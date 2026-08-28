import type { ProjectScanResult } from '@zeus/code-indexer';
import type { GitDiffSummary, GitStatusSummary } from '@zeus/git-core';
import type { ProjectGraph } from '@zeus/graph-engine';

export const heavyWorkerProtocolVersion = 1 as const;

export interface CodeMapHeavyWorkerInput {
  protocolVersion: typeof heavyWorkerProtocolVersion;
  jobId: string;
  kind: 'code_map_scan';
  rootPath: string;
  projectName: string;
  ignoreDirectories: string[];
  additionalFiles: Array<{ absolutePath: string; relativePath: string }>;
  maxResultBytes: number;
}

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

export type HeavyWorkerInput = CodeMapHeavyWorkerInput | GitDiffHeavyWorkerInput | GitStatusHeavyWorkerInput;

export interface HeavyWorkerResultRef {
  jobId: string;
  kind: 'verified_inline_projection';
  resultType: HeavyWorkerInput['kind'];
  sha256: string;
  byteLength: number;
}

export interface CodeMapHeavyWorkerResult {
  scan: ProjectScanResult;
  graph: ProjectGraph;
  resultRef: HeavyWorkerResultRef;
}

export interface GitDiffHeavyWorkerResult {
  diff: GitDiffSummary;
  resultRef: HeavyWorkerResultRef & { resultType: 'git_diff' };
}

export interface GitStatusHeavyWorkerResult {
  status: GitStatusSummary;
  resultRef: HeavyWorkerResultRef & { resultType: 'git_status' };
}

export type HeavyWorkerResult = CodeMapHeavyWorkerResult | GitDiffHeavyWorkerResult | GitStatusHeavyWorkerResult;

export type HeavyWorkerProgressStage = 'worker_started' | 'source_indexed' | 'graph_built' | 'git_process_started' | 'git_projection_built';

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
