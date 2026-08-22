import { canonicalCommandInputJson, type CommandEnvelope, commandEnvelopeSchemaGeneration, type CommandScopeKind } from '@zeus/shared';
import { durableConversationCommandEnvelope, forgetDurableConversationCommandEnvelope } from './durableCommandEnvelopeCache.js';

export const conversationDispatchClientCommandTypes = {
  changeSetUndo: 'conversation.turn.change_set.undo',
  changeSetReapply: 'conversation.turn.change_set.reapply',
  messageSubmit: 'conversation.message.submit',
  sideChatAsk: 'conversation.side_chat.ask',
  queueUpdate: 'conversation.queue.update',
  queueRetry: 'conversation.queue.retry',
  queueReroute: 'conversation.queue.reroute',
  queueDelete: 'conversation.queue.delete',
  queueSendNow: 'conversation.queue.send_now',
  queueResume: 'conversation.queue.resume',
  queueRecover: 'conversation.queue.recover',
  queueReorder: 'conversation.queue.reorder',
  turnInterrupt: 'conversation.turn.interrupt',
  serverRequestRespond: 'conversation.server_request.respond',
  planImplementationRespond: 'conversation.plan_implementation.respond',
  requestSnooze: 'conversation.request.snooze',
} as const;

type ConversationDispatchClientCommandType = (typeof conversationDispatchClientCommandTypes)[keyof typeof conversationDispatchClientCommandTypes];
type ConversationDispatchClientScopeKind = Extract<CommandScopeKind, 'product_conversation' | 'submission' | 'turn' | 'approval'>;
type ConversationDispatchCommandPayload = { operationIdentity: string; inputSha256: string };
const stableRequests = new Map<string, Promise<{ command: CommandEnvelope<ConversationDispatchCommandPayload>; input: object }>>();
const maximumStableRequests = 256;
const conversationDispatchCommandNamespace = 'conversation-dispatch';

/** Transport 重连与 HTTP 重试必须复用此处一次构造的不可变 Envelope 与正文。 */
export async function buildConversationDispatchCommandRequest<TInput extends object>(input: {
  commandType: ConversationDispatchClientCommandType;
  scopeKind: ConversationDispatchClientScopeKind;
  scopeId: string;
  value: TInput;
  /** 仅用于跨 transport 重连的同一用户动作；相同 key 携带不同正文会失败关闭。 */
  reconnectIdentity?: string;
}): Promise<{ command: CommandEnvelope<ConversationDispatchCommandPayload>; input: TInput }> {
  if (input.reconnectIdentity) {
    const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
    const existing = stableRequests.get(cacheKey);
    if (existing) {
      const request = (await existing) as { command: CommandEnvelope<ConversationDispatchCommandPayload>; input: TInput };
      const currentSha256 = await sha256(canonicalCommandInputJson(input.value));
      if (request.command.payload.inputSha256 !== currentSha256) throw new Error('A reconnect identity cannot be reused with different conversation command input.');
      return request;
    }
    const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
    const created = durableConversationCommandEnvelope({
      namespace: conversationDispatchCommandNamespace,
      stableIdentity: cacheKey,
      inputSha256,
      commandType: input.commandType,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      create: () => createConversationDispatchCommandEnvelope(input, inputSha256),
    }).then((command) => ({ command, input: input.value }));
    stableRequests.set(cacheKey, created as Promise<{ command: CommandEnvelope<ConversationDispatchCommandPayload>; input: object }>);
    while (stableRequests.size > maximumStableRequests) stableRequests.delete(stableRequests.keys().next().value!);
    return created;
  }
  return createConversationDispatchCommandRequest(input);
}

async function createConversationDispatchCommandRequest<TInput extends object>(input: {
  commandType: ConversationDispatchClientCommandType;
  scopeKind: ConversationDispatchClientScopeKind;
  scopeId: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<ConversationDispatchCommandPayload>; input: TInput }> {
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return { command: createConversationDispatchCommandEnvelope(input, inputSha256), input: input.value };
}

function createConversationDispatchCommandEnvelope(
  input: {
    commandType: ConversationDispatchClientCommandType;
    scopeKind: ConversationDispatchClientScopeKind;
    scopeId: string;
  },
  inputSha256: string,
): CommandEnvelope<ConversationDispatchCommandPayload> {
  const operationIdentity = `conversation_dispatch_operation_${randomIdentity()}`;
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: `command_conversation_dispatch_${randomIdentity()}`,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'zeus-desktop-conversation-dispatch' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${operationIdentity}`,
    issuedAt: new Date().toISOString(),
    payload: { operationIdentity, inputSha256 },
  };
}

export function forgetConversationDispatchCommandRequest(input: { commandType: ConversationDispatchClientCommandType; scopeKind: ConversationDispatchClientScopeKind; scopeId: string; reconnectIdentity: string }): void {
  const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
  stableRequests.delete(cacheKey);
  forgetDurableConversationCommandEnvelope(conversationDispatchCommandNamespace, cacheKey);
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomIdentity(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
