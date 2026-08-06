import {
  createCodexAppServerManager,
  type CodexAppServerEvent,
  type CodexAppServerManager,
  type CodexCapabilitiesSnapshot,
  type CodexServerRequestResponse,
  type CodexTransportState,
  type ExternalAgentImportEvent,
} from './codexAppServerManager.js';

interface RuntimeEntry {
  manager: CodexAppServerManager;
  commandPath: string;
  externalAgentHome: string | null;
  remoteControl: boolean;
  capabilities: CodexCapabilitiesSnapshot;
  threads: Set<string>;
  activeTurns: Map<string, string>;
  completedTurns: Set<string>;
  pendingRequests: Map<string, { generationId: string; threadId: string | null }>;
  unsubscribe: () => void;
  unsubscribeExternalImport: () => void;
  closing: boolean;
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
 * 新线程和已经空闲的旧线程迁移到当前运行时；正在执行或等待交互的线程固定在原运行时，直至自然排空。
 */
export function createCodexRuntimeGenerationManager(): CodexAppServerManager {
  const entries = new Set<RuntimeEntry>();
  const entriesByGeneration = new Map<string, RuntimeEntry>();
  const entriesByThread = new Map<string, RuntimeEntry>();
  const listeners = new Set<(event: CodexAppServerEvent) => void>();
  const externalImportListeners = new Set<(event: ExternalAgentImportEvent) => void>();
  let activeEntry: RuntimeEntry | null = null;
  let preparingForShutdown = false;
  let closePromise: Promise<void> | null = null;
  let activationChain: Promise<unknown> = Promise.resolve();
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

  function isPinned(entry: RuntimeEntry, threadId: string): boolean {
    if (entry.activeTurns.has(threadId)) return true;
    for (const request of entry.pendingRequests.values()) {
      if (request.threadId === threadId) return true;
    }
    return false;
  }

  function bindThread(entry: RuntimeEntry, threadId: string): void {
    const previous = entriesByThread.get(threadId);
    previous?.threads.delete(threadId);
    entriesByThread.set(threadId, entry);
    entry.threads.add(threadId);
  }

  async function migrateThreadToActive(threadId: string, cwd?: string): Promise<RuntimeEntry> {
    const active = requireActiveEntry();
    const mapped = entriesByThread.get(threadId);
    if (mapped === active) return active;
    if (mapped && isPinned(mapped, threadId)) return mapped;
    await active.manager.resumeThread({ threadId, ...(cwd ? { cwd } : {}) });
    bindThread(active, threadId);
    if (mapped) void tryDrain(mapped);
    return active;
  }

  function forwardEvent(entry: RuntimeEntry, event: CodexAppServerEvent): void {
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
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // 单个消费者异常不能中断其他世代的事件转发。
      }
    }
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

  async function activate(input: { commandPath: string; externalAgentHome?: string; remoteControl?: boolean }): Promise<CodexCapabilitiesSnapshot> {
    if (preparingForShutdown) throw managerError('ZEUS_CODEX_CLOSED', 'Codex runtime generation manager is closing.');
    const requestedHome = input.externalAgentHome ?? null;
    const requestedRemoteControl = input.remoteControl ?? remoteControlEnabled;
    const normalizedInput = { ...input, remoteControl: requestedRemoteControl };
    if (activeEntry && activeEntry.commandPath === input.commandPath && activeEntry.externalAgentHome === requestedHome && activeEntry.remoteControl === requestedRemoteControl) {
      const capabilities = await activeEntry.manager.ensureReady(normalizedInput);
      activeEntry.capabilities = capabilities;
      rememberGeneration(activeEntry, capabilities.generationId);
      return capabilities;
    }

    const manager = createCodexAppServerManager();
    const provisional: RuntimeEntry = {
      manager,
      commandPath: input.commandPath,
      externalAgentHome: requestedHome,
      remoteControl: requestedRemoteControl,
      capabilities: {
        generationId: '',
        initializedAt: '',
        models: [],
        supportedModels: [],
      },
      threads: new Set<string>(),
      activeTurns: new Map<string, string>(),
      completedTurns: new Set<string>(),
      pendingRequests: new Map<string, { generationId: string; threadId: string | null }>(),
      unsubscribe: () => undefined,
      unsubscribeExternalImport: () => undefined,
      closing: false,
    };
    provisional.unsubscribe = manager.subscribe((event) => forwardEvent(provisional, event));
    provisional.unsubscribeExternalImport = manager.subscribeExternalAgentImport(forwardExternalImport);
    entries.add(provisional);
    try {
      const capabilities = await manager.ensureReady(normalizedInput);
      provisional.capabilities = capabilities;
      rememberGeneration(provisional, capabilities.generationId);
      if (requestedRemoteControl) await manager.enableRemoteControl();
      const previous = activeEntry;
      activeEntry = provisional;
      if (requestedRemoteControl) remoteControlEnabled = true;
      if (previous) void tryDrain(previous);
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
    if (entry === activeEntry || entry.closing || entry.activeTurns.size > 0 || entry.pendingRequests.size > 0) return;
    entry.closing = true;
    for (const threadId of entry.threads) {
      if (entriesByThread.get(threadId) === entry) entriesByThread.delete(threadId);
    }
    entry.threads.clear();
    entry.unsubscribe();
    entry.unsubscribeExternalImport();
    await entry.manager.prepareForShutdown().catch(() => undefined);
    await entry.manager.close().catch(() => undefined);
    entries.delete(entry);
    for (const [generationId, knownEntry] of entriesByGeneration) {
      if (knownEntry === entry) entriesByGeneration.delete(generationId);
    }
  }

  function entryForGeneration(generationId: string): RuntimeEntry | null {
    const entry = entriesByGeneration.get(generationId);
    if (!entry) return null;
    return entry.manager.hasGeneration(generationId) ? entry : null;
  }

  return {
    ensureReady(input) {
      const activation = activationChain.then(() => activate(input));
      activationChain = activation.catch(() => undefined);
      return activation;
    },
    async startThread(input) {
      const entry = requireActiveEntry();
      const thread = await entry.manager.startThread(input);
      bindThread(entry, thread.id);
      return thread;
    },
    async resumeThread(input) {
      const mapped = entriesByThread.get(input.threadId);
      if (mapped && isPinned(mapped, input.threadId)) return mapped.manager.resumeThread(input);
      const active = requireActiveEntry();
      const thread = await active.manager.resumeThread(input);
      bindThread(active, thread.id);
      if (mapped && mapped !== active) void tryDrain(mapped);
      return thread;
    },
    async archiveThread(input) {
      const entry = routeThread(input.threadId);
      await entry.manager.archiveThread(input);
      entriesByThread.delete(input.threadId);
      entry.threads.delete(input.threadId);
      void tryDrain(entry);
    },
    async unarchiveThread(input) {
      const active = requireActiveEntry();
      const previous = entriesByThread.get(input.threadId);
      const thread = await active.manager.unarchiveThread(input);
      bindThread(active, thread.id);
      if (previous && previous !== active) void tryDrain(previous);
      return thread;
    },
    async readThread(input) {
      return routeThread(input.threadId).manager.readThread(input);
    },
    async startTurn(input) {
      const entry = await migrateThreadToActive(input.threadId, input.cwd);
      const turn = await entry.manager.startTurn(input);
      const identity = turnKey(input.threadId, turn.id);
      if (entry.completedTurns.has(identity)) entry.completedTurns.delete(identity);
      else entry.activeTurns.set(input.threadId, turn.id);
      return turn;
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
      if ([...entries].some((entry) => entry.activeTurns.size > 0 || entry.pendingRequests.size > 0)) {
        throw managerError('ZEUS_CODEX_REMOTE_CONTROL_BUSY', '请先让正在运行或等待回答的会话结束，再启用远程接管；切换执行宿主不能安全搬移进行中的请求。');
      }
      remoteControlEnabled = true;
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
            activeThreadCount: entry.activeTurns.size,
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
        listeners.clear();
        externalImportListeners.clear();
        activeEntry = null;
      })();
      return closePromise;
    },
  };
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

function managerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
