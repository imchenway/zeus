import { temporaryWorkspaceId, type ConversationWorktreeBranchOptions, type ConversationWorktreeOptions } from '@zeus/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
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
  /** 仓库切换只改变当前编辑对象，各仓配置保存在同一个首发请求中。 */
  const [selectedRepositoryId, setSelectedRepositoryId] = useState('');
  /** 快照更换时直接派生有效选择，避免一帧使用上一项目仓库。 */
  const selectedRepository = repositories.find((repository) => repository.id === selectedRepositoryId) ?? repositories[0] ?? null;
  /** 非根仓即使只有一个成员，也需要保留项目容器目录。 */
  const projectWorktree = repositories.length > 1 || Boolean(repositories[0] && !['', '.'].includes(repositories[0].relativePath));
  /** 只读取当前仓库的来源和目标分支。 */
  const selection = props.worktree && 'repositories' in props.worktree ? props.worktree.repositories.find((entry) => entry.repositoryId === selectedRepository?.id) : projectWorktree ? undefined : props.worktree;
  const snapshot = selectedRepository?.snapshot;
  /** 首次提交前当前分支尚未进入 localBranches，仍需作为真实本地来源展示。 */
  const localBranches = useMemo(
    () => (!snapshot?.detached && !snapshot?.headSha && snapshot?.branch && !snapshot.localBranches.includes(snapshot.branch) ? [snapshot.branch, ...snapshot.localBranches] : (snapshot?.localBranches ?? [])),
    [snapshot],
  );
  const sources = useMemo(() => (snapshot ? repositorySources(snapshot) : []), [snapshot]);
  const worktreeAvailable = loadState === 'ready' && repositories.length > 0 && repositories.every((repository) => repositorySources(repository.snapshot).length > 0);
  const sourceAvailable = Boolean(selection && sources.some((source) => source.kind === selection.sourceKind && source.ref === selection.sourceRef));
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
  const branchLabel = snapshot?.detached ? (zh ? '游离 HEAD' : 'Detached HEAD') : snapshot?.branch || (loadState === 'loading' ? (zh ? '正在读取' : 'Loading') : zh ? '非 Git 目录' : 'Not a Git repository');
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

  const checkedOutBranches = useMemo(() => new Set(snapshot?.checkedOutBranches ?? []), [snapshot?.checkedOutBranches]);
  const branchOptions = useMemo(() => {
    if (!selectedRepository) return [];
    const unavailableReason = zh ? '已在其他工作目录使用' : 'In use in another working folder';
    return [
      ...localBranches.map((branch) => {
        const current = branch === selectedRepository.snapshot.branch;
        const occupied = !current && checkedOutBranches.has(branch);
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
  }, [checkedOutBranches, localBranches, selectedRepository, zh]);

  useEffect(() => {
    const version = ++loadVersionRef.current;
    setWorkbench(null);
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

  /** 改动当前仓库时保留其余仓库的来源和分支。 */
  function updateSelection(value: ConversationWorktreeBranchOptions): void {
    if (!selectedRepository) return;
    if (props.worktree && 'repositories' in props.worktree) {
      props.onWorktreeChange({ repositories: props.worktree.repositories.map((entry) => (entry.repositoryId === selectedRepository.id ? { ...value, repositoryId: entry.repositoryId } : entry)) });
    } else props.onWorktreeChange(value);
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

  async function executeBranchAction(action: ProjectGitAction): Promise<boolean> {
    if (!selectedRepository || !props.onExecuteProjectGit || branchBusyRef.current || refreshing || projectBusy || props.disabled) return false;
    const version = loadVersionRef.current;
    branchBusyRef.current = true;
    setBranchBusy(true);
    setError(null);
    try {
      const response = await props.onExecuteProjectGit(props.projectId, selectedRepository.id, action);
      if (version !== loadVersionRef.current) return false;
      setWorkbench((current) => replaceRepositorySnapshot(current, selectedRepository.id, response));
      return true;
    } catch (reason) {
      if (version === loadVersionRef.current) setError(reason);
      return false;
    } finally {
      if (version === loadVersionRef.current) {
        branchBusyRef.current = false;
        setBranchBusy(false);
      }
    }
  }

  async function refreshRemoteBranches(): Promise<void> {
    if (!selectedRepository || !props.onExecuteProjectGit || refreshing) return;
    const version = loadVersionRef.current;
    setRefreshing(true);
    setError(null);
    try {
      const response = await props.onExecuteProjectGit(props.projectId, selectedRepository.id, { type: 'fetch' });
      if (version !== loadVersionRef.current) return;
      setWorkbench((current) => (current ? { ...current, repositories: current.repositories.map((repository) => (repository.id === selectedRepository.id ? { ...repository, snapshot: response.snapshot } : repository)) } : null));
    } catch (reason) {
      if (version === loadVersionRef.current) setError(reason);
    } finally {
      if (version === loadVersionRef.current) setRefreshing(false);
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
              ariaLabel={zh ? 'Git 仓库' : 'Git repository'}
              className="session-new-conversation-context-select"
              value={selectedRepository?.id ?? ''}
              triggerLabel={selectedRepository ? (selectedRepository.relativePath === '.' ? selectedRepository.name : selectedRepository.relativePath) : zh ? '选择仓库' : 'Choose repository'}
              triggerIcon={<Folder />}
              options={repositories.map((repository) => ({ value: repository.id, label: repository.relativePath === '.' ? repository.name : repository.relativePath, searchText: `${repository.name} ${repository.relativePath}` }))}
              onChange={setSelectedRepositoryId}
              disabled={props.disabled || refreshing || branchBusy || projectBusy}
              searchable
              searchPlaceholder={zh ? '搜索仓库' : 'Search repositories'}
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
              emptyLabel={zh ? '没有匹配的本地分支' : 'No matching local branches'}
              onChange={(value) => {
                if (value === createBranchActionValue) {
                  setCreateBranchOpen(true);
                  return;
                }
                if (value !== selectedRepository?.snapshot.branch) void executeBranchAction({ type: 'checkout', branchName: value });
              }}
              options={branchOptions}
              popoverMinWidth={340}
              searchable
              searchPlaceholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
              size="compact"
              triggerIcon={loadState === 'loading' ? <span className="session-new-conversation-context-spinner" aria-hidden="true" /> : <GitBranch />}
              triggerLabel={branchLabel}
              triggerRef={branchTriggerRef}
              value={selectedRepository?.snapshot.branch ?? branchLabel}
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
              triggerLabel={selection?.sourceRef || (zh ? '选择来源分支' : 'Choose source branch')}
              triggerTitle={[zh ? '工作树来源分支' : 'Worktree source branch', selection?.sourceRef, selection?.branchName].filter(Boolean).join(' · ')}
              value={selection ? `${selection.sourceKind}:${selection.sourceRef}` : ''}
              options={sources.map((source) => ({
                value: `${source.kind}:${source.ref}`,
                label: source.ref,
                group: source.kind === 'local' ? (zh ? '本地分支' : 'Local branches') : zh ? '远程分支' : 'Remote branches',
              }))}
              onChange={(value) => {
                const source = sources.find((entry) => `${entry.kind}:${entry.ref}` === value);
                if (source && selection) updateSelection({ ...selection, sourceKind: source.kind, sourceRef: source.ref });
              }}
              searchable
              searchPlaceholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
              emptyLabel={zh ? '没有匹配的分支' : 'No matching branches'}
              disabled={props.disabled || projectBusy || !selection}
              footer={
                <span className="session-new-worktree-fields">
                  <label>
                    <span>{zh ? '工作树分支名' : 'Worktree branch name'}</span>
                    <input
                      aria-label={zh ? '工作树分支名' : 'Worktree branch name'}
                      value={selection?.branchName ?? ''}
                      placeholder={`${props.taskBranchPrefix}/conversation-example`}
                      spellCheck={false}
                      disabled={props.disabled || projectBusy || !selection}
                      onChange={(event) => {
                        if (selection) updateSelection({ ...selection, branchName: event.currentTarget.value });
                      }}
                    />
                  </label>
                  <small>
                    {!snapshot?.headSha && selection?.sourceKind === 'local' && selection.sourceRef === snapshot?.branch
                      ? zh
                        ? `空仓库会把当前项目文件带入工作树；分支名须以 ${branchNamespace} 开头。`
                        : `The current project files will seed this empty repository worktree. The new name must start with ${branchNamespace}.`
                      : zh
                        ? `从所选分支创建，分支名须以 ${branchNamespace} 开头。`
                        : `Create from the selected branch. The new name must start with ${branchNamespace}.`}
                  </small>
                  {selection && !sourceAvailable && loadState === 'ready' ? <span role="alert">{zh ? '来源分支已不可用，请重新选择。' : 'The source branch is no longer available. Choose another branch.'}</span> : null}
                  <Button variant="secondary" size="compact" busy={refreshing} disabled={props.disabled || projectBusy || !snapshot?.remotes.length || !props.onExecuteProjectGit} onClick={() => void refreshRemoteBranches()}>
                    {zh ? '刷新远程分支' : 'Refresh remote branches'}
                  </Button>
                </span>
              }
            />
          </span>
        )}
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
                <small>{zh ? `起点：${selectedRepository.snapshot.branch}` : `Starting point: ${selectedRepository.snapshot.branch}`}</small>
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
  const local = !snapshot.detached && !snapshot.headSha && snapshot.branch && !snapshot.localBranches.includes(snapshot.branch) ? [snapshot.branch, ...snapshot.localBranches] : snapshot.localBranches;
  return [...local.map((ref) => ({ ref, kind: 'local' as const })), ...snapshot.remoteBranches.filter((ref) => ref.includes('/') && !ref.endsWith('/HEAD')).map((ref) => ({ ref, kind: 'remote' as const }))];
}
