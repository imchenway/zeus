import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CodexOfficialRateWindow, UsageOverviewSnapshot, UsageProviderSummary } from '@zeus/shared';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import './MenuBarUsageWindow.css';

type Language = AppShellSettings['appLanguage'];
type Appearance = AppShellSettings['appearance'];
type UsageClient = Pick<DashboardClient, 'loadUsageOverview' | 'subscribeEvents'>;

const snapshotStorageKey = 'zeus.menu-bar-usage.snapshot';
const selectionStorageKey = 'zeus.menu-bar-usage.selection';
/** 菜单栏独立保存供应商顺序，不改变供应商配置或后台统计顺序。 */
const providerOrderStorageKey = 'zeus.menu-bar-usage.provider-order';

const copy = {
  'zh-CN': {
    all: '全部',
    allProviders: '全部供应源',
    reorderHint: '拖动手柄排序，也可聚焦手柄后按 ↑ ↓',
    reorder: '排序',
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
    recentUsage: 'Zeus 本地 Token',
    accountRecentUsage: 'Codex 账户 Token',
    officialUsageUnavailable: '官方账户暂未提供日用量',
    insufficientHistory: '用量积累后显示趋势',
    missingDay: '暂无数据',
    fullStatistics: '用量详情',
    showZeus: '显示 Zeus',
    quitZeus: '退出 Zeus',
    retry: '重新读取',
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
    reorderHint: 'Drag to reorder, or focus a handle and press ↑ ↓',
    reorder: 'Reorder',
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
    recentUsage: 'Zeus local tokens',
    accountRecentUsage: 'Codex account tokens',
    officialUsageUnavailable: 'Official daily account usage is unavailable',
    insufficientHistory: 'A trend appears after usage is recorded',
    missingDay: 'No data',
    fullStatistics: 'Usage details',
    showZeus: 'Show Zeus',
    quitZeus: 'Quit Zeus',
    retry: 'Reload',
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
  /** 首次读取排序偏好，实时快照刷新不覆盖用户选择。 */
  const [providerOrder, setProviderOrder] = useState(readStoredProviderOrder);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
  /** 已保存供应商按偏好排列，新出现的供应商沿用后台顺序追加。 */
  const providerRanks = new Map(providerOrder.map((id, index) => [id, index]));
  /** 列表与标签始终使用同一份排序结果，不修改原始快照。 */
  const providers = [...(snapshot?.providers ?? [])].sort((left, right) => (providerRanks.get(left.providerId) ?? providerOrder.length) - (providerRanks.get(right.providerId) ?? providerOrder.length));
  /** 拖拽与键盘共用移动入口，忽略已失效的供应商或越界目标。 */
  const moveProvider = (providerId: string, targetId: string) => {
    /** 当前可见顺序也是保存后的顺序，失效供应商不重新插入。 */
    const next = providers.map((provider) => provider.providerId);
    /** 起点和终点都必须仍在当前快照中。 */
    const sourceIndex = next.indexOf(providerId);
    const targetIndex = next.indexOf(targetId);
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, providerId);
    setProviderOrder(next);
    try {
      localStorage.setItem(providerOrderStorageKey, JSON.stringify(next));
    } catch {
      // 存储不可写时仍允许本次窗口内排序，与现有选择偏好保持一致。
    }
  };
  const selectedProvider = providers.find((provider) => provider.providerId === selection) ?? null;
  // 顶部时间表示本次用量读取完成时间，供应源数据的新鲜度仍由卡片单独提示。
  const updatedAt = snapshot?.updatedAt;
  const stale = Boolean(selectedProvider?.stale || error);
  const freshness = updatedAt ? formatUpdatedAt(updatedAt, surfaceSettings.language, stale ? text.stale : '') : loading ? text.loading : error ? text.failed : text.loading;

  return (
    <main className="menu-bar-usage-root" data-appearance={surfaceSettings.appearance} lang={surfaceSettings.language} aria-label={surfaceSettings.language === 'zh-CN' ? 'Zeus 菜单栏用量浮窗' : 'Zeus menu bar usage'}>
      <section className="menu-bar-usage-surface">
        <header className="menu-bar-usage-header">
          <span className="menu-bar-usage-identity">
            <span className="menu-bar-usage-mark" aria-hidden="true" />
            <strong>Zeus</strong>
          </span>
          <span className="menu-bar-usage-refresh-status">
            <small className="menu-bar-usage-freshness" data-stale={stale && !loading ? 'true' : 'false'} aria-live="polite" title={freshness}>
              {freshness}
            </small>
            <button className="menu-bar-usage-refresh" type="button" aria-label={loading ? text.loading : text.retry} title={loading ? text.loading : text.retry} aria-busy={loading} disabled={loading} onClick={() => void load()}>
              {loading ? <RefreshPendingIcon /> : <RefreshIcon />}
            </button>
          </span>
        </header>

        <nav className="menu-bar-usage-tabs" role="tablist" aria-label={text.allProviders}>
          <button type="button" role="tab" aria-selected={selection === 'all'} tabIndex={selection === 'all' ? 0 : -1} onClick={() => select('all')} onKeyDown={handleTabKeyDown}>
            {text.all}
          </button>
          {providers.map((provider) => (
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
            <AllProviders providers={providers} language={surfaceSettings.language} onSelect={select} onMove={moveProvider} />
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

/** 全部供应商列表：独立手柄排序，点击内容仍打开供应商详情。 */
function AllProviders(props: { providers: UsageProviderSummary[]; language: Language; onSelect: (providerId: string) => void; onMove: (providerId: string, targetId: string) => void }) {
  const text = copy[props.language];
  /** 只接收从本列表手柄发起的拖拽，外部文本和文件不会修改顺序。 */
  const [draggedId, setDraggedId] = useState<string | null>(null);
  /** 落点仅用于提示，松手后才提交排序，避免悬停时列表来回跳动。 */
  const [dropId, setDropId] = useState<string | null>(null);
  /** 键盘移动后向读屏播报当前位置。 */
  const [announcement, setAnnouncement] = useState('');
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
      {props.providers.length > 1 ? (
        <small className="menu-bar-usage-reorder-hint" id="menu-bar-usage-reorder-hint">
          {text.reorderHint}
        </small>
      ) : null}
      <span className="menu-bar-usage-sr-only" role="status">
        {announcement}
      </span>
      {props.providers.map((provider, index) => {
        const fullName = providerDisplayName(provider);
        const providerDetail = provider.deleted
          ? text.deleted
          : provider.kind === 'subscription'
            ? [provider.planType || text.subscription, provider.rateLimitWindows.length ? (props.language === 'zh-CN' ? `${provider.rateLimitWindows.length} 项官方额度` : `${provider.rateLimitWindows.length} quota windows`) : null]
                .filter(Boolean)
                .join(' · ')
            : text.api;
        return (
          <div
            className="menu-bar-usage-provider-row"
            key={provider.providerId}
            data-dragging={draggedId === provider.providerId}
            data-drop={dropId === provider.providerId && draggedId !== provider.providerId ? (props.providers.findIndex((entry) => entry.providerId === draggedId) < index ? 'after' : 'before') : undefined}
            onDragOver={(event) => {
              if (!draggedId) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropId(provider.providerId);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropId(null);
            }}
            onDrop={(event) => {
              if (!draggedId) return;
              event.preventDefault();
              props.onMove(draggedId, provider.providerId);
              setDraggedId(null);
              setDropId(null);
            }}
          >
            {props.providers.length > 1 ? (
              <button
                className="menu-bar-usage-drag-handle"
                type="button"
                draggable
                aria-label={`${text.reorder} ${fullName}`}
                aria-describedby="menu-bar-usage-reorder-hint"
                title={text.reorderHint}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', provider.providerId);
                  setDraggedId(provider.providerId);
                }}
                onDragEnd={() => {
                  setDraggedId(null);
                  setDropId(null);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                  event.preventDefault();
                  /** 边界按键保持位置和焦点，不循环跳到另一端。 */
                  const targetIndex = index + (event.key === 'ArrowUp' ? -1 : 1);
                  const target = props.providers[targetIndex];
                  if (!target) return;
                  props.onMove(provider.providerId, target.providerId);
                  setAnnouncement(`${fullName} · ${targetIndex + 1} / ${props.providers.length}`);
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M5 3h.01M11 3h.01M5 8h.01M11 8h.01M5 13h.01M11 13h.01" />
                </svg>
              </button>
            ) : null}
            <button className="menu-bar-usage-provider-open" type="button" title={provider.deleted ? fullName : undefined} onClick={() => props.onSelect(provider.providerId)}>
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
          </div>
        );
      })}
    </section>
  );
}

function ProviderDetail(props: { provider: UsageProviderSummary; language: Language }) {
  const { provider, language } = props;
  const text = copy[language];
  const cacheAvailable = provider.cacheUsageAvailable ?? (provider.providerId === 'codex' || provider.sevenDayLocal.cachedInputTokens > 0 || provider.sevenDayLocal.cacheWriteInputTokens > 0);
  const sevenDayLocalComplete = provider.sevenDayLocalComplete === true;
  return (
    <article className="menu-bar-usage-detail">
      <ProviderSummaryCard provider={provider} language={language} />

      <dl className="menu-bar-usage-metrics">
        <Metric label={text.sevenDaysShort} accessibleLabel={text.sevenDays} value={formatIncompleteTokens(provider.sevenDayLocal.totalTokens, provider.sevenDayLocalComplete, language)} />
        <Metric label={text.cache} value={!sevenDayLocalComplete ? '—' : cacheAvailable ? formatPercent(provider.sevenDayLocal.cacheHitRate, language, '—') : text.cacheUnsupported} />
        <Metric label={text.costShort} accessibleLabel={text.cost} value={sevenDayLocalComplete ? formatCost(provider, language, text.noPrice) : '—'} />
      </dl>

      <DailyBars provider={provider} language={language} />
    </article>
  );
}

/** 完整展示官方额度窗口，避免备用额度的较低余额遮住重置后的主额度。 */
function ProviderSummaryCard(props: { provider: UsageProviderSummary; language: Language }) {
  const { provider, language } = props;
  const text = copy[language];
  const name = providerDisplayName(provider);
  const todayValue = formatIncompleteTokens(provider.todayLocal.totalTokens, provider.todayLocalComplete, language);
  /** 无官方额度时保留原有空态；多项额度按官方顺序逐一显示。 */
  const windows = provider.rateLimitWindows.length ? provider.rateLimitWindows : [undefined];
  /** 读屏摘要覆盖全部额度，不将某一项伪装成当前模型额度。 */
  const quotaSummary = provider.rateLimitWindows.map((window) => `${windowRemainingLabel(window, language)} ${formatPercent(window.remainingPercent / 100, language)}`).join('，') || text.noQuota;
  const source = provider.rateLimitWindows.length ? text.officialAndLocal : provider.officialState === 'signed_out' ? text.localQuotaSignIn : text.localQuotaUnavailable;
  return (
    <section className="menu-bar-usage-account-card" aria-label={`${name}，${quotaSummary}，${text.todayToken} ${todayValue}`}>
      <div className="menu-bar-usage-account-body">
        <div className="menu-bar-usage-account-quotas">
          {windows.map((window, index) => {
            /** 名称包含额度池和周期，同名的短期与长期额度也能区分。 */
            const quotaHeading = window ? windowRemainingLabel(window, language) : text.quota;
            /** 百分比使用该窗口的官方余额，空态不推算额度。 */
            const quotaValue = window ? formatPercent(window.remainingPercent / 100, language) : text.noQuota;
            return (
              <div key={`${window?.limitId ?? 'default'}-${window?.kind ?? 'empty'}-${index}`} className="menu-bar-usage-account-quota" data-empty={window ? 'false' : 'true'}>
                <small title={quotaHeading}>{quotaHeading}</small>
                <strong>{quotaValue}</strong>
                {window ? (
                  <>
                    <span className="menu-bar-usage-progress" role="progressbar" aria-label={quotaHeading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
                      <i style={{ inlineSize: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }} />
                    </span>
                    <time dateTime={window.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : undefined} title={window.resetsAt ? formatReset(window.resetsAt, language, text.resets) : undefined}>
                      {window.resetsAt ? formatReset(window.resetsAt, language, text.resets) : '—'}
                    </time>
                  </>
                ) : provider.officialState === 'signed_out' ? (
                  <small>{text.signedOut}</small>
                ) : null}
              </div>
            );
          })}
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

/** 按原统计来源展示每日柱形、日期与数值，缺失数据不推算成零。 */
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
              <strong className="menu-bar-usage-bar-value">{formatOptionalTokens(slot.totalTokens, props.language)}</strong>
            </span>
          );
        })}
      </div>
    </figure>
  );
}

/** 菜单栏指标只显示名称和数值，减少重复说明占用的空间。 */
function Metric(props: { label: string; accessibleLabel?: string; value: string }) {
  return (
    <div>
      <dt aria-label={props.accessibleLabel}>{props.label}</dt>
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

/** 双箭头留出清晰开口，小尺寸下仍可辨识刷新方向。 */
function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.5 2v4h-4M2.5 14v-4h4M3.1 5.5a5.2 5.2 0 0 1 8.6-1.7L13.5 6M2.5 10l1.8 2.2a5.2 5.2 0 0 0 8.6-1.7" />
    </svg>
  );
}

/** 细圆环在固定按钮内匀速旋转，避免翻转沙漏带来的视觉跳动。 */
function RefreshPendingIcon() {
  return <span className="menu-bar-usage-spinner" aria-hidden="true" />;
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

/** 同时标明额度池和周期，缺少名称时保留官方标识，不猜测对应模型。 */
function windowRemainingLabel(window: CodexOfficialRateWindow, language: Language): string {
  /** 官方名称优先，标识只在没有名称时补充。 */
  const name = window.limitName || window.limitId;
  /** 官方未提供时长时使用窗口类别，避免同一额度池出现无法区分的两行。 */
  const duration = !window.windowDurationMins
    ? window.kind === 'primary'
      ? language === 'zh-CN'
        ? '主要窗口'
        : 'Primary window'
      : language === 'zh-CN'
        ? '次要窗口'
        : 'Secondary window'
    : window.windowDurationMins >= 1_440
      ? language === 'zh-CN'
        ? `${window.windowDurationMins / 1_440} 日`
        : `${window.windowDurationMins / 1_440} day`
      : language === 'zh-CN'
        ? `${window.windowDurationMins / 60} 小时`
        : `${window.windowDurationMins / 60} hour`;
  return `${name ? `${name} · ` : ''}${duration}${language === 'zh-CN' ? '剩余' : ' remaining'}`;
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

/** 美元使用简短货币符号，保留小额费用精度。 */
function formatCost(provider: UsageProviderSummary, language: Language, unavailable: string): string {
  const value = provider.sevenDayLocal.apiEquivalentUsd;
  if (value === null || !provider.sevenDayLocal.priceCoverage) return unavailable;
  return `~${new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: value > 0 && value < 0.01 ? 4 : 2, maximumFractionDigits: 4 }).format(value)}`;
}

/** 直接显示本地日期和时间，跨日重置无需悬停猜测。 */
function formatReset(timestamp: number, language: Language, prefix: string): string {
  return `${prefix} ${new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp * 1_000))}`;
}

/** 正常状态仅显示时间；读取失败时保留过期数据说明。 */
function formatUpdatedAt(value: string, language: Language, prefix: string): string {
  return `${prefix ? `${prefix} ` : ''}${new Intl.DateTimeFormat(language, { hour: '2-digit', minute: '2-digit' }).format(new Date(value))}`;
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

/** 本地存储属于不可信输入：仅接受非空字符串标识，并去除重复项。 */
function readStoredProviderOrder(): string[] {
  try {
    /** 旧偏好或手工修改的内容不得影响窗口启动。 */
    const value: unknown = JSON.parse(localStorage.getItem(providerOrderStorageKey) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))] : [];
  } catch {
    return [];
  }
}

function storeSelection(value: string): void {
  try {
    localStorage.setItem(selectionStorageKey, value);
  } catch {
    // 选择偏好不可写时，仅保留当前窗口内状态。
  }
}
