import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, type Stats } from 'node:fs';
import { access, copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { releaseArtifactDownloadUrls } from '@zeus/local-server/release-core';
import { type DesktopReleaseUpdateStatus } from './releaseUpdateService.js';

/** 固定通过原生子进程运行本机安装管理器。 */
const execFile = promisify(execFileCallback);
/** 官方 Homebrew 安装项，禁止切换为其他发行来源。 */
const caskToken = 'imchenway/tap/zeus';
/** 安装管理器的输出上限，避免异常日志持续占用内存。 */
const commandOutputLimit = 8 * 1024 * 1024;
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
  /** 只查询本机安装记录；来源或路径冲突必须报错，不能自动接管。 */
  isManaged(): Promise<boolean>;
  /** 安装时接收已经下载的文件，包管理器不再负责应用内下载。 */
  prepare(update: DesktopReleaseUpdateStatus, artifactPath: string, onProgress: (progress: HomebrewUpdateProgress) => void): Promise<HomebrewPreparedUpdate>;
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

interface VerifiedArtifactIdentity {
  device: number;
  inode: number;
  size: number;
  modifiedAtMs: number;
  changedAtMs: number;
}

/** Homebrew 仅在安装阶段接收已校验文件，保留 Cask 版本登记与安装后身份核验。 */
export function createHomebrewUpdateService(options: CreateHomebrewUpdateServiceOptions): HomebrewUpdateService {
  return {
    /** 未安装 Homebrew 或未登记 Zeus 时交给直接更新，其他查询错误保留原始原因。 */
    async isManaged() {
      const brewPath = await resolveHomebrewBinary(options.testMode);
      if (!brewPath) return false;
      const { stdout } = await runBrew(brewPath, ['list', '--cask', '--versions'], { timeoutMs: 60_000, allowAutoUpdate: false });
      if (!stdout.split(/\r?\n/u).some((line) => /^(?:imchenway\/tap\/)?zeus\s+\S/u.test(line.trim()))) return false;
      const cask = await inspectCask(brewPath);
      await validateManagedCask(cask, options);
      return true;
    },

    async prepare(update, artifactPath, onProgress) {
      assertUpdateCanUseHomebrew(update, options);
      const brewPath = await resolveHomebrewBinary(options.testMode);
      if (!brewPath) throw new Error('未找到 Homebrew。请先安装 Homebrew，再重试 Zeus 更新。');
      let cask = await retryOperation(() => inspectCask(brewPath), 2);
      await validateManagedCask(cask, options);
      if (!caskMatchesRelease(cask, update)) {
        onProgress({ phase: 'updating' });
        // 全局同步失败时，只有 Zeus Cask 完整核对通过才接受已落地的同步结果。
        await retryOperation(async () => {
          try {
            await runBrew(brewPath, ['update'], { timeoutMs: 5 * 60_000, allowAutoUpdate: true });
          } catch (updateError) {
            try {
              // 公共索引下载失败前，官方 Tap 可能已更新；核对实际 Cask 和当前 App 身份。
              const refreshedCask = await inspectCask(brewPath);
              await validateManagedCask(refreshedCask, options);
              validateCask(refreshedCask, update, options.currentAppPath);
            } catch {
              throw updateError;
            }
          }
        }, 2);
        cask = await retryOperation(() => inspectCask(brewPath), 2);
      }
      validateCask(cask, update, options.currentAppPath);
      const cachePath = await readCachePath(brewPath, options.testMode);
      const artifact = update.artifact!;
      onProgress({ phase: 'verifying' });
      const cachedArtifact = await verifyArtifact(cachePath, artifact.sha256, artifact.sizeBytes);
      if (cachedArtifact) return { update, brewPath, cachePath, verifiedArtifact: cachedArtifact };

      /** 复用应用内直连下载的制品，安装准备不再启动另一条下载链路。 */
      const downloadedArtifact = await stageHomebrewCachedArtifact(artifactPath, cachePath, artifact);
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
      validateCask(beforeInstall, prepared.update, options.currentAppPath);
      onProgress({ phase: 'installing' });
      await runBrew(prepared.brewPath, ['upgrade', '--cask', '--no-quit', '--yes', '--require-sha', caskToken], {
        timeoutMs: 15 * 60_000,
        allowAutoUpdate: false,
      });
      const installed = await inspectCask(prepared.brewPath);
      if (installed.installedVersion !== prepared.update.latestVersion) {
        throw new Error(`Homebrew 安装后版本不一致：expected=${prepared.update.latestVersion} actual=${installed.installedVersion ?? 'none'}`, {
          cause: { code: 'ZEUS_UPDATE_INSTALLED_IDENTITY_MISMATCH', message: 'Installed app does not match the requested release' },
        });
      }
      if (installed.appTarget !== resolve(options.currentAppPath)) {
        throw new Error('Homebrew 安装后的 Zeus App 位置与当前日常正式应用不一致。');
      }
      if (!installed.appTarget) throw new Error('Homebrew 安装后没有返回 Zeus App 的精确位置。');
      return inspectInstalledApp(installed.appTarget, options.bundleId, [prepared.update.latestVersion]);
    },
  };
}

/** 安装登记不能代替磁盘事实；退出旧进程前必须复验将要重启的真实 App。 */
async function inspectInstalledApp(appPath: string, expectedBundleId: string, expectedVersions: readonly string[]): Promise<HomebrewInstalledUpdate> {
  const resolvedAppPath = resolve(appPath);
  const appStat = await stat(resolvedAppPath).catch(() => null);
  if (!appStat?.isDirectory()) throw new Error('Homebrew 安装后的 Zeus App 不存在。');
  const infoPlistPath = join(resolvedAppPath, 'Contents', 'Info.plist');
  const [bundleId, shortVersion, bundleVersion] = await Promise.all([readPlistString(infoPlistPath, 'CFBundleIdentifier'), readPlistString(infoPlistPath, 'CFBundleShortVersionString'), readPlistString(infoPlistPath, 'CFBundleVersion')]);
  if (bundleId !== expectedBundleId) {
    throw new Error(`Homebrew 安装后的 Zeus App 身份不一致：expected=${expectedBundleId} actual=${bundleId}`, { cause: { code: 'ZEUS_UPDATE_INSTALLED_IDENTITY_MISMATCH', message: 'Installed app does not match the requested release' } });
  }
  if (shortVersion !== bundleVersion || !expectedVersions.includes(shortVersion)) {
    throw new Error(`Homebrew 安装后的 Zeus App 版本不一致：expected=${expectedVersions.join('|')} actual=${shortVersion} (${bundleVersion})`, {
      cause: { code: 'ZEUS_UPDATE_INSTALLED_IDENTITY_MISMATCH', message: 'Installed app does not match the requested release' },
    });
  }
  return { appPath: resolvedAppPath, bundleId, version: shortVersion };
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
  if (cask.appTarget !== resolve(options.currentAppPath)) {
    throw new Error('Homebrew Cask 管理的 Zeus App 不是当前正在使用的日常正式应用。');
  }
  // 未重启时磁盘 App 可能已是 Homebrew 刚安装的版本；路径和身份仍必须严格一致。
  await inspectInstalledApp(options.currentAppPath, options.bundleId, [options.currentAppVersion, cask.installedVersion]);
}

/** 缺少安装工具是合法安装方式；执行失败不冒充工具缺失。 */
async function resolveHomebrewBinary(testMode: boolean): Promise<string | null> {
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
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
  }
  return null;
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

function validateCask(cask: HomebrewCaskInfo, update: DesktopReleaseUpdateStatus, currentAppPath: string): void {
  if (cask.tap !== 'imchenway/tap') throw new Error('Zeus 只允许使用 imchenway/tap 中的正式 Cask 升级。');
  if (!cask.installedVersion) throw new Error('当前 Zeus 没有目标 Homebrew Cask 管理收据，不能自动接管安装。');
  if (!caskMatchesRelease(cask, update)) {
    throw new Error('Homebrew Cask 与 Zeus 发布清单不一致，为避免安装错误版本已停止升级。');
  }
  if (cask.appTarget !== resolve(currentAppPath)) {
    throw new Error('Homebrew Cask 管理的 Zeus App 不是当前正在使用的日常正式应用。');
  }
}

/** 同一版本与摘要的官方 CDN、GitHub 地址代表同一份 Cask 制品。 */
export function caskMatchesRelease(cask: HomebrewCaskInfo, update: DesktopReleaseUpdateStatus): boolean {
  const artifact = update.artifact!;
  return cask.version === update.latestVersion && cask.sha256 === artifact.sha256 && (cask.url === artifact.downloadUrl || releaseArtifactDownloadUrls(update.latestVersion, artifact.fileName).includes(cask.url));
}

/** 将已下载的制品原子写入 Homebrew 缓存，复制后重新校验以防源文件变化。 */
export async function stageHomebrewCachedArtifact(sourcePath: string, cachePath: string, artifact: NonNullable<DesktopReleaseUpdateStatus['artifact']>): Promise<VerifiedArtifactIdentity> {
  await mkdir(dirname(cachePath), { recursive: true });
  /** 暂存文件与目标位于同一目录，校验失败不会覆盖原有缓存。 */
  const temporaryPath = `${cachePath}.${randomUUID()}.partial`;
  try {
    await copyFile(sourcePath, temporaryPath, fsConstants.COPYFILE_EXCL);
    if (!(await verifyArtifact(temporaryPath, artifact.sha256, artifact.sizeBytes))) throw new Error('已下载的更新包摘要或大小与发布清单不符。');
    await rename(temporaryPath, cachePath);
    /** 原子更名后记录真实文件身份，安装前仍会复验。 */
    const verified = await verifyArtifact(cachePath, artifact.sha256, artifact.sizeBytes);
    if (!verified) throw new Error('Homebrew 缓存安装包未通过发布清单校验。');
    return verified;
  } finally {
    await rm(temporaryPath, { force: true });
  }
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
