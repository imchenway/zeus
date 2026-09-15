import { FilePreview, fileDiffEmptyMessage } from '../code/FilePreview.js';
import type { FilePreviewRequest } from '@zeus/shared';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/dist/csr/Columns';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { RowsIcon as Rows } from '@phosphor-icons/react/dist/csr/Rows';
import type { DashboardClient, GitDiffHunk, GitDiffSummary, GitFileDiff } from '../apiClient.js';
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
/** 与会话和交付共用按可视区域渲染的差异视图。 */
const CodeDiffView = lazy(() => import('../code/CodeDiffView.js').then((module) => ({ default: module.CodeDiffView })));

import '../styles.css';
import '../ui/primitives.css';
import '../agentdesk-theme.css';

type DiffViewMode = 'side-by-side' | 'unified';

interface SideBySideDiffProps {
  /** 准确的仓库与比较范围。 */
  previewRequest?: FilePreviewRequest;
  /** 外部快照刷新时释放旧内容。 */
  revision?: string | number;
  diff: GitDiffSummary | null;
  zh: boolean;
  title?: string;
  fill?: boolean;
  partitionHunks?: boolean;
  hunkActionsDisabled?: boolean;
  onHunkAction?: (file: GitFileDiff, hunk: GitDiffHunk, index: number) => void;
  hunkActionLabel?: string;
  onHunkDiscard?: (file: GitFileDiff, hunk: GitDiffHunk, index: number) => void;
  hunkDiscardLabel?: string;
}

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
  /** 独立窗口沿用应用外观，系统模式由主题样式实时跟随。 */
  appearance: 'light' | 'dark' | 'system';
}) {
  const zh = props.language === 'zh-CN';
  /** 初始设置用于首帧，后续变化沿用既有窗口通知机制。 */
  const [appearance, setAppearance] = useState(props.appearance);
  useEffect(() => window.zeus?.onProjectGitDiffAppearance?.(setAppearance), []);
  /** 将主题同步给正文之外的菜单和错误弹层。 */
  useEffect(() => {
    /** 文档主题使门户内容与独立窗口保持一致。 */
    const root = document.documentElement;
    root.dataset.zeusTheme = appearance;
    return () => {
      if (root.dataset.zeusTheme === appearance) delete root.dataset.zeusTheme;
    };
  }, [appearance]);
  const [diff, setDiff] = useState<GitDiffSummary | null>(null);
  const [title, setTitle] = useState(props.filePath || (zh ? 'Git 差异' : 'Git diff'));
  const [selectedPath, setSelectedPath] = useState(props.filePath);
  const [error, setError] = useState<unknown>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
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
        // 明确选择的非文本或未跟踪文件即使没有补丁，也必须保留其身份。
        setSelectedPath(props.filePath || next.fileDiffs[0]?.newPath || next.fileDiffs[0]?.oldPath || '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.repositoryId, props.filePath, props.stage, props.commitHash, props.comparisonRef, props.comparisonMode]);

  useEffect(() => {
    document.title = selectedPath ? `${title} · ${selectedPath}` : title;
  }, [selectedPath, title]);

  const selectedDiff = useMemo(() => (diff && selectedPath ? selectFileDiff(diff, selectedPath) : diff), [diff, selectedPath]);
  const viewer = selectedDiff ? (
    <SideBySideDiff
      previewRequest={{
        kind: 'project-git',
        projectId: props.projectId,
        repositoryId: props.repositoryId,
        path: selectedPath,
        stage: props.stage,
        commitHash: props.commitHash,
        comparisonRef: props.comparisonRef,
        comparisonMode: props.comparisonMode,
      }}
      diff={selectedDiff}
      zh={zh}
      title={selectedPath || title}
      fill
    />
  ) : null;

  return (
    <main className={`macos-ai-app zeus-shell theme-${appearance} project-git-diff-window`} aria-label={zh ? 'Git 差异窗口' : 'Git diff window'}>
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
                {props.filePath && !diff.fileDiffs.some((file) => file.newPath === props.filePath || file.oldPath === props.filePath) ? (
                  <button type="button" className={props.filePath === selectedPath ? 'is-current' : ''} onClick={() => setSelectedPath(props.filePath)}>
                    <File aria-hidden="true" />
                    <span>{props.filePath}</span>
                  </button>
                ) : null}
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
        <p className="project-git-diff-loading">{error ? <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} /> : zh ? '正在读取差异…' : 'Loading diff…'}</p>
      )}
    </main>
  );
}

function TextSideBySideDiff(props: SideBySideDiffProps) {
  const [mode, setMode] = useState<DiffViewMode>('side-by-side');
  const file = props.diff?.fileDiffs[0] ?? null;
  if (!file) return <p className="project-git-empty-copy">{props.zh ? '选择一个文件查看差异。' : 'Select a file to inspect its diff.'}</p>;
  if (file.hunks.length === 0) {
    return <p className="project-git-empty-copy">{fileDiffEmptyMessage(file, props.zh)}</p>;
  }
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
      <div className="project-git-diff-side-by-side">
        {mode === 'side-by-side' ? (
          <div className="project-git-diff-side-head">
            <span title={oldPath}>{oldPath}</span>
            <span title={newPath}>{newPath}</span>
          </div>
        ) : null}
        <Suspense fallback={<p role="status">{props.zh ? '正在打开差异…' : 'Opening diff…'}</p>}>
          {props.partitionHunks ? (
            <div className="project-git-diff-hunks" aria-label={props.zh ? '差异区块' : 'Diff hunks'}>
              {file.hunks.map((hunk, index) => (
                <DiffHunkSection
                  key={`${hunk.header}:${index}`}
                  file={file}
                  hunk={hunk}
                  index={index}
                  unified={mode === 'unified'}
                  zh={props.zh}
                  disabled={props.hunkActionsDisabled}
                  actionLabel={props.hunkActionLabel}
                  discardLabel={props.hunkDiscardLabel}
                  onAction={props.onHunkAction}
                  onDiscard={props.onHunkDiscard}
                />
              ))}
            </div>
          ) : (
            <CodeDiffView file={file} unified={mode === 'unified'} alignReplacements resizable label={props.zh ? '文件差异' : 'File diff'} />
          )}
        </Suspense>
      </div>
    </section>
  );
}

/** 工作区差异按 hunk 分段呈现，操作始终贴近将被影响的代码。 */
function DiffHunkSection(props: {
  file: GitFileDiff;
  hunk: GitDiffHunk;
  index: number;
  unified: boolean;
  zh: boolean;
  disabled?: boolean;
  actionLabel?: string;
  discardLabel?: string;
  onAction?: SideBySideDiffProps['onHunkAction'];
  onDiscard?: SideBySideDiffProps['onHunkDiscard'];
}) {
  const file = useMemo(() => ({ ...props.file, hunks: [props.hunk] }), [props.file, props.hunk]);
  const label = props.zh ? `区块 ${props.index + 1}` : `Hunk ${props.index + 1}`;
  const range = props.zh
    ? `原始行 ${formatHunkRange(props.hunk.oldStart, props.hunk.oldLines, true)} → 新行 ${formatHunkRange(props.hunk.newStart, props.hunk.newLines, true)}`
    : `Old ${formatHunkRange(props.hunk.oldStart, props.hunk.oldLines, false)} → new ${formatHunkRange(props.hunk.newStart, props.hunk.newLines, false)}`;
  const height = Math.min(560, Math.max(72, props.hunk.lines.length * 20 + 32));
  return (
    <section className="project-git-diff-hunk" aria-label={`${label} · ${range}`}>
      <header className="project-git-diff-hunk-header">
        <span>
          <strong>{label}</strong>
          <small title={props.hunk.header}>{range}</small>
        </span>
        {props.onAction || props.onDiscard ? (
          <span className="project-git-diff-hunk-commands">
            {props.onAction ? (
              <button type="button" disabled={props.disabled} onClick={() => props.onAction?.(props.file, props.hunk, props.index)}>
                {props.actionLabel ?? (props.zh ? '应用区块' : 'Apply hunk')}
              </button>
            ) : null}
            {props.onDiscard ? (
              <button className="is-danger" type="button" disabled={props.disabled} onClick={() => props.onDiscard?.(props.file, props.hunk, props.index)}>
                {props.discardLabel ?? (props.zh ? '放弃区块' : 'Discard hunk')}
              </button>
            ) : null}
          </span>
        ) : null}
      </header>
      <div className="project-git-diff-hunk-body" style={{ height }}>
        <CodeDiffView file={file} unified={props.unified} alignReplacements resizable omitHunkHeaders label={`${props.zh ? '文件差异' : 'File diff'} · ${label}`} />
      </div>
    </section>
  );
}

function formatHunkRange(start: number, lines: number, zh: boolean): string {
  if (lines === 0) return zh ? '空' : 'empty';
  const end = start + lines - 1;
  return start === end ? String(start) : `${start}–${end}`;
}

/** 独立差异窗口只把选中文件交给代码视图。 */
function selectFileDiff(diff: GitDiffSummary, path: string): GitDiffSummary {
  return { ...diff, fileDiffs: diff.fileDiffs.filter((file) => file.newPath === path || file.oldPath === path) };
}

/** 仓库各入口共用媒体预览，文本保留原来的区块操作。 */
export function SideBySideDiff(props: SideBySideDiffProps) {
  return props.previewRequest ? (
    <FilePreview request={props.previewRequest} revision={props.revision} zh={props.zh}>
      {props.diff?.fileDiffs.length ? <TextSideBySideDiff {...props} /> : null}
    </FilePreview>
  ) : (
    <TextSideBySideDiff {...props} />
  );
}
