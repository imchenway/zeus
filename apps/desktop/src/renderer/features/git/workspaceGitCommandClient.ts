import { type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { buildRendererCommandRequest, commandInputSha256, randomIdentity, type RendererCommandPayload } from '../../commandRequest.js';

export const workspaceGitClientCommandTypes = {
  workbenchAction: 'git.workbench.repository.action',
  taskWorkspaceCommitAll: 'git.task_workspace.commit_all',
  taskWorkspacePushAll: 'git.task_workspace.push_all',
  taskWorkspaceCommit: 'git.task_workspace.commit',
  taskWorkspacePush: 'git.task_workspace.push',
  taskWorkspaceStopSessions: 'git.task_workspace.stop_sessions',
  taskWorkspaceReclaim: 'git.task_workspace.reclaim',
  taskWorkspaceDiscard: 'git.task_workspace.discard',
  taskWorkspaceIntegrate: 'git.task_workspace.integrate',
  taskIntegrationConflictAiSession: 'git.task_integration.conflict_ai_session',
  taskIntegrationConflictResolve: 'git.task_integration.conflict_resolve',
  taskIntegrationFinalize: 'git.task_integration.finalize',
  taskIntegrationPush: 'git.task_integration.push',
  projectSnapshotCreate: 'git.project.snapshot.create',
  projectPatchExport: 'git.project.patch.export',
  taskPushRepositoryRefreshRemote: 'git.task_push.repository.refresh_remote',
} as const;

type WorkspaceGitClientCommandType = (typeof workspaceGitClientCommandTypes)[keyof typeof workspaceGitClientCommandTypes];
type WorkspaceGitClientScopeKind = Extract<CommandScopeKind, 'task' | 'task_workspace' | 'task_integration' | 'git_repository'>;
type WorkspaceGitCommandPayload = RendererCommandPayload;
const stableRequests = new Map<string, Promise<{ command: CommandEnvelope<WorkspaceGitCommandPayload>; input: object }>>();
const maximumStableRequests = 256;

/** 一次用户动作只构造一个不可变 Envelope；transport 重连必须复用同一正文。 */
export async function buildWorkspaceGitCommandRequest<TInput extends object>(input: {
  commandType: WorkspaceGitClientCommandType;
  scopeKind: WorkspaceGitClientScopeKind;
  scopeId: string;
  value: TInput;
  reconnectIdentity?: string;
}): Promise<{ command: CommandEnvelope<WorkspaceGitCommandPayload>; input: TInput }> {
  if (input.reconnectIdentity) {
    const cacheKey = `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.reconnectIdentity}`;
    const existing = stableRequests.get(cacheKey);
    if (existing) {
      const request = (await existing) as { command: CommandEnvelope<WorkspaceGitCommandPayload>; input: TInput };
      if (request.command.payload.inputSha256 !== (await commandInputSha256(input.value))) {
        throw new Error('A reconnect identity cannot be reused with different Workspace Git command input.');
      }
      return request;
    }
    const created = createWorkspaceGitCommandRequest(input);
    stableRequests.set(cacheKey, created as Promise<{ command: CommandEnvelope<WorkspaceGitCommandPayload>; input: object }>);
    while (stableRequests.size > maximumStableRequests) stableRequests.delete(stableRequests.keys().next().value!);
    return created;
  }
  return createWorkspaceGitCommandRequest(input);
}

async function createWorkspaceGitCommandRequest<TInput extends object>(input: {
  commandType: WorkspaceGitClientCommandType;
  scopeKind: WorkspaceGitClientScopeKind;
  scopeId: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<WorkspaceGitCommandPayload>; input: TInput }> {
  const operationIdentity = `workspace_git_operation_${randomIdentity()}`;
  return buildRendererCommandRequest({
    ...input,
    operationIdentity,
    commandIdPrefix: 'command_workspace_git_',
    actorId: 'zeus-desktop-workspace-git',
    expectedRevision: null,
  });
}
