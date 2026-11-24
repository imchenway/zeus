import type { AgentRuntimeEvent, ModelProtocolFamily } from '@zeus/ai-runtime';
import type { ConversationExecutionRepository, ConversationProcessItemRecord, ConversationProcessKind, ConversationRuntimeSegmentRecord } from '@zeus/storage';
import type { CodexRolloutRequestUserInputEvidence } from './codexRolloutRequestUserInput.js';

interface TurnIdentity {
  conversationId: string;
  turnId: string;
  segment: ConversationRuntimeSegmentRecord;
}

/** SDK 事件进入 Zeus 会话语义时携带冻结协议与展示阶段。 */
interface PiTurnIdentity extends TurnIdentity {
  /** 本次执行快照冻结的线协议族。 */
  protocolFamily: ModelProtocolFamily | 'copilot_sdk' | 'antigravity_acp';
  /** 当前 Assistant 响应对应的稳定展示阶段；旧事件允许为空。 */
  stageId: string | null;
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

  projectRecoveredRequestUserInput(
    input: TurnIdentity & { evidence: CodexRolloutRequestUserInputEvidence; providerThreadId: string; turnTerminal: boolean; turnCompletedAt: string | null; observedAt: string },
  ): ConversationProcessItemRecord {
    const terminalWithoutOutput = input.turnTerminal && input.evidence.outcome === 'pending';
    const outcome = terminalWithoutOutput ? 'resolved' : input.evidence.outcome;
    const completedAt = input.evidence.resolvedAt ?? (input.turnTerminal ? (input.turnCompletedAt ?? input.observedAt) : null);
    const containsSecret = input.evidence.questions.some((question) => question.isSecret);
    return this.execution.appendProcessItem({
      conversationId: input.conversationId,
      turnId: input.turnId,
      segmentId: input.segment.id,
      kind: 'waiting',
      status: outcome === 'pending' ? 'in_progress' : 'completed',
      title: '等待用户操作',
      detail: {
        provider: 'codex',
        itemType: 'requestUserInput',
        requestType: 'request_user_input',
        recovery: 'content_only',
        submissionAuthority: 'unavailable',
        providerThreadId: input.providerThreadId,
        providerTurnId: input.evidence.providerTurnId,
        providerItemId: input.evidence.providerItemId,
        callId: input.evidence.callId,
        questions: input.evidence.questions,
        outcome,
        ...(input.evidence.answers && !containsSecret ? { answers: input.evidence.answers } : {}),
        ...(terminalWithoutOutput ? { resolutionReason: 'turn_terminal' } : {}),
      },
      sourceEventId: `codex:rollout-request-user-input:${input.evidence.providerItemId}`,
      startedAt: input.evidence.occurredAt ?? input.observedAt,
      completedAt,
    });
  }

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

  projectPiEvent(identity: PiTurnIdentity, event: AgentRuntimeEvent): ConversationProcessItemRecord[] {
    const payload = asRecord(event.payload);
    if (event.type === 'message_end') {
      const message = asRecord(payload.message);
      const blocks = Array.isArray(message.content) ? message.content : [];
      const records: ConversationProcessItemRecord[] = [];
      const failed = message.stopReason === 'error' || message.stopReason === 'aborted';
      for (const [index, candidate] of blocks.entries()) {
        const block = asRecord(candidate);
        const type = typeof block.type === 'string' ? block.type : '';
        const failureText = failed && type === 'text';
        if (!failureText && type !== 'thinking' && type !== 'reasoning' && type !== 'toolCall' && type !== 'tool_use') continue;
        const kind: ConversationProcessKind = failureText ? 'warning' : type === 'thinking' || type === 'reasoning' ? 'reasoning' : 'tool';
        const sourceId = typeof block.id === 'string' ? block.id : `${identity.stageId ?? event.nativeRunId}:${index}`;
        /** 工具声明和执行进度使用同一个身份，声明本身不代表执行完成。 */
        const sourceEventId = kind === 'tool' ? `${event.agentKind}:tool_execution:${sourceId}` : `${event.agentKind}:block:${sourceId}`;
        /** 重放旧的声明时不能回退已完成调用的结果。 */
        const existing = kind === 'tool' ? this.execution.processItemBySourceEventId(identity.segment.id, sourceEventId) : undefined;
        if (existing) {
          records.push(existing);
          continue;
        }
        records.push(
          this.execution.appendProcessItem({
            conversationId: identity.conversationId,
            turnId: identity.turnId,
            segmentId: identity.segment.id,
            kind,
            status: failureText ? 'failed' : kind === 'tool' ? 'in_progress' : 'completed',
            title: failureText ? (message.stopReason === 'aborted' ? '运行已中止' : '运行错误') : processTitle(kind, type),
            detail: {
              provider: event.agentKind,
              protocolFamily: identity.protocolFamily,
              stageId: identity.stageId,
              // Pi 各协议返回的思考正文都属于可回看的过程正文，不能只保留 Anthropic。
              ...(kind === 'reasoning' ? { reasoningPresentation: 'process_text' } : {}),
              block,
            },
            sourceEventId,
            startedAt: event.createdAt,
            completedAt: kind === 'tool' ? null : event.createdAt,
          }),
        );
      }
      return records;
    }
    const mapped = piEventKind(event.type);
    if (!mapped) return [];
    const thoughtId = event.agentKind === 'antigravity' && mapped === 'reasoning' && typeof payload.reasoningId === 'string' ? payload.reasoningId : null;
    const sourceId = typeof payload.toolCallId === 'string' ? payload.toolCallId : typeof payload.attempt === 'number' ? String(payload.attempt) : String(event.sequence);
    /** ACP 摘要与工具的分段都更新同一条记录。 */
    const sourceEventId = thoughtId
      ? `antigravity:reasoning:${thoughtId}`
      : mapped === 'tool'
        ? `${event.agentKind}:tool_execution:${sourceId}`
        : `${event.agentKind}:${event.type.replace(/_(start|end|complete|completed)$/, '')}:${sourceId}`;
    const previous = mapped === 'tool' || thoughtId ? this.execution.processItemBySourceEventId(identity.segment.id, sourceEventId) : undefined;
    /** 已确认的终态不回退；同一 ACP 调用的真实结果可补齐原先的未知结果。 */
    /** 只合并同一调用的事件内容，不读取其他轮次。 */
    const previousDetail = previous ? asRecord(JSON.parse(previous.detailJson)) : {};
    const lateResult = event.agentKind === 'antigravity' && payload.lateResult === true && previous?.turnId === identity.turnId && asRecord(previousDetail.payload).outcome === 'outcome_unknown';
    if (event.agentKind === 'antigravity' && previous && previous.turnId !== identity.turnId) return [];
    if (previous && previous.status !== 'in_progress' && !lateResult) return [previous];
    const ending = /(_end|_settled|_complete|_completed)$/.test(event.type);
    const failed = event.type === 'runtime_error' || payload.error !== undefined || payload.isError === true;
    return [
      this.execution.appendProcessItem({
        conversationId: identity.conversationId,
        turnId: identity.turnId,
        segmentId: identity.segment.id,
        kind: mapped,
        status: failed ? 'failed' : ending ? 'completed' : 'in_progress',
        title: event.agentKind === 'antigravity' && mapped === 'tool' && typeof payload.toolName === 'string' ? payload.toolName : processTitle(mapped, event.type),
        detail: {
          ...previousDetail,
          provider: event.agentKind,
          protocolFamily: identity.protocolFamily,
          stageId: previousDetail.stageId ?? identity.stageId,
          eventType: event.type,
          ...(thoughtId ? { reasoningPresentation: 'process_text', text: Array.isArray(payload.summary) ? payload.summary.join('') : '' } : {}),
          payload: { ...asRecord(previousDetail.payload), ...(lateResult ? { summary: undefined } : {}), ...payload },
        },
        sourceEventId,
        startedAt: event.createdAt,
        completedAt: failed || ending ? event.createdAt : null,
      }),
    ];
  }
}

function nativeProcessKind(itemType: string): ConversationProcessKind | null {
  if (itemType === 'reasoning') return 'reasoning';
  if (itemType === 'commandExecution') return 'command';
  if (itemType === 'contextCompaction') return 'context_compaction';
  if (itemType === 'contextUpdate') return 'context_update';
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
  if (kind === 'context_update') return 'AGENTS.md 规则更新';
  if (kind === 'waiting') return '等待用户操作';
  if (kind === 'warning') return '运行警告';
  return source === 'fileChange' ? '修改文件' : '调用工具';
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
