import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AcceptedAgentRun,
  AgentDescriptor,
  AgentRuntimeEvent,
  AgentRuntimeHealthSnapshot,
  AgentRuntimeProbe,
  AgentSessionIdentity,
  AgentSessionSnapshot,
  InterruptAgentRunInput,
  OpenAgentSessionInput,
  ReadAgentSessionInput,
  RespondAgentInteractionInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
  SupervisedAgentRuntimeDriver,
} from './agentRuntimeContracts.js';
import { installManagedAntigravity, readManagedAntigravity, type AntigravityInstallProgress } from './antigravityInstallation.js';
import { resolveCliSearchPath } from './cliSearchPath.js';
import { CodexJsonLineDecoder as JsonLineDecoder, type CodexWireId as RpcId, type CodexWireMessage as RpcMessage } from './codexAppServerProtocol.js';
import { businessProcessEnvironment, resolveExecutableInvocation } from './commandExecution.js';
import type { PiSdkRuntimeDriver, PiZeusToolRequest } from './piSdkRuntimeDriver.js';

/** agy 返回的模型身份，Zeus 使用该身份发送模型选择。 */
export interface AntigravityModel {
  id: string;
  name: string;
  /** 当前型号选中后，agy 返回的原生 thought_level 值。 */
  supportedReasoningEfforts?: string[];
  /** 探测会话切换至该型号后，agy 选定的档位。 */
  defaultReasoningEffort?: string | null;
}

/** 浏览器授权和模型目录的公开状态，凭据始终留在 agy。 */
export interface AntigravityAccountCatalog {
  status: 'idle' | 'checking' | 'missing_cli' | 'installing' | 'sign_in_required' | 'signing_in' | 'verification_required' | 'ready' | 'unavailable';
  models: AntigravityModel[];
  /** 验证地址仅在用户点击验证时单独读取。 */
  verificationAvailable?: boolean;
  /** 仅在准备受管 CLI 时公开具体阶段。 */
  installation?: AntigravityInstallProgress;
  message?: string;
}

/** 由 Zeus 提供的规则真源目录和账号目录变更通知。 */
export interface AntigravityRuntimeOptions {
  /** 固定的 Zeus 规则真源目录，凭据和 CLI 个人配置沿用原生存储。 */
  agentRulesDirectory: string;
  /** 账号探测确认目录变化后再通知选择器失效。 */
  onAccountCatalogChanged(): void;
}

/** 与一条官方 ACP 请求对应的回执。 */
interface PendingRpc {
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Antigravity ACP 按换行传输 JSON-RPC，复用已有的有界帧解码。 */
class AcpConnection {
  /** 使不同 agy 子进程发出的会话事件可区分。 */
  readonly generationId = randomUUID();
  /** 未收到响应的请求由本进程持有。 */
  private readonly pending = new Map<RpcId, PendingRpc>();
  /** 与子进程 stdout 绑定的帧解码器。 */
  private readonly decoder = new JsonLineDecoder();
  /** JSON-RPC 请求 ID 在同一进程内递增。 */
  private nextId = 0;
  /** 终止后拒绝新写入。 */
  private closed = false;

  /** 建立子进程读写边界，stderr 可能包含 OAuth 信息，直接消费且不保存。 */
  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly diagnosticPath: string,
    onMessage: (connection: AcpConnection, message: RpcMessage) => void,
    private readonly onClose: (connection: AcpConnection, error: Error) => void,
  ) {
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => {
      for (const frame of this.decoder.push(chunk)) {
        if (this.closed) break;
        if (frame.type === 'protocol_error') {
          this.close(agyError('ZEUS_AGY_PROTOCOL', 'Antigravity CLI 返回了无法读取的 ACP 消息。'));
          break;
        }
        if ('method' in frame.message) {
          onMessage(this, frame.message);
          continue;
        }
        const reply = this.pending.get(frame.message.id);
        if (!reply) continue;
        this.pending.delete(frame.message.id);
        if (reply.timer) clearTimeout(reply.timer);
        if (frame.message.error) reply.reject(agyRpcError(frame.message.error));
        else reply.resolve(frame.message.result);
      }
    });
    child.stdin.on('error', () => this.close());
    child.on('error', () => this.close());
    child.on('close', () => this.close());
  }

  /** 活跃的本地 CLI 进程。 */
  get pid(): number | null {
    return this.child.pid ?? null;
  }

  /** 从当前 CLI 进程的私有诊断读取 Google 账号挑战。 */
  readVerification(): Promise<{ url: string | null } | null> {
    return readAntigravityVerification(this.diagnosticPath);
  }

  /** 登录有独立的等待区间。轮次由用户停止，不对正常长轮次设置硬超时。 */
  request(method: string, params: object, timeoutMs: number | null = 15_000): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => this.close(agyError('ZEUS_AGY_TIMEOUT', 'Antigravity CLI 未及时响应。')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.close();
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** 发送 ACP 取消通知或工具权限答复。 */
  write(message: object): void {
    if (this.closed || !this.child.stdin.writable) throw agyError('ZEUS_AGY_EXIT', 'Antigravity CLI 已断开。');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  /** 退出或取消登录时收敛当前连接，避免旧回执污染新进程。 */
  close(error = agyError('ZEUS_AGY_EXIT', 'Antigravity CLI 已断开。')): void {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      if (item.timer) clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    this.onClose(this, error);
    if (this.child.exitCode === null) this.child.kill();
  }
}

/** 本地会话的 ACP 配置与当前轮次。 */
interface SessionBinding {
  identity: AgentSessionIdentity;
  config: Record<string, unknown>;
  run?: {
    id: string;
    text: string;
    /** CLI 用普通消息发送验证提示，等供应商诊断确认后再判定用途。 */
    verificationNotice: string | null;
    messageId: string;
    abort: AbortController;
    tools: Set<string>;
  };
}

/** Zeus 接受的 Google 账号授权方式。 */
const googleLoginMethod = 'oauth-personal';

/** agy 在选中模型后返回的独立思考档位配置。 */
const thoughtLevelConfig = 'thought_level';

/** agy 在 ACP 正文中返回的账号验证提示。 */
const verificationNotice = '⚠ Verification Required';

/** 将官方 ACP 会话接入 Zeus 已有的持久派发和审批。 */
export class AntigravityRuntimeDriver implements PiSdkRuntimeDriver, SupervisedAgentRuntimeDriver {
  /** 持久会话和模型目录共用的 Provider 身份。 */
  readonly kind = 'antigravity' as const;
  /** ID 由 agy 分配，不在 Zeus 重建。 */
  private readonly sessions = new Map<string, SessionBinding>();
  /** 原生事件仅投影到绑定本运行时的宿主。 */
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>();
  /** 未授权时模型目录为空。 */
  private catalog: AntigravityAccountCatalog = { status: 'idle', models: [] };
  /** Google 生成的验证链接，仅保存在当前 Core 内存。 */
  private verificationUrl: string | null = null;
  /** 当前 ACP 子进程，关闭后生成新代次。 */
  private connection: AcpConnection | null = null;
  /** 同时刷新只启动一个子进程。 */
  private connecting: Promise<AcpConnection> | null = null;
  /** 初始化协商的认证方式。 */
  private authMethods: unknown[] = [];
  /** 账号检查和登录不能并发创建探测会话。 */
  private accountOperation: Promise<AntigravityAccountCatalog> | null = null;
  /** 取消登录时同时停止正在进行的程序下载。 */
  private installationAbort: AbortController | null = null;
  /** 已断开的登录流程不能写入后续目录。 */
  private accountRevision = 0;
  /** 只有已选择官方个人 Google 账号的连接才读取缓存凭据。 */
  private googleAccountSelected = false;
  /** Core 终止后不再创建 agy 进程。 */
  private disposed = false;
  /** 同一进程内的实时事件排序。 */
  private sequence = 0;

  /** 使用 Core 自己的工作目录查询账号和模型目录。 */
  constructor(
    private readonly probeDirectory: string,
    private readonly approve: (request: PiZeusToolRequest, tool: Record<string, unknown>) => Promise<boolean>,
    private readonly respond: (input: RespondAgentInteractionInput) => Promise<void>,
    private readonly now: () => string,
    private readonly options: AntigravityRuntimeOptions,
  ) {}

  /** 读取缓存的状态，无副作用。 */
  readAccount(): AntigravityAccountCatalog {
    return this.catalog;
  }

  /** 仅在账号仍待验证时向显式的验证操作提供官方链接。 */
  readVerificationUrl(): string | null {
    return this.catalog.status === 'verification_required' ? this.verificationUrl : null;
  }

  /** 冷启动复用本机此前通过 Zeus 接入的官方个人 Google 账号。 */
  restoreGoogleAccount(): Promise<AntigravityAccountCatalog> {
    this.googleAccountSelected = true;
    return this.refreshAccount();
  }

  /** 使用 agy 已保存的 Google 账号检查模型目录。 */
  refreshAccount(): Promise<AntigravityAccountCatalog> {
    if (this.accountOperation) return this.accountOperation;
    if (!this.googleAccountSelected) {
      this.catalog = { status: readManagedAntigravity(this.probeDirectory) ? 'sign_in_required' : 'missing_cli', models: [] };
      return Promise.resolve(this.catalog);
    }
    if (this.catalog.status === 'verification_required') {
      if ([...this.sessions.values()].some((session) => session.run)) return Promise.resolve(this.catalog);
      // 新进程会重新检查 Google 账号，当前进程的诊断仍保留上一次拒绝。
      this.connection?.close();
    }
    return this.checkAccount(false);
  }

  /** 在后台推进官方浏览器授权，界面可以取消。 */
  beginLogin(): AntigravityAccountCatalog {
    if (!this.accountOperation && ![...this.sessions.values()].some((session) => session.run)) {
      void this.checkAccount(true);
    }
    return this.catalog;
  }

  /** 取消正在等待的登录，不影响已建立的项目会话。 */
  cancelLogin(): AntigravityAccountCatalog {
    if (this.catalog.status === 'installing' || this.catalog.status === 'signing_in') {
      this.accountRevision++;
      this.installationAbort?.abort();
      this.accountOperation = null;
      this.catalog = { status: readManagedAntigravity(this.probeDirectory) ? 'sign_in_required' : 'missing_cli', models: [] };
      this.connection?.close();
    }
    return this.catalog;
  }

  /** 提交 Zeus 的接入退出后，释放当前连接、模型目录和验证链接。 */
  async logoutAccount(disableRestore: () => Promise<void>): Promise<AntigravityAccountCatalog> {
    if (this.accountOperation || [...this.sessions.values()].some((session) => session.run)) {
      throw agyError('ZEUS_AGY_BUSY', '请等 Antigravity 当前操作或会话结束后再退出登录。');
    }
    const previous = this.catalog;
    this.catalog = { status: 'checking', models: [] };
    const operation = (async () => {
      await disableRestore();
      this.googleAccountSelected = false;
      this.verificationUrl = null;
      this.catalog = { status: 'sign_in_required', models: [] };
      this.connection?.close();
      return this.catalog;
    })();
    this.accountOperation = operation;
    try {
      return await operation;
    } catch (error) {
      this.catalog = previous;
      throw error;
    } finally {
      this.accountOperation = null;
    }
  }

  /** 能力探测仅陈述已经观察到的 CLI 和账号状态。 */
  async probe(): Promise<AgentRuntimeProbe> {
    return { available: this.catalog.status === 'ready', checkedAt: this.now(), adapterVersion: null, binaryVersion: null, protocolVersion: this.connection ? 'acp' : null, reason: this.catalog.status };
  }

  /** 标记 Antigravity 的会话操作及确实缺失的计数能力。 */
  async readCapabilities(): Promise<AgentDescriptor> {
    return {
      kind: this.kind,
      displayName: 'Google Antigravity',
      transport: 'rpc',
      supportStatus: this.catalog.status === 'ready' ? 'experimental' : 'unavailable',
      visibleToUsers: this.catalog.status === 'ready',
      capabilities: {},
      preflightTokenCount: { state: 'unavailable', exact: false, source: null, checkedAt: null, reason: 'Antigravity ACP 未报告精确的预检 Token 数。' },
    };
  }

  /** 在项目目录创建独立的原生会话。 */
  async openSession(input: OpenAgentSessionInput): Promise<AgentSessionIdentity> {
    const connection = await this.requireAccount();
    const config = record(await connection.request('session/new', { cwd: input.cwd, mcpServers: [] }));
    if (typeof config.sessionId !== 'string' || !config.sessionId) throw agyError('ZEUS_AGY_PROTOCOL', 'Antigravity CLI 未返回会话 ID。');
    return this.bind(connection, config.sessionId, config);
  }

  /** 使用原生会话 ID 恢复，历史展示继续使用 Zeus 已保存的事件。 */
  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionIdentity> {
    if (!input.cwd) throw agyError('ZEUS_AGY_SESSION', 'Antigravity 会话缺少工作目录。');
    const connection = await this.requireAccount();
    const present = this.sessions.get(input.nativeSessionId);
    if (present) return present.identity;
    const config = record(await connection.request('session/load', { sessionId: input.nativeSessionId, cwd: input.cwd, mcpServers: [] }));
    return this.bind(connection, input.nativeSessionId, config);
  }

  /** 模型、操作模式与思考档位确认后才持久接纳并发送提示词。 */
  async startRun(input: StartAgentRunInput): Promise<AcceptedAgentRun> {
    const connection = await this.requireAccount();
    const session = this.requireSession(input.session);
    if (session.run) throw agyError('ZEUS_AGY_BUSY', 'Antigravity 会话已有运行中的轮次。');
    const sessionId = session.identity.nativeSessionId;
    const config = selectConfig(session.config, 'model');
    if (input.model && config) {
      if (!config.options.some((model) => model.id === input.model?.modelId)) throw agyError('ZEUS_AGY_MODEL_UNAVAILABLE', '当前 Google 账号无法使用所选模型。');
      if (config.current !== input.model.modelId) await this.setConfig(connection, session, config.id, input.model.modelId);
    } else if (input.model) {
      const models = record(session.config.models);
      if (models.currentModelId !== input.model.modelId) {
        if (!legacyModels(models).some((model) => model.id === input.model?.modelId)) throw agyError('ZEUS_AGY_MODEL_UNAVAILABLE', '当前 Google 账号无法使用所选模型。');
        await connection.request('session/set_model', { sessionId, modelId: input.model.modelId });
        models.currentModelId = input.model.modelId;
      }
    }
    const mode = selectConfig(session.config, 'mode');
    const modeId = input.workMode === 'plan' || input.permissionMode === 'read-only' ? 'plan' : 'default';
    if (mode?.options.some((item) => item.id === modeId)) {
      if (mode.current !== modeId) await this.setConfig(connection, session, mode.id, modeId);
    } else if (modeId === 'plan') {
      const modes = record(session.config.modes);
      if (!Array.isArray(modes.availableModes) || !modes.availableModes.some((item) => record(item).id === modeId)) throw agyError('ZEUS_AGY_MODE_UNAVAILABLE', '当前 Antigravity CLI 未开放计划模式。');
      await connection.request('session/set_mode', { sessionId, modeId });
      modes.currentModeId = modeId;
    } else if (record(session.config.modes).currentModeId === 'plan') {
      await connection.request('session/set_mode', { sessionId, modeId });
      record(session.config.modes).currentModeId = modeId;
    }
    if (input.thinkingLevel) {
      /** agy 在模型或模式切换时可能重算档位，使用此时的回执核验。 */
      const thinking = selectConfig(session.config, thoughtLevelConfig);
      if (!thinking?.options.some((option) => option.id === input.thinkingLevel)) throw agyError('ZEUS_AGY_EFFORT_UNAVAILABLE', 'Antigravity 当前会话未开放所选思考档位。');
      if (thinking.current !== input.thinkingLevel) {
        await this.setConfig(connection, session, thinking.id, input.thinkingLevel);
        if (selectConfig(session.config, thoughtLevelConfig)?.current !== input.thinkingLevel) throw agyError('ZEUS_AGY_EFFORT_UNCONFIRMED', 'Antigravity 未确认所选思考档位，消息尚未发送。');
      }
    }
    if (connection !== this.connection) throw agyError('ZEUS_AGY_EXIT', 'Antigravity CLI 已断开，消息尚未发送。');
    const acceptance = { nativeRunId: randomUUID(), acceptedAt: this.now() };
    /** 该轮持有 ACP 原生会话内的正文和工具状态。 */
    const run: NonNullable<SessionBinding['run']> = { id: acceptance.nativeRunId, messageId: randomUUID(), text: '', verificationNotice: null, abort: new AbortController(), tools: new Set<string>() };
    const prompt = [{ type: 'text', text: [input.content, input.untrustedContext?.content].filter(Boolean).join('\n\n') }, ...(input.images ?? []).map((image) => ({ type: 'image', data: image.data, mimeType: image.mimeType }))];
    input.preflightResult?.(true);
    input.durableTransactionSync?.(acceptance);
    session.run = run;
    setImmediate(() => {
      if (session.run !== run) return;
      if (run.abort.signal.aborted) {
        this.finish(session, true, null);
        return;
      }
      if (this.catalog.status === 'verification_required') {
        this.finish(session, false, antigravityVerificationError());
        return;
      }
      void (async () => {
        try {
          input.providerWriteMayStart?.();
          const result = record(await connection.request('session/prompt', { sessionId, prompt }, null));
          const cancelled = result.stopReason === 'cancelled';
          const verification = !cancelled && (run.verificationNotice || run.text.trim() === verificationNotice) ? await connection.readVerification() : null;
          if (session.run !== run) return;
          if (verification && !run.abort.signal.aborted) {
            this.requireVerification(this.catalog.models, verification.url);
            this.finish(session, false, antigravityVerificationError());
            return;
          }
          this.finish(session, cancelled, null);
        } catch (error) {
          this.finish(session, false, error instanceof Error ? error : agyError('ZEUS_AGY_RUN_FAILED', 'Antigravity 请求失败。'));
        }
      })();
    });
    return acceptance;
  }

  /** 活跃提示词完成后可继续原生会话。 */
  followUp(input: StartAgentRunInput): Promise<AcceptedAgentRun> {
    return this.startRun(input);
  }

  /** ACP 当前轮次的提示词保持不变。 */
  async steerRun(): Promise<never> {
    throw unsupportedAgyOperation();
  }

  /** ACP 的上下文压缩由 agy 管理。 */
  async compactSession(): Promise<never> {
    throw unsupportedAgyOperation();
  }

  /** ACP 可以恢复自己的会话，便携历史由宿主在能力入口约束。 */
  async importPortableHistory(): Promise<never> {
    throw unsupportedAgyOperation();
  }

  /** 独立的权限审查由用户操作完成。 */
  async reviewPermission(): Promise<never> {
    throw unsupportedAgyOperation();
  }

  /** ACP 目录由官方会话响应更新。 */
  invalidateModelRuntime(): void {}

  /** 取消原生轮次并释放挂起的工具审批。 */
  async interruptRun(input: InterruptAgentRunInput): Promise<void> {
    const session = this.requireSession(input.session);
    if (session.run?.id !== input.nativeRunId) return;
    session.run.abort.abort();
    this.connection!.write({ method: 'session/cancel', params: { sessionId: input.session.nativeSessionId } });
  }

  /** 将宿主已经持久接纳的批准或拒绝交回 ACP。 */
  respondToInteraction(input: RespondAgentInteractionInput): Promise<void> {
    return this.respond(input);
  }

  /** 查询本地绑定状态，不为读取状态发送模型请求。 */
  async readSession(input: ReadAgentSessionInput): Promise<AgentSessionSnapshot> {
    const session = this.requireSession(input.session);
    return { session: session.identity, state: session.run ? 'active' : 'idle', raw: null };
  }

  /** 恢复官方连接，不再次提交上一轮提示词。 */
  async recover(): Promise<void> {
    await this.refreshAccount();
  }

  /** 将恢复结果反馈给宿主运行健康页面。 */
  async recoverRuntime(): Promise<AgentRuntimeHealthSnapshot> {
    await this.recover();
    return this.getRuntimeHealth();
  }

  /** Core 关闭时退出子进程，Google 账号由 agy 保存。 */
  async close(): Promise<void> {
    this.disposed = true;
    this.accountRevision++;
    this.installationAbort?.abort();
    this.connection?.close();
    this.catalog = { status: 'idle', models: [] };
  }

  /** 读取当前连接状态及原生进程。 */
  getRuntimeHealth(): AgentRuntimeHealthSnapshot {
    return {
      agentKind: this.kind,
      transport: 'rpc',
      generationId: this.connection?.generationId ?? null,
      lifecycle: this.connection ? (this.catalog.status === 'ready' ? 'healthy' : 'starting') : 'stopped',
      protocolVersion: this.connection ? 'acp' : null,
      processId: this.connection?.pid ?? null,
      checkedAt: this.now(),
      consecutiveFailures: 0,
      circuit: { state: 'closed', openedAt: null, reason: null, recovery: 'explicit' },
      lastFailure: null,
    };
  }

  /** 注册持久会话编排使用的事件订阅。 */
  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 登录走官方个人账号，后台探测期间保留已有的可用目录。 */
  private checkAccount(login: boolean, background = false): Promise<AntigravityAccountCatalog> {
    const revision = ++this.accountRevision;
    const needsInstallation = login && !readManagedAntigravity(this.probeDirectory);
    if (!background) this.catalog = needsInstallation ? { status: 'installing', models: [], installation: { stage: 'preparing' } } : { status: login ? 'signing_in' : 'checking', models: [] };
    const operation = (async () => {
      /** 同一连接的诊断也用于识别授权或建探测会话时的验证要求。 */
      let connection: AcpConnection | undefined;
      try {
        if (needsInstallation) {
          const abort = new AbortController();
          this.installationAbort = abort;
          try {
            await installManagedAntigravity(this.probeDirectory, abort.signal, (installation) => {
              if (revision === this.accountRevision) this.catalog = { status: 'installing', models: [], installation };
            });
          } finally {
            if (this.installationAbort === abort) this.installationAbort = null;
          }
          if (revision !== this.accountRevision) return this.catalog;
          this.catalog = { status: 'signing_in', models: [] };
        }
        connection = await this.connect();
        if (revision !== this.accountRevision) return this.catalog;
        if (login) {
          if (!this.authMethods.some((item) => record(item).id === googleLoginMethod)) throw agyError('ZEUS_AGY_PROTOCOL', '请更新 Antigravity CLI 以使用个人 Google 账号登录。');
          await connection.request('authenticate', { methodId: googleLoginMethod }, 5 * 60_000);
          if (revision !== this.accountRevision) return this.catalog;
          this.googleAccountSelected = true;
        }
        const probe = record(await connection.request('session/new', { cwd: this.probeDirectory, mcpServers: [] }));
        const verification = await connection.readVerification();
        const options = selectConfig(probe, 'model');
        let models = options?.options ?? legacyModels(record(probe.models));
        if (typeof probe.sessionId === 'string') {
          try {
            if (options && !verification) models = await this.readModelReasoningEfforts(connection, probe.sessionId, probe, options);
          } finally {
            await connection.request('session/close', { sessionId: probe.sessionId }).catch(() => undefined);
          }
        }
        if (revision === this.accountRevision) {
          if (connection !== this.connection) throw agyError('ZEUS_AGY_EXIT', 'Antigravity CLI 已断开。');
          if (verification) this.requireVerification(models, verification.url);
          else {
            this.verificationUrl = null;
            this.catalog = { status: 'ready', models };
          }
        }
      } catch (error) {
        const verification = login || this.googleAccountSelected ? await connection?.readVerification() : null;
        if (revision === this.accountRevision) {
          if (verification) {
            this.googleAccountSelected = true;
            this.requireVerification([], verification.url);
            return this.catalog;
          }
          this.verificationUrl = null;
          const code = record(error).code;
          if (background && this.catalog.status === 'ready' && code !== 'ZEUS_AGY_AUTH_REQUIRED') return this.catalog;
          this.catalog = {
            status: code === 'ZEUS_AGY_MISSING' ? 'missing_cli' : code === 'ZEUS_AGY_AUTH_REQUIRED' ? 'sign_in_required' : 'unavailable',
            models: [],
            message: error instanceof Error ? error.message : undefined,
          };
        }
      }
      return this.catalog;
    })();
    this.accountOperation = operation;
    void operation.finally(() => {
      if (this.accountOperation === operation) this.accountOperation = null;
    });
    return operation;
  }

  /** 在账号探测会话里逐型号读取档位，正式会话和模型目录均沿用 agy 的值。 */
  private async readModelReasoningEfforts(connection: AcpConnection, sessionId: string, probe: Record<string, unknown>, modelConfig: NonNullable<ReturnType<typeof selectConfig>>): Promise<AntigravityModel[]> {
    let config = probe;
    const models: AntigravityModel[] = [];
    for (const model of modelConfig.options) {
      if (selectConfig(config, 'model')?.current !== model.id) {
        try {
          config = record(await connection.request('session/set_config_option', { sessionId, configId: modelConfig.id, value: model.id }));
        } catch (error) {
          if (connection !== this.connection || record(error).code === 'ZEUS_AGY_AUTH_REQUIRED') throw error;
          models.push(model);
          continue;
        }
      }
      const thinking = selectConfig(config, 'model')?.current === model.id ? selectConfig(config, thoughtLevelConfig) : undefined;
      const efforts = thinking?.options.map((option) => option.id) ?? [];
      const current = thinking?.current;
      models.push(efforts.length ? { ...model, supportedReasoningEfforts: efforts, defaultReasoningEffort: current && efforts.includes(current) ? current : null } : model);
    }
    return models;
  }

  /** 账号已授权，Google 需要验证后才接受模型请求。 */
  private requireVerification(models: AntigravityModel[], url: string | null): void {
    this.verificationUrl = url;
    this.catalog = { status: 'verification_required', models, verificationAvailable: Boolean(url), message: antigravityVerificationError().message };
  }

  /** 会话的模型或可选档位变化时，用账号探测结果刷新公共目录。 */
  private updateSessionConfig(session: SessionBinding, configOptions: unknown): void {
    if (!Array.isArray(configOptions)) return;
    const previousModel = selectConfig(session.config, 'model');
    const previousEfforts = selectConfig(session.config, thoughtLevelConfig)?.options;
    session.config.configOptions = configOptions;
    if (this.catalog.status !== 'ready' || this.accountOperation) return;
    const nextModel = selectConfig(session.config, 'model');
    const modelOptionsChanged = JSON.stringify(previousModel?.options) !== JSON.stringify(nextModel?.options);
    const effortOptionsChanged = previousModel?.current === nextModel?.current && JSON.stringify(previousEfforts) !== JSON.stringify(selectConfig(session.config, thoughtLevelConfig)?.options);
    if (!modelOptionsChanged && !effortOptionsChanged) return;
    const catalogBefore = this.catalog;
    void this.checkAccount(false, true).then((catalog) => {
      if (catalog.status !== catalogBefore.status || JSON.stringify(catalog.models) !== JSON.stringify(catalogBefore.models)) this.options.onAccountCatalogChanged();
    });
  }

  /** 过滤替代认证环境，使用 Zeus 持有的官方 CLI 启动 ACP。 */
  private connect(): Promise<AcpConnection> {
    if (this.connecting) return this.connecting;
    if (this.connection) return Promise.resolve(this.connection);
    const operation = (async () => {
      const env = businessProcessEnvironment({ ...process.env, PATH: await resolveCliSearchPath() });
      if (this.disposed) throw agyError('ZEUS_AGY_EXIT', 'Antigravity CLI 已关闭。');
      for (const key of Object.keys(env)) {
        if (/^(?:GOOGLE_(?:APPLICATION_CREDENTIALS|GEMINI_BASE_URL|CLOUD_.*)|AGY_ADC_AUTH)$/iu.test(key) || /(?:_API_KEY|_ACCESS_TOKEN)$/iu.test(key)) delete env[key];
      }
      const executable = readManagedAntigravity(this.probeDirectory);
      if (!executable) throw agyError('ZEUS_AGY_MISSING', '点击登录 Google，Zeus 会准备 Antigravity CLI。');
      /** 独占诊断目录只在子进程存活期间保留，避免读取其他 agy 实例的账号挑战。 */
      const diagnosticDirectory = await mkdtemp(join(tmpdir(), 'zeus-antigravity-'));
      const diagnosticPath = join(diagnosticDirectory, 'acp.log');
      /** 独立的附加目录只有规则引用，使用相对路径读取 Zeus 当前保存的规则。 */
      let rulesDirectory: string | undefined;
      /** 进程退出或准备失败时清理这一代进程的本地文件。 */
      const removeProcessFiles = () => Promise.allSettled([rm(diagnosticDirectory, { recursive: true, force: true }), ...(rulesDirectory ? [rm(rulesDirectory, { recursive: true, force: true })] : [])]);
      let child: ChildProcessWithoutNullStreams;
      try {
        rulesDirectory = await mkdtemp(join(this.options.agentRulesDirectory, '.antigravity-'));
        await writeFile(
          join(rulesDirectory, 'AGENTS.md'),
          '# Zeus session rules\n\nUse the Zeus global rules below and the current project rules for this session. Personal global rules from the host Antigravity profile do not apply to this Zeus session.\n\n@[Zeus global rules](../AGENTS.md)\n',
          { mode: 0o400, flag: 'wx' },
        );
        if (this.disposed) throw agyError('ZEUS_AGY_EXIT', 'Antigravity CLI 已关闭。');
        const invocation = resolveExecutableInvocation(executable, ['acp', '--sandbox', '--add-dir', rulesDirectory, '--log-file', diagnosticPath], { env, cwd: this.probeDirectory });
        child = spawn(invocation.command, invocation.args, { cwd: this.probeDirectory, env: invocation.env, windowsHide: true, windowsVerbatimArguments: invocation.windowsVerbatimArguments, stdio: 'pipe' });
      } catch (error) {
        await removeProcessFiles();
        throw error;
      }
      child.once('close', () => void removeProcessFiles());
      const connection = new AcpConnection(
        child,
        diagnosticPath,
        (source, message) => this.onMessage(source, message),
        (source, error) => this.onClose(source, error),
      );
      this.connection = connection;
      try {
        const result = record(await connection.request('initialize', { protocolVersion: 1, clientInfo: { name: 'zeus', version: '0.1.0' }, clientCapabilities: {} }));
        if (result.protocolVersion !== 1) throw agyError('ZEUS_AGY_PROTOCOL', '当前 Antigravity CLI 的 ACP 协议不可用。');
        this.authMethods = Array.isArray(result.authMethods) ? result.authMethods : [];
        return connection;
      } catch (error) {
        connection.close();
        throw error;
      }
    })();
    this.connecting = operation;
    void operation.then(
      () => {
        if (this.connecting === operation) this.connecting = null;
      },
      () => {
        if (this.connecting === operation) this.connecting = null;
      },
    );
    return operation;
  }

  /** 只有已连通的官方 Google 账号才能创建会话。 */
  private async requireAccount(): Promise<AcpConnection> {
    const account = this.catalog.status === 'ready' || this.catalog.status === 'verification_required' ? this.catalog : await this.refreshAccount();
    if (account.status === 'verification_required') throw antigravityVerificationError();
    if (account.status !== 'ready' || !this.connection) throw agyError('ZEUS_AGY_AUTH_REQUIRED', account.message ?? '请在模型供应商中登录 Google 账号。');
    return this.connection;
  }

  /** 只在同一进程内使用内存中的会话绑定。 */
  private requireSession(identity: AgentSessionIdentity): SessionBinding {
    const binding = this.sessions.get(identity.nativeSessionId);
    if (!binding || identity.runtimeInstanceId !== this.connection?.generationId) throw agyError('ZEUS_AGY_SESSION', 'Antigravity 连接已变化，请恢复会话后再发送。');
    return binding;
  }

  /** 绑定官方会话 ID，ACP 会话不需要本地文件路径。 */
  private bind(connection: AcpConnection, nativeSessionId: string, config: Record<string, unknown>): AgentSessionIdentity {
    const identity = { agentKind: this.kind, runtimeInstanceId: connection.generationId, nativeSessionId, nativeSessionPath: null };
    this.sessions.set(nativeSessionId, { identity, config });
    return identity;
  }

  /** 保存 agy 确认过的可选值和当前值。 */
  private async setConfig(connection: AcpConnection, session: SessionBinding, configId: string, value: string): Promise<void> {
    const response = record(await connection.request('session/set_config_option', { sessionId: session.identity.nativeSessionId, configId, value }));
    this.updateSessionConfig(session, response.configOptions);
  }

  /** 处理实时文本、工具进度与官方权限请求。 */
  private onMessage(connection: AcpConnection, message: RpcMessage): void {
    if (connection !== this.connection || !('method' in message)) return;
    const params = record(message.params);
    const session = typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
    if ('id' in message) {
      if (message.method === 'session/request_permission') void this.approveTool(connection, message.id, session, params).catch(() => connection.close());
      else {
        try {
          connection.write({ id: message.id, error: { code: -32601, message: 'Method not supported' } });
        } catch {
          connection.close();
        }
      }
      return;
    }
    if (message.method !== 'session/update' || !session) return;
    const update = record(params.update);
    if (update.sessionUpdate === 'config_option_update') this.updateSessionConfig(session, update.configOptions);
    const run = session.run;
    if (!run) return;
    if (update.sessionUpdate === 'agent_message_chunk') {
      const { text } = record(update.content);
      if (typeof text !== 'string' || !text) return;
      if (text.trim() === verificationNotice) {
        this.appendMessage(session, run, '');
        run.verificationNotice = text;
      } else this.appendMessage(session, run, text);
    }
    if (typeof update.toolCallId === 'string') {
      if (update.sessionUpdate === 'tool_call' && !run.tools.has(update.toolCallId)) {
        this.endMessage(session);
        run.tools.add(update.toolCallId);
        this.emit(session, 'tool_execution_start', { toolCallId: update.toolCallId, toolName: update.title ?? update.kind ?? 'Antigravity', arguments: update.rawInput });
      }
      if (run.tools.has(update.toolCallId) && (update.status === 'completed' || update.status === 'failed')) {
        run.tools.delete(update.toolCallId);
        this.emit(session, 'tool_execution_end', { toolCallId: update.toolCallId, result: update.content ?? update.rawOutput, isError: update.status === 'failed' });
      }
    }
  }

  /** 保留原生回复文本及首次输出事件。 */
  private appendMessage(session: SessionBinding, run: NonNullable<SessionBinding['run']>, text: string): void {
    const delta = (run.verificationNotice ?? '') + text;
    run.verificationNotice = null;
    if (!delta) return;
    if (!run.text) this.emit(session, 'message_start', { message: { id: run.messageId, role: 'assistant' } });
    run.text += delta;
    this.emit(session, 'message_update', { message: { id: run.messageId, role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta } });
  }

  /** 只向 ACP 回送单次批准、拒绝或取消。 */
  private async approveTool(connection: AcpConnection, id: RpcId, session: SessionBinding | undefined, params: Record<string, unknown>): Promise<void> {
    const run = session?.run;
    const tool = record(params.toolCall);
    const options = Array.isArray(params.options) ? params.options.map(record) : [];
    const allow = options.find((item) => item.kind === 'allow_once');
    const deny = options.find((item) => item.kind === 'reject_once');
    let selected: unknown;
    if (session && run && allow && typeof tool.toolCallId === 'string') {
      const approved = await this.approve(
        {
          session: session.identity,
          nativeRunId: run.id,
          requestId: `acp:${id}`,
          toolCallId: tool.toolCallId,
          toolName: String(tool.title ?? tool.kind ?? 'Antigravity'),
          args: record(tool.rawInput),
          signal: run.abort.signal,
        },
        tool,
      ).catch(() => false);
      if (!run.abort.signal.aborted) selected = approved ? allow?.optionId : deny?.optionId;
    }
    if (this.connection !== connection) return;
    connection.write({ id, result: { outcome: typeof selected === 'string' ? { outcome: 'selected', optionId: selected } : { outcome: 'cancelled' } } });
  }

  /** 将工具调用前的正文与之后的回复存为独立原生条目。 */
  private endMessage(session: SessionBinding): void {
    const run = session.run;
    if (!run) return;
    if (run.verificationNotice) this.appendMessage(session, run, '');
    if (!run.text) return;
    this.emit(session, 'message_end', { message: { id: run.messageId, role: 'assistant', content: [{ type: 'text', text: run.text }] } });
    run.text = '';
    run.messageId = randomUUID();
  }

  /** 收敛正常、取消和失败状态，保留已收到的正文。 */
  private finish(session: SessionBinding, cancelled: boolean, error: Error | null): void {
    if (!session.run) return;
    session.run.abort.abort();
    if (record(error).code === 'ZEUS_AGY_VERIFICATION_REQUIRED') session.run.verificationNotice = null;
    this.endMessage(session);
    if (record(error).code === 'ZEUS_AGY_AUTH_REQUIRED') this.catalog = { status: 'sign_in_required', models: [], message: error!.message };
    if (error) this.emit(session, 'runtime_error', { code: record(error).code ?? 'ZEUS_AGY_RUN_FAILED', message: error.message });
    else this.emit(session, 'agent_settled', { cancelled });
    session.run = undefined;
  }

  /** 断开只结束原进程的会话，正在进行的请求保留结果未知。 */
  private onClose(connection: AcpConnection, error: Error): void {
    if (this.connection !== connection) return;
    this.connection = null;
    if (this.catalog.status === 'ready') this.catalog = { status: 'unavailable', models: [], message: error.message };
    for (const session of this.sessions.values()) {
      this.finish(session, false, agyError('ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN', 'Antigravity CLI 已断开，此轮结果待核对。'));
    }
    this.sessions.clear();
  }

  /** 按原生会话与轮次的稳定身份提交事件。 */
  private emit(session: SessionBinding, type: string, payload: unknown): void {
    for (const listener of this.listeners)
      listener({
        agentKind: this.kind,
        runtimeInstanceId: session.identity.runtimeInstanceId,
        nativeSessionId: session.identity.nativeSessionId,
        nativeRunId: session.run?.id ?? null,
        sequence: ++this.sequence,
        type,
        payload,
        createdAt: this.now(),
      });
  }
}

/** 只在匹配 Google 结构化 403 时接收验证链接，链接必须指向 Google 账号站点。 */
async function readAntigravityVerification(path: string): Promise<{ url: string | null } | null> {
  const file = await open(path, 'r').catch(() => null);
  if (!file) return null;
  try {
    const { size } = await file.stat();
    /** 登录和本轮错误扫描最多读取最近 128 KiB。 */
    const tail = Buffer.alloc(Math.min(size, 128 * 1024));
    const { bytesRead } = await file.read(tail, 0, tail.length, size - tail.length);
    const diagnostics = tail.toString('utf8', 0, bytesRead);
    for (const match of [...diagnostics.matchAll(/Failed to make code assist backend request \([^\r\n]+\): (\{\r?\n[\s\S]*?^\})/gm)].reverse()) {
      const body = match[1];
      if (!body) continue;
      try {
        const error = record(record(JSON.parse(body)).error);
        if (error.code !== 403 || !Array.isArray(error.details)) continue;
        const validation = error.details.map(record).find((item) => item['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo' && item.reason === 'VALIDATION_REQUIRED' && item.domain === 'cloudcode-pa.googleapis.com');
        if (!validation) continue;
        const value = record(validation.metadata).validation_url;
        const url = typeof value === 'string' ? URL.parse(value) : null;
        return { url: url?.origin === 'https://accounts.google.com' && !url.username && !url.password ? url.href : null };
      } catch {
        // 单条截断的诊断不影响其他记录。
      }
    }
    return /^E\d{4} [^\r\n]* errorreport\.go:\d+\] PERMISSION_DENIED \(code 403\): Verify your account to continue\.\r?$/m.test(diagnostics) ? { url: null } : null;
  } catch {
    return null;
  } finally {
    await file.close().catch(() => undefined);
  }
}

/** 服务端提交和失败轮次共用明确的验证提示。 */
function antigravityVerificationError(): Error & { code: string } {
  return agyError('ZEUS_AGY_VERIFICATION_REQUIRED', '请在设置的 Google Antigravity 账号卡片中完成验证后重试。');
}

/** 读取 ACP 的对象字段时拒绝数组和非对象值。 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 读取 ACP 的分组选项。agy 的 thought_level 也可由配置 ID 识别。 */
function selectConfig(result: Record<string, unknown>, category: 'model' | 'mode' | typeof thoughtLevelConfig): { id: string; current: string | null; options: AntigravityModel[] } | undefined {
  const config = Array.isArray(result.configOptions) ? result.configOptions.map(record).find((item) => item.type === 'select' && (item.category === category || item.id === category)) : undefined;
  if (!config || typeof config.id !== 'string' || !Array.isArray(config.options)) return undefined;
  const options = config.options
    .flatMap((item: unknown) => {
      const option = record(item);
      return Array.isArray(option.options) ? option.options : [option];
    })
    .flatMap((item: unknown) => {
      const option = record(item);
      return typeof option.value === 'string' && typeof option.name === 'string' ? [{ id: option.value, name: option.name }] : [];
    });
  return { id: config.id, current: typeof config.currentValue === 'string' ? config.currentValue : null, options };
}

/** agy 也可通过 ACP 的 models 扩展返回可选模型。 */
function legacyModels(models: Record<string, unknown>): AntigravityModel[] {
  return Array.isArray(models.availableModels) ? models.availableModels.map(record).flatMap((model) => (typeof model.modelId === 'string' && typeof model.name === 'string' ? [{ id: model.modelId, name: model.name }] : [])) : [];
}

/** 仅转述 ACP 的已知故障类别，不记录包含授权信息的原始诊断。 */
function agyRpcError(error: { code: number; message: string }): Error {
  if (/quota|rate limit|resource.exhausted|429/i.test(error.message)) return agyError('ZEUS_AGY_QUOTA', 'Antigravity 额度已用尽或已达到 Google 限流，请稍后重试。');
  if (error.code === -32000 || /authentication required|unauthenticated/i.test(error.message)) return agyError('ZEUS_AGY_AUTH_REQUIRED', '请重新登录 Google 账号。');
  return agyError('ZEUS_AGY_RPC', 'Antigravity CLI 拒绝了请求。');
}

/** 通过 Zeus 通用错误契约传递稳定错误码。 */
function agyError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 对 ACP 未提供的宿主操作返回明确原因。 */
function unsupportedAgyOperation(): Error {
  return agyError('ZEUS_AGY_OPERATION_UNAVAILABLE', '此操作在 Antigravity 会话中不可用。');
}
