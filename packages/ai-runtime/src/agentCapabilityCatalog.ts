import type { AgentCapabilityEvidence, AgentCapabilityId, AgentDescriptor } from './agentRuntimeContracts.js';
import { type AgentRuntimeRegistry, createAgentRuntimeRegistry } from './agentRuntimeRegistry.js';

export interface CodexAgentCatalogEvidence {
  enabled: boolean;
  available: boolean;
  checkedAt: string;
  adapterVersion: string | null;
  binaryVersion?: string | null;
  reason: string;
}

const CODEX_CAPABILITIES: readonly AgentCapabilityId[] = ['session', 'streaming', 'steer', 'interrupt', 'approval', 'user_input', 'model_catalog', 'service_tier', 'usage'];

const PI_DECLARED_CAPABILITIES: readonly AgentCapabilityId[] = ['session', 'streaming', 'steer', 'follow_up', 'interrupt', 'user_input', 'usage', 'compaction'];

export function createAgentCapabilityCatalog(codex: CodexAgentCatalogEvidence): AgentRuntimeRegistry {
  return createAgentRuntimeRegistry([createCodexAgentDescriptor(codex), createPiFrameworkDescriptor()]);
}

export function createCodexAgentDescriptor(input: CodexAgentCatalogEvidence): AgentDescriptor {
  const verified = input.enabled && input.available;
  const state = verified ? 'supported' : 'unverified';
  const reason = input.enabled ? input.reason : 'Zeus 当前已关闭 Codex 原生会话。';
  return {
    kind: 'codex',
    displayName: 'Codex Agent',
    transport: 'app_server',
    supportStatus: verified ? 'verified' : 'unavailable',
    visibleToUsers: true,
    preflightTokenCount: {
      state: 'unavailable',
      exact: false,
      source: null,
      checkedAt: input.checkedAt,
      reason: '当前 Codex app-server 没有请求前 token-count RPC；只能使用请求后的真实 usage 通知。',
    },
    capabilities: capabilityRecord(CODEX_CAPABILITIES, {
      state,
      checkedAt: input.checkedAt,
      adapterVersion: input.adapterVersion,
      binaryVersion: input.binaryVersion ?? input.adapterVersion,
      reason,
    }),
  };
}

export function createPiFrameworkDescriptor(): AgentDescriptor {
  return {
    kind: 'pi',
    displayName: 'Pi Agent',
    transport: 'rpc',
    supportStatus: 'framework_only',
    visibleToUsers: false,
    preflightTokenCount: {
      state: 'unavailable',
      exact: false,
      source: null,
      checkedAt: null,
      reason: '当前 Pi SDK 没有请求前精确 token-count 端口；不得把字符估算标记为精确计数。',
    },
    capabilities: capabilityRecord(PI_DECLARED_CAPABILITIES, {
      state: 'unverified',
      checkedAt: null,
      adapterVersion: null,
      binaryVersion: null,
      reason: '当前只登记公共协议框架，尚未安装、启动或验收 Pi。',
    }),
  };
}

function capabilityRecord(ids: readonly AgentCapabilityId[], evidence: AgentCapabilityEvidence): Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>> {
  return Object.fromEntries(ids.map((id) => [id, { ...evidence }])) as Partial<Record<AgentCapabilityId, AgentCapabilityEvidence>>;
}
