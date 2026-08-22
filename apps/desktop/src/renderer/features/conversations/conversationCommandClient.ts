import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope } from '@zeus/shared';

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
type ConversationCommandPayload = { operationIdentity: string; inputSha256: string };

/** Transport 内部重连或重试必须复用此处一次构造的不可变 Body。 */
export async function buildConversationCommandRequest<TInput extends object>(input: {
  commandType: ConversationClientCommandType;
  conversationId: string;
  expectedRevision?: number | null;
  value: TInput;
}): Promise<{ command: CommandEnvelope<ConversationCommandPayload>; input: TInput }> {
  const operationIdentity = `conversation_operation_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_conversation_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-conversation' },
      scope: { kind: 'product_conversation', id: input.conversationId },
      expectedRevision: input.expectedRevision ?? null,
      idempotencyKey: `${input.commandType}:${operationIdentity}`,
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity, inputSha256 },
    },
    input: input.value,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomIdentity(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
