import type { SecretPresence } from '../integrations/integrationContracts.js';
import type { GitStatusSummary } from '../git/gitContracts.js';
import type { TaskRecord } from '../tasks/taskContracts.js';

export interface ProjectRecord {
  id: string;
  name: string;
  localPath: string;
  description?: string | null;
  note?: string | null;
  scanStatus: string;
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

export type ProjectIndexScope = 'project' | 'src' | 'custom';

export interface ProjectConfig {
  projectId: string;
  defaultModel: string | null;
  defaultWorkMode: ProjectWorkMode;
  defaultTaskPrompt: string;
  scan: {
    ignoreDirectories: string[];
    indexScope: ProjectIndexScope;
  };
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
    schemaPaths: string[];
  };
  telegram: {
    alias: string | null;
  };
  security: {
    allowShell: boolean;
    allowGitWrite: boolean;
  };
}

export type SaveProjectConfigRequest = Omit<ProjectConfig, 'projectId' | 'vcs'> & { vcs?: ProjectConfig['vcs'] };

export interface ProjectDatabaseSecretSnapshot {
  connectionName: string | null;
  password: SecretPresence;
}

export interface ProjectGraphSummary {
  nodeCount: number;
  edgeCount: number;
  viewCount: number;
}

export interface ProjectScanStatus {
  projectId: string;
  scanStatus: ProjectRecord['scanStatus'];
  graph: ProjectGraphSummary;
}

export interface ProjectOverview {
  project: ProjectRecord;
  graph: ProjectGraphSummary;
  git: GitStatusSummary;
  tasks: {
    total: number;
    byStatus: Record<string, number>;
    recent: TaskRecord[];
  };
}

export interface CreateProjectRequest {
  name: string;
  localPath: string;
  description?: string;
  note?: string;
  defaultModel?: string | null;
  defaultWorkMode?: ProjectWorkMode;
  defaultTaskPrompt?: string;
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
