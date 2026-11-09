import type { ModelConnectionRecord } from '@zeus/ai-runtime';
import type { KiloAccountUsage, KiloPassUsage } from '@zeus/shared';

/** Kilo 的公开模型目录同时提供美元 Token 单价，不需要发送账户凭据。 */
export const kiloModelsUrl = 'https://ai-gateway.kilo.ai/api/v1/models';

/** 官方账户接口与推理网关分离；余额和个人 Pass 共用此服务。 */
const kiloAccountOrigin = 'https://api.kilo.ai';

/** 仅识别已知官方 HTTPS 来源，避免把第三方中转密钥发送给 Kilo。 */
export function isKiloConnection(connection: Pick<ModelConnectionRecord, 'baseUrl'>): boolean {
  const origin = new URL(connection.baseUrl).origin;
  return origin === kiloAccountOrigin || origin === 'https://ai-gateway.kilo.ai';
}

/** 官方 JSON 对象字段的读取边界。 */
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 额度和用量必须为有限的非负美元数，缺字段不能冒充零。 */
function dollars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('额度字段无效');
  return value;
}

/** 解析官方 tRPC 订阅快照；取消且已失效的订阅不再展示周期额度。 */
function parsePass(value: unknown): KiloPassUsage | null {
  const item = Array.isArray(value) ? value[0] : value;
  const data = record(record(record(item)?.result)?.data);
  const root = record(data?.json) ?? data ?? record(value);
  if (!root || !Object.hasOwn(root, 'subscription')) throw new Error('套餐响应无效');
  if (root.subscription === null) return null;
  const subscription = record(root.subscription);
  if (!subscription) throw new Error('套餐字段无效');
  if (typeof subscription.status === 'string' && !['active', 'past_due', 'trialing'].includes(subscription.status)) return null;
  const next = subscription.nextBillingAt ?? subscription.nextRenewalAt;
  return {
    currentPeriodBaseCreditsUsd: dollars(subscription.currentPeriodBaseCreditsUsd),
    currentPeriodBonusCreditsUsd: dollars(subscription.currentPeriodBonusCreditsUsd),
    currentPeriodUsageUsd: dollars(subscription.currentPeriodUsageUsd),
    nextBillingAt: typeof next === 'string' && Number.isFinite(Date.parse(next)) ? new Date(next).toISOString() : null,
  };
}

/** 官方账户查询共用缓存和在途请求；只读取余额与 Pass，不发起生成或扣款。 */
export function createKiloAccountUsageService(options: {
  /** 当前连接清单，删除或更换凭据后不沿用旧账户数据。 */
  connections(): ModelConnectionRecord[];
  /** 从现有 SecretStore 读取指定连接的密钥，不返回给界面。 */
  readApiKey(connectionId: string): Promise<string | null | undefined>;
  /** 使用宿主时钟记录刷新时间。 */
  now(): string;
  /** 沿用宿主网络实现。 */
  fetch?: typeof fetch;
}) {
  /** 缓存身份包含配置修订；密钥轮换会更新该修订。 */
  const cache = new Map<string, { revision: string; snapshot: KiloAccountUsage }>();
  /** 相同配置的重复刷新合并，配置改变时等待旧请求退出。 */
  const active = new Map<string, Promise<void>>();
  /** 关闭宿主时中止网络并等待任务退出。 */
  const controller = new AbortController();
  /** 复用模型连接的网络实现。 */
  const fetcher = options.fetch ?? fetch;

  /** 被动读取仅访问内存，过期数据保留原值并标记陈旧。 */
  function read(connection: ModelConnectionRecord): KiloAccountUsage | undefined {
    if (!connection.enabled || !isKiloConnection(connection)) return undefined;
    const entry = cache.get(connection.id);
    const snapshot = entry?.revision === connection.updatedAt ? entry.snapshot : undefined;
    if (!snapshot) return { balanceUsd: null, pass: null, checkedAt: null, stale: true, error: null };
    return { ...snapshot, stale: snapshot.stale || Date.parse(options.now()) - Date.parse(snapshot.checkedAt!) >= 10 * 60_000 };
  }

  /** 凭据仅发往固定官方来源；拒绝重定向和响应正文中的错误泄漏。 */
  async function request(path: string, apiKey: string): Promise<unknown> {
    const response = await fetcher(`${kiloAccountOrigin}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  /** 单项失败保留该项上次成功数据，另一项仍可独立更新。 */
  async function refresh(connection: ModelConnectionRecord): Promise<void> {
    const previous = read(connection)!;
    let snapshot = previous;
    try {
      const apiKey = await options.readApiKey(connection.id);
      if (!apiKey) throw new Error('未配置 Kilo API Key');
      const params = new URLSearchParams({ batch: '1', input: JSON.stringify({ '0': null }) });
      const [balance, pass] = await Promise.allSettled([request('/api/profile/balance', apiKey).then((value) => dollars(record(value)?.balance)), request(`/api/trpc/kiloPass.getState?${params}`, apiKey).then(parsePass)]);
      const errors = [balance.status === 'rejected' ? 'Kilo 余额查询失败' : null, pass.status === 'rejected' ? 'Kilo Pass 查询失败' : null].filter(Boolean);
      snapshot = {
        balanceUsd: balance.status === 'fulfilled' ? balance.value : previous.balanceUsd,
        pass: pass.status === 'fulfilled' ? pass.value : previous.pass,
        checkedAt: options.now(),
        stale: errors.length > 0,
        error: errors.length ? errors.join('；') : null,
      };
    } catch {
      snapshot = { ...previous, checkedAt: options.now(), stale: true, error: 'Kilo 账户查询失败，请检查连接密钥或稍后刷新。' };
    }
    if (!controller.signal.aborted && options.connections().some((current) => current.id === connection.id && current.enabled && current.updatedAt === connection.updatedAt && isKiloConnection(current))) {
      cache.set(connection.id, { revision: connection.updatedAt, snapshot });
    }
  }

  return {
    read,
    /** 菜单栏主动刷新和后台周期刷新共用节流，不依赖 Codex 登录。 */
    async refreshDue(maxAgeMs = 10 * 60_000): Promise<void> {
      const connections = options.connections().filter((connection) => connection.enabled && isKiloConnection(connection));
      for (const id of cache.keys()) if (!connections.some((connection) => connection.id === id)) cache.delete(id);
      await Promise.all(
        connections.map(async (connection) => {
          const pending = active.get(connection.id);
          if (pending) return pending;
          const snapshot = read(connection)!;
          if (controller.signal.aborted || (snapshot.checkedAt && Date.parse(options.now()) - Date.parse(snapshot.checkedAt) < maxAgeMs)) return;
          const job = refresh(connection).finally(() => active.delete(connection.id));
          active.set(connection.id, job);
          await job;
        }),
      );
    },
    /** 等待已发出的查询退出，关闭后不再更新缓存。 */
    async dispose(): Promise<void> {
      controller.abort();
      await Promise.allSettled(active.values());
    },
  };
}
