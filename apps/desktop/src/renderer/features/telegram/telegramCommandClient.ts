import {type CommandEnvelope} from '@zeus/shared';
import {buildRendererCommandRequest, randomIdentity, type RendererCommandPayload} from '../../commandRequest.js';

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
  imConnectionCreate: 'im.telegram.connection.create',
  imConnectionRepair: 'im.telegram.connection.repair',
  imConnectionCheck: 'im.telegram.connection.check',
  imConnectionUpdate: 'im.telegram.connection.update',
  imConnectionRemove: 'im.telegram.connection.remove',
} as const;

type TelegramClientCommandType = (typeof telegramClientCommandTypes)[keyof typeof telegramClientCommandTypes];

/** 每次用户意图只生成一次不可变正文；Local transport 的连接刷新会 byte-identical 重用该 Body。 */
export async function buildTelegramCommandRequest<TInput extends object>(input: {
  commandType: TelegramClientCommandType;
  scopeId: string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
    return buildRendererCommandRequest({
        commandType: input.commandType,
        commandIdPrefix: 'command_telegram_',
        actorId: 'zeus-desktop-telegram-settings',
        scopeKind: 'settings',
        scopeId: input.scopeId,
        operationIdentity,
        value: input.value,
    });
}
