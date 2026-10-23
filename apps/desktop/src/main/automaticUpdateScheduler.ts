import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import type { HomebrewUpdateController, HomebrewUpdateIndicatorState } from './homebrewUpdateController.js';

export interface AutomaticUpdateScheduler {
  start(): Promise<void>;
  checkIfDue(): void;
  recordCheckCompleted(checkedAt?: string): void;
  getIndicatorState(): HomebrewUpdateIndicatorState;
  stop(): void;
}

/** 自动安装以实际程序路径和目标版本共同标识，不能因重启或切换安装来源重复发起。 */
export interface AutomaticCodexUpdateTarget {
  /** 检查接口返回的实际程序绝对路径。 */
  commandPath: string;
  /** 本次检测到并冻结的官方目标版本。 */
  targetVersion: string;
}

/** 先持久化安装意图，再确认仍可后台提交；返回 false 时不得发送安装请求。 */
export type ReserveAutomaticCodexUpdate = (target: AutomaticCodexUpdateTarget, mayStart: () => boolean) => Promise<boolean>;

interface CreateAutomaticUpdateSchedulerOptions {
  statePath: string;
  intervalMs: number;
  initialDelayMs: number;
  failedCheckRetryMs?: number;
  controller: HomebrewUpdateController;
  onIndicatorChange: (state: HomebrewUpdateIndicatorState) => void;
  /** 通知点击保留打开结果，由桌面入口展示窗口启动失败。 */
  notifyReady: (latestVersion: string, showProgress: () => Promise<void>) => boolean;
  /** 与 Zeus 检测共用到期触发，受管 Codex 经过持久化门禁后进入既有安全更新链。 */
  updateCodexAutomatically?: (reserveUpdate: ReserveAutomaticCodexUpdate) => Promise<void>;
}

interface PersistedAutomaticUpdateState {
  schemaVersion: 1;
  lastCheckCompletedAt: string | null;
  lastNotifiedVersion: string | null;
  blockedPrepareVersion: string | null;
  /** 已发起的安装目标跨重启保留；null 表示记录不可读，只允许检测和手动更新。 */
  codexUpdateAttempts: AutomaticCodexUpdateTarget[] | null;
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
    codexUpdateAttempts: [],
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
  /** 写入结果供自动安装门禁判断；日志写入失败不能被当成安装意图已落盘。 */
  let persistChain = Promise.resolve(true);
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
      /** 两类更新从同一个到期点开始，任一失败都不阻断另一类。 */
      const [zeusResult, companionResult] = await Promise.allSettled([options.controller.checkAutomatically({ blockedPrepareVersion: persisted.blockedPrepareVersion }), options.updateCodexAutomatically?.(reserveCodexUpdate)]);
      const loaded = zeusResult.status === 'fulfilled' ? zeusResult.value : false;
      if (zeusResult.status === 'rejected') console.warn('Zeus 自动更新检测失败。', zeusResult.reason);
      if (companionResult.status === 'rejected') console.warn('Codex 后台更新未完成；已发起的目标不会自动重发，请在设置中检查。', companionResult.reason);
      if (!loaded && !stopped) scheduleAt(Date.now() + (options.failedCheckRetryMs ?? defaultFailedCheckRetryMs));
    } finally {
      checking = false;
      // 极慢预取跨过下一到期点时，原定时器可能已在串行任务期间触发；完成后必须重新挂回调度。
      if (!stopped && !checkTimer) scheduleFromLastCheck();
    }
  }

  /** 同一目标只自动提交一次；失败、断线或退出后继续保留记录，不猜测外部安装结果。 */
  async function reserveCodexUpdate(target: AutomaticCodexUpdateTarget, mayStart: () => boolean): Promise<boolean> {
    if (stopped || !mayStart() || !persisted.codexUpdateAttempts) return false;
    if (!isAutomaticCodexUpdateTarget(target)) throw new Error('Codex 自动更新缺少有效的安装路径或目标版本。');
    if (persisted.codexUpdateAttempts.some((attempt) => attempt.commandPath === target.commandPath && attempt.targetVersion === target.targetVersion)) return false;
    /** 复制冻结的目标，写入成功之前不能发送安装命令。 */
    const attempt = { ...target };
    persisted = { ...persisted, codexUpdateAttempts: [...persisted.codexUpdateAttempts, attempt] };
    if (!(await persistNow())) throw new Error('Codex 自动更新记录未能保存，本轮没有提交安装。');
    if (stopped || !mayStart()) {
      /** 落盘期间切回前台或关闭时还未发送请求，可以安全撤销本次意图。 */
      persisted = { ...persisted, codexUpdateAttempts: persisted.codexUpdateAttempts?.filter((entry) => entry !== attempt) ?? null };
      await persistNow();
      return false;
    }
    return true;
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
    if (state.phase === 'failed' && state.latestVersion && state.failure?.step !== 'check') blockedPrepareVersion = state.latestVersion;
    else if (state.phase === 'ready' || state.phase === 'manual' || state.phase === 'downloaded' || state.phase === 'idle' || (state.latestVersion && state.latestVersion !== previous.latestVersion)) blockedPrepareVersion = null;
    persisted = { ...persisted, blockedPrepareVersion, indicator: { ...state } };
    broadcastIndicator(state);
    schedulePersistence();
    if (state.phase !== 'ready' || !state.latestVersion || state.latestVersion === persisted.lastNotifiedVersion) return;
    const notified = options.notifyReady(state.latestVersion, () => options.controller.showOrCheck());
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

  /** 串行原子写入调度状态，并把真实写入结果交给自动安装门禁。 */
  function persistNow(): Promise<boolean> {
    /** 每次入队固定快照，后续状态修改不能改变已排队的写入内容。 */
    const snapshot = JSON.stringify(persisted, null, 2);
    persistChain = persistChain
      .then(async () => {
        await mkdir(dirname(options.statePath), { recursive: true, mode: 0o700 });
        /** 临时文件与目标同目录，rename 不暴露半份状态。 */
        const temporaryPath = `${options.statePath}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporaryPath, snapshot, { encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true });
          await rename(temporaryPath, options.statePath);
          return true;
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
      })
      .catch((error: unknown) => {
        console.warn('Zeus 无法持久化自动更新状态。', error);
        return false;
      });
    return persistChain;
  }

  /** 恢复同一份调度文件；Zeus 自身版本变化不能清除 Codex 的安装防重记录。 */
  async function start(): Promise<void> {
    if (started || stopped) return;
    started = true;
    /** 当前指示器仅用来替换不再匹配 Zeus 版本的旧展示状态。 */
    const restored = await readPersistedState(options.statePath, persisted);
    persisted = restored;
    options.controller.restoreIndicatorState(restored.indicator);
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

/** 旧文件没有 Codex 记录时从空列表开始；损坏或不可读时关闭自动安装，避免重发未知结果。 */
async function readPersistedState(path: string, fallback: PersistedAutomaticUpdateState): Promise<PersistedAutomaticUpdateState> {
  try {
    /** 本地状态文件也必须先核对结构，不能把损坏记录当成从未安装。 */
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('自动更新状态格式无效。');
    /** 缺失字段只表示该文件由尚未记录 Codex 安装目标的旧程序创建。 */
    const codexUpdateAttempts = value.codexUpdateAttempts === undefined ? [] : value.codexUpdateAttempts;
    if (codexUpdateAttempts !== null && (!Array.isArray(codexUpdateAttempts) || !codexUpdateAttempts.every(isAutomaticCodexUpdateTarget))) throw new Error('Codex 自动安装记录格式无效。');
    /** Zeus 升级后仍按原规则重置自己的调度展示，但保留独立的 Codex 安装记录。 */
    if (!isIndicatorState(value.indicator, fallback.indicator.currentVersion)) return { ...fallback, codexUpdateAttempts };
    return {
      schemaVersion: 1,
      lastCheckCompletedAt: typeof value.lastCheckCompletedAt === 'string' && normalizeIsoDate(value.lastCheckCompletedAt) ? normalizeIsoDate(value.lastCheckCompletedAt) : null,
      lastNotifiedVersion: typeof value.lastNotifiedVersion === 'string' && value.lastNotifiedVersion.trim() ? value.lastNotifiedVersion.trim() : null,
      blockedPrepareVersion: typeof value.blockedPrepareVersion === 'string' && value.blockedPrepareVersion.trim() ? value.blockedPrepareVersion.trim() : null,
      codexUpdateAttempts,
      indicator: value.indicator,
    };
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return fallback;
    console.warn('自动更新状态无法读取，Codex 仅检测和提示，不自动安装。', error);
    return { ...fallback, codexUpdateAttempts: null };
  }
}

/** 安装目标必须包含绝对程序路径和服务端支持的版本格式。 */
export function isAutomaticCodexUpdateTarget(value: unknown): value is AutomaticCodexUpdateTarget {
  return isRecord(value) && typeof value.commandPath === 'string' && isAbsolute(value.commandPath) && typeof value.targetVersion === 'string' && /^\d+\.\d+\.\d+(?:-(?:alpha|beta)(?:\.\d+)*)?$/u.test(value.targetVersion);
}

function isIndicatorState(value: unknown, currentVersion: string): value is HomebrewUpdateIndicatorState {
  if (!isRecord(value)) return false;
  return (
    ['idle', 'available', 'manual', 'downloaded', 'preparing', 'retrying', 'ready', 'failed'].includes(String(value.phase)) &&
    value.currentVersion === currentVersion &&
    (value.latestVersion === null || typeof value.latestVersion === 'string') &&
    typeof value.detail === 'string' &&
    typeof value.updatedAt === 'string' &&
    normalizeIsoDate(value.updatedAt) !== null &&
    (value.progress === undefined || (typeof value.progress === 'number' && Number.isFinite(value.progress) && value.progress >= 0 && value.progress <= 1)) &&
    (value.retryAt === undefined || (typeof value.retryAt === 'string' && normalizeIsoDate(value.retryAt) !== null)) &&
    (value.failure === undefined ||
      (isRecord(value.failure) &&
        ['check', 'prepare', 'download', 'install'].includes(String(value.failure.step)) &&
        typeof value.failure.title === 'string' &&
        typeof value.failure.canRetry === 'boolean' &&
        (value.failure.technicalDetail === undefined || typeof value.failure.technicalDetail === 'string')))
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
