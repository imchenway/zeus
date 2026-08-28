import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

export const integrationClientCommandTypes = {
  modelConnectionCreate: 'integration.model_connection.create',
  modelConnectionUpdate: 'integration.model_connection.update',
  modelConnectionDelete: 'integration.model_connection.delete',
  modelConnectionApiKeyClear: 'integration.model_connection.api_key.clear',
  modelConnectionModelsRefresh: 'integration.model_connection.models.refresh',
  modelConnectionDiagnose: 'integration.model_connection.diagnose',
  zentaoInstanceCreate: 'integration.zentao_instance.create',
  zentaoInstanceUpdate: 'integration.zentao_instance.update',
  zentaoInstanceDelete: 'integration.zentao_instance.delete',
  zentaoInstancePasswordClear: 'integration.zentao_instance.password.clear',
  zentaoInstanceVerify: 'integration.zentao_instance.verify',
  projectModelSelectionSave: 'settings.project_model_selection.save',
  telegramBotTokenPut: 'integration.telegram_bot_token.put',
  telegramBotTokenDelete: 'integration.telegram_bot_token.delete',
  externalApiKeyPut: 'integration.external_api_key.put',
  externalApiKeyDelete: 'integration.external_api_key.delete',
} as const;

type IntegrationClientCommandType = (typeof integrationClientCommandTypes)[keyof typeof integrationClientCommandTypes];
type IntegrationClientScopeKind = Extract<CommandScopeKind, 'settings' | 'integration_account' | 'provider_configuration' | 'provider_account'>;
type IntegrationCommandPayload = { operationIdentity: string; inputSha256: string };

/** 每次 UI 操作只构造一次 Envelope；连接刷新与 HTTP 重试复用同一个序列化 Body。 */
export async function buildIntegrationCommandRequest<TInput extends object>(input: {
  commandType: IntegrationClientCommandType;
  scopeKind: IntegrationClientScopeKind;
  scopeId(operationIdentity: string): string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<IntegrationCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_integration_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-integrations' },
      scope: { kind: input.scopeKind, id: input.scopeId(operationIdentity) },
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
