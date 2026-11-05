import { aggregateRequestPrices, estimateModelPrice, type ModelPricingCatalog } from '@zeus/shared';
import type { ModelConnectionRecord } from '@zeus/ai-runtime';
import type { CodexUsageLedgerRepository, ConversationRepository } from '@zeus/storage';

/** 连接目录更新后只补逐请求缺价，不覆盖已有金额或跨供应商借用费率。 */
export function backfillConnectionPrices(connection: ModelConnectionRecord, catalog: ModelPricingCatalog, options: { ledger: CodexUsageLedgerRepository; conversations: ConversationRepository; now: string }): string[] {
  /** 两种执行入口保留自己的账本身份，按同一连接目录计价。 */
  const providers = [`api:${connection.id}`, `pi:${connection.id}`];
  /** 仅更新发生补价的会话投影。 */
  const affected = new Set<string>();
  for (const providerId of providers)
    for (const row of options.ledger.list({ providerId })) {
      if (!row.estimate.requests?.length) continue;
      /** 已有请求数组不原地修改，避免共享运行状态被部分更新。 */
      let changed = false;
      const requests = row.estimate.requests.map((request) => {
        if (request.estimate.apiEquivalentUsd !== null || request.estimate.costs?.length) return request;
        if (request.estimate.rateSnapshot.sourceUrls.some((url) => url !== catalog.url)) return request;
        const estimate = estimateModelPrice(request.estimate.rateSnapshot.model, request.usage, catalog, request.occurredAt);
        if (estimate.apiEquivalentUsd === null && !estimate.costs?.length) return request;
        estimate.rateSnapshot.backfilledAt = options.now;
        changed = true;
        return { ...request, estimate };
      });
      if (!changed) continue;
      const estimate = aggregateRequestPrices(requests);
      estimate.billableTokens = Math.max(estimate.billableTokens, row.estimate.billableTokens);
      estimate.coverage = estimate.billableTokens ? estimate.pricedTokens / estimate.billableTokens : null;
      options.ledger.upsert({ ...row, estimate });
      affected.add(row.conversationId);
    }
  for (const conversationId of affected) {
    const previous = options.conversations.getProviderTokenUsageSnapshot(conversationId);
    if (!previous) continue;
    const rows = options.ledger.list({ conversationId });
    const totals = aggregateRequestPrices(rows.map((row) => ({ id: row.id, occurredAt: row.occurredAt, usage: row.usage, estimate: row.estimate })));
    const latest = rows.at(-1);
    const billable = rows.reduce((sum, row) => sum + row.estimate.billableTokens, 0);
    const priced = rows.reduce((sum, row) => sum + row.estimate.pricedTokens, 0);
    options.conversations.repairProviderTokenUsagePricing(conversationId, {
      ...previous,
      costs: totals.costs,
      estimatedCredits: totals.credits,
      apiEquivalentUsd: totals.apiEquivalentUsd,
      lastApiEquivalentUsd: latest?.estimate.requests?.at(-1)?.estimate.apiEquivalentUsd ?? latest?.estimate.apiEquivalentUsd ?? null,
      cacheSavingsUsd: totals.cacheSavingsUsd,
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
  return [...affected];
}
