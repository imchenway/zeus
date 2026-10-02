import { performance } from 'node:perf_hooks';

/** 单次本地等待最多十五分钟，不按远端运行的创建时间扣减。 */
export const releaseWorkflowWaitLimitMs = 15 * 60_000;
/** 等待期间每分钟输出一次可回验的进度心跳。 */
export const releaseWorkflowHeartbeatIntervalMs = 60_000;
/** 正常状态轮询间隔，实际休眠仍受剩余预算约束。 */
export const releaseWorkflowPollIntervalMs = 10_000;

/** 使用本进程单调时钟建立等待预算，避免远端年龄或系统钟差造成立即超时。 */
export function resolveReleaseWorkflowWaitWindow(observedAtMs = performance.now()) {
  if (!Number.isFinite(observedAtMs)) throw new Error('Release Workflow 观察时间无效。');

  return {
    startedAtMs: observedAtMs,
    deadlineAtMs: observedAtMs + releaseWorkflowWaitLimitMs,
  };
}

/** 用同一时钟读取预算，传给网络请求的剩余毫秒取整，超时边界保留精确判断。 */
export function readReleaseWorkflowWaitState(waitWindow, observedAtMs = performance.now()) {
  if (!Number.isFinite(observedAtMs)) throw new Error('Release Workflow 观察时间无效。');
  return {
    elapsedMs: Math.max(0, Math.floor(observedAtMs - waitWindow.startedAtMs)),
    remainingMs: Math.max(0, Math.ceil(waitWindow.deadlineAtMs - observedAtMs)),
    timedOut: observedAtMs >= waitWindow.deadlineAtMs,
  };
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
