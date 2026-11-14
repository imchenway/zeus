import {
  inputSuggestionModelKey,
  inputSuggestionRetryDelay,
  userFacingErrorCause,
  type AutomaticInputSuggestionState,
  type InputSuggestionRequest,
  type InputSuggestionResult,
  type InputSuggestionSettings,
  type InputSuggestionUiDiagnostic,
} from '@zeus/shared';
import type { ConversationApiClient } from '../features/conversations/conversationApiClient.js';

export { inputSuggestionRetryDelay } from '@zeus/shared';

/** 后台触发和输入框读取共用完全相同的会话、模型及轮次身份。 */
export function inputSuggestionIdentity(options: {
  /** 项目与会话共同隔离候选。 */
  projectId?: string | null;
  /** 已建立会话使用持久身份。 */
  conversationId?: string | null;
  /** 新草稿使用项目或任务归属。 */
  scopeKey?: string;
  /** 只读取专用建议配置。 */
  settings?: InputSuggestionSettings;
  /** 自动建议始终绑定已完成轮次。 */
  turnId?: string | null;
}) {
  /** 显式元组防止分隔字符造成身份冲突。 */
  const sessionKey = JSON.stringify(options.conversationId ? ['conversation', options.projectId, options.conversationId] : ['draft', options.projectId ?? '', options.scopeKey ?? '']);
  /** 跟随或专用模型、推理深度和速度共同确定配置身份。 */
  const modelKey = inputSuggestionModelKey(options.settings);
  /** 手动结果不随主会话轮次推进失效。 */
  const resultKey = JSON.stringify([sessionKey, modelKey]);
  /** 自动生成独立于手动润色，完成事件不因手动请求占用而丢失。 */
  const automaticSessionKey = JSON.stringify([sessionKey, 'automatic']);
  return { sessionKey, automaticSessionKey, modelKey, resultKey, automaticResultKey: JSON.stringify([resultKey, options.turnId ?? null]) };
}

/** 请求和结果属于会话，输入框只订阅当前会话的快照。 */
interface InputSuggestionSnapshot extends Pick<InputSuggestionResult, 'text' | 'reason' | 'cause' | 'modelRef'> {
  /** 持久自动任务的原轮次，手动请求可以为空。 */
  completedTurnId: string | null;
  /** 每次主动或自动生成的稳定身份，重试不创建另一份候选。 */
  requestId: string;
  /** 手动结果绑定会话与模型，自动结果另绑定完成轮次。 */
  key: string;
  /** 专用模型、推理深度和速度共同决定请求配置。 */
  modelKey: string;
  /** 润色绑定请求时的原文；空输入建议只在草稿再次为空时展示。 */
  sourceDraft: string;
  /** 空输入建议与草稿润色使用原有生成通路。 */
  mode: InputSuggestionRequest['mode'];
  /** 自动预测仍遵循完成轮次约束。 */
  trigger: InputSuggestionRequest['trigger'];
  /** 后台运行时继续更新快照，切回只显示当前状态。 */
  pending: boolean;
  /** 从零开始记录重试次数，切换页面不重置。 */
  retryAttempt: number;
  /** 等待自动重试时保留计划时刻，生成中与结束后为空。 */
  retryAt: number | null;
  /** 系统报告离线时暂停发出请求，联网后继续当前尝试。 */
  waitingForNetwork: boolean;
}

/** 每个候选槽位持有一个请求，自动建议和手动润色独立复用，不依赖组件挂载。 */
class InputSuggestionSession {
  /** 不可变快照满足 React 外部状态订阅要求。 */
  private result: InputSuggestionSnapshot | null = null;
  /** 只有明确取消或失效才终止生成，退订不会触发取消。 */
  private controller: AbortController | null = null;
  /** 已展示预览的请求不因输入框重新挂载而再次弹出。 */
  private presentedRequestId: string | null = null;
  /** 用户消息事件可能重复送达，只在新的稳定身份出现时清除旧候选。 */
  private observedUserInputs = new Set<string>();
  /** 每个会话独立通知，后台结果不会刷新其他会话。 */
  private listeners = new Set<() => void>();
  /** 自动建议只读取所属项目和会话的持久状态。 */
  private automaticScope: { projectId: string; conversationId: string } | null = null;
  /** 取消读取不会取消 Core 中的模型生成。 */
  private automaticRead: AbortController | null = null;
  /** 可见会话每五秒补读，推送丢失仍能恢复结果。 */
  private automaticTimer: ReturnType<typeof setInterval> | null = null;
  /** 读取期间到达的推送只合并为一次后续刷新。 */
  private automaticReadAgain = false;
  /** 明确关闭的轮次先在本地隐藏，直到取消操作成功写入 Core。 */
  private dismissedAutomaticTurn: string | null = null;
  /** 本机连接临时不可用时保留取消意图，下次读取前重试。 */
  private automaticDismissPending = false;
  /** 首次打开和配置变化只登记一次恢复，不把定时补读变成反复入队。 */
  private automaticEnsured = false;
  /** 当前窗口采用的配置身份，用于重新登记模型变更。 */
  private automaticSettingsKey: string | null = null;

  /** 切页只取消自动状态补读，Core 生成和手动请求继续由各自状态持有。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.automaticScope && !this.automaticTimer) {
      this.automaticEnsured = false;
      this.automaticTimer = setInterval(() => this.refreshAutomatic(), 5_000);
      this.refreshAutomatic();
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        if (this.automaticTimer) clearInterval(this.automaticTimer);
        this.automaticTimer = null;
        this.automaticRead?.abort();
      }
      pruneInputSuggestionSessions();
    };
  };

  /** 同一结果始终返回同一引用，避免重复渲染。 */
  getSnapshot = (): InputSuggestionSnapshot | null => this.result;

  /** 注册读取归属，不创建模型请求。 */
  configureAutomatic(projectId: string, conversationId: string): void {
    this.automaticScope = { projectId, conversationId };
  }

  /** 新要求只清理本窗口投影，任务是否过期由 Core 判定。 */
  invalidateAutomatic(): void {
    this.automaticEnsured = false;
    this.automaticRead?.abort();
    this.publish(null);
    this.refreshAutomatic();
  }

  /** 推送、首次订阅与定时补读共用一条可取消的只读请求。 */
  refreshAutomatic(): void {
    if (!this.automaticScope || !automaticClient || (this.listeners.size === 0 && !this.automaticDismissPending)) return;
    if (this.automaticRead) {
      this.automaticReadAgain = true;
      return;
    }
    const scope = this.automaticScope;
    const client = automaticClient;
    const controller = new AbortController();
    this.automaticRead = controller;
    void (async () => {
      if (this.automaticDismissPending && this.dismissedAutomaticTurn) {
        await client.dismissAutomaticInputSuggestion(scope.projectId, scope.conversationId, this.dismissedAutomaticTurn, controller.signal);
        this.automaticDismissPending = false;
      }
      if (!this.automaticEnsured) {
        await client.ensureAutomaticInputSuggestion(scope.projectId, scope.conversationId, controller.signal);
        this.automaticEnsured = true;
      }
      const { suggestion } = await client.loadAutomaticInputSuggestion(scope.projectId, scope.conversationId, controller.signal);
      if (!controller.signal.aborted) this.applyAutomatic(suggestion);
    })()
      .catch(() => {
        // 连接恢复后补读；读取失败不删除已有候选，也不冒充模型生成失败。
      })
      .finally(() => {
        if (this.automaticRead === controller) this.automaticRead = null;
        if (this.automaticReadAgain) {
          this.automaticReadAgain = false;
          this.refreshAutomatic();
        }
        pruneInputSuggestionSessions();
      });
  }

  /** 同一轮明确取消后不因迟到读取恢复候选。 */
  private applyAutomatic(state: AutomaticInputSuggestionState | null): void {
    if (!state || state.state === 'cancelled' || state.completedTurnId === this.dismissedAutomaticTurn) {
      this.publish(null);
      return;
    }
    const pending = state.state === 'pending' || state.state === 'running';
    const snapshot: InputSuggestionSnapshot = {
      completedTurnId: state.completedTurnId,
      requestId: JSON.stringify([state.completedTurnId, state.modelKey]),
      key: JSON.stringify([this.automaticScope, state.completedTurnId, state.modelKey]),
      modelKey: state.modelKey,
      modelRef: state.modelRef,
      sourceDraft: '',
      mode: 'suggest',
      trigger: 'automatic',
      pending,
      text: state.text,
      reason: pending ? null : state.reason,
      cause: state.cause,
      retryAttempt: Math.max(0, state.attemptCount - (state.state === 'pending' ? 0 : 1)),
      retryAt: state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : null,
      waitingForNetwork: pending && state.waitingForNetwork,
    };
    if (JSON.stringify(this.result) !== JSON.stringify(snapshot)) this.publish(snapshot);
  }

  /** 只有当前手动请求的有效结果可以首次展开预览。 */
  claimPreview = (requestId: string): boolean => {
    if (this.result?.requestId !== requestId || this.result.trigger !== 'manual' || this.result.pending || !this.result.text || this.presentedRequestId === requestId) return false;
    this.presentedRequestId = requestId;
    return true;
  };

  /** 编辑只使原文润色失效，空输入建议继续生成并在删空后展示。 */
  invalidateDraft(): void {
    if (this.result?.mode === 'suggest' && this.result.sourceDraft === '') return;
    this.dismiss();
  }

  /** 已发送要求变化时清除候选，普通助手进度不走此入口。 */
  observeUserInput(identity: string): void {
    if (this.observedUserInputs.has(identity)) return;
    this.observedUserInputs.add(identity);
    if (this.observedUserInputs.size > 64) this.observedUserInputs.delete(this.observedUserInputs.values().next().value!);
    this.dismiss();
  }

  /** 活动请求和可见投影不回收，已结束的自动投影可从 Core 重新读取。 */
  get retained(): boolean {
    return this.controller !== null || this.automaticRead !== null || this.automaticDismissPending || this.listeners.size > 0;
  }

  /** 发送、采用、明确取消或上下文失效时清理；旧浮层不能取消新请求。 */
  dismiss = (requestId?: string): void => {
    if (requestId !== undefined && this.result?.requestId !== requestId) return;
    if (this.automaticScope) {
      if (this.result?.completedTurnId) {
        this.dismissedAutomaticTurn = this.result.completedTurnId;
        this.automaticDismissPending = true;
      }
      this.automaticRead?.abort();
      this.publish(null);
      this.refreshAutomatic();
      return;
    }
    this.controller?.abort();
    this.controller = null;
    this.presentedRequestId = null;
    this.publish(null);
  };

  /** 配置变化也清理不可见会话，旧模型的迟到结果不能恢复。 */
  invalidateSettings(modelKey: string, automaticEnabled: boolean): void {
    if (this.automaticScope) {
      if (this.automaticSettingsKey !== modelKey) {
        this.automaticSettingsKey = modelKey;
        this.automaticEnsured = false;
      }
      if (this.result && (this.result.modelKey !== modelKey || !automaticEnabled)) this.publish(null);
      if (automaticEnabled) this.refreshAutomatic();
      return;
    }
    if (this.result && (this.result.modelKey !== modelKey || (this.result.trigger !== 'manual' && !automaticEnabled))) this.dismiss();
  }

  /** 生成由会话状态层持有，卸载输入框后继续接收完成或失败。 */
  start(options: {
    /** 含自动轮次约束的结果身份。 */
    key: string;
    /** 捕获本次所选模型配置。 */
    modelKey: string;
    /** 润色绑定原文；空输入建议不依赖用户后来输入的文字。 */
    sourceDraft: string;
    /** 专用模型核对回执身份；跟随模式由服务端解析并核对当前会话。 */
    modelRef: string | null;
    /** 生成请求继续使用现有 HTTP 通路。 */
    request: InputSuggestionRequest;
    /** 捕获发起时的客户端函数，页面切换不替换正在执行的调用。 */
    generate: (input: InputSuggestionRequest, signal: AbortSignal, diagnosticId?: string) => Promise<InputSuggestionResult>;
  }): void {
    if (this.controller) return;
    /** 每次请求使用独立身份，迟到回调不得覆盖后续生成。 */
    const controller = new AbortController();
    this.controller = controller;
    /** 同一次点击跨界面、HTTP 和模型阶段共用身份，不复用上一轮的编号。 */
    let diagnosticId = crypto.randomUUID();
    /** 单调计时不受系统时钟调整影响。 */
    let startedAt = performance.now();
    /** 仅把状态、枚举和字数发送给本机 Main，禁止附带草稿与建议正文。 */
    const record = (event: InputSuggestionUiDiagnostic['event'], outcome?: string, outputCharacters?: number): void => {
      try {
        if (typeof window !== 'undefined')
          window.zeus?.reportInputSuggestionDiagnostic?.({ requestId: diagnosticId, event, mode: options.request.mode, trigger: options.request.trigger, elapsedMs: Math.round(performance.now() - startedAt), outcome, outputCharacters });
      } catch {
        /* 诊断不可用不阻断用户的生成操作。 */
      }
    };
    controller.signal.addEventListener('abort', () => record('ui_cancelled', 'client_cancelled'), { once: true });
    /** 等待和完成使用同一份原文及请求归属。 */
    const snapshot: InputSuggestionSnapshot = {
      completedTurnId: options.request.completedTurnId ?? null,
      requestId: diagnosticId,
      key: options.key,
      modelKey: options.modelKey,
      modelRef: options.modelRef,
      sourceDraft: options.sourceDraft,
      mode: options.request.mode,
      trigger: options.request.trigger,
      pending: true,
      text: null,
      reason: null,
      retryAttempt: 0,
      retryAt: null,
      waitingForNetwork: false,
    };
    this.publish(snapshot);
    void (async () => {
      try {
        for (let retryAttempt = 0; !controller.signal.aborted; retryAttempt += 1) {
          if (typeof window !== 'undefined' && window.navigator.onLine === false) {
            this.publish({ ...snapshot, retryAttempt, waitingForNetwork: true });
            await new Promise<void>((resolve) => {
              /** 联网或取消后解除全部监听，离线等待不创建请求或消耗尝试次数。 */
              const finish = (): void => {
                window.removeEventListener('online', resume);
                controller.signal.removeEventListener('abort', finish);
                resolve();
              };
              /** 注册完成后复核状态，避免错过注册期间的联网或取消。 */
              const resume = (): void => {
                if (controller.signal.aborted || window.navigator.onLine !== false) finish();
              };
              window.addEventListener('online', resume);
              controller.signal.addEventListener('abort', finish, { once: true });
              resume();
            });
            if (controller.signal.aborted) return;
          }
          if (retryAttempt > 0) {
            diagnosticId = crypto.randomUUID();
            startedAt = performance.now();
          }
          this.publish({ ...snapshot, retryAttempt });
          record('ui_started');
          /** 响应失败和传输失败共用恢复通路，自动建议持续恢复临时故障。 */
          let response: InputSuggestionResult;
          try {
            response = await options.generate(options.request, controller.signal, diagnosticId);
            record('ui_received', response.reason ?? 'generated', response.text?.length ?? 0);
          } catch (error: unknown) {
            if (!controller.signal.aborted) record('ui_failed', 'request_failed');
            response = { text: null, reason: 'failed', cause: userFacingErrorCause(error), modelRef: options.modelRef, completedTurnId: options.request.completedTurnId ?? null };
          }
          if (this.controller !== controller || controller.signal.aborted) {
            record('ui_discarded', 'request_replaced_or_cancelled');
            return;
          }
          if ((options.modelRef !== null && response.modelRef !== options.modelRef) || (response.text && !response.modelRef) || (options.request.trigger === 'automatic' && response.completedTurnId !== options.request.completedTurnId)) {
            record('ui_discarded', 'identity_changed');
            this.publish(null);
            return;
          }
          /** 有效候选不重复生成，剩余失败按明确原因决定是否等待。 */
          const retryDelay = response.text ? null : inputSuggestionRetryDelay(response, retryAttempt, options.request.trigger);
          if (retryDelay === null) {
            this.publish({ ...snapshot, modelRef: response.modelRef, text: response.text, reason: response.reason, cause: response.cause, pending: false, retryAttempt });
            record('ui_result_stored', response.reason ?? 'generated', response.text?.length ?? 0);
            return;
          }
          this.publish({ ...snapshot, retryAttempt: retryAttempt + 1, retryAt: Date.now() + retryDelay });
          await new Promise<void>((resolve) => {
            /** 取消立即结束等待并移除监听，发送或改设置后不能留下定时请求。 */
            const finish = (): void => {
              clearTimeout(timer);
              controller.signal.removeEventListener('abort', finish);
              resolve();
            };
            /** 等待期间继续持有会话控制器，卸载不取消，连续 Tab 不重复请求。 */
            const timer = setTimeout(finish, retryDelay);
            controller.signal.addEventListener('abort', finish, { once: true });
            if (controller.signal.aborted) finish();
          });
        }
      } finally {
        if (this.controller === controller) this.controller = null;
        pruneInputSuggestionSessions();
      }
    })();
  }

  /** 只有当前会话订阅者接收状态变化，错误也保存在原会话。 */
  private publish(result: InputSuggestionSnapshot | null): void {
    if (this.result === result) return;
    this.result = result;
    for (const listener of this.listeners) listener();
  }
}

/** 当前窗口仅保留最近使用的投影；自动任务和结果由 Core 持久保存。 */
const sessions = new Map<string, InputSuggestionSession>();
/** 当前已认证客户端只提供持久状态的读取与明确取消。 */
let automaticClient: Pick<ConversationApiClient, 'loadAutomaticInputSuggestion' | 'ensureAutomaticInputSuggestion' | 'dismissAutomaticInputSuggestion'> | null = null;
/** 回收无人使用的草稿和手动状态，活动请求及自动候选不按容量淘汰。 */
const retainedSessionLimit = 100;

/** 仅淘汰最久未访问、已结束且没有显示订阅的记录。 */
function pruneInputSuggestionSessions(protectedSession?: InputSuggestionSession): void {
  for (const [key, session] of sessions) {
    if (sessions.size <= retainedSessionLimit) break;
    if (session !== protectedSession && !session.retained) sessions.delete(key);
  }
}

/** 会话或新草稿归属提供稳定身份，返回同一个可订阅状态对象。 */
export function getInputSuggestionSession(key: string): InputSuggestionSession {
  /** 重开会话更新访问顺序，保留原对象和正在运行的请求。 */
  const session = sessions.get(key) ?? new InputSuggestionSession();
  sessions.delete(key);
  sessions.set(key, session);
  pruneInputSuggestionSessions(session);
  return session;
}

/** 自动建议复用会话状态订阅，不把读取动作变成新的生成请求。 */
export function getAutomaticInputSuggestionSession(projectId: string, conversationId: string): InputSuggestionSession {
  const session = getInputSuggestionSession(inputSuggestionIdentity({ projectId, conversationId }).automaticSessionKey);
  session.configureAutomatic(projectId, conversationId);
  return session;
}

/** 工作台挂载或连接更新后，补读已有可见会话；退订不取消 Core 任务。 */
export function configureAutomaticInputSuggestionClient(client: typeof automaticClient): void {
  automaticClient = client;
  refreshAutomaticInputSuggestions();
}

/** 推送丢失后的重连和系统网络变化均补读当前可见会话。 */
export function refreshAutomaticInputSuggestions(): void {
  for (const session of sessions.values()) session.refreshAutomatic();
}

/** 专用模型或自动开关变化时，同步所有已经发起过建议的会话。 */
export function synchronizeInputSuggestionSettings(modelKey: string, automaticEnabled: boolean): void {
  for (const session of sessions.values()) session.invalidateSettings(modelKey, automaticEnabled);
}
