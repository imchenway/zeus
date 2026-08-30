import type {
  CreateTelegramImConnectionInput,
  ImConnectionSnapshot,
  ImPairingSessionSnapshot,
  ImProjectSelectionOption,
  ImSettingsSnapshot,
  ImTelegramConnectionCreated,
  ImTelegramConnectionLogEntry,
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
  UpdateTelegramImConnectionInput,
} from './telegramContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildTelegramCommandRequest, telegramClientCommandTypes } from './telegramCommandClient.js';

export interface TelegramApiClient {
  loadImSettings: () => Promise<ImSettingsSnapshot>;
  loadImOptions: () => Promise<ImProjectSelectionOption[]>;
  createTelegramImConnection: (input: CreateTelegramImConnectionInput) => Promise<ImTelegramConnectionCreated>;
  recreateTelegramImPairing: (connectionId: string) => Promise<ImTelegramConnectionCreated>;
  loadTelegramImPairing: (connectionId: string) => Promise<{ connection: ImConnectionSnapshot; pairing: ImPairingSessionSnapshot | null }>;
  checkTelegramImConnection: (connectionId: string) => Promise<ImConnectionSnapshot>;
  updateTelegramImConnection: (connectionId: string, input: UpdateTelegramImConnectionInput) => Promise<ImConnectionSnapshot>;
  removeTelegramImConnection: (connectionId: string) => Promise<{ removed: boolean; connectionId: string }>;
  loadTelegramImConnectionLogs: (connectionId: string) => Promise<ImTelegramConnectionLogEntry[]>;
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
    method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    path: string;
  }): Promise<TResult> => {
    const body = await buildTelegramCommandRequest(input);
    return transport.request<TResult>(input.path, jsonRequest(input.method, body));
  };

  const pollingCommand = <TResult>(commandType: typeof telegramClientCommandTypes.pollingStart | typeof telegramClientCommandTypes.pollingStop | typeof telegramClientCommandTypes.pollingOnce, operationPrefix: string, path: string) =>
    command<Record<string, never>, TResult>({ commandType, scopeId: 'telegram.polling', operationPrefix, value: {}, method: 'POST', path });

  return {
    loadImSettings: () => transport.request('/api/im/settings'),
    loadImOptions: () => transport.request('/api/im/options'),
    createTelegramImConnection: (value) =>
      command({ commandType: telegramClientCommandTypes.imConnectionCreate, scopeId: 'im.telegram.connections', operationPrefix: 'im_telegram_connection_create', value, method: 'POST', path: '/api/im/telegram/connections' }),
    recreateTelegramImPairing: (connectionId) =>
      command({
        commandType: telegramClientCommandTypes.imConnectionRepair,
        scopeId: `im.connection.${connectionId}`,
        operationPrefix: 'im_telegram_pairing_create',
        value: {},
        method: 'POST',
        path: `/api/im/telegram/connections/${encodeURIComponent(connectionId)}/pairing`,
      }),
    loadTelegramImPairing: (connectionId) => transport.request(`/api/im/telegram/connections/${encodeURIComponent(connectionId)}/pairing`),
    checkTelegramImConnection: (connectionId) =>
      command({
        commandType: telegramClientCommandTypes.imConnectionCheck,
        scopeId: `im.connection.${connectionId}`,
        operationPrefix: 'im_telegram_connection_check',
        value: {},
        method: 'POST',
        path: `/api/im/telegram/connections/${encodeURIComponent(connectionId)}/check`,
      }),
    updateTelegramImConnection: (connectionId, value) =>
      command({
        commandType: telegramClientCommandTypes.imConnectionUpdate,
        scopeId: `im.connection.${connectionId}`,
        operationPrefix: 'im_telegram_connection_update',
        value,
        method: 'PATCH',
        path: `/api/im/telegram/connections/${encodeURIComponent(connectionId)}`,
      }),
    removeTelegramImConnection: (connectionId) =>
      command({
        commandType: telegramClientCommandTypes.imConnectionRemove,
        scopeId: `im.connection.${connectionId}`,
        operationPrefix: 'im_telegram_connection_remove',
        value: {},
        method: 'DELETE',
        path: `/api/im/telegram/connections/${encodeURIComponent(connectionId)}`,
      }),
    loadTelegramImConnectionLogs: (connectionId) => transport.request(`/api/im/telegram/connections/${encodeURIComponent(connectionId)}/logs`),
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
