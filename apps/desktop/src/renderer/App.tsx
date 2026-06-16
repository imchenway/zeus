import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { buildMermaidDiagramExport, buildMermaidDiagramSource, toReactFlowElements, toSigmaGraph, type MermaidDiagramExportFile } from '@zeus/diagram-engine';
export { buildMermaidDiagramExport, buildMermaidDiagramSource, toReactFlowElements, toSigmaGraph, type MermaidDiagramExportFile } from '@zeus/diagram-engine';
import '@xterm/xterm/css/xterm.css';
import '@xyflow/react/dist/style.css';
import './styles.css';
import { notifyMainAppShellSettingsChanged } from './appShellBridge.js';
import {
  createEmptyDashboardSnapshot,
  type AiRuntimeAdapterDescriptor,
  type AppShellSettings,
  type AiRuntimeAdapterStatus,
  type AiRuntimeLogEntry,
  type AiRuntimeSession,
  type AiRuntimeTerminalEvent,
  type AiRuntimeTerminalSnapshot,
  type CodeMapSettings,
  type DashboardSnapshot,
  type ExecuteGitOperationRequest,
  type ExecutedGitOperationResult,
  type HighRiskGitOperation,
  type GitDiffHunk,
  type GitDiffSummary,
  type GitPatchExport,
  type GitOperationConfirmation,
  type GraphConversationHistoryItem,
  type GraphConversationHistoryPage,
  type GraphQuestionAnswer,
  type GraphSearchResult,
  type GraphViewSnapshot,
  type GraphViewType,
  type ImportLocalBusinessDataResult,
  type ImportLocalSettingsRequest,
  type ImportLocalSettingsResult,
  type LoadRuntimeSessionsRequest,
  type LocalBusinessDataSnapshot,
  type LocalSettingsExportSnapshot,
  type ProjectArchiveConfirmation,
  type ProjectConfig,
  type ProjectDatabaseSecretSnapshot,
  type CreateProjectRequest,
  type ProjectRecord,
  type ReleaseStatusSnapshot,
  type ReleaseUpdateStatusSnapshot,
  type RuntimeOperationConfirmation,
  type RuntimeSettings,
  type RuntimeStatusSnapshot,
  type SaveProjectConfigRequest,
  type SecurityAuditLogEntry,
  type SecurityResetResult,
  type SecuritySecretsSnapshot,
  type TelegramNotificationSettings,
  type TelegramTestConnectionResult,
  type TelegramPollingLogEntry,
  type TelegramPollingStatus,
  type TelegramSecuritySettings,
  type TaskEventRecord,
  type TaskRecord,
  type TaskStatus,
  type TaskTemplateRecord,
} from './apiClient.js';

const navItems = ['Projects', 'Conversations', 'Settings'] as const;
type MainNavItem = (typeof navItems)[number];
type MainNavTarget = 'projects' | 'conversations' | 'settings';
type LegacyMainNavTarget = MainNavTarget | 'dashboard' | 'tasks' | 'code-map' | 'runtime' | 'git-diff' | 'telegram';
type ProjectDetailPanel = 'graph' | 'diff' | 'edit' | 'config' | 'archive' | undefined;
type ConversationDrawer = 'runtime' | 'context' | 'changes' | 'templates' | undefined;
type SettingsCategory = 'general' | 'runtime' | 'telegram' | 'security' | 'git' | 'release' | 'data';
export type LocalClientStatus = 'connecting' | 'ready' | 'failed';
type WorkspaceViewId = MainNavTarget;
type SidebarGroup = {
  id: string;
  placement: 'main' | 'bottom';
  items: Array<{ label: string; target: MainNavTarget }>;
};
type EmptyPromptAction = {
  label: string;
  onAction?: () => void;
  disabled?: boolean;
};
const mainNavTargets = navItems.map(mainNavTargetForItem);
const sidebarGroups: SidebarGroup[] = [
  {
    id: 'primary',
    placement: 'main',
    items: [
      { label: '项目', target: 'projects' },
      { label: '对话', target: 'conversations' },
    ],
  },
  {
    id: 'settings',
    placement: 'bottom',
    items: [{ label: '设置', target: 'settings' }],
  },
];

/** 主导航只保留项目、对话、设置；旧 hash 入口统一迁移到新的收纳式工作区。 */
function mainNavTargetForItem(item: MainNavItem): MainNavTarget {
  if (item === 'Projects') return 'projects';
  if (item === 'Settings') return 'settings';
  return 'conversations';
}

function normalizeMainNavTarget(hash: string | undefined): MainNavTarget {
  const target = hash?.replace(/^#/, '');
  if (!target) return 'conversations';
  if (target === 'dashboard' || target === 'tasks' || target === 'runtime') return 'conversations';
  if (target === 'code-map' || target === 'git-diff') return 'projects';
  if (target === 'telegram' || target?.startsWith('settings-')) return 'settings';
  return mainNavTargets.includes(target as MainNavTarget) ? (target as MainNavTarget) : 'conversations';
}

function readCurrentMainNavTarget(): MainNavTarget {
  return typeof window === 'undefined' ? 'conversations' : normalizeMainNavTarget(window.location.hash);
}

/** 首屏只打开一个真实工作区；测试或恢复态带有明确数据时进入对应入口，避免把所有内容铺成一页。 */
function inferInitialMainNavTarget(props: {
  initialMainNavTarget?: LegacyMainNavTarget;
  initialGraphView?: GraphViewSnapshot;
  initialGraphAnswer?: GraphQuestionAnswer;
  initialGraphConversations?: GraphConversationHistoryItem[];
  initialTaskEvents?: TaskEventRecord[];
  initialGitDiff?: GitDiffSummary;
  initialGitConfirmation?: GitOperationConfirmation;
  initialRuntimeSessions?: AiRuntimeSession[];
  initialRuntimeStatus?: RuntimeStatusSnapshot;
  initialRuntimeLogs?: AiRuntimeLogEntry[];
  initialRuntimeAdapters?: AiRuntimeAdapterDescriptor[];
  initialRuntimeAdapterChecks?: Record<string, AiRuntimeAdapterStatus>;
  initialRuntimeSettings?: RuntimeSettings;
  initialRuntimeGenericShellCommand?: string;
  initialRuntimeConfirmation?: RuntimeOperationConfirmation;
  initialSecuritySecrets?: SecuritySecretsSnapshot;
  initialAppShellSettings?: AppShellSettings;
  initialReleaseStatus?: ReleaseStatusSnapshot;
  initialReleaseUpdateStatus?: ReleaseUpdateStatusSnapshot;
  initialSecurityAuditLogs?: SecurityAuditLogEntry[];
  initialLocalError?: LocalUiErrorSnapshot;
  initialProjectConfig?: ProjectConfig;
  initialProjectDatabaseSecret?: ProjectDatabaseSecretSnapshot;
  initialArchivedProjects?: ProjectRecord[];
  initialArchivedTasks?: TaskRecord[];
  initialTaskTemplates?: TaskTemplateRecord[];
  snapshot?: DashboardSnapshot;
}): MainNavTarget {
  if (props.initialMainNavTarget) return normalizeMainNavTarget(`#${props.initialMainNavTarget}`);
  if (typeof window !== 'undefined' && window.location.hash) return readCurrentMainNavTarget();
  if (props.initialSecuritySecrets || props.initialAppShellSettings || props.initialReleaseStatus || props.initialSecurityAuditLogs?.length || props.initialLocalError) return 'settings';
  if (props.initialProjectConfig || props.initialProjectDatabaseSecret || props.initialArchivedProjects?.length) return 'projects';
  if (props.initialGitDiff || props.initialGitConfirmation || props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length) return 'projects';
  if (
    props.initialTaskEvents?.length ||
    props.initialArchivedTasks?.length ||
    props.initialTaskTemplates?.length ||
    props.initialRuntimeStatus ||
    props.initialRuntimeSessions?.length ||
    props.initialRuntimeLogs?.length ||
    props.initialRuntimeAdapters?.length ||
    props.initialRuntimeSettings ||
    props.initialRuntimeGenericShellCommand ||
    props.initialRuntimeConfirmation ||
    (props.snapshot?.tasks.length ?? 0) > 0
  )
    return 'conversations';
  if (props.snapshot?.projects.length) return 'projects';
  return 'projects';
}

function syncRecordFromSnapshot<T extends { id: string }>(current: T | undefined, records: T[]): T | undefined {
  return current ? (records.find((record) => record.id === current.id) ?? records[0]) : records[0];
}

function normalizeProjectLocalPath(localPath: string): string {
  const trimmed = localPath.trim();
  if (trimmed === '/') return trimmed;
  return trimmed.replace(/\/+$/u, '');
}

function dedupeProjectRecordsByLocalPath(projects: ProjectRecord[]): ProjectRecord[] {
  const seen = new Set<string>();
  const deduped: ProjectRecord[] = [];
  for (const project of projects) {
    const key = normalizeProjectLocalPath(project.localPath);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push({ ...project, localPath: key });
  }
  return deduped;
}

function filterVisibleTasks(tasks: TaskRecord[], query: string, status: TaskStatus | '', tag: string, sortBy: 'createdAt' | 'updatedAt' | 'title' | 'status'): TaskRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  const normalizedTag = tag.trim().toLowerCase();
  const filtered = tasks.filter((task) => {
    const matchesQuery = !normalizedQuery || [task.title, task.description ?? '', task.id].some((value) => value.toLowerCase().includes(normalizedQuery));
    const matchesStatus = !status || task.status === status;
    const matchesTag = !normalizedTag || task.tags?.some((item) => item.toLowerCase().includes(normalizedTag));
    return matchesQuery && matchesStatus && matchesTag;
  });
  return [...filtered].sort((left, right) => {
    if (sortBy === 'title') return left.title.localeCompare(right.title);
    if (sortBy === 'status') return left.status.localeCompare(right.status);
    return left.id.localeCompare(right.id);
  });
}

const graphViewOptions: Array<{ type: GraphViewType; label: string }> = [
  { type: 'architecture', label: '系统架构图' },
  { type: 'module', label: '模块图' },
  { type: 'table', label: '表关系图' },
  { type: 'module_detail', label: '模块详情图' },
  { type: 'api_sequence', label: '接口时序图' },
  { type: 'module_flow', label: '模块流程图' },
  { type: 'method_logic', label: '方法逻辑图' },
];

function WorkspaceDrawer(props: { label: string; className?: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="workspace-drawer-backdrop" aria-label={`${props.label}背景`} onClick={props.onClose}>
      <aside className={`workspace-drawer ${props.className ?? ''}`} role="dialog" aria-modal="true" aria-label={props.label} onClick={(event) => event.stopPropagation()}>
        <div className="workspace-drawer-chrome">
          <strong>{props.label}</strong>
          <button type="button" onClick={props.onClose}>
            关闭{props.label}
          </button>
        </div>
        <div className="workspace-drawer-content">{props.children}</div>
      </aside>
    </div>
  );
}

/** Codex macOS 风格分组卡片：用于设置、项目列表等需要统一圆角和分割线的区域。 */
function NativeSettingsCard(props: { label: string; children: ReactNode; className?: string }) {
  return (
    <section className={`native-settings-card ${props.className ?? ''}`} aria-label={props.label}>
      {props.children}
    </section>
  );
}

/** Codex macOS 风格行：左侧保持标题与解释，右侧只放当前行的控件或状态。 */
function NativeControlRow(props: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`native-control-row ${props.className ?? ''}`}>
      <span className="native-control-copy">
        <strong>{props.title}</strong>
        {props.description ? <span className="native-control-description">{props.description}</span> : null}
      </span>
      <span className="native-control-slot">{props.children}</span>
    </div>
  );
}

export type LocalUiErrorSnapshot = {
  action: string;
  message: string;
  occurredAt: string;
};

/** Zeus 主界面：展示真实 API snapshot；无真实记录时才展示空状态。 */
export function App(props: {
  snapshot?: DashboardSnapshot;
  onScanCurrentGraph?: () => Promise<DashboardSnapshot>;
  onLoadGraphView?: (viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  onSearchGraph?: (query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => Promise<GraphSearchResult>;
  onAskGraph?: (projectId: string, question: string) => Promise<GraphQuestionAnswer>;
  onLoadGraphConversations?: (
    projectId: string,
    input?: {
      query?: string;
      limit?: number;
      offset?: number;
      archived?: boolean;
    },
  ) => Promise<GraphConversationHistoryPage>;
  onLoadGraphConversation?: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  onArchiveGraphConversation?: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  onRestoreGraphConversation?: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  onCreateTaskFromGraphConversation?: (projectId: string, conversationId: string) => Promise<DashboardSnapshot>;
  onCreateCurrentProject?: (defaults?: Pick<CreateProjectRequest, 'defaultModel' | 'defaultWorkMode' | 'defaultTaskPrompt'>) => Promise<DashboardSnapshot>;
  onLoadProjects?: (query?: string) => Promise<ProjectRecord[]>;
  onLoadProject?: (projectId: string) => Promise<ProjectRecord>;
  onLoadProjectConfig?: (projectId: string) => Promise<ProjectConfig>;
  onSaveProjectConfig?: (projectId: string, input: SaveProjectConfigRequest) => Promise<ProjectConfig>;
  onLoadProjectDatabaseSecret?: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  onSaveProjectDatabasePassword?: (projectId: string, password: string) => Promise<ProjectDatabaseSecretSnapshot>;
  onClearProjectDatabasePassword?: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  onUpdateProject?: (
    projectId: string,
    input: {
      name: string;
      localPath?: string;
      description?: string | null;
      note?: string | null;
    },
  ) => Promise<DashboardSnapshot>;
  onDeleteProject?: (projectId: string) => Promise<DashboardSnapshot>;
  onCreateProjectArchiveConfirmation?: (projectId: string) => Promise<ProjectArchiveConfirmation>;
  onArchiveProject?: (projectId: string) => Promise<DashboardSnapshot>;
  onRestoreProject?: (projectId: string) => Promise<DashboardSnapshot>;
  onLoadArchivedProjects?: () => Promise<ProjectRecord[]>;
  onLoadArchivedTasks?: (projectId: string) => Promise<TaskRecord[]>;
  onSetProjectDefaultTemplate?: (projectId: string, templateId: string | null) => Promise<DashboardSnapshot>;
  onCreateDefaultTask?: (projectId: string) => Promise<DashboardSnapshot>;
  onLoadTasks?: (projectId: string, query?: string, status?: TaskStatus, tag?: string, sortBy?: 'createdAt' | 'updatedAt' | 'title' | 'status') => Promise<TaskRecord[]>;
  onLoadTask?: (taskId: string) => Promise<TaskRecord>;
  onUpdateTask?: (taskId: string, input: { title: string; description?: string }) => Promise<DashboardSnapshot>;
  onUpdateTaskTags?: (taskId: string, tags: string[]) => Promise<DashboardSnapshot>;
  onDeleteTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRunTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onPauseTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onContinueTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onCancelTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRetryTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onCreateTaskFromGraphNode?: (nodeId: string, projectId: string) => Promise<DashboardSnapshot>;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => Promise<{
    opened: boolean;
    filePath: string | null;
    lineStart?: number | null;
  }>;
  onCreateTaskFromTemplate?: (templateId: string, projectId: string) => Promise<DashboardSnapshot>;
  onLoadGitDiff?: () => Promise<GitDiffSummary>;
  onExportGitPatch?: () => Promise<GitPatchExport>;
  onExportPatchFile?: (patch: GitPatchExport) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportMermaidDiagramFile?: (payload: MermaidDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  initialRuntimeStatus?: RuntimeStatusSnapshot;
  onLoadRuntimeStatus?: () => Promise<RuntimeStatusSnapshot>;
  onLoadRuntimeSettings?: () => Promise<RuntimeSettings>;
  onSaveRuntimeSettings?: (input: RuntimeSettings) => Promise<RuntimeSettings>;
  onLoadCodeMapSettings?: () => Promise<CodeMapSettings>;
  onSaveCodeMapSettings?: (input: CodeMapSettings) => Promise<CodeMapSettings>;
  onLoadAppShellSettings?: () => Promise<AppShellSettings>;
  onSaveAppShellSettings?: (
    input: Pick<
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
      | 'defaultModel'
      | 'defaultTaskTemplateId'
    >,
  ) => Promise<AppShellSettings>;
  onClearLocalCaches?: () => Promise<{
    cleared: boolean;
    clearedCaches: Array<'code-index' | 'graph-view' | 'layout'>;
    clearedAt: string;
  }>;
  onExportLocalSettings?: () => Promise<LocalSettingsExportSnapshot>;
  onImportLocalSettings?: (input: ImportLocalSettingsRequest) => Promise<ImportLocalSettingsResult>;
  onExportLocalBusinessData?: () => Promise<LocalBusinessDataSnapshot>;
  onImportLocalBusinessData?: (input: LocalBusinessDataSnapshot) => Promise<ImportLocalBusinessDataResult>;
  onExportSettingsFile?: (snapshot: LocalSettingsExportSnapshot) => Promise<{ saved: boolean; filePath: string | null }>;
  onExportBusinessDataFile?: (snapshot: LocalBusinessDataSnapshot) => Promise<{ saved: boolean; filePath: string | null }>;
  onImportSettingsFile?: () => Promise<{
    imported: boolean;
    filePath: string | null;
    snapshot?: LocalSettingsExportSnapshot;
  }>;
  onImportBusinessDataFile?: () => Promise<{
    imported: boolean;
    filePath: string | null;
    snapshot?: LocalBusinessDataSnapshot;
  }>;
  onLoadRuntimeAdapters?: () => Promise<AiRuntimeAdapterDescriptor[]>;
  onCheckRuntimeAdapter?: (adapterId: string) => Promise<AiRuntimeAdapterStatus>;
  onLoadRuntimeSessions?: (input?: LoadRuntimeSessionsRequest) => Promise<AiRuntimeSession[]>;
  onCreateRuntimeConfirmation?: (input: {
    action: 'start_generic_session';
    reason: string;
    session: {
      projectId: string;
      taskId?: string;
      command: string;
      args?: string[];
      cwd?: string;
    };
  }) => Promise<RuntimeOperationConfirmation>;
  onConfirmRuntimeOperation?: (confirmationId: string) => Promise<RuntimeOperationConfirmation>;
  onRejectRuntimeOperation?: (confirmationId: string, reason?: string) => Promise<RuntimeOperationConfirmation>;
  onStartRuntimeSession?: (input: { projectId: string; taskId?: string; command: string; args?: string[]; cwd?: string; confirmationId?: string }) => Promise<AiRuntimeSession>;
  onStopRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onLoadRuntimeSessionLogs?: (sessionId: string) => Promise<AiRuntimeLogEntry[]>;
  onSendRuntimeInput?: (sessionId: string, input: string) => Promise<AiRuntimeSession>;
  onInterruptRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onResizeRuntimeSession?: (sessionId: string, size: { cols: number; rows: number }) => Promise<AiRuntimeSession>;
  onLoadRuntimeTerminalSnapshot?: (sessionId: string) => Promise<AiRuntimeTerminalSnapshot>;
  onLoadRuntimeTerminalEvents?: (sessionId: string, input?: { limit?: number; offset?: number }) => Promise<{ items: AiRuntimeTerminalEvent[] }>;
  onGenerateRuntimeSessionSummary?: (sessionId: string) => Promise<AiRuntimeSession>;
  onSetRuntimeSessionFavorite?: (sessionId: string, favorite: boolean) => Promise<AiRuntimeSession>;
  onArchiveRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onRestoreRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onDeleteRuntimeSession?: (sessionId: string) => Promise<AiRuntimeSession>;
  onCreateTaskFromRuntimeSession?: (sessionId: string, input: { title?: string; instruction?: string }) => Promise<DashboardSnapshot>;
  onLoadSecuritySecrets?: () => Promise<SecuritySecretsSnapshot>;
  onLoadSecurityAuditLogs?: () => Promise<SecurityAuditLogEntry[]>;
  onLoadReleaseStatus?: () => Promise<ReleaseStatusSnapshot>;
  onCheckReleaseUpdate?: () => Promise<ReleaseUpdateStatusSnapshot>;
  onSaveTelegramBotToken?: (token: string) => Promise<SecuritySecretsSnapshot>;
  onClearTelegramBotToken?: () => Promise<SecuritySecretsSnapshot>;
  onSaveExternalApiKey?: (key: string) => Promise<SecuritySecretsSnapshot>;
  onClearExternalApiKey?: () => Promise<SecuritySecretsSnapshot>;
  onResetSecurity?: () => Promise<SecurityResetResult>;
  onLoadTelegramPollingStatus?: () => Promise<TelegramPollingStatus>;
  onLoadTelegramPollingLogs?: () => Promise<TelegramPollingLogEntry[]>;
  onStartTelegramPolling?: () => Promise<TelegramPollingStatus>;
  onStopTelegramPolling?: () => Promise<TelegramPollingStatus>;
  onPollTelegramOnce?: () => Promise<TelegramPollingStatus>;
  onTestTelegramConnection?: () => Promise<TelegramTestConnectionResult>;
  onLoadTelegramNotificationSettings?: () => Promise<TelegramNotificationSettings>;
  onSaveTelegramNotificationSettings?: (input: TelegramNotificationSettings) => Promise<TelegramNotificationSettings>;
  onLoadTelegramSecuritySettings?: () => Promise<TelegramSecuritySettings>;
  onSaveTelegramSecuritySettings?: (input: TelegramSecuritySettings) => Promise<TelegramSecuritySettings>;
  onLoadTaskTemplates?: (projectId?: string) => Promise<TaskTemplateRecord[]>;
  onLoadTaskEvents?: (taskId: string) => Promise<TaskEventRecord[]>;
  onUpdateTaskStatus?: (taskId: string, status: TaskStatus) => Promise<DashboardSnapshot>;
  onArchiveTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onRestoreTask?: (taskId: string) => Promise<DashboardSnapshot>;
  onCreateGitConfirmation?: (operation: HighRiskGitOperation, message?: string) => Promise<GitOperationConfirmation>;
  onConfirmGitOperation?: (confirmationId: string) => Promise<GitOperationConfirmation>;
  onRejectGitOperation?: (confirmationId: string, reason?: string) => Promise<GitOperationConfirmation>;
  onExecuteGitOperation?: (input: ExecuteGitOperationRequest) => Promise<ExecutedGitOperationResult>;
  initialTaskEvents?: TaskEventRecord[];
  initialTaskTemplates?: TaskTemplateRecord[];
  initialArchivedProjects?: ProjectRecord[];
  initialArchivedTasks?: TaskRecord[];
  initialGraphView?: GraphViewSnapshot;
  initialGraphAnswer?: GraphQuestionAnswer;
  initialGraphConversations?: GraphConversationHistoryItem[];
  initialRuntimeSessions?: AiRuntimeSession[];
  initialRuntimeLogs?: AiRuntimeLogEntry[];
  initialRuntimeAdapters?: AiRuntimeAdapterDescriptor[];
  initialRuntimeAdapterChecks?: Record<string, AiRuntimeAdapterStatus>;
  initialRuntimeSettings?: RuntimeSettings;
  initialRuntimeGenericShellCommand?: string;
  initialSecuritySecrets?: SecuritySecretsSnapshot;
  initialRuntimeConfirmation?: RuntimeOperationConfirmation;
  initialCodeMapSettings?: CodeMapSettings;
  initialProjectConfig?: ProjectConfig;
  initialProjectDatabaseSecret?: ProjectDatabaseSecretSnapshot;
  initialAppShellSettings?: AppShellSettings;
  initialReleaseStatus?: ReleaseStatusSnapshot;
  initialReleaseUpdateStatus?: ReleaseUpdateStatusSnapshot;
  initialSecurityAuditLogs?: SecurityAuditLogEntry[];
  initialGitConfirmation?: GitOperationConfirmation;
  initialGitDiff?: GitDiffSummary;
  initialLocalError?: LocalUiErrorSnapshot;
  localClientStatus?: LocalClientStatus;
  localClientError?: string;
  initialMainNavTarget?: LegacyMainNavTarget;
}) {
  const [activeNavTarget, setActiveNavTarget] = useState<MainNavTarget>(() => inferInitialMainNavTarget(props));
  const workspaceScrollRef = useRef<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState<DashboardSnapshot>(() => props.snapshot ?? createEmptyDashboardSnapshot());
  const [gitDiff, setGitDiff] = useState<GitDiffSummary | undefined>(() => props.initialGitDiff);
  const [gitHunkDecisions, setGitHunkDecisions] = useState<Record<string, 'accepted' | 'rejected'>>({});
  const [patchExportStatus, setPatchExportStatus] = useState('尚未导出 Patch');
  const [graphView, setGraphView] = useState<GraphViewSnapshot | undefined>(() => props.initialGraphView);
  const [graphAnswer, setGraphAnswer] = useState<GraphQuestionAnswer | undefined>(() => props.initialGraphAnswer);
  const [graphConversations, setGraphConversations] = useState<GraphConversationHistoryItem[]>(() => props.initialGraphConversations ?? []);
  const [graphConversationPage, setGraphConversationPage] = useState<Pick<GraphConversationHistoryPage, 'total' | 'limit' | 'offset' | 'query' | 'archived'>>(() => ({
    total: props.initialGraphConversations?.length ?? 0,
    limit: 5,
    offset: 0,
    query: null,
    archived: false,
  }));
  const [selectedGraphConversation, setSelectedGraphConversation] = useState<GraphConversationHistoryItem | undefined>(() => props.initialGraphConversations?.[0]);
  const [graphConversationSearch, setGraphConversationSearch] = useState('local-server');
  const [taskEvents, setTaskEvents] = useState<TaskEventRecord[]>(() => props.initialTaskEvents ?? []);
  const [taskTemplates, setTaskTemplates] = useState<TaskTemplateRecord[]>(() => props.initialTaskTemplates ?? []);
  const [archivedProjects, setArchivedProjects] = useState<ProjectRecord[]>(() => props.initialArchivedProjects ?? []);
  const [archivedTasks, setArchivedTasks] = useState<TaskRecord[]>(() => props.initialArchivedTasks ?? []);
  const [projectDetail, setProjectDetail] = useState<ProjectRecord | undefined>(() => props.snapshot?.projects[0]);
  const [taskDetail, setTaskDetail] = useState<TaskRecord | undefined>(() => props.snapshot?.tasks[0]);
  const [projectSearchQuery, setProjectSearchQuery] = useState('Zeus');
  const [createProjectConfigForm] = useState(() => ({
    defaultModel: '',
    defaultWorkMode: 'plan' as ProjectConfig['defaultWorkMode'],
    defaultTaskPrompt: '',
  }));
  const [taskSearchQuery, setTaskSearchQuery] = useState('Bug');
  const [taskStatusFilter, setTaskStatusFilter] = useState<TaskStatus | ''>('ready');
  const [taskTagFilter, setTaskTagFilter] = useState('backend');
  const [taskSortBy, setTaskSortBy] = useState<'createdAt' | 'updatedAt' | 'title' | 'status'>('title');
  const [projectEditForm, setProjectEditForm] = useState(() => ({
    name: props.snapshot?.projects[0]?.name ?? '',
    localPath: props.snapshot?.projects[0]?.localPath ?? '',
    description: props.snapshot?.projects[0]?.description ?? '',
    note: props.snapshot?.projects[0]?.note ?? '',
  }));
  const initialProjectConfig = normalizeProjectConfig(props.initialProjectConfig, props.snapshot?.projects[0]?.id);
  const [projectConfig, setProjectConfig] = useState<ProjectConfig | undefined>(() => initialProjectConfig);
  const [projectConfigForm, setProjectConfigForm] = useState<ProjectConfigFormState>(() => toProjectConfigForm(initialProjectConfig));
  const [projectDatabaseSecret] = useState<ProjectDatabaseSecretSnapshot | undefined>(() => props.initialProjectDatabaseSecret);
  const [taskEditForm, setTaskEditForm] = useState(() => ({
    title: props.snapshot?.tasks[0]?.title ?? '',
    description: props.snapshot?.tasks[0]?.description ?? '',
    tags: props.snapshot?.tasks[0]?.tags?.join(', ') ?? '',
  }));
  const [pendingProjectDeleteId, setPendingProjectDeleteId] = useState<string | undefined>();

  useEffect(() => {
    if (!props.snapshot) return;
    // 同步 Electron hydration 后传入的真实 snapshot，避免首屏 connecting 空状态锁死后续真实项目与任务。
    setSnapshot(props.snapshot);
    const nextProject = syncRecordFromSnapshot(projectDetail, props.snapshot.projects);
    const nextTask = syncRecordFromSnapshot(taskDetail, props.snapshot.tasks);
    setProjectDetail(nextProject);
    setTaskDetail(nextTask);
    setProjectEditForm({
      name: nextProject?.name ?? '',
      localPath: nextProject?.localPath ?? '',
      description: nextProject?.description ?? '',
      note: nextProject?.note ?? '',
    });
    setTaskEditForm({
      title: nextTask?.title ?? '',
      description: nextTask?.description ?? '',
      tags: nextTask?.tags?.join(', ') ?? '',
    });
  }, [props.snapshot]);

  const [graphSearchResult, setGraphSearchResult] = useState<GraphSearchResult | undefined>();
  const [gitConfirmation, setGitConfirmation] = useState<GitOperationConfirmation | undefined>(() => props.initialGitConfirmation);
  const [gitOperationStatus, setGitOperationStatus] = useState('尚未执行 Git 写操作');
  const [gitCommitMessage, setGitCommitMessage] = useState('');
  const [gitBranchName, setGitBranchName] = useState('');
  const [gitSwitchBranchName, setGitSwitchBranchName] = useState('');
  const [gitBaseRef, setGitBaseRef] = useState('');
  const [gitStashRef, setGitStashRef] = useState('stash@{0}');
  const [gitRemote, setGitRemote] = useState('origin');
  const [gitTargetRef, setGitTargetRef] = useState('main');
  const [gitRollbackRef, setGitRollbackRef] = useState('HEAD');
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatusSnapshot | undefined>(props.initialRuntimeStatus);
  const [runtimeAdapters, setRuntimeAdapters] = useState<AiRuntimeAdapterDescriptor[]>(() => props.initialRuntimeAdapters ?? []);
  const [runtimeSettings, setRuntimeSettings] = useState<RuntimeSettings>(() => normalizeRuntimeSettings(props.initialRuntimeSettings));
  const [codeMapSettings, setCodeMapSettings] = useState<CodeMapSettings>(() => normalizeCodeMapSettings(props.initialCodeMapSettings));
  const [appShellSettings, setAppShellSettings] = useState<AppShellSettings>(
    () =>
      props.initialAppShellSettings ?? {
        appLanguage: 'zh-CN',
        appearance: 'system',
        webviewDebugEnabled: false,
        developerModeEnabled: false,
        multiWindowEnabled: true,
        backgroundModeEnabled: true,
        desktopNotificationsEnabled: true,
        openAtLoginEnabled: false,
        autoUpdateChannel: 'manual',
        defaultProjectId: null,
        defaultModel: null,
        defaultTaskTemplateId: null,
        localLogDirectory: 'Zeus/logs',
        localConfigPath: 'Zeus/zeus.config.json',
        dataPortability: {
          importSupported: true,
          exportSupported: true,
          redactsSecrets: true,
        },
        cache: { codeIndex: true, graphView: true, layout: true },
        lastCacheClearAt: null,
      },
  );
  const [dataPortabilityStatus, setDataPortabilityStatus] = useState('尚未导入/导出');
  const [runtimeAdapterChecks, setRuntimeAdapterChecks] = useState<Record<string, AiRuntimeAdapterStatus>>(() => props.initialRuntimeAdapterChecks ?? {});
  const [runtimeConfirmation, setRuntimeConfirmation] = useState<RuntimeOperationConfirmation | undefined>(() => props.initialRuntimeConfirmation);
  const [runtimeConfirmationCommand, setRuntimeConfirmationCommand] = useState(() => props.initialRuntimeConfirmation?.session.args.slice(1).join(' ') ?? '');
  const [runtimeGenericShellCommand, setRuntimeGenericShellCommand] = useState(props.initialRuntimeGenericShellCommand ?? '');
  const [runtimeGenericShellCriticalConfirmation, setRuntimeGenericShellCriticalConfirmation] = useState('');
  const genericShellRisk = classifyGenericShellCommandRisk(runtimeGenericShellCommand);
  const genericShellCriticalConfirmed = isGenericShellCriticalConfirmationSatisfied(genericShellRisk, runtimeGenericShellCriticalConfirmation);
  const [runtimeConfirmationStatus, setRuntimeConfirmationStatus] = useState(() => (props.initialRuntimeConfirmation?.status === 'rejected' ? '已拒绝 Generic shell 确认；不会启动 Runtime 会话' : '尚未创建 Generic shell 确认'));
  const [runtimeSessions, setRuntimeSessions] = useState<AiRuntimeSession[]>(() => props.initialRuntimeSessions ?? []);
  const [runtimeLogs, setRuntimeLogs] = useState<AiRuntimeLogEntry[]>(() => props.initialRuntimeLogs ?? []);
  const [runtimeSearchQuery, setRuntimeSearchQuery] = useState('');
  const [runtimeInput, setRuntimeInput] = useState('');
  const [runtimeFavoriteOnly, setRuntimeFavoriteOnly] = useState(false);
  const [runtimeShowArchived, setRuntimeShowArchived] = useState(false);
  const [runtimeLogExportStatus, setRuntimeLogExportStatus] = useState('尚未导出 Runtime 日志');
  const [runtimeLogSearchQuery, setRuntimeLogSearchQuery] = useState('');
  const [runtimeLogsCollapsed, setRuntimeLogsCollapsed] = useState(false);
  const [runtimeLogCopyStatus, setRuntimeLogCopyStatus] = useState('尚未复制 Runtime 日志');
  const [securitySecrets, setSecuritySecrets] = useState<SecuritySecretsSnapshot>(
    () =>
      props.initialSecuritySecrets ?? {
        telegramBotToken: { configured: false, label: '未配置' },
        externalApiKey: { configured: false, label: '未配置' },
      },
  );
  const [externalApiKeyInput, setExternalApiKeyInput] = useState('');
  const [securityAuditLogs, setSecurityAuditLogs] = useState<SecurityAuditLogEntry[]>(() => props.initialSecurityAuditLogs ?? []);
  const [releaseStatus, setReleaseStatus] = useState<ReleaseStatusSnapshot>(
    () =>
      props.initialReleaseStatus ?? {
        signing: { configured: false, label: '等待 Apple 签名证书' },
        notarization: { configured: false, label: '等待 Apple 公证凭据' },
        homebrewCask: { configured: false, label: '等待 Homebrew cask 文件' },
        releaseWorkflow: {
          configured: false,
          label: '等待 GitHub Release workflow',
        },
        readiness: {
          canBuildUnsignedArtifacts: true,
          canSign: false,
          canNotarize: false,
          waitingFor: ['Apple signing certificate', 'Apple notarization credentials'],
        },
        autoUpdate: {
          currentVersion: '0.1.0',
          channel: 'manual',
          checkMode: 'manual',
          updateFeedConfigured: false,
          changelogPath: 'docs/release.md',
          waitingFor: ['signed and notarized artifacts'],
          label: '手动更新 · 0.1.0',
        },
      },
  );
  const [releaseUpdateStatus, setReleaseUpdateStatus] = useState<ReleaseUpdateStatusSnapshot>(
    () =>
      props.initialReleaseUpdateStatus ?? {
        status: 'unavailable',
        currentVersion: '0.1.0',
        latestVersion: '0.1.0',
        channel: 'stable',
        releasePageUrl: 'https://github.com/imchenway/zeus/releases/latest',
        artifact: null,
        automaticInstallEnabled: false,
        recommendedAction: 'open_download_page',
        label: '暂未检查更新',
        reason: '点击检查更新后读取 GitHub Release manifest；未签名或未公证的产物只允许手动安装。',
        checkedAt: '',
      },
  );
  const [releaseUpdateCheckState, setReleaseUpdateCheckState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [telegramTokenInput, setTelegramTokenInput] = useState('');
  const [telegramPollingStatus, setTelegramPollingStatus] = useState<TelegramPollingStatus>({
    running: false,
    offset: 0,
    lastError: null,
    handledUpdates: 0,
  });
  const [telegramPollingLogs] = useState<TelegramPollingLogEntry[]>([]);
  const [telegramNotificationSettings, setTelegramNotificationSettings] = useState<TelegramNotificationSettings>({
    enabled: true,
    chatIds: [],
    silentMode: false,
  });
  const [telegramNotificationChatIdsInput, setTelegramNotificationChatIdsInput] = useState('');
  const [telegramTestStatus, setTelegramTestStatus] = useState('尚未测试连接');
  const [telegramSecuritySettings, setTelegramSecuritySettings] = useState<TelegramSecuritySettings>({ allowedUserIds: [] });
  const [telegramAllowedUserIdsInput, setTelegramAllowedUserIdsInput] = useState('');
  const [scanState, setScanState] = useState<'idle' | 'scanning' | 'failed'>('idle');
  const [actionState, setActionState] = useState<
    'idle' | 'creating-project' | 'creating-task' | 'loading-diff' | 'loading-runtime' | 'loading-templates' | 'updating-task' | 'creating-git-confirmation' | 'confirming-git-operation' | 'executing-git-operation' | 'failed'
  >('idle');
  const [localError, setLocalError] = useState<LocalUiErrorSnapshot | undefined>(() => normalizeLocalUiError(props.initialLocalError));
  const localClientStatus = props.localClientStatus ?? (props.onCreateCurrentProject ? 'ready' : 'connecting');
  const localClientReady = localClientStatus === 'ready';
  const gitLabel = snapshot.git.isRepository ? `Git ${snapshot.git.branch}` : 'Git 未检测';
  useEffect(() => {
    const syncActiveTarget = () => setActiveNavTarget(readCurrentMainNavTarget());
    syncActiveTarget();
    window.addEventListener('hashchange', syncActiveTarget);
    return () => window.removeEventListener('hashchange', syncActiveTarget);
  }, []);

  const visibleProjects = useMemo(() => dedupeProjectRecordsByLocalPath(snapshot.projects), [snapshot.projects]);
  const firstProject = visibleProjects[0];
  const firstProjectId = firstProject?.id;
  const runtime = runtimeStatus ?? {
    aiCli: {
      name: 'Codex CLI',
      command: 'codex',
      available: snapshot.runtime.aiCli.available,
      reason: snapshot.runtime.aiCli.reason,
    },
    telegram: snapshot.runtime.telegram,
    terminal: {
      provider: 'child_process' as const,
      pty: {
        available: false,
        reason: 'node-pty 状态等待读取；当前不会声称 xterm 已启用。',
      },
    },
  };
  const [projectPanel, setProjectPanel] = useState<ProjectDetailPanel>(() => {
    if (props.initialMainNavTarget === 'code-map' || props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length) return 'graph';
    if (props.initialMainNavTarget === 'git-diff' || props.initialGitDiff || props.initialGitConfirmation) return 'diff';
    if (props.initialProjectConfig || props.initialProjectDatabaseSecret) return 'config';
    if (props.initialArchivedProjects?.length) return 'archive';
    return undefined;
  });
  const [conversationDrawer, setConversationDrawer] = useState<ConversationDrawer>(() => {
    if (
      props.initialMainNavTarget === 'runtime' ||
      props.initialRuntimeStatus ||
      props.initialRuntimeSessions?.length ||
      props.initialRuntimeLogs?.length ||
      props.initialRuntimeAdapters?.length ||
      props.initialRuntimeSettings ||
      props.initialRuntimeGenericShellCommand ||
      props.initialRuntimeConfirmation
    )
      return 'runtime';
    if (props.initialMainNavTarget === 'code-map' || props.initialGraphView || props.initialGraphAnswer || props.initialGraphConversations?.length) return 'context';
    if (props.initialMainNavTarget === 'git-diff' || props.initialGitDiff || props.initialGitConfirmation) return 'changes';
    if (props.initialTaskTemplates?.length) return 'templates';
    return undefined;
  });
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory>(() => {
    if (props.initialMainNavTarget === 'telegram' || props.initialSecuritySecrets?.telegramBotToken.configured) return 'telegram';
    if (props.initialRuntimeSettings || props.initialRuntimeStatus) return 'runtime';
    if (props.initialSecuritySecrets || props.initialSecurityAuditLogs?.length) return 'security';
    if (props.initialReleaseStatus) return 'release';
    return 'general';
  });
  const selectedProject = projectDetail ?? firstProject;
  const selectedTask = taskDetail ?? snapshot.tasks[0];
  const visibleTasks = useMemo(() => filterVisibleTasks(snapshot.tasks, taskSearchQuery, taskStatusFilter, taskTagFilter, taskSortBy), [snapshot.tasks, taskSearchQuery, taskStatusFilter, taskTagFilter, taskSortBy]);
  const changedFiles = gitDiff?.files ?? snapshot.git.changedFiles;

  function recordLocalError(action: string, error: unknown): void {
    // 只记录真实捕获到的前端操作失败，并在渲染前脱敏，避免把 token / API key 明文带到界面。
    setLocalError({
      action,
      message: redactLocalUiErrorMessage(errorToLocalUiMessage(error)),
      occurredAt: new Date().toISOString(),
    });
    setActionState('failed');
  }

  async function loadFilteredTasks(): Promise<void> {
    if (!props.onLoadTasks || !firstProjectId) return;
    setActionState('updating-task');
    try {
      const tasks = await props.onLoadTasks(firstProjectId, taskSearchQuery.trim() || undefined, taskStatusFilter || undefined, taskTagFilter.trim() || undefined, taskSortBy);
      setSnapshot((current) => ({ ...current, tasks }));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function loadTaskDetail(taskId: string): Promise<void> {
    if (!props.onLoadTask) {
      setTaskDetail(snapshot.tasks.find((task) => task.id === taskId));
      return;
    }
    setActionState('updating-task');
    try {
      const task = await props.onLoadTask(taskId);
      setTaskDetail(task);
      setTaskEditForm({
        title: task.title,
        description: task.description ?? '',
        tags: task.tags?.join(', ') ?? '',
      });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function updateTask(taskId: string, event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!props.onUpdateTask) return;
    const title = taskEditForm.title.trim();
    if (!title) return;
    setActionState('updating-task');
    try {
      const nextSnapshot = await props.onUpdateTask(taskId, {
        title,
        description: taskEditForm.description.trim(),
      });
      setSnapshot(nextSnapshot);
      const updatedTask = nextSnapshot.tasks.find((task) => task.id === taskId);
      setTaskDetail(updatedTask);
      if (updatedTask)
        setTaskEditForm({
          title: updatedTask.title,
          description: updatedTask.description ?? '',
          tags: updatedTask.tags?.join(', ') ?? taskEditForm.tags,
        });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function searchProjects(): Promise<void> {
    if (!props.onLoadProjects) return;
    setActionState('creating-project');
    try {
      const projects = await props.onLoadProjects(projectSearchQuery.trim() || undefined);
      setSnapshot((current) => ({ ...current, projects }));
      setProjectDetail(projects[0]);
      if (projects[0])
        setProjectEditForm({
          name: projects[0].name,
          localPath: projects[0].localPath,
          description: projects[0].description ?? '',
          note: projects[0].note ?? '',
        });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function loadProjectDetail(projectId: string): Promise<void> {
    if (!props.onLoadProject) {
      setProjectDetail(visibleProjects.find((project) => project.id === projectId));
      return;
    }
    setActionState('creating-project');
    try {
      const project = await props.onLoadProject(projectId);
      setProjectDetail(project);
      setProjectEditForm({
        name: project.name,
        localPath: project.localPath,
        description: project.description ?? '',
        note: project.note ?? '',
      });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function loadProjectConfig(projectId: string): Promise<void> {
    if (!props.onLoadProjectConfig) return;
    setActionState('creating-project');
    try {
      const loadedConfig = normalizeProjectConfig(await props.onLoadProjectConfig(projectId), projectId);
      setProjectConfig(loadedConfig);
      setProjectConfigForm(toProjectConfigForm(loadedConfig));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function saveProjectConfig(projectId: string, event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!props.onSaveProjectConfig) return;
    const input: SaveProjectConfigRequest = {
      defaultModel: projectConfigForm.defaultModel.trim() || null,
      defaultWorkMode: projectConfigForm.defaultWorkMode,
      defaultTaskPrompt: projectConfigForm.defaultTaskPrompt.trim(),
      scan: {
        ignoreDirectories: parseProjectConfigList(projectConfigForm.scanIgnoreDirectories),
        indexScope: projectConfigForm.indexScope,
      },
      language: {
        primary: projectConfigForm.languagePrimary.trim() || 'typescript',
        additional: parseProjectConfigList(projectConfigForm.languageAdditional),
      },
      dependencies: {
        packageManagers: parseProjectConfigList(projectConfigForm.packageManagers),
        manifestPaths: parseProjectConfigList(projectConfigForm.manifestPaths),
      },
      database: {
        connectionName: projectConfigForm.databaseConnectionName.trim() || null,
        schemaPaths: parseProjectConfigList(projectConfigForm.databaseSchemaPaths),
      },
      telegram: {
        alias: projectConfigForm.telegramAlias.trim() || null,
      },
      security: {
        allowShell: projectConfigForm.allowShell,
        allowGitWrite: projectConfigForm.allowGitWrite,
      },
    };
    setActionState('creating-project');
    try {
      // 项目配置只保存本机偏好，不验证或伪造外部 CLI、数据库、Telegram 的可用性。
      const savedConfig = normalizeProjectConfig(await props.onSaveProjectConfig(projectId, input), projectId);
      setProjectConfig(savedConfig);
      setProjectConfigForm(toProjectConfigForm(savedConfig));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function updateProject(projectId: string, event?: FormEvent<HTMLFormElement>): Promise<void> {
    event?.preventDefault();
    if (!props.onUpdateProject) return;
    const name = projectEditForm.name.trim();
    if (!name) return;
    setActionState('creating-project');
    try {
      const nextSnapshot = await props.onUpdateProject(projectId, {
        name,
        localPath: projectEditForm.localPath.trim() || undefined,
        description: projectEditForm.description.trim() || null,
        note: projectEditForm.note.trim() || null,
      });
      setSnapshot(nextSnapshot);
      const updatedProject = nextSnapshot.projects.find((project) => project.id === projectId);
      setProjectDetail(updatedProject);
      if (updatedProject)
        setProjectEditForm({
          name: updatedProject.name,
          localPath: updatedProject.localPath,
          description: updatedProject.description ?? '',
          note: updatedProject.note ?? '',
        });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function deleteProject(projectId: string): Promise<void> {
    if (!props.onDeleteProject) return;
    setActionState('creating-project');
    try {
      const nextSnapshot = await props.onDeleteProject(projectId);
      setSnapshot(nextSnapshot);
      setProjectDetail(nextSnapshot.projects[0]);
      setPendingProjectDeleteId(undefined);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function searchGraph(query: string, nodeType?: string, edgeType?: string, minConfidence?: number): Promise<void> {
    if (!props.onSearchGraph) return;
    setScanState('scanning');
    try {
      setGraphSearchResult(await props.onSearchGraph(query, nodeType, edgeType, minConfidence));
      setScanState('idle');
    } catch {
      setScanState('failed');
    }
  }

  async function askGraph(question: string): Promise<void> {
    if (!props.onAskGraph || !firstProjectId) return;
    const normalizedQuestion = question.trim();
    if (!normalizedQuestion) return;
    setScanState('scanning');
    try {
      // 图谱问答必须走真实后端 Runtime，不在前端编造 AI 结论。
      setGraphAnswer(await props.onAskGraph(firstProjectId, normalizedQuestion));
      if (props.onLoadGraphConversations) {
        await loadGraphConversations({
          query: undefined,
          offset: 0,
          archived: false,
        });
      }
      setScanState('idle');
    } catch {
      setScanState('failed');
    }
  }

  async function loadGraphConversations(input: { query?: string; offset?: number; archived?: boolean } = {}): Promise<void> {
    if (!props.onLoadGraphConversations || !firstProjectId) return;
    setScanState('scanning');
    try {
      const page = await props.onLoadGraphConversations(firstProjectId, {
        query: input.query,
        limit: graphConversationPage.limit,
        offset: input.offset ?? graphConversationPage.offset,
        archived: input.archived ?? graphConversationPage.archived,
      });
      setGraphConversations(page.items);
      setGraphConversationPage({
        total: page.total,
        limit: page.limit,
        offset: page.offset,
        query: page.query,
        archived: page.archived,
      });
      setSelectedGraphConversation(page.items[0]);
      setScanState('idle');
    } catch {
      setScanState('failed');
    }
  }

  async function loadGraphConversationDetail(conversationId: string): Promise<void> {
    if (!firstProjectId) return;
    if (!props.onLoadGraphConversation) {
      setSelectedGraphConversation(graphConversations.find((conversation) => conversation.id === conversationId));
      return;
    }
    setScanState('scanning');
    try {
      setSelectedGraphConversation(await props.onLoadGraphConversation(firstProjectId, conversationId));
      setScanState('idle');
    } catch {
      setScanState('failed');
    }
  }

  async function archiveGraphConversation(conversationId: string): Promise<void> {
    if (!props.onArchiveGraphConversation || !firstProjectId) return;
    setScanState('scanning');
    try {
      await props.onArchiveGraphConversation(firstProjectId, conversationId);
      await loadGraphConversations({
        query: graphConversationPage.query ?? undefined,
        offset: graphConversationPage.offset,
        archived: graphConversationPage.archived,
      });
    } catch {
      setScanState('failed');
    }
  }

  async function restoreGraphConversation(conversationId: string): Promise<void> {
    if (!props.onRestoreGraphConversation || !firstProjectId) return;
    setScanState('scanning');
    try {
      await props.onRestoreGraphConversation(firstProjectId, conversationId);
      await loadGraphConversations({
        query: graphConversationPage.query ?? undefined,
        offset: graphConversationPage.offset,
        archived: graphConversationPage.archived,
      });
    } catch {
      setScanState('failed');
    }
  }

  async function openGraphView(viewType: GraphViewType = 'architecture'): Promise<void> {
    if (!props.onLoadGraphView) return;
    setScanState('scanning');
    try {
      setGraphView(await props.onLoadGraphView(viewType));
      setScanState('idle');
    } catch {
      setScanState('failed');
    }
  }

  async function handleCodeMapAction(): Promise<void> {
    handleMainNavigate('projects');
    setProjectPanel('graph');
    if (snapshot.graph.viewCount > 0 && !graphView) {
      await openGraphView();
      return;
    }
    await scanCurrentGraph();
  }

  function codeMapActionLabel(): string {
    if (scanState === 'scanning') return '扫描中';
    if (scanState === 'failed') return '重试扫描';
    if (snapshot.graph.viewCount > 0 && !graphView) return '打开 Code Map';
    return '扫描当前仓库';
  }

  async function scanCurrentGraph(): Promise<void> {
    if (!props.onScanCurrentGraph) return;
    setScanState('scanning');
    try {
      setSnapshot(await props.onScanCurrentGraph());
      if (props.onLoadGraphView) {
        setGraphView(await props.onLoadGraphView('architecture'));
      }
      setScanState('idle');
    } catch {
      setScanState('failed');
    }
  }

  async function createCurrentProject(): Promise<void> {
    if (!props.onCreateCurrentProject) return;
    setActionState('creating-project');
    try {
      setSnapshot(
        await props.onCreateCurrentProject({
          defaultModel: createProjectConfigForm.defaultModel.trim() || appShellSettings.defaultModel || null,
          defaultWorkMode: createProjectConfigForm.defaultWorkMode,
          defaultTaskPrompt: createProjectConfigForm.defaultTaskPrompt.trim(),
        }),
      );
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function restoreProject(projectId: string): Promise<void> {
    if (!props.onRestoreProject) return;
    setActionState('creating-project');
    try {
      setSnapshot(await props.onRestoreProject(projectId));
      if (props.onLoadArchivedProjects) {
        setArchivedProjects(await props.onLoadArchivedProjects());
      } else {
        setArchivedProjects((items) => items.filter((item) => item.id !== projectId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
      setActionState('failed');
    }
  }

  async function createTaskFromGraphNode(nodeId: string): Promise<void> {
    if (!props.onCreateTaskFromGraphNode || !firstProjectId) return;
    setActionState('creating-task');
    try {
      setSnapshot(await props.onCreateTaskFromGraphNode(nodeId, firstProjectId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromGraphConversation(conversationId: string): Promise<void> {
    if (!props.onCreateTaskFromGraphConversation || !firstProjectId) return;
    setActionState('creating-task');
    try {
      setSnapshot(await props.onCreateTaskFromGraphConversation(firstProjectId, conversationId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createDefaultTask(): Promise<void> {
    if (!props.onCreateDefaultTask || !firstProjectId) return;
    setActionState('creating-task');
    try {
      const nextSnapshot = await props.onCreateDefaultTask(firstProjectId);
      setSnapshot(nextSnapshot);
      const latestTaskId = nextSnapshot.tasks.at(-1)?.id;
      if (latestTaskId && props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(latestTaskId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function updateTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    if (!props.onUpdateTaskStatus) return;
    setActionState('updating-task');
    try {
      const nextSnapshot = await props.onUpdateTaskStatus(taskId, status);
      setSnapshot(nextSnapshot);
      if (props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(taskId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function controlTaskRuntime(taskId: string, action: 'run' | 'pause' | 'continue' | 'cancel' | 'retry'): Promise<void> {
    const handlers = {
      run: props.onRunTask,
      pause: props.onPauseTask,
      continue: props.onContinueTask,
      cancel: props.onCancelTask,
      retry: props.onRetryTask,
    };
    const handler = handlers[action];
    if (!handler) return;
    setActionState('updating-task');
    try {
      // 专用任务控制 API 会写入 Runtime 会话和审计事件；前端只刷新真实快照。
      setSnapshot(await handler(taskId));
      if (props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(taskId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function restoreTask(taskId: string): Promise<void> {
    if (!props.onRestoreTask) return;
    setActionState('updating-task');
    try {
      const nextSnapshot = await props.onRestoreTask(taskId);
      setSnapshot(nextSnapshot);
      if (firstProjectId && props.onLoadArchivedTasks) {
        setArchivedTasks(await props.onLoadArchivedTasks(firstProjectId));
      } else {
        setArchivedTasks((items) => items.filter((item) => item.id !== taskId));
      }
      if (props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(taskId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createGitConfirmation(operation: HighRiskGitOperation): Promise<void> {
    if (!props.onCreateGitConfirmation) return;
    setActionState('creating-git-confirmation');
    try {
      setGitConfirmation(await props.onCreateGitConfirmation(operation, operation === 'commit' ? gitCommitMessage.trim() : undefined));
      setGitOperationStatus('尚未执行 Git 写操作');
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function confirmGitOperation(): Promise<void> {
    if (!props.onConfirmGitOperation || !gitConfirmation) return;
    setActionState('confirming-git-operation');
    try {
      setGitConfirmation(await props.onConfirmGitOperation(gitConfirmation.id));
      setGitOperationStatus('尚未执行 Git 写操作');
      setActionState('idle');
    } catch {
      setGitOperationStatus('Git 操作确认失败；请重新创建确认');
      setActionState('failed');
    }
  }

  async function rejectGitOperation(): Promise<void> {
    if (!props.onRejectGitOperation || !gitConfirmation) return;
    setActionState('confirming-git-operation');
    try {
      const rejected = await props.onRejectGitOperation(gitConfirmation.id, `用户在 Git Diff 面板拒绝${formatGitOperationLabel(gitConfirmation.operation)}确认`);
      setGitConfirmation(rejected);
      setGitOperationStatus('已拒绝 Git 确认；不会执行 Git 写操作');
      setActionState('idle');
    } catch {
      setGitOperationStatus('Git 确认拒绝失败；请查看本地审计日志');
      setActionState('failed');
    }
  }

  async function executeConfirmedGitOperation(): Promise<void> {
    if (!props.onExecuteGitOperation || !gitConfirmation || gitConfirmation.status !== 'confirmed') return;
    const executionInput = buildGitOperationExecutionInput(gitConfirmation, {
      branchName: gitConfirmation.operation === 'switch_branch' ? gitSwitchBranchName : gitBranchName,
      baseRef: gitBaseRef,
      stashRef: gitStashRef,
      remote: gitRemote,
      targetRef: gitConfirmation.operation === 'rollback' ? gitRollbackRef : gitTargetRef,
    });
    if (gitConfirmation.operation === 'commit' && !executionInput.message?.trim()) {
      setGitOperationStatus('提交需要 commit message；请重新创建带 message 的提交确认');
      return;
    }
    setActionState('executing-git-operation');
    try {
      const result = await props.onExecuteGitOperation(executionInput);
      setGitOperationStatus(`已执行 ${formatGitOperationLabel(result.operation)} · git ${result.args.join(' ')}`);
      setActionState('idle');
    } catch {
      setGitOperationStatus('Git 写操作执行失败；请查看本地审计日志');
      setActionState('failed');
    }
  }

  function setGitHunkDecision(file: { oldPath: string; newPath: string }, hunk: GitDiffHunk, decision: 'accepted' | 'rejected'): void {
    setGitHunkDecisions((current) => ({
      ...current,
      [buildGitHunkReviewKey(file, hunk)]: decision,
    }));
  }

  async function loadGitDiff(): Promise<void> {
    if (!props.onLoadGitDiff) return;
    setActionState('loading-diff');
    try {
      setGitDiff(await props.onLoadGitDiff());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function exportGitPatch(): Promise<void> {
    if (!props.onExportGitPatch) return;
    setActionState('loading-diff');
    try {
      const patch = await props.onExportGitPatch();
      const saved = props.onExportPatchFile ? await props.onExportPatchFile(patch) : { saved: false, filePath: null };
      setPatchExportStatus(saved.saved ? `已保存 .patch 文件：${saved.filePath}` : `已生成只读 Patch：${patch.fileName}`);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function loadRuntimeStatus(): Promise<void> {
    if (!props.onLoadRuntimeStatus) return;
    setActionState('loading-runtime');
    try {
      setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadSecuritySecrets) setSecuritySecrets(await props.onLoadSecuritySecrets());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      if (props.onLoadReleaseStatus) setReleaseStatus(await props.onLoadReleaseStatus());
      if (props.onLoadTelegramNotificationSettings) {
        const settings = await props.onLoadTelegramNotificationSettings();
        setTelegramNotificationSettings(settings);
        setTelegramNotificationChatIdsInput(settings.chatIds.join(', '));
      }
      if (props.onLoadTelegramSecuritySettings) {
        const settings = await props.onLoadTelegramSecuritySettings();
        setTelegramSecuritySettings(settings);
        setTelegramAllowedUserIdsInput(settings.allowedUserIds.join(', '));
      }
      if (props.onLoadRuntimeAdapters) setRuntimeAdapters(await props.onLoadRuntimeAdapters());
      if (props.onLoadRuntimeSettings) setRuntimeSettings(normalizeRuntimeSettings(await props.onLoadRuntimeSettings()));
      if (props.onLoadCodeMapSettings) {
        const settings = normalizeCodeMapSettings(await props.onLoadCodeMapSettings());
        setCodeMapSettings(settings);
      }
      if (props.onLoadProjectConfig && firstProjectId) {
        const loadedConfig = normalizeProjectConfig(await props.onLoadProjectConfig(firstProjectId), firstProjectId);
        setProjectConfig(loadedConfig);
        setProjectConfigForm(toProjectConfigForm(loadedConfig));
      }
      if (props.onLoadAppShellSettings) setAppShellSettings(await props.onLoadAppShellSettings());
      if (props.onLoadRuntimeSessions) {
        const sessions = await props.onLoadRuntimeSessions();
        setRuntimeSessions(sessions);
        if (sessions[0] && props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessions[0].id));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function checkReleaseUpdate(): Promise<void> {
    if (!props.onCheckReleaseUpdate) return;
    setReleaseUpdateCheckState('loading');
    try {
      setReleaseUpdateStatus(await props.onCheckReleaseUpdate());
      setReleaseUpdateCheckState('idle');
    } catch (error) {
      setReleaseUpdateCheckState('failed');
      recordLocalError('renderer-action', error);
    }
  }

  async function checkRuntimeAdapter(adapterId: string): Promise<void> {
    if (!props.onCheckRuntimeAdapter) return;
    setActionState('loading-runtime');
    try {
      const status = await props.onCheckRuntimeAdapter(adapterId);
      setRuntimeAdapterChecks((current) => ({
        ...current,
        [adapterId]: status,
      }));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveRuntimeSettings(): Promise<void> {
    if (!props.onSaveRuntimeSettings) return;
    setActionState('loading-runtime');
    try {
      // 只保存用户选择的默认 adapter；是否可用仍必须通过真实 CLI 检测确认。
      setRuntimeSettings(normalizeRuntimeSettings(await props.onSaveRuntimeSettings(runtimeSettings)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveAppShellSettings(): Promise<void> {
    if (!props.onSaveAppShellSettings) return;
    setActionState('loading-runtime');
    try {
      // 通用设置只保存本机偏好，不写入任何业务假数据或密钥明文。
      const savedSettings = await props.onSaveAppShellSettings({
        appLanguage: appShellSettings.appLanguage,
        appearance: appShellSettings.appearance,
        webviewDebugEnabled: appShellSettings.webviewDebugEnabled,
        developerModeEnabled: appShellSettings.developerModeEnabled,
        multiWindowEnabled: appShellSettings.multiWindowEnabled,
        backgroundModeEnabled: appShellSettings.backgroundModeEnabled,
        desktopNotificationsEnabled: appShellSettings.desktopNotificationsEnabled,
        openAtLoginEnabled: appShellSettings.openAtLoginEnabled,
        autoUpdateChannel: appShellSettings.autoUpdateChannel,
        defaultProjectId: appShellSettings.defaultProjectId,
        defaultModel: appShellSettings.defaultModel,
        defaultTaskTemplateId: appShellSettings.defaultTaskTemplateId,
      });
      setAppShellSettings(savedSettings);
      await notifyMainAppShellSettingsChanged({
        zeus: window.zeus,
        settings: {
          webviewDebugEnabled: savedSettings.webviewDebugEnabled,
          multiWindowEnabled: savedSettings.multiWindowEnabled,
          backgroundModeEnabled: savedSettings.backgroundModeEnabled,
          desktopNotificationsEnabled: savedSettings.desktopNotificationsEnabled,
          openAtLoginEnabled: savedSettings.openAtLoginEnabled,
        },
      });
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function clearLocalCaches(): Promise<void> {
    if (!props.onClearLocalCaches) return;
    setActionState('loading-runtime');
    try {
      const cleared = await props.onClearLocalCaches();
      setAppShellSettings((current) => ({
        ...current,
        lastCacheClearAt: cleared.clearedAt,
      }));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function exportLocalSettings(): Promise<void> {
    if (!props.onExportLocalSettings) return;
    setActionState('loading-runtime');
    try {
      const exported = await props.onExportLocalSettings();
      const saved = props.onExportSettingsFile ? await props.onExportSettingsFile(exported) : { saved: false, filePath: null };
      setDataPortabilityStatus(saved.saved ? `最近导出：${saved.filePath}，密钥已脱敏` : `最近导出：${exported.exportedAt}，密钥已脱敏`);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function importLocalSettings(): Promise<void> {
    if (!props.onImportLocalSettings) return;
    setActionState('loading-runtime');
    try {
      const selected = props.onImportSettingsFile ? await props.onImportSettingsFile() : { imported: false, filePath: null };
      const result = await props.onImportLocalSettings(
        selected.snapshot
          ? {
              schemaVersion: 1,
              settings: {
                appShell: toSafeAppShellImport(selected.snapshot.settings.appShell),
                runtime: selected.snapshot.settings.runtime,
                codeMap: selected.snapshot.settings.codeMap,
                telegramNotification: selected.snapshot.settings.telegramNotification,
                telegramSecurity: selected.snapshot.settings.telegramSecurity,
              },
            }
          : {
              schemaVersion: 1,
              settings: {
                appShell: {
                  appLanguage: appShellSettings.appLanguage,
                  appearance: appShellSettings.appearance,
                  webviewDebugEnabled: appShellSettings.webviewDebugEnabled,
                  developerModeEnabled: appShellSettings.developerModeEnabled,
                  multiWindowEnabled: appShellSettings.multiWindowEnabled,
                  backgroundModeEnabled: appShellSettings.backgroundModeEnabled,
                  desktopNotificationsEnabled: appShellSettings.desktopNotificationsEnabled,
                  openAtLoginEnabled: appShellSettings.openAtLoginEnabled,
                  autoUpdateChannel: appShellSettings.autoUpdateChannel,
                  defaultProjectId: appShellSettings.defaultProjectId,
                  defaultModel: appShellSettings.defaultModel,
                  defaultTaskTemplateId: appShellSettings.defaultTaskTemplateId,
                },
                runtime: runtimeSettings,
                codeMap: codeMapSettings,
                telegramNotification: telegramNotificationSettings,
                telegramSecurity: telegramSecuritySettings,
              },
            },
      );
      if (props.onLoadAppShellSettings) setAppShellSettings(await props.onLoadAppShellSettings());
      if (props.onLoadRuntimeSettings) setRuntimeSettings(normalizeRuntimeSettings(await props.onLoadRuntimeSettings()));
      if (props.onLoadCodeMapSettings) {
        const settings = normalizeCodeMapSettings(await props.onLoadCodeMapSettings());
        setCodeMapSettings(settings);
      }
      if (props.onLoadTelegramNotificationSettings) {
        const settings = await props.onLoadTelegramNotificationSettings();
        setTelegramNotificationSettings(settings);
        setTelegramNotificationChatIdsInput(settings.chatIds.join(', '));
      }
      if (props.onLoadTelegramSecuritySettings) {
        const settings = await props.onLoadTelegramSecuritySettings();
        setTelegramSecuritySettings(settings);
        setTelegramAllowedUserIdsInput(settings.allowedUserIds.join(', '));
      }
      setDataPortabilityStatus(
        selected.imported && selected.filePath ? `最近导入：${selected.filePath}，${result.importedSettings.join(', ') || '无设置变更'}` : `最近导入：${result.importedAt}，${result.importedSettings.join(', ') || '无设置变更'}`,
      );
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function startRuntimeSession(): Promise<void> {
    if (!props.onStartRuntimeSession || !firstProjectId || !firstProject) return;
    setActionState('loading-runtime');
    try {
      const session = await props.onStartRuntimeSession({
        projectId: firstProjectId,
        command: runtime.aiCli.command,
        args: ['--version'],
        cwd: firstProject.localPath,
      });
      setRuntimeSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]);
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(session.id));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createGenericRuntimeConfirmation(): Promise<void> {
    const shellCommand = runtimeGenericShellCommand.trim();
    if (!props.onCreateRuntimeConfirmation || !firstProjectId || !firstProject || !shellCommand) return;
    setActionState('loading-runtime');
    try {
      const confirmation = await props.onCreateRuntimeConfirmation({
        action: 'start_generic_session',
        reason: `用户在 Zeus 桌面端明确确认启动 Generic shell Runtime：${shellCommand}`,
        session: {
          projectId: firstProjectId,
          command: 'sh',
          args: ['-lc', shellCommand],
          cwd: firstProject.localPath,
        },
      });
      setRuntimeConfirmation(confirmation);
      setRuntimeConfirmationCommand(shellCommand);
      setRuntimeConfirmationStatus(`已创建确认 ${confirmation.id}，确认只绑定本次 sh -lc。`);
      setActionState('idle');
    } catch {
      setRuntimeConfirmationStatus('Generic shell 确认创建失败');
      setActionState('failed');
    }
  }

  async function rejectGenericRuntimeConfirmation(): Promise<void> {
    if (!props.onRejectRuntimeOperation || !runtimeConfirmation) return;
    setActionState('loading-runtime');
    try {
      // 拒绝操作只关闭当前一次性令牌，不启动任何 Runtime 子进程。
      const rejected = await props.onRejectRuntimeOperation(runtimeConfirmation.id, '用户在 Runtime 设置中拒绝 Generic shell 确认');
      setRuntimeConfirmation(rejected);
      setRuntimeConfirmationStatus('已拒绝 Generic shell 确认；不会启动 Runtime 会话');
      setActionState('idle');
    } catch {
      setRuntimeConfirmationStatus('Generic shell 确认拒绝失败');
      setActionState('failed');
    }
  }

  async function confirmAndStartGenericRuntime(): Promise<void> {
    if (!props.onConfirmRuntimeOperation || !props.onStartRuntimeSession || !runtimeConfirmation || !firstProjectId || !firstProject) return;
    if (!genericShellCriticalConfirmed) {
      setRuntimeConfirmationStatus(`高危命令必须先手动输入 ${GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE}`);
      return;
    }
    const shellCommand = runtimeGenericShellCommand.trim();
    if (runtimeConfirmationCommand !== shellCommand) {
      setRuntimeConfirmation(undefined);
      setRuntimeConfirmationCommand('');
      setRuntimeConfirmationStatus('命令已变更，请重新创建 Generic shell 确认');
      return;
    }
    setActionState('loading-runtime');
    try {
      const confirmed = await props.onConfirmRuntimeOperation(runtimeConfirmation.id);
      const session = await props.onStartRuntimeSession({
        projectId: firstProjectId,
        command: 'sh',
        args: ['-lc', shellCommand],
        cwd: firstProject.localPath,
        confirmationId: confirmed.id,
      });
      setRuntimeConfirmation({
        ...confirmed,
        status: 'consumed',
        consumedAt: new Date().toISOString(),
      });
      setRuntimeConfirmationStatus(`已消费确认 ${confirmed.id} 并启动 Generic shell 会话。`);
      setRuntimeSessions((items) => [session, ...items.filter((item) => item.id !== session.id)]);
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(session.id));
      setActionState('idle');
    } catch {
      setRuntimeConfirmationStatus('Generic shell 确认或启动失败');
      setActionState('failed');
    }
  }

  async function sendRuntimeInput(sessionId: string): Promise<void> {
    const input = runtimeInput.trim();
    if (!props.onSendRuntimeInput || !input) return;
    setActionState('loading-runtime');
    try {
      await props.onSendRuntimeInput(sessionId, input);
      setRuntimeInput('');
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function interruptRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onInterruptRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const updated = await props.onInterruptRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function resizeRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onResizeRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      await props.onResizeRuntimeSession(sessionId, { cols: 120, rows: 32 });
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function loadRuntimeTerminalSnapshot(sessionId: string): Promise<void> {
    if (!props.onLoadRuntimeTerminalSnapshot) return;
    setActionState('loading-runtime');
    try {
      const snapshot = await props.onLoadRuntimeTerminalSnapshot(sessionId);
      setRuntimeLogs(snapshot.logs);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function stopRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onStopRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const stopped = await props.onStopRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === stopped.id ? stopped : item)));
      if (props.onLoadRuntimeSessionLogs) setRuntimeLogs(await props.onLoadRuntimeSessionLogs(sessionId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function refreshRuntimeSessions(): Promise<void> {
    if (!props.onLoadRuntimeSessions) return;
    setActionState('loading-runtime');
    try {
      setRuntimeSessions(
        await props.onLoadRuntimeSessions({
          query: runtimeSearchQuery.trim() || undefined,
          favoriteOnly: runtimeFavoriteOnly,
          archived: runtimeShowArchived,
        }),
      );
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function generateRuntimeSessionSummary(sessionId: string): Promise<void> {
    if (!props.onGenerateRuntimeSessionSummary) return;
    setActionState('loading-runtime');
    try {
      const updated = await props.onGenerateRuntimeSessionSummary(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function setRuntimeSessionFavorite(session: AiRuntimeSession): Promise<void> {
    if (!props.onSetRuntimeSessionFavorite) return;
    setActionState('loading-runtime');
    try {
      const updated = await props.onSetRuntimeSessionFavorite(session.id, !session.favorite);
      setRuntimeSessions((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function archiveRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onArchiveRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const archived = await props.onArchiveRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.filter((item) => item.id !== archived.id));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function restoreRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onRestoreRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const restored = await props.onRestoreRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.map((item) => (item.id === restored.id ? restored : item)));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromRuntimeSession(session: AiRuntimeSession): Promise<void> {
    if (!props.onCreateTaskFromRuntimeSession) return;
    setActionState('creating-task');
    try {
      const nextSnapshot = await props.onCreateTaskFromRuntimeSession(session.id, {
        title: `继续会话：${session.command}`,
        instruction: '基于真实 Runtime 会话日志继续分析后续处理事项。',
      });
      setSnapshot(nextSnapshot);
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function deleteRuntimeSession(sessionId: string): Promise<void> {
    if (!props.onDeleteRuntimeSession) return;
    setActionState('loading-runtime');
    try {
      const deleted = await props.onDeleteRuntimeSession(sessionId);
      setRuntimeSessions((items) => items.filter((item) => item.id !== deleted.id));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function exportRuntimeLogs(sessionId: string): Promise<void> {
    const logs = runtimeLogs.filter((entry) => entry.sessionId === sessionId);
    let sourceFilePath: string | undefined;
    if (props.onLoadRuntimeTerminalEvents) {
      const terminalEvents = await props.onLoadRuntimeTerminalEvents(sessionId, { limit: 1, offset: 0 });
      sourceFilePath = resolveRuntimeNormalizedLogPath(terminalEvents.items);
    }
    if (!window.zeus?.exportRuntimeLogsToFile || (logs.length === 0 && !sourceFilePath)) {
      setRuntimeLogExportStatus('没有可导出的真实 Runtime 日志');
      return;
    }
    setActionState('loading-runtime');
    try {
      const exported = await window.zeus.exportRuntimeLogsToFile({
        fileName: `zeus-runtime-${sessionId}.log`,
        mimeType: 'text/plain',
        sessionId,
        sourceFilePath,
        logs: logs.map((entry) => ({
          createdAt: entry.createdAt,
          stream: entry.stream,
          text: entry.text,
        })),
      });
      setRuntimeLogExportStatus(exported.saved ? `最近导出 Runtime 日志：${exported.filePath}` : '已取消 Runtime 日志导出');
      setActionState('idle');
    } catch {
      setRuntimeLogExportStatus('Runtime 日志导出失败');
      setActionState('failed');
    }
  }

  async function copyRuntimeLogs(): Promise<void> {
    const content = runtimeLogs.map(formatRuntimeLogLine).join('\n');
    if (!content) {
      setRuntimeLogCopyStatus('没有可复制的真实 Runtime 日志');
      return;
    }
    try {
      await navigator.clipboard?.writeText(content);
      setRuntimeLogCopyStatus('已复制当前日志');
    } catch {
      // 非浏览器或权限不足时不伪造复制成功，仅保留可见状态。
      setRuntimeLogCopyStatus('复制当前日志失败');
    }
  }

  async function saveTelegramBotToken(): Promise<void> {
    const token = telegramTokenInput.trim();
    if (!props.onSaveTelegramBotToken || !token) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onSaveTelegramBotToken(token));
      setTelegramTokenInput('');
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function clearTelegramBotToken(): Promise<void> {
    if (!props.onClearTelegramBotToken) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onClearTelegramBotToken());
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveExternalApiKey(): Promise<void> {
    const key = externalApiKeyInput.trim();
    if (!props.onSaveExternalApiKey || !key) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onSaveExternalApiKey(key));
      setExternalApiKeyInput('');
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function clearExternalApiKey(): Promise<void> {
    if (!props.onClearExternalApiKey) return;
    setActionState('loading-runtime');
    try {
      setSecuritySecrets(await props.onClearExternalApiKey());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function resetSecurity(): Promise<void> {
    if (!props.onResetSecurity) return;
    setActionState('loading-runtime');
    try {
      const reset = await props.onResetSecurity();
      setSecuritySecrets(reset.secrets);
      setTelegramNotificationSettings(reset.telegramNotificationSettings);
      setTelegramNotificationChatIdsInput(reset.telegramNotificationSettings.chatIds.join(', '));
      setTelegramSecuritySettings(reset.telegramSecuritySettings);
      setTelegramAllowedUserIdsInput(reset.telegramSecuritySettings.allowedUserIds.join(', '));
      if (props.onLoadRuntimeStatus) setRuntimeStatus(await props.onLoadRuntimeStatus());
      if (props.onLoadTelegramPollingStatus) setTelegramPollingStatus(await props.onLoadTelegramPollingStatus());
      if (props.onLoadSecurityAuditLogs) setSecurityAuditLogs(await props.onLoadSecurityAuditLogs());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function saveTelegramNotificationSettings(): Promise<void> {
    if (!props.onSaveTelegramNotificationSettings) return;
    setActionState('loading-runtime');
    try {
      const settings = await props.onSaveTelegramNotificationSettings({
        enabled: telegramNotificationSettings.enabled,
        chatIds: parseNumericList(telegramNotificationChatIdsInput),
        silentMode: telegramNotificationSettings.silentMode,
      });
      setTelegramNotificationSettings(settings);
      setTelegramNotificationChatIdsInput(settings.chatIds.join(', '));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function testTelegramConnection(): Promise<void> {
    if (!props.onTestTelegramConnection) return;
    setActionState('loading-runtime');
    try {
      // 主动测试只回显 Chat ID、尝试次数和时间，不把 Bot Token 或消息明文写入界面状态。
      const result = await props.onTestTelegramConnection();
      setTelegramTestStatus(`测试连接已发送：${result.chatIds.join(', ')} · 尝试 ${result.attempts} 次 · ${result.sentAt}`);
      setActionState('idle');
    } catch {
      setTelegramTestStatus('测试连接失败，请检查 Bot Token 和通知 Chat ID。');
      setActionState('failed');
    }
  }

  async function saveTelegramSecuritySettings(): Promise<void> {
    if (!props.onSaveTelegramSecuritySettings) return;
    setActionState('loading-runtime');
    try {
      const settings = await props.onSaveTelegramSecuritySettings({
        allowedUserIds: parseNumericList(telegramAllowedUserIdsInput),
      });
      setTelegramSecuritySettings(settings);
      setTelegramAllowedUserIdsInput(settings.allowedUserIds.join(', '));
      setRuntimeStatus(await props.onLoadRuntimeStatus?.());
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function loadTaskTemplates(): Promise<void> {
    if (!props.onLoadTaskTemplates) return;
    setActionState('loading-templates');
    try {
      setTaskTemplates(await props.onLoadTaskTemplates(firstProjectId));
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  async function createTaskFromTemplate(templateId: string): Promise<void> {
    if (!props.onCreateTaskFromTemplate || !firstProjectId) return;
    setActionState('creating-task');
    try {
      const nextSnapshot = await props.onCreateTaskFromTemplate(templateId, firstProjectId);
      setSnapshot(nextSnapshot);
      const latestTaskId = nextSnapshot.tasks.at(-1)?.id;
      if (latestTaskId && props.onLoadTaskEvents) {
        setTaskEvents(await props.onLoadTaskEvents(latestTaskId));
      }
      setActionState('idle');
    } catch (error) {
      recordLocalError('renderer-action', error);
    }
  }

  function handleMainNavigate(target: WorkspaceViewId): void {
    setActiveNavTarget(target);
    if (typeof window !== 'undefined') {
      // 只更新地址栏语义，不触发浏览器原生锚点滚动，避免左栏和主工作区一起跳到底部。
      window.history.replaceState(null, '', `#${target}`);
    }
    workspaceScrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function repositoryPickerLabel(): string {
    if (actionState === 'creating-project') return '创建中';
    if (localClientStatus === 'failed') return '本地服务连接失败';
    if (!localClientReady) return '连接本地服务中';
    return '选择真实本地代码库';
  }

  function handleWindowDragPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    const bridge = window.zeus;
    if (event.button !== 0 || !bridge?.beginWindowDrag || !bridge.moveWindowDrag || !bridge.endWindowDrag) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    try {
      target.setPointerCapture(event.pointerId);
    } catch {
      // 某些系统级拖拽事件不会允许 capture；后续仍通过 window 级监听完成拖拽。
    }
    void bridge.beginWindowDrag({
      screenX: event.screenX,
      screenY: event.screenY,
    });

    const handlePointerMove = (moveEvent: PointerEvent) => {
      void bridge.moveWindowDrag({
        screenX: moveEvent.screenX,
        screenY: moveEvent.screenY,
      });
    };
    const finishWindowDrag = () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishWindowDrag);
      window.removeEventListener('pointercancel', finishWindowDrag);
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // release 失败不影响 Main 进程清理拖拽状态。
      }
      void bridge.endWindowDrag();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', finishWindowDrag, { once: true });
    window.addEventListener('pointercancel', finishWindowDrag, { once: true });
  }

  return (
    <main
      className={`zeus-shell ai-native-shell macos-ai-app codex-thread-workbench spatial-graph-studio theme-${appShellSettings.appearance}`}
      data-theme={appShellSettings.appearance}
      aria-label="Zeus macOS AI 原生研发工作台 · Motion respects reduced motion"
    >
      <div className="window-drag-strip" aria-hidden="true" onPointerDown={handleWindowDragPointerDown} />
      <SidebarNav activeNavTarget={activeNavTarget} onNavigate={handleMainNavigate} />

      <section className="workspace ai-workspace" ref={workspaceScrollRef}>
        {localClientStatus !== 'ready' ? <LocalClientNotice status={localClientStatus} error={props.localClientError} /> : null}
        {localError ? (
          <section className="inline-status failed" aria-label="本地操作失败">
            <strong>{localError.message}</strong>
          </section>
        ) : null}

        {activeNavTarget === 'projects' ? (
          <section className="workspace-view workspace-view-projects" aria-label="项目">
            <aside className="workspace-list-pane project-list-pane" aria-label="项目列表">
              <div className="pane-toolbar" aria-label="项目搜索与创建">
                <label className="compact-field">
                  搜索项目
                  <input aria-label="搜索项目" value={projectSearchQuery} onChange={(event) => setProjectSearchQuery(event.currentTarget.value)} />
                </label>
                <button type="button" onClick={searchProjects} disabled={!props.onLoadProjects || actionState === 'creating-project'}>
                  搜索
                </button>
                <button type="button" onClick={createCurrentProject} disabled={!localClientReady || !props.onCreateCurrentProject || actionState === 'creating-project'}>
                  {repositoryPickerLabel()}
                </button>
              </div>
              <div className="object-list native-list-card" aria-label="项目列表内容">
                {visibleProjects.length === 0 ? (
                  <EmptyPrompt
                    title="选择真实本地代码库"
                    body=""
                    actions={[
                      {
                        label: repositoryPickerLabel(),
                        onAction: createCurrentProject,
                        disabled: !localClientReady || !props.onCreateCurrentProject || actionState === 'creating-project',
                      },
                    ]}
                  />
                ) : (
                  visibleProjects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className={`object-row native-list-row ${project.id === selectedProject?.id ? 'selected' : ''}`}
                      onClick={() => {
                        setProjectPanel(undefined);
                        void loadProjectDetail(project.id);
                      }}
                    >
                      <span className="native-folder-icon" aria-hidden="true" />
                      <span className="native-list-main">
                        <strong>{project.name}</strong>
                        <span className="native-list-subtitle">{project.localPath}</span>
                      </span>
                      <span className="native-list-trailing">{project.scanStatus}</span>
                    </button>
                  ))
                )}
              </div>
            </aside>

            <section className="workspace-detail-pane project-detail-pane" aria-label="当前项目状态">
              {selectedProject ? (
                <>
                  <section className="object-summary" aria-label="当前项目状态">
                    <strong>{selectedProject.name}</strong>
                    <dl className="status-list">
                      <div>
                        <dt>本地路径</dt>
                        <dd>{selectedProject.localPath}</dd>
                      </div>
                      <div>
                        <dt>扫描</dt>
                        <dd>{selectedProject.scanStatus}</dd>
                      </div>
                      <div>
                        <dt>Git</dt>
                        <dd>
                          {gitLabel}
                          {changedFiles.length > 0 ? ` · ${changedFiles.length} 个变更` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt>图谱</dt>
                        <dd>
                          {snapshot.graph.nodeCount} nodes / {snapshot.graph.edgeCount} edges
                        </dd>
                      </div>
                    </dl>
                  </section>

                  <section className="primary-action-row" aria-label="下一步操作">
                    <button
                      type="button"
                      onClick={() => {
                        setProjectPanel('graph');
                        void scanCurrentGraph();
                      }}
                      disabled={!props.onScanCurrentGraph || scanState === 'scanning'}
                    >
                      扫描项目
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProjectPanel('graph');
                        void handleCodeMapAction();
                      }}
                      disabled={!props.onLoadGraphView && !props.onScanCurrentGraph}
                    >
                      打开图谱
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProjectPanel('diff');
                        void loadGitDiff();
                      }}
                      disabled={!props.onLoadGitDiff || actionState === 'loading-diff'}
                    >
                      查看变更
                    </button>
                  </section>

                  <section className="secondary-action-row" aria-label="更多项目操作">
                    <button type="button" onClick={() => setProjectPanel(projectPanel === 'edit' ? undefined : 'edit')}>
                      编辑
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setProjectPanel(projectPanel === 'config' ? undefined : 'config');
                        if (selectedProject.id) void loadProjectConfig(selectedProject.id);
                      }}
                    >
                      配置
                    </button>
                    <button type="button" onClick={() => setProjectPanel(projectPanel === 'archive' ? undefined : 'archive')}>
                      更多项目操作
                    </button>
                  </section>

                  {projectPanel ? (
                    <WorkspaceDrawer label="项目二级面板" className="project-drawer" onClose={() => setProjectPanel(undefined)}>
                      {projectPanel === 'graph' ? (
                        <section className="drawer-section" aria-label="代码图谱">
                          {graphView ? (
                            <CodeMapView
                              isActive={projectPanel === 'graph'}
                              graphView={graphView}
                              searchResult={graphSearchResult}
                              graphAnswer={graphAnswer}
                              graphConversations={graphConversations}
                              graphConversationPage={graphConversationPage}
                              selectedGraphConversation={selectedGraphConversation}
                              graphConversationSearch={graphConversationSearch}
                              onGraphConversationSearchChange={setGraphConversationSearch}
                              onLoadGraphConversations={loadGraphConversations}
                              onLoadGraphConversation={loadGraphConversationDetail}
                              onArchiveGraphConversation={archiveGraphConversation}
                              onRestoreGraphConversation={restoreGraphConversation}
                              onCreateTaskFromGraphConversation={createTaskFromGraphConversation}
                              onLoadView={openGraphView}
                              onSearchGraph={searchGraph}
                              onAskGraph={askGraph}
                              onCreateTaskFromNode={createTaskFromGraphNode}
                              onOpenGraphSource={props.onOpenGraphSource}
                              onExportMermaidDiagramFile={props.onExportMermaidDiagramFile}
                              codeMapSettings={codeMapSettings}
                            />
                          ) : (
                            <div className="drawer-empty">
                              <strong>代码图谱</strong>
                              <span>{snapshot.graph.nodeCount > 0 ? `${snapshot.graph.nodeCount} nodes / ${snapshot.graph.edgeCount} edges / ${snapshot.graph.viewCount} views` : '等待真实扫描'}</span>
                              <button type="button" onClick={handleCodeMapAction} disabled={!props.onScanCurrentGraph || scanState === 'scanning'}>
                                {codeMapActionLabel()}
                              </button>
                            </div>
                          )}
                        </section>
                      ) : null}

                      {projectPanel === 'diff' ? (
                        <section className="drawer-section" aria-label="代码变更">
                          <div className="drawer-header-row">
                            <strong>代码变更</strong>
                            <button type="button" onClick={exportGitPatch} disabled={actionState === 'loading-diff'}>
                              导出 Patch
                            </button>
                          </div>
                          <section className="evidence-row" aria-label="Git 工作区状态">
                            <strong>Git 工作区状态</strong>
                            <span>{snapshot.git.clean === true ? '干净' : `有 ${changedFiles.length} 个变更`}</span>
                            <em>
                              冲突 {snapshot.git.conflictFiles?.length ?? 0} · 远程分支 {snapshot.git.remoteBranches?.length ?? 0}
                              {snapshot.git.recentCommits?.[0] ? ` · 最近提交 ${snapshot.git.recentCommits[0].shortHash}` : ''}
                            </em>
                          </section>
                          {changedFiles.length === 0 ? <span>当前仓库暂无已读取变更。</span> : changedFiles.slice(0, 12).map((file) => <code key={file}>{file}</code>)}
                          {gitDiff?.fileDiffs.slice(0, 4).map((file) => (
                            <section className="git-review-panel" key={`${file.oldPath}-${file.newPath}`} aria-label={`${file.newPath} 变更审查`}>
                              <strong>文件级 Diff：{file.newPath}</strong>
                              <span>
                                +{file.addedLines} / -{file.deletedLines}
                              </span>
                              {file.hunks.slice(0, 2).map((hunk) => (
                                <div className="git-hunk-decision" key={hunk.header}>
                                  <span>{hunk.header}</span>
                                  {hunk.lines.slice(0, 4).map((line, index) => (
                                    <code key={`${hunk.header}-${index}`}>{line.content}</code>
                                  ))}
                                  <button type="button" onClick={() => setGitHunkDecision(file, hunk, 'accepted')}>
                                    接受 hunk
                                  </button>
                                  <button type="button" onClick={() => setGitHunkDecision(file, hunk, 'rejected')}>
                                    拒绝 hunk
                                  </button>
                                  <small>{gitHunkDecisions[buildGitHunkReviewKey(file, hunk)] ?? '未决策'}</small>
                                </div>
                              ))}
                            </section>
                          ))}
                          {gitDiff ? <small>{buildGitDiffDecisionSummary(gitDiff, gitHunkDecisions)}</small> : null}
                          <section className="edit-form" aria-label="Git 高风险参数">
                            <strong>Git 高风险参数</strong>
                            <label>
                              新分支名称
                              <input aria-label="新分支名称" value={gitBranchName} onChange={(event) => setGitBranchName(event.currentTarget.value)} />
                            </label>
                            <label>
                              切换已有分支
                              <input aria-label="切换已有分支" value={gitSwitchBranchName} onChange={(event) => setGitSwitchBranchName(event.currentTarget.value)} />
                            </label>
                            <label>
                              对比基准
                              <input aria-label="Git 对比基准" value={gitBaseRef} onChange={(event) => setGitBaseRef(event.currentTarget.value)} />
                            </label>
                            <label>
                              Stash 引用
                              <input aria-label="Stash 引用" value={gitStashRef} onChange={(event) => setGitStashRef(event.currentTarget.value)} />
                            </label>
                            <label>
                              远端名称
                              <input aria-label="远端名称" value={gitRemote} onChange={(event) => setGitRemote(event.currentTarget.value)} />
                            </label>
                            <label>
                              目标引用
                              <input aria-label="目标引用" value={gitTargetRef} onChange={(event) => setGitTargetRef(event.currentTarget.value)} />
                            </label>
                            <label>
                              回滚目标
                              <input aria-label="回滚目标" value={gitRollbackRef} onChange={(event) => setGitRollbackRef(event.currentTarget.value)} />
                            </label>
                          </section>
                          <section className="danger-zone" aria-label="Git 高风险确认">
                            <label>
                              提交说明
                              <input aria-label="Commit message" value={gitCommitMessage} onChange={(event) => setGitCommitMessage(event.currentTarget.value)} />
                            </label>
                            <small>用于已确认 Git commit；为空时不会执行提交</small>
                            <div className="task-controls">
                              <button type="button" onClick={() => createGitConfirmation('stash')} disabled={actionState === 'creating-git-confirmation'}>
                                请求暂存确认
                              </button>
                              <button type="button" onClick={() => createGitConfirmation('commit')} disabled={actionState === 'creating-git-confirmation' || !gitCommitMessage.trim()}>
                                请求提交确认
                              </button>
                            </div>
                            {gitConfirmation ? (
                              <small>
                                {gitConfirmation.confirmationText} · {gitConfirmation.status}
                              </small>
                            ) : (
                              <small>{patchExportStatus}</small>
                            )}
                            {gitConfirmation?.expiresAt ? (
                              <small>
                                确认有效期：
                                {formatGitConfirmationExpiry(gitConfirmation.expiresAt)}
                              </small>
                            ) : null}
                            {gitConfirmation?.status === 'pending' ? (
                              <div className="task-controls">
                                <button type="button" onClick={confirmGitOperation} disabled={!props.onConfirmGitOperation || actionState === 'confirming-git-operation'}>
                                  确认 Git 操作
                                </button>
                                <button type="button" onClick={rejectGitOperation} disabled={!props.onRejectGitOperation || actionState === 'confirming-git-operation'}>
                                  拒绝 Git 确认
                                </button>
                              </div>
                            ) : null}
                            {gitConfirmation?.status === 'pending' ? <small>拒绝后不会执行任何 Git 写操作</small> : null}
                            {gitConfirmation?.status === 'rejected' ? (
                              <div className="evidence-row">
                                <strong>已拒绝 Git 确认</strong>
                                <span>不会执行 Git 写操作</span>
                                <em>{gitConfirmation.rejectedReason ?? '用户已拒绝本次 Git 确认'}</em>
                              </div>
                            ) : null}
                            {gitConfirmation?.status === 'confirmed' ? <small>只执行白名单 Git 命令</small> : null}
                            {gitConfirmation?.status === 'confirmed' ? (
                              <button type="button" onClick={executeConfirmedGitOperation} disabled={!props.onExecuteGitOperation || actionState === 'executing-git-operation'}>
                                执行已确认
                                {formatGitOperationLabel(gitConfirmation.operation)}
                              </button>
                            ) : null}
                            <small>{gitOperationStatus}</small>
                          </section>
                        </section>
                      ) : null}

                      {projectPanel === 'edit' ? (
                        <form className="drawer-section edit-form" aria-label="项目编辑表单" onSubmit={(event) => updateProject(selectedProject.id, event)}>
                          <label>
                            项目名称
                            <input
                              aria-label="项目名称"
                              value={projectEditForm.name}
                              onChange={(event) =>
                                setProjectEditForm((current) => ({
                                  ...current,
                                  name: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            项目路径
                            <input
                              aria-label="项目路径"
                              value={projectEditForm.localPath}
                              onChange={(event) =>
                                setProjectEditForm((current) => ({
                                  ...current,
                                  localPath: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            项目描述
                            <textarea
                              aria-label="项目描述"
                              value={projectEditForm.description}
                              onChange={(event) =>
                                setProjectEditForm((current) => ({
                                  ...current,
                                  description: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <button type="submit" disabled={!projectEditForm.name.trim() || actionState === 'creating-project'}>
                            保存项目变更
                          </button>
                          <button type="button" className="danger-action" onClick={() => setPendingProjectDeleteId(selectedProject.id)}>
                            删除项目
                          </button>
                          {pendingProjectDeleteId === selectedProject.id ? (
                            <button type="button" className="danger-action" onClick={() => deleteProject(selectedProject.id)}>
                              确认删除项目
                            </button>
                          ) : null}
                        </form>
                      ) : null}

                      {projectPanel === 'config' ? (
                        <form className="drawer-section edit-form" aria-label="项目配置" onSubmit={(event) => saveProjectConfig(selectedProject.id, event)}>
                          <label>
                            默认 AI 模型
                            <input
                              aria-label="默认 AI 模型"
                              value={projectConfigForm.defaultModel}
                              onChange={(event) =>
                                setProjectConfigForm((current) => ({
                                  ...current,
                                  defaultModel: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            默认工作模式
                            <select
                              aria-label="默认工作模式"
                              value={projectConfigForm.defaultWorkMode}
                              onChange={(event) =>
                                setProjectConfigForm((current) => ({
                                  ...current,
                                  defaultWorkMode: event.currentTarget.value as ProjectConfig['defaultWorkMode'],
                                }))
                              }
                            >
                              <option value="plan">plan</option>
                              <option value="develop">develop</option>
                              <option value="review">review</option>
                              <option value="debug">debug</option>
                            </select>
                          </label>
                          <label>
                            扫描忽略规则
                            <input
                              aria-label="扫描忽略规则"
                              value={projectConfigForm.scanIgnoreDirectories}
                              onChange={(event) =>
                                setProjectConfigForm((current) => ({
                                  ...current,
                                  scanIgnoreDirectories: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <label>
                            主语言
                            <input
                              aria-label="主语言"
                              value={projectConfigForm.languagePrimary}
                              onChange={(event) =>
                                setProjectConfigForm((current) => ({
                                  ...current,
                                  languagePrimary: event.currentTarget.value,
                                }))
                              }
                            />
                          </label>
                          <span>{projectConfig ? `当前配置：${projectConfig.defaultWorkMode}` : '当前配置待读取'}</span>
                          <span>
                            {formatProjectLanguage(projectConfigForm)} · {formatProjectDependencies(projectConfigForm)}
                          </span>
                          <span>数据库连接配置</span>
                          <span>{formatProjectDatabase(projectConfigForm)}</span>
                          {projectDatabaseSecret ? <span>密码状态：{projectDatabaseSecret.password.label}</span> : null}
                          <small>{formatProjectDatabaseHelp(projectConfigForm)}</small>
                          <span>
                            安全策略：允许 Shell：
                            {projectConfigForm.allowShell ? '是' : '否'} · 允许 Git 写操作：
                            {projectConfigForm.allowGitWrite ? '是' : '否'}
                          </span>
                          <button type="submit" disabled={!props.onSaveProjectConfig || actionState === 'creating-project'}>
                            保存项目配置
                          </button>
                        </form>
                      ) : null}

                      {projectPanel === 'archive' ? (
                        <section className="drawer-section" aria-label="归档项目">
                          <div className="drawer-header-row">
                            <strong>归档项目</strong>
                            <button type="button" onClick={async () => (props.onLoadArchivedProjects ? setArchivedProjects(await props.onLoadArchivedProjects()) : undefined)} disabled={!props.onLoadArchivedProjects}>
                              刷新
                            </button>
                          </div>
                          {archivedProjects.length === 0 ? (
                            <span>暂无归档项目。</span>
                          ) : (
                            archivedProjects.map((project) => (
                              <div className="object-row readonly" key={project.id}>
                                <strong>{project.name}</strong>
                                <small>{project.localPath}</small>
                                <button type="button" onClick={() => restoreProject(project.id)}>
                                  恢复项目
                                </button>
                              </div>
                            ))
                          )}
                        </section>
                      ) : null}
                    </WorkspaceDrawer>
                  ) : null}
                </>
              ) : (
                <>
                  <EmptyPrompt
                    title="选择真实本地代码库"
                    body=""
                    actions={[
                      {
                        label: repositoryPickerLabel(),
                        onAction: createCurrentProject,
                        disabled: !localClientReady || !props.onCreateCurrentProject || actionState === 'creating-project',
                      },
                    ]}
                  />
                  {projectPanel === 'archive' ? (
                    <WorkspaceDrawer label="项目二级面板" className="project-drawer" onClose={() => setProjectPanel(undefined)}>
                      <section className="drawer-section" aria-label="归档项目">
                        <div className="drawer-header-row">
                          <strong>归档项目</strong>
                          <button type="button" onClick={async () => (props.onLoadArchivedProjects ? setArchivedProjects(await props.onLoadArchivedProjects()) : undefined)} disabled={!props.onLoadArchivedProjects}>
                            刷新
                          </button>
                        </div>
                        {archivedProjects.length === 0 ? (
                          <span>暂无归档项目。</span>
                        ) : (
                          archivedProjects.map((project) => (
                            <div className="object-row readonly" key={project.id}>
                              <strong>{project.name}</strong>
                              <small>{project.localPath}</small>
                              <button type="button" onClick={() => restoreProject(project.id)}>
                                恢复项目
                              </button>
                            </div>
                          ))
                        )}
                      </section>
                    </WorkspaceDrawer>
                  ) : null}
                </>
              )}
            </section>
          </section>
        ) : null}

        {activeNavTarget === 'conversations' ? (
          <section className="workspace-view workspace-view-conversations" aria-label="对话">
            <aside className="workspace-list-pane conversation-list-pane" aria-label="对话列表">
              <div className="pane-toolbar" aria-label="对话搜索与新建">
                <label className="compact-field">
                  搜索任务
                  <input aria-label="搜索任务" value={taskSearchQuery} onChange={(event) => setTaskSearchQuery(event.currentTarget.value)} />
                </label>
                <label className="compact-field">
                  状态筛选
                  <select aria-label="任务状态筛选" value={taskStatusFilter} onChange={(event) => setTaskStatusFilter(event.currentTarget.value as TaskStatus | '')}>
                    <option value="">全部</option>
                    <option value="ready">ready</option>
                    <option value="running">running</option>
                    <option value="paused">paused</option>
                    <option value="completed">completed</option>
                    <option value="cancelled">cancelled</option>
                  </select>
                </label>
                <label className="compact-field">
                  标签筛选
                  <input aria-label="任务标签筛选" value={taskTagFilter} onChange={(event) => setTaskTagFilter(event.currentTarget.value)} />
                </label>
                <label className="compact-field">
                  排序
                  <select aria-label="任务排序" value={taskSortBy} onChange={(event) => setTaskSortBy(event.currentTarget.value as 'createdAt' | 'updatedAt' | 'title' | 'status')}>
                    <option value="title">标题</option>
                    <option value="status">状态</option>
                    <option value="createdAt">创建时间</option>
                    <option value="updatedAt">更新时间</option>
                  </select>
                </label>
                <button type="button" onClick={loadFilteredTasks} disabled={!firstProjectId || !props.onLoadTasks || actionState === 'updating-task'}>
                  筛选
                </button>
                <button type="button" onClick={createDefaultTask} disabled={!firstProjectId || actionState === 'creating-task'}>
                  新对话
                </button>
              </div>
              <div className="object-list" aria-label="今天">
                {visibleTasks.length === 0 ? (
                  <EmptyPrompt
                    title="还没有任务"
                    body=""
                    actions={[
                      {
                        label: '新对话',
                        onAction: createDefaultTask,
                        disabled: !firstProjectId || actionState === 'creating-task',
                      },
                    ]}
                  />
                ) : (
                  visibleTasks.map((task) => (
                    <button key={task.id} type="button" className={task.id === selectedTask?.id ? 'object-row selected' : 'object-row'} onClick={() => loadTaskDetail(task.id)}>
                      <strong>{task.title}</strong>
                      <span>{task.status}</span>
                      <small>{task.projectId}</small>
                    </button>
                  ))
                )}
              </div>
              {archivedTasks.length > 0 ? (
                <section className="conversation-archive" aria-label="归档">
                  <strong>归档任务</strong>
                  {archivedTasks.slice(0, 6).map((task) => (
                    <button type="button" className="object-row" key={task.id} onClick={() => restoreTask(task.id)}>
                      <span>恢复任务</span>
                      <strong>{task.title}</strong>
                    </button>
                  ))}
                </section>
              ) : null}
            </aside>

            <section className="workspace-detail-pane conversation-detail-pane" aria-label="当前对话">
              <section className="integration-state-strip" aria-label="外部集成状态">
                <span>{runtime.aiCli.available ? 'AI CLI 已检测' : 'AI CLI 未配置'}</span>
                <span>{runtime.telegram.enabled ? 'Telegram 已启用' : 'Telegram 未启用'}</span>
              </section>
              {selectedTask ? (
                <>
                  <section className="thread-summary" aria-label="当前对话">
                    <strong>{selectedTask.title}</strong>
                    <span>
                      {selectedTask.status} · {selectedTask.projectId}
                    </span>
                    {selectedTask.description ? <p>{selectedTask.description}</p> : null}
                  </section>
                  <section className="thread-body" aria-label="任务事件">
                    {taskEvents.length === 0 ? (
                      <span>暂无事件，下一步可以推送到 CLI 或补充任务要求。</span>
                    ) : (
                      taskEvents.slice(-8).map((event) => (
                        <article className="timeline-event" key={event.id}>
                          <strong>{event.title}</strong>
                          <span>{event.eventType}</span>
                          <small>{event.createdAt}</small>
                        </article>
                      ))
                    )}
                  </section>
                  <section className="primary-action-row" aria-label="任务下一步">
                    {selectedTask.status === 'ready' ? (
                      <button type="button" onClick={() => controlTaskRuntime(selectedTask.id, 'run')}>
                        推送到 CLI 对话
                      </button>
                    ) : null}
                    {selectedTask.status === 'running' ? (
                      <button type="button" onClick={() => controlTaskRuntime(selectedTask.id, 'pause')}>
                        暂停 Runtime
                      </button>
                    ) : null}
                    {selectedTask.status === 'paused' ? (
                      <button type="button" onClick={() => controlTaskRuntime(selectedTask.id, 'continue')}>
                        继续 Runtime
                      </button>
                    ) : null}
                    <button type="button" onClick={() => updateTaskStatus(selectedTask.id, 'completed')}>
                      标记完成
                    </button>
                    <button type="button" onClick={() => controlTaskRuntime(selectedTask.id, 'cancel')}>
                      取消任务
                    </button>
                  </section>
                  <section className="composer-dock" aria-label="要求后续变更">
                    <textarea
                      aria-label="要求后续变更"
                      value={taskEditForm.description}
                      onChange={(event) =>
                        setTaskEditForm((current) => ({
                          ...current,
                          description: event.currentTarget.value,
                        }))
                      }
                      placeholder="要求后续变更"
                    />
                    <button type="button" onClick={() => selectedTask && updateTask(selectedTask.id)} disabled={!selectedTask || actionState === 'updating-task'}>
                      发送
                    </button>
                  </section>
                  <section className="secondary-action-row" aria-label="对话收纳入口">
                    <button type="button" onClick={() => setConversationDrawer(conversationDrawer === 'runtime' ? undefined : 'runtime')}>
                      运行环境
                    </button>
                    <button type="button" onClick={() => setConversationDrawer(conversationDrawer === 'context' ? undefined : 'context')}>
                      上下文
                    </button>
                    <button type="button" onClick={() => setConversationDrawer(conversationDrawer === 'changes' ? undefined : 'changes')}>
                      代码变更
                    </button>
                    <button type="button" onClick={() => setConversationDrawer(conversationDrawer === 'templates' ? undefined : 'templates')}>
                      模板
                    </button>
                  </section>
                </>
              ) : (
                <EmptyPrompt
                  title="新对话"
                  body=""
                  actions={[
                    {
                      label: '新对话',
                      onAction: createDefaultTask,
                      disabled: !firstProjectId || actionState === 'creating-task',
                    },
                  ]}
                />
              )}

              {conversationDrawer ? (
                <WorkspaceDrawer label="对话二级面板" className="conversation-drawer" onClose={() => setConversationDrawer(undefined)}>
                  {conversationDrawer === 'runtime' ? (
                    <section className="drawer-section runtime-workbench" aria-label="运行环境">
                      <div className="drawer-header-row">
                        <strong>运行环境</strong>
                        <button type="button" onClick={loadRuntimeStatus} disabled={!props.onLoadRuntimeStatus || actionState === 'loading-runtime'}>
                          刷新
                        </button>
                      </div>
                      <div className="evidence-row">
                        <strong>{runtime.aiCli.name}</strong>
                        <span>{runtime.aiCli.available ? `已检测到 ${runtime.aiCli.command}` : `等待配置 ${runtime.aiCli.command}`}</span>
                        <em>{runtime.aiCli.reason}</em>
                      </div>
                      <div className="evidence-row">
                        <strong>终端后端</strong>
                        <span>{runtime.terminal?.provider ?? 'child_process'}</span>
                        <em>{runtime.terminal?.pty.reason ?? 'node-pty 状态等待读取。'}</em>
                      </div>
                      {runtimeAdapters.length > 0 ? (
                        <section className="timeline" aria-label="Runtime Adapters">
                          <strong>Runtime Adapters</strong>
                          {runtimeAdapters.map((adapter) => {
                            const checked = runtimeAdapterChecks[adapter.id];
                            return (
                              <div className="timeline-event" key={adapter.id}>
                                <strong>{adapter.displayName}</strong>
                                <span>
                                  {adapter.command} · {checked ? (checked.available ? '可用' : '不可用') : '未检测'}
                                </span>
                                <small>{formatRuntimeAdapterDetectionFacts(adapter, checked)}</small>
                                <button type="button" onClick={() => checkRuntimeAdapter(adapter.id)} disabled={actionState === 'loading-runtime'}>
                                  检测 adapter
                                </button>
                              </div>
                            );
                          })}
                        </section>
                      ) : null}
                      {runtimeAdapters.some((adapter) => adapter.id === 'generic') ? (
                        <section className="edit-form danger-zone" aria-label="Generic shell 高风险确认">
                          <strong>Generic shell 高风险确认</strong>
                          <label>
                            Generic shell 命令
                            <input
                              aria-label="Generic shell 命令"
                              placeholder="例如 pnpm --version"
                              value={runtimeGenericShellCommand}
                              onChange={(event) => {
                                setRuntimeGenericShellCommand(event.currentTarget.value);
                                setRuntimeGenericShellCriticalConfirmation('');
                                setRuntimeConfirmation(undefined);
                                setRuntimeConfirmationCommand('');
                                setRuntimeConfirmationStatus('命令已变更，请重新创建 Generic shell 确认');
                              }}
                            />
                          </label>
                          <div className="evidence-row">
                            <strong>命令预览</strong>
                            <span>{runtimeGenericShellCommand.trim() ? `sh -lc ${runtimeGenericShellCommand.trim()}` : '尚未输入 shell 命令'}</span>
                            <em>
                              {genericShellRisk.label}：{genericShellRisk.reason}。确认只绑定本次 sh -lc。
                            </em>
                          </div>
                          {genericShellRisk.level === 'critical' ? (
                            <label>
                              高危命令确认短语
                              <input
                                aria-label="高危命令确认短语"
                                placeholder={GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE}
                                value={runtimeGenericShellCriticalConfirmation}
                                onChange={(event) => setRuntimeGenericShellCriticalConfirmation(event.currentTarget.value)}
                              />
                              <small>检测到高危命令，启动前必须完整输入 {GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE}。</small>
                            </label>
                          ) : null}
                          <small>{runtimeConfirmationStatus}</small>
                          {runtimeConfirmation?.status === 'rejected' ? (
                            <div className="evidence-row">
                              <strong>已拒绝 Generic shell 确认</strong>
                              <span>不会启动 Runtime 会话</span>
                              <em>{runtimeConfirmation.rejectedReason ?? '用户已拒绝本次一次性确认。'}</em>
                            </div>
                          ) : null}
                          <div className="task-controls">
                            <button type="button" onClick={createGenericRuntimeConfirmation} disabled={!props.onCreateRuntimeConfirmation || !firstProjectId || !runtimeGenericShellCommand.trim() || actionState === 'loading-runtime'}>
                              创建 Generic shell 确认
                            </button>
                            {runtimeConfirmation?.status === 'pending' ? (
                              <button type="button" onClick={rejectGenericRuntimeConfirmation} disabled={!props.onRejectRuntimeOperation || actionState === 'loading-runtime'}>
                                拒绝 Generic shell 确认
                              </button>
                            ) : null}
                            {runtimeConfirmation?.status !== 'rejected' ? (
                              <button
                                type="button"
                                onClick={confirmAndStartGenericRuntime}
                                disabled={!props.onConfirmRuntimeOperation || !runtimeConfirmation || runtimeConfirmation.status !== 'pending' || !genericShellCriticalConfirmed || actionState === 'loading-runtime'}
                              >
                                确认并启动 Generic shell
                              </button>
                            ) : null}
                          </div>
                          {runtimeConfirmation?.status === 'pending' ? <small>拒绝后不会启动 Runtime 会话。</small> : null}
                        </section>
                      ) : null}
                      <section className="timeline" aria-label="AI Runtime 会话">
                        <div className="drawer-header-row">
                          <strong>AI Runtime 会话</strong>
                          <button type="button" onClick={startRuntimeSession} disabled={!firstProjectId || !runtime.aiCli.available || actionState === 'loading-runtime'}>
                            启动 Runtime 会话
                          </button>
                        </div>
                        <div className="graph-search-bar" aria-label="Runtime 会话搜索">
                          <label>
                            搜索会话
                            <input aria-label="搜索会话" value={runtimeSearchQuery} onChange={(event) => setRuntimeSearchQuery(event.currentTarget.value)} />
                          </label>
                          <label>
                            <input aria-label="只看收藏会话" type="checkbox" checked={runtimeFavoriteOnly} onChange={(event) => setRuntimeFavoriteOnly(event.currentTarget.checked)} />
                            只看收藏
                          </label>
                          <label>
                            <input aria-label="显示归档会话" type="checkbox" checked={runtimeShowArchived} onChange={(event) => setRuntimeShowArchived(event.currentTarget.checked)} />
                            显示归档
                          </label>
                          <button type="button" onClick={refreshRuntimeSessions} disabled={!props.onLoadRuntimeSessions || actionState === 'loading-runtime'}>
                            应用会话筛选
                          </button>
                        </div>
                        {runtimeSessions.length === 0 ? (
                          <span>暂无真实 Runtime 会话。</span>
                        ) : (
                          runtimeSessions.slice(0, 5).map((session) => (
                            <div className="timeline-event" key={session.id}>
                              <strong>{[session.command, ...session.args].join(' ')}</strong>
                              <span>
                                {session.status} · {session.cwd}
                              </span>
                              <small>{session.summary ?? '未生成摘要'}</small>
                              <div className="task-controls">
                                <button type="button" onClick={() => generateRuntimeSessionSummary(session.id)}>
                                  生成摘要
                                </button>
                                <button type="button" onClick={() => setRuntimeSessionFavorite(session)}>
                                  {session.favorite ? '取消收藏' : '收藏会话'}
                                </button>
                                {session.archived ? (
                                  <button type="button" onClick={() => restoreRuntimeSession(session.id)}>
                                    恢复会话
                                  </button>
                                ) : (
                                  <button type="button" onClick={() => archiveRuntimeSession(session.id)}>
                                    归档会话
                                  </button>
                                )}
                                <button type="button" onClick={() => createTaskFromRuntimeSession(session)}>
                                  从会话创建任务
                                </button>
                                <button type="button" onClick={() => exportRuntimeLogs(session.id)}>
                                  导出当前日志
                                </button>
                                <button type="button" onClick={() => deleteRuntimeSession(session.id)}>
                                  删除会话
                                </button>
                              </div>
                              {session.status === 'running' ? (
                                <section className="edit-form" aria-label="Runtime 输入">
                                  <label>
                                    Runtime 输入
                                    <input aria-label="Runtime 输入" value={runtimeInput} onChange={(event) => setRuntimeInput(event.currentTarget.value)} />
                                  </label>
                                  <button type="button" onClick={() => sendRuntimeInput(session.id)} disabled={!runtimeInput.trim() || actionState === 'loading-runtime'}>
                                    发送 Runtime 输入
                                  </button>
                                  <button type="button" onClick={() => interruptRuntimeSession(session.id)}>
                                    Interrupt
                                  </button>
                                  <button type="button" onClick={() => resizeRuntimeSession(session.id)}>
                                    调整终端尺寸
                                  </button>
                                  <button type="button" onClick={() => loadRuntimeTerminalSnapshot(session.id)}>
                                    读取终端快照
                                  </button>
                                  <button type="button" onClick={() => stopRuntimeSession(session.id)}>
                                    停止会话
                                  </button>
                                </section>
                              ) : null}
                              {session.status === 'orphan_detected' ? (
                                <section className="edit-form" aria-label="Runtime 孤儿会话控制">
                                  <button type="button" onClick={() => stopRuntimeSession(session.id)}>
                                    终止孤儿会话
                                  </button>
                                </section>
                              ) : null}
                            </div>
                          ))
                        )}
                      </section>
                      {runtimeLogs.length > 0 ? (
                        <section className="terminal-log" aria-label="真实 Runtime 日志">
                          <strong>真实 Runtime 日志</strong>
                          <RuntimeXtermPane logs={runtimeLogs} enabled={runtimeStatus?.terminal?.provider === 'node-pty' && runtimeStatus.terminal.pty.available === true} />
                          <label>
                            搜索日志
                            <input aria-label="搜索日志" value={runtimeLogSearchQuery} onChange={(event) => setRuntimeLogSearchQuery(event.currentTarget.value)} />
                          </label>
                          <div className="task-controls">
                            <button type="button" onClick={copyRuntimeLogs}>
                              复制当前日志
                            </button>
                            <button type="button" onClick={() => setRuntimeLogsCollapsed((current) => !current)}>
                              {runtimeLogsCollapsed ? '展开日志' : '折叠日志'}
                            </button>
                            <span className="sr-only">展开日志</span>
                            <button type="button" onClick={() => exportRuntimeLogs(runtimeLogs[0]?.sessionId ?? '')}>
                              导出当前日志
                            </button>
                          </div>
                          <small>
                            日志导出只保存当前加载的真实 Runtime 日志 · {runtimeLogExportStatus} · {runtimeLogCopyStatus}
                          </small>
                          <div className="log-legend">错误高亮 / 命令高亮 / AI 回复高亮</div>
                          <details>
                            <summary>原始输出查看</summary>
                            {!runtimeLogsCollapsed ? (
                              runtimeLogs
                                .filter((entry) => runtimeLogMatches(entry, runtimeLogSearchQuery))
                                .slice(-8)
                                .map((entry) => {
                                  const tone = classifyRuntimeLog(entry);
                                  return (
                                    <code className={`runtime-log-line ${tone}`} key={entry.id}>
                                      {formatRuntimeLogLine(entry)}
                                    </code>
                                  );
                                })
                            ) : (
                              <span>日志已折叠，点击展开日志查看。</span>
                            )}
                          </details>
                        </section>
                      ) : null}
                    </section>
                  ) : null}

                  {conversationDrawer === 'context' ? (
                    <section className="drawer-section" aria-label="上下文">
                      <div className="drawer-header-row">
                        <strong>上下文</strong>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveNavTarget('projects');
                            setProjectPanel('graph');
                          }}
                        >
                          打开图谱
                        </button>
                      </div>
                      <span>
                        {snapshot.graph.nodeCount} nodes / {snapshot.graph.edgeCount} edges / {snapshot.graph.viewCount} views
                      </span>
                      {graphAnswer ? (
                        <div className="graph-ai-summary">
                          <strong>图谱问答</strong>
                          <span>{graphAnswer.answer}</span>
                        </div>
                      ) : null}
                      {graphConversations.slice(0, 4).map((conversation) => (
                        <button type="button" className="object-row" key={conversation.id} onClick={() => loadGraphConversationDetail(conversation.id)}>
                          {conversation.title}
                        </button>
                      ))}
                    </section>
                  ) : null}

                  {conversationDrawer === 'changes' ? (
                    <section className="drawer-section" aria-label="代码变更">
                      <div className="drawer-header-row">
                        <strong>代码变更</strong>
                        <button type="button" onClick={loadGitDiff} disabled={!props.onLoadGitDiff || actionState === 'loading-diff'}>
                          读取 Diff
                        </button>
                      </div>
                      {changedFiles.length === 0 ? <span>暂无已读取变更。</span> : changedFiles.slice(0, 12).map((file) => <code key={file}>{file}</code>)}
                    </section>
                  ) : null}

                  {conversationDrawer === 'templates' ? (
                    <section className="drawer-section" aria-label="任务模板">
                      <div className="drawer-header-row">
                        <strong>任务模板</strong>
                        <button type="button" onClick={loadTaskTemplates} disabled={!props.onLoadTaskTemplates || actionState === 'loading-templates'}>
                          {actionState === 'loading-templates' ? '读取中' : '读取模板'}
                        </button>
                      </div>
                      {taskTemplates.length === 0 ? (
                        <span>暂无模板。</span>
                      ) : (
                        taskTemplates.map((template) => (
                          <button type="button" className="object-row" key={template.id} onClick={() => createTaskFromTemplate(template.id)}>
                            {template.name}
                          </button>
                        ))
                      )}
                    </section>
                  ) : null}
                </WorkspaceDrawer>
              ) : null}
            </section>
          </section>
        ) : null}

        {activeNavTarget === 'settings' ? (
          <section className="workspace-view workspace-view-settings" aria-label="设置">
            <aside className="settings-category-list" aria-label="设置分类">
              {(
                [
                  ['general', '通用'],
                  ['runtime', 'AI CLI / Runtime'],
                  ['telegram', 'Telegram'],
                  ['security', '安全与 Keychain'],
                  ['git', 'Git 确认'],
                  ['release', '发布与更新'],
                  ['data', '缓存与数据'],
                ] as Array<[SettingsCategory, string]>
              ).map(([id, label]) => (
                <button key={id} type="button" className={settingsCategory === id ? 'selected' : ''} onClick={() => setSettingsCategory(id)}>
                  {label}
                </button>
              ))}
            </aside>
            <section className="settings-detail-pane" aria-label="当前分类">
              {settingsCategory === 'general' ? (
                <section className="settings-form native-settings-stack" aria-label="通用">
                  <strong className="settings-current-category">当前分类：通用</strong>
                  <NativeSettingsCard label="通用设置">
                    <NativeControlRow title="应用语言" description="选择 Zeus 使用的界面语言">
                      <select
                        aria-label="应用语言"
                        value={appShellSettings.appLanguage}
                        onChange={(event) =>
                          setAppShellSettings((current) => ({
                            ...current,
                            appLanguage: event.currentTarget.value as AppShellSettings['appLanguage'],
                          }))
                        }
                      >
                        <option value="zh-CN">简体中文</option>
                        <option value="en-US">English</option>
                      </select>
                    </NativeControlRow>
                    <NativeControlRow title="深色/浅色模式" description="界面跟随系统，或固定为浅色、深色">
                      <select
                        aria-label="深色/浅色模式"
                        value={appShellSettings.appearance}
                        onChange={(event) =>
                          setAppShellSettings((current) => ({
                            ...current,
                            appearance: event.currentTarget.value as AppShellSettings['appearance'],
                          }))
                        }
                      >
                        <option value="system">跟随系统</option>
                        <option value="light">浅色</option>
                        <option value="dark">深色</option>
                      </select>
                    </NativeControlRow>
                    <NativeControlRow title="桌面通知" description="本机任务、Runtime 和 Telegram 状态变化时提醒">
                      <label className="native-switch" aria-label="桌面通知开关">
                        <input
                          className="native-switch-input"
                          aria-label="桌面通知"
                          type="checkbox"
                          checked={appShellSettings.desktopNotificationsEnabled}
                          onChange={(event) =>
                            setAppShellSettings((current) => ({
                              ...current,
                              desktopNotificationsEnabled: event.currentTarget.checked,
                            }))
                          }
                        />
                        <span className="native-switch-track" aria-hidden="true" />
                      </label>
                    </NativeControlRow>
                    <NativeControlRow title="保存设置" description="只保存当前分类，不影响项目或 Runtime 会话">
                      <button type="button" onClick={saveAppShellSettings} disabled={!props.onSaveAppShellSettings || actionState === 'loading-runtime'}>
                        保存
                      </button>
                    </NativeControlRow>
                  </NativeSettingsCard>
                </section>
              ) : null}
              {settingsCategory === 'runtime' ? (
                <section className="settings-form native-settings-stack" aria-label="AI CLI / Runtime">
                  <strong className="settings-current-category">当前分类：AI CLI / Runtime</strong>
                  <NativeSettingsCard label="Runtime 执行设置">
                    <span>Runtime 执行设置</span>
                    <div className="evidence-row">
                      <strong>{runtime.aiCli.name}</strong>
                      <span>{runtime.aiCli.available ? '已检测' : '等待配置'}</span>
                      <em>{runtime.aiCli.reason}</em>
                    </div>
                    <label>
                      默认 Adapter
                      <select
                        aria-label="默认 Runtime Adapter"
                        value={runtimeSettings.defaultAdapterId}
                        onChange={(event) =>
                          setRuntimeSettings((current) => ({
                            ...current,
                            defaultAdapterId: event.currentTarget.value as RuntimeSettings['defaultAdapterId'],
                          }))
                        }
                      >
                        {runtimeAdapters.length === 0 ? (
                          <option value="codex">codex</option>
                        ) : (
                          runtimeAdapters.map((adapter) => (
                            <option key={adapter.id} value={adapter.id}>
                              {adapter.displayName}
                            </option>
                          ))
                        )}
                      </select>
                    </label>
                    <div className="evidence-row">
                      <strong>当前默认</strong>
                      <span>{runtimeAdapters.find((adapter) => adapter.id === runtimeSettings.defaultAdapterId)?.displayName ?? runtimeSettings.defaultAdapterId}</span>
                      <em>{`当前默认：${runtimeAdapters.find((adapter) => adapter.id === runtimeSettings.defaultAdapterId)?.displayName ?? runtimeSettings.defaultAdapterId}`}</em>
                    </div>
                    <label>
                      默认 Adapter 模型
                      <input
                        aria-label="默认 Adapter 模型"
                        value={runtimeSettings.adapterModels[runtimeSettings.defaultAdapterId] ?? ''}
                        onChange={(event) =>
                          setRuntimeSettings((current) => ({
                            ...current,
                            adapterModels: {
                              ...current.adapterModels,
                              [current.defaultAdapterId]: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      默认参数
                      <input
                        aria-label="默认参数"
                        value={formatRuntimeDefaultArgs(runtimeSettings.adapterDefaultArgs[runtimeSettings.defaultAdapterId] ?? ['--ask-for-approval', 'never'])}
                        onChange={(event) =>
                          setRuntimeSettings((current) => ({
                            ...current,
                            adapterDefaultArgs: {
                              ...current.adapterDefaultArgs,
                              [current.defaultAdapterId]: parseRuntimeDefaultArgsText(event.currentTarget.value),
                            },
                          }))
                        }
                      />
                    </label>
                    <label>
                      CLI 路径
                      <input
                        aria-label="CLI 路径"
                        value={runtimeSettings.adapterCliPaths[runtimeSettings.defaultAdapterId] ?? ''}
                        onChange={(event) =>
                          setRuntimeSettings((current) => ({
                            ...current,
                            adapterCliPaths: {
                              ...current.adapterCliPaths,
                              [current.defaultAdapterId]: event.currentTarget.value,
                            },
                          }))
                        }
                      />
                    </label>
                    <div className="evidence-row">
                      <strong>项目并发上限</strong>
                      <span>{runtimeSettings.concurrency.maxPerProject}</span>
                      <em>全局并发上限：{runtimeSettings.concurrency.maxGlobal}</em>
                    </div>
                    <div className="evidence-row">
                      <strong>执行超时</strong>
                      <span>{`${runtimeSettings.executionTimeoutSeconds} 秒`}</span>
                      <em>{`日志保留策略：保留 ${runtimeSettings.logRetentionDays} 天`}</em>
                    </div>
                    <div className="evidence-row">
                      <strong>自动确认策略</strong>
                      <span>{runtimeSettings.autoConfirmationPolicy === 'low_risk_only' ? '仅低风险' : runtimeSettings.autoConfirmationPolicy}</span>
                      <em>不会绕过 Generic shell、Git 写入、删除文件等高风险确认。</em>
                    </div>
                    <label>
                      执行超时秒数
                      <input
                        aria-label="执行超时秒数"
                        value={String(runtimeSettings.executionTimeoutSeconds)}
                        onChange={(event) =>
                          setRuntimeSettings((current) => ({
                            ...current,
                            executionTimeoutSeconds: normalizeRuntimeSettingNumber(event.currentTarget.value, current.executionTimeoutSeconds, 24 * 3600),
                          }))
                        }
                      />
                    </label>
                    <details>
                      <summary>高级 Runtime 参数</summary>
                      <label>
                        Shell 路径
                        <input
                          aria-label="Shell 路径"
                          value={runtimeSettings.shell.path ?? ''}
                          onChange={(event) =>
                            setRuntimeSettings((current) => ({
                              ...current,
                              shell: {
                                ...current.shell,
                                path: event.currentTarget.value || null,
                              },
                            }))
                          }
                        />
                      </label>
                      <span>{runtimeSettings.shell.login ? '作为 login shell 启动' : '非 login shell 启动'}</span>
                      <label>
                        终端环境变量
                        <textarea
                          aria-label="终端环境变量"
                          value={formatRuntimeTerminalEnv(runtimeSettings.terminalEnv)}
                          onChange={(event) =>
                            setRuntimeSettings((current) => ({
                              ...current,
                              terminalEnv: parseRuntimeTerminalEnvText(event.currentTarget.value),
                            }))
                          }
                        />
                      </label>
                      <small>环境变量会进入真实子进程；不会验证 CLI 已安装或已登录。</small>
                    </details>
                    <button type="button" onClick={saveRuntimeSettings} disabled={!props.onSaveRuntimeSettings || actionState === 'loading-runtime'}>
                      保存默认 Adapter
                    </button>
                  </NativeSettingsCard>
                </section>
              ) : null}
              {settingsCategory === 'telegram' ? (
                <section className="settings-form native-settings-stack" aria-label="Telegram">
                  <strong className="settings-current-category">当前分类：Telegram</strong>
                  <NativeSettingsCard label="Telegram 设置">
                    <div className="evidence-row">
                      <strong>Telegram Bot Token</strong>
                      <span>{securitySecrets.telegramBotToken.label}</span>
                      <em>Token 只保存到 macOS Keychain；界面不回显明文。</em>
                    </div>
                    <label>
                      Telegram Bot Token
                      <input aria-label="Telegram Bot Token" type="password" value={telegramTokenInput} onChange={(event) => setTelegramTokenInput(event.currentTarget.value)} />
                    </label>
                    <div className="task-controls">
                      <button type="button" onClick={saveTelegramBotToken} disabled={!telegramTokenInput.trim() || actionState === 'loading-runtime'}>
                        保存到 Keychain
                      </button>
                      <button type="button" onClick={clearTelegramBotToken} disabled={!props.onClearTelegramBotToken || actionState === 'loading-runtime'}>
                        清理 Token
                      </button>
                    </div>
                    <label>
                      通知 Chat ID
                      <input aria-label="通知 Chat ID" value={telegramNotificationChatIdsInput} onChange={(event) => setTelegramNotificationChatIdsInput(event.currentTarget.value)} />
                    </label>
                    <div className="task-controls">
                      <button type="button" onClick={saveTelegramNotificationSettings} disabled={!props.onSaveTelegramNotificationSettings || actionState === 'loading-runtime'}>
                        保存通知设置
                      </button>
                      <button type="button" onClick={testTelegramConnection} disabled={!props.onTestTelegramConnection || actionState === 'loading-runtime'}>
                        测试连接
                      </button>
                    </div>
                    <span>{telegramTestStatus}</span>
                    <details>
                      <summary>轮询与消息日志</summary>
                      <span>
                        {telegramPollingStatus.running ? '运行中' : '已停止'} · offset {telegramPollingStatus.offset}
                      </span>
                      {telegramPollingLogs.slice(-5).map((entry, index) => (
                        <code key={`${entry.updateId ?? 'poll'}-${index}`}>{entry.command}</code>
                      ))}
                    </details>
                  </NativeSettingsCard>
                </section>
              ) : null}
              {settingsCategory === 'security' ? (
                <section className="settings-form native-settings-stack" aria-label="安全与 Keychain">
                  <strong className="settings-current-category">当前分类：安全与 Keychain</strong>
                  <NativeSettingsCard label="安全与 Keychain 设置">
                    <div className="evidence-row">
                      <strong>外部 API Key</strong>
                      <span>{securitySecrets.externalApiKey.label}</span>
                      <em>只保存到 macOS Keychain；不会声明外部 AI 服务已可用。</em>
                    </div>
                    <label>
                      外部 API Key
                      <input aria-label="外部 API Key" type="password" value={externalApiKeyInput} onChange={(event) => setExternalApiKeyInput(event.currentTarget.value)} />
                    </label>
                    <div className="task-controls">
                      <button type="button" onClick={saveExternalApiKey} disabled={!externalApiKeyInput.trim() || actionState === 'loading-runtime'}>
                        保存 API Key
                      </button>
                      <button type="button" onClick={clearExternalApiKey} disabled={!props.onClearExternalApiKey || actionState === 'loading-runtime'}>
                        清理 API Key
                      </button>
                    </div>
                    <label>
                      Allowed User ID
                      <input aria-label="Allowed User ID" value={telegramAllowedUserIdsInput} onChange={(event) => setTelegramAllowedUserIdsInput(event.currentTarget.value)} />
                    </label>
                    <button type="button" onClick={saveTelegramSecuritySettings} disabled={!props.onSaveTelegramSecuritySettings || actionState === 'loading-runtime'}>
                      保存白名单
                    </button>
                    <section className="danger-zone" aria-label="泄露风险">
                      <strong>泄露风险</strong>
                      <button type="button" onClick={resetSecurity} disabled={!props.onResetSecurity || actionState === 'loading-runtime'}>
                        重置安全设置
                      </button>
                    </section>
                    <details>
                      <summary>安全审计</summary>
                      {securityAuditLogs.length === 0 ? <span>暂无真实安全审计记录。</span> : securityAuditLogs.slice(0, 6).map((entry) => <code key={entry.id}>{entry.action}</code>)}
                    </details>
                  </NativeSettingsCard>
                </section>
              ) : null}
              {settingsCategory === 'git' ? (
                <section className="settings-form native-settings-stack" aria-label="Git 确认">
                  <strong className="settings-current-category">当前分类：Git 确认</strong>
                  <NativeSettingsCard label="Git 确认设置">
                    <label>
                      分支名
                      <input aria-label="Git 分支名" value={gitBranchName} onChange={(event) => setGitBranchName(event.currentTarget.value)} />
                    </label>
                    <label>
                      远端
                      <input aria-label="Git 远端" value={gitRemote} onChange={(event) => setGitRemote(event.currentTarget.value)} />
                    </label>
                    <section className="danger-zone">
                      <strong>危险操作必须确认</strong>
                      <button type="button" onClick={() => createGitConfirmation('branch')} disabled={actionState === 'creating-git-confirmation' || !gitBranchName.trim()}>
                        请求创建分支确认
                      </button>
                      <button type="button" onClick={() => createGitConfirmation('push')} disabled={actionState === 'creating-git-confirmation' || !gitRemote.trim() || !gitTargetRef.trim()}>
                        请求推送确认
                      </button>
                    </section>
                  </NativeSettingsCard>
                </section>
              ) : null}
              {settingsCategory === 'release' ? (
                <section className="settings-form native-settings-stack" aria-label="发布与更新">
                  <strong className="settings-current-category">当前分类：发布与更新</strong>
                  <NativeSettingsCard label="发布与签名">
                    <span>发布与签名</span>
                    <div className="evidence-row">
                      <strong>macOS 签名</strong>
                      <span>{releaseStatus.signing.label}</span>
                      <em>证书只通过发布环境变量读取。</em>
                    </div>
                    <div className="evidence-row">
                      <strong>notarization</strong>
                      <span>{releaseStatus.notarization.label}</span>
                      <em>不会伪造签名或 notarization 成功；没有 Apple 凭据时只允许 unsigned 验证。</em>
                    </div>
                    <div className="evidence-row">
                      <strong>Homebrew cask</strong>
                      <span>{releaseStatus.homebrewCask.label}</span>
                      <em>{releaseStatus.readiness.canBuildUnsignedArtifacts ? 'unsigned 构建可用' : 'unsigned 构建不可用'}</em>
                    </div>
                    <details>
                      <summary>发布详情</summary>
                      <span>自动更新预留 · {releaseStatus.autoUpdate.label}</span>
                      <small>{releaseStatus.autoUpdate.changelogPath}</small>
                      <small>{releaseStatus.readiness.waitingFor.join(' · ')}</small>
                      <small>{releaseStatus.autoUpdate.waitingFor.join(' · ')}</small>
                    </details>
                    <section className="release-update-panel" aria-label="软件更新">
                      <div className="release-update-heading">
                        <strong>软件更新</strong>
                        <button type="button" onClick={checkReleaseUpdate} disabled={!props.onCheckReleaseUpdate || releaseUpdateCheckState === 'loading'}>
                          {releaseUpdateCheckState === 'loading' ? '检查中' : '检查更新'}
                        </button>
                      </div>
                      <div className="release-update-summary">
                        <span>{`当前版本：${releaseUpdateStatus.currentVersion}`}</span>
                        <span>{`最新版本：${releaseUpdateStatus.latestVersion}`}</span>
                        <span>{releaseUpdateStatus.label}</span>
                      </div>
                      <a href={releaseUpdateStatus.releasePageUrl}>GitHub Release</a>
                      <small>{releaseUpdateStatus.automaticInstallEnabled ? '已签名与公证，可下载后安装。' : '下载安装需要签名与公证；当前只打开 GitHub Release 手动安装。'}</small>
                      <small>{releaseUpdateStatus.reason}</small>
                      {releaseUpdateStatus.artifact ? (
                        <code>
                          {releaseUpdateStatus.artifact.fileName} · {releaseUpdateStatus.artifact.sha256}
                        </code>
                      ) : (
                        <span>暂无匹配本机架构的安装包。</span>
                      )}
                      {releaseUpdateCheckState === 'failed' ? <span role="status">更新检查失败，请稍后重试。</span> : null}
                    </section>
                  </NativeSettingsCard>
                </section>
              ) : null}
              {settingsCategory === 'data' ? (
                <section className="settings-form native-settings-stack" aria-label="缓存与数据">
                  <strong className="settings-current-category">当前分类：缓存与数据</strong>
                  <NativeSettingsCard label="缓存与数据设置">
                    <div className="evidence-row">
                      <strong>本地日志目录</strong>
                      <span>{appShellSettings.localLogDirectory}</span>
                      <em>导出会在本机脱敏保存。</em>
                    </div>
                    <div className="task-controls">
                      <button type="button" onClick={exportLocalSettings} disabled={!props.onExportLocalSettings || actionState === 'loading-runtime'}>
                        导出设置
                      </button>
                      <button type="button" onClick={importLocalSettings} disabled={!props.onImportLocalSettings || actionState === 'loading-runtime'}>
                        导入设置
                      </button>
                      <button type="button" onClick={clearLocalCaches} disabled={!props.onClearLocalCaches || actionState === 'loading-runtime'}>
                        清理缓存
                      </button>
                    </div>
                    <small>{dataPortabilityStatus}</small>
                  </NativeSettingsCard>
                </section>
              ) : null}
            </section>
          </section>
        ) : null}
      </section>
    </main>
  );
}

export const GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE = 'ZEUS HIGH RISK';

export type GenericShellCommandRiskLevel = 'empty' | 'medium' | 'critical';

export interface GenericShellCommandRisk {
  level: GenericShellCommandRiskLevel;
  label: string;
  reason: string;
}

/** 对 Generic shell 命令做本地静态风险提示；只用于提示和确认文案，不替代后端确认与审计。 */
export function classifyGenericShellCommandRisk(command: string): GenericShellCommandRisk {
  const normalized = command.trim().toLowerCase();
  if (!normalized)
    return {
      level: 'empty',
      label: '尚未输入',
      reason: '请输入要预览和确认的 shell 命令',
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
      label: '高危命令',
      reason: '检测到删除、管道执行远程脚本或破坏性系统操作模式',
    };
  }
  return {
    level: 'medium',
    label: '需要确认',
    reason: 'Generic shell 会在本机执行任意命令',
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

export function buildGitDiffReviewSummary(diff: GitDiffSummary): string {
  const hunkCount = diff.fileDiffs?.reduce((total, file) => total + file.hunks.length, 0) ?? 0;
  const addedLines = diff.fileDiffs?.reduce((total, file) => total + file.addedLines, 0) ?? 0;
  const deletedLines = diff.fileDiffs?.reduce((total, file) => total + file.deletedLines, 0) ?? 0;
  return `${diff.files.length} 个文件 · ${hunkCount} 个 hunk · +${addedLines} / -${deletedLines}`;
}

export function buildGitDiffDecisionSummary(diff: GitDiffSummary, decisions: Record<string, 'accepted' | 'rejected'>): string {
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
  return `审查决策：已接受 ${accepted} · 已拒绝 ${rejected} · 待审查 ${pending} · 不执行 git apply`;
}

function buildGitHunkReviewKey(file: { oldPath: string; newPath: string }, hunk: GitDiffHunk): string {
  return `${file.oldPath}->${file.newPath}:${hunk.header}`;
}

/** 使用固定 UTC 格式展示 Git 确认过期时间，避免本地时区差异让审查口径不一致。 */
function formatGitConfirmationExpiry(expiresAt: string): string {
  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) return '未知';
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Git 写操作标签只用于安全确认后的 UI 展示，不反推任何命令参数。 */
function formatGitOperationLabel(operation: string): string {
  const labels: Record<string, string> = {
    commit: '提交',
    stash: '暂存',
    apply_stash: '应用暂存',
    rollback: '回滚',
    branch: '创建分支',
    switch_branch: '切换分支',
    pull: '拉取',
    push: '推送',
  };
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

function formatRuntimeLogLine(entry: AiRuntimeLogEntry): string {
  return `${entry.createdAt} · ${entry.stream}: ${entry.text}`;
}

function runtimeLogMatches(entry: AiRuntimeLogEntry, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return `${entry.stream} ${entry.text} ${entry.createdAt}`.toLowerCase().includes(normalized);
}

function classifyRuntimeLog(entry: AiRuntimeLogEntry): 'error' | 'command' | 'ai' | 'output' {
  const text = entry.text.trim();
  if (entry.stream === 'stderr' || /(^|\b)(error|failed|exception)(\b|:)/iu.test(text)) return 'error';
  if (entry.stream === 'system' || text.startsWith('$') || text.startsWith('>')) return 'command';
  if (/^(AI|Assistant|Codex):/iu.test(text)) return 'ai';
  return 'output';
}

function toSafeAppShellImport(
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
      | 'defaultModel'
      | 'defaultTaskTemplateId'
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
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : null,
    defaultTaskTemplateId: typeof raw.defaultTaskTemplateId === 'string' ? raw.defaultTaskTemplateId : null,
  };
}

function CodeMapView(props: {
  isActive?: boolean;
  graphView: GraphViewSnapshot;
  searchResult?: GraphSearchResult;
  graphAnswer?: GraphQuestionAnswer;
  graphConversations?: GraphConversationHistoryItem[];
  graphConversationPage?: Pick<GraphConversationHistoryPage, 'total' | 'limit' | 'offset' | 'query' | 'archived'>;
  selectedGraphConversation?: GraphConversationHistoryItem;
  graphConversationSearch?: string;
  onGraphConversationSearchChange?: (query: string) => void;
  onLoadGraphConversations?: (input?: { query?: string; offset?: number; archived?: boolean }) => void;
  onLoadGraphConversation?: (conversationId: string) => void;
  onArchiveGraphConversation?: (conversationId: string) => void;
  onRestoreGraphConversation?: (conversationId: string) => void;
  onCreateTaskFromGraphConversation?: (conversationId: string) => void;
  onLoadView?: (viewType: GraphViewType) => Promise<void>;
  onSearchGraph?: (query: string, nodeType?: string, edgeType?: string, minConfidence?: number) => void;
  onAskGraph?: (question: string) => void;
  onCreateTaskFromNode?: (nodeId: string) => void;
  onOpenGraphSource?: (source: { sourceRef: string; lineStart?: number }) => void;
  onExportMermaidDiagramFile?: (payload: MermaidDiagramExportFile) => Promise<{ saved: boolean; filePath: string | null }>;
  codeMapSettings: CodeMapSettings;
}) {
  const [hiddenNodeIds, setHiddenNodeIds] = useState<string[]>([]);
  const [activeNodeMenuId, setActiveNodeMenuId] = useState<string | null>(null);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [selectedGraphHopDepth, setSelectedGraphHopDepth] = useState<1 | 2>(1);
  const [showMermaidPreview, setShowMermaidPreview] = useState(false);
  const [lastMermaidExport, setLastMermaidExport] = useState<ReturnType<typeof buildMermaidDiagramExport> | null>(null);
  const [mermaidExportStatus, setMermaidExportStatus] = useState<string | null>(null);
  const [graphSearchQuery, setGraphSearchQuery] = useState('local-server');
  const [graphQuestionInput, setGraphQuestionInput] = useState('local-server');
  const [graphNodeTypeFilter, setGraphNodeTypeFilter] = useState('file');
  const [graphEdgeTypeFilter, setGraphEdgeTypeFilter] = useState('declares');
  const [graphMinConfidence, setGraphMinConfidence] = useState(props.codeMapSettings.showLowConfidenceEdges ? 0 : 1);
  const rawVisibleNodes = props.searchResult?.nodes ?? props.graphView.nodes;
  const { nodes: visibleNodes, edges: visibleEdges } = buildVisibleGraphSlice({
    nodes: rawVisibleNodes,
    edges: props.searchResult?.edges?.length ? props.searchResult.edges : props.graphView.edges,
    hiddenNodeIds,
    maxNodes: 8,
    maxEdges: 5,
    showLowConfidenceEdges: props.codeMapSettings.showLowConfidenceEdges,
    minConfidence: graphMinConfidence,
  });
  const selectedGraphNode = visibleNodes.find((node) => node.id === selectedGraphNodeId) ?? visibleNodes[0];
  const conversationPage = props.graphConversationPage ?? {
    total: props.graphConversations?.length ?? 0,
    limit: 5,
    offset: 0,
    query: null,
    archived: false,
  };
  const nextOffset = conversationPage.offset + conversationPage.limit;
  const previousOffset = Math.max(0, conversationPage.offset - conversationPage.limit);
  const selectedConversation = props.selectedGraphConversation ?? props.graphConversations?.[0];
  const shouldRenderRuntimeGraph = props.isActive || typeof window === 'undefined';

  function toggleNodeVisibility(nodeId: string): void {
    setHiddenNodeIds((current) => (current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]));
  }

  function runNodeAction(node: GraphViewSnapshot['nodes'][number], action: GraphNodeActionMenuItem): void {
    if (action.id === 'inspect-detail') {
      setSelectedGraphNodeId(node.id);
      setSelectedGraphHopDepth(1);
    }
    if (action.id === 'create-task') props.onCreateTaskFromNode?.(node.id);
    if (action.id === 'open-source')
      props.onOpenGraphSource?.({
        sourceRef: action.sourceRef,
        lineStart: action.lineStart ?? undefined,
      });
    if (action.id === 'ask-node') {
      const request = buildGraphQuestionRequest(`解释图谱节点 ${node.qualifiedName}，来源 ${node.sourceRef}`);
      if (request.canAsk) props.onAskGraph?.(request.question);
    }
    if (action.id === 'generate-sequence' || action.id === 'generate-flow') {
      setSelectedGraphNodeId(node.id);
      setShowMermaidPreview(true);
    }
    if (action.id === 'expand-one-hop') {
      setSelectedGraphNodeId(node.id);
      setSelectedGraphHopDepth(1);
    }
    if (action.id === 'expand-two-hop') {
      setSelectedGraphNodeId(node.id);
      setSelectedGraphHopDepth(2);
    }
    if (action.id === 'toggle-visibility') toggleNodeVisibility(node.id);
    setActiveNodeMenuId(null);
  }

  return (
    <section className="code-map-view" aria-label="代码图谱视图">
      <section className="spatial-graph-stage" aria-label="Spatial Graph Studio">
        <div className="graph-stage-command">
          <span>Spatial Graph Studio</span>
          <h3>Graph Stage</h3>
          <p>以真实源码节点为舞台，聚焦模块、接口、表和方法，再把来源轨迹交给 AI 任务线程。</p>
        </div>
        <div className="graph-stage-lanes" aria-label="Graph Studio 工作区">
          <span>Node Focus</span>
          <span>Source Trail</span>
          <span>
            {props.graphView.nodes.length} nodes · {props.graphView.edges.length} edges
          </span>
        </div>
      </section>
      <div className="graph-view-switcher" aria-label="图谱视图切换">
        {graphViewOptions.map((option) => (
          <button key={option.type} type="button" aria-pressed={props.graphView.viewType === option.type} onClick={() => props.onLoadView?.(option.type)}>
            {option.label}
          </button>
        ))}
      </div>
      {props.graphView.performance ? (
        <div className="graph-performance-strip" aria-label="图谱性能监控">
          <span>图谱视图读取 {Math.round(props.graphView.performance.durationMs)}ms</span>
          <span>真实节点 {props.graphView.performance.nodeCount}</span>
          <span>真实边 {props.graphView.performance.edgeCount}</span>
        </div>
      ) : null}
      <div className="graph-search-bar" aria-label="图谱搜索过滤">
        <label>
          搜索节点/字段
          <input aria-label="搜索节点/字段" value={graphSearchQuery} onChange={(event) => setGraphSearchQuery(event.currentTarget.value)} />
        </label>
        <label>
          筛选类型
          <select aria-label="筛选类型" value={graphNodeTypeFilter} onChange={(event) => setGraphNodeTypeFilter(event.currentTarget.value)}>
            <option value="">全部</option>
            <option value="file">file</option>
            <option value="function">function</option>
            <option value="package">package</option>
            <option value="api">api</option>
            <option value="table">table</option>
            <option value="column">column</option>
          </select>
        </label>
        <label>
          边类型
          <select aria-label="边类型" value={graphEdgeTypeFilter} onChange={(event) => setGraphEdgeTypeFilter(event.currentTarget.value)}>
            <option value="">全部</option>
            <option value="declares">declares</option>
            <option value="contains">contains</option>
            <option value="calls">calls</option>
            <option value="reads_table">reads_table</option>
            <option value="writes_table">writes_table</option>
          </select>
        </label>
        <label>
          最低置信度
          <input aria-label="最低置信度" type="number" min="0" max="1" step="0.1" value={graphMinConfidence} onChange={(event) => setGraphMinConfidence(normalizeGraphMinConfidence(event.currentTarget.value, graphMinConfidence))} />
        </label>
        <button
          type="button"
          onClick={() => {
            const request = buildGraphSearchRequest({
              query: graphSearchQuery,
              nodeType: graphNodeTypeFilter,
              edgeType: graphEdgeTypeFilter,
              minConfidence: graphMinConfidence,
            });
            props.onSearchGraph?.(request.query, request.nodeType, request.edgeType, request.minConfidence);
          }}
        >
          搜索
        </button>
        {props.searchResult ? <span>{props.searchResult.nodes.length} 个结果</span> : null}
      </div>
      <section className="edit-form" aria-label="图谱问答">
        <h3>图谱问答</h3>
        <label>
          向图谱提问
          <input aria-label="向图谱提问" value={graphQuestionInput} onChange={(event) => setGraphQuestionInput(event.currentTarget.value)} />
        </label>
        <div className="task-controls">
          <button
            type="button"
            disabled={!buildGraphQuestionRequest(graphQuestionInput).canAsk}
            onClick={() => {
              const request = buildGraphQuestionRequest(graphQuestionInput);
              if (request.canAsk) props.onAskGraph?.(request.question);
            }}
          >
            向图谱提问
          </button>
        </div>
        <small>回答必须由真实 AI Runtime 基于图谱来源生成；来源不足时会明确说明不足以判断。</small>
        {props.graphAnswer ? (
          <div className="timeline-event" aria-label="图谱问答回答">
            <strong>{props.graphAnswer.answer}</strong>
            <span>{props.graphAnswer.sessionId ? `Runtime 会话 ${props.graphAnswer.sessionId}` : '来源不足，未启动 Runtime 会话'}</span>
            {props.graphAnswer.sources.nodes.slice(0, 3).map((node) => (
              <small key={node.id}>{node.sourceRef}</small>
            ))}
          </div>
        ) : null}
        <section className="timeline" aria-label="图谱问答历史">
          <h3>问答历史</h3>
          <div className="graph-history-toolbar" aria-label="图谱问答历史工具栏">
            <label>
              搜索历史
              <input aria-label="搜索图谱问答历史" value={props.graphConversationSearch ?? ''} onChange={(event) => props.onGraphConversationSearchChange?.(event.target.value)} />
            </label>
            <button
              type="button"
              onClick={() =>
                props.onLoadGraphConversations?.({
                  query: props.graphConversationSearch?.trim() || undefined,
                  offset: 0,
                  archived: conversationPage.archived,
                })
              }
            >
              搜索历史
            </button>
            <button
              type="button"
              aria-pressed={conversationPage.archived}
              onClick={() =>
                props.onLoadGraphConversations?.({
                  query: conversationPage.query ?? undefined,
                  offset: 0,
                  archived: !conversationPage.archived,
                })
              }
            >
              {conversationPage.archived ? '查看未归档' : '查看归档'}
            </button>
            <span>{conversationPage.total} 条真实问答</span>
          </div>
          {(props.graphConversations ?? []).length === 0 ? (
            <span>{conversationPage.query ? '没有匹配的真实图谱问答；换个关键词或查看未筛选历史。' : '暂无真实图谱问答历史；完成一次问答后会在这里展示问题、回答和来源。'}</span>
          ) : (
            props.graphConversations?.slice(0, 5).map((conversation) => {
              const assistantMessage = conversation.messages.find((message) => message.role === 'assistant');
              return (
                <div className="timeline-event" key={conversation.id}>
                  <strong>{conversation.title}</strong>
                  <span>{assistantMessage?.content ?? conversation.summary ?? '未生成回答'}</span>
                  <small>{conversation.sessionId ? `Runtime 会话 ${conversation.sessionId}` : '未启动 Runtime 会话'}</small>
                  <div className="task-controls">
                    <button type="button" onClick={() => props.onLoadGraphConversation?.(conversation.id)}>
                      查看详情
                    </button>
                    <button type="button" onClick={() => props.onCreateTaskFromGraphConversation?.(conversation.id)}>
                      从问答创建任务
                    </button>
                    {conversation.archived ? (
                      <button type="button" onClick={() => props.onRestoreGraphConversation?.(conversation.id)}>
                        恢复历史
                      </button>
                    ) : (
                      <button type="button" onClick={() => props.onArchiveGraphConversation?.(conversation.id)}>
                        归档历史
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
          <div className="task-controls" aria-label="图谱问答历史分页">
            <button
              type="button"
              disabled={conversationPage.offset <= 0}
              onClick={() =>
                props.onLoadGraphConversations?.({
                  query: conversationPage.query ?? undefined,
                  offset: previousOffset,
                  archived: conversationPage.archived,
                })
              }
            >
              上一页
            </button>
            <span>{conversationPage.total === 0 ? '第 0-0 条' : `第 ${conversationPage.offset + 1}-${Math.min(conversationPage.total, conversationPage.offset + conversationPage.limit)} 条`}</span>
            <button
              type="button"
              disabled={nextOffset >= conversationPage.total}
              onClick={() =>
                props.onLoadGraphConversations?.({
                  query: conversationPage.query ?? undefined,
                  offset: nextOffset,
                  archived: conversationPage.archived,
                })
              }
            >
              下一页
            </button>
          </div>
          {selectedConversation ? (
            <aside className="graph-conversation-detail" aria-label="图谱问答详情">
              <h4>{selectedConversation.title}</h4>
              <small>
                {selectedConversation.archived ? '已归档' : '未归档'} · {selectedConversation.status}
              </small>
              {selectedConversation.messages.map((message) => (
                <div className="timeline-event" key={message.id}>
                  <strong>{message.role === 'assistant' ? 'AI 回答' : '用户问题'}</strong>
                  <span>{message.content}</span>
                  <small>{message.source}</small>
                </div>
              ))}
            </aside>
          ) : null}
        </section>
      </section>
      {shouldRenderRuntimeGraph ? <GraphRuntimeCanvas nodes={visibleNodes} edges={visibleEdges} layout={props.graphView.layout} /> : null}
      <GraphCanvas nodes={visibleNodes} edges={visibleEdges} layout={props.graphView.layout} />
      <section className="graph-mermaid-preview" aria-label="Mermaid 预览">
        <div className="graph-canvas-header">
          <h3>Mermaid 预览</h3>
          <button type="button" onClick={() => setShowMermaidPreview((current) => !current)}>
            {showMermaidPreview ? '隐藏 Mermaid 源码' : '生成 Mermaid 预览'}
          </button>
          <button
            type="button"
            onClick={async () => {
              const source = buildMermaidDiagramSource({
                viewType: props.graphView.viewType,
                nodes: visibleNodes,
                edges: visibleEdges,
              });
              const exportFile = buildMermaidDiagramExport({
                viewTitle: props.graphView.title,
                viewType: props.graphView.viewType,
                generatedAt: new Date().toISOString(),
                source,
              });
              setLastMermaidExport(exportFile);
              try {
                const saved = props.onExportMermaidDiagramFile ? await props.onExportMermaidDiagramFile(exportFile) : { saved: false, filePath: null };
                setMermaidExportStatus(saved.saved && saved.filePath ? `已保存 Mermaid 源码：${saved.filePath}` : `已生成 Mermaid 源码：${exportFile.fileName}`);
              } catch {
                setMermaidExportStatus('Mermaid 源码保存失败；已保留当前预览文本，可复制后手动保存。');
              }
              setShowMermaidPreview(true);
            }}
          >
            导出 Mermaid 源码
          </button>
        </div>
        {showMermaidPreview ? (
          <pre>
            {buildMermaidDiagramSource({
              viewType: props.graphView.viewType,
              nodes: visibleNodes,
              edges: visibleEdges,
            })}
          </pre>
        ) : (
          <small>基于当前真实可见节点和边生成 Mermaid 文本；不渲染假图，也不引入额外依赖。</small>
        )}
        {lastMermaidExport ? <small>{`已生成 ${lastMermaidExport.fileName} · ${lastMermaidExport.mimeType}`}</small> : null}
        {mermaidExportStatus ? <small>{mermaidExportStatus}</small> : null}
      </section>
      <div className="graph-visibility-toolbar" aria-label="图谱节点显示控制">
        <span>已隐藏 {hiddenNodeIds.length} 个节点</span>
        <button type="button" disabled={hiddenNodeIds.length === 0} onClick={() => setHiddenNodeIds([])}>
          恢复全部节点
        </button>
      </div>
      <div className="graph-node-list" aria-label="图谱节点">
        {visibleNodes.map((node) => {
          if (isAggregatedGraphNode(node)) {
            return (
              <article className="graph-node aggregate" key={node.id}>
                <strong>{node.name}</strong>
                <span>{node.nodeTypes.join(' / ')}</span>
                <small>{`聚合 ${node.aggregateCount} 个真实节点 · ${node.sourceRefs.length} sources`}</small>
              </article>
            );
          }
          const isHidden = hiddenNodeIds.includes(node.id);
          const isMenuOpen = activeNodeMenuId === node.id;
          const nodeActions = buildGraphNodeActionMenu(node, isHidden);
          return (
            <article
              className="graph-node"
              key={node.id}
              onContextMenu={(event) => {
                event.preventDefault();
                setActiveNodeMenuId(node.id);
              }}
            >
              <strong>{node.name}</strong>
              <span>{node.nodeType}</span>
              <small>
                {node.sourceRef}:{String(node.metadata.lineStart ?? '?')}
              </small>
              <button type="button" onClick={() => props.onCreateTaskFromNode?.(node.id)}>
                从节点创建任务
              </button>
              <button
                type="button"
                onClick={() =>
                  props.onOpenGraphSource?.({
                    sourceRef: node.sourceRef,
                    lineStart: typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : undefined,
                  })
                }
              >
                打开源码
              </button>
              <button type="button" aria-pressed={isHidden} onClick={() => toggleNodeVisibility(node.id)}>
                {isHidden ? '恢复节点' : '隐藏节点'}
              </button>
              <button type="button" aria-expanded={isMenuOpen} onClick={() => setActiveNodeMenuId(isMenuOpen ? null : node.id)}>
                打开节点菜单
              </button>
              <div className="graph-node-menu" role="menu" aria-label="节点操作菜单" hidden={!isMenuOpen}>
                {nodeActions.map((action) => (
                  <button key={action.id} type="button" role="menuitem" onClick={() => runNodeAction(node, action)}>
                    {action.label}
                  </button>
                ))}
              </div>
            </article>
          );
        })}
      </div>
      <div className="graph-edge-list" aria-label="图谱边">
        {visibleEdges.map((edge) => (
          <div className="graph-edge" key={edge.id}>
            <strong>{edge.edgeType}</strong>
            <span>{edge.sourceRef}</span>
            {'aggregateCount' in edge && edge.aggregateCount > 1 ? (
              <small>
                聚合 {edge.aggregateCount} 条真实边 · {edge.sourceRefs.length} sources
              </small>
            ) : null}
          </div>
        ))}
      </div>
      {visibleEdges[0] ? <GraphEdgeDetailPanel edge={visibleEdges[0]} graphView={props.graphView} /> : null}
      {selectedGraphNode ? <GraphNodeDetail node={selectedGraphNode} graphView={props.graphView} expandedHopDepth={selectedGraphHopDepth} /> : null}
    </section>
  );
}

export interface GraphNodeActionMenuItem {
  id: 'inspect-detail' | 'create-task' | 'open-source' | 'ask-node' | 'generate-sequence' | 'generate-flow' | 'expand-one-hop' | 'expand-two-hop' | 'toggle-visibility';
  label: string;
  sourceRef: string;
  lineStart: number | null;
}

export function buildGraphNodeActionMenu(node: GraphViewSnapshot['nodes'][number], hidden = false): GraphNodeActionMenuItem[] {
  const lineStart = typeof node.metadata.lineStart === 'number' ? node.metadata.lineStart : null;
  return [
    {
      id: 'inspect-detail',
      label: '查看详情',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'open-source',
      label: '打开源码',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'ask-node',
      label: '提问此节点',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'generate-sequence',
      label: '生成时序图',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'generate-flow',
      label: '生成流程图',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'expand-one-hop',
      label: '展开一跳',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'expand-two-hop',
      label: '展开二跳',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'create-task',
      label: '从节点创建任务',
      sourceRef: node.sourceRef,
      lineStart,
    },
    {
      id: 'toggle-visibility',
      label: hidden ? '恢复节点' : '隐藏节点',
      sourceRef: node.sourceRef,
      lineStart,
    },
  ];
}

export type AggregatedGraphNode = GraphViewSnapshot['nodes'][number] & {
  isAggregate: true;
  aggregateCount: number;
  nodeIds: string[];
  sourceRefs: string[];
  nodeTypes: string[];
};

export type AggregatedGraphEdge = GraphViewSnapshot['edges'][number] & {
  aggregateCount: number;
  sourceRefs: string[];
  edgeIds: string[];
};

export function buildVisibleGraphSlice(input: {
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
  hiddenNodeIds: string[];
  maxNodes: number;
  maxEdges: number;
  showLowConfidenceEdges?: boolean;
  minConfidence?: number;
}): {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: AggregatedGraphEdge[];
} {
  const hiddenNodeIds = new Set(input.hiddenNodeIds);
  const minConfidence = typeof input.minConfidence === 'number' ? normalizeGraphMinConfidence(input.minConfidence, input.showLowConfidenceEdges ? 0 : 1) : input.showLowConfidenceEdges ? 0 : 1;
  const nodes = buildAggregatedGraphNodes(
    input.nodes.filter((node) => !hiddenNodeIds.has(node.id)),
    input.maxNodes,
  );
  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = buildAggregatedGraphEdges(input.edges.filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)).filter((edge) => edge.confidence >= minConfidence)).slice(0, input.maxEdges);
  return { nodes, edges };
}

export function buildGraphQuestionRequest(question: string): {
  question: string;
  canAsk: boolean;
} {
  const normalizedQuestion = question.trim();
  return {
    question: normalizedQuestion,
    canAsk: normalizedQuestion.length > 0,
  };
}

export interface GraphSearchFilterInput {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence: number;
}

export function buildGraphSearchRequest(input: GraphSearchFilterInput): {
  query: string;
  nodeType?: string;
  edgeType?: string;
  minConfidence: number;
} {
  return {
    query: input.query.trim(),
    nodeType: input.nodeType?.trim() || undefined,
    edgeType: input.edgeType?.trim() || undefined,
    minConfidence: normalizeGraphMinConfidence(input.minConfidence, 1),
  };
}

export function normalizeGraphMinConfidence(value: string | number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return Math.min(1, Math.max(0, fallback));
  return Math.min(1, Math.max(0, Math.round(parsed * 100) / 100));
}

export function isAggregatedGraphNode(node: GraphViewSnapshot['nodes'][number] | AggregatedGraphNode): node is AggregatedGraphNode {
  return 'isAggregate' in node && node.isAggregate === true;
}

export function buildAggregatedGraphNodes(nodes: GraphViewSnapshot['nodes'], maxNodes: number): Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode> {
  const safeMaxNodes = Math.max(1, maxNodes);
  if (nodes.length <= safeMaxNodes) return nodes;
  const concreteNodeCount = Math.max(0, safeMaxNodes - 1);
  const concreteNodes = nodes.slice(0, concreteNodeCount);
  const overflowNodes = nodes.slice(concreteNodeCount);
  const sourceRefs = [...new Set(overflowNodes.map((node) => node.sourceRef))];
  const nodeTypes = [...new Set(overflowNodes.map((node) => node.nodeType))];
  const nodeIds = overflowNodes.map((node) => node.id);
  const firstOverflow = overflowNodes[0];
  // 聚合节点只表达前端可见切片的压缩摘要，不写回图谱事实库。
  const aggregateNode: AggregatedGraphNode = {
    id: `aggregate_nodes_${nodeIds.join('_')}`,
    nodeType: 'aggregate',
    name: `聚合 ${overflowNodes.length} 个节点`,
    qualifiedName: `聚合节点：${nodeIds.join(',')}`,
    sourceRef: firstOverflow?.sourceRef ?? '',
    symbolId: `aggregate_symbols_${nodeIds.join('_')}`,
    metadata: {
      aggregateCount: overflowNodes.length,
      nodeIds,
      sourceRefs,
      nodeTypes,
    },
    isAggregate: true,
    aggregateCount: overflowNodes.length,
    nodeIds,
    sourceRefs,
    nodeTypes,
  };
  return [...concreteNodes, aggregateNode];
}

export function buildAggregatedGraphEdges(edges: GraphViewSnapshot['edges']): AggregatedGraphEdge[] {
  const groups = new Map<string, AggregatedGraphEdge>();
  for (const edge of edges) {
    const key = `${edge.sourceNodeId}::${edge.targetNodeId}::${edge.edgeType}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        ...edge,
        aggregateCount: 1,
        sourceRefs: [edge.sourceRef],
        edgeIds: [edge.id],
      });
      continue;
    }
    current.aggregateCount += 1;
    current.edgeIds.push(edge.id);
    if (!current.sourceRefs.includes(edge.sourceRef)) current.sourceRefs.push(edge.sourceRef);
    current.confidence = Math.round(((current.confidence * (current.aggregateCount - 1) + edge.confidence) / current.aggregateCount) * 100) / 100;
  }
  return [...groups.values()];
}

function RuntimeXtermPane(props: { logs: AiRuntimeLogEntry[]; enabled: boolean }) {
  const terminalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!props.enabled || !terminalRef.current || typeof window === 'undefined') return;
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    void import('@xterm/xterm').then(({ Terminal }) => {
      if (disposed || !terminalRef.current) return;
      // xterm 只负责渲染已采集的真实 Runtime 日志；输入、resize、Ctrl-C 仍走后端审计 API。
      terminal = new Terminal({
        convertEol: true,
        cursorBlink: false,
        disableStdin: true,
        rows: 10,
        cols: 120,
        theme: { background: '#0f172a', foreground: '#dbeafe' },
      });
      terminal.open(terminalRef.current);
      for (const entry of props.logs.slice(-80)) terminal.writeln(formatRuntimeLogLine(entry));
    });
    return () => {
      disposed = true;
      terminal?.dispose();
    };
  }, [props.enabled, props.logs]);

  if (!props.enabled) return null;
  return <div className="xterm-runtime-pane" aria-label="xterm Runtime 终端" ref={terminalRef} />;
}

type SigmaRendererInstance = { kill: () => void };
type GraphologyGraphInstance = {
  addNode: (key: string, attributes?: Record<string, unknown>) => void;
  addDirectedEdgeWithKey: (key: string, source: string, target: string, attributes?: Record<string, unknown>) => void;
};
type GraphologyGraphConstructor = new () => GraphologyGraphInstance;
type SigmaRendererConstructor = new (graph: GraphologyGraphInstance, container: HTMLElement, settings?: Record<string, unknown>) => SigmaRendererInstance;

export interface SigmaRuntimeGraphNode {
  key: string;
  attributes: {
    label: string;
    type: string;
    nodeType: string;
    sourceRef: string;
    x: number;
    y: number;
    size: number;
    color: string;
  };
}

export interface SigmaRuntimeGraph {
  nodes: SigmaRuntimeGraphNode[];
  edges: ReturnType<typeof toSigmaGraph>['edges'];
}

export function buildSigmaRuntimeGraph(input: {
  nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>;
  edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>;
  layout?: GraphViewSnapshot['layout'];
}): SigmaRuntimeGraph {
  const baseGraph = toSigmaGraph({ nodes: input.nodes, edges: input.edges });
  const width = normalizeGraphCanvasDimension(input.layout?.width, 720, 1440);
  const height = normalizeGraphCanvasDimension(input.layout?.height, 300, 900);
  const layout = buildGraphCanvasLayout(input.nodes, width, height, input.layout);

  return {
    ...baseGraph,
    nodes: baseGraph.nodes.map((node) => {
      const point = layout.get(node.key) ?? {
        x: Math.round(width / 2),
        y: Math.round(height / 2),
      };
      const nodeType = node.attributes.type;
      return {
        ...node,
        attributes: {
          ...node.attributes,
          type: 'circle',
          nodeType,
          // Sigma/WebGL 运行时要求 x/y 是真实数值；这里复用服务端布局或确定性前端布局，不生成演示节点。
          x: point.x,
          y: point.y,
          size: nodeType === 'aggregate' ? 11 : 8,
          color: sigmaNodeColor(nodeType),
        },
      };
    }),
  };
}

function sigmaNodeColor(nodeType: string): string {
  switch (nodeType) {
    case 'api':
      return '#4f46e5';
    case 'table':
    case 'column':
      return '#0f766e';
    case 'function':
      return '#7c3aed';
    case 'aggregate':
      return '#64748b';
    default:
      return '#2563eb';
  }
}

function GraphRuntimeCanvas(props: { nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>; edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>; layout?: GraphViewSnapshot['layout'] }) {
  const sigmaContainerRef = useRef<HTMLDivElement | null>(null);
  const reactFlowContainerRef = useRef<HTMLDivElement | null>(null);
  const sigmaGraph = useMemo(
    () =>
      buildSigmaRuntimeGraph({
        nodes: props.nodes,
        edges: props.edges,
        layout: props.layout,
      }),
    [props.nodes, props.edges, props.layout],
  );
  const reactFlowElements = useMemo(() => toReactFlowElements({ nodes: props.nodes, edges: props.edges }), [props.nodes, props.edges]);

  useEffect(() => {
    if (!sigmaContainerRef.current || props.nodes.length === 0 || typeof window === 'undefined') return undefined;
    let disposed = false;
    let sigmaRenderer: SigmaRendererInstance | undefined;

    void (async () => {
      const [{ default: Graph }, { default: Sigma }] = await Promise.all([
        import('graphology') as unknown as Promise<{
          default: GraphologyGraphConstructor;
        }>,
        import('sigma') as unknown as Promise<{
          default: SigmaRendererConstructor;
        }>,
        // 动态加载 React Flow 运行时，避免服务端静态渲染时访问浏览器 API。
        import('@xyflow/react'),
      ]);
      if (disposed || !sigmaContainerRef.current) return;
      const graph = new Graph();
      for (const node of sigmaGraph.nodes) graph.addNode(node.key, node.attributes);
      for (const edge of sigmaGraph.edges) graph.addDirectedEdgeWithKey(edge.key, edge.source, edge.target, edge.attributes);
      // Sigma/WebGL 只渲染真实转换后的 Graphology 图，不补造空节点或演示边。
      sigmaRenderer = new Sigma(graph, sigmaContainerRef.current, {
        renderEdgeLabels: false,
        labelRenderedSizeThreshold: 12,
        allowInvalidContainer: true,
      });
      if (reactFlowContainerRef.current) reactFlowContainerRef.current.dataset.runtimeReady = 'true';
    })();

    return () => {
      disposed = true;
      sigmaRenderer?.kill();
    };
  }, [props.nodes.length, sigmaGraph]);

  if (props.nodes.length === 0) {
    return (
      <section className="graph-runtime-canvas" aria-label="图谱运行时">
        <article className="graph-runtime-pane" aria-label="Sigma WebGL 大图">
          <h3>Sigma WebGL 大图</h3>
          <p>当前没有真实节点，WebGL 运行时保持空态。</p>
        </article>
        <article className="graph-runtime-pane" aria-label="React Flow 局部图">
          <h3>React Flow 局部图</h3>
          <p>当前没有真实局部图节点。</p>
        </article>
      </section>
    );
  }

  return (
    <section className="graph-runtime-canvas" aria-label="图谱运行时">
      <article className="graph-runtime-pane" aria-label="Sigma WebGL 大图">
        <div className="graph-canvas-header">
          <h3>Sigma WebGL 大图</h3>
          <span>
            {sigmaGraph.nodes.length} nodes · {sigmaGraph.edges.length} edges
          </span>
        </div>
        <div className="graph-runtime-mount" data-runtime="sigma" ref={sigmaContainerRef} />
        <div className="graph-runtime-facts" aria-label="Sigma 图谱真实来源">
          {sigmaGraph.nodes.slice(0, 4).map((node) => (
            <span key={node.key}>{node.attributes.label}</span>
          ))}
          {sigmaGraph.edges.slice(0, 3).map((edge) => (
            <small key={edge.key}>
              {edge.attributes.label} {edge.attributes.confidence.toFixed(2)}
            </small>
          ))}
        </div>
      </article>
      <article className="graph-runtime-pane" aria-label="React Flow 局部图">
        <div className="graph-canvas-header">
          <h3>React Flow 局部图</h3>
          <span>
            {reactFlowElements.nodes.length} nodes · {reactFlowElements.edges.length} edges
          </span>
        </div>
        <div className="graph-runtime-mount" data-runtime="react-flow" ref={reactFlowContainerRef}>
          {reactFlowElements.nodes.slice(0, 5).map((node) => (
            <div className="react-flow-node-summary" key={node.id}>
              <strong>{node.data.label}</strong>
              <span>{node.type}</span>
              <small>{node.data.sourceRef}</small>
            </div>
          ))}
        </div>
        <div className="graph-runtime-facts" aria-label="React Flow 真实边">
          {reactFlowElements.edges.slice(0, 4).map((edge) => (
            <small key={edge.id}>{edge.label}</small>
          ))}
        </div>
      </article>
    </section>
  );
}

function GraphCanvas(props: { nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>; edges: Array<GraphViewSnapshot['edges'][number] | AggregatedGraphEdge>; layout?: GraphViewSnapshot['layout'] }) {
  const width = normalizeGraphCanvasDimension(props.layout?.width, 720, 1440);
  const height = normalizeGraphCanvasDimension(props.layout?.height, 300, 900);
  const layout = buildGraphCanvasLayout(props.nodes, width, height, props.layout);
  const visibleNodeIds = new Set(props.nodes.map((node) => node.id));
  const visibleEdges = buildAggregatedGraphEdges(props.edges.filter((edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)));

  if (props.nodes.length === 0) {
    return (
      <section className="graph-canvas" aria-label="代码图谱画布">
        <h3>代码图谱画布</h3>
        <p>当前筛选没有真实节点；调整搜索条件后会展示由源码扫描生成的节点和边。</p>
      </section>
    );
  }

  return (
    <section className="graph-canvas" aria-label="代码图谱画布">
      <div className="graph-canvas-header">
        <h3>代码图谱画布</h3>
        <span>
          {props.nodes.length} nodes · {visibleEdges.length} 聚合边
          {props.layout ? ` · 服务端布局 ${props.layout.algorithm}` : ''}
        </span>
      </div>
      <svg className="graph-canvas-svg" role="img" aria-label="代码图谱画布" viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <marker id="graph-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M 0 0 L 8 4 L 0 8 z" />
          </marker>
        </defs>
        {visibleEdges.map((edge) => {
          const source = layout.get(edge.sourceNodeId);
          const target = layout.get(edge.targetNodeId);
          if (!source || !target) return null;
          const labelX = (source.x + target.x) / 2;
          const labelY = (source.y + target.y) / 2 - 8;
          return (
            <g className="graph-canvas-edge" key={edge.id}>
              <line x1={source.x} y1={source.y} x2={target.x} y2={target.y} markerEnd="url(#graph-arrow)" />
              <text x={labelX} y={labelY}>
                {edge.edgeType} {edge.confidence.toFixed(2)}
                {edge.aggregateCount > 1 ? ` · ${edge.aggregateCount} sources` : ''}
              </text>
            </g>
          );
        })}
        {props.nodes.map((node) => {
          const point = layout.get(node.id);
          if (!point) return null;
          return (
            <g className={`graph-canvas-node ${node.nodeType}`} key={node.id} transform={`translate(${point.x} ${point.y})`}>
              <circle r="24" />
              <text className="graph-canvas-node-name" x="0" y="-32">
                {node.name}
              </text>
              <text className="graph-canvas-node-type" x="0" y="42">
                {node.nodeType}
              </text>
              <title>{`${node.qualifiedName} · ${node.sourceRef}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="graph-canvas-sources" aria-label="画布源码来源">
        {props.nodes.slice(0, 4).map((node) => (
          <span key={node.id}>{node.sourceRef}</span>
        ))}
      </div>
    </section>
  );
}

function buildGraphCanvasLayout(nodes: Array<GraphViewSnapshot['nodes'][number] | AggregatedGraphNode>, width: number, height: number, serverLayout?: GraphViewSnapshot['layout']) {
  const layout = new Map<string, { x: number; y: number }>();
  const serverPositions = new Map((serverLayout?.positions ?? []).map((position) => [position.nodeId, { x: position.x, y: position.y }]));
  const centerX = width / 2;
  const centerY = height / 2;
  const radiusX = Math.max(190, width / 2 - 96);
  const radiusY = Math.max(72, height / 2 - 64);

  nodes.forEach((node, index) => {
    const serverPosition = serverPositions.get(node.id);
    if (serverPosition) {
      // 服务端在超大图谱下会给出真实全局坐标；桌面画布只消费压缩后的视窗坐标，避免 macOS 窗口被几万像素的 SVG/WebGL 画布撑开。
      layout.set(node.id, normalizeServerGraphPosition(serverPosition, serverLayout, width, height));
      return;
    }
    // 使用确定性椭圆布局，避免服务端渲染与前端渲染产生随机差异。
    const angle = nodes.length === 1 ? -Math.PI / 2 : -Math.PI / 2 + (index / nodes.length) * Math.PI * 2;
    layout.set(node.id, {
      x: Math.round(centerX + Math.cos(angle) * radiusX),
      y: Math.round(centerY + Math.sin(angle) * radiusY),
    });
  });

  return layout;
}

function normalizeGraphCanvasDimension(value: number | undefined, fallback: number, maxDesktopSize: number) {
  if (!Number.isFinite(value) || !value || value <= 0) return fallback;
  const rounded = Math.round(value);
  return rounded > maxDesktopSize * 2 ? maxDesktopSize : Math.max(fallback, rounded);
}

function normalizeServerGraphPosition(position: { x: number; y: number }, serverLayout: GraphViewSnapshot['layout'] | undefined, width: number, height: number) {
  if (!serverLayout || (serverLayout.width === width && serverLayout.height === height)) return position;
  const serverWidth = Number.isFinite(serverLayout.width) && serverLayout.width > 0 ? serverLayout.width : width;
  const serverHeight = Number.isFinite(serverLayout.height) && serverLayout.height > 0 ? serverLayout.height : height;
  const insetX = Math.min(72, Math.max(24, width * 0.06));
  const insetY = Math.min(64, Math.max(24, height * 0.07));
  const usableWidth = Math.max(1, width - insetX * 2);
  const usableHeight = Math.max(1, height - insetY * 2);
  const x = Math.min(serverWidth, Math.max(0, position.x));
  const y = Math.min(serverHeight, Math.max(0, position.y));

  return {
    x: Math.round(insetX + (x / serverWidth) * usableWidth),
    y: Math.round(insetY + (y / serverHeight) * usableHeight),
  };
}

function GraphNodeDetail(props: { node: GraphViewSnapshot['nodes'][number]; graphView: GraphViewSnapshot; expandedHopDepth?: 1 | 2 }) {
  const recentTasks = Array.isArray(props.node.metadata.recentTasks) ? props.node.metadata.recentTasks : [];
  const riskTags = Array.isArray(props.node.metadata.riskTags) ? props.node.metadata.riskTags.filter((tag): tag is string => typeof tag === 'string') : [];
  const aiSummary = typeof props.node.metadata.aiSummary === 'string' && props.node.metadata.aiSummary.trim() ? props.node.metadata.aiSummary.trim() : null;
  const oneHopEdges = props.graphView.edges.filter((edge) => edge.sourceNodeId === props.node.id || edge.targetNodeId === props.node.id);
  const oneHopNodeIds = Array.from(new Set(oneHopEdges.flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId]).filter((id) => id !== props.node.id)));
  const oneHopNodes = oneHopNodeIds.map((id) => props.graphView.nodes.find((node) => node.id === id)).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  const twoHopNodeIds = Array.from(
    new Set(
      props.graphView.edges
        .filter((edge) => oneHopNodeIds.includes(edge.sourceNodeId) || oneHopNodeIds.includes(edge.targetNodeId))
        .flatMap((edge) => [edge.sourceNodeId, edge.targetNodeId])
        .filter((id) => id !== props.node.id && !oneHopNodeIds.includes(id)),
    ),
  );
  const twoHopNodes = twoHopNodeIds.map((id) => props.graphView.nodes.find((node) => node.id === id)).filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return (
    <aside className="graph-detail" aria-label="节点详情">
      <strong>节点详情</strong>
      <span>{props.node.qualifiedName}</span>
      <small>
        {props.node.sourceRef} · {String(props.node.metadata.lineStart ?? '?')}-{String(props.node.metadata.lineEnd ?? '?')}
      </small>
      {aiSummary ? (
        <div className="graph-ai-summary" aria-label="AI 摘要">
          <strong>AI 摘要</strong>
          <span>{aiSummary}</span>
        </div>
      ) : null}
      {recentTasks.length > 0 ? (
        <div className="graph-recent-tasks" aria-label="最近任务">
          <strong>最近任务</strong>
          {recentTasks.slice(0, 3).map((task, index) => {
            const taskRecord = task as {
              taskId?: string;
              title?: string;
              status?: string;
            };
            return (
              <span key={taskRecord.taskId ?? index}>
                {taskRecord.title ?? '未命名任务'} · {taskRecord.status ?? 'unknown'}
              </span>
            );
          })}
        </div>
      ) : null}
      {oneHopNodes.length > 0 ? (
        <div className="graph-neighborhood" aria-label="一跳邻居">
          <strong>一跳邻居</strong>
          {oneHopNodes.slice(0, 4).map((node) => (
            <span key={node.id}>
              {node.name} · {node.nodeType}
            </span>
          ))}
        </div>
      ) : null}
      {twoHopNodes.length > 0 ? (
        <div className="graph-neighborhood" aria-label="二跳影响范围" hidden={(props.expandedHopDepth ?? 1) < 2}>
          <strong>二跳影响范围</strong>
          {twoHopNodes.slice(0, 4).map((node) => (
            <span key={node.id}>
              {node.name} · {node.nodeType}
            </span>
          ))}
        </div>
      ) : null}
      {riskTags.length > 0 ? (
        <div className="graph-risk-tags" aria-label="风险标签">
          {riskTags.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function GraphEdgeDetailPanel(props: { edge: GraphViewSnapshot['edges'][number]; graphView: GraphViewSnapshot }) {
  const source = props.graphView.nodes.find((node) => node.id === props.edge.sourceNodeId);
  const target = props.graphView.nodes.find((node) => node.id === props.edge.targetNodeId);
  return (
    <aside className="graph-edge-detail" aria-label="边详情">
      <strong>边详情</strong>
      <span>
        {props.edge.edgeType} · confidence {props.edge.confidence}
      </span>
      <small>
        {source?.name ?? props.edge.sourceNodeId} → {target?.name ?? props.edge.targetNodeId}
      </small>
      <small>{props.edge.sourceRef}</small>
    </aside>
  );
}

function SidebarNav(props: { activeNavTarget: WorkspaceViewId; onNavigate: (target: WorkspaceViewId) => void }) {
  return (
    <aside className="zeus-sidebar ai-sidebar" aria-label="主导航">
      <div className="sidebar-product-mark" aria-label="Zeus">
        <strong>Zeus</strong>
      </div>
      <nav aria-label="主要导航">
        {sidebarGroups.map((group) => (
          <section className={`nav-group nav-group-${group.placement}`} key={group.id}>
            {group.items.map((item) => (
              <a
                key={item.target}
                className={item.target === props.activeNavTarget ? 'active' : ''}
                href={`#${item.target}`}
                onClick={(event) => {
                  event.preventDefault();
                  props.onNavigate(item.target);
                }}
              >
                <strong>{item.label}</strong>
              </a>
            ))}
          </section>
        ))}
      </nav>
    </aside>
  );
}

function EmptyPrompt(props: { title: string; body: string; actions: EmptyPromptAction[] }) {
  return (
    <section className="empty-prompt" aria-label={props.title}>
      <strong>{props.title}</strong>
      {props.actions.length > 0 ? (
        <div className="prompt-actions">
          {props.actions.map((action) => (
            <button key={action.label} type="button" onClick={action.onAction} disabled={action.disabled}>
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function formatRuntimeDefaultArgs(args: string[]): string {
  return args.join(' ');
}

function formatRuntimeAdapterDetectionFacts(adapter: AiRuntimeAdapterDescriptor, status?: AiRuntimeAdapterStatus): string {
  if (!status) return `能力：${adapter.capabilities.join(' / ')}`;
  // Adapter 检测字段直接来自真实探测结果；未读取时明确展示未知，不把外部 CLI 可用性推断成已登录。
  return [
    `版本：${status.version ?? '未读取'}`,
    `登录状态：${formatAdapterAuthStatus(status.authStatus)}`,
    `模型配置：${status.modelConfiguration === 'user-configured' ? '用户配置' : status.modelConfiguration}`,
    `能力：${status.capabilities.join(' / ')}`,
  ].join(' · ');
}

function formatAdapterAuthStatus(status: AiRuntimeAdapterStatus['authStatus']): string {
  if (status === 'authenticated') return '已认证';
  if (status === 'unauthenticated') return '未登录';
  return '未知';
}

function parseRuntimeDefaultArgsText(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 16);
}

function formatRuntimeTerminalEnv(env: RuntimeSettings['terminalEnv']): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

interface ProjectConfigFormState {
  defaultModel: string;
  defaultWorkMode: ProjectConfig['defaultWorkMode'];
  defaultTaskPrompt: string;
  scanIgnoreDirectories: string;
  indexScope: ProjectConfig['scan']['indexScope'];
  languagePrimary: string;
  languageAdditional: string;
  packageManagers: string;
  manifestPaths: string;
  databaseConnectionName: string;
  databaseSchemaPaths: string;
  telegramAlias: string;
  allowShell: boolean;
  allowGitWrite: boolean;
}

function normalizeProjectConfig(config?: Partial<ProjectConfig>, projectId?: string): ProjectConfig | undefined {
  const resolvedProjectId = config?.projectId ?? projectId;
  if (!resolvedProjectId) return undefined;
  return {
    projectId: resolvedProjectId,
    defaultModel: config?.defaultModel ?? null,
    defaultWorkMode: config?.defaultWorkMode ?? 'plan',
    defaultTaskPrompt: config?.defaultTaskPrompt ?? '',
    scan: {
      ignoreDirectories: config?.scan?.ignoreDirectories ?? ['node_modules', 'dist', '.tmp', 'coverage'],
      indexScope: config?.scan?.indexScope ?? 'project',
    },
    language: {
      primary: config?.language?.primary ?? 'typescript',
      additional: config?.language?.additional ?? [],
    },
    dependencies: {
      packageManagers: config?.dependencies?.packageManagers ?? [],
      manifestPaths: config?.dependencies?.manifestPaths ?? [],
    },
    vcs: {
      isGitRepository: config?.vcs?.isGitRepository ?? false,
      gitRoot: config?.vcs?.gitRoot ?? null,
    },
    database: {
      connectionName: config?.database?.connectionName ?? null,
      schemaPaths: config?.database?.schemaPaths ?? [],
    },
    telegram: {
      alias: config?.telegram?.alias ?? null,
    },
    security: {
      allowShell: config?.security?.allowShell ?? false,
      allowGitWrite: config?.security?.allowGitWrite ?? false,
    },
  };
}

function toProjectConfigForm(config?: ProjectConfig): ProjectConfigFormState {
  const normalized = normalizeProjectConfig(config, config?.projectId) ?? {
    projectId: '',
    defaultModel: null,
    defaultWorkMode: 'plan',
    defaultTaskPrompt: '',
    scan: {
      ignoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
      indexScope: 'project',
    },
    language: { primary: 'typescript', additional: [] },
    dependencies: { packageManagers: [], manifestPaths: [] },
    vcs: { isGitRepository: false, gitRoot: null },
    database: { connectionName: null, schemaPaths: [] },
    telegram: { alias: null },
    security: { allowShell: false, allowGitWrite: false },
  };
  return {
    defaultModel: normalized.defaultModel ?? '',
    defaultWorkMode: normalized.defaultWorkMode,
    defaultTaskPrompt: normalized.defaultTaskPrompt,
    scanIgnoreDirectories: normalized.scan.ignoreDirectories.join(', '),
    indexScope: normalized.scan.indexScope,
    languagePrimary: normalized.language.primary,
    languageAdditional: normalized.language.additional.join(', '),
    packageManagers: normalized.dependencies.packageManagers.join(', '),
    manifestPaths: normalized.dependencies.manifestPaths.join(', '),
    databaseConnectionName: redactDatabaseConnectionName(normalized.database.connectionName),
    databaseSchemaPaths: normalized.database.schemaPaths.join(', '),
    telegramAlias: normalized.telegram.alias ?? '',
    allowShell: normalized.security.allowShell,
    allowGitWrite: normalized.security.allowGitWrite,
  };
}

function parseProjectConfigList(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !item.includes('..'))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function parseNumericList(text: string): number[] {
  const seen = new Set<number>();
  return text
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

function formatProjectLanguage(form: ProjectConfigFormState): string {
  const additional = parseProjectConfigList(form.languageAdditional);
  return [form.languagePrimary.trim() || 'typescript', ...additional].join(' + ');
}

function formatProjectDependencies(form: ProjectConfigFormState): string {
  const managers = parseProjectConfigList(form.packageManagers).join(', ') || '未设置包管理器';
  const manifests = parseProjectConfigList(form.manifestPaths).join(', ') || '未设置清单路径';
  return `${managers} · ${manifests}`;
}

function formatProjectDatabase(form: ProjectConfigFormState): string {
  const connectionName = redactDatabaseConnectionName(form.databaseConnectionName) || '未设置连接名';
  const schemaPaths = parseProjectConfigList(form.databaseSchemaPaths).join(', ') || '未设置 Schema 路径';
  return `${connectionName} · ${schemaPaths}`;
}

function formatProjectDatabaseHelp(form: ProjectConfigFormState): string {
  return isExternalDatabaseUri(form.databaseConnectionName)
    ? '外部数据库驱动待接入；请把密码保存到 Keychain 密码字段，连接名显示会自动脱敏，不会声明远程 schema 已读取。'
    : '配置的真实 DDL/SQL 文件会在 src 扫描范围外并入代码图谱；连接名不是凭据。';
}

function isExternalDatabaseUri(value: string | null | undefined): boolean {
  return /^(?:postgresql?|mysql|mariadb):/iu.test(value?.trim() ?? '');
}

function redactDatabaseConnectionName(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!isExternalDatabaseUri(text)) return text;
  try {
    const url = new URL(text);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    // URI 格式异常时仍要避免 user:password@ 片段直接出现在界面。
    return text.replace(/(:\/\/[^:@\s]+):[^@\s]+@/u, '$1:***@');
  }
}

function normalizeLocalUiError(error?: LocalUiErrorSnapshot): LocalUiErrorSnapshot | undefined {
  if (!error) return undefined;
  return {
    action: error.action.trim() || 'renderer-action',
    message: redactLocalUiErrorMessage(error.message),
    occurredAt: error.occurredAt.trim() || new Date(0).toISOString(),
  };
}

function errorToLocalUiMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '本地操作失败，详情请查看本地日志目录。';
}

function redactLocalUiErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [REDACTED]')
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s;&]+)/giu, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, '[REDACTED]');
}

function normalizeRuntimeSettings(settings?: Partial<RuntimeSettings>): RuntimeSettings {
  const defaultSettings: RuntimeSettings = {
    defaultAdapterId: 'codex',
    adapterModels: {},
    adapterDefaultArgs: {},
    adapterCliPaths: {},
    terminalEnv: {},
    shell: { path: null, login: false },
    concurrency: { maxPerProject: 1, maxGlobal: 2 },
    executionTimeoutSeconds: 3600,
    logRetentionDays: 30,
    autoConfirmationPolicy: 'never',
  };
  const maxPerProject = normalizeRuntimeSettingNumber(String(settings?.concurrency?.maxPerProject ?? defaultSettings.concurrency.maxPerProject), defaultSettings.concurrency.maxPerProject);
  const maxGlobal = Math.max(normalizeRuntimeSettingNumber(String(settings?.concurrency?.maxGlobal ?? defaultSettings.concurrency.maxGlobal), defaultSettings.concurrency.maxGlobal), maxPerProject);
  return {
    ...defaultSettings,
    ...settings,
    adapterModels: settings?.adapterModels ?? defaultSettings.adapterModels,
    adapterDefaultArgs: settings?.adapterDefaultArgs ?? defaultSettings.adapterDefaultArgs,
    adapterCliPaths: settings?.adapterCliPaths ?? defaultSettings.adapterCliPaths,
    terminalEnv: settings?.terminalEnv ?? defaultSettings.terminalEnv,
    shell: { ...defaultSettings.shell, ...settings?.shell },
    concurrency: { maxPerProject, maxGlobal },
  };
}

function normalizeCodeMapSettings(settings?: Partial<CodeMapSettings>): CodeMapSettings {
  const defaultSettings: CodeMapSettings = {
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
  return {
    ...defaultSettings,
    ...settings,
    defaultIgnoreDirectories: Array.isArray(settings?.defaultIgnoreDirectories) ? settings.defaultIgnoreDirectories : defaultSettings.defaultIgnoreDirectories,
    maxCallChainDepth: typeof settings?.maxCallChainDepth === 'number' ? settings.maxCallChainDepth : defaultSettings.maxCallChainDepth,
    moduleFlowManualNotes: typeof settings?.moduleFlowManualNotes === 'string' ? settings.moduleFlowManualNotes : defaultSettings.moduleFlowManualNotes,
  };
}

function parseRuntimeTerminalEnvText(text: string): RuntimeSettings['terminalEnv'] {
  const env: RuntimeSettings['terminalEnv'] = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    const name = key.trim();
    const value = valueParts.join('=').trim();
    // 只保存明确的键值对，避免把空变量写进真实 Runtime 子进程环境。
    if (!name || !value) continue;
    env[name] = value;
  }
  return env;
}

export function resolveRuntimeNormalizedLogPath(events: AiRuntimeTerminalEvent[]): string | undefined {
  const chunkPath = events.find((event) => event.rawChunkPath?.includes('/chunks/'))?.rawChunkPath;
  if (!chunkPath) return undefined;
  return chunkPath.replace(/\/chunks\/[^/]+$/u, '/terminal.normalized.log');
}

function normalizeRuntimeSettingNumber(value: string, fallback: number, max = 20): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}

function LocalClientNotice(props: { status: LocalClientStatus; error?: string }) {
  const failed = props.status === 'failed';
  return (
    <section className={`client-status ${failed ? 'failed' : 'connecting'}`} aria-label="本地服务连接状态">
      <strong>{failed ? '本地服务连接失败' : '正在连接本地服务'}</strong>
      {props.error ? <em>{props.error}</em> : null}
    </section>
  );
}
