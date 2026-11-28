import type { AsyncQuestionNotification, NotificationListFilter, NotificationPage } from '@zeus/shared';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';

/** 通知中心统一读取和批量确认，单条确认仍由原业务接口负责。 */
export interface NotificationApiClient {
  /** 服务端完成跨来源排序与分页。 */
  loadNotifications(cursor?: string, filter?: NotificationListFilter): Promise<NotificationPage>;
  /** 打开时确认原问题还需要回答。 */
  loadPendingQuestion(id: string): Promise<AsyncQuestionNotification | null>;
  /** 各来源未读和幂等回执同事务提交。 */
  acknowledgeAllNotifications(): Promise<{ acknowledged: boolean }>;
  /** 确认准确命令执行的结果，不影响其他执行。 */
  acknowledgeCommandNotification(runId: string): Promise<{ acknowledged: boolean }>;
}

/** 复用工作台认证连接，不为通知建立独立传输层。 */
export function createNotificationApiClient(transport: LocalApiTransport): NotificationApiClient {
  return {
    /** 游标和项目筛选都通过查询参数传递。 */
    loadNotifications: (cursor, filter) => {
      const query = new URLSearchParams();
      if (cursor) query.set('cursor', cursor);
      if (filter?.view) query.set('view', filter.view);
      if (filter?.projectId) query.set('projectId', filter.projectId);
      return transport.request(`/api/notifications${query.size ? `?${query}` : ''}`);
    },
    /** 按准确消息确认资格，和当前列表分页无关。 */
    loadPendingQuestion: (id) => transport.request(`/api/notifications/question/${encodeURIComponent(id)}`),
    /** 一次用户点击生成一个幂等键，传输层重放沿用同一请求。 */
    acknowledgeAllNotifications: () => transport.request('/api/notifications/read-all', { ...jsonRequest('POST', {}), headers: { 'idempotency-key': crypto.randomUUID() } }),
    /** 沿用统一通知幂等协议，执行身份作为路径参数编码。 */
    acknowledgeCommandNotification: (runId) => transport.request(`/api/notifications/command/${encodeURIComponent(runId)}/read`, { ...jsonRequest('POST', {}), headers: { 'idempotency-key': crypto.randomUUID() } }),
  };
}
