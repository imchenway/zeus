import type {
  CreateGitConfirmationRequest,
  ExecuteGitOperationRequest,
  ExecutedGitOperationResult,
  GitDiffSummary,
  GitOperationConfirmation,
  GitPatchExport,
  GitStatusSummary,
  ProjectGitAction,
  ProjectGitActionResponse,
  ProjectGitCommitDetail,
  ProjectGitSnapshotResult,
  ProjectGitWorkbenchSnapshot,
} from './gitContracts.js';
import type { ProjectGitWorkbenchBridge } from '../../transport/dashboardClientContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildGitCommandRequest, gitClientCommandTypes } from './gitCommandClient.js';
import { buildWorkspaceGitCommandRequest, workspaceGitClientCommandTypes } from './workspaceGitCommandClient.js';

export interface GitApiClient {
  loadGitDiff: () => Promise<GitDiffSummary>;
  loadProjectGitStatus: (projectId: string) => Promise<GitStatusSummary>;
  loadProjectGitWorkbench: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  loadProjectGitCommit: (projectId: string, repositoryId: string, commitHash: string) => Promise<ProjectGitCommitDetail>;
  loadProjectGitComparisonDiff: (projectId: string, repositoryId: string, ref: string, mode: 'current' | 'working-tree') => Promise<GitDiffSummary>;
  executeProjectGitAction: (projectId: string, repositoryId: string, input: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  loadProjectGitDiff: (projectId: string) => Promise<GitDiffSummary>;
  createProjectGitSnapshot: (projectId: string, taskId: string) => Promise<ProjectGitSnapshotResult>;
  exportProjectGitPatch: (projectId: string) => Promise<GitPatchExport>;
  loadTaskGitDiff: (taskId: string) => Promise<GitDiffSummary>;
  exportGitPatch: () => Promise<GitPatchExport>;
  createGitConfirmation: (input: CreateGitConfirmationRequest) => Promise<GitOperationConfirmation>;
  confirmGitOperation: (confirmationId: string) => Promise<GitOperationConfirmation>;
  rejectGitOperation: (confirmationId: string, reason?: string) => Promise<GitOperationConfirmation>;
  executeGitOperation: (input: ExecuteGitOperationRequest) => Promise<ExecutedGitOperationResult>;
  executeProjectGitBranch: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitCheckout: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitCommit: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitStash: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitApplyStash: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitPull: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeProjectGitPush: (projectId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
  executeTaskGitRollback: (taskId: string, input: Omit<ExecuteGitOperationRequest, 'operation'>) => Promise<ExecutedGitOperationResult>;
}

export function createGitApiClient(transport: LocalApiTransport, bridge: () => ProjectGitWorkbenchBridge | undefined): GitApiClient {
  const projectOperation = async (projectId: string, operation: string, commandType: Parameters<typeof buildGitCommandRequest>[0]['commandType'], input: object) => {
    const body = await buildGitCommandRequest({
      commandType,
      scopeKind: 'git_repository',
      scopeId: () => `project:${projectId}`,
      operationPrefix: `git_project_${operation.replaceAll('-', '_')}`,
      value: input,
    });
    return transport.request<ExecutedGitOperationResult>(`${projectGitPath(projectId)}/${operation}`, jsonRequest('POST', body));
  };
  return {
    loadGitDiff: () => transport.request<GitDiffSummary>('/api/git/diff'),
    loadProjectGitStatus: (projectId) => transport.request<GitStatusSummary>(`${projectGitPath(projectId)}/status`),
    loadProjectGitWorkbench: (projectId) => bridge()?.loadWorkbench(projectId) ?? transport.request<ProjectGitWorkbenchSnapshot>(`${projectGitPath(projectId)}/workbench`),
    loadProjectGitCommit: (projectId, repositoryId, commitHash) =>
      bridge()?.loadCommit(projectId, repositoryId, commitHash) ??
      transport.request<ProjectGitCommitDetail>(`${projectGitPath(projectId)}/workbench/repositories/${encodeURIComponent(repositoryId)}/commits/${encodeURIComponent(commitHash)}`),
    loadProjectGitComparisonDiff: (projectId, repositoryId, ref, mode) =>
      bridge()?.loadComparison(projectId, repositoryId, ref, mode) ??
      transport.request<GitDiffSummary>(`${projectGitPath(projectId)}/workbench/repositories/${encodeURIComponent(repositoryId)}/compare?ref=${encodeURIComponent(ref)}&mode=${mode}`),
    executeProjectGitAction: async (projectId, repositoryId, input) => {
      const nativeBridge = bridge();
      if (nativeBridge) return nativeBridge.execute(projectId, repositoryId, input);
      const body = await buildWorkspaceGitCommandRequest({
        commandType: workspaceGitClientCommandTypes.workbenchAction,
        scopeKind: 'git_repository',
        scopeId: repositoryId,
        value: input,
      });
      return transport.request<ProjectGitActionResponse>(`${projectGitPath(projectId)}/workbench/repositories/${encodeURIComponent(repositoryId)}/actions`, jsonRequest('POST', body));
    },
    loadProjectGitDiff: (projectId) => transport.request<GitDiffSummary>(`${projectGitPath(projectId)}/diff`),
    createProjectGitSnapshot: async (projectId, taskId) => {
      const body = await buildWorkspaceGitCommandRequest({
        commandType: workspaceGitClientCommandTypes.projectSnapshotCreate,
        scopeKind: 'git_repository',
        scopeId: `project:${projectId}`,
        value: { taskId },
      });
      return transport.request<ProjectGitSnapshotResult>(`${projectGitPath(projectId)}/snapshot`, jsonRequest('POST', body));
    },
    exportProjectGitPatch: async (projectId) => {
      const body = await buildWorkspaceGitCommandRequest({
        commandType: workspaceGitClientCommandTypes.projectPatchExport,
        scopeKind: 'git_repository',
        scopeId: `project:${projectId}`,
        value: {},
      });
      return transport.request<GitPatchExport>(`${projectGitPath(projectId)}/patch`, jsonRequest('POST', body));
    },
    loadTaskGitDiff: (taskId) => transport.request<GitDiffSummary>(`/api/tasks/${encodeURIComponent(taskId)}/diff`),
    exportGitPatch: () => transport.request<GitPatchExport>('/api/git/patch'),
    createGitConfirmation: async (input) => {
      const body = await buildGitCommandRequest({
        commandType: gitClientCommandTypes.confirmationCreate,
        scopeKind: 'approval',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'git_confirmation',
        value: input,
      });
      return transport.request<GitOperationConfirmation>('/api/git/confirmations', jsonRequest('POST', body));
    },
    confirmGitOperation: async (confirmationId) => {
      const body = await buildGitCommandRequest({
        commandType: gitClientCommandTypes.confirmationConfirm,
        scopeKind: 'approval',
        scopeId: () => confirmationId,
        operationPrefix: 'git_confirmation_confirm',
        value: {},
      });
      return transport.request<GitOperationConfirmation>(`/api/git/confirmations/${encodeURIComponent(confirmationId)}/confirm`, jsonRequest('POST', body));
    },
    rejectGitOperation: async (confirmationId, reason) => {
      const value = { reason };
      const body = await buildGitCommandRequest({
        commandType: gitClientCommandTypes.confirmationReject,
        scopeKind: 'approval',
        scopeId: () => confirmationId,
        operationPrefix: 'git_confirmation_reject',
        value,
      });
      return transport.request<GitOperationConfirmation>(`/api/git/confirmations/${encodeURIComponent(confirmationId)}/reject`, jsonRequest('POST', body));
    },
    executeGitOperation: async (input) => {
      const body = await buildGitCommandRequest({
        commandType: gitClientCommandTypes.operationExecute,
        scopeKind: 'git_repository',
        scopeId: () => 'primary',
        operationPrefix: 'git_operation',
        value: input,
      });
      return transport.request<ExecutedGitOperationResult>('/api/git/operations', jsonRequest('POST', body));
    },
    executeProjectGitBranch: (projectId, input) => projectOperation(projectId, 'branch', gitClientCommandTypes.projectBranch, input),
    executeProjectGitCheckout: (projectId, input) => projectOperation(projectId, 'checkout', gitClientCommandTypes.projectCheckout, input),
    executeProjectGitCommit: (projectId, input) => projectOperation(projectId, 'commit', gitClientCommandTypes.projectCommit, input),
    executeProjectGitStash: (projectId, input) => projectOperation(projectId, 'stash', gitClientCommandTypes.projectStash, input),
    executeProjectGitApplyStash: (projectId, input) => projectOperation(projectId, 'apply-stash', gitClientCommandTypes.projectApplyStash, input),
    executeProjectGitPull: (projectId, input) => projectOperation(projectId, 'pull', gitClientCommandTypes.projectPull, input),
    executeProjectGitPush: (projectId, input) => projectOperation(projectId, 'push', gitClientCommandTypes.projectPush, input),
    executeTaskGitRollback: async (taskId, input) => {
      const body = await buildGitCommandRequest({
        commandType: gitClientCommandTypes.taskRollback,
        scopeKind: 'git_repository',
        scopeId: () => `task:${taskId}`,
        operationPrefix: 'git_task_rollback',
        value: input,
      });
      return transport.request<ExecutedGitOperationResult>(`/api/tasks/${encodeURIComponent(taskId)}/git/rollback`, jsonRequest('POST', body));
    },
  };
}

function projectGitPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/git`;
}
