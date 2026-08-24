import { createHash } from 'node:crypto';
import type { AgentRuntimeHealthSnapshot } from '@zeus/ai-runtime';
import { parseCommandEnvelope, type CommandEnvelope } from '@zeus/shared';
import type { CommandDeliveryRepository, CommandDeliverySnapshot } from '@zeus/storage';

const providerRuntimeRecoveryCommandType = 'provider.runtime.pi.recover';
const providerRuntimeRecoveryScopeId = 'provider:pi';
const explicitlyRejectedRecoveryCodes = new Set(['ZEUS_PI_WORKER_RECOVERY_BUSY', 'ZEUS_PI_WORKER_CLOSED']);

interface PiRuntimeRecoveryPayload extends Record<string, unknown> {
  provider: 'pi';
  expectedGenerationId: string | null;
  acknowledgeUnknownResultNoReplay: true;
}

export interface ProviderRuntimeRecoveryResult {
  recovered: true;
  commandId: string;
  outboxId: string;
  idempotentReplay: boolean;
  previousGenerationId: string | null;
  generationId: string;
  replayedCommandCount: 0;
  health: AgentRuntimeHealthSnapshot;
}

export interface ProviderRuntimeRecoveryApplicationPort {
  execute(command: unknown): Promise<ProviderRuntimeRecoveryResult>;
}

export interface ProviderRuntimeRecoveryApplicationServiceOptions {
  commandDeliveries: CommandDeliveryRepository;
  readPiHealth(): AgentRuntimeHealthSnapshot;
  recoverPi(): Promise<AgentRuntimeHealthSnapshot>;
  now?: () => string;
}

interface ActiveRecovery {
  commandId: string;
  requestSha256: string;
  promise: Promise<ProviderRuntimeRecoveryResult>;
}

/**
 * Pi Runtime 恢复的单写入者应用边界。
 *
 * 同一命令的并发重连共享结果，其他恢复命令在活动操作期间失败关闭，不形成无界队列。
 * generation CAS 在接纳新 Outbox 前完成；一旦写出水位落盘，只有明确 busy/closed
 * 可以安全重试，其余失败全部按 unknown 封口，绝不自动再次切换 Worker。
 */
export class ProviderRuntimeRecoveryApplicationService implements ProviderRuntimeRecoveryApplicationPort {
  private readonly now: () => string;
  private active: ActiveRecovery | null = null;

  constructor(private readonly options: ProviderRuntimeRecoveryApplicationServiceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  execute(rawCommand: unknown): Promise<ProviderRuntimeRecoveryResult> {
    const command = parsePiRuntimeRecoveryCommand(rawCommand);
    const requestSha256 = sha256(canonicalJson(command));
    if (this.active) {
      if (this.active.commandId === command.commandId && this.active.requestSha256 === requestSha256) return this.active.promise;
      throw recoveryError('ZEUS_PROVIDER_RECOVERY_BUSY', '已有 Provider Runtime 恢复命令正在执行；请刷新 generation 后重试。', 409);
    }
    const promise = this.executeOwned(command, requestSha256).finally(() => {
      if (this.active?.commandId === command.commandId && this.active.requestSha256 === requestSha256) this.active = null;
    });
    this.active = { commandId: command.commandId, requestSha256, promise };
    return promise;
  }

  private async executeOwned(command: CommandEnvelope<PiRuntimeRecoveryPayload>, requestSha256: string): Promise<ProviderRuntimeRecoveryResult> {
    const input = {
      envelope: command,
      requestSha256,
      destinationKind: 'provider_runtime' as const,
      destinationId: 'pi',
      resourceId: providerRuntimeRecoveryScopeId,
      occurredAt: this.now(),
    };
    const existing = this.options.commandDeliveries.get(command.commandId);
    if (existing && blocksRuntimeRecoveryReplay(existing)) {
      try {
        this.options.commandDeliveries.acceptAndPrepare(input);
      } catch (error) {
        if (readErrorCode(error) !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
        return this.resolveBlockedReplay(command, existing);
      }
    }

    const before = this.options.readPiHealth();
    if (before.generationId !== command.payload.expectedGenerationId) {
      throw recoveryError('ZEUS_PROVIDER_RECOVERY_STALE_GENERATION', 'Pi Worker generation 已变化，请刷新运行态后使用新的 Command Envelope。', 409, {
        expectedGenerationId: command.payload.expectedGenerationId,
        actualGenerationId: before.generationId,
      });
    }

    const prepared = this.options.commandDeliveries.acceptAndPrepare(input);
    this.options.commandDeliveries.markProviderWriteStarted({ outboxId: prepared.outbox.id, occurredAt: this.now() });
    let after: AgentRuntimeHealthSnapshot;
    try {
      after = await this.options.recoverPi();
      assertAcceptedRecoveryHealth(before, after);
    } catch (error) {
      const errorCode = readErrorCode(error);
      const explicitlyRejected = errorCode !== null && explicitlyRejectedRecoveryCodes.has(errorCode);
      const observedHealth = safelyReadHealth(this.options.readPiHealth);
      this.options.commandDeliveries.recordOutcome({
        outboxId: prepared.outbox.id,
        outcome: explicitlyRejected ? 'explicitly_rejected' : 'outcome_unknown_after_write',
        providerId: 'pi',
        providerGenerationId: observedHealth?.generationId ?? before.generationId,
        evidence: {
          source: 'provider_runtime_recovery',
          result: explicitlyRejected ? 'explicitly_rejected' : 'outcome_unknown_after_write',
          expectedGenerationId: command.payload.expectedGenerationId,
          observedGenerationId: observedHealth?.generationId ?? null,
          error: { code: errorCode, message: error instanceof Error ? error.message : String(error) },
          replayedCommandCount: 0,
        },
        occurredAt: this.now(),
      });
      if (explicitlyRejected) throw error;
      throw recoveryError('ZEUS_PROVIDER_RECOVERY_OUTCOME_UNKNOWN', 'Pi Worker 恢复在写出后未取得完整接纳证据。', 409, {
        commandId: command.commandId,
        outboxId: prepared.outbox.id,
        causeCode: errorCode,
      });
    }

    this.options.commandDeliveries.recordOutcome({
      outboxId: prepared.outbox.id,
      outcome: 'accepted',
      providerId: 'pi',
      providerGenerationId: after.generationId,
      nativeSessionId: after.generationId,
      evidence: {
        source: 'provider_runtime_recovery',
        previousGenerationId: before.generationId,
        generationId: after.generationId,
        lifecycle: after.lifecycle,
        circuitState: after.circuit.state,
        replayedCommandCount: 0,
      },
      occurredAt: this.now(),
    });
    return {
      recovered: true,
      commandId: command.commandId,
      outboxId: prepared.outbox.id,
      idempotentReplay: false,
      previousGenerationId: before.generationId,
      generationId: after.generationId!,
      replayedCommandCount: 0,
      health: after,
    };
  }

  private resolveBlockedReplay(command: CommandEnvelope<PiRuntimeRecoveryPayload>, snapshot: CommandDeliverySnapshot): ProviderRuntimeRecoveryResult {
    const latest = snapshot.attempts.at(-1);
    if (latest?.receipt?.outcome === 'accepted' && latest.receipt.nativeSessionId) {
      return {
        recovered: true,
        commandId: command.commandId,
        outboxId: latest.id,
        idempotentReplay: true,
        previousGenerationId: command.payload.expectedGenerationId,
        generationId: latest.receipt.nativeSessionId,
        replayedCommandCount: 0,
        health: this.options.readPiHealth(),
      };
    }
    throw recoveryError('ZEUS_PROVIDER_RECOVERY_OUTCOME_UNKNOWN', '该恢复命令已有写出后未知证据。', 409, {
      commandId: command.commandId,
      outboxId: latest?.id ?? null,
    });
  }
}

function parsePiRuntimeRecoveryCommand(value: unknown): CommandEnvelope<PiRuntimeRecoveryPayload> {
  const command = parseCommandEnvelope<PiRuntimeRecoveryPayload>(value);
  const payload = command.payload;
  if (
    command.commandType !== providerRuntimeRecoveryCommandType ||
    command.scope.kind !== 'runtime_segment' ||
    command.scope.id !== providerRuntimeRecoveryScopeId ||
    command.expectedRevision !== null ||
    (command.actor.kind !== 'user' && command.actor.kind !== 'local_api') ||
    payload.provider !== 'pi' ||
    payload.acknowledgeUnknownResultNoReplay !== true ||
    !Object.prototype.hasOwnProperty.call(payload, 'expectedGenerationId') ||
    (payload.expectedGenerationId !== null && !validIdentity(payload.expectedGenerationId)) ||
    Object.keys(payload).some((key) => !['provider', 'expectedGenerationId', 'acknowledgeUnknownResultNoReplay'].includes(key))
  ) {
    throw recoveryError('ZEUS_PROVIDER_RECOVERY_COMMAND_INVALID', '恢复命令必须使用 provider.runtime.pi.recover、runtime_segment/provider:pi、null revision，并明确 generation 与不重放确认。', 400);
  }
  return command;
}

function blocksRuntimeRecoveryReplay(snapshot: CommandDeliverySnapshot): boolean {
  const latest = snapshot.attempts.at(-1);
  return latest?.state === 'provider_write_started' || latest?.outcome === 'outcome_unknown_after_write' || latest?.outcome === 'accepted';
}

function assertAcceptedRecoveryHealth(before: AgentRuntimeHealthSnapshot, after: AgentRuntimeHealthSnapshot): void {
  if (after.agentKind !== 'pi' || !after.generationId || after.generationId === before.generationId || after.lifecycle !== 'healthy' || after.circuit.state !== 'closed') {
    throw recoveryError('ZEUS_PROVIDER_RECOVERY_ACCEPTANCE_INVALID', 'Pi Worker 恢复没有返回新且健康的 generation，按写出后结果未知处理。', 409, {
      previousGenerationId: before.generationId,
      observedGenerationId: after.generationId,
      lifecycle: after.lifecycle,
      circuitState: after.circuit.state,
    });
  }
}

function safelyReadHealth(read: () => AgentRuntimeHealthSnapshot): AgentRuntimeHealthSnapshot | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127);
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function recoveryError(code: string, message: string, statusCode: number, details: Record<string, unknown> = {}): Error & { code: string; statusCode: number; details: Record<string, unknown> } {
  return Object.assign(new Error(message), { code, statusCode, details });
}
