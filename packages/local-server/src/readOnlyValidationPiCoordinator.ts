import type { AgentRuntimeHealthSnapshot } from '@zeus/ai-runtime';
import type { createPiNativeConversationCoordinator } from './piNativeConversationCoordinator.js';

type PiCoordinator = ReturnType<typeof createPiNativeConversationCoordinator>;

/** 验证组合不构造 Pi Worker driver；查询只返回 stopped，任何动作统一拒绝。 */
export function createReadOnlyValidationPiCoordinator(now: () => string): PiCoordinator {
  const blocked = (): Promise<never> =>
    Promise.reject(
      Object.assign(new Error('只读验证模式未构造 Pi Worker。'), {
        code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
        statusCode: 503,
      }),
    );
  const health = (): AgentRuntimeHealthSnapshot => ({
    agentKind: 'pi',
    transport: 'rpc',
    generationId: null,
    lifecycle: 'stopped',
    protocolVersion: null,
    processId: null,
    checkedAt: now(),
    consecutiveFailures: 0,
    circuit: { state: 'closed', openedAt: null, reason: null, recovery: 'explicit' },
    lastFailure: null,
  });
  const passive = {
    repairPersistedConversationIdentities: () => 0,
    repairPersistedAgentMessageProjections: () => 0,
    runtimeHealth: health,
    close: async () => undefined,
  };
  return new Proxy(passive as unknown as PiCoordinator, {
    get(target, property, receiver) {
      if (Reflect.has(target as object, property)) return Reflect.get(target as object, property, receiver) as unknown;
      return blocked;
    },
  });
}
