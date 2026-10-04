import { performance } from 'node:perf_hooks';

/** 已进入执行的发布允许冷编译和产物校验，但本次累计等待仍有上限。 */
export const releaseWorkflowWaitLimitMs = 45 * 60_000;
/** 尚未开始执行的运行最多排队十五分钟，避免服务故障时长期等待。 */
export const releaseWorkflowQueueWaitLimitMs = 15 * 60_000;
/** 子命令用独立退出码传递未确认结果，不能冒充成功或远端发布失败。 */
export const releasePublicationUnconfirmedExitCode = 2;
/** 等待期间每分钟输出一次可回验的进度心跳。 */
export const releaseWorkflowHeartbeatIntervalMs = 60_000;
/** 正常状态轮询间隔，实际休眠仍受剩余预算约束。 */
export const releaseWorkflowPollIntervalMs = 10_000;

/** 使用本进程单调时钟建立等待预算，避免远端年龄或系统钟差造成立即超时。 */
export function resolveReleaseWorkflowWaitWindow(observedAtMs = performance.now(), workflowRun = null) {
  if (!Number.isFinite(observedAtMs)) throw new Error('Release Workflow 观察时间无效。');

  /** 排队与执行共用起点，阶段变化不会重置本地累计时长。 */
  const waitWindow = {
    startedAtMs: observedAtMs,
    deadlineAtMs: observedAtMs + releaseWorkflowWaitLimitMs,
    queueDeadlineAtMs: observedAtMs + releaseWorkflowQueueWaitLimitMs,
    executionStarted: false,
  };
  observeReleaseWorkflowExecution(waitWindow, workflowRun);
  return waitWindow;
}

/** 一旦观察到运行或作业已执行，后续阶段间排队不退回首次排队预算。 */
export function observeReleaseWorkflowExecution(waitWindow, workflowRun) {
  if (workflowRun?.status === 'in_progress' || workflowRun?.status === 'completed' || workflowRun?.jobs?.some((job) => job.status === 'in_progress' || job.status === 'completed')) {
    waitWindow.executionStarted = true;
  }
}

/** 用同一时钟读取预算，传给网络请求的剩余毫秒取整，超时边界保留精确判断。 */
export function readReleaseWorkflowWaitState(waitWindow, observedAtMs = performance.now()) {
  if (!Number.isFinite(observedAtMs)) throw new Error('Release Workflow 观察时间无效。');
  /** 未开始的运行受排队预算约束，已开始的运行受累计执行预算约束。 */
  const deadlineAtMs = waitWindow.executionStarted ? waitWindow.deadlineAtMs : Math.min(waitWindow.deadlineAtMs, waitWindow.queueDeadlineAtMs);
  return {
    elapsedMs: Math.max(0, Math.floor(observedAtMs - waitWindow.startedAtMs)),
    remainingMs: Math.max(0, Math.ceil(deadlineAtMs - observedAtMs)),
    timedOut: observedAtMs >= deadlineAtMs,
    limitMs: deadlineAtMs - waitWindow.startedAtMs,
  };
}

/** 公开交付尚未完成回验时保留未知结果，供发布各层准确传递。 */
export class ReleasePublicationUnconfirmedError extends Error {
  /** 保留具体缺失证据和恢复说明，不改变远端运行。 */
  constructor(message) {
    super(message);
    this.name = 'ReleasePublicationUnconfirmedError';
  }
}

/** 将毫秒预算显示为中文分钟和秒。 */
export function formatReleaseWorkflowDuration(durationMs) {
  /** 不显示负数或未满一秒的小数。 */
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  /** 已经过的完整分钟数。 */
  const minutes = Math.floor(totalSeconds / 60);
  /** 保留分钟内的秒数。 */
  const seconds = totalSeconds % 60;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}
