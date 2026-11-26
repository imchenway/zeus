import { codexPricingUrl } from './codexUsagePricing.js';
import {
  calculateCacheHitRate,
  emptyTokenUsageBreakdown,
  normalizeCodexPricingServiceTier,
  sumEstimatedCosts,
  type CodexLocalUsageDay,
  type CodexLocalUsageTotals,
  type CodexUsageRateSnapshot,
  type CodexUsageRange,
  type TokenUsageBreakdown,
  type UsageAnalyticsSnapshot,
  type UsageModelCostBreakdown,
  type UsageModelOutputRateBreakdown,
  type UsageModelPricePeriod,
  type UsageModelRate,
  type UsageOverviewSnapshot,
  type UsageOverviewRangeSummary,
  type UsageProviderAnalytics,
  type UsageProviderSummary,
  type KiloAccountUsage,
} from '@zeus/shared';
import {
  conversationModelRequestId,
  type CodexUsageLedgerRecord,
  CodexUsageLedgerRepository,
  type ConversationOutputRateMeasurement,
  type ConversationExecutionRepository,
  type ConversationUsageWriteFailure,
  ConversationRepository,
  ProjectRepository,
} from '@zeus/storage';
import type { CodexUsageService } from './codexUsageService.js';
import type { ModelConnectionService } from './modelConnectionService.js';
import type { AgentRuntimeRegistry, AgentRuntimeUsageProvider } from '@zeus/ai-runtime';

interface CreateUsageOverviewServiceOptions {
  ledger: CodexUsageLedgerRepository;
  /** 供应商名称和账号状态来自托管运行时注册。 */
  agentRuntimeRegistry: Pick<AgentRuntimeRegistry, 'readUsageProviders'>;
  /** Codex 公开价格的同步状态独立于官方账户额度。 */
  codexPricingStatus: CodexUsageService['pricingStatus'];
  modelConnections: ModelConnectionService;
  projects: ProjectRepository;
  conversations: ConversationRepository;
  execution: ConversationExecutionRepository;
  now?: () => Date;
}

/** 一组可测速文本请求的加权计算依据。 */
interface OutputRateTotals {
  /** 首个可见 Token 之后的生成间隔总数。 */
  outputTokenIntervals: number;
  /** 文本生成时长总和。 */
  durationMs: number;
}

/** 每个原生轮次保留请求级模型身份，供总览和按模型明细共用。 */
type OutputRateIndex = ReadonlyMap<string, readonly ConversationOutputRateMeasurement[]>;

export interface UsageOverviewService {
  read(): Promise<UsageOverviewSnapshot>;
  readAnalytics(input: { range: CodexUsageRange; projectId?: string | null; model?: string | null }): Promise<UsageAnalyticsSnapshot>;
}

/** 菜单栏与用量详情共用原生供应商和当前仍存在的 API 连接。 */
export function createUsageOverviewService(options: CreateUsageOverviewServiceOptions): UsageOverviewService {
  const now = options.now ?? (() => new Date());

  /** 账本、日期、连接或运行时账号状态变化时重算最近一次概览。 */
  let overviewCache: { key: string; snapshot: UsageOverviewSnapshot } | undefined;

  /** API 连接用完整的账本供应商 ID 索引，避免与同名原生账号混用。 */
  const listConnectionsByProviderId = () => new Map(options.modelConnections.listMetadata().map((connection) => [`api:${connection.id}`, connection]));

  /** 用量缺失按账本的供应商身份归组，兼容旧 Pi 连接 ID。 */
  const listUsageFailuresByProvider = () => new Map(groupRows(options.execution.listUsageWriteFailures(), (failure) => canonicalUsageProviderId(failure.providerId)));

  /** 被动读取不刷新官方账户；汇总快捷时间范围与数据库返回的历史边界。 */
  async function read(): Promise<UsageOverviewSnapshot> {
    const nativeProviders = options.agentRuntimeRegistry.readUsageProviders();
    const pricingStatus = options.codexPricingStatus();
    const readAt = now();
    const connections = listConnectionsByProviderId();
    /** 官方 Kilo 快照与本地账本一起参与缓存身份，余额变化无需等待新会话。 */
    const kiloAccounts = new Map([...connections].map(([providerId, connection]) => [providerId, options.modelConnections.kiloUsage.read(connection)]));
    const revision = options.ledger.readRevision();
    /** 写入失败没有账本修订，也要参与概览缓存。 */
    const usageFailures = listUsageFailuresByProvider();
    /** 请求计时不属于费用账本修订，必须纳入缓存身份才能及时显示新速率。 */
    const outputMeasurements = options.execution.listOutputRateMeasurements();
    const key =
      JSON.stringify([...connections.values()].map((connection) => options.modelConnections.pricing.read(connection))) +
      JSON.stringify(pricingStatus) +
      JSON.stringify([revision, localDate(readAt), readAt.getTimezoneOffset(), [...connections], [...nativeProviders], [...kiloAccounts], outputMeasurements, [...usageFailures]]);
    if (revision !== null && overviewCache?.key === key) return { ...overviewCache.snapshot, updatedAt: readAt.toISOString() };
    const outputRateByTurn = indexOutputRateMeasurements(outputMeasurements);
    /** 快捷时间范围和价格周期都基于完整账本，返回值只包含轻量汇总。 */
    const allRows = options.ledger.list();
    /** 每个供应源只分组一次，具体时间范围在汇总阶段裁剪。 */
    const groups = new Map(groupRows(allRows, (row) => canonicalUsageProviderId(row.providerId)));
    const history = options.ledger.listOverviewProviders();
    /** 已就绪的原生账号和有官方余额的连接可在第一条账本记录前显示。 */
    const providerIds = new Set([
      ...[...nativeProviders].flatMap(([providerId, provider]) => (provider.active ? [providerId] : [])),
      ...history.map((entry) => entry.providerId),
      ...usageFailures.keys(),
      ...[...kiloAccounts].flatMap(([providerId, account]) => (account ? [providerId] : [])),
    ]);
    const providers = [...providerIds]
      .map((providerId) => {
        const connection = connections.get(providerId);
        const provider = buildProviderSummary({
          providerId,
          rows: groups.get(providerId) ?? [],
          usageFailures: usageFailures.get(providerId) ?? [],
          outputRateByTurn,
          readAt,
          nativeProvider: nativeProviders.get(providerId),
          connection,
          kiloAccount: kiloAccounts.get(providerId),
        });
        const bounds = history.find((entry) => entry.providerId === providerId);
        if (bounds) {
          provider.collectionStartedAt = bounds.firstAt;
          provider.cacheUsageAvailable ||= bounds.hasCache === 1;
          if (bounds.lastAt > provider.updatedAt) provider.updatedAt = bounds.lastAt;
        }
        const source = providerId === 'codex' ? codexPricingUrl : connection ? options.modelConnections.pricing.source(connection) : null;
        const syncFailed = providerId === 'codex' ? pricingStatus.failed : Boolean(connection && options.modelConnections.pricing.read(connection)?.error);
        for (const range of Object.values(provider.overviewRanges))
          for (const entry of range.costBreakdown) {
            if (!entry.sourceUrls?.length && source) entry.sourceUrls = [source];
            if (!entry.rate || !entry.estimatedCosts.length) entry.missingPriceReason = entry.rate?.charges?.length ? 'missing_usage' : syncFailed ? 'sync_failed' : 'unconfirmed';
          }
        return provider;
      })
      // 移除 API 连接不删除账本，也不影响原生账号的历史用量。
      .filter((provider) => !provider.deleted)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const snapshot: UsageOverviewSnapshot = { providers, providerCoverage: 'all-recorded', updatedAt: readAt.toISOString() };
    overviewCache = revision === null ? undefined : { key, snapshot };
    return snapshot;
  }

  /** 同次读取生成当前供应商的详情和筛选目录，避免前端累积失效选项。 */
  async function readAnalytics(input: Parameters<UsageOverviewService['readAnalytics']>[0]): Promise<UsageAnalyticsSnapshot> {
    const readAt = now();
    const nativeProviders = options.agentRuntimeRegistry.readUsageProviders();
    const pricingStatus = options.codexPricingStatus();
    const connections = listConnectionsByProviderId();
    const allRows = options.ledger.list();
    const outputRateByTurn = indexOutputRateMeasurements(options.execution.listOutputRateMeasurements());
    const groups = new Map(groupRows(allRows, (row) => canonicalUsageProviderId(row.providerId)));
    /** 失败可能发生在供应商的第一笔用量，详情仍须提供其入口。 */
    const usageFailures = listUsageFailuresByProvider();
    for (const providerId of usageFailures.keys()) {
      if (!groups.has(providerId)) groups.set(providerId, []);
    }
    for (const providerId of connections.keys()) {
      if (!groups.has(providerId)) groups.set(providerId, []);
    }
    for (const [providerId, provider] of nativeProviders) {
      if ((provider.active || provider.showInAnalytics) && !groups.has(providerId)) groups.set(providerId, []);
    }

    const since = rangeStart(input.range, readAt);
    const providers = [...groups.entries()]
      .map(([providerId, rows]): UsageProviderAnalytics => {
        const isCodex = providerId === 'codex';
        /** 先按时间裁剪明细；筛选目录独立保留当前供应商的历史选项。 */
        const rangeRows = rows.filter((row) => !since || row.occurredAt >= since);
        /** 明细按项目和模型共同筛选。 */
        const filteredRows = rangeRows.filter((row) => (!input.projectId || row.projectId === input.projectId) && (!input.model || row.model === input.model));
        /** 提示和数据使用同一组筛选，其他模型的失败不影响当前范围。 */
        const providerFailures = usageFailures.get(providerId) ?? [];
        /** 日趋势和完整性摘要使用同一批失败记录。 */
        const filteredFailures = providerFailures.filter((failure) => (!since || failure.occurredAt >= since) && (!input.projectId || failure.projectId === input.projectId) && (!input.model || failure.model === input.model));
        /** 保留仅有失败记录的项目或模型选项，便于核对该范围。 */
        const filterSources = [...rows, ...providerFailures];
        const connection = connections.get(providerId);
        const nativeProvider = nativeProviders.get(providerId);
        const provider = buildProviderSummary({
          providerId,
          rows,
          usageFailures: providerFailures,
          outputRateByTurn,
          readAt,
          nativeProvider,
          connection,
          kiloAccount: connection ? options.modelConnections.kiloUsage.read(connection) : undefined,
        });
        const pricingRows = filteredRows.length > 0 ? filteredRows : rows;
        const catalogDates = [...new Set(pricingRows.map((row) => row.estimate.rateSnapshot.catalogDate))].sort();
        const configuredSource = isCodex ? codexPricingUrl : connection ? options.modelConnections.pricing.source(connection) : null;
        const sourceUrls = [...new Set([...(configuredSource ? [configuredSource] : []), ...pricingRows.flatMap((row) => row.estimate.rateSnapshot.sourceUrls)])];
        return {
          provider,
          range: input.range,
          projectId: input.projectId ?? null,
          model: input.model ?? null,
          official: nativeProvider?.official ?? null,
          filters: {
            models: [...new Set(filterSources.map((row) => row.model))].sort().map((model) => ({ id: model, label: model })),
            projects: [...new Set(filterSources.map((row) => row.projectId))].map((projectId) => ({ id: projectId, label: options.projects.getById(projectId)?.name ?? '已删除项目' })),
          },
          local: {
            totals: aggregateRows(filteredRows, outputRateByTurn),
            complete: filteredRows.every((row) => row.usageComplete) && filteredFailures.length === 0,
            incompleteDates: [...new Set(filteredFailures.map((failure) => localDate(new Date(failure.occurredAt))))],
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
            ...(isCodex ? { sync: pricingStatus } : {}),
            catalogDate: catalogDates.at(-1) ?? null,
            sourceUrls,
            note: isCodex
              ? (pricingStatus.error ? `价格同步未完整完成：${pricingStatus.error}。` : '') +
                'Credits 与 API 等价美元均为估算，不是实际账单；缺价会自动获取官方价格。' +
                (filteredRows.some((row) => row.estimate.rateSnapshot.backfilledAt) ? '历史缺价记录使用已确认的公开费率补算。' : '')
              : '费用为供应商费率估算；未知模型或未返回费率的轮次不会计入估算。',
          },
        };
      })
      // 详情与菜单栏采用相同的 API 连接边界，完整历史仍保存在账本中。
      .filter((analytics) => !analytics.provider.deleted)
      .sort((left, right) => right.local.totals.totalTokens - left.local.totals.totalTokens || left.provider.name.localeCompare(right.provider.name));
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

/** 从运行时或 API 连接解析供应商身份，再汇总它的本地账本。 */
function buildProviderSummary(input: {
  providerId: string;
  rows: CodexUsageLedgerRecord[];
  /** 尚未被同一请求的成功写入补齐的失败。 */
  usageFailures: ConversationUsageWriteFailure[];
  /** 所有可测速请求按原生轮次索引后的请求级证据。 */
  outputRateByTurn: OutputRateIndex;
  readAt: Date;
  /** 注册表提供的原生供应商名称、类型和账户状态。 */
  nativeProvider?: AgentRuntimeUsageProvider;
  /** 对应账本供应商 ID 的现存 API 连接。 */
  connection?: ReturnType<ModelConnectionService['listMetadata']>[number];
  /** Kilo 账户总余额和 Pass 周期额度，不用于改写本地请求费用。 */
  kiloAccount?: KiloAccountUsage;
}): UsageProviderSummary {
  const { providerId, rows, usageFailures, outputRateByTurn, readAt, nativeProvider, connection, kiloAccount } = input;
  const official = nativeProvider?.official;
  /** Pi 连接已归并到 api: 前缀，只有这类记录依赖连接仍然存在。 */
  const isConnection = providerId.startsWith('api:');
  const sourceId = isConnection ? providerId.slice(4) : providerId;
  /** 快捷范围使用本地自然日边界，账本和失败记录共同采用。 */
  const todayBoundary = startOfLocalDay(readAt).toISOString();
  const sevenDayBoundary = addDays(startOfLocalDay(readAt), -6).toISOString();
  const thirtyDayBoundary = addDays(startOfLocalDay(readAt), -29).toISOString();
  const todayRows = rows.filter((row) => row.occurredAt >= todayBoundary);
  const sevenDayRows = rows.filter((row) => row.occurredAt >= sevenDayBoundary);
  const thirtyDayRows = rows.filter((row) => row.occurredAt >= thirtyDayBoundary);
  const today = localDate(readAt);
  const sevenDayStart = localDate(addDays(startOfLocalDay(readAt), -6));
  /** 快捷范围沿用账本时间边界，只标记范围内发生的失败。 */
  const failureTimes = usageFailures.map((failure) => failure.occurredAt);
  /** 本地趋势和范围汇总都将缺报的账本记录和未补齐的写入视为不完整。 */
  const incompleteTimes = [...failureTimes, ...sevenDayRows.filter((row) => !row.usageComplete).map((row) => row.occurredAt)];
  const incompleteLocalDates = [...new Set(incompleteTimes.map((timestamp) => localDate(new Date(timestamp))).filter((date) => date >= sevenDayStart && date <= today))];
  /** 价格周期必须参考该供应源的全部账本目录，不能只看今日或近七日窗口。 */
  const pricePeriods = buildUsagePricePeriods(rows);
  /** 四个快捷范围共享同一聚合入口，避免 Renderer 自行重算账本口径。 */
  const overviewRanges = {
    today: buildOverviewRangeSummary(
      todayRows,
      pricePeriods,
      outputRateByTurn,
      failureTimes.some((at) => at >= todayBoundary),
    ),
    '7d': buildOverviewRangeSummary(
      sevenDayRows,
      pricePeriods,
      outputRateByTurn,
      failureTimes.some((at) => at >= sevenDayBoundary),
    ),
    '30d': buildOverviewRangeSummary(
      thirtyDayRows,
      pricePeriods,
      outputRateByTurn,
      failureTimes.some((at) => at >= thirtyDayBoundary),
    ),
    all: buildOverviewRangeSummary(rows, pricePeriods, outputRateByTurn, usageFailures.length > 0),
  };
  const accountDays = official?.dailyUsageBuckets?.filter((bucket) => bucket.startDate >= sevenDayStart && bucket.startDate <= today).map((bucket) => ({ date: bucket.startDate, totalTokens: bucket.tokens })) ?? null;
  const latestLocalAt = rows.at(-1)?.occurredAt ?? readAt.toISOString();
  return {
    providerId,
    sourceId,
    name: nativeProvider?.name ?? connection?.name ?? sourceId,
    kind: nativeProvider?.kind ?? (kiloAccount?.pass ? 'subscription' : 'api'),
    deleted: isConnection && !connection,
    cacheUsageAvailable: nativeProvider?.cacheUsageAvailable === true || connection?.templateId === 'deepseek' || rows.some((row) => row.usage.cachedInputTokens > 0 || row.usage.cacheWriteInputTokens > 0),
    planType: official?.planType ?? (kiloAccount?.pass ? 'Kilo Pass' : null),
    officialState: official?.state ?? (kiloAccount ? (kiloAccount.checkedAt && !kiloAccount.error ? 'available' : 'unavailable') : null),
    rateLimitWindows: official?.rateLimitWindows ?? [],
    officialCreditBalance: official?.creditBalance ?? null,
    officialCreditsUnlimited: official?.creditsUnlimited ?? false,
    ...(kiloAccount ? { kiloAccount } : {}),
    accountTodayTokens: accountDays?.find((day) => day.date === today)?.totalTokens ?? null,
    accountSevenDayTokens: accountDays && accountDays.length > 0 ? accountDays.reduce((sum, day) => sum + day.totalTokens, 0) : null,
    dailyAccount: accountDays,
    overviewRanges,
    dailyLocal: groupRows(sevenDayRows, (row) => localDate(new Date(row.occurredAt))).map(([date, entries]) => ({ date, ...aggregateRows(entries, outputRateByTurn) })) satisfies CodexLocalUsageDay[],
    incompleteLocalDates,
    collectionStartedAt: rows[0]?.occurredAt ?? null,
    updatedAt: [latestLocalAt, official?.fetchedAt ?? kiloAccount?.checkedAt ?? ''].sort().at(-1)!,
    stale: official?.stale ?? kiloAccount?.stale ?? false,
    error: official?.error ?? kiloAccount?.error ?? null,
  };
}

/** 统一构造菜单栏单个时间范围的指标、费用明细和模型速率明细。 */
function buildOverviewRangeSummary(rows: readonly CodexUsageLedgerRecord[], pricePeriods: ReadonlyMap<string, UsageModelPricePeriod>, outputRateByTurn: OutputRateIndex, hasWriteFailure: boolean): UsageOverviewRangeSummary {
  return {
    local: aggregateRows(rows, outputRateByTurn),
    costBreakdown: aggregateCostBreakdown(rows, pricePeriods),
    outputRateBreakdown: aggregateOutputRateBreakdown(rows, outputRateByTurn),
    complete: !hasWriteFailure && rows.every((row) => row.usageComplete),
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

/** 同一轮可能包含工具前后多次文本请求；保留每个请求，避免丢失真实模型身份。 */
function indexOutputRateMeasurements(measurements: readonly ConversationOutputRateMeasurement[]): OutputRateIndex {
  const result = new Map<string, ConversationOutputRateMeasurement[]>();
  for (const measurement of measurements) {
    const key = outputRateKey(measurement.conversationId, measurement.providerThreadId, measurement.providerTurnId);
    const entries = result.get(key);
    if (entries) entries.push(measurement);
    else result.set(key, [measurement]);
  }
  return result;
}

/** 汇总选中轮次的请求级速率证据。 */
function aggregateOutputRateTotals(rows: readonly CodexUsageLedgerRecord[], outputRateByTurn: OutputRateIndex): OutputRateTotals {
  const totals = { outputTokenIntervals: 0, durationMs: 0 };
  for (const row of rows) {
    for (const measurement of outputRateByTurn.get(outputRateKey(row.conversationId, row.providerThreadId, row.providerTurnId)) ?? []) {
      totals.outputTokenIntervals += measurement.outputTokenIntervals;
      totals.durationMs += measurement.durationMs;
    }
  }
  return totals;
}

/** 按实际模型和请求速度档位汇总生成间隔与时长。 */
function aggregateOutputRateBreakdown(rows: readonly CodexUsageLedgerRecord[], outputRateByTurn: OutputRateIndex): UsageModelOutputRateBreakdown[] {
  /** 每个组合分别累积生成间隔和毫秒数。 */
  const groups = new Map<string, Pick<UsageModelOutputRateBreakdown, 'model' | 'serviceTier'> & OutputRateTotals>();
  for (const row of rows) {
    /** 只处理已匹配到该账本轮次的可测速请求。 */
    const measurements = outputRateByTurn.get(outputRateKey(row.conversationId, row.providerThreadId, row.providerTurnId));
    if (!measurements?.length) continue;
    /** 档位来自同一次请求；轮次级快照可能只记录了最后一笔请求的档位。 */
    const tiersByRequest = new Map<string, string>();
    for (const request of row.estimate.requests ?? []) {
      /** Codex 的空档位表示标准速度；其他供应源的空值没有档位信息。 */
      const tier = request.estimate.rateSnapshot.serviceTier;
      if (tier === undefined || (tier === null && row.providerId !== 'codex')) continue;
      /** 内部观测身份匹配累计用量；真实响应身份匹配旧观测和独立 API 请求。 */
      const normalizedTier = normalizeCodexPricingServiceTier(tier);
      tiersByRequest.set(conversationModelRequestId(row.conversationId, `codex-request:${row.providerThreadId}:${request.id}`), normalizedTier);
      tiersByRequest.set(request.responseId ?? request.id, normalizedTier);
    }
    for (const measurement of measurements) {
      /** 仅按可证明的请求身份关联，未匹配的测速样本归入未知档位。 */
      const serviceTier = tiersByRequest.get(measurement.requestId) ?? (measurement.providerRequestId === null ? null : (tiersByRequest.get(measurement.providerRequestId) ?? null));
      /** 组合键区分同模型的各档位，也保留没有档位证据的样本。 */
      const key = JSON.stringify([measurement.modelId, serviceTier]);
      const totals = groups.get(key) ?? { model: measurement.modelId, serviceTier, outputTokenIntervals: 0, durationMs: 0 };
      totals.outputTokenIntervals += measurement.outputTokenIntervals;
      totals.durationMs += measurement.durationMs;
      groups.set(key, totals);
    }
  }
  return [...groups.values()]
    .map(({ model, serviceTier, outputTokenIntervals, durationMs }) => ({ model, serviceTier, outputTokensPerSecond: (outputTokenIntervals * 1_000) / durationMs }))
    .sort((left, right) => left.model.localeCompare(right.model) || Number(left.serviceTier === null) - Number(right.serviceTier === null) || (left.serviceTier ?? '').localeCompare(right.serviceTier ?? ''));
}

/** 汇总选中账本记录；请求速率按生成间隔和真实文本生成时长加权。 */
function aggregateRows(rows: readonly CodexUsageLedgerRecord[], outputRateByTurn: OutputRateIndex): CodexLocalUsageTotals {
  const usage = sumBreakdowns(rows.map((row) => row.usage));
  const billableTokens = rows.reduce((sum, row) => sum + row.estimate.billableTokens, 0);
  const pricedTokens = rows.reduce((sum, row) => sum + row.estimate.pricedTokens, 0);
  const creditValues = rows.flatMap((row) => (row.estimate.credits === null ? [] : [row.estimate.credits]));
  const usdValues = rows.flatMap((row) => (row.estimate.apiEquivalentUsd === null ? [] : [row.estimate.apiEquivalentUsd]));
  const savingsValues = rows.flatMap((row) => (row.estimate.cacheSavingsUsd === null ? [] : [row.estimate.cacheSavingsUsd]));
  /** 同一范围按总生成间隔与总时长加权，不能把长短请求的速率直接求平均。 */
  const outputRateTotals = aggregateOutputRateTotals(rows, outputRateByTurn);
  return {
    ...usage,
    costs: sumEstimatedCosts(rows.map((row) => row.estimate)),
    hasBackfilledPricing: rows.some((row) => Boolean(row.estimate.rateSnapshot.backfilledAt)),
    conversationCount: new Set(rows.map((row) => row.conversationId)).size,
    turnCount: rows.length,
    cacheHitRate: calculateCacheHitRate(usage),
    outputTokensPerSecond: outputRateTotals.durationMs > 0 ? (outputRateTotals.outputTokenIntervals * 1_000) / outputRateTotals.durationMs : null,
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
        existing.sourceUrls = [...new Set([...(existing.sourceUrls ?? []), ...snapshot.sourceUrls])];
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
          sourceUrls: [...snapshot.sourceUrls],
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
  const metered = conditions?.metered;
  const seriesKey = JSON.stringify([
    provider,
    model,
    serviceTier,
    longContext,
    conditions?.inputRange ? [conditions.inputRange.minExclusive, conditions.inputRange.maxInclusive] : null,
    [...new Set(windows)],
    metered ? [Object.entries(metered.attributes ?? {}).sort(), metered.windows ?? [], metered.charges.map((charge) => [charge.meter, charge.unit, charge.quantityPerPrice, charge.category])] : null,
  ]);
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
    const { currency, perMillion, perRequest, metered } = snapshot.price;
    return {
      currency,
      perMillion: perMillion ? { input: perMillion.input, output: perMillion.output, cachedInput: perMillion.cachedInput, cacheWrite: perMillion.cacheWrite } : null,
      perRequest,
      ...(metered ? { charges: metered.charges } : {}),
    };
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

/** 统计记录与缺失记录沿用同一组分组规则。 */
function groupRows<T>(rows: readonly T[], key: (row: T) => string): Array<[string, T[]]> {
  /** 相同身份追加到既有分组，保持首次出现顺序。 */
  const groups = new Map<string, T[]>();
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
