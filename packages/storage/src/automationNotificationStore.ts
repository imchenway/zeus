import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { AutomationRunRecord } from './automationStore.js';
import type { AutomationNotification, AutomationNotificationPage, NotificationPosition } from '@zeus/shared';
import type { ZeusDatabasePort, SqlValue } from './databasePort.js';
import { randomId } from './randomId.js';

/** 投影输入只包含业务摘要，身份和确认状态由仓库管理。 */
export type AutomationNotificationDraft = Omit<AutomationNotification, 'id' | 'runId' | 'revision' | 'occurredAt'> & { /** 同次运行内的会话或异常身份。 */ targetKey: string };

/** 未投影的源修订在运行表中耐久保存，进程退出后可以继续。 */
export interface PendingAutomationNotification {
  /** 原运行身份。 */
  id: string;
  /** 当前待投影修订。 */
  revision: number;
  /** 结果真实发生时间。 */
  occurredAt: string;
  /** 结果发生时的引用与状态，后续恢复运行不能覆盖这份事实。 */
  snapshot: Pick<AutomationRunRecord, 'status' | 'errorCode' | 'errorMessage' | 'conversationId' | 'executionReferences' | 'dispatchTargets' | 'dispatchCompletedAt'>;
}

/** SQLite 内部通知行，不作为跨层接口。 */
interface NotificationRow {
  /** 稳定通知身份。 */
  id: string;
  /** 原运行身份。 */
  run_id: string;
  /** 摘要字段。 */
  payload_json: string;
  /** 当前结果修订。 */
  revision: number;
  /** 结果时间。 */
  occurred_at: string;
}

/** 原未读结果迁入待投影队列，已读历史不会重新提醒。 */
export function migrateAutomationNotifications(db: ZeusDatabasePort): void {
  /** 此迁移只补充通知状态，不改写历史运行结果。 */
  const migrationId = '20261013_0831_automation_notifications';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    db.execute('ALTER TABLE automation_runs ADD COLUMN notification_revision INTEGER NOT NULL DEFAULT 0');
    db.execute('ALTER TABLE automation_runs ADD COLUMN notification_projected_revision INTEGER NOT NULL DEFAULT 0');
    db.execute('ALTER TABLE automation_runs ADD COLUMN notification_occurred_at TEXT');
    db.execute('ALTER TABLE automation_runs ADD COLUMN notification_source_json TEXT');
    /** 标识符只来自本函数，冻结结果时不接收外部 SQL。 */
    const sourceExpression = (prefix: string) => `json_object('status', ${prefix}status, 'errorCode', ${prefix}error_code,
      'errorMessage', ${prefix}error_message, 'conversationId', ${prefix}conversation_id,
      'executionReferences', json(${prefix}execution_references_json), 'dispatchTargets', json(${prefix}dispatch_targets_json),
      'dispatchCompletedAt', ${prefix}dispatch_completed_at)`;
    db.execute(`CREATE TABLE automation_notifications (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
      target_key TEXT NOT NULL, payload_json TEXT NOT NULL, revision INTEGER NOT NULL,
      occurred_at TEXT NOT NULL, read_at TEXT, UNIQUE(run_id, target_key)
    )`);
    db.execute('CREATE INDEX idx_automation_notifications_unread ON automation_notifications(occurred_at DESC, id DESC) WHERE read_at IS NULL');
    db.execute('CREATE INDEX idx_automation_notification_pending ON automation_runs(notification_revision, notification_projected_revision) WHERE notification_revision > notification_projected_revision');
    db.execute(`UPDATE automation_runs SET notification_revision = 1, notification_occurred_at = updated_at, notification_source_json = ${sourceExpression('')}
      WHERE unread = 1 AND status IN ('awaiting_review', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown')`);
    // 插入型的取消或跳过记录也进入同一通知路径。
    db.execute(`CREATE TRIGGER automation_notification_insert AFTER INSERT ON automation_runs
      WHEN NEW.unread = 1 AND NEW.status IN ('awaiting_review', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown')
      BEGIN UPDATE automation_runs SET notification_revision = 1, notification_occurred_at = NEW.updated_at, notification_source_json = ${sourceExpression('NEW.')} WHERE id = NEW.id; END`);
    // 比较真实结果字段，重复对账不会把已读内容重新置为未读。
    db.execute(`CREATE TRIGGER automation_notification_update AFTER UPDATE OF status, unread, error_code, error_message, execution_references_json, conversation_id, dispatch_targets_json, dispatch_completed_at ON automation_runs
      WHEN NEW.unread = 1 AND NEW.status IN ('awaiting_review', 'succeeded', 'failed', 'blocked', 'cancelled', 'outcome_unknown')
      AND (OLD.status IS NOT NEW.status OR OLD.unread = 0 OR OLD.error_code IS NOT NEW.error_code
        OR OLD.error_message IS NOT NEW.error_message OR OLD.execution_references_json IS NOT NEW.execution_references_json
        OR OLD.conversation_id IS NOT NEW.conversation_id OR OLD.dispatch_targets_json IS NOT NEW.dispatch_targets_json OR OLD.dispatch_completed_at IS NOT NEW.dispatch_completed_at)
      BEGIN UPDATE automation_runs SET notification_revision = notification_revision + 1, notification_occurred_at = NEW.updated_at, notification_source_json = ${sourceExpression('NEW.')} WHERE id = NEW.id; END`);
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '逐会话自动化通知及已读修订',
      createHash('sha256').update(migrationId).digest('hex'),
      new Date().toISOString(),
    ]);
  });
}

/** 通知与原运行共用数据库，已读确认不会修改其他会话。 */
export class AutomationNotificationRepository {
  /** 使用调用方的事务和耐久提交边界。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 分批读取待处理修订，批次不会限制用户的未读总数。 */
  pending(): PendingAutomationNotification[] {
    return this.db
      .select<Omit<PendingAutomationNotification, 'snapshot'> & { snapshotJson: string }>(
        'SELECT id, notification_revision AS revision, notification_occurred_at AS occurredAt, notification_source_json AS snapshotJson FROM automation_runs WHERE notification_revision > notification_projected_revision ORDER BY notification_occurred_at, id LIMIT 100',
      )
      .map(({ snapshotJson, ...source }) => ({ ...source, snapshot: JSON.parse(snapshotJson) as PendingAutomationNotification['snapshot'] }));
  }

  /** 同修订只投影一次；被会话替代的旧异常不继续留在未读列表。 */
  project(source: PendingAutomationNotification, items: AutomationNotificationDraft[]): void {
    this.db.transaction(() => {
      /** 重复投影不得把刚确认的通知再改为已读或未读。 */
      const current = this.db.get<{ revision: number; projected: number }>('SELECT notification_revision AS revision, notification_projected_revision AS projected FROM automation_runs WHERE id = ?', [source.id]);
      if (!current || current.revision !== source.revision || current.projected >= source.revision) return;
      this.db.execute('UPDATE automation_notifications SET read_at = COALESCE(read_at, ?) WHERE run_id = ?', [source.occurredAt, source.id]);
      for (const { targetKey, ...payload } of items) {
        this.db.execute(
          `INSERT INTO automation_notifications (id, run_id, target_key, payload_json, revision, occurred_at, read_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(run_id, target_key) DO UPDATE SET
          payload_json = excluded.payload_json, revision = excluded.revision, occurred_at = excluded.occurred_at, read_at = NULL
          WHERE automation_notifications.revision < excluded.revision`,
          [`automation_notice_${randomId(16)}`, source.id, targetKey, JSON.stringify(payload), source.revision, source.occurredAt],
        );
      }
      // 投影提交前执行最小一致性检查；异常会回滚，不能静默吞掉待查看结果。
      assert(items.length > 0 && new Set(items.map((item) => item.targetKey)).size === items.length, '自动化通知必须包含唯一的查看目标。');
      assert.equal(
        this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_notifications WHERE run_id = ? AND revision = ? AND read_at IS NULL', [source.id, source.revision])!.count,
        items.length,
        '自动化通知投影条目与未读记录不一致。',
      );
      this.db.execute('UPDATE automation_runs SET notification_projected_revision = ? WHERE id = ? AND notification_revision = ?', [source.revision, source.id, source.revision]);
    });
  }

  /** 游标按发生时间和稳定身份排序，读取时同时给出准确的未读总数。 */
  list(cursor?: string, before?: NotificationPosition): AutomationNotificationPage {
    /** 游标来自客户端，必须验证结构后才绑定到查询。 */
    const params: SqlValue[] = [];
    /** 首次查询覆盖最新一页，后续页面严格位于游标之后。 */
    let after = '';
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error();
        /** 解码值不能直接用于 SQL。 */
        const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !Number.isFinite(Date.parse(value[0])) || typeof value[1] !== 'string' || value[1].length > 200) throw new Error();
        after = ' AND (occurred_at < ? OR (occurred_at = ? AND id < ?))';
        params.push(value[0], value[0], value[1]);
      } catch {
        throw new Error('ZEUS_AUTOMATION_NOTIFICATION_CURSOR_INVALID: 通知分页位置无效，请重新加载。');
      }
    }
    if (before) {
      // 统一列表对两个来源使用相同的严格边界，包括同一时间的稳定身份。
      after = " AND (occurred_at, 'automation', id) < (?, ?, ?)";
      params.splice(0, params.length, before.occurredAt, before.source, before.id);
    }
    /** 多取一条只用于判断下一页，不以页长度代替总数。 */
    const rows = this.db.select<NotificationRow>(`SELECT * FROM automation_notifications WHERE read_at IS NULL${after} ORDER BY occurred_at DESC, id DESC LIMIT 21`, params);
    /** 页面最后一项决定下一页边界。 */
    const last = rows[19];
    return {
      items: rows.slice(0, 20).map((row) => ({ ...(JSON.parse(row.payload_json) as AutomationNotificationDraft), id: row.id, runId: row.run_id, revision: row.revision, occurredAt: row.occurred_at })),
      unreadCount: this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_notifications WHERE read_at IS NULL')!.count,
      nextCursor: rows.length > 20 && last ? Buffer.from(JSON.stringify([last.occurred_at, last.id])).toString('base64url') : null,
    };
  }

  /** 同一事务确认全部未读记录，覆盖未加载分页，后续新修订仍由投影保持未读。 */
  acknowledgeAll(): { acknowledged: boolean } {
    this.db.execute('UPDATE automation_notifications SET read_at = ? WHERE read_at IS NULL', [new Date().toISOString()]);
    // 提交前检查全量确认，防止分页限制或遗漏造成部分成功。
    assert.equal(this.db.get<{ count: number }>('SELECT COUNT(*) AS count FROM automation_notifications WHERE read_at IS NULL')!.count, 0, '全部已读后仍有未确认的通知。');
    return { acknowledged: true };
  }

  /** 仅确认用户实际看见的修订；过期确认不清除较新结果。 */
  acknowledge(id: string, expectedRevision: number): { acknowledged: boolean } {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('ZEUS_AUTOMATION_NOTIFICATION_REVISION_INVALID: 通知修订无效。');
    /** 原通知不存在时不把失败伪装成已读。 */
    const current = this.db.get<{ revision: number }>('SELECT revision FROM automation_notifications WHERE id = ?', [id]);
    if (!current) throw new Error('ZEUS_AUTOMATION_NOTIFICATION_NOT_FOUND: 通知已不存在，请刷新列表。');
    if (current.revision !== expectedRevision) return { acknowledged: false };
    this.db.execute('UPDATE automation_notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND revision = ?', [new Date().toISOString(), id, expectedRevision]);
    return { acknowledged: true };
  }
}
