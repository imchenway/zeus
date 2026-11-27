import { useWindowDocument } from '../ui/windowDocument.js';
import { branchSwitchRepositories, executeRepositoryBatch, intersectRepositoryValues, repositoryLocalBranches } from './repositoryBranchGroups.js';
import './gitWorkspace.css';
import { createProjectGitMergeAction } from './projectGitMergeAction.js';
import { repositoryColor } from './repositoryColor.js';
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { MenuSurface, type MenuSubmenuAnchor } from '../ui/MenuSurface.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useMotionPresence } from '../ui/useMotionPresence.js';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import type { ProjectGitAction, ProjectGitRepositoryWorkbenchItem } from '../apiClient.js';
import type { ProjectGitBranchRepository } from '@zeus/git-core';
import type { BusyState, BranchKind, ExecutionOutcome, ProjectGitUpdateStrategy } from './gitWorkbenchTypes.js';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { GitMergeIcon as GitMerge } from '@phosphor-icons/react/dist/csr/GitMerge';
import { MagnifyingGlassIcon as MagnifyingGlass } from '@phosphor-icons/react/dist/csr/MagnifyingGlass';
import { StackIcon as Stack } from '@phosphor-icons/react/dist/csr/Stack';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { Form } from '../ui/Form.js';

interface BranchTreeNode {
  name: string;
  branch: string;
  children: Map<string, BranchTreeNode>;
}

/** 直接选择的分支由类型与短引用共同确定。 */
interface SelectedBranchSource {
  sourceKind: BranchKind;
  sourceRef: string;
}

/** 表单与来源模式直接选择引用，检出模式打开分支操作。 */
type BranchSelectionMode = 'checkout' | 'source' | 'pick';

/** 分支树的叶节点保留完整 Git 引用和引用类型。 */
interface BranchReference {
  ref: string;
  kind: BranchKind | 'tag' | 'revision';
}

/** 级联菜单锚定引用行，仓库为空时操作整个共同分支范围。 */
type ReferenceActionMenu = MenuSubmenuAnchor & { reference: string } & ({ repository: ProjectGitBranchRepository; kind: BranchReference['kind'] } | { repository: null; kind: BranchKind });

/** 开合状态按仓库、引用类型和目录路径保存。 */
interface BranchDisclosureState {
  expanded: ReadonlyMap<string, boolean>;
  setExpanded: (id: string, open: boolean, group: HTMLElement | null) => void;
}

/** Git 工作区与会话入口共用仓库、分支和动作的级联菜单。 */
export function BranchSwitcher(props: {
  zh: boolean;
  /** 按仓库、分支、操作逐级展开，供源码与 Git 工作区共用。 */
  cascadeRepositories?: boolean;
  /** 会话只提供签出或来源选择，不显示工作区的提交、合并等动作。 */
  referenceSelection?: {
    mode: BranchSelectionMode;
    selectedSource?: (repository: ProjectGitBranchRepository) => SelectedBranchSource | undefined;
    onSelect: (repositories: ProjectGitBranchRepository[], ref: string, kind: BranchKind) => Promise<boolean>;
  };
  /** 展开时由会话按需读取分支清单。 */
  onOpen?: () => void;
  /** 冷读和失败反馈显示在列表位置。 */
  menuStatus?: ReactNode;
  /** 与搜索同排的会话刷新操作。 */
  searchAction?: ReactNode;
  /** 工作树配置保留在同一菜单内。 */
  footer?: ReactNode;
  /** 会话加载、发送或 Git 操作期间禁用入口及选择。 */
  disabled?: boolean;
  /** 表单中的选择器占满字段宽度。 */
  field?: boolean;
  /** 字段名称用于区分不同仓库和分支用途。 */
  ariaLabel?: string;
  /** 关联表单已展示的选择说明。 */
  ariaDescribedBy?: string;
  /** 替换表单原控件时保留初始焦点。 */
  autoFocus?: boolean;
  /** 会话可显示多仓状态或尚未创建的工作树来源。 */
  triggerLabel?: string;
  /** 混合分支逐项收缩，使长分支名不会盖住其他来源。 */
  triggerRefs?: readonly string[];
  /** 混合来源的标题可在窄布局隐藏。 */
  triggerPrefix?: string;
  /** 已选来源的类型在收起状态下仍可辨认。 */
  triggerKind?: BranchKind;
  /** 新建分支弹窗关闭后恢复入口焦点。 */
  triggerRef?: RefObject<HTMLButtonElement | null>;
  repositories: ProjectGitBranchRepository[];
  selectedRepository: ProjectGitBranchRepository | null;
  busy: BusyState;
  onSelectRepository: (repositoryId: string) => void;
  /** 来源模式可回到全部仓库的编辑范围。 */
  onSelectAllRepositories?: () => void;
  onExecute?: (repository: ProjectGitRepositoryWorkbenchItem, action: ProjectGitAction, label: string) => Promise<ExecutionOutcome>;
  onOpenDiff?: (repository: ProjectGitRepositoryWorkbenchItem, filePath: string, options?: { comparisonRef?: string; comparisonMode?: 'current' | 'working-tree' }) => void;
  onOpenUpdate?: () => void;
  onOpenCommit?: () => void;
  onOpenPush?: () => void;
  onOpenNewBranch?: (baseRef?: string, repositoryId?: string) => void;
  onOpenRevision?: () => void;
}) {
  /** 分支菜单跟随所在窗口的尺寸、焦点和键盘事件。 */
  const document = useWindowDocument();
  const window = document.defaultView!;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [repositoryMenu, setRepositoryMenu] = useState<{ anchor: HTMLButtonElement; repository: ProjectGitBranchRepository } | null>(null);
  const repositoryMenuRef = useRef(repositoryMenu);
  repositoryMenuRef.current = repositoryMenu;
  const repositoryPopoverRef = useRef<HTMLDivElement>(null);
  const repositorySubmenuId = useId();
  const repositoryRowId = useId();
  const [referenceMenu, setReferenceMenu] = useState<ReferenceActionMenu | null>(null);
  const referenceMenuRef = useRef(referenceMenu);
  referenceMenuRef.current = referenceMenu;
  const menuTreeRef = useRef<HTMLDivElement>(null);
  const submenuId = useId();
  /** 搜索的临时开合状态不覆盖正常浏览状态。 */
  const [expandedGroups, setExpandedGroups] = useState(() => new Map<string, boolean>());
  const [searchExpandedGroups, setSearchExpandedGroups] = useState(() => new Map<string, boolean>());
  /** 内部引用用于普通 Git 入口，外部引用用于会话弹窗的焦点恢复。 */
  const localTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = props.triggerRef ?? localTriggerRef;
  /** 下拉视觉退出后释放内容，业务开关仍立即生效。 */
  const { ref: popoverRef, present: popoverPresent } = useMotionPresence<HTMLDivElement>(open);
  const searchRef = useRef<HTMLInputElement>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  /** 收起分组时关闭依附在其内部引用上的操作菜单。 */
  const disclosure: BranchDisclosureState = {
    expanded: normalizedQuery ? searchExpandedGroups : expandedGroups,
    setExpanded: (id, expanded, group) => {
      const updateGroups = normalizedQuery ? setSearchExpandedGroups : setExpandedGroups;
      updateGroups((current) => new Map(current).set(id, expanded));
      if (!expanded && group?.contains(referenceMenuRef.current?.row ?? null)) setReferenceMenu(null);
    },
  };
  const triggerLabel = props.triggerLabel ?? (props.selectedRepository ? currentRepositoryRefLabel(props.selectedRepository, props.zh) : props.zh ? '选择分支' : 'Select branch');
  /** 本地与远程使用明确文字，分支名过长时类型仍显示。 */
  const triggerKindLabel = props.triggerKind ? branchKindLabel(props.triggerKind, props.zh) : undefined;
  /** 只有完整工作台快照可打开文件比较与引用写操作菜单。 */
  const operationRepository = referenceMenu?.repository && isWorkbenchRepository(referenceMenu.repository) ? referenceMenu.repository : null;
  /** 状态反馈和搜索框轮流取得弹层焦点。 */
  const menuHasStatus = Boolean(props.menuStatus);
  /** 工作树在主菜单内切换来源范围。 */
  const sourceMode = props.referenceSelection?.mode === 'source';
  /** 仓库列表、搜索结果和空状态共用同一个匹配规则。 */
  const matchingRepositories = normalizedQuery
    ? props.repositories.filter((repository) => `${repository.name}/${repository.relativePath}`.toLocaleLowerCase().includes(normalizedQuery) || repositoryHasMatchingReference(repository, normalizedQuery))
    : props.repositories;
  /** 全部仓库范围显示共同分支，选定单仓后显示该仓引用。 */
  const visibleRepositories = normalizedQuery ? matchingRepositories : props.selectedRepository ? [props.selectedRepository] : sourceMode ? [] : props.repositories.slice(0, 1);
  /** Git 的签出范围区分登记的子模块与普通嵌套仓库。 */
  const checkoutRepositories = useMemo(() => branchSwitchRepositories(props.repositories), [props.repositories]);
  /** 批量签出按父子关系收敛范围；工作树来源仍保留逐仓选择。 */
  const branchRepositories = sourceMode ? props.repositories : checkoutRepositories;
  /** 菜单展开后才求分支交集，普通签出只需要本地分支。 */
  const commonBranches = useMemo(() => {
    if (!popoverPresent || props.repositories.length < 2) return [];
    return [
      ...intersectRepositoryValues(branchRepositories, repositoryLocalBranches).map((ref) => ({ ref, kind: 'local' as const })),
      ...(sourceMode
        ? intersectRepositoryValues(props.repositories, (repository) => (repository.snapshot.remoteBranches ?? []).filter((ref) => ref.includes('/') && !ref.endsWith('/HEAD'))).map((ref) => ({ ref, kind: 'remote' as const }))
        : []),
    ];
  }, [popoverPresent, props.repositories, sourceMode, branchRepositories]);

  /** 来源模式下，共同分支只用于全部仓库或搜索结果。 */
  const showCommonBranches = !sourceMode || !props.selectedRepository || Boolean(normalizedQuery);
  /** 范围或分支刷新后，关闭已从列表消失的共同分支菜单。 */
  if (referenceMenu?.repository === null && (!showCommonBranches || !commonBranches.some(({ ref, kind }) => ref === referenceMenu.reference && kind === referenceMenu.kind))) {
    setReferenceMenu(null);
  }

  const closeMenus = () => {
    setReferenceMenu(null);
    setRepositoryMenu(null);
    setOpen(false);
  };

  // 定位与首帧一起完成，展开过程中只改变视觉状态。
  useLayoutEffect(() => {
    if (!open) return;
    /** 读失败或重新确认仓库时，任何基于旧列表的级联操作失效。 */
    if (menuHasStatus) {
      setReferenceMenu(null);
      setRepositoryMenu(null);
    }
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
      if (referenceMenuRef.current || repositoryMenuRef.current || menuTreeRef.current?.closest('[inert]')) return;
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
    /** 重新读取保留仍在菜单内的焦点，例如正在刷新的按钮。 */
    if (!menuTreeRef.current?.contains(document.activeElement) || document.activeElement === popoverRef.current) {
      (menuHasStatus ? popoverRef.current : (searchRef.current ?? popoverRef.current))?.focus({ preventScroll: true });
    }
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open, menuHasStatus]);

  const matches = (value: string): boolean => !normalizedQuery || value.toLocaleLowerCase().includes(normalizedQuery);
  const runAction = (action: () => void) => () => {
    closeMenus();
    action();
  };
  /** 单仓来源选择只编辑草稿，点击后直接返回输入框。 */
  const openReferenceMenu = (event: ReactMouseEvent<HTMLButtonElement>, repository: ProjectGitBranchRepository, ref: string, kind: BranchKind | 'tag' | 'revision') => {
    if (props.referenceSelection && props.referenceSelection.mode !== 'checkout' && (kind === 'local' || kind === 'remote')) {
      if (props.disabled || props.busy) return;
      return props.referenceSelection.onSelect([repository], ref, kind).then((selected) => {
        if (selected) {
          closeMenus();
          triggerRef.current?.focus();
        }
      });
    }
    const parent = event.currentTarget.closest<HTMLElement>('.project-git-branch-popover');
    if (!parent) return;
    if (!props.cascadeRepositories) props.onSelectRepository(repository.id);
    if (parent === popoverRef.current) setRepositoryMenu(null);
    setReferenceMenu({ row: event.currentTarget, parent, repository, reference: ref, kind });
  };
  const quickActions = [
    { id: 'update', label: props.zh ? '更新项目…' : 'Update Project…', run: props.onOpenUpdate },
    { id: 'commit', label: props.zh ? '提交…' : 'Commit…', run: props.onOpenCommit },
    { id: 'push', label: props.zh ? '推送…' : 'Push…', run: props.onOpenPush },
    { id: 'new-branch', label: props.zh ? '新建分支…' : 'New Branch…', run: props.onOpenNewBranch },
    { id: 'revision', label: props.zh ? '切换到标签或提交…' : 'Switch to a tag or commit…', run: props.onOpenRevision },
  ].filter((action) => action.run && matches(action.label));

  /** 共同分支行只打开或关闭操作菜单，具体操作由用户在菜单里选择。 */
  function renderCommonBranch({ ref: branch, kind }: { ref: string; kind: BranchKind }, label: string, anchorId: string) {
    /** 高亮当前菜单的触发行，完整引用用于区分同名的本地和远程分支。 */
    const active = referenceMenu?.repository === null && referenceMenu.reference === branch && referenceMenu.kind === kind;
    return (
      <Button
        unstyled
        id={anchorId}
        type="button"
        aria-haspopup="menu"
        aria-expanded={active}
        aria-controls={active ? submenuId : undefined}
        data-icon-tooltip={branch}
        aria-label={branch}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' || active) return;
          event.preventDefault();
          event.currentTarget.click();
        }}
        onClick={(event) => {
          const parent = popoverRef.current;
          if (!parent) return;
          setRepositoryMenu(null);
          setReferenceMenu(active ? null : { row: event.currentTarget, parent, repository: null, reference: branch, kind });
        }}
      >
        <GitBranch aria-hidden="true" />
        <span>{label}</span>
        <CaretRight aria-hidden="true" />
      </Button>
    );
  }

  /** 共同分支菜单把完整引用交给原有的批量来源、签出或合入操作。 */
  function renderCommonBranchActions(branch: string, kind: BranchKind) {
    return (
      <>
        <Button
          unstyled
          type="button"
          role="menuitem"
          disabled={
            props.disabled ||
            props.busy !== null ||
            (!sourceMode && branchRepositories.some((repository) => (repository.snapshot.detached || repository.snapshot.branch !== branch) && repository.snapshot.checkedOutBranches?.includes(branch)))
          }
          onClick={async () => {
            if (props.referenceSelection) {
              if (await props.referenceSelection.onSelect(props.repositories, branch, kind)) {
                closeMenus();
                triggerRef.current?.focus();
              }
              return;
            }
            const execute = props.onExecute;
            if (!execute) return;
            await executeRepositoryBatch(branchRepositories.filter(isWorkbenchRepository), (repository) =>
              execute(repository, { type: 'checkout', branchName: branch }, props.zh ? `在全部仓库签出“${branch}”` : `Checkout '${branch}' in all repositories`),
            );
            closeMenus();
          }}
        >
          {sourceMode ? (props.zh ? '设为来源分支' : 'Set as source branch') : props.zh ? `在全部 ${props.repositories.length} 个仓库签出` : `Checkout in all ${props.repositories.length} repositories`}
        </Button>
        {!props.referenceSelection && props.onExecute ? (
          <Button
            unstyled
            type="button"
            role="menuitem"
            disabled={props.disabled || props.busy !== null}
            onClick={async () => {
              const execute = props.onExecute!;
              await executeRepositoryBatch(
                props.repositories.filter(isWorkbenchRepository).filter((repository) => repository.snapshot.branch !== branch),
                (repository) => execute(repository, createProjectGitMergeAction(repository, branch), props.zh ? `将“${branch}”合入当前分支` : `Merge '${branch}' into current branch`),
              );
              closeMenus();
            }}
          >
            {props.zh ? '合入各仓当前分支' : 'Merge into each current branch'}
          </Button>
        ) : null}
      </>
    );
  }

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
        tabIndex={-1}
        aria-label={props.zh ? '分支与 Git 操作' : 'Branches and Git actions'}
        style={position}
      >
        {!menuHasStatus || props.searchAction ? (
          <div className="project-git-branch-search-row" data-with-action={props.searchAction ? 'true' : undefined}>
            <label className="project-git-branch-search">
              <MagnifyingGlass aria-hidden="true" />
              <input
                ref={searchRef}
                type="search"
                disabled={menuHasStatus}
                value={query}
                onChange={(event) => {
                  setReferenceMenu(null);
                  setRepositoryMenu(null);
                  setSearchExpandedGroups(new Map());
                  setQuery(event.currentTarget.value);
                }}
                aria-label={props.referenceSelection ? (props.zh ? '搜索分支和仓库' : 'Search branches and repositories') : props.zh ? '搜索分支、操作和仓库' : 'Search branches, actions and repositories'}
                placeholder={props.referenceSelection ? (props.zh ? '搜索分支和仓库' : 'Search branches and repositories') : props.zh ? '搜索分支、操作和仓库' : 'Search branches, actions and repositories'}
              />
            </label>
            {props.searchAction}
          </div>
        ) : null}
        {props.menuStatus}
        {!menuHasStatus ? (
          <div className="project-git-branch-popover-scroll">
            {quickActions.length > 0 ? (
              <section className="project-git-branch-actions" aria-label={props.zh ? 'Git 操作' : 'Git actions'}>
                {quickActions.map((action) => (
                  <Button unstyled key={action.id} type="button" onClick={runAction(() => action.run?.())} disabled={props.disabled || props.busy !== null}>
                    {action.label}
                  </Button>
                ))}
              </section>
            ) : null}
            {props.repositories.length > 0 && (props.cascadeRepositories || props.repositories.length > 1) ? (
              <section className="git-branch-repositories" aria-label={props.zh ? '仓库' : 'Repositories'}>
                {props.onSelectAllRepositories && !normalizedQuery ? (
                  <Button
                    unstyled
                    type="button"
                    className={props.selectedRepository ? '' : 'is-current'}
                    aria-pressed={!props.selectedRepository}
                    disabled={props.disabled || props.busy !== null}
                    onClick={() => {
                      setReferenceMenu(null);
                      props.onSelectAllRepositories?.();
                    }}
                  >
                    <Stack aria-hidden="true" />
                    <span>{props.zh ? '全部仓库' : 'All repositories'}</span>
                    <small>{props.zh ? `${props.repositories.length} 个仓库` : `${props.repositories.length} repositories`}</small>
                    <CaretRight aria-hidden="true" />
                  </Button>
                ) : null}
                {matchingRepositories.map((repository) => {
                  /** 来源行显示草稿分支，实际 HEAD 由仓库详情说明。 */
                  const rowReference = sourceMode
                    ? (props.referenceSelection?.selectedSource?.(repository)?.sourceRef ?? (repository.snapshot.detached ? (props.zh ? '选择来源' : 'Choose source') : repository.snapshot.branch))
                    : currentRepositoryRefLabel(repository, props.zh);
                  return (
                    <Button
                      unstyled
                      type="button"
                      key={repository.id}
                      id={`${repositoryRowId}-${repository.id}`}
                      className={(props.cascadeRepositories ? repositoryMenu?.repository.id === repository.id : repository.id === props.selectedRepository?.id) ? 'is-current' : ''}
                      aria-pressed={sourceMode ? repository.id === props.selectedRepository?.id : undefined}
                      disabled={sourceMode && (props.disabled || props.busy !== null)}
                      aria-haspopup={props.cascadeRepositories ? 'menu' : undefined}
                      aria-expanded={props.cascadeRepositories ? repositoryMenu?.repository.id === repository.id : undefined}
                      aria-controls={repositoryMenu?.repository.id === repository.id ? repositorySubmenuId : undefined}
                      onKeyDown={(event) => {
                        if (!props.cascadeRepositories || event.key !== 'ArrowRight') return;
                        event.preventDefault();
                        event.currentTarget.click();
                      }}
                      onClick={(event) => {
                        setReferenceMenu(null);
                        if (props.cascadeRepositories) {
                          setRepositoryMenu({ anchor: event.currentTarget, repository });
                          if (props.referenceSelection) return props.onSelectRepository(repository.id);
                        } else {
                          props.onSelectRepository(repository.id);
                          setQuery('');
                        }
                      }}
                      data-icon-tooltip={sourceMode ? `${repository.relativePath} · ${rowReference}` : repository.relativePath}
                    >
                      <span className="git-repository-dot" style={{ backgroundColor: repositoryColor(repository.id) }} />
                      <span>{repository.name}</span>
                      <small>{rowReference}</small>
                      <CaretRight aria-hidden="true" />
                    </Button>
                  );
                })}
              </section>
            ) : null}
            {visibleRepositories.map((repository) => (
              <RepositoryBranchGroups
                key={repository.id}
                zh={props.zh}
                repository={repository}
                selectionMode={props.referenceSelection?.mode}
                selectedSource={props.referenceSelection?.selectedSource?.(repository)}
                showRepository={props.cascadeRepositories || (sourceMode && (props.repositories.length > 1 || repository.snapshot.detached))}
                submodule={sourceMode && !checkoutRepositories.includes(repository)}
                scope={`main:${repository.id}`}
                disclosure={disclosure}
                query={`${repository.name}/${repository.relativePath}`.toLocaleLowerCase().includes(normalizedQuery) ? '' : normalizedQuery}
                onOpenReferenceMenu={openReferenceMenu}
                activeAnchorId={referenceMenu?.row.id}
                submenuId={submenuId}
              />
            ))}
            {showCommonBranches && commonBranches.some((branch) => matches(branch.ref)) ? (
              <BranchDisclosure
                id="common"
                label={sourceMode ? (props.zh ? '共同来源分支' : 'Common source branches') : props.zh ? '共同本地分支' : 'Common local branches'}
                defaultOpen={sourceMode || Boolean(normalizedQuery)}
                disclosure={disclosure}
              >
                <ReferenceGroups
                  groups={(['local', 'remote'] as const).map((kind) => ({
                    id: kind,
                    label: branchKindLabel(kind, props.zh),
                    values: commonBranches.filter((branch) => branch.kind === kind && matches(branch.ref)),
                  }))}
                  scope="common"
                  disclosure={disclosure}
                  searching={Boolean(normalizedQuery)}
                  expandRemotes={sourceMode}
                  renderItem={renderCommonBranch}
                />
              </BranchDisclosure>
            ) : null}
            {quickActions.length === 0 && matchingRepositories.length === 0 ? (
              <p className="project-git-branch-empty">
                {!props.repositories.length && props.referenceSelection
                  ? props.zh
                    ? '项目中没有 Git 仓库。'
                    : 'This project has no Git repositories.'
                  : props.referenceSelection
                    ? props.zh
                      ? '没有匹配的分支或仓库。'
                      : 'No matching branches or repositories.'
                    : props.zh
                      ? '没有匹配的分支、标签或操作。可使用“签出标签或 Revision”解析完整引用。'
                      : 'No matching branch, tag, or action. Use Checkout Tag or Revision to resolve an exact ref.'}
              </p>
            ) : null}
            {props.footer}
          </div>
        ) : null}
      </div>
      <MotionPresence>
        {open && !menuHasStatus && repositoryMenu && popoverRef.current ? (
          <MenuSurface
            key={repositoryMenu.repository.id}
            ref={repositoryPopoverRef}
            id={repositorySubmenuId}
            className="project-git-branch-popover git-repository-branch-submenu"
            aria-label={props.zh ? `仓库分支：${repositoryMenu.repository.name}` : `Repository branches: ${repositoryMenu.repository.name}`}
            submenuAnchor={{ row: repositoryMenu.anchor, parent: popoverRef.current }}
            onClose={() => {
              setReferenceMenu(null);
              setRepositoryMenu(null);
            }}
          >
            <div className="project-git-branch-popover-scroll">
              <section className="project-git-branch-actions">
                {props.onOpenNewBranch ? (
                  <Button
                    unstyled
                    type="button"
                    role="menuitem"
                    disabled={props.disabled || props.busy !== null}
                    onClick={runAction(() => {
                      props.onSelectRepository(repositoryMenu.repository.id);
                      props.onOpenNewBranch?.(undefined, repositoryMenu.repository.id);
                    })}
                  >
                    {props.zh ? '新建分支…' : 'New Branch…'}
                  </Button>
                ) : null}
                {props.onOpenRevision ? (
                  <Button
                    unstyled
                    type="button"
                    role="menuitem"
                    disabled={props.disabled || props.busy !== null}
                    onClick={runAction(() => {
                      props.onSelectRepository(repositoryMenu.repository.id);
                      props.onOpenRevision?.();
                    })}
                  >
                    {props.zh ? '切换到标签或提交…' : 'Switch to a tag or commit…'}
                  </Button>
                ) : null}
              </section>
              <RepositoryBranchGroups
                zh={props.zh}
                repository={repositoryMenu.repository}
                selectionMode={props.referenceSelection?.mode}
                selectedSource={props.referenceSelection?.selectedSource?.(repositoryMenu.repository)}
                showRepository
                scope={`submenu:${repositoryMenu.repository.id}`}
                disclosure={disclosure}
                query={`${repositoryMenu.repository.name}/${repositoryMenu.repository.relativePath}`.toLocaleLowerCase().includes(normalizedQuery) ? '' : normalizedQuery}
                onOpenReferenceMenu={openReferenceMenu}
                activeAnchorId={referenceMenu?.row.id}
                submenuId={submenuId}
              />
            </div>
          </MenuSurface>
        ) : null}
      </MotionPresence>
      <MotionPresence>
        {open && !menuHasStatus && referenceMenu && popoverRef.current ? (
          referenceMenu.repository === null || (props.referenceSelection?.mode === 'checkout' && referenceMenu.kind === 'local') ? (
            <MenuSurface
              key={referenceMenu.row.id}
              id={submenuId}
              className="project-git-branch-context-menu"
              submenuAnchor={referenceMenu}
              toggleAnchor={referenceMenu.repository === null ? referenceMenu.row : undefined}
              onClose={() => setReferenceMenu(null)}
              aria-label={props.zh ? `分支操作：${referenceMenu.reference}` : `Branch actions: ${referenceMenu.reference}`}
            >
              {!sourceMode ? (
                <div className="git-reference-menu-heading" data-icon-tooltip={referenceMenu.reference}>
                  <GitBranch aria-hidden="true" />
                  <strong>{referenceMenu.reference}</strong>
                </div>
              ) : null}
              {referenceMenu.repository === null ? (
                renderCommonBranchActions(referenceMenu.reference, referenceMenu.kind)
              ) : (
                <Button
                  unstyled
                  type="button"
                  role="menuitem"
                  disabled={
                    props.disabled ||
                    props.busy !== null ||
                    ((referenceMenu.repository.snapshot.detached || referenceMenu.repository.snapshot.branch !== referenceMenu.reference) && referenceMenu.repository.snapshot.checkedOutBranches?.includes(referenceMenu.reference))
                  }
                  onClick={async () => {
                    if (await props.referenceSelection!.onSelect([referenceMenu.repository], referenceMenu.reference, 'local')) {
                      closeMenus();
                      triggerRef.current?.focus();
                    }
                  }}
                >
                  {props.zh ? '签出' : 'Checkout'}
                </Button>
              )}
            </MenuSurface>
          ) : referenceMenu.kind === 'local' || referenceMenu.kind === 'remote' ? (
            props.onOpenDiff && props.onExecute && operationRepository ? (
              <BranchContextMenu
                key={referenceMenu.row.id}
                id={submenuId}
                x={0}
                y={0}
                submenuAnchor={referenceMenu}
                repository={operationRepository}
                branch={referenceMenu.reference}
                kind={referenceMenu.kind}
                zh={props.zh}
                busy={props.busy}
                onClose={() => setReferenceMenu(null)}
                onAction={closeMenus}
                onExecute={props.onExecute}
                onOpenDiff={props.onOpenDiff}
              />
            ) : null
          ) : props.onExecute && operationRepository ? (
            <RevisionContextMenu
              key={referenceMenu.row.id}
              id={submenuId}
              x={0}
              y={0}
              submenuAnchor={referenceMenu}
              repository={operationRepository}
              revision={referenceMenu.reference}
              zh={props.zh}
              busy={props.busy}
              onClose={() => setReferenceMenu(null)}
              onAction={closeMenus}
              onExecute={props.onExecute}
              onNewBranch={(baseRef) => {
                closeMenus();
                props.onSelectRepository(referenceMenu.repository.id);
                return props.onOpenNewBranch?.(baseRef);
              }}
            />
          ) : null
        ) : null}
      </MotionPresence>
    </div>
  ) : null;

  return (
    <>
      <Button
        unstyled
        ref={triggerRef}
        type="button"
        className={`project-git-branch-trigger${props.field ? ' is-field' : ''}${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={props.ariaLabel ?? (triggerKindLabel ? `${triggerLabel} · ${triggerKindLabel}` : triggerLabel)}
        aria-describedby={props.ariaDescribedBy}
        data-icon-tooltip={!props.triggerLabel && props.selectedRepository ? `${props.selectedRepository.name} · ${triggerLabel}` : triggerLabel}
        disabled={props.disabled || (!props.repositories.length && !props.onOpen)}
        autoFocus={props.autoFocus}
        onClick={() => {
          setQuery('');
          setExpandedGroups(new Map());
          setSearchExpandedGroups(new Map());
          setReferenceMenu(null);
          setRepositoryMenu(null);
          if (!open) props.onOpen?.();
          setOpen(!open);
        }}
      >
        <GitBranch aria-hidden="true" />
        {props.triggerRefs?.length ? (
          <>
            {props.triggerPrefix ? <span className="project-git-branch-trigger-prefix">{props.triggerPrefix}</span> : null}
            {props.triggerRefs.slice(0, 2).map((ref, index) => (
              <Fragment key={ref}>
                {index > 0 ? <small className="project-git-branch-trigger-divider">·</small> : null}
                <span className="project-git-branch-trigger-ref">{ref}</span>
              </Fragment>
            ))}
            {props.triggerRefs.length > 2 ? <small className="project-git-branch-trigger-divider">+{props.triggerRefs.length - 2}</small> : null}
          </>
        ) : (
          <span>{triggerLabel}</span>
        )}
        {triggerKindLabel ? (
          <small className="git-branch-kind" data-kind={props.triggerKind}>
            {triggerKindLabel}
          </small>
        ) : null}
        <CaretDown aria-hidden="true" />
      </Button>
      {typeof document !== 'undefined' && document.body && popover ? createPortal(popover, triggerRef.current?.closest('.macos-ai-app') ?? document.body) : popover}
    </>
  );
}

/** 表单把现有候选交给会话共用的分支树，选中后只更新字段。 */
export function BranchPicker(props: {
  zh: boolean;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  triggerLabel: string;
  value?: { ref: string; kind: BranchKind };
  localBranches?: string[];
  remoteBranches?: string[];
  disabled?: boolean;
  autoFocus?: boolean;
  menuStatus?: ReactNode;
  onChange: (ref: string, kind: BranchKind) => void;
}) {
  /** 多个字段各自拥有分支树的焦点和展开标识。 */
  const repositoryId = useId();
  /** 将字段候选投影为分支树读取的单仓范围。 */
  const repository: ProjectGitBranchRepository = {
    id: repositoryId,
    name: props.ariaLabel ?? props.triggerLabel,
    relativePath: '.',
    snapshot: { branch: '', detached: false, headSha: '', submodules: [], localBranches: props.localBranches, remoteBranches: props.remoteBranches },
  };
  return (
    <BranchSwitcher
      zh={props.zh}
      field
      ariaLabel={props.ariaLabel && props.value ? `${props.ariaLabel} · ${props.value.ref}` : props.ariaLabel}
      ariaDescribedBy={props.ariaDescribedBy}
      triggerLabel={props.triggerLabel}
      repositories={[repository]}
      selectedRepository={repository}
      busy={null}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      menuStatus={props.menuStatus}
      onSelectRepository={() => undefined}
      referenceSelection={{
        mode: 'pick',
        selectedSource: () => (props.value ? { sourceRef: props.value.ref, sourceKind: props.value.kind } : undefined),
        onSelect: async (_repositories, ref, kind) => {
          props.onChange(ref, kind);
          return true;
        },
      }}
    />
  );
}

/** 单仓、逐仓及共同分支共用的引用类型分组。 */
interface BranchReferenceGroup<Item extends BranchReference> {
  id: 'recent' | BranchKind | 'tags';
  label: string;
  values: Item[];
}

/** 分组头使用原生 disclosure 语义，父级收起后子级状态由路径保留。 */
function BranchDisclosure(props: { id: string; label: string; defaultOpen: boolean; disclosure: BranchDisclosureState; children: ReactNode }) {
  const open = props.disclosure.expanded.get(props.id) ?? props.defaultOpen;
  return (
    <details className="git-branch-collapsible-group" open={open}>
      <summary
        title={props.label}
        onClick={(event) => {
          event.preventDefault();
          props.disclosure.setExpanded(props.id, !open, event.currentTarget.parentElement);
        }}
      >
        <CaretRight aria-hidden="true" />
        <span>{props.label}</span>
      </summary>
      {open ? props.children : null}
    </details>
  );
}

/** 单仓与逐仓选择按入口支持的引用类型准备分支树。 */
export function RepositoryBranchGroups(props: {
  zh: boolean;
  showRepository?: boolean;
  /** 由当前父仓的 Git 子模块登记识别。 */
  submodule?: boolean;
  scope: string;
  disclosure: BranchDisclosureState;
  selectionMode?: BranchSelectionMode;
  repository: ProjectGitBranchRepository;
  selectedSource?: SelectedBranchSource;
  query: string;
  activeAnchorId?: string;
  submenuId: string;
  onOpenReferenceMenu: (event: ReactMouseEvent<HTMLButtonElement>, repository: ProjectGitBranchRepository, ref: string, kind: BranchReference['kind']) => void;
}) {
  const { repository, selectionMode } = props;
  const groups: BranchReferenceGroup<BranchReference>[] = [
    { id: 'recent', label: props.zh ? '最近' : 'Recent', values: repository.snapshot.recentRefs ?? [] },
    { id: 'local', label: branchKindLabel('local', props.zh), values: repositoryLocalBranches(repository).map((ref) => ({ ref, kind: 'local' })) },
    { id: 'remote', label: branchKindLabel('remote', props.zh), values: (repository.snapshot.remoteBranches ?? []).map((ref) => ({ ref, kind: 'remote' })) },
    { id: 'tags', label: props.zh ? '标签' : 'Tags', values: (repository.snapshot.tags ?? []).map((ref) => ({ ref, kind: 'tag' })) },
  ];
  for (const group of groups) {
    group.values = group.values.filter(
      (item) =>
        (!props.query || item.ref.toLocaleLowerCase().includes(props.query)) &&
        (!selectionMode || item.kind === 'local' || (item.kind === 'remote' && (selectionMode === 'pick' || (selectionMode === 'source' && item.ref.includes('/') && !item.ref.endsWith('/HEAD'))))),
    );
  }
  if (!groups.some((group) => group.values.length)) return null;

  /** 来源和表单选择直接选中引用，检出入口保留操作菜单。 */
  const directSelection = selectionMode === 'source' || selectionMode === 'pick';
  /** 来源模式把实际 HEAD 放在详情，完整路径随仓库名称提供。 */
  const currentRef = currentRepositoryRefLabel(repository, props.zh, directSelection);
  const isSelected = (item: BranchReference) =>
    directSelection ? props.selectedSource?.sourceKind === item.kind && props.selectedSource.sourceRef === item.ref : item.kind === 'local' && item.ref === repository.snapshot.branch && !repository.snapshot.detached;

  return (
    <section className="project-git-branch-repository">
      {!directSelection || props.showRepository ? (
        <header className={directSelection ? 'project-git-source-repository-head' : undefined}>
          <strong data-icon-tooltip={directSelection ? repository.relativePath : undefined}>{repository.name}</strong>
          <small>{directSelection ? `${props.submodule ? (props.zh ? '子模块 · ' : 'Submodule · ') : ''}${currentRef}` : repository.relativePath === '.' ? currentRef : `${repository.relativePath} · ${currentRef}`}</small>
        </header>
      ) : null}
      <ReferenceGroups
        groups={groups}
        scope={props.scope}
        disclosure={props.disclosure}
        searching={Boolean(props.query)}
        isSelected={isSelected}
        renderItem={(item, label, anchorId) => {
          const selected = isSelected(item);
          const active = props.activeAnchorId === anchorId;
          return (
            <Button
              unstyled
              type="button"
              className={active ? 'is-active' : selected ? 'is-current' : ''}
              id={anchorId}
              data-icon-tooltip={item.ref}
              aria-label={item.ref}
              aria-current={selected ? 'true' : undefined}
              aria-haspopup={directSelection ? undefined : 'menu'}
              aria-expanded={directSelection ? undefined : active}
              aria-controls={active ? props.submenuId : undefined}
              onKeyDown={(event) => {
                if (directSelection || event.key !== 'ArrowRight') return;
                event.preventDefault();
                event.currentTarget.click();
              }}
              onClick={(event) => props.onOpenReferenceMenu(event, repository, item.ref, item.kind)}
            >
              <GitBranch aria-hidden="true" />
              <span>{label}</span>
              {directSelection ? (
                selected ? (
                  <Check aria-hidden="true" />
                ) : null
              ) : (
                <>
                  {selected ? <small>{props.zh ? '当前' : 'Current'}</small> : null}
                  <CaretRight aria-hidden="true" />
                </>
              )}
            </Button>
          );
        }}
      />
    </section>
  );
}

/** 类型层根据入口和引用状态决定默认开合。 */
function ReferenceGroups<Item extends BranchReference>(props: {
  groups: BranchReferenceGroup<Item>[];
  scope: string;
  disclosure: BranchDisclosureState;
  searching: boolean;
  /** 共同来源默认展开远程类型和下一层远程名。 */
  expandRemotes?: boolean;
  isSelected?: (item: Item) => boolean;
  renderItem: (item: Item, label: string, anchorId: string) => ReactNode;
}) {
  return props.groups
    .filter((group) => group.values.length)
    .map((group) => {
      const scope = `${props.scope}:${group.id}`;
      /** 远程名的展开规则只用于远程引用组。 */
      const expandRemotes = group.id === 'remote' && props.expandRemotes === true;
      return (
        <BranchDisclosure
          key={scope}
          id={scope}
          label={group.label}
          defaultOpen={props.searching || group.id === 'local' || group.id === 'recent' || expandRemotes || Boolean(props.isSelected && group.values.some(props.isSelected))}
          disclosure={props.disclosure}
        >
          <ReferenceTree scope={scope} items={group.values} disclosure={props.disclosure} searching={props.searching} expandRootFolders={expandRemotes} isSelected={props.isSelected} renderItem={props.renderItem} />
        </BranchDisclosure>
      );
    });
}

/** Git 引用的斜杠形成目录层级，远程引用先按远程名分组。 */
function ReferenceTree<Item extends BranchReference>(props: {
  scope: string;
  items: Item[];
  prefix?: string;
  disclosure: BranchDisclosureState;
  searching: boolean;
  /** 仅将树根下的远程名默认展开，其下的分支目录按正常规则处理。 */
  expandRootFolders?: boolean;
  isSelected?: (item: Item) => boolean;
  renderItem: (item: Item, label: string, anchorId: string) => ReactNode;
}) {
  const treeId = useId();
  const prefix = props.prefix ?? '';
  const folders = new Map<string, Item[]>();
  const leaves: Item[] = [];
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
      {leaves.map((item, index) => (
        <Fragment key={`${item.kind}:${item.ref}`}>{props.renderItem(item, item.ref.slice(prefix.length), `${treeId}-${index}`)}</Fragment>
      ))}
      {[...folders].map(([folder, items]) => {
        const path = prefix + folder;
        const id = `${props.scope}:${path}`;
        return (
          <BranchDisclosure
            key={id}
            id={id}
            label={folder.slice(0, -1)}
            defaultOpen={props.searching || (!prefix && props.expandRootFolders === true) || Boolean(props.isSelected && items.some(props.isSelected))}
            disclosure={props.disclosure}
          >
            <ReferenceTree {...props} items={items} prefix={path} />
          </BranchDisclosure>
        );
      })}
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
      className="zeus-context-menu project-git-branch-context-menu"
      role="menu"
      aria-label={props.zh ? `引用操作：${props.revision}` : `Reference actions: ${props.revision}`}
      style={{ left: props.x, top: props.y }}
    >
      <div className="git-reference-menu-heading" data-icon-tooltip={props.revision}>
        <GitBranch aria-hidden="true" />
        <strong>{props.revision}</strong>
      </div>
      <Button
        unstyled
        type="button"
        role="menuitem"
        disabled={props.busy !== null}
        onClick={() => {
          closeMenus();
          return props.onExecute(props.repository, { type: 'checkout_revision', revision: props.revision }, props.zh ? `签出“${props.revision}”` : `Checkout '${props.revision}'`);
        }}
      >
        <ArrowRight aria-hidden="true" />
        <span>{props.zh ? '签出（进入游离提交状态）' : 'Checkout (detached HEAD)'}</span>
      </Button>
      <Button unstyled type="button" role="menuitem" disabled={props.busy !== null} onClick={() => props.onNewBranch(props.revision)}>
        <GitBranch aria-hidden="true" />
        <span>{props.zh ? `从“${props.revision}”新建分支…` : `New Branch from '${props.revision}'…`}</span>
      </Button>
    </MenuSurface>
  );
}

/** 更新项目只选择整合策略；执行进度与冲突由共享工作台显示。 */
export function UpdateProjectDialog(props: { projectId: string; zh: boolean; activation: number; busy: BusyState; onClose: () => void; onUpdate: (strategy: ProjectGitUpdateStrategy) => void }) {
  /** 系统窗口、浏览器预览和读屏共用更新标题。 */
  const title = props.zh ? '更新项目' : 'Update Project';
  /** 更新方式按项目保存，取消不写入。 */
  const [strategy, setStrategy] = useState(() => readUpdateStrategy(props.projectId));
  /** 勾选后，后续快捷键直接使用已保存的更新方式。 */
  const [skipDialog, setSkipDialog] = useState(() => readSkipUpdateDialog(props.projectId));
  return (
    <ModalPortal
      systemWindow="git-update"
      windowActivation={props.activation}
      rootClassName="project-git-modal-root"
      backdropClassName="project-git-modal-backdrop"
      onDismiss={props.onClose}
      dismissDisabled={props.busy !== null}
      role="dialog"
      aria-label={title}
    >
      <Form
        className="project-git-update-dialog"
        data-modal-surface="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (props.busy !== null) return;
          window.localStorage.setItem(`zeus.project-git-update-strategy:${props.projectId}`, strategy);
          window.localStorage.setItem(`zeus.project-git-update-skip-dialog:${props.projectId}`, String(skipDialog));
          return props.onUpdate(strategy);
        }}
      >
        <header>
          <strong>{title}</strong>
        </header>
        <main>
          <fieldset className="project-git-update-strategies" aria-label={props.zh ? '更新方式' : 'Update method'} disabled={props.busy !== null}>
            <label>
              <input type="radio" name="project-git-update-strategy" value="merge" checked={strategy === 'merge'} onChange={() => setStrategy('merge')} />
              <span>{props.zh ? '将传入的更改合并到当前分支' : 'Merge incoming changes into the current branch'}</span>
            </label>
            <label>
              <input type="radio" name="project-git-update-strategy" value="rebase" checked={strategy === 'rebase'} onChange={() => setStrategy('rebase')} />
              <span>{props.zh ? '将当前分支变基到传入的更改之上' : 'Rebase the current branch on top of incoming changes'}</span>
            </label>
          </fieldset>
        </main>
        <footer>
          <label className="project-git-update-remember">
            <input type="checkbox" checked={skipDialog} disabled={props.busy !== null} onChange={(event) => setSkipDialog(event.currentTarget.checked)} />
            <span>{props.zh ? '不再显示' : "Don't show again"}</span>
          </label>
          <div className="project-git-update-actions">
            <Button size="compact" variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
              {props.zh ? '取消' : 'Cancel'}
            </Button>
            {/* 共享焦点管理器读取原生 autofocus 属性，并在关闭后恢复原焦点。 */}
            <Button
              type="submit"
              size="compact"
              variant="primary"
              ref={(button) => {
                button?.setAttribute('autofocus', '');
              }}
              disabled={props.busy !== null}
            >
              {props.zh ? '确定' : 'OK'}
            </Button>
          </div>
        </footer>
      </Form>
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
              if (outcome) return props.onClose();
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
            <Button unstyled type="button" role="tab" aria-selected={mode === 'existing'} disabled={existingCandidates.length === 0 || props.busy !== null} onClick={() => setMode('existing')}>
              <ArrowRight aria-hidden="true" />
              <span>{props.zh ? '检出现有' : 'Checkout Existing'}</span>
            </Button>
            <Button unstyled type="button" role="tab" aria-selected={mode === 'new'} disabled={props.busy !== null} onClick={() => setMode('new')}>
              <GitBranch aria-hidden="true" />
              <span>{props.zh ? '检出新分支' : 'Checkout New Branch'}</span>
            </Button>
          </span>
        </header>
        <main>
          <label>
            <span>{props.zh ? '检出远程分支' : 'Remote branch'}</span>
            <BranchPicker
              zh={props.zh}
              ariaLabel={props.zh ? '检出远程分支' : 'Remote branch'}
              triggerLabel={remoteRef}
              value={{ ref: remoteRef, kind: 'remote' }}
              remoteBranches={props.repository.snapshot.remoteBranches}
              onChange={selectRemote}
              disabled={props.busy !== null}
            />
          </label>
          {mode === 'existing' ? (
            <label>
              <span>{props.zh ? '现有本地分支' : 'Existing local branch'}</span>
              <BranchPicker
                zh={props.zh}
                ariaLabel={props.zh ? '现有本地分支' : 'Existing local branch'}
                triggerLabel={existingBranch}
                value={{ ref: existingBranch, kind: 'local' }}
                localBranches={existingCandidates}
                onChange={setExistingBranch}
                autoFocus
                disabled={props.busy !== null}
              />
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
              if (outcome) return props.onClose();
            }}
          >
            {props.zh ? '签出' : 'Checkout'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}

/** 当前引用在完整快照和只读 HEAD 快照中均可显示。 */
export function currentRepositoryRefLabel(repository: ProjectGitBranchRepository, zh: boolean, showHead = false): string {
  if (!repository.snapshot.detached) return showHead ? `${zh ? '当前 HEAD' : 'Current HEAD'} · ${repository.snapshot.branch}` : repository.snapshot.branch;
  return `${zh ? '游离' : 'Detached'}${showHead ? ' HEAD' : ''} · ${repository.snapshot.headTags?.[0] ?? repository.snapshot.headSha.slice(0, 8)}`;
}

export function shortRef(ref: string): string {
  return /^[0-9a-f]{40}$/iu.test(ref) ? ref.slice(0, 8) : ref;
}

/** 搜索只查当前快照中已读取的引用。 */
export function repositoryHasMatchingReference(repository: ProjectGitBranchRepository, query: string): boolean {
  return [...repositoryLocalBranches(repository), ...(repository.snapshot.remoteBranches ?? []), ...(repository.snapshot.tags ?? []), ...(repository.snapshot.recentRefs ?? []).map((item) => item.ref)].some((value) =>
    value.toLocaleLowerCase().includes(query),
  );
}

/** 工作台专属动作要求仓库拥有文件状态快照。 */
function isWorkbenchRepository(repository: ProjectGitBranchRepository): repository is ProjectGitRepositoryWorkbenchItem {
  return 'fileStatuses' in repository.snapshot;
}

/** 引用类型同时用于菜单分组和已选标签。 */
function branchKindLabel(kind: BranchKind, zh: boolean): string {
  return kind === 'local' ? (zh ? '本地' : 'Local') : zh ? '远程' : 'Remote';
}

/** 旧的重置偏好不用于快捷键更新，默认保留当前分支历史。 */
export function readUpdateStrategy(projectId: string): ProjectGitUpdateStrategy {
  /** 仅变基需要显式保留，其余值使用合并。 */
  const value = typeof window === 'undefined' ? null : window.localStorage.getItem(`zeus.project-git-update-strategy:${projectId}`);
  return value === 'rebase' ? 'rebase' : 'merge';
}

/** 仅快捷键使用免提示偏好；分支菜单始终允许重新选择。 */
export function readSkipUpdateDialog(projectId: string): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(`zeus.project-git-update-skip-dialog:${projectId}`) === 'true';
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
    <Button
      unstyled
      type="button"
      className={props.node.branch === (props.selected ?? props.current) ? 'is-current' : ''}
      data-checked-out={props.node.branch === props.current || undefined}
      aria-current={props.selected === props.node.branch ? 'true' : undefined}
      style={{ paddingLeft: `${props.depth * 20 + 25}px` }}
      onClick={() => props.onSelect?.(props.node.branch)}
      onDoubleClick={() => props.onCheckout?.(props.node.branch)}
      onContextMenu={(event) => props.onContextMenu(event, props.node.branch)}
      data-icon-tooltip={props.onCheckout ? (props.zh ? `双击切换到分支“${props.node.branch}”` : `Double-click to check out '${props.node.branch}'`) : undefined}
    >
      {props.hideBranchIcons ? null : <GitBranch aria-hidden="true" />}
      <span>{props.node.name}</span>
      {props.node.branch === props.current ? (
        <small className="git-checked-out-mark" data-icon-tooltip={props.zh ? '当前检出分支' : 'Checked out branch'}>
          ✓
        </small>
      ) : null}
      {divergenceText ? (
        <span className="git-tracking-badge" aria-label={divergenceLabel} data-icon-tooltip={divergenceLabel}>
          {divergenceText}
        </span>
      ) : null}
    </Button>
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
    return props.onExecute(props.repository, action, label);
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
                return props.onExecute(props.repository, { type: 'delete_branch', branchName: props.branch }, props.zh ? '删除分支' : 'Delete branch').then((outcome) => {
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
      className="zeus-context-menu project-git-branch-context-menu"
      role="menu"
      aria-label={props.zh ? `分支操作：${props.branch}` : `Reference actions: ${props.branch}`}
      style={{ left: props.x, top: props.y }}
    >
      <div className="git-reference-menu-heading" data-icon-tooltip={props.branch}>
        <GitBranch aria-hidden="true" />
        <strong>{props.branch}</strong>
      </div>
      {props.branch !== current ? (
        <Button
          unstyled
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={() => {
            if (props.kind === 'remote') {
              setRemoteCheckout('checkout');
              return;
            }
            closeMenus();
            return props.onExecute(props.repository, { type: 'checkout', branchName: props.branch }, props.zh ? '签出分支' : 'Checkout branch');
          }}
        >
          <ArrowRight aria-hidden="true" />
          <span>{props.zh ? '签出' : 'Checkout'}</span>
        </Button>
      ) : null}
      {props.kind === 'remote' && !props.repository.snapshot.detached ? (
        <Button unstyled type="button" role="menuitem" disabled={props.busy !== null} onClick={() => setRemoteCheckout('checkout')}>
          <GitBranch aria-hidden="true" />
          <span>{props.zh ? `从“${props.branch}”新建分支…` : `New Branch from '${props.branch}'…`}</span>
        </Button>
      ) : null}
      {props.branch !== current && !props.repository.snapshot.detached ? (
        <Button
          unstyled
          type="button"
          role="menuitem"
          disabled={props.busy !== null}
          onClick={() => {
            if (props.kind === 'remote') {
              setRemoteCheckout('rebase');
              return;
            }
            closeMenus();
            return checkoutAndRebase();
          }}
        >
          <ArrowsClockwise aria-hidden="true" />
          <span>{props.zh ? `签出并变基到“${currentLabel}”` : `Checkout and Rebase onto '${currentLabel}'`}</span>
        </Button>
      ) : null}
      <hr />
      <Button unstyled type="button" role="menuitem" onClick={compare('current')}>
        <GitDiff aria-hidden="true" />
        <span>{props.zh ? `与“${currentLabel}”比较` : `Compare with '${currentLabel}'`}</span>
      </Button>
      <Button unstyled type="button" role="menuitem" onClick={compare('working-tree')}>
        <GitDiff aria-hidden="true" />
        <span>{props.zh ? '显示与工作区的差异' : 'Show Diff with Working Tree'}</span>
      </Button>
      {props.branch !== current && !props.repository.snapshot.detached ? (
        <>
          <hr />
          <Button unstyled type="button" role="menuitem" disabled={props.busy !== null} onClick={run({ type: 'rebase', branchName: props.branch }, props.zh ? '变基当前分支' : 'Rebase current branch')}>
            <ArrowsClockwise aria-hidden="true" />
            <span>{props.zh ? `将“${current}”变基到“${props.branch}”` : `Rebase '${current}' onto '${props.branch}'`}</span>
          </Button>
          <Button
            unstyled
            type="button"
            role="menuitem"
            disabled={props.busy !== null}
            onClick={run(createProjectGitMergeAction(props.repository, props.branch), props.zh ? `将“${props.branch}”合并到“${current}”` : `Merge '${props.branch}' into '${current}'`)}
          >
            <GitMerge aria-hidden="true" />
            <span>{props.zh ? `将“${props.branch}”合入“${current}”` : `Merge '${props.branch}' into '${current}'`}</span>
          </Button>
        </>
      ) : null}
      {props.kind === 'remote' && !props.repository.snapshot.detached ? (
        <>
          <hr />
          <Button
            unstyled
            type="button"
            role="menuitem"
            disabled={props.busy !== null}
            onClick={run({ type: 'pull', remote: props.branch.split('/')[0], targetBranch: remoteLeaf, strategy: 'rebase' }, props.zh ? '拉取并变基' : 'Pull with rebase')}
          >
            <ArrowDown aria-hidden="true" />
            <span>{props.zh ? `拉取到“${current}”（变基）` : `Pull into '${current}' Using Rebase`}</span>
          </Button>
          <Button
            unstyled
            type="button"
            role="menuitem"
            disabled={props.busy !== null}
            onClick={run({ type: 'pull', remote: props.branch.split('/')[0], targetBranch: remoteLeaf, strategy: 'merge' }, props.zh ? '拉取并合并' : 'Pull with merge')}
          >
            <ArrowDown aria-hidden="true" />
            <span>{props.zh ? `拉取到“${current}”（合并）` : `Pull into '${current}' Using Merge`}</span>
          </Button>
        </>
      ) : null}
      {props.kind === 'local' && props.branch !== current ? (
        <>
          <hr />
          <Button unstyled type="button" role="menuitem" data-danger disabled={props.busy !== null} onClick={() => setConfirmDelete(true)}>
            <Trash aria-hidden="true" />
            <span>{props.zh ? '删除…' : 'Delete…'}</span>
          </Button>
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
          <label className="project-git-stash-keep-index" data-icon-tooltip={props.zh ? '保留当前已经暂存到索引中的修改' : 'Leave changes already staged in the index intact'}>
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
  const selectedBranch = branches.includes(branch) ? branch : '';
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
                <BranchPicker
                  key={remote}
                  zh={props.zh}
                  ariaLabel={props.zh ? '要拉取的远程分支' : 'Remote branch to pull'}
                  value={selectedBranch ? { ref: `${remote}/${selectedBranch}`, kind: 'remote' } : undefined}
                  remoteBranches={branches.map((name) => `${remote}/${name}`)}
                  onChange={(ref) => setBranch(ref.slice(remote.length + 1))}
                  triggerLabel={selectedBranch || (props.zh ? '选择远程分支' : 'Select a remote branch')}
                  disabled={locked || !remote}
                  menuStatus={branches.length ? undefined : props.zh ? '暂无远程分支，请点击刷新' : 'No remote branches. Refresh to fetch them.'}
                />
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
            disabled={locked || !remote || !selectedBranch || props.repository.snapshot.detached}
            busy={submitting}
            onClick={async () => {
              if (locked) return;
              setSubmitting(true);
              try {
                const outcome = await props.onExecute(props.repository, { type: 'pull', remote, targetBranch: selectedBranch, strategy: rebase ? 'rebase' : 'merge', commitMerge, includeMergeLog, noFastForward }, props.zh ? '拉取' : 'Pull');
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

/** 当前检出分支的默认远端与同名目标，供拉取和推送入口共用。 */
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
  /** 候选维持本地优先，排除当前合入目标。 */
  const localBranches = props.repository.snapshot.localBranches.filter((branch) => branch !== props.repository.snapshot.branch);
  const remoteBranches = props.repository.snapshot.remoteBranches.filter((branch) => branch !== props.repository.snapshot.branch);
  /** 分支类型和名称共同确定选中引用。 */
  const [selection, setSelection] = useState<{ ref: string; kind: BranchKind } | undefined>(() => (localBranches[0] ? { ref: localBranches[0], kind: 'local' } : remoteBranches[0] ? { ref: remoteBranches[0], kind: 'remote' } : undefined));
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
            <BranchPicker
              zh={props.zh}
              ariaLabel={props.zh ? '来源分支' : 'Source branch'}
              triggerLabel={selection?.ref ?? (props.zh ? '选择来源分支' : 'Select source branch')}
              value={selection}
              onChange={(ref, kind) => setSelection({ ref, kind })}
              localBranches={localBranches}
              remoteBranches={remoteBranches}
              disabled={props.busy !== null || (!localBranches.length && !remoteBranches.length)}
            />
          </label>
          {!localBranches.length && !remoteBranches.length ? <p>{props.zh ? '没有其他可合并的分支。' : 'No other branches to merge.'}</p> : null}
        </main>
        <footer>
          <Button variant="secondary" onClick={props.onClose} disabled={props.busy !== null}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant="primary"
            disabled={!selection || props.busy !== null}
            busy={props.busy?.action === 'merge'}
            onClick={async () => {
              if (!selection) return;
              /** 完整引用使同名的本地和远程分支仍指向各自提交。 */
              const branch = `refs/${selection.kind === 'local' ? 'heads' : 'remotes'}/${selection.ref}`;
              /** 目标身份取自当前弹窗展示的仓库快照，后台不替换为更新后的分支。 */
              const result = await props.onExecute(props.repository, createProjectGitMergeAction(props.repository, branch), props.zh ? '合并分支' : 'Merge branch');
              if (result) return props.onClose();
            }}
          >
            {props.zh ? '合并' : 'Merge'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
