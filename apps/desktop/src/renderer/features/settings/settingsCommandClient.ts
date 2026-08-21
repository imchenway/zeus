import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

export const settingsClientCommandTypes = {
  projectDatabaseSecretPut: 'settings.project_database_secret.put',
  projectDatabaseSecretDelete: 'settings.project_database_secret.delete',
  projectConfigPut: 'settings.project_config.put',
  runtimeSettingsPut: 'settings.runtime.put',
  appShellSettingsPut: 'settings.app_shell.put',
  projectionCacheClear: 'settings.projection_cache.clear',
  settingsImport: 'settings.import',
  dataImport: 'settings.business_data.import',
  codeMapSettingsPut: 'settings.code_map.put',
} as const;

type SettingsClientCommandType = (typeof settingsClientCommandTypes)[keyof typeof settingsClientCommandTypes];
type SettingsClientScopeKind = Extract<CommandScopeKind, 'project' | 'settings'>;
type SettingsCommandPayload = { operationIdentity: string; inputSha256: string };

/** 每次 UI 意图仅创建一个不可变请求；传输层刷新连接时复用同一 JSON body。 */
export async function buildSettingsCommandRequest<TInput extends object>(input: {
  commandType: SettingsClientCommandType;
  scopeKind: SettingsClientScopeKind;
  scopeId: string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<SettingsCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_settings_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-settings' },
      scope: { kind: input.scopeKind, id: input.scopeId },
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
