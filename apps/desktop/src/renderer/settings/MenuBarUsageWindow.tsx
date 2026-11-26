import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { formatZeusDateTime, formatCodexCredits, hasPositiveCodexCredits, isCodexSubscriptionUsage } from '@zeus/shared';
import type { CodexOfficialRateWindow, KiloAccountUsage, UsageModelCostBreakdown, UsageModelOutputRateBreakdown, UsageOverviewRange, UsageOverviewSnapshot, UsageProviderSummary } from '@zeus/shared';
import type { AppShellSettings, DashboardClient } from '../apiClient.js';
import { compareModelNames } from '../modelOptionPresentation.js';
import { ModelProviderBadge, useModelProviderAppearances } from '../modelProviderAppearance.js';
import type { UsageModelProviderAppearance } from '@zeus/shared';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import './MenuBarUsageWindow.css';
import { Button } from '../ui/Button.js';

type Language = AppShellSettings['appLanguage'];
type Appearance = AppShellSettings['appearance'];
type UsageClient = Pick<DashboardClient, 'loadUsageOverview' | 'subscribeEvents'>;

/** 用量快照沿用原键；读取时校验当前渲染必需结构，让旧版缓存自然失效。 */
const snapshotStorageKey = 'zeus.menu-bar-usage.snapshot';
const selectionStorageKey = 'zeus.menu-bar-usage.selection';
/** 菜单栏独立保存供应商顺序，不改变供应商配置或后台统计顺序。 */
const providerOrderStorageKey = 'zeus.menu-bar-usage.provider-order';
const chartDimensionStorageKey = 'zeus.menu-bar-usage.chart-dimension';

/** 全部供应商和单个供应商共用的快捷时间选项顺序。 */
const overviewRangeOrder: UsageOverviewRange[] = ['today', '7d', '30d', 'all'];

/** 柱图统计维度；费用只能来自本地账本估算，官方账户历史没有模型维度。 */
type ChartDimension = 'tokens' | 'cost';

/** Codex 柱图统计来源；其他供应商始终使用 Zeus 本地账本。 */
type ChartSource = 'local' | 'account';

/** 柱图槽位：日期、数值与完整性，数值为 null 表示当天没有可用数据。 */
type DailySlot = { date: string; value: number | null; complete: boolean };

/** 指标明细复用同一个独立原生浮窗，并由类型决定表格内容。 */
type MetricDetail = { kind: 'cost'; label: string; entries: UsageModelCostBreakdown[]; equivalentCost: boolean } | { kind: 'output-rate'; label: string; entries: UsageModelOutputRateBreakdown[] };

/** 指标展示值可选携带结构化明细。 */
type MetricValue = {
  label: string;
  value: string;
  detail?: MetricDetail;
};

/** 菜单栏固定文案按当前语言选择，订阅费用与官方余额分别说明。 */
const copy = {
  'zh-CN': {
    all: '全部',
    allProviders: '全部供应源',
    providers: '供应商',
    reorderHelp: '拖动手柄排序，也可聚焦手柄后按 ↑ ↓',
    reorder: '排序',
    loading: '正在读取用量',
    noProviders: '还没有可统计的用量',
    noProvidersDetail: '使用 AI 后，这里会显示各个服务的用量。',
    quota: '额度剩余',
    /** 总览汇总可见供应商的本机用量，读屏文案与可见数据保持一致。 */
    todayLocalTokens: '今日本机 Token',
    localTokens: '本机 Token',
    /** 统计不完整时，供应商数只表示当前已记录的下限。 */
    providersUsed: (count: number, complete: boolean, range: UsageOverviewRange) => `${complete ? '' : '至少 '}${count} 个供应商${range === 'today' ? '今日' : ''}有用量`,
    incomplete: '统计不完整',
    usagePeriod: '统计周期',
    sevenDayTrend: '近 7 天趋势',
    /** 只用于官方明确返回的 Codex 主额度的五小时窗口。 */
    fiveHourQuota: (remaining: string) => `5 小时额度 · 剩余 ${remaining}`,
    available: '可用',
    localOnly: '本机统计',
    staleStatus: '数据过期',
    signedOut: '未登录',
    unavailableStatus: '配额异常',
    removedStatus: '已移除',
    tokens: 'Token',
    cacheHit: '缓存命中率',
    outputRate: '请求输出速率',
    outputRateDetail: '模型请求输出速率',
    /** 请求配置中的速度档位，与实测速率分列。 */
    outputRateSpeed: '速度档位',
    cacheUnsupported: '供应源未提供',
    cost: '费用',
    /** 订阅用量按 API 费率换算的金额，不是实际账单。 */
    equivalentCost: '等价费用',
    /** 订阅费用明细沿用相同的等价金额口径。 */
    equivalentCostDetail: '模型等价费用明细',
    /** 等价费用说明保持本地估算与官方扣款的区别。 */
    equivalentCostHint: '按已知模型费率估算 Zeus 本地等价费用，非实际扣款。',
    /** 官方账户剩余点数与订阅额度分别展示。 */
    remainingCredits: '剩余点数',
    costDetail: '模型费用明细',
    showCostDetail: '查看模型、单价和 Token 明细',
    showOutputRateDetail: '按模型和速度档位查看请求输出速率',
    model: '模型',
    /** 费用明细的速度档位和长上下文列。 */
    costSpeedContext: '速率 / 上下文',
    unitPrice: '单价 / 每百万',
    consumedTokens: '消耗 Token',
    estimatedCost: '费用',
    usageAndEstimatedCost: 'Token / 费用',
    inputPrice: '输入',
    cachedInputPrice: '缓存读',
    cacheWritePrice: '缓存写',
    outputPrice: '输出',
    perRequestPrice: '每次请求',
    pricePeriod: '价格周期',
    untilNow: '至今',
    overview: '用量概览',
    overviewRanges: { today: '今日', '7d': '近 7 天', '30d': '近 30 天', all: '全部' },
    dimension: '统计维度',
    dimensionTokens: 'Token',
    dimensionCost: '费用',
    statisticsSource: '统计来源',
    zeusLocalUsage: 'Zeus 本地统计',
    zeusLocalUsageHint: '只统计在 Zeus 中产生的用量；费用由本地账本按模型单价计算。',
    costEstimateHint: '费用由 Zeus 本地账本按请求单价计算，只合计已计价部分；覆盖率按可计费 Token 计算，不代表费用比例。',
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
    reorderHelp: 'Drag to reorder, or focus a handle and press ↑ ↓',
    reorder: 'Reorder',
    loading: 'Loading usage',
    noProviders: 'No usage recorded yet',
    noProvidersDetail: 'Usage for each AI service appears here after you use it.',
    quota: 'Quota remaining',
    /** Summary counts usage recorded in Zeus across the visible providers. */
    todayLocalTokens: 'Today’s local tokens',
    localTokens: 'Local tokens',
    /** 统计不完整时，供应商数只表示当前已记录的下限。 */
    providersUsed: (count: number, complete: boolean, range: UsageOverviewRange) => `${complete ? '' : 'At least '}${count} ${count === 1 ? 'provider' : 'providers'} used${range === 'today' ? ' today' : ''}`,
    incomplete: 'Incomplete usage',
    usagePeriod: 'Usage period',
    sevenDayTrend: '7-day trend',
    /** Shown for the official five-hour window in the main Codex quota. */
    fiveHourQuota: (remaining: string) => `5h quota · ${remaining} left`,
    available: 'Available',
    localOnly: 'Local stats',
    staleStatus: 'Stale data',
    signedOut: 'Signed out',
    unavailableStatus: 'Quota error',
    removedStatus: 'Removed',
    tokens: 'Tokens',
    cacheHit: 'Cache hit rate',
    outputRate: 'Request output rate',
    outputRateDetail: 'Model request output rates',
    /** 请求配置中的速度档位，与实测速率分列。 */
    outputRateSpeed: 'Speed',
    cacheUnsupported: 'Not provided',
    cost: 'Cost',
    /** 英文订阅金额沿用等价费用口径。 */
    equivalentCost: 'Equivalent cost',
    /** 英文订阅费用明细标题。 */
    equivalentCostDetail: 'Model equivalent cost details',
    /** 英文等价费用与实际扣款的边界说明。 */
    equivalentCostHint: 'Zeus-local equivalent cost estimated at known model rates; not actual charges.',
    /** 英文官方剩余点数标签。 */
    remainingCredits: 'Credits remaining',
    costDetail: 'Model cost details',
    showCostDetail: 'Show model, rate, and token details',
    showOutputRateDetail: 'Show request output rates by model and speed',
    model: 'Model',
    /** 英文费用明细中速度档位和长上下文的列名。 */
    costSpeedContext: 'Speed / Context',
    unitPrice: 'Rate / million',
    consumedTokens: 'Tokens',
    estimatedCost: 'Cost',
    usageAndEstimatedCost: 'Token / cost',
    inputPrice: 'Input',
    cachedInputPrice: 'Read',
    cacheWritePrice: 'Write',
    outputPrice: 'Output',
    perRequestPrice: 'Per request',
    pricePeriod: 'Price period',
    untilNow: 'Present',
    overview: 'Usage overview',
    overviewRanges: { today: 'Today', '7d': '7 days', '30d': '30 days', all: 'All' },
    dimension: 'Metric dimension',
    dimensionTokens: 'Tokens',
    dimensionCost: 'Cost',
    statisticsSource: 'Statistics source',
    zeusLocalUsage: 'Zeus local stats',
    zeusLocalUsageHint: 'Includes usage generated in Zeus only; cost is calculated from the local ledger using model rates.',
    costEstimateHint: 'The local ledger sums priced requests only. Coverage measures billable tokens, not the share of total cost.',
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
  /** 本地读取结束后，官方刷新继续在独立来源中进行。 */
  const refreshing = loading || Boolean(snapshot?.refreshingSources?.length);
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
      void resizeWindow(height).catch((cause: unknown) => console.warn('菜单栏浮窗尺寸调整失败。', cause));
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
      timer = setTimeout(
        () => {
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
        },
        refresh ? 0 : 150,
      );
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
    // 旧快照选中过已移除供应商时回到全部，避免保留无效标签选择。
    if (!snapshot || selection === 'all' || snapshot.providers.some((provider) => !provider.deleted && provider.providerId === selection)) return;
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
  /** 列表与标签共用有效供应商，旧缓存也不能重新显示已移除项；排序不修改原始快照。 */
  const providers = (snapshot?.providers ?? []).filter((provider) => !provider.deleted).sort((left, right) => (providerRanks.get(left.providerId) ?? providerOrder.length) - (providerRanks.get(right.providerId) ?? providerOrder.length));
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
  const freshness = updatedAt ? formatUpdatedAt(updatedAt, surfaceSettings.language) : loading ? text.loading : error ? text.failed : text.loading;

  return (
    <main className="menu-bar-usage-root" data-appearance={surfaceSettings.appearance} lang={surfaceSettings.language} aria-label={surfaceSettings.language === 'zh-CN' ? 'Zeus 菜单栏用量浮窗' : 'Zeus menu bar usage'}>
      <section ref={surfaceRef} className="menu-bar-usage-surface">
        <header className="menu-bar-usage-header">
          <span className="menu-bar-usage-identity">
            <span className="menu-bar-usage-mark" aria-hidden="true" />
            <strong>Zeus</strong>
          </span>
          <span className="menu-bar-usage-refresh-status">
            <small className="menu-bar-usage-freshness" aria-live="polite" data-icon-tooltip={freshness}>
              {freshness}
            </small>
            <Button
              unstyled
              className="menu-bar-usage-refresh"
              type="button"
              aria-label={refreshing ? text.loading : text.retry}
              data-icon-tooltip={refreshing ? (props.language === 'zh-CN' ? '正在刷新' : 'Refreshing') : props.language === 'zh-CN' ? '刷新用量' : 'Refresh usage'}
              aria-busy={refreshing}
              disabled={refreshing}
              onClick={() => load('force')}
            >
              {refreshing ? <RefreshPendingIcon /> : <RefreshIcon />}
            </Button>
          </span>
        </header>

        <nav className="menu-bar-usage-tabs" role="tablist" aria-label={text.allProviders}>
          <Button unstyled type="button" role="tab" aria-selected={selection === 'all'} tabIndex={selection === 'all' ? 0 : -1} onClick={() => select('all')} onKeyDown={handleTabKeyDown}>
            {text.all}
          </Button>
          {providers.map((provider) => (
            <Button
              unstyled
              key={provider.providerId}
              type="button"
              role="tab"
              aria-label={providerDisplayName(provider)}
              aria-selected={selection === provider.providerId}
              tabIndex={selection === provider.providerId ? 0 : -1}
              data-icon-tooltip={provider.deleted ? providerDisplayName(provider) : undefined}
              onClick={() => select(provider.providerId)}
              onKeyDown={handleTabKeyDown}
            >
              <ModelProviderBadge sourceId={provider.sourceId} sourceName={provider.name} />
              {providerDisplayName(provider, true)}
            </Button>
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
            <AllProviders providers={providers} fullCoverage={snapshot.providerCoverage === 'all-recorded'} language={surfaceSettings.language} onSelect={select} onMove={moveProvider} />
          )}
        </div>

        <footer className="menu-bar-usage-actions">
          <Button unstyled className="menu-bar-usage-primary-action" type="button" onClick={() => window.zeus?.openMenuBarUsageSettings?.('usage')}>
            {text.fullStatistics}
          </Button>
          <Button unstyled type="button" onClick={() => window.zeus?.showMainWindowFromMenuBarUsage?.()}>
            {text.showZeus}
          </Button>
          <Button unstyled type="button" onClick={() => window.zeus?.quitFromMenuBarUsage?.()}>
            {text.quitZeus}
          </Button>
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
      <Button unstyled type="button" onClick={() => props.onRetry()} disabled={props.loading}>
        {props.loading ? text.loading : text.retry}
      </Button>
    </div>
  );
}

/** 本机用量总览，独立手柄排序，点击内容仍打开供应商详情。 */
function AllProviders(props: { providers: UsageProviderSummary[]; fullCoverage: boolean; language: Language; onSelect: (providerId: string) => void; onMove: (providerId: string, targetId: string) => void }) {
  /** 新打开 All 时先展示今日，顶部和右列使用同一统计周期。 */
  const [range, setRange] = useState<UsageOverviewRange>('today');
  const { language, providers } = props;
  const text = copy[language];
  /** 只接收从本列表手柄发起的拖拽，外部文本和文件不会修改顺序。 */
  const [draggedId, setDraggedId] = useState<string | null>(null);
  /** 落点仅用于提示，松手后才提交排序，避免悬停时列表来回跳动。 */
  const [dropId, setDropId] = useState<string | null>(null);
  /** 键盘移动后向读屏播报当前位置。 */
  const [announcement, setAnnouncement] = useState('');
  if (providers.length === 0) {
    return (
      <div className="menu-bar-usage-empty">
        <strong>{text.noProviders}</strong>
        <span>{text.noProvidersDetail}</span>
      </div>
    );
  }
  /** 合计与活跃供应商数共用各供应商的本机记录，缺失用量时按下限展示。 */
  const total = providers.reduce(
    (summary, provider) => {
      /** 当前周期的本机用量是顶部汇总和该供应商右列的数据来源。 */
      const usage = provider.overviewRanges[range];
      return {
        tokens: summary.tokens + usage.local.totalTokens,
        activeProviders: summary.activeProviders + (usage.local.totalTokens > 0 ? 1 : 0),
        complete: summary.complete && usage.complete,
      };
    },
    { tokens: 0, activeProviders: 0, complete: props.fullCoverage },
  );
  /** 表头与读屏共用当前所选周期文案。 */
  const rangeLabel = text.overviewRanges[range];
  return (
    <section className="menu-bar-usage-provider-list" data-reorderable={providers.length > 1} aria-label={text.allProviders}>
      <div className="menu-bar-usage-all-range">
        <UsageRangeControl range={range} language={language} onChange={setRange} />
      </div>
      <div className="menu-bar-usage-provider-total">
        <span>
          <b>{range === 'today' ? text.todayLocalTokens : text.localTokens}</b>
          <small>
            {text.providersUsed(total.activeProviders, total.complete, range)}
            {total.complete ? '' : ` · ${text.incomplete}`}
          </small>
        </span>
        <strong>{formatIncompleteTokens(total.tokens, total.complete, language)}</strong>
      </div>
      <header className="menu-bar-usage-provider-heading" aria-hidden="true">
        <span>{text.providers}</span>
        <span>{text.sevenDayTrend}</span>
        <span>{rangeLabel}</span>
      </header>
      <span className="menu-bar-usage-sr-only" id="menu-bar-usage-reorder-help">
        {text.reorderHelp}
      </span>
      <span className="menu-bar-usage-sr-only" role="status">
        {announcement}
      </span>
      {providers.map((provider, index) => {
        const fullName = providerDisplayName(provider);
        /** 右列的 Token 和费用与顶部汇总取同一周期。 */
        const usage = provider.overviewRanges[range];
        /** 可见数值与读屏摘要共用格式，数据不完整时显示已知下限。 */
        const tokenValue = formatIncompleteTokens(usage.local.totalTokens, usage.complete, language);
        /** 完整价格覆盖时才展示估算，部分金额仍可在详情查看。 */
        const costValue = usage.complete && usage.local.priceCoverage === 1 ? formatUsd(usage.local.apiEquivalentUsd, usage.local.priceCoverage, language, '') : '';
        const costLabel = isCodexSubscriptionUsage(provider) ? text.equivalentCost : text.cost;
        /** 近七日柱高按当前供应商的本机用量峰值缩放，最后一格为当天。 */
        const slots = buildDailySlots(provider, 'tokens', 'local');
        const peak = Math.max(...slots.map((slot) => slot.value ?? 0));
        /** 主额度摘要只取当前可用的官方五小时窗口。 */
        const quota =
          !provider.stale && provider.officialState === 'available' && isCodexSubscriptionUsage(provider)
            ? provider.rateLimitWindows.find((entry) => entry.windowDurationMins === 300 && (isCodexQuotaWindow(entry) || (entry.limitId === 'default' && !entry.limitName)))
            : undefined;
        const quotaLabel = quota ? text.fiveHourQuota(formatPercent(quota.remainingPercent / 100, language)) : '';
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
            {providers.length > 1 ? (
              <Button
                unstyled
                className="menu-bar-usage-drag-handle"
                type="button"
                draggable
                aria-label={`${text.reorder} ${fullName}`}
                aria-describedby="menu-bar-usage-reorder-help"
                data-icon-tooltip={props.language === 'zh-CN' ? '拖动调整顺序' : 'Drag to reorder'}
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
                  const target = providers[targetIndex];
                  if (!target) return;
                  props.onMove(provider.providerId, target.providerId);
                  setAnnouncement(`${fullName} · ${targetIndex + 1} / ${providers.length}`);
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M5 3h.01M11 3h.01M5 8h.01M11 8h.01M5 13h.01M11 13h.01" />
                </svg>
              </Button>
            ) : null}
            <Button
              data-busy-behavior="background"
              unstyled
              className="menu-bar-usage-provider-open"
              type="button"
              aria-label={[fullName, rangeLabel, `${text.tokens} ${tokenValue}`, costValue && `${costLabel} ${costValue}`, quotaLabel].filter(Boolean).join(' · ')}
              aria-description={peak > 0 ? `${text.sevenDayTrend} · ${slots.map(({ value }) => (value === null ? text.missingDay : formatTokens(value, language))).join(', ')}` : undefined}
              data-icon-tooltip={[fullName, providerDetail, costValue && `${costLabel} ${costValue}`].filter(Boolean).join(' · ')}
              onClick={() => props.onSelect(provider.providerId)}
            >
              <span className="menu-bar-usage-provider-copy">
                <strong className="model-provider-labelled" data-icon-tooltip={provider.deleted ? fullName : undefined}>
                  <ModelProviderBadge sourceId={provider.sourceId} sourceName={fullName} />
                  <span>{fullName}</span>
                </strong>
                {provider.deleted ? <small>{text.removedStatus}</small> : quotaLabel && <small>{quotaLabel}</small>}
              </span>
              <span className="menu-bar-usage-provider-trend" aria-hidden="true">
                {peak > 0 && slots.map(({ date, value }) => <i key={date} style={{ blockSize: value === null ? 0 : `max(1px, ${(value / peak) * 100}%)` }} />)}
              </span>
              <span className="menu-bar-usage-provider-value">
                <small>{tokenValue}</small>
                {costValue && <strong>{costValue}</strong>}
              </span>
              <Chevron />
            </Button>
          </div>
        );
      })}
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

/** All 与供应商详情共用周期选项、选中状态和键盘可操作的按钮。 */
function UsageRangeControl({ range, language, onChange }: { range: UsageOverviewRange; language: Language; onChange: (range: UsageOverviewRange) => void }) {
  /** 浮窗的当前语言决定按钮及其分组名称。 */
  const text = copy[language];
  return (
    <span className="menu-bar-usage-range" role="group" aria-label={text.usagePeriod}>
      {overviewRangeOrder.map((entry) => (
        <Button unstyled key={entry} type="button" aria-pressed={range === entry} onClick={() => onChange(entry)}>
          {text.overviewRanges[entry]}
        </Button>
      ))}
    </span>
  );
}

/** 用量概览：四项固定指标共用同一时间范围与服务端聚合结果。 */
function UsageOverview(props: { provider: UsageProviderSummary; language: Language }) {
  const { provider, language } = props;
  const text = copy[language];
  /** 快捷范围只控制指标汇总，七日趋势图继续保持七根日柱。 */
  const [range, setRange] = useState<UsageOverviewRange>('7d');
  const metrics = readMetricValues(provider, language, range);
  return (
    <section className="menu-bar-usage-overview">
      <header className="menu-bar-usage-overview-head">
        <h3>
          {text.overview}
          {provider.overviewRanges[range].complete ? '' : ` · ${text.incomplete}`}
        </h3>
        <UsageRangeControl range={range} language={language} onChange={setRange} />
      </header>

      <dl className="menu-bar-usage-metrics">
        {metrics.map((metric) => (
          <Metric key={metric.label} {...metric} language={language} provider={provider} />
        ))}
      </dl>
    </section>
  );
}

/** 指标取值与文案：Token、费用为范围合计，命中率和输出速率为加权平均。 */
function readMetricValues(provider: UsageProviderSummary, language: Language, range: UsageOverviewRange): MetricValue[] {
  const text = copy[language];
  const summary = provider.overviewRanges[range];
  const local = summary.local;
  const complete = summary.complete === true;
  const cacheAvailable = provider.cacheUsageAvailable;
  /** 等价费用口径只影响 Codex 订阅，不改变 API 供应商文案。 */
  const equivalentCost = isCodexSubscriptionUsage(provider);
  /** 今日范围无需重复解释单价周期，只隐藏周期，不改变费用聚合结果。 */
  const costBreakdown = range === 'today' ? summary.costBreakdown.map((entry) => ({ ...entry, pricePeriod: null })) : summary.costBreakdown;
  return [
    { label: text.tokens, value: formatIncompleteTokens(local.totalTokens, summary.complete, language) },
    {
      label: equivalentCost ? text.equivalentCost : text.cost,
      value: complete ? formatUsd(local.apiEquivalentUsd, local.priceCoverage, language, text.noPrice) : '—',
      detail: costBreakdown.length ? { kind: 'cost', label: equivalentCost ? text.equivalentCostDetail : text.costDetail, entries: costBreakdown, equivalentCost } : undefined,
    },
    { label: text.cacheHit, value: !complete ? '—' : cacheAvailable ? formatPercent(local.cacheHitRate, language, '—') : text.cacheUnsupported },
    {
      label: text.outputRate,
      value: formatOutputRate(local.outputTokensPerSecond ?? null, language),
      detail: summary.outputRateBreakdown.length ? { kind: 'output-rate', label: text.outputRateDetail, entries: summary.outputRateBreakdown } : undefined,
    },
  ];
}

/** 完整展示官方额度窗口，避免备用额度的较低余额遮住重置后的主额度。 */
function ProviderSummaryCard(props: { provider: UsageProviderSummary; language: Language }) {
  /** 保持官方额度与本地用量独立，不为没有额度的供应商制造空态。 */
  const { provider, language } = props;
  if (provider.kiloAccount) return <KiloAccountSummary account={provider.kiloAccount} language={language} />;
  /** 只在 Codex 订阅有正数余额时展示，始终附在额度百分比下方。 */
  const showCredits = isCodexSubscriptionUsage(provider) && provider.officialState === 'available' && hasPositiveCodexCredits(provider.officialCreditBalance);
  if (provider.rateLimitWindows.length === 0) return null;
  /** 当前语言和供应商名称用于分组及辅助阅读摘要。 */
  const text = copy[language];
  const name = providerDisplayName(provider);
  /** 同一账户的有限余额只展示一次。 */
  const creditBalance = formatCodexCredits(provider.officialCreditBalance, language);
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
  const codexIndex = orderedGroups.findIndex(([, windows]) => isCodexQuotaWindow(windows[0]));
  if (provider.providerId === 'codex' && codexIndex > 0) orderedGroups.unshift(...orderedGroups.splice(codexIndex, 1));
  return (
    <section className="menu-bar-usage-account-card" aria-label={`${name} · ${text.quota}`}>
      {orderedGroups.map(([id, windows], groupIndex) => {
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
                  <div className="menu-bar-usage-quota-meta" data-with-credits={showCredits || undefined}>
                    <time dateTime={window.resetsAt ? new Date(window.resetsAt * 1_000).toISOString() : undefined}>{window.resetsAt ? formatReset(window.resetsAt, language, text.resets) : '—'}</time>
                    {showCredits && groupIndex === 0 && index === windows.length - 1 ? (
                      <span className="menu-bar-usage-account-credits" aria-label={`${text.remainingCredits} ${provider.officialCreditBalance}`}>
                        {text.remainingCredits} {creditBalance}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}
    </section>
  );
}

/** 账户充值余额与 Pass 本周期额度分开展示，沿用菜单栏的额度条和金额格式。 */
function KiloAccountSummary(props: { account: KiloAccountUsage; language: Language }) {
  const { account, language } = props;
  const zh = language === 'zh-CN';
  const pass = account.pass;
  /** 赠送额度仅使用官方已发放金额，不预估未来奖励。 */
  const total = pass ? pass.currentPeriodBaseCreditsUsd + pass.currentPeriodBonusCreditsUsd : 0;
  const remaining = pass ? Math.max(0, total - pass.currentPeriodUsageUsd) : null;
  const percent = remaining !== null && total > 0 ? Math.min(100, (remaining / total) * 100) : null;
  const nextBilling = pass?.nextBillingAt ? Date.parse(pass.nextBillingAt) / 1_000 : null;
  return (
    <section className="menu-bar-usage-account-card" aria-label={zh ? 'Kilo 账户额度' : 'Kilo account credits'}>
      <div className="menu-bar-usage-kilo-balance">
        <span>{zh ? '账户余额' : 'Account balance'}</span>
        <strong>{account.balanceUsd === null ? '—' : formatCostAmount(account.balanceUsd, 'USD', language)}</strong>
      </div>
      {pass ? (
        <section className="menu-bar-usage-quota-group" aria-label="Kilo Pass">
          <h3>Kilo Pass</h3>
          <div className="menu-bar-usage-account-quota">
            <span className="menu-bar-usage-quota-duration">{zh ? '本周期剩余' : 'Period remaining'}</span>
            <span className="menu-bar-usage-progress" role="progressbar" aria-label={zh ? 'Kilo Pass 本周期剩余额度' : 'Kilo Pass remaining credits'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}>
              <i style={{ inlineSize: `${percent ?? 0}%` }} />
            </span>
            <strong>{percent === null ? '—' : formatPercent(percent / 100, language)}</strong>
            <div className="menu-bar-usage-quota-meta" data-with-credits="true">
              <time dateTime={pass.nextBillingAt ?? undefined}>{nextBilling === null ? '—' : formatReset(nextBilling, language, zh ? '续费' : 'Renews')}</time>
              <span className="menu-bar-usage-account-credits">
                {formatCostAmount(remaining!, 'USD', language)} / {formatCostAmount(total, 'USD', language)}
              </span>
            </div>
          </div>
        </section>
      ) : null}
      {account.error || account.stale ? (
        <div className="menu-bar-usage-notice" data-tone={account.error ? 'warning' : undefined} role="status">
          {account.error ? (zh ? account.error : 'Kilo account refresh failed.') : zh ? '额度待刷新' : 'Credits awaiting refresh'}
        </div>
      ) : null}
    </section>
  );
}

/** Codex 可切换本地或账户来源；其他供应商固定使用本地日用量。 */
function DailyBars(props: { provider: UsageProviderSummary; language: Language }) {
  /** Codex 才显示来源选择，首次打开固定使用 Zeus 本地统计。 */
  const text = copy[props.language];
  const sourceSelectable = props.provider.providerId === 'codex';
  /** Codex 订阅趋势和按钮与概览使用同一等价费用文案。 */
  const costLabel = isCodexSubscriptionUsage(props.provider) ? text.equivalentCost : text.cost;
  const [source, setSource] = useState<ChartSource>('local');
  /** 本地维度单独保存；切到账户来源时不丢失用户之前选择的费用维度。 */
  const [localDimension, setLocalDimension] = useState<ChartDimension>(readStoredChartDimension);
  /** Codex 账户接口只返回 Token，不能把本地费用冒充为账户费用。 */
  const accountSource = sourceSelectable && source === 'account';
  const dimension: ChartDimension = accountSource ? 'tokens' : localDimension;
  /** 费用维度只来自本地账本，官方账户历史没有模型维度，无法换算金额。 */
  const costDimension = dimension === 'cost';
  const label = costDimension ? costLabel : accountSource ? text.accountUsage : sourceSelectable ? text.zeusLocalUsage : text.recentUsage;
  /** 图注口径随维度切换，避免两种数据源被当成同一份统计。 */
  const sourceHint = accountSource ? text.accountUsageHint : sourceSelectable ? (isCodexSubscriptionUsage(props.provider) ? text.equivalentCostHint : text.zeusLocalUsageHint) : costDimension ? text.costEstimateHint : null;
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
  const hasLocalHistory = props.provider.dailyLocal.length > 0 || props.provider.collectionStartedAt !== null || Boolean(props.provider.incompleteLocalDates?.length);
  if (!sourceSelectable && !hasLocalHistory)
    return (
      <div className="menu-bar-usage-chart-empty">
        <small>{text.insufficientHistory}</small>
      </div>
    );
  /** 补齐近七日日期；开始记录之前保留缺失状态。 */
  const slots = buildDailySlots(props.provider, dimension, accountSource ? 'account' : 'local');
  const maximum = Math.max(...slots.flatMap((slot) => (slot.value && slot.value > 0 ? [slot.value] : [])), 1);
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
            <Button unstyled type="button" aria-pressed={!costDimension} onClick={() => selectDimension('tokens')}>
              {text.dimensionTokens}
            </Button>
            <Button unstyled type="button" aria-pressed={costDimension} onClick={() => selectDimension('cost')}>
              {costLabel}
            </Button>
          </span>
        ) : null}
      </figcaption>
      <div className="menu-bar-usage-bars-plot">
        {slots.map((slot) => {
          const state = slot.value === null ? 'missing' : slot.value === 0 ? 'zero' : 'positive';
          const formatted = costDimension ? formatUsdText(slot.value, props.language, slot.complete) : slot.value === null ? '' : formatIncompleteTokens(slot.value, slot.complete, props.language);
          const value = slot.value === null ? text.missingDay : costDimension ? formatted : `${formatted} Token`;
          /** 七列共用有限宽度：Token 的万级数字去掉小数，费用与悬浮摘要统一保留两位。 */
          const barLabel = slot.value === null ? '—' : formatted;
          const chartLabel = slot.value === null ? barLabel : costDimension ? formatCurrency(slot.value, props.language) : barLabel.length > 6 ? `${slot.complete ? '' : '≥'}${formatTokens(slot.value, props.language, 0)}` : barLabel;
          return (
            <span key={slot.date} data-state={state} aria-label={`${formatShortDate(slot.date, props.language)} ${value}`} data-icon-tooltip={`${slot.date} · ${value}`}>
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

/** 菜单栏指标在名称右侧提供可点击的结构化明细。 */
function Metric(props: MetricValue & { language: Language; provider: UsageProviderSummary }) {
  return (
    <div>
      <dt>
        <span>{props.label}</span>
        {props.detail ? <MetricDetailPopover detail={props.detail} language={props.language} provider={props.provider} /> : null}
      </dt>
      <dd>{props.value}</dd>
    </div>
  );
}

/** 独立指标明细窗口使用的桥接数据类型。 */
type MenuBarUsageCostDetailPayload = Awaited<ReturnType<NonNullable<Window['zeus']>['getMenuBarUsageCostDetail']>>;

/** 指标说明在独立透明窗口中从鼠标左下方展开，不改变菜单栏原生宽度。 */
function MetricDetailPopover(props: { detail: MetricDetail; language: Language; provider: UsageProviderSummary }) {
  /** 独立浮窗使用菜单栏已读取的供应商外观。 */
  const providerAppearance = useModelProviderAppearances().get(props.provider.sourceId);
  const text = copy[props.language];
  /** 每个指标拥有稳定身份，主进程用它保证多个费用指标互斥切换。 */
  const detailId = useId();
  /** 控件容器用于识别菜单栏内部的外部点击。 */
  const controlRef = useRef<HTMLDivElement>(null);
  /** 触发器边界用于键盘打开时换算屏幕锚点。 */
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** 鼠标打开时直接保存真实屏幕坐标，独立窗口无需换算父窗口扩宽偏移。 */
  const pointerAnchorRef = useRef<{ x: number; y: number } | null>(null);
  /** 点击或键盘打开后固定展示，移开鼠标不自动关闭。 */
  const pinnedRef = useRef(false);
  /** 展开状态只用于触发器可访问性，实际窗口状态由主进程广播校准。 */
  const [open, setOpen] = useState(false);
  /** 把当前内容和锚点交给独立原生窗口；主进程负责屏幕边界与显示时机。 */
  const showCostDetail = useCallback(
    (pinned: boolean) => {
      /** 浏览器预览没有 Electron 桥接，只保留静态触发器。 */
      const showWindow = window.zeus?.showMenuBarUsageCostDetail;
      if (!showWindow) return;
      /** 键盘打开时以图标右下角作为等价屏幕锚点。 */
      const trigger = triggerRef.current;
      if (!trigger) return;
      /** 当前应用外观直接来自菜单栏根节点，避免为一个展示字段层层透传。 */
      const appearanceValue = document.querySelector<HTMLElement>('.menu-bar-usage-root')?.dataset.appearance;
      /** 非法或缺失值回退到系统外观。 */
      const appearance: Appearance = appearanceValue === 'light' || appearanceValue === 'dark' ? appearanceValue : 'system';
      /** 鼠标优先使用事件的屏幕坐标，键盘则把元素视口坐标换算成屏幕坐标。 */
      const triggerRect = trigger.getBoundingClientRect();
      /** 最终锚点始终落在触发图标内部或右下角。 */
      const anchor = pointerAnchorRef.current ?? { x: window.screenX + triggerRect.right, y: window.screenY + triggerRect.bottom };
      pinnedRef.current = pinned;
      setOpen(true);
      const provider = { sourceId: props.provider.sourceId, sourceName: props.provider.name, templateId: providerAppearance?.templateId, iconDataUrl: providerAppearance?.iconDataUrl };
      void showWindow({ id: detailId, language: props.language, appearance, anchor, pinned, provider, ...props.detail }).catch((cause: unknown) => {
        setOpen(false);
        console.warn('菜单栏指标明细无法打开。', cause);
      });
    },
    [detailId, props.detail, props.language, props.provider.sourceId, props.provider.name, providerAppearance],
  );

  useEffect(() => {
    /** 主进程是跨窗口可见性的唯一事实源，切换到其他指标时同步重置本地固定状态。 */
    const subscribe = window.zeus?.onMenuBarUsageCostDetailChanged;
    if (!subscribe) return;
    return subscribe((payload) => {
      /** 只有当前指标身份匹配时才保持展开。 */
      const active = payload?.id === detailId;
      setOpen(active);
      pinnedRef.current = active ? payload.pinned : false;
    });
  }, [detailId]);

  useEffect(() => {
    if (!open) return;
    /** Escape 只关闭独立费用明细，不继续冒泡关闭整个菜单栏窗口。 */
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      pinnedRef.current = false;
      void window.zeus?.hideMenuBarUsageCostDetail?.();
    };
    /** 点击当前触发器之外的菜单栏内容时关闭已固定明细。 */
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (controlRef.current?.contains(event.target as Node)) return;
      pinnedRef.current = false;
      void window.zeus?.hideMenuBarUsageCostDetail?.();
    };
    window.addEventListener('keydown', closeOnEscape, true);
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      window.removeEventListener('keydown', closeOnEscape, true);
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [open]);

  /** 悬停时记录真实屏幕锚点并立即打开明细，保留已有固定状态。 */
  const showFromPointer = (event: { screenX: number; screenY: number }) => {
    pointerAnchorRef.current = { x: event.screenX, y: event.screenY };
    void window.zeus?.cancelHideMenuBarUsageCostDetail?.();
    showCostDetail(pinnedRef.current);
  };

  /** 未固定时由主进程延迟关闭，允许鼠标跨过两个原生窗口之间的间距。 */
  const scheduleHoverClose = () => {
    if (pinnedRef.current) return;
    void window.zeus?.scheduleHideMenuBarUsageCostDetail?.();
  };

  /** 点击在固定与关闭之间切换。 */
  const togglePinned = () => {
    if (pinnedRef.current) {
      pinnedRef.current = false;
      void window.zeus?.hideMenuBarUsageCostDetail?.();
      return;
    }
    pointerAnchorRef.current = null;
    showCostDetail(true);
  };

  return (
    <div ref={controlRef} className="menu-bar-usage-cost-detail-control" onPointerEnter={showFromPointer} onPointerLeave={scheduleHoverClose}>
      <Button
        unstyled
        ref={triggerRef}
        type="button"
        className="menu-bar-usage-cost-detail-trigger"
        aria-label={`${props.detail.label} · ${props.detail.kind === 'cost' ? text.showCostDetail : text.showOutputRateDetail}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={togglePinned}
        onFocus={(event) => {
          if (!event.currentTarget.matches(':focus-visible')) return;
          pointerAnchorRef.current = null;
          showCostDetail(true);
        }}
      >
        <span aria-hidden="true">?</span>
      </Button>
    </div>
  );
}

/** 独立透明窗口订阅主进程数据并按真实内容请求原生尺寸。 */
export function MenuBarUsageCostDetailWindow(props: { initialPayload: MenuBarUsageCostDetailPayload | null }) {
  /** 当前展示数据会在用户切换费用指标或应用外观时更新。 */
  const [payload, setPayload] = useState<MenuBarUsageCostDetailPayload | null>(props.initialPayload);
  /** 根节点尺寸包含面板阴影留白，是原生窗口唯一的尺寸依据。 */
  const surfaceRef = useRef<HTMLElement>(null);

  useEffect(() => window.zeus?.onMenuBarUsageCostDetailChanged?.(setPayload), []);

  useEffect(() => {
    if (payload) document.title = payload.label;
  }, [payload]);

  useEffect(() => {
    /** 明细窗口可能只有窗口焦点而没有具体 DOM 焦点，因此 Escape 在全局监听。 */
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void window.zeus?.hideMenuBarUsageCostDetail?.();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, []);

  useEffect(() => {
    /** 窗口隐藏时 payload 会被清空，不再发送无意义的尺寸请求。 */
    const surface = surfaceRef.current;
    const resizeWindow = window.zeus?.resizeMenuBarUsageCostDetail;
    if (!payload || !surface || !resizeWindow) return;
    /** 内容、字体或滚动区变化后按实际外框尺寸同步原生窗口。 */
    const updateSize = () => {
      const rect = surface.getBoundingClientRect();
      /** 原生窗口隐藏时布局可能短暂归零，跳过该次观察结果。 */
      if (rect.width <= 0 || rect.height <= 0) return;
      void resizeWindow(Math.ceil(rect.width), Math.ceil(rect.height)).catch((cause: unknown) => console.warn('菜单栏费用明细尺寸调整失败。', cause));
    };
    /** 原生窗口隐藏期间完成首轮测量，避免用户看到最大初始尺寸。 */
    const observer = new ResizeObserver(updateSize);
    observer.observe(surface);
    updateSize();
    return () => observer.disconnect();
  }, [payload]);

  if (!payload) return null;
  return (
    <main
      ref={surfaceRef}
      className="menu-bar-usage-root menu-bar-usage-cost-detail-window-root"
      data-appearance={payload.appearance}
      lang={payload.language}
      onPointerEnter={() => window.zeus?.cancelHideMenuBarUsageCostDetail?.()}
      onPointerLeave={() => window.zeus?.scheduleHideMenuBarUsageCostDetail?.()}
    >
      <MetricDetailPanel payload={payload} />
    </main>
  );
}

/** 独立窗口按载荷类型渲染对应表格，窗口交互和定位保持共用。 */
function MetricDetailPanel(props: { payload: NonNullable<MenuBarUsageCostDetailPayload> }) {
  const { payload } = props;
  return payload.kind === 'cost' ? (
    <CostBreakdownPanel entries={payload.entries} label={payload.label} language={payload.language} equivalentCost={payload.equivalentCost} provider={payload.provider} />
  ) : (
    <OutputRateBreakdownPanel entries={payload.entries} label={payload.label} language={payload.language} provider={payload.provider} />
  );
}

/** 按模型和速度档位展示同一时间范围内加权后的请求输出速率。 */
function OutputRateBreakdownPanel(props: { entries: UsageModelOutputRateBreakdown[]; label: string; language: Language; provider?: UsageModelProviderAppearance }) {
  /** 列名跟随菜单栏窗口的语言。 */
  const text = copy[props.language];
  return (
    <section className="menu-bar-usage-cost-detail menu-bar-usage-cost-detail-window" role="dialog" aria-label={props.label}>
      <strong>{props.label}</strong>
      <div className="menu-bar-usage-cost-table-scroll" data-scrollable={props.entries.length > 8}>
        <table>
          <thead>
            <tr>
              <th scope="col">{text.model}</th>
              <th scope="col">{text.outputRateSpeed}</th>
              <th scope="col">{text.outputRate}</th>
            </tr>
          </thead>
          <tbody>
            {props.entries.map((entry) => (
              <tr key={JSON.stringify([entry.model, entry.serviceTier])}>
                <th scope="row">
                  <span className="model-provider-labelled">
                    {props.provider ? <ModelProviderBadge {...props.provider} /> : null}
                    {entry.model}
                  </span>
                </th>
                <td lang="en">{formatOutputRateServiceTier(entry.serviceTier)}</td>
                <td>{formatOutputRate(entry.outputTokensPerSecond, props.language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** 常用速度使用英文名称，其他档位保留供应商标识。 */
function formatOutputRateServiceTier(tier: string | null): string {
  switch (tier) {
    case 'default':
      return 'Standard';
    case 'priority':
      return 'Fast';
    case 'ultrafast':
      return 'Ultrafast';
    default:
      return tier ?? 'Unknown';
  }
}

/** 常见计费档位按速度从低到高排列。 */
const costServiceTierRanks = new Map<UsageModelCostBreakdown['serviceTier'], number>([
  ['standard', 0],
  ['fast', 1],
  ['ultrafast', 2],
]);

/** 模型内先按速度、再按上下文排序；相同组合保留账本传入的明细顺序。 */
function compareModelPriceTiers(left: UsageModelCostBreakdown, right: UsageModelCostBreakdown): number {
  /** 未知档位排在已知档位之后，再按其供应商标识排列。 */
  const rankDifference = (costServiceTierRanks.get(left.serviceTier) ?? costServiceTierRanks.size) - (costServiceTierRanks.get(right.serviceTier) ?? costServiceTierRanks.size);
  return rankDifference || (left.serviceTier ?? '').localeCompare(right.serviceTier ?? '', 'en') || Number(left.longContext) - Number(right.longContext);
}

/** 费用明细按原始模型 ID 分组，每行对应一个计费档位和价格快照。 */
function CostBreakdownPanel(props: { entries: UsageModelCostBreakdown[]; label: string; language: Language; equivalentCost?: boolean; provider?: UsageModelProviderAppearance }) {
  /** 列名和辅助说明始终跟随当前语言。 */
  const text = copy[props.language];
  /** 独立窗口读取明确的计费口径，不通过标题文字猜测供应商类型。 */
  const costLabel = props.equivalentCost ? text.equivalentCost : text.estimatedCost;
  /** 只有存在档位或长上下文数据时才需要这一列。 */
  const showSpeedContext = props.entries.some((entry) => entry.serviceTier || entry.longContext);
  /** 同名模型使用同一个行组，数字段按数值升序排列。 */
  const modelGroups = [...Map.groupBy(props.entries, (entry) => entry.model)].sort(([left], [right]) => compareModelNames(left, right, 'ascending'));
  return (
    <section className="menu-bar-usage-cost-detail menu-bar-usage-cost-detail-window" role="dialog" aria-label={props.label}>
      <strong>{props.label}</strong>
      <div className="menu-bar-usage-cost-table-scroll" data-scrollable={props.entries.length > 8}>
        <table>
          <thead>
            <tr>
              <th scope="col">{text.model}</th>
              {showSpeedContext ? <th scope="col">{text.costSpeedContext}</th> : null}
              <th scope="col">{text.unitPrice}</th>
              <th scope="col">{props.equivalentCost ? `${text.tokens} / ${costLabel}` : text.usageAndEstimatedCost}</th>
            </tr>
          </thead>
          {modelGroups.map(([model, entries]) => (
            <tbody key={model}>
              {entries.sort(compareModelPriceTiers).map((entry, index) => {
                /** 可见值与读屏标签共用同一格式的 Token 数量。 */
                const tokens = formatTokens(entry.usage.totalTokens, props.language);
                /** 金额为空时，结果列只保留 Token 数量。 */
                const estimatedCost = formatModelEstimatedCost(entry, props.language);
                return (
                  <tr key={`${model}-${index}`}>
                    {index === 0 ? (
                      <th scope="rowgroup" rowSpan={entries.length}>
                        <span className="model-provider-labelled">
                          {props.provider ? <ModelProviderBadge {...props.provider} /> : null}
                          {model}
                        </span>
                      </th>
                    ) : null}
                    {showSpeedContext ? (
                      <td lang="en">
                        {entry.serviceTier ? <span>{formatModelPriceTier(entry.serviceTier)}</span> : null}
                        {entry.longContext ? <span className="menu-bar-usage-long-context">LongContext</span> : null}
                      </td>
                    ) : null}
                    <td className="menu-bar-usage-unit-price">
                      {formatModelRate(entry, props.language).map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                      {entry.pricePeriod ? (
                        <span className="menu-bar-usage-price-period" aria-label={`${text.pricePeriod} ${formatPricePeriod(entry.pricePeriod, props.language)}`}>
                          {formatPricePeriod(entry.pricePeriod, props.language)}
                        </span>
                      ) : null}
                    </td>
                    <td aria-label={`${text.consumedTokens} ${tokens}${estimatedCost ? `；${costLabel} ${estimatedCost}` : ''}`}>
                      <span>{tokens}</span>
                      {estimatedCost ? <span className="menu-bar-usage-model-estimated-cost">{estimatedCost}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  );
}

/** 计费档位的英文名称使用首字母大写。 */
function formatModelPriceTier(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/** 单价按普通输入输出、缓存读写压成两行，缺少费率时留空。 */
function formatModelRate(entry: UsageModelCostBreakdown, language: Language): string[] {
  const text = copy[language];
  const rate = entry.rate;
  if (!rate) return [];
  if (rate.charges?.length) return rate.charges.map((charge) => `${charge.meter} ${charge.amount === null ? '—' : formatRateAmount(charge.amount, rate.currency, language)} / ${charge.quantityPerPrice} ${charge.unit}`);
  if (rate.perRequest !== null) return [`${text.perRequestPrice} ${formatRateAmount(rate.perRequest, rate.currency, language)}`];
  if (!rate.perMillion) return [];
  /** 普通输入输出始终成对展示，便于横向比较。 */
  const lines = [`${text.inputPrice} ${formatRateAmount(rate.perMillion.input, rate.currency, language)} · ${text.outputPrice} ${formatRateAmount(rate.perMillion.output, rate.currency, language)}`];
  /** 缓存类别只在单价已知时显示，避免把未知误写成零。 */
  const cacheRates: string[] = [];
  if (rate.perMillion.cachedInput !== null) cacheRates.push(`${text.cachedInputPrice} ${formatRateAmount(rate.perMillion.cachedInput, rate.currency, language)}`);
  if (rate.perMillion.cacheWrite !== null) cacheRates.push(`${text.cacheWritePrice} ${formatRateAmount(rate.perMillion.cacheWrite, rate.currency, language)}`);
  if (cacheRates.length > 0) lines.push(cacheRates.join(' · '));
  return lines;
}

/** 价格目录周期统一使用紧凑日期；最新目录按用户可见语义显示到“至今”。 */
function formatPricePeriod(period: NonNullable<UsageModelCostBreakdown['pricePeriod']>, language: Language): string {
  /** 日期只替换分隔符，不受运行机器时区影响。 */
  const formatDate = (value: string) => value.replaceAll('-', '/');
  return `${formatDate(period.from)}～${period.to ? formatDate(period.to) : copy[language].untilNow}`;
}

/** 费用使用后台汇总的原币金额，缺少金额时返回空。 */
function formatModelEstimatedCost(entry: UsageModelCostBreakdown, language: Language): string | null {
  const costs = entry.estimatedCosts;
  if (!costs?.length) return null;
  return costs.map(({ currency, amount }) => `~${formatCostAmount(amount, currency, language)}`).join(' + ');
}

/** 费率保留原币种；美元与人民币使用熟悉符号，其他单位显示原始代码。 */
function formatRateAmount(value: number, currency: string, language: Language): string {
  const amount = new Intl.NumberFormat(language, { maximumFractionDigits: 6 }).format(value);
  if (currency === 'USD') return `$${amount}`;
  if (currency === 'CNY') return `¥${amount}`;
  return `${currency} ${amount}`;
}

/** 费用金额固定保留两位小数；费率继续由独立格式化函数保留必要精度。 */
function formatCostAmount(value: number, currency: string, language: Language): string {
  /** 非零的小额费用不能四舍五入成零，使用最小展示单位表达。 */
  const lessThanMinimum = value > 0 && value < 0.01;
  const amount = new Intl.NumberFormat(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
  if (currency === 'USD') return `${lessThanMinimum ? '<' : ''}$${lessThanMinimum ? '0.01' : amount}`;
  if (currency === 'CNY') return `${lessThanMinimum ? '<' : ''}¥${lessThanMinimum ? '0.01' : amount}`;
  return `${currency} ${lessThanMinimum ? '<0.01' : amount}`;
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
    /** 本地缺报日期的数值仅代表已经记录的用量。 */
    const incomplete = !accountUsage && provider.incompleteLocalDates?.includes(dateKey);
    const recorded = bucketsByDate.get(dateKey);
    /** 本地采集以后，完整且没有记录的日期视为零。 */
    const emptyLocalDay = recorded === undefined && !accountUsage && !incomplete && collectionStart !== null && dateKey >= collectionStart;
    /** 官方缺日与未定价金额保留空值。 */
    const knownValue = typeof recorded === 'number' ? Math.max(0, recorded) : emptyLocalDay ? 0 : null;
    /** 账本将无已知 Token 的缺报记录保存为零，趋势使用缺失状态。 */
    const value = dimension === 'tokens' && incomplete && knownValue === 0 ? null : knownValue;
    return { date: dateKey, value, complete: !incomplete && value !== null && (dimension !== 'cost' || recorded === undefined || pricingByDate.get(dateKey) === 1) };
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

/** 官方额度池可通过标识或名称识别；Spark 等独立额度保留各自口径。 */
function isCodexQuotaWindow(window: CodexOfficialRateWindow): boolean {
  return window.limitId?.toLowerCase() === 'codex' || window.limitName?.toLowerCase() === 'codex';
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

/** 用量缺失且没有已知用量时不显示零。 */
function formatIncompleteTokens(value: number, complete: boolean | undefined, language: Language): string {
  if (!complete && value === 0) return '—';
  const formatted = formatTokens(value, language);
  return complete === true ? formatted : `≥${formatted}`;
}

function formatPercent(value: number | null, language: Language, unavailable = ''): string {
  return value === null ? unavailable : new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(Math.max(0, value));
}

/** 请求输出速率沿用会话详情精度，低于每秒一百 Token 时保留一位小数。 */
function formatOutputRate(value: number | null, language: Language): string {
  return value === null ? '—' : `${new Intl.NumberFormat(language, { maximumFractionDigits: value < 100 ? 1 : 0 }).format(value)} tokens / s`;
}

/** 美元费用统一使用简短货币符号并固定保留两位小数。 */
function formatCurrency(value: number, language: Language): string {
  return formatCostAmount(value, 'USD', language);
}

/** 主金额只标记估算属性；未计价范围由紧邻指标区的覆盖率说明统一承载。 */
function formatUsd(value: number | null, coverage: number | null | undefined, language: Language, unavailable: string): string {
  if (value === null || !coverage) return unavailable;
  return `~${formatCurrency(value, language)}`;
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
  return `${prefix} ${formatZeusDateTime(timestamp * 1_000, language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
}

/** 顶部更新时间只显示时间，过期状态继续由颜色和完整提示表达。 */
function formatUpdatedAt(value: string, language: Language): string {
  return formatZeusDateTime(value, language, { hour: '2-digit', minute: '2-digit' });
}

function formatShortDate(value: string, language: Language): string {
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function readStoredSnapshot(): UsageOverviewSnapshot | null {
  try {
    const value = JSON.parse(localStorage.getItem(snapshotStorageKey) ?? 'null') as UsageOverviewSnapshot | null;
    /** 缓存可能来自旧版结构；缺少当前渲染必需字段时等待实时读取，不能让菜单栏整页崩溃。 */
    const compatible = value?.providers.every(
      (provider) =>
        Array.isArray(provider.dailyLocal) &&
        overviewRangeOrder.every(
          (range) =>
            Boolean(provider.overviewRanges?.[range]?.local) &&
            Array.isArray(provider.overviewRanges[range].costBreakdown) &&
            provider.overviewRanges[range].costBreakdown.every((entry) => typeof entry.longContext === 'boolean' && (entry.serviceTier === null || typeof entry.serviceTier === 'string')) &&
            Array.isArray(provider.overviewRanges[range].outputRateBreakdown) &&
            provider.overviewRanges[range].outputRateBreakdown.every((entry) => typeof entry.model === 'string' && (entry.serviceTier === null || typeof entry.serviceTier === 'string') && typeof entry.outputTokensPerSecond === 'number'),
        ),
    );
    return value && Array.isArray(value.providers) && compatible && typeof value.updatedAt === 'string' ? value : null;
  } catch {
    return null;
  }
}

function storeSnapshot(value: UsageOverviewSnapshot): void {
  try {
    localStorage.setItem(snapshotStorageKey, JSON.stringify({ ...value, refreshingSources: [] }));
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

/** 维度偏好只接受两个已知取值，其他内容回落到 Token。 */
function readStoredChartDimension(): ChartDimension {
  try {
    return localStorage.getItem(chartDimensionStorageKey) === 'cost' ? 'cost' : 'tokens';
  } catch {
    return 'tokens';
  }
}
