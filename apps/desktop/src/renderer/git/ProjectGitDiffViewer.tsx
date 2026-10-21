import { ZeusSelect } from '../ZeusSelect.js';
import { FilePreview, FilePreviewDataContext, PreviewIconButton, fileDiffEmptyMessage } from '../code/FilePreview.js';
import type { FilePreviewRequest, FilePreviewItem } from '@zeus/shared';
import { lazy, Suspense, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fullFileDiff } from '../code/fullFileDiff.js';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/dist/csr/Columns';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import type { FileStatus } from '../code/fileStatus.js';
import { RowsIcon as Rows } from '@phosphor-icons/react/dist/csr/Rows';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { DashboardClient, GitDiffHunk, GitDiffSummary, GitFileDiff } from '../apiClient.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
/** 与会话和交付共用按可视区域渲染的差异视图。 */
const CodeDiffView = lazy(() => import('../code/CodeDiffView.js').then((module) => ({ default: module.CodeDiffView })));

import '../styles.css';
import '../ui/primitives.css';
import '../agentdesk-theme.css';

type DiffViewMode = 'side-by-side' | 'unified';

interface SideBySideDiffProps {
  /** 已知工作区状态优先于补丁类型，避免未跟踪文件被显示为已暂存新增。 */
  fileStatus?: FileStatus;
  /** 准确的仓库与比较范围。 */
  previewRequest?: FilePreviewRequest;
  /** 外部快照刷新时释放旧内容。 */
  revision?: string | number;
  diff: GitDiffSummary | null;
  zh: boolean;
  title?: string;
  fill?: boolean;
  hunkActionsDisabled?: boolean;
  onHunkAction?: (file: GitFileDiff, hunk: GitDiffHunk, index: number) => void;
  hunkActionLabel?: string;
  onHunkDiscard?: (file: GitFileDiff, hunk: GitDiffHunk, index: number) => void;
  hunkDiscardLabel?: string;
  /** 源码临时对比的关闭操作与文件操作保持在同一行。 */
  onClose?: () => void;
}

/** 项目、任务和推送快照共用系统差异窗口，只展示明确来源的内容。 */
export function ProjectGitDiffWindow(props: {
  /** 已有只读接口负责解析仓库和任务工作区。 */
  client: Pick<DashboardClient, 'loadProjectGitWorkbench' | 'loadProjectGitCommit' | 'loadProjectGitComparisonDiff' | 'loadTaskWorkspaceFileDiff' | 'loadTaskGitWorkspaceSnapshot'>;
  /** 快照只展示已选范围；任务与项目来源继续按业务身份读取。 */
  source: Extract<FilePreviewRequest, { kind: 'project-git' | 'task-git' }> | { kind: 'snapshot'; path: string; diff: GitDiffSummary };
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
  /** 独立窗口按自己的读取结果识别未跟踪文件，不沿用打开前的旧状态。 */
  const [fileStatuses, setFileStatuses] = useState<Record<string, FileStatus>>({});
  const [title, setTitle] = useState(props.source.path || (zh ? 'Git 差异' : 'Git diff'));
  const [selectedPath, setSelectedPath] = useState(props.source.path);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDiff(null);
    setFileStatuses({});
    /** 捕获本轮来源；窗口永远按打开时的任务、文件及比较范围读取。 */
    const source = props.source;
    const request =
      source.kind === 'snapshot'
        ? Promise.resolve(source.diff)
        : source.kind === 'task-git'
          ? Promise.all([
              props.client.loadTaskWorkspaceFileDiff(source.taskId, source.workspaceId, source.path, source.scope),
              source.scope === 'working' ? props.client.loadTaskGitWorkspaceSnapshot(source.taskId, source.workspaceId) : Promise.resolve(null),
            ]).then(([result, snapshot]) => {
              if (!cancelled) {
                setTitle(source.scope === 'working' ? (zh ? '本机未提交' : 'Local uncommitted') : zh ? '已提交成果' : 'Committed result');
                if (snapshot?.workspace.review) {
                  /** 与任务交付使用同一工作区快照状态，补丁仍只负责正文差异。 */
                  const review = snapshot.workspace.review;
                  setFileStatuses(Object.fromEntries([...review.stagedFiles, ...review.unstagedFiles, ...review.untrackedFiles].map((file) => [file.path, file.category])));
                }
              }
              return result.diff;
            })
          : source.commitHash
            ? props.client.loadProjectGitCommit(source.projectId, source.repositoryId, source.commitHash).then((detail) => {
                if (!cancelled) setTitle(detail.commit.subject);
                return detail.diff;
              })
            : source.comparisonRef
              ? props.client.loadProjectGitComparisonDiff(source.projectId, source.repositoryId, source.comparisonRef, source.comparisonMode ?? 'current').then((summary) => {
                  if (!cancelled) setTitle(`${source.comparisonRef} · ${zh ? '分支差异' : 'Branch diff'}`);
                  return summary;
                })
              : props.client.loadProjectGitWorkbench(source.projectId).then((workbench) => {
                  /** 项目工作台只在项目来源下解析仓库。 */
                  const repository = workbench.repositories.find((candidate) => candidate.id === source.repositoryId);
                  if (!repository) throw new Error(zh ? '仓库已不在当前项目中。' : 'The repository is no longer part of this project.');
                  if (!cancelled) {
                    setTitle(repository.name);
                    // 暂存范围由补丁决定；未跟踪与冲突不能从新增补丁推断。
                    setFileStatuses(Object.fromEntries(repository.snapshot.fileStatuses.filter((file) => file.category === 'untracked' || file.category === 'conflict').map((file) => [file.path, file.category])));
                  }
                  return source.stage === 'staged' ? repository.snapshot.stagedDiff : source.stage === 'unstaged' ? repository.snapshot.unstagedDiff : repository.snapshot.diff;
                });
    void request
      .then((next) => {
        if (cancelled) return;
        setDiff(next);
        // 明确选择的非文本或未跟踪文件即使没有补丁，也必须保留其身份。
        setSelectedPath(props.source.path || next.fileDiffs[0]?.newPath || next.fileDiffs[0]?.oldPath || '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason);
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, props.source, zh]);

  useEffect(() => {
    document.title = selectedPath ? `${title} · ${selectedPath}` : title;
  }, [selectedPath, title]);

  const selectedDiff = useMemo(() => (diff && selectedPath ? selectFileDiff(diff, selectedPath) : diff), [diff, selectedPath]);
  const viewer = selectedDiff ? (
    <SideBySideDiff fileStatus={fileStatuses[selectedPath]} previewRequest={props.source.kind === 'snapshot' ? undefined : { ...props.source, path: selectedPath }} diff={selectedDiff} zh={zh} title={selectedPath || title} fill />
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
                {props.source.path && !diff.fileDiffs.some((file) => file.newPath === props.source.path || file.oldPath === props.source.path) ? (
                  <button type="button" className={props.source.path === selectedPath ? 'is-current' : ''} onClick={() => setSelectedPath(props.source.path)}>
                    <FileTypeIcon name={props.source.path} />
                    <span data-file-status={fileStatuses[props.source.path]}>{props.source.path}</span>
                  </button>
                ) : null}
                {diff.fileDiffs.map((file) => {
                  const path = file.newPath || file.oldPath;
                  return (
                    <button key={`${file.oldPath}:${file.newPath}`} type="button" className={path === selectedPath ? 'is-current' : ''} onClick={() => setSelectedPath(path)}>
                      <FileTypeIcon name={path} />
                      <span data-icon-tooltip={path} data-file-status={fileStatuses[path] ?? file.changeType}>
                        {path}
                      </span>
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

/** 标题、模式切换与布局操作共用一行，空文本差异仍能切换到内容预览。 */
function TextSideBySideDiff(props: SideBySideDiffProps & { /** 共享文件操作由预览容器提供。 */ toolbar?: ReactNode; /** 已授权的前后两版完整正文。 */ items?: FilePreviewItem[] | null }) {
  const [mode, setMode] = useState<DiffViewMode>('side-by-side');
  /** 全文模式固定左右展示，片段操作仍使用原始补丁。 */
  const full = useContext(FilePreviewDataContext)?.full;
  const file = props.diff?.fileDiffs[0] ?? null;
  /** 片段操作仍使用原始补丁，连续正文不改变暂存范围。 */
  const [hunkIndex, setHunkIndex] = useState(0);
  /** 选择片段时只滚动到原始行，不创建第二个差异编辑器。 */
  const [revealLine, setRevealLine] = useState<{ line: number; side: 'left' | 'right' }>();
  /** 内容与补丁不一致时拒绝拼接，提示刷新而不是展示错位行。 */
  const continuous = useMemo(() => {
    if (!file || !props.items) return null;
    try {
      return { file: continuousDiffFile(file, props.items), error: '' };
    } catch (error) {
      return { file: null, error: error instanceof Error ? error.message : '文件读取失败。' };
    }
  }, [file, props.items]);
  /** 只有取得完整文本时，归属才绑定到同一对前后版本。 */
  const blame = useMemo(() => (props.items ? { left: props.items[0]?.blame ?? [], right: props.items[1]?.blame ?? [] } : undefined), [props.items]);
  if (!file) return <p className="project-git-empty-copy">{props.zh ? '选择一个文件查看差异。' : 'Select a file to inspect its diff.'}</p>;
  const oldPath = file.changeType === 'added' ? (props.zh ? '变更前（空文件）' : 'Before (empty file)') : file.oldPath;
  const newPath = file.changeType === 'deleted' ? (props.zh ? '变更后（空文件）' : 'After (empty file)') : file.newPath;
  /** 刷新后片段数减少时仍保持有效索引。 */
  const selectedIndex = Math.min(hunkIndex, Math.max(0, file.hunks.length - 1));
  /** 操作目标始终来自原始片段，不能使用补齐后的全文补丁。 */
  const selectedHunk = file.hunks[selectedIndex];
  /** 没有完整预览来源的快照只展示已有片段，并明确说明范围。 */
  const visibleFile = continuous?.file ?? file;
  /** 正文读取失败或发生变化时禁止对旧片段执行操作。 */
  const actionsDisabled = props.hunkActionsDisabled || Boolean(props.previewRequest && !continuous?.file);
  return (
    <section className={`project-git-diff-preview${props.fill ? ' is-fill' : ''}`} aria-label={props.zh ? '文件差异' : 'File diff'}>
      <header>
        <FileTypeIcon name={file.newPath || file.oldPath} />
        <strong data-icon-tooltip={props.title ?? (file.newPath || file.oldPath)} data-file-status={props.fileStatus ?? file.changeType}>
          {props.title ?? (file.newPath || file.oldPath)}
        </strong>
        {props.toolbar ? (
          <nav className="file-preview-toolbar" aria-label={props.zh ? '文件操作' : 'File actions'}>
            {props.toolbar}
          </nav>
        ) : null}
        <span>+{file.addedLines}</span>
        <em>-{file.deletedLines}</em>
        {!full ? (
          <span className="project-git-diff-mode" aria-label={props.zh ? '差异布局' : 'Diff layout'}>
            <button
              type="button"
              className={mode === 'side-by-side' ? 'is-active' : ''}
              aria-pressed={mode === 'side-by-side'}
              aria-label={props.zh ? '左右两栏' : 'Side-by-side'}
              onClick={() => setMode('side-by-side')}
              data-icon-tooltip={props.zh ? '左右两栏' : 'Side-by-side'}
            >
              <Columns aria-hidden="true" />
            </button>
            <button
              type="button"
              className={mode === 'unified' ? 'is-active' : ''}
              aria-pressed={mode === 'unified'}
              aria-label={props.zh ? '统一视图' : 'Unified'}
              onClick={() => setMode('unified')}
              data-icon-tooltip={props.zh ? '统一视图' : 'Unified'}
            >
              <Rows aria-hidden="true" />
            </button>
          </span>
        ) : null}
      </header>
      <div className="project-git-diff-side-by-side">
        {full || mode === 'side-by-side' ? (
          <div className="project-git-diff-side-head">
            <span data-icon-tooltip={oldPath}>{oldPath}</span>
            <span data-icon-tooltip={newPath}>{newPath}</span>
          </div>
        ) : null}
        {props.items?.some((item) => item.blameError) ? (
          <p role="status">
            {props.zh ? '提交归属读取失败：' : 'Could not read line history: '}
            {props.items.find((item) => item.blameError)?.blameError}
          </p>
        ) : null}
        {continuous?.error ? (
          <p role="alert">{props.zh ? continuous.error : 'The complete file could not be matched to this diff. Refresh the file and try again.'}</p>
        ) : props.previewRequest && !props.items ? (
          <p role="status">{props.zh ? '正在读取完整文件…' : 'Loading complete file…'}</p>
        ) : (
          <>
            {!props.previewRequest ? <p role="status">{props.zh ? '此快照仅包含差异片段。' : 'This snapshot contains changed sections only.'}</p> : null}
            {selectedHunk && (props.onHunkAction || props.onHunkDiscard) ? (
              <div className="project-git-diff-hunk-commands">
                <ZeusSelect
                  ariaLabel={props.zh ? '选择改动片段' : 'Select changed section'}
                  value={String(selectedIndex)}
                  size="compact"
                  className="project-git-diff-hunk-select"
                  options={file.hunks.map((hunk, index) => ({ value: String(index), label: props.zh ? `改动 ${index + 1} · 行 ${hunk.newStart || hunk.oldStart}` : `Change ${index + 1} · line ${hunk.newStart || hunk.oldStart}` }))}
                  onChange={(value) => {
                    /** 只接受当前展示的原始片段索引，定位第一条实际改动。 */
                    const index = Number(value);
                    if (!Number.isInteger(index) || !file.hunks[index]) return;
                    setHunkIndex(index);
                    /** 删除片段使用旧文件行号，其余片段使用新文件行号。 */
                    const changed = file.hunks[index]?.lines.find((line) => line.type === 'addition' || line.type === 'deletion');
                    if (changed) setRevealLine(changed.newLineNumber !== null ? { line: changed.newLineNumber, side: 'right' } : { line: changed.oldLineNumber!, side: 'left' });
                  }}
                />
                {props.onHunkAction ? (
                  <button type="button" disabled={actionsDisabled} onClick={() => props.onHunkAction?.(file, selectedHunk, selectedIndex)}>
                    {props.hunkActionLabel}
                  </button>
                ) : null}
                {props.onHunkDiscard ? (
                  <button type="button" className="is-danger" disabled={actionsDisabled} onClick={() => props.onHunkDiscard?.(file, selectedHunk, selectedIndex)}>
                    {props.hunkDiscardLabel}
                  </button>
                ) : null}
              </div>
            ) : null}
            {visibleFile.hunks.length === 0 ? (
              <p className="project-git-empty-copy">{fileDiffEmptyMessage(file, props.zh)}</p>
            ) : (
              <Suspense fallback={null}>
                <CodeDiffView
                  file={full ? file : visibleFile}
                  unified={mode === 'unified'}
                  alignReplacements
                  resizable
                  omitHunkHeaders={Boolean(continuous?.file)}
                  blame={blame}
                  blameLocale={props.zh ? 'zh-CN' : 'en-US'}
                  revealLine={revealLine}
                  label={props.zh ? '文件差异' : 'File diff'}
                />
              </Suspense>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/** 用授权全文补齐未修改行；逐行校验旧补丁，拒绝把不同版本拼在一起。 */
function continuousDiffFile(file: GitFileDiff, items: FilePreviewItem[]): GitFileDiff {
  /** 与会话和交付共用全文核对，保留原始文件统计及操作片段。 */
  const complete = fullFileDiff(file, items);
  if (!complete) throw new Error('完整文件暂不可用或内容已经变化，请刷新 Git 差异。');
  return { ...file, hunks: complete.hunks };
}

/** 独立差异窗口只把选中文件交给代码视图。 */
function selectFileDiff(diff: GitDiffSummary, path: string): GitDiffSummary {
  return { ...diff, fileDiffs: diff.fileDiffs.filter((file) => file.newPath === path || file.oldPath === path) };
}

/** 仓库各入口共用媒体预览，文本保留原来的区块操作。 */
export function SideBySideDiff(props: SideBySideDiffProps) {
  return props.previewRequest ? (
    <FilePreview
      request={props.previewRequest}
      revision={props.revision}
      zh={props.zh}
      fileStatus={props.fileStatus ?? props.diff?.fileDiffs[0]?.changeType}
      actions={
        props.onClose ? (
          <PreviewIconButton tooltip={false} label={props.zh ? '关闭对比' : 'Close diff'} onClick={props.onClose}>
            <X size={16} aria-hidden="true" />
          </PreviewIconButton>
        ) : null
      }
    >
      {props.diff?.fileDiffs.length ? (toolbar, items) => <TextSideBySideDiff {...props} toolbar={toolbar} items={items} /> : null}
    </FilePreview>
  ) : (
    <TextSideBySideDiff {...props} />
  );
}
