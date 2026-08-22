import { defaultTaskManagementStatusConfig, normalizeTaskManagementStatusConfig } from '@zeus/shared';
import { type AppLanguage } from './workspaceCopy.js';
import { normalizeTaskTableColumnPreferences, normalizeTaskTableEnumSortOrders } from '../../task/taskWorkspaceModel.js';
import { type AiRuntimeLogEntry, type AppShellSettings, type ExecuteGitOperationRequest, type GitDiffHunk, type GitDiffSummary, type GitOperationConfirmation } from '../../apiClient.js';
import { getLanguageCopy, normalizeCodeWorkspaceByProject, normalizeSidebarConversationCollapsedStatusIdsByProject, normalizeSidebarConversationOrganization, normalizeTaskExpandedIdsByProject, normalizeTaskPageViewByProject, normalizeTaskStatusFilterByProject, normalizeTaskViewModeByProject } from './workspaceSupport.js';
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

/** 图谱问答会话状态来自存储枚举，渲染时按当前 UI 语言格式化，未知状态保留原始事实。 */
export function formatGraphConversationStatus(status: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).codeMapWorkspace.conversationStatusLabels;
  return labels[status] ?? status;
}

/** 图谱问答消息来源是内部来源枚举，渲染时按当前 UI 语言格式化；未知来源保留原始事实便于追溯。 */
export function formatGraphMessageSource(source: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).codeMapWorkspace.messageSourceLabels;
  return labels[source] ?? source;
}

/** 图谱节点类型是搜索和布局使用的结构化枚举，展示时按界面语言转换，不改写图谱数据本身。 */
export function formatGraphNodeType(nodeType: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).graphNodeTypes;
  return labels[nodeType] ?? nodeType;
}

export function formatGraphNodeTypeList(nodeTypes: string[], appLanguage: AppLanguage = 'zh-CN'): string {
  return nodeTypes.map((nodeType) => formatGraphNodeType(nodeType, appLanguage)).join(' / ');
}

/** 图谱边类型同样保留原始 API 枚举，只在可读 UI 标签中本地化。 */
export function formatGraphEdgeType(edgeType: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const labels: Record<string, string> = getLanguageCopy(appLanguage).graphEdgeTypes;
  return labels[edgeType] ?? edgeType;
}

export function formatGraphLayoutAlgorithm(algorithm: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const zhLabels: Record<string, string> = {
    hierarchical: '层级布局',
    force: '力导向布局',
    dagre: 'Dagre 布局',
    'radial-neighborhood': '节点邻域布局',
  };
  const enLabels: Record<string, string> = {
    hierarchical: 'hierarchical layout',
    force: 'force layout',
    dagre: 'Dagre layout',
    'radial-neighborhood': 'node neighborhood layout',
  };
  return appLanguage === 'en-US' ? (enLabels[algorithm] ?? algorithm) : (zhLabels[algorithm] ?? algorithm);
}

/** 图谱风险标签来自扫描/任务写回的结构化枚举；界面显示本地化标签，未知真实标签保留原文便于追溯。 */
export function formatGraphRiskTag(tag: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const riskTagLabels: Record<AppLanguage, Record<string, string>> = {
    'zh-CN': {
      task_completed: '任务完成',
      task_failed: '任务失败',
      task_running: '任务运行中',
      task_paused: '任务暂停',
      task_cancelled: '任务取消',
      source_verified: '来源已验证',
      schema_drift: 'Schema 漂移',
      orphan_detected: '孤儿会话',
    },
    'en-US': {
      task_completed: 'Task completed',
      task_failed: 'Task failed',
      task_running: 'Task running',
      task_paused: 'Task paused',
      task_cancelled: 'Task cancelled',
      source_verified: 'Source verified',
      schema_drift: 'Schema drift',
      orphan_detected: 'Orphan detected',
    },
  };
  return riskTagLabels[appLanguage][tag] ?? tag;
}

export function formatGraphEdgeWithConfidence(edge: { edgeType: string; confidence: number }, appLanguage: AppLanguage = 'zh-CN'): string {
  return `${formatGraphEdgeType(edge.edgeType, appLanguage)} ${edge.confidence.toFixed(2)}`;
}

export function formatGraphRuntimeEdgeLabel(label: string, appLanguage: AppLanguage = 'zh-CN'): string {
  const [edgeType, ...rest] = label.split(/\s+/u);
  if (!edgeType) return label;
  return [formatGraphEdgeType(edgeType, appLanguage), ...rest].join(' ');
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
      | 'sidebarConversationOrganization'
      | 'sidebarConversationCollapsedStatusIdsByProject'
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
    sidebarConversationOrganization: normalizeSidebarConversationOrganization(raw.sidebarConversationOrganization),
    sidebarConversationCollapsedStatusIdsByProject: normalizeSidebarConversationCollapsedStatusIdsByProject(raw.sidebarConversationCollapsedStatusIdsByProject),
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
