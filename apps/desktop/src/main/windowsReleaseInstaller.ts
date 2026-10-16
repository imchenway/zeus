import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ensurePrivatePathSync, readPrivateFileSync, publishFileSync, windowsSecurityRequest } from '@zeus/storage/platform-security';
import type { CreateReleaseUpdateServiceOptions, DesktopReleaseUpdateStatus } from './releaseUpdateService.js';
import { releaseUpdateDirectory } from './releaseInstallerProtocol.js';

/** 安装器就绪必须在主程序开始退出之前得到确认。 */
const installerReadyTimeoutMs = 15_000;

/** Windows 更新事务与恢复包的持久化身份。 */
interface WindowsInstallTransaction {
  /** 随机事务身份，不能重用已开始的安装。 */
  transactionId: string;
  /** 只有此版本的实际启动就绪才能提交完成。 */
  expectedVersion: string;
  /** 恢复时重新安装的已知上版应用版本。 */
  previousVersion: string;
  /** 安装器写入状态的固定文件。 */
  resultPath: string;
  /** 当前旧版签名有效的安装包摘要。 */
  recoverySha256: string;
}

/** 校验 Windows 安装器与当前应用属于相同的受信任发行者。 */
export async function verifyWindowsReleaseSignature(installerPath: string, executablePath: string): Promise<void> {
  /** 原生 WinTrust 校验使用固定助手，不把证书信息当作可执行脚本。 */
  const installer = windowsSecurityRequest<{ valid: boolean; subject: string }>({ operation: 'verify-authenticode', path: resolve(installerPath) });
  const application = windowsSecurityRequest<{ valid: boolean; subject: string }>({ operation: 'verify-authenticode', path: resolve(executablePath) });
  if (!installer.valid || !application.valid || !installer.subject || installer.subject !== application.subject) throw new Error('更新包签名无效或发行者与当前应用不同。');
}

/** 在应用安装目录外启动 NSIS；安装器持有旧主进程句柄并等待正常退出。 */
export async function installWindowsRelease(options: CreateReleaseUpdateServiceOptions, installerPath: string, update: DesktopReleaseUpdateStatus): Promise<boolean> {
  if (!(options.testMode && options.allowUntrustedTestUpdate)) await verifyWindowsReleaseSignature(installerPath, options.currentExecutablePath);
  /** 只复制 NSIS 已记录且签名通过的上一安装器，不自行拼接注册表安装目录。 */
  const cachedPath = (await readFile(join(dirname(options.currentExecutablePath), 'resources/installer-cache-path.txt'), 'utf16le')).replace(/^\uFEFF/u, '').trim();
  if (!cachedPath) throw new Error('当前安装缺少恢复安装器，请先手动重新安装正式 Windows 包。');
  if (!(options.testMode && options.allowUntrustedTestUpdate)) await verifyWindowsReleaseSignature(cachedPath, options.currentExecutablePath);
  /** 恢复包放在持久数据根，卸载程序不会删除此目录。 */
  const directory = releaseUpdateDirectory(options.userDataPath);
  await mkdir(directory, { recursive: true });
  ensurePrivatePathSync(directory, 'directory');
  /** 每次准备只替换尚未开始的事务；未知安装结果不能自动重放。 */
  const pendingPath = join(directory, 'windows-install-pending.json');
  try {
    const pending = readWindowsInstallTransaction(pendingPath);
    const result = JSON.parse(
      await readFile(pending.resultPath, 'utf8').catch(() => {
        throw new Error('上一次安装没有确定回执，请使用恢复入口处理。');
      }),
    ) as { transactionId?: string; status?: string };
    if (result.transactionId !== pending.transactionId) throw new Error('上一次安装回执身份无效，不能开始新的安装。');
    if (!['completed', 'failed', 'cancelled'].includes(result.status ?? '')) throw new Error('上一次 Windows 安装结果尚未确认，请先恢复或检查现有安装。');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  /** 先复制到临时文件再发布恢复包，避免复制中断损坏已有恢复入口。 */
  const recoveryPath = join(directory, 'windows-recovery.exe');
  await copyFile(cachedPath, `${recoveryPath}.partial`);
  ensurePrivatePathSync(`${recoveryPath}.partial`, 'file');
  publishFileSync(`${recoveryPath}.partial`, recoveryPath, { replace: true });
  /** 摘要与上版恢复包绑定，后续打开前再次验证。 */
  const transaction: WindowsInstallTransaction = {
    transactionId: randomUUID(),
    expectedVersion: update.latestVersion,
    previousVersion: options.currentAppVersion,
    resultPath: '',
    recoverySha256: await hashWindowsInstaller(recoveryPath),
  };
  transaction.resultPath = join(directory, `installer-${transaction.transactionId}.json`);
  await persistWindowsInstallRecord(pendingPath, JSON.stringify(transaction));
  return launchWindowsInstaller(options, installerPath, transaction);
}

/** 安装和恢复共用同一退出接力，不能让恢复入口跳过停止工作。 */
async function launchWindowsInstaller(options: CreateReleaseUpdateServiceOptions, installerPath: string, transaction: WindowsInstallTransaction): Promise<boolean> {
  /** 仅保留本次启动的安装器对象，取消时不能按同名进程批量终止。 */
  let installer: ChildProcess | undefined;
  /** 保存本次子进程的真实终止事件，取消不能仅凭 kill 返回值继续退出。 */
  let installerExit: Promise<void> | undefined;
  /** Main 与失败收尾共用一次撤销，不重复写入未知外部结果。 */
  let cancellation: Promise<void> | undefined;
  /** 在旧 Main 仍存活时撤销独立安装器，文件替换尚未开始。 */
  function cancel(): Promise<void> {
    return (cancellation ??= (async () => {
      await persistWindowsInstallRecord(`${transaction.resultPath}.cancel`, transaction.transactionId);
      if (installerExit) {
        if (installer?.exitCode === null && installer.signalCode === null) installer.kill();
        /** 有界等待真实 exit；失败必须阻止后续正常退出，不宣称撤销成功。 */
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            installerExit,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error('Windows 安装器尚未确认退出；取消状态未完成，不能继续正常退出。')), 10_000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      await persistWindowsInstallRecord(transaction.resultPath, JSON.stringify({ transactionId: transaction.transactionId, status: 'cancelled' }));
    })());
  }
  /** 用户尚未同意时不启动安装器；取消后保留下载包供下次明确操作。 */
  let accepted = false;
  try {
    accepted = await options.onInstallReady(async () => {
      if (cancellation) throw new Error('本次 Windows 安装已撤销，不能重新启动安装器。');
      /** NSIS 使用独立 exe，不能以待替换的 Zeus.exe 运行 JS 助手。 */
      const child = spawn(
        installerPath,
        ['/S', '--force-run', `/ZEUS-PID=${process.pid}`, `/ZEUS-TRANSACTION=${transaction.transactionId}`, `/ZEUS-RESULT=${transaction.resultPath}`, `/ZEUS-TARGET=${resolve(options.currentExecutablePath)}`],
        { detached: true, stdio: 'ignore', windowsHide: true },
      );
      installer = child;
      installerExit = new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
        child.once('error', () => {
          if (!child.pid) resolveExit();
        });
      });
      /** 记录确定的启动错误，不将超时误当作可以重复执行。 */
      let launchError: Error | null = null;
      /** 提前退出是确定失败；不能把互斥锁冲突误报为安装结果未知。 */
      let exitedBeforeReady = false;
      child.once('error', (error) => {
        launchError = error;
      });
      child.once('exit', () => {
        exitedBeforeReady = true;
      });
      child.unref();
      /** 就绪回执由安装器打开并核验旧 UI 句柄后写入。 */
      const deadline = Date.now() + installerReadyTimeoutMs;
      while (Date.now() < deadline) {
        if (launchError) throw launchError;
        if (exitedBeforeReady) throw new Error('Windows 安装器在准备完成前已退出，请确认没有其他安装器运行后手动重试。');
        try {
          const result = JSON.parse(await readFile(transaction.resultPath, 'utf8')) as { transactionId?: string; status?: string };
          if (result.transactionId !== transaction.transactionId) throw new Error('Windows 安装器事务身份不匹配。');
          if (result.status === 'ready') return;
          if (result.status === 'failed') throw new Error('Windows 安装器未能安全准备升级。');
        } catch (error) {
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      throw new Error('Windows 安装器准备结果未知，已取消重启；不会自动再次启动安装器。');
    }, cancel);
  } finally {
    if (!accepted) {
      await cancel();
    }
  }
  return accepted;
}

/** 新版 UI 与执行宿主均已就绪后才确认安装完成；启动失败不能伪造成功。 */
export async function completeWindowsReleaseInstall(userDataPath: string, currentVersion: string): Promise<void> {
  if (process.platform !== 'win32') return;
  /** 无更新事务属于正常首次启动。 */
  const pendingPath = join(releaseUpdateDirectory(userDataPath), 'windows-install-pending.json');
  try {
    const transaction = readWindowsInstallTransaction(pendingPath);
    if (transaction.expectedVersion !== currentVersion) return;
    const result = JSON.parse(await readFile(transaction.resultPath, 'utf8')) as { transactionId?: string; status?: string };
    if (result.transactionId !== transaction.transactionId || result.status !== 'installed') return;
    await persistWindowsInstallRecord(transaction.resultPath, JSON.stringify({ transactionId: transaction.transactionId, status: 'completed', updatedAt: new Date().toISOString() }));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
}

/** 恢复入口只打开摘要与发行者都再次校验通过的旧安装器。 */
export async function openWindowsRecoveryInstaller(options: CreateReleaseUpdateServiceOptions): Promise<void> {
  if (process.platform !== 'win32') throw new Error('恢复安装器只适用于 Windows。');
  /** 恢复路径由数据布局确定，不能接受渲染层传入任意可执行文件。 */
  const directory = releaseUpdateDirectory(options.userDataPath);
  const transaction = readWindowsInstallTransaction(join(directory, 'windows-install-pending.json'));
  const recoveryPath = join(directory, 'windows-recovery.exe');
  if ((await hashWindowsInstaller(recoveryPath)) !== transaction.recoverySha256) throw new Error('恢复安装器摘要已变化。');
  await verifyWindowsReleaseSignature(recoveryPath, options.currentExecutablePath);
  /** 显式恢复先撤销旧事务；仍在等待的旧安装器必须退出，不能在未来退出时执行旧更新。 */
  await persistWindowsInstallRecord(`${transaction.resultPath}.cancel`, transaction.transactionId);
  /** 恢复同样生成新事务，避免复用已经完成或取消的安装器。 */
  const recoveryTransaction: WindowsInstallTransaction = { ...transaction, transactionId: randomUUID(), expectedVersion: transaction.previousVersion, resultPath: '' };
  recoveryTransaction.resultPath = join(directory, `installer-${recoveryTransaction.transactionId}.json`);
  await persistWindowsInstallRecord(join(directory, 'windows-install-pending.json'), JSON.stringify(recoveryTransaction));
  await launchWindowsInstaller(options, recoveryPath, recoveryTransaction);
}

/** 先落盘独立候选再原子发布，进程中断不能留下半份事务或取消记录。 */
async function persistWindowsInstallRecord(path: string, content: string): Promise<void> {
  /** 随机独占创建避免继承旧候选文件或链接。 */
  const candidate = `${path}.${randomUUID()}.partial`;
  const handle = await open(candidate, 'wx', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  ensurePrivatePathSync(candidate, 'file');
  publishFileSync(candidate, path, { replace: true });
}

/** 持久化事务也是输入边界；拒绝伪造路径、无效身份和超大文件。 */
function readWindowsInstallTransaction(path: string): WindowsInstallTransaction {
  /** Windows 私有读取同时核对当前用户归属和 reparse point。 */
  const value = JSON.parse(readPrivateFileSync(path, 32 * 1024).toString('utf8')) as Partial<WindowsInstallTransaction>;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.transactionId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.transactionId) ||
    typeof value.expectedVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value.expectedVersion) ||
    typeof value.previousVersion !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(value.previousVersion) ||
    typeof value.recoverySha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.recoverySha256) ||
    value.resultPath !== join(dirname(path), `installer-${value.transactionId}.json`)
  )
    throw new Error('Windows 更新事务记录无效，不能继续安装。');
  return value as WindowsInstallTransaction;
}

/** 恢复安装器使用有界流计算摘要，避免大型安装包占满界面进程内存。 */
async function hashWindowsInstaller(path: string): Promise<string> {
  const hash = createHash('sha256');
  let bytesRead = 0;
  for await (const chunk of createReadStream(path)) {
    bytesRead += chunk.length;
    if (bytesRead > 2 * 1024 * 1024 * 1024) throw new Error('恢复安装器超过允许大小。');
    hash.update(chunk);
  }
  return hash.digest('hex');
}
