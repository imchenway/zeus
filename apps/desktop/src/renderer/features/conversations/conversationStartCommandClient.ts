import { type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { commandInputSha256, createRendererCommandEnvelope, randomIdentity, type RendererCommandPayload, sha256 } from '../../commandRequest.js';
import { durableConversationCommandEnvelope, forgetDurableConversationCommandEnvelope } from './durableCommandEnvelopeCache.js';

/** 客户端会话首发使用的稳定命令名称。 */
export const conversationStartClientCommandTypes = {
  projectConversationCreate: 'conversation.project.create',
  taskConversationCreate: 'conversation.task.create',
} as const;

/** 会话首发的数据约束。 */
type ConversationStartClientCommandType = (typeof conversationStartClientCommandTypes)[keyof typeof conversationStartClientCommandTypes];
/** 会话首发的数据约束。 */
type ConversationStartClientScopeKind = Extract<CommandScopeKind, 'project' | 'task'>;
/** 会话首发的数据约束。 */
type ConversationStartCommandPayload = RendererCommandPayload;
/** 同一首发意图在当前页面内复用请求。 */
const stableRequests = new Map<string, Promise<{ command: CommandEnvelope<ConversationStartCommandPayload>; input: object }>>();
/** 首发请求内存缓存的最大条目数。 */
const maximumStableRequests = 256;
/** 沿用已有首发持久身份，确保升级后的重连不会生成第二次发送。 */
const conversationStartCommandNamespace = 'graph-conversation';

/** 一次用户意图只生成一个不可变 Body；同一 reconnectIdentity 的 transport 重连必须复用它。 */
export async function buildConversationStartCommandRequest<TInput extends object>(input: {
  commandType: ConversationStartClientCommandType;
  scopeKind: ConversationStartClientScopeKind;
  scopeId: string;
  value: TInput;
  operationSeed?: string;
  reconnectIdentity?: string;
}): Promise<{ command: CommandEnvelope<ConversationStartCommandPayload>; input: TInput }> {
  if (input.reconnectIdentity) {
    const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
    const existing = stableRequests.get(cacheKey);
    if (existing) {
      const request = (await existing) as { command: CommandEnvelope<ConversationStartCommandPayload>; input: TInput };
      if (request.command.payload.inputSha256 !== (await commandInputSha256(input.value))) {
        throw new Error('同一重连身份不能用于不同的会话首发内容。');
      }
      return request;
    }
    const inputSha256 = await commandInputSha256(input.value);
    const created = durableConversationCommandEnvelope({
      namespace: conversationStartCommandNamespace,
      stableIdentity: cacheKey,
      inputSha256,
      commandType: input.commandType,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      create: () => createConversationStartCommandEnvelope(input, inputSha256),
    }).then((command) => ({ command, input: input.value }));
    stableRequests.set(cacheKey, created as Promise<{ command: CommandEnvelope<ConversationStartCommandPayload>; input: object }>);
    while (stableRequests.size > maximumStableRequests) stableRequests.delete(stableRequests.keys().next().value!);
    return created;
  }
  return createConversationStartCommandRequest(input);
}

/** 构造首次发送的命令与正文。 */
async function createConversationStartCommandRequest<TInput extends object>(input: {
  commandType: ConversationStartClientCommandType;
  scopeKind: ConversationStartClientScopeKind;
  scopeId: string;
  value: TInput;
  operationSeed?: string;
}): Promise<{ command: CommandEnvelope<ConversationStartCommandPayload>; input: TInput }> {
  const inputSha256 = await commandInputSha256(input.value);
  return { command: await createConversationStartCommandEnvelope(input, inputSha256), input: input.value };
}

/** 沿用历史首发身份生成不可变命令信封。 */
async function createConversationStartCommandEnvelope(
  input: {
    commandType: ConversationStartClientCommandType;
    scopeKind: ConversationStartClientScopeKind;
    scopeId: string;
    operationSeed?: string;
  },
  inputSha256: string,
): Promise<CommandEnvelope<ConversationStartCommandPayload>> {
  const operationIdentity = `graph_conversation_operation_${input.operationSeed ? (await sha256(`${input.commandType}\0${input.operationSeed}`)).slice(0, 32) : randomIdentity(true)}`;
  return createRendererCommandEnvelope({
    ...input,
    operationIdentity,
    inputSha256,
    commandIdPrefix: 'command_graph_conversation_',
    actorId: 'zeus-desktop-graph-conversation',
    expectedRevision: null,
  });
}

/** 用户意图完成后释放对应的请求缓存。 */
export function forgetConversationStartCommandRequest(input: { commandType: ConversationStartClientCommandType; scopeKind: ConversationStartClientScopeKind; scopeId: string; reconnectIdentity: string }): void {
  const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
  stableRequests.delete(cacheKey);
  forgetDurableConversationCommandEnvelope(conversationStartCommandNamespace, cacheKey);
}
