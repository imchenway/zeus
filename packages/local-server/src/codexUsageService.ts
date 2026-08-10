import type { CodexAccountRateLimitsSnapshot, CodexAccountSnapshot, CodexAppServerManager } from '@zeus/ai-runtime';
import {
  calculateCacheHitRate,
  CODEX_USAGE_PRICE_CATALOG_DATE,
  CODEX_USAGE_PRICE_SOURCE_URLS,
  emptyTokenUsageBreakdown,
  estimateCodexUsage,
  estimateCodexUsageWithRateSnapshot,
  type CodexLocalUsageDay,
  type CodexLocalUsageTotals,
  type CodexOfficialUsageSnapshot,
  type CodexUsageAnalyticsSnapshot,
  type CodexUsageRange,
  type CodexUsageSummarySnapshot,
  type NativeTokenUsageSnapshot,
  type TokenUsageBreakdown,
} from '@zeus/shared';
import { type CodexUsageLedgerRecord, CodexUsageLedgerRepository, ConversationRepository, ProjectRepository, SettingRepository } from '@zeus/storage';

interface CreateCodexUsageServiceOptions {
  manager: CodexAppServerManager;
  ledger: CodexUsageLedgerRepository;
  conversations: ConversationRepository;
  projects: ProjectRepository;
  settings: SettingRepository;
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  persist?: () => Promise<void>;
  now?: () => string;
}

interface PersistedOfficialUsage {
  snapshot: CodexOfficialUsageSnapshot;
  storedAt: string;
}

export interface CodexUsageService {
  recordTurn(input: {
    generationId: string;
    sequence: number;
    projectId: string;
    conversationId: string;
    providerThreadId: string;
    providerTurnId: string;
    model: string;
    serviceTier?: string | null;
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
    occurredAt: string;
  }): Promise<NativeTokenUsageSnapshot>;
  refreshOfficialUsage(): Promise<CodexOfficialUsageSnapshot>;
  handleSparseRateLimitUpdate(): void;
  handleAccountChanged(): void;
  readSummary(): Promise<CodexUsageSummarySnapshot>;
  readAnalytics(input: { range: CodexUsageRange; projectId?: string | null; model?: string | null }): Promise<CodexUsageAnalyticsSnapshot>;
}

const lastAccountScopeSettingKey = 'codex.usage.last_account_scope';
const officialCacheKey = (scopeId: string) => `codex.usage.official.${scopeId}`;

export function createCodexUsageService(options: CreateCodexUsageServiceOptions): CodexUsageService {
  const now = options.now ?? (() => new Date().toISOString());
  let accountCache: { value: CodexAccountSnapshot; expiresAt: number } | null = null;
  let officialRefresh: Promise<CodexOfficialUsageSnapshot> | null = null;
  let sparseRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  async function readAccount(): Promise<CodexAccountSnapshot> {
    if (accountCache && accountCache.expiresAt > Date.now()) return accountCache.value;
    const value = await options.manager.readAccount();
    accountCache = { value, expiresAt: Date.now() + 60_000 };
    return value;
  }

  function cachedOfficial(scopeId?: string | null): CodexOfficialUsageSnapshot | null {
    const effectiveScope = scopeId ?? options.settings.getJson<string>(lastAccountScopeSettingKey);
    if (!effectiveScope) return null;
    return options.settings.getJson<PersistedOfficialUsage>(officialCacheKey(effectiveScope))?.snapshot ?? null;
  }

  async function persistOfficial(snapshot: CodexOfficialUsageSnapshot): Promise<void> {
    if (!snapshot.accountScopeId) return;
    options.settings.setJson(lastAccountScopeSettingKey, snapshot.accountScopeId);
    options.settings.setJson(officialCacheKey(snapshot.accountScopeId), { snapshot, storedAt: now() } satisfies PersistedOfficialUsage);
    await options.persist?.();
  }

  async function refreshOfficialUsage(): Promise<CodexOfficialUsageSnapshot> {
    if (officialRefresh) return officialRefresh;
    officialRefresh = (async () => {
      let account: CodexAccountSnapshot;
      try {
        account = await readAccount();
      } catch (error) {
        const previous = cachedOfficial();
        return previous ? { ...previous, stale: true, error: errorMessage(error) } : emptyOfficial('unavailable', null, null, null, true, errorMessage(error));
      }
      if (!account.signedIn) return emptyOfficial('signed_out', account.accountScopeId, account.accountType, account.planType, false, null);
      if (account.accountType !== 'chatgpt') return emptyOfficial('unsupported', account.accountScopeId, account.accountType, account.planType, false, null);

      const previous = cachedOfficial(account.accountScopeId);
      const [usageResult, limitsResult] = await Promise.allSettled([options.manager.readAccountUsage(), options.manager.readAccountRateLimits()]);
      const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
      const limits = limitsResult.status === 'fulfilled' ? limitsResult.value : null;
      if (!usage && !limits && previous) {
        return { ...previous, stale: true, error: [usageResult, limitsResult].map(settledError).filter(Boolean).join('；') || '暂时无法刷新官方用量' };
      }
      const fetchedAt = now();
      const snapshot: CodexOfficialUsageSnapshot = {
        state: 'available',
        accountScopeId: account.accountScopeId,
        accountType: account.accountType,
        planType: account.planType ?? limits?.rateLimits.planType ?? previous?.planType ?? null,
        lifetimeTokens: usage?.summary.lifetimeTokens ?? previous?.lifetimeTokens ?? null,
        peakDailyTokens: usage?.summary.peakDailyTokens ?? previous?.peakDailyTokens ?? null,
        longestRunningTurnSec: usage?.summary.longestRunningTurnSec ?? previous?.longestRunningTurnSec ?? null,
        currentStreakDays: usage?.summary.currentStreakDays ?? previous?.currentStreakDays ?? null,
        longestStreakDays: usage?.summary.longestStreakDays ?? previous?.longestStreakDays ?? null,
        dailyUsageBuckets: usage ? usage.dailyUsageBuckets : (previous?.dailyUsageBuckets ?? null),
        rateLimitWindows: limits ? flattenRateLimitWindows(limits) : (previous?.rateLimitWindows ?? []),
        fetchedAt,
        stale: usageResult.status === 'rejected' || limitsResult.status === 'rejected',
        error: [usageResult, limitsResult].map(settledError).filter(Boolean).join('；') || null,
      };
      await persistOfficial(snapshot);
      return snapshot;
    })().finally(() => {
      officialRefresh = null;
    });
    return officialRefresh;
  }

  async function recordTurn(input: Parameters<CodexUsageService['recordTurn']>[0]): Promise<NativeTokenUsageSnapshot> {
    validateBreakdown(input.total);
    validateBreakdown(input.last);
    const existing = options.ledger.findByProviderTurn('codex', input.providerThreadId, input.providerTurnId);
    const estimate = existing ? estimateCodexUsageWithRateSnapshot(input.last, existing.estimate.rateSnapshot) : estimateCodexUsage({ model: input.model, serviceTier: input.serviceTier, usage: input.last });
    let accountScopeId = 'codex-local';
    try {
      accountScopeId = (await readAccount()).accountScopeId;
    } catch {
      // 离线轮次仍进入本机账本，不伪装成官方账户统计。
    }
    options.ledger.upsert({
      providerId: 'codex',
      accountScopeId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      model: input.model,
      serviceTier: input.serviceTier,
      usage: input.last,
      estimate,
      occurredAt: input.occurredAt,
    });
    const rows = options.ledger.list({ conversationId: input.conversationId });
    const local = aggregateRows(rows);
    const catalogDates = [...new Set(rows.map((row) => row.estimate.rateSnapshot.catalogDate))].sort();
    const pricingSourceUrls = [...new Set(rows.flatMap((row) => row.estimate.rateSnapshot.sourceUrls))];
    const historyComplete = sumBreakdowns(rows.map((row) => row.usage)).totalTokens >= input.total.totalTokens;
    const snapshot: NativeTokenUsageSnapshot = {
      generationId: input.generationId,
      sequence: input.sequence,
      total: input.total,
      last: input.last,
      modelContextWindow: input.modelContextWindow,
      cacheHitRate: calculateCacheHitRate(input.total),
      estimatedCredits: local.estimatedCredits,
      apiEquivalentUsd: local.apiEquivalentUsd,
      cacheSavingsUsd: local.cacheSavingsUsd,
      priceCoverage: local.priceCoverage,
      pricingCatalogDate: catalogDates.at(-1) ?? null,
      pricingSourceUrls,
      historyComplete,
    };
    options.broadcast('codex.usage.changed', { providerId: 'codex', conversationId: input.conversationId, updatedAt: now() });
    return snapshot;
  }

  function handleSparseRateLimitUpdate(): void {
    if (sparseRefreshTimer) return;
    sparseRefreshTimer = setTimeout(() => {
      sparseRefreshTimer = null;
      void refreshOfficialUsage().then(
        (official) => options.broadcast('codex.usage.changed', { providerId: 'codex', scope: 'official', stale: official.stale, updatedAt: now() }),
        () => undefined,
      );
    }, 250);
  }

  function handleAccountChanged(): void {
    accountCache = null;
    handleSparseRateLimitUpdate();
  }

  async function readSummary(): Promise<CodexUsageSummarySnapshot> {
    const [official] = await Promise.all([refreshOfficialUsage()]);
    const today = localDate(new Date());
    const sevenDayStart = localDate(addDays(startOfLocalDay(new Date()), -6));
    const rows = options.ledger.list({ accountScopeId: official.accountScopeId ?? 'codex-local', since: addDays(startOfLocalDay(new Date()), -6).toISOString() });
    const buckets = official.dailyUsageBuckets ?? [];
    return {
      providerId: 'codex',
      official,
      officialTodayTokens: buckets.find((bucket) => bucket.startDate === today)?.tokens ?? (official.dailyUsageBuckets ? 0 : null),
      officialSevenDayTokens: official.dailyUsageBuckets ? buckets.filter((bucket) => bucket.startDate >= sevenDayStart).reduce((sum, bucket) => sum + bucket.tokens, 0) : null,
      localSevenDay: aggregateRows(rows),
      updatedAt: now(),
    };
  }

  async function readAnalytics(input: Parameters<CodexUsageService['readAnalytics']>[0]): Promise<CodexUsageAnalyticsSnapshot> {
    const official = await refreshOfficialUsage();
    const rows = options.ledger.list({ accountScopeId: official.accountScopeId ?? 'codex-local', since: rangeStart(input.range), projectId: input.projectId, model: input.model });
    return {
      providerId: 'codex',
      range: input.range,
      projectId: input.projectId ?? null,
      model: input.model ?? null,
      official,
      local: {
        totals: aggregateRows(rows),
        daily: groupRows(rows, (row) => localDate(new Date(row.occurredAt))).map(([date, entries]) => ({ date, ...aggregateRows(entries) })) satisfies CodexLocalUsageDay[],
        byModel: groupRows(rows, (row) => row.model).map(([model, entries]) => ({ id: model, label: model, deleted: false, ...aggregateRows(entries) })),
        byProject: groupRows(rows, (row) => row.projectId).map(([projectId, entries]) => {
          const project = options.projects.getById(projectId);
          return { id: projectId, label: project?.name ?? '已删除项目', deleted: !project, ...aggregateRows(entries) };
        }),
        byConversation: groupRows(rows, (row) => row.conversationId).map(([conversationId, entries]) => {
          const conversation = options.conversations.getRecordById(conversationId);
          return { id: conversationId, label: conversation?.title || '已删除会话', deleted: !conversation, ...aggregateRows(entries) };
        }),
        collectionStartedAt: options.ledger.collectionStartedAt(official.accountScopeId ?? 'codex-local'),
      },
      pricing: {
        catalogDate: CODEX_USAGE_PRICE_CATALOG_DATE,
        sourceUrls: [...CODEX_USAGE_PRICE_SOURCE_URLS],
        note: 'Credits 与 API 等价美元均为估算，不是实际账单；未知模型不估价。',
      },
      updatedAt: now(),
    };
  }

  return { recordTurn, refreshOfficialUsage, handleSparseRateLimitUpdate, handleAccountChanged, readSummary, readAnalytics };
}

function emptyOfficial(state: CodexOfficialUsageSnapshot['state'], accountScopeId: string | null, accountType: string | null, planType: string | null, stale: boolean, error: string | null): CodexOfficialUsageSnapshot {
  return {
    state,
    accountScopeId,
    accountType,
    planType,
    lifetimeTokens: null,
    peakDailyTokens: null,
    longestRunningTurnSec: null,
    currentStreakDays: null,
    longestStreakDays: null,
    dailyUsageBuckets: null,
    rateLimitWindows: [],
    fetchedAt: null,
    stale,
    error,
  };
}

function flattenRateLimitWindows(snapshot: CodexAccountRateLimitsSnapshot): CodexOfficialUsageSnapshot['rateLimitWindows'] {
  const multiBuckets = snapshot.rateLimitsByLimitId ? Object.entries(snapshot.rateLimitsByLimitId) : [];
  const buckets = multiBuckets.length > 0 ? multiBuckets : [[snapshot.rateLimits.limitId ?? 'default', snapshot.rateLimits] as const];
  return buckets.flatMap(([fallbackId, bucket]) =>
    (['primary', 'secondary'] as const).flatMap((kind) => {
      const window = bucket[kind];
      if (!window) return [];
      return [
        {
          limitId: bucket.limitId ?? fallbackId,
          limitName: bucket.limitName,
          kind,
          usedPercent: window.usedPercent,
          remainingPercent: Math.max(0, 100 - window.usedPercent),
          windowDurationMins: window.windowDurationMins,
          resetsAt: window.resetsAt,
        },
      ];
    }),
  );
}

function aggregateRows(rows: readonly CodexUsageLedgerRecord[]): CodexLocalUsageTotals {
  const usage = sumBreakdowns(rows.map((row) => row.usage));
  const billableTokens = rows.reduce((sum, row) => sum + row.estimate.billableTokens, 0);
  const pricedTokens = rows.reduce((sum, row) => sum + row.estimate.pricedTokens, 0);
  const creditValues = rows.flatMap((row) => (row.estimate.credits === null ? [] : [row.estimate.credits]));
  const usdValues = rows.flatMap((row) => (row.estimate.apiEquivalentUsd === null ? [] : [row.estimate.apiEquivalentUsd]));
  const savingsValues = rows.flatMap((row) => (row.estimate.cacheSavingsUsd === null ? [] : [row.estimate.cacheSavingsUsd]));
  return {
    ...usage,
    conversationCount: new Set(rows.map((row) => row.conversationId)).size,
    turnCount: rows.length,
    cacheHitRate: calculateCacheHitRate(usage),
    estimatedCredits: creditValues.length > 0 ? creditValues.reduce((sum, value) => sum + value, 0) : null,
    apiEquivalentUsd: usdValues.length > 0 ? usdValues.reduce((sum, value) => sum + value, 0) : null,
    cacheSavingsUsd: savingsValues.length > 0 ? savingsValues.reduce((sum, value) => sum + value, 0) : null,
    priceCoverage: billableTokens > 0 ? pricedTokens / billableTokens : null,
  };
}

function sumBreakdowns(values: readonly TokenUsageBreakdown[]): TokenUsageBreakdown {
  return values.reduce<TokenUsageBreakdown>((total, value) => {
    total.totalTokens += value.totalTokens;
    total.inputTokens += value.inputTokens;
    total.cachedInputTokens += value.cachedInputTokens;
    total.cacheWriteInputTokens += value.cacheWriteInputTokens;
    total.outputTokens += value.outputTokens;
    total.reasoningOutputTokens += value.reasoningOutputTokens;
    return total;
  }, emptyTokenUsageBreakdown());
}

function groupRows(rows: readonly CodexUsageLedgerRecord[], key: (row: CodexUsageLedgerRecord) => string): Array<[string, CodexUsageLedgerRecord[]]> {
  const groups = new Map<string, CodexUsageLedgerRecord[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()].sort((left, right) => aggregateRows(right[1]).totalTokens - aggregateRows(left[1]).totalTokens);
}

function rangeStart(range: CodexUsageRange): string | null {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  return addDays(startOfLocalDay(new Date()), -(days - 1)).toISOString();
}

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateBreakdown(value: TokenUsageBreakdown): void {
  if (Object.values(value).some((candidate) => !Number.isSafeInteger(candidate) || candidate < 0)) throw new Error('Invalid Codex token usage breakdown');
}

function settledError(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? errorMessage(result.reason) : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
