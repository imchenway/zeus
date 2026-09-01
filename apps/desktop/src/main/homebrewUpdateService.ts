import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, createReadStream, type Stats } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DesktopReleaseUpdateStatus } from './releaseUpdateService.js';

const execFile = promisify(execFileCallback);
const caskToken = 'imchenway/tap/zeus';
const commandOutputLimit = 8 * 1024 * 1024;
const progressOutputLimit = 4 * 1024;
const downloadProgressPollIntervalMs = 500;
const downloadSpeedDisplayWindowMs = 5_000;
const defaultDownloadStallWindowMs = 30_000;
const defaultMinimumDownloadBytesPerSecond = 16 * 1024;
const defaultMinimumRemainingBytesForReconnect = 8 * 1024 * 1024;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

export interface HomebrewUpdateProgress {
  phase: 'updating' | 'downloading' | 'reconnecting' | 'verifying' | 'installing';
  downloadedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  reconnectCount?: number;
}

export interface HomebrewPreparedUpdate {
  update: DesktopReleaseUpdateStatus;
  brewPath: string;
  cachePath: string;
  verifiedArtifact: VerifiedArtifactIdentity;
}

export interface HomebrewInstalledUpdate {
  appPath: string;
  bundleId: string;
  version: string;
}

export interface HomebrewUpdateService {
  prepare(update: DesktopReleaseUpdateStatus, onProgress: (progress: HomebrewUpdateProgress) => void): Promise<HomebrewPreparedUpdate>;
  install(prepared: HomebrewPreparedUpdate, onProgress: (progress: HomebrewUpdateProgress) => void): Promise<HomebrewInstalledUpdate>;

  reconnectDownload(): boolean;
}

export class HomebrewUpdateError extends Error {
  constructor(
    message: string,
    readonly kind: 'transient_download' | 'structural',
  ) {
    super(message);
    this.name = 'HomebrewUpdateError';
  }
}

export function isTransientHomebrewDownloadError(error: unknown): boolean {
  return error instanceof HomebrewUpdateError && error.kind === 'transient_download';
}

interface CreateHomebrewUpdateServiceOptions {
  currentAppPath: string;
  currentAppVersion: string;
  bundleId: string;
  testMode: boolean;
}

interface HomebrewCaskInfo {
  version: string;
  installedVersion: string | null;
  tap: string;
  url: string;
  sha256: string;
  appTarget: string | null;
}

interface VerifiedArtifactIdentity {
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

interface DownloadRecoveryPolicy {
  stallWindowMs: number;
  minimumBytesPerSecond: number;
  minimumRemainingBytes: number;
}

/** Homebrew 继续拥有 Cask 版本登记；Zeus 只编排预取、复验和用户确认后的安装。 */
export function createHomebrewUpdateService(options: CreateHomebrewUpdateServiceOptions): HomebrewUpdateService {
  const recoveryPolicy = downloadRecoveryPolicy(options.testMode);
  let reconnectActiveDownload: (() => boolean) | null = null;
  return {
    async prepare(update, onProgress) {
      assertUpdateCanUseHomebrew(update, options);
      const brewPath = await resolveHomebrewBinary(options.testMode);
      let cask = await retryOperation(() => inspectCask(brewPath), 2);
      await validateManagedCask(cask, options);
      if (!caskMatchesRelease(cask, update)) {
        onProgress({ phase: 'updating' });
        await retryOperation(() => runBrew(brewPath, ['update'], { timeoutMs: 5 * 60_000, allowAutoUpdate: true }), 2);
        cask = await retryOperation(() => inspectCask(brewPath), 2);
      }
      validateCask(cask, update, options.currentAppPath, options.testMode);
      const cachePath = await readCachePath(brewPath, options.testMode);
      const artifact = update.artifact!;
      onProgress({ phase: 'verifying' });
      const cachedArtifact = await verifyArtifact(cachePath, artifact.sha256, artifact.sizeBytes);
      if (cachedArtifact) return { update, brewPath, cachePath, verifiedArtifact: cachedArtifact };

      onProgress({ phase: 'downloading', ...(artifact.sizeBytes === null ? {} : { totalBytes: artifact.sizeBytes }) });
      let fetchAttempt = 0;
      await retryOperation(
        () => {
          const reconnectCount = fetchAttempt;
          fetchAttempt += 1;
          if (reconnectCount > 0) onProgress({ phase: 'reconnecting', reconnectCount });
          return fetchCask(brewPath, cachePath, artifact.sizeBytes, onProgress, options.testMode, reconnectCount, recoveryPolicy, (reconnect) => {
            reconnectActiveDownload = reconnect;
          });
        },
        2,
        isTransientHomebrewDownloadError,
      );
      onProgress({ phase: 'verifying' });
      const downloadedArtifact = await verifyArtifact(cachePath, artifact.sha256, artifact.sizeBytes);
      if (!downloadedArtifact) throw new Error('Homebrew 下载完成，但缓存安装包未通过发布清单校验。');
      return { update, brewPath, cachePath, verifiedArtifact: downloadedArtifact };
    },

    async install(prepared, onProgress) {
      assertUpdateCanUseHomebrew(prepared.update, options);
      const artifact = prepared.update.artifact!;
      if (!(await matchesArtifactIdentity(prepared.cachePath, prepared.verifiedArtifact))) {
        const reverifiedArtifact = await verifyArtifact(prepared.cachePath, artifact.sha256, artifact.sizeBytes);
        if (!reverifiedArtifact) throw new Error('已预取的更新包已变化或不完整，请重新下载。');
        prepared.verifiedArtifact = reverifiedArtifact;
      }
      const beforeInstall = await inspectCask(prepared.brewPath);
      await validateManagedCask(beforeInstall, options);
      validateCask(beforeInstall, prepared.update, options.currentAppPath, options.testMode);
      onProgress({ phase: 'installing' });
      await runBrew(prepared.brewPath, ['upgrade', '--cask', '--no-quit', '--yes', '--require-sha', caskToken], {
        timeoutMs: 15 * 60_000,
        allowAutoUpdate: false,
      });
      const installed = await inspectCask(prepared.brewPath);
      if (installed.installedVersion !== prepared.update.latestVersion) {
        throw new Error(`Homebrew 安装后版本不一致：expected=${prepared.update.latestVersion} actual=${installed.installedVersion ?? 'none'}`);
      }
      if (!options.testMode && installed.appTarget !== resolve(options.currentAppPath)) {
        throw new Error('Homebrew 安装后的 Zeus App 位置与当前日常正式应用不一致。');
      }
      if (!installed.appTarget) throw new Error('Homebrew 安装后没有返回 Zeus App 的精确位置。');
      return inspectInstalledApp(installed.appTarget, options.bundleId, prepared.update.latestVersion);
    },

    reconnectDownload() {
      return reconnectActiveDownload?.() ?? false;
    },
  };
}

/** 安装登记不能代替磁盘事实；退出旧进程前必须复验将要重启的真实 App。 */
async function inspectInstalledApp(appPath: string, expectedBundleId: string, expectedVersion: string): Promise<HomebrewInstalledUpdate> {
  const resolvedAppPath = resolve(appPath);
  const appStat = await stat(resolvedAppPath).catch(() => null);
  if (!appStat?.isDirectory()) throw new Error('Homebrew 安装后的 Zeus App 不存在。');
  const infoPlistPath = join(resolvedAppPath, 'Contents', 'Info.plist');
  const [bundleId, shortVersion, bundleVersion] = await Promise.all([readPlistString(infoPlistPath, 'CFBundleIdentifier'), readPlistString(infoPlistPath, 'CFBundleShortVersionString'), readPlistString(infoPlistPath, 'CFBundleVersion')]);
  if (bundleId !== expectedBundleId) {
    throw new Error(`Homebrew 安装后的 Zeus App 身份不一致：expected=${expectedBundleId} actual=${bundleId}`);
  }
  if (shortVersion !== expectedVersion || bundleVersion !== expectedVersion) {
    throw new Error(`Homebrew 安装后的 Zeus App 版本不一致：expected=${expectedVersion} actual=${shortVersion} (${bundleVersion})`);
  }
  return { appPath: resolvedAppPath, bundleId, version: expectedVersion };
}

async function readPlistString(infoPlistPath: string, key: string): Promise<string> {
  try {
    const { stdout } = await execFile('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', infoPlistPath], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const value = stdout.trim();
    if (!value) throw new Error('值为空');
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 Homebrew 安装后的 Zeus App 身份字段 ${key}：${detail}`);
  }
}

function assertUpdateCanUseHomebrew(update: DesktopReleaseUpdateStatus, options: CreateHomebrewUpdateServiceOptions): void {
  if (process.platform !== 'darwin') throw new Error('Homebrew Cask 升级只支持 macOS。');
  if (update.status !== 'available' || !update.artifact) throw new Error('当前没有可预取的 Zeus 更新。');
  if (update.currentVersion !== options.currentAppVersion) throw new Error('更新状态与当前 Zeus App 版本不一致。');
  const expectedArch = process.arch === 'x64' ? 'x64' : 'arm64';
  if (update.artifact.arch !== expectedArch) throw new Error('更新安装包与当前 Mac 架构不一致。');
}

/** 版本漂移可以由 Homebrew 收敛，但当前 App 的路径、身份和实际版本必须可信。 */
async function validateManagedCask(cask: HomebrewCaskInfo, options: CreateHomebrewUpdateServiceOptions): Promise<void> {
  if (cask.tap !== 'imchenway/tap') throw new Error('Zeus 只允许使用 imchenway/tap 中的正式 Cask 升级。');
  if (!cask.installedVersion) throw new Error('当前 Zeus 没有目标 Homebrew Cask 管理收据，不能自动接管安装。');
  if (!options.testMode && cask.appTarget !== resolve(options.currentAppPath)) {
    throw new Error('Homebrew Cask 管理的 Zeus App 不是当前正在使用的日常正式应用。');
  }
  await inspectInstalledApp(options.currentAppPath, options.bundleId, options.currentAppVersion);
}

async function resolveHomebrewBinary(testMode: boolean): Promise<string> {
  const testOverride = process.env.ZEUS_HOMEBREW_BIN?.trim();
  if (testOverride) {
    if (!testMode) throw new Error('ZEUS_HOMEBREW_BIN 只允许隔离测试包使用。');
    const candidate = resolve(testOverride);
    if (!isAbsolute(testOverride) || !isUnderTemporaryDirectory(candidate)) throw new Error('隔离 Homebrew 替身必须位于系统临时目录。');
    await access(candidate, fsConstants.X_OK);
    return candidate;
  }
  for (const candidate of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续检查另一个标准 Homebrew 位置。
    }
  }
  throw new Error('未找到 Homebrew。请先安装 Homebrew，再重试 Zeus 更新。');
}

async function inspectCask(brewPath: string): Promise<HomebrewCaskInfo> {
  const { stdout } = await runBrew(brewPath, ['info', '--cask', '--json=v2', caskToken], { timeoutMs: 60_000, allowAutoUpdate: false });
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Homebrew 返回的 Zeus Cask 信息不是有效 JSON。');
  }
  if (!isRecord(value) || !Array.isArray(value.casks) || value.casks.length !== 1 || !isRecord(value.casks[0])) {
    throw new Error('Homebrew 没有返回唯一的 Zeus Cask。');
  }
  const cask = value.casks[0];
  const artifacts = Array.isArray(cask.artifacts) ? cask.artifacts : [];
  let appTarget: string | null = null;
  for (const artifact of artifacts) {
    if (!isRecord(artifact) || !Array.isArray(artifact.app) || typeof artifact.target !== 'string') continue;
    if (artifact.app.includes('Zeus.app')) appTarget = resolve(artifact.target);
  }
  const installedVersion = typeof cask.installed === 'string' && cask.installed.trim() ? cask.installed.trim() : null;
  if (typeof cask.version !== 'string' || typeof cask.tap !== 'string' || typeof cask.url !== 'string' || typeof cask.sha256 !== 'string') {
    throw new Error('Homebrew Zeus Cask 缺少必要版本或产物信息。');
  }
  return {
    version: cask.version,
    installedVersion,
    tap: cask.tap,
    url: cask.url,
    sha256: cask.sha256,
    appTarget,
  };
}

function validateCask(cask: HomebrewCaskInfo, update: DesktopReleaseUpdateStatus, currentAppPath: string, testMode: boolean): void {
  if (cask.tap !== 'imchenway/tap') throw new Error('Zeus 只允许使用 imchenway/tap 中的正式 Cask 升级。');
  if (!cask.installedVersion) throw new Error('当前 Zeus 没有目标 Homebrew Cask 管理收据，不能自动接管安装。');
  if (!caskMatchesRelease(cask, update)) {
    throw new Error('Homebrew Cask 与 Zeus 发布清单不一致，为避免安装错误版本已停止升级。');
  }
  if (!testMode && cask.appTarget !== resolve(currentAppPath)) {
    throw new Error('Homebrew Cask 管理的 Zeus App 不是当前正在使用的日常正式应用。');
  }
}

function caskMatchesRelease(cask: HomebrewCaskInfo, update: DesktopReleaseUpdateStatus): boolean {
  const artifact = update.artifact!;
  return cask.version === update.latestVersion && cask.sha256 === artifact.sha256 && cask.url === artifact.downloadUrl;
}

async function readCachePath(brewPath: string, testMode: boolean): Promise<string> {
  const { stdout } = await retryOperation(() => runBrew(brewPath, ['--cache', '--cask', caskToken], { timeoutMs: 60_000, allowAutoUpdate: false }), 2);
  const cachePath = resolve(stdout.trim());
  if (!stdout.trim() || !isAbsolute(stdout.trim())) throw new Error('Homebrew 没有返回有效的 Zeus 缓存路径。');
  if (testMode && process.env.ZEUS_HOMEBREW_BIN?.trim() && !isUnderTemporaryDirectory(cachePath)) {
    throw new Error('隔离 Homebrew 缓存必须位于系统临时目录。');
  }
  return cachePath;
}

async function fetchCask(
  brewPath: string,
  cachePath: string,
  expectedSizeBytes: number | null,
  onProgress: (progress: HomebrewUpdateProgress) => void,
  testMode: boolean,
  reconnectCount: number,
  recoveryPolicy: DownloadRecoveryPolicy,
  setReconnect: (reconnect: (() => boolean) | null) => void,
): Promise<void> {
  const brewArgs = ['fetch', '--cask', '--retry', caskToken];
  const executable = !testMode && (await isExecutable('/usr/bin/script')) ? '/usr/bin/script' : brewPath;
  const args = executable === brewPath ? brewArgs : ['-q', '/dev/null', brewPath, ...brewArgs];
  await new Promise<void>((resolveFetch, rejectFetch) => {
    const child = spawn(executable, args, {
      detached: true,
      env: homebrewEnvironment(false),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    let progressOutput = '';
    let lastDownloadedBytes: number | undefined;
    let lastTotalBytes: number | undefined;
    let lastBytesPerSecond: number | undefined;
    let fetchFinished = false;
    let terminationReason: 'manual' | 'low_speed' | 'timeout' | null = null;
    let forceTerminationTimer: ReturnType<typeof setTimeout> | null = null;
    const speedSamples: Array<{ observedAtMs: number; downloadedBytes: number }> = [];
    const timeout = setTimeout(() => requestTermination('timeout'), 15 * 60_000);
    const cacheProgressTimer =
      expectedSizeBytes === null
        ? undefined
        : setInterval(() => {
            void publishCachedProgress();
          }, downloadProgressPollIntervalMs);
    setReconnect(() => requestTermination('manual'));
    const inspect = (chunk: Buffer) => {
      const rawText = chunk.toString('utf8');
      const text = stripTerminalFormatting(rawText);
      stdout = appendBounded(stdout, text);
      progressOutput = appendTail(progressOutput, rawText, progressOutputLimit);
      publishParsedProgress();
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', (chunk: Buffer) => {
      const rawText = chunk.toString('utf8');
      const text = stripTerminalFormatting(rawText);
      stderr = appendBounded(stderr, text);
      progressOutput = appendTail(progressOutput, rawText, progressOutputLimit);
      publishParsedProgress();
    });

    /** Homebrew 的伪终端输出可能跨多个 data 事件，必须基于滚动缓冲解析完整进度。 */
    function publishParsedProgress(): void {
      const parsed = parseHomebrewProgress(stripTerminalFormatting(progressOutput), expectedSizeBytes);
      if (parsed) publishProgress(parsed);
    }

    /** Homebrew 下载会先写入缓存目标的 .incomplete 文件，文件大小是不依赖终端格式的真实进度事实。 */
    async function publishCachedProgress(): Promise<void> {
      if (fetchFinished || expectedSizeBytes === null) return;
      try {
        const partialArtifact = await stat(`${cachePath}.incomplete`);
        if (fetchFinished || !partialArtifact.isFile()) return;
        const downloadedBytes = Math.min(partialArtifact.size, expectedSizeBytes);
        const bytesPerSecond = observeDownloadSpeed(downloadedBytes, expectedSizeBytes);
        publishProgress({
          downloadedBytes,
          totalBytes: expectedSizeBytes,
          ...(bytesPerSecond === undefined ? {} : { bytesPerSecond }),
        });
      } catch {
        // 下载尚未创建临时文件时，继续等待 Homebrew 输出。
      }
    }

    function publishProgress(parsed: { downloadedBytes: number; totalBytes?: number; bytesPerSecond?: number }): void {
      const roundedBytesPerSecond = parsed.bytesPerSecond === undefined ? lastBytesPerSecond : Math.max(0, Math.round(parsed.bytesPerSecond));
      if (parsed.downloadedBytes === lastDownloadedBytes && parsed.totalBytes === lastTotalBytes && roundedBytesPerSecond === lastBytesPerSecond) return;
      lastDownloadedBytes = parsed.downloadedBytes;
      lastTotalBytes = parsed.totalBytes;
      lastBytesPerSecond = roundedBytesPerSecond;
      onProgress({
        phase: 'downloading',
        ...parsed,
        ...(roundedBytesPerSecond === undefined ? {} : { bytesPerSecond: roundedBytesPerSecond }),
        reconnectCount,
      });
    }

    function observeDownloadSpeed(downloadedBytes: number, totalBytes: number): number | undefined {
      const observedAtMs = Date.now();
      const previousSample = speedSamples.at(-1);
      if (previousSample && downloadedBytes < previousSample.downloadedBytes) speedSamples.length = 0;
      speedSamples.push({ observedAtMs, downloadedBytes });
      const oldestNeededAtMs = observedAtMs - Math.max(recoveryPolicy.stallWindowMs, downloadSpeedDisplayWindowMs);
      while (speedSamples.length > 2 && speedSamples[1]!.observedAtMs <= oldestNeededAtMs) speedSamples.shift();

      const displaySample = sampleAtOrBefore(speedSamples, observedAtMs - downloadSpeedDisplayWindowMs);
      const displayElapsedMs = displaySample ? observedAtMs - displaySample.observedAtMs : 0;
      const bytesPerSecond = displaySample && displayElapsedMs >= 1_000 ? ((downloadedBytes - displaySample.downloadedBytes) * 1_000) / displayElapsedMs : undefined;

      const stallSample = sampleAtOrBefore(speedSamples, observedAtMs - recoveryPolicy.stallWindowMs);
      const stallElapsedMs = stallSample ? observedAtMs - stallSample.observedAtMs : 0;
      const remainingBytes = Math.max(0, totalBytes - downloadedBytes);
      if (stallSample && stallElapsedMs >= recoveryPolicy.stallWindowMs && remainingBytes >= recoveryPolicy.minimumRemainingBytes) {
        const stallBytesPerSecond = ((downloadedBytes - stallSample.downloadedBytes) * 1_000) / stallElapsedMs;
        if (stallBytesPerSecond < recoveryPolicy.minimumBytesPerSecond) requestTermination('low_speed');
      }
      return bytesPerSecond;
    }

    function requestTermination(reason: 'manual' | 'low_speed' | 'timeout'): boolean {
      if (fetchFinished || terminationReason) return false;
      terminationReason = reason;
      const signaled = terminateProcessGroup(child.pid, 'SIGTERM');
      if (!signaled) {
        terminationReason = null;
        return false;
      }
      forceTerminationTimer = setTimeout(() => terminateProcessGroup(child.pid, 'SIGKILL'), 3_000);
      forceTerminationTimer.unref();
      return true;
    }

    function stopProgressMonitoring(): void {
      fetchFinished = true;
      clearTimeout(timeout);
      if (cacheProgressTimer) clearInterval(cacheProgressTimer);
      if (forceTerminationTimer) clearTimeout(forceTerminationTimer);
      setReconnect(null);
    }

    child.once('error', (error) => {
      stopProgressMonitoring();
      if (terminationReason) {
        rejectFetch(new HomebrewUpdateError(downloadReconnectMessage(terminationReason), 'transient_download'));
        return;
      }
      const kind = isTransientDownloadFailure(error.message, typeof (error as NodeJS.ErrnoException).code === 'string' ? (error as NodeJS.ErrnoException).code : undefined) ? 'transient_download' : 'structural';
      rejectFetch(new HomebrewUpdateError(`Homebrew 下载更新失败：${error.message}`, kind));
    });
    child.once('exit', (code, signal) => {
      stopProgressMonitoring();
      if (code === 0) resolveFetch();
      else if (terminationReason) rejectFetch(new HomebrewUpdateError(downloadReconnectMessage(terminationReason), 'transient_download'));
      else {
        const detail = stderr || stdout;
        const kind = isTransientDownloadFailure(detail, signal ?? undefined) ? 'transient_download' : 'structural';
        rejectFetch(new HomebrewUpdateError(formatCommandFailure('Homebrew 下载更新失败', detail, code ?? undefined, signal ?? undefined), kind));
      }
    });
  });
}

function sampleAtOrBefore(
  samples: ReadonlyArray<{
    observedAtMs: number;
    downloadedBytes: number;
  }>,
  cutoffMs: number,
): { observedAtMs: number; downloadedBytes: number } | undefined {
  let match: { observedAtMs: number; downloadedBytes: number } | undefined;
  for (const sample of samples) {
    if (sample.observedAtMs > cutoffMs) break;
    match = sample;
  }
  return match;
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function downloadReconnectMessage(reason: 'manual' | 'low_speed' | 'timeout'): string {
  if (reason === 'manual') return '已按用户要求重新建立 Homebrew 下载连接。';
  if (reason === 'low_speed') return 'Homebrew 下载连接持续异常低速，Zeus 已重新建立连接。';
  return 'Homebrew 下载超过单次等待上限，Zeus 已重新建立连接。';
}

function downloadRecoveryPolicy(testMode: boolean): DownloadRecoveryPolicy {
  if (!testMode) {
    return {
      stallWindowMs: defaultDownloadStallWindowMs,
      minimumBytesPerSecond: defaultMinimumDownloadBytesPerSecond,
      minimumRemainingBytes: defaultMinimumRemainingBytesForReconnect,
    };
  }
  return {
    stallWindowMs: readPositiveIntegerEnvironment('ZEUS_HOMEBREW_STALL_WINDOW_MS', defaultDownloadStallWindowMs, 2_000),
    minimumBytesPerSecond: readPositiveIntegerEnvironment('ZEUS_HOMEBREW_MIN_SPEED_BPS', defaultMinimumDownloadBytesPerSecond, 1),
    minimumRemainingBytes: readPositiveIntegerEnvironment('ZEUS_HOMEBREW_MIN_REMAINING_BYTES', defaultMinimumRemainingBytesForReconnect, 1),
  };
}

function readPositiveIntegerEnvironment(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

/** 只有明确的网络中断、服务端暂时不可用或下载超时才进入后台重试。 */
function isTransientDownloadFailure(detail: string, codeOrSignal?: string): boolean {
  if (codeOrSignal === 'SIGTERM' || ['EAI_AGAIN', 'ECONNABORTED', 'ECONNRESET', 'ENETDOWN', 'ENETUNREACH', 'ETIMEDOUT'].includes(codeOrSignal ?? '')) return true;
  return /(?:curl:\s*\((?:5|6|7|18|28|35|47|52|55|56|92)\)|http[^\n]*(?:408|425|429|5\d\d)|could not resolve|connection (?:reset|refused|timed out)|network is unreachable|operation timed out|temporary failure)/iu.test(detail);
}

async function runBrew(brewPath: string, args: string[], options: { timeoutMs: number; allowAutoUpdate: boolean }): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile(brewPath, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: commandOutputLimit,
      env: homebrewEnvironment(options.allowAutoUpdate),
    });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: string | number; signal?: string };
    throw new Error(formatCommandFailure(`Homebrew ${args[0] ?? '命令'} 失败`, failure.stderr || failure.stdout || failure.message, failure.code, failure.signal));
  }
}

function homebrewEnvironment(allowAutoUpdate: boolean): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOMEBREW_NO_ANALYTICS: '1',
    HOMEBREW_NO_ENV_HINTS: '1',
    HOMEBREW_NO_INSTALL_CLEANUP: '1',
    HOMEBREW_NO_AUTO_UPDATE: allowAutoUpdate ? undefined : '1',
    HOMEBREW_NO_UPGRADE_QUIT_CASKS: '1',
    NONINTERACTIVE: '1',
  };
}

async function verifyArtifact(path: string, expectedSha256: string, expectedSizeBytes: number | null): Promise<VerifiedArtifactIdentity | null> {
  try {
    const before = await stat(path);
    if (!before.isFile() || (expectedSizeBytes !== null && before.size !== expectedSizeBytes)) return null;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== expectedSha256) return null;
    const after = await stat(path);
    const beforeIdentity = artifactIdentity(before);
    const afterIdentity = artifactIdentity(after);
    return sameArtifactIdentity(beforeIdentity, afterIdentity) && after.isFile() ? afterIdentity : null;
  } catch {
    return null;
  }
}

async function matchesArtifactIdentity(path: string, expected: VerifiedArtifactIdentity): Promise<boolean> {
  try {
    const current = await stat(path);
    return current.isFile() && sameArtifactIdentity(artifactIdentity(current), expected);
  } catch {
    return false;
  }
}

function artifactIdentity(fileStat: Stats): VerifiedArtifactIdentity {
  return {
    device: fileStat.dev,
    inode: fileStat.ino,
    size: fileStat.size,
    modifiedAtMs: fileStat.mtimeMs,
    changedAtMs: fileStat.ctimeMs,
  };
}

function sameArtifactIdentity(left: VerifiedArtifactIdentity, right: VerifiedArtifactIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size && left.modifiedAtMs === right.modifiedAtMs && left.changedAtMs === right.changedAtMs;
}

function parseHomebrewProgress(text: string, expectedSizeBytes: number | null): { downloadedBytes: number; totalBytes?: number } | null {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)\s*\/\s*(\d+(?:\.\d+)?)\s*(B|KB|MB|GB)/giu)];
  const match = matches.at(-1);
  if (!match) return null;
  const downloadedBytes = toBytes(Number(match[1]), match[2]);
  const parsedTotal = toBytes(Number(match[3]), match[4]);
  const totalBytes = expectedSizeBytes ?? parsedTotal;
  if (!Number.isFinite(downloadedBytes) || downloadedBytes < 0 || !Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return { downloadedBytes: Math.min(downloadedBytes, totalBytes), totalBytes };
}

function toBytes(value: number, unit: string): number {
  const multiplier = unit.toUpperCase() === 'GB' ? 1024 ** 3 : unit.toUpperCase() === 'MB' ? 1024 ** 2 : unit.toUpperCase() === 'KB' ? 1024 : 1;
  return Math.round(value * multiplier);
}

function stripTerminalFormatting(value: string): string {
  return value.replace(ansiEscapePattern, '').replace(/\r/gu, '\n');
}

function appendBounded(current: string, next: string): string {
  const combined = `${current}${next}`;
  return combined.length <= commandOutputLimit ? combined : combined.slice(-commandOutputLimit);
}

function appendTail(current: string, next: string, limit: number): string {
  const combined = `${current}${next}`;
  return combined.length <= limit ? combined : combined.slice(-limit);
}

function formatCommandFailure(prefix: string, output: string, code: string | number | undefined, signal: string | undefined): string {
  const summary = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-3)
    .join(' ');
  return `${prefix}${code === undefined ? '' : ` (code ${code})`}${signal ? ` (signal ${signal})` : ''}${summary ? `：${summary}` : '。'}`;
}

/** 只为检查、缓存定位和明确的瞬时下载故障做短重试；安装命令不进入此流程。 */
async function retryOperation<T>(operation: () => Promise<T>, retryCount: number, shouldRetry: (error: unknown) => boolean = () => true): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === retryCount || !shouldRetry(error)) break;
      await delay(attempt === 0 ? 400 : 1_200);
    }
  }
  throw lastError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isUnderTemporaryDirectory(path: string): boolean {
  const normalized = resolve(path);
  const roots = [resolve(tmpdir()), resolve('/tmp')];
  return roots.some((root) => {
    const pathRelative = relative(root, normalized);
    return Boolean(pathRelative) && !pathRelative.startsWith('..') && !pathRelative.includes('/../');
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
