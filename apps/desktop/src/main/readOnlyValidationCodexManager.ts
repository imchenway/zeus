import type { CodexAppServerManager } from '@zeus/ai-runtime';

/**
 * 验证 Core 需要让查询组合完成依赖注入，但绝不能构造会 spawn Provider 的真实 manager。
 * 所有外部能力统一失败关闭；被动健康查询只返回 idle/空世代。
 */
export function createReadOnlyValidationCodexManager(): CodexAppServerManager {
  const unavailable = (): Promise<never> =>
    Promise.reject(
      Object.assign(new Error('只读验证模式未构造 Codex Provider manager。'), {
        code: 'ZEUS_READ_ONLY_VALIDATION_CAPABILITY_BLOCKED',
        statusCode: 503,
      }),
    );
  const passive = {
    getState: () => ({ type: 'idle' as const }),
    hasGeneration: () => false,
    generationForThread: () => null,
    listRuntimeGenerations: () => [],
    subscribe: () => () => undefined,
    subscribeExternalAgentImport: () => () => undefined,
    subscribeRpcRetries: () => () => undefined,
    prepareForShutdown: async () => undefined,
    close: async () => undefined,
  };
  return new Proxy(passive as unknown as CodexAppServerManager, {
    get(target, property, receiver) {
      if (Reflect.has(target as object, property)) return Reflect.get(target as object, property, receiver) as unknown;
      return unavailable;
    },
  });
}
