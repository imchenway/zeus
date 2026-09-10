import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { NativeSessionItemBuffer, NativeSessionState, NativeSubagentListSnapshot, NativeSubagentStatus, NativeSubagentSummary, NativeSubagentThreadSnapshot, NativeTurnSnapshot } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationTranscript, isSubagentCoordinationItem } from './ConversationTranscript.js';
import { RuntimeDetails } from './RuntimeDetails.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { createInitialSessionState } from './sessionReducer.js';

/** 子智能体工作面只提供原生线程的查看与刷新。 */
interface SubagentWorkspaceProps {
  language: SessionUiLanguage;
  conversationId: string;
  activityRevision: string;
  hintCount: number;
  initialSnapshot?: NativeSubagentListSnapshot | null;
  fullWidth: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  loadList: () => Promise<NativeSubagentListSnapshot>;
  loadThread: (threadId: string) => Promise<NativeSubagentThreadSnapshot>;
}

/** 原生运行状态决定刷新周期，不由正文内容推断完成。 */
const activeStatuses = new Set<NativeSubagentStatus>(['pending', 'running', 'waiting']);

/** 复用主会话消息与详情，面板只保留子线程导航。 */
export function SubagentWorkspace(props: SubagentWorkspaceProps) {
  const zh = props.language === 'zh-CN';
  const [snapshot, setSnapshot] = useState<NativeSubagentListSnapshot | null>(props.initialSnapshot ?? null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<NativeSubagentThreadSnapshot | null>(null);
  const [loadingList, setLoadingList] = useState(!props.initialSnapshot);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const listRequestRef = useRef(0);
  const threadRequestRef = useRef(0);
  const loadListRef = useRef(props.loadList);
  const loadThreadRef = useRef(props.loadThread);
  /** 记录已观察的状态边沿，结束时只追加一次最终详情读取。 */
  const previousAgentRef = useRef<{ id: string; status: NativeSubagentStatus } | null>(null);
  loadListRef.current = props.loadList;
  loadThreadRef.current = props.loadThread;
  useEffect(() => {
    if (!props.initialSnapshot || props.initialSnapshot.conversationId !== props.conversationId) return;
    setSnapshot(props.initialSnapshot);
    setLoadingList(false);
  }, [props.conversationId, props.initialSnapshot]);

  const refreshList = useCallback(async (foreground: boolean) => {
    const requestId = ++listRequestRef.current;
    if (foreground) setLoadingList(true);
    try {
      const next = await loadListRef.current();
      if (listRequestRef.current !== requestId) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (listRequestRef.current !== requestId) return;
      setError(cause);
    } finally {
      if (listRequestRef.current === requestId) setLoadingList(false);
    }
  }, []);

  const openThread = useCallback(async (threadId: string, foreground: boolean) => {
    const requestId = ++threadRequestRef.current;
    setSelectedThreadId(threadId);
    if (foreground) {
      setThread(null);
      setLoadingThread(true);
    }
    try {
      const next = await loadThreadRef.current(threadId);
      if (threadRequestRef.current !== requestId) return;
      setThread(next);
      setError(null);
    } catch (cause) {
      if (threadRequestRef.current !== requestId) return;
      setError(cause);
    } finally {
      if (threadRequestRef.current === requestId) setLoadingThread(false);
    }
  }, []);

  useEffect(() => {
    void refreshList(!props.initialSnapshot);
  }, [props.activityRevision, props.conversationId, props.initialSnapshot, refreshList]);

  // 活动通知仅刷新列表；只有切换会话或卸载才丢弃当前线程的在途读取。
  useEffect(() => {
    return () => {
      listRequestRef.current += 1;
      threadRequestRef.current += 1;
    };
  }, [props.conversationId]);

  const selectedAgent = selectedThreadId ? snapshot?.items.find((item) => item.id === selectedThreadId) : null;
  const hasRunningAgents = snapshot?.items.some((item) => activeStatuses.has(item.status)) ?? false;
  /** 使用稳定的状态值，列表轮询不重置线程轮询的计时器。 */
  const selectedStatus = selectedAgent?.status;

  useEffect(() => {
    if (!hasRunningAgents) return;
    const timer = setTimeout(() => void refreshList(false), 2_000);
    return () => clearTimeout(timer);
  }, [hasRunningAgents, refreshList, snapshot?.items]);

  useEffect(() => {
    if (!selectedThreadId || !selectedStatus || !activeStatuses.has(selectedStatus)) return;
    const timer = setTimeout(() => void openThread(selectedThreadId, false), 2_000);
    return () => clearTimeout(timer);
  }, [openThread, selectedStatus, selectedThreadId, thread]);

  useEffect(() => {
    /** 切换线程建立新的观察基线，不能触发旧线程刷新。 */
    const previous = previousAgentRef.current;
    previousAgentRef.current = selectedThreadId && selectedStatus ? { id: selectedThreadId, status: selectedStatus } : null;
    if (selectedThreadId && selectedStatus && previous?.id === selectedThreadId && activeStatuses.has(previous.status) && !activeStatuses.has(selectedStatus)) {
      void openThread(selectedThreadId, false);
    }
  }, [openThread, selectedStatus, selectedThreadId]);

  const grouped = useMemo(() => {
    const items = snapshot?.items ?? [];
    return {
      active: items.filter((item) => activeStatuses.has(item.status)),
      done: items.filter((item) => !activeStatuses.has(item.status)),
    };
  }, [snapshot?.items]);

  const threadItems = useMemo(() => {
    if (!thread) return [];
    return thread.turns.flatMap((turn) =>
      turn.items
        .filter((item) => !isSubagentCoordinationItem(item))
        .map<NativeSessionItemBuffer>((item) => ({
          key: `${thread.agent.id}:${turn.id}:${item.id}`,
          conversationId: props.conversationId,
          threadId: thread.agent.id,
          turnId: turn.id,
          itemId: item.id,
          providerItemId: item.providerItemId ?? undefined,
          type: item.type,
          status: item.status,
          phase: item.phase,
          text: item.text,
          payload: item.payload,
          resources: item.resources ?? [],
          timelineAt: item.startedAt ?? item.updatedAt,
          updatedAt: item.updatedAt,
        })),
    );
  }, [props.conversationId, thread]);
  const transcriptState = useMemo(() => (thread ? projectSubagentTranscriptState(props.conversationId, thread, threadItems) : null), [props.conversationId, thread, threadItems]);

  const toggleLabel = props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width';
  return (
    <aside className="session-subagent-workspace" data-full-width={props.fullWidth || undefined} aria-label={zh ? '智能体' : 'Agents'}>
      <header className="session-thread-header session-subagent-header">
        <span className="session-subagent-title">
          {selectedThreadId ? (
            <button
              type="button"
              aria-label={zh ? '返回智能体列表' : 'Back to agent list'}
              onClick={() => {
                threadRequestRef.current += 1;
                setSelectedThreadId(null);
                setThread(null);
                setError(null);
              }}
            >
              <ArrowLeft aria-hidden="true" />
            </button>
          ) : (
            <UsersThree aria-hidden="true" weight="regular" />
          )}
          <span className="session-thread-title-copy">
            <span className="session-thread-title-row">
              <strong>{selectedAgent?.title ?? (zh ? '智能体' : 'Agents')}</strong>
            </span>
            <small>{selectedAgent ? statusLabel(selectedAgent.status, props.language) : zh ? `${snapshot?.items.length ?? props.hintCount} 个线程` : `${snapshot?.items.length ?? props.hintCount} threads`}</small>
          </span>
        </span>
        <nav aria-label={zh ? '智能体面板操作' : 'Agent panel actions'}>
          <button type="button" aria-label={zh ? '刷新智能体' : 'Refresh agents'} title={zh ? '刷新' : 'Refresh'} onClick={() => void (selectedThreadId ? openThread(selectedThreadId, false) : refreshList(true))}>
            <ArrowsClockwise aria-hidden="true" />
          </button>
          <button type="button" aria-label={toggleLabel} title={toggleLabel} onClick={() => props.onFullWidthChange(!props.fullWidth)}>
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </button>
          <button type="button" aria-label={zh ? '关闭智能体面板' : 'Close agent panel'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </nav>
        {thread ? (
          <div className="session-thread-subtitle-row">
            <RuntimeDetails key={thread.agent.id} runtime={thread.runtime} language={props.language} scope="subagent" />
          </div>
        ) : null}
      </header>

      {error ? (
        <section className="session-subagent-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          <button type="button" onClick={() => void (selectedThreadId ? openThread(selectedThreadId, true) : refreshList(true))}>
            {zh ? '重试' : 'Retry'}
          </button>
        </section>
      ) : null}
      {selectedThreadId ? (
        <div className="session-subagent-detail">
          {loadingThread && !thread ? <SubagentLoading label={zh ? '正在读取智能体会话…' : 'Loading agent conversation…'} /> : null}
          {thread?.historyBoundary.state === 'unavailable' ? (
            <aside className="session-subagent-boundary-notice" role="status">
              <strong>{zh ? '部分历史归属不可确认' : 'Some history could not be attributed'}</strong>
              <span>{zh ? '无法确认属于此智能体的内容已隐藏。' : 'Content that could not be confirmed as belonging to this agent is hidden.'}</span>
              {thread.historyBoundary.reason ? <small>{thread.historyBoundary.reason}</small> : null}
            </aside>
          ) : null}
          <section className="session-subagent-thread" aria-label={zh ? '智能体会话' : 'Agent conversation'}>
            {!loadingThread && thread && threadItems.length === 0 ? (
              <SubagentEmpty
                title={zh ? '暂无可显示内容' : 'No visible content'}
                description={
                  thread.historyBoundary.state === 'unavailable'
                    ? zh
                      ? '暂时没有可显示的智能体工作内容。'
                      : 'No work from this agent is available to display yet.'
                    : zh
                      ? '这个智能体还没有发来消息。'
                      : 'This agent has not sent any messages yet.'
                }
              />
            ) : null}
            {transcriptState ? <ConversationTranscript state={transcriptState} language={props.language} historyOnly={!activeStatuses.has(thread!.agent.status)} transcriptHydrated /> : null}
          </section>
        </div>
      ) : (
        <section className="session-subagent-list" aria-live="polite">
          {loadingList && !snapshot ? <SubagentLoading label={zh ? '正在读取智能体…' : 'Loading agents…'} /> : null}
          {!loadingList && snapshot && snapshot.items.length === 0 ? <SubagentEmpty title={zh ? '暂无智能体' : 'No agents'} description={zh ? '此对话尚未创建子智能体。' : 'This conversation has no subagents yet.'} /> : null}
          {grouped.active.length > 0 ? <SubagentGroup title={zh ? '进行中' : 'Active'} items={grouped.active} language={props.language} onOpen={(agent) => void openThread(agent.id, true)} /> : null}
          {grouped.done.length > 0 ? <SubagentGroup title={zh ? '已完成' : 'Done'} items={grouped.done} language={props.language} onOpen={(agent) => void openThread(agent.id, true)} /> : null}
        </section>
      )}
    </aside>
  );
}

/** 子线程仅适配原生状态与身份，展示规则交给共享时间线。 */
function projectSubagentTranscriptState(conversationId: string, thread: NativeSubagentThreadSnapshot, items: readonly NativeSessionItemBuffer[]): NativeSessionState {
  const base = createInitialSessionState();
  const terminalTurnIds: NativeSessionState['terminalTurnIds'] = {};
  const turnsByProviderId: Record<string, NativeTurnSnapshot> = {};
  for (const turn of thread.turns) {
    const turnItems = items.filter((item) => item.turnId === turn.id);
    const timeline = turnItems
      .map((item) => item.timelineAt ?? item.updatedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const updated = turnItems
      .map((item) => item.updatedAt)
      .filter((value): value is string => Boolean(value))
      .sort();
    const status = normalizeSubagentTurnStatus(turn.status);
    const terminal = terminalSubagentTurnStatus(status);
    if (terminal) terminalTurnIds[turn.id] = terminal;
    const createdAt = timeline[0] ?? thread.agent.createdAt ?? thread.agent.updatedAt ?? new Date(0).toISOString();
    const updatedAt = updated.at(-1) ?? timeline.at(-1) ?? thread.agent.updatedAt ?? createdAt;
    turnsByProviderId[turn.id] = {
      id: turn.id,
      providerTurnId: turn.id,
      submissionId: null,
      status,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      createdAt,
      updatedAt,
    };
  }
  // Agent 汇总状态可能比具体轮次晚到；不能把最后一个已终结轮次重新标成活动轮次并回显旧 reasoning。
  const activeTurnId = activeStatuses.has(thread.agent.status) ? ([...thread.turns].reverse().find((turn) => !terminalSubagentTurnStatus(normalizeSubagentTurnStatus(turn.status)))?.id ?? null) : null;
  const itemMap = Object.fromEntries(items.map((item) => [item.key, item]));
  const latestUpdatedAt = items
    .map((item) => item.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);
  return {
    ...base,
    transportState: 'ready',
    conversationState: thread.agent.status === 'pending' ? 'starting_turn' : thread.agent.status === 'running' ? 'active_prework' : thread.agent.status === 'waiting' ? 'waiting_user_input' : 'native_idle',
    conversationId: `${conversationId}:subagent:${thread.agent.id}`,
    providerThreadId: thread.agent.id,
    activeTurnId,
    startedTurnId: activeTurnId,
    turnsByProviderId,
    terminalTurnIds,
    items: itemMap,
    itemOrder: items.map((item) => item.key),
    transcriptRevision: latestUpdatedAt ? Date.parse(latestUpdatedAt) || items.length : items.length,
  };
}

/** 归一化原生线程状态，不将已结束轮次重新变为运行。 */
function normalizeSubagentTurnStatus(status: string): string {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'in_progress' || normalized === 'inprogress' || normalized === 'active') return 'running';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'interrupted';
  return normalized || 'running';
}

function terminalSubagentTurnStatus(status: string): 'completed' | 'interrupted' | 'failed' | null {
  if (status === 'completed') return 'completed';
  if (status === 'interrupted') return 'interrupted';
  if (status === 'failed') return 'failed';
  return null;
}

function SubagentGroup(props: { title: string; items: NativeSubagentSummary[]; language: SessionUiLanguage; onOpen: (agent: NativeSubagentSummary) => void }) {
  return (
    <section className="session-subagent-group">
      <header>
        <strong>{props.title}</strong>
        <span>{props.items.length}</span>
      </header>
      <div>
        {props.items.map((agent) => (
          <button key={agent.id} type="button" className="session-subagent-row" onClick={() => props.onOpen(agent)}>
            <span className="session-subagent-status-dot" data-status={agent.status} aria-hidden="true" />
            <span className="session-subagent-row-copy">
              <strong>{agent.title}</strong>
              <small>{agent.role || subagentPathLabel(agent.path) || statusLabel(agent.status, props.language)}</small>
            </span>
            <span className="session-subagent-row-status">{statusLabel(agent.status, props.language)}</span>
            <CaretRight aria-hidden="true" />
          </button>
        ))}
      </div>
    </section>
  );
}

function SubagentLoading(props: { label: string }) {
  return (
    <p className="session-subagent-loading" role="status">
      <span className="session-command-spinner" aria-hidden="true" />
      {props.label}
    </p>
  );
}

function SubagentEmpty(props: { title: string; description: string }) {
  return (
    <div className="session-subagent-empty">
      <UsersThree aria-hidden="true" weight="regular" />
      <strong>{props.title}</strong>
      <small>{props.description}</small>
    </div>
  );
}

function statusLabel(status: NativeSubagentStatus, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  if (status === 'pending') return zh ? '准备中' : 'Starting';
  if (status === 'running') return zh ? '运行中' : 'Running';
  if (status === 'waiting') return zh ? '等待中' : 'Waiting';
  if (status === 'completed') return zh ? '已完成' : 'Completed';
  if (status === 'interrupted') return zh ? '已中断' : 'Interrupted';
  if (status === 'failed') return zh ? '失败' : 'Failed';
  return zh ? '状态未知' : 'Unknown';
}

function subagentPathLabel(path: string | null): string | null {
  return path?.split('/').filter(Boolean).pop() ?? null;
}
