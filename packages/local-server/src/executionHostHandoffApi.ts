import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type ExecutionHostHandoffBlockers, type ExecutionHostHandoffPreparation, ExecutionHostHandoffRepository } from '@zeus/storage';

export type ExecutionHostMutationFenceState = 'open' | 'draining' | 'prepared' | 'recovery_required';

/**
 * 交接 prepare 是切换 Command Ledger 单写入者的控制面，不能反过来依赖即将冻结的通用 Command Ledger。
 * 它只以 execution_host_handoffs 同库 journal、checkpoint hash 和单飞 promise 提供耐久 CAS。
 */
export const executionHostHandoffControlDeclaration = {
  classification: 'handoff_control_capability',
  writesBusinessState: false,
  durableJournal: 'execution_host_handoffs',
  singleFlight: true,
  commandLedger: 'not_applicable',
} as const;

/** HTTP 副作用接纳闸门；GET/HEAD/OPTIONS 与交接 prepare 控制面不计入业务 mutation。 */
export class ExecutionHostMutationAdmissionFence {
  private activeMutationRequestCount = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(private currentState: ExecutionHostMutationFenceState) {}

  state(): ExecutionHostMutationFenceState {
    return this.currentState;
  }

  transition(state: ExecutionHostMutationFenceState): void {
    this.currentState = state;
  }

  install(server: FastifyInstance): void {
    server.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      const pathname = request.url.split('?', 1)[0];
      if (this.currentState !== 'open') {
        const allowedControlRequest =
          (request.method === 'POST' && pathname === '/api/execution-host/handoff/prepare') ||
          (request.method === 'GET' && pathname === '/api/execution-host/status') ||
          (request.method === 'GET' && /^\/api\/execution-host\/handoff\/[^/]+\/prepared$/u.test(pathname));
        if (allowedControlRequest) return;
        const recoveryRequired = this.currentState === 'recovery_required';
        await reply.code(503).send({
          error: recoveryRequired ? 'ZEUS_EXECUTION_HOST_RECOVERY_REQUIRED' : 'ZEUS_EXECUTION_HOST_DRAINING',
          message: recoveryRequired ? 'Zeus 上次未能完整退出，已停止继续执行会话。' : 'Zeus 正在完成更新，请稍后重试。',
          handoffState: this.currentState,
        });
        return;
      }
      if (pathname === '/api/execution-host/handoff/prepare' || ['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
      this.activeMutationRequestCount += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        this.activeMutationRequestCount -= 1;
        if (this.activeMutationRequestCount !== 0) return;
        for (const resolveWaiter of this.drainWaiters) resolveWaiter();
        this.drainWaiters.clear();
      };
      reply.raw.once('finish', release);
      reply.raw.once('close', release);
    });
  }

  async waitForAdmittedMutations(): Promise<void> {
    if (this.activeMutationRequestCount === 0) return;
    await new Promise<void>((resolveWait, rejectWait) => {
      const onDrained = () => {
        clearTimeout(timeout);
        resolveWait();
      };
      const timeout = setTimeout(() => {
        this.drainWaiters.delete(onDrained);
        rejectWait(Object.assign(new Error('等待已接纳副作用请求排空超时。'), { code: 'ZEUS_EXECUTION_HOST_MUTATION_DRAIN_TIMEOUT', statusCode: 409 }));
      }, 30_000);
      timeout.unref?.();
      this.drainWaiters.add(onDrained);
    });
  }
}

interface PollingAdmissionService {
  status(): { running: boolean };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  pollOnce(): Promise<unknown>;
}

/** 在 handoff 排空期间暂停可从 HTTP 之外接纳命令的轮询器，并只在闸门重新打开时恢复。 */
export function createPollingAdmissionPause(
  fence: ExecutionHostMutationAdmissionFence,
  getService: () => PollingAdmissionService | undefined,
  getTimer: () => ReturnType<typeof setInterval> | undefined,
  setTimer: (timer: ReturnType<typeof setInterval> | undefined) => void,
): () => Promise<() => Promise<void>> {
  return async () => {
    const service = getService();
    const wasRunning = service?.status().running === true;
    const timer = getTimer();
    if (timer) clearInterval(timer);
    setTimer(undefined);
    if (service && wasRunning) await service.stop();
    return async () => {
      if (!service || !wasRunning || fence.state() !== 'open') return;
      await service.start();
      if (getTimer()) return;
      const resumed = setInterval(() => void service.pollOnce(), 30_000);
      resumed.unref?.();
      setTimer(resumed);
    };
  };
}

export interface RegisterExecutionHostHandoffApiOptions {
  server: FastifyInstance;
  repository: ExecutionHostHandoffRepository;
  fence: ExecutionHostMutationAdmissionFence;
  sourceInstanceId: string;
  sourceAppVersion: string;
  save(): Promise<void>;
  pauseBackgroundAdmission(): Promise<() => Promise<void>>;
  readBackgroundMutationBlockers(): Record<string, number>;
  freezeBackgroundMutationSources(): Promise<void>;
  freezeBusinessMutationAdmission(): void;
  prepareJournal(handoffId: string, preparedAt: string): ExecutionHostHandoffPreparation;
  requireRecoveryJournal(handoffId: string, reason: string, occurredAt: string): void;
  publishPrepared(input: { handoffId: string; checkpointSha256: string; requestCount: number; targetAppVersion: string }): void;
  now(): Date;
}

/** 注册同库 durable handoff 的 prepare/verify 控制面；业务 checkpoint 永不返回给 Main。 */
export function registerExecutionHostHandoffApi(options: RegisterExecutionHostHandoffApiOptions): void {
  let preparationPromise: Promise<{ handoffId: string; checkpointSha256: string; requestCount: number; preparedAt: string }> | undefined;

  options.server.post('/api/execution-host/handoff/prepare', async (request: FastifyRequest<{ Body: { targetAppVersion?: unknown } }>, reply) => {
    const targetAppVersion = typeof request.body?.targetAppVersion === 'string' ? request.body.targetAppVersion.trim() : '';
    if (!targetAppVersion || targetAppVersion.length > 128) {
      return reply.code(400).send({ error: 'ZEUS_EXECUTION_HOST_HANDOFF_TARGET_INVALID', message: 'Execution Host 交接目标版本无效。' });
    }
    if (options.fence.state() === 'recovery_required') {
      return reply.code(409).send({ error: 'ZEUS_EXECUTION_HOST_HANDOFF_RECOVERY_REQUIRED', message: '已有 Execution Host 交接需要人工恢复，拒绝覆盖原账本。' });
    }
    if (preparationPromise) return preparationPromise;

    const preparing = prepare(targetAppVersion);
    preparationPromise = preparing;
    try {
      return await preparing;
    } catch (error) {
      const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
      return reply.code(statusCode).send({
        error: error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'ZEUS_EXECUTION_HOST_HANDOFF_PREPARE_FAILED',
        message: error instanceof Error ? error.message : 'Execution Host 持久化交接准备失败。',
      });
    } finally {
      if (preparationPromise === preparing && options.fence.state() === 'open') preparationPromise = undefined;
    }
  });

  options.server.get('/api/execution-host/handoff/:handoffId/prepared', async (request: FastifyRequest<{ Params: { handoffId: string }; Querystring: { checkpointSha256?: string } }>, reply) => {
    const checkpointSha256 = request.query.checkpointSha256?.trim() ?? '';
    const prepared = checkpointSha256 ? options.repository.isPrepared({ handoffId: request.params.handoffId, checkpointSha256 }) : false;
    if (!prepared) {
      return reply.code(409).send({ error: 'ZEUS_EXECUTION_HOST_HANDOFF_NOT_PREPARED', message: 'Execution Host 交接账本不存在、状态不符或 hash 不匹配。' });
    }
    return { prepared: true, handoffId: request.params.handoffId, checkpointSha256 };
  });

  async function prepare(targetAppVersion: string) {
    // 已知存在活动写入时不能先关闸再判断，否则新版 Main 的周期探测会让旧 Core
    // 每秒短暂进入 draining，普通读取和新会话派发都会随机失败。这里先做无副作用
    // 预检；真正关闸后仍会再次复核，覆盖预检与冻结之间新进入的工作。
    const preflightBlockers = options.repository.readBlockers();
    const preflightBackgroundBlockers = options.readBackgroundMutationBlockers();
    if (hasHandoffBlockers(preflightBlockers) || hasBackgroundMutationBlockers(preflightBackgroundBlockers)) {
      const blockers = { business: preflightBlockers, background: preflightBackgroundBlockers };
      throw Object.assign(new Error(`Execution Host 交接被活动工作阻断：${JSON.stringify(blockers)}`), {
        code: preflightBlockers.piWaitingTurnCount > 0 ? 'ZEUS_EXECUTION_HOST_PI_WAITING_BLOCKED' : 'ZEUS_EXECUTION_HOST_HANDOFF_WORK_BLOCKED',
        statusCode: 409,
      });
    }
    options.fence.transition('draining');
    let handoffId: string | null = null;
    let coordinatorFrozen = false;
    let resumeBackground: (() => Promise<void>) | null = null;
    try {
      await options.save();
      const draining = options.repository.startDraining({
        sourceInstanceId: options.sourceInstanceId,
        sourceAppVersion: options.sourceAppVersion,
        targetAppVersion,
        startedAt: options.now().toISOString(),
      });
      handoffId = draining.id;
      resumeBackground = await options.pauseBackgroundAdmission();
      await options.fence.waitForAdmittedMutations();
      const initialBlockers = options.repository.readBlockers();
      const initialBackgroundBlockers = options.readBackgroundMutationBlockers();
      if (hasHandoffBlockers(initialBlockers) || hasBackgroundMutationBlockers(initialBackgroundBlockers)) {
        const blockers = { business: initialBlockers, background: initialBackgroundBlockers };
        options.repository.abandonDraining(handoffId, { reason: JSON.stringify(blockers), abandonedAt: options.now().toISOString() });
        options.fence.transition('open');
        await resumeBackground();
        throw Object.assign(new Error(`Execution Host 交接被活动工作阻断：${JSON.stringify(blockers)}`), {
          code: initialBlockers.piWaitingTurnCount > 0 ? 'ZEUS_EXECUTION_HOST_PI_WAITING_BLOCKED' : 'ZEUS_EXECUTION_HOST_HANDOFF_WORK_BLOCKED',
          statusCode: 409,
        });
      }

      coordinatorFrozen = true;
      await options.freezeBackgroundMutationSources();
      await options.save();
      const finalBlockers = options.repository.readBlockers();
      const finalBackgroundBlockers = options.readBackgroundMutationBlockers();
      if (hasHandoffBlockers(finalBlockers) || hasBackgroundMutationBlockers(finalBackgroundBlockers)) {
        const blockers = { business: finalBlockers, background: finalBackgroundBlockers };
        options.requireRecoveryJournal(handoffId, `post_freeze_revalidation_failed:${JSON.stringify(blockers)}`, options.now().toISOString());
        throw Object.assign(new Error(`Execution Host 在冻结后台写入后复核失败：${JSON.stringify(blockers)}`), {
          code: 'ZEUS_EXECUTION_HOST_HANDOFF_REVALIDATION_FAILED',
          statusCode: 409,
        });
      }
      options.freezeBusinessMutationAdmission();
      const prepared = options.prepareJournal(handoffId, options.now().toISOString());
      options.fence.transition('prepared');
      options.publishPrepared({ ...prepared, targetAppVersion });
      return prepared;
    } catch (error) {
      if (coordinatorFrozen) {
        if (handoffId && options.repository.getById(handoffId)?.status !== 'recovery_required') {
          try {
            options.requireRecoveryJournal(handoffId, error instanceof Error ? error.message : String(error), options.now().toISOString());
          } catch {
            // 冻结后的 SQLite 硬故障无法安全覆写；draining/prepared 账本会由新 Core 启动恢复为 recovery_required。
          }
        }
        options.fence.transition('recovery_required');
      } else if (handoffId && options.repository.getById(handoffId)?.status === 'draining') {
        await options.save().catch(() => undefined);
        options.repository.abandonDraining(handoffId, {
          reason: error instanceof Error ? error.message : String(error),
          abandonedAt: options.now().toISOString(),
        });
        options.fence.transition('open');
        await resumeBackground?.().catch(() => undefined);
      } else if (!handoffId) options.fence.transition('open');
      throw error;
    }
  }
}

function hasHandoffBlockers(blockers: ExecutionHostHandoffBlockers): boolean {
  return (
    blockers.effectfulTurnCount > 0 ||
    blockers.activeRuntimeCount > 0 ||
    blockers.activeCommandRunCount > 0 ||
    blockers.piWaitingTurnCount > 0 ||
    blockers.unrecoverableWaitingTurnCount > 0 ||
    blockers.invalidCodexRequestCount > 0 ||
    blockers.pendingRequestCount !== blockers.recoverableCodexRequestCount
  );
}

function hasBackgroundMutationBlockers(blockers: Record<string, number>): boolean {
  return Object.values(blockers).some((count) => !Number.isSafeInteger(count) || count < 0 || count > 0);
}
