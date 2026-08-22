import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

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
type GraphConversationCommandPayload = { operationIdentity: string; inputSha256: string };
const stableRequests = new Map<string, Promise<{ command: CommandEnvelope<GraphConversationCommandPayload>; input: object }>>();
const maximumStableRequests = 256;

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
      if (request.command.payload.inputSha256 !== (await sha256(canonicalCommandInputJson(input.value)))) {
        throw new Error('A reconnect identity cannot be reused with different Graph/Conversation command input.');
      }
      return request;
    }
    const created = createGraphConversationCommandRequest(input);
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
  const operationIdentity = `graph_conversation_operation_${input.operationSeed ? (await sha256(`${input.commandType}\0${input.operationSeed}`)).slice(0, 32) : randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_graph_conversation_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-graph-conversation' },
      scope: { kind: input.scopeKind, id: input.scopeId },
      expectedRevision: null,
      idempotencyKey: `${input.commandType}:${operationIdentity}`,
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity, inputSha256 },
    },
    input: input.value,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomIdentity(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID().replaceAll('-', '');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
