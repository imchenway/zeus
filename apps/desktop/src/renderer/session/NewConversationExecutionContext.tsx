import { branchSwitchRepositories, executeRepositoryBatch, repositoryLocalBranches } from '../git/repositoryBranchGroups.js';
import type { ProjectGitBranchRepository, ProjectGitBranchSelection, ProjectGitBranchSnapshot } from '@zeus/git-core';
import { temporaryWorkspaceId, type ConversationWorktreeBranchOptions, type ConversationWorktreeOptions } from '@zeus/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CachedQuery } from '../cachedQuery.js';
import { projectGitQueryEntries, type ProjectGitQueryClient } from '../git/projectGitWorkbenchState.js';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { BranchSwitcher, currentRepositoryRefLabel } from '../git/GitRepositoryControls.js';
import { Button } from '../ui/Button.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Form } from '../ui/Form.js';

export interface NewConversationExecutionContextProps {
  language: SessionUiLanguage;
  projectId: string;
  projects: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  workspaceMode: 'direct' | 'worktree';
  /** 首发时同时创建关联任务，按项目恢复最近选择。 */
  createTask: boolean;
  /** 开关更新项目偏好，发送前不创建任务。 */
  onCreateTaskChange: (enabled: boolean) => void;
  /** 新工作树分支必须使用的当前全局前缀。 */
  taskBranchPrefix: string;
  worktree?: ConversationWorktreeOptions;
  onWorktreeChange: (options: ConversationWorktreeOptions) => void;
  onWorkspaceModeChange: (mode: 'direct' | 'worktree') => void;
  disabled?: boolean;
  onSelectProject?: (projectId: string) => void | Promise<void>;
  /** 按客户端及项目复用分支快照。 */
  projectGitClient?: ProjectGitQueryClient;
  onExecuteProjectGit?: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  onBusyChange?: (busy: boolean) => void;
}

/** 新会话的项目、工作位置和分支配置；发送前只执行明确的 Git 动作。 */
export function NewConversationExecutionContext(props: NewConversationExecutionContextProps) {
  const zh = props.language === 'zh-CN';
  const loadVersionRef = useRef(0);
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const branchBusyRef = useRef(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState('');
  /** 用户发起 Git 操作时的错误独立于后台读取状态。 */
  const [actionError, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);

  const temporary = props.projectId === temporaryWorkspaceId;
  /** 工作树模式编辑来源，直接模式显示并切换实际 HEAD。 */
  const sourceMode = props.workspaceMode === 'worktree';
  /** 当前分支供默认来源使用，候选引用只供展开后的菜单使用。 */
  const gitQueries = useMemo(() => (!temporary && props.projectGitClient ? projectGitQueryEntries(props.projectGitClient, props.projectId) : null), [temporary, props.projectGitClient, props.projectId]);
  const heads = useBranchQuery(gitQueries?.heads ?? null);
  const references = useBranchQuery(gitQueries?.references ?? null);
  /** 缓存可以先显示，草稿默认值只用本次打开后确认的 HEAD。 */
  const [confirmedHeads, setConfirmedHeads] = useState<CachedQuery<ProjectGitBranchSelection> | null>(null);
  /** 确认范围随项目查询实例变化，防止旧项目的回执启用发送。 */
  const headsReady = confirmedHeads !== null && confirmedHeads === gitQueries?.heads;
  /** 复用已经读取的项目快照，首读只发 HEAD 查询。 */
  const branchSnapshot = heads?.value ?? gitQueries?.workbench.getSnapshot().value ?? null;
  /** 展开时重新扫描磁盘，旧快照在这次读取成功前不能成为可选项。 */
  const branchList = references?.value?.projectId === props.projectId && !references.refreshing && references.error === null ? references.value : null;
  const readError = temporary ? null : gitQueries?.heads ? (!branchSnapshot || (props.workspaceMode === 'worktree' && !headsReady) ? heads?.error : null) : zh ? '当前无法读取项目分支。' : 'Project branches are unavailable.';
  const loadState = temporary || branchSnapshot ? 'ready' : readError ? 'error' : 'loading';
  const error = actionError ?? readError;
  const selectedProject = props.projects.find((project) => project.id === props.projectId) ?? null;
  // 只消费当前项目的快照，切换项目的一帧内也不能沿用旧来源。
  const repositories = useMemo(() => (branchSnapshot?.projectId === props.projectId ? branchSnapshot.repositories : []), [branchSnapshot, props.projectId]);
  /** 明确选中的仓库身份不随批量切换后的分组变化而扩大或缩小。空数组表示全部仓库。 */
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  /** 仓库被移除时，编辑范围回到仍可用的仓库列表。 */
  const scopedRepositories = useMemo(() => {
    const matching = repositories.filter((repository) => scopeIds.includes(repository.id));
    return matching.length ? matching : repositories;
  }, [repositories, scopeIds]);
  /** 范围选择和刷新提示共用同一组仓库。 */
  const scopeIsAll = scopedRepositories.length === repositories.length;
  /** 只用第一仓读取共同字段，不把它作为批量操作的唯一目标。 */
  const selectedRepository = scopedRepositories[0] ?? null;
  /** 非根仓即使只有一个成员，也需要保留项目容器目录。 */
  const projectWorktree = repositories.length > 1 || Boolean(repositories[0] && !['', '.'].includes(repositories[0].relativePath));
  /** 单仓范围由分支菜单中的仓库行选择，空身份集合表示全部仓库。 */
  const scopeLabel = scopeIsAll && repositories.length > 1 ? (zh ? '全部仓库' : 'All repositories') : (selectedRepository?.name ?? '');
  /** 单仓与多仓草稿共用同一来源查询。 */
  function selectionForRepository(repository: ProjectGitBranchRepository): ConversationWorktreeBranchOptions | undefined {
    return props.worktree && 'repositories' in props.worktree ? props.worktree.repositories.find((entry) => entry.repositoryId === repository.id) : projectWorktree ? undefined : props.worktree;
  }
  /** 工作树设置可按当前范围批量修改，其他仓库保持各自配置。 */
  const selections = scopedRepositories.map(selectionForRepository);
  /** 首个配置只用于比较，不代表混合范围具有统一来源。 */
  const selection = selections[0];
  /** 输入空值表示来源仓库使用不同的新分支名，编辑后统一为输入值。 */
  const commonBranchName = selection && selections.every((entry) => entry?.branchName === selection.branchName) ? selection.branchName : '';
  /** 收起时总结所有工作树来源，逐仓浏览不会改变会话使用的仓库。 */
  const sources = sourceMode ? repositories.map((repository) => selectionForRepository(repository) ?? (!repository.snapshot.detached ? { sourceKind: 'local' as const, sourceRef: repository.snapshot.branch } : undefined)) : [];
  /** 同名来源合并显示，分支顺序沿用项目仓库顺序。 */
  const resolvedRefs = sourceMode ? sources.map((source) => source?.sourceRef ?? '') : scopedRepositories.map((repository) => currentRepositoryRefLabel(repository, zh));
  const branchRefs = resolvedRefs.every(Boolean) ? [...new Set(resolvedRefs)] : [];
  /** 只有引用名称和类型都一致时，入口才显示统一的类型标签。 */
  const uniformSourceKind = sources.every((source) => source?.sourceKind === sources[0]?.sourceKind) ? sources[0]?.sourceKind : undefined;
  const currentBranchKind = scopedRepositories.every((repository) => !repository.snapshot.detached) ? 'local' : undefined;
  const triggerKind = branchRefs.length === 1 ? (sourceMode ? uniformSourceKind : currentBranchKind) : undefined;
  /** 来源标题与完整引用用于收起按钮的可访问名称和提示。 */
  const sourceLabel = zh ? '来源分支' : branchRefs.length > 1 ? 'Source branches' : 'Source branch';
  const branchLabel = branchRefs.length
    ? `${sourceMode ? `${sourceLabel}${zh ? '：' : ': '}` : ''}${branchRefs.join(' · ')}`
    : sourceMode && repositories.length
      ? zh
        ? '选择来源分支'
        : 'Choose source branch'
      : loadState === 'loading'
        ? zh
          ? '正在读取'
          : 'Loading'
        : zh
          ? '非 Git 目录'
          : 'Not a Git repository';
  /** 刷新只抓取当前范围内配置了远程的仓库。 */
  const refreshLabel = zh ? `刷新远程分支 · ${scopeLabel}` : `Refresh remote branches · ${scopeLabel}`;
  /** 游离 HEAD 仓库仍能打开来源菜单，等候选可用后再确定源。 */
  const worktreeAvailable = repositories.length > 0 && repositories.every(({ snapshot }) => snapshot.localBranches === undefined || defaultWorktreeSource(snapshot) !== undefined);
  const sourceAvailable = scopedRepositories.every((repository, index) => {
    /** 已保存的各仓来源分别核对，混合来源本身不属于错误。 */
    const selected = selections[index];
    return selected && isSourceAvailable(repository.snapshot, selected);
  });
  /** 前缀已由设置边界规范化，这里只负责即时启用状态。 */
  const branchNamespace = `${props.taskBranchPrefix}/`;
  const validWorktree =
    headsReady &&
    worktreeAvailable &&
    (!props.worktree || !('repositories' in props.worktree) || props.worktree.repositories.length === repositories.length) &&
    repositories.every((repository) => {
      /** 发送前检查全部成员，不能只检查当前展开的仓库。 */
      const options = selectionForRepository(repository);
      return Boolean(options && (props.createTask || (options.branchName.trim().startsWith(branchNamespace) && options.branchName.trim().length > branchNamespace.length)) && isSourceAvailable(repository.snapshot, options));
    });
  const projectOptions = useMemo(
    () => [
      { value: temporaryWorkspaceId, label: zh ? '临时会话 · 默认目录' : 'Temporary conversation · Default folder', group: zh ? '无项目' : 'Without a project', searchText: '临时 默认 temporary default' },
      ...props.projects
        .filter((project) => project.id !== temporaryWorkspaceId)
        .map((project) => ({
          value: project.id,
          label: `${project.name} · ${project.localPath}`,
          group: zh ? '项目' : 'Projects',
          searchText: `${project.name} ${project.localPath}`,
        })),
    ],
    [props.projects, zh],
  );

  useEffect(() => {
    /** 项目切换后，迟到读取只更新其原项目缓存。 */
    const version = ++loadVersionRef.current;
    setScopeIds([]);
    setError(null);
    setRefreshing(false);
    branchBusyRef.current = false;
    setBranchBusy(false);
    setCreateBranchOpen(false);
    setCreateBranchName('');
    setConfirmedHeads(null);
    const query = gitQueries?.heads;
    if (query) {
      void query
        .load(true)
        .then(() => {
          if (version === loadVersionRef.current) setConfirmedHeads(query);
        })
        .catch(() => undefined);
    }
    return () => {
      loadVersionRef.current += 1;
    };
  }, [gitQueries, props.projectId]);

  useLayoutEffect(() => {
    if (temporary || props.workspaceMode !== 'worktree' || !worktreeAvailable || !headsReady) return;
    /** 同一轮默认命名用于全部独立仓库；用户可以逐仓修改。 */
    const branchName = `${props.taskBranchPrefix}/conversation-${crypto.randomUUID().slice(0, 8)}`;
    if (!projectWorktree && !(props.worktree && 'repositories' in props.worktree)) {
      if (!props.worktree) {
        const source = defaultWorktreeSource(repositories[0]!.snapshot);
        if (source) props.onWorktreeChange({ sourceKind: source.kind, sourceRef: source.ref, branchName });
      }
      return;
    }
    /** 仓库登记变化时保留仍在项目中的选择，为新增仓库填入当前分支。 */
    const previous = props.worktree && 'repositories' in props.worktree ? props.worktree.repositories : [];
    if (previous.length === repositories.length && repositories.every((repository) => previous.some((entry) => entry.repositoryId === repository.id))) return;
    const defaults = repositories.flatMap((repository) => {
      const saved = previous.find((entry) => entry.repositoryId === repository.id);
      if (saved) return [saved];
      const source = defaultWorktreeSource(repository.snapshot);
      return source ? [{ repositoryId: repository.id, sourceKind: source.kind, sourceRef: source.ref, branchName }] : [];
    });
    if (defaults.length === repositories.length) props.onWorktreeChange({ repositories: defaults });
  }, [temporary, props.workspaceMode, props.worktree, props.onWorktreeChange, props.taskBranchPrefix, worktreeAvailable, projectWorktree, repositories, headsReady]);

  /** 批量修改只覆盖用户编辑的字段，其余来源和分支名各自保留。 */
  function updateSelection(value: Partial<ConversationWorktreeBranchOptions>, targets = scopedRepositories): boolean {
    if (!props.worktree || !targets.length || targets.some((repository) => !selectionForRepository(repository))) return false;
    if ('repositories' in props.worktree) {
      props.onWorktreeChange({ repositories: props.worktree.repositories.map((entry) => (targets.some((repository) => repository.id === entry.repositoryId) ? { ...entry, ...value } : entry)) });
    } else props.onWorktreeChange({ ...props.worktree, ...value });
    return true;
  }

  useLayoutEffect(() => {
    props.onBusyChange?.(branchBusy || projectBusy || refreshing || (!temporary && props.workspaceMode === 'worktree' && !validWorktree));
    return () => props.onBusyChange?.(false);
  }, [branchBusy, projectBusy, refreshing, temporary, props.workspaceMode, validWorktree, props.onBusyChange]);

  /** 关闭新建分支窗口后恢复共享分支入口的焦点。 */
  function closeCreateBranchDialog(): void {
    setCreateBranchOpen(false);
    setCreateBranchName('');
    window.requestAnimationFrame(() => branchTriggerRef.current?.focus());
  }

  /** 展开菜单后读取候选引用，并同步这次读取的仓库和 HEAD。 */
  async function readBranchList(): Promise<void> {
    if (!gitQueries?.references) return;
    const { heads, references: query } = gitQueries;
    /** 补读成功也可恢复首次 HEAD 读取失败后的默认选择。 */
    const version = loadVersionRef.current;
    const result = await query.load(true);
    const resolved = query.getSnapshot();
    if (resolved.value === result && result.projectId === props.projectId && resolved.updatedAt >= (heads?.getSnapshot().updatedAt ?? 0)) {
      heads?.set(result);
      if (version === loadVersionRef.current) {
        setConfirmedHeads(heads);
        setScopeIds((ids) => ids.filter((id) => result.repositories.some((repository) => repository.id === id)));
      }
    }
  }

  /** 复用 Git 页的顺序批处理，并立即发布每个仓库返回的真实快照。 */
  async function executeBranchAction(action: ProjectGitAction, repositoriesToUpdate: ProjectGitBranchRepository[] = scopedRepositories): Promise<boolean> {
    if (!repositoriesToUpdate.length || !props.onExecuteProjectGit || branchBusyRef.current || refreshing || projectBusy || props.disabled) return false;
    /** 操作开始时固定项目和仓库范围。 */
    const version = loadVersionRef.current;
    /** 签出和新建分支只操作独立范围，避免再次把子模块切到同名旧分支。 */
    const switchTargets = action.type === 'checkout' || action.type === 'create_branch' ? branchSwitchRepositories(repositoriesToUpdate) : repositoriesToUpdate;
    /** 重签当前分支也同步子模块；新建已存在的当前分支和无 remote 的 fetch 保持跳过。 */
    const targets = switchTargets.filter((repository) =>
      action.type === 'create_branch' ? repository.snapshot.detached || repository.snapshot.branch !== action.branchName : action.type !== 'fetch' || Boolean(repository.snapshot.remotes?.length),
    );
    branchBusyRef.current = true;
    setBranchBusy(true);
    setRefreshing(action.type === 'fetch');
    setError(null);
    /** 每次失败保留真实原因，批处理只补充受影响的仓库范围。 */
    let failure: unknown;
    try {
      /** 结果区分已经成功、停止位置和尚未执行的仓库。 */
      const result = await executeRepositoryBatch(targets, async (repository) => {
        if (version !== loadVersionRef.current) return null;
        try {
          /** 新建分支从各仓库自己的当前分支开始，不能挪用第一仓的来源。 */
          const input = action.type === 'create_branch' ? { ...action, baseRef: repository.snapshot.detached ? undefined : repository.snapshot.branch } : action;
          /** 操作完成后直接采用服务端返回的仓库状态。 */
          const response = await props.onExecuteProjectGit!(props.projectId, repository.id, input);
          const updated = replaceRepositorySnapshot(gitQueries?.workbench.getSnapshot().value ?? null, repository.id, response);
          if (updated) gitQueries?.workbench.set(updated);
          /** 引用动作使用服务端回执覆盖该仓，取消旧查询的回写资格。 */
          const previousList = gitQueries?.references?.getSnapshot().value;
          if (previousList) {
            const next = { ...previousList, repositories: previousList.repositories.map((item) => (item.id === repository.id ? { ...item, snapshot: response.snapshot } : item)) };
            gitQueries?.references?.set(next);
            gitQueries?.heads?.set(next);
          }
          /** 父仓库签出会更新子模块，一起重读相关仓库的分支和提交。 */
          if ((action.type === 'checkout' || action.type === 'create_branch') && repository.snapshot.submodules?.some((module) => module.initialized)) {
            gitQueries?.workbench.invalidate();
            await readBranchList();
          }
          if (version !== loadVersionRef.current) return null;
          return 'completed';
        } catch (reason) {
          failure = reason;
          return null;
        }
      });
      /** 抓取只返回被操作仓库的快照，列表仍须重新核对是否有仓库移除。 */
      if (action.type === 'fetch' && version === loadVersionRef.current) await readBranchList().catch(() => undefined);
      if (version !== loadVersionRef.current) return false;
      if (result.stopped) {
        /** 已成功切换不回滚，剩余仓库保留原分支；失败结果不能显示为全部成功。 */
        const detail = formatVisibleApplicationError(failure, zh ? 'zh-CN' : 'en');
        setError(
          zh
            ? `${result.stopped.name}：${detail} 已完成 ${result.completed.length}/${targets.length} 个仓库，未执行 ${result.remaining.length} 个。`
            : `${result.stopped.name}: ${detail} Completed ${result.completed.length}/${targets.length} repositories; ${result.remaining.length} not attempted.`,
        );
        return false;
      }
      return true;
    } finally {
      if (version === loadVersionRef.current) {
        branchBusyRef.current = false;
        setBranchBusy(false);
        setRefreshing(false);
      }
    }
  }

  return (
    <>
      {error ? (
        <p className="session-new-conversation-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      <div className="session-new-conversation-context" aria-label={zh ? '新对话的工作位置' : 'Work location for the new conversation'}>
        <span className="session-new-conversation-context-control">
          <ZeusSelect
            ariaLabel={zh ? `工作目录：${selectedProject?.name ?? '不可用'}` : `Project: ${selectedProject?.name ?? 'Unavailable'}`}
            className="session-new-conversation-context-select"
            emptyLabel={zh ? '没有匹配的项目' : 'No matching projects'}
            onChange={async (projectId) => {
              if (projectId === props.projectId || !props.onSelectProject || projectBusy) return;
              setProjectBusy(true);
              try {
                await props.onSelectProject(projectId);
              } catch (reason) {
                setError(reason);
              } finally {
                setProjectBusy(false);
              }
            }}
            options={projectOptions}
            popoverMinWidth={320}
            searchable
            searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
            size="compact"
            triggerIcon={<Folder />}
            triggerLabel={temporary ? (zh ? '临时会话 · 默认目录' : 'Temporary · Default folder') : (selectedProject?.name ?? (zh ? '项目不可用' : 'Project unavailable'))}
            value={props.projectId}
            disabled={props.disabled || refreshing || branchBusy || projectBusy || props.projects.length === 0 || !props.onSelectProject}
          />
        </span>
        {!temporary ? (
          <span className="session-new-conversation-context-control">
            <ZeusSelect
              ariaLabel={zh ? '工作位置' : 'Work location'}
              className="session-new-conversation-context-select"
              value={props.workspaceMode}
              onChange={(value) => props.onWorkspaceModeChange(value === 'worktree' ? 'worktree' : 'direct')}
              options={[
                { value: 'direct', label: zh ? '项目目录' : 'Project folder' },
                { value: 'worktree', label: zh ? '新建工作树' : 'New worktree', disabled: !worktreeAvailable },
              ]}
              triggerIcon={props.workspaceMode === 'worktree' ? <GitBranch /> : <Folder />}
              triggerLabel={props.workspaceMode === 'worktree' ? (zh ? '新建工作树' : 'New worktree') : zh ? '项目目录' : 'Project folder'}
              size="compact"
              popoverMinWidth={220}
              disabled={props.disabled || refreshing || branchBusy || projectBusy}
            />
          </span>
        ) : null}
        {temporary ? (
          <span className="session-new-conversation-context-note" data-icon-tooltip={selectedProject?.localPath}>
            {zh ? '文件保存在默认目录' : 'Files saved in the default folder'}
          </span>
        ) : (
          <span className="session-new-conversation-context-control session-new-conversation-context-branch">
            <BranchSwitcher
              key={`${props.projectId}:${props.workspaceMode}`}
              cascadeRepositories={!sourceMode}
              zh={zh}
              repositories={branchList?.repositories ?? []}
              selectedRepository={sourceMode && scopeIsAll && repositories.length > 1 ? null : (branchList?.repositories.find((repository) => repository.id === selectedRepository?.id) ?? null)}
              triggerRef={branchTriggerRef}
              triggerLabel={branchLabel}
              triggerRefs={branchRefs.length > 1 ? branchRefs : undefined}
              triggerPrefix={sourceMode ? sourceLabel : undefined}
              triggerKind={triggerKind}
              disabled={props.disabled || projectBusy || loadState === 'loading' || !gitQueries?.references || (!sourceMode && !props.onExecuteProjectGit)}
              onOpen={() => void readBranchList().catch(() => undefined)}
              menuStatus={
                branchList ? undefined : references?.error ? (
                  <div className="session-new-branch-menu-status">
                    <span role="alert">
                      <VisibleApplicationError error={references.error} language={zh ? 'zh-CN' : 'en'} />
                    </span>
                    <Button variant="secondary" size="compact" onClick={() => readBranchList().catch(() => undefined)}>
                      {zh ? '重试' : 'Retry'}
                    </Button>
                  </div>
                ) : (
                  <div className="session-new-branch-menu-status" role="status">
                    <CircleNotch aria-hidden="true" className="project-git-spinner" />
                    {zh ? '正在读取分支…' : 'Loading branches…'}
                  </div>
                )
              }
              searchAction={
                sourceMode ? (
                  <Button
                    unstyled
                    type="button"
                    className="session-new-branch-refresh"
                    aria-label={refreshLabel}
                    data-icon-tooltip={refreshLabel}
                    data-busy-behavior="background"
                    busy={refreshing}
                    aria-disabled={refreshing || undefined}
                    disabled={props.disabled || projectBusy || (branchBusy && !refreshing) || (!branchList && !refreshing) || !scopedRepositories.some((repository) => repository.snapshot.remotes?.length) || !props.onExecuteProjectGit}
                    onClick={() => {
                      if (!refreshing) void executeBranchAction({ type: 'fetch' });
                    }}
                  >
                    {refreshing ? <CircleNotch aria-hidden="true" className="project-git-spinner" /> : <ArrowsClockwise aria-hidden="true" />}
                  </Button>
                ) : undefined
              }
              busy={branchBusy ? { repositoryId: selectedRepository?.id ?? '', action: refreshing ? 'fetch' : 'checkout' } : null}
              onSelectRepository={(repositoryId) => setScopeIds([repositoryId])}
              onSelectAllRepositories={sourceMode ? () => setScopeIds([]) : undefined}
              referenceSelection={{
                mode: sourceMode ? 'source' : 'checkout',
                selectedSource: selectionForRepository,
                onSelect: async (targets, ref, kind) => {
                  if (props.disabled || projectBusy || branchBusyRef.current) return false;
                  if (sourceMode && !updateSelection({ sourceKind: kind, sourceRef: ref }, targets)) return false;
                  setScopeIds(targets.length === repositories.length ? [] : targets.map((repository) => repository.id));
                  return sourceMode ? true : executeBranchAction({ type: 'checkout', branchName: ref }, targets);
                },
              }}
              onOpenNewBranch={
                props.workspaceMode === 'direct'
                  ? (_baseRef, repositoryId) => {
                      setScopeIds(repositoryId ? [repositoryId] : []);
                      setCreateBranchOpen(true);
                    }
                  : undefined
              }
              footer={
                sourceMode && ((!props.createTask && selectedRepository) || (selection && !sourceAvailable)) ? (
                  <span className="session-new-worktree-fields">
                    {!props.createTask ? (
                      <>
                        <label>
                          <span>
                            {zh ? '工作树分支名' : 'Worktree branch name'} · {scopeLabel}
                          </span>
                          <input
                            aria-label={zh ? '工作树分支名' : 'Worktree branch name'}
                            value={commonBranchName}
                            placeholder={selection && !commonBranchName ? (zh ? '多个分支名' : 'Multiple branch names') : `${props.taskBranchPrefix}/conversation-example`}
                            spellCheck={false}
                            disabled={props.disabled || projectBusy || branchBusy || !selection}
                            onChange={(event) => {
                              if (selection) updateSelection({ branchName: event.currentTarget.value });
                            }}
                          />
                        </label>
                        <small>
                          {scopedRepositories.some((repository, index) => !repository.snapshot.headSha && selections[index]?.sourceKind === 'local' && selections[index]?.sourceRef === repository.snapshot.branch)
                            ? zh
                              ? `空仓库会把当前项目文件带入工作树；分支名须以 ${branchNamespace} 开头。`
                              : `The current project files will seed this empty repository worktree. The new name must start with ${branchNamespace}.`
                            : zh
                              ? `从所选分支创建，分支名须以 ${branchNamespace} 开头。`
                              : `Create from the selected branch. The new name must start with ${branchNamespace}.`}
                        </small>
                      </>
                    ) : null}
                    {selection && !sourceAvailable && loadState === 'ready' ? <span role="alert">{zh ? '来源分支已不可用，请重新选择。' : 'The source branch is no longer available. Choose another branch.'}</span> : null}
                  </span>
                ) : undefined
              }
            />
          </span>
        )}
        <label className="session-new-conversation-create-task">
          <span>{zh ? '自动创建任务' : 'Automatically create task'}</span>
          <span className="settings-switch-state">
            <input
              className="native-switch-input"
              type="checkbox"
              role="switch"
              aria-label={zh ? '自动创建任务' : 'Automatically create task'}
              checked={props.createTask}
              onChange={(event) => {
                // 自动命名仍保留完整来源草稿；关闭开关后可以继续编辑原分支名。
                if (event.currentTarget.checked && props.worktree) {
                  /** 草稿空名称不阻断任务自动命名，最终名称由服务端按真实任务生成。 */
                  const branchName = `${props.taskBranchPrefix}/conversation-${crypto.randomUUID().slice(0, 8)}`;
                  props.onWorktreeChange(
                    'repositories' in props.worktree
                      ? { repositories: props.worktree.repositories.map((entry) => ({ ...entry, branchName: entry.branchName.trim() || branchName })) }
                      : { ...props.worktree, branchName: props.worktree.branchName.trim() || branchName },
                  );
                }
                return props.onCreateTaskChange(event.currentTarget.checked);
              }}
              disabled={props.disabled}
            />
            <span className="native-switch-track" aria-hidden="true" />
          </span>
        </label>
      </div>

      <MotionPresence>
        {createBranchOpen && selectedRepository ? (
          <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" dismissDisabled={branchBusy} onDismiss={closeCreateBranchDialog} role="dialog" aria-label={zh ? '新建分支' : 'New branch'}>
            <Form
              className="project-git-reference-dialog zeus-solid-form-surface"
              onSubmit={(event) => {
                event.preventDefault();
                const branchName = createBranchName.trim();
                if (!branchName) return;
                return executeBranchAction({ type: 'create_branch', branchName, baseRef: selectedRepository.snapshot.detached ? undefined : selectedRepository.snapshot.branch }).then((created) => {
                  if (created) closeCreateBranchDialog();
                });
              }}
              data-modal-surface="dialog"
            >
              <header>
                <strong>{zh ? '新建并检出分支' : 'Create and Checkout Branch'}</strong>
                <small>
                  {scopedRepositories.length > 1
                    ? zh
                      ? `${scopeLabel} · 各仓当前分支`
                      : `${scopeLabel} · Current branch in each repository`
                    : zh
                      ? `起点：${selectedRepository.snapshot.branch}`
                      : `Starting point: ${selectedRepository.snapshot.branch}`}
                </small>
              </header>
              <main>
                <label>
                  <span>{zh ? '分支名称' : 'Branch name'}</span>
                  <input autoFocus value={createBranchName} disabled={branchBusy} placeholder="feature/example" onChange={(event) => setCreateBranchName(event.currentTarget.value)} />
                </label>
              </main>
              <footer>
                <Button variant="secondary" onClick={closeCreateBranchDialog} disabled={branchBusy}>
                  {zh ? '取消' : 'Cancel'}
                </Button>
                <Button type="submit" variant="primary" busy={branchBusy} disabled={!createBranchName.trim()}>
                  {zh ? '创建并检出' : 'Create and Checkout'}
                </Button>
              </footer>
            </Form>
          </ModalPortal>
        ) : null}
      </MotionPresence>
    </>
  );
}

/** 已打开的工作台也使用同一次 Git 动作的结果。 */
function replaceRepositorySnapshot(current: ProjectGitWorkbenchSnapshot | null, repositoryId: string, response: ProjectGitActionResponse): ProjectGitWorkbenchSnapshot | null {
  if (!current) return current;
  return {
    ...current,
    refreshedAt: new Date().toISOString(),
    repositories: current.repositories.map((repository) => (repository.id === repositoryId ? { ...repository, snapshot: response.snapshot } : repository)),
  };
}

/** 优先使用当前本地分支；游离 HEAD 沿用列表中的首个有效来源。 */
function defaultWorktreeSource(snapshot: ProjectGitBranchSnapshot) {
  const local = snapshot.detached ? snapshot.localBranches?.[0] : snapshot.branch;
  if (local) return { ref: local, kind: 'local' as const };
  const remote = snapshot.remoteBranches?.find((ref) => ref.includes('/') && !ref.endsWith('/HEAD'));
  return remote ? { ref: remote, kind: 'remote' as const } : undefined;
}

/** 清单未打开时保留已有选择，创建工作树时由服务端再核对引用。 */
function isSourceAvailable(snapshot: ProjectGitBranchSnapshot, source: ConversationWorktreeBranchOptions): boolean {
  if (snapshot.localBranches === undefined) return true;
  return source.sourceKind === 'local'
    ? repositoryLocalBranches({ snapshot }).includes(source.sourceRef)
    : Boolean(snapshot.remoteBranches?.includes(source.sourceRef) && source.sourceRef.includes('/') && !source.sourceRef.endsWith('/HEAD'));
}

/** 临时会话没有仓库，普通项目从共享缓存订阅已读取的数据。 */
function useBranchQuery(query: CachedQuery<ProjectGitBranchSelection> | null) {
  const subscribe = useCallback((listener: () => void) => query?.subscribe(listener) ?? (() => undefined), [query]);
  const getSnapshot = useCallback(() => query?.getSnapshot() ?? null, [query]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
