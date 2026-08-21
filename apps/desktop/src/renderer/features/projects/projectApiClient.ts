import type {
  CreateProjectRequest,
  LoadProjectsRequest,
  ProjectArchiveConfirmation,
  ProjectConfig,
  ProjectDatabaseSecretSnapshot,
  ProjectRecord,
  ProjectWorkspaceConfigSnapshot,
  SaveProjectConfigRequest,
  UpdateProjectRequest,
} from './projectContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildSettingsCommandRequest, settingsClientCommandTypes } from '../settings/settingsCommandClient.js';
import { buildWorkManagementCommandRequest, workManagementClientCommandTypes } from '../work-management/workManagementCommandClient.js';

export interface ProjectApiClient {
  loadProjects: (input?: LoadProjectsRequest) => Promise<ProjectRecord[]>;
  loadProject: (projectId: string) => Promise<ProjectRecord>;
  loadProjectConfig: (projectId: string) => Promise<ProjectConfig>;
  saveProjectConfig: (projectId: string, input: SaveProjectConfigRequest) => Promise<ProjectConfig>;
  loadProjectWorkspaceConfig: (projectId: string) => Promise<ProjectWorkspaceConfigSnapshot>;
  saveProjectWorkspaceConfig: (projectId: string, input: { sharedWritablePaths: Array<{ localPath: string }> }) => Promise<ProjectWorkspaceConfigSnapshot>;
  loadProjectDatabaseSecret: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  saveProjectDatabasePassword: (projectId: string, password: string) => Promise<ProjectDatabaseSecretSnapshot>;
  clearProjectDatabasePassword: (projectId: string) => Promise<ProjectDatabaseSecretSnapshot>;
  createProject: (input: CreateProjectRequest) => Promise<ProjectRecord>;
  updateProject: (projectId: string, input: UpdateProjectRequest) => Promise<ProjectRecord>;
  deleteProject: (projectId: string) => Promise<ProjectRecord>;
  createProjectArchiveConfirmation: (projectId: string) => Promise<ProjectArchiveConfirmation>;
  archiveProject: (projectId: string) => Promise<ProjectRecord>;
  restoreProject: (projectId: string) => Promise<ProjectRecord>;
  setProjectDefaultTemplate: (projectId: string, templateId: string | null) => Promise<ProjectRecord>;
  loadArchivedProjects: () => Promise<ProjectRecord[]>;
}

/** 项目上下文的公开查询/命令映射；路径和 HTTP method 不再泄漏给页面 controller。 */
export function createProjectApiClient(transport: LocalApiTransport): ProjectApiClient {
  return {
    loadProjects: (input) => transport.request<ProjectRecord[]>(`/api/projects${input?.query ? `?query=${encodeURIComponent(input.query)}` : ''}`),
    loadProject: (projectId) => transport.request<ProjectRecord>(projectPath(projectId)),
    loadProjectConfig: (projectId) => transport.request<ProjectConfig>(`${projectPath(projectId)}/config`),
    saveProjectConfig: async (projectId, input: SaveProjectConfigRequest) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.projectConfigPut, scopeKind: 'project', scopeId: projectId, operationPrefix: 'project_config', value: input });
      return transport.request<ProjectConfig>(`${projectPath(projectId)}/config`, jsonRequest('PUT', body));
    },
    loadProjectWorkspaceConfig: (projectId) => transport.request<ProjectWorkspaceConfigSnapshot>(`${projectPath(projectId)}/workspace-config`),
    saveProjectWorkspaceConfig: async (projectId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectWorkspaceUpdate,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'project_workspace_update_',
        value: input,
      });
      return transport.request<ProjectWorkspaceConfigSnapshot>(`${projectPath(projectId)}/workspace-config`, jsonRequest('PUT', body));
    },
    loadProjectDatabaseSecret: (projectId) => transport.request<ProjectDatabaseSecretSnapshot>(`${projectPath(projectId)}/database/secret`),
    saveProjectDatabasePassword: async (projectId, password) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.projectDatabaseSecretPut, scopeKind: 'project', scopeId: projectId, operationPrefix: 'project_database_secret_put', value: { password } });
      return transport.request<ProjectDatabaseSecretSnapshot>(`${projectPath(projectId)}/database/secret`, jsonRequest('PUT', body));
    },
    clearProjectDatabasePassword: async (projectId) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.projectDatabaseSecretDelete, scopeKind: 'project', scopeId: projectId, operationPrefix: 'project_database_secret_delete', value: {} });
      return transport.request<ProjectDatabaseSecretSnapshot>(`${projectPath(projectId)}/database/secret`, jsonRequest('DELETE', body));
    },
    createProject: async (input: CreateProjectRequest) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectCreate,
        scopeKind: 'project',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'project_',
        value: input,
      });
      return transport.request<ProjectRecord>('/api/projects', jsonRequest('POST', body));
    },
    updateProject: async (projectId, input: UpdateProjectRequest) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectUpdate,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'project_update_',
        value: input,
      });
      return transport.request<ProjectRecord>(projectPath(projectId), jsonRequest('PATCH', body));
    },
    deleteProject: async (projectId) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectDelete,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'project_delete_',
        value: {},
      });
      return transport.request<ProjectRecord>(projectPath(projectId), jsonRequest('DELETE', body));
    },
    createProjectArchiveConfirmation: (projectId) => transport.request<ProjectArchiveConfirmation>(`${projectPath(projectId)}/archive-confirmation`, { method: 'POST' }),
    archiveProject: async (projectId) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectArchive,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'project_archive_',
        value: {},
      });
      return transport.request<ProjectRecord>(`${projectPath(projectId)}/archive`, jsonRequest('POST', body));
    },
    restoreProject: async (projectId) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectRestore,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'project_restore_',
        value: {},
      });
      return transport.request<ProjectRecord>(`${projectPath(projectId)}/restore`, jsonRequest('POST', body));
    },
    setProjectDefaultTemplate: async (projectId, templateId) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.projectDefaultTemplateSet,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'project_default_template_',
        value: { templateId },
      });
      return transport.request<ProjectRecord>(`${projectPath(projectId)}/default-template`, jsonRequest('PUT', body));
    },
    loadArchivedProjects: () => transport.request<ProjectRecord[]>('/api/projects/archived'),
  };
}

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}
