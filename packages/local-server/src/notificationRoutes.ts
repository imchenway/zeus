import assert from 'node:assert/strict';
import { compareNotificationPositions, type NotificationItem, type NotificationPage, type NotificationPosition } from '@zeus/shared';
import type { ZeusDatabasePort } from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AutomationNotificationService } from './automationNotificationService.js';
import { AutomationMutationApplication } from './automationMutationApplication.js';
import type { TaskReminderService } from './taskReminderService.js';

/** 统一通知只聚合原有业务记录，批量确认复用既有幂等耐久事务。 */
export function registerNotificationRoutes(options: {
  /** 已认证的本地服务。 */
  server: FastifyInstance;
  /** 两类通知及操作回执共用的数据库。 */
  db: ZeusDatabasePort;
  /** 自动化结果及原会话身份。 */
  automations: AutomationNotificationService;
  /** 任务提醒及当前任务有效性。 */
  tasks: TaskReminderService;
  /** 只读诊断不能确认通知。 */
  readOnly: boolean;
}): void {
  /** 该应用仅处理 HTTP 幂等与事务，不调用调度器或恢复执行。 */
  const mutations = new AutomationMutationApplication(options.db);
  /** 两个原列表至少各返回二十条，合并后取二十条不会漏掉全局前列。 */
  const pageSize = 20;
  /** 查询失败必须显示错误，不能伪装为空列表。 */
  const fail = (reply: FastifyReply, error: unknown) => {
    /** 保留已有幂等错误身份，便于区分参数错误与不确定结果。 */
    const message = error instanceof Error ? error.message : '通知操作失败。';
    /** 游标错误使用明确状态码，幂等冲突沿用已有错误语义。 */
    const code = /\b(ZEUS_[A-Z0-9_]+)\b/u.exec(message)?.[1] ?? 'ZEUS_NOTIFICATION_OPERATION_FAILED';
    /** 不将无效请求伪装成服务器故障。 */
    const statusCode = (error as { statusCode?: number })?.statusCode ?? (code.endsWith('_ID_REQUIRED') ? 400 : code.endsWith('_CONFLICT') || code.endsWith('_OUTCOME_UNKNOWN') ? 409 : 500);
    return reply.code(statusCode).send({ error: code, message });
  };

  options.server.get('/api/notifications', async (request: FastifyRequest<{ Querystring: { cursor?: string } }>, reply) => {
    try {
      /** 全局游标不依赖来源页大小，也不依赖边界行是否被删除或已读。 */
      const before = decodeNotificationCursor(request.query.cursor);
      /** 原服务仍负责补齐投影和检查可导航对象。 */
      const automations = options.automations.list(undefined, before);
      const tasks = options.tasks.list(undefined, before);
      /** 来源参与身份排序，相同时间与相同业务身份不会互相覆盖。 */
      const candidates: NotificationItem[] = [...automations.items.map((item) => ({ ...item, source: 'automation' as const })), ...tasks.items.map((item) => ({ ...item, source: 'task' as const }))].sort(compareNotificationPositions);
      // 源查询与全局排序若不一致则拒绝响应，不能静默重复或跳过通知。
      assert(
        candidates.every((item, index) => (!before || compareNotificationPositions(item, before) > 0) && (index === 0 || compareNotificationPositions(candidates[index - 1]!, item) < 0)),
        '通知分页边界或排序不一致。',
      );
      /** 当前页只截取全局顺序，下一次两个来源都从相同边界继续。 */
      const items = candidates.slice(0, pageSize);
      /** 游标只携带稳定排序字段，不暴露通知正文。 */
      const last = items.at(-1);
      /** 来源仍有下一页时，统一入口必须保留继续读取的入口。 */
      const hasMore = candidates.length > items.length || Boolean(automations.nextCursor || tasks.nextCursor);
      return {
        items,
        unreadCount: automations.unreadCount + tasks.unreadCount,
        nextCursor: last && hasMore ? Buffer.from(JSON.stringify({ occurredAt: last.occurredAt, source: last.source, id: last.id })).toString('base64url') : null,
      } satisfies NotificationPage;
    } catch (error) {
      return fail(reply, error);
    }
  });

  /** 两类通知同事务确认；同一请求重放只返回原回执，后来产生的提醒保持未读。 */
  options.server.post('/api/notifications/read-all', async (request, reply) => {
    try {
      if (options.readOnly) return reply.code(403).send({ error: 'ZEUS_NOTIFICATION_READ_ONLY', message: '只读模式不能确认通知。' });
      options.automations.synchronize();
      options.tasks.synchronize();
      /** 两类更新和幂等回执要么一起落盘，要么一起回滚。 */
      const result = mutations.execute({ method: request.method, url: request.url, body: request.body, key: request.headers['idempotency-key'] }, () => {
        options.automations.acknowledgeAll();
        options.tasks.acknowledgeAll();
        return { statusCode: 200, body: { acknowledged: true } };
      });
      return reply.code(result.statusCode).send(result.body);
    } catch (error) {
      return fail(reply, error);
    }
  });
}

/** 游标是外部输入，只允许有限长度、明确来源和有效时间的稳定位置。 */
function decodeNotificationCursor(cursor?: string): NotificationPosition | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (typeof cursor !== 'string' || cursor.length > 4096) throw new Error();
    /** 解析结果不能在校验前被当作可信类型。 */
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    /** 只提取用于分页的字段，额外输入不会进入查询。 */
    const { occurredAt, source, id } = value as Record<string, unknown>;
    if (typeof occurredAt !== 'string' || occurredAt.length > 64 || !Number.isFinite(Date.parse(occurredAt)) || (source !== 'automation' && source !== 'task') || typeof id !== 'string' || !id || id.length > 1024) throw new Error();
    return { occurredAt, source, id };
  } catch {
    throw Object.assign(new Error('通知分页位置无效，请重新加载。'), { statusCode: 400 });
  }
}
