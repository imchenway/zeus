import type { AutomationNotification } from './automationNotifications.js';
import type { TaskReminder } from './taskDeadline.js';

/** 来源只用于分发原有业务行为，界面不按来源分类。 */
export type NotificationItem = (AutomationNotification & { /** 原自动化结果。 */ source: 'automation' }) | (TaskReminder & { /** 原任务截止提醒。 */ source: 'task' });

/** 统一分页使用全局边界，不依赖上一条通知仍存在或仍未读。 */
export type NotificationPosition = Pick<NotificationItem, 'occurredAt' | 'source' | 'id'>;

/** 统一列表一次返回完整未读数和下一页位置。 */
export interface NotificationPage {
  /** 本页按全局顺序排列的未读记录。 */
  items: NotificationItem[];
  /** 两种来源的全部有效未读数。 */
  unreadCount: number;
  /** 没有更多未读记录时为空。 */
  nextCursor: string | null;
}

/** 时间、来源和身份依次倒序，与 SQLite 的文本比较一致，不使用本地化排序。 */
export function compareNotificationPositions(left: NotificationPosition, right: NotificationPosition): number {
  if (left.occurredAt !== right.occurredAt) return left.occurredAt > right.occurredAt ? -1 : 1;
  if (left.source !== right.source) return left.source > right.source ? -1 : 1;
  return left.id === right.id ? 0 : left.id > right.id ? -1 : 1;
}
