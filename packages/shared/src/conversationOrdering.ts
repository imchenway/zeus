/** 会话导航只使用持久的用户发起时间，不使用打开会话时可能刷新的运行状态时间。 */
interface WorkStartedSortableConversation {
  /** 同时创建时用于稳定排序的会话身份。 */
  id: string;
  /** 缺少主动输入记录时使用的原始创建时间，采用 ISO 格式。 */
  createdAt: string;
  /** 最近创建或主动输入的时间，采用 ISO 格式；辅助会话可为空。 */
  workStartedAt?: string | null;
}

/** 新建或主动发送的会话优先；同一时间按创建时间和身份稳定排序。 */
export function compareConversationWorkStartedDesc(left: WorkStartedSortableConversation, right: WorkStartedSortableConversation): number {
  return (right.workStartedAt ?? right.createdAt).localeCompare(left.workStartedAt ?? left.createdAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}
