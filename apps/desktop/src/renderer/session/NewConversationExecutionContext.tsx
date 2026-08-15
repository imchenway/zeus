import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitWorkbenchSnapshot, ProjectRecord } from '../apiClient.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

type OpenContextMenu = 'project' | 'branch' | null;

export interface NewConversationExecutionContextProps {
  language: SessionUiLanguage;
  projectId: string;
  projects: readonly Pick<ProjectRecord, 'id' | 'name' | 'localPath'>[];
  disabled?: boolean;
  onSelectProject?: (projectId: string) => void;
  onLoadProjectGit?: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  onExecuteProjectGit?: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
  onBusyChange?: (busy: boolean) => void;
}

export function NewConversationExecutionContext(props: NewConversationExecutionContextProps) {
  const zh = props.language === 'zh-CN';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const projectTriggerRef = useRef<HTMLButtonElement | null>(null);
  const branchTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectSearchRef = useRef<HTMLInputElement | null>(null);
  const branchSearchRef = useRef<HTMLInputElement | null>(null);
  const loadVersionRef = useRef(0);
  const [openMenu, setOpenMenu] = useState<OpenContextMenu>(null);
  const [projectQuery, setProjectQuery] = useState('');
  const [branchQuery, setBranchQuery] = useState('');
  const [workbench, setWorkbench] = useState<ProjectGitWorkbenchSnapshot | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  useApplicationErrorDialog(error, {
    language: zh ? 'zh-CN' : 'en',
    title: zh ? '新会话执行环境操作失败' : 'New conversation context failed',
    source: 'NewConversationExecutionContext',
  });
  const [branchBusy, setBranchBusy] = useState(false);
  const [createBranchOpen, setCreateBranchOpen] = useState(false);
  const [createBranchName, setCreateBranchName] = useState('');

  const selectedProject = props.projects.find((project) => project.id === props.projectId) ?? null;
  const rootRepository = useMemo(() => workbench?.repositories.find((repository) => repository.relativePath === '.' || repository.relativePath === '') ?? null, [workbench]);
  const branchLabel = rootRepository?.snapshot.branch || (loadState === 'loading' ? (zh ? '正在读取' : 'Loading') : zh ? '非 Git 目录' : 'Not a Git repository');

  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLocaleLowerCase();
    if (!query) return props.projects;
    return props.projects.filter((project) => `${project.name} ${project.localPath}`.toLocaleLowerCase().includes(query));
  }, [projectQuery, props.projects]);

  const filteredBranches = useMemo(() => {
    const query = branchQuery.trim().toLocaleLowerCase();
    const branches = rootRepository?.snapshot.localBranches ?? [];
    return query ? branches.filter((branch) => branch.toLocaleLowerCase().includes(query)) : branches;
  }, [branchQuery, rootRepository]);

  useEffect(() => {
    const version = ++loadVersionRef.current;
    setWorkbench(null);
    setLoadState('loading');
    setError(null);
    setBranchQuery('');
    setCreateBranchOpen(false);
    setCreateBranchName('');
    if (!props.onLoadProjectGit) {
      setLoadState('error');
      setError(zh ? '当前无法读取项目分支。' : 'Project branches are unavailable.');
      return;
    }
    void props
      .onLoadProjectGit(props.projectId)
      .then((snapshot) => {
        if (version !== loadVersionRef.current) return;
        setWorkbench(snapshot);
        setLoadState('ready');
      })
      .catch((reason: unknown) => {
        if (version !== loadVersionRef.current) return;
        setLoadState('error');
        setError(formatGitContextError(reason, props.language));
      });
    return () => {
      loadVersionRef.current += 1;
    };
  }, [props.language, props.onLoadProjectGit, props.projectId, zh]);

  useEffect(() => {
    if (!openMenu) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      closeMenu(openMenu);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  }, [openMenu]);

  useEffect(() => {
    if (openMenu === 'project') projectSearchRef.current?.focus();
    if (openMenu === 'branch') branchSearchRef.current?.focus();
  }, [openMenu]);

  useEffect(() => {
    props.onBusyChange?.(branchBusy);
    return () => props.onBusyChange?.(false);
  }, [branchBusy, props.onBusyChange]);

  function closeMenu(menu: Exclude<OpenContextMenu, null>, restoreFocus = false): void {
    setOpenMenu(null);
    setProjectQuery('');
    setBranchQuery('');
    setCreateBranchOpen(false);
    setCreateBranchName('');
    if (!restoreFocus) return;
    window.requestAnimationFrame(() => (menu === 'project' ? projectTriggerRef.current : branchTriggerRef.current)?.focus());
  }

  function handleRootKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || !openMenu) return;
    event.preventDefault();
    event.stopPropagation();
    closeMenu(openMenu, true);
  }

  function handlePopoverKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1 + items.length) % items.length : (currentIndex - 1 + items.length) % items.length;
    event.preventDefault();
    items[nextIndex]?.focus();
  }

  async function executeBranchAction(action: ProjectGitAction): Promise<void> {
    if (!rootRepository || !props.onExecuteProjectGit || branchBusy) return;
    setBranchBusy(true);
    setError(null);
    try {
      const response = await props.onExecuteProjectGit(props.projectId, rootRepository.id, action);
      setWorkbench((current) => replaceRepositorySnapshot(current, rootRepository.id, response));
      closeMenu('branch', true);
    } catch (reason) {
      setError(formatGitContextError(reason, props.language));
    } finally {
      setBranchBusy(false);
    }
  }

  const checkedOutBranches = new Set(rootRepository?.snapshot.checkedOutBranches ?? []);

  return (
    <div ref={rootRef} className="session-new-conversation-context" aria-label={zh ? '新会话执行上下文' : 'New conversation execution context'} onKeyDown={handleRootKeyDown}>
      <span className="session-new-conversation-context-control">
        <button
          ref={projectTriggerRef}
          type="button"
          className="session-new-conversation-context-trigger"
          aria-label={zh ? `项目：${selectedProject?.name ?? '不可用'}` : `Project: ${selectedProject?.name ?? 'Unavailable'}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'project'}
          disabled={props.disabled || branchBusy || props.projects.length === 0 || !props.onSelectProject}
          onClick={() => setOpenMenu((current) => (current === 'project' ? null : 'project'))}
        >
          <Folder aria-hidden="true" />
          <span>{selectedProject?.name ?? (zh ? '项目不可用' : 'Project unavailable')}</span>
          <CaretDown aria-hidden="true" />
        </button>
        {openMenu === 'project' ? (
          <section className="session-new-conversation-context-popover is-project" role="dialog" aria-label={zh ? '选择项目' : 'Choose project'} onKeyDown={handlePopoverKeyDown}>
            <label className="session-new-conversation-context-search">
              <MagnifyingGlass aria-hidden="true" />
              <input ref={projectSearchRef} type="search" value={projectQuery} placeholder={zh ? '搜索项目' : 'Search projects'} onChange={(event) => setProjectQuery(event.currentTarget.value)} />
            </label>
            <span className="session-new-conversation-context-heading">{zh ? '项目' : 'Projects'}</span>
            <div className="session-new-conversation-context-options">
              {filteredProjects.length > 0 ? (
                filteredProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    aria-current={project.id === props.projectId ? 'true' : undefined}
                    onClick={() => {
                      closeMenu('project');
                      props.onSelectProject?.(project.id);
                    }}
                  >
                    <Folder aria-hidden="true" />
                    <span>
                      <strong>{project.name}</strong>
                      <small>{project.localPath}</small>
                    </span>
                    {project.id === props.projectId ? <Check aria-hidden="true" /> : null}
                  </button>
                ))
              ) : (
                <p className="session-new-conversation-context-empty">{zh ? '没有匹配的项目' : 'No matching projects'}</p>
              )}
            </div>
          </section>
        ) : null}
      </span>

      <span className="session-new-conversation-context-control">
        <button
          ref={branchTriggerRef}
          type="button"
          className="session-new-conversation-context-trigger"
          aria-label={zh ? `分支：${branchLabel}` : `Branch: ${branchLabel}`}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'branch'}
          disabled={props.disabled || loadState !== 'ready' || !rootRepository || !props.onExecuteProjectGit}
          onClick={() => setOpenMenu((current) => (current === 'branch' ? null : 'branch'))}
        >
          {loadState === 'loading' ? <CircleNotch className="session-new-conversation-context-spinner" aria-hidden="true" /> : <GitBranch aria-hidden="true" />}
          <span>{branchLabel}</span>
          {rootRepository ? <CaretDown aria-hidden="true" /> : null}
        </button>
        {openMenu === 'branch' && rootRepository ? (
          <section className="session-new-conversation-context-popover is-branch" role="dialog" aria-label={zh ? '选择分支' : 'Choose branch'} aria-busy={branchBusy || undefined} onKeyDown={handlePopoverKeyDown}>
            <label className="session-new-conversation-context-search">
              <MagnifyingGlass aria-hidden="true" />
              <input
                ref={branchSearchRef}
                type="search"
                value={branchQuery}
                placeholder={zh ? `搜索 ${selectedProject?.name ?? ''} 分支` : `Search ${selectedProject?.name ?? ''} branches`}
                onChange={(event) => setBranchQuery(event.currentTarget.value)}
              />
            </label>
            <span className="session-new-conversation-context-heading">{zh ? '分支' : 'Branches'}</span>
            <div className="session-new-conversation-context-options">
              {filteredBranches.length > 0 ? (
                filteredBranches.map((branch) => {
                  const current = branch === rootRepository.snapshot.branch;
                  const occupied = !current && checkedOutBranches.has(branch);
                  const unavailableReason = zh ? '该分支已在其他工作区检出' : 'This branch is checked out in another worktree';
                  return (
                    <button
                      key={branch}
                      type="button"
                      aria-current={current ? 'true' : undefined}
                      aria-label={occupied ? `${branch}，${unavailableReason}` : branch}
                      title={occupied ? unavailableReason : branch}
                      disabled={branchBusy || occupied}
                      onClick={() => {
                        if (current) {
                          closeMenu('branch', true);
                          return;
                        }
                        void executeBranchAction({ type: 'checkout', branchName: branch });
                      }}
                    >
                      <GitBranch aria-hidden="true" />
                      <span>{branch}</span>
                      {current ? <Check aria-hidden="true" /> : null}
                    </button>
                  );
                })
              ) : (
                <p className="session-new-conversation-context-empty">{zh ? '没有匹配的本地分支' : 'No matching local branches'}</p>
              )}
            </div>
            <div className="session-new-conversation-context-create">
              {createBranchOpen ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const branchName = createBranchName.trim();
                    if (!branchName) return;
                    void executeBranchAction({ type: 'create_branch', branchName, baseRef: rootRepository.snapshot.branch === 'detached' ? undefined : rootRepository.snapshot.branch });
                  }}
                >
                  <input
                    aria-label={zh ? '新分支名称' : 'New branch name'}
                    placeholder={zh ? '输入新分支名称' : 'Enter a new branch name'}
                    value={createBranchName}
                    disabled={branchBusy}
                    onChange={(event) => setCreateBranchName(event.currentTarget.value)}
                  />
                  <button type="submit" disabled={branchBusy || !createBranchName.trim()}>
                    {branchBusy ? (zh ? '正在检出' : 'Checking out') : zh ? '创建' : 'Create'}
                  </button>
                </form>
              ) : (
                <button type="button" disabled={branchBusy} onClick={() => setCreateBranchOpen(true)}>
                  <Plus aria-hidden="true" />
                  <span>{zh ? '创建并检出新分支…' : 'Create and check out a new branch…'}</span>
                </button>
              )}
            </div>
          </section>
        ) : null}
      </span>
    </div>
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

function formatGitContextError(reason: unknown, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  const message = reason instanceof Error ? reason.message : String(reason);
  if (/already checked out|registered worktree/u.test(message)) return zh ? '该分支已在其他工作区检出。' : 'This branch is checked out in another worktree.';
  if (/would be overwritten|local changes/u.test(message)) return zh ? '当前未提交修改会被分支切换覆盖，请先处理这些修改。' : 'Current local changes would be overwritten. Resolve them before switching branches.';
  if (/not a git repository|repository required/u.test(message.toLocaleLowerCase())) return zh ? '当前项目根目录不是 Git 仓库。' : 'The current project root is not a Git repository.';
  return zh ? `无法更新分支：${message}` : `Unable to update branch: ${message}`;
}
