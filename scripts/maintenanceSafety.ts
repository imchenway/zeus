import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

/** 维护子进程只接受参数数组，不经过 shell。 */
const executeFile = promisify(execFile);
/** 清单与审计文件只允许有界读取。 */
const maximumMetadataBytes = 8 * 1024 * 1024;

/** 删除计划记录的文件系统身份。 */
export interface MaintenancePathIdentity {
  /** 缺失路径只能进入元数据对账，不能追删后来重建的目录。 */
  present: boolean;
  /** 设备编号和 inode 共同识别已审阅的对象。 */
  device: string | null;
  /** 文件或目录的原始 inode。 */
  inode: string | null;
  /** 根对象最后修改时间。 */
  modifiedAtMs: string | null;
}

/** 维护目录树的元数据摘要；分配字节仅作估算，不承诺实际释放空间。 */
export interface MaintenanceTreeFacts {
  /** 所有受管项的路径、设备、inode、大小和修改时间摘要。 */
  sha256: string;
  /** 包含目录和符号链接的条目数量。 */
  entries: number;
  /** 文件系统报告的分配字节，硬链接和共享块可能重复。 */
  allocatedBytes: number;
}

/** 递归统计且不跟随符号链接；只有明确丢弃工作树时才允许把 Git 元数据纳入摘要。 */
export async function inspectMaintenanceTree(root: string, includeGitMetadata = false): Promise<MaintenanceTreeFacts> {
  await requireMaintenanceDirectory(root);
  const digest = createHash('sha256');
  const pending = [root];
  let entries = 0;
  let allocatedBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.name === '.git' && !includeGitMetadata) throw new Error(`历史材料中含 Git 元数据，需单独保全：${path}`);
      const value = await lstat(path, { bigint: true });
      const link = value.isSymbolicLink() ? await readlink(path) : null;
      digest.update(JSON.stringify([relative(root, path), String(value.dev), String(value.ino), String(value.mode), String(value.size), String(value.mtimeNs), link]));
      entries += 1;
      allocatedBytes += Number(value.blocks) * 512;
      if (value.isDirectory() && !value.isSymbolicLink()) pending.push(path);
    }
  }
  return { sha256: digest.digest('hex'), entries, allocatedBytes };
}

/** 路径包含比较适配当前平台，拒绝跨盘符和相邻名称。 */
export function maintenancePathContains(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

/** 读取原对象身份，不跟随末级符号链接。 */
export async function readMaintenanceIdentity(path: string): Promise<MaintenancePathIdentity> {
  try {
    const value = await lstat(path, { bigint: true });
    return { present: true, device: String(value.dev), inode: String(value.ino), modifiedAtMs: String(value.mtimeMs) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { present: false, device: null, inode: null, modifiedAtMs: null };
    throw error;
  }
}

/** 目录本身和全部父路径必须与真实绝对路径一致，拒绝符号链接或重解析跳转。 */
export async function requireMaintenanceDirectory(path: string): Promise<void> {
  const value = await lstat(path);
  if (!value.isDirectory() || value.isSymbolicLink() || (await realpath(path)) !== resolve(path)) throw new Error(`维护目录不是规范物理路径：${path}`);
}

/** 有界读取清单并复核打开句柄身份，Windows 没有 O_NOFOLLOW 时仍检查替换竞态。 */
export async function readMaintenanceMetadata(path: string): Promise<{ text: string; sha256: string }> {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(maximumMetadataBytes) || (await realpath(path)) !== resolve(path)) throw new Error(`维护清单不是有界普通文件：${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) throw new Error('维护清单在读取前已变化。');
    const content = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || content.byteLength > maximumMetadataBytes) throw new Error('维护清单在读取时已变化。');
    return { text: content.toString('utf8'), sha256: createHash('sha256').update(content).digest('hex') };
  } finally {
    await handle.close();
  }
}

/** 固定路径白名单只接受非空绝对路径数组，不展开通配符并拒绝重复和父子重叠。 */
export async function readMaintenanceAllowlist(path: string | null): Promise<string[] | null> {
  if (!path) return null;
  const raw: unknown = JSON.parse((await readMaintenanceMetadata(resolve(path))).text);
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10_000 || raw.some((value) => typeof value !== 'string' || !isAbsolute(value))) throw new Error('路径白名单必须是最多一万个绝对路径组成的非空 JSON 数组。');
  const paths = (raw as string[]).map((value) => resolve(value)).sort((left, right) => (process.platform === 'win32' ? left.toLowerCase() : left).localeCompare(process.platform === 'win32' ? right.toLowerCase() : right));
  const names = new Set<string>();
  for (const path of paths) {
    /** Windows 路径身份不依赖盘符或名称的大小写。 */
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (names.has(key)) throw new Error('路径白名单包含重复或父子重叠，必须逐项审阅。');
    for (let parent = dirname(path); ; parent = dirname(parent)) {
      if (names.has(process.platform === 'win32' ? parent.toLowerCase() : parent)) throw new Error('路径白名单包含重复或父子重叠，必须逐项审阅。');
      if (dirname(parent) === parent) break;
    }
    names.add(key);
  }
  return paths;
}

/** 采集当前平台的进程命令行；只在明确维护入口执行。 */
async function maintenanceProcesses(): Promise<Array<{ pid: number; parentPid: number; command: string }>> {
  if (process.platform === 'win32') {
    const result = await executeFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress',
      ],
      {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      },
    );
    const raw = JSON.parse(result.stdout || '[]') as Record<string, unknown> | Array<Record<string, unknown>>;
    return (Array.isArray(raw) ? raw : [raw]).map((row) => ({ pid: Number(row.ProcessId), parentPid: Number(row.ParentProcessId), command: `${String(row.Name ?? '')} ${String(row.ExecutablePath ?? '')} ${String(row.CommandLine ?? '')}` }));
  }
  const result = await executeFile('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return result.stdout.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
  });
}

/** 离线删除拒绝运行中的 Zeus、Provider、构建器及指向候选的进程，错误只报告 PID。 */
export async function assertOfflineMaintenance(dataRoot: string, candidatePaths: string[]): Promise<void> {
  const processes = await maintenanceProcesses();
  /** 仅当前维护脚本的启动包装器可忽略，其他维护进程不能放行。 */
  const ancestors = new Set<number>();
  for (let pid = process.ppid; pid > 1 && !ancestors.has(pid);) {
    ancestors.add(pid);
    pid = processes.find((row) => row.pid === pid)?.parentPid ?? 0;
  }
  const relatedPaths = [dataRoot, ...candidatePaths].map((path) => path.replaceAll('\\', '/').toLowerCase());
  const blockers = processes.filter(({ pid, command }) => {
    if (pid === process.pid) return false;
    /** 仅忽略正在承载同一维护脚本的启动包装器，不能忽略作为父进程的 Zeus。 */
    if (ancestors.has(pid) && process.argv[1] && command.includes(basename(process.argv[1]))) return false;
    const normalized = command.replaceAll('\\', '/').toLowerCase();
    /** macOS 由下方 lsof 核对实际占用；其他平台缺少该检查时仍保守阻止未归属的 Codex。 */
    const unscopedProvider = process.platform !== 'darwin' && /(?:^|[\s/])codex(?:\.exe)?(?:\s|$)/u.test(normalized);
    return (
      /\/zeus(?: test)?\.app\/contents\/|(?:^|[\s/])zeus(?: test)?\.exe(?:\s|$)|scripts\/release-all\.mjs|electron-builder|(?:^|\s)cargo(?:\.exe)?\s+(?:build|run)|package-(?:mac|windows)\.mjs/u.test(normalized) ||
      unscopedProvider ||
      relatedPaths.some((path) => normalized.includes(path))
    );
  });
  if (blockers.length > 0) throw new Error(`维护要求相关进程完全退出；仍有 PID：${blockers.map((row) => row.pid).join(', ')}。`);
  if (candidatePaths.some((path) => maintenancePathContains(path, process.cwd()))) throw new Error('当前维护进程的工作目录位于删除候选内。');
  await assertMaintenancePathsNotOpen([dataRoot, ...candidatePaths]);
}

/** macOS 核对全部打开文件，覆盖 cwd 以外的 SQLite、日志和编辑器句柄。 */
export async function assertMaintenancePathsNotOpen(paths: string[]): Promise<void> {
  if (process.platform !== 'darwin' || paths.length === 0) return;
  const result = await executeFile('/usr/sbin/lsof', ['-nP', '-F', 'pn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let pid = 0;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    if (!line.startsWith('n') || pid === process.pid || pid === process.ppid || !isAbsolute(line.slice(1))) continue;
    if (paths.some((path) => maintenancePathContains(path, line.slice(1)))) throw new Error(`维护候选仍被进程 ${pid} 打开，已保留。`);
  }
}

/** 显式在线回收只保护目标本身，不因正式 Zeus 使用其他目录而阻止历史材料回收。 */
export async function assertHistoricalCleanupAvailable(paths: string[]): Promise<void> {
  if (paths.some((path) => maintenancePathContains(path, process.cwd()))) throw new Error('维护进程的工作目录位于删除目标内。');
  const normalizedPaths = paths.map((path) => path.replaceAll('\\', '/').toLowerCase());
  const blockers = (await maintenanceProcesses()).filter(({ pid, command }) => pid !== process.pid && normalizedPaths.some((path) => command.replaceAll('\\', '/').toLowerCase().includes(path)));
  if (blockers.length) throw new Error(`目标仍由进程引用，已保留；PID：${blockers.map((row) => row.pid).join(', ')}。`);
  await assertMaintenancePathsNotOpen(paths);
}

/** 同一数据根一次只允许一个清理任务；中断遗留锁需核对日志后人工处理。 */
export async function withMaintenanceLease<T>(dataRoot: string, operation: () => Promise<T>): Promise<T> {
  await requireMaintenanceDirectory(dataRoot);
  const runtimeRoot = join(dataRoot, 'runtime');
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await requireMaintenanceDirectory(runtimeRoot);
  const path = join(runtimeRoot, 'generated-data-maintenance.lock');
  const handle = await open(path, 'wx', 0o600);
  const identity = await handle.stat({ bigint: true });
  /** 操作结果和租约释放错误分别保存，不能覆盖未知操作的真实错误。 */
  let outcome: { value: T } | { error: unknown };
  try {
    await handle.writeFile(`${JSON.stringify({ format: 'zeus-offline-maintenance-2026-10-19', pid: process.pid, startedAt: new Date().toISOString(), script: process.argv[1] })}\n`);
    await handle.sync();
    outcome = { value: await operation() };
  } catch (error) {
    outcome = { error };
  }
  try {
    await handle.close();
    const current = await lstat(path, { bigint: true });
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.isSymbolicLink()) throw new Error('维护锁身份变化，保留现场并核对审计，不能自动重放。');
    await unlink(path);
  } catch (error) {
    if ('error' in outcome) throw new AggregateError([outcome.error, error], '维护执行与释放租约均未完成，必须核对审计。');
    throw error;
  }
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
