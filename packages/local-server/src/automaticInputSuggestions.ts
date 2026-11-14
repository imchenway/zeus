import {
  inputSuggestionModelKey,
  inputSuggestionRetryDelay,
  normalizeInputSuggestionSettings,
  userFacingErrorCause,
  type AutomaticInputSuggestionState,
  type InputSuggestionRequest,
  type InputSuggestionResult,
  type InputSuggestionSettings,
} from '@zeus/shared';
import type { InputSuggestionJob, InputSuggestionJobRepository } from '@zeus/storage';

/** Core 独立消费持久自动建议，窗口只读取状态，不再拥有任务生命周期。 */
export function createAutomaticInputSuggestions(options: {
  /** 原轮次关联的耐久任务。 */
  jobs: InputSuggestionJobRepository;
  /** 仅显式启用的建议配置允许产生模型用量。 */
  readSettings: () => InputSuggestionSettings | undefined;
  /** 会话项目和归档状态来自主记录。 */
  getConversation: (conversationId: string) => { projectId: string; archived?: boolean } | undefined;
  /** 跟随模型始终由原会话解析。 */
  conversationModelRef?: (conversationId: string) => string | null;
  /** 新用户提交使旧回复候选过期。 */
  hasPendingSubmission: (conversationId: string) => boolean;
  /** 自动、手动共用已校验的无工具生成通路。 */
  generate: (input: InputSuggestionRequest, signal: AbortSignal) => Promise<InputSuggestionResult>;
  /** 推送只作为刷新提示，丢失后仍可读取持久状态。 */
  publish: (type: string, payload: Record<string, unknown>) => void;
  /** 旁路故障只记录诊断，不影响正文。 */
  onError: (error: unknown) => void;
}) {
  /** 同时最多生成两条建议，避免多个会话争抢模型进程与准备预算。 */
  const active = new Map<string, { conversationId: string; controller: AbortController; promise: Promise<void> }>();
  /** 宿主关闭后不接纳新任务。 */
  let closed = false;
  /** 单个 Core 内不重入领取。 */
  let ticking = false;
  /** 由 Main 的系统联网状态更新；过期报告不能永久阻塞脱离窗口的 Core。 */
  let network = { online: true, observedAt: 0 };
  /** Core 自身的唤醒时钟，不随页面卸载。 */
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Main 每五秒报告，十五秒未收到报告时改由实际传输判定可用性。 */
  function networkAvailable(): boolean {
    return network.online || Date.now() - network.observedAt > 15_000;
  }

  /** 状态先持久化，再通知窗口按项目和会话刷新。 */
  function notify(conversationId: string): void {
    const conversation = options.getConversation(conversationId);
    if (conversation) {
      try {
        options.publish('input_suggestions.changed', { projectId: conversation.projectId, conversationId });
      } catch (error) {
        options.onError(error);
      }
    }
  }

  /** 入队读取当前真实用户轮次；旧历史仅在用户打开对应会话时按需恢复。 */
  function ensure(conversationId: string): void {
    const settings = normalizeInputSuggestionSettings(options.readSettings());
    if (!settings.enabled) return;
    const conversation = options.getConversation(conversationId);
    const latest = options.jobs.latestTurn(conversationId);
    if (!conversation || conversation.archived || !latest || latest.status !== 'completed' || options.hasPendingSubmission(conversationId)) return;
    const modelRef = settings.followConversationModel ? (options.conversationModelRef?.(conversationId) ?? null) : settings.modelRef;
    options.jobs.enqueue(latest.id, inputSuggestionModelKey(settings), modelRef, new Date().toISOString());
  }

  /** 每次异步生成前后都复核原轮次及模型，迟到回执不跨要求或配置生效。 */
  function current(job: InputSuggestionJob): boolean {
    const settings = normalizeInputSuggestionSettings(options.readSettings());
    const conversation = options.getConversation(job.conversationId);
    const modelRef = settings.followConversationModel ? (options.conversationModelRef?.(job.conversationId) ?? null) : settings.modelRef;
    return (
      settings.enabled &&
      !!conversation &&
      !conversation.archived &&
      options.jobs.latestTurn(job.conversationId)?.id === job.turnId &&
      !options.hasPendingSubmission(job.conversationId) &&
      inputSuggestionModelKey(settings) === job.modelKey &&
      modelRef === job.modelRef
    );
  }

  /** 一次领取最多产生一次无工具调用，失败只更新原任务的下一次尝试时刻。 */
  async function execute(job: InputSuggestionJob, controller: AbortController): Promise<void> {
    let result: InputSuggestionResult;
    try {
      if (!current(job)) {
        ensure(job.conversationId);
        result = { completedTurnId: job.turnId, modelRef: job.modelRef, text: null, reason: 'cancelled', retryable: false };
      } else {
        result = await options.generate({ mode: 'suggest', trigger: 'automatic', projectId: job.projectId, conversationId: job.conversationId, completedTurnId: job.turnId }, controller.signal);
      }
    } catch (error) {
      result = { completedTurnId: job.turnId, modelRef: job.modelRef, text: null, reason: 'failed', cause: userFacingErrorCause(error) };
    }
    if (closed) return;
    if (controller.signal.aborted) {
      options.jobs.pause(job, new Date().toISOString());
      notify(job.conversationId);
      return;
    }
    if (!current(job)) {
      ensure(job.conversationId);
      result = { ...result, text: null, reason: 'cancelled', retryable: false };
    }
    const delay = result.text ? null : inputSuggestionRetryDelay(result, Math.max(0, job.attemptCount - 1), 'automatic');
    const state = result.text ? 'ready' : delay !== null ? 'pending' : ['cancelled', 'context_unavailable', 'disabled'].includes(result.reason ?? '') ? 'cancelled' : 'blocked';
    const now = new Date().toISOString();
    options.jobs.finish(job, result, state, new Date(Date.now() + (delay ?? 0)).toISOString(), now);
    notify(job.conversationId);
  }

  /** 完成轮次已在同事务登记待办，领取并发固定为两个。 */
  function kick(): void {
    if (closed || ticking || !normalizeInputSuggestionSettings(options.readSettings()).enabled) return;
    ticking = true;
    try {
      if (!networkAvailable()) return;
      while (active.size < 2) {
        const job = options.jobs.claim(new Date().toISOString(), [...active.keys()]);
        if (!job) break;
        const controller = new AbortController();
        const entry = { conversationId: job.conversationId, controller, promise: Promise.resolve() };
        active.set(job.turnId, entry);
        notify(job.conversationId);
        entry.promise = execute(job, controller)
          .catch(options.onError)
          .finally(() => {
            active.delete(job.turnId);
            kick();
          });
      }
    } catch (error) {
      options.onError(error);
    } finally {
      ticking = false;
    }
  }

  return {
    /** 服务可用后才恢复领取，启动不受窗口存在与否影响。 */
    start(): void {
      options.jobs.recover(new Date().toISOString());
      timer = setInterval(kick, 1_000);
      timer.unref();
      kick();
    },
    /** 真实完成与当前会话恢复共用幂等入队。 */
    ensure(conversationId: string): void {
      ensure(conversationId);
      kick();
    },
    /** 新要求与用户取消都持久化，后台恢复不会复活旧候选。 */
    dismiss(conversationId: string, turnId?: string): void {
      options.jobs.cancel(conversationId, new Date().toISOString(), turnId);
      for (const [id, entry] of active) if (entry.conversationId === conversationId && (!turnId || turnId === id)) entry.controller.abort('cancelled');
      notify(conversationId);
    },
    /** 设置变化中止旧配置；当前轮次按新配置重新登记。 */
    settingsChanged(): void {
      for (const entry of active.values()) entry.controller.abort('settings_changed');
      options.jobs.retryBlocked(new Date().toISOString());
      kick();
    },
    /** 目录或登录恢复只唤醒阻塞任务，不中断其他正在生成的请求。 */
    availabilityChanged(): void {
      options.jobs.retryBlocked(new Date().toISOString());
      kick();
    },
    /** Main 的系统离线报告暂停新领取，并释放尚未完成的尝试。 */
    networkChanged(online: boolean): void {
      const changed = network.online !== online;
      network = { online, observedAt: Date.now() };
      if (!online) for (const entry of active.values()) entry.controller.abort('network_offline');
      if (changed) options.publish('input_suggestions.network.changed', { online });
      if (online && changed) options.jobs.retryBlocked(new Date().toISOString());
      if (online) kick();
    },
    /** 持久结果可在窗口重载、切页和实时事件遗漏后读取。 */
    read(conversationId: string): AutomaticInputSuggestionState | null {
      if (!normalizeInputSuggestionSettings(options.readSettings()).enabled || options.getConversation(conversationId)?.archived) return null;
      if (options.hasPendingSubmission(conversationId)) return null;
      const job = options.jobs.current(conversationId);
      if (!job) return null;
      return {
        completedTurnId: job.turnId,
        modelRef: job.modelRef,
        text: null,
        reason: null,
        ...job.result,
        modelKey: job.modelKey ?? inputSuggestionModelKey(normalizeInputSuggestionSettings(options.readSettings())),
        state: job.state,
        attemptCount: job.attemptCount,
        nextAttemptAt: job.state === 'pending' ? job.nextAttemptAt : null,
        waitingForNetwork: !networkAvailable(),
      };
    },
    /** 关闭保留未完成记录，下一次 Core 启动按原轮次恢复。 */
    async close(): Promise<void> {
      closed = true;
      clearInterval(timer);
      for (const entry of active.values()) entry.controller.abort('host_shutdown');
      await Promise.allSettled([...active.values()].map((entry) => entry.promise));
    },
  };
}
