import type { RuntimeSettings } from '../runtime/runtimeContracts.js';
import type { AppShellSettings, ClearLocalCachesResult, CodeMapSettings, ImportLocalSettingsRequest, ImportLocalSettingsResult, LocalSettingsExportSnapshot, UpdateAppShellSettingsRequest } from './settingsContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildSettingsCommandRequest, settingsClientCommandTypes } from './settingsCommandClient.js';

export interface SettingsApiClient {
  loadRuntimeSettings: () => Promise<RuntimeSettings>;
  saveRuntimeSettings: (input: RuntimeSettings) => Promise<RuntimeSettings>;
  loadCodeMapSettings: () => Promise<CodeMapSettings>;
  saveCodeMapSettings: (input: CodeMapSettings) => Promise<CodeMapSettings>;
  loadAppShellSettings: () => Promise<AppShellSettings>;
  saveAppShellSettings: (input: UpdateAppShellSettingsRequest) => Promise<AppShellSettings>;
  clearLocalCaches: () => Promise<ClearLocalCachesResult>;
  exportLocalSettings: () => Promise<LocalSettingsExportSnapshot>;
  importLocalSettings: (input: ImportLocalSettingsRequest) => Promise<ImportLocalSettingsResult>;
}

export function createSettingsApiClient(transport: LocalApiTransport): SettingsApiClient {
  return {
    loadRuntimeSettings: () => transport.request<RuntimeSettings>('/api/runtime/settings'),
    saveRuntimeSettings: async (input: RuntimeSettings) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.runtimeSettingsPut, scopeKind: 'settings', scopeId: 'runtime', operationPrefix: 'runtime_settings', value: input });
      return transport.request<RuntimeSettings>('/api/runtime/settings', jsonRequest('PUT', body));
    },
    loadCodeMapSettings: () => transport.request<CodeMapSettings>('/api/code-map/settings'),
    saveCodeMapSettings: async (input: CodeMapSettings) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.codeMapSettingsPut, scopeKind: 'settings', scopeId: 'code-map', operationPrefix: 'code_map_settings', value: input });
      return transport.request<CodeMapSettings>('/api/code-map/settings', jsonRequest('PUT', body));
    },
    loadAppShellSettings: () => transport.request<AppShellSettings>('/api/settings/app-shell'),
    saveAppShellSettings: async (input: UpdateAppShellSettingsRequest) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.appShellSettingsPut, scopeKind: 'settings', scopeId: 'app-shell', operationPrefix: 'app_shell_settings', value: input });
      return transport.request<AppShellSettings>('/api/settings/app-shell', jsonRequest('PUT', body));
    },
    clearLocalCaches: async () => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.projectionCacheClear, scopeKind: 'settings', scopeId: 'projection-cache', operationPrefix: 'projection_cache_clear', value: {} });
      return transport.request<ClearLocalCachesResult>('/api/settings/code-graph-cache/clear', jsonRequest('POST', body));
    },
    exportLocalSettings: () => transport.request<LocalSettingsExportSnapshot>('/api/settings/export'),
    importLocalSettings: async (input) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.settingsImport, scopeKind: 'settings', scopeId: 'local-settings-import', operationPrefix: 'settings_import', value: input });
      return transport.request<ImportLocalSettingsResult>('/api/settings/import', jsonRequest('POST', body));
    },
  };
}
