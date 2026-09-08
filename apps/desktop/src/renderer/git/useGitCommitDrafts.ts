import { useEffect, useState } from 'react';

// 存储不可用时仍在当前应用进程内保留草稿，不随 Git 页面卸载而丢失。
const memoryDrafts = new Map<string, Record<string, string>>();

export function useGitCommitDrafts(projectId: string) {
  const key = `zeus.git.commit-drafts.v1:${projectId}`;
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    if (memoryDrafts.has(key)) return memoryDrafts.get(key)!;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
      }
    } catch {
      /* 旧数据损坏或存储被禁用时使用空草稿。 */
    }
    return {};
  });
  useEffect(() => {
    const nonempty = Object.fromEntries(Object.entries(drafts).filter(([, value]) => value.length > 0));
    memoryDrafts.set(key, nonempty);
    try {
      if (Object.keys(nonempty).length) localStorage.setItem(key, JSON.stringify(nonempty));
      else localStorage.removeItem(key);
    } catch {
      /* 内存副本继续保留草稿。 */
    }
  }, [key, drafts]);
  return [drafts, setDrafts] as const;
}
