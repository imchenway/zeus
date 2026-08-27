import type {
  AgentCatalogSnapshot,
  BatchTaskWorkspaceResponse,
  CodexAccountSnapshot,
  CodexChatGptLogin,
  CodexTaskPushCapabilities,
  CodexTaskRepositoryCapability,
  NativeOperationAcceptance,
  StartTaskModelPushRequest,
  TaskGitDiffSummary,
  TaskIntegrationConflictAiSession,
  TaskIntegrationConflictFile,
  TaskIntegrationConflictPermissionMode,
  TaskIntegrationPushResult,
  TaskIntegrationRecord,
  TaskIntegrationResult,
  TaskWorkspaceCommitResult,
  TaskWorkspaceIndexCollection,
  TaskWorkspacePushResult,
  TaskWorkspaceSnapshotResponse,
  TaskWorkspacesSnapshot,
} from '../../session/sessionTypes.js';
import type { CodexUsageAnalyticsSnapshot, CodexUsageRange, CodexUsageSummarySnapshot, UsageOverviewSnapshot } from '@zeus/shared';
import type { CodexConfigActivationResult, CodexConfigImportPreview, CodexConfigImportResult, CodexLegacyImportResult, CodexLegacyImportSnapshot, SkillCatalog, SkillInstallResult, SkillInstallSource } from './codexContracts.js';
import { buildCodexPublicCommandRequest, codexPublicClientCommandTypes, codexPublicClientScopeIds } from './codexPublicCommandClient.js';
import { buildGraphConversationCommandRequest, graphConversationClientCommandTypes } from '../conversations/graphConversationCommandClient.js';
import { buildWorkspaceGitCommandRequest, workspaceGitClientCommandTypes } from '../git/workspaceGitCommandClient.js';
import { type LocalApiTransport, ZeusApiError } from '../../transport/localApiTransport.js';

export interface CodexApiClient {
  loadAgents: () => Promise<AgentCatalogSnapshot>;
  loadCodexTaskPushCapabilities: (projectId: string, taskId: string) => Promise<CodexTaskPushCapabilities>;
  refreshTaskPushRepositoryRemote: (projectId: string, taskId: string, repositoryId: string) => Promise<CodexTaskRepositoryCapability>;
  loadCodexAccount: () => Promise<CodexAccountSnapshot>;
  loadCodexUsageSummary: () => Promise<CodexUsageSummarySnapshot>;
  loadUsageOverview: () => Promise<UsageOverviewSnapshot>;
  loadCodexUsageAnalytics: (input: { range: CodexUsageRange; projectId?: string; model?: string }) => Promise<CodexUsageAnalyticsSnapshot>;
  startCodexChatGptLogin: () => Promise<CodexChatGptLogin>;
  cancelCodexChatGptLogin: (loginId: string) => Promise<void>;
  startTaskModelPush: (
    taskId: string,
    input: StartTaskModelPushRequest,
  ) => Promise<{
    acceptance: NativeOperationAcceptance;
    operationIdentity: string;
  }>;
  loadTaskGitWorkspaces: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  loadTaskGitWorkspaceIndex: (taskId: string) => Promise<TaskWorkspaceIndexCollection>;
  loadTaskGitWorkspaceSnapshot: (taskId: string, workspaceId: string) => Promise<TaskWorkspaceSnapshotResponse>;
  loadTaskWorkspaceFileDiff: (
    taskId: string,
    workspaceId: string,
    path: string,
    scope?: 'working' | 'committed',
  ) => Promise<{
    path: string;
    diff: TaskGitDiffSummary;
  }>;
  commitTaskWorkspace: (taskId: string, workspaceId: string, input: { message: string; selectedPaths: string[] }) => Promise<TaskWorkspaceCommitResult>;
  commitAllTaskWorkspaces: (taskId: string, input: { message: string }) => Promise<BatchTaskWorkspaceResponse>;
  pushTaskWorkspace: (taskId: string, workspaceId: string) => Promise<TaskWorkspacePushResult>;
  pushAllTaskWorkspaces: (taskId: string) => Promise<BatchTaskWorkspaceResponse>;
  pushTaskIntegration: (taskId: string, integrationId: string) => Promise<TaskIntegrationPushResult>;
  reclaimTaskWorkspace: (taskId: string, workspaceId: string) => Promise<{ workspace: unknown; result?: unknown }>;
  discardTaskWorkspace: (taskId: string, workspaceId: string, confirmationText: string) => Promise<{ workspace: unknown; result: unknown }>;
  stopTaskWorkspaceSessions: (taskId: string, workspaceId: string) => Promise<{ workspaceId: string; interrupted: number; cancelled: number }>;
  loadTaskIntegrations: (taskId: string) => Promise<{ taskId: string; items: TaskIntegrationRecord[]; integrations: TaskIntegrationRecord[] }>;
  startTaskIntegration: (
    taskId: string,
    workspaceId: string,
    input: {
      targetBranch: string;
      mode: 'merge' | 'squash';
      prepareOnly?: boolean;
    },
  ) => Promise<{ integration: TaskIntegrationRecord; result?: TaskIntegrationResult }>;
  loadTaskIntegrationConflict: (taskId: string, integrationId: string, path: string) => Promise<TaskIntegrationConflictFile>;
  startTaskIntegrationConflictAi: (
    taskId: string,
    integrationId: string,
    path: string,
    content: string,
    fingerprint: string,
    permissionMode: TaskIntegrationConflictPermissionMode,
    idempotencyKey: string,
    skillId?: string,
  ) => Promise<TaskIntegrationConflictAiSession>;
  resolveTaskIntegrationConflict: (taskId: string, integrationId: string, path: string, content: string) => Promise<{ integration: TaskIntegrationRecord; result: { path: string; remainingConflictFiles: string[] } }>;
  finalizeTaskIntegration: (
    taskId: string,
    integrationId: string,
  ) => Promise<{
    integration: TaskIntegrationRecord;
    result: TaskIntegrationResult;
  }>;
  loadCodexLegacyImports: () => Promise<CodexLegacyImportSnapshot>;
  startCodexLegacyImport: (sourceConversationIds: string[]) => Promise<CodexLegacyImportResult>;
  loadCodexLegacyImport: (importId: string) => Promise<CodexLegacyImportResult>;
  inspectCodexConfigImport: () => Promise<CodexConfigImportPreview>;
  importCodexConfig: () => Promise<CodexConfigImportResult>;
  activateCodexConfig: () => Promise<CodexConfigActivationResult>;
  loadSkills: (projectId?: string, forceReload?: boolean) => Promise<SkillCatalog>;
  installSkill: (source: SkillInstallSource, projectId?: string) => Promise<SkillInstallResult>;
  removeSkill: (skillId: string, projectId?: string) => Promise<{ removed: true; skillId: string; name: string }>;
}

export function createCodexApiClient(transport: LocalApiTransport): CodexApiClient {
  const loadUsageOverview = async (): Promise<UsageOverviewSnapshot> => {
    try {
      return await transport.request<UsageOverviewSnapshot>('/api/usage-overview');
    } catch (error) {
      if (!(error instanceof ZeusApiError) || error.status !== 404) throw error;
      const analytics = await transport.request<CodexUsageAnalyticsSnapshot>('/api/codex/usage-analytics?range=7d');
      return normalizeLegacyCodexUsageOverview(analytics);
    }
  };

  return {
    loadAgents: () => transport.request<AgentCatalogSnapshot>('/api/agents'),
    loadCodexTaskPushCapabilities: (projectId, taskId) => transport.request<CodexTaskPushCapabilities>(`/api/projects/${encodeURIComponent(projectId)}/codex-task-push-capabilities?taskId=${encodeURIComponent(taskId)}`),
    refreshTaskPushRepositoryRemote: async (projectId, taskId, repositoryId) => {
      const body = await buildWorkspaceGitCommandRequest({
        commandType: workspaceGitClientCommandTypes.taskPushRepositoryRefreshRemote,
        scopeKind: 'git_repository',
        scopeId: repositoryId,
        value: { taskId },
      });
      return transport.request<CodexTaskRepositoryCapability>(`/api/projects/${encodeURIComponent(projectId)}/codex-task-push-capabilities/repositories/${encodeURIComponent(repositoryId)}/refresh-remote`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadCodexAccount: () => transport.request<CodexAccountSnapshot>('/api/codex/account'),
    loadCodexUsageSummary: () => transport.request<CodexUsageSummarySnapshot>('/api/codex/usage-summary'),
    loadUsageOverview,
    loadCodexUsageAnalytics: (input) => {
      const query = new URLSearchParams({ range: input.range });
      if (input.projectId) query.set('projectId', input.projectId);
      if (input.model) query.set('model', input.model);
      return transport.request<CodexUsageAnalyticsSnapshot>(`/api/codex/usage-analytics?${query.toString()}`);
    },
    startCodexChatGptLogin: async () => {
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.accountLoginStart,
        scopeKind: 'provider_account',
        scopeId: codexPublicClientScopeIds.account,
        operationPrefix: 'codex_account_login',
        value: {},
      });
      return transport.request<CodexChatGptLogin>('/api/codex/account/login/chatgpt', { method: 'POST', body: JSON.stringify(body) });
    },
    cancelCodexChatGptLogin: async (loginId) => {
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.accountLoginCancel,
        scopeKind: 'provider_account',
        scopeId: codexPublicClientScopeIds.account,
        operationPrefix: 'codex_account_login_cancel',
        value: { loginId },
      });
      await transport.request<{ cancelled: true }>(`/api/codex/account/login/${encodeURIComponent(loginId)}/cancel`, { method: 'POST', body: JSON.stringify(body) });
    },
    startTaskModelPush: async (taskId, input) => {
      const { idempotencyKey, ...body } = input;
      const commandBody = await buildGraphConversationCommandRequest({
        commandType: graphConversationClientCommandTypes.taskConversationCreate,
        scopeKind: 'task',
        scopeId: taskId,
        operationSeed: idempotencyKey,
        reconnectIdentity: idempotencyKey,
        value: body,
      });
      const acceptance = await transport.request<NativeOperationAcceptance>(`/api/tasks/${encodeURIComponent(taskId)}/conversations`, {
        method: 'POST',
        body: JSON.stringify(commandBody),
      });
      return { acceptance, operationIdentity: commandBody.command.payload.operationIdentity };
    },
    loadTaskGitWorkspaces: (taskId) => transport.request<TaskWorkspacesSnapshot>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces`),
    loadTaskGitWorkspaceIndex: (taskId) => transport.request<TaskWorkspaceIndexCollection>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/index`),
    loadTaskGitWorkspaceSnapshot: (taskId, workspaceId) => transport.request<TaskWorkspaceSnapshotResponse>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/snapshot`),
    loadTaskWorkspaceFileDiff: (taskId, workspaceId, path, scope = 'working') =>
      transport.request<{
        path: string;
        diff: TaskGitDiffSummary;
      }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/file-diff?path=${encodeURIComponent(path)}&scope=${encodeURIComponent(scope)}`),
    commitTaskWorkspace: async (taskId, workspaceId, input) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspaceCommit, scopeKind: 'task_workspace', scopeId: workspaceId, value: input });
      return transport.request<TaskWorkspaceCommitResult>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/commit`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    commitAllTaskWorkspaces: async (taskId, input) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspaceCommitAll, scopeKind: 'task', scopeId: taskId, value: input });
      return transport.request<BatchTaskWorkspaceResponse>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/commit-all`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    pushTaskWorkspace: async (taskId, workspaceId) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspacePush, scopeKind: 'task_workspace', scopeId: workspaceId, value: {} });
      return transport.request<TaskWorkspacePushResult>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/push`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    pushAllTaskWorkspaces: async (taskId) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspacePushAll, scopeKind: 'task', scopeId: taskId, value: {} });
      return transport.request<BatchTaskWorkspaceResponse>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/push-all`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    pushTaskIntegration: async (taskId, integrationId) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskIntegrationPush, scopeKind: 'task_integration', scopeId: integrationId, value: {} });
      return transport.request<TaskIntegrationPushResult>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/push`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    reclaimTaskWorkspace: async (taskId, workspaceId) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspaceReclaim, scopeKind: 'task_workspace', scopeId: workspaceId, value: {} });
      return transport.request<{ workspace: unknown; result?: unknown }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/reclaim`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    discardTaskWorkspace: async (taskId, workspaceId, confirmationText) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspaceDiscard, scopeKind: 'task_workspace', scopeId: workspaceId, value: { confirmationText } });
      return transport.request<{ workspace: unknown; result: unknown }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/discard`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    stopTaskWorkspaceSessions: async (taskId, workspaceId) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspaceStopSessions, scopeKind: 'task_workspace', scopeId: workspaceId, value: {} });
      return transport.request<{ workspaceId: string; interrupted: number; cancelled: number }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/stop-sessions`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadTaskIntegrations: (taskId) => transport.request<{ taskId: string; items: TaskIntegrationRecord[]; integrations: TaskIntegrationRecord[] }>(`/api/tasks/${encodeURIComponent(taskId)}/integrations`),
    startTaskIntegration: async (taskId, workspaceId, input) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskWorkspaceIntegrate, scopeKind: 'task_workspace', scopeId: workspaceId, value: input });
      return transport.request<{
        integration: TaskIntegrationRecord;
        result?: TaskIntegrationResult;
      }>(`/api/tasks/${encodeURIComponent(taskId)}/git-workspaces/${encodeURIComponent(workspaceId)}/integrate`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadTaskIntegrationConflict: (taskId, integrationId, path) =>
      transport.request<TaskIntegrationConflictFile>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/conflict?path=${encodeURIComponent(path)}`),
    startTaskIntegrationConflictAi: async (taskId, integrationId, path, content, fingerprint, permissionMode, idempotencyKey, skillId) => {
      const body = await buildWorkspaceGitCommandRequest({
        commandType: workspaceGitClientCommandTypes.taskIntegrationConflictAiSession,
        scopeKind: 'task_integration',
        scopeId: integrationId,
        value: { path, content, fingerprint, permissionMode, ...(skillId ? { skillId } : {}) },
        reconnectIdentity: idempotencyKey,
      });
      return transport.request<TaskIntegrationConflictAiSession>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/conflict/ai-session`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    resolveTaskIntegrationConflict: async (taskId, integrationId, path, content) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskIntegrationConflictResolve, scopeKind: 'task_integration', scopeId: integrationId, value: { path, content } });
      return transport.request<{ integration: TaskIntegrationRecord; result: { path: string; remainingConflictFiles: string[] } }>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/conflict`, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    finalizeTaskIntegration: async (taskId, integrationId) => {
      const body = await buildWorkspaceGitCommandRequest({ commandType: workspaceGitClientCommandTypes.taskIntegrationFinalize, scopeKind: 'task_integration', scopeId: integrationId, value: {} });
      return transport.request<{
        integration: TaskIntegrationRecord;
        result: TaskIntegrationResult;
      }>(`/api/tasks/${encodeURIComponent(taskId)}/integrations/${encodeURIComponent(integrationId)}/finalize`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadCodexLegacyImports: () => transport.request<CodexLegacyImportSnapshot>('/api/codex-native/import'),
    startCodexLegacyImport: async (sourceConversationIds) => {
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.legacyImportStart,
        scopeKind: 'provider_import',
        scopeId: codexPublicClientScopeIds.legacyImport,
        operationPrefix: 'codex_legacy_import',
        value: { sourceConversationIds },
      });
      return transport.request<CodexLegacyImportResult>('/api/codex-native/import', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadCodexLegacyImport: (importId) => transport.request<CodexLegacyImportResult>(`/api/codex-native/import/${encodeURIComponent(importId)}`),
    inspectCodexConfigImport: () => transport.request<CodexConfigImportPreview>('/api/codex-config/import'),
    importCodexConfig: async () => {
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.configurationImport,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicClientScopeIds.configuration,
        operationPrefix: 'codex_configuration_import',
        value: {},
      });
      return transport.request<CodexConfigImportResult>('/api/codex-config/import', { method: 'POST', body: JSON.stringify(body) });
    },
    activateCodexConfig: async () => {
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.configurationActivate,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicClientScopeIds.configuration,
        operationPrefix: 'codex_configuration_activate',
        value: {},
      });
      return transport.request<CodexConfigActivationResult>('/api/codex-config/activate', { method: 'POST', body: JSON.stringify(body) });
    },
    loadSkills: (projectId, forceReload = false) => {
      const query = new URLSearchParams();
      if (projectId) query.set('projectId', projectId);
      if (forceReload) query.set('forceReload', 'true');
      const suffix = query.size ? `?${query.toString()}` : '';
      return transport.request<SkillCatalog>(`/api/skills${suffix}`);
    },
    installSkill: async (source, projectId) => {
      const value = { projectId: projectId ?? null, source };
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.skillInstall,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicClientScopeIds.skills,
        operationPrefix: 'zeus_skill_install',
        value,
      });
      return transport.request<SkillInstallResult>('/api/skills/install', { method: 'POST', body: JSON.stringify(body) });
    },
    removeSkill: async (skillId, projectId) => {
      const value = { projectId: projectId ?? null, skillId };
      const body = await buildCodexPublicCommandRequest({
        commandType: codexPublicClientCommandTypes.skillRemove,
        scopeKind: 'provider_configuration',
        scopeId: codexPublicClientScopeIds.skills,
        operationPrefix: 'zeus_skill_remove',
        value,
      });
      return transport.request<{ removed: true; skillId: string; name: string }>(`/api/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE', body: JSON.stringify(body) });
    },
  };
}

function normalizeLegacyCodexUsageOverview(analytics: CodexUsageAnalyticsSnapshot): UsageOverviewSnapshot {
  const currentDate = new Date();
  const today = localDateKey(currentDate);
  const sevenDayStartDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate());
  sevenDayStartDate.setDate(sevenDayStartDate.getDate() - 6);
  const sevenDayStart = localDateKey(sevenDayStartDate);
  const dailyAccount = analytics.official.dailyUsageBuckets?.filter((bucket) => bucket.startDate >= sevenDayStart && bucket.startDate <= today).map((bucket) => ({ date: bucket.startDate, totalTokens: bucket.tokens })) ?? null;
  const todayLocal = analytics.local.daily.find((bucket) => bucket.date === today) ?? emptyLocalUsageTotals();
  return {
    providers: [
      {
        providerId: 'codex',
        sourceId: 'codex',
        name: 'Codex',
        kind: 'subscription',
        deleted: false,
        cacheUsageAvailable: true,
        planType: analytics.official.planType,
        officialState: analytics.official.state,
        rateLimitWindows: analytics.official.rateLimitWindows,
        officialCreditBalance: analytics.official.creditBalance,
        officialCreditsUnlimited: analytics.official.creditsUnlimited,
        accountTodayTokens: dailyAccount?.find((bucket) => bucket.date === today)?.totalTokens ?? null,
        accountSevenDayTokens: dailyAccount && dailyAccount.length > 0 ? dailyAccount.reduce((sum, bucket) => sum + bucket.totalTokens, 0) : null,
        dailyAccount,
        todayLocal,
        todayLocalComplete: false,
        sevenDayLocal: analytics.local.totals,
        sevenDayLocalComplete: false,
        dailyLocal: analytics.local.daily,
        collectionStartedAt: analytics.local.collectionStartedAt,
        updatedAt: analytics.updatedAt,
        stale: analytics.official.stale,
        error: analytics.official.error,
      },
    ],
    updatedAt: analytics.updatedAt,
    providerCoverage: 'codex-only-compatibility',
  };
}

function emptyLocalUsageTotals() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    conversationCount: 0,
    turnCount: 0,
    cacheHitRate: null,
    estimatedCredits: null,
    apiEquivalentUsd: null,
    cacheSavingsUsd: null,
    priceCoverage: null,
  };
}

function localDateKey(value: Date): string {
  return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-');
}
