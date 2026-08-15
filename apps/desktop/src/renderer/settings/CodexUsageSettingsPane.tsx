import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import type { CodexLocalUsageDay, CodexLocalUsageGroup, CodexOfficialUsageSnapshot, CodexUsageAnalyticsSnapshot, CodexUsageRange } from '@zeus/shared';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

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
  const [error, setError] = useState<string | null>(null);
  useApplicationErrorDialog(error, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    title: props.language === 'zh-CN' ? '用量读取失败' : 'Usage failed to load',
    source: 'CodexUsageSettingsPane',
  });
  const [filterOptions, setFilterOptions] = useState<{ projects: CodexLocalUsageGroup[]; models: CodexLocalUsageGroup[] }>({ projects: [], models: [] });

  const load = useCallback(async () => {
    if (!props.client) {
      setLoading(false);
      setError(copy.unavailable);
      return;
    }
    setLoading(true);
    try {
      const next = await props.client.loadCodexUsageAnalytics({ range, projectId: projectId || undefined, model: model || undefined });
      setSnapshot(next);
      setFilterOptions((current) => ({
        projects: mergeGroups(current.projects, next.local.byProject),
        models: mergeGroups(current.models, next.local.byModel),
      }));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [copy.unavailable, model, projectId, props.client, range]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), props.refreshRevision > 0 ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [load, props.refreshRevision]);

  return (
    <section className="settings-product-pane codex-usage-settings" aria-label={copy.title}>
      <header className="codex-usage-page-header">
        <span>
          <h2 className="settings-page-title">{copy.title}</h2>
          <small>{snapshot ? formatUpdatedAt(snapshot.updatedAt, props.language) : null}</small>
        </span>
        <button type="button" onClick={() => void load()} disabled={loading}>
          {copy.refresh}
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

          <UsageSection title={copy.local} description={copy.localHelp} badge={copy.onlyZeus}>
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
            <LocalOverview snapshot={snapshot} language={props.language} />
          </UsageSection>
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
    title: props.language === 'zh-CN' ? '官方用量读取失败' : 'Official usage failed to load',
    source: 'CodexUsageSettingsPane.official',
  });
  if (props.snapshot.state === 'signed_out') return <p className="codex-usage-state">{copy.signedOut}</p>;
  if (props.snapshot.state === 'unsupported') return <p className="codex-usage-state">{copy.unsupported}</p>;
  if (props.snapshot.state === 'unavailable' && !props.snapshot.fetchedAt) return <p className="codex-usage-state">{copy.unavailable}</p>;
  return (
    <>
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
      <UsageHeatmap days={(props.snapshot.dailyUsageBuckets ?? []).map((day) => ({ date: day.startDate, totalTokens: day.tokens }))} label={copy.allClients} language={props.language} />
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
    </>
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
          [props.language === 'zh-CN' ? '缓存读取' : 'Cache reads', formatTokens(totals.cachedInputTokens, props.language)],
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
      <UsageBreakdownTable title={props.language === 'zh-CN' ? '模型明细' : 'Models'} rows={props.snapshot.local.byModel} language={props.language} />
      <UsageBreakdownTable title={props.language === 'zh-CN' ? '项目明细' : 'Projects'} rows={props.snapshot.local.byProject} language={props.language} />
      <UsageBreakdownTable title={props.language === 'zh-CN' ? '会话明细' : 'Conversations'} rows={props.snapshot.local.byConversation} language={props.language} />
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
    </>
  );
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

function UsageBreakdownTable(props: { title: string; rows: CodexLocalUsageGroup[]; language: Language }) {
  if (props.rows.length === 0) return null;
  return (
    <section className="codex-usage-table-wrap">
      <h3>{props.title}</h3>
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
          {props.rows.map((row) => (
            <tr key={row.id}>
              <th scope="row">{row.label}</th>
              <td>{formatTokens(row.totalTokens, props.language)}</td>
              <td>{formatPercent(row.cacheHitRate, props.language)}</td>
              <td>{formatEstimate(row.estimatedCredits, 'credits', props.language)}</td>
              <td>{formatEstimate(row.apiEquivalentUsd, 'usd', props.language)}</td>
              <td>{formatPercent(row.priceCoverage, props.language)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 6 }).format(value);
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
