import { useCallback, useEffect, useRef, useState } from 'react';
import { calculateUncachedInputTokens, type CodexOfficialRateWindow, type UsageOverviewSnapshot, type UsageProviderSummary } from '@zeus/shared';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
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
    todayShort: '今日 Zeus Token',
    todaySummary: '今日',
    sevenDays: '近 7 日 Zeus Token',
    sevenDaysShort: '近 7 日 Zeus',
    sevenDaysSummary: '近 7 日',
    cache: '缓存命中率',
    cacheUnsupported: '供应源未提供',
    cost: '近 7 日估算费用',
    costShort: '7 日估算费用',
    noPrice: '暂无价格',
    localEstimate: 'Zeus 本地估算',
    localUsage: 'Zeus 本地统计',
    localUsageIncomplete: 'Zeus 本地记录不完整',
    recentUsage: 'Zeus 本地 Token',
    accountRecentUsage: 'Codex 账户 Token',
    officialUsageUnavailable: '官方账户暂未提供日用量',
    insufficientHistory: '用量积累后显示趋势',
    missingDay: '暂无数据',
    fullStatistics: '查看完整统计',
    showZeus: '显示 Zeus',
    quitZeus: '退出 Zeus',
    retry: '重新读取',
    stale: '上次成功结果',
    failed: '暂时无法更新用量',
    failedDetail: '未能读取本地用量数据，请重试。',
    codexOnlyCompatibility: '当前旧执行宿主仅能汇总 Codex；安全交接后恢复全部供应源。',
    updated: '更新于',
    resets: '重置于',
    subscription: '订阅账户',
    api: 'API 供应源',
    deleted: '配置已移除，历史用量保留',
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
    todayShort: 'Zeus today',
    todaySummary: 'Today',
    sevenDays: 'Zeus tokens in 7 days',
    sevenDaysShort: 'Zeus · 7 days',
    sevenDaysSummary: '7 days',
    cache: 'Cache hit rate',
    cacheUnsupported: 'Not provided',
    cost: 'Estimated cost · 7 days',
    costShort: '7-day estimate',
    noPrice: 'No pricing',
    localEstimate: 'Zeus local estimate',
    localUsage: 'Zeus local usage',
    localUsageIncomplete: 'Incomplete Zeus local history',
    recentUsage: 'Zeus local tokens',
    accountRecentUsage: 'Codex account tokens',
    officialUsageUnavailable: 'Official daily account usage is unavailable',
    insufficientHistory: 'A trend appears after usage is recorded',
    missingDay: 'No data',
    fullStatistics: 'View full statistics',
    showZeus: 'Show Zeus',
    quitZeus: 'Quit Zeus',
    retry: 'Reload',
    stale: 'Last successful result',
    failed: 'Usage cannot be updated',
    failedDetail: 'Local usage data could not be read. Please retry.',
    codexOnlyCompatibility: 'The current legacy host can summarize Codex only. All providers return after a safe handoff.',
    updated: 'Updated',
    resets: 'Resets',
    subscription: 'Subscription',
    api: 'API provider',
    deleted: 'Configuration removed; usage history retained',
  },
} as const;

export function MenuBarUsageWindow(props: { client: UsageClient; language: Language; appearance: Appearance }) {
  const [surfaceSettings, setSurfaceSettings] = useState<{ language: Language; appearance: Appearance }>({ language: props.language, appearance: props.appearance });
  const text = copy[surfaceSettings.language];
  const [snapshot, setSnapshot] = useState<UsageOverviewSnapshot | null>(() => readStoredSnapshot());
  const [selection, setSelection] = useState(() => readStoredSelection());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  useApplicationErrorDialog(error, {
    language: surfaceSettings.language === 'zh-CN' ? 'zh-CN' : 'en',
  });

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
        setError(cause);
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
  const selectedProviderName = selectedProvider ? providerDisplayName(selectedProvider) : null;
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
              <small title={selectedProvider?.deleted ? (selectedProviderName ?? undefined) : undefined}>{selectedProvider ? providerDisplayName(selectedProvider, true) : text.allProviders}</small>
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
            <button
              key={provider.providerId}
              type="button"
              role="tab"
              aria-label={providerDisplayName(provider)}
              aria-selected={selection === provider.providerId}
              title={provider.deleted ? providerDisplayName(provider) : undefined}
              onClick={() => select(provider.providerId)}
            >
              {providerDisplayName(provider, true)}
            </button>
          ))}
        </nav>

        <div className="menu-bar-usage-status-stack">
          {snapshot?.providerCoverage === 'codex-only-compatibility' ? (
            <div className="menu-bar-usage-notice" data-tone="warning" role="status">
              <span>{text.codexOnlyCompatibility}</span>
            </div>
          ) : null}
        </div>

        <div className="menu-bar-usage-content" role="tabpanel">
          {!snapshot && error ? (
            <UsageLoadFailure error={error} language={surfaceSettings.language} loading={loading} onRetry={load} />
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

function UsageLoadFailure(props: { error: unknown; language: Language; loading: boolean; onRetry: () => Promise<void> }) {
  const text = copy[props.language];
  return (
    <div className="menu-bar-usage-load-failure" role="alert">
      <VisibleApplicationError error={props.error} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
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
        const fullName = providerDisplayName(provider);
        const providerDetail = provider.deleted
          ? text.deleted
          : provider.kind === 'subscription'
            ? [provider.planType || text.subscription, urgent ? `${text.quota} ${formatPercent(urgent.remainingPercent / 100, props.language)}` : null].filter(Boolean).join(' · ')
            : text.api;
        return (
          <button key={provider.providerId} type="button" title={provider.deleted ? fullName : undefined} onClick={() => props.onSelect(provider.providerId)}>
            <span className="menu-bar-usage-provider-symbol" aria-hidden="true">
              {fullName.slice(0, 1).toUpperCase()}
            </span>
            <span className="menu-bar-usage-provider-copy">
              <strong title={provider.deleted ? fullName : undefined}>{fullName}</strong>
              <small>{providerDetail}</small>
            </span>
            <span className="menu-bar-usage-provider-value">
              <strong>{formatIncompleteTokens(provider.todayLocal.totalTokens, provider.todayLocalComplete, props.language)}</strong>
              <small>{text.todayShort}</small>
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
  const urgent = findMostUrgentWindow(provider.rateLimitWindows);
  const cacheAvailable = provider.cacheUsageAvailable ?? (provider.providerId === 'codex' || provider.sevenDayLocal.cachedInputTokens > 0 || provider.sevenDayLocal.cacheWriteInputTokens > 0);
  const sevenDayLocalComplete = provider.sevenDayLocalComplete === true;
  return (
    <article className="menu-bar-usage-detail">
      <section className="menu-bar-usage-token-hero" aria-label={text.today}>
        <span>{text.today}</span>
        <strong>{formatIncompleteTokens(provider.todayLocal.totalTokens, provider.todayLocalComplete, language)}</strong>
        <small>{provider.todayLocalComplete ? text.localUsage : text.localUsageIncomplete}</small>
      </section>

      {urgent ? <QuotaSummary window={urgent} language={language} /> : null}

      <dl className="menu-bar-usage-metrics">
        <Metric
          label={text.sevenDaysShort}
          accessibleLabel={text.sevenDays}
          value={formatIncompleteTokens(provider.sevenDayLocal.totalTokens, provider.sevenDayLocalComplete, language)}
          hint={provider.sevenDayLocalComplete ? text.localUsage : text.localUsageIncomplete}
        />
        <Metric
          label={text.cache}
          value={!sevenDayLocalComplete ? '—' : cacheAvailable ? formatPercent(provider.sevenDayLocal.cacheHitRate, language, '—') : text.cacheUnsupported}
          hint={
            sevenDayLocalComplete && cacheAvailable
              ? `${language === 'zh-CN' ? '命中' : 'Hit'} ${formatTokens(provider.sevenDayLocal.cachedInputTokens, language)} · ${language === 'zh-CN' ? '未命中' : 'Miss'} ${formatTokens(calculateUncachedInputTokens(provider.sevenDayLocal), language)}`
              : undefined
          }
        />
        <Metric label={text.costShort} accessibleLabel={text.cost} value={sevenDayLocalComplete ? formatCost(provider, language, text.noPrice) : '—'} hint={sevenDayLocalComplete ? text.localEstimate : text.localUsageIncomplete} />
      </dl>

      <DailyBars provider={provider} language={language} />
    </article>
  );
}

function QuotaSummary(props: { window: CodexOfficialRateWindow; language: Language }) {
  const text = copy[props.language];
  const label = props.window.limitName || windowLabel(props.window, props.language);
  return (
    <section className="menu-bar-usage-quota-summary" aria-label={text.quota}>
      <span>
        <strong>{label}</strong>
        <small>{props.window.resetsAt ? formatReset(props.window.resetsAt, props.language, text.resets) : text.noQuota}</small>
      </span>
      <span className="menu-bar-usage-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.window.remainingPercent}>
        <i style={{ inlineSize: `${Math.max(0, Math.min(100, props.window.remainingPercent))}%` }} />
      </span>
      <b>{formatPercent(props.window.remainingPercent / 100, props.language)}</b>
    </section>
  );
}

function DailyBars(props: { provider: UsageProviderSummary; language: Language }) {
  const text = copy[props.language];
  const accountUsage = props.provider.kind === 'subscription';
  const buckets = accountUsage ? (props.provider.dailyAccount ?? null) : props.provider.dailyLocal;
  const label = accountUsage ? text.accountRecentUsage : text.recentUsage;
  if (buckets === null)
    return (
      <div className="menu-bar-usage-chart-empty">
        <span>{label}</span>
        <small>{text.officialUsageUnavailable}</small>
      </div>
    );
  if (buckets.length === 0 && (accountUsage || !props.provider.collectionStartedAt))
    return (
      <div className="menu-bar-usage-chart-empty">
        <span>{label}</span>
        <small>{text.insufficientHistory}</small>
      </div>
    );
  const slots = buildDailySlots(props.provider, buckets, accountUsage);
  const maximum = Math.max(...slots.flatMap((slot) => (slot.totalTokens && slot.totalTokens > 0 ? [slot.totalTokens] : [])), 1);
  const todayValue = accountUsage ? formatOptionalTokens(props.provider.accountTodayTokens, props.language) : formatIncompleteTokens(props.provider.todayLocal.totalTokens, props.provider.todayLocalComplete, props.language);
  const sevenDayValue = accountUsage ? formatOptionalTokens(props.provider.accountSevenDayTokens, props.language) : formatIncompleteTokens(props.provider.sevenDayLocal.totalTokens, props.provider.sevenDayLocalComplete, props.language);
  return (
    <figure className="menu-bar-usage-bars" aria-label={`${providerDisplayName(props.provider)} ${label}`}>
      <figcaption>
        <span>{label}</span>
        <dl>
          <div>
            <dt>{text.todaySummary}</dt>
            <dd>{todayValue}</dd>
          </div>
          <div>
            <dt>{text.sevenDaysSummary}</dt>
            <dd>{sevenDayValue}</dd>
          </div>
        </dl>
      </figcaption>
      <div className="menu-bar-usage-bars-plot">
        {slots.map((slot) => {
          const state = slot.totalTokens === null ? 'missing' : slot.totalTokens === 0 ? 'zero' : 'positive';
          const value = slot.totalTokens === null ? text.missingDay : `${formatTokens(slot.totalTokens, props.language)} Token`;
          return (
            <span key={slot.date} data-state={state} aria-label={`${formatShortDate(slot.date, props.language)} ${value}`} title={`${slot.date} · ${value}`}>
              <span className="menu-bar-usage-bar-slot">
                {slot.totalTokens === null ? <em aria-hidden="true">—</em> : <i style={{ blockSize: slot.totalTokens === 0 ? '2px' : `${Math.max(10, (slot.totalTokens / maximum) * 100)}%` }} />}
              </span>
              <small>{formatShortDate(slot.date, props.language)}</small>
            </span>
          );
        })}
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

function providerDisplayName(provider: UsageProviderSummary, compact = false): string {
  const name = provider.deleted ? provider.sourceId.trim() || provider.providerId : provider.name;
  if (!compact || !provider.deleted || name.length <= 22) return name;
  return `${name.slice(0, 12)}…${name.slice(-8)}`;
}

function buildDailySlots(provider: UsageProviderSummary, buckets: ReadonlyArray<{ date: string; totalTokens: number }>, accountUsage: boolean): Array<{ date: string; totalTokens: number | null }> {
  const bucketsByDate = new Map(buckets.map((bucket) => [bucket.date, bucket.totalTokens]));
  const collectionStart = accountUsage ? null : timestampDateKey(provider.collectionStartedAt);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(date.getDate() - 6 + index);
    const dateKey = localDateKey(date);
    const recorded = bucketsByDate.get(dateKey);
    return {
      date: dateKey,
      totalTokens: recorded === undefined ? (!accountUsage && collectionStart !== null && dateKey >= collectionStart ? 0 : null) : Math.max(0, recorded),
    };
  });
}

function timestampDateKey(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : localDateKey(date);
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function windowLabel(window: CodexOfficialRateWindow, language: Language): string {
  if (!window.windowDurationMins) return copy[language].quota;
  if (window.windowDurationMins >= 24 * 60) return language === 'zh-CN' ? `${Math.round(window.windowDurationMins / 1_440)} 日窗口` : `${Math.round(window.windowDurationMins / 1_440)} day window`;
  return language === 'zh-CN' ? `${Math.round(window.windowDurationMins / 60)} 小时窗口` : `${Math.round(window.windowDurationMins / 60)} hour window`;
}

function formatTokens(value: number, language: Language): string {
  return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatIncompleteTokens(value: number, complete: boolean | undefined, language: Language): string {
  const formatted = formatTokens(value, language);
  return complete === true ? formatted : `≥${formatted}`;
}

function formatOptionalTokens(value: number | null | undefined, language: Language): string {
  return value === null || value === undefined ? '—' : formatTokens(value, language);
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
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
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
