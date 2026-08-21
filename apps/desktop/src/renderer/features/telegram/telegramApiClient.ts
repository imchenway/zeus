import type {
  SecurityResetResult,
  TelegramDispatchPreviewInput,
  TelegramDispatchPreviewResult,
  TelegramNotificationSettings,
  TelegramPollingLogEntry,
  TelegramPollingStatus,
  TelegramSecuritySettings,
  TelegramSettingsSnapshot,
  TelegramStatusSnapshot,
  TelegramTestConnectionResult,
  UpdateTelegramSettingsRequest,
} from './telegramContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildTelegramCommandRequest, telegramClientCommandTypes } from './telegramCommandClient.js';

export interface TelegramApiClient {
  resetSecurity: () => Promise<SecurityResetResult>;
  loadTelegramStatus: () => Promise<TelegramStatusSnapshot>;
  saveTelegramSettings: (input: UpdateTelegramSettingsRequest) => Promise<TelegramSettingsSnapshot>;
  startTelegram: () => Promise<TelegramPollingStatus>;
  stopTelegram: () => Promise<TelegramPollingStatus>;
  loadTelegramPollingStatus: () => Promise<TelegramPollingStatus>;
  loadTelegramPollingLogs: () => Promise<TelegramPollingLogEntry[]>;
  loadTelegramMessages: () => Promise<TelegramPollingLogEntry[]>;
  startTelegramPolling: () => Promise<TelegramPollingStatus>;
  stopTelegramPolling: () => Promise<TelegramPollingStatus>;
  pollTelegramOnce: () => Promise<TelegramPollingStatus>;
  testTelegramConnection: () => Promise<TelegramTestConnectionResult>;
  loadTelegramNotificationSettings: () => Promise<TelegramNotificationSettings>;
  saveTelegramNotificationSettings: (input: TelegramNotificationSettings) => Promise<TelegramNotificationSettings>;
  loadTelegramSecuritySettings: () => Promise<TelegramSecuritySettings>;
  saveTelegramSecuritySettings: (input: TelegramSecuritySettings) => Promise<TelegramSecuritySettings>;
  dispatchTelegramPreview: (input: TelegramDispatchPreviewInput) => Promise<TelegramDispatchPreviewResult>;
}

export function createTelegramApiClient(transport: LocalApiTransport): TelegramApiClient {
  const command = async <TInput extends object, TResult>(input: {
    commandType: Parameters<typeof buildTelegramCommandRequest>[0]['commandType'];
    scopeId: string;
    operationPrefix: string;
    value: TInput;
    method: 'POST' | 'PUT' | 'PATCH';
    path: string;
  }): Promise<TResult> => {
    const body = await buildTelegramCommandRequest(input);
    return transport.request<TResult>(input.path, jsonRequest(input.method, body));
  };

  const pollingCommand = <TResult>(commandType: typeof telegramClientCommandTypes.pollingStart | typeof telegramClientCommandTypes.pollingStop | typeof telegramClientCommandTypes.pollingOnce, operationPrefix: string, path: string) =>
    command<Record<string, never>, TResult>({ commandType, scopeId: 'telegram.polling', operationPrefix, value: {}, method: 'POST', path });

  return {
    resetSecurity: () => command({ commandType: telegramClientCommandTypes.securityReset, scopeId: 'security.reset', operationPrefix: 'security_reset', value: {}, method: 'POST', path: '/api/security/reset' }),
    loadTelegramStatus: () => transport.request('/api/telegram/status'),
    saveTelegramSettings: (value) => command({ commandType: telegramClientCommandTypes.settingsUpdate, scopeId: 'telegram.settings', operationPrefix: 'telegram_settings_update', value, method: 'PATCH', path: '/api/telegram/settings' }),
    startTelegram: () => pollingCommand(telegramClientCommandTypes.pollingStart, 'telegram_polling_start', '/api/telegram/start'),
    stopTelegram: () => pollingCommand(telegramClientCommandTypes.pollingStop, 'telegram_polling_stop', '/api/telegram/stop'),
    loadTelegramPollingStatus: () => transport.request('/api/telegram/polling/status'),
    loadTelegramPollingLogs: () => transport.request('/api/telegram/polling/logs'),
    loadTelegramMessages: () => transport.request('/api/telegram/messages'),
    startTelegramPolling: () => pollingCommand(telegramClientCommandTypes.pollingStart, 'telegram_polling_start', '/api/telegram/polling/start'),
    stopTelegramPolling: () => pollingCommand(telegramClientCommandTypes.pollingStop, 'telegram_polling_stop', '/api/telegram/polling/stop'),
    pollTelegramOnce: () => pollingCommand(telegramClientCommandTypes.pollingOnce, 'telegram_polling_once', '/api/telegram/polling/poll-once'),
    testTelegramConnection: () => command({ commandType: telegramClientCommandTypes.connectionTest, scopeId: 'telegram.connection-test', operationPrefix: 'telegram_connection_test', value: {}, method: 'POST', path: '/api/telegram/test' }),
    loadTelegramNotificationSettings: () => transport.request('/api/telegram/notification-settings'),
    saveTelegramNotificationSettings: (value) =>
      command({
        commandType: telegramClientCommandTypes.notificationSettingsUpdate,
        scopeId: 'telegram.notification-settings',
        operationPrefix: 'telegram_notification_settings_update',
        value,
        method: 'PUT',
        path: '/api/telegram/notification-settings',
      }),
    loadTelegramSecuritySettings: () => transport.request('/api/telegram/security-settings'),
    saveTelegramSecuritySettings: (value) =>
      command({ commandType: telegramClientCommandTypes.securitySettingsUpdate, scopeId: 'telegram.security-settings', operationPrefix: 'telegram_security_settings_update', value, method: 'PUT', path: '/api/telegram/security-settings' }),
    dispatchTelegramPreview: (value) =>
      command({ commandType: telegramClientCommandTypes.dispatchPreview, scopeId: 'telegram.dispatch-preview', operationPrefix: 'telegram_dispatch_preview', value, method: 'POST', path: '/api/telegram/dispatch-preview' }),
  };
}
