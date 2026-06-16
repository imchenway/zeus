import type { TaskStatus } from '@zeus/shared';

/** 任务状态迁移表：所有 UI/API 状态按钮都必须受这里约束。 */
const allowedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['ready', 'cancelled'],
  ready: ['running', 'cancelled'],
  running: ['paused', 'waiting_confirmation', 'completed', 'failed', 'cancelled'],
  paused: ['running', 'cancelled'],
  waiting_confirmation: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: ['ready'],
  cancelled: ['ready'],
};

/** 判断 Zeus 任务是否允许从当前状态切换到目标状态。 */
export function canTransitionTaskStatus(from: TaskStatus, to: TaskStatus): boolean {
  return allowedTransitions[from].includes(to);
}

/** 返回迁移后的状态；非法迁移直接抛错，避免任务进入不可解释状态。 */
export function getNextTaskStatus(from: TaskStatus, to: TaskStatus): TaskStatus {
  if (!canTransitionTaskStatus(from, to)) {
    throw new Error(`Invalid Zeus task transition: ${from} -> ${to}`);
  }
  return to;
}

export type { TaskStatus } from '@zeus/shared';
