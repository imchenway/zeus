import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { ClockIcon as Clock } from '@phosphor-icons/react/dist/csr/Clock';
import { EyeSlashIcon as EyeSlash } from '@phosphor-icons/react/dist/csr/EyeSlash';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { PauseCircleIcon as PauseCircle } from '@phosphor-icons/react/dist/csr/PauseCircle';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { WarningIcon as Warning } from '@phosphor-icons/react/dist/csr/Warning';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import type { NativeConversationChoice, NativeSessionState } from './sessionTypes.js';
import { compareConversationStageUpdatedDesc } from './conversationOrdering.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { conversationDisplayTitle } from './conversationDisplayTitle.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';
import type { TaskAgentRunStatus } from '../apiClient.js';
import { taskAgentRunStatusLabels } from '../task/TaskRunStatusChip.js';
import { beginConversationNavigationTrace } from '../performanceTraceContext.js';

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
  /** 普通会话的展示数量，进行中的会话不占用此额度。 */
  visibleConversationCount?: number;
  onShowMore?: () => void;
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
    paused: '处理已暂停',
    queued: '待发送',
    streaming: '正在响应',
    pending_approval: '等待批准',
    pending_user_input: '需要用户输入',
    error: '会话错误',
    legacy_readonly: '旧会话，只读',
    archive: '归档会话',
    archiveLegacyUnavailable: '旧版只读会话无法与 Codex 线程同步归档',
    archiving: '正在归档',
    showMore: '展开更多',
  },
  'en-US': {
    aria: 'Project conversations',
    empty: 'No conversations yet',
    newThread: 'New conversation',
    selectTask: 'Choose task',
    ready: 'Thread ready',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    paused: 'Processing paused',
    queued: 'Queued',
    streaming: 'Responding',
    pending_approval: 'Approval required',
    pending_user_input: 'User input required',
    error: 'Thread error',
    legacy_readonly: 'Legacy, read-only',
    archive: 'Archive conversation',
    archiveLegacyUnavailable: 'Legacy read-only conversations cannot be archived together with their Codex thread',
    archiving: 'Archiving',
    showMore: 'Show more',
  },
} as const;

interface FlattenedConversation {
  conversation: NativeConversationChoice;
  displayTitle: string;
}

/** 按会话更新时间平铺项目内容，键盘导航只包含当前可见项。 */
export function ProjectConversationTree(props: ProjectConversationTreeProps) {
  const copy = labels[props.language];
  const [archivingConversationId, setArchivingConversationId] = useState<string | null>(null);
  /** 在绘制禁用态之前也阻止重复点击。 */
  const archiveRequestRef = useRef<string | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';
  /** 列表筛选和行内状态使用同一权威来源，已连接会话状态优先于目录快照。 */
  const runtimeStateForConversation = (conversation: NativeConversationChoice): ConversationTreeRuntimeState =>
    props.conversationStates?.[conversationNavigationId(conversation)] ?? props.conversationStates?.[conversation.id] ?? conversationTreeRuntimeStateFromConversation(conversation);
  /** 搜索命中全部展示；数量限制只折叠普通会话，进行中的会话始终保留。 */
  const flattenedGroups = props.groups.map((project) => {
    /** 过滤后的完整列表同时作为“展开更多”的计数依据。 */
    const conversations = flattenProjectConversations(project, normalizedQuery, props.language);
    /** 每个项目单独计算普通会话额度，展开更多仍追加相同数量的普通会话。 */
    let ordinaryConversationCount = 0;
    return {
      project,
      conversations,
      visibleConversations:
        normalizedQuery || props.visibleConversationCount === undefined
          ? conversations
          : conversations.filter(({ conversation }) => {
              /** 与侧栏运行图标一致，执行、排队及连接阶段都不能被数量限制隐藏。 */
              const runStatus = taskRunStatusFromConversationTreeState(runtimeStateForConversation(conversation));
              if (runStatus === 'running' || runStatus === 'connecting' || runStatus === 'reconnecting') return true;
              return ordinaryConversationCount++ < Math.max(0, props.visibleConversationCount!);
            }),
    };
  });
  /** 焦点和上下键导航沿用实际展示的顺序。 */
  const visibleConversations = flattenedGroups.flatMap((group) => group.visibleConversations);
  const conversationIds = visibleConversations.map((entry) => conversationNavigationId(entry.conversation));
  const allConversationIds = props.groups.flatMap((project) => flattenProjectConversations(project, '', props.language).map((entry) => conversationNavigationId(entry.conversation)));
  const enteringConversationIds = useNewItemMotionIds(allConversationIds);
  const fallbackTabStopId = props.selectedConversationId && conversationIds.includes(props.selectedConversationId) ? null : (conversationIds[0] ?? null);

  /** 列表只显示归档进度，业务操作负责统一错误反馈。 */
  async function archiveConversation(conversation: NativeConversationChoice): Promise<void> {
    if (!props.onArchiveConversation || archiveRequestRef.current) return;
    archiveRequestRef.current = conversation.id;
    setArchivingConversationId(conversation.id);
    try {
      await props.onArchiveConversation(conversation);
    } finally {
      archiveRequestRef.current = null;
      setArchivingConversationId(null);
    }
  }

  /** 渲染平铺会话及其运行状态和归档入口。 */
  function renderConversationItems(conversations: FlattenedConversation[]) {
    return conversations.map(({ conversation, displayTitle }) => {
      const navigationId = conversationNavigationId(conversation);
      const current = navigationId === props.selectedConversationId;
      const runtimeState = runtimeStateForConversation(conversation);
      const archiving = archivingConversationId === conversation.id;
      // 可否归档由服务端按当前状态判断；仅旧会话在入口禁用。
      const archiveLabel = archiving ? copy.archiving : runtimeState === 'legacy_readonly' ? copy.archiveLegacyUnavailable : copy.archive;
      return (
        <li className="session-conversation-tree-item" key={navigationId} data-motion-surface="list-item" data-motion-state={enteringConversationIds.has(navigationId) ? 'entering' : undefined}>
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
              disabled={archiving || runtimeState === 'legacy_readonly'}
              aria-label={`${archiveLabel}: ${displayTitle}`}
              title={archiveLabel}
              onClick={() => {
                if (!archiving) void archiveConversation(conversation);
              }}
            >
              {archiving ? <CircleNotch className="session-conversation-archive-spinner" aria-hidden="true" /> : <Archive aria-hidden="true" />}
            </button>
          ) : null}
        </li>
      );
    });
  }

  return (
    <nav className="session-project-conversation-tree" aria-label={copy.aria} onKeyDown={handleTreeKeyDown}>
      {flattenedGroups.map(({ project, conversations, visibleConversations }) => (
        <section className="session-conversation-project-group" key={project.projectId} aria-label={project.projectName}>
          {!props.compactProjectLabel && props.onStartConversation ? <ProjectConversationHeader project={project} language={props.language} onStartConversation={props.onStartConversation} /> : null}
          <ul className="session-conversation-project-items">{renderConversationItems(visibleConversations)}</ul>
          {visibleConversations.length === 0 && props.showEmptyState !== false ? <p className="session-conversation-project-empty">{copy.empty}</p> : null}
          {!normalizedQuery && props.onShowMore && visibleConversations.length < conversations.length ? (
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
        <div className="session-conversation-task-menu" role="menu" inert={!menuOpen} aria-hidden={!menuOpen} aria-label={copy.selectTask} hidden={!menuOpen} onKeyDown={handleMenuKeyDown}>
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
    if (props.conversation.attentionKind === 'interrupted') return <ConversationStatusIcon status="interrupted" label={props.language === 'zh-CN' ? '本轮已中断' : 'Turn interrupted'} />;
    if (props.conversation.attentionKind === 'completed') return <ConversationStatusIcon status="completed" label={props.language === 'zh-CN' ? '已完成' : 'Completed'} />;
    return <ConversationStatusIcon status="unread" label={props.language === 'zh-CN' ? '有未读回复' : 'Unread reply'} />;
  }
  return null;
}

type ConversationStatusIconKind = TaskAgentRunStatus | 'completed' | 'interrupted' | 'unread';

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
  } else if (props.status === 'interrupted') {
    icon = <WarningCircle aria-hidden="true" />;
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

/** 合并项目直属与任务会话，按显示标题搜索，再按会话阶段更新时间排序。 */
function flattenProjectConversations(project: ProjectConversationGroup, normalizedQuery: string, language: 'zh-CN' | 'en-US'): FlattenedConversation[] {
  return [
    ...(project.conversations ?? []).map((conversation) => ({ conversation, displayTitle: conversationDisplayTitle(conversation.title) })),
    ...project.tasks.flatMap((task) => task.conversations.map((conversation) => ({ conversation, displayTitle: conversationDisplayTitle(conversation.title, task.taskTitle, language) }))),
  ]
    .filter((entry) => !normalizedQuery || entry.displayTitle.toLocaleLowerCase().includes(normalizedQuery))
    .sort((left, right) => compareConversationStageUpdatedDesc(left.conversation, right.conversation));
}

/** 将当前已连接 controller 的权威状态映射为全局 source tree 的可读状态。 */
export function conversationTreeRuntimeStateFromSession(state: NativeSessionState): ConversationTreeRuntimeState {
  if (state.conversationState === 'turn_failed') return 'error';
  // 侧栏表达会话本身的运行态，不表达当前窗口读取本地快照或建立实时订阅的短暂状态。
  // 读取、连接、重连失败都属于当前窗口的瞬时 transport，不再污染全局会话树状态。
  if (state.snapshot?.providerState === 'archived' || (state.queue?.state.type === 'paused' && state.queue.state.reason === 'provider_archived')) {
    return (state.queue?.submissions.length ?? 0) > 0 ? 'queued' : 'ready';
  }
  if (state.queue?.state.type === 'paused' && state.queue.state.reason === 'recovery_required') return 'paused';
  if (state.planImplementationRequests.some((request) => request.status === 'pending')) return 'pending_user_input';
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

export function conversationTreeRuntimeStateFromConversation(
  conversation: Pick<NativeConversationChoice, 'status' | 'stage' | 'transportKind' | 'providerState' | 'pendingRequestKind' | 'listRuntimeState'> & { readOnly?: boolean },
): ConversationTreeRuntimeState {
  if (conversation.listRuntimeState) return conversation.listRuntimeState;
  if (conversation.transportKind !== 'codex_native') return 'legacy_readonly';
  const providerState = `${conversation.providerState ?? ''}`.toLocaleLowerCase();
  const recordState = conversation.status.toLocaleLowerCase();
  if (providerState.includes('failed') || providerState.includes('error') || recordState.includes('failed') || recordState.includes('error')) return 'error';
  if (conversation.stage === 'waiting_user') return 'pending_user_input';
  if (conversation.stage === 'waiting_approval') return 'pending_approval';
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
