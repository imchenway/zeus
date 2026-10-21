import { MotionPresence } from '../../ui/MotionPresence.js';
import { isMacOSPlatform, platformShortcutLabel } from '../../platform.js';
import { temporaryWorkspaceId, normalizeSidebarConversationFilters, sidebarConversationRunStatusGroup, sidebarConversationRunStatusGroups, type SidebarConversationFilters } from '@zeus/shared';
import { Collapsible } from '../../ui/Collapsible.js';
import { handleSourceListKeyboardNavigation } from './workspaceSupport.js';
import { type CSSProperties, type FormEvent, type ReactNode, type UIEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlarmIcon } from '@phosphor-icons/react/dist/csr/Alarm';
import { PuzzlePieceIcon } from '@phosphor-icons/react/dist/csr/PuzzlePiece';
import { FolderIcon } from '@phosphor-icons/react/dist/csr/Folder';
import { FolderOpenIcon as FolderOpen } from '@phosphor-icons/react/dist/csr/FolderOpen';
import { FolderPlusIcon as FolderPlus } from '@phosphor-icons/react/dist/csr/FolderPlus';
import { FunnelIcon as Funnel } from '@phosphor-icons/react/dist/csr/Funnel';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { UserCircleIcon } from '@phosphor-icons/react/dist/csr/UserCircle';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { PushPinIcon as PushPin } from '@phosphor-icons/react/dist/csr/PushPin';
import { PushPinSlashIcon as PushPinSlash } from '@phosphor-icons/react/dist/csr/PushPinSlash';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { SpinnerGapIcon as SpinnerGap } from '@phosphor-icons/react/dist/csr/SpinnerGap';
import { ListChecksIcon as WorkspaceTasksIcon } from '@phosphor-icons/react/dist/csr/ListChecks';
import { ChatCircleDotsIcon as ChatCircleDots } from '@phosphor-icons/react/dist/csr/ChatCircleDots';
import { type AutomaticUpdateIndicatorState } from '../../appShellBridge.js';
import {
  type ConversationTreeRuntimeState,
  type ProjectConversationGroup,
  ProjectConversationTree,
  ConversationStatusIcon,
  summarizeProjectConversationStatuses,
  resolveConversationTreeRuntimeState,
  taskRunStatusFromConversationTreeState,
} from '../../session/ProjectConversationTree.js';
import type { NativeConversationChoice } from '../../session/sessionTypes.js';
import { type AppLanguage } from './workspaceCopy.js';
import { Button } from '../../ui/Button.js';
import { ZeusSelect } from '../../ZeusSelect.js';
import { ModalPortal } from '../../ui/ModalPortal.js';
import { formatVisibleApplicationError } from '../../ui/ApplicationErrorDialog.js';
import { MenuSurface } from '../../ui/MenuSurface.js';
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

/** 项目普通会话首屏数量，进行中的会话始终展示且不占额度。 */
const defaultVisibleConversationCount = 6;
/** 每次展开更多追加的普通会话数量。 */
const additionalVisibleConversationCount = 10;
/** 项目下拉中的独立操作值，不会写入任何项目槽位。 */
const projectSlotCreateValue = '__create_new_project__';

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

/** 数字团队的三个导航入口共用前后相伴的机器人轮廓。 */
function DigitalTeamIcon() {
  return (
    <svg className="project-workspace-mode-line-icon" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path d="M8 7V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-2M13 2v2M7 6v3" />
      <rect x="2" y="9" width="10" height="9" rx="2" />
      <path d="M11 7h.01M15 7h.01M5 12.5h.01M9 12.5h.01M5 15.5h4M14 10.5h1.5" />
    </svg>
  );
}

/** 首次工作面聚焦选择工作目录。 */
export function ProjectStartGuide(props: { language: AppLanguage; busy: boolean; available: boolean; onChooseFolder: () => void }) {
  /** 引导文案沿用应用语言。 */
  const zh = props.language === 'zh-CN';
  return (
    <section className="project-start-guide" aria-labelledby="project-start-title">
      <div className="project-start-symbol" aria-hidden="true">
        <FolderOpen size={32} weight="regular" />
      </div>
      <h1 id="project-start-title">{zh ? '让想法，从这里开始' : 'Your ideas start here'}</h1>
      <div className="project-start-action">
        <Button variant="primary" size="regular" onClick={props.onChooseFolder} disabled={props.busy || !props.available} busy={props.busy}>
          <FolderPlus size={18} aria-hidden="true" />
          {zh ? '选择工作文件夹' : 'Choose working folder'}
        </Button>
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
  onStartTemporary?: () => void;
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
    <ModalPortal
      rootClassName="project-create-dialog-portal-root"
      backdropClassName="project-create-dialog-backdrop"
      dismissDisabled={interactionBusy}
      onDismiss={props.onClose}
      role="dialog"
      aria-labelledby="project-create-dialog-title"
      aria-describedby={describedBy}
    >
      <form className="project-create-dialog zeus-solid-form-surface" onSubmit={props.onSubmit} data-modal-surface="dialog">
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
                {props.form.localPath ? <small data-icon-tooltip={props.form.localPath}>{props.form.localPath}</small> : null}
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
          {props.onStartTemporary ? (
            <Button variant="secondary" size="regular" onClick={props.onStartTemporary} disabled={interactionBusy}>
              {props.copy.createTemporary}
            </Button>
          ) : null}
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
    <ModalPortal
      rootClassName="project-rename-dialog-portal-root"
      backdropClassName="project-rename-dialog-backdrop"
      dismissDisabled={props.busy}
      onDismiss={props.onClose}
      role="dialog"
      aria-labelledby="project-rename-dialog-title"
      aria-describedby={describedBy}
    >
      <form
        className="project-rename-dialog zeus-solid-form-surface"
        onSubmit={props.onSubmit}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || props.busy) return;
          event.stopPropagation();
          props.onClose();
        }}
        data-modal-surface="dialog"
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

/** 项目切换器固定在左上角，左侧活动栏保留会话、任务与全局入口。 */
export function ProjectWorkspaceNavigation(props: {
  project: ProjectRecord;
  projects: ProjectRecord[];
  onSelectProject: (project: ProjectRecord) => void;
  canCreateProject: boolean;
  createProjectBusy: boolean;
  activeNavTarget: WorkspaceViewId;
  section: ProjectWorkspaceSection;
  codeMode: ProjectCodeWorkspaceMode;
  language: AppLanguage;
  onOpen: (section: ProjectWorkspaceSection, codeMode?: ProjectCodeWorkspaceMode) => void;
  onNavigate: (target: WorkspaceViewId) => void;
  onCreateProject: () => void;
  onCreateConversation: () => void;
  conversationGroups: ProjectConversationGroup[];
  conversationStates?: Record<string, ConversationTreeRuntimeState>;
}) {
  /** 导航文案跟随当前应用语言。 */
  const zh = props.language === 'zh-CN';
  /** 会话入口支持 Option 点击创建新会话。 */
  const conversationLabel = zh ? '会话' : 'Conversations';
  const conversationTitle = zh ? '打开会话；按住 Option 点击可在当前项目创建新会话' : 'Open conversations; Option-click to create one in the current project';
  /** 各工作区的可见名称。 */
  const labels: Record<ProjectWorkspaceEntryId, string> = {
    tasks: zh ? '任务' : 'Tasks',
  };
  /** 同一套线性图标保持一致的视觉重量。 */
  const icons: Record<ProjectWorkspaceEntryId, ReactNode> = {
    tasks: <WorkspaceTasksIcon size={18} weight="regular" aria-hidden="true" />,
  };
  /** 全局工作区激活时不保留上一个项目工作区的伪选中态。 */
  const projectWorkspaceActive =
    props.activeNavTarget !== 'settings' && props.activeNavTarget !== 'skills' && props.activeNavTarget !== 'digital-employees' && props.activeNavTarget !== 'digital-teams' && props.activeNavTarget !== 'automations';
  /** 顶部允许并列打开多个项目槽位；每个槽位保留独立的项目下拉。 */
  const projectSlotSequenceRef = useRef(1);
  const projectStatuses = useMemo(() => summarizeProjectConversationStatuses(props.conversationGroups, props.conversationStates, props.language), [props.conversationGroups, props.conversationStates, props.language]);
  const [projectSlots, setProjectSlots] = useState<Array<{ id: string; projectId: string }>>(() => [{ id: 'project-slot-0', projectId: props.project.id }]);
  const projectIdsKey = props.projects.map((project) => project.id).join('\u0000');
  useEffect(() => {
    const knownProjectIds = new Set(props.projects.map((project) => project.id));
    setProjectSlots((current) => {
      const next = current.filter((slot) => !slot.projectId || knownProjectIds.has(slot.projectId));
      if (!next.some((slot) => slot.projectId === props.project.id)) {
        const emptyIndex = next.findIndex((slot) => !slot.projectId);
        if (emptyIndex >= 0) next[emptyIndex] = { ...next[emptyIndex]!, projectId: props.project.id };
        else next.push({ id: `project-slot-${projectSlotSequenceRef.current++}`, projectId: props.project.id });
      }
      return next.length === current.length && next.every((slot, index) => slot.id === current[index]?.id && slot.projectId === current[index]?.projectId) ? current : next;
    });
  }, [projectIdsKey, props.project.id, props.projects]);
  const openedProjectIds = new Set(projectSlots.map((slot) => slot.projectId).filter(Boolean));
  /** 加号也打开项目选择菜单：已打开项目直接激活，未打开项目新增槽位。 */
  const selectProjectFromAddMenu = (id: string) => {
    if (id === projectSlotCreateValue) {
      props.onCreateProject();
      return;
    }
    const project = props.projects.find((item) => item.id === id);
    if (!project) return;
    if (!openedProjectIds.has(project.id)) {
      const slotId = `project-slot-${projectSlotSequenceRef.current++}`;
      setProjectSlots((current) => [...current, { id: slotId, projectId: project.id }]);
    }
    if (project.id !== props.project.id) props.onSelectProject(project);
  };
  /** 关闭项目槽位；关闭当前项目时切换到相邻的已打开项目。 */
  const closeProjectSlot = (slotId: string) => {
    if (projectSlots.length <= 1) return;
    const closingIndex = projectSlots.findIndex((slot) => slot.id === slotId);
    const closingSlot = closingIndex >= 0 ? projectSlots[closingIndex] : undefined;
    if (!closingSlot) return;
    const nextSlots = projectSlots.filter((slot) => slot.id !== slotId);
    setProjectSlots(nextSlots);
    if (closingSlot.projectId !== props.project.id) return;
    const replacementSlot = nextSlots[closingIndex] ?? nextSlots[closingIndex - 1];
    const replacementProject = replacementSlot ? props.projects.find((project) => project.id === replacementSlot.projectId) : undefined;
    if (replacementProject) props.onSelectProject(replacementProject);
  };
  return (
    <>
      <header className="project-workspace-project-switcher" aria-label={props.project.name}>
        <div className="project-workspace-project-switcher-leading">
          <nav className="project-workspace-project-slots" aria-label={zh ? '已打开的项目' : 'Open projects'}>
            {projectSlots.map((slot, index) => {
              const slotProject = props.projects.find((project) => project.id === slot.projectId);
              const active = slotProject?.id === props.project.id;
              const emptyValue = `__empty_project_slot_${slot.id}`;
              const projectStatus = projectStatuses.get(slot.projectId);
              const selectLabel = slotProject ? (zh ? `选择项目 ${slotProject.name}` : `Select project ${slotProject.name}`) : zh ? '尚未选择项目' : 'No project selected';
              return (
                <span key={slot.id} className={`project-workspace-project-slot${active ? ' is-active' : ''}`} data-project-slot-id={slot.id}>
                  <button
                    type="button"
                    className="project-workspace-project-slot-primary"
                    aria-label={projectStatus ? `${selectLabel}，${projectStatus.label}` : selectLabel}
                    data-icon-tooltip={projectStatus?.label}
                    aria-pressed={active}
                    aria-disabled={!slotProject || undefined}
                    onClick={() => {
                      if (slotProject && slotProject.id !== props.project.id) props.onSelectProject(slotProject);
                    }}
                  />
                  <ZeusSelect
                    ariaLabel={zh ? `更改第 ${index + 1} 个项目` : `Change project ${index + 1}`}
                    value={slot.projectId || emptyValue}
                    options={[
                      ...props.projects.map((project) => ({
                        value: project.id,
                        label: project.name,
                        searchText: project.localPath,
                        disabled: project.id !== slot.projectId && openedProjectIds.has(project.id),
                      })),
                      {
                        value: projectSlotCreateValue,
                        label: zh ? '创建新项目' : 'Create new project',
                        disabled: !props.canCreateProject,
                      },
                    ]}
                    onChange={(id) => {
                      if (id === projectSlotCreateValue) {
                        props.onCreateProject();
                        return;
                      }
                      const project = props.projects.find((item) => item.id === id);
                      if (!project) return;
                      setProjectSlots((current) => current.map((item) => (item.id === slot.id ? { ...item, projectId: project.id } : item)));
                      if (project.id !== props.project.id) props.onSelectProject(project);
                    }}
                    triggerLabel={slotProject?.name ?? (zh ? '选择项目' : 'Select project')}
                    triggerIcon={projectStatus ? <ConversationStatusIcon {...projectStatus} /> : <FolderOpen size={18} aria-hidden="true" />}
                    triggerClassName="project-workspace-project-slot-trigger"
                    triggerTitle={[projectStatus?.label, zh ? '点击左侧箭头切换项目' : 'Use the left arrow to change project'].filter(Boolean).join(' · ')}
                    searchable
                    searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
                    emptyLabel={zh ? '没有可选择的项目' : 'No projects available'}
                    popoverMinWidth={260}
                    popoverArrowAlignment="start"
                    size="compact"
                  />
                  <button
                    type="button"
                    className="project-workspace-project-slot-close"
                    disabled={projectSlots.length <= 1}
                    aria-label={slotProject ? (zh ? `关闭项目 ${slotProject.name}` : `Close project ${slotProject.name}`) : zh ? '关闭项目槽位' : 'Close project slot'}
                    data-icon-tooltip={
                      projectSlots.length <= 1 ? (zh ? '至少保留一个项目' : 'Keep at least one project open') : slotProject ? (zh ? `关闭 ${slotProject.name}` : `Close ${slotProject.name}`) : zh ? '关闭项目槽位' : 'Close project slot'
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      closeProjectSlot(slot.id);
                    }}
                  >
                    <X size={15} weight="regular" aria-hidden="true" />
                  </button>
                </span>
              );
            })}
          </nav>
          <ZeusSelect
            className="project-workspace-add-project-select"
            ariaLabel={zh ? '打开项目菜单' : 'Open project menu'}
            value={props.project.id}
            options={[
              ...props.projects.map((project) => ({ value: project.id, label: project.name, searchText: project.localPath })),
              {
                value: projectSlotCreateValue,
                label: zh ? '创建新项目' : 'Create new project',
                disabled: !props.canCreateProject,
              },
            ]}
            onChange={selectProjectFromAddMenu}
            triggerIcon={<Plus size={18} weight="regular" aria-hidden="true" />}
            triggerClassName="project-workspace-add-project"
            triggerTitle={zh ? '打开项目菜单' : 'Open project menu'}
            hideSelectedLabel
            searchable
            searchPlaceholder={zh ? '搜索项目' : 'Search projects'}
            emptyLabel={zh ? '没有可选择的项目' : 'No projects available'}
            popoverMinWidth={260}
            popoverArrowAlignment="center"
            disabled={props.createProjectBusy}
            size="compact"
          />
        </div>
      </header>
      <nav className="project-workspace-mode-rail" aria-label={zh ? '项目工作区' : 'Project workspace'}>
        <button
          data-icon-tooltip={conversationLabel}
          type="button"
          className={projectWorkspaceActive && props.section === 'sessions' ? 'is-active' : ''}
          aria-label={conversationTitle}
          aria-current={projectWorkspaceActive && props.section === 'sessions' ? 'page' : undefined}
          onClick={(event) => {
            if (event.altKey) props.onCreateConversation();
            else props.onOpen('sessions');
          }}
        >
          <span className="project-workspace-mode-icon" aria-hidden="true">
            <ChatCircleDots size={18} weight="regular" />
          </span>
          <span className="project-workspace-mode-label">{conversationLabel}</span>
        </button>
        {PROJECT_WORKSPACE_ENTRIES.map((item) => {
          /** 只对当前可见的项目页面显示选中态。 */
          const active = projectWorkspaceActive && props.section === item.section;
          /** 当前入口文案。 */
          const label = labels[item.id];
          /** 读屏和提示保留快捷键说明。 */
          const shortcutLabel = platformShortcutLabel(zh ? `${label}（⌘${item.shortcutKey}）` : `${label} (⌘${item.shortcutKey})`);
          /** 浮层使用更接近桌面应用菜单的紧凑排版。 */
          const tooltipLabel = platformShortcutLabel(`${label}（⌘${item.shortcutKey}）`);
          return (
            <button
              data-icon-tooltip={tooltipLabel}
              key={item.id}
              type="button"
              className={active ? 'is-active' : ''}
              aria-label={shortcutLabel}
              aria-current={active ? 'page' : undefined}
              aria-keyshortcuts={`${isMacOSPlatform() ? 'Meta' : 'Control'}+${item.shortcutKey}`}
              onClick={() => props.onOpen(item.section, item.codeMode)}
            >
              <span className="project-workspace-mode-icon" aria-hidden="true">
                {icons[item.id]}
              </span>
              <span className="project-workspace-mode-label">{label}</span>
            </button>
          );
        })}
        <span className="project-workspace-mode-rail-spacer" aria-hidden="true" />
        <button
          data-icon-tooltip={zh ? '自动化' : 'Automations'}
          type="button"
          className={props.activeNavTarget === 'automations' ? 'is-active' : ''}
          aria-label={zh ? '自动化' : 'Automations'}
          aria-current={props.activeNavTarget === 'automations' ? 'page' : undefined}
          onClick={() => props.onNavigate('automations')}
        >
          <span className="project-workspace-mode-icon" aria-hidden="true">
            <AlarmIcon weight="regular" aria-hidden="true" data-icon-source="phosphor" />
          </span>
          <span className="project-workspace-mode-label">{zh ? '自动化' : 'Automations'}</span>
        </button>
        <button
          data-icon-tooltip={zh ? '扩展管理' : 'Extensions'}
          type="button"
          className={props.activeNavTarget === 'skills' ? 'is-active' : ''}
          aria-label={zh ? '扩展管理' : 'Extensions'}
          aria-current={props.activeNavTarget === 'skills' ? 'page' : undefined}
          onClick={() => props.onNavigate('skills')}
        >
          <span className="project-workspace-mode-icon" aria-hidden="true">
            <PuzzlePieceIcon weight="regular" aria-hidden="true" data-icon-source="phosphor" />
          </span>
          <span className="project-workspace-mode-label">{zh ? '扩展管理' : 'Extensions'}</span>
        </button>
        {/* 数字员工使用人物头像线框，并在全局导航中紧邻数字团队上方。 */}
        <button
          data-icon-tooltip={zh ? '数字员工' : 'Digital employees'}
          type="button"
          className={props.activeNavTarget === 'digital-employees' ? 'is-active' : ''}
          aria-label={zh ? '数字员工' : 'Digital employees'}
          aria-current={props.activeNavTarget === 'digital-employees' ? 'page' : undefined}
          onClick={() => props.onNavigate('digital-employees')}
        >
          <span className="project-workspace-mode-icon" aria-hidden="true">
            <UserCircleIcon size={18} weight="regular" aria-hidden="true" data-icon-source="phosphor" />
          </span>
          <span className="project-workspace-mode-label">{zh ? '数字员工' : 'Digital employees'}</span>
        </button>
        <button
          data-icon-tooltip={zh ? '数字团队' : 'Digital teams'}
          type="button"
          className={props.activeNavTarget === 'digital-teams' ? 'is-active' : ''}
          aria-label={zh ? '数字团队' : 'Digital teams'}
          aria-current={props.activeNavTarget === 'digital-teams' ? 'page' : undefined}
          onClick={() => props.onNavigate('digital-teams')}
        >
          <span className="project-workspace-mode-icon" aria-hidden="true">
            <DigitalTeamIcon />
          </span>
          <span className="project-workspace-mode-label">{zh ? '数字团队' : 'Digital teams'}</span>
        </button>
        <button
          data-icon-tooltip={zh ? '设置' : 'Settings'}
          type="button"
          className={props.activeNavTarget === 'settings' ? 'is-active' : ''}
          aria-label={zh ? '设置' : 'Settings'}
          aria-current={props.activeNavTarget === 'settings' ? 'page' : undefined}
          onClick={() => props.onNavigate('settings')}
        >
          <span className="project-workspace-mode-icon" aria-hidden="true">
            <GearSix size={18} weight="regular" />
          </span>
          <span className="project-workspace-mode-label">{zh ? '设置' : 'Settings'}</span>
        </button>
      </nav>
    </>
  );
}

/** 项目导航保留状态筛选，会话始终平铺，文字检索统一在搜索弹窗。 */
export function SidebarNav(props: {
  /** 通知状态驻留工作台，标题行仅承载全局入口。 */
  notificationCenter?: ReactNode;
  mainLayout?: 'current' | 'upstream';
  activeNavTarget: WorkspaceViewId;
  activeProjectId?: string;
  activeProjectSection: ProjectWorkspaceSection;
  activeProjectCodeMode: ProjectCodeWorkspaceMode;
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
  /** 只在真实会话客户端就绪时提供重命名能力。 */
  onRenameConversation?: (conversation: NativeConversationChoice, title: string) => Promise<void>;
  onNavigate: (target: WorkspaceViewId) => void;
  onOpenAutomaticUpdate: () => void;
  onOpenProjectSection: (project: ProjectRecord, section: ProjectWorkspaceSection, codeMode?: ProjectCodeWorkspaceMode) => void;
  onTogglePinnedProject: (projectId: string) => void;
  onToggleProjectCollapsed: (projectId: string) => void;
  onRevealProjectInFinder: (projectPath: string) => Promise<void>;
  onRenameProject: (projectId: string, displayName: string) => Promise<void>;
  onPrepareProjectDelete: (projectId: string) => void;
  onConfirmProjectDelete: (projectId: string) => void;
  pendingProjectDeleteId?: string;
}) {
  /** 项目右键菜单同一时刻只显示一项，退出动画由 MotionPresence 处理。 */
  const [projectContextMenu, setProjectContextMenu] = useState<{ projectId: string; position: { left: number; top: number } } | null>(null);
  /** 分组收起不改变每个项目原有的展开偏好。 */
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  /** 组级开关和内容保持唯一的无障碍关联。 */
  const projectsListId = useId();
  /** 已保存的数据库设置优先；旧缓存只作为首次接收来源。 */
  const [legacyConversationFilters] = useState(readLegacySidebarConversationFilters);
  /** 漏斗继续由工作台的持久设置直接控制。 */
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
  /** 项目右键菜单关闭及重命名结束后返回名称行。 */
  const projectMenuAnchorRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const previousActiveProjectIdRef = useRef(props.activeProjectId);
  /** 滚动结束后隐藏滑块；计时器不参与列表渲染。 */
  const sidebarScrollIdleTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 只在实际滚动后短暂显示，滚轮、键盘与拖动共用同一入口。 */
  function handleSidebarScroll(event: UIEvent<HTMLElement>): void {
    /** 固定本次滚动容器，异步回调不持有事件对象。 */
    const list = event.currentTarget;
    clearTimeout(sidebarScrollIdleTimerRef.current);
    list.dataset.scrolling = 'true';
    sidebarScrollIdleTimerRef.current = setTimeout(() => {
      delete list.dataset.scrolling;
    }, 1000);
  }
  useEffect(() => {
    if (previousActiveProjectIdRef.current === props.activeProjectId) return;
    previousActiveProjectIdRef.current = props.activeProjectId;
    setVisibleConversationCountByProject({});
  }, [props.activeProjectId]);
  useEffect(() => {
    return () => {
      clearTimeout(sidebarScrollIdleTimerRef.current);
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
  /** 只关闭业务状态，焦点返回和退出动画均沿用共用菜单。 */
  const closeProjectContextMenu = () => setProjectContextMenu(null);
  /** 右键和键盘共用项目菜单，焦点与窗口边界由 MenuSurface 处理。 */
  const openProjectContextMenu = (projectId: string, position: { left: number; top: number }) => {
    projectMenuAnchorRefs.current.get(projectId)?.focus({ preventScroll: true });
    setProjectContextMenu({ projectId, position });
  };
  const copy = getLanguageCopy(props.appLanguage).sidebar;
  const zh = props.appLanguage === 'zh-CN';
  const showConversationNavigation =
    props.mainLayout === 'upstream' ||
    (props.activeNavTarget !== 'skills' && props.activeNavTarget !== 'digital-employees' && props.activeNavTarget !== 'digital-teams' && props.activeNavTarget !== 'automations' && props.activeProjectSection === 'sessions');
  const scopeToCurrentProject = showConversationNavigation && props.mainLayout !== 'upstream' && props.activeProjectId;
  /** 会话侧栏严格跟随顶部选中的当前项目，其他项目通过顶部入口切换。 */
  const scopedProjects = scopeToCurrentProject ? props.projects.filter((project) => project.id === props.activeProjectId) : props.projects;
  const scopedConversationGroups = scopeToCurrentProject ? props.conversationGroups.filter((group) => group.projectId === props.activeProjectId) : props.conversationGroups;
  const contextTitle =
    props.activeNavTarget === 'automations'
      ? zh
        ? '自动化'
        : 'Automations'
      : props.activeNavTarget === 'skills'
        ? copy.skills
        : props.activeNavTarget === 'digital-employees'
          ? zh
            ? '数字员工'
            : 'Digital employees'
          : props.activeNavTarget === 'digital-teams'
            ? zh
              ? '数字团队'
              : 'Digital teams'
            : props.activeProjectSection === 'tasks'
              ? zh
                ? '任务'
                : 'Tasks'
              : props.activeProjectSection === 'code'
                ? props.activeProjectCodeMode === 'git'
                  ? 'Git'
                  : zh
                    ? '源码'
                    : 'Source'
                : zh
                  ? '会话'
                  : 'Conversations';
  const openProjectRenameDialog = (project: ProjectRecord) => {
    closeProjectContextMenu();
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
    if (projectId) window.requestAnimationFrame(() => projectMenuAnchorRefs.current.get(projectId)?.focus());
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
      window.requestAnimationFrame(() => projectMenuAnchorRefs.current.get(projectId)?.focus());
    } catch (error) {
      setProjectRenameError(errorToLocalUiMessage(error, props.appLanguage));
    } finally {
      setProjectRenameBusy(false);
    }
  };
  /** 相同状态身份合并为一个选项；项目自定义名称不同则并列显示，避免误读。 */
  const statusLabelsById = new Map<string, Set<string>>();
  for (const group of scopedConversationGroups) {
    for (const status of [...group.taskStatuses, ...group.tasks.filter((task) => !group.taskStatuses.some((status) => status.id === task.managementStatus)).map((task) => ({ id: task.managementStatus, label: task.managementStatus }))]) {
      if (!statusLabelsById.has(status.id)) statusLabelsById.set(status.id, new Set());
      statusLabelsById.get(status.id)!.add(status.label);
    }
  }
  /** 任务状态、会话运行状态与其他会话分区展示；清除选择不属于可选值。 */
  const statusFilterOptions = [
    ...Array.from(statusLabelsById, ([id, labels]) => ({ value: `status:${id}`, label: [...labels].join(' / '), group: copy.taskStatusFilterGroup })),
    ...sidebarConversationRunStatusGroups.map(({ value }) => ({ value: `run:${value}`, label: copy.conversationRunStatusGroups[value], group: copy.conversationStatusFilterGroup })),
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
  /** 从当前权威投影派生所属分组，连接、等待等细分状态更新无需额外同步。 */
  function matchesConversationRunStatus(conversation: NativeConversationChoice): boolean {
    return (
      activeRunStatusFilters.length === 0 || activeRunStatusFilters.includes(`run:${sidebarConversationRunStatusGroup(taskRunStatusFromConversationTreeState(resolveConversationTreeRuntimeState(conversation, props.conversationStates)))}`)
    );
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
  /** 上游已按阶段时间倒序；先取每个任务首条，再筛选运行状态和分页，避免旧会话重新出现。 */
  const filteredConversationGroups = scopedConversationGroups.map((group) => {
    return {
      ...group,
      conversations: !hasTaskStatusFilter || activeStatusFilters.includes('project') ? group.conversations?.filter((conversation) => matchesConversationRunStatus(conversation)) : [],
      tasks: (!hasTaskStatusFilter ? group.tasks : group.tasks.filter((task) => activeStatusFilters.includes(`status:${task.managementStatus}`))).map((task) => ({
        ...task,
        conversations: (latestConversationOnly ? task.conversations.slice(0, 1) : task.conversations).filter((conversation) => matchesConversationRunStatus(conversation)),
      })),
    };
  });
  /** 空项目是否隐藏由独立显示选项决定；全部模式仍保留空项目。 */
  const visibleProjects = scopedProjects.filter((project) => {
    /** 列表与漏斗共用已筛选的数据，不能由被筛掉的会话撑起空项目。 */
    const group = filteredConversationGroups.find((candidate) => candidate.projectId === project.id);
    /** 项目直属会话与符合状态的任务会话。 */
    const conversations = [...(group?.conversations ?? []), ...(group?.tasks.flatMap((task) => task.conversations) ?? [])];
    return !(showConversationNavigation && hasConversationFilter && hideEmptyFilteredProjects && conversations.length === 0);
  });
  const enteringProjectIds = useNewItemMotionIds(scopedProjects.map((project) => project.id));
  // macOS 避让交通灯；Windows 使用系统标题栏，内容区只保留正常内边距。
  const titlebarProtectedSidebarStyle = {
    '--zeus-hidden-titlebar-safe-top': isMacOSPlatform() ? (props.mainLayout === 'upstream' ? '44px' : '20px') : '8px',
    '--zeus-traffic-light-no-content-zone': isMacOSPlatform() ? '44px' : '0px',
    paddingBlockStart: 'var(--zeus-hidden-titlebar-safe-top, 44px)',
    paddingTop: 'var(--zeus-hidden-titlebar-safe-top, 44px)',
  } as CSSProperties;
  const projectMenuPortalHost = typeof document === 'undefined' ? undefined : (document.querySelector<HTMLElement>('.macos-ai-app.zeus-shell') ?? undefined);

  return (
    <aside className="zeus-sidebar ai-sidebar project-first-sidebar zeus-titlebar-protected-source-list" aria-label={copy.ariaLabel} style={titlebarProtectedSidebarStyle}>
      <div className="project-window-control-reserved-space" aria-hidden="true" />
      {props.mainLayout === 'upstream' ? (
        <nav className="project-quick-actions codex-source-list-quick-actions" aria-label={copy.quickActionsLabel}>
          <div className="project-sidebar-brand-row">
            <strong className="project-sidebar-brand">Zeus</strong>
            {props.notificationCenter}
          </div>
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
              <AlarmIcon weight="regular" aria-hidden="true" data-icon-source="phosphor" />
            </span>
            <span className="project-quick-action-label">{props.appLanguage === 'zh-CN' ? '自动化' : 'Automations'}</span>
          </button>
          <button type="button" className={`project-quick-action${props.activeNavTarget === 'skills' ? ' is-active' : ''}`} aria-current={props.activeNavTarget === 'skills' ? 'page' : undefined} onClick={() => props.onNavigate('skills')}>
            <span className="project-quick-action-icon" aria-hidden="true">
              <PuzzlePieceIcon weight="regular" aria-hidden="true" data-icon-source="phosphor" />
            </span>
            <span className="project-quick-action-label">{copy.skills}</span>
          </button>
          {/* 上游首页也保持员工在团队上方的相同顺序。 */}
          <button
            type="button"
            className={`project-quick-action${props.activeNavTarget === 'digital-employees' ? ' is-active' : ''}`}
            aria-current={props.activeNavTarget === 'digital-employees' ? 'page' : undefined}
            onClick={() => props.onNavigate('digital-employees')}
          >
            <span className="project-quick-action-icon" aria-hidden="true">
              <UserCircleIcon size={20} weight="regular" aria-hidden="true" data-icon-source="phosphor" />
            </span>
            <span className="project-quick-action-label">{zh ? '数字员工' : 'Digital employees'}</span>
          </button>
          <button
            type="button"
            className={`project-quick-action${props.activeNavTarget === 'digital-teams' ? ' is-active' : ''}`}
            aria-current={props.activeNavTarget === 'digital-teams' ? 'page' : undefined}
            onClick={() => props.onNavigate('digital-teams')}
          >
            <span className="project-quick-action-icon" aria-hidden="true">
              <DigitalTeamIcon />
            </span>
            <span className="project-quick-action-label">{zh ? '数字团队' : 'Digital teams'}</span>
          </button>
        </nav>
      ) : (
        <nav className="project-quick-actions codex-source-list-quick-actions project-context-actions" aria-label={contextTitle}>
          {showConversationNavigation ? (
            <button type="button" className="project-quick-action" onClick={props.onCreateConversation} disabled={props.createProjectBusy}>
              <span className="project-quick-action-icon" aria-hidden="true">
                <svg viewBox="0 0 20 20" focusable="false">
                  <path d="M4.2 14.9 4.8 11 12.6 3.2a2 2 0 0 1 2.8 0l1.4 1.4a2 2 0 0 1 0 2.8L9 15.2l-3.9.6Z" />
                  <path d="m11.4 4.4 4.2 4.2" />
                </svg>
              </span>
              <span className="project-quick-action-label">{copy.newChat}</span>
            </button>
          ) : null}
        </nav>
      )}
      {/* 项目分组始终保留新建入口，空列表也可直接创建项目。 */}
      <section className="project-sidebar-list zeus-source-list" role="navigation" data-source-list-keyboard="vertical" aria-label={copy.projectListLabel} onKeyDown={handleSourceListKeyboardNavigation} onScroll={handleSidebarScroll}>
        <div className="project-sidebar-heading">
          <span className="project-sidebar-group-title">
            <button
              type="button"
              className="project-disclosure-button"
              aria-label={projectsExpanded ? (zh ? '收起所有项目' : 'Collapse all projects') : zh ? '展开所有项目' : 'Expand all projects'}
              data-icon-tooltip={projectsExpanded ? (zh ? '收起所有项目' : 'Collapse all projects') : zh ? '展开所有项目' : 'Expand all projects'}
              aria-expanded={projectsExpanded}
              aria-controls={projectsListId}
              onClick={() => setProjectsExpanded((value) => !value)}
            >
              <span aria-hidden="true">
                <CaretRight weight="regular" />
              </span>
            </button>
            <strong>{zh ? '项目' : 'Projects'}</strong>
          </span>
          <span className="project-sidebar-heading-actions">
            {showConversationNavigation ? (
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
                triggerTooltip={props.appLanguage === 'zh-CN' ? '筛选会话' : 'Filter conversations'}
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
                    <label className="project-conversation-filter-display" data-icon-tooltip={copy.hideEmptyFilteredProjects}>
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
            ) : null}
            <button
              type="button"
              className="project-add-button"
              aria-label={copy.addProject}
              data-icon-tooltip={copy.addProject}
              onClick={props.onCreateProject}
              disabled={!props.canCreateProject}
              {...controlBusyProps(props.createProjectBusy)}
            >
              <Plus aria-hidden="true" weight="regular" />
            </button>
          </span>
        </div>
        <Collapsible open={projectsExpanded} id={projectsListId}>
          {visibleProjects.length === 0 ? (
            <p className="project-search-empty-row" role="status">
              {hasConversationFilter ? copy.noConversationMatches : copy.noProjectMatches}
            </p>
          ) : (
            visibleProjects.map((project) => {
              const isActiveProject =
                project.id === props.activeProjectId &&
                props.activeNavTarget !== 'settings' &&
                props.activeNavTarget !== 'skills' &&
                props.activeNavTarget !== 'digital-employees' &&
                props.activeNavTarget !== 'digital-teams' &&
                props.activeNavTarget !== 'automations';
              const pinned = props.pinnedProjectIds.includes(project.id);
              const expanded = !props.collapsedProjectIds.includes(project.id);
              /** 保留关闭动画的视觉表面，输入入口只取当前业务菜单。 */
              const menuOpen = projectContextMenu?.projectId === project.id;
              const menuPosition = menuOpen ? projectContextMenu.position : undefined;
              const conversationGroup = filteredConversationGroups.find((group) => group.projectId === project.id);
              const projectMorePopover =
                menuOpen && menuPosition ? (
                  <MenuSurface
                    onClose={() => closeProjectContextMenu()}
                    id={`project-more-menu-${project.id}`}
                    className="project-more-popover zeus-quiet-more-menu"
                    aria-label={`${project.name} ${copy.moreProjectActionsPrefix}`}
                    style={{ left: menuPosition.left, top: menuPosition.top }}
                  >
                    {/* 项目菜单提升到应用壳层，位置由右键或键盘触发行决定，避免被侧栏滚动容器横向裁剪。 */}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        props.onTogglePinnedProject(project.id);
                        closeProjectContextMenu();
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
                        closeProjectContextMenu();
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
                          closeProjectContextMenu();
                        }}
                      >
                        <span className="project-more-menu-icon" aria-hidden="true">
                          <X weight="bold" />
                        </span>
                        <span>{copy.confirmDeleteProject}</span>
                      </button>
                    ) : null}
                  </MenuSurface>
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
                    rowProps={{
                      ref: (row) => {
                        /** 返回焦点始终落在项目名称，展开按钮保留独立左键行为。 */
                        const anchor = row?.querySelector<HTMLButtonElement>('.zeus-source-list-row-main');
                        if (anchor) projectMenuAnchorRefs.current.set(project.id, anchor);
                        else projectMenuAnchorRefs.current.delete(project.id);
                      },
                      onContextMenu: (event) => {
                        if (project.id === temporaryWorkspaceId) return;
                        event.preventDefault();
                        event.stopPropagation();
                        /** 整行的右边缘作为锚点，不遮挡项目名称。 */
                        const rect = event.currentTarget.getBoundingClientRect();
                        openProjectContextMenu(project.id, { left: rect.right + 6, top: rect.top });
                      },
                      onKeyDown: (event) => {
                        // 标准菜单键可替代右键；普通方向键仍由项目列表处理。
                        if (project.id === temporaryWorkspaceId || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
                        event.preventDefault();
                        event.stopPropagation();
                        /** 键盘与右键在整行右侧的同一位置打开。 */
                        const rect = event.currentTarget.getBoundingClientRect();
                        openProjectContextMenu(project.id, { left: rect.right + 6, top: rect.top });
                      },
                    }}
                    level="root"
                    surface="fill"
                    expanded={showConversationNavigation ? expanded : undefined}
                    disclosure={
                      showConversationNavigation ? (
                        <button
                          data-icon-tooltip={`${expanded ? copy.collapseProjectPrefix : copy.expandProjectPrefix}${copy.labelSeparator}${project.name}`}
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
                      ) : undefined
                    }
                    disclosurePlacement={showConversationNavigation ? 'trailing' : undefined}
                    icon={<FolderIcon className="native-folder-icon zeus-avatar-token" weight="regular" aria-hidden="true" />}
                    label={<strong>{project.name}</strong>}
                    buttonProps={{
                      type: 'button',
                      tabIndex: isActiveProject ? 0 : -1,
                      'data-source-list-item': 'true',
                      'aria-label':
                        project.id === temporaryWorkspaceId ? (props.appLanguage === 'zh-CN' ? '临时会话' : 'Temporary conversations') : `${props.appLanguage === 'zh-CN' ? '项目' : 'Project'}${copy.labelSeparator}${project.name}`,
                      'aria-current': isActiveProject ? 'true' : undefined,
                      'aria-haspopup': project.id === temporaryWorkspaceId ? undefined : 'menu',
                      'aria-controls': menuOpen ? `project-more-menu-${project.id}` : undefined,
                      // 侧边栏项目名称固定作为该项目的任务页入口。
                      onClick: () => props.onOpenProjectSection(project, project.id === temporaryWorkspaceId ? 'sessions' : 'tasks'),
                    }}
                    actions={
                      project.id === temporaryWorkspaceId ? undefined : projectMenuPortalHost ? (
                        createPortal(<MotionPresence>{projectMorePopover}</MotionPresence>, projectMenuPortalHost)
                      ) : (
                        <MotionPresence>{projectMorePopover}</MotionPresence>
                      )
                    }
                  />
                  {showConversationNavigation && conversationGroup && ((conversationGroup.conversations?.length ?? 0) > 0 || conversationGroup.tasks.some((task) => task.conversations.length > 0)) ? (
                    <Collapsible open={expanded}>
                      <div className="project-sidebar-conversations">
                        {showConversationNavigation && conversationGroup ? (
                          <ProjectConversationTree
                            groups={[conversationGroup]}
                            selectedConversationId={props.selectedConversationId}
                            conversationStates={props.conversationStates}
                            onSelectConversation={props.onSelectConversation}
                            onArchiveConversation={props.onArchiveConversation}
                            onRenameConversation={props.onRenameConversation}
                            language={props.appLanguage}
                            compactProjectLabel
                            showEmptyState={false}
                            query=""
                            visibleConversationCount={visibleConversationCountByProject[project.id] ?? defaultVisibleConversationCount}
                            onShowMore={() =>
                              setVisibleConversationCountByProject((current) => ({
                                ...current,
                                [project.id]: (current[project.id] ?? defaultVisibleConversationCount) + additionalVisibleConversationCount,
                              }))
                            }
                          />
                        ) : null}
                      </div>
                    </Collapsible>
                  ) : null}
                </section>
              );
            })
          )}
        </Collapsible>
      </section>

      <footer className="project-sidebar-footer">
        <AutomaticUpdateIndicatorButton state={props.automaticUpdateIndicator} language={props.appLanguage} onOpen={props.onOpenAutomaticUpdate} />
        {/* 上游布局的全局入口已在顶部呈现，只有当前布局需要底部兜底。 */}
        {!props.activeProjectId && props.mainLayout !== 'upstream' ? (
          <nav className="project-global-tools" aria-label={copy.quickActionsLabel}>
            <button type="button" className={props.activeNavTarget === 'automations' ? 'active' : ''} aria-current={props.activeNavTarget === 'automations' ? 'page' : undefined} onClick={() => props.onNavigate('automations')}>
              <span aria-hidden="true">
                <AlarmIcon weight="regular" aria-hidden="true" data-icon-source="phosphor" />
              </span>
              {zh ? '自动化' : 'Automations'}
            </button>
            <button type="button" className={props.activeNavTarget === 'skills' ? 'active' : ''} aria-current={props.activeNavTarget === 'skills' ? 'page' : undefined} onClick={() => props.onNavigate('skills')}>
              <span aria-hidden="true">
                <PuzzlePieceIcon weight="regular" aria-hidden="true" data-icon-source="phosphor" />
              </span>
              {copy.skills}
            </button>
            {/* 无项目首页仍可管理全局员工。 */}
            <button
              type="button"
              className={props.activeNavTarget === 'digital-employees' ? 'active' : ''}
              aria-current={props.activeNavTarget === 'digital-employees' ? 'page' : undefined}
              onClick={() => props.onNavigate('digital-employees')}
            >
              <span aria-hidden="true">
                <UserCircleIcon size={20} weight="regular" aria-hidden="true" data-icon-source="phosphor" />
              </span>
              {zh ? '数字员工' : 'Digital employees'}
            </button>
            <button type="button" className={props.activeNavTarget === 'digital-teams' ? 'active' : ''} aria-current={props.activeNavTarget === 'digital-teams' ? 'page' : undefined} onClick={() => props.onNavigate('digital-teams')}>
              <span aria-hidden="true">
                <DigitalTeamIcon />
              </span>
              {zh ? '数字团队' : 'Digital teams'}
            </button>
          </nav>
        ) : null}
        {props.mainLayout === 'upstream' || !props.activeProjectId ? (
          <section className="project-global-settings" aria-label={copy.globalSettingsLabel}>
            <button type="button" className={props.activeNavTarget === 'settings' ? 'active' : ''} onClick={() => props.onNavigate('settings')}>
              <span aria-hidden="true">
                <GearSix weight="regular" />
              </span>
              {copy.settings}
            </button>
          </section>
        ) : null}
      </footer>
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
      <button type="button" data-icon-tooltip={`${props.state.detail} ${actionHint}`} aria-label={zh ? `${label}。${props.state.detail} ${actionHint}` : `${label}. ${props.state.detail} ${actionHint}`} onClick={props.onOpen}>
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

/** 连接资源和授权仍独立于工作偏好保存。 */
export interface ProjectConfigFormState {
  databaseConnectionName: string;
  allowShell: boolean;
  allowGitWrite: boolean;
}

/** 只读取项目资源，忽略历史独立偏好。 */
export function normalizeProjectConfig(config?: Partial<ProjectConfig>, projectId?: string): ProjectConfig | undefined {
  const resolvedProjectId = config?.projectId ?? projectId;
  if (!resolvedProjectId) return undefined;
  return {
    projectId: resolvedProjectId,
    vcs: { isGitRepository: config?.vcs?.isGitRepository ?? false, gitRoot: config?.vcs?.gitRoot ?? null },
    database: { connectionName: config?.database?.connectionName ?? null },
    security: { allowShell: config?.security?.allowShell ?? false, allowGitWrite: config?.security?.allowGitWrite ?? false },
  };
}

/** 将连接资源与授权转为现有操作表单。 */
export function toProjectConfigForm(config?: ProjectConfig): ProjectConfigFormState {
  return {
    databaseConnectionName: redactDatabaseConnectionName(config?.database.connectionName),
    allowShell: config?.security.allowShell ?? false,
    allowGitWrite: config?.security.allowGitWrite ?? false,
  };
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
  return formatVisibleApplicationError(error, language === 'zh-CN' ? 'zh-CN' : 'en');
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
    /** 未设置时不向新终端发送命令。 */
    terminalStartupCommand: '',
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
