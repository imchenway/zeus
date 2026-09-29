import type { CodexAppServerManager, CodexAppServerEvent, CodexModelCapability } from '@zeus/ai-runtime';

/** 单次真实 Codex 请求的最长等待时间。 */
const codexInferenceTimeoutMs = 25_000;
/** 清理临时线程不能继续延长用户可见诊断。 */
const codexDiagnosticCleanupTimeoutMs = 1_000;

/** 真实请求探针只需要线程、轮次、事件和清理能力。 */
type CodexConnectionDiagnosticManager = Pick<CodexAppServerManager, 'startThread' | 'startTurn' | 'interruptTurn' | 'archiveThread' | 'subscribe'>;

/** 真实请求成功后只返回本次总耗时。 */
export interface CodexConversationProbeResult {
  /** 从创建临时线程到收到轮次完成事件的毫秒数。 */
  latencyMs: number;
}

/** 不信任 Provider 事件结构，只读取对象字段。 */
function eventRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Provider 既可能把轮次身份放在顶层，也可能放在 turn 对象内。 */
function eventTurnId(params: Record<string, unknown>): string | null {
  /** 嵌套轮次用于完成事件，顶层身份用于失败事件。 */
  const turn = eventRecord(params.turn);
  return typeof params.turnId === 'string' ? params.turnId : typeof turn.id === 'string' ? turn.id : null;
}

/** 统一构造带稳定错误码的诊断错误。 */
function diagnosticError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** 临时线程中断和归档都采用短截止，迟到清理不阻塞诊断回执。 */
async function finishCleanup(operation: Promise<unknown>): Promise<void> {
  /** 清理超时只结束本地等待，宿主仍可在后台完成 RPC。 */
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, codexDiagnosticCleanupTimeoutMs);
      }),
    ]).catch(() => undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 在隔离的临时线程内发送一次最小文本请求。
 * 只有收到目标轮次 completed 事件才成功，目录读取或 turn/start 接纳都不算对话可用。
 */
export async function probeCodexConversation(input: { manager: CodexConnectionDiagnosticManager; model: CodexModelCapability; cwd: string }): Promise<CodexConversationProbeResult> {
  /** 用户可见耗时从临时线程创建前开始计算。 */
  const startedAt = performance.now();
  /** 临时线程身份用于过滤共享 Provider 事件。 */
  let threadId = '';
  /** 轮次身份用于拒绝同线程内无关的迟到事件。 */
  let turnId = '';
  /** 完成后不再尝试中断轮次。 */
  let completed = false;
  /** 订阅函数在创建线程失败时保持空操作。 */
  let unsubscribe = (): void => undefined;
  /** 超时句柄只覆盖本次真实请求。 */
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const thread = await input.manager.startThread({
      model: input.model.model,
      cwd: input.cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: { type: 'readOnly', networkAccess: false },
      baseInstructions: '你是 Zeus 的网络连接检查。不要调用工具，只回答 ok。',
      developerInstructions: '只输出 ok，不解释，不访问文件，不执行命令。',
    });
    threadId = thread.id;
    /** 先订阅再启动轮次，避免极快完成事件早于 startTurn 回执。 */
    const completion = new Promise<void>((resolve, reject) => {
      unsubscribe = input.manager.subscribe((event: CodexAppServerEvent) => {
        const params = eventRecord(event.params);
        if (params.threadId !== threadId) return;
        const currentTurnId = eventTurnId(params);
        if (turnId && currentTurnId && currentTurnId !== turnId) return;
        if (event.method === 'error' && params.willRetry !== true) {
          reject(diagnosticError('ZEUS_CODEX_INFERENCE_FAILED', 'Codex 模型请求失败，请检查网络、登录状态或额度。'));
          return;
        }
        if (event.method === 'turn/failed' || event.method === 'turn/cancelled') {
          reject(diagnosticError('ZEUS_CODEX_INFERENCE_FAILED', 'Codex 模型请求未能完成。'));
          return;
        }
        if (event.method !== 'turn/completed') return;
        const turn = eventRecord(params.turn);
        if (turn.status !== 'completed') {
          reject(diagnosticError('ZEUS_CODEX_INFERENCE_FAILED', 'Codex 模型请求返回了未完成状态。'));
          return;
        }
        completed = true;
        resolve();
      });
      timeout = setTimeout(() => reject(diagnosticError('ZEUS_CODEX_INFERENCE_TIMEOUT', 'Codex 真实模型请求在 25 秒内没有完成。')), codexInferenceTimeoutMs);
    });
    /** 选择目录中最低可用思考档，减少连接检查用量与等待。 */
    const effort = ['none', 'minimal', 'low'].find((candidate) => input.model.supportedReasoningEfforts.includes(candidate));
    /** 启动回执与完成事件同时等待，极快失败也立即附着 rejection handler。 */
    const starting = input.manager
      .startTurn({
        threadId,
        model: input.model.model,
        input: [{ type: 'text', text: '只回答：ok', text_elements: [] }],
        ...(effort ? { effort } : {}),
        summary: 'none',
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      })
      .then((turn) => {
        turnId = turn.id;
      });
    await Promise.all([starting, completion]);
    return { latencyMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  } finally {
    if (timeout) clearTimeout(timeout);
    unsubscribe();
    if (threadId && turnId && !completed) await finishCleanup(input.manager.interruptTurn({ threadId, turnId }));
    if (threadId) await finishCleanup(input.manager.archiveThread({ threadId }));
  }
}
