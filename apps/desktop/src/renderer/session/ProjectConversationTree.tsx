import {type KeyboardEvent, useEffect, useRef, useState} from 'react';
import {AnimatePresence, motion, useReducedMotion} from 'framer-motion';
import {ArchiveIcon as Archive} from '@phosphor-icons/react/dist/csr/Archive';
import {ChatCircleIcon as ChatCircle} from '@phosphor-icons/react/dist/csr/ChatCircle';
import {CheckCircleIcon as CheckCircle} from '@phosphor-icons/react/dist/csr/CheckCircle';
import {CircleNotchIcon as CircleNotch} from '@phosphor-icons/react/dist/csr/CircleNotch';
import {ClockIcon as Clock} from '@phosphor-icons/react/dist/csr/Clock';
import {EyeSlashIcon as EyeSlash} from '@phosphor-icons/react/dist/csr/EyeSlash';
import {FolderIcon as Folder} from '@phosphor-icons/react/dist/csr/Folder';
import {PauseCircleIcon as PauseCircle} from '@phosphor-icons/react/dist/csr/PauseCircle';
import {PlusIcon as Plus} from '@phosphor-icons/react/dist/csr/Plus';
import {ShieldCheckIcon as ShieldCheck} from '@phosphor-icons/react/dist/csr/ShieldCheck';
import {WarningIcon as Warning} from '@phosphor-icons/react/dist/csr/Warning';
import type {NativeConversationChoice, NativeConversationSnapshot, NativeSessionState} from './sessionTypes.js';
import {compareConversationStageUpdatedDesc} from './conversationOrdering.js';
import type {SessionUiLanguage} from './ThreadItemView.js';
import {conversationDisplayTitle} from './conversationDisplayTitle.js';
import {useNewItemMotionIds} from '../ui/useNewItemMotion.js';
import type {TaskAgentRunStatus} from '../apiClient.js';
import {taskAgentRunStatusLabels} from '../task/TaskRunStatusChip.js';
import {beginConversationNavigationTrace} from '../performanceTraceContext.js';

export interface ProjectConversationTaskGroup {
  taskId: string;
  taskCode: string;
  taskTitle: string;
  managementStatus: string;
  conversations: NativeConversationChoice[];
}

export interface ProjectConversationStatusDefinition {
  id: string;
  label: string;
}

export interface ProjectConversationGroup {
  projectId: string;
  projectName: string;
  conversations?: NativeConversationChoice[];
  taskStatuses: ProjectConversationStatusDefinition[];
  tasks: ProjectConversationTaskGroup[];
}

export type ConversationTreeRuntimeState = 'connecting' | 'reconnecting' | 'paused' | 'queued' | 'ready' | 'streaming' | 'pending_approval' | 'pending_user_input' | 'error' | 'legacy_readonly';

export interface ProjectConversationTreeProps {
  groups: ProjectConversationGroup[];
  selectedConversationId?: string | null;
  conversationStates?: Record<string, ConversationTreeRuntimeState>;
  onSelectConversation: (conversation: NativeConversationChoice) => void;
  onStartConversation?: (taskId: string) => void;
  onArchiveConversation?: (conversation: NativeConversationChoice) => Promise<void> | void;
  language: SessionUiLanguage;
  compactProjectLabel?: boolean;
  query?: string;
  showEmptyState?: boolean;
  visibleConversationCount?: number;
  onShowMore?: () => void;
  organization?: 'flat' | 'task_status';
  collapsedStatusIdsByProject?: Record<string, string[]>;
  onToggleStatusGroup?: (projectId: string, statusId: string) => void;
}

const labels = {
  'zh-CN': {
    aria: '项目会话',
    empty: '暂无会话',
    newThread: '新建会话',
    selectTask: '选择任务',
    ready: '会话就绪',
    connecting: '正在连接',
    reconnecting: '正在重连',
    paused: '队列已暂停',
    queued: '待发送',
    streaming: '正在响应',
    pending_approval: '等待批准',
    pending_user_input: '需要用户输入',
    error: '会话错误',
    legacy_readonly: '旧会话，只读',
    archive: '归档会话',
    archiveUnavailable: '会话仍在运行、排队或等待处理，暂时不能归档',
    archiveLegacyUnavailable: '旧版只读会话无法与 Codex 线程同步归档',
    archiving: '正在归档',
    showMore: '展开更多',
    expandStatusGroup: '展开任务状态分组',
    collapseStatusGroup: '折叠任务状态分组',
  },
  'en-US': {
    aria: 'Project conversations',
    empty: 'No conversations yet',
    newThread: 'New conversation',
    selectTask: 'Choose task',
    ready: 'Thread ready',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    paused: 'Queue paused',
    queued: 'Queued',
    streaming: 'Responding',
    pending_approval: 'Approval required',
    pending_user_input: 'User input required',
    error: 'Thread error',
    legacy_readonly: 'Legacy, read-only',
    archive: 'Archive conversation',
    archiveUnavailable: 'This conversation is running, queued, or waiting and cannot be archived yet',
    archiveLegacyUnavailable: 'Legacy read-only conversations cannot be archived together with their Codex thread',
    archiving: 'Archiving',
    showMore: 'Show more',
    expandStatusGroup: 'Expand task status group',
    collapseStatusGroup: 'Collapse task status group',
  },
} as const;

interface FlattenedConversation {
  conversation: NativeConversationChoice;
  displayTitle: string;
}

interface FlattenedStatusGroup {
  statusId: string;
  statusLabel: string;
  conversations: FlattenedConversation[];
}

interface FlattenedProjectConversations {
  project: ProjectConversationGroup;
  flatConversations: FlattenedConversation[];
  projectConversations: FlattenedConversation[];
  statusGroups: FlattenedStatusGroup[];
}

export function ProjectConversationTree(props: ProjectConversationTreeProps) {
  const copy = labels[props.language];
  const reduceMotion = useReducedMotion();
  const [archivingConversationId, setArchivingConversationId] = useState<string | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';
  const organization = props.organization ?? 'flat';
  const flattenedGroups = props.groups
    .map((project) => flattenProjectConversations(project, normalizedQuery))
    .map((group) => (normalizedQuery ? group : limitFlattenedProjectConversations(group, organization, props.visibleConversationCount)));
  const visibleConversations = flattenedGroups.flatMap((group) => {
    if (organization === 'flat') return group.flatConversations;
    const collapsedStatusIds = props.collapsedStatusIdsByProject?.[group.project.projectId] ?? [];
    return [...group.projectConversations, ...group.statusGroups.filter((statusGroup) => !collapsedStatusIds.includes(statusGroup.statusId)).flatMap((statusGroup) => statusGroup.conversations)];
  });
  const conversationIds = visibleConversations.map((entry) => conversationNavigationId(entry.conversation));
  const allConversationIds = props.groups.flatMap((project) => flattenProjectConversations(project, '').flatConversations.map((entry) => conversationNavigationId(entry.conversation)));
  const conversationLayoutDependency = allConversationIds.join('\u0000');
  const enteringConversationIds = useNewItemMotionIds(allConversationIds);
  const fallbackTabStopId = props.selectedConversationId && conversationIds.includes(props.selectedConversationId) ? null : (conversationIds[0] ?? null);

  async function archiveConversation(conversation: NativeConversationChoice): Promise<void> {
    if (!props.onArchiveConversation || archivingConversationId) return;
    setArchivingConversationId(conversation.id);
    try {
      await props.onArchiveConversation(conversation);
    } catch {
      // 错误已由上层统一展示，会话行保持原状便于用户重试。
    } finally {
      setArchivingConversationId(null);
    }
  }

  function renderConversationItems(conversations: FlattenedConversation[]) {
    return conversations.map(({ conversation, displayTitle }) => {
      const navigationId = conversationNavigationId(conversation);
      const current = navigationId === props.selectedConversationId;
      const runtimeState = props.conversationStates?.[navigationId] ?? props.conversationStates?.[conversation.id] ?? conversationTreeRuntimeStateFromConversation(conversation);
      const archiveAvailable = conversationCanBeArchived(runtimeState);
      const archiveUnavailableReason = runtimeState === 'legacy_readonly' ? copy.archiveLegacyUnavailable : copy.archiveUnavailable;
      const archiving = archivingConversationId === conversation.id;
      const archiveLabel = archiving ? copy.archiving : archiveAvailable ? copy.archive : archiveUnavailableReason;
      return (
        <motion.li
          className="session-conversation-tree-item"
          key={navigationId}
          layout={reduceMotion ? false : 'position'}
          layoutDependency={conversationLayoutDependency}
          initial={false}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto', overflow: 'visible' }}
          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
          transition={reduceMotion ? { duration: 0 } : { layout: { duration: 0.16, ease: [0.22, 1, 0.36, 1] }, opacity: { duration: 0.12 }, height: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
          data-motion-surface="list-item"
          data-motion-state={enteringConversationIds.has(navigationId) ? 'entering' : undefined}
        >
          <button
            type="button"
            className={`session-conversation-tree-row${current ? ' is-current' : ''}`}
            aria-current={current ? 'page' : undefined}
            tabIndex={current || navigationId === fallbackTabStopId ? 0 : -1}
            data-conversation-tree-item="true"
            data-conversation-runtime-state={runtimeState}
            onClick={() => {
              if (!current && conversation.transportKind === 'codex_native' && !conversation.taskPushCreating) {
                beginConversationNavigationTrace(conversation.projectId, conversation.id);
              }
              props.onSelectConversation(conversation);
            }}
          >
            <span className="session-conversation-title" title={displayTitle}>
              {displayTitle}
            </span>
            <ConversationRowState conversation={conversation} runtimeState={runtimeState} language={props.language} />
          </button>
          {props.onArchiveConversation && !conversation.taskPushCreating ? (
            <button
              type="button"
              className="session-conversation-archive-button"
              aria-disabled={!archiveAvailable || archiving}
              aria-label={`${archiveLabel}: ${displayTitle}`}
              title={archiveLabel}
              onClick={() => {
                if (archiveAvailable && !archiving) void archiveConversation(conversation);
              }}
            >
              {archiving ? <CircleNotch className="session-conversation-archive-spinner" aria-hidden="true" /> : <Archive aria-hidden="true" />}
            </button>
          ) : null}
        </motion.li>
      );
    });
  }

  return (
    <nav className="session-project-conversation-tree" aria-label={copy.aria} onKeyDown={handleTreeKeyDown}>
      {flattenedGroups.map(({ project, flatConversations, projectConversations, statusGroups }) => (
        <section className="session-conversation-project-group" key={project.projectId} aria-label={project.projectName}>
          {!props.compactProjectLabel && props.onStartConversation ? <ProjectConversationHeader project={project} language={props.language} onStartConversation={props.onStartConversation} /> : null}
          {organization === 'flat' ? (
            <ul className="session-conversation-project-items">
              <AnimatePresence initial={false}>{renderConversationItems(flatConversations)}</AnimatePresence>
            </ul>
          ) : (
            <>
              {projectConversations.length > 0 ? (
                <ul className="session-conversation-project-items session-conversation-project-direct-items">
                  <AnimatePresence initial={false}>{renderConversationItems(projectConversations)}</AnimatePresence>
                </ul>
              ) : null}
              {statusGroups.map((statusGroup) => {
                const collapsed = props.collapsedStatusIdsByProject?.[project.projectId]?.includes(statusGroup.statusId) ?? false;
                const actionLabel = `${collapsed ? copy.expandStatusGroup : copy.collapseStatusGroup}: ${statusGroup.statusLabel}`;
                return (
                  <section className="session-conversation-status-group" key={statusGroup.statusId} aria-label={statusGroup.statusLabel}>
                    <button
                      type="button"
                      className="session-conversation-status-group-toggle"
                      aria-expanded={!collapsed}
                      aria-label={actionLabel}
                      title={actionLabel}
                      onClick={() => props.onToggleStatusGroup?.(project.projectId, statusGroup.statusId)}
                    >
                      <span className="session-conversation-status-group-chevron" aria-hidden="true">
                        ›
                      </span>
                      <strong>{statusGroup.statusLabel}</strong>
                    </button>
                    <AnimatePresence initial={false}>
                      {!collapsed ? (
                        <motion.div
                          className="session-conversation-status-group-content"
                          initial={reduceMotion ? false : { opacity: 0, height: 0, overflow: 'hidden' }}
                          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, height: 'auto', overflow: 'visible' }}
                          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } }}
                          transition={reduceMotion ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
                        >
                          <ul className="session-conversation-project-items">{renderConversationItems(statusGroup.conversations)}</ul>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </section>
                );
              })}
            </>
          )}
          {visibleConversationCount({ flatConversations, projectConversations, statusGroups }, organization) === 0 && props.showEmptyState !== false ? <p className="session-conversation-project-empty">{copy.empty}</p> : null}
          {!normalizedQuery && props.onShowMore && visibleConversationCount({ flatConversations, projectConversations, statusGroups }, organization) < flattenProjectConversations(project, '').flatConversations.length ? (
            <button type="button" className="session-conversation-show-more" onClick={props.onShowMore}>
              {copy.showMore}
            </button>
          ) : null}
        </section>
      ))}
    </nav>
  );
}

function conversationNavigationId(conversation: NativeConversationChoice): string {
  return conversation.navigationId ?? conversation.id;
}

export function conversationCanBeArchived(runtimeState: ConversationTreeRuntimeState): boolean {
  return runtimeState === 'ready' || runtimeState === 'paused' || runtimeState === 'error';
}

function ProjectConversationHeader(props: { project: ProjectConversationGroup; language: SessionUiLanguage; onStartConversation: (taskId: string) => void }) {
  const copy = labels[props.language];
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [menuOpen]);

  function openMenu(): void {
    setMenuOpen(true);
    window.requestAnimationFrame(() => itemRefs.current[0]?.focus());
  }

  function handleMenuKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      setMenuOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Home') items[0]?.focus();
    else if (event.key === 'End') items.at(-1)?.focus();
    else {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      items[(current + delta + items.length) % items.length]?.focus();
    }
  }

  return (
    <header className="session-conversation-project-header">
      <span className="session-conversation-project-label">
        <Folder aria-hidden="true" />
        <strong>{props.project.projectName}</strong>
      </span>
      <div ref={rootRef} className="session-conversation-create-control">
        <button
          ref={triggerRef}
          type="button"
          aria-label={`${copy.newThread}: ${props.project.projectName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={props.project.tasks.length === 0}
          onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
        >
          <Plus aria-hidden="true" />
        </button>
        <div className="session-conversation-task-menu" role="menu" aria-label={copy.selectTask} hidden={!menuOpen} onKeyDown={handleMenuKeyDown}>
          {props.project.tasks.map((task, index) => (
            <button
              key={task.taskId}
              ref={(element) => {
                itemRefs.current[index] = element;
              }}
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                props.onStartConversation(task.taskId);
              }}
            >
              <strong>{task.taskCode}</strong>
              <span>{task.taskTitle}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

function ConversationRowState(props: { conversation: NativeConversationChoice; runtimeState: ConversationTreeRuntimeState; language: SessionUiLanguage }) {
  const runStatus = taskRunStatusFromConversationTreeState(props.runtimeState);
  if (runStatus !== 'idle') {
    return <ConversationStatusIcon status={runStatus} label={taskAgentRunStatusLabels[props.language][runStatus]} />;
  }
  if (props.conversation.hasUnreadAttention) {
    if (props.conversation.attentionKind === 'failed') return <ConversationStatusIcon status="failed" label={taskAgentRunStatusLabels[props.language].failed} />;
    if (props.conversation.attentionKind === 'interrupted') return <ConversationStatusIcon status="paused" label={taskAgentRunStatusLabels[props.language].paused} />;
    if (props.conversation.attentionKind === 'completed') return <ConversationStatusIcon status="completed" label={props.language === 'zh-CN' ? '已完成' : 'Completed'} />;
    return <ConversationStatusIcon status="unread" label={props.language === 'zh-CN' ? '有未读回复' : 'Unread reply'} />;
  }
  return null;
}

type ConversationStatusIconKind = TaskAgentRunStatus | 'completed' | 'unread';

function ConversationStatusIcon(props: { status: ConversationStatusIconKind; label: string }) {
  let icon = null;
  if (props.status === 'connecting' || props.status === 'reconnecting' || props.status === 'running') {
    icon = <CircleNotch className="session-conversation-state-spinner" aria-hidden="true" />;
  } else if (props.status === 'waiting_user') {
    icon = <ChatCircle aria-hidden="true" />;
  } else if (props.status === 'waiting_approval') {
    icon = <ShieldCheck aria-hidden="true" />;
  } else if (props.status === 'paused') {
    icon = <PauseCircle aria-hidden="true" />;
  } else if (props.status === 'failed') {
    icon = <Warning aria-hidden="true" />;
  } else if (props.status === 'completed') {
    icon = <CheckCircle aria-hidden="true" />;
  } else if (props.status === 'legacy_readonly') {
    icon = <EyeSlash aria-hidden="true" />;
  } else if (props.status === 'not_started' || props.status === 'idle') {
    icon = <Clock aria-hidden="true" />;
  }

  return (
    <span className={`session-conversation-status-icon is-${props.status}`} role="img" aria-label={props.label} title={props.label}>
      {icon}
    </span>
  );
}

function taskRunStatusFromConversationTreeState(runtimeState: ConversationTreeRuntimeState): TaskAgentRunStatus {
  if (runtimeState === 'connecting') return 'connecting';
  if (runtimeState === 'reconnecting') return 'reconnecting';
  if (runtimeState === 'streaming' || runtimeState === 'queued') return 'running';
  if (runtimeState === 'pending_user_input') return 'waiting_user';
  if (runtimeState === 'pending_approval') return 'waiting_approval';
  if (runtimeState === 'paused') return 'paused';
  if (runtimeState === 'error') return 'failed';
  if (runtimeState === 'legacy_readonly') return 'legacy_readonly';
  return 'idle';
}

function flattenProjectConversations(project: ProjectConversationGroup, normalizedQuery: string): FlattenedProjectConversations {
  const matchesQuery = (entry: FlattenedConversation) => !normalizedQuery || entry.displayTitle.toLocaleLowerCase().includes(normalizedQuery);
  const projectConversations = (project.conversations ?? [])
    .map((conversation): FlattenedConversation => ({ conversation, displayTitle: conversationDisplayTitle(conversation.title) }))
    .filter(matchesQuery)
    .sort((left, right) => compareConversationStageUpdatedDesc(left.conversation, right.conversation));
  const statusDefinitions = [...project.taskStatuses];
  const statusLabels = new Map(statusDefinitions.map((status) => [status.id, status.label]));
  const taskConversations = project.tasks.flatMap((task) => {
    if (!statusLabels.has(task.managementStatus)) {
      statusDefinitions.push({ id: task.managementStatus, label: task.managementStatus });
      statusLabels.set(task.managementStatus, task.managementStatus);
    }
    return task.conversations
      .map((conversation): FlattenedConversation & { managementStatus: string } => ({
        conversation,
        displayTitle: conversationDisplayTitle(conversation.title, task.taskTitle),
        managementStatus: task.managementStatus,
      }))
      .filter(matchesQuery);
  });
  const statusGroups = statusDefinitions
    .map(
      (status): FlattenedStatusGroup => ({
        statusId: status.id,
        statusLabel: status.label,
        conversations: taskConversations.filter((entry) => entry.managementStatus === status.id).sort((left, right) => compareConversationStageUpdatedDesc(left.conversation, right.conversation)),
      }),
    )
    .filter((statusGroup) => statusGroup.conversations.length > 0);
  const flatConversations = [...projectConversations, ...taskConversations].sort((left, right) => compareConversationStageUpdatedDesc(left.conversation, right.conversation));
  return { project, flatConversations, projectConversations, statusGroups };
}

function limitFlattenedProjectConversations(group: FlattenedProjectConversations, organization: 'flat' | 'task_status', maxCount?: number): FlattenedProjectConversations {
  if (maxCount === undefined) return group;
  const safeMaxCount = Math.max(0, maxCount);
  if (organization === 'flat') return { ...group, flatConversations: group.flatConversations.slice(0, safeMaxCount) };

  let remaining = safeMaxCount;
  const projectConversations = group.projectConversations.slice(0, remaining);
  remaining -= projectConversations.length;
  const statusGroups = group.statusGroups
    .map((statusGroup) => {
      const conversations = statusGroup.conversations.slice(0, remaining);
      remaining -= conversations.length;
      return { ...statusGroup, conversations };
    })
    .filter((statusGroup) => statusGroup.conversations.length > 0);
  return { ...group, flatConversations: group.flatConversations.slice(0, safeMaxCount), projectConversations, statusGroups };
}

function visibleConversationCount(group: Pick<FlattenedProjectConversations, 'flatConversations' | 'projectConversations' | 'statusGroups'>, organization: 'flat' | 'task_status'): number {
  if (organization === 'flat') return group.flatConversations.length;
  return group.projectConversations.length + group.statusGroups.reduce((count, statusGroup) => count + statusGroup.conversations.length, 0);
}

/** 将当前已连接 controller 的权威状态映射为全局 source tree 的可读状态。 */
export function conversationTreeRuntimeStateFromSession(state: NativeSessionState): ConversationTreeRuntimeState {
    if (state.conversationState === 'turn_failed') return 'error';
    // 侧栏表达会话本身的运行态，不表达当前窗口读取本地快照或建立实时订阅的短暂状态。
    // 已有权威快照时，即使视图正在水合/重连，也继续投影任务、队列和待处理请求的真实状态。
    if (!state.snapshot) {
        if (state.transportState === 'failed') return 'error';
        if (state.transportState === 'reconnecting') return 'reconnecting';
        if (state.transportState === 'connecting' || state.transportState === 'hydrating' || state.transportState === 'disconnected') return 'connecting';
    }
  if (state.snapshot?.providerState === 'archived' || (state.queue?.state.type === 'paused' && state.queue.state.reason === 'provider_archived')) {
    return (state.queue?.submissions.length ?? 0) > 0 ? 'queued' : 'ready';
  }
  if (state.queue?.state.type === 'paused' && state.queue.state.reason === 'recovery_required') return 'error';
  const pendingRequest = state.pendingRequests.find((request) => request.status === 'pending');
  if (pendingRequest?.type === 'request_user_input' || pendingRequest?.type === 'userInput' || state.conversationState === 'waiting_user_input') return 'pending_user_input';
  if (pendingRequest || state.conversationState === 'waiting_approval') return 'pending_approval';
  if (state.queue?.state.type === 'paused') return 'paused';
  if (
    state.conversationState === 'starting_turn' ||
    state.conversationState === 'active_prework' ||
    state.conversationState === 'active_final_answer' ||
    state.conversationState === 'interrupt_confirm' ||
    state.conversationState === 'interrupting'
  )
    return 'streaming';
  return 'ready';
}

/** 后台会话没有独立 controller 时，使用服务端完整快照恢复同一套列表状态。 */
export function conversationTreeRuntimeStateFromSnapshot(snapshot: NativeConversationSnapshot): ConversationTreeRuntimeState {
  const fallback = conversationTreeRuntimeStateFromConversation(snapshot);
  if (fallback === 'legacy_readonly' || fallback === 'error' || fallback === 'connecting' || fallback === 'reconnecting') return fallback;
  if (snapshot.queue.state.type === 'paused') {
    if (snapshot.queue.state.reason === 'provider_archived') return snapshot.queue.submissions.length > 0 ? 'queued' : 'ready';
    if (snapshot.queue.state.reason === 'recovery_required') return 'error';
    return 'paused';
  }
  const pendingRequest = snapshot.requests.find((request) => request.status === 'pending');
  if (pendingRequest?.type === 'request_user_input' || pendingRequest?.type === 'userInput' || snapshot.pendingRequestKind === 'user_input') return 'pending_user_input';
  if (pendingRequest || snapshot.pendingRequestKind === 'approval') return 'pending_approval';
  if (snapshot.queue.state.type === 'waiting') return snapshot.queue.state.reason === 'user_input' ? 'pending_user_input' : 'pending_approval';
  if (snapshot.queue.state.type === 'dispatching') return 'queued';
  if (snapshot.queue.state.type === 'active') return 'streaming';
  if (snapshot.queue.submissions.some((submission) => submission.status === 'queued')) return 'queued';
  return fallback;
}

export function conversationTreeRuntimeStateFromConversation(
  conversation: Pick<NativeConversationChoice, 'status' | 'transportKind' | 'providerState' | 'pendingRequestKind' | 'listRuntimeState'> & { readOnly?: boolean },
): ConversationTreeRuntimeState {
  if (conversation.listRuntimeState) return conversation.listRuntimeState;
  if (conversation.transportKind !== 'codex_native') return 'legacy_readonly';
  const providerState = `${conversation.providerState ?? ''}`.toLocaleLowerCase();
  const recordState = conversation.status.toLocaleLowerCase();
  if (providerState.includes('failed') || providerState.includes('error') || recordState.includes('failed') || recordState.includes('error')) return 'error';
  if (providerState.includes('reconnect')) return 'reconnecting';
  if (providerState.includes('connect') || providerState.includes('hydrat') || providerState.includes('disconnected')) return 'connecting';
  if (providerState.includes('paused') || recordState.includes('paused')) return 'paused';
  if (conversation.pendingRequestKind === 'user_input') return 'pending_user_input';
  if (conversation.pendingRequestKind === 'approval') return 'pending_approval';
  if (providerState.includes('user_input')) return 'pending_user_input';
  if (providerState.includes('waiting')) return 'pending_approval';
  return 'ready';
}

function handleTreeKeyDown(event: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-conversation-tree-item="true"]:not(:disabled)'));
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, Math.max(0, currentIndex + 1)) : Math.max(0, currentIndex < 0 ? 0 : currentIndex - 1);
  event.preventDefault();
  const next = items[nextIndex];
  if (!next) return;
  items.forEach((item) => {
    item.tabIndex = item === next ? 0 : -1;
  });
  next.focus();
}
