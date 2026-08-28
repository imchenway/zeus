import {
  type CodexAppServerEvent,
  type CodexAppServerManager,
  type CodexCapabilitiesSnapshot,
  type CodexResponsesModelProvider,
  type CodexResponsesRuntime,
  type CodexServerRequestResponse,
  type CodexTransportState,
  createCodexAppServerManager,
  type ExternalAgentImportEvent,
} from './codexAppServerManager.js';
import { spawn as nodeSpawn } from 'node:child_process';

interface RuntimeEntry {
  manager: CodexAppServerManager;
  commandPath: string;
  externalAgentHome: string | null;
  remoteControl: boolean;
  providerEnvironment: Record<string, string>;
  responsesProvider: CodexResponsesModelProvider | null;
  capabilities: CodexCapabilitiesSnapshot;
  threads: Set<string>;
  activeTurns: Map<string, string>;
  completedTurns: Set<string>;
  activeGoals: Set<string>;
  pendingRequests: Map<string, { generationId: string; threadId: string | null }>;
  unsubscribe: () => void;
  unsubscribeExternalImport: () => void;
  activationSequence: number;
  inFlightWrites: number;
  closing: boolean;
  closePromise: Promise<void> | null;
}

interface RuntimeLease {
  entry: RuntimeEntry;
  release(): void;
}

type RuntimeActivationInput = {
  commandPath: string;
  externalAgentHome?: string;
  remoteControl?: boolean;
  providerEnvironment?: Record<string, string>;
  responsesProvider?: CodexResponsesModelProvider | null;
};

function sameResponsesProvider(left: CodexResponsesModelProvider | null, right: CodexResponsesModelProvider | null): boolean {
  if (left === null || right === null) return left === right;
  return left.id === right.id && left.name === right.name && left.baseUrl === right.baseUrl && left.envKey === right.envKey && left.modelContextWindow === right.modelContextWindow;
}

/** app-server 重启后仍需在进程级配置中声明外部 Responses Provider，原生 thread 才能继续运行。 */
function responsesProviderFlags(provider: CodexResponsesModelProvider | null): string[] {
  if (!provider) return [];
  if (!/^[a-z0-9_-]{1,100}$/iu.test(provider.id) || !/^ZEUS_MODEL_CONNECTION_[A-Z0-9_]+_API_KEY$/u.test(provider.envKey)) {
    throw managerError('ZEUS_CODEX_PROVIDER_INVALID', 'Responses 自定义 Provider 身份无效。');
  }
  const prefix = `model_providers.${provider.id}`;
  return [
    '-c',
    `${prefix}.name=${JSON.stringify(provider.name)}`,
    '-c',
    `${prefix}.base_url=${JSON.stringify(provider.baseUrl)}`,
    '-c',
    `${prefix}.env_key=${JSON.stringify(provider.envKey)}`,
    '-c',
    `${prefix}.wire_api="responses"`,
    '-c',
    `${prefix}.requires_openai_auth=false`,
  ];
}

const supportedServerRequestMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/tool/call',
]);

/**
 * 让一个执行宿主同时持有多个 Codex app-server。
 * 新线程进入配置匹配的当前运行时；已经绑定的线程继续由持有 writer 的原运行时处理，直至该进程完全退出并释放锁。
 */
export function createCodexRuntimeGenerationManager(
  options: {
    accountFingerprintSalt?: string;
    codexHome?: string;
    runtimeEnvironment?: Record<string, string>;
    providerVersionProbe?: (commandPath: string) => Promise<string | null>;
  } = {},
): CodexAppServerManager {
  const entries = new Set<RuntimeEntry>();
  const entriesByGeneration = new Map<string, RuntimeEntry>();
  const entriesByThread = new Map<string, RuntimeEntry>();
  const responsesProvidersByThread = new Map<string, CodexResponsesModelProvider>();
  const responsesProviderEnvironmentsByThread = new Map<string, Record<string, string>>();
  const threadHandoffChains = new Map<string, Promise<void>>();
  const listeners = new Set<(event: CodexAppServerEvent) => void | Promise<void>>();
  const externalImportListeners = new Set<(event: ExternalAgentImportEvent) => void>();
  let activeEntry: RuntimeEntry | null = null;
  let preparingForShutdown = false;
  let closePromise: Promise<void> | null = null;
  let activationChain: Promise<unknown> = Promise.resolve();
  let activationSequence = 0;
  let remoteControlEnabled = false;

  function requireActiveEntry(): RuntimeEntry {
    if (!activeEntry || preparingForShutdown) throw managerError('ZEUS_CODEX_NOT_READY', 'Codex runtime generation manager is not ready.');
    return activeEntry;
  }

  function rememberGeneration(entry: RuntimeEntry, generationId: string): void {
    for (const [knownGenerationId, knownEntry] of entriesByGeneration) {
      if (knownEntry === entry && knownGenerationId !== generationId) entriesByGeneration.delete(knownGenerationId);
    }
    entriesByGeneration.set(generationId, entry);
    if (entry.capabilities.generationId !== generationId) {
      const state = entry.manager.getState();
      if (state.type === 'ready' && state.generationId === generationId) entry.capabilities = state.capabilities;
    }
  }

  function entryGeneration(entry: RuntimeEntry): string | null {
    const state = entry.manager.getState();
    if (state.type === 'idle' || state.type === 'closed') return null;
    rememberGeneration(entry, state.generationId);
    return state.generationId;
  }

  function routeThread(threadId: string): RuntimeEntry {
    const mapped = entriesByThread.get(threadId);
    if (mapped && mapped.manager.getState().type !== 'closed') return mapped;
    if (mapped) entriesByThread.delete(threadId);
    return requireActiveEntry();
  }

  function bindThread(entry: RuntimeEntry, threadId: string): void {
    const previous = entriesByThread.get(threadId);
    previous?.threads.delete(threadId);
    entriesByThread.set(threadId, entry);
    entry.threads.add(threadId);
  }

  function sameRuntimeIdentity(
    entry: RuntimeEntry,
    input: {
      commandPath: string;
      externalAgentHome: string | null;
      remoteControl: boolean;
      providerEnvironment: Record<string, string>;
      responsesProvider: CodexResponsesModelProvider | null;
    },
  ): boolean {
    return (
      entry.commandPath === input.commandPath &&
      entry.externalAgentHome === input.externalAgentHome &&
      entry.remoteControl === input.remoteControl &&
      sameStringRecord(entry.providerEnvironment, input.providerEnvironment) &&
      sameResponsesProvider(entry.responsesProvider, input.responsesProvider)
    );
  }

  function entryMatchesRuntime(
    entry: RuntimeEntry,
    input: {
      commandPath: string;
      externalAgentHome: string | null;
      remoteControl: boolean;
      providerEnvironment: Record<string, string>;
      responsesProvider: CodexResponsesModelProvider | null;
    },
  ): boolean {
    return !entry.closing && entry.manager.getState().type !== 'closed' && sameRuntimeIdentity(entry, input);
  }

  function retainEntry(entry: RuntimeEntry): RuntimeLease {
    if (entry.closing || entry.manager.getState().type === 'closed') {
      throw managerError('ZEUS_CODEX_GENERATION_EXITED', 'Codex runtime generation closed before the writer operation could start.');
    }
    entry.inFlightWrites += 1;
    let released = false;
    return {
      entry,
      release() {
        if (released) return;
        released = true;
        entry.inFlightWrites -= 1;
        void tryDrain(entry);
      },
    };
  }

  function promoteEntry(entry: RuntimeEntry, requestedRemoteControl: boolean): void {
    const previous = activeEntry;
    activeEntry = entry;
    entry.activationSequence = ++activationSequence;
    if (requestedRemoteControl) remoteControlEnabled = true;
    if (previous && previous !== entry) void tryDrain(previous);
  }

  function serializeThreadHandoff<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = threadHandoffChains.get(threadId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tracked = result
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (threadHandoffChains.get(threadId) === tracked) threadHandoffChains.delete(threadId);
      });
    threadHandoffChains.set(threadId, tracked);
    return result;
  }

  function recordedResponsesRuntime(threadId: string, explicit?: CodexResponsesRuntime): CodexResponsesRuntime | undefined {
    if (explicit) return explicit;
    const provider = responsesProvidersByThread.get(threadId);
    if (!provider) return undefined;
    return {
      provider,
      environment: responsesProviderEnvironmentsByThread.get(threadId) ?? {},
    };
  }

  function assertOwnerRuntime(entry: RuntimeEntry, threadId: string, responsesRuntime: CodexResponsesRuntime | undefined): void {
    if (!responsesRuntime) {
      if (entry.responsesProvider === null) return;
    } else if (!entry.remoteControl && sameResponsesProvider(entry.responsesProvider, responsesRuntime.provider) && sameStringRecord(entry.providerEnvironment, responsesRuntime.environment)) {
      return;
    }
    throw managerError('ZEUS_CODEX_THREAD_RUNTIME_IDENTITY_MISMATCH', `Codex thread ${threadId} is owned by a runtime with a different provider identity.`);
  }

  function acquireRuntimeForThread(responsesRuntime: CodexResponsesRuntime | undefined): Promise<RuntimeLease> {
    const acquisition = activationChain.then(async () => {
      const current = requireActiveEntry();
      const requestedResponsesProvider = responsesRuntime?.provider ?? null;
      const requestedProviderEnvironment = responsesRuntime?.environment ?? {};
      await activate({
        commandPath: current.commandPath,
        ...(current.externalAgentHome ? { externalAgentHome: current.externalAgentHome } : {}),
        remoteControl: requestedResponsesProvider ? false : remoteControlEnabled,
        providerEnvironment: requestedProviderEnvironment,
        responsesProvider: requestedResponsesProvider,
      });
      return retainEntry(requireActiveEntry());
    });
    activationChain = acquisition.then(
      () => undefined,
      () => undefined,
    );
    return acquisition;
  }

  async function acquireThreadLease(threadId: string, explicitResponsesRuntime?: CodexResponsesRuntime): Promise<{ lease: RuntimeLease; responsesRuntime: CodexResponsesRuntime | undefined; needsResume: boolean }> {
    let mapped = entriesByThread.get(threadId);
    if (mapped?.closing) await mapped.closePromise;
    mapped = entriesByThread.get(threadId);
    const responsesRuntime = recordedResponsesRuntime(threadId, explicitResponsesRuntime);
    if (mapped && !mapped.closing && mapped.manager.getState().type !== 'closed') {
      assertOwnerRuntime(mapped, threadId, responsesRuntime);
      return { lease: retainEntry(mapped), responsesRuntime, needsResume: false };
    }
    if (mapped) entriesByThread.delete(threadId);
    return { lease: await acquireRuntimeForThread(responsesRuntime), responsesRuntime, needsResume: true };
  }

  function withThreadOwner<T>(
    threadId: string,
    cwd: string | undefined,
    explicitResponsesRuntime: CodexResponsesRuntime | undefined,
    operation: (entry: RuntimeEntry, responsesRuntime: CodexResponsesRuntime | undefined) => Promise<T>,
  ): Promise<T> {
    return serializeThreadHandoff(threadId, async () => {
      const acquired = await acquireThreadLease(threadId, explicitResponsesRuntime);
      const { entry } = acquired.lease;
      try {
        if (acquired.needsResume) {
          await entry.manager.resumeThread({
            threadId,
            ...(cwd ? { cwd } : {}),
            ...(acquired.responsesRuntime ? { responsesRuntime: acquired.responsesRuntime } : {}),
          });
          bindThread(entry, threadId);
          await syncThreadGoalPin(entry, threadId);
        }
        return await operation(entry, acquired.responsesRuntime);
      } finally {
        acquired.lease.release();
      }
    });
  }

  async function syncThreadGoalPin(entry: RuntimeEntry, threadId: string): Promise<void> {
    if (!entry.capabilities.goals.supported || !entry.capabilities.goals.enabled) return;
    const goal = await entry.manager.readThreadGoal({ threadId }).catch(() => null);
    if (goal?.status === 'active') entry.activeGoals.add(threadId);
    else entry.activeGoals.delete(threadId);
  }

  function forwardEvent(entry: RuntimeEntry, event: CodexAppServerEvent): void | Promise<void> {
    rememberGeneration(entry, event.generationId);
    const params = isRecord(event.params) ? event.params : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    if (threadId) bindThread(entry, threadId);
    if (event.method === 'turn/started' && threadId) {
      const turn = isRecord(params.turn) ? params.turn : {};
      const turnId = typeof turn.id === 'string' ? turn.id : typeof params.turnId === 'string' ? params.turnId : null;
      if (turnId && !entry.completedTurns.has(turnKey(threadId, turnId))) entry.activeTurns.set(threadId, turnId);
    }
    if (event.requestId !== undefined && supportedServerRequestMethods.has(event.method)) {
      entry.pendingRequests.set(requestKey(event.generationId, event.requestId), {
        generationId: event.generationId,
        threadId,
      });
    }
    if (event.method === 'serverRequest/resolved') {
      const resolvedRequestId = typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : null;
      if (resolvedRequestId !== null) entry.pendingRequests.delete(requestKey(event.generationId, resolvedRequestId));
      void tryDrain(entry);
    }
    if (event.method === 'turn/completed' && threadId) {
      const turn = isRecord(params.turn) ? params.turn : {};
      const turnId = typeof turn.id === 'string' ? turn.id : typeof params.turnId === 'string' ? params.turnId : entry.activeTurns.get(threadId);
      if (turnId) {
        const identity = turnKey(threadId, turnId);
        entry.completedTurns.add(identity);
        const cleanup = setTimeout(() => entry.completedTurns.delete(identity), 60_000);
        cleanup.unref();
      }
      entry.activeTurns.delete(threadId);
      for (const [key, request] of entry.pendingRequests) {
        if (request.threadId === threadId) entry.pendingRequests.delete(key);
      }
      void tryDrain(entry);
    }
    if (event.method === 'thread/goal/updated' && threadId) {
      const goal = isRecord(params.goal) ? params.goal : {};
      if (goal.status === 'active') entry.activeGoals.add(threadId);
      else {
        entry.activeGoals.delete(threadId);
        void tryDrain(entry);
      }
    }
    if (event.method === 'thread/goal/cleared' && threadId) {
      entry.activeGoals.delete(threadId);
      void tryDrain(entry);
    }
    const pendingDeliveries: Promise<void>[] = [];
    for (const listener of listeners) {
      try {
        const delivery = listener(event);
        if (delivery && typeof delivery.then === 'function') pendingDeliveries.push(delivery);
      } catch {
        // 单个消费者异常不能中断其他世代的事件转发。
      }
    }
    if (pendingDeliveries.length > 0) return Promise.allSettled(pendingDeliveries).then(() => undefined);
  }

  function forwardExternalImport(event: ExternalAgentImportEvent): void {
    for (const listener of externalImportListeners) {
      try {
        listener(event);
      } catch {
        // 导入事件消费者之间保持隔离。
      }
    }
  }

  async function activate(input: RuntimeActivationInput, forceFreshGeneration = false): Promise<CodexCapabilitiesSnapshot> {
    if (preparingForShutdown) throw managerError('ZEUS_CODEX_CLOSED', 'Codex runtime generation manager is closing.');
    const requestedHome = input.externalAgentHome ?? null;
    const requestedResponsesProvider = input.responsesProvider ?? null;
    // 外部 Responses 依赖连接专属进程环境，不能交给已经运行且环境不可更新的 Remote Control 守护进程。
    const requestedRemoteControl = requestedResponsesProvider ? false : (input.remoteControl ?? remoteControlEnabled);
    const requestedProviderEnvironment = input.providerEnvironment ?? (requestedResponsesProvider ? (activeEntry?.providerEnvironment ?? {}) : {});
    const normalizedInput = { ...input, remoteControl: requestedRemoteControl, providerEnvironment: requestedProviderEnvironment };
    const runtimeIdentity = {
      commandPath: input.commandPath,
      externalAgentHome: requestedHome,
      remoteControl: requestedRemoteControl,
      providerEnvironment: requestedProviderEnvironment,
      responsesProvider: requestedResponsesProvider,
    };
    let reusable = forceFreshGeneration
      ? null
      : activeEntry && entryMatchesRuntime(activeEntry, runtimeIdentity)
        ? activeEntry
        : [...entries].filter((entry) => entryMatchesRuntime(entry, runtimeIdentity)).sort((left, right) => right.activationSequence - left.activationSequence)[0];
    if (!forceFreshGeneration && !reusable) {
      const closingMatch = [...entries].filter((entry) => entry.closing && sameRuntimeIdentity(entry, runtimeIdentity)).sort((left, right) => right.activationSequence - left.activationSequence)[0];
      if (closingMatch?.closePromise) await closingMatch.closePromise;
      reusable =
        activeEntry && entryMatchesRuntime(activeEntry, runtimeIdentity)
          ? activeEntry
          : [...entries].filter((entry) => entryMatchesRuntime(entry, runtimeIdentity)).sort((left, right) => right.activationSequence - left.activationSequence)[0];
    }
    if (reusable) {
      const capabilities = await reusable.manager.ensureReady(normalizedInput);
      reusable.capabilities = capabilities;
      rememberGeneration(reusable, capabilities.generationId);
      promoteEntry(reusable, requestedRemoteControl);
      return capabilities;
    }

    const providerVersionFallback = await (options.providerVersionProbe ?? probeCodexProviderVersion)(input.commandPath);
    const manager = createCodexAppServerManager({
      ...(options.accountFingerprintSalt ? { accountFingerprintSalt: options.accountFingerprintSalt } : {}),
      ...(options.codexHome ? { codexHome: options.codexHome } : {}),
      ...(options.runtimeEnvironment ? { runtimeEnvironment: options.runtimeEnvironment } : {}),
      ...(requestedResponsesProvider ? { appServerFlags: responsesProviderFlags(requestedResponsesProvider) } : {}),
      providerVersionFallback,
    });
    const provisional: RuntimeEntry = {
      manager,
      commandPath: input.commandPath,
      externalAgentHome: requestedHome,
      remoteControl: requestedRemoteControl,
      providerEnvironment: { ...requestedProviderEnvironment },
      responsesProvider: requestedResponsesProvider,
      capabilities: {
        generationId: '',
        initializedAt: '',
        providerVersion: null,
        protocolVersion: 'codex-app-server-v2',
        models: [],
        supportedModels: [],
        preflightTokenCount: {
          state: 'unavailable',
          exact: false,
          reason: '尚未建立 Codex app-server generation；没有请求前 token-count RPC 能力证据。',
        },
        goals: { supported: false, enabled: false, stage: null },
      },
      threads: new Set<string>(),
      activeTurns: new Map<string, string>(),
      completedTurns: new Set<string>(),
      activeGoals: new Set<string>(),
      pendingRequests: new Map<string, { generationId: string; threadId: string | null }>(),
      unsubscribe: () => undefined,
      unsubscribeExternalImport: () => undefined,
      activationSequence: 0,
      inFlightWrites: 0,
      closing: false,
      closePromise: null,
    };
    provisional.unsubscribe = manager.subscribe((event) => forwardEvent(provisional, event));
    provisional.unsubscribeExternalImport = manager.subscribeExternalAgentImport(forwardExternalImport);
    entries.add(provisional);
    try {
      const capabilities = await manager.ensureReady(normalizedInput);
      provisional.capabilities = capabilities;
      rememberGeneration(provisional, capabilities.generationId);
      if (requestedRemoteControl) await manager.enableRemoteControl();
      promoteEntry(provisional, requestedRemoteControl);
      return capabilities;
    } catch (error) {
      provisional.unsubscribe();
      provisional.unsubscribeExternalImport();
      entries.delete(provisional);
      await manager.close().catch(() => undefined);
      throw error;
    }
  }

  async function tryDrain(entry: RuntimeEntry): Promise<void> {
    if (entry === activeEntry || entry.inFlightWrites > 0 || entry.activeTurns.size > 0 || entry.activeGoals.size > 0 || entry.pendingRequests.size > 0) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closing = true;
    entry.closePromise = (async () => {
      entry.unsubscribe();
      entry.unsubscribeExternalImport();
      await entry.manager.prepareForShutdown().catch(() => undefined);
      // close 只有在子进程确认退出后才完成；失败时保留 owner 映射，禁止假定 writer 锁已经释放。
      await entry.manager.close();
      for (const threadId of entry.threads) {
        if (entriesByThread.get(threadId) === entry) entriesByThread.delete(threadId);
      }
      entry.threads.clear();
      entries.delete(entry);
      for (const [generationId, knownEntry] of entriesByGeneration) {
        if (knownEntry === entry) entriesByGeneration.delete(generationId);
      }
    })();
    return entry.closePromise;
  }

  function enqueueActivation(input: RuntimeActivationInput, forceFreshGeneration = false): Promise<CodexCapabilitiesSnapshot> {
    const activation = activationChain.then(() => activate(input, forceFreshGeneration));
    activationChain = activation.catch(() => undefined);
    return activation;
  }

  function entryForGeneration(generationId: string): RuntimeEntry | null {
    const entry = entriesByGeneration.get(generationId);
    if (!entry) return null;
    return entry.manager.hasGeneration(generationId) ? entry : null;
  }

  return {
    ensureReady(input) {
      return enqueueActivation(input);
    },
    activateFreshGeneration(input) {
      return enqueueActivation(input, true);
    },
    async readAccount(input = {}) {
      return requireActiveEntry().manager.readAccount(input);
    },
    async readAccountRateLimits() {
      return requireActiveEntry().manager.readAccountRateLimits();
    },
    async readAccountUsage() {
      return requireActiveEntry().manager.readAccountUsage();
    },
    async startChatGptLogin() {
      return requireActiveEntry().manager.startChatGptLogin();
    },
    async cancelChatGptLogin(input) {
      await requireActiveEntry().manager.cancelChatGptLogin(input);
    },
    async startThread(input) {
      const lease = await acquireRuntimeForThread(input.responsesRuntime);
      try {
        const thread = await lease.entry.manager.startThread(input);
        bindThread(lease.entry, thread.id);
        if (input.responsesRuntime) responsesProvidersByThread.set(thread.id, input.responsesRuntime.provider);
        if (input.responsesRuntime) responsesProviderEnvironmentsByThread.set(thread.id, { ...input.responsesRuntime.environment });
        return thread;
      } finally {
        lease.release();
      }
    },
    async resumeThread(input) {
      return serializeThreadHandoff(input.threadId, async () => {
        const acquired = await acquireThreadLease(input.threadId, input.responsesRuntime);
        const { entry } = acquired.lease;
        try {
          const thread = await entry.manager.resumeThread({ ...input, ...(acquired.responsesRuntime ? { responsesRuntime: acquired.responsesRuntime } : {}) });
          bindThread(entry, thread.id);
          if (acquired.responsesRuntime) responsesProvidersByThread.set(thread.id, acquired.responsesRuntime.provider);
          if (acquired.responsesRuntime) responsesProviderEnvironmentsByThread.set(thread.id, { ...acquired.responsesRuntime.environment });
          await syncThreadGoalPin(entry, thread.id);
          return thread;
        } finally {
          acquired.lease.release();
        }
      });
    },
    async archiveThread(input) {
      await withThreadOwner(input.threadId, undefined, undefined, async (entry) => {
        await entry.manager.archiveThread(input);
        if (entriesByThread.get(input.threadId) === entry) entriesByThread.delete(input.threadId);
        responsesProvidersByThread.delete(input.threadId);
        responsesProviderEnvironmentsByThread.delete(input.threadId);
        entry.threads.delete(input.threadId);
      });
    },
    async unarchiveThread(input) {
      const active = requireActiveEntry();
      const previous = entriesByThread.get(input.threadId);
      const thread = await active.manager.unarchiveThread(input);
      bindThread(active, thread.id);
      await syncThreadGoalPin(active, thread.id);
      if (previous && previous !== active) void tryDrain(previous);
      return thread;
    },
    async readThread(input) {
      return routeThread(input.threadId).manager.readThread(input);
    },
    async listThreads(input) {
      const routeId = input.ancestorThreadId ?? input.parentThreadId;
      const entry = routeId ? routeThread(routeId) : requireActiveEntry();
      const page = await entry.manager.listThreads(input);
      for (const thread of page.data) bindThread(entry, thread.id);
      return page;
    },
    async readThreadGoal(input) {
      return routeThread(input.threadId).manager.readThreadGoal(input);
    },
    async setThreadGoal(input) {
      return withThreadOwner(input.threadId, undefined, undefined, async (entry) => {
        const goal = await entry.manager.setThreadGoal(input);
        if (goal.status === 'active') entry.activeGoals.add(input.threadId);
        else entry.activeGoals.delete(input.threadId);
        return goal;
      });
    },
    async clearThreadGoal(input) {
      return withThreadOwner(input.threadId, undefined, undefined, async (entry) => {
        const result = await entry.manager.clearThreadGoal(input);
        if (result.cleared) entry.activeGoals.delete(input.threadId);
        return result;
      });
    },
    async listThreadTurns(input) {
      return routeThread(input.threadId).manager.listThreadTurns(input);
    },
    async listSkills(input) {
      return requireActiveEntry().manager.listSkills(input);
    },
    async startTurn(input) {
      return withThreadOwner(input.threadId, input.cwd, input.responsesRuntime, async (entry) => {
        if (input.responsesRuntime) {
          responsesProvidersByThread.set(input.threadId, input.responsesRuntime.provider);
          responsesProviderEnvironmentsByThread.set(input.threadId, { ...input.responsesRuntime.environment });
        }
        const turn = await entry.manager.startTurn(input);
        const identity = turnKey(input.threadId, turn.id);
        if (entry.completedTurns.has(identity)) entry.completedTurns.delete(identity);
        else entry.activeTurns.set(input.threadId, turn.id);
        return turn;
      });
    },
    async steerTurn(input) {
      return routeThread(input.threadId).manager.steerTurn(input);
    },
    async interruptTurn(input) {
      return routeThread(input.threadId).manager.interruptTurn(input);
    },
    async respondToServerRequest(input: CodexServerRequestResponse) {
      const entry = entryForGeneration(input.generationId);
      if (!entry) throw managerError('ZEUS_CODEX_STALE_GENERATION', 'Codex server request belongs to an unavailable runtime generation.');
      await entry.manager.respondToServerRequest(input);
      entry.pendingRequests.delete(requestKey(input.generationId, input.requestId));
      void tryDrain(entry);
    },
    async readRemoteControlStatus() {
      return requireActiveEntry().manager.readRemoteControlStatus();
    },
    async enableRemoteControl(input = {}) {
      const current = requireActiveEntry();
      // 活动线程继续固定在原宿主；新宿主只接收新线程和已空闲线程。
      await activate({
        commandPath: current.commandPath,
        ...(current.externalAgentHome ? { externalAgentHome: current.externalAgentHome } : {}),
        remoteControl: true,
      });
      return requireActiveEntry().manager.enableRemoteControl(input);
    },
    async disableRemoteControl(input = {}) {
      const active = requireActiveEntry();
      const status = await active.manager.disableRemoteControl(input);
      remoteControlEnabled = false;
      if ([...entries].every((entry) => entry.activeTurns.size === 0 && entry.pendingRequests.size === 0)) {
        await activate({
          commandPath: active.commandPath,
          ...(active.externalAgentHome ? { externalAgentHome: active.externalAgentHome } : {}),
          remoteControl: false,
        });
      }
      return status;
    },
    async startRemoteControlPairing(input = {}) {
      return requireActiveEntry().manager.startRemoteControlPairing(input);
    },
    async readRemoteControlPairingStatus(input) {
      return requireActiveEntry().manager.readRemoteControlPairingStatus(input);
    },
    async listRemoteControlClients(input) {
      return requireActiveEntry().manager.listRemoteControlClients(input);
    },
    async revokeRemoteControlClient(input) {
      await requireActiveEntry().manager.revokeRemoteControlClient(input);
    },
    async detectExternalAgentConfig(input) {
      return requireActiveEntry().manager.detectExternalAgentConfig(input);
    },
    async startExternalAgentImport(input) {
      return requireActiveEntry().manager.startExternalAgentImport(input);
    },
    async readExternalAgentImportHistories() {
      return requireActiveEntry().manager.readExternalAgentImportHistories();
    },
    subscribeExternalAgentImport(listener) {
      externalImportListeners.add(listener);
      return () => externalImportListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState(): CodexTransportState {
      return activeEntry?.manager.getState() ?? { type: 'idle' };
    },
    hasGeneration(generationId) {
      return entryForGeneration(generationId) !== null;
    },
    generationForThread(threadId) {
      const entry = entriesByThread.get(threadId) ?? activeEntry;
      return entry ? entryGeneration(entry) : null;
    },
    listRuntimeGenerations() {
      return [...entries]
        .map((entry) => {
          const state = entry.manager.getState();
          if (state.type === 'idle' || state.type === 'closed') return null;
          return {
            generationId: state.generationId,
            commandPath: entry.commandPath,
            state: state.type,
            active: entry === activeEntry,
            activeThreadCount: new Set([...entry.activeTurns.keys(), ...entry.activeGoals]).size,
            pendingRequestCount: entry.pendingRequests.size,
          };
        })
        .filter((snapshot): snapshot is NonNullable<typeof snapshot> => snapshot !== null);
    },
    async prepareForShutdown() {
      preparingForShutdown = true;
      await Promise.all([...entries].map((entry) => entry.manager.prepareForShutdown()));
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        preparingForShutdown = true;
        await Promise.all([...entries].map((entry) => entry.manager.close()));
        for (const entry of entries) {
          entry.unsubscribe();
          entry.unsubscribeExternalImport();
        }
        entries.clear();
        entriesByGeneration.clear();
        entriesByThread.clear();
        responsesProvidersByThread.clear();
        responsesProviderEnvironmentsByThread.clear();
        threadHandoffChains.clear();
        listeners.clear();
        externalImportListeners.clear();
        activeEntry = null;
      })();
      return closePromise;
    },
  };
}

/** initialize 已不稳定携带 serverInfo；只读执行同一二进制的 --version，不按路径或文件名猜版本。 */
function probeCodexProviderVersion(commandPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = nodeSpawn(commandPath, ['--version'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(null);
    }, 5_000);
    child.stdout?.on('data', (chunk) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.stderr?.on('data', (chunk) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      if (code !== 0) return finish(null);
      const output = `${Buffer.concat(stdout).toString('utf8')}\n${Buffer.concat(stderr).toString('utf8')}`;
      const match = output.match(/(?:v|version\s*)?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)/iu);
      finish(match?.[1] ?? null);
    });
  });
}

function requestKey(generationId: string, requestId: string | number): string {
  return `${generationId}\0${typeof requestId}:${String(requestId)}`;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\0${turnId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStringRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function managerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
