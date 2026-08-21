import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { ColdEvidenceRepository, CommandDeliveryRepository, CommandDeliveryStoreError, createZeusDatabase, LongTermMemoryRepository, LongTermMemoryStoreError } from '../packages/storage/src/index.js';
import {
  MemoryContextApplicationService,
  memoryCommandTypes,
  memoryHeadCommandScopeId,
  memoryRecordCommandScopeId,
  type MemoryMutationCommandPayload,
  type NewMemoryCandidate,
  type SupersedingMemoryCandidate,
} from '../packages/local-server/src/memoryContextApi.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-memory-command-probe-'));
const projectRoot = join(probeRoot, 'project');
const databasePath = join(probeRoot, 'probe.db');
const observed: Record<string, unknown> = {};

try {
  await mkdir(join(projectRoot, 'docs'), { recursive: true });
  await writeFile(join(projectRoot, 'docs', 'ZEUS-MEM-001_任务主文档.md'), '# ZEUS-MEM-001\n\n只读 Context preview 行为探针。\n', { encoding: 'utf8', mode: 0o600 });
  const db = await createZeusDatabase(databasePath);
  try {
    const memory = new LongTermMemoryRepository(db);
    const commandDeliveries = new CommandDeliveryRepository(db);
    let clock = Date.parse('2026-08-21T01:00:00.000Z');
    const service = new MemoryContextApplicationService({
      memory,
      coldEvidence: new ColdEvidenceRepository(db),
      commandDeliveries,
      getProject: (projectId) => (projectId === 'project-memory-probe' ? { id: projectId, localPath: projectRoot } : undefined),
      now: () => new Date((clock += 1_000)),
    });

    const candidateInput: NewMemoryCandidate = {
      memoryKey: 'ui.language',
      scope: { kind: 'global', id: '*' },
      candidateKind: 'preference',
      content: '界面使用简体中文。',
      effect: 'advisory',
      source: { kind: 'user_explicit', reference: 'memory-command-probe', observedAt: '2026-08-21T00:59:00.000Z' },
      confirmationLevel: 'explicit',
      confidence: 1,
      reviewAfter: '2027-08-21T00:00:00.000Z',
    };
    const candidateOperationIdentity = 'memory_probe_candidate_1';
    const candidateRequest = memoryRequest({
      commandId: 'command_memory_probe_candidate_1',
      commandType: memoryCommandTypes.candidateRecord,
      idempotencyKey: 'memory-probe-candidate-1',
      scopeId: memoryHeadCommandScopeId(candidateInput),
      operationIdentity: candidateOperationIdentity,
      input: candidateInput,
    });
    const candidateAccepted = service.recordMemory(candidateRequest);
    const candidateReplay = service.recordMemory(candidateRequest);
    observed.candidateRecordId = candidateAccepted.record.id;
    observed.candidateReplay = candidateReplay.replayed;
    observed.candidateRows = db.countRows('long_term_memories');
    observed.candidateInboxRows = db.countRows('command_inbox');
    observed.candidateOutboxRows = db.countRows('command_outbox');
    observed.candidateReceiptRows = db.countRows('command_delivery_receipts');
    observed.candidateReceiptOperationIdentity = commandDeliveries.get(candidateRequest.command.commandId)?.attempts[0]?.receipt?.operationIdentity ?? null;

    const conflictingInput = { ...candidateInput, content: '界面使用英文。' };
    const conflictingRequest = memoryRequest({
      commandId: 'command_memory_probe_candidate_conflict',
      commandType: memoryCommandTypes.candidateRecord,
      idempotencyKey: candidateRequest.command.idempotencyKey,
      scopeId: memoryHeadCommandScopeId(conflictingInput),
      operationIdentity: 'memory_probe_candidate_conflict',
      input: conflictingInput,
    });
    observed.idempotencyConflict = captureCode(() => service.recordMemory(conflictingRequest));
    observed.rowsAfterConflict = db.countRows('long_term_memories');

    const rejectedInput = { ...candidateInput, memoryKey: 'task.current.result', candidateKind: 'task_fact' as const, content: '当前任务已完成。' };
    const rejectedRequest = memoryRequest({
      commandId: 'command_memory_probe_rejected',
      commandType: memoryCommandTypes.candidateRecord,
      idempotencyKey: 'memory-probe-rejected',
      scopeId: memoryHeadCommandScopeId(rejectedInput),
      operationIdentity: 'memory_probe_rejected',
      input: rejectedInput,
    });
    observed.rejectedCandidate = captureCode(() => service.recordMemory(rejectedRequest));
    observed.rejectedInboxRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [rejectedRequest.command.commandId])?.count ?? -1;
    observed.rejectedOutboxRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_outbox WHERE command_id = ?`, [rejectedRequest.command.commandId])?.count ?? -1;
    observed.rejectedMemoryRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM long_term_memories WHERE id = ?`, ['memory_probe_rejected'])?.count ?? -1;

    const supersedingInput: SupersedingMemoryCandidate = {
      candidateKind: 'preference',
      content: '界面与文档使用简体中文。',
      effect: 'advisory',
      source: { kind: 'user_explicit', reference: 'memory-command-probe-correction', observedAt: '2026-08-21T01:01:00.000Z' },
      confirmationLevel: 'explicit',
      confidence: 1,
      reviewAfter: '2027-08-21T00:00:00.000Z',
    };
    const supersedeOperationIdentity = 'memory_probe_supersede_1';
    const supersedeRequest = memoryRequest({
      commandId: 'command_memory_probe_supersede_1',
      commandType: memoryCommandTypes.recordSupersede,
      idempotencyKey: 'memory-probe-supersede-1',
      scopeId: memoryRecordCommandScopeId(candidateOperationIdentity),
      operationIdentity: supersedeOperationIdentity,
      input: supersedingInput,
    });
    const superseded = service.supersedeMemory(candidateOperationIdentity, supersedeRequest);
    const supersedeReplay = service.supersedeMemory(candidateOperationIdentity, supersedeRequest);
    observed.supersedeRecordId = superseded.record.id;
    observed.supersedePreviousId = superseded.record.supersedesId;
    observed.supersedeReplay = supersedeReplay.replayed;
    observed.rowsAfterSupersedeReplay = db.countRows('long_term_memories');

    const tombstoneInput = { reason: '用户明确停用该偏好。' };
    const tombstoneOperationIdentity = 'memory_probe_tombstone_1';
    const tombstoneRequest = memoryRequest({
      commandId: 'command_memory_probe_tombstone_1',
      commandType: memoryCommandTypes.recordTombstone,
      idempotencyKey: 'memory-probe-tombstone-1',
      scopeId: memoryRecordCommandScopeId(supersedeOperationIdentity),
      operationIdentity: tombstoneOperationIdentity,
      input: tombstoneInput,
    });
    const tombstoned = service.tombstoneMemory(supersedeOperationIdentity, tombstoneRequest);
    const tombstoneReplay = service.tombstoneMemory(supersedeOperationIdentity, tombstoneRequest);
    observed.tombstoned = tombstoned.record.tombstone;
    observed.tombstoneReason = tombstoned.record.tombstoneReason;
    observed.tombstoneReplay = tombstoneReplay.replayed;
    observed.tombstoneReceiptOperationIdentity = commandDeliveries.get(tombstoneRequest.command.commandId)?.attempts[0]?.receipt?.operationIdentity ?? null;

    const beforePreview = ledgerCounts(db);
    const preview = await service.previewContext({
      projectId: 'project-memory-probe',
      taskId: 'task-memory-probe',
      taskCode: 'ZEUS-MEM-001',
      operationRisk: 'read_only',
      provider: {
        id: 'provider-memory-probe',
        contextWindowTokens: 16_384,
        reservedOutputTokens: 2_048,
        currentInputTokens: 0,
        capabilities: { applicationContext: true, untrustedContext: true, portableContext: true },
      },
      maximumCompiledTokens: 8_192,
    });
    const afterPreview = ledgerCounts(db);
    observed.previewSelectedTaskDocument = preview.taskDocument.selected?.relativePath ?? null;
    observed.previewLedgerUnchanged = JSON.stringify(beforePreview) === JSON.stringify(afterPreview);
    observed.finalLedger = afterPreview;
    observed.quickCheck = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(candidateAccepted.record.id === candidateOperationIdentity && candidateReplay.record.id === candidateOperationIdentity && candidateReplay.replayed, 'candidate replay 必须返回同一 operation result 且不重复 mutation');
    assertProbe(observed.candidateRows === 1 && observed.candidateInboxRows === 1 && observed.candidateOutboxRows === 1 && observed.candidateReceiptRows === 1, 'candidate 业务事实、Inbox、Outbox 与 accepted receipt 必须各有且只有一条');
    assertProbe(observed.candidateReceiptOperationIdentity === candidateOperationIdentity, 'candidate accepted receipt 必须保存独立 operation identity');
    assertProbe(observed.idempotencyConflict === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT' && observed.rowsAfterConflict === 1, '同 scope 幂等键绑定不同请求必须冲突且不写业务事实');
    assertProbe(observed.rejectedCandidate === 'ZEUS_LONG_TERM_MEMORY_CANDIDATE_REJECTED', '被治理规则拒绝的候选必须显式失败');
    assertProbe(observed.rejectedInboxRows === 0 && observed.rejectedOutboxRows === 0 && observed.rejectedMemoryRows === 0, '领域拒绝必须把 Inbox、Outbox 与业务 mutation 整体回滚');
    assertProbe(
      superseded.record.id === supersedeOperationIdentity && superseded.record.supersedesId === candidateOperationIdentity && supersedeReplay.replayed && observed.rowsAfterSupersedeReplay === 2,
      'supersede replay 必须返回同一新记录且只执行一次 mutation',
    );
    assertProbe(tombstoned.record.tombstone && tombstoneReplay.replayed && observed.tombstoneReceiptOperationIdentity === tombstoneOperationIdentity, 'tombstone replay 必须返回同一墓碑结果且保留 operation identity');
    assertProbe(observed.previewSelectedTaskDocument === 'docs/ZEUS-MEM-001_任务主文档.md' && observed.previewLedgerUnchanged === true, '成功的 Context preview 必须只读且不建立 Command 账本');
    assertProbe(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过');
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function memoryRequest<TInput extends Record<string, unknown>>(input: {
  commandId: string;
  commandType: (typeof memoryCommandTypes)[keyof typeof memoryCommandTypes];
  idempotencyKey: string;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}) {
  const inputSha256 = digest(canonicalJson(input.input));
  const command: CommandEnvelope<MemoryMutationCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: input.commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'memory-command-behavior-probe' },
    scope: { kind: 'memory', id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: input.idempotencyKey,
    issuedAt: '2026-08-21T01:00:00.000Z',
    payload: { operationIdentity: input.operationIdentity, inputSha256 },
  };
  return { command, input: input.input };
}

function ledgerCounts(db: { countRows(tableName: string): number }) {
  return {
    inbox: db.countRows('command_inbox'),
    outbox: db.countRows('command_outbox'),
    receipts: db.countRows('command_delivery_receipts'),
    memories: db.countRows('long_term_memories'),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (!value || typeof value !== 'object') throw new Error('Probe input must be JSON data.');
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    if (error instanceof CommandDeliveryStoreError || error instanceof LongTermMemoryStoreError) return error.code;
    if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
    return error instanceof Error ? error.name : String(error);
  }
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Memory Command 行为探针失败：${message}`);
}
