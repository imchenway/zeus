import type { SecretPresence } from '../integrations/integrationContracts.js';
import type { GitStatusSummary } from '../git/gitContracts.js';
import type { TaskRecord } from '../tasks/taskContracts.js';

export interface ProjectRecord {
  id: string;
  name: string;
  localPath: string;
  description?: string | null;
  note?: string | null;
  defaultTemplateId?: string | null;
}

export interface ProjectWorkspaceSharedPath {
  id: string;
  projectId: string;
  relativePath: string;
  localPath: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectWorkspaceConfigSnapshot {
  projectId: string;
  containerPath: string;
  sharedWritablePaths: ProjectWorkspaceSharedPath[];
}

export type ProjectWorkMode = 'plan' | 'develop' | 'review' | 'debug';

export interface ProjectModelServiceTierPreference {
  modelSourceId: string | null;
  modelId: string;
  serviceTier: 'standard' | 'priority';
}

export interface ProjectConfig {
  projectId: string;
  serviceTierPreferences: ProjectModelServiceTierPreference[];
  defaultModel: string | null;
  defaultWorkMode: ProjectWorkMode;
  language: {
    primary: string;
    additional: string[];
  };
  dependencies: {
    packageManagers: string[];
    manifestPaths: string[];
  };
  vcs: {
    isGitRepository: boolean;
    gitRoot: string | null;
  };
  database: {
    connectionName: string | null;
  };
  telegram: {
    alias: string | null;
  };
  security: {
    allowShell: boolean;
    allowGitWrite: boolean;
  };
}

export type SaveProjectConfigRequest = Omit<ProjectConfig, 'projectId' | 'vcs' | 'serviceTierPreferences'> & { vcs?: ProjectConfig['vcs'] };

export interface ProjectDatabaseSecretSnapshot {
  connectionName: string | null;
  password: SecretPresence;
}

export interface ProjectOverview {
  project: ProjectRecord;
  git: GitStatusSummary;
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    recent: TaskRecord[];
  };
}

export interface CreateProjectRequest {
  temporary?: boolean;
  name: string;
  localPath: string;
  description?: string;
  note?: string;
  defaultModel?: string | null;
  defaultWorkMode?: ProjectWorkMode;
}

export interface UpdateProjectRequest {
  name?: string;
  localPath?: string;
  description?: string | null;
  note?: string | null;
}

export interface LoadProjectsRequest {
  query?: string;
}

export interface ProjectArchiveConfirmation {
  projectId: string;
  confirmationText: string;
  riskLevel: 'medium';
}
