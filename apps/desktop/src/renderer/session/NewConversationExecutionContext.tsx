import { executeRepositoryBatch, groupRepositoriesByBranch, intersectRepositoryValues, repositoryLocalBranches } from '../git/repositoryBranchGroups.js';
import { temporaryWorkspaceId, type ConversationWorktreeBranchOptions, type ConversationWorktreeOptions } from '@zeus/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { formatVisibleApplicationError, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { Button } from '../ui/Button.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { ModalPortal } from '../ui/ModalPortal.js';

const createBranchActionValue = '__zeus create branch__';

export interface NewConversationExecutionContextProps {
  language: SessionUiLanguage;
  projectId: string;
  projects: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  workspaceMode: 'direct' | 'worktree';
  /** 首发时同时创建关联任务，默认关闭。 */
  createTask: boolean;
  /** 开关只修改草稿，发送前不创建任务。 */
  onCreateTaskChange: (enabled: boolean) => void;
  /** 新工作树分支必须使用的当前全局前缀。 */
  taskBranchPrefix: string;
  worktree?: ConversationWorktreeOptions;
  onWorktreeChange: (options: ConversationWorktreeOptions) => void;
  onWorkspaceModeChange: (mode: 'direct' | 'worktree') => void;
  disabled?: boolean;
  onSelectProject?: (projectId: string) => void | Promise<void>;
  onLoadProjectGit?: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  onExecuteProjectGit?: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  onBusyChange?: (busy: boolean) => void;
}

export function NewConversationExecutionContext(props: NewConversationExecutionContextProps) {
  const zh = props.language === 'zh-CN';
  const loadVersionRef = useRef(0);
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const branchBusyRef = useRef(false);
  const [branchBusy, setBranchBusy] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState('');
  const [workbench, setWorkbench] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);

  const temporary = props.projectId === temporaryWorkspaceId;
  const selectedProject = props.projects.find((project) => project.id === props.projectId) ?? null;
  // 只消费当前项目的快照，切换项目的一帧内也不能沿用旧来源。
  const repositories = useMemo(() => (workbench?.projectId === props.projectId ? workbench.repositories : []), [workbench, props.projectId]);
  /** 明确选中的仓库身份不随批量切换后的分组变化而扩大或缩小。空数组表示全部仓库。 */
  const [scopeIds, setScopeIds] = useState<string[]>([]);
  /** 选择范围限定为当前项目仍存在的仓库。 */
  const scopedRepositories = useMemo(() => (scopeIds.length ? repositories.filter((repository) => scopeIds.includes(repository.id)) : repositories), [repositories, scopeIds]);
  /** 只用第一仓读取共同字段，不把它作为批量操作的唯一目标。 */
  const selectedRepository = scopedRepositories[0] ?? null;
  /** 非根仓即使只有一个成员，也需要保留项目容器目录。 */
  const projectWorktree = repositories.length > 1 || Boolean(repositories[0] && !['', '.'].includes(repositories[0].relativePath));
  /** 共享代码交付的同名分组，游离 HEAD 不参与分支分组。 */
  const scopeChoices = useMemo(() => {
    /** 同名分组只包含真实分支，避免把游离提交误称为共同分支。 */
    const groups = groupRepositoriesByBranch(
      repositories.filter((repository) => !repository.snapshot.detached && repository.snapshot.branch),
      (repository) => repository.snapshot.branch,
    );
    /** 操作范围沿用统一选择器，不增加第二套勾选或弹层。 */
    const choices = [
      { value: 'all', label: zh ? `全部仓库（${repositories.length}）` : `All repositories (${repositories.length})`, description: '', group: '', ids: [] as string[] },
      ...groups
        .filter((group) => group.repositories.length > 1)
        .map((group) => ({
          value: JSON.stringify(group.repositories.map((repository) => repository.id)),
          label: `${group.branchName} · ${group.repositories.length}`,
          description: group.repositories.map((repository) => (repository.relativePath === '.' ? repository.name : repository.relativePath)).join('、'),
          group: zh ? '同名分支' : 'Same branch',
          ids: group.repositories.map((repository) => repository.id),
        })),
      ...repositories.map((repository) => ({
        value: JSON.stringify([repository.id]),
        label: repository.relativePath === '.' ? repository.name : repository.relativePath,
        description: repository.snapshot.detached ? (zh ? '游离 HEAD' : 'Detached HEAD') : repository.snapshot.branch,
        group: zh ? '仓库' : 'Repositories',
        ids: [repository.id],
      })),
    ];
    /** 部分成功后原分组可能拆开，仍保留用户已选的准确范围。 */
    const selectedValue = scopeIds.length ? JSON.stringify(scopeIds) : 'all';
    if (!choices.some((choice) => choice.value === selectedValue))
      choices.push({
        value: selectedValue,
        label: zh ? `已选仓库（${scopedRepositories.length}）` : `Selected repositories (${scopedRepositories.length})`,
        description: scopedRepositories.map((repository) => repository.name).join('、'),
        group: '',
        ids: scopeIds,
      });
    return choices;
  }, [repositories, scopedRepositories, scopeIds, zh]);
  /** 选择器值绑定成员身份，而非会随检出改变的分支名。 */
  const scopeValue = scopeIds.length ? JSON.stringify(scopeIds) : 'all';
  /** 同名分组内的仓库名称已在菜单中显示，触发器只保留组名。 */
  const scopeLabel = scopeChoices.find((choice) => choice.value === scopeValue)?.label ?? '';
  /** 工作树设置可按当前范围批量修改，其他仓库保持各自配置。 */
  const selections = scopedRepositories.map((repository) =>
    props.worktree && 'repositories' in props.worktree ? props.worktree.repositories.find((entry) => entry.repositoryId === repository.id) : projectWorktree ? undefined : props.worktree,
  );
  /** 首个配置只用于比较，不代表混合范围具有统一来源。 */
  const selection = selections[0];
  /** 混合来源时保持空选中态，允许统一选择共同来源。 */
  const commonSource = selection && selections.every((entry) => entry?.sourceKind === selection.sourceKind && entry?.sourceRef === selection.sourceRef) ? selection : undefined;
  /** 输入空值表示来源仓库使用不同的新分支名，编辑后统一为输入值。 */
  const commonBranchName = selection && selections.every((entry) => entry?.branchName === selection.branchName) ? selection.branchName : '';
  const snapshot = selectedRepository?.snapshot;
  /** 本地目标分支与 Git 页使用同一交集规则。 */
  const localBranches = useMemo(() => intersectRepositoryValues(scopedRepositories, repositoryLocalBranches), [scopedRepositories]);
  /** 本地和远端同名引用分开求交集，不混用来源类型。 */
  const sources = useMemo(
    () => [
      ...localBranches.map((ref) => ({ ref, kind: 'local' as const })),
      ...intersectRepositoryValues(scopedRepositories, (repository) => repository.snapshot.remoteBranches.filter((ref) => ref.includes('/') && !ref.endsWith('/HEAD'))).map((ref) => ({ ref, kind: 'remote' as const })),
    ],
    [localBranches, scopedRepositories],
  );
  const worktreeAvailable = loadState === 'ready' && repositories.length > 0 && repositories.every((repository) => repositorySources(repository.snapshot).length > 0);
  const sourceAvailable = scopedRepositories.every((repository, index) => {
    /** 已保存的各仓来源分别核对，混合来源本身不属于错误。 */
    const selected = selections[index];
    return selected && repositorySources(repository.snapshot).some((source) => source.kind === selected.sourceKind && source.ref === selected.sourceRef);
  });
  /** 前缀已由设置边界规范化，这里只负责即时启用状态。 */
  const branchNamespace = `${props.taskBranchPrefix}/`;
  const validWorktree =
    worktreeAvailable &&
    repositories.every((repository) => {
      /** 发送前检查全部成员，不能只检查当前展开的仓库。 */
      const options = props.worktree && 'repositories' in props.worktree ? props.worktree.repositories.find((entry) => entry.repositoryId === repository.id) : projectWorktree ? undefined : props.worktree;
      return Boolean(
        options &&
        options.branchName.trim().startsWith(branchNamespace) &&
        options.branchName.trim().length > branchNamespace.length &&
        repositorySources(repository.snapshot).some((source) => source.kind === options.sourceKind && source.ref === options.sourceRef),
      );
    });
  const branchLabel = scopedRepositories.some((repository) => repository.snapshot.branch !== snapshot?.branch || repository.snapshot.detached !== snapshot?.detached)
    ? zh
      ? '多个分支'
      : 'Multiple branches'
    : snapshot?.detached
      ? zh
        ? '游离 HEAD'
        : 'Detached HEAD'
      : snapshot?.branch || (loadState === 'loading' ? (zh ? '正在读取' : 'Loading') : zh ? '非 Git 目录' : 'Not a Git repository');
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

  const branchOptions = useMemo(() => {
    if (!selectedRepository) return [];
    const unavailableReason = zh ? '已在其他工作目录使用' : 'In use in another working folder';
    return [
      ...localBranches.map((branch) => {
        /** 任一仓库的目标分支被其他工作树使用时，整组目标不可检出。 */
        const occupied = scopedRepositories.some((repository) => (repository.snapshot.detached || repository.snapshot.branch !== branch) && repository.snapshot.checkedOutBranches?.includes(branch));
        return {
          value: branch,
          label: occupied ? `${branch} · ${unavailableReason}` : branch,
          group: zh ? '分支' : 'Branches',
          searchText: `${branch} ${occupied ? unavailableReason : ''}`,
          disabled: occupied,
        };
      }),
      {
        value: createBranchActionValue,
        label: zh ? '创建并检出新分支…' : 'Create and check out a new branch…',
        group: zh ? '操作' : 'Actions',
        searchText: zh ? '新建 创建 检出 分支' : 'new create checkout branch',
        disabled: false,
      },
    ];
  }, [localBranches, selectedRepository, scopedRepositories, zh]);

  useEffect(() => {
    const version = ++loadVersionRef.current;
    setWorkbench(null);
    setScopeIds([]);
    setLoadState('loading');
    setError(null);
    setRefreshing(false);
    branchBusyRef.current = false;
    setBranchBusy(false);
    setCreateBranchOpen(false);
    setCreateBranchName('');
    if (temporary) {
      setLoadState('ready');
      return;
    }
    if (!props.onLoadProjectGit) {
      setLoadState('error');
      setError(zh ? '当前无法读取项目分支。' : 'Project branches are unavailable.');
      return;
    }
    void props
      .onLoadProjectGit(props.projectId)
      .then((value) => {
        if (version !== loadVersionRef.current) return;
        setWorkbench(value);
        setLoadState('ready');
      })
      .catch((reason: unknown) => {
        if (version !== loadVersionRef.current) return;
        setLoadState('error');
        setError(reason);
      });
    return () => {
      loadVersionRef.current += 1;
    };
  }, [props.onLoadProjectGit, props.projectId, temporary, zh]);

  useEffect(() => {
    if (temporary || props.workspaceMode !== 'worktree' || !worktreeAvailable) return;
    /** 同一轮默认命名用于全部独立仓库；用户可以逐仓修改。 */
    const branchName = `${props.taskBranchPrefix}/conversation-${crypto.randomUUID().slice(0, 8)}`;
    if (!projectWorktree && !(props.worktree && 'repositories' in props.worktree)) {
      if (!props.worktree) {
        const source = sources.find((entry) => entry.kind === 'local' && entry.ref === snapshot?.branch) ?? sources[0];
        if (source) props.onWorktreeChange({ sourceKind: source.kind, sourceRef: source.ref, branchName });
      }
      return;
    }
    /** 仓库登记变化时保留仍在项目中的选择，为新增仓库填入当前分支。 */
    const previous = props.worktree && 'repositories' in props.worktree ? props.worktree.repositories : [];
    if (previous.length === repositories.length && repositories.every((repository) => previous.some((entry) => entry.repositoryId === repository.id))) return;
    props.onWorktreeChange({
      repositories: repositories.map((repository) => {
        const saved = previous.find((entry) => entry.repositoryId === repository.id);
        if (saved) return saved;
        const available = repositorySources(repository.snapshot);
        const source = available.find((entry) => entry.kind === 'local' && entry.ref === repository.snapshot.branch) ?? available[0]!;
        return { repositoryId: repository.id, sourceKind: source.kind, sourceRef: source.ref, branchName };
      }),
    });
  }, [temporary, props.workspaceMode, props.worktree, props.onWorktreeChange, props.taskBranchPrefix, worktreeAvailable, sources, snapshot?.branch, projectWorktree, repositories]);

  /** 批量修改只覆盖用户编辑的字段，其余来源和分支名各自保留。 */
  function updateSelection(value: Partial<ConversationWorktreeBranchOptions>): void {
    if (!selectedRepository) return;
    if (props.worktree && 'repositories' in props.worktree) {
      props.onWorktreeChange({ repositories: props.worktree.repositories.map((entry) => (scopedRepositories.some((repository) => repository.id === entry.repositoryId) ? { ...entry, ...value } : entry)) });
    } else if (props.worktree) props.onWorktreeChange({ ...props.worktree, ...value });
  }

  useEffect(() => {
    props.onBusyChange?.(branchBusy || projectBusy || refreshing || (!temporary && props.workspaceMode === 'worktree' && !validWorktree));
    return () => props.onBusyChange?.(false);
  }, [branchBusy, projectBusy, refreshing, temporary, props.workspaceMode, validWorktree, props.onBusyChange]);

  function closeCreateBranchDialog(): void {
    setCreateBranchOpen(false);
    setCreateBranchName('');
    window.requestAnimationFrame(() => branchTriggerRef.current?.focus());
  }

  /** 复用 Git 页的顺序批处理，并立即发布每个仓库返回的真实快照。 */
  async function executeBranchAction(action: ProjectGitAction): Promise<boolean> {
    if (!scopedRepositories.length || !props.onExecuteProjectGit || branchBusyRef.current || refreshing || projectBusy || props.disabled) return false;
    /** 操作开始时固定项目和仓库范围。 */
    const version = loadVersionRef.current;
    /** 已到目标分支的仓库无需重复检出；本地无 remote 的仓库不参与 fetch。 */
    const targets = scopedRepositories.filter((repository) =>
      action.type === 'checkout' || action.type === 'create_branch' ? repository.snapshot.detached || repository.snapshot.branch !== action.branchName : action.type !== 'fetch' || repository.snapshot.remotes.length > 0,
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
          if (version !== loadVersionRef.current) return null;
          setWorkbench((current) => replaceRepositorySnapshot(current, repository.id, response));
          return 'completed';
        } catch (reason) {
          failure = reason;
          return null;
        }
      });
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
        {!temporary && projectWorktree ? (
          <span className="session-new-conversation-context-control">
            <ZeusSelect
              ariaLabel={zh ? '分支操作范围' : 'Repositories for branch action'}
              className="session-new-conversation-context-select"
              value={scopeValue}
              triggerLabel={scopeLabel}
              triggerIcon={<Folder />}
              options={scopeChoices.map((choice) => ({ ...choice, searchText: choice.description }))}
              onChange={(value) => setScopeIds(scopeChoices.find((choice) => choice.value === value)?.ids ?? [])}
              disabled={props.disabled || refreshing || branchBusy || projectBusy}
              searchable
              searchPlaceholder={zh ? '搜索分支或仓库' : 'Search branches or repositories'}
              size="compact"
              popoverMinWidth={280}
            />
          </span>
        ) : null}
        {temporary ? (
          <span data-icon-tooltip={selectedProject?.localPath}>{zh ? '文件保存在默认目录' : 'Files saved in the default folder'}</span>
        ) : props.workspaceMode === 'direct' ? (
          <span className="session-new-conversation-context-control">
            <ZeusSelect
              ariaLabel={zh ? `分支：${branchLabel}` : `Branch: ${branchLabel}`}
              className="session-new-conversation-context-select"
              emptyLabel={zh ? '没有匹配的共同本地分支' : 'No matching common local branches'}
              onChange={(value) => {
                if (value === createBranchActionValue) {
                  setCreateBranchOpen(true);
                  return;
                }
                void executeBranchAction({ type: 'checkout', branchName: value });
              }}
              options={branchOptions}
              popoverMinWidth={340}
              searchable
              searchPlaceholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
              size="compact"
              triggerIcon={loadState === 'loading' ? <span className="session-new-conversation-context-spinner" aria-hidden="true" /> : <GitBranch />}
              triggerLabel={branchLabel}
              triggerRef={branchTriggerRef}
              value={branchLabel}
              disabled={props.disabled || refreshing || branchBusy || projectBusy || loadState !== 'ready' || !selectedRepository || !props.onExecuteProjectGit}
            />
          </span>
        ) : (
          <span className="session-new-conversation-context-control">
            <ZeusSelect
              ariaLabel={zh ? '来源分支' : 'Source branch'}
              className="session-new-conversation-context-select"
              popoverClassName="session-worktree-branch-popover"
              size="compact"
              popoverMinWidth={420}
              popoverArrowAlignment="start"
              triggerIcon={<GitBranch />}
              triggerLabel={commonSource?.sourceRef || (selection ? (zh ? '多个来源分支' : 'Multiple source branches') : zh ? '选择来源分支' : 'Choose source branch')}
              triggerTitle={[scopeLabel, commonSource?.sourceRef, commonBranchName].filter(Boolean).join(' · ')}
              value={commonSource ? `${commonSource.sourceKind}:${commonSource.sourceRef}` : ''}
              options={sources.map((source) => ({
                value: `${source.kind}:${source.ref}`,
                label: source.ref,
                group: source.kind === 'local' ? (zh ? '本地分支' : 'Local branches') : zh ? '远程分支' : 'Remote branches',
              }))}
              onChange={(value) => {
                const source = sources.find((entry) => `${entry.kind}:${entry.ref}` === value);
                if (source && selection) updateSelection({ sourceKind: source.kind, sourceRef: source.ref });
              }}
              searchable
              searchPlaceholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
              emptyLabel={zh ? '没有匹配的分支' : 'No matching branches'}
              disabled={props.disabled || projectBusy || branchBusy || !selection}
              footer={
                <span className="session-new-worktree-fields">
                  <label>
                    <span>{zh ? '工作树分支名' : 'Worktree branch name'}</span>
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
                  {selection && !sourceAvailable && loadState === 'ready' ? <span role="alert">{zh ? '来源分支已不可用，请重新选择。' : 'The source branch is no longer available. Choose another branch.'}</span> : null}
                  <Button
                    variant="secondary"
                    size="compact"
                    busy={refreshing}
                    disabled={props.disabled || projectBusy || branchBusy || !scopedRepositories.some((repository) => repository.snapshot.remotes.length) || !props.onExecuteProjectGit}
                    onClick={() => void executeBranchAction({ type: 'fetch' })}
                  >
                    {zh ? '刷新远程分支' : 'Refresh remote branches'}
                  </Button>
                </span>
              }
            />
          </span>
        )}
        <label className="session-new-conversation-create-task">
          <span>{zh ? '创建任务' : 'Create task'}</span>
          <span className="settings-switch-state">
            <input
              className="native-switch-input"
              type="checkbox"
              role="switch"
              aria-label={zh ? '创建任务' : 'Create task'}
              checked={props.createTask}
              onChange={(event) => props.onCreateTaskChange(event.currentTarget.checked)}
              disabled={props.disabled}
            />
            <span className="native-switch-track" aria-hidden="true" />
          </span>
        </label>
      </div>

      <MotionPresence>
        {createBranchOpen && selectedRepository ? (
          <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" dismissDisabled={branchBusy} onDismiss={closeCreateBranchDialog} role="dialog" aria-label={zh ? '新建分支' : 'New branch'}>
            <form
              className="project-git-reference-dialog zeus-solid-form-surface"
              onSubmit={(event) => {
                event.preventDefault();
                const branchName = createBranchName.trim();
                if (!branchName) return;
                void executeBranchAction({ type: 'create_branch', branchName, baseRef: selectedRepository.snapshot.detached ? undefined : selectedRepository.snapshot.branch }).then((created) => {
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
            </form>
          </ModalPortal>
        ) : null}
      </MotionPresence>
    </>
  );
}

function replaceRepositorySnapshot(current: ProjectGitWorkbenchSnapshot | null, repositoryId: string, response: ProjectGitActionResponse): ProjectGitWorkbenchSnapshot | null {
  if (!current) return current;
  return {
    ...current,
    refreshedAt: new Date().toISOString(),
    repositories: current.repositories.map((repository) => (repository.id === repositoryId ? { ...repository, snapshot: response.snapshot } : repository)),
  };
}

/** 首次提交前的当前分支与已存在本地、远端分支使用同一来源列表。 */
function repositorySources(snapshot: ProjectGitWorkbenchSnapshot['repositories'][number]['snapshot']) {
  /** unborn 分支没有 refs/heads，但可以创建独立工作树。 */
  const local = repositoryLocalBranches({ snapshot });
  return [...local.map((ref) => ({ ref, kind: 'local' as const })), ...snapshot.remoteBranches.filter((ref) => ref.includes('/') && !ref.endsWith('/HEAD')).map((ref) => ({ ref, kind: 'remote' as const }))];
}
