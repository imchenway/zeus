import type { ConversationRepository, ConversationSubmissionRepository, ZeusConversationSubmissionRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { coordinatorError } from './codexNativeConversationPolicy.js';

export function createCodexNativeConversationAccess(options: { conversations: Pick<ConversationRepository, 'getById'>; submissions: Pick<ConversationSubmissionRepository, 'getById'> }) {
  function requireProductConversation(conversationId: string): ZeusConversationWithMessagesRecord {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.transportKind !== 'codex_native') {
      throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native product conversation was not found.');
    }
    return conversation;
  }

  function requireConversation(conversationId: string): ZeusConversationWithMessagesRecord {
    const conversation = requireProductConversation(conversationId);
    if (conversation.agentKind !== 'codex') throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Codex native conversation was not found.');
    return conversation;
  }

  function requireOwnedSubmission(conversationId: string, submissionId: string): ZeusConversationSubmissionRecord {
    const submission = options.submissions.getById(submissionId);
    if (!submission || submission.conversationId !== conversationId) throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_FOUND', 'Native submission was not found.');
    return submission;
  }

  return { requireConversation, requireProductConversation, requireOwnedSubmission };
}
