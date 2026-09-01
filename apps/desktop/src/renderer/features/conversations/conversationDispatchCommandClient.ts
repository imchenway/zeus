import { type CommandEnvelope, conversationDispatchWireCommandTypes, type ConversationDispatchWireCommandType, type ConversationDispatchWirePayload, type ConversationDispatchWireScopeKind } from '@zeus/shared';
import { commandInputSha256, createRendererCommandEnvelope, randomIdentity, type RendererCommandPayload } from '../../commandRequest.js';
import { durableConversationCommandEnvelope, forgetDurableConversationCommandEnvelope } from './durableCommandEnvelopeCache.js';

export const conversationDispatchClientCommandTypes = conversationDispatchWireCommandTypes;
type ConversationDispatchClientCommandType = ConversationDispatchWireCommandType;
type ConversationDispatchClientScopeKind = ConversationDispatchWireScopeKind;
type ConversationDispatchCommandPayload = ConversationDispatchWirePayload & RendererCommandPayload;
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
      const currentSha256 = await commandInputSha256(input.value);
      if (request.command.payload.inputSha256 !== currentSha256) throw new Error('A reconnect identity cannot be reused with different conversation command input.');
      return request;
    }
    const inputSha256 = await commandInputSha256(input.value);
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
  const inputSha256 = await commandInputSha256(input.value);
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
  return createRendererCommandEnvelope({
    ...input,
    operationIdentity,
    inputSha256,
    commandIdPrefix: 'command_conversation_dispatch_',
    actorId: 'zeus-desktop-conversation-dispatch',
    expectedRevision: null,
  });
}

export function forgetConversationDispatchCommandRequest(input: { commandType: ConversationDispatchClientCommandType; scopeKind: ConversationDispatchClientScopeKind; scopeId: string; reconnectIdentity: string }): void {
  const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
  stableRequests.delete(cacheKey);
  forgetDurableConversationCommandEnvelope(conversationDispatchCommandNamespace, cacheKey);
}
