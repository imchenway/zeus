import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope } from '@zeus/shared';
import {
  ColdEvidenceRepository,
  CommandDeliveryRepository,
  CommandDeliveryStoreError,
  LongTermMemoryRepository,
  LongTermMemoryStoreError,
  type ListLongTermMemoriesInput,
  type LongTermMemoryRecord,
  type RecordLongTermMemoryCandidateInput,
} from '@zeus/storage';
import { compileContext, ContextCompilerError, longTermMemoryContextFragment, renderCompiledContext, type CompileContextInput, type ContextBudget } from './contextCompiler.js';
import { ContextSourceCatalog, ContextSourceCatalogError } from './contextSourceCatalog.js';

export interface MemoryContextProject {
  id: string;
  localPath: string;
}

export interface MemoryContextApplicationServiceOptions {
  memory: LongTermMemoryRepository;
  coldEvidence: ColdEvidenceRepository;
  commandDeliveries: CommandDeliveryRepository;
  getProject(projectId: string): MemoryContextProject | undefined;
  now(): Date;
}

export type NewMemoryCandidate = Omit<RecordLongTermMemoryCandidateInput, 'id' | 'recordedAt'>;
export type SupersedingMemoryCandidate = Omit<RecordLongTermMemoryCandidateInput, 'id' | 'recordedAt' | 'scope' | 'memoryKey' | 'supersedesId'>;

export const memoryCommandTypes = {
  candidateRecord: 'memory.candidate.record',
  recordSupersede: 'memory.record.supersede',
  recordTombstone: 'memory.record.tombstone',
} as const;

export type MemoryCommandType = (typeof memoryCommandTypes)[keyof typeof memoryCommandTypes];
export type MemoryMutationCommandPayload = { operationIdentity: string; inputSha256: string };

export interface MemoryMutationRequest<TInput extends Record<string, unknown>> {
  command: CommandEnvelope<MemoryMutationCommandPayload>;
  input: TInput;
}

export interface MemoryMutationResult {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  record: LongTermMemoryRecord;
}

/**
 * 副作用清单据此把 POST preview 判为只读，而不是按 URL 名称放行。
 * 此声明必须与 previewContext 的实现级无写调用证据同时成立。
 */
export const memoryContextPreviewSideEffectDeclaration = Object.freeze({
  applicationMethod: 'previewContext',
  classification: 'read_only',
  writesBusinessState: false,
  commandLedger: 'not_applicable',
  rationale: '只读取项目、任务主文档、Cold Evidence 和长期 Memory，并返回未持久化的编译预览。',
});

export interface ContextPreviewInput {
  projectId: string;
  taskId: string;
  taskCode: string;
  asOf?: string;
  operationRisk: CompileContextInput['operationRisk'];
  provider: CompileContextInput['provider'];
  maximumCompiledTokens?: number;
  budgets?: Partial<ContextBudget>;
  minimumMemoryConfidence?: number;
  maximumTaskDocumentBytes?: number;
}

/** Memory 与任务上下文的 Application Service；HTTP 层不直接操作 Repository 或文件路径。 */
export class MemoryContextApplicationService {
  constructor(private readonly options: MemoryContextApplicationServiceOptions) {}

  listMemory(input: ListLongTermMemoriesInput) {
    return this.options.memory.list(input);
  }

  resolveMemory(input: { projectId?: string | null; asOf?: string; minimumConfidence?: number }) {
    return this.options.memory.resolveForContext({
      projectId: input.projectId,
      asOf: input.asOf ?? this.options.now().toISOString(),
      minimumConfidence: input.minimumConfidence,
    });
  }

  recordMemory(value: unknown): MemoryMutationResult {
    return this.executeMemoryMutation<NewMemoryCandidate>({
      value,
      commandType: memoryCommandTypes.candidateRecord,
      expectedScopeId: (input) => memoryHeadCommandScopeId(input),
      resourceId: (_input, operationIdentity) => operationIdentity,
      resultRecordId: (_input, operationIdentity) => operationIdentity,
      mutate: (input, operationIdentity, occurredAt) => {
        assertNoInputKeys(input, ['id', 'recordedAt'], memoryCommandTypes.candidateRecord);
        const result = this.options.memory.recordCandidate({ ...input, id: operationIdentity, recordedAt: occurredAt });
        if (!result.accepted) {
          throw new LongTermMemoryStoreError('ZEUS_LONG_TERM_MEMORY_CANDIDATE_REJECTED', '任务事实、一次性结果和运行证据不能进入长期记忆。', { candidateKind: result.reason });
        }
        return result.record;
      },
    });
  }

  supersedeMemory(previousId: string, value: unknown): MemoryMutationResult {
    return this.executeMemoryMutation<SupersedingMemoryCandidate>({
      value,
      commandType: memoryCommandTypes.recordSupersede,
      expectedScopeId: () => memoryRecordCommandScopeId(previousId),
      resourceId: (_input, operationIdentity) => operationIdentity,
      resultRecordId: (_input, operationIdentity) => operationIdentity,
      mutate: (input, operationIdentity, occurredAt) => {
        assertNoInputKeys(input, ['id', 'recordedAt', 'scope', 'memoryKey', 'supersedesId'], memoryCommandTypes.recordSupersede);
        return this.options.memory.supersede(previousId, { ...input, id: operationIdentity, recordedAt: occurredAt });
      },
    });
  }

  tombstoneMemory(id: string, value: unknown): MemoryMutationResult {
    return this.executeMemoryMutation<{ reason?: unknown }>({
      value,
      commandType: memoryCommandTypes.recordTombstone,
      expectedScopeId: () => memoryRecordCommandScopeId(id),
      resourceId: () => id,
      resultRecordId: () => id,
      mutate: (input, _operationIdentity, occurredAt) => {
        assertExactInputKeys(input, ['reason'], memoryCommandTypes.recordTombstone);
        if (typeof input.reason !== 'string') throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'reason is required.', 400);
        return this.options.memory.tombstone(id, { at: occurredAt, reason: input.reason });
      },
    });
  }

  async previewContext(input: ContextPreviewInput) {
    const project = this.options.getProject(input.projectId);
    if (!project) throw new MemoryContextApiError('ZEUS_CONTEXT_PROJECT_NOT_FOUND', 'Project not found.', 404);
    const asOf = input.asOf ?? this.options.now().toISOString();
    const memory = this.options.memory.resolveForContext({ projectId: project.id, asOf, minimumConfidence: input.minimumMemoryConfidence });
    const rootId = `project:${project.id}`;
    const catalog = new ContextSourceCatalog([{ id: rootId, path: project.localPath, owner: 'project' }], this.options.coldEvidence, () => false);
    const taskDocument = await catalog.primaryTaskDocumentFragment({
      rootId,
      projectId: project.id,
      taskId: input.taskId,
      taskCode: input.taskCode,
      maximumBytes: input.maximumTaskDocumentBytes,
    });
    const fragments = [taskDocument.fragment, ...memory.selected.map(longTermMemoryContextFragment)].filter((fragment) => fragment !== null);
    const compiled = compileContext({
      asOf,
      operationRisk: input.operationRisk,
      provider: input.provider,
      maximumCompiledTokens: input.maximumCompiledTokens,
      budgets: input.budgets,
      includeColdEvidence: false,
      task: { projectId: project.id, taskId: input.taskId, taskCode: input.taskCode.toUpperCase() },
      watermarks: {
        'docs.primary': taskDocument.fragment?.sourceVersion ?? 'missing',
        'memory.latest': latestMemoryWatermark(memory.selected.map((record) => record.updatedAt)),
      },
      fragments,
    });
    return {
      preview: true as const,
      coverage: ['task_document', 'long_term_memory'] as const,
      compiled,
      rendered: renderCompiledContext(compiled),
      taskDocument: {
        selected: taskDocument.selection.primary,
        candidates: taskDocument.selection.candidates,
        truncatedDirectory: taskDocument.selection.truncatedDirectory,
        nextByteOffset: taskDocument.page?.nextByteOffset ?? null,
      },
      memory: {
        selectedIds: memory.selected.map((record) => record.id),
        reviewRequiredIds: memory.reviewRequired.map((record) => record.id),
        exclusions: memory.excluded.map(({ record, reason }) => ({ id: record.id, reason })),
      },
      notConnected: ['project_code', 'conversation_history', 'runtime_evidence', 'provider_adapter'] as const,
    };
  }

  private executeMemoryMutation<TInput extends Record<string, unknown>>(definition: {
    value: unknown;
    commandType: MemoryCommandType;
    expectedScopeId(input: TInput): string;
    resourceId(input: TInput, operationIdentity: string): string;
    resultRecordId(input: TInput, operationIdentity: string): string;
    mutate(input: TInput, operationIdentity: string, occurredAt: string): LongTermMemoryRecord;
  }): MemoryMutationResult {
    const parsed = parseMemoryMutationRequest<TInput>(definition.value, definition.commandType);
    const expectedScopeId = definition.expectedScopeId(parsed.input);
    if (parsed.command.scope.id !== expectedScopeId) {
      throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory command scope does not match the addressed resource.', 400);
    }
    const occurredAt = this.options.now().toISOString();
    const resourceId = definition.resourceId(parsed.input, parsed.operationIdentity);
    const resultRecordId = definition.resultRecordId(parsed.input, parsed.operationIdentity);
    let mutatedRecord: LongTermMemoryRecord | undefined;
    const delivery = this.options.commandDeliveries.executeCoreApplication({
      envelope: parsed.command,
      requestSha256: parsed.inputSha256,
      destinationId: 'memory-context-application',
      resourceId,
      operationIdentity: parsed.operationIdentity,
      occurredAt,
      evidence: {
        source: 'memory_context_application',
        commandType: definition.commandType,
        inputSha256: parsed.inputSha256,
        resourceScopeId: expectedScopeId,
      },
      mutateBusinessState: () => {
        mutatedRecord = definition.mutate(parsed.input, parsed.operationIdentity, occurredAt);
        if (mutatedRecord.id !== resultRecordId) throw new Error('Memory mutation returned a record that does not match its stable result identity.');
      },
    });
    const record = delivery.created ? mutatedRecord : this.options.memory.getById(resultRecordId);
    if (!record || delivery.receipt.operationIdentity !== parsed.operationIdentity) {
      throw new Error('Accepted Memory command is missing its immutable operation result.');
    }
    return {
      commandId: delivery.inbox.commandId,
      operationIdentity: parsed.operationIdentity,
      replayed: !delivery.created,
      record,
    };
  }
}

export class MemoryContextApiError extends Error {
  readonly name = 'MemoryContextApiError';

  constructor(
    readonly code: 'ZEUS_CONTEXT_PROJECT_NOT_FOUND' | 'ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT',
    message: string,
    readonly statusCode: 400 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

/** 注册 Memory 管理和 Context 预览端口；所有业务选择由 Application Service 完成。 */
export function registerMemoryContextApi(server: FastifyInstance, service: MemoryContextApplicationService): void {
  server.get(
    '/api/memory',
    async (
      request: FastifyRequest<{
        Querystring: { scopeKind?: string; scopeId?: string; includeTombstones?: string; beforeUpdatedAt?: string; beforeId?: string; limit?: string };
      }>,
      reply,
    ) => {
      try {
        const query = request.query;
        const scope = query.scopeKind === undefined ? undefined : parseScope(query.scopeKind, query.scopeId);
        const before = query.beforeUpdatedAt === undefined && query.beforeId === undefined ? undefined : parseCursor(query.beforeUpdatedAt, query.beforeId);
        return service.listMemory({ scope, before, includeTombstones: parseBoolean(query.includeTombstones, false), limit: parseOptionalNumber(query.limit) });
      } catch (error) {
        return sendMemoryContextError(reply, error);
      }
    },
  );

  server.get('/api/memory/resolved', async (request: FastifyRequest<{ Querystring: { projectId?: string; asOf?: string; minimumConfidence?: string } }>, reply) => {
    try {
      return service.resolveMemory({ projectId: request.query.projectId, asOf: request.query.asOf, minimumConfidence: parseOptionalNumber(request.query.minimumConfidence) });
    } catch (error) {
      return sendMemoryContextError(reply, error);
    }
  });

  server.post('/api/memory/candidates', async (request: FastifyRequest<{ Body: MemoryMutationRequest<NewMemoryCandidate> }>, reply) => {
    try {
      const result = service.recordMemory(request.body);
      return reply.code(201).send(result);
    } catch (error) {
      return sendMemoryContextError(reply, error);
    }
  });

  server.post('/api/memory/:id/supersede', async (request: FastifyRequest<{ Params: { id: string }; Body: MemoryMutationRequest<SupersedingMemoryCandidate> }>, reply) => {
    try {
      return service.supersedeMemory(request.params.id, request.body);
    } catch (error) {
      return sendMemoryContextError(reply, error);
    }
  });

  server.delete('/api/memory/:id', async (request: FastifyRequest<{ Params: { id: string }; Body: MemoryMutationRequest<{ reason?: unknown }> }>, reply) => {
    try {
      return service.tombstoneMemory(request.params.id, request.body);
    } catch (error) {
      return sendMemoryContextError(reply, error);
    }
  });

  server.post('/api/projects/:projectId/tasks/:taskId/context/preview', async (request: FastifyRequest<{ Params: { projectId: string; taskId: string }; Body: Omit<ContextPreviewInput, 'projectId' | 'taskId'> }>, reply) => {
    try {
      const body = requireObjectBody(request.body);
      if (typeof body.taskCode !== 'string' || !isRecord(body.provider)) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'taskCode and provider are required.', 400);
      return await service.previewContext({ ...(body as unknown as Omit<ContextPreviewInput, 'projectId' | 'taskId'>), projectId: request.params.projectId, taskId: request.params.taskId });
    } catch (error) {
      return sendMemoryContextError(reply, error);
    }
  });
}

interface ParsedMemoryMutationRequest<TInput extends Record<string, unknown>> {
  command: CommandEnvelope<MemoryMutationCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

function parseMemoryMutationRequest<TInput extends Record<string, unknown>>(value: unknown, expectedCommandType: MemoryCommandType): ParsedMemoryMutationRequest<TInput> {
  const body = requireObjectBody(value);
  assertExactInputKeys(body, ['command', 'input'], expectedCommandType);
  const command = parseCommandEnvelope<MemoryMutationCommandPayload>(body.command);
  if (command.commandType !== expectedCommandType) {
    throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', `Expected command type ${expectedCommandType}.`, 400);
  }
  if (command.scope.kind !== 'memory') throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory mutations require command scope kind memory.', 400);
  if (command.expectedRevision !== null) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory records do not expose a numeric revision; expectedRevision must be null.', 400);
  assertExactInputKeys(command.payload, ['inputSha256', 'operationIdentity'], expectedCommandType);
  const operationIdentity = boundedCommandIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
  const declaredInputSha256 = validCommandSha256(command.payload.inputSha256, 'command.payload.inputSha256');
  const input = requireObjectBody(body.input) as TInput;
  const inputSha256 = sha256(canonicalJson(input));
  if (inputSha256 !== declaredInputSha256) {
    throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory command inputSha256 does not match Body.input.', 400);
  }
  return { command, input, inputSha256, operationIdentity };
}

/** Candidate scope 对同一个 Memory head 稳定，不随正文或候选记录 ID 改变。 */
export function memoryHeadCommandScopeId(input: Pick<NewMemoryCandidate, 'memoryKey' | 'scope'>): string {
  if (typeof input.memoryKey !== 'string' || !isRecord(input.scope) || typeof input.scope.kind !== 'string' || typeof input.scope.id !== 'string') {
    throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory candidate requires memoryKey and scope.', 400);
  }
  return `head_${sha256(canonicalJson({ memoryKey: input.memoryKey, scope: { id: input.scope.id, kind: input.scope.kind } })).slice(0, 48)}`;
}

/** Record command scope 使用不可逆稳定摘要，避免把用户定义的资源 ID 复制进命令索引。 */
export function memoryRecordCommandScopeId(recordId: string): string {
  return `record_${sha256(boundedCommandIdentity(recordId, 'memoryRecordId')).slice(0, 48)}`;
}

function assertNoInputKeys(value: Record<string, unknown>, prohibited: readonly string[], commandType: MemoryCommandType): void {
  const found = prohibited.filter((key) => Object.hasOwn(value, key));
  if (found.length > 0) {
    throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', `${commandType} input contains server-owned fields: ${found.join(', ')}.`, 400);
  }
}

function assertExactInputKeys(value: Record<string, unknown>, expected: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length !== normalizedExpected.length || actual.some((key, index) => key !== normalizedExpected[index])) {
    throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', `${context} must contain exactly: ${normalizedExpected.join(', ')}.`, 400);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory command input must contain finite JSON numbers.', 400);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!isRecord(value)) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Memory command input must be JSON data.', 400);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function validCommandSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', `${field} must be a lowercase SHA-256.`, 400);
  return value;
}

function boundedCommandIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 256 || value.includes('\0')) {
    throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', `${field} must be a non-empty stable identity of at most 256 characters.`, 400);
  }
  return value;
}

function latestMemoryWatermark(values: string[]): string {
  return [...values].sort().at(-1) ?? 'none';
}

function parseScope(kind: string, id: string | undefined): { kind: 'global' | 'project'; id: string } {
  if (kind === 'global') return { kind, id: id ?? '*' };
  if (kind === 'project' && id !== undefined) return { kind, id };
  throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'scopeKind/scopeId is invalid.', 400);
}

function parseCursor(updatedAt: string | undefined, id: string | undefined): { updatedAt: string; id: string } {
  if (updatedAt === undefined || id === undefined) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'beforeUpdatedAt and beforeId must be provided together.', 400);
  return { updatedAt, id };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Boolean query value must be true or false.', 400);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Numeric query value is invalid.', 400);
  return parsed;
}

function requireObjectBody(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new MemoryContextApiError('ZEUS_MEMORY_CONTEXT_INVALID_ARGUMENT', 'Request body must be an object.', 400);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sendMemoryContextError(reply: FastifyReply, error: unknown) {
  if (error instanceof MemoryContextApiError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  if (error instanceof LongTermMemoryStoreError) {
    const statusCode = error.code === 'ZEUS_LONG_TERM_MEMORY_NOT_FOUND' ? 404 : error.code === 'ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT' ? 409 : error.code === 'ZEUS_LONG_TERM_MEMORY_CANDIDATE_REJECTED' ? 422 : 400;
    return reply.code(statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  if (error instanceof CommandEnvelopeError) {
    const statusCode = error.code === 'ZEUS_COMMAND_EXPECTED_REVISION_CONFLICT' || error.code === 'ZEUS_DOMAIN_STATE_TRANSITION_REJECTED' ? 409 : 400;
    return reply.code(statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  if (error instanceof CommandDeliveryStoreError) {
    const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : 409;
    return reply.code(statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  if (error instanceof ContextCompilerError) return reply.code(error.code === 'ZEUS_CONTEXT_COMPILER_INVALID_ARGUMENT' ? 400 : 409).send({ error: error.code, message: error.message, details: error.details });
  if (error instanceof ContextSourceCatalogError) {
    const statusCode =
      error.code === 'ZEUS_CONTEXT_SOURCE_NOT_FOUND' || error.code === 'ZEUS_CONTEXT_SOURCE_ROOT_NOT_FOUND' ? 404 : error.code === 'ZEUS_CONTEXT_SOURCE_UNAUTHORIZED' ? 403 : error.code === 'ZEUS_CONTEXT_SOURCE_CHANGED' ? 409 : 400;
    return reply.code(statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  return reply.code(500).send({ error: 'ZEUS_MEMORY_CONTEXT_FAILED', message: error instanceof Error ? error.message : 'Memory/context operation failed.' });
}
