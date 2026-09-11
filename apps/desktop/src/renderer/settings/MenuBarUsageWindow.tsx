import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
    noProvidersDetail: '使用 AI 后，这里会显示各个服务的用量。',
    quota: '配额剩余',
    noQuota: '暂无官方配额数据',
    todayToken: '今日 token',
    available: '可用',
    localOnly: '本机统计',
    staleStatus: '数据过期',
    signedOut: '未登录',
    unavailableStatus: '配额异常',
    removedStatus: '已移除',
    officialAndLocal: '官方配额 + Zeus 本地统计',
    localQuotaUnavailable: 'Zeus 本地统计；官方配额暂不可用',
    localQuotaSignIn: 'Zeus 本地统计；登录后可查看官方配额',
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
    fullStatistics: '用量详情',
    showZeus: '显示 Zeus',
    quitZeus: '退出 Zeus',
    retry: '重新读取',
    refreshed: '刷新',
    stale: '上次成功结果',
    failed: '暂时无法更新用量',
    failedDetail: '未能读取本地用量数据，请重试。',
    codexOnlyCompatibility: '当前后台版本只能显示 Codex 用量；后台更新后将显示其他服务。',
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
    noProvidersDetail: 'Usage for each AI service appears here after you use it.',
    quota: 'Quota remaining',
    noQuota: 'No official quota data',
    todayToken: 'Today tokens',
    available: 'Available',
    localOnly: 'Local stats',
    staleStatus: 'Stale data',
    signedOut: 'Signed out',
    unavailableStatus: 'Quota error',
    removedStatus: 'Removed',
    officialAndLocal: 'Official quota + Zeus local stats',
    localQuotaUnavailable: 'Zeus local stats; official quota unavailable',
    localQuotaSignIn: 'Zeus local stats; sign in for official quota',
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
    fullStatistics: 'Usage details',
    showZeus: 'Show Zeus',
    quitZeus: 'Quit Zeus',
    retry: 'Reload',
    refreshed: 'Refreshed',
    stale: 'Last successful result',
    failed: 'Usage cannot be updated',
    failedDetail: 'Local usage data could not be read. Please retry.',
    codexOnlyCompatibility: 'The current background service can only show Codex usage. Other services will appear after it is updated.',
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
    if (!snapshot || selection === 'all' || snapshot.providers.some((provider) => provider.providerId === selection)) return;
    setSelection('all');
    storeSelection('all');
  }, [selection, snapshot]);

  const select = (providerId: string) => {
    setSelection(providerId);
    storeSelection(providerId);
  };
  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const currentIndex = tabs.indexOf(event.currentTarget);
    if (currentIndex < 0 || tabs.length === 0) return;

    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (currentIndex + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;

    event.preventDefault();
    nextTab.click();
    nextTab.focus();
  };
  const selectedProvider = snapshot?.providers.find((provider) => provider.providerId === selection) ?? null;
  const updatedAt = selectedProvider?.updatedAt ?? snapshot?.updatedAt;
  const stale = Boolean(selectedProvider?.stale || error);
  const freshness = updatedAt ? formatUpdatedAt(updatedAt, surfaceSettings.language, stale ? text.stale : text.refreshed) : loading ? text.loading : error ? text.failed : text.loading;

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
              <small className="menu-bar-usage-freshness" data-stale={stale && !loading ? 'true' : 'false'} aria-live="polite">
                {freshness}
              </small>
            </span>
          </span>
          <button className="menu-bar-usage-refresh" type="button" aria-label={loading ? text.loading : text.retry} title={loading ? text.loading : text.retry} aria-busy={loading} disabled={loading} onClick={() => void load()}>
            {loading ? <RefreshPendingIcon /> : <RefreshIcon />}
          </button>
        </header>

        <nav className="menu-bar-usage-tabs" role="tablist" aria-label={text.allProviders}>
          <button type="button" role="tab" aria-selected={selection === 'all'} tabIndex={selection === 'all' ? 0 : -1} onClick={() => select('all')} onKeyDown={handleTabKeyDown}>
            {text.all}
          </button>
          {snapshot?.providers.map((provider) => (
            <button
              key={provider.providerId}
              type="button"
              role="tab"
              aria-label={providerDisplayName(provider)}
              aria-selected={selection === provider.providerId}
              tabIndex={selection === provider.providerId ? 0 : -1}
              title={provider.deleted ? providerDisplayName(provider) : undefined}
              onClick={() => select(provider.providerId)}
              onKeyDown={handleTabKeyDown}
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
          </button>
          <button type="button" onClick={() => void window.zeus?.showMainWindowFromMenuBarUsage?.()}>
            {text.showZeus}
          </button>
          <button type="button" onClick={() => void window.zeus?.quitFromMenuBarUsage?.()}>
            {text.quitZeus}
          </button>
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
      <ProviderSummaryCard provider={provider} window={urgent} language={language} />

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

type ProviderStatusTone = 'success' | 'warning' | 'danger' | 'info';

function ProviderSummaryCard(props: { provider: UsageProviderSummary; window?: CodexOfficialRateWindow; language: Language }) {
  const { provider, language } = props;
  const text = copy[language];
  const name = providerDisplayName(provider);
  const status = providerStatus(provider, language);
  const quotaHeading = props.window ? windowRemainingLabel(props.window, language) : language === 'zh-CN' ? '额度' : 'Quota';
  const todayValue = formatIncompleteTokens(provider.todayLocal.totalTokens, provider.todayLocalComplete, language);
  const quotaValue = props.window ? formatPercent(props.window.remainingPercent / 100, language) : text.noQuota;
  const source = props.window ? text.officialAndLocal : provider.officialState === 'signed_out' ? text.localQuotaSignIn : text.localQuotaUnavailable;
  return (
    <section className="menu-bar-usage-account-card" data-status={status.tone} aria-label={`${name}，${status.label}，${quotaHeading} ${quotaValue}，${text.todayToken} ${todayValue}`}>
      <header className="menu-bar-usage-account-header">
        <span className="menu-bar-usage-account-identity">
          <span className="menu-bar-usage-account-symbol" aria-hidden="true">
            {name.slice(0, 1).toUpperCase()}
          </span>
          <strong>{name}</strong>
        </span>
        <span className="menu-bar-usage-account-state" data-tone={status.tone}>
          {status.label}
        </span>
      </header>

      <div className="menu-bar-usage-account-body">
        <div className="menu-bar-usage-account-quota" data-empty={props.window ? 'false' : 'true'}>
          <small>{quotaHeading}</small>
          <strong>{quotaValue}</strong>
          {props.window ? (
            <>
              <span className="menu-bar-usage-progress" role="progressbar" aria-label={quotaHeading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={props.window.remainingPercent}>
                <i style={{ inlineSize: `${Math.max(0, Math.min(100, props.window.remainingPercent))}%` }} />
              </span>
              <time dateTime={props.window.resetsAt ? new Date(props.window.resetsAt * 1_000).toISOString() : undefined} title={props.window.resetsAt ? formatReset(props.window.resetsAt, language, text.resets) : undefined}>
                {props.window.resetsAt ? formatResetTime(props.window.resetsAt, language) : '—'}
              </time>
            </>
          ) : (
            <small>{provider.officialState === 'signed_out' ? text.signedOut : text.localOnly}</small>
          )}
        </div>
        <div className="menu-bar-usage-account-today">
          <small>{text.todayToken}</small>
          <strong>{todayValue}</strong>
        </div>
      </div>

      <small className="menu-bar-usage-account-source" title={source}>
        {source}
      </small>
    </section>
  );
}

function providerStatus(provider: UsageProviderSummary, language: Language): { label: string; tone: ProviderStatusTone } {
  const text = copy[language];
  if (provider.deleted) return { label: text.removedStatus, tone: 'danger' };
  if (provider.stale) return { label: text.staleStatus, tone: 'info' };
  if (provider.officialState === 'available') return { label: text.available, tone: 'success' };
  if (provider.officialState === 'signed_out') return { label: text.signedOut, tone: 'warning' };
  if (provider.officialState === 'unavailable') return { label: text.unavailableStatus, tone: 'danger' };
  return { label: text.localOnly, tone: 'warning' };
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

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13 4.5V1.75m0 0h-2.75M13 1.75l-1.6 1.6A5 5 0 1 0 12.78 8" />
    </svg>
  );
}

function RefreshPendingIcon() {
  return (
    <svg className="menu-bar-usage-hourglass" viewBox="0 0 256 256" aria-hidden="true">
      <path d="M211.31 196.69A16 16 0 0 1 200 224H56a16 16 0 0 1-11.32-27.31L116.43 128 44.82 59.44a1.59 1.59 0 0 0-.13-.13A16 16 0 0 1 56 32h144a16 16 0 0 1 11.32 27.31 1.59 1.59 0 0 0-.13.13L139.57 128l71.61 68.56a1.59 1.59 0 0 0 .13.13Z" />
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

function windowRemainingLabel(window: CodexOfficialRateWindow, language: Language): string {
  if (window.limitName) return language === 'zh-CN' ? `${window.limitName}剩余` : `${window.limitName} remaining`;
  if (!window.windowDurationMins) return copy[language].quota;
  if (window.windowDurationMins >= 24 * 60) return language === 'zh-CN' ? `${Math.round(window.windowDurationMins / 1_440)} 日剩余` : `${Math.round(window.windowDurationMins / 1_440)} day remaining`;
  return language === 'zh-CN' ? `${Math.round(window.windowDurationMins / 60)} 小时剩余` : `${Math.round(window.windowDurationMins / 60)} hour remaining`;
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

function formatResetTime(timestamp: number, language: Language): string {
  return new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1_000));
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
