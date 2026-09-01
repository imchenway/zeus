import {type CommandEnvelope, type CommandScopeKind} from '@zeus/shared';
import {
    commandInputSha256,
    createRendererCommandEnvelope,
    randomIdentity,
    type RendererCommandPayload,
    sha256
} from '../../commandRequest.js';
import {
    durableConversationCommandEnvelope,
    forgetDurableConversationCommandEnvelope
} from './durableCommandEnvelopeCache.js';

export const graphConversationClientCommandTypes = {
  projectConversationCreate: 'conversation.project.create',
  taskConversationCreate: 'conversation.task.create',
  projectGraphScan: 'graph.project.scan',
  projectGraphViewsGenerate: 'graph.project.views.generate',
  projectGraphAsk: 'graph.project.ask',
  currentGraphScan: 'graph.current.scan',
} as const;

export const currentGraphClientScopeId = 'current-project-root';

type GraphConversationClientCommandType = (typeof graphConversationClientCommandTypes)[keyof typeof graphConversationClientCommandTypes];
type GraphConversationClientScopeKind = Extract<CommandScopeKind, 'project' | 'task'>;
type GraphConversationCommandPayload = RendererCommandPayload;
const stableRequests = new Map<string, Promise<{ command: CommandEnvelope<GraphConversationCommandPayload>; input: object }>>();
const maximumStableRequests = 256;
const graphConversationCommandNamespace = 'graph-conversation';

/** 一次用户意图只生成一个不可变 Body；同一 reconnectIdentity 的 transport 重连必须复用它。 */
export async function buildGraphConversationCommandRequest<TInput extends object>(input: {
  commandType: GraphConversationClientCommandType;
  scopeKind: GraphConversationClientScopeKind;
  scopeId: string;
  value: TInput;
  operationSeed?: string;
  reconnectIdentity?: string;
}): Promise<{ command: CommandEnvelope<GraphConversationCommandPayload>; input: TInput }> {
  if (input.reconnectIdentity) {
    const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
    const existing = stableRequests.get(cacheKey);
    if (existing) {
      const request = (await existing) as { command: CommandEnvelope<GraphConversationCommandPayload>; input: TInput };
        if (request.command.payload.inputSha256 !== (await commandInputSha256(input.value))) {
        throw new Error('A reconnect identity cannot be reused with different Graph/Conversation command input.');
      }
      return request;
    }
      const inputSha256 = await commandInputSha256(input.value);
    const created = durableConversationCommandEnvelope({
      namespace: graphConversationCommandNamespace,
      stableIdentity: cacheKey,
      inputSha256,
      commandType: input.commandType,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      create: () => createGraphConversationCommandEnvelope(input, inputSha256),
    }).then((command) => ({ command, input: input.value }));
    stableRequests.set(cacheKey, created as Promise<{ command: CommandEnvelope<GraphConversationCommandPayload>; input: object }>);
    while (stableRequests.size > maximumStableRequests) stableRequests.delete(stableRequests.keys().next().value!);
    return created;
  }
  return createGraphConversationCommandRequest(input);
}

async function createGraphConversationCommandRequest<TInput extends object>(input: {
  commandType: GraphConversationClientCommandType;
  scopeKind: GraphConversationClientScopeKind;
  scopeId: string;
  value: TInput;
  operationSeed?: string;
}): Promise<{ command: CommandEnvelope<GraphConversationCommandPayload>; input: TInput }> {
    const inputSha256 = await commandInputSha256(input.value);
  return { command: await createGraphConversationCommandEnvelope(input, inputSha256), input: input.value };
}

async function createGraphConversationCommandEnvelope(
  input: {
    commandType: GraphConversationClientCommandType;
    scopeKind: GraphConversationClientScopeKind;
    scopeId: string;
    operationSeed?: string;
  },
  inputSha256: string,
): Promise<CommandEnvelope<GraphConversationCommandPayload>> {
    const operationIdentity = `graph_conversation_operation_${input.operationSeed ? (await sha256(`${input.commandType}\0${input.operationSeed}`)).slice(0, 32) : randomIdentity(true)}`;
    return createRendererCommandEnvelope({
        ...input,
        operationIdentity,
        inputSha256,
        commandIdPrefix: 'command_graph_conversation_',
        actorId: 'zeus-desktop-graph-conversation',
        expectedRevision: null
    });
}

export function forgetGraphConversationCommandRequest(input: { commandType: GraphConversationClientCommandType; scopeKind: GraphConversationClientScopeKind; scopeId: string; reconnectIdentity: string }): void {
  const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
  stableRequests.delete(cacheKey);
  forgetDurableConversationCommandEnvelope(graphConversationCommandNamespace, cacheKey);
}
