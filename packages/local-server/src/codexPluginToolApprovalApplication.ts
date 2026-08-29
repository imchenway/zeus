import type { ConversationRepository, ConversationServerRequestRepository, ConversationTurnRepository, ZeusConversationServerRequestRecord } from '@zeus/storage';
import type { NativeAcceptedOperation, NativeConversationRunState, RespondNativeRequestInput } from './codexNativeConversationContracts.js';
import { coordinatorError, invalidServerRequestResponse, nativePendingRequestProjection, parseJsonRecord } from './codexNativeConversationPolicy.js';

export function createCodexPluginToolApprovalApplication(options: {
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  requests: ConversationServerRequestRepository;
  now(): string;
  operationId(): string;
  persist(): Promise<void>;
  broadcast(type: string, payload: Record<string, unknown>): void;
  setRunState(conversationId: string, state: NativeConversationRunState): void;
}) {
  const pending = new Map<string, { resolve(allowed: boolean): void; turnId: string }>();

  async function requestApproval(input: { conversationId: string; threadId: string; turnId: string; callId: string; generationId: string; namespace: string; tool: string; argumentKeys: string[] }): Promise<boolean> {
    const conversation = options.conversations.getById(input.conversationId);
    if (!conversation) throw coordinatorError('ZEUS_PLUGIN_TOOL_CONVERSATION_NOT_FOUND', 'Plugin 工具审批没有对应的持久会话。');
    const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerThreadId === input.threadId && candidate.providerTurnId === input.turnId);
    if (!turn) throw coordinatorError('ZEUS_PLUGIN_TOOL_TURN_NOT_FOUND', 'Plugin 工具审批没有对应的持久轮次。');
    const timestamp = options.now();
    options.turns.upsert({ ...turn, status: 'waiting', completedAt: null, updatedAt: timestamp });
    const request = options.requests.upsert({
      conversationId: conversation.id,
      turnId: turn.id,
      itemId: input.callId,
      transportGenerationId: input.generationId,
      providerRequestId: `plugin-tool:${input.callId}`,
      requestKind: 'command',
      payload: {
        zeusPluginToolApproval: true,
        threadId: input.threadId,
        turnId: input.turnId,
        callId: input.callId,
        command: `MCP ${input.namespace}.${input.tool}`,
        namespace: input.namespace,
        tool: input.tool,
        argumentKeys: input.argumentKeys,
        reason: 'Zeus Plugin MCP 工具按当前工具级策略需要审批。',
        availableDecisions: ['accept', 'decline', 'cancel'],
      },
      status: 'pending',
      createdAt: timestamp,
    });
    options.setRunState(conversation.id, { type: 'waiting', turnId: input.turnId, requestId: request.id, reason: 'approval' });
    options.conversations.markAttentionUnread(conversation.id, { kind: 'unread', turnId: input.turnId, occurredAt: timestamp });
    await options.persist();
    options.broadcast('conversation.request.created', {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      providerThreadId: input.threadId,
      providerTurnId: input.turnId,
      requestId: request.id,
      requestKind: 'command',
      request: nativePendingRequestProjection(request),
    });
    return new Promise<boolean>((resolveApproval) => pending.set(request.id, { resolve: resolveApproval, turnId: turn.id }));
  }

  async function tryRespond(request: ZeusConversationServerRequestRecord, response: RespondNativeRequestInput['response']): Promise<NativeAcceptedOperation | null> {
    const payload = parseJsonRecord(request.payloadJson);
    if (payload.zeusPluginToolApproval !== true) return null;
    if (response.type !== 'command') throw invalidServerRequestResponse('Response type does not match the pending Plugin MCP tool approval.');
    const channel = pending.get(request.id);
    if (!channel) throw coordinatorError('ZEUS_PLUGIN_TOOL_APPROVAL_CHANNEL_UNAVAILABLE', 'Plugin 工具审批通道已断开；Zeus 不会把历史允许决定套用于新调用。');
    const conversation = options.conversations.getById(request.conversationId);
    if (!conversation) throw coordinatorError('ZEUS_PLUGIN_TOOL_CONVERSATION_NOT_FOUND', 'Plugin 工具审批的会话已不存在。');
    pending.delete(request.id);
    const allowed = response.decision === 'accept' || response.decision === 'acceptForSession';
    options.requests.resolve(request.id, { response, resolvedAt: options.now() });
    const turn = options.turns.getById(channel.turnId);
    if (turn) options.turns.upsert({ ...turn, status: 'running', completedAt: null, updatedAt: options.now() });
    const providerTurnId = typeof payload.turnId === 'string' ? payload.turnId : (turn?.providerTurnId ?? '');
    options.setRunState(conversation.id, { type: 'active', turnId: providerTurnId, phase: 'prework' });
    channel.resolve(allowed);
    await options.persist();
    options.broadcast('conversation.request.resolved', {
      conversationId: conversation.id,
      projectId: conversation.projectId,
      providerThreadId: conversation.providerThreadId,
      providerTurnId: turn?.providerTurnId ?? null,
      requestId: request.id,
      requestKind: request.requestKind,
    });
    return {
      operationId: options.operationId(),
      conversationId: conversation.id,
      submissionId: turn?.clientSubmissionId ?? '',
      status: 'responded',
      providerThreadId: conversation.providerThreadId,
      providerTurnId: turn?.providerTurnId ?? null,
    };
  }

  function close(): void {
    for (const channel of pending.values()) channel.resolve(false);
    pending.clear();
  }

  return { requestApproval, tryRespond, close };
}
