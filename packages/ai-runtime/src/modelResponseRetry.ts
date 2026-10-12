/** Zeus 统一管理模型响应恢复预算，首次请求之后最多再试五次。 */
export const modelResponseRetryPolicy = {
  /** 首次请求之外允许的自动恢复次数。 */
  maxRetries: 5,
  /** 单次建立模型连接的上限，收到响应头后不再限制生成耗时。 */
  connectionTimeoutMs: 60_000,
  /** 指数退避从一秒开始。 */
  baseDelayMs: 1_000,
} as const;

/** 永久拒绝优先于网络关键词，避免额度、认证和配置错误空转。 */
export function isRetryableModelResponseFailure(error: unknown): boolean {
  /** 保留 Codex 嵌套供应商错误；其他供应商沿用 Pi 的错误分类。 */
  const text = error instanceof Error ? `${error.name} ${error.message}` : (JSON.stringify(error) ?? '');
  if (/unauthorized|forbidden|invalid.api.key|authentication|insufficient.quota|quota.exceeded|billing|credit.balance|context.window|context.length|configuration|reserved.*provider|permission.denied|余额|额度|认证|配置/iu.test(text))
    return false;
  return /timeout|timed.out|terminated|connection|disconnected|socket|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|fetch failed|failed to fetch|stream.*(closed|failed|interrupt)|rate.limit|too.many.requests|overloaded|temporar|server.error|service.unavailable|\b(408|429|500|502|503|504)\b|网络|连接|超时/iu.test(
    text,
  );
}

/** 两个适配器共用指数退避；次数在调用前必须属于本轮剩余预算。 */
export function modelResponseRetryDelay(attempt: number): number {
  return modelResponseRetryPolicy.baseDelayMs * 2 ** Math.max(0, Math.min(attempt, modelResponseRetryPolicy.maxRetries) - 1);
}

/** 仅供模型建链使用；收到响应头或流开始事件时必须释放计时器。 */
export function createModelConnectionDeadline(onTimeout: () => void): () => void {
  /** 已建立连接后不能继续计时，正常思考、输出和工具执行不消耗建链时间。 */
  const timer = setTimeout(onTimeout, modelResponseRetryPolicy.connectionTimeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}
