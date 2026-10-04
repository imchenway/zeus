import { useId, useMemo, useRef, type ReactNode, type ComponentProps } from 'react';
import type { TaskGitFileStatus, TaskWorkspaceIndexSnapshot, TaskWorkspaceSnapshot, TaskGitDiffSummary } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { SideBySideDiff } from './ProjectGitDiffViewer.js';
import { GitPaneSeparator } from './GitPaneSeparator.js';
import { CopySimpleIcon } from '@phosphor-icons/react/dist/csr/CopySimple';
import { CaretDownIcon } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { FileTypeIcon } from '../code/FileTypeIcon.js';

/** 两种交付入口共用文件范围。 */
export type DiffScope = 'committed' | 'working';
/** 操作期间锁定交付范围。 */
export type BusyAction = 'loading' | 'commit' | 'commit-message' | 'push' | 'merge' | 'conflict' | 'ai' | null;

/** 文件树保留真实仓库相对路径。 */
export interface DeliveryFile {
  path: string;
  label: string;
  additions: number;
  deletions: number;
  workingFile?: TaskGitFileStatus;
}
/** 操作反馈保留逐仓结果。 */
export interface DeliveryFeedback {
  /** 操作结果跟随对应按钮；没有操作归属时作为页面级提示。 */
  action?: 'commit' | 'merge' | 'push';
  /** 汇总与逐仓结果一同更新，避免旧结果混入下一条提示。 */
  results?: BatchDeliveryResult[];
  /** 非批量合入也保留短摘要，完整目标和待同步原因放入详情。 */
  summary?: string;
  tone: 'success' | 'warning' | 'info';
  text: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** 独立仓库可以分别成功、跳过或失败。 */
export type BatchDeliveryStatus = 'succeeded' | 'skipped' | 'attention' | 'failed';

/** 单仓结果不覆盖其他仓库。 */
export interface BatchDeliveryResult {
  workspaceId: string;
  repositoryName: string;
  status: BatchDeliveryStatus;
  message: string;
}

/** 交付视图只消费显示事实，不要求普通目录伪造任务工作区。 */
export interface DeliveryRepositoryGroup {
  workspace: Pick<TaskWorkspaceIndexSnapshot, 'id' | 'branchName' | 'state' | 'repositoryName' | 'repositoryRelativePath'>;
  detail: Pick<TaskWorkspaceSnapshot, 'review'> | undefined;
  files: DeliveryFile[];
  statusLabel: string;
}

/** 本机读取失败保留重试，不能把未加载误报为没有变化。 */
export function InitialLoadState(props: { zh: boolean; error?: string | null; onRetry?: () => void }) {
  return (
    <section className="task-git-delivery-load-state" role={props.error ? 'alert' : 'status'}>
      {props.error ? <VisibleApplicationError error={props.error} language={props.zh ? 'zh-CN' : 'en'} /> : <strong>{props.zh ? '正在读取本机 Git 信息…' : 'Loading local Git information…'}</strong>}
      {!props.error ? <small>{props.zh ? '这里只读取本机分支、提交和工作区，不会连接远端仓库。' : 'This reads local branches, commits, and worktrees without contacting a remote repository.'}</small> : null}
      {props.onRetry ? (
        <Button variant="secondary" size="compact" onClick={props.onRetry}>
          {props.zh ? '重新读取' : 'Retry'}
        </Button>
      ) : null}
    </section>
  );
}

/** 仓库与文件采用同一选择口径。 */
export function DeliveryScopeBar(props: { selectedRepositories: number; totalRepositories: number; selectedFiles: number; zh: boolean }) {
  return (
    <section className="task-git-delivery-scopebar" aria-label={props.zh ? '当前交付选择' : 'Current delivery selection'}>
      <strong>{props.zh ? '按文件审查，按仓库交付' : 'Review by file, deliver by repository'}</strong>
      <span>
        {props.zh
          ? `已选 ${props.selectedRepositories}/${props.totalRepositories} 个仓库 · ${props.selectedFiles} 个待提交文件`
          : `${props.selectedRepositories}/${props.totalRepositories} repositories · ${props.selectedFiles} uncommitted files selected`}
      </span>
    </section>
  );
}

/** 按任务分支、仓库与目录组织交付范围，审阅操作不改变勾选。 */
export function DeliveryRepositoryFileTree(props: {
  groups: DeliveryRepositoryGroup[];
  detailStates: Record<string, 'loading' | 'error'>;
  diffScope: DiffScope;
  totalWorkingFiles: number;
  totalCommittedFiles: number;
  focusedWorkspaceId: string;
  selectedFile: string;
  selectedWorkspaceIds: Set<string>;
  selectedPathsByWorkspace: Record<string, string[]>;
  currentConversationWorkspaceId?: string | null;
  zh: boolean;
  disabled: boolean;
  onScopeChange: (scope: DiffScope) => void;
  onSelectFile: (workspaceId: string, path: string) => void;
  onToggleWorkspace: (workspaceId: string, selected: boolean) => void;
  onToggleBranch: (workspaceIds: string[], selected: boolean) => void;
  /** 目录批量选择与单文件选择共用状态入口。 */
  onToggleFiles: (workspaceId: string, paths: string[], selected: boolean) => void;
  /** 双击仅打开差异，不改变勾选范围。 */
  onOpenFile: (workspaceId: string, path: string) => void;
  onCopyBranch: (branchName: string) => void | Promise<void>;
}) {
  /** 同一任务分支下的仓库保持现有排序与交付范围。 */
  const branchGroups = groupDeliveryRepositoriesByBranch(props.groups);
  return (
    <aside className="task-git-delivery-file-browser" aria-label={props.zh ? '按仓库分组的交付文件' : 'Delivery files grouped by repository'}>
      <header className="task-git-review-pane-title task-git-delivery-diff-tabs">
        <span role="group" aria-label={props.zh ? '文件范围' : 'File scope'}>
          <button
            type="button"
            className={props.diffScope === 'working' ? 'is-active' : ''}
            aria-pressed={props.diffScope === 'working'}
            title={props.zh ? '本机未提交' : 'Local uncommitted'}
            onClick={() => props.onScopeChange('working')}
            disabled={props.disabled}
          >
            <span>{props.zh ? '本机未提交' : 'Local uncommitted'}</span> <small>{props.totalWorkingFiles}</small>
          </button>
          <button
            type="button"
            className={props.diffScope === 'committed' ? 'is-active' : ''}
            aria-pressed={props.diffScope === 'committed'}
            title={props.zh ? '已提交成果' : 'Committed result'}
            onClick={() => props.onScopeChange('committed')}
            disabled={props.disabled}
          >
            <span>{props.zh ? '已提交成果' : 'Committed result'}</span> <small>{props.totalCommittedFiles}</small>
          </button>
        </span>
      </header>
      <div className="task-git-delivery-file-tree">
        {props.groups.length === 0 ? <p className="task-git-delivery-repository-state">{props.zh ? '当前范围没有可交付的 Git 仓库。' : 'No Git repositories are available in this scope.'}</p> : null}
        {branchGroups.map((branchGroup) => {
          /** 分支勾选只覆盖当前分组中的仓库。 */
          const workspaceIds = branchGroup.repositories.map((group) => group.workspace.id);
          /** 部分勾选通过复选框的中间状态呈现。 */
          const selectedCount = workspaceIds.filter((workspaceId) => props.selectedWorkspaceIds.has(workspaceId)).length;
          /** 空分组不展示全选状态。 */
          const allSelected = workspaceIds.length > 0 && selectedCount === workspaceIds.length;
          /** 任务当前会话标记仅使用真实工作区绑定。 */
          const currentConversation = workspaceIds.includes(props.currentConversationWorkspaceId ?? '');
          return (
            <section key={branchGroup.branchName} className={`task-git-delivery-branch${currentConversation ? ' is-current-conversation' : ''}`}>
              <header>
                <label>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(element) => {
                      if (element) element.indeterminate = selectedCount > 0 && !allSelected;
                    }}
                    aria-checked={selectedCount > 0 && !allSelected ? 'mixed' : allSelected}
                    onChange={(event) => props.onToggleBranch(workspaceIds, event.target.checked)}
                    disabled={props.disabled}
                  />
                  <strong>{branchGroup.branchName}</strong>
                </label>
                <span>
                  {currentConversation ? <small className="task-git-current-conversation-badge">{props.zh ? '当前会话' : 'Current session'}</small> : null}
                  <button
                    type="button"
                    aria-label={props.zh ? '复制分支名' : 'Copy branch name'}
                    title={props.zh ? '复制分支名' : 'Copy branch name'}
                    onClick={() => void props.onCopyBranch(branchGroup.branchName)}
                    disabled={props.disabled}
                  >
                    <CopySimpleIcon size={14} aria-hidden="true" />
                  </button>
                </span>
              </header>
              {branchGroup.repositories.map((group) => {
                /** 文件身份始终包含所属仓库。 */
                const workspaceId = group.workspace.id;
                /** 仓库选择与审阅焦点相互独立。 */
                const workspaceSelected = props.selectedWorkspaceIds.has(workspaceId);
                /** 本仓库选中路径供目录与文件共用。 */
                const selectedPaths = new Set(props.selectedPathsByWorkspace[workspaceId] ?? []);
                return (
                  <details open key={workspaceId} className={`task-git-delivery-repository${props.focusedWorkspaceId === workspaceId ? ' is-focused' : ''}`}>
                    <summary>
                      <label>
                        <input type="checkbox" checked={workspaceSelected} onChange={(event) => props.onToggleWorkspace(workspaceId, event.target.checked)} disabled={props.disabled || group.workspace.state === 'discarded'} />
                        <DeliveryEntryIcon />
                        <span>
                          <strong>{repositoryLabel(group.workspace, props.zh)}</strong>
                          <small>
                            {group.files.length} {props.zh ? '个文件' : 'files'}
                          </small>
                          <small>{group.statusLabel}</small>
                        </span>
                      </label>
                    </summary>
                    {props.detailStates[workspaceId] === 'loading' ? <small className="task-git-delivery-repository-state">{props.zh ? '正在读取文件…' : 'Loading files…'}</small> : null}
                    {group.files.length > 0 ? (
                      <DeliveryDirectoryFiles
                        files={group.files}
                        prefix=""
                        selectedPaths={workspaceSelected ? selectedPaths : new Set()}
                        selectedFile={props.focusedWorkspaceId === workspaceId ? props.selectedFile : ''}
                        working={props.diffScope === 'working'}
                        disabled={props.disabled || group.workspace.state === 'discarded'}
                        zh={props.zh}
                        onToggle={(paths, selected) => props.onToggleFiles(workspaceId, paths, selected)}
                        onSelect={(path) => props.onSelectFile(workspaceId, path)}
                        onOpen={(path) => props.onOpenFile(workspaceId, path)}
                      />
                    ) : !props.detailStates[workspaceId] ? (
                      <small className="task-git-delivery-repository-state">{props.diffScope === 'working' ? (props.zh ? '没有未提交文件' : 'No uncommitted files') : props.zh ? '没有已提交成果' : 'No committed result'}</small>
                    ) : null}
                  </details>
                );
              })}
            </section>
          );
        })}
      </div>
    </aside>
  );
}

/** 目录仅组织显示和批量勾选；文件身份始终保留完整仓库相对路径。 */
function DeliveryDirectoryFiles(props: {
  /** 当前目录内的全部文件。 */
  files: DeliveryFile[];
  /** 已显示的父路径。 */
  prefix: string;
  /** 当前实际参与提交的文件。 */
  selectedPaths: Set<string>;
  /** 正在审阅的完整路径。 */
  selectedFile: string;
  /** 已提交范围只读，不显示提交勾选。 */
  working: boolean;
  /** 交付期间禁止改变范围。 */
  disabled: boolean;
  /** 当前显示语言。 */
  zh: boolean;
  /** 一次更新当前目录内的选择。 */
  onToggle: (paths: string[], selected: boolean) => void;
  /** 单击更新下方差异。 */
  onSelect: (path: string) => void;
  /** 双击打开独立窗口。 */
  onOpen: (path: string) => void;
}) {
  /** 文件按下一级路径分组，目录排序在普通文件之前。 */
  const entries = useMemo(() => {
    /** 每个目录记录其后代，选择时无需重新扫描其他仓库。 */
    const groups = new Map<string, DeliveryFile[]>();
    for (const file of props.files) {
      /** 尾部斜杠区分目录与叶子。 */
      const remainder = file.path.slice(props.prefix.length);
      /** 找到当前目录下一级边界。 */
      const slash = remainder.indexOf('/');
      /** 叶子保留文件名，目录保留末尾分隔符。 */
      const name = slash < 0 ? remainder : remainder.slice(0, slash + 1);
      /** 同目录后代共用一份集合。 */
      const files = groups.get(name) ?? [];
      files.push(file);
      groups.set(name, files);
    }
    return [...groups]
      .map(([name, files]) => {
        // 连续单子目录合成一行；遇到文件或目录分叉即停止，保持批量勾选范围。
        while (name.endsWith('/')) {
          /** 第一条路径提供下一级边界，所有后代必须共享该目录。 */
          const slash = files[0]!.path.indexOf('/', props.prefix.length + name.length);
          if (slash < 0) break;
          /** 合并名称仍保留末尾斜杠，递归与复选框继续使用完整路径。 */
          const next = files[0]!.path.slice(props.prefix.length, slash + 1);
          if (!files.every((file) => file.path.startsWith(props.prefix + next))) break;
          name = next;
        }
        return [name, files] as const;
      })
      .sort(([left], [right]) => Number(right.endsWith('/')) - Number(left.endsWith('/')) || left.localeCompare(right));
  }, [props.files, props.prefix]);
  return (
    <ol>
      {entries.map(([name, files]) => {
        /** 目录和文件均使用完整路径作为稳定身份。 */
        const path = props.prefix + name;
        /** 目录节点展开子级，叶子节点打开差异。 */
        const directory = name.endsWith('/');
        /** 半选状态只统计当前有效提交范围。 */
        const selectedCount = files.filter((file) => props.selectedPaths.has(file.path)).length;
        /** 全选与半选分开设置到原生复选框。 */
        const allSelected = selectedCount === files.length;
        /** 已提交成果隐藏文件选择，仓库仍可用于交付。 */
        const checkbox = props.working ? (
          <input
            type="checkbox"
            checked={allSelected}
            ref={(element) => {
              if (element) element.indeterminate = selectedCount > 0 && !allSelected;
            }}
            aria-label={props.zh ? `选择${directory ? '目录' : '文件'} ${path}` : `Select ${directory ? 'directory' : 'file'} ${path}`}
            onChange={(event) =>
              props.onToggle(
                files.map((file) => file.path),
                event.target.checked,
              )
            }
            disabled={props.disabled}
          />
        ) : null;
        return (
          <li key={path}>
            {directory ? (
              <details open className="task-git-delivery-directory">
                <summary title={path}>
                  {checkbox}
                  <DeliveryEntryIcon />
                  <span>{name.slice(0, -1)}</span>
                  <small>{files.length}</small>
                </summary>
                <DeliveryDirectoryFiles {...props} files={files} prefix={path} />
              </details>
            ) : (
              <div className={`task-git-delivery-file-row${props.selectedFile === path ? ' is-active' : ''}`}>
                {checkbox}
                <button type="button" title={path} aria-pressed={props.selectedFile === path} onClick={() => props.onSelect(path)} onDoubleClick={() => props.onOpen(path)} disabled={props.disabled}>
                  <DeliveryEntryIcon path={path} />
                  <span>{name}</span>
                  <small>
                    {files[0].label}
                    {files[0].additions || files[0].deletions ? ` · +${files[0].additions} −${files[0].deletions}` : ''}
                  </small>
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 交付树复用源码及会话的文件图标，目录使用同一 Phosphor 文件夹轮廓。 */
function DeliveryEntryIcon(props: { path?: string }) {
  return props.path ? <FileTypeIcon name={props.path} className="task-git-delivery-entry-icon" /> : <FolderIcon className="task-git-delivery-entry-icon" size={16} weight="regular" aria-hidden="true" />;
}

/** 操作区和冲突页标题栏只显示摘要，复用原生浮层查看逐仓详情。 */
export function DeliveryFeedbackNotice(props: {
  feedback: DeliveryFeedback;
  zh: boolean;
  /** 标题栏入口不占额外一行，浮层由浏览器处理外部点击、Escape 与焦点。 */
  compactResults?: boolean;
}) {
  /** 每个提示使用唯一浮层身份和定位锚点，避免不同窗口或预览相互定位。 */
  const resultId = useId();
  /** CSS 锚点名称使用合法标识符，保持浮层贴近当前入口。 */
  const resultAnchor = `--delivery-results-${resultId.replace(/:/g, '')}`;
  /** 查询原生浮层状态，让 Escape 优先关闭明细而不是交付窗口。 */
  const resultPopover = useRef<HTMLDivElement>(null);
  return (
    <div
      className={`task-git-delivery-notice is-${props.feedback.tone}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      onKeyDown={(event) => {
        // 原生浮层嵌在 ModalPortal 中，拦住其关闭整个窗口的 Escape 路由。
        if (event.key === 'Escape' && resultPopover.current?.matches(':popover-open')) {
          event.preventDefault();
          event.stopPropagation();
          resultPopover.current.hidePopover();
        }
      }}
    >
      {(props.compactResults || props.feedback.action) && (props.feedback.results?.length || props.feedback.summary) && !props.feedback.onAction ? (
        <>
          <button type="button" className="task-git-delivery-result-trigger" popoverTarget={resultId} title={props.feedback.text} style={{ anchorName: resultAnchor }}>
            <span>{props.feedback.summary ?? props.feedback.text}</span>
            <CaretDownIcon aria-hidden="true" />
          </button>
          <div ref={resultPopover} id={resultId} popover="auto" className="task-git-delivery-result-popover" style={{ positionAnchor: resultAnchor }} aria-label={props.zh ? '逐仓交付结果' : 'Per-repository delivery results'}>
            {props.feedback.results?.length ? <BatchDeliveryResults results={props.feedback.results} zh={props.zh} /> : <div className={`task-git-delivery-feedback is-${props.feedback.tone}`}>{props.feedback.text}</div>}
          </div>
        </>
      ) : (
        <>
          <div className={`task-git-delivery-feedback is-${props.feedback.tone}`}>
            <span>{props.feedback.text}</span>
            {props.feedback.actionLabel && props.feedback.onAction ? (
              <button type="button" onClick={props.feedback.onAction}>
                {props.feedback.actionLabel}
              </button>
            ) : null}
          </div>
          {props.feedback.results?.length ? <BatchDeliveryResults results={props.feedback.results} zh={props.zh} /> : null}
        </>
      )}
    </div>
  );
}

/** 将仓库与其操作结果放在同一行，颜色之外同时提供文字状态。 */
function BatchDeliveryResults(props: { results: BatchDeliveryResult[]; zh: boolean }) {
  return (
    <section className="task-git-delivery-batch-result" aria-label={props.zh ? '逐仓交付结果' : 'Per-repository delivery results'}>
      <ol>
        {props.results.map((result) => (
          <li key={result.workspaceId} data-status={result.status}>
            <b>{props.zh ? { succeeded: '成功', skipped: '跳过', attention: '待处理', failed: '失败' }[result.status] : result.status}</b>
            <span>{result.repositoryName}</span>
            <small>{result.message}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 按真实分支分组，不为普通目录制造任务分支。 */
function groupDeliveryRepositoriesByBranch(groups: DeliveryRepositoryGroup[]): Array<{ branchName: string; repositories: DeliveryRepositoryGroup[] }> {
  /** 按首次出现顺序保留现有仓库顺序。 */
  const byBranch = new Map<string, DeliveryRepositoryGroup[]>();
  for (const group of groups) {
    /** 同分支仓库复用同一组，不重新排序。 */
    const existing = byBranch.get(group.workspace.branchName);
    if (existing) existing.push(group);
    else byBranch.set(group.workspace.branchName, [group]);
  }
  return [...byBranch].map(([branchName, repositories]) => ({ branchName, repositories }));
}

/** 仓库名称来自服务端登记事实。 */
export function repositoryLabel(workspace: Pick<TaskWorkspaceIndexSnapshot, 'repositoryName' | 'repositoryRelativePath'>, zh: boolean): string {
  return workspace.repositoryName || workspace.repositoryRelativePath || (zh ? '项目仓库' : 'Project repository');
}

/** 普通目录和任务工作树共用同一文件审查、操作区及差异布局。 */
export function GitDeliveryWorkspace(props: {
  zh: boolean;
  selectedRepositories: number;
  totalRepositories: number;
  selectedFiles: number;
  fileBrowser: ReactNode;
  actions: ReactNode;
  selectedFile: string;
  diffTitle: string;
  diffLoading: boolean;
  diff: TaskGitDiffSummary | null;
  revision: string | number;
  previewRequest?: ComponentProps<typeof SideBySideDiff>['previewRequest'];
  onShowCommitted?: () => void;
  busy: boolean;
}) {
  return (
    <div className="task-git-delivery-content">
      <DeliveryScopeBar {...props} />
      <div className="task-git-review-layout task-git-delivery-layout">
        {props.fileBrowser}
        {props.actions}
        <GitPaneSeparator name="delivery-height" label={props.zh ? '调整文件区与差异区高度' : 'Resize files and diff'} axis="y" initial={42} min={25} max={65} />
        <main className="task-git-review-main task-git-delivery-diff-main">
          <header className="task-git-review-pane-title">
            <strong title={props.selectedFile}>{props.diffTitle}</strong>
          </header>
          {!props.selectedFile ? (
            <div className="task-git-delivery-empty">
              <strong>{props.zh ? '选择文件，查看代码变化' : 'Select a file to review changes'}</strong>
              {props.onShowCommitted ? (
                <Button variant="secondary" size="regular" onClick={props.onShowCommitted} disabled={props.busy}>
                  {props.zh ? '查看已提交成果' : 'Review committed changes'}
                </Button>
              ) : null}
            </div>
          ) : props.diffLoading ? (
            <p className="task-git-review-empty" role="status">
              {props.zh ? '正在读取差异…' : 'Loading diff…'}
            </p>
          ) : (
            <SideBySideDiff previewRequest={props.previewRequest} revision={props.revision} diff={props.diff} zh={props.zh} title={props.diffTitle} fill />
          )}
        </main>
      </div>
    </div>
  );
}

/** 三个交付步骤只实现一次；合入方向由真实工作区能力明确说明。 */
export function GitDeliveryActions(props: {
  zh: boolean;
  busyAction: BusyAction;
  clientAvailable: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  message: string;
  onMessageChange: (value: string) => void;
  generationFeedback: string;
  commitCount: number;
  onCommit: () => void;
  beforeCommit?: ReactNode;
  commitFeedback?: ReactNode;
  mergeTitle?: string;
  mergeDescription?: string;
  mergeTarget: string;
  mergeOptions: ComponentProps<typeof ZeusSelect>['options'];
  onMergeTargetChange: (value: string) => void;
  mergeDisabled: boolean;
  mode: 'merge' | 'squash';
  onModeChange?: (value: 'merge' | 'squash') => void;
  mergeCount: number;
  onMerge: () => void;
  mergeIssues?: ReactNode;
  mergeFeedback?: ReactNode;
  pushCount: number;
  onPush: () => void;
  pushFeedback?: ReactNode;
}) {
  /** 两种入口都在操作期间锁定文件选择。 */
  const busy = props.busyAction !== null;
  return (
    <aside className="task-git-review-options task-git-delivery-actions">
      <section className="task-git-delivery-action-step">
        <div className="task-git-delivery-step-heading">
          <strong>{props.zh ? '1. 提交文件' : '1. Commit files'}</strong>
          <Button
            variant="secondary"
            size="compact"
            aria-label={props.busyAction === 'commit-message' ? (props.zh ? '停止生成提交说明' : 'Stop generating commit message') : props.zh ? 'AI 生成提交说明' : 'Generate commit message with AI'}
            title={props.zh ? '根据勾选文件生成提交说明' : 'Generate a commit message from selected files'}
            disabled={props.busyAction !== 'commit-message' && (busy || !props.clientAvailable || !props.canGenerate)}
            onClick={props.onGenerate}
          >
            {props.busyAction === 'commit-message' ? (props.zh ? '停止生成' : 'Stop generating') : props.zh ? 'AI 生成' : 'AI Generate'}
          </Button>
        </div>
        {props.beforeCommit}
        {props.commitCount > 0 ? (
          <textarea value={props.message} onChange={(event) => props.onMessageChange(event.target.value)} disabled={busy && props.busyAction !== 'commit-message'} aria-label={props.zh ? '提交说明' : 'Commit message'} />
        ) : null}
        {props.generationFeedback ? <small role="status">{props.generationFeedback}</small> : null}
        <Button variant="secondary" size="compact" busy={props.busyAction === 'commit'} onClick={props.onCommit} disabled={busy || props.commitCount === 0}>
          {props.zh ? `提交所选文件（${props.commitCount}）` : `Commit selected files (${props.commitCount})`}
        </Button>
        {props.commitFeedback}
      </section>
      <section className="task-git-delivery-action-step">
        <strong>{props.mergeTitle ?? (props.zh ? '2. 合入目标分支' : '2. Merge into target branch')}</strong>
        {props.mergeDescription ? <small>{props.mergeDescription}</small> : null}
        <ZeusSelect
          size="compact"
          ariaLabel={props.mergeTitle ?? (props.zh ? '统一合入目标分支' : 'Merge target for all selected repositories')}
          value={props.mergeTarget}
          options={props.mergeOptions}
          onChange={props.onMergeTargetChange}
          disabled={busy || props.mergeDisabled}
          searchPlaceholder={props.zh ? '搜索本地分支' : 'Search local branches'}
        />
        {props.mergeIssues}
        {props.onModeChange ? (
          <ZeusSelect
            size="compact"
            ariaLabel={props.zh ? '合入方式' : 'Merge method'}
            value={props.mode}
            options={[
              { value: 'merge', label: props.zh ? 'Merge · 保留提交历史' : 'Merge · preserve commits' },
              { value: 'squash', label: props.zh ? 'Squash · 合成一个提交' : 'Squash · one commit' },
            ]}
            onChange={props.onModeChange}
            disabled={busy}
            searchable={false}
          />
        ) : null}
        <Button variant="primary" size="compact" busy={props.busyAction === 'merge'} onClick={props.onMerge} disabled={busy || props.mergeCount === 0}>
          {props.zh ? `合入所选仓库（${props.mergeCount}）` : `Merge selected repositories (${props.mergeCount})`}
        </Button>
        {props.mergeFeedback}
      </section>
      <section className="task-git-delivery-action-step">
        <div className="task-git-delivery-step-heading">
          <strong>{props.zh ? '3. 推送到远端' : '3. Push to remote'}</strong>
          <Button variant="secondary" size="compact" busy={props.busyAction === 'push'} onClick={props.onPush} disabled={busy || props.pushCount === 0}>
            {props.zh ? `推送（${props.pushCount}）` : `Push (${props.pushCount})`}
          </Button>
        </div>
        {props.pushFeedback}
      </section>
    </aside>
  );
}
