import type { CodexAccountRateLimitsSnapshot, CodexAccountSnapshot, CodexAppServerManager } from '@zeus/ai-runtime';
import {
  calculateCacheHitRate,
  CODEX_USAGE_PRICE_CATALOG_DATE,
  emptyTokenUsageBreakdown,
  estimateCodexUsage,
  estimateCodexUsageWithRateSnapshot,
  aggregateRequestPrices,
  sumEstimatedCosts,
  unavailableRateSnapshot,
  type CodexUsageEstimate,
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
import { estimatePublishedCodexUsage, fetchPublishedCodexPricing, parsePublishedCodexPrices, type PublishedCodexPricing } from './codexUsagePricing.js';

interface CreateCodexUsageServiceOptions {
  manager: CodexAppServerManager;
  ledger: CodexUsageLedgerRepository;
  conversations: ConversationRepository;
  projects: ProjectRepository;
  settings: SettingRepository;
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  persist?: () => Promise<void>;
  now?: () => string;
  repairLegacyCodexSourceAlias?: boolean;
  /** 只读验收禁用网络补价与账本写入。 */
  automaticPricing?: boolean;
}

interface PersistedOfficialUsage {
  snapshot: CodexOfficialUsageSnapshot;
  storedAt: string;
}

export interface CodexUsageService {
  /** 真实请求单独固化单价；相同响应身份重放不新增费用。 */
  recordRequest(input: {
    projectId: string;
    conversationId: string;
    providerThreadId: string;
    providerTurnId: string;
    requestId: string;
    model: string;
    modelSourceId?: string | null;
    serviceTier?: string | null;
    usage: TokenUsageBreakdown;
    occurredAt: string;
  }): Promise<CodexUsageEstimate>;
  /** 后台补齐缺价记录，不由查询接口触发写入。 */
  refreshMissingPricing(): Promise<void>;
  /** 停止补价请求与延迟任务，避免服务关闭后写入账本。 */
  dispose(): Promise<void>;
  recordTurn(input: {
    generationId: string;
    sequence: number;
    projectId: string;
    conversationId: string;
    providerThreadId: string;
    providerTurnId: string;
    model: string;
    modelSourceId?: string | null;
    serviceTier?: string | null;
    total: TokenUsageBreakdown;
    last: TokenUsageBreakdown;
    modelContextWindow: number | null;
    occurredAt: string;
  }): Promise<NativeTokenUsageSnapshot>;
  refreshOfficialUsage(minimumAgeMs?: number): Promise<CodexOfficialUsageSnapshot>;
  readCachedOfficialUsage(): CodexOfficialUsageSnapshot;
  handleSparseRateLimitUpdate(): void;
  handleAccountChanged(): void;
  readSummary(): Promise<CodexUsageSummarySnapshot>;
  readAnalytics(input: { range: CodexUsageRange; projectId?: string | null; model?: string | null }): Promise<CodexUsageAnalyticsSnapshot>;
}

const lastAccountScopeSettingKey = 'codex.usage.last_account_scope';
const officialCacheKey = (scopeId: string) => `codex.usage.official.${scopeId}`;
/** 官方价目原文复用现有设置存储，不引入额外数据库或文件。 */
const publishedPricingKey = 'codex.usage.published_pricing';

export function createCodexUsageService(options: CreateCodexUsageServiceOptions): CodexUsageService {
  const now = options.now ?? (() => new Date().toISOString());
  let accountCache: { value: CodexAccountSnapshot; expiresAt: number } | null = null;
  let officialRefresh: Promise<CodexOfficialUsageSnapshot> | null = null;
  /** 最近检查结果也保留未登录和失败状态，避免打开浮窗连续重试。 */
  let officialSnapshot: CodexOfficialUsageSnapshot | null = null;
  /** 官方检查节流使用单调时钟，不受系统校时影响。 */
  let officialCheckedAt = -Infinity;
  /** 账户切换后丢弃旧账户在途刷新，避免旧快照重新出现。 */
  let officialAccountEpoch = 0;
  let sparseRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** 一个服务实例只维护一份下载，缺价并发不会重复联网。 */
  let pricingRefresh: Promise<void> | null = null;
  /** 先提交 Token 事件，再在下一次事件循环补价。 */
  let pricingTimer: ReturnType<typeof setTimeout> | null = null;
  /** 关闭时同时取消网络请求。 */
  const pricingAbort = new AbortController();
  /** 成功后一小时内、失败后五分钟内不重复获取同一官方页面。 */
  let nextPricingAttemptAt = 0;
  /** 已验证的公开价格，重启后仍可离线使用。 */
  let publishedPricing: PublishedCodexPricing | null = null;
  /** 同一官方原文仅解析一次，避免按账本行重复扫描整份文档。 */
  let publishedPrices: ReturnType<typeof parsePublishedCodexPrices> = [];
  try {
    /** 设置也是数据边界，损坏缓存不能中断账本服务。 */
    const cached = options.settings.getJson<PublishedCodexPricing>(publishedPricingKey);
    if (cached && typeof cached.document === 'string' && cached.document.length <= 512_000 && typeof cached.fetchedAt === 'string' && Number.isFinite(Date.parse(cached.fetchedAt))) {
      publishedPrices = parsePublishedCodexPrices(cached.document);
      publishedPricing = cached;
      nextPricingAttemptAt = Date.parse(cached.fetchedAt) + 60 * 60_000;
    }
  } catch {
    // 缓存损坏时下次后台刷新重新获取，Token 记录仍正常工作。
  }

  if (options.repairLegacyCodexSourceAlias !== false) repairLegacyCodexSourceAlias();

  /** 当前公开目录优先；已记录请求继续引用各自快照。 */
  function estimateAvailablePrice(input: { model: string; serviceTier?: string | null; usage: TokenUsageBreakdown }) {
    /** 尚未下载过目录时保留带日期的离线价格依据。 */
    const local = estimateCodexUsage(input);
    return publishedPricing ? (estimatePublishedCodexUsage({ ...input, catalog: publishedPricing, prices: publishedPrices }) ?? estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model))) : local;
  }

  /** 只更新空费用，重新读取账本避免联网期间覆盖新增 Token 或已补齐的价格。 */
  function backfillAvailablePrices(): boolean {
    /** 会话价格汇总只在该会话存在实际变化时重建一次。 */
    const affected = new Set<string>();
    for (const row of options.ledger.list({ providerId: 'codex' })) {
      if (row.estimate.apiEquivalentUsd !== null || row.estimate.requests) continue;
      /** 补价不是历史价格证明，因此始终保存补价标记。 */
      const estimate = estimateAvailablePrice({ model: row.model, serviceTier: row.serviceTier, usage: row.usage });
      if (estimate.apiEquivalentUsd === null) continue;
      estimate.rateSnapshot.backfilledAt = now();
      options.ledger.upsert({ ...row, estimate });
      affected.add(row.conversationId);
    }
    for (const conversationId of affected) repairConversationUsageSnapshot(conversationId);
    return affected.size > 0;
  }

  /** 本地补价与联网补价统一串行执行；失败保留真实用量和未知费用。 */
  function refreshMissingPricing(): Promise<void> {
    if (options.automaticPricing === false || pricingAbort.signal.aborted) return Promise.resolve();
    if (pricingRefresh) return pricingRefresh;
    pricingRefresh = (async () => {
      /** 优先使用缓存补价，离线也能恢复已经有依据的费用。 */
      let changed = backfillAvailablePrices();
      /** 到期即刷新，已有模型涨降价也能更新后续请求。 */
      if (Date.parse(now()) >= nextPricingAttemptAt) {
        nextPricingAttemptAt = Date.parse(now()) + 5 * 60_000;
        /** 只捕获下载错误，存储失败必须交给现有服务错误边界处理。 */
        let fetched: PublishedCodexPricing | null = null;
        try {
          /** 联网期间不阻塞 Token 事件；完成后再读取最新账本。 */
          fetched = await fetchPublishedCodexPricing(pricingAbort.signal);
        } catch {
          // 官方未发布、网络失败或格式变化时保持缺价，五分钟后允许重试。
        }
        if (pricingAbort.signal.aborted) return;
        if (fetched) {
          options.settings.setJson(publishedPricingKey, fetched);
          publishedPrices = parsePublishedCodexPrices(fetched.document);
          publishedPricing = fetched;
          nextPricingAttemptAt = Date.parse(now()) + 60 * 60_000;
          changed = backfillAvailablePrices() || changed;
          await options.persist?.();
        }
      }
      if (changed && !pricingAbort.signal.aborted) {
        await options.persist?.();
        options.broadcast('codex.usage.changed', { providerId: 'codex', scope: 'pricing', updatedAt: now() });
        options.broadcast('usage.changed', { providerId: 'codex', scope: 'pricing', updatedAt: now() });
      }
    })().finally(() => {
      pricingRefresh = null;
    });
    return pricingRefresh;
  }

  /** 轮次记账后异步补价，不把官网响应时间加入模型事件处理。 */
  function schedulePricingRefresh(): void {
    if (pricingTimer || options.automaticPricing === false || pricingAbort.signal.aborted) return;
    pricingTimer = setTimeout(() => {
      pricingTimer = null;
      void refreshMissingPricing().catch(() => undefined);
    }, 0);
    pricingTimer.unref?.();
  }

  /** 服务关闭后不保留计时器、网络请求或后台写入。 */
  async function dispose(): Promise<void> {
    pricingAbort.abort();
    if (pricingTimer) clearTimeout(pricingTimer);
    if (sparseRefreshTimer) clearTimeout(sparseRefreshTimer);
    await Promise.allSettled([pricingRefresh, officialRefresh]);
  }

  /**
   * 早期任务推送把原生 Codex 的 sourceId 写成了字符串 `codex`，旧迁移又把所有非空
   * sourceId 都改成 `api:*`。这会把官方 Codex 费率冻结成 DeepSeek 来源。启动时按保留的
   * 模型与 Token 事实重建这些账本和会话快照；第三方连接 id 不受影响。
   */
  function repairLegacyCodexSourceAlias(): void {
    const legacyRows = options.ledger.list({ providerId: 'api:codex' });
    if (legacyRows.length === 0) return;
    const affectedConversationIds = new Set<string>();
    for (const row of legacyRows) {
      const canonical = options.ledger.findByProviderTurn('codex', row.providerThreadId, row.providerTurnId);
      if (!canonical) {
        options.ledger.upsert({
          providerId: 'codex',
          accountScopeId: 'codex-local',
          projectId: row.projectId,
          conversationId: row.conversationId,
          providerThreadId: row.providerThreadId,
          providerTurnId: row.providerTurnId,
          model: row.model,
          serviceTier: row.serviceTier,
          usage: row.usage,
          providerBaseline: row.providerBaseline,
          providerTotal: row.providerTotal,
          usageComplete: row.usageComplete,
          estimate: row.estimate,
          occurredAt: row.occurredAt,
        });
      }
      options.ledger.deleteById(row.id);
      affectedConversationIds.add(row.conversationId);
    }
    for (const conversationId of affectedConversationIds) repairConversationUsageSnapshot(conversationId);
  }

  function repairConversationUsageSnapshot(conversationId: string): void {
    const previous = options.conversations.getProviderTokenUsageSnapshot(conversationId);
    if (!previous) return;
    const rows = options.ledger.list({ conversationId });
    const local = aggregateRows(rows);
    const catalogDates = [...new Set(rows.map((row) => row.estimate.rateSnapshot.catalogDate))].sort();
    const pricingSourceUrls = [...new Set(rows.flatMap((row) => row.estimate.rateSnapshot.sourceUrls))];
    const latest = rows.at(-1);
    options.conversations.repairProviderTokenUsagePricing(conversationId, {
      ...previous,
      costs: local.costs,
      estimatedCredits: local.estimatedCredits,
      apiEquivalentUsd: local.apiEquivalentUsd,
      lastApiEquivalentUsd: latest?.estimate.requests?.at(-1)?.estimate.apiEquivalentUsd ?? latest?.estimate.apiEquivalentUsd ?? null,
      cacheSavingsUsd: local.cacheSavingsUsd,
      priceCoverage: local.priceCoverage,
      pricingCatalogDate: catalogDates.at(-1) ?? null,
      pricingSourceUrls,
      historyComplete: sumBreakdowns(rows.map((row) => row.usage)).totalTokens >= previous.total.totalTokens,
    });
  }

  async function readAccount(): Promise<CodexAccountSnapshot> {
    if (accountCache && accountCache.expiresAt > Date.now()) return accountCache.value;
    const epoch = officialAccountEpoch;
    const value = await options.manager.readAccount();
    if (epoch !== officialAccountEpoch) return value;
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

  async function refreshOfficialUsage(minimumAgeMs = 15_000): Promise<CodexOfficialUsageSnapshot> {
    if (pricingAbort.signal.aborted) return readCachedOfficialUsage();
    if (officialRefresh) return officialRefresh;
    const cached = readCachedOfficialUsage();
    const cacheAge = cached.fetchedAt ? Date.parse(now()) - Date.parse(cached.fetchedAt) : Infinity;
    if (performance.now() - officialCheckedAt < minimumAgeMs || (!cached.stale && cacheAge >= 0 && cacheAge < minimumAgeMs)) return cached;
    const epoch = officialAccountEpoch;
    officialRefresh = (async () => {
      let account: CodexAccountSnapshot;
      try {
        account = await readAccount();
      } catch (error) {
        const previous = officialAccountEpoch === 0 ? cachedOfficial() : officialSnapshot;
        return previous ? { ...previous, stale: true, error: errorMessage(error) } : emptyOfficial('unavailable', null, null, null, true, errorMessage(error));
      }
      if (epoch !== officialAccountEpoch) return readCachedOfficialUsage();
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
        creditBalance: limits ? readCreditBalance(limits) : (previous?.creditBalance ?? null),
        creditsUnlimited: limits ? readCreditsUnlimited(limits) : (previous?.creditsUnlimited ?? false),
        fetchedAt,
        stale: usageResult.status === 'rejected' || limitsResult.status === 'rejected',
        error: [usageResult, limitsResult].map(settledError).filter(Boolean).join('；') || null,
      };
      if (epoch !== officialAccountEpoch) return readCachedOfficialUsage();
      await persistOfficial(snapshot);
      return snapshot;
    })()
      .then((snapshot) => {
        if (epoch !== officialAccountEpoch) return readCachedOfficialUsage();
        officialSnapshot = snapshot;
        officialCheckedAt = performance.now();
        return snapshot;
      })
      .finally(() => {
        officialRefresh = null;
        if (epoch !== officialAccountEpoch) handleSparseRateLimitUpdate();
      });
    return officialRefresh;
  }

  /** 原始响应是请求计价的权威；累计 Token 通知只负责轮次和会话总量。 */
  async function recordRequest(input: Parameters<CodexUsageService['recordRequest']>[0]): Promise<CodexUsageEstimate> {
    validateBreakdown(input.usage);
    const providerId = !input.modelSourceId || input.modelSourceId === 'codex' ? 'codex' : `api:${input.modelSourceId}`;
    const existing = options.ledger.findByProviderTurn(providerId, input.providerThreadId, input.providerTurnId);
    /** 旧轮次已有整体快照时保持原样，迟到的单请求事件不能覆盖历史总额。 */
    if (existing && !existing.estimate.requests) return estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model));
    const requests = existing?.estimate.requests ?? [];
    const previous = requests.find((request) => request.id === input.requestId);
    if (previous) return previous.estimate;
    const estimate = providerId === 'codex' ? estimateAvailablePrice(input) : estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model));
    const next = [...requests, { id: input.requestId, occurredAt: input.occurredAt, usage: input.usage, estimate }];
    const measured = sumBreakdowns(next.map((request) => request.usage));
    const usage = existing && existing.usage.totalTokens > measured.totalTokens ? existing.usage : measured;
    const totalEstimate = aggregateRequestPrices(next);
    totalEstimate.billableTokens = Math.max(totalEstimate.billableTokens, usage.inputTokens + usage.outputTokens);
    totalEstimate.coverage = totalEstimate.billableTokens ? totalEstimate.pricedTokens / totalEstimate.billableTokens : null;
    options.ledger.upsert({
      ...existing,
      providerId,
      accountScopeId: existing?.accountScopeId ?? (providerId === 'codex' ? 'codex-local' : input.modelSourceId!),
      projectId: input.projectId,
      conversationId: input.conversationId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      model: input.model,
      serviceTier: input.serviceTier,
      usage,
      usageComplete: existing?.usageComplete ?? false,
      estimate: totalEstimate,
      occurredAt: input.occurredAt,
    });
    repairConversationUsageSnapshot(input.conversationId);
    await options.persist?.();
    schedulePricingRefresh();
    return estimate;
  }

  async function recordTurn(input: Parameters<CodexUsageService['recordTurn']>[0]): Promise<NativeTokenUsageSnapshot> {
    validateBreakdown(input.total);
    validateBreakdown(input.last);
    const nativeCodexSource = !input.modelSourceId || input.modelSourceId === 'codex';
    const providerId = nativeCodexSource ? 'codex' : `api:${input.modelSourceId}`;
    const existing = options.ledger.findByProviderTurn(providerId, input.providerThreadId, input.providerTurnId);
    const threadRows = options.ledger.list({ providerId, providerThreadId: input.providerThreadId });
    const priorProviderTotal = threadRows
      .filter((row) => row.providerTurnId !== input.providerTurnId && row.providerTotal && row.providerTotal.totalTokens <= input.total.totalTokens)
      .sort((left, right) => (right.providerTotal?.totalTokens ?? 0) - (left.providerTotal?.totalTokens ?? 0))[0]?.providerTotal;
    const previousSnapshot = options.conversations.getProviderTokenUsageSnapshot(input.conversationId);
    const previousSnapshotTotal = previousSnapshot?.total && previousSnapshot.total.totalTokens < input.total.totalTokens ? previousSnapshot.total : null;
    const legacyRowsExist = threadRows.some((row) => row.providerTurnId !== input.providerTurnId && !row.providerTotal);
    const providerBaseline =
      existing?.providerBaseline ?? priorProviderTotal ?? previousSnapshotTotal ?? (existing ? subtractBreakdowns(input.total, existing.usage) : legacyRowsExist ? subtractBreakdowns(input.total, input.last) : emptyTokenUsageBreakdown());
    const usage = subtractBreakdowns(input.total, providerBaseline);
    const usageComplete = existing?.providerBaseline ? existing.usageComplete : Boolean(priorProviderTotal || previousSnapshotTotal || (!existing && !legacyRowsExist));
    /** 累计通知不重算已完成请求；未观测到请求的剩余用量保持缺价。 */
    const estimate = existing && !existing.estimate.requests ? { ...existing.estimate } : aggregateRequestPrices(existing?.estimate.requests ?? []);
    estimate.billableTokens = Math.max(estimate.billableTokens, usage.inputTokens + usage.outputTokens);
    estimate.coverage = estimate.billableTokens ? estimate.pricedTokens / estimate.billableTokens : null;
    if (nativeCodexSource && existing && existing.estimate.apiEquivalentUsd === null && estimate.apiEquivalentUsd !== null) estimate.rateSnapshot.backfilledAt = now();
    let accountScopeId = nativeCodexSource ? 'codex-local' : input.modelSourceId!;
    if (nativeCodexSource) {
      try {
        accountScopeId = (await readAccount()).accountScopeId;
      } catch {
        // 离线轮次仍进入本机账本，不伪装成官方账户统计。
      }
    }
    options.ledger.upsert({
      providerId,
      accountScopeId,
      projectId: input.projectId,
      conversationId: input.conversationId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      model: input.model,
      serviceTier: input.serviceTier,
      usage,
      providerBaseline,
      providerTotal: input.total,
      usageComplete,
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
      serviceTier: input.serviceTier ?? null,
      total: input.total,
      last: input.last,
      modelContextWindow: input.modelContextWindow,
      cacheHitRate: calculateCacheHitRate(input.total),
      costs: local.costs,
      estimatedCredits: local.estimatedCredits,
      apiEquivalentUsd: local.apiEquivalentUsd,
      lastApiEquivalentUsd: estimate.requests?.at(-1)?.estimate.apiEquivalentUsd ?? null,
      cacheSavingsUsd: local.cacheSavingsUsd,
      priceCoverage: local.priceCoverage,
      pricingCatalogDate: catalogDates.at(-1) ?? null,
      pricingSourceUrls,
      historyComplete,
    };
    options.broadcast('codex.usage.changed', { providerId, conversationId: input.conversationId, updatedAt: now() });
    if (nativeCodexSource && estimate.apiEquivalentUsd === null) schedulePricingRefresh();
    return snapshot;
  }

  function handleSparseRateLimitUpdate(): void {
    if (sparseRefreshTimer || pricingAbort.signal.aborted) return;
    sparseRefreshTimer = setTimeout(() => {
      sparseRefreshTimer = null;
      void refreshOfficialUsage(0).then(
        (official) => options.broadcast('codex.usage.changed', { providerId: 'codex', scope: 'official', stale: official.stale, updatedAt: now() }),
        () => undefined,
      );
    }, 250);
  }

  function handleAccountChanged(): void {
    accountCache = null;
    officialAccountEpoch += 1;
    officialCheckedAt = -Infinity;
    officialSnapshot = emptyOfficial('unavailable', null, null, null, true, null);
    handleSparseRateLimitUpdate();
  }

  function readCachedOfficialUsage(): CodexOfficialUsageSnapshot {
    const cached = officialSnapshot ?? cachedOfficial();
    return cached
      ? { ...cached, stale: cached.stale || !cached.fetchedAt || Date.parse(now()) - Date.parse(cached.fetchedAt) >= 10 * 60_000, creditBalance: cached.creditBalance ?? null, creditsUnlimited: cached.creditsUnlimited ?? false }
      : emptyOfficial('unavailable', null, null, null, true, null);
  }

  async function readSummary(): Promise<CodexUsageSummarySnapshot> {
    const official = readCachedOfficialUsage();
    const today = localDate(new Date());
    const sevenDayStart = localDate(addDays(startOfLocalDay(new Date()), -6));
    const rows = options.ledger.list({ accountScopeId: official.accountScopeId ?? 'codex-local', since: addDays(startOfLocalDay(new Date()), -6).toISOString() });
    const buckets = official.dailyUsageBuckets ?? [];
    return {
      providerId: 'codex',
      official,
      officialTodayTokens: buckets.find((bucket) => bucket.startDate === today)?.tokens ?? null,
      officialSevenDayTokens: official.dailyUsageBuckets ? buckets.filter((bucket) => bucket.startDate >= sevenDayStart).reduce((sum, bucket) => sum + bucket.tokens, 0) : null,
      localSevenDay: aggregateRows(rows),
      updatedAt: now(),
    };
  }

  async function readAnalytics(input: Parameters<CodexUsageService['readAnalytics']>[0]): Promise<CodexUsageAnalyticsSnapshot> {
    const official = readCachedOfficialUsage();
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
        catalogDate:
          rows
            .map((row) => row.estimate.rateSnapshot.catalogDate)
            .sort()
            .at(-1) ?? CODEX_USAGE_PRICE_CATALOG_DATE,
        sourceUrls: [...new Set(rows.flatMap((row) => row.estimate.rateSnapshot.sourceUrls))],
        note: 'Credits 与 API 等价美元均为估算，不是实际账单；缺价会自动获取官方价格。' + (rows.some((row) => row.estimate.rateSnapshot.backfilledAt) ? '历史缺价记录按补价时价格估算。' : ''),
      },
      updatedAt: now(),
    };
  }

  return { recordRequest, recordTurn, refreshOfficialUsage, readCachedOfficialUsage, handleSparseRateLimitUpdate, handleAccountChanged, readSummary, readAnalytics, refreshMissingPricing, dispose };
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
    creditBalance: null,
    creditsUnlimited: false,
    fetchedAt: null,
    stale,
    error,
  };
}

function readCreditBalance(snapshot: CodexAccountRateLimitsSnapshot): string | null {
  return (
    rateLimitBuckets(snapshot)
      .map((bucket) => bucket.credits?.balance ?? null)
      .find((balance): balance is string => Boolean(balance)) ?? null
  );
}

function readCreditsUnlimited(snapshot: CodexAccountRateLimitsSnapshot): boolean {
  return rateLimitBuckets(snapshot).some((bucket) => bucket.credits?.unlimited === true);
}

function rateLimitBuckets(snapshot: CodexAccountRateLimitsSnapshot) {
  return snapshot.rateLimitsByLimitId ? Object.values(snapshot.rateLimitsByLimitId) : [snapshot.rateLimits];
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
    costs: sumEstimatedCosts(rows.map((row) => row.estimate)),
    hasBackfilledPricing: rows.some((row) => Boolean(row.estimate.rateSnapshot.backfilledAt)),
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

function subtractBreakdowns(total: TokenUsageBreakdown, baseline: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, total.totalTokens - baseline.totalTokens),
    inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, total.cacheWriteInputTokens - baseline.cacheWriteInputTokens),
    outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - baseline.reasoningOutputTokens),
  };
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
