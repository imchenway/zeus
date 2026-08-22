import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '@zeus/shared';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import type { MemoryCandidateInput, MemoryListQuery, MemoryPage, MemoryRecord, SupersedingMemoryCandidateInput } from './memoryContracts.js';

type MemoryCommandType = 'memory.candidate.record' | 'memory.record.supersede' | 'memory.record.tombstone';
type MemoryCommandPayload = { operationIdentity: string; inputSha256: string };
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
  const inputSha256 = await sha256(canonicalJson(input));
  const commandId = `command_memory_${randomIdentity()}`;
  const command: CommandEnvelope<MemoryCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType,
    actor: { kind: 'local_api', id: 'zeus-desktop-memory-settings' },
    scope: { kind: 'memory', id: scopeId },
    expectedRevision: null,
    idempotencyKey: `${commandType}:${operationIdentity}`,
    issuedAt: new Date().toISOString(),
    payload: { operationIdentity, inputSha256 },
  };
  return { command, input };
}

async function memoryHeadCommandScopeId(input: Pick<MemoryCandidateInput, 'memoryKey' | 'scope'>): Promise<string> {
  const identity = canonicalJson({ memoryKey: input.memoryKey, scope: { id: input.scope.id, kind: input.scope.kind } });
  return `head_${(await sha256(identity)).slice(0, 48)}`;
}

async function memoryRecordCommandScopeId(recordId: string): Promise<string> {
  return `record_${(await sha256(recordId)).slice(0, 48)}`;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Memory command input must contain finite JSON numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Memory command input must be JSON data.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
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

function requireExplicitExternalState<T extends Pick<MemoryCandidateInput, 'effect' | 'confirmationLevel' | 'source'>>(input: T): T {
  if (input.effect !== 'external_state') return input;
  if (input.confirmationLevel !== 'explicit' || (input.source.kind !== 'user_explicit' && input.source.kind !== 'project_instruction')) {
    throw new Error('可能改变外部状态的长期记忆必须由用户 explicit 确认，且来源只能是用户明确输入或项目规则。');
  }
  return input;
}
