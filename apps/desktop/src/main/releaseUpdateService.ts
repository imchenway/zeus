import { execFile as execFileCallback, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createLegacyFlatZeusDataLayout, createZeusDataLayout } from '@zeus/local-server';
import { releaseInstallerProtocolVersion, releaseInstallerResultPath, writeReleaseInstallerBootstrap } from './releaseInstallerProtocol.js';

const execFile = promisify(execFileCallback);
const maximumUpdateBytes = 2 * 1024 * 1024 * 1024;
const installerReadyTimeoutMs = 10_000;
const installerPollIntervalMs = 100;

export interface DesktopReleaseUpdateStatus {
  status: 'up_to_date' | 'available' | 'unavailable';
  currentVersion: string;
  latestVersion: string;
  channel: 'stable' | 'preview';
  releasePageUrl: string;
  artifact: {
    arch: 'arm64' | 'x64';
    kind: 'dmg';
    fileName: string;
    sha256: string;
    sizeBytes: number | null;
    downloadUrl: string;
  } | null;
  executionHostProtocolVersion: number;
  automaticInstallEnabled: boolean;
  recommendedAction: 'none' | 'open_download_page' | 'download_and_install';
  label: string;
  reason: string;
  checkedAt: string;
  executionHost?: unknown;
}

export interface DesktopReleaseUpdateOperation {
  accepted: boolean;
  update: DesktopReleaseUpdateStatus;
  reason: string;
}

export interface CreateReleaseUpdateServiceOptions {
  userDataPath: string;
  currentAppPath: string;
  currentExecutablePath: string;
  currentAppVersion: string;
  localServerConfig: () => { baseUrl: string; apiToken: string };
  isPackaged: boolean;
  testMode: boolean;
  allowUntrustedTestUpdate: boolean;
  onInstallReady: () => void;
}

interface PreparedUpdate {
  update: DesktopReleaseUpdateStatus;
  dmgPath: string;
}

export interface ReleaseUpdateService {
  download(): Promise<DesktopReleaseUpdateOperation>;
  install(): Promise<DesktopReleaseUpdateOperation>;
}

/**
 * 执行宿主可能仍从旧 App 备份运行；只有宿主完成最终关闭后，Main 才能清理这些受控备份。
 */
export async function cleanupStaleReleaseBackups(currentAppPath: string): Promise<string[]> {
  const appName = basename(currentAppPath, '.app');
  if (!appName || basename(currentAppPath) !== `${appName}.app`) throw new Error('Zeus App 路径无效，不能清理升级备份。');
  const parent = dirname(currentAppPath);
  const prefix = `.${appName}.backup-`;
  const suffix = '.app';
  const removed: string[] = [];
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !entry.name.startsWith(prefix) || !entry.name.endsWith(suffix)) continue;
    const transactionId = entry.name.slice(prefix.length, -suffix.length);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(transactionId)) continue;
    const backupPath = join(parent, entry.name);
    const backupStat = await lstat(backupPath);
    if (!backupStat.isDirectory() || backupStat.isSymbolicLink()) continue;
    await rm(backupPath, { recursive: true, force: false });
    removed.push(backupPath);
  }
  return removed;
}

/** Main 负责下载与安装准备；真正替换 App 的动作交给脱离界面生命周期的辅助进程。 */
export function createReleaseUpdateService(options: CreateReleaseUpdateServiceOptions): ReleaseUpdateService {
  let prepared: PreparedUpdate | null = null;
  let operationChain: Promise<DesktopReleaseUpdateOperation> | null = null;

  function exclusive(operation: () => Promise<DesktopReleaseUpdateOperation>): Promise<DesktopReleaseUpdateOperation> {
    if (operationChain) return operationChain;
    operationChain = operation().finally(() => {
      operationChain = null;
    });
    return operationChain;
  }

  return {
    download: () =>
      exclusive(async () => {
        const update = await loadUpdateStatus(options);
        assertDownloadAllowed(update, options);
        const artifact = update.artifact!;
        if (basename(artifact.fileName) !== artifact.fileName) throw new Error('更新包文件名包含非法路径。');
        const dataLayout = existsSync(join(options.userDataPath, 'data')) ? createZeusDataLayout(options.userDataPath) : createLegacyFlatZeusDataLayout(options.userDataPath);
        const downloadDirectory = join(dataLayout.releaseUpdates, 'downloads', update.latestVersion);
        await mkdir(downloadDirectory, { recursive: true, mode: 0o700 });
        await chmod(downloadDirectory, 0o700);
        const dmgPath = join(downloadDirectory, artifact.fileName);
        await downloadVerifiedArtifact({
          url: artifact.downloadUrl,
          targetPath: dmgPath,
          expectedSha256: artifact.sha256,
          expectedSizeBytes: artifact.sizeBytes,
          testMode: options.testMode && options.allowUntrustedTestUpdate,
        });
        prepared = { update, dmgPath };
        return {
          accepted: true,
          update,
          reason: '更新包已下载并通过 SHA-256 校验，等待安装确认。',
        };
      }),
    install: () =>
      exclusive(async () => {
        const update = await loadUpdateStatus(options);
        assertDownloadAllowed(update, options);
        if (!prepared || prepared.update.latestVersion !== update.latestVersion || prepared.update.artifact?.sha256 !== update.artifact?.sha256) {
          return { accepted: false, update, reason: '已下载更新与当前发布清单不一致，请重新下载。' };
        }
        const transactionId = randomUUID();
        const staged = await stageUpdateApp({
          dmgPath: prepared.dmgPath,
          transactionId,
          targetAppPath: options.currentAppPath,
          expectedVersion: update.latestVersion,
          testMode: options.testMode && options.allowUntrustedTestUpdate,
        });
        const executableRelativePath = relative(options.currentAppPath, options.currentExecutablePath);
        const backupAppPath = join(dirname(options.currentAppPath), `.${basename(options.currentAppPath, '.app')}.backup-${transactionId}.app`);
        const bootstrapPath = await writeReleaseInstallerBootstrap(options.userDataPath, {
          protocolVersion: releaseInstallerProtocolVersion,
          transactionId,
          mainPid: process.pid,
          targetAppPath: options.currentAppPath,
          stagedAppPath: staged.appPath,
          backupAppPath,
          executableRelativePath,
          userDataPath: options.userDataPath,
          previousAppVersion: options.currentAppVersion,
          expectedAppVersion: staged.appVersion,
          testMode: options.testMode && options.allowUntrustedTestUpdate,
          createdAt: new Date().toISOString(),
        });
        await launchInstallerAndWaitUntilReady(bootstrapPath, options.userDataPath, transactionId);
        options.onInstallReady();
        return {
          accepted: true,
          update,
          reason: '安装辅助进程已就绪；Zeus 将退出界面、替换 App，并在成功后自动重新打开。',
        };
      }),
  };
}

async function loadUpdateStatus(options: CreateReleaseUpdateServiceOptions): Promise<DesktopReleaseUpdateStatus> {
  const config = options.localServerConfig();
  const response = await fetch(`${config.baseUrl}/api/release/check-update`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Zeus update status failed with HTTP ${response.status}.`);
  const value = (await response.json()) as unknown;
  if (!isReleaseUpdateStatus(value)) throw new Error('Zeus update status response is invalid.');
  return value;
}

function assertDownloadAllowed(update: DesktopReleaseUpdateStatus, options: CreateReleaseUpdateServiceOptions): void {
  if (!options.isPackaged) throw new Error('Zeus 只允许 packaged App 执行应用内安装。');
  if (update.currentVersion !== options.currentAppVersion) throw new Error('更新状态中的当前版本与正在运行的 App 不一致。');
  if (update.status !== 'available' || !update.artifact) throw new Error('当前没有可安装的更新。');
  if (update.executionHostProtocolVersion !== 1) throw new Error('更新包与当前执行宿主协议不兼容，必须等待任务排空后手动升级。');
  if (!update.automaticInstallEnabled && !(options.testMode && options.allowUntrustedTestUpdate)) {
    throw new Error('更新包未同时通过签名、公证和协议兼容门禁。');
  }
}

async function downloadVerifiedArtifact(input: { url: string; targetPath: string; expectedSha256: string; expectedSizeBytes: number | null; testMode: boolean }): Promise<void> {
  if (await verifyExistingArtifact(input.targetPath, input.expectedSha256, input.expectedSizeBytes)) return;
  const temporaryPath = `${input.targetPath}.${randomUUID()}.partial`;
  const output = await open(temporaryPath, 'wx', 0o600);
  const hash = createHash('sha256');
  let receivedBytes = 0;
  try {
    const source = new URL(input.url);
    if (source.protocol === 'file:') {
      if (!input.testMode || !isUnderTemporaryDirectory(fileURLToPath(source))) throw new Error('本地更新源只允许用于隔离测试。');
      const bytes = await readFile(fileURLToPath(source));
      receivedBytes = bytes.length;
      hash.update(bytes);
      await output.write(bytes);
    } else {
      const loopbackTestSource = input.testMode && source.protocol === 'http:' && source.hostname === '127.0.0.1' && Boolean(source.port);
      if (!loopbackTestSource && !isTrustedGithubDownloadUrl(source)) throw new Error('更新下载地址不是受信任的 GitHub Release。');
      const response = await fetch(source, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
      if (!response.ok || !response.body) throw new Error(`更新下载失败：HTTP ${response.status}`);
      const responseUrl = new URL(response.url);
      const loopbackTestResponse = input.testMode && responseUrl.protocol === 'http:' && responseUrl.hostname === '127.0.0.1' && Boolean(responseUrl.port);
      if (!loopbackTestResponse && !isTrustedGithubResponseUrl(responseUrl)) throw new Error('更新下载重定向离开了受信任的 GitHub 产物域名。');
      for await (const chunk of response.body) {
        const bytes = Buffer.from(chunk);
        receivedBytes += bytes.length;
        if (receivedBytes > maximumUpdateBytes) throw new Error('更新包超过允许大小。');
        hash.update(bytes);
        await output.write(bytes);
      }
    }
    await output.sync();
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await output.close();
  }
  const actualSha256 = hash.digest('hex');
  if (actualSha256 !== input.expectedSha256 || (input.expectedSizeBytes !== null && receivedBytes !== input.expectedSizeBytes)) {
    await rm(temporaryPath, { force: true });
    throw new Error('更新包摘要或大小与发布清单不一致。');
  }
  await rm(input.targetPath, { force: true }).catch(() => undefined);
  await rename(temporaryPath, input.targetPath);
  await chmod(input.targetPath, 0o600);
}

async function verifyExistingArtifact(path: string, expectedSha256: string, expectedSizeBytes: number | null): Promise<boolean> {
  try {
    const bytes = await readFile(path);
    if (expectedSizeBytes !== null && bytes.length !== expectedSizeBytes) return false;
    return createHash('sha256').update(bytes).digest('hex') === expectedSha256;
  } catch {
    return false;
  }
}

async function stageUpdateApp(input: { dmgPath: string; transactionId: string; targetAppPath: string; expectedVersion: string; testMode: boolean }): Promise<{ appPath: string; appVersion: string }> {
  const targetStat = await lstat(input.targetAppPath);
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) throw new Error('当前 Zeus App 不是可安全替换的普通目录。');
  const targetParent = dirname(input.targetAppPath);
  await access(targetParent, fsConstants.W_OK);
  const stagedAppPath = join(targetParent, `.${basename(input.targetAppPath, '.app')}.update-${input.transactionId}.app`);
  const mount = await mountDmg(input.dmgPath);
  try {
    const appName = input.testMode ? basename(input.targetAppPath) : 'Zeus.app';
    const sourceAppPath = join(mount, appName);
    const sourceStat = await lstat(sourceAppPath);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error(`更新 DMG 缺少 ${appName}。`);
    await execFile('/usr/bin/ditto', [sourceAppPath, stagedAppPath], { maxBuffer: 8 * 1024 * 1024 });
    await verifyStagedApp(stagedAppPath, input.expectedVersion, input.testMode);
    const appVersion = await readAppVersion(stagedAppPath);
    return { appPath: stagedAppPath, appVersion };
  } catch (error) {
    await rm(stagedAppPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await execFile('/usr/bin/hdiutil', ['detach', mount, '-force'], { maxBuffer: 8 * 1024 * 1024 }).catch(() => undefined);
  }
}

async function mountDmg(dmgPath: string): Promise<string> {
  const { stdout } = await execFile('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', dmgPath], { maxBuffer: 8 * 1024 * 1024 });
  let mount: string | undefined;
  for (const line of stdout.split(/\r?\n/u)) {
    const candidate = line.split('\t').at(-1)?.trim() ?? '';
    if (candidate.startsWith('/Volumes/')) mount = candidate;
  }
  if (!mount) throw new Error('无法从更新 DMG 识别挂载点。');
  return mount;
}

async function verifyStagedApp(appPath: string, expectedVersion: string, testMode: boolean): Promise<void> {
  await execFile('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { maxBuffer: 8 * 1024 * 1024 });
  const appVersion = await readAppVersion(appPath);
  if (!testMode && appVersion !== expectedVersion) throw new Error(`更新 App 版本不匹配：expected=${expectedVersion} actual=${appVersion}`);
  if (testMode) return;
  await execFile('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], { maxBuffer: 8 * 1024 * 1024 });
  await execFile('/usr/bin/xcrun', ['stapler', 'validate', appPath], { maxBuffer: 8 * 1024 * 1024 });
}

async function readAppVersion(appPath: string): Promise<string> {
  const { stdout } = await execFile('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(appPath, 'Contents', 'Info.plist')], { maxBuffer: 1024 * 1024 });
  const version = stdout.trim();
  if (!version) throw new Error('更新 App 缺少版本号。');
  return version;
}

async function launchInstallerAndWaitUntilReady(bootstrapPath: string, userDataPath: string, transactionId: string): Promise<void> {
  const entryPath = join(dirname(fileURLToPath(import.meta.url)), 'releaseInstaller.js');
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ZEUS_RELEASE_INSTALLER_BOOTSTRAP_PATH: bootstrapPath,
    },
  });
  child.unref();
  const resultPath = releaseInstallerResultPath(userDataPath, transactionId);
  const deadline = Date.now() + installerReadyTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
      if (isRecord(value) && value.transactionId === transactionId && value.status === 'ready') return;
      if (isRecord(value) && (value.status === 'failed' || value.status === 'rolled_back')) {
        throw new Error(typeof value.message === 'string' ? value.message : '安装辅助进程启动失败。');
      }
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
    await wait(installerPollIntervalMs);
  }
  throw new Error('安装辅助进程未在允许时间内就绪。');
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    const timer = setTimeout(resolveWait, delayMs);
    timer.unref();
  });
}

function currentTemporaryRoot(): string {
  try {
    return realpathSync(resolve(process.env.TMPDIR?.trim() || '/tmp'));
  } catch {
    return resolve(process.env.TMPDIR?.trim() || '/tmp');
  }
}

function isUnderTemporaryDirectory(path: string): boolean {
  const normalized = resolve(path);
  return [currentTemporaryRoot(), resolve('/tmp')].some((root) => {
    const pathRelative = relative(root, normalized);
    return Boolean(pathRelative) && !pathRelative.startsWith('..') && !pathRelative.includes('/../');
  });
}

function isTrustedGithubDownloadUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname === 'github.com' && /^\/[^/]+\/[^/]+\/releases\/download\//u.test(url.pathname);
}

function isTrustedGithubResponseUrl(url: URL): boolean {
  return url.protocol === 'https:' && ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname);
}

function isReleaseUpdateStatus(value: unknown): value is DesktopReleaseUpdateStatus {
  return (
    isRecord(value) &&
    (value.status === 'up_to_date' || value.status === 'available' || value.status === 'unavailable') &&
    typeof value.currentVersion === 'string' &&
    typeof value.latestVersion === 'string' &&
    (value.channel === 'stable' || value.channel === 'preview') &&
    typeof value.releasePageUrl === 'string' &&
    typeof value.automaticInstallEnabled === 'boolean' &&
    Number.isInteger(value.executionHostProtocolVersion) &&
    (value.recommendedAction === 'none' || value.recommendedAction === 'open_download_page' || value.recommendedAction === 'download_and_install') &&
    typeof value.label === 'string' &&
    typeof value.reason === 'string' &&
    typeof value.checkedAt === 'string' &&
    (value.artifact === null ||
      (isRecord(value.artifact) &&
        (value.artifact.arch === 'arm64' || value.artifact.arch === 'x64') &&
        value.artifact.kind === 'dmg' &&
        typeof value.artifact.fileName === 'string' &&
        typeof value.artifact.sha256 === 'string' &&
        /^[a-f0-9]{64}$/u.test(value.artifact.sha256) &&
        (value.artifact.sizeBytes === null || (typeof value.artifact.sizeBytes === 'number' && Number.isSafeInteger(value.artifact.sizeBytes))) &&
        typeof value.artifact.downloadUrl === 'string'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === code;
}
