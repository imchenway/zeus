import './gitWorkspace.css';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { MenuSurface, type MenuSubmenuAnchor } from '../ui/MenuSurface.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useMotionPresence } from '../ui/useMotionPresence.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import type { ProjectGitAction, ProjectGitRepositoryWorkbenchItem } from '../apiClient.js';
import type { BusyState, OperationTone, BranchKind, ExecutionOutcome, ProjectGitUpdateStrategy, PushSelection } from './gitWorkbenchTypes.js';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';

interface BranchTreeNode {
  name: string;
  branch: string;
  children: Map<string, BranchTreeNode>;
}

export function BranchSwitcher(props: {
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
  const [referenceMenu, setReferenceMenu] = useState<{ anchor: HTMLButtonElement; repository: ProjectGitRepositoryWorkbenchItem; reference: string; kind: BranchKind | 'tag' | 'revision' } | null>(null);
  const referenceMenuRef = useRef(referenceMenu);
  referenceMenuRef.current = referenceMenu;
  const menuTreeRef = useRef<HTMLDivElement>(null);
  const submenuId = useId();
  const [commonBranch, setCommonBranch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 下拉视觉退出后释放内容，业务开关仍立即生效。 */
  const { ref: popoverRef, present: popoverPresent } = useMotionPresence<HTMLDivElement>(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const triggerLabel = props.selectedRepository ? currentRepositoryRefLabel(props.selectedRepository, props.zh) : props.zh ? '选择分支' : 'Select branch';
  const visibleRepositories = normalizedQuery
    ? props.repositories.filter((repository) => `${repository.name}/${repository.relativePath}`.toLocaleLowerCase().includes(normalizedQuery) || repositoryHasMatchingReference(repository, normalizedQuery))
    : props.selectedRepository
      ? [props.selectedRepository]
      : props.repositories.slice(0, 1);
  const commonLocalBranches = useMemo(() => intersectRepositoryValues(props.repositories, (repository) => repository.snapshot.localBranches), [props.repositories]);

  const closeMenus = () => {
    setReferenceMenu(null);
    setOpen(false);
  };

  // 定位与首帧一起完成，展开过程中只改变视觉状态。
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = popoverRef.current?.offsetWidth ?? 420;
      const height = popoverRef.current?.offsetHeight ?? 600;
      const top = rect.bottom + height + 14 <= window.innerHeight ? rect.bottom + 6 : rect.top >= height + 14 ? rect.top - height - 6 : window.innerHeight - height - 8;
      setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)), top: Math.max(8, top) });
    };
    const close = (event: PointerEvent) => {
      if (menuTreeRef.current?.closest('[inert]')) return;
      if (!menuTreeRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) closeMenus();
    };
    const escape = (event: KeyboardEvent) => {
      if (referenceMenuRef.current || menuTreeRef.current?.closest('[inert]')) return;
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        event.stopPropagation();
        closeMenus();
        triggerRef.current?.focus();
      }
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', escape, true);
    searchRef.current?.focus({ preventScroll: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);

  const matches = (value: string): boolean => !normalizedQuery || value.toLocaleLowerCase().includes(normalizedQuery);
  const runAction = (action: () => void) => () => {
    closeMenus();
    action();
  };
  const openReferenceMenu = (event: ReactMouseEvent<HTMLButtonElement>, repository: ProjectGitRepositoryWorkbenchItem, ref: string, kind: BranchKind | 'tag' | 'revision') => {
    props.onSelectRepository(repository.id);
    setReferenceMenu({ anchor: event.currentTarget, repository, reference: ref, kind });
  };
  const quickActions = [
    { id: 'update', label: props.zh ? '更新项目…' : 'Update Project…', run: props.onOpenUpdate },
    { id: 'commit', label: props.zh ? '提交…' : 'Commit…', run: props.onOpenCommit },
    { id: 'push', label: props.zh ? '推送…' : 'Push…', run: props.onOpenPush },
    { id: 'new-branch', label: props.zh ? '新建分支…' : 'New Branch…', run: () => props.onOpenNewBranch() },
    { id: 'revision', label: props.zh ? '切换到标签或提交…' : 'Switch to a tag or commit…', run: props.onOpenRevision },
  ].filter((action) => matches(action.label));

  const popover = popoverPresent ? (
    <div ref={menuTreeRef} className="git-branch-menu-tree">
      <div
        ref={popoverRef}
        className="project-git-branch-popover"
        data-motion-surface="popover"
        data-motion-state={open ? 'open' : 'closing'}
        inert={!open}
        aria-hidden={!open}
        role="dialog"
        aria-label={props.zh ? '分支与 Git 操作' : 'Branches and Git actions'}
        style={position}
      >
        <label className="project-git-branch-search">
          <MagnifyingGlass aria-hidden="true" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => {
              setReferenceMenu(null);
              setQuery(event.currentTarget.value);
            }}
            aria-label={props.zh ? '搜索分支、操作和仓库' : 'Search branches, actions and repositories'}
            placeholder={props.zh ? '搜索分支、操作和仓库' : 'Search branches, actions and repositories'}
          />
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
          {normalizedQuery && props.repositories.length > 1 && commonLocalBranches.some(matches) ? (
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
                          for (const repository of props.repositories) {
                            if (repository.snapshot.branch === branch && !repository.snapshot.detached) continue;
                            if ((await props.onExecute(repository, { type: 'checkout', branchName: branch }, props.zh ? `在全部仓库签出“${branch}”` : `Checkout '${branch}' in all repositories`)) !== 'completed') break;
                          }
                          setOpen(false);
                        }}
                      >
                        {props.zh ? `在全部 ${props.repositories.length} 个仓库签出` : `Checkout in all ${props.repositories.length} repositories`}
                      </button>
                      <button
                        type="button"
                        disabled={props.busy !== null}
                        onClick={async () => {
                          for (const repository of props.repositories.filter((candidate) => candidate.snapshot.branch !== branch)) {
                            if ((await props.onExecute(repository, { type: 'merge', branchName: branch }, props.zh ? `将“${branch}”合入当前分支` : `Merge '${branch}' into current branch`)) !== 'completed') break;
                          }
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
          {props.repositories.length > 1 ? (
            <section className="git-branch-repositories" aria-label={props.zh ? '仓库' : 'Repositories'}>
              {props.repositories
                .filter((repository) => !normalizedQuery || `${repository.name}/${repository.relativePath}`.toLocaleLowerCase().includes(normalizedQuery))
                .map((repository) => (
                  <button
                    type="button"
                    key={repository.id}
                    className={repository.id === props.selectedRepository?.id ? 'is-current' : ''}
                    onClick={() => {
                      setReferenceMenu(null);
                      props.onSelectRepository(repository.id);
                      setQuery('');
                    }}
                    title={repository.relativePath}
                  >
                    <span className="git-repository-dot" />
                    <span>{repository.name}</span>
                    <small>{currentRepositoryRefLabel(repository, props.zh)}</small>
                    <CaretRight />
                  </button>
                ))}
            </section>
          ) : null}
          {visibleRepositories.map((repository) => (
            <RepositoryBranchGroups
              key={`${repository.id}:${normalizedQuery}`}
              zh={props.zh}
              repository={repository}
              query={`${repository.name}/${repository.relativePath}`.toLocaleLowerCase().includes(normalizedQuery) ? '' : normalizedQuery}
              onOpenReferenceMenu={openReferenceMenu}
              activeAnchorId={referenceMenu?.anchor.id}
              submenuId={submenuId}
            />
          ))}
          {quickActions.length === 0 && !props.repositories.some((repository) => repositoryHasMatchingReference(repository, normalizedQuery)) ? (
            <p className="project-git-branch-empty">{props.zh ? '没有匹配的分支、标签或操作。可使用“签出标签或 Revision”解析完整引用。' : 'No matching branch, tag, or action. Use Checkout Tag or Revision to resolve an exact ref.'}</p>
          ) : null}
        </div>
      </div>
      <MotionPresence>
        {open && referenceMenu && popoverRef.current ? (
          referenceMenu.kind === 'local' || referenceMenu.kind === 'remote' ? (
            <BranchContextMenu
              key={referenceMenu.anchor.id}
              id={submenuId}
              x={0}
              y={0}
              submenuAnchor={{ row: referenceMenu.anchor, parent: popoverRef.current }}
              repository={referenceMenu.repository}
              branch={referenceMenu.reference}
              kind={referenceMenu.kind}
              zh={props.zh}
              busy={props.busy}
              onClose={() => setReferenceMenu(null)}
              onAction={closeMenus}
              onExecute={props.onExecute}
              onOpenDiff={props.onOpenDiff}
            />
          ) : (
            <RevisionContextMenu
              key={referenceMenu.anchor.id}
              id={submenuId}
              x={0}
              y={0}
              submenuAnchor={{ row: referenceMenu.anchor, parent: popoverRef.current }}
              repository={referenceMenu.repository}
              revision={referenceMenu.reference}
              zh={props.zh}
              busy={props.busy}
              onClose={() => setReferenceMenu(null)}
              onAction={closeMenus}
              onExecute={props.onExecute}
              onNewBranch={(baseRef) => {
                closeMenus();
                props.onOpenNewBranch(baseRef);
              }}
            />
          )
        ) : null}
      </MotionPresence>
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-git-branch-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!props.repositories.length}
        onClick={() => {
          setQuery('');
          setReferenceMenu(null);
          setOpen((current) => !current);
        }}
      >
        <GitBranch aria-hidden="true" />
        <span title={`${props.selectedRepository?.name ?? ''} · ${triggerLabel}`}>{triggerLabel}</span>
        <CaretDown aria-hidden="true" />
      </button>
      {typeof document !== 'undefined' && document.body && popover ? createPortal(popover, triggerRef.current?.closest('.macos-ai-app') ?? document.body) : popover}
    </>
  );
}

export function RepositoryBranchGroups(props: {
  zh: boolean;
  repository: ProjectGitRepositoryWorkbenchItem;
  query: string;
  activeAnchorId?: string;
  submenuId: string;
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
          <ReferenceTree items={group.values} repository={props.repository} zh={props.zh} onOpenReferenceMenu={props.onOpenReferenceMenu} activeAnchorId={props.activeAnchorId} submenuId={props.submenuId} />
        </div>
      ))}
    </section>
  );
}

function ReferenceTree(props: {
  items: Array<{ ref: string; kind: BranchKind | 'tag' | 'revision' }>;
  repository: ProjectGitRepositoryWorkbenchItem;
  zh: boolean;
  onOpenReferenceMenu: Parameters<typeof RepositoryBranchGroups>[0]['onOpenReferenceMenu'];
  prefix?: string;
  activeAnchorId?: string;
  submenuId: string;
}) {
  const treeId = useId();
  const prefix = props.prefix ?? '';
  const folders = new Map<string, typeof props.items>();
  const leaves: typeof props.items = [];
  for (const item of props.items) {
    const rest = item.ref.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) leaves.push(item);
    else {
      const folder = rest.slice(0, slash + 1);
      const children = folders.get(folder) ?? [];
      children.push(item);
      folders.set(folder, children);
    }
  }
  return (
    <div className="git-reference-tree">
      {[...folders].map(([folder, items]) => (
        <details key={folder} open>
          <summary>
            <CaretRight />
            <span>{folder.slice(0, -1)}</span>
          </summary>
          <ReferenceTree {...props} items={items} prefix={prefix + folder} />
        </details>
      ))}
      {leaves.map((item, index) => (
        <button
          key={`${item.kind}:${item.ref}`}
          type="button"
          className={item.kind === 'local' && item.ref === props.repository.snapshot.branch ? 'is-current' : ''}
          id={`${treeId}-${index}`}
          title={item.ref}
          aria-haspopup="menu"
          aria-expanded={props.activeAnchorId === `${treeId}-${index}`}
          aria-controls={props.activeAnchorId === `${treeId}-${index}` ? props.submenuId : undefined}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowRight') return;
            event.preventDefault();
            event.currentTarget.click();
          }}
          onClick={(event) => props.onOpenReferenceMenu(event, props.repository, item.ref, item.kind)}
        >
          <GitBranch />
          <span>{item.ref.slice(prefix.length)}</span>
          {item.kind === 'local' && item.ref === props.repository.snapshot.branch ? <small>{props.zh ? '当前' : 'Current'}</small> : null}
          <CaretRight />
        </button>
      ))}
    </div>
  );
}

export function RevisionContextMenu(props: {
  id?: string;
  submenuAnchor?: MenuSubmenuAnchor;
  onAction?: () => void;
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
  const closeMenus = props.onAction ?? props.onClose;

  return (
    <MenuSurface
      onClose={props.onClose}
      ref={menuRef}
      id={props.id}
      submenuAnchor={props.submenuAnchor}
      className="project-git-branch-context-menu"
      role="menu"
      aria-label={props.zh ? `引用操作：${props.revision}` : `Reference actions: ${props.revision}`}
      style={{ left: props.x, top: props.y }}
    >
      <div className="git-reference-menu-heading" title={props.revision}>
        <GitBranch aria-hidden="true" />
        <strong>{props.revision}</strong>
      </div>
      <button
        type="button"
        role="menuitem"
        disabled={props.busy !== null}
        onClick={() => {
          closeMenus();
          void props.onExecute(props.repository, { type: 'checkout_revision', revision: props.revision }, props.zh ? `签出“${props.revision}”` : `Checkout '${props.revision}'`);
        }}
      >
        {props.zh ? '签出（进入游离提交状态）' : 'Checkout (detached HEAD)'}
      </button>
      <button type="button" role="menuitem" disabled={props.busy !== null} onClick={() => props.onNewBranch(props.revision)}>
        {props.zh ? `从“${props.revision}”新建分支…` : `New Branch from '${props.revision}'…`}
      </button>
    </MenuSurface>
  );
}

export function UpdateProjectDialog(props: {
  open: boolean;
  projectId: string;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  busy: BusyState;
  errorsByRepository: Readonly<Record<string, string>>;
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
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null} role="dialog" aria-label={props.zh ? '更新项目' : 'Update project'}>
      <section className="project-git-update-dialog" data-modal-surface="dialog">
        <header>
          <strong>{props.zh ? '更新项目' : 'Update Project'}</strong>
          <small>
            {props.zh
              ? '获取所有仓库的远端变化，并按所选方式更新当前分支。未提交的文件会先备份，更新后再恢复。'
              : 'Fetch remote changes for all repositories and update their current branches using the selected method. Uncommitted files are backed up first and restored afterward.'}
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
                  {result === null && results.some((item) => item.id === repository.id) ? (
                    <i className="is-error">
                      <VisibleApplicationError error={props.errorsByRepository[repository.id]} language={props.zh ? 'zh-CN' : 'en'} />
                    </i>
                  ) : null}
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

export function NewBranchDialog(props: {
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
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null} role="dialog" aria-label={props.zh ? '新建分支' : 'New branch'}>
      <section className="project-git-reference-dialog" data-modal-surface="dialog">
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
              const outcome = await props.onExecute(repository, { type: 'create_branch', branchName: branchName.trim(), baseRef }, props.zh ? '新建并签出分支' : 'Create and checkout branch');
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

export function RemoteBranchCheckoutDialog(props: {
  zh: boolean;
  repository: ProjectGitRepositoryWorkbenchItem;
  initialRemoteRef: string;
  busy: BusyState;
  onClose: () => void;
  onComplete?: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  type CheckoutMode = 'existing' | 'new';
  const initialCandidates = matchingLocalBranches(props.repository, props.initialRemoteRef);
  const [mode, setMode] = useState<CheckoutMode>(() => (initialCandidates.length ? 'existing' : 'new'));
  const [remoteRef, setRemoteRef] = useState(props.initialRemoteRef);
  const [existingBranch, setExistingBranch] = useState(initialCandidates[0] ?? '');
  const [branchName, setBranchName] = useState(() => remoteBranchLeaf(props.initialRemoteRef));
  const [trackRemote, setTrackRemote] = useState(true);
  const existingCandidates = matchingLocalBranches(props.repository, remoteRef);
  const normalizedBranchName = branchName.trim();
  const branchAlreadyExists = props.repository.snapshot.localBranches.includes(normalizedBranchName);
  const currentBranchSelected = !props.repository.snapshot.detached && existingBranch === props.repository.snapshot.branch;
  const selectRemote = (nextRemoteRef: string) => {
    const nextCandidates = matchingLocalBranches(props.repository, nextRemoteRef);
    setRemoteRef(nextRemoteRef);
    setExistingBranch(nextCandidates[0] ?? '');
    setBranchName(remoteBranchLeaf(nextRemoteRef));
    if (mode === 'existing' && nextCandidates.length === 0) setMode('new');
  };
  const disabled = props.busy !== null || (mode === 'existing' ? !existingBranch || currentBranchSelected : !normalizedBranchName || branchAlreadyExists);
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={props.busy !== null} role="dialog">
      <section className="project-git-reference-dialog project-git-remote-checkout-dialog" role="dialog" aria-modal="true" aria-label={props.zh ? '检出远程分支' : 'Checkout remote branch'}>
        <header>
          <strong>{props.zh ? '检出远程分支' : 'Checkout Remote Branch'}</strong>
          <span className="project-git-remote-checkout-modes" role="tablist" aria-label={props.zh ? '检出方式' : 'Checkout mode'}>
            <button type="button" role="tab" aria-selected={mode === 'existing'} disabled={existingCandidates.length === 0 || props.busy !== null} onClick={() => setMode('existing')}>
              <ArrowRight aria-hidden="true" />
              <span>{props.zh ? '检出现有' : 'Checkout Existing'}</span>
            </button>
            <button type="button" role="tab" aria-selected={mode === 'new'} disabled={props.busy !== null} onClick={() => setMode('new')}>
              <GitBranch aria-hidden="true" />
              <span>{props.zh ? '检出新分支' : 'Checkout New Branch'}</span>
            </button>
          </span>
        </header>
        <main>
          <label>
            <span>{props.zh ? '检出远程分支' : 'Remote branch'}</span>
            <select value={remoteRef} onChange={(event) => selectRemote(event.currentTarget.value)} disabled={props.busy !== null}>
              {props.repository.snapshot.remoteBranches.map((branch) => (
                <option key={branch} value={branch}>
                  {branch}
                </option>
              ))}
            </select>
          </label>
          {mode === 'existing' ? (
            <label>
              <span>{props.zh ? '现有本地分支' : 'Existing local branch'}</span>
              <select value={existingBranch} onChange={(event) => setExistingBranch(event.currentTarget.value)} autoFocus disabled={props.busy !== null}>
                {existingCandidates.map((branch) => (
                  <option key={branch} value={branch}>
                    {branch}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <>
              <label>
                <span>{props.zh ? '新的本地分支名称' : 'New local branch name'}</span>
                <input value={branchName} onChange={(event) => setBranchName(event.currentTarget.value)} autoFocus disabled={props.busy !== null} />
              </label>
              <label className="project-git-remote-checkout-track">
                <input type="checkbox" checked={trackRemote} onChange={(event) => setTrackRemote(event.currentTarget.checked)} disabled={props.busy !== null} />
                <span>{props.zh ? '本地分支跟踪远程分支' : 'Track the remote branch'}</span>
              </label>
              {branchAlreadyExists ? (
                <p className="project-git-remote-checkout-warning" role="alert">
                  {props.zh ? `本地分支“${normalizedBranchName}”已存在，请选择“检出现有”或使用其他名称。` : `Local branch '${normalizedBranchName}' already exists. Checkout the existing branch or choose another name.`}
                </p>
              ) : null}
            </>
          )}
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            busy={props.busy?.action === (mode === 'existing' ? 'checkout' : 'create_branch')}
            disabled={disabled}
            onClick={async () => {
              const outcome =
                mode === 'existing'
                  ? await props.onExecute(props.repository, { type: 'checkout', branchName: existingBranch }, props.zh ? '检出现有分支' : 'Checkout existing branch')
                  : await props.onExecute(props.repository, { type: 'create_branch', branchName: normalizedBranchName, baseRef: remoteRef, trackRemote }, props.zh ? '检出远程分支' : 'Checkout remote branch');
              if (outcome === 'completed') (props.onComplete ?? props.onClose)();
            }}
          >
            {props.zh ? '检出' : 'Checkout'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

export function matchingLocalBranches(repository: ProjectGitRepositoryWorkbenchItem, remoteRef: string): string[] {
  const leaf = remoteBranchLeaf(remoteRef);
  return repository.snapshot.localBranches.filter((branch) => repository.snapshot.branchUpstreams?.[branch] === remoteRef || branch === leaf);
}

export function remoteBranchLeaf(remoteRef: string): string {
  return remoteRef.replace(/^[^/]+\//u, '');
}

export function CheckoutRevisionDialog(props: {
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
    <ModalPortal
      rootClassName="project-git-modal-root"
      backdropClassName="project-git-modal-backdrop"
      onDismiss={props.onClose}
      dismissDisabled={props.busy !== null}
      role="dialog"
      aria-label={props.zh ? '切换到标签或提交' : 'Switch to a tag or commit'}
    >
      <section className="project-git-reference-dialog" data-modal-surface="dialog">
        <header>
          <strong>{props.zh ? '切换到标签或提交' : 'Switch to a tag or commit'}</strong>
          <small>
            {props.zh ? '切换后会停留在所选提交，不属于任何分支。如需继续修改，可以从这里新建分支。' : 'After switching, you will be at the selected commit without being on a branch. Create a branch from there to continue making changes.'}
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
              const outcome = await props.onExecute(repository, { type: 'checkout_revision', revision: revision.trim() }, props.zh ? '切换到所选提交' : 'Switch to the selected commit');
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

export function currentRepositoryRefLabel(repository: ProjectGitRepositoryWorkbenchItem, zh: boolean): string {
  if (!repository.snapshot.detached) return repository.snapshot.branch;
  return `${zh ? '游离' : 'Detached'} · ${repository.snapshot.headTags[0] ?? repository.snapshot.headSha.slice(0, 8)}`;
}

export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/iu.test(ref) ? ref.slice(0, 8) : ref;
}

export function intersectRepositoryValues(repositories: ProjectGitRepositoryWorkbenchItem[], read: (repository: ProjectGitRepositoryWorkbenchItem) => string[]): string[] {
  if (repositories.length === 0) return [];
  const [first, ...rest] = repositories;
  return [...new Set(read(first!))].filter((value) => rest.every((repository) => read(repository).includes(value))).sort((left, right) => left.localeCompare(right));
}

export function repositoryHasMatchingReference(repository: ProjectGitRepositoryWorkbenchItem, query: string): boolean {
  if (!query) return true;
  return [...repository.snapshot.localBranches, ...repository.snapshot.remoteBranches, ...repository.snapshot.tags, ...repository.snapshot.recentRefs.map((item) => item.ref)].some((value) => value.toLocaleLowerCase().includes(query));
}

export function readUpdateStrategy(projectId: string): ProjectGitUpdateStrategy {
  const value = typeof window === 'undefined' ? null : window.localStorage.getItem(`zeus.project-git-update-strategy:${projectId}`);
  return value === 'merge' || value === 'rebase' || value === 'reset' ? value : 'merge';
}

export function BranchDirectoryTree(props: {
  hideBranchIcons?: boolean;
  onSelect?: (branch: string) => void;
  branches: string[];
  current: string;
  selected?: string;
  branchDivergences?: Record<string, { ahead: number; behind: number }>;
  kind: BranchKind;
  zh: boolean;
  onCheckout?: (branch: string) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, branch: string) => void;
}) {
  const tree = useMemo(() => buildBranchTree(props.branches), [props.branches.join('\0')]);
  return (
    <div className="project-git-branch-directory-tree">
      {Array.from(tree.children.values()).map((node) => (
        <BranchTreeEntry key={node.branch || node.name} node={node} depth={0} {...props} />
      ))}
    </div>
  );
}

export function BranchTreeEntry(props: Parameters<typeof BranchDirectoryTree>[0] & { node: BranchTreeNode; depth: number }) {
  if (props.node.children.size > 0) {
    return <BranchTreeFolder {...props} />;
  }
  const divergence = props.branchDivergences?.[props.node.branch];
  const divergenceText = divergence ? [divergence.ahead ? `↑${divergence.ahead}` : '', divergence.behind ? `↓${divergence.behind}` : ''].filter(Boolean).join(' ') : '';
  const divergenceLabel = divergence
    ? [divergence.ahead ? (props.zh ? `领先 ${divergence.ahead}` : `Ahead ${divergence.ahead}`) : '', divergence.behind ? (props.zh ? `落后 ${divergence.behind}` : `Behind ${divergence.behind}`) : '']
        .filter(Boolean)
        .join(props.zh ? '，' : ', ')
    : '';
  return (
    <button
      type="button"
      className={props.node.branch === (props.selected ?? props.current) ? 'is-current' : ''}
      data-checked-out={props.node.branch === props.current || undefined}
      aria-current={props.selected === props.node.branch ? 'true' : undefined}
      style={{ paddingLeft: `${props.depth * 20 + 25}px` }}
      onClick={() => props.onSelect?.(props.node.branch)}
      onDoubleClick={() => props.onCheckout?.(props.node.branch)}
      onContextMenu={(event) => props.onContextMenu(event, props.node.branch)}
      title={props.onCheckout ? (props.zh ? `双击切换到分支“${props.node.branch}”` : `Double-click to check out '${props.node.branch}'`) : undefined}
    >
      {props.hideBranchIcons ? null : <GitBranch aria-hidden="true" />}
      <span>{props.node.name}</span>
      {props.node.branch === props.current ? (
        <small className="git-checked-out-mark" title={props.zh ? '当前检出分支' : 'Checked out branch'}>
          ✓
        </small>
      ) : null}
      {divergenceText ? (
        <span className="git-tracking-badge" aria-label={divergenceLabel} title={divergenceLabel}>
          {divergenceText}
        </span>
      ) : null}
    </button>
  );
}

export function BranchTreeFolder(props: Parameters<typeof BranchTreeEntry>[0]) {
  const [open, setOpen] = useState(() => (props.node.branch ? props.node.branch === props.current || props.current.startsWith(`${props.node.branch}/`) : true));
  return (
    <details className="project-git-branch-folder" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary style={{ paddingLeft: `${props.depth * 20 + 5}px` }}>
        <CaretRight aria-hidden="true" />
        <span>{props.node.name}</span>
      </summary>
      {Array.from(props.node.children.values()).map((child) => (
        <BranchTreeEntry key={child.branch || child.name} {...props} node={child} depth={props.depth + 1} />
      ))}
    </details>
  );
}

export function buildBranchTree(branches: string[]): BranchTreeNode {
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

export function BranchContextMenu(props: {
  id?: string;
  submenuAnchor?: MenuSubmenuAnchor;
  onAction?: () => void;
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
  const closeMenus = props.onAction ?? props.onClose;
  const [remoteCheckout, setRemoteCheckout] = useState<'checkout' | 'rebase' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const current = props.repository.snapshot.branch;
  const currentLabel = props.repository.snapshot.detached
    ? props.zh
      ? `游离 · ${props.repository.snapshot.headTags[0] ?? props.repository.snapshot.headSha.slice(0, 8)}`
      : `Detached · ${props.repository.snapshot.headTags[0] ?? props.repository.snapshot.headSha.slice(0, 8)}`
    : current;

  const run = (action: ProjectGitAction, label: string) => () => {
    closeMenus();
    void props.onExecute(props.repository, action, label);
  };
  const compare = (mode: 'current' | 'working-tree') => () => {
    closeMenus();
    props.onOpenDiff(props.repository, '', { comparisonRef: props.branch, comparisonMode: mode });
  };
  const remoteLeaf = remoteBranchLeaf(props.branch);
  const checkoutAndRebase = async () => {
    const checkedOut = await props.onExecute(props.repository, { type: 'checkout', branchName: props.branch }, props.zh ? '签出分支' : 'Checkout branch');
    if (checkedOut === 'completed' && !props.repository.snapshot.detached)
      await props.onExecute(props.repository, { type: 'rebase', branchName: current }, props.zh ? `将“${props.branch}”变基到“${current}”` : `Rebase '${props.branch}' onto '${current}'`);
  };
  if (remoteCheckout)
    return (
      <RemoteBranchCheckoutDialog
        repository={props.repository}
        initialRemoteRef={props.branch}
        zh={props.zh}
        busy={props.busy}
        onClose={() => setRemoteCheckout(null)}
        onComplete={closeMenus}
        onExecute={async (repository, action, label) => {
          const outcome = await props.onExecute(repository, action, label);
          if (outcome !== 'completed' || remoteCheckout !== 'rebase') return outcome;
          return props.onExecute(repository, { type: 'rebase', branchName: current }, props.zh ? `变基到“${current}”` : `Rebase onto '${current}'`);
        }}
      />
    );
  if (confirmDelete) {
    return (
      <ModalPortal
        rootClassName="project-git-modal-root"
        backdropClassName="project-git-modal-backdrop"
        onDismiss={() => setConfirmDelete(false)}
        dismissDisabled={props.busy !== null}
        role="alertdialog"
        aria-label={props.zh ? '删除分支' : 'Delete branch'}
      >
        <section className="project-git-branch-delete-dialog" data-modal-surface="alertdialog">
          <header>
            <strong>{props.zh ? `删除“${props.branch}”？` : `Delete '${props.branch}'?`}</strong>
            <small>{props.zh ? '仅删除本地分支；尚未合入的分支会由 Git 拒绝删除。' : 'Only the local branch is deleted. Git refuses unmerged branches.'}</small>
          </header>
          <footer>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)} disabled={props.busy !== null}>
              {props.zh ? '取消' : 'Cancel'}
            </Button>
            <Button
              variant="danger"
              busy={props.busy?.action === 'delete_branch'}
              disabled={props.busy !== null}
              onClick={() => {
                void props.onExecute(props.repository, { type: 'delete_branch', branchName: props.branch }, props.zh ? '删除分支' : 'Delete branch').then((outcome) => {
                  if (outcome === 'completed') closeMenus();
                });
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
    <MenuSurface
      onClose={props.onClose}
      ref={menuRef}
      id={props.id}
      submenuAnchor={props.submenuAnchor}
      className="project-git-branch-context-menu"
      role="menu"
      aria-label={props.zh ? `分支操作：${props.branch}` : `Reference actions: ${props.branch}`}
      style={{ left: props.x, top: props.y }}
    >
      <div className="git-reference-menu-heading" title={props.branch}>
        <GitBranch aria-hidden="true" />
        <strong>{props.branch}</strong>
      </div>
      {props.branch !== current ? (
        <button
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={() => {
            if (props.kind === 'remote') {
              setRemoteCheckout('checkout');
              return;
            }
            closeMenus();
            void props.onExecute(props.repository, { type: 'checkout', branchName: props.branch }, props.zh ? '签出分支' : 'Checkout branch');
          }}
        >
          {props.zh ? '签出' : 'Checkout'}
        </button>
      ) : null}
      {props.kind === 'remote' && !props.repository.snapshot.detached ? (
        <button type="button" role="menuitem" disabled={props.busy !== null} onClick={() => setRemoteCheckout('checkout')}>
          {props.zh ? `从“${props.branch}”新建分支…` : `New Branch from '${props.branch}'…`}
        </button>
      ) : null}
      {props.branch !== current && !props.repository.snapshot.detached ? (
        <button
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={() => {
            if (props.kind === 'remote') {
              setRemoteCheckout('rebase');
              return;
            }
            closeMenus();
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
          <button type="button" role="menuitem" disabled={props.busy !== null} onClick={run({ type: 'merge', branchName: props.branch }, props.zh ? `将“${props.branch}”合并到“${current}”` : `Merge '${props.branch}' into '${current}'`)}>
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
    </MenuSurface>
  );
}

export function StashDialog(props: {
  repository: ProjectGitRepositoryWorkbenchItem;
  zh: boolean;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const [message, setMessage] = useState('');
  const [keepIndex, setKeepIndex] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = submitting || props.busy !== null;
  return (
    <ModalPortal
      rootClassName="project-git-modal-root"
      backdropClassName="project-git-modal-backdrop"
      onDismiss={props.onClose}
      dismissDisabled={locked}
      role="dialog"
      aria-label={props.zh ? `贮藏 ${props.repository.name} 的变更` : `Stash changes in ${props.repository.name}`}
    >
      <section className="project-git-reference-dialog project-git-stash-dialog" data-modal-surface="dialog">
        <main>
          <p className="project-git-stash-introduction">
            {props.zh
              ? '将当前工作区的已跟踪修改和未跟踪文件保存到 Stash，然后恢复为干净状态。不会自动切换分支。'
              : 'Save tracked and untracked changes in the working tree to a Stash, then return to a clean state. This will not switch branches automatically.'}
          </p>
          <label className="project-git-stash-message">
            <span>{props.zh ? '信息：' : 'Message:'}</span>
            <input autoFocus value={message} disabled={locked} placeholder={props.zh ? '可选' : 'Optional'} onChange={(event) => setMessage(event.currentTarget.value)} />
          </label>
          <label className="project-git-stash-keep-index" title={props.zh ? '保留当前已经暂存到索引中的修改' : 'Leave changes already staged in the index intact'}>
            <input type="checkbox" checked={keepIndex} disabled={locked} onChange={(event) => setKeepIndex(event.currentTarget.checked)} />
            <span>{props.zh ? '保留已暂存的变更' : 'Keep staged changes'}</span>
          </label>
        </main>
        <footer>
          <Button variant="secondary" disabled={locked} onClick={props.onClose}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            busy={submitting || props.busy?.action === 'stash'}
            disabled={locked}
            onClick={async () => {
              if (locked) return;
              setSubmitting(true);
              try {
                const outcome = await props.onExecute(props.repository, { type: 'stash', message: message.trim() || undefined, includeUntracked: true, keepIndex }, props.zh ? '贮藏工作区变更' : 'Stash working tree changes');
                if (outcome === 'completed') props.onClose();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {props.zh ? '贮藏' : 'Stash'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

export function PullDialog(props: {
  repository: ProjectGitRepositoryWorkbenchItem;
  zh: boolean;
  busy: BusyState;
  onClose: () => void;
  onExecute: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
}) {
  const initial = defaultPushTarget(props.repository);
  const [remote, setRemote] = useState(initial.remote);
  const [branch, setBranch] = useState(initial.targetBranch);
  const [rebase, setRebase] = useState(false);
  const [commitMerge, setCommitMerge] = useState(true);
  const [includeMergeLog, setIncludeMergeLog] = useState(false);
  const [noFastForward, setNoFastForward] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const locked = submitting || props.busy !== null;
  const branches = props.repository.snapshot.remoteBranches.filter((ref) => ref.startsWith(remote + '/') && !ref.endsWith('/HEAD')).map((ref) => ref.slice(remote.length + 1));
  const optionsId = useId();
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={locked} role="dialog" aria-label={props.zh ? '拉取' : 'Pull'}>
      <section className="project-git-reference-dialog project-git-sync-dialog" data-modal-surface="dialog">
        <header>
          <strong>
            {props.zh ? '拉取' : 'Pull'} · {props.repository.name}
          </strong>
        </header>
        <main>
          <fieldset disabled={locked} className="project-git-sync-fields">
            <label>
              <span>{props.zh ? '从仓库拉取' : 'Pull from remote'}</span>
              <select
                value={remote}
                onChange={(event) => {
                  setRemote(event.currentTarget.value);
                  setBranch(props.repository.snapshot.branch);
                }}
              >
                {props.repository.snapshot.remotes.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <p className="project-git-remote-url">{props.repository.snapshot.remoteDetails?.find((item) => item.name === remote)?.fetchUrl}</p>
            <label>
              <span>{props.zh ? '要拉取的远程分支' : 'Remote branch'}</span>
              <span className="project-git-sync-branch-input">
                <input list={optionsId} value={branch} onChange={(event) => setBranch(event.currentTarget.value)} />
                <datalist id={optionsId}>
                  {branches.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={locked || !remote}
                  onClick={async () => {
                    setSubmitting(true);
                    try {
                      await props.onExecute(props.repository, { type: 'fetch', remote }, props.zh ? '刷新远程分支' : 'Refresh remote branches');
                    } finally {
                      setSubmitting(false);
                    }
                  }}
                >
                  {props.zh ? '刷新' : 'Refresh'}
                </Button>
              </span>
            </label>
            <label>
              <span>{props.zh ? '拉取到本地分支' : 'Local branch'}</span>
              <strong>{props.repository.snapshot.branch}</strong>
            </label>
          </fieldset>
          <fieldset className="project-git-sync-options" disabled={locked}>
            <legend>{props.zh ? '选项' : 'Options'}</legend>
            <label>
              <input type="checkbox" checked={commitMerge} disabled={rebase} onChange={(event) => setCommitMerge(event.currentTarget.checked)} />
              {props.zh ? '立即提交合并的改动' : 'Commit merged changes immediately'}
            </label>
            <label>
              <input type="checkbox" checked={includeMergeLog} disabled={rebase} onChange={(event) => setIncludeMergeLog(event.currentTarget.checked)} />
              {props.zh ? '包括被合并提交的信息内容' : 'Include merged commit messages'}
            </label>
            <label>
              <input type="checkbox" checked={noFastForward} disabled={rebase} onChange={(event) => setNoFastForward(event.currentTarget.checked)} />
              {props.zh ? '无论是否可以快进更新都创建新的提交' : 'Create a merge commit even when fast-forward is possible'}
            </label>
            <label>
              <input type="checkbox" checked={rebase} onChange={(event) => setRebase(event.currentTarget.checked)} />
              {props.zh ? '用变基代替合并（请确保本地提交尚未推送）' : 'Rebase instead of merge (local commits should not have been pushed)'}
            </label>
            {!rebase && !commitMerge ? (
              <small>{props.zh ? '快进更新不会创建合并提交；如需在更新前停下，请同时勾选“创建新的提交”。' : 'Fast-forward updates do not create a merge commit. Also select “Create a merge commit” to stop before committing.'}</small>
            ) : null}
          </fieldset>
        </main>
        <footer>
          <Button variant="secondary" disabled={locked} onClick={props.onClose}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={locked || !remote || !branch.trim() || props.repository.snapshot.detached}
            busy={submitting}
            onClick={async () => {
              if (locked) return;
              setSubmitting(true);
              try {
                const outcome = await props.onExecute(props.repository, { type: 'pull', remote, targetBranch: branch.trim(), strategy: rebase ? 'rebase' : 'merge', commitMerge, includeMergeLog, noFastForward }, props.zh ? '拉取' : 'Pull');
                if (outcome) props.onClose();
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {props.zh ? '拉取' : 'Pull'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

export function PushDialog(props: {
  open: boolean;
  zh: boolean;
  repositories: ProjectGitRepositoryWorkbenchItem[];
  selectedRepository: ProjectGitRepositoryWorkbenchItem | null;
  busy: BusyState;
  results: Array<{ repositoryId: string; repositoryName: string; tone: OperationTone; message: string }>;
  onClose: () => void;
  onPush: (selections: PushSelection[], forceWithLease: boolean, pushTags: boolean) => Promise<void>;
}) {
  const [repositoryId, setRepositoryId] = useState(props.selectedRepository?.id ?? props.repositories[0]?.id ?? '');
  const repository = props.repositories.find((item) => item.id === repositoryId);
  const [selections, setSelections] = useState<PushSelection[]>(() => {
    const current = props.selectedRepository ?? props.repositories[0];
    if (!current || current.snapshot.detached || !current.snapshot.localBranches.includes(current.snapshot.branch) || !current.snapshot.remotes.length) return [];
    return [{ repositoryId: current.id, ...defaultPushTarget(current), sourceBranch: current.snapshot.branch, setUpstream: true }];
  });
  const [remotes, setRemotes] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, { targetBranch: string; setUpstream: boolean }>>({});
  const [forceWithLease, setForceWithLease] = useState(false);
  const [pushTags, setPushTags] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const optionsId = useId();
  const locked = submitting || props.busy !== null;
  if (!props.open || !repository) return null;
  const remote = remotes[repositoryId] ?? defaultPushTarget(repository).remote;
  const branches = repository.snapshot.localBranches;
  const remoteBranches = repository.snapshot.remoteBranches.filter((ref) => ref.startsWith(remote + '/') && !ref.endsWith('/HEAD')).map((ref) => ref.slice(remote.length + 1));
  const branchTarget = (sourceBranch: string) => {
    const configured = targets[JSON.stringify([repositoryId, remote, sourceBranch])];
    const upstream = repository.snapshot.branchUpstreams?.[sourceBranch];
    return configured ?? { targetBranch: upstream?.startsWith(remote + '/') ? upstream.slice(remote.length + 1) : sourceBranch, setUpstream: true };
  };
  const selectionFor = (sourceBranch: string): PushSelection => ({ repositoryId, remote, sourceBranch, ...branchTarget(sourceBranch) });
  const selected = (sourceBranch: string) => selections.some((item) => item.repositoryId === repositoryId && item.sourceBranch === sourceBranch);
  const changeTarget = (sourceBranch: string, update: { targetBranch: string; setUpstream: boolean }) => {
    setTargets((current) => ({ ...current, [JSON.stringify([repositoryId, remote, sourceBranch])]: update }));
    setSelections((current) => current.map((item) => (item.repositoryId === repositoryId && item.sourceBranch === sourceBranch ? { ...item, ...update } : item)));
  };
  const resultMode = props.results.length > 0;
  const allSelected = branches.length > 0 && branches.every(selected);
  const duplicateTarget = selections.some((item, index) =>
    selections.some((other, otherIndex) => index !== otherIndex && item.repositoryId === other.repositoryId && item.remote === other.remote && item.targetBranch.trim() === other.targetBranch.trim()),
  );
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={locked} role="dialog" aria-label={props.zh ? '推送' : 'Push'}>
      <section className="project-git-reference-dialog project-git-sync-dialog" data-modal-surface="dialog">
        <header>
          <strong>{resultMode ? (props.zh ? '推送结果' : 'Push results') : props.zh ? '推送' : 'Push'}</strong>
          <small>{props.zh ? '按仓库选择本地分支及远程目标；切换仓库会保留已勾选项。' : 'Select local branches and remote targets. Selections are retained when switching repositories.'}</small>
        </header>
        <main>
          {resultMode ? (
            <div className="project-git-sync-results">
              {props.results.map((result, index) => (
                <section key={index}>
                  <strong>{result.repositoryName}</strong>
                  <p>{result.tone === 'error' ? <VisibleApplicationError error={result.message} language={props.zh ? 'zh-CN' : 'en'} /> : result.message}</p>
                </section>
              ))}
            </div>
          ) : (
            <>
              <fieldset disabled={locked} className="project-git-sync-fields">
                {props.repositories.length > 1 ? (
                  <label>
                    <span>{props.zh ? '本地仓库' : 'Repository'}</span>
                    <select value={repositoryId} onChange={(event) => setRepositoryId(event.currentTarget.value)}>
                      {props.repositories.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.relativePath === '.' ? item.name : item.relativePath}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label>
                  <span>{props.zh ? '推送到仓库' : 'Push to remote'}</span>
                  <select
                    value={remote}
                    onChange={(event) => {
                      const next = event.currentTarget.value;
                      setRemotes((current) => ({ ...current, [repositoryId]: next }));
                      setSelections((current) =>
                        current.map((item) =>
                          item.repositoryId === repositoryId
                            ? {
                                ...item,
                                remote: next,
                                targetBranch:
                                  targets[JSON.stringify([repositoryId, next, item.sourceBranch])]?.targetBranch ??
                                  (repository.snapshot.branchUpstreams?.[item.sourceBranch]?.startsWith(next + '/') ? repository.snapshot.branchUpstreams[item.sourceBranch]!.slice(next.length + 1) : item.sourceBranch),
                                setUpstream: targets[JSON.stringify([repositoryId, next, item.sourceBranch])]?.setUpstream ?? true,
                              }
                            : item,
                        ),
                      );
                    }}
                  >
                    {repository.snapshot.remotes.map((name) => (
                      <option key={name}>{name}</option>
                    ))}
                  </select>
                </label>
                <p className="project-git-remote-url">{repository.snapshot.remoteDetails?.find((item) => item.name === remote)?.pushUrl}</p>
              </fieldset>
              <fieldset disabled={locked || !remote} className="project-git-sync-options">
                <legend>{props.zh ? '要推送的分支' : 'Branches to push'}</legend>
                <div className="project-git-sync-table-scroll">
                  <table className="project-git-sync-table">
                    <thead>
                      <tr>
                        <th>{props.zh ? '推送' : 'Push'}</th>
                        <th>{props.zh ? '本地分支' : 'Local branch'}</th>
                        <th>{props.zh ? '远程分支' : 'Remote branch'}</th>
                        <th>{props.zh ? '跟踪' : 'Track'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {branches.map((branch) => {
                        const target = branchTarget(branch);
                        return (
                          <tr key={branch}>
                            <td>
                              <input
                                aria-label={(props.zh ? '推送分支 ' : 'Push branch ') + branch}
                                type="checkbox"
                                checked={selected(branch)}
                                onChange={(event) =>
                                  setSelections((current) => (event.currentTarget.checked ? [...current, selectionFor(branch)] : current.filter((item) => item.repositoryId !== repositoryId || item.sourceBranch !== branch)))
                                }
                              />
                            </td>
                            <th scope="row">
                              {branch}
                              {branch === repository.snapshot.branch ? <small>{props.zh ? '当前' : 'Current'}</small> : null}
                            </th>
                            <td>
                              <input
                                aria-label={(props.zh ? '远程目标 ' : 'Remote target ') + branch}
                                list={optionsId}
                                value={target.targetBranch}
                                onChange={(event) => changeTarget(branch, { ...target, targetBranch: event.currentTarget.value })}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={(props.zh ? '设置跟踪 ' : 'Set upstream ') + branch}
                                type="checkbox"
                                checked={target.setUpstream}
                                onChange={(event) => changeTarget(branch, { ...target, setUpstream: event.currentTarget.checked })}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <datalist id={optionsId}>
                  {remoteBranches.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                {!branches.length ? <p>{props.zh ? '当前仓库没有本地分支。' : 'No local branches in this repository.'}</p> : null}
                <label>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={(event) => {
                      const rest = selections.filter((item) => item.repositoryId !== repositoryId);
                      setSelections(event.currentTarget.checked ? [...rest, ...branches.map(selectionFor)] : rest);
                    }}
                  />
                  {props.zh ? '全选当前仓库分支' : 'Select all branches in this repository'}
                </label>
              </fieldset>
              <fieldset disabled={locked} className="project-git-sync-options">
                <label>
                  <input type="checkbox" checked={pushTags} onChange={(event) => setPushTags(event.currentTarget.checked)} />
                  {props.zh ? '推送所有标签' : 'Push all tags'}
                </label>
                <label>
                  <input type="checkbox" checked={forceWithLease} onChange={(event) => setForceWithLease(event.currentTarget.checked)} />
                  {props.zh ? '强制推送（仅当远端未被他人更新）' : 'Force push only if the remote has not changed'}
                </label>
              </fieldset>
              <small>
                {props.zh
                  ? `已选 ${selections.length} 个分支，涉及 ${new Set(selections.map((item) => item.repositoryId)).size} 个仓库`
                  : `${selections.length} branches selected across ${new Set(selections.map((item) => item.repositoryId)).size} repositories`}
              </small>
              {duplicateTarget ? <p role="alert">{props.zh ? '同一仓库的多个本地分支不能推送到同一远程目标，请调整目标分支。' : 'Multiple local branches cannot target the same remote branch. Choose distinct targets.'}</p> : null}
            </>
          )}
        </main>
        <footer>
          <Button variant="secondary" disabled={locked} onClick={props.onClose}>
            {resultMode ? (props.zh ? '关闭' : 'Close') : props.zh ? '取消' : 'Cancel'}
          </Button>
          {!resultMode ? (
            <Button
              variant="primary"
              busy={submitting}
              disabled={locked || !selections.length || duplicateTarget || selections.some((item) => !item.remote || !item.targetBranch.trim())}
              onClick={async () => {
                if (locked) return;
                setSubmitting(true);
                try {
                  await props.onPush(
                    selections.map((item) => ({ ...item, targetBranch: item.targetBranch.trim() })),
                    forceWithLease,
                    pushTags,
                  );
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              {props.zh ? '推送' : 'Push'}
            </Button>
          ) : null}
        </footer>
      </section>
    </ModalPortal>
  );
}

export function defaultPushTarget(repository: ProjectGitRepositoryWorkbenchItem): { remote: string; targetBranch: string } {
  const upstream = repository.snapshot.upstream;
  const remote = repository.snapshot.remotes.find((name) => upstream?.startsWith(`${name}/`)) ?? repository.snapshot.remotes.find((name) => name === 'origin') ?? repository.snapshot.remotes[0] ?? '';
  return { remote, targetBranch: upstream?.startsWith(`${remote}/`) ? upstream.slice(remote.length + 1) : repository.snapshot.branch };
}

/** 合并前明确展示来源与目标，命令执行沿用统一的冲突处理。 */
export function MergeBranchDialog(props: {
  repository: ProjectGitRepositoryWorkbenchItem;
  zh: boolean;
  busy: BusyState;
  onClose(): void;
  onExecute(repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string): Promise<ExecutionOutcome>;
}) {
  const branches = [...props.repository.snapshot.localBranches, ...props.repository.snapshot.remoteBranches].filter((branch) => branch !== props.repository.snapshot.branch);
  const [branch, setBranch] = useState(branches[0] ?? '');
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" role="dialog" aria-label={props.zh ? '合并分支' : 'Merge branch'} onDismiss={props.onClose} dismissDisabled={props.busy !== null}>
      <section className="project-git-reference-dialog">
        <header>
          <strong>{props.zh ? '合并分支' : 'Merge branch'}</strong>
          <small>
            {props.repository.name} · {props.zh ? '合入' : 'Into'} {props.repository.snapshot.branch}
          </small>
        </header>
        <main>
          <label>
            <span>{props.zh ? '来源分支' : 'Source branch'}</span>
            <ZeusSelect
              ariaLabel={props.zh ? '来源分支' : 'Source branch'}
              value={branch}
              onChange={setBranch}
              options={branches.map((ref) => ({ value: ref, label: ref }))}
              disabled={props.busy !== null}
              size="regular"
              searchable
              searchPlaceholder={props.zh ? '搜索分支' : 'Search branches'}
              emptyLabel={props.zh ? '没有匹配的分支' : 'No matching branches'}
            />
          </label>
          {!branches.length ? <p>{props.zh ? '没有其他可合并的分支。' : 'No other branches to merge.'}</p> : null}
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={!branch || props.busy !== null}
            busy={props.busy?.action === 'merge'}
            onClick={async () => {
              const result = await props.onExecute(props.repository, { type: 'merge', branchName: branch }, props.zh ? '合并分支' : 'Merge branch');
              if (result) props.onClose();
            }}
          >
            {props.zh ? '合并' : 'Merge'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
