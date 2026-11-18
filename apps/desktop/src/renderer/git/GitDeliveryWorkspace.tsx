import { useDeliveryFileMenu } from './DeliveryFileMenu.js';
import type { FilePreviewRequest, GitDeliverySettings } from '@zeus/shared';
import { groupRepositoriesByBranch } from './repositoryBranchGroups.js';
import { GitDeliveryCombinationContext, readGitDeliverySettings } from './gitDeliverySettings.js';
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type ComponentProps } from 'react';
import { createPortal } from 'react-dom';
import type { TaskWorkspaceIndexSnapshot, TaskWorkspaceSnapshot, TaskGitDiffSummary } from '../session/sessionTypes.js';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { SideBySideDiff } from './ProjectGitDiffViewer.js';
import { GitPaneSeparator } from './GitPaneSeparator.js';
import { beginGitDiffSelection, useGitDeliveryWindowFrame } from './gitDeliveryPerformance.js';
import type { PreparedFilePreview } from '../code/preparedFilePreview.js';
import { CopySimpleIcon } from '@phosphor-icons/react/dist/csr/CopySimple';
import { CheckIcon } from '@phosphor-icons/react/dist/csr/Check';
import { GearSixIcon } from '@phosphor-icons/react/dist/csr/GearSix';
import { SparkleIcon } from '@phosphor-icons/react/dist/csr/Sparkle';
import { WarningCircleIcon } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { fileStatusLabel, type FileStatus } from '../code/fileStatus.js';
import { groupDirectoryFiles } from '../code/groupDirectoryFiles.js';
import { GitCommitGenerationSettingsButton } from './GitCommitGenerationSettings.js';
import type { GitCommitModelsClient } from './gitCommitModels.js';
import { gitDeliveryActionLabel } from './GitDeliveryProgress.js';

/** 两种交付入口共用文件范围。 */
export type DiffScope = 'committed' | 'working';
/** 操作期间锁定交付范围。 */
export type BusyAction = 'loading' | 'files' | 'commit' | 'commit-message' | 'push' | 'merge' | 'conflict' | 'ai' | null;

/** 文件树保留真实仓库相对路径。 */
export interface DeliveryFile {
  /** 子模块是可提交的版本引用，不展开为父仓库文件。 */
  isSubmodule?: boolean;
  /** 仓库相对路径保持文件操作身份。 */
  path: string;
  /** 工作区使用 Git 状态，已提交成果使用比较类型。 */
  status: FileStatus;
  /** 当前比较中的新增行数。 */
  additions: number;
  /** 当前比较中的删除行数。 */
  deletions: number;
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
  /** 原始失败保留错误链，详情窗口可读取 Git 输出。 */
  error?: unknown;
}

/** 交付视图只消费显示事实，不要求普通目录伪造任务工作区。 */
export interface DeliveryRepositoryGroup {
  /** 文件复制沿用实际工作目录；缺省仍提供原始相对路径。 */
  localPath?: string;
  workspace: Pick<TaskWorkspaceIndexSnapshot, 'id' | 'branchName' | 'state' | 'repositoryName' | 'repositoryRelativePath'>;
  detail: Pick<TaskWorkspaceSnapshot, 'review'> | undefined;
  files: DeliveryFile[];
  /** 完整工作区路径用于清除已提交或已还原文件的分组归属。 */
  workingPaths?: string[];
  statusLabel: string;
  /** 未完成或失败的读取不能被当成空目录。 */
  loadState?: 'loading' | 'error';
}

/** 本机读取失败保留重试，不能把未加载误报为没有变化。 */
export function InitialLoadState(props: { zh: boolean; error?: unknown; onRetry?: () => void }) {
  if (!props.error)
    return (
      <div className="task-git-delivery-content" role="status" aria-label={props.zh ? '正在读取本机 Git 信息' : 'Loading local Git information'} aria-busy="true">
        <div className="task-git-review-layout task-git-delivery-layout" aria-hidden="true">
          <section className="task-git-delivery-file-browser">
            <header className="task-git-review-pane-title">
              <strong>{props.zh ? '本机未提交' : 'Local uncommitted'}</strong>
            </header>
            <div className="task-loading-skeleton-stack git-delivery-loading-lines">
              <span className="task-loading-skeleton-line" />
              <span className="task-loading-skeleton-line" />
              <span className="task-loading-skeleton-line short" />
            </div>
          </section>
          <section className="task-git-delivery-actions">
            <div className="task-git-delivery-actions-scroll">
              <header className="task-git-review-pane-title">
                <strong>{props.zh ? '提交文件' : 'Commit files'}</strong>
              </header>
              <div className="task-loading-skeleton-stack git-delivery-loading-lines">
                <span className="task-loading-skeleton-line" />
                <span className="task-loading-skeleton-line short" />
              </div>
            </div>
          </section>
          <main className="task-git-review-main task-git-delivery-diff-main">
            <header className="task-git-review-pane-title">
              <strong>{props.zh ? '差异对比' : 'Diff'}</strong>
            </header>
            <div className="task-loading-skeleton-stack git-delivery-loading-lines">
              <span className="task-loading-skeleton-line" />
              <span className="task-loading-skeleton-line short" />
            </div>
          </main>
        </div>
      </div>
    );
  return (
    <section className="task-git-delivery-load-state" role={props.error ? 'alert' : 'status'}>
      <VisibleApplicationError error={props.error} language={props.zh ? 'zh-CN' : 'en'} />
      {props.onRetry ? (
        <Button variant="secondary" size="compact" onClick={props.onRetry}>
          {props.zh ? '重新读取' : 'Retry'}
        </Button>
      ) : null}
    </section>
  );
}

/** 未勾选的仓库共用空范围。 */
const emptyDeliveryPaths = new Set<string>();

/** 按任务分支、仓库与目录组织交付范围，审阅操作不改变勾选。 */
export function DeliveryRepositoryFileTree(props: {
  /** 本机变更列表归属当前项目。 */
  projectId: string;
  /** 文件操作复用调用方的仓库或任务身份。 */
  fileRequest: (workspaceId: string, path: string) => FilePreviewRequest;
  /** 文件写入完成或失败后重新读取真实状态。 */
  onRefresh: () => Promise<void>;
  /** 文件操作期间锁定提交等动作。 */
  onBusyChange: (busy: boolean) => void;
  groups: DeliveryRepositoryGroup[];
  detailStates: Record<string, 'loading' | 'error'>;
  diffScope: DiffScope;
  totalWorkingFiles: number;
  /** 未完成或失败的比较没有可靠计数，不能显示为零。 */
  totalCommittedFiles: number | null;
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
  /** 只有剪贴板写入成功才返回 true，避免把错误回报成已复制。 */
  onCopyBranch: (branchName: string) => boolean | Promise<boolean>;
}) {
  /** 文件菜单在所有交付入口保持同一可用状态和范围。 */
  const fileMenu = useDeliveryFileMenu({ ...props, working: props.diffScope === 'working', request: props.fileRequest });
  /** 审阅焦点变化时保留各仓库的动作引用，点击时仍读取最新工作区。 */
  const latestActions = useRef({ fileMenu, props });
  useLayoutEffect(() => {
    latestActions.current = { fileMenu, props };
  });
  /** 变更列表名称影响文件分组，菜单是否打开不影响。 */
  const listName = fileMenu.lists.name;
  /** 文件集合或变更列表变化时才重新绑定仓库目录。 */
  const repositoryActions = useMemo(
    () =>
      new Map(
        props.groups.map((group) => {
          /** 动作以仓库和仓库内的路径定位。 */
          const id = group.workspace.id;
          return [
            id,
            {
              listName: (path: string) => (group.localPath ? listName(group.localPath, path) : ''),
              onContextMenu: (event: React.MouseEvent<HTMLElement>, files: DeliveryFile[]) => latestActions.current.fileMenu.openMenu(event, group, files),
              onKeyDown: (event: React.KeyboardEvent<HTMLElement>, files: DeliveryFile[]) => latestActions.current.fileMenu.onKeyDown(event, group, files),
              onToggle: (paths: string[], selected: boolean) => latestActions.current.props.onToggleFiles(id, paths, selected),
              onSelect: (path: string) => latestActions.current.props.onSelectFile(id, path),
              onOpen: (path: string) => latestActions.current.props.onOpenFile(id, path),
            },
          ] as const;
        }),
      ),
    [props.groups, listName],
  );
  /** 切换文件审阅时复用提交勾选集合。 */
  const selectedPathSets = useMemo(() => new Map(Object.entries(props.selectedPathsByWorkspace).map(([id, paths]) => [id, new Set(paths)] as const)), [props.selectedPathsByWorkspace]);
  // 仅完整读取的仓库清除过期归属，筛选视图和加载失败不删除其他文件的分组。
  useEffect(() => {
    try {
      fileMenu.lists.prune(props.groups.flatMap((group) => (group.localPath && group.workingPaths ? [{ root: group.localPath, paths: group.workingPaths }] : [])));
    } catch (error) {
      fileMenu.onError(error);
    }
  }, [props.groups, fileMenu.lists.prune, fileMenu.onError]);
  /** 复制反馈只属于成功写入的分支。 */
  const [copiedBranch, setCopiedBranch] = useState<string | null>(null);
  // 短暂确认后恢复原操作名称，组件退出时释放定时器。
  useEffect(() => {
    if (!copiedBranch) return;
    /** 确认持续时间与其他复制入口一致。 */
    const timer = window.setTimeout(() => setCopiedBranch(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copiedBranch]);
  /** 同一任务分支下的仓库保持现有排序与交付范围。 */
  const visibleGroups = props.groups.filter((group) => group.files.length > 0 || group.loadState || props.detailStates[group.workspace.id]);
  /** 分支全选只作用于当前文件范围中的可见仓库。 */
  const branchGroups = groupRepositoriesByBranch(visibleGroups, (group) => group.workspace.branchName);
  return (
    <aside className="task-git-delivery-file-browser" aria-label={props.zh ? '按仓库分组的交付文件' : 'Delivery files grouped by repository'}>
      <header className="task-git-review-pane-title task-git-delivery-diff-tabs">
        <span role="group" aria-label={props.zh ? '文件范围' : 'File scope'}>
          <Button
            unstyled
            type="button"
            className={props.diffScope === 'working' ? 'is-active' : ''}
            aria-pressed={props.diffScope === 'working'}
            data-icon-tooltip={props.zh ? '本机未提交' : 'Local uncommitted'}
            onClick={() => props.onScopeChange('working')}
            disabled={props.disabled}
          >
            <span>{props.zh ? '本机未提交' : 'Local uncommitted'}</span> <small>{props.totalWorkingFiles}</small>
          </Button>
          <Button
            unstyled
            type="button"
            className={props.diffScope === 'committed' ? 'is-active' : ''}
            aria-pressed={props.diffScope === 'committed'}
            data-icon-tooltip={props.zh ? '已提交成果' : 'Committed result'}
            onClick={() => props.onScopeChange('committed')}
            disabled={props.disabled}
          >
            <span>{props.zh ? '已提交成果' : 'Committed result'}</span> <small>{props.totalCommittedFiles ?? '—'}</small>
          </Button>
        </span>
      </header>
      <div className="task-git-delivery-file-tree">
        {visibleGroups.length === 0 ? <p className="task-git-delivery-repository-state">{props.zh ? '当前范围没有变动文件。' : 'No changed files in this scope.'}</p> : null}
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
                  <Button
                    unstyled
                    type="button"
                    aria-label={copiedBranch === branchGroup.branchName ? (props.zh ? '已复制分支名' : 'Branch name copied') : props.zh ? '复制分支名' : 'Copy branch name'}
                    data-icon-tooltip={copiedBranch === branchGroup.branchName ? (props.zh ? '已复制分支名' : 'Branch name copied') : props.zh ? '复制分支名' : 'Copy branch name'}
                    onClick={async () => {
                      // 回执由实际执行复制的调用方提供，不根据点击推测成功。
                      setCopiedBranch((await props.onCopyBranch(branchGroup.branchName)) ? branchGroup.branchName : null);
                    }}
                    disabled={props.disabled}
                  >
                    {copiedBranch === branchGroup.branchName ? <CheckIcon size={14} aria-hidden="true" /> : <CopySimpleIcon size={14} aria-hidden="true" />}
                  </Button>
                </span>
              </header>
              {branchGroup.repositories.map((group) => {
                /** 文件身份始终包含所属仓库。 */
                const workspaceId = group.workspace.id;
                /** 仓库选择与审阅焦点相互独立。 */
                const workspaceSelected = props.selectedWorkspaceIds.has(workspaceId);
                /** 本仓库选中路径供目录与文件共用。 */
                const selectedPaths = (workspaceSelected && selectedPathSets.get(workspaceId)) || emptyDeliveryPaths;
                return (
                  <details open data-file-root={group.localPath} key={workspaceId} className={`task-git-delivery-repository${props.focusedWorkspaceId === workspaceId ? ' is-focused' : ''}`}>
                    <summary onContextMenu={(event) => fileMenu.openMenu(event, group, group.files)} onKeyDown={(event) => fileMenu.onKeyDown(event, group, group.files)}>
                      <label>
                        <input type="checkbox" checked={workspaceSelected} onChange={(event) => props.onToggleWorkspace(workspaceId, event.target.checked)} disabled={props.disabled || group.workspace.state === 'discarded'} />
                        <DeliveryEntryIcon />
                        <span>
                          <strong>{repositoryLabel(group.workspace, props.zh)}</strong>
                          <small>
                            {group.files.length} {group.files.some((file) => file.isSubmodule) ? (props.zh ? '项变更' : 'changes') : props.zh ? '个文件' : 'files'}
                          </small>
                          <small>{group.statusLabel}</small>
                        </span>
                      </label>
                    </summary>
                    {(group.loadState ?? props.detailStates[workspaceId]) === 'loading' ? <small className="task-git-delivery-repository-state">{props.zh ? '正在读取文件…' : 'Loading files…'}</small> : null}
                    {group.files.length > 0 ? (
                      <DeliveryChangelistFiles
                        {...repositoryActions.get(workspaceId)!}
                        files={group.files}
                        prefix=""
                        selectedPaths={selectedPaths}
                        selectedFile={props.focusedWorkspaceId === workspaceId ? props.selectedFile : ''}
                        working={props.diffScope === 'working'}
                        disabled={props.disabled || group.workspace.state === 'discarded'}
                        zh={props.zh}
                      />
                    ) : !(group.loadState ?? props.detailStates[workspaceId]) ? (
                      <small className="task-git-delivery-repository-state">{props.diffScope === 'working' ? (props.zh ? '没有未提交文件' : 'No uncommitted files') : props.zh ? '没有已提交成果' : 'No committed result'}</small>
                    ) : null}
                  </details>
                );
              })}
            </section>
          );
        })}
      </div>
      {fileMenu.dialogs}
    </aside>
  );
}

/** 只有自定义列表存在时才显示列表层级，未跟踪文件保持独立分组。 */
const DeliveryChangelistFiles = memo(function ChangelistFiles(props: DeliveryDirectoryFilesProps & { listName(path: string): string }) {
  /** 每个文件只属于一个本机列表，历史成果不参与分组。 */
  const groups = useMemo(() => {
    if (!props.working) return null;
    /** 分组时同时保留已跟踪和未跟踪文件的顺序。 */
    type Members = { tracked: DeliveryFile[]; untracked: DeliveryFile[] };
    const membersByName = new Map<string, Members>();
    for (const file of props.files) {
      const untracked = file.status === 'untracked';
      const name = untracked ? '' : props.listName(file.path);
      const members: Members = membersByName.get(name) ?? { tracked: [], untracked: [] };
      members[untracked ? 'untracked' : 'tracked'].push(file);
      membersByName.set(name, members);
    }
    return [...membersByName.keys()].some(Boolean) ? [...membersByName] : null;
  }, [props.files, props.listName, props.working]);
  if (!groups) return <DeliveryDirectoryFiles {...props} />;
  return (
    <>
      {groups.map(([name, { tracked, untracked }]) => {
        const selectedCount = tracked.filter((file) => props.selectedPaths.has(file.path)).length;
        return (
          <div key={name}>
            {tracked.length ? (
              <details open className="task-git-delivery-directory">
                <summary onContextMenu={(event) => props.onContextMenu(event, tracked)} onKeyDown={(event) => props.onKeyDown(event, tracked)}>
                  <input
                    type="checkbox"
                    checked={selectedCount === tracked.length}
                    ref={(element) => {
                      if (element) element.indeterminate = selectedCount > 0 && selectedCount < tracked.length;
                    }}
                    aria-checked={selectedCount > 0 && selectedCount < tracked.length ? 'mixed' : selectedCount === tracked.length}
                    aria-label={name || (props.zh ? '默认变更列表' : 'Default Changelist')}
                    disabled={props.disabled}
                    onChange={(event) =>
                      props.onToggle(
                        tracked.map((file) => file.path),
                        event.target.checked,
                      )
                    }
                  />
                  <span>{name || (props.zh ? '默认变更列表' : 'Default Changelist')}</span>
                  <small>{tracked.length}</small>
                </summary>
                <DeliveryDirectoryFiles {...props} files={tracked} selectedFile={tracked.some((file) => file.path === props.selectedFile) ? props.selectedFile : ''} />
              </details>
            ) : null}
            {untracked.length ? <DeliveryDirectoryFiles {...props} files={untracked} selectedFile={untracked.some((file) => file.path === props.selectedFile) ? props.selectedFile : ''} /> : null}
          </div>
        );
      })}
    </>
  );
});

/** 目录仅组织显示和批量勾选；文件身份始终保留完整仓库相对路径。 */
interface DeliveryDirectoryFilesProps {
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
  /** 点击节点决定上下文动作范围。 */
  onContextMenu: (event: React.MouseEvent<HTMLElement>, files: DeliveryFile[]) => void;
  /** 文件树焦点内支持菜单与 Git 快捷键。 */
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>, files: DeliveryFile[]) => void;
}

/** 展开状态和审阅焦点独立，选中文件只更新所属目录分支。 */
const DeliveryDirectoryFiles = memo(function DirectoryFiles(props: DeliveryDirectoryFilesProps) {
  /** 复用未跟踪分组的成员列表，审阅焦点不触发重新分组。 */
  const rootGroups = useMemo(() => {
    if (props.prefix || !props.files.some((file) => file.status === 'untracked')) return null;
    return { tracked: props.files.filter((file) => file.status !== 'untracked'), untracked: props.files.filter((file) => file.status === 'untracked') };
  }, [props.files, props.prefix]);
  if (rootGroups) {
    const { tracked, untracked } = rootGroups;
    /** 只向当前文件所在的一组传递选中态。 */
    const selectedUntracked = untracked.some((file) => file.path === props.selectedFile);
    /** 分组勾选直接使用现有路径集合，支持半选。 */
    const selectedCount = untracked.filter((file) => props.selectedPaths.has(file.path)).length;
    return (
      <>
        <DeliveryDirectoryFiles {...props} files={tracked} selectedFile={selectedUntracked ? '' : props.selectedFile} />
        <details open className="task-git-delivery-directory">
          <summary onContextMenu={(event) => props.onContextMenu(event, untracked)} onKeyDown={(event) => props.onKeyDown(event, untracked)}>
            {props.working ? (
              <input
                type="checkbox"
                checked={selectedCount === untracked.length}
                ref={(element) => {
                  if (element) element.indeterminate = selectedCount > 0 && selectedCount < untracked.length;
                }}
                aria-checked={selectedCount > 0 && selectedCount < untracked.length ? 'mixed' : selectedCount === untracked.length}
                aria-label={props.zh ? '选择未跟踪文件' : 'Select untracked files'}
                onChange={(event) =>
                  props.onToggle(
                    untracked.map((file) => file.path),
                    event.target.checked,
                  )
                }
                disabled={props.disabled}
              />
            ) : null}
            <span>{props.zh ? '未跟踪文件' : 'Unversioned Files'}</span>
            <small>{untracked.length}</small>
          </summary>
          <DeliveryDirectoryEntries {...props} files={untracked} selectedFile={selectedUntracked ? props.selectedFile : ''} />
        </details>
      </>
    );
  }
  return <DeliveryDirectoryEntries {...props} />;
});

/** 目录与分组共用同一文件树，展开状态不改变真实路径。 */
const DeliveryDirectoryEntries = memo(function DirectoryEntries(props: DeliveryDirectoryFilesProps) {
  /** 文件按下一级路径分组，目录排序在普通文件之前。 */
  const entries = useMemo(() => groupDirectoryFiles(props.files, props.prefix), [props.files, props.prefix]);
  /** 点击审阅文件时复用目录勾选统计。 */
  const selectedCounts = useMemo(() => (props.working ? entries.map(([, files]) => files.filter((file) => props.selectedPaths.has(file.path)).length) : []), [entries, props.working, props.selectedPaths]);
  return (
    <ol>
      {entries.map(([name, files], index) => {
        /** 目录和文件均使用完整路径作为稳定身份。 */
        const path = props.prefix + name;
        /** 目录节点展开子级，叶子节点打开差异。 */
        const directory = name.endsWith('/');
        /** 半选状态只统计当前有效提交范围。 */
        const selectedCount = selectedCounts[index] ?? 0;
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
                <summary data-file-path={path} data-icon-tooltip={name.slice(0, -1)} onContextMenu={(event) => props.onContextMenu(event, files)} onKeyDown={(event) => props.onKeyDown(event, files)}>
                  {checkbox}
                  <DeliveryEntryIcon />
                  <span>{name.slice(0, -1)}</span>
                  <small>{files.length}</small>
                </summary>
                <DeliveryDirectoryFiles {...props} files={files} prefix={path} selectedFile={props.selectedFile.startsWith(path) ? props.selectedFile : ''} />
              </details>
            ) : (
              <div className={`task-git-delivery-file-row${props.selectedFile === path ? ' is-active' : ''}`} onContextMenu={(event) => props.onContextMenu(event, files)} onKeyDown={(event) => props.onKeyDown(event, files)}>
                {checkbox}
                <Button
                  data-busy-behavior="background"
                  unstyled
                  type="button"
                  data-file-path={path}
                  data-icon-tooltip={name}
                  aria-label={`${path}${files[0].isSubmodule ? (props.zh ? ' · 子模块' : ' · Submodule') : ''} · ${fileStatusLabel(files[0].status, props.zh)}`}
                  aria-pressed={props.selectedFile === path}
                  onClick={() => {
                    if (props.selectedFile !== path) beginGitDiffSelection(path);
                    return props.onSelect(path);
                  }}
                  onDoubleClick={() => props.onOpen(path)}
                  disabled={props.disabled}
                >
                  <DeliveryEntryIcon path={path} submodule={files[0].isSubmodule} />
                  <span data-file-status={files[0].status}>{name}</span>
                  {files[0].isSubmodule ? <small>{props.zh ? '子模块' : 'Submodule'}</small> : null}
                  {files[0].additions || files[0].deletions ? <small>{`+${files[0].additions} −${files[0].deletions}`}</small> : null}
                </Button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
});

/** 交付树复用源码及会话的文件图标，目录使用同一 Phosphor 文件夹轮廓。 */
function DeliveryEntryIcon(props: { path?: string; submodule?: boolean }) {
  return props.path ? (
    <FileTypeIcon name={props.path} kind={props.submodule ? 'submodule' : undefined} className="task-git-delivery-entry-icon" />
  ) : (
    <FolderIcon className="task-git-delivery-entry-icon" size={16} weight="regular" aria-hidden="true" />
  );
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
  /** 鼠标和键盘均可查看同一份明细。 */
  const resultTrigger = useRef<HTMLButtonElement>(null);
  /** 短暂跨过入口与浮层间隙时，不立即关闭正在查看的内容。 */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 鼠标等待后展示逐仓结果，点击与键盘继续使用即时原生浮层。 */
  const hoverIntent = useHoverIntent(() => showResults());
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  /** 原生浮层负责定位、外部点击和 Escape，悬停只控制显示。 */
  function showResults(): void {
    hoverIntent.cancel();
    clearTimeout(closeTimer.current);
    if (!resultPopover.current?.matches(':popover-open')) resultPopover.current?.showPopover();
  }
  /** 鼠标与焦点离开入口和明细后才关闭，便于阅读或复制长内容。 */
  function closeResultsLater(): void {
    hoverIntent.cancel();
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!resultTrigger.current?.matches(':hover, :focus') && !resultPopover.current?.matches(':hover, :focus-within')) resultPopover.current?.hidePopover();
    }, 120);
  }
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
          <Button
            unstyled
            ref={resultTrigger}
            type="button"
            className="task-git-delivery-result-trigger"
            popoverTarget={resultId}
            popoverTargetAction="show"
            aria-describedby={resultId}
            style={{ anchorName: resultAnchor }}
            onPointerEnter={(event) => {
              clearTimeout(closeTimer.current);
              if (event.pointerType !== 'touch' && event.buttons === 0) hoverIntent.schedule(event.currentTarget);
            }}
            onPointerLeave={closeResultsLater}
            onClick={hoverIntent.cancel}
            onFocus={(event) => {
              hoverIntent.cancel();
              if (event.currentTarget.matches(':focus-visible')) showResults();
            }}
            onBlur={closeResultsLater}
          >
            <span>{props.feedback.summary ?? props.feedback.text}</span>
            <WarningCircleIcon size={16} aria-hidden="true" />
          </Button>
          <div
            ref={resultPopover}
            id={resultId}
            popover="auto"
            role="tooltip"
            className="task-git-delivery-result-popover"
            style={{ positionAnchor: resultAnchor }}
            aria-label={props.zh ? '逐仓交付结果' : 'Per-repository delivery results'}
            onPointerEnter={showResults}
            onPointerLeave={closeResultsLater}
            onFocus={showResults}
            onBlur={closeResultsLater}
          >
            {props.feedback.results?.length ? <BatchDeliveryResults results={props.feedback.results} zh={props.zh} /> : <div className={`task-git-delivery-feedback is-${props.feedback.tone}`}>{props.feedback.text}</div>}
          </div>
        </>
      ) : (
        <>
          <div className={`task-git-delivery-feedback is-${props.feedback.tone}`}>
            <span>{props.feedback.text}</span>
            {props.feedback.actionLabel && props.feedback.onAction ? (
              <Button unstyled type="button" onClick={props.feedback.onAction}>
                {props.feedback.actionLabel}
              </Button>
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
            <small>{result.error ? <VisibleApplicationError error={result.error} summary={result.message} title={result.repositoryName} language={props.zh ? 'zh-CN' : 'en'} /> : result.message}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** 仓库名称来自服务端登记事实。 */
export function repositoryLabel(workspace: Pick<TaskWorkspaceIndexSnapshot, 'repositoryName' | 'repositoryRelativePath'>, zh: boolean): string {
  return workspace.repositoryName || workspace.repositoryRelativePath || (zh ? '项目仓库' : 'Project repository');
}

/** 普通目录和任务工作树共用同一文件审查、操作区及差异布局。 */
export function GitDeliveryWorkspace(props: {
  /** 至少一个仓库已有真实文件状态，加载占位不算首个可读帧。 */
  contentReady: boolean;
  zh: boolean;
  fileBrowser: ReactNode;
  actions: ReactNode;
  selectedFile: string;
  diffTitle: string;
  /** 与文件树使用同一状态，未跟踪文件不由补丁推断。 */
  fileStatus?: FileStatus;
  diffLoading: boolean;
  /** 读取失败留在当前文件附近，可重新请求同一个补丁。 */
  diffError?: unknown;
  /** 只重试当前选中文件。 */
  onRetryDiff?: () => void;
  diff: TaskGitDiffSummary | null;
  revision: string | number;
  /** 与补丁同时准备的授权全文，不重复读取或变更文件权限。 */
  preparedPreview?: PreparedFilePreview;
  /** Diff 保存后复用业务页的快照刷新，保持文件树和数量一致。 */
  onFileSaved?: () => void | Promise<void>;
  previewRequest?: ComponentProps<typeof SideBySideDiff>['previewRequest'];
  onShowCommitted?: () => void;
  busy: boolean;
}) {
  useGitDeliveryWindowFrame(props.contentReady);
  return (
    <div className="task-git-delivery-content">
      <div className="task-git-review-layout task-git-delivery-layout">
        {props.fileBrowser}
        {props.actions}
        <GitPaneSeparator name="delivery-actions" label={props.zh ? '调整操作区宽度' : 'Resize actions'} unit="px" initial={320} min={240} max={960} reverse />
        <GitPaneSeparator name="delivery-height" label={props.zh ? '调整文件区与差异区高度' : 'Resize files and diff'} axis="y" initial={42} min={15} max={80} />
        <main className="task-git-review-main task-git-delivery-diff-main">
          <header className="task-git-review-pane-title">
            <strong tabIndex={0} data-file-path={props.selectedFile || undefined} data-icon-tooltip={props.diffTitle} data-file-status={props.fileStatus}>
              {props.diffTitle}
            </strong>
          </header>
          {props.diffError != null ? (
            <p className="task-git-review-error" role="alert">
              <VisibleApplicationError error={props.diffError} language={props.zh ? 'zh-CN' : 'en'} action={props.onRetryDiff ? { label: props.zh ? '重试' : 'Retry', onClick: props.onRetryDiff } : undefined} />
            </p>
          ) : null}
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
            <SideBySideDiff
              fileStatus={props.fileStatus}
              previewRequest={props.previewRequest}
              revision={props.revision}
              preparedPreview={props.preparedPreview}
              onSaved={props.onFileSaved}
              diff={props.diff}
              zh={props.zh}
              title={props.diffTitle}
              showPatchEarly
              fill
            />
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
  /** 设置与生成读取同一项目的真实模型目录。 */
  generationClient: GitCommitModelsClient | null;
  /** 当前项目身份用于读取独立设置或继承全局默认。 */
  projectId: string;
  /** 使用项目原目录的会话采用直接提交和推送的初始组合。 */
  currentDirectory?: boolean;
  /** 只有关联任务的交付能够修改任务状态。 */
  hasTask: boolean;
  /** 交付设置入口放在当前窗口的标题栏。 */
  settingsHost: HTMLElement | null;
  canGenerate: boolean;
  onGenerate: () => void;
  message: string;
  onMessageChange: (value: string) => void;
  generationFeedback: string;
  commitCount: number;
  onCommit: () => void;
  beforeCommit?: ReactNode;
  commitFeedback?: ReactNode;
  /** 各仓库独立选择本地合入目标，默认值由入口的来源记录提供。 */
  mergeTargets: Array<{ repositoryId: string; label: string; value: string; branches: string[] }>;
  /** 选择结果同时用于单独合入和组合交付。 */
  onMergeTargetChange: (repositoryId: string, branch: string) => void;
  /** 复用入口的剪贴板能力和失败反馈。 */
  onCopyBranch?: (branchName: string) => boolean | Promise<boolean>;
  mergeDisabled: boolean;
  mode: 'merge' | 'squash';
  mergeCount: number;
  /** 任务交付明确覆盖工作目录全部仓库，独立仓库操作仍使用所选范围。 */
  mergeAll?: boolean;
  /** 单独合入也携带用户当前选择的成功收尾设置。 */
  onMerge?: (settings: GitDeliverySettings) => void;
  mergeIssues?: ReactNode;
  mergeFeedback?: ReactNode;
  pushCount: number;
  onPush: () => void;
  pushFeedback?: ReactNode;
  /** 两种交付入口共用后台运行入口。 */
  combination?: ReactNode;
}) {
  /** 每个项目恢复最近一次被后台接纳的组合，临时勾选仅属于当前操作栏。 */
  const [preferences, setSettings] = useState(() => readGitDeliverySettings(props.projectId, props.currentDirectory));
  /** 已保存的命令和任务状态默认勾选，本次关闭开关时保留选择值。 */
  const [followUps, setFollowUps] = useState(() => ({
    commands: Boolean(preferences.postPushCommandIds?.length),
    taskStatus: Boolean(preferences.finalTaskStatus),
  }));
  /** 每个仓库都选择有效本地目标后才允许整次合入。 */
  const canMerge = props.mergeTargets.length > 0 && props.mergeTargets.every((target) => target.value && target.branches.includes(target.value)) && !props.mergeDisabled;
  /** 表单显示当前选择，并限制无法执行的合入。 */
  const settings = { ...preferences, merge: preferences.merge && canMerge };
  /** 单步合入和组合交付只携带本入口允许且已勾选的收尾选项。 */
  const executionSettings: GitDeliverySettings = {
    ...settings,
    postPushCommandIds: followUps.commands ? (settings.postPushCommandIds ?? []) : [],
    finalTaskStatus: props.hasTask && followUps.taskStatus ? settings.finalTaskStatus : null,
    archiveConversation: !props.hasTask && settings.archiveConversation === true,
  };
  /** 复制成功才显示确认图标，目标变化后旧回执不再匹配。 */
  const [copiedTargetBranch, setCopiedTargetBranch] = useState<string | null>(null);
  /** 标题栏的交付设置编辑合入方式与冲突处理选项。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 后台运行与单步操作共用组合选择锁。 */
  const [combinationRunning, setCombinationRunning] = useState(false);
  /** 提供右侧操作栏中独立于表单滚动的按钮位置。 */
  const [footerHost, setFooterHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    /** 同时恢复当前项目最近接纳的收尾选项和对应勾选。 */
    const restored = readGitDeliverySettings(props.projectId, props.currentDirectory);
    setSettings(restored);
    setFollowUps({ commands: Boolean(restored.postPushCommandIds?.length), taskStatus: Boolean(restored.finalTaskStatus) });
    setSettingsOpen(false);
  }, [props.projectId, props.currentDirectory]);
  /** 两种入口都在操作期间锁定文件选择。 */
  const busy = props.busyAction !== null || combinationRunning;
  /** 单步入口明确提示当前合入方式及其仓库范围。 */
  const mergeLabel = gitDeliveryActionLabel('merge', props.zh, props.mode);
  /** 任务交付的单步合入覆盖整个工作目录。 */
  const mergeButtonLabel = props.mergeAll ? (props.zh ? `全部${mergeLabel}` : `${mergeLabel} all`) : mergeLabel;
  /** 组合选择集中在执行区，不改变上方独立动作的可用性。 */
  function combinationOption(action: 'commit' | 'merge' | 'push', label: string): ReactNode {
    return (
      <label className="git-delivery-checkbox" aria-disabled={action === 'merge' && !canMerge ? true : undefined}>
        <input
          type="checkbox"
          checked={settings[action]}
          disabled={busy || (action === 'merge' && !canMerge)}
          aria-label={props.zh ? `组合包含${label}` : `Include ${label} in combination`}
          onChange={(event) => setSettings((current) => ({ ...current, [action]: event.target.checked }))}
        />
        <span>{label}</span>
      </label>
    );
  }
  return (
    <GitDeliveryCombinationContext.Provider value={{ settings, setSettings, executionSettings, followUps, setFollowUps, canMerge, settingsOpen, setSettingsOpen, setRunning: setCombinationRunning, footerHost }}>
      {props.combination && props.settingsHost
        ? createPortal(
            <Button size="compact" disabled={busy} aria-haspopup="dialog" aria-label={props.zh ? '交付设置' : 'Delivery settings'} data-icon-tooltip={props.zh ? '交付设置' : 'Delivery settings'} onClick={() => setSettingsOpen(true)}>
              <GearSixIcon aria-hidden="true" />
            </Button>,
            props.settingsHost,
          )
        : null}
      <aside className="task-git-review-options task-git-delivery-actions">
        <div className="task-git-delivery-actions-scroll">
          <section className="task-git-delivery-action-step">
            <div className="task-git-delivery-step-heading">
              <strong>{props.zh ? '提交文件' : 'Commit files'}</strong>
              <Button
                variant={props.combination ? 'secondary' : 'primary'}
                size="compact"
                aria-label={props.zh ? `提交所选文件（${props.commitCount}）` : `Commit selected files (${props.commitCount})`}
                busy={props.busyAction === 'commit'}
                onClick={props.onCommit}
                disabled={busy || props.commitCount === 0}
              >
                {props.zh ? '提交' : 'Commit'}
                {props.commitCount > 0 ? `（${props.commitCount}）` : ''}
              </Button>
            </div>
            {props.beforeCommit}
            <div className="task-git-delivery-composer">
              {props.commitCount > 0 ? (
                <textarea
                  rows={2}
                  value={props.message}
                  onChange={(event) => props.onMessageChange(event.target.value)}
                  disabled={busy && props.busyAction !== 'commit-message'}
                  aria-label={props.zh ? '提交说明' : 'Commit message'}
                  placeholder={props.zh ? '填写提交说明…' : 'Write a commit message…'}
                />
              ) : null}
              <div className="task-git-generation-controls task-git-delivery-commit-tools">
                <Button
                  variant="secondary"
                  size="compact"
                  aria-label={props.busyAction === 'commit-message' ? (props.zh ? '停止生成提交说明' : 'Stop generating commit message') : props.zh ? 'AI 生成提交说明' : 'Generate commit message with AI'}
                  title={props.zh ? '根据勾选文件生成提交说明' : 'Generate a commit message from selected files'}
                  disabled={props.busyAction !== 'commit-message' && (busy || !props.generationClient || !props.canGenerate)}
                  onClick={props.onGenerate}
                >
                  <SparkleIcon aria-hidden="true" />
                  {props.busyAction === 'commit-message' ? (props.zh ? '停止生成' : 'Stop generating') : props.zh ? 'AI 生成' : 'AI Generate'}
                </Button>
                <GitCommitGenerationSettingsButton client={props.generationClient} projectId={props.projectId} zh={props.zh} disabled={busy} />
              </div>
            </div>
            {props.generationFeedback ? <small role="status">{props.generationFeedback}</small> : null}
            {props.commitFeedback}
          </section>
          <section className="task-git-delivery-action-step" aria-label={props.zh ? '合入' : 'Merge'}>
            <div className="task-git-delivery-step-heading">
              <strong>{props.zh ? '合入分支' : 'Merge branches'}</strong>
              <Button
                variant="secondary"
                size="compact"
                aria-label={
                  props.mergeAll
                    ? props.zh
                      ? `${mergeButtonLabel}所选目标分支（${props.mergeCount} 个仓库）`
                      : `${mergeButtonLabel} ${props.mergeCount} repositories into their selected target branches`
                    : props.zh
                      ? `${mergeButtonLabel}所选仓库（${props.mergeCount}）`
                      : `${mergeButtonLabel} selected repositories (${props.mergeCount})`
                }
                busy={props.busyAction === 'merge'}
                onClick={() => props.onMerge?.(executionSettings)}
                disabled={busy || !canMerge || props.mergeCount === 0}
              >
                {mergeButtonLabel}
                {props.mergeCount > 0 ? `（${props.mergeCount}）` : ''}
              </Button>
            </div>
            <div className="task-git-delivery-field-row">
              <span>{props.zh ? '目标分支' : 'Target'}</span>
              <div className="task-git-delivery-targets">
                {props.mergeTargets.map((target) => (
                  <div className="task-git-delivery-source-branch" key={target.repositoryId}>
                    <ZeusSelect
                      size="compact"
                      ariaLabel={`${target.label} · ${props.zh ? '合入目标分支' : 'Merge target branch'}`}
                      value={target.value}
                      options={[
                        ...(!target.value || !target.branches.includes(target.value) ? [{ value: target.value, label: target.value || (props.zh ? '选择目标分支' : 'Choose target branch'), disabled: true }] : []),
                        ...target.branches.map((branch) => ({ value: branch, label: props.mergeTargets.length > 1 ? `${target.label}: ${branch}` : branch })),
                      ]}
                      onChange={(branch) => props.onMergeTargetChange(target.repositoryId, branch)}
                      disabled={busy || !target.branches.length}
                    />
                    {target.value && props.onCopyBranch ? (
                      <Button
                        variant="secondary"
                        size="compact"
                        aria-label={copiedTargetBranch === target.value ? (props.zh ? '已复制目标分支名' : 'Target branch name copied') : props.zh ? '复制目标分支名' : 'Copy target branch name'}
                        data-icon-tooltip={props.zh ? '复制目标分支名' : 'Copy target branch name'}
                        onClick={async () => setCopiedTargetBranch((await props.onCopyBranch?.(target.value)) ? target.value : null)}
                      >
                        {copiedTargetBranch === target.value ? <CheckIcon aria-hidden="true" /> : <CopySimpleIcon aria-hidden="true" />}
                      </Button>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
            {props.mergeIssues}
            {props.mergeFeedback}
          </section>
          <section className="task-git-delivery-action-step">
            <div className="task-git-delivery-step-heading">
              <strong>{props.zh ? '推送到远端' : 'Push to remote'}</strong>
              <Button
                variant="secondary"
                size="compact"
                aria-label={props.zh ? `推送到远端（${props.pushCount}）` : `Push to remote (${props.pushCount})`}
                busy={props.busyAction === 'push'}
                onClick={props.onPush}
                disabled={busy || props.pushCount === 0}
              >
                {props.zh ? '推送' : 'Push'}
                {props.pushCount > 0 ? `（${props.pushCount}）` : ''}
              </Button>
            </div>
            {props.pushFeedback}
          </section>
          {props.combination ? (
            <section className="task-git-delivery-action-step git-delivery-workflow" aria-label={props.zh ? '组合交付' : 'Combined delivery'}>
              <strong>{props.zh ? '组合交付' : 'Combined delivery'}</strong>
              <div className="git-delivery-workflow-steps">
                {combinationOption('commit', props.zh ? '提交' : 'Commit')}
                {combinationOption('merge', props.zh ? '合入' : 'Merge')}
                {combinationOption('push', props.zh ? '推送' : 'Push')}
              </div>
              <div className="git-delivery-workflow-options">
                <label className="git-delivery-checkbox" aria-disabled={busy || !settings.commit || undefined}>
                  <input
                    type="checkbox"
                    checked={settings.generateCommitMessage}
                    disabled={busy || !settings.commit}
                    aria-label={props.zh ? '组合中 AI 生成提交说明' : 'Generate commit messages with AI in combination'}
                    onChange={(event) => setSettings((current) => ({ ...current, generateCommitMessage: event.target.checked }))}
                  />
                  <span>{props.zh ? 'AI 生成提交说明' : 'AI commit message'}</span>
                </label>
                {canMerge ? (
                  <label className="git-delivery-checkbox" aria-disabled={busy || !settings.merge || undefined}>
                    <input type="checkbox" checked={settings.resolveConflicts} disabled={busy || !settings.merge} onChange={(event) => setSettings((current) => ({ ...current, resolveConflicts: event.target.checked }))} />
                    <span>{props.zh ? 'AI 处理冲突' : 'AI conflict resolution'}</span>
                  </label>
                ) : null}
              </div>
              {props.combination}
            </section>
          ) : null}
        </div>
        {props.combination ? <footer className="git-delivery-combination-footer" ref={setFooterHost} /> : null}
      </aside>
    </GitDeliveryCombinationContext.Provider>
  );
}
import { useHoverIntent } from '../ui/useHoverIntent.js';
