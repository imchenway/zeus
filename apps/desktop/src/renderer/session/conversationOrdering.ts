import type { NativeConversationChoice } from './sessionTypes.js';

type StageSortableConversation = Pick<NativeConversationChoice, 'id' | 'createdAt' | 'stageUpdatedAt'>;
type CreatedSortableConversation = Pick<NativeConversationChoice, 'id' | 'createdAt'>;

/** 任务运行状态取最近变化的会话；此顺序不用于会话导航。 */
export function compareConversationStageUpdatedDesc(left: StageSortableConversation, right: StageSortableConversation): number {
  return right.stageUpdatedAt.localeCompare(left.stageUpdatedAt) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

/** 任务详情按会话创建顺序表达任务发展时间线。 */
export function compareConversationCreatedAsc(left: CreatedSortableConversation, right: CreatedSortableConversation): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
