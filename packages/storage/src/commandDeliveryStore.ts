import { createHash } from 'node:crypto';
import { assertDomainStateTransition, defineDomainStateMachine, parseCommandEnvelope, type CommandEnvelope } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

export const commandDeliverySchemaMigrationId = '20260821_031_transactional_command_delivery_v4';

/** Provider 派发只有这四类可持久结论；prepared/write_started 只是传输阶段，不是结果。 */
export const commandDeliveryOutcomes = ['failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted'] as const;
export type CommandDeliveryOutcome = (typeof commandDeliveryOutcomes)[number];
export type CommandDeliveryAttemptState = 'prepared' | 'provider_write_started' | 'failed_before_write' | 'explicitly_rejected' | 'outcome_unknown_after_write' | 'accepted';
export type CommandInboxDeliveryState = 'pending' | 'retryable' | 'terminal';
export type CommandOutboxState = 'prepared' | 'provider_write_started' | 'resolved';
export type CommandDeliveryDestinationKind = 'provider_turn' | 'provider_session' | 'provider_runtime' | 'core_application' | 'external_operation';

export const commandDeliveryAttemptStateMachine = defineDomainStateMachine({
  name: 'command_delivery_attempt',
  states: ['prepared', 'provider_write_started', ...commandDeliveryOutcomes] as const,
  transitions: {
    prepared: ['provider_write_started', 'failed_before_write', 'explicitly_rejected', 'accepted'],
    provider_write_started: ['explicitly_rejected', 'outcome_unknown_after_write', 'accepted'],
    failed_before_write: [],
    explicitly_rejected: [],
    // unknown 禁止重放，但可在取得 Provider 原生证据后追加 accepted 回执收敛。
    outcome_unknown_after_write: ['accepted'],
    accepted: [],
  },
  terminalStates: ['failed_before_write', 'explicitly_rejected', 'accepted'],
});

export type CommandDeliveryStoreErrorCode =
  | 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT'
  | 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT'
  | 'ZEUS_COMMAND_DELIVERY_NOT_FOUND'
  | 'ZEUS_COMMAND_DELIVERY_STATE_CONFLICT'
  | 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED'
  | 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT'
  | 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT';

export class CommandDeliveryStoreError extends Error {
  readonly name = 'CommandDeliveryStoreError';

  constructor(
    readonly code: CommandDeliveryStoreErrorCode,
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

export interface CommandInboxRecord {
  commandId: string;
  schemaGeneration: string;
  commandType: string;
  actorKind: string;
  actorId: string | null;
  scopeKind: string;
  scopeId: string;
  expectedRevision: number | null;
  idempotencyKey: string;
  envelopeSha256: string;
  requestSha256: string;
  envelopeJson: string;
  deliveryState: CommandInboxDeliveryState;
  lastOutcome: CommandDeliveryOutcome | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommandOutboxRecord {
  id: string;
  commandId: string;
  attempt: number;
  destinationKind: CommandDeliveryDestinationKind;
  destinationId: string;
  resourceId: string;
  externalOperationId: string | null;
  state: CommandOutboxState;
  outcome: CommandDeliveryOutcome | null;
  autoRetryPermitted: boolean;
  preparedAt: string;
  providerWriteStartedAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface CommandDeliveryReceiptRecord {
  id: string;
  commandId: string;
  outboxId: string;
  sequence: number;
  outcome: CommandDeliveryOutcome;
  providerId: string | null;
  providerGenerationId: string | null;
  nativeSessionId: string | null;
  nativeTurnId: string | null;
  operationIdentity: string | null;
  evidenceSha256: string;
  evidenceJson: string;
  occurredAt: string;
}

export interface AcceptAndPrepareCommandDeliveryInput {
  envelope: CommandEnvelope;
  /** 与领域请求正文或不可变 submission 相同的稳定摘要。 */
  requestSha256: string;
  destinationKind: CommandDeliveryDestinationKind;
  destinationId: string;
  resourceId: string;
  externalOperationId?: string | null;
  occurredAt: string;
  /** 同步回调与 Inbox/Outbox 在同一个 BEGIN IMMEDIATE 中提交。 */
  mutateBusinessState?: () => void;
}

export interface RecordCommandDeliveryOutcomeInput {
  outboxId: string;
  outcome: CommandDeliveryOutcome;
  evidence: unknown;
  providerId?: string | null;
  providerGenerationId?: string | null;
  nativeSessionId?: string | null;
  nativeTurnId?: string | null;
  operationIdentity?: string | null;
  occurredAt: string;
}

export interface ExecuteCoreApplicationCommandInput {
  envelope: CommandEnvelope;
  requestSha256: string;
  destinationId: string;
  resourceId: string;
  operationIdentity: string;
  occurredAt: string;
  evidence?: unknown;
  mutateBusinessState: () => void;
}

export interface ExecuteCoreApplicationCommandResult {
  inbox: CommandInboxRecord;
  outbox: CommandOutboxRecord;
  receipt: CommandDeliveryReceiptRecord;
  created: boolean;
}

export interface CommandDeliverySnapshot {
  inbox: CommandInboxRecord;
  attempts: Array<CommandOutboxRecord & { receipt: CommandDeliveryReceiptRecord | null }>;
  autoRetryPermitted: boolean;
}

interface CommandInboxRow {
  command_id: string;
  schema_generation: string;
  command_type: string;
  actor_kind: string;
  actor_id: string | null;
  scope_kind: string;
  scope_id: string;
  expected_revision: number | null;
  idempotency_key: string;
  envelope_sha256: string;
  request_sha256: string;
  envelope_json: string;
  delivery_state: CommandInboxDeliveryState;
  last_outcome: CommandDeliveryOutcome | null;
  created_at: string;
  updated_at: string;
}

interface CommandOutboxRow {
  id: string;
  command_id: string;
  attempt: number;
  destination_kind: CommandDeliveryDestinationKind;
  destination_id: string;
  resource_id: string;
  external_operation_id: string | null;
  state: CommandOutboxState;
  outcome: CommandDeliveryOutcome | null;
  auto_retry_permitted: number;
  prepared_at: string;
  provider_write_started_at: string | null;
  resolved_at: string | null;
  updated_at: string;
}

interface CommandDeliveryReceiptRow {
  id: string;
  command_id: string;
  outbox_id: string;
  sequence: number;
  outcome: CommandDeliveryOutcome;
  provider_id: string | null;
  provider_generation_id: string | null;
  native_session_id: string | null;
  native_turn_id: string | null;
  operation_identity: string | null;
  evidence_sha256: string;
  evidence_json: string;
  occurred_at: string;
}

/** 建立统一命令接纳、Provider 待派发尝试和不可变回执；不回填或猜测历史派发。 */
export function migrateCommandDeliverySchema(db: ZeusDatabasePort): void {
  const checksumSource =
    'command_inbox:v1;command_outbox:v4-external-operation-owned-by-one-command-with-safe-attempt-retry;command_delivery_receipts:v3-operation-identity-unique;destinations:provider-turn,provider-session,provider-runtime,core-application,external-operation;outcomes:failed-before-write,explicitly-rejected,outcome-unknown-after-write,accepted';
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;

  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [commandDeliverySchemaMigrationId]);
    if (existing && existing.checksum !== checksum) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT', '命令派发迁移账本与当前结构定义不一致，已拒绝继续打开数据库。', {
        migrationId: commandDeliverySchemaMigrationId,
      });
    }

    db.execute(`
      CREATE TABLE IF NOT EXISTS command_inbox (
        command_id TEXT PRIMARY KEY CHECK (length(command_id) > 0),
        schema_generation TEXT NOT NULL CHECK (length(schema_generation) > 0),
        command_type TEXT NOT NULL CHECK (length(command_type) > 0),
        actor_kind TEXT NOT NULL CHECK (length(actor_kind) > 0),
        actor_id TEXT,
        scope_kind TEXT NOT NULL CHECK (length(scope_kind) > 0),
        scope_id TEXT NOT NULL CHECK (length(scope_id) > 0),
        expected_revision INTEGER CHECK (expected_revision IS NULL OR expected_revision >= 0),
        idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) > 0),
        envelope_sha256 TEXT NOT NULL CHECK (length(envelope_sha256) = 64 AND envelope_sha256 NOT GLOB '*[^0-9a-f]*'),
        request_sha256 TEXT NOT NULL CHECK (length(request_sha256) = 64 AND request_sha256 NOT GLOB '*[^0-9a-f]*'),
        envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json)),
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'retryable', 'terminal')),
        last_outcome TEXT CHECK (last_outcome IS NULL OR last_outcome IN ('failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (scope_kind, scope_id, idempotency_key)
      )
    `);
    assertRequiredColumns(db, 'command_inbox', [
      'command_id',
      'schema_generation',
      'command_type',
      'actor_kind',
      'actor_id',
      'scope_kind',
      'scope_id',
      'expected_revision',
      'idempotency_key',
      'envelope_sha256',
      'request_sha256',
      'envelope_json',
      'delivery_state',
      'last_outcome',
      'created_at',
      'updated_at',
    ]);

    db.execute(`
      CREATE TABLE IF NOT EXISTS command_outbox (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        command_id TEXT NOT NULL REFERENCES command_inbox(command_id),
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        destination_kind TEXT NOT NULL CHECK (length(destination_kind) > 0),
        destination_id TEXT NOT NULL CHECK (length(destination_id) > 0),
        resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
        external_operation_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('prepared', 'provider_write_started', 'resolved')),
        outcome TEXT CHECK (outcome IS NULL OR outcome IN ('failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted')),
        auto_retry_permitted INTEGER NOT NULL CHECK (auto_retry_permitted IN (0, 1)),
        prepared_at TEXT NOT NULL,
        provider_write_started_at TEXT,
        resolved_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (command_id, attempt),
        CHECK ((state = 'resolved' AND outcome IS NOT NULL AND resolved_at IS NOT NULL) OR (state <> 'resolved' AND outcome IS NULL AND resolved_at IS NULL)),
        CHECK ((state = 'prepared' AND provider_write_started_at IS NULL) OR state <> 'prepared')
      )
    `);
    try {
      db.execute(`ALTER TABLE command_outbox ADD COLUMN external_operation_id TEXT`);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；新库和已升级库会命中重复列。
    }
    assertRequiredColumns(db, 'command_outbox', [
      'id',
      'command_id',
      'attempt',
      'destination_kind',
      'destination_id',
      'resource_id',
      'external_operation_id',
      'state',
      'outcome',
      'auto_retry_permitted',
      'prepared_at',
      'provider_write_started_at',
      'resolved_at',
      'updated_at',
    ]);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_command_outbox_dispatch ON command_outbox(state, prepared_at, command_id)`);
    // v3 的唯一索引错误地阻断同一 Command 在确证写出前失败后的安全 attempt 2；v4 改为只阻断跨 Command 冒用。
    db.execute(`DROP INDEX IF EXISTS ux_command_outbox_external_operation`);
    db.execute(`
      CREATE TRIGGER IF NOT EXISTS command_outbox_block_cross_command_external_identity
      BEFORE INSERT ON command_outbox
      WHEN NEW.destination_kind = 'external_operation'
       AND NEW.external_operation_id IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM command_outbox AS existing
          WHERE existing.destination_kind = 'external_operation'
            AND existing.destination_id = NEW.destination_id
            AND existing.external_operation_id = NEW.external_operation_id
            AND existing.command_id <> NEW.command_id
       )
      BEGIN
        SELECT RAISE(ABORT, 'external operation identity belongs to another command');
      END
    `);

    db.execute(`
      CREATE TABLE IF NOT EXISTS command_delivery_receipts (
        id TEXT PRIMARY KEY CHECK (length(id) > 0),
        command_id TEXT NOT NULL REFERENCES command_inbox(command_id),
        outbox_id TEXT NOT NULL REFERENCES command_outbox(id),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        outcome TEXT NOT NULL CHECK (outcome IN ('failed_before_write', 'explicitly_rejected', 'outcome_unknown_after_write', 'accepted')),
        provider_id TEXT,
        provider_generation_id TEXT,
        native_session_id TEXT,
        native_turn_id TEXT,
        operation_identity TEXT,
        evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'),
        evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
        occurred_at TEXT NOT NULL,
        UNIQUE (outbox_id, sequence)
      )
    `);
    try {
      db.execute(`ALTER TABLE command_delivery_receipts ADD COLUMN operation_identity TEXT`);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；新库和已升级库会命中重复列。
    }
    assertRequiredColumns(db, 'command_delivery_receipts', [
      'id',
      'command_id',
      'outbox_id',
      'sequence',
      'outcome',
      'provider_id',
      'provider_generation_id',
      'native_session_id',
      'native_turn_id',
      'operation_identity',
      'evidence_sha256',
      'evidence_json',
      'occurred_at',
    ]);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_command_delivery_receipts_command ON command_delivery_receipts(command_id, occurred_at, outbox_id)`);
    db.execute(
      `CREATE UNIQUE INDEX IF NOT EXISTS ux_command_delivery_receipts_operation_identity
         ON command_delivery_receipts(operation_identity)
       WHERE outcome = 'accepted' AND operation_identity IS NOT NULL`,
    );

    db.execute(`
      CREATE TRIGGER IF NOT EXISTS command_delivery_receipts_immutable_update
      BEFORE UPDATE ON command_delivery_receipts
      BEGIN
        SELECT RAISE(ABORT, 'command delivery receipts are immutable');
      END
    `);
    db.execute(`
      CREATE TRIGGER IF NOT EXISTS command_delivery_receipts_immutable_delete
      BEFORE DELETE ON command_delivery_receipts
      BEGIN
        SELECT RAISE(ABORT, 'command delivery receipts are immutable');
      END
    `);
    db.execute(`
      CREATE TRIGGER IF NOT EXISTS command_outbox_block_uncertain_replay
      BEFORE INSERT ON command_outbox
      WHEN EXISTS (
        SELECT 1
          FROM command_delivery_receipts AS receipt
         WHERE receipt.command_id = NEW.command_id
           AND receipt.outcome IN ('outcome_unknown_after_write', 'accepted')
      )
      BEGIN
        SELECT RAISE(ABORT, 'command delivery terminal outcome blocks replay');
      END
    `);

    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      commandDeliverySchemaMigrationId,
      '扩展四类 Command destination、Core 原子回执与外部副作用稳定 operation 身份',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

/**
 * 命令接纳与 Provider 派发账本。
 *
 * at-least-once 只允许发生在已有确证的写出前失败或明确拒绝之后；一旦结果未知，
 * Repository 与 SQLite trigger 都会阻断新 attempt，必须先由恢复流程取得原生证据。
 */
export class CommandDeliveryRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  executeCoreApplication(input: ExecuteCoreApplicationCommandInput): ExecuteCoreApplicationCommandResult {
    const envelope = parseCommandEnvelope(input.envelope);
    const requestSha256 = validSha256(input.requestSha256, 'requestSha256');
    const destinationId = boundedIdentity(input.destinationId, 'destinationId');
    const resourceId = boundedIdentity(input.resourceId, 'resourceId');
    const operationIdentity = boundedIdentity(input.operationIdentity, 'operationIdentity');
    const occurredAt = validTimestamp(input.occurredAt, 'occurredAt');
    const envelopeJson = canonicalJson(envelope);
    const envelopeSha256 = sha256(envelopeJson);
    return this.db.durableTransactionSync(() => {
      this.receiveInCurrentTransaction(envelope, envelopeJson, envelopeSha256, requestSha256, occurredAt);
      const latest = this.latestOutbox(envelope.commandId);
      if (latest) {
        assertSameDeliveryIdentity(latest, 'core_application', destinationId, resourceId, null);
        const receipt = this.receiptByOutbox(latest.id);
        if (latest.outcome === 'accepted' && receipt?.operationIdentity === operationIdentity) {
          return { inbox: this.requireInbox(envelope.commandId), outbox: latest, receipt, created: false };
        }
        throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_STATE_CONFLICT', 'Core Application 命令已有非同一 accepted operation 回执，拒绝重复执行业务 mutation。', {
          commandId: envelope.commandId,
          outboxId: latest.id,
        });
      }
      const operationOwner = this.receiptByOperationIdentity(operationIdentity);
      if (operationOwner) {
        throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT', 'Core operationIdentity 已绑定另一 Command，拒绝重复执行业务 mutation。', {
          commandId: envelope.commandId,
          existingCommandId: operationOwner.commandId,
          operationIdentity,
        });
      }
      const outboxId = stableOutboxId(envelope.commandId, 1);
      this.db.execute(
        `INSERT INTO command_outbox
         (id, command_id, attempt, destination_kind, destination_id, resource_id, external_operation_id, state, outcome,
          auto_retry_permitted, prepared_at, provider_write_started_at, resolved_at, updated_at)
         VALUES (?, ?, 1, 'core_application', ?, ?, NULL, 'prepared', NULL, 0, ?, NULL, NULL, ?)`,
        [outboxId, envelope.commandId, destinationId, resourceId, occurredAt, occurredAt],
      );
      input.mutateBusinessState();
      const receipt = this.recordOutcomeInCurrentTransaction({
        outboxId,
        outcome: 'accepted',
        evidence: input.evidence ?? { source: 'core_application_transaction', operationIdentity },
        operationIdentity,
        occurredAt,
      });
      return { inbox: this.requireInbox(envelope.commandId), outbox: this.requireOutbox(outboxId), receipt, created: true };
    });
  }

  acceptAndPrepare(input: AcceptAndPrepareCommandDeliveryInput): { inbox: CommandInboxRecord; outbox: CommandOutboxRecord; created: boolean } {
    return this.db.durableTransactionSync(() => this.acceptAndPrepareInCurrentTransaction(input));
  }

  /**
   * 由领域 Core mutation 在自己持有的 durableTransactionSync 中原子追加子外部操作。
   * 调用方必须已经位于同一数据库事务；此入口不会自行提交，避免父事实与派发意图出现双写窗口。
   */
  acceptAndPrepareInCurrentTransaction(input: AcceptAndPrepareCommandDeliveryInput): { inbox: CommandInboxRecord; outbox: CommandOutboxRecord; created: boolean } {
    const envelope = parseCommandEnvelope(input.envelope);
    const requestSha256 = validSha256(input.requestSha256, 'requestSha256');
    const destinationKind = validDestinationKind(input.destinationKind);
    const destinationId = boundedIdentity(input.destinationId, 'destinationId');
    const resourceId = boundedIdentity(input.resourceId, 'resourceId');
    const externalOperationId = boundedOptionalIdentity(input.externalOperationId, 'externalOperationId');
    if (destinationKind === 'external_operation' ? !externalOperationId : externalOperationId !== null) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '只有 external_operation 必须且只能携带稳定 externalOperationId。', { destinationKind });
    }
    if (destinationKind === 'core_application') {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'core_application 必须通过 executeCoreApplication 原子接纳，不能停留在 prepared。', { destinationKind });
    }
    const occurredAt = validTimestamp(input.occurredAt, 'occurredAt');
    const envelopeJson = canonicalJson(envelope);
    const envelopeSha256 = sha256(envelopeJson);

    this.receiveInCurrentTransaction(envelope, envelopeJson, envelopeSha256, requestSha256, occurredAt);
    if (destinationKind === 'external_operation' && externalOperationId) {
      const operationOwner = this.outboxByExternalOperation(destinationId, externalOperationId);
      if (operationOwner && operationOwner.commandId !== envelope.commandId) {
        throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT', 'External operation identity 已绑定另一 Command，禁止二次写出。', {
          commandId: envelope.commandId,
          existingCommandId: operationOwner.commandId,
          destinationId,
          externalOperationId,
        });
      }
    }
    const latest = this.latestOutbox(envelope.commandId);
    if (latest?.state === 'provider_write_started') {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'Provider 写出已经开始但尚无回执，禁止自动重放该命令。', {
        commandId: envelope.commandId,
        outboxId: latest.id,
        outcome: 'outcome_unknown_after_write',
      });
    }
    if (latest?.state === 'prepared') {
      assertSameDeliveryIdentity(latest, destinationKind, destinationId, resourceId, externalOperationId);
      input.mutateBusinessState?.();
      return { inbox: this.requireInbox(envelope.commandId), outbox: latest, created: false };
    }
    if (latest?.outcome === 'outcome_unknown_after_write' || latest?.outcome === 'accepted') {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'Provider 写出后结果未知或已接纳，禁止自动创建新的派发尝试。', {
        commandId: envelope.commandId,
        outboxId: latest.id,
        outcome: latest.outcome,
      });
    }
    if (latest && latest.outcome !== 'failed_before_write' && latest.outcome !== 'explicitly_rejected') {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_STATE_CONFLICT', '命令最新派发尝试没有可证明安全的重试结论。', {
        commandId: envelope.commandId,
        outboxId: latest.id,
        outcome: latest.outcome,
      });
    }
    const attempt = (latest?.attempt ?? 0) + 1;
    const outboxId = stableOutboxId(envelope.commandId, attempt);
    this.db.execute(
      `INSERT INTO command_outbox
         (id, command_id, attempt, destination_kind, destination_id, resource_id, external_operation_id, state, outcome,
          auto_retry_permitted, prepared_at, provider_write_started_at, resolved_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', NULL, 1, ?, NULL, NULL, ?)`,
      [outboxId, envelope.commandId, attempt, destinationKind, destinationId, resourceId, externalOperationId, occurredAt, occurredAt],
    );
    this.db.execute(`UPDATE command_inbox SET delivery_state = 'pending', last_outcome = NULL, updated_at = ? WHERE command_id = ?`, [occurredAt, envelope.commandId]);
    input.mutateBusinessState?.();
    return { inbox: this.requireInbox(envelope.commandId), outbox: this.requireOutbox(outboxId), created: true };
  }

  markProviderWriteStarted(input: { outboxId: string; occurredAt: string }): CommandOutboxRecord {
    return this.db.durableTransactionSync(() => this.markProviderWriteStartedInCurrentTransaction(input));
  }

  markExternalWriteStarted(input: { outboxId: string; occurredAt: string }): CommandOutboxRecord {
    return this.markProviderWriteStarted(input);
  }

  markProviderWriteStartedInCurrentTransaction(input: { outboxId: string; occurredAt: string }): CommandOutboxRecord {
    const occurredAt = validTimestamp(input.occurredAt, 'occurredAt');
    const outbox = this.requireOutbox(boundedIdentity(input.outboxId, 'outboxId'));
    if (outbox.destinationKind === 'core_application') {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_STATE_CONFLICT', 'core_application 没有外部写出阶段，必须在同一事务直接形成 accepted 回执。', { outboxId: outbox.id });
    }
    if (outbox.state === 'provider_write_started') return outbox;
    if (outbox.state === 'resolved') {
      throw commandDeliveryError(
        outbox.outcome === 'outcome_unknown_after_write' || outbox.outcome === 'accepted' ? 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' : 'ZEUS_COMMAND_DELIVERY_STATE_CONFLICT',
        '已收口的派发尝试不能重新标记为 Provider 写出。',
        { outboxId: outbox.id, outcome: outbox.outcome },
      );
    }
    assertDomainStateTransition(commandDeliveryAttemptStateMachine, 'prepared', 'provider_write_started');
    this.db.execute(
      `UPDATE command_outbox
          SET state = 'provider_write_started', auto_retry_permitted = 0,
              provider_write_started_at = ?, updated_at = ?
        WHERE id = ? AND state = 'prepared'`,
      [occurredAt, occurredAt, outbox.id],
    );
    return this.requireOutbox(outbox.id);
  }

  recordOutcome(input: RecordCommandDeliveryOutcomeInput): CommandDeliveryReceiptRecord {
    return this.db.durableTransactionSync(() => this.recordOutcomeInCurrentTransaction(input));
  }

  recordOutcomeInCurrentTransaction(input: RecordCommandDeliveryOutcomeInput): CommandDeliveryReceiptRecord {
    return this.recordOutcomeInternal(input, false);
  }

  reconcileUnknownAsAccepted(input: Omit<RecordCommandDeliveryOutcomeInput, 'outcome'>): CommandDeliveryReceiptRecord {
    return this.db.durableTransactionSync(() => this.reconcileUnknownAsAcceptedInCurrentTransaction(input));
  }

  /** 只允许凭 Provider 原生 turn 身份把 unknown 收敛为 accepted；不会创建新 Outbox attempt。 */
  reconcileUnknownAsAcceptedInCurrentTransaction(input: Omit<RecordCommandDeliveryOutcomeInput, 'outcome'>): CommandDeliveryReceiptRecord {
    return this.recordOutcomeInternal({ ...input, outcome: 'accepted' }, true);
  }

  private recordOutcomeInternal(input: RecordCommandDeliveryOutcomeInput, allowUnknownReconciliation: boolean): CommandDeliveryReceiptRecord {
    const outbox = this.requireOutbox(boundedIdentity(input.outboxId, 'outboxId'));
    const outcome = validOutcome(input.outcome);
    const occurredAt = validTimestamp(input.occurredAt, 'occurredAt');
    const evidenceJson = canonicalJson(input.evidence);
    if (Buffer.byteLength(evidenceJson, 'utf8') > 1024 * 1024) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'Provider 回执证据超过 1 MiB，必须改存 ArtifactRef。', { outboxId: outbox.id });
    }
    const evidenceSha256 = sha256(evidenceJson);
    const existing = this.receiptByOutbox(outbox.id);
    const reconcilingUnknown = allowUnknownReconciliation && existing?.outcome === 'outcome_unknown_after_write' && outcome === 'accepted';
    if (existing) {
      if (
        existing.outcome === outcome &&
        existing.evidenceSha256 === evidenceSha256 &&
        existing.providerId === (input.providerId ?? null) &&
        existing.providerGenerationId === (input.providerGenerationId ?? null) &&
        existing.nativeSessionId === (input.nativeSessionId ?? null) &&
        existing.nativeTurnId === (input.nativeTurnId ?? null) &&
        existing.operationIdentity === (input.operationIdentity ?? null)
      ) {
        return existing;
      }
      if (!reconcilingUnknown) {
        throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT', '同一派发尝试已经存在不同的不可变回执。', {
          outboxId: outbox.id,
          existingOutcome: existing.outcome,
          attemptedOutcome: outcome,
        });
      }
    }
    if (outbox.state === 'resolved' && !reconcilingUnknown) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT', '派发尝试已收口但缺少可核对的同一回执。', { outboxId: outbox.id, outcome: outbox.outcome });
    }
    const fromState = reconcilingUnknown ? 'outcome_unknown_after_write' : outbox.state === 'prepared' ? 'prepared' : 'provider_write_started';
    assertDomainStateTransition(commandDeliveryAttemptStateMachine, fromState, outcome);
    const providerId = boundedOptionalIdentity(input.providerId, 'providerId');
    const providerGenerationId = boundedOptionalIdentity(input.providerGenerationId, 'providerGenerationId');
    const nativeSessionId = boundedOptionalIdentity(input.nativeSessionId, 'nativeSessionId');
    const nativeTurnId = boundedOptionalIdentity(input.nativeTurnId, 'nativeTurnId');
    const operationIdentity = boundedOptionalIdentity(input.operationIdentity, 'operationIdentity');
    if (outcome === 'accepted') {
      if (outbox.destinationKind === 'provider_runtime') {
        if (!nativeSessionId || nativeTurnId || operationIdentity) {
          throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'Provider Runtime 已接纳回执必须携带新 generation 的 nativeSessionId，且不能伪装为 nativeTurnId。', { outboxId: outbox.id });
        }
      } else if (outbox.destinationKind === 'provider_session') {
        if (!nativeSessionId || nativeTurnId || operationIdentity) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'Provider session 已接纳回执必须只携带真实 nativeSessionId。', { outboxId: outbox.id });
      } else if (outbox.destinationKind === 'provider_turn') {
        if (!nativeSessionId || !nativeTurnId || operationIdentity)
          throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'Provider turn 已接纳回执必须携带真实 nativeSessionId 与 native run/turn 身份。', { outboxId: outbox.id });
      } else if (outbox.destinationKind === 'core_application') {
        if (!operationIdentity || nativeSessionId || nativeTurnId) {
          throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'Core Application 已接纳回执必须只携带稳定 operationIdentity。', { outboxId: outbox.id });
        }
      } else if (!outbox.externalOperationId || operationIdentity || nativeSessionId || nativeTurnId) {
        throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'External operation 已接纳回执必须由 Outbox 的稳定 externalOperationId 证明，不能伪装 Provider/Core 身份。', { outboxId: outbox.id });
      }
    } else if (operationIdentity) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '只有 core_application accepted 回执可以携带 operationIdentity。', { outboxId: outbox.id });
    }
    const autoRetryPermitted = outcome === 'failed_before_write' || outcome === 'explicitly_rejected';
    const sequence = (existing?.sequence ?? 0) + 1;
    const receiptId = stableReceiptId(outbox.id, sequence);
    this.db.execute(
      `INSERT INTO command_delivery_receipts
       (id, command_id, outbox_id, sequence, outcome, provider_id, provider_generation_id, native_session_id,
        native_turn_id, operation_identity, evidence_sha256, evidence_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [receiptId, outbox.commandId, outbox.id, sequence, outcome, providerId, providerGenerationId, nativeSessionId, nativeTurnId, operationIdentity, evidenceSha256, evidenceJson, occurredAt],
    );
    this.db.execute(
      `UPDATE command_outbox
          SET state = 'resolved', outcome = ?, auto_retry_permitted = ?, resolved_at = ?, updated_at = ?
        WHERE id = ?`,
      [outcome, autoRetryPermitted ? 1 : 0, occurredAt, occurredAt, outbox.id],
    );
    this.db.execute(`UPDATE command_inbox SET delivery_state = ?, last_outcome = ?, updated_at = ? WHERE command_id = ?`, [autoRetryPermitted ? 'retryable' : 'terminal', outcome, occurredAt, outbox.commandId]);
    return this.requireReceipt(receiptId);
  }

  get(commandId: string): CommandDeliverySnapshot | undefined {
    const inboxRow = this.db.get<CommandInboxRow>(`SELECT * FROM command_inbox WHERE command_id = ?`, [boundedIdentity(commandId, 'commandId')]);
    if (!inboxRow) return undefined;
    const attempts = this.db.select<CommandOutboxRow>(`SELECT * FROM command_outbox WHERE command_id = ? ORDER BY attempt`, [commandId]).map((row) => {
      const outbox = mapOutbox(row);
      return { ...outbox, receipt: this.receiptByOutbox(outbox.id) ?? null };
    });
    const latest = attempts.at(-1);
    return {
      inbox: mapInbox(inboxRow),
      attempts,
      autoRetryPermitted: latest?.state === 'resolved' && (latest.outcome === 'failed_before_write' || latest.outcome === 'explicitly_rejected'),
    };
  }

  getByScope(scopeKind: string, scopeId: string): CommandDeliverySnapshot | undefined {
    const row = this.db.get<{ command_id: string }>(`SELECT command_id FROM command_inbox WHERE scope_kind = ? AND scope_id = ? ORDER BY created_at, command_id LIMIT 1`, [
      boundedIdentity(scopeKind, 'scopeKind'),
      boundedIdentity(scopeId, 'scopeId'),
    ]);
    return row ? this.get(row.command_id) : undefined;
  }

  getByOperationIdentity(operationIdentity: string): CommandDeliverySnapshot | undefined {
    const receipt = this.receiptByOperationIdentity(boundedIdentity(operationIdentity, 'operationIdentity'));
    return receipt ? this.get(receipt.commandId) : undefined;
  }

  getByExternalOperationIdentity(destinationId: string, externalOperationId: string): CommandDeliverySnapshot | undefined {
    const outbox = this.outboxByExternalOperation(boundedIdentity(destinationId, 'destinationId'), boundedIdentity(externalOperationId, 'externalOperationId'));
    return outbox ? this.get(outbox.commandId) : undefined;
  }

  listRecoveryRequired(limit = 100): CommandDeliverySnapshot[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '恢复扫描 limit 必须是 1 到 1000 的安全整数。', { limit });
    }
    return this.db
      .select<{ command_id: string }>(
        `SELECT command_id
           FROM command_inbox
          WHERE delivery_state = 'pending'
             OR last_outcome = 'outcome_unknown_after_write'
          ORDER BY updated_at, command_id
          LIMIT ?`,
        [limit],
      )
      .map((row) => this.get(row.command_id)!)
      .filter(Boolean);
  }

  /** 按 destination 分页领取仍未写出的外部操作；只返回每个 Command 的最新 prepared attempt。 */
  listPreparedExternalByDestination(destinationId: string, afterCommandId: string | null = null, limit = 256): CommandDeliverySnapshot[] {
    const normalizedDestinationId = boundedIdentity(destinationId, 'destinationId');
    const normalizedAfterCommandId = afterCommandId === null ? null : boundedIdentity(afterCommandId, 'afterCommandId');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'prepared 外部操作扫描 limit 必须是 1 到 1000 的安全整数。', { limit });
    }
    return this.db
      .select<{ command_id: string }>(
        `SELECT outbox.command_id
           FROM command_outbox AS outbox
          WHERE outbox.destination_kind = 'external_operation'
            AND outbox.destination_id = ?
            AND outbox.state = 'prepared'
            AND (? IS NULL OR outbox.command_id > ?)
            AND outbox.attempt = (
              SELECT MAX(latest.attempt)
                FROM command_outbox AS latest
               WHERE latest.command_id = outbox.command_id
            )
          ORDER BY outbox.command_id
          LIMIT ?`,
        [normalizedDestinationId, normalizedAfterCommandId, normalizedAfterCommandId, limit],
      )
      .map((row) => this.get(row.command_id)!)
      .filter(Boolean);
  }

  /** 进程重启时把“已耐久标记写出但没有回执”的 attempt 收口为 unknown，绝不重新投递。 */
  sealUnreceiptedProviderWritesAsUnknown(occurredAt: string): number {
    const recoveredAt = validTimestamp(occurredAt, 'occurredAt');
    return this.db.durableTransactionSync(() => {
      const rows = this.db.select<CommandOutboxRow>(
        `SELECT outbox.*
           FROM command_outbox AS outbox
           LEFT JOIN command_delivery_receipts AS receipt ON receipt.outbox_id = outbox.id
          WHERE outbox.state = 'provider_write_started'
            AND receipt.outbox_id IS NULL
          ORDER BY outbox.prepared_at, outbox.command_id, outbox.attempt`,
      );
      for (const row of rows) {
        const outbox = mapOutbox(row);
        this.recordOutcomeInCurrentTransaction({
          outboxId: outbox.id,
          outcome: 'outcome_unknown_after_write',
          evidence: {
            source: 'core_startup_recovery',
            providerWriteStartedAt: outbox.providerWriteStartedAt,
            reason: 'durable_write_marker_without_provider_receipt',
          },
          occurredAt: recoveredAt,
        });
      }
      return rows.length;
    });
  }

  private receiveInCurrentTransaction(envelope: CommandEnvelope, envelopeJson: string, envelopeSha256: string, requestSha256: string, occurredAt: string): CommandInboxRecord {
    const byIdentity = this.db.get<CommandInboxRow>(`SELECT * FROM command_inbox WHERE command_id = ?`, [envelope.commandId]);
    const byIdempotency = this.db.get<CommandInboxRow>(`SELECT * FROM command_inbox WHERE scope_kind = ? AND scope_id = ? AND idempotency_key = ?`, [envelope.scope.kind, envelope.scope.id, envelope.idempotencyKey]);
    const existing = byIdentity ?? byIdempotency;
    if (existing) {
      if (existing.command_id !== envelope.commandId || existing.envelope_sha256 !== envelopeSha256 || existing.request_sha256 !== requestSha256) {
        throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT', 'Command ID 或 scope 幂等键已经绑定不同请求。', {
          commandId: envelope.commandId,
          existingCommandId: existing.command_id,
          scopeKind: envelope.scope.kind,
          scopeId: envelope.scope.id,
        });
      }
      return mapInbox(existing);
    }
    this.db.execute(
      `INSERT INTO command_inbox
       (command_id, schema_generation, command_type, actor_kind, actor_id, scope_kind, scope_id,
        expected_revision, idempotency_key, envelope_sha256, request_sha256, envelope_json,
        delivery_state, last_outcome, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?, ?)`,
      [
        envelope.commandId,
        envelope.schemaGeneration,
        envelope.commandType,
        envelope.actor.kind,
        envelope.actor.id,
        envelope.scope.kind,
        envelope.scope.id,
        envelope.expectedRevision,
        envelope.idempotencyKey,
        envelopeSha256,
        requestSha256,
        envelopeJson,
        occurredAt,
        occurredAt,
      ],
    );
    return this.requireInbox(envelope.commandId);
  }

  private latestOutbox(commandId: string): CommandOutboxRecord | undefined {
    const row = this.db.get<CommandOutboxRow>(`SELECT * FROM command_outbox WHERE command_id = ? ORDER BY attempt DESC LIMIT 1`, [commandId]);
    return row ? mapOutbox(row) : undefined;
  }

  private receiptByOutbox(outboxId: string): CommandDeliveryReceiptRecord | undefined {
    const row = this.db.get<CommandDeliveryReceiptRow>(`SELECT * FROM command_delivery_receipts WHERE outbox_id = ? ORDER BY sequence DESC LIMIT 1`, [outboxId]);
    return row ? mapReceipt(row) : undefined;
  }

  private receiptByOperationIdentity(operationIdentity: string): CommandDeliveryReceiptRecord | undefined {
    const row = this.db.get<CommandDeliveryReceiptRow>(
      `SELECT * FROM command_delivery_receipts
        WHERE outcome = 'accepted' AND operation_identity = ?
        ORDER BY occurred_at, id LIMIT 1`,
      [operationIdentity],
    );
    return row ? mapReceipt(row) : undefined;
  }

  private outboxByExternalOperation(destinationId: string, externalOperationId: string): CommandOutboxRecord | undefined {
    const row = this.db.get<CommandOutboxRow>(
      `SELECT * FROM command_outbox
        WHERE destination_kind = 'external_operation' AND destination_id = ? AND external_operation_id = ?
        ORDER BY prepared_at, id LIMIT 1`,
      [destinationId, externalOperationId],
    );
    return row ? mapOutbox(row) : undefined;
  }

  private requireInbox(commandId: string): CommandInboxRecord {
    const row = this.db.get<CommandInboxRow>(`SELECT * FROM command_inbox WHERE command_id = ?`, [commandId]);
    if (!row) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_NOT_FOUND', 'Command Inbox 记录不存在。', { commandId });
    return mapInbox(row);
  }

  private requireOutbox(outboxId: string): CommandOutboxRecord {
    const row = this.db.get<CommandOutboxRow>(`SELECT * FROM command_outbox WHERE id = ?`, [outboxId]);
    if (!row) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_NOT_FOUND', 'Command Outbox 记录不存在。', { outboxId });
    return mapOutbox(row);
  }

  private requireReceipt(receiptId: string): CommandDeliveryReceiptRecord {
    const row = this.db.get<CommandDeliveryReceiptRow>(`SELECT * FROM command_delivery_receipts WHERE id = ?`, [receiptId]);
    if (!row) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_NOT_FOUND', 'Command Provider 回执不存在。', { receiptId });
    return mapReceipt(row);
  }
}

function mapInbox(row: CommandInboxRow): CommandInboxRecord {
  return {
    commandId: row.command_id,
    schemaGeneration: row.schema_generation,
    commandType: row.command_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    scopeKind: row.scope_kind,
    scopeId: row.scope_id,
    expectedRevision: row.expected_revision,
    idempotencyKey: row.idempotency_key,
    envelopeSha256: row.envelope_sha256,
    requestSha256: row.request_sha256,
    envelopeJson: row.envelope_json,
    deliveryState: row.delivery_state,
    lastOutcome: row.last_outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutbox(row: CommandOutboxRow): CommandOutboxRecord {
  return {
    id: row.id,
    commandId: row.command_id,
    attempt: row.attempt,
    destinationKind: row.destination_kind,
    destinationId: row.destination_id,
    resourceId: row.resource_id,
    externalOperationId: row.external_operation_id,
    state: row.state,
    outcome: row.outcome,
    autoRetryPermitted: row.auto_retry_permitted === 1,
    preparedAt: row.prepared_at,
    providerWriteStartedAt: row.provider_write_started_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function mapReceipt(row: CommandDeliveryReceiptRow): CommandDeliveryReceiptRecord {
  return {
    id: row.id,
    commandId: row.command_id,
    outboxId: row.outbox_id,
    sequence: row.sequence,
    outcome: row.outcome,
    providerId: row.provider_id,
    providerGenerationId: row.provider_generation_id,
    nativeSessionId: row.native_session_id,
    nativeTurnId: row.native_turn_id,
    operationIdentity: row.operation_identity,
    evidenceSha256: row.evidence_sha256,
    evidenceJson: row.evidence_json,
    occurredAt: row.occurred_at,
  };
}

function assertSameDeliveryIdentity(outbox: CommandOutboxRecord, destinationKind: CommandDeliveryDestinationKind, destinationId: string, resourceId: string, externalOperationId: string | null): void {
  if (outbox.destinationKind === destinationKind && outbox.destinationId === destinationId && outbox.resourceId === resourceId && outbox.externalOperationId === externalOperationId) return;
  throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT', '活动 Outbox 已绑定不同的目的地或资源身份。', {
    outboxId: outbox.id,
    commandId: outbox.commandId,
  });
}

function validDestinationKind(value: unknown): CommandDeliveryDestinationKind {
  if (value === 'provider_turn' || value === 'provider_session' || value === 'provider_runtime' || value === 'core_application' || value === 'external_operation') return value;
  throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'destinationKind 必须是已治理命令目的地之一。', { destinationKind: typeof value === 'string' ? value : null });
}

function validOutcome(value: unknown): CommandDeliveryOutcome {
  if (typeof value === 'string' && commandDeliveryOutcomes.includes(value as CommandDeliveryOutcome)) return value as CommandDeliveryOutcome;
  throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', 'Provider 派发结果不在允许的四态集合中。', { outcome: typeof value === 'string' ? value : null });
}

function validSha256(value: unknown, field: string): string {
  if (typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)) return value;
  if (typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)) return value.slice('sha256:'.length);
  throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', `${field} 必须是小写 SHA-256。`, { field });
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512 || Array.from(value).some(isControlCharacter)) {
    throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', `${field} 不是有效的稳定身份。`, { field });
  }
  return value;
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 31 || codePoint === 127;
}

function boundedOptionalIdentity(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return boundedIdentity(value, field);
}

function validTimestamp(value: unknown, field: string): string {
  const timestamp = boundedIdentity(value, field);
  if (Number.isNaN(Date.parse(timestamp))) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', `${field} 必须是有效时间。`, { field });
  return timestamp;
}

function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalValue(value, new Set(), 0));
  if (encoded === undefined) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据不是可持久化 JSON。');
  return encoded;
}

function canonicalValue(value: unknown, stack: Set<object>, depth: number): unknown {
  if (depth > 32) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据超过最大嵌套深度。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据包含非有限数字。');
    return value;
  }
  if (Array.isArray(value)) {
    if (stack.has(value)) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据包含循环引用。');
    stack.add(value);
    try {
      return value.map((entry) => (entry === undefined ? null : canonicalValue(entry, stack, depth + 1)));
    } finally {
      stack.delete(value);
    }
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据包含非普通对象。');
    if (stack.has(value)) throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据包含循环引用。');
    stack.add(value);
    const result: Record<string, unknown> = {};
    try {
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        const candidate = (value as Record<string, unknown>)[key];
        if (candidate === undefined) continue;
        if (typeof candidate === 'function' || typeof candidate === 'symbol' || typeof candidate === 'bigint') {
          throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据包含非 JSON 字段。', { field: key });
        }
        result[key] = canonicalValue(candidate, stack, depth + 1);
      }
    } finally {
      stack.delete(value);
    }
    return result;
  }
  throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT', '命令或回执证据不是可持久化 JSON。');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableOutboxId(commandId: string, attempt: number): string {
  return `command_outbox_${createHash('sha256').update(`${commandId}\0${attempt}`).digest('hex').slice(0, 32)}`;
}

function stableReceiptId(outboxId: string, sequence: number): string {
  return `command_receipt_${createHash('sha256').update(`${outboxId}\0${sequence}`).digest('hex').slice(0, 32)}`;
}

function assertRequiredColumns(db: ZeusDatabasePort, table: string, columns: readonly string[]): void {
  const present = new Set(db.select<{ name: string }>(`PRAGMA table_info(${table})`).map((column) => column.name));
  const missing = columns.filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw commandDeliveryError('ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT', '命令派发表结构不完整，已拒绝猜测迁移。', { table, missingColumns: missing.join(',') });
  }
}

function commandDeliveryError(code: CommandDeliveryStoreErrorCode, message: string, details: Readonly<Record<string, string | number | boolean | null>> = {}): CommandDeliveryStoreError {
  return new CommandDeliveryStoreError(code, message, details);
}
