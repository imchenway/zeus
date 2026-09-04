import type { CodexAppServerManager, CodexResponsesRuntime, CodexThreadRuntimeStatus, CodexThreadSnapshot } from '@zeus/ai-runtime';
import type { ConversationSubmissionRepository, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import type { ConversationDispatchContext } from './codexNativeConversationContracts.js';
import type { NativeConversationRunState } from './codexNativeConversationContracts.js';
import { coordinatorError, isRecord, requireString, serializeError } from './codexNativeConversationPolicy.js';

type ProviderThreadAuthority = { type: 'active'; turnId: string; status: Extract<CodexThreadRuntimeStatus, { type: 'active' }> } | { type: 'idle'; status: Extract<CodexThreadRuntimeStatus, { type: 'idle' | 'notLoaded' }> };

interface ProviderActiveObserver {
  conversationId: string;
  providerThreadId: string;
  timer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
  delayIndex: number;
  consecutiveFailures: number;
}

interface CodexProviderThreadAuthorityOptions {
  manager: Pick<CodexAppServerManager, 'generationForThread' | 'readThread' | 'resumeThread'>;
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>;
  runStates: Map<string, NativeConversationRunState>;
  getConversation(conversationId: string): ZeusConversationWithMessagesRecord | undefined;
  requireConversation(conversationId: string): ZeusConversationWithMessagesRecord;
  prepareContext(conversationId: string): Promise<ConversationDispatchContext>;
  inferRunState(conversation: ZeusConversationWithMessagesRecord): NativeConversationRunState;
  responsesRuntimeFor(context: ConversationDispatchContext): Promise<CodexResponsesRuntime | null>;
  enqueueProviderTurnReconciliation(conversation: ZeusConversationWithMessagesRecord, input?: { priority?: 'control' }): Promise<void>;
  projectedProviderThreadSnapshot(conversationId: string, metadata: CodexThreadSnapshot): CodexThreadSnapshot;
  reconcileConversationSnapshot(conversation: ZeusConversationWithMessagesRecord, snapshot: CodexThreadSnapshot, generationId: string, input?: { preserveUnsentQueue?: boolean }): void;
  readyGenerationId(): string | null;
  persistThreadProviderSettings(conversationId: string, thread: CodexThreadSnapshot): void;
  persist(): Promise<void>;
  markConversationRecoveryRequired(conversationId: string, error: unknown): boolean;
  broadcast(type: string, payload: Record<string, unknown>): void;
  requestQueueDrain(): void;
}

export interface CodexProviderThreadAuthorityApplication {
  inspect(conversation: ZeusConversationWithMessagesRecord, context: ConversationDispatchContext, input?: { observeActive?: boolean }): Promise<ProviderThreadAuthority>;
  observe(conversationId: string, providerThreadId: string): void;
  queueChanged(conversationId: string): void;
  stopObserver(conversationId: string): void;
  markSubscribed(providerThreadId: string): void;
  markUnsubscribed(providerThreadId: string): void;
  close(): Promise<void>;
}

const observerDelaysMs = [1_000, 2_000, 5_000, 15_000] as const;

/** Provider thread 权威读取、恢复订阅与活动 turn 观察的单一应用边界。 */
export function createCodexProviderThreadAuthorityApplication(options: CodexProviderThreadAuthorityOptions): CodexProviderThreadAuthorityApplication {
  const authorityChains = new Map<string, Promise<ProviderThreadAuthority>>();
  const activeObservers = new Map<string, ProviderActiveObserver>();
  const subscribedThreads = new Set<string>();
  /** 关闭协调器时结束仍在加载大体量历史的本地恢复等待。 */
  const resumeAbortController = new AbortController();
  let closing = false;
  let closePromise: Promise<void> | null = null;

  function hasQueuedSubmission(conversationId: string): boolean {
    return options.submissions.listByConversation(conversationId).some((submission) => submission.status === 'queued' && !submission.providerTurnId);
  }

  function requiresProviderTurnProjection(conversation: ZeusConversationWithMessagesRecord, providerStatus: CodexThreadRuntimeStatus): boolean {
    if (providerStatus.type === 'active') return true;
    const state = options.runStates.get(conversation.id) ?? options.inferRunState(conversation);
    if (state.type === 'active' || state.type === 'waiting') return true;
    // queued -> dispatching 只是 Zeus 已取得本地派发租约，并不代表 Provider 已接受轮次。
    // 把这个写前状态当作 Provider 活动轮次会让每次“继续”重新读取完整历史，
    // 恰好把 thread/turns/list 放回 turn/start 的同步前置路径。
    if (state.type === 'dispatching') {
      const dispatchingSubmission = options.submissions.listByConversation(conversation.id).find((submission) => submission.id === state.submissionId);
      if (dispatchingSubmission?.providerTurnId) return true;
    }
    return options.submissions
      .listByConversation(conversation.id)
      .some((submission) => Boolean(submission.providerTurnId) && (submission.status === 'dispatching' || submission.status === 'active' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required')));
  }

  function stopObserver(conversationId: string): void {
    const observer = activeObservers.get(conversationId);
    if (!observer) return;
    if (observer.timer) clearTimeout(observer.timer);
    observer.timer = null;
    activeObservers.delete(conversationId);
  }

  function stopAllObservers(): void {
    for (const conversationId of [...activeObservers.keys()]) stopObserver(conversationId);
  }

  function scheduleObserver(observer: ProviderActiveObserver): void {
    if (closing || observer.polling || observer.timer || activeObservers.get(observer.conversationId) !== observer) return;
    const delay = observerDelaysMs[Math.min(observer.delayIndex, observerDelaysMs.length - 1)]!;
    observer.timer = setTimeout(() => {
      observer.timer = null;
      void pollActiveTurn(observer);
    }, delay);
    observer.timer.unref();
  }

  function observe(conversationId: string, providerThreadId: string): void {
    if (closing) return;
    if (!hasQueuedSubmission(conversationId)) {
      stopObserver(conversationId);
      return;
    }
    const existing = activeObservers.get(conversationId);
    if (existing?.providerThreadId === providerThreadId) {
      scheduleObserver(existing);
      return;
    }
    stopObserver(conversationId);
    const observer: ProviderActiveObserver = {
      conversationId,
      providerThreadId,
      timer: null,
      polling: false,
      delayIndex: 0,
      consecutiveFailures: 0,
    };
    activeObservers.set(conversationId, observer);
    scheduleObserver(observer);
  }

  function queueChanged(conversationId: string): void {
    if (!hasQueuedSubmission(conversationId)) stopObserver(conversationId);
  }

  function isTerminalAuthorityError(error: unknown): boolean {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
    return code === 'ZEUS_NATIVE_PROVIDER_SYSTEM_ERROR' || code === 'ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED' || code === 'ZEUS_CODEX_INVALID_RESPONSE';
  }

  async function pollActiveTurn(observer: ProviderActiveObserver): Promise<void> {
    if (closing || activeObservers.get(observer.conversationId) !== observer) return;
    const conversation = options.getConversation(observer.conversationId);
    if (!conversation || conversation.providerThreadId !== observer.providerThreadId || !hasQueuedSubmission(observer.conversationId)) {
      stopObserver(observer.conversationId);
      return;
    }
    observer.polling = true;
    try {
      const context = await options.prepareContext(conversation.id);
      const authority = await inspect(options.requireConversation(conversation.id), context, { observeActive: false });
      observer.consecutiveFailures = 0;
      if (authority.type === 'active') {
        observer.delayIndex = Math.min(observer.delayIndex + 1, observerDelaysMs.length - 1);
        return;
      }
      stopObserver(conversation.id);
      await options.persist();
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        providerThreadId: observer.providerThreadId,
        providerState: 'ready',
      });
      options.requestQueueDrain();
    } catch (error) {
      if (activeObservers.get(observer.conversationId) !== observer) return;
      observer.consecutiveFailures += 1;
      observer.delayIndex = Math.min(observer.delayIndex + 1, observerDelaysMs.length - 1);
      if (isTerminalAuthorityError(error) || observer.consecutiveFailures >= 3) {
        stopObserver(observer.conversationId);
        options.markConversationRecoveryRequired(observer.conversationId, error);
        await options.persist();
        options.broadcast('conversation.native.recovery_failed', {
          conversationId: observer.conversationId,
          providerThreadId: observer.providerThreadId,
          error: serializeError(error),
        });
        options.broadcast('conversation.queue.changed', { conversationId: observer.conversationId, providerThreadId: observer.providerThreadId });
      }
    } finally {
      observer.polling = false;
      if (activeObservers.get(observer.conversationId) === observer) scheduleObserver(observer);
    }
  }

  async function readAndProject(conversation: ZeusConversationWithMessagesRecord): Promise<ProviderThreadAuthority> {
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    // 派发门禁属于控制面读取，不能被同一 app-server 的慢过程投影反向阻塞。
    const metadata = await options.manager.readThread({ threadId: providerThreadId, priority: 'control' });
    if (metadata.id !== providerThreadId) {
      throw coordinatorError('ZEUS_CODEX_THREAD_IDENTITY_MISMATCH', 'Codex returned a different thread while reading authoritative state.');
    }
    const providerStatus = metadata.status;
    if (!providerStatus) {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread omitted its authoritative runtime status.');
    }
    if (providerStatus.type === 'systemError') {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_SYSTEM_ERROR', 'Provider thread is in systemError state.');
    }
    // 空闲 Provider + 本地安全边界已经足以允许下一轮派发。完整轮次历史属于投影面，
    // 不能继续作为每次“继续”的同步前置；只有任一侧仍有未终结轮次时才必须追平。
    if (requiresProviderTurnProjection(conversation, providerStatus)) {
      await options.enqueueProviderTurnReconciliation(options.requireConversation(conversation.id), { priority: 'control' });
    }
    const current = options.requireConversation(conversation.id);
    const snapshot = options.projectedProviderThreadSnapshot(conversation.id, metadata);
    const generationId = options.manager.generationForThread(providerThreadId) ?? options.readyGenerationId();
    if (!generationId) throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread has no authoritative runtime generation.');
    options.reconcileConversationSnapshot(current, snapshot, generationId, { preserveUnsentQueue: true });
    const state = options.runStates.get(conversation.id) ?? options.inferRunState(options.requireConversation(conversation.id));
    if (state.type === 'active' || state.type === 'waiting') {
      return { type: 'active', turnId: state.turnId, status: providerStatus.type === 'active' ? providerStatus : { type: 'active', activeFlags: [] } };
    }
    if (providerStatus.type === 'active') {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider reports an active thread but no exact active turn can be projected.');
    }
    if (state.type !== 'idle') {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread state cannot confirm a safe idle dispatch boundary.');
    }
    return { type: 'idle', status: providerStatus };
  }

  async function inspectUnserialized(conversation: ZeusConversationWithMessagesRecord, context: ConversationDispatchContext): Promise<ProviderThreadAuthority> {
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const first = await readAndProject(conversation);
    if (first.type === 'active' && subscribedThreads.has(providerThreadId)) return first;
    const confirmed = first.type === 'active' ? first : await readAndProject(options.requireConversation(conversation.id));
    if (confirmed.type === 'active' && subscribedThreads.has(providerThreadId)) return confirmed;
    if (confirmed.status.type === 'idle' && subscribedThreads.has(providerThreadId)) return confirmed;

    const responsesRuntime = await options.responsesRuntimeFor(context);
    let resumed: CodexThreadSnapshot;
    try {
      resumed = await options.manager.resumeThread({
        threadId: providerThreadId,
        ...(context.projectLocalPath ? { cwd: context.projectLocalPath } : {}),
        ...(responsesRuntime ? { responsesRuntime } : {}),
        signal: resumeAbortController.signal,
      });
    } catch (resumeError) {
      // 关闭流程已经明确取消本地等待，不再追加一次权威读取拖延执行宿主交接。
      if (closing) throw resumeError;
      // 只读确认后可能恰好开始新轮次；仅当本连接已从实时事件确认订阅时才能
      // 接受该竞争结果。活动态本身不代表新宿主拥有后续事件订阅。
      const raced = await readAndProject(options.requireConversation(conversation.id)).catch(() => null);
      if (raced?.type === 'active' && subscribedThreads.has(providerThreadId)) return raced;
      throw resumeError;
    }
    if (resumed.id !== providerThreadId) {
      throw coordinatorError('ZEUS_CODEX_THREAD_IDENTITY_MISMATCH', 'Codex returned a different thread while resuming authoritative state.');
    }
    subscribedThreads.add(providerThreadId);
    options.persistThreadProviderSettings(conversation.id, resumed);
    const afterResume = await readAndProject(options.requireConversation(conversation.id));
    if (afterResume.type === 'active') return afterResume;
    if (afterResume.status.type !== 'idle') {
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread remained notLoaded after resume.');
    }
    return afterResume;
  }

  function inspect(conversation: ZeusConversationWithMessagesRecord, context: ConversationDispatchContext, input: { observeActive?: boolean } = {}): Promise<ProviderThreadAuthority> {
    const previous = authorityChains.get(conversation.id);
    const waitForPrevious = previous
      ? previous.then(
          () => undefined,
          () => undefined,
        )
      : Promise.resolve();
    const authority = waitForPrevious.then(() => inspectUnserialized(options.requireConversation(conversation.id), context));
    authorityChains.set(conversation.id, authority);
    void authority
      .finally(() => {
        if (authorityChains.get(conversation.id) === authority) authorityChains.delete(conversation.id);
      })
      .catch(() => undefined);
    return authority.then((result) => {
      if (result.type === 'active' && input.observeActive !== false) {
        observe(conversation.id, requireString(options.requireConversation(conversation.id).providerThreadId, 'provider thread id'));
      } else if (result.type === 'idle') {
        stopObserver(conversation.id);
      }
      return result;
    });
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    resumeAbortController.abort();
    stopAllObservers();
    closePromise = Promise.allSettled([...authorityChains.values()]).then(() => {
      subscribedThreads.clear();
      authorityChains.clear();
      activeObservers.clear();
    });
    return closePromise;
  }

  return {
    inspect,
    observe,
    queueChanged,
    stopObserver,
    markSubscribed(providerThreadId) {
      subscribedThreads.add(providerThreadId);
    },
    markUnsubscribed(providerThreadId) {
      subscribedThreads.delete(providerThreadId);
    },
    close,
  };
}
