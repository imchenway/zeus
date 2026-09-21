import type { AgentRuntimeEvent } from './agentRuntimeContracts.js';
import { isPerformanceTraceIdentity } from '@zeus/shared';

export const piRuntimeWorkerProtocolVersion = 'zeus.pi-runtime-worker.v1' as const;

export type PiRuntimeWorkerMethod =
  | 'initialize'
  | 'probe'
  | 'readCapabilities'
  | 'openSession'
  | 'resumeSession'
  | 'startRun'
  | 'steerRun'
  | 'followUp'
  | 'compactSession'
  | 'importPortableHistory'
  | 'interruptRun'
  | 'respondToInteraction'
  | 'readSession'
  | 'recover'
  | 'reviewPermission'
  | 'invalidateModelRuntime'
  | 'close';

export type PiRuntimeWorkerReverseMethod = 'load_connections' | 'tool_execute' | 'tool_respond' | 'run_acceptance' | 'run_rejected' | 'provider_payload_observed';

export interface PiRuntimeWorkerWireError {
  code: string;
  message: string;
}

interface PiRuntimeWorkerEnvelope {
  protocolVersion: typeof piRuntimeWorkerProtocolVersion;
  generationId: string;
  /** 可选短期性能身份；旧消息允许缺失，null 表示无关联。 */
  traceIdentity?: string | null;
}

export interface PiRuntimeWorkerHello extends PiRuntimeWorkerEnvelope {
  kind: 'hello';
  pid: number;
}

export interface PiRuntimeWorkerRequest extends PiRuntimeWorkerEnvelope {
  kind: 'request';
  id: string;
  method: PiRuntimeWorkerMethod;
  payload: unknown;
}

export interface PiRuntimeWorkerResponse extends PiRuntimeWorkerEnvelope {
  kind: 'response';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: PiRuntimeWorkerWireError;
}

export interface PiRuntimeWorkerEventMessage extends PiRuntimeWorkerEnvelope {
  kind: 'event';
  event: AgentRuntimeEvent;
}

export interface PiRuntimeWorkerReverseRequest extends PiRuntimeWorkerEnvelope {
  kind: 'reverse_request';
  id: string;
  method: PiRuntimeWorkerReverseMethod;
  payload: unknown;
}

export interface PiRuntimeWorkerReverseResponse extends PiRuntimeWorkerEnvelope {
  kind: 'reverse_response';
  id: string;
  ok: boolean;
  value?: unknown;
  error?: PiRuntimeWorkerWireError;
}

export interface PiRuntimeWorkerReverseCancel extends PiRuntimeWorkerEnvelope {
  kind: 'reverse_cancel';
  id: string;
}

export type PiRuntimeWorkerToCoreMessage = PiRuntimeWorkerHello | PiRuntimeWorkerResponse | PiRuntimeWorkerEventMessage | PiRuntimeWorkerReverseRequest | PiRuntimeWorkerReverseCancel;

export type PiRuntimeCoreToWorkerMessage = PiRuntimeWorkerRequest | PiRuntimeWorkerReverseResponse;

export function isPiRuntimeWorkerToCoreMessage(value: unknown): value is PiRuntimeWorkerToCoreMessage {
  if (!isEnvelope(value)) return false;
  if (value.kind === 'hello') return typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0;
  if (value.kind === 'response') return isResponse(value);
  if (value.kind === 'event') return isRecord(value.event);
  if (value.kind === 'reverse_request') return typeof value.id === 'string' && isReverseMethod(value.method) && 'payload' in value;
  if (value.kind === 'reverse_cancel') return typeof value.id === 'string';
  return false;
}

export function isPiRuntimeCoreToWorkerMessage(value: unknown): value is PiRuntimeCoreToWorkerMessage {
  if (!isEnvelope(value)) return false;
  if (value.kind === 'request') return typeof value.id === 'string' && isWorkerMethod(value.method) && 'payload' in value;
  if (value.kind === 'reverse_response') return isResponse(value);
  return false;
}

/**
 * 错误码只用于跨 IPC 传递短标识符，这里拦截的是任意字符串冒充错误码，而不是限制大小写。
 * AI 供应商的错误码是小写加下划线（context_length_exceeded、insufficient_quota、model_not_found 等），
 * 早先只放行大写会把它们统一降级成通用码，使 userFacingError 中对应的友好文案永远无法命中。
 */
const piRuntimeWorkerErrorCodePattern = /^[A-Za-z][A-Za-z0-9_-]{0,119}$/u;

/** 这两个码只表示「Pi 侧失败了」，本身不含原因，因此允许用正文还原更精确的原因。 */
const piGenericFailureCodes = new Set(['ZEUS_PI_WORKER_OPERATION_FAILED', 'ZEUS_PI_MODEL_REQUEST_FAILED']);

/**
 * Pi 只把供应商的 HTTP 响应压成「状态码: 响应体」纯文本（例如 `400: {"message":"This model's maximum context length is ..."}`），
 * 既不保留供应商错误码，也没有结构化字段。这里按 HTTP 语义还原成 Zeus 已解释的标准码，
 * 否则上游只会看到笼统的「Pi 失败了」，userFacingError 里超窗、余额、限流、鉴权的文案永远无法命中。
 */
function piProviderFailureCode(message: string): string | null {
  /** 状态码未必在开头：Pi 会写成 `Summarization failed: 400: {...}`，故按 4xx/5xx 三位数定位并排除长数字内的片段。 */
  const status = /(?:^|[^\d])([45]\d{2})(?![\d])/u.exec(message)?.[1];
  if (!status) return null;
  if (status === '401' || status === '403') return 'authentication_error';
  if (status === '402') return /insufficient|balance|quota|billing|credit/iu.test(message) ? 'insufficient_quota' : 'permission_denied';
  if (status === '429') return 'rate_limit_exceeded';
  if (status === '400' && /maximum context length|context length|too many tokens|exceeds? .{0,24}context/iu.test(message)) return 'context_length_exceeded';
  return null;
}

/** 保留供应商或 Zeus 自带的精确错误码；只有笼统失败码才回退到按正文还原。 */
function resolvePiRuntimeWorkerErrorCode(record: Record<string, unknown>, message: string): string {
  const declared = typeof record.code === 'string' && piRuntimeWorkerErrorCodePattern.test(record.code) ? record.code : null;
  if (declared && !piGenericFailureCodes.has(declared)) return declared;
  return piProviderFailureCode(message) ?? declared ?? 'ZEUS_PI_WORKER_OPERATION_FAILED';
}

export function serializePiRuntimeWorkerError(error: unknown): PiRuntimeWorkerWireError {
  const record = isRecord(error) ? error : {};
  const message = error instanceof Error ? error.message : typeof record.message === 'string' ? record.message : 'Pi Worker 操作失败。';
  return { code: resolvePiRuntimeWorkerErrorCode(record, message), message: sanitizePiRuntimeWorkerDiagnostic(message) };
}

export function piRuntimeWorkerError(error: PiRuntimeWorkerWireError): Error & { code: string } {
  return Object.assign(new Error(sanitizePiRuntimeWorkerDiagnostic(error.message)), { code: error.code });
}

/** IPC 诊断只允许传递短文本，并抹除常见凭据形态；已知凭据值由调用方再做精确替换。 */
export function sanitizePiRuntimeWorkerDiagnostic(message: string): string {
  return message
    .replace(/(?:sk|key|token)-[A-Za-z0-9_.-]{12,}/gu, '[凭据已隐藏]')
    .replace(/((?:authorization|api[-_ ]?key|token)\s*[:=]\s*)[^\s,;]+/giu, '$1[凭据已隐藏]')
    .slice(0, 2_000);
}

function isEnvelope(value: unknown): value is Record<string, unknown> & PiRuntimeWorkerEnvelope {
  return (
    isRecord(value) &&
    value.protocolVersion === piRuntimeWorkerProtocolVersion &&
    typeof value.generationId === 'string' &&
    value.generationId.length > 0 &&
    typeof value.kind === 'string' &&
    (value.traceIdentity === undefined || value.traceIdentity === null || isPerformanceTraceIdentity(value.traceIdentity))
  );
}

function isResponse(value: Record<string, unknown>): boolean {
  if (typeof value.id !== 'string' || typeof value.ok !== 'boolean') return false;
  if (value.ok) return !('error' in value) || value.error === undefined;
  return isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

function isWorkerMethod(value: unknown): value is PiRuntimeWorkerMethod {
  return (
    value === 'initialize' ||
    value === 'probe' ||
    value === 'readCapabilities' ||
    value === 'openSession' ||
    value === 'resumeSession' ||
    value === 'startRun' ||
    value === 'steerRun' ||
    value === 'followUp' ||
    value === 'compactSession' ||
    value === 'importPortableHistory' ||
    value === 'interruptRun' ||
    value === 'respondToInteraction' ||
    value === 'readSession' ||
    value === 'recover' ||
    value === 'reviewPermission' ||
    value === 'invalidateModelRuntime' ||
    value === 'close'
  );
}

function isReverseMethod(value: unknown): value is PiRuntimeWorkerReverseMethod {
  return value === 'load_connections' || value === 'tool_execute' || value === 'tool_respond' || value === 'run_acceptance' || value === 'run_rejected' || value === 'provider_payload_observed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
