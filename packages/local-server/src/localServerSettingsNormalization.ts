import { defaultTaskManagementStatusConfig, isTaskStatusFilter, normalizeTaskManagementStatusConfig, type ProjectCodeWorkspacePreference, type TaskManagementStatusConfig, type TaskPageViewMode, type TaskStatusFilter } from '@zeus/shared';
import type { TaskManagementStatus, TaskPriority } from '@zeus/storage';
import { listAiCliAdapters, type AiCliAdapterDescriptor } from '@zeus/ai-runtime';
import { parse } from 'node:path';
import type { RuntimeAutoConfirmationPolicy, RuntimeSettingsSnapshot } from './runtimeQueryApplication.js';

interface TelegramNotificationSettingsSnapshot {
  enabled: boolean;
  chatIds: number[];
  silentMode: boolean;
}

interface TelegramSecuritySettingsSnapshot {
  allowedUserIds: number[];
}

export interface SettingsIdentityCatalog {
  hasProjectId(projectId: string): boolean;
  hasTaskTemplateId(templateId: string): boolean;
}

export interface CodeMapSettingsSnapshot {
  defaultScanScope: 'project' | 'src' | 'custom';
  defaultIgnoreDirectories: string[];
  maxCallChainDepth: number;
  showLowConfidenceEdges: boolean;
  layoutAlgorithm: 'hierarchical' | 'force' | 'dagre';
  graphCacheStrategy: 'sqlite' | 'memory' | 'disabled';
  tableRelationInference: 'foreign_key_and_name' | 'foreign_key_only' | 'name_only' | 'disabled';
  aiSummaryEnabled: boolean;
  incrementalScanEnabled: boolean;
  performanceMonitoringEnabled: boolean;
  moduleFlowManualNotes: string;
}

export interface UpdateCodeMapSettingsBody {
  defaultScanScope?: unknown;
  defaultIgnoreDirectories?: unknown;
  maxCallChainDepth?: unknown;
  showLowConfidenceEdges?: unknown;
  layoutAlgorithm?: unknown;
  graphCacheStrategy?: unknown;
  tableRelationInference?: unknown;
  aiSummaryEnabled?: unknown;
  incrementalScanEnabled?: unknown;
  performanceMonitoringEnabled?: unknown;
  moduleFlowManualNotes?: unknown;
}

export interface UpdateRuntimeSettingsBody {
  defaultAdapterId?: string;
  adapterModels?: Record<string, unknown>;
  adapterDefaultArgs?: Record<string, unknown>;
  adapterCliPaths?: Record<string, unknown>;
  terminalEnv?: Record<string, unknown>;
  shell?: {
    path?: unknown;
    login?: unknown;
  };
  executionTimeoutSeconds?: unknown;
  logRetentionDays?: unknown;
  autoConfirmationPolicy?: unknown;
}

export type AppAppearance = 'system' | 'light' | 'dark';
export type AppLanguage = 'zh-CN' | 'en-US';
export type TaskTableColumnKey =
  | 'code'
  | 'intent'
  | 'taskType'
  | 'managementStatus'
  | 'branchStatus'
  | 'runStatus'
  | 'source'
  | 'updatedAt'
  | 'createdAt'
  | 'template'
  | 'project'
  | 'priority'
  | 'description'
  | 'runtimeSession'
  | 'rawId'
  | 'createdFrom';
export type TaskTableColumnWidth = number;
export type TaskTableSortDirection = 'asc' | 'desc';
export type TaskAgentRunStatus = 'not_started' | 'connecting' | 'reconnecting' | 'running' | 'waiting_user' | 'waiting_approval' | 'paused' | 'idle' | 'failed' | 'legacy_readonly';

export interface TaskTableSortState {
  columnKey: TaskTableColumnKey | null;
  direction: TaskTableSortDirection | null;
}

export interface TaskTableColumnPreferences {
  visibleColumnKeys: TaskTableColumnKey[];
  columnOrder: TaskTableColumnKey[];
  columnWidths?: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>>;
  sort: TaskTableSortState;
}

export interface TaskTableEnumSortOrders {
  priority: TaskPriority[];
  managementStatus: TaskManagementStatus[];
  runStatus: TaskAgentRunStatus[];
}

const defaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'taskType',
  'managementStatus',
  'branchStatus',
  'runStatus',
  'source',
  'createdAt',
  'updatedAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
const defaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'taskType', 'managementStatus', 'branchStatus', 'runStatus', 'source', 'createdAt', 'updatedAt'];
const defaultTaskTableColumnWidths: Record<TaskTableColumnKey, number> = {
  code: 112,
  intent: 280,
  taskType: 96,
  managementStatus: 112,
  branchStatus: 128,
  runStatus: 132,
  source: 120,
  updatedAt: 148,
  createdAt: 148,
  template: 144,
  project: 144,
  priority: 112,
  description: 220,
  runtimeSession: 180,
  rawId: 180,
  createdFrom: 144,
};
const legacyTaskTableColumnWidthScale = {
  compact: 0.78,
  standard: 1,
  wide: 1.35,
} as const;
const defaultTaskTableEnumSortOrders: TaskTableEnumSortOrders = {
  priority: ['p0', 'p1', 'p2', 'p3', 'p4'],
  managementStatus: ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'],
  runStatus: ['not_started', 'connecting', 'reconnecting', 'running', 'waiting_user', 'waiting_approval', 'paused', 'idle', 'failed', 'legacy_readonly'],
};
const preBranchStatusDefaultTaskTableColumnOrder: TaskTableColumnKey[] = [
  'code',
  'intent',
  'managementStatus',
  'runStatus',
  'source',
  'createdAt',
  'updatedAt',
  'template',
  'project',
  'priority',
  'description',
  'runtimeSession',
  'rawId',
  'createdFrom',
];
const preBranchStatusDefaultVisibleTaskTableColumns: TaskTableColumnKey[] = ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'createdAt', 'updatedAt'];
const previousDefaultTaskTableColumns: Array<{ visible: TaskTableColumnKey[]; order: TaskTableColumnKey[] }> = [
  {
    visible: preBranchStatusDefaultVisibleTaskTableColumns,
    order: preBranchStatusDefaultTaskTableColumnOrder,
  },
  {
    visible: ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'updatedAt'],
    order: ['code', 'intent', 'managementStatus', 'runStatus', 'source', 'updatedAt', 'createdAt', 'template', 'project', 'priority', 'description', 'runtimeSession', 'rawId', 'createdFrom'],
  },
];
const taskTableColumnKeySet = new Set<TaskTableColumnKey>(defaultTaskTableColumnOrder);
const legacyTaskTableColumnKeySet = new Set(['nextAction', 'aiExecution', 'signals']);

export function normalizeTaskTableColumnKeys(value: unknown, fallback: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<TaskTableColumnKey>();
  const keys = value.filter((item): item is TaskTableColumnKey => typeof item === 'string' && taskTableColumnKeySet.has(item as TaskTableColumnKey));
  for (const key of keys) seen.add(key);
  return seen.size > 0 ? Array.from(seen) : fallback;
}

export function normalizeTaskTableColumnPreferences(value: unknown): TaskTableColumnPreferences {
  const input = typeof value === 'object' && value !== null ? (value as Partial<TaskTableColumnPreferences>) : {};
  const hasLegacyColumns = containsLegacyTaskTableColumnKeys(input.visibleColumnKeys) || containsLegacyTaskTableColumnKeys(input.columnOrder);
  const visible = normalizeTaskTableColumnKeys(migrateLegacyTaskTableColumnKeys(input.visibleColumnKeys), defaultVisibleTaskTableColumns);
  // 编码和意图是任务列表的识别锚点，即使导入/保存缺失也要补回，避免用户配置损坏导致任务不可扫描。
  let visibleWithRequired = Array.from(new Set<TaskTableColumnKey>([...visible, 'code', 'intent']));
  const order = normalizeTaskTableColumnKeys(migrateLegacyTaskTableColumnKeys(input.columnOrder), defaultTaskTableColumnOrder);
  if (hasLegacyColumns) visibleWithRequired = placeStatusColumnsAfterIntent(visibleWithRequired);
  let migratedOrder = hasLegacyColumns ? placeStatusColumnsAfterIntent(order) : order;
  const usesPreviousDefault = previousDefaultTaskTableColumns.some((defaults) => taskTableColumnArraysEqual(visibleWithRequired, defaults.visible) && taskTableColumnArraysEqual(migratedOrder, defaults.order));
  if (usesPreviousDefault) {
    visibleWithRequired = [...defaultVisibleTaskTableColumns];
    migratedOrder = [...defaultTaskTableColumnOrder];
  } else {
    migratedOrder = insertMissingBranchStatusAfterManagementStatus(migratedOrder);
  }
  const columnWidths = normalizeTaskTableColumnWidths(input.columnWidths);
  const sort = normalizeTaskTableSortState(input.sort);
  // 用户传入顺序只决定已知列的优先级，其他合法列按默认顺序补齐，保证前端刷新后列集合稳定。
  const ordered = [...migratedOrder, ...defaultTaskTableColumnOrder.filter((key) => !migratedOrder.includes(key))];
  const normalized: TaskTableColumnPreferences = {
    visibleColumnKeys: visibleWithRequired.filter((key) => taskTableColumnKeySet.has(key)),
    columnOrder: ordered,
    sort,
  };
  if (columnWidths) normalized.columnWidths = columnWidths;
  return normalized;
}

export function insertMissingBranchStatusAfterManagementStatus(keys: TaskTableColumnKey[]): TaskTableColumnKey[] {
  if (keys.includes('branchStatus')) return keys;
  const managementStatusIndex = keys.indexOf('managementStatus');
  const insertIndex = managementStatusIndex >= 0 ? managementStatusIndex + 1 : 0;
  return [...keys.slice(0, insertIndex), 'branchStatus', ...keys.slice(insertIndex)];
}

export function taskTableColumnArraysEqual(left: readonly TaskTableColumnKey[], right: readonly TaskTableColumnKey[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export function normalizeTaskTableColumnWidths(value: unknown): Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const normalized: Partial<Record<TaskTableColumnKey, TaskTableColumnWidth>> = {};
  for (const [key, width] of Object.entries(value)) {
    if (!taskTableColumnKeySet.has(key as TaskTableColumnKey)) continue;
    const normalizedWidth = normalizeTaskTableColumnWidth(key as TaskTableColumnKey, width);
    if (normalizedWidth === null) continue;
    normalized[key as TaskTableColumnKey] = normalizedWidth;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeTaskTableColumnWidth(columnKey: TaskTableColumnKey, value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.min(640, Math.max(64, Math.round(value)));
  if (typeof value !== 'string' || !(value in legacyTaskTableColumnWidthScale)) return null;
  const scale = legacyTaskTableColumnWidthScale[value as keyof typeof legacyTaskTableColumnWidthScale];
  return Math.round(defaultTaskTableColumnWidths[columnKey] * scale);
}

export function normalizeTaskTableSortState(value: unknown): TaskTableSortState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { columnKey: null, direction: null };
  const input = value as Partial<TaskTableSortState>;
  const columnKey = typeof input.columnKey === 'string' && taskTableColumnKeySet.has(input.columnKey as TaskTableColumnKey) ? (input.columnKey as TaskTableColumnKey) : null;
  const direction = input.direction === 'asc' || input.direction === 'desc' ? input.direction : null;
  return columnKey && direction ? { columnKey, direction } : { columnKey: null, direction: null };
}

export function normalizeTaskTableColumnsByProject(value: unknown): Record<string, TaskTableColumnPreferences> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskTableColumnPreferences> = {};
  for (const [projectId, preferences] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter) continue;
    normalized[normalizedProjectId] = normalizeTaskTableColumnPreferences(preferences);
  }
  return normalized;
}

export function normalizeTaskStatusFilterByProject(value: unknown): Record<string, TaskStatusFilter> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskStatusFilter> = {};
  let count = 0;
  for (const [projectId, filter] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter || !isTaskStatusFilter(filter)) continue;
    normalized[normalizedProjectId] = filter;
    count += 1;
    if (count >= 100) break;
  }
  return normalized;
}

export function normalizeTaskViewModeByProject(value: unknown): Record<string, 'hierarchy' | 'flat'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([projectId, mode]) => Boolean(projectId.trim()) && projectId.length <= 160 && (mode === 'hierarchy' || mode === 'flat'))
      .slice(0, 100),
  ) as Record<string, 'hierarchy' | 'flat'>;
}

export function normalizeTaskPageViewByProject(value: unknown): Record<string, TaskPageViewMode> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, TaskPageViewMode] => Boolean(entry[0]) && (entry[1] === 'list' || entry[1] === 'board')));
}

export function normalizeTaskExpandedIdsByProject(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string[]> = {};
  for (const [projectId, taskIds] of Object.entries(value)) {
    if (!projectId.trim() || projectId.length > 160 || !Array.isArray(taskIds)) continue;
    normalized[projectId] = [...new Set(taskIds.filter((taskId): taskId is string => typeof taskId === 'string' && Boolean(taskId.trim()) && taskId.length <= 160))].slice(0, 500);
  }
  return normalized;
}

export function normalizeSidebarConversationOrganization(value: unknown): 'flat' | 'task_status' {
  return value === 'task_status' ? 'task_status' : 'flat';
}

export function normalizeSidebarConversationCollapsedStatusIdsByProject(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, string[]> = {};
  for (const [projectId, statusIds] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const invalidProjectId = !normalizedProjectId || normalizedProjectId.length > 160 || Array.from(normalizedProjectId).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
    if (invalidProjectId || !Array.isArray(statusIds)) continue;
    normalized[normalizedProjectId] = [
      ...new Set(
        statusIds
          .filter((statusId): statusId is string => typeof statusId === 'string')
          .map((statusId) => statusId.trim())
          .filter((statusId) => Boolean(statusId) && statusId.length <= 160 && !Array.from(statusId).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)),
      ),
    ].slice(0, 100);
    if (Object.keys(normalized).length >= 100) break;
  }
  return normalized;
}

export function normalizeTaskManagementStatusByProject(value: unknown, template: TaskManagementStatusConfig): Record<string, TaskManagementStatusConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, TaskManagementStatusConfig> = {};
  for (const [projectId, config] of Object.entries(value)) {
    const normalizedProjectId = projectId.trim();
    const containsControlCharacter = Array.from(normalizedProjectId).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127);
    if (!normalizedProjectId || normalizedProjectId.length > 160 || containsControlCharacter) continue;
    normalized[normalizedProjectId] = normalizeTaskManagementStatusConfig(config, template);
    if (Object.keys(normalized).length >= 100) break;
  }
  return normalized;
}

export function normalizeTaskTableEnumSortOrders(value: unknown): TaskTableEnumSortOrders {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<TaskTableEnumSortOrders>) : {};
  return {
    priority: normalizeEnumOrder(input.priority, defaultTaskTableEnumSortOrders.priority),
    managementStatus: normalizeEnumOrder(input.managementStatus, defaultTaskTableEnumSortOrders.managementStatus),
    runStatus: normalizeEnumOrder(input.runStatus, defaultTaskTableEnumSortOrders.runStatus),
  };
}

export function normalizeEnumOrder<T extends string>(value: unknown, fallback: readonly T[]): T[] {
  if (!Array.isArray(value)) return [...fallback];
  const allowed = new Set(fallback);
  const normalized = Array.from(new Set(value.filter((item): item is T => typeof item === 'string' && allowed.has(item as T))));
  return [...normalized, ...fallback.filter((item) => !normalized.includes(item))];
}

export function containsLegacyTaskTableColumnKeys(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => typeof item === 'string' && legacyTaskTableColumnKeySet.has(item));
}

export function placeStatusColumnsAfterIntent(keys: TaskTableColumnKey[]): TaskTableColumnKey[] {
  const withoutStatusColumns = keys.filter((key) => key !== 'managementStatus' && key !== 'runStatus');
  const intentIndex = withoutStatusColumns.indexOf('intent');
  const insertIndex = intentIndex >= 0 ? intentIndex + 1 : 0;
  return [...withoutStatusColumns.slice(0, insertIndex), 'managementStatus', 'runStatus', ...withoutStatusColumns.slice(insertIndex)];
}

export function migrateLegacyTaskTableColumnKeys(value: unknown): unknown {
  if (!containsLegacyTaskTableColumnKeys(value)) return value;
  if (!Array.isArray(value)) return value;
  const migrated: string[] = [];
  let insertedStatusColumns = false;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    if (legacyTaskTableColumnKeySet.has(item)) {
      if (!insertedStatusColumns) {
        migrated.push('managementStatus', 'runStatus');
        insertedStatusColumns = true;
      }
      continue;
    }
    migrated.push(item);
  }
  return migrated;
}

export interface AppShellSettingsSnapshot {
  appLanguage: AppLanguage;
  appearance: AppAppearance;
  webviewDebugEnabled: boolean;
  developerModeEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
  autoUpdateChannel: 'manual';
  defaultProjectId: string | null;
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  sidebarConversationOrganization: 'flat' | 'task_status';
  sidebarConversationCollapsedStatusIdsByProject: Record<string, string[]>;
  defaultModel: string | null;
  defaultTaskTemplateId: string | null;
  taskTableColumns: TaskTableColumnPreferences;
  taskTableColumnsByProject: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders: TaskTableEnumSortOrders;
  taskManagementStatusTemplate: TaskManagementStatusConfig;
  taskManagementStatusByProject: Record<string, TaskManagementStatusConfig>;
  taskStatusFilterByProject: Record<string, TaskStatusFilter>;
  taskViewModeByProject: Record<string, 'hierarchy' | 'flat'>;
  taskPageViewByProject: Record<string, TaskPageViewMode>;
  taskExpandedIdsByProject: Record<string, string[]>;
  codeWorkspaceByProject: Record<string, ProjectCodeWorkspacePreference>;
  localLogDirectory: string;
  localConfigPath: string;
  dataPortability: {
    importSupported: boolean;
    exportSupported: boolean;
    redactsSecrets: boolean;
  };
  cache: {
    codeIndex: boolean;
    graphView: boolean;
    layout: boolean;
  };
  lastCacheClearAt: string | null;
}

export interface UpdateAppShellSettingsBody {
  appLanguage?: AppLanguage;
  appearance?: AppAppearance;
  webviewDebugEnabled?: boolean;
  developerModeEnabled?: boolean;
  multiWindowEnabled?: boolean;
  backgroundModeEnabled?: boolean;
  desktopNotificationsEnabled?: boolean;
  openAtLoginEnabled?: boolean;
  autoUpdateChannel?: 'manual';
  defaultProjectId?: string | null;
  pinnedProjectIds?: string[];
  collapsedProjectIds?: string[];
  sidebarConversationOrganization?: 'flat' | 'task_status';
  sidebarConversationCollapsedStatusIdsByProject?: Record<string, string[]>;
  defaultModel?: string | null;
  defaultTaskTemplateId?: string | null;
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  taskTableColumnsByProject?: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  taskManagementStatusByProject?: Record<string, TaskManagementStatusConfig>;
  /** 删除状态时只作为本次保存的迁移指令，不进入持久设置。 */
  taskManagementStatusReplacements?: Record<string, Record<string, string>>;
  taskStatusFilterByProject?: Record<string, TaskStatusFilter>;
  taskViewModeByProject?: Record<string, 'hierarchy' | 'flat'>;
  taskPageViewByProject?: Record<string, TaskPageViewMode>;
  taskExpandedIdsByProject?: Record<string, string[]>;
  codeWorkspaceByProject?: Record<string, ProjectCodeWorkspacePreference>;
}

export interface ClearCacheResult {
  cleared: boolean;
  clearedCaches: Array<'code-index' | 'graph-view' | 'layout'>;
  clearedAt: string;
}

export interface LocalSettingsExportSnapshot {
  app: 'Zeus';
  schemaVersion: 1;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  settings: {
    appShell: AppShellSettingsSnapshot;
    runtime: RuntimeSettingsSnapshot;
    codeMap: CodeMapSettingsSnapshot;
    telegramNotification: TelegramNotificationSettingsSnapshot;
    telegramSecurity: TelegramSecuritySettingsSnapshot;
  };
}

export interface ImportLocalSettingsBody {
  schemaVersion?: number;
  settings?: {
    appShell?: UpdateAppShellSettingsBody;
    runtime?: RuntimeSettingsSnapshot;
    codeMap?: UpdateCodeMapSettingsBody;
    telegramNotification?: TelegramNotificationSettingsSnapshot;
    telegramSecurity?: TelegramSecuritySettingsSnapshot;
  };
}

export interface ImportLocalSettingsResult {
  imported: boolean;
  importedSettings: string[];
  importedAt: string;
}
export const runtimeSettingsKey = 'runtime.settings';
export const codeMapSettingsKey = 'codeMap.settings';
export const codexRemoteControlEnabledSettingKey = 'codex.remote_control.enabled';
export const projectConfigSettingsPrefix = 'project.config.';
export const defaultRuntimeSettings: RuntimeSettingsSnapshot = {
  defaultAdapterId: 'codex',
  adapterModels: {},
  adapterDefaultArgs: {},
  adapterCliPaths: {},
  terminalEnv: {},
  shell: { path: null, login: false },
  executionTimeoutSeconds: 3600,
  logRetentionDays: 30,
  autoConfirmationPolicy: 'never',
};
export const defaultCodeMapSettings: CodeMapSettingsSnapshot = {
  defaultScanScope: 'project',
  defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
  maxCallChainDepth: 3,
  showLowConfidenceEdges: false,
  layoutAlgorithm: 'hierarchical',
  graphCacheStrategy: 'sqlite',
  tableRelationInference: 'foreign_key_and_name',
  aiSummaryEnabled: false,
  incrementalScanEnabled: true,
  performanceMonitoringEnabled: false,
  moduleFlowManualNotes: '',
};
export function normalizeCodeMapSettings(value: unknown): CodeMapSettingsSnapshot | null {
  if (value === undefined) return defaultCodeMapSettings;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as UpdateCodeMapSettingsBody;
  const defaultScanScope = isCodeMapScanScope(raw.defaultScanScope) ? raw.defaultScanScope : defaultCodeMapSettings.defaultScanScope;
  const defaultIgnoreDirectories = normalizeCodeMapIgnoreDirectories(raw.defaultIgnoreDirectories);
  const maxCallChainDepth = normalizeIntegerRange(raw.maxCallChainDepth, defaultCodeMapSettings.maxCallChainDepth, 1, 10);
  if (!defaultIgnoreDirectories || maxCallChainDepth === null) return null;
  const layoutAlgorithm = isCodeMapLayoutAlgorithm(raw.layoutAlgorithm) ? raw.layoutAlgorithm : defaultCodeMapSettings.layoutAlgorithm;
  const graphCacheStrategy = isGraphCacheStrategy(raw.graphCacheStrategy) ? raw.graphCacheStrategy : defaultCodeMapSettings.graphCacheStrategy;
  const tableRelationInference = isTableRelationInference(raw.tableRelationInference) ? raw.tableRelationInference : defaultCodeMapSettings.tableRelationInference;
  const moduleFlowManualNotes = normalizeCodeMapManualNotes(raw.moduleFlowManualNotes);
  if (moduleFlowManualNotes === null) return null;
  return {
    defaultScanScope,
    defaultIgnoreDirectories,
    maxCallChainDepth,
    showLowConfidenceEdges: raw.showLowConfidenceEdges === true,
    layoutAlgorithm,
    graphCacheStrategy,
    tableRelationInference,
    aiSummaryEnabled: raw.aiSummaryEnabled === true,
    incrementalScanEnabled: raw.incrementalScanEnabled !== false,
    performanceMonitoringEnabled: raw.performanceMonitoringEnabled === true,
    moduleFlowManualNotes,
  };
}

export function normalizeCodeMapManualNotes(value: unknown): string | null {
  if (value === undefined) return defaultCodeMapSettings.moduleFlowManualNotes;
  if (typeof value !== 'string') return null;
  // 人工流程草稿只保存本机说明，不参与图谱事实生成；限制长度避免设置快照被日志/大文本污染。
  if (value.includes('\u0000') || value.length > 4000) return null;
  return value.trim();
}

export function normalizeCodeMapIgnoreDirectories(value: unknown): string[] | null {
  if (value === undefined) return defaultCodeMapSettings.defaultIgnoreDirectories;
  if (!Array.isArray(value)) return null;
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const directory = item.trim();
    if (!isSafeCodeMapIgnoreDirectory(directory)) return null;
    if (!seen.has(directory)) {
      seen.add(directory);
      items.push(directory);
    }
  }
  return items;
}

export function isSafeCodeMapIgnoreDirectory(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..') && value.length > 0 && value.length <= 80;
}

export function normalizeIntegerRange(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export function isCodeMapScanScope(value: unknown): value is CodeMapSettingsSnapshot['defaultScanScope'] {
  return value === 'project' || value === 'src' || value === 'custom';
}

export function isCodeMapLayoutAlgorithm(value: unknown): value is CodeMapSettingsSnapshot['layoutAlgorithm'] {
  return value === 'hierarchical' || value === 'force' || value === 'dagre';
}

export function isGraphCacheStrategy(value: unknown): value is CodeMapSettingsSnapshot['graphCacheStrategy'] {
  return value === 'sqlite' || value === 'memory' || value === 'disabled';
}

export function isTableRelationInference(value: unknown): value is CodeMapSettingsSnapshot['tableRelationInference'] {
  return value === 'foreign_key_and_name' || value === 'foreign_key_only' || value === 'name_only' || value === 'disabled';
}

export function normalizeRuntimeSettings(value: RuntimeSettingsSnapshot | undefined): RuntimeSettingsSnapshot {
  if (!value || !isRuntimeAdapterId(value.defaultAdapterId)) return defaultRuntimeSettings;
  return {
    defaultAdapterId: value.defaultAdapterId,
    adapterModels: normalizeRuntimeAdapterModels(value.adapterModels) ?? {},
    adapterDefaultArgs: normalizeRuntimeAdapterDefaultArgs(value.adapterDefaultArgs) ?? {},
    adapterCliPaths: normalizeRuntimeAdapterCliPaths(value.adapterCliPaths) ?? {},
    terminalEnv: normalizeRuntimeTerminalEnv(value.terminalEnv) ?? {},
    shell: normalizeRuntimeShellSettings(value.shell) ?? defaultRuntimeSettings.shell,
    executionTimeoutSeconds: normalizeRuntimeExecutionTimeoutSeconds(value.executionTimeoutSeconds) ?? defaultRuntimeSettings.executionTimeoutSeconds,
    logRetentionDays: normalizeRuntimeLogRetentionDays(value.logRetentionDays) ?? defaultRuntimeSettings.logRetentionDays,
    autoConfirmationPolicy: normalizeRuntimeAutoConfirmationPolicy(value.autoConfirmationPolicy) ?? defaultRuntimeSettings.autoConfirmationPolicy,
  };
}

export function normalizeImportedRuntimeSettings(value: RuntimeSettingsSnapshot | undefined): RuntimeSettingsSnapshot | null {
  if (!value || !isRuntimeAdapterId(value.defaultAdapterId) || value.defaultAdapterId === 'generic') return null;
  const adapterModels = normalizeRuntimeAdapterModels(value.adapterModels);
  const adapterDefaultArgs = normalizeRuntimeAdapterDefaultArgs(value.adapterDefaultArgs);
  const adapterCliPaths = normalizeRuntimeAdapterCliPaths(value.adapterCliPaths);
  const terminalEnv = normalizeRuntimeTerminalEnv(value.terminalEnv);
  const shell = normalizeRuntimeShellSettings(value.shell);
  const executionTimeoutSeconds = normalizeRuntimeExecutionTimeoutSeconds(value.executionTimeoutSeconds);
  const logRetentionDays = normalizeRuntimeLogRetentionDays(value.logRetentionDays);
  const autoConfirmationPolicy = normalizeRuntimeAutoConfirmationPolicy(value.autoConfirmationPolicy);
  if (!adapterModels || !adapterDefaultArgs || !adapterCliPaths || !terminalEnv || !shell || executionTimeoutSeconds === null || logRetentionDays === null || autoConfirmationPolicy === null) {
    return null;
  }
  // 设置快照导入只恢复安全的本机偏好；Generic shell 不能被导入为默认 adapter，避免绕过显式确认。
  return {
    defaultAdapterId: value.defaultAdapterId,
    adapterModels,
    adapterDefaultArgs,
    adapterCliPaths,
    terminalEnv,
    shell,
    executionTimeoutSeconds,
    logRetentionDays,
    autoConfirmationPolicy,
  };
}

export function normalizeAppShellSettings(value: AppShellSettingsSnapshot | undefined, fallbackLogDirectory: string, fallbackConfigPath: string, identities: SettingsIdentityCatalog): AppShellSettingsSnapshot {
  const appearance: AppAppearance = value?.appearance === 'light' || value?.appearance === 'dark' || value?.appearance === 'system' ? value.appearance : 'system';
  const appLanguage: AppLanguage = value?.appLanguage === 'en-US' ? 'en-US' : 'zh-CN';
  const taskManagementStatusTemplate = normalizeTaskManagementStatusConfig(value?.taskManagementStatusTemplate, defaultTaskManagementStatusConfig);
  return {
    appLanguage,
    appearance,
    webviewDebugEnabled: value?.webviewDebugEnabled === true,
    developerModeEnabled: value?.developerModeEnabled === true,
    multiWindowEnabled: typeof value?.multiWindowEnabled === 'boolean' ? value.multiWindowEnabled : true,
    backgroundModeEnabled: typeof value?.backgroundModeEnabled === 'boolean' ? value.backgroundModeEnabled : true,
    desktopNotificationsEnabled: typeof value?.desktopNotificationsEnabled === 'boolean' ? value.desktopNotificationsEnabled : true,
    openAtLoginEnabled: typeof value?.openAtLoginEnabled === 'boolean' ? value.openAtLoginEnabled : false,
    autoUpdateChannel: 'manual',
    defaultProjectId: normalizeDefaultProjectId(value?.defaultProjectId, identities),
    pinnedProjectIds: normalizeProjectPreferenceIds(value?.pinnedProjectIds),
    collapsedProjectIds: normalizeProjectPreferenceIds(value?.collapsedProjectIds),
    sidebarConversationOrganization: normalizeSidebarConversationOrganization(value?.sidebarConversationOrganization),
    sidebarConversationCollapsedStatusIdsByProject: normalizeSidebarConversationCollapsedStatusIdsByProject(value?.sidebarConversationCollapsedStatusIdsByProject),
    defaultModel: normalizeAppShellDefaultModel(value?.defaultModel),
    defaultTaskTemplateId: normalizeDefaultTaskTemplateId(value?.defaultTaskTemplateId, identities),
    taskTableColumns: normalizeTaskTableColumnPreferences(value?.taskTableColumns),
    taskTableColumnsByProject: normalizeTaskTableColumnsByProject(value?.taskTableColumnsByProject),
    taskTableEnumSortOrders: normalizeTaskTableEnumSortOrders(value?.taskTableEnumSortOrders),
    taskManagementStatusTemplate,
    taskManagementStatusByProject: normalizeTaskManagementStatusByProject(value?.taskManagementStatusByProject, taskManagementStatusTemplate),
    taskStatusFilterByProject: normalizeTaskStatusFilterByProject(value?.taskStatusFilterByProject),
    taskViewModeByProject: normalizeTaskViewModeByProject(value?.taskViewModeByProject),
    taskPageViewByProject: normalizeTaskPageViewByProject(value?.taskPageViewByProject),
    taskExpandedIdsByProject: normalizeTaskExpandedIdsByProject(value?.taskExpandedIdsByProject),
    codeWorkspaceByProject: normalizeCodeWorkspaceByProject(value?.codeWorkspaceByProject),
    localLogDirectory: fallbackLogDirectory,
    // 本地配置文件路径由当前运行实例决定，不接受导入文件覆盖，避免误指向其他机器路径。
    localConfigPath: fallbackConfigPath,
    dataPortability: {
      importSupported: true,
      exportSupported: true,
      redactsSecrets: true,
    },
    cache: { codeIndex: true, graphView: true, layout: true },
    lastCacheClearAt: typeof value?.lastCacheClearAt === 'string' ? value.lastCacheClearAt : null,
  };
}

export function patchAppShellSettings(current: AppShellSettingsSnapshot, input: UpdateAppShellSettingsBody, identities: SettingsIdentityCatalog): AppShellSettingsSnapshot {
  return normalizeAppShellSettings(
    {
      ...current,
      appLanguage: input.appLanguage === 'en-US' || input.appLanguage === 'zh-CN' ? input.appLanguage : current.appLanguage,
      appearance: input.appearance ?? current.appearance,
      webviewDebugEnabled: typeof input.webviewDebugEnabled === 'boolean' ? input.webviewDebugEnabled : current.webviewDebugEnabled,
      developerModeEnabled: typeof input.developerModeEnabled === 'boolean' ? input.developerModeEnabled : current.developerModeEnabled,
      multiWindowEnabled: typeof input.multiWindowEnabled === 'boolean' ? input.multiWindowEnabled : current.multiWindowEnabled,
      backgroundModeEnabled: typeof input.backgroundModeEnabled === 'boolean' ? input.backgroundModeEnabled : current.backgroundModeEnabled,
      desktopNotificationsEnabled: typeof input.desktopNotificationsEnabled === 'boolean' ? input.desktopNotificationsEnabled : current.desktopNotificationsEnabled,
      openAtLoginEnabled: typeof input.openAtLoginEnabled === 'boolean' ? input.openAtLoginEnabled : current.openAtLoginEnabled,
      autoUpdateChannel: 'manual',
      defaultProjectId: input.defaultProjectId === null ? null : typeof input.defaultProjectId === 'string' ? input.defaultProjectId : current.defaultProjectId,
      pinnedProjectIds: Array.isArray(input.pinnedProjectIds) ? normalizeProjectPreferenceIds(input.pinnedProjectIds) : current.pinnedProjectIds,
      collapsedProjectIds: Array.isArray(input.collapsedProjectIds) ? normalizeProjectPreferenceIds(input.collapsedProjectIds) : current.collapsedProjectIds,
      sidebarConversationOrganization: Object.prototype.hasOwnProperty.call(input, 'sidebarConversationOrganization')
        ? normalizeSidebarConversationOrganization(input.sidebarConversationOrganization)
        : current.sidebarConversationOrganization,
      sidebarConversationCollapsedStatusIdsByProject: Object.prototype.hasOwnProperty.call(input, 'sidebarConversationCollapsedStatusIdsByProject')
        ? normalizeSidebarConversationCollapsedStatusIdsByProject(input.sidebarConversationCollapsedStatusIdsByProject)
        : current.sidebarConversationCollapsedStatusIdsByProject,
      defaultModel: input.defaultModel === null ? null : typeof input.defaultModel === 'string' ? input.defaultModel : current.defaultModel,
      defaultTaskTemplateId: input.defaultTaskTemplateId === null ? null : typeof input.defaultTaskTemplateId === 'string' ? input.defaultTaskTemplateId : current.defaultTaskTemplateId,
      // taskTableColumns 支持局部保存；columnWidths 只有显式传入时才替换，空对象用于明确恢复默认列宽。
      taskTableColumns: input.taskTableColumns
        ? normalizeTaskTableColumnPreferences({
            ...current.taskTableColumns,
            ...input.taskTableColumns,
            columnWidths: Object.prototype.hasOwnProperty.call(input.taskTableColumns, 'columnWidths') ? input.taskTableColumns.columnWidths : current.taskTableColumns.columnWidths,
          })
        : current.taskTableColumns,
      taskTableColumnsByProject: Object.prototype.hasOwnProperty.call(input, 'taskTableColumnsByProject') ? normalizeTaskTableColumnsByProject(input.taskTableColumnsByProject) : current.taskTableColumnsByProject,
      taskTableEnumSortOrders: Object.prototype.hasOwnProperty.call(input, 'taskTableEnumSortOrders') ? normalizeTaskTableEnumSortOrders(input.taskTableEnumSortOrders) : current.taskTableEnumSortOrders,
      taskManagementStatusTemplate: Object.prototype.hasOwnProperty.call(input, 'taskManagementStatusTemplate')
        ? normalizeTaskManagementStatusConfig(input.taskManagementStatusTemplate, current.taskManagementStatusTemplate)
        : current.taskManagementStatusTemplate,
      taskManagementStatusByProject: Object.prototype.hasOwnProperty.call(input, 'taskManagementStatusByProject')
        ? normalizeTaskManagementStatusByProject(
            input.taskManagementStatusByProject,
            Object.prototype.hasOwnProperty.call(input, 'taskManagementStatusTemplate') ? normalizeTaskManagementStatusConfig(input.taskManagementStatusTemplate, current.taskManagementStatusTemplate) : current.taskManagementStatusTemplate,
          )
        : current.taskManagementStatusByProject,
      taskStatusFilterByProject: Object.prototype.hasOwnProperty.call(input, 'taskStatusFilterByProject') ? normalizeTaskStatusFilterByProject(input.taskStatusFilterByProject) : current.taskStatusFilterByProject,
      taskViewModeByProject: Object.prototype.hasOwnProperty.call(input, 'taskViewModeByProject') ? normalizeTaskViewModeByProject(input.taskViewModeByProject) : current.taskViewModeByProject,
      taskPageViewByProject: Object.prototype.hasOwnProperty.call(input, 'taskPageViewByProject') ? normalizeTaskPageViewByProject(input.taskPageViewByProject) : current.taskPageViewByProject,
      taskExpandedIdsByProject: Object.prototype.hasOwnProperty.call(input, 'taskExpandedIdsByProject') ? normalizeTaskExpandedIdsByProject(input.taskExpandedIdsByProject) : current.taskExpandedIdsByProject,
      codeWorkspaceByProject: Object.prototype.hasOwnProperty.call(input, 'codeWorkspaceByProject') ? normalizeCodeWorkspaceByProject(input.codeWorkspaceByProject) : current.codeWorkspaceByProject,
    },
    current.localLogDirectory,
    current.localConfigPath,
    identities,
  );
}

export function normalizeCodeWorkspaceByProject(value: unknown): Record<string, ProjectCodeWorkspacePreference> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([projectId, preference]) => Boolean(projectId.trim()) && preference && typeof preference === 'object' && !Array.isArray(preference))
    .slice(0, 100)
    .map(([projectId, preference]) => {
      const raw = preference as Partial<ProjectCodeWorkspacePreference>;
      const openFiles = normalizeSourcePreferencePaths(raw.openFiles, 20);
      const activeFile = typeof raw.activeFile === 'string' && normalizeSourcePreferencePaths([raw.activeFile], 1).length === 1 ? raw.activeFile : null;
      const expandedDirectories = normalizeSourcePreferencePaths(raw.expandedDirectories, 200);
      const treeWidth = Math.max(200, Math.min(420, Math.round(typeof raw.treeWidth === 'number' && Number.isFinite(raw.treeWidth) ? raw.treeWidth : 260)));
      return [projectId.trim(), { openFiles, activeFile, expandedDirectories, treeWidth } satisfies ProjectCodeWorkspacePreference] as const;
    });
  return Object.fromEntries(entries);
}

export function normalizeSourcePreferencePaths(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().replaceAll('\\', '/'))
        .filter((item) => Boolean(item) && !item.startsWith('/') && !item.includes('\0') && !item.split('/').includes('..') && !item.split('/').includes('.git')),
    ),
  ].slice(0, limit);
}

export function normalizeAppShellDefaultModel(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  const model = value.trim();
  // 通用默认模型只是本机偏好，限制为短单行文本，避免污染日志或后续 Runtime 参数展示。
  if (!model || model.length > 128 || hasControlCharacter(model)) return null;
  return model;
}

export function normalizeProjectPreferenceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || id.length > 120 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, 100);
}

export function normalizeDefaultProjectId(value: unknown, identities: SettingsIdentityCatalog): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  // 默认项目只能引用真实已连接项目；导入或保存未知 ID 时不创建占位项目。
  return identities.hasProjectId(value) ? value : null;
}

export function normalizeDefaultTaskTemplateId(value: unknown, identities: SettingsIdentityCatalog): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return null;
  // 默认任务模板只能引用真实存在的模板；保存或导入未知 ID 时不创建占位模板。
  return identities.hasTaskTemplateId(value) ? value : null;
}

export function normalizeRuntimeAutoConfirmationPolicy(value: unknown): RuntimeAutoConfirmationPolicy | null {
  if (value === undefined) return defaultRuntimeSettings.autoConfirmationPolicy;
  return value === 'never' || value === 'low_risk_only' ? value : null;
}

export function normalizeRuntimeAdapterModels(value: unknown): RuntimeSettingsSnapshot['adapterModels'] | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const adapterModels: RuntimeSettingsSnapshot['adapterModels'] = {};
  for (const [adapterId, rawModel] of Object.entries(value)) {
    if (!isRuntimeAdapterId(adapterId)) return null;
    if (typeof rawModel !== 'string') return null;
    const model = rawModel.trim();
    if (!model) continue;
    // 模型名会进入本机 CLI 参数，只允许短单行文本，避免控制字符污染日志或命令展示。
    if (model.length > 128 || hasControlCharacter(model)) return null;
    adapterModels[adapterId] = model;
  }
  return adapterModels;
}

export function normalizeRuntimeAdapterDefaultArgs(value: unknown): RuntimeSettingsSnapshot['adapterDefaultArgs'] | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const adapterArgs: RuntimeSettingsSnapshot['adapterDefaultArgs'] = {};
  for (const [adapterId, rawArgs] of Object.entries(value)) {
    if (!isRuntimeAdapterId(adapterId)) return null;
    if (!Array.isArray(rawArgs)) return null;
    const args = rawArgs.map((arg) => (typeof arg === 'string' ? arg.trim() : null));
    if (args.some((arg) => !arg || arg.length > 128 || hasControlCharacter(arg))) return null;
    if (args.length > 16) return null;
    if (args.length > 0) adapterArgs[adapterId] = args as string[];
  }
  return adapterArgs;
}

export function normalizeRuntimeAdapterCliPaths(value: unknown): RuntimeSettingsSnapshot['adapterCliPaths'] | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cliPaths: RuntimeSettingsSnapshot['adapterCliPaths'] = {};
  for (const [adapterId, rawPath] of Object.entries(value)) {
    if (!isRuntimeAdapterId(adapterId) || adapterId === 'generic') return null;
    if (typeof rawPath !== 'string') return null;
    const cliPath = rawPath.trim();
    if (!cliPath) continue;
    // CLI 路径只接受本机绝对路径；不检查存在性，避免把“已配置路径”伪造成“已安装/已登录”。
    if (!cliPath.startsWith('/') || cliPath.length > 256 || hasControlCharacter(cliPath)) return null;
    const basenameAdapter = listAiCliAdapters().find((adapter) => adapter.command === parse(cliPath).base);
    if (basenameAdapter && basenameAdapter.id !== adapterId) return null;
    cliPaths[adapterId] = cliPath;
  }
  return cliPaths;
}

export function normalizeRuntimeTerminalEnv(value: unknown): RuntimeSettingsSnapshot['terminalEnv'] | null {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const env: RuntimeSettingsSnapshot['terminalEnv'] = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(rawKey) || rawKey.length > 64) return null;
    if (typeof rawValue !== 'string') return null;
    const valueText = rawValue.trim();
    if (!valueText) continue;
    // 环境变量会进入真实子进程，限制为单行短文本，避免控制字符污染终端和日志。
    if (valueText.length > 512 || hasControlCharacter(valueText)) return null;
    env[rawKey] = valueText;
  }
  return env;
}

export function normalizeRuntimeShellSettings(value: unknown): RuntimeSettingsSnapshot['shell'] | null {
  if (value === undefined) return defaultRuntimeSettings.shell;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as { path?: unknown; login?: unknown };
  const path = typeof raw.path === 'string' ? raw.path.trim() : '';
  if (path && (!path.startsWith('/') || path.length > 256 || hasControlCharacter(path))) return null;
  return {
    path: path || null,
    login: raw.login === true,
  };
}

export function normalizeRuntimeExecutionTimeoutSeconds(value: unknown): number | null {
  if (value === undefined) return defaultRuntimeSettings.executionTimeoutSeconds;
  // 长时任务使用绝对截止时间和分段 timer，产品不再以 24 小时为上限。
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 60 || value > 315_360_000) return null;
  return value;
}

export function normalizeRuntimeLogRetentionDays(value: unknown): number | null {
  if (value === undefined) return defaultRuntimeSettings.logRetentionDays;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 365) return null;
  return value;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isRuntimeAdapterId(value: unknown): value is AiCliAdapterDescriptor['id'] {
  return listAiCliAdapters().some((adapter) => adapter.id === value);
}
