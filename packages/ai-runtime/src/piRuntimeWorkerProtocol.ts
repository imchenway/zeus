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
  | 'interruptRun'
  | 'respondToInteraction'
  | 'readSession'
  | 'recover'
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

export function serializePiRuntimeWorkerError(error: unknown): PiRuntimeWorkerWireError {
  const record = isRecord(error) ? error : {};
  const code = typeof record.code === 'string' && /^[A-Z0-9_]{1,120}$/u.test(record.code) ? record.code : 'ZEUS_PI_WORKER_OPERATION_FAILED';
  const message = error instanceof Error ? error.message : typeof record.message === 'string' ? record.message : 'Pi Worker 操作失败。';
  return { code, message: sanitizePiRuntimeWorkerDiagnostic(message) };
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
    value === 'interruptRun' ||
    value === 'respondToInteraction' ||
    value === 'readSession' ||
    value === 'recover' ||
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
