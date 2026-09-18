import type { ProjectSourceRevision } from './projectSourceWorkspace.js';

export interface ProjectSourceTextSearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
}

export interface ProjectSourceTextSearchInput extends ProjectSourceTextSearchOptions {
  projectId: string;
  query: string;
}

/** 位置基于编辑器使用的 LF 文本，列号和偏移量均为 UTF-16。 */
export interface ProjectSourceTextMatch {
  offset: number;
  length: number;
  text: string;
  line: number;
  column: number;
  preview: string;
  previewColumn: number;
}

export interface ProjectSourceTextSearchFile {
  relativePath: string;
  revision: ProjectSourceRevision;
  matches: ProjectSourceTextMatch[];
}

export interface ProjectSourceTextSearchResult {
  files: ProjectSourceTextSearchFile[];
  truncated: boolean;
}

export const projectSourceTextSearchLimit = 1000;

/** 磁盘与未保存草稿共用字面量匹配规则，避免搜索和替换的边界不一致。 */
export function findProjectSourceTextMatches(content: string, query: string, options: ProjectSourceTextSearchOptions = {}, limit = projectSourceTextSearchLimit): { matches: ProjectSourceTextMatch[]; truncated: boolean } {
  if (!query || query.length > 1024 || /[\r\n]/u.test(query)) return { matches: [], truncated: false };
  const literal = query.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = options.wholeWord ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
  const expression = new RegExp(pattern, options.matchCase ? 'gu' : 'giu');
  const matches: ProjectSourceTextMatch[] = [];
  let line = 1;
  let lineStart = 0;
  let nextLine = content.indexOf('\n');
  for (const match of content.matchAll(expression)) {
    if (matches.length >= limit) return { matches, truncated: true };
    const offset = match.index;
    while (nextLine >= 0 && nextLine < offset) {
      line += 1;
      lineStart = nextLine + 1;
      nextLine = content.indexOf('\n', lineStart);
    }
    const previewStart = Math.max(lineStart, offset - 60);
    const previewEnd = Math.min(nextLine < 0 ? content.length : nextLine, Math.max(previewStart + 220, offset + match[0].length));
    const prefix = previewStart > lineStart ? '…' : '';
    const suffix = previewEnd < (nextLine < 0 ? content.length : nextLine) ? '…' : '';
    matches.push({ offset, length: match[0].length, text: match[0], line, column: offset - lineStart + 1, preview: prefix + content.slice(previewStart, previewEnd) + suffix, previewColumn: prefix.length + offset - previewStart });
  }
  return { matches, truncated: false };
}

/** 按原始位置替换，替换文本中的 $、反斜线等字符始终按字面量处理。 */
export function replaceProjectSourceTextMatches(content: string, matches: readonly ProjectSourceTextMatch[], replacement: string): string {
  let result = '';
  let cursor = 0;
  for (const match of [...matches].sort((left, right) => left.offset - right.offset)) {
    if (match.offset < cursor || match.length <= 0 || content.slice(match.offset, match.offset + match.length) !== match.text) throw new Error('匹配内容已变化，请重新搜索后替换。');
    result += content.slice(cursor, match.offset) + replacement;
    cursor = match.offset + match.length;
  }
  return result + content.slice(cursor);
}
