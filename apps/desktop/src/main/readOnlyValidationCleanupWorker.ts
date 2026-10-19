import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** 父进程退出检查间隔。 */
const parentCheckIntervalMs = 250;
/** 最长等待五分钟；超时保留现场，不冒险删除仍在使用的数据。 */
const maximumParentChecks = 1_200;

/** 只接受标准 SHA-256 文本。 */
function requireSha256(value: string | undefined): string {
  if (!value || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('只读验收清理摘要无效。');
  return value;
}

/** 只接受当前用户 `.zeus-test` 下的标准只读验收目录形态。 */
async function requireValidationRoot(value: string | undefined): Promise<string> {
  if (!value || !isAbsolute(value)) throw new Error('只读验收清理路径无效。');
  const root = resolve(value);
  const base = resolve(homedir(), '.zeus-test');
  const relativePath = relative(base, root);
  const segments = relativePath.split(sep);
  if (segments.length !== 3 || !/^instance-[a-f0-9]{16}$/u.test(segments[0]!) || segments[1] !== 'read-only-validation' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(segments[2]!)) {
    throw new Error('只读验收清理路径不属于标准隔离目录。');
  }
  const status = await lstat(root);
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(root)) !== root) throw new Error('只读验收清理目录身份无效。');
  return root;
}

/** 清理前再次核对 manifest 与目录、运行编号和数据库路径绑定。 */
async function verifyValidationManifest(root: string, manifestHash: string): Promise<void> {
  const manifestPath = join(root, 'data', 'zeus.db.read-only-validation.json');
  /** 等待父进程期间不得替换验证根、data 目录或 manifest。 */
  await requireValidationRoot(root);
  const manifestStatus = await lstat(manifestPath);
  if (!manifestStatus.isFile() || manifestStatus.isSymbolicLink() || manifestStatus.size > 64 * 1024 || (await realpath(manifestPath)) !== manifestPath) throw new Error('只读验收清单不再是原物理路径中的有界普通文件。');
  const value = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  const runId = relative(resolve(homedir(), '.zeus-test'), root).split(sep).at(-1);
  if (value.manifestHash !== manifestHash || value.validationRoot !== root || value.runId !== runId) throw new Error('只读验收清理 manifest 身份不匹配。');
  /** 自签摘要只检测误操作与变化，不能代替上面的根路径约束。 */
  const payload = { ...value };
  delete payload.manifestHash;
  if (createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== manifestHash) throw new Error('只读验收清理 manifest 内容摘要不匹配。');
  const database = value.database as Record<string, unknown> | undefined;
  if (database?.path !== join(root, 'data', 'zeus.db')) throw new Error('只读验收清理数据库路径不匹配。');
}

/** 判断原 Electron 进程是否仍存在；权限错误按仍存活处理。 */
function parentIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** 使用短定时器等待，不阻塞事件循环。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

/** 等待父进程完全退出后删除本次验证根；任何身份异常都失败关闭并保留证据。 */
async function main(): Promise<void> {
  const root = await requireValidationRoot(process.argv[2]);
  /** 父进程退出前后必须是同一物理目录，避免追删同名新实例。 */
  const originalIdentity = await lstat(root, { bigint: true });
  const parentPid = Number(process.argv[3]);
  const manifestHash = requireSha256(process.argv[4]);
  if (!Number.isSafeInteger(parentPid) || parentPid <= 1) throw new Error('只读验收清理父进程无效。');
  await verifyValidationManifest(root, manifestHash);
  for (let check = 0; check < maximumParentChecks; check += 1) {
    if (!parentIsRunning(parentPid)) {
      await verifyValidationManifest(root, manifestHash);
      const currentIdentity = await lstat(root, { bigint: true });
      if (currentIdentity.dev !== originalIdentity.dev || currentIdentity.ino !== originalIdentity.ino) throw new Error('只读验收根在等待退出时已替换，继续保留。');
      // Windows 的 SQLite、Chromium 或安全软件句柄可能稍晚释放，使用 Node 原生有界重试。
      await rm(root, { recursive: true, force: false, maxRetries: 40, retryDelay: parentCheckIntervalMs });
      return;
    }
    await delay(parentCheckIntervalMs);
  }
  throw new Error('只读验收进程在清理等待期内没有退出，已保留验证副本。');
}

await main();
