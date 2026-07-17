import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  CodexJsonLineDecoder,
  parseExternalAgentConfigDetectResponse,
  parseExternalAgentConfigImportHistoriesResponse,
  parseExternalAgentConfigImportResponse,
  parseExternalAgentImportNotification,
  type CodexWireId,
  type CodexWireMessage,
  type ExternalAgentConfigDetectParams,
  type ExternalAgentConfigDetectResponse,
  type ExternalAgentConfigImportHistory,
  type ExternalAgentConfigImportParams,
  type ExternalAgentConfigImportResponse,
  type ExternalAgentImportNotification,
} from './codexAppServerProtocol.js';
export type {
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportHistory,
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  ExternalAgentImportNotification,
} from './codexAppServerProtocol.js';
import { expandCliSearchPath } from './cliSearchPath.js';

export interface CodexAppServerReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

export interface CodexAppServerProcess {
  readonly pid?: number;
  stdin: { write(chunk: string | Uint8Array): boolean };
  stdout: CodexAppServerReadable;
  stderr: CodexAppServerReadable;
  on(event: 'exit' | 'error', listener: (...args: unknown[]) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface CodexAppServerSpawnOptions {
  env: NodeJS.ProcessEnv;
}

export type CodexAppServerSpawn = (command: string, args: string[], options?: CodexAppServerSpawnOptions) => CodexAppServerProcess;

export interface CodexModelCapability {
  id: string;
  model: string;
  displayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  raw: Record<string, unknown>;
}

export interface CodexCapabilitiesSnapshot {
  generationId: string;
  initializedAt: string;
  models: CodexModelCapability[];
  supportedModels: string[];
}

export type CodexSandboxPolicy = { type: 'readOnly'; networkAccess: false } | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean } | { type: 'dangerFullAccess' };

export interface CodexThreadStartInput {
  model: string;
  cwd: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox: CodexSandboxPolicy;
  config?: never;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
}

export interface CodexThreadSnapshot {
  id: string;
  turns?: unknown[];
  [key: string]: unknown;
}

export interface CodexTurnStartInput {
  threadId: string;
  clientUserMessageId?: string;
  input: Array<Record<string, unknown>>;
  additionalContext?: Record<string, unknown>;
  collaborationMode?: { mode: 'plan' | 'default'; settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null } };
  model?: string;
  effort?: string;
  cwd?: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandboxPolicy?: CodexSandboxPolicy;
}

export interface CodexTurnSteerInput {
  threadId: string;
  turnId: string;
  clientUserMessageId?: string;
  input: Array<Record<string, unknown>>;
}

export interface CodexTurnSnapshot {
  id: string;
  threadId: string;
  items?: unknown[];
  [key: string]: unknown;
}

interface CodexServerResponseBase {
  generationId: string;
  requestId: CodexWireId;
}

export type CodexServerRequestResponse =
  | (CodexServerResponseBase & { type: 'command'; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' })
  | (CodexServerResponseBase & { type: 'file'; decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel' })
  | (CodexServerResponseBase & {
      type: 'permissions';
      permissions: {
        network?: { enabled: boolean | null };
        fileSystem?: { read: string[] | null; write: string[] | null; globScanMaxDepth?: number };
      };
      scope: 'turn' | 'session';
      strictAutoReview?: boolean;
    })
  | (CodexServerResponseBase & { type: 'request_user_input'; answers: Record<string, { answers: string[] }> })
  | (CodexServerResponseBase & { type: 'mcp'; action: 'accept' | 'decline' | 'cancel'; content: JsonValue | null; _meta: JsonValue | null });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CodexAppServerEvent {
  generationId: string;
  sequence: number;
  method: string;
  params: unknown;
  receivedAt: string;
  requestId?: CodexWireId;
}

export type CodexTransportState =
  | { type: 'idle' }
  | { type: 'starting'; generationId: string }
  | { type: 'ready'; generationId: string; capabilities: CodexCapabilitiesSnapshot }
  | { type: 'restarting'; generationId: string; attempt: number }
  | { type: 'closed' };

export interface CodexAppServerManager {
  ensureReady(input: { commandPath: string; externalAgentHome?: string }): Promise<CodexCapabilitiesSnapshot>;
  startThread(input: CodexThreadStartInput): Promise<CodexThreadSnapshot>;
  resumeThread(input: { threadId: string; cwd?: string }): Promise<CodexThreadSnapshot>;
  readThread(input: { threadId: string }): Promise<CodexThreadSnapshot>;
  startTurn(input: CodexTurnStartInput): Promise<CodexTurnSnapshot>;
  steerTurn(input: CodexTurnSteerInput): Promise<{ turnId: string }>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  respondToServerRequest(input: CodexServerRequestResponse): Promise<void>;
  detectExternalAgentConfig(input?: ExternalAgentConfigDetectParams): Promise<ExternalAgentConfigDetectResponse>;
  startExternalAgentImport(input: ExternalAgentConfigImportParams): Promise<ExternalAgentConfigImportResponse>;
  readExternalAgentImportHistories(): Promise<ExternalAgentConfigImportHistory[]>;
  subscribeExternalAgentImport(listener: (event: ExternalAgentImportEvent) => void): () => void;
  subscribe(listener: (event: CodexAppServerEvent) => void): () => void;
  getState(): CodexTransportState;
  prepareForShutdown(): Promise<void>;
  close(): Promise<void>;
}

export type ExternalAgentImportEvent = ExternalAgentImportNotification & { generationId: string };

type PendingRequest = {
  generationId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

interface CreateCodexAppServerManagerOptions {
  spawn?: CodexAppServerSpawn;
  now?: () => string;
  generationId?: () => string;
  requestTimeoutMs?: number;
  appServerFlags?: readonly string[];
  onRestartScheduled?: (delayMs: number, attempt: number) => void;
  onDiagnostic?: (entry: { generationId: string; sequence: number; stderrSummary: string }) => void;
  eventReplayLimit?: number;
  shutdownTimeoutMs?: number;
}

type ProcessExitTracker = { promise: Promise<void>; resolve: () => void; exited: boolean };

type ServerRequestRecord = {
  generationId: string;
  method: string;
  params: unknown;
  paramsIdentity: string;
  state: 'pending' | 'responded' | 'unsupported' | 'conflicted';
};

const RESTART_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

function resolveBeforeTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve(false);
    }, timeoutMs);
    void promise.then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

export function createCodexAppServerManager(options: CreateCodexAppServerManagerOptions = {}): CodexAppServerManager {
  const spawn = options.spawn ?? spawnNodeCodexAppServer;
  const now = options.now ?? (() => new Date().toISOString());
  const makeGenerationId = options.generationId ?? randomUUID;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const eventReplayLimit = options.eventReplayLimit ?? 1_024;
  const shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? 5_000);
  const listeners = new Set<(event: CodexAppServerEvent) => void>();
  const externalAgentImportListeners = new Set<(event: ExternalAgentImportEvent) => void>();
  const eventReplayBuffer: CodexAppServerEvent[] = [];
  const pendingRequests = new Map<string, PendingRequest>();
  const serverRequests = new Map<string, ServerRequestRecord>();
  const processExitTrackers = new Map<CodexAppServerProcess, ProcessExitTracker>();
  const pendingInterrupts = new Set<string>();
  const startedTurns = new Set<string>();
  const threadModels = new Map<string, string>();
  let state: CodexTransportState = { type: 'idle' };
  let child: CodexAppServerProcess | null = null;
  let commandPath: string | null = null;
  let externalAgentHome: string | null = null;
  let readyPromise: Promise<CodexCapabilitiesSnapshot> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectScheduledRestart: ((error: Error) => void) | null = null;
  let restartAttempt = 0;
  let requestSequence = 0;
  let eventSequence = 0;
  let diagnosticSequence = 0;
  let preparingForShutdown = false;
  let closePromise: Promise<void> | null = null;

  function currentGenerationId(): string {
    if (state.type === 'idle' || state.type === 'closed') throw managerError('ZEUS_CODEX_NOT_READY', 'Codex app-server is not ready.');
    return state.generationId;
  }

  function start(command: string): Promise<CodexCapabilitiesSnapshot> {
    const generationId = makeGenerationId();
    requestSequence = 0;
    eventSequence = 0;
    diagnosticSequence = 0;
    eventReplayBuffer.length = 0;
    pendingInterrupts.clear();
    startedTurns.clear();
    state = { type: 'starting', generationId };
    const decoder = new CodexJsonLineDecoder();
    const spawned = spawn(command, ['app-server', ...(options.appServerFlags ?? []), '--listen', 'stdio://'], {
      env: {
        ...process.env,
        PATH: expandCliSearchPath(),
        ...(externalAgentHome === null ? {} : { ZEUS_CODEX_EXTERNAL_AGENT_HOME: externalAgentHome }),
      },
    });
    trackProcessExit(spawned);
    child = spawned;
    spawned.stdout.on('data', (chunk) => {
      if (child !== spawned || state.type === 'closed') return;
      for (const frame of decoder.push(toBuffer(chunk))) {
        if (frame.type === 'protocol_error') {
          emitEvent(generationId, 'transport/protocol_error', frame.error);
        } else {
          handleWireMessage(generationId, frame.message);
        }
      }
    });
    spawned.stderr.on('data', (chunk) => {
      if (child !== spawned || state.type === 'closed') return;
      options.onDiagnostic?.({
        generationId,
        sequence: ++diagnosticSequence,
        stderrSummary: summarizeStderr(toBuffer(chunk).toString('utf8')),
      });
    });
    spawned.on('error', (error) => {
      const failure = error instanceof Error ? error : new Error('Codex app-server process error.');
      // A failed spawn has no OS process to await. A pid-bearing ChildProcess error does not prove exit.
      if (spawned.pid === undefined) {
        markProcessExited(spawned);
        handleProcessExit(spawned, generationId, failure);
        return;
      }
      if (child === spawned && state.type !== 'closed') {
        emitEvent(generationId, 'transport/process_error', { message: 'Codex app-server process reported an error before exit.' });
      }
    });
    spawned.on('exit', (code, signal) => {
      markProcessExited(spawned);
      handleProcessExit(spawned, generationId, managerError('ZEUS_CODEX_GENERATION_EXITED', `Codex app-server generation exited (${String(code ?? signal ?? 'unknown')}).`));
    });

    const handshake = (async () => {
      await rpc(generationId, 'initialize', {
        clientInfo: { name: 'zeus', title: 'Zeus', version: '0.1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      write({ method: 'initialized' });
      const modelList = await rpc(generationId, 'model/list', {});
      const models = parseModels(modelList);
      const capabilities: CodexCapabilitiesSnapshot = {
        generationId,
        initializedAt: now(),
        models,
        supportedModels: models.map((model) => model.model),
      };
      if (child !== spawned) throw managerError('ZEUS_CODEX_GENERATION_EXITED', 'Codex app-server generation changed during initialization.');
      state = { type: 'ready', generationId, capabilities };
      restartAttempt = 0;
      return capabilities;
    })();
    return handshake.catch((error: unknown) => {
      const failure = asError(error);
      if (child === spawned) {
        spawned.kill('SIGTERM');
      }
      throw failure;
    });
  }

  function trackProcessExit(process: CodexAppServerProcess): void {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    processExitTrackers.set(process, { promise, resolve, exited: false });
  }

  function markProcessExited(process: CodexAppServerProcess): void {
    const tracker = processExitTrackers.get(process);
    if (!tracker || tracker.exited) return;
    tracker.exited = true;
    tracker.resolve();
    processExitTrackers.delete(process);
  }

  async function terminateProcess(process: CodexAppServerProcess): Promise<void> {
    const tracker = processExitTrackers.get(process);
    if (!tracker || tracker.exited) return;
    process.kill('SIGTERM');
    if (await resolveBeforeTimeout(tracker.promise, shutdownTimeoutMs)) return;
    if (!tracker.exited) process.kill('SIGKILL');
    await tracker.promise;
  }

  function handleProcessExit(process: CodexAppServerProcess, generationId: string, error: Error): void {
    if (child !== process) return;
    child = null;
    rejectGeneration(generationId, error);
    for (const [key, request] of serverRequests) {
      if (request.generationId === generationId) serverRequests.delete(key);
    }
    if (preparingForShutdown || state.type === 'closed') return;
    scheduleRestart(generationId);
  }

  function scheduleRestart(generationId: string): void {
    restartAttempt += 1;
    const delay = RESTART_DELAYS_MS[Math.min(restartAttempt - 1, RESTART_DELAYS_MS.length - 1)];
    state = { type: 'restarting', generationId, attempt: restartAttempt };
    options.onRestartScheduled?.(delay, restartAttempt);
    readyPromise = new Promise<CodexCapabilitiesSnapshot>((resolve, reject) => {
      rejectScheduledRestart = reject;
      restartTimer = setTimeout(() => {
        restartTimer = null;
        rejectScheduledRestart = null;
        if (preparingForShutdown || state.type === 'closed' || commandPath === null) {
          reject(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
          return;
        }
        start(commandPath).then(resolve, reject);
      }, delay);
    });
    void readyPromise.catch(() => undefined);
  }

  function write(message: unknown): void {
    if (child === null) throw managerError('ZEUS_CODEX_NOT_READY', 'Codex app-server process is unavailable.');
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function rpc(generationId: string, method: string, params: unknown): Promise<unknown> {
    if (preparingForShutdown || state.type === 'closed') return Promise.reject(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
    if (generationId !== currentGenerationId()) return Promise.reject(managerError('ZEUS_CODEX_STALE_GENERATION', 'Codex app-server generation is stale.'));
    const id = `${generationId}:${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(pendingKey(generationId, id));
        reject(managerError('ZEUS_CODEX_RPC_TIMEOUT', `Codex app-server request timed out: ${method}`));
      }, requestTimeoutMs);
      pendingRequests.set(pendingKey(generationId, id), { generationId, resolve, reject, timeout });
      try {
        write({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        pendingRequests.delete(pendingKey(generationId, id));
        reject(asError(error));
      }
    });
  }

  function handleWireMessage(generationId: string, message: CodexWireMessage): void {
    if ('id' in message && !('method' in message)) {
      const key = pendingKey(generationId, message.id);
      const pending = pendingRequests.get(key);
      if (!pending) return;
      pendingRequests.delete(key);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (!('method' in message)) return;
    const requestId = 'id' in message ? message.id : undefined;
    const requestKey = requestId === undefined ? null : serverRequestKey(generationId, requestId);
    const existingRequest = requestKey === null ? undefined : serverRequests.get(requestKey);
    const paramsIdentity = requestId === undefined ? null : canonicalJson(message.params);
    if (requestId !== undefined && existingRequest && (existingRequest.method !== message.method || existingRequest.paramsIdentity !== paramsIdentity)) {
      existingRequest.state = 'conflicted';
      write({ id: requestId, error: { code: -32600, message: 'Conflicting Codex server request identity.' } });
      const originalParams = isRecord(existingRequest.params) ? existingRequest.params : {};
      const receivedParams = isRecord(message.params) ? message.params : {};
      emitEvent(
        generationId,
        'transport/server_request_identity_conflict',
        {
          originalMethod: existingRequest.method,
          receivedMethod: message.method,
          ...(typeof originalParams.threadId === 'string' ? { threadId: originalParams.threadId } : typeof receivedParams.threadId === 'string' ? { threadId: receivedParams.threadId } : {}),
          ...(typeof originalParams.turnId === 'string' ? { turnId: originalParams.turnId } : typeof receivedParams.turnId === 'string' ? { turnId: receivedParams.turnId } : {}),
        },
        requestId,
      );
      return;
    }
    if (requestId !== undefined && existingRequest?.state === 'conflicted') {
      write({ id: requestId, error: { code: -32600, message: 'Conflicting Codex server request identity.' } });
      return;
    }
    if (requestId !== undefined && !supportedServerRequestMethods.has(message.method)) {
      if (!existingRequest && requestKey !== null && paramsIdentity !== null) {
        serverRequests.set(requestKey, { generationId, method: message.method, params: message.params, paramsIdentity, state: 'unsupported' });
      }
      write({ id: requestId, error: { code: -32601, message: 'Unsupported Codex server request method.' } });
      const params = isRecord(message.params) ? message.params : {};
      emitEvent(generationId, 'transport/unsupported_server_request', {
        method: message.method,
        ...(typeof params.threadId === 'string' ? { threadId: params.threadId } : {}),
        ...(typeof params.turnId === 'string' ? { turnId: params.turnId } : {}),
      });
      return;
    }
    if (requestId !== undefined && requestKey !== null && paramsIdentity !== null) {
      if (existingRequest?.state === 'pending') return;
      if (existingRequest) {
        existingRequest.state = 'pending';
      } else {
        serverRequests.set(requestKey, { generationId, method: message.method, params: message.params, paramsIdentity, state: 'pending' });
      }
    }
    emitEvent(generationId, message.method, message.params, requestId);
    if (message.method === 'externalAgentConfig/import/progress' || message.method === 'externalAgentConfig/import/completed') {
      try {
        const parsed = parseExternalAgentImportNotification(message.method, message.params);
        const event = { ...parsed, generationId };
        for (const listener of externalAgentImportListeners) {
          try {
            listener(event);
          } catch {
            // Consumer failures are isolated from the app-server transport and other listeners.
          }
        }
      } catch (error) {
        emitEvent(generationId, 'transport/protocol_error', {
          code: 'INVALID_EXTERNAL_AGENT_IMPORT_NOTIFICATION',
          detail: asError(error).message,
        });
      }
    }
    if (message.method === 'turn/started') observeTurnStarted(generationId, message.params);
  }

  function emitEvent(generationId: string, method: string, params: unknown, requestId?: CodexWireId): void {
    const event: CodexAppServerEvent = {
      generationId,
      sequence: ++eventSequence,
      method,
      params,
      receivedAt: now(),
      ...(requestId === undefined ? {} : { requestId }),
    };
    if (eventReplayLimit > 0) {
      eventReplayBuffer.push(event);
      if (eventReplayBuffer.length > eventReplayLimit) eventReplayBuffer.splice(0, eventReplayBuffer.length - eventReplayLimit);
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Consumer failures must not break decoding, request settlement, or other listeners.
      }
    }
  }

  function observeTurnStarted(generationId: string, params: unknown): void {
    const record = isRecord(params) ? params : {};
    const threadId = typeof record.threadId === 'string' ? record.threadId : null;
    const turn = isRecord(record.turn) ? record.turn : {};
    const turnId = typeof turn.id === 'string' ? turn.id : typeof record.turnId === 'string' ? record.turnId : null;
    if (!threadId || !turnId) return;
    const key = turnKey(threadId, turnId);
    startedTurns.add(key);
    if (!pendingInterrupts.delete(key)) return;
    void rpc(generationId, 'turn/interrupt', { threadId, turnId }).catch(() => undefined);
  }

  function rejectGeneration(generationId: string, error: Error): void {
    for (const [key, pending] of pendingRequests) {
      if (pending.generationId !== generationId) continue;
      clearTimeout(pending.timeout);
      pendingRequests.delete(key);
      pending.reject(error);
    }
  }

  async function awaitCapabilities(): Promise<CodexCapabilitiesSnapshot> {
    if (state.type === 'ready') return state.capabilities;
    if (readyPromise) return readyPromise;
    throw managerError('ZEUS_CODEX_NOT_READY', 'Call ensureReady before using Codex app-server.');
  }

  function requireModel(capabilities: CodexCapabilitiesSnapshot, modelName: string): CodexModelCapability {
    const model = capabilities.models.find((candidate) => candidate.model === modelName || candidate.id === modelName);
    if (!model) {
      throw Object.assign(new Error(`Configured Codex model is unavailable: ${modelName}`), {
        code: 'ZEUS_CODEX_MODEL_UNAVAILABLE',
        supportedModels: [...capabilities.supportedModels],
      });
    }
    return model;
  }

  return {
    ensureReady(input) {
      if (state.type === 'closed' || preparingForShutdown) return Promise.reject(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
      if (commandPath !== null && commandPath !== input.commandPath) {
        return Promise.reject(managerError('ZEUS_CODEX_COMMAND_PATH_CHANGED', 'Codex command path cannot change while the manager is active.'));
      }
      const requestedExternalAgentHome = input.externalAgentHome ?? null;
      if (requestedExternalAgentHome !== null && !isAbsolute(requestedExternalAgentHome)) {
        return Promise.reject(managerError('ZEUS_CODEX_EXTERNAL_AGENT_HOME_INVALID', 'Codex external-agent home must be an absolute path.'));
      }
      if (commandPath !== null && externalAgentHome !== requestedExternalAgentHome) {
        return Promise.reject(managerError('ZEUS_CODEX_EXTERNAL_AGENT_HOME_CHANGED', 'Codex external-agent home cannot change while the manager is active.'));
      }
      commandPath = input.commandPath;
      externalAgentHome = requestedExternalAgentHome;
      if (state.type === 'ready') return Promise.resolve(state.capabilities);
      if (readyPromise) return readyPromise;
      readyPromise = start(input.commandPath);
      void readyPromise.catch(() => undefined);
      return readyPromise;
    },
    async startThread(input) {
      const capabilities = await awaitCapabilities();
      requireModel(capabilities, input.model);
      if (input.config !== undefined) throw managerError('ZEUS_CODEX_CONFIG_UNAVAILABLE', 'Raw Codex thread config overrides are not supported.');
      const sandbox = normalizeThreadSandbox(input.sandbox);
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'thread/start',
          compactObject({
            model: input.model,
            cwd: input.cwd,
            approvalPolicy: input.approvalPolicy,
            approvalsReviewer: input.approvalsReviewer,
            sandbox: sandbox.mode,
            runtimeWorkspaceRoots: sandbox.runtimeWorkspaceRoots,
            baseInstructions: input.baseInstructions,
            developerInstructions: input.developerInstructions,
            ephemeral: input.ephemeral,
          }),
        ),
      );
      const thread = parseThread(response.thread);
      threadModels.set(thread.id, typeof response.model === 'string' ? response.model : input.model);
      return thread;
    },
    async resumeThread(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await rpc(capabilities.generationId, 'thread/resume', compactObject({ threadId: input.threadId, cwd: input.cwd })));
      const thread = parseThread(response.thread);
      if (typeof response.model === 'string') threadModels.set(thread.id, response.model);
      return thread;
    },
    async readThread(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await rpc(capabilities.generationId, 'thread/read', { threadId: input.threadId, includeTurns: true }));
      return parseThread(response.thread);
    },
    async startTurn(input) {
      const capabilities = await awaitCapabilities();
      const modelName = input.model ?? threadModels.get(input.threadId);
      const model = modelName ? requireModel(capabilities, modelName) : null;
      if (input.effort !== undefined) {
        const supportedEfforts = model?.supportedReasoningEfforts ?? [];
        if (!model || !supportedEfforts.includes(input.effort)) {
          throw Object.assign(new Error(`Configured Codex effort is unavailable: ${input.effort}`), {
            code: 'ZEUS_CODEX_EFFORT_UNAVAILABLE',
            supportedEfforts: [...supportedEfforts],
          });
        }
      }
      if (input.collaborationMode) {
        const collaborationModel = requireModel(capabilities, input.collaborationMode.settings.model);
        const collaborationEffort = input.collaborationMode.settings.reasoning_effort;
        if (collaborationEffort !== null && !collaborationModel.supportedReasoningEfforts.includes(collaborationEffort)) {
          throw Object.assign(new Error(`Configured Codex effort is unavailable: ${collaborationEffort}`), {
            code: 'ZEUS_CODEX_EFFORT_UNAVAILABLE',
            supportedEfforts: [...collaborationModel.supportedReasoningEfforts],
          });
        }
      }
      const sandboxPolicy = input.sandboxPolicy === undefined ? undefined : normalizeTurnSandbox(input.sandboxPolicy);
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'turn/start',
          compactObject({
            threadId: input.threadId,
            clientUserMessageId: input.clientUserMessageId,
            input: input.input,
            additionalContext: input.additionalContext,
            collaborationMode: input.collaborationMode,
            model: input.model,
            effort: input.effort,
            cwd: input.cwd,
            approvalPolicy: input.approvalPolicy,
            approvalsReviewer: input.approvalsReviewer,
            sandboxPolicy,
          }),
        ),
      );
      const turn = parseTurn(response.turn, input.threadId);
      if (input.model) threadModels.set(input.threadId, input.model);
      return turn;
    },
    async steerTurn(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(
        await rpc(capabilities.generationId, 'turn/steer', {
          threadId: input.threadId,
          expectedTurnId: input.turnId,
          clientUserMessageId: input.clientUserMessageId,
          input: input.input,
        }),
      );
      if (typeof response.turnId !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex turn/steer response omitted turnId.');
      return { turnId: response.turnId };
    },
    async interruptTurn(input) {
      const capabilities = await awaitCapabilities();
      const key = turnKey(input.threadId, input.turnId);
      if (!startedTurns.has(key)) {
        pendingInterrupts.add(key);
        return;
      }
      await rpc(capabilities.generationId, 'turn/interrupt', input);
    },
    async respondToServerRequest(input) {
      const generationId = currentGenerationId();
      if (input.generationId !== generationId) throw managerError('ZEUS_CODEX_STALE_GENERATION', 'Cannot respond to a server request from another generation.');
      const key = serverRequestKey(generationId, input.requestId);
      const request = serverRequests.get(key);
      if (!request) throw managerError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
      if (request.state === 'conflicted') throw managerError('ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT', 'Codex server request identity is conflicted.');
      if (request.state !== 'pending') throw managerError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
      const expectedMethod = serverMethodForResponse(input.type);
      if (request.method !== expectedMethod) throw managerError('ZEUS_CODEX_SERVER_REQUEST_TYPE_MISMATCH', `Expected ${request.method}, received ${input.type}.`);
      validateServerResponse(input);
      let result: Record<string, unknown>;
      switch (input.type) {
        case 'command':
        case 'file':
          result = { decision: input.decision };
          break;
        case 'permissions':
          result = compactObject({ permissions: input.permissions, scope: input.scope, strictAutoReview: input.strictAutoReview });
          break;
        case 'request_user_input':
          result = { answers: input.answers };
          break;
        case 'mcp':
          result = { action: input.action, content: input.content, _meta: input._meta };
          break;
      }
      write({ id: input.requestId, result });
      request.state = 'responded';
    },
    async detectExternalAgentConfig(input = {}) {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigDetectResponse(await rpc(capabilities.generationId, 'externalAgentConfig/detect', compactObject({ includeHome: input.includeHome, cwds: input.cwds })));
    },
    async startExternalAgentImport(input) {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigImportResponse(await rpc(capabilities.generationId, 'externalAgentConfig/import', input));
    },
    async readExternalAgentImportHistories() {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigImportHistoriesResponse(await rpc(capabilities.generationId, 'externalAgentConfig/import/readHistories', {})).data;
    },
    subscribeExternalAgentImport(listener) {
      externalAgentImportListeners.add(listener);
      return () => externalAgentImportListeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      for (const event of eventReplayBuffer) listener(event);
      return () => listeners.delete(listener);
    },
    getState() {
      return state;
    },
    async prepareForShutdown() {
      preparingForShutdown = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      rejectScheduledRestart?.(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager is closing.'));
      rejectScheduledRestart = null;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        preparingForShutdown = true;
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = null;
        }
        rejectScheduledRestart?.(managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager closed.'));
        rejectScheduledRestart = null;
        const process = child;
        const previousGeneration = state.type === 'idle' || state.type === 'closed' ? null : state.generationId;
        state = { type: 'closed' };
        if (previousGeneration) rejectGeneration(previousGeneration, managerError('ZEUS_CODEX_CLOSED', 'Codex app-server manager closed.'));
        if (process) await terminateProcess(process);
        if (child === process) child = null;
        listeners.clear();
        externalAgentImportListeners.clear();
        eventReplayBuffer.length = 0;
        serverRequests.clear();
        pendingInterrupts.clear();
        startedTurns.clear();
      })();
      return closePromise;
    },
  };
}

function spawnNodeCodexAppServer(command: string, args: string[], options?: CodexAppServerSpawnOptions): CodexAppServerProcess {
  const child = nodeSpawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: options?.env });
  return child as unknown as CodexAppServerProcess;
}

function parseModels(value: unknown): CodexModelCapability[] {
  const response = asRecord(value);
  if (!Array.isArray(response.data)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list response omitted data.');
  return response.data.map((entry) => {
    const model = asRecord(entry);
    if (typeof model.id !== 'string' || typeof model.model !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned an invalid model.');
    const effortEntries = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    const supportedReasoningEfforts = effortEntries.map((effort) => (isRecord(effort) && typeof effort.reasoningEffort === 'string' ? effort.reasoningEffort : null)).filter((effort): effort is string => effort !== null);
    return {
      id: model.id,
      model: model.model,
      ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : {}),
      supportedReasoningEfforts,
      ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      raw: model,
    };
  });
}

function parseThread(value: unknown): CodexThreadSnapshot {
  const thread = asRecord(value);
  if (typeof thread.id !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex thread response omitted id.');
  return thread as CodexThreadSnapshot;
}

function parseTurn(value: unknown, threadId: string): CodexTurnSnapshot {
  const turn = asRecord(value);
  if (typeof turn.id !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex turn response omitted id.');
  return { ...turn, id: turn.id, threadId };
}

function normalizeThreadSandbox(sandbox: CodexSandboxPolicy): { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; runtimeWorkspaceRoots?: string[] } {
  if (!isRecord(sandbox)) throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox is invalid.');
  if (sandbox.type === 'readOnly' && sandbox.networkAccess === false) return { mode: 'read-only' };
  if (sandbox.type === 'dangerFullAccess' && Object.keys(sandbox).length === 1) return { mode: 'danger-full-access' };
  if (sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && validWritableRoots(sandbox.writableRoots)) {
    return { mode: 'workspace-write', runtimeWorkspaceRoots: [...sandbox.writableRoots] };
  }
  throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox must be read-only, workspace-write, or danger-full-access.');
}

function normalizeTurnSandbox(sandbox: CodexSandboxPolicy): Record<string, unknown> {
  if (!isRecord(sandbox)) throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox is invalid.');
  if (sandbox.type === 'readOnly' && sandbox.networkAccess === false) return { type: 'readOnly', networkAccess: false };
  if (sandbox.type === 'dangerFullAccess' && Object.keys(sandbox).length === 1) return { type: 'dangerFullAccess' };
  if (sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && validWritableRoots(sandbox.writableRoots)) {
    return {
      type: 'workspaceWrite',
      writableRoots: [...sandbox.writableRoots],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
  }
  throw managerError('ZEUS_CODEX_SANDBOX_UNAVAILABLE', 'Codex sandbox must be read-only, workspace-write, or danger-full-access.');
}

function validWritableRoots(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((root) => typeof root === 'string' && isAbsolute(root));
}

function validateServerResponse(input: CodexServerRequestResponse): void {
  if (input.type === 'command' || input.type === 'file') {
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(input.decision)) throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex approval decision is invalid.');
    return;
  }
  if (input.type === 'permissions') {
    if ((input.scope !== 'turn' && input.scope !== 'session') || !isPermissionProfile(input.permissions) || (input.strictAutoReview !== undefined && typeof input.strictAutoReview !== 'boolean')) {
      throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex permissions response is invalid.');
    }
    return;
  }
  if (input.type === 'request_user_input') {
    if (!isRecord(input.answers) || !Object.values(input.answers).every((answer) => isRecord(answer) && Array.isArray(answer.answers) && answer.answers.every((entry) => typeof entry === 'string'))) {
      throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex request_user_input response is invalid.');
    }
    return;
  }
  if (!['accept', 'decline', 'cancel'].includes(input.action) || !isJsonValue(input.content) || !isJsonValue(input._meta)) {
    throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex MCP response is invalid.');
  }
}

function isPermissionProfile(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!hasOnlyKeys(value, ['network', 'fileSystem'])) return false;
  if (value.network !== undefined && (!isRecord(value.network) || !hasOnlyKeys(value.network, ['enabled']))) return false;
  if (value.network !== undefined && (!isRecord(value.network) || (value.network.enabled !== null && typeof value.network.enabled !== 'boolean'))) return false;
  if (value.fileSystem !== undefined) {
    if (!isRecord(value.fileSystem)) return false;
    if (!hasOnlyKeys(value.fileSystem, ['read', 'write', 'globScanMaxDepth'])) return false;
    for (const field of ['read', 'write'] as const) {
      const entries = value.fileSystem[field];
      if (entries !== null && (!Array.isArray(entries) || !entries.every((entry) => typeof entry === 'string' && isAbsolute(entry)))) return false;
    }
    if (value.fileSystem.globScanMaxDepth !== undefined && (!Number.isInteger(value.fileSystem.globScanMaxDepth) || Number(value.fileSystem.globScanMaxDepth) < 0)) return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function serverMethodForResponse(type: CodexServerRequestResponse['type']): string {
  return {
    command: 'item/commandExecution/requestApproval',
    file: 'item/fileChange/requestApproval',
    permissions: 'item/permissions/requestApproval',
    request_user_input: 'item/tool/requestUserInput',
    mcp: 'mcpServer/elicitation/request',
  }[type];
}

const supportedServerRequestMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']);

function pendingKey(generationId: string, id: CodexWireId): string {
  return `${generationId}\u0000${typeof id}:${String(id)}`;
}

function serverRequestKey(generationId: string, id: CodexWireId): string {
  return pendingKey(generationId, id);
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex app-server returned an invalid object.');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toBuffer(value: Buffer | string): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function summarizeStderr(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/giu, '[REDACTED]')
    .replace(/\bAuthorization\s*:\s*Bearer\s+[^\s]+/giu, 'Authorization: Bearer [REDACTED]')
    .replace(/\bBearer\s+[^\s]+/giu, 'Bearer [REDACTED]')
    .replace(/\b([A-Z0-9_.-]*(?:token|api[_-]?key|password|secret)[A-Z0-9_.-]*)\s*[:=]\s*([^\s,;]+)/giu, '$1=[REDACTED]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 512);
}

function managerError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
