import type { ConversationExpertRepository, ConversationTurnRepository } from '@zeus/storage';

const routedExpertEventTypes = new Set([
  'conversation.item.started',
  'conversation.item.delta',
  'conversation.item.completed',
  'conversation.request.created',
  'conversation.request.changed',
  'conversation.request.resolved',
  'conversation.request.snoozed',
  'conversation.plugin_app.created',
]);

/** 把隐藏专家通道的实时事件投影回父会话；子通道用户提示不进入群聊正文。 */
export function routeConversationExpertEvent(input: {
  type: string;
  payload: Record<string, unknown>;
  experts: Pick<ConversationExpertRepository, 'getActiveExecutionByChildConversation'>;
  turns: Pick<ConversationTurnRepository, 'listByConversation'>;
}): { type: string; payload: Record<string, unknown> } | null {
  const sourceConversationId = typeof input.payload.conversationId === 'string' ? input.payload.conversationId : null;
  const execution = sourceConversationId ? input.experts.getActiveExecutionByChildConversation(sourceConversationId) : undefined;
  if (!execution || !routedExpertEventTypes.has(input.type)) return { type: input.type, payload: input.payload };

  const parentTurn = input.turns.listByConversation(execution.conversationId).find((turn) => turn.clientSubmissionId === execution.submissionId);
  const actor = parseRecord(execution.employeeSnapshotJson);
  const itemType = typeof input.payload.itemType === 'string' ? input.payload.itemType : '';
  if (input.type.startsWith('conversation.item.') && itemType === 'userMessage') return null;
  if (input.type.startsWith('conversation.item.') && itemType === 'agentMessage') {
    return {
      type: 'conversation.expert.execution.changed',
      payload: {
        conversationId: execution.conversationId,
        sourceConversationId,
        threadId: `expert-room:${execution.conversationId}`,
        ...(parentTurn ? { turnId: parentTurn.id } : {}),
        execution: {
          id: execution.id,
          submissionId: execution.submissionId,
          ordinal: execution.ordinal,
          status: execution.status,
          actor,
          text: typeof input.payload.textContent === 'string' ? input.payload.textContent : '',
          error: execution.errorJson ? parseRecord(execution.errorJson) : null,
        },
      },
    };
  }

  const request = recordValue(input.payload.request) ? { ...input.payload.request, conversationId: execution.conversationId, ...(parentTurn ? { turnId: parentTurn.id } : {}), actor, expertExecutionId: execution.id } : input.payload.request;
  return {
    type: input.type,
    payload: {
      ...input.payload,
      conversationId: execution.conversationId,
      sourceConversationId,
      threadId: `expert-room:${execution.conversationId}`,
      ...(parentTurn ? { turnId: parentTurn.id } : {}),
      ...(typeof input.payload.itemId === 'string' ? { itemId: `${execution.id}:${input.payload.itemId}` } : {}),
      ...(recordValue(input.payload.itemPayload) ? { itemPayload: { ...input.payload.itemPayload, actor, expertExecutionId: execution.id, ordinal: execution.ordinal } } : {}),
      ...(request ? { request } : {}),
      actor,
      expertExecutionId: execution.id,
      ordinal: execution.ordinal,
    },
  };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return recordValue(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
