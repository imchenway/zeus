import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  heavyWorkerProtocolVersion,
  type CodeMapHeavyWorkerResult,
  type GitDiffHeavyWorkerResult,
  type GitStatusHeavyWorkerResult,
  type HeavyWorkerInput,
  type HeavyWorkerMessage,
  type HeavyWorkerProgressStage,
  type HeavyWorkerResult,
} from './heavyWorkerContracts.js';

const heavyWorkerConcurrency = 1;
const heavyWorkerQueueLimit = 3;
const heavyWorkerTimeoutMs = 15 * 60_000;
const codeMapWorkerMaxResultBytes = 256 * 1024 * 1024;
const gitDiffWorkerMaxResultBytes = 32 * 1024 * 1024;
const gitStatusWorkerMaxResultBytes = 16 * 1024 * 1024;

interface QueuedHeavyJob {
  jobId: string;
  input: HeavyWorkerInput;
  signal?: AbortSignal;
  resolve: (result: HeavyWorkerResult) => void;
  reject: (error: unknown) => void;
  abortListener?: () => void;
  worker?: Worker;
  timeout?: ReturnType<typeof setTimeout>;
  startedAt?: number;
  finalization?: Promise<void>;
  settled: boolean;
}

export interface HeavyWorkerPoolSnapshot {
  protocolVersion: typeof heavyWorkerProtocolVersion;
  concurrencyLimit: number;
  queueLimit: number;
  acceptingJobs: boolean;
  activeJobs: number;
  queuedJobs: number;
  queueHighWater: number;
  completedJobs: number;
  failedJobs: number;
  cancelledJobs: number;
  timedOutJobs: number;
  completedByKind: Record<HeavyWorkerInput['kind'], number>;
  lastProgress: { jobId: string; stage: HeavyWorkerProgressStage; completedUnits: number; totalUnits: number } | null;
  lastDurationMs: number | null;
}

const queue: QueuedHeavyJob[] = [];
const active = new Map<string, QueuedHeavyJob>();
// 每个普通 Core generation 必须显式 activate；只读验证和模块刚加载时默认失败关闭。
let closed = true;
let queueHighWater = 0;
let completedJobs = 0;
let failedJobs = 0;
let cancelledJobs = 0;
let timedOutJobs = 0;
let completedByKind = emptyCompletedByKind();
let lastProgress: HeavyWorkerPoolSnapshot['lastProgress'] = null;
let lastDurationMs: number | null = null;

export function runCodeMapHeavyJob(rootPath: string, projectName: string, ignoreDirectories: string[], additionalFiles: Array<{ absolutePath: string; relativePath: string }>, signal?: AbortSignal): Promise<CodeMapHeavyWorkerResult> {
  return enqueueHeavyJob(
    {
      protocolVersion: heavyWorkerProtocolVersion,
      jobId: `heavy_${randomUUID()}`,
      kind: 'code_map_scan',
      rootPath,
      projectName,
      ignoreDirectories: [...ignoreDirectories],
      additionalFiles: additionalFiles.map((file) => ({ ...file })),
      maxResultBytes: codeMapWorkerMaxResultBytes,
    },
    isCodeMapResult,
    signal,
  );
}

/** 大型 Git diff 的子进程输出与 unified-diff 解析都在 Worker 内完成；Core 只接收有哈希与字节预算的投影。 */
export function runGitDiffHeavyJob(rootPath: string, signal?: AbortSignal): Promise<GitDiffHeavyWorkerResult> {
  return enqueueHeavyJob(
    {
      protocolVersion: heavyWorkerProtocolVersion,
      jobId: `heavy_${randomUUID()}`,
      kind: 'git_diff',
      rootPath,
      maxResultBytes: gitDiffWorkerMaxResultBytes,
    },
    isGitDiffResult,
    signal,
  );
}

/** 仓库状态/文件统计在 Worker 内完成，避免大量 porcelain 与 commit 元数据解析占用 Core 事件循环。 */
export function runGitStatusHeavyJob(rootPath: string, signal?: AbortSignal): Promise<GitStatusHeavyWorkerResult> {
  return enqueueHeavyJob(
    {
      protocolVersion: heavyWorkerProtocolVersion,
      jobId: `heavy_${randomUUID()}`,
      kind: 'git_status',
      rootPath,
      maxResultBytes: gitStatusWorkerMaxResultBytes,
    },
    isGitStatusResult,
    signal,
  );
}

function enqueueHeavyJob<Result extends HeavyWorkerResult>(input: HeavyWorkerInput, guard: (value: unknown, jobId: string) => value is Result, signal?: AbortSignal): Promise<Result> {
  if (closed) return Promise.reject(heavyWorkerError('ZEUS_HEAVY_WORKER_POOL_CLOSED', 'Heavy Worker 池已经关闭。'));
  if (signal?.aborted) return Promise.reject(heavyWorkerError('ZEUS_HEAVY_WORKER_CANCELLED', 'Heavy Worker 作业在排队前已取消。'));
  if (queue.length >= heavyWorkerQueueLimit) return Promise.reject(heavyWorkerError('ZEUS_HEAVY_WORKER_QUEUE_FULL', 'Heavy Worker 队列已达到高水位，请稍后重试。'));
  return new Promise<Result>((resolve, reject) => {
    const job: QueuedHeavyJob = {
      jobId: input.jobId,
      input,
      ...(signal ? { signal } : {}),
      resolve: (value) => {
        if (!guard(value, input.jobId)) {
          reject(heavyWorkerError('ZEUS_HEAVY_WORKER_RESULT_INVALID', 'Heavy Worker 返回了不符合当前作业类型的投影。'));
          return;
        }
        resolve(value);
      },
      reject,
      settled: false,
    };
    if (signal) {
      job.abortListener = () => cancelJob(job, 'ZEUS_HEAVY_WORKER_CANCELLED', 'Heavy Worker 作业已取消。');
      signal.addEventListener('abort', job.abortListener, { once: true });
    }
    queue.push(job);
    queueHighWater = Math.max(queueHighWater, queue.length);
    pump();
  });
}

export function heavyWorkerPoolSnapshot(): HeavyWorkerPoolSnapshot {
  return {
    protocolVersion: heavyWorkerProtocolVersion,
    concurrencyLimit: heavyWorkerConcurrency,
    queueLimit: heavyWorkerQueueLimit,
    acceptingJobs: !closed,
    activeJobs: active.size,
    queuedJobs: queue.length,
    queueHighWater,
    completedJobs,
    failedJobs,
    cancelledJobs,
    timedOutJobs,
    completedByKind: { ...completedByKind },
    lastProgress: lastProgress ? { ...lastProgress } : null,
    lastDurationMs,
  };
}

/** 同一 Node 进程创建新的 Core generation 时显式重开池；旧 generation 的作业必须已经全部退出。 */
export function activateHeavyWorkerJobs(): void {
  if (!closed) return;
  if (active.size > 0 || queue.length > 0) throw heavyWorkerError('ZEUS_HEAVY_WORKER_GENERATION_BUSY', '旧 Core generation 的 Heavy Worker 尚未全部退出。');
  closed = false;
  queueHighWater = 0;
  completedJobs = 0;
  failedJobs = 0;
  cancelledJobs = 0;
  timedOutJobs = 0;
  completedByKind = emptyCompletedByKind();
  lastProgress = null;
  lastDurationMs = null;
}

export async function closeHeavyWorkerJobs(): Promise<void> {
  closed = true;
  await Promise.all([
    ...[...queue].map((job) => cancelJob(job, 'ZEUS_HEAVY_WORKER_POOL_CLOSED', 'Core 正在关闭，排队中的 Heavy Worker 作业已取消。')),
    ...[...active.values()].map((job) => cancelJob(job, 'ZEUS_HEAVY_WORKER_POOL_CLOSED', 'Core 正在关闭，运行中的 Heavy Worker 作业已取消。')),
  ]);
}

function pump(): void {
  while (!closed && active.size < heavyWorkerConcurrency && queue.length > 0) {
    const job = queue.shift();
    if (!job || job.settled) continue;
    startJob(job);
  }
}

function startJob(job: QueuedHeavyJob): void {
  job.startedAt = Date.now();
  let worker: Worker;
  try {
    worker = new Worker(new URL('./heavyWorkerEntry.js', import.meta.url), {
      // `node -e --input-type` 等父进程探针参数不能继承给文件型 Worker；正式 Electron 参数仍保持不变。
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      workerData: job.input,
      resourceLimits: {
        maxOldGenerationSizeMb: 768,
        maxYoungGenerationSizeMb: 64,
        stackSizeMb: 8,
      },
    });
  } catch (error) {
    void finishJob(job, 'failed', undefined, error);
    return;
  }
  job.worker = worker;
  active.set(job.jobId, job);
  job.timeout = setTimeout(() => {
    timedOutJobs += 1;
    void cancelJob(job, 'ZEUS_HEAVY_WORKER_TIMEOUT', 'Heavy Worker 作业超过 15 分钟资源预算。');
  }, heavyWorkerTimeoutMs);
  job.timeout.unref();
  worker.on('message', (message: unknown) => handleMessage(job, message));
  worker.on('error', (error) => void finishJob(job, 'failed', undefined, error));
  worker.on('exit', (code) => {
    if (!job.settled) void finishJob(job, 'failed', undefined, heavyWorkerError('ZEUS_HEAVY_WORKER_EXITED', `Heavy Worker 在返回结果前退出，exitCode=${code}。`));
  });
}

function handleMessage(job: QueuedHeavyJob, value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const message = value as Partial<HeavyWorkerMessage>;
  if (message.protocolVersion !== heavyWorkerProtocolVersion || message.jobId !== job.jobId) return;
  if (message.type === 'progress' && 'stage' in message && 'completedUnits' in message && 'totalUnits' in message) {
    lastProgress = {
      jobId: job.jobId,
      stage: message.stage as HeavyWorkerProgressStage,
      completedUnits: Number(message.completedUnits),
      totalUnits: Number(message.totalUnits),
    };
    return;
  }
  if (message.type === 'failed' && 'error' in message && message.error && typeof message.error === 'object') {
    const error = message.error as { code?: unknown; message?: unknown };
    void finishJob(job, 'failed', undefined, heavyWorkerError(typeof error.code === 'string' ? error.code : 'ZEUS_HEAVY_WORKER_FAILED', typeof error.message === 'string' ? error.message : 'Heavy Worker 执行失败。'));
    return;
  }
  if (message.type !== 'completed' || !('result' in message) || !isHeavyWorkerResult(message.result, job.input)) return;
  void finishJob(job, 'completed', message.result);
}

function isResultRef(value: unknown, input: Pick<HeavyWorkerInput, 'jobId' | 'kind' | 'maxResultBytes'>): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<HeavyWorkerResult>;
  return (
    result.resultRef?.jobId === input.jobId &&
    result.resultRef.kind === 'verified_inline_projection' &&
    result.resultRef.resultType === input.kind &&
    typeof result.resultRef.sha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(result.resultRef.sha256) &&
    typeof result.resultRef.byteLength === 'number' &&
    result.resultRef.byteLength > 0 &&
    result.resultRef.byteLength <= input.maxResultBytes
  );
}

function isCodeMapResult(value: unknown, jobId: string): value is CodeMapHeavyWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<CodeMapHeavyWorkerResult>;
  return Boolean(result.scan && typeof result.scan === 'object') && Boolean(result.graph && typeof result.graph === 'object') && isResultRef(value, { jobId, kind: 'code_map_scan', maxResultBytes: codeMapWorkerMaxResultBytes });
}

function isGitDiffResult(value: unknown, jobId: string): value is GitDiffHeavyWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<GitDiffHeavyWorkerResult>;
  return Boolean(result.diff && typeof result.diff === 'object') && isResultRef(value, { jobId, kind: 'git_diff', maxResultBytes: gitDiffWorkerMaxResultBytes });
}

function isGitStatusResult(value: unknown, jobId: string): value is GitStatusHeavyWorkerResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Partial<GitStatusHeavyWorkerResult>;
  return Boolean(result.status && typeof result.status === 'object') && isResultRef(value, { jobId, kind: 'git_status', maxResultBytes: gitStatusWorkerMaxResultBytes });
}

function isHeavyWorkerResult(value: unknown, input: HeavyWorkerInput): value is HeavyWorkerResult {
  if (input.kind === 'code_map_scan') return isCodeMapResult(value, input.jobId);
  if (input.kind === 'git_diff') return isGitDiffResult(value, input.jobId);
  return isGitStatusResult(value, input.jobId);
}

async function cancelJob(job: QueuedHeavyJob, code: string, message: string): Promise<void> {
  if (job.settled) return job.finalization ?? Promise.resolve();
  const queuedIndex = queue.indexOf(job);
  if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
  if (code === 'ZEUS_HEAVY_WORKER_CANCELLED') cancelledJobs += 1;
  return finishJob(job, 'failed', undefined, heavyWorkerError(code, message));
}

function finishJob(job: QueuedHeavyJob, outcome: 'completed' | 'failed', result?: HeavyWorkerResult, error?: unknown): Promise<void> {
  if (job.settled) return job.finalization ?? Promise.resolve();
  job.settled = true;
  if (job.timeout) clearTimeout(job.timeout);
  if (job.signal && job.abortListener) job.signal.removeEventListener('abort', job.abortListener);
  const finalize = () => {
    active.delete(job.jobId);
    if (job.startedAt !== undefined) lastDurationMs = Math.max(0, Date.now() - job.startedAt);
    if (outcome === 'completed' && result) {
      completedJobs += 1;
      completedByKind[job.input.kind] += 1;
      job.resolve(result);
    } else {
      failedJobs += 1;
      job.reject(error ?? heavyWorkerError('ZEUS_HEAVY_WORKER_FAILED', 'Heavy Worker 执行失败。'));
    }
    pump();
  };
  if (job.worker) job.finalization = job.worker.terminate().then(finalize, finalize);
  else {
    finalize();
    job.finalization = Promise.resolve();
  }
  return job.finalization;
}

function emptyCompletedByKind(): Record<HeavyWorkerInput['kind'], number> {
  return { code_map_scan: 0, git_diff: 0, git_status: 0 };
}

function heavyWorkerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
