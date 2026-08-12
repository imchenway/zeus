import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DesktopReleaseUpdateStatus } from './releaseUpdateService.js';

const execFile = promisify(execFileCallback);
const caskToken = 'imchenway/tap/zeus';
const commandOutputLimit = 8 * 1024 * 1024;
const progressOutputLimit = 4 * 1024;
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

export interface HomebrewUpdateProgress {
  phase: 'updating' | 'downloading' | 'verifying' | 'installing';
  downloadedBytes?: number;
  totalBytes?: number;
}

export interface HomebrewPreparedUpdate {
  update: DesktopReleaseUpdateStatus;
  brewPath: string;
  cachePath: string;
}

export interface HomebrewInstalledUpdate {
  appPath: string;
  bundleId: string;
  version: string;
}

export interface HomebrewUpdateService {
  prepare(update: DesktopReleaseUpdateStatus, onProgress: (progress: HomebrewUpdateProgress) => void): Promise<HomebrewPreparedUpdate>;
  install(prepared: HomebrewPreparedUpdate, onProgress: (progress: HomebrewUpdateProgress) => void): Promise<HomebrewInstalledUpdate>;
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

/** Homebrew 继续拥有 Cask 版本登记；Zeus 只编排预取、复验和用户确认后的安装。 */
export function createHomebrewUpdateService(options: CreateHomebrewUpdateServiceOptions): HomebrewUpdateService {
  return {
    async prepare(update, onProgress) {
      assertUpdateCanUseHomebrew(update, options);
      const brewPath = await resolveHomebrewBinary(options.testMode);
      onProgress({ phase: 'updating' });
      await runBrew(brewPath, ['update'], { timeoutMs: 5 * 60_000, allowAutoUpdate: true });

      const cask = await inspectCask(brewPath);
      validateCask(cask, update, options.currentAppPath, options.currentAppVersion, options.testMode);
      const cachePath = await readCachePath(brewPath, options.testMode);
      const artifact = update.artifact!;
      if (await verifyArtifact(cachePath, artifact.sha256, artifact.sizeBytes)) {
        onProgress({ phase: 'verifying' });
        return { update, brewPath, cachePath };
      }

      onProgress({ phase: 'downloading', ...(artifact.sizeBytes === null ? {} : { totalBytes: artifact.sizeBytes }) });
      await fetchCask(brewPath, cachePath, artifact.sizeBytes, onProgress, options.testMode);
      onProgress({ phase: 'verifying' });
      if (!(await verifyArtifact(cachePath, artifact.sha256, artifact.sizeBytes))) {
        throw new Error('Homebrew 下载完成，但缓存安装包未通过发布清单校验。');
      }
      return { update, brewPath, cachePath };
    },

    async install(prepared, onProgress) {
      assertUpdateCanUseHomebrew(prepared.update, options);
      const artifact = prepared.update.artifact!;
      if (!(await verifyArtifact(prepared.cachePath, artifact.sha256, artifact.sizeBytes))) {
        throw new Error('已预取的更新包已变化或不完整，请重新下载。');
      }
      const beforeInstall = await inspectCask(prepared.brewPath);
      validateCask(beforeInstall, prepared.update, options.currentAppPath, options.currentAppVersion, options.testMode);
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
  if (update.executionHostProtocolVersion !== 1) throw new Error('新版 Zeus 与当前执行宿主协议不兼容，不能继续升级。');
  const expectedArch = process.arch === 'x64' ? 'x64' : 'arm64';
  if (update.artifact.arch !== expectedArch) throw new Error('更新安装包与当前 Mac 架构不一致。');
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

function validateCask(cask: HomebrewCaskInfo, update: DesktopReleaseUpdateStatus, currentAppPath: string, currentAppVersion: string, testMode: boolean): void {
  const artifact = update.artifact!;
  if (cask.tap !== 'imchenway/tap') throw new Error('Zeus 只允许使用 imchenway/tap 中的正式 Cask 升级。');
  if (cask.installedVersion !== currentAppVersion) {
    throw new Error(`当前 Zeus 不是由目标 Homebrew Cask 以同一版本管理：app=${currentAppVersion} cask=${cask.installedVersion ?? 'none'}`);
  }
  if (cask.version !== update.latestVersion || cask.sha256 !== artifact.sha256 || cask.url !== artifact.downloadUrl) {
    throw new Error('Homebrew Cask 与 Zeus 发布清单不一致，为避免安装错误版本已停止升级。');
  }
  if (!testMode && cask.appTarget !== resolve(currentAppPath)) {
    throw new Error('Homebrew Cask 管理的 Zeus App 不是当前正在使用的日常正式应用。');
  }
}

async function readCachePath(brewPath: string, testMode: boolean): Promise<string> {
  const { stdout } = await runBrew(brewPath, ['--cache', '--cask', caskToken], { timeoutMs: 60_000, allowAutoUpdate: false });
  const cachePath = resolve(stdout.trim());
  if (!stdout.trim() || !isAbsolute(stdout.trim())) throw new Error('Homebrew 没有返回有效的 Zeus 缓存路径。');
  if (testMode && process.env.ZEUS_HOMEBREW_BIN?.trim() && !isUnderTemporaryDirectory(cachePath)) {
    throw new Error('隔离 Homebrew 缓存必须位于系统临时目录。');
  }
  return cachePath;
}

async function fetchCask(brewPath: string, cachePath: string, expectedSizeBytes: number | null, onProgress: (progress: HomebrewUpdateProgress) => void, testMode: boolean): Promise<void> {
  const brewArgs = ['fetch', '--cask', '--retry', caskToken];
  const executable = !testMode && (await isExecutable('/usr/bin/script')) ? '/usr/bin/script' : brewPath;
  const args = executable === brewPath ? brewArgs : ['-q', '/dev/null', brewPath, ...brewArgs];
  await new Promise<void>((resolveFetch, rejectFetch) => {
    const child = spawn(executable, args, {
      env: homebrewEnvironment(false),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    let progressOutput = '';
    let lastDownloadedBytes: number | undefined;
    let lastTotalBytes: number | undefined;
    let fetchFinished = false;
    const timeout = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    const cacheProgressTimer =
      expectedSizeBytes === null
        ? undefined
        : setInterval(() => {
            void publishCachedProgress();
          }, 100);
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
        publishProgress({
          downloadedBytes: Math.min(partialArtifact.size, expectedSizeBytes),
          totalBytes: expectedSizeBytes,
        });
      } catch {
        // 下载尚未创建临时文件时，继续等待 Homebrew 输出。
      }
    }

    function publishProgress(parsed: { downloadedBytes: number; totalBytes?: number }): void {
      if (parsed.downloadedBytes === lastDownloadedBytes && parsed.totalBytes === lastTotalBytes) return;
      lastDownloadedBytes = parsed.downloadedBytes;
      lastTotalBytes = parsed.totalBytes;
      onProgress({ phase: 'downloading', ...parsed });
    }

    function stopProgressMonitoring(): void {
      fetchFinished = true;
      clearTimeout(timeout);
      if (cacheProgressTimer) clearInterval(cacheProgressTimer);
    }

    child.once('error', (error) => {
      stopProgressMonitoring();
      rejectFetch(error);
    });
    child.once('exit', (code, signal) => {
      stopProgressMonitoring();
      if (code === 0) resolveFetch();
      else rejectFetch(new Error(formatCommandFailure('Homebrew 下载更新失败', stderr || stdout, code ?? undefined, signal ?? undefined)));
    });
  });
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

async function verifyArtifact(path: string, expectedSha256: string, expectedSizeBytes: number | null): Promise<boolean> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile() || (expectedSizeBytes !== null && fileStat.size !== expectedSizeBytes)) return false;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex') === expectedSha256;
  } catch {
    return false;
  }
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
