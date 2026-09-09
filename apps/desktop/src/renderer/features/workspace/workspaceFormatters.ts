import { defaultTaskManagementStatusConfig, normalizeTaskManagementStatusConfig } from '@zeus/shared';
import { type AppLanguage } from './workspaceCopy.js';
import { normalizeTaskTableColumnPreferences, normalizeTaskTableEnumSortOrders } from '../../task/taskWorkspaceModel.js';
import { type AiRuntimeLogEntry, type AppShellSettings, type ExecuteGitOperationRequest, type GitDiffHunk, type GitDiffSummary, type GitOperationConfirmation } from '../../apiClient.js';
import { getLanguageCopy, normalizeCodeWorkspaceByProject, normalizeTaskExpandedIdsByProject, normalizeTaskPageViewByProject, normalizeTaskStatusFilterByProject, normalizeTaskViewModeByProject } from './workspaceSupport.js';

export const GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE = 'ZEUS HIGH RISK';

export type GenericShellCommandRiskLevel = 'empty' | 'medium' | 'critical';

export interface GenericShellCommandRisk {
  level: GenericShellCommandRiskLevel;
  /** 风险标签只保存稳定状态码，真正展示文案必须走当前语言 copy 域。 */
  label: string;
  /** 风险原因只保存稳定状态码，避免英文界面混入中文状态值。 */
  reason: string;
}

/** 对 Generic shell 命令做本地静态风险提示；只用于提示和确认文案，不替代后端确认与审计。 */
export function classifyGenericShellCommandRisk(command: string): GenericShellCommandRisk {
  const normalized = command.trim().toLowerCase();
  if (!normalized)
    return {
      level: 'empty',
      label: 'generic_shell.risk.empty',
      reason: 'generic_shell.reason.empty',
    };
  const criticalPatterns = [
    /\brm\s+.*(-rf|-fr|-r)\b/,
    /\b(sudo\s+)?rm\s+.*\//,
    /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/,
    /\bwget\b[^|]*\|\s*(sh|bash|zsh)\b/,
    /\bdd\s+.*\bof=/,
    /\bchmod\s+-r\s+777\b/,
    /\bmkfs\b/,
    /:\(\)\s*\{\s*:\|:\s*&\s*}\s*;/,
  ];
  if (criticalPatterns.some((pattern) => pattern.test(normalized))) {
    return {
      level: 'critical',
      label: 'generic_shell.risk.critical',
      reason: 'generic_shell.reason.critical_pattern',
    };
  }
  return {
    level: 'medium',
    label: 'generic_shell.risk.medium',
    reason: 'generic_shell.reason.requires_confirmation',
  };
}

export interface GitOperationExecutionForm {
  branchName?: string;
  baseRef?: string;
  stashRef?: string;
  remote?: string;
  targetRef?: string;
}

/** 从已确认记录和专用表单构造白名单 Git 执行请求；不允许用户输入任意 git 子命令。 */
export function buildGitOperationExecutionInput(confirmation: GitOperationConfirmation, form: GitOperationExecutionForm = {}): ExecuteGitOperationRequest {
  const input: ExecuteGitOperationRequest = {
    confirmationId: confirmation.id,
    operation: confirmation.operation,
  };
  if (confirmation.operation === 'commit') input.message = confirmation.message;
  if (confirmation.operation === 'stash') input.message = confirmation.message ?? confirmation.reason;
  if (confirmation.operation === 'branch' || confirmation.operation === 'switch_branch') input.branchName = form.branchName;
  if (confirmation.operation === 'branch' && form.baseRef?.trim()) input.baseRef = form.baseRef;
  if (confirmation.operation === 'apply_stash') input.stashRef = form.stashRef;
  if (confirmation.operation === 'pull' || confirmation.operation === 'push') {
    input.remote = form.remote;
    input.targetRef = form.targetRef;
  }
  if (confirmation.operation === 'rollback') input.targetRef = form.targetRef;
  return input;
}

export function buildGitDiffReviewSummary(diff: GitDiffSummary, appLanguage: AppLanguage = 'zh-CN'): string {
  const hunkCount = diff.fileDiffs?.reduce((total, file) => total + file.hunks.length, 0) ?? 0;
  const addedLines = diff.fileDiffs?.reduce((total, file) => total + file.addedLines, 0) ?? 0;
  const deletedLines = diff.fileDiffs?.reduce((total, file) => total + file.deletedLines, 0) ?? 0;
  return getLanguageCopy(appLanguage).gitDiffWorkspace.reviewSummary(diff.files.length, hunkCount, addedLines, deletedLines);
}

export function buildGitDiffDecisionSummary(diff: GitDiffSummary, decisions: Record<string, 'accepted' | 'rejected'>, appLanguage: AppLanguage = 'zh-CN'): string {
  let accepted = 0;
  let rejected = 0;
  let total = 0;
  for (const file of diff.fileDiffs ?? []) {
    for (const hunk of file.hunks) {
      total += 1;
      const decision = decisions[buildGitHunkReviewKey(file, hunk)];
      if (decision === 'accepted') accepted += 1;
      if (decision === 'rejected') rejected += 1;
    }
  }
  const pending = Math.max(total - accepted - rejected, 0);
  return getLanguageCopy(appLanguage).gitDiffWorkspace.decisionSummary(accepted, rejected, pending);
}

export function buildGitHunkReviewKey(file: { oldPath: string; newPath: string }, hunk: GitDiffHunk): string {
  return `${file.oldPath}->${file.newPath}:${hunk.header}`;
}

/** 使用固定 UTC 格式展示 Git 确认过期时间，避免本地时区差异让审查口径不一致。 */
export function formatGitConfirmationExpiry(expiresAt: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return getLanguageCopy(appLanguage).gitDiffWorkspace.unknownExpiry;
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Git 确认状态来自安全确认记录，渲染时按当前 UI 语言格式化，避免 pending 这类内部状态直出。 */
export function formatGitConfirmationStatus(status: GitOperationConfirmation['status'], appLanguage: AppLanguage = 'zh-CN'): string {
  const labels = getLanguageCopy(appLanguage).gitDiffWorkspace.confirmationStatusLabels;
  return labels[status] ?? status;
}

/** Git 写操作标签只用于安全确认后的 UI 展示，不反推任何命令参数。 */
export function formatGitOperationLabel(operation: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).gitDiffWorkspace.operationLabels;
  return labels[operation] ?? operation;
}

/** Git clean 状态可能来自旧版本 API，缺失时用 changedFiles 兜底，保持界面向后兼容。 */

/** 将 Git diff 文件变更类型转成稳定中文文案，方便用户按文件审查真实变更。 */

/** 只展示每个 hunk 的前几行真实差异，避免大 diff 让 Dashboard 失控。 */

/** 高危 Generic shell 命令必须有人工输入短语，避免误点直接启动破坏性命令。 */
export function isGenericShellCriticalConfirmationSatisfied(risk: GenericShellCommandRisk, phrase: string): boolean {
  if (risk.level !== 'critical') return true;
  return phrase.trim() === GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE;
}

export function formatRuntimeLogLine(entry: AiRuntimeLogEntry): string {
  return `${entry.createdAt} · ${entry.stream}: ${entry.text}`;
}

export function joinRuntimeLogEntries(entries: AiRuntimeLogEntry[]): string {
  let output = '';
  for (const entry of entries) {
    if (entry.stream !== 'system') {
      output += entry.text;
      continue;
    }
    if (output && !output.endsWith('\n') && !output.endsWith('\r')) output += '\n';
    output += entry.text;
    if (!output.endsWith('\n')) output += '\n';
  }
  return output;
}

export function runtimeLogMatches(entry: AiRuntimeLogEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${entry.stream} ${entry.text} ${entry.createdAt}`.toLowerCase().includes(normalized);
}

export function toSafeAppShellImport(
  raw: Partial<AppShellSettings> | undefined,
):
  | Pick<
      AppShellSettings,
      | 'appLanguage'
      | 'appearance'
      | 'webviewDebugEnabled'
      | 'developerModeEnabled'
      | 'multiWindowEnabled'
      | 'backgroundModeEnabled'
      | 'desktopNotificationsEnabled'
      | 'openAtLoginEnabled'
      | 'autoUpdateChannel'
      | 'defaultProjectId'
      | 'pinnedProjectIds'
      | 'collapsedProjectIds'
      | 'defaultModel'
      | 'defaultTaskTemplateId'
      | 'taskTableColumns'
      | 'taskTableColumnsByProject'
      | 'taskTableEnumSortOrders'
      | 'taskManagementStatusTemplate'
      | 'taskManagementStatusByProject'
      | 'taskStatusFilterByProject'
      | 'taskViewModeByProject'
      | 'taskPageViewByProject'
      | 'taskExpandedIdsByProject'
      | 'codeWorkspaceByProject'
    >
  | undefined {
  if (!raw) return undefined;
  return {
    appLanguage: raw.appLanguage === 'en-US' ? 'en-US' : 'zh-CN',
    appearance: raw.appearance === 'light' || raw.appearance === 'dark' || raw.appearance === 'system' ? raw.appearance : 'system',
    webviewDebugEnabled: raw.webviewDebugEnabled === true,
    developerModeEnabled: raw.developerModeEnabled === true,
    multiWindowEnabled: typeof raw.multiWindowEnabled === 'boolean' ? raw.multiWindowEnabled : true,
    backgroundModeEnabled: typeof raw.backgroundModeEnabled === 'boolean' ? raw.backgroundModeEnabled : true,
    desktopNotificationsEnabled: typeof raw.desktopNotificationsEnabled === 'boolean' ? raw.desktopNotificationsEnabled : true,
    openAtLoginEnabled: typeof raw.openAtLoginEnabled === 'boolean' ? raw.openAtLoginEnabled : false,
    autoUpdateChannel: 'manual',
    defaultProjectId: typeof raw.defaultProjectId === 'string' ? raw.defaultProjectId : null,
    pinnedProjectIds: Array.isArray(raw.pinnedProjectIds) ? raw.pinnedProjectIds.filter((id): id is string => typeof id === 'string') : [],
    collapsedProjectIds: Array.isArray(raw.collapsedProjectIds) ? raw.collapsedProjectIds.filter((id): id is string => typeof id === 'string') : [],
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : null,
    defaultTaskTemplateId: typeof raw.defaultTaskTemplateId === 'string' ? raw.defaultTaskTemplateId : null,
    taskTableColumns: normalizeTaskTableColumnPreferences(raw.taskTableColumns),
    taskTableColumnsByProject: Object.fromEntries(Object.entries(raw.taskTableColumnsByProject ?? {}).map(([projectId, preferences]) => [projectId, normalizeTaskTableColumnPreferences(preferences)])),
    taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(raw.taskTableEnumSortOrders),
    taskManagementStatusTemplate: normalizeTaskManagementStatusConfig(raw.taskManagementStatusTemplate, defaultTaskManagementStatusConfig),
    taskManagementStatusByProject: Object.fromEntries(
      Object.entries(raw.taskManagementStatusByProject ?? {}).map(([projectId, config]) => [
        projectId,
        normalizeTaskManagementStatusConfig(config, normalizeTaskManagementStatusConfig(raw.taskManagementStatusTemplate, defaultTaskManagementStatusConfig)),
      ]),
    ),
    taskStatusFilterByProject: normalizeTaskStatusFilterByProject(raw.taskStatusFilterByProject),
    taskViewModeByProject: normalizeTaskViewModeByProject(raw.taskViewModeByProject),
    taskPageViewByProject: normalizeTaskPageViewByProject(raw.taskPageViewByProject),
    taskExpandedIdsByProject: normalizeTaskExpandedIdsByProject(raw.taskExpandedIdsByProject),
    codeWorkspaceByProject: normalizeCodeWorkspaceByProject(raw.codeWorkspaceByProject),
  };
}
