import { aggregateRequestPrices, estimateModelPrice, sumEstimatedCosts, type ModelPricingCatalog, type UsageRequestPriceSnapshot } from '@zeus/shared';
import type { ModelConnectionRecord } from '@zeus/ai-runtime';
import type { CodexUsageLedgerRepository, ConversationRepository } from '@zeus/storage';

/** 连接目录更新后只补逐请求缺价，不覆盖已有金额或跨供应商借用费率。 */
export function backfillConnectionPrices(connection: ModelConnectionRecord, catalog: ModelPricingCatalog, options: { ledger: CodexUsageLedgerRepository; conversations: ConversationRepository; now: string }): string[] {
  /** 两种执行入口保留自己的账本身份，按同一连接目录计价。 */
  const providers = [`api:${connection.id}`, `pi:${connection.id}`];
  /** 仅更新发生补价的会话投影。 */
  const affected = new Map<string, UsageRequestPriceSnapshot[]>();
  for (const providerId of providers)
    for (const row of options.ledger.list({ providerId })) {
      if (!row.estimate.requests?.length) continue;
      /** 旧整轮金额与明细不一致时，保留整轮原账。 */
      const previous = aggregateRequestPrices(row.estimate.requests);
      if (previous.apiEquivalentUsd !== row.estimate.apiEquivalentUsd || previous.credits !== row.estimate.credits || JSON.stringify(previous.costs) !== JSON.stringify(sumEstimatedCosts([row.estimate]))) continue;
      /** 只收集此次补出的金额，避免以账本重建历史会话金额。 */
      const additions: UsageRequestPriceSnapshot[] = [];
      const requests = row.estimate.requests.map((request) => {
        if (request.estimate.apiEquivalentUsd !== null || request.estimate.costs?.length || request.estimate.credits != null) return request;
        if (request.pricingAccountScope !== connection.pricingCredentialId) return request;
        if (request.estimate.rateSnapshot.sourceUrls.some((url) => url !== catalog.url)) return request;
        const quantities = request.meteredUsage?.quantities ?? [];
        /** 旧账本的空 Token 快照不代表供应商明确返回零。 */
        const source = {
          ...catalog,
          prices: catalog.prices.filter((price) => {
            if (price.metered) return Boolean(request.startedAt) && request.estimate.rateSnapshot.sourceUrls.includes(catalog.url);
            if (price.excludedUtcWindows?.length && !request.startedAt) return false;
            if (price.perRequest !== null) return quantities.some((item) => item.meter === 'requests' && item.unit === 'request' && item.quantity === 1);
            return ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_tokens'].every((meter) => quantities.some((item) => item.meter === meter && item.unit === 'token'));
          }),
        };
        const estimate = estimateModelPrice(request.estimate.rateSnapshot.model, request.usage, source, request.startedAt ?? request.occurredAt, request.meteredUsage, true);
        if (estimate.apiEquivalentUsd === null && !estimate.costs?.length) return request;
        estimate.rateSnapshot.backfilledAt = options.now;
        const priced = { ...request, estimate };
        additions.push(priced);
        return priced;
      });
      if (!additions.length) continue;
      const estimate = aggregateRequestPrices(requests);
      estimate.billableTokens = Math.max(estimate.billableTokens, row.estimate.billableTokens);
      estimate.coverage = estimate.billableTokens ? estimate.pricedTokens / estimate.billableTokens : null;
      options.ledger.upsert({ ...row, estimate });
      affected.set(row.conversationId, [...(affected.get(row.conversationId) ?? []), ...additions]);
    }
  for (const [conversationId, additions] of affected) {
    const previous = options.conversations.getProviderTokenUsageSnapshot(conversationId);
    if (!previous) continue;
    const rows = options.ledger.list({ conversationId });
    const added = aggregateRequestPrices(additions);
    const latest = rows.at(-1)?.estimate.requests?.at(-1);
    const billable = rows.reduce((sum, row) => sum + row.estimate.billableTokens, 0);
    const priced = rows.reduce((sum, row) => sum + row.estimate.pricedTokens, 0);
    options.conversations.repairProviderTokenUsagePricing(conversationId, {
      ...previous,
      costs: sumEstimatedCosts([previous, added]),
      apiEquivalentUsd: added.apiEquivalentUsd === null ? previous.apiEquivalentUsd : (previous.apiEquivalentUsd ?? 0) + added.apiEquivalentUsd,
      lastApiEquivalentUsd: previous.lastApiEquivalentUsd ?? (latest?.estimate.rateSnapshot.backfilledAt === options.now ? latest.estimate.apiEquivalentUsd : null),
      priceCoverage: billable ? priced / billable : null,
      pricingCatalogDate:
        rows
          .map((row) => row.estimate.rateSnapshot.catalogDate)
          .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
          .sort()
          .at(-1) ?? null,
      pricingSourceUrls: [...new Set(rows.flatMap((row) => row.estimate.rateSnapshot.sourceUrls))],
    });
  }
  return [...affected.keys()];
}
