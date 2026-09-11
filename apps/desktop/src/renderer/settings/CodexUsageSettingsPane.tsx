import { type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { calculateUncachedInputTokens, type CodexLocalUsageDay, type CodexLocalUsageGroup, type CodexOfficialUsageSnapshot, type CodexUsageAnalyticsSnapshot, type CodexUsageRange } from '@zeus/shared';
import { CalendarDotsIcon as CalendarDots } from '@phosphor-icons/react/dist/csr/CalendarDots';
import { GaugeIcon as Gauge } from '@phosphor-icons/react/dist/csr/Gauge';
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { SettingsPagination, settingsPage, settingsPageSize } from './SettingsPagination.js';

type UsageClient = {
  loadCodexUsageAnalytics: (input: { range: CodexUsageRange; projectId?: string; model?: string }) => Promise<CodexUsageAnalyticsSnapshot>;
};

type Language = 'zh-CN' | 'en-US';

const text = {
  'zh-CN': {
    title: '用量',
    official: 'Codex 账户总览',
    officialHelp: '全部 Codex 客户端的官方账户数据，不与 Zeus 本地明细相加。',
    local: 'Zeus 内使用明细',
    localHelp: '仅包含功能启用后 Zeus 采集的逐轮数据。Credits 和美元均为估算，不是实际账单。',
    allClients: '全部 Codex 客户端',
    onlyZeus: '仅 Zeus',
    loading: '正在读取用量…',
    unavailable: '不可用',
    signedOut: '尚未登录 Codex ChatGPT 账户。',
    unsupported: '当前登录方式不提供 ChatGPT 官方账户统计；本地 Zeus 明细仍可用。',
    stale: '离线或刷新失败，当前显示上次成功数据。',
    empty: '尚无可展示的用量数据。',
    noPrice: '暂无官方价格',
    range: '时间范围',
    project: '项目',
    model: '模型',
    all: '全部',
    refresh: '刷新',
  },
  'en-US': {
    title: 'Usage',
    official: 'Codex account overview',
    officialHelp: 'Official account data across all Codex clients. It is never added to Zeus-local usage.',
    local: 'Usage inside Zeus',
    localHelp: 'Only turn-level data collected by Zeus since this feature was enabled. Credits and USD are estimates, not an actual bill.',
    allClients: 'All Codex clients',
    onlyZeus: 'Zeus only',
    loading: 'Loading usage…',
    unavailable: 'Unavailable',
    signedOut: 'No Codex ChatGPT account is signed in.',
    unsupported: 'This sign-in method does not provide official ChatGPT account analytics. Zeus-local detail remains available.',
    stale: 'Offline or refresh failed. Showing the last successful snapshot.',
    empty: 'No usage data is available yet.',
    noPrice: 'No official price available',
    range: 'Range',
    project: 'Project',
    model: 'Model',
    all: 'All',
    refresh: 'Refresh',
  },
} as const;

export function CodexUsageSettingsPane(props: { client: UsageClient | null; language: Language; refreshRevision: number }) {
  const copy = text[props.language];
  const [range, setRange] = useState<CodexUsageRange>('30d');
  const [projectId, setProjectId] = useState('');
  const [model, setModel] = useState('');
  const [snapshot, setSnapshot] = useState<CodexUsageAnalyticsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const loadRevision = useRef(0);
  useApplicationErrorDialog(error, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
  const [filterOptions, setFilterOptions] = useState<{ projects: CodexLocalUsageGroup[]; models: CodexLocalUsageGroup[] }>({ projects: [], models: [] });

  const load = useCallback(async () => {
    const revision = ++loadRevision.current;
    if (!props.client) {
      setLoading(false);
      setError(copy.unavailable);
      return;
    }
    setLoading(true);
    try {
      const next = await props.client.loadCodexUsageAnalytics({ range, projectId: projectId || undefined, model: model || undefined });
      if (revision !== loadRevision.current) return;
      setSnapshot(next);
      setFilterOptions((current) => ({
        projects: mergeGroups(current.projects, next.local.byProject),
        models: mergeGroups(current.models, next.local.byModel),
      }));
      setError(null);
    } catch (cause) {
      if (revision === loadRevision.current) setError(cause);
    } finally {
      if (revision === loadRevision.current) setLoading(false);
    }
  }, [copy.unavailable, model, projectId, props.client, range]);

  useEffect(() => {
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
        <button type="button" onClick={() => void load()} disabled={loading} aria-busy={loading}>
          {loading ? copy.loading : copy.refresh}
        </button>
      </header>
      {loading && !snapshot ? (
        <p className="codex-usage-state" role="status">
          {copy.loading}
        </p>
      ) : null}
      {snapshot ? (
        <>
          <UsageSection title={copy.official} description={copy.officialHelp} badge={copy.allClients}>
            <OfficialOverview snapshot={snapshot.official} language={props.language} />
          </UsageSection>

          <LocalUsageTabs snapshot={snapshot} language={props.language} dataKey={`${range}:${projectId}:${model}`}>
            <div className="codex-usage-filters" aria-label={copy.local}>
              <label>
                <span>{copy.range}</span>
                <select value={range} onChange={(event) => setRange(event.currentTarget.value as CodexUsageRange)}>
                  <option value="7d">7 {props.language === 'zh-CN' ? '天' : 'days'}</option>
                  <option value="30d">30 {props.language === 'zh-CN' ? '天' : 'days'}</option>
                  <option value="90d">90 {props.language === 'zh-CN' ? '天' : 'days'}</option>
                  <option value="all">{copy.all}</option>
                </select>
              </label>
              <label>
                <span>{copy.project}</span>
                <select value={projectId} onChange={(event) => setProjectId(event.currentTarget.value)}>
                  <option value="">{copy.all}</option>
                  {filterOptions.projects.map((group) => (
                    <option value={group.id} key={group.id}>
                      {group.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>{copy.model}</span>
                <select value={model} onChange={(event) => setModel(event.currentTarget.value)}>
                  <option value="">{copy.all}</option>
                  {filterOptions.models.map((group) => (
                    <option value={group.id} key={group.id}>
                      {group.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </LocalUsageTabs>
        </>
      ) : null}
    </section>
  );
}

function UsageSection(props: { title: string; description: string; badge: string; children: ReactNode }) {
  return (
    <section className="codex-usage-section">
      <header>
        <span>
          <strong>{props.title}</strong>
          <small>{props.description}</small>
        </span>
        <em>{props.badge}</em>
      </header>
      {props.children}
    </section>
  );
}

function OfficialOverview(props: { snapshot: CodexOfficialUsageSnapshot; language: Language }) {
  const copy = text[props.language];
  useApplicationErrorDialog(props.snapshot.state === 'unavailable' ? props.snapshot.error : null, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
  });
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
      <div className="codex-usage-official-summary">
        {props.snapshot.stale ? <p className="codex-usage-stale">{copy.stale}</p> : null}
        <MetricGrid
          language={props.language}
          items={[
            [props.language === 'zh-CN' ? '计划' : 'Plan', props.snapshot.planType ?? copy.unavailable],
            [props.language === 'zh-CN' ? '累计 Token' : 'Lifetime tokens', formatTokens(props.snapshot.lifetimeTokens, props.language)],
            [props.language === 'zh-CN' ? '日峰值' : 'Peak day', formatTokens(props.snapshot.peakDailyTokens, props.language)],
            [props.language === 'zh-CN' ? '最长运行' : 'Longest turn', formatDuration(props.snapshot.longestRunningTurnSec, props.language)],
            [props.language === 'zh-CN' ? '当前连续天数' : 'Current streak', formatDays(props.snapshot.currentStreakDays, props.language)],
            [props.language === 'zh-CN' ? '最长连续天数' : 'Longest streak', formatDays(props.snapshot.longestStreakDays, props.language)],
          ]}
        />
      </div>
      <div className="codex-usage-official-detail-grid">
        <OfficialUsageCalendar days={(props.snapshot.dailyUsageBuckets ?? []).map((day) => ({ date: day.startDate, totalTokens: day.tokens }))} label={copy.allClients} language={props.language} />
        <section className="codex-usage-quota-panel" aria-label={props.language === 'zh-CN' ? '账户用量限制' : 'Account usage limits'}>
          <header>
            <span>
              <Gauge size={20} weight="regular" aria-hidden="true" />
              <strong>{props.language === 'zh-CN' ? '账户用量限制' : 'Account usage limits'}</strong>
            </span>
            <small>{props.language === 'zh-CN' ? `${props.snapshot.rateLimitWindows.length} 个窗口` : `${props.snapshot.rateLimitWindows.length} window${props.snapshot.rateLimitWindows.length === 1 ? '' : 's'}`}</small>
          </header>
          {props.snapshot.rateLimitWindows.length > 0 ? (
            <div className="codex-usage-limit-list">
              {props.snapshot.rateLimitWindows.map((window, index) => (
                <div key={`${window.limitId ?? 'limit'}-${window.kind}-${index}`}>
                  <span>
                    <strong>{window.limitName ?? window.limitId ?? (props.language === 'zh-CN' ? '配额窗口' : 'Quota window')}</strong>
                    <small>{formatWindow(window.windowDurationMins, props.language)}</small>
                  </span>
                  <span>
                    <b>{formatPercent(window.remainingPercent / 100, props.language)}</b>
                    <small>{window.resetsAt ? formatReset(window.resetsAt, props.language) : copy.unavailable}</small>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="codex-usage-state">{props.language === 'zh-CN' ? '当前没有可展示的限额窗口。' : 'No usage-limit windows are available.'}</p>
          )}
        </section>
      </div>
    </>
  );
}

type LocalUsageTab = 'overview' | 'models' | 'projects' | 'conversations';

function LocalUsageTabs(props: { snapshot: CodexUsageAnalyticsSnapshot; language: Language; dataKey: string; children: ReactNode }) {
  const copy = text[props.language];
  const [activeTab, setActiveTab] = useState<LocalUsageTab>('overview');
  const tabGroupId = useId();
  const tabs: Array<{ id: LocalUsageTab; label: string }> = [
    { id: 'overview', label: copy.local },
    { id: 'models', label: props.language === 'zh-CN' ? '模型明细' : 'Models' },
    { id: 'projects', label: props.language === 'zh-CN' ? '项目明细' : 'Projects' },
    { id: 'conversations', label: props.language === 'zh-CN' ? '会话明细' : 'Conversations' },
  ];
  const tabId = (tab: LocalUsageTab) => `${tabGroupId}-${tab}-tab`;
  const panelId = (tab: LocalUsageTab) => `${tabGroupId}-${tab}-panel`;
  const emptyPanel = <p className="codex-usage-state">{copy.empty}</p>;

  return (
    <section className="codex-usage-section codex-usage-local-tabs">
      <header className="codex-usage-local-tabs-header">
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
      {props.children}
      <section id={panelId('overview')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('overview')} tabIndex={0} hidden={activeTab !== 'overview'}>
        <LocalOverview snapshot={props.snapshot} language={props.language} />
      </section>
      <section id={panelId('models')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('models')} tabIndex={0} hidden={activeTab !== 'models'}>
        {props.snapshot.local.byModel.length > 0 ? (
          <UsageBreakdownTable key={`${props.dataKey}:models`} title={props.language === 'zh-CN' ? '模型明细' : 'Models'} rows={props.snapshot.local.byModel} language={props.language} showTitle={false} />
        ) : (
          emptyPanel
        )}
      </section>
      <section id={panelId('projects')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('projects')} tabIndex={0} hidden={activeTab !== 'projects'}>
        {props.snapshot.local.byProject.length > 0 ? (
          <UsageBreakdownTable key={`${props.dataKey}:projects`} title={props.language === 'zh-CN' ? '项目明细' : 'Projects'} rows={props.snapshot.local.byProject} language={props.language} showTitle={false} />
        ) : (
          emptyPanel
        )}
      </section>
      <section id={panelId('conversations')} className="codex-usage-local-tab-panel" role="tabpanel" aria-labelledby={tabId('conversations')} tabIndex={0} hidden={activeTab !== 'conversations'}>
        {props.snapshot.local.byConversation.length > 0 ? (
          <UsageBreakdownTable key={`${props.dataKey}:conversations`} title={props.language === 'zh-CN' ? '会话明细' : 'Conversations'} rows={props.snapshot.local.byConversation} language={props.language} showTitle={false} />
        ) : (
          emptyPanel
        )}
      </section>
      <p className="codex-usage-pricing-note">
        {props.snapshot.pricing.note} {props.language === 'zh-CN' ? '价格来源日期' : 'Price source date'}: {props.snapshot.pricing.catalogDate}
        {' · '}
        <a href={props.snapshot.pricing.sourceUrls[0]} target="_blank" rel="noreferrer">
          OpenAI
        </a>
      </p>
      {props.snapshot.local.collectionStartedAt ? (
        <small>
          {props.language === 'zh-CN' ? '本地采集始于' : 'Local collection started'} {formatDateTime(props.snapshot.local.collectionStartedAt, props.language)}
        </small>
      ) : null}
    </section>
  );
}

function LocalOverview(props: { snapshot: CodexUsageAnalyticsSnapshot; language: Language }) {
  const copy = text[props.language];
  const totals = props.snapshot.local.totals;
  return (
    <>
      <MetricGrid
        language={props.language}
        items={[
          [props.language === 'zh-CN' ? '会话数' : 'Conversations', String(totals.conversationCount)],
          [props.language === 'zh-CN' ? '轮次数' : 'Turns', String(totals.turnCount)],
          [props.language === 'zh-CN' ? '总 Token' : 'Total tokens', formatTokens(totals.totalTokens, props.language)],
          [props.language === 'zh-CN' ? '输入' : 'Input', formatTokens(totals.inputTokens, props.language)],
          [props.language === 'zh-CN' ? '输出' : 'Output', formatTokens(totals.outputTokens, props.language)],
          [props.language === 'zh-CN' ? '推理输出' : 'Reasoning output', formatTokens(totals.reasoningOutputTokens, props.language)],
          [props.language === 'zh-CN' ? '缓存命中' : 'Cache hits', formatTokens(totals.cachedInputTokens, props.language)],
          [props.language === 'zh-CN' ? '缓存未命中' : 'Cache misses', formatTokens(calculateUncachedInputTokens(totals), props.language)],
          [props.language === 'zh-CN' ? '缓存写入' : 'Cache writes', formatTokens(totals.cacheWriteInputTokens, props.language)],
          [props.language === 'zh-CN' ? '缓存命中率' : 'Cache hit rate', formatPercent(totals.cacheHitRate, props.language)],
          ['Credits', formatEstimate(totals.estimatedCredits, 'credits', props.language)],
          [props.language === 'zh-CN' ? 'API 等价美元' : 'API-equivalent USD', formatEstimate(totals.apiEquivalentUsd, 'usd', props.language)],
          [props.language === 'zh-CN' ? '缓存节省估算' : 'Estimated cache savings', formatEstimate(totals.cacheSavingsUsd, 'usd', props.language)],
          [props.language === 'zh-CN' ? '费用覆盖率' : 'Price coverage', formatPercent(totals.priceCoverage, props.language)],
        ]}
      />
      <UsageHeatmap days={props.snapshot.local.daily} label={copy.onlyZeus} language={props.language} />
      {totals.turnCount === 0 ? <p className="codex-usage-state">{copy.empty}</p> : null}
    </>
  );
}

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

function OfficialUsageCalendar(props: { days: Array<Pick<CodexLocalUsageDay, 'date' | 'totalTokens'>>; label: string; language: Language }) {
  const calendar = useMemo(() => buildUsageCalendar(props.days, props.language), [props.days, props.language]);
  const [hover, setHover] = useState<{ day: UsageCalendarCell; left: number; top: number } | null>(null);
  const tooltipId = useId();
  const zh = props.language === 'zh-CN';
  const hide = useCallback(() => setHover(null), []);
  useEffect(() => {
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [hide]);
  const show = (day: UsageCalendarCell, element: HTMLElement) => {
    if (day.future) return;
    const rect = element.getBoundingClientRect();
    setHover({ day, left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)), top: Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 310)) });
  };
  const totals = hover ? props.days.filter((day) => day.date === hover.day.date && Number.isFinite(day.totalTokens)) : [];
  const missing = zh ? '未提供' : 'Not provided';
  const rows = hover
    ? [
        ['Runtime', 'Codex'],
        [
          zh ? '总量' : 'Total',
          totals.length
            ? `${formatTokens(
                totals.reduce((sum, day) => sum + Math.max(0, day.totalTokens), 0),
                props.language,
              )} Token`
            : zh
              ? '无记录'
              : 'No record',
        ],
        [zh ? '未缓存' : 'Uncached', missing],
        [zh ? '缓存' : 'Cached', missing],
        [zh ? '输出' : 'Output', missing],
        [zh ? '估算' : 'Estimate', missing],
        [zh ? '口径' : 'Scope', props.label],
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
        <span className="codex-usage-calendar-card-basis" title={props.language === 'zh-CN' ? `${props.label}，按日统计` : `${props.label}, grouped by day`}>
          <span>{props.language === 'zh-CN' ? '口径' : 'View'}</span>
          <b>{props.language === 'zh-CN' ? '精细' : 'Detailed'}</b>
        </span>
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
                onMouseEnter={(event) => show(day, event.currentTarget)}
                onMouseLeave={hide}
                onFocus={(event) => show(day, event.currentTarget)}
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
              <small>{zh ? '官方按日统计未提供缓存拆分和费用。' : 'Daily account statistics do not include cache breakdown or costs.'}</small>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}

function UsageHeatmap(props: { days: Array<Pick<CodexLocalUsageDay, 'date' | 'totalTokens'>>; label: string; language: Language }) {
  const cells = useMemo(() => props.days.slice(-365), [props.days]);
  const max = useMemo(() => cells.reduce((value, day) => Math.max(value, day.totalTokens), 0), [cells]);
  return (
    <section className="codex-usage-heatmap" aria-label={props.label}>
      <header>
        <strong>{props.label}</strong>
        <small>{props.language === 'zh-CN' ? '每日 Token 活动' : 'Daily token activity'}</small>
      </header>
      <div role="img" aria-label={props.label}>
        {cells.map((day) => {
          const level = max > 0 ? Math.max(1, Math.ceil((day.totalTokens / max) * 4)) : 0;
          return <span key={day.date} data-level={level} title={`${day.date}: ${formatTokens(day.totalTokens, props.language)}`} />;
        })}
      </div>
    </section>
  );
}

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

function startOfLocalDate(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function addLocalDays(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function localDateKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

function formatCalendarMonth(value: Date, language: Language): string {
  if (language === 'zh-CN') return ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'][value.getMonth()] ?? '';
  return new Intl.DateTimeFormat(language, { month: 'short' }).format(value);
}

function formatCalendarDate(value: Date, language: Language): string {
  return new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric', weekday: 'short' }).format(value);
}

/** 各明细独立分页，过滤条件变更时由父级重新挂载并回到第一页。 */
function UsageBreakdownTable(props: { title: string; rows: CodexLocalUsageGroup[]; language: Language; showTitle?: boolean }) {
  /** 用户请求页；最新数据缩短时立即夹紧显示范围。 */
  const [requestedPage, setRequestedPage] = useState(1);
  /** 当前可展示页。 */
  const page = settingsPage(props.rows.length, requestedPage);
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
              <th>Credits</th>
              <th>USD</th>
              <th>{props.language === 'zh-CN' ? '覆盖率' : 'Coverage'}</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.slice((page - 1) * settingsPageSize, page * settingsPageSize).map((row) => (
              <tr key={row.id}>
                <th scope="row" title={row.label}>
                  {row.label}
                </th>
                <td>{formatTokens(row.totalTokens, props.language)}</td>
                <td>{formatPercent(row.cacheHitRate, props.language)}</td>
                <td>{formatEstimate(row.estimatedCredits, 'credits', props.language)}</td>
                <td>{formatEstimate(row.apiEquivalentUsd, 'usd', props.language)}</td>
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

function mergeGroups(current: CodexLocalUsageGroup[], incoming: CodexLocalUsageGroup[]): CodexLocalUsageGroup[] {
  return [...new Map([...current, ...incoming].map((group) => [group.id, group])).values()].sort((left, right) => left.label.localeCompare(right.label));
}

function formatTokens(value: number | null, language: Language): string {
  return value === null ? text[language].unavailable : new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value: number | null, language: Language): string {
  return value === null ? text[language].unavailable : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

function formatEstimate(value: number | null, kind: 'credits' | 'usd', language: Language): string {
  if (value === null) return text[language].noPrice;
  // 常规估算保留两位小数，微小费用保留四位，避免大量无意义尾数撑宽表格。
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: value > 0 && value < 0.01 ? 4 : 2 }).format(value);
  return kind === 'usd' ? `~$${formatted}` : `~${formatted}`;
}

function formatDuration(seconds: number | null, language: Language): string {
  if (seconds === null) return text[language].unavailable;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return language === 'zh-CN' ? `${hours ? `${hours} 小时 ` : ''}${minutes} 分` : `${hours ? `${hours}h ` : ''}${minutes}m`;
}

function formatDays(days: number | null, language: Language): string {
  return days === null ? text[language].unavailable : `${days} ${language === 'zh-CN' ? '天' : days === 1 ? 'day' : 'days'}`;
}

function formatWindow(minutes: number | null, language: Language): string {
  if (minutes === null) return text[language].unavailable;
  if (minutes % (24 * 60) === 0) return formatDays(minutes / (24 * 60), language);
  if (minutes % 60 === 0) return `${minutes / 60} ${language === 'zh-CN' ? '小时' : 'hours'}`;
  return `${minutes} ${language === 'zh-CN' ? '分钟' : 'minutes'}`;
}

function formatReset(timestamp: number, language: Language): string {
  return `${language === 'zh-CN' ? '重置于' : 'Resets'} ${new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000))}`;
}

function formatDateTime(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatUpdatedAt(value: string, language: Language): string {
  return `${language === 'zh-CN' ? '更新于' : 'Updated'} ${formatDateTime(value, language)}`;
}
