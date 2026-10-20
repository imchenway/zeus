import { ZeusSelect } from '../ZeusSelect.js';
import { FilePreview, PreviewIconButton, fileDiffEmptyMessage } from '../code/FilePreview.js';
import type { FilePreviewRequest, FilePreviewItem } from '@zeus/shared';
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ColumnsIcon as Columns } from '@phosphor-icons/react/dist/csr/Columns';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
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
  client: Pick<DashboardClient, 'loadProjectGitWorkbench' | 'loadProjectGitCommit' | 'loadProjectGitComparisonDiff' | 'loadTaskWorkspaceFileDiff'>;
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
  const [title, setTitle] = useState(props.source.path || (zh ? 'Git 差异' : 'Git diff'));
  const [selectedPath, setSelectedPath] = useState(props.source.path);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDiff(null);
    /** 捕获本轮来源；窗口永远按打开时的任务、文件及比较范围读取。 */
    const source = props.source;
    const request =
      source.kind === 'snapshot'
        ? Promise.resolve(source.diff)
        : source.kind === 'task-git'
          ? props.client.loadTaskWorkspaceFileDiff(source.taskId, source.workspaceId, source.path, source.scope).then((result) => {
              if (!cancelled) setTitle(source.scope === 'working' ? (zh ? '本机未提交' : 'Local uncommitted') : zh ? '已提交成果' : 'Committed result');
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
                  if (!cancelled) setTitle(repository.name);
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
  const viewer = selectedDiff ? <SideBySideDiff previewRequest={props.source.kind === 'snapshot' ? undefined : { ...props.source, path: selectedPath }} diff={selectedDiff} zh={zh} title={selectedPath || title} fill /> : null;

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
                    <span>{props.source.path}</span>
                  </button>
                ) : null}
                {diff.fileDiffs.map((file) => {
                  const path = file.newPath || file.oldPath;
                  return (
                    <button key={`${file.oldPath}:${file.newPath}`} type="button" className={path === selectedPath ? 'is-current' : ''} onClick={() => setSelectedPath(path)}>
                      <FileTypeIcon name={path} />
                      <span data-icon-tooltip={path} data-file-status={file.changeType}>
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
        <strong data-icon-tooltip={props.title ?? (file.newPath || file.oldPath)} data-file-status={file.changeType}>
          {props.title ?? (file.newPath || file.oldPath)}
        </strong>
        {props.toolbar ? (
          <nav className="file-preview-toolbar" aria-label={props.zh ? '文件操作' : 'File actions'}>
            {props.toolbar}
          </nav>
        ) : null}
        <span>+{file.addedLines}</span>
        <em>-{file.deletedLines}</em>
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
      </header>
      <div className="project-git-diff-side-by-side">
        {mode === 'side-by-side' ? (
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
                  file={visibleFile}
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
  /** Git 不把末尾换行后的空字符串当成额外代码行。 */
  const readLines = (item: FilePreviewItem | undefined, absent: boolean): string[] => {
    if (absent) return [];
    if (!item || item.content === undefined || item.truncated) throw new Error(item?.reason || '完整文件暂不可用，请刷新或在外部编辑器中查看。');
    if (!item.content) return [];
    const lines = item.content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    if (lines.at(-1) === '') lines.pop();
    return lines;
  };
  /** 前后版本独立读取，新增或删除的缺失侧明确为空。 */
  const before = readLines(items[0], file.changeType === 'added');
  const after = readLines(items[1], file.changeType === 'deleted');
  /** 只给展示层补齐上下文，原始补丁继续用于写操作。 */
  const lines: GitDiffHunk['lines'] = [];
  /** 游标对应已消费的前后版本行数。 */
  let left = 0;
  let right = 0;
  /** 任何版本错位都要求重新读取，不静默隐藏中间正文。 */
  const stale = () => new Error('文件内容已经变化，请刷新 Git 差异。');
  /** 未修改段必须在两端完全一致。 */
  const appendContext = (leftEnd: number, rightEnd: number) => {
    if (leftEnd < left || rightEnd < right || leftEnd > before.length || rightEnd > after.length) throw stale();
    while (left < leftEnd && right < rightEnd) {
      if (before[left] !== after[right]) throw stale();
      lines.push({ type: 'context', content: before[left]!, oldLineNumber: ++left, newLineNumber: ++right });
    }
    if (left !== leftEnd || right !== rightEnd) throw stale();
  };
  for (const hunk of file.hunks) {
    appendContext(hunk.oldLines ? hunk.oldStart - 1 : hunk.oldStart, hunk.newLines ? hunk.newStart - 1 : hunk.newStart);
    for (const line of hunk.lines) {
      if (line.type === 'metadata') continue;
      let content = line.content.endsWith('\r') ? line.content.slice(0, -1) : line.content;
      // 预览解码会去除文件头 BOM，比较同一可见正文时采用一致规则。
      if ((line.oldLineNumber === 1 || line.newLineNumber === 1) && content.startsWith('\uFEFF')) content = content.slice(1);
      if (line.type !== 'addition' && (line.oldLineNumber !== left + 1 || before[left++] !== content)) throw stale();
      if (line.type !== 'deletion' && (line.newLineNumber !== right + 1 || after[right++] !== content)) throw stale();
      lines.push({ ...line, content });
    }
  }
  appendContext(before.length, after.length);
  return { ...file, hunks: lines.length ? [{ header: '', oldStart: before.length ? 1 : 0, newStart: after.length ? 1 : 0, oldLines: before.length, newLines: after.length, lines }] : [] };
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
      fileStatus={props.diff?.fileDiffs[0]?.changeType}
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
