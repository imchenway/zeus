import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { normalizeTaskDeadline, taskDeadlineTimes, matchesTaskDeadline, type TaskDeadline } from '../packages/shared/src/taskDeadline.js';
import { createZeusDatabase, ProjectRepository, TaskRepository, TaskReminderRepository } from '../packages/storage/src/index.js';
import { registerTaskReminderService } from '../packages/local-server/src/taskReminderService.js';
import { exportLocalBusinessData, importLocalBusinessData, validateLocalBusinessDataImport } from '../packages/local-server/src/localDataTransfer.js';
import { createSystemNotificationBridge, type ZeusSystemNotificationPayload } from '../apps/desktop/src/main/systemNotifications.js';

/** 使用隔离数据库验证真实读写、迁移和恢复，不接触用户资料。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-0639-check-'));
/** 所有边界断言使用固定时刻，避免依赖执行日期。 */
const now = Date.parse('2026-10-14T04:00:00Z');
/** 上海日期任务在当天 09:00 提醒，次日零点截止。 */
const dateDeadline = normalizeTaskDeadline({ date: '2026-10-14', timeZone: 'Asia/Shanghai' })!;
assert.deepEqual(taskDeadlineTimes(dateDeadline), { dueAt: '2026-10-14T16:00:00.000Z', remindAt: '2026-10-14T01:00:00.000Z' });
/** 指定时间任务提前三十分钟提醒。 */
const timed = normalizeTaskDeadline({ ...dateDeadline, time: '12:30' })!;
assert.equal(taskDeadlineTimes(timed).remindAt, '2026-10-14T04:00:00.000Z');
assert.equal(taskDeadlineTimes({ ...timed, reminder: 'at_deadline' }).remindAt, taskDeadlineTimes(timed).dueAt);
assert.equal(taskDeadlineTimes({ ...timed, reminder: 'off' }).remindAt, null);
for (const value of [
  { ...timed, date: '2026-02-30' },
  { ...timed, time: '24:00' },
  { ...timed, timeZone: 'Invalid/Zone' },
  { ...timed, reminder: 'daily' },
  { ...timed, date: '2026-03-08', time: '02:30', timeZone: 'America/New_York' },
  { ...dateDeadline, date: '2011-12-30', timeZone: 'Pacific/Apia', reminder: 'off' },
])
  assert.throws(() => normalizeTaskDeadline(value));
/** 夏令时重复分钟固定取第一次，日期结束按日历计算。 */
assert.equal(taskDeadlineTimes({ ...timed, date: '2026-11-01', time: '01:30', timeZone: 'America/New_York' }).dueAt, '2026-11-01T05:30:00.000Z');
assert.equal(taskDeadlineTimes({ ...dateDeadline, date: '2026-03-08', timeZone: 'America/New_York' }).dueAt, '2026-03-09T04:00:00.000Z');
/** 日期结束遇到零点跳时或整日跳过，仍采用实际日界线。 */
assert.equal(taskDeadlineTimes(normalizeTaskDeadline({ ...dateDeadline, date: '2026-09-05', timeZone: 'America/Santiago' })!).dueAt, '2026-09-06T04:00:00.000Z');
assert.equal(taskDeadlineTimes(normalizeTaskDeadline({ ...dateDeadline, date: '2011-12-29', timeZone: 'Pacific/Apia' })!).dueAt, '2011-12-30T10:00:00.000Z');
assert(matchesTaskDeadline({ deadline: dateDeadline }, 'today', now));
assert(!matchesTaskDeadline({ deadline: dateDeadline }, 'overdue', now));
assert(matchesTaskDeadline({ deadline: dateDeadline }, 'overdue', Date.parse('2026-10-14T16:00:00Z')));
assert(!matchesTaskDeadline({ deadline: dateDeadline, managementStatus: 'accepted' }, 'overdue', now + 86400000, ['accepted', 'dropped']));
assert(matchesTaskDeadline({ deadline: { ...dateDeadline, date: '2026-10-21' } }, 'next_seven_days', now));
assert(!matchesTaskDeadline({ deadline: { ...dateDeadline, date: '2026-10-22' } }, 'next_seven_days', now));
assert(!matchesTaskDeadline({ deadline: dateDeadline }, 'next_seven_days', now));
assert(matchesTaskDeadline({}, 'unset', now));

try {
  /** 首次创建执行真实迁移；关闭后重新打开验证持久记录。 */
  let db = await createZeusDatabase(join(root, 'tasks.db'));
  try {
    /** 项目和任务使用真实仓库，外键和修改冲突均参与检查。 */
    const projects = new ProjectRepository(db);
    /** 隔离项目目录仅在临时目录内。 */
    const project = projects.create({ id: 'deadline-project', name: '截止提醒核对', localPath: root });
    /** 任务读写入口。 */
    const tasks = new TaskRepository(db);
    /** 自定义终态角色必须参与提醒判断。 */
    const terminal = () => ['accepted', 'dropped'];
    /** 通知和任务共用数据库。 */
    let reminders = new TaskReminderRepository(db, terminal);
    /** 每次创建真实任务，可选择截止配置。 */
    const create = (id: string, deadline: TaskDeadline | null = null) => tasks.create({ id, projectId: project.id, title: id, taskType: 'task', description: '分页与截止规则核对', createdFrom: 'user', sourceContext: {}, deadline });
    for (let index = 0; index < 55; index += 1) create(`no-deadline-${index}`);
    /** 匹配任务刻意排在默认首批之外，防止前端当前页筛选冒充完整查询。 */
    const first = create('due-after-first-page', dateDeadline);
    assert.deepEqual(
      tasks.listSummaryPage(project.id, { deadlineFilter: 'today', now, limit: 1 }).items.map((task) => task.id),
      [first.id],
    );
    create('second-due', dateDeadline);
    /** 日期筛选分页继续使用相同条件。 */
    const page = tasks.listSummaryPage(project.id, { deadlineFilter: 'today', now, limit: 1 });
    assert(page.hasMore && page.nextCursor);
    assert.equal(tasks.listSummaryPage(project.id, { deadlineFilter: 'today', now, limit: 1, cursor: page.nextCursor }).items.length, 1);
    assert.throws(() => tasks.listSummaryPage(project.id, { deadlineFilter: 'unset', cursor: page.nextCursor!, now }));
    assert.equal(reminders.synchronize(new Date(now).toISOString()), 2);
    assert.equal(reminders.synchronize(new Date(now).toISOString()), 0);
    assert.equal(reminders.list().unreadCount, 2);
    /** 确认一条不会消除另一个任务的通知。 */
    const originalNotice = reminders.list().items.find((item) => item.taskId === first.id)!;
    reminders.acknowledge([originalNotice.id], false, new Date(now).toISOString());
    assert.equal(reminders.list().unreadCount, 1);
    /** 普通内容修改保留截止配置，不生成新修订。 */
    const renamed = tasks.updateContent(first.id, { expectedUpdatedAt: first.updatedAt, title: '修改标题' }).task;
    assert.deepEqual(renamed.deadline, dateDeadline);
    assert.throws(() => tasks.updateContent(first.id, { expectedUpdatedAt: first.updatedAt, deadline: null }));
    /** 改期生成新修订，旧确认不能误清新通知。 */
    const changed = tasks.updateContent(first.id, { expectedUpdatedAt: renamed.updatedAt, deadline: timed }).task;
    reminders.synchronize(new Date(now).toISOString());
    reminders.acknowledge([originalNotice.id], false, new Date(now).toISOString());
    assert(reminders.list().items.some((item) => item.taskId === first.id && item.id !== originalNotice.id));
    tasks.updateContent(first.id, { expectedUpdatedAt: changed.updatedAt, deadline: null });
    assert(!reminders.list().items.some((item) => item.taskId === first.id));
    /** 自定义完成角色不依赖任务执行状态。 */
    db.execute('UPDATE tasks SET management_status = ? WHERE id = ?', ['accepted', 'second-due']);
    reminders.synchronize(new Date(now).toISOString());
    assert.equal(reminders.list().unreadCount, 0);
    /** 归档与删除后不能继续投递旧通知。 */
    const archived = create('archived-task', dateDeadline);
    reminders.synchronize(new Date(now).toISOString());
    tasks.archive(archived.id);
    assert.equal(reminders.list().unreadCount, 0);
    /** 未来任务归档后立即恢复，也不能恢复已取消的原提醒。 */
    const retiredFuture = create('retired-future', { ...dateDeadline, time: '16:00' });
    tasks.archive(retiredFuture.id);
    tasks.restore(retiredFuture.id);
    /** 未来提醒在重启后补齐，已生成的身份保持不变。 */
    create('wake-up', { ...dateDeadline, time: '15:00' });
    await db.close();
    db = await createZeusDatabase(join(root, 'tasks.db'));
    reminders = new TaskReminderRepository(db, terminal);
    reminders.synchronize('2026-10-14T08:00:00.000Z');
    assert.equal(reminders.list().unreadCount, 1);
    assert.equal(reminders.synchronize('2026-10-14T08:00:00.000Z'), 0);
    /** 提醒服务查询、确认、非法参数和幂等行为使用真实 HTTP 路由检查。 */
    const server = Fastify();
    registerTaskReminderService({ server, db, terminalStatuses: terminal, readOnly: false, publish: () => undefined, now: () => new Date('2026-10-14T08:00:00Z') });
    await server.ready();
    assert.equal((await server.inject('/api/task-reminders')).json().unreadCount, 1);
    assert.equal((await server.inject('/api/task-reminders?cursor=invalid')).statusCode, 400);
    assert.equal((await server.inject({ method: 'POST', url: '/api/task-reminders/acknowledge', payload: { ids: 'invalid', system: false } })).statusCode, 400);
    /** 系统队列只确认投递，不会消除应用内未读。 */
    const batch = (await server.inject('/api/task-reminders/system-pending')).json() as ReturnType<TaskReminderRepository['systemPending']>;
    assert.equal(batch.ids.length, 1);
    await server.inject({ method: 'POST', url: '/api/task-reminders/acknowledge', payload: { ids: batch.ids, system: true } });
    assert.equal((await server.inject('/api/task-reminders/system-pending')).json().ids.length, 0);
    assert.equal((await server.inject('/api/task-reminders')).json().unreadCount, 1);
    await server.close();
    /** 导出再导入保留日期、分钟、时区和提醒方式。 */
    const exported = exportLocalBusinessData(db, new Date(now).toISOString());
    assert.equal(exported.data.tasks.find((task) => task.id === 'wake-up')?.deadline?.time, '15:00');
    /** 第二份独立数据库只接收本次导出。 */
    const importedDb = await createZeusDatabase(join(root, 'import.db'));
    try {
      assert.equal(validateLocalBusinessDataImport(importedDb, exported), null);
      importedDb.transaction(() => importLocalBusinessData(importedDb, exported));
      assert.deepEqual(new TaskRepository(importedDb).getById('wake-up')?.deadline, { ...dateDeadline, time: '15:00' });
    } finally {
      await importedDb.close();
    }
    /** 系统通知桥批量摘要、前台抑制和确认采用真实桥实现。 */
    const shown: ZeusSystemNotificationPayload[] = [];
    /** 本次身份模拟服务端的一批持久通知。 */
    let pending = ['a', 'b'];
    /** 确认用于等待异步桥完成，无任意固定休眠。 */
    let complete!: () => void;
    /** 完成回执驱动检查。 */
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    /** WebSocket 事件只作为唤醒，启动补读不依赖消息到达。 */
    const bridge = createSystemNotificationBridge({
      baseUrl: 'http://127.0.0.1:1',
      apiToken: 'isolated',
      openWebSocket: () => ({ addEventListener() {}, close() {} }),
      showNotification: (payload) => shown.push(payload),
      loadTaskReminders: async () => ({ ids: pending, first: batch.first }),
      acknowledgeTaskReminders: async () => {
        pending = [];
        complete();
      },
    });
    try {
      await completed;
      assert.equal(shown.length, 1);
      assert.equal(shown[0].taskId, undefined);
      assert(shown[0].body.includes('2'));
    } finally {
      bridge.close();
    }
    /** 前台收到提醒时只确认系统队列，保留应用内未读。 */
    let finishForeground!: () => void;
    /** 等待实际确认完成，不用固定延时推断成功。 */
    const foregroundDone = new Promise<void>((resolve) => {
      finishForeground = resolve;
    });
    /** 前台不应调用操作系统展示回调。 */
    const foregroundBridge = createSystemNotificationBridge({
      baseUrl: 'http://127.0.0.1:1',
      apiToken: 'isolated',
      openWebSocket: () => ({ addEventListener() {}, close() {} }),
      shouldNotify: () => false,
      showNotification: () => assert.fail('前台不应弹系统通知'),
      loadTaskReminders: async () => ({ ids: ['foreground'], first: batch.first }),
      acknowledgeTaskReminders: async () => {
        finishForeground();
      },
    });
    try {
      await foregroundDone;
    } finally {
      foregroundBridge.close();
    }
    console.log('通过：日期和时区边界、真实存储与分页、冲突与改期、取消与归档、重启补发、通知接口、系统批量摘要、导入导出。');
  } finally {
    await db.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
