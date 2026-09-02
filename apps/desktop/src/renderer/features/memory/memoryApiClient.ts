import { canonicalCommandInputJson } from '@zeus/shared';
import { buildRendererCommandRequest, randomIdentity, sha256 } from '../../commandRequest.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import type { MemoryCandidateInput, MemoryListQuery, MemoryPage, MemoryRecord, SupersedingMemoryCandidateInput } from './memoryContracts.js';

type MemoryCommandType = 'memory.candidate.record' | 'memory.record.supersede' | 'memory.record.tombstone';
type MemoryMutationResponse = { commandId: string; operationIdentity: string; replayed: boolean; record: MemoryRecord };

export interface MemoryApiClient {
  list(input: MemoryListQuery): Promise<MemoryPage>;
  create(input: MemoryCandidateInput): Promise<MemoryRecord>;
  supersede(previousId: string, input: SupersedingMemoryCandidateInput): Promise<MemoryRecord>;
  tombstone(id: string, reason: string): Promise<MemoryRecord>;
}

/** Memory bounded context 的唯一 HTTP 映射；UI/query store 不拼接路由。 */
export function createMemoryApiClient(transport: LocalApiTransport): MemoryApiClient {
  return {
    list: (input) => {
      const query = new URLSearchParams({
        scopeKind: input.scope.kind,
        scopeId: input.scope.id,
        includeTombstones: String(input.includeTombstones),
        limit: String(input.limit ?? 50),
      });
      if (input.before) {
        query.set('beforeUpdatedAt', input.before.updatedAt);
        query.set('beforeId', input.before.id);
      }
      return transport.request<MemoryPage>(`/api/memory?${query.toString()}`);
    },
    create: async (input) => {
      const safeInput = requireExplicitExternalState(input);
      const operationIdentity = `memory_${randomIdentity()}`;
      const body = await buildMemoryCommandRequest('memory.candidate.record', await memoryHeadCommandScopeId(safeInput), operationIdentity, safeInput);
      return transport.request<MemoryMutationResponse>('/api/memory/candidates', jsonRequest('POST', body)).then((result) => result.record);
    },
    supersede: async (previousId, input) => {
      const safeInput = requireExplicitExternalState(input);
      const operationIdentity = `memory_${randomIdentity()}`;
      const body = await buildMemoryCommandRequest('memory.record.supersede', await memoryRecordCommandScopeId(previousId), operationIdentity, safeInput);
      return transport.request<MemoryMutationResponse>(`/api/memory/${encodeURIComponent(previousId)}/supersede`, jsonRequest('POST', body)).then((result) => result.record);
    },
    tombstone: async (id, reason) => {
      const input = { reason };
      const body = await buildMemoryCommandRequest('memory.record.tombstone', await memoryRecordCommandScopeId(id), `memory_tombstone_${randomIdentity()}`, input);
      return transport.request<MemoryMutationResponse>(`/api/memory/${encodeURIComponent(id)}`, jsonRequest('DELETE', body)).then((result) => result.record);
    },
  };
}

async function buildMemoryCommandRequest<TInput extends object>(commandType: MemoryCommandType, scopeId: string, operationIdentity: string, input: TInput) {
  return buildRendererCommandRequest({
    commandType,
    commandIdPrefix: 'command_memory_',
    actorId: 'zeus-desktop-memory-settings',
    scopeKind: 'memory',
    scopeId,
    operationIdentity,
    value: input,
  });
}

async function memoryHeadCommandScopeId(input: Pick<MemoryCandidateInput, 'memoryKey' | 'scope'>): Promise<string> {
  const identity = canonicalCommandInputJson({ memoryKey: input.memoryKey, scope: { id: input.scope.id, kind: input.scope.kind } });
  return `head_${(await sha256(identity)).slice(0, 48)}`;
}

async function memoryRecordCommandScopeId(recordId: string): Promise<string> {
  return `record_${(await sha256(recordId)).slice(0, 48)}`;
}

function requireExplicitExternalState<T extends Pick<MemoryCandidateInput, 'effect' | 'confirmationLevel' | 'source'>>(input: T): T {
  if (input.effect !== 'external_state') return input;
  if (input.confirmationLevel !== 'explicit' || (input.source.kind !== 'user_explicit' && input.source.kind !== 'project_instruction')) {
    throw new Error('可能改变外部状态的长期记忆必须由用户 explicit 确认，且来源只能是用户明确输入或项目规则。');
  }
  return input;
}
