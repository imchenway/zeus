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

export type SkillScope = 'user' | 'repo' | 'system' | 'admin';

export interface SkillDescriptor {
  id: string;
  name: string;
  description: string;
  shortDescription?: string;
  invocation: string;
  path: string;
  scope: SkillScope;
  removable: boolean;
  interface?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
}

export interface SkillCatalog {
  cwd: string;
  skills: SkillDescriptor[];
  errors: Array<Record<string, unknown>>;
  refreshedAt: string;
}

export type SkillInstallSource = { kind: 'local'; path: string } | { kind: 'git'; repositoryUrl: string; ref?: string; subdirectory?: string };

export interface SkillInstallResult {
  skill: SkillDescriptor;
  installedAt: string;
}
