import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** 显示缓存可随时重建，旧的整文件格式不再读取。 */
const cacheSchema = 'zeus-session-display-cache';
/** 单会话、总量与有效期共同约束磁盘使用。 */
const cacheLimits = { entryBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, entries: 32, ageMs: 14 * 24 * 60 * 60 * 1000 };
/** 会话身份仅用作哈希输入，不能控制文件路径。 */
interface CacheIdentity {
  projectId: string;
  conversationId: string;
}
/** 显示缓存信封每次只含当前会话。 */
interface CacheEnvelope {
  schemaGeneration: string;
  savedAt: string;
  entries: Array<CacheIdentity & { cachedAt: string; state: unknown }>;
}
/** ponytail: 最多 32 个显示文件串行落盘；写入吞吐成为瓶颈时改成按会话队列。 */
let pendingWrite: Promise<boolean> = Promise.resolve(true);

/** 在信任边界限制身份长度；文件名不泄漏会话或项目名。 */
function validIdentity(value: unknown): value is CacheIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as CacheIdentity;
  return [identity.projectId, identity.conversationId].every((part) => typeof part === 'string' && part.length > 0 && part.length <= 512);
}

/** 身份字段按 JSON 编码后哈希，避免拼接歧义。 */
function cachePath(root: string, identity: CacheIdentity): string {
  return join(
    root,
    `${createHash('sha256')
      .update(JSON.stringify([identity.projectId, identity.conversationId]))
      .digest('hex')}.json`,
  );
}

/** 缓存无效只影响显示加速，不影响权威数据加载。 */
function validEnvelope(value: unknown): value is CacheEnvelope {
  if (!value || typeof value !== 'object') return false;
  const envelope = value as CacheEnvelope;
  if (envelope.schemaGeneration !== cacheSchema || !Array.isArray(envelope.entries) || envelope.entries.length !== 1) return false;
  const entry = envelope.entries[0]!;
  if (!validIdentity(entry)) return false;
  return [envelope.savedAt, entry.cachedAt].every((timestamp) => {
    const age = Date.now() - Date.parse(timestamp);
    return Number.isFinite(age) && age >= -60_000 && age <= cacheLimits.ageMs;
  });
}

/** 使用异步句柄校验同一个文件，拒绝链接、越权文件与过大内容。 */
export async function readSessionViewCache(root: string, identity: unknown): Promise<unknown | null> {
  if (!validIdentity(identity)) return null;
  try {
    const directory = await lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) return null;
    const file = await open(cachePath(root, identity), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) || metadata.size <= 0 || metadata.size > cacheLimits.entryBytes)
        return null;
      const value: unknown = JSON.parse(await file.readFile('utf8'));
      return validEnvelope(value) && value.entries[0]!.projectId === identity.projectId && value.entries[0]!.conversationId === identity.conversationId ? value : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

/** 原子写入后只查元数据清理过期或越界项，不重读其他会话正文。 */
export function writeSessionViewCache(root: string, value: unknown): Promise<boolean> {
  if (!validEnvelope(value)) return Promise.resolve(false);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return Promise.resolve(false);
  }
  if (Buffer.byteLength(serialized, 'utf8') > cacheLimits.entryBytes) return Promise.resolve(false);
  const target = cachePath(root, value.entries[0]!);
  pendingWrite = pendingWrite.then(async () => {
    const temporaryPath = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = await lstat(root);
      if (!directory.isDirectory() || directory.isSymbolicLink() || (typeof process.getuid === 'function' && directory.uid !== process.getuid())) return false;
      await chmod(root, 0o700);
      await writeFile(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      await rename(temporaryPath, target);
      const entries = await Promise.all((await readdir(root)).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).map(async (name) => ({ path: join(root, name), metadata: await lstat(join(root, name)) })));
      entries.sort((left, right) => right.metadata.mtimeMs - left.metadata.mtimeMs);
      let bytes = 0;
      let count = 0;
      for (const entry of entries) {
        bytes += entry.metadata.size;
        count += 1;
        if (count > cacheLimits.entries || bytes > cacheLimits.totalBytes || Date.now() - entry.metadata.mtimeMs > cacheLimits.ageMs) await unlink(entry.path).catch(() => undefined);
      }
      return true;
    } catch {
      await unlink(temporaryPath).catch(() => undefined);
      return false;
    }
  });
  return pendingWrite;
}
