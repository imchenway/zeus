import { type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { buildRendererCommandRequest, randomIdentity, type RendererCommandPayload } from '../../commandRequest.js';

export const codexPublicClientCommandTypes = {
  accountLoginStart: 'codex.account.login.start',
  accountLoginCancel: 'codex.account.login.cancel',
  remoteControlEnable: 'codex.remote_control.enable',
  remoteControlDisable: 'codex.remote_control.disable',
  remoteControlPairingStart: 'codex.remote_control.pairing.start',
  remoteControlClientRevoke: 'codex.remote_control.client.revoke',
  configurationImport: 'codex.configuration.import',
  configurationActivate: 'codex.configuration.activate',
  skillInstall: 'skill.install',
  skillRemove: 'skill.remove',
  legacyImportStart: 'codex.legacy_import.start',
} as const;

export const codexPublicClientScopeIds = {
  account: 'codex-account',
  remoteControl: 'codex-remote-control',
  configuration: 'codex-configuration',
  skills: 'zeus-skills',
  legacyImport: 'codex-legacy-import',
} as const;

type CodexPublicClientCommandType = (typeof codexPublicClientCommandTypes)[keyof typeof codexPublicClientCommandTypes];
type CodexPublicClientScopeKind = Extract<CommandScopeKind, 'provider_account' | 'provider_remote_control' | 'provider_configuration' | 'provider_import'>;

/** Local transport 的两个网络 attempt 复用此处一次生成的 Body，绝不重建 operation identity。 */
export async function buildCodexPublicCommandRequest<TInput extends object>(input: {
  commandType: CodexPublicClientCommandType;
  scopeKind: CodexPublicClientScopeKind;
  scopeId: string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  return buildRendererCommandRequest({
    ...input,
    operationIdentity,
    commandIdPrefix: 'command_codex_public_',
    actorId: 'zeus-desktop-codex-control',
    expectedRevision: null,
  });
}
