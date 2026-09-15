import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { randomId } from './randomId.js';
import { TaskWorkStoreError, TaskWorkDeliverableRepository } from './taskWorkStore.js';
import type { TaskWorkDeploymentReceipt } from './taskWorkDeploymentStore.js';

/** 审查意见永远绑定一份冻结成果及具体引用位置。 */
export interface TaskWorkReviewNote {
  /** 原始意见身份。 */
  id: string;
  /** 被审查的固定成果身份。 */
  deliverableId: string;
  /** 创建意见时的内容摘要。 */
  contentSha256: string;
  /** 正文标题、文件或行号等定位文字。 */
  anchor: string;
  /** 问题与修改建议。 */
  content: string;
  /** 阻塞项必须处理后才能验收。 */
  blocking: boolean;
  /** 解决状态不删除原始意见。 */
  status: 'open' | 'resolved';
  /** 修订用于避免并发覆盖。 */
  revision: number;
  /** 首次提出时间。 */
  createdAt: string;
  /** 最后处理时间。 */
  updatedAt: string;
}

/** 冻结证据索引；正文仍由原交付物资产存储持有。 */
export interface TaskWorkDeliverableBundle {
  /** 具有真实来源的成果种类。 */
  availableKinds: Array<'document' | 'code' | 'verification' | 'deployment'>;
  /** 冻结的代码变更与运行证据身份。 */
  sources: Array<{ kind: 'message' | 'change_set' | 'command' | 'deployment'; id: string; sha256: string; status: string; command?: string }>;
  /** 部署结构化声明和来源命令随成果一起冻结。 */
  deployments?: TaskWorkDeploymentReceipt[];
  /** 缺失或无法完整读取的证据，不能当成已通过。 */
  gaps: string[];
}

/** 新增审查账本，不修改历史正文及其内容摘要。 */
export function migrateTaskWorkReviewSchema(db: ZeusDatabasePort): void {
  /** 阶段规划与成果审查分别记录迁移完成。 */
  const migrationId = '20260910_task_work_review';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    db.execute('ALTER TABLE task_work_deliverables ADD COLUMN bundle_json TEXT');
    db.execute(
      `CREATE TABLE task_work_review_notes (id TEXT PRIMARY KEY, deliverable_id TEXT NOT NULL REFERENCES task_work_deliverables(id), content_sha256 TEXT NOT NULL, anchor TEXT NOT NULL, content TEXT NOT NULL, blocking INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','resolved')), revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    );
    db.execute('CREATE INDEX idx_task_work_review_notes_deliverable ON task_work_review_notes(deliverable_id, created_at)');
    db.execute('INSERT INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES(?, ?, ?, ?)', [
      migrationId,
      '冻结成果证据索引与修订绑定审查意见',
      createHash('sha256').update(migrationId).digest('hex'),
      new Date().toISOString(),
    ]);
  });
}

/** 只管理审查意见，验收和返工仍使用原工作管理入口。 */
export class TaskWorkReviewRepository {
  /** 与工作交付物共享事务和时钟。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  /** 按实际成果身份读取审查历史。 */
  list(deliverableId: string): TaskWorkReviewNote[] {
    return this.db
      .select<{
        id: string;
        deliverable_id: string;
        content_sha256: string;
        anchor: string;
        content: string;
        blocking: number;
        status: 'open' | 'resolved';
        revision: number;
        created_at: string;
        updated_at: string;
      }>('SELECT * FROM task_work_review_notes WHERE deliverable_id = ? ORDER BY created_at, id', [deliverableId])
      .map((row) => ({
        id: row.id,
        deliverableId: row.deliverable_id,
        contentSha256: row.content_sha256,
        anchor: row.anchor,
        content: row.content,
        blocking: row.blocking === 1,
        status: row.status,
        revision: row.revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }
  /** 提出意见时验证成果摘要，旧页面不能把意见挂到另一份内容。 */
  add(deliverableId: string, contentSha256: string, input: { anchor: string; content: string; blocking: boolean }): TaskWorkReviewNote {
    /** 固定的源成果必须仍存在。 */
    const deliverable = new TaskWorkDeliverableRepository(this.db, this.now).getById(deliverableId);
    if (!deliverable || deliverable.contentSha256 !== contentSha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_CONFLICT', '成果内容已改变，请重新读取。');
    if (deliverable.status !== 'submitted') throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_CLOSED', '这份成果已完成审查，请在当前待审成果中提出修改。');
    if (typeof input.blocking !== 'boolean' || typeof input.content !== 'string' || !input.content.trim() || input.content.length > 8000 || typeof input.anchor !== 'string' || input.anchor.length > 1000)
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_INVALID', '请填写有效的审查意见。', 400);
    /** 每次被命令账本接纳的意见拥有独立身份。 */
    const id = `task_work_review_${randomId(16)}`;
    /** 同一操作的创建和更新时间一致。 */
    const timestamp = this.now();
    this.db.execute("INSERT INTO task_work_review_notes(id, deliverable_id, content_sha256, anchor, content, blocking, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 'open', ?, ?)", [
      id,
      deliverableId,
      contentSha256,
      input.anchor.trim(),
      input.content.trim(),
      input.blocking ? 1 : 0,
      timestamp,
      timestamp,
    ]);
    return this.list(deliverableId).find((note) => note.id === id)!;
  }
  /** 解决或重开只更改意见状态，原文字和来源保持不变。 */
  resolve(deliverableId: string, noteId: string, expectedRevision: number, resolved: boolean): TaskWorkReviewNote {
    /** 只允许处理同一成果的意见。 */
    const note = this.list(deliverableId).find((candidate) => candidate.id === noteId);
    if (!note || note.revision !== expectedRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_CONFLICT', '审查意见已被处理，请重新读取。');
    if (new TaskWorkDeliverableRepository(this.db, this.now).getById(deliverableId)?.status !== 'submitted') throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_CLOSED', '已验收成果的审查记录保持冻结。');
    this.db.execute('UPDATE task_work_review_notes SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', [resolved ? 'resolved' : 'open', this.now(), note.id, expectedRevision]);
    return this.list(deliverableId).find((candidate) => candidate.id === note.id)!;
  }
}
