import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { compareNotificationPositions, type NotificationPosition, type TaskDeadline, type TaskReminder, type TaskReminderPage } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

/** 截止时间及提醒修订与任务共用事务，不依赖 Renderer 存活。 */
export function migrateTaskReminders(db: ZeusDatabasePort): void {
  /** 迁移账本身份固定，重复启动不会修改已有提醒。 */
  const migrationId = '20261014_0639_task_deadlines';
  if (db.get('SELECT 1 FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    db.execute('ALTER TABLE tasks ADD COLUMN deadline_json TEXT');
    db.execute('ALTER TABLE tasks ADD COLUMN deadline_at TEXT');
    db.execute('ALTER TABLE tasks ADD COLUMN reminder_at TEXT');
    db.execute('ALTER TABLE tasks ADD COLUMN reminder_revision INTEGER NOT NULL DEFAULT 0');
    db.execute('CREATE INDEX tasks_reminder_due ON tasks(reminder_at) WHERE reminder_at IS NOT NULL');
    db.execute(`CREATE TABLE task_reminders (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, occurred_at TEXT NOT NULL, read_at TEXT,
      cancelled_at TEXT, system_consumed_at TEXT, UNIQUE(task_id, revision)
    )`);
    db.execute('CREATE INDEX task_reminders_unread ON task_reminders(read_at, cancelled_at, occurred_at, id)');
    db.execute(`CREATE TRIGGER task_deadline_revision AFTER UPDATE OF deadline_json ON tasks
      WHEN OLD.deadline_json IS NOT NEW.deadline_json BEGIN
        UPDATE tasks SET reminder_revision = OLD.reminder_revision + 1 WHERE id = NEW.id;
        UPDATE task_reminders SET cancelled_at = COALESCE(cancelled_at, NEW.updated_at) WHERE task_id = NEW.id;
      END`);
    db.execute(`CREATE TRIGGER task_reminder_retired AFTER UPDATE OF archived, deleted_at ON tasks
      WHEN NEW.archived = 1 OR NEW.deleted_at IS NOT NULL BEGIN
        INSERT OR IGNORE INTO task_reminders (id, task_id, revision, occurred_at, cancelled_at)
          SELECT id || ':' || reminder_revision, id, reminder_revision, reminder_at, NEW.updated_at FROM tasks WHERE id = NEW.id AND reminder_at IS NOT NULL;
        UPDATE task_reminders SET cancelled_at = COALESCE(cancelled_at, NEW.updated_at) WHERE task_id = NEW.id;
      END`);
    db.execute(`CREATE TRIGGER project_reminders_retired AFTER UPDATE OF archived, deleted_at ON projects
      WHEN NEW.archived = 1 OR NEW.deleted_at IS NOT NULL BEGIN
        INSERT OR IGNORE INTO task_reminders (id, task_id, revision, occurred_at, cancelled_at)
          SELECT id || ':' || reminder_revision, id, reminder_revision, reminder_at, NEW.updated_at FROM tasks WHERE project_id = NEW.id AND reminder_at IS NOT NULL;
        UPDATE task_reminders SET cancelled_at = COALESCE(cancelled_at, NEW.updated_at) WHERE task_id IN (SELECT id FROM tasks WHERE project_id = NEW.id);
      END`);
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '任务截止配置、提醒修订和未读记录',
      createHash('sha256').update(migrationId).digest('hex'),
      new Date().toISOString(),
    ]);
  });
}

/** 仓库只读取提醒需要的轻量任务字段。 */
interface ReminderCandidate {
  /** 任务身份。 */
  id: string;
  /** 项目身份。 */
  projectId: string;
  /** 管理状态。 */
  managementStatus: string;
  /** 当前配置修订。 */
  revision: number;
  /** 预先计算的提醒时刻。 */
  remindAt: string;
  /** 任务或项目已归档、删除。 */
  retired: number;
}

/** 提醒记录只拥有已读和投递状态，标题及项目始终读取当前任务。 */
export class TaskReminderRepository {
  /** 调用方提供耐久事务以及项目的完成、取消角色。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly terminalStatuses: (projectId: string) => readonly string[],
  ) {}

  /** 过期计划被取消；同任务同修订的唯一约束阻止重启后重复生成。 */
  synchronize(now: string): number {
    /** ponytail: 仅扫描有提醒的轻量任务；超大项目改为按项目终态维护待发索引。 */
    const candidates = this.db.select<ReminderCandidate>(`SELECT t.id, t.project_id AS projectId, t.management_status AS managementStatus,
      t.reminder_revision AS revision, t.reminder_at AS remindAt,
      CASE WHEN t.archived = 1 OR t.deleted_at IS NOT NULL OR p.archived = 1 OR p.deleted_at IS NOT NULL THEN 1 ELSE 0 END AS retired
      FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.reminder_at IS NOT NULL`);
    /** 实际变化才发送刷新事件，避免空轮询刷新工作台。 */
    let changed = 0;
    for (const task of candidates) {
      /** 管理终态与执行状态相互独立。 */
      const cancelled = Boolean(task.retired) || this.terminalStatuses(task.projectId).includes(task.managementStatus);
      if (!cancelled && task.remindAt > now) continue;
      this.db.execute('INSERT OR IGNORE INTO task_reminders (id, task_id, revision, occurred_at, cancelled_at) VALUES (?, ?, ?, ?, ?)', [`${task.id}:${task.revision}`, task.id, task.revision, task.remindAt, cancelled ? now : null]);
      changed += this.db.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
      if (cancelled) {
        this.db.execute('UPDATE task_reminders SET cancelled_at = ? WHERE task_id = ? AND cancelled_at IS NULL', [now, task.id]);
        changed += this.db.get<{ count: number }>('SELECT changes() AS count')?.count ?? 0;
      }
    }
    return changed;
  }

  /** 当前有效未读从同一查询投影，终态配置变更立即影响列表和系统投递。 */
  private unread(systemOnly = false): TaskReminder[] {
    return this.db
      .select<Omit<TaskReminder, 'deadline'> & { deadlineJson: string; managementStatus: string }>(
        `SELECT n.id, t.id AS taskId,
      t.project_id AS projectId, p.name AS projectName, t.title, t.deadline_json AS deadlineJson, t.management_status AS managementStatus, n.occurred_at AS occurredAt
      FROM task_reminders n JOIN tasks t ON t.id = n.task_id JOIN projects p ON p.id = t.project_id
      WHERE n.revision = t.reminder_revision AND n.read_at IS NULL AND n.cancelled_at IS NULL
        AND t.deadline_json IS NOT NULL AND t.archived = 0 AND t.deleted_at IS NULL AND p.archived = 0 AND p.deleted_at IS NULL
        ${systemOnly ? 'AND n.system_consumed_at IS NULL' : ''}
      ORDER BY n.occurred_at DESC, n.id DESC`,
      )
      .filter((row) => !this.terminalStatuses(row.projectId).includes(row.managementStatus))
      .map((row) => ({ id: row.id, taskId: row.taskId, projectId: row.projectId, projectName: row.projectName, title: row.title, occurredAt: row.occurredAt, deadline: JSON.parse(row.deadlineJson) as TaskDeadline }));
  }

  /** 游标记录稳定时间和身份，已读后仍可继续翻页。 */
  list(cursor?: string, before?: NotificationPosition): TaskReminderPage {
    /** 先计算完整未读，再截取当前页。 */
    const all = this.unread();
    /** 页起点不依赖游标行是否仍为未读。 */
    let after: { occurredAt: string; id: string } | null = null;
    if (cursor !== undefined) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error();
        after = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { occurredAt: string; id: string };
        if (!after || typeof after.id !== 'string' || !after.id || typeof after.occurredAt !== 'string' || !Number.isFinite(Date.parse(after.occurredAt))) throw new Error();
      } catch {
        throw Object.assign(new Error('提醒分页游标无效。'), { statusCode: 400 });
      }
    }
    /** 倒序查询与游标边界保持一致。 */
    const remaining = all.filter((item) => (before ? compareNotificationPositions({ ...item, source: 'task' }, before) > 0 : !after || item.occurredAt < after.occurredAt || (item.occurredAt === after.occurredAt && item.id < after.id)));
    /** 一次展示五十条，完整计数不受分页限制。 */
    const items = remaining.slice(0, 50);
    /** 下一页复用最后一条记录的稳定位置。 */
    const last = items.at(-1);
    return { items, unreadCount: all.length, nextCursor: remaining.length > items.length && last ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, id: last.id })).toString('base64url') : null };
  }

  /** 主进程恢复时读取尚未处理的通知，批量补发只弹一次摘要。 */
  systemPending(): { ids: string[]; first: TaskReminder | null } {
    /** 单条显示任务详情，多条打开统一通知列表。 */
    const items = this.unread(true);
    return { ids: items.map((item) => item.id), first: items[0] ?? null };
  }

  /** 调用方以统一事务确认所有有效未读，不改写系统投递状态。 */
  acknowledgeAll(now: string): void {
    for (const item of this.unread()) this.acknowledge([item.id], false, now);
    // 全量确认存在遗漏时使外层事务回滚，避免返回部分成功。
    assert.equal(this.unread().length, 0, '全部已读后仍有未确认的任务提醒。');
  }

  /** 按点击时冻结的通知身份确认，旧请求不能清除新修订。 */
  acknowledge(ids: string[], system: boolean, now: string): void {
    if (!Array.isArray(ids) || ids.length > 10000 || ids.some((id) => typeof id !== 'string' || !id || id.length > 1024)) throw Object.assign(new Error('提醒身份无效。'), { statusCode: 400 });
    for (const id of ids) this.db.execute(`UPDATE task_reminders SET ${system ? 'system_consumed_at' : 'read_at'} = COALESCE(${system ? 'system_consumed_at' : 'read_at'}, ?) WHERE id = ?`, [now, id]);
  }
}
