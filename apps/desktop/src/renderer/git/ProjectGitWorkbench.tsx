import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
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
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { DashboardClient, ProjectGitAction, ProjectGitCommitDetail, ProjectGitRepositoryWorkbenchItem, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { SideBySideDiff } from './ProjectGitDiffViewer.js';

type GitTab = 'changes' | 'shelf' | 'stash' | 'log' | 'console';
type BusyState = { repositoryId: string; action: ProjectGitAction['type'] } | null;
type OperationTone = 'success' | 'warning' | 'error';
type ChangeStage = 'staged' | 'unstaged';
type BranchKind = 'local' | 'remote';
type ExecutionOutcome = 'completed' | 'conflict' | null;

interface OperationRecord {
  id: string;
  repositoryId: string;
  repositoryName: string;
  action: ProjectGitAction['type'];
  label: string;
  startedAt: string;
  durationMs: number;
  tone: OperationTone;
  output: string;
}

export interface ProjectGitWorkbenchProps {
  project: ProjectRecord;
  client: Pick<DashboardClient, 'loadProjectGitWorkbench' | 'loadProjectGitCommit' | 'executeProjectGitAction'>;
  language: 'zh-CN' | 'en-US';
}

export function ProjectGitWorkbench(props: ProjectGitWorkbenchProps) {
  const zh = props.language === 'zh-CN';
  const [snapshot, setSnapshot] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<GitTab>(() => readRememberedTab(props.project.id));
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  const [selectedCommitHash, setSelectedCommitHash] = useState('');
  const [commitDetail, setCommitDetail] = useState<ProjectGitCommitDetail | null>(null);
  const [commitLoading, setCommitLoading] = useState(false);
  const [selectedFilePath, setSelectedFilePath] = useState('');
  const [selectedFileStage, setSelectedFileStage] = useState<ChangeStage>('unstaged');
  const [searchQuery, setSearchQuery] = useState('');
  const [operationsOpen, setOperationsOpen] = useState(false);
  const [pushOpen, setPushOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [newBranchOpen, setNewBranchOpen] = useState(false);
  const [newBranchBase, setNewBranchBase] = useState('');
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [busy, setBusy] = useState<BusyState>(null);
  const [operationRecords, setOperationRecords] = useState<OperationRecord[]>([]);
  const [pushResults, setPushResults] = useState<Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>>([]);
  const requestVersionRef = useRef(0);

  const repositories = snapshot?.repositories ?? [];
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0] ?? null;
  const changedCount = repositories.reduce((total, repository) => total + repository.snapshot.fileStatuses.length, 0);
  const conflictCount = repositories.reduce((total, repository) => total + repository.snapshot.conflictFiles.length, 0);
  const allCommits = useMemo(
    () =>
      repositories
        .flatMap((repository) => repository.snapshot.recentCommits.map((commit) => ({ repository, commit })))
        .filter(({ commit }) => `${commit.subject} ${commit.author} ${commit.hash}`.toLocaleLowerCase().includes(searchQuery.trim().toLocaleLowerCase()))
        .sort((left, right) => Date.parse(right.commit.authoredAt) - Date.parse(left.commit.authoredAt)),
    [repositories, searchQuery],
  );

  useEffect(() => {
    void loadWorkbench();
    return () => {
      requestVersionRef.current += 1;
    };
  }, [props.project.id]);

  useEffect(() => {
    window.localStorage.setItem(`zeus.project-git-tab-v2:${props.project.id}`, tab);
  }, [props.project.id, tab]);

  useEffect(() => {
    if (!selectedRepository) {
      setSelectedCommitHash('');
      setCommitDetail(null);
      return;
    }
    const preferred = selectedCommitHash && selectedRepository.snapshot.recentCommits.some((commit) => commit.hash === selectedCommitHash) ? selectedCommitHash : (selectedRepository.snapshot.recentCommits[0]?.hash ?? '');
    if (preferred !== selectedCommitHash) setSelectedCommitHash(preferred);
  }, [selectedRepository?.id, selectedRepository?.snapshot.headSha]);

  useEffect(() => {
    if (!selectedRepository || !selectedCommitHash || tab !== 'log') {
      setCommitDetail(null);
      return;
    }
    let cancelled = false;
    setCommitLoading(true);
    props.client
      .loadProjectGitCommit(props.project.id, selectedRepository.id, selectedCommitHash)
      .then((detail) => {
        if (cancelled) return;
        setCommitDetail(detail);
        setSelectedFilePath(detail.files[0]?.path ?? '');
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setCommitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [props.project.id, selectedRepository?.id, selectedCommitHash, tab]);

  async function loadWorkbench(): Promise<void> {
    const version = ++requestVersionRef.current;
    setLoadState('loading');
    setError(null);
    try {
      const next = await props.client.loadProjectGitWorkbench(props.project.id);
      if (version !== requestVersionRef.current) return;
      setSnapshot(next);
      setSelectedRepositoryId((current) => (next.repositories.some((repository) => repository.id === current) ? current : (next.repositories[0]?.id ?? '')));
      setLoadState('ready');
    } catch (reason) {
      if (version !== requestVersionRef.current) return;
      setLoadState('error');
      setError(errorMessage(reason));
    }
  }

  async function execute(repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string): Promise<ExecutionOutcome> {
    const started = performance.now();
    setBusy({ repositoryId: repository.id, action: action.type });
    setError(null);
    try {
      const response = await props.client.executeProjectGitAction(props.project.id, repository.id, action);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              refreshedAt: new Date().toISOString(),
              repositories: current.repositories.map((candidate) => (candidate.id === repository.id ? { ...candidate, snapshot: response.snapshot } : candidate)),
            }
          : current,
      );
      addOperationRecord(
        repository,
        action.type,
        response.result.outcome === 'conflict' ? (zh ? '操作停在冲突现场' : 'Operation stopped on conflicts') : label,
        response.result.outcome === 'conflict' ? 'warning' : 'success',
        [response.result.stdout, response.result.stderr, ...response.result.conflictFiles].filter(Boolean).join('\n'),
        performance.now() - started,
      );
      if (response.result.outcome === 'conflict') setTab('changes');
      return response.result.outcome;
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message);
      addOperationRecord(repository, action.type, label, 'error', message, performance.now() - started);
      return null;
    } finally {
      setBusy(null);
    }
  }

  function addOperationRecord(repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction['type'], label: string, tone: OperationTone, output: string, durationMs: number): void {
    setOperationRecords((current) => [
      {
        id: `${Date.now()}-${repository.id}-${action}`,
        repositoryId: repository.id,
        repositoryName: repository.name,
        action,
        label,
        startedAt: new Date().toISOString(),
        durationMs: Math.round(durationMs),
        tone,
        output,
      },
      ...current,
    ]);
  }

  function selectCommit(repository: ProjectGitRepositoryWorkbenchItem, commitHash: string): void {
    setSelectedRepositoryId(repository.id);
    setSelectedCommitHash(commitHash);
  }

  function openDiffWindow(repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }): void {
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
        <strong>{zh ? '正在读取项目 Git 现场' : 'Loading project Git state'}</strong>
        <span>{zh ? '正在发现当前项目中的真实仓库。' : 'Discovering real repositories in this project.'}</span>
      </section>
    );
  }

  if (loadState === 'error' && !snapshot) {
    return (
      <section className="project-git-workbench-state" role="alert">
        <WarningCircle aria-hidden="true" />
        <strong>{zh ? '无法读取项目 Git 现场' : 'Project Git state is unavailable'}</strong>
        <span>{error}</span>
        <Button variant="secondary" onClick={() => void loadWorkbench()}>
          {zh ? '重试' : 'Retry'}
        </Button>
      </section>
    );
  }

  if (repositories.length === 0) {
    return (
      <section className="project-git-workbench-state">
        <GitBranch aria-hidden="true" />
        <strong>{zh ? '这个项目中没有发现 Git 仓库' : 'No Git repository was found'}</strong>
        <span>{zh ? 'Zeus 只展示当前项目目录内实时发现的真实 Git 根。' : 'Zeus only shows real Git roots discovered inside the current project.'}</span>
        <Button variant="secondary" onClick={() => void loadWorkbench()}>
          {zh ? '重新扫描' : 'Scan again'}
        </Button>
      </section>
    );
  }

  return (
    <section className="project-git-workbench" aria-label={zh ? '项目 Git 工作台' : 'Project Git workbench'}>
      <header className="project-git-toolbar">
        <span className="project-git-project-identity">
          <strong>{props.project.name}</strong>
          <small>{zh ? `${repositories.length} 个仓库` : `${repositories.length} repositories`}</small>
        </span>
        <BranchSwitcher
          zh={zh}
          repositories={repositories}
          selectedRepository={selectedRepository}
          busy={busy}
          onSelectRepository={setSelectedRepositoryId}
          onExecute={execute}
          onOpenDiff={openDiffWindow}
          onOpenUpdate={() => setUpdateOpen(true)}
          onOpenCommit={() => setCommitOpen(true)}
          onOpenPush={() => setPushOpen(true)}
          onOpenNewBranch={(baseRef) => {
            setNewBranchBase(baseRef ?? '');
            setNewBranchOpen(true);
          }}
          onOpenRevision={() => setRevisionOpen(true)}
        />
        <span className="project-git-toolbar-actions">
          <Button variant="secondary" size="compact" busy={loadState === 'loading'} onClick={() => void loadWorkbench()}>
            {zh ? '刷新' : 'Refresh'}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              if (selectedRepository) void execute(selectedRepository, { type: 'fetch' }, zh ? '获取远端' : 'Fetch');
            }}
            disabled={!selectedRepository || busy !== null}
          >
            {zh ? '获取' : 'Fetch'}
          </Button>
          <Button
            variant="secondary"
            size="compact"
            onClick={() => {
              if (selectedRepository) void execute(selectedRepository, { type: 'pull', strategy: 'rebase' }, zh ? '拉取并变基' : 'Pull with rebase');
            }}
            disabled={!selectedRepository || busy !== null || selectedRepository.snapshot.detached || selectedRepository.snapshot.remotes.length === 0}
          >
            {zh ? '拉取' : 'Pull'}
          </Button>
          <Button variant="secondary" size="compact" onClick={() => setPushOpen(true)} disabled={busy !== null}>
            {zh ? '推送' : 'Push'}
          </Button>
          <span className="project-git-menu-anchor">
            <Button variant="secondary" size="compact" onClick={() => setOperationsOpen((current) => !current)}>
              {zh ? '操作' : 'Actions'} <CaretDown aria-hidden="true" />
            </Button>
            {operationsOpen ? (
              <OperationsMenu
                zh={zh}
                onClose={() => setOperationsOpen(false)}
                onOpenCommit={() => setCommitOpen(true)}
                onOpenPush={() => setPushOpen(true)}
                onOpenUpdate={() => setUpdateOpen(true)}
                onOpenNewBranch={() => {
                  setNewBranchBase('');
                  setNewBranchOpen(true);
                }}
                onOpenRevision={() => setRevisionOpen(true)}
                onSelectTab={setTab}
              />
            ) : null}
          </span>
        </span>
      </header>

      <nav className="project-git-tabs" aria-label={zh ? 'Git 工作区' : 'Git workspace'}>
        {(
          [
            ['changes', zh ? '本地变更' : 'Local Changes', changedCount],
            ['shelf', 'Shelf', 0],
            ['stash', 'Stash', repositories.reduce((total, repository) => total + repository.snapshot.stashes.length, 0)],
            ['log', zh ? '日志' : 'Log', null],
            ['console', zh ? '控制台' : 'Console', operationRecords.length],
          ] as const
        ).map(([id, label, count]) => (
          <button key={id} type="button" className={tab === id ? 'is-active' : ''} aria-current={tab === id ? 'page' : undefined} onClick={() => setTab(id)}>
            {label}
            {count !== null ? <span>{count}</span> : null}
          </button>
        ))}
        <span className="project-git-tab-facts">
          {conflictCount > 0 ? <em>{zh ? `${conflictCount} 个冲突` : `${conflictCount} conflicts`}</em> : null}
          <label>
            <MagnifyingGlass aria-hidden="true" />
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.currentTarget.value)} placeholder={zh ? '搜索提交、作者或分支' : 'Search commits, authors, or branches'} />
          </label>
        </span>
      </nav>

      {error ? (
        <div className="project-git-inline-error" role="alert">
          <WarningCircle aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={zh ? '收起错误' : 'Dismiss error'}>
            {zh ? '收起' : 'Dismiss'}
          </button>
        </div>
      ) : null}

      {tab === 'log' ? (
        <GitLogSurface
          zh={zh}
          repositories={repositories}
          commits={allCommits.filter(({ repository }) => repository.id === selectedRepository?.id)}
          selectedRepository={selectedRepository}
          selectedCommitHash={selectedCommitHash}
          commitDetail={commitDetail}
          commitLoading={commitLoading}
          selectedFilePath={selectedFilePath}
          onSelectRepository={setSelectedRepositoryId}
          onSelectCommit={selectCommit}
          onSelectFile={setSelectedFilePath}
          busy={busy}
          onExecute={execute}
          onOpenDiff={openDiffWindow}
        />
      ) : tab === 'changes' ? (
        <LocalChangesSurface
          zh={zh}
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
          onCommit={() => setCommitOpen(true)}
        />
      ) : tab === 'stash' ? (
        <StashSurface zh={zh} repositories={repositories} busy={busy} onExecute={execute} />
      ) : tab === 'shelf' ? (
        <ShelfSurface zh={zh} />
      ) : (
        <ConsoleSurface zh={zh} operations={operationRecords} />
      )}

      <CommitDialog open={commitOpen} zh={zh} repositories={repositories} busy={busy} onClose={() => setCommitOpen(false)} onExecute={execute} />
      <UpdateProjectDialog open={updateOpen} projectId={props.project.id} zh={zh} repositories={repositories} busy={busy} onClose={() => setUpdateOpen(false)} onExecute={execute} />
      <NewBranchDialog open={newBranchOpen} zh={zh} repositories={repositories} selectedRepository={selectedRepository} baseRef={newBranchBase} busy={busy} onClose={() => setNewBranchOpen(false)} onExecute={execute} />
      <CheckoutRevisionDialog open={revisionOpen} zh={zh} repositories={repositories} selectedRepository={selectedRepository} busy={busy} onClose={() => setRevisionOpen(false)} onExecute={execute} />
      <PushDialog
        open={pushOpen}
        zh={zh}
        repositories={repositories}
        busy={busy}
        results={pushResults}
        onClose={() => {
          setPushOpen(false);
          setPushResults([]);
        }}
        onPush={async (selections, forceWithLease, pushTags) => {
          const results: Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }> = [];
          for (const repository of repositories.filter((candidate) => selections.some((selection) => selection.repositoryId === candidate.id))) {
            const selection = selections.find((candidate) => candidate.repositoryId === repository.id)!;
            const ok = await execute(repository, { type: 'push', remote: selection.remote, targetBranch: selection.targetBranch, forceWithLease, pushTags }, zh ? '推送提交' : 'Push commits');
            results.push({
              repositoryId: repository.id,
              repositoryName: repository.name,
              tone: ok ? 'success' : 'error',
              message: ok
                ? zh
                  ? `已推送 ${repository.snapshot.outgoingCommits.length} 个提交`
                  : `Pushed ${repository.snapshot.outgoingCommits.length} commits`
                : zh
                  ? '推送失败，其他仓库结果不回滚'
                  : 'Push failed; other repository results are not rolled back',
            });
          }
          setPushResults(results);
        }}
      />
    </section>
  );
}

type ProjectGitUpdateStrategy = 'merge' | 'rebase' | 'reset';

function BranchSwitcher(props: {
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  busy: BusyState;
  onSelectRepository: (repositoryId: string) => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
  onOpenUpdate: () => void;
  onOpenCommit: () => void;
  onOpenPush: () => void;
  onOpenNewBranch: (baseRef?: string) => void;
  onOpenRevision: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; repository: ProjectGitRepositoryWorkbenchItem; branch: string; kind: BranchKind } | null>(null);
  const [revisionMenu, setRevisionMenu] = useState<{ x: number; y: number; repository: ProjectGitRepositoryWorkbenchItem; revision: string } | null>(null);
  const [commonBranch, setCommonBranch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const currentLabels = props.repositories.map((repository) => currentRepositoryRefLabel(repository, props.zh));
  const sameCurrent = new Set(currentLabels).size === 1;
  const triggerLabel =
    props.repositories.length === 1
      ? (currentLabels[0] ?? (props.zh ? '分支不可用' : 'Branch unavailable'))
      : props.zh
        ? `${props.repositories.length} 个仓库 · ${sameCurrent ? currentLabels[0] : '分支已分歧'}`
        : `${props.repositories.length} repositories · ${sameCurrent ? currentLabels[0] : 'branches differ'}`;
  const commonLocalBranches = useMemo(() => intersectRepositoryValues(props.repositories, (repository) => repository.snapshot.localBranches), [props.repositories]);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 530)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 620)) });
    };
    const close = (event: PointerEvent) => {
      if (!popoverRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape, true);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  const matches = (value: string): boolean => !normalizedQuery || value.toLocaleLowerCase().includes(normalizedQuery);
  const runAction = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  const openReferenceMenu = (event: ReactMouseEvent<HTMLButtonElement>, repository: ProjectGitRepositoryWorkbenchItem, ref: string, kind: BranchKind | 'tag' | 'revision') => {
    const rect = event.currentTarget.getBoundingClientRect();
    setOpen(false);
    props.onSelectRepository(repository.id);
    if (kind === 'local' || kind === 'remote') setBranchMenu({ x: rect.right + 4, y: rect.top, repository, branch: ref, kind });
    else setRevisionMenu({ x: rect.right + 4, y: rect.top, repository, revision: ref });
  };
  const quickActions = [
    { id: 'update', label: props.zh ? '更新项目…' : 'Update Project…', run: props.onOpenUpdate },
    { id: 'commit', label: props.zh ? '提交…' : 'Commit…', run: props.onOpenCommit },
    { id: 'push', label: props.zh ? '推送…' : 'Push…', run: props.onOpenPush },
    { id: 'new-branch', label: props.zh ? '新建分支…' : 'New Branch…', run: () => props.onOpenNewBranch() },
    { id: 'revision', label: props.zh ? '签出标签或 Revision…' : 'Checkout Tag or Revision…', run: props.onOpenRevision },
  ].filter((action) => matches(action.label));

  const popover = open ? (
    <div ref={popoverRef} className="project-git-branch-popover" role="dialog" aria-label={props.zh ? '分支与 Git 操作' : 'Branches and Git actions'} style={position}>
      <label className="project-git-branch-search">
        <MagnifyingGlass aria-hidden="true" />
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder={props.zh ? '搜索分支和操作' : 'Search for branches and actions'} />
      </label>
      <div className="project-git-branch-popover-scroll">
        {quickActions.length > 0 ? (
          <section className="project-git-branch-actions" aria-label={props.zh ? 'Git 操作' : 'Git actions'}>
            {quickActions.map((action) => (
              <button key={action.id} type="button" onClick={runAction(action.run)} disabled={props.busy !== null}>
                {action.label}
              </button>
            ))}
          </section>
        ) : null}
        {props.repositories.length > 1 && commonLocalBranches.some(matches) ? (
          <section className="project-git-branch-group">
            <strong>{props.zh ? '共同本地分支' : 'Common local branches'}</strong>
            {commonLocalBranches.filter(matches).map((branch) => (
              <div key={branch} className="project-git-common-branch">
                <button type="button" className={branch === commonBranch ? 'is-current' : ''} onClick={() => setCommonBranch((current) => (current === branch ? '' : branch))}>
                  <GitBranch aria-hidden="true" />
                  <span>{branch}</span>
                  <CaretRight aria-hidden="true" />
                </button>
                {commonBranch === branch ? (
                  <span className="project-git-common-branch-actions">
                    <button
                      type="button"
                      disabled={props.busy !== null || props.repositories.some((repository) => repository.snapshot.detached)}
                      onClick={async () => {
                        for (const repository of props.repositories)
                          await props.onExecute(repository, { type: 'checkout', branchName: branch, smart: true }, props.zh ? `在全部仓库签出“${branch}”` : `Checkout '${branch}' in all repositories`);
                        setOpen(false);
                      }}
                    >
                      {props.zh ? `在全部 ${props.repositories.length} 个仓库签出` : `Checkout in all ${props.repositories.length} repositories`}
                    </button>
                    <button
                      type="button"
                      disabled={props.busy !== null}
                      onClick={async () => {
                        for (const repository of props.repositories.filter((candidate) => candidate.snapshot.branch !== branch))
                          await props.onExecute(repository, { type: 'merge', branchName: branch }, props.zh ? `将“${branch}”合入当前分支` : `Merge '${branch}' into current branch`);
                        setOpen(false);
                      }}
                    >
                      {props.zh ? '合入各仓当前分支' : 'Merge into each current branch'}
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
          </section>
        ) : null}
        {props.repositories.map((repository) => (
          <RepositoryBranchGroups key={repository.id} zh={props.zh} repository={repository} query={normalizedQuery} onOpenReferenceMenu={openReferenceMenu} />
        ))}
        {quickActions.length === 0 && !props.repositories.some((repository) => repositoryHasMatchingReference(repository, normalizedQuery)) ? (
          <p className="project-git-branch-empty">{props.zh ? '没有匹配的分支、标签或操作。可使用“签出标签或 Revision”解析完整引用。' : 'No matching branch, tag, or action. Use Checkout Tag or Revision to resolve an exact ref.'}</p>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <>
      <button ref={triggerRef} type="button" className={`project-git-branch-trigger${open ? ' is-open' : ''}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <GitBranch aria-hidden="true" />
        <span>{triggerLabel}</span>
        <CaretDown aria-hidden="true" />
      </button>
      {typeof document !== 'undefined' && document.body && popover ? createPortal(popover, triggerRef.current?.closest('.macos-ai-app') ?? document.body) : popover}
      {branchMenu ? <BranchContextMenu {...branchMenu} zh={props.zh} busy={props.busy} onClose={() => setBranchMenu(null)} onExecute={props.onExecute} onOpenDiff={props.onOpenDiff} /> : null}
      {revisionMenu ? (
        <RevisionContextMenu
          {...revisionMenu}
          zh={props.zh}
          busy={props.busy}
          onClose={() => setRevisionMenu(null)}
          onExecute={props.onExecute}
          onNewBranch={(baseRef) => {
            setRevisionMenu(null);
            props.onOpenNewBranch(baseRef);
          }}
        />
      ) : null}
    </>
  );
}

function RepositoryBranchGroups(props: {
  zh: boolean;
  repository: ProjectGitRepositoryWorkbenchItem;
  query: string;
  onOpenReferenceMenu: (event: ReactMouseEvent<HTMLButtonElement>, repository: ProjectGitRepositoryWorkbenchItem, ref: string, kind: BranchKind | 'tag' | 'revision') => void;
}) {
  const matches = (value: string): boolean => !props.query || value.toLocaleLowerCase().includes(props.query);
  const groups = [
    { id: 'recent', label: props.zh ? '最近' : 'Recent', values: props.repository.snapshot.recentRefs.filter((item) => matches(item.ref)) },
    { id: 'local', label: props.zh ? '本地' : 'Local', values: props.repository.snapshot.localBranches.filter(matches).map((ref) => ({ ref, kind: 'local' as const })) },
    { id: 'remote', label: props.zh ? '远程' : 'Remote', values: props.repository.snapshot.remoteBranches.filter(matches).map((ref) => ({ ref, kind: 'remote' as const })) },
    { id: 'tags', label: 'Tags', values: props.repository.snapshot.tags.filter(matches).map((ref) => ({ ref, kind: 'tag' as const })) },
  ].filter((group) => group.values.length > 0);
  if (groups.length === 0) return null;
  return (
    <section className="project-git-branch-repository">
      <header>
        <strong>{props.repository.name}</strong>
        <small>{props.repository.relativePath === '.' ? currentRepositoryRefLabel(props.repository, props.zh) : `${props.repository.relativePath} · ${currentRepositoryRefLabel(props.repository, props.zh)}`}</small>
      </header>
      {groups.map((group) => (
        <div key={group.id} className="project-git-branch-group">
          <strong>{group.label}</strong>
          {group.values.map((item) => (
            <button
              key={`${group.id}:${item.ref}`}
              type="button"
              className={item.kind === 'local' && item.ref === props.repository.snapshot.branch ? 'is-current' : ''}
              onClick={(event) => props.onOpenReferenceMenu(event, props.repository, item.ref, item.kind)}
            >
              <GitBranch aria-hidden="true" />
              <span>{item.ref}</span>
              {item.kind === 'local' && item.ref === props.repository.snapshot.branch ? <small>{props.zh ? '当前' : 'Current'}</small> : null}
              <CaretRight aria-hidden="true" />
            </button>
          ))}
        </div>
      ))}
    </section>
  );
}

function RevisionContextMenu(props: {
  x: number;
  y: number;
  repository: ProjectGitRepositoryWorkbenchItem;
  revision: string;
  zh: boolean;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onNewBranch: (baseRef: string) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) props.onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, []);
  return (
    <div ref={menuRef} className="project-git-branch-context-menu" role="menu" style={{ left: Math.max(8, Math.min(props.x, window.innerWidth - 430)), top: Math.max(8, Math.min(props.y, window.innerHeight - 180)) }}>
      <button
        type="button"
        role="menuitem"
        disabled={props.busy !== null}
        onClick={() => {
          props.onClose();
          void props.onExecute(props.repository, { type: 'checkout_revision', revision: props.revision, smart: true }, props.zh ? `签出“${props.revision}”` : `Checkout '${props.revision}'`);
        }}
      >
        {props.zh ? '签出（进入游离提交状态）' : 'Checkout (detached HEAD)'}
      </button>
      <button type="button" role="menuitem" disabled={props.busy !== null} onClick={() => props.onNewBranch(props.revision)}>
        {props.zh ? `从“${props.revision}”新建分支…` : `New Branch from '${props.revision}'…`}
      </button>
    </div>
  );
}

function UpdateProjectDialog(props: {
  open: boolean;
  projectId: string;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const [strategy, setStrategy] = useState<ProjectGitUpdateStrategy>('merge');
  const [resetConfirmed, setResetConfirmed] = useState(false);
  const [results, setResults] = useState<Array<{ id: string; outcome: ExecutionOutcome }>>([]);
  useEffect(() => {
    if (!props.open) return;
    setStrategy(readUpdateStrategy(props.projectId));
    setResetConfirmed(false);
    setResults([]);
  }, [props.open, props.projectId]);
  if (!props.open) return null;
  const localCommitCount = props.repositories.reduce((total, repository) => total + repository.snapshot.outgoingCommits.length, 0);
  const resetNeedsConfirmation = strategy === 'reset' && localCommitCount > 0;
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
      <section className="project-git-update-dialog" role="dialog" aria-modal="true" aria-label={props.zh ? '更新项目' : 'Update project'}>
        <header>
          <strong>{props.zh ? '更新项目' : 'Update Project'}</strong>
          <small>
            {props.zh
              ? '从全部项目仓库获取远端变化，并使用同一种策略更新各仓当前分支。脏仓会先 Smart Stash，完成后恢复。'
              : 'Fetch every project repository and update each current branch with one strategy. Dirty repositories use Smart Stash and restore.'}
          </small>
        </header>
        <main>
          <fieldset className="project-git-update-strategies">
            <legend>{props.zh ? '更新方式' : 'Update method'}</legend>
            {(
              [
                ['merge', props.zh ? '合并远端变化' : 'Merge incoming changes', props.zh ? '保留本地提交历史，可能产生合并提交。' : 'Keep local commit history; may create a merge commit.'],
                ['rebase', props.zh ? '将当前分支变基到远端之上' : 'Rebase current branch onto incoming changes', props.zh ? '把本地提交重放到最新上游之后。' : 'Replay local commits on top of the updated upstream.'],
                ['reset', props.zh ? '重置到远端分支' : 'Reset to the remote branch', props.zh ? '丢弃本地分支尚未包含在远端中的提交。' : 'Drop local commits that are not present in the tracked remote branch.'],
              ] as const
            ).map(([value, title, description]) => (
              <label key={value} className={strategy === value ? 'is-current' : ''}>
                <input type="radio" name="project-git-update-strategy" value={value} checked={strategy === value} onChange={() => setStrategy(value)} />
                <span>
                  <strong>{title}</strong>
                  <small>{description}</small>
                </span>
              </label>
            ))}
          </fieldset>
          <section className="project-git-update-repositories">
            <strong>{props.zh ? `仓库 (${props.repositories.length})` : `Repositories (${props.repositories.length})`}</strong>
            {props.repositories.map((repository) => {
              const result = results.find((item) => item.id === repository.id)?.outcome;
              return (
                <span key={repository.id}>
                  <GitBranch aria-hidden="true" />
                  <b>{repository.name}</b>
                  <small>{repository.snapshot.detached ? (props.zh ? '游离提交状态，无法更新' : 'Detached HEAD; cannot update') : (repository.snapshot.upstream ?? (props.zh ? '没有跟踪远端' : 'No tracked remote'))}</small>
                  {repository.snapshot.fileStatuses.length > 0 ? <em>{props.zh ? `Smart Stash · ${repository.snapshot.fileStatuses.length} 个变化` : `Smart Stash · ${repository.snapshot.fileStatuses.length} changes`}</em> : null}
                  {result ? <i className={`is-${result}`}>{result === 'completed' ? (props.zh ? '已完成' : 'Completed') : props.zh ? '存在冲突' : 'Conflicts'}</i> : null}
                  {result === null && results.some((item) => item.id === repository.id) ? <i className="is-error">{props.zh ? '失败' : 'Failed'}</i> : null}
                </span>
              );
            })}
          </section>
          {resetNeedsConfirmation ? (
            <label className="project-git-update-reset-confirm">
              <input type="checkbox" checked={resetConfirmed} onChange={(event) => setResetConfirmed(event.currentTarget.checked)} />
              <span>
                {props.zh
                  ? `我确认丢弃全部仓库中共 ${localCommitCount} 个尚未进入跟踪远端的本地提交。未提交文件会通过 Smart Stash 恢复。`
                  : `I confirm dropping ${localCommitCount} local commits not present in tracked remotes. Uncommitted files will be restored through Smart Stash.`}
              </span>
            </label>
          ) : null}
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '关闭' : 'Close'}
          </Button>
          <Button
            variant={strategy === 'reset' ? 'danger' : 'primary'}
            busy={props.busy?.action === 'update'}
            disabled={props.busy !== null || (resetNeedsConfirmation && !resetConfirmed)}
            onClick={async () => {
              window.localStorage.setItem(`zeus.project-git-update-strategy:${props.projectId}`, strategy);
              const nextResults: Array<{ id: string; outcome: ExecutionOutcome }> = [];
              for (const repository of props.repositories) {
                const outcome = await props.onExecute(repository, { type: 'update', strategy, smart: true }, props.zh ? '更新项目' : 'Update project');
                nextResults.push({ id: repository.id, outcome });
                setResults([...nextResults]);
              }
            }}
          >
            {strategy === 'reset' ? (props.zh ? '重置全部仓库' : 'Reset all repositories') : props.zh ? '更新全部仓库' : 'Update all repositories'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function NewBranchDialog(props: {
  open: boolean;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  baseRef: string;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const [repositoryId, setRepositoryId] = useState('');
  const [branchName, setBranchName] = useState('');
  useEffect(() => {
    if (!props.open) return;
    setRepositoryId(props.selectedRepository?.id ?? props.repositories[0]?.id ?? '');
    setBranchName('');
  }, [props.open, props.selectedRepository?.id]);
  if (!props.open) return null;
  const repository = props.repositories.find((candidate) => candidate.id === repositoryId) ?? null;
  const baseRef = props.baseRef || repository?.snapshot.headSha || '';
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
      <section className="project-git-reference-dialog" role="dialog" aria-modal="true" aria-label={props.zh ? '新建分支' : 'New branch'}>
        <header>
          <strong>{props.zh ? '新建并签出分支' : 'Create and Checkout Branch'}</strong>
          <small>{props.zh ? `起点：${shortRef(baseRef)}` : `Starting point: ${shortRef(baseRef)}`}</small>
        </header>
        <main>
          {props.repositories.length > 1 && !props.baseRef ? (
            <label>
              <span>{props.zh ? '仓库' : 'Repository'}</span>
              <select value={repositoryId} onChange={(event) => setRepositoryId(event.currentTarget.value)}>
                {props.repositories.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{`${candidate.name} · ${currentRepositoryRefLabel(candidate, props.zh)}`}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>{props.zh ? '分支名称' : 'Branch name'}</span>
            <input value={branchName} onChange={(event) => setBranchName(event.currentTarget.value)} autoFocus placeholder="feature/example" />
          </label>
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            busy={props.busy?.action === 'create_branch'}
            disabled={!repository || !branchName.trim() || props.busy !== null}
            onClick={async () => {
              if (!repository) return;
              const outcome = await props.onExecute(repository, { type: 'create_branch', branchName: branchName.trim(), baseRef, smart: true }, props.zh ? '新建并签出分支' : 'Create and checkout branch');
              if (outcome) props.onClose();
            }}
          >
            {props.zh ? '创建并签出' : 'Create and Checkout'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function CheckoutRevisionDialog(props: {
  open: boolean;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const [repositoryId, setRepositoryId] = useState('');
  const [revision, setRevision] = useState('');
  useEffect(() => {
    if (!props.open) return;
    setRepositoryId(props.selectedRepository?.id ?? props.repositories[0]?.id ?? '');
    setRevision('');
  }, [props.open, props.selectedRepository?.id]);
  if (!props.open) return null;
  const repository = props.repositories.find((candidate) => candidate.id === repositoryId) ?? null;
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
      <section className="project-git-reference-dialog" role="dialog" aria-modal="true" aria-label={props.zh ? '签出标签或 Revision' : 'Checkout tag or revision'}>
        <header>
          <strong>{props.zh ? '签出标签或 Revision' : 'Checkout Tag or Revision'}</strong>
          <small>
            {props.zh ? '签出后进入游离提交状态；顶部会持续显示标签或短提交号，并提供从当前位置新建分支。' : 'Checkout enters detached HEAD. The toolbar keeps the tag or short commit visible and offers branch creation from that point.'}
          </small>
        </header>
        <main>
          {props.repositories.length > 1 ? (
            <label>
              <span>{props.zh ? '仓库' : 'Repository'}</span>
              <select value={repositoryId} onChange={(event) => setRepositoryId(event.currentTarget.value)}>
                {props.repositories.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>{props.zh ? '标签、分支或提交号' : 'Tag, branch, or commit'}</span>
            <input value={revision} onChange={(event) => setRevision(event.currentTarget.value)} autoFocus placeholder="v0.3.2 / a1b2c3d4" />
          </label>
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            busy={props.busy?.action === 'checkout_revision'}
            disabled={!repository || !revision.trim() || props.busy !== null}
            onClick={async () => {
              if (!repository) return;
              const outcome = await props.onExecute(repository, { type: 'checkout_revision', revision: revision.trim(), smart: true }, props.zh ? '签出 Revision' : 'Checkout revision');
              if (outcome) props.onClose();
            }}
          >
            {props.zh ? '签出' : 'Checkout'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

function currentRepositoryRefLabel(repository: ProjectGitRepositoryWorkbenchItem, zh: boolean): string {
  if (!repository.snapshot.detached) return repository.snapshot.branch;
  return `${zh ? '游离' : 'Detached'} · ${repository.snapshot.headTags[0] ?? repository.snapshot.headSha.slice(0, 8)}`;
}

function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/iu.test(ref) ? ref.slice(0, 8) : ref;
}

function intersectRepositoryValues(repositories: ProjectGitRepositoryWorkbenchItem[], read: (repository: ProjectGitRepositoryWorkbenchItem) => string[]): string[] {
  if (repositories.length === 0) return [];
  const [first, ...rest] = repositories;
  return [...new Set(read(first!))].filter((value) => rest.every((repository) => read(repository).includes(value))).sort((left, right) => left.localeCompare(right));
}

function repositoryHasMatchingReference(repository: ProjectGitRepositoryWorkbenchItem, query: string): boolean {
  if (!query) return true;
  return [...repository.snapshot.localBranches, ...repository.snapshot.remoteBranches, ...repository.snapshot.tags, ...repository.snapshot.recentRefs.map((item) => item.ref)].some((value) => value.toLocaleLowerCase().includes(query));
}

function readUpdateStrategy(projectId: string): ProjectGitUpdateStrategy {
  const value = typeof window === 'undefined' ? null : window.localStorage.getItem(`zeus.project-git-update-strategy:${projectId}`);
  return value === 'merge' || value === 'rebase' || value === 'reset' ? value : 'merge';
}

function GitLogSurface(props: {
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  commits: Array<{ repository: ProjectGitRepositoryWorkbenchItem; commit: ProjectGitRepositoryWorkbenchItem['snapshot']['recentCommits'][number] }>;
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  selectedCommitHash: string;
  commitDetail: ProjectGitCommitDetail | null;
  commitLoading: boolean;
  selectedFilePath: string;
  onSelectRepository: (repositoryId: string) => void;
  onSelectCommit: (repository: ProjectGitRepositoryWorkbenchItem, commitHash: string) => void;
  onSelectFile: (path: string) => void;
  busy: BusyState;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
}) {
  const selectedDiff = props.commitDetail?.diff.fileDiffs.find((file) => file.newPath === props.selectedFilePath || file.oldPath === props.selectedFilePath) ?? props.commitDetail?.diff.fileDiffs[0] ?? null;
  const [branchMenu, setBranchMenu] = useState<{ x: number; y: number; repository: ProjectGitRepositoryWorkbenchItem; branch: string; kind: BranchKind } | null>(null);
  return (
    <div className="project-git-log-layout">
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
          <span>{props.zh ? '图谱 / 提交信息' : 'Graph / Commit message'}</span>
          <span>{props.zh ? '作者' : 'Author'}</span>
          <span>{props.zh ? '日期' : 'Date'}</span>
        </header>
        <div className="project-git-commit-scroll">
          <CommitGraph commits={props.commits.map(({ commit }) => commit)} />
          <div className="project-git-commit-rows">
            {props.commits.map(({ repository, commit }) => {
              const selected = repository.id === props.selectedRepository?.id && commit.hash === props.selectedCommitHash;
              return (
                <button key={`${repository.id}:${commit.hash}`} type="button" className={`project-git-commit-row${selected ? ' is-current' : ''}`} onClick={() => props.onSelectCommit(repository, commit.hash)}>
                  <span className="project-git-commit-subject">
                    <strong>{commit.subject}</strong>
                    <small>
                      {repository.name} · {commit.shortHash}
                    </small>
                  </span>
                  <span>{commit.author}</span>
                  <time dateTime={commit.authoredAt}>{formatRelativeTime(commit.authoredAt, props.zh)}</time>
                </button>
              );
            })}
          </div>
        </div>
      </main>
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
            <SideBySideDiff diff={selectedDiff ? { isRepository: true, files: [props.selectedFilePath], diffText: props.commitDetail.diff.diffText, fileDiffs: [selectedDiff] } : null} zh={props.zh} />
          </>
        ) : (
          <p className="project-git-empty-copy">{props.zh ? '选择一个提交查看文件与差异。' : 'Select a commit to inspect files and diff.'}</p>
        )}
      </aside>
      {branchMenu ? <BranchContextMenu {...branchMenu} zh={props.zh} busy={props.busy} onClose={() => setBranchMenu(null)} onExecute={props.onExecute} onOpenDiff={props.onOpenDiff} /> : null}
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

interface BranchTreeNode {
  name: string;
  branch: string;
  children: Map<string, BranchTreeNode>;
}

function BranchDirectoryTree(props: { branches: string[]; current: string; kind: BranchKind; onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, branch: string) => void }) {
  const tree = useMemo(() => buildBranchTree(props.branches), [props.branches.join('\0')]);
  return (
    <div className="project-git-branch-directory-tree">
      {Array.from(tree.children.values()).map((node) => (
        <BranchTreeEntry key={node.branch || node.name} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

function BranchTreeEntry(props: Parameters<typeof BranchDirectoryTree>[0] & { node: BranchTreeNode; depth: number }) {
  if (props.node.children.size > 0) {
    return (
      <details className="project-git-branch-folder" open={props.node.branch ? props.node.branch === props.current || props.current.startsWith(`${props.node.branch}/`) : true}>
        <summary style={{ paddingLeft: `${props.depth * 12 + 5}px` }}>
          <CaretRight aria-hidden="true" />
          <Folder aria-hidden="true" />
          <span>{props.node.name}</span>
        </summary>
        {Array.from(props.node.children.values()).map((child) => (
          <BranchTreeEntry key={child.branch || child.name} {...props} node={child} depth={props.depth + 1} />
        ))}
      </details>
    );
  }
  return (
    <button type="button" className={props.node.branch === props.current ? 'is-current' : ''} style={{ paddingLeft: `${props.depth * 12 + 7}px` }} onContextMenu={(event) => props.onContextMenu(event, props.node.branch)}>
      <GitBranch aria-hidden="true" />
      <span>{props.node.name}</span>
    </button>
  );
}

function buildBranchTree(branches: string[]): BranchTreeNode {
  const root: BranchTreeNode = { name: '', branch: '', children: new Map() };
  for (const branch of [...branches].sort((left, right) => left.localeCompare(right))) {
    let current = root;
    const parts = branch.split('/').filter(Boolean);
    parts.forEach((part, index) => {
      const fullName = parts.slice(0, index + 1).join('/');
      const next = current.children.get(part) ?? { name: part, branch: fullName, children: new Map<string, BranchTreeNode>() };
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
    const rowHeight = 40;
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
        context.bezierCurveTo(12 + fromLane * 14, y + 14, 12 + destination * 14, nextY - 14, 12 + destination * 14, nextY);
        context.stroke();
      });
      for (const destination of destinations.slice(1)) {
        context.strokeStyle = colors[destination % colors.length]!;
        context.beginPath();
        context.moveTo(12 + lane * 14, y);
        context.bezierCurveTo(12 + lane * 14, y + 14, 12 + destination * 14, nextY - 14, 12 + destination * 14, nextY);
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

function LocalChangesSurface(props: {
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  selectedFilePath: string;
  selectedFileStage: ChangeStage;
  busy: BusyState;
  onSelectRepository: (repositoryId: string) => void;
  onSelectFile: (path: string, stage: ChangeStage) => void;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { stage?: 'combined' | ChangeStage; commitHash?: string; comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onCommit: () => void;
}) {
  const stageDiff = props.selectedFileStage === 'staged' ? props.selectedRepository?.snapshot.stagedDiff : props.selectedRepository?.snapshot.unstagedDiff;
  const selectedDiff = stageDiff?.fileDiffs.find((file) => file.newPath === props.selectedFilePath || file.oldPath === props.selectedFilePath) ?? stageDiff?.fileDiffs[0] ?? null;
  return (
    <div className="project-git-changes-layout">
      <aside className="project-git-change-tree">
        <header>
          <strong>{props.zh ? '变更文件' : 'Changed files'}</strong>
          <span>{props.repositories.reduce((total, repository) => total + repository.snapshot.fileStatuses.length, 0)}</span>
        </header>
        {props.repositories.map((repository) => {
          const staged = repository.snapshot.fileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?');
          const unstaged = repository.snapshot.fileStatuses.filter((file) => file.workingTreeStatus !== ' ' || file.indexStatus === '?');
          return (
            <section key={repository.id}>
              <button className="project-git-change-repository" type="button" onClick={() => props.onSelectRepository(repository.id)}>
                <GitBranch aria-hidden="true" />
                <strong>{repository.name}</strong>
                <small>{repository.snapshot.branch}</small>
              </button>
              {unstaged.length > 0 ? <span className="project-git-change-group-title">{props.zh ? '未暂存' : 'Unstaged'}</span> : null}
              <ChangeDirectoryTree
                files={unstaged.map((file) => file.path)}
                stage="unstaged"
                repository={repository}
                selectedRepositoryId={props.selectedRepository?.id}
                selectedFilePath={props.selectedFilePath}
                selectedFileStage={props.selectedFileStage}
                busy={props.busy}
                zh={props.zh}
                onSelectRepository={props.onSelectRepository}
                onSelectFile={props.onSelectFile}
                onOpenDiff={props.onOpenDiff}
                onExecute={props.onExecute}
              />
              {staged.length > 0 ? <span className="project-git-change-group-title">{props.zh ? '已暂存' : 'Staged'}</span> : null}
              <ChangeDirectoryTree
                files={staged.map((file) => file.path)}
                stage="staged"
                repository={repository}
                selectedRepositoryId={props.selectedRepository?.id}
                selectedFilePath={props.selectedFilePath}
                selectedFileStage={props.selectedFileStage}
                busy={props.busy}
                zh={props.zh}
                onSelectRepository={props.onSelectRepository}
                onSelectFile={props.onSelectFile}
                onOpenDiff={props.onOpenDiff}
                onExecute={props.onExecute}
              />
            </section>
          );
        })}
      </aside>
      <main className="project-git-change-diff">
        <SideBySideDiff diff={selectedDiff ? { isRepository: true, files: [props.selectedFilePath], diffText: stageDiff?.diffText ?? '', fileDiffs: [selectedDiff] } : null} zh={props.zh} />
      </main>
      <aside className="project-git-commit-rail">
        <strong>{props.zh ? '提交' : 'Commit'}</strong>
        {props.repositories.map((repository) => {
          const count = repository.snapshot.fileStatuses.filter((file) => file.indexStatus !== ' ' && file.indexStatus !== '?').length;
          return (
            <span key={repository.id}>
              <b>{repository.name}</b>
              <small>{props.zh ? `${count} 个已暂存文件` : `${count} staged files`}</small>
            </span>
          );
        })}
        <Button variant="primary" onClick={props.onCommit} disabled={props.repositories.every((repository) => repository.snapshot.fileStatuses.every((file) => file.indexStatus === ' ' || file.indexStatus === '?'))}>
          {props.zh ? '提交已暂存变更' : 'Commit staged changes'}
        </Button>
      </aside>
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
  const tree = useMemo(() => buildChangeTree(props.files), [props.files.join('\0')]);
  if (props.files.length === 0) return null;
  return (
    <div className="project-git-change-directory-tree">
      {Array.from(tree.children.values()).map((node) => (
        <ChangeTreeEntry key={node.path} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

function ChangeTreeEntry(props: Parameters<typeof ChangeDirectoryTree>[0] & { node: ChangeTreeNode; depth: number }) {
  if (!props.node.file) {
    return (
      <details className="project-git-change-folder" open>
        <summary style={{ paddingLeft: `${props.depth * 13 + 6}px` }}>
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
  return (
    <div className={`project-git-change-file-row${selected ? ' is-current' : ''}`} style={{ paddingLeft: `${props.depth * 13 + 8}px` }}>
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
        title={props.node.path}
        onClick={() => {
          props.onSelectRepository(props.repository.id);
          props.onSelectFile(props.node.path, props.stage);
        }}
        onDoubleClick={() => props.onOpenDiff(props.repository, props.node.path, { stage: props.stage })}
      >
        <File aria-hidden="true" />
        <span>{props.node.name}</span>
      </button>
    </div>
  );
}

function buildChangeTree(paths: string[]): ChangeTreeNode {
  const root: ChangeTreeNode = { name: '', path: '', children: new Map(), file: false };
  for (const path of paths.sort((left, right) => left.localeCompare(right))) {
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
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  busy: BusyState;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  return (
    <div className="project-git-stash-surface">
      {props.repositories.map((repository) => (
        <section key={repository.id}>
          <header>
            <span>
              <GitBranch aria-hidden="true" />
              <strong>{repository.name}</strong>
              <small>{repository.snapshot.branch}</small>
            </span>
            <Button
              variant="secondary"
              size="compact"
              disabled={props.busy !== null || repository.snapshot.clean}
              onClick={() => void props.onExecute(repository, { type: 'stash', includeUntracked: true, message: 'Zeus stash' }, props.zh ? '创建 Stash' : 'Create stash')}
            >
              {props.zh ? '暂存当前变更' : 'Stash current changes'}
            </Button>
          </header>
          {repository.snapshot.stashes.length === 0 ? <p>{props.zh ? '这个仓库没有 Stash。' : 'No stash in this repository.'}</p> : null}
          {repository.snapshot.stashes.map((stash) => (
            <article key={stash.ref}>
              <Archive aria-hidden="true" />
              <span>
                <strong>{displayStashSubject(stash.subject, props.zh)}</strong>
                <small>
                  {stash.ref} · {stash.author} · {formatRelativeTime(stash.authoredAt, props.zh)}
                </small>
              </span>
              <Button variant="secondary" size="compact" disabled={props.busy !== null} onClick={() => void props.onExecute(repository, { type: 'apply_stash', stashRef: stash.ref }, props.zh ? '应用 Stash' : 'Apply stash')}>
                {props.zh ? '应用' : 'Apply'}
              </Button>
              <Button variant="secondary" size="compact" disabled={props.busy !== null} onClick={() => void props.onExecute(repository, { type: 'apply_stash', stashRef: stash.ref, pop: true }, props.zh ? '弹出 Stash' : 'Pop stash')}>
                {props.zh ? '弹出' : 'Pop'}
              </Button>
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}

function ShelfSurface(props: { zh: boolean }) {
  return (
    <section className="project-git-empty-surface">
      <Archive aria-hidden="true" />
      <strong>{props.zh ? '还没有 Shelf 条目' : 'No Shelf entries yet'}</strong>
      <span>{props.zh ? 'Shelf 会保存 Zeus 创建的项目级补丁；真实条目创建后会按仓库显示。' : 'Shelf stores Zeus project patches and groups real entries by repository.'}</span>
    </section>
  );
}

function ConsoleSurface(props: { zh: boolean; operations: OperationRecord[] }) {
  return (
    <div className="project-git-console-surface">
      {props.operations.length === 0 ? (
        <section className="project-git-empty-surface">
          <ArrowsClockwise aria-hidden="true" />
          <strong>{props.zh ? '还没有 Git 操作记录' : 'No Git operations yet'}</strong>
          <span>{props.zh ? '这里只记录 Zeus 发起的受控 Git 动作，不提供命令输入。' : 'Only controlled Git actions started by Zeus appear here. There is no command input.'}</span>
        </section>
      ) : (
        props.operations.map((operation) => (
          <article key={operation.id} data-tone={operation.tone}>
            {operation.tone === 'success' ? <CheckCircle aria-hidden="true" /> : <WarningCircle aria-hidden="true" />}
            <span>
              <strong>{operation.label}</strong>
              <small>
                {operation.repositoryName} · {new Date(operation.startedAt).toLocaleTimeString()} · {operation.durationMs} ms
              </small>
              {operation.output ? <pre>{operation.output}</pre> : null}
            </span>
          </article>
        ))
      )}
    </div>
  );
}

function BranchContextMenu(props: {
  x: number;
  y: number;
  repository: ProjectGitRepositoryWorkbenchItem;
  branch: string;
  kind: BranchKind;
  zh: boolean;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onOpenDiff: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const current = props.repository.snapshot.branch;
  const currentLabel = props.repository.snapshot.detached
    ? props.zh
      ? `游离 · ${props.repository.snapshot.headTags[0] ?? props.repository.snapshot.headSha.slice(0, 8)}`
      : `Detached · ${props.repository.snapshot.headTags[0] ?? props.repository.snapshot.headSha.slice(0, 8)}`
    : current;
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!confirmDelete && !menuRef.current?.contains(event.target as Node)) props.onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [confirmDelete]);
  const run = (action: ProjectGitAction, label: string) => () => {
    props.onClose();
    void props.onExecute(props.repository, action, label);
  };
  const compare = (mode: 'current' | 'working-tree') => () => {
    props.onClose();
    props.onOpenDiff(props.repository, '', { comparisonRef: props.branch, comparisonMode: mode });
  };
  const remoteLeaf = props.kind === 'remote' ? props.branch.replace(/^[^/]+\//u, '') : props.branch;
  const checkoutAndRebase = async () => {
    const checkedOut =
      props.kind === 'remote'
        ? await props.onExecute(props.repository, { type: 'create_branch', branchName: remoteLeaf, baseRef: props.branch, trackRemote: true, smart: true }, props.zh ? '签出远程分支' : 'Checkout remote branch')
        : await props.onExecute(props.repository, { type: 'checkout', branchName: props.branch, smart: true }, props.zh ? '签出分支' : 'Checkout branch');
    if (checkedOut && !props.repository.snapshot.detached) await props.onExecute(props.repository, { type: 'rebase', branchName: current }, props.zh ? `将“${remoteLeaf}”变基到“${current}”` : `Rebase '${remoteLeaf}' onto '${current}'`);
  };
  if (confirmDelete) {
    return (
      <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
        <section className="project-git-branch-delete-dialog" role="alertdialog" aria-modal="true" aria-label={props.zh ? '删除分支' : 'Delete branch'}>
          <header>
            <strong>{props.zh ? `删除“${props.branch}”？` : `Delete '${props.branch}'?`}</strong>
            <small>{props.zh ? '仅删除本地分支；尚未合入的分支会由 Git 拒绝删除。' : 'Only the local branch is deleted. Git refuses unmerged branches.'}</small>
          </header>
          <footer>
            <Button variant="secondary" onClick={props.onClose}>
              {props.zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              busy={props.busy?.action === 'delete_branch'}
              disabled={props.busy !== null}
              onClick={() => {
                void props.onExecute(props.repository, { type: 'delete_branch', branchName: props.branch }, props.zh ? '删除分支' : 'Delete branch').then(props.onClose);
              }}
            >
              {props.zh ? '删除' : 'Delete'}
            </Button>
          </footer>
        </section>
      </ModalPortal>
    );
  }
  return (
    <div ref={menuRef} className="project-git-branch-context-menu" role="menu" style={{ left: Math.max(8, Math.min(props.x, window.innerWidth - 560)), top: Math.max(8, Math.min(props.y, window.innerHeight - 430)) }}>
      {props.branch !== current ? (
        <button
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={() => {
            props.onClose();
            void (props.kind === 'remote'
              ? props.onExecute(props.repository, { type: 'create_branch', branchName: remoteLeaf, baseRef: props.branch, trackRemote: true, smart: true }, props.zh ? '签出远程分支' : 'Checkout remote branch')
              : props.onExecute(props.repository, { type: 'checkout', branchName: props.branch, smart: true }, props.zh ? '签出分支' : 'Checkout branch'));
          }}
        >
          {props.zh ? '签出' : 'Checkout'}
        </button>
      ) : null}
      {props.kind === 'remote' && !props.repository.snapshot.detached ? (
        <button
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={run({ type: 'create_branch', branchName: remoteLeaf, baseRef: props.branch, trackRemote: true, smart: true }, props.zh ? '从远程分支新建本地分支' : 'Create local branch from remote')}
        >
          {props.zh ? `从“${props.branch}”新建分支…` : `New Branch from '${props.branch}'…`}
        </button>
      ) : null}
      {props.branch !== current && !props.repository.snapshot.detached ? (
        <button
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={() => {
            props.onClose();
            void checkoutAndRebase();
          }}
        >
          {props.zh ? `签出并变基到“${currentLabel}”` : `Checkout and Rebase onto '${currentLabel}'`}
        </button>
      ) : null}
      <hr />
      <button type="button" role="menuitem" onClick={compare('current')}>
        {props.zh ? `与“${currentLabel}”比较` : `Compare with '${currentLabel}'`}
      </button>
      <button type="button" role="menuitem" onClick={compare('working-tree')}>
        {props.zh ? '显示与工作区的差异' : 'Show Diff with Working Tree'}
      </button>
      {props.branch !== current && !props.repository.snapshot.detached ? (
        <>
          <hr />
          <button type="button" role="menuitem" disabled={props.busy !== null} onClick={run({ type: 'rebase', branchName: props.branch }, props.zh ? '变基当前分支' : 'Rebase current branch')}>
            {props.zh ? `将“${current}”变基到“${props.branch}”` : `Rebase '${current}' onto '${props.branch}'`}
          </button>
          <button type="button" role="menuitem" disabled={props.busy !== null} onClick={run({ type: 'merge', branchName: props.branch }, props.zh ? '合并分支' : 'Merge branch')}>
            {props.zh ? `将“${props.branch}”合入“${current}”` : `Merge '${props.branch}' into '${current}'`}
          </button>
        </>
      ) : null}
      {props.kind === 'remote' && !props.repository.snapshot.detached ? (
        <>
          <hr />
          <button type="button" role="menuitem" disabled={props.busy !== null} onClick={run({ type: 'pull', remote: props.branch.split('/')[0], targetBranch: remoteLeaf, strategy: 'rebase' }, props.zh ? '拉取并变基' : 'Pull with rebase')}>
            {props.zh ? `拉取到“${current}”（变基）` : `Pull into '${current}' Using Rebase`}
          </button>
          <button type="button" role="menuitem" disabled={props.busy !== null} onClick={run({ type: 'pull', remote: props.branch.split('/')[0], targetBranch: remoteLeaf, strategy: 'merge' }, props.zh ? '拉取并合并' : 'Pull with merge')}>
            {props.zh ? `拉取到“${current}”（合并）` : `Pull into '${current}' Using Merge`}
          </button>
        </>
      ) : null}
      {props.kind === 'local' && props.branch !== current ? (
        <>
          <hr />
          <button type="button" role="menuitem" disabled={props.busy !== null} onClick={() => setConfirmDelete(true)}>
            {props.zh ? '删除…' : 'Delete…'}
          </button>
        </>
      ) : null}
    </div>
  );
}

function OperationsMenu(props: { zh: boolean; onClose: () => void; onOpenCommit: () => void; onOpenPush: () => void; onOpenUpdate: () => void; onOpenNewBranch: () => void; onOpenRevision: () => void; onSelectTab: (tab: GitTab) => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) props.onClose();
    };
    document.addEventListener('pointerdown', close, true);
    return () => document.removeEventListener('pointerdown', close, true);
  }, []);
  const action = (callback: () => void) => () => {
    props.onClose();
    callback();
  };
  return (
    <div
      ref={menuRef}
      className="project-git-operations-menu"
      role="menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') props.onClose();
      }}
    >
      <button type="button" role="menuitem" onClick={action(props.onOpenCommit)}>
        {props.zh ? '提交…' : 'Commit…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenPush)}>
        {props.zh ? '推送…' : 'Push…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenUpdate)}>
        {props.zh ? '更新项目…' : 'Update Project…'}
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={action(props.onOpenNewBranch)}>
        {props.zh ? '新建分支…' : 'New Branch…'}
      </button>
      <button type="button" role="menuitem" onClick={action(props.onOpenRevision)}>
        {props.zh ? '签出标签或 Revision…' : 'Checkout Tag or Revision…'}
      </button>
      <hr />
      <button type="button" role="menuitem" onClick={action(() => props.onSelectTab('log'))}>
        {props.zh ? '显示 Git 日志' : 'Show Git Log'}
      </button>
      <button type="button" role="menuitem" onClick={action(() => props.onSelectTab('changes'))}>
        {props.zh ? '未提交的变更' : 'Uncommitted Changes'}
      </button>
      <button type="button" role="menuitem" onClick={action(() => props.onSelectTab('stash'))}>
        Stash
      </button>
    </div>
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
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
      <section className="project-git-commit-dialog" role="dialog" aria-modal="true" aria-label={props.zh ? '提交已暂存变更' : 'Commit staged changes'}>
        <header>
          <strong>{props.zh ? '提交已暂存变更' : 'Commit staged changes'}</strong>
          <small>{props.zh ? '多个仓库会分别创建提交，不伪装成一个跨仓提交。' : 'Each repository creates its own commit.'}</small>
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
              for (const repository of staged) await props.onExecute(repository, { type: 'commit', message }, props.zh ? '提交已暂存变更' : 'Commit staged changes');
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

function PushDialog(props: {
  open: boolean;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  busy: BusyState;
  results: Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>;
  onClose: () => void;
  onPush: (selections: Array<{ repositoryId: string; remote: string; targetBranch: string }>, forceWithLease: boolean, pushTags: boolean) => Promise<void>;
}) {
  const pushable = props.repositories.filter((repository) => !repository.snapshot.detached && repository.snapshot.outgoingCommits.length > 0 && repository.snapshot.remotes.length > 0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [targets, setTargets] = useState<Record<string, { remote: string; targetBranch: string }>>({});
  const [forceWithLease, setForceWithLease] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  useEffect(() => {
    if (!props.open) return;
    setSelectedIds(pushable.map((repository) => repository.id));
    setTargets(Object.fromEntries(props.repositories.map((repository) => [repository.id, { remote: repository.snapshot.remotes[0] ?? '', targetBranch: repository.snapshot.branch }])));
  }, [props.open, props.repositories.map((repository) => `${repository.id}:${repository.snapshot.headSha}`).join('|')]);
  if (!props.open) return null;
  const resultMode = props.results.length > 0;
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
      <section className="project-git-push-dialog" role="dialog" aria-modal="true" aria-label={resultMode ? (props.zh ? '推送结果' : 'Push results') : props.zh ? '推送提交' : 'Push commits'}>
        <header>
          <strong>{resultMode ? (props.zh ? '推送结果' : 'Push results') : props.zh ? '推送提交' : 'Push commits'}</strong>
          <small>
            {resultMode
              ? props.zh
                ? '结果按仓库保留，成功仓库不会回滚。'
                : 'Results stay per repository; successful pushes are not rolled back.'
              : props.zh
                ? `${pushable.length} 个仓库有待推送提交`
                : `${pushable.length} repositories have outgoing commits`}
          </small>
        </header>
        <main>
          {(resultMode ? props.repositories.filter((repository) => props.results.some((result) => result.repositoryId === repository.id)) : props.repositories).map((repository) => {
            const result = props.results.find((candidate) => candidate.repositoryId === repository.id);
            const target = targets[repository.id] ?? { remote: repository.snapshot.remotes[0] ?? '', targetBranch: repository.snapshot.branch };
            return (
              <section key={repository.id} className={result ? `is-${result.tone}` : ''}>
                {resultMode ? (
                  result?.tone === 'success' ? (
                    <CheckCircle aria-hidden="true" />
                  ) : (
                    <WarningCircle aria-hidden="true" />
                  )
                ) : (
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(repository.id)}
                    disabled={!pushable.includes(repository)}
                    onChange={(event) => setSelectedIds((current) => (event.currentTarget.checked ? [...current, repository.id] : current.filter((id) => id !== repository.id)))}
                  />
                )}
                <span>
                  <strong>{repository.name}</strong>
                  {resultMode ? (
                    <small>
                      {repository.snapshot.branch} → {target.remote}/{target.targetBranch}
                    </small>
                  ) : (
                    <span className="project-git-push-target">
                      <small>{repository.snapshot.branch} →</small>
                      <select
                        aria-label={props.zh ? `${repository.name} 远端` : `${repository.name} remote`}
                        value={target.remote}
                        onChange={(event) => setTargets((current) => ({ ...current, [repository.id]: { ...target, remote: event.currentTarget.value } }))}
                      >
                        {repository.snapshot.remotes.map((remote) => (
                          <option key={remote} value={remote}>
                            {remote}
                          </option>
                        ))}
                      </select>
                      <span>/</span>
                      <input
                        aria-label={props.zh ? `${repository.name} 目标分支` : `${repository.name} target branch`}
                        value={target.targetBranch}
                        onChange={(event) => setTargets((current) => ({ ...current, [repository.id]: { ...target, targetBranch: event.currentTarget.value } }))}
                      />
                    </span>
                  )}
                </span>
                <em>
                  {result?.message ??
                    (repository.snapshot.outgoingCommits.length > 0 ? (props.zh ? `${repository.snapshot.outgoingCommits.length} 个提交` : `${repository.snapshot.outgoingCommits.length} commits`) : props.zh ? '无需推送' : 'Up to date')}
                </em>
              </section>
            );
          })}
          {!resultMode ? (
            <div className="project-git-push-options">
              <label>
                <input type="checkbox" checked={pushTags} onChange={(event) => setPushTags(event.currentTarget.checked)} />
                {props.zh ? '推送可达标签' : 'Push reachable tags'}
              </label>
              <label>
                <input type="checkbox" checked={forceWithLease} onChange={(event) => setForceWithLease(event.currentTarget.checked)} />
                {props.zh ? '使用 --force-with-lease' : 'Use --force-with-lease'}
              </label>
            </div>
          ) : null}
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {resultMode ? (props.zh ? '关闭' : 'Close') : props.zh ? '取消' : 'Cancel'}
          </Button>
          {!resultMode ? (
            <Button
              variant="primary"
              busy={props.busy?.action === 'push'}
              disabled={selectedIds.length === 0 || selectedIds.some((id) => !targets[id]?.remote || !targets[id]?.targetBranch.trim()) || props.busy !== null}
              onClick={() =>
                void props.onPush(
                  selectedIds.map((repositoryId) => ({ repositoryId, ...targets[repositoryId]! })),
                  forceWithLease,
                  pushTags,
                )
              }
            >
              {props.zh ? '推送' : 'Push'}
            </Button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

function readRememberedTab(projectId: string): GitTab {
  const value = typeof window === 'undefined' ? null : window.localStorage.getItem(`zeus.project-git-tab-v2:${projectId}`);
  return value === 'changes' || value === 'shelf' || value === 'stash' || value === 'console' ? value : 'log';
}

function displayStashSubject(subject: string, zh: boolean): string {
  const cleaned = subject.replace(/^(?:On\s+[^:]+|WIP\s+on\s+[^:]+):\s*/iu, '').trim();
  return cleaned || (zh ? '未命名 Stash' : 'Untitled stash');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === 'string' && error.trim() ? error : 'Git operation failed.';
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
