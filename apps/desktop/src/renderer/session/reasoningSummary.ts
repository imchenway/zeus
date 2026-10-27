import type { NativeSessionItemBuffer } from './sessionTypes.js';
import { mergeTranscriptItem } from './transcriptReconciliation.js';

/** 提取 Provider 已提供的最后一段可读摘要，不生成或推测思考内容。 */
export function latestReasoningSummaryText(item: Pick<NativeSessionItemBuffer, 'text' | 'payload'>): string {
  const presentation = recordValue(item.payload.presentation);
  const presentedSegments = stringSegments(presentation.summarySegments);
  const summarySegments = presentedSegments.length > 0 ? presentedSegments : stringSegments(item.payload.summary);
  return cleanReasoningSummary(summarySegments.at(-1) ?? item.text);
}

/** 过滤尚未填入正文的摘要分段。 */
function stringSegments(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry === 'string' && entry.trim()) return [entry];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const text = (entry as Record<string, unknown>).text;
    return typeof text === 'string' && text.trim() ? [text] : [];
  });
}

/** 沿用摘要的最新段落和动作标题显示方式。 */
function cleanReasoningSummary(value: string): string {
  const text = value.trim();
  if (!text) return '';
  // Provider 可能把连续更新的多个动作标题合并进同一摘要项。活动区只应表达
  // 最新动作，否则一个转圈图标会带出两三行“同时进行中”的错觉。
  const latest = text
    .split(/\n\s*\n/gu)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .at(-1)!;
  // 同一行可能紧邻多个 **动作** 标题；此时只保留最后一个动作，避免中间的
  // “****”被当作正文显示成重复文本。
  if (/^(?:\s*\*\*[^*\n]+\*\*\s*)+$/u.test(latest)) {
    const lastAction = latest.match(/\*\*[^*\n]+\*\*/gu)?.at(-1);
    if (lastAction) return lastAction.slice(2, -2);
  }
  const bold = /^\*\*([^\n]+)\*\*$/u.exec(latest);
  return bold?.[1] ?? latest;
}

/** 仅把对象载荷作为摘要字段来源。 */
function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 同一轮次保留最近的有效摘要；缺失字段不是清空指令，终态和换轮由调用方传入空轮次。 */
export function reconcileCurrentReasoningItem(previous: NativeSessionItemBuffer | null | undefined, incoming: NativeSessionItemBuffer | null, activeTurnId: string | null): NativeSessionItemBuffer | null {
  if (!activeTurnId) return null;
  /** 不能把上一轮内容带入新请求。 */
  const current = previous?.turnId === activeTurnId ? previous : null;
  if (!incoming || incoming.turnId !== activeTurnId || incoming.status === 'failed' || !latestReasoningSummaryText(incoming)) return current;
  if (!current) return incoming;
  /** 正文修订号只在同一条目内有意义，不同摘要不能互相合并载荷。 */
  const sameItem = current.transcript && incoming.transcript ? current.transcript.placement.entryId === incoming.transcript.placement.entryId : current.itemId === incoming.itemId;
  if (sameItem) return mergeTranscriptItem(current, incoming);
  /** 持久位置决定不同摘要的先后；无位置的旧协议沿用条目的首次时间。 */
  const previousOrder = current.transcript?.placement.order;
  const incomingOrder = incoming.transcript?.placement.order;
  if (previousOrder != null && incomingOrder != null) return incomingOrder > previousOrder ? incoming : current;
  return (incoming.timelineAt ?? incoming.updatedAt ?? '') >= (current.timelineAt ?? current.updatedAt ?? '') ? incoming : current;
}
