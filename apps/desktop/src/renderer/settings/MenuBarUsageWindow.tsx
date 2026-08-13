import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CodexOfficialRateWindow, CodexUsageSummarySnapshot } from '@zeus/shared';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import './MenuBarUsageWindow.css';

type Language = AppShellSettings['appLanguage'];
type Appearance = AppShellSettings['appearance'];
type UsageClient = Pick<DashboardClient, 'loadCodexUsageSummary'>;

const copy = {
  'zh-CN': {
    title: 'Zeus',
    accountConnected: '账户已连接',
    loading: '正在读取用量',
    unavailable: '不可用',
    quota: '配额剩余',
    noQuota: '暂无可用配额数据',
    today: '今日官方 Token',
    sevenDays: '近 7 日官方 Token',
    cache: '缓存命中',
    credits: '估算点数',
    api: 'API 等价',
    localEstimate: '近 7 日 · 仅 Zeus · 估算值',
    fullStatistics: '查看完整统计',
    showZeus: '显示 Zeus',
    quitZeus: '退出 Zeus',
    configure: '前往配置',
    retry: '重新读取',
    signedOut: '尚未登录 Codex ChatGPT 账户，本地 Zeus 明细仍可查看。',
    unsupported: '当前登录方式不提供官方账户统计，本地 Zeus 明细仍可查看。',
    stale: '官方数据刷新失败，当前显示上次成功结果。',
    failed: '暂时无法更新用量，可重试或打开完整统计。',
    updated: '更新于',
    resets: '重置于',
  },
  'en-US': {
    title: 'Zeus',
    accountConnected: 'Account connected',
    loading: 'Loading usage',
    unavailable: 'Unavailable',
    quota: 'Quota remaining',
    noQuota: 'No quota data available',
    today: 'Official today',
    sevenDays: 'Official 7 days',
    cache: 'Cache hit',
    credits: 'Est. credits',
    api: 'API equivalent',
    localEstimate: 'Last 7 days · Zeus only · estimates',
    fullStatistics: 'View full statistics',
    showZeus: 'Show Zeus',
    quitZeus: 'Quit Zeus',
    configure: 'Open configuration',
    retry: 'Reload',
    signedOut: 'No Codex ChatGPT account is signed in. Zeus-local detail remains available.',
    unsupported: 'This sign-in method does not provide official usage. Zeus-local detail remains available.',
    stale: 'Official usage could not refresh. Showing the last successful result.',
    failed: 'Usage cannot be updated right now. Retry or open full statistics.',
    updated: 'Updated',
    resets: 'Resets',
  },
} as const;

export function MenuBarUsageWindow(props: { client: UsageClient; language: Language; appearance: Appearance }) {
  const text = copy[props.language];
  const [snapshot, setSnapshot] = useState<CodexUsageSummarySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);

  const load = useCallback(() => {
    if (requestRef.current) return requestRef.current;
    const request = (async () => {
      setLoading(true);
      try {
        setSnapshot(await props.client.loadCodexUsageSummary());
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
    const refreshWhenShown = () => void load();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void window.zeus?.hideMenuBarUsage?.();
    };
    window.addEventListener('focus', refreshWhenShown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('focus', refreshWhenShown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [load]);

  const urgentWindow = useMemo(() => findMostUrgentWindow(snapshot?.official.rateLimitWindows ?? []), [snapshot]);
  const officialState = snapshot?.official.state;
  const stateMessage = error
    ? text.failed
    : snapshot?.official.stale
      ? text.stale
      : officialState === 'signed_out'
        ? text.signedOut
        : officialState === 'unsupported'
          ? text.unsupported
          : officialState === 'unavailable'
            ? text.failed
            : null;

  return (
    <main className="menu-bar-usage-root" data-appearance={props.appearance} lang={props.language} aria-label={props.language === 'zh-CN' ? 'Zeus 菜单栏用量浮窗' : 'Zeus menu bar usage'}>
      <section className="menu-bar-usage-surface">
        <header className="menu-bar-usage-header">
          <span className="menu-bar-usage-identity">
            <span className="menu-bar-usage-mark" aria-hidden="true">
              Z
            </span>
            <span>
              <strong>{text.title}</strong>
              <small>{snapshot?.official.planType ?? (loading && !snapshot ? text.loading : officialState === 'available' ? text.accountConnected : text.unavailable)}</small>
            </span>
          </span>
          <span className="menu-bar-usage-freshness" data-loading={loading ? 'true' : 'false'}>
            <i aria-hidden="true" />
            {snapshot ? formatUpdatedAt(snapshot.updatedAt, props.language, text.updated) : text.loading}
          </span>
        </header>

        {stateMessage ? (
          <div className="menu-bar-usage-notice" data-tone={error ? 'error' : officialState === 'signed_out' ? 'attention' : 'muted'} role={error ? 'alert' : 'status'}>
            <span>{stateMessage}</span>
            {error ? (
              <button type="button" onClick={() => void load()} disabled={loading}>
                {text.retry}
              </button>
            ) : null}
          </div>
        ) : null}

        {loading && !snapshot ? (
          <UsageSkeleton label={text.loading} />
        ) : (
          <div className="menu-bar-usage-content">
            <section className="menu-bar-usage-quota" aria-label={text.quota}>
              <div>
                <span>{urgentWindow?.limitName || text.quota}</span>
                <strong>{urgentWindow ? formatPercent(urgentWindow.remainingPercent / 100, props.language) : '—'}</strong>
                <small>{urgentWindow?.resetsAt ? formatReset(urgentWindow.resetsAt, props.language, text.resets) : text.noQuota}</small>
              </div>
              <span
                className="menu-bar-usage-ring"
                style={{ '--remaining': urgentWindow?.remainingPercent ?? 0 } as CSSProperties}
                role="progressbar"
                aria-label={text.quota}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={urgentWindow?.remainingPercent}
              >
                <i aria-hidden="true" />
              </span>
            </section>

            <dl className="menu-bar-usage-token-row">
              <Metric label={text.today} value={formatTokens(snapshot?.officialTodayTokens ?? null, props.language, text.unavailable)} />
              <Metric label={text.sevenDays} value={formatTokens(snapshot?.officialSevenDayTokens ?? null, props.language, text.unavailable)} />
            </dl>

            <section className="menu-bar-usage-estimates" aria-label={text.localEstimate}>
              <dl>
                <Metric label={text.cache} value={formatPercent(snapshot?.localSevenDay.cacheHitRate ?? null, props.language, text.unavailable)} compact />
                <Metric label={text.credits} value={formatEstimate(snapshot?.localSevenDay.estimatedCredits ?? null, 'credits', props.language, text.unavailable)} compact />
                <Metric label={text.api} value={formatEstimate(snapshot?.localSevenDay.apiEquivalentUsd ?? null, 'usd', props.language, text.unavailable)} compact />
              </dl>
              <small>{text.localEstimate}</small>
            </section>
          </div>
        )}

        <footer className="menu-bar-usage-actions">
          {officialState === 'signed_out' ? (
            <button className="menu-bar-usage-primary-action" type="button" onClick={() => void window.zeus?.openMenuBarUsageSettings?.('runtime')}>
              {text.configure}
            </button>
          ) : (
            <button className="menu-bar-usage-primary-action" type="button" onClick={() => void window.zeus?.openMenuBarUsageSettings?.('usage')}>
              {text.fullStatistics}
              <span aria-hidden="true">›</span>
            </button>
          )}
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

function Metric(props: { label: string; value: string; compact?: boolean }) {
  return (
    <div className={props.compact ? 'is-compact' : undefined}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}

function UsageSkeleton(props: { label: string }) {
  return (
    <div className="menu-bar-usage-skeleton" role="status" aria-label={props.label}>
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function findMostUrgentWindow(windows: CodexOfficialRateWindow[]): CodexOfficialRateWindow | undefined {
  let selected: CodexOfficialRateWindow | undefined;
  for (const candidate of windows) {
    if (!selected || candidate.remainingPercent < selected.remainingPercent) selected = candidate;
  }
  return selected;
}

function formatTokens(value: number | null, language: Language, unavailable: string): string {
  return value === null ? unavailable : new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatPercent(value: number | null, language: Language, unavailable = ''): string {
  return value === null ? unavailable : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

function formatEstimate(value: number | null, kind: 'credits' | 'usd', language: Language, unavailable: string): string {
  if (value === null) return unavailable;
  const formatted = new Intl.NumberFormat(language, { minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 4 }).format(value);
  return kind === 'usd' ? `~$${formatted}` : `~${formatted}`;
}

function formatReset(timestamp: number, language: Language, prefix: string): string {
  const formatted = new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1000));
  return `${prefix} ${formatted}`;
}

function formatUpdatedAt(value: string, language: Language, prefix: string): string {
  const formatted = new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  return `${prefix} ${formatted}`;
}
