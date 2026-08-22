import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { enterDatabasePerformanceTrace } from '@zeus/storage';
import { normalizePerformanceTraceIdentity } from '@zeus/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const defaultSampleCapacity = 4_096;

interface ActiveRequestTrace {
  traceId: string;
  startedAt: number;
  responseBytes: number | null;
  disposeLifecycle: () => void;
}

export interface LocalApiPerformanceSample {
  traceId: string;
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
  responseBytes: number | null;
  completedAt: string;
}

export interface LocalApiPerformanceSummary {
  capturedSampleCount: number;
  capacity: number;
  generatedAt: string;
  operations: Array<{
    operation: string;
    sampleCount: number;
    durationMs: { p50: number; p95: number; p99: number; max: number };
    responseBytes: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
  }>;
  recent: LocalApiPerformanceSample[];
  coreRuntime: {
    processUptimeSeconds: number;
    eventLoopUtilization: number;
    eventLoopDelayMs: { count: number; min: number | null; max: number | null; mean: number | null; p50: number | null; p95: number | null; p99: number | null };
    memoryBytes: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
  };
}

/**
 * 本机 API 的有界、无正文性能采样器。
 *
 * 仅保留路由模板、时延、状态和响应字节，不记录 URL 参数、请求体、响应体或授权头。
 * 该环形内存投影用于现场校准，不是审计事实，Core 重启后允许丢失。
 */
export class LocalApiPerformanceCollector {
  private readonly active = new WeakMap<FastifyRequest, ActiveRequestTrace>();
  private readonly activeTraceIds = new Set<string>();
  private readonly samples: LocalApiPerformanceSample[] = [];
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private readonly initialEventLoopUtilization = performance.eventLoopUtilization();

  constructor(private readonly capacity = defaultSampleCapacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Performance sample capacity must be a positive integer.');
    this.eventLoopDelay.enable();
  }

  begin(request: FastifyRequest, reply: FastifyReply): string {
    const supplied = firstHeaderValue(request.headers['x-zeus-trace-id']);
    const normalizedSupplied = normalizePerformanceTraceIdentity(supplied);
    // 只继承固定格式的无正文身份；并发复用同一身份会改由 Core 生成，避免两个请求混入同一关联链。
    const traceId = normalizedSupplied && !this.activeTraceIds.has(normalizedSupplied) ? normalizedSupplied : randomUUID();
    // onRequest 已处于 Fastify 为本次请求建立的异步作用域；只把校验后的无正文身份
    // 传给 Storage，Repository 内同步或异步执行的 SQLite 样本都会继承且不会跨请求串线。
    enterDatabasePerformanceTrace(traceId);
    this.activeTraceIds.add(traceId);
    const abandon = () => this.abandon(request);
    request.raw.once('aborted', abandon);
    reply.raw.once('close', abandon);
    this.active.set(request, {
      traceId,
      startedAt: performance.now(),
      responseBytes: null,
      disposeLifecycle: () => {
        request.raw.off('aborted', abandon);
        reply.raw.off('close', abandon);
      },
    });
    reply.header('x-zeus-trace-id', traceId);
    return traceId;
  }

  capturePayload(request: FastifyRequest, reply: FastifyReply, payload: unknown): void {
    const trace = this.active.get(request);
    if (!trace) return;
    trace.responseBytes = payloadByteLength(payload, reply);
    const elapsed = performance.now() - trace.startedAt;
    reply.header('server-timing', `zeus_core;dur=${elapsed.toFixed(2)}`);
    reply.header('x-zeus-trace-id', trace.traceId);
  }

  finish(request: FastifyRequest, reply: FastifyReply): void {
    const trace = this.active.get(request);
    if (!trace) return;
    this.release(request, trace);
    const sample: LocalApiPerformanceSample = {
      traceId: trace.traceId,
      method: request.method,
      route: routeTemplate(request),
      statusCode: reply.statusCode,
      durationMs: roundMetric(performance.now() - trace.startedAt),
      responseBytes: trace.responseBytes,
      completedAt: new Date().toISOString(),
    };
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
  }

  snapshot(options: { route?: string; recentLimit?: number } = {}): LocalApiPerformanceSummary {
    const filtered = options.route ? this.samples.filter((sample) => sample.route === options.route) : [...this.samples];
    const grouped = new Map<string, LocalApiPerformanceSample[]>();
    for (const sample of filtered) {
      const operation = `${sample.method} ${sample.route}`;
      const entries = grouped.get(operation);
      if (entries) entries.push(sample);
      else grouped.set(operation, [sample]);
    }
    const operations = [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([operation, entries]) => {
        const durations = entries.map((entry) => entry.durationMs).sort((left, right) => left - right);
        const byteLengths = entries.flatMap((entry) => (entry.responseBytes === null ? [] : [entry.responseBytes])).sort((left, right) => left - right);
        return {
          operation,
          sampleCount: entries.length,
          durationMs: summarizeNumbers(durations),
          responseBytes: byteLengths.length > 0 ? summarizeNumbers(byteLengths) : { p50: null, p95: null, p99: null, max: null },
        };
      });
    const recentLimit = clampInteger(options.recentLimit ?? 100, 0, 500);
    return {
      capturedSampleCount: filtered.length,
      capacity: this.capacity,
      generatedAt: new Date().toISOString(),
      operations,
      recent: recentLimit === 0 ? [] : filtered.slice(-recentLimit).reverse(),
      coreRuntime: this.coreRuntimeSnapshot(),
    };
  }

  close(): void {
    this.activeTraceIds.clear();
    this.eventLoopDelay.disable();
  }

  /** 客户端断连不会进入 onResponse；必须独立释放并发 trace 身份且不得形成成功样本。 */
  private abandon(request: FastifyRequest): void {
    const trace = this.active.get(request);
    if (!trace) return;
    this.release(request, trace);
  }

  private release(request: FastifyRequest, trace: ActiveRequestTrace): void {
    this.active.delete(request);
    this.activeTraceIds.delete(trace.traceId);
    trace.disposeLifecycle();
  }

  private coreRuntimeSnapshot(): LocalApiPerformanceSummary['coreRuntime'] {
    const hasDelaySamples = this.eventLoopDelay.count > 0;
    const memory = process.memoryUsage();
    return {
      processUptimeSeconds: roundMetric(process.uptime()),
      eventLoopUtilization: roundMetric(performance.eventLoopUtilization(this.initialEventLoopUtilization).utilization),
      eventLoopDelayMs: {
        count: this.eventLoopDelay.count,
        min: hasDelaySamples ? nanosecondsToMilliseconds(this.eventLoopDelay.min) : null,
        max: hasDelaySamples ? nanosecondsToMilliseconds(this.eventLoopDelay.max) : null,
        mean: hasDelaySamples ? nanosecondsToMilliseconds(this.eventLoopDelay.mean) : null,
        p50: hasDelaySamples ? nanosecondsToMilliseconds(this.eventLoopDelay.percentile(50)) : null,
        p95: hasDelaySamples ? nanosecondsToMilliseconds(this.eventLoopDelay.percentile(95)) : null,
        p99: hasDelaySamples ? nanosecondsToMilliseconds(this.eventLoopDelay.percentile(99)) : null,
      },
      memoryBytes: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
    };
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

function routeTemplate(request: FastifyRequest): string {
  const route = request.routeOptions?.url;
  if (typeof route === 'string' && route) return route;
  try {
    return new URL(request.url, 'http://127.0.0.1').pathname;
  } catch {
    return '/unresolved';
  }
}

function payloadByteLength(payload: unknown, reply: FastifyReply): number | null {
  if (typeof payload === 'string') return Buffer.byteLength(payload);
  if (Buffer.isBuffer(payload)) return payload.byteLength;
  if (payload instanceof Uint8Array) return payload.byteLength;
  const contentLength = reply.getHeader('content-length');
  const parsed = typeof contentLength === 'number' ? contentLength : typeof contentLength === 'string' ? Number(contentLength) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function summarizeNumbers(values: number[]): { p50: number; p95: number; p99: number; max: number } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: roundMetric(values.at(-1) ?? 0),
  };
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return roundMetric(sortedValues[index] ?? 0);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function nanosecondsToMilliseconds(value: number): number {
  return roundMetric(value / 1_000_000);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
