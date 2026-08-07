import type { NativeConversationChoice } from './sessionTypes.js';

type StageSortableConversation = Pick<NativeConversationChoice, 'id' | 'createdAt' | 'stageUpdatedAt'>;
type CreatedSortableConversation = Pick<NativeConversationChoice, 'id' | 'createdAt'>;

/** 左侧会话入口只按阶段时间倒序；创建时间和 ID 仅用于稳定处理同一毫秒。 */
export function compareConversationStageUpdatedDesc(left: StageSortableConversation, right: StageSortableConversation): number {
  return right.stageUpdatedAt.localeCompare(left.stageUpdatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

/** 任务详情按会话创建顺序表达任务发展时间线。 */
export function compareConversationCreatedAsc(left: CreatedSortableConversation, right: CreatedSortableConversation): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
