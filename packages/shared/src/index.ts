/** Zeus 任务状态：只描述真实任务生命周期，不承载任何示例或 mock 业务数据。 */
export type TaskStatus = 'draft' | 'ready' | 'running' | 'paused' | 'waiting_confirmation' | 'completed' | 'failed' | 'cancelled';

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
