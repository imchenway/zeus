import type { GitFileBlame } from '../features/git/gitContracts.js';

interface Entry {
  revision: string;
  updatedAt: number;
  value?: GitFileBlame;
  promise?: Promise<GitFileBlame>;
}

const entries = new Map<string, Entry>();
const ttlMs = 30_000;
const maximumEntries = 24;
const maximumLines = 100_000;

export function invalidateGitBlame(key: string): void {
  entries.delete(key);
}

/** 每个文件只保留一个版本；按最近使用顺序限制文件数和逐行数据量。 */
function prune(): void {
  const now = Date.now();
  for (const [key, entry] of entries) {
    if (!entry.promise && now - entry.updatedAt >= ttlMs) entries.delete(key);
  }
  let lines = [...entries.values()].reduce((total, entry) => total + (entry.value?.lines.length ?? 0), 0);
  for (const [key, entry] of entries) {
    if (entries.size <= maximumEntries && lines <= maximumLines) break;
    lines -= entry.value?.lines.length ?? 0;
    entries.delete(key);
  }
}

export function readCachedGitBlame(key: string, revision: string, load: () => Promise<GitFileBlame>, refresh = false): Promise<GitFileBlame> {
  prune();
  const cached = entries.get(key);
  if (cached?.revision === revision) {
    entries.delete(key);
    entries.set(key, cached);
    if (cached.value && !refresh) return Promise.resolve(cached.value);
    if (cached.promise) return cached.promise;
  }
  const entry: Entry = { revision, updatedAt: Date.now() };
  const promise = Promise.resolve()
    .then(load)
    .then((value) => {
      // 已失效或被新版本替换的请求不得重新写回缓存。
      if (entries.get(key) === entry) {
        entry.value = value;
        entry.promise = undefined;
        entry.updatedAt = Date.now();
        prune();
      }
      return value;
    })
    .catch((error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
  entry.promise = promise;
  entries.delete(key);
  entries.set(key, entry);
  prune();
  return promise;
}
