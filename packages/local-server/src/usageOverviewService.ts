import { calculateCacheHitRate, emptyTokenUsageBreakdown, type CodexLocalUsageDay, type CodexLocalUsageTotals, type TokenUsageBreakdown, type UsageOverviewSnapshot, type UsageProviderSummary } from '@zeus/shared';
import { type CodexUsageLedgerRecord, CodexUsageLedgerRepository } from '@zeus/storage';
import type { CodexUsageService } from './codexUsageService.js';
import type { ModelConnectionService } from './modelConnectionService.js';

interface CreateUsageOverviewServiceOptions {
  ledger: CodexUsageLedgerRepository;
  codexUsage: CodexUsageService;
  modelConnections: ModelConnectionService;
  now?: () => Date;
}

export interface UsageOverviewService {
  read(): Promise<UsageOverviewSnapshot>;
}

/** 菜单栏只聚合 Zeus 实际记录到的供应源，不把不同计费口径强行相加。 */
export function createUsageOverviewService(options: CreateUsageOverviewServiceOptions): UsageOverviewService {
  const now = options.now ?? (() => new Date());

  async function read(): Promise<UsageOverviewSnapshot> {
    const readAt = now();
    const allRows = options.ledger.list();
    const connections = await options.modelConnections.list();
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
    const official = options.codexUsage.readCachedOfficialUsage();
    const groups = groupRows(allRows, (row) => row.providerId);
    const providers = groups
      .map(([providerId, rows]): UsageProviderSummary => {
        const isCodex = providerId === 'codex';
        const sourceId = isCodex ? 'codex' : providerId.startsWith('pi:') ? providerId.slice(3) : providerId;
        const connectionName = connectionNames.get(sourceId);
        const todayRows = rows.filter((row) => row.occurredAt >= startOfLocalDay(readAt).toISOString());
        const sevenDayRows = rows.filter((row) => row.occurredAt >= addDays(startOfLocalDay(readAt), -6).toISOString());
        const latestLocalAt = rows.at(-1)?.occurredAt ?? readAt.toISOString();
        const updatedAt = isCodex && official.fetchedAt && official.fetchedAt > latestLocalAt ? official.fetchedAt : latestLocalAt;
        return {
          providerId,
          sourceId,
          name: isCodex ? 'Codex' : (connectionName ?? '已删除供应源'),
          kind: isCodex ? 'subscription' : 'api',
          deleted: !isCodex && !connectionName,
          planType: isCodex ? official.planType : null,
          officialState: isCodex ? official.state : null,
          rateLimitWindows: isCodex ? official.rateLimitWindows : [],
          officialCreditBalance: isCodex ? official.creditBalance : null,
          officialCreditsUnlimited: isCodex ? official.creditsUnlimited : false,
          todayLocal: aggregateRows(todayRows),
          sevenDayLocal: aggregateRows(sevenDayRows),
          dailyLocal: groupRows(sevenDayRows, (row) => localDate(new Date(row.occurredAt))).map(([date, entries]) => ({ date, ...aggregateRows(entries) })) satisfies CodexLocalUsageDay[],
          collectionStartedAt: rows[0]?.occurredAt ?? null,
          updatedAt,
          stale: isCodex ? official.stale : false,
          error: isCodex ? official.error : null,
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return {
      providers,
      updatedAt:
        providers
          .map((provider) => provider.updatedAt)
          .sort()
          .at(-1) ?? readAt.toISOString(),
    };
  }

  return { read };
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
  return [...groups.entries()];
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
