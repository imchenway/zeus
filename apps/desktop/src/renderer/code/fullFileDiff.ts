import type { FilePreviewItem, FileReviewDiff } from '@zeus/shared';
import { diffArrays } from 'diff';

/** 本页撤销成功后按新读取的两端重建差异，外部列表尚未刷新时也不继续展示旧补丁。 */
export function refreshedFileDiff(file: FileReviewDiff, items: FilePreviewItem[] | null, refreshed?: boolean): FileReviewDiff {
  if (!refreshed || items?.length !== 2 || items.some((item) => !item.missing && (item.kind !== 'text' || item.truncated || item.content === undefined))) return file;
  /** 沿用现有 diff 库并限制编辑距离及计算时间，超限交给全文核对提示刷新。 */
  const parts = diffArrays(patchLines(items[0]!), patchLines(items[1]!), { timeout: 40, maxEditLength: 10000 });
  if (!parts) return file;
  /** 原始文件行号不包含显示补位。 */
  let oldLine = 1;
  let newLine = 1;
  /** 新快照保留文件身份，仅更新正文差异与统计。 */
  const lines: FileReviewDiff['hunks'][number]['lines'] = [];
  for (const part of parts)
    for (const text of part.value) {
      lines.push({ type: part.added ? 'addition' : part.removed ? 'deletion' : 'context', content: text.replace(/\n$/u, ''), oldLineNumber: part.added ? null : oldLine++, newLineNumber: part.removed ? null : newLine++ });
      if (!text.endsWith('\n')) lines.push({ type: 'metadata', content: '\\ No newline at end of file', oldLineNumber: null, newLineNumber: null });
    }
  /** 重新生成三行上下文的补丁片段，避免把全文当成一个暂存区块。 */
  const ranges: Array<{ from: number; to: number }> = [];
  lines.forEach((line, index) => {
    if (line.type === 'context' || line.type === 'metadata') return;
    const from = Math.max(0, index - 3);
    let to = Math.min(lines.length, index + 4);
    if (lines[to]?.type === 'metadata') to += 1;
    const last = ranges.at(-1);
    if (last && last.to >= from) last.to = to;
    else ranges.push({ from, to });
  });
  /** 前缀计数让每个片段的边界计算保持常数时间。 */
  const oldOffsets = [0];
  const newOffsets = [0];
  lines.forEach((line, index) => {
    oldOffsets.push(oldOffsets[index]! + (line.oldLineNumber === null ? 0 : 1));
    newOffsets.push(newOffsets[index]! + (line.newLineNumber === null ? 0 : 1));
  });
  const hunks = ranges.map(({ from, to }) => {
    const oldLines = oldOffsets[to]! - oldOffsets[from]!;
    const newLines = newOffsets[to]! - newOffsets[from]!;
    const oldStart = oldOffsets[from]! + (oldLines ? 1 : 0);
    const newStart = newOffsets[from]! + (newLines ? 1 : 0);
    return { header: `@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`, oldStart, newStart, oldLines, newLines, lines: lines.slice(from, to) };
  });
  return { ...file, addedLines: lines.filter((line) => line.type === 'addition').length, deletedLines: lines.filter((line) => line.type === 'deletion').length, hunks };
}

/** 重新生成补丁时保留末尾换行，CRLF 和 BOM 沿用显示规范化。 */
function patchLines(item: FilePreviewItem): string[] {
  if (item.missing) return [];
  return (
    item
      .content!.replace(/^\uFEFF/u, '')
      .replace(/\r\n/gu, '\n')
      .match(/[^\n]*\n|[^\n]+$/gu) ?? []
  );
}

/** 补丁、全文与归属核对使用同一显示文本，不让 CRLF 或文件头 BOM 改变行身份。 */
export function normalizedFileLine(content: string, line: number): string {
  /** CRLF 的回车不属于可见代码；只有第一行允许移除解码已处理的 BOM。 */
  const text = content.replace(/\r$/u, '');
  return line === 1 ? text.replace(/^\uFEFF/u, '') : text;
}

/** Git 行号不包含文件结尾换行生成的虚拟空行；统一 CRLF 显示，保留真实空白行。 */
function contentLines(item: FilePreviewItem): string[] {
  if (item.missing) return [];
  /** 正文只来自完整且成功解码的授权版本。 */
  const lines = item.content!.split('\n').map((line, index) => normalizedFileLine(line, index + 1));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** 原补丁提供增删身份，真实两端提供完整上下文；不猜测缺失文件或过期内容。 */
export function fullFileDiff(file: FileReviewDiff, items: FilePreviewItem[]): FileReviewDiff | null {
  if (items.length !== 2 || items.some((item) => !item.missing && (item.kind !== 'text' || item.truncated || item.content === undefined))) return null;
  /** 两端文本只按实际文件行分割，不从补丁补造全文。 */
  const left = contentLines(items[0]!);
  const right = contentLines(items[1]!);
  /** 结果仍使用共享差异契约，评论和行号不变。 */
  const lines: FileReviewDiff['hunks'][number]['lines'] = [];
  /** 两侧独立维护一基原始行号。 */
  let oldLine = 1;
  let newLine = 1;
  /** 补丁以外的内容必须一致，否则快照已变或只提供了部分补丁。 */
  function contextUntil(oldEnd: number, newEnd: number): boolean {
    if (oldEnd < oldLine || newEnd < newLine || oldEnd - oldLine !== newEnd - newLine || oldEnd > left.length + 1 || newEnd > right.length + 1) return false;
    while (oldLine < oldEnd) {
      if (left[oldLine - 1] !== right[newLine - 1]) return false;
      lines.push({ type: 'context', content: left[oldLine - 1]!, oldLineNumber: oldLine++, newLineNumber: newLine++ });
    }
    return true;
  }
  for (const hunk of file.hunks) {
    if (!contextUntil(hunk.oldStart + (hunk.oldLines === 0 ? 1 : 0), hunk.newStart + (hunk.newLines === 0 ? 1 : 0))) return null;
    for (const line of hunk.lines) {
      if (line.type === 'metadata') continue;
      /** 统一补丁与预览的 CRLF；解码去掉的文件头 BOM 不参与正文比对。 */
      const content = normalizedFileLine(line.content, line.oldLineNumber === 1 || line.newLineNumber === 1 ? 1 : 0);
      if (line.type !== 'addition' && (line.oldLineNumber !== oldLine || left[oldLine++ - 1] !== content)) return null;
      if (line.type !== 'deletion' && (line.newLineNumber !== newLine || right[newLine++ - 1] !== content)) return null;
      lines.push({ ...line, content });
    }
  }
  if (!contextUntil(left.length + 1, right.length + 1)) return null;
  return { ...file, hunks: [{ header: '', oldStart: 1, newStart: 1, oldLines: left.length, newLines: right.length, lines }] };
}
