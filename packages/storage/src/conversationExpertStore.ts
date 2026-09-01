import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { randomId } from './randomId.js';

export type ConversationExpertExecutionStatus = 'queued' | 'dispatching' | 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'cancelled';

export interface ConversationExpertParticipantRecord {
  id: string;
  conversationId: string;
  employeeId: string;
  employeeRevision: number;
  childConversationId: string;
  runtimeFingerprint: string;
  contextThroughSequence: number;
  identitySnapshotJson: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationExpertExecutionRecord {
  id: string;
  conversationId: string;
  submissionId: string;
  participantId: string;
  childConversationId: string;
  childSubmissionId: string | null;
  ordinal: number;
  status: ConversationExpertExecutionStatus;
  contextThroughSequence: number;
  employeeSnapshotJson: string;
  settingsSnapshotJson: string;
  answer: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ConversationExpertActorSnapshot {
  kind: 'digital_employee';
  id: string;
  name: string;
  role: string;
  domain: string;
  revision: number;
}

export interface AcceptConversationExpertRoundInput {
  conversationId: string;
  submissionId: string;
  idempotencyKey: string;
  requestHash: string;
  clientMessageId: string;
  content: string;
  displayText: string;
  input: unknown;
  createdAt: string;
  queued?: boolean;
  executions: Array<{
    id: string;
    participantId: string;
    childConversationId: string;
    ordinal: number;
    employeeSnapshot: ConversationExpertActorSnapshot & { prompt: string };
    settingsSnapshot: unknown;
  }>;
}

/** 建立会话专家参与者、专家执行与模型历史 actor 身份。 */
export function migrateConversationExpertSchema(db: ZeusDatabasePort): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_expert_participants (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      employee_id TEXT NOT NULL,
      employee_revision INTEGER NOT NULL,
      child_conversation_id TEXT NOT NULL,
      runtime_fingerprint TEXT NOT NULL,
      context_through_sequence INTEGER NOT NULL DEFAULT 0,
      identity_snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(conversation_id, employee_id),
      UNIQUE(child_conversation_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_expert_participants_room ON conversation_expert_participants(conversation_id, created_at, id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_expert_executions (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      participant_id TEXT NOT NULL,
      child_conversation_id TEXT NOT NULL,
      child_submission_id TEXT,
      ordinal INTEGER NOT NULL,
      status TEXT NOT NULL,
      context_through_sequence INTEGER NOT NULL,
      employee_snapshot_json TEXT NOT NULL,
      settings_snapshot_json TEXT NOT NULL,
      answer TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      UNIQUE(submission_id, ordinal),
      UNIQUE(submission_id, participant_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_expert_executions_room ON conversation_expert_executions(conversation_id, created_at, ordinal)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_expert_executions_active ON conversation_expert_executions(status, created_at, id)`);
  for (const statement of [
    `ALTER TABLE conversation_model_history ADD COLUMN actor_kind TEXT`,
    `ALTER TABLE conversation_model_history ADD COLUMN actor_id TEXT`,
    `ALTER TABLE conversation_model_history ADD COLUMN actor_snapshot_json TEXT`,
    `ALTER TABLE conversation_model_history ADD COLUMN expert_execution_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 新库或已经完成迁移的旧库均保持幂等。
    }
  }
}

export class ConversationExpertRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  getParticipant(conversationId: string, employeeId: string): ConversationExpertParticipantRecord | undefined {
    const row = this.db.get<ParticipantRow>(`SELECT * FROM conversation_expert_participants WHERE conversation_id = ? AND employee_id = ?`, [conversationId, employeeId]);
    return row ? mapParticipant(row) : undefined;
  }

  getParticipantByChildConversation(childConversationId: string): ConversationExpertParticipantRecord | undefined {
    const row = this.db.get<ParticipantRow>(`SELECT * FROM conversation_expert_participants WHERE child_conversation_id = ?`, [childConversationId]);
    return row ? mapParticipant(row) : undefined;
  }

  listParticipants(conversationId: string): ConversationExpertParticipantRecord[] {
    return this.db.select<ParticipantRow>(`SELECT * FROM conversation_expert_participants WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapParticipant);
  }

  ensureParticipant(input: {
    conversationId: string;
    employeeId: string;
    employeeRevision: number;
    childConversationId: string;
    runtimeFingerprint: string;
    identitySnapshot: unknown;
    updatedAt: string;
  }): ConversationExpertParticipantRecord {
    const existing = this.getParticipant(input.conversationId, input.employeeId);
    if (!existing) {
      const id = `conversation_expert_participant_${randomId(12)}`;
      this.db.execute(
        `INSERT INTO conversation_expert_participants
         (id, conversation_id, employee_id, employee_revision, child_conversation_id, runtime_fingerprint,
          context_through_sequence, identity_snapshot_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [id, input.conversationId, input.employeeId, input.employeeRevision, input.childConversationId, input.runtimeFingerprint, JSON.stringify(input.identitySnapshot), input.updatedAt, input.updatedAt],
      );
      return this.getParticipant(input.conversationId, input.employeeId)!;
    }
    if (existing.runtimeFingerprint === input.runtimeFingerprint && existing.employeeRevision === input.employeeRevision) return existing;
    this.db.execute(
      `UPDATE conversation_expert_participants
          SET employee_revision = ?, child_conversation_id = ?, runtime_fingerprint = ?, context_through_sequence = 0,
              identity_snapshot_json = ?, updated_at = ?
        WHERE id = ?`,
      [input.employeeRevision, input.childConversationId, input.runtimeFingerprint, JSON.stringify(input.identitySnapshot), input.updatedAt, existing.id],
    );
    return this.getParticipant(input.conversationId, input.employeeId)!;
  }

  updateParticipantContext(participantId: string, throughSequence: number, updatedAt: string): void {
    this.db.execute(
      `UPDATE conversation_expert_participants
          SET context_through_sequence = CASE WHEN context_through_sequence < ? THEN ? ELSE context_through_sequence END,
              updated_at = ?
        WHERE id = ?`,
      [throughSequence, throughSequence, updatedAt, participantId],
    );
  }

  currentModelHistorySequence(conversationId: string): number {
    return this.db.get<{ sequence: number | null }>(`SELECT MAX(sequence) AS sequence FROM conversation_model_history WHERE conversation_id = ?`, [conversationId])?.sequence ?? 0;
  }

  modelHistoryForExpertContext(input: { conversationId: string; employeeId: string; afterSequence: number; throughSequence: number; currentSubmissionId: string }): Array<{
    sequence: number;
    role: 'user' | 'assistant' | 'tool';
    content: unknown;
    segmentId: string;
  }> {
    return this.db
      .select<{ sequence: number; role: string; content_json: string; segment_id: string; actor_kind: string | null; actor_id: string | null; submission_id: string | null }>(
        `SELECT history.sequence, history.role, history.content_json, history.segment_id,
                history.actor_kind, history.actor_id, history.submission_id
           FROM conversation_model_history AS history
           LEFT JOIN conversation_submissions AS history_submission ON history_submission.id = history.submission_id
           JOIN conversation_submissions AS current_submission ON current_submission.id = ?
          WHERE history.conversation_id = ? AND history.sequence > ? AND history.sequence <= ?
            AND (history.submission_id IS NULL OR history_submission.timeline_sequence <= current_submission.timeline_sequence)
            AND NOT (history.actor_kind = 'digital_employee' AND history.actor_id = ?)
            AND NOT (history.role = 'user' AND history.submission_id = ?)
          ORDER BY history.sequence`,
        [input.currentSubmissionId, input.conversationId, input.afterSequence, input.throughSequence, input.employeeId, input.currentSubmissionId],
      )
      .flatMap((row) => {
        if (row.role !== 'user' && row.role !== 'assistant' && row.role !== 'tool') return [];
        return [{ sequence: row.sequence, role: row.role, content: parseJson(row.content_json), segmentId: row.segment_id }];
      });
  }

  acceptRound(input: AcceptConversationExpertRoundInput): { submissionId: string; turnId: string; segmentId: string; userSequence: number; executions: ConversationExpertExecutionRecord[] } {
    const existing = this.db.get<{ id: string; request_hash: string }>(`SELECT id, request_hash FROM conversation_submissions WHERE conversation_id = ? AND idempotency_key = ?`, [input.conversationId, input.idempotencyKey]);
    if (existing) {
      if (existing.id !== input.submissionId || existing.request_hash !== input.requestHash) throw expertStoreError('ZEUS_EXPERT_ROUND_IDEMPOTENCY_CONFLICT', '专家轮次幂等身份与既有提交冲突。');
      const execution = this.listExecutionsBySubmission(existing.id);
      const turn = this.db.get<{ id: string }>(`SELECT id FROM conversation_turns WHERE client_submission_id = ? ORDER BY created_at, id LIMIT 1`, [existing.id]);
      const user = this.db.get<{ sequence: number; segment_id: string }>(`SELECT sequence, segment_id FROM conversation_model_history WHERE submission_id = ? AND role = 'user' ORDER BY sequence LIMIT 1`, [existing.id]);
      if (!turn || !user) throw expertStoreError('ZEUS_EXPERT_ROUND_DURABILITY_INCOMPLETE', '既有专家轮次缺少持久接纳证据。');
      return { submissionId: existing.id, turnId: turn.id, segmentId: user.segment_id, userSequence: user.sequence, executions: execution };
    }
    return this.db.transaction(() => {
      this.ensureSequenceCounter(input.conversationId);
      const turnId = `conversation_expert_round_turn_${randomId(12)}`;
      const segmentId = `conversation_expert_round_segment_${randomId(12)}`;
      const submissionStatus = input.queued ? 'queued' : 'active';
      const turnStatus = input.queued ? 'queued' : 'running';
      const queuePosition = input.queued
        ? (this.db.get<{ position: number | null }>(
            `SELECT MAX(queue_position) AS position
               FROM conversation_submissions
              WHERE conversation_id = ? AND status IN ('queued', 'paused', 'failed')`,
            [input.conversationId],
          )?.position ?? 0) + 1
        : null;
      const timelineSequence = this.nextSequence(input.conversationId, 'timeline_sequence');
      const userSequence = this.nextSequence(input.conversationId, 'model_history_sequence');
      this.db.execute(
        `INSERT INTO conversation_runtime_segments
         (id, conversation_id, runtime_kind, state, execution_snapshot_id, provider_id, native_session_id, native_session_path,
          provider_model, provider_protocol_version, provider_binary_version, provisional_for_submission_id, opened_at, accepted_at,
          sealed_at, seal_reason, created_at, updated_at)
         VALUES (?, ?, 'codex', 'sealed', NULL, 'zeus-expert-router', NULL, NULL, NULL, 'internal', NULL, NULL, ?, ?, ?, 'expert_round_projection', ?, ?)`,
        [segmentId, input.conversationId, input.createdAt, input.createdAt, input.createdAt, input.createdAt, input.createdAt],
      );
      this.db.execute(
        `INSERT INTO conversation_submissions
         (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, queue_position,
          input_json, target_provider_turn_id, provider_turn_id, paused_reason, error_json, created_at, updated_at, dispatched_at,
          resolved_at, replacement_of_submission_id, replacement_reason, execution_snapshot_id, submission_outcome, accepted_at,
          timeline_sequence, model_history_sequence, segment_id)
         VALUES (?, ?, ?, ?, ?, 'message', 'queue', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL, NULL,
                 'accepted', ?, ?, ?, ?)`,
        [
          input.submissionId,
          input.conversationId,
          input.idempotencyKey,
          input.requestHash,
          input.clientMessageId,
          submissionStatus,
          queuePosition,
          JSON.stringify(input.input),
          input.createdAt,
          input.createdAt,
          input.queued ? null : input.createdAt,
          input.createdAt,
          timelineSequence,
          userSequence,
          segmentId,
        ],
      );
      this.db.execute(
        `INSERT INTO conversation_turns
         (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, error_json, plan_json,
          started_at, completed_at, created_at, updated_at, agent_kind, native_run_id)
         VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL, ?, NULL, ?, ?, 'codex', ?)`,
        [turnId, input.conversationId, `expert-room:${input.conversationId}`, input.submissionId, turnStatus, input.queued ? null : input.createdAt, input.createdAt, input.createdAt, input.submissionId],
      );
      this.db.execute(
        `INSERT INTO conversation_timeline_events
         (id, conversation_id, sequence, event_kind, turn_id, submission_id, segment_id, payload_json, occurred_at)
         VALUES (?, ?, ?, 'expert_round_accepted', ?, ?, ?, ?, ?)`,
        [`conversation_timeline_event_${randomId(12)}`, input.conversationId, timelineSequence, turnId, input.submissionId, segmentId, JSON.stringify({ expertCount: input.executions.length }), input.createdAt],
      );
      this.db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json, reasoning_source_json,
          tool_pair_id, capability_loss_json, confirmed_at, actor_kind, actor_id, actor_snapshot_json, expert_execution_id)
         VALUES (?, ?, ?, ?, ?, ?, 'user', ?, NULL, NULL, NULL, ?, 'user', NULL, NULL, NULL)`,
        [
          `conversation_model_history_${randomId(12)}`,
          input.conversationId,
          userSequence,
          turnId,
          input.submissionId,
          segmentId,
          JSON.stringify({ text: input.content, ...(input.displayText !== input.content ? { displayText: input.displayText } : {}) }),
          input.createdAt,
        ],
      );
      this.db.execute(
        `INSERT INTO conversation_messages
         (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, 'user', ?, 'expert_group_user', ?, ?, NULL, NULL, NULL, ?)`,
        [`conversation_message_${randomId(12)}`, input.conversationId, input.displayText, JSON.stringify({ submissionId: input.submissionId, expertRound: true }), input.createdAt, input.clientMessageId],
      );
      for (const execution of input.executions) {
        this.db.execute(
          `INSERT INTO conversation_expert_executions
           (id, conversation_id, submission_id, participant_id, child_conversation_id, child_submission_id, ordinal, status,
            context_through_sequence, employee_snapshot_json, settings_snapshot_json, answer, error_json, created_at, updated_at,
            started_at, completed_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?, 'queued', ?, ?, ?, NULL, NULL, ?, ?, NULL, NULL)`,
          [
            execution.id,
            input.conversationId,
            input.submissionId,
            execution.participantId,
            execution.childConversationId,
            execution.ordinal,
            userSequence,
            JSON.stringify(execution.employeeSnapshot),
            JSON.stringify(execution.settingsSnapshot),
            input.createdAt,
            input.createdAt,
          ],
        );
      }
      this.db.execute(`UPDATE conversations SET status = 'open', stage = 'running', stage_updated_at = ?, updated_at = ? WHERE id = ?`, [input.createdAt, input.createdAt, input.conversationId]);
      return { submissionId: input.submissionId, turnId, segmentId, userSequence, executions: this.listExecutionsBySubmission(input.submissionId) };
    });
  }

  listExecutionsBySubmission(submissionId: string): ConversationExpertExecutionRecord[] {
    return this.db.select<ExecutionRow>(`SELECT * FROM conversation_expert_executions WHERE submission_id = ? ORDER BY ordinal`, [submissionId]).map(mapExecution);
  }

  getExecution(executionId: string): ConversationExpertExecutionRecord | undefined {
    const row = this.db.get<ExecutionRow>(`SELECT * FROM conversation_expert_executions WHERE id = ?`, [executionId]);
    return row ? mapExecution(row) : undefined;
  }

  getActiveExecutionByChildConversation(childConversationId: string): ConversationExpertExecutionRecord | undefined {
    const row = this.db.get<ExecutionRow>(
      `SELECT * FROM conversation_expert_executions
        WHERE child_conversation_id = ? AND status IN ('dispatching', 'running', 'waiting')
        ORDER BY created_at DESC, ordinal DESC, id DESC LIMIT 1`,
      [childConversationId],
    );
    return row ? mapExecution(row) : undefined;
  }

  listActiveExecutions(): ConversationExpertExecutionRecord[] {
    return this.db.select<ExecutionRow>(`SELECT * FROM conversation_expert_executions WHERE status IN ('queued', 'dispatching', 'running', 'waiting') ORDER BY created_at, ordinal, id`).map(mapExecution);
  }

  hasExecutingRound(conversationId: string): boolean {
    return Boolean(
      this.db.get<{ present: number }>(
        `SELECT 1 AS present
           FROM conversation_expert_executions AS execution
           JOIN conversation_submissions AS submission ON submission.id = execution.submission_id
          WHERE execution.conversation_id = ?
            AND submission.status = 'active'
            AND execution.status IN ('queued', 'dispatching', 'running', 'waiting')
          LIMIT 1`,
        [conversationId],
      ),
    );
  }

  activateRound(submissionId: string, updatedAt: string): ConversationExpertExecutionRecord[] | null {
    return this.db.transaction(() => {
      const submission = this.db.get<{ conversation_id: string; status: string; timeline_sequence: number }>(`SELECT conversation_id, status, timeline_sequence FROM conversation_submissions WHERE id = ?`, [submissionId]);
      if (!submission) throw expertStoreError('ZEUS_EXPERT_ROUND_NOT_FOUND', '专家轮次不存在。');
      if (submission.status !== 'queued' && submission.status !== 'active') return null;
      const earlier = this.db.get<{ present: number }>(
        `SELECT 1 AS present
           FROM conversation_expert_executions AS execution
           JOIN conversation_submissions AS candidate ON candidate.id = execution.submission_id
          WHERE execution.conversation_id = ?
            AND candidate.timeline_sequence < ?
            AND execution.status IN ('queued', 'dispatching', 'running', 'waiting')
          LIMIT 1`,
        [submission.conversation_id, submission.timeline_sequence],
      );
      if (earlier) return null;
      if (submission.status === 'queued') {
        const contextThroughSequence = this.currentModelHistorySequence(submission.conversation_id);
        this.db.execute(
          `UPDATE conversation_expert_executions
              SET context_through_sequence = ?, updated_at = ?
            WHERE submission_id = ? AND status = 'queued' AND child_submission_id IS NULL`,
          [contextThroughSequence, updatedAt, submissionId],
        );
        this.db.execute(
          `UPDATE conversation_submissions
              SET status = 'active', dispatched_at = COALESCE(dispatched_at, ?), updated_at = ?
            WHERE id = ?`,
          [updatedAt, updatedAt, submissionId],
        );
        this.db.execute(
          `UPDATE conversation_turns
              SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
            WHERE client_submission_id = ? AND provider_turn_id IS NULL`,
          [updatedAt, updatedAt, submissionId],
        );
      }
      return this.listExecutionsBySubmission(submissionId);
    });
  }

  setExecutionStatus(input: { executionId: string; status: ConversationExpertExecutionStatus; updatedAt: string; childSubmissionId?: string | null; answer?: string | null; error?: unknown }): ConversationExpertExecutionRecord {
    const startedAt = input.status === 'dispatching' || input.status === 'running' || input.status === 'waiting' ? input.updatedAt : null;
    const completedAt = ['completed', 'failed', 'interrupted', 'cancelled'].includes(input.status) ? input.updatedAt : null;
    this.db.execute(
      `UPDATE conversation_expert_executions
          SET status = ?, child_submission_id = COALESCE(?, child_submission_id), answer = COALESCE(?, answer),
              error_json = ?, updated_at = ?, started_at = COALESCE(started_at, ?), completed_at = COALESCE(completed_at, ?)
        WHERE id = ?`,
      [input.status, input.childSubmissionId ?? null, input.answer ?? null, input.error === undefined ? null : JSON.stringify(input.error), input.updatedAt, startedAt, completedAt, input.executionId],
    );
    const row = this.db.get<ExecutionRow>(`SELECT * FROM conversation_expert_executions WHERE id = ?`, [input.executionId]);
    if (!row) throw expertStoreError('ZEUS_EXPERT_EXECUTION_NOT_FOUND', '专家执行不存在。');
    return mapExecution(row);
  }

  appendExpertAnswer(input: { executionId: string; answer: string; completedAt: string }): ConversationExpertExecutionRecord {
    return this.db.transaction(() => {
      const executionRow = this.db.get<ExecutionRow>(`SELECT * FROM conversation_expert_executions WHERE id = ?`, [input.executionId]);
      if (!executionRow) throw expertStoreError('ZEUS_EXPERT_EXECUTION_NOT_FOUND', '专家执行不存在。');
      const execution = mapExecution(executionRow);
      if (['completed', 'failed', 'interrupted', 'cancelled'].includes(execution.status)) return execution;
      const completed = this.setExecutionStatus({ executionId: execution.id, status: 'completed', updatedAt: input.completedAt, answer: input.answer });
      this.finishRoundIfTerminal(execution.submissionId, input.completedAt);
      return completed;
    });
  }

  retryExecution(executionId: string, updatedAt: string, queued = false): ConversationExpertExecutionRecord {
    return this.db.transaction(() => {
      const execution = this.getExecution(executionId);
      if (!execution) throw expertStoreError('ZEUS_EXPERT_EXECUTION_NOT_FOUND', '专家执行不存在。');
      if (execution.status !== 'failed') throw expertStoreError('ZEUS_EXPERT_EXECUTION_NOT_RETRYABLE', '只有失败的专家位置可以单独重试。');
      this.db.execute(
        `UPDATE conversation_expert_executions
            SET status = 'queued', child_submission_id = NULL, answer = NULL, error_json = NULL,
                updated_at = ?, started_at = NULL, completed_at = NULL
          WHERE id = ?`,
        [updatedAt, executionId],
      );
      this.db.execute(`DELETE FROM conversation_model_history WHERE expert_execution_id = ?`, [executionId]);
      this.db.execute(`DELETE FROM conversation_messages WHERE conversation_id = ? AND provider_item_id = ? AND source = 'expert_group_answer'`, [execution.conversationId, executionId]);
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = ?, queue_position = ?, submission_outcome = 'accepted', resolved_at = NULL, error_json = NULL,
                dispatched_at = ?, updated_at = ?
          WHERE id = ?`,
        [
          queued ? 'queued' : 'active',
          queued
            ? (this.db.get<{ position: number | null }>(
                `SELECT MAX(queue_position) AS position
                   FROM conversation_submissions
                  WHERE conversation_id = ? AND status IN ('queued', 'paused', 'failed')`,
                [execution.conversationId],
              )?.position ?? 0) + 1
            : null,
          queued ? null : updatedAt,
          updatedAt,
          execution.submissionId,
        ],
      );
      this.db.execute(
        `UPDATE conversation_turns
            SET status = ?, started_at = ?, completed_at = NULL, error_json = NULL, updated_at = ?
          WHERE client_submission_id = ? AND provider_turn_id IS NULL`,
        [queued ? 'queued' : 'running', queued ? null : updatedAt, updatedAt, execution.submissionId],
      );
      this.db.execute(`UPDATE conversations SET stage = 'running', stage_updated_at = ?, updated_at = ? WHERE id = ?`, [updatedAt, updatedAt, execution.conversationId]);
      return this.getExecution(executionId)!;
    });
  }

  finishRoundIfTerminal(submissionId: string, updatedAt: string): void {
    const remaining = this.db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM conversation_expert_executions WHERE submission_id = ? AND status NOT IN ('completed', 'failed', 'interrupted', 'cancelled')`, [submissionId])?.count ?? 0;
    if (remaining > 0) return;
    const submission = this.db.get<{ conversation_id: string }>(`SELECT conversation_id FROM conversation_submissions WHERE id = ?`, [submissionId]);
    if (!submission) return;
    this.projectTerminalExecutions(submissionId);
    this.db.execute(`UPDATE conversation_submissions SET status = 'completed', submission_outcome = 'terminal', resolved_at = ?, updated_at = ? WHERE id = ?`, [updatedAt, updatedAt, submissionId]);
    this.db.execute(`UPDATE conversation_turns SET status = 'completed', completed_at = ?, updated_at = ? WHERE client_submission_id = ? AND provider_turn_id IS NULL`, [updatedAt, updatedAt, submissionId]);
    const pendingRound = this.db.get<{ present: number }>(
      `SELECT 1 AS present
         FROM conversation_expert_executions
        WHERE conversation_id = ? AND status IN ('queued', 'dispatching', 'running', 'waiting')
        LIMIT 1`,
      [submission.conversation_id],
    );
    this.db.execute(`UPDATE conversations SET stage = ?, stage_updated_at = ?, updated_at = ? WHERE id = ?`, [pendingRound ? 'running' : 'completed', updatedAt, updatedAt, submission.conversation_id]);
  }

  private projectTerminalExecutions(submissionId: string): void {
    const turn = this.db.get<{ id: string }>(`SELECT id FROM conversation_turns WHERE client_submission_id = ? ORDER BY created_at, id LIMIT 1`, [submissionId]);
    const userHistory = this.db.get<{ segment_id: string }>(`SELECT segment_id FROM conversation_model_history WHERE submission_id = ? AND role = 'user' ORDER BY sequence LIMIT 1`, [submissionId]);
    if (!turn || !userHistory) throw expertStoreError('ZEUS_EXPERT_ROUND_DURABILITY_INCOMPLETE', '专家轮次缺少父会话历史身份。');
    for (const execution of this.listExecutionsBySubmission(submissionId)) {
      if (this.db.get<{ id: string }>(`SELECT id FROM conversation_model_history WHERE expert_execution_id = ? LIMIT 1`, [execution.id])) continue;
      const actor = parseJson(execution.employeeSnapshotJson) as ConversationExpertActorSnapshot;
      const error = execution.errorJson ? parseJson(execution.errorJson) : null;
      const text = execution.answer ?? (execution.status === 'interrupted' || execution.status === 'cancelled' ? '本轮专家执行已停止。' : `专家执行失败：${errorMessage(error)}`);
      const confirmedAt = execution.completedAt ?? execution.updatedAt;
      const sequence = this.nextSequence(execution.conversationId, 'model_history_sequence');
      this.db.execute(
        `INSERT INTO conversation_model_history
         (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json, reasoning_source_json,
          tool_pair_id, capability_loss_json, confirmed_at, actor_kind, actor_id, actor_snapshot_json, expert_execution_id)
         VALUES (?, ?, ?, ?, ?, ?, 'assistant', ?, NULL, NULL, NULL, ?, 'digital_employee', ?, ?, ?)`,
        [
          `conversation_model_history_${randomId(12)}`,
          execution.conversationId,
          sequence,
          turn.id,
          execution.submissionId,
          userHistory.segment_id,
          JSON.stringify({ text, phase: 'final_answer', expertStatus: execution.status }),
          confirmedAt,
          actor.id,
          execution.employeeSnapshotJson,
          execution.id,
        ],
      );
      this.db.execute(
        `INSERT INTO conversation_messages
         (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, 'assistant', ?, 'expert_group_answer', ?, ?, NULL, NULL, ?, NULL)`,
        [
          `conversation_message_${randomId(12)}`,
          execution.conversationId,
          text,
          JSON.stringify({ actor, expertExecutionId: execution.id, ordinal: execution.ordinal, status: execution.status, ...(error ? { error } : {}) }),
          confirmedAt,
          execution.id,
        ],
      );
    }
  }

  runtimeFingerprint(input: { employeeRevision: number; model: string; modelSourceId: string | null; pluginReferences: unknown; skillReferences: unknown }): string {
    return createHash('sha256').update(JSON.stringify(input)).digest('hex');
  }

  private ensureSequenceCounter(conversationId: string): void {
    this.db.execute(
      `INSERT INTO conversation_sequence_counters
       (conversation_id, timeline_sequence, model_history_sequence, process_sequence, model_request_sequence, sync_event_sequence)
       VALUES (?, 0, 0, 0, 0, 0)
       ON CONFLICT(conversation_id) DO NOTHING`,
      [conversationId],
    );
  }

  private nextSequence(conversationId: string, column: 'timeline_sequence' | 'model_history_sequence'): number {
    this.ensureSequenceCounter(conversationId);
    this.db.execute(`UPDATE conversation_sequence_counters SET ${column} = ${column} + 1 WHERE conversation_id = ?`, [conversationId]);
    const row = this.db.get<Record<string, number>>(`SELECT ${column} FROM conversation_sequence_counters WHERE conversation_id = ?`, [conversationId]);
    return row?.[column] ?? 1;
  }
}

interface ParticipantRow {
  id: string;
  conversation_id: string;
  employee_id: string;
  employee_revision: number;
  child_conversation_id: string;
  runtime_fingerprint: string;
  context_through_sequence: number;
  identity_snapshot_json: string;
  created_at: string;
  updated_at: string;
}

interface ExecutionRow {
  id: string;
  conversation_id: string;
  submission_id: string;
  participant_id: string;
  child_conversation_id: string;
  child_submission_id: string | null;
  ordinal: number;
  status: ConversationExpertExecutionStatus;
  context_through_sequence: number;
  employee_snapshot_json: string;
  settings_snapshot_json: string;
  answer: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

function mapParticipant(row: ParticipantRow): ConversationExpertParticipantRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    employeeId: row.employee_id,
    employeeRevision: row.employee_revision,
    childConversationId: row.child_conversation_id,
    runtimeFingerprint: row.runtime_fingerprint,
    contextThroughSequence: row.context_through_sequence,
    identitySnapshotJson: row.identity_snapshot_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapExecution(row: ExecutionRow): ConversationExpertExecutionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    submissionId: row.submission_id,
    participantId: row.participant_id,
    childConversationId: row.child_conversation_id,
    childSubmissionId: row.child_submission_id,
    ordinal: row.ordinal,
    status: row.status,
    contextThroughSequence: row.context_through_sequence,
    employeeSnapshotJson: row.employee_snapshot_json,
    settingsSnapshotJson: row.settings_snapshot_json,
    answer: row.answer,
    errorJson: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { text: value };
  }
}

function errorMessage(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string' && value.message.trim()) return value.message.trim();
  return '未知错误';
}

function expertStoreError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
