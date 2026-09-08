import { Fragment, useMemo, type ReactNode } from 'react';
import type { TaskGitFileDiff } from '../session/sessionTypes.js';
import { SyntaxHighlightedLine, useSyntaxHighlightedSegments, type HighlightedLine } from '../code/SyntaxHighlightedCode.js';

/** 交付与会话审核共用左右差异；审核可在原始行号处补充操作及评论。 */
export function TaskGitDiffTable(props: {
  /** 已按补丁片段解析的文件差异。 */
  diff: TaskGitFileDiff | null;
  /** 区分尚未选择文件与当前文件没有文本差异。 */
  hasSelection: boolean;
  /** 沿用所在页面的中英文文案。 */
  zh: boolean;
  /** 自定义有效行号的操作；空白补位和片段头不产生可操作行。 */
  renderLineNumber?: (line: number, side: 'left' | 'right') => ReactNode;
  /** 评论排在对应侧的代码行下方，左右行始终共用同一行高。 */
  renderLineComments?: (line: number, side: 'left' | 'right') => ReactNode;
}) {
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
    <div className="task-git-review-diff-table" role="table" aria-label={props.zh ? '左右代码差异' : 'Side-by-side code diff'}>
      {rows.map((row) => {
        /** 两侧评论只在真实存在的行上渲染。 */
        const leftComments = row.leftNumber === '' ? null : props.renderLineComments?.(row.leftNumber, 'left');
        /** 右侧评论独立保留新文件行号。 */
        const rightComments = row.rightNumber === '' ? null : props.renderLineComments?.(row.rightNumber, 'right');
        return (
          <Fragment key={row.key}>
            <div className={`task-git-review-diff-row is-${row.kind}`} role="row">
              <span className="line-number" role="cell">
                {row.leftNumber === '' ? '' : (props.renderLineNumber?.(row.leftNumber, 'left') ?? row.leftNumber)}
              </span>
              <code role="cell">
                <SyntaxHighlightedLine line={highlightedLine(row.leftKey, row.left, leftInput, leftHighlights)} empty="" />
              </code>
              <span className="line-number" role="cell">
                {row.rightNumber === '' ? '' : (props.renderLineNumber?.(row.rightNumber, 'right') ?? row.rightNumber)}
              </span>
              <code role="cell">
                <SyntaxHighlightedLine line={highlightedLine(row.rightKey, row.right, rightInput, rightHighlights)} empty="" />
              </code>
            </div>
            {leftComments || rightComments ? (
              <div className="task-git-review-diff-row" role="row">
                <div className="task-git-review-diff-annotation" role="cell" aria-colspan={2}>
                  {leftComments}
                </div>
                <div className="task-git-review-diff-annotation" role="cell" aria-colspan={2}>
                  {rightComments}
                </div>
              </div>
            ) : null}
          </Fragment>
        );
      })}
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
