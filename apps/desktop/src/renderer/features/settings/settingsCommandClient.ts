import { type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { buildRendererCommandRequest, randomIdentity, type RendererCommandPayload } from '../../commandRequest.js';

export const settingsClientCommandTypes = {
  projectDatabaseSecretPut: 'settings.project_database_secret.put',
  projectDatabaseSecretDelete: 'settings.project_database_secret.delete',
  projectConfigPut: 'settings.project_config.put',
  projectModelServiceTierPreferencePut: 'settings.project_model_service_tier_preference.put',
  runtimeSettingsPut: 'settings.runtime.put',
  appShellSettingsPut: 'settings.app_shell.put',
  projectionCacheClear: 'settings.projection_cache.clear',
  settingsImport: 'settings.import',
  dataImport: 'settings.business_data.import',
  codeMapSettingsPut: 'settings.code_map.put',
} as const;

type SettingsClientCommandType = (typeof settingsClientCommandTypes)[keyof typeof settingsClientCommandTypes];
type SettingsClientScopeKind = Extract<CommandScopeKind, 'project' | 'settings'>;

/** 每次 UI 意图仅创建一个不可变请求；传输层刷新连接时复用同一 JSON body。 */
export async function buildSettingsCommandRequest<TInput extends object>(input: {
  commandType: SettingsClientCommandType;
  scopeKind: SettingsClientScopeKind;
  scopeId: string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  return buildRendererCommandRequest({
    ...input,
    operationIdentity,
    commandIdPrefix: 'command_settings_',
    actorId: 'zeus-desktop-settings',
    expectedRevision: null,
  });
}
