import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HomebrewUpdateController, HomebrewUpdateIndicatorState } from './homebrewUpdateController.js';

export interface AutomaticUpdateScheduler {
  start(): Promise<void>;
  checkIfDue(): void;
  recordCheckCompleted(checkedAt?: string): void;
  getIndicatorState(): HomebrewUpdateIndicatorState;
  stop(): void;
}

interface CreateAutomaticUpdateSchedulerOptions {
  statePath: string;
  intervalMs: number;
  initialDelayMs: number;
  failedCheckRetryMs?: number;
  controller: HomebrewUpdateController;
  onIndicatorChange: (state: HomebrewUpdateIndicatorState) => void;
  notifyReady: (latestVersion: string, showProgress: () => void) => boolean;
}

interface PersistedAutomaticUpdateState {
  schemaVersion: 1;
  lastCheckCompletedAt: string | null;
  lastNotifiedVersion: string | null;
  blockedPrepareVersion: string | null;
  indicator: HomebrewUpdateIndicatorState;
}

const defaultFailedCheckRetryMs = 5 * 60_000;
const indicatorBroadcastIntervalMs = 500;
const persistenceDebounceMs = 1_000;

/** 自动调度只负责频率、恢复和提醒；检查、预取与安装仍由唯一更新控制器串行执行。 */
export function createAutomaticUpdateScheduler(options: CreateAutomaticUpdateSchedulerOptions): AutomaticUpdateScheduler {
  let persisted: PersistedAutomaticUpdateState = {
    schemaVersion: 1,
    lastCheckCompletedAt: null,
    lastNotifiedVersion: null,
    blockedPrepareVersion: null,
    indicator: options.controller.getIndicatorState(),
  };
  let stopped = false;
  let checking = false;
  let started = false;
  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  let persistenceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBroadcastAt = 0;
  let lastBroadcastPhase = persisted.indicator.phase;
  let persistChain = Promise.resolve();
  let removeIndicatorListener: (() => void) | null = null;
  let removeCheckCompletedListener: (() => void) | null = null;

  function scheduleAt(timestamp: number): void {
    if (stopped) return;
    if (checkTimer) clearTimeout(checkTimer);
    const delayMs = Math.max(0, timestamp - Date.now());
    checkTimer = setTimeout(() => {
      checkTimer = null;
      void runDueCheck();
    }, delayMs);
    checkTimer.unref();
  }

  function scheduleFromLastCheck(): void {
    const lastCheck = parseTimestamp(persisted.lastCheckCompletedAt);
    const dueAt = lastCheck === null ? Date.now() + options.initialDelayMs : lastCheck + options.intervalMs;
    scheduleAt(dueAt);
  }

  async function runDueCheck(): Promise<void> {
    if (stopped || checking) return;
    const lastCheck = parseTimestamp(persisted.lastCheckCompletedAt);
    if (lastCheck !== null && Date.now() < lastCheck + options.intervalMs) {
      scheduleFromLastCheck();
      return;
    }
    checking = true;
    try {
      const loaded = await options.controller.checkAutomatically({ blockedPrepareVersion: persisted.blockedPrepareVersion });
      if (!loaded && !stopped) scheduleAt(Date.now() + (options.failedCheckRetryMs ?? defaultFailedCheckRetryMs));
    } finally {
      checking = false;
      // 极慢预取跨过下一到期点时，原定时器可能已在串行任务期间触发；完成后必须重新挂回调度。
      if (!stopped && !checkTimer) scheduleFromLastCheck();
    }
  }

  function recordCheckCompleted(checkedAt = new Date().toISOString()): void {
    const normalized = normalizeIsoDate(checkedAt) ?? new Date().toISOString();
    persisted = { ...persisted, lastCheckCompletedAt: normalized };
    schedulePersistence();
    scheduleFromLastCheck();
  }

  function handleIndicatorChange(state: HomebrewUpdateIndicatorState): void {
    const previous = persisted.indicator;
    let blockedPrepareVersion = persisted.blockedPrepareVersion;
    if (state.phase === 'failed' && state.latestVersion) blockedPrepareVersion = state.latestVersion;
    else if (state.phase === 'ready' || state.phase === 'idle' || (state.latestVersion && state.latestVersion !== previous.latestVersion)) blockedPrepareVersion = null;
    persisted = { ...persisted, blockedPrepareVersion, indicator: { ...state } };
    broadcastIndicator(state);
    schedulePersistence();
    if (state.phase !== 'ready' || !state.latestVersion || state.latestVersion === persisted.lastNotifiedVersion) return;
    const notified = options.notifyReady(state.latestVersion, () => void options.controller.showOrCheck());
    if (!notified) return;
    persisted = { ...persisted, lastNotifiedVersion: state.latestVersion };
    schedulePersistence();
  }

  function broadcastIndicator(state: HomebrewUpdateIndicatorState): void {
    const now = Date.now();
    const phaseChanged = lastBroadcastPhase !== state.phase;
    if (phaseChanged || now - lastBroadcastAt >= indicatorBroadcastIntervalMs) {
      if (broadcastTimer) clearTimeout(broadcastTimer);
      broadcastTimer = null;
      lastBroadcastAt = now;
      lastBroadcastPhase = state.phase;
      options.onIndicatorChange({ ...state });
      return;
    }
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(
      () => {
        broadcastTimer = null;
        lastBroadcastAt = Date.now();
        lastBroadcastPhase = persisted.indicator.phase;
        options.onIndicatorChange({ ...persisted.indicator });
      },
      indicatorBroadcastIntervalMs - (now - lastBroadcastAt),
    );
    broadcastTimer.unref();
  }

  function schedulePersistence(): void {
    if (stopped || persistenceTimer) return;
    persistenceTimer = setTimeout(() => {
      persistenceTimer = null;
      void persistNow();
    }, persistenceDebounceMs);
    persistenceTimer.unref();
  }

  function persistNow(): Promise<void> {
    const snapshot = JSON.stringify(persisted, null, 2);
    persistChain = persistChain
      .then(async () => {
        await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
        const temporaryPath = `${options.statePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporaryPath, options.statePath);
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
      })
      .catch((error: unknown) => {
        console.warn('Zeus 无法持久化自动更新状态。', error);
      });
    return persistChain;
  }

  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;
    const restored = await readPersistedState(options.statePath, options.controller.getIndicatorState().currentVersion);
    if (restored) {
      persisted = restored;
      options.controller.restoreIndicatorState(restored.indicator);
    }
    removeIndicatorListener = options.controller.onIndicatorState(handleIndicatorChange);
    removeCheckCompletedListener = options.controller.onCheckCompleted(recordCheckCompleted);
    persisted = { ...persisted, indicator: options.controller.getIndicatorState() };
    options.onIndicatorChange({ ...persisted.indicator });
    if (persisted.indicator.phase === 'available' || persisted.indicator.phase === 'preparing' || persisted.indicator.phase === 'retrying') {
      // 进程中断过预取时不伪装成仍在下载；启动后短暂让出首屏，再从发布清单恢复真实任务。
      persisted = { ...persisted, lastCheckCompletedAt: null };
    }
    scheduleFromLastCheck();
  }

  return {
    start,
    checkIfDue: () => {
      if (!started || stopped) return;
      const lastCheck = parseTimestamp(persisted.lastCheckCompletedAt);
      if (lastCheck === null || Date.now() >= lastCheck + options.intervalMs) scheduleAt(Date.now());
    },
    recordCheckCompleted,
    getIndicatorState: () => ({ ...persisted.indicator }),
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (checkTimer) clearTimeout(checkTimer);
      if (broadcastTimer) clearTimeout(broadcastTimer);
      if (persistenceTimer) clearTimeout(persistenceTimer);
      checkTimer = null;
      broadcastTimer = null;
      persistenceTimer = null;
      removeIndicatorListener?.();
      removeCheckCompletedListener?.();
      removeIndicatorListener = null;
      removeCheckCompletedListener = null;
      void persistNow();
    },
  };
}

async function readPersistedState(path: string, currentVersion: string): Promise<PersistedAutomaticUpdateState | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !isIndicatorState(value.indicator, currentVersion)) return null;
    return {
      schemaVersion: 1,
      lastCheckCompletedAt: typeof value.lastCheckCompletedAt === 'string' && normalizeIsoDate(value.lastCheckCompletedAt) ? normalizeIsoDate(value.lastCheckCompletedAt) : null,
      lastNotifiedVersion: typeof value.lastNotifiedVersion === 'string' && value.lastNotifiedVersion.trim() ? value.lastNotifiedVersion.trim() : null,
      blockedPrepareVersion: typeof value.blockedPrepareVersion === 'string' && value.blockedPrepareVersion.trim() ? value.blockedPrepareVersion.trim() : null,
      indicator: value.indicator,
    };
  } catch {
    return null;
  }
}

function isIndicatorState(value: unknown, currentVersion: string): value is HomebrewUpdateIndicatorState {
  if (!isRecord(value)) return false;
  return (
    ['idle', 'available', 'preparing', 'retrying', 'ready', 'failed'].includes(String(value.phase)) &&
    value.currentVersion === currentVersion &&
    (value.latestVersion === null || typeof value.latestVersion === 'string') &&
    typeof value.detail === 'string' &&
    typeof value.updatedAt === 'string' &&
    normalizeIsoDate(value.updatedAt) !== null &&
    (value.progress === undefined || (typeof value.progress === 'number' && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1)) &&
    (value.retryAt === undefined || (typeof value.retryAt === 'string' && normalizeIsoDate(value.retryAt) !== null))
  );
}

function normalizeIsoDate(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
