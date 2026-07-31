import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { rename, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createExecutionHostControlClient, readExecutionHostRendezvous } from './executionHostProtocol.js';
import { readReleaseInstallerBootstrap, releaseInstallerProtocolVersion, writeReleaseInstallerResult, type ReleaseInstallerBootstrap, type ReleaseInstallerResult } from './releaseInstallerProtocol.js';

const mainExitTimeoutMs = 10 * 60_000;
const reopenedUiTimeoutMs = 90_000;
const reopenedUiTestTimeoutMs = 10_000;
const pollIntervalMs = 250;

async function runReleaseInstaller(): Promise<void> {
  const bootstrapPath = process.env.ZEUS_RELEASE_INSTALLER_BOOTSTRAP_PATH?.trim();
  if (!bootstrapPath) throw new Error('ZEUS_RELEASE_INSTALLER_BOOTSTRAP_PATH is required.');
  const bootstrap = await readReleaseInstallerBootstrap(bootstrapPath);
  await unlink(bootstrapPath).catch(() => undefined);
  try {
    if (bootstrap.protocolVersion !== releaseInstallerProtocolVersion) throw new Error('Zeus release installer protocol is incompatible.');
    validateInstallerPaths(bootstrap);
    await updateResult(bootstrap, 'ready', '安装辅助进程已经就绪，正在等待旧界面退出。');
  } catch (error) {
    await updateResult(bootstrap, 'failed', error instanceof Error ? error.message : String(error)).catch(() => undefined);
    throw error;
  }
  if (!(await waitForProcessExit(bootstrap.mainPid, mainExitTimeoutMs))) {
    await updateResult(bootstrap, 'failed', '旧界面未在允许时间内退出，安装没有开始。');
    process.exitCode = 1;
    return;
  }

  await updateResult(bootstrap, 'installing', '正在原子替换 Zeus App。');
  let movedOriginal = false;
  let installedNewApp = false;
  let failedNewUiLeaseId: string | null = null;
  try {
    await rename(bootstrap.targetAppPath, bootstrap.backupAppPath);
    movedOriginal = true;
    await rename(bootstrap.stagedAppPath, bootstrap.targetAppPath);
    installedNewApp = true;
    const newProcessPid = await launchApp(bootstrap.targetAppPath, bootstrap.executableRelativePath);
    const reconnected = await waitForExpectedUi(bootstrap.userDataPath, bootstrap.expectedAppVersion, bootstrap.testMode ? reopenedUiTestTimeoutMs : reopenedUiTimeoutMs);
    if (!reconnected) {
      failedNewUiLeaseId = await readCurrentUiLeaseId(bootstrap.userDataPath);
      if (!(await terminateProcess(newProcessPid))) throw new Error('新版界面未能连接执行宿主，且安装器无法安全终止该进程。');
      throw new Error('新版界面未在允许时间内重新连接执行宿主。');
    }
    await updateResult(bootstrap, 'completed', '升级完成，新版 Zeus 已重新连接执行宿主；旧 App 备份将在该宿主停止后清理。');
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    try {
      if (installedNewApp) {
        const failedPath = `${bootstrap.stagedAppPath}.failed`;
        await rename(bootstrap.targetAppPath, failedPath);
      }
      if (movedOriginal) await rename(bootstrap.backupAppPath, bootstrap.targetAppPath);
      if (movedOriginal) {
        await launchApp(bootstrap.targetAppPath, bootstrap.executableRelativePath);
        const rollbackReconnected = await waitForExpectedUi(bootstrap.userDataPath, bootstrap.previousAppVersion, bootstrap.testMode ? reopenedUiTestTimeoutMs : reopenedUiTimeoutMs, failedNewUiLeaseId);
        if (!rollbackReconnected) throw new Error('旧 App 已恢复，但旧界面未能重新连接执行宿主。');
      }
      await updateResult(bootstrap, 'rolled_back', `升级失败，已恢复旧 App：${failure.message}`);
    } catch (rollbackError) {
      await updateResult(bootstrap, 'failed', `升级失败且自动回滚未完成：${failure.message}；${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    process.exitCode = 1;
  }
}

async function launchApp(appPath: string, executableRelativePath: string): Promise<number> {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.ZEUS_RELEASE_INSTALLER_BOOTSTRAP_PATH;
  const child = spawn(join(appPath, executableRelativePath), [], {
    detached: true,
    stdio: 'ignore',
    env: environment,
  });
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn);
    child.once('error', rejectSpawn);
  });
  child.unref();
  if (!child.pid) throw new Error('Zeus release installer could not launch the App.');
  return child.pid;
}

async function waitForExpectedUi(userDataPath: string, expectedAppVersion: string, timeoutMs: number, excludedLeaseId: string | null = null): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rendezvous = await readExecutionHostRendezvous(userDataPath);
    if (rendezvous) {
      try {
        const status = await createExecutionHostControlClient(rendezvous).health();
        if (status.uiLease.connected && status.uiLease.appVersion === expectedAppVersion && status.uiLease.leaseId !== excludedLeaseId) return true;
      } catch {
        // 宿主可能正好重启或更新 rendezvous，继续按截止时间重试。
      }
    }
    await wait(pollIntervalMs);
  }
  return false;
}

async function readCurrentUiLeaseId(userDataPath: string): Promise<string | null> {
  const rendezvous = await readExecutionHostRendezvous(userDataPath);
  if (!rendezvous) return null;
  try {
    const status = await createExecutionHostControlClient(rendezvous).health();
    return status.uiLease.connected ? status.uiLease.leaseId : null;
  } catch {
    return null;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await wait(pollIntervalMs);
  }
  return !processExists(pid);
}

async function terminateProcess(pid: number): Promise<boolean> {
  if (!processExists(pid)) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return !processExists(pid);
  }
  if (await waitForProcessExit(pid, 10_000)) return true;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return !processExists(pid);
  }
  return waitForProcessExit(pid, 5_000);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolveWait) => {
    setTimeout(resolveWait, delayMs);
  });
}

function validateInstallerPaths(input: ReleaseInstallerBootstrap): void {
  const target = resolve(input.targetAppPath);
  const staged = resolve(input.stagedAppPath);
  const backup = resolve(input.backupAppPath);
  const parent = dirname(target);
  if (dirname(staged) !== parent || dirname(backup) !== parent) throw new Error('Zeus update staging and backup paths must share the installed App parent directory.');
  if (!basename(target).endsWith('.app') || !basename(staged).startsWith('.') || !basename(backup).startsWith('.')) {
    throw new Error('Zeus release installer App paths are invalid.');
  }
  if (target === staged || target === backup || staged === backup) throw new Error('Zeus release installer App paths must be distinct.');
  if (!input.testMode && basename(target) !== 'Zeus.app') throw new Error('Production release installer can only replace Zeus.app.');
  if (input.testMode) {
    for (const path of [target, staged, backup, resolve(input.userDataPath)]) {
      if (!isUnderTemporaryRoot(path)) throw new Error('Test release installer paths must remain under the system temporary directory.');
    }
  }
}

function isUnderTemporaryRoot(path: string): boolean {
  const normalizedPath = canonicalizeContainmentPath(path);
  return [tmpdir(), '/tmp'].map(canonicalizeContainmentPath).some((root) => {
    const pathRelative = relative(root, normalizedPath);
    return Boolean(pathRelative) && !pathRelative.startsWith('..') && !pathRelative.includes('/../');
  });
}

function canonicalizeContainmentPath(path: string): string {
  const normalizedPath = resolve(path);
  try {
    return realpathSync(normalizedPath);
  } catch {
    try {
      return join(realpathSync(dirname(normalizedPath)), basename(normalizedPath));
    } catch {
      return normalizedPath;
    }
  }
}

async function updateResult(input: ReleaseInstallerBootstrap, status: ReleaseInstallerResult['status'], message: string): Promise<void> {
  await writeReleaseInstallerResult(input.userDataPath, {
    transactionId: input.transactionId,
    status,
    message,
    updatedAt: new Date().toISOString(),
  });
}

function isNodeError(value: unknown, code: string): value is NodeJS.ErrnoException {
  return value instanceof Error && (value as NodeJS.ErrnoException).code === code;
}

void runReleaseInstaller().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
