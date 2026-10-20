import type { FilePreviewItem, FileReviewDiff } from '@zeus/shared';

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
