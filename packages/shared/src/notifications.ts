import type { GitDeliveryNotification } from './gitDelivery.js';
import type { AutomationNotification } from './automationNotifications.js';
import type { TaskReminder } from './taskDeadline.js';

/** 命令通知只提供执行身份及摘要，脚本、参数和日志仍由原详情接口读取。 */
export interface CommandRunNotification {
  /** 原命令执行身份，同时作为通知身份。 */
  id: string;
  /** 执行所属项目，不能替换成当前选中的项目。 */
  projectId: string;
  /** 执行时冻结的命令标题。 */
  title: string;
  /** 只有已经结束的执行结果可以产生通知。 */
  status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  /** 执行真实结束时间，已读操作不会改变排序。 */
  occurredAt: string;
}

/** 待答通知定位原问题，答复仍走原会话提交。 */
export interface AsyncQuestionNotification {
  /** 这条提问消息的稳定记录身份，用于列表和游标。 */
  id: string;
  /** 问题所在的项目和产品会话身份。 */
  projectId: string;
  conversationId: string;
  /** 目录尚未加载时也能解释待答问题归属。 */
  projectName: string;
  /** 原会话表单使用的 Provider 轮次和问题身份。 */
  providerTurnId: string;
  providerItemId: string;
  /** 会话标题与经过脱敏的首题摘要。 */
  title: string;
  excerpt: string;
  /** 原问题的创建时间，ISO 8601。 */
  occurredAt: string;
  /** 由待答状态投影，没有独立已读回执。 */
  source: 'question';
}

/** 来源只用于分发原有业务行为，界面不按来源分类。 */
export type NotificationItem =
  | (AutomationNotification & { /** 原自动化结果。 */ source: 'automation' })
  | (TaskReminder & { /** 原任务截止提醒。 */ source: 'task' })
  | (GitDeliveryNotification & { /** 后台代码交付结果。 */ source: 'git_delivery' })
  | (CommandRunNotification & { /** 命令中心执行结果。 */ source: 'command' })
  | AsyncQuestionNotification;

/** 统一分页使用全局边界，不依赖上一条通知仍存在或仍未读。 */
export type NotificationPosition = Pick<NotificationItem, 'occurredAt' | 'source' | 'id'>;

/** 待处理视图按业务状态和项目读取，默认视图仍按未读回执读取。 */
export interface NotificationListFilter {
  /** 缺省为未读列表。 */
  view?: 'pending';
  /** 待处理视图中的项目身份，缺省为全部项目。 */
  projectId?: string;
}

/** 统一列表每页保留全局未读数和当前视图的下一页位置。 */
export interface NotificationPage {
  /** 本页按全局顺序排列的通知。 */
  items: NotificationItem[];
  /** 全部来源的有效未读数。 */
  unreadCount: number;
  /** 当前视图没有更多记录时为空。 */
  nextCursor: string | null;
}

/** 时间、来源和身份依次倒序，与 SQLite 的文本比较一致，不使用本地化排序。 */
export function compareNotificationPositions(left: NotificationPosition, right: NotificationPosition): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt > right.occurredAt ? -1 : 1;
  if (left.source !== right.source) return left.source > right.source ? -1 : 1;
  return left.id === right.id ? 0 : left.id > right.id ? -1 : 1;
}
