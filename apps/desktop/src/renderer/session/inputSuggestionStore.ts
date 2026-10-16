import { userFacingErrorCause, type InputSuggestionRequest, type InputSuggestionResult, type InputSuggestionSettings, type InputSuggestionUiDiagnostic } from '@zeus/shared';

/** 仅对无工具的建议生成恢复已知临时故障，不复用主会话发送的重试规则。 */
const transientSuggestionErrors = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'ZEUS_EXECUTION_HOST_DRAINING',
  'ZEUS_CODEX_RPC_TIMEOUT',
  'ZEUS_CODEX_MODEL_AT_CAPACITY',
  'serverOverloaded',
  'ZEUS_MODEL_HTTP_408',
  'ZEUS_MODEL_HTTP_429',
  'ZEUS_MODEL_HTTP_500',
  'ZEUS_MODEL_HTTP_502',
  'ZEUS_MODEL_HTTP_503',
  'ZEUS_MODEL_HTTP_504',
  'ZEUS_MODEL_CATALOG_TIMEOUT',
  'ZEUS_MODEL_CATALOG_CONNECT_TIMEOUT',
  'ZEUS_MODEL_CATALOG_CONNECTION_RESET',
  'ZEUS_MODEL_CATALOG_NETWORK_FAILED',
  'ZEUS_MODEL_TEXT_INCOMPLETE',
]);

/** 首次临时失败等待两秒，再次等待五秒；无需改写、无效输出和明确配置错误不重复请求。 */
export function inputSuggestionRetryDelay(result: Pick<InputSuggestionResult, 'reason' | 'cause'>, retries: number): number | null {
  if (retries >= 2 || (result.reason !== 'timed_out' && result.reason !== 'failed')) return null;
  // 无结构化原因的生成失败也受同一上限约束；不通过报错正文猜测权限或网络状态。
  for (let cause = result.cause; cause; cause = cause.cause) {
    if (cause.code && !transientSuggestionErrors.has(cause.code)) return null;
  }
  return retries === 0 ? 2_000 : 5_000;
}

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
  /** 专用模型、推理深度和速度共同确定配置身份。 */
  const modelKey = JSON.stringify([options.settings?.modelRef ?? null, options.settings?.effort ?? null, options.settings?.serviceTier ?? null]);
  /** 手动结果不随主会话轮次推进失效。 */
  const resultKey = JSON.stringify([sessionKey, modelKey]);
  return { sessionKey, modelKey, resultKey, automaticResultKey: JSON.stringify([resultKey, options.turnId ?? null]) };
}

/** 请求和结果属于会话，输入框只订阅当前会话的快照。 */
interface InputSuggestionSnapshot extends Pick<InputSuggestionResult, 'text' | 'reason' | 'cause'> {
  /** 每次主动或自动生成的稳定身份，重试不创建另一份候选。 */
  requestId: string;
  /** 手动结果绑定会话与模型，自动结果另绑定完成轮次。 */
  key: string;
  /** 专用模型、推理深度和速度共同决定请求配置。 */
  modelKey: string;
  /** 请求时的原文用于预览和失效核对，编辑后不得继续使用。 */
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
}

/** 一个会话最多持有一个正在生成的请求，不依赖组件挂载。 */
class InputSuggestionSession {
  /** 不可变快照满足 React 外部状态订阅要求。 */
  private result: InputSuggestionSnapshot | null = null;
  /** 只有明确取消或失效才终止生成，退订不会触发取消。 */
  private controller: AbortController | null = null;
  /** 已展示预览的请求不因输入框重新挂载而再次弹出。 */
  private presentedRequestId: string | null = null;
  /** 自动完成事件跨页面去重，重开会话不能重复产生用量。 */
  private requestedTurn: string | null = null;
  /** 用户消息事件可能重复送达，只在新的稳定身份出现时清除旧候选。 */
  private observedUserInputs = new Set<string>();
  /** 已挂载输入框报告即时限制，卸载后改用已保存的草稿判断。 */
  private automaticEligibility = new Map<symbol, boolean>();
  /** 每个会话独立通知，后台结果不会刷新其他会话。 */
  private listeners = new Set<() => void>();

  /** 切换页面只移除显示订阅，保留请求和结果。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      pruneInputSuggestionSessions();
    };
  };

  /** 同一结果始终返回同一引用，避免重复渲染。 */
  getSnapshot = (): InputSuggestionSnapshot | null => this.result;

  /** 只有当前手动请求的有效结果可以首次展开预览。 */
  claimPreview = (requestId: string): boolean => {
    if (this.result?.requestId !== requestId || this.result.trigger !== 'manual' || this.result.pending || !this.result.text || this.presentedRequestId === requestId) return false;
    this.presentedRequestId = requestId;
    return true;
  };

  /** 消费完成事件后不再重放，清空草稿或切换页面都不能重置。 */
  consumeAutomaticTurn(key: string): boolean {
    if (this.requestedTurn === key) return false;
    this.requestedTurn = key;
    return true;
  }

  /** 输入法、目标输入或待处理附件立即阻止并取消自动生成，卸载只释放限制。 */
  observeAutomaticEligibility(owner: symbol, eligible: boolean): () => void {
    this.automaticEligibility.set(owner, eligible);
    if (!eligible) this.dismissAutomatic();
    return () => {
      this.automaticEligibility.delete(owner);
    };
  }

  /** 编辑事件立即阻止自动启动并取消旧请求，不等待 React 更新或输入法提交文字。 */
  beginEditing(owner: symbol): void {
    this.automaticEligibility.set(owner, false);
    this.dismiss();
  }

  /** 后台事件不覆盖用户正在处理的输入，也不抢占手动结果。 */
  get automaticAllowed(): boolean {
    return !this.controller && !this.result && [...this.automaticEligibility.values()].every(Boolean);
  }

  /** 主会话继续运行时只清除自动预测，手动润色仍可独立完成。 */
  dismissAutomatic(): void {
    if (this.result?.trigger === 'automatic') this.dismiss();
  }

  /** 已发送要求变化时清除候选，普通助手进度不走此入口。 */
  observeUserInput(identity: string): void {
    if (this.observedUserInputs.has(identity)) return;
    this.observedUserInputs.add(identity);
    if (this.observedUserInputs.size > 64) this.observedUserInputs.delete(this.observedUserInputs.values().next().value!);
    this.dismiss();
  }

  /** 正在使用或生成的会话不能被容量回收中断。 */
  get retained(): boolean {
    return this.controller !== null || this.listeners.size > 0;
  }

  /** 编辑、发送、采用或取消时清理；旧浮层的关闭事件不能取消新请求。 */
  dismiss = (requestId?: string): void => {
    if (requestId !== undefined && this.result?.requestId !== requestId) return;
    this.controller?.abort();
    this.controller = null;
    this.presentedRequestId = null;
    this.publish(null);
  };

  /** 配置变化也清理不可见会话，旧模型的迟到结果不能恢复。 */
  invalidateSettings(modelKey: string, automaticEnabled: boolean): void {
    if (this.result && (this.result.modelKey !== modelKey || (this.result.trigger === 'automatic' && !automaticEnabled))) this.dismiss();
  }

  /** 生成由会话状态层持有，卸载输入框后继续接收完成或失败。 */
  start(options: {
    /** 含自动轮次约束的结果身份。 */
    key: string;
    /** 捕获本次所选模型配置。 */
    modelKey: string;
    /** 原文快照用于说明候选依据，继续输入必须取消本次生成。 */
    sourceDraft: string;
    /** 服务端回执必须匹配实际请求模型。 */
    modelRef: string;
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
      requestId: diagnosticId,
      key: options.key,
      modelKey: options.modelKey,
      sourceDraft: options.sourceDraft,
      mode: options.request.mode,
      trigger: options.request.trigger,
      pending: true,
      text: null,
      reason: null,
      retryAttempt: 0,
      retryAt: null,
    };
    this.publish(snapshot);
    void (async () => {
      try {
        for (let retryAttempt = 0; !controller.signal.aborted; retryAttempt += 1) {
          if (retryAttempt > 0) {
            diagnosticId = crypto.randomUUID();
            startedAt = performance.now();
            this.publish({ ...snapshot, retryAttempt });
          }
          record('ui_started');
          /** 响应失败和传输失败都进入同一条有界恢复通路。 */
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
          if (response.modelRef !== options.modelRef || (options.request.trigger === 'automatic' && response.completedTurnId !== options.request.completedTurnId)) {
            record('ui_discarded', 'identity_changed');
            this.publish(null);
            return;
          }
          /** 有效候选不重复生成，剩余失败按明确原因决定是否等待。 */
          const retryDelay = response.text ? null : inputSuggestionRetryDelay(response, retryAttempt);
          if (retryDelay === null) {
            this.publish({ ...snapshot, text: response.text, reason: response.reason, cause: response.cause, pending: false, retryAttempt });
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

/** 当前窗口缓存最近使用的会话，不将未采纳正文写入持久化存储。 */
const sessions = new Map<string, InputSuggestionSession>();
/** 限制已结束且无人查看的缓存数量，活动请求永不因容量被取消。 */
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

/** 专用模型或自动开关变化时，同步所有已经发起过建议的会话。 */
export function synchronizeInputSuggestionSettings(modelKey: string, automaticEnabled: boolean): void {
  for (const session of sessions.values()) session.invalidateSettings(modelKey, automaticEnabled);
}
