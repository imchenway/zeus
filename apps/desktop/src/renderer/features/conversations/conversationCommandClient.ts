import { type CommandEnvelope } from '@zeus/shared';
import { buildRendererCommandRequest, randomIdentity, type RendererCommandPayload } from '../../commandRequest.js';

export const conversationClientCommandTypes = {
  nextTurnSettingsUpdate: 'conversation.next_turn_settings.update',
  permissionModeUpdate: 'conversation.permission_mode.update',
  collaborationModeUpdate: 'conversation.collaboration_mode.update',
  goalSet: 'conversation.goal.set',
  goalPause: 'conversation.goal.pause',
  goalResume: 'conversation.goal.resume',
  goalClear: 'conversation.goal.clear',
  attentionAcknowledge: 'conversation.attention.acknowledge',
  providerThreadRestore: 'conversation.provider_thread.restore',
  archive: 'conversation.archive',
  restore: 'conversation.restore',
} as const;

type ConversationClientCommandType = (typeof conversationClientCommandTypes)[keyof typeof conversationClientCommandTypes];

/** Transport 内部重连或重试必须复用此处一次构造的不可变 Body。 */
export async function buildConversationCommandRequest<TInput extends object>(input: {
  commandType: ConversationClientCommandType;
  conversationId: string;
  expectedRevision?: number | null;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `conversation_operation_${randomIdentity()}`;
  return buildRendererCommandRequest({
    commandType: input.commandType,
    commandIdPrefix: 'command_conversation_',
    actorId: 'zeus-desktop-conversation',
    scopeKind: 'product_conversation',
    scopeId: input.conversationId,
    expectedRevision: input.expectedRevision,
    operationIdentity,
    value: input.value,
  });
}
