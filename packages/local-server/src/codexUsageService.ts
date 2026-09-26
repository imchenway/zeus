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
  tokenUsageSignature,
  type CodexUsageEstimate,
  type CodexLocalUsageDay,
  type CodexLocalUsageTotals,
  type CodexOfficialUsageSnapshot,
  type CodexUsageAnalyticsSnapshot,
  type CodexUsageRange,
  type CodexUsageSummarySnapshot,
  type NativeTokenUsageSnapshot,
  type TokenUsageBreakdown,
  type UsageRequestPriceSnapshot,
} from '@zeus/shared';
import { conversationModelRequestId, type ConversationExecutionRepository, type CodexUsageLedgerRecord, CodexUsageLedgerRepository, ConversationRepository, ProjectRepository, SettingRepository } from '@zeus/storage';
import { estimatePublishedCodexUsage, fetchPublishedCodexPricing, parsePublishedCodexPrices, type PublishedCodexPricing } from './codexUsagePricing.js';
import { readCodexUsageHistory } from './codexUsageHistory.js';

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
  /** 历史补算读取已绑定原生会话和同轮配置证据，并修复可精确关联的请求费用。 */
  execution?: ConversationExecutionRepository;
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
    /** 兼容通知的累计观察身份；缺省表示真实响应身份。 */
    observationId?: string;
    model: string;
    modelSourceId?: string | null;
    serviceTier?: string | null;
    usage: TokenUsageBreakdown;
    occurredAt: string;
  }): Promise<CodexUsageEstimate & { requestId: string | null }>;
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

/** 仅统一官方已知档位别名，不将未知档位降级为普通价格。 */
function normalizedServiceTier(tier: string | null | undefined): string {
  return tier === 'fast' || tier === 'priority' ? 'priority' : tier == null || tier === 'standard' || tier === 'default' ? 'default' : tier;
}

/** 累计边界逐项核对，不能只凭总 Token 数掩盖缓存或输出分类的重复。 */
function withinBreakdown(value: TokenUsageBreakdown, limit: TokenUsageBreakdown): boolean {
  return (Object.keys(value) as Array<keyof TokenUsageBreakdown>).every((key) => value[key] <= limit[key]);
}

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
    return publishedPricing
      ? (estimatePublishedCodexUsage({ ...input, catalog: publishedPricing, prices: publishedPrices }) ?? estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model, input.serviceTier ?? null)))
      : local;
  }

  /** 两个入口只在互补观察唯一且配置一致时关联；同入口的相同用量不合并。 */
  function appendRequestPrice(requests: UsageRequestPriceSnapshot[], input: Parameters<CodexUsageService['recordRequest']>[0], backfilledAt?: string): { requests: UsageRequestPriceSnapshot[]; request: UsageRequestPriceSnapshot | null } {
    /** 直接身份命中优先，重启后也复用已经固化的记录。 */
    const previous = requests.find((request) => request.id === input.requestId || request.responseId === input.requestId || (input.observationId && request.observationId === input.observationId));
    if (previous) return { requests, request: previous };
    /** 不跨越尚未对齐的另一入口记录猜测请求次序。 */
    const counterparts = requests.filter((request) => (input.observationId ? !request.observationId : Boolean(request.observationId && !request.responseId)));
    /** 关联同时核对完整用量、模型和档位。 */
    const matches = counterparts.filter(
      (request) =>
        tokenUsageSignature(request.usage) === tokenUsageSignature(input.usage) &&
        request.estimate.rateSnapshot.model === input.model &&
        normalizedServiceTier(request.estimate.rateSnapshot.serviceTier) === normalizedServiceTier(input.serviceTier),
    );
    if (counterparts.length && matches.length !== 1) return { requests, request: null };
    /** 只有唯一候选才补充外部身份，不重写已知费用。 */
    const matched = matches[0];
    /** 非原生模型继续由自己的定价入口负责，不能套用 Codex 单价。 */
    const nativeSource = !input.modelSourceId || input.modelSourceId === 'codex';
    /** 缺价时保留服务档位，后续目录更新才能精确补齐。 */
    const estimate = matched?.estimate ?? (nativeSource ? estimateAvailablePrice(input) : estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model, input.serviceTier ?? null)));
    if (!matched && backfilledAt && estimate.apiEquivalentUsd !== null) estimate.rateSnapshot.backfilledAt = backfilledAt;
    /** 内部身份和日期始终采用首次记录，两个外部身份只作关联。 */
    const request = { ...(matched ?? { id: input.requestId, occurredAt: input.occurredAt, usage: input.usage, estimate }), ...(input.observationId ? { observationId: input.observationId } : { responseId: input.requestId }) };
    return { requests: matched ? requests.map((entry) => (entry === matched ? request : entry)) : [...requests, request], request };
  }

  /** 只补请求缺口；异步读取历史后重读账本，避免覆盖实时新记录。 */
  async function backfillAvailablePrices(): Promise<boolean> {
    /** 同一轮补价后只修复一次会话汇总。 */
    const affected = new Set<string>();
    /** ponytail: 每轮补价每线程只扫描一次；历史文件成为瓶颈时再按文件进度缓存。 */
    const histories = new Map<string, ReturnType<typeof readCodexUsageHistory>>();
    for (const candidate of options.ledger.list({ providerId: 'codex' })) {
      if (pricingAbort.signal.aborted) break;
      if (candidate.estimate.apiEquivalentUsd !== null && candidate.estimate.coverage === 1) continue;
      /** 仅在请求数量不足时读取原生历史，纯缺价不重复扫描正文。 */
      let history: Awaited<ReturnType<typeof readCodexUsageHistory>> = [];
      if (candidate.estimate.requests && options.execution && sumBreakdowns(candidate.estimate.requests.map((request) => request.usage)).totalTokens < candidate.usage.totalTokens) {
        /** 文件路径来自已绑定的原生段，不按目录或日期搜索会话。 */
        const segment = options.execution.segmentByNativeSession(candidate.providerThreadId, candidate.conversationId);
        /** 旧会话没有运行段时，只允许线程身份仍一致的已绑定路径。 */
        const conversation = segment?.nativeSessionPath ? undefined : options.conversations.getById(candidate.conversationId);
        /** 原生段拥有自己的线程路径，切换后的当前路径不能用于旧轮次。 */
        const path = segment?.nativeSessionPath ?? (conversation?.providerThreadId === candidate.providerThreadId ? conversation.providerThreadPath : null);
        if (!histories.has(candidate.providerThreadId)) histories.set(candidate.providerThreadId, readCodexUsageHistory(path, candidate.providerThreadId));
        history = await histories.get(candidate.providerThreadId)!;
      }
      if (pricingAbort.signal.aborted) break;
      /** 文件读取期间实时事件可能已补齐这一轮，写入前重新读取。 */
      const row = options.ledger.findByProviderTurn('codex', candidate.providerThreadId, candidate.providerTurnId);
      if (!row) continue;
      /** 最终一次聚合只在请求或价格确实改变后写回。 */
      let estimate = row.estimate;
      if (row.estimate.requests) {
        /** 原数组代表不可变的已有请求价格，恢复过程只替换变更的记录。 */
        let requests = row.estimate.requests;
        /** 同轮唯一的已确认配置只用于原生事件缺失档位的情况。 */
        const context = history.length ? options.execution?.codexTurnPricingContext(row.conversationId, row.providerThreadId, row.providerTurnId) : null;
        for (const entry of history) {
          if (entry.providerTurnId !== row.providerTurnId || !row.providerTotal || !withinBreakdown(entry.total, row.providerTotal) || (row.providerBaseline && entry.total.totalTokens <= row.providerBaseline.totalTokens)) continue;
          if (entry.serviceTier === undefined && (!context || context.model !== entry.model || normalizedServiceTier(context.serviceTier) !== normalizedServiceTier(row.serviceTier))) continue;
          /** 单笔缺失事实只能来自原生 last 记录和对应轮次配置。 */
          const restored = appendRequestPrice(
            requests,
            {
              projectId: row.projectId,
              conversationId: row.conversationId,
              providerThreadId: row.providerThreadId,
              providerTurnId: row.providerTurnId,
              requestId: entry.observationId,
              observationId: entry.observationId,
              model: entry.model,
              serviceTier: entry.serviceTier === undefined ? context!.serviceTier : entry.serviceTier,
              usage: entry.usage,
              occurredAt: entry.occurredAt,
            },
            now(),
          );
          /** 恢复后的每项用量不得超出已记录轮次总量，避免重叠记录重复收费。 */
          if (withinBreakdown(sumBreakdowns(restored.requests.map((request) => request.usage)), row.usage)) requests = restored.requests;
        }
        /** 逐请求补价：已有金额永远保留，旧缺价且档位已丢失的记录保持未知。 */
        requests = requests.map((request) => {
          if (request.estimate.apiEquivalentUsd !== null || (!request.observationId && !request.responseId && request.estimate.rateSnapshot.catalogDate === 'unavailable')) return request;
          /** 只使用该请求自己的模型、档位和上下文用量。 */
          const priced = estimateAvailablePrice({ model: request.estimate.rateSnapshot.model, serviceTier: request.estimate.rateSnapshot.serviceTier, usage: request.usage });
          if (priced.apiEquivalentUsd === null) return request;
          priced.rateSnapshot.backfilledAt = now();
          return { ...request, estimate: priced };
        });
        if (requests.length === row.estimate.requests.length && requests.every((request, index) => request === row.estimate.requests![index])) continue;
        estimate = aggregateRequestPrices(requests);
        estimate.billableTokens = Math.max(estimate.billableTokens, row.estimate.billableTokens, row.usage.inputTokens + row.usage.outputTokens);
        estimate.coverage = estimate.billableTokens ? estimate.pricedTokens / estimate.billableTokens : null;
        for (const request of requests) {
          options.execution?.enrichModelRequest(conversationModelRequestId(row.conversationId, `codex-request:${row.providerThreadId}:${request.id}`), { estimatedUsd: request.estimate.apiEquivalentUsd });
        }
      } else {
        if (row.estimate.apiEquivalentUsd !== null) continue;
        /** 仅保留原有旧账本补价路径，绝不把请求数组展开成整轮计价。 */
        estimate = estimateAvailablePrice({ model: row.model, serviceTier: row.serviceTier, usage: row.usage });
        if (estimate.apiEquivalentUsd === null) continue;
        estimate.rateSnapshot.backfilledAt = now();
      }
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
      let changed = await backfillAvailablePrices();
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
          changed = (await backfillAvailablePrices()) || changed;
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

  /** 两类事件共用一笔价格；只有唯一的互补观察才能关联，歧义不新增费用。 */
  async function recordRequest(input: Parameters<CodexUsageService['recordRequest']>[0]): ReturnType<CodexUsageService['recordRequest']> {
    validateBreakdown(input.usage);
    const providerId = !input.modelSourceId || input.modelSourceId === 'codex' ? 'codex' : `api:${input.modelSourceId}`;
    const existing = options.ledger.findByProviderTurn(providerId, input.providerThreadId, input.providerTurnId);
    /** 旧轮次已有整体快照时保持原样，迟到的单请求事件不能覆盖历史总额。 */
    if (existing && !existing.estimate.requests) return { ...estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model, input.serviceTier ?? null)), requestId: null };
    const requests = existing?.estimate.requests ?? [];
    /** 实时通知与历史恢复使用同一关联规则。 */
    const result = appendRequestPrice(requests, input);
    /** 歧义仅保留轮次累计量，不产生第二笔费用或第二条请求观测。 */
    const request = result.request;
    if (!request) return { ...estimateCodexUsageWithRateSnapshot(input.usage, unavailableRateSnapshot(input.model, input.serviceTier ?? null)), requestId: null };
    if (result.requests === requests) return { ...request.estimate, requestId: request.id };
    /** 关联不改变原始请求顺序或已有价格。 */
    const next = result.requests;
    /** 当次请求自身的估算结果用于请求表，不借用轮次最后一笔费用。 */
    const estimate = request.estimate;
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
      occurredAt: next.length === requests.length && existing ? existing.occurredAt : input.occurredAt,
    });
    repairConversationUsageSnapshot(input.conversationId);
    await options.persist?.();
    schedulePricingRefresh();
    return { ...estimate, requestId: request.id };
  }

  async function recordTurn(input: Parameters<CodexUsageService['recordTurn']>[0]): Promise<NativeTokenUsageSnapshot> {
    validateBreakdown(input.total);
    validateBreakdown(input.last);
    const nativeCodexSource = !input.modelSourceId || input.modelSourceId === 'codex';
    const providerId = nativeCodexSource ? 'codex' : `api:${input.modelSourceId}`;
    /** 账户读取完成后再读取可变账本，避免后台补价期间覆盖新快照。 */
    let accountScopeId = nativeCodexSource ? 'codex-local' : input.modelSourceId!;
    if (nativeCodexSource) {
      try {
        accountScopeId = (await readAccount()).accountScopeId;
      } catch {
        // 离线轮次仍进入本机账本，不伪装成官方账户统计。
      }
    }
    const existing = options.ledger.findByProviderTurn(providerId, input.providerThreadId, input.providerTurnId);
    const threadRows = options.ledger.list({ providerId, providerThreadId: input.providerThreadId });
    /** 乱序或跨重启重放的旧累计通知不能回退 Token 总量、日期和最近请求。 */
    if (existing?.providerTotal && withinBreakdown(input.total, existing.providerTotal)) {
      input = { ...input, total: existing.providerTotal, last: existing.estimate.requests?.at(-1)?.usage ?? input.last, model: existing.model, serviceTier: existing.serviceTier, occurredAt: existing.occurredAt };
    }
    const priorProviderTotal = threadRows
      .filter((row) => row.providerTurnId !== input.providerTurnId && row.providerTotal && row.providerTotal.totalTokens <= input.total.totalTokens)
      .sort((left, right) => (right.providerTotal?.totalTokens ?? 0) - (left.providerTotal?.totalTokens ?? 0))[0]?.providerTotal;
    const previousSnapshot = options.conversations.getProviderTokenUsageSnapshot(input.conversationId);
    const previousSnapshotTotal = previousSnapshot?.total && previousSnapshot.total.totalTokens < input.total.totalTokens ? previousSnapshot.total : null;
    const legacyRowsExist = threadRows.some((row) => row.providerTurnId !== input.providerTurnId && !row.providerTotal);
    const providerBaseline =
      existing?.providerBaseline ??
      priorProviderTotal ??
      previousSnapshotTotal ??
      (existing?.providerTotal ? subtractBreakdowns(input.total, existing.usage) : legacyRowsExist ? subtractBreakdowns(input.total, input.last) : emptyTokenUsageBreakdown());
    const usage = subtractBreakdowns(input.total, providerBaseline);
    const usageComplete = existing?.providerBaseline ? existing.usageComplete : Boolean(priorProviderTotal || previousSnapshotTotal || (!existing?.providerTotal && !legacyRowsExist));
    /** 累计通知不重算已完成请求；未观测到请求的剩余用量保持缺价。 */
    const estimate = existing && !existing.estimate.requests ? { ...existing.estimate } : aggregateRequestPrices(existing?.estimate.requests ?? []);
    estimate.billableTokens = Math.max(estimate.billableTokens, usage.inputTokens + usage.outputTokens);
    estimate.coverage = estimate.billableTokens ? estimate.pricedTokens / estimate.billableTokens : null;
    if (nativeCodexSource && existing && existing.estimate.apiEquivalentUsd === null && estimate.apiEquivalentUsd !== null) estimate.rateSnapshot.backfilledAt = now();
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
