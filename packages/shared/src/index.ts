/** Zeus 任务状态：只描述真实任务生命周期，不承载任何示例或 mock 业务数据。 */
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

/** 项目管理阶段与 Coding Agent 执行状态严格分离；这里只描述任务在交付流程中的位置。 */
export type TaskManagementStatus = 'todo' | 'in_development' | 'in_testing' | 'awaiting_acceptance' | 'blocked' | 'completed' | 'cancelled';

/** 项目管理阶段的固定展示与筛选顺序。 */
export const taskManagementStatusOrder: readonly TaskManagementStatus[] = ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'] as const;

/** 对 API、导入文件和数据库回填值做统一运行时校验。 */
export function isTaskManagementStatus(value: unknown): value is TaskManagementStatus {
  return typeof value === 'string' && taskManagementStatusOrder.includes(value as TaskManagementStatus);
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
