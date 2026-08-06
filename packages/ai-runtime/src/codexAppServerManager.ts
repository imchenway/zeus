import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import { WebSocket, type RawData } from 'ws';
import {
  CodexJsonLineDecoder,
  type CodexWireId,
  type CodexWireMessage,
  type ExternalAgentConfigDetectParams,
  type ExternalAgentConfigDetectResponse,
  type ExternalAgentConfigImportHistory,
  type ExternalAgentConfigImportParams,
  type ExternalAgentConfigImportResponse,
  type ExternalAgentImportNotification,
  parseExternalAgentConfigDetectResponse,
  parseExternalAgentConfigImportHistoriesResponse,
  parseExternalAgentConfigImportResponse,
  parseExternalAgentImportNotification,
} from './codexAppServerProtocol.js';
import { expandCliSearchPath } from './cliSearchPath.js';

export type {
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportHistory,
  ExternalAgentConfigImportParams,
  ExternalAgentConfigImportResponse,
  ExternalAgentImportNotification,
} from './codexAppServerProtocol.js';

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

export interface CodexModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface CodexModelCapability {
  id: string;
  model: string;
  displayName?: string;
  supportedReasoningEfforts: string[];
  defaultReasoningEffort?: string;
  serviceTiers: CodexModelServiceTier[];
  defaultServiceTier?: string | null;
  raw: Record<string, unknown>;
}

export interface CodexCapabilitiesSnapshot {
  generationId: string;
  initializedAt: string;
  models: CodexModelCapability[];
  supportedModels: string[];
}

export type CodexSandboxPolicy = { type: 'readOnly'; networkAccess: false } | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean } | { type: 'dangerFullAccess' };
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

export interface CodexDynamicToolFunctionSpec {
  type: 'function';
  name: string;
  description: string;
  inputSchema: JsonValue;
  deferLoading?: boolean;
}

export interface CodexDynamicToolNamespaceSpec {
  type: 'namespace';
  name: string;
  description: string;
  tools: CodexDynamicToolFunctionSpec[];
}

export type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

export interface CodexThreadStartInput {
  model: string;
  serviceTier?: string | null;
  cwd: string;
  approvalPolicy?: string;
  approvalsReviewer?: string;
  sandbox: CodexSandboxPolicy;
  config?: never;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  dynamicTools?: CodexDynamicToolSpec[];
}

export interface CodexThreadSnapshot {
  id: string;
  turns?: unknown[];
  providerSettings?: {
    generationId: string;
    sequence: number;
    model: string;
    effort?: string;
    serviceTier?: string | null;
  };
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
  serviceTier?: string | null;
  summary?: CodexReasoningSummary;
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
  | (CodexServerResponseBase & { type: 'command'; decision: CodexCommandApprovalDecision })
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
  | (CodexServerResponseBase & { type: 'mcp'; action: 'accept' | 'decline' | 'cancel'; content: JsonValue | null; _meta: JsonValue | null })
  | (CodexServerResponseBase & {
      type: 'dynamic_tool';
      contentItems: Array<{ type: 'inputText'; text: string } | { type: 'inputImage'; imageUrl: string }>;
      success: boolean;
    });

export type CodexCommandApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'decline'
  | 'cancel'
  | {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] };
    };

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

export interface CodexRuntimeGenerationSnapshot {
  generationId: string;
  commandPath: string;
  state: CodexTransportState['type'];
  active: boolean;
  activeThreadCount: number;
  pendingRequestCount: number;
}

export type CodexRemoteControlConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'errored';

export interface CodexRemoteControlStatus {
  status: CodexRemoteControlConnectionStatus;
  serverName: string;
  installationId: string;
  environmentId: string | null;
}

export interface CodexRemoteControlPairing {
  pairingCode: string;
  manualPairingCode: string | null;
  environmentId: string;
  expiresAt: number;
}

export interface CodexRemoteControlClient {
  clientId: string;
  displayName: string | null;
  deviceType: string | null;
  platform: string | null;
  osVersion: string | null;
  deviceModel: string | null;
  appVersion: string | null;
  lastSeenAt: number | null;
}

export interface CodexRemoteControlClientsPage {
  data: CodexRemoteControlClient[];
  nextCursor: string | null;
}

export interface CodexAppServerManager {
  ensureReady(input: { commandPath: string; externalAgentHome?: string; remoteControl?: boolean }): Promise<CodexCapabilitiesSnapshot>;
  startThread(input: CodexThreadStartInput): Promise<CodexThreadSnapshot>;
  resumeThread(input: { threadId: string; cwd?: string }): Promise<CodexThreadSnapshot>;

  unarchiveThread(input: { threadId: string }): Promise<CodexThreadSnapshot>;
  readThread(input: { threadId: string }): Promise<CodexThreadSnapshot>;
  startTurn(input: CodexTurnStartInput): Promise<CodexTurnSnapshot>;
  steerTurn(input: CodexTurnSteerInput): Promise<{ turnId: string }>;
  interruptTurn(input: { threadId: string; turnId: string }): Promise<void>;
  respondToServerRequest(input: CodexServerRequestResponse): Promise<void>;
  readRemoteControlStatus(): Promise<CodexRemoteControlStatus>;
  enableRemoteControl(input?: { ephemeral?: boolean }): Promise<CodexRemoteControlStatus>;
  disableRemoteControl(input?: { ephemeral?: boolean }): Promise<CodexRemoteControlStatus>;
  startRemoteControlPairing(input?: { manualCode?: boolean }): Promise<CodexRemoteControlPairing>;
  readRemoteControlPairingStatus(input: { pairingCode?: string | null; manualPairingCode?: string | null }): Promise<{ claimed: boolean }>;
  listRemoteControlClients(input: { environmentId: string; cursor?: string | null; limit?: number | null; order?: 'asc' | 'desc' | null }): Promise<CodexRemoteControlClientsPage>;
  revokeRemoteControlClient(input: { environmentId: string; clientId: string }): Promise<void>;
  detectExternalAgentConfig(input?: ExternalAgentConfigDetectParams): Promise<ExternalAgentConfigDetectResponse>;
  startExternalAgentImport(input: ExternalAgentConfigImportParams): Promise<ExternalAgentConfigImportResponse>;
  readExternalAgentImportHistories(): Promise<ExternalAgentConfigImportHistory[]>;
  subscribeExternalAgentImport(listener: (event: ExternalAgentImportEvent) => void): () => void;
  subscribe(listener: (event: CodexAppServerEvent) => void): () => void;
  getState(): CodexTransportState;
  hasGeneration(generationId: string): boolean;
  generationForThread(threadId: string): string | null;
  listRuntimeGenerations(): CodexRuntimeGenerationSnapshot[];
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
  let remoteControlTransport = false;
  let readyPromise: Promise<CodexCapabilitiesSnapshot> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectScheduledRestart: ((error: Error) => void) | null = null;
  let restartAttempt = 0;
  let requestSequence = 0;
  let eventSequence = 0;
  let diagnosticSequence = 0;
  let remoteControlEnabled = false;
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
    const env = {
      ...process.env,
      PATH: expandCliSearchPath(),
      ...(externalAgentHome === null ? {} : { ZEUS_CODEX_EXTERNAL_AGENT_HOME: externalAgentHome }),
    };
    const spawned = remoteControlTransport
      ? spawnRemoteControlCodexAppServer(command, { env })
      : spawn(command, ['app-server', ...(options.appServerFlags ?? []), '--listen', 'stdio://'], { env });
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
      if (remoteControlEnabled || remoteControlTransport) await rpc(generationId, 'remoteControl/enable', {});
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
      throw managerError(
        'ZEUS_CODEX_DEPENDENCY_UNAVAILABLE',
        `用户本机 Codex CLI 无法启动兼容的 app-server（${command}）：${failure.message}。请运行官方安装命令 curl -fsSL https://chatgpt.com/codex/install.sh | sh，完成登录后在 Zeus 设置中重新检测；Zeus 不会自动安装或使用内置回退。`,
      );
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
    if (message.method === 'serverRequest/resolved') {
      const params = isRecord(message.params) ? message.params : {};
      const resolvedRequestId = typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : null;
      if (resolvedRequestId !== null) serverRequests.delete(serverRequestKey(generationId, resolvedRequestId));
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
      const requestedRemoteControlTransport = input.remoteControl === true;
      if (commandPath !== null && remoteControlTransport !== requestedRemoteControlTransport) {
        return Promise.reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_TRANSPORT_CHANGED', 'Codex remote-control transport cannot change while the manager is active.'));
      }
      commandPath = input.commandPath;
      externalAgentHome = requestedExternalAgentHome;
      remoteControlTransport = requestedRemoteControlTransport;
      if (remoteControlTransport) remoteControlEnabled = true;
      if (state.type === 'ready') return Promise.resolve(state.capabilities);
      if (readyPromise) return readyPromise;
      readyPromise = start(input.commandPath);
      void readyPromise.catch(() => undefined);
      return readyPromise;
    },
    async startThread(input) {
      const capabilities = await awaitCapabilities();
      const model = requireModel(capabilities, input.model);
      validateServiceTier(model, input.serviceTier);
      if (input.config !== undefined) throw managerError('ZEUS_CODEX_CONFIG_UNAVAILABLE', 'Raw Codex thread config overrides are not supported.');
      const sandbox = normalizeThreadSandbox(input.sandbox);
      const response = asRecord(
        await rpc(
          capabilities.generationId,
          'thread/start',
          compactObject({
            model: input.model,
            serviceTier: input.serviceTier,
            cwd: input.cwd,
            approvalPolicy: input.approvalPolicy,
            approvalsReviewer: input.approvalsReviewer,
            sandbox: sandbox.mode,
            runtimeWorkspaceRoots: sandbox.runtimeWorkspaceRoots,
            baseInstructions: input.baseInstructions,
            developerInstructions: input.developerInstructions,
            ephemeral: input.ephemeral,
            dynamicTools: input.dynamicTools,
          }),
        ),
      );
      const thread = parseThread(response.thread);
      const responseModel = typeof response.model === 'string' ? response.model : input.model;
      threadModels.set(thread.id, responseModel);
      return attachThreadProviderSettings(thread, capabilities.generationId, response, responseModel);
    },
    async resumeThread(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await rpc(capabilities.generationId, 'thread/resume', compactObject({ threadId: input.threadId, cwd: input.cwd })));
      const thread = parseThread(response.thread);
      const responseModel = typeof response.model === 'string' ? response.model : threadModels.get(thread.id);
      if (responseModel) threadModels.set(thread.id, responseModel);
      return responseModel ? attachThreadProviderSettings(thread, capabilities.generationId, response, responseModel) : thread;
    },
    async unarchiveThread(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await rpc(capabilities.generationId, 'thread/unarchive', { threadId: input.threadId }));
      return parseThread(response.thread);
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
      if (input.serviceTier !== undefined) {
        if (!model) throw managerError('ZEUS_CODEX_MODEL_UNAVAILABLE', 'Codex service tier validation requires a known model.');
        validateServiceTier(model, input.serviceTier);
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
            serviceTier: input.serviceTier,
            summary: input.summary,
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
        case 'dynamic_tool':
          result = { contentItems: input.contentItems, success: input.success };
          break;
      }
      write({ id: input.requestId, result });
      request.state = 'responded';
    },
    async readRemoteControlStatus() {
      const capabilities = await awaitCapabilities();
      return parseRemoteControlStatus(await rpc(capabilities.generationId, 'remoteControl/status/read', undefined));
    },
    async enableRemoteControl(input = {}) {
      const capabilities = await awaitCapabilities();
      const status = parseRemoteControlStatus(await rpc(capabilities.generationId, 'remoteControl/enable', compactObject({ ephemeral: input.ephemeral })));
      remoteControlEnabled = true;
      return status;
    },
    async disableRemoteControl(input = {}) {
      const capabilities = await awaitCapabilities();
      const status = parseRemoteControlStatus(await rpc(capabilities.generationId, 'remoteControl/disable', compactObject({ ephemeral: input.ephemeral })));
      remoteControlEnabled = false;
      return status;
    },
    async startRemoteControlPairing(input = {}) {
      const capabilities = await awaitCapabilities();
      return parseRemoteControlPairing(await rpc(capabilities.generationId, 'remoteControl/pairing/start', compactObject({ manualCode: input.manualCode })));
    },
    async readRemoteControlPairingStatus(input) {
      const capabilities = await awaitCapabilities();
      const response = asRecord(await rpc(capabilities.generationId, 'remoteControl/pairing/status', compactObject(input)));
      if (typeof response.claimed !== 'boolean') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote pairing status omitted claimed.');
      return { claimed: response.claimed };
    },
    async listRemoteControlClients(input) {
      const capabilities = await awaitCapabilities();
      return parseRemoteControlClients(await rpc(capabilities.generationId, 'remoteControl/client/list', compactObject(input)));
    },
    async revokeRemoteControlClient(input) {
      const capabilities = await awaitCapabilities();
      await rpc(capabilities.generationId, 'remoteControl/client/revoke', input);
    },
    async detectExternalAgentConfig(input = {}) {
      const capabilities = await awaitCapabilities();
      return parseExternalAgentConfigDetectResponse(
        await rpc(
          capabilities.generationId,
          'externalAgentConfig/detect',
          compactObject({
            includeHome: input.includeHome,
            cwds: input.cwds,
            source: input.source,
            migrationSource: input.migrationSource,
          }),
        ),
      );
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
    hasGeneration(generationId) {
      return state.type !== 'idle' && state.type !== 'closed' && state.generationId === generationId;
    },
    generationForThread() {
      return state.type === 'idle' || state.type === 'closed' ? null : state.generationId;
    },
    listRuntimeGenerations() {
      if (state.type === 'idle' || state.type === 'closed' || commandPath === null) return [];
      return [
        {
          generationId: state.generationId,
          commandPath,
          state: state.type,
          active: true,
          activeThreadCount: 0,
          pendingRequestCount: serverRequests.size,
        },
      ];
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

/**
 * 连接官方 Remote Control 守护进程，并把 WebSocket 文本帧适配为现有 JSONL 传输。
 * 守护进程由官方 CLI 管理；Zeus 退出只断开自己的控制连接，不擅自停止用户已启用的远程宿主。
 */
function spawnRemoteControlCodexAppServer(command: string, options: CodexAppServerSpawnOptions): CodexAppServerProcess {
  const stdout = new EventEmitter() as CodexAppServerReadable;
  const stderr = new EventEmitter() as CodexAppServerReadable;
  const lifecycle = new EventEmitter();
  const pendingMessages: string[] = [];
  let inputBuffer = '';
  let socket: WebSocket | null = null;
  let stopping = false;
  let exited = false;

  function finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (exited) return;
    exited = true;
    lifecycle.emit('exit', code, signal);
  }

  function fail(error: Error): void {
    if (stopping || exited) return;
    (stderr as EventEmitter).emit('data', error.message);
    lifecycle.emit('error', error);
    finishExit(1, null);
  }

  function sendMessage(message: string): void {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(message);
      return;
    }
    pendingMessages.push(message);
  }

  const processAdapter: CodexAppServerProcess = {
    // 该值只用于区分“尚未生成系统进程”的 spawn 失败；真实守护进程 PID 由官方 CLI 管理。
    pid: process.pid,
    stdin: {
      write(chunk) {
        inputBuffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        const lines = inputBuffer.split('\n');
        inputBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) sendMessage(line);
        }
        return true;
      },
    },
    stdout,
    stderr,
    on(event, listener) {
      lifecycle.on(event, listener);
      return this;
    },
    kill(signal = 'SIGTERM') {
      if (stopping || exited) return false;
      stopping = true;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close(1000, 'Zeus transport closed');
        const forceClose = setTimeout(() => socket?.terminate(), 500);
        forceClose.unref();
      } else {
        socket?.terminate();
        finishExit(null, signal);
      }
      return true;
    },
  };

  void (async () => {
    const daemon = await startRemoteControlDaemon(command, options.env, (chunk) => (stderr as EventEmitter).emit('data', chunk));
    if (stopping || exited) return;
    socket = new WebSocket('ws://localhost/rpc', {
      createConnection: () => createConnection({ path: daemon.socketPath }),
      perMessageDeflate: false,
    });
    socket.on('open', () => {
      for (const message of pendingMessages.splice(0)) socket?.send(message);
    });
    socket.on('message', (data: RawData) => {
      const text = rawWebSocketText(data);
      if (text !== null) (stdout as EventEmitter).emit('data', Buffer.from(`${text}\n`, 'utf8'));
    });
    socket.on('error', (error) => fail(error instanceof Error ? error : new Error('Codex Remote Control WebSocket failed.')));
    socket.on('close', () => finishExit(stopping ? null : 1, stopping ? 'SIGTERM' : null));
  })().catch((error: unknown) => fail(asError(error)));

  return processAdapter;
}

async function startRemoteControlDaemon(command: string, env: NodeJS.ProcessEnv, onStderr: (chunk: Buffer | string) => void): Promise<{ socketPath: string }> {
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(command, ['remote-control', 'start', '--json'], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_START_TIMEOUT', 'Codex Remote Control 守护进程启动超时。'));
    }, 30_000);
    timeout.unref();
    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += toBuffer(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += toBuffer(chunk).toString('utf8');
      onStderr(chunk);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(
          managerError(
            'ZEUS_CODEX_REMOTE_CONTROL_START_FAILED',
            `官方 Codex Remote Control 守护进程启动失败（${String(code ?? signal ?? 'unknown')}）：${stderr.trim() || '没有返回诊断信息'}。请确认 Zeus 使用官方独立安装版 Codex CLI。`,
          ),
        );
        return;
      }
      try {
        const result = parseLastJsonObject(stdout);
        const daemon = asRecord(result.daemon);
        const socketPath = typeof daemon.socketPath === 'string' ? daemon.socketPath : null;
        if (!socketPath || !isAbsolute(socketPath)) throw new Error('启动结果没有返回绝对控制套接字路径。');
        resolve({ socketPath });
      } catch (error) {
        reject(managerError('ZEUS_CODEX_REMOTE_CONTROL_START_INVALID', `无法读取 Codex Remote Control 启动结果：${asError(error).message}`));
      }
    });
  });
}

function rawWebSocketText(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return null;
}

function parseLastJsonObject(value: string): Record<string, unknown> {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return asRecord(JSON.parse(lines[index]!));
    } catch {
      // 官方 CLI 可能在 JSON 前输出升级提示，只取最后一个有效 JSON 对象。
    }
  }
  throw new Error('Codex CLI 没有返回 JSON 启动结果。');
}

function parseModels(value: unknown): CodexModelCapability[] {
  const response = asRecord(value);
  if (!Array.isArray(response.data)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list response omitted data.');
  return response.data.map((entry) => {
    const model = asRecord(entry);
    if (typeof model.id !== 'string' || typeof model.model !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned an invalid model.');
    const effortEntries = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [];
    const supportedReasoningEfforts = effortEntries.map((effort) => (isRecord(effort) && typeof effort.reasoningEffort === 'string' ? effort.reasoningEffort : null)).filter((effort): effort is string => effort !== null);
    const serviceTierEntries = model.serviceTiers === undefined ? [] : model.serviceTiers;
    if (!Array.isArray(serviceTierEntries)) throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned invalid service tiers.');
    const serviceTiers = serviceTierEntries.map((entry) => {
      if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id || typeof entry.name !== 'string' || !entry.name || typeof entry.description !== 'string') {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex model/list returned an invalid service tier.');
      }
      return { id: entry.id, name: entry.name, description: entry.description };
    });
    return {
      id: model.id,
      model: model.model,
      ...(typeof model.displayName === 'string' ? { displayName: model.displayName } : {}),
      supportedReasoningEfforts,
      ...(typeof model.defaultReasoningEffort === 'string' ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
      serviceTiers,
      ...(typeof model.defaultServiceTier === 'string' || model.defaultServiceTier === null ? { defaultServiceTier: model.defaultServiceTier } : {}),
      raw: model,
    };
  });
}

function validateServiceTier(model: CodexModelCapability, serviceTier: string | null | undefined): void {
  if (serviceTier === undefined || serviceTier === null) return;
  if (model.serviceTiers.some((tier) => tier.id === serviceTier)) return;
  throw Object.assign(new Error(`Configured Codex service tier is unavailable: ${serviceTier}`), {
    code: 'ZEUS_CODEX_SERVICE_TIER_UNAVAILABLE',
    supportedServiceTiers: model.serviceTiers.map((tier) => tier.id),
  });
}

function attachThreadProviderSettings(thread: CodexThreadSnapshot, generationId: string, response: Record<string, unknown>, model: string): CodexThreadSnapshot {
  const effort = typeof response.effort === 'string' ? response.effort : typeof response.reasoningEffort === 'string' ? response.reasoningEffort : undefined;
  const hasServiceTier = Object.prototype.hasOwnProperty.call(response, 'serviceTier');
  const serviceTier = typeof response.serviceTier === 'string' || response.serviceTier === null ? response.serviceTier : undefined;
  return {
    ...thread,
    providerSettings: {
      generationId,
      sequence: 0,
      model,
      ...(effort ? { effort } : {}),
      ...(hasServiceTier && serviceTier !== undefined ? { serviceTier } : {}),
    },
  };
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

function parseRemoteControlStatus(value: unknown): CodexRemoteControlStatus {
  const response = asRecord(value);
  if (!['disabled', 'connecting', 'connected', 'errored'].includes(String(response.status))) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid status.');
  }
  if (typeof response.serverName !== 'string' || typeof response.installationId !== 'string' || (response.environmentId !== null && typeof response.environmentId !== 'string')) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid identity.');
  }
  return {
    status: response.status as CodexRemoteControlConnectionStatus,
    serverName: response.serverName,
    installationId: response.installationId,
    environmentId: response.environmentId,
  };
}

function parseRemoteControlPairing(value: unknown): CodexRemoteControlPairing {
  const response = asRecord(value);
  if (
    typeof response.pairingCode !== 'string' ||
    (response.manualPairingCode !== null && typeof response.manualPairingCode !== 'string') ||
    typeof response.environmentId !== 'string' ||
    typeof response.expiresAt !== 'number' ||
    !Number.isSafeInteger(response.expiresAt)
  ) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned invalid pairing data.');
  }
  return {
    pairingCode: response.pairingCode,
    manualPairingCode: response.manualPairingCode,
    environmentId: response.environmentId,
    expiresAt: response.expiresAt,
  };
}

function parseRemoteControlClients(value: unknown): CodexRemoteControlClientsPage {
  const response = asRecord(value);
  if (!Array.isArray(response.data) || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) {
    throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid client list.');
  }
  return {
    data: response.data.map((value) => {
      const client = asRecord(value);
      if (typeof client.clientId !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid client.');
      for (const key of ['displayName', 'deviceType', 'platform', 'osVersion', 'deviceModel', 'appVersion'] as const) {
        if (client[key] !== null && typeof client[key] !== 'string') throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned invalid client metadata.');
      }
      if (client.lastSeenAt !== null && (typeof client.lastSeenAt !== 'number' || !Number.isSafeInteger(client.lastSeenAt))) {
        throw managerError('ZEUS_CODEX_INVALID_RESPONSE', 'Codex remote control returned an invalid client timestamp.');
      }
      return {
        clientId: client.clientId,
        displayName: client.displayName as string | null,
        deviceType: client.deviceType as string | null,
        platform: client.platform as string | null,
        osVersion: client.osVersion as string | null,
        deviceModel: client.deviceModel as string | null,
        appVersion: client.appVersion as string | null,
        lastSeenAt: client.lastSeenAt,
      };
    }),
    nextCursor: response.nextCursor,
  };
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
  if (input.type === 'command') {
    if (!isCommandApprovalDecision(input.decision)) throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex command approval decision is invalid.');
    return;
  }
  if (input.type === 'file') {
    if (!['accept', 'acceptForSession', 'decline', 'cancel'].includes(input.decision)) throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex file approval decision is invalid.');
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
  if (input.type === 'dynamic_tool') {
    if (
      typeof input.success !== 'boolean' ||
      !Array.isArray(input.contentItems) ||
      !input.contentItems.every((item) => (item.type === 'inputText' && typeof item.text === 'string') || (item.type === 'inputImage' && typeof item.imageUrl === 'string' && item.imageUrl.startsWith('data:image/')))
    ) {
      throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex dynamic tool response is invalid.');
    }
    return;
  }
  if (!['accept', 'decline', 'cancel'].includes(input.action) || !isJsonValue(input.content) || !isJsonValue(input._meta)) {
    throw managerError('ZEUS_CODEX_SERVER_RESPONSE_INVALID', 'Codex MCP response is invalid.');
  }
}

function isCommandApprovalDecision(value: unknown): value is CodexCommandApprovalDecision {
  if (typeof value === 'string') return ['accept', 'acceptForSession', 'decline', 'cancel'].includes(value);
  if (!isRecord(value) || !hasOnlyKeys(value, ['acceptWithExecpolicyAmendment'])) return false;
  const amendment = value.acceptWithExecpolicyAmendment;
  return (
    isRecord(amendment) &&
    hasOnlyKeys(amendment, ['execpolicy_amendment']) &&
    Array.isArray(amendment.execpolicy_amendment) &&
    amendment.execpolicy_amendment.length > 0 &&
    amendment.execpolicy_amendment.every((entry) => typeof entry === 'string' && entry.length > 0)
  );
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
    dynamic_tool: 'item/tool/call',
  }[type];
}

const supportedServerRequestMethods = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'item/tool/requestUserInput',
  'mcpServer/elicitation/request',
  'item/tool/call',
]);

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
