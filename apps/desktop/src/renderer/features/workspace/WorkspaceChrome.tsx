import { MotionPresence } from '../../ui/MotionPresence.js';
import { normalizeSidebarConversationFilters, sidebarConversationRunStatuses, type SidebarConversationFilters } from '@zeus/shared';
import { Collapsible } from '../../ui/Collapsible.js';
import { handleSourceListKeyboardNavigation } from './workspaceSupport.js';
import { type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderPlusIcon as FolderPlus } from '@phosphor-icons/react/dist/csr/FolderPlus';
import { FunnelIcon as Funnel } from '@phosphor-icons/react/dist/csr/Funnel';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { DotsThreeVerticalIcon as DotsThreeVertical } from '@phosphor-icons/react/dist/csr/DotsThreeVertical';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { PushPinIcon as PushPin } from '@phosphor-icons/react/dist/csr/PushPin';
import { PushPinSlashIcon as PushPinSlash } from '@phosphor-icons/react/dist/csr/PushPinSlash';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { SpinnerGapIcon as SpinnerGap } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { ListChecksIcon as WorkspaceTasksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { GitBranchIcon as WorkspaceGitIcon } from '@phosphor-icons/react/dist/csr/GitBranch';
import { CodeSimpleIcon as WorkspaceSourceIcon } from '@phosphor-icons/react/dist/csr/CodeSimple';
import { TerminalIcon as WorkspaceCommandsIcon } from '@phosphor-icons/react/dist/csr/Terminal';
import { type AutomaticUpdateIndicatorState } from '../../appShellBridge.js';
import { type ConversationTreeRuntimeState, type ProjectConversationGroup, ProjectConversationTree, resolveConversationTreeRuntimeState, taskRunStatusFromConversationTreeState } from '../../session/ProjectConversationTree.js';
import { taskAgentRunStatusLabels } from '../../task/TaskRunStatusChip.js';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import { conversationDisplayTitle } from '../../session/conversationDisplayTitle.js';
import { type AppLanguage } from './workspaceCopy.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { reportApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { SourceListRow } from '../../ui/SourceListRow.js';
import { useNewItemMotionIds } from '../../ui/useNewItemMotion.js';
import { type AiRuntimeAdapterDescriptor, type AiRuntimeAdapterStatus, type AiRuntimeTerminalEvent, type ProjectConfig, type ProjectRecord, type RuntimeSettings } from '../../apiClient.js';
import { GENERIC_SHELL_CRITICAL_CONFIRMATION_PHRASE, type GenericShellCommandRisk } from './workspaceFormatters.js';
import {
  controlBusyProps,
  defaultProjectNameFromLocalPath,
  getLanguageCopy,
  type InlineRecoveryAction,
  type LocalUiErrorSnapshot,
  PROJECT_WORKSPACE_ENTRIES,
  type ProjectCodeWorkspaceMode,
  type ProjectCreateFormState,
  type ProjectWorkspaceEntryId,
  type ProjectWorkspaceSection,
  type RuntimeConfirmationStatusState,
  type WorkspaceViewId,
} from './workspaceSupport.js';

/** 项目会话首屏数量。 */
const defaultVisibleConversationCount = 6;
/** 每次展开更多追加的会话数量。 */
const additionalVisibleConversationCount = 10;

/** 仅用于接收旧界面缓存；之后以本机设置数据库为准。 */
const sidebarConversationFilterStorageKey = 'zeus.sidebar.conversation-filters';

/** 旧偏好只读取一次，数据库已有记录时不会被它覆盖。 */
function readLegacySidebarConversationFilters(): SidebarConversationFilters | undefined {
  try {
    /** 本机存储也可能被清理或损坏，读取后逐字段校验。 */
    const value: unknown = JSON.parse(window.localStorage.getItem(sidebarConversationFilterStorageKey) ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return normalizeSidebarConversationFilters(value);
  } catch {
    return undefined;
  }
}

/** 首次工作面复用项目创建，不引入独立引导状态或模型前置依赖。 */
export function ProjectStartGuide(props: { language: AppLanguage; busy: boolean; available: boolean; onChooseFolder: () => void }) {
  /** 引导文案沿用应用语言。 */
  const zh = props.language === 'zh-CN';
  return (
    <section className="project-start-guide" aria-labelledby="project-start-title">
      <FolderOpen className="project-start-symbol" size={36} weight="regular" aria-hidden="true" />
      <p className="project-start-eyebrow">{zh ? '你的第一个项目' : 'Your first project'}</p>
      <h1 id="project-start-title">{zh ? '从一个工作文件夹开始' : 'Start with a working folder'}</h1>
      <p className="project-start-description">{zh ? '把想完成的工作交给 Zeus。先选择文件夹，再创建一个清晰的任务。' : 'Bring your work to Zeus. Choose a folder, then describe the task you want to complete.'}</p>
      <ol className="project-start-steps" aria-label={zh ? '开始工作的三个步骤' : 'Three steps to start'}>
        <li aria-current="step">
          <span>1</span>
          <div>
            <strong>{zh ? '选择文件夹' : 'Choose a folder'}</strong>
            <small>{zh ? '确定项目与工作位置' : 'Set the project and location'}</small>
          </div>
        </li>
        <li>
          <span>2</span>
          <div>
            <strong>{zh ? '创建任务' : 'Create a task'}</strong>
            <small>{zh ? '描述目标与预期结果' : 'Describe the outcome'}</small>
          </div>
        </li>
        <li>
          <span>3</span>
          <div>
            <strong>{zh ? '确认并推送' : 'Review and push'}</strong>
            <small>{zh ? '按需接入模型后开始' : 'Connect a model when needed'}</small>
          </div>
        </li>
      </ol>
      <div className="project-start-action">
        <Button size="regular" onClick={props.onChooseFolder} disabled={props.busy || !props.available} busy={props.busy}>
          <FolderPlus size={18} aria-hidden="true" />
          {zh ? '选择工作文件夹' : 'Choose working folder'}
        </Button>
        <small>{zh ? '模型可以稍后接入，项目与任务保存在本机。' : 'Connect a model later. Projects and tasks are saved on your Mac.'}</small>
      </div>
    </section>
  );
}

/** 先选择工作目录，再确认名称；复用已有创建与弹窗交互。 */
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
  /** 目录未选时作为首个操作，原生选择器关闭后再恢复表单焦点。 */
  const directoryButtonRef = useRef<HTMLButtonElement>(null);
  /** 目录已有值时允许直接确认或修改自动填入的名称。 */
  const nameInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!props.open || props.directoryBusy) return;
    /** 等待原生选择器结束且控件恢复可用，兼容首次引导直接选目录的入口。 */
    const focusFrame = window.requestAnimationFrame(() => {
      (props.form.localPath ? nameInputRef.current : directoryButtonRef.current)?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(focusFrame);
  }, [props.open, props.directoryBusy, props.form.localPath]);
  if (!props.open) return null;

  /** 选择目录或创建期间，统一阻止重复操作和关闭。 */
  const interactionBusy = props.busy || props.directoryBusy;
  /** 错误与目录说明一并提供给辅助阅读工具。 */
  const describedBy = props.error ? 'project-create-folder-help project-create-error' : 'project-create-folder-help';

  return (
    <ModalPortal rootClassName="project-create-dialog-portal-root" backdropClassName="project-create-dialog-backdrop" dismissDisabled={interactionBusy} onDismiss={props.onClose}>
      <form className="project-create-dialog zeus-solid-form-surface" role="dialog" aria-modal="true" aria-labelledby="project-create-dialog-title" aria-describedby={describedBy} onSubmit={props.onSubmit}>
        <header className="project-create-dialog-header">
          <strong id="project-create-dialog-title">{props.copy.createDialogTitle}</strong>
          <button type="button" className="project-create-dialog-close" aria-label={props.copy.createCancel} onClick={props.onClose} disabled={interactionBusy}>
            <X aria-hidden="true" weight="regular" />
          </button>
        </header>
        <div className="project-create-dialog-body">
          <section className="project-create-folder-field" aria-labelledby="project-create-folder-label">
            <strong id="project-create-folder-label">{props.copy.createFolderLabel}</strong>
            <button
              ref={directoryButtonRef}
              type="button"
              className="project-create-folder-picker"
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
              <span className="project-create-folder-change">{props.form.localPath ? props.copy.createChangeFolder : props.copy.createSelectFolder}</span>
            </button>
            <p id="project-create-folder-help">{props.copy.createFolderHelp}</p>
          </section>
          <label className="project-create-name-field" htmlFor="project-create-name-input">
            <span>{props.copy.createNameLabel}</span>
            <input
              ref={nameInputRef}
              id="project-create-name-input"
              value={props.form.name}
              placeholder={props.copy.createNamePlaceholder}
              aria-invalid={props.error === props.copy.createNameRequired ? true : undefined}
              aria-describedby={props.error === props.copy.createNameRequired ? 'project-create-error' : undefined}
              onChange={(event) => props.onNameChange(event.currentTarget.value)}
              disabled={interactionBusy}
            />
          </label>
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

/** 项目主导航统一图标尺寸与字重，并让图标和文案作为整体居中。 */
export function ProjectWorkspaceModeToolbar(props: {
  project: ProjectRecord;
  section: ProjectWorkspaceSection;
  codeMode: ProjectCodeWorkspaceMode;
  language: AppLanguage;
  onOpen: (section: ProjectWorkspaceSection, codeMode?: ProjectCodeWorkspaceMode) => void;
}) {
  /** 导航文案跟随当前应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 各工作区的可见名称。 */
  const labels: Record<ProjectWorkspaceEntryId, string> = {
    tasks: zh ? '任务' : 'Tasks',
    git: 'Git',
    source: zh ? '源码' : 'Source',
    commands: zh ? '命令' : 'Commands',
  };
  /** 同一套线性图标保持一致的视觉重量。 */
  const icons: Record<ProjectWorkspaceEntryId, ReactNode> = {
    tasks: <WorkspaceTasksIcon size={18} weight="regular" aria-hidden="true" />,
    git: <WorkspaceGitIcon size={18} weight="regular" aria-hidden="true" />,
    source: <WorkspaceSourceIcon size={18} weight="regular" aria-hidden="true" />,
    commands: <WorkspaceCommandsIcon size={18} weight="regular" aria-hidden="true" />,
  };
  return (
    <header className="project-workspace-mode-toolbar" aria-label={props.project.name}>
      <nav aria-label={zh ? '项目工作区' : 'Project workspace'}>
        {PROJECT_WORKSPACE_ENTRIES.map((item) => {
          /** 当前工作区与源码子模式共同决定选中态。 */
          const active = props.section === item.section && (item.section !== 'code' || props.codeMode === item.codeMode);
          /** 当前入口文案。 */
          const label = labels[item.id];
          /** 读屏和提示保留快捷键说明。 */
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
              <span className="project-workspace-mode-label">{label}</span>
            </button>
          );
        })}
      </nav>
    </header>
  );
}

/** 项目导航将状态筛选与搜索叠加，会话始终平铺。 */
export function SidebarNav(props: {
  activeNavTarget: WorkspaceViewId;
  activeProjectId?: string;
  activeProjectSection: ProjectWorkspaceSection;
  projects: ProjectRecord[];
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  /** 启动时已加载的持久漏斗偏好，不依赖项目列表就绪。 */
  conversationFilters?: SidebarConversationFilters;
  /** 用户操作与旧偏好接收共用本机设置保存入口。 */
  onConversationFiltersChange: (filters: SidebarConversationFilters) => void;
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
  onRevealProjectInFinder: (projectPath: string) => Promise<void>;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onPrepareProjectDelete: (projectId: string) => void;
  onConfirmProjectDelete: (projectId: string) => void;
  pendingProjectDeleteId?: string;
}) {
  /** 只兜底丢失的过渡事件，正常关闭跟随共享退出动效。 */
  const projectPopoverCloseAnimationMs = 320;
  const projectPopoverAnchorGapPx = 6;
  const [openProjectMenuIds, setOpenProjectMenuIds] = useState<Set<string>>(() => new Set());
  const [closingProjectMenuIds, setClosingProjectMenuIds] = useState<Set<string>>(() => new Set());
  const [projectMenuPositions, setProjectMenuPositions] = useState<Map<string, { left: number; top: number }>>(() => new Map());
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  /** 已保存的数据库设置优先；旧缓存只作为首次接收来源。 */
  const [legacyConversationFilters] = useState(readLegacySidebarConversationFilters);
  /** 搜索文字仍保持临时输入，漏斗由工作台持久设置直接控制。 */
  const conversationFilters = props.conversationFilters ?? legacyConversationFilters ?? normalizeSidebarConversationFilters(undefined);
  useEffect(() => {
    if (props.conversationFilters !== undefined || !legacyConversationFilters) return;
    props.onConversationFiltersChange(legacyConversationFilters);
  }, [props.conversationFilters, props.onConversationFiltersChange, legacyConversationFilters]);
  /** 筛选和显示共用同一份持久偏好，避免分别恢复时出现中间态。 */
  const { conversationStatusFilters, hideEmptyFilteredProjects, latestConversationOnly } = conversationFilters;
  /** 只提交本次漏斗修改，异步目录刷新不会写回默认值。 */
  function updateConversationFilters(patch: Partial<SidebarConversationFilters>): void {
    /** 合并本次修改，保留同一漏斗内未修改的选项。 */
    const next = { ...conversationFilters, ...patch };
    props.onConversationFiltersChange(next);
  }
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
  const toggleProjectCollapsed = (projectId: string, expanded: boolean) => {
    if (expanded) {
      setVisibleConversationCountByProject((current) => {
        if (current[projectId] === undefined) return current;
        const next = { ...current };
        delete next[projectId];
        return next;
      });
    }
    props.onToggleProjectCollapsed(projectId);
  };
  const handleProjectSearchKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // 输入时保留光标按键，避免触发项目列表的方向键导航。
    event.stopPropagation();
    if (event.key !== 'Escape') return;
    setProjectSearchQuery('');
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
      setProjectRenameError(errorToLocalUiMessage(error, props.appLanguage));
    } finally {
      setProjectRenameBusy(false);
    }
  };
  /** 相同状态身份合并为一个选项；项目自定义名称不同则并列显示，避免误读。 */
  const statusLabelsById = new Map<string, Set<string>>();
  for (const group of props.conversationGroups) {
    for (const status of [...group.taskStatuses, ...group.tasks.filter((task) => !group.taskStatuses.some((status) => status.id === task.managementStatus)).map((task) => ({ id: task.managementStatus, label: task.managementStatus }))]) {
      if (!statusLabelsById.has(status.id)) statusLabelsById.set(status.id, new Set());
      statusLabelsById.get(status.id)!.add(status.label);
    }
  }
  /** 任务状态、会话运行状态与其他会话分区展示；清除选择不属于可选值。 */
  const statusFilterOptions = [
    ...Array.from(statusLabelsById, ([id, labels]) => ({ value: `status:${id}`, label: [...labels].join(' / '), group: copy.taskStatusFilterGroup })),
    ...sidebarConversationRunStatuses.map((status) => ({ value: `run:${status}`, label: taskAgentRunStatusLabels[props.appLanguage][status], group: copy.conversationStatusFilterGroup })),
    { value: 'project', label: copy.projectConversationsOnly, group: copy.otherConversationFilterGroup },
  ];
  /** 忽略已删除的状态；未选择状态时显示全部会话。 */
  const activeStatusFilters = conversationStatusFilters.filter((value) => statusFilterOptions.some((option) => option.value === value));
  /** 任意维度已选择时，漏斗与清除操作同步显示已筛选。 */
  const hasStatusFilter = activeStatusFilters.length > 0;
  /** 任务状态与直属会话沿用并集，未选择该维度时不限。 */
  const hasTaskStatusFilter = activeStatusFilters.some((value) => value === 'project' || value.startsWith('status:'));
  /** 运行状态独立多选，再与任务维度取交集。 */
  const activeRunStatusFilters = activeStatusFilters.filter((value) => value.startsWith('run:'));
  /** 直接从当前权威投影派生筛选结果，状态更新无需额外同步。 */
  function matchesConversationRunStatus(conversation: NativeConversationChoice): boolean {
    return activeRunStatusFilters.length === 0 || activeRunStatusFilters.includes(`run:${taskRunStatusFromConversationTreeState(resolveConversationTreeRuntimeState(conversation, props.conversationStates))}`);
  }
  /** 状态筛选或同任务去重生效时，漏斗和空项目选项都反映当前筛选。 */
  const hasConversationFilter = hasStatusFilter || latestConversationOnly;
  /** 已选状态只出现在漏斗悬停提示中，不额外占用侧栏空间。 */
  const statusFilterLabel = hasStatusFilter
    ? statusFilterOptions
        .filter((option) => activeStatusFilters.includes(option.value))
        .map((option) => option.label)
        .join(props.appLanguage === 'zh-CN' ? '、' : ', ')
    : copy.allConversations;
  /** 上游已按阶段时间倒序；先取每个任务首条，再筛选运行状态、搜索和分页，避免旧会话重新出现。 */
  const filteredConversationGroups = props.conversationGroups.map((group) => ({
    ...group,
    conversations: !hasTaskStatusFilter || activeStatusFilters.includes('project') ? group.conversations?.filter(matchesConversationRunStatus) : [],
    tasks: (!hasTaskStatusFilter ? group.tasks : group.tasks.filter((task) => activeStatusFilters.includes(`status:${task.managementStatus}`))).map((task) => ({
      ...task,
      conversations: (latestConversationOnly ? task.conversations.slice(0, 1) : task.conversations).filter(matchesConversationRunStatus),
    })),
  }));
  /** 空项目是否隐藏由独立显示选项决定；全部模式仍保留空项目。 */
  const visibleProjects = props.projects.filter((project) => {
    /** 搜索与列表渲染共用已筛选的数据，不能由被筛掉的会话撑起空项目。 */
    const group = filteredConversationGroups.find((candidate) => candidate.projectId === project.id);
    /** 项目直属会话与符合状态的任务会话。 */
    const conversations = [...(group?.conversations ?? []), ...(group?.tasks.flatMap((task) => task.conversations) ?? [])];
    if (hasConversationFilter && hideEmptyFilteredProjects && conversations.length === 0) return false;
    /** 沿用项目名称、目录和会话显示标题的大小写不敏感搜索。 */
    const query = projectSearchQuery.trim().toLocaleLowerCase();
    return (
      !query ||
      project.name.toLocaleLowerCase().includes(query) ||
      project.localPath.toLocaleLowerCase().includes(query) ||
      conversations.some((conversation) =>
        conversationDisplayTitle(conversation.title, group?.tasks.find((task) => task.taskId === conversation.taskId)?.taskTitle, props.appLanguage)
          .toLocaleLowerCase()
          .includes(query),
      )
    );
  });
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
        <strong className="project-sidebar-brand">Zeus</strong>
        <button type="button" className="project-quick-action" onClick={props.onCreateConversation} disabled={!props.activeProjectId}>
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M4.2 14.9 4.8 11 12.6 3.2a2 2 0 0 1 2.8 0l1.4 1.4a2 2 0 0 1 0 2.8L9 15.2l-3.9.6Z" />
              <path d="m11.4 4.4 4.2 4.2" />
            </svg>
          </span>
          <span className="project-quick-action-label">{copy.newChat}</span>
        </button>
        <button
          type="button"
          className={`project-quick-action${props.activeNavTarget === 'automations' ? ' is-active' : ''}`}
          aria-current={props.activeNavTarget === 'automations' ? 'page' : undefined}
          onClick={() => props.onNavigate('automations')}
        >
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <circle cx="10" cy="10" r="6.5" />
              <path d="M10 6.2V10l2.7 1.8M4.2 3.8l1.5 1.5M15.8 3.8l-1.5 1.5" />
            </svg>
          </span>
          <span className="project-quick-action-label">{props.appLanguage === 'zh-CN' ? '自动化' : 'Automations'}</span>
        </button>
        <button type="button" className={`project-quick-action${props.activeNavTarget === 'skills' ? ' is-active' : ''}`} aria-current={props.activeNavTarget === 'skills' ? 'page' : undefined} onClick={() => props.onNavigate('skills')}>
          <span className="project-quick-action-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" focusable="false">
              <path d="M10 2.7 11.5 7l4.5 1.5-4.5 1.6-1.5 4.3-1.5-4.3L4 8.5 8.5 7 10 2.7Z" />
              <path d="m15.2 13 .7 2 .1.1 2.1.7-2.1.8-.8 2.1-.7-2.1-2.1-.8 2.1-.7.7-2Z" />
            </svg>
          </span>
          <span className="project-quick-action-label">{copy.skills}</span>
        </button>
      </nav>
      <section className="project-sidebar-list zeus-source-list" role="navigation" data-source-list-keyboard="vertical" aria-label={copy.projectListLabel} onKeyDown={handleSourceListKeyboardNavigation}>
        <div className="project-sidebar-heading">
          <label className="project-sidebar-search-field" onKeyDown={handleProjectSearchKeyDown}>
            <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <circle cx="8.8" cy="8.8" r="5.4" />
              <path d="m13 13 3.4 3.4" />
            </svg>
            <input type="search" aria-label={copy.search} placeholder={copy.search} value={projectSearchQuery} onChange={(event) => setProjectSearchQuery(event.currentTarget.value)} />
          </label>
          <span className="project-sidebar-heading-actions">
            <ZeusSelect
              ariaLabel={copy.filterConversationsByTaskStatus}
              value={activeStatusFilters[0] ?? statusFilterOptions[0]!.value}
              selectedValues={activeStatusFilters}
              options={statusFilterOptions}
              onChange={(value) => {
                updateConversationFilters({ conversationStatusFilters: activeStatusFilters.includes(value) ? activeStatusFilters.filter((status) => status !== value) : [...activeStatusFilters, value] });
                setVisibleConversationCountByProject({});
              }}
              triggerIcon={<Funnel aria-hidden="true" weight={hasConversationFilter ? 'fill' : 'regular'} />}
              triggerClassName={`project-conversation-filter-button${hasConversationFilter ? ' is-filtered' : ''}`}
              triggerTitle={`${copy.filterConversationsByTaskStatus}: ${statusFilterLabel}${latestConversationOnly ? ` · ${copy.latestConversationOnly}` : ''}`}
              searchable={false}
              hideSelectedLabel
              popoverClassName="project-conversation-filter-popover"
              popoverMinWidth={248}
              header={
                <>
                  <span>{copy.conversationFilterTitle}</span>
                  <button
                    type="button"
                    className="project-conversation-filter-clear"
                    disabled={!hasStatusFilter}
                    onClick={() => {
                      updateConversationFilters({ conversationStatusFilters: [] });
                      setVisibleConversationCountByProject({});
                    }}
                  >
                    {copy.clearConversationSelection}
                  </button>
                </>
              }
              footer={
                <>
                  <label className="project-conversation-filter-display" title={copy.hideEmptyFilteredProjects}>
                    <span>{copy.hideEmptyFilteredProjectsLabel}</span>
                    <span className="settings-switch-state">
                      <input
                        className="native-switch-input"
                        type="checkbox"
                        role="switch"
                        aria-label={copy.hideEmptyFilteredProjects}
                        checked={hideEmptyFilteredProjects}
                        onChange={(event) => updateConversationFilters({ hideEmptyFilteredProjects: event.currentTarget.checked })}
                      />
                      <span className="native-switch-track" aria-hidden="true" />
                    </span>
                  </label>
                  <label className="project-conversation-filter-display">
                    <span>{copy.latestConversationOnly}</span>
                    <span className="settings-switch-state">
                      <input
                        className="native-switch-input"
                        type="checkbox"
                        role="switch"
                        aria-label={copy.latestConversationOnly}
                        checked={latestConversationOnly}
                        onChange={(event) => {
                          updateConversationFilters({ latestConversationOnly: event.currentTarget.checked });
                          setVisibleConversationCountByProject({});
                        }}
                      />
                      <span className="native-switch-track" aria-hidden="true" />
                    </span>
                  </label>
                </>
              }
              size="compact"
            />
            <button type="button" className="project-add-button" aria-label={copy.addProject} title={copy.addProject} onClick={props.onCreateProject} disabled={!props.canCreateProject} {...controlBusyProps(props.createProjectBusy)}>
              <Plus aria-hidden="true" weight="regular" />
            </button>
          </span>
        </div>
        {props.projects.length === 0 ? null : visibleProjects.length === 0 ? (
          <section className="project-inline-recovery-row project-search-empty-row" aria-label={hasConversationFilter ? copy.noConversationMatches : copy.noProjectMatches}>
            <span className="project-inline-recovery-copy">
              <strong>{hasConversationFilter ? copy.noConversationMatches : copy.noProjectMatches}</strong>
            </span>
          </section>
        ) : (
          visibleProjects.map((project) => {
            const isActiveProject = project.id === props.activeProjectId && props.activeNavTarget !== 'settings' && props.activeNavTarget !== 'skills' && props.activeNavTarget !== 'automations';
            const pinned = props.pinnedProjectIds.includes(project.id);
            const expanded = !props.collapsedProjectIds.includes(project.id);
            const menuOpen = openProjectMenuIds.has(project.id);
            const menuClosing = closingProjectMenuIds.has(project.id);
            const menuVisible = menuOpen || menuClosing;
            const menuPosition = projectMenuPositions.get(project.id);
            const conversationGroup = filteredConversationGroups.find((group) => group.projectId === project.id);
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
                  inert={menuClosing}
                  aria-hidden={menuClosing}
                  onTransitionEnd={(event) => {
                    if (menuClosing && event.target === event.currentTarget && event.propertyName === 'opacity') closeProjectMoreMenu(project.id);
                  }}
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
                      onClick={() => toggleProjectCollapsed(project.id, expanded)}
                    >
                      <span aria-hidden="true">
                        <CaretRight weight="regular" />
                      </span>
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
                        <GearSix aria-hidden="true" weight="regular" />
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
                          <DotsThreeVertical aria-hidden="true" weight="regular" />
                        </button>
                      </div>
                      {projectMorePopover ? (projectMenuPortalHost ? createPortal(projectMorePopover, projectMenuPortalHost) : projectMorePopover) : null}
                    </>
                  }
                />
                {conversationGroup && ((conversationGroup.conversations?.length ?? 0) > 0 || conversationGroup.tasks.some((task) => task.conversations.length > 0)) ? (
                  <Collapsible open={expanded}>
                    <div className="project-sidebar-conversations">
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
                        visibleConversationCount={visibleConversationCountByProject[project.id] ?? defaultVisibleConversationCount}
                        onShowMore={() =>
                          setVisibleConversationCountByProject((current) => ({
                            ...current,
                            [project.id]: (current[project.id] ?? defaultVisibleConversationCount) + additionalVisibleConversationCount,
                          }))
                        }
                      />
                    </div>
                  </Collapsible>
                ) : null}
              </section>
            );
          })
        )}
      </section>

      <AutomaticUpdateIndicatorButton state={props.automaticUpdateIndicator} language={props.appLanguage} onOpen={props.onOpenAutomaticUpdate} />
      <section className="project-global-settings" aria-label={copy.globalSettingsLabel}>
        <button type="button" className={props.activeNavTarget === 'settings' ? 'active' : ''} onClick={() => props.onNavigate('settings')}>
          <span aria-hidden="true">
            <GearSix weight="regular" />
          </span>
          {copy.settings}
        </button>
      </section>
      <MotionPresence>
        {projectRenameTarget ? (
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
        ) : null}
      </MotionPresence>
    </aside>
  );
}

/** 侧栏只展示可用更新和处理进度；失败详情留在更新窗口，避免持续打扰工作。 */
export function AutomaticUpdateIndicatorButton(props: { state: AutomaticUpdateIndicatorState | null; language: AppLanguage; onOpen: () => void }) {
  if (!props.state || props.state.phase === 'idle' || props.state.phase === 'failed') return null;
  const zh = props.language === 'zh-CN';
  const version = props.state.latestVersion ?? props.state.currentVersion;
  const progress = props.state.progress === undefined ? null : `${Math.min(100, Math.floor(Math.max(0, props.state.progress) * 100))}%`;
  const label =
    props.state.phase === 'ready'
      ? zh
        ? `Zeus ${version} 等待重启`
        : `Zeus ${version} ready to restart`
      : props.state.phase === 'downloaded'
        ? zh
          ? `Zeus ${version} 等待手动安装`
          : `Zeus ${version} ready for manual installation`
        : props.state.phase === 'manual'
          ? zh
            ? `Zeus ${version} · 下载新版`
            : `Zeus ${version} · Download new version`
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
    props.state.phase === 'ready' || props.state.phase === 'downloaded' ? (
      <CheckCircle aria-hidden="true" weight="fill" />
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
  languagePrimary: string;
  languageAdditional: string;
  packageManagers: string;
  manifestPaths: string;
  databaseConnectionName: string;
  telegramAlias: string;
  allowShell: boolean;
  allowGitWrite: boolean;
}

export function normalizeProjectConfig(config?: Partial<ProjectConfig>, projectId?: string): ProjectConfig | undefined {
  const resolvedProjectId = config?.projectId ?? projectId;
  if (!resolvedProjectId) return undefined;
  return {
    projectId: resolvedProjectId,
    serviceTierPreferences: config?.serviceTierPreferences ?? [],
    defaultModel: config?.defaultModel ?? null,
    defaultWorkMode: config?.defaultWorkMode ?? 'plan',
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
    language: { primary: 'typescript', additional: [] },
    dependencies: { packageManagers: [], manifestPaths: [] },
    vcs: { isGitRepository: false, gitRoot: null },
    database: { connectionName: null },
    telegram: { alias: null },
    security: { allowShell: false, allowGitWrite: false },
  };
  return {
    defaultModel: normalized.defaultModel ?? '',
    defaultWorkMode: normalized.defaultWorkMode,
    languagePrimary: normalized.language.primary,
    languageAdditional: normalized.language.additional.join(', '),
    packageManagers: normalized.dependencies.packageManagers.join(', '),
    manifestPaths: normalized.dependencies.manifestPaths.join(', '),
    databaseConnectionName: redactDatabaseConnectionName(normalized.database.connectionName),
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
  return connectionName;
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

export function errorToLocalUiMessage(error: unknown, language: AppLanguage): string {
  return reportApplicationError(error, { language: language === 'zh-CN' ? 'zh-CN' : 'en' });
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
