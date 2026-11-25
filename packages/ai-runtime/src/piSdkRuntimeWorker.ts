import { randomUUID } from 'node:crypto';
import type { AgentProviderPayloadDiagnostic, AgentRuntimeEvent, FollowUpAgentRunInput, StartAgentRunInput, SteerAgentRunInput } from './agentRuntimeContracts.js';
import { createPiSdkRuntimeDriver, type PiRuntimeConnection, type PiSdkRuntimeDriver, type PiZeusToolDefinitionSpec, type PiZeusToolRequest, type PiZeusToolResult } from './piSdkRuntimeDriver.js';
import {
  isPiRuntimeCoreToWorkerMessage,
  piRuntimeWorkerError,
  piRuntimeWorkerProtocolVersion,
  sanitizePiRuntimeWorkerDiagnostic,
  serializePiRuntimeWorkerError,
  type PiRuntimeCoreToWorkerMessage,
  type PiRuntimeWorkerRequest,
  type PiRuntimeWorkerReverseMethod,
  type PiRuntimeWorkerReverseResponse,
  type PiRuntimeWorkerToCoreMessage,
} from './piRuntimeWorkerProtocol.js';

interface WorkerInitialization {
  adapterVersion: string;
  agentDirectory: string;
  sessionDirectory: string;
  nativeTools: PiZeusToolDefinitionSpec[];
}

/** IPC 提交用标志表示 Core 是否提供摘要请求回调。 */
interface SerializedStartInput extends Omit<StartAgentRunInput, 'preflightResult' | 'durableTransactionSync' | 'providerWriteMayStart' | 'providerPayloadObserved' | 'compactionRequestObserved'> {
  callbackToken: string;
  observeCompactionRequests: boolean;
}

/** 把模型请求诊断路由到当前原生轮次对应的 Core 回调。 */
interface RunCallbackBinding {
  nativeRunId: string;
  callbackToken: string;
  traceIdentity: string | null;
}

interface PendingReverseRequest {
  traceIdentity: string | null;
  resolve(value: unknown): void;
  reject(error: Error): void;
  /** 人工问答和审批由取消或宿主断连收口，不使用工具总时限。 */
  timeout: ReturnType<typeof setTimeout> | undefined;
  abortCleanup: (() => void) | null;
}

const noCommandResponse = Symbol('no-command-response');
const generationId = process.env.ZEUS_PI_WORKER_GENERATION_ID?.trim() || `invalid_generation_${randomUUID()}`;
const pendingReverseRequests = new Map<string, PendingReverseRequest>();
/** 每个 Pi 会话仅保留当前轮次的诊断回调身份。 */
const runCallbacks = new Map<string, RunCallbackBinding>();
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
        /** 图片沿用反向请求的取消传播，不触发工具执行。 */
        readImage: async ({ signal, ...input }) => (await reverseRequest('tool_image_read', input, signal)) as { data: string; mimeType: string },
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
    case 'importPortableHistory':
      return runtime.importPortableHistory(request.payload as Parameters<PiSdkRuntimeDriver['importPortableHistory']>[0]);
    case 'interruptRun':
      return runtime.interruptRun(request.payload as Parameters<PiSdkRuntimeDriver['interruptRun']>[0]);
    case 'respondToInteraction':
      return runtime.respondToInteraction(request.payload as Parameters<PiSdkRuntimeDriver['respondToInteraction']>[0]);
    case 'readSession':
      return runtime.readSession(request.payload as Parameters<PiSdkRuntimeDriver['readSession']>[0]);
    case 'recover':
      return runtime.recover();
    case 'reviewPermission':
      return runtime.reviewPermission(request.payload as Parameters<PiSdkRuntimeDriver['reviewPermission']>[0]);
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

/** Core 持久接纳通过反向 RPC 完成，由 SDK 驱动统一控制写前放行。 */
async function startRun(runtime: PiSdkRuntimeDriver, request: PiRuntimeWorkerRequest, input: SerializedStartInput): Promise<typeof noCommandResponse> {
  /** 接纳、拒绝和诊断都需要保留同一条派发链路标识。 */
  const traceIdentity = request.traceIdentity ?? null;
  let preflightAccepted = false;
  try {
    await runtime.startRun(
      {
        ...input,
        preflightResult: (accepted) => {
          preflightAccepted = accepted;
        },
        ...(input.observeCompactionRequests
          ? {
              compactionRequestObserved: async (observation) => {
                await reverseRequest('compaction_request_observed', { callbackToken: input.callbackToken, observation }, undefined, traceIdentity);
              },
            }
          : {}),
      },
      async (acceptance) => {
        runCallbacks.set(input.session.nativeSessionId, { nativeRunId: acceptance.nativeRunId, callbackToken: input.callbackToken, traceIdentity });
        await reverseRequest('run_acceptance', { commandRequestId: request.id, callbackToken: input.callbackToken, session: input.session, acceptance }, undefined, traceIdentity);
      },
    );
    return noCommandResponse;
  } catch (error) {
    if (!preflightAccepted) {
      await reverseRequest('run_rejected', { commandRequestId: request.id, callbackToken: input.callbackToken, session: input.session }, undefined, traceIdentity).catch(() => undefined);
    }
    if (runCallbacks.get(input.session.nativeSessionId)?.callbackToken === input.callbackToken) runCallbacks.delete(input.session.nativeSessionId);
    throw error;
  }
}

/** 发出模型请求前将脱敏诊断交给已接纳该轮的 Core。 */
async function beforeProviderWrite(sessionId: string, model: { sourceId: string | null; modelId: string; displayName: string | null }, diagnostic: AgentProviderPayloadDiagnostic): Promise<void> {
  /** 归属按会话查找，接纳回执绑定到具体轮次。 */
  const binding = runCallbacks.get(sessionId);
  if (binding) await reverseRequest('provider_payload_observed', { callbackToken: binding.callbackToken, model, diagnostic }, undefined, binding.traceIdentity);
}

async function reverseToolRequest(request: PiZeusToolRequest): Promise<PiZeusToolResult> {
  const { signal, ...serializable } = request;
  return (await reverseRequest('tool_execute', serializable, signal)) as PiZeusToolResult;
}

function forwardRuntimeEvent(event: AgentRuntimeEvent): void {
  const forwardedEvent = event.type === 'runtime_error' ? { ...event, payload: sanitizeRuntimeErrorPayload(event.payload) } : event;
  send({ kind: 'event', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, event: forwardedEvent });
  if (event.nativeSessionId && (event.type === 'agent_settled' || event.type === 'runtime_error') && runCallbacks.get(event.nativeSessionId)?.nativeRunId === event.nativeRunId) {
    runCallbacks.delete(event.nativeSessionId);
  }
}

function reverseRequest(method: Parameters<typeof sendReverseRequest>[0], payload: unknown, signal?: AbortSignal, traceIdentity: string | null = null): Promise<unknown> {
  if (closing) return Promise.reject(workerError('ZEUS_PI_WORKER_CLOSING', 'Pi Worker 正在关闭。'));
  // 取消可能先于监听注册；已经取消的调用不能进入无限等待或再发送工具操作。
  if (signal?.aborted) return Promise.reject(workerError('ZEUS_PI_TOOL_ABORTED', 'Pi 工具调用已取消。'));
  const id = `pi_reverse_${randomUUID()}`;
  return new Promise((resolve, reject) => {
    const timeoutMs = reverseRequestTimeout(method);
    const timeout =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            const pending = pendingReverseRequests.get(id);
            if (!pending) return;
            pending.abortCleanup?.();
            pendingReverseRequests.delete(id);
            send({ kind: 'reverse_cancel', protocolVersion: piRuntimeWorkerProtocolVersion, generationId, id });
            reject(workerError('ZEUS_PI_WORKER_REVERSE_RPC_TIMEOUT', `Pi Worker 反向 RPC 超时：${method}`));
          }, timeoutMs);
    timeout?.unref();
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

function sendReverseRequest(method: PiRuntimeWorkerReverseMethod, id: string, payload: unknown, traceIdentity: string | null): void {
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

function readInitialization(value: unknown): WorkerInitialization {
  const record = asRecord(value);
  const adapterVersion = requiredString(record.adapterVersion, 'adapterVersion');
  const agentDirectory = requiredString(record.agentDirectory, 'agentDirectory');
  const sessionDirectory = requiredString(record.sessionDirectory, 'sessionDirectory');
  const nativeTools = Array.isArray(record.nativeTools) ? record.nativeTools.map(readNativeToolDefinition) : [];
  return { adapterVersion, agentDirectory, sessionDirectory, nativeTools };
}

function readNativeToolDefinition(value: unknown): PiZeusToolDefinitionSpec {
  const record = asRecord(value);
  const parameters = asRecord(record.parameters);
  if (parameters.type !== 'object') throw workerError('ZEUS_PI_WORKER_INITIALIZATION_INVALID', 'Pi 原生工具参数必须是 JSON object schema。');
  return {
    name: requiredString(record.name, 'nativeTools.name'),
    label: requiredString(record.label, 'nativeTools.label'),
    description: requiredString(record.description, 'nativeTools.description'),
    parameters,
    ...(record.executionMode === 'sequential' ? { executionMode: 'sequential' as const } : record.executionMode === 'parallel' ? { executionMode: 'parallel' as const } : {}),
    ...(record.deferLoading === true ? { deferLoading: true } : {}),
  };
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
  runCallbacks.clear();
  knownCredentialValues.clear();
}

/** 工具执行内可等待用户；外部工具的执行超时仍由各自共用 Broker 管理。 */
function reverseRequestTimeout(method: string): number | null {
  if (method === 'tool_execute') return null;
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
