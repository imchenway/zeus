import type { ConversationSystemMessage } from '@zeus/shared';

/** 首屏、补页、命令回执与实时事件合并到同一系统消息，不回退恢复事实。 */
export function mergeSystemMessages(current: Record<string, ConversationSystemMessage> | undefined, incoming: readonly ConversationSystemMessage[]): Record<string, ConversationSystemMessage> {
  /** 保留尚未出现在有界首屏中的历史消息。 */
  const result = { ...current };
  for (const message of incoming) {
    /** 内容修订和位置修订分别决定是否接管，避免重编号丢失。 */
    const previous = result[message.id];
    const latest = !previous || (message.transcript.sources[0]?.revision ?? 0) >= (previous.transcript.sources[0]?.revision ?? 0) ? message : previous;
    const placement =
      previous &&
      (previous.transcript.placement.orderEpoch > message.transcript.placement.orderEpoch ||
        (previous.transcript.placement.orderEpoch === message.transcript.placement.orderEpoch && previous.transcript.placement.placementRevision > message.transcript.placement.placementRevision))
        ? previous.transcript.placement
        : message.transcript.placement;
    result[message.id] = { ...latest, transcript: { ...latest.transcript, placement } };
  }
  return result;
}
