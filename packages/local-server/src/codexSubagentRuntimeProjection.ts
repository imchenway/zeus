import { createReadStream } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative } from 'node:path';
import type { CodexThreadSnapshot } from '@zeus/ai-runtime';
import { calculateCacheHitRate, estimateCodexUsage, type TokenUsageBreakdown } from '@zeus/shared';

export const codexSubagentRuntimeMaximumJsonlBytes = 512 * 1024 * 1024;
export const codexSubagentRuntimeMaximumJsonlLineBytes = 16 * 1024 * 1024;

export type SubagentRuntimeFact<T> = { state: 'available'; value: T } | { state: 'unavailable'; reason: string };

export interface SubagentRuntimeDetails {
  model: SubagentRuntimeFact<string>;
  effort: SubagentRuntimeFact<string>;
  serviceTier: SubagentRuntimeFact<string | null>;
  usage: {
    serviceTier: SubagentRuntimeFact<string | null>;
    totalTokens: SubagentRuntimeFact<number>;
    inputTokens: SubagentRuntimeFact<number>;
    outputTokens: SubagentRuntimeFact<number>;
    reasoningOutputTokens: SubagentRuntimeFact<number>;
    contextTokens: SubagentRuntimeFact<number>;
    contextWindow: SubagentRuntimeFact<number>;
    cacheHitRate: SubagentRuntimeFact<number>;
    apiEquivalentUsd: SubagentRuntimeFact<number>;
    priceCoverage: SubagentRuntimeFact<number>;
    pricingCatalogDate: SubagentRuntimeFact<string>;
    pricingSourceUrls: SubagentRuntimeFact<string[]>;
    historyComplete: SubagentRuntimeFact<boolean>;
  };
  performance: {
    latestOutputTokensPerSecond: SubagentRuntimeFact<number>;
    latestFirstVisibleResponseMs: SubagentRuntimeFact<number>;
    cumulativeProcessedDurationMs: SubagentRuntimeFact<number>;
  };
  activity: {
    turnCount: SubagentRuntimeFact<number>;
    modelRequestCount: SubagentRuntimeFact<number>;
    toolOrCommandCount: SubagentRuntimeFact<number>;
    retryCount: SubagentRuntimeFact<number>;
    failedTurnCount: SubagentRuntimeFact<number>;
  };
  changeSummary: SubagentRuntimeFact<{ fileCount: number; addedLines: number; deletedLines: number; complete: boolean }>;
  environment: {
    cwd: SubagentRuntimeFact<string>;
    branch: SubagentRuntimeFact<string>;
    nativeSessionId: SubagentRuntimeFact<string>;
    nativeSessionPath: SubagentRuntimeFact<string>;
  };
}

export interface CodexSubagentRuntimeReadPort {
  read(input: { thread: CodexThreadSnapshot; ownedTurns: Record<string, unknown>[] }): Promise<SubagentRuntimeDetails>;
}

interface CreateCodexSubagentRuntimeReaderOptions {
  providerHistoryRoot: string;
  maximumBytes?: number;
  maximumLineBytes?: number;
}

interface RuntimeContext {
  model: string | null;
  effort: string | null;
  serviceTier: string | null;
  hasServiceTier: boolean;
  cwd: string | null;
}

interface RuntimeScanState {
  threadId: string;
  requestedPath: string;
  realPath: string;
  device: number;
  inode: number;
  offset: number;
  pending: Buffer;
  lineNumber: number;
  firstLineValidated: boolean;
  ownedTurnIdsSignature: string;
  ownedBoundaryStarted: boolean;
  baselineEstablished: boolean;
  latestBeforeBoundaryTotal: TokenUsageBreakdown | null;
  baselineTotal: TokenUsageBreakdown | null;
  latestTotal: TokenUsageBreakdown | null;
  latestLast: TokenUsageBreakdown | null;
  modelContextWindow: number | null;
  runtimeContext: RuntimeContext | null;
  modelRequestKeys: Set<string>;
  retryCount: number;
  retryComplete: boolean;
}

interface RuntimeScanResult {
  state: RuntimeScanState | null;
  reason: string | null;
}

const toolOrCommandItemTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'fileChange']);

export function createCodexSubagentRuntimeReader(options: CreateCodexSubagentRuntimeReaderOptions): CodexSubagentRuntimeReadPort {
  const maximumBytes = options.maximumBytes ?? codexSubagentRuntimeMaximumJsonlBytes;
  const maximumLineBytes = options.maximumLineBytes ?? codexSubagentRuntimeMaximumJsonlLineBytes;
  const cache = new Map<string, RuntimeScanState>();
  let historyRootPromise: Promise<string> | null = null;

  async function historyRoot(): Promise<string> {
    historyRootPromise ??= realpath(options.providerHistoryRoot);
    return historyRootPromise;
  }

  async function read(input: { thread: CodexThreadSnapshot; ownedTurns: Record<string, unknown>[] }): Promise<SubagentRuntimeDetails> {
    const scan = await scanRuntime(input.thread, input.ownedTurns).catch((error: unknown) => {
      cache.delete(input.thread.id);
      return { state: null, reason: error instanceof Error ? error.message : 'Provider JSONL 运行事实读取失败。' } satisfies RuntimeScanResult;
    });
    return toRuntimeDetails(input.thread, input.ownedTurns, scan);
  }

  async function scanRuntime(thread: CodexThreadSnapshot, ownedTurns: Record<string, unknown>[]): Promise<RuntimeScanResult> {
    const requestedPath = typeof thread.path === 'string' && thread.path.trim() ? thread.path : null;
    if (!requestedPath) return { state: null, reason: 'Codex 线程未提供可核验的 JSONL 路径。' };
    if (!isAbsolute(requestedPath)) return { state: null, reason: 'Codex 线程 JSONL 路径不是绝对路径。' };
    const pathMetadata = await lstat(requestedPath);
    if (pathMetadata.isSymbolicLink()) return { state: null, reason: 'Codex 线程 JSONL 路径不允许使用符号链接。' };
    const [root, resolvedPath] = await Promise.all([historyRoot(), realpath(requestedPath)]);
    if (!pathInsideRoot(root, resolvedPath)) return { state: null, reason: 'Codex 线程 JSONL 路径不在隔离 Provider 历史根内。' };
    const metadata = await stat(resolvedPath);
    if (!metadata.isFile()) return { state: null, reason: 'Codex 线程 JSONL 路径不是普通文件。' };
    if (!Number.isSafeInteger(metadata.size) || metadata.size > maximumBytes) return { state: null, reason: `Codex 线程 JSONL 超过 ${maximumBytes} bytes 有界扫描上限。` };

    const ownedTurnIds = new Set(ownedTurns.flatMap((turn) => (typeof turn.id === 'string' ? [turn.id] : [])));
    const signature = [...ownedTurnIds].sort().join('\n');
    const state = cache.get(thread.id) ?? null;
    const identityChanged =
      !state ||
      state.requestedPath !== requestedPath ||
      state.realPath !== resolvedPath ||
      state.device !== metadata.dev ||
      state.inode !== metadata.ino ||
      metadata.size < state.offset ||
      (!state.ownedBoundaryStarted && state.ownedTurnIdsSignature !== signature);
    const activeState = identityChanged ? initialScanState(thread.id, requestedPath, resolvedPath, metadata.dev, metadata.ino, signature) : state;
    if (!activeState) return { state: null, reason: 'Codex 线程 JSONL 增量扫描状态不可用。' };
    if (metadata.size > activeState.offset) await appendFileRange(activeState, metadata.size, ownedTurnIds);
    cache.set(thread.id, activeState);
    if (!activeState.firstLineValidated) return { state: null, reason: 'Codex 线程 JSONL 首行身份尚未完整落盘。' };
    if (!activeState.ownedBoundaryStarted) return { state: activeState, reason: '尚未在 Provider JSONL 中确认子线程自身 turn_context。' };
    return { state: activeState, reason: null };
  }

  async function appendFileRange(state: RuntimeScanState, targetSize: number, ownedTurnIds: Set<string>): Promise<void> {
    const stream = createReadStream(state.realPath, { start: state.offset, end: targetSize - 1, highWaterMark: 1024 * 1024 });
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      state.offset += chunk.length;
      const data = state.pending.length === 0 ? chunk : Buffer.concat([state.pending, chunk]);
      let cursor = 0;
      while (true) {
        const newlineIndex = data.indexOf(0x0a, cursor);
        if (newlineIndex < 0) break;
        const line = data.subarray(cursor, newlineIndex + 1);
        consumeLine(state, trimLineEnding(line), ownedTurnIds);
        cursor = newlineIndex + 1;
      }
      state.pending = data.subarray(cursor);
      if (state.pending.length > maximumLineBytes) throw runtimeError(`Provider JSONL 单行超过 ${maximumLineBytes} bytes 上限。`);
    }
  }

  function consumeLine(state: RuntimeScanState, bytes: Buffer, ownedTurnIds: Set<string>): void {
    state.lineNumber += 1;
    if (bytes.length > maximumLineBytes) throw runtimeError(`Provider JSONL 第 ${state.lineNumber} 行超过 ${maximumLineBytes} bytes 上限。`);
    if (bytes.length === 0) {
      if (!state.firstLineValidated) throw runtimeError('Provider JSONL 首行没有可核验的线程身份。');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw runtimeError(`Provider JSONL 第 ${state.lineNumber} 行不是有效 JSON。`);
    }
    if (!isRecord(value)) throw runtimeError(`Provider JSONL 第 ${state.lineNumber} 行不是对象。`);
    if (!state.firstLineValidated) {
      const payload = isRecord(value.payload) ? value.payload : {};
      if (value.type !== 'session_meta' || payload.id !== state.threadId) throw runtimeError('Provider JSONL 首行线程身份与请求的 Subagent 不匹配。');
      state.firstLineValidated = true;
      return;
    }
    const payload = isRecord(value.payload) ? value.payload : {};
    if (value.type === 'turn_context') {
      const turnId = stringValue(payload.turn_id, payload.turnId);
      if (!state.ownedBoundaryStarted && turnId && ownedTurnIds.has(turnId)) {
        state.ownedBoundaryStarted = true;
        state.baselineEstablished = true;
        state.baselineTotal = state.latestBeforeBoundaryTotal ?? emptyBreakdown();
      }
      if (state.ownedBoundaryStarted) state.runtimeContext = runtimeContext(payload, state.runtimeContext);
      return;
    }
    const tokenUsage = tokenCountPayload(value, payload);
    if (!tokenUsage) return;
    if (!state.ownedBoundaryStarted) {
      state.latestBeforeBoundaryTotal = tokenUsage.total;
      return;
    }
    state.latestTotal = tokenUsage.total;
    state.latestLast = tokenUsage.last;
    state.modelContextWindow = tokenUsage.modelContextWindow;
    const requestKey = breakdownKey(tokenUsage.total);
    if (!state.modelRequestKeys.has(requestKey)) {
      state.modelRequestKeys.add(requestKey);
      const requestKind = stringValue(tokenUsage.requestKind);
      if (requestKind === 'retry') state.retryCount += 1;
      if (!requestKind) state.retryComplete = false;
    }
  }

  return { read };
}

function toRuntimeDetails(thread: CodexThreadSnapshot, ownedTurns: Record<string, unknown>[], scan: RuntimeScanResult): SubagentRuntimeDetails {
  const state = scan.state;
  const scanReason = scan.reason ?? 'Provider JSONL 运行事实不可用。';
  const context = state?.runtimeContext ?? null;
  const usage = state?.baselineEstablished && state.baselineTotal && state.latestTotal ? subtractBreakdown(state.latestTotal, state.baselineTotal) : null;
  const usageReason = usage ? null : state?.ownedBoundaryStarted ? '子线程尚未产生可读的 token_count。' : scanReason;
  const contextReason = state?.ownedBoundaryStarted ? '子线程自身 turn_context 未提供该运行配置。' : scanReason;
  const model: SubagentRuntimeFact<string> = context?.model ? available(context.model) : unavailable(contextReason);
  const effort: SubagentRuntimeFact<string> = context?.effort ? available(context.effort) : unavailable(contextReason);
  const serviceTier: SubagentRuntimeFact<string | null> = context?.hasServiceTier ? available(context.serviceTier) : unavailable(contextReason);
  const last = state?.latestLast ?? null;
  const estimate = usage && model.state === 'available' ? estimateCodexUsage({ model: model.value, serviceTier: serviceTier.state === 'available' ? serviceTier.value : null, usage }) : null;
  const activity = activityFacts(ownedTurns, state, scanReason);
  const changeSummary = changeFacts(ownedTurns);
  const gitInfo = isRecord(thread.gitInfo) ? thread.gitInfo : {};
  const cwd = context?.cwd ?? (typeof thread.cwd === 'string' && thread.cwd.trim() ? thread.cwd : null);
  const nativeSessionPath = state?.firstLineValidated ? state.realPath : null;
  const noRequestTiming = '子线程历史没有完整的模型请求时序边界。';
  return {
    model,
    effort,
    serviceTier,
    usage: {
      serviceTier,
      totalTokens: usageFact(usage?.totalTokens, usageReason),
      inputTokens: usageFact(usage?.inputTokens, usageReason),
      outputTokens: usageFact(usage?.outputTokens, usageReason),
      reasoningOutputTokens: usageFact(usage?.reasoningOutputTokens, usageReason),
      contextTokens: usageFact(last?.totalTokens, usageReason),
      contextWindow: usageFact(state?.modelContextWindow, usageReason),
      cacheHitRate: usage ? nullableFact(calculateCacheHitRate(usage), '子线程输入 Token 为 0，无法计算缓存命中率。') : unavailable(usageReason ?? scanReason),
      apiEquivalentUsd: estimate?.apiEquivalentUsd === null || estimate?.apiEquivalentUsd === undefined ? unavailable(estimate ? '当前模型没有可用的 API 等价价格。' : (usageReason ?? scanReason)) : available(estimate.apiEquivalentUsd),
      priceCoverage: estimate?.coverage === null || estimate?.coverage === undefined ? unavailable(estimate ? '当前用量没有可计算的计价覆盖率。' : (usageReason ?? scanReason)) : available(estimate.coverage),
      pricingCatalogDate: estimate ? available(estimate.rateSnapshot.catalogDate) : unavailable(usageReason ?? scanReason),
      pricingSourceUrls: estimate ? available([...estimate.rateSnapshot.sourceUrls]) : unavailable(usageReason ?? scanReason),
      historyComplete: usage ? available(true) : unavailable(usageReason ?? scanReason),
    },
    performance: {
      latestOutputTokensPerSecond: unavailable(noRequestTiming),
      latestFirstVisibleResponseMs: unavailable(noRequestTiming),
      cumulativeProcessedDurationMs: unavailable('子线程历史没有审批与用户等待区间，不使用轮次总耗时冒充处理耗时。'),
    },
    activity: {
      turnCount: available(ownedTurns.length),
      modelRequestCount: activity.modelRequestCount,
      toolOrCommandCount: activity.toolOrCommandCount,
      retryCount: activity.retryCount,
      failedTurnCount: activity.failedTurnCount,
    },
    changeSummary,
    environment: {
      cwd: cwd ? available(cwd) : unavailable('子线程未提供工作目录。'),
      branch: typeof gitInfo.branch === 'string' && gitInfo.branch.trim() ? available(gitInfo.branch) : unavailable('子线程未提供 Git 分支。'),
      nativeSessionId: available(thread.id),
      nativeSessionPath: nativeSessionPath ? available(nativeSessionPath) : unavailable(scanReason),
    },
  };
}

function activityFacts(
  ownedTurns: Record<string, unknown>[],
  state: RuntimeScanState | null,
  scanReason: string,
): {
  modelRequestCount: SubagentRuntimeFact<number>;
  toolOrCommandCount: SubagentRuntimeFact<number>;
  retryCount: SubagentRuntimeFact<number>;
  failedTurnCount: SubagentRuntimeFact<number>;
} {
  let toolOrCommandCount = 0;
  let failedTurnCount = 0;
  const seenItemIds = new Set<string>();
  for (const turn of ownedTurns) {
    if (turn.status === 'failed' || turn.status === 'errored' || (turn.error !== undefined && turn.error !== null)) failedTurnCount += 1;
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (!isRecord(item) || typeof item.type !== 'string' || !toolOrCommandItemTypes.has(item.type)) continue;
      const identity = typeof item.id === 'string' ? item.id : `${String(turn.id)}:${item.type}:${toolOrCommandCount}`;
      if (seenItemIds.has(identity)) continue;
      seenItemIds.add(identity);
      toolOrCommandCount += 1;
    }
  }
  const requestCount: SubagentRuntimeFact<number> = state?.ownedBoundaryStarted ? available(state.modelRequestKeys.size) : unavailable(scanReason);
  const retryCount: SubagentRuntimeFact<number> = !state?.ownedBoundaryStarted
    ? unavailable(scanReason)
    : state.modelRequestKeys.size === 0
      ? unavailable('子线程尚未产生模型请求。')
      : state.retryComplete
        ? available(state.retryCount)
        : unavailable('历史 token_count 没有完整的 requestKind，无法确认重试次数。');
  return { modelRequestCount: requestCount, toolOrCommandCount: available(toolOrCommandCount), retryCount, failedTurnCount: available(failedTurnCount) };
}

function changeFacts(ownedTurns: Record<string, unknown>[]): SubagentRuntimeDetails['changeSummary'] {
  const paths = new Set<string>();
  let addedLines = 0;
  let deletedLines = 0;
  let complete = true;
  for (const turn of ownedTurns) {
    for (const item of Array.isArray(turn.items) ? turn.items : []) {
      if (!isRecord(item) || item.type !== 'fileChange') continue;
      if (!Array.isArray(item.changes)) {
        complete = false;
        continue;
      }
      for (const change of item.changes) {
        if (!isRecord(change)) {
          complete = false;
          continue;
        }
        if (typeof change.path === 'string' && change.path.trim()) paths.add(change.path);
        else complete = false;
        if (typeof change.diff !== 'string') {
          complete = false;
          continue;
        }
        const lines = diffLineCounts(change.diff);
        addedLines += lines.added;
        deletedLines += lines.deleted;
      }
    }
  }
  return available({ fileCount: paths.size, addedLines, deletedLines, complete });
}

function runtimeContext(payload: Record<string, unknown>, previous: RuntimeContext | null): RuntimeContext {
  const model = stringValue(payload.model) ?? previous?.model ?? null;
  const effort = stringValue(payload.effort, payload.reasoning_effort, payload.reasoningEffort) ?? previous?.effort ?? null;
  const hasServiceTier = Object.prototype.hasOwnProperty.call(payload, 'service_tier') || Object.prototype.hasOwnProperty.call(payload, 'serviceTier') || previous?.hasServiceTier === true;
  const rawServiceTier = Object.prototype.hasOwnProperty.call(payload, 'service_tier') ? payload.service_tier : Object.prototype.hasOwnProperty.call(payload, 'serviceTier') ? payload.serviceTier : previous?.serviceTier;
  const serviceTier = rawServiceTier === null || rawServiceTier === undefined ? null : stringValue(rawServiceTier);
  const cwd = stringValue(payload.cwd) ?? previous?.cwd ?? null;
  return { model, effort, serviceTier, hasServiceTier, cwd };
}

function tokenCountPayload(value: Record<string, unknown>, payload: Record<string, unknown>): { total: TokenUsageBreakdown; last: TokenUsageBreakdown; modelContextWindow: number | null; requestKind: unknown } | null {
  if (value.type !== 'event_msg' || payload.type !== 'token_count') return null;
  const info = isRecord(payload.info) ? payload.info : {};
  const total = parseBreakdown(isRecord(info.total_token_usage) ? info.total_token_usage : isRecord(info.total) ? info.total : null);
  const last = parseBreakdown(isRecord(info.last_token_usage) ? info.last_token_usage : isRecord(info.last) ? info.last : null);
  if (!total || !last) return null;
  const modelContextWindow = safeInteger(info.model_context_window ?? info.modelContextWindow);
  return { total, last, modelContextWindow, requestKind: info.request_kind ?? info.requestKind ?? payload.request_kind ?? payload.requestKind };
}

function parseBreakdown(value: Record<string, unknown> | null): TokenUsageBreakdown | null {
  if (!value) return null;
  const totalTokens = safeInteger(value.total_tokens ?? value.totalTokens);
  const inputTokens = safeInteger(value.input_tokens ?? value.inputTokens);
  const outputTokens = safeInteger(value.output_tokens ?? value.outputTokens);
  if (totalTokens === null || inputTokens === null || outputTokens === null) return null;
  return {
    totalTokens,
    inputTokens,
    cachedInputTokens: safeInteger(value.cached_input_tokens ?? value.cachedInputTokens) ?? 0,
    cacheWriteInputTokens: safeInteger(value.cache_write_input_tokens ?? value.cacheWriteInputTokens) ?? 0,
    outputTokens,
    reasoningOutputTokens: safeInteger(value.reasoning_output_tokens ?? value.reasoningOutputTokens) ?? 0,
  };
}

function subtractBreakdown(total: TokenUsageBreakdown, baseline: TokenUsageBreakdown): TokenUsageBreakdown | null {
  const fields = {
    totalTokens: total.totalTokens - baseline.totalTokens,
    inputTokens: total.inputTokens - baseline.inputTokens,
    cachedInputTokens: total.cachedInputTokens - baseline.cachedInputTokens,
    cacheWriteInputTokens: total.cacheWriteInputTokens - baseline.cacheWriteInputTokens,
    outputTokens: total.outputTokens - baseline.outputTokens,
    reasoningOutputTokens: total.reasoningOutputTokens - baseline.reasoningOutputTokens,
  };
  return Object.values(fields).every((value) => Number.isSafeInteger(value) && value >= 0) ? fields : null;
}

function initialScanState(threadId: string, requestedPath: string, realPath: string, device: number, inode: number, ownedTurnIdsSignature: string): RuntimeScanState {
  return {
    threadId,
    requestedPath,
    realPath,
    device,
    inode,
    offset: 0,
    pending: Buffer.alloc(0),
    lineNumber: 0,
    firstLineValidated: false,
    ownedTurnIdsSignature,
    ownedBoundaryStarted: false,
    baselineEstablished: false,
    latestBeforeBoundaryTotal: null,
    baselineTotal: null,
    latestTotal: null,
    latestLast: null,
    modelContextWindow: null,
    runtimeContext: null,
    modelRequestKeys: new Set(),
    retryCount: 0,
    retryComplete: true,
  };
}

function diffLineCounts(diff: string): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted += 1;
  }
  return { added, deleted };
}

function pathInsideRoot(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return candidate === '' || (!candidate.startsWith('..') && !isAbsolute(candidate));
}

function trimLineEnding(value: Buffer): Buffer {
  const end = value.at(-1) === 0x0a ? value.length - 1 : value.length;
  return end > 0 && value.at(end - 1) === 0x0d ? value.subarray(0, end - 1) : value.subarray(0, end);
}

function breakdownKey(value: TokenUsageBreakdown): string {
  return [value.totalTokens, value.inputTokens, value.cachedInputTokens, value.cacheWriteInputTokens, value.outputTokens, value.reasoningOutputTokens].join(':');
}

function emptyBreakdown(): TokenUsageBreakdown {
  return { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
}

function usageFact(value: number | null | undefined, reason: string | null): SubagentRuntimeFact<number> {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? available(value) : unavailable(reason ?? '运行用量不可用。');
}

function nullableFact<T>(value: T | null, reason: string): SubagentRuntimeFact<T> {
  return value === null ? unavailable(reason) : available(value);
}

function available<T>(value: T): SubagentRuntimeFact<T> {
  return { state: 'available', value };
}

function unavailable<T>(reason: string): SubagentRuntimeFact<T> {
  return { state: 'unavailable', reason };
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runtimeError(message: string): Error {
  return Object.assign(new Error(message), { code: 'ZEUS_CODEX_SUBAGENT_RUNTIME_INVALID' });
}
