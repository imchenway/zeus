/** 自动化通知只描述需要查看的运行结果。 */
export type AutomationNotificationStatus = 'awaiting_review' | 'succeeded' | 'failed' | 'blocked' | 'cancelled' | 'outcome_unknown';

/** 自动化通知是运行结果的查看入口，不拥有会话正文。 */
export interface AutomationNotification {
  /** 通知的稳定身份。 */
  id: string;
  /** 生成通知的准确自动化运行。 */
  runId: string;
  /** 原自动化名称，规则删除后仍可展示。 */
  automationName: string;
  /** 真实会话或异常所属项目。 */
  projectId: string;
  /** 无项目运行使用空名称，由界面本地化。 */
  projectName: string;
  /** 可打开的真实会话；没有会话或已删除时为空。 */
  conversationId: string | null;
  /** 会话标题；无会话时为空。 */
  conversationTitle: string;
  /** 原运行的结果状态。 */
  status: AutomationNotificationStatus;
  /** 用户可查看的异常说明。 */
  errorMessage: string | null;
  /** 用于已有错误文案格式化的错误码。 */
  errorCode: string | null;
  /** 原运行仍有可恢复的派发目标。 */
  canResume: boolean;
  /** 此条提醒的修订，确认不能跨修订。 */
  revision: number;
  /** 本次提醒的发生时间。 */
  occurredAt: string;
}

/** 通知查询同时返回全量未读数与稳定分页游标。 */
export interface AutomationNotificationPage {
  /** 本页未读记录。 */
  items: AutomationNotification[];
  /** 所有未读记录数量，不受页大小限制。 */
  unreadCount: number;
  /** 没有下一页时为空。 */
  nextCursor: string | null;
}
