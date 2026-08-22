import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizePerformanceTraceIdentity } from '@zeus/shared';
import type {
  AcceptedAgentRun,
  AgentDescriptor,
  AgentRuntimeEvent,
  AgentRuntimeFailureKind,
  AgentRuntimeFailureSnapshot,
  AgentRuntimeHealthSnapshot,
  AgentRuntimeProbe,
  AgentSessionIdentity,
  AgentSessionSnapshot,
  CompactAgentSessionInput,
  CompactAgentSessionResult,
  FollowUpAgentRunInput,
  InterruptAgentRunInput,
  OpenAgentSessionInput,
  ReadAgentSessionInput,
  RespondAgentInteractionInput,
  ResumeAgentSessionInput,
  StartAgentRunInput,
  SteerAgentRunInput,
  SupervisedAgentRuntimeDriver,
} from './agentRuntimeContracts.js';
import type { PiRuntimeConnection, PiZeusToolBroker, PiZeusToolRequest } from './piSdkRuntimeDriver.js';
import {
  isPiRuntimeWorkerToCoreMessage,
  piRuntimeWorkerError,
  piRuntimeWorkerProtocolVersion,
  sanitizePiRuntimeWorkerDiagnostic,
  serializePiRuntimeWorkerError,
  type PiRuntimeWorkerMethod,
  type PiRuntimeWorkerResponse,
  type PiRuntimeWorkerReverseRequest,
} from './piRuntimeWorkerProtocol.js';

export interface CreatePiRuntimeWorkerDriverOptions {
  adapterVersion: string;
  agentDirectory: string;
  sessionDirectory: string;
  loadConnections: () => Promise<PiRuntimeConnection[]>;
  toolBroker: PiZeusToolBroker;
  now?: () => string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  onDiagnostic?: (entry: { generationId: string; sequence: number; stderrSummary: string }) => void;
}

export interface PiRuntimeWorkerDriver extends SupervisedAgentRuntimeDriver {
  readonly kind: 'pi';
  invalidateModelRuntime(): Promise<void>;
}

interface PendingWorkerRequest {
  method: PiRuntimeWorkerMethod;
  effectful: boolean;
  traceIdentity: string | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

interface RunCallbacks {
  commandRequestId: string;
  traceIdentity: string | null;
  callbacks: Pick<StartAgentRunInput, 'preflightResult' | 'durableTransactionSync' | 'providerWriteMayStart' | 'providerPayloadObserved'>;
}

interface SessionBinding {
  identity: AgentSessionIdentity;
  cwd: string | null;
}

interface ActiveRunBinding {
  nativeRunId: string;
  session: AgentSessionIdentity;
  callbackToken: string;
}

interface PendingHello {
  generationId: string;
  resolve(): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
}

const effectfulMethods = new Set<PiRuntimeWorkerMethod>(['openSession', 'resumeSession', 'startRun', 'steerRun', 'followUp', 'compactSession', 'interruptRun', 'respondToInteraction']);

/**
 * Core 侧 Pi Runtime Adapter。构造本身不启动进程；只有显式探测、恢复或真实运行调用才创建 Worker。
 */
export function createPiRuntimeWorkerDriver(options: CreatePiRuntimeWorkerDriverOptions): PiRuntimeWorkerDriver {
  const now = options.now ?? (() => new Date().toISOString());
  const startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 5_000;
  const listeners = new Set<(event: AgentRuntimeEvent) => void>();
  const pendingRequests = new Map<string, PendingWorkerRequest>();
  const runCallbacks = new Map<string, RunCallbacks>();
  const sessions = new Map<string, SessionBinding>();
  const activeRuns = new Map<string, ActiveRunBinding>();
  const reverseControllers = new Map<string, AbortController>();
  const knownCredentialValues = new Set<string>();
  let child: ChildProcess | null = null;
  let pendingHello: PendingHello | null = null;
  let startPromise: Promise<void> | null = null;
  let generationId: string | null = null;
  let lifecycle: AgentRuntimeHealthSnapshot['lifecycle'] = 'stopped';
  let circuitState: AgentRuntimeHealthSnapshot['circuit']['state'] = 'closed';
  let circuitOpenedAt: string | null = null;
  let circuitReason: AgentRuntimeFailureKind | null = null;
  let lastFailure: AgentRuntimeFailureSnapshot | null = null;
  let consecutiveFailures = 0;
  let requestSequence = 0;
  let diagnosticSequence = 0;
  let closing = false;
  let expectedExit = false;

  function health(): AgentRuntimeHealthSnapshot {
    return {
      agentKind: 'pi',
      transport: 'rpc',
      generationId,
      lifecycle,
      protocolVersion: generationId ? piRuntimeWorkerProtocolVersion : null,
      processId: child?.pid ?? null,
      checkedAt: now(),
      consecutiveFailures,
      circuit: { state: circuitState, openedAt: circuitOpenedAt, reason: circuitReason, recovery: 'explicit' },
      lastFailure: lastFailure ? { ...lastFailure } : null,
    };
  }

  async function ensureReady(allowRecovery: boolean): Promise<void> {
    if (closing) throw driverError('ZEUS_PI_WORKER_CLOSED', 'Pi Worker 驱动正在关闭。');
    if (child?.connected && (lifecycle === 'healthy' || lifecycle === 'degraded') && circuitState === 'closed') return;
    if (startPromise) return startPromise;
    if (circuitState === 'open' && !allowRecovery) throw circuitOpenError();
    startPromise = startWorker(allowRecovery)
      .catch(async (error: unknown) => {
        if (circuitState !== 'open') openCircuit(failure('startup', 'ZEUS_PI_WORKER_START_FAILED', error instanceof Error ? error.message : 'Pi Worker 启动失败。', false));
        await terminateWorker(false);
        throw error;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  async function startWorker(recovering: boolean): Promise<void> {
    const nextGeneration = `pi_worker_${randomUUID()}`;
    generationId = nextGeneration;
    lifecycle = recovering ? 'recovering' : 'starting';
    circuitState = recovering ? 'half_open' : 'closed';
    expectedExit = false;
    requestSequence = 0;
    diagnosticSequence = 0;
    const workerPath = fileURLToPath(new URL('./piSdkRuntimeWorker.js', import.meta.url));
    const spawned = fork(workerPath, [], {
      env: workerEnvironment(nextGeneration),
      execArgv: [],
      serialization: 'json',
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    child = spawned;
    spawned.stderr?.on('data', (chunk: Buffer | string) => {
      const stderrSummary = sanitizeDiagnostic(typeof chunk === 'string' ? chunk : chunk.toString('utf8'), knownCredentialValues);
      if (stderrSummary) options.onDiagnostic?.({ generationId: nextGeneration, sequence: ++diagnosticSequence, stderrSummary });
    });
    spawned.on('message', (message: unknown) => handleWorkerMessage(spawned, nextGeneration, message));
    spawned.once('error', (error) => {
      if (spawned.pid === undefined) handleWorkerExit(spawned, nextGeneration, failure('startup', 'ZEUS_PI_WORKER_START_FAILED', error instanceof Error ? error.message : 'Pi Worker 无法启动。', false));
    });
    spawned.once('exit', (code, signal) => {
      handleWorkerExit(spawned, nextGeneration, failure('process_exit', 'ZEUS_PI_WORKER_EXITED', `Pi Worker 已退出（${String(code ?? signal ?? 'unknown')}）。`, activeRuns.size > 0));
    });
    await waitForHello(nextGeneration);
    await requestCurrentGeneration('initialize', { adapterVersion: options.adapterVersion, agentDirectory: options.agentDirectory, sessionDirectory: options.sessionDirectory }, { timeoutMs: startupTimeoutMs, effectful: false });
    if (child !== spawned || generationId !== nextGeneration) throw driverError('ZEUS_PI_WORKER_STALE_GENERATION', 'Pi Worker 在初始化期间更换了运行代次。');
    lifecycle = 'healthy';
    circuitState = 'closed';
    circuitOpenedAt = null;
    circuitReason = null;
    consecutiveFailures = 0;
  }

  function waitForHello(expectedGenerationId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingHello?.generationId === expectedGenerationId) pendingHello = null;
        const timeoutFailure = failure('startup', 'ZEUS_PI_WORKER_START_TIMEOUT', 'Pi Worker 未在启动时限内完成协议握手。', false);
        openCircuit(timeoutFailure);
        void terminateWorker(false);
        reject(snapshotError(timeoutFailure));
      }, startupTimeoutMs);
      timeout.unref();
      pendingHello = { generationId: expectedGenerationId, resolve, reject, timeout };
    });
  }

  function clearPendingHello(error?: Error): void {
    const current = pendingHello;
    if (!current) return;
    clearTimeout(current.timeout);
    pendingHello = null;
    if (error) current.reject(error);
  }

  function handleWorkerMessage(source: ChildProcess, sourceGeneration: string, raw: unknown): void {
    if (source !== child || sourceGeneration !== generationId) return;
    const rawRecord = asRecord(raw);
    if (rawRecord.protocolVersion !== piRuntimeWorkerProtocolVersion) {
      const protocolFailure = failure('protocol_incompatible', 'ZEUS_PI_WORKER_PROTOCOL_INCOMPATIBLE', 'Pi Worker 协议版本不兼容。', false);
      clearPendingHello(snapshotError(protocolFailure));
      openCircuit(protocolFailure);
      void terminateWorker(false);
      return;
    }
    if (!isPiRuntimeWorkerToCoreMessage(raw) || raw.generationId !== sourceGeneration) {
      const protocolFailure = failure('protocol_incompatible', 'ZEUS_PI_WORKER_PROTOCOL_INVALID', 'Pi Worker 返回了不兼容的协议帧。', false);
      openCircuit(protocolFailure);
      void terminateWorker(false);
      return;
    }
    if (raw.kind === 'hello') {
      if (!pendingHello || pendingHello.generationId !== raw.generationId || raw.pid !== source.pid) {
        const protocolFailure = failure('protocol_incompatible', 'ZEUS_PI_WORKER_HELLO_INVALID', 'Pi Worker 握手身份不一致。', false);
        openCircuit(protocolFailure);
        void terminateWorker(false);
        return;
      }
      const hello = pendingHello;
      clearPendingHello();
      hello.resolve();
      return;
    }
    if (raw.kind === 'response') {
      settleWorkerResponse(raw);
      return;
    }
    if (raw.kind === 'event') {
      handleRuntimeEvent(raw.event);
      return;
    }
    if (raw.kind === 'reverse_cancel') {
      reverseControllers.get(raw.id)?.abort();
      reverseControllers.delete(raw.id);
      return;
    }
    void handleReverseRequest(raw);
  }

  function settleWorkerResponse(response: PiRuntimeWorkerResponse): void {
    const pending = pendingRequests.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(response.id);
    if ((response.traceIdentity ?? null) !== pending.traceIdentity) {
      pending.reject(driverError('ZEUS_PI_WORKER_TRACE_IDENTITY_MISMATCH', 'Pi Worker 回执的性能 trace identity 与请求不一致。'));
      return;
    }
    if (response.ok) {
      pending.resolve(response.value);
      return;
    }
    const error = piRuntimeWorkerError(response.error!);
    const classified = classifyOperationFailure(error, false);
    if (shouldOpenCircuit(classified)) openCircuit(classified);
    else if (lifecycle === 'healthy') {
      lifecycle = 'degraded';
      lastFailure = classified;
    }
    pending.reject(error);
  }

  async function handleReverseRequest(request: PiRuntimeWorkerReverseRequest): Promise<void> {
    try {
      let value: unknown;
      if (request.method === 'load_connections') {
        const connections = await options.loadConnections();
        rememberCredentialValues(connections, knownCredentialValues);
        value = connections;
      } else if (request.method === 'tool_execute') value = await executeReverseTool(request);
      else if (request.method === 'tool_respond') value = await options.toolBroker.respond?.(request.payload as RespondAgentInteractionInput);
      else if (request.method === 'run_acceptance') value = await acceptRun(request);
      else if (request.method === 'run_rejected') value = rejectRun(request);
      else if (request.method === 'provider_payload_observed') value = observeProviderPayload(request);
      sendToWorker({ kind: 'reverse_response', protocolVersion: piRuntimeWorkerProtocolVersion, generationId: request.generationId, traceIdentity: request.traceIdentity ?? null, id: request.id, ok: true, value });
    } catch (error) {
      try {
        sendToWorker({ kind: 'reverse_response', protocolVersion: piRuntimeWorkerProtocolVersion, generationId: request.generationId, traceIdentity: request.traceIdentity ?? null, id: request.id, ok: false, error: serializePiRuntimeWorkerError(error) });
      } catch {
        // Worker 已退出时只由进程退出路径收口 pending/unknown，不再制造第二个未处理异常。
      }
    } finally {
      reverseControllers.delete(request.id);
    }
  }

  async function executeReverseTool(request: PiRuntimeWorkerReverseRequest) {
    const controller = new AbortController();
    reverseControllers.set(request.id, controller);
    const input = request.payload as Omit<PiZeusToolRequest, 'signal'>;
    return options.toolBroker.execute({ ...input, signal: controller.signal });
  }

  async function acceptRun(request: PiRuntimeWorkerReverseRequest): Promise<void> {
    const payload = asRecord(request.payload);
    const callbackToken = requiredString(payload.callbackToken, 'callbackToken');
    const commandRequestId = requiredString(payload.commandRequestId, 'commandRequestId');
    const callbacks = runCallbacks.get(callbackToken);
    const pending = pendingRequests.get(commandRequestId);
    if (!callbacks || callbacks.commandRequestId !== commandRequestId || !pending || pending.method !== 'startRun') {
      throw driverError('ZEUS_PI_WORKER_ACCEPTANCE_IDENTITY_MISMATCH', 'Pi Worker 接纳回执与当前提交不匹配。');
    }
    if ((request.traceIdentity ?? null) !== callbacks.traceIdentity || pending.traceIdentity !== callbacks.traceIdentity) {
      throw driverError('ZEUS_PI_WORKER_TRACE_IDENTITY_MISMATCH', 'Pi Worker 接纳回执的性能 trace identity 与提交不一致。');
    }
    const acceptance = readAcceptance(payload.acceptance);
    callbacks.callbacks.preflightResult?.(true);
    callbacks.callbacks.durableTransactionSync?.(acceptance);
    callbacks.callbacks.providerWriteMayStart?.();
    activeRuns.set(acceptance.nativeRunId, {
      nativeRunId: acceptance.nativeRunId,
      session: normalizeSessionForGeneration(payload.session as AgentSessionIdentity),
      callbackToken,
    });
    clearTimeout(pending.timeout);
    pendingRequests.delete(commandRequestId);
    pending.resolve(acceptance);
    // 让调用方先登记活动轮次，再允许 Worker 通过 Provider 传输门；不靠跨进程调度顺序碰运气。
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  function rejectRun(request: PiRuntimeWorkerReverseRequest): void {
    const payload = asRecord(request.payload);
    const callbackToken = requiredString(payload.callbackToken, 'callbackToken');
    const callbacks = runCallbacks.get(callbackToken);
    callbacks?.callbacks.preflightResult?.(false);
    runCallbacks.delete(callbackToken);
  }

  function observeProviderPayload(request: PiRuntimeWorkerReverseRequest): void {
    const payload = asRecord(request.payload);
    const callbackToken = requiredString(payload.callbackToken, 'callbackToken');
    runCallbacks.get(callbackToken)?.callbacks.providerPayloadObserved?.(payload.diagnostic as Parameters<NonNullable<StartAgentRunInput['providerPayloadObserved']>>[0]);
  }

  function handleRuntimeEvent(event: AgentRuntimeEvent): void {
    if (event.runtimeInstanceId !== generationId || event.agentKind !== 'pi') {
      const protocolFailure = failure('protocol_incompatible', 'ZEUS_PI_WORKER_EVENT_IDENTITY_INVALID', 'Pi Worker 事件运行身份不一致。', false);
      openCircuit(protocolFailure);
      void terminateWorker(false);
      return;
    }
    if (event.type === 'runtime_error') {
      const classified = classifyRuntimeEventFailure(event);
      lastFailure = classified;
      if (shouldOpenCircuit(classified)) openCircuit(classified);
      else if (circuitState === 'closed') lifecycle = 'degraded';
    } else if (event.type === 'agent_settled' && circuitState === 'closed') {
      lifecycle = 'healthy';
    }
    if (event.nativeRunId && (event.type === 'agent_settled' || event.type === 'runtime_error')) {
      const active = activeRuns.get(event.nativeRunId);
      if (active) runCallbacks.delete(active.callbackToken);
      activeRuns.delete(event.nativeRunId);
    }
    for (const listener of listeners) listener(event);
  }

  function request(method: PiRuntimeWorkerMethod, payload: unknown, timeoutMs = timeoutForMethod(method)): Promise<unknown> {
    return ensureReady(false).then(() => requestCurrentGeneration(method, payload, { timeoutMs, effectful: effectfulMethods.has(method), traceIdentity: traceIdentityFromPayload(payload) }));
  }

  function requestCurrentGeneration(method: PiRuntimeWorkerMethod, payload: unknown, input: { timeoutMs: number; effectful: boolean; traceIdentity?: string | null }): Promise<unknown> {
    if (!child?.connected || !generationId) return Promise.reject(driverError('ZEUS_PI_WORKER_UNAVAILABLE', 'Pi Worker 当前不可用。'));
    const id = `${generationId}:${++requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = pendingRequests.get(id);
        if (!pending) return;
        pendingRequests.delete(id);
        const timeoutFailure = failure('timeout', input.effectful ? 'ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN' : 'ZEUS_PI_WORKER_RPC_TIMEOUT', `Pi Worker 调用超时：${method}`, input.effectful);
        openCircuit(timeoutFailure);
        pending.reject(snapshotError(timeoutFailure));
        void terminateWorker(false);
      }, input.timeoutMs);
      timeout.unref();
      const traceIdentity = input.traceIdentity ?? null;
      pendingRequests.set(id, { method, effectful: input.effectful, traceIdentity, resolve, reject, timeout });
      try {
        sendToWorker({ kind: 'request', protocolVersion: piRuntimeWorkerProtocolVersion, generationId: generationId!, traceIdentity, id, method, payload });
      } catch (error) {
        clearTimeout(timeout);
        pendingRequests.delete(id);
        reject(error instanceof Error ? error : driverError('ZEUS_PI_WORKER_SEND_FAILED', 'Pi Worker IPC 写入失败。'));
      }
    });
  }

  function sendToWorker(message: Parameters<NonNullable<ChildProcess['send']>>[0]): void {
    if (!child?.connected || !child.send) throw driverError('ZEUS_PI_WORKER_UNAVAILABLE', 'Pi Worker IPC 已断开。');
    child.send(message);
  }

  function handleWorkerExit(source: ChildProcess, sourceGeneration: string, exitFailure: AgentRuntimeFailureSnapshot): void {
    if (source !== child || sourceGeneration !== generationId) return;
    child = null;
    clearPendingHello(snapshotError(exitFailure));
    if (expectedExit || closing) {
      lifecycle = closing ? 'closing' : 'stopped';
      return;
    }
    if (circuitState !== 'open') openCircuit(exitFailure);
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pendingRequests.delete(id);
      const requestFailure = pending.effectful ? failure('process_exit', 'ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN', `Pi Worker 在 ${pending.method} 结果确认前退出；Zeus 不会自动重发。`, true) : exitFailure;
      pending.reject(snapshotError(requestFailure));
    }
    for (const controller of reverseControllers.values()) controller.abort();
    reverseControllers.clear();
    const interrupted = [...activeRuns.values()];
    activeRuns.clear();
    setImmediate(() => {
      for (const active of interrupted) {
        const event: AgentRuntimeEvent = {
          agentKind: 'pi',
          runtimeInstanceId: sourceGeneration,
          nativeSessionId: active.session.nativeSessionId,
          nativeRunId: active.nativeRunId,
          sequence: Number.MAX_SAFE_INTEGER,
          type: 'runtime_error',
          payload: {
            code: 'ZEUS_PROVIDER_WORKER_RESULT_UNKNOWN',
            message: 'Pi Worker 在轮次终态确认前退出；可能已发生 Provider 或工具副作用，Zeus 不会自动重发。',
            resultUnknown: true,
            generationId: sourceGeneration,
          },
          createdAt: now(),
        };
        for (const listener of listeners) listener(event);
        runCallbacks.delete(active.callbackToken);
      }
    });
  }

  function openCircuit(snapshot: AgentRuntimeFailureSnapshot): void {
    lastFailure = snapshot;
    consecutiveFailures += 1;
    circuitState = 'open';
    circuitOpenedAt ??= snapshot.occurredAt;
    circuitReason = snapshot.kind;
    lifecycle = 'circuit_open';
  }

  async function terminateWorker(intentional: boolean): Promise<void> {
    const current = child;
    if (!current) return;
    if (intentional) expectedExit = true;
    const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
    current.kill('SIGTERM');
    if (await beforeTimeout(exited, shutdownTimeoutMs)) return;
    current.kill('SIGKILL');
    await exited;
  }

  async function recoverRuntime(): Promise<AgentRuntimeHealthSnapshot> {
    if (closing) throw driverError('ZEUS_PI_WORKER_CLOSED', 'Pi Worker 驱动正在关闭。');
    if (child && (activeRuns.size > 0 || pendingRequests.size > 0 || reverseControllers.size > 0 || startPromise !== null)) {
      throw driverError('ZEUS_PI_WORKER_RECOVERY_BUSY', 'Pi Worker 仍有活动轮次或未完成 RPC，不能切换运行代次。');
    }
    if (child) await terminateWorker(true);
    expectedExit = false;
    await ensureReady(true);
    await requestCurrentGeneration('recover', {}, { timeoutMs: 30_000, effectful: false });
    try {
      for (const binding of sessions.values()) {
        const path = binding.identity.nativeSessionPath;
        if (!path) throw driverError('ZEUS_PI_SESSION_PATH_REQUIRED', 'Pi Worker 恢复原生会话需要既有 session path；不会创建替代会话。');
        const resumed = (await requestCurrentGeneration(
          'resumeSession',
          { nativeSessionId: binding.identity.nativeSessionId, nativeSessionPath: path, ...(binding.cwd ? { cwd: binding.cwd } : {}) },
          { timeoutMs: 60_000, effectful: true },
        )) as AgentSessionIdentity;
        assertSameNativeIdentity(binding.identity, resumed);
        binding.identity = resumed;
      }
    } catch (error) {
      const identityFailure = failure('protocol_incompatible', readErrorCode(error) ?? 'ZEUS_PI_SESSION_RECOVERY_FAILED', error instanceof Error ? error.message : 'Pi Worker 原生身份恢复失败。', false);
      openCircuit(identityFailure);
      await terminateWorker(false);
      throw snapshotError(identityFailure);
    }
    lifecycle = 'healthy';
    circuitState = 'closed';
    circuitOpenedAt = null;
    circuitReason = null;
    consecutiveFailures = 0;
    return health();
  }

  function rememberSession(identity: AgentSessionIdentity, cwd: string | null): AgentSessionIdentity {
    if (identity.agentKind !== 'pi' || identity.runtimeInstanceId !== generationId) throw driverError('ZEUS_PI_WORKER_SESSION_IDENTITY_INVALID', 'Pi Worker 返回了不属于当前运行代次的会话身份。');
    sessions.set(identity.nativeSessionId, { identity, cwd });
    return identity;
  }

  function normalizeSessionForGeneration(identity: AgentSessionIdentity): AgentSessionIdentity {
    const binding = sessions.get(identity.nativeSessionId);
    return binding?.identity ?? identity;
  }

  function withCurrentSession<T extends { session: AgentSessionIdentity }>(input: T): T {
    return { ...input, session: normalizeSessionForGeneration(input.session) };
  }

  const api: PiRuntimeWorkerDriver = {
    kind: 'pi',
    async probe(): Promise<AgentRuntimeProbe> {
      const probe = (await request('probe', {})) as AgentRuntimeProbe;
      return { ...probe, protocolVersion: piRuntimeWorkerProtocolVersion };
    },
    async readCapabilities(): Promise<AgentDescriptor> {
      const descriptor = (await request('readCapabilities', {})) as AgentDescriptor;
      return { ...descriptor, transport: 'rpc' };
    },
    async openSession(input: OpenAgentSessionInput): Promise<AgentSessionIdentity> {
      return rememberSession((await request('openSession', input)) as AgentSessionIdentity, input.cwd);
    },
    async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSessionIdentity> {
      const resumed = (await request('resumeSession', input)) as AgentSessionIdentity;
      assertSameNativeIdentity({ agentKind: 'pi', nativeSessionId: input.nativeSessionId, nativeSessionPath: input.nativeSessionPath ?? null, runtimeInstanceId: resumed.runtimeInstanceId }, resumed);
      return rememberSession(resumed, input.cwd ?? sessions.get(input.nativeSessionId)?.cwd ?? null);
    },
    async startRun(input: StartAgentRunInput): Promise<AcceptedAgentRun> {
      await ensureReady(false);
      const callbackToken = `pi_callbacks_${randomUUID()}`;
      const { preflightResult, durableTransactionSync, providerWriteMayStart, providerPayloadObserved, ...serializable } = withCurrentSession(input);
      if (!generationId) throw driverError('ZEUS_PI_WORKER_UNAVAILABLE', 'Pi Worker 当前不可用。');
      const commandRequestId = `${generationId}:${requestSequence + 1}`;
      const traceIdentity = serializable.traceIdentity ?? null;
      runCallbacks.set(callbackToken, { commandRequestId, traceIdentity, callbacks: { preflightResult, durableTransactionSync, providerWriteMayStart, providerPayloadObserved } });
      try {
        return (await requestCurrentGeneration('startRun', { ...serializable, callbackToken }, { timeoutMs: timeoutForMethod('startRun'), effectful: true, traceIdentity })) as AcceptedAgentRun;
      } catch (error) {
        runCallbacks.delete(callbackToken);
        throw error;
      }
    },
    async steerRun(input: SteerAgentRunInput): Promise<AcceptedAgentRun> {
      return (await request('steerRun', withCurrentSession(input))) as AcceptedAgentRun;
    },
    async followUp(input: FollowUpAgentRunInput): Promise<AcceptedAgentRun> {
      return (await request('followUp', withCurrentSession(input))) as AcceptedAgentRun;
    },
    async compactSession(input: CompactAgentSessionInput): Promise<CompactAgentSessionResult> {
      return (await request('compactSession', withCurrentSession(input))) as CompactAgentSessionResult;
    },
    async interruptRun(input: InterruptAgentRunInput): Promise<void> {
      await request('interruptRun', withCurrentSession(input));
    },
    async respondToInteraction(input: RespondAgentInteractionInput): Promise<void> {
      await request('respondToInteraction', withCurrentSession(input));
    },
    async readSession(input: ReadAgentSessionInput): Promise<AgentSessionSnapshot> {
      return (await request('readSession', withCurrentSession(input))) as AgentSessionSnapshot;
    },
    async recover(): Promise<void> {
      await recoverRuntime();
    },
    async recoverRuntime(): Promise<AgentRuntimeHealthSnapshot> {
      return recoverRuntime();
    },
    getRuntimeHealth(): AgentRuntimeHealthSnapshot {
      return health();
    },
    async invalidateModelRuntime(): Promise<void> {
      if (!child || !generationId) {
        if (circuitReason === 'authentication' || circuitReason === 'rate_limit') {
          circuitState = 'closed';
          circuitOpenedAt = null;
          circuitReason = null;
          lifecycle = 'stopped';
        }
        return;
      }
      await requestCurrentGeneration('invalidateModelRuntime', {}, { timeoutMs: 15_000, effectful: false });
      if (circuitReason === 'authentication' || circuitReason === 'rate_limit') {
        circuitState = 'closed';
        circuitOpenedAt = null;
        circuitReason = null;
        lifecycle = 'healthy';
      }
    },
    async close(): Promise<void> {
      if (closing) return;
      closing = true;
      lifecycle = 'closing';
      if (child?.connected && generationId) {
        expectedExit = true;
        await requestCurrentGeneration('close', {}, { timeoutMs: shutdownTimeoutMs, effectful: false }).catch(() => undefined);
        await terminateWorker(true);
      }
      child = null;
      lifecycle = 'stopped';
      for (const pending of pendingRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(driverError('ZEUS_PI_WORKER_CLOSED', 'Pi Worker 驱动已经关闭。'));
      }
      pendingRequests.clear();
      listeners.clear();
      runCallbacks.clear();
      activeRuns.clear();
      knownCredentialValues.clear();
    },
    subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;

  function circuitOpenError(): Error & { code: string; failureKind: AgentRuntimeFailureKind | null } {
    return Object.assign(driverError('ZEUS_PI_WORKER_CIRCUIT_OPEN', `Pi Worker 熔断已打开${lastFailure ? `：${lastFailure.message}` : '。'}请先执行受控恢复。`), { failureKind: circuitReason });
  }
}

function workerEnvironment(generationId: string): NodeJS.ProcessEnv {
  const allowed = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'NODE_ENV', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE'];
  const environment: NodeJS.ProcessEnv = { ZEUS_PI_WORKER_GENERATION_ID: generationId };
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = '1';
  return environment;
}

function timeoutForMethod(method: PiRuntimeWorkerMethod): number {
  if (method === 'startRun') return 310_000;
  if (method === 'compactSession') return 600_000;
  if (method === 'openSession' || method === 'resumeSession') return 60_000;
  if (method === 'probe' || method === 'readCapabilities' || method === 'recover') return 30_000;
  return 15_000;
}

function classifyOperationFailure(error: Error & { code?: string }, resultUnknown: boolean): AgentRuntimeFailureSnapshot {
  const code = error.code ?? 'ZEUS_PI_WORKER_OPERATION_FAILED';
  const message = error.message;
  if (/PROTOCOL|INCOMPATIBLE/u.test(code)) return failure('protocol_incompatible', code, message, resultUnknown);
  if (/TIMEOUT/u.test(code)) return failure('timeout', code, message, resultUnknown);
  if (isAuthenticationFailure(message, code)) return failure('authentication', code, message, resultUnknown);
  if (isRateLimitFailure(message, code)) return failure('rate_limit', code, message, resultUnknown);
  return failure('unknown', code, message, resultUnknown);
}

function classifyRuntimeEventFailure(event: AgentRuntimeEvent): AgentRuntimeFailureSnapshot {
  const payload = asRecord(event.payload);
  const code = typeof payload.code === 'string' ? payload.code : 'ZEUS_PI_RUNTIME_FAILED';
  const message = typeof payload.message === 'string' ? payload.message : 'Pi Runtime 返回失败事件。';
  if (isAuthenticationFailure(message, code)) return failure('authentication', code, message, false);
  if (isRateLimitFailure(message, code)) return failure('rate_limit', code, message, false);
  return failure('unknown', code, message, payload.resultUnknown === true);
}

function shouldOpenCircuit(snapshot: AgentRuntimeFailureSnapshot): boolean {
  return snapshot.kind === 'startup' || snapshot.kind === 'timeout' || snapshot.kind === 'authentication' || snapshot.kind === 'rate_limit' || snapshot.kind === 'protocol_incompatible' || snapshot.kind === 'process_exit';
}

function isAuthenticationFailure(message: string, code: string): boolean {
  return /AUTH|API_KEY|UNAUTHORIZED/u.test(code) || /(?:authentication failed|unauthorized|invalid api key|missing api key|http\s*401)/iu.test(message);
}

function isRateLimitFailure(message: string, code: string): boolean {
  return /RATE_LIMIT|TOO_MANY_REQUESTS/u.test(code) || /(?:rate.?limit|too many requests|http\s*429)/iu.test(message);
}

function failure(kind: AgentRuntimeFailureKind, code: string, message: string, resultUnknown: boolean): AgentRuntimeFailureSnapshot {
  return { kind, code, message: sanitizeDiagnostic(message) || 'Pi Worker 失败。', occurredAt: new Date().toISOString(), resultUnknown };
}

function snapshotError(snapshot: AgentRuntimeFailureSnapshot): Error & { code: string; failureKind: AgentRuntimeFailureKind; resultUnknown: boolean } {
  return Object.assign(new Error(snapshot.message), { code: snapshot.code, failureKind: snapshot.kind, resultUnknown: snapshot.resultUnknown });
}

function readAcceptance(value: unknown): AcceptedAgentRun {
  const record = asRecord(value);
  return { nativeRunId: requiredString(record.nativeRunId, 'nativeRunId'), acceptedAt: requiredString(record.acceptedAt, 'acceptedAt') };
}

function assertSameNativeIdentity(expected: AgentSessionIdentity, actual: AgentSessionIdentity): void {
  if (actual.agentKind !== 'pi' || actual.nativeSessionId !== expected.nativeSessionId || (expected.nativeSessionPath && actual.nativeSessionPath !== expected.nativeSessionPath)) {
    throw driverError('ZEUS_PI_SESSION_IDENTITY_MISMATCH', 'Pi Worker 恢复后的原生会话身份不一致；Zeus 不会创建替代会话。');
  }
}

function sanitizeDiagnostic(value: string, knownCredentialValues: ReadonlySet<string> = new Set()): string {
  let sanitized = value;
  for (const credential of knownCredentialValues) sanitized = sanitized.split(credential).join('[凭据已隐藏]');
  return sanitizePiRuntimeWorkerDiagnostic(sanitized)
    .replace(/[\r\n]+/gu, ' ')
    .trim()
    .slice(0, 1_000);
}

function rememberCredentialValues(connections: readonly PiRuntimeConnection[], target: Set<string>): void {
  for (const connection of connections) {
    const credential = connection.apiKey?.trim();
    if (credential && credential.length >= 8) target.add(credential);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw driverError('ZEUS_PI_WORKER_PROTOCOL_INVALID', `Pi Worker 字段无效：${field}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function traceIdentityFromPayload(value: unknown): string | null {
  const traceIdentity = asRecord(value).traceIdentity;
  return normalizePerformanceTraceIdentity(traceIdentity);
}

function readErrorCode(error: unknown): string | null {
  const record = asRecord(error);
  return typeof record.code === 'string' ? record.code : null;
}

function driverError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function beforeTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    void promise.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}
