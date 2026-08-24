import { useEffect, useMemo, useRef, useState, type UIEvent as ReactUIEvent } from 'react';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/dist/csr/Columns';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { RowsIcon as Rows } from '@phosphor-icons/react/dist/csr/Rows';
import type { DashboardClient, GitDiffHunk, GitDiffLine, GitDiffSummary } from '../apiClient.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { SyntaxHighlightedLine, useSyntaxHighlightedSegments, type HighlightedLine } from '../code/SyntaxHighlightedCode.js';
import '../styles.css';
import '../ui/primitives.css';

type DiffViewMode = 'side-by-side' | 'unified';
type DiffSide = { lineNumber: number | null; content: string; tone: 'context' | 'addition' | 'deletion' | 'empty'; highlightKey?: string };
type AlignedDiffRow = { key: string; metadata?: string; left?: DiffSide; right?: DiffSide };

export function ProjectGitDiffWindow(props: {
  client: Pick<DashboardClient, 'loadProjectGitWorkbench' | 'loadProjectGitCommit' | 'loadProjectGitComparisonDiff'>;
  projectId: string;
  repositoryId: string;
  filePath: string;
  stage: 'combined' | 'staged' | 'unstaged';
  commitHash?: string;
  comparisonRef?: string;
  comparisonMode?: 'current' | 'working-tree';
  language: 'zh-CN' | 'en-US';
}) {
  const zh = props.language === 'zh-CN';
  const [diff, setDiff] = useState<GitDiffSummary | null>(null);
  const [title, setTitle] = useState(props.filePath || (zh ? 'Git 差异' : 'Git diff'));
  const [selectedPath, setSelectedPath] = useState(props.filePath);
  const [error, setError] = useState<string | null>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
    title: zh ? 'Git 差异读取失败' : 'Git diff failed to load',
    source: 'ProjectGitDiffWindow',
  });

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const request = props.commitHash
      ? props.client.loadProjectGitCommit(props.projectId, props.repositoryId, props.commitHash).then((detail) => {
          setTitle(detail.commit.subject);
          return detail.diff;
        })
      : props.comparisonRef
        ? props.client.loadProjectGitComparisonDiff(props.projectId, props.repositoryId, props.comparisonRef, props.comparisonMode ?? 'current').then((summary) => {
            setTitle(`${props.comparisonRef} · ${zh ? '分支差异' : 'Branch diff'}`);
            return summary;
          })
        : props.client.loadProjectGitWorkbench(props.projectId).then((workbench) => {
            const repository = workbench.repositories.find((candidate) => candidate.id === props.repositoryId);
            if (!repository) throw new Error(zh ? '仓库已不在当前项目中。' : 'The repository is no longer part of this project.');
            const source = props.stage === 'staged' ? repository.snapshot.stagedDiff : props.stage === 'unstaged' ? repository.snapshot.unstagedDiff : repository.snapshot.diff;
            setTitle(repository.name);
            return source;
          });
    void request
      .then((next) => {
        if (cancelled) return;
        setDiff(next);
        const requested = next.fileDiffs.find((file) => file.newPath === props.filePath || file.oldPath === props.filePath);
        setSelectedPath(requested ? props.filePath : next.fileDiffs[0]?.newPath || next.fileDiffs[0]?.oldPath || '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.repositoryId, props.filePath, props.stage, props.commitHash, props.comparisonRef, props.comparisonMode]);

  useEffect(() => {
    document.title = selectedPath ? `${title} · ${selectedPath}` : title;
  }, [selectedPath, title]);

  const selectedDiff = useMemo(() => (diff && selectedPath ? selectFileDiff(diff, selectedPath) : diff), [diff, selectedPath]);
  const viewer = selectedDiff ? <SideBySideDiff diff={selectedDiff} zh={zh} title={selectedPath || title} fill /> : null;

  return (
    <main className="macos-ai-app project-git-diff-window" aria-label={zh ? 'Git 差异窗口' : 'Git diff window'}>
      {diff ? (
        diff.fileDiffs.length > 1 ? (
          <div className="project-git-diff-window-layout">
            <aside className="project-git-diff-window-files" aria-label={zh ? '变更文件' : 'Changed files'}>
              <header>
                <strong>{title}</strong>
                <small>
                  {diff.fileDiffs.length} {zh ? '个文件' : 'files'}
                </small>
              </header>
              <div>
                {diff.fileDiffs.map((file) => {
                  const path = file.newPath || file.oldPath;
                  return (
                    <button key={`${file.oldPath}:${file.newPath}`} type="button" className={path === selectedPath ? 'is-current' : ''} onClick={() => setSelectedPath(path)}>
                      <File aria-hidden="true" />
                      <span title={path}>{path}</span>
                      <em>+{file.addedLines}</em>
                      <i>-{file.deletedLines}</i>
                    </button>
                  );
                })}
              </div>
            </aside>
            {viewer}
          </div>
        ) : (
          viewer
        )
      ) : (
        <p className="project-git-diff-loading">{error ? (zh ? '当前没有可显示的差异。' : 'No diff is currently available.') : zh ? '正在读取差异…' : 'Loading diff…'}</p>
      )}
    </main>
  );
}

export function SideBySideDiff(props: { diff: GitDiffSummary | null; zh: boolean; title?: string; fill?: boolean }) {
  const [mode, setMode] = useState<DiffViewMode>('side-by-side');
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const syncingVerticalScrollRef = useRef(false);
  const file = props.diff?.fileDiffs[0] ?? null;
  const alignedRows = useMemo(() => (file ? file.hunks.flatMap((hunk, index) => alignHunk(hunk, index)) : []), [file]);
  const leftHighlightInput = useMemo(() => buildGitDiffHighlightInput(file?.hunks ?? [], 'left'), [file]);
  const rightHighlightInput = useMemo(() => buildGitDiffHighlightInput(file?.hunks ?? [], 'right'), [file]);
  const leftHighlights = useSyntaxHighlightedSegments(file?.oldPath ?? '', leftHighlightInput.contents);
  const rightHighlights = useSyntaxHighlightedSegments(file?.newPath ?? '', rightHighlightInput.contents);
  if (!file) return <p className="project-git-empty-copy">{props.zh ? '选择一个文件查看差异。' : 'Select a file to inspect its diff.'}</p>;
  const oldPath = file.changeType === 'added' ? (props.zh ? '变更前（空文件）' : 'Before (empty file)') : file.oldPath;
  const newPath = file.changeType === 'deleted' ? (props.zh ? '变更后（空文件）' : 'After (empty file)') : file.newPath;
  return (
    <section className={`project-git-diff-preview${props.fill ? ' is-fill' : ''}`} aria-label={props.zh ? '文件差异' : 'File diff'}>
      <header>
        <strong title={props.title ?? (file.newPath || file.oldPath)}>{props.title ?? (file.newPath || file.oldPath)}</strong>
        <span>+{file.addedLines}</span>
        <em>-{file.deletedLines}</em>
        <span className="project-git-diff-mode" aria-label={props.zh ? '差异布局' : 'Diff layout'}>
          <button type="button" className={mode === 'side-by-side' ? 'is-active' : ''} onClick={() => setMode('side-by-side')} title={props.zh ? '左右两栏' : 'Side-by-side'}>
            <Columns aria-hidden="true" />
          </button>
          <button type="button" className={mode === 'unified' ? 'is-active' : ''} onClick={() => setMode('unified')} title={props.zh ? '统一视图' : 'Unified'}>
            <Rows aria-hidden="true" />
          </button>
        </span>
      </header>
      {mode === 'side-by-side' ? (
        <div className="project-git-diff-side-by-side">
          <div className="project-git-diff-side-head">
            <span title={oldPath}>{oldPath}</span>
            <span title={newPath}>{newPath}</span>
          </div>
          <div className="project-git-diff-side-scroll">
            <div ref={leftPaneRef} className="project-git-diff-side-pane" onScroll={(event) => syncVerticalScroll(event, rightPaneRef.current, syncingVerticalScrollRef)}>
              {alignedRows.map((row) =>
                row.metadata ? (
                  <div key={row.key} className="project-git-diff-side-metadata">
                    {row.metadata}
                  </div>
                ) : (
                  <DiffSideCell key={row.key} side={row.left ?? emptySide()} highlighted={highlightedGitDiffLine(row.left, leftHighlightInput, leftHighlights)} />
                ),
              )}
            </div>
            <div ref={rightPaneRef} className="project-git-diff-side-pane" onScroll={(event) => syncVerticalScroll(event, leftPaneRef.current, syncingVerticalScrollRef)}>
              {alignedRows.map((row) =>
                row.metadata ? (
                  <div key={row.key} className="project-git-diff-side-metadata">
                    {row.metadata}
                  </div>
                ) : (
                  <DiffSideCell key={row.key} side={row.right ?? emptySide()} highlighted={highlightedGitDiffLine(row.right, rightHighlightInput, rightHighlights)} />
                ),
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="project-git-diff-unified">
          {file.hunks.flatMap((hunk, hunkIndex) => [
            <span key={`${hunk.header}:header`} className="is-metadata">
              {hunk.header}
            </span>,
            ...hunk.lines.map((line, index) => {
              const key = `${hunkIndex}:${index}`;
              const input = line.type === 'deletion' ? leftHighlightInput : rightHighlightInput;
              const highlights = line.type === 'deletion' ? leftHighlights : rightHighlights;
              return (
                <span key={`${hunk.header}:${index}`} className={`is-${line.type}`}>
                  <i>{line.oldLineNumber ?? ''}</i>
                  <i>{line.newLineNumber ?? ''}</i>
                  <code>
                    <span aria-hidden="true">{line.type === 'addition' ? '+' : line.type === 'deletion' ? '-' : ' '}</span>
                    <SyntaxHighlightedLine line={highlightedGitDiffLineByKey(key, line.content, input, highlights)} />
                  </code>
                </span>
              );
            }),
          ])}
        </div>
      )}
    </section>
  );
}

function syncVerticalScroll(event: ReactUIEvent<HTMLDivElement>, target: HTMLDivElement | null, syncingRef: { current: boolean }) {
  if (!target || syncingRef.current || target.scrollTop === event.currentTarget.scrollTop) return;
  syncingRef.current = true;
  target.scrollTop = event.currentTarget.scrollTop;
  requestAnimationFrame(() => {
    syncingRef.current = false;
  });
}

function DiffSideCell(props: { side: DiffSide; highlighted: HighlightedLine }) {
  return (
    <span className={`project-git-diff-side-cell is-${props.side.tone}`}>
      <i>{props.side.lineNumber ?? ''}</i>
      <code>
        <SyntaxHighlightedLine line={props.highlighted} empty="" />
      </code>
    </span>
  );
}

function alignHunk(hunk: GitDiffHunk, hunkIndex: number): AlignedDiffRow[] {
  const rows: AlignedDiffRow[] = [{ key: `${hunkIndex}:metadata`, metadata: hunk.header }];
  let cursor = 0;
  while (cursor < hunk.lines.length) {
    const line = hunk.lines[cursor]!;
    if (line.type === 'context') {
      const highlightKey = `${hunkIndex}:${cursor}`;
      rows.push({ key: highlightKey, left: sideFromLine(line, 'context', 'old', highlightKey), right: sideFromLine(line, 'context', 'new', highlightKey) });
      cursor += 1;
      continue;
    }
    if (line.type === 'metadata') {
      rows.push({ key: `${hunkIndex}:${cursor}`, metadata: line.content });
      cursor += 1;
      continue;
    }
    const deleted: Array<{ line: GitDiffLine; index: number }> = [];
    const added: Array<{ line: GitDiffLine; index: number }> = [];
    const blockStart = cursor;
    while (cursor < hunk.lines.length && hunk.lines[cursor]!.type !== 'context' && hunk.lines[cursor]!.type !== 'metadata') {
      const changed = hunk.lines[cursor]!;
      if (changed.type === 'deletion') deleted.push({ line: changed, index: cursor });
      if (changed.type === 'addition') added.push({ line: changed, index: cursor });
      cursor += 1;
    }
    const count = Math.max(deleted.length, added.length);
    for (let index = 0; index < count; index += 1) {
      rows.push({
        key: `${hunkIndex}:${blockStart}:${index}`,
        left: deleted[index] ? sideFromLine(deleted[index]!.line, 'deletion', 'old', `${hunkIndex}:${deleted[index]!.index}`) : emptySide(),
        right: added[index] ? sideFromLine(added[index]!.line, 'addition', 'new', `${hunkIndex}:${added[index]!.index}`) : emptySide(),
      });
    }
  }
  return rows;
}

function sideFromLine(line: GitDiffLine, tone: DiffSide['tone'], side: 'old' | 'new', highlightKey: string): DiffSide {
  return { lineNumber: side === 'old' ? line.oldLineNumber : line.newLineNumber, content: line.content, tone, highlightKey };
}

function emptySide(): DiffSide {
  return { lineNumber: null, content: '', tone: 'empty' };
}

interface GitDiffHighlightInput {
  contents: string[];
  positions: Map<string, { segment: number; line: number }>;
}

function buildGitDiffHighlightInput(hunks: GitDiffHunk[], side: 'left' | 'right'): GitDiffHighlightInput {
  const contents: string[] = [];
  const positions = new Map<string, { segment: number; line: number }>();
  hunks.forEach((hunk, hunkIndex) => {
    const segment = contents.length;
    const segmentLines: string[] = [];
    hunk.lines.forEach((line, lineIndex) => {
      const belongsToSide = line.type === 'context' || (side === 'left' ? line.type === 'deletion' : line.type === 'addition');
      if (!belongsToSide) return;
      positions.set(`${hunkIndex}:${lineIndex}`, { segment, line: segmentLines.length });
      segmentLines.push(line.content);
    });
    contents.push(segmentLines.join('\n'));
  });
  return { contents, positions };
}

function highlightedGitDiffLine(side: DiffSide | undefined, input: GitDiffHighlightInput, highlights: HighlightedLine[][]): HighlightedLine {
  return side ? highlightedGitDiffLineByKey(side.highlightKey, side.content, input, highlights) : [];
}

function highlightedGitDiffLineByKey(key: string | undefined, content: string, input: GitDiffHighlightInput, highlights: HighlightedLine[][]): HighlightedLine {
  const position = key ? input.positions.get(key) : undefined;
  return (position ? highlights[position.segment]?.[position.line] : null) ?? (content ? [{ text: content }] : []);
}

function selectFileDiff(diff: GitDiffSummary, filePath: string): GitDiffSummary {
  const selected = diff.fileDiffs.find((file) => file.newPath === filePath || file.oldPath === filePath);
  return selected ? { ...diff, files: [filePath], fileDiffs: [selected] } : { ...diff, files: [], fileDiffs: [] };
}
