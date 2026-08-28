import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope } from '@zeus/shared';

export const telegramClientCommandTypes = {
  securityReset: 'security.reset',
  notificationSettingsUpdate: 'telegram.notification_settings.update',
  connectionTest: 'telegram.connection.test',
  securitySettingsUpdate: 'telegram.security_settings.update',
  dispatchPreview: 'telegram.dispatch_preview',
  settingsUpdate: 'telegram.settings.update',
  pollingStart: 'telegram.polling.start',
  pollingStop: 'telegram.polling.stop',
  pollingOnce: 'telegram.polling.poll_once',
} as const;

type TelegramClientCommandType = (typeof telegramClientCommandTypes)[keyof typeof telegramClientCommandTypes];
type TelegramCommandPayload = { operationIdentity: string; inputSha256: string };

/** 每次用户意图只生成一次不可变正文；Local transport 的连接刷新会 byte-identical 重用该 Body。 */
export async function buildTelegramCommandRequest<TInput extends object>(input: {
  commandType: TelegramClientCommandType;
  scopeId: string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<TelegramCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_telegram_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-telegram-settings' },
      scope: { kind: 'settings', id: input.scopeId },
      expectedRevision: null,
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
