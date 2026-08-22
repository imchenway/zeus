import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

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
type WorkspaceGitCommandPayload = { operationIdentity: string; inputSha256: string };
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
      if (request.command.payload.inputSha256 !== (await sha256(canonicalCommandInputJson(input.value)))) {
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
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_workspace_git_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-workspace-git' },
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
