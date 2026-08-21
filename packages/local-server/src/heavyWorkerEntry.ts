import { createHash } from 'node:crypto';
import { parentPort, workerData } from 'node:worker_threads';
import { scanProjectSource } from '@zeus/code-indexer';
import { getGitDiff, getGitStatus } from '@zeus/git-core';
import { buildProjectGraph } from '@zeus/graph-engine';
import {
  heavyWorkerProtocolVersion,
  type CodeMapHeavyWorkerInput,
  type CodeMapHeavyWorkerResult,
  type GitDiffHeavyWorkerResult,
  type GitStatusHeavyWorkerResult,
  type HeavyWorkerInput,
  type HeavyWorkerMessage,
  type HeavyWorkerProgressStage,
  type HeavyWorkerResult,
} from './heavyWorkerContracts.js';

function post(message: HeavyWorkerMessage): void {
  if (!parentPort) throw new Error('Heavy Worker 缺少父进程消息端口。');
  parentPort.postMessage(message);
}

function progress(input: HeavyWorkerInput, stage: HeavyWorkerProgressStage, completedUnits: number, totalUnits: number): void {
  post({ protocolVersion: heavyWorkerProtocolVersion, jobId: input.jobId, type: 'progress', stage, completedUnits, totalUnits });
}

function parseInput(value: unknown): HeavyWorkerInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw workerError('ZEUS_HEAVY_WORKER_INPUT_INVALID', 'Heavy Worker 输入不是对象。');
  const input = value as Partial<HeavyWorkerInput>;
  if (
    input.protocolVersion !== heavyWorkerProtocolVersion ||
    (input.kind !== 'code_map_scan' && input.kind !== 'git_diff' && input.kind !== 'git_status') ||
    typeof input.jobId !== 'string' ||
    !input.jobId ||
    typeof input.rootPath !== 'string' ||
    !input.rootPath ||
    typeof input.maxResultBytes !== 'number' ||
    !Number.isSafeInteger(input.maxResultBytes) ||
    input.maxResultBytes <= 0
  ) {
    throw workerError('ZEUS_HEAVY_WORKER_INPUT_INVALID', 'Heavy Worker 输入身份、类型或预算无效。');
  }
  if (input.kind === 'code_map_scan' && (typeof input.projectName !== 'string' || !input.projectName || !Array.isArray(input.ignoreDirectories) || !Array.isArray(input.additionalFiles))) {
    throw workerError('ZEUS_HEAVY_WORKER_INPUT_INVALID', '代码地图 Worker 输入缺少项目名、忽略目录或附加文件。');
  }
  return input as HeavyWorkerInput;
}

function workerError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'ZEUS_HEAVY_WORKER_FAILED';
}

async function run(): Promise<void> {
  let input: HeavyWorkerInput | null = null;
  try {
    input = parseInput(workerData);
    progress(input, 'worker_started', 0, 2);
    const result = await executeJob(input);
    post({ protocolVersion: heavyWorkerProtocolVersion, jobId: input.jobId, type: 'completed', result });
  } catch (error) {
    if (input) {
      post({
        protocolVersion: heavyWorkerProtocolVersion,
        jobId: input.jobId,
        type: 'failed',
        error: { code: errorCode(error), message: error instanceof Error ? error.message : 'Heavy Worker 执行失败。' },
      });
    } else {
      throw error;
    }
  } finally {
    parentPort?.close();
  }
}

async function executeJob(input: HeavyWorkerInput): Promise<HeavyWorkerResult> {
  if (input.kind === 'code_map_scan') return executeCodeMapJob(input);
  progress(input, 'git_process_started', 1, 2);
  if (input.kind === 'git_diff') {
    const diff = await getGitDiff(input.rootPath);
    const result = withVerifiedResultRef(input, { diff }) as GitDiffHeavyWorkerResult;
    progress(input, 'git_projection_built', 2, 2);
    return result;
  }
  const status = await getGitStatus(input.rootPath);
  const result = withVerifiedResultRef(input, { status }) as GitStatusHeavyWorkerResult;
  progress(input, 'git_projection_built', 2, 2);
  return result;
}

async function executeCodeMapJob(input: CodeMapHeavyWorkerInput): Promise<CodeMapHeavyWorkerResult> {
  const scan = await scanProjectSource({
    rootPath: input.rootPath,
    projectName: input.projectName,
    ignoreDirectories: input.ignoreDirectories,
    additionalFiles: input.additionalFiles,
  });
  progress(input, 'source_indexed', 1, 2);
  const graph = buildProjectGraph(scan);
  const result = withVerifiedResultRef(input, { scan, graph }) as CodeMapHeavyWorkerResult;
  progress(input, 'graph_built', 2, 2);
  return result;
}

function withVerifiedResultRef(input: HeavyWorkerInput, projection: Record<string, unknown>): HeavyWorkerResult {
  const serialized = JSON.stringify(projection);
  const byteLength = Buffer.byteLength(serialized);
  if (byteLength > input.maxResultBytes) {
    throw workerError('ZEUS_HEAVY_WORKER_RESULT_TOO_LARGE', `Heavy Worker 结果 ${byteLength} bytes 超过 ${input.maxResultBytes} bytes 预算。`);
  }
  return {
    ...projection,
    resultRef: {
      jobId: input.jobId,
      kind: 'verified_inline_projection',
      resultType: input.kind,
      sha256: createHash('sha256').update(serialized).digest('hex'),
      byteLength,
    },
  } as HeavyWorkerResult;
}

void run();
