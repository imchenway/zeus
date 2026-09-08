import type { GitDiffSummary, GitStatusSummary } from '@zeus/git-core';

export const heavyWorkerProtocolVersion = 1 as const;

export interface GitDiffHeavyWorkerInput {
  protocolVersion: typeof heavyWorkerProtocolVersion;
  jobId: string;
  kind: 'git_diff';
  rootPath: string;
  maxResultBytes: number;
}

export interface GitStatusHeavyWorkerInput {
  protocolVersion: typeof heavyWorkerProtocolVersion;
  jobId: string;
  kind: 'git_status';
  rootPath: string;
  maxResultBytes: number;
}

export type HeavyWorkerInput = GitDiffHeavyWorkerInput | GitStatusHeavyWorkerInput;

export interface HeavyWorkerResultRef {
  jobId: string;
  kind: 'verified_inline_projection';
  resultType: HeavyWorkerInput['kind'];
  sha256: string;
  byteLength: number;
}

export interface GitDiffHeavyWorkerResult {
  diff: GitDiffSummary;
  resultRef: HeavyWorkerResultRef & { resultType: 'git_diff' };
}

export interface GitStatusHeavyWorkerResult {
  status: GitStatusSummary;
  resultRef: HeavyWorkerResultRef & { resultType: 'git_status' };
}

export type HeavyWorkerResult = GitDiffHeavyWorkerResult | GitStatusHeavyWorkerResult;

export type HeavyWorkerProgressStage = 'worker_started' | 'git_process_started' | 'git_projection_built';

export type HeavyWorkerMessage =
  | {
      protocolVersion: typeof heavyWorkerProtocolVersion;
      jobId: string;
      type: 'progress';
      stage: HeavyWorkerProgressStage;
      completedUnits: number;
      totalUnits: number;
    }
  | {
      protocolVersion: typeof heavyWorkerProtocolVersion;
      jobId: string;
      type: 'completed';
      result: HeavyWorkerResult;
    }
  | {
      protocolVersion: typeof heavyWorkerProtocolVersion;
      jobId: string;
      type: 'failed';
      error: { code: string; message: string };
    };
