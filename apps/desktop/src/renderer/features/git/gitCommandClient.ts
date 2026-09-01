import { type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { buildRendererCommandRequest, randomIdentity, type RendererCommandPayload } from '../../commandRequest.js';

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

/** 每个 UI 操作只构造一次 Envelope；LocalApiTransport 的连接刷新重试复用同一个序列化 Body。 */
export async function buildGitCommandRequest<TInput extends object>(input: {
  commandType: GitClientCommandType;
  scopeKind: GitClientScopeKind;
  scopeId(operationIdentity: string): string;
  operationPrefix: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<RendererCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}_${randomIdentity()}`;
  return buildRendererCommandRequest({
    ...input,
    scopeId: input.scopeId(operationIdentity),
    operationIdentity,
    commandIdPrefix: 'command_git_',
    actorId: 'zeus-desktop-git',
    expectedRevision: null,
  });
}
