import type { SessionEvent } from '@github/copilot-sdk';
import type { AgentRuntimeEvent } from './agentRuntimeContracts.js';

/** 把 Copilot SDK 的事件映射到 Core 既有的会话处理阶段，保留原生事件身份。 */
export class CopilotSdkEventAdapter {
  private sequence = 0;
  private readonly pendingMessages = new Map<string, Extract<SessionEvent, { type: 'assistant.message' }>>();
  private readonly usageByCall = new Map<string, Extract<SessionEvent, { type: 'assistant.usage' }>>();
  private readonly accountedCalls = new Set<string>();

  /** 每个适配器只属于一个原生会话和一个当前 Zeus 轮次。 */
  constructor(
    private readonly sessionId: string,
    private readonly runId: string,
    private readonly generationId: string,
  ) {}

  /** 顺序交付流式正文、完整消息、工具和终态；用量与消息按 API call 身份配对。 */
  accept(event: SessionEvent): AgentRuntimeEvent[] {
    if (event.agentId || event.checkpoint) return [];
    switch (event.type) {
      case 'assistant.message_start':
        return [this.wrap(event, 'message_start', { message: { id: event.data.messageId, role: 'assistant' } })];
      case 'assistant.message_delta':
        return [this.wrap(event, 'message_update', { message: { id: event.data.messageId, role: 'assistant' }, assistantMessageEvent: { type: 'text_delta', delta: event.data.deltaContent } })];
      case 'assistant.message': {
        this.pendingMessages.set(event.data.messageId, event);
        const usage = event.data.apiCallId ? this.usageByCall.get(event.data.apiCallId) : undefined;
        return usage ? this.flushMessage(event, usage) : [];
      }
      case 'assistant.usage': {
        if (!event.data.apiCallId) return [];
        this.usageByCall.set(event.data.apiCallId, event);
        const message = [...this.pendingMessages.values()].find((candidate) => candidate.data.apiCallId === event.data.apiCallId);
        return message ? this.flushMessage(message, event) : [];
      }
      case 'tool.execution_start':
        return [this.wrap(event, 'tool_execution_start', { toolCallId: event.data.toolCallId, toolName: event.data.toolName, arguments: event.data.arguments })];
      case 'tool.execution_complete':
        return [this.wrap(event, 'tool_execution_end', { toolCallId: event.data.toolCallId, result: event.data.result })];
      case 'session.idle': {
        const remaining = [...this.pendingMessages.values()].flatMap((message) => this.flushMessage(message, message.data.apiCallId ? this.usageByCall.get(message.data.apiCallId) : undefined));
        return [...remaining, this.wrap(event, 'agent_settled', {})];
      }
      case 'session.error':
        return [this.wrap(event, 'runtime_error', { code: 'ZEUS_COPILOT_RUNTIME_ERROR', message: event.data.message })];
      default:
        return event.type.startsWith('session.compaction_') || event.type.startsWith('assistant.reasoning_') ? [this.wrap(event, event.type.replaceAll('.', '_'), event.data)] : [];
    }
  }

  /** 一次模型调用的真实用量只随最后一条完整消息记账。 */
  private flushMessage(message: Extract<SessionEvent, { type: 'assistant.message' }>, usage?: Extract<SessionEvent, { type: 'assistant.usage' }>): AgentRuntimeEvent[] {
    if (!this.pendingMessages.delete(message.data.messageId)) return [];
    const callId = message.data.apiCallId;
    const lastChunk = message.data.chunkCount === undefined || message.data.chunkIndex === message.data.chunkCount - 1;
    const shouldAccount = Boolean(usage && callId && lastChunk && !this.accountedCalls.has(callId));
    if (shouldAccount && callId) this.accountedCalls.add(callId);
    const cacheRead = shouldAccount ? (usage?.data.cacheReadTokens ?? 0) : 0;
    const cacheWrite = shouldAccount ? (usage?.data.cacheWriteTokens ?? 0) : 0;
    const input = shouldAccount ? Math.max(0, (usage?.data.inputTokens ?? 0) - cacheRead - cacheWrite) : 0;
    const output = shouldAccount ? (usage?.data.outputTokens ?? 0) : 0;
    const content = [
      ...(message.data.reasoningText ? [{ type: 'thinking', text: message.data.reasoningText }] : []),
      ...(message.data.content ? [{ type: 'text', text: message.data.content }] : []),
      ...(message.data.toolRequests ?? []).map((tool) => ({ type: 'toolCall', id: tool.toolCallId, name: tool.name, arguments: tool.arguments })),
    ];
    return [
      this.wrap(message, 'message_end', {
        message: {
          id: message.data.messageId,
          responseId: callId,
          role: 'assistant',
          content,
          stopReason: message.data.toolRequests?.length ? 'toolUse' : 'stop',
          ...(shouldAccount ? { usage: { input, output, cacheRead, cacheWrite, reasoning: usage?.data.reasoningTokens ?? 0, totalTokens: input + cacheRead + cacheWrite + output } } : {}),
        },
      }),
    ];
  }

  /** Core 事件使用连续序号和 SDK 时间戳，避免重排同一轮次的消息。 */
  private wrap(event: SessionEvent, type: string, payload: unknown): AgentRuntimeEvent {
    return { agentKind: 'copilot', runtimeInstanceId: this.generationId, nativeSessionId: this.sessionId, nativeRunId: this.runId, sequence: ++this.sequence, type, payload, createdAt: event.timestamp };
  }
}
