import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon as ArrowLeft } from '@phosphor-icons/react/dist/csr/ArrowLeft';
import { ArrowsClockwiseIcon as ArrowsClockwise } from '@phosphor-icons/react/dist/csr/ArrowsClockwise';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { NativeSessionItemBuffer, NativeSubagentListSnapshot, NativeSubagentStatus, NativeSubagentSummary, NativeSubagentThreadSnapshot } from './sessionTypes.js';
import { ThreadItemView, type SessionUiLanguage } from './ThreadItemView.js';
import { isSubagentCoordinationItem } from './ConversationTranscript.js';
import { RuntimeDetails } from './RuntimeDetails.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

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

const activeStatuses = new Set<NativeSubagentStatus>(['pending', 'running', 'waiting']);

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
    return () => {
      listRequestRef.current += 1;
      threadRequestRef.current += 1;
    };
  }, [props.activityRevision, props.conversationId, props.initialSnapshot, refreshList]);

  const selectedAgent = selectedThreadId ? snapshot?.items.find((item) => item.id === selectedThreadId) : null;
  const hasRunningAgents = snapshot?.items.some((item) => activeStatuses.has(item.status)) ?? false;

  useEffect(() => {
    if (!hasRunningAgents) return;
    const timer = setTimeout(() => void refreshList(false), 2_000);
    return () => clearTimeout(timer);
  }, [hasRunningAgents, refreshList, snapshot?.items]);

  useEffect(() => {
    if (!selectedThreadId || !selectedAgent || !activeStatuses.has(selectedAgent.status)) return;
    const timer = setTimeout(() => void openThread(selectedThreadId, false), 2_000);
    return () => clearTimeout(timer);
  }, [openThread, selectedAgent, selectedThreadId, thread]);

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

  const toggleLabel = props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width';
  return (
    <aside className="session-subagent-workspace" data-full-width={props.fullWidth || undefined} aria-label={zh ? '智能体' : 'Agents'}>
      <header className="session-subagent-header">
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
          <span>
            <strong>{selectedAgent?.title ?? (zh ? '智能体' : 'Agents')}</strong>
            <small>{selectedAgent ? statusLabel(selectedAgent.status, props.language) : zh ? `${snapshot?.items.length ?? props.hintCount} 个线程` : `${snapshot?.items.length ?? props.hintCount} threads`}</small>
          </span>
        </span>
        <nav aria-label={zh ? '智能体面板操作' : 'Agent panel actions'}>
          <button type="button" aria-label={zh ? '刷新智能体' : 'Refresh agents'} title={zh ? '刷新' : 'Refresh'} onClick={() => void (selectedThreadId ? openThread(selectedThreadId, true) : refreshList(true))}>
            <ArrowsClockwise aria-hidden="true" />
          </button>
          <button type="button" aria-label={toggleLabel} title={toggleLabel} onClick={() => props.onFullWidthChange(!props.fullWidth)}>
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </button>
          <button type="button" aria-label={zh ? '关闭智能体面板' : 'Close agent panel'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </nav>
      </header>

      {error ? (
        <section className="session-subagent-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          <button type="button" onClick={() => void (selectedThreadId ? openThread(selectedThreadId, true) : refreshList(true))}>
            {zh ? '重试' : 'Retry'}
          </button>
        </section>
      ) : selectedThreadId ? (
        <div className="session-subagent-detail">
          {loadingThread && !thread ? <SubagentLoading label={zh ? '正在读取智能体会话…' : 'Loading agent conversation…'} /> : null}
          {thread ? <RuntimeDetails runtime={thread.runtime} language={props.language} scope="subagent" /> : null}
          {thread?.historyBoundary.state === 'unavailable' ? (
            <aside className="session-subagent-boundary-notice" role="status">
              <strong>{zh ? '部分历史归属不可确认' : 'Some history could not be attributed'}</strong>
              <span>{zh ? '已隐藏可能来自父会话或缺少时间边界的内容。' : 'Content that may belong to the parent conversation or lacks a reliable time boundary is hidden.'}</span>
              {thread.historyBoundary.reason ? <small>{thread.historyBoundary.reason}</small> : null}
            </aside>
          ) : null}
          <section className="session-subagent-thread" role="log" aria-live="off" aria-label={zh ? '智能体会话' : 'Agent conversation'}>
            {!loadingThread && thread && threadItems.length === 0 ? (
              <SubagentEmpty
                title={zh ? '暂无可显示内容' : 'No visible content'}
                description={
                  thread.historyBoundary.state === 'unavailable'
                    ? zh
                      ? '当前没有能可靠确认属于该智能体的工作内容。'
                      : 'No work content can currently be attributed to this agent with confidence.'
                    : zh
                      ? '该智能体线程尚未产生可读消息。'
                      : 'This agent thread has no readable messages yet.'
                }
              />
            ) : null}
            {threadItems.map((item) => (
              <ThreadItemView key={item.key} item={item} language={props.language} />
            ))}
          </section>
        </div>
      ) : (
        <section className="session-subagent-list" aria-live="polite">
          {loadingList && !snapshot ? <SubagentLoading label={zh ? '正在读取智能体…' : 'Loading agents…'} /> : null}
          {!loadingList && snapshot && snapshot.items.length === 0 ? <SubagentEmpty title={zh ? '暂无智能体' : 'No agents'} description={zh ? '当前会话还没有派生智能体。' : 'This conversation has not spawned any agents.'} /> : null}
          {grouped.active.length > 0 ? <SubagentGroup title={zh ? '进行中' : 'Active'} items={grouped.active} language={props.language} onOpen={(agent) => void openThread(agent.id, true)} /> : null}
          {grouped.done.length > 0 ? <SubagentGroup title={zh ? '已完成' : 'Done'} items={grouped.done} language={props.language} onOpen={(agent) => void openThread(agent.id, true)} /> : null}
        </section>
      )}
    </aside>
  );
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
