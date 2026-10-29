import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 只读解析公共 Git 目录，让桌面桥接与后台宿主共用互斥身份。 */
const execute = promisify(execFile);
/** 嵌套的同一操作可重入；并行用户动作不共享所有权。 */
const ownership = new AsyncLocalStorage<ReadonlyArray<{ directory: string; active: boolean }>>();
/** 准备目录携带完整所有者身份，尚未发布时不会占用正式锁。 */
const pendingDirectoryPrefix = 'zeus-operation-pending-';

/** 只有身份完整且进程已不存在的所有者可回收；权限不足和 PID 复用均保守保留。 */
function ownerProcessHasExited(owner: string): boolean {
  /** UUID 限定所有者格式，避免把目录内未知文件当作进程身份。 */
  const match = /^owner-([1-9][0-9]*)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.exec(owner);
  /** PID 必须处于系统进程号的有符号整数范围。 */
  const pid = match ? Number(match[1]) : 0;
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** 仅删除空目录；新持有者已发布非空目录时，保留其完整所有权。 */
async function removeEmptyLockDirectory(directory: string): Promise<boolean> {
  try {
    await rmdir(directory);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if (['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** 删除确切的唯一所有者文件；并发回收已处理该文件时不触碰其他所有者。 */
async function removeOwnedLockDirectory(directory: string, owner: string): Promise<void> {
  await unlink(join(directory, owner)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await removeEmptyLockDirectory(directory);
}

/** 回收释放中断后的空目录或死亡进程的锁；未知内容及活跃进程始终保留。 */
async function recoverLockDirectory(directory: string, expectedOwner?: string): Promise<boolean> {
  /** 路径消失表示另一回收者已完成；不可读不等于空目录。 */
  const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (entries === null) return true;
  if (entries.length === 0) return removeEmptyLockDirectory(directory);
  /** 只认可单一所有者；准备目录还须匹配其路径内的身份。 */
  const owner = entries.length === 1 ? entries[0]! : '';
  if ((expectedOwner !== undefined && owner !== expectedOwner) || !ownerProcessHasExited(owner)) return false;
  await removeOwnedLockDirectory(directory, owner);
  return true;
}

/** 清理发布前崩溃的准备目录，避免反复中断累积无主目录；不递归删除未知内容。 */
async function recoverPendingLockDirectories(commonDirectory: string): Promise<void> {
  /** 只枚举公共 Git 目录的直接子项，不遍历对象库或工作树。 */
  const entries = await readdir(commonDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(pendingDirectoryPrefix)) continue;
    /** 准备目录名与所有者文件名使用同一个随机身份。 */
    const owner = entry.name.slice(pendingDirectoryPrefix.length);
    if (ownerProcessHasExited(owner)) await recoverLockDirectory(join(commonDirectory, entry.name), owner);
  }
}

/** 返回可由桌面与后台入口共同识别的仓库竞争结果。 */
function repositoryBusyError(): Error & { code: string; statusCode: number } {
  return Object.assign(new Error('该仓库已有 Git 操作正在执行，请等待完成后继续。'), { code: 'ZEUS_GIT_BUSY', statusCode: 409 });
}

/** 完整所有者目录一次发布为锁，多宿主互斥且不暴露初始化中的空目录。 */
export async function withGitRepositoryOperation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  /** Git 自己确定工作树的公共目录，不使用客户端传入的锁路径。 */
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  /** 同一仓库全部工作树与路径别名共用真实 Git 目录。 */
  const commonDirectory = await realpath(result.stdout.trim());
  /** 正式锁固定名称，使全部宿主争用同一位置。 */
  const directory = join(commonDirectory, 'zeus-operation-lock');
  if (ownership.getStore()?.some((lease) => lease.active && lease.directory === directory)) return operation();
  await recoverPendingLockDirectories(commonDirectory);
  /** 随机身份确保回收者只删除自己观察到的所有者文件。 */
  const owner = `owner-${process.pid}-${randomUUID()}`;
  /** 与正式锁处于同一目录，重命名不跨文件系统。 */
  const pendingDirectory = join(commonDirectory, `${pendingDirectoryPrefix}${owner}`);
  await mkdir(pendingDirectory);
  try {
    await writeFile(join(pendingDirectory, owner), '', { flag: 'wx' });
    /** 只重试一次锁发布，绝不重放 Git 写操作。 */
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // 非空目标不能被目录重命名覆盖，初始化完成前只存在私有准备目录。
        await rename(pendingDirectory, directory);
        break;
      } catch (error) {
        // Windows 已有目标可报 EPERM/EACCES；仍须读取实际目录，不能据错误码直接删除。
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (!(await recoverLockDirectory(directory))) throw repositoryBusyError();
        if (attempt === 1) throw error;
      }
    }
    /** 释放前撤销重入身份，后台子任务不能继承已结束的操作。 */
    const lease = { directory, active: true };
    try {
      return await ownership.run([...(ownership.getStore() ?? []), lease], operation);
    } finally {
      lease.active = false;
      await removeOwnedLockDirectory(directory, owner);
    }
  } finally {
    await removeOwnedLockDirectory(pendingDirectory, owner);
  }
}
