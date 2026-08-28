import { createHash, randomUUID } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { runtimeSessionProcessOwningStatuses } from './runtimeSessionStore.js';

export const EXECUTION_HOST_HANDOFF_MIGRATION_ID = '20260821_0003_execution_host_durable_handoff';

export type ExecutionHostHandoffStatus = 'draining' | 'prepared' | 'claimed' | 'completed' | 'recovery_required' | 'aborted';

export interface ExecutionHostHandoffRecord {
  id: string;
  sourceInstanceId: string;
  sourceAppVersion: string;
  targetAppVersion: string;
  status: ExecutionHostHandoffStatus;
  checkpointSha256: string | null;
  requestCount: number;
  claimedByInstanceId: string | null;
  failureJson: string | null;
  createdAt: string;
  updatedAt: string;
  preparedAt: string | null;
  claimedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionHostHandoffPreparation {
  handoffId: string;
  checkpointSha256: string;
  requestCount: number;
  preparedAt: string;
}

export interface ExecutionHostHandoffRecoveryResult {
  outcome: 'none' | 'completed' | 'aborted' | 'recovery_required';
  handoffId: string | null;
  restoredRequestCount: number;
  dispatchEnabled: boolean;
  reason: string | null;
}

export interface ExecutionHostHandoffBlockers {
  effectfulTurnCount: number;
  activeRuntimeCount: number;
  activeCommandRunCount: number;
  piWaitingTurnCount: number;
  unrecoverableWaitingTurnCount: number;
  pendingRequestCount: number;
  recoverableCodexRequestCount: number;
  invalidCodexRequestCount: number;
}

interface DbHandoffRow {
  id: string;
  source_instance_id: string;
  source_app_version: string;
  target_app_version: string;
  status: string;
  checkpoint_sha256: string | null;
  request_count: number;
  claimed_by_instance_id: string | null;
  failure_json: string | null;
  created_at: string;
  updated_at: string;
  prepared_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
}

interface DbPendingRequestCheckpointRow {
  request_id: string;
  conversation_id: string;
  turn_id: string | null;
  transport_generation_id: string;
  provider_request_id_json: string;
  request_kind: string;
  request_status: string;
  request_created_at: string;
  conversation_agent_kind: string | null;
  conversation_transport_kind: string;
  conversation_agent_transport: string | null;
  conversation_provider_id: string | null;
  conversation_provider_thread_id: string | null;
  conversation_native_session_id: string | null;
  conversation_updated_at: string;
  turn_conversation_id: string | null;
  turn_status: string | null;
  turn_agent_kind: string | null;
  turn_updated_at: string | null;
}

interface DbHandoffRequestRow {
  handoff_id: string;
  ordinal: number;
  request_id: string;
  conversation_id: string;
  expected_turn_id: string;
  expected_transport_generation_id: string;
  expected_provider_request_id_json: string;
  expected_request_kind: string;
  expected_request_status: string;
  expected_request_created_at: string;
  expected_conversation_updated_at: string;
  expected_turn_status: string;
  expected_turn_updated_at: string;
  identity_sha256: string;
}

const pendingRequestCheckpointSql = `
  SELECT request.id AS request_id,
         request.conversation_id,
         request.turn_id,
         request.transport_generation_id,
         request.provider_request_id_json,
         request.request_kind,
         request.status AS request_status,
         request.created_at AS request_created_at,
         conversation.agent_kind AS conversation_agent_kind,
         conversation.transport_kind AS conversation_transport_kind,
         conversation.agent_transport AS conversation_agent_transport,
         conversation.provider_id AS conversation_provider_id,
         conversation.provider_thread_id AS conversation_provider_thread_id,
         conversation.native_session_id AS conversation_native_session_id,
         conversation.updated_at AS conversation_updated_at,
         turn.conversation_id AS turn_conversation_id,
         turn.status AS turn_status,
         turn.agent_kind AS turn_agent_kind,
         turn.updated_at AS turn_updated_at
    FROM conversation_server_requests AS request
    JOIN conversations AS conversation ON conversation.id = request.conversation_id
    LEFT JOIN conversation_turns AS turn ON turn.id = request.turn_id
   WHERE request.status = 'pending'
   ORDER BY request.created_at, request.id
`;

/** Execution Host 交接账本与请求快照和业务会话共享同一个 SQLite 提交边界。 */
export function migrateExecutionHostHandoffSchema(db: ZeusDatabasePort): void {
  const checksum = `sha256:${createHash('sha256').update('execution-host-handoff-journal-v1:single-active:request-cas:dispatch-fence').digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [EXECUTION_HOST_HANDOFF_MIGRATION_ID]);
    if (existing && existing.checksum !== checksum) {
      throw handoffError('ZEUS_EXECUTION_HOST_HANDOFF_SCHEMA_CONFLICT', 'Execution Host 交接迁移账本与当前结构定义不一致，已拒绝继续打开数据库。');
    }
    db.execute(`
      CREATE TABLE IF NOT EXISTS execution_host_handoffs (
        id TEXT PRIMARY KEY,
        source_instance_id TEXT NOT NULL,
        source_app_version TEXT NOT NULL,
        target_app_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draining', 'prepared', 'claimed', 'completed', 'recovery_required', 'aborted')),
        checkpoint_sha256 TEXT,
        request_count INTEGER NOT NULL DEFAULT 0,
        claimed_by_instance_id TEXT,
        failure_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        prepared_at TEXT,
        claimed_at TEXT,
        completed_at TEXT
      )
    `);
    db.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_host_single_active_handoff
      ON execution_host_handoffs((1))
      WHERE status IN ('draining', 'prepared', 'claimed')
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_execution_host_handoff_status ON execution_host_handoffs(status, created_at DESC, id DESC)`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS execution_host_handoff_requests (
        handoff_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        expected_turn_id TEXT NOT NULL,
        expected_transport_generation_id TEXT NOT NULL,
        expected_provider_request_id_json TEXT NOT NULL,
        expected_request_kind TEXT NOT NULL,
        expected_request_status TEXT NOT NULL,
        expected_request_created_at TEXT NOT NULL,
        expected_conversation_updated_at TEXT NOT NULL,
        expected_turn_status TEXT NOT NULL,
        expected_turn_updated_at TEXT NOT NULL,
        identity_sha256 TEXT NOT NULL,
        restore_outcome TEXT,
        restored_at TEXT,
        PRIMARY KEY (handoff_id, request_id),
        UNIQUE (handoff_id, ordinal),
        FOREIGN KEY (handoff_id) REFERENCES execution_host_handoffs(id) ON DELETE CASCADE
      )
    `);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      EXECUTION_HOST_HANDOFF_MIGRATION_ID,
      '增加 Execution Host 持久化排空、请求 CAS 恢复与派发闸门账本',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

/**
 * 持久化升级交接仓储。
 *
 * draining/prepared/claim/restore 与 dispatch_enabled 都由 SQLite 原子裁决；Main 不持有业务快照。
 */
export class ExecutionHostHandoffRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  startDraining(input: { sourceInstanceId: string; sourceAppVersion: string; targetAppVersion: string; startedAt: string }): ExecutionHostHandoffRecord {
    const id = `execution_host_handoff_${randomUUID()}`;
    this.db.durableTransactionSync(() => {
      const active = this.active();
      if (active) throw handoffError('ZEUS_EXECUTION_HOST_HANDOFF_ALREADY_ACTIVE', `Execution Host 交接 ${active.id} 仍处于 ${active.status}。`);
      this.db.execute(
        `INSERT INTO execution_host_handoffs
         (id, source_instance_id, source_app_version, target_app_version, status, checkpoint_sha256,
          request_count, claimed_by_instance_id, failure_json, created_at, updated_at,
          prepared_at, claimed_at, completed_at)
         VALUES (?, ?, ?, ?, 'draining', NULL, 0, NULL, NULL, ?, ?, NULL, NULL, NULL)`,
        [id, input.sourceInstanceId, input.sourceAppVersion, input.targetAppVersion, input.startedAt, input.startedAt],
      );
      this.setDispatchEnabled(false);
    });
    return this.require(id);
  }

  abandonDraining(id: string, input: { reason: string; abandonedAt: string }): void {
    this.db.durableTransactionSync(() => {
      const current = this.require(id);
      if (current.status !== 'draining') return;
      this.db.execute(`UPDATE execution_host_handoffs SET status = 'aborted', failure_json = ?, updated_at = ? WHERE id = ? AND status = 'draining'`, [
        JSON.stringify({ code: 'ZEUS_EXECUTION_HOST_HANDOFF_BLOCKED', reason: input.reason }),
        input.abandonedAt,
        id,
      ]);
      this.setDispatchEnabled(true);
    });
  }

  requireRecovery(id: string, input: { reason: string; occurredAt: string }): void {
    this.db.durableTransactionSync(() => this.markRecoveryRequired(id, input.reason, input.occurredAt, []));
  }

  readBlockers(): ExecutionHostHandoffBlockers {
    const pending = this.db.select<DbPendingRequestCheckpointRow>(pendingRequestCheckpointSql);
    const recoverable = pending.filter(isRecoverableCodexWaitingRequest);
    const row = this.db.get<{
      effectful_turn_count: number;
      active_runtime_count: number;
      active_command_run_count: number;
      pi_waiting_turn_count: number;
      waiting_turn_count: number;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM conversation_turns WHERE status IN ('dispatching', 'running')) AS effectful_turn_count,
        (SELECT COUNT(*) FROM runtime_sessions WHERE status IN (${runtimeSessionProcessOwningStatuses.map((status) => `'${status}'`).join(', ')})) AS active_runtime_count,
        (SELECT COUNT(*) FROM command_runs WHERE status IN ('pending_confirmation', 'starting', 'running', 'stopping')) AS active_command_run_count,
        (SELECT COUNT(*) FROM conversation_turns WHERE status = 'waiting' AND agent_kind = 'pi') AS pi_waiting_turn_count,
        (SELECT COUNT(*) FROM conversation_turns WHERE status = 'waiting') AS waiting_turn_count
    `);
    if (!row) throw new Error('Execution Host 交接阻断查询未返回结果。');
    return {
      effectfulTurnCount: assertCount(row.effectful_turn_count),
      activeRuntimeCount: assertCount(row.active_runtime_count),
      activeCommandRunCount: assertCount(row.active_command_run_count),
      piWaitingTurnCount: assertCount(row.pi_waiting_turn_count),
      unrecoverableWaitingTurnCount: Math.max(0, assertCount(row.waiting_turn_count) - new Set(recoverable.map((request) => request.turn_id)).size),
      pendingRequestCount: pending.length,
      recoverableCodexRequestCount: recoverable.length,
      invalidCodexRequestCount: pending.length - recoverable.length,
    };
  }

  prepare(id: string, preparedAt: string): ExecutionHostHandoffPreparation {
    let revalidationBlockers: ExecutionHostHandoffBlockers | null = null;
    const prepared = this.db.durableTransactionSync(() => {
      const handoff = this.require(id);
      if (handoff.status !== 'draining') throw handoffError('ZEUS_EXECUTION_HOST_HANDOFF_NOT_DRAINING', `Execution Host 交接 ${id} 不处于 draining。`);
      const blockers = this.readBlockers();
      if (hasBlockers(blockers)) {
        revalidationBlockers = blockers;
        this.db.execute(`UPDATE execution_host_handoffs SET status = 'recovery_required', failure_json = ?, updated_at = ? WHERE id = ?`, [
          JSON.stringify({ code: 'ZEUS_EXECUTION_HOST_HANDOFF_REVALIDATION_FAILED', blockers }),
          preparedAt,
          id,
        ]);
        return null;
      }

      const requests = this.db.select<DbPendingRequestCheckpointRow>(pendingRequestCheckpointSql);
      const identities = requests.map((request, ordinal) => ({ request, ordinal, sha256: requestIdentitySha256(request) }));
      for (const identity of identities) {
        const request = identity.request;
        this.db.execute(
          `INSERT INTO execution_host_handoff_requests
           (handoff_id, ordinal, request_id, conversation_id, expected_turn_id,
            expected_transport_generation_id, expected_provider_request_id_json,
            expected_request_kind, expected_request_status, expected_request_created_at,
            expected_conversation_updated_at, expected_turn_status, expected_turn_updated_at,
            identity_sha256, restore_outcome, restored_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
          [
            id,
            identity.ordinal,
            request.request_id,
            request.conversation_id,
            request.turn_id!,
            request.transport_generation_id,
            request.provider_request_id_json,
            request.request_kind,
            request.request_status,
            request.request_created_at,
            request.conversation_updated_at,
            request.turn_status!,
            request.turn_updated_at!,
            identity.sha256,
          ],
        );
      }
      const checkpointSha256 = checkpointHash(
        id,
        handoff.sourceInstanceId,
        handoff.targetAppVersion,
        identities.map((identity) => identity.sha256),
      );
      this.db.execute(
        `UPDATE execution_host_handoffs
            SET status = 'prepared', checkpoint_sha256 = ?, request_count = ?,
                failure_json = NULL, prepared_at = ?, updated_at = ?
          WHERE id = ? AND status = 'draining'`,
        [checkpointSha256, identities.length, preparedAt, preparedAt, id],
      );
      return { handoffId: id, checkpointSha256, requestCount: identities.length, preparedAt };
    });
    if (!prepared || revalidationBlockers) {
      throw handoffError('ZEUS_EXECUTION_HOST_HANDOFF_REVALIDATION_FAILED', `Execution Host 在冻结 Provider 后复核失败：${JSON.stringify(revalidationBlockers)}`);
    }
    return prepared;
  }

  isPrepared(input: { handoffId: string; checkpointSha256: string }): boolean {
    const row = this.db.get<{ present: number }>(`SELECT 1 AS present FROM execution_host_handoffs WHERE id = ? AND status = 'prepared' AND checkpoint_sha256 = ?`, [input.handoffId, input.checkpointSha256]);
    return row?.present === 1;
  }

  /** 新 Core 的首次业务恢复：在同一同步耐久事务内完成 claim、逐项 CAS、恢复标记和重新开闸。 */
  recoverPrepared(input: { claimingInstanceId: string; claimingAppVersion: string; restoredAt: string }): ExecutionHostHandoffRecoveryResult {
    return this.db.durableTransactionSync(() => {
      const staleDraining = this.db.get<DbHandoffRow>(`SELECT * FROM execution_host_handoffs WHERE status IN ('draining', 'claimed') ORDER BY created_at DESC, id DESC LIMIT 1`);
      if (staleDraining) {
        const reason = staleDraining.status === 'draining' ? 'source_core_exited_before_prepared' : 'claim_interrupted';
        this.markRecoveryRequired(staleDraining.id, reason, input.restoredAt, []);
        return { outcome: 'recovery_required', handoffId: staleDraining.id, restoredRequestCount: 0, dispatchEnabled: false, reason };
      }

      const preparedRow = this.db.get<DbHandoffRow>(`SELECT * FROM execution_host_handoffs WHERE status = 'prepared' ORDER BY prepared_at DESC, id DESC LIMIT 1`);
      if (!preparedRow) {
        const recovery = this.db.get<DbHandoffRow>(`SELECT *
                                                      FROM execution_host_handoffs
                                                      WHERE status = 'recovery_required'
                                                      ORDER BY updated_at DESC, id DESC
                                                      LIMIT 1`);
        if (recovery) {
          const storedRequestCount =
            this.db.get<{
              count: number;
            }>(`SELECT COUNT(*) AS count FROM execution_host_handoff_requests WHERE handoff_id = ?`, [recovery.id])?.count ?? 0;
          // source Core 在生成 checkpoint 前失败时，没有任何可供新 Core 恢复的交接正文。
          // 将明确未发送的本地队列暂停后即可安全终止该账本；Provider 已接纳的轮次仍由随后
          // 的原生恢复流程按权威快照对账，禁止自动重放本地队列。
          if (recovery.checkpoint_sha256 === null && recovery.request_count === 0 && storedRequestCount === 0) {
            this.db.execute(
              `UPDATE conversation_submissions
                  SET status = 'paused', paused_reason = 'upgrade_interrupted', submission_outcome = 'paused', updated_at = ?
                WHERE status = 'queued' AND provider_turn_id IS NULL`,
              [input.restoredAt],
            );
            this.db.execute(`UPDATE execution_host_handoffs SET status = 'aborted', updated_at = ? WHERE id = ? AND status = 'recovery_required'`, [input.restoredAt, recovery.id]);
            this.setDispatchEnabled(true);
            return {
              outcome: 'aborted',
              handoffId: recovery.id,
              restoredRequestCount: 0,
              dispatchEnabled: true,
              reason: recovery.failure_json,
            };
          }
          this.setDispatchEnabled(false);
          return { outcome: 'recovery_required', handoffId: recovery.id, restoredRequestCount: 0, dispatchEnabled: false, reason: recovery.failure_json };
        }
        return { outcome: 'none', handoffId: null, restoredRequestCount: 0, dispatchEnabled: false, reason: null };
      }

      const prepared = mapHandoff(preparedRow);
      if (prepared.targetAppVersion !== input.claimingAppVersion) {
        const reason = `target_app_version_mismatch:${prepared.targetAppVersion}:${input.claimingAppVersion}`;
        this.markRecoveryRequired(prepared.id, reason, input.restoredAt, []);
        return { outcome: 'recovery_required', handoffId: prepared.id, restoredRequestCount: 0, dispatchEnabled: false, reason };
      }

      this.db.execute(
        `UPDATE execution_host_handoffs
            SET status = 'claimed', claimed_by_instance_id = ?, claimed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'prepared'`,
        [input.claimingInstanceId, input.restoredAt, input.restoredAt, prepared.id],
      );

      const expected = this.db.select<DbHandoffRequestRow>(`SELECT * FROM execution_host_handoff_requests WHERE handoff_id = ? ORDER BY ordinal, request_id`, [prepared.id]);
      const persistedRequestHashes = expected.map(storedRequestIdentitySha256);
      const persistedCheckpointSha256 = checkpointHash(prepared.id, prepared.sourceInstanceId, prepared.targetAppVersion, persistedRequestHashes);
      const journalIntegrityMismatch =
        expected.length !== prepared.requestCount || prepared.checkpointSha256 !== persistedCheckpointSha256 || expected.some((checkpoint, index) => checkpoint.identity_sha256 !== persistedRequestHashes[index]);
      if (journalIntegrityMismatch) {
        const reason = 'handoff_checkpoint_integrity_mismatch';
        this.markRecoveryRequired(prepared.id, reason, input.restoredAt, []);
        return { outcome: 'recovery_required', handoffId: prepared.id, restoredRequestCount: 0, dispatchEnabled: false, reason };
      }

      const current = this.db.select<DbPendingRequestCheckpointRow>(pendingRequestCheckpointSql);
      const currentById = new Map(current.map((request) => [request.request_id, request]));
      const mismatchedConversationIds = new Set<string>();
      const restoredConversations = new Map<string, string>();
      const restoredTurns = new Map<string, Pick<DbHandoffRequestRow, 'conversation_id' | 'expected_turn_id' | 'expected_turn_status' | 'expected_turn_updated_at'>>();
      for (const checkpoint of expected) {
        const candidate = currentById.get(checkpoint.request_id);
        if (!candidate || !matchesCheckpoint(candidate, checkpoint)) mismatchedConversationIds.add(checkpoint.conversation_id);
        const turnKey = `${checkpoint.conversation_id}\0${checkpoint.expected_turn_id}`;
        const groupedTurn = restoredTurns.get(turnKey);
        if (groupedTurn && (groupedTurn.expected_turn_status !== checkpoint.expected_turn_status || groupedTurn.expected_turn_updated_at !== checkpoint.expected_turn_updated_at)) {
          mismatchedConversationIds.add(checkpoint.conversation_id);
        } else {
          restoredTurns.set(turnKey, checkpoint);
        }
      }
      if (current.length !== expected.length) {
        for (const candidate of current) {
          if (!expected.some((checkpoint) => checkpoint.request_id === candidate.request_id)) mismatchedConversationIds.add(candidate.conversation_id);
        }
      }
      if (mismatchedConversationIds.size > 0) {
        const reason = 'pending_request_compare_and_swap_mismatch';
        this.markRecoveryRequired(prepared.id, reason, input.restoredAt, [...mismatchedConversationIds]);
        return { outcome: 'recovery_required', handoffId: prepared.id, restoredRequestCount: 0, dispatchEnabled: false, reason };
      }

      try {
        this.db.transaction(() => {
          for (const checkpoint of expected) {
            const marker = JSON.stringify({
              interactionRecoveryCheckpoint: true,
              handoffCheckpoint: true,
              recoveryReason: 'host_handoff',
              handoffId: prepared.id,
              checkpointSha256: prepared.checkpointSha256,
              sourceInstanceId: prepared.sourceInstanceId,
              capturedAt: prepared.preparedAt,
              restoredAt: input.restoredAt,
            });
            this.db.execute(
              `UPDATE conversation_server_requests
                  SET status = 'pending', response_json = ?, resolved_at = NULL, auto_resolution_state = 'none'
                WHERE id = ? AND conversation_id = ? AND turn_id = ?
                  AND transport_generation_id = ? AND provider_request_id_json = ?
                  AND request_kind = ? AND status = ? AND created_at = ?`,
              [
                marker,
                checkpoint.request_id,
                checkpoint.conversation_id,
                checkpoint.expected_turn_id,
                checkpoint.expected_transport_generation_id,
                checkpoint.expected_provider_request_id_json,
                checkpoint.expected_request_kind,
                checkpoint.expected_request_status,
                checkpoint.expected_request_created_at,
              ],
            );
            assertSingleCasChange(this.db, checkpoint.conversation_id, `request:${checkpoint.request_id}`);
            restoredConversations.set(checkpoint.conversation_id, checkpoint.expected_conversation_updated_at);
            this.db.execute(
              `UPDATE execution_host_handoff_requests
                  SET restore_outcome = 'restored', restored_at = ?
                WHERE handoff_id = ? AND request_id = ? AND restore_outcome IS NULL`,
              [input.restoredAt, prepared.id, checkpoint.request_id],
            );
            assertSingleCasChange(this.db, checkpoint.conversation_id, `journal_request:${checkpoint.request_id}`);
          }
          // 同一 turn 可以存在多个 pending request；按 turn 聚合后只执行并核对一次 CAS。
          for (const checkpoint of restoredTurns.values()) {
            this.db.execute(
              `UPDATE conversation_turns
                  SET status = 'waiting', completed_at = NULL, updated_at = ?
                WHERE id = ? AND conversation_id = ? AND status = ? AND updated_at = ? AND agent_kind = 'codex'`,
              [input.restoredAt, checkpoint.expected_turn_id, checkpoint.conversation_id, checkpoint.expected_turn_status, checkpoint.expected_turn_updated_at],
            );
            assertSingleCasChange(this.db, checkpoint.conversation_id, `turn:${checkpoint.expected_turn_id}`);
          }
          for (const [conversationId, expectedUpdatedAt] of restoredConversations) {
            this.db.execute(
              `UPDATE conversations
                  SET provider_state = 'waiting', stage = 'waiting_user', stage_updated_at = ?, updated_at = ?
                WHERE id = ? AND updated_at = ? AND agent_kind = 'codex'
                  AND transport_kind = 'codex_native' AND agent_transport = 'app_server'
                  AND provider_id = 'codex' AND provider_thread_id IS NOT NULL
                  AND native_session_id = provider_thread_id`,
              [input.restoredAt, input.restoredAt, conversationId, expectedUpdatedAt],
            );
            assertSingleCasChange(this.db, conversationId, `conversation:${conversationId}`);
          }
          this.db.execute(
            `UPDATE execution_host_handoffs
                SET status = 'completed', completed_at = ?, updated_at = ?, failure_json = NULL
              WHERE id = ? AND status = 'claimed' AND claimed_by_instance_id = ?`,
            [input.restoredAt, input.restoredAt, prepared.id, input.claimingInstanceId],
          );
          assertSingleCasChange(this.db, null, `handoff:${prepared.id}`);
        });
      } catch (error) {
        if (!isHandoffCasMismatch(error)) throw error;
        const reason = `pending_request_compare_and_swap_update_mismatch:${error.step}`;
        this.markRecoveryRequired(prepared.id, reason, input.restoredAt, [...new Set(expected.map((checkpoint) => checkpoint.conversation_id))]);
        return { outcome: 'recovery_required', handoffId: prepared.id, restoredRequestCount: 0, dispatchEnabled: false, reason };
      }
      this.setDispatchEnabled(true);
      return { outcome: 'completed', handoffId: prepared.id, restoredRequestCount: expected.length, dispatchEnabled: true, reason: null };
    });
  }

  active(): ExecutionHostHandoffRecord | undefined {
    const row = this.db.get<DbHandoffRow>(`SELECT * FROM execution_host_handoffs WHERE status IN ('draining', 'prepared', 'claimed') ORDER BY created_at DESC, id DESC LIMIT 1`);
    return row ? mapHandoff(row) : undefined;
  }

  getById(id: string): ExecutionHostHandoffRecord | undefined {
    const row = this.db.get<DbHandoffRow>(`SELECT * FROM execution_host_handoffs WHERE id = ?`, [id]);
    return row ? mapHandoff(row) : undefined;
  }

  private require(id: string): ExecutionHostHandoffRecord {
    const handoff = this.getById(id);
    if (!handoff) throw handoffError('ZEUS_EXECUTION_HOST_HANDOFF_NOT_FOUND', `Execution Host 交接不存在：${id}`);
    return handoff;
  }

  private markRecoveryRequired(id: string, reason: string, occurredAt: string, conversationIds: string[]): void {
    this.db.execute(
      `UPDATE execution_host_handoffs
          SET status = 'recovery_required', failure_json = ?, updated_at = ?
        WHERE id = ? AND status IN ('draining', 'prepared', 'claimed')`,
      [JSON.stringify({ code: 'ZEUS_EXECUTION_HOST_HANDOFF_RECOVERY_REQUIRED', reason }), occurredAt, id],
    );
    for (const conversationId of conversationIds) {
      this.db.execute(
        `UPDATE conversation_turns
            SET status = 'paused', error_json = ?, updated_at = ?
          WHERE conversation_id = ? AND status IN ('dispatching', 'running', 'waiting')`,
        [JSON.stringify({ code: 'ZEUS_EXECUTION_HOST_HANDOFF_CAS_MISMATCH', reason }), occurredAt, conversationId],
      );
      this.db.execute(
        `UPDATE conversations
            SET provider_state = 'paused', stage = 'paused', stage_updated_at = ?, updated_at = ?
          WHERE id = ?`,
        [occurredAt, occurredAt, conversationId],
      );
    }
    this.setDispatchEnabled(false);
  }

  private setDispatchEnabled(enabled: boolean): void {
    this.db.execute(`UPDATE conversation_store_metadata SET dispatch_enabled = ? WHERE singleton = 1`, [enabled ? 1 : 0]);
  }
}

function isRecoverableCodexWaitingRequest(row: DbPendingRequestCheckpointRow): boolean {
  return (
    row.request_status === 'pending' &&
    row.conversation_agent_kind === 'codex' &&
    row.conversation_transport_kind === 'codex_native' &&
    row.conversation_agent_transport === 'app_server' &&
    row.conversation_provider_id === 'codex' &&
    Boolean(row.conversation_provider_thread_id) &&
    row.conversation_native_session_id === row.conversation_provider_thread_id &&
    Boolean(row.turn_id) &&
    row.turn_conversation_id === row.conversation_id &&
    row.turn_status === 'waiting' &&
    row.turn_agent_kind === 'codex' &&
    Boolean(row.turn_updated_at)
  );
}

function requestIdentitySha256(row: DbPendingRequestCheckpointRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.request_id,
        row.conversation_id,
        row.turn_id,
        row.transport_generation_id,
        row.provider_request_id_json,
        row.request_kind,
        row.request_status,
        row.request_created_at,
        row.conversation_updated_at,
        row.turn_status,
        row.turn_updated_at,
      ]),
    )
    .digest('hex');
}

function storedRequestIdentitySha256(row: DbHandoffRequestRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.request_id,
        row.conversation_id,
        row.expected_turn_id,
        row.expected_transport_generation_id,
        row.expected_provider_request_id_json,
        row.expected_request_kind,
        row.expected_request_status,
        row.expected_request_created_at,
        row.expected_conversation_updated_at,
        row.expected_turn_status,
        row.expected_turn_updated_at,
      ]),
    )
    .digest('hex');
}

function checkpointHash(handoffId: string, sourceInstanceId: string, targetAppVersion: string, requestHashes: string[]): string {
  return createHash('sha256').update(JSON.stringify({ handoffId, sourceInstanceId, targetAppVersion, requestHashes })).digest('hex');
}

function matchesCheckpoint(current: DbPendingRequestCheckpointRow, expected: DbHandoffRequestRow): boolean {
  return (
    isRecoverableCodexWaitingRequest(current) &&
    current.conversation_id === expected.conversation_id &&
    current.turn_id === expected.expected_turn_id &&
    current.transport_generation_id === expected.expected_transport_generation_id &&
    current.provider_request_id_json === expected.expected_provider_request_id_json &&
    current.request_kind === expected.expected_request_kind &&
    current.request_status === expected.expected_request_status &&
    current.request_created_at === expected.expected_request_created_at &&
    current.conversation_updated_at === expected.expected_conversation_updated_at &&
    current.turn_status === expected.expected_turn_status &&
    current.turn_updated_at === expected.expected_turn_updated_at &&
    requestIdentitySha256(current) === expected.identity_sha256
  );
}

function hasBlockers(blockers: ExecutionHostHandoffBlockers): boolean {
  return (
    blockers.effectfulTurnCount > 0 ||
    blockers.activeRuntimeCount > 0 ||
    blockers.activeCommandRunCount > 0 ||
    blockers.piWaitingTurnCount > 0 ||
    blockers.unrecoverableWaitingTurnCount > 0 ||
    blockers.invalidCodexRequestCount > 0 ||
    blockers.pendingRequestCount !== blockers.recoverableCodexRequestCount
  );
}

function mapHandoff(row: DbHandoffRow): ExecutionHostHandoffRecord {
  return {
    id: row.id,
    sourceInstanceId: row.source_instance_id,
    sourceAppVersion: row.source_app_version,
    targetAppVersion: row.target_app_version,
    status: parseStatus(row.status),
    checkpointSha256: row.checkpoint_sha256,
    requestCount: assertCount(row.request_count),
    claimedByInstanceId: row.claimed_by_instance_id,
    failureJson: row.failure_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preparedAt: row.prepared_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}

function parseStatus(value: string): ExecutionHostHandoffStatus {
  if (value === 'draining' || value === 'prepared' || value === 'claimed' || value === 'completed' || value === 'recovery_required' || value === 'aborted') return value;
  throw new Error(`Execution Host 交接状态非法：${value}`);
}

function assertCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Execution Host 交接计数非法：${String(value)}`);
  return value;
}

function assertSingleCasChange(db: ZeusDatabasePort, conversationId: string | null, step: string): void {
  const count = db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0;
  if (count !== 1) {
    throw Object.assign(new Error(`Execution Host 交接 CAS 未命中唯一记录：${step}`), {
      code: 'ZEUS_EXECUTION_HOST_HANDOFF_CAS_UPDATE_MISMATCH',
      conversationId,
      step,
    });
  }
}

function isHandoffCasMismatch(error: unknown): error is Error & { conversationId: string | null; step: string } {
  return error instanceof Error && (error as { code?: unknown }).code === 'ZEUS_EXECUTION_HOST_HANDOFF_CAS_UPDATE_MISMATCH' && typeof (error as { step?: unknown }).step === 'string';
}

function handoffError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}
