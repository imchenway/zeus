import { canonicalCommandInputJson, type CommandEnvelope, commandEnvelopeSchemaGeneration, parseCommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { durableConversationCommandEnvelope, forgetDurableConversationCommandEnvelope } from './features/conversations/durableCommandEnvelopeCache.js';

/** 未得到确定结果的命令按业务输入保留身份，重试不能创建第二次写入。 */
const pendingCommandIdentities = new Map<string, string>();
/** 共享命令复用已有耐久信封存储，与会话专用发送身份分开。 */
const rendererCommandNamespace = 'renderer-mutation';

export type RendererCommandPayload = { operationIdentity: string; inputSha256: string };

interface RendererCommandEnvelopeInput {
  commandType: string;
  commandIdPrefix: string;
  actorId: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  inputSha256: string;
  expectedRevision?: number | null;
}

/** 构造单次操作的命令；跨请求复用由知道实际路由的传输入口完成。 */
export async function buildRendererCommandRequest<TInput extends object>(
  input: Omit<RendererCommandEnvelopeInput, 'inputSha256'> & {
    value: TInput;
  },
): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  return {
    command: createRendererCommandEnvelope({ ...input, inputSha256: await commandInputSha256(input.value) }),
    input: input.value,
  };
}

/** 按实际路由和业务正文保留未确认命令，避免跨项目或跨模板复用操作身份。 */
export async function prepareRendererCommandRequest(path: string, init: RequestInit, suppliedCommand?: CommandEnvelope<RendererCommandPayload>): Promise<RequestInit> {
  if (typeof init.body !== 'string') return init;
  let body: unknown;
  try {
    body = JSON.parse(init.body) as unknown;
  } catch {
    return init;
  }
  const embedded = typeof body === 'object' && body !== null && 'command' in body ? body.command : null;
  const rawCommand = suppliedCommand ?? embedded;
  if (typeof rawCommand !== 'object' || rawCommand === null || !('schemaGeneration' in rawCommand) || rawCommand.schemaGeneration !== commandEnvelopeSchemaGeneration) return init;
  const original = parseCommandEnvelope<RendererCommandPayload>(rawCommand);
  const scopeId = original.scope.id.replace(original.payload.operationIdentity, '{operation}');
  const value = suppliedCommand ? body : Object.fromEntries(Object.entries(body as Record<string, unknown>).filter(([key]) => key !== 'command'));
  const stableIdentity = await commandInputSha256({
    path,
    method: init.method ?? 'GET',
    commandType: original.commandType,
    actor: original.actor,
    scopeKind: original.scope.kind,
    scopeId,
    expectedRevision: original.expectedRevision,
    value,
  });
  const command = await durableConversationCommandEnvelope({
    namespace: rendererCommandNamespace,
    stableIdentity,
    inputSha256: original.payload.inputSha256,
    commandType: original.commandType,
    scopeKind: original.scope.kind,
    ...(scopeId === original.scope.id ? { scopeId } : {}),
    create: () => original,
  });
  if (command.actor.id !== original.actor.id || command.actor.kind !== original.actor.kind || command.scope.id.replace(command.payload.operationIdentity, '{operation}') !== scopeId || command.expectedRevision !== original.expectedRevision)
    throw new Error('待核对命令与当前操作范围不一致。');
  pendingCommandIdentities.set(command.idempotencyKey, stableIdentity);
  const headers = new Headers(init.headers);
  headers.set('idempotency-key', command.idempotencyKey);
  return { ...init, headers, body: suppliedCommand ? init.body : JSON.stringify({ ...(body as Record<string, unknown>), command }) };
}

/** 只有确定成功或明确拒绝才释放身份；读取刷新与传输中断不能结束原写操作。 */
export async function settleRendererCommandRequest(key: string | null | undefined): Promise<void> {
  const identity = key ? pendingCommandIdentities.get(key) : undefined;
  if (!key || !identity) return;
  await forgetDurableConversationCommandEnvelope(rendererCommandNamespace, identity);
  pendingCommandIdentities.delete(key);
}

export function createRendererCommandEnvelope(input: RendererCommandEnvelopeInput): CommandEnvelope<RendererCommandPayload> {
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: `${input.commandIdPrefix}${randomIdentity()}`,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: input.actorId },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: input.expectedRevision ?? null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: new Date().toISOString(),
    payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
  };
}

export function commandInputSha256(value: unknown): Promise<string> {
  return sha256(canonicalCommandInputJson(value));
}

export async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomIdentity(compact = false): string {
  const value = typeof globalThis.crypto.randomUUID === 'function' ? globalThis.crypto.randomUUID() : Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return compact ? value.replaceAll('-', '') : value;
}
