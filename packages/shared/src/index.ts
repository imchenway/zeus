/** Zeus 任务状态：只描述真实任务生命周期，不承载任何示例或 mock 业务数据。 */
export * from './taskPush.js';
export * from './codexUsage.js';
export * from './commandEnvelope.js';
export * from './commandGovernance.js';
export * from './executionHostStopCommand.js';
export * from './readOnlyValidation.js';
export * from './conversationDispatchWire.js';
export * from './conversationSnapshotV2Wire.js';
export * from './im.js';
export * from './skillIdentity.js';

export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

/** 任务优先级只表达处理顺序；P0 不会隐式启动任务或 AI 会话。 */
export const taskPriorityOrder = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;

export type TaskPriority = (typeof taskPriorityOrder)[number];

/** 任务附件只能归属到可接收资源的内容字段，标题不在此集合中。 */
export const taskAttachmentFieldOrder = ['description', 'defectCurrentState', 'defectExpectedOutcome', 'defectReproductionSteps', 'optimizationCurrentState', 'optimizationExpectedOutcome', 'tags'] as const;

export type TaskAttachmentField = (typeof taskAttachmentFieldOrder)[number];

export function isTaskAttachmentField(value: unknown): value is TaskAttachmentField {
  return typeof value === 'string' && taskAttachmentFieldOrder.includes(value as TaskAttachmentField);
}

/** 任务附件关联只保存可持久化元数据；预览内容与可恢复正文不进入任务记录。 */
export interface TaskAttachmentReference {
  path: string;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  field: TaskAttachmentField;
  mimeType?: string;
  size?: number;
  characterCount?: number;
}

/** 对 API 输入做统一优先级校验，拒绝把任意字符串写入新任务。 */
export function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && taskPriorityOrder.includes(value as TaskPriority);
}

/** 任务类型只表达工作目标；不会改变任务状态、优先级或执行方式。 */
export const taskTypeOrder = ['requirement', 'defect', 'optimization'] as const;

export type TaskType = (typeof taskTypeOrder)[number];

/** 对 API、导入数据和数据库回填值做统一任务类型校验。 */
export function isTaskType(value: unknown): value is TaskType {
  return typeof value === 'string' && taskTypeOrder.includes(value as TaskType);
}

const taskCommitPrefixByType: Record<TaskType, 'feat' | 'fix' | 'perf'> = {
  requirement: 'feat',
  defect: 'fix',
  optimization: 'perf',
};

/** 根据任务类型生成可编辑的任务提交说明建议值，不用于代码交付合入提交。 */
export function buildTaskCommitMessageSuggestion(input: { taskType: TaskType; taskCode: string; taskTitle: string }): string {
  return `${taskCommitPrefixByType[input.taskType]}: ${input.taskCode.trim()} ${input.taskTitle.trim()}`;
}

/** 项目管理阶段与 Coding Agent 执行状态严格分离；状态标识由项目配置持有，不再限制为固定联合类型。 */
export type TaskManagementStatus = string;

/** 旧项目与新项目默认模板继续沿用现有七个状态，保存行为兼容且不改变用户已有任务。 */
export const taskManagementStatusOrder = ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'] as const;

export interface TaskManagementStatusDefinition {
  id: TaskManagementStatus;
  /** null 表示继续使用 Zeus 随语言切换的默认文案；用户改名后保存真实输入。 */
  label: string | null;
  /** 用户选择的单一主色；各主题下的文字、边框和浅底由界面自动派生。 */
  color: string;
}

export interface TaskManagementStatusRoles {
  defaultStatusId: TaskManagementStatus;
  pushedStatusId: TaskManagementStatus;
  completedStatusId: TaskManagementStatus;
  cancelledStatusId: TaskManagementStatus;
}

export interface TaskManagementStatusConfig {
  statuses: TaskManagementStatusDefinition[];
  roles: TaskManagementStatusRoles;
}

const defaultTaskManagementStatusColors: Record<(typeof taskManagementStatusOrder)[number], string> = {
  todo: '#6b7280',
  in_development: '#3b82f6',
  in_testing: '#8b5cf6',
  awaiting_acceptance: '#d97706',
  blocked: '#dc2626',
  completed: '#16a34a',
  cancelled: '#6b7280',
};

/** 全局模板的初始值只负责兼容现有行为；复制到项目后，每个状态都可以平等增删改。 */
export const defaultTaskManagementStatusConfig: TaskManagementStatusConfig = {
  statuses: taskManagementStatusOrder.map((id) => ({ id, label: null, color: defaultTaskManagementStatusColors[id] })),
  roles: {
    defaultStatusId: 'todo',
    pushedStatusId: 'in_development',
    completedStatusId: 'completed',
    cancelledStatusId: 'cancelled',
  },
};

const taskManagementStatusIdPattern = /^[a-z][a-z0-9_-]{0,63}$/u;
const taskManagementStatusColorPattern = /^#[0-9a-f]{6}$/iu;

/** 对 API、导入文件和数据库回填值做统一标识校验；合法项目状态不再依赖固定名称。 */
export function isTaskManagementStatus(value: unknown): value is TaskManagementStatus {
  return typeof value === 'string' && taskManagementStatusIdPattern.test(value);
}

/** 设置导入和服务端保存共用同一归一化规则，避免项目状态集合在不同入口发生漂移。 */
export function normalizeTaskManagementStatusConfig(value: unknown, fallback: TaskManagementStatusConfig = defaultTaskManagementStatusConfig): TaskManagementStatusConfig {
  const normalizedFallback = cloneTaskManagementStatusConfig(fallback);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalizedFallback;
  const input = value as Partial<TaskManagementStatusConfig>;
  if (!Array.isArray(input.statuses)) return normalizedFallback;
  const statuses: TaskManagementStatusDefinition[] = [];
  const seen = new Set<string>();
  for (const candidate of input.statuses) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const definition = candidate as Partial<TaskManagementStatusDefinition>;
    if (!isTaskManagementStatus(definition.id) || seen.has(definition.id)) continue;
    const label = normalizeTaskManagementStatusLabel(definition.label, definition.id);
    const color = typeof definition.color === 'string' && taskManagementStatusColorPattern.test(definition.color) ? definition.color.toLowerCase() : '#6b7280';
    statuses.push({ id: definition.id, label, color });
    seen.add(definition.id);
    if (statuses.length >= 32) break;
  }
  if (statuses.length === 0) return normalizedFallback;
  const firstStatusId = statuses[0].id;
  const fallbackRoles = normalizedFallback.roles;
  const rolesInput = input.roles && typeof input.roles === 'object' && !Array.isArray(input.roles) ? (input.roles as Partial<TaskManagementStatusRoles>) : {};
  const resolveRole = (value: unknown, fallbackValue: string): TaskManagementStatus => {
    if (typeof value === 'string' && seen.has(value)) return value;
    if (seen.has(fallbackValue)) return fallbackValue;
    return firstStatusId;
  };
  return {
    statuses,
    roles: {
      defaultStatusId: resolveRole(rolesInput.defaultStatusId, fallbackRoles.defaultStatusId),
      pushedStatusId: resolveRole(rolesInput.pushedStatusId, fallbackRoles.pushedStatusId),
      completedStatusId: resolveRole(rolesInput.completedStatusId, fallbackRoles.completedStatusId),
      cancelledStatusId: resolveRole(rolesInput.cancelledStatusId, fallbackRoles.cancelledStatusId),
    },
  };
}

export function cloneTaskManagementStatusConfig(config: TaskManagementStatusConfig): TaskManagementStatusConfig {
  return {
    statuses: config.statuses.map((status) => ({ ...status })),
    roles: { ...config.roles },
  };
}

function normalizeTaskManagementStatusLabel(value: unknown, statusId: string): string | null {
  if (value === null || value === undefined) return taskManagementStatusOrder.includes(statusId as (typeof taskManagementStatusOrder)[number]) ? null : statusId;
  if (typeof value !== 'string') return statusId;
  const label = value.trim();
  if (!label || label.length > 48 || Array.from(label).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) return statusId;
  return label;
}

/** 任务页状态筛选值；空字符串表示“全部”，“未完成”是派生筛选而不是任务管理状态。 */
export type TaskStatusFilter = '' | 'unfinished' | TaskManagementStatus;

/** 对本机项目筛选偏好做统一校验，拒绝把未知字符串写入 App Shell 设置。 */
export function isTaskStatusFilter(value: unknown): value is TaskStatusFilter {
  return value === '' || value === 'unfinished' || isTaskManagementStatus(value);
}

/** 任务状态展示顺序，前端和服务端共用，避免多处硬编码。 */
export const taskStatusOrder: readonly TaskStatus[] = ['draft', 'ready', 'running', 'paused', 'waiting_confirmation', 'completed', 'failed', 'cancelled'] as const;

const terminalTaskStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);

/** 判断任务是否已经进入不可继续推进的终态。 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return terminalTaskStatuses.has(status);
}

/** Zeus 事件命名统一使用 zeus.* 命名空间，便于落库、日志和 WebSocket 过滤。 */
export enum ZeusEventKind {
  ProjectCreated = 'zeus.project.created',
  ProjectUpdated = 'zeus.project.updated',
  TaskCreated = 'zeus.task.created',
  TaskUpdated = 'zeus.task.updated',
  RuntimeUpdated = 'zeus.runtime.updated',
  TerminalOutput = 'zeus.terminal.output',
  GraphGenerated = 'zeus.graph.generated',
  GitUpdated = 'zeus.git.updated',
  TelegramUpdated = 'zeus.telegram.updated',
  SecurityWarning = 'zeus.security.warning',
}

/** 所有事件必须带真实来源，禁止用无来源的假数据填充图谱或执行日志。 */
export interface ZeusEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  kind: ZeusEventKind;
  payload: TPayload;
  source: 'user' | 'system' | 'scanner' | 'runtime' | 'git' | 'telegram';
  createdAt: string;
}

/** 任务页一级视图；列表内部的层级和平铺不属于一级视图。 */
export type TaskPageViewMode = 'list' | 'board';

export const taskBoardGroupProperties = ['managementStatus', 'priority', 'taskType', 'tags', 'parentTask', 'runStatus', 'branchStatus', 'source'] as const;
export type TaskBoardGroupProperty = (typeof taskBoardGroupProperties)[number];
export const taskBoardEmptyGroupId = '__zeus_none__';

export const taskBoardCardProperties = ['code', 'managementStatus', 'priority', 'taskType', 'runStatus', 'branchStatus', 'tags', 'parentTask', 'source', 'createdAt', 'updatedAt'] as const;
export type TaskBoardCardProperty = (typeof taskBoardCardProperties)[number];
export type TaskBoardCardSize = 'small' | 'medium' | 'large';
export type TaskBoardPreviewMode = 'none' | 'content' | 'first_image';
export type TaskBoardOpenMode = 'side_peek' | 'center_peek' | 'full_page';
export type TaskBoardGroupSort = 'manual' | 'ascending' | 'descending';
export type TaskBoardSortDirection = 'ascending' | 'descending';
export type TaskBoardFilterOperator = 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'is_empty' | 'is_not_empty';
export type TaskBoardFilterConjunction = 'and' | 'or';
export type TaskBoardColorTone = 'neutral' | 'blue' | 'violet' | 'green' | 'amber' | 'orange' | 'red';
export type TaskBoardCalculationKind = 'count_all' | 'count_values' | 'count_unique' | 'count_empty' | 'count_not_empty' | 'percent_empty' | 'percent_not_empty' | 'earliest_date' | 'latest_date' | 'date_range';

export interface TaskBoardFilterRule {
  id: string;
  kind: 'rule';
  property: TaskBoardCardProperty;
  operator: TaskBoardFilterOperator;
  value?: string | string[] | null;
}

export interface TaskBoardFilterGroup {
  id: string;
  kind: 'group';
  conjunction: TaskBoardFilterConjunction;
  conditions: Array<TaskBoardFilterRule | TaskBoardFilterGroup>;
}

export interface TaskBoardSortRule {
  id: string;
  property: TaskBoardCardProperty;
  direction: TaskBoardSortDirection;
}

export interface TaskBoardCalculation {
  kind: TaskBoardCalculationKind;
  property?: TaskBoardCardProperty;
}

export interface TaskBoardConditionalColorRule {
  id: string;
  filter: TaskBoardFilterGroup;
  tone: TaskBoardColorTone;
}

export interface TaskBoardPreviewPosition {
  x: number;
  y: number;
}

export interface TaskBoardViewSettings {
  groupBy: TaskBoardGroupProperty;
  subgroupBy: TaskBoardGroupProperty | null;
  groupSort: TaskBoardGroupSort;
  groupOrder: string[];
  hiddenGroupIds: string[];
  collapsedGroupIds: string[];
  hiddenSubgroupIdsByGroup: Record<string, string[]>;
  collapsedSubgroupIdsByGroup: Record<string, string[]>;
  hideEmptyGroups: boolean;
  colorColumns: boolean;
  columnColors: Record<string, TaskBoardColorTone>;
  cardSize: TaskBoardCardSize;
  visibleProperties: TaskBoardCardProperty[];
  propertyOrder: TaskBoardCardProperty[];
  preview: TaskBoardPreviewMode;
  fitPreview: boolean;
  previewPositions: Record<string, TaskBoardPreviewPosition>;
  filters: TaskBoardFilterGroup | null;
  sorts: TaskBoardSortRule[];
  calculation: TaskBoardCalculation;
  conditionalColors: TaskBoardConditionalColorRule[];
  openMode: TaskBoardOpenMode;
}

export interface TaskBoardViewSnapshot {
  projectId: string;
  revision: number;
  settings: TaskBoardViewSettings;
  positions: TaskBoardPosition[];
  updatedAt: string | null;
}

export interface TaskBoardPosition {
  projectId: string;
  layoutKey: string;
  groupId: string;
  subgroupId: string;
  taskId: string;
  rank: number;
  updatedAt: string;
}

export interface TaskBoardLaneIdentity {
  groupId: string;
  subgroupId?: string | null;
}

export interface TaskBoardMoveRequest {
  taskId: string;
  source: TaskBoardLaneIdentity;
  target: TaskBoardLaneIdentity & { beforeTaskId?: string; afterTaskId?: string };
  expectedTaskUpdatedAt: string;
  expectedViewRevision: number;
  confirmWorktreeCleanup?: boolean;
}

export interface TaskBoardViewUpdateRequest {
  expectedRevision: number;
  settings: Partial<TaskBoardViewSettings>;
}

const taskBoardFilterOperators = new Set<TaskBoardFilterOperator>(['equals', 'not_equals', 'contains', 'not_contains', 'is_empty', 'is_not_empty']);
const taskBoardColorTones = new Set<TaskBoardColorTone>(['neutral', 'blue', 'violet', 'green', 'amber', 'orange', 'red']);
const taskBoardCalculationKinds = new Set<TaskBoardCalculationKind>(['count_all', 'count_values', 'count_unique', 'count_empty', 'count_not_empty', 'percent_empty', 'percent_not_empty', 'earliest_date', 'latest_date', 'date_range']);

export function isTaskBoardGroupProperty(value: unknown): value is TaskBoardGroupProperty {
  return typeof value === 'string' && taskBoardGroupProperties.includes(value as TaskBoardGroupProperty);
}

export function isTaskBoardCardProperty(value: unknown): value is TaskBoardCardProperty {
  return typeof value === 'string' && taskBoardCardProperties.includes(value as TaskBoardCardProperty);
}

export function taskBoardLayoutKey(settings: Pick<TaskBoardViewSettings, 'groupBy' | 'subgroupBy'>): string {
  return `${settings.groupBy}:${settings.subgroupBy ?? ''}`;
}

export function createDefaultTaskBoardViewSettings(): TaskBoardViewSettings {
  return {
    groupBy: 'managementStatus',
    subgroupBy: null,
    groupSort: 'manual',
    groupOrder: [],
    hiddenGroupIds: [],
    collapsedGroupIds: [],
    hiddenSubgroupIdsByGroup: {},
    collapsedSubgroupIdsByGroup: {},
    hideEmptyGroups: false,
    colorColumns: true,
    columnColors: {},
    cardSize: 'medium',
    visibleProperties: ['code', 'priority', 'taskType', 'runStatus', 'tags'],
    propertyOrder: [...taskBoardCardProperties],
    preview: 'none',
    fitPreview: true,
    previewPositions: {},
    filters: null,
    sorts: [],
    calculation: { kind: 'count_all' },
    conditionalColors: [],
    openMode: 'side_peek',
  };
}

function boardStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length <= 160)));
}

function normalizeTaskBoardFilter(value: unknown, depth = 1): TaskBoardFilterGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return null;
  const candidate = value as Partial<TaskBoardFilterGroup>;
  if (candidate.kind !== 'group' || (candidate.conjunction !== 'and' && candidate.conjunction !== 'or') || !Array.isArray(candidate.conditions)) return null;
  const conditions: Array<TaskBoardFilterRule | TaskBoardFilterGroup> = [];
  for (const condition of candidate.conditions.slice(0, 32)) {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) continue;
    const entry = condition as Partial<TaskBoardFilterRule | TaskBoardFilterGroup>;
    if (entry.kind === 'group') {
      const group = normalizeTaskBoardFilter(entry, depth + 1);
      if (group) conditions.push(group);
      continue;
    }
    if (entry.kind !== 'rule' || !isTaskBoardCardProperty(entry.property) || !taskBoardFilterOperators.has(entry.operator as TaskBoardFilterOperator)) continue;
    conditions.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : `rule-${depth}-${conditions.length}`,
      kind: 'rule',
      property: entry.property,
      operator: entry.operator as TaskBoardFilterOperator,
      ...(entry.value === null || typeof entry.value === 'string' || (Array.isArray(entry.value) && entry.value.every((item) => typeof item === 'string')) ? { value: entry.value } : {}),
    });
  }
  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : `group-${depth}`,
    kind: 'group',
    conjunction: candidate.conjunction,
    conditions,
  };
}

/** 对服务端持久化和 Renderer 草稿使用同一看板配置清洗规则。 */
export function normalizeTaskBoardViewSettings(value: unknown, fallback: TaskBoardViewSettings = createDefaultTaskBoardViewSettings()): TaskBoardViewSettings {
  const candidate = value && typeof value === 'object' && !Array.isArray(value) ? (value as Partial<TaskBoardViewSettings>) : {};
  const groupBy = isTaskBoardGroupProperty(candidate.groupBy) ? candidate.groupBy : fallback.groupBy;
  const subgroupBy = candidate.subgroupBy === null ? null : isTaskBoardGroupProperty(candidate.subgroupBy) && candidate.subgroupBy !== groupBy ? candidate.subgroupBy : fallback.subgroupBy === groupBy ? null : fallback.subgroupBy;
  const propertyOrder = boardStringArray(candidate.propertyOrder).filter(isTaskBoardCardProperty);
  const completePropertyOrder = [...propertyOrder, ...taskBoardCardProperties.filter((property) => !propertyOrder.includes(property))];
  const visibleProperties = boardStringArray(candidate.visibleProperties).filter(isTaskBoardCardProperty);
  const hiddenSubgroupIdsByGroup = Object.fromEntries(
    Object.entries(candidate.hiddenSubgroupIdsByGroup ?? {})
      .filter(([key]) => key.length <= 160)
      .map(([key, ids]) => [key, boardStringArray(ids)]),
  );
  const collapsedSubgroupIdsByGroup = Object.fromEntries(
    Object.entries(candidate.collapsedSubgroupIdsByGroup ?? {})
      .filter(([key]) => key.length <= 160)
      .map(([key, ids]) => [key, boardStringArray(ids)]),
  );
  const previewPositions = Object.fromEntries(
    Object.entries(candidate.previewPositions ?? {})
      .filter(([taskId, position]) => taskId.length <= 160 && position && Number.isFinite(position.x) && Number.isFinite(position.y))
      .map(([taskId, position]) => [taskId, { x: Math.min(100, Math.max(0, position.x)), y: Math.min(100, Math.max(0, position.y)) }]),
  );
  const columnColors = Object.fromEntries(Object.entries(candidate.columnColors ?? {}).filter(([groupId, tone]) => groupId.length <= 160 && taskBoardColorTones.has(tone)));
  const sorts = Array.isArray(candidate.sorts)
    ? candidate.sorts.filter((sort): sort is TaskBoardSortRule => Boolean(sort && typeof sort.id === 'string' && isTaskBoardCardProperty(sort.property) && (sort.direction === 'ascending' || sort.direction === 'descending'))).slice(0, 8)
    : fallback.sorts;
  const calculation =
    candidate.calculation && taskBoardCalculationKinds.has(candidate.calculation.kind)
      ? { kind: candidate.calculation.kind, ...(isTaskBoardCardProperty(candidate.calculation.property) ? { property: candidate.calculation.property } : {}) }
      : fallback.calculation;
  const conditionalColors = Array.isArray(candidate.conditionalColors)
    ? candidate.conditionalColors
        .flatMap((rule) => {
          const filter = normalizeTaskBoardFilter(rule?.filter);
          return rule && typeof rule.id === 'string' && filter && taskBoardColorTones.has(rule.tone) ? [{ id: rule.id, filter, tone: rule.tone }] : [];
        })
        .slice(0, 16)
    : fallback.conditionalColors;
  return {
    groupBy,
    subgroupBy,
    groupSort: candidate.groupSort === 'ascending' || candidate.groupSort === 'descending' || candidate.groupSort === 'manual' ? candidate.groupSort : fallback.groupSort,
    groupOrder: boardStringArray(candidate.groupOrder),
    hiddenGroupIds: boardStringArray(candidate.hiddenGroupIds),
    collapsedGroupIds: boardStringArray(candidate.collapsedGroupIds),
    hiddenSubgroupIdsByGroup,
    collapsedSubgroupIdsByGroup,
    hideEmptyGroups: typeof candidate.hideEmptyGroups === 'boolean' ? candidate.hideEmptyGroups : fallback.hideEmptyGroups,
    colorColumns: typeof candidate.colorColumns === 'boolean' ? candidate.colorColumns : fallback.colorColumns,
    columnColors,
    cardSize: candidate.cardSize === 'small' || candidate.cardSize === 'large' || candidate.cardSize === 'medium' ? candidate.cardSize : fallback.cardSize,
    visibleProperties: Array.isArray(candidate.visibleProperties) ? visibleProperties : [...fallback.visibleProperties],
    propertyOrder: completePropertyOrder,
    preview: candidate.preview === 'content' || candidate.preview === 'first_image' || candidate.preview === 'none' ? candidate.preview : fallback.preview,
    fitPreview: typeof candidate.fitPreview === 'boolean' ? candidate.fitPreview : fallback.fitPreview,
    previewPositions,
    filters: candidate.filters === null ? null : (normalizeTaskBoardFilter(candidate.filters) ?? fallback.filters),
    sorts,
    calculation,
    conditionalColors,
    openMode: candidate.openMode === 'center_peek' || candidate.openMode === 'full_page' || candidate.openMode === 'side_peek' ? candidate.openMode : fallback.openMode,
  };
}

export * from './browser.js';
export * from './commands.js';
export * from './conversationContext.js';
export * from './conversationResources.js';
export * from './portableConversationContext.js';
export * from './projectSourceWorkspace.js';
export * from './requestUserInput.js';
export * from './sourceLanguage.js';

/** 禅道对象类型只从链接结构识别；Zeus 不会主动调用禅道接口。 */
export type ZentaoLinkKind = 'bug' | 'story' | 'task';

export type ZentaoLinkInfo = { kind: 'zentao'; zentaoKind: ZentaoLinkKind; objectId: string; url: string } | { kind: 'unsupported'; url: string } | { kind: 'invalid' };

/** 解析禅道详情页链接：支持 /bug-view-123.html 路径形式与 ?m=bug&f=view&bugID=123 旧版参数形式。 */
export function parseZentaoTaskUrl(rawUrl: string): ZentaoLinkInfo {
  const url = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: 'invalid' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { kind: 'unsupported', url };
  const pathname = decodeURIComponent(parsed.pathname);
  const pathMatch = pathname.match(/\/(bug|story|task)-view-(\d+)(?:\.html)?/iu);
  if (pathMatch) {
    const zentaoKind = pathMatch[1].toLowerCase() as ZentaoLinkKind;
    return { kind: 'zentao', zentaoKind, objectId: pathMatch[2], url };
  }
  const moduleName = parsed.searchParams.get('m')?.toLowerCase();
  if (moduleName === 'bug' || moduleName === 'story' || moduleName === 'task') {
    const objectId = parsed.searchParams.get(`${moduleName}ID`) ?? parsed.searchParams.get('id');
    if (objectId && /^\d+$/u.test(objectId)) {
      return { kind: 'zentao', zentaoKind: moduleName, objectId, url };
    }
  }
  return { kind: 'unsupported', url };
}

/** 粘贴文本恰好是一个禅道链接时返回该链接，否则返回 null；用于粘贴后自动解析。 */
export function extractZentaoTaskLink(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/u.test(trimmed)) return null;
  const link = parseZentaoTaskUrl(trimmed);
  return link.kind === 'zentao' ? trimmed : null;
}

/** 禅道对象映射到 Zeus 任务类型：缺陷归入缺陷，需求与任务归入需求。 */
export function zentaoTaskType(zentaoKind: ZentaoLinkKind): TaskType {
  return zentaoKind === 'bug' ? 'defect' : 'requirement';
}

export type ZentaoTaskExtract =
  | {
      kind: 'ok';
      zentaoKind: ZentaoLinkKind;
      objectId: string;
      taskType: TaskType;
      title: string;
      description: string;
      currentState: string;
      reproductionSteps: string;
      expectedOutcome: string;
      sourceUrl: string;
      attachments: TaskAttachmentReference[];
      attachmentFailedCount: number;
    }
  | { kind: 'login_required'; zentaoKind: ZentaoLinkKind; objectId: string; sourceUrl: string }
  | { kind: 'unsupported'; sourceUrl: string }
  | { kind: 'failed'; sourceUrl: string; reason: string; cause?: 'credential_missing' | 'auth_failed' | 'network' };

/** 禅道实例元数据；host 保存 origin（协议+主机+端口），basePath 为子目录路径，根目录部署时为空字符串。 */
export interface ZentaoInstanceRecord {
  id: string;
  host: string;
  basePath: string;
  account: string;
  passwordConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaveZentaoInstanceRequest {
  baseUrl: string;
  account: string;
  password?: string;
}

export type ZentaoInstanceVerifyCode = 'verified' | 'password_missing' | 'auth_failed' | 'api_unavailable' | 'network_failed' | 'bad_request';

export interface ZentaoInstanceVerifyResult {
  ok: boolean;
  code: ZentaoInstanceVerifyCode;
  checkedAt: string;
  message: string;
}

/** Keychain 记录名；与 local-server 写入时的账号命名保持一致。 */
export function zentaoSecretAccount(instanceId: string): string {
  return `zentao:${instanceId}`;
}

/** 将实例地址解析为 host(origin) 与 basePath；只接受 http/https 且不带查询参数与片段。 */
export function parseZentaoInstanceBaseUrl(rawBaseUrl: string): { host: string; basePath: string } | null {
  const trimmed = rawBaseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  const host = `${parsed.protocol}//${parsed.host}`;
  const basePath = parsed.pathname.replace(/\/+$/u, '');
  return { host, basePath };
}

/** 构造实例的禅道 REST 基址；根目录部署时为 /api.php/v1。 */
export function zentaoInstanceApiBase(instance: Pick<ZentaoInstanceRecord, 'host' | 'basePath'>): string {
  return `${instance.host}${instance.basePath}/api.php/v1`;
}
