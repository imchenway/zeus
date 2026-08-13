import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodexOfficialRateWindow, UsageOverviewSnapshot, UsageProviderSummary } from '@zeus/shared';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import './MenuBarUsageWindow.css';

type Language = AppShellSettings['appLanguage'];
type Appearance = AppShellSettings['appearance'];
type UsageClient = Pick<DashboardClient, 'loadUsageOverview' | 'subscribeEvents'>;

const snapshotStorageKey = 'zeus.menu-bar-usage.snapshot';
const selectionStorageKey = 'zeus.menu-bar-usage.selection';

const copy = {
  'zh-CN': {
    all: '全部',
    allProviders: '全部供应源',
    loading: '正在读取用量',
    noProviders: '还没有可统计的用量',
    noProvidersDetail: '供应源产生真实 Token 后，会自动出现在这里。',
    quota: '配额剩余',
    noQuota: '暂无官方配额数据',
    today: '今日 Zeus Token',
    todayShort: '今日 Token',
    sevenDays: '近 7 日 Token',
    sevenDaysShort: '7 日 Token',
    cache: '缓存命中率',
    cacheUnsupported: '供应源未提供',
    cost: '近 7 日估算费用',
    costShort: '7 日估算费用',
    noPrice: '暂无价格',
    localEstimate: 'Zeus 本地估算',
    officialCredits: '官方积分余额',
    unlimited: '不限量',
    recentUsage: '近 7 日用量',
    insufficientHistory: '用量积累后显示趋势',
    fullStatistics: '查看完整统计',
    showZeus: '显示 Zeus',
    quitZeus: '退出 Zeus',
    retry: '重试',
    stale: '上次成功结果',
    failed: '暂时无法更新用量',
    failedDetail: '未能读取本地用量数据，请重试。',
    codexOnlyCompatibility: '当前旧执行宿主仅能汇总 Codex；安全交接后恢复全部供应源。',
    updated: '更新于',
    resets: '重置于',
    subscription: '订阅账户',
    api: 'API 供应源',
    deleted: '配置已移除，历史用量仍保留',
    calls: '次调用',
  },
  'en-US': {
    all: 'All',
    allProviders: 'All providers',
    loading: 'Loading usage',
    noProviders: 'No usage recorded yet',
    noProvidersDetail: 'Providers appear here after Zeus records real tokens.',
    quota: 'Quota remaining',
    noQuota: 'No official quota data',
    today: 'Zeus tokens today',
    todayShort: 'Today',
    sevenDays: 'Tokens in 7 days',
    sevenDaysShort: '7 days',
    cache: 'Cache hit rate',
    cacheUnsupported: 'Not provided',
    cost: 'Estimated cost · 7 days',
    costShort: '7-day estimate',
    noPrice: 'No pricing',
    localEstimate: 'Zeus local estimate',
    officialCredits: 'Official credits',
    unlimited: 'Unlimited',
    recentUsage: 'Usage · 7 days',
    insufficientHistory: 'A trend appears after usage is recorded',
    fullStatistics: 'View full statistics',
    showZeus: 'Show Zeus',
    quitZeus: 'Quit Zeus',
    retry: 'Retry',
    stale: 'Last successful result',
    failed: 'Usage cannot be updated',
    failedDetail: 'Local usage data could not be read. Please retry.',
    codexOnlyCompatibility: 'The current legacy host can summarize Codex only. All providers return after a safe handoff.',
    updated: 'Updated',
    resets: 'Resets',
    subscription: 'Subscription',
    api: 'API provider',
    deleted: 'Configuration removed; history retained',
    calls: 'calls',
  },
} as const;

export function MenuBarUsageWindow(props: { client: UsageClient; language: Language; appearance: Appearance }) {
  const [surfaceSettings, setSurfaceSettings] = useState<{ language: Language; appearance: Appearance }>({ language: props.language, appearance: props.appearance });
  const text = copy[surfaceSettings.language];
  const [snapshot, setSnapshot] = useState<UsageOverviewSnapshot | null>(() => readStoredSnapshot());
  const [selection, setSelection] = useState(() => readStoredSelection());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);

  useEffect(() => window.zeus?.onMenuBarUsageSettingsChanged?.(setSurfaceSettings), []);

  const load = useCallback(() => {
    if (requestRef.current) return requestRef.current;
    const request = (async () => {
      setLoading(true);
      try {
        const next = await props.client.loadUsageOverview();
        setSnapshot(next);
        storeSnapshot(next);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        requestRef.current = null;
        setLoading(false);
      }
    })();
    requestRef.current = request;
    return request;
  }, [props.client]);

  useEffect(() => {
    void load();
    const unsubscribe = props.client.subscribeEvents(
      (event) => {
        if (event.type === 'usage.changed' || event.type === 'codex.usage.changed') void load();
      },
      () => undefined,
    );
    const refreshWhenShown = () => void load();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void window.zeus?.hideMenuBarUsage?.();
    };
    window.addEventListener('focus', refreshWhenShown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refreshWhenShown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [load, props.client]);

  useEffect(() => {
    if (selection === 'all' || snapshot?.providers.some((provider) => provider.providerId === selection)) return;
    setSelection('all');
    storeSelection('all');
  }, [selection, snapshot]);

  const select = (providerId: string) => {
    setSelection(providerId);
    storeSelection(providerId);
  };
  const selectedProvider = snapshot?.providers.find((provider) => provider.providerId === selection) ?? null;
  const updatedAt = selectedProvider?.updatedAt ?? snapshot?.updatedAt;
  const stale = Boolean(selectedProvider?.stale || error);
  const freshness = updatedAt ? formatUpdatedAt(updatedAt, surfaceSettings.language, stale ? text.stale : text.updated) : loading ? text.loading : error ? text.failed : text.loading;

  return (
    <main className="menu-bar-usage-root" data-appearance={surfaceSettings.appearance} lang={surfaceSettings.language} aria-label={surfaceSettings.language === 'zh-CN' ? 'Zeus 菜单栏用量浮窗' : 'Zeus menu bar usage'}>
      <section className="menu-bar-usage-surface">
        <header className="menu-bar-usage-header">
          <span className="menu-bar-usage-identity">
            <span className="menu-bar-usage-mark" aria-hidden="true">
              Z
            </span>
            <span>
              <strong>Zeus</strong>
              <small>{selectedProvider?.name ?? text.allProviders}</small>
            </span>
          </span>
          <span className="menu-bar-usage-freshness" data-loading={loading ? 'true' : 'false'} data-stale={stale && !loading ? 'true' : 'false'} aria-live="polite">
            <i aria-hidden="true" />
            {freshness}
          </span>
        </header>

        <nav className="menu-bar-usage-tabs" role="tablist" aria-label={text.allProviders}>
          <button type="button" role="tab" aria-selected={selection === 'all'} onClick={() => select('all')}>
            {text.all}
          </button>
          {snapshot?.providers.map((provider) => (
            <button key={provider.providerId} type="button" role="tab" aria-selected={selection === provider.providerId} onClick={() => select(provider.providerId)}>
              {provider.name}
            </button>
          ))}
        </nav>

        <div className="menu-bar-usage-status-stack">
          {snapshot?.providerCoverage === 'codex-only-compatibility' ? (
            <div className="menu-bar-usage-notice" data-tone="warning" role="status">
              <span>{text.codexOnlyCompatibility}</span>
            </div>
          ) : null}
          {error && snapshot ? (
            <div className="menu-bar-usage-notice" data-tone="error" role="alert">
              <span>{text.failed}</span>
              <button type="button" onClick={() => void load()} disabled={loading}>
                {text.retry}
              </button>
            </div>
          ) : null}
        </div>

        <div className="menu-bar-usage-content" role="tabpanel">
          {!snapshot && error ? (
            <UsageLoadFailure language={surfaceSettings.language} loading={loading} onRetry={load} />
          ) : !snapshot ? (
            <UsageSkeleton label={text.loading} />
          ) : selectedProvider ? (
            <ProviderDetail provider={selectedProvider} language={surfaceSettings.language} />
          ) : (
            <AllProviders providers={snapshot.providers} language={surfaceSettings.language} onSelect={select} />
          )}
        </div>

        <footer className="menu-bar-usage-actions">
          <button className="menu-bar-usage-primary-action" type="button" onClick={() => void window.zeus?.openMenuBarUsageSettings?.('usage')}>
            {text.fullStatistics}
            <Chevron />
          </button>
          <div>
            <button type="button" onClick={() => void window.zeus?.showMainWindowFromMenuBarUsage?.()}>
              {text.showZeus}
            </button>
            <button type="button" onClick={() => void window.zeus?.quitFromMenuBarUsage?.()}>
              {text.quitZeus}
            </button>
          </div>
        </footer>
      </section>
    </main>
  );
}

function UsageLoadFailure(props: { language: Language; loading: boolean; onRetry: () => Promise<void> }) {
  const text = copy[props.language];
  return (
    <div className="menu-bar-usage-load-failure" role="alert">
      <strong>{text.failed}</strong>
      <span>{text.failedDetail}</span>
      <button type="button" onClick={() => void props.onRetry()} disabled={props.loading}>
        {props.loading ? text.loading : text.retry}
      </button>
    </div>
  );
}

function AllProviders(props: { providers: UsageProviderSummary[]; language: Language; onSelect: (providerId: string) => void }) {
  const text = copy[props.language];
  if (props.providers.length === 0) {
    return (
      <div className="menu-bar-usage-empty">
        <strong>{text.noProviders}</strong>
        <span>{text.noProvidersDetail}</span>
      </div>
    );
  }
  return (
    <section className="menu-bar-usage-provider-list" aria-label={text.allProviders}>
      {props.providers.map((provider) => {
        const urgent = findMostUrgentWindow(provider.rateLimitWindows);
        return (
          <button key={provider.providerId} type="button" onClick={() => props.onSelect(provider.providerId)}>
            <span className="menu-bar-usage-provider-symbol" aria-hidden="true">
              {provider.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="menu-bar-usage-provider-copy">
              <strong>{provider.name}</strong>
              <small>{provider.deleted ? text.deleted : provider.kind === 'subscription' ? provider.planType || text.subscription : text.api}</small>
            </span>
            <span className="menu-bar-usage-provider-value">
              <strong>{urgent ? formatPercent(urgent.remainingPercent / 100, props.language) : formatTokens(provider.todayLocal.totalTokens, props.language)}</strong>
              <small>{urgent ? text.quota : text.todayShort}</small>
            </span>
            <Chevron />
          </button>
        );
      })}
    </section>
  );
}

function ProviderDetail(props: { provider: UsageProviderSummary; language: Language }) {
  const { provider, language } = props;
  const text = copy[language];
  const urgent = useMemo(() => findMostUrgentWindow(provider.rateLimitWindows), [provider.rateLimitWindows]);
  const cacheAvailable = provider.providerId === 'codex' || provider.sevenDayLocal.cachedInputTokens > 0 || provider.sevenDayLocal.cacheWriteInputTokens > 0;
  return (
    <article className="menu-bar-usage-detail">
      {provider.kind === 'subscription' ? (
        <section className="menu-bar-usage-quota" aria-label={text.quota}>
          <div>
            <span>{urgent?.limitName || text.quota}</span>
            <strong>{urgent ? formatPercent(urgent.remainingPercent / 100, language) : '—'}</strong>
            <small>{urgent?.resetsAt ? formatReset(urgent.resetsAt, language, text.resets) : text.noQuota}</small>
          </div>
          <span
            className="menu-bar-usage-ring"
            style={{ '--remaining': urgent?.remainingPercent ?? 0 } as CSSProperties}
            role="progressbar"
            aria-label={text.quota}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={urgent?.remainingPercent}
          >
            <i aria-hidden="true" />
          </span>
        </section>
      ) : (
        <section className="menu-bar-usage-api-hero">
          <span>{text.today}</span>
          <strong>{formatTokens(provider.todayLocal.totalTokens, language)}</strong>
          <small>
            {formatTokens(provider.sevenDayLocal.totalTokens, language)} · {provider.sevenDayLocal.turnCount} {text.calls}
          </small>
        </section>
      )}

      {provider.rateLimitWindows.length > 0 ? <RateWindows windows={provider.rateLimitWindows} language={language} /> : null}

      <dl className="menu-bar-usage-metrics">
        <Metric
          label={provider.kind === 'api' ? text.sevenDaysShort : text.todayShort}
          accessibleLabel={provider.kind === 'api' ? text.sevenDays : text.today}
          value={formatTokens(provider.kind === 'api' ? provider.sevenDayLocal.totalTokens : provider.todayLocal.totalTokens, language)}
        />
        <Metric label={text.cache} value={cacheAvailable ? formatPercent(provider.sevenDayLocal.cacheHitRate, language, '—') : text.cacheUnsupported} />
        <Metric label={text.costShort} accessibleLabel={text.cost} value={formatCost(provider, language, text.noPrice)} hint={text.localEstimate} />
      </dl>

      {provider.officialCreditsUnlimited || provider.officialCreditBalance ? (
        <div className="menu-bar-usage-credit">
          <span>{text.officialCredits}</span>
          <strong>{provider.officialCreditsUnlimited ? text.unlimited : provider.officialCreditBalance}</strong>
        </div>
      ) : null}

      <DailyBars provider={provider} language={language} />
    </article>
  );
}

function RateWindows(props: { windows: CodexOfficialRateWindow[]; language: Language }) {
  const text = copy[props.language];
  return (
    <section className="menu-bar-usage-windows" aria-label={text.quota}>
      {props.windows.slice(0, 3).map((window, index) => (
        <div key={`${window.limitId ?? 'limit'}-${window.kind}-${index}`}>
          <span>
            <strong>{window.limitName || windowLabel(window, props.language)}</strong>
            <small>{window.resetsAt ? formatReset(window.resetsAt, props.language, text.resets) : ''}</small>
          </span>
          <span className="menu-bar-usage-progress" role="progressbar" aria-label={window.limitName || text.quota} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
            <i style={{ inlineSize: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }} />
          </span>
          <b>{formatPercent(window.remainingPercent / 100, props.language)}</b>
        </div>
      ))}
    </section>
  );
}

function DailyBars(props: { provider: UsageProviderSummary; language: Language }) {
  const text = copy[props.language];
  const buckets = props.provider.dailyLocal;
  if (buckets.length === 0)
    return (
      <div className="menu-bar-usage-chart-empty">
        <span>{text.recentUsage}</span>
        <small>{text.insufficientHistory}</small>
      </div>
    );
  const maximum = Math.max(...buckets.map((bucket) => bucket.totalTokens), 1);
  return (
    <figure className="menu-bar-usage-bars" aria-label={`${props.provider.name} ${text.recentUsage}`}>
      <figcaption>
        <span>{text.recentUsage}</span>
        <strong>{formatTokens(props.provider.sevenDayLocal.totalTokens, props.language)}</strong>
      </figcaption>
      <div>
        {buckets.map((bucket) => (
          <span key={bucket.date} aria-label={`${formatShortDate(bucket.date, props.language)} ${formatTokens(bucket.totalTokens, props.language)}`}>
            <i style={{ blockSize: `${Math.max(8, (bucket.totalTokens / maximum) * 100)}%` }} />
            <small>{formatShortDate(bucket.date, props.language)}</small>
          </span>
        ))}
      </div>
    </figure>
  );
}

function Metric(props: { label: string; accessibleLabel?: string; value: string; hint?: string }) {
  return (
    <div>
      <dt aria-label={props.accessibleLabel}>{props.label}</dt>
      <dd>{props.value}</dd>
      {props.hint ? <small>{props.hint}</small> : null}
    </div>
  );
}

function UsageSkeleton(props: { label: string }) {
  return (
    <div className="menu-bar-usage-skeleton" role="status" aria-label={props.label}>
      <span />
      <span />
      <span />
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}

function findMostUrgentWindow(windows: CodexOfficialRateWindow[]): CodexOfficialRateWindow | undefined {
  return windows.reduce<CodexOfficialRateWindow | undefined>((selected, candidate) => (!selected || candidate.remainingPercent < selected.remainingPercent ? candidate : selected), undefined);
}

function windowLabel(window: CodexOfficialRateWindow, language: Language): string {
  if (!window.windowDurationMins) return copy[language].quota;
  if (window.windowDurationMins >= 24 * 60) return language === 'zh-CN' ? `${Math.round(window.windowDurationMins / 1_440)} 日窗口` : `${Math.round(window.windowDurationMins / 1_440)} day window`;
  return language === 'zh-CN' ? `${Math.round(window.windowDurationMins / 60)} 小时窗口` : `${Math.round(window.windowDurationMins / 60)} hour window`;
}

function formatTokens(value: number, language: Language): string {
  return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value: number | null, language: Language, unavailable = ''): string {
  return value === null ? unavailable : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

function formatCost(provider: UsageProviderSummary, language: Language, unavailable: string): string {
  const value = provider.sevenDayLocal.apiEquivalentUsd;
  if (value === null || !provider.sevenDayLocal.priceCoverage) return unavailable;
  return `~${new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 4 }).format(value)}`;
}

function formatReset(timestamp: number, language: Language, prefix: string): string {
  return `${prefix} ${new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1_000))}`;
}

function formatUpdatedAt(value: string, language: Language, prefix: string): string {
  return `${prefix} ${new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))}`;
}

function formatShortDate(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { weekday: 'narrow' }).format(new Date(`${value}T12:00:00`));
}

function readStoredSnapshot(): UsageOverviewSnapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(snapshotStorageKey) ?? 'null') as UsageOverviewSnapshot | null;
    return value && Array.isArray(value.providers) && typeof value.updatedAt === 'string' ? value : null;
  } catch {
    return null;
  }
}

function storeSnapshot(value: UsageOverviewSnapshot): void {
  try {
    localStorage.setItem(snapshotStorageKey, JSON.stringify(value));
  } catch {
    // 本地快照写入失败不影响当前窗口继续显示实时结果。
  }
}

function readStoredSelection(): string {
  try {
    return localStorage.getItem(selectionStorageKey)?.trim() || 'all';
  } catch {
    return 'all';
  }
}

function storeSelection(value: string): void {
  try {
    localStorage.setItem(selectionStorageKey, value);
  } catch {
    // 选择偏好不可写时，仅保留当前窗口内状态。
  }
}
