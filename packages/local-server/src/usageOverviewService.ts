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
      /** 标准价格与历史 Codex 美元费率统一成前端只读结构。 */
      const rate = usageModelRate(snapshot);
      /** 缺省档位沿用计价器的普通档语义，未知档位保持原值。 */
      const serviceTier =
        row.providerId === 'codex'
          ? snapshot.serviceTier === 'fast' || snapshot.serviceTier === 'priority'
            ? 'fast'
            : snapshot.serviceTier == null || snapshot.serviceTier === 'default' || snapshot.serviceTier === 'standard'
              ? 'standard'
              : snapshot.serviceTier
          : null;
      /** 只展示 Codex 已记录的上下文计价档位。 */
      const longContext = row.providerId === 'codex' && snapshot.longContext;
      /** 目录日期只用于合并可见周期，不参与同档同价身份。 */
      const catalogDate = validCatalogDate(snapshot.catalogDate);
      /** 相同价格的不同档位保持独立，快速档位别名仍合并。 */
      const key = JSON.stringify([request.model, rate, serviceTier, longContext]);
      const pricePeriod = rate && catalogDate ? (pricePeriods.get(pricePeriodKey(request.model, catalogDate)) ?? null) : null;
      const existing = groups.get(key);
      if (existing) {
        existing.usage = sumBreakdowns([existing.usage, request.usage]);
        existing.estimatedCosts = sumEstimatedCosts([{ costs: existing.estimatedCosts, apiEquivalentUsd: null }, request.estimate]);
        existing.pricePeriod = mergeUsagePricePeriods(existing.pricePeriod, pricePeriod);
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

/** 从供应源完整账本建立相邻价格目录周期，最新目录延续到至今。 */
function buildUsagePricePeriods(rows: readonly CodexUsageLedgerRecord[]): Map<string, UsageModelPricePeriod> {
  /** 同一模型可能在一个目录内包含多个档位，它们共享目录周期。 */
  const datesByModel = new Map<string, Set<string>>();
  for (const row of rows) {
    /** 新账本逐请求读取真实快照，旧账本继续读取整轮快照。 */
    const snapshots = row.estimate.requests?.length ? row.estimate.requests.map((request) => request.estimate.rateSnapshot) : [row.estimate.rateSnapshot];
    for (const snapshot of snapshots) {
      /** 缺价和非法日期不参与周期推断。 */
      if (!usageModelRate(snapshot)) continue;
      const catalogDate = validCatalogDate(snapshot.catalogDate);
      if (!catalogDate) continue;
      const model = snapshot.model || row.model;
      const dates = datesByModel.get(model);
      if (dates) dates.add(catalogDate);
      else datesByModel.set(model, new Set([catalogDate]));
    }
  }
  /** 返回值直接以模型和目录日期索引，费用聚合无需重复搜索。 */
  const periods = new Map<string, UsageModelPricePeriod>();
  for (const [model, dateSet] of datesByModel) {
    const dates = [...dateSet].sort();
    for (const [index, from] of dates.entries()) {
      const next = dates[index + 1];
      periods.set(pricePeriodKey(model, from), { from, to: next ? previousIsoDate(next) : null });
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

/** 目录周期索引不使用费率内容，多个并行档位共享同一个时间边界。 */
function pricePeriodKey(model: string, catalogDate: string): string {
  return `${model}\u0000${catalogDate}`;
}

/** 相邻目录采用闭区间显示，因此结束日是下一目录开始日的前一天。 */
function previousIsoDate(value: string): string {
  return new Date(Date.parse(`${value}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
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
