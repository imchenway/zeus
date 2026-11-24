import { conversationUsedResources } from '@zeus/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { NativeSessionItemBuffer, NativeSessionState, NativeSubagentListSnapshot, NativeSubagentStatus, NativeSubagentSummary, NativeSubagentThreadSnapshot, NativeTurnSnapshot } from './sessionTypes.js';
import { activeNativeSubagentStatuses as activeStatuses } from './sessionTypes.js';
import { ThreadItemView, transcriptItemText, type SessionUiLanguage } from './ThreadItemView.js';
import { ConversationMarkdown } from './ConversationMarkdown.js';
import { ConversationTranscript, isFinalAnswerItem, isSubagentCoordinationItem, isVisibleTranscriptItem } from './ConversationTranscript.js';
import { RuntimeDetails } from './RuntimeDetails.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { createInitialSessionState } from './sessionReducer.js';
import { useReadingScroll, useReadingState } from '../ui/readingState.js';
import { Button } from '../ui/Button.js';

/** 子智能体工作面只提供原生线程的查看与刷新。 */
interface SubagentWorkspaceProps {
  language: SessionUiLanguage;
  conversationId: string;
  initialSnapshot?: NativeSubagentListSnapshot | null;
  /** 轮次入口发起的一次直接选择。 */
  threadRequest?: { threadId: string };
  /** 向轮次入口同步面板中的实际选中线程。 */
  onSelectedThreadChange?: (threadId: string | null) => void;
  /** 会话顶栏中与侧栏正文同宽的挂载点。 */
  toolbarHost: HTMLElement | null;
  /** 窄窗口直接使用全宽工作面。 */
  canSplit: boolean;
  fullWidth: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  loadList: () => Promise<NativeSubagentListSnapshot>;
  loadThread: (threadId: string) => Promise<NativeSubagentThreadSnapshot>;
  /** 操作代理通过已有中断命令停止，不给原生线程猜测产品身份。 */
  onStopOperationAgent?: (threadId: string) => Promise<void>;
}

/** 复用主会话消息与详情，面板只保留子线程导航。 */
export function SubagentWorkspace(props: SubagentWorkspaceProps) {
  /** 子线程列表和线程正文分别保存各自的位置。 */
  const listScroll = useReadingScroll('subagent-list');
  const zh = props.language === 'zh-CN';
  const [snapshot, setSnapshot] = useState<NativeSubagentListSnapshot | null>(props.initialSnapshot ?? null);
  const [selectedThreadId, setSelectedThreadId] = useReadingState<string | null>(`subagent:${props.conversationId}`, null);
  /** 打开详情或返回列表时，焦点落在新页面的标题上。 */
  const titleRef = useRef<HTMLSpanElement>(null);
  const focusTitle = useRef(false);
  /** 只在重新挂载时补读已选择线程，点击入口仍负责自己的读取。 */
  const initialThreadId = useRef(selectedThreadId).current;
  const [thread, setThread] = useState<NativeSubagentThreadSnapshot | null>(null);
  /** 手动选择完整会话只作用于当前回复，新一轮完成后优先展示新回复。 */
  const [fullConversationReplyKey, setFullConversationReplyKey] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(!props.initialSnapshot);
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** 停止请求在回执前禁止重复点击。 */
  const [stopping, setStopping] = useState(false);
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
      setFullConversationReplyKey(null);
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

  /** 主会话已经预读时直接使用同一份列表。 */
  const hasInitialSnapshot = Boolean(props.initialSnapshot);
  useEffect(() => {
    if (!hasInitialSnapshot) void refreshList(true);
  }, [hasInitialSnapshot, props.conversationId, refreshList]);

  useEffect(() => {
    if (props.threadRequest) {
      void openThread(props.threadRequest.threadId, true);
      titleRef.current?.focus();
    } else if (initialThreadId) {
      // 重新挂载时读取上次选择的线程；正文位置由共享时间线恢复。
      void openThread(initialThreadId, true);
    }
  }, [initialThreadId, openThread, props.threadRequest]);

  useEffect(() => {
    props.onSelectedThreadChange?.(selectedThreadId);
  }, [props.onSelectedThreadChange, selectedThreadId]);

  useLayoutEffect(() => {
    if (!focusTitle.current) return;
    titleRef.current?.focus();
    focusTitle.current = false;
  }, [selectedThreadId]);

  // 活动通知仅刷新列表；只有切换会话或卸载才丢弃当前线程的在途读取。
  useEffect(() => {
    return () => {
      listRequestRef.current += 1;
      threadRequestRef.current += 1;
    };
  }, [props.conversationId]);

  const selectedAgent = selectedThreadId ? snapshot?.items.find((item) => item.id === selectedThreadId) : null;
  /** 使用稳定的状态值，列表轮询不重置线程轮询的计时器。 */
  const selectedStatus = selectedAgent?.status;

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
  /** 没有可显示的轮次时，单独展示服务端已保存的子任务。 */
  const hasVisibleItems = threadItems.some(isVisibleTranscriptItem);
  const task = hasVisibleItems ? null : thread?.taskInstruction;
  const startupBlock = thread?.agent.startupBlock;
  /** 任务已完成且历史归属可确认时，才展示结果。 */
  const finalReply = useMemo(() => {
    if (thread?.agent.status !== 'completed' || (selectedStatus ?? thread.agent.status) !== 'completed' || thread.historyBoundary.state !== 'confirmed') return undefined;
    /** 接口按轮次顺序返回，旧轮次的回复不代表本次执行结果。 */
    const latestTurn = thread.turns.at(-1);
    if (!latestTurn || normalizeSubagentTurnStatus(latestTurn.status) !== 'completed') return undefined;
    return threadItems.findLast(
      (item) => item.turnId === latestTurn.id && item.status === 'completed' && isFinalAnswerItem(item) && isVisibleTranscriptItem(item) && (item.resources.length > 0 || transcriptItemText(item).trim().length > 0),
    );
  }, [selectedStatus, thread, threadItems]);
  /** 同一条回复刷新后保留用户的视图选择。 */
  const showingFullConversation = finalReply?.key === fullConversationReplyKey;
  /** 用回复标题标识可滚动的阅读区域。 */
  const finalReplyTitle = zh ? '最终回复' : 'Final reply';

  /** 用户选择列表行后，把键盘导航交给详情工具栏。 */
  function selectAgent(agent: NativeSubagentSummary) {
    focusTitle.current = true;
    return openThread(agent.id, true);
  }

  /** 标题只表达当前线程身份，进度和错误由正文承载。 */
  const title = selectedAgent?.title ?? thread?.agent.title ?? (zh ? '智能体' : 'Agents');
  const toggleLabel = props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width';
  const header = (
    <header className="session-context-workspace-header session-subagent-header">
      <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
        {selectedThreadId ? (
          <Button
            unstyled
            className="session-subagent-back"
            data-icon-tooltip={zh ? '返回智能体列表' : 'Back to agent list'}
            type="button"
            aria-label={zh ? '返回智能体列表' : 'Back to agent list'}
            onClick={() => {
              focusTitle.current = true;
              threadRequestRef.current += 1;
              setSelectedThreadId(null);
              setThread(null);
              setError(null);
            }}
          >
            <ArrowLeft aria-hidden="true" />
          </Button>
        ) : (
          <UsersThree aria-hidden="true" weight="regular" />
        )}
        <strong title={title}>{title}</strong>
        {thread ? <RuntimeDetails key={thread.agent.id} runtime={thread.runtime} language={props.language} scope="subagent" resources={conversationUsedResources(thread.turns.flatMap((turn) => turn.items))} /> : null}
      </span>
      <nav aria-label={zh ? '智能体面板操作' : 'Agent panel actions'}>
        {selectedAgent?.operation && activeStatuses.has(selectedAgent.status) && props.onStopOperationAgent ? (
          <Button
            unstyled
            type="button"
            disabled={stopping}
            aria-busy={stopping}
            onClick={() => {
              setStopping(true);
              return props.onStopOperationAgent!(selectedAgent.id)
                .then(() => refreshList(false))
                .catch(setError)
                .finally(() => setStopping(false));
            }}
          >
            {selectedAgent.dispatchUnconfirmed ? (zh ? '核对并停止' : 'Check and stop') : zh ? '停止' : 'Stop'}
          </Button>
        ) : null}
        <Button unstyled type="button" aria-label={zh ? '刷新智能体' : 'Refresh agents'} data-icon-tooltip={zh ? '刷新智能体' : 'Refresh agents'} onClick={() => (selectedThreadId ? openThread(selectedThreadId, false) : refreshList(true))}>
          <ArrowsClockwise aria-hidden="true" />
        </Button>
        {props.canSplit ? (
          <Button unstyled type="button" aria-label={toggleLabel} data-icon-tooltip={toggleLabel} onClick={() => props.onFullWidthChange(!props.fullWidth)}>
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </Button>
        ) : null}
        <Button unstyled type="button" aria-label={zh ? '关闭智能体面板' : 'Close agent panel'} data-icon-tooltip={zh ? '关闭' : 'Close'} onClick={props.onClose}>
          <X aria-hidden="true" />
        </Button>
      </nav>
    </header>
  );

  return (
    <aside className="session-subagent-workspace" data-full-width={props.fullWidth || undefined} aria-label={zh ? '智能体' : 'Agents'}>
      {props.toolbarHost ? createPortal(header, props.toolbarHost) : header}
      {error ? (
        <section className="session-subagent-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          <Button unstyled type="button" onClick={() => (selectedThreadId ? openThread(selectedThreadId, true) : refreshList(true))}>
            {zh ? '重试' : 'Retry'}
          </Button>
        </section>
      ) : null}
      {selectedThreadId ? (
        <div className="session-subagent-detail">
          {loadingThread && !thread ? <SubagentStatus busy label={zh ? '正在读取智能体会话…' : 'Loading agent conversation…'} /> : null}
          {thread?.historyBoundary.state === 'unavailable' ? (
            <aside className="session-subagent-boundary-notice" role="status">
              <strong>{zh ? '部分历史归属不可确认' : 'Some history could not be attributed'}</strong>
              <span>{zh ? '无法确认属于此智能体的内容已隐藏。' : 'Content that could not be confirmed as belonging to this agent is hidden.'}</span>
              {thread.historyBoundary.reason ? <small>{thread.historyBoundary.reason}</small> : null}
            </aside>
          ) : null}
          {task?.state === 'available' && task.text ? (
            <div className="session-subagent-task">
              <article className="session-thread-item session-thread-item-user">
                <ConversationMarkdown text={task.text} streamId={`subagent-task:${selectedThreadId}`} phase="final" language={props.language} />
              </article>
            </div>
          ) : null}
          {startupBlock && thread ? (
            <section className="session-subagent-error" role="alert">
              <strong>{statusLabel(thread.agent, props.language)}</strong>
              {startupBlock.error ? <VisibleApplicationError error={startupBlock.error} language={zh ? 'zh-CN' : 'en'} /> : null}
            </section>
          ) : null}
          {finalReply && thread ? (
            <div className="session-subagent-result-bar">
              <p className="session-subagent-status" role="status">
                {zh ? '状态' : 'Status'}
                <span className="session-subagent-status-dot" data-status={thread.agent.status} aria-hidden="true" />
                <strong>{statusLabel(thread.agent, props.language)}</strong>
              </p>
              <Button unstyled type="button" className="session-subagent-view-action" onClick={() => setFullConversationReplyKey(showingFullConversation ? null : finalReply.key)}>
                {showingFullConversation ? (zh ? '查看最终回复' : 'View final reply') : zh ? '查看完整会话' : 'View full conversation'}
              </Button>
            </div>
          ) : null}
          {finalReply && !showingFullConversation ? (
            <section className="session-subagent-result" key={finalReply.key} aria-label={finalReplyTitle} tabIndex={0}>
              <h2>{finalReplyTitle}</h2>
              <ThreadItemView item={finalReply} language={props.language} />
            </section>
          ) : thread && transcriptState && hasVisibleItems ? (
            <section className="session-subagent-thread" aria-label={zh ? '智能体会话' : 'Agent conversation'}>
              <ConversationTranscript state={transcriptState} language={props.language} historyOnly={Boolean(startupBlock) || !activeStatuses.has(thread.agent.status)} transcriptHydrated />
            </section>
          ) : thread && !startupBlock ? (
            <SubagentStatus
              busy={thread.agent.status === 'pending' || thread.agent.status === 'running'}
              label={thread.agent.status === 'completed' ? (zh ? '已完成 · 暂无可显示消息' : 'Completed · No visible messages') : statusLabel(thread.agent, props.language)}
            />
          ) : null}
        </div>
      ) : (
        <section ref={listScroll} className="session-subagent-list" aria-live="polite">
          {loadingList && !snapshot ? <SubagentStatus busy label={zh ? '正在读取智能体…' : 'Loading agents…'} /> : null}
          {!loadingList && snapshot && snapshot.items.length === 0 ? <SubagentStatus label={zh ? '暂无智能体' : 'No agents'} /> : null}
          {grouped.active.length > 0 ? <SubagentGroup title={zh ? '进行中' : 'Active'} items={grouped.active} language={props.language} onOpen={selectAgent} /> : null}
          {grouped.done.length > 0 ? <SubagentGroup title={zh ? '已结束' : 'Finished'} items={grouped.done} language={props.language} onOpen={selectAgent} /> : null}
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

/** 列表每行只显示一次运行状态。 */
function SubagentGroup(props: { title: string; items: NativeSubagentSummary[]; language: SessionUiLanguage; onOpen: (agent: NativeSubagentSummary) => void }) {
  return (
    <section className="session-subagent-group">
      <header>
        <strong>{props.title}</strong>
        <span>{props.items.length}</span>
      </header>
      <div>
        {props.items.map((agent) => (
          <Button data-busy-behavior="background" unstyled key={agent.id} type="button" className="session-subagent-row" onClick={() => props.onOpen(agent)}>
            <span className="session-subagent-status-dot" data-status={agent.status} aria-hidden="true" />
            <span className="session-subagent-row-copy">
              <strong>{agent.title}</strong>
              {agent.role ? <small>{agent.role}</small> : null}
            </span>
            <span className="session-subagent-row-status">{statusLabel(agent, props.language)}</span>
            <CaretRight aria-hidden="true" />
          </Button>
        ))}
      </div>
    </section>
  );
}

/** 列表和详情共用紧凑状态行，只有正在读取或运行时显示进度。 */
function SubagentStatus(props: { label: string; busy?: boolean }) {
  return (
    <p className="session-subagent-status" role="status">
      {props.busy ? <span className="session-command-spinner" aria-hidden="true" /> : null}
      {props.label}
    </p>
  );
}

/** 已暂停的提交在列表和无可见轮次的详情中使用同一个标签。 */
function statusLabel({ status, startupBlock, dispatchUnconfirmed }: NativeSubagentSummary, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  if (startupBlock) return zh ? '启动受阻' : 'Startup blocked';
  if (dispatchUnconfirmed) return zh ? '派发待核对' : 'Dispatch unconfirmed';
  if (status === 'pending') return zh ? '准备中' : 'Preparing';
  if (status === 'running') return zh ? '运行中' : 'Running';
  if (status === 'waiting') return zh ? '等待中' : 'Waiting';
  if (status === 'completed') return zh ? '已完成' : 'Completed';
  if (status === 'interrupted') return zh ? '已中断' : 'Interrupted';
  if (status === 'failed') return zh ? '失败' : 'Failed';
  return zh ? '状态未知' : 'Unknown';
}
