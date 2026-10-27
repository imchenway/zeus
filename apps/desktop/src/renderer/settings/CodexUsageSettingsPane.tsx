import { formatCodexCredits, formatEstimatedCosts, hasPositiveCodexCredits, isCodexSubscriptionUsage } from '@zeus/shared';
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { calculateUncachedInputTokens, type CodexLocalUsageDay, type CodexLocalUsageGroup, type CodexOfficialUsageSnapshot, type CodexUsageRange, type UsageAnalyticsSnapshot, type UsageProviderAnalytics } from '@zeus/shared';
import { CalendarDotsIcon as CalendarDots } from '@phosphor-icons/react/dist/csr/CalendarDots';
import { GaugeIcon as Gauge } from '@phosphor-icons/react/dist/csr/Gauge';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import { ZeusSelect } from '../ZeusSelect.js';
import { compareModelNames } from '../modelOptionPresentation.js';
import { SettingsPagination, settingsPage, settingsPageSize } from './SettingsPagination.js';

/** 用量详情只依赖统一分析接口。 */
type UsageClient = {
  /** 读取当前供应商的本地明细与独立官方账户快照。 */
  loadUsageAnalytics: (input: { range: CodexUsageRange; projectId?: string; model?: string }) => Promise<UsageAnalyticsSnapshot>;
};

/** 用量页沿用应用语言。 */
type Language = 'zh-CN' | 'en-US';

/** 页面说明统一强调本地统计与官方账户的不同范围。 */
const text = {
  'zh-CN': {
    title: '用量详情',
    official: 'Codex 账户总览',
    officialHelp: '全部 Codex 客户端的官方账户数据，不与 Zeus 本地明细相加。',
    /** 仅解释官方扣费规则，不保证所有限制都能用点数解除。 */
    creditsHelp: '订阅额度用完后，可用点数可按 OpenAI 的规则继续使用；实际扣费和使用限制以官方账户为准。',
    local: '供应商本地使用明细',
    localHelp: '仅统计 Zeus 本地记录；费用由已知模型单价估算，非实际账单。',
    allClients: '全部 Codex 客户端',
    onlyZeus: '仅 Zeus 本地记录',
    allProviders: '全部供应商',
    provider: '供应商',
    subscription: '订阅供应商',
    today: '今日',
    loading: '正在读取用量…',
    unavailable: '不可用',
    signedOut: '尚未登录 Codex ChatGPT 账户。',
    unsupported: '当前登录方式不提供 ChatGPT 官方账户统计；本地 Zeus 明细仍可用。',
    stale: '本次刷新未完成，当前显示上次成功读取的数据。',
    empty: '尚无可展示的用量数据。',
    range: '时间范围',
    project: '项目',
    model: '模型',
    all: '全部',
    refresh: '刷新',
  },
  'en-US': {
    title: 'Usage details',
    official: 'Codex account overview',
    officialHelp: 'Official account data across all Codex clients. It is never added to Zeus-local usage.',
    /** 英文官方点数扣费说明。 */
    creditsHelp: 'After included limits are reached, available credits can extend usage under OpenAI rules. Official account billing and usage limits apply.',
    local: 'Provider-local usage details',
    localHelp: 'Zeus local records only. Costs use known model rates, not actual bills.',
    allClients: 'All Codex clients',
    onlyZeus: 'Zeus local records',
    allProviders: 'All providers',
    provider: 'Provider',
    subscription: 'Subscription provider',
    today: 'Today',
    loading: 'Loading usage…',
    unavailable: 'Unavailable',
    signedOut: 'No Codex ChatGPT account is signed in.',
    unsupported: 'This sign-in method does not provide official ChatGPT account analytics. Zeus-local detail remains available.',
    stale: 'Refresh did not complete. Showing the last successful snapshot.',
    empty: 'No usage data is available yet.',
    range: 'Range',
    project: 'Project',
    model: 'Model',
    all: 'All',
    refresh: 'Refresh',
  },
} as const;

/** 用量读取失败只影响本页；保留旧数据、刷新入口和可主动查看的错误详情。 */
export function CodexUsageSettingsPane(props: { client: UsageClient | null; language: Language; refreshRevision: number }) {
  /** 页面文案使用当前语言。 */
  const copy = text[props.language];
  /** 详情沿用三十天默认范围。 */
  const [range, setRange] = useState<CodexUsageRange>('30d');
  /** 项目与模型共同限制本地统计，官方账户区不受这些条件影响。 */
  const [projectId, setProjectId] = useState('');
  /** 模型选择随供应商和有效目录重置。 */
  const [model, setModel] = useState('');
  /** 快照包含同次读取的明细与筛选目录。 */
  const [snapshot, setSnapshot] = useState<UsageAnalyticsSnapshot | null>(null);
  /** 全部供应商使用比较表，单个供应商使用下钻详情。 */
  const [selectedProviderId, setSelectedProviderId] = useState('all');
  /** 后台读取时保留当前内容。 */
  const [loading, setLoading] = useState(true);
  /** 错误沿用统一错误详情组件。 */
  const [error, setError] = useState<unknown>(null);
  /** 迟到请求不能覆盖较新的筛选结果。 */
  const loadRevision = useRef(0);
  /** 后端是当前供应商目录的权威来源。 */
  const providers = snapshot?.providers ?? [];
  /** 失效选择立即回到全部，不显示已移除连接的占位面板。 */
  const selectedProvider = providers.find((entry) => entry.provider.providerId === selectedProviderId);
  /** 单个供应商只提供自己的项目和模型选项。 */
  const filterProviders = selectedProvider ? [selectedProvider] : providers;
  /** 去重只作用于当前快照，不累积历史选项。 */
  const projects = usageFilterOptions(filterProviders, 'projects');
  /** 模型目录独立于已选项目，允许用户退出组合筛选。 */
  const models = usageFilterOptions(filterProviders, 'models');

  /** 下钻沿用可用筛选，不让同一行进入详情后改变统计范围。 */
  const selectProvider = (providerId: string) => {
    setSelectedProviderId(providerId);
    /** 下钻保留仍适用的条件；切换到不含该选项的供应商时才清除。 */
    const next = providers.find((entry) => entry.provider.providerId === providerId);
    if (next) {
      setProjectId((current) => (next.filters.projects.some((group) => group.id === current) ? current : ''));
      setModel((current) => (next.filters.models.some((group) => group.id === current) ? current : ''));
    }
  };

  /** 同次响应提供稳定选项；失效条件清除后重新读取，不把旧结果标成新范围。 */
  const load = useCallback(async () => {
    /** 本轮请求身份用于处理刷新和快速筛选的竞争。 */
    const revision = ++loadRevision.current;
    if (!props.client) {
      setLoading(false);
      setError(copy.unavailable);
      return;
    }
    setLoading(true);
    try {
      /** 详情查询不需要再请求一次未筛选快照。 */
      const next = await props.client.loadUsageAnalytics({ range, projectId: projectId || undefined, model: model || undefined });
      if (revision !== loadRevision.current) return;
      /** 校验选择时也使用本轮供应商目录，避免删除连接后残留筛选。 */
      const selected = next.providers.find((entry) => entry.provider.providerId === selectedProviderId);
      /** 全部视图允许选择任一当前供应商有记录的模型和项目。 */
      const scope = selected ? [selected] : next.providers;
      /** 已删除供应商的条件一并清除，即使另一供应商使用同名模型。 */
      const selectionRemoved = selectedProviderId !== 'all' && !selected;
      /** 没有记录的失效项目不继续限制页面。 */
      const nextProject = !selectionRemoved && scope.some((entry) => entry.filters.projects.some((group) => group.id === projectId)) ? projectId : '';
      /** 没有记录的失效模型不继续限制页面。 */
      const nextModel = !selectionRemoved && scope.some((entry) => entry.filters.models.some((group) => group.id === model)) ? model : '';
      if (selectionRemoved) setSelectedProviderId('all');
      if (nextProject !== projectId || nextModel !== model) {
        setProjectId(nextProject);
        setModel(nextModel);
        return;
      }
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (revision === loadRevision.current) setError(cause);
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  }, [copy.unavailable, model, projectId, props.client, range, selectedProviderId]);

  useEffect(() => {
    /** 事件驱动的刷新合并为一次，手动刷新仍立即执行。 */
    const timer = window.setTimeout(() => void load(), props.refreshRevision > 0 ? 180 : 0);
    return () => {
      window.clearTimeout(timer);
      loadRevision.current += 1;
    };
  }, [load, props.refreshRevision]);

  return (
    <section className="settings-product-pane codex-usage-settings" aria-label={copy.title}>
      <header className="codex-usage-page-header">
        <span>
          <h2 className="settings-page-title">{copy.title}</h2>
          <small>{snapshot ? formatUpdatedAt(snapshot.updatedAt, props.language) : null}</small>
        </span>
        <Button size="compact" onClick={() => void load()} busy={loading}>
          {loading ? copy.loading : copy.refresh}
        </Button>
      </header>
      {loading && !snapshot ? (
        <p className="codex-usage-state" role="status">
          {copy.loading}
        </p>
      ) : null}
      {error ? (
        <p className="codex-usage-state" role="status">
          {snapshot ? <span>{copy.stale} </span> : null}
          <VisibleApplicationError error={error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {snapshot ? (
        <>
          <div className="codex-usage-filters" aria-label={copy.local}>
            <div>
              <span>{copy.provider}</span>
              <ZeusSelect
                size="regular"
                ariaLabel={copy.provider}
                value={selectedProvider?.provider.providerId ?? 'all'}
                onChange={selectProvider}
                searchable
                options={[{ value: 'all', label: copy.allProviders }, ...providers.map((entry) => ({ value: entry.provider.providerId, label: entry.provider.name }))]}
              />
            </div>
            <div>
              <span>{copy.range}</span>
              <ZeusSelect<CodexUsageRange>
                size="regular"
                ariaLabel={copy.range}
                value={range}
                onChange={setRange}
                options={[
                  { value: '7d', label: props.language === 'zh-CN' ? '近 7 天' : 'Last 7 days' },
                  { value: '30d', label: props.language === 'zh-CN' ? '近 30 天' : 'Last 30 days' },
                  { value: '90d', label: props.language === 'zh-CN' ? '近 90 天' : 'Last 90 days' },
                  { value: 'all', label: copy.all },
                ]}
              />
            </div>
            <div>
              <span>{copy.project}</span>
              <ZeusSelect size="regular" ariaLabel={copy.project} value={projectId} onChange={setProjectId} searchable options={[{ value: '', label: copy.all }, ...projects.map((group) => ({ value: group.id, label: group.label }))]} />
            </div>
            <div>
              <span>{copy.model}</span>
              <ZeusSelect size="regular" ariaLabel={copy.model} value={model} onChange={setModel} searchable options={[{ value: '', label: copy.all }, ...models.map((group) => ({ value: group.id, label: group.label }))]} />
            </div>
          </div>
          <div className="codex-usage-content" aria-busy={loading}>
            {selectedProvider ? (
              <>
                <LocalUsageTabs analytics={selectedProvider} language={props.language} dataKey={`${selectedProvider.provider.providerId}:${range}:${projectId}:${model}`} />
                {selectedProvider.official ? (
                  <details className="codex-usage-account">
                    <summary>
                      <strong>{copy.official}</strong>
                      <span>{copy.allClients}</span>
                    </summary>
                    <p className="codex-usage-note">{copy.officialHelp}</p>
                    <OfficialOverview snapshot={selectedProvider.official} language={props.language} />
                  </details>
                ) : null}
              </>
            ) : (
              <AllProvidersOverview providers={providers} language={props.language} onSelect={selectProvider} filtered={Boolean(projectId || model)} />
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}

/** 供应商使用紧凑行比较；不同供应商的用量和费用不合计。 */
function AllProvidersOverview(props: { providers: UsageProviderAnalytics[]; language: Language; onSelect: (providerId: string) => void; filtered: boolean }) {
  /** 表头和状态沿用当前语言。 */
  const copy = text[props.language];
  if (props.providers.length === 0) return <p className="codex-usage-state">{copy.empty}</p>;
  return (
    <section className="codex-usage-provider-overview" aria-label={copy.allProviders}>
      <div className="codex-usage-table-scroll">
        <table className="codex-usage-provider-table">
          <caption>{props.language === 'zh-CN' ? 'Zeus 本地统计 · 按当前范围 Token 排序' : 'Zeus local usage · ordered by tokens in this range'}</caption>
          <thead>
            <tr>
              <th scope="col">{copy.provider}</th>
              <th scope="col">{props.language === 'zh-CN' ? '当前范围 Token' : 'Range tokens'}</th>
              <th scope="col">{props.language === 'zh-CN' ? '缓存命中率' : 'Cache hit rate'}</th>
              <th scope="col">{props.language === 'zh-CN' ? '输出速率' : 'Output rate'}</th>
              <th scope="col">{props.language === 'zh-CN' ? '费用估算' : 'Estimated cost'}</th>
            </tr>
          </thead>
          <tbody>
            {props.providers.map((analytics) => (
              <tr key={analytics.provider.providerId}>
                <th scope="row">
                  <button type="button" className="codex-usage-provider-open" onClick={() => props.onSelect(analytics.provider.providerId)}>
                    <strong>{analytics.provider.name}</strong>
                    <small>
                      {isCodexSubscriptionUsage(analytics.provider) ? (analytics.provider.planType ?? copy.subscription) : 'API'}
                      <span aria-hidden="true"> →</span>
                    </small>
                  </button>
                </th>
                <td data-label={props.language === 'zh-CN' ? '当前范围 Token' : 'Range tokens'}>
                  <strong>{formatTokens(analytics.local.totals.totalTokens, props.language)}</strong>
                  {!props.filtered ? (
                    <small>
                      {copy.today} {formatTokens(analytics.provider.overviewRanges.today.local.totalTokens, props.language)}
                    </small>
                  ) : null}
                </td>
                <td data-label={props.language === 'zh-CN' ? '缓存命中率' : 'Cache hit rate'}>
                  {analytics.provider.cacheUsageAvailable && analytics.local.totals.cacheHitRate !== null ? formatPercent(analytics.local.totals.cacheHitRate, props.language) : '—'}
                </td>
                <td data-label={props.language === 'zh-CN' ? '输出速率' : 'Output rate'}>{formatOutputRate(analytics.local.totals.outputTokensPerSecond, props.language)}</td>
                <td data-label={usageCostLabel(analytics.provider, props.language)} data-icon-tooltip={formatEstimatedCosts(analytics.local.totals.costs, analytics.local.totals.apiEquivalentUsd)}>
                  <strong>{formatUsageCost(analytics.local.totals, props.language)}</strong>
                  <small>
                    {usageCostLabel(analytics.provider, props.language)}
                    {analytics.local.totals.priceCoverage !== null && analytics.local.totals.priceCoverage < 1 ? ` · ${props.language === 'zh-CN' ? '部分计价' : 'Partial'}` : ''}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="codex-usage-note">
        {props.language === 'zh-CN' ? '费用按已知模型单价估算，非实际账单。不同供应商分别统计；点击名称查看明细。' : 'Costs use known model rates, not actual bills. Providers stay separate. Select a name for details.'}
      </p>
    </section>
  );
}

/** 官方额度和账户趋势独立展开；未知或零点数不再占据统计卡片。 */
function OfficialOverview(props: { snapshot: CodexOfficialUsageSnapshot; language: Language }) {
  /** 官方数据不受本地筛选影响。 */
  const copy = text[props.language];
  if (props.snapshot.state === 'signed_out') return <p className="codex-usage-state">{copy.signedOut}</p>;
  if (props.snapshot.state === 'unsupported') return <p className="codex-usage-state">{copy.unsupported}</p>;
  if (props.snapshot.state === 'unavailable' && !props.snapshot.fetchedAt)
    return (
      <p className="codex-usage-state" role="alert">
        <VisibleApplicationError error={props.snapshot.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
      </p>
    );
  return (
    <>
      {props.snapshot.stale ? <p className="codex-usage-stale">{copy.stale}</p> : null}
      <div className="codex-usage-official-detail-grid">
        <section className="codex-usage-quota-panel" aria-label={props.language === 'zh-CN' ? '额度剩余' : 'Quota remaining'}>
          <header>
            <span>
              <Gauge size={18} weight="regular" aria-hidden="true" />
              <strong>{props.language === 'zh-CN' ? '额度剩余' : 'Quota remaining'}</strong>
            </span>
            <small>{props.snapshot.planType}</small>
          </header>
          {props.snapshot.rateLimitWindows.length > 0 ? (
            <div className="codex-usage-limit-list">
              {props.snapshot.rateLimitWindows.map((window, index) => (
                <div key={`${window.limitId ?? 'limit'}-${window.kind}-${index}`}>
                  <span>
                    <strong>
                      {window.limitName ?? window.limitId ?? 'Codex'} · {formatWindow(window.windowDurationMins, props.language)}
                    </strong>
                    <progress aria-label={`${window.limitName ?? 'Codex'} · ${formatWindow(window.windowDurationMins, props.language)}`} value={Math.max(0, Math.min(100, window.remainingPercent))} max={100} />
                    <small>{window.resetsAt ? formatReset(window.resetsAt, props.language) : null}</small>
                  </span>
                  <b>{formatPercent(window.remainingPercent / 100, props.language)}</b>
                </div>
              ))}
            </div>
          ) : (
            <p className="codex-usage-note">{props.language === 'zh-CN' ? '官方暂未提供额度。' : 'Account limits are not available.'}</p>
          )}
          {props.snapshot.state === 'available' && !props.snapshot.creditsUnlimited && hasPositiveCodexCredits(props.snapshot.creditBalance) ? (
            <p className="codex-usage-note" data-icon-tooltip={copy.creditsHelp}>
              {props.language === 'zh-CN' ? '剩余点数' : 'Remaining credits'} <strong>{formatCodexCredits(props.snapshot.creditBalance, props.language)}</strong>
            </p>
          ) : null}
        </section>
        {props.snapshot.dailyUsageBuckets?.length ? (
          <OfficialUsageCalendar days={props.snapshot.dailyUsageBuckets.map((day) => ({ date: day.startDate, totalTokens: day.tokens }))} label={copy.allClients} language={props.language} />
        ) : (
          <p className="codex-usage-state">{props.language === 'zh-CN' ? '官方暂未提供每日统计。' : 'Daily account statistics are not available.'}</p>
        )}
      </div>
    </>
  );
}

/** 本地用量保留概览与三个独立明细入口。 */
type LocalUsageTab = 'overview' | 'models' | 'projects' | 'conversations';

/** 明细共用筛选快照，供应商切换和条件变化时独立重置分页。 */
function LocalUsageTabs(props: { analytics: UsageProviderAnalytics; language: Language; dataKey: string }) {
  /** 标签与说明使用当前语言。 */
  const copy = text[props.language];
  /** 切换条件时保留正在阅读的明细类型。 */
  const [activeTab, setActiveTab] = useState<LocalUsageTab>('overview');
  /** 每组标签独立生成无障碍关联身份。 */
  const tabGroupId = useId();
  /** 明细类型保持固定顺序。 */
  const tabs: Array<{ id: LocalUsageTab; label: string }> = [
    { id: 'overview', label: props.language === 'zh-CN' ? '概览' : 'Overview' },
    { id: 'models', label: props.language === 'zh-CN' ? '模型明细' : 'Models' },
    { id: 'projects', label: props.language === 'zh-CN' ? '项目明细' : 'Projects' },
    { id: 'conversations', label: props.language === 'zh-CN' ? '会话明细' : 'Conversations' },
  ];
  /** 标签身份与内容面板一一对应。 */
  const tabId = (tab: LocalUsageTab) => `${tabGroupId}-${tab}-tab`;
  /** 内容面板通过标签获得读屏名称。 */
  const panelId = (tab: LocalUsageTab) => `${tabGroupId}-${tab}-panel`;
  /** 空结果在当前标签内说明。 */
  const emptyPanel = <p className="codex-usage-state">{copy.empty}</p>;

  return (
    <section className="codex-usage-section codex-usage-local-tabs">
      <header className="codex-usage-local-tabs-header">
        <strong>{props.analytics.provider.name}</strong>
        <nav className="codex-usage-local-tab-list" role="tablist" aria-label={copy.local} onKeyDown={handleLocalUsageTabKeyDown}>
          {tabs.map((tab) => (
            <button id={tabId(tab.id)} key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} aria-controls={panelId(tab.id)} tabIndex={activeTab === tab.id ? 0 : -1} onClick={() => setActiveTab(tab.id)}>
              {tab.label}
            </button>
          ))}
        </nav>
        <em>{copy.onlyZeus}</em>
      </header>
      <small className="codex-usage-local-help">{copy.localHelp}</small>
      <section id={panelId('overview')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('overview')} tabIndex={0} hidden={activeTab !== 'overview'}>
        <LocalOverview analytics={props.analytics} language={props.language} />
      </section>
      <section id={panelId('models')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('models')} tabIndex={0} hidden={activeTab !== 'models'}>
        {props.analytics.local.byModel.length > 0 ? (
          <UsageBreakdownTable
            key={`${props.dataKey}:models`}
            title={props.language === 'zh-CN' ? '模型明细' : 'Models'}
            rows={props.analytics.local.byModel}
            language={props.language}
            showTitle={false}
            provider={props.analytics.provider}
          />
        ) : (
          emptyPanel
        )}
      </section>
      <section id={panelId('projects')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('projects')} tabIndex={0} hidden={activeTab !== 'projects'}>
        {props.analytics.local.byProject.length > 0 ? (
          <UsageBreakdownTable
            key={`${props.dataKey}:projects`}
            title={props.language === 'zh-CN' ? '项目明细' : 'Projects'}
            rows={props.analytics.local.byProject}
            language={props.language}
            showTitle={false}
            provider={props.analytics.provider}
          />
        ) : (
          emptyPanel
        )}
      </section>
      <section id={panelId('conversations')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('conversations')} tabIndex={0} hidden={activeTab !== 'conversations'}>
        {props.analytics.local.byConversation.length > 0 ? (
          <UsageBreakdownTable
            key={`${props.dataKey}:conversations`}
            title={props.language === 'zh-CN' ? '会话明细' : 'Conversations'}
            rows={props.analytics.local.byConversation}
            language={props.language}
            showTitle={false}
            provider={props.analytics.provider}
          />
        ) : (
          emptyPanel
        )}
      </section>
      <p className="codex-usage-pricing-note">
        {props.analytics.pricing.note}
        {props.analytics.pricing.catalogDate && !['unknown', 'unavailable'].includes(props.analytics.pricing.catalogDate)
          ? ` ${props.language === 'zh-CN' ? '价格来源日期' : 'Price source date'}: ${props.analytics.pricing.catalogDate}`
          : null}
        {props.analytics.pricing.sourceUrls[0] ? (
          <>
            {' · '}
            <a href={props.analytics.pricing.sourceUrls[0]} target="_blank" rel="noreferrer">
              {props.analytics.provider.name}
            </a>
          </>
        ) : null}
      </p>
      {props.analytics.local.collectionStartedAt ? (
        <small>
          {props.language === 'zh-CN' ? '本地采集始于' : 'Local collection started'} {formatDateTime(props.analytics.local.collectionStartedAt, props.language)}
        </small>
      ) : null}
    </section>
  );
}

/** 概览沿用菜单栏四项核心指标，Token 构成按需展开。 */
function LocalOverview(props: { analytics: UsageProviderAnalytics; language: Language }) {
  /** 当前供应商的本地范围汇总。 */
  const { local, provider } = props.analytics;
  /** 指标与详细构成使用同一份汇总。 */
  const totals = local.totals;
  return (
    <>
      <MetricGrid
        language={props.language}
        items={[
          [props.language === 'zh-CN' ? 'Token' : 'Tokens', formatTokens(totals.totalTokens, props.language)],
          [usageCostLabel(provider, props.language), formatUsageCost(totals, props.language)],
          [props.language === 'zh-CN' ? '缓存命中率' : 'Cache hit rate', provider.cacheUsageAvailable && totals.cacheHitRate !== null ? formatPercent(totals.cacheHitRate, props.language) : '—'],
          [props.language === 'zh-CN' ? '请求输出速率' : 'Request output rate', formatOutputRate(totals.outputTokensPerSecond, props.language)],
        ]}
      />
      <p className="codex-usage-note">
        {props.language === 'zh-CN' ? `${totals.turnCount} 轮 · ${totals.conversationCount} 个会话` : `${totals.turnCount} turns · ${totals.conversationCount} conversations`}
        {totals.priceCoverage !== null ? ` · ${props.language === 'zh-CN' ? '计价覆盖率' : 'Price coverage'} ${formatPercent(totals.priceCoverage, props.language)}` : ''}
      </p>
      {totals.turnCount === 0 ? <p className="codex-usage-state">{text[props.language].empty}</p> : <LocalUsageTrend days={local.daily} range={props.analytics.range} label={text[props.language].onlyZeus} language={props.language} />}
      {totals.turnCount > 0 ? (
        <details className="codex-usage-token-detail">
          <summary>{props.language === 'zh-CN' ? 'Token 构成' : 'Token breakdown'}</summary>
          <MetricGrid
            language={props.language}
            items={[
              [props.language === 'zh-CN' ? '输入' : 'Input', formatTokens(totals.inputTokens, props.language)],
              [props.language === 'zh-CN' ? '输出' : 'Output', formatTokens(totals.outputTokens, props.language)],
              [props.language === 'zh-CN' ? '推理输出' : 'Reasoning output', formatTokens(totals.reasoningOutputTokens, props.language)],
              [props.language === 'zh-CN' ? '缓存命中' : 'Cache hits', formatTokens(totals.cachedInputTokens, props.language)],
              [props.language === 'zh-CN' ? '缓存未命中' : 'Cache misses', formatTokens(calculateUncachedInputTokens(totals), props.language)],
              [props.language === 'zh-CN' ? '缓存写入' : 'Cache writes', formatTokens(totals.cacheWriteInputTokens, props.language)],
            ]}
          />
        </details>
      ) : null}
    </>
  );
}

/** 页内标签支持方向键和首尾跳转，保留标准键盘访问。 */
function handleLocalUsageTabKeyDown(event: ReactKeyboardEvent<HTMLElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const currentIndex = tabs.indexOf(document.activeElement as HTMLButtonElement);
  if (currentIndex < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : event.key === 'ArrowRight' ? (currentIndex + 1) % tabs.length : (currentIndex - 1 + tabs.length) % tabs.length;
  tabs[nextIndex]?.focus();
  tabs[nextIndex]?.click();
}

/** 核心指标共用紧凑定义列表，保持数值与标签关联。 */
function MetricGrid(props: { items: Array<[string, string]>; language: Language }) {
  return (
    <dl className="codex-usage-metric-grid">
      {props.items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 官方日历只显示账户按日统计，不制造未提供的缓存和费用字段。 */
function OfficialUsageCalendar(props: { days: Array<Pick<CodexLocalUsageDay, 'date' | 'totalTokens'>>; label: string; language: Language }) {
  const calendar = useMemo(() => buildUsageCalendar(props.days, props.language), [props.days, props.language]);
  const [hover, setHover] = useState<{ day: UsageCalendarCell; left: number; top: number } | null>(null);
  const tooltipId = useId();
  const zh = props.language === 'zh-CN';
  /** 每个日期重新等待，回调读取最新用量数据。 */
  const hoverIntent = useHoverIntent<UsageCalendarCell>((day, element) => show(day, element));
  /** 离开或页面变化同时撤销未显示的详情。 */
  const hide = useCallback(() => {
    hoverIntent.cancel();
    setHover(null);
  }, [hoverIntent]);
  useEffect(() => {
    // 未展开时的滚动取消交给共用控制器；这里只关闭已显示的详情。
    if (!hover) return;
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [hide, hover]);
  const show = (day: UsageCalendarCell, element: HTMLElement) => {
    hoverIntent.cancel();
    if (day.future) return;
    const rect = element.getBoundingClientRect();
    setHover({ day, left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)), top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 310)) });
  };
  const totals = hover ? props.days.filter((day) => day.date === hover.day.date && Number.isFinite(day.totalTokens)) : [];
  /** 账户只提供每日总量，悬浮详情保留有依据的字段。 */
  const rows = hover
    ? [
        [
          zh ? 'Token' : 'Tokens',
          totals.length
            ? formatTokens(
                totals.reduce((sum, day) => sum + Math.max(0, day.totalTokens), 0),
                props.language,
              )
            : zh
              ? '无记录'
              : 'No record',
        ],
        [zh ? '统计来源' : 'Source', props.label],
      ]
    : [];
  const title = props.language === 'zh-CN' ? '最近半年用量' : 'Usage over the last 6 months';
  return (
    <section className="codex-usage-calendar-card" aria-label={`${title} · ${props.label}`}>
      <header>
        <span className="codex-usage-calendar-card-title">
          <CalendarDots size={22} weight="regular" aria-hidden="true" />
          <strong>{title}</strong>
        </span>
        <small>{props.label}</small>
      </header>
      <div className="codex-usage-calendar-card-scroll">
        <div className="codex-usage-calendar" role="group" aria-label={`${title} · ${props.label}`}>
          <div className="codex-usage-calendar-months" style={{ gridTemplateColumns: `repeat(${calendar.weekCount}, var(--usage-heatmap-cell-size))` }} aria-hidden="true">
            {calendar.months.map((month, index) => (
              <span key={`${index}-${month ?? 'empty'}`}>{month}</span>
            ))}
          </div>
          <div className="codex-usage-calendar-weekdays" aria-hidden="true">
            {calendar.weekdays.map((weekday, index) => (
              <span key={`${index}-${weekday}`}>{weekday}</span>
            ))}
          </div>
          <div className="codex-usage-calendar-cells" style={{ gridTemplateColumns: `repeat(${calendar.weekCount}, var(--usage-heatmap-cell-size))` }}>
            {calendar.cells.map((day) => (
              <span
                key={day.date}
                data-level={day.level}
                data-future={day.future || undefined}
                tabIndex={day.future ? undefined : 0}
                aria-label={day.title}
                aria-describedby={hover?.day.date === day.date ? tooltipId : undefined}
                onPointerEnter={(event) => {
                  hide();
                  if (!day.future && event.pointerType !== 'touch' && event.buttons === 0) hoverIntent.schedule(event.currentTarget, day);
                }}
                onPointerLeave={hide}
                onFocus={(event) => {
                  hoverIntent.cancel();
                  if (event.currentTarget.matches(':focus-visible')) show(day, event.currentTarget);
                }}
                onClick={(event) => show(day, event.currentTarget)}
                onBlur={hide}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') hide();
                }}
              />
            ))}
          </div>
          <div className="codex-usage-calendar-legend" aria-hidden="true">
            <span>{props.language === 'zh-CN' ? '少' : 'Less'}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} data-level={level} />
            ))}
            <span>{props.language === 'zh-CN' ? '多' : 'More'}</span>
          </div>
        </div>
      </div>
      {hover &&
        createPortal(
          <div className="macos-ai-app" style={{ display: 'contents' }}>
            <div id={tooltipId} role="tooltip" className="codex-usage-calendar-tooltip" style={{ left: hover.left, top: hover.top }}>
              <strong>{formatCalendarDate(new Date(`${hover.day.date}T00:00:00`), props.language)}</strong>
              <dl>
                {rows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              <small>{zh ? '官方每日统计不含缓存拆分和费用。' : 'Daily account statistics do not include cache breakdown or costs.'}</small>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}

/** 当前范围使用连续日期柱图；全部历史按月汇总，避免裁掉早期记录。 */
function LocalUsageTrend(props: { days: Array<Pick<CodexLocalUsageDay, 'date' | 'totalTokens'>>; range: CodexUsageRange; label: string; language: Language }) {
  /** 每个槽位保留完整时间间隔，没有记录的日期为零。 */
  const cells = useMemo(() => {
    /** 全部历史按月份合计，其余范围保持逐日。 */
    const monthly = props.range === 'all';
    /** 日期键只来自后台账本，不混入官方账户统计。 */
    const totals = new Map<string, number>();
    for (const day of props.days) {
      /** 月份合并只改变展示粒度，不改变 Token 总量。 */
      const key = monthly ? day.date.slice(0, 7) : day.date;
      totals.set(key, (totals.get(key) ?? 0) + day.totalTokens);
    }
    /** 当前本地日期用于补齐空白日期。 */
    const today = startOfLocalDate(new Date());
    /** 全部历史从首条记录月份开始，空历史只保留当前月份。 */
    const firstMonth = [...totals.keys()].sort()[0];
    /** 日期计算使用本地日历，避免夏令时带来的重复或缺日。 */
    const first = monthly ? (firstMonth ? new Date(`${firstMonth}-01T00:00:00`) : new Date(today.getFullYear(), today.getMonth(), 1)) : addLocalDays(today, -(props.range === '7d' ? 6 : props.range === '30d' ? 29 : 89));
    /** 柱图保留全部槽位，不对全部历史做静默截断。 */
    const slots: Array<{ date: string; totalTokens: number }> = [];
    for (let date = first; date <= today; date = monthly ? new Date(date.getFullYear(), date.getMonth() + 1, 1) : addLocalDays(date, 1)) {
      /** 月和日使用各自的展示键。 */
      const key = monthly ? localDateKey(date).slice(0, 7) : localDateKey(date);
      slots.push({ date: key, totalTokens: totals.get(key) ?? 0 });
    }
    return slots;
  }, [props.days, props.range]);
  /** 柱高只在同一供应商、同一统计范围内比较。 */
  const maximum = Math.max(1, ...cells.map((day) => day.totalTokens));
  return (
    <section className="codex-usage-trend" aria-label={props.label}>
      <header>
        <strong>{props.range === 'all' ? (props.language === 'zh-CN' ? '每月 Token' : 'Monthly tokens') : props.language === 'zh-CN' ? '每日 Token' : 'Daily tokens'}</strong>
        <small>{props.label}</small>
      </header>
      <div className="codex-usage-trend-bars" role="list">
        {cells.map((day) => (
          <span
            key={day.date}
            role="listitem"
            tabIndex={0}
            data-icon-tooltip={`${day.date}: ${new Intl.NumberFormat(props.language).format(day.totalTokens)} Token`}
            aria-label={`${day.date}: ${new Intl.NumberFormat(props.language).format(day.totalTokens)} Token`}
          >
            <i style={{ blockSize: `${Math.max(day.totalTokens > 0 ? 2 : 0, (day.totalTokens / maximum) * 100)}%` }} />
          </span>
        ))}
      </div>
      <footer>
        <span>{cells[0]?.date}</span>
        <span>{cells.at(-1)?.date}</span>
      </footer>
    </section>
  );
}

/** 官方日历中的单个日期包含访问说明与强度。 */
type UsageCalendarCell = {
  date: string;
  level: number;
  future: boolean;
  title: string;
};

type UsageCalendar = {
  cells: UsageCalendarCell[];
  months: Array<string | null>;
  weekdays: string[];
  weekCount: number;
};

/** 热力图以周一为首日；半年固定为 26 列，保证月份位置和参考样式稳定。 */
function buildUsageCalendar(days: Array<Pick<CodexLocalUsageDay, 'date' | 'totalTokens'>>, language: Language, now = new Date()): UsageCalendar {
  const weekCount = 26;
  const today = startOfLocalDate(now);
  const currentWeekStart = addLocalDays(today, -((today.getDay() + 6) % 7));
  const firstDate = addLocalDays(currentWeekStart, -(weekCount - 1) * 7);
  const totalsByDate = new Map<string, number>();
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day.date) || !Number.isFinite(day.totalTokens)) continue;
    totalsByDate.set(day.date, (totalsByDate.get(day.date) ?? 0) + Math.max(0, day.totalTokens));
  }

  const datedCells = Array.from({ length: weekCount * 7 }, (_, index) => {
    const date = addLocalDays(firstDate, index);
    const dateKey = localDateKey(date);
    return { date, dateKey, totalTokens: totalsByDate.get(dateKey) ?? 0, future: date > today };
  });
  const max = datedCells.reduce((value, day) => (day.future ? value : Math.max(value, day.totalTokens)), 0);
  const cells = datedCells.map<UsageCalendarCell>((day) => ({
    date: day.dateKey,
    level: day.future || day.totalTokens <= 0 || max <= 0 ? 0 : Math.max(1, Math.ceil((day.totalTokens / max) * 4)),
    future: day.future,
    title: day.future ? `${formatCalendarDate(day.date, language)} · ${language === 'zh-CN' ? '未来日期' : 'Future date'}` : `${formatCalendarDate(day.date, language)} · ${formatTokens(day.totalTokens, language)} Token`,
  }));
  const months = Array.from<string | null>({ length: weekCount }).fill(null);
  for (let weekIndex = 0; weekIndex < weekCount; weekIndex += 1) {
    for (let weekdayIndex = 0; weekdayIndex < 7; weekdayIndex += 1) {
      const date = datedCells[weekIndex * 7 + weekdayIndex]?.date;
      if (date?.getDate() === 1) months[weekIndex] = formatCalendarMonth(date, language);
    }
  }
  return {
    cells,
    months,
    weekdays: language === 'zh-CN' ? ['一', '二', '三', '四', '五', '六', '日'] : ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
    weekCount,
  };
}

/** 取本地日历的零点，避免跨时区日期偏移。 */
function startOfLocalDate(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

/** 按本地日历加减日期，保留夏令时边界。 */
function addLocalDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

/** 生成与本地账本一致的日期键。 */
function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

/** 按界面语言显示简短月份。 */
function formatCalendarMonth(value: Date, language: Language): string {
  if (language === 'zh-CN') return ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'][value.getMonth()] ?? '';
  return new Intl.DateTimeFormat(language, { month: 'short' }).format(value);
}

/** 为日期悬浮详情提供完整日期。 */
function formatCalendarDate(value: Date, language: Language): string {
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(value);
}

/** 各明细独立分页，过滤条件变更时由父级重新挂载并回到第一页。 */
function UsageBreakdownTable(props: { title: string; rows: CodexLocalUsageGroup[]; language: Language; showTitle?: boolean; provider: UsageProviderAnalytics['provider'] }) {
  /** 用户请求页；最新数据缩短时立即夹紧显示范围。 */
  const [requestedPage, setRequestedPage] = useState(1);
  /** 当前可展示页。 */
  const page = settingsPage(props.rows.length, requestedPage);
  /** 模型、项目和会话都按 Token 降序展示，分页不会改变排序。 */
  const rows = useMemo(() => [...props.rows].sort((left, right) => right.totalTokens - left.totalTokens || left.label.localeCompare(right.label)), [props.rows]);
  if (props.rows.length === 0) return null;
  return (
    <section className="codex-usage-table-wrap" aria-label={props.title}>
      {props.showTitle === false ? null : <h3>{props.title}</h3>}
      <div className="codex-usage-table-scroll">
        <table>
          <thead>
            <tr>
              <th>{props.language === 'zh-CN' ? '名称' : 'Name'}</th>
              <th>Token</th>
              <th>{props.language === 'zh-CN' ? '命中率' : 'Cache hit'}</th>
              <th>{props.language === 'zh-CN' ? '输出速率' : 'Output rate'}</th>
              <th>{usageCostLabel(props.provider, props.language)}</th>
              <th>{props.language === 'zh-CN' ? '覆盖率' : 'Coverage'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice((page - 1) * settingsPageSize, page * settingsPageSize).map((row) => (
              <tr key={row.id}>
                <th scope="row" data-icon-tooltip={row.label}>
                  {row.label}
                </th>
                <td>{formatTokens(row.totalTokens, props.language)}</td>
                <td>{formatPercent(row.cacheHitRate, props.language)}</td>
                <td>{formatOutputRate(row.outputTokensPerSecond, props.language)}</td>
                <td data-icon-tooltip={formatEstimatedCosts(row.costs, row.apiEquivalentUsd)}>{formatUsageCost(row, props.language)}</td>
                <td>{formatPercent(row.priceCoverage, props.language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SettingsPagination label={props.title} total={props.rows.length} page={page} onChange={setRequestedPage} language={props.language} />
    </section>
  );
}

/** 从当前快照生成筛选选项；模型采用统一型号排序，项目沿用名称排序。 */
function usageFilterOptions(providers: UsageProviderAnalytics[], field: 'models' | 'projects'): Array<Pick<CodexLocalUsageGroup, 'id' | 'label'>> {
  return [...new Map(providers.flatMap((entry) => entry.filters[field]).map((group) => [group.id, group])).values()].sort((left, right) =>
    field === 'models' ? compareModelNames(left.label, right.label) : left.label.localeCompare(right.label),
  );
}

/** Codex 订阅使用等价费用口径，其他供应商使用普通费用估算。 */
function usageCostLabel(provider: UsageProviderAnalytics['provider'], language: Language): string {
  return isCodexSubscriptionUsage(provider) ? (language === 'zh-CN' ? '等价费用' : 'Equivalent cost') : language === 'zh-CN' ? '费用估算' : 'Estimated cost';
}

/** 费用保留原币，常规数值两位小数，小额保留四位且不舍入成零。 */
function formatUsageCost(totals: UsageProviderAnalytics['local']['totals'], language: Language): string {
  if (totals.turnCount === 0) return '—';
  /** 缺价不是零费用，也不能混合不同币种。 */
  const amounts = totals.costs ?? (totals.apiEquivalentUsd === null ? [] : [{ currency: 'USD', amount: totals.apiEquivalentUsd }]);
  if (amounts.length === 0) return language === 'zh-CN' ? '暂无价格' : 'No price';
  return amounts.map(({ currency, amount }) => `${currency} ${amount > 0 && amount < 0.0001 ? '<0.0001' : new Intl.NumberFormat(language, { maximumFractionDigits: amount > 0 && amount < 0.01 ? 4 : 2 }).format(amount)}`).join(' + ');
}

/** 速率沿用后台加权汇总，缺少有效测量时保持未知。 */
function formatOutputRate(value: number | null, language: Language): string {
  return value === null ? '—' : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(value)} tok/s`;
}

/** Token 使用本地化紧凑数值。 */
function formatTokens(value: number | null, language: Language): string {
  return value === null ? text[language].unavailable : new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

/** 百分比只展示非负值，缺失值保持未知。 */
function formatPercent(value: number | null, language: Language): string {
  return value === null ? text[language].unavailable : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

/** 统一额度窗口的天数单位。 */
function formatDays(days: number | null, language: Language): string {
  return days === null ? text[language].unavailable : `${days} ${language === 'zh-CN' ? '天' : days === 1 ? 'day' : 'days'}`;
}

/** 官方额度时长优先使用整天或整小时。 */
function formatWindow(minutes: number | null, language: Language): string {
  if (minutes === null) return text[language].unavailable;
  if (minutes % (24 * 60) === 0) return formatDays(minutes / (24 * 60), language);
  if (minutes % 60 === 0) return `${minutes / 60} ${language === 'zh-CN' ? '小时' : 'hours'}`;
  return `${minutes} ${language === 'zh-CN' ? '分钟' : 'minutes'}`;
}

/** 官方时间戳转换为账户额度重置时间。 */
function formatReset(timestamp: number, language: Language): string {
  return `${language === 'zh-CN' ? '重置于' : 'Resets'} ${new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000))}`;
}

/** 更新时间采用界面语言的日期格式。 */
function formatDateTime(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

/** 刷新时间保持次级说明，不当作告警。 */
function formatUpdatedAt(value: string, language: Language): string {
  return `${language === 'zh-CN' ? '更新于' : 'Updated'} ${formatDateTime(value, language)}`;
}
import { useHoverIntent } from '../ui/useHoverIntent.js';
