import type { RuntimeSettings } from '../runtime/runtimeContracts.js';
import type { AppShellSettings, ImportLocalSettingsRequest, ImportLocalSettingsResult, LocalSettingsExportSnapshot, UpdateAppShellSettingsRequest } from './settingsContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildSettingsCommandRequest, settingsClientCommandTypes } from './settingsCommandClient.js';

export interface SettingsApiClient {
  loadRuntimeSettings: () => Promise<RuntimeSettings>;
  saveRuntimeSettings: (input: RuntimeSettings) => Promise<RuntimeSettings>;
  loadAppShellSettings: () => Promise<AppShellSettings>;
  saveAppShellSettings: (input: UpdateAppShellSettingsRequest) => Promise<AppShellSettings>;
  exportLocalSettings: () => Promise<LocalSettingsExportSnapshot>;
  importLocalSettings: (input: ImportLocalSettingsRequest) => Promise<ImportLocalSettingsResult>;
}

export function createSettingsApiClient(transport: LocalApiTransport): SettingsApiClient {
  /** 设置页切换后仍按操作顺序写入，避免旧请求晚到覆盖新选择。 */
  let appShellSaveQueue: Promise<unknown> = Promise.resolve();
  return {
    loadRuntimeSettings: () => transport.request<RuntimeSettings>('/api/runtime/settings'),
    saveRuntimeSettings: async (input: RuntimeSettings) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.runtimeSettingsPut, scopeKind: 'settings', scopeId: 'runtime', operationPrefix: 'runtime_settings', value: input });
      return transport.request<RuntimeSettings>('/api/runtime/settings', jsonRequest('PUT', body));
    },
    loadAppShellSettings: () => transport.request<AppShellSettings>('/api/settings/app-shell'),
    saveAppShellSettings: (input: UpdateAppShellSettingsRequest) => {
      /** 失败继续交给调用方处理，同时允许后续修改正常保存。 */
      const result = appShellSaveQueue.then(async () => {
        /** 写入开始时创建命令，保证请求和顺序一致。 */
        const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.appShellSettingsPut, scopeKind: 'settings', scopeId: 'app-shell', operationPrefix: 'app_shell_settings', value: input });
        return transport.request<AppShellSettings>('/api/settings/app-shell', jsonRequest('PUT', body));
      });
      appShellSaveQueue = result.catch(() => undefined);
      return result;
    },
    exportLocalSettings: () => transport.request<LocalSettingsExportSnapshot>('/api/settings/export'),
    importLocalSettings: async (input) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.settingsImport, scopeKind: 'settings', scopeId: 'local-settings-import', operationPrefix: 'settings_import', value: input });
      return transport.request<ImportLocalSettingsResult>('/api/settings/import', jsonRequest('POST', body));
    },
  };
}
