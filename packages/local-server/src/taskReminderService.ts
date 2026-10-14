import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TaskReminderRepository, type ZeusDatabasePort } from '@zeus/storage';
import type { NotificationPosition, TaskReminderPage } from '@zeus/shared';

/** 提醒只依赖本地任务事实，生命周期由本地服务管理。 */
export function registerTaskReminderService(options: {
  /** 已认证的本地服务。 */
  server: FastifyInstance;
  /** 提醒与任务共享耐久事务。 */
  db: ZeusDatabasePort;
  /** 项目定义的完成和取消角色。 */
  terminalStatuses(projectId: string): readonly string[];
  /** 只读诊断不能生成或确认提醒。 */
  readOnly: boolean;
  /** 通知变化唤醒现有工作台连接。 */
  publish(type: string, payload: Record<string, unknown>): void;
  /** 统一时钟便于行为核对。 */
  now(): Date;
}) {
  /** 一份仓库负责未读和系统投递状态。 */
  const reminders = new TaskReminderRepository(options.db, options.terminalStatuses);
  /** 空闲时也检查时钟，休眠恢复后首个回调补齐遗漏。 */
  let timer: ReturnType<typeof setInterval> | undefined;
  /** 事件在事务落盘之后发布，读取方不会看到半完成状态。 */
  const synchronize = (): void => {
    if (options.readOnly) return;
    /** 配置修订的唯一约束使重复扫描幂等。 */
    const changed = options.db.commitCriticalFactSync(() => reminders.synchronize(options.now().toISOString()));
    if (changed) options.publish('task.reminders.changed', {});
  };
  /** 后台错误记录到服务日志，不让未捕获异常退出应用。 */
  const safeSynchronize = (): void => {
    try {
      synchronize();
    } catch (error) {
      options.server.log.error({ err: error }, '任务提醒检查失败');
    }
  };
  /** 所有接口保留明确错误状态，不返回成功空列表掩盖失败。 */
  const fail = (reply: FastifyReply, error: unknown) => reply.code((error as { statusCode?: number })?.statusCode ?? 500).send({ code: 'ZEUS_TASK_REMINDER_ERROR', message: error instanceof Error ? error.message : '任务提醒操作失败。' });
  /** 原列表和统一通知入口共用同一批有效提醒。 */
  const list = (cursor?: string, before?: NotificationPosition): TaskReminderPage => {
    synchronize();
    return reminders.list(cursor, before);
  };
  options.server.get('/api/task-reminders', async (request: FastifyRequest<{ Querystring: { cursor?: string } }>, reply) => {
    try {
      return list(request.query.cursor);
    } catch (error) {
      return fail(reply, error);
    }
  });
  options.server.get('/api/task-reminders/system-pending', async (_request, reply) => {
    try {
      synchronize();
      return reminders.systemPending();
    } catch (error) {
      return fail(reply, error);
    }
  });
  /** 批量确认携带准确身份，重复提交不会确认后来生成的提醒。 */
  options.server.post('/api/task-reminders/acknowledge', async (request: FastifyRequest<{ Body: { ids?: string[]; system?: boolean } }>, reply) => {
    try {
      if (options.readOnly) return reply.code(403).send({ message: '只读模式不能确认提醒。' });
      if (typeof request.body?.system !== 'boolean') return reply.code(400).send({ message: '提醒确认类型无效。' });
      options.db.commitCriticalFactSync(() => reminders.acknowledge(request.body.ids!, request.body.system!, options.now().toISOString()));
      options.publish('task.reminders.changed', {});
      return { acknowledged: true };
    } catch (error) {
      return fail(reply, error);
    }
  });
  options.server.addHook('onReady', async () => {
    if (options.readOnly) return;
    safeSynchronize();
    timer = setInterval(safeSynchronize, 15000);
    timer.unref();
  });
  options.server.addHook('onClose', async () => clearInterval(timer));
  options.server.addHook('onResponse', async (request, reply) => {
    // 任务、项目或配置变更后立即对账；提醒确认本身不触发递归检查。
    if (request.method !== 'GET' && reply.statusCode < 400 && !request.url.startsWith('/api/task-reminders')) safeSynchronize();
  });
  return {
    synchronize,
    list,
    /** 由统一入口提供耐久事务，提交完成后才刷新所有窗口。 */
    acknowledgeAll(): void {
      reminders.acknowledgeAll(options.now().toISOString());
      options.db.afterCommit(() => options.publish('task.reminders.changed', {}));
    },
  };
}

/** 统一通知复用任务提醒服务，不额外创建定时器或事实源。 */
export type TaskReminderService = ReturnType<typeof registerTaskReminderService>;
