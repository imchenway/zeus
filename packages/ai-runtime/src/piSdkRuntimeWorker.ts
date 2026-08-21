import { randomUUID } from 'node:crypto';
import type { AcceptedAgentRun, AgentProviderPayloadDiagnostic, AgentRuntimeEvent, FollowUpAgentRunInput, StartAgentRunInput, SteerAgentRunInput } from './agentRuntimeContracts.js';
import { createPiSdkRuntimeDriver, type PiRuntimeConnection, type PiSdkRuntimeDriver, type PiZeusToolRequest, type PiZeusToolResult } from './piSdkRuntimeDriver.js';
import {
  isPiRuntimeCoreToWorkerMessage,
  piRuntimeWorkerError,
  piRuntimeWorkerProtocolVersion,
  sanitizePiRuntimeWorkerDiagnostic,
  serializePiRuntimeWorkerError,
  type PiRuntimeCoreToWorkerMessage,
  type PiRuntimeWorkerRequest,
  type PiRuntimeWorkerReverseResponse,
  type PiRuntimeWorkerToCoreMessage,
} from './piRuntimeWorkerProtocol.js';

interface WorkerInitialization {
  adapterVersion: string;
  agentDirectory: string;
  sessionDirectory: string;
}

interface SerializedStartInput extends Omit<StartAgentRunInput, 'preflightResult' | 'durableTransactionSync' | 'providerWriteMayStart' | 'providerPayloadObserved'> {
  callbackToken: string;
}

interface RunBoundary {
  callbackToken: string;
  traceIdentity: string | null;
  providerWriteAllowed: Promise<void>;
  allowProviderWrite(): void;
  rejectProviderWrite(error: unknown): void;
}

interface PendingReverseRequest {
  traceIdentity: string | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  abortCleanup: (() => void) | null;
}

const noCommandResponse = Symbol('no-command-response');
const generationId = process.env.ZEUS_PI_WORKER_GENERATION_ID?.trim() || `invalid_generation_${randomUUID()}`;
const pendingReverseRequests = new Map<string, PendingReverseRequest>();
const runBoundaries = new Map<string, RunBoundary>();
const knownCredentialValues = new Set<string>();
let driver: PiSdkRuntimeDriver | null = null;
let closing = false;

send({ kind: 'hello', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, pid: process.pid });

process.on('message', (raw: unknown) => {
  if (!isPiRuntimeCoreToWorkerMessage(raw) || raw.generationId !== generationId) {
    closing = true;
    process.exit(78);
    return;
  }
  void handleCoreMessage(raw);
});

process.on('disconnect', () => {
  closing = true;
  void closeDriver().finally(() => {
    process.exit(0);
  });
});

process.on('uncaughtException', () => {
  process.exit(70);
});

process.on('unhandledRejection', () => {
  process.exit(70);
});

async function handleCoreMessage(message: PiRuntimeCoreToWorkerMessage): Promise<void> {
  if (message.kind === 'reverse_response') {
    settleReverseRequest(message);
    return;
  }
  try {
    const value = await handleRequest(message);
    if (value === noCommandResponse) return;
    send({ kind: 'response', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, traceIdentity: message.traceIdentity ?? null, id: message.id, ok: true, value });
    if (message.method === 'close') process.disconnect?.();
  } catch (error) {
    send({ kind: 'response', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, traceIdentity: message.traceIdentity ?? null, id: message.id, ok: false, error: serializeWorkerError(error) });
  }
}

async function handleRequest(request: PiRuntimeWorkerRequest): Promise<unknown | typeof noCommandResponse> {
  if (request.method === 'initialize') {
    if (driver) throw workerError('ZEUS_PI_WORKER_ALREADY_INITIALIZED', 'Pi Worker 已经完成初始化。');
    const input = readInitialization(request.payload);
    driver = createPiSdkRuntimeDriver({
      ...input,
      runtimeInstanceId: generationId,
      loadConnections: async () => {
        const connections = (await reverseRequest('load_connections', {})) as PiRuntimeConnection[];
        rememberCredentialValues(connections);
        return connections;
      },
      toolBroker: {
        execute: async (toolRequest) => reverseToolRequest(toolRequest),
        respond: async (response) => {
          await reverseRequest('tool_respond', response);
        },
      },
      beforeProviderWrite: async ({ sessionId, model, diagnostic }) => beforeProviderWrite(sessionId, model, diagnostic),
    });
    driver.subscribe(forwardRuntimeEvent);
    return { protocolVersion: piRuntimeWorkerProtocolVersion, generationId, adapterVersion: input.adapterVersion };
  }
  const runtime = requireDriver();
  switch (request.method) {
    case 'probe':
      return runtime.probe();
    case 'readCapabilities':
      return runtime.readCapabilities();
    case 'openSession':
      return runtime.openSession(request.payload as Parameters<PiSdkRuntimeDriver['openSession']>[0]);
    case 'resumeSession':
      return runtime.resumeSession(request.payload as Parameters<PiSdkRuntimeDriver['resumeSession']>[0]);
    case 'startRun':
      return startRun(runtime, request, request.payload as SerializedStartInput);
    case 'steerRun':
      return runtime.steerRun(request.payload as SteerAgentRunInput);
    case 'followUp':
      return runtime.followUp(request.payload as FollowUpAgentRunInput);
    case 'compactSession':
      return runtime.compactSession(request.payload as Parameters<PiSdkRuntimeDriver['compactSession']>[0]);
    case 'interruptRun':
      return runtime.interruptRun(request.payload as Parameters<PiSdkRuntimeDriver['interruptRun']>[0]);
    case 'respondToInteraction':
      return runtime.respondToInteraction(request.payload as Parameters<PiSdkRuntimeDriver['respondToInteraction']>[0]);
    case 'readSession':
      return runtime.readSession(request.payload as Parameters<PiSdkRuntimeDriver['readSession']>[0]);
    case 'recover':
      return runtime.recover();
    case 'invalidateModelRuntime':
      return runtime.invalidateModelRuntime();
    case 'close':
      closing = true;
      await closeDriver();
      return undefined;
    default:
      throw workerError('ZEUS_PI_WORKER_METHOD_UNSUPPORTED', 'Pi Worker 收到不兼容的方法。');
  }
}

async function startRun(runtime: PiSdkRuntimeDriver, request: PiRuntimeWorkerRequest, input: SerializedStartInput): Promise<typeof noCommandResponse> {
  const boundary = createRunBoundary(input.callbackToken, request.traceIdentity ?? null);
  runBoundaries.set(input.session.nativeSessionId, boundary);
  let preflightAccepted = false;
  let acceptance: AcceptedAgentRun | null = null;
  try {
    acceptance = await runtime.startRun({
      ...input,
      preflightResult: (accepted) => {
        preflightAccepted = accepted;
      },
    });
    await reverseRequest('run_acceptance', {
      commandRequestId: request.id,
      callbackToken: input.callbackToken,
      session: input.session,
      acceptance,
    }, undefined, boundary.traceIdentity);
    boundary.allowProviderWrite();
    return noCommandResponse;
  } catch (error) {
    boundary.rejectProviderWrite(error);
    if (!preflightAccepted) {
      await reverseRequest('run_rejected', { commandRequestId: request.id, callbackToken: input.callbackToken, session: input.session }, undefined, boundary.traceIdentity).catch(() => undefined);
    } else if (acceptance) await runtime.interruptRun({ session: input.session, nativeRunId: acceptance.nativeRunId }).catch(() => undefined);
    runBoundaries.delete(input.session.nativeSessionId);
    throw error;
  }
}

async function beforeProviderWrite(sessionId: string, model: { sourceId: string | null; modelId: string; displayName: string | null }, diagnostic: AgentProviderPayloadDiagnostic): Promise<void> {
  const boundary = runBoundaries.get(sessionId);
  if (!boundary) return;
  await boundary.providerWriteAllowed;
  await reverseRequest('provider_payload_observed', { callbackToken: boundary.callbackToken, model, diagnostic }, undefined, boundary.traceIdentity);
}

async function reverseToolRequest(request: PiZeusToolRequest): Promise<PiZeusToolResult> {
  const { signal, ...serializable } = request;
  return (await reverseRequest('tool_execute', serializable, signal)) as PiZeusToolResult;
}

function forwardRuntimeEvent(event: AgentRuntimeEvent): void {
  const forwardedEvent = event.type === 'runtime_error' ? { ...event, payload: sanitizeRuntimeErrorPayload(event.payload) } : event;
  send({ kind: 'event', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, event: forwardedEvent });
  if (event.nativeSessionId && (event.type === 'agent_settled' || event.type === 'runtime_error')) runBoundaries.delete(event.nativeSessionId);
}

function reverseRequest(method: Parameters<typeof sendReverseRequest>[0], payload: unknown, signal?: AbortSignal, traceIdentity: string | null = null): Promise<unknown> {
  if (closing) return Promise.reject(workerError('ZEUS_PI_WORKER_CLOSING', 'Pi Worker 正在关闭。'));
  const id = `pi_reverse_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingReverseRequests.get(id);
      if (!pending) return;
      pending.abortCleanup?.();
      pendingReverseRequests.delete(id);
      send({ kind: 'reverse_cancel', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, id });
      reject(workerError('ZEUS_PI_WORKER_REVERSE_RPC_TIMEOUT', `Pi Worker 反向 RPC 超时：${method}`));
    }, reverseRequestTimeout(method));
    timeout.unref();
    const abort = () => {
      const pending = pendingReverseRequests.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pendingReverseRequests.delete(id);
      send({ kind: 'reverse_cancel', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, id });
      reject(Object.assign(new Error('Pi 工具调用已取消。'), { name: 'AbortError', code: 'ZEUS_PI_TOOL_ABORTED' }));
    };
    pendingReverseRequests.set(id, { traceIdentity, resolve, reject, timeout, abortCleanup: signal ? () => signal.removeEventListener('abort', abort) : null });
    signal?.addEventListener('abort', abort, { once: true });
    sendReverseRequest(method, id, payload, traceIdentity);
  });
}

function sendReverseRequest(method: 'load_connections' | 'tool_execute' | 'tool_respond' | 'run_acceptance' | 'run_rejected' | 'provider_payload_observed', id: string, payload: unknown, traceIdentity: string | null): void {
  send({ kind: 'reverse_request', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, traceIdentity, id, method, payload });
}

function settleReverseRequest(response: PiRuntimeWorkerReverseResponse): void {
  const pending = pendingReverseRequests.get(response.id);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pending.abortCleanup?.();
  pendingReverseRequests.delete(response.id);
  if ((response.traceIdentity ?? null) !== pending.traceIdentity) {
    pending.reject(workerError('ZEUS_PI_WORKER_TRACE_IDENTITY_MISMATCH', 'Pi Worker 反向 RPC 回执的性能 trace identity 不一致。'));
    return;
  }
  if (response.ok) pending.resolve(response.value);
  else pending.reject(piRuntimeWorkerError(response.error!));
}

function createRunBoundary(callbackToken: string, traceIdentity: string | null): RunBoundary {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const providerWriteAllowed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void providerWriteAllowed.catch(() => undefined);
  return { callbackToken, traceIdentity, providerWriteAllowed, allowProviderWrite: resolve, rejectProviderWrite: reject };
}

function readInitialization(value: unknown): WorkerInitialization {
  const record = asRecord(value);
  const adapterVersion = requiredString(record.adapterVersion, 'adapterVersion');
  const agentDirectory = requiredString(record.agentDirectory, 'agentDirectory');
  const sessionDirectory = requiredString(record.sessionDirectory, 'sessionDirectory');
  return { adapterVersion, agentDirectory, sessionDirectory };
}

function requireDriver(): PiSdkRuntimeDriver {
  if (!driver) throw workerError('ZEUS_PI_WORKER_NOT_INITIALIZED', 'Pi Worker 尚未完成初始化。');
  return driver;
}

async function closeDriver(): Promise<void> {
  const current = driver;
  driver = null;
  if (current) await current.close({ mode: 'final' });
  for (const pending of pendingReverseRequests.values()) {
    clearTimeout(pending.timeout);
    pending.abortCleanup?.();
    pending.reject(workerError('ZEUS_PI_WORKER_CLOSING', 'Pi Worker 正在关闭。'));
  }
  pendingReverseRequests.clear();
  for (const boundary of runBoundaries.values()) boundary.rejectProviderWrite(workerError('ZEUS_PI_WORKER_CLOSING', 'Pi Worker 正在关闭。'));
  runBoundaries.clear();
  knownCredentialValues.clear();
}

function reverseRequestTimeout(method: string): number {
  if (method === 'tool_execute') return 180_000;
  if (method === 'run_acceptance') return 60_000;
  return 30_000;
}

function send(message: PiRuntimeWorkerToCoreMessage | { kind: 'reverse_cancel'; protocolVersion: typeof piRuntimeWorkerProtocolVersion; generationId: string; id: string }): void {
  if (!process.connected || !process.send) return;
  process.send(message);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw workerError('ZEUS_PI_WORKER_INITIALIZATION_INVALID', `Pi Worker 初始化字段无效：${field}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function workerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function serializeWorkerError(error: unknown) {
  const serialized = serializePiRuntimeWorkerError(error);
  return { ...serialized, message: redactKnownCredentials(serialized.message) };
}

function sanitizeRuntimeErrorPayload(payload: unknown): unknown {
  if (typeof payload === 'string') return redactKnownCredentials(payload);
  const record = asRecord(payload);
  if (Object.keys(record).length === 0) return payload;
  const sanitized = { ...record };
  for (const field of ['message', 'error', 'errorMessage', 'reason']) {
    if (typeof sanitized[field] === 'string') sanitized[field] = redactKnownCredentials(sanitized[field]);
  }
  return sanitized;
}

function redactKnownCredentials(value: string): string {
  let redacted = value;
  for (const credential of knownCredentialValues) redacted = redacted.split(credential).join('[凭据已隐藏]');
  return sanitizePiRuntimeWorkerDiagnostic(redacted);
}

function rememberCredentialValues(connections: readonly PiRuntimeConnection[]): void {
  for (const connection of connections) {
    const credential = connection.apiKey?.trim();
    if (credential && credential.length >= 8) knownCredentialValues.add(credential);
  }
}
