import type { KeyboardEvent } from 'react';
import type { NativeConversationChoice, NativeSessionState } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export interface ProjectConversationTaskGroup {
  taskId: string;
  taskTitle: string;
  conversations: NativeConversationChoice[];
}

export interface ProjectConversationGroup {
  projectId: string;
  projectName: string;
  conversations?: NativeConversationChoice[];
  tasks: ProjectConversationTaskGroup[];
}

export type ConversationTreeRuntimeState = 'connecting' | 'reconnecting' | 'paused' | 'ready' | 'streaming' | 'pending_request' | 'error' | 'legacy_readonly';

export interface ProjectConversationTreeProps {
  groups: ProjectConversationGroup[];
  selectedConversationId?: string | null;
  conversationStates?: Record<string, ConversationTreeRuntimeState>;
  onSelectConversation: (conversation: NativeConversationChoice) => void;
  onStartConversation: (taskId: string) => void;
  language: SessionUiLanguage;
  compactProjectLabel?: boolean;
}

const labels = {
  'zh-CN': {
    aria: '项目会话',
    empty: '暂无真实会话',
    newThread: '新建会话',
    ready: '会话就绪',
    connecting: '正在连接',
    reconnecting: '正在重连',
    paused: '队列已暂停',
    streaming: '正在响应',
    pending_request: '等待操作',
    error: '会话错误',
    legacy_readonly: '旧会话，只读',
  },
  'en-US': {
    aria: 'Project conversations',
    empty: 'No real conversations yet',
    newThread: 'New conversation',
    ready: 'Thread ready',
    connecting: 'Connecting',
    reconnecting: 'Reconnecting',
    paused: 'Queue paused',
    streaming: 'Responding',
    pending_request: 'Action required',
    error: 'Thread error',
    legacy_readonly: 'Legacy, read-only',
  },
} as const;

export function ProjectConversationTree(props: ProjectConversationTreeProps) {
  const copy = labels[props.language];
  const conversationIds = props.groups.flatMap((project) => [...(project.conversations ?? []), ...project.tasks.flatMap((task) => task.conversations)].map((conversation) => conversation.id));
  const fallbackTabStopId = props.selectedConversationId && conversationIds.includes(props.selectedConversationId) ? null : (conversationIds[0] ?? null);
  const renderConversationItems = (conversations: NativeConversationChoice[], className?: string) => (
    <ul className={className}>
      {conversations.map((conversation) => {
        const current = conversation.id === props.selectedConversationId;
        const runtimeState = props.conversationStates?.[conversation.id] ?? inferRuntimeState(conversation);
        return (
          <li key={conversation.id}>
            <button
              type="button"
              className={`session-conversation-tree-row${current ? ' is-current' : ''}`}
              aria-current={current ? 'page' : undefined}
              tabIndex={current || conversation.id === fallbackTabStopId ? 0 : -1}
              data-conversation-tree-item="true"
              data-conversation-runtime-state={runtimeState}
              onClick={() => props.onSelectConversation(conversation)}
            >
              <span className="session-conversation-tree-copy">
                <strong>{conversation.title}</strong>
                {conversation.summary ? <small>{conversation.summary}</small> : null}
              </span>
              <span className="session-conversation-tree-state">
                <span className="session-state-symbol" aria-hidden="true">
                  {runtimeState === 'streaming' || runtimeState === 'connecting'
                    ? '◌'
                    : runtimeState === 'reconnecting'
                      ? '↻'
                      : runtimeState === 'paused'
                        ? 'Ⅱ'
                        : runtimeState === 'pending_request'
                          ? '!'
                          : runtimeState === 'error'
                            ? '×'
                            : runtimeState === 'legacy_readonly'
                              ? '↗'
                              : '·'}
                </span>
                <span>{copy[runtimeState]}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
  return (
    <nav className="session-project-conversation-tree" aria-label={copy.aria} onKeyDown={handleTreeKeyDown}>
      {props.groups.map((project) => (
        <section className="session-conversation-project-group" key={project.projectId} aria-label={project.projectName}>
          {props.compactProjectLabel ? null : <strong className="session-conversation-project-label">{project.projectName}</strong>}
          {(project.conversations ?? []).length > 0 ? renderConversationItems(project.conversations ?? [], 'session-conversation-project-items') : null}
          {project.tasks.map((task) => (
            <section className="session-conversation-task-group" key={task.taskId} aria-label={task.taskTitle}>
              <header>
                <span title={task.taskTitle}>{task.taskTitle}</span>
                <button type="button" aria-label={`${copy.newThread}: ${task.taskTitle}`} onClick={() => props.onStartConversation(task.taskId)}>
                  <span aria-hidden="true">＋</span>
                </button>
              </header>
              {task.conversations.length > 0 ? renderConversationItems(task.conversations) : <p>{copy.empty}</p>}
            </section>
          ))}
          {(project.conversations ?? []).length === 0 && project.tasks.length === 0 ? <p className="session-conversation-project-empty">{copy.empty}</p> : null}
        </section>
      ))}
    </nav>
  );
}

/** 将当前已连接 controller 的权威状态映射为全局 source tree 的可读状态。 */
export function conversationTreeRuntimeStateFromSession(state: NativeSessionState): ConversationTreeRuntimeState {
  if (state.error?.recoveryRequired) return 'error';
  if (state.transportState === 'failed' || state.conversationState === 'turn_failed') return 'error';
  if (state.transportState === 'connecting' || state.transportState === 'hydrating' || state.transportState === 'disconnected') return 'connecting';
  if (state.transportState === 'reconnecting') return 'reconnecting';
  if (state.pendingRequests.some((request) => request.status === 'pending') || state.conversationState === 'waiting_approval' || state.conversationState === 'waiting_user_input') return 'pending_request';
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

function inferRuntimeState(conversation: NativeConversationChoice): ConversationTreeRuntimeState {
  if (conversation.readOnly || conversation.transportKind !== 'codex_native') return 'legacy_readonly';
  const providerState = `${conversation.providerState ?? ''}`.toLocaleLowerCase();
  const recordState = conversation.status.toLocaleLowerCase();
  if (providerState.includes('failed') || providerState.includes('error') || recordState.includes('failed') || recordState.includes('error')) return 'error';
  if (providerState.includes('reconnect')) return 'reconnecting';
  if (providerState.includes('connect') || providerState.includes('hydrat') || providerState.includes('disconnected')) return 'connecting';
  if (providerState.includes('paused') || recordState.includes('paused')) return 'paused';
  if (providerState.includes('waiting')) return 'pending_request';
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
