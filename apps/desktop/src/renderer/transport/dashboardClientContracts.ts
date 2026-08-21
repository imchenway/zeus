import type { ProjectGitAction, ProjectGitActionResponse, ProjectGitCommitDetail, ProjectGitWorkbenchSnapshot, GitDiffSummary } from '../features/git/gitContracts.js';
import type { ZeusClientPerformanceSpan } from './localApiTransport.js';

export interface DashboardClientOptions {
  baseUrl: string;
  apiToken: string;
  executionHostTransition?: ExecutionHostTransition;
  readOnlyValidation?: ReadOnlyValidationIdentity;
  refreshLocalServerConfig?: () => Promise<DashboardClientOptions>;
  projectGitWorkbench?: ProjectGitWorkbenchBridge;
  onPerformanceSpan?: (span: ZeusClientPerformanceSpan) => void;
}

export interface ReadOnlyValidationIdentity {
  mode: 'read_only_validation';
  runId: string;
  manifestHash: string;
  databaseSha256: string;
}

export interface ProjectGitWorkbenchBridge {
  loadWorkbench: (projectId: string) => Promise<ProjectGitWorkbenchSnapshot>;
  loadCommit: (projectId: string, repositoryId: string, commitHash: string) => Promise<ProjectGitCommitDetail>;
  loadComparison: (projectId: string, repositoryId: string, ref: string, mode: 'current' | 'working-tree') => Promise<GitDiffSummary>;
  execute: (projectId: string, repositoryId: string, action: ProjectGitAction) => Promise<ProjectGitActionResponse>;
}

export interface ExecutionHostTransition {
  state: 'current' | 'draining_previous';
  currentAppVersion: string;
  hostAppVersion: string;
  capabilities: {
    nativeConversationSources: Array<'task_push' | 'code_review' | 'conflict_resolution'>;
    readOnlyValidation?: ReadOnlyValidationIdentity;
  };
}

export interface ZeusRealtimeEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type ZeusRealtimeConnectionState = 'connecting' | 'connected' | 'reconnecting';
