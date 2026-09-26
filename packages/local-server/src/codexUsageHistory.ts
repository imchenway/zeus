import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { codexUsageObservationIdentity, type TokenUsageBreakdown } from '@zeus/shared';

/** 从原生会话恢复的请求事实；服务档位缺失时必须另有同轮配置证据。 */
export interface CodexHistoricalUsageRequest {
  /** 原生轮次身份，不按时间归属。 */
  providerTurnId: string;
  /** 累计用量观察身份，与实时通知完全一致。 */
  observationId: string;
  /** 原生轮次记录的模型。 */
  model: string;
  /** 原始事件明确报告的档位，缺省表示未知。 */
  serviceTier?: string | null;
  /** 该请求的用量。 */
  usage: TokenUsageBreakdown;
  /** 该请求完成后的原生累计量，用于核对账本边界。 */
  total: TokenUsageBreakdown;
  /** 原生事件发生时间，补算不能将其改成当前时间。 */
  occurredAt: string;
}

/** 只读取已经绑定的原生文件；身份、轮次或用量损坏时不猜测费用。 */
export async function readCodexUsageHistory(path: string | null, threadId: string): Promise<CodexHistoricalUsageRequest[]> {
  if (!path || !isAbsolute(path) || extname(path) !== '.jsonl') return [];
  try {
    /** 不跟随替换的文件链接，也不从目录、设备或管道恢复账本。 */
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  /** 逐行读取避免把包含会话正文的大文件整体载入内存。 */
  const stream = createReadStream(path, { encoding: 'utf8' });
  /** 提前拒绝错误线程时也关闭底层文件，避免重复补价留下读取句柄。 */
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  /** 同一累计通知可能重复落盘，仅保留首次证据。 */
  const requests = new Map<string, CodexHistoricalUsageRequest>();
  /** 必须先核对首条线程元数据，再接纳任何请求。 */
  let verified = false;
  /** 轮次配置只在明确的 turn_context 边界切换。 */
  let context: Record<string, unknown> | null = null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      /** 活动文件的末尾半行不作为请求证据。 */
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        if (!verified) return [];
        // 损坏行可能是轮次边界，下一条明确配置前不能沿用上一轮身份。
        context = null;
        continue;
      }
      if (!record(entry) || !record(entry.payload)) continue;
      /** 只读取价格有关的元数据，其他正文不进入补算结果。 */
      const payload = entry.payload;
      if (!verified) {
        if (entry.type !== 'session_meta' || payload.id !== threadId) return [];
        verified = true;
        continue;
      }
      if (entry.type === 'session_meta' && payload.id !== threadId) return [];
      if (entry.type === 'turn_context') {
        context = payload;
        continue;
      }
      if (entry.type !== 'event_msg' || payload.type !== 'token_count' || !record(payload.info) || !context) continue;
      /** 缺少稳定轮次或模型时，不能从相邻记录继承猜测。 */
      const turnId = context.turn_id;
      /** 模型须来自原生轮次配置或本条用量事件。 */
      const model = typeof payload.info.model === 'string' ? payload.info.model : context.model;
      if (typeof turnId !== 'string' || !turnId || typeof model !== 'string' || !model) continue;
      /** 累计量与单请求量都必须完整、非负且为安全整数。 */
      const total = breakdown(payload.info.total_token_usage);
      /** 只把明确的 last 请求记入费用，绝不使用整轮累计量替代。 */
      const usage = breakdown(payload.info.last_token_usage);
      if (!total || !usage || usage.totalTokens === 0 || Object.keys(usage).some((key) => usage![key as keyof TokenUsageBreakdown] > total![key as keyof TokenUsageBreakdown])) continue;
      if (typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) continue;
      /** 原始事件优先于轮次配置，未提供档位时保留缺省状态。 */
      const tierSource = Object.prototype.hasOwnProperty.call(payload.info, 'service_tier') ? payload.info : context;
      /** 属性是否存在区分明确的普通档位 null 和历史资料缺失。 */
      const hasTier = Object.prototype.hasOwnProperty.call(tierSource, 'service_tier');
      /** 未知类型不能降级为普通档位。 */
      const tier = tierSource.service_tier;
      if (hasTier && tier !== null && typeof tier !== 'string') continue;
      /** 实时和历史使用相同累计身份，恢复执行可安全重放。 */
      const observationId = codexUsageObservationIdentity(threadId, turnId, total);
      if (!requests.has(observationId)) requests.set(observationId, { providerTurnId: turnId, observationId, model, ...(hasTier ? { serviceTier: tier as string | null } : {}), usage, total, occurredAt: entry.timestamp });
    }
  } catch {
    return [];
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...requests.values()];
}

/** JSON 边界拒绝数组与空值。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 原生用量保持缓存、输出和推理分类；缺失必需字段不补零。 */
function breakdown(value: unknown): TokenUsageBreakdown | null {
  if (!record(value)) return null;
  /** 原生协议字段显式映射到产品内部用量。 */
  const usage = {
    inputTokens: value.input_tokens,
    cachedInputTokens: value.cached_input_tokens ?? 0,
    cacheWriteInputTokens: value.cache_write_input_tokens ?? 0,
    outputTokens: value.output_tokens,
    reasoningOutputTokens: value.reasoning_output_tokens ?? 0,
    totalTokens: value.total_tokens,
  };
  return Object.values(usage).every((number) => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0) ? (usage as TokenUsageBreakdown) : null;
}
