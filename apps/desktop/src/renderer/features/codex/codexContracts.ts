export type CodexLegacyImportRunStatus = 'prepared' | 'waiting' | 'completed' | 'failed';

export interface CodexLegacyImportEligibleSession {
  sourceConversationId: string;
  title: string;
  cwd: string;
}

export interface CodexLegacyImportRun {
  id: string;
  importId: string | null;
  sourceConversationId: string;
  targetConversationId: string | null;
  status: CodexLegacyImportRunStatus;
  targetThreadId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CodexLegacyImportSnapshot {
  eligible: CodexLegacyImportEligibleSession[];
  runs: CodexLegacyImportRun[];
}

export interface CodexLegacyImportResult {
  importId: string;
  status: 'waiting' | 'completed' | 'failed';
  runs: CodexLegacyImportRun[];
}

export interface CodexConfigImportEntry {
  path: string;
  kind: 'file' | 'directory';
  nodeCount: number;
}

export interface CodexConfigImportPreview {
  available: boolean;
  sourceRoot: string;
  targetRoot: string;
  entries: CodexConfigImportEntry[];
  skipped: Array<{
    path: string;
    reason: 'missing' | 'symbolic_link' | 'unsupported_type' | 'contains_sensitive_assignment' | 'too_large' | 'generated_runtime';
  }>;
}

export interface CodexConfigImportResult extends CodexConfigImportPreview {
  imported: string[];
  backupRoot: string | null;
  importedAt: string;
  restartRequired: boolean;
  runtimeReloaded: boolean;
  runtimeGenerationId: string | null;
  runtimeError: string | null;
}

export interface CodexConfigActivationResult {
  runtimeReloaded: true;
  runtimeGenerationId: string;
  restartRequired: false;
}
