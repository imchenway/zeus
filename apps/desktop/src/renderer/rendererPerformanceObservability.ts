import type { ProfilerOnRenderCallback } from 'react';
import type { ZeusClientPerformanceSpan } from './apiClient.js';
import { completeConversationNavigationTrace, readyConversationNavigationTrace } from './performanceTraceContext.js';

const rendererPerformanceCapacity = 2_048;

export type RendererPerformanceSample =
  | ({ kind: 'api' } & ZeusClientPerformanceSpan)
  | {
      kind: 'react_commit';
      componentId: string;
      phase: 'mount' | 'update' | 'nested-update';
      actualDurationMs: number;
      baseDurationMs: number;
      commitTimeMs: number;
      traceId: string | null;
      completedAt: string;
    }
  | {
      kind: 'conversation_first_frame';
      name: 'conversation-first-content-frame';
      traceId: string;
      snapshotSucceeded: boolean | null;
      startTimeMs: number;
      durationMs: number;
      completedAt: string;
    }
  | {
      kind: 'long_task' | 'paint' | 'first_content_frame';
      name: string;
      startTimeMs: number;
      durationMs: number;
      completedAt: string;
    };

export interface RendererPerformanceSnapshot {
  capacity: number;
  sampleCount: number;
  generatedAt: string;
  conversationNavigationLatency: RendererLatencyPercentiles;
  samples: RendererPerformanceSample[];
}

export interface RendererLatencyPercentiles {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

/**
 * Renderer 性能采样只保存在当前窗口的有界内存中。
 *
 * 不保存 DOM、会话正文、URL 参数或用户输入；窗口关闭后允许丢失。正式验收通过
 * `snapshot()` 在隔离 Test 现场提取，不把诊断投影混入业务事实或长期 Memory。
 */
export class RendererPerformanceCollector {
  private readonly samples: RendererPerformanceSample[] = [];
  private readonly observers: PerformanceObserver[] = [];
  private pendingConversationFrameTraceId: string | null = null;
  private firstContentFrameRecorded = false;

  readonly onApiSpan = (span: ZeusClientPerformanceSpan): void => {
    this.append({ kind: 'api', ...span });
  };

  readonly onReactRender: ProfilerOnRenderCallback = (componentId, phase, actualDuration, baseDuration, _startTime, commitTime): void => {
    const navigation = readyConversationNavigationTrace();
    this.append({
      kind: 'react_commit',
      componentId,
      phase,
      actualDurationMs: roundMetric(actualDuration),
      baseDurationMs: roundMetric(baseDuration),
      commitTimeMs: roundMetric(commitTime),
      traceId: navigation?.traceId ?? null,
      completedAt: new Date().toISOString(),
    });
    if (navigation && this.pendingConversationFrameTraceId !== navigation.traceId) this.scheduleConversationFirstFrame(navigation.traceId);
  };

  install(): void {
    if (typeof PerformanceObserver !== 'function') return;
    this.observeEntryType('longtask', 'long_task');
    this.observeEntryType('paint', 'paint');
  }

  recordFirstContentFrame(startedAtMs: number): void {
    if (this.firstContentFrameRecorded) return;
    this.firstContentFrameRecorded = true;
    const completedAtMs = performance.now();
    const sample: RendererPerformanceSample = {
      kind: 'first_content_frame',
      name: 'renderer-first-content-frame',
      startTimeMs: roundMetric(startedAtMs),
      durationMs: roundMetric(Math.max(0, completedAtMs - startedAtMs)),
      completedAt: new Date().toISOString(),
    };
    this.append(sample);
    recordPerformanceMeasure('zeus.renderer.first-content-frame', sample.startTimeMs, sample.durationMs, sample);
  }

  snapshot(): RendererPerformanceSnapshot {
    const conversationNavigationDurations = this.samples.flatMap((sample) => (sample.kind === 'conversation_first_frame' ? [sample.durationMs] : []));
    return {
      capacity: rendererPerformanceCapacity,
      sampleCount: this.samples.length,
      generatedAt: new Date().toISOString(),
      conversationNavigationLatency: latencyPercentiles(conversationNavigationDurations),
      samples: [...this.samples],
    };
  }

  disconnect(): void {
    for (const observer of this.observers) observer.disconnect();
    this.observers.length = 0;
  }

  private observeEntryType(entryType: string, kind: 'long_task' | 'paint'): void {
    if (!PerformanceObserver.supportedEntryTypes.includes(entryType)) return;
    const observer = new PerformanceObserver((entryList) => {
      for (const entry of entryList.getEntries()) {
        const sample: RendererPerformanceSample = {
          kind,
          name: entry.name,
          startTimeMs: roundMetric(entry.startTime),
          durationMs: roundMetric(entry.duration),
          completedAt: new Date().toISOString(),
        };
        this.append(sample);
      }
    });
    observer.observe({ type: entryType, buffered: true });
    this.observers.push(observer);
  }

  private append(sample: RendererPerformanceSample): void {
    this.samples.push(sample);
    if (this.samples.length > rendererPerformanceCapacity) this.samples.splice(0, this.samples.length - rendererPerformanceCapacity);
  }

  private scheduleConversationFirstFrame(traceId: string): void {
    this.pendingConversationFrameTraceId = traceId;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (this.pendingConversationFrameTraceId === traceId) this.pendingConversationFrameTraceId = null;
        const navigation = completeConversationNavigationTrace(traceId);
        if (!navigation) return;
        const completedAtMs = performance.now();
        const sample: RendererPerformanceSample = {
          kind: 'conversation_first_frame',
          name: 'conversation-first-content-frame',
          traceId,
          snapshotSucceeded: navigation.snapshotSucceeded,
          startTimeMs: roundMetric(navigation.startedAtMs),
          durationMs: roundMetric(Math.max(0, completedAtMs - navigation.startedAtMs)),
          completedAt: new Date().toISOString(),
        };
        this.append(sample);
        recordPerformanceMeasure('zeus.renderer.conversation-first-content-frame', sample.startTimeMs, sample.durationMs, sample);
      });
    });
  }
}

function recordPerformanceMeasure(name: string, start: number, duration: number, detail: unknown): void {
  try {
    performance.measure(name, { start, duration, detail });
  } catch {
    // Performance Timeline 不可用不影响 Renderer；有界采样仍保留同一数值。
  }
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function latencyPercentiles(values: readonly number[]): RendererLatencyPercentiles {
  if (values.length === 0) return { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null };
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = (ratio: number): number => ordered[Math.max(0, Math.ceil(ordered.length * ratio) - 1)]!;
  return {
    sampleCount: ordered.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    p99Ms: percentile(0.99),
  };
}
