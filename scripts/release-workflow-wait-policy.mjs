export const releaseWorkflowWaitLimitMs = 15 * 60_000;
export const releaseWorkflowHeartbeatIntervalMs = 60_000;
export const releaseWorkflowPollIntervalMs = 10_000;

export function resolveReleaseWorkflowWaitWindow(workflowRun, observedAtMs = Date.now()) {
  if (!Number.isFinite(observedAtMs)) throw new Error('Release Workflow 观察时间无效。');

  const createdAtMs = Date.parse(workflowRun?.createdAt ?? '');
  const startedAtMs = Number.isFinite(createdAtMs) && createdAtMs <= observedAtMs ? createdAtMs : observedAtMs;
  return {
    startedAtMs,
    deadlineAtMs: startedAtMs + releaseWorkflowWaitLimitMs,
  };
}

export function readReleaseWorkflowWaitState(waitWindow, observedAtMs = Date.now()) {
  if (!Number.isFinite(observedAtMs)) throw new Error('Release Workflow 观察时间无效。');
  return {
    elapsedMs: Math.max(0, observedAtMs - waitWindow.startedAtMs),
    remainingMs: Math.max(0, waitWindow.deadlineAtMs - observedAtMs),
    timedOut: observedAtMs >= waitWindow.deadlineAtMs,
  };
}

export function formatReleaseWorkflowDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}分${String(seconds).padStart(2, '0')}秒`;
}
