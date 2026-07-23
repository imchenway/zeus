/** Zeus 任务状态：只描述真实任务生命周期，不承载任何示例或 mock 业务数据。 */
export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

/** 项目管理阶段与 Coding Agent 执行状态严格分离；这里只描述任务在交付流程中的位置。 */
export type TaskManagementStatus =
    'todo'
    | 'in_development'
    | 'in_testing'
    | 'awaiting_acceptance'
    | 'blocked'
    | 'completed'
    | 'cancelled';

/** 项目管理阶段的固定展示与筛选顺序。 */
export const taskManagementStatusOrder: readonly TaskManagementStatus[] = ['todo', 'in_development', 'in_testing', 'awaiting_acceptance', 'blocked', 'completed', 'cancelled'] as const;

/** 对 API、导入文件和数据库回填值做统一运行时校验。 */
export function isTaskManagementStatus(value: unknown): value is TaskManagementStatus {
    return typeof value === 'string' && taskManagementStatusOrder.includes(value as TaskManagementStatus);
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
