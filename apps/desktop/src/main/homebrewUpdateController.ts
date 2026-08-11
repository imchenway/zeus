import type { DesktopReleaseUpdateStatus } from './releaseUpdateService.js';
import type { HomebrewPreparedUpdate, HomebrewUpdateProgress, HomebrewUpdateService } from './homebrewUpdateService.js';
import { createNativeUpdateProgressHost, type NativeUpdateProgressHost, type NativeUpdateProgressState } from './nativeUpdateProgress.js';

export interface HomebrewUpdateController {
  showOrCheck(): Promise<void>;
  close(): void;
}

interface CreateHomebrewUpdateControllerOptions {
  helperPath: string;
  language: () => 'zh-CN' | 'en-US';
  loadUpdateStatus: () => Promise<DesktopReleaseUpdateStatus>;
  homebrew: HomebrewUpdateService;
  currentVersion: string;
  bundleId: string;
  canInstall: () => void;
  onInstallReady: () => void;
  notifyReady: (showProgress: () => void) => void;
}

type ControllerPhase = 'idle' | 'checking' | 'available' | 'preparing' | 'ready' | 'installing' | 'failed' | 'upToDate';

/** 原生窗口可以隐藏或重启，但唯一后台更新任务不因窗口生命周期重复执行。 */
export function createHomebrewUpdateController(options: CreateHomebrewUpdateControllerOptions): HomebrewUpdateController {
  let host: NativeUpdateProgressHost | null = null;
  let phase: ControllerPhase = 'idle';
  let hidden = false;
  let currentUpdate: DesktopReleaseUpdateStatus | null = null;
  let prepared: HomebrewPreparedUpdate | null = null;
  let lastState: NativeUpdateProgressState | null = null;
  let lastFailureStep: 'check' | 'prepare' | 'install' = 'check';
  let operation: Promise<void> | null = null;

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
      if (action === 'download') void runExclusive(prepareUpdate);
      else if (action === 'restart') void runExclusive(installPreparedUpdate);
      else if (action === 'retry') {
        if (lastFailureStep === 'install' && prepared) void runExclusive(installPreparedUpdate);
        else if (lastFailureStep === 'prepare' && currentUpdate) void runExclusive(prepareUpdate);
        else void runExclusive(checkForUpdate);
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

  async function publish(state: NativeUpdateProgressState): Promise<void> {
    lastState = { ...state, present: !hidden };
    const currentHost = await ensureHost();
    currentHost.update(lastState);
  }

  async function checkForUpdate(): Promise<void> {
    phase = 'checking';
    prepared = null;
    currentUpdate = null;
    lastFailureStep = 'check';
    await publish(copyFor(options.language(), 'checking', options.currentVersion));
    try {
      const update = await options.loadUpdateStatus();
      currentUpdate = update;
      if (update.status === 'up_to_date') {
        phase = 'upToDate';
        await publish(copyFor(options.language(), 'upToDate', options.currentVersion, update));
        return;
      }
      if (update.status !== 'available' || !update.artifact) throw new Error(update.reason || '暂时无法取得可用更新。');
      phase = 'available';
      await publish(copyFor(options.language(), 'available', options.currentVersion, update));
    } catch (error) {
      phase = 'failed';
      await publish(failedCopy(options.language(), error));
    }
  }

  async function prepareUpdate(): Promise<void> {
    if (!currentUpdate || currentUpdate.status !== 'available') return checkForUpdate();
    phase = 'preparing';
    lastFailureStep = 'prepare';
    try {
      prepared = await options.homebrew.prepare(currentUpdate, (progress) => {
        void publish(progressCopy(options.language(), progress, currentUpdate!));
      });
      phase = 'ready';
      const wasHidden = hidden;
      await publish(copyFor(options.language(), 'ready', options.currentVersion, currentUpdate));
      if (wasHidden) options.notifyReady(() => void showCurrent());
    } catch (error) {
      phase = 'failed';
      await publish(failedCopy(options.language(), error));
    }
  }

  async function installPreparedUpdate(): Promise<void> {
    if (!prepared) return prepareUpdate();
    lastFailureStep = 'install';
    try {
      options.canInstall();
      phase = 'installing';
      await publish(copyFor(options.language(), 'installing', options.currentVersion, prepared.update));
      await options.homebrew.install(prepared, (progress) => {
        void publish(progressCopy(options.language(), progress, prepared!.update));
      });
      const currentHost = await ensureHost();
      currentHost.relaunchAfterProcessExit({ pid: process.pid, bundleId: options.bundleId });
      options.onInstallReady();
    } catch (error) {
      phase = 'failed';
      await publish(failedCopy(options.language(), error));
    }
  }

  async function showCurrent(): Promise<void> {
    hidden = false;
    const currentHost = await ensureHost();
    if (lastState) currentHost.update({ ...lastState, present: true });
    else currentHost.show();
  }

  return {
    showOrCheck: () => {
      if (phase === 'preparing' || phase === 'ready' || phase === 'installing' || phase === 'available') return showCurrent();
      hidden = false;
      return runExclusive(checkForUpdate);
    },
    close: () => {
      host?.close();
      host = null;
    },
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
      progress: 1,
      progressText: zh ? '下载和校验已完成' : 'Download and verification complete',
    };
  }
  return {
    state,
    title: zh ? '正在安装更新' : 'Installing Update',
    detail: zh ? `Homebrew 正在使用已缓存的 Zeus ${latestVersion} 安装包。安装成功后 Zeus 会重新打开。` : `Homebrew is installing the cached Zeus ${latestVersion} update. Zeus will reopen after installation succeeds.`,
  };
}

function progressCopy(language: 'zh-CN' | 'en-US', progress: HomebrewUpdateProgress, update: DesktopReleaseUpdateStatus): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  if (progress.phase === 'updating') {
    return {
      state: 'updating',
      title: zh ? '正在更新 Homebrew 信息' : 'Updating Homebrew Information',
      detail: zh ? 'Zeus 正在刷新公开 Cask，不会阻止你继续工作。' : 'Zeus is refreshing the public Cask without blocking your work.',
    };
  }
  if (progress.phase === 'verifying') {
    return {
      state: 'verifying',
      title: zh ? '正在校验更新' : 'Verifying Update',
      detail: zh ? `Homebrew 与 Zeus 正在复验 ${update.artifact?.fileName ?? update.latestVersion} 的大小和 SHA-256。` : `Homebrew and Zeus are verifying the size and SHA-256 of ${update.artifact?.fileName ?? update.latestVersion}.`,
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
    ...(ratio === undefined ? {} : { progress: ratio, progressText: formatPercent(ratio) }),
  };
}

function failedCopy(language: 'zh-CN' | 'en-US', error: unknown): NativeUpdateProgressState {
  const zh = language === 'zh-CN';
  const detail = error instanceof Error ? error.message : String(error);
  return {
    state: 'failed',
    title: zh ? '更新未能完成' : 'Update Could Not Be Completed',
    detail: detail.trim() || (zh ? '请稍后重试。' : 'Try again later.'),
    progressText: zh ? 'Zeus 未替换当前 App，现有工作可以继续。' : 'Zeus did not replace the current app. Existing work can continue.',
  };
}

function formatPercent(ratio: number): string {
  return `${Math.min(100, Math.floor(Math.max(0, ratio) * 100))}%`;
}
