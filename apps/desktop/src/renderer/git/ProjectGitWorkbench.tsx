import { formatZeusDateTime } from '@zeus/shared';
import { PushDialog } from './GitPushDialog.js';
import { GitCherryPickIcon, GitLogControls, GitToolbarMenu, gitLogRefName, initialGitLogPresentation, initialGitLogScope, readGitLogInfo, repositoryHasHistoryRef, type GitLogPresentation, type GitLogScope } from './GitLogControls.js';
import { GitHistoryDialog, type GitHistoryDialogTarget } from './GitHistoryActions.js';
import { GitChangelistDialog } from './DeliveryFileMenu.js';
import { useDeliveryChangelists } from './deliveryChangelists.js';
import { displayedFilePath } from '../ui/filePathActions.js';
import { DotsThreeIcon as DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree';
import { isMacOSPlatform } from '../platform.js';
import { GitCommitIcon as GitCommit } from '@phosphor-icons/react/dist/csr/GitCommit';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { GitMergeIcon as GitMerge } from '@phosphor-icons/react/dist/csr/GitMerge';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import {
  projectGitWorkbenchCacheEntry,
  readCachedProjectGitWorkbench,
  requestProjectGitWorkbench,
  subscribeProjectGitRefresh,
  notifyProjectGitChanged,
  unavailableGitRepositoriesNotice,
  visibleRepositoryFiles,
} from './projectGitWorkbenchState.js';
import { createProjectGitMergeAction } from './projectGitMergeAction.js';
import {
  MergeBranchDialog,
  UpdateProjectDialog,
  readUpdateStrategy,
  readSkipUpdateDialog,
  NewBranchDialog,
  RemoteBranchCheckoutDialog,
  CheckoutRevisionDialog,
  BranchDirectoryTree,
  StashDialog,
  PullDialog,
  defaultPushTarget,
} from './GitRepositoryControls.js';
import type { ProjectGitUpdateStrategy } from './gitWorkbenchTypes.js';
import type { ExecutionOutcome } from './gitWorkbenchTypes.js';
import type { BranchKind, GitBranchComparisonEditor, GitBranchComparisonTarget, GitSourceEditorTarget } from './gitWorkbenchTypes.js';
import type { OperationTone } from './gitWorkbenchTypes.js';
import type { BusyState } from './gitWorkbenchTypes.js';
import type { PushSelection } from './gitWorkbenchTypes.js';
import { MenuSurface } from '../ui/MenuSurface.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { repositoryColor } from './repositoryColor.js';
import { useGitOperationHistory } from './useGitOperationHistory.js';
import { GitContextMenu, GitMenuActionDialog, type GitMenuItem, type GitMenuConfirmation } from './GitContextMenu.js';
import { GitPaneSeparator } from './GitPaneSeparator.js';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type MouseEvent as ReactMouseEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { createPortal } from 'react-dom';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretUpIcon as CaretUp } from '@phosphor-icons/react/dist/csr/CaretUp';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/csr/Eye';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TagIcon as Tag } from '@phosphor-icons/react/dist/csr/Tag';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ProjectGitBranchComparison, ProjectGitBranchComparisonQuery, ProjectGitHistoryAction, ProjectGitLogInfo } from '@zeus/git-core';
import type { DashboardClient, GitDiffSummary, ProjectGitAction, ProjectGitCommitDetail, ProjectGitOperationRecord, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { formatVisibleApplicationError, reportApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SideBySideDiff } from './ProjectGitDiffViewer.js';

/** Git 工作区保留浏览页面，代码交付通过共用弹窗打开。 */
type GitTab = 'local' | 'shelf' | 'stash' | 'log' | 'console' | 'update';
type ChangeStage = 'staged' | 'unstaged';
interface GitContextTarget {
  kind: 'local' | 'remote' | 'tag' | 'commit' | 'stash' | 'repository';
  repositoryId: string;
  ref: string;
}

/** Compare 优先在自己的差集里定位相关提交。 */
type GitCommitNavigation = (hash: string) => Promise<boolean>;

/** 组合 Checkout 与 Rebase 固定当时的变基起点。 */
type CheckoutRebaseBase = Pick<Extract<ProjectGitAction, { type: 'checkout_rebase' }>, 'expectedBranch' | 'expectedHeadSha'>;

/** Log 翻页按仓库分别保留稳定偏移。 */
type GitLogCommit = { repository: ProjectGitRepositoryWorkbenchItem; commit: ProjectGitRepositoryWorkbenchItem['snapshot']['recentCommits'][number] };
type GitLogPosition = { offset: number; exhausted: boolean };
type GitLogPage = { key: string; entries: GitLogCommit[]; positions: Record<string, GitLogPosition>; hasMore: boolean };

/** 按 Git 动作选图标，避免依赖中英文菜单文案。 */
const gitContextActionIcons: Partial<Record<ProjectGitAction['type'], ReactNode>> = {
  apply_stash: <Archive aria-hidden="true" />,
  checkout: <GitBranch aria-hidden="true" />,
  checkout_rebase: <ArrowsClockwise aria-hidden="true" />,
  checkout_revision: <GitCommit aria-hidden="true" />,
  cherry_pick: <GitCherryPickIcon />,
  delete_branch: <Trash aria-hidden="true" />,
  delete_tag: <Trash aria-hidden="true" />,
  drop_stash: <Trash aria-hidden="true" />,
  fetch: <ArrowDown aria-hidden="true" />,
  merge: <GitMerge aria-hidden="true" />,
  push_tag: <ArrowUp aria-hidden="true" />,
  rebase: <ArrowsClockwise aria-hidden="true" />,
  revert: <ArrowCounterClockwise aria-hidden="true" />,
  update: <ArrowDown aria-hidden="true" />,
  update_branch: <ArrowDown aria-hidden="true" />,
};

/** 使用 Git 工作区的原英文操作名。 */
const integrationNames = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-Pick', revert: 'Revert' } as const;

export interface ProjectGitWorkbenchProps {
  /** 嵌入工作区提供额外工具入口。 */
  toolbarActions?: ReactNode;
  /** 主工作区的更新快捷键请求，允许 Git 尚未加载或处于收起状态。 */
  updateRequest?: number;
  /** 顶部分支菜单发起操作时展开底栏，使提交表单和操作反馈可见。 */
  onOpenPanel?(): void;
  /** 文件编辑区负责标签生命周期，Git 工作台继续提供实际菜单和仓库操作。 */
  onOpenGitEditor?(target: GitSourceEditorTarget): void;
  comparisonEditors?: readonly GitBranchComparisonEditor[];
  /** 将工作台快照同步给源码文件树，保持状态标记一致。 */
  onSnapshot?(snapshot: ProjectGitWorkbenchSnapshot | null): void;
  conversationScope?: boolean;
  project: ProjectRecord;
  client: Pick<
    DashboardClient,
    | 'loadConversationGitHistory'
    | 'loadProjectGitWorkbench'
    | 'loadProjectGitOperations'
    | 'loadProjectGitPushPreview'
    | 'loadProjectGitCommit'
    | 'loadProjectGitComparisonDiff'
    | 'executeProjectGitAction'
    | 'generateGitCommitMessage'
    | 'loadGitCommitModels'
  >;
  language: 'zh-CN' | 'en-US';
}

/** 保留同一窗口中按项目切换 Git 页面时的查看位置。 */
const projectGitViewPreferences = new Map<string, { repositoryId: string; searchQuery: string; console: { wrap: boolean; clearedAt: number } }>();

export function ProjectGitWorkbench(props: ProjectGitWorkbenchProps) {
  /** Git 操作在会话与项目工作区使用同一组英文名称。 */
  const zh = false;
  /** 快捷键只投递到当前可见工具栏，继续使用按钮原有禁用条件和操作流程。 */
  const workbenchRef = useRef<HTMLElement>(null);
  /** 数字与工具栏操作顺序对应，避开源码及全局导航的既有快捷键。 */
  const macShortcuts = isMacOSPlatform();
  /** 无障碍快捷键使用平台主键，显示提示使用常见键盘符号。 */
  const toolbarShortcut = (digit: number) => ({
    'data-git-toolbar-key': String(digit),
    'aria-keyshortcuts': `${macShortcuts ? 'Meta' : 'Control'}+Alt+${digit}`,
  });
  /** 操作名称和快捷键共同进入原悬停提示，不增加图标下方文字。 */
  const toolbarLabel = (name: string, digit: number) => `${name}（${macShortcuts ? '⌘⌥' : 'Ctrl+Alt+'}${digit}）`;
  useEffect(() => {
    /** 仅响应当前工作区；弹窗、隐藏底栏、重复按键与输入法组合不触发 Git 操作。 */
    const handleToolbarShortcut = (event: KeyboardEvent) => {
      const root = workbenchRef.current;
      if (!root || root.closest('[hidden], [inert]') || !root.getClientRects().length || event.defaultPrevented || event.repeat || event.isComposing || event.getModifierState('AltGraph')) return;
      /** 数字键优先按物理位置匹配，兼容 Option 键或键盘布局产生的不同字符。 */
      const digit = /^Digit[1-9]$/.test(event.code) ? event.code.slice(-1) : event.key;
      if (!(macShortcuts ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) || !event.altKey || event.shiftKey || !/^[1-9]$/.test(digit)) return;
      if ([...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some((dialog) => !dialog.closest('[hidden], [inert]') && dialog.getClientRects().length)) return;
      const button = root.querySelector<HTMLButtonElement>(`.git-command-toolbar button[data-git-toolbar-key="${digit}"]`);
      if (!button || button.disabled || button.closest('[inert]')) return;
      event.preventDefault();
      event.stopPropagation();
      button.click();
    };
    document.addEventListener('keydown', handleToolbarShortcut);
    return () => document.removeEventListener('keydown', handleToolbarShortcut);
  }, [macShortcuts]);
  const [snapshot, setSnapshot] = useState<ProjectGitWorkbenchSnapshot | null>(() => readCachedProjectGitWorkbench(props.client, props.project.id));
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(() => (snapshot ? 'ready' : 'loading'));
  const [error, setError] = useState<string | null>(null);
  /** 有可用快照时在原状态区域说明遗漏的仓库。 */
  const unavailableNotice = unavailableGitRepositoriesNotice(snapshot, zh);
  const [tab, setTab] = useState<GitTab>(() => (props.conversationScope ? 'log' : readRememberedTab(props.project.id)));
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(() => projectGitViewPreferences.get(props.project.id)?.repositoryId ?? '');
  /** 只有用户点选才建立提交选择，并绑定仓库，避免初始加载或换仓库产生伪选中。 */
  const [selectedCommit, setSelectedCommit] = useState<{ repositoryId: string; ref: string } | null>(null);
  const [selectedStashRef, setSelectedStashRef] = useState('');
  const [conversationDiff, setConversationDiff] = useState<{ diff: import('../apiClient.js').GitDiffSummary; preview: Extract<import('@zeus/shared').FilePreviewRequest, { kind: 'project-git' }> } | null>(null);
  const [commitDetail, setCommitDetail] = useState<ProjectGitCommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [searchQuery, setSearchQuery] = useState(() => projectGitViewPreferences.get(props.project.id)?.searchQuery ?? '');
  /** 分支筛选独立于提交历史搜索。 */
  const [branchQuery, setBranchQuery] = useState('');
  const branchSearch = useDeferredValue(branchQuery.trim().toLocaleLowerCase());
  const [operationsOpen, setOperationsOpen] = useState(false);
  /** 打开次数同时用于唤回已存在的系统窗口。 */
  const [pushOpen, setPushOpen] = useState(0);
  /** 右键 Push 只预选触发操作的本地分支。 */
  const [pushSelection, setPushSelection] = useState<PushSelection>();
  const [pullOpen, setPullOpen] = useState(false);
  const [stashRepositoryId, setStashRepositoryId] = useState<string | null>(null);
  const operationsTriggerRef = useRef<HTMLButtonElement>(null);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; title: string; items: GitMenuItem[]; anchor?: HTMLElement } | null>(null);
  const [menuConfirmation, setMenuConfirmation] = useState<GitMenuConfirmation | null>(null);
  /** Undo 复用文件交付窗口的 changelist 选择与存储。 */
  const changelists = useDeliveryChangelists(props.project.id);
  const [undoTarget, setUndoTarget] = useState<{ repository: ProjectGitRepositoryWorkbenchItem; detail: ProjectGitCommitDetail }>();
  /** Unshelve 固定用户确认时的 Shelf 引用、提交和文件集合。 */
  const [unshelveTarget, setUnshelveTarget] = useState<{ repository: ProjectGitRepositoryWorkbenchItem; entry: ProjectGitRepositoryWorkbenchItem['snapshot']['stashes'][number]; paths: string[] }>();
  /** 目标提交可能还在分页或重新筛选中，加载后再滚动并恢复焦点。 */
  const pendingLogFocus = useRef<{ repositoryId: string; hash: string } | undefined>(undefined);
  /** 需要独立选择重置模式、变基计划或历史文件的操作。 */
  const [historyDialog, setHistoryDialog] = useState<GitHistoryDialogTarget>();
  /** 每次请求都可唤回系统窗口，保留尚未确认的策略和勾选状态。 */
  const [updateOpen, setUpdateOpen] = useState(0);
  /** 同一快捷键请求只消费一次，加载期间保留最后一次请求。 */
  const handledUpdateRequest = useRef(0);
  /** 多仓库更新期间不接受第二轮更新。 */
  const updatingProject = useRef(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchBase, setNewBranchBase] = useState('');
  const [remoteCheckoutTarget, setRemoteCheckoutTarget] = useState<{ repositoryId: string; remoteRef: string; rebase?: CheckoutRebaseBase } | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  /** 工作台 Git 动作沿用原有执行状态。 */
  const [busy, setBusy] = useState<BusyState>(null);
  const actionBusyRef = useRef(false);
  /** 控制台缓存可以销毁，历史由桌面耐久账本恢复。 */
  const operationHistory = useGitOperationHistory(props.client, props.project.id);
  const [pushResults, setPushResults] = useState<Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>>([]);
  const requestVersionRef = useRef(0);
  const operationErrorsByRepositoryRef = useRef<Record<string, string>>({});

  const [subtreeDialogOpen, setSubtreeDialogOpen] = useState(false);
  const [historyRef, setHistoryRef] = useState('');
  const [logScope, setLogScope] = useState<GitLogScope>(initialGitLogScope);
  const [logPresentation, setLogPresentation] = useState<GitLogPresentation>(initialGitLogPresentation);
  /** 额外 Log 页保存各自的分支、查询和根选择。 */
  const [activeLog, setActiveLog] = useState('main');
  const [logTabs, setLogTabs] = useState<string[]>(['main']);
  const logTabViews = useRef(new Map<string, { ref: string; text: string; scope: GitLogScope }>());
  const [consoleOpen, setConsoleOpen] = useState(false);
  /** Console 一次打开只展示该窗口会话内实际执行的 Git 命令。 */
  const [consoleView, setConsoleView] = useState(() => projectGitViewPreferences.get(props.project.id)?.console ?? { wrap: false, clearedAt: performance.timeOrigin });
  useEffect(() => {
    projectGitViewPreferences.set(props.project.id, { repositoryId: selectedRepositoryId, searchQuery, console: consoleView });
  }, [props.project.id, selectedRepositoryId, searchQuery, consoleView]);
  /** 最近一次 Update 保留 Git 返回的实际起止提交。 */
  const [updateInfo, setUpdateInfo] = useState<GitUpdateInfo>();
  const updateBatch = useRef<GitUpdateInfo | undefined>(undefined);
  const [historyPage, setHistoryPage] = useState<GitLogPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyInFlight = useRef<number | null>(null);
  const historyRequest = useRef(0);
  const repositories = useMemo(() => {
    const items = snapshot?.repositories ?? [];
    return items.map((repository) => ({ ...repository, snapshot: { ...repository.snapshot, fileStatuses: visibleRepositoryFiles(repository, items) } }));
  }, [snapshot]);
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0] ?? null;
  /** 操作按钮使用当前仓库内的 Git 暂停状态。 */
  const integrationKind = selectedRepository?.snapshot.integrationState;
  /** 工作区可见时准备全项目交付窗口，与提交按钮和未提交更改行共用同一范围。 */
  const preloadCommit = useCallback(() => {
    const root = workbenchRef.current;
    if (!root || root.closest('[hidden], [inert]') || !root.getClientRects().length) return;
    void window.zeus?.openTaskGitDeliveryWindow({ projectId: props.project.id, preload: true }).catch(() => undefined);
  }, [props.project.id]);
  useEffect(() => {
    if (!repositories.length) return;
    const idle = window.requestIdleCallback(preloadCommit, { timeout: 500 });
    window.addEventListener('focus', preloadCommit);
    return () => {
      window.cancelIdleCallback(idle);
      window.removeEventListener('focus', preloadCommit);
    };
  }, [repositories.length, preloadCommit]);
  useEffect(() => {
    if (!props.updateRequest || handledUpdateRequest.current === props.updateRequest || loadState === 'loading') return;
    handledUpdateRequest.current = props.updateRequest;
    if (actionBusyRef.current || updatingProject.current) return;
    if (loadState === 'error' || !repositories.length) {
      props.onOpenPanel?.();
      return;
    }
    if (updateOpen || !readSkipUpdateDialog(props.project.id)) openUpdateDialog();
    else void updateProject(readUpdateStrategy(props.project.id));
  }, [props.updateRequest, loadState, updateOpen]);
  const stashRepository = repositories.find((repository) => repository.id === stashRepositoryId) ?? null;
  const remoteCheckoutRepository = repositories.find((repository) => repository.id === remoteCheckoutTarget?.repositoryId) ?? null;
  const activeStash = selectedRepository?.snapshot.stashes.find((stash) => stash.ref === selectedStashRef) ?? selectedRepository?.snapshot.stashes[0] ?? null;
  const activeStashRef = activeStash?.ref ?? '';
  /** 其他仓库的选择不能借用当前仓库读取详情。 */
  const selectedCommitHash = selectedCommit?.repositoryId === selectedRepository?.id ? (selectedCommit?.ref ?? '') : '';
  /** 全局提交覆盖项目内全部仓库，同名文件按所属仓库分别计数。 */
  const changedCount = repositories.reduce((total, repository) => total + new Set(repository.snapshot.fileStatuses.map((file) => file.path)).size, 0);
  const conflictCount = repositories.reduce((total, repository) => total + repository.snapshot.conflictFiles.length, 0);
  /** 分支限定名称时跳过没有该引用的根；HEAD 可在每个选中根独立比较。 */
  const hasPathScope = Object.values(logScope.paths).some((paths) => paths.length);
  const logRepositories = repositories.filter(
    (repository) => (logScope.roots === null || logScope.roots.includes(repository.id)) && (!hasPathScope || logScope.paths[repository.id]?.length) && repositoryHasHistoryRef(repository, historyRef),
  );
  const deferredSearch = useDeferredValue(searchQuery.trim());
  const historyKey = JSON.stringify([historyRef, logRepositories.map((repository) => repository.id), deferredSearch, logScope.filter, logScope.paths]);
  const historyMatches = historyPage?.key === historyKey;
  const allCommits = historyMatches ? historyPage.entries : [];
  useLayoutEffect(() => {
    const target = pendingLogFocus.current;
    if (tab !== 'log' || !target || selectedCommit?.repositoryId !== target.repositoryId || selectedCommit.ref !== target.hash) return;
    const row = workbenchRef.current?.querySelector<HTMLElement>('[data-git-log-row="' + CSS.escape(target.repositoryId + ':' + target.hash) + '"]');
    if (!row) return;
    pendingLogFocus.current = undefined;
    row.scrollIntoView({ block: 'nearest' });
    row.focus({ preventScroll: true });
  }, [tab, selectedCommit, allCommits]);

  /** 选择另外的 Log 时恢复其原过滤条件。 */
  function openLogTab(id: string): void {
    if (id !== activeLog) {
      logTabViews.current.set(activeLog, { ref: historyRef, text: searchQuery, scope: logScope });
      const view = logTabViews.current.get(id);
      setHistoryRef(view?.ref ?? '');
      setSearchQuery(view?.text ?? '');
      setLogScope(view?.scope ?? initialGitLogScope);
      setSelectedCommit(null);
      setActiveLog(id);
    }
    setTab('log');
  }

  /** 新的 Log 承接当前过滤条件，之后独立修改。 */
  function addLogTab(): void {
    const id = crypto.randomUUID();
    logTabViews.current.set(id, { ref: historyRef, text: searchQuery, scope: logScope });
    setLogTabs((tabs) => [...tabs, id]);
    openLogTab(id);
  }

  useEffect(() => {
    setSelectedStashRef('');
  }, [selectedRepository?.id]);
  useEffect(() => {
    const timer = tab === 'log' ? window.setTimeout(() => void loadHistory(false), deferredSearch ? 150 : 0) : null;
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      historyRequest.current += 1;
    };
  }, [historyKey, tab, snapshot?.refreshedAt]);

  /** 逐根读取后合并有序队列，只有已经显示的记录推进该根的偏移。 */
  async function loadHistory(append: boolean): Promise<void> {
    if (!props.conversationScope && !window.zeus?.loadProjectGitHistory) return;
    if (append && historyInFlight.current === historyRequest.current) return;
    const previous = historyPage?.key === historyKey ? historyPage : null;
    const retainedCount = !append ? (previous?.entries.length ?? 0) : 0;
    const request = ++historyRequest.current;
    historyInFlight.current = request;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const entries = append ? [...(previous?.entries ?? [])] : [];
      const positions = append ? { ...previous?.positions } : ({} as Record<string, GitLogPosition>);
      let hasMore = false;
      do {
        const pages = await Promise.all(
          logRepositories
            .filter((repository) => !positions[repository.id]?.exhausted)
            .map(async (repository) => {
              const offset = positions[repository.id]?.offset ?? 0;
              const page = props.conversationScope
                ? await props.client.loadConversationGitHistory(props.project.id, repository.id, offset, historyRef || undefined)
                : await window.zeus!.loadProjectGitHistory({
                    projectId: props.project.id,
                    repositoryId: repository.id,
                    offset,
                    ref: historyRef || undefined,
                    filters: { ...logScope.filter, text: deferredSearch, paths: logScope.paths[repository.id] },
                  });
              return { repository, offset, page, used: 0 };
            }),
        );
        if (request !== historyRequest.current) return;
        for (let index = 0; index < 200; index++) {
          const next = pages
            .filter((item) => item.used < item.page.commits.length)
            .sort((left, right) => {
              const a = left.page.commits[left.used]!;
              const b = right.page.commits[right.used]!;
              return Date.parse(b.committedAt ?? b.authoredAt) - Date.parse(a.committedAt ?? a.authoredAt);
            })[0];
          if (!next) break;
          entries.push({ repository: next.repository, commit: next.page.commits[next.used++]! });
          if (next.used === next.page.commits.length && next.page.hasMore) break;
        }
        for (const { repository, offset, page, used } of pages) positions[repository.id] = { offset: offset + used, exhausted: used === page.commits.length && !page.hasMore };
        hasMore = pages.some(({ repository }) => !positions[repository.id]?.exhausted);
      } while (!append && hasMore && entries.length < retainedCount);
      setHistoryPage({ key: historyKey, entries, positions, hasMore });
    } catch (reason) {
      if (request === historyRequest.current) setHistoryError(errorMessage(reason, zh));
    } finally {
      if (request === historyRequest.current) {
        historyInFlight.current = null;
        setHistoryLoading(false);
      }
    }
  }

  useEffect(() => {
    // 缓存仅用于首屏，进入页面和回到应用时都重新读取外部 Git 变化。
    const refresh = (force = false) => {
      if (force) projectGitWorkbenchCacheEntry(props.client, props.project.id).invalidate();
      if (document.visibilityState === 'visible' && !actionBusyRef.current) void loadWorkbench(force);
    };
    refresh();
    const unsubscribe = subscribeProjectGitRefresh(props.project.id, refresh);
    return () => {
      requestVersionRef.current += 1;
      unsubscribe();
    };
  }, [props.client, props.project.id]);

  /** 缓存和源码状态均跟随工作台快照，包括 Git 操作后的更新。 */
  useEffect(() => {
    if (snapshot?.projectId === props.project.id) {
      const cache = projectGitWorkbenchCacheEntry(props.client, props.project.id);
      if (cache.getSnapshot().value !== snapshot) cache.set(snapshot);
    }
    props.onSnapshot?.(snapshot);
  }, [props.client, props.project.id, props.onSnapshot, snapshot]);

  useEffect(() => {
    window.localStorage.setItem(`zeus.project-git-tab-v2:${props.project.id}`, tab);
  }, [props.project.id, tab]);

  useEffect(() => {
    if (props.conversationScope || tab !== 'console') return;
    void operationHistory.refresh();
    const timer = window.setInterval(() => void operationHistory.refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [tab, operationHistory.refresh, props.conversationScope]);
  useEffect(() => {
    if (!props.conversationScope && operationHistory.items.some((record) => record.commands?.some((_, index) => (record.commandDetails?.[index]?.startedAt ?? Date.parse(record.startedAt)) > consoleView.clearedAt))) {
      setConsoleOpen(true);
    }
  }, [operationHistory.items, consoleView.clearedAt, props.conversationScope]);

  useEffect(() => {
    // 新选择立即清除旧详情，避免旧行高亮在异步读取期间冒充当前选择。
    setCommitDetail(null);
    const revision = tab === 'stash' ? activeStashRef : selectedCommitHash;
    if (!selectedRepository || !revision || !['log', 'stash', 'shelf'].includes(tab)) {
      setCommitLoading(false);
      return;
    }
    let cancelled = false;
    setCommitLoading(true);
    props.client
      .loadProjectGitCommit(props.project.id, selectedRepository.id, revision)
      .then((detail) => {
        if (cancelled) return;
        setCommitDetail(detail);
        setSelectedFilePath(detail.files[0]?.path ?? '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason, zh));
      })
      .finally(() => {
        if (!cancelled) setCommitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.project.id, selectedRepository?.id, selectedCommitHash, activeStashRef, activeStash?.hash, tab]);

  async function loadWorkbench(force = false): Promise<void> {
    // 历史与仓库快照独立读取，仓库刷新失败不能伪装成没有操作记录。
    if (!props.conversationScope) void operationHistory.refresh();
    const version = ++requestVersionRef.current;
    setLoadState('loading');
    setError(null);
    try {
      const next = await requestProjectGitWorkbench(props.client, props.project.id, force);
      if (version !== requestVersionRef.current) return;
      setSnapshot(next);
      setSelectedRepositoryId((current) => (next.repositories.some((repository) => repository.id === current) ? current : (next.repositories[0]?.id ?? '')));
      setLoadState('ready');
    } catch (reason) {
      if (version !== requestVersionRef.current) return;
      setLoadState('error');
      setError(errorMessage(reason, zh));
    }
  }

  /** Git 拒绝覆盖本地文件后，用户可在同一 Checkout 目标上选择 Smart Checkout。 */
  function offerSmartCheckout(repository: ProjectGitRepositoryWorkbenchItem, action: Extract<ProjectGitAction, { type: 'checkout' | 'checkout_revision' | 'create_branch' }>): void {
    setSelectedRepositoryId(repository.id);
    setMenuConfirmation({
      title: 'Smart Checkout',
      description: repository.name + ' · Local changes would be overwritten. Git can save them before checkout and restore them afterward.',
      actionLabel: 'Smart Checkout',
      run: async () => (await execute(repository, { ...action, smart: true }, 'Smart Checkout')) !== null,
    });
  }

  /** 菜单显式请求始终允许再次选择更新方式。 */
  function openUpdateDialog(): void {
    setUpdateOpen((count) => count + 1);
  }

  /** 更新当前项目的全部仓库；失败或冲突后停止，保留原执行链的恢复入口。 */
  async function updateProject(strategy: ProjectGitUpdateStrategy): Promise<void> {
    if (actionBusyRef.current || updatingProject.current) return;
    updatingProject.current = true;
    updateBatch.current = { at: new Date().toISOString(), entries: [] };
    setUpdateOpen(0);
    try {
      for (const repository of repositories) {
        if ((await execute(repository, { type: 'update', strategy, smart: true }, zh ? '更新项目' : 'Update project')) !== 'completed') break;
      }
    } finally {
      updatingProject.current = false;
      const result = updateBatch.current;
      updateBatch.current = undefined;
      if (result?.entries.length) {
        setUpdateInfo(result);
        setTab('update');
      }
    }
  }

  /** 所有入口共用执行状态与错误反馈；源码中的操作先展开工作台。 */
  async function execute(repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string): Promise<ExecutionOutcome> {
    if (actionBusyRef.current) return null;
    props.onOpenPanel?.();
    actionBusyRef.current = true;
    requestVersionRef.current += 1;
    projectGitWorkbenchCacheEntry(props.client, props.project.id).invalidate();
    setBusy({ repositoryId: repository.id, action: action.type });
    setError(null);
    const previousOperationErrors = { ...operationErrorsByRepositoryRef.current };
    delete previousOperationErrors[repository.id];
    operationErrorsByRepositoryRef.current = previousOperationErrors;
    try {
      const response = await props.client.executeProjectGitAction(props.project.id, repository.id, action);
      setLoadState('ready');
      setSnapshot((current) =>
        current
          ? {
              ...current,
              refreshedAt: new Date().toISOString(),
              repositories: current.repositories.map((candidate) => (candidate.id === repository.id ? { ...candidate, snapshot: response.snapshot } : candidate)),
            }
          : current,
      );
      // 父仓库签出会同时更新子模块，不能保留子模块的旧分支快照。
      if (
        action.type === 'submodule_update' ||
        action.type === 'subtree' ||
        ((action.type === 'checkout' || action.type === 'checkout_revision' || action.type === 'create_branch' || action.type === 'checkout_rebase') && repository.snapshot.submodules?.some((module) => module.initialized))
      )
        await loadWorkbench(true);
      notifyProjectGitChanged(props.project.id);
      if (response.result.outcome === 'blocked') {
        if (action.type === 'checkout' || action.type === 'checkout_revision' || action.type === 'create_branch') offerSmartCheckout(repository, action);
        return null;
      }
      if (response.snapshot.integrationState) setSelectedRepositoryId(repository.id);
      if (response.result.conflictFiles.length) openDelivery(repository.id);
      if (action.type === 'update' || action.type === 'update_branch' || action.type === 'pull') {
        const range = response.result.updateRange;
        const entry = { repository, before: range?.before ?? '', after: range?.after ?? '', outcome: response.result.outcome, output: [response.result.stdout, response.result.stderr].filter(Boolean).join('\n') };
        if (updateBatch.current) updateBatch.current.entries.push(entry);
        else {
          setUpdateInfo({ at: new Date().toISOString(), entries: [entry] });
          setTab('update');
        }
      }
      if (action.type === 'history_edit' && action.operation === 'undo' && response.result.outcome === 'completed') setTab('local');
      return response.result.outcome;
    } catch (reason) {
      const message = errorMessage(reason, zh, {
        title: label,
        ...((action.type === 'checkout' || action.type === 'checkout_revision' || action.type === 'create_branch') && errorHasCode(reason, 'ZEUS_GIT_CHECKOUT_BLOCKED')
          ? {
              action: {
                label: 'Smart Checkout',
                onClick: () => offerSmartCheckout(repository, action),
              },
            }
          : {}),
      });
      operationErrorsByRepositoryRef.current = { ...operationErrorsByRepositoryRef.current, [repository.id]: message };
      if (action.type === 'update' || action.type === 'update_branch' || action.type === 'pull') {
        const entry = { repository, before: repository.snapshot.headSha, after: '', outcome: 'failed' as const, output: message };
        if (updateBatch.current) updateBatch.current.entries.push(entry);
        else {
          setUpdateInfo({ at: new Date().toISOString(), entries: [entry] });
          setTab('update');
        }
      }
      await loadWorkbench(true);
      setError(`${label}: ${message}`);
      return null;
    } finally {
      actionBusyRef.current = false;
      setBusy(null);
      if (!props.conversationScope) void operationHistory.refresh(true);
    }
  }

  /** 菜单及 F2 都重命名当前聚焦的本地分支。 */
  function openBranchRename(repository: ProjectGitRepositoryWorkbenchItem, branch: string): void {
    if (busy) return;
    setMenuConfirmation({
      title: 'Rename...',
      description: `${repository.name} · ${branch}`,
      field: 'New name',
      initialValue: branch,
      run: async (newName) => (await execute(repository, { type: 'rename_branch', branchName: branch, newName }, 'Rename Branch')) === 'completed',
    });
  }

  /** 分支入口只预选指定来源；工具栏入口继续使用当前分支。 */
  function openPush(selection?: PushSelection): void {
    setPushSelection(selection);
    setPushResults([]);
    setPushOpen((count) => count + 1);
  }

  /** 在文件编辑区按实际仓库和完整分支引用打开对比。 */
  function openBranchComparison(repository: ProjectGitRepositoryWorkbenchItem, branch: string, kind: BranchKind): void {
    const ref = `refs/${kind === 'local' ? 'heads' : 'remotes'}/${branch}`;
    props.onOpenGitEditor?.({ id: 'compare:' + JSON.stringify([props.project.id, repository.id, ref]), projectId: props.project.id, repositoryId: repository.id, repositoryName: repository.name, branch, ref });
  }

  /** 构造同一份菜单，普通分支树和提交引用的子菜单共享操作。 */
  function gitContextItems(target: GitContextTarget, resolvedDetail?: ProjectGitCommitDetail, navigate?: GitCommitNavigation): GitMenuItem[] {
    const repository = repositories.find((item) => item.id === target.repositoryId);
    if (!repository) return [];
    const copy = (text: string) => navigator.clipboard.writeText(text);
    const label = (cn: string, en: string) => (zh ? cn : en);
    const items: GitMenuItem[] = [];
    const action = (title: string, value: ProjectGitAction, confirmation?: string, danger = false, disabled = false, separatorBefore = false) =>
      items.push({
        label: title,
        icon: gitContextActionIcons[value.type],
        disabled: busy !== null || disabled,
        danger,
        separatorBefore,
        run: () => {
          if (confirmation) setMenuConfirmation({ title, description: `${repository.name} · ${target.ref}\n${confirmation}`, danger, run: async () => (await execute(repository, value, title)) === 'completed' });
          else return execute(repository, value, title).then(() => {});
        },
      });
    /** 左侧或提交右键从选中引用打开共用新分支对话框。 */
    const newBranch = (title: string, baseRef: string) =>
      items.push({
        label: title,
        icon: <GitBranch aria-hidden="true" />,
        disabled: busy !== null,
        run: () => {
          setSelectedRepositoryId(repository.id);
          setNewBranchBase(baseRef);
          setNewBranchOpen(true);
        },
      });
    if (target.kind === 'local' || target.kind === 'remote') {
      const kind = target.kind;
      const { branch, detached, headSha, branchUpstreams, upstream, remotes, integrationState } = repository.snapshot;
      const current = kind === 'local' && !detached && branch === target.ref;
      const branchRef = `refs/${kind === 'local' ? 'heads' : 'remotes'}/${target.ref}`;
      const currentLabel = detached ? 'HEAD' : branch;
      const canIntegrate = !current && !detached && !integrationState && Boolean(headSha);
      const rebaseBase = { expectedBranch: branch, expectedHeadSha: headSha };
      const checkoutRebase = `Checkout and Rebase onto '${currentLabel}'`;
      if (kind === 'local') action('Checkout', { type: 'checkout', branchName: target.ref }, undefined, false, current);
      else items.push({ icon: <GitBranch aria-hidden="true" />, label: 'Checkout', disabled: busy !== null, run: () => setRemoteCheckoutTarget({ repositoryId: repository.id, remoteRef: target.ref }) });
      newBranch(`New Branch from '${target.ref}'...`, branchRef);
      if (kind === 'local') action(checkoutRebase, { type: 'checkout_rebase', branchName: target.ref, ...rebaseBase }, 'This checks out the selected branch and rebases its commits onto the current HEAD.', true, !canIntegrate);
      else
        items.push({
          icon: <ArrowsClockwise aria-hidden="true" />,
          label: checkoutRebase,
          disabled: busy !== null || !canIntegrate,
          run: () => setRemoteCheckoutTarget({ repositoryId: repository.id, remoteRef: target.ref, rebase: rebaseBase }),
        });
      items.push({ icon: <GitDiff aria-hidden="true" />, label: `Compare with '${currentLabel}'`, separatorBefore: true, disabled: !headSha || !props.onOpenGitEditor, run: () => openBranchComparison(repository, target.ref, kind) });
      items.push({ icon: <GitDiff aria-hidden="true" />, label: 'Show Diff with Working Tree', run: () => openDiffWindow(repository, '', { comparisonRef: branchRef, comparisonMode: 'working-tree' }) });
      action(`Rebase '${currentLabel}' onto '${target.ref}'`, { type: 'rebase', branchName: branchRef, ...rebaseBase }, 'This rewrites the current branch history.', true, !canIntegrate, true);
      action(`Merge '${target.ref}' into '${currentLabel}'`, createProjectGitMergeAction(repository, branchRef), 'This may create a merge commit or conflicts.', false, !canIntegrate);
      if (kind === 'local') {
        const tracking = branchUpstreams?.[target.ref] ?? (current ? upstream : null);
        action('Update', { type: 'update_branch', branchName: target.ref, strategy: readUpdateStrategy(props.project.id) }, undefined, false, Boolean(integrationState) || !remotes.some((remote) => tracking?.startsWith(`${remote}/`)), true);
        items.push({
          icon: <ArrowUp aria-hidden="true" />,
          label: 'Push...',
          disabled: busy !== null || !remotes.length,
          run: () => openPush({ repositoryId: repository.id, sourceBranch: target.ref, ...defaultPushTarget(repository, target.ref), setUpstream: !tracking }),
        });
        items.push({ icon: <PencilSimple aria-hidden="true" />, label: 'Rename...', shortcut: 'F2', separatorBefore: true, disabled: busy !== null, run: () => openBranchRename(repository, target.ref) });
        action('Delete', { type: 'delete_branch', branchName: target.ref }, 'Git refuses to delete an unmerged local branch.', true, current);
      } else {
        const remote = [...remotes].sort((left, right) => right.length - left.length).find((name) => target.ref.startsWith(`${name}/`));
        if (remote) action('Fetch Remote', { type: 'fetch', remote }, undefined, false, false, true);
      }
      items.push({ icon: <Copy aria-hidden="true" />, label: 'Copy Branch Name', separatorBefore: true, run: () => copy(target.ref) });
    } else if (target.kind === 'commit') {
      const revision = target.ref;
      const detail = resolvedDetail ?? (commitDetail?.commit.hash === revision && selectedRepository?.id === repository.id ? commitDetail : null);
      const logged = allCommits.find((item) => item.repository.id === repository.id && item.commit.hash === revision)?.commit;
      const commit = detail?.commit ?? logged;
      const { branch, detached, headSha, integrationState } = repository.snapshot;
      const canWrite = busy === null && !detached && !integrationState && Boolean(headSha);
      const targetInHead = headSha === revision || detail?.containingBranches?.includes('refs/heads/' + branch);
      const published = detail?.containingBranches?.some((ref) => ref.startsWith('refs/remotes/')) ?? false;
      const rewriteDisabled = !canWrite || !targetInHead;
      const publishedWarning = published ? ' This rewrites commits already visible in a remote-tracking branch.' : '';
      const historyAction = (operation: ProjectGitHistoryAction['operation']): ProjectGitHistoryAction => ({ type: 'history_edit', operation, revision, expectedBranch: branch, expectedHeadSha: headSha });
      const refs = commit?.refs?.filter((ref) => ref.startsWith('refs/heads/') || ref.startsWith('refs/remotes/') || ref.startsWith('HEAD -> refs/heads/')) ?? [];
      const branchItems = [...new Set(refs)].map((ref) => {
        const name = gitLogRefName(ref);
        const kind = ref.startsWith('refs/remotes/') ? 'remote' : 'local';
        return { label: "Branch '" + name + "'", run: () => {}, children: gitContextItems({ repositoryId: repository.id, ref: name, kind }) };
      });
      items.push({ icon: <Copy aria-hidden="true" />, label: 'Copy Revision Number', shortcut: macShortcuts ? '⌥⇧⌘C' : 'Ctrl+Alt+Shift+C', run: () => copy(revision) });
      items.push({
        icon: <GitDiff aria-hidden="true" />,
        label: 'Create Patch...',
        run: async () => {
          const { patch } = await readGitLogInfo(props.project.id, repository.id, { kind: 'patch', ref: revision });
          if (!patch) throw new Error('This commit has no patch.');
          if (!window.zeus?.exportPatchToFile) throw new Error('Patch export is unavailable.');
          await window.zeus.exportPatchToFile({ fileName: revision.slice(0, 8) + '.patch', mimeType: 'text/x-patch', patchText: patch });
        },
      });
      action('Cherry-Pick', { type: 'cherry_pick', revision }, 'Apply the selected commit to ' + branch + '.', false, !canWrite || !detail || Boolean(targetInHead) || (commit?.parentHashes.length ?? 0) > 1);
      items.push({
        label: 'Checkout',
        icon: <GitBranch aria-hidden="true" />,
        separatorBefore: true,
        disabled: busy !== null,
        run: () => {},
        children: [
          {
            label: 'Checkout Revision',
            run: () =>
              setMenuConfirmation({
                title: 'Checkout Revision',
                description: 'Checkout ' + revision.slice(0, 12) + ' as detached HEAD.',
                run: async () => (await execute(repository, { type: 'checkout_revision', revision }, 'Checkout Revision')) === 'completed',
              }),
          },
          ...branchItems.map((item) => ({
            label: gitLogRefName(item.label.slice(8, -1)),
            run: () => {
              const name = item.label.slice(8, -1);
              if (repository.snapshot.localBranches.includes(name)) return execute(repository, { type: 'checkout', branchName: name }, 'Checkout').then(() => {});
              setRemoteCheckoutTarget({ repositoryId: repository.id, remoteRef: name });
            },
          })),
        ],
      });
      items.push({
        label: 'Show Repository at Revision',
        run: () => {
          if (!props.onOpenGitEditor) {
            setHistoryDialog({ kind: 'revision', repository, revision });
            return;
          }
          props.onOpenGitEditor({
            id: 'revision:' + JSON.stringify([props.project.id, repository.id, revision]),
            projectId: props.project.id,
            repositoryId: repository.id,
            repositoryName: repository.name,
            revision,
          });
        },
      });
      items.push({ label: 'Compare with Local', run: () => openDiffWindow(repository, '', { comparisonRef: revision, comparisonMode: 'working-tree' }) });
      items.push({ label: 'Reset Current Branch to Here...', separatorBefore: true, disabled: !canWrite, danger: true, run: () => setHistoryDialog({ kind: 'reset', repository, revision }) });
      action('Revert Commit', { type: 'revert', revision }, 'Create a new commit that reverses the selected commit.', false, !canWrite || Boolean(commit && commit.parentHashes.length > 1));
      items.push({ label: 'Undo Commit...', danger: true, disabled: rewriteDisabled || headSha !== revision || Boolean(commit && commit.parentHashes.length !== 1), run: () => openUndoCommit(repository, revision) });
      items.push({ label: 'Edit Commit Message...', shortcut: 'F2', separatorBefore: true, disabled: rewriteDisabled || published, run: () => openCommitMessage(repository, revision) });
      const files = repository.snapshot.fileStatuses.filter((file) => !file.path.endsWith('/')).map((file) => ({ path: file.path, checked: file.indexStatus !== ' ' && file.indexStatus !== '?' }));
      for (const [operation, title] of [
        ['fixup', 'Fixup'],
        ['squash', 'Squash Into'],
      ] as const) {
        items.push({
          label: title + '...',
          disabled: rewriteDisabled || (commit?.parentHashes.length ?? 0) > 1 || files.length === 0,
          run: () =>
            setMenuConfirmation({
              title,
              description: repository.name + ' · ' + revision.slice(0, 12) + publishedWarning,
              ...(operation === 'squash' ? { messageField: 'Commit message' } : {}),
              files,
              danger: true,
              run: async (_value, message, paths) => (await execute(repository, { ...historyAction(operation), message, paths }, title)) !== null,
            }),
        });
      }
      action('Drop Commit', historyAction('drop'), 'Remove this commit by rewriting subsequent commits on the current branch.' + publishedWarning, true, rewriteDisabled);
      items.push({ label: 'Interactively Rebase from Here...', disabled: rewriteDisabled || (commit?.parentHashes.length ?? 0) > 1, run: () => setHistoryDialog({ kind: 'interactive', repository, revision }) });
      const pushTarget = defaultPushTarget(repository);
      items.push({
        icon: <ArrowUp aria-hidden="true" />,
        label: 'Push All up to Here...',
        disabled: !canWrite || !pushTarget.remote || !targetInHead,
        run: () =>
          openPush({
            repositoryId: repository.id,
            sourceBranch: branch,
            sourceRevision: revision,
            setUpstream: false,
            ...pushTarget,
          }),
      });
      branchItems.forEach((item, index) => items.push({ ...item, separatorBefore: index === 0 }));
      newBranch('New Branch...', revision);
      items.at(-1)!.shortcut = macShortcuts ? '⌥⌘N' : 'Ctrl+Alt+N';
      items.push({
        label: 'New Tag...',
        disabled: busy !== null,
        run: () =>
          setMenuConfirmation({
            title: 'New Tag...',
            description: repository.name + ' · ' + revision.slice(0, 12),
            field: 'Tag name',
            messageField: 'Tag message',
            run: async (tagName, message) => (await execute(repository, { type: 'create_tag', tagName, revision, message }, 'New Tag')) === 'completed',
          }),
      });
      items.push({ label: 'Go to Child Commit', separatorBefore: true, shortcut: '←', run: () => navigateCommitRelation(repository, revision, 'child', undefined, navigate) });
      items.push({ label: 'Go to Parent Commit', shortcut: '→', disabled: commit?.parentHashes.length === 0, run: () => navigateCommitRelation(repository, revision, 'parent', commit?.parentHashes, navigate) });
    } else if (target.kind === 'tag') {
      const revision = target.kind === 'tag' ? `refs/tags/${target.ref}` : target.ref;
      items.push({
        icon: <GitCommit aria-hidden="true" />,
        label: label('查看提交详情', 'View commit details'),
        run: () => {
          setTab('log');
          selectCommit(repository, revision);
        },
      });
      items.push({ icon: <GitDiff aria-hidden="true" />, label: label('与当前分支比较', 'Compare with current branch'), run: () => openDiffWindow(repository, '', { comparisonRef: revision, comparisonMode: 'current' }) });
      action(
        label('反向提交…', 'Revert commit…'),
        { type: 'revert', revision },
        label('创建一个新提交，反向撤销该提交的变更；如果发生冲突，会保留现场供处理。', 'Create a new commit that reverses this commit. Conflicts remain available for resolution.'),
        true,
      );
      action(
        label('拣选到当前分支…', 'Cherry-pick commit…'),
        { type: 'cherry_pick', revision },
        label('将该提交的变更应用到当前分支，可能产生冲突。', 'Apply this commit to the current branch; conflicts may occur.'),
        false,
        repository.snapshot.detached,
      );
      action(
        label('检出此版本…', 'Checkout revision…'),
        { type: 'checkout_revision', revision },
        label('进入游离 HEAD 状态；若本地修改阻碍切换，将停止并提示，不自动贮藏。', 'Enter detached HEAD. Stop if local changes block checkout; do not auto-stash.'),
      );
      newBranch('New Branch...', revision);
      items.push({
        icon: <Plus aria-hidden="true" />,
        label: label('创建附注标签…', 'Create annotated tag…'),
        disabled: busy !== null,
        run: () =>
          setMenuConfirmation({
            title: label('创建附注标签', 'Create annotated tag'),
            description: `${repository.name} · ${revision}`,
            field: label('标签名称', 'Tag name'),
            messageField: label('标签说明（可选，默认使用标签名称）', 'Tag message (optional, defaults to tag name)'),
            run: async (tagName, message) => (await execute(repository, { type: 'create_tag', tagName, revision, message }, label('创建附注标签', 'Create annotated tag'))) === 'completed',
          }),
      });
      if (target.kind === 'tag') {
        for (const remote of repository.snapshot.remotes)
          action(
            label(`推送此标签到 ${remote}…`, `Push this tag to ${remote}…`),
            { type: 'push_tag', tagName: target.ref, remote },
            label(`仅推送标签 ${target.ref} 到 ${remote}，不会覆盖已有远程标签。`, `Push only ${target.ref} to ${remote}, without overwriting an existing remote tag.`),
          );
      }
      if (target.kind === 'tag') action(label('删除本地标签…', 'Delete local tag…'), { type: 'delete_tag', tagName: target.ref }, label('仅删除本地标签，不删除远程标签。', 'Delete the local tag only.'), true);
      items.push({ icon: <Copy aria-hidden="true" />, label: target.kind === 'tag' ? label('复制标签名', 'Copy tag name') : label('复制提交哈希', 'Copy commit hash'), run: () => copy(target.ref) });
      const commit = repository.snapshot.recentCommits.find((item) => item.hash === target.ref);
      if (commit) items.push({ icon: <Copy aria-hidden="true" />, label: label('复制提交说明', 'Copy commit message'), run: () => copy(commit.subject) });
    } else if (target.kind === 'stash') {
      action(label('应用贮藏', 'Apply stash'), { type: 'apply_stash', stashRef: target.ref });
      action(label('应用并移除贮藏…', 'Pop stash…'), { type: 'apply_stash', stashRef: target.ref, pop: true }, label('应用成功后删除该贮藏；发生冲突时保留。', 'Remove the stash after successful application; keep it on conflicts.'));
      action(label('删除贮藏…', 'Drop stash…'), { type: 'drop_stash', stashRef: target.ref }, label('将永久删除该贮藏，无法撤销。', 'Permanently delete this stash. This cannot be undone.'), true);
      items.push({ icon: <Copy aria-hidden="true" />, label: label('复制贮藏引用', 'Copy stash reference'), run: () => copy(target.ref) });
    } else {
      items.push({
        icon: <GitDiff aria-hidden="true" />,
        label: label('代码交付', 'Code delivery'),
        run: () => {
          setSelectedRepositoryId(repository.id);
          openDelivery(repository.id);
        },
      });
      items.push({
        icon: <GitCommit aria-hidden="true" />,
        label: label('查看历史', 'View history'),
        run: () => {
          setSelectedRepositoryId(repository.id);
          setTab('log');
        },
      });
      action(label('获取远程更新', 'Fetch'), { type: 'fetch' }, undefined, false, !repository.snapshot.remotes.length);
      action(
        label('拉取并合并…', 'Pull with merge…'),
        { type: 'update', strategy: 'merge', smart: true },
        label('获取并合并此仓库的远程更新。', 'Fetch and merge remote updates for this repository.'),
        false,
        !repository.snapshot.remotes.length || repository.snapshot.detached,
      );
      action(
        label('拉取并变基…', 'Pull with rebase…'),
        { type: 'update', strategy: 'rebase', smart: true },
        label('获取此仓库的远程更新，并将当前分支的本地提交变基到上游。', 'Fetch remote updates and rebase this branch onto its upstream.'),
        true,
        !repository.snapshot.remotes.length || repository.snapshot.detached,
      );
      items.push({
        icon: <ArrowUp aria-hidden="true" />,
        label: label('推送…', 'Push…'),
        disabled: busy !== null,
        run: () => {
          setSelectedRepositoryId(repository.id);
          setPushOpen((count) => count + 1);
        },
      });
      items.push({
        icon: <Archive aria-hidden="true" />,
        label: label('贮藏当前修改…', 'Stash changes…'),
        disabled: busy !== null || repository.snapshot.clean || repository.snapshot.conflictFiles.length > 0,
        run: () => {
          setSelectedRepositoryId(repository.id);
          setStashRepositoryId(repository.id);
        },
      });
      items.push({ icon: <Copy aria-hidden="true" />, label: label('复制仓库名称', 'Copy repository name'), run: () => copy(repository.name) });
    }
    return items;
  }

  /** 右键和键盘打开同一菜单，并将焦点还给触发行。 */
  function showGitContextMenu(event: ReactMouseEvent, target: GitContextTarget, navigate?: GitCommitNavigation): void {
    event.preventDefault();
    event.stopPropagation();
    const items = gitContextItems(target, undefined, navigate);
    if (!items.length) return;
    const trigger = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    const bounds = trigger?.getBoundingClientRect();
    trigger?.focus({ preventScroll: true });
    const pending = { x: event.clientX || bounds?.left || 0, y: event.clientY || bounds?.bottom || 0, title: target.ref || repositories.find((item) => item.id === target.repositoryId)?.name || 'Git', items, anchor: trigger ?? undefined };
    setContextMenu(pending);
    if (target.kind === 'commit') {
      void props.client
        .loadProjectGitCommit(props.project.id, target.repositoryId, target.ref)
        .then((detail) => {
          setContextMenu((current) => (current === pending ? { ...pending, items: gitContextItems(target, detail, navigate) } : current));
        })
        .catch((reason: unknown) => {
          setContextMenu((current) => (current === pending ? null : current));
          setError(errorMessage(reason, zh));
        });
    }
  }

  /** Log 和对比列表使用相同的提交快捷键及执行条件。 */
  function handleCommitKey(event: ReactKeyboardEvent<HTMLButtonElement>, repository: ProjectGitRepositoryWorkbenchItem, hash: string, navigate?: GitCommitNavigation): void {
    const modified = macShortcuts ? event.metaKey : event.ctrlKey;
    const action =
      event.key === 'F2'
        ? 'Edit Commit Message...'
        : event.key === 'ArrowLeft'
          ? 'Go to Child Commit'
          : event.key === 'ArrowRight'
            ? 'Go to Parent Commit'
            : modified && event.altKey && event.shiftKey && (event.code === 'KeyC' || event.key.toLowerCase() === 'c')
              ? 'Copy Revision Number'
              : modified && event.altKey && !event.shiftKey && (event.code === 'KeyN' || event.key.toLowerCase() === 'n')
                ? 'New Branch...'
                : '';
    if (!action) return;
    event.preventDefault();
    const target = { kind: 'commit' as const, repositoryId: repository.id, ref: hash };
    void (action === 'Edit Commit Message...' ? props.client.loadProjectGitCommit(props.project.id, repository.id, hash) : Promise.resolve(undefined))
      .then((detail) =>
        gitContextItems(target, detail, navigate)
          .find((item) => item.label === action && !item.disabled)
          ?.run(),
      )
      .catch((reason: unknown) => setError(errorMessage(reason, zh)));
  }

  /** 分支命名空间先于仓库，同名引用按实际所属仓库分别显示。 */
  function renderBranchGroups() {
    const groups = (
      [
        ['Local', 'localBranches', 'local', 'heads'],
        ['Remote', 'remoteBranches', 'remote', 'remotes'],
        ['Tags', 'tags', 'tag', 'tags'],
      ] as const
    ).map(([title, field, kind, namespace]) => {
      const owners = new Map<string, ProjectGitRepositoryWorkbenchItem[]>();
      for (const repository of repositories) {
        for (const ref of repository.snapshot[field]) {
          if (branchSearch && !ref.toLocaleLowerCase().includes(branchSearch)) continue;
          const previous = owners.get(ref);
          if (previous) previous.push(repository);
          else owners.set(ref, [repository]);
        }
      }
      if (branchSearch && !owners.size) return null;
      return (
        <details key={branchSearch ? kind + ':search' : kind} open={kind === 'local' || Boolean(branchSearch)}>
          <summary className="project-git-reference-section-heading">{title}</summary>
          <BranchDirectoryTree
            branches={[...owners.keys()]}
            searchQuery={branchSearch}
            current=""
            kind={kind === 'remote' ? kind : 'local'}
            zh={false}
            renderBranch={(ref, name, depth) =>
              owners.get(ref)?.map((repository, _, matches) => {
                const revision = 'refs/' + namespace + '/' + ref;
                const current = kind === 'local' && !repository.snapshot.detached && repository.snapshot.branch === ref;
                const selected = tab === 'log' && selectedRepository?.id === repository.id && historyRef === revision;
                const divergence = kind === 'local' ? (current ? repository.snapshot : repository.snapshot.branchDivergences?.[ref]) : undefined;
                const tracking = [divergence?.ahead ? '↑' + divergence.ahead : '', divergence?.behind ? '↓' + divergence.behind : ''].filter(Boolean).join(' ');
                return (
                  <Button
                    key={repository.id}
                    type="button"
                    unstyled
                    className={selected ? 'is-current' : ''}
                    data-checked-out={current || undefined}
                    aria-current={selected ? 'true' : undefined}
                    aria-keyshortcuts={kind === 'local' ? 'F2' : undefined}
                    data-icon-tooltip={repository.relativePath + ' · ' + revision}
                    style={{ paddingInlineStart: depth * 20 + 21 }}
                    onClick={() => {
                      setTab('log');
                      setLogScope((scope) => ({ ...scope, roots: [repository.id] }));
                      setHistoryRef(revision);
                      selectCommit(repository, revision);
                    }}
                    onDoubleClick={() => {
                      if (busy || kind === 'tag') return;
                      if (kind === 'remote') setRemoteCheckoutTarget({ repositoryId: repository.id, remoteRef: ref });
                      else
                        void execute(repository, { type: 'checkout', branchName: ref }, 'Checkout').then((outcome) => {
                          if (outcome !== 'completed') return;
                          setHistoryRef('');
                          setSelectedCommit(null);
                        });
                    }}
                    onContextMenu={(event) => showGitContextMenu(event, { kind, repositoryId: repository.id, ref })}
                    onKeyDown={(event) => {
                      if (kind !== 'local' || event.key !== 'F2') return;
                      event.preventDefault();
                      openBranchRename(repository, ref);
                    }}
                  >
                    {kind === 'tag' ? <Tag aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
                    <span>{name}</span>
                    {matches.length > 1 ? <small title={repository.relativePath}>{repository.name}</small> : null}
                    {current ? (
                      <small className="git-checked-out-mark" aria-label="Checked out branch">
                        ✓
                      </small>
                    ) : null}
                    {tracking ? <small className="git-tracking-badge">{tracking}</small> : null}
                  </Button>
                );
              })
            }
          />
        </details>
      );
    });
    return groups.some(Boolean) ? (
      groups
    ) : (
      <p className="git-branch-no-matches" role="status">
        No matching branches
      </p>
    );
  }

  /** 提交、分支和标签入口共用显式选择，后台刷新不再自动选中首条提交。 */
  function selectCommit(repository: ProjectGitRepositoryWorkbenchItem, commitHash: string): void {
    setSelectedRepositoryId(repository.id);
    setSelectedCommit({ repositoryId: repository.id, ref: commitHash });
  }

  /** 导航到未加载的提交时以其仓库和固定版本重新定位 Log。 */
  function jumpToLogCommit(repository: ProjectGitRepositoryWorkbenchItem, hash: string): void {
    props.onOpenPanel?.();
    if (!allCommits.some((item) => item.repository.id === repository.id && item.commit.hash === hash)) {
      setHistoryRef(hash);
      setSearchQuery('');
      setLogScope({ ...initialGitLogScope, roots: [repository.id] });
    }
    pendingLogFocus.current = { repositoryId: repository.id, hash };
    setTab('log');
    selectCommit(repository, hash);
  }

  /** 关系查询使用实际提交图，分页和筛选不会隐藏可导航的目标。 */
  async function navigateCommitRelation(repository: ProjectGitRepositoryWorkbenchItem, revision: string, direction: 'parent' | 'child', parents?: string[], navigate?: GitCommitNavigation): Promise<void> {
    const targets =
      direction === 'parent'
        ? (parents ?? (await props.client.loadProjectGitCommit(props.project.id, repository.id, revision)).commit.parentHashes)
        : ((await readGitLogInfo(props.project.id, repository.id, { kind: 'children', ref: revision })).revisions ?? []);
    if (!targets.length) throw new Error('No ' + direction + ' commit in the Git Log.');
    if (targets.length === 1) {
      if (!(await navigate?.(targets[0]!))) jumpToLogCommit(repository, targets[0]!);
      return;
    }
    setMenuConfirmation({
      title: direction === 'parent' ? 'Go to Parent Commit' : 'Go to Child Commit',
      description: repository.name + ' · ' + revision.slice(0, 12),
      field: 'Commit',
      choices: targets.map((hash) => ({ value: hash, label: hash.slice(0, 12) })),
      run: async (hash) => {
        if (!(await navigate?.(hash))) jumpToLogCommit(repository, hash);
        return true;
      },
    });
  }

  /** 读取将退回的真实文件和消息后选择已有或新建 changelist。 */
  async function openUndoCommit(repository: ProjectGitRepositoryWorkbenchItem, revision: string): Promise<void> {
    const detail = await props.client.loadProjectGitCommit(props.project.id, repository.id, revision);
    setUndoTarget({ repository, detail });
  }

  /** 与独立交付窗口使用同一个实际工作目录身份。 */
  function changelistRoot(repository: ProjectGitRepositoryWorkbenchItem): string {
    return repository.localPath ?? displayedFilePath(repository.relativePath, props.project.localPath ?? undefined);
  }

  /** 仅将本次撤销的文件移入列表，保留提交之外已有的本地修改。 */
  async function undoCommit(name: string): Promise<void> {
    if (!undoTarget) return;
    const { repository, detail } = undoTarget;
    const { branch, headSha } = repository.snapshot;
    const outcome = await execute(repository, { type: 'history_edit', operation: 'undo', revision: detail.commit.hash, expectedBranch: branch, expectedHeadSha: headSha }, 'Undo Commit');
    if (outcome !== 'completed') throw new Error('Undo Commit could not complete. See the Git operation result.');
    setUndoTarget(undefined);
    const paths = new Set(detail.files.map((file) => file.path));
    for (const file of detail.diff.fileDiffs) {
      if (file.oldPath) paths.add(file.oldPath);
      if (file.newPath) paths.add(file.newPath);
    }
    try {
      changelists.move(changelistRoot(repository), [...paths], name);
    } catch (reason) {
      setError('Commit undone. Could not save the changelist. ' + errorMessage(reason, zh));
    }
  }

  /** 重新编辑消息时加载原始正文并固定当前分支快照。 */
  async function openCommitMessage(repository: ProjectGitRepositoryWorkbenchItem, revision: string): Promise<void> {
    const detail = await props.client.loadProjectGitCommit(props.project.id, repository.id, revision);
    setMenuConfirmation({
      title: 'Edit Commit Message...',
      description: repository.name + ' · ' + detail.commit.shortHash,
      messageField: 'Commit message',
      initialMessage: detail.body || detail.commit.subject,
      danger: true,
      run: async (_value, message) =>
        (await execute(repository, { type: 'history_edit', operation: 'message', revision, message, expectedBranch: repository.snapshot.branch, expectedHeadSha: repository.snapshot.headSha }, 'Edit Commit Message')) === 'completed',
    });
  }

  /** 暂停在 Edit 时仅修改 Git 允许 amend 的当前提交及已暂存变更。 */
  async function openRebaseAmend(repository: ProjectGitRepositoryWorkbenchItem): Promise<void> {
    const { branch, headSha } = repository.snapshot;
    const { content } = await readGitLogInfo(props.project.id, repository.id, { kind: 'message', ref: headSha });
    setMenuConfirmation({
      title: 'Amend Commit...',
      description: repository.name + ' · ' + headSha.slice(0, 12),
      messageField: 'Commit message',
      initialMessage: content,
      run: async (_value, message) => (await execute(repository, { type: 'history_edit', operation: 'amend_rebase', revision: headSha, expectedBranch: branch, expectedHeadSha: headSha, message }, 'Amend Commit')) === 'completed',
    });
  }

  /** 把文件历史限制在选中的提交及实际仓库下。 */
  function openFileHistory(repository: ProjectGitRepositoryWorkbenchItem, revision: string, path: string): void {
    props.onOpenPanel?.();
    setLogScope({ ...initialGitLogScope, filter: { ...initialGitLogScope.filter, follow: true }, roots: [repository.id], paths: { [repository.id]: [path] } });
    setHistoryRef(revision);
    setSearchQuery('');
    setTab('log');
  }

  /** 一次确认选中的全部文件，Git 原子应用该选择的反向补丁。 */
  function confirmFileRevert(repository: ProjectGitRepositoryWorkbenchItem, revision: string, paths: string[]): void {
    setMenuConfirmation({
      title: 'Revert Selected Changes',
      description: paths.join('\n'),
      danger: true,
      run: async () =>
        (await execute(repository, { type: 'history_edit', operation: 'revert_file', revision, paths, expectedBranch: repository.snapshot.branch, expectedHeadSha: repository.snapshot.headSha }, 'Revert Selected Changes')) === 'completed',
    });
  }

  /** 所有变更入口直接使用既有原生交付窗口服务，工作台不挂载交付页面。 */
  function openDelivery(repositoryId?: string, pathPrefix?: string): void | Promise<unknown> {
    if (!window.zeus?.openTaskGitDeliveryWindow) {
      setError(errorMessage(new Error(zh ? '当前环境无法打开代码交付窗口。' : 'The code delivery window is unavailable in this environment.'), zh));
      return;
    }
    return window.zeus.openTaskGitDeliveryWindow(repositoryId ? { projectId: props.project.id, repositoryId, pathPrefix } : { projectId: props.project.id }).catch((reason: unknown) => setError(errorMessage(reason, zh)));
  }

  /** 全局提交与冲突入口覆盖项目内全部仓库，文件树负责后续选择。 */
  function openCommit(): void | Promise<unknown> {
    if (repositories.length) return openDelivery();
  }

  function openDiffWindow(repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }): void {
    if (props.conversationScope) {
      const request = options?.comparisonRef
        ? props.client.loadProjectGitComparisonDiff(props.project.id, repository.id, options.comparisonRef, options.comparisonMode ?? 'current')
        : options?.commitHash
          ? props.client.loadProjectGitCommit(props.project.id, repository.id, options.commitHash).then((detail) => detail.diff)
          : props.client.loadProjectGitComparisonDiff(props.project.id, repository.id, 'HEAD', options?.stage === 'staged' || options?.stage === 'unstaged' ? options.stage : 'working-tree', filePath);
      void request
        .then((diff) =>
          setConversationDiff({
            diff: { ...diff, files: [filePath], fileDiffs: diff.fileDiffs.filter((file) => file.newPath === filePath || file.oldPath === filePath) },
            preview: { kind: 'project-git', projectId: props.project.id, repositoryId: repository.id, path: filePath, ...options },
          }),
        )
        .catch((reason: unknown) => setError(errorMessage(reason, zh)));
      return;
    }
    void window.zeus?.openProjectGitDiffWindow?.({
      projectId: props.project.id,
      repositoryId: repository.id,
      filePath,
      stage: options?.stage ?? 'combined',
      ...(options?.commitHash ? { commitHash: options.commitHash } : {}),
      ...(options?.comparisonRef ? { comparisonRef: options.comparisonRef } : {}),
      ...(options?.comparisonMode ? { comparisonMode: options.comparisonMode } : {}),
    });
  }

  /** 门户将视图放进源码标签，仍使用当前 Git 实例的快照、菜单及确认弹窗。 */
  const comparisonViews = props.comparisonEditors
    ?.filter(({ target }) => target.projectId === props.project.id)
    .map(({ target, host }) => {
      const repository = repositories.find((item) => item.id === target.repositoryId);
      return createPortal(
        repository ? (
          <GitBranchComparisonView
            projectId={props.project.id}
            target={target}
            repository={repository}
            repositoryRoot={changelistRoot(repository)}
            projectName={props.project.name}
            projectRoot={props.project.localPath ?? undefined}
            busy={busy !== null}
            loadCommit={props.client.loadProjectGitCommit}
            onFileHistory={(revision, path) => openFileHistory(repository, revision, path)}
            onRevertFile={(revision, paths) => confirmFileRevert(repository, revision, paths)}
            onCommitKey={(event, hash, navigate) => handleCommitKey(event, repository, hash, navigate)}
            onCommitContext={(event, hash, navigate) => showGitContextMenu(event, { kind: 'commit', repositoryId: repository.id, ref: hash }, navigate)}
            onOpenFile={(path, commitHash) => openDiffWindow(repository, path, { commitHash })}
            onCherryPick={(detail) =>
              gitContextItems({ kind: 'commit', repositoryId: repository.id, ref: detail.commit.hash }, detail)
                .find((item) => item.label === 'Cherry-Pick' && !item.disabled)
                ?.run()
            }
          />
        ) : (
          <p className="project-git-history-status" role="alert">
            Repository is unavailable.
          </p>
        ),
        host,
        target.id,
      );
    });

  if (loadState === 'loading' && !snapshot) {
    return (
      <section className="project-git-workbench-state" aria-live="polite">
        {props.toolbarActions ? <div className="project-git-state-actions">{props.toolbarActions}</div> : null}
        <CircleNotch aria-hidden="true" className="project-git-spinner" />
        <strong>{zh ? '正在读取项目的 Git 状态' : 'Loading the project’s Git status'}</strong>
        <span>{zh ? '正在查找项目中的 Git 仓库。' : 'Finding Git repositories in this project.'}</span>
      </section>
    );
  }

  if (loadState === 'error' && !snapshot) {
    return (
      <section className="project-git-workbench-state" role="alert">
        {props.toolbarActions ? <div className="project-git-state-actions">{props.toolbarActions}</div> : null}
        <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        <Button variant="secondary" onClick={() => loadWorkbench(true)}>
          {zh ? '重新读取' : 'Reload'}
        </Button>
      </section>
    );
  }

  if (repositories.length === 0) {
    return (
      <>
        {comparisonViews}
        <section className="project-git-workbench-state">
          {props.toolbarActions ? <div className="project-git-state-actions">{props.toolbarActions}</div> : null}
          <GitBranch aria-hidden="true" />
          <strong>{zh ? '这个项目中没有发现 Git 仓库' : 'No Git repository was found'}</strong>
          <span>{zh ? '请检查项目目录是否包含 Git 仓库，然后重新扫描。' : 'Check that the project folder contains a Git repository, then scan again.'}</span>
          <Button variant="secondary" onClick={() => loadWorkbench(true)}>
            {zh ? '重新扫描' : 'Scan again'}
          </Button>
        </section>
      </>
    );
  }

  return (
    <section
      ref={workbenchRef}
      className="project-git-workbench"
      onContextMenu={(event) => {
        const element = (event.target as HTMLElement).closest<HTMLElement>('[data-git-context]');
        if (element?.dataset.gitContext) showGitContextMenu(event, JSON.parse(element.dataset.gitContext) as GitContextTarget);
      }}
      onKeyDown={(event) => {
        if (!event.currentTarget.contains(event.target as Node) || tab !== 'log' || event.key.toLowerCase() !== 'r' || !(macShortcuts ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return;
        if (event.target instanceof Element && event.target.closest('[role=dialog], [role=alertdialog]')) return;
        event.preventDefault();
        void loadWorkbench(true);
      }}
      aria-label={zh ? '项目 Git 工作台' : 'Project Git workbench'}
    >
      {comparisonViews}
      {error || unavailableNotice ? (
        <section className={error ? 'project-git-workbench-state' : 'project-git-inline-error'} role={error ? 'alert' : 'status'}>
          {error ? <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} /> : <span style={{ overflowWrap: 'anywhere' }}>{unavailableNotice}</span>}
        </section>
      ) : null}
      {busy || integrationKind ? (
        <div className="git-integration-actions">
          {' '}
          {busy && !props.conversationScope && window.zeus?.cancelProjectGitAction ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={() => {
                return window.zeus!.cancelProjectGitAction(busy.repositoryId).catch((reason: unknown) => setError(errorMessage(reason, zh)));
              }}
            >
              {zh ? '中止操作' : 'Stop operation'}
            </Button>
          ) : null}
          {selectedRepository && integrationKind ? (
            <>
              {selectedRepository.snapshot.rebaseEditHead && selectedRepository.snapshot.rebaseEditHead === selectedRepository.snapshot.headSha ? (
                <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => void openRebaseAmend(selectedRepository).catch((reason: unknown) => setError(errorMessage(reason, zh)))}>
                  Amend Commit...
                </Button>
              ) : null}
              <Button
                variant="secondary"
                size="compact"
                disabled={busy !== null || selectedRepository.snapshot.conflictFiles.length > 0}
                onClick={() => execute(selectedRepository, { type: 'continue_integration', kind: integrationKind }, 'Continue ' + integrationNames[integrationKind])}
              >
                {'Continue ' + integrationNames[integrationKind]}
              </Button>
              {integrationKind !== 'merge' && integrationKind !== 'rebase' ? (
                <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => execute(selectedRepository, { type: 'skip_integration', kind: integrationKind }, 'Skip Commit')}>
                  Skip Commit
                </Button>
              ) : null}
              <Button variant="secondary" size="compact" disabled={busy !== null} onClick={() => execute(selectedRepository, { type: 'abort_integration', kind: integrationKind }, 'Abort ' + integrationNames[integrationKind])}>
                {'Abort ' + integrationNames[integrationKind]}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}

      <MotionPresence>
        {conversationDiff ? (
          <ModalPortal role="dialog" aria-label={zh ? '文件差异' : 'File diff'} onDismiss={() => setConversationDiff(null)}>
            <section className="conversation-git-delivery">
              <header>
                <strong>{conversationDiff.preview.path}</strong>
                <Button onClick={() => setConversationDiff(null)}>{zh ? '关闭' : 'Close'}</Button>
              </header>
              <SideBySideDiff previewRequest={conversationDiff.preview} diff={conversationDiff.diff} zh={zh} fill />
            </section>
          </ModalPortal>
        ) : null}
      </MotionPresence>

      {conflictCount > 0 ? (
        <section className="project-git-conflict-banner" role="alert">
          <WarningCircle aria-hidden="true" />
          <span>
            <strong>{zh ? `存在 ${conflictCount} 个冲突文件` : `${conflictCount} conflicted files`}</strong>
            <small>{zh ? '请在代码交付弹窗逐个检查冲突，解决后暂存文件，再继续合并或变基。' : 'Review each file in Code Delivery, stage resolved files, then continue the merge or rebase.'}</small>
          </span>
          <Button variant="secondary" size="compact" onClick={openCommit}>
            {zh ? '处理冲突' : 'Resolve conflicts'}
          </Button>
        </section>
      ) : null}

      {/* 工具栏跨越整个 Git 工作区，底线与左右工作面同时衔接。 */}
      <header className="project-git-toolbar git-command-toolbar" aria-label={zh ? 'Git 工具栏' : 'Git toolbar'}>
        <strong className="git-workspace-heading">{zh ? '工作区' : 'Workspace'}</strong>
        {selectedRepository ? (
          <GitToolbarMenu
            label="Repositories"
            caption={selectedRepository.name}
            items={[
              { label: 'Repositories' },
              ...repositories.map((repository) => ({
                label: repository.relativePath === '.' ? repository.name : repository.relativePath,
                color: repositoryColor(repository.id),
                checked: selectedRepository.id === repository.id,
                run: () => {
                  setSelectedRepositoryId(repository.id);
                  setSelectedFilePath('');
                  setSelectedCommit(null);
                  setHistoryRef('');
                  setLogScope((scope) => ({ ...scope, roots: [repository.id], paths: {} }));
                },
              })),
              { label: 'Repository Actions' },
              ...gitContextItems({ kind: 'repository', repositoryId: selectedRepository.id, ref: selectedRepository.name }).map((item) => ({
                label: item.label,
                disabled: item.disabled,
                run: () => {
                  void Promise.resolve(item.run()).catch((reason: unknown) => setError(errorMessage(reason, false)));
                },
              })),
              ...(selectedRepository.snapshot.submodules?.length
                ? [
                    { label: 'Submodule Actions' },
                    ...selectedRepository.snapshot.submodules.map((module) => ({
                      label: (module.initialized ? 'Update ' : 'Initialize ') + module.path,
                      disabled: busy !== null,
                      run: () => {
                        void execute(selectedRepository, { type: 'submodule_update', path: module.path }, 'Update Submodule');
                      },
                    })),
                  ]
                : []),
              ...(selectedRepository.subtreePaths?.length ? [{ label: 'Subtrees' }, ...selectedRepository.subtreePaths.map((path) => ({ label: path, run: () => openDelivery(selectedRepository.id, path) }))] : []),
            ]}
          />
        ) : null}
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(1)}
          aria-haspopup="dialog"
          aria-label={toolbarLabel(zh ? `提交 · ${changedCount} 个待提交文件` : `Commit · ${changedCount} pending files`, 1)}
          data-icon-tooltip={toolbarLabel(zh ? `提交 · ${repositories.length} 个仓库 · ${changedCount} 个待提交文件` : `Commit · ${repositories.length} repositories · ${changedCount} pending files`, 1)}
          disabled={!selectedRepository || busy !== null}
          onPointerEnter={preloadCommit}
          onFocus={preloadCommit}
          onClick={openCommit}
        >
          <GitCommit aria-hidden="true" />
          {changedCount > 0 ? <small aria-hidden="true">{changedCount}</small> : null}
        </Button>
        <i />
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(2)}
          aria-label={toolbarLabel(zh ? '拉取' : 'Pull', 2)}
          data-icon-tooltip={toolbarLabel(zh ? '拉取' : 'Pull', 2)}
          disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || !selectedRepository.snapshot.remotes.length}
          onClick={() => setPullOpen(true)}
        >
          <ArrowDown aria-hidden="true" />
          {selectedRepository?.snapshot.behind ? <small>{selectedRepository.snapshot.behind}</small> : null}
        </Button>
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(3)}
          aria-label={toolbarLabel(zh ? '推送' : 'Push', 3)}
          data-icon-tooltip={toolbarLabel(zh ? '推送' : 'Push', 3)}
          disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || !selectedRepository.snapshot.remotes.length}
          onClick={() => openPush()}
        >
          <ArrowUp aria-hidden="true" />
          {selectedRepository?.snapshot.ahead ? <small>{selectedRepository.snapshot.ahead}</small> : null}
        </Button>
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(4)}
          aria-label={toolbarLabel(zh ? '抓取' : 'Fetch', 4)}
          data-icon-tooltip={toolbarLabel(zh ? '抓取' : 'Fetch', 4)}
          disabled={!selectedRepository || busy !== null || !selectedRepository.snapshot.remotes.length}
          onClick={() => {
            if (selectedRepository) return execute(selectedRepository, { type: 'fetch' }, zh ? '获取远端' : 'Fetch');
          }}
        >
          <ArrowsClockwise aria-hidden="true" />
        </Button>
        <i />
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(5)}
          aria-label={toolbarLabel(zh ? '分支' : 'Branch', 5)}
          data-icon-tooltip={toolbarLabel(zh ? '分支' : 'Branch', 5)}
          disabled={!selectedRepository || busy !== null}
          onClick={() => {
            setNewBranchBase('');
            setNewBranchOpen(true);
          }}
        >
          <GitBranch aria-hidden="true" />
        </Button>
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(6)}
          aria-label={toolbarLabel(zh ? '合并' : 'Merge', 6)}
          data-icon-tooltip={toolbarLabel(zh ? '合并' : 'Merge', 6)}
          disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || Boolean(selectedRepository.snapshot.integrationState)}
          onClick={() => setMergeOpen(true)}
        >
          <GitMerge aria-hidden="true" />
        </Button>
        <Button
          unstyled
          type="button"
          {...toolbarShortcut(7)}
          aria-label={toolbarLabel(zh ? '贮藏' : 'Stash', 7)}
          data-icon-tooltip={toolbarLabel(zh ? '贮藏' : 'Stash', 7)}
          disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.clean || selectedRepository.snapshot.conflictFiles.length > 0}
          onClick={() => {
            if (selectedRepository) setStashRepositoryId(selectedRepository.id);
          }}
        >
          <Archive aria-hidden="true" />
        </Button>
        <span className="project-git-menu-anchor">
          <Button
            unstyled
            ref={operationsTriggerRef}
            type="button"
            {...toolbarShortcut(8)}
            aria-label={toolbarLabel(zh ? '操作' : 'Actions', 8)}
            data-icon-tooltip={toolbarLabel(zh ? '操作' : 'Actions', 8)}
            aria-haspopup="menu"
            aria-expanded={operationsOpen}
            disabled={busy !== null}
            onClick={() => setOperationsOpen((current) => !current)}
          >
            <DotsThree aria-hidden="true" />
          </Button>
          <MotionPresence>
            {operationsOpen ? (
              <OperationsMenu
                anchor={operationsTriggerRef.current}
                zh={zh}
                onClose={() => setOperationsOpen(false)}
                onOpenCommit={openCommit}
                onOpenPush={() => setPushOpen((count) => count + 1)}
                onOpenUpdate={openUpdateDialog}
                onOpenNewBranch={() => {
                  setNewBranchBase('');
                  setNewBranchOpen(true);
                }}
                onOpenRevision={() => setRevisionOpen(true)}
                onSelectTab={setTab}
                onOpenConsole={
                  props.conversationScope
                    ? undefined
                    : () => {
                        setConsoleOpen(true);
                        setTab('console');
                      }
                }
                onOpenSubtree={() => setSubtreeDialogOpen(true)}
              />
            ) : null}
          </MotionPresence>
        </span>

        <Button unstyled type="button" {...toolbarShortcut(9)} aria-label={toolbarLabel(zh ? '刷新' : 'Refresh', 9)} data-icon-tooltip={toolbarLabel(zh ? '刷新' : 'Refresh', 9)} disabled={busy !== null} onClick={() => loadWorkbench(true)}>
          <ArrowsClockwise aria-hidden="true" />
        </Button>
        {props.toolbarActions}
      </header>
      <nav className="git-workbench-tabs" aria-label="Git views">
        <div
          role="tablist"
          aria-label="Git views"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')];
            const index = tabs.indexOf(event.target as HTMLButtonElement);
            if (index < 0) return;
            const next = tabs[(index + tabs.length + (event.key === 'ArrowRight' ? 1 : -1)) % tabs.length];
            event.preventDefault();
            next?.focus();
            next?.click();
          }}
        >
          {(['local', 'shelf', 'stash'] as const).map((name) => (
            <Button key={name} unstyled type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
              {{ local: 'Local Changes', shelf: 'Shelf', stash: 'Stash' }[name]}
            </Button>
          ))}
          {logTabs.map((id) => {
            const view = id === activeLog ? { ref: historyRef, scope: logScope } : logTabViews.current.get(id);
            return (
              <div key={id} className="git-workbench-tab-group">
                <Button unstyled type="button" role="tab" aria-selected={tab === 'log' && id === activeLog} onClick={() => openLogTab(id)}>
                  {'Log' + (view?.ref ? ': on ' + gitLogRefName(view.ref).slice(0, 64) : '') + (view?.scope.filter.me ? ' by me' : '')}
                </Button>
                {id !== 'main' ? (
                  <Button
                    unstyled
                    type="button"
                    aria-label="Close Log tab"
                    onClick={() => {
                      if (activeLog === id) openLogTab('main');
                      logTabViews.current.delete(id);
                      setLogTabs((tabs) => tabs.filter((entry) => entry !== id));
                    }}
                  >
                    <X aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
            );
          })}
          {consoleOpen ? (
            <div className="git-workbench-tab-group">
              <Button unstyled type="button" role="tab" aria-selected={tab === 'console'} onClick={() => setTab('console')}>
                Console
              </Button>
              <Button
                unstyled
                type="button"
                aria-label="Close Console"
                onClick={() => {
                  setConsoleOpen(false);
                  setConsoleView((view) => ({ ...view, clearedAt: Date.now() }));
                  if (tab === 'console') setTab('log');
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {updateInfo ? (
            <div className="git-workbench-tab-group">
              <Button unstyled type="button" role="tab" aria-selected={tab === 'update'} onClick={() => setTab('update')}>
                Update Info: {formatZeusDateTime(updateInfo.at, 'en-US')}
              </Button>
              <Button
                unstyled
                type="button"
                aria-label="Close Update Info"
                onClick={() => {
                  setUpdateInfo(undefined);
                  if (tab === 'update') setTab('log');
                }}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
        <Button unstyled type="button" aria-label="New Log Tab" data-icon-tooltip="New Log Tab" onClick={addLogTab}>
          <Plus aria-hidden="true" />
        </Button>
        <GitToolbarMenu
          label="Git Views"
          icon={<CaretDown aria-hidden="true" />}
          items={[
            { label: 'Local Changes', run: () => setTab('local') },
            { label: 'Shelf', run: () => setTab('shelf') },
            { label: 'Stash', run: () => setTab('stash') },
            { label: 'Log', run: () => openLogTab('main') },
            {
              label: 'Console',
              run: () => {
                setConsoleOpen(true);
                setTab('console');
              },
            },
            ...(updateInfo ? [{ label: 'Update Info', run: () => setTab('update') }] : []),
          ]}
        />
      </nav>
      <div className="project-git-browser-layout" data-single-pane={tab !== 'log' || undefined}>
        <aside className="project-git-navigator" aria-label={zh ? 'Git 导航' : 'Git navigation'}>
          <label className="git-branch-tree-search">
            <MagnifyingGlass aria-hidden="true" />
            <input type="search" aria-label="Search branches" placeholder="Search branches" value={branchQuery} onChange={(event) => setBranchQuery(event.currentTarget.value)} />
          </label>
          {selectedRepository ? (
            <>
              <Button
                unstyled
                type="button"
                className="git-branch-head-row"
                aria-current={tab === 'log' && historyRef === 'HEAD' ? 'true' : undefined}
                disabled={!selectedRepository.snapshot.headSha}
                onClick={() => {
                  setTab('log');
                  setHistoryRef('HEAD');
                  setLogScope((scope) => ({ ...scope, roots: [selectedRepository.id] }));
                  selectCommit(selectedRepository, 'HEAD');
                }}
              >
                <GitBranch aria-hidden="true" />
                <span>{selectedRepository.snapshot.detached ? 'HEAD (Detached)' : 'HEAD (Current Branch)'}</span>
              </Button>
              {renderBranchGroups()}
            </>
          ) : null}
        </aside>
        <GitPaneSeparator name="navigation" label={zh ? '调整 Git 导航宽度' : 'Resize Git navigation'} initial={20} min={12} max={40} />
        <div className="project-git-browser-content">
          {tab === 'log' ? (
            <GitLogControls
              key={activeLog}
              projectId={props.project.id}
              repositories={repositories}
              repository={selectedRepository}
              refName={historyRef}
              scope={logScope}
              presentation={logPresentation}
              text={searchQuery}
              onText={setSearchQuery}
              onRef={setHistoryRef}
              onScope={setLogScope}
              onPresentation={setLogPresentation}
              onRefresh={() => void loadWorkbench(true)}
              canCherryPick={Boolean(
                selectedRepository &&
                selectedCommitHash &&
                !busy &&
                selectedRepository.snapshot.headSha !== selectedCommitHash &&
                !selectedRepository.snapshot.detached &&
                !selectedRepository.snapshot.integrationState &&
                !commitDetail?.containingBranches?.includes('refs/heads/' + selectedRepository.snapshot.branch),
              )}
              onCherryPick={() => {
                if (selectedRepository)
                  return gitContextItems({ kind: 'commit', repositoryId: selectedRepository.id, ref: commitDetail?.commit.hash ?? selectedCommitHash })
                    .find((item) => item.label === 'Cherry-Pick' && !item.disabled)
                    ?.run();
              }}
              onJump={jumpToLogCommit}
              refreshShortcut={macShortcuts ? '⌘R' : 'Ctrl+R'}
            />
          ) : null}
          {tab === 'log' ? (
            <GitLogSurface
              projectId={props.project.id}
              projectName={props.project.name}
              projectRoot={props.project.localPath ?? undefined}
              zh={zh}
              repositories={repositories}
              commits={allCommits}
              refName={historyRef}
              presentation={logPresentation}
              historyLoading={historyLoading}
              historyError={historyError}
              historyHasMore={historyMatches && historyPage.hasMore}
              onLoadMore={() => loadHistory(true)}
              selectedRepository={selectedRepository}
              selectedCommitHash={commitDetail?.commit.hash ?? selectedCommitHash}
              commitDetail={commitDetail}
              commitLoading={commitLoading}
              selectedFilePath={selectedFilePath}
              onSelectCommit={selectCommit}
              onClearSelection={() => setSelectedCommit(null)}
              onOpenChanges={() => setTab('local')}
              onPreloadChanges={preloadCommit}
              onSelectFile={setSelectedFilePath}
              busy={busy !== null}
              onOpenDiff={openDiffWindow}
              onCommitKey={handleCommitKey}
              onFileHistory={openFileHistory}
              onRevertFile={confirmFileRevert}
            />
          ) : tab === 'stash' ? (
            <StashSurface
              projectId={props.project.id}
              zh={zh}
              repository={selectedRepository}
              stash={activeStash}
              onSelectStash={setSelectedStashRef}
              detail={commitDetail?.commit.hash === activeStash?.hash ? commitDetail : null}
              loading={commitLoading}
              selectedFilePath={selectedFilePath}
              busy={busy}
              onSelectFile={setSelectedFilePath}
              onOpenDiff={openDiffWindow}
              onExecute={execute}
            />
          ) : tab === 'local' ? (
            <GitLocalChangesSurface
              repositories={repositories}
              changelistName={(repository, path) => changelists.name(changelistRoot(repository), path)}
              busy={busy}
              onOpen={openDiffWindow}
              onExecute={execute}
              onCommit={openCommit}
              onShelve={(repository, paths) =>
                setMenuConfirmation({
                  title: 'Shelve Changes...',
                  description: repository.name + ' · ' + paths.length + (paths.length === 1 ? ' file' : ' files'),
                  field: 'Shelf name',
                  run: async (message) => {
                    const result = await execute(repository, { type: 'shelve', message, paths }, 'Shelve Changes');
                    if (result === 'completed') {
                      setSelectedRepositoryId(repository.id);
                      setTab('shelf');
                    }
                    return result === 'completed';
                  },
                })
              }
            />
          ) : tab === 'shelf' ? (
            <GitShelfSurface
              projectId={props.project.id}
              repositories={repositories}
              repository={selectedRepository}
              refreshedAt={snapshot?.refreshedAt ?? ''}
              busy={busy}
              onRepository={setSelectedRepositoryId}
              onUnshelve={(repository, entry, paths) => setUnshelveTarget({ repository, entry, paths })}
              onOpen={openDiffWindow}
              onDelete={(repository, entry) =>
                setMenuConfirmation({
                  title: 'Delete Shelf',
                  description: entry.subject,
                  danger: true,
                  run: async () => (await execute(repository, { type: 'delete_shelf', shelfRef: entry.ref, revision: entry.hash }, 'Delete Shelf')) === 'completed',
                })
              }
            />
          ) : tab === 'update' && updateInfo ? (
            <GitUpdateSurface projectId={props.project.id} info={updateInfo} onCommit={jumpToLogCommit} />
          ) : (
            <ConsoleSurface history={operationHistory} repositories={repositories} rootPath={props.project.localPath} view={consoleView} onView={setConsoleView} />
          )}
        </div>
      </div>

      <MotionPresence>{mergeOpen && selectedRepository ? <MergeBranchDialog repository={selectedRepository} zh={zh} busy={busy} onClose={() => setMergeOpen(false)} onExecute={execute} /> : null}</MotionPresence>
      <MotionPresence>
        {subtreeDialogOpen && selectedRepository ? <SubtreeManagementDialog key={selectedRepository.id} repository={selectedRepository} zh={zh} busy={busy} onClose={() => setSubtreeDialogOpen(false)} onExecute={execute} /> : null}
      </MotionPresence>
      <MotionPresence>{contextMenu ? <GitContextMenu {...contextMenu} onClose={() => setContextMenu(null)} onError={(reason) => setError(errorMessage(reason, zh))} /> : null}</MotionPresence>
      <MotionPresence>{menuConfirmation ? <GitMenuActionDialog key={menuConfirmation.title} value={menuConfirmation} zh={zh} onClose={() => setMenuConfirmation(null)} /> : null}</MotionPresence>
      <MotionPresence>
        {undoTarget ? (
          <GitChangelistDialog
            zh={false}
            names={changelists.names}
            title="Select Target Changelist"
            description={
              undoTarget.repository.name +
              ' · ' +
              undoTarget.detail.commit.shortHash +
              (undoTarget.detail.containingBranches?.some((ref) => ref.startsWith('refs/remotes/')) ? ' · This commit is already published. Undo moves the local branch.' : '')
            }
            suggestedName={undoTarget.detail.commit.subject}
            actionLabel="Undo Commit"
            onClose={() => setUndoTarget(undefined)}
            onMove={undoCommit}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {unshelveTarget ? (
          <GitChangelistDialog
            zh={false}
            names={changelists.names}
            title="Unshelve Changes"
            description={unshelveTarget.repository.name + ' · ' + unshelveTarget.entry.subject}
            actionLabel="Unshelve"
            optionLabel="Remove successfully applied files from the shelf"
            onClose={() => setUnshelveTarget(undefined)}
            onMove={async (name, remove) => {
              const { repository, entry, paths } = unshelveTarget;
              const outcome = await execute(repository, { type: 'unshelve', shelfRef: entry.ref, revision: entry.hash, paths, remove }, 'Unshelve');
              if (outcome === null) throw new Error('Unshelve could not complete. See the Git operation result.');
              setUnshelveTarget(undefined);
              if (outcome === 'conflict') return;
              try {
                changelists.move(changelistRoot(repository), paths, name);
              } catch (reason) {
                setError('Changes restored. Could not save the changelist. ' + errorMessage(reason, zh));
              }
            }}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {historyDialog ? (
          <GitHistoryDialog target={historyDialog} projectId={props.project.id} onClose={() => setHistoryDialog(undefined)} onExecute={async (action, title) => (await execute(historyDialog.repository, action, title)) !== null} />
        ) : null}
      </MotionPresence>
      <MotionPresence>{stashRepository ? <StashDialog key={stashRepository.id} repository={stashRepository} zh={zh} busy={busy} onClose={() => setStashRepositoryId(null)} onExecute={execute} /> : null}</MotionPresence>
      <MotionPresence>{updateOpen ? <UpdateProjectDialog key={props.project.id} projectId={props.project.id} zh={zh} activation={updateOpen} busy={busy} onClose={() => setUpdateOpen(0)} onUpdate={updateProject} /> : null}</MotionPresence>
      <MotionPresence>
        {newBranchOpen ? (
          <NewBranchDialog open={newBranchOpen} zh={zh} repositories={repositories} selectedRepository={selectedRepository} baseRef={newBranchBase} busy={busy} onClose={() => setNewBranchOpen(false)} onExecute={execute} />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {remoteCheckoutTarget && remoteCheckoutRepository ? (
          <RemoteBranchCheckoutDialog
            key={`${remoteCheckoutTarget.repositoryId}:${remoteCheckoutTarget.remoteRef}`}
            zh={zh}
            repository={remoteCheckoutRepository}
            initialRemoteRef={remoteCheckoutTarget.remoteRef}
            busy={busy}
            onClose={() => setRemoteCheckoutTarget(null)}
            onExecute={(repository, action, label) => {
              const base = remoteCheckoutTarget.rebase;
              if (base && (action.type === 'checkout' || action.type === 'create_branch')) {
                return execute(repository, { type: 'checkout_rebase', branchName: action.branchName, ...(action.type === 'create_branch' ? { baseRef: action.baseRef } : {}), ...base }, `Checkout and Rebase onto '${base.expectedBranch}'`);
              }
              return execute(repository, action, label);
            }}
          />
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {revisionOpen ? <CheckoutRevisionDialog open={revisionOpen} zh={zh} repositories={repositories} selectedRepository={selectedRepository} busy={busy} onClose={() => setRevisionOpen(false)} onExecute={execute} /> : null}
      </MotionPresence>
      <MotionPresence>{pullOpen && selectedRepository ? <PullDialog key={selectedRepository.id} repository={selectedRepository} zh={zh} busy={busy} onClose={() => setPullOpen(false)} onExecute={execute} /> : null}</MotionPresence>
      <MotionPresence>
        {pushOpen ? (
          <PushDialog
            key={pushSelection ? `${pushSelection.repositoryId}:${pushSelection.sourceBranch}:${pushSelection.sourceRevision ?? ''}` : 'current'}
            projectId={props.project.id}
            client={props.client}
            revision={snapshot?.refreshedAt ?? ''}
            open={pushOpen > 0}
            activation={pushOpen}
            zh={zh}
            repositories={repositories}
            selectedRepository={selectedRepository}
            initialSelections={pushSelection ? [pushSelection] : undefined}
            fixedTargets={Boolean(pushSelection?.sourceRevision)}
            busy={busy}
            results={pushResults}
            onClose={() => {
              setPushOpen(0);
              setPushSelection(undefined);
              setPushResults([]);
            }}
            onPush={async (selections, forceWithLease, pushTags) => {
              const results: Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }> = [];
              for (const selection of selections) {
                const repository = repositories.find((candidate) => candidate.id === selection.repositoryId)!;
                const action: ProjectGitAction = selection.sourceRevision
                  ? {
                      type: 'history_edit',
                      operation: 'push',
                      revision: selection.sourceRevision,
                      expectedBranch: selection.sourceBranch,
                      expectedHeadSha: repository.snapshot.headSha,
                      remote: selection.remote,
                      targetBranch: selection.targetBranch,
                    }
                  : { type: 'push', remote: selection.remote, sourceBranch: selection.sourceBranch, targetBranch: selection.targetBranch, setUpstream: selection.setUpstream, forceWithLease, pushAllTags: pushTags };
                const ok = await execute(repository, action, selection.sourceRevision ? 'Push All up to Here' : 'Push commits');
                results.push({
                  repositoryId: repository.id,
                  repositoryName: `${repository.name} · ${selection.sourceBranch}`,
                  tone: ok ? 'success' : 'error',
                  message: ok
                    ? zh
                      ? `已推送到 ${selection.remote}/${selection.targetBranch}`
                      : `Pushed to ${selection.remote}/${selection.targetBranch}`
                    : (operationErrorsByRepositoryRef.current[repository.id] ?? (zh ? '推送失败。' : 'Push failed.')),
                });
              }
              setPushResults(results);
            }}
          />
        ) : null}
      </MotionPresence>
    </section>
  );
}

/** 两个比较方向共用提交行和差异检查器。 */
type GitComparisonSide = 'branch' | 'head';

/** Compare 打开文件编辑区的独立标签，刷新失败时仍保留已读取的提交。 */
function GitBranchComparisonView(props: {
  projectId: string;
  projectName: string;
  projectRoot?: string;
  target: GitBranchComparisonTarget;
  repository: ProjectGitRepositoryWorkbenchItem;
  /** 提交文件路径相对于对比仓库，剪贴板沿用其真实根目录。 */
  repositoryRoot: string;
  busy: boolean;
  loadCommit: DashboardClient['loadProjectGitCommit'];
  onFileHistory: (revision: string, path: string) => void;
  onRevertFile: (revision: string, paths: string[]) => void;
  onOpenFile: (path: string, commitHash: string) => void;
  onCommitKey: (event: ReactKeyboardEvent<HTMLButtonElement>, hash: string, navigate: GitCommitNavigation) => void;
  onCommitContext: (event: ReactMouseEvent<HTMLButtonElement>, hash: string, navigate: GitCommitNavigation) => void;
  onCherryPick: (detail: ProjectGitCommitDetail) => void;
}) {
  const [snapshot, setSnapshot] = useState<{ result: ProjectGitBranchComparison; version: number }>();
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const { projectId, target } = props;
  useEffect(() => {
    let active = true;
    const request = window.zeus?.loadProjectGitBranchComparison?.({ projectId, repositoryId: target.repositoryId, query: { branchRef: target.ref, headRef: 'HEAD', branch: { sort: 'date' }, head: { sort: 'date' } } });
    if (!request) {
      setError('Branch comparison is unavailable.');
      return;
    }
    void request
      .then((result) => {
        if (active) setSnapshot({ result, version });
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, false));
      });
    return () => {
      active = false;
    };
  }, [projectId, target, version]);

  /** 快捷键和按钮更新快照，两个 Pane 的设置与选择各自保留。 */
  function refresh(): void {
    setError('');
    setVersion((current) => current + 1);
  }

  const result = snapshot?.result;
  return (
    <div
      className="git-comparison-editor"
      data-file-root={props.repositoryRoot}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key.toLowerCase() !== 'r' || !(isMacOSPlatform() ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return;
        event.preventDefault();
        refresh();
      }}
    >
      {error ? (
        <div className="project-git-history-status" role="alert">
          <span>{error}</span>
          <Button size="compact" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {snapshot && result?.branch && result.head ? (
        <div className="git-branch-comparison-layout" aria-busy={snapshot.version !== version && !error}>
          <GitComparisonPane {...props} result={result} version={snapshot.version} side="branch" initialPage={result.branch} onRefresh={refresh} />
          <GitPaneSeparator name="comparison-panes" label="Resize comparison sides" axis="y" initial={50} min={25} max={75} />
          <GitComparisonPane {...props} result={result} version={snapshot.version} side="head" initialPage={result.head} onRefresh={refresh} />
        </div>
      ) : !error ? (
        <p className="project-git-history-status" role="status">
          Loading commits...
        </p>
      ) : null}
    </div>
  );
}

/** Compare 两侧使用同一份 Log 组件、筛选、图谱和文件检查器。 */
function GitComparisonPane(
  props: Parameters<typeof GitBranchComparisonView>[0] & {
    result: ProjectGitBranchComparison;
    version: number;
    side: GitComparisonSide;
    initialPage: NonNullable<ProjectGitBranchComparison['branch']>;
    onRefresh(): void;
  },
) {
  const { projectId, repository, loadCommit, side, result, initialPage, version } = props;
  const { branchSha, headSha } = result;
  const [hash, setHash] = useState('');
  const [detail, setDetail] = useState<ProjectGitCommitDetail>();
  const [path, setPath] = useState('');
  const [detailError, setDetailError] = useState('');
  const [retry, setRetry] = useState(0);
  const [scope, setScope] = useState(initialGitLogScope);
  const [text, setText] = useState('');
  /** 定位时把键盘焦点移动到实际提交行。 */
  const [focusRequest, setFocusRequest] = useState<{ hash: string }>();
  const [presentation, setPresentation] = useState(initialGitLogPresentation);
  const query = useDeferredValue(useMemo(() => ({ ...scope.filter, text, paths: scope.paths[repository.id] }), [scope, text, repository.id]));
  const unfiltered = !(query.text?.trim() || query.authors?.length || query.me || query.since || query.until || query.paths?.length || query.sort === 'topo' || query.firstParent || query.noMerges);
  const key = JSON.stringify([version, branchSha, headSha, query]);
  const [request, setRequest] = useState<{ key: string; offset: number }>();
  const [page, setPage] = useState<{ key: string; request: typeof request; data: typeof initialPage | null; error: string }>();
  const pending = request?.key === key ? request : undefined;
  const pageData = (page?.key === key ? page.data : null) ?? (unfiltered ? initialPage : null);
  const pageError = page?.key === key ? page.error : '';
  const pageLoading = !(unfiltered && !pending) && (page?.key !== key || page.request !== pending);
  const includedSha = side === 'branch' ? branchSha : headSha;
  const excludedSha = side === 'branch' ? headSha : branchSha;
  const include = side === 'branch' ? props.target.branch : 'HEAD';
  const exclude = side === 'branch' ? 'HEAD' : props.target.branch;
  const selected = detail?.commit.hash === hash ? detail : null;
  const comparisonRepositories = useMemo(() => [repository], [repository]);
  const entries = useMemo(() => (pageData?.commits ?? []).map((commit) => ({ repository, commit })), [pageData, repository]);
  const confirmedRange = useRef({ branchSha, headSha });

  useEffect(() => {
    if (confirmedRange.current.branchSha === branchSha && confirmedRange.current.headSha === headSha) return;
    confirmedRange.current = { branchSha, headSha };
    if (!hash) return;
    let active = true;
    void readComparisonPage(projectId, repository.id, { branchRef: branchSha, headRef: headSha, [side]: { text: hash } })
      .then((next) => {
        if (active && !next[side]?.commits.some((commit) => commit.hash === hash)) {
          setHash('');
          setPath('');
          setDetailError('');
          setFocusRequest(undefined);
        }
      })
      .catch((reason: unknown) => {
        if (active) setDetailError(errorMessage(reason, false));
      });
    return () => {
      active = false;
    };
  }, [branchSha, headSha, hash, projectId, repository.id, side]);

  useEffect(() => {
    if (!hash) return;
    let active = true;
    void loadCommit(projectId, repository.id, hash)
      .then((next) => {
        if (!active) return;
        setPath((current) => (next.files.some((file) => file.path === current) ? current : (next.files[0]?.path ?? '')));
        setDetail(next);
      })
      .catch((reason: unknown) => {
        if (active) setDetailError(errorMessage(reason, false));
      });
    return () => {
      active = false;
    };
  }, [projectId, repository.id, loadCommit, hash, retry]);

  useEffect(() => {
    if (unfiltered && !pending) return;
    let active = true;
    const offset = pending?.offset ?? 0;
    const timer = window.setTimeout(
      () => {
        const range: ProjectGitBranchComparisonQuery = { branchRef: branchSha, headRef: headSha, [side]: { ...query, offset } };
        void readComparisonPage(projectId, repository.id, range)
          .then((next) => {
            if (!active || !next[side]) return;
            const data = next[side];
            setPage((previous) => {
              const earlier = (previous?.key === key ? previous.data : null) ?? initialPage;
              return { key, request: pending, error: '', data: offset ? { ...data, commits: [...earlier.commits, ...data.commits] } : data };
            });
          })
          .catch((reason: unknown) => {
            if (active) setPage((previous) => ({ key, request: pending, error: errorMessage(reason, false), data: previous?.key === key ? previous.data : null }));
          });
      },
      pending ? 0 : 160,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [branchSha, headSha, initialPage, key, pending, projectId, query, repository.id, side, unfiltered]);

  /** 选择下一条提交时清除上一条的文件焦点和错误。 */
  function selectHash(next: string): void {
    if (next === hash) return;
    setDetailError('');
    setPath('');
    setHash(next);
  }

  /** 使用当前筛选验证提交属于这一侧，翻页未加载时定位到完整哈希。 */
  async function locateCommit(revision: string): Promise<boolean> {
    if (!entries.some((entry) => entry.commit.hash === revision)) {
      const next = await readComparisonPage(projectId, repository.id, { branchRef: branchSha, headRef: headSha, [side]: { ...query, regex: false, text: revision } });
      if (!next[side]?.commits.some((commit) => commit.hash === revision)) return false;
      setScope({ ...scope, filter: { ...scope.filter, regex: false } });
      setText(revision);
    }
    selectHash(revision);
    setFocusRequest({ hash: revision });
    return true;
  }

  const canCherryPick = Boolean(
    selected &&
    side === 'branch' &&
    !props.busy &&
    !repository.snapshot.detached &&
    !repository.snapshot.integrationState &&
    selected.commit.parentHashes.length <= 1 &&
    selected.commit.hash !== repository.snapshot.headSha &&
    !selected.containingBranches?.includes('refs/heads/' + repository.snapshot.branch),
  );
  return (
    <section className="git-branch-comparison-pane" aria-label={'Commits only in ' + include}>
      <GitLogSurface
        projectId={projectId}
        projectName={props.projectName}
        projectRoot={props.projectRoot}
        zh={false}
        repositories={comparisonRepositories}
        commits={entries}
        refName={includedSha}
        presentation={presentation}
        historyLoading={pageLoading}
        historyError={pageError}
        historyHasMore={Boolean(pageData?.hasMore)}
        onLoadMore={() => {
          if (!pageLoading) setRequest({ key, offset: pageData?.commits.length ?? 0 });
        }}
        selectedRepository={repository}
        selectedCommitHash={hash}
        commitDetail={selected}
        commitLoading={Boolean(hash && !selected && !detailError)}
        selectedFilePath={path}
        onSelectCommit={(_, hash) => {
          setFocusRequest(undefined);
          selectHash(hash);
        }}
        onClearSelection={() => selectHash('')}
        onSelectFile={setPath}
        busy={props.busy || Boolean(repository.snapshot.integrationState)}
        onOpenDiff={(_, file, options) => {
          if (options?.commitHash) props.onOpenFile(file, options.commitHash);
        }}
        onCommitKey={(event, _, hash) => props.onCommitKey(event, hash, locateCommit)}
        onCommitContext={(event, hash) => props.onCommitContext(event, hash, locateCommit)}
        onFileHistory={(_, revision, file) => props.onFileHistory(revision, file)}
        onRevertFile={(_, revision, paths) => props.onRevertFile(revision, paths)}
        comparison={{ emptyText: unfiltered ? exclude + ' contains all commits from ' + include : 'No matching commits', excludedSha, currentSide: side === 'head', focusRequest }}
        detailError={
          detailError
            ? {
                message: detailError,
                retry: () => {
                  setDetailError('');
                  setRetry((current) => current + 1);
                },
              }
            : undefined
        }
        header={
          <>
            <GitLogControls
              projectId={projectId}
              repositories={comparisonRepositories}
              repository={repository}
              refName={includedSha}
              excludedRef={excludedSha}
              fixedRange
              scope={scope}
              onScope={setScope}
              text={text}
              onText={setText}
              presentation={presentation}
              onPresentation={setPresentation}
              onRefresh={props.onRefresh}
              refreshShortcut={isMacOSPlatform() ? '⌘R' : 'Ctrl+R'}
              canCherryPick={canCherryPick}
              onCherryPick={() => {
                if (canCherryPick && selected) props.onCherryPick(selected);
              }}
              onJump={async (_, hash) => {
                if (!(await locateCommit(hash))) throw new Error('The commit is outside this comparison side or its active filters.');
              }}
            />
            <header className="git-branch-comparison-caption" title={'Commits only in ' + include + ', compared with ' + exclude}>
              <span>
                Commits only in <strong>{include}</strong>
              </span>
            </header>
          </>
        }
      />
    </section>
  );
}

/** 编辑区的分页、定位和刷新均读取同一个 Git 比较接口。 */
function readComparisonPage(projectId: string, repositoryId: string, query: ProjectGitBranchComparisonQuery): Promise<ProjectGitBranchComparison> {
  return window.zeus?.loadProjectGitBranchComparison?.({ projectId, repositoryId, query }) ?? Promise.reject(new Error('Branch comparison is unavailable.'));
}

/** 提交行与图形共享像素高度。 */
const gitHistoryRowHeight = 28;

/** Log 逐根合并 Git 顺序，图谱行、选择和文件检查器引用相同提交身份。 */
function GitLogSurface(props: {
  projectId: string;
  projectName: string;
  projectRoot?: string;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  commits: GitLogCommit[];
  refName: string;
  presentation: GitLogPresentation;
  historyLoading: boolean;
  historyError: string;
  historyHasMore: boolean;
  onLoadMore: () => void;
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  selectedCommitHash: string;
  commitDetail: ProjectGitCommitDetail | null;
  commitLoading: boolean;
  selectedFilePath: string;
  onSelectCommit: (repository: ProjectGitRepositoryWorkbenchItem, commitHash: string) => void;
  onClearSelection: () => void;
  onOpenChanges?: () => void;
  onPreloadChanges?: () => void;
  onSelectFile: (path: string) => void;
  busy: boolean;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { commitHash?: string }) => void;
  onCommitKey: (event: ReactKeyboardEvent<HTMLButtonElement>, repository: ProjectGitRepositoryWorkbenchItem, hash: string) => void;
  onCommitContext?: (event: ReactMouseEvent<HTMLButtonElement>, hash: string) => void;
  onFileHistory: (repository: ProjectGitRepositoryWorkbenchItem, revision: string, path: string) => void;
  onRevertFile: (repository: ProjectGitRepositoryWorkbenchItem, revision: string, paths: string[]) => void;
  /** Compare 提供固定差集和同侧的工具栏。 */
  comparison?: { emptyText: string; excludedSha: string; currentSide: boolean; focusRequest?: { hash: string } };
  header?: ReactNode;
  detailError?: { message: string; retry: () => void };
}) {
  const historyScroll = useRef<HTMLDivElement>(null);
  const historySentinel = useRef<HTMLDivElement>(null);
  const positioned = useRef('');
  /** 每次定位只移动一次焦点，后续分页和筛选可继续操作工具栏。 */
  const lastFocusRequest = useRef<{ hash: string } | undefined>(undefined);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const presentation = props.presentation;
  const [emails, setEmails] = useState<Record<string, string>>({});
  const [cherry, setCherry] = useState<Record<string, string[]>>({});
  /** 当前作者和等价补丁按仓库读取，不从姓名或提交标题推断。 */
  useEffect(() => {
    let active = true;
    void Promise.all(
      props.repositories.map(async (repository) => {
        const [identity, picked] = await Promise.all([
          presentation.myCommits ? readGitLogInfo(props.projectId, repository.id, { kind: 'identity' }).catch(() => null) : null,
          presentation.notCherryPicked && props.refName && repositoryHasHistoryRef(repository, props.refName)
            ? readGitLogInfo(props.projectId, repository.id, { kind: 'cherry', ref: props.refName, before: props.comparison?.excludedSha }).catch(() => null)
            : null,
        ]);
        return { id: repository.id, identity: identity?.email, revisions: picked?.revisions };
      }),
    ).then((result) => {
      if (!active) return;
      setEmails(Object.fromEntries(result.flatMap((entry) => (entry.identity ? [[entry.id, entry.identity.toLowerCase()]] : []))));
      setCherry(Object.fromEntries(result.flatMap((entry) => (entry.revisions ? [[entry.id, entry.revisions]] : []))));
    });
    return () => {
      active = false;
    };
  }, [props.projectId, props.repositories, props.refName, props.comparison?.excludedSha, presentation.myCommits, presentation.notCherryPicked]);
  useEffect(() => {
    setExpanded([]);
    setCollapsed([]);
  }, [presentation.foldRevision]);
  useEffect(() => {
    if (!historyScroll.current || !historySentinel.current || props.historyLoading || props.historyError || !props.historyHasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) props.onLoadMore();
      },
      { root: historyScroll.current, rootMargin: '0px 0px 160px 0px' },
    );
    observer.observe(historySentinel.current);
    return () => observer.disconnect();
  }, [props.historyLoading, props.historyError, props.historyHasMore, props.onLoadMore]);
  const selectedIdentity = (props.selectedRepository?.id ?? '') + ':' + props.selectedCommitHash;
  const rows = useMemo(() => logGraphRows(props.commits, presentation.collapsed, expanded, collapsed, selectedIdentity), [props.commits, presentation.collapsed, expanded, collapsed, selectedIdentity]);
  useLayoutEffect(() => {
    const request = props.comparison?.focusRequest;
    const focus = request && request !== lastFocusRequest.current && request.hash === props.selectedCommitHash;
    if (!focus && positioned.current === selectedIdentity) return;
    const row = historyScroll.current?.querySelector<HTMLElement>('[data-git-log-row="' + CSS.escape(selectedIdentity) + '"]');
    if (!row) return;
    positioned.current = selectedIdentity;
    row.scrollIntoView({ block: 'nearest' });
    if (focus) {
      lastFocusRequest.current = request;
      row.focus({ preventScroll: true });
    }
  }, [rows, selectedIdentity, props.comparison?.focusRequest, props.selectedCommitHash]);
  const columns = { gridTemplateColumns: ['minmax(160px, 1fr)', ...(presentation.hash ? ['72px'] : []), ...(presentation.author ? ['minmax(90px, 16%)'] : []), ...(presentation.date ? ['96px'] : [])].join(' ') };
  const graph = useMemo(
    () =>
      rows.map(({ repository, commit, hidden }) => ({
        ...commit,
        hash: repository.id + ':' + commit.hash,
        parentHashes: (hidden?.at(-1)?.commit.parentHashes ?? commit.parentHashes).map((hash) => repository.id + ':' + hash),
      })),
    [rows],
  );
  const folded = useMemo(() => new Set(rows.flatMap((row) => (row.hidden ? [row.repository.id + ':' + row.commit.hash] : []))), [rows]);
  const reachable = useMemo(() => {
    const current = new Set(props.repositories.map((repository) => repository.id + ':' + repository.snapshot.headSha));
    for (const { repository, commit } of props.commits) {
      if (!current.has(repository.id + ':' + commit.hash)) continue;
      for (const parent of commit.parentHashes) current.add(repository.id + ':' + parent);
    }
    return current;
  }, [props.commits, props.repositories]);
  const repository = props.selectedRepository;
  const detail = props.commitDetail;
  return (
    <div className="project-git-log-layout" style={{ '--git-history-row-height': gitHistoryRowHeight + 'px' } as React.CSSProperties}>
      <main className="project-git-commit-list">
        {props.header}
        {!props.comparison ? (
          <header className="project-git-list-header" style={columns}>
            <span className="git-history-graph-heading">Graph</span>
            <span>Description</span>
            {presentation.hash ? <span>Commit</span> : null}
            {presentation.author ? <span>Author</span> : null}
            {presentation.date ? <span>Date</span> : null}
          </header>
        ) : null}
        {props.onOpenChanges && repository?.snapshot.fileStatuses.length ? (
          <Button unstyled type="button" className="project-git-commit-row git-working-copy-row" style={columns} onPointerEnter={props.onPreloadChanges} onFocus={props.onPreloadChanges} onClick={props.onOpenChanges}>
            <strong>Local Changes · {repository.snapshot.fileStatuses.length}</strong>
          </Button>
        ) : null}
        <div className="project-git-commit-scroll" ref={historyScroll}>
          <CommitGraph commits={graph} showLongEdges={presentation.longEdges} folded={folded} />
          <div className="project-git-commit-rows">
            {!rows.length && !props.historyLoading && !props.historyError ? (
              <p className="project-git-empty-copy" role="status">
                {props.comparison?.emptyText ?? 'No matching commits'}
              </p>
            ) : null}
            {rows.map(({ repository, commit, hidden, foldId }) => {
              const identity = repository.id + ':' + commit.hash;
              const selected = identity === selectedIdentity;
              const when = presentation.commitTimestamp ? (commit.committedAt ?? commit.authoredAt) : commit.authoredAt;
              const refs = [
                ...new Set(
                  (commit.refs ?? (commit.hash === repository.snapshot.headSha ? ['HEAD'] : []))
                    .filter((ref) => /^(HEAD|refs\/(?:heads|remotes|tags)|tag: )/u.test(ref))
                    .map((ref) => ({ name: gitLogRefName(ref), tag: ref.startsWith('tag:') }))
                    .map(({ name, tag }) => (tag && !presentation.tagNames ? '◇' : name)),
                ),
              ];
              const labels = refs.length ? (
                <span className="git-history-ref" aria-label={refs.join(', ')} data-icon-tooltip={refs.join(', ')}>
                  <GitBranch aria-hidden="true" />
                  {presentation.compactRefs ? refs[0] + (refs.length > 1 ? ' +' + (refs.length - 1) : '') : refs.join(', ')}
                </span>
              ) : null;
              if (hidden)
                return (
                  <Button
                    key={identity}
                    unstyled
                    type="button"
                    className="project-git-commit-row git-log-fold"
                    style={columns}
                    onClick={() => {
                      setExpanded((previous) => [...previous, foldId!]);
                      setCollapsed((previous) => previous.filter((id) => id !== foldId));
                    }}
                  >
                    … {hidden.length} commits
                  </Button>
                );
              return (
                <Button
                  key={identity}
                  unstyled
                  type="button"
                  data-git-log-row={identity}
                  aria-pressed={selected}
                  data-git-context={JSON.stringify({ kind: 'commit', repositoryId: repository.id, ref: commit.hash })}
                  data-current-branch={(presentation.currentHighlight && (props.comparison ? props.comparison.currentSide : reachable.has(identity))) || undefined}
                  data-merge-commit={(presentation.mergeHighlight && commit.parentHashes.length > 1) || undefined}
                  data-own-commit={(presentation.myCommits && Boolean(commit.authorEmail) && emails[repository.id] === commit.authorEmail?.toLowerCase()) || undefined}
                  data-not-cherry-picked={(presentation.notCherryPicked && cherry[repository.id]?.includes(commit.hash)) || undefined}
                  className={'project-git-commit-row' + (selected ? ' is-current' : '')}
                  style={{ ...columns, borderInlineStart: props.repositories.length > 1 ? '2px solid ' + repositoryColor(repository.id) : undefined }}
                  onClick={() => props.onSelectCommit(repository, commit.hash)}
                  onDoubleClick={() => {
                    if (foldId) {
                      props.onClearSelection();
                      setExpanded((previous) => previous.filter((id) => id !== foldId));
                      setCollapsed((previous) => [...previous, foldId]);
                    }
                  }}
                  onKeyDown={(event) => props.onCommitKey(event, repository, commit.hash)}
                  onContextMenu={props.onCommitContext ? (event) => props.onCommitContext?.(event, commit.hash) : undefined}
                >
                  <span className="project-git-commit-subject" data-icon-tooltip={commit.subject}>
                    {presentation.rootNames ? <small>{repository.name}</small> : null}
                    {presentation.refsOnLeft ? labels : null}
                    <strong>{commit.subject}</strong>
                    {!presentation.refsOnLeft ? labels : null}
                  </span>
                  {presentation.hash ? <code data-icon-tooltip={commit.hash}>{commit.shortHash}</code> : null}
                  {presentation.author ? <span data-icon-tooltip={commit.authorEmail ?? commit.author}>{commit.author}</span> : null}
                  {presentation.date ? (
                    <time dateTime={when} data-icon-tooltip={formatZeusDateTime(when, 'en-US')}>
                      {formatRelativeTime(when, props.zh)}
                    </time>
                  ) : null}
                </Button>
              );
            })}
            <div ref={historySentinel} role="status" className="project-git-history-status">
              {props.historyError ? (
                <>
                  <span>{props.historyError}</span>
                  <Button size="compact" variant="secondary" onClick={props.onLoadMore}>
                    Retry
                  </Button>
                </>
              ) : props.historyLoading ? (
                'Loading commits...'
              ) : props.historyHasMore ? (
                <Button size="compact" variant="secondary" onClick={props.onLoadMore}>
                  Load More
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </main>
      <GitPaneSeparator name="history-columns" label="Resize history and changed files" initial={65} min={35} max={80} />
      {props.detailError ? (
        <aside className="project-git-inspector git-comparison-detail-error" role="alert">
          {props.detailError.message}{' '}
          <Button size="compact" onClick={props.detailError.retry}>
            Retry
          </Button>
        </aside>
      ) : (
        <GitCommitInspector
          projectId={props.projectId}
          projectName={props.projectName}
          projectRoot={props.projectRoot}
          repository={repository}
          detail={detail}
          loading={props.commitLoading}
          path={props.selectedFilePath}
          busy={props.busy}
          onSelect={props.onSelectFile}
          onOpen={(path) => {
            if (detail && repository) props.onOpenDiff(repository, path, { commitHash: detail.commit.hash });
          }}
          onHistory={(path) => {
            if (detail && repository) props.onFileHistory(repository, detail.commit.hash, path);
          }}
          onRevert={(paths) => {
            if (detail && repository) props.onRevertFile(repository, detail.commit.hash, paths);
          }}
        />
      )}
    </div>
  );
}

/** 连续首父链在没有引用、合流或跨仓范围时可收起。 */
function logGraphRows(commits: GitLogCommit[], collapseAll: boolean, expanded: string[], collapsed: string[], selected: string): Array<GitLogCommit & { hidden?: GitLogCommit[]; foldId?: string }> {
  const children = new Map<string, number>();
  for (const { repository, commit } of commits)
    for (const parent of commit.parentHashes) {
      const key = repository.id + ':' + parent;
      children.set(key, (children.get(key) ?? 0) + 1);
    }
  const rows: Array<GitLogCommit & { hidden?: GitLogCommit[]; foldId?: string }> = [];
  for (let start = 0; start < commits.length;) {
    const first = commits[start]!;
    let end = start;
    while (end + 1 < commits.length) {
      const current = commits[end]!;
      const next = commits[end + 1]!;
      if (
        current.repository.id !== next.repository.id ||
        current.commit.refs?.length ||
        next.commit.refs?.length ||
        current.commit.parentHashes.length !== 1 ||
        current.commit.parentHashes[0] !== next.commit.hash ||
        (children.get(next.repository.id + ':' + next.commit.hash) ?? 0) > 1
      )
        break;
      end++;
    }
    const foldId = end - start >= 3 ? first.repository.id + ':' + first.commit.hash : undefined;
    const chain = commits.slice(start, end + 1);
    const hide = foldId && !expanded.includes(foldId) && (collapseAll || collapsed.includes(foldId)) && !chain.some(({ repository, commit }) => repository.id + ':' + commit.hash === selected);
    if (hide) rows.push({ ...first, hidden: chain, foldId });
    else for (const commit of chain) rows.push({ ...commit, foldId });
    start = end + 1;
  }
  return rows;
}

/** 文件操作与提交元数据共用当前选中的不可变提交。 */
function GitCommitInspector(props: {
  projectId: string;
  projectName: string;
  projectRoot?: string;
  repository: ProjectGitRepositoryWorkbenchItem | null;
  detail: ProjectGitCommitDetail | null;
  loading: boolean;
  path: string;
  busy: boolean;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onHistory: (path: string) => void;
  onRevert: (paths: string[]) => void;
}) {
  const [directories, setDirectories] = useState(true);
  const [modules, setModules] = useState(true);
  const [showDetails, setShowDetails] = useState(true);
  const [preview, setPreview] = useState(false);
  /** 展开分支归属始终针对当前提交。 */
  const [expandedBranches, setExpandedBranches] = useState<ProjectGitCommitDetail>();
  const files = useRef<HTMLDivElement>(null);
  /** 多选属于当前提交。主选文件仍控制 Diff 和文件历史。 */
  const [selection, setSelection] = useState<{ detail: ProjectGitCommitDetail; anchor: string; paths: string[] }>();
  const { repository, detail, path } = props;
  if (!repository || !detail || props.loading)
    return (
      <aside className="project-git-inspector">
        <p className="project-git-empty-copy" role="status">
          {props.loading ? 'Loading commit...' : 'Select a commit to view changes'}
        </p>
      </aside>
    );
  const commit = detail.commit;
  const currentSelection = selection?.detail === detail ? selection : undefined;
  const selectedPaths = currentSelection?.paths ?? (path ? [path] : []);
  const file = detail.diff.fileDiffs.find((item) => item.newPath === path || item.oldPath === path);
  /** Cmd/Ctrl 切换单项，Shift 选择展开目录内可见的连续文件。 */
  function selectFile(next: string, event: ReactMouseEvent<HTMLButtonElement>): void {
    let paths = [next];
    let anchor = next;
    if (event.shiftKey && files.current) {
      const visible = Array.from(files.current.querySelectorAll<HTMLButtonElement>('button[data-file-path]'))
        .filter((row) => !row.closest('details:not([open])'))
        .map((row) => row.dataset.filePath!);
      const from = visible.indexOf(currentSelection?.anchor ?? path);
      const to = visible.indexOf(next);
      if (from >= 0 && to >= 0) {
        anchor = visible[from]!;
        paths = visible.slice(Math.min(from, to), Math.max(from, to) + 1);
      }
    } else if (event.metaKey || event.ctrlKey) {
      paths = selectedPaths.includes(next) ? selectedPaths.filter((item) => item !== next) : [...selectedPaths, next];
    }
    setSelection({ detail: detail!, anchor, paths });
    props.onSelect(paths.includes(next) ? next : (paths.at(-1) ?? ''));
  }
  const refs = [...new Set((commit.refs ?? []).map(gitLogRefName))];
  const inHead = repository.snapshot.headSha === commit.hash || (!repository.snapshot.detached && detail.containingBranches?.includes('refs/heads/' + repository.snapshot.branch));
  const containing = [...new Set([...(inHead ? ['HEAD'] : []), ...(detail.containingBranches ?? []).map(gitLogRefName)])];
  const showAllBranches = expandedBranches === detail;
  const visibleBranches = showAllBranches ? containing : containing.slice(0, 3);
  const count = detail.files.length + (detail.files.length === 1 ? ' file' : ' files');
  const fileTree = <CommitFileDirectoryTree files={detail.files} diff={detail.diff} selectedPath={path} selectedPaths={selectedPaths} flat={!directories} onSelect={selectFile} onOpen={props.onOpen} />;
  /** 展开折叠只改变目录展示，选中的文件和预览保持原值。 */
  function expandAll(open: boolean): void {
    for (const item of files.current?.querySelectorAll('details') ?? []) item.open = open;
  }
  return (
    <aside className="project-git-inspector git-log-inspector" data-show-details={showDetails}>
      <section className="project-git-changed-files">
        <header
          className="git-log-file-actions"
          onKeyDown={(event) => {
            if (path && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
              event.preventDefault();
              props.onOpen(path);
            }
          }}
        >
          <Button unstyled type="button" aria-label="Show Diff" data-icon-tooltip="Show Diff" disabled={!path} onClick={() => props.onOpen(path)}>
            <GitDiff aria-hidden="true" />
          </Button>
          <Button
            unstyled
            type="button"
            aria-label="Revert Selected Changes"
            data-icon-tooltip="Revert Selected Changes"
            disabled={!selectedPaths.length || props.busy || repository.snapshot.detached}
            onClick={() => props.onRevert(selectedPaths)}
          >
            <ArrowCounterClockwise aria-hidden="true" />
          </Button>
          <Button unstyled type="button" aria-label="History Up to Here" data-icon-tooltip="History Up to Here" disabled={!path} onClick={() => props.onHistory(path)}>
            <ClockCounterClockwise aria-hidden="true" />
          </Button>
          <GitToolbarMenu
            label="View Options"
            icon={<Eye aria-hidden="true" />}
            items={[
              { label: 'Group By' },
              { label: 'Directory', checked: directories, run: () => setDirectories(!directories) },
              { label: 'Module', checked: modules, run: () => setModules(!modules) },
              { label: 'Show Details', checked: showDetails, run: () => setShowDetails(!showDetails) },
              { label: 'Show Diff Preview', checked: preview, run: () => setPreview(!preview) },
            ]}
          />
          <i />
          <Button unstyled type="button" aria-label="Expand All" data-icon-tooltip="Expand All" disabled={!directories && !modules} onClick={() => expandAll(true)}>
            <CaretDown aria-hidden="true" />
          </Button>
          <Button unstyled type="button" aria-label="Collapse All" data-icon-tooltip="Collapse All" disabled={!directories && !modules} onClick={() => expandAll(false)}>
            <CaretUp aria-hidden="true" />
          </Button>
        </header>
        <div ref={files} className="git-log-inspector-tree">
          {modules ? (
            <details open>
              <summary>
                <i className="git-log-root-color" style={{ background: repositoryColor(repository.id) }} />
                {repository.name} <small>{count}</small>
              </summary>
              <details open className="git-log-project-root">
                <summary title={props.projectRoot ?? repository.localPath}>
                  <FileTypeIcon path={props.projectRoot ?? repository.name} kind="directory" />
                  {props.projectName}{' '}
                  <small>
                    {count} {props.projectRoot ?? repository.localPath}
                  </small>
                </summary>
                {directories && repository.relativePath && repository.relativePath !== '.' ? (
                  <details open className="git-log-project-root">
                    <summary>
                      <FileTypeIcon path={repository.relativePath} kind="directory" />
                      {repository.relativePath} <small>{count}</small>
                    </summary>
                    {fileTree}
                  </details>
                ) : (
                  fileTree
                )}
              </details>
            </details>
          ) : (
            fileTree
          )}
        </div>
        {preview && file ? (
          <SideBySideDiff
            diff={{ ...detail.diff, files: [path], fileDiffs: [file] }}
            previewRequest={{ kind: 'project-git', projectId: props.projectId, repositoryId: repository.id, path, commitHash: commit.hash }}
            zh={false}
            title={path}
          />
        ) : null}
      </section>
      {showDetails ? (
        <>
          <GitPaneSeparator name="details" label="Resize files and commit details" axis="y" initial={55} min={20} max={80} />
          <section className="project-git-commit-detail">
            <strong>{commit.subject}</strong>
            <span>
              <i className="git-log-root-color" style={{ background: repositoryColor(repository.id) }} /> <code>{commit.shortHash}</code> {commit.author}
              {commit.authorEmail ? ' <' + commit.authorEmail + '>' : ''} · {formatZeusDateTime(commit.authoredAt, 'en-US')}
            </span>
            {refs.length ? (
              <span className="git-log-commit-refs">
                <Tag aria-hidden="true" size={13} /> {refs.join(', ')}
              </span>
            ) : null}
            {containing.length ? (
              <span>
                In {containing.length} {containing.length === 1 ? 'branch' : 'branches'}: {visibleBranches.join(', ')}
                {containing.length > 3 ? (
                  <Button unstyled type="button" className="git-log-show-branches" aria-expanded={showAllBranches} onClick={() => setExpandedBranches(showAllBranches ? undefined : detail)}>
                    {showAllBranches ? 'Show less' : 'Show all'}
                  </Button>
                ) : null}
              </span>
            ) : null}
            {detail.body && detail.body !== commit.subject ? <p>{detail.body}</p> : null}
          </section>
        </>
      ) : null}
    </aside>
  );
}

interface CommitFileTreeNode {
  name: string;
  path: string;
  /** 目录内该次提交影响的文件总数。 */
  count?: number;
  children: Map<string, CommitFileTreeNode>;
  /** 提交统计和状态来自同一份差异，禁止从增删行数猜测新增或删除文件。 */
  stats?: { additions: number; deletions: number; changeType?: string };
}

/** 提交与贮藏文件列表共用准确的变更类型和文件图标。 */
function CommitFileDirectoryTree(props: {
  files: Array<{ path: string; additions: number; deletions: number }>;
  diff: GitDiffSummary;
  selectedPath: string;
  /** 详情支持多选，Stash 仍沿用单文件预览。 */
  selectedPaths?: readonly string[];
  flat?: boolean;
  onSelect: (path: string, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onOpen: (path: string) => void;
}) {
  /** 树节点直接持有状态，避免每个文件重复扫描全部差异。 */
  const tree = useMemo(() => buildCommitFileTree(props.files, props.diff, props.flat), [props.files, props.diff, props.flat]);
  return (
    <div className="project-git-commit-file-tree">
      {Array.from(tree.children.values()).map((node) => (
        <CommitFileTreeEntry key={(node.stats ? 'file:' : 'directory:') + node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

/** 目录显示层级，文件显示来自真实提交差异的名称颜色和统计。 */
function CommitFileTreeEntry(props: Parameters<typeof CommitFileDirectoryTree>[0] & { node: CommitFileTreeNode; depth: number }) {
  if (!props.node.stats) {
    return (
      <details className="project-git-commit-file-folder" open>
        <summary data-file-path={props.node.path} style={{ paddingLeft: `${props.depth * 12 + 5}px` }}>
          <CaretRight aria-hidden="true" />
          <FileTypeIcon path={props.node.path} kind="directory" size={13} />
          <span>{props.node.name}</span>
          <small>{props.node.count} files</small>
        </summary>
        {Array.from(props.node.children.values()).map((child) => (
          <CommitFileTreeEntry key={(child.stats ? 'file:' : 'directory:') + child.path} {...props} node={child} depth={props.depth + 1} />
        ))}
      </details>
    );
  }
  return (
    <Button
      data-busy-behavior="background"
      unstyled
      type="button"
      data-file-path={props.node.path}
      className={(props.selectedPaths?.includes(props.node.path) ?? props.node.path === props.selectedPath) ? 'is-current' : ''}
      aria-pressed={props.selectedPaths?.includes(props.node.path)}
      style={{ paddingLeft: `${props.depth * 12 + 7}px` }}
      onClick={(event) => props.onSelect(props.node.path, event)}
      onDoubleClick={() => props.onOpen(props.node.path)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd')) {
          event.preventDefault();
          props.onOpen(props.node.path);
        }
      }}
    >
      <FileTypeIcon path={props.node.path} />
      <span data-icon-tooltip={props.node.name} data-file-status={props.node.stats.changeType}>
        {props.node.name}
      </span>
      <em>+{props.node.stats.additions}</em>
      <i>-{props.node.stats.deletions}</i>
    </Button>
  );
}

/** 一次构造路径索引和目录树，二进制文件也沿用真实变更类型。 */
function buildCommitFileTree(files: Array<{ path: string; additions: number; deletions: number }>, diff: GitDiffSummary, flat?: boolean): CommitFileTreeNode {
  /** 重命名的前后路径均指向同一真实状态。 */
  const statuses = new Map(
    diff.fileDiffs.flatMap(
      (file) =>
        [
          [file.oldPath, file.changeType],
          [file.newPath, file.changeType],
        ] as const,
    ),
  );
  const root: CommitFileTreeNode = { name: '', path: '', children: new Map() };
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    let current = root;
    const parts = flat ? [file.path] : file.path.split('/').filter(Boolean);
    parts.forEach((part, index) => {
      const leaf = index === parts.length - 1;
      const path = parts.slice(0, index + 1).join('/');
      const key = (leaf ? 'file:' : 'directory:') + part;
      const next = current.children.get(key) ?? { name: part, path, children: new Map<string, CommitFileTreeNode>() };
      next.count = (next.count ?? 0) + 1;
      if (leaf) next.stats = { additions: file.additions, deletions: file.deletions, changeType: statuses.get(file.path) };
      current.children.set(key, next);
      current = next;
    });
  }
  compactCommitDirectories(root);
  return root;
}

/** 单一路径链显示在同一行，保留叶节点原始的 Git 路径。 */
function compactCommitDirectories(node: CommitFileTreeNode): void {
  for (const folder of node.children.values()) {
    if (folder.stats) continue;
    while (folder.children.size === 1) {
      const child = folder.children.values().next().value!;
      if (child.stats) break;
      folder.name += '/' + child.name;
      folder.path = child.path;
      folder.children = child.children;
    }
    compactCommitDirectories(folder);
  }
}

function CommitGraph(props: { commits: ProjectGitRepositoryWorkbenchItem['snapshot']['recentCommits']; showLongEdges?: boolean; folded?: ReadonlySet<string> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = 112;
    const rowHeight = gitHistoryRowHeight;
    const height = Math.max(1, props.commits.length * rowHeight);
    const scale = window.devicePixelRatio || 1;
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.scale(scale, scale);
    context.lineWidth = 1.5;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    const colors = ['#4f67d8', '#29a98b', '#7957d5', '#76a93c', '#c27a34', '#3293ba', '#d45f86'];
    const lanes: string[] = [];
    const hashes = new Set(props.commits.map((commit) => commit.hash));
    props.commits.forEach((commit, row) => {
      let lane = lanes.indexOf(commit.hash);
      if (lane < 0) {
        lane = lanes.length;
        lanes[lane] = commit.hash;
      }
      const parents = commit.parentHashes.filter((parent, index, values) => values.indexOf(parent) === index && (props.showLongEdges !== false || hashes.has(parent)));
      const destinations = parents.map((parent, index) => {
        const existing = lanes.indexOf(parent);
        if (existing >= 0) return existing;
        if (index === 0) return lane;
        lanes.push(parent);
        return lanes.length - 1;
      });
      const nextLanes = [...lanes];
      nextLanes[lane] = parents[0] ?? '';
      parents.slice(1).forEach((parent, index) => {
        const destination = destinations[index + 1]!;
        nextLanes[destination] = parent;
      });
      const y = row * rowHeight + rowHeight / 2;
      const nextY = y + rowHeight;
      context.setLineDash(props.folded?.has(commit.hash) ? [3, 4] : []);
      lanes.forEach((value, fromLane) => {
        if (!value) return;
        const destination = value === commit.hash ? (destinations[0] ?? -1) : nextLanes.indexOf(value);
        if (destination < 0 || row === props.commits.length - 1) return;
        context.strokeStyle = colors[fromLane % colors.length]!;
        context.beginPath();
        context.moveTo(12 + fromLane * 14, y);
        context.bezierCurveTo(12 + fromLane * 14, y + rowHeight / 2, 12 + destination * 14, nextY - rowHeight / 2, 12 + destination * 14, nextY);
        context.stroke();
      });
      for (const destination of destinations.slice(1)) {
        context.strokeStyle = colors[destination % colors.length]!;
        context.beginPath();
        context.moveTo(12 + lane * 14, y);
        context.bezierCurveTo(12 + lane * 14, y + rowHeight / 2, 12 + destination * 14, nextY - rowHeight / 2, 12 + destination * 14, nextY);
        context.stroke();
      }
      context.fillStyle = colors[lane % colors.length]!;
      context.beginPath();
      context.arc(12 + lane * 14, y, 3.5, 0, Math.PI * 2);
      context.fill();
      if (parents.length < commit.parentHashes.length && props.showLongEdges === false) {
        context.fillText('↓', 9 + lane * 14, y + 12);
      }
      for (let index = 0; index < nextLanes.length; index += 1) {
        if (nextLanes[index] && nextLanes.indexOf(nextLanes[index]!) !== index) nextLanes[index] = '';
      }
      while (nextLanes.at(-1) === '') nextLanes.pop();
      lanes.splice(0, lanes.length, ...nextLanes);
    });
  }, [props.commits, props.showLongEdges, props.folded]);
  return <canvas ref={canvasRef} className="project-git-graph-canvas" aria-hidden="true" />;
}

/** Stash 在自己的标签中选择贮藏和文件，分支树保持只显示引用。 */
function StashSurface(props: {
  /** 仓库预览所属项目。 */
  projectId: string;
  zh: boolean;
  repository: ProjectGitRepositoryWorkbenchItem | null;
  stash: ProjectGitRepositoryWorkbenchItem['snapshot']['stashes'][number] | null;
  onSelectStash: (ref: string) => void;
  detail: ProjectGitCommitDetail | null;
  loading: boolean;
  selectedFilePath: string;
  busy: BusyState;
  onSelectFile: (path: string) => void;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const selectedDiff = props.detail?.diff.fileDiffs.find((file) => file.newPath === props.selectedFilePath || file.oldPath === props.selectedFilePath) ?? null;
  if (!props.repository || !props.stash) {
    return (
      <div className="project-git-empty-surface">
        <Archive aria-hidden="true" />
        <strong>{props.zh ? '没有可查看的贮藏' : 'No stash to inspect'}</strong>
      </div>
    );
  }
  const repository = props.repository;
  const stash = props.stash;
  return (
    <section className="project-git-stash-surface" aria-label={props.zh ? '贮藏详情' : 'Stash details'}>
      <header className="project-git-stash-toolbar">
        <span className="project-git-stash-identity" data-git-context={JSON.stringify({ kind: 'stash', repositoryId: repository.id, ref: stash.ref })}>
          <Archive aria-hidden="true" />
          <span>
            <GitToolbarMenu
              label="Stash"
              caption={displayStashSubject(stash.subject, props.zh)}
              items={repository.snapshot.stashes.map((entry) => ({
                label: entry.ref + ' · ' + displayStashSubject(entry.subject, props.zh),
                checked: entry.ref === stash.ref,
                run: () => props.onSelectStash(entry.ref),
              }))}
            />
            <small>
              {stash.ref} · {stash.author} · {formatRelativeTime(stash.authoredAt, props.zh)}
            </small>
          </span>
        </span>
        <span className="project-git-stash-actions">
          <Button variant="secondary" size="compact" disabled={props.busy !== null} onClick={() => props.onExecute(repository, { type: 'apply_stash', stashRef: stash.ref }, props.zh ? '应用 Stash' : 'Apply stash')}>
            {props.zh ? '应用' : 'Apply'}
          </Button>
          <Button variant="secondary" size="compact" disabled={props.busy !== null} onClick={() => props.onExecute(repository, { type: 'apply_stash', stashRef: stash.ref, pop: true }, props.zh ? '弹出 Stash' : 'Pop stash')}>
            {props.zh ? '弹出' : 'Pop'}
          </Button>
          <Button variant="danger" size="compact" disabled={props.busy !== null} onClick={() => props.onExecute(repository, { type: 'drop_stash', stashRef: stash.ref }, props.zh ? '删除 Stash' : 'Drop stash')}>
            {props.zh ? '删除' : 'Delete'}
          </Button>
        </span>
      </header>
      {props.loading ? (
        <div className="project-git-inspector-loading">
          <CircleNotch aria-hidden="true" />
          {props.zh ? '正在读取贮藏差异' : 'Loading stash diff'}
        </div>
      ) : props.detail ? (
        <div className="project-git-stash-diff-layout">
          <aside className="project-git-changed-files project-git-stash-files" aria-label={props.zh ? '贮藏中的变更文件' : 'Files changed in stash'}>
            <header>
              <strong>{props.zh ? `变更文件 (${props.detail.files.length})` : `Changed files (${props.detail.files.length})`}</strong>
            </header>
            <CommitFileDirectoryTree files={props.detail.files} diff={props.detail.diff} selectedPath={props.selectedFilePath} onSelect={props.onSelectFile} onOpen={(path) => props.onOpenDiff(repository, path, { commitHash: stash.ref })} />
          </aside>
          <GitPaneSeparator name="stash-files" label={props.zh ? '调整贮藏文件列表宽度' : 'Resize stash file list'} initial={28} min={16} max={55} />
          <SideBySideDiff
            previewRequest={props.selectedFilePath ? { kind: 'project-git', projectId: props.projectId, repositoryId: props.repository.id, path: props.selectedFilePath, commitHash: props.stash.ref } : undefined}
            diff={selectedDiff ? { isRepository: true, files: [props.selectedFilePath], diffText: props.detail.diff.diffText, fileDiffs: [selectedDiff] } : null}
            zh={props.zh}
            title={props.selectedFilePath}
          />
        </div>
      ) : (
        <p className="project-git-empty-copy">{props.zh ? '无法读取该贮藏的文件差异。' : 'The files and diff for this stash could not be loaded.'}</p>
      )}
    </section>
  );
}

/** Update Info 保存每个仓库实际更新前后的提交及错误。 */
interface GitUpdateInfo {
  at: string;
  entries: Array<{ repository: ProjectGitRepositoryWorkbenchItem; before: string; after: string; outcome: 'completed' | 'conflict' | 'failed'; output: string }>;
}

/** 已分配的文件按 changelist 显示，其余保留 Git 原有状态分组。 */
function groupLocalChanges(repository: ProjectGitRepositoryWorkbenchItem, listName: (repository: ProjectGitRepositoryWorkbenchItem, path: string) => string) {
  const defaultFiles: typeof repository.snapshot.fileStatuses = [];
  const assigned = new Map<string, typeof defaultFiles>();
  for (const file of repository.snapshot.fileStatuses) {
    const name = listName(repository, file.path);
    if (name) {
      const entries = assigned.get(name) ?? [];
      entries.push(file);
      assigned.set(name, entries);
    } else defaultFiles.push(file);
  }
  return [
    ...[...assigned].map(([group, entries]) => ({ key: 'list:' + group, group, entries })),
    { key: 'staged', group: 'Staged', entries: defaultFiles.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?') },
    { key: 'changes', group: 'Changes', entries: defaultFiles.filter((file) => file.indexStatus !== '?' && file.workingTreeStatus !== ' ') },
    { key: 'unversioned', group: 'Unversioned Files', entries: defaultFiles.filter((file) => file.indexStatus === '?') },
  ];
}

/** 本地变更快速浏览，Commit 继续打开项目已有的原生交付窗口。 */
function GitLocalChangesSurface(props: {
  repositories: ProjectGitRepositoryWorkbenchItem[];
  changelistName: (repository: ProjectGitRepositoryWorkbenchItem, path: string) => string;
  busy: BusyState;
  onOpen: (repository: ProjectGitRepositoryWorkbenchItem, path: string) => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onShelve: (repository: ProjectGitRepositoryWorkbenchItem, paths: string[]) => void;
  onCommit: () => void | Promise<unknown>;
}) {
  const [selection, setSelection] = useState<{ repositoryId: string; path: string }>();
  /** 同一 Shelf 条目保存来自一个 Git 根的路径。 */
  const [checked, setChecked] = useState<{ repositoryId: string; paths: string[] }>();
  const repositories = props.repositories.filter((repository) => repository.snapshot.fileStatuses.length);
  const selected = repositories.find((repository) => repository.id === (checked?.repositoryId ?? selection?.repositoryId)) ?? repositories[0];
  const file = selected?.id === selection?.repositoryId ? selected?.snapshot.fileStatuses.find((status) => status.path === selection?.path) : undefined;
  const paths =
    selected?.snapshot.fileStatuses.filter((status) => status.indexStatus !== '?' && (checked?.repositoryId === selected.id ? checked.paths.includes(status.path) : !file || status.path === file.path)).map((status) => status.path) ?? [];
  /** Changelist 和单文件用同一批量选择，切换仓库时重新确定有效范围。 */
  function togglePaths(repository: ProjectGitRepositoryWorkbenchItem, targets: string[], include: boolean) {
    const current = selected?.id === repository.id ? paths : [];
    setChecked({ repositoryId: repository.id, paths: include ? [...new Set([...current, ...targets])] : current.filter((path) => !targets.includes(path)) });
  }
  return (
    <section className="git-workbench-tab-surface" aria-label="Local Changes">
      <header className="git-log-toolbar">
        <Button size="compact" variant="primary" onClick={props.onCommit} disabled={!repositories.length || props.busy !== null}>
          Commit...
        </Button>
        <Button
          size="compact"
          variant="secondary"
          disabled={!selected || !file}
          onClick={() => {
            if (selected && file) props.onOpen(selected, file.path);
          }}
        >
          Show Diff
        </Button>
        <Button
          size="compact"
          variant="secondary"
          disabled={!selected || !file || file.workingTreeStatus === ' ' || props.busy !== null}
          onClick={() => {
            if (selected && file) return props.onExecute(selected, { type: 'stage', paths: [file.path] }, 'Stage');
          }}
        >
          Stage
        </Button>
        <Button
          size="compact"
          variant="secondary"
          disabled={!selected || !file || file.indexStatus === ' ' || file.indexStatus === '?' || props.busy !== null}
          onClick={() => {
            if (selected && file) return props.onExecute(selected, { type: 'unstage', paths: [file.path] }, 'Unstage');
          }}
        >
          Unstage
        </Button>
        <Button
          size="compact"
          variant="secondary"
          disabled={!paths.length || props.busy !== null}
          onClick={() => {
            if (selected) props.onShelve(selected, paths);
          }}
        >
          Shelve Changes...
        </Button>
      </header>
      <div className="git-workbench-tab-body">
        {!repositories.length ? (
          <p className="project-git-empty-copy" role="status">
            No local changes
          </p>
        ) : null}
        {repositories.map((repository) => (
          <details key={repository.id} open>
            <summary>
              <i className="git-log-root-color" style={{ background: repositoryColor(repository.id) }} />
              {repository.name} <small>{repository.snapshot.fileStatuses.length} files</small>
            </summary>
            {groupLocalChanges(repository, props.changelistName).map(({ key, group, entries }) => {
              if (!entries.length) return null;
              const tracked = entries.filter((status) => status.indexStatus !== '?').map((status) => status.path);
              return (
                <details open key={key}>
                  <summary>
                    {tracked.length ? (
                      <input
                        type="checkbox"
                        aria-label={'Select ' + group}
                        checked={selected?.id === repository.id && tracked.every((path) => paths.includes(path))}
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => togglePaths(repository, tracked, event.currentTarget.checked)}
                      />
                    ) : null}
                    {group} <small>{entries.length}</small>
                  </summary>
                  {entries.map((status) => (
                    <div className="git-tab-checkable-file" key={status.path}>
                      <input
                        type="checkbox"
                        aria-label={'Select ' + status.path}
                        disabled={status.indexStatus === '?'}
                        checked={selected?.id === repository.id && paths.includes(status.path)}
                        onChange={(event) => togglePaths(repository, [status.path], event.currentTarget.checked)}
                      />
                      <Button
                        unstyled
                        type="button"
                        className="git-tab-file-row"
                        aria-pressed={selection?.repositoryId === repository.id && selection.path === status.path}
                        onClick={() => {
                          setSelection({ repositoryId: repository.id, path: status.path });
                          if (checked?.repositoryId !== repository.id) setChecked(undefined);
                        }}
                        onDoubleClick={() => props.onOpen(repository, status.path)}
                      >
                        <FileTypeIcon path={status.path} kind={status.isSubmodule ? 'submodule' : undefined} />
                        <span data-file-status={status.category}>{status.path}</span>
                      </Button>
                    </div>
                  ))}
                </details>
              );
            })}
          </details>
        ))}
      </div>
    </section>
  );
}

/** Shelf 列表来自仓库的独立引用，打开差异时固定保存的提交。 */
function GitShelfSurface(props: {
  projectId: string;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  repository: ProjectGitRepositoryWorkbenchItem | null;
  refreshedAt: string;
  busy: BusyState;
  onRepository: (id: string) => void;
  onUnshelve: (repository: ProjectGitRepositoryWorkbenchItem, entry: ProjectGitRepositoryWorkbenchItem['snapshot']['stashes'][number], paths: string[]) => void;
  onOpen: (repository: ProjectGitRepositoryWorkbenchItem, path: string, options?: { commitHash?: string }) => void;
  onDelete: (repository: ProjectGitRepositoryWorkbenchItem, entry: ProjectGitRepositoryWorkbenchItem['snapshot']['stashes'][number]) => void;
}) {
  const [entries, setEntries] = useState<ProjectGitRepositoryWorkbenchItem['snapshot']['stashes']>([]);
  const [selected, setSelected] = useState('');
  /** 文件读取与固定版本关联，快速切换条目时不会执行旧选择。 */
  const [detail, setDetail] = useState<{ hash: string; files: NonNullable<ProjectGitLogInfo['shelfFiles']> }>();
  const [checked, setChecked] = useState<string[]>([]);
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { repository, projectId, refreshedAt } = props;
  const repositoryId = repository?.id;
  const entry = entries.find((item) => item.ref === selected);
  const filesAtSelection = detail && detail.hash === entry?.hash ? detail.files : [];
  useEffect(() => {
    if (!repositoryId) return;
    let active = true;
    setLoading(true);
    setError('');
    void readGitLogInfo(projectId, repositoryId, { kind: 'shelf' })
      .then((result) => {
        if (!active) return;
        setEntries(result.entries ?? []);
        setSelected((ref) => (result.entries?.some((entry) => entry.ref === ref) ? ref : (result.entries?.[0]?.ref ?? '')));
      })
      .catch((reason: unknown) => {
        if (active) {
          setEntries([]);
          setError(errorMessage(reason, false));
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, repositoryId, refreshedAt]);
  useEffect(() => {
    setDetail(undefined);
    setPath('');
    if (!entry || !repositoryId) return;
    let active = true;
    void readGitLogInfo(projectId, repositoryId, { kind: 'shelf', ref: entry.hash })
      .then((result) => {
        if (active) {
          const files = result.shelfFiles ?? [];
          setDetail({ hash: entry.hash, files });
          setPath(files[0]?.path ?? '');
          setChecked(files.map((file) => file.path));
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, false));
      });
    return () => {
      active = false;
    };
  }, [projectId, repositoryId, entry]);
  return (
    <section className="git-workbench-tab-surface" aria-label="Shelf">
      <header className="git-log-toolbar">
        <select aria-label="Shelf repository" value={repositoryId ?? ''} onChange={(event) => props.onRepository(event.currentTarget.value)}>
          {props.repositories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <Button
          size="compact"
          variant="secondary"
          disabled={!repository || !entry || !filesAtSelection.some((file) => checked.includes(file.path)) || loading || props.busy !== null}
          onClick={() => {
            const paths = filesAtSelection.filter((file) => checked.includes(file.path)).flatMap((file) => (file.originalPath ? [file.path, file.originalPath] : [file.path]));
            if (repository && entry && paths.length) props.onUnshelve(repository, entry, [...new Set(paths)]);
          }}
        >
          Unshelve...
        </Button>
        <Button
          size="compact"
          variant="secondary"
          disabled={!repository || !entry || loading || props.busy !== null}
          onClick={() => {
            if (repository && entry) props.onDelete(repository, entry);
          }}
        >
          Delete
        </Button>
      </header>
      <div className="git-workbench-tab-body">
        {loading ? <p role="status">Loading Shelf...</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        {!entries.length && !loading && !error ? (
          <p className="project-git-empty-copy" role="status">
            No shelved changes
          </p>
        ) : null}
        {entries.map((item) => (
          <Button unstyled className="git-tab-file-row" key={item.ref} aria-pressed={item.ref === selected} onClick={() => setSelected(item.ref)}>
            <Archive aria-hidden="true" />
            <span>{item.subject}</span>
            <small>{formatZeusDateTime(item.authoredAt, 'en-US')}</small>
          </Button>
        ))}
        {repository
          ? filesAtSelection.map((file) => (
              <div className="git-tab-checkable-file" key={file.path}>
                <input
                  type="checkbox"
                  aria-label={'Select ' + file.path}
                  checked={checked.includes(file.path)}
                  onChange={(event) => setChecked(event.currentTarget.checked ? [...checked, file.path] : checked.filter((path) => path !== file.path))}
                />
                <Button unstyled className="git-tab-file-row" aria-pressed={path === file.path} onClick={() => setPath(file.path)} onDoubleClick={() => props.onOpen(repository, file.path, { commitHash: file.revision })}>
                  <FileTypeIcon path={file.path} />
                  <span>{file.originalPath ? file.originalPath + ' → ' + file.path : file.path}</span>
                </Button>
              </div>
            ))
          : null}
      </div>
    </section>
  );
}

/** Update Info 展开时读取实测提交范围和变更文件。 */
function GitUpdateSurface(props: { projectId: string; info: GitUpdateInfo; onCommit: (repository: ProjectGitRepositoryWorkbenchItem, hash: string) => void }) {
  /** 文件预览固定在当前更新实际使用的版本，不跟随后续 Git 操作。 */
  const [selection, setSelection] = useState<{ entry: GitUpdateInfo['entries'][number]; path: string; changeType: NonNullable<ProjectGitLogInfo['diff']>['fileDiffs'][number]['changeType'] }>();
  const selected = selection && props.info.entries.includes(selection.entry) ? selection : undefined;
  return (
    <section className="git-update-layout" aria-label="Update Info">
      <div className="git-workbench-tab-body">
        {props.info.entries.map((entry) => (
          <GitUpdateRepository
            key={props.info.at + ':' + entry.repository.id}
            projectId={props.projectId}
            entry={entry}
            onCommit={props.onCommit}
            selectedPath={selected?.entry === entry ? selected.path : ''}
            onSelect={(path, changeType) => setSelection({ entry, path, changeType })}
          />
        ))}
      </div>
      <GitPaneSeparator name="update-files" label="Resize updated files and diff" initial={38} min={24} max={60} />
      <div className="git-update-preview">
        {selected ? (
          <SideBySideDiff
            key={selected.entry.repository.id + ':' + selected.entry.after + ':' + selected.path}
            title={selected.path}
            diff={null}
            zh={false}
            fileStatus={selected.changeType}
            previewRequest={{ kind: 'project-git', projectId: props.projectId, repositoryId: selected.entry.repository.id, path: selected.path, revisions: [selected.entry.before, selected.entry.after] }}
          />
        ) : (
          <p className="project-git-empty-copy">Select a file to view changes</p>
        )}
      </div>
    </section>
  );
}

/** 更新结果保留成功、冲突和失败，查询失败也不显示为空变化。 */
function GitUpdateRepository(props: {
  projectId: string;
  entry: GitUpdateInfo['entries'][number];
  onCommit: (repository: ProjectGitRepositoryWorkbenchItem, hash: string) => void;
  selectedPath: string;
  onSelect: (path: string, changeType: NonNullable<ProjectGitLogInfo['diff']>['fileDiffs'][number]['changeType']) => void;
}) {
  const { entry, projectId } = props;
  const [result, setResult] = useState<ProjectGitLogInfo>();
  const [error, setError] = useState('');
  const needsRange = Boolean(entry.before && entry.after && entry.before !== entry.after);
  const [offset, setOffset] = useState<number | null>(needsRange ? 0 : null);
  useEffect(() => {
    if (!needsRange || offset === null) return;
    let active = true;
    void readGitLogInfo(projectId, entry.repository.id, { kind: 'update', before: entry.before, ref: entry.after, offset })
      .then((data) => {
        if (active) setResult((current) => (offset ? { ...current, ...data, diff: current?.diff, commits: [...(current?.commits ?? []), ...(data.commits ?? [])] } : data));
      })
      .catch((reason: unknown) => {
        if (active) setError(errorMessage(reason, false));
      })
      .finally(() => {
        if (active) setOffset(null);
      });
    return () => {
      active = false;
    };
  }, [projectId, entry, needsRange, offset]);
  return (
    <details open>
      <summary>
        <i className="git-log-root-color" style={{ background: repositoryColor(entry.repository.id) }} />
        {entry.repository.name} <small>{entry.outcome === 'completed' ? 'Updated' : entry.outcome === 'conflict' ? 'Conflicts' : 'Failed'}</small>
      </summary>
      {result?.commits?.map((commit) => (
        <Button unstyled type="button" key={commit.hash} className="git-tab-file-row" onClick={() => props.onCommit(entry.repository, commit.hash)}>
          <code>{commit.shortHash}</code>
          <span>{commit.subject}</span>
        </Button>
      ))}
      {offset !== null ? (
        <p role="status">Loading updated commits...</p>
      ) : result?.hasMore || error ? (
        <Button
          size="compact"
          onClick={() => {
            setError('');
            setOffset(result?.commits?.length ?? 0);
          }}
        >
          {error ? 'Retry' : 'Load More'}
        </Button>
      ) : null}
      {result?.diff?.fileDiffs.length ? (
        <details open>
          <summary>
            Updated Files <small>{result.diff.files.length}</small>
          </summary>
          <CommitFileDirectoryTree
            files={result.diff.fileDiffs.map((file) => ({ path: file.newPath || file.oldPath, additions: file.addedLines, deletions: file.deletedLines }))}
            diff={result.diff}
            selectedPath={props.selectedPath}
            onSelect={(path) => {
              const file = result.diff?.fileDiffs.find((item) => (item.newPath || item.oldPath) === path);
              if (file) props.onSelect(path, file.changeType);
            }}
            onOpen={(path) => {
              const file = result.diff?.fileDiffs.find((item) => (item.newPath || item.oldPath) === path);
              if (file) props.onSelect(path, file.changeType);
            }}
          />
        </details>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {entry.output ? <pre>{entry.output}</pre> : null}
    </details>
  );
}

/** Console 展示账本里的原命令和输出，清屏只改变当前视图。 */
/** 一行对应真实命令、进程输出或操作终态，可在多仓之间按时间合并。 */
type GitConsoleRow = { key: string; at: number; kind: 'command' | 'stdout' | 'stderr' | 'status'; text: string };

/** 新记录保留实际时间和工作目录；旧记录沿用既有输出和操作时间。 */
function gitConsoleRows(operations: ProjectGitOperationRecord[], repositories: ProjectGitRepositoryWorkbenchItem[], rootPath?: string | null): GitConsoleRow[] {
  const rows: GitConsoleRow[] = [];
  for (const operation of operations) {
    const at = Date.parse(operation.startedAt);
    let latest = at;
    const repository = repositories.find((item) => item.id === operation.repositoryId);
    const cwd = repository?.localPath ?? (rootPath && repository ? displayedFilePath(repository.relativePath, rootPath) : operation.repositoryName);
    const commands = operation.commands ?? [];
    const detailed = operation.commandDetails?.some(Boolean);
    if (!commands.length) continue;
    for (const [index, command] of commands.entries()) {
      const detail = operation.commandDetails?.[index];
      const startedAt = detail?.startedAt ?? at;
      latest = Math.max(latest, startedAt);
      const time = new Date(startedAt);
      const stamp = detail || index === 0 ? time.toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(time.getMilliseconds()).padStart(3, '0') + ': ' : '';
      const key = operation.id + ':' + index;
      rows.push({ key, at: startedAt, kind: 'command', text: stamp + '[' + (detail?.cwd ?? cwd) + '] ' + command });
      detail?.output?.forEach((part, partIndex) => {
        latest = Math.max(latest, part.at);
        rows.push({ key: key + ':' + partIndex, at: part.at, kind: part.stream, text: part.text });
      });
    }
    const finished = Math.max(latest, Date.parse(operation.updatedAt ?? operation.startedAt));
    if (!detailed) {
      const stdout = operation.stdout ?? (operation.stderr === undefined ? operation.output : '');
      if (stdout) rows.push({ key: operation.id + ':stdout', at: finished, kind: 'stdout', text: stdout });
      if (operation.stderr) rows.push({ key: operation.id + ':stderr', at: finished, kind: 'stderr', text: operation.stderr });
    } else if (operation.status === 'failed_before_write' || operation.status === 'unknown_after_write') {
      if (operation.output) rows.push({ key: operation.id + ':failure', at: finished, kind: 'stderr', text: operation.output });
    }
    if (operation.status !== 'completed' && operation.status !== 'running') {
      rows.push({ key: operation.id + ':status', at: finished, kind: 'status', text: operationStatusLabels[operation.status][1] });
    }
    operation.limitations.forEach((limitation) => rows.push({ key: operation.id + ':' + limitation, at: finished, kind: 'status', text: operationLimitationLabels[limitation][1] }));
  }
  return rows.sort((left, right) => left.at - right.at);
}

function ConsoleSurface(props: {
  history: ReturnType<typeof useGitOperationHistory>;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  rootPath?: string | null;
  view: { wrap: boolean; clearedAt: number };
  onView: (view: { wrap: boolean; clearedAt: number }) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const rows = useMemo(() => gitConsoleRows(props.history.items, props.repositories, props.rootPath).filter((row) => row.at > props.view.clearedAt), [props.history.items, props.repositories, props.rootPath, props.view.clearedAt]);
  /** 用户滚离末尾后，新的命令输出不抢阅读位置。 */
  function scrollEnd(): void {
    if (!root.current) return;
    root.current.scrollTop = root.current.scrollHeight;
    follow.current = true;
  }
  useLayoutEffect(() => {
    if (follow.current) scrollEnd();
  }, [rows, props.view.wrap]);
  return (
    <section className="git-console-layout" aria-label="Console">
      <div className="git-console-actions">
        <Button unstyled type="button" aria-label="Use Soft Wraps" data-icon-tooltip="Use Soft Wraps" aria-pressed={props.view.wrap} onClick={() => props.onView({ ...props.view, wrap: !props.view.wrap })}>
          <span aria-hidden="true">↵</span>
        </Button>
        <Button unstyled type="button" aria-label="Scroll to End" data-icon-tooltip="Scroll to End" onClick={scrollEnd}>
          <ArrowDown aria-hidden="true" />
        </Button>
        <Button unstyled type="button" aria-label="Clear Console" data-icon-tooltip="Clear Console" disabled={!rows.length} onClick={() => props.onView({ ...props.view, clearedAt: performance.timeOrigin + performance.now() })}>
          <Trash aria-hidden="true" />
        </Button>
      </div>
      <div
        ref={root}
        className="git-console-output"
        data-wrap={props.view.wrap}
        role="region"
        aria-label="Git command output"
        tabIndex={0}
        aria-busy={props.history.loading}
        onScroll={(event) => {
          const element = event.currentTarget;
          follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 30;
        }}
      >
        {props.history.error ? (
          <div role="alert">
            {props.history.error}{' '}
            <Button size="compact" onClick={() => props.history.retry()}>
              Retry
            </Button>
          </div>
        ) : null}
        {props.history.nextCursor && Date.parse(props.history.items.at(-1)?.startedAt ?? '') > props.view.clearedAt ? (
          <Button
            size="compact"
            variant="secondary"
            disabled={props.history.loading}
            onClick={() => {
              follow.current = false;
              void props.history.loadMore();
            }}
          >
            Load Earlier Output
          </Button>
        ) : null}
        {props.history.loading ? <span role="status">Loading Console...</span> : null}
        {!rows.length && !props.history.loading && !props.history.error ? <p className="project-git-empty-copy">No Git command output</p> : null}
        {rows.map((row) =>
          row.kind === 'status' ? (
            <small key={row.key}>{row.text}</small>
          ) : (
            <pre key={row.key} className={row.kind === 'command' ? 'git-console-command' : row.kind === 'stderr' ? 'git-console-stderr' : undefined}>
              {row.text.replace(/\r\n?/gu, '\n').replace(/\n$/u, '')}
            </pre>
          ),
        )}
      </div>
    </section>
  );
}

/** 文本明确表达账本事实，颜色与图标不承担唯一的状态提示。 */
const operationStatusLabels: Record<ProjectGitOperationRecord['status'], [string, string]> = {
  paused: ['变基已暂停', 'Rebase paused'],
  running: ['正在执行', 'Running'],
  completed: ['已完成', 'Completed'],
  conflict: ['存在冲突，需要处理', 'Conflicts need attention'],
  blocked: ['Checkout blocked by local changes', 'Checkout blocked by local changes'],
  failed_before_write: ['执行前失败，未开始写入', 'Failed before writing'],
  unknown_after_write: ['结果未知，需要核对', 'Outcome unknown; verification needed'],
  recorded: ['已保存执行结果，详细状态未保存', 'Result recorded; detailed status unavailable'],
};

/** 缺失信息与展示上限均直接说明，避免将空白误认为完整历史。 */
const operationLimitationLabels: Record<ProjectGitOperationRecord['limitations'][number], [string, string]> = {
  action_unavailable: ['记录未保存动作名称。', 'The action name was not saved.'],
  output_not_saved: ['记录未保存输出内容。', 'Output was not saved.'],
  output_truncated: ['输出过长，此处仅展示前 64 Ki 字符。', 'Output is long; only the first 64 Ki characters are shown.'],
  commands_not_saved: ['记录未保存具体 Git 命令。', 'The Git commands were not saved.'],
  commands_truncated: ['命令记录过长，仅保存前 64 Ki 字符。', 'Command history exceeded 64 Ki characters and was truncated.'],
};

function OperationsMenu(props: {
  anchor: HTMLButtonElement | null;
  zh: boolean;
  onClose: () => void;
  onOpenCommit: () => void;
  onOpenPush: () => void;
  onOpenUpdate: () => void;
  onOpenNewBranch: () => void;
  onOpenRevision: () => void;
  onSelectTab: (tab: GitTab) => void;
  onOpenConsole?: () => void;
  onOpenSubtree: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const bounds = props.anchor?.getBoundingClientRect();

  const action = (callback: () => void) => () => {
    props.onClose();
    callback();
  };
  return createPortal(
    <MenuSurface onClose={props.onClose} ref={menuRef} className="macos-ai-app project-git-operations-menu" role="menu" style={{ left: Math.max(8, (bounds?.right ?? 228) - 220), top: (bounds?.bottom ?? 0) + 5 }}>
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenCommit)}>
        {props.zh ? '提交…' : 'Commit…'}
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenPush)}>
        {props.zh ? '推送…' : 'Push…'}
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenUpdate)}>
        {props.zh ? '更新项目…' : 'Update Project…'}
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenSubtree)}>
        {props.zh ? '管理子树…' : 'Manage subtrees…'}
      </Button>
      <hr />
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenNewBranch)}>
        {props.zh ? '新建分支…' : 'New Branch…'}
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenRevision)}>
        {props.zh ? '切换到标签或提交…' : 'Switch to a tag or commit…'}
      </Button>
      <hr />
      <Button unstyled type="button" role="menuitem" onClick={action(() => props.onSelectTab('log'))}>
        {props.zh ? '显示 Git 历史' : 'Show Git History'}
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenCommit)}>
        {props.zh ? '未提交的变更' : 'Uncommitted Changes'}
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={action(() => props.onSelectTab('stash'))}>
        {props.zh ? '贮藏' : 'Stashes'}
      </Button>
      {props.onOpenConsole ? (
        <Button unstyled type="button" role="menuitem" onClick={action(props.onOpenConsole)}>
          {props.zh ? '控制台 / 操作记录' : 'Console / Operation history'}
        </Button>
      ) : null}
    </MenuSurface>,
    document.body,
  );
}

function readRememberedTab(projectId: string): GitTab {
  const value = typeof window === 'undefined' ? null : window.localStorage.getItem(`zeus.project-git-tab-v2:${projectId}`);
  return value === 'stash' ? value : 'log';
}

function displayStashSubject(subject: string, zh: boolean): string {
  const cleaned = subject.replace(/^(?:On\s+[^:]+|WIP\s+on\s+[^:]+):\s*/iu, '').trim();
  return cleaned || (zh ? '未命名 Stash' : 'Untitled stash');
}

function errorMessage(error: unknown, zh: boolean, options: { title?: string; action?: { label: string; onClick: () => void | Promise<void> } } = {}): string {
  return options.title || options.action ? reportApplicationError(error, { language: zh ? 'zh-CN' : 'en', ...options }) : formatVisibleApplicationError(error, zh ? 'zh-CN' : 'en');
}

function errorHasCode(error: unknown, expected: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === 'string') return current.startsWith(`${expected}:`) || current === expected;
    if (typeof current !== 'object' || Array.isArray(current)) return false;
    const candidate = current as { code?: unknown; error?: unknown; cause?: unknown };
    if (candidate.code === expected || candidate.error === expected) return true;
    current = candidate.cause;
  }
  return false;
}

function formatRelativeTime(value: string, zh: boolean): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return zh ? '刚刚' : 'Just now';
  if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return zh ? `${days} 天前` : `${days}d ago`;
}

function SubtreeManagementDialog(props: {
  repository: ProjectGitRepositoryWorkbenchItem;
  zh: boolean;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const [operation, setOperation] = useState<'add' | 'pull' | 'push'>('add');
  const [path, setPath] = useState('');
  const [remote, setRemote] = useState(props.repository.snapshot.remotes[0] ?? '');
  const [branch, setBranch] = useState('');
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null} role="dialog" aria-label={props.zh ? '管理子树' : 'Manage subtree'}>
      <section className="project-git-subtree-dialog" data-modal-surface="dialog">
        <h2>{props.zh ? '管理子树' : 'Manage subtree'}</h2>
        <p>{props.zh ? '添加和拉取使用 squash 合并，需要干净的工作区。操作前会确认目标仓库与分支。' : 'Add and pull use squash and require a clean working tree. Confirm the target before executing.'}</p>
        <label>
          {props.zh ? '操作' : 'Action'}
          <select value={operation} onChange={(event) => setOperation(event.currentTarget.value as 'add' | 'pull' | 'push')}>
            <option value="add">{props.zh ? '添加' : 'Add'}</option>
            <option value="pull">{props.zh ? '拉取' : 'Pull'}</option>
            <option value="push">{props.zh ? '推送' : 'Push'}</option>
          </select>
        </label>
        <label>
          {props.zh ? '子树路径' : 'Subtree path'}
          <input value={path} onChange={(event) => setPath(event.currentTarget.value)} placeholder="packages/example" list="project-git-subtree-paths" />
        </label>
        <datalist id="project-git-subtree-paths">
          {props.repository.subtreePaths?.map((value) => (
            <option key={value} value={value} />
          ))}
        </datalist>
        <label>
          {props.zh ? '远端' : 'Remote'}
          <select value={remote} onChange={(event) => setRemote(event.currentTarget.value)}>
            {props.repository.snapshot.remotes.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
        <label>
          {props.zh ? '远端分支' : 'Remote branch'}
          <input value={branch} onChange={(event) => setBranch(event.currentTarget.value)} placeholder="main" />
        </label>
        <footer>
          <Button variant="secondary" disabled={props.busy !== null} onClick={props.onClose}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            disabled={props.busy !== null || !path || !remote || !branch}
            onClick={() =>
              props.onExecute(props.repository, { type: 'subtree', operation, path, remote, branch }, props.zh ? '子树操作' : 'Subtree operation').then((result) => {
                if (result === 'completed') props.onClose();
              })
            }
          >
            {props.zh ? '执行' : 'Execute'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
