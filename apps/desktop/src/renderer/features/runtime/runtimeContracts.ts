import type { CommandArtifact, CommandConfirmation, CommandRun } from '@zeus/shared';

export interface AiRuntimeAdapterDescriptor {
  id: 'codex' | 'claude' | 'gemini' | 'generic';
  name: string;
  displayName: string;
  command: string;
  capabilities: string[];
}

export interface RuntimeSettings {
  defaultAdapterId: AiRuntimeAdapterDescriptor['id'];
  adapterModels: Partial<Record<AiRuntimeAdapterDescriptor['id'], string>>;
  adapterDefaultArgs: Partial<Record<AiRuntimeAdapterDescriptor['id'], string[]>>;
  adapterCliPaths: Partial<Record<AiRuntimeAdapterDescriptor['id'], string>>;
  terminalEnv: Record<string, string>;
  shell: {
    path: string | null;
    login: boolean;
  };
  executionTimeoutSeconds: number;
  logRetentionDays: number;
  autoConfirmationPolicy: 'never' | 'low_risk_only';
}

export interface AiRuntimeAdapterStatus extends AiRuntimeAdapterDescriptor {
  available: boolean;
  reason: string;
  version: string | null;
  resolvedCommandPath: string | null;
  checkedAt: string;
  compatibility: 'compatible' | 'incompatible' | 'not_checked';
  installationGuideUrl: string | null;
  authStatus: 'unknown' | 'authenticated' | 'unauthenticated';
  modelConfiguration: 'user-configured';
}

export interface RuntimeStatusSnapshot {
  aiCli: {
    name: string;
    command: string;
    available: boolean;
    reason: string;
  };
  telegram: {
    enabled: boolean;
    reason: string;
  };
  terminal?: {
    provider: 'node-pty' | 'child_process';
    pty: { available: boolean; reason: string };
  };
}

export type AiRuntimeSessionStatus = 'running' | 'exited' | 'failed' | 'stopped' | 'orphan_detected' | 'lost';

export interface AiRuntimeSession {
  id: string;
  projectId: string;
  taskId?: string;
  command: string;
  args: string[];
  cwd: string;
  status: AiRuntimeSessionStatus;
  pid?: number;
  exitCode?: number | null;
  summary?: string | null;
  favorite?: boolean;
  archived?: boolean;
  deletedAt?: string | null;
  startedAt: string;
  endedAt?: string;
}

export interface AiRuntimeLogEntry {
  id: string;
  sessionId: string;
  stream: 'system' | 'stdout' | 'stderr';
  text: string;
  createdAt: string;
}

export interface CommandRunDetail {
  run: CommandRun;
  artifacts: CommandArtifact[];
  runtimeSession: AiRuntimeSession | null;
  logs: AiRuntimeLogEntry[];
  afterSeq: number;
  nextSeq: number;
  logTotal: number;
  hasMoreLogs: boolean;
  logsTruncated?: boolean;
}

export interface CommandRunTerminalOutput {
  content: string;
  byteLength: number;
}

export interface LoadCommandRunOptions {
  afterSeq?: number;
  logLimit?: number;
  tail?: boolean;
}

export interface CreateCommandConfirmationRequest {
  parameters: Record<string, string | number | boolean>;
  trigger?: 'desktop' | 'telegram';
}

export interface StartCommandRunRequest {
  runId: string;
  confirmationId: string;
  parameters: Record<string, string | number | boolean>;
}

export type CommandConfirmationResponse = CommandConfirmation & { runId: string };

export interface AiRuntimeTerminalSnapshot {
  sessionId: string;
  status: AiRuntimeSessionStatus;
  command: string;
  cwd: string;
  logs: AiRuntimeLogEntry[];
  logsTruncated?: boolean;
  capturedAt: string;
}

export interface AiRuntimeTerminalEvent {
  id: string;
  sessionId: string;
  taskId: string | null;
  seq: number;
  eventType: string;
  content: string;
  rawChunkPath: string | null;
  createdAt: string;
}

export interface LoadRuntimeLogsRequest {
  query?: string;
  stream?: AiRuntimeLogEntry['stream'];
  limit?: number;
  offset?: number;
}

export interface LoadRuntimeTerminalEventsRequest {
  limit?: number;
  offset?: number;
}

export interface RuntimeLogPage {
  sessionId: string;
  items: AiRuntimeLogEntry[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  stream: AiRuntimeLogEntry['stream'] | null;
}

export interface RuntimeTerminalEventPage {
  sessionId: string;
  items: AiRuntimeTerminalEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface StartRuntimeSessionRequest {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
  confirmationId?: string;
}

export interface RuntimeConfirmationSessionRequest {
  projectId: string;
  taskId?: string;
  command: string;
  args?: string[];
  cwd?: string;
}

export interface CreateRuntimeConfirmationRequest {
  action: 'start_generic_session';
  reason: string;
  session: RuntimeConfirmationSessionRequest;
}

export interface RuntimeOperationConfirmation {
  id: string;
  action: 'start_generic_session';
  status: 'pending' | 'confirmed' | 'consumed' | 'rejected';
  riskLevel: 'high';
  reason: string;
  securityContext?: {
    operationKind: 'shell_command';
    requiresConfirmation: true;
    riskLevel: 'high';
    projectId: string;
    taskId: string | null;
    cwd: string;
    commandPreview: string;
    redacted: boolean;
  };
  session: Required<Pick<RuntimeConfirmationSessionRequest, 'projectId' | 'command' | 'args' | 'cwd'>> & Pick<RuntimeConfirmationSessionRequest, 'taskId'>;
  createdAt: string;
  confirmedAt: string | null;
  consumedAt: string | null;
  rejectedAt?: string | null;
  rejectedReason?: string | null;
}

export interface LoadRuntimeSessionsRequest {
  query?: string;
  projectId?: string;
  taskId?: string;
  archived?: boolean;
  favoriteOnly?: boolean;
}

export interface CreateTaskFromRuntimeSessionRequest {
  idempotencyKey: string;
  title?: string;
  instruction?: string;
}
