import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderPlusIcon as FolderPlus } from '@phosphor-icons/react/dist/csr/FolderPlus';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { PushPinIcon as PushPin } from '@phosphor-icons/react/dist/csr/PushPin';
import { PushPinSlashIcon as PushPinSlash } from '@phosphor-icons/react/dist/csr/PushPinSlash';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { SpinnerGapIcon as SpinnerGap } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { CheckSquareIcon as WorkspaceTasksIcon } from '@phosphor-icons/react/dist/csr/CheckSquare';
import { GitBranchIcon as WorkspaceGitIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { CodeIcon as WorkspaceSourceIcon } from '@phosphor-icons/react/dist/csr/Code';
import { GraphIcon as WorkspaceGraphIcon } from '@phosphor-icons/react/dist/csr/Graph';
import { TerminalWindowIcon as WorkspaceCommandsIcon } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { type AutomaticUpdateIndicatorState } from '../../appShellBridge.js';
import { type ConversationTreeRuntimeState, type ProjectConversationGroup, ProjectConversationTree } from '../../session/ProjectConversationTree.js';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import { conversationDisplayTitle } from '../../session/conversationDisplayTitle.js';
import { type AppLanguage } from './workspaceCopy.js';
import { Button } from '../../ui/Button.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { SourceListRow } from '../../ui/SourceListRow.js';
import { useNewItemMotionIds } from '../../ui/useNewItemMotion.js';
import { type AiRuntimeAdapterDescriptor, type AiRuntimeAdapterStatus, type AiRuntimeTerminalEvent, type AppShellSettings, type CodeMapSettings, type ProjectConfig, type ProjectRecord, type RuntimeSettings } from '../../apiClient.js';
import { GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE, type GenericShellCommandRisk } from './workspaceFormatters.js';
import { handleSourceListKeyboardNavigation } from '../graph/GraphCanvas.js';
import { controlBusyProps, defaultProjectNameFromLocalPath, getLanguageCopy, type InlineRecoveryAction, type LocalUiErrorSnapshot, PROJECT_WORKSPACE_ENTRIES, type ProjectCodeWorkspaceMode, type ProjectCreateFormState, type ProjectWorkspaceEntryId, type ProjectWorkspaceSection, type RuntimeConfirmationStatusState, type WorkspaceViewId } from './workspaceSupport.js';
export function ProjectCreateDialog(props: {
  open: boolean;
  form: ProjectCreateFormState;
  busy: boolean;
  directoryBusy: boolean;
  error?: string;
  copy: ReturnType<typeof getLanguageCopy>['sidebar'];
  onNameChange: (name: string) => void;
  onChooseDirectory: () => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.open) return;
    const focusFrame = window.requestAnimationFrame(() => nameInputRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.open]);
  if (!props.open) return null;

  const interactionBusy = props.busy || props.directoryBusy;
  const describedBy = props.error ? 'project-create-folder-help project-create-error' : 'project-create-folder-help';

  function handleProjectCreateKeyDown(event: ReactKeyboardEvent<HTMLFormElement>): void {
    if (event.key === 'Escape' && !interactionBusy) {
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')).filter(
      (element) => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true',
    );
    if (controls.length === 0) return;
    const firstControl = controls[0];
    const lastControl = controls.at(-1);
    if (event.shiftKey && document.activeElement === firstControl) {
      event.preventDefault();
      lastControl?.focus();
    } else if (!event.shiftKey && document.activeElement === lastControl) {
      event.preventDefault();
      firstControl?.focus();
    }
  }

  return (
    <ModalPortal rootClassName="project-create-dialog-portal-root" backdropClassName="project-create-dialog-backdrop" dismissDisabled={interactionBusy} onDismiss={props.onClose}>
      <form
        className="project-create-dialog zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-dialog-title"
        aria-describedby={describedBy}
        onSubmit={props.onSubmit}
        onKeyDown={handleProjectCreateKeyDown}
      >
        <header className="project-create-dialog-header">
          <strong id="project-create-dialog-title">{props.copy.createDialogTitle}</strong>
          <button type="button" className="project-create-dialog-close" aria-label={props.copy.createCancel} onClick={props.onClose} disabled={interactionBusy}>
            <X aria-hidden="true" weight="regular" />
          </button>
        </header>
        <div className="project-create-dialog-body">
          <label className="visually-hidden" htmlFor="project-create-name-input">
            {props.copy.createNameLabel}
          </label>
          <div className="project-create-name-control">
            <span className="project-create-name-icon" aria-hidden="true">
              <Folder weight="regular" />
            </span>
            <input
              ref={nameInputRef}
              id="project-create-name-input"
              value={props.form.name}
              placeholder={props.copy.createNamePlaceholder}
              aria-invalid={props.error === props.copy.createNameRequired ? true : undefined}
              onChange={(event) => props.onNameChange(event.currentTarget.value)}
              disabled={interactionBusy}
            />
          </div>
          <section className="project-create-folder-field" aria-labelledby="project-create-folder-label">
            <strong id="project-create-folder-label">{props.copy.createFolderLabel}</strong>
            <p id="project-create-folder-help" className="visually-hidden">
              {props.copy.createFolderHelp}
            </p>
            <button
              type="button"
              className="project-create-folder-picker"
              data-selected={props.form.localPath ? 'true' : 'false'}
              aria-describedby="project-create-folder-help"
              onClick={props.onChooseDirectory}
              disabled={interactionBusy}
              {...controlBusyProps(props.directoryBusy)}
            >
              <span className="project-create-folder-picker-icon" aria-hidden="true">
                {props.form.localPath ? <FolderOpen weight="regular" /> : <FolderPlus weight="regular" />}
              </span>
              <span className="project-create-folder-picker-copy">
                <strong>{props.form.localPath ? defaultProjectNameFromLocalPath(props.form.localPath) : props.copy.createChooseFolder}</strong>
                {props.form.localPath ? <small title={props.form.localPath}>{props.form.localPath}</small> : null}
              </span>
              {props.form.localPath ? <span className="project-create-folder-change">{props.copy.createChangeFolder}</span> : null}
            </button>
          </section>
          {props.error ? (
            <p className="project-create-error" id="project-create-error" role="alert">
              {props.error}
            </p>
          ) : null}
        </div>
        <footer className="project-create-dialog-footer">
          <Button variant="secondary" size="regular" onClick={props.onClose} disabled={interactionBusy}>
            {props.copy.createCancel}
          </Button>
          <Button type="submit" variant="primary" size="regular" busy={props.busy} disabled={interactionBusy || !props.form.name.trim() || !props.form.localPath}>
            {props.busy ? props.copy.createSubmitting : props.copy.createSubmit}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
}

export function ProjectRenameDialog(props: {
  project?: ProjectRecord;
  draft: string;
  busy: boolean;
  error?: string;
  copy: ReturnType<typeof getLanguageCopy>['sidebar'];
  onDraftChange: (draft: string) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.project) return;
    const focusFrame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.project?.id]);
  if (!props.project) return null;

  const describedBy = props.error ? 'project-rename-dialog-help project-rename-error' : 'project-rename-dialog-help';
  const surface = (
    <ModalPortal rootClassName="project-rename-dialog-portal-root" backdropClassName="project-rename-dialog-backdrop" dismissDisabled={props.busy} onDismiss={props.onClose}>
      <form
        className="project-rename-dialog zeus-solid-form-surface"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-dialog-title"
        aria-describedby={describedBy}
        onSubmit={props.onSubmit}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || props.busy) return;
          event.stopPropagation();
          props.onClose();
        }}
      >
        <header className="project-rename-dialog-header">
          <span>
            <strong id="project-rename-dialog-title">{props.copy.renameDialogTitle}</strong>
            <small id="project-rename-dialog-help">{props.copy.renameDialogHelp}</small>
          </span>
          <button type="button" className="project-rename-dialog-close" aria-label={props.copy.renameCancel} onClick={props.onClose} disabled={props.busy}>
            <X aria-hidden="true" weight="regular" />
          </button>
        </header>
        <div className="project-rename-dialog-body">
          <label htmlFor="project-rename-input">{props.copy.renameLabel}</label>
          <input
            ref={inputRef}
            id="project-rename-input"
            value={props.draft}
            placeholder={props.copy.renamePlaceholder}
            aria-invalid={props.error ? true : undefined}
            onChange={(event) => props.onDraftChange(event.currentTarget.value)}
            disabled={props.busy}
          />
          {props.error ? (
            <small className="project-rename-error" id="project-rename-error" role="alert">
              {props.error}
            </small>
          ) : null}
        </div>
        <footer className="project-rename-dialog-footer">
          <Button variant="secondary" size="regular" className="project-rename-dialog-cancel" onClick={props.onClose} disabled={props.busy}>
            {props.copy.renameCancel}
          </Button>
          <Button type="submit" variant="primary" size="regular" className="project-rename-dialog-submit" busy={props.busy} disabled={!props.draft.trim()}>
            {props.busy ? props.copy.renameSaving : props.copy.renameSave}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
  return surface;
}

export function ProjectWorkspaceModeToolbar(props: {
  project: ProjectRecord;
  section: ProjectWorkspaceSection;
  codeMode: ProjectCodeWorkspaceMode;
  language: AppLanguage;
  onOpen: (section: ProjectWorkspaceSection, codeMode?: ProjectCodeWorkspaceMode) => void;
}) {
  const zh = props.language === 'zh-CN';
  const labels: Record<ProjectWorkspaceEntryId, string> = {
    tasks: zh ? '任务' : 'Tasks',
    git: 'Git',
    source: zh ? '源码' : 'Source',
    graph: zh ? '图谱' : 'Graph',
    commands: zh ? '命令' : 'Commands',
  };
  const icons: Record<ProjectWorkspaceEntryId, ReactNode> = {
    tasks: <WorkspaceTasksIcon aria-hidden="true" />,
    git: <WorkspaceGitIcon aria-hidden="true" />,
    source: <WorkspaceSourceIcon aria-hidden="true" />,
    graph: <WorkspaceGraphIcon aria-hidden="true" />,
    commands: <WorkspaceCommandsIcon aria-hidden="true" />,
  };
  return (
    <header className="project-workspace-mode-toolbar">
      <strong title={props.project.localPath}>{props.project.name}</strong>
      <nav aria-label={zh ? '项目工作区' : 'Project workspace'}>
        {PROJECT_WORKSPACE_ENTRIES.map((item) => {
          const active = props.section === item.section && (item.section !== 'code' || props.codeMode === item.codeMode);
          const label = labels[item.id];
          const shortcutLabel = zh ? `${label}（⌘${item.shortcutKey}）` : `${label} (⌘${item.shortcutKey})`;
          return (
            <button
              key={item.id}
              type="button"
              className={active ? 'is-active' : ''}
              aria-label={shortcutLabel}
              aria-current={active ? 'page' : undefined}
              aria-keyshortcuts={`Meta+${item.shortcutKey}`}
              title={shortcutLabel}
              onClick={() => props.onOpen(item.section, item.codeMode)}
            >
              <span aria-hidden="true">{icons[item.id]}</span>
              {label}
            </button>
          );
        })}
      </nav>
    </header>
  );
}

export function SidebarNav(props: {
  activeNavTarget: WorkspaceViewId;
  activeProjectId?: string;
  activeProjectSection: ProjectWorkspaceSection;
  projects: ProjectRecord[];
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  conversationOrganization: AppShellSettings['sidebarConversationOrganization'];
  collapsedConversationStatusIdsByProject: Record<string, string[]>;
  conversationGroups: ProjectConversationGroup[];
  selectedConversationId?: string | null;
  conversationStates: Record<string, ConversationTreeRuntimeState>;
  automaticUpdateIndicator: AutomaticUpdateIndicatorState | null;
  appLanguage: AppLanguage;
  canCreateProject: boolean;
  createProjectBusy: boolean;
  onCreateProject: () => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversation: NativeConversationChoice) => void;
  onArchiveConversation: (conversation: NativeConversationChoice) => Promise<void>;
  onNavigate: (target: WorkspaceViewId) => void;
  onOpenAutomaticUpdate: () => void;
  onOpenProjectSection: (project: ProjectRecord, section: ProjectWorkspaceSection) => void;
  onTogglePinnedProject: (projectId: string) => void;
  onToggleProjectCollapsed: (projectId: string) => void;
  onToggleConversationOrganization: () => void;
  onToggleConversationStatusGroup: (projectId: string, statusId: string) => void;
  onRevealProjectInFinder: (projectPath: string) => Promise<void>;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onPrepareProjectDelete: (projectId: string) => void;
  onConfirmProjectDelete: (projectId: string) => void;
  pendingProjectDeleteId?: string;
}) {
  const projectPopoverCloseAnimationMs = 120;
  const projectPopoverAnchorGapPx = 6;
  const [openProjectMenuIds, setOpenProjectMenuIds] = useState<Set<string>>(() => new Set());
  const [closingProjectMenuIds, setClosingProjectMenuIds] = useState<Set<string>>(() => new Set());
  const [projectMenuPositions, setProjectMenuPositions] = useState<Map<string, { left: number; top: number }>>(() => new Map());
  const [projectSearchOpen, setProjectSearchOpen] = useState(false);
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [visibleConversationCountByProject, setVisibleConversationCountByProject] = useState<Record<string, number>>({});
  const [projectRenameTarget, setProjectRenameTarget] = useState<ProjectRecord | undefined>();
  const [projectRenameDraft, setProjectRenameDraft] = useState('');
  const [projectRenameBusy, setProjectRenameBusy] = useState(false);
  const [projectRenameError, setProjectRenameError] = useState<string | undefined>();
  const openProjectMenuIdsRef = useRef(openProjectMenuIds);
  const projectMenuButtonRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const projectMenuCloseTimerRefs = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const previousActiveProjectIdRef = useRef(props.activeProjectId);
  useEffect(() => {
    if (previousActiveProjectIdRef.current === props.activeProjectId) return;
    previousActiveProjectIdRef.current = props.activeProjectId;
    setVisibleConversationCountByProject({});
  }, [props.activeProjectId]);
  useEffect(() => {
    openProjectMenuIdsRef.current = openProjectMenuIds;
  }, [openProjectMenuIds]);
  useEffect(() => {
    return () => {
      projectMenuCloseTimerRefs.current.forEach((timer) => clearTimeout(timer));
      projectMenuCloseTimerRefs.current.clear();
    };
  }, []);
  const closeProjectSearch = () => {
    setProjectSearchOpen(false);
    setProjectSearchQuery('');
  };
  const toggleProjectSearch = () => {
    if (projectSearchOpen) {
      closeProjectSearch();
      return;
    }
    setProjectSearchOpen(true);
  };
  const handleProjectSearchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    closeProjectSearch();
  };
  const clearProjectMenuCloseTimer = (projectId: string) => {
    const timer = projectMenuCloseTimerRefs.current.get(projectId);
    if (!timer) return;
    clearTimeout(timer);
    projectMenuCloseTimerRefs.current.delete(projectId);
  };
  const closeProjectMoreMenu = (projectId: string) => {
    clearProjectMenuCloseTimer(projectId);
    setClosingProjectMenuIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setOpenProjectMenuIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setProjectMenuPositions((current) => {
      if (!current.has(projectId)) return current;
      const next = new Map(current);
      next.delete(projectId);
      return next;
    });
  };
  const closeProjectMoreMenuWithMotion = (projectId: string) => {
    if (!openProjectMenuIdsRef.current.has(projectId)) return;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      closeProjectMoreMenu(projectId);
      return;
    }
    setClosingProjectMenuIds((current) => new Set(current).add(projectId));
    clearProjectMenuCloseTimer(projectId);
    const timer = setTimeout(() => {
      projectMenuCloseTimerRefs.current.delete(projectId);
      closeProjectMoreMenu(projectId);
    }, projectPopoverCloseAnimationMs);
    projectMenuCloseTimerRefs.current.set(projectId, timer);
  };
  const closeProjectMoreMenusImmediately = () => {
    projectMenuCloseTimerRefs.current.forEach((timer) => clearTimeout(timer));
    projectMenuCloseTimerRefs.current.clear();
    setClosingProjectMenuIds((current) => (current.size === 0 ? current : new Set()));
    setOpenProjectMenuIds((current) => (current.size === 0 ? current : new Set()));
    setProjectMenuPositions((current) => (current.size === 0 ? current : new Map()));
  };
  const closeOpenProjectMoreMenusWithMotion = () => {
    const openProjectIds = Array.from(openProjectMenuIdsRef.current);
    if (openProjectIds.length === 0) return;
    const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) {
      closeProjectMoreMenusImmediately();
      return;
    }
    openProjectIds.forEach((projectId) => closeProjectMoreMenuWithMotion(projectId));
  };
  const toggleProjectMoreMenu = (projectId: string, anchorButton: HTMLButtonElement) => {
    if (openProjectMenuIdsRef.current.has(projectId)) {
      closeProjectMoreMenuWithMotion(projectId);
      return;
    }
    const anchorRect = anchorButton.getBoundingClientRect();
    setProjectMenuPositions((current) => {
      const next = new Map(current);
      next.set(projectId, {
        left: anchorRect.right + projectPopoverAnchorGapPx,
        top: anchorRect.top,
      });
      return next;
    });
    clearProjectMenuCloseTimer(projectId);
    setClosingProjectMenuIds((current) => {
      if (!current.has(projectId)) return current;
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
    setOpenProjectMenuIds((current) => {
      const next = new Set(current);
      next.add(projectId);
      return next;
    });
  };
  const handleProjectMoreMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, projectId: string) => {
    const menuItems = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    const currentIndex = menuItems.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeProjectMoreMenuWithMotion(projectId);
      projectMenuButtonRefs.current.get(projectId)?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || menuItems.length === 0) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? menuItems.length - 1 : event.key === 'ArrowDown' ? (currentIndex + 1 + menuItems.length) % menuItems.length : (currentIndex - 1 + menuItems.length) % menuItems.length;
    menuItems[nextIndex]?.focus();
  };
  useEffect(() => {
    const closeProjectMoreMenusOnOutsidePointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('.project-row-actions, .project-more-popover')) return;
      // 点击菜单外部只关闭轻量 popover，不折叠项目行，避免破坏多个项目可同时展开的 source-list 状态。
      closeOpenProjectMoreMenusWithMotion();
    };
    document.addEventListener('pointerdown', closeProjectMoreMenusOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeProjectMoreMenusOnOutsidePointerDown, true);
  }, []);
  useEffect(() => {
    if (openProjectMenuIds.size === 0) return;
    const syncOpenProjectMenuPositions = () => {
      setProjectMenuPositions((current) => {
        const next = new Map(current);
        openProjectMenuIds.forEach((projectId) => {
          const anchorButton = projectMenuButtonRefs.current.get(projectId);
          if (!anchorButton) return;
          const anchorRect = anchorButton.getBoundingClientRect();
          next.set(projectId, {
            left: anchorRect.right + projectPopoverAnchorGapPx,
            top: anchorRect.top,
          });
        });
        return next;
      });
    };
    window.addEventListener('resize', syncOpenProjectMenuPositions);
    document.addEventListener('scroll', syncOpenProjectMenuPositions, true);
    return () => {
      window.removeEventListener('resize', syncOpenProjectMenuPositions);
      document.removeEventListener('scroll', syncOpenProjectMenuPositions, true);
    };
  }, [openProjectMenuIds]);
  const copy = getLanguageCopy(props.appLanguage).sidebar;
  const openProjectRenameDialog = (project: ProjectRecord) => {
    closeProjectMoreMenuWithMotion(project.id);
    setProjectRenameTarget(project);
    setProjectRenameDraft(project.name);
    setProjectRenameError(undefined);
  };
  const closeProjectRenameDialog = () => {
    if (projectRenameBusy) return;
    const projectId = projectRenameTarget?.id;
    setProjectRenameTarget(undefined);
    setProjectRenameDraft('');
    setProjectRenameError(undefined);
    if (projectId) window.requestAnimationFrame(() => projectMenuButtonRefs.current.get(projectId)?.focus());
  };
  const submitProjectRename = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectRenameTarget || projectRenameBusy) return;
    const displayName = projectRenameDraft.trim();
    if (!displayName) {
      setProjectRenameError(copy.renameRequired);
      return;
    }
    setProjectRenameBusy(true);
    setProjectRenameError(undefined);
    try {
      await props.onRenameProject(projectRenameTarget.id, displayName);
      const projectId = projectRenameTarget.id;
      setProjectRenameTarget(undefined);
      setProjectRenameDraft('');
      window.requestAnimationFrame(() => projectMenuButtonRefs.current.get(projectId)?.focus());
    } catch (error) {
      setProjectRenameError(errorToLocalUiMessage(error));
    } finally {
      setProjectRenameBusy(false);
    }
  };
  const visibleProjects = projectSearchQuery.trim()
    ? props.projects.filter((project) => {
        const query = projectSearchQuery.trim().toLocaleLowerCase();
        const group = props.conversationGroups.find((candidate) => candidate.projectId === project.id);
        const conversationMatches = [...(group?.conversations ?? []), ...(group?.tasks.flatMap((task) => task.conversations) ?? [])].some((conversation) =>
          conversationDisplayTitle(conversation.title, group?.tasks.find((task) => task.taskId === conversation.taskId)?.taskTitle)
            .toLocaleLowerCase()
            .includes(query),
        );
        return project.name.toLocaleLowerCase().includes(query) || project.localPath.toLocaleLowerCase().includes(query) || conversationMatches;
      })
    : props.projects;
  const enteringProjectIds = useNewItemMotionIds(props.projects.map((project) => project.id));
  // macOS 红黄绿窗口按钮属于系统层：侧栏只保留 44px 顶部安全区，避开交通灯但不再保留整行死空间。
  const titlebarProtectedSidebarStyle = {
    '--zeus-hidden-titlebar-safe-top': '44px',
    paddingBlockStart: 'var(--zeus-hidden-titlebar-safe-top, 44px)',
    paddingTop: 'var(--zeus-hidden-titlebar-safe-top, 44px)',
  } as CSSProperties;
  const projectMenuPortalHost = typeof document === 'undefined' ? undefined : (document.querySelector<HTMLElement>('.macos-ai-app.zeus-shell') ?? undefined);

  return (
    <aside className="zeus-sidebar ai-sidebar project-first-sidebar zeus-titlebar-protected-source-list" aria-label={copy.ariaLabel} style={titlebarProtectedSidebarStyle}>
      <div className="project-window-control-reserved-space" aria-hidden="true" />
      <nav className="project-quick-actions codex-source-list-quick-actions" aria-label={copy.quickActionsLabel}>
        <button type="button" className="project-quick-action" onClick={props.onCreateConversation} disabled={!props.activeProjectId}>
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M4.2 14.9 4.8 11 12.6 3.2a2 2 0 0 1 2.8 0l1.4 1.4a2 2 0 0 1 0 2.8L9 15.2l-3.9.6Z" />
              <path d="m11.4 4.4 4.2 4.2" />
            </svg>
          </span>
          <span className="project-quick-action-label">{copy.newChat}</span>
        </button>
        <button type="button" className="project-quick-action" aria-expanded={projectSearchOpen} onClick={toggleProjectSearch} disabled={props.projects.length === 0}>
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <circle cx="8.8" cy="8.8" r="5.4" />
              <path d="m13 13 3.4 3.4" />
            </svg>
          </span>
          <span className="project-quick-action-label">{copy.search}</span>
        </button>
      </nav>
      {projectSearchOpen ? (
        <section className="project-sidebar-search-row" aria-label={copy.search} onKeyDown={handleProjectSearchKeyDown}>
          {/* 搜索入口只负责本地过滤项目 source-list，不再偷偷跳到第一个项目任务页，避免误切当前工作上下文。 */}
          <span className="project-sidebar-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input type="search" aria-label={copy.search} placeholder={copy.search} value={projectSearchQuery} autoFocus onChange={(event) => setProjectSearchQuery(event.currentTarget.value)} />
        </section>
      ) : null}

      <section className="project-sidebar-list zeus-source-list" role="navigation" data-source-list-keyboard="vertical" aria-label={copy.projectListLabel} onKeyDown={handleSourceListKeyboardNavigation}>
        <div className="project-sidebar-heading">
          <span>{copy.projects}</span>
          <span className="project-sidebar-heading-actions">
            <button
              type="button"
              className="project-conversation-organization-button"
              aria-label={props.conversationOrganization === 'task_status' ? copy.showConversationsFlat : copy.groupConversationsByTaskStatus}
              title={props.conversationOrganization === 'task_status' ? copy.showConversationsFlat : copy.groupConversationsByTaskStatus}
              onClick={props.onToggleConversationOrganization}
            >
              {props.conversationOrganization === 'task_status' ? (
                <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                  <path d="M4 5.2h12M4 10h12M4 14.8h12" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                  <path d="M6.2 4.4h9.8M6.2 7.2h7.2M6.2 12.8h9.8M6.2 15.6h7.2" />
                  <path d="m3.5 4.4 1.2 1.4-1.2 1.4M3.5 12.8l1.2 1.4-1.2 1.4" />
                </svg>
              )}
            </button>
            <button type="button" className="project-add-button" aria-label={copy.addProject} title={copy.addProject} onClick={props.onCreateProject} disabled={!props.canCreateProject} {...controlBusyProps(props.createProjectBusy)}>
              <Plus aria-hidden="true" weight="regular" />
            </button>
          </span>
        </div>
        {props.projects.length === 0 ? null : visibleProjects.length === 0 ? (
          <section className="project-inline-recovery-row project-search-empty-row" aria-label={copy.noProjectMatches}>
            <span className="project-inline-recovery-copy">
              <strong>{copy.noProjectMatches}</strong>
            </span>
          </section>
        ) : (
          visibleProjects.map((project) => {
            const isActiveProject = project.id === props.activeProjectId && props.activeNavTarget !== 'settings';
            const pinned = props.pinnedProjectIds.includes(project.id);
            const expanded = !props.collapsedProjectIds.includes(project.id);
            const menuOpen = openProjectMenuIds.has(project.id);
            const menuClosing = closingProjectMenuIds.has(project.id);
            const menuVisible = menuOpen || menuClosing;
            const menuPosition = projectMenuPositions.get(project.id);
            const conversationGroup = props.conversationGroups.find((group) => group.projectId === project.id);
            const projectMatchesSearch = project.name.toLocaleLowerCase().includes(projectSearchQuery.trim().toLocaleLowerCase()) || project.localPath.toLocaleLowerCase().includes(projectSearchQuery.trim().toLocaleLowerCase());
            const projectMorePopover =
              menuVisible && menuPosition ? (
                <div
                  id={`project-more-menu-${project.id}`}
                  className="project-more-popover zeus-quiet-more-menu"
                  role="menu"
                  aria-label={`${project.name} ${copy.moreProjectActionsPrefix}`}
                  data-motion-surface="popover"
                  data-motion-state={menuClosing ? 'closing' : 'open'}
                  style={{ left: menuPosition.left, top: menuPosition.top }}
                  onKeyDown={(event) => handleProjectMoreMenuKeyDown(event, project.id)}
                >
                  {/* 项目菜单提升到应用壳层，位置只由“更多”按钮的视口坐标决定，避免被侧栏滚动容器横向裁剪。 */}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      props.onTogglePinnedProject(project.id);
                      closeProjectMoreMenuWithMotion(project.id);
                    }}
                  >
                    <span className="project-more-menu-icon" aria-hidden="true">
                      {pinned ? <PushPinSlash weight="regular" /> : <PushPin weight="regular" />}
                    </span>
                    <span>{pinned ? copy.unpinProject : copy.pinProject}</span>
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeProjectMoreMenuWithMotion(project.id);
                      void props.onRevealProjectInFinder(project.localPath).catch(() => undefined);
                    }}
                  >
                    <span className="project-more-menu-icon" aria-hidden="true">
                      <FolderOpen weight="regular" />
                    </span>
                    <span>{copy.revealProjectInFinder}</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => openProjectRenameDialog(project)}>
                    <span className="project-more-menu-icon" aria-hidden="true">
                      <PencilSimple weight="regular" />
                    </span>
                    <span>{copy.renameProject}</span>
                  </button>
                  <button type="button" role="menuitem" className="project-menu-remove-action" onClick={() => props.onPrepareProjectDelete(project.id)}>
                    <span className="project-more-menu-icon" aria-hidden="true">
                      <X weight="regular" />
                    </span>
                    <span>{copy.deleteProject}</span>
                  </button>
                  {props.pendingProjectDeleteId === project.id ? (
                    <button
                      type="button"
                      role="menuitem"
                      className="danger-action project-menu-confirm-remove-action"
                      onClick={() => {
                        props.onConfirmProjectDelete(project.id);
                        closeProjectMoreMenuWithMotion(project.id);
                      }}
                    >
                      <span className="project-more-menu-icon" aria-hidden="true">
                        <X weight="bold" />
                      </span>
                      <span>{copy.confirmDeleteProject}</span>
                    </button>
                  ) : null}
                </div>
              ) : null;
            return (
              <section
                className="project-sidebar-item"
                key={project.id}
                aria-label={`${copy.projects}${copy.labelSeparator}${project.name}`}
                data-motion-surface="list-item"
                data-motion-state={enteringProjectIds.has(project.id) ? 'entering' : undefined}
              >
                <SourceListRow
                  level="root"
                  surface="fill"
                  expanded={expanded}
                  className={isActiveProject && props.activeProjectSection !== 'sessions' ? 'is-active-project-root' : undefined}
                  disclosure={
                    <button
                      type="button"
                      className="project-disclosure-button"
                      aria-label={`${expanded ? copy.collapseProjectPrefix : copy.expandProjectPrefix}${copy.labelSeparator}${project.name}`}
                      aria-expanded={expanded}
                      onClick={() => props.onToggleProjectCollapsed(project.id)}
                    >
                      <span aria-hidden="true">›</span>
                    </button>
                  }
                  disclosurePlacement="trailing"
                  icon={
                    <svg className="native-folder-icon zeus-avatar-token" viewBox="0 0 20 20" focusable="false" aria-hidden="true">
                      <path d="M2.8 6.4h5.1l1.4 1.5h7.9v7.7a1.4 1.4 0 0 1-1.4 1.4H4.2a1.4 1.4 0 0 1-1.4-1.4Z" />
                      <path d="M2.8 6.4V5.7a1.4 1.4 0 0 1 1.4-1.4h3.4l1.5 2.1" />
                    </svg>
                  }
                  label={<strong>{project.name}</strong>}
                  buttonProps={{
                    type: 'button',
                    tabIndex: isActiveProject ? 0 : -1,
                    'data-source-list-item': 'true',
                    'aria-label': `${copy.sections.tasks}${copy.labelSeparator}${project.name}`,
                    onClick: () => props.onOpenProjectSection(project, 'tasks'),
                  }}
                  actions={
                    <>
                      <button type="button" className="project-settings-button" aria-label={`${copy.projectSettingsPrefix}${copy.labelSeparator}${project.name}`} onClick={() => props.onOpenProjectSection(project, 'project-settings')}>
                        ⚙
                      </button>
                      <div className={`project-row-actions ${menuOpen ? 'open' : ''} ${menuClosing ? 'closing' : ''}`.trim()} onKeyDown={(event) => handleProjectMoreMenuKeyDown(event, project.id)}>
                        <button
                          type="button"
                          className="project-more-button"
                          ref={(button) => {
                            if (button) {
                              projectMenuButtonRefs.current.set(project.id, button);
                            } else {
                              projectMenuButtonRefs.current.delete(project.id);
                            }
                          }}
                          aria-label={`${copy.moreProjectActionsPrefix}${copy.labelSeparator}${project.name}`}
                          aria-haspopup="menu"
                          aria-expanded={menuOpen}
                          aria-controls={menuVisible ? `project-more-menu-${project.id}` : undefined}
                          onClick={(event) => toggleProjectMoreMenu(project.id, event.currentTarget)}
                        >
                          ···
                        </button>
                      </div>
                      {projectMorePopover ? (projectMenuPortalHost ? createPortal(projectMorePopover, projectMenuPortalHost) : projectMorePopover) : null}
                    </>
                  }
                />
                {expanded ? (
                  <div className="project-sidebar-conversations animated-project-menu">
                    {conversationGroup ? (
                      <ProjectConversationTree
                        groups={[conversationGroup]}
                        selectedConversationId={props.selectedConversationId}
                        conversationStates={props.conversationStates}
                        onSelectConversation={props.onSelectConversation}
                        onArchiveConversation={props.onArchiveConversation}
                        language={props.appLanguage}
                        compactProjectLabel
                        showEmptyState={false}
                        query={projectMatchesSearch ? '' : projectSearchQuery}
                        visibleConversationCount={visibleConversationCountByProject[project.id] ?? 6}
                        onShowMore={() =>
                          setVisibleConversationCountByProject((current) => ({
                            ...current,
                            [project.id]: (current[project.id] ?? 6) + 10,
                          }))
                        }
                        organization={props.conversationOrganization}
                        collapsedStatusIdsByProject={props.collapsedConversationStatusIdsByProject}
                        onToggleStatusGroup={props.onToggleConversationStatusGroup}
                      />
                    ) : null}
                  </div>
                ) : null}
              </section>
            );
          })
        )}
      </section>

      <AutomaticUpdateIndicatorButton state={props.automaticUpdateIndicator} language={props.appLanguage} onOpen={props.onOpenAutomaticUpdate} />
      <section className="project-global-settings" aria-label={copy.globalSettingsLabel}>
        <button type="button" className={props.activeNavTarget === 'settings' ? 'active' : ''} onClick={() => props.onNavigate('settings')}>
          <span aria-hidden="true">⚙</span>
          {copy.settings}
        </button>
      </section>
      <ProjectRenameDialog
        project={projectRenameTarget}
        draft={projectRenameDraft}
        busy={projectRenameBusy}
        error={projectRenameError}
        copy={copy}
        onDraftChange={(draft) => {
          setProjectRenameDraft(draft);
          if (projectRenameError) setProjectRenameError(undefined);
        }}
        onClose={closeProjectRenameDialog}
        onSubmit={(event) => void submitProjectRename(event)}
      />
    </aside>
  );
}

export function AutomaticUpdateIndicatorButton(props: { state: AutomaticUpdateIndicatorState | null; language: AppLanguage; onOpen: () => void }) {
  if (!props.state || props.state.phase === 'idle') return null;
  const zh = props.language === 'zh-CN';
  const version = props.state.latestVersion ?? props.state.currentVersion;
  const progress = props.state.progress === undefined ? null : `${Math.min(100, Math.floor(Math.max(0, props.state.progress) * 100))}%`;
  const label =
    props.state.phase === 'ready'
      ? zh
        ? `Zeus ${version} 等待重启`
        : `Zeus ${version} ready to restart`
      : props.state.phase === 'failed'
        ? zh
          ? `Zeus ${version} 下载失败`
          : `Zeus ${version} download failed`
        : props.state.phase === 'retrying'
          ? zh
            ? `Zeus ${version} 等待重试`
            : `Zeus ${version} waiting to retry`
          : props.state.phase === 'preparing'
            ? zh
              ? `正在下载 Zeus ${version}${progress ? ` · ${progress}` : ''}`
              : `Downloading Zeus ${version}${progress ? ` · ${progress}` : ''}`
            : zh
              ? `Zeus ${version} 可用`
              : `Zeus ${version} available`;
  const icon =
    props.state.phase === 'ready' ? (
      <CheckCircle aria-hidden="true" weight="fill" />
    ) : props.state.phase === 'failed' ? (
      <WarningCircle aria-hidden="true" weight="fill" />
    ) : props.state.phase === 'preparing' || props.state.phase === 'retrying' ? (
      <SpinnerGap className="automatic-update-indicator-spinner" aria-hidden="true" />
    ) : (
      <DownloadSimple aria-hidden="true" />
    );
  const actionHint = zh ? '点击打开更新窗口' : 'Open the update window';
  return (
    <section className="automatic-update-indicator" data-phase={props.state.phase} aria-live="polite" aria-atomic="true">
      <button type="button" title={`${props.state.detail} ${actionHint}`} aria-label={zh ? `${label}。${props.state.detail} ${actionHint}` : `${label}. ${props.state.detail} ${actionHint}`} onClick={props.onOpen}>
        <span className="automatic-update-indicator-icon" aria-hidden="true">
          {icon}
        </span>
        <span>{label}</span>
      </button>
    </section>
  );
}

export function InlineRecoveryPrompt(props: { title: string; body: string; actions: InlineRecoveryAction[]; className?: string }) {
  return (
    <section className={`project-inline-recovery-row ${props.className ?? ''}`} aria-label={props.title}>
      <span className="project-inline-recovery-copy">
        <strong>{props.title}</strong>
        {props.body ? <small>{props.body}</small> : null}
      </span>
      {props.actions.length > 0 ? (
        <span className="project-inline-recovery-command-rail">
          {props.actions.map((action) => (
            <button key={action.label} type="button" onClick={action.onAction} disabled={action.disabled} {...controlBusyProps(action.busy === true)}>
              {action.label}
            </button>
          ))}
        </span>
      ) : null}
    </section>
  );
}

export function formatRuntimeDefaultArgs(args: string[]): string {
  return args.join(' ');
}

export function formatRuntimeAdapterDetectionFacts(adapter: AiRuntimeAdapterDescriptor, status: AiRuntimeAdapterStatus | undefined, appLanguage: AppLanguage): string {
  const copy = getLanguageCopy(appLanguage).sessionWorkspace.runtimeDrawer;
  if (!status) return copy.adapterCapabilities(adapter.capabilities.join(' / '));
  // Adapter 检测字段直接来自真实探测结果；按当前应用语言格式化标签，但不翻译真实命令、模型 ID 或能力 ID。
  const modelConfiguration = status.modelConfiguration === 'user-configured' ? copy.adapterModelUserConfigured : status.modelConfiguration;
  return [
    status.resolvedCommandPath ?? adapter.command,
    copy.adapterVersion(status.version ?? copy.adapterVersionUnknown),
    status.checkedAt,
    copy.adapterAuthStatus(formatAdapterAuthStatus(status.authStatus, appLanguage)),
    copy.adapterModelConfig(modelConfiguration),
    copy.adapterCapabilities(status.capabilities.join(' / ')),
  ].join(' · ');
}

export function formatAdapterAuthStatus(status: AiRuntimeAdapterStatus['authStatus'], appLanguage: AppLanguage): string {
  const copy = getLanguageCopy(appLanguage).sessionWorkspace.runtimeDrawer;
  if (status === 'authenticated') return copy.adapterAuthAuthenticated;
  if (status === 'unauthenticated') return copy.adapterAuthUnauthenticated;
  return copy.adapterAuthUnknown;
}

export function formatGenericShellRisk(risk: GenericShellCommandRisk, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): GenericShellCommandRisk {
  if (risk.level === 'empty') {
    return {
      ...risk,
      label: copy.emptyShellCommand,
      reason: copy.genericShellCommandHelp,
    };
  }
  if (risk.level === 'critical') {
    return {
      ...risk,
      label: copy.criticalPhraseTitle,
      reason: copy.criticalPhraseHelp(GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE),
    };
  }
  return {
    ...risk,
    label: copy.confirmationStateTitle,
    reason: copy.genericShellCommandHelp,
  };
}

export function formatRuntimeConfirmationStatus(status: RuntimeConfirmationStatusState, copy: ReturnType<typeof getLanguageCopy>['sessionWorkspace']['runtimeDrawer']): string {
  if (status.kind === 'created') return copy.genericShellConfirmationCreated(status.confirmationId);
  if (status.kind === 'create_failed') return copy.genericShellConfirmationCreateFailed;
  if (status.kind === 'reject_failed') return copy.genericShellConfirmationRejectFailed;
  if (status.kind === 'rejected') return `${copy.rejectedTitle} · ${copy.rejectedHelp}`;
  if (status.kind === 'critical_phrase_required') return copy.genericShellCriticalPhraseRequired(GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE);
  if (status.kind === 'changed') return copy.genericShellChangedStatus;
  if (status.kind === 'consumed') return copy.genericShellConfirmationConsumed(status.confirmationId);
  if (status.kind === 'failed') return copy.genericShellConfirmationFailed;
  return copy.genericShellConfirmationIdle;
}

export function parseRuntimeDefaultArgsText(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 16);
}

export function formatRuntimeTerminalEnv(env: RuntimeSettings['terminalEnv']): string {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
}

export interface ProjectConfigFormState {
  defaultModel: string;
  defaultWorkMode: ProjectConfig['defaultWorkMode'];
  defaultTaskPrompt: string;
  scanIgnoreDirectories: string;
  indexScope: ProjectConfig['scan']['indexScope'];
  languagePrimary: string;
  languageAdditional: string;
  packageManagers: string;
  manifestPaths: string;
  databaseConnectionName: string;
  databaseSchemaPaths: string;
  telegramAlias: string;
  allowShell: boolean;
  allowGitWrite: boolean;
}

export function normalizeProjectConfig(config?: Partial<ProjectConfig>, projectId?: string): ProjectConfig | undefined {
  const resolvedProjectId = config?.projectId ?? projectId;
  if (!resolvedProjectId) return undefined;
  return {
    projectId: resolvedProjectId,
    defaultModel: config?.defaultModel ?? null,
    defaultWorkMode: config?.defaultWorkMode ?? 'plan',
    defaultTaskPrompt: config?.defaultTaskPrompt ?? '',
    scan: {
      ignoreDirectories: config?.scan?.ignoreDirectories ?? ['node_modules', 'dist', '.tmp', 'coverage'],
      indexScope: config?.scan?.indexScope ?? 'project',
    },
    language: {
      primary: config?.language?.primary ?? 'typescript',
      additional: config?.language?.additional ?? [],
    },
    dependencies: {
      packageManagers: config?.dependencies?.packageManagers ?? [],
      manifestPaths: config?.dependencies?.manifestPaths ?? [],
    },
    vcs: {
      isGitRepository: config?.vcs?.isGitRepository ?? false,
      gitRoot: config?.vcs?.gitRoot ?? null,
    },
    database: {
      connectionName: config?.database?.connectionName ?? null,
      schemaPaths: config?.database?.schemaPaths ?? [],
    },
    telegram: {
      alias: config?.telegram?.alias ?? null,
    },
    security: {
      allowShell: config?.security?.allowShell ?? false,
      allowGitWrite: config?.security?.allowGitWrite ?? false,
    },
  };
}

export function toProjectConfigForm(config?: ProjectConfig): ProjectConfigFormState {
  const normalized = normalizeProjectConfig(config, config?.projectId) ?? {
    projectId: '',
    defaultModel: null,
    defaultWorkMode: 'plan',
    defaultTaskPrompt: '',
    scan: {
      ignoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
      indexScope: 'project',
    },
    language: { primary: 'typescript', additional: [] },
    dependencies: { packageManagers: [], manifestPaths: [] },
    vcs: { isGitRepository: false, gitRoot: null },
    database: { connectionName: null, schemaPaths: [] },
    telegram: { alias: null },
    security: { allowShell: false, allowGitWrite: false },
  };
  return {
    defaultModel: normalized.defaultModel ?? '',
    defaultWorkMode: normalized.defaultWorkMode,
    defaultTaskPrompt: normalized.defaultTaskPrompt,
    scanIgnoreDirectories: normalized.scan.ignoreDirectories.join(', '),
    indexScope: normalized.scan.indexScope,
    languagePrimary: normalized.language.primary,
    languageAdditional: normalized.language.additional.join(', '),
    packageManagers: normalized.dependencies.packageManagers.join(', '),
    manifestPaths: normalized.dependencies.manifestPaths.join(', '),
    databaseConnectionName: redactDatabaseConnectionName(normalized.database.connectionName),
    databaseSchemaPaths: normalized.database.schemaPaths.join(', '),
    telegramAlias: normalized.telegram.alias ?? '',
    allowShell: normalized.security.allowShell,
    allowGitWrite: normalized.security.allowGitWrite,
  };
}

export function parseProjectConfigList(text: string): string[] {
  const seen = new Set<string>();
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item && !item.includes('..'))
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

export function parseNumericList(text: string): number[] {
  const seen = new Set<number>();
  return text
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
}

export function formatProjectLanguage(form: ProjectConfigFormState): string {
  const additional = parseProjectConfigList(form.languageAdditional);
  return [form.languagePrimary.trim() || 'typescript', ...additional].join(' + ');
}

export function formatProjectDependencies(form: ProjectConfigFormState, copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectConfig']): string {
  const managers = parseProjectConfigList(form.packageManagers).join(', ') || copy.unsetPackageManagers;
  const manifests = parseProjectConfigList(form.manifestPaths).join(', ') || copy.unsetManifestPaths;
  return `${managers} · ${manifests}`;
}

export function formatProjectDatabase(form: ProjectConfigFormState, copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectConfig']): string {
  const connectionName = redactDatabaseConnectionName(form.databaseConnectionName) || copy.unsetConnectionName;
  const schemaPaths = parseProjectConfigList(form.databaseSchemaPaths).join(', ') || copy.unsetSchemaPaths;
  return `${connectionName} · ${schemaPaths}`;
}

export function formatProjectDatabaseHelp(form: ProjectConfigFormState, copy: ReturnType<typeof getLanguageCopy>['codeWorkspace']['projectConfig']): string {
  return isExternalDatabaseUri(form.databaseConnectionName) ? copy.externalDatabaseHelp : copy.localSchemaHelp;
}

export function isExternalDatabaseUri(value: string | null | undefined): boolean {
  return /^(?:postgresql?|mysql|mariadb):/iu.test(value?.trim() ?? '');
}

export function redactDatabaseConnectionName(value: string | null | undefined): string {
  const text = value?.trim() ?? '';
  if (!isExternalDatabaseUri(text)) return text;
  try {
    const url = new URL(text);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    // URI 格式异常时仍要避免 user:password@ 片段直接出现在界面。
    return text.replace(/(:\/\/[^:@\s]+):[^@\s]+@/u, '$1:***@');
  }
}

export function normalizeLocalUiError(error?: LocalUiErrorSnapshot): LocalUiErrorSnapshot | undefined {
  if (!error) return undefined;
  return {
    action: error.action.trim() || 'renderer-action',
    message: redactLocalUiErrorMessage(error.message),
    occurredAt: error.occurredAt.trim() || new Date(0).toISOString(),
  };
}

export function errorToLocalUiMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return '本地操作失败，详情请查看本地日志目录。';
}

export function redactLocalUiErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gu, 'Bearer [REDACTED]')
    .replace(/\b(token|api[_-]?key|secret|password)=([^\s;&]+)/giu, '$1=[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/gu, '[REDACTED]');
}

export function normalizeRuntimeSettings(settings?: Partial<RuntimeSettings>): RuntimeSettings {
  const defaultSettings: RuntimeSettings = {
    defaultAdapterId: 'codex',
    adapterModels: {},
    adapterDefaultArgs: {},
    adapterCliPaths: {},
    terminalEnv: {},
    shell: { path: null, login: false },
    executionTimeoutSeconds: 3600,
    logRetentionDays: 30,
    autoConfirmationPolicy: 'never',
  };
  return {
    ...defaultSettings,
    ...settings,
    adapterModels: settings?.adapterModels ?? defaultSettings.adapterModels,
    adapterDefaultArgs: settings?.adapterDefaultArgs ?? defaultSettings.adapterDefaultArgs,
    adapterCliPaths: settings?.adapterCliPaths ?? defaultSettings.adapterCliPaths,
    terminalEnv: settings?.terminalEnv ?? defaultSettings.terminalEnv,
    shell: { ...defaultSettings.shell, ...settings?.shell },
  };
}

export function normalizeCodeMapSettings(settings?: Partial<CodeMapSettings>): CodeMapSettings {
  const defaultSettings: CodeMapSettings = {
    defaultScanScope: 'project',
    defaultIgnoreDirectories: ['node_modules', 'dist', '.tmp', 'coverage'],
    maxCallChainDepth: 3,
    showLowConfidenceEdges: false,
    layoutAlgorithm: 'hierarchical',
    graphCacheStrategy: 'sqlite',
    tableRelationInference: 'foreign_key_and_name',
    aiSummaryEnabled: false,
    incrementalScanEnabled: true,
    performanceMonitoringEnabled: false,
    moduleFlowManualNotes: '',
  };
  return {
    ...defaultSettings,
    ...settings,
    defaultIgnoreDirectories: Array.isArray(settings?.defaultIgnoreDirectories) ? settings.defaultIgnoreDirectories : defaultSettings.defaultIgnoreDirectories,
    maxCallChainDepth: typeof settings?.maxCallChainDepth === 'number' ? settings.maxCallChainDepth : defaultSettings.maxCallChainDepth,
    moduleFlowManualNotes: typeof settings?.moduleFlowManualNotes === 'string' ? settings.moduleFlowManualNotes : defaultSettings.moduleFlowManualNotes,
  };
}

export function parseRuntimeTerminalEnvText(text: string): RuntimeSettings['terminalEnv'] {
  const env: RuntimeSettings['terminalEnv'] = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes('=')) continue;
    const [key, ...valueParts] = trimmed.split('=');
    const name = key.trim();
    const value = valueParts.join('=').trim();
    // 只保存明确的键值对，避免把空变量写进真实 Runtime 子进程环境。
    if (!name || !value) continue;
    env[name] = value;
  }
  return env;
}

export function resolveRuntimeNormalizedLogPath(events: AiRuntimeTerminalEvent[]): string | undefined {
  const normalizedPath = events.find((event) => event.rawChunkPath?.endsWith('/terminal.normalized.log'))?.rawChunkPath;
  if (normalizedPath) return normalizedPath;
  const chunkPath = events.find((event) => event.rawChunkPath?.includes('/chunks/'))?.rawChunkPath;
  if (!chunkPath) return undefined;
  return chunkPath.replace(/\/chunks\/[^/]+$/u, '/terminal.normalized.log');
}

export function normalizeRuntimeSettingNumber(value: string, fallback: number, max = 20): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}
