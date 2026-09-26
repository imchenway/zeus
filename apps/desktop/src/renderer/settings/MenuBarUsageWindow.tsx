import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { CodexOfficialRateWindow, UsageModelCostBreakdown, UsageOverviewSnapshot, UsageProviderSummary } from '@zeus/shared';
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
/** 指标显示偏好与柱图统计维度只影响浮窗展示，不改变后台统计口径。 */
const metricsStorageKey = 'zeus.menu-bar-usage.metrics';
const chartDimensionStorageKey = 'zeus.menu-bar-usage.chart-dimension';

/** 全部可选指标；顺序即网格顺序，取消勾选只影响展示。 */
const metricOrder = ['todayTokens', 'todayCost', 'sevenDayTokens', 'sevenDayCost', 'cacheHit', 'cacheSavings', 'sevenDayConversations', 'sevenDayTurns', 'averageTurnCost'] as const;

/** 默认显示的指标；新增指标默认不展示，升级后浮窗高度与既有版面保持不变。 */
const defaultMetricOrder: MetricId[] = ['todayTokens', 'todayCost', 'sevenDayTokens', 'sevenDayCost', 'cacheHit', 'cacheSavings'];

/** 指标标识，取值来自本地存储时必须先过滤未知项。 */
type MetricId = (typeof metricOrder)[number];

/** 柱图统计维度；费用只能来自本地账本估算，官方账户历史没有模型维度。 */
type ChartDimension = 'tokens' | 'cost';

/** Codex 柱图统计来源；其他供应商始终使用 Zeus 本地账本。 */
type ChartSource = 'local' | 'account';

/** 柱图槽位：日期、数值与完整性，数值为 null 表示当天没有可用数据。 */
type DailySlot = { date: string; value: number | null; complete: boolean };

/** 指标展示值可选携带模型费用明细，非费用指标不创建说明入口。 */
type MetricValue = { label: string; accessibleLabel?: string; value: string; detailLabel?: string; costBreakdown?: UsageModelCostBreakdown[] };

const copy = {
  'zh-CN': {
    all: '全部',
    allProviders: '全部供应源',
    providers: '供应商',
    reorderHint: '拖拽调整顺序，顶部同步',
    reorderHelp: '拖动手柄排序，也可聚焦手柄后按 ↑ ↓',
    reorder: '排序',
    loading: '正在读取用量',
    noProviders: '还没有可统计的用量',
    noProvidersDetail: '使用 AI 后，这里会显示各个服务的用量。',
    quota: '额度剩余',
    todayToken: '今日 Token',
    available: '可用',
    localOnly: '本机统计',
    staleStatus: '数据过期',
    signedOut: '未登录',
    unavailableStatus: '配额异常',
    removedStatus: '已移除',
    today: '今日 Token',
    sevenDays: '近 7 日 Token',
    sevenDaysSummary: '近 7 日',
    cache: '缓存命中率',
    cacheUnsupported: '供应源未提供',
    cost: '近 7 日估算费用',
    costShort: '7 日估算费用',
    todayCost: '今日估算费用',
    cacheSavings: '7 日缓存节省',
    sevenDayConversations: '7 日会话数',
    sevenDayTurns: '7 日轮次数',
    averageTurnCost: '平均每轮费用',
    todayCostDetail: '今日模型费用明细',
    sevenDayCostDetail: '近 7 日模型费用明细',
    averageTurnCostDetail: '近 7 日平均每轮费用明细',
    costDetailHint: 'Token 单价按每百万计',
    showCostDetail: '查看模型、单价和 Token 明细',
    model: '模型',
    unitPrice: '单价',
    consumedTokens: '消耗 Token',
    inputPrice: '输入',
    cachedInputPrice: '缓存读',
    cacheWritePrice: '缓存写',
    outputPrice: '输出',
    perRequestPrice: '每次请求',
    overview: '用量概览',
    metrics: '指标',
    dimension: '统计维度',
    dimensionTokens: 'Token',
    dimensionCost: '费用',
    statisticsSource: '统计来源',
    zeusLocalUsage: 'Zeus 本地统计',
    zeusLocalUsageHint: '只统计在 Zeus 中产生的用量；费用由本地账本按模型单价估算。',
    costEstimateHint: '费用由 Zeus 本地账本按请求单价估算，只合计已计价部分；覆盖率按可计费 Token 计算，不代表费用比例。',
    noPrice: '暂无价格',
    recentUsage: '每日 Token',
    accountUsage: 'Codex 账户统计',
    accountUsageHint: '显示 Codex 账户在所有客户端的每日 Token；Codex 官方未提供每日费用。',
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
    providers: 'Provider',
    reorderHint: 'Drag to reorder the list and tabs',
    reorderHelp: 'Drag to reorder, or focus a handle and press ↑ ↓',
    reorder: 'Reorder',
    loading: 'Loading usage',
    noProviders: 'No usage recorded yet',
    noProvidersDetail: 'Usage for each AI service appears here after you use it.',
    quota: 'Quota remaining',
    todayToken: 'Today tokens',
    available: 'Available',
    localOnly: 'Local stats',
    staleStatus: 'Stale data',
    signedOut: 'Signed out',
    unavailableStatus: 'Quota error',
    removedStatus: 'Removed',
    today: 'Today tokens',
    sevenDays: 'Tokens in 7 days',
    sevenDaysSummary: '7 days',
    cache: 'Cache hit rate',
    cacheUnsupported: 'Not provided',
    cost: 'Estimated cost · 7 days',
    costShort: '7-day estimate',
    todayCost: "Today's estimate",
    cacheSavings: 'Cache savings · 7 days',
    sevenDayConversations: 'Sessions · 7 days',
    sevenDayTurns: 'Turns · 7 days',
    averageTurnCost: 'Avg cost per turn',
    todayCostDetail: "Today's model cost details",
    sevenDayCostDetail: 'Model cost details · 7 days',
    averageTurnCostDetail: 'Average cost per turn details · 7 days',
    costDetailHint: 'Token rates are per million',
    showCostDetail: 'Show model, rate, and token details',
    model: 'Model',
    unitPrice: 'Rate',
    consumedTokens: 'Tokens',
    inputPrice: 'Input',
    cachedInputPrice: 'Cache read',
    cacheWritePrice: 'Cache write',
    outputPrice: 'Output',
    perRequestPrice: 'Per request',
    overview: 'Usage overview',
    metrics: 'Metrics',
    dimension: 'Metric dimension',
    dimensionTokens: 'Tokens',
    dimensionCost: 'Cost',
    statisticsSource: 'Statistics source',
    zeusLocalUsage: 'Zeus local stats',
    zeusLocalUsageHint: 'Includes usage generated in Zeus only; cost is estimated from the local ledger using model rates.',
    costEstimateHint: 'Local estimates sum priced requests only. Coverage measures billable tokens, not the share of total cost.',
    noPrice: 'No pricing',
    recentUsage: 'Daily tokens',
    accountUsage: 'Codex account stats',
    accountUsageHint: 'Shows daily tokens across all clients. Codex does not provide daily account cost.',
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
  /** 读取实际内容高度，使无额度页和较短的列表自然收起。 */
  const surfaceRef = useRef<HTMLElement>(null);

  useEffect(() => window.zeus?.onMenuBarUsageSettingsChanged?.(setSurfaceSettings), []);

  useEffect(() => {
    /** 只有原生浮窗调整窗口；浏览器预览继续使用自身视口。 */
    const resizeWindow = window.zeus?.resizeMenuBarUsage;
    const surface = surfaceRef.current;
    const content = surface?.querySelector<HTMLElement>('.menu-bar-usage-content');
    const body = content?.firstElementChild;
    if (!resizeWindow || !surface || !content || !body) return;
    /** 缓存本次布局请求，窗口回传的尺寸变化不重复发送相同高度。 */
    let requestedHeight = 0;
    /** 固定操作区与自然内容相加，超高内容仍由原有滚动区承接。 */
    const updateHeight = () => {
      const height = Math.ceil(document.documentElement.clientHeight - content.clientHeight + body.getBoundingClientRect().height);
      if (height === requestedHeight) return;
      requestedHeight = height;
      void resizeWindow(height).catch((cause: unknown) => console.warn('菜单栏浮窗高度调整失败。', cause));
    };
    /** 同时监听文字换行和窗口大小变化，不依赖固定额度条数估算。 */
    const observer = new ResizeObserver(updateHeight);
    observer.observe(surface);
    observer.observe(body);
    updateHeight();
    return () => observer.disconnect();
  }, [snapshot, selection, surfaceSettings.language, error]);

  const load = useCallback(
    (refresh?: 'if-stale' | 'force') => {
      if (requestRef.current) return requestRef.current;
      const request = (async () => {
        setLoading(true);
        try {
          const next = await props.client.loadUsageOverview(refresh);
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
    },
    [props.client],
  );

  useEffect(() => {
    /** 隐藏期间只记变化，合并显示、聚焦及同批用量通知。 */
    let dirty = true;
    /** 打开时检查过期官方数据，普通事件只读取本地快照。 */
    let refresh: 'if-stale' | undefined = 'if-stale';
    /** 仅可见窗口允许提交请求；原生初始隐藏窗口也必须已经取得焦点。 */
    const visible = () => document.visibilityState === 'visible' && (!window.zeus || document.hasFocus());
    /** 订阅退出后，不允许在途请求重新安排任务。 */
    let disposed = false;
    /** 一个短暂合并窗口，不建立持续轮询。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 请求期间的新通知留到下一轮，避免在途去重吞掉最终更新。 */
    const schedule = () => {
      if (disposed || timer || !dirty || !visible()) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (disposed || !visible()) return;
        if (requestRef.current) {
          void requestRef.current.finally(schedule);
          return;
        }
        dirty = false;
        const requestedRefresh = refresh;
        refresh = undefined;
        void load(requestedRefresh).finally(schedule);
      }, 150);
    };
    const unsubscribe = props.client.subscribeEvents(
      (event) => {
        if (event.type !== 'usage.changed' && event.type !== 'codex.usage.changed') return;
        dirty = true;
        schedule();
      },
      () => undefined,
    );
    /** 重新显示时补读一次；重复可见性通知共享同一合并窗口。 */
    const refreshWhenShown = () => {
      if (!visible()) return;
      dirty = true;
      refresh = 'if-stale';
      schedule();
    };
    schedule();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      /** 页面内弹层打开时，Escape 只关闭当前弹层，不关闭整个菜单栏浮窗。 */
      if (document.querySelector('.menu-bar-usage-metrics-menu:popover-open, .menu-bar-usage-cost-detail:popover-open')) return;
      event.preventDefault();
      void window.zeus?.hideMenuBarUsage?.();
    };
    window.addEventListener('focus', refreshWhenShown);
    document.addEventListener('visibilitychange', refreshWhenShown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', refreshWhenShown);
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
      <section ref={surfaceRef} className="menu-bar-usage-surface">
        <header className="menu-bar-usage-header">
          <span className="menu-bar-usage-identity">
            <span className="menu-bar-usage-mark" aria-hidden="true" />
            <strong>Zeus</strong>
          </span>
          <span className="menu-bar-usage-refresh-status">
            <small className="menu-bar-usage-freshness" data-stale={stale && !loading ? 'true' : 'false'} aria-live="polite" title={freshness}>
              {freshness}
            </small>
            <button className="menu-bar-usage-refresh" type="button" aria-label={loading ? text.loading : text.retry} title={loading ? text.loading : text.retry} aria-busy={loading} disabled={loading} onClick={() => void load('force')}>
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
      <header className="menu-bar-usage-provider-heading" aria-hidden="true">
        <span>{text.providers}</span>
        <span>{text.todayToken}</span>
      </header>
      <span className="menu-bar-usage-sr-only" id="menu-bar-usage-reorder-help">
        {text.reorderHelp}
      </span>
      <span className="menu-bar-usage-sr-only" role="status">
        {announcement}
      </span>
      {props.providers.map((provider, index) => {
        const fullName = providerDisplayName(provider);
        /** 可见数值与读屏摘要共用格式，省略重复文案后仍能识别今日统计口径。 */
        const todayValue = formatIncompleteTokens(provider.todayLocal.totalTokens, provider.todayLocalComplete, props.language);
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
                aria-describedby="menu-bar-usage-reorder-help"
                title={text.reorderHelp}
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
            <button className="menu-bar-usage-provider-open" type="button" aria-label={`${fullName} · ${text.today} ${todayValue}`} title={`${fullName} · ${providerDetail}`} onClick={() => props.onSelect(provider.providerId)}>
              <span className="menu-bar-usage-provider-copy">
                <strong title={provider.deleted ? fullName : undefined}>{fullName}</strong>
                {provider.deleted ? <small>{text.removedStatus}</small> : null}
              </span>
              <span className="menu-bar-usage-provider-value">
                <strong>{todayValue}</strong>
              </span>
              <Chevron />
            </button>
          </div>
        );
      })}
      {props.providers.length > 1 ? <small className="menu-bar-usage-reorder-hint">{text.reorderHint}</small> : null}
    </section>
  );
}

/** 统一各供应商的本地指标和趋势布局，官方额度仅在存在时显示。 */
function ProviderDetail(props: { provider: UsageProviderSummary; language: Language }) {
  return (
    <article className="menu-bar-usage-detail">
      <ProviderSummaryCard provider={props.provider} language={props.language} />

      <UsageOverview provider={props.provider} language={props.language} />

      <DailyBars key={props.provider.providerId} provider={props.provider} language={props.language} />
    </article>
  );
}

/** 用量概览：标题、指标多选与指标网格共用同一套取值，避免多处口径不一致。 */
function UsageOverview(props: { provider: UsageProviderSummary; language: Language }) {
  const { provider, language } = props;
  const text = copy[language];
  /** 多选面板与触发按钮配对，重挂载后仍保持唯一 id。 */
  const menuId = useId();
  const [visibleMetrics, setVisibleMetrics] = useState(readStoredMetrics);
  const metrics = readMetricValues(provider, language);
  /** 价格覆盖与用量采集完整性分开说明，不把部分金额伪装成完整费用。 */
  const partialPricing = (provider.todayLocal.priceCoverage !== null && provider.todayLocal.priceCoverage < 1) || (provider.sevenDayLocal.priceCoverage !== null && provider.sevenDayLocal.priceCoverage < 1);
  /** 至少保留一个指标，取消最后一个可见项时保持原样。 */
  const toggleMetric = (id: MetricId) => {
    const selected = visibleMetrics.includes(id);
    if (selected && visibleMetrics.length === 1) return;
    /** 保存顺序始终与指标顺序一致，刷新后网格排列稳定。 */
    const next = metricOrder.filter((entry) => (entry === id ? !selected : visibleMetrics.includes(entry)));
    setVisibleMetrics(next);
    storeMetrics(next);
  };
  return (
    <section className="menu-bar-usage-overview">
      <header className="menu-bar-usage-overview-head">
        <h3>{text.overview}</h3>
        <button className="menu-bar-usage-metrics-trigger" type="button" popoverTarget={menuId} aria-haspopup="true" aria-label={`${text.metrics} · ${visibleMetrics.length}/${metricOrder.length}`}>
          {text.metrics}
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="m4 6.5 4 4 4-4" />
          </svg>
        </button>
        {/* 面板挂在 popover 顶层，不会被浮窗滚动区裁切，点击外部自动收起。 */}
        <div id={menuId} popover="auto" className="menu-bar-usage-metrics-menu" role="group" aria-label={text.metrics}>
          {metricOrder.map((id) => {
            const selected = visibleMetrics.includes(id);
            return (
              <label key={id} className="menu-bar-usage-metrics-option">
                <input type="checkbox" checked={selected} disabled={selected && visibleMetrics.length === 1} onChange={() => toggleMetric(id)} />
                <span>{metrics[id].label}</span>
              </label>
            );
          })}
        </div>
      </header>

      <dl className="menu-bar-usage-metrics">
        {metricOrder
          .filter((id) => visibleMetrics.includes(id))
          .map((id) => (
            <Metric key={id} {...metrics[id]} language={language} />
          ))}
      </dl>
      {partialPricing && (
        <p className="menu-bar-usage-pricing-note">
          {language === 'zh-CN'
            ? `已计价 Token：今日 ${formatPercent(provider.todayLocal.priceCoverage, language)} · 七日 ${formatPercent(provider.sevenDayLocal.priceCoverage, language)}；剩余用量尚未计价。`
            : `Priced tokens: today ${formatPercent(provider.todayLocal.priceCoverage, language)} · 7 days ${formatPercent(provider.sevenDayLocal.priceCoverage, language)}. Remaining usage is unpriced.`}
        </p>
      )}
      {provider.sevenDayLocal.hasBackfilledPricing && <p className="menu-bar-usage-pricing-note">{language === 'zh-CN' ? '含历史补算：按补价时价格估算' : 'Includes historical usage estimated at backfill-time prices'}</p>}
    </section>
  );
}

/** 指标取值与文案：多选面板和网格共用一份结果，标签与数值始终对应。 */
function readMetricValues(provider: UsageProviderSummary, language: Language): Record<MetricId, MetricValue> {
  const text = copy[language];
  const cacheAvailable = provider.cacheUsageAvailable ?? (provider.providerId === 'codex' || provider.sevenDayLocal.cachedInputTokens > 0 || provider.sevenDayLocal.cacheWriteInputTokens > 0);
  const sevenDayLocalComplete = provider.sevenDayLocalComplete === true;
  /** 平均每轮费用只在有轮次、已定价且七日内数据完整时才有意义。 */
  const averageTurnCost =
    provider.sevenDayLocal.turnCount > 0
      ? formatUsd(provider.sevenDayLocal.apiEquivalentUsd === null ? null : provider.sevenDayLocal.apiEquivalentUsd / provider.sevenDayLocal.turnCount, provider.sevenDayLocal.priceCoverage, language, text.noPrice)
      : '—';
  return {
    todayTokens: { label: text.today, value: formatIncompleteTokens(provider.todayLocal.totalTokens, provider.todayLocalComplete, language) },
    todayCost: {
      label: text.todayCost,
      value: provider.todayLocalComplete === true ? formatUsd(provider.todayLocal.apiEquivalentUsd, provider.todayLocal.priceCoverage, language, text.noPrice) : '—',
      detailLabel: text.todayCostDetail,
      costBreakdown: provider.todayCostBreakdown ?? [],
    },
    sevenDayTokens: { label: text.sevenDays, value: formatIncompleteTokens(provider.sevenDayLocal.totalTokens, provider.sevenDayLocalComplete, language) },
    sevenDayCost: {
      label: text.costShort,
      accessibleLabel: text.cost,
      value: sevenDayLocalComplete ? formatUsd(provider.sevenDayLocal.apiEquivalentUsd, provider.sevenDayLocal.priceCoverage, language, text.noPrice) : '—',
      detailLabel: text.sevenDayCostDetail,
      costBreakdown: provider.sevenDayCostBreakdown ?? [],
    },
    cacheHit: { label: text.cache, value: !sevenDayLocalComplete ? '—' : cacheAvailable ? formatPercent(provider.sevenDayLocal.cacheHitRate, language, '—') : text.cacheUnsupported },
    cacheSavings: { label: text.cacheSavings, value: sevenDayLocalComplete ? formatUsd(provider.sevenDayLocal.cacheSavingsUsd, provider.sevenDayLocal.priceCoverage, language, text.noPrice) : '—' },
    sevenDayConversations: { label: text.sevenDayConversations, value: formatIncompleteCount(provider.sevenDayLocal.conversationCount, provider.sevenDayLocalComplete, language) },
    sevenDayTurns: { label: text.sevenDayTurns, value: formatIncompleteCount(provider.sevenDayLocal.turnCount, provider.sevenDayLocalComplete, language) },
    averageTurnCost: {
      label: text.averageTurnCost,
      value: sevenDayLocalComplete ? averageTurnCost : '—',
      detailLabel: text.averageTurnCostDetail,
      costBreakdown: provider.sevenDayCostBreakdown ?? [],
    },
  };
}

/** 完整展示官方额度窗口，避免备用额度的较低余额遮住重置后的主额度。 */
function ProviderSummaryCard(props: { provider: UsageProviderSummary; language: Language }) {
  /** 保持官方额度与本地用量独立，不为没有额度的供应商制造空态。 */
  const { provider, language } = props;
  if (provider.rateLimitWindows.length === 0) return null;
  /** 当前语言和供应商名称用于分组及辅助阅读摘要。 */
  const text = copy[language];
  const name = providerDisplayName(provider);
  /** 按官方额度池标识分组，避免名称重复，也不合并同名的独立额度池。 */
  const groups = new Map<string, CodexOfficialRateWindow[]>();
  for (const window of provider.rateLimitWindows) {
    /** 缺少池标识时才用名称归组，保留后台返回的窗口顺序。 */
    const key = window.limitId || window.limitName || '';
    const group = groups.get(key);
    if (group) group.push(window);
    else groups.set(key, [window]);
  }
  /** 固定 Codex 主额度组在首位，其余组及组内周期保留原顺序。 */
  const orderedGroups = [...groups];
  /** 同时识别官方额度池标识和显示名称，不把 Spark 等独立额度当作主额度。 */
  const codexIndex = orderedGroups.findIndex(([id, windows]) => id.toLowerCase() === 'codex' || windows[0].limitName?.toLowerCase() === 'codex');
  if (provider.providerId === 'codex' && codexIndex > 0) orderedGroups.unshift(...orderedGroups.splice(codexIndex, 1));
  return (
    <section className="menu-bar-usage-account-card" aria-label={`${name} · ${text.quota}`}>
      {orderedGroups.map(([id, windows]) => {
        /** 同一额度池只显示一次名称，各周期仍独立保留余额与重置日期。 */
        const groupName = windows[0].limitName || id || name;
        return (
          <section key={id} className="menu-bar-usage-quota-group" aria-label={groupName}>
            <h3>{groupName}</h3>
            {windows.map((window, index) => {
              /** 周期显示短名称，读屏进度条保留完整额度池和剩余含义。 */
              const duration = windowDurationLabel(window, language);
              const quotaHeading = `${groupName} · ${duration} · ${text.quota}`;
              return (
                <div key={`${window.kind}-${index}`} className="menu-bar-usage-account-quota">
                  <span className="menu-bar-usage-quota-duration">{duration}</span>
                  <span className="menu-bar-usage-progress" role="progressbar" aria-label={quotaHeading} aria-valuemin={0} aria-valuemax={100} aria-valuenow={window.remainingPercent}>
                    <i style={{ inlineSize: `${Math.max(0, Math.min(100, window.remainingPercent))}%` }} />
                  </span>
                  <strong>{formatPercent(window.remainingPercent / 100, language)}</strong>
                  <time dateTime={window.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : undefined}>{window.resetsAt ? formatReset(window.resetsAt, language, text.resets) : '—'}</time>
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}

/** Codex 可切换本地或账户来源；其他供应商固定使用本地日用量。 */
function DailyBars(props: { provider: UsageProviderSummary; language: Language }) {
  /** Codex 才显示来源选择，首次打开固定使用 Zeus 本地统计。 */
  const text = copy[props.language];
  const sourceSelectable = props.provider.providerId === 'codex';
  const [source, setSource] = useState<ChartSource>('local');
  /** 本地维度单独保存；切到账户来源时不丢失用户之前选择的费用维度。 */
  const [localDimension, setLocalDimension] = useState<ChartDimension>(readStoredChartDimension);
  /** Codex 账户接口只返回 Token，不能把本地费用冒充为账户费用。 */
  const accountSource = sourceSelectable && source === 'account';
  const dimension: ChartDimension = accountSource ? 'tokens' : localDimension;
  /** 费用维度只来自本地账本，官方账户历史没有模型维度，无法换算金额。 */
  const costDimension = dimension === 'cost';
  const label = costDimension ? text.cost : accountSource ? text.accountUsage : sourceSelectable ? text.zeusLocalUsage : text.recentUsage;
  /** 图注口径随维度切换，避免两种数据源被当成同一份统计。 */
  const sourceHint = accountSource ? text.accountUsageHint : sourceSelectable ? text.zeusLocalUsageHint : costDimension ? text.costEstimateHint : null;
  /** 维度偏好写入本地存储，重开浮窗保持一致。 */
  const selectDimension = (next: ChartDimension) => {
    setLocalDimension(next);
    try {
      localStorage.setItem(chartDimensionStorageKey, next);
    } catch {
      // 存储不可写时仅保留本次窗口内的选择，与现有偏好处理一致。
    }
  };
  /** 费用维度依赖本地账本；没有本地记录时不再画一排空柱。 */
  const hasLocalHistory = props.provider.dailyLocal.length > 0 || props.provider.collectionStartedAt !== null;
  if (!sourceSelectable && !hasLocalHistory)
    return (
      <div className="menu-bar-usage-chart-empty">
        <small>{text.insufficientHistory}</small>
      </div>
    );
  /** 补齐近七日日期；开始记录之前保留缺失状态。 */
  const slots = buildDailySlots(props.provider, dimension, accountSource ? 'account' : 'local');
  const maximum = Math.max(...slots.flatMap((slot) => (slot.value && slot.value > 0 ? [slot.value] : [])), 1);
  /** 按实际展示的七根柱汇总；缺失日期或费用覆盖不足时保留不完整提示。 */
  const sevenDayTotal = slots.reduce((sum, slot) => sum + (slot.value ?? 0), 0);
  const sevenDayValue = costDimension
    ? props.provider.sevenDayLocal.apiEquivalentUsd === null
      ? text.noPrice
      : formatIncompleteUsd(
          sevenDayTotal,
          slots.every((slot) => slot.complete),
          props.language,
        )
    : accountSource
      ? formatIncompleteTokens(
          sevenDayTotal,
          slots.every((slot) => slot.complete),
          props.language,
        )
      : formatIncompleteTokens(props.provider.sevenDayLocal.totalTokens, props.provider.sevenDayLocalComplete, props.language);
  return (
    <figure className="menu-bar-usage-bars" aria-label={`${providerDisplayName(props.provider)} ${label}`}>
      <figcaption>
        <span className="menu-bar-usage-chart-source">
          {sourceSelectable ? (
            <label className="menu-bar-usage-source-select">
              <span className="menu-bar-usage-sr-only">{text.statisticsSource}</span>
              <select aria-label={text.statisticsSource} value={source} onChange={(event) => setSource(event.currentTarget.value === 'account' ? 'account' : 'local')}>
                <option value="local">{text.zeusLocalUsage}</option>
                <option value="account">{text.accountUsage}</option>
              </select>
            </label>
          ) : (
            label
          )}
          {sourceHint && (
            <span className="menu-bar-usage-source-info" role="img" tabIndex={0} aria-label={sourceHint}>
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 4.5v4M8 11.5h.01" />
              </svg>
              {/* 原生 title 在无边框透明浮窗里不显示，说明文字改为真实气泡，读屏仍读图标自身的文案。 */}
              <span className="menu-bar-usage-source-hint" aria-hidden="true">
                {sourceHint}
              </span>
            </span>
          )}
        </span>
        {!accountSource ? (
          <span className="menu-bar-usage-dimension" role="group" aria-label={text.dimension}>
            <button type="button" aria-pressed={!costDimension} onClick={() => selectDimension('tokens')}>
              {text.dimensionTokens}
            </button>
            <button type="button" aria-pressed={costDimension} onClick={() => selectDimension('cost')}>
              {text.dimensionCost}
            </button>
          </span>
        ) : null}
        <dl>
          <div>
            <dt>{text.sevenDaysSummary}</dt>
            <dd>{sevenDayValue}</dd>
          </div>
        </dl>
      </figcaption>
      <div className="menu-bar-usage-bars-plot">
        {slots.map((slot) => {
          const state = slot.value === null ? 'missing' : slot.value === 0 ? 'zero' : 'positive';
          const formatted = costDimension ? formatUsdText(slot.value, props.language, slot.complete) : slot.value === null ? '' : formatIncompleteTokens(slot.value, slot.complete, props.language);
          const value = slot.value === null ? text.missingDay : costDimension ? formatted : `${formatted} Token`;
          /** 七列共用有限宽度：token 的万级数字去掉小数，金额限制到两位小数；悬浮摘要保留原精度。 */
          const barLabel = slot.value === null ? '—' : formatted;
          const chartLabel = slot.value === null ? barLabel : costDimension ? formatCurrency(slot.value, props.language, 2) : barLabel.length > 6 ? `${slot.complete ? '' : '≥'}${formatTokens(slot.value, props.language, 0)}` : barLabel;
          return (
            <span key={slot.date} data-state={state} aria-label={`${formatShortDate(slot.date, props.language)} ${value}`} title={`${slot.date} · ${value}`}>
              <span className="menu-bar-usage-bar-slot">
                <span className="menu-bar-usage-bar-column" style={{ blockSize: slot.value ? `${Math.max(2, (slot.value / maximum) * 100)}%` : '2px' }}>
                  {/* 零用量不显示柱顶数字，日期与悬浮用量仍保留。 */}
                  {slot.value !== 0 && <strong className="menu-bar-usage-bar-value">{chartLabel}</strong>}
                  <i />
                </span>
              </span>
              <small>{formatShortDate(slot.date, props.language)}</small>
            </span>
          );
        })}
      </div>
    </figure>
  );
}

/** 菜单栏费用指标在名称右侧提供可点击的真实账本明细。 */
function Metric(props: MetricValue & { language: Language }) {
  return (
    <div>
      <dt>
        <span aria-label={props.accessibleLabel}>{props.label}</span>
        {props.costBreakdown?.length && props.detailLabel ? <CostBreakdownPopover entries={props.costBreakdown} label={props.detailLabel} language={props.language} /> : null}
      </dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/** 费用明细浮层与感叹号之间保留的间距。 */
const costDetailPopoverGap = 8;

/** 费用明细浮层距离可视区域边缘的最小留白。 */
const costDetailViewportInset = 12;

/** 费用说明使用原生顶层浮层，并依据可视区域剩余空间左右翻转。 */
function CostBreakdownPopover(props: { entries: UsageModelCostBreakdown[]; label: string; language: Language }) {
  const text = copy[props.language];
  /** 每个指标独立关联触发按钮和浮层，保证多个费用指标同时存在时不串位。 */
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const hoverCloseTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  /** 使用浮层实际尺寸判断：默认放右侧，右侧放不下时翻到左侧，并约束在可视区域内。 */
  const positionPopover = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover?.matches(':popover-open')) return;
    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const rightSpace = window.innerWidth - costDetailViewportInset - triggerRect.right;
    const placeOnLeft = rightSpace < popoverRect.width + costDetailPopoverGap;
    const preferredLeft = placeOnLeft ? triggerRect.left - costDetailPopoverGap - popoverRect.width : triggerRect.right + costDetailPopoverGap;
    const maximumLeft = Math.max(costDetailViewportInset, window.innerWidth - costDetailViewportInset - popoverRect.width);
    const preferredTop = triggerRect.top + (triggerRect.height - popoverRect.height) / 2;
    const maximumTop = Math.max(costDetailViewportInset, window.innerHeight - costDetailViewportInset - popoverRect.height);
    const left = Math.min(Math.max(preferredLeft, costDetailViewportInset), maximumLeft);
    const top = Math.min(Math.max(preferredTop, costDetailViewportInset), maximumTop);
    popover.style.setProperty('--usage-cost-detail-left', `${Math.round(left)}px`);
    popover.style.setProperty('--usage-cost-detail-top', `${Math.round(top)}px`);
    popover.dataset.side = placeOnLeft ? 'left' : 'right';
  }, []);

  /** 取消延迟关闭，让鼠标可以跨过触发器与浮层之间的间距。 */
  const clearHoverClose = () => {
    if (hoverCloseTimerRef.current === null) return;
    window.clearTimeout(hoverCloseTimerRef.current);
    hoverCloseTimerRef.current = null;
  };
  /** 悬停、聚焦或点击时打开同一个原生浮层。 */
  const showPopover = () => {
    clearHoverClose();
    if (!popoverRef.current?.matches(':popover-open')) popoverRef.current?.showPopover();
  };
  /** 未被点击固定时，指针离开触发器和浮层后延迟收起。 */
  const scheduleHoverClose = () => {
    clearHoverClose();
    hoverCloseTimerRef.current = window.setTimeout(() => {
      hoverCloseTimerRef.current = null;
      if (pinnedRef.current || triggerRef.current?.matches(':hover') || popoverRef.current?.matches(':hover')) return;
      if (popoverRef.current?.matches(':popover-open')) popoverRef.current.hidePopover();
    }, 120);
  };
  /** 点击切换固定状态；固定后移开鼠标仍保持展示。 */
  const togglePinned = () => {
    if (pinnedRef.current) {
      pinnedRef.current = false;
      if (popoverRef.current?.matches(':popover-open')) popoverRef.current.hidePopover();
      return;
    }
    pinnedRef.current = true;
    showPopover();
  };

  useEffect(() => {
    if (!open) return;
    /** 窗口变化、滚动或内容尺寸变化后重新贴住触发器。 */
    const syncPosition = () => positionPopover();
    const observer = new ResizeObserver(syncPosition);
    if (triggerRef.current) observer.observe(triggerRef.current);
    if (popoverRef.current) observer.observe(popoverRef.current);
    window.addEventListener('resize', syncPosition);
    window.addEventListener('scroll', syncPosition, true);
    positionPopover();
    return () => {
      observer.disconnect();
      if (hoverCloseTimerRef.current !== null) window.clearTimeout(hoverCloseTimerRef.current);
      hoverCloseTimerRef.current = null;
      window.removeEventListener('resize', syncPosition);
      window.removeEventListener('scroll', syncPosition, true);
    };
  }, [open, positionPopover]);

  return (
    <div className="menu-bar-usage-cost-detail-control" onPointerEnter={showPopover} onPointerLeave={scheduleHoverClose}>
      <button
        ref={triggerRef}
        type="button"
        className="menu-bar-usage-cost-detail-trigger"
        aria-label={`${props.label} · ${text.showCostDetail}`}
        aria-controls={popoverId}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={togglePinned}
        onFocus={showPopover}
        onBlur={scheduleHoverClose}
      >
        <span aria-hidden="true">!</span>
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        popover="auto"
        className="menu-bar-usage-cost-detail"
        role="dialog"
        aria-label={props.label}
        onPointerEnter={clearHoverClose}
        onPointerLeave={scheduleHoverClose}
        onToggle={(event) => {
          const nextOpen = event.currentTarget.matches(':popover-open');
          if (!nextOpen) pinnedRef.current = false;
          setOpen(nextOpen);
          if (nextOpen) positionPopover();
        }}
      >
        <strong>{props.label}</strong>
        <small>{text.costDetailHint}</small>
        <div className="menu-bar-usage-cost-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{text.model}</th>
                <th scope="col">{text.unitPrice}</th>
                <th scope="col">{text.consumedTokens}</th>
              </tr>
            </thead>
            <tbody>
              {props.entries.map((entry, index) => (
                <tr key={`${entry.model}-${index}`}>
                  <th scope="row">{entry.model}</th>
                  <td>
                    {formatModelRate(entry, props.language).map((line) => (
                      <span key={line}>{line}</span>
                    ))}
                  </td>
                  <td>{formatTokens(entry.usage.totalTokens, props.language)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** 单价单元格完整列出实际使用过的计价类别，空费率明确显示暂无价格。 */
function formatModelRate(entry: UsageModelCostBreakdown, language: Language): string[] {
  const text = copy[language];
  const rate = entry.rate;
  if (!rate) return [text.noPrice];
  if (rate.perRequest !== null) return [`${text.perRequestPrice} ${formatRateAmount(rate.perRequest, rate.currency, language)}`];
  if (!rate.perMillion) return [text.noPrice];
  /** 缓存类别只在单价已知时显示，避免把未知误写成零。 */
  const lines = [`${text.inputPrice} ${formatRateAmount(rate.perMillion.input, rate.currency, language)}`];
  if (rate.perMillion.cachedInput !== null) lines.push(`${text.cachedInputPrice} ${formatRateAmount(rate.perMillion.cachedInput, rate.currency, language)}`);
  if (rate.perMillion.cacheWrite !== null) lines.push(`${text.cacheWritePrice} ${formatRateAmount(rate.perMillion.cacheWrite, rate.currency, language)}`);
  lines.push(`${text.outputPrice} ${formatRateAmount(rate.perMillion.output, rate.currency, language)}`);
  return lines;
}

/** 费率保留原币种；美元与人民币使用熟悉符号，其他单位显示原始代码。 */
function formatRateAmount(value: number, currency: string, language: Language): string {
  const amount = new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(value);
  if (currency === 'USD') return `$${amount}`;
  if (currency === 'CNY') return `¥${amount}`;
  return `${currency} ${amount}`;
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

/** 账户数据保持官方原貌；缺失日期不以本地记录或零填充。 */
function buildDailySlots(provider: UsageProviderSummary, dimension: ChartDimension, source: ChartSource): DailySlot[] {
  /** 账户图使用官方历史；费用维度与普通供应商沿用本地日账本。 */
  const accountUsage = provider.providerId === 'codex' && source === 'account';
  const buckets = accountUsage ? (provider.dailyAccount ?? []) : provider.dailyLocal.map((day) => ({ date: day.date, totalTokens: dimension === 'cost' ? day.apiEquivalentUsd : day.totalTokens }));
  /** 按日期查找数值，本地采集起点只用于普通供应商的空白日期。 */
  const bucketsByDate = new Map(buckets.map((bucket) => [bucket.date, bucket.totalTokens]));
  /** 费用有数值也可能只覆盖部分请求，每天独立保留缺价状态。 */
  const pricingByDate = new Map(provider.dailyLocal.map((day) => [day.date, day.priceCoverage]));
  const collectionStart = timestampDateKey(provider.collectionStartedAt);
  /** 以本地自然日对应顶部今日指标，七天范围包含当天。 */
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, index) => {
    /** 每根柱对应独立自然日，最后一根固定为当天。 */
    const date = new Date(today);
    date.setDate(date.getDate() - 6 + index);
    const dateKey = localDateKey(date);
    /** 官方缺失继续显示破折号；本地采集后的无记录日期才视作零，未定价日期按缺失处理。 */
    const recorded = bucketsByDate.get(dateKey);
    const value = recorded === null ? null : recorded === undefined ? (!accountUsage && collectionStart !== null && dateKey >= collectionStart ? 0 : null) : Math.max(0, recorded);
    return { date: dateKey, value, complete: value !== null && (dimension !== 'cost' || recorded === undefined || pricingByDate.get(dateKey) === 1) };
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

/** 分组标题已标明额度池，行内仅显示周期，避免重复模型名称。 */
function windowDurationLabel(window: CodexOfficialRateWindow, language: Language): string {
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
  return duration;
}

/** 数字按当前语言缩写，柱图可降低小数精度以防相邻标签重叠。 */
function formatTokens(value: number, language: Language, maximumFractionDigits = 1): string {
  return new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits }).format(value);
}

function formatIncompleteTokens(value: number, complete: boolean | undefined, language: Language): string {
  const formatted = formatTokens(value, language);
  return complete === true ? formatted : `≥${formatted}`;
}

/** 会话数、轮次数等计数不缩写，未完成时同样标出已知下限。 */
function formatIncompleteCount(value: number, complete: boolean | undefined, language: Language): string {
  return `${complete === true ? '' : '≥'}${new Intl.NumberFormat(language).format(Math.max(0, value))}`;
}

function formatPercent(value: number | null, language: Language, unavailable = ''): string {
  return value === null ? unavailable : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

/** 美元统一使用简短货币符号；小额保留更多小数位，柱顶等紧凑位置限制到两位。 */
function formatCurrency(value: number, language: Language, maximumFractionDigits = 4): string {
  return new Intl.NumberFormat(language, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: value > 0 && value < 0.01 ? maximumFractionDigits : 2,
    maximumFractionDigits,
  }).format(value);
}

/** 缺价与部分计价显式区分；波浪号只表示金额是估算。 */
function formatUsd(value: number | null, coverage: number | null | undefined, language: Language, unavailable: string): string {
  if (value === null || !coverage) return unavailable;
  return `${coverage < 1 ? (language === 'zh-CN' ? '部分 ' : 'Partial ') : ''}~${formatCurrency(value, language)}`;
}

/** 柱图槽位金额：槽位已按天过滤缺失与未定价，这里只做格式化。 */
function formatUsdText(value: number | null, language: Language, complete: boolean): string {
  return value === null ? '' : formatIncompleteUsd(value, complete, language);
}

/** 不完整费用显示已计价部分，不能把估算金额表达成真实账单下限。 */
function formatIncompleteUsd(value: number, complete: boolean, language: Language): string {
  return `${complete ? '' : language === 'zh-CN' ? '部分 ' : 'Partial '}~${formatCurrency(value, language)}`;
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

/** 指标偏好同属不可信输入：过滤未知标识、按固定顺序去重，空结果回落为默认显示项。 */
function readStoredMetrics(): MetricId[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(metricsStorageKey) ?? 'null');
    if (!Array.isArray(value)) return [...defaultMetricOrder];
    const known = new Set(value.filter((id): id is MetricId => typeof id === 'string' && metricOrder.includes(id as MetricId)));
    const selected = metricOrder.filter((id) => known.has(id));
    return selected.length > 0 ? selected : [...defaultMetricOrder];
  } catch {
    return [...defaultMetricOrder];
  }
}

function storeMetrics(value: MetricId[]): void {
  try {
    localStorage.setItem(metricsStorageKey, JSON.stringify(value));
  } catch {
    // 存储不可写时仍保留本次窗口内的指标选择。
  }
}

/** 维度偏好只接受两个已知取值，其他内容回落到 Token。 */
function readStoredChartDimension(): ChartDimension {
  try {
    return localStorage.getItem(chartDimensionStorageKey) === 'cost' ? 'cost' : 'tokens';
  } catch {
    return 'tokens';
  }
}
