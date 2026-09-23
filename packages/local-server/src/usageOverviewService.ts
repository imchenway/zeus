import {
  calculateCacheHitRate,
  emptyTokenUsageBreakdown,
  type CodexLocalUsageDay,
  type CodexLocalUsageTotals,
  type CodexUsageRange,
  type TokenUsageBreakdown,
  type UsageAnalyticsSnapshot,
  type UsageOverviewSnapshot,
  type UsageProviderAnalytics,
  type UsageProviderSummary,
} from '@zeus/shared';
import { type CodexUsageLedgerRecord, CodexUsageLedgerRepository, ConversationRepository, ProjectRepository } from '@zeus/storage';
import type { CodexUsageService } from './codexUsageService.js';
import type { ModelConnectionService } from './modelConnectionService.js';

interface CreateUsageOverviewServiceOptions {
  ledger: CodexUsageLedgerRepository;
  codexUsage: CodexUsageService;
  modelConnections: ModelConnectionService;
  projects: ProjectRepository;
  conversations: ConversationRepository;
  now?: () => Date;
}

export interface UsageOverviewService {
  read(): Promise<UsageOverviewSnapshot>;
  readAnalytics(input: { range: CodexUsageRange; projectId?: string | null; model?: string | null }): Promise<UsageAnalyticsSnapshot>;
}

/** 菜单栏只聚合 Zeus 实际记录到的供应源，不把不同计费口径强行相加。 */
export function createUsageOverviewService(options: CreateUsageOverviewServiceOptions): UsageOverviewService {
  const now = options.now ?? (() => new Date());

  /** 官方网络读取最多占用两秒；后台请求继续复用，慢响应不阻塞本地统计。 */
  async function readOfficialUsage(): Promise<Awaited<ReturnType<CodexUsageService['refreshOfficialUsage']>>> {
    /** 超时只结束本次等待，不取消其他读取者共享的官方刷新。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        options.codexUsage.refreshOfficialUsage(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('官方用量仍在刷新')), 2_000);
        }),
      ]);
    } catch (error) {
      return { ...options.codexUsage.readCachedOfficialUsage(), stale: true, error: error instanceof Error ? error.message : '暂时无法刷新官方用量' };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 主动读取时优先更新官方用量，超过等待预算则展示缓存和本地统计。 */
  async function read(): Promise<UsageOverviewSnapshot> {
    /** 官方读取复用现有运行时与请求去重，不会为统计启动新的外部进程。 */
    const official = await readOfficialUsage();
    const readAt = now();
    const allRows = options.ledger.list();
    const connections = options.modelConnections.listMetadata();
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
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
      // 汇总时间记录本次读取，供应源更新时间继续保留原始含义。
      updatedAt: readAt.toISOString(),
    };
  }

  async function readAnalytics(input: Parameters<UsageOverviewService['readAnalytics']>[0]): Promise<UsageAnalyticsSnapshot> {
    const readAt = now();
    const official = await readOfficialUsage();
    const connections = options.modelConnections.listMetadata();
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const allRows = options.ledger.list();
    const groups = new Map<string, CodexUsageLedgerRecord[]>();
    for (const row of allRows) {
      const providerId = canonicalUsageProviderId(row.providerId);
      const entries = groups.get(providerId);
      if (entries) entries.push(row);
      else groups.set(providerId, [row]);
    }
    for (const connection of connections) {
      if (!groups.has(`api:${connection.id}`)) groups.set(`api:${connection.id}`, []);
    }
    if (!groups.has('codex')) groups.set('codex', []);

    const since = rangeStart(input.range, readAt);
    const providers = [...groups.entries()]
      .map(([providerId, rows]): UsageProviderAnalytics => {
        const isCodex = providerId === 'codex';
        const filteredRows = rows.filter((row) => (!since || row.occurredAt >= since) && (!input.projectId || row.projectId === input.projectId) && (!input.model || row.model === input.model));
        const provider = buildProviderSummary({ providerId, rows, readAt, official, connectionNames, connectionsById });
        const pricingRows = filteredRows.length > 0 ? filteredRows : rows;
        const catalogDates = [...new Set(pricingRows.map((row) => row.estimate.rateSnapshot.catalogDate))].sort();
        const sourceUrls = [...new Set(pricingRows.flatMap((row) => row.estimate.rateSnapshot.sourceUrls))];
        return {
          provider,
          range: input.range,
          projectId: input.projectId ?? null,
          model: input.model ?? null,
          official: isCodex ? official : null,
          local: {
            totals: aggregateRows(filteredRows),
            daily: groupRows(filteredRows, (row) => localDate(new Date(row.occurredAt))).map(([date, entries]) => ({ date, ...aggregateRows(entries) })),
            byModel: groupRows(filteredRows, (row) => row.model).map(([model, entries]) => ({ id: model, label: model, deleted: false, ...aggregateRows(entries) })),
            byProject: groupRows(filteredRows, (row) => row.projectId).map(([projectId, entries]) => {
              const project = options.projects.getById(projectId);
              return { id: projectId, label: project?.name ?? '已删除项目', deleted: !project, ...aggregateRows(entries) };
            }),
            byConversation: groupRows(filteredRows, (row) => row.conversationId).map(([conversationId, entries]) => {
              const conversation = options.conversations.getRecordById(conversationId);
              return { id: conversationId, label: conversation?.title || '已删除会话', deleted: !conversation, ...aggregateRows(entries) };
            }),
            collectionStartedAt: rows[0]?.occurredAt ?? null,
          },
          pricing: {
            catalogDate: catalogDates.at(-1) ?? null,
            sourceUrls,
            note: isCodex
              ? 'Credits 与 API 等价美元均为估算，不是实际账单；缺价会自动获取官方价格。' + (filteredRows.some((row) => row.estimate.rateSnapshot.backfilledAt) ? '历史缺价记录按补价时价格估算。' : '')
              : '费用为供应商费率估算；未知模型或未返回费率的轮次不会计入估算。',
          },
        };
      })
      .sort((left, right) => right.provider.updatedAt.localeCompare(left.provider.updatedAt));
    return {
      range: input.range,
      projectId: input.projectId ?? null,
      model: input.model ?? null,
      providers,
      updatedAt: readAt.toISOString(),
    };
  }

  return { read, readAnalytics };
}

function buildProviderSummary(input: {
  providerId: string;
  rows: CodexUsageLedgerRecord[];
  readAt: Date;
  official: Awaited<ReturnType<CodexUsageService['refreshOfficialUsage']>>;
  connectionNames: Map<string, string>;
  connectionsById: Map<string, ReturnType<ModelConnectionService['listMetadata']>[number]>;
}): UsageProviderSummary {
  const { providerId, rows, readAt, official, connectionNames, connectionsById } = input;
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
    updatedAt: isCodex && official.fetchedAt && official.fetchedAt > latestLocalAt ? official.fetchedAt : latestLocalAt,
    stale: isCodex ? official.stale : false,
    error: isCodex ? official.error : null,
  };
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

function groupRows(rows: readonly CodexUsageLedgerRecord[], key: (row: CodexUsageLedgerRecord) => string): Array<[string, CodexUsageLedgerRecord[]]> {
  const groups = new Map<string, CodexUsageLedgerRecord[]>();
  for (const row of rows) {
    /** 原地追加，避免历史记录较多时反复复制整个分组。 */
    const groupKey = key(row);
    const entries = groups.get(groupKey);
    if (entries) entries.push(row);
    else groups.set(groupKey, [row]);
  }
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

function rangeStart(range: CodexUsageRange, readAt: Date): string | null {
  if (range === 'all') return null;
  const days = range === '7d' ? 6 : range === '30d' ? 29 : 89;
  return addDays(startOfLocalDay(readAt), -days).toISOString();
}

function localDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
