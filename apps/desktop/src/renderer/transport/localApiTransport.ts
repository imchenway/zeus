import { currentConversationNavigationTraceId, markConversationNavigationSnapshotSettled } from '../performanceTraceContext.js';

/**
 * Renderer 各 bounded context 共享的公开传输端口。
 *
 * 业务 client 只能看到版本化 JSON/Blob 请求能力，不掌握 token、端口刷新、重试、
 * trace 或 Electron Main 生命周期；这些横切策略由此文件的唯一实现负责。
 */
export interface LocalApiTransport {
  readonly protocol: 'zeus-local-api-v1';
  request<T>(path: string, init?: RequestInit): Promise<T>;
  requestBlob(path: string): Promise<Blob>;
  connectEvents<T>(onEvent: (event: T) => void, options?: { afterEventId?: string; conversationId?: string; afterSequence?: number; syncStreamGeneration?: string }): WebSocket;
}

export interface LocalApiConnection {
  baseUrl: string;
  apiToken: string;
}

export interface ZeusClientPerformanceSpan {
  traceId: string;
  attempt: number;
  operation: string;
  statusCode: number | null;
  success: boolean;
  durationMs: number;
  responseWaitMs: number | null;
  responseParseMs: number | null;
  responseBytes: number | null;
  serverDurationMs: number | null;
  responseTraceMatched: boolean | null;
  completedAt: string;
}

export class ZeusApiError extends Error {
  readonly status: number;
  readonly error: string | null;
  readonly recoveryRequired: boolean;

  constructor(input: { status: number; error?: string | null; message: string; recoveryRequired?: boolean }) {
    super(input.message);
    this.name = 'ZeusApiError';
    this.status = input.status;
    this.error = input.error ?? null;
    this.recoveryRequired = input.recoveryRequired ?? false;
  }
}

const localApiReadTimeoutMs = 8_000;

class LocalApiReadTimeoutError extends Error {
  readonly code = 'ZEUS_LOCAL_API_READ_TIMEOUT';

  constructor(path: string) {
    super(`Zeus 本地服务读取超时：${apiRouteFamily(path)}`);
    this.name = 'LocalApiReadTimeoutError';
  }
}

export function createLocalApiTransport(options: { getConnection(): LocalApiConnection; refreshConnection?: () => Promise<LocalApiConnection>; onPerformanceSpan?: (span: ZeusClientPerformanceSpan) => void }): LocalApiTransport {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const traceId = createClientTraceId(path);
    let completedSuccessfully = false;
    try {
      try {
        const result = await requestOnce<T>(options.getConnection(), path, init, traceId, 1, options.onPerformanceSpan);
        completedSuccessfully = true;
        return result;
      } catch (error) {
        if (!isLikelyLocalServerConnectionError(error) || !options.refreshConnection) throw error;
        // 一个逻辑请求最多刷新一次 Main 提供的端口/token，禁止在 context client 内自建重试循环。
        const refreshed = await options.refreshConnection();
        const result = await requestOnce<T>(refreshed, path, init, traceId, 2, options.onPerformanceSpan);
        completedSuccessfully = true;
        return result;
      }
    } finally {
      // 重连的两个网络 attempt 属于同一个逻辑请求；只有最终结果才能结束 Snapshot 导航阶段。
      markConversationNavigationSnapshotSettled(traceId, path, completedSuccessfully);
    }
  };

  const requestBlob = async (path: string): Promise<Blob> => {
    const traceId = createClientTraceId(path);
    let connection = options.getConnection();
    let attempt = 1;
    while (true) {
      const startedAt = performance.now();
      let response: Response | null = null;
      try {
        const blob = await runWithReadTimeout(
          {
            headers: {
              authorization: `Bearer ${connection.apiToken}`,
              'x-zeus-trace-id': traceId,
            },
          },
          path,
          async (timedInit) => {
            response = await fetch(`${connection.baseUrl}${path}`, timedInit);
            if (!response.ok) throw await responseError(response, path);
            return response.blob();
          },
        );
        recordClientPerformanceSpan(options.onPerformanceSpan, blobPerformanceSpan(response, traceId, attempt, startedAt, true));
        return blob;
      } catch (error) {
        recordClientPerformanceSpan(options.onPerformanceSpan, blobPerformanceSpan(response, traceId, attempt, startedAt, false));
        if (attempt !== 1 || !isLikelyLocalServerConnectionError(error) || !options.refreshConnection) throw error;
        connection = await options.refreshConnection();
        attempt = 2;
      }
    }
  };

  const connectEvents = <T>(onEvent: (event: T) => void, eventOptions?: { afterEventId?: string; conversationId?: string; afterSequence?: number; syncStreamGeneration?: string }): WebSocket => {
    const connection = options.getConnection();
    const wsUrl = new URL(`${connection.baseUrl.replace(/^http/u, 'ws')}/api/events`);
    if (eventOptions?.afterEventId) wsUrl.searchParams.set('afterEventId', eventOptions.afterEventId);
    if (eventOptions?.conversationId) wsUrl.searchParams.set('conversationId', eventOptions.conversationId);
    if (eventOptions?.afterSequence !== undefined) wsUrl.searchParams.set('afterSequence', String(eventOptions.afterSequence));
    if (eventOptions?.syncStreamGeneration) wsUrl.searchParams.set('syncStreamGeneration', eventOptions.syncStreamGeneration);
    const socket = new WebSocket(wsUrl.toString(), buildZeusWebSocketProtocol(connection.apiToken));
    socket.addEventListener('message', (message) => {
      void decodeWebSocketMessage(message.data).then((text) => {
        if (!text) return;
        onEvent(JSON.parse(text) as T);
      });
    });
    return socket;
  };

  return { protocol: 'zeus-local-api-v1', request, requestBlob, connectEvents };
}

export function jsonRequest(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

async function requestOnce<T>(connection: LocalApiConnection, path: string, init: RequestInit | undefined, traceId: string, attempt: number, observer: ((span: ZeusClientPerformanceSpan) => void) | undefined): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${connection.apiToken}`);
  headers.set('x-zeus-trace-id', traceId);
  if (init?.body) headers.set('content-type', 'application/json');
  const startedAt = performance.now();
  const readState: { response: Response | null; responseReceivedAt: number | null } = {
    response: null,
    responseReceivedAt: null,
  };
  let completedSuccessfully = false;
  try {
    const result = await runWithReadTimeout({ ...init, headers }, path, async (timedInit) => {
      readState.response = await fetch(`${connection.baseUrl}${path}`, timedInit);
      readState.responseReceivedAt = performance.now();
      if (!readState.response.ok) throw await responseError(readState.response, path);
      if (readState.response.status === 204 || readState.response.headers.get('content-length') === '0') return undefined as T;
      return (await readState.response.json()) as T;
    });
    completedSuccessfully = true;
    return result;
  } finally {
    const completedAt = performance.now();
    const response = readState.response;
    const responseReceivedAt = readState.responseReceivedAt;
    recordClientPerformanceSpan(observer, {
      traceId,
      attempt,
      operation: apiRouteFamily(path, init?.method),
      statusCode: response?.status ?? null,
      success: completedSuccessfully,
      durationMs: roundClientMetric(completedAt - startedAt),
      responseWaitMs: responseReceivedAt === null ? null : roundClientMetric(responseReceivedAt - startedAt),
      responseParseMs: responseReceivedAt === null ? null : roundClientMetric(completedAt - responseReceivedAt),
      responseBytes: parseNonNegativeIntegerHeader(response?.headers.get('content-length') ?? null),
      serverDurationMs: parseServerDuration(response?.headers.get('server-timing') ?? null),
      responseTraceMatched: response ? response.headers.get('x-zeus-trace-id') === traceId : null,
      completedAt: new Date().toISOString(),
    });
  }
}

async function responseError(response: Response, path: string): Promise<ZeusApiError> {
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    message?: string;
    recoveryRequired?: boolean;
    operation?: { status?: string };
  } | null;
  const recoveryRequired = payload?.recoveryRequired === true || payload?.error === 'ZEUS_IDEMPOTENCY_RECOVERY_REQUIRED' || payload?.operation?.status === 'recovery_required';
  return new ZeusApiError({
    status: response.status,
    error: payload?.error,
    message: payload?.message ?? `Zeus local API request failed: ${path} ${response.status}`,
    recoveryRequired,
  });
}

function blobPerformanceSpan(response: Response | null, traceId: string, attempt: number, startedAt: number, success: boolean): ZeusClientPerformanceSpan {
  const completedAt = performance.now();
  return {
    traceId,
    attempt,
    operation: 'GET /api/blob',
    statusCode: response?.status ?? null,
    success,
    durationMs: roundClientMetric(completedAt - startedAt),
    responseWaitMs: null,
    responseParseMs: null,
    responseBytes: parseNonNegativeIntegerHeader(response?.headers.get('content-length') ?? null),
    serverDurationMs: parseServerDuration(response?.headers.get('server-timing') ?? null),
    responseTraceMatched: response ? response.headers.get('x-zeus-trace-id') === traceId : null,
    completedAt: new Date().toISOString(),
  };
}

export function isLikelyLocalServerConnectionError(error: unknown): boolean {
  // 持久化升级交接中的 503 表示当前连接正在退出，不是业务失败。刷新 Main
  // 提供的连接并复用同一逻辑读取一次，避免把瞬时交接窗口展示成 Git/会话错误。
  if (error instanceof ZeusApiError) return error.error === 'ZEUS_EXECUTION_HOST_DRAINING';
  if (error instanceof LocalApiReadTimeoutError) return true;
  if (error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string' && ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'].includes(code)) return true;
  return /fetch failed|failed to fetch|networkerror|connection refused|connection reset/iu.test(error.message);
}

async function runWithReadTimeout<T>(init: RequestInit, path: string, operation: (timedInit: RequestInit) => Promise<T>): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET') return operation(init);

  const controller = new AbortController();
  const callerSignal = init.signal;
  let timedOut = false;
  const forwardAbort = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forwardAbort();
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, localApiReadTimeoutMs);
  try {
    // 超时覆盖响应头和正文解析，避免本地服务只返回响应头后让 JSON/Blob 读取永久悬挂。
    return await operation({ ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new LocalApiReadTimeoutError(path);
    throw error;
  } finally {
    globalThis.clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}

function createClientTraceId(path: string): string {
  const conversationNavigationTraceId = currentConversationNavigationTraceId(path);
  if (conversationNavigationTraceId) return conversationNavigationTraceId;
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function apiRouteFamily(path: string, method?: string): string {
  let pathname = '/api/unknown';
  try {
    pathname = new URL(path, 'http://127.0.0.1').pathname;
  } catch {
    // 无效相对 URL 只进入 unknown 家族，不把原始值写入性能投影。
  }
  const segments = pathname.split('/').filter(Boolean);
  const family = segments[0] === 'api' && segments[1] ? `/api/${segments[1]}` : '/api/unknown';
  return `${(method ?? 'GET').toUpperCase()} ${family}`;
}

function recordClientPerformanceSpan(observer: ((span: ZeusClientPerformanceSpan) => void) | undefined, span: ZeusClientPerformanceSpan): void {
  try {
    performance.measure('zeus.api.request', {
      start: Math.max(0, performance.now() - span.durationMs),
      duration: span.durationMs,
      detail: span,
    });
  } catch {
    // Performance Timeline 不可用不影响 API 结果；显式 observer 仍可接收同一 span。
  }
  try {
    observer?.(span);
  } catch {
    // 诊断观察者不能改变产品请求的成功或失败语义。
  }
}

function parseNonNegativeIntegerHeader(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseServerDuration(value: string | null): number | null {
  if (!value) return null;
  const match = /(?:^|,)\s*zeus_core;dur=([0-9]+(?:\.[0-9]+)?)/u.exec(value);
  if (!match?.[1]) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? roundClientMetric(parsed) : null;
}

function roundClientMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

async function decodeWebSocketMessage(data: MessageEvent['data']): Promise<string | null> {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  if (ArrayBuffer.isView(data)) return new TextDecoder().decode(data);
  if (data && typeof data === 'object' && 'text' in data && typeof data.text === 'function') return data.text();
  return null;
}

function buildZeusWebSocketProtocol(apiToken: string): string {
  if (typeof Buffer !== 'undefined') return `zeus-token.${Buffer.from(apiToken, 'utf8').toString('base64url')}`;
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(apiToken)))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
  return `zeus-token.${encoded}`;
}
