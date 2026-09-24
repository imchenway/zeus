import {
  calculateCacheHitRate,
  emptyTokenUsageBreakdown,
  sumEstimatedCosts,
  type CodexLocalUsageDay,
  type CodexLocalUsageTotals,
  type CodexUsageRateSnapshot,
  type CodexUsageRange,
  type TokenUsageBreakdown,
  type UsageAnalyticsSnapshot,
  type UsageModelCostBreakdown,
  type UsageModelRate,
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

  /** 仅缓存最近一次概览；实际账本、日期、连接名称或官方快照变化即重算。 */
  let overviewCache: { key: string; snapshot: UsageOverviewSnapshot } | undefined;

  /** 被动读取不刷新官方账户；仅汇总最近七天记录与数据库返回的历史边界。 */
  async function read(): Promise<UsageOverviewSnapshot> {
    const official = options.codexUsage.readCachedOfficialUsage();
    const readAt = now();
    const connections = options.modelConnections.listMetadata();
    const revision = options.ledger.readRevision();
    const key = JSON.stringify([revision, localDate(readAt), readAt.getTimezoneOffset(), connections, official]);
    if (revision !== null && overviewCache?.key === key) return { ...overviewCache.snapshot, updatedAt: readAt.toISOString() };
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    const groups = new Map(groupRows(options.ledger.list({ since: addDays(startOfLocalDay(readAt), -6).toISOString() }), (row) => canonicalUsageProviderId(row.providerId)));
    const history = options.ledger.listOverviewProviders();
    const providerIds = new Set([...(official.state === 'available' && !history.some((entry) => entry.providerId === 'codex') ? ['codex'] : []), ...history.map((entry) => entry.providerId)]);
    const providers = [...providerIds]
      .map((providerId) => {
        const provider = buildProviderSummary({ providerId, rows: groups.get(providerId) ?? [], readAt, official, connectionNames, connectionsById });
        const bounds = history.find((entry) => entry.providerId === providerId);
        if (bounds) {
          provider.collectionStartedAt = bounds.firstAt;
          provider.cacheUsageAvailable ||= bounds.hasCache === 1;
          provider.updatedAt = providerId === 'codex' && official.fetchedAt && official.fetchedAt > bounds.lastAt ? official.fetchedAt : bounds.lastAt;
        }
        return provider;
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const snapshot: UsageOverviewSnapshot = { providers, providerCoverage: 'all-recorded', updatedAt: readAt.toISOString() };
    overviewCache = revision === null ? undefined : { key, snapshot };
    return snapshot;
  }

  async function readAnalytics(input: Parameters<UsageOverviewService['readAnalytics']>[0]): Promise<UsageAnalyticsSnapshot> {
    const readAt = now();
    const official = options.codexUsage.readCachedOfficialUsage();
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
    todayCostBreakdown: aggregateCostBreakdown(todayRows),
    todayLocalComplete: todayRows.every((row) => row.usageComplete),
    sevenDayLocal: aggregateRows(sevenDayRows),
    sevenDayCostBreakdown: aggregateCostBreakdown(sevenDayRows),
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

/** 按真实请求的模型和价格快照归组，避免用最后一次单价解释整段历史。 */
function aggregateCostBreakdown(rows: readonly CodexUsageLedgerRecord[]): UsageModelCostBreakdown[] {
  /** JSON 键只用于同一次聚合内识别完全相同的模型与费率。 */
  const groups = new Map<string, UsageModelCostBreakdown>();
  for (const row of rows) {
    /** 新账本优先使用请求级快照；旧账本仍以整轮快照展示真实已知信息。 */
    const requests = row.estimate.requests?.length
      ? row.estimate.requests.map((request) => ({ model: request.estimate.rateSnapshot.model || row.model, usage: request.usage, rateSnapshot: request.estimate.rateSnapshot }))
      : [{ model: row.estimate.rateSnapshot.model || row.model, usage: row.usage, rateSnapshot: row.estimate.rateSnapshot }];
    for (const request of requests) {
      /** 标准价格与历史 Codex 美元费率统一成前端只读结构。 */
      const rate = usageModelRate(request.rateSnapshot);
      const key = JSON.stringify([request.model, rate]);
      const existing = groups.get(key);
      if (existing) {
        existing.usage = sumBreakdowns([existing.usage, request.usage]);
      } else {
        groups.set(key, { model: request.model, rate, usage: { ...request.usage } });
      }
    }
  }
  return [...groups.values()].sort((left, right) => left.model.localeCompare(right.model));
}

/** 把各供应商费率投影为同一展示口径，缺价继续保持未知。 */
function usageModelRate(snapshot: CodexUsageRateSnapshot): UsageModelRate | null {
  if (snapshot.price) return { currency: snapshot.price.currency, perMillion: snapshot.price.perMillion, perRequest: snapshot.price.perRequest };
  if (snapshot.usdPerMillion) {
    return {
      currency: 'USD',
      perMillion: {
        input: snapshot.usdPerMillion.input,
        output: snapshot.usdPerMillion.output,
        cachedInput: snapshot.usdPerMillion.cachedInput,
        cacheWrite: snapshot.usdPerMillion.cacheWrite,
      },
      perRequest: null,
    };
  }
  if (snapshot.creditsPerMillion) {
    return {
      currency: 'Credits',
      perMillion: {
        input: snapshot.creditsPerMillion.input,
        output: snapshot.creditsPerMillion.output,
        cachedInput: snapshot.creditsPerMillion.cachedInput,
        cacheWrite: snapshot.creditsPerMillion.cacheWrite,
      },
      perRequest: null,
    };
  }
  return null;
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
