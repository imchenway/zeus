import { type ConversationRepository, type ZeusConversationSubmissionRecord } from '@zeus/storage';

/** Provider 回显前先用 Zeus 已耐久接纳的 submission 投影用户消息。 */
export function projectLocallyAcceptedUserMessage(input: { conversations: ConversationRepository; submission: ZeusConversationSubmissionRecord; broadcast(event: string, payload: Record<string, unknown>): void }): void {
  const submissionInput = parseRecord(input.submission.inputJson);
  if (submissionInput.internalOperation === true) return;
  const displayText = typeof submissionInput.displayText === 'string' ? submissionInput.displayText.trim() : '';
  const text = typeof submissionInput.text === 'string' ? submissionInput.text : '';
  const hasVisibleResources =
    (Array.isArray(submissionInput.attachments) && submissionInput.attachments.length > 0) ||
    (Array.isArray(submissionInput.browserComments) && submissionInput.browserComments.length > 0) ||
    isRecord(submissionInput.conversationContext) ||
    isRecord(submissionInput.taskPushLayout);
  if (!displayText && !text && !hasVisibleResources) return;
  input.conversations.appendMessage({
    conversationId: input.submission.conversationId,
    role: 'user',
    content: displayText || text,
    source: 'zeus_local_submission',
    metadata: {
      inputOrigin: 'zeus_local',
      submissionId: input.submission.id,
      clientUserMessageId: input.submission.clientMessageId,
      ...(Array.isArray(submissionInput.attachments) && submissionInput.attachments.length ? { attachments: submissionInput.attachments } : {}),
      ...(isRecord(submissionInput.taskPushLayout) ? { taskPushLayout: submissionInput.taskPushLayout } : {}),
      ...(Array.isArray(submissionInput.browserComments) && submissionInput.browserComments.length ? { browserComments: submissionInput.browserComments } : {}),
      ...(isRecord(submissionInput.conversationContext) ? { conversationContext: submissionInput.conversationContext } : {}),
      ...(typeof submissionInput.origin === 'string' ? { origin: submissionInput.origin } : {}),
      ...(typeof submissionInput.planItemId === 'string' ? { planItemId: submissionInput.planItemId } : {}),
      ...(typeof submissionInput.requestAnswerId === 'string' ? { requestAnswerId: submissionInput.requestAnswerId } : {}),
    },
    createdAt: input.submission.createdAt,
    clientMessageId: input.submission.clientMessageId,
  });
  input.broadcast('conversation.queue.changed', { conversationId: input.submission.conversationId, submissionId: input.submission.id });
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
