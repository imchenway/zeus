import { createHash, randomUUID } from 'node:crypto';
import type { InputSuggestionResult } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

/** 自动建议任务表的迁移身份，不改变原会话数据。 */
const migrationId = '20261114_input_suggestions';
/** 有用户要求的轮次参与预测；独立压缩等内部轮次不替代用户回复。 */
export const inputSuggestionUserTurnSql = `(client_submission_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM conversation_model_history AS user_history
  WHERE user_history.conversation_id = conversation_turns.conversation_id
    AND user_history.turn_id = conversation_turns.id AND user_history.role = 'user'
))`;

/** 每行表示一个已完成回复的自动建议任务，身份与归属由原轮次提供。 */
export interface InputSuggestionJob {
  /** 原轮次主键，同时是任务的唯一身份。 */
  turnId: string;
  /** 通过原轮次读取的会话身份。 */
  conversationId: string;
  /** 通过会话读取的项目身份，不另存可冲突的归属副本。 */
  projectId: string;
  /** 本次建议的模型配置身份。 */
  modelKey: string | null;
  /** 当前实际使用的建议模型，无法解析时为空。 */
  modelRef: string | null;
  /** 任务当前状态。 */
  state: 'pending' | 'running' | 'ready' | 'blocked' | 'cancelled';
  /** 已领取的生成尝试次数。 */
  attemptCount: number;
  /** 当前领取身份，结束后为空，迟到回执不得覆盖新尝试。 */
  attemptId: string | null;
  /** 下一次允许领取的 UTC 时刻。 */
  nextAttemptAt: string;
  /** 原生成通路的完整回执快照，尚未生成时为空。 */
  result: InputSuggestionResult | null;
}

/** SQLite 行沿用数据库字段名，转换后才进入领域层。 */
interface JobRow {
  turn_id: string;
  conversation_id: string;
  project_id: string;
  model_key: string | null;
  model_ref: string | null;
  state: InputSuggestionJob['state'];
  attempt_count: number;
  attempt_id: string | null;
  next_attempt_at: string;
  result_json: string | null;
}

/** 新增任务表及真实查询索引；旧数据与旧结构不变。 */
export function migrateInputSuggestionSchema(db: ZeusDatabasePort): void {
  /** 字段注释保留在 SQLite 的建表定义中。 */
  const schema = `CREATE TABLE IF NOT EXISTS input_suggestion_jobs (
    -- 原回复轮次主键；会话、项目通过轮次关联读取。
    turn_id TEXT PRIMARY KEY NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
    -- 建议模型、推理深度及速度的配置身份；尚未解析时为空，不含秘密。
    model_key TEXT,
    -- 当前实际模型身份；模型尚不可用时为空。
    model_ref TEXT,
    -- 待生成、生成中、成功、配置阻塞或明确取消。
    state TEXT NOT NULL CHECK(state IN ('pending','running','ready','blocked','cancelled')),
    -- 已领取的尝试次数，单位：次。
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    -- 当前领取身份；未运行时为空。
    attempt_id TEXT,
    -- 下一次可尝试时间，UTC ISO 8601。
    next_attempt_at TEXT NOT NULL,
    -- 完整生成回执快照；未生成时为空，不保存草稿或凭证。
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
    -- 首次登记与最后变化时间，UTC ISO 8601。
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK(state <> 'ready' OR (model_key IS NOT NULL AND model_ref IS NOT NULL AND json_type(result_json, '$.text') IS 'text' AND length(trim(json_extract(result_json, '$.text'))) > 0)),
    CHECK((state = 'running') = (attempt_id IS NOT NULL))
  )`;
  /** 迁移校验覆盖实际表定义。 */
  const checksum = `sha256:${createHash('sha256').update(schema).digest('hex')}`;
  db.transaction(() => {
    const previous = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [migrationId]);
    if (previous && previous.checksum !== checksum) throw new Error('输入建议任务迁移定义与账本不一致。');
    db.execute(schema);
    db.execute("CREATE INDEX IF NOT EXISTS idx_input_suggestion_due ON input_suggestion_jobs(next_attempt_at, turn_id) WHERE state = 'pending'");
    const now = new Date().toISOString();
    db.execute('INSERT OR IGNORE INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [migrationId, '自动输入建议按回复轮次保存持久任务', checksum, now]);
  });
}

/** 与完成轮次共用调用方事务登记待办，事件丢失也不会漏掉任务。 */
export function captureCompletedInputSuggestion(db: ZeusDatabasePort, turnId: string, now: string): void {
  db.execute(
    `INSERT INTO input_suggestion_jobs
    (turn_id, model_key, model_ref, state, attempt_count, attempt_id, next_attempt_at, result_json, created_at, updated_at)
    SELECT id, NULL, NULL, 'pending', 0, NULL, ?, NULL, ?, ? FROM conversation_turns
    WHERE id=? AND status='completed' AND ${inputSuggestionUserTurnSql}
      AND EXISTS (SELECT 1 FROM conversations WHERE id=conversation_turns.conversation_id AND archived=0)
      AND EXISTS (SELECT 1 FROM settings WHERE key='app.shell.settings'
        AND CASE WHEN json_valid(value_json) THEN json_extract(value_json,'$.inputSuggestions.enabled') END=1)
    ON CONFLICT(turn_id) DO NOTHING`,
    [now, now, now, turnId],
  );
}

/** 持久任务的领取与回执均使用原有耐久事务。 */
export class InputSuggestionJobRepository {
  /** 数据库端口只暴露本任务所需的事务和查询。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 只取当前用户轮次，压缩轮次不会使已有建议过期。 */
  latestTurn(conversationId: string): { id: string; status: string } | undefined {
    return this.db.get(`SELECT id, status FROM conversation_turns WHERE conversation_id = ? AND ${inputSuggestionUserTurnSql} ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
  }

  /** 完成轮次幂等入队；配置变化只重建尚未被用户取消的任务。 */
  enqueue(turnId: string, modelKey: string, modelRef: string | null, now: string): void {
    this.db.commitCriticalFactSync(() =>
      this.db.execute(
        `INSERT INTO input_suggestion_jobs
      (turn_id, model_key, model_ref, state, attempt_count, attempt_id, next_attempt_at, result_json, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, NULL, ?, NULL, ?, ?)
      ON CONFLICT(turn_id) DO UPDATE SET model_key=excluded.model_key, model_ref=excluded.model_ref, state='pending',
        attempt_count=0, attempt_id=NULL, next_attempt_at=excluded.next_attempt_at, result_json=NULL, updated_at=excluded.updated_at
      WHERE input_suggestion_jobs.state <> 'cancelled' AND
        (input_suggestion_jobs.model_key IS NOT excluded.model_key OR input_suggestion_jobs.model_ref IS NOT excluded.model_ref)`,
        [turnId, modelKey, modelRef, now, now, now],
      ),
    );
  }

  /** 查询始终通过原轮次和会话关联取得项目归属。 */
  get(turnId: string): InputSuggestionJob | null {
    const row = this.db.get<JobRow>(
      `SELECT job.*, turn.conversation_id, conversation.project_id FROM input_suggestion_jobs AS job
      JOIN conversation_turns AS turn ON turn.id=job.turn_id JOIN conversations AS conversation ON conversation.id=turn.conversation_id WHERE job.turn_id=?`,
      [turnId],
    );
    return row ? this.map(row) : null;
  }

  /** 当前会话只读取最新用户轮次的候选，绝不回退到旧要求。 */
  current(conversationId: string): InputSuggestionJob | null {
    const turn = this.latestTurn(conversationId);
    return turn ? this.get(turn.id) : null;
  }

  /** 串行宿主内通过耐久事务领取，随机身份隔离迟到回执。 */
  claim(now: string, activeTurnIds: readonly string[]): InputSuggestionJob | null {
    const exclusion = activeTurnIds.length ? `AND turn_id NOT IN (${activeTurnIds.map(() => '?').join(',')})` : '';
    const row = this.db.get<{ turn_id: string }>(`SELECT turn_id FROM input_suggestion_jobs WHERE state='pending' AND next_attempt_at<=? ${exclusion} ORDER BY next_attempt_at, turn_id LIMIT 1`, [now, ...activeTurnIds]);
    if (!row) return null;
    return this.db.commitCriticalFactSync(() => {
      const attemptId = randomUUID();
      this.db.execute("UPDATE input_suggestion_jobs SET state='running', attempt_count=attempt_count+1, attempt_id=?, updated_at=? WHERE turn_id=? AND state='pending' AND next_attempt_at<=?", [attemptId, now, row.turn_id, now]);
      const claimed = this.get(row.turn_id);
      return claimed?.attemptId === attemptId ? claimed : null;
    });
  }

  /** 只收口本次领取；配置重建、取消和新尝试均使旧回执失效。 */
  finish(job: InputSuggestionJob, result: InputSuggestionResult, state: InputSuggestionJob['state'], nextAttemptAt: string, now: string): void {
    this.db.commitCriticalFactSync(() =>
      this.db.execute(
        `UPDATE input_suggestion_jobs SET state=?, result_json=?, next_attempt_at=?, attempt_id=NULL, updated_at=?
      WHERE turn_id=? AND state='running' AND attempt_id=?`,
        [state, JSON.stringify(result), nextAttemptAt, now, job.turnId, job.attemptId],
      ),
    );
  }

  /** 离线中断后恢复待办；已经开始的尝试保留计数，等待本身不增加次数。 */
  pause(job: InputSuggestionJob, now: string): void {
    this.db.commitCriticalFactSync(() =>
      this.db.execute("UPDATE input_suggestion_jobs SET state='pending', attempt_id=NULL, next_attempt_at=?, updated_at=? WHERE turn_id=? AND state='running' AND attempt_id=?", [now, now, job.turnId, job.attemptId]),
    );
  }

  /** 新要求或明确取消使原候选失效；恢复时不会复活同一轮。 */
  cancel(conversationId: string, now: string, turnId?: string): void {
    this.db.commitCriticalFactSync(() =>
      this.db.execute(
        `UPDATE input_suggestion_jobs SET state='cancelled', result_json=NULL, attempt_id=NULL, updated_at=?
      WHERE turn_id IN (SELECT id FROM conversation_turns WHERE conversation_id=?) ${turnId ? 'AND turn_id=?' : ''} AND state<>'cancelled'`,
        [now, conversationId, ...(turnId ? [turnId] : [])],
      ),
    );
  }

  /** 宿主独占同一数据根，启动时把未收到回执的领取恢复为待生成。 */
  recover(now: string): void {
    this.db.commitCriticalFactSync(() => this.db.execute("UPDATE input_suggestion_jobs SET state='pending', attempt_id=NULL, next_attempt_at=?, updated_at=? WHERE state IN ('running','blocked')", [now, now]));
  }

  /** 用户更新模型配置或凭证后重新尝试明确阻塞的任务。 */
  retryBlocked(now: string): void {
    this.db.commitCriticalFactSync(() => this.db.execute("UPDATE input_suggestion_jobs SET state='pending', next_attempt_at=?, updated_at=? WHERE state='blocked'", [now, now]));
  }

  /** JSON 字段是由同一生成服务写入的回执快照，不解析用户草稿。 */
  private map(row: JobRow): InputSuggestionJob {
    return {
      turnId: row.turn_id,
      conversationId: row.conversation_id,
      projectId: row.project_id,
      modelKey: row.model_key,
      modelRef: row.model_ref,
      state: row.state,
      attemptCount: row.attempt_count,
      attemptId: row.attempt_id,
      nextAttemptAt: row.next_attempt_at,
      result: row.result_json ? (JSON.parse(row.result_json) as InputSuggestionResult) : null,
    };
  }
}
