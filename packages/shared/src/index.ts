/** Zeus 任务状态：只描述真实任务生命周期，不承载任何示例或 mock 业务数据。 */
export * from './taskPush.js';
export * from './codexUsage.js';

export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

/** 任务优先级只表达处理顺序；P0 不会隐式启动任务或 AI 会话。 */
export const taskPriorityOrder = ['p0', 'p1', 'p2', 'p3', 'p4'] as const;

export type TaskPriority = (typeof taskPriorityOrder)[number];

/** 任务附件关联只保存可持久化元数据；预览内容与可恢复正文不进入任务记录。 */
export interface TaskAttachmentReference {
  path: string;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
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

export * from './browser.js';
export * from './commands.js';
export * from './conversationResources.js';
export * from './projectSourceWorkspace.js';
