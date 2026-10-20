import type { GitDeliveryInput, GitDeliveryRun, TaskManagementStatusDefinition } from '@zeus/shared';
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
  ProjectGitPushPreview,
  ProjectGitPushPreviewInput,
  ProjectGitSnapshotResult,
  ProjectGitWorkbenchSnapshot,
  ProjectGitOperationPage,
} from './gitContracts.js';
import type { ProjectGitWorkbenchBridge } from '../../transport/dashboardClientContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildGitCommandRequest, gitClientCommandTypes } from './gitCommandClient.js';
import { buildWorkspaceGitCommandRequest, workspaceGitClientCommandTypes } from './workspaceGitCommandClient.js';
import type { CodexTaskPushModelCapability } from '../../session/sessionTypes.js';

/** 提交说明使用真实模型目录中的推理与速率能力。 */
export type GitCommitModelOption = CodexTaskPushModelCapability & { label: string };

export interface GitApiClient {
  /** 后台交付查询只返回同一真实入口的记录。 */
  loadGitDeliveryRuns(projectId: string, scopeId: string): Promise<{ items: GitDeliveryRun[] }>;
  /** 读取真实项目管理状态。 */
  loadGitDeliveryOptions(projectId: string): Promise<{ statuses: TaskManagementStatusDefinition[] }>;
  /** 接纳时使用稳定用户动作身份。 */
  startGitDeliveryRun(projectId: string, input: GitDeliveryInput, key: string): Promise<GitDeliveryRun>;
  /** 手动继续不重新执行已成功步骤。 */
  resumeGitDeliveryRun(projectId: string, runId: string, input?: { confirmWorktreeCleanup?: boolean }): Promise<GitDeliveryRun>;
  /** 通知已读不会触发交付。 */
  acknowledgeGitDelivery(runId: string): Promise<unknown>;
  /** 普通会话复用冲突编辑器。 */
  loadGitDeliveryConflict(
    projectId: string,
    runId: string,
    stepId: string,
    path?: string,
  ): Promise<{ files: string[]; sourceBranch: string; targetBranch: string; file: import('../../session/sessionTypes.js').TaskIntegrationConflictFile | null }>;
  /** 用户在冲突页明确授权本次 AI 接管。 */
  startGitDeliveryConflictAi(projectId: string, runId: string, stepId: string, input: { path: string; content: string; fingerprint: string; permissionMode: 'auto' | 'full-access'; skillId?: string }): Promise<GitDeliveryRun>;
  /** 保存冲突必须匹配当前三方指纹。 */
  saveGitDeliveryConflict(projectId: string, runId: string, stepId: string, input: { path: string; content: string; fingerprint: string }): Promise<unknown>;

  forConversationGit: (conversationId: string) => GitApiClient;
  /** 操作账本属于桌面实例，不能回退到独立执行宿主的其他记录。 */
  loadProjectGitOperations: (projectId: string, cursor?: string) => Promise<ProjectGitOperationPage>;
  /** 生成入口可以取消模型读取，停止操作不必等待模型发现完成。 */
  loadGitCommitModels: (projectId: string, signal?: AbortSignal) => Promise<{ items: GitCommitModelOption[]; warning: string }>;
  generateGitCommitMessage: (
    projectId: string,
    input: {
      repositoryId: string;
      relativePath?: string;
      /** 任务交付按服务端工作区记录解析仓库，不能使用项目根目录的同名文件。 */
      taskId?: string;
      language: 'zh-CN' | 'en';
      modelRef: string;
      /** 推理档位使用所选模型目录中的原始身份。 */
      effort?: string;
      /** 标准速率显式清除 Provider 的默认加速档位。 */
      serviceTier?: 'priority' | null;
      selection?: Array<{ repositoryId: string; relativePath: string; paths: string[] }>;
    },
    onText?: (text: string) => void,
    signal?: AbortSignal,
  ) => Promise<{ message: string; model: string; truncated?: boolean }>;
  loadGitDiff: () => Promise<GitDiffSummary>;
  loadProjectGitWorkbench: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  loadConversationGitHistory: (projectId: string, repositoryId: string, offset: number, ref?: string) => Promise<{ commits: NonNullable<GitStatusSummary['recentCommits']>; hasMore: boolean }>;
  loadProjectGitCommit: (projectId: string, repositoryId: string, commitHash: string) => Promise<ProjectGitCommitDetail>;
  /** 按来源分支和目标远端读取本地推送预览。 */
  loadProjectGitPushPreview: (projectId: string, repositoryId: string, input: ProjectGitPushPreviewInput) => Promise<ProjectGitPushPreview>;
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

export function createGitApiClient(transport: LocalApiTransport, bridge: () => ProjectGitWorkbenchBridge | undefined, conversationId?: string): GitApiClient {
  const scopedRepositoryId = (repositoryId: string): string => {
    if (conversationId && repositoryId !== `conversation:${conversationId}`) throw new Error('会话工作树身份不匹配，请重新打开代码交付。');
    return encodeURIComponent(repositoryId);
  };
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
    loadGitDeliveryRuns: (projectId, scopeId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-runs?${new URLSearchParams({ scopeId })}`),
    loadGitDeliveryOptions: (projectId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-options`),
    startGitDeliveryRun: (projectId, input, key) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-runs`, { ...jsonRequest('POST', input), headers: { 'idempotency-key': key } }),
    resumeGitDeliveryRun: (projectId, runId, input = {}) =>
      transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-runs/${encodeURIComponent(runId)}/resume`, { ...jsonRequest('POST', input), headers: { 'idempotency-key': crypto.randomUUID() } }),
    acknowledgeGitDelivery: (runId) => transport.request(`/api/notifications/git-delivery/${encodeURIComponent(runId)}/read`, { ...jsonRequest('POST', {}), headers: { 'idempotency-key': crypto.randomUUID() } }),
    loadGitDeliveryConflict: (projectId, runId, stepId, path) =>
      transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/conflict${path ? `?${new URLSearchParams({ path })}` : ''}`),
    startGitDeliveryConflictAi: (projectId, runId, stepId, input) =>
      transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/ai`, {
        ...jsonRequest('POST', input),
        headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    saveGitDeliveryConflict: (projectId, runId, stepId, input) =>
      transport.request(`/api/projects/${encodeURIComponent(projectId)}/git-delivery-runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/conflict`, jsonRequest('PUT', input)),
    forConversationGit: (id) => createGitApiClient(transport, () => undefined, id),
    /** 缺少桌面桥接时报告不可用，不能伪装为空历史。 */
    loadProjectGitOperations: async (projectId, cursor) => {
      /** 历史读取和工作台操作必须使用同一个桌面账本。 */
      const nativeBridge = bridge();
      if (!nativeBridge) throw new Error('桌面 Git 操作历史暂不可用。 / Desktop Git operation history is unavailable.');
      return nativeBridge.loadOperations(projectId, cursor);
    },
    loadGitCommitModels: (projectId, signal) => transport.request(`${projectGitPath(projectId)}/commit-models`, { signal }),
    generateGitCommitMessage: async (projectId, input, onText, signal) => {
      scopedRepositoryId(input.repositoryId);
      input.selection?.forEach((item) => scopedRepositoryId(item.repositoryId));
      let result: { message: string; model: string; truncated?: boolean } | undefined;
      await transport.requestStream<{ type: string; text?: string; message?: string; model?: string; truncated?: boolean }>(
        `${projectGitPath(projectId)}/commit-message`,
        { ...jsonRequest('POST', { ...input, stream: true }), signal },
        (event) => {
          if (event.type === 'error') throw new Error(event.message ?? '提交说明生成失败。');
          if (event.type === 'text' && typeof event.text === 'string') onText?.(event.text);
          if (event.type === 'result' && typeof event.message === 'string' && typeof event.model === 'string') result = { message: event.message, model: event.model, truncated: event.truncated };
        },
      );
      if (!result) throw new Error('生成连接已中断，请重试。');
      return result;
    },
    loadGitDiff: () => transport.request<GitDiffSummary>('/api/git/diff'),
    loadProjectGitWorkbench: async (projectId) => {
      const snapshot = await (bridge()?.loadWorkbench(projectId) ?? transport.request<ProjectGitWorkbenchSnapshot>(`${projectGitPath(projectId)}/workbench${conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : ''}`));
      if (conversationId && (snapshot.repositories.length !== 1 || snapshot.repositories[0]?.id !== `conversation:${conversationId}`)) throw new Error('当前执行宿主尚不支持会话工作树交付，请更新后重试。');
      return snapshot;
    },
    loadConversationGitHistory: async (projectId, repositoryId, offset, ref) =>
      transport.request(`${projectGitPath(projectId)}/workbench/repositories/${scopedRepositoryId(repositoryId)}/history?offset=${offset}${ref ? `&ref=${encodeURIComponent(ref)}` : ''}`),
    loadProjectGitCommit: async (projectId, repositoryId, commitHash) =>
      bridge()?.loadCommit(projectId, repositoryId, commitHash) ??
      transport.request<ProjectGitCommitDetail>(`${projectGitPath(projectId)}/workbench/repositories/${scopedRepositoryId(repositoryId)}/commits/${encodeURIComponent(commitHash)}`),
    /** 桌面与会话工作树分别沿用各自可信仓库身份。 */
    loadProjectGitPushPreview: async (projectId, repositoryId, input) =>
      bridge()?.loadPushPreview(projectId, repositoryId, input) ??
      transport.request<ProjectGitPushPreview>(
        `${projectGitPath(projectId)}/workbench/repositories/${scopedRepositoryId(repositoryId)}/push-preview?${new URLSearchParams({ sourceBranch: input.sourceBranch, remote: input.remote, targetBranch: input.targetBranch, offset: String(input.offset ?? 0) })}`,
      ),
    loadProjectGitComparisonDiff: async (projectId, repositoryId, ref, mode) =>
      bridge()?.loadComparison(projectId, repositoryId, ref, mode) ??
      transport.request<GitDiffSummary>(`${projectGitPath(projectId)}/workbench/repositories/${scopedRepositoryId(repositoryId)}/compare?ref=${encodeURIComponent(ref)}&mode=${mode}`),
    executeProjectGitAction: async (projectId, repositoryId, input) => {
      scopedRepositoryId(repositoryId);
      const nativeBridge = bridge();
      if (nativeBridge) return nativeBridge.execute(projectId, repositoryId, input);
      const body = await buildWorkspaceGitCommandRequest({
        commandType: workspaceGitClientCommandTypes.workbenchAction,
        scopeKind: 'git_repository',
        scopeId: repositoryId,
        value: input,
      });
      return transport.request<ProjectGitActionResponse>(`${projectGitPath(projectId)}/workbench/repositories/${scopedRepositoryId(repositoryId)}/actions`, jsonRequest('POST', body));
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
