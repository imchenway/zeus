import {type CommandEnvelope, type CommandScopeKind} from '@zeus/shared';
import {buildRendererCommandRequest, randomIdentity, type RendererCommandPayload} from '../../commandRequest.js';

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

/** 每次 UI 操作只构造一次 Envelope；连接刷新与 HTTP 重试复用同一个序列化 Body。 */
export async function buildIntegrationCommandRequest<TInput extends object>(input: {
  commandType: IntegrationClientCommandType;
  scopeKind: IntegrationClientScopeKind;
  scopeId(operationIdentity: string): string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
    return buildRendererCommandRequest({
        ...input,
        scopeId: input.scopeId(operationIdentity),
        operationIdentity,
        commandIdPrefix: 'command_integration_',
        actorId: 'zeus-desktop-integrations',
        expectedRevision: null
    });
}
