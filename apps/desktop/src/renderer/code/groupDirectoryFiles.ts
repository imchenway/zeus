/** 审阅与 Git 文件列表共用目录分组；连续单层目录合并，遇到文件或分叉即停止。 */
export function groupDirectoryFiles<File extends { path: string }>(files: File[], prefix: string): Array<readonly [string, File[]]> {
  /** 每个下级目录保留完整后代集合，不改变文件身份。 */
  const groups = new Map<string, File[]>();
  for (const file of files) {
    /** 尾部斜杠区分目录与文件。 */
    const remainder = file.path.slice(prefix.length);
    /** 当前目录下一级的路径边界。 */
    const slash = remainder.indexOf('/');
    /** 文件只展示文件名，目录保留递归需要的分隔符。 */
    const name = slash < 0 ? remainder : remainder.slice(0, slash + 1);
    /** 同一目录的文件共用集合。 */
    const descendants = groups.get(name) ?? [];
    descendants.push(file);
    groups.set(name, descendants);
  }
  return [...groups]
    .map(([name, descendants]) => {
      while (name.endsWith('/')) {
        /** 仅在全部后代都属于同一下级目录时继续合并。 */
        const slash = descendants[0]!.path.indexOf('/', prefix.length + name.length);
        if (slash < 0) break;
        /** 合并后的路径仍保留目录分隔符。 */
        const next = descendants[0]!.path.slice(prefix.length, slash + 1);
        if (!descendants.every((file) => file.path.startsWith(prefix + next))) break;
        name = next;
      }
      return [name, descendants] as const;
    })
    .sort(([left], [right]) => Number(right.endsWith('/')) - Number(left.endsWith('/')) || left.localeCompare(right));
}
