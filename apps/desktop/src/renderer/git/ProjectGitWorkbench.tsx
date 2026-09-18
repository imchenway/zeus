import { DotsThreeIcon as DotsThree } from '@phosphor-icons/react/dist/csr/DotsThree';
import { GitCommitIcon as GitCommit } from '@phosphor-icons/react/dist/csr/GitCommit';
import { GitMergeIcon as GitMerge } from '@phosphor-icons/react/dist/csr/GitMerge';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ClockCounterClockwiseIcon as History } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { projectGitWorkbenchCacheEntry, readCachedProjectGitWorkbench, requestProjectGitWorkbench, subscribeProjectGitRefresh, notifyProjectGitChanged, visibleRepositoryFiles } from './projectGitWorkbenchState.js';
import {
  BranchSwitcher,
  MergeBranchDialog,
  UpdateProjectDialog,
  NewBranchDialog,
  RemoteBranchCheckoutDialog,
  CheckoutRevisionDialog,
  BranchDirectoryTree,
  BranchContextMenu,
  StashDialog,
  PullDialog,
  PushDialog,
} from './GitRepositoryControls.js';
import type { ExecutionOutcome } from './gitWorkbenchTypes.js';
import type { BranchKind } from './gitWorkbenchTypes.js';
import type { OperationTone } from './gitWorkbenchTypes.js';
import type { BusyState } from './gitWorkbenchTypes.js';
import { MenuSurface } from '../ui/MenuSurface.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useGitCommitDrafts } from './useGitCommitDrafts.js';
import { loadGitCommitModelOptions } from './gitCommitModels.js';
import { useGitOperationHistory } from './useGitOperationHistory.js';
import { GitContextMenu, GitMenuActionDialog, type GitMenuItem, type GitMenuConfirmation } from './GitContextMenu.js';
import { GitPaneSeparator } from './GitPaneSeparator.js';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { ListBulletsIcon as ListBullets } from '@phosphor-icons/react/dist/csr/ListBullets';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { TreeStructureIcon as TreeStructure } from '@phosphor-icons/react/dist/csr/TreeStructure';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { DashboardClient, GitDiffHunk, GitFileDiff, ProjectGitAction, ProjectGitCommitDetail, ProjectGitOperationRecord, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { reportApplicationError, useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SideBySideDiff } from './ProjectGitDiffViewer.js';

type GitTab = 'changes' | 'stash' | 'log' | 'console';
type ChangeStage = 'staged' | 'unstaged';
interface GitContextTarget {
  kind: 'file' | 'directory' | 'stage' | 'local' | 'remote' | 'tag' | 'commit' | 'stash' | 'repository';
  repositoryId: string;
  ref: string;
  stage?: ChangeStage;
}

export interface ProjectGitWorkbenchProps {
  conversationScope?: boolean;
  project: ProjectRecord;
  client: Pick<
    DashboardClient,
    | 'loadConversationGitHistory'
    | 'loadProjectGitWorkbench'
    | 'loadProjectGitOperations'
    | 'loadProjectGitCommit'
    | 'loadProjectGitComparisonDiff'
    | 'executeProjectGitAction'
    | 'generateGitCommitMessage'
    | 'loadGitCommitModels'
    | 'loadProjectModelSelection'
  >;
  language: 'zh-CN' | 'en-US';
}

const projectGitViewPreferences = new Map<string, { repositoryId: string; searchQuery: string }>();

export function ProjectGitWorkbench(props: ProjectGitWorkbenchProps) {
  const zh = props.language === 'zh-CN';
  const [snapshot, setSnapshot] = useState<ProjectGitWorkbenchSnapshot | null>(() => readCachedProjectGitWorkbench(props.client, props.project.id));
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(() => (snapshot ? 'ready' : 'loading'));
  const [error, setError] = useState<string | null>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [tab, setTab] = useState<GitTab>(() => (props.conversationScope ? 'changes' : readRememberedTab(props.project.id)));
  const [subtree, setSubtree] = useState<{ repositoryId: string; path: string } | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(() => projectGitViewPreferences.get(props.project.id)?.repositoryId ?? '');
  /** 只有用户点选才建立提交选择，并绑定仓库，避免初始加载或换仓库产生伪选中。 */
  const [selectedCommit, setSelectedCommit] = useState<{ repositoryId: string; ref: string } | null>(null);
  const [selectedStashRef, setSelectedStashRef] = useState('');
  const [conversationDiff, setConversationDiff] = useState<{ diff: import('../apiClient.js').GitDiffSummary; preview: Extract<import('@zeus/shared').FilePreviewRequest, { kind: 'project-git' }> } | null>(null);
  const [commitDetail, setCommitDetail] = useState<ProjectGitCommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFileStage, setSelectedFileStage] = useState<ChangeStage>('unstaged');
  const [searchQuery, setSearchQuery] = useState(() => projectGitViewPreferences.get(props.project.id)?.searchQuery ?? '');
  useEffect(() => {
    projectGitViewPreferences.set(props.project.id, { repositoryId: selectedRepositoryId, searchQuery });
  }, [props.project.id, selectedRepositoryId, searchQuery]);
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [pullOpen, setPullOpen] = useState(false);
  const [stashRepositoryId, setStashRepositoryId] = useState<string | null>(null);
  const operationsTriggerRef = useRef<HTMLButtonElement>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitRequest, setCommitRequest] = useState(0);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; title: string; items: GitMenuItem[] } | null>(null);
  const [menuConfirmation, setMenuConfirmation] = useState<GitMenuConfirmation | null>(null);
  const [commitDrafts, setCommitDrafts] = useGitCommitDrafts(props.project.id);
  const [commitModels, setCommitModels] = useState<Array<{ id: string; label: string }>>([]);
  const [commitModelRef, setCommitModelRef] = useState('');
  const [commitModelsLoading, setCommitModelsLoading] = useState(true);
  const [commitModelsError, setCommitModelsError] = useState('');
  const [commitModelsRefresh, setCommitModelsRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setCommitModelsLoading(true);
    setCommitModelsError('');
    setCommitModelRef('');
    setCommitModels([]);
    void loadGitCommitModelOptions(props.client, props.project.id)
      .then((models) => {
        if (!active) return;
        // 单个来源不可用不代表整个模型列表失败；有可用模型时不阻挡生成反馈。
        setCommitModelsError(models.items.length ? '' : models.warning);
        setCommitModels(models.items);
        setCommitModelRef(models.modelRef);
      })
      .catch((reason: unknown) => {
        if (active) setCommitModelsError(errorMessage(reason, zh));
      })
      .finally(() => {
        if (active) setCommitModelsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.project.id, zh, commitModelsRefresh]);
  function selectCommitModel(modelRef: string): void {
    setCommitModelRef(modelRef);
    try {
      localStorage.setItem(`zeus.git.commit-model.${props.project.id}`, modelRef);
    } catch {
      /* 本次选择仍然有效。 */
    }
  }
  const [generatingCommitFor, setGeneratingCommitFor] = useState<string | null>(null);
  const generatingCommitRef = useRef(false);
  const commitGenerationController = useRef<AbortController | null>(null);
  useEffect(() => () => commitGenerationController.current?.abort(), [props.project.id]);
  const [commitGenerationFeedback, setCommitGenerationFeedback] = useState<Record<string, string>>({});
  const [updateOpen, setUpdateOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchBase, setNewBranchBase] = useState('');
  const [remoteCheckoutTarget, setRemoteCheckoutTarget] = useState<{ repositoryId: string; remoteRef: string } | null>(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const actionBusyRef = useRef(false);
  /** 控制台缓存可以销毁，历史由桌面耐久账本恢复。 */
  const operationHistory = useGitOperationHistory(props.client, props.project.id);
  const [pushResults, setPushResults] = useState<Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>>([]);
  const requestVersionRef = useRef(0);
  const operationErrorsByRepositoryRef = useRef<Record<string, string>>({});

  const [subtreeDialogOpen, setSubtreeDialogOpen] = useState(false);
  const [historyRef, setHistoryRef] = useState('');
  const [historyPage, setHistoryPage] = useState<{ key: string; commits: ProjectGitRepositoryWorkbenchItem['snapshot']['recentCommits']; hasMore: boolean } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const historyInFlight = useRef<number | null>(null);
  const historyRequest = useRef(0);
  const repositories = useMemo(() => {
    const items = snapshot?.repositories ?? [];
    return items.map((repository) => ({ ...repository, snapshot: { ...repository.snapshot, fileStatuses: visibleRepositoryFiles(repository, items) } }));
  }, [snapshot]);
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0] ?? null;
  const stashRepository = repositories.find((repository) => repository.id === stashRepositoryId) ?? null;
  const remoteCheckoutRepository = repositories.find((repository) => repository.id === remoteCheckoutTarget?.repositoryId) ?? null;
  const activeStash = selectedRepository?.snapshot.stashes.find((stash) => stash.ref === selectedStashRef) ?? selectedRepository?.snapshot.stashes[0] ?? null;
  const activeStashRef = activeStash?.ref ?? '';
  /** 其他仓库的选择不能借用当前仓库读取详情。 */
  const selectedCommitHash = selectedCommit?.repositoryId === selectedRepository?.id ? (selectedCommit?.ref ?? '') : '';
  // 角标与文件列表使用同一个仓库，不能把其他子模块的改动算进来。
  const changedCount = selectedRepository?.snapshot.fileStatuses.length ?? 0;
  const conflictCount = repositories.reduce((total, repository) => total + repository.snapshot.conflictFiles.length, 0);
  const allCommits = useMemo(
    () =>
      repositories
        .filter((repository) => repository.id === selectedRepository?.id)
        .flatMap((repository) => (historyPage?.key === `${repository.id}:${historyRef}` ? historyPage.commits : repository.snapshot.recentCommits).map((commit) => ({ repository, commit })))
        .filter(({ commit }) => `${commit.subject} ${commit.author} ${commit.hash}`.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase())),
    [repositories, selectedRepository?.id, searchQuery, historyPage, historyRef],
  );

  useEffect(() => {
    setHistoryRef('');
    setHistoryPage(null);
    setSelectedStashRef('');
  }, [selectedRepository?.id]);
  useEffect(() => {
    if (tab === 'log') void loadHistory(false);
    return () => {
      historyRequest.current += 1;
    };
  }, [selectedRepository?.id, historyRef, tab, snapshot?.refreshedAt]);

  async function loadHistory(append: boolean): Promise<void> {
    if (!selectedRepository || (!props.conversationScope && !window.zeus?.loadProjectGitHistory)) return;
    if (append && historyInFlight.current === historyRequest.current) return;
    const key = `${selectedRepository.id}:${historyRef}`;
    const previous = append && historyPage?.key === key ? historyPage.commits : [];
    const request = ++historyRequest.current;
    historyInFlight.current = request;
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const page = props.conversationScope
        ? await props.client.loadConversationGitHistory(props.project.id, selectedRepository.id, previous.length, historyRef || undefined)
        : await window.zeus!.loadProjectGitHistory!({ projectId: props.project.id, repositoryId: selectedRepository.id, offset: previous.length, ...(historyRef ? { ref: historyRef } : {}) });
      if (request !== historyRequest.current) return;
      const commits = [...previous, ...page.commits].filter((commit, index, items) => items.findIndex((item) => item.hash === commit.hash) === index);
      setHistoryPage({ key, commits, hasMore: page.hasMore });
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
    const refresh = () => {
      if (document.visibilityState === 'visible' && !actionBusyRef.current) void loadWorkbench();
    };
    refresh();
    const unsubscribe = subscribeProjectGitRefresh(props.project.id, refresh);
    return () => {
      requestVersionRef.current += 1;
      unsubscribe();
    };
  }, [props.client, props.project.id]);

  useEffect(() => {
    if (snapshot?.projectId === props.project.id) projectGitWorkbenchCacheEntry(props.client, props.project.id).snapshot = snapshot;
  }, [props.client, props.project.id, snapshot]);

  useEffect(() => {
    window.localStorage.setItem(`zeus.project-git-tab-v2:${props.project.id}`, tab);
  }, [props.project.id, tab]);

  useEffect(() => {
    if (!props.conversationScope && tab === 'console') void operationHistory.refresh();
  }, [tab, operationHistory.refresh, props.conversationScope]);

  useEffect(() => {
    if (tab !== 'changes' || !snapshot) return;
    const repository = snapshot.repositories.find((candidate) => candidate.id === selectedRepositoryId) ?? snapshot.repositories[0];
    if (!repository) {
      if (selectedFilePath) setSelectedFilePath('');
      return;
    }
    if (repository.id !== selectedRepositoryId) setSelectedRepositoryId(repository.id);
    const unstagedPaths = new Set(repository.snapshot.fileStatuses.filter((file) => file.workingTreeStatus !== ' ' || file.indexStatus === '?').map((file) => file.path));
    const stagedPaths = new Set(repository.snapshot.fileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?').map((file) => file.path));
    const selectedPaths = selectedFileStage === 'staged' ? stagedPaths : unstagedPaths;
    if (selectedPaths.has(selectedFilePath)) return;
    const otherStagePaths = selectedFileStage === 'staged' ? unstagedPaths : stagedPaths;
    if (otherStagePaths.has(selectedFilePath)) {
      setSelectedFileStage(selectedFileStage === 'staged' ? 'unstaged' : 'staged');
      return;
    }
    const firstUnstagedPath = unstagedPaths.values().next().value;
    const firstStagedPath = stagedPaths.values().next().value;
    setSelectedFilePath(firstUnstagedPath ?? firstStagedPath ?? '');
    setSelectedFileStage(firstUnstagedPath ? 'unstaged' : 'staged');
  }, [snapshot, tab, selectedRepositoryId, selectedFilePath, selectedFileStage]);

  useEffect(() => {
    // 新选择立即清除旧详情，避免旧行高亮在异步读取期间冒充当前选择。
    setCommitDetail(null);
    const revision = tab === 'stash' ? activeStashRef : selectedCommitHash;
    if (!selectedRepository || !revision || (tab !== 'log' && tab !== 'stash')) {
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

  async function loadWorkbench(): Promise<void> {
    // 历史与仓库快照独立读取，仓库刷新失败不能伪装成没有操作记录。
    if (!props.conversationScope) void operationHistory.refresh();
    const version = ++requestVersionRef.current;
    setLoadState('loading');
    setError(null);
    try {
      const next = await requestProjectGitWorkbench(props.client, props.project.id);
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

  async function execute(repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string): Promise<ExecutionOutcome> {
    if (actionBusyRef.current) return null;
    actionBusyRef.current = true;
    requestVersionRef.current += 1;
    projectGitWorkbenchCacheEntry(props.client, props.project.id).request = null;
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
      if (action.type === 'submodule_update' || action.type === 'subtree') await loadWorkbench();
      notifyProjectGitChanged(props.project.id);
      if (response.result.outcome === 'conflict') setTab('changes');
      return response.result.outcome;
    } catch (reason) {
      const message = errorMessage(reason, zh, {
        title: label,
        ...((action.type === 'checkout' || action.type === 'checkout_revision' || action.type === 'create_branch') && errorHasCode(reason, 'ZEUS_GIT_CHECKOUT_BLOCKED')
          ? {
              action: {
                label: zh ? '打开贮藏入口' : 'Open stash action',
                onClick: () => {
                  setSelectedRepositoryId(repository.id);
                  setStashRepositoryId(repository.id);
                },
              },
            }
          : {}),
      });
      operationErrorsByRepositoryRef.current = { ...operationErrorsByRepositoryRef.current, [repository.id]: message };
      await loadWorkbench();
      setError(`${label}: ${message}`);
      return null;
    } finally {
      actionBusyRef.current = false;
      setBusy(null);
      if (!props.conversationScope) void operationHistory.refresh(true);
    }
  }

  async function generateCommitMessage(repository: ProjectGitRepositoryWorkbenchItem): Promise<void> {
    if (generatingCommitRef.current || busy || commitModelsLoading || !commitModelRef) return;
    generatingCommitRef.current = true;
    const controller = new AbortController();
    commitGenerationController.current = controller;
    setGeneratingCommitFor(repository.id);
    setCommitGenerationFeedback((current) => ({ ...current, [repository.id]: '' }));
    const originalMessage = commitDrafts[repository.id] ?? '';
    let lastGenerated = originalMessage;
    const updateGenerated = (message: string) => {
      const expected = lastGenerated;
      lastGenerated = message;
      setCommitDrafts((current) => ((current[repository.id] ?? '') === expected ? { ...current, [repository.id]: message } : current));
    };
    try {
      const result = await props.client.generateGitCommitMessage(
        props.project.id,
        { repositoryId: repository.id, relativePath: repository.relativePath, language: zh ? 'zh-CN' : 'en', modelRef: commitModelRef },
        (text) => {
          if (!controller.signal.aborted) updateGenerated(text);
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      updateGenerated(result.message);
      setCommitGenerationFeedback((current) => ({
        ...current,
        [repository.id]:
          (zh ? `已由 ${result.model} 生成，请检查后提交。` : `Generated by ${result.model}. Review before committing.`) +
          (result.truncated ? (zh ? ' 部分大文件或生成文件仅提供摘要，请核对完整性。' : ' Large or generated files were summarized; check completeness.') : ''),
      }));
    } catch (reason) {
      updateGenerated(originalMessage);
      setCommitGenerationFeedback((current) => ({ ...current, [repository.id]: controller.signal.aborted ? (zh ? '已停止生成，已保留原提交说明。' : 'Generation stopped. The original message was preserved.') : errorMessage(reason, zh) }));
    } finally {
      generatingCommitRef.current = false;
      if (commitGenerationController.current === controller) commitGenerationController.current = null;
      setGeneratingCommitFor(null);
    }
  }

  function showGitContextMenu(event: ReactMouseEvent, target: GitContextTarget): void {
    event.preventDefault();
    event.stopPropagation();
    const repository = repositories.find((item) => item.id === target.repositoryId);
    if (!repository) return;
    const copy = (text: string) => navigator.clipboard.writeText(text);
    const label = (cn: string, en: string) => (zh ? cn : en);
    const items: GitMenuItem[] = [];
    const action = (title: string, value: ProjectGitAction, confirmation?: string, danger = false, disabled = false) =>
      items.push({
        label: title,
        disabled: busy !== null || disabled,
        danger,
        run: () => {
          if (confirmation) setMenuConfirmation({ title, description: `${repository.name} · ${target.ref}\n${confirmation}`, danger, run: async () => (await execute(repository, value, title)) === 'completed' });
          else return execute(repository, value, title).then(() => {});
        },
      });
    const form = (title: string, field: string, build: (text: string) => ProjectGitAction, initialValue = '') =>
      items.push({
        label: title,
        disabled: busy !== null,
        run: () => setMenuConfirmation({ title, description: `${repository.name} · ${target.ref}`, field, initialValue, run: async (text) => (await execute(repository, build(text), title)) === 'completed' }),
      });
    const newBranch = (baseRef: string) => form(label('新建分支…', 'New branch…'), label('分支名称', 'Branch name'), (branchName) => ({ type: 'create_branch', branchName, baseRef }));
    if (target.kind === 'file' || target.kind === 'directory' || target.kind === 'stage') {
      const files = repository.snapshot.fileStatuses
        .filter((file) => !subtree || subtree.repositoryId !== repository.id || file.path === subtree.path || file.path.startsWith(`${subtree.path}/`))
        .filter(
          (file) =>
            (target.kind === 'stage' || file.path === target.ref || (target.kind === 'directory' && file.path.startsWith(`${target.ref}/`))) &&
            (target.stage === 'staged' ? file.indexStatus !== ' ' && file.indexStatus !== '?' : file.workingTreeStatus !== ' ' || file.indexStatus === '?'),
        );
      const paths = files.map((file) => file.path);
      action(target.stage === 'staged' ? label('取消暂存', 'Unstage') : label('暂存', 'Stage'), { type: target.stage === 'staged' ? 'unstage' : 'stage', paths }, undefined, false, !paths.length);
      if (target.kind === 'file') items.push({ label: label('查看差异', 'View diff'), run: () => openDiffWindow(repository, target.ref, { stage: target.stage }) });
      if (target.stage !== 'staged') {
        const tracked = files.filter((file) => file.indexStatus !== '?').map((file) => file.path);
        action(
          label('丢弃未暂存修改…', 'Discard unstaged changes…'),
          { type: 'discard', paths: tracked },
          label(`将 ${tracked.length} 个已跟踪文件恢复为暂存区内容。未跟踪文件不会被删除。此操作无法撤销。\n${tracked.join('\n')}`, `Restore ${tracked.length} tracked files from the index. Untracked files are kept. This cannot be undone.`),
          true,
          !tracked.length || repository.snapshot.conflictFiles.length > 0,
        );
      }
      if (target.kind !== 'stage') items.push({ label: label('复制相对路径', 'Copy relative path'), run: () => copy(target.ref) });
    } else if (target.kind === 'local' || target.kind === 'remote') {
      const current = target.kind === 'local' && !repository.snapshot.detached && repository.snapshot.branch === target.ref;
      if (target.kind === 'local') action(label('切换到此分支', 'Checkout branch'), { type: 'checkout', branchName: target.ref }, undefined, false, current);
      else {
        const remote = target.ref.split('/')[0]!;
        action(label('获取此远程', 'Fetch remote'), { type: 'fetch', remote });
        form(
          label('检出为本地跟踪分支…', 'Checkout tracking branch…'),
          label('本地分支名称', 'Local branch name'),
          (branchName) => ({ type: 'create_branch', branchName, baseRef: target.ref, trackRemote: true }),
          target.ref.slice(remote.length + 1),
        );
      }
      items.push({ label: label('与当前分支比较', 'Compare with current branch'), run: () => openDiffWindow(repository, '', { comparisonRef: target.ref, comparisonMode: 'current' }) });
      items.push({ label: label('与工作区比较', 'Compare with working tree'), run: () => openDiffWindow(repository, '', { comparisonRef: target.ref, comparisonMode: 'working-tree' }) });
      newBranch(target.ref);
      action(
        label(`将“${target.ref}”合并到“${repository.snapshot.branch}”…`, `Merge '${target.ref}' into '${repository.snapshot.branch}'…`),
        { type: 'merge', branchName: target.ref },
        label(
          `将来源分支“${target.ref}”合并到目标分支“${repository.snapshot.branch}”，可能产生合并提交或冲突。`,
          `Merge source branch '${target.ref}' into target branch '${repository.snapshot.branch}'. This may create a merge commit or conflicts.`,
        ),
        false,
        current || repository.snapshot.detached,
      );
      action(
        label('将当前分支变基到此处…', 'Rebase current branch here…'),
        { type: 'rebase', branchName: target.ref },
        label('这会重写当前分支的本地提交历史。', 'This rewrites the current branch history.'),
        true,
        current || repository.snapshot.detached,
      );
      if (target.kind === 'local') {
        form(label('重命名分支…', 'Rename branch…'), label('新名称', 'New name'), (newName) => ({ type: 'rename_branch', branchName: target.ref, newName }), target.ref);
        action(
          label('删除本地分支…', 'Delete local branch…'),
          { type: 'delete_branch', branchName: target.ref },
          label('仅删除本地分支；Git 会拒绝删除尚未合入的分支。', 'Only delete the local branch. Git refuses unmerged branches.'),
          true,
          current,
        );
      }
      items.push({ label: label('复制分支名', 'Copy branch name'), run: () => copy(target.ref) });
    } else if (target.kind === 'commit' || target.kind === 'tag') {
      const revision = target.kind === 'tag' ? `refs/tags/${target.ref}` : target.ref;
      items.push({
        label: label('查看提交详情', 'View commit details'),
        run: () => {
          setTab('log');
          selectCommit(repository, revision);
        },
      });
      items.push({ label: label('与当前分支比较', 'Compare with current branch'), run: () => openDiffWindow(repository, '', { comparisonRef: revision, comparisonMode: 'current' }) });
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
      newBranch(revision);
      items.push({
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
      items.push({ label: target.kind === 'tag' ? label('复制标签名', 'Copy tag name') : label('复制提交哈希', 'Copy commit hash'), run: () => copy(target.ref) });
      const commit = repository.snapshot.recentCommits.find((item) => item.hash === target.ref);
      if (commit) items.push({ label: label('复制提交说明', 'Copy commit message'), run: () => copy(commit.subject) });
    } else if (target.kind === 'stash') {
      action(label('应用贮藏', 'Apply stash'), { type: 'apply_stash', stashRef: target.ref });
      action(label('应用并移除贮藏…', 'Pop stash…'), { type: 'apply_stash', stashRef: target.ref, pop: true }, label('应用成功后删除该贮藏；发生冲突时保留。', 'Remove the stash after successful application; keep it on conflicts.'));
      action(label('删除贮藏…', 'Drop stash…'), { type: 'drop_stash', stashRef: target.ref }, label('将永久删除该贮藏，无法撤销。', 'Permanently delete this stash. This cannot be undone.'), true);
      items.push({ label: label('复制贮藏引用', 'Copy stash reference'), run: () => copy(target.ref) });
    } else {
      items.push({
        label: label('查看文件状态', 'View file status'),
        run: () => {
          setSelectedRepositoryId(repository.id);
          setTab('changes');
        },
      });
      items.push({
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
        label: label('推送…', 'Push…'),
        disabled: busy !== null,
        run: () => {
          setSelectedRepositoryId(repository.id);
          setPushOpen(true);
        },
      });
      items.push({
        label: label('贮藏当前修改…', 'Stash changes…'),
        disabled: busy !== null || repository.snapshot.clean || repository.snapshot.conflictFiles.length > 0,
        run: () => {
          setSelectedRepositoryId(repository.id);
          setStashRepositoryId(repository.id);
        },
      });
      items.push({ label: label('复制仓库名称', 'Copy repository name'), run: () => copy(repository.name) });
    }
    setContextMenu({ x: event.clientX, y: event.clientY, title: target.ref || repository.name, items });
  }

  /** 提交、分支和标签入口共用显式选择，后台刷新不再自动选中首条提交。 */
  function selectCommit(repository: ProjectGitRepositoryWorkbenchItem, commitHash: string): void {
    setSelectedRepositoryId(repository.id);
    setSelectedCommit({ repositoryId: repository.id, ref: commitHash });
  }

  function openCommit(): void {
    setTab('changes');
    setCommitRequest((value) => value + 1);
  }

  function openDiffWindow(repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }): void {
    if (props.conversationScope) {
      const request = options?.comparisonRef
        ? props.client.loadProjectGitComparisonDiff(props.project.id, repository.id, options.comparisonRef, options.comparisonMode ?? 'current')
        : options?.commitHash
          ? props.client.loadProjectGitCommit(props.project.id, repository.id, options.commitHash).then((detail) => detail.diff)
          : Promise.resolve(options?.stage === 'staged' ? repository.snapshot.stagedDiff : options?.stage === 'unstaged' ? repository.snapshot.unstagedDiff : repository.snapshot.diff);
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

  if (loadState === 'loading' && !snapshot) {
    return (
      <section className="project-git-workbench-state" aria-live="polite">
        <CircleNotch aria-hidden="true" className="project-git-spinner" />
        <strong>{zh ? '正在读取项目的 Git 状态' : 'Loading the project’s Git status'}</strong>
        <span>{zh ? '正在查找项目中的 Git 仓库。' : 'Finding Git repositories in this project.'}</span>
      </section>
    );
  }

  if (loadState === 'error' && !snapshot) {
    return (
      <section className="project-git-workbench-state" role="alert">
        <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        <Button variant="secondary" onClick={() => void loadWorkbench()}>
          {zh ? '重新读取' : 'Reload'}
        </Button>
      </section>
    );
  }

  if (repositories.length === 0) {
    return (
      <section className="project-git-workbench-state">
        <GitBranch aria-hidden="true" />
        <strong>{zh ? '这个项目中没有发现 Git 仓库' : 'No Git repository was found'}</strong>
        <span>{zh ? '请检查项目目录是否包含 Git 仓库，然后重新扫描。' : 'Check that the project folder contains a Git repository, then scan again.'}</span>
        <Button variant="secondary" onClick={() => void loadWorkbench()}>
          {zh ? '重新扫描' : 'Scan again'}
        </Button>
      </section>
    );
  }

  return (
    <section
      className="project-git-workbench"
      onContextMenu={(event) => {
        const element = (event.target as HTMLElement).closest<HTMLElement>('[data-git-context]');
        if (element?.dataset.gitContext) showGitContextMenu(event, JSON.parse(element.dataset.gitContext) as GitContextTarget);
      }}
      aria-label={zh ? '项目 Git 工作台' : 'Project Git workbench'}
    >
      <header className="project-git-toolbar git-command-toolbar" aria-label={zh ? 'Git 工具栏' : 'Git toolbar'}>
        <div className="git-toolbar-identity">
          <div className="git-toolbar-repository" title={selectedRepository?.relativePath}>
            <Folder aria-hidden="true" />
            <span>{selectedRepository?.name ?? props.project.name}</span>
          </div>
          {selectedRepository ? (
            <BranchSwitcher
              zh={zh}
              repositories={repositories}
              selectedRepository={selectedRepository}
              busy={busy}
              onSelectRepository={setSelectedRepositoryId}
              onExecute={execute}
              onOpenDiff={openDiffWindow}
              onOpenUpdate={() => setUpdateOpen(true)}
              onOpenCommit={openCommit}
              onOpenPush={() => setPushOpen(true)}
              onOpenNewBranch={(baseRef) => {
                setNewBranchBase(baseRef ?? '');
                setNewBranchOpen(true);
              }}
              onOpenRevision={() => setRevisionOpen(true)}
            />
          ) : null}
        </div>
        <button type="button" disabled={!selectedRepository || busy !== null} onClick={openCommit}>
          <GitCommit />
          <span>{zh ? '提交' : 'Commit'}</span>
        </button>
        <i />
        <button type="button" disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || !selectedRepository.snapshot.remotes.length} onClick={() => setPullOpen(true)}>
          <ArrowDown />
          <span>{zh ? '拉取' : 'Pull'}</span>
          {selectedRepository?.snapshot.behind ? <small>{selectedRepository.snapshot.behind}</small> : null}
        </button>
        <button type="button" disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || !selectedRepository.snapshot.remotes.length} onClick={() => setPushOpen(true)}>
          <ArrowUp />
          <span>{zh ? '推送' : 'Push'}</span>
          {selectedRepository?.snapshot.ahead ? <small>{selectedRepository.snapshot.ahead}</small> : null}
        </button>
        <button
          type="button"
          disabled={!selectedRepository || busy !== null || !selectedRepository.snapshot.remotes.length}
          onClick={() => {
            if (selectedRepository) void execute(selectedRepository, { type: 'fetch' }, zh ? '获取远端' : 'Fetch');
          }}
        >
          <ArrowsClockwise />
          <span>{zh ? '抓取' : 'Fetch'}</span>
        </button>
        <i />
        <button
          type="button"
          disabled={!selectedRepository || busy !== null}
          onClick={() => {
            setNewBranchBase('');
            setNewBranchOpen(true);
          }}
        >
          <GitBranch />
          <span>{zh ? '分支' : 'Branch'}</span>
        </button>
        <button type="button" disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || Boolean(selectedRepository.snapshot.integrationState)} onClick={() => setMergeOpen(true)}>
          <GitMerge />
          <span>{zh ? '合并' : 'Merge'}</span>
        </button>
        <button
          type="button"
          disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.clean || selectedRepository.snapshot.conflictFiles.length > 0}
          onClick={() => {
            if (selectedRepository) setStashRepositoryId(selectedRepository.id);
          }}
        >
          <Archive />
          <span>{zh ? '贮藏' : 'Stash'}</span>
        </button>
        <span className="project-git-menu-anchor">
          <button ref={operationsTriggerRef} type="button" aria-haspopup="menu" aria-expanded={operationsOpen} onClick={() => setOperationsOpen((current) => !current)}>
            <DotsThree aria-hidden="true" />
            <span>{zh ? '操作' : 'Actions'}</span>
          </button>
          <MotionPresence>
            {operationsOpen ? (
              <OperationsMenu
                anchor={operationsTriggerRef.current}
                zh={zh}
                onClose={() => setOperationsOpen(false)}
                onOpenCommit={openCommit}
                onOpenPush={() => setPushOpen(true)}
                onOpenUpdate={() => setUpdateOpen(true)}
                onOpenNewBranch={() => {
                  setNewBranchBase('');
                  setNewBranchOpen(true);
                }}
                onOpenRevision={() => setRevisionOpen(true)}
                onSelectTab={setTab}
                onOpenConsole={props.conversationScope ? undefined : () => setTab('console')}
                onOpenSubtree={() => setSubtreeDialogOpen(true)}
              />
            ) : null}
          </MotionPresence>
        </span>

        <button type="button" disabled={busy !== null} onClick={() => void loadWorkbench()}>
          <ArrowsClockwise />
          <span>{zh ? '刷新' : 'Refresh'}</span>
        </button>
      </header>
      {busy || selectedRepository?.snapshot.integrationState ? (
        <div className="git-integration-actions">
          {' '}
          {busy && !props.conversationScope && window.zeus?.cancelProjectGitAction ? (
            <Button
              variant="secondary"
              size="compact"
              onClick={() => {
                void window.zeus!.cancelProjectGitAction(busy.repositoryId).catch((reason: unknown) => setError(errorMessage(reason, zh)));
              }}
            >
              {zh ? '中止操作' : 'Stop operation'}
            </Button>
          ) : null}
          {selectedRepository?.snapshot.integrationState ? (
            <>
              <Button
                variant="secondary"
                size="compact"
                disabled={busy !== null || selectedRepository.snapshot.conflictFiles.length > 0}
                onClick={() => void execute(selectedRepository, { type: 'continue_integration', kind: selectedRepository.snapshot.integrationState! }, zh ? '继续合并或变基' : 'Continue integration')}
              >
                {zh ? '继续' : 'Continue'}
              </Button>
              <Button
                variant="secondary"
                size="compact"
                disabled={busy !== null}
                onClick={() => void execute(selectedRepository, { type: 'abort_integration', kind: selectedRepository.snapshot.integrationState! }, zh ? '终止合并或变基' : 'Abort integration')}
              >
                {zh ? '终止合并/变基' : 'Abort integration'}
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
            <small>{zh ? '请在变更页逐个检查冲突，解决后暂存文件，再继续合并或变基。' : 'Review each file in Local Changes, stage resolved files, then continue the merge or rebase.'}</small>
          </span>
          <Button variant="secondary" size="compact" onClick={() => setTab('changes')}>
            {zh ? '处理冲突' : 'Resolve conflicts'}
          </Button>
        </section>
      ) : null}

      <div className="project-git-browser-layout">
        <aside className="project-git-navigator" aria-label={zh ? 'Git 导航' : 'Git navigation'}>
          <nav className="git-workspace-navigation" aria-label={zh ? 'Git 工作区' : 'Git workspace'}>
            <strong>{zh ? '工作区' : 'Workspace'}</strong>
            {(
              [
                ['changes', zh ? '文件状态' : 'File Status', <File key="file" />, changedCount],
                ['log', zh ? '历史' : 'History', <History key="history" />, null],
              ] as const
            ).map(([id, label, icon, count]) => (
              <button type="button" key={id} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
                {icon}
                <span>{label}</span>
                {count !== null ? <small>{count}</small> : null}
              </button>
            ))}
          </nav>
          {selectedRepository?.snapshot.submodules?.length ? (
            <details>
              <summary className="project-git-reference-section-heading">
                <span>{zh ? '子模块初始化与更新' : 'Initialize / update submodules'}</span>
              </summary>
              {selectedRepository.snapshot.submodules.map((module) => (
                <button
                  type="button"
                  key={module.path}
                  disabled={busy !== null}
                  title={zh ? '检出父仓库记录的子模块提交，保留未提交修改；有冲突时 Git 会拒绝更新。' : 'Check out the recorded submodule commit without forcing local changes.'}
                  onClick={() => void execute(selectedRepository, { type: 'submodule_update', path: module.path }, zh ? '初始化/更新子模块' : 'Initialize/update submodule')}
                >
                  <span>{module.path}</span>
                  <small>{module.initialized ? (zh ? '更新' : 'Update') : zh ? '初始化' : 'Initialize'}</small>
                </button>
              ))}
            </details>
          ) : null}
          {[
            { title: zh ? '仓库' : 'Repositories', items: repositories.filter((repository) => !repository.isSubmodule) },
            { title: zh ? '子模块' : 'Submodules', items: repositories.filter((repository) => repository.isSubmodule) },
          ]
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <details key={group.title} open>
                <summary className="project-git-reference-section-heading">
                  <span>{group.title}</span>
                  <small>{group.items.length}</small>
                </summary>
                <RepositoryNavigationTree
                  repositories={group.items}
                  zh={zh}
                  selectedId={selectedRepository?.id}
                  onSelect={(id) => {
                    setSubtree(null);
                    setSelectedRepositoryId(id);
                    setSelectedFilePath('');
                    setSelectedCommit(null);
                  }}
                />
              </details>
            ))}
          {selectedRepository ? (
            <>
              {(
                [
                  [zh ? '分支' : 'Branches', selectedRepository.snapshot.localBranches, 'local'],
                  [zh ? '远程' : 'Remotes', selectedRepository.snapshot.remoteBranches, 'remote'],
                  [zh ? '标签' : 'Tags', selectedRepository.snapshot.tags, 'local'],
                ] as const
              ).map(([title, branches, kind]) => (
                <details key={title} open={branches === selectedRepository.snapshot.localBranches ? true : undefined}>
                  <summary className="project-git-reference-section-heading">
                    {branches === selectedRepository.snapshot.localBranches ? <GitBranch className="project-git-branch-section-icon" aria-hidden="true" /> : null}
                    <span>{title}</span>
                    <small>{branches.length}</small>
                  </summary>
                  <BranchDirectoryTree
                    hideBranchIcons={branches === selectedRepository.snapshot.localBranches}
                    branches={[...branches]}
                    current={branches === selectedRepository.snapshot.localBranches && !selectedRepository.snapshot.detached ? selectedRepository.snapshot.branch : ''}
                    selected={tab === 'log' ? (historyRef === 'HEAD' ? selectedRepository.snapshot.branch : historyRef) : ''}
                    branchDivergences={
                      branches === selectedRepository.snapshot.localBranches
                        ? {
                            ...selectedRepository.snapshot.branchDivergences,
                            [selectedRepository.snapshot.branch]: {
                              ahead: selectedRepository.snapshot.ahead,
                              behind: selectedRepository.snapshot.behind,
                            },
                          }
                        : undefined
                    }
                    kind={kind}
                    zh={zh}
                    onSelect={(ref) => {
                      if (title === (zh ? '分支' : 'Branches')) {
                        setTab('log');
                        setHistoryRef(ref);
                        selectCommit(selectedRepository, ref);
                        return;
                      }
                      setTab('log');
                      setHistoryRef(ref);
                      selectCommit(selectedRepository, ref);
                    }}
                    onCheckout={
                      branches === selectedRepository.snapshot.tags
                        ? undefined
                        : (ref) => {
                            if (kind === 'remote') {
                              setRemoteCheckoutTarget({ repositoryId: selectedRepository.id, remoteRef: ref });
                              return;
                            }
                            if (!selectedRepository.snapshot.detached && selectedRepository.snapshot.branch === ref) return;
                            void execute(selectedRepository, { type: 'checkout', branchName: ref }, zh ? `切换到分支“${ref}”` : `Checkout '${ref}'`).then((outcome) => {
                              if (outcome !== 'completed') return;
                              setTab('log');
                              setHistoryRef('');
                              setSelectedCommit(null);
                            });
                          }
                    }
                    onContextMenu={(event, ref) => showGitContextMenu(event, { kind: branches === selectedRepository.snapshot.tags ? 'tag' : kind, repositoryId: selectedRepository.id, ref })}
                  />
                </details>
              ))}
              <details>
                <summary className="project-git-reference-section-heading">
                  <span>{zh ? '贮藏区' : 'Stashes'}</span>
                  <small>{selectedRepository.snapshot.stashes.length}</small>
                </summary>
                {selectedRepository.snapshot.stashes.map((stash) => (
                  <button
                    key={stash.ref}
                    className="project-git-navigation-stash"
                    data-git-context={JSON.stringify({ kind: 'stash', repositoryId: selectedRepository.id, ref: stash.ref })}
                    type="button"
                    aria-current={tab === 'stash' && activeStashRef === stash.ref ? 'true' : undefined}
                    onClick={() => {
                      setSelectedStashRef(stash.ref);
                      setTab('stash');
                    }}
                    title={stash.subject}
                  >
                    <Archive aria-hidden="true" />
                    <span>{stash.subject}</span>
                  </button>
                ))}
              </details>
              <details>
                <summary className="project-git-reference-section-heading">
                  <span>{zh ? '子树' : 'Subtrees'}</span>
                </summary>
                {(selectedRepository.subtreePaths ?? []).map((path) => (
                  <button
                    key={path}
                    type="button"
                    onClick={() => {
                      setSubtree({ repositoryId: selectedRepository.id, path });
                      setSelectedFilePath('');
                      setTab('changes');
                    }}
                  >
                    <Folder aria-hidden="true" />
                    <span>{path}</span>
                  </button>
                ))}
              </details>
            </>
          ) : null}
        </aside>
        <GitPaneSeparator name="navigation" label={zh ? '调整 Git 导航宽度' : 'Resize Git navigation'} initial={20} min={12} max={40} />
        <div className="project-git-browser-content">
          <div className="git-content-toolbar">
            <strong>{tab === 'changes' ? (zh ? '文件状态' : 'File Status') : tab === 'log' ? (zh ? '提交历史' : 'Commit history') : tab === 'stash' ? (zh ? '贮藏' : 'Stashes') : zh ? '操作记录' : 'Operation history'}</strong>
            {tab === 'log' && selectedRepository ? (
              <select
                aria-label={zh ? '历史分支范围' : 'History branch scope'}
                value={historyRef}
                onChange={(event) => {
                  setHistoryRef(event.currentTarget.value);
                  setSelectedCommit(null);
                  setSelectedFilePath('');
                }}
              >
                <option value="">{zh ? '全部分支' : 'All branches'}</option>
                <option value="HEAD">{zh ? '当前分支' : 'Current branch'}</option>
                {[...new Set([...selectedRepository.snapshot.localBranches, ...selectedRepository.snapshot.remoteBranches, ...selectedRepository.snapshot.tags])].map((ref) => (
                  <option key={ref} value={ref}>
                    {ref}
                  </option>
                ))}
              </select>
            ) : null}
            {tab === 'changes' || tab === 'log' ? (
              <label>
                <MagnifyingGlass />
                <input
                  aria-label={tab === 'changes' ? (zh ? '筛选更改文件' : 'Filter changed files') : zh ? '搜索提交' : 'Search commits'}
                  value={tab === 'changes' ? fileQuery : searchQuery}
                  onChange={(event) => (tab === 'changes' ? setFileQuery(event.currentTarget.value) : setSearchQuery(event.currentTarget.value))}
                  placeholder={tab === 'changes' ? (zh ? '筛选文件…' : 'Filter files…') : zh ? '搜索提交、作者或哈希…' : 'Search commits, authors or hashes…'}
                />
              </label>
            ) : null}
          </div>
          {tab === 'log' ? (
            <GitLogSurface
              projectId={props.project.id}
              zh={zh}
              repositories={repositories}
              commits={allCommits.filter(({ repository }) => repository.id === selectedRepository?.id)}
              historyLoading={historyLoading}
              historyError={historyError}
              historyHasMore={historyPage?.key === `${selectedRepository?.id}:${historyRef}` && historyPage.hasMore}
              onLoadMore={() => void loadHistory(true)}
              selectedRepository={selectedRepository}
              selectedCommitHash={commitDetail?.commit.hash ?? selectedCommitHash}
              commitDetail={commitDetail}
              commitLoading={commitLoading}
              selectedFilePath={selectedFilePath}
              onSelectRepository={setSelectedRepositoryId}
              onSelectCommit={selectCommit}
              onOpenChanges={() => setTab('changes')}
              onSelectFile={setSelectedFilePath}
              busy={busy}
              onExecute={execute}
              onOpenDiff={openDiffWindow}
              onConfirmAction={(repository, action, title, description, danger) =>
                setMenuConfirmation({
                  title,
                  description: `${repository.name} · ${action.revision}` + (description ? `\n${description}` : ''),
                  danger,
                  run: async () => (await execute(repository, action, title)) === 'completed',
                })
              }
            />
          ) : tab === 'changes' ? (
            <LocalChangesSurface
              query={fileQuery}
              commitRequest={commitRequest}
              previewRevision={snapshot?.refreshedAt}
              projectId={props.project.id}
              subtree={subtree}
              onClearSubtree={() => setSubtree(null)}
              zh={zh}
              onOpenStash={() => setTab('stash')}
              repositories={repositories}
              selectedRepository={selectedRepository}
              selectedFilePath={selectedFilePath}
              selectedFileStage={selectedFileStage}
              busy={busy}
              onSelectRepository={setSelectedRepositoryId}
              onSelectFile={(path, stage) => {
                setSelectedFilePath(path);
                setSelectedFileStage(stage);
              }}
              onOpenDiff={openDiffWindow}
              onExecute={execute}
              onConfirmAction={(repository, action, title, description, danger) =>
                setMenuConfirmation({
                  title,
                  description: `${repository.name}\n${description}`,
                  danger,
                  run: async () => (await execute(repository, action, title)) === 'completed',
                })
              }
              onCommit={() => setCommitOpen(true)}
              commitDrafts={commitDrafts}
              commitModels={commitModels}
              commitModelRef={commitModelRef}
              commitModelsLoading={commitModelsLoading}
              commitModelsError={commitModelsError}
              onSelectCommitModel={selectCommitModel}
              onRefreshCommitModels={() => setCommitModelsRefresh((current) => current + 1)}
              generatingCommitFor={generatingCommitFor}
              generationFeedback={selectedRepository ? commitGenerationFeedback[selectedRepository.id] : undefined}
              onGenerateCommitMessage={generateCommitMessage}
              onStopCommitGeneration={() => commitGenerationController.current?.abort()}
              onCommitMessageChange={(repositoryId, message) => setCommitDrafts((current) => ({ ...current, [repositoryId]: message }))}
            />
          ) : tab === 'stash' ? (
            <StashSurface
              projectId={props.project.id}
              zh={zh}
              repository={selectedRepository}
              stash={activeStash}
              detail={commitDetail?.commit.hash === activeStash?.hash ? commitDetail : null}
              loading={commitLoading}
              selectedFilePath={selectedFilePath}
              busy={busy}
              onSelectFile={setSelectedFilePath}
              onOpenDiff={openDiffWindow}
              onExecute={execute}
            />
          ) : (
            <ConsoleSurface zh={zh} history={operationHistory} />
          )}
        </div>
      </div>

      <MotionPresence>{mergeOpen && selectedRepository ? <MergeBranchDialog repository={selectedRepository} zh={zh} busy={busy} onClose={() => setMergeOpen(false)} onExecute={execute} /> : null}</MotionPresence>
      <MotionPresence>
        {subtreeDialogOpen && selectedRepository ? <SubtreeManagementDialog key={selectedRepository.id} repository={selectedRepository} zh={zh} busy={busy} onClose={() => setSubtreeDialogOpen(false)} onExecute={execute} /> : null}
      </MotionPresence>
      <MotionPresence>{contextMenu ? <GitContextMenu {...contextMenu} onClose={() => setContextMenu(null)} onError={(reason) => setError(errorMessage(reason, zh))} /> : null}</MotionPresence>
      <MotionPresence>{menuConfirmation ? <GitMenuActionDialog value={menuConfirmation} zh={zh} onClose={() => setMenuConfirmation(null)} /> : null}</MotionPresence>
      <MotionPresence>{commitOpen ? <CommitDialog open={commitOpen} zh={zh} repositories={repositories} busy={busy} onClose={() => setCommitOpen(false)} onExecute={execute} /> : null}</MotionPresence>
      <MotionPresence>{stashRepository ? <StashDialog key={stashRepository.id} repository={stashRepository} zh={zh} busy={busy} onClose={() => setStashRepositoryId(null)} onExecute={execute} /> : null}</MotionPresence>
      <MotionPresence>
        {updateOpen ? (
          <UpdateProjectDialog
            open={updateOpen}
            projectId={props.project.id}
            zh={zh}
            repositories={repositories}
            busy={busy}
            errorsByRepository={operationErrorsByRepositoryRef.current}
            onClose={() => setUpdateOpen(false)}
            onExecute={execute}
          />
        ) : null}
      </MotionPresence>
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
            onExecute={execute}
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
            open={pushOpen}
            zh={zh}
            repositories={repositories}
            selectedRepository={selectedRepository}
            busy={busy}
            results={pushResults}
            onClose={() => {
              setPushOpen(false);
              setPushResults([]);
            }}
            onPush={async (selections, forceWithLease, pushTags) => {
              const results: Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }> = [];
              for (const selection of selections) {
                const repository = repositories.find((candidate) => candidate.id === selection.repositoryId)!;
                const ok = await execute(
                  repository,
                  { type: 'push', remote: selection.remote, sourceBranch: selection.sourceBranch, targetBranch: selection.targetBranch, setUpstream: selection.setUpstream, forceWithLease, pushAllTags: pushTags },
                  zh ? '推送提交' : 'Push commits',
                );
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

const gitHistoryRowHeight = 28;

function GitLogSurface(props: {
  /** 仓库预览所属项目。 */
  projectId: string;
  zh: boolean;
  historyLoading: boolean;
  historyError: string;
  historyHasMore: boolean;
  onLoadMore: () => void;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  commits: Array<{ repository: ProjectGitRepositoryWorkbenchItem; commit: ProjectGitRepositoryWorkbenchItem['snapshot']['recentCommits'][number] }>;
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  selectedCommitHash: string;
  commitDetail: ProjectGitCommitDetail | null;
  commitLoading: boolean;
  selectedFilePath: string;
  onSelectRepository: (repositoryId: string) => void;
  onSelectCommit: (repository: ProjectGitRepositoryWorkbenchItem, commitHash: string) => void;
  onOpenChanges: () => void;
  onSelectFile: (path: string) => void;
  busy: BusyState;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
  onConfirmAction: (repository: ProjectGitRepositoryWorkbenchItem, action: Extract<ProjectGitAction, { type: 'revert' | 'cherry_pick' }>, title: string, description: string, danger?: boolean) => void;
}) {
  const selectedDiff = props.commitDetail?.diff.fileDiffs.find((file) => file.newPath === props.selectedFilePath || file.oldPath === props.selectedFilePath) ?? null;
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setCommitMenu(null);
  }, [props.selectedRepository?.id, props.commitDetail?.commit.hash, props.commitLoading, props.busy]);
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; repository: ProjectGitRepositoryWorkbenchItem; branch: string; kind: BranchKind } | null>(null);
  const historyScroll = useRef<HTMLDivElement>(null);
  const historySentinel = useRef<HTMLDivElement>(null);
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
  return (
    <div className="project-git-log-layout" style={{ '--git-history-row-height': `${gitHistoryRowHeight}px` } as React.CSSProperties}>
      <aside className="project-git-repository-rail">
        <header>
          <strong>{props.zh ? '仓库与分支' : 'Repositories and branches'}</strong>
        </header>
        {props.repositories.map((repository) => (
          <section key={repository.id} className={repository.id === props.selectedRepository?.id ? 'is-current' : ''}>
            <button type="button" className="project-git-repository-row" onClick={() => props.onSelectRepository(repository.id)}>
              <GitBranch aria-hidden="true" />
              <span>
                <strong>{repository.name}</strong>
                <small>{repository.relativePath === '.' ? repository.snapshot.branch : `${repository.relativePath} · ${repository.snapshot.branch}`}</small>
              </span>
              {repository.snapshot.fileStatuses.length > 0 ? <em>{repository.snapshot.fileStatuses.length}</em> : null}
            </button>
            <div className="project-git-branch-tree">
              <span>{props.zh ? '本地分支' : 'Local branches'}</span>
              <BranchDirectoryTree
                branches={repository.snapshot.localBranches}
                current={repository.snapshot.branch}
                kind="local"
                zh={props.zh}
                onContextMenu={(event, branch) => {
                  event.preventDefault();
                  setBranchMenu({ x: event.clientX, y: event.clientY, repository, branch, kind: 'local' });
                }}
              />
              {repository.snapshot.remoteBranches.length > 0 ? <span>{props.zh ? '远程分支' : 'Remote branches'}</span> : null}
              <BranchDirectoryTree
                branches={repository.snapshot.remoteBranches}
                current=""
                kind="remote"
                zh={props.zh}
                onContextMenu={(event, branch) => {
                  event.preventDefault();
                  setBranchMenu({ x: event.clientX, y: event.clientY, repository, branch, kind: 'remote' });
                }}
              />
            </div>
          </section>
        ))}
      </aside>
      <main className="project-git-commit-list">
        <header className="project-git-list-header">
          <span className="git-history-graph-heading">{props.zh ? '图表' : 'Graph'}</span>
          <span>{props.zh ? '描述' : 'Description'}</span>
          <span>{props.zh ? '提交' : 'Commit'}</span>
          <span>{props.zh ? '作者' : 'Author'}</span>
          <span>{props.zh ? '日期' : 'Date'}</span>
        </header>
        {props.selectedRepository && props.selectedRepository.snapshot.fileStatuses.length > 0 ? (
          <button type="button" className="project-git-commit-row git-working-copy-row" onClick={props.onOpenChanges}>
            <span className="project-git-commit-subject">
              <strong>{props.zh ? '未提交的更改' : 'Uncommitted changes'}</strong>
              <small>{props.selectedRepository.snapshot.fileStatuses.length}</small>
            </span>
            <code>—</code>
            <span>—</span>
            <span />
          </button>
        ) : null}
        <div className="project-git-commit-scroll" ref={historyScroll}>
          <CommitGraph commits={props.commits.map(({ commit }) => commit)} />
          <div className="project-git-commit-rows">
            {props.commits.length === 0 ? <p role="status">{props.zh ? '当前列表没有匹配的提交，请调整搜索条件或选择其他分支。' : 'No matching commits in this list. Adjust the search or choose another branch.'}</p> : null}
            {props.commits.map(({ repository, commit }) => {
              const selected = repository.id === props.selectedRepository?.id && commit.hash === props.selectedCommitHash;
              return (
                <button
                  key={`${repository.id}:${commit.hash}`}
                  data-git-context={JSON.stringify({ kind: 'commit', repositoryId: repository.id, ref: commit.hash })}
                  type="button"
                  className={`project-git-commit-row${selected ? ' is-current' : ''}`}
                  onClick={() => props.onSelectCommit(repository, commit.hash)}
                >
                  <span className="project-git-commit-subject" title={commit.subject}>
                    {repository.snapshot.headSha === commit.hash ? (
                      <span className="git-history-ref" title={repository.snapshot.detached ? 'HEAD' : `HEAD → ${repository.snapshot.branch}`}>
                        <GitBranch aria-hidden="true" />
                        {repository.snapshot.detached ? 'HEAD' : repository.snapshot.branch}
                      </span>
                    ) : null}
                    <strong>{commit.subject}</strong>
                  </span>
                  <code title={commit.hash}>{commit.shortHash}</code>
                  <span title={commit.author}>{commit.author}</span>
                  <time dateTime={commit.authoredAt} title={new Date(commit.authoredAt).toLocaleString()}>
                    {formatRelativeTime(commit.authoredAt, props.zh)}
                  </time>
                </button>
              );
            })}
            <div ref={historySentinel} role="status" className="project-git-history-status">
              {props.historyError ? (
                <>
                  <span>{props.historyError}</span>
                  <Button variant="secondary" size="compact" onClick={props.onLoadMore}>
                    {props.zh ? '重试' : 'Retry'}
                  </Button>
                </>
              ) : props.historyLoading ? (
                props.zh ? (
                  '正在加载提交…'
                ) : (
                  'Loading commits…'
                )
              ) : props.historyHasMore ? (
                props.zh ? (
                  '向下滚动加载更多提交'
                ) : (
                  'Scroll for more commits'
                )
              ) : props.zh ? (
                '已加载全部提交'
              ) : (
                'All commits loaded'
              )}
            </div>
          </div>
        </div>
      </main>
      <GitPaneSeparator name="history" label={props.zh ? '调整历史与详情高度' : 'Resize history and details'} axis="y" initial={55} min={20} max={75} />
      <aside className="project-git-inspector">
        {props.commitLoading ? (
          <div className="project-git-inspector-loading">
            <CircleNotch aria-hidden="true" />
            {props.zh ? '正在读取提交' : 'Loading commit'}
          </div>
        ) : props.commitDetail ? (
          <>
            <section className="project-git-commit-detail">
              <strong>{props.commitDetail.commit.subject}</strong>
              <span>{props.commitDetail.commit.author}</span>
              <small>
                {props.commitDetail.commit.shortHash} · {new Date(props.commitDetail.commit.authoredAt).toLocaleString()}
              </small>
              <div className="project-git-commit-actions">
                <Button
                  variant="secondary"
                  disabled={!props.selectedRepository}
                  onClick={() => props.selectedRepository && props.onOpenDiff(props.selectedRepository, '', { comparisonRef: props.commitDetail!.commit.hash, comparisonMode: 'current' })}
                >
                  {props.zh ? '查看与当前分支的差异' : 'View diff with current branch'}
                </Button>
                <Button
                  variant="secondary"
                  disabled={props.busy !== null || !props.selectedRepository}
                  aria-haspopup="menu"
                  aria-expanded={commitMenu !== null}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setCommitMenu(commitMenu ? null : { x: bounds.left, y: bounds.bottom + 5 });
                  }}
                >
                  {props.zh ? '更多操作' : 'More actions'}
                  <CaretDown aria-hidden="true" />
                </Button>
              </div>
              <MotionPresence>
                {commitMenu && props.selectedRepository
                  ? createPortal(
                      <MenuSurface className="project-git-context-menu" aria-label={props.zh ? '提交操作' : 'Commit actions'} style={{ left: commitMenu.x, top: commitMenu.y }} onClose={() => setCommitMenu(null)}>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={props.busy !== null || props.selectedRepository.snapshot.detached}
                          onClick={() => {
                            setCommitMenu(null);
                            props.onConfirmAction(
                              props.selectedRepository!,
                              { type: 'cherry_pick', revision: props.commitDetail!.commit.hash },
                              props.zh ? '拣选到当前分支' : 'Cherry-pick commit',
                              props.zh ? '这会把选中提交的改动应用到当前分支。' : 'This applies the selected commit to the current branch.',
                            );
                          }}
                        >
                          {props.zh ? '拣选到当前分支' : 'Cherry-pick to current branch'}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          data-danger="true"
                          disabled={props.busy !== null}
                          onClick={() => {
                            setCommitMenu(null);
                            props.onConfirmAction(
                              props.selectedRepository!,
                              { type: 'revert', revision: props.commitDetail!.commit.hash },
                              props.zh ? '撤销此提交' : 'Revert commit',
                              props.zh ? '这会创建一个新提交来撤销选中提交的改动，原提交仍保留在历史中。' : 'This creates a new commit that reverses the selected commit. The original commit remains in history.',
                              true,
                            );
                          }}
                        >
                          {props.zh ? '撤销此提交' : 'Revert this commit'}
                        </button>
                      </MenuSurface>,
                      document.querySelector('.macos-ai-app') ?? document.body,
                    )
                  : null}
              </MotionPresence>
              {props.commitDetail.body && props.commitDetail.body !== props.commitDetail.commit.subject ? <p>{props.commitDetail.body}</p> : null}
            </section>
            <section className="project-git-changed-files">
              <header>
                <strong>{props.zh ? `变更文件 (${props.commitDetail.files.length})` : `Changed files (${props.commitDetail.files.length})`}</strong>
              </header>
              <CommitFileDirectoryTree
                files={props.commitDetail.files}
                selectedPath={props.selectedFilePath}
                onSelect={props.onSelectFile}
                onOpen={(path) => {
                  if (props.selectedRepository) props.onOpenDiff(props.selectedRepository, path, { commitHash: props.commitDetail?.commit.hash });
                }}
              />
            </section>
            <GitPaneSeparator name="inspector" label={props.zh ? '调整详情与差异宽度' : 'Resize details and diff'} initial={35} min={20} max={65} />
            <GitPaneSeparator name="details" label={props.zh ? '调整文件与提交详情高度' : 'Resize files and commit details'} axis="y" initial={55} min={20} max={80} />
            <SideBySideDiff
              previewRequest={
                props.selectedRepository && props.selectedFilePath
                  ? { kind: 'project-git', projectId: props.projectId, repositoryId: props.selectedRepository.id, path: props.selectedFilePath, commitHash: props.selectedCommitHash }
                  : undefined
              }
              diff={selectedDiff ? { isRepository: true, files: [props.selectedFilePath], diffText: props.commitDetail.diff.diffText, fileDiffs: [selectedDiff] } : null}
              zh={props.zh}
            />
          </>
        ) : (
          <p className="project-git-empty-copy">{props.zh ? '选择一个提交查看文件与差异。' : 'Select a commit to inspect files and diff.'}</p>
        )}
      </aside>
      <MotionPresence>{branchMenu ? <BranchContextMenu {...branchMenu} zh={props.zh} busy={props.busy} onClose={() => setBranchMenu(null)} onExecute={props.onExecute} onOpenDiff={props.onOpenDiff} /> : null}</MotionPresence>
    </div>
  );
}

interface CommitFileTreeNode {
  name: string;
  path: string;
  children: Map<string, CommitFileTreeNode>;
  stats?: { additions: number; deletions: number };
}

function CommitFileDirectoryTree(props: { files: Array<{ path: string; additions: number; deletions: number }>; selectedPath: string; onSelect: (path: string) => void; onOpen: (path: string) => void }) {
  const tree = useMemo(() => buildCommitFileTree(props.files), [props.files.map((file) => `${file.path}:${file.additions}:${file.deletions}`).join('\0')]);
  return (
    <div className="project-git-commit-file-tree">
      {Array.from(tree.children.values()).map((node) => (
        <CommitFileTreeEntry key={node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

function CommitFileTreeEntry(props: Parameters<typeof CommitFileDirectoryTree>[0] & { node: CommitFileTreeNode; depth: number }) {
  if (!props.node.stats) {
    return (
      <details className="project-git-commit-file-folder" open>
        <summary style={{ paddingLeft: `${props.depth * 12 + 5}px` }}>
          <CaretRight aria-hidden="true" />
          <Folder aria-hidden="true" />
          <span>{props.node.name}</span>
        </summary>
        {Array.from(props.node.children.values()).map((child) => (
          <CommitFileTreeEntry key={child.path} {...props} node={child} depth={props.depth + 1} />
        ))}
      </details>
    );
  }
  return (
    <button
      type="button"
      className={props.node.path === props.selectedPath ? 'is-current' : ''}
      style={{ paddingLeft: `${props.depth * 12 + 7}px` }}
      onClick={() => props.onSelect(props.node.path)}
      onDoubleClick={() => props.onOpen(props.node.path)}
    >
      <File aria-hidden="true" />
      <span title={props.node.path}>{props.node.name}</span>
      <em>+{props.node.stats.additions}</em>
      <i>-{props.node.stats.deletions}</i>
    </button>
  );
}

function buildCommitFileTree(files: Array<{ path: string; additions: number; deletions: number }>): CommitFileTreeNode {
  const root: CommitFileTreeNode = { name: '', path: '', children: new Map() };
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    let current = root;
    const parts = file.path.split('/').filter(Boolean);
    parts.forEach((part, index) => {
      const path = parts.slice(0, index + 1).join('/');
      const next = current.children.get(part) ?? { name: part, path, children: new Map<string, CommitFileTreeNode>() };
      if (index === parts.length - 1) next.stats = { additions: file.additions, deletions: file.deletions };
      current.children.set(part, next);
      current = next;
    });
  }
  return root;
}

function CommitGraph(props: { commits: ProjectGitRepositoryWorkbenchItem['snapshot']['recentCommits'] }) {
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
    props.commits.forEach((commit, row) => {
      let lane = lanes.indexOf(commit.hash);
      if (lane < 0) {
        lane = lanes.length;
        lanes[lane] = commit.hash;
      }
      const parents = commit.parentHashes.filter((parent, index, values) => values.indexOf(parent) === index);
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
      for (let index = 0; index < nextLanes.length; index += 1) {
        if (nextLanes[index] && nextLanes.indexOf(nextLanes[index]!) !== index) nextLanes[index] = '';
      }
      while (nextLanes.at(-1) === '') nextLanes.pop();
      lanes.splice(0, lanes.length, ...nextLanes);
    });
  }, [props.commits]);
  return <canvas ref={canvasRef} className="project-git-graph-canvas" aria-hidden="true" />;
}

// 子模块按仓库相对路径组织，目录节点只负责展开，不改变仓库选择。
function RepositoryNavigationTree(props: { repositories: ProjectGitRepositoryWorkbenchItem[]; zh: boolean; selectedId?: string; onSelect: (id: string) => void }) {
  type Node = { name: string; path: string; children: Map<string, Node>; repository?: ProjectGitRepositoryWorkbenchItem };
  const root: Node = { name: '', path: '', children: new Map() };
  for (const repository of props.repositories) {
    const parts = repository.relativePath === '.' ? [repository.name] : repository.relativePath.split('/').filter(Boolean);
    let node = root;
    for (const name of parts) {
      if (!node.children.has(name)) node.children.set(name, { name, path: `${node.path}/${name}`, children: new Map() });
      node = node.children.get(name)!;
    }
    node.repository = repository;
  }
  const render = (node: Node): React.ReactNode => {
    const repository = node.repository;
    const snapshot = repository?.snapshot;
    const relation = !snapshot
      ? ''
      : snapshot.detached
        ? props.zh
          ? '分离 HEAD'
          : 'Detached HEAD'
        : !snapshot.upstream
          ? props.zh
            ? '未跟踪'
            : 'No upstream'
          : snapshot.ahead || snapshot.behind
            ? [snapshot.ahead ? `↑${snapshot.ahead}` : '', snapshot.behind ? `↓${snapshot.behind}` : ''].filter(Boolean).join(' ')
            : props.zh
              ? '已同步'
              : 'Synced';
    const row =
      repository && snapshot ? (
        <button
          data-git-context={JSON.stringify({ kind: 'repository', repositoryId: repository.id, ref: repository.name })}
          type="button"
          className="project-git-navigation-repository"
          aria-current={props.selectedId === repository.id ? 'true' : undefined}
          onClick={() => props.onSelect(repository.id)}
          title={`${repository.relativePath}\n${snapshot.branch} → ${snapshot.upstream ?? (props.zh ? '未设置远程跟踪分支' : 'No upstream')}\n${relation}`}
        >
          <GitBranch aria-hidden="true" />
          <span>
            {node.name}
            <small>{snapshot.detached ? snapshot.headSha.slice(0, 7) : snapshot.branch}</small>
          </span>
          <span className="git-tracking-badge" aria-label={relation}>
            {relation}
          </span>
        </button>
      ) : null;
    if (!node.children.size) return <div key={node.path}>{row}</div>;
    return (
      <details key={node.path} className="git-repository-directory" open>
        <summary>
          <CaretRight aria-hidden="true" />
          <Folder aria-hidden="true" />
          <span>{node.name}</span>
        </summary>
        <div className="git-repository-directory-children">
          {row}
          {[...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(render)}
        </div>
      </details>
    );
  };
  return <>{[...root.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map(render)}</>;
}

function LocalChangesSurface(props: {
  query: string;
  commitRequest: number;
  /** 刷新时即使二进制补丁相同，也重新读取当前文件。 */
  previewRevision?: string;
  /** 仓库预览所属项目。 */
  projectId: string;
  subtree: { repositoryId: string; path: string } | null;
  onClearSubtree: () => void;
  zh: boolean;
  onOpenStash: () => void;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  selectedFilePath: string;
  selectedFileStage: ChangeStage;
  busy: BusyState;
  onSelectRepository: (repositoryId: string) => void;
  onSelectFile: (path: string, stage: ChangeStage) => void;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onConfirmAction: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, title: string, description: string, danger: boolean) => void;
  onCommit: () => void;
  commitDrafts: Record<string, string>;
  commitModels: Array<{ id: string; label: string }>;
  commitModelRef: string;
  commitModelsLoading: boolean;
  commitModelsError: string;
  onSelectCommitModel: (modelRef: string) => void;
  onRefreshCommitModels: () => void;
  generatingCommitFor: string | null;
  generationFeedback?: string;
  onGenerateCommitMessage: (repository: ProjectGitRepositoryWorkbenchItem) => Promise<void>;
  onStopCommitGeneration: () => void;
  onCommitMessageChange: (repositoryId: string, message: string) => void;
}) {
  const committingRef = useRef(false);
  const [fileView, setFileView] = useState<'tree' | 'flat'>(() => {
    try {
      return localStorage.getItem('zeus.git.file-view.v1') === 'flat' ? 'flat' : 'tree';
    } catch {
      return 'tree';
    }
  });
  const [editingRepository, setEditingRepository] = useState<string | null>(null);
  const commitInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.commitRequest && props.selectedRepository) setEditingRepository(props.selectedRepository.id);
  }, [props.commitRequest]);
  const commitActive = Boolean(props.selectedRepository && editingRepository === props.selectedRepository.id);
  useEffect(() => {
    if (commitActive) commitInputRef.current?.focus();
  }, [commitActive]);
  const repository = props.selectedRepository;
  const message = repository ? (props.commitDrafts[repository.id] ?? '') : '';
  const stagedCount = repository?.snapshot.fileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?').length ?? 0;
  const generating = props.generatingCommitFor === repository?.id;
  const canCommit = Boolean(repository && stagedCount > 0 && message.trim() && !props.busy && !generating);
  async function commitCurrentRepository(): Promise<void> {
    if (!repository || !canCommit || committingRef.current) return;
    committingRef.current = true;
    try {
      const outcome = await props.onExecute(repository, { type: 'commit', message: message.trim() }, props.zh ? '提交已暂存变更' : 'Commit staged changes');
      if (outcome === 'completed') {
        props.onCommitMessageChange(repository.id, '');
        setEditingRepository(null);
      }
    } finally {
      committingRef.current = false;
    }
  }
  const subtree = props.subtree;
  const matchesSubtree = (path: string) => !subtree || subtree.repositoryId !== props.selectedRepository?.id || path === subtree.path || path.startsWith(`${subtree.path}/`);
  const visibleFileStatuses = repository?.snapshot.fileStatuses.filter((file) => matchesSubtree(file.path) && file.path.toLocaleLowerCase().includes(props.query.trim().toLocaleLowerCase())) ?? [];
  const visibleChangeCount = visibleFileStatuses.length;
  const emptyVisibleChanges = Boolean(repository && visibleChangeCount === 0 && repository.snapshot.conflictFiles.length === 0);
  const workspaceClean = Boolean(emptyVisibleChanges && repository?.snapshot.fileStatuses.length === 0);
  const visibleStageFiles = {
    staged: visibleFileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?').map((file) => file.path),
    unstaged: visibleFileStatuses.filter((file) => file.workingTreeStatus !== ' ' || file.indexStatus === '?').map((file) => file.path),
  };
  const stageDiff = props.selectedFileStage === 'staged' ? props.selectedRepository?.snapshot.stagedDiff : props.selectedRepository?.snapshot.unstagedDiff;
  const selectedDiff = stageDiff?.fileDiffs.find((file) => (file.newPath === props.selectedFilePath || file.oldPath === props.selectedFilePath) && matchesSubtree(file.newPath || file.oldPath)) ?? null;
  return (
    <div className="project-git-changes-layout project-git-navigator-layout" data-commit-active={commitActive}>
      <aside className="project-git-change-tree" data-empty={emptyVisibleChanges || undefined}>
        {repository && repository.snapshot.conflictFiles.length > 0 ? (
          <section className="project-git-conflict-files" aria-label={props.zh ? '冲突文件' : 'Conflicted files'}>
            <header>
              <WarningCircle aria-hidden="true" />
              <strong>{props.zh ? `冲突文件 (${repository.snapshot.conflictFiles.length})` : `Conflicts (${repository.snapshot.conflictFiles.length})`}</strong>
            </header>
            {repository.snapshot.conflictFiles.map((path) => (
              <button key={path} type="button" className={path === props.selectedFilePath ? 'is-current' : ''} onClick={() => props.onSelectFile(path, 'unstaged')} title={path}>
                <span>{path}</span>
              </button>
            ))}
          </section>
        ) : null}
        <header>
          <strong>{props.zh ? '变更文件' : 'Changed files'}</strong>
          <span className="project-git-file-view-control" title={fileView === 'flat' ? (props.zh ? '平铺结构' : 'Flat view') : props.zh ? '树状结构' : 'Tree view'}>
            {fileView === 'flat' ? <ListBullets aria-hidden="true" /> : <TreeStructure aria-hidden="true" />}
            <CaretDown aria-hidden="true" />
            <select
              className="project-git-file-view-select"
              aria-label={props.zh ? `文件显示方式：${fileView === 'flat' ? '平铺结构' : '树状结构'}` : `File view: ${fileView === 'flat' ? 'Flat view' : 'Tree view'}`}
              value={fileView}
              disabled={!repository || visibleChangeCount === 0}
              onChange={(event) => {
                const next = event.currentTarget.value === 'flat' ? 'flat' : 'tree';
                setFileView(next);
                try {
                  localStorage.setItem('zeus.git.file-view.v1', next);
                } catch {
                  /* 存储不可用时保留当前会话选择。 */
                }
              }}
            >
              <option value="tree">{props.zh ? '树状结构' : 'Tree view'}</option>
              <option value="flat">{props.zh ? '平铺结构' : 'Flat view'}</option>
            </select>
          </span>
          <span>{visibleChangeCount}</span>
          {subtree?.repositoryId === props.selectedRepository?.id ? (
            <button type="button" onClick={props.onClearSubtree}>
              {props.zh ? '清除目录筛选' : 'Clear folder filter'}
            </button>
          ) : null}
        </header>
        {emptyVisibleChanges ? (
          <div className="project-git-clean-state" role="status">
            <span className="project-git-empty-symbol">
              <CheckCircle aria-hidden="true" />
            </span>
            <strong>{workspaceClean ? (props.zh ? '工作区干净' : 'Working tree clean') : props.zh ? '没有匹配的更改' : 'No matching changes'}</strong>
            <span>{workspaceClean ? (props.zh ? '没有待暂存或提交的文件。' : 'There are no files to stage or commit.') : props.zh ? '调整文件或目录筛选可查看其他更改。' : 'Adjust the file or folder filter to view other changes.'}</span>
          </div>
        ) : (
          <div className="project-git-stage-panels">
            {(['staged', 'unstaged'] as const).map((stage) => {
              const files = visibleStageFiles[stage];
              const title = stage === 'staged' ? (props.zh ? '已暂存' : 'Staged') : props.zh ? '未暂存' : 'Unstaged';
              return (
                <Fragment key={stage}>
                  {stage === 'unstaged' ? <GitPaneSeparator name="stages" label={props.zh ? '调整已暂存与未暂存区域高度' : 'Resize staged and unstaged panels'} axis="y" initial={50} min={15} max={85} /> : null}
                  <section className="project-git-stage-panel" aria-label={title}>
                    <header data-git-context={repository ? JSON.stringify({ kind: 'stage', repositoryId: repository.id, ref: title, stage }) : undefined}>
                      <label className="project-git-stage-select-all">
                        <input
                          type="checkbox"
                          checked={stage === 'staged' && files.length > 0}
                          disabled={!repository || !files.length || props.busy !== null}
                          aria-label={stage === 'staged' ? (props.zh ? '取消暂存全部显示文件' : 'Unstage all displayed files') : props.zh ? '暂存全部显示文件' : 'Stage all displayed files'}
                          title={stage === 'staged' ? (props.zh ? '取消暂存全部显示文件' : 'Unstage all displayed files') : props.zh ? '暂存全部显示文件' : 'Stage all displayed files'}
                          onChange={() => {
                            if (repository && files.length && !props.busy)
                              void props.onExecute(
                                repository,
                                { type: stage === 'staged' ? 'unstage' : 'stage', paths: files },
                                stage === 'staged' ? (props.zh ? '取消暂存全部显示文件' : 'Unstage all displayed files') : props.zh ? '暂存全部显示文件' : 'Stage all displayed files',
                              );
                          }}
                        />
                        <strong>{title}</strong>
                      </label>
                      <span>{files.length}</span>
                      <button
                        type="button"
                        className="git-stage-all"
                        disabled={!repository || !files.length || props.busy !== null}
                        onClick={() => {
                          if (repository) void props.onExecute(repository, { type: stage === 'staged' ? 'unstage' : 'stage', paths: files }, stage === 'staged' ? (props.zh ? '取消暂存' : 'Unstage') : props.zh ? '暂存' : 'Stage');
                        }}
                      >
                        {stage === 'staged' ? (props.zh ? '取消暂存全部' : 'Unstage all') : props.zh ? '暂存全部' : 'Stage all'}
                      </button>
                    </header>
                    <div className="project-git-stage-scroll">
                      {repository && files.length > 0 ? (
                        <ChangeDirectoryTree
                          view={fileView}
                          files={files}
                          stage={stage}
                          repository={repository}
                          selectedRepositoryId={repository.id}
                          selectedFilePath={props.selectedFilePath}
                          selectedFileStage={props.selectedFileStage}
                          busy={props.busy}
                          zh={props.zh}
                          onSelectRepository={props.onSelectRepository}
                          onSelectFile={props.onSelectFile}
                          onOpenDiff={props.onOpenDiff}
                          onExecute={props.onExecute}
                        />
                      ) : (
                        <p className="project-git-stage-empty">{stage === 'staged' ? (props.zh ? '暂无已暂存文件' : 'No staged files') : props.zh ? '暂无未暂存文件' : 'No unstaged files'}</p>
                      )}
                    </div>
                  </section>
                </Fragment>
              );
            })}
          </div>
        )}
      </aside>
      <GitPaneSeparator name="files" label={props.zh ? '调整文件列表宽度' : 'Resize file list'} initial={30} min={15} max={65} />
      <main className="project-git-change-diff">
        {emptyVisibleChanges ? (
          <div className="project-git-change-diff-empty" role="status">
            <span className="project-git-empty-symbol">
              <CheckCircle aria-hidden="true" />
            </span>
            <strong>{workspaceClean ? (props.zh ? '当前分支没有本地更改' : 'No local changes on this branch') : props.zh ? '当前目录没有可比较的变更' : 'No comparable changes in this folder'}</strong>
            <span>
              {workspaceClean
                ? props.zh
                  ? '修改文件后，可在这里逐项查看差异。'
                  : 'Edit a file to inspect its diff here.'
                : props.zh
                  ? '清除目录筛选，或选择其他目录查看差异。'
                  : 'Clear the folder filter or select another folder to inspect changes.'}
            </span>
          </div>
        ) : (
          <SideBySideDiff
            previewRequest={repository && props.selectedFilePath ? { kind: 'project-git', projectId: props.projectId, repositoryId: repository.id, path: props.selectedFilePath, stage: props.selectedFileStage } : undefined}
            revision={props.previewRevision}
            diff={selectedDiff ? { isRepository: true, files: [selectedDiff.newPath || selectedDiff.oldPath], diffText: stageDiff?.diffText ?? '', fileDiffs: [selectedDiff] } : null}
            zh={props.zh}
            partitionHunks
            hunkActionsDisabled={props.busy !== null}
            onHunkAction={
              repository && selectedDiff && selectedDiff.changeType === 'modified'
                ? (file, hunk) => {
                    const patch = buildGitHunkPatch(file, hunk);
                    void props.onExecute(
                      repository,
                      { type: 'apply_patch', patch, reverse: props.selectedFileStage === 'staged' },
                      props.selectedFileStage === 'staged' ? (props.zh ? '取消暂存区块' : 'Unstage hunk') : props.zh ? '暂存区块' : 'Stage hunk',
                    );
                  }
                : undefined
            }
            hunkActionLabel={props.selectedFileStage === 'staged' ? (props.zh ? '取消暂存区块' : 'Unstage hunk') : props.zh ? '暂存区块' : 'Stage hunk'}
            onHunkDiscard={
              repository && selectedDiff && selectedDiff.changeType === 'modified' && props.selectedFileStage === 'unstaged'
                ? (file, hunk, index) => {
                    const patch = buildGitHunkPatch(file, hunk);
                    const title = props.zh ? `放弃区块 ${index + 1}` : `Discard hunk ${index + 1}`;
                    props.onConfirmAction(
                      repository,
                      { type: 'apply_patch', patch, reverse: true, target: 'worktree' },
                      title,
                      props.zh ? `将“${file.newPath || file.oldPath}”的区块 ${index + 1} 恢复为暂存区内容。此操作无法撤销。` : `Restore hunk ${index + 1} in '${file.newPath || file.oldPath}' to the index version. This cannot be undone.`,
                      true,
                    );
                  }
                : undefined
            }
            hunkDiscardLabel={props.zh ? '放弃区块' : 'Discard hunk'}
          />
        )}
      </main>
      {commitActive ? (
        <>
          <GitPaneSeparator name="commit" label={props.zh ? '调整提交区域高度' : 'Resize commit panel'} axis="y" initial={65} min={25} max={85} />
          <aside className="project-git-commit-rail project-git-commit-composer">
            <div className="project-git-commit-summary" role="status">
              <strong>{repository?.name ?? (props.zh ? '请选择仓库' : 'Select a repository')}</strong>
              <small>{props.zh ? `${stagedCount} 个已暂存文件 · 仅提交当前仓库` : `${stagedCount} staged files · Current repository only`}</small>
              {stagedCount === 0 ? <small>{props.zh ? '勾选左侧文件进行暂存后即可提交。' : 'Select files on the left to stage them before committing.'}</small> : null}
            </div>
            <div className="project-git-commit-message">
              <div className="project-git-commit-message-heading">
                <label htmlFor="project-git-commit-message">{props.zh ? '提交说明' : 'Commit message'}</label>
                <div className="project-git-commit-generation-controls">
                  <small className="project-git-commit-generation-feedback" role="status" title={props.commitModelsError || undefined}>
                    {!props.commitModelsLoading && !props.commitModels.length
                      ? props.zh
                        ? '暂无可用模型，请在设置中配置模型连接后刷新。'
                        : 'No models available. Configure a model connection in Settings, then refresh.'
                      : props.generationFeedback || props.commitModelsError}
                  </small>
                  <select
                    aria-label={props.zh ? '生成提交说明的模型' : 'Commit message model'}
                    value={props.commitModelRef}
                    disabled={props.commitModelsLoading || props.generatingCommitFor !== null || props.commitModels.length === 0}
                    onChange={(event) => props.onSelectCommitModel(event.currentTarget.value)}
                  >
                    {!props.commitModelRef ? <option value="">{props.commitModelsLoading ? (props.zh ? '正在加载模型…' : 'Loading models…') : props.zh ? '没有可用模型' : 'No available models'}</option> : null}
                    {props.commitModels.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    disabled={props.commitModelsLoading || props.generatingCommitFor !== null}
                    onClick={props.onRefreshCommitModels}
                    title={props.zh ? '刷新模型列表' : 'Refresh models'}
                    aria-label={props.zh ? '刷新模型列表' : 'Refresh models'}
                  >
                    <ArrowsClockwise aria-hidden="true" />
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!generating && (!repository || stagedCount === 0 || props.busy !== null || props.generatingCommitFor !== null || props.commitModelsLoading || !props.commitModelRef)}
                    onClick={() => {
                      if (generating) props.onStopCommitGeneration();
                      else if (repository) void props.onGenerateCommitMessage(repository);
                    }}
                  >
                    {generating ? (props.zh ? '停止生成' : 'Stop generating') : props.zh ? 'AI 生成' : 'Generate with AI'}
                  </Button>
                </div>
              </div>
              <textarea
                ref={commitInputRef}
                id="project-git-commit-message"
                value={message}
                rows={3}
                placeholder={props.zh ? '简要描述本次修改，可换行补充详情' : 'Describe this change; add details on subsequent lines'}
                disabled={!repository || props.busy !== null || generating}
                onChange={(event) => {
                  if (repository) props.onCommitMessageChange(repository.id, event.currentTarget.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && !event.nativeEvent.isComposing && !props.busy && !generating) {
                    event.preventDefault();
                    setEditingRepository(null);
                  }
                  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void commitCurrentRepository();
                  }
                }}
              />
            </div>
            <div className="project-git-commit-actions">
              <Button variant="secondary" disabled={props.busy !== null || generating} onClick={() => setEditingRepository(null)}>
                {props.zh ? '取消' : 'Cancel'}
              </Button>
              <Button variant="primary" onClick={() => void commitCurrentRepository()} disabled={!canCommit} busy={props.busy?.action === 'commit'}>
                {props.zh ? '提交已暂存变更' : 'Commit staged changes'}
              </Button>
              {props.repositories.length > 1 ? (
                <Button variant="secondary" onClick={props.onCommit} disabled={props.busy !== null}>
                  {props.zh ? '多仓库提交…' : 'Commit across repositories…'}
                </Button>
              ) : null}
            </div>
          </aside>
        </>
      ) : (
        <aside className="project-git-commit-collapsed">
          <span title={repository?.name}>{repository?.name ?? (props.zh ? '提交' : 'Commit')}</span>
          <button
            type="button"
            disabled={!repository || workspaceClean}
            aria-label={workspaceClean ? (props.zh ? '当前仓库没有可提交的变更' : 'No changes to commit in this repository') : props.zh ? '展开提交说明编辑区' : 'Expand commit message editor'}
            onClick={() => {
              if (repository) setEditingRepository(repository.id);
            }}
          >
            {message.split(/\r?\n/u)[0] ||
              (workspaceClean
                ? props.zh
                  ? '工作区干净'
                  : 'Working tree clean'
                : stagedCount > 0
                  ? props.zh
                    ? '填写提交说明…'
                    : 'Enter a commit message…'
                  : props.zh
                    ? '先暂存文件，再填写提交说明…'
                    : 'Stage files before entering a commit message…')}
          </button>
        </aside>
      )}
    </div>
  );
}

interface ChangeTreeNode {
  name: string;
  path: string;
  children: Map<string, ChangeTreeNode>;
  file: boolean;
}

function ChangeDirectoryTree(props: {
  view?: 'tree' | 'flat';
  files: string[];
  stage: ChangeStage;
  repository: ProjectGitRepositoryWorkbenchItem;
  selectedRepositoryId?: string;
  selectedFilePath: string;
  selectedFileStage: ChangeStage;
  busy: BusyState;
  zh: boolean;
  onSelectRepository: (repositoryId: string) => void;
  onSelectFile: (path: string, stage: ChangeStage) => void;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage }) => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const nodes = useMemo(
    () => (props.view === 'flat' ? [...props.files].sort((a, b) => a.localeCompare(b)).map((path): ChangeTreeNode => ({ name: path, path, file: true, children: new Map() })) : [...buildChangeTree(props.files).children.values()]),
    [props.files.join('\0'), props.view],
  );
  if (props.files.length === 0) return null;
  return (
    <div className="project-git-change-directory-tree">
      {nodes.map((node) => (
        <ChangeTreeEntry key={node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

function ChangeTreeEntry(props: Parameters<typeof ChangeDirectoryTree>[0] & { node: ChangeTreeNode; depth: number }) {
  if (!props.node.file) {
    return (
      <details className="project-git-change-folder" open>
        <summary data-git-context={JSON.stringify({ kind: 'directory', repositoryId: props.repository.id, ref: props.node.path, stage: props.stage })} style={{ paddingLeft: `${props.depth * 13 + 6}px` }}>
          <CaretRight aria-hidden="true" />
          <Folder aria-hidden="true" />
          <span>{props.node.name}</span>
        </summary>
        {Array.from(props.node.children.values()).map((child) => (
          <ChangeTreeEntry key={child.path} {...props} node={child} depth={props.depth + 1} />
        ))}
      </details>
    );
  }
  const selected = props.repository.id === props.selectedRepositoryId && props.node.path === props.selectedFilePath && props.stage === props.selectedFileStage;
  const checked = props.stage === 'staged';
  const status = props.repository.snapshot.fileStatuses.find((file) => file.path === props.node.path);
  return (
    <div data-git-context={JSON.stringify({ kind: 'file', repositoryId: props.repository.id, ref: props.node.path, stage: props.stage })} className={`project-git-change-file-row${selected ? ' is-current' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={props.busy !== null}
        aria-label={checked ? (props.zh ? `取消暂存 ${props.node.path}` : `Unstage ${props.node.path}`) : props.zh ? `暂存 ${props.node.path}` : `Stage ${props.node.path}`}
        onChange={() =>
          void props.onExecute(
            props.repository,
            checked ? { type: 'unstage', paths: [props.node.path] } : { type: 'stage', paths: [props.node.path] },
            checked ? (props.zh ? '取消暂存文件' : 'Unstage file') : props.zh ? '暂存文件' : 'Stage file',
          )
        }
      />
      <button
        type="button"
        style={{ marginLeft: `${props.depth * 13}px` }}
        title={props.node.path}
        onClick={() => {
          props.onSelectRepository(props.repository.id);
          props.onSelectFile(props.node.path, props.stage);
        }}
        onDoubleClick={() => props.onOpenDiff(props.repository, props.node.path, { stage: props.stage })}
      >
        <File aria-hidden="true" />
        <span>{props.node.name}</span>
        {status ? <small className={`project-git-file-status is-${status.category}`}>{gitFileStatusLabel(status.category, props.zh)}</small> : null}
      </button>
    </div>
  );
}

function buildChangeTree(paths: string[]): ChangeTreeNode {
  const root: ChangeTreeNode = { name: '', path: '', children: new Map(), file: false };
  for (const path of [...paths].sort((left, right) => left.localeCompare(right))) {
    let current = root;
    const parts = path.split('/').filter(Boolean);
    parts.forEach((part, index) => {
      const childPath = parts.slice(0, index + 1).join('/');
      const next = current.children.get(part) ?? { name: part, path: childPath, children: new Map<string, ChangeTreeNode>(), file: index === parts.length - 1 };
      current.children.set(part, next);
      current = next;
    });
  }
  return root;
}

function StashSurface(props: {
  /** 仓库预览所属项目。 */
  projectId: string;
  zh: boolean;
  repository: ProjectGitRepositoryWorkbenchItem | null;
  stash: ProjectGitRepositoryWorkbenchItem['snapshot']['stashes'][number] | null;
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
        <span>{props.zh ? '左侧“贮藏区”会显示当前仓库中的贮藏。' : 'Stashes in the current repository appear in the sidebar.'}</span>
      </div>
    );
  }
  const repository = props.repository;
  const stash = props.stash;
  return (
    <section className="project-git-stash-surface" aria-label={props.zh ? '贮藏详情' : 'Stash details'}>
      <header className="project-git-stash-toolbar">
        <span className="project-git-stash-identity">
          <Archive aria-hidden="true" />
          <span>
            <strong>{displayStashSubject(stash.subject, props.zh)}</strong>
            <small>
              {stash.ref} · {stash.author} · {formatRelativeTime(stash.authoredAt, props.zh)}
            </small>
          </span>
        </span>
        <span className="project-git-stash-actions">
          <Button variant="secondary" size="compact" disabled={props.busy !== null} onClick={() => void props.onExecute(repository, { type: 'apply_stash', stashRef: stash.ref }, props.zh ? '应用 Stash' : 'Apply stash')}>
            {props.zh ? '应用' : 'Apply'}
          </Button>
          <Button variant="secondary" size="compact" disabled={props.busy !== null} onClick={() => void props.onExecute(repository, { type: 'apply_stash', stashRef: stash.ref, pop: true }, props.zh ? '弹出 Stash' : 'Pop stash')}>
            {props.zh ? '弹出' : 'Pop'}
          </Button>
          <Button variant="danger" size="compact" disabled={props.busy !== null} onClick={() => void props.onExecute(repository, { type: 'drop_stash', stashRef: stash.ref }, props.zh ? '删除 Stash' : 'Drop stash')}>
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
            <CommitFileDirectoryTree files={props.detail.files} selectedPath={props.selectedFilePath} onSelect={props.onSelectFile} onOpen={(path) => props.onOpenDiff(repository, path, { commitHash: stash.ref })} />
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

/** 控制台复用既有记录布局，滚动和键盘入口共用历史加载门禁。 */
function ConsoleSurface(props: { zh: boolean; history: ReturnType<typeof useGitOperationHistory> }) {
  /** 当前控制台是独立滚动区域。 */
  const root = useRef<HTMLDivElement>(null);
  /** 底部标记只负责触发读取，不执行任何 Git 动作。 */
  const sentinel = useRef<HTMLElement>(null);
  /** 以可见记录作为锚点，刷新插入新记录时保留阅读位置。 */
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  /** 只记录首个可见记录；位于顶部时保持最新记录可见。 */
  function rememberPosition(): void {
    /** 容器卸载时无需继续计算滚动位置。 */
    const container = root.current;
    if (!container || container.scrollTop === 0) {
      anchor.current = null;
      return;
    }
    /** 相对容器的偏移不会受整个窗口移动影响。 */
    const top = container.getBoundingClientRect().top;
    /** 操作卡片都是滚动区直接子项，跳过底部加载状态。 */
    const visible = [...container.children].find((element) => element instanceof HTMLElement && element.dataset.operationId && element.getBoundingClientRect().bottom > top) as HTMLElement | undefined;
    anchor.current = visible ? { id: visible.dataset.operationId!, offset: visible.getBoundingClientRect().top - top } : null;
  }

  useLayoutEffect(() => {
    /** DOM 更新后按原记录偏移补偿新增内容的高度。 */
    const container = root.current;
    if (container && anchor.current) {
      /** 使用已知元素身份查找，不把输出文本拼成选择器。 */
      const element = [...container.children].find((child) => child instanceof HTMLElement && child.dataset.operationId === anchor.current!.id);
      if (element) container.scrollTop += element.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.current.offset;
    }
    rememberPosition();
  }, [props.history.items]);

  useEffect(() => {
    if (!root.current || !sentinel.current || props.history.loading || props.history.error || !props.history.nextCursor || typeof IntersectionObserver === 'undefined') return;
    /** 使用浏览器原生可见性观察，靠近底部 240 像素时加载下一页。 */
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void props.history.loadMore();
      },
      { root: root.current, rootMargin: '240px 0px' },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [props.history.loading, props.history.error, props.history.nextCursor, props.history.loadMore, props.history.items.length]);

  return (
    <div ref={root} className="project-git-console-surface" role="region" aria-label={props.zh ? 'Git 操作历史' : 'Git operation history'} tabIndex={0} onScroll={rememberPosition} aria-busy={props.history.loading}>
      {props.history.total === 0 && !props.history.loading && !props.history.error ? (
        <section className="project-git-empty-surface">
          <ArrowsClockwise aria-hidden="true" />
          <strong>{props.zh ? '这个项目还没有 Git 工作台操作记录' : 'No Git workbench operations for this project yet'}</strong>
          <span>{props.zh ? '通过桌面 Git 工作台执行的操作会保存在这里。' : 'Operations performed through the desktop Git workbench are saved here.'}</span>
        </section>
      ) : null}
      {props.history.items.map((operation) => (
        <article key={operation.id} data-operation-id={operation.id} data-tone={operation.status === 'completed' ? 'success' : operation.status === 'failed_before_write' ? 'error' : 'warning'}>
          {operation.status === 'completed' ? <CheckCircle aria-hidden="true" /> : operation.status === 'running' ? <CircleNotch aria-hidden="true" /> : <WarningCircle aria-hidden="true" />}
          <span>
            <strong>
              {operation.action && Object.hasOwn(operationActionLabels, operation.action)
                ? operationActionLabels[operation.action as ProjectGitAction['type']][props.zh ? 0 : 1]
                : (operation.action ?? (props.zh ? 'Git 操作' : 'Git operation'))}
            </strong>
            <small>
              {operation.repositoryName} · <time dateTime={operation.startedAt}>{new Date(operation.startedAt).toLocaleString(props.zh ? 'zh-CN' : 'en-US')}</time>
              {operation.durationMs !== null ? ` · ${operation.durationMs} ms` : ''}
            </small>
            <span>{operationStatusLabels[operation.status][props.zh ? 0 : 1]}</span>
            {operation.commands?.length ? <pre aria-label={props.zh ? '执行的 Git 命令' : 'Git commands invoked'}>{operation.commands.map((command) => `$ ${command}`).join('\n')}</pre> : null}
            {operation.status === 'unknown_after_write' ? (
              <small>{props.zh ? '请刷新并核对仓库状态；推送还需要核对远端。不会自动重试此操作。' : 'Refresh and check the repository; also check the remote for a push. This operation will not be retried automatically.'}</small>
            ) : null}
            {operation.output ? <pre>{operation.output}</pre> : null}
            {operation.limitations.map((limitation) => (
              <small key={limitation}>{operationLimitationLabels[limitation][props.zh ? 0 : 1]}</small>
            ))}
          </span>
        </article>
      ))}
      <footer ref={sentinel} className="project-git-console-pagination">
        {props.history.error ? (
          <>
            <span role="alert">
              {props.zh ? '操作历史读取失败：' : 'Could not read operation history: '}
              {props.history.error}
            </span>
            <Button variant="secondary" size="compact" onClick={() => void props.history.retry()}>
              {props.zh ? '重试读取' : 'Retry loading'}
            </Button>
          </>
        ) : props.history.loading || props.history.total === null ? (
          <span role="status">{props.zh ? '正在加载操作记录…' : 'Loading operation records…'}</span>
        ) : props.history.nextCursor ? (
          <Button variant="secondary" size="compact" onClick={() => void props.history.loadMore()}>
            {props.zh ? '加载更多' : 'Load more'}
          </Button>
        ) : props.history.items.length > 0 ? (
          <span role="status">{props.zh ? '已加载全部' : 'All records loaded'}</span>
        ) : null}
      </footer>
    </div>
  );
}

/** 动作名称只按已保存的类型翻译，不从 Git 输出猜测操作。 */
const operationActionLabels: Record<ProjectGitAction['type'], [string, string]> = {
  discard: ['放弃修改', 'Discard changes'],
  rename_branch: ['重命名分支', 'Rename branch'],
  create_tag: ['创建标签', 'Create tag'],
  push_tag: ['推送标签', 'Push tag'],
  delete_tag: ['删除标签', 'Delete tag'],
  subtree: ['子树操作', 'Subtree operation'],
  submodule_update: ['更新子模块', 'Update submodule'],
  fetch: ['获取', 'Fetch'],
  stage: ['暂存', 'Stage'],
  unstage: ['取消暂存', 'Unstage'],
  apply_patch: ['应用补丁', 'Apply patch'],
  commit: ['提交', 'Commit'],
  push: ['推送', 'Push'],
  pull: ['拉取', 'Pull'],
  update: ['更新', 'Update'],
  checkout: ['切换分支', 'Switch branch'],
  checkout_revision: ['检出提交', 'Checkout revision'],
  create_branch: ['创建分支', 'Create branch'],
  delete_branch: ['删除分支', 'Delete branch'],
  revert: ['撤销提交', 'Revert commit'],
  cherry_pick: ['拣选提交', 'Cherry-pick commit'],
  merge: ['合并', 'Merge'],
  rebase: ['变基', 'Rebase'],
  stash: ['创建 Stash', 'Create stash'],
  apply_stash: ['应用 Stash', 'Apply stash'],
  drop_stash: ['删除 Stash', 'Drop stash'],
  continue_integration: ['继续合并或变基', 'Continue integration'],
  abort_integration: ['终止合并或变基', 'Abort integration'],
};

/** 文本明确表达账本事实，颜色与图标不承担唯一的状态提示。 */
const operationStatusLabels: Record<ProjectGitOperationRecord['status'], [string, string]> = {
  running: ['正在执行', 'Running'],
  completed: ['已完成', 'Completed'],
  conflict: ['存在冲突，需要处理', 'Conflicts need attention'],
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
      <button type="button" role="menuitem" onClick={action(props.onOpenCommit)}>
        {props.zh ? '提交…' : 'Commit…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenPush)}>
        {props.zh ? '推送…' : 'Push…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenUpdate)}>
        {props.zh ? '更新项目…' : 'Update Project…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenSubtree)}>
        {props.zh ? '管理子树…' : 'Manage subtrees…'}
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={action(props.onOpenNewBranch)}>
        {props.zh ? '新建分支…' : 'New Branch…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenRevision)}>
        {props.zh ? '切换到标签或提交…' : 'Switch to a tag or commit…'}
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={action(() => props.onSelectTab('log'))}>
        {props.zh ? '显示 Git 历史' : 'Show Git History'}
      </button>
      <button type="button" role="menuitem" onClick={action(() => props.onSelectTab('changes'))}>
        {props.zh ? '未提交的变更' : 'Uncommitted Changes'}
      </button>
      <button type="button" role="menuitem" onClick={action(() => props.onSelectTab('stash'))}>
        {props.zh ? '贮藏' : 'Stashes'}
      </button>
      {props.onOpenConsole ? (
        <button type="button" role="menuitem" onClick={action(props.onOpenConsole)}>
          {props.zh ? '控制台 / 操作记录' : 'Console / Operation history'}
        </button>
      ) : null}
    </MenuSurface>,
    document.body,
  );
}

function CommitDialog(props: {
  open: boolean;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const [message, setMessage] = useState('');
  const staged = props.repositories.filter((repository) => repository.snapshot.fileStatuses.some((file) => file.indexStatus !== ' ' && file.indexStatus !== '?'));
  if (!props.open) return null;
  return (
    <ModalPortal
      rootClassName="project-git-modal-root"
      backdropClassName="project-git-modal-backdrop"
      onDismiss={props.onClose}
      dismissDisabled={props.busy !== null}
      role="dialog"
      aria-label={props.zh ? '提交已暂存变更' : 'Commit staged changes'}
    >
      <section className="project-git-commit-dialog" data-modal-surface="dialog">
        <header>
          <strong>{props.zh ? '提交已暂存变更' : 'Commit staged changes'}</strong>
          <small>{props.zh ? '每个仓库会分别创建提交。' : 'Each repository will receive a separate commit.'}</small>
        </header>
        <main>
          {staged.map((repository) => (
            <span key={repository.id}>
              <GitBranch aria-hidden="true" />
              <strong>{repository.name}</strong>
              <small>
                {repository.snapshot.fileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?').length} {props.zh ? '个文件' : 'files'}
              </small>
            </span>
          ))}
          <label>
            <span>{props.zh ? '提交说明' : 'Commit message'}</span>
            <textarea value={message} onChange={(event) => setMessage(event.currentTarget.value)} autoFocus />
          </label>
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            busy={props.busy?.action === 'commit'}
            disabled={!message.trim() || staged.length === 0 || props.busy !== null}
            onClick={async () => {
              for (const repository of staged) {
                const outcome = await props.onExecute(repository, { type: 'commit', message: message.trim() }, props.zh ? '提交已暂存变更' : 'Commit staged changes');
                if (outcome !== 'completed') return;
              }
              setMessage('');
              props.onClose();
            }}
          >
            {props.zh ? `提交 ${staged.length} 个仓库` : `Commit ${staged.length} repositories`}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function readRememberedTab(projectId: string): GitTab {
  const value = typeof window === 'undefined' ? null : window.localStorage.getItem(`zeus.project-git-tab-v2:${projectId}`);
  return value === 'changes' || value === 'stash' || value === 'console' ? value : 'log';
}

function gitFileStatusLabel(category: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    added: ['新增', 'Added'],
    modified: ['修改', 'Modified'],
    deleted: ['删除', 'Deleted'],
    renamed: ['重命名', 'Renamed'],
    untracked: ['未跟踪', 'Untracked'],
    conflict: ['冲突', 'Conflict'],
    other: ['变更', 'Changed'],
  };
  return (labels[category] ?? labels.other)[zh ? 0 : 1];
}

function displayStashSubject(subject: string, zh: boolean): string {
  const cleaned = subject.replace(/^(?:On\s+[^:]+|WIP\s+on\s+[^:]+):\s*/iu, '').trim();
  return cleaned || (zh ? '未命名 Stash' : 'Untitled stash');
}

function errorMessage(error: unknown, zh: boolean, options: { title?: string; action?: { label: string; onClick: () => void | Promise<void> } } = {}): string {
  return reportApplicationError(error, { language: zh ? 'zh-CN' : 'en', ...options });
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

/** 将当前文件的单个 hunk 重建为 Git 可接受的 patch，供暂存、取消暂存或放弃使用。 */
function buildGitHunkPatch(file: GitFileDiff, hunk: GitDiffHunk): string {
  const oldPath = file.oldPath || file.newPath;
  const newPath = file.newPath || file.oldPath;
  const lines = hunk.lines.map((line) => {
    if (line.type === 'addition') return `+${line.content}`;
    if (line.type === 'deletion') return `-${line.content}`;
    if (line.type === 'context') return ` ${line.content}`;
    return line.content;
  });
  return [`diff --git a/${oldPath} b/${newPath}`, file.changeType === 'added' ? '--- /dev/null' : `--- a/${oldPath}`, file.changeType === 'deleted' ? '+++ /dev/null' : `+++ b/${newPath}`, hunk.header, ...lines, ''].join('\n');
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
              void props.onExecute(props.repository, { type: 'subtree', operation, path, remote, branch }, props.zh ? '子树操作' : 'Subtree operation').then((result) => {
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
