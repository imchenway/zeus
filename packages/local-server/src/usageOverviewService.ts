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
    const connections = options.modelConnections.listMetadata();
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const official = options.codexUsage.readCachedOfficialUsage();
    const groups = groupRows(allRows, (row) => canonicalUsageProviderId(row.providerId));
    if (official.state === 'available' && !groups.some(([providerId]) => providerId === 'codex')) groups.unshift(['codex', []]);
    const providers = groups
      .map(([providerId, rows]): UsageProviderSummary => {
        const isCodex = providerId === 'codex';
        const sourceId = isCodex ? 'codex' : providerId.startsWith('api:') ? providerId.slice(4) : providerId;
        const connectionName = connectionNames.get(sourceId);
        const connection = connectionsById.get(sourceId);
        const todayRows = rows.filter((row) => row.occurredAt >= startOfLocalDay(readAt).toISOString());
        const sevenDayRows = rows.filter((row) => row.occurredAt >= addDays(startOfLocalDay(readAt), -6).toISOString());
        const today = localDate(readAt);
        const sevenDayStart = localDate(addDays(startOfLocalDay(readAt), -6));
        const accountDays = isCodex ? (official.dailyUsageBuckets?.filter((bucket) => bucket.startDate >= sevenDayStart && bucket.startDate <= today).map((bucket) => ({ date: bucket.startDate, totalTokens: bucket.tokens })) ?? null) : null;
        const latestLocalAt = rows.at(-1)?.occurredAt ?? readAt.toISOString();
        const updatedAt = isCodex && official.fetchedAt && official.fetchedAt > latestLocalAt ? official.fetchedAt : latestLocalAt;
        return {
          providerId,
          sourceId,
          name: isCodex ? 'Codex' : (connectionName ?? sourceId),
          kind: isCodex ? 'subscription' : 'api',
          deleted: !isCodex && !connectionName,
          cacheUsageAvailable: isCodex || connection?.templateId === 'deepseek' || rows.some((row) => row.usage.cachedInputTokens > 0 || row.usage.cacheWriteInputTokens > 0),
          planType: isCodex ? official.planType : null,
          officialState: isCodex ? official.state : null,
          rateLimitWindows: isCodex ? official.rateLimitWindows : [],
          officialCreditBalance: isCodex ? official.creditBalance : null,
          officialCreditsUnlimited: isCodex ? official.creditsUnlimited : false,
          accountTodayTokens: accountDays?.find((day) => day.date === today)?.totalTokens ?? null,
          accountSevenDayTokens: accountDays && accountDays.length > 0 ? accountDays.reduce((sum, day) => sum + day.totalTokens, 0) : null,
          dailyAccount: accountDays,
          todayLocal: aggregateRows(todayRows),
          todayLocalComplete: todayRows.every((row) => row.usageComplete),
          sevenDayLocal: aggregateRows(sevenDayRows),
          sevenDayLocalComplete: sevenDayRows.every((row) => row.usageComplete),
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
      providerCoverage: 'all-recorded',
      updatedAt:
        providers
          .map((provider) => provider.updatedAt)
          .sort()
          .at(-1) ?? readAt.toISOString(),
    };
  }

  return { read };
}

/** 同一个外部模型连接无论由 Pi 还是 App Server 执行，都归并到同一 API 供应源。 */
function canonicalUsageProviderId(providerId: string): string {
  if (providerId.startsWith('pi:')) return `api:${providerId.slice(3)}`;
  return providerId;
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
