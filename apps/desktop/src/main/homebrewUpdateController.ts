import { describeUserFacingError, redactUserFacingErrorDetails } from '@zeus/shared';
import type { DesktopReleaseUpdateStatus, ReleaseManualInstallReason, ReleaseUpdateService } from './releaseUpdateService.js';
import { type HomebrewInstalledUpdate, type HomebrewPreparedUpdate, type HomebrewUpdateProgress, type HomebrewUpdateService, isTransientHomebrewDownloadError } from './homebrewUpdateService.js';
import { createNativeUpdateProgressHost, type NativeUpdateProgressHost, type NativeUpdateProgressState } from './nativeUpdateProgress.js';

export type HomebrewUpdateIndicatorPhase = 'idle' | 'available' | 'manual' | 'preparing' | 'retrying' | 'ready' | 'failed';

export interface HomebrewUpdateIndicatorState {
  phase: HomebrewUpdateIndicatorPhase;
  currentVersion: string;
  latestVersion: string | null;
  detail: string;
  updatedAt: string;
  progress?: number;
  retryAt?: string;
  /** 保存可读原因和失败阶段，重新打开应用后仍能解释和安全重试。 */
  failure?: { step: UpdateFailureStep; title: string; technicalDetail?: string; canRetry: boolean };
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
  /** DMG 安装复用已有直接更新与安装交接。 */
  direct: ReleaseUpdateService;
  /** 仅在用户点击后打开经过 Main 校验的官方发布页。 */
  openDownloadPage: (url: string) => Promise<void>;
  currentVersion: string;
  canInstall: () => void;
  onInstallReady: (targetExecutionHostProtocolVersion: number, activate: () => void | Promise<void>) => Promise<boolean>;
  retryDelaysMs?: readonly number[];
}

type ControllerPhase = 'idle' | 'checking' | 'available' | 'manual' | 'preparing' | 'ready' | 'installing' | 'failed' | 'upToDate';

/** 失败阶段决定提示与可执行动作，不从失败状态推断下载故障。 */
type UpdateFailureStep = 'check' | 'prepare' | 'download' | 'install';

/** 两种更新方式共享窗口、状态与调度，安装仍由各自服务完成。 */
type PreparedUpdate = (HomebrewPreparedUpdate & { method: 'homebrew' }) | { method: 'direct'; update: DesktopReleaseUpdateStatus };

const defaultRetryDelaysMs = [60_000, 5 * 60_000] as const;

/** 原生窗口可以隐藏或重启，但唯一后台更新任务不因窗口生命周期重复执行。 */
export function createHomebrewUpdateController(options: CreateHomebrewUpdateControllerOptions): HomebrewUpdateController {
  let host: NativeUpdateProgressHost | null = null;
  let phase: ControllerPhase = 'idle';
  let hidden = false;
  let closed = false;
  let currentUpdate: DesktopReleaseUpdateStatus | null = null;
  let prepared: PreparedUpdate | null = null;
  let installed: HomebrewInstalledUpdate | null = null;
  /** 每次重新检查安装记录，不根据最初下载方式永久推断。 */
  let updateMethod: 'homebrew' | 'direct' | null = null;
  let lastState: NativeUpdateProgressState | null = null;
  let lastFailureStep: UpdateFailureStep = 'check';
  let operation: Promise<void> | null = null;
  let indicatorState = idleIndicator(options.currentVersion);
  const indicatorListeners = new Set<(state: HomebrewUpdateIndicatorState) => void>();
  const checkCompletedListeners = new Set<(checkedAt: string) => void>();
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;

  async function ensureHost(): Promise<NativeUpdateProgressHost> {
    if (host) return host;
    const created = await createNativeUpdateProgressHost({
      executablePath: options.helperPath,
      language: options.language,
    });
    host = created;
    created.onAction((action) => {
      if (action === 'closed' || action === 'later' || action === 'close') {
        hidden = true;
        return;
      }
      hidden = false;
      if (action === 'download') void runExclusive(() => prepareUpdate(false));
      else if (action === 'check') void runExclusive(() => checkForUpdate(true, true).then(() => undefined));
      else if (action === 'open_download_page') void runExclusive(openDownloadPage);
      else if (action === 'reconnect' && updateMethod === 'homebrew') options.homebrew.reconnectDownload();
      else if (action === 'restart') void runExclusive(installPreparedUpdate);
      else if (action === 'retry') {
        if (lastFailureStep === 'install' && prepared) void runExclusive(installPreparedUpdate);
        else if (lastFailureStep === 'prepare' || lastFailureStep === 'download') void runExclusive(() => prepareUpdate(false));
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
        prepared = null;
        installed = null;
        phase = 'upToDate';
        if (updateIndicator) setIndicator(idleIndicator(options.currentVersion));
        if (present) await publish(copyFor(options.language(), 'upToDate', options.currentVersion, update));
        return update;
      }
      if (update.status !== 'available' || !update.artifact) {
        if (!update.latestVersion || update.latestVersion === update.currentVersion) throw new Error(update.reason || '暂时无法取得可用更新。');
        await publishManualUpdate(update, 'release');
        return update;
      }
      updateMethod = (await options.homebrew.isManaged()) ? 'homebrew' : 'direct';
      const manualReason = updateMethod === 'direct' ? await options.direct.manualInstallReason(update) : null;
      if (manualReason) {
        await publishManualUpdate(update, manualReason);
        return update;
      }
      if (prepared && prepared.method === updateMethod && samePreparedUpdate(prepared, update)) {
        phase = 'ready';
        if (updateIndicator) setIndicator(indicatorForReady(options.language(), update));
        if (present) await publish(copyFor(options.language(), 'ready', options.currentVersion, update));
        return update;
      }
      prepared = null;
      installed = null;
      phase = 'available';
      if (updateIndicator) setIndicator(indicatorForAvailable(options.language(), update));
      if (present) await publish(copyFor(options.language(), 'available', options.currentVersion, update));
      return update;
    } catch (error) {
      await publishFailure(error, 'check');
      return null;
    }
  }

  async function prepareUpdate(automatic: boolean): Promise<void> {
    if (!currentUpdate || !updateMethod || phase === 'failed' || currentUpdate.status !== 'available' || !currentUpdate.artifact) {
      const loaded = await checkForUpdate(!automatic, true);
      if (!loaded || loaded.status !== 'available' || !loaded.artifact) return;
    }
    if (phase === 'manual') return;
    phase = 'preparing';
    lastFailureStep = 'prepare';
    const update = currentUpdate!;
    setIndicator(indicatorForPreparing(options.language(), update));
    for (let attempt = 0; ; attempt += 1) {
      try {
        /** 两条下载路径只用真实进度驱动同一窗口。 */
        const onProgress = (progress: HomebrewUpdateProgress): void => {
          lastFailureStep = progress.phase === 'downloading' || progress.phase === 'reconnecting' ? 'download' : 'prepare';
          setIndicator(indicatorFromProgress(options.language(), progress, update));
          void publish(progressCopy(options.language(), progress, update, updateMethod === 'direct'));
        };
        if (updateMethod === 'homebrew') {
          prepared = { ...(await options.homebrew.prepare(update, onProgress)), method: 'homebrew' };
        } else {
          const result = await options.direct.download(onProgress);
          if (!result.accepted) throw new Error(result.reason);
          prepared = { method: 'direct', update: result.update };
          currentUpdate = result.update;
        }
        phase = 'ready';
        setIndicator(indicatorForReady(options.language(), prepared.update));
        await publish(copyFor(options.language(), 'ready', options.currentVersion, prepared.update));
        return;
      } catch (error) {
        const retryDelayMs = retryDelaysMs[attempt];
        if (automatic && retryDelayMs !== undefined && isTransientUpdateDownloadError(error)) {
          const retryAt = new Date(Date.now() + retryDelayMs).toISOString();
          setIndicator(indicatorForRetry(options.language(), update, retryAt));
          await publish(retryCopy(options.language(), retryAt));
          await wait(retryDelayMs);
          if (closed) return;
          phase = 'preparing';
          setIndicator(indicatorForPreparing(options.language(), update));
          continue;
        }
        prepared = null;
        await publishFailure(error, lastFailureStep);
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
      if ((await options.homebrew.isManaged()) !== (prepared.method === 'homebrew')) throw new Error('Zeus 的安装管理方式已变化，请重新检查更新。');
      /** 用户取消退出时保留下载结果；直接安装由原安装器完成退出后的替换。 */
      let accepted: boolean;
      if (prepared.method === 'direct') {
        const result = await options.direct.install();
        if (!result.accepted) {
          prepared = null;
          await checkForUpdate(true, true);
          return;
        }
        accepted = result.restartAccepted === true;
      } else {
        installed ??= await options.homebrew.install(prepared, (progress) => {
          void publish(progressCopy(options.language(), progress, prepared!.update));
        });
        accepted = await options.onInstallReady(prepared.update.executionHostProtocolVersion, async () => {
          const currentHost = await ensureHost();
          currentHost.relaunchAfterProcessExit({ pid: process.pid, ...installed! });
        });
      }
      if (!accepted) {
        phase = 'ready';
        setIndicator(indicatorForReady(options.language(), prepared.update));
        await publish(copyFor(options.language(), 'ready', options.currentVersion, prepared.update));
      }
    } catch (error) {
      await publishFailure(error, 'install');
    }
  }

  /** 需要手动安装是正常更新状态，不进入后台下载失败和自动重试。 */
  async function publishManualUpdate(update: DesktopReleaseUpdateStatus, reason: ReleaseManualInstallReason): Promise<void> {
    prepared = null;
    installed = null;
    phase = 'manual';
    const state = manualCopy(options.language(), update, reason);
    setIndicator({ phase: 'manual', currentVersion: options.currentVersion, latestVersion: update.latestVersion, detail: state.detail });
    await publish(state);
  }

  /** 保存脱敏后的真实原因，恢复窗口时不用通用错误覆盖它。 */
  async function publishFailure(error: unknown, step: UpdateFailureStep): Promise<void> {
    phase = 'failed';
    lastFailureStep = step;
    const state = failedCopy(options.language(), error, step);
    setIndicator({
      phase: 'failed',
      currentVersion: options.currentVersion,
      latestVersion: currentUpdate?.latestVersion ?? null,
      detail: state.detail,
      failure: { step, title: state.title, technicalDetail: state.technicalDetail, canRetry: state.canRetry === true },
    });
    await publish(state);
  }

  /** 点击下载页面前重新读取发布信息，持久化状态不能直接决定外部地址。 */
  async function openDownloadPage(): Promise<void> {
    const update = await checkForUpdate(false, true);
    if (!update) return;
    try {
      if (phase === 'manual') await options.openDownloadPage(update.releasePageUrl);
      else await showCurrent();
    } catch (error) {
      await publishFailure(error, 'check');
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
      const update = await checkForUpdate(false, false);
      if (!update) return;
      loaded = true;
      if (update.status === 'up_to_date') {
        setIndicator(idleIndicator(options.currentVersion));
        return;
      }
      if (phase === 'manual') return;
      if (input?.blockedPrepareVersion === update.latestVersion && previousIndicator.failure?.step !== 'check' && previousIndicator.phase === 'failed' && previousIndicator.latestVersion === update.latestVersion) {
        phase = 'failed';
        setIndicator({ ...previousIndicator, updatedAt: new Date().toISOString() });
        lastFailureStep = previousIndicator.failure?.step ?? 'check';
        lastState = nativeStateFromIndicator(options.language(), previousIndicator);
        return;
      }
      if (phase === 'ready' && prepared) {
        setIndicator(indicatorForReady(options.language(), update));
        return;
      }
      setIndicator(indicatorForAvailable(options.language(), update));
      await prepareUpdate(true);
    });
    return loaded;
  }

  return {
    showOrCheck: () => {
      if (phase === 'preparing' || phase === 'installing' || (phase === 'available' && currentUpdate) || (phase === 'failed' && lastState?.state === 'failed')) return showCurrent();
      hidden = false;
      return runExclusive(() => checkForUpdate(true, true).then(() => undefined));
    },
    checkAutomatically,
    getIndicatorState: () => ({ ...indicatorState }),
    restoreIndicatorState: (state) => {
      if (!isIndicatorState(state) || state.currentVersion !== options.currentVersion || state.phase === 'idle') return;
      indicatorState = { ...state };
      phase = state.phase === 'ready' ? 'ready' : state.phase === 'failed' ? 'failed' : state.phase === 'manual' ? 'manual' : 'available';
      lastFailureStep = state.failure?.step ?? 'check';
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

/** 只有安装方式、版本与摘要一致的准备结果才可继续复用。 */
function samePreparedUpdate(prepared: PreparedUpdate, update: DesktopReleaseUpdateStatus): boolean {
  return prepared.update.latestVersion === update.latestVersion && prepared.update.artifact?.sha256 === update.artifact?.sha256;
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

/** 手动更新说明只描述用户下一步，不要求用户理解安装工具内部概念。 */
function manualCopy(language: 'zh-CN' | 'en-US', update: DesktopReleaseUpdateStatus, reason: ReleaseManualInstallReason): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  const reasons = {
    release: zh ? '此版本需要通过下载页面手动安装。' : 'This release requires manual installation from the download page.',
    protocol: zh ? '此版本需要先结束正在进行的工作，再手动安装。' : 'Finish active work before installing this release manually.',
    location: zh ? '当前应用的位置无法自动替换，请将新版拖入“应用程序”完成安装。' : 'This app cannot be replaced in its current location. Drag the new version into Applications.',
    signature: zh ? '请先手动安装一次正式签名版本，后续即可使用应用内更新。' : 'Install a Developer ID-signed release manually once to enable future in-app updates.',
  };
  return { state: 'manual', title: zh ? '发现新版本' : 'A New Version Is Available', detail: `${zh ? `Zeus ${update.latestVersion} 可用。` : `Zeus ${update.latestVersion} is available. `}${reasons[reason]}` };
}

function copyFor(language: 'zh-CN' | 'en-US', state: 'checking' | 'available' | 'upToDate' | 'ready' | 'installing', currentVersion: string, update?: DesktopReleaseUpdateStatus): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  const latestVersion = update?.latestVersion ?? currentVersion;
  if (state === 'checking') {
    return {
      state,
      title: zh ? '正在检查更新' : 'Checking for Updates',
      detail: zh ? '正在检查是否有可安装的新版本。' : 'Checking whether a new version is available to install.',
      progressCaption: zh ? '正在检查最新版本' : 'Checking the latest version',
    };
  }
  if (state === 'available') {
    return {
      state,
      title: zh ? '发现新版本' : 'A New Version Is Available',
      detail: zh ? `当前版本 ${currentVersion}，最新版本 ${latestVersion}。Zeus 可以在后台下载并校验更新。` : `Current version ${currentVersion}; latest version ${latestVersion}. Zeus can download and verify the update in the background.`,
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
      detail: zh ? `Zeus ${latestVersion} 已下载并通过校验。点击“立即重启”后才会安装并切换到新版。` : `Zeus ${latestVersion} has been downloaded and verified. It will only be installed after you choose Restart Now.`,
    };
  }
  return {
    state,
    title: zh ? '正在安装更新' : 'Installing Update',
    detail: zh ? `正在使用已缓存的 Zeus ${latestVersion} 安装包。安装成功后 Zeus 会重新打开。` : `Installing the cached Zeus ${latestVersion} update. Zeus will reopen after installation succeeds.`,
    progressCaption: zh ? `正在安装 Zeus ${latestVersion}` : `Installing Zeus ${latestVersion}`,
  };
}

function progressCopy(language: 'zh-CN' | 'en-US', progress: HomebrewUpdateProgress, update: DesktopReleaseUpdateStatus, direct = false): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  if (progress.phase === 'updating') {
    return {
      state: 'updating',
      title: zh ? '正在更新 Homebrew 信息' : 'Updating Homebrew Information',
      detail: zh ? '正在更新安装信息，你可以继续使用 Zeus。' : 'Updating installation information. You can keep using Zeus.',
      progressCaption: zh ? '正在更新 Homebrew 信息' : 'Updating Homebrew information',
    };
  }
  if (progress.phase === 'verifying') {
    return {
      state: 'verifying',
      title: zh ? '正在校验更新' : 'Verifying Update',
      detail: zh ? `正在检查 Zeus ${update.latestVersion} 更新包是否完整。` : `Checking that the Zeus ${update.latestVersion} update package is complete.`,
      progressCaption: zh ? '正在校验下载内容' : 'Verifying downloaded update',
    };
  }
  if (progress.phase === 'reconnecting') {
    return {
      state: 'downloading',
      title: zh ? '正在重新连接' : 'Reconnecting Download',
      detail: zh
        ? `Zeus 正在为 ${update.artifact?.fileName ?? update.latestVersion} 建立新的下载连接，并保留已下载内容。`
        : `Zeus is opening a new download connection for ${update.artifact?.fileName ?? update.latestVersion} while keeping downloaded data.`,
      progressCaption: zh ? `第 ${progress.reconnectCount ?? 1} 次重新连接` : `Reconnect ${progress.reconnectCount ?? 1}`,
    };
  }
  if (progress.phase === 'installing') return copyFor(language, 'installing', update.currentVersion, update);
  const totalBytes = progress.totalBytes;
  const downloadedBytes = progress.downloadedBytes;
  const ratio = downloadedBytes !== undefined && totalBytes !== undefined && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : undefined;
  const reconnectCount = progress.reconnectCount ?? 0;
  const speedText = progress.bytesPerSecond === undefined ? null : formatByteRate(progress.bytesPerSecond);
  const percentText = ratio === undefined ? null : formatPercent(ratio);
  return {
    state: 'downloading',
    title: zh ? '正在下载 Zeus 更新' : 'Downloading Zeus Update',
    detail: zh
      ? `正在下载 Zeus ${update.latestVersion}${reconnectCount > 0 ? `；已重新连接 ${reconnectCount} 次` : ''}。你可以继续使用 Zeus。`
      : `Downloading Zeus ${update.latestVersion}${reconnectCount > 0 ? `; reconnected ${reconnectCount} time${reconnectCount === 1 ? '' : 's'}` : ''}. You can keep using Zeus.`,
    progressCaption: zh ? `正在下载 Zeus ${update.latestVersion}` : `Downloading Zeus ${update.latestVersion}`,
    canReconnect: !direct,
    ...(ratio === undefined ? {} : { progress: ratio }),
    ...(percentText === null ? {} : { progressText: speedText === null ? percentText : `${percentText} · ${speedText}` }),
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

function failedCopy(language: 'zh-CN' | 'en-US', error: unknown, step: UpdateFailureStep): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  const explanation = describeUserFacingError(error, language);
  const technicalDetail = redactUserFacingErrorDetails(explanation.details);
  // 下载失败只有已识别的短暂中断可以直接重试；安装失败先处理具体原因。
  const canRetry = step !== 'install' && (explanation.action === 'retry' || isTransientUpdateDownloadError(error));
  const copy = {
    check: {
      title: zh ? '无法检查更新' : 'Could Not Check for Updates',
    },
    prepare: {
      title: zh ? '无法准备更新' : 'Could Not Prepare Update',
    },
    download: {
      title: zh ? '更新下载失败' : 'Update Download Failed',
    },
    install: {
      title: zh ? '更新安装失败' : 'Update Installation Failed',
    },
  }[step];
  return {
    state: 'failed',
    title: copy.title,
    detail: explanation.message,
    canRetry,
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
  if (state.phase === 'failed')
    return {
      state: 'failed',
      title: state.failure?.title ?? (zh ? '更新未完成' : 'Update Incomplete'),
      detail: state.detail,
      technicalDetail: state.failure?.technicalDetail,
      canRetry: state.failure?.canRetry === true && state.failure.step !== 'install',
      present: false,
    };
  if (state.phase === 'manual') return { state: 'manual', title: zh ? '发现新版本' : 'A New Version Is Available', detail: state.detail, present: false };
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
    ['idle', 'available', 'manual', 'preparing', 'retrying', 'ready', 'failed'].includes(value.phase) &&
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

function formatByteRate(bytesPerSecond: number): string {
  const normalized = Math.max(0, bytesPerSecond);
  if (normalized >= 1024 ** 2) return `${formatRateNumber(normalized / 1024 ** 2)} MiB/s`;
  if (normalized >= 1024) return `${formatRateNumber(normalized / 1024)} KiB/s`;
  return `${Math.round(normalized)} B/s`;
}

function formatRateNumber(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
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

/** 仅网络下载中断可后台自动重试，校验及安装错误必须保留。 */
function isTransientUpdateDownloadError(error: unknown): boolean {
  return isTransientHomebrewDownloadError(error) || (error instanceof Error && typeof error.cause === 'object' && error.cause !== null && 'code' in error.cause && error.cause.code === 'ZEUS_UPDATE_DOWNLOAD_INTERRUPTED');
}
