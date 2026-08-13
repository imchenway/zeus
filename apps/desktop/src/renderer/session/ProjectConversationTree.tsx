import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import type { NativeConversationChoice, NativeConversationSnapshot, NativeSessionState } from './sessionTypes.js';
import { compareConversationStageUpdatedDesc } from './conversationOrdering.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { conversationDisplayTitle } from './conversationDisplayTitle.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';

export interface ProjectConversationTaskGroup {
  taskId: string;
  taskCode: string;
  taskTitle: string;
  conversations: NativeConversationChoice[];
}

export interface ProjectConversationGroup {
  projectId: string;
  projectName: string;
  conversations?: NativeConversationChoice[];
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
  },
} as const;

interface FlattenedConversation {
  conversation: NativeConversationChoice;
  displayTitle: string;
}

export function ProjectConversationTree(props: ProjectConversationTreeProps) {
  const copy = labels[props.language];
  const reduceMotion = useReducedMotion();
  const [archivingConversationId, setArchivingConversationId] = useState<string | null>(null);
  const normalizedQuery = props.query?.trim().toLocaleLowerCase() ?? '';
  const flattenedGroups = props.groups.map(flattenProjectConversations).map((group) => ({
    ...group,
    conversations: normalizedQuery ? group.conversations.filter((entry) => entry.displayTitle.toLocaleLowerCase().includes(normalizedQuery)) : group.conversations,
  }));
  const conversationIds = flattenedGroups.flatMap((group) => group.conversations.map((entry) => conversationNavigationId(entry.conversation)));
  const allConversationIds = props.groups.flatMap((group) => flattenProjectConversations(group).conversations.map((entry) => conversationNavigationId(entry.conversation)));
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

  return (
    <nav className="session-project-conversation-tree" aria-label={copy.aria} onKeyDown={handleTreeKeyDown}>
      {flattenedGroups.map(({ project, conversations }) => (
        <section className="session-conversation-project-group" key={project.projectId} aria-label={project.projectName}>
          {!props.compactProjectLabel && props.onStartConversation ? <ProjectConversationHeader project={project} language={props.language} onStartConversation={props.onStartConversation} /> : null}
          <ul className="session-conversation-project-items">
            <AnimatePresence initial={false}>
              {conversations.map(({ conversation, displayTitle }) => {
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
                      onClick={() => props.onSelectConversation(conversation)}
                    >
                      <strong title={displayTitle}>{displayTitle}</strong>
                      <ConversationRowState conversation={conversation} runtimeState={runtimeState} current={current} language={props.language} />
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
              })}
            </AnimatePresence>
          </ul>
          {conversations.length === 0 && props.showEmptyState !== false ? <p className="session-conversation-project-empty">{copy.empty}</p> : null}
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

function ConversationRowState(props: { conversation: NativeConversationChoice; runtimeState: ConversationTreeRuntimeState; current: boolean; language: SessionUiLanguage }) {
  const copy = labels[props.language];
  const active = ['connecting', 'reconnecting', 'streaming', 'pending_approval', 'pending_user_input'].includes(props.runtimeState);
  if (props.runtimeState === 'pending_approval' || props.runtimeState === 'pending_user_input') {
    return (
      <span className="session-conversation-tree-state">
        <span className={`session-conversation-status-pill is-${props.runtimeState}`}>{copy[props.runtimeState]}</span>
        <CircleNotch className="session-conversation-state-spinner" aria-hidden="true" />
      </span>
    );
  }
  if (active) {
    return (
      <span className="session-conversation-tree-state" aria-label={copy[props.runtimeState]}>
        <CircleNotch className="session-conversation-state-spinner" aria-hidden="true" />
      </span>
    );
  }
  if (props.conversation.hasUnreadAttention) {
    if (props.conversation.attentionKind === 'failed' || props.conversation.attentionKind === 'interrupted' || props.conversation.attentionKind === 'completed') {
      const attentionLabel =
        props.conversation.attentionKind === 'failed'
          ? props.language === 'zh-CN'
            ? '失败'
            : 'Failed'
          : props.conversation.attentionKind === 'interrupted'
            ? props.language === 'zh-CN'
              ? '已中断'
              : 'Interrupted'
            : props.language === 'zh-CN'
              ? '已完成'
              : 'Completed';
      return <span className={`session-conversation-status-pill is-${props.conversation.attentionKind}`}>{attentionLabel}</span>;
    }
    return <span className="session-conversation-unread-dot" aria-label={props.language === 'zh-CN' ? '有未读回复' : 'Unread reply'} />;
  }
  if (props.runtimeState === 'error') {
    return (
      <span className="session-conversation-tree-state" aria-label={copy.error}>
        <WarningCircle aria-hidden="true" />
      </span>
    );
  }
  if (props.runtimeState === 'legacy_readonly') {
    return (
      <span className="session-conversation-tree-state is-muted" aria-label={copy.legacy_readonly}>
        <ArrowSquareOut aria-hidden="true" />
      </span>
    );
  }
  if (props.runtimeState === 'paused' || props.runtimeState === 'queued') return <span className="session-conversation-tree-state is-muted">{copy[props.runtimeState]}</span>;
  return null;
}

function flattenProjectConversations(project: ProjectConversationGroup): {
  project: ProjectConversationGroup;
  conversations: FlattenedConversation[];
} {
  const taskById = new Map(project.tasks.map((task) => [task.taskId, task]));
  const conversations = [...(project.conversations ?? []), ...project.tasks.flatMap((task) => task.conversations)]
    .map((conversation): FlattenedConversation => {
      const task = conversation.taskId ? taskById.get(conversation.taskId) : undefined;
      return {
        conversation,
        displayTitle: conversationDisplayTitle(conversation.title, task?.taskTitle),
      };
    })
    .sort((left, right) => compareConversationStageUpdatedDesc(left.conversation, right.conversation));
  return { project, conversations };
}

/** 将当前已连接 controller 的权威状态映射为全局 source tree 的可读状态。 */
export function conversationTreeRuntimeStateFromSession(state: NativeSessionState): ConversationTreeRuntimeState {
  if (state.transportState === 'failed' || state.conversationState === 'turn_failed') return 'error';
  if (state.transportState === 'connecting' || state.transportState === 'hydrating' || state.transportState === 'disconnected') return 'connecting';
  if (state.transportState === 'reconnecting') return 'reconnecting';
  if (state.snapshot?.providerState === 'archived' || (state.queue?.state.type === 'paused' && state.queue.state.reason === 'provider_archived')) {
    return (state.queue?.submissions.length ?? 0) > 0 ? 'queued' : 'ready';
  }
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
  if (conversation.readOnly || conversation.transportKind !== 'codex_native') return 'legacy_readonly';
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
  if (providerState.includes('active') || providerState.includes('running') || providerState.includes('starting')) return 'streaming';
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
