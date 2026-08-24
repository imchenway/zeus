import { useMemo } from 'react';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import { SyntaxHighlightedLine, useSyntaxHighlightedSegments, type HighlightedLine } from '../code/SyntaxHighlightedCode.js';

export function TaskGitDiffTable(props: { diff: TaskGitFileDiff | null; hasSelection: boolean; zh: boolean }) {
  const leftInput = useMemo(() => buildHighlightInput(props.diff, 'left'), [props.diff]);
  const rightInput = useMemo(() => buildHighlightInput(props.diff, 'right'), [props.diff]);
  const leftHighlights = useSyntaxHighlightedSegments(props.diff?.oldPath ?? '', leftInput.contents);
  const rightHighlights = useSyntaxHighlightedSegments(props.diff?.newPath ?? '', rightInput.contents);
  const rows = useMemo(() => buildRows(props.diff), [props.diff]);

  if (!props.diff) {
    return (
      <p className="task-git-review-empty">{props.hasSelection ? (props.zh ? '该文件暂无可显示的文本差异。' : 'No text diff is available for this file.') : props.zh ? '请选择文件查看代码差异。' : 'Select a file to view its code diff.'}</p>
    );
  }
  if (props.diff.hunks.length === 0) {
    return <p className="task-git-review-empty">{props.zh ? '文件已经变化，但没有可显示的文本内容，可能是二进制文件或仅文件属性变化。' : 'The file changed, but no text content is available; it may be binary or metadata-only.'}</p>;
  }
  return (
    <div className="task-git-review-diff-table" role="table">
      {rows.map((row) => (
        <div key={row.key} className={`task-git-review-diff-row is-${row.kind}`} role="row">
          <span className="line-number">{row.leftNumber}</span>
          <code>
            <SyntaxHighlightedLine line={highlightedLine(row.leftKey, row.left, leftInput, leftHighlights)} empty="" />
          </code>
          <span className="line-number">{row.rightNumber}</span>
          <code>
            <SyntaxHighlightedLine line={highlightedLine(row.rightKey, row.right, rightInput, rightHighlights)} empty="" />
          </code>
        </div>
      ))}
    </div>
  );
}

interface TaskDiffRow {
  key: string;
  kind: 'header' | 'context' | 'addition' | 'deletion' | 'metadata';
  leftNumber: number | '';
  left: string;
  leftKey?: string;
  rightNumber: number | '';
  right: string;
  rightKey?: string;
}

interface TaskDiffHighlightInput {
  contents: string[];
  positions: Map<string, { segment: number; line: number }>;
}

function buildRows(diff: TaskGitFileDiff | null): TaskDiffRow[] {
  if (!diff) return [];
  return diff.hunks.flatMap((hunk, hunkIndex) => [
    { key: `${hunkIndex}:header`, kind: 'header' as const, leftNumber: '' as const, left: hunk.header, rightNumber: '' as const, right: hunk.header },
    ...hunk.lines.map((line, lineIndex) => {
      const highlightKey = `${hunkIndex}:${lineIndex}`;
      return {
        key: highlightKey,
        kind: line.type,
        leftNumber: line.oldLineNumber ?? ('' as const),
        left: line.type === 'addition' ? '' : line.content,
        ...(line.type === 'addition' || line.type === 'metadata' ? {} : { leftKey: highlightKey }),
        rightNumber: line.newLineNumber ?? ('' as const),
        right: line.type === 'deletion' ? '' : line.content,
        ...(line.type === 'deletion' || line.type === 'metadata' ? {} : { rightKey: highlightKey }),
      };
    }),
  ]);
}

function buildHighlightInput(diff: TaskGitFileDiff | null, side: 'left' | 'right'): TaskDiffHighlightInput {
  const contents: string[] = [];
  const positions = new Map<string, { segment: number; line: number }>();
  for (const [hunkIndex, hunk] of (diff?.hunks ?? []).entries()) {
    const segment = contents.length;
    const segmentLines: string[] = [];
    hunk.lines.forEach((line, lineIndex) => {
      const belongsToSide = line.type === 'context' || (side === 'left' ? line.type === 'deletion' : line.type === 'addition');
      if (!belongsToSide) return;
      positions.set(`${hunkIndex}:${lineIndex}`, { segment, line: segmentLines.length });
      segmentLines.push(line.content);
    });
    contents.push(segmentLines.join('\n'));
  }
  return { contents, positions };
}

function highlightedLine(key: string | undefined, content: string, input: TaskDiffHighlightInput, highlights: HighlightedLine[][]): HighlightedLine {
  const position = key ? input.positions.get(key) : undefined;
  return (position ? highlights[position.segment]?.[position.line] : null) ?? (content ? [{ text: content }] : []);
}
