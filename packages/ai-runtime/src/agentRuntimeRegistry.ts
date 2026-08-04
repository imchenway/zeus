import type { AgentDescriptor, AgentKind } from './agentRuntimeContracts.js';

export interface AgentRuntimeRegistry {
  listAll(): AgentDescriptor[];

  listPublic(): AgentDescriptor[];

  get(kind: AgentKind): AgentDescriptor | undefined;

  requireVerified(kind: AgentKind): AgentDescriptor;
}

export function createAgentRuntimeRegistry(descriptors: readonly AgentDescriptor[]): AgentRuntimeRegistry {
  const byKind = new Map<AgentKind, AgentDescriptor>();
  for (const descriptor of descriptors) {
    if (byKind.has(descriptor.kind)) throw new Error(`Agent descriptor already registered: ${descriptor.kind}`);
    byKind.set(descriptor.kind, cloneAgentDescriptor(descriptor));
  }

  const readAll = () => [...byKind.values()].map(cloneAgentDescriptor);
  return {
    listAll: readAll,
    listPublic: () => readAll().filter((descriptor) => descriptor.visibleToUsers && descriptor.supportStatus === 'verified' && descriptor.capabilities.session?.state === 'supported'),
    get: (kind) => {
      const descriptor = byKind.get(kind);
      return descriptor ? cloneAgentDescriptor(descriptor) : undefined;
    },
    requireVerified: (kind) => {
      const descriptor = byKind.get(kind);
      if (!descriptor || descriptor.supportStatus !== 'verified') throw createAgentNotAvailableError(kind);
      return cloneAgentDescriptor(descriptor);
    },
  };
}

export function createAgentNotAvailableError(kind: AgentKind): Error & { code: 'ZEUS_AGENT_NOT_AVAILABLE' } {
  return Object.assign(new Error(`Agent is not available: ${kind}`), { code: 'ZEUS_AGENT_NOT_AVAILABLE' as const });
}

function cloneAgentDescriptor(descriptor: AgentDescriptor): AgentDescriptor {
  return {
    ...descriptor,
    capabilities: Object.fromEntries(Object.entries(descriptor.capabilities).map(([id, evidence]) => [id, evidence ? { ...evidence } : evidence])),
  };
}
