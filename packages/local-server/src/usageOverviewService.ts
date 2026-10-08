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
  type UsageModelPricePeriod,
  type UsageModelRate,
  type UsageOverviewSnapshot,
  type UsageOverviewRangeSummary,
  type UsageProviderAnalytics,
  type UsageProviderSummary,
} from '@zeus/shared';
import { type CodexUsageLedgerRecord, CodexUsageLedgerRepository, type ConversationOutputRateMeasurement, type ConversationExecutionRepository, ConversationRepository, ProjectRepository } from '@zeus/storage';
import type { CodexUsageService } from './codexUsageService.js';
import type { ModelConnectionService } from './modelConnectionService.js';

interface CreateUsageOverviewServiceOptions {
  ledger: CodexUsageLedgerRepository;
  codexUsage: CodexUsageService;
  modelConnections: ModelConnectionService;
  projects: ProjectRepository;
  conversations: ConversationRepository;
  execution: ConversationExecutionRepository;
  now?: () => Date;
}

/** 同一原生轮次内所有可测速文本请求的加权计算依据。 */
interface OutputRateTotals {
  /** 可见输出 Token 总量。 */
  visibleOutputTokens: number;
  /** 文本生成时长总和。 */
  durationMs: number;
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

  /** 被动读取不刷新官方账户；汇总快捷时间范围与数据库返回的历史边界。 */
  async function read(): Promise<UsageOverviewSnapshot> {
    const official = options.codexUsage.readCachedOfficialUsage();
    const readAt = now();
    const connections = options.modelConnections.listMetadata();
    const revision = options.ledger.readRevision();
    /** 请求计时不属于费用账本修订，必须纳入缓存身份才能及时显示新速率。 */
    const outputMeasurements = options.execution.listOutputRateMeasurements();
    const key = JSON.stringify([revision, localDate(readAt), readAt.getTimezoneOffset(), connections, official, outputMeasurements]);
    if (revision !== null && overviewCache?.key === key) return { ...overviewCache.snapshot, updatedAt: readAt.toISOString() };
    const outputRateByTurn = indexOutputRateMeasurements(outputMeasurements);
    const connectionNames = new Map(connections.map((connection) => [connection.id, connection.name]));
    const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
    /** 快捷时间范围和价格周期都基于完整账本，返回值只包含轻量汇总。 */
    const allRows = options.ledger.list();
    /** 每个供应源只分组一次，具体时间范围在汇总阶段裁剪。 */
    const groups = new Map(groupRows(allRows, (row) => canonicalUsageProviderId(row.providerId)));
    const history = options.ledger.listOverviewProviders();
    const providerIds = new Set([...(official.state === 'available' && !history.some((entry) => entry.providerId === 'codex') ? ['codex'] : []), ...history.map((entry) => entry.providerId)]);
    const providers = [...providerIds]
      .map((providerId) => {
        const provider = buildProviderSummary({ providerId, rows: groups.get(providerId) ?? [], outputRateByTurn, readAt, official, connectionNames, connectionsById });
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
    const outputRateByTurn = indexOutputRateMeasurements(options.execution.listOutputRateMeasurements());
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
        const provider = buildProviderSummary({ providerId, rows, outputRateByTurn, readAt, official, connectionNames, connectionsById });
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
            totals: aggregateRows(filteredRows, outputRateByTurn),
            daily: groupRows(filteredRows, (row) => localDate(new Date(row.occurredAt))).map(([date, entries]) => ({ date, ...aggregateRows(entries, outputRateByTurn) })),
            byModel: groupRows(filteredRows, (row) => row.model).map(([model, entries]) => ({ id: model, label: model, deleted: false, ...aggregateRows(entries, outputRateByTurn) })),
            byProject: groupRows(filteredRows, (row) => row.projectId).map(([projectId, entries]) => {
              const project = options.projects.getById(projectId);
              return { id: projectId, label: project?.name ?? '已删除项目', deleted: !project, ...aggregateRows(entries, outputRateByTurn) };
            }),
            byConversation: groupRows(filteredRows, (row) => row.conversationId).map(([conversationId, entries]) => {
              const conversation = options.conversations.getRecordById(conversationId);
              return { id: conversationId, label: conversation?.title || '已删除会话', deleted: !conversation, ...aggregateRows(entries, outputRateByTurn) };
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
  /** 所有可测速请求按原生轮次归并后的计算依据。 */
  outputRateByTurn: ReadonlyMap<string, OutputRateTotals>;
  readAt: Date;
  official: Awaited<ReturnType<CodexUsageService['refreshOfficialUsage']>>;
  connectionNames: Map<string, string>;
  connectionsById: Map<string, ReturnType<ModelConnectionService['listMetadata']>[number]>;
}): UsageProviderSummary {
  const { providerId, rows, outputRateByTurn, readAt, official, connectionNames, connectionsById } = input;
  const isCodex = providerId === 'codex';
  const sourceId = isCodex ? 'codex' : providerId.startsWith('api:') ? providerId.slice(4) : providerId;
  const connectionName = connectionNames.get(sourceId);
  const connection = connectionsById.get(sourceId);
  const todayRows = rows.filter((row) => row.occurredAt >= startOfLocalDay(readAt).toISOString());
  const sevenDayRows = rows.filter((row) => row.occurredAt >= addDays(startOfLocalDay(readAt), -6).toISOString());
  const thirtyDayRows = rows.filter((row) => row.occurredAt >= addDays(startOfLocalDay(readAt), -29).toISOString());
  const today = localDate(readAt);
  const sevenDayStart = localDate(addDays(startOfLocalDay(readAt), -6));
  /** 价格周期必须参考该供应源的全部账本目录，不能只看今日或近七日窗口。 */
  const pricePeriods = buildUsagePricePeriods(rows);
  /** 四个快捷范围共享同一聚合入口，避免 Renderer 自行重算账本口径。 */
  const overviewRanges = {
    today: buildOverviewRangeSummary(todayRows, pricePeriods, outputRateByTurn),
    '7d': buildOverviewRangeSummary(sevenDayRows, pricePeriods, outputRateByTurn),
    '30d': buildOverviewRangeSummary(thirtyDayRows, pricePeriods, outputRateByTurn),
    all: buildOverviewRangeSummary(rows, pricePeriods, outputRateByTurn),
  };
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
    overviewRanges,
    dailyLocal: groupRows(sevenDayRows, (row) => localDate(new Date(row.occurredAt))).map(([date, entries]) => ({ date, ...aggregateRows(entries, outputRateByTurn) })) satisfies CodexLocalUsageDay[],
    collectionStartedAt: rows[0]?.occurredAt ?? null,
    updatedAt: isCodex && official.fetchedAt && official.fetchedAt > latestLocalAt ? official.fetchedAt : latestLocalAt,
    stale: isCodex ? official.stale : false,
    error: isCodex ? official.error : null,
  };
}

/** 统一构造菜单栏单个时间范围的指标与费用明细。 */
function buildOverviewRangeSummary(rows: readonly CodexUsageLedgerRecord[], pricePeriods: ReadonlyMap<string, UsageModelPricePeriod>, outputRateByTurn: ReadonlyMap<string, OutputRateTotals>): UsageOverviewRangeSummary {
  return {
    local: aggregateRows(rows, outputRateByTurn),
    costBreakdown: aggregateCostBreakdown(rows, pricePeriods),
    complete: rows.every((row) => row.usageComplete),
  };
}

/** 同一个外部模型连接无论由 Pi 还是 App Server 执行，都归并到同一 API 供应源。 */
function canonicalUsageProviderId(providerId: string): string {
  if (providerId.startsWith('pi:')) return `api:${providerId.slice(3)}`;
  return providerId;
}

/** 用产品会话、原生线程和轮次组成稳定键，避免不同供应源的同名轮次串数据。 */
function outputRateKey(conversationId: string, providerThreadId: string, providerTurnId: string): string {
  return JSON.stringify([conversationId, providerThreadId, providerTurnId]);
}

/** 同一轮可能包含工具前后多次文本请求；先归并依据，再由时间范围选择对应轮次。 */
function indexOutputRateMeasurements(measurements: readonly ConversationOutputRateMeasurement[]): ReadonlyMap<string, OutputRateTotals> {
  const result = new Map<string, OutputRateTotals>();
  for (const measurement of measurements) {
    const key = outputRateKey(measurement.conversationId, measurement.providerThreadId, measurement.providerTurnId);
    const totals = result.get(key) ?? { visibleOutputTokens: 0, durationMs: 0 };
    totals.visibleOutputTokens += measurement.visibleOutputTokens;
    totals.durationMs += measurement.durationMs;
    result.set(key, totals);
  }
  return result;
}

/** 汇总选中账本记录；请求速率按可见 Token 和真实文本生成时长加权。 */
function aggregateRows(rows: readonly CodexUsageLedgerRecord[], outputRateByTurn: ReadonlyMap<string, OutputRateTotals>): CodexLocalUsageTotals {
  const usage = sumBreakdowns(rows.map((row) => row.usage));
  const billableTokens = rows.reduce((sum, row) => sum + row.estimate.billableTokens, 0);
  const pricedTokens = rows.reduce((sum, row) => sum + row.estimate.pricedTokens, 0);
  const creditValues = rows.flatMap((row) => (row.estimate.credits === null ? [] : [row.estimate.credits]));
  const usdValues = rows.flatMap((row) => (row.estimate.apiEquivalentUsd === null ? [] : [row.estimate.apiEquivalentUsd]));
  const savingsValues = rows.flatMap((row) => (row.estimate.cacheSavingsUsd === null ? [] : [row.estimate.cacheSavingsUsd]));
  /** 同一范围按总 Token 与总时长加权，不能把长短请求的速率直接求平均。 */
  const outputRateTotals = rows.reduce<OutputRateTotals>(
    (total, row) => {
      const measurement = outputRateByTurn.get(outputRateKey(row.conversationId, row.providerThreadId, row.providerTurnId));
      if (measurement) {
        total.visibleOutputTokens += measurement.visibleOutputTokens;
        total.durationMs += measurement.durationMs;
      }
      return total;
    },
    { visibleOutputTokens: 0, durationMs: 0 },
  );
  return {
    ...usage,
    costs: sumEstimatedCosts(rows.map((row) => row.estimate)),
    hasBackfilledPricing: rows.some((row) => Boolean(row.estimate.rateSnapshot.backfilledAt)),
    conversationCount: new Set(rows.map((row) => row.conversationId)).size,
    turnCount: rows.length,
    cacheHitRate: calculateCacheHitRate(usage),
    outputTokensPerSecond: outputRateTotals.durationMs > 0 ? (outputRateTotals.visibleOutputTokens * 1_000) / outputRateTotals.durationMs : null,
    estimatedCredits: creditValues.length > 0 ? creditValues.reduce((sum, value) => sum + value, 0) : null,
    apiEquivalentUsd: usdValues.length > 0 ? usdValues.reduce((sum, value) => sum + value, 0) : null,
    cacheSavingsUsd: savingsValues.length > 0 ? savingsValues.reduce((sum, value) => sum + value, 0) : null,
    priceCoverage: billableTokens > 0 ? pricedTokens / billableTokens : null,
  };
}

/** 按真实请求的模型、计费档位和价格快照归组；同档同价只保留一行。 */
function aggregateCostBreakdown(rows: readonly CodexUsageLedgerRecord[], pricePeriods: ReadonlyMap<string, UsageModelPricePeriod>): UsageModelCostBreakdown[] {
  /** JSON 键只用于同一次聚合内识别完全相同的模型、档位和费率。 */
  const groups = new Map<string, UsageModelCostBreakdown>();
  for (const row of rows) {
    /** 新账本优先使用请求级快照；旧账本仍以整轮快照展示真实已知信息。 */
    const requests = row.estimate.requests?.length
      ? row.estimate.requests.map((request) => ({ model: request.estimate.rateSnapshot.model || row.model, usage: request.usage, estimate: request.estimate }))
      : [{ model: row.estimate.rateSnapshot.model || row.model, usage: row.usage, estimate: row.estimate }];
    for (const request of requests) {
      /** 档位与费率必须来自同一次请求的不可变快照。 */
      const snapshot = request.estimate.rateSnapshot;
      /** 费用归组与完整账本周期使用同一份档位、条件和单价身份。 */
      const { rate, serviceTier, longContext, groupKey: key, priceKey } = usagePriceIdentity(row.providerId, request.model, snapshot);
      /** 周期来自完整账本，不受当前时间范围是否包含最新目录影响。 */
      const pricePeriod = pricePeriods.get(priceKey) ?? null;
      /** 同档同价维持原有一行展示。 */
      const existing = groups.get(key);
      if (existing) {
        existing.usage = sumBreakdowns([existing.usage, request.usage]);
        existing.estimatedCosts = sumEstimatedCosts([{ costs: existing.estimatedCosts, apiEquivalentUsd: null }, request.estimate]);
        /** 合并行包含无法确定周期的条件时，不用其他条件的日期掩盖未知。 */
        existing.pricePeriod = existing.pricePeriod && pricePeriod ? mergeUsagePricePeriods(existing.pricePeriod, pricePeriod) : null;
      } else {
        groups.set(key, {
          model: request.model,
          rate,
          serviceTier,
          longContext,
          pricePeriod,
          usage: { ...request.usage },
          estimatedCosts: sumEstimatedCosts([request.estimate]),
        });
      }
    }
  }
  /** 最新价格周期优先；缺少周期的历史记录放在最后，再按模型和 Token 稳定排序。 */
  return [...groups.values()].sort((left, right) => (right.pricePeriod?.from ?? '').localeCompare(left.pricePeriod?.from ?? '') || left.model.localeCompare(right.model) || right.usage.totalTokens - left.usage.totalTokens);
}

/** 合并同价记录的首尾周期；同价重新启用时按产品要求仍展示为一个整体跨度。 */
function mergeUsagePricePeriods(current: UsageModelPricePeriod | null, next: UsageModelPricePeriod | null): UsageModelPricePeriod | null {
  if (!current) return next;
  if (!next) return current;
  return {
    from: current.from < next.from ? current.from : next.from,
    to: current.to === null || next.to === null ? null : current.to > next.to ? current.to : next.to,
  };
}

/** 为费用归组与价格周期统一模型、档位、适用条件和完整单价身份。 */
function usagePriceIdentity(providerId: string, model: string, snapshot: CodexUsageRateSnapshot) {
  /** 历史连接别名仍属于同一供应源。 */
  const provider = canonicalUsageProviderId(providerId);
  /** 缺省档位沿用计价器的普通档语义，未知档位保持原值。 */
  const serviceTier =
    provider === 'codex'
      ? snapshot.serviceTier === 'fast' || snapshot.serviceTier === 'priority'
        ? 'fast'
        : snapshot.serviceTier == null || snapshot.serviceTier === 'default' || snapshot.serviceTier === 'standard'
          ? 'standard'
          : snapshot.serviceTier
      : null;
  /** 上下文档位只读取 Codex 请求事实，不从累计 Token 推断。 */
  const longContext = provider === 'codex' && snapshot.longContext;
  /** 单价投影固定字段顺序，目录时间和说明文字不参与价格比较。 */
  const rate = usageModelRate(snapshot);
  /** 输入范围与时段决定 API 价格是否并行适用，不能当作前后调价。 */
  const conditions = snapshot.price;
  /** 时段与星期的顺序不改变价格适用条件。 */
  const windows = conditions?.excludedUtcWindows?.map((window) => JSON.stringify([[...new Set(window.weekdays)].sort((left, right) => left - right), window.startMinute, window.endMinute])).sort() ?? [];
  /** 一条周期链只比较完全相同的计费条件。 */
  const seriesKey = JSON.stringify([provider, model, serviceTier, longContext, conditions?.inputRange ? [conditions.inputRange.minExclusive, conditions.inputRange.maxInclusive] : null, [...new Set(windows)]]);
  return {
    rate,
    serviceTier,
    longContext,
    /** 同档同价保留既有合并展示，不按抓取目录拆行。 */
    groupKey: JSON.stringify([provider, model, rate, serviceTier, longContext]),
    seriesKey,
    /** 价格周期由计费条件和完整单价共同定位。 */
    priceKey: JSON.stringify([seriesKey, rate]),
  };
}

/** 从完整账本识别同条件下的真实单价变化，未记录调价时延续到至今。 */
function buildUsagePricePeriods(rows: readonly CodexUsageLedgerRecord[]): Map<string, UsageModelPricePeriod> {
  /** 每个条件独立保存目录日对应的价格，同价刷新不会形成新的价格周期。 */
  const pricesBySeries = new Map<string, Map<string, string>>();
  /** 日期缺失或同日冲突会使该条件链无法完整排序，不推断其起止日期。 */
  const uncertainSeries = new Set<string>();
  for (const row of rows) {
    /** 新账本逐请求读取真实快照，旧账本继续读取整轮快照。 */
    const snapshots = row.estimate.requests?.length ? row.estimate.requests.map((request) => request.estimate.rateSnapshot) : [row.estimate.rateSnapshot];
    for (const snapshot of snapshots) {
      /** 与可见费用行共用身份，避免不同档位或 API 条件互相截断。 */
      const { rate, seriesKey, priceKey } = usagePriceIdentity(row.providerId, snapshot.model || row.model, snapshot);
      if (!rate) continue;
      /** 抓取日期只作为本地目录顺序，不冒充官方生效时间。 */
      const catalogDate = validCatalogDate(snapshot.catalogDate);
      if (!catalogDate) {
        uncertainSeries.add(seriesKey);
        continue;
      }
      /** 同条件同日最多允许一种完整单价；冲突不按请求到达顺序裁决。 */
      const dates = pricesBySeries.get(seriesKey) ?? new Map<string, string>();
      if (dates.has(catalogDate) && dates.get(catalogDate) !== priceKey) uncertainSeries.add(seriesKey);
      dates.set(catalogDate, priceKey);
      pricesBySeries.set(seriesKey, dates);
    }
  }
  /** 同价跨目录或重新启用时仍归为一行，因此索引保留其完整首尾跨度。 */
  const periods = new Map<string, UsageModelPricePeriod>();
  for (const [seriesKey, dates] of pricesBySeries) {
    if (uncertainSeries.has(seriesKey)) continue;
    /** 只保留真实变价节点，连续相同价格沿用第一次记录日期。 */
    const changes: Array<[string, string]> = [];
    for (const entry of [...dates].sort(([left], [right]) => left.localeCompare(right))) {
      if (changes.at(-1)?.[1] !== entry[1]) changes.push(entry);
    }
    for (const [index, [from, priceKey]] of changes.entries()) {
      /** 闭区间结束于同条件下一次变价的前一天，最后一种价格持续至今。 */
      const next = changes[index + 1]?.[0];
      periods.set(priceKey, { from: periods.get(priceKey)?.from ?? from, to: next ? previousIsoDate(next) : null });
    }
  }
  return periods;
}

/** 只接受规范日历日期，避免把 unavailable 或抓取异常值显示为生效周期。 */
function validCatalogDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const instant = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value ? value : null;
}

/** 相邻目录采用闭区间显示，因此结束日是下一目录开始日的前一天。 */
function previousIsoDate(value: string): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** 把各供应商费率投影为同一展示口径，缺价继续保持未知。 */
function usageModelRate(snapshot: CodexUsageRateSnapshot): UsageModelRate | null {
  if (snapshot.price) {
    /** 条件价格的对象字段顺序可能不同，先投影为固定顺序再比较完整单价。 */
    const { currency, perMillion, perRequest } = snapshot.price;
    return { currency, perMillion: perMillion ? { input: perMillion.input, output: perMillion.output, cachedInput: perMillion.cachedInput, cacheWrite: perMillion.cacheWrite } : null, perRequest };
  }
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
