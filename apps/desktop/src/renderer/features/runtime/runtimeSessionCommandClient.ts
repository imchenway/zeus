import { type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { type LocalApiTransport, ZeusApiError } from '../../transport/localApiTransport.js';
import { buildRendererCommandRequest, randomIdentity, type RendererCommandPayload, sha256 } from '../../commandRequest.js';

export const runtimeSessionClientCommandTypes = {
  confirmationCreate: 'runtime.confirmation.create',
  confirmationConfirm: 'runtime.confirmation.confirm',
  confirmationReject: 'runtime.confirmation.reject',
  sessionStart: 'runtime.session.start',
  sessionInterrupt: 'runtime.session.interrupt',
  sessionStop: 'runtime.session.stop',
  sessionSummaryGenerate: 'runtime.session.summary.generate',
  sessionFavoriteSet: 'runtime.session.favorite.set',
  sessionArchive: 'runtime.session.archive',
  sessionRestore: 'runtime.session.restore',
  sessionTaskCreate: 'runtime.session.task.create',
  sessionDelete: 'runtime.session.delete',
} as const;

type RuntimeSessionClientCommandType = (typeof runtimeSessionClientCommandTypes)[keyof typeof runtimeSessionClientCommandTypes];

/** Transport 的两个网络 attempt 复用同一个序列化 Body；正文只进入 input，不复制到 Inbox payload。 */
export async function buildRuntimeSessionCommandRequest<TInput extends object>(input: {
  commandType: RuntimeSessionClientCommandType;
  scopeKind: Extract<CommandScopeKind, 'approval' | 'runtime_segment'>;
  scopeId(operationIdentity: string): string;
  operationPrefix: string;
  operationSeed?: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const suffix = input.operationSeed ? (await sha256(`${input.commandType}\0${input.operationSeed}`)).slice(0, 32) : randomIdentity();
  const operationIdentity = `${input.operationPrefix}${suffix}`;
  return buildRendererCommandRequest({
    ...input,
    scopeId: input.scopeId(operationIdentity),
    operationIdentity,
    commandIdPrefix: 'command_runtime_session_',
    actorId: stableRuntimeRendererClientId(),
    expectedRevision: null,
  });
}

interface RuntimeEphemeralLease {
  leaseId: string;
  clientId: string;
  sessionId: string;
  nextSequence: number;
  expiresAt: string;
}

/** input/resize 走短租约和单调序列；失败后重新读取服务端 nextSequence，不猜测上次是否写入。 */
export class RuntimeEphemeralCapabilityClient {
  private readonly leases = new Map<string, RuntimeEphemeralLease>();
  private readonly clientId = stableRuntimeRendererClientId();

  constructor(private readonly transport: LocalApiTransport) {}

  send<TInput extends object, TResult>(sessionId: string, kind: 'input' | 'resize', input: TInput): Promise<TResult> {
    return this.sendOnce<TInput, TResult>(sessionId, kind, input, true);
  }

  private async sendOnce<TInput extends object, TResult>(sessionId: string, kind: 'input' | 'resize', input: TInput, mayRenew: boolean): Promise<TResult> {
    const lease = await this.requireLease(sessionId);
    const body = {
      capability: { leaseId: lease.leaseId, clientId: lease.clientId, sequence: lease.nextSequence },
      input,
    };
    try {
      const result = await this.transport.request<TResult>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/${kind}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      lease.nextSequence += 1;
      return result;
    } catch (error) {
      // 网络未知与 lease 冲突都丢弃本地游标；续次先向服务端读取真实 nextSequence。
      this.leases.delete(sessionId);
      if (mayRenew && isRenewableLeaseError(error)) return this.sendOnce<TInput, TResult>(sessionId, kind, input, false);
      throw error;
    }
  }

  private async requireLease(sessionId: string): Promise<RuntimeEphemeralLease> {
    const cached = this.leases.get(sessionId);
    if (cached && Date.parse(cached.expiresAt) > Date.now()) return cached;
    const lease = await this.transport.request<RuntimeEphemeralLease>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/capabilities/ephemeral`, {
      method: 'POST',
      body: JSON.stringify({ clientId: this.clientId }),
    });
    this.leases.set(sessionId, lease);
    return lease;
  }
}

function isRenewableLeaseError(error: unknown): boolean {
  return error instanceof ZeusApiError && ['ZEUS_RUNTIME_EPHEMERAL_LEASE_REQUIRED', 'ZEUS_RUNTIME_EPHEMERAL_LEASE_EXPIRED', 'ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_GAP', 'ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_CONFLICT'].includes(error.error ?? '');
}

let fallbackRendererClientId: string | undefined;

function stableRuntimeRendererClientId(): string {
  const storageKey = 'zeus.runtime.renderer-client-id.v1';
  try {
    const existing = globalThis.sessionStorage?.getItem(storageKey)?.trim();
    if (existing) return existing;
    const created = `zeus-desktop-runtime-${randomIdentity()}`;
    globalThis.sessionStorage?.setItem(storageKey, created);
    return created;
  } catch {
    fallbackRendererClientId ??= `zeus-desktop-runtime-${randomIdentity()}`;
    return fallbackRendererClientId;
  }
}
