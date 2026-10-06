import type { SecretPresence } from '../integrations/integrationContracts.js';
import type { GitStatusSummary } from '../git/gitContracts.js';
import type { TaskRecord } from '../tasks/taskContracts.js';

export interface ProjectRecord {
  id: string;
  name: string;
  localPath: string;
  description?: string | null;
  note?: string | null;
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

/** 项目仅保留仓库资源、连接和授权，不包含独立工作偏好。 */
export interface ProjectConfig {
  projectId: string;
  vcs: { isGitRepository: boolean; gitRoot: string | null };
  database: { connectionName: string | null };
  security: { allowShell: boolean; allowGitWrite: boolean };
}

/** 更新项目资源与授权。 */
export type SaveProjectConfigRequest = Partial<Omit<ProjectConfig, 'projectId'>>;

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
