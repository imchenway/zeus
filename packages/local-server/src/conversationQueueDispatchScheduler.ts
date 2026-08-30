export interface ConversationQueueDispatchSchedulerOptions {
  dispatch(conversationId: string): Promise<void>;
  onError(conversationId: string, error: unknown): Promise<void> | void;
  enqueue?(work: () => void): void;
}

interface ConversationQueueDispatchState {
  requestedRevision: number;
  completedRevision: number;
  scheduled: boolean;
  running: Promise<void> | null;
  waiters: Array<{ revision: number; resolve(): void }>;
}

export function mustWaitForInProcessRuntimeTurn(runtimeKind: 'codex' | 'pi', inProgressTurns: ReadonlyArray<{ agentKind: string | null }>): boolean {
  if (inProgressTurns.length === 0) return false;
  // Pi Worker 是唯一活动权威时，只能等待它发出终态。Codex Provider 则允许 coordinator
  // 继续观察 Provider thread，以收口 Core 重启后残留的本地 active 状态。
  return runtimeKind === 'pi' || inProgressTurns.some((turn) => turn.agentKind === 'pi');
}

/**
 * 会话队首派发的进程内单 owner 调度器。
 *
 * 多个事实可能同时要求重新核对同一队首：HTTP 接纳、终态事件、Provider 权威观察、
 * 启动恢复和显式重试。旧实现用 Set 直接丢弃 owner 忙碌期间的后续唤醒；这里以递增
 * revision 保留“至少再核对一次”的事实，同时仍保证同一会话没有并发派发。
 */
export class ConversationQueueDispatchScheduler {
  private readonly states = new Map<string, ConversationQueueDispatchState>();
  private readonly enqueue: (work: () => void) => void;

  constructor(private readonly options: ConversationQueueDispatchSchedulerOptions) {
    this.enqueue = options.enqueue ?? queueMicrotask;
  }

  request(conversationId: string): Promise<void> {
    const state = this.states.get(conversationId) ?? {
      requestedRevision: 0,
      completedRevision: 0,
      scheduled: false,
      running: null,
      waiters: [],
    };
    if (!this.states.has(conversationId)) this.states.set(conversationId, state);
    state.requestedRevision += 1;
    const revision = state.requestedRevision;
    const completion = new Promise<void>((resolve) => state.waiters.push({ revision, resolve }));
    this.schedule(conversationId, state);
    return completion;
  }

  snapshot(conversationId: string): { requestedRevision: number; completedRevision: number; scheduled: boolean; running: boolean } | null {
    const state = this.states.get(conversationId);
    return state
      ? {
          requestedRevision: state.requestedRevision,
          completedRevision: state.completedRevision,
          scheduled: state.scheduled,
          running: state.running !== null,
        }
      : null;
  }

  private schedule(conversationId: string, state: ConversationQueueDispatchState): void {
    if (state.scheduled || state.running) return;
    state.scheduled = true;
    this.enqueue(() => {
      state.scheduled = false;
      if (state.running) return;
      const running = this.drain(conversationId, state);
      state.running = running;
      void running.finally(() => {
        if (state.running === running) state.running = null;
        if (state.completedRevision < state.requestedRevision) {
          this.schedule(conversationId, state);
          return;
        }
        if (state.waiters.length === 0) this.states.delete(conversationId);
      });
    });
  }

  private async drain(conversationId: string, state: ConversationQueueDispatchState): Promise<void> {
    while (state.completedRevision < state.requestedRevision) {
      const targetRevision = state.requestedRevision;
      try {
        await this.options.dispatch(conversationId);
      } catch (error) {
        try {
          await this.options.onError(conversationId, error);
        } catch {
          // onError 是最后诊断边界；派发 owner 仍必须释放，不能因日志持久化失败永久卡住队列。
        }
      }
      state.completedRevision = targetRevision;
      const completed = state.waiters.filter((waiter) => waiter.revision <= targetRevision);
      state.waiters = state.waiters.filter((waiter) => waiter.revision > targetRevision);
      for (const waiter of completed) waiter.resolve();
    }
  }
}
