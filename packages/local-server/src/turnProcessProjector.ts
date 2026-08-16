import type { AgentRuntimeEvent } from '@zeus/ai-runtime';
import type { ConversationExecutionRepository, ConversationProcessItemRecord, ConversationProcessKind, ConversationRuntimeSegmentRecord } from '@zeus/storage';

interface TurnIdentity {
  conversationId: string;
  turnId: string;
  segment: ConversationRuntimeSegmentRecord;
}

interface NativeItemProjection extends TurnIdentity {
  providerItemId: string;
  itemType: string;
  status: 'in_progress' | 'completed' | 'failed';
  payload: Record<string, unknown>;
  text: string;
  occurredAt: string;
}

/** 将 Provider 事件收敛为稳定、可持久化且不宣称隐藏思维链的处理过程。 */
export class TurnProcessProjector {
  constructor(private readonly execution: ConversationExecutionRepository) {}

  projectNativeItem(input: NativeItemProjection): ConversationProcessItemRecord | null {
    const kind = nativeProcessKind(input.itemType);
    if (!kind) return null;
    return this.execution.appendProcessItem({
      conversationId: input.conversationId,
      turnId: input.turnId,
      segmentId: input.segment.id,
      kind,
      status: input.status,
      title: processTitle(kind, input.itemType),
      detail: { provider: input.segment.runtimeKind, itemType: input.itemType, payload: input.payload, text: input.text },
      sourceEventId: `${input.segment.runtimeKind}:item:${input.providerItemId}`,
      startedAt: input.occurredAt,
      completedAt: input.status === 'in_progress' ? null : input.occurredAt,
    });
  }

  projectPiEvent(identity: TurnIdentity, event: AgentRuntimeEvent): ConversationProcessItemRecord[] {
    const payload = asRecord(event.payload);
    if (event.type === 'message_end') {
      const message = asRecord(payload.message);
      const blocks = Array.isArray(message.content) ? message.content : [];
      const records: ConversationProcessItemRecord[] = [];
      for (const [index, candidate] of blocks.entries()) {
        const block = asRecord(candidate);
        const type = typeof block.type === 'string' ? block.type : '';
        if (type !== 'thinking' && type !== 'reasoning' && type !== 'toolCall' && type !== 'tool_use') continue;
        const kind: ConversationProcessKind = type === 'thinking' || type === 'reasoning' ? 'reasoning' : 'tool';
        const sourceId = typeof block.id === 'string' ? block.id : `${event.sequence}:${index}`;
        records.push(this.execution.appendProcessItem({
          conversationId: identity.conversationId,
          turnId: identity.turnId,
          segmentId: identity.segment.id,
          kind,
          status: 'completed',
          title: processTitle(kind, type),
          detail: { provider: 'pi', block },
          sourceEventId: `pi:block:${sourceId}`,
          startedAt: event.createdAt,
          completedAt: event.createdAt,
        }));
      }
      return records;
    }
    const mapped = piEventKind(event.type);
    if (!mapped) return [];
    const sourceId = typeof payload.toolCallId === 'string' ? payload.toolCallId : typeof payload.attempt === 'number' ? String(payload.attempt) : String(event.sequence);
    const ending = /(_end|_settled|_complete|_completed)$/.test(event.type);
    const failed = event.type === 'runtime_error' || payload.error !== undefined;
    return [this.execution.appendProcessItem({
      conversationId: identity.conversationId,
      turnId: identity.turnId,
      segmentId: identity.segment.id,
      kind: mapped,
      status: failed ? 'failed' : ending ? 'completed' : 'in_progress',
      title: processTitle(mapped, event.type),
      detail: { provider: 'pi', eventType: event.type, payload },
      sourceEventId: `pi:${event.type.replace(/_(start|end|complete|completed)$/, '')}:${sourceId}`,
      startedAt: event.createdAt,
      completedAt: failed || ending ? event.createdAt : null,
    })];
  }
}

function nativeProcessKind(itemType: string): ConversationProcessKind | null {
  if (itemType === 'reasoning') return 'reasoning';
  if (itemType === 'commandExecution') return 'command';
  if (itemType === 'contextCompaction') return 'context_compaction';
  if (itemType === 'warning' || itemType === 'error') return 'warning';
  if (/tool|fileChange|webSearch|image/i.test(itemType)) return 'tool';
  return null;
}

function piEventKind(type: string): ConversationProcessKind | null {
  if (/compaction/i.test(type)) return 'context_compaction';
  if (/retry/i.test(type)) return 'retry';
  if (/tool_execution|tool_call|toolcall/i.test(type)) return 'tool';
  if (/thinking|reasoning/i.test(type)) return 'reasoning';
  if (/waiting|approval|input_required/i.test(type)) return 'waiting';
  if (type === 'runtime_error' || /warning/i.test(type)) return 'warning';
  return null;
}

function processTitle(kind: ConversationProcessKind, source: string): string {
  if (kind === 'reasoning') return '思考摘要';
  if (kind === 'command') return '执行命令';
  if (kind === 'retry') return '自动重试';
  if (kind === 'context_compaction') return '上下文压缩';
  if (kind === 'waiting') return '等待用户操作';
  if (kind === 'warning') return '运行警告';
  return source === 'fileChange' ? '修改文件' : '调用工具';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
