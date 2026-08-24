import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

const sessionViewCacheSchemaGeneration = 'zeus-session-view-cache-v1';
const maximumSessionViewCacheFileBytes = 33 * 1024 * 1024;
const maximumSessionViewCacheEntries = 32;

/** 缓存损坏或越界只影响重启首屏优化，绝不能阻断 Zeus 启动。 */
export function readSessionViewCache(filePath: string): unknown | null {
  try {
    const metadata = lstatSync(filePath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) ||
      metadata.size <= 0 ||
      metadata.size > maximumSessionViewCacheFileBytes
    )
      return null;
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return hasValidEnvelope(value) ? value : null;
  } catch {
    return null;
  }
}

/** Renderer 已做语义清洗；Main 再限制信封、条目数、实际 UTF-8 体积和文件权限。 */
export function writeSessionViewCache(filePath: string, value: unknown): boolean {
  if (!hasValidEnvelope(value)) return false;
  let serialized: string;
  try {
    serialized = `${JSON.stringify(value)}\n`;
  } catch {
    return false;
  }
  if (Buffer.byteLength(serialized, 'utf8') > maximumSessionViewCacheFileBytes) return false;

  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(temporaryPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
    return true;
  } catch {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // 临时文件可能未创建；显示缓存写入失败时继续使用内存热缓存。
    }
    return false;
  }
}

function hasValidEnvelope(value: unknown): value is { schemaGeneration: string; savedAt: string; entries: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaGeneration?: unknown }).schemaGeneration === sessionViewCacheSchemaGeneration &&
    typeof (value as { savedAt?: unknown }).savedAt === 'string' &&
    Array.isArray((value as { entries?: unknown }).entries) &&
    (value as { entries: unknown[] }).entries.length <= maximumSessionViewCacheEntries
  );
}
