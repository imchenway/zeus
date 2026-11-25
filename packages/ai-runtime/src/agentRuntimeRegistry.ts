import type { CodexOfficialUsageSnapshot, UsageProviderKind } from '@zeus/shared';
import type { AgentDescriptor, AgentKind } from './agentRuntimeContracts.js';

/** 运行时可向菜单栏和用量详情提供的本地供应商状态。 */
export interface AgentRuntimeUsageProvider {
  /** 用量界面显示的供应商名称。 */
  name: string;
  /** 供应商的订阅或 API 计费类型。 */
  kind: UsageProviderKind;
  /** 账号已就绪时，可在首次产生用量前显示供应商。 */
  active: boolean;
  /** 未登录也需要保留用量详情入口时启用。 */
  showInAnalytics?: boolean;
  /** 运行时支持缓存 Token 时，可在首次命中前显示该指标。 */
  cacheUsageAvailable?: boolean;
  /** 供应商提供官方额度时，使用最近一次已读取的账户快照。 */
  official?: CodexOfficialUsageSnapshot;
}

/** 原生运行时的身份与被动查询入口。 */
export interface AgentRuntimeRegistration {
  /** 原生账号运行时用此类型作为账本供应商 ID。 */
  kind: AgentKind;
  /** 只读取已有状态，不启动或探测运行时。 */
  readDescriptor(): AgentDescriptor;
  /** 由独立账号提供本地用量时，读取该账号的当前状态。 */
  readUsageProvider?(): AgentRuntimeUsageProvider;
}

export interface AgentRuntimeRegistry {
  listAll(): AgentDescriptor[];

  listPublic(): AgentDescriptor[];

  get(kind: AgentKind): AgentDescriptor | undefined;

  requireVerified(kind: AgentKind): AgentDescriptor;

  /** 按账本供应商 ID 返回原生运行时的用量资料。 */
  readUsageProviders(): ReadonlyMap<string, AgentRuntimeUsageProvider>;
}

/** 每种运行时登记一次，能力目录和用量读取共用身份。 */
export function createAgentRuntimeRegistry(registrations: readonly AgentRuntimeRegistration[]): AgentRuntimeRegistry {
  /** 运行类型在注册时确定，账号状态在读取时获取。 */
  const byKind = new Map<AgentKind, AgentRuntimeRegistration>();
  for (const registration of registrations) {
    if (byKind.has(registration.kind)) throw new Error(`Agent descriptor already registered: ${registration.kind}`);
    byKind.set(registration.kind, registration);
  }

  /** 能力快照返回副本，调用方可独立使用。 */
  const readAll = () => [...byKind.values()].map((registration) => cloneAgentDescriptor(registration.readDescriptor()));
  /** 仅按需读取目标运行时的能力。 */
  const get = (kind: AgentKind) => {
    const registration = byKind.get(kind);
    return registration ? cloneAgentDescriptor(registration.readDescriptor()) : undefined;
  };
  return {
    listAll: readAll,
    listPublic: () => readAll().filter((descriptor) => descriptor.visibleToUsers && descriptor.supportStatus === 'verified' && descriptor.capabilities.session?.state === 'supported'),
    get,
    /** 需要已验证能力的调用方必须经过同一注册表检查。 */
    requireVerified: (kind) => {
      const descriptor = get(kind);
      if (!descriptor || descriptor.supportStatus !== 'verified') throw createAgentNotAvailableError(kind);
      return descriptor;
    },
    /** 只读取用量资料，能力目录的探测信息不参与本地统计。 */
    readUsageProviders() {
      const providers = new Map<string, AgentRuntimeUsageProvider>();
      for (const registration of byKind.values()) {
        if (registration.readUsageProvider) providers.set(registration.kind, registration.readUsageProvider());
      }
      return providers;
    },
  };
}

export function createAgentNotAvailableError(kind: AgentKind): Error & { code: 'ZEUS_AGENT_NOT_AVAILABLE' } {
  return Object.assign(new Error(`Agent is not available: ${kind}`), { code: 'ZEUS_AGENT_NOT_AVAILABLE' as const });
}

function cloneAgentDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    preflightTokenCount: { ...descriptor.preflightTokenCount },
    capabilities: Object.fromEntries(Object.entries(descriptor.capabilities).map(([id, evidence]) => [id, evidence ? { ...evidence } : evidence])),
  };
}
