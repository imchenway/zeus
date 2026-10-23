import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { link, lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** 平台安全操作明确区分普通文件和目录。 */
export type PrivatePathKind = 'file' | 'directory';

/** 根据宿主固定的安装位置查找原生程序，禁止按 PATH 搜索可替换命令。 */
function windowsSecurityExecutable(): string {
  if (process.platform !== 'win32') throw new Error('Windows 原生安全操作只能在 Windows 运行。');
  /** 打包和开发入口均由宿主固定程序位置。 */
  const configured = process.env.ZEUS_WINDOWS_SECURITY_HELPER;
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = configured
    ? [configured]
    : [join(resources ?? join(dirname(process.execPath), 'resources'), 'native', 'zeus-windows-security.exe'), fileURLToPath(new URL('../../../apps/desktop/dist/native/zeus-windows-security.exe', import.meta.url))];
  const executable = candidates.find((path) => isAbsolute(path) && existsSync(path));
  if (!executable) throw Object.assign(new Error('Windows 安全组件缺失，请修复 Zeus 安装。'), { code: 'ZEUS_WINDOWS_SECURITY_HELPER_MISSING', failClosed: true });
  return executable;
}

/** 解码有界响应，只传播原生错误说明，不附带请求或秘密。 */
function decodeWindowsSecurityResponse<T>(serialized: string, succeeded: boolean): T {
  let response: { ok?: boolean; result?: T; error?: { code?: string; message?: string } };
  try {
    response = JSON.parse(serialized) as typeof response;
  } catch {
    throw Object.assign(new Error('Windows 安全组件返回了无效结果。'), { code: 'ZEUS_WINDOWS_SECURITY_PROTOCOL_INVALID', failClosed: true });
  }
  if (!succeeded || response.ok !== true) throw Object.assign(new Error(response.error?.message ?? 'Windows 安全操作失败。'), { code: response.error?.code ?? 'ZEUS_WINDOWS_SECURITY_FAILED', failClosed: true });
  return response.result as T;
}

/** 启动前的同步安全检查使用有界 JSON 管道，不把秘密放进命令参数。 */
export function windowsSecurityRequest<T>(request: Readonly<Record<string, unknown>>): T {
  const result = spawnSync(windowsSecurityExecutable(), [], { input: `${JSON.stringify(request)}\n`, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.signal) throw Object.assign(new Error('Windows 安全组件未完成请求。', { cause: result.error }), { code: 'ZEUS_WINDOWS_SECURITY_HELPER_FAILED', failClosed: true });
  return decodeWindowsSecurityResponse<T>(result.stdout, result.status === 0);
}

/** 日常凭据请求异步执行，系统解密或原生程序启动不会阻塞桌面事件循环。 */
export function windowsSecurityRequestAsync<T>(request: Readonly<Record<string, unknown>>): Promise<T> {
  return new Promise<T>((resolveRequest, rejectRequest) => {
    const child = execFile(windowsSecurityExecutable(), [], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error && (error.killed || typeof error.code === 'string')) {
        rejectRequest(Object.assign(new Error('Windows 安全组件未完成请求。'), { code: 'ZEUS_WINDOWS_SECURITY_HELPER_FAILED', failClosed: true }));
        return;
      }
      try {
        resolveRequest(decodeWindowsSecurityResponse<T>(stdout, !error));
      } catch (failure) {
        rejectRequest(failure);
      }
    });
    // 子进程提早退出时由退出回调报告唯一错误，不对未知写入结果重试。
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(`${JSON.stringify(request)}\n`, 'utf8');
  });
}

/** 创建或收紧应用自有文件权限；Windows 使用受保护 DACL，POSIX 使用 mode。 */
export function ensurePrivatePathSync(path: string, kind: PrivatePathKind): void {
  if (process.platform === 'win32') {
    windowsSecurityRequest({ operation: 'ensure-private', path, kind });
    return;
  }
  if (kind === 'directory') mkdirSync(path, { recursive: true, mode: 0o700 });
  assertOwnedPathSync(path, kind);
  chmodSync(path, kind === 'directory' ? 0o700 : 0o600);
}

/** 验证当前用户归属和普通对象类型，不更改现有对象。 */
export function assertOwnedPathSync(path: string, kind: PrivatePathKind): void {
  if (process.platform === 'win32') {
    windowsSecurityRequest({ operation: 'assert-owned', path, kind });
    return;
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) || (typeof process.getuid === 'function' && stats.uid !== process.getuid()))
    throw Object.assign(new Error('安全文件或目录类型、归属无效。'), { code: 'ZEUS_PRIVATE_PATH_UNSAFE', failClosed: true });
}

/** 校验当前用户私有权限；调用方不能用 Windows mode 位代替真实 DACL。 */
export function assertPrivatePathSync(path: string, kind: PrivatePathKind): void {
  if (process.platform === 'win32') {
    windowsSecurityRequest({ operation: 'assert-private', path, kind });
    return;
  }
  assertOwnedPathSync(path, kind);
  if ((lstatSync(path).mode & 0o077) !== 0) throw Object.assign(new Error('安全文件或目录权限范围过宽。'), { code: 'ZEUS_PRIVATE_PATH_UNSAFE', failClosed: true });
}

/** Windows 使用拒绝写入/删除的原生句柄读取私有文件。 */
export function readPrivateFileSync(path: string, maximumBytes: number): Buffer {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0 || maximumBytes > 4 * 1024 * 1024) throw new Error('安全文件读取上限无效。');
  if (process.platform === 'win32') return Buffer.from(windowsSecurityRequest<{ bytes: string }>({ operation: 'read-private', path, maximumBytes }).bytes, 'base64');
  assertPrivatePathSync(path, 'file');
  /** 路径检查与句柄必须指向同一个私有普通文件。 */
  const entry = lstatSync(path, { bigint: true });
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.dev !== entry.dev || stats.ino !== entry.ino || stats.nlink !== 1n || (stats.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())))
      throw new Error('安全文件身份、链接数或权限无效。');
    if (stats.size <= 0n || stats.size > BigInt(maximumBytes)) throw new Error('安全文件大小超出读取上限。');
    /** 最多读取声明长度加一个字节，拒绝读取期间增长或被替换的内容。 */
    const bytes = Buffer.alloc(Number(stats.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(descriptor, bytes, length, bytes.length - length, length);
      if (read === 0) break;
      length += read;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (BigInt(length) !== stats.size || after.size !== stats.size || after.mtimeNs !== stats.mtimeNs || after.ctimeNs !== stats.ctimeNs || after.nlink !== 1n) throw new Error('安全文件在读取期间发生变化。');
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}

/** 在真实句柄上复核目录项身份，补齐 Windows 不支持 O_NOFOLLOW 的边界。 */
export function openRegularFileNoFollowSync(path: string, flags: number): number {
  if (process.platform !== 'win32') return openSync(path, flags | constants.O_NOFOLLOW);
  windowsSecurityRequest({ operation: 'inspect-path', path });
  /** 打开前的目录项必须与最终文件句柄和目录项保持同一身份。 */
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('文件读取目标必须是普通文件。');
  const descriptor = openSync(path, flags);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const current = lstatSync(path, { bigint: true });
    windowsSecurityRequest({ operation: 'inspect-path', path });
    if (!opened.isFile() || current.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('文件路径在打开期间发生替换。');
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

/** 异步大文件流同样复核实际句柄身份，避免只检查路径名称。 */
export async function openRegularFileNoFollow(path: string, flags: number): Promise<FileHandle> {
  if (process.platform !== 'win32') return open(path, flags | constants.O_NOFOLLOW);
  windowsSecurityRequest({ operation: 'inspect-path', path });
  /** 打开前记录普通目录项身份，打开后必须仍是同一文件。 */
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('文件读取目标必须是普通文件。');
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    windowsSecurityRequest({ operation: 'inspect-path', path });
    if (!opened.isFile() || current.isSymbolicLink() || before.dev !== opened.dev || before.ino !== opened.ino || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('文件路径在打开期间发生替换。');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** 同卷发布文件：Windows 原生写穿透移动；POSIX 原子发布后刷新目录。 */
export async function publishFile(source: string, target: string, options: { replace: boolean }): Promise<void> {
  if (process.platform === 'win32') {
    await windowsSecurityRequestAsync({ operation: 'publish-file', source, target, replace: options.replace });
    return;
  }
  /** 刷新内容后再发布名称，失败不能被当作已持久化。 */
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (options.replace) await rename(source, target);
  else {
    await link(source, target);
    await unlink(source);
  }
  syncPosixDirectory(dirname(target));
  if (dirname(source) !== dirname(target)) syncPosixDirectory(dirname(source));
}

/** 同步调用方沿用相同的持久化发布语义。 */
export function publishFileSync(source: string, target: string, options: { replace: boolean }): void {
  if (process.platform === 'win32') {
    windowsSecurityRequest({ operation: 'publish-file', source, target, replace: options.replace });
    return;
  }
  /** 复制或 SQLite 生成的候选也必须先把文件内容落盘。 */
  const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  if (options.replace) renameSync(source, target);
  else {
    linkSync(source, target);
    unlinkSync(source);
  }
  syncPosixDirectory(dirname(target));
  if (dirname(source) !== dirname(target)) syncPosixDirectory(dirname(source));
}

/** POSIX 目录刷新只用于本平台；Windows 调用方必须使用原生发布操作。 */
function syncPosixDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** 统一目录包含判断，明确拒绝 Windows 跨盘绝对路径。 */
export function pathIsInside(candidate: string, parent: string): boolean {
  const child = relative(resolve(parent), resolve(candidate));
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Windows 目标名称必须可无损表示，禁止设备文件、ADS 和被系统折叠的末尾字符。 */
export function assertWindowsPortablePath(path: string): void {
  if (
    path.includes('\\') ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\p{Cc}]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part))
  )
    throw Object.assign(new Error(`文件名无法在 Windows 上无损保存：${path}`), { code: 'ZEUS_WINDOWS_PATH_UNREPRESENTABLE', failClosed: true });
}

/** Windows 恢复前校验全部文件与隐式目录，禁止大小写合并及文件/目录冲突。 */
export function assertWindowsPortablePaths(paths: readonly string[]): void {
  const entries = new Map<string, { path: string; file: boolean }>();
  for (const path of paths) {
    assertWindowsPortablePath(path);
    const parts = path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const prefix = parts.slice(0, index + 1).join('/');
      const file = index === parts.length - 1;
      const key = prefix.toUpperCase();
      const previous = entries.get(key);
      if (previous && (previous.path !== prefix || previous.file || file)) throw Object.assign(new Error(`Windows 恢复路径存在名称冲突：${path}`), { code: 'ZEUS_WINDOWS_PATH_UNREPRESENTABLE', failClosed: true });
      entries.set(key, { path: prefix, file });
    }
  }
}
