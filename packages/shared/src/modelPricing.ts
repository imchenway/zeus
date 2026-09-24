import type { CodexUsageEstimate, CodexUsageRateSnapshot, TokenUsageBreakdown } from './codexUsage.js';
import { estimateCodexUsageWithRateSnapshot } from './codexUsage.js';

/** 金额保留原始币种，不把人民币写入美元字段。 */
export interface EstimatedMoney {
  /** 三位币种代码。 */
  currency: string;
  /** 未舍入的估算金额，显示时才格式化。 */
  amount: number;
}

/** 页面确认的单价；空值表示未公布，不能当作免费。 */
export interface ModelPrice {
  /** 当前单价适用的请求输入量；上限外不沿用便宜档位。 */
  inputRange?: { minExclusive: number; maxInclusive: number };
  /** 排除的 UTC 时段；例如未确定法定节假日的工作日高峰。 */
  excludedUtcWindows?: Array<{ weekdays: number[]; startMinute: number; endMinute: number }>;
  /** 供应商精确模型标识，不做名称相似匹配。 */
  model: string;
  /** 价格的币种。 */
  currency: string;
  /** 每百万 Token 单价；按次项目为空。 */
  perMillion: { input: number; output: number; cachedInput: number | null; cacheWrite: number | null } | null;
  /** 每次请求单价；Token 项目为空。 */
  perRequest: number | null;
  /** 公开价、分组或其他已确认适用范围。 */
  basis: string;
  /** 原始页面依据，不含密钥。 */
  evidence: string;
}

/** 连接价格的只读状态，解析失败也保留已验证清单。 */
export interface ModelPricingCatalog {
  /** 用户提供或内置的价格页面。 */
  url: string;
  /** 成功读取的时间，不冒充价格生效日期。 */
  retrievedAt: string | null;
  /** 最近尝试读取的时间。 */
  checkedAt: string;
  /** 原文摘要用于避免无变化时重复调用模型。 */
  documentHash: string;
  /** 校验通过的动态模型价格。 */
  prices: ModelPrice[];
  /** 被识别但缺少计价依据的模型。 */
  unavailableModels: string[];
  /** 失败或部分识别说明。 */
  error: string | null;
}

/** 每次真实请求保存独立费率和用量，重放不新增收费。 */
export interface UsageRequestPriceSnapshot {
  /** 同一轮内稳定的真实请求身份。 */
  id: string;
  /** 请求记录的时间。 */
  occurredAt: string;
  /** 供应商报告的用量。 */
  usage: TokenUsageBreakdown;
  /** 当次计算结果与费率，不引用可变的最新价格。 */
  estimate: Omit<CodexUsageEstimate, 'requests'>;
}

/** 统一空费率，缺价保留真实模型与用量。 */
export function unavailableRateSnapshot(model: string): CodexUsageRateSnapshot {
  return { catalogDate: 'unavailable', model, normalizedModel: null, serviceTier: null, longContext: false, creditsPerMillion: null, usdPerMillion: null, sourceUrls: [] };
}

/** 根据一条已校验的公开价格计算，缺少正在使用的缓存费率时保留未知。 */
export function estimateModelPrice(model: string, usage: TokenUsageBreakdown, catalog: ModelPricingCatalog | null, occurredAt = new Date().toISOString()): CodexUsageEstimate {
  /** 精确身份在连接内部匹配，其他供应商同名模型不能借价。 */
  const instant = new Date(occurredAt);
  /** 所有适用条件均由程序判断，多个冲突费率同时命中时拒绝猜测。 */
  const matches =
    catalog?.prices.filter(
      (entry) =>
        entry.model === model &&
        (!entry.inputRange || (usage.inputTokens > entry.inputRange.minExclusive && usage.inputTokens <= entry.inputRange.maxInclusive)) &&
        !entry.excludedUtcWindows?.some(
          (window) => window.weekdays.includes(instant.getUTCDay()) && instant.getUTCHours() * 60 + instant.getUTCMinutes() >= window.startMinute && instant.getUTCHours() * 60 + instant.getUTCMinutes() < window.endMinute,
        ),
    ) ?? [];
  const price = matches.length === 1 ? matches[0] : undefined;
  /** 使用通用空费率建立账本形状，不套用任何模型默认价格。 */
  const snapshot = unavailableRateSnapshot(model);
  if (!price || !catalog?.retrievedAt) return estimateCodexUsageWithRateSnapshot(usage, snapshot);
  snapshot.retrievedAt = catalog.retrievedAt;
  snapshot.catalogDate = catalog.retrievedAt.slice(0, 10);
  snapshot.normalizedModel = model;
  snapshot.sourceUrls = [catalog.url];
  snapshot.price = price;
  return estimateModelUsageWithSnapshot(usage, snapshot);
}

/** 固化费率的确定性计算；页面与模型只提供数据，不执行生成的公式。 */
export function estimateModelUsageWithSnapshot(usage: TokenUsageBreakdown, snapshot: CodexUsageRateSnapshot): CodexUsageEstimate {
  /** 兼容历史美元记录，原计算口径保持可复算。 */
  const result = estimateCodexUsageWithRateSnapshot(usage, snapshot);
  /** 自定义单价独立保存，未提供时继续使用历史字段。 */
  const price = snapshot.price;
  if (!price) return result;
  /** 供应商返回互相冲突的用量时保留缺价，不能靠截零低估费用。 */
  if (Object.values(usage).some((value) => !Number.isFinite(value) || value < 0) || usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) return result;
  /** 缓存类别从输入总量扣除后分别计费。 */
  const input = Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens);
  /** 单价缺失且实际使用了该类别时不输出完整费用。 */
  const rates = price.perMillion;
  /** 按次计价不依赖 Token 数量。 */
  const amount =
    price.perRequest ??
    (rates && (usage.cachedInputTokens === 0 || rates.cachedInput !== null) && (usage.cacheWriteInputTokens === 0 || rates.cacheWrite !== null)
      ? (input * rates.input + usage.outputTokens * rates.output + usage.cachedInputTokens * (rates.cachedInput ?? 0) + usage.cacheWriteInputTokens * (rates.cacheWrite ?? 0)) / 1_000_000
      : null);
  if (amount === null || !Number.isFinite(amount)) return result;
  return { ...result, costs: [{ currency: price.currency, amount }], apiEquivalentUsd: price.currency === 'USD' ? amount : null, pricedTokens: result.billableTokens, coverage: result.billableTokens > 0 ? 1 : null };
}

/** 按币种分别汇总；历史美元记录只补入一次。 */
export function sumEstimatedCosts(estimates: readonly Pick<CodexUsageEstimate, 'costs' | 'apiEquivalentUsd'>[]): EstimatedMoney[] {
  /** 币种不能跨桶相加。 */
  const totals = new Map<string, number>();
  for (const estimate of estimates) {
    for (const cost of estimate.costs ?? (estimate.apiEquivalentUsd === null ? [] : [{ currency: 'USD', amount: estimate.apiEquivalentUsd }])) totals.set(cost.currency, (totals.get(cost.currency) ?? 0) + cost.amount);
  }
  return [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amount]) => ({ currency, amount }));
}

/** 汇总请求快照；账本仍然每轮一条，不重复累加重放事件。 */
export function aggregateRequestPrices(requests: UsageRequestPriceSnapshot[]): CodexUsageEstimate {
  /** 每个请求独立计价，绝不以最后一次单价重算整轮。 */
  const estimates = requests.map((request) => request.estimate);
  /** 只汇总已知金额，覆盖率揭示未计价部分。 */
  const sum = (key: 'credits' | 'apiEquivalentUsd' | 'cacheSavingsUsd'): number | null => {
    const values = estimates.flatMap((estimate) => (estimate[key] === null ? [] : [estimate[key]!]));
    return values.length ? values.reduce((a, b) => a + b, 0) : null;
  };
  /** 汇总覆盖率采用可计费 Token，而非条目数。 */
  const billableTokens = estimates.reduce((total, estimate) => total + estimate.billableTokens, 0);
  /** 分子来自各请求自己的费率覆盖范围。 */
  const pricedTokens = estimates.reduce((total, estimate) => total + estimate.pricedTokens, 0);
  return {
    requests,
    costs: sumEstimatedCosts(estimates),
    credits: sum('credits'),
    apiEquivalentUsd: sum('apiEquivalentUsd'),
    cacheSavingsUsd: sum('cacheSavingsUsd'),
    billableTokens,
    pricedTokens,
    coverage: billableTokens ? pricedTokens / billableTokens : null,
    rateSnapshot: { ...(estimates.at(-1)?.rateSnapshot ?? unavailableRateSnapshot('')), sourceUrls: [...new Set(estimates.flatMap((estimate) => estimate.rateSnapshot.sourceUrls))] },
  };
}

/** 费用展示保持币种可见，小额不四舍五入成零。 */
export function formatEstimatedCosts(costs: EstimatedMoney[] | undefined, usd: number | null): string {
  const values = costs ?? (usd === null ? [] : [{ currency: 'USD', amount: usd }]);
  return values.length ? values.map(({ currency, amount }) => `${currency} ${amount > 0 && amount < 0.0001 ? '<0.0001' : amount.toLocaleString('en-US', { maximumFractionDigits: 4 })}`).join(' + ') : '暂无价格';
}
