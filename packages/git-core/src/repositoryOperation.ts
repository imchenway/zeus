import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** 只读解析公共 Git 目录，让桌面桥接与后台宿主共用互斥身份。 */
const execute = promisify(execFile);
/** 嵌套的同一操作可重入；并行用户动作不共享所有权。 */
const ownership = new AsyncLocalStorage<ReadonlyArray<{ directory: string; active: boolean }>>();

/** 文件锁覆盖多个宿主进程，崩溃后仅在确认原进程不存在时回收。 */
export async function withGitRepositoryOperation<T>(cwd: string, operation: () => Promise<T>): Promise<T> {
  /** Git 自己确定工作树的公共目录，不使用客户端传入的锁路径。 */
  const result = await execute('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, timeout: 15_000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  /** 同一仓库的全部工作树共享锁。 */
  const directory = join(await realpath(result.stdout.trim()), 'zeus-operation-lock');
  if (ownership.getStore()?.some((lease) => lease.active && lease.directory === directory)) return operation();
  /** 两次尝试只用于确认已死亡进程留下的锁，不自动重试 Git 写操作。 */
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      /** 锁文件尚未写完或不可读时视为忙，不删除其他进程的新锁。 */
      const entries = await readdir(directory).catch(() => [] as string[]);
      const owner = entries.length === 1 ? entries[0]! : '';
      const pid = /^owner-[0-9]+-[a-f0-9-]+$/u.test(owner) ? Number(owner.split('-')[1]) : 0;
      if (attempt === 0 && Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
        } catch (reason) {
          if ((reason as NodeJS.ErrnoException).code === 'ESRCH') {
            // 只删除刚才看到的唯一所有权文件；另一回收者已经处理时不能碰新锁。
            try {
              await unlink(join(directory, owner));
              await rmdir(directory);
            } catch {
              throw Object.assign(new Error('仓库锁正在恢复，请稍后继续。'), { code: 'ZEUS_GIT_BUSY', statusCode: 409 });
            }
            continue;
          }
        }
      }
      throw Object.assign(new Error('该仓库已有 Git 操作正在执行，请等待完成后继续。'), { code: 'ZEUS_GIT_BUSY', statusCode: 409 });
    }
  }
  /** 活跃标志在 finally 撤销，后台子任务不能继承已释放的锁。 */
  const lease = { directory, active: true };
  /** 唯一文件名避免旧进程恢复时删除另一个新锁。 */
  const owner = join(directory, `owner-${process.pid}-${randomUUID()}`);
  try {
    await writeFile(owner, '', { flag: 'wx' });
    return await ownership.run([...(ownership.getStore() ?? []), lease], operation);
  } finally {
    lease.active = false;
    await unlink(owner).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await rmdir(directory);
  }
}
