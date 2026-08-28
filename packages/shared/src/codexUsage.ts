export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexUsageRateSnapshot {
  catalogDate: string;
  model: string;
  normalizedModel: string | null;
  serviceTier: string | null;
  longContext: boolean;
  creditsPerMillion: { input: number; cachedInput: number; cacheWrite: number | null; output: number } | null;
  usdPerMillion: { input: number; cachedInput: number; cacheWrite: number | null; output: number } | null;
  sourceUrls: string[];
}

export interface CodexUsageEstimate {
  credits: number | null;
  apiEquivalentUsd: number | null;
  cacheSavingsUsd: number | null;
  pricedTokens: number;
  billableTokens: number;
  coverage: number | null;
  rateSnapshot: CodexUsageRateSnapshot;
}

export interface NativeTokenUsageSnapshot {
  generationId: string;
  sequence: number;
  serviceTier?: string | null;
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
  cacheHitRate: number | null;
  estimatedCredits: number | null;
  apiEquivalentUsd: number | null;
  lastApiEquivalentUsd: number | null;
  cacheSavingsUsd: number | null;
  priceCoverage: number | null;
  pricingCatalogDate: string | null;
  pricingSourceUrls: string[];
  historyComplete: boolean;
}

export interface CodexOfficialRateWindow {
  limitId: string | null;
  limitName: string | null;
  kind: 'primary' | 'secondary';
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexOfficialUsageSnapshot {
  state: 'available' | 'signed_out' | 'unsupported' | 'unavailable';
  accountScopeId: string | null;
  accountType: string | null;
  planType: string | null;
  lifetimeTokens: number | null;
  peakDailyTokens: number | null;
  longestRunningTurnSec: number | null;
  currentStreakDays: number | null;
  longestStreakDays: number | null;
  dailyUsageBuckets: Array<{ startDate: string; tokens: number }> | null;
  rateLimitWindows: CodexOfficialRateWindow[];
  creditBalance: string | null;
  creditsUnlimited: boolean;
  fetchedAt: string | null;
  stale: boolean;
  error: string | null;
}

export type UsageProviderKind = 'subscription' | 'api';

export interface UsageProviderSummary {
  providerId: string;
  sourceId: string;
  name: string;
  kind: UsageProviderKind;
  deleted: boolean;
  cacheUsageAvailable: boolean;
  planType: string | null;
  officialState: CodexOfficialUsageSnapshot['state'] | null;
  rateLimitWindows: CodexOfficialRateWindow[];
  officialCreditBalance: string | null;
  officialCreditsUnlimited: boolean;
  accountTodayTokens: number | null;
  accountSevenDayTokens: number | null;
  dailyAccount: Array<{ date: string; totalTokens: number }> | null;
  todayLocal: CodexLocalUsageTotals;
  todayLocalComplete: boolean;
  sevenDayLocal: CodexLocalUsageTotals;
  sevenDayLocalComplete: boolean;
  dailyLocal: CodexLocalUsageDay[];
  collectionStartedAt: string | null;
  updatedAt: string;
  stale: boolean;
  error: string | null;
}

export interface UsageOverviewSnapshot {
  providers: UsageProviderSummary[];
  updatedAt: string;
  providerCoverage: 'all-recorded' | 'codex-only-compatibility';
}

export interface CodexLocalUsageTotals extends TokenUsageBreakdown {
  conversationCount: number;
  turnCount: number;
  cacheHitRate: number | null;
  estimatedCredits: number | null;
  apiEquivalentUsd: number | null;
  cacheSavingsUsd: number | null;
  priceCoverage: number | null;
}

export interface CodexLocalUsageGroup extends CodexLocalUsageTotals {
  id: string;
  label: string;
  deleted: boolean;
}

export interface CodexLocalUsageDay extends CodexLocalUsageTotals {
  date: string;
}

export type CodexUsageRange = '7d' | '30d' | '90d' | 'all';

export interface CodexUsageSummarySnapshot {
  providerId: 'codex';
  official: CodexOfficialUsageSnapshot;
  officialTodayTokens: number | null;
  officialSevenDayTokens: number | null;
  localSevenDay: CodexLocalUsageTotals;
  updatedAt: string;
}

export interface CodexUsageAnalyticsSnapshot {
  providerId: 'codex';
  range: CodexUsageRange;
  projectId: string | null;
  model: string | null;
  official: CodexOfficialUsageSnapshot;
  local: {
    totals: CodexLocalUsageTotals;
    daily: CodexLocalUsageDay[];
    byModel: CodexLocalUsageGroup[];
    byProject: CodexLocalUsageGroup[];
    byConversation: CodexLocalUsageGroup[];
    collectionStartedAt: string | null;
  };
  pricing: {
    catalogDate: string;
    sourceUrls: string[];
    note: string;
  };
  updatedAt: string;
}

interface CodexModelPrice {
  id: string;
  aliases: string[];
  credits: { input: number; cachedInput: number; cacheWrite: number | null; output: number };
  standardUsd: { input: number; cachedInput: number; cacheWrite: number | null; output: number };
  fastUsd: { input: number; cachedInput: number; cacheWrite: number | null; output: number } | null;
  fastLongUsd: { input: number; cachedInput: number; cacheWrite: number | null; output: number } | null;
  longUsd: { input: number; cachedInput: number; cacheWrite: number | null; output: number } | null;
  fastCreditsMultiplier: number | null;
}

interface DeepSeekModelPrice {
  id: string;
  beforeWindowPricing: { input: number; cachedInput: number; output: number };
  offPeak: { input: number; cachedInput: number; output: number };
  peak: { input: number; cachedInput: number; output: number };
}

export const CODEX_USAGE_PRICE_CATALOG_DATE = '2026-08-10';
export const CODEX_USAGE_PRICE_SOURCE_URLS = [
  'https://developers.openai.com/api/docs/pricing',
  'https://developers.openai.com/api/docs/guides/prompt-caching',
  'https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits',
  'https://learn.chatgpt.com/docs/agent-configuration/speed',
] as const;

export const DEEPSEEK_USAGE_PRICE_CATALOG_DATE = '2026-08-15';
export const DEEPSEEK_USAGE_PRICE_SOURCE_URLS = ['https://api-docs.deepseek.com/quick_start/pricing/'] as const;

const deepSeekWindowPricingStartsAt = Date.parse('2026-08-16T16:00:00Z');
const deepSeekPrices: DeepSeekModelPrice[] = [
  {
    id: 'deepseek-v4-flash',
    beforeWindowPricing: { input: 0.14, cachedInput: 0.0028, output: 0.28 },
    offPeak: { input: 0.22, cachedInput: 0.007, output: 0.66 },
    peak: { input: 0.44, cachedInput: 0.014, output: 1.32 },
  },
  {
    id: 'deepseek-v4-pro',
    beforeWindowPricing: { input: 0.435, cachedInput: 0.003625, output: 0.87 },
    offPeak: { input: 0.66, cachedInput: 0.022, output: 1.98 },
    peak: { input: 1.32, cachedInput: 0.044, output: 3.96 },
  },
];

const prices: CodexModelPrice[] = [
  {
    id: 'gpt-5.6-sol',
    aliases: ['gpt-5.6-sol'],
    credits: { input: 125, cachedInput: 12.5, cacheWrite: 156.25, output: 750 },
    standardUsd: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
    fastUsd: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 60 },
    fastLongUsd: { input: 20, cachedInput: 2, cacheWrite: 25, output: 90 },
    longUsd: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 45 },
    fastCreditsMultiplier: 2.5,
  },
  {
    id: 'gpt-5.6-terra',
    aliases: ['gpt-5.6-terra'],
    credits: { input: 50, cachedInput: 5, cacheWrite: 62.5, output: 300 },
    standardUsd: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    fastUsd: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 24 },
    fastLongUsd: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 36 },
    longUsd: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
    fastCreditsMultiplier: 2.5,
  },
  {
    id: 'gpt-5.6-luna',
    aliases: ['gpt-5.6-luna'],
    credits: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 30 },
    standardUsd: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    fastUsd: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 2.4 },
    fastLongUsd: { input: 0.8, cachedInput: 0.08, cacheWrite: 1, output: 3.6 },
    longUsd: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
    fastCreditsMultiplier: 2.5,
  },
  {
    id: 'gpt-5.5',
    aliases: ['gpt-5.5'],
    credits: { input: 125, cachedInput: 12.5, cacheWrite: null, output: 750 },
    standardUsd: { input: 5, cachedInput: 0.5, cacheWrite: null, output: 30 },
    fastUsd: { input: 12.5, cachedInput: 1.25, cacheWrite: null, output: 75 },
    fastLongUsd: null,
    longUsd: { input: 10, cachedInput: 1, cacheWrite: null, output: 45 },
    fastCreditsMultiplier: 2.5,
  },
  {
    id: 'gpt-5.4',
    aliases: ['gpt-5.4'],
    credits: { input: 62.5, cachedInput: 6.25, cacheWrite: null, output: 375 },
    standardUsd: { input: 2.5, cachedInput: 0.25, cacheWrite: null, output: 15 },
    fastUsd: { input: 5, cachedInput: 0.5, cacheWrite: null, output: 30 },
    fastLongUsd: null,
    longUsd: { input: 5, cachedInput: 0.5, cacheWrite: null, output: 22.5 },
    fastCreditsMultiplier: 2,
  },
  {
    id: 'gpt-5.4-mini',
    aliases: ['gpt-5.4-mini'],
    credits: { input: 18.75, cachedInput: 1.875, cacheWrite: null, output: 113 },
    standardUsd: { input: 0.75, cachedInput: 0.075, cacheWrite: null, output: 4.5 },
    fastUsd: { input: 1.5, cachedInput: 0.15, cacheWrite: null, output: 9 },
    fastLongUsd: null,
    longUsd: null,
    fastCreditsMultiplier: 2,
  },
];

export function emptyTokenUsageBreakdown(): TokenUsageBreakdown {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

export function calculateCacheHitRate(usage: Pick<TokenUsageBreakdown, 'inputTokens' | 'cachedInputTokens'>): number | null {
  return usage.inputTokens > 0 ? Math.min(1, Math.max(0, usage.cachedInputTokens / usage.inputTokens)) : null;
}

/** 未命中输入包含普通输入，不重复计算已经单列的缓存读取和缓存写入。 */
export function calculateUncachedInputTokens(usage: Pick<TokenUsageBreakdown, 'inputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'>): number {
  return Math.max(0, usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteInputTokens);
}

export function estimateCodexUsage(input: { model: string; serviceTier?: string | null; usage: TokenUsageBreakdown }): CodexUsageEstimate {
  const model = resolvePrice(input.model);
  const serviceTier = input.serviceTier ?? null;
  const isFast = serviceTier === 'priority';
  const longContext = input.usage.inputTokens > 272_000 && model?.longUsd !== null;
  const usdRates = model ? (isFast ? (longContext ? model.fastLongUsd : model.fastUsd) : longContext ? model.longUsd : model.standardUsd) : null;
  const creditsMultiplier = isFast && model?.fastCreditsMultiplier ? model.fastCreditsMultiplier : 1;
  const creditRates = model
    ? {
        input: model.credits.input * creditsMultiplier,
        cachedInput: model.credits.cachedInput * creditsMultiplier,
        cacheWrite: model.credits.cacheWrite === null ? null : model.credits.cacheWrite * creditsMultiplier,
        output: model.credits.output * creditsMultiplier,
      }
    : null;
  const rateSnapshot: CodexUsageRateSnapshot = {
    catalogDate: CODEX_USAGE_PRICE_CATALOG_DATE,
    model: input.model,
    normalizedModel: model?.id ?? null,
    serviceTier,
    longContext,
    creditsPerMillion: creditRates,
    usdPerMillion: usdRates,
    sourceUrls: [...CODEX_USAGE_PRICE_SOURCE_URLS],
  };
  return estimateCodexUsageWithRateSnapshot(input.usage, rateSnapshot);
}

/** 按 DeepSeek 官方公开单价和请求发生时间估算费用，并把当时费率固化到账本。 */
export function estimateDeepSeekUsage(input: { model: string; usage: TokenUsageBreakdown; occurredAt: string }): CodexUsageEstimate {
  const model = resolveDeepSeekPrice(input.model);
  const occurredAt = Date.parse(input.occurredAt);
  const rate = model && Number.isFinite(occurredAt) ? resolveDeepSeekRate(model, occurredAt) : null;
  const rateSnapshot: CodexUsageRateSnapshot = {
    catalogDate: DEEPSEEK_USAGE_PRICE_CATALOG_DATE,
    model: input.model,
    normalizedModel: model?.id ?? null,
    serviceTier: null,
    longContext: false,
    creditsPerMillion: null,
    // DeepSeek 不单独收取缓存写入费；若运行内核单列缓存写入 token，按未命中输入计价。
    usdPerMillion: rate ? { input: rate.input, cachedInput: rate.cachedInput, cacheWrite: rate.input, output: rate.output } : null,
    sourceUrls: [...DEEPSEEK_USAGE_PRICE_SOURCE_URLS],
  };
  return estimateCodexUsageWithRateSnapshot(input.usage, rateSnapshot);
}

/** 用原始费率快照重算同一轮的增量通知，避免 Zeus 升级后改写历史价格口径。 */
export function estimateCodexUsageWithRateSnapshot(usage: TokenUsageBreakdown, rateSnapshot: CodexUsageRateSnapshot): CodexUsageEstimate {
  const usdRates = rateSnapshot.usdPerMillion;
  const creditRates = rateSnapshot.creditsPerMillion;
  const uncachedInput = calculateUncachedInputTokens(usage);
  const billableTokens = uncachedInput + usage.cachedInputTokens + usage.cacheWriteInputTokens + usage.outputTokens;
  if (!usdRates) {
    return { credits: null, apiEquivalentUsd: null, cacheSavingsUsd: null, pricedTokens: 0, billableTokens, coverage: billableTokens > 0 ? 0 : null, rateSnapshot };
  }
  const usdWritePriced = usage.cacheWriteInputTokens === 0 || usdRates.cacheWrite !== null;
  const apiEquivalentUsd = usdWritePriced
    ? perMillion(uncachedInput * usdRates.input + usage.cachedInputTokens * usdRates.cachedInput + usage.cacheWriteInputTokens * (usdRates.cacheWrite ?? 0) + usage.outputTokens * usdRates.output)
    : null;
  const creditsWritePriced = usage.cacheWriteInputTokens === 0 || creditRates?.cacheWrite !== null;
  const credits =
    creditRates && creditsWritePriced
      ? perMillion(uncachedInput * creditRates.input + usage.cachedInputTokens * creditRates.cachedInput + usage.cacheWriteInputTokens * (creditRates.cacheWrite ?? 0) + usage.outputTokens * creditRates.output)
      : null;
  const pricedTokens = billableTokens - (usdWritePriced ? 0 : usage.cacheWriteInputTokens);
  const cacheSavingsUsd = perMillion(usage.cachedInputTokens * Math.max(0, usdRates.input - usdRates.cachedInput));
  return {
    credits,
    apiEquivalentUsd,
    cacheSavingsUsd,
    pricedTokens,
    billableTokens,
    coverage: billableTokens > 0 ? pricedTokens / billableTokens : null,
    rateSnapshot,
  };
}

function resolvePrice(model: string): CodexModelPrice | null {
  const normalized = model.trim().toLowerCase();
  return prices.find((price) => price.aliases.some((alias) => normalized === alias || normalized.startsWith(`${alias}-20`))) ?? null;
}

function resolveDeepSeekPrice(model: string): DeepSeekModelPrice | null {
  const normalized = model.trim().toLowerCase();
  return deepSeekPrices.find((price) => price.id === normalized) ?? null;
}

function resolveDeepSeekRate(model: DeepSeekModelPrice, occurredAt: number): DeepSeekModelPrice['beforeWindowPricing'] {
  if (occurredAt < deepSeekWindowPricingStartsAt) return model.beforeWindowPricing;
  const hour = new Date(occurredAt).getUTCHours();
  const peak = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return peak ? model.peak : model.offPeak;
}

function perMillion(value: number): number {
  return value / 1_000_000;
}
