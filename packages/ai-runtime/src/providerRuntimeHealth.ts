import type { AgentRuntimeHealthSnapshot } from './agentRuntimeContracts.js';
import type { CodexAppServerManager, CodexTransportState } from './codexAppServerManager.js';

export interface ProviderRuntimeHealthReader {
  getRuntimeHealth(): AgentRuntimeHealthSnapshot;
}

/** 为现有 Codex app-server 管理器建立统一被动健康端口；构造和读取都不会启动 Provider。 */
export function createCodexProviderRuntimeHealthReader(manager: Pick<CodexAppServerManager, 'getState'>, now: () => string = () => new Date().toISOString()): ProviderRuntimeHealthReader {
  return { getRuntimeHealth: () => readCodexProviderRuntimeHealth(manager, now) };
}

/** 把既有 Codex app-server 世代投影到公共 Provider health/circuit 语义，不触发登录或能力探测。 */
export function readCodexProviderRuntimeHealth(manager: Pick<CodexAppServerManager, 'getState'>, now: () => string = () => new Date().toISOString()): AgentRuntimeHealthSnapshot {
  const state = manager.getState();
  const checkedAt = now();
  return {
    agentKind: 'codex',
    transport: 'app_server',
    generationId: generationFromCodexState(state),
    lifecycle: state.type === 'ready' ? 'healthy' : state.type === 'starting' ? 'starting' : state.type === 'restarting' ? 'circuit_open' : 'stopped',
    protocolVersion: state.type === 'ready' ? state.capabilities.protocolVersion : state.type === 'idle' || state.type === 'closed' ? null : 'codex-app-server-v2',
    processId: null,
    checkedAt,
    consecutiveFailures: state.type === 'restarting' ? state.attempt : 0,
    circuit: {
      state: state.type === 'restarting' ? 'open' : state.type === 'starting' ? 'half_open' : 'closed',
      openedAt: null,
      reason: state.type === 'restarting' ? 'process_exit' : null,
      recovery: 'automatic_supervised',
    },
    lastFailure:
      state.type === 'restarting'
        ? {
            kind: 'process_exit',
            code: 'ZEUS_CODEX_GENERATION_EXITED',
            message: 'Codex app-server 世代已退出；监督器只启动新世代，不自动重发未确认命令。',
            occurredAt: checkedAt,
            resultUnknown: true,
          }
        : null,
  };
}

function generationFromCodexState(state: CodexTransportState): string | null {
  return state.type === 'idle' || state.type === 'closed' ? null : state.generationId;
}
