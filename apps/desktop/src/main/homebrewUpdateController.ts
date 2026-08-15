import type { DesktopReleaseUpdateStatus } from './releaseUpdateService.js';
import { isTransientHomebrewDownloadError, type HomebrewPreparedUpdate, type HomebrewUpdateProgress, type HomebrewUpdateService } from './homebrewUpdateService.js';
import { createNativeUpdateProgressHost, type NativeUpdateProgressHost, type NativeUpdateProgressState } from './nativeUpdateProgress.js';

export type HomebrewUpdateIndicatorPhase = 'idle' | 'available' | 'preparing' | 'retrying' | 'ready' | 'failed';

export interface HomebrewUpdateIndicatorState {
  phase: HomebrewUpdateIndicatorPhase;
  currentVersion: string;
  latestVersion: string | null;
  detail: string;
  updatedAt: string;
  progress?: number;
  retryAt?: string;
}

export interface HomebrewUpdateController {
  showOrCheck(): Promise<void>;
  checkAutomatically(input?: { blockedPrepareVersion?: string | null }): Promise<boolean>;
  getIndicatorState(): HomebrewUpdateIndicatorState;
  restoreIndicatorState(state: HomebrewUpdateIndicatorState): void;
  onIndicatorState(listener: (state: HomebrewUpdateIndicatorState) => void): () => void;
  onCheckCompleted(listener: (checkedAt: string) => void): () => void;
  close(): void;
}

interface CreateHomebrewUpdateControllerOptions {
  helperPath: string;
  language: () => 'zh-CN' | 'en-US';
  loadUpdateStatus: () => Promise<DesktopReleaseUpdateStatus>;
  homebrew: HomebrewUpdateService;
  currentVersion: string;
  canInstall: () => void;
  onInstallReady: () => void;
  retryDelaysMs?: readonly number[];
}

type ControllerPhase = 'idle' | 'checking' | 'available' | 'preparing' | 'ready' | 'installing' | 'failed' | 'upToDate';

const defaultRetryDelaysMs = [60_000, 5 * 60_000] as const;

/** 原生窗口可以隐藏或重启，但唯一后台更新任务不因窗口生命周期重复执行。 */
export function createHomebrewUpdateController(options: CreateHomebrewUpdateControllerOptions): HomebrewUpdateController {
  let host: NativeUpdateProgressHost | null = null;
  let phase: ControllerPhase = 'idle';
  let hidden = false;
  let closed = false;
  let currentUpdate: DesktopReleaseUpdateStatus | null = null;
  let prepared: HomebrewPreparedUpdate | null = null;
  let lastState: NativeUpdateProgressState | null = null;
  let lastFailureStep: 'check' | 'prepare' | 'install' = 'check';
  let operation: Promise<void> | null = null;
  let indicatorState = idleIndicator(options.currentVersion);
  const indicatorListeners = new Set<(state: HomebrewUpdateIndicatorState) => void>();
  const checkCompletedListeners = new Set<(checkedAt: string) => void>();
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;

  async function ensureHost(): Promise<NativeUpdateProgressHost> {
    if (host) return host;
    const created = await createNativeUpdateProgressHost({
      executablePath: options.helperPath,
      language: options.language(),
    });
    host = created;
    created.onAction((action) => {
      if (action === 'closed' || action === 'later' || action === 'close') {
        hidden = true;
        return;
      }
      hidden = false;
      if (action === 'download') void runExclusive(() => prepareUpdate(false));
      else if (action === 'restart') void runExclusive(installPreparedUpdate);
      else if (action === 'retry') {
        if (lastFailureStep === 'install' && prepared) void runExclusive(installPreparedUpdate);
        else if (lastFailureStep === 'prepare' || indicatorState.phase === 'failed') void runExclusive(() => prepareUpdate(false));
        else void runExclusive(() => checkForUpdate(true, true).then(() => undefined));
      }
    });
    created.onExit(() => {
      if (host === created) host = null;
      hidden = true;
    });
    if (lastState) created.update({ ...lastState, present: !hidden });
    return created;
  }

  function runExclusive(task: () => Promise<void>): Promise<void> {
    if (operation) return operation;
    const running = task().finally(() => {
      if (operation === running) operation = null;
    });
    operation = running;
    return running;
  }

  function setIndicator(next: Omit<HomebrewUpdateIndicatorState, 'updatedAt'> & { updatedAt?: string }): void {
    indicatorState = {
      ...next,
      updatedAt: next.updatedAt ?? new Date().toISOString(),
    };
    for (const listener of indicatorListeners) listener({ ...indicatorState });
  }

  async function publish(state: NativeUpdateProgressState): Promise<void> {
    lastState = { ...state, present: !hidden };
    if (hidden && !host) return;
    const currentHost = await ensureHost();
    currentHost.update(lastState);
  }

  async function checkForUpdate(present: boolean, updateIndicator: boolean): Promise<DesktopReleaseUpdateStatus | null> {
    phase = 'checking';
    prepared = null;
    currentUpdate = null;
    lastFailureStep = 'check';
    if (present) {
      await publish(copyFor(options.language(), 'checking', options.currentVersion));
      (await ensureHost()).show();
    }
    try {
      const update = await retryOperation(options.loadUpdateStatus, 2);
      currentUpdate = update;
      const checkedAt = validIsoDate(update.checkedAt) ?? new Date().toISOString();
      for (const listener of checkCompletedListeners) listener(checkedAt);
      if (update.status === 'up_to_date') {
        phase = 'upToDate';
        if (updateIndicator) setIndicator(idleIndicator(options.currentVersion));
        if (present) await publish(copyFor(options.language(), 'upToDate', options.currentVersion, update));
        return update;
      }
      if (update.status !== 'available' || !update.artifact) {
        if (present) throw new Error(update.reason || '暂时无法取得可用更新。');
        return update;
      }
      phase = 'available';
      if (updateIndicator) setIndicator(indicatorForAvailable(options.language(), update));
      if (present) await publish(copyFor(options.language(), 'available', options.currentVersion, update));
      return update;
    } catch (error) {
      phase = 'failed';
      if (present) await publish(failedCopy(options.language(), error, 'check'));
      return null;
    }
  }

  async function prepareUpdate(automatic: boolean): Promise<void> {
    if (!currentUpdate || currentUpdate.status !== 'available' || !currentUpdate.artifact) {
      const loaded = await checkForUpdate(!automatic, true);
      if (!loaded || loaded.status !== 'available' || !loaded.artifact) return;
    }
    phase = 'preparing';
    lastFailureStep = 'prepare';
    const update = currentUpdate!;
    setIndicator(indicatorForPreparing(options.language(), update));
    for (let attempt = 0; ; attempt += 1) {
      try {
        prepared = await options.homebrew.prepare(update, (progress) => {
          const nativeState = progressCopy(options.language(), progress, update);
          setIndicator(indicatorFromProgress(options.language(), progress, update));
          void publish(nativeState);
        });
        phase = 'ready';
        setIndicator(indicatorForReady(options.language(), update));
        await publish(copyFor(options.language(), 'ready', options.currentVersion, update));
        return;
      } catch (error) {
        const retryDelayMs = retryDelaysMs[attempt];
        if (automatic && retryDelayMs !== undefined && isTransientHomebrewDownloadError(error)) {
          const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
          setIndicator(indicatorForRetry(options.language(), update, retryAt));
          await publish(retryCopy(options.language(), retryAt));
          await wait(retryDelayMs);
          if (closed) return;
          phase = 'preparing';
          setIndicator(indicatorForPreparing(options.language(), update));
          continue;
        }
        phase = 'failed';
        setIndicator(indicatorForFailed(options.language(), update));
        await publish(failedCopy(options.language(), error, 'prepare'));
        return;
      }
    }
  }

  async function installPreparedUpdate(): Promise<void> {
    if (!prepared) {
      await prepareUpdate(false);
      if (!prepared) return;
    }
    lastFailureStep = 'install';
    try {
      options.canInstall();
      phase = 'installing';
      await publish(copyFor(options.language(), 'installing', options.currentVersion, prepared.update));
      const installed = await options.homebrew.install(prepared, (progress) => {
        void publish(progressCopy(options.language(), progress, prepared!.update));
      });
      const currentHost = await ensureHost();
      currentHost.relaunchAfterProcessExit({ pid: process.pid, ...installed });
      options.onInstallReady();
    } catch (error) {
      phase = 'failed';
      setIndicator(indicatorForFailed(options.language(), prepared.update));
      await publish(failedCopy(options.language(), error, 'install'));
    }
  }

  async function showCurrent(): Promise<void> {
    hidden = false;
    const currentHost = await ensureHost();
    if (lastState) currentHost.update({ ...lastState, present: true });
    currentHost.show();
  }

  async function checkAutomatically(input?: { blockedPrepareVersion?: string | null }): Promise<boolean> {
    hidden = true;
    let loaded = false;
    await runExclusive(async () => {
      const previousIndicator = indicatorState;
      const previousPrepared = prepared;
      const update = await checkForUpdate(false, false);
      if (!update) return;
      loaded = true;
      if (update.status === 'up_to_date') {
        setIndicator(idleIndicator(options.currentVersion));
        return;
      }
      if (update.status !== 'available' || !update.artifact) {
        phase = 'failed';
        setIndicator(indicatorForUnavailable(options.language(), update));
        lastState = failedCopy(options.language(), update.reason || '暂时无法预取更新。', 'prepare');
        return;
      }
      if (input?.blockedPrepareVersion === update.latestVersion && previousIndicator.phase === 'failed' && previousIndicator.latestVersion === update.latestVersion) {
        phase = 'failed';
        setIndicator({ ...previousIndicator, updatedAt: new Date().toISOString() });
        return;
      }
      if (previousIndicator.phase === 'ready' && previousIndicator.latestVersion === update.latestVersion && previousPrepared) {
        prepared = previousPrepared;
        phase = 'ready';
        setIndicator({ ...previousIndicator, updatedAt: new Date().toISOString() });
        return;
      }
      setIndicator(indicatorForAvailable(options.language(), update));
      await prepareUpdate(true);
    });
    return loaded;
  }

  return {
    showOrCheck: () => {
      if (phase === 'preparing' || phase === 'ready' || phase === 'installing' || phase === 'available' || (phase === 'failed' && lastState)) return showCurrent();
      hidden = false;
      return runExclusive(() => checkForUpdate(true, true).then(() => undefined));
    },
    checkAutomatically,
    getIndicatorState: () => ({ ...indicatorState }),
    restoreIndicatorState: (state) => {
      if (!isIndicatorState(state) || state.currentVersion !== options.currentVersion || state.phase === 'idle') return;
      indicatorState = { ...state };
      phase = state.phase === 'ready' ? 'ready' : state.phase === 'failed' ? 'failed' : 'available';
      lastFailureStep = state.phase === 'failed' ? 'prepare' : 'check';
      lastState = nativeStateFromIndicator(options.language(), state);
    },
    onIndicatorState: (listener) => {
      indicatorListeners.add(listener);
      return () => indicatorListeners.delete(listener);
    },
    onCheckCompleted: (listener) => {
      checkCompletedListeners.add(listener);
      return () => checkCompletedListeners.delete(listener);
    },
    close: () => {
      closed = true;
      host?.close();
      host = null;
      indicatorListeners.clear();
      checkCompletedListeners.clear();
    },
  };
}

function idleIndicator(currentVersion: string): HomebrewUpdateIndicatorState {
  return {
    phase: 'idle',
    currentVersion,
    latestVersion: null,
    detail: '',
    updatedAt: new Date().toISOString(),
  };
}

function indicatorForAvailable(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  return {
    phase: 'available',
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    detail: language === 'zh-CN' ? `Zeus ${update.latestVersion} 可用，正在准备后台下载。` : `Zeus ${update.latestVersion} is available and will be downloaded in the background.`,
  };
}

function indicatorForPreparing(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  return {
    phase: 'preparing',
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    detail: language === 'zh-CN' ? `正在下载并校验 Zeus ${update.latestVersion}。` : `Downloading and verifying Zeus ${update.latestVersion}.`,
  };
}

function indicatorFromProgress(language: 'zh-CN' | 'en-US', progress: HomebrewUpdateProgress, update: DesktopReleaseUpdateStatus): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  const ratio = progress.downloadedBytes !== undefined && progress.totalBytes !== undefined && progress.totalBytes > 0 ? Math.min(1, progress.downloadedBytes / progress.totalBytes) : undefined;
  return {
    ...indicatorForPreparing(language, update),
    ...(ratio === undefined ? {} : { progress: ratio }),
  };
}

function indicatorForRetry(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus, retryAt: string): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  return {
    phase: 'retrying',
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    detail: language === 'zh-CN' ? `下载暂时中断，将自动重试 Zeus ${update.latestVersion}。` : `The download was interrupted and Zeus ${update.latestVersion} will be retried automatically.`,
    retryAt,
  };
}

function indicatorForReady(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  return {
    phase: 'ready',
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    detail: language === 'zh-CN' ? `Zeus ${update.latestVersion} 已下载并通过校验，等待你决定何时重启。` : `Zeus ${update.latestVersion} is downloaded and verified, waiting for you to choose when to restart.`,
    progress: 1,
  };
}

function indicatorForFailed(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  return {
    phase: 'failed',
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion,
    detail: language === 'zh-CN' ? '更新下载未能完成，点击查看原因并重试。' : 'The update download could not be completed. Open it to review the reason and retry.',
  };
}

function indicatorForUnavailable(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus): Omit<HomebrewUpdateIndicatorState, 'updatedAt'> {
  return {
    phase: 'failed',
    currentVersion: update.currentVersion,
    latestVersion: update.latestVersion || null,
    detail: language === 'zh-CN' ? '发现版本变化，但暂时没有可安全预取的更新包。' : 'A version change was found, but no update can be safely prefetched yet.',
  };
}

function copyFor(language: 'zh-CN' | 'en-US', state: 'checking' | 'available' | 'upToDate' | 'ready' | 'installing', currentVersion: string, update?: DesktopReleaseUpdateStatus): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  const latestVersion = update?.latestVersion ?? currentVersion;
  if (state === 'checking') {
    return {
      state,
      title: zh ? '正在检查更新' : 'Checking for Updates',
      detail: zh ? 'Zeus 正在读取公开稳定版发布清单。' : 'Zeus is reading the public stable release manifest.',
      progressCaption: zh ? '正在读取发布清单' : 'Reading release manifest',
    };
  }
  if (state === 'available') {
    return {
      state,
      title: zh ? '发现新版本' : 'A New Version Is Available',
      detail: zh
        ? `当前版本 ${currentVersion}，最新版本 ${latestVersion}。Zeus 可以在后台通过 Homebrew 下载并校验更新。`
        : `Current version ${currentVersion}; latest version ${latestVersion}. Zeus can download and verify the update with Homebrew in the background.`,
    };
  }
  if (state === 'upToDate') {
    return {
      state,
      title: zh ? 'Zeus 已是最新版本' : 'Zeus Is Up to Date',
      detail: zh ? `当前版本 ${currentVersion}。` : `Current version ${currentVersion}.`,
    };
  }
  if (state === 'ready') {
    return {
      state,
      title: zh ? '更新已下载' : 'Update Downloaded',
      detail: zh ? `Zeus ${latestVersion} 已通过 Homebrew 校验。点击“立即重启”后才会安装并切换到新版。` : `Zeus ${latestVersion} passed Homebrew verification. It will only be installed after you choose Restart Now.`,
    };
  }
  return {
    state,
    title: zh ? '正在安装更新' : 'Installing Update',
    detail: zh ? `Homebrew 正在使用已缓存的 Zeus ${latestVersion} 安装包。安装成功后 Zeus 会重新打开。` : `Homebrew is installing the cached Zeus ${latestVersion} update. Zeus will reopen after installation succeeds.`,
    progressCaption: zh ? `正在安装 Zeus ${latestVersion}` : `Installing Zeus ${latestVersion}`,
  };
}

function progressCopy(language: 'zh-CN' | 'en-US', progress: HomebrewUpdateProgress, update: DesktopReleaseUpdateStatus): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  if (progress.phase === 'updating') {
    return {
      state: 'updating',
      title: zh ? '正在更新 Homebrew 信息' : 'Updating Homebrew Information',
      detail: zh ? 'Zeus 正在刷新公开 Cask，不会阻止你继续工作。' : 'Zeus is refreshing the public Cask without blocking your work.',
      progressCaption: zh ? '正在更新 Homebrew 信息' : 'Updating Homebrew information',
    };
  }
  if (progress.phase === 'verifying') {
    return {
      state: 'verifying',
      title: zh ? '正在校验更新' : 'Verifying Update',
      detail: zh ? `Homebrew 与 Zeus 正在复验 ${update.artifact?.fileName ?? update.latestVersion} 的大小和 SHA-256。` : `Homebrew and Zeus are verifying the size and SHA-256 of ${update.artifact?.fileName ?? update.latestVersion}.`,
      progressCaption: zh ? '正在校验下载内容' : 'Verifying downloaded update',
    };
  }
  if (progress.phase === 'installing') return copyFor(language, 'installing', update.currentVersion, update);
  const totalBytes = progress.totalBytes;
  const downloadedBytes = progress.downloadedBytes;
  const ratio = downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : undefined;
  return {
    state: 'downloading',
    title: zh ? '正在下载 Zeus 更新' : 'Downloading Zeus Update',
    detail: zh ? `正在通过 Homebrew 下载 Zeus ${update.latestVersion}；你可以继续使用 Zeus。` : `Downloading Zeus ${update.latestVersion} with Homebrew. You can keep using Zeus.`,
    progressCaption: zh ? `正在下载 Zeus ${update.latestVersion}` : `Downloading Zeus ${update.latestVersion}`,
    ...(ratio === undefined ? {} : { progress: ratio, progressText: formatPercent(ratio) }),
  };
}

function retryCopy(language: 'zh-CN' | 'en-US', retryAt: string): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  return {
    state: 'downloading',
    title: zh ? '下载暂时中断' : 'Download Interrupted',
    detail: zh ? `Zeus 将在 ${formatLocalTime(retryAt, language)} 自动重试。` : `Zeus will retry automatically at ${formatLocalTime(retryAt, language)}.`,
    progressCaption: zh ? '等待自动重试' : 'Waiting to retry',
  };
}

function failedCopy(language: 'zh-CN' | 'en-US', error: unknown, step: 'check' | 'prepare' | 'install'): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  const technicalDetail = error instanceof Error ? error.message : String(error);
  const copy = {
    check: {
      title: zh ? '无法检查更新' : 'Could Not Check for Updates',
      detail: zh ? '暂时无法取得最新版本信息。Zeus 没有发生变化，你可以稍后重试。' : 'The latest version information is temporarily unavailable. Zeus was not changed; you can try again later.',
    },
    prepare: {
      title: zh ? '更新下载失败' : 'Update Download Failed',
      detail: zh ? 'Zeus 未被替换，你可以继续工作。' : 'Zeus was not replaced. You can keep working.',
    },
    install: {
      title: zh ? '更新安装失败' : 'Update Installation Failed',
      detail: zh ? 'Zeus 未完成替换，现有工作可以继续。' : 'Zeus was not replaced successfully. Your existing work can continue.',
    },
  }[step];
  return {
    state: 'failed',
    title: copy.title,
    detail: copy.detail,
    ...(technicalDetail.trim() ? { technicalDetail: technicalDetail.trim() } : {}),
  };
}

function nativeStateFromIndicator(language: 'zh-CN' | 'en-US', state: HomebrewUpdateIndicatorState): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  if (state.phase === 'ready') {
    return {
      state: 'ready',
      title: zh ? '更新已下载' : 'Update Downloaded',
      detail: state.detail,
      present: false,
    };
  }
  if (state.phase === 'failed') return { ...failedCopy(language, state.detail, 'prepare'), present: false };
  return {
    state: 'available',
    title: zh ? '发现新版本' : 'A New Version Is Available',
    detail: state.detail,
    present: false,
  };
}

function isIndicatorState(value: HomebrewUpdateIndicatorState): boolean {
  return (
    Boolean(value) &&
    ['idle', 'available', 'preparing', 'retrying', 'ready', 'failed'].includes(value.phase) &&
    typeof value.currentVersion === 'string' &&
    (value.latestVersion === null || typeof value.latestVersion === 'string') &&
    typeof value.detail === 'string' &&
    validIsoDate(value.updatedAt) !== null
  );
}

function validIsoDate(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, delayMs);
    timer.unref();
  });
}

function formatPercent(ratio: number): string {
  return `${Math.min(100, Math.floor(Math.max(0, ratio) * 100))}%`;
}

function formatLocalTime(value: string, language: 'zh-CN' | 'en-US'): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

/** Release 检查只读取外部事实；临时失败允许两次短间隔重试。 */
async function retryOperation<T>(operation: () => Promise<T>, retryCount: number): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retryCount) break;
      await delay(attempt === 0 ? 400 : 1_200);
    }
  }
  throw lastError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
