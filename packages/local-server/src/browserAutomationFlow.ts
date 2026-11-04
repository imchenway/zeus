import type { BrowserAutomationContentItem, BrowserAutomationPort, BrowserAutomationToolCall, BrowserAutomationToolResult } from './browserAutomation.js';

/** 单次自动化调用的最长存活时间，单位为毫秒；重连与排队共用同一预算。 */
const maximumCallDurationMs = 120_000;
/** 同一会话、同一浏览器最多保留的待执行调用数。 */
const maximumQueuedCalls = 32;
/** 可合并操作只包含一个已有基础动作，不允许任意脚本或批量提交。 */
const actionTools = ['click', 'type', 'press', 'scroll'] as const;

/** 以可信调度端的截止时间为上限，缺省调用也有有限的生命周期。 */
export function browserAutomationDeadline(deadlineUnixMs?: number): number {
  if (deadlineUnixMs !== undefined && (!Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= 0)) {
    throw Object.assign(new Error('浏览器调用截止时间无效。'), { code: 'ZEUS_BROWSER_DEADLINE_INVALID' });
  }
  return Math.min(deadlineUnixMs ?? Infinity, Date.now() + maximumCallDurationMs);
}

/** 返回剩余毫秒数；过期调用必须在开始下一步之前停止。 */
export function remainingBrowserAutomationTime(deadlineUnixMs: number): number {
  /** 剩余时间同时约束排队、重连、网络传输和动作后的观察。 */
  const remainingMs = deadlineUnixMs - Date.now();
  if (remainingMs <= 0) throw Object.assign(new Error('浏览器调用已过期，未开始的步骤已停止；已执行的动作不会自动重放。'), { code: 'ZEUS_BROWSER_CALL_EXPIRED' });
  return remainingMs;
}

/** 在宿主入口串行处理同一会话的页面操作；不同会话仍可并行，具体浏览器实现由端口注入。 */
export function createBrowserAutomationFlow(invoke: BrowserAutomationPort['invoke']): BrowserAutomationPort['invoke'] {
  /** 队尾等待真实宿主操作结束，不能因外层超时就允许后续动作与其交错。 */
  const tails = new Map<string, Promise<void>>();
  /** 有界排队避免离线宿主积压无限数量的模型请求。 */
  const counts = new Map<string, number>();
  return async (input) => {
    /** 两端共用浏览器选择；无效目标不能静默降级到内置浏览器。 */
    const surface = input.arguments.surface ?? 'built_in';
    if (typeof surface !== 'string' || !['built_in', 'chrome', 'edge'].includes(surface)) throw new TypeError('浏览器 surface 必须为 built_in、chrome 或 edge。');
    /** 截止时间在进入队列前固定，排队不会重新获得完整预算。 */
    const deadlineUnixMs = browserAutomationDeadline(input.deadlineUnixMs);
    remainingBrowserAutomationTime(deadlineUnixMs);
    /** 对话框处置可能是完成当前动作的前提，不能排在该动作之后；身份和路径仍由宿主校验。 */
    const resolvesDialog = input.tool === 'invoke' && typeof input.arguments.path === 'string' && /^(?:Alert|BeforeUnload|Confirm|Prompt)Dialog\.(?:accept|dismiss)$/u.test(input.arguments.path);
    /** 元数据查询不触碰页面，可在页面动作期间读取。 */
    if (input.tool === 'catalog' || resolvesDialog) return invoke({ ...input, deadlineUnixMs });
    /** JSON 元组防止用户身份中的分隔符引起队列碰撞。 */
    const key = JSON.stringify([input.conversationId, surface]);
    /** 计数包含当前执行项和等待项。 */
    const count = counts.get(key) ?? 0;
    if (count >= maximumQueuedCalls) throw Object.assign(new Error('当前会话的浏览器调用队列已满，请等待已有调用结束。'), { code: 'ZEUS_BROWSER_QUEUE_FULL' });
    counts.set(key, count + 1);
    /** 失败调用不会破坏队列；每次执行前重新检查预算。 */
    const operation = (tails.get(key) ?? Promise.resolve()).then(() => {
      remainingBrowserAutomationTime(deadlineUnixMs);
      /** 宿主不得把模型参数中的时间当作新的授权期限。 */
      const boundedInput = { ...input, deadlineUnixMs };
      return input.tool === 'act' ? invokeBrowserAction(invoke, boundedInput) : invoke(boundedInput);
    });
    /** 队尾只负责释放资源，不吞掉返回给调用者的错误。 */
    const tail = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        /** 等待项有独立生命周期，不提前解除仍在运行的宿主动作。 */
        const remainingCount = (counts.get(key) ?? 1) - 1;
        if (remainingCount === 0) counts.delete(key);
        else counts.set(key, remainingCount);
        if (tails.get(key) === tail) tails.delete(key);
      });
    tails.set(key, tail);
    return operation;
  };
}

/** 在一个固定标签内执行一次动作，再观察结果；任一步失败都不会重新执行动作。 */
async function invokeBrowserAction(invoke: BrowserAutomationPort['invoke'], input: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult> {
  /** 复合动作在任何副作用之前完整校验参数。 */
  const args = input.arguments;
  /** 稳定标签身份避免动作后因活动标签变化而观察了另一页面。 */
  const tabId = requireActionString(args.tabId, 'tabId');
  /** 仅允许一个基础动作，后续动作应依据本次观察结果决定。 */
  const action = requireActionString(args.action, 'action');
  /** 所有子步骤共享原始调用身份、浏览器目标和截止时间。 */
  const common = { tabId, surface: args.surface ?? 'built_in' };
  if (!(actionTools as readonly string[]).includes(action)) throw new TypeError('action 必须为 click、type、press 或 scroll。');
  /** 只向基础动作传递其已定义的参数，不保存输入到额外缓存。 */
  const actionArguments: Record<string, unknown> = { ...common };
  if (action === 'click' || action === 'type') actionArguments.target = requireActionString(args.target, 'target');
  if (action === 'press') actionArguments.key = requireActionString(args.key, 'key');
  if (action === 'type') {
    if (typeof args.text !== 'string' || args.text.length > 100_000) throw new TypeError('text 必须为不超过 100000 个字符的字符串。');
    if (args.replace !== undefined && typeof args.replace !== 'boolean') throw new TypeError('replace 必须为布尔值。');
    actionArguments.text = args.text;
    actionArguments.replace = args.replace !== false;
  }
  if (action === 'scroll') {
    if (args.target !== undefined) actionArguments.target = requireActionString(args.target, 'target');
    for (const axis of ['x', 'y']) {
      if (args[axis] !== undefined) {
        if (typeof args[axis] !== 'number' || !Number.isFinite(args[axis])) throw new TypeError(`${axis} 必须为有限数值。`);
        actionArguments[axis] = args[axis];
      }
    }
  }
  /** 观察开关只影响返回信息，不改变动作授权。 */
  const observe = args.observe ?? true;
  if (typeof observe !== 'boolean') throw new TypeError('observe 必须为布尔值。');
  /** 返回元素数量采用较小默认值，完整页面可按需再取。 */
  const maxElements = args.maxElements ?? 80;
  if (typeof maxElements !== 'number' || !Number.isInteger(maxElements) || maxElements < 1 || maxElements > 400) throw new TypeError('maxElements 必须为 1 至 400 的整数。');
  /** 条件等待是业务结果观察，缺省不插入固定睡眠。 */
  const waitFor = validateActionWait(args.waitFor);
  /** 顶层调用边界已固定预算。 */
  const deadlineUnixMs = input.deadlineUnixMs!;
  /** 返回内容按动作、条件、观察分段，动作成功不代表业务已经完成。 */
  const contentItems: BrowserAutomationContentItem[] = [];
  /** 发给宿主后发生的异常只能作为未知结果处理。 */
  let dispatched = false;
  try {
    remainingBrowserAutomationTime(deadlineUnixMs);
    dispatched = true;
    /** 原有宿主继续执行页面权限、标签归属、文件输入等检查。 */
    const result = await invoke({ ...input, tool: action, arguments: actionArguments });
    if (!result.success) return actionFailure(tabId, 'unconfirmed', result.contentItems);
  } catch (error) {
    return actionFailure(tabId, dispatched ? 'unknown' : 'not_started', [{ type: 'inputText', text: error instanceof Error ? error.message : String(error) }]);
  }
  contentItems.push({ type: 'inputText', text: JSON.stringify({ tabId, action, actionStatus: 'completed', businessOutcome: 'unverified' }) });
  /** 条件或观察失败不得把已完成动作改写为未执行。 */
  let observed = true;
  if (waitFor) {
    try {
      /** 条件自身上限不能超过调用剩余时间。 */
      const timeoutMs = Math.min(waitFor.timeoutMs, remainingBrowserAutomationTime(deadlineUnixMs));
      /** 等待固定标签上的页面状态。 */
      const result = await invoke({ ...input, tool: 'wait', arguments: { ...common, ...waitFor, timeoutMs } });
      observed = result.success;
      contentItems.push({ type: 'inputText', text: JSON.stringify({ conditionStatus: result.success ? 'matched' : 'not_matched' }) }, ...result.contentItems);
    } catch (error) {
      observed = false;
      contentItems.push({ type: 'inputText', text: JSON.stringify({ conditionStatus: 'unknown', message: error instanceof Error ? error.message : String(error) }) });
    }
  }
  if (observe) {
    try {
      remainingBrowserAutomationTime(deadlineUnixMs);
      /** 快照直接返回最新引用，不额外请求截图或整页多次快照。 */
      const result = await invoke({ ...input, tool: 'snapshot', arguments: { ...common, maxElements } });
      observed = observed && result.success;
      contentItems.push({ type: 'inputText', text: JSON.stringify({ observationStatus: result.success ? 'captured' : 'failed', pageContentTrust: 'untrusted' }) }, ...result.contentItems);
    } catch (error) {
      observed = false;
      contentItems.push({ type: 'inputText', text: JSON.stringify({ observationStatus: 'unknown', message: error instanceof Error ? error.message : String(error), nextStep: 'Inspect this tab; do not replay the completed action.' }) });
    }
  }
  return { success: observed, contentItems };
}

/** 校验可选的操作后条件，拒绝在动作后才发现无效条件。 */
function validateActionWait(value: unknown): { selector: string; state: string; text?: string; timeoutMs: number } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !['selector', 'state', 'text', 'timeoutMs'].includes(key))) throw new TypeError('waitFor 条件无效。');
  /** 必须有真实页面条件，复合动作不接受无条件睡眠。 */
  const selector = requireActionString(value.selector, 'waitFor.selector');
  /** 可见状态是默认的观察条件。 */
  const state = value.state ?? 'visible';
  if (typeof state !== 'string' || !['attached', 'visible', 'hidden', 'detached', 'enabled'].includes(state)) throw new TypeError('waitFor.state 无效。');
  if (value.text !== undefined && (typeof value.text !== 'string' || value.text.length > 20_000 || ['hidden', 'detached'].includes(state))) throw new TypeError('waitFor.text 只能用于存在、可见或可用状态，且不超过 20000 个字符。');
  /** 条件等待上限为毫秒，与基础 wait 工具一致。 */
  const timeoutMs = value.timeoutMs ?? 5_000;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) throw new TypeError('waitFor.timeoutMs 必须为 0 至 30000 的整数毫秒。');
  return { selector, state, timeoutMs, ...(typeof value.text === 'string' ? { text: value.text } : {}) };
}

/** 保留未完成及未知结果，避免连接失败后模型重填或重复提交。 */
function actionFailure(tabId: string, actionStatus: string, details: BrowserAutomationContentItem[]): BrowserAutomationToolResult {
  return {
    success: false,
    contentItems: [
      {
        type: 'inputText',
        text: JSON.stringify({ tabId, actionStatus, nextStep: 'Inspect this tab before deciding what remains; do not replay the action automatically.' }),
      },
      ...details,
    ],
  };
}

/** 动作目标和标签身份不接受空白字符串。 */
function requireActionString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须为非空字符串。`);
  return value;
}

/** 将外来 JSON 对象与数组、空值区分。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
