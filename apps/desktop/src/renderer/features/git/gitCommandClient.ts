import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

export const gitClientCommandTypes = {
  confirmationCreate: 'git.confirmation.create',
  confirmationConfirm: 'git.confirmation.confirm',
  confirmationReject: 'git.confirmation.reject',
  operationExecute: 'git.operation.execute',
  projectBranch: 'git.project.branch',
  projectCheckout: 'git.project.checkout',
  projectCommit: 'git.project.commit',
  projectStash: 'git.project.stash',
  projectApplyStash: 'git.project.apply_stash',
  projectPull: 'git.project.pull',
  projectPush: 'git.project.push',
  taskRollback: 'git.task.rollback',
} as const;

type GitClientCommandType = (typeof gitClientCommandTypes)[keyof typeof gitClientCommandTypes];
type GitClientScopeKind = Extract<CommandScopeKind, 'approval' | 'git_repository'>;
type GitCommandPayload = { operationIdentity: string; inputSha256: string };

/** 每个 UI 操作只构造一次 Envelope；LocalApiTransport 的连接刷新重试复用同一个序列化 Body。 */
export async function buildGitCommandRequest<TInput extends object>(input: {
  commandType: GitClientCommandType;
  scopeKind: GitClientScopeKind;
  scopeId(operationIdentity: string): string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<GitCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_git_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-git' },
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
