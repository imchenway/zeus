import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

export const codexPublicClientCommandTypes = {
  accountLoginStart: 'codex.account.login.start',
  accountLoginCancel: 'codex.account.login.cancel',
  remoteControlEnable: 'codex.remote_control.enable',
  remoteControlDisable: 'codex.remote_control.disable',
  remoteControlPairingStart: 'codex.remote_control.pairing.start',
  remoteControlClientRevoke: 'codex.remote_control.client.revoke',
  configurationImport: 'codex.configuration.import',
  configurationActivate: 'codex.configuration.activate',
  legacyImportStart: 'codex.legacy_import.start',
} as const;

export const codexPublicClientScopeIds = {
  account: 'codex-account',
  remoteControl: 'codex-remote-control',
  configuration: 'codex-configuration',
  legacyImport: 'codex-legacy-import',
} as const;

type CodexPublicClientCommandType = (typeof codexPublicClientCommandTypes)[keyof typeof codexPublicClientCommandTypes];
type CodexPublicClientScopeKind = Extract<CommandScopeKind, 'provider_account' | 'provider_remote_control' | 'provider_configuration' | 'provider_import'>;
type CodexPublicCommandPayload = { operationIdentity: string; inputSha256: string };

/** Local transport 的两个网络 attempt 复用此处一次生成的 Body，绝不重建 operation identity。 */
export async function buildCodexPublicCommandRequest<TInput extends object>(input: {
  commandType: CodexPublicClientCommandType;
  scopeKind: CodexPublicClientScopeKind;
  scopeId: string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<CodexPublicCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_codex_public_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-codex-control' },
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
