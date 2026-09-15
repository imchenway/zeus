import { accessSync, constants as fsConstants, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { temporaryWorkspaceId } from '@zeus/shared';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createDefaultProjectConfig, normalizeProjectConfig, type ProjectConfigSnapshot } from './projectCore.js';
import type { AppendAuditLogInput, ProjectRepository, ProjectSharedPathRepository, TaskTemplateRepository, ZeusProjectRecord, ZeusProjectSharedPathRecord } from '@zeus/storage';
import type { WorkManagementTaskCommandContext } from './workManagementTaskCommandRoutes.js';
import { WorkManagementRouteError } from './workManagementCoreCommandRoutes.js';
import type { ProjectRepositoryDiscoveryService } from './projectRepositoryDiscovery.js';

export interface CreateProjectCommandInput {
  temporary?: boolean;
  name: string;
  localPath: string;
  description?: string;
  note?: string;
  defaultModel?: unknown;
  defaultWorkMode?: unknown;
}

export interface UpdateProjectCommandInput {
  name?: string;
  localPath?: string;
  description?: string | null;
  note?: string | null;
}

export interface UpdateProjectWorkspaceCommandInput {
  sharedWritablePaths?: Array<{ localPath?: unknown }>;
}

export interface SetProjectDefaultTemplateCommandInput {
  templateId: string | null;
}

interface ProjectOperationPorts {
  temporaryWorkspaceDirectory?: string;
  /** 项目命令提交后异步发现本地仓库。 */
  repositoryDiscovery: Pick<ProjectRepositoryDiscoveryService, 'request'>;
  projects: Pick<ProjectRepository, 'archive' | 'create' | 'delete' | 'getById' | 'prepareArchive' | 'restore' | 'setDefaultTemplate' | 'update'>;
  sharedPaths: Pick<ProjectSharedPathRepository, 'replaceForProject'>;
  templates: Pick<TaskTemplateRepository, 'getById'>;
  saveProjectConfig(projectId: string, config: ProjectConfigSnapshot): void;
  /** 为新项目写入经过目录验证的默认模型及可用模型集合。 */
  stageProjectModelSelection(projectId: string, explicitModel: string | null): void;
  stageProjectManagementStatus(projectId: string): void;
  activateProjectManagementStatus(projectId: string): void;
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  afterCommit(callback: () => void): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): void;
}

/** 项目写模型：路径身份、默认配置、共享目录和审计在同一 Core transaction 中提交。 */
export class WorkManagementProjectOperations {
  constructor(private readonly ports: ProjectOperationPorts) {}

  create(input: CreateProjectCommandInput, projectId: string, context: WorkManagementTaskCommandContext): ZeusProjectRecord {
    if (input?.temporary === true) {
      const directory = this.ports.temporaryWorkspaceDirectory;
      if (!directory) throw routeError(503, 'ZEUS_TEMPORARY_WORKSPACE_UNAVAILABLE', 'Temporary workspace is unavailable');
      mkdirSync(directory, { recursive: true });
      const existing = this.ports.projects.getById(temporaryWorkspaceId);
      if (existing) return existing;
      projectId = temporaryWorkspaceId;
      input = { ...input, name: '临时会话', localPath: directory };
    }
    if (!input?.name || !input.localPath) throw routeError(400, 'ZEUS_INVALID_PROJECT', 'Project name and localPath are required');
    const localPath = requireReadableProjectDirectory(input.localPath);
    const initialDefaults = normalizeProjectConfig('pending-project', { defaultModel: input.defaultModel, defaultWorkMode: input.defaultWorkMode }, createDefaultProjectConfig('pending-project'));
    if (!initialDefaults) throw routeError(400, 'ZEUS_INVALID_PROJECT_CONFIG', 'Project defaults must use safe single-line values and supported work modes');
    const projectConfig = normalizeProjectConfig(projectId, { defaultModel: input.defaultModel, defaultWorkMode: input.defaultWorkMode }, detectProjectConfigFromLocalFiles(projectId, localPath));
    if (!projectConfig) throw routeError(400, 'ZEUS_INVALID_PROJECT_CONFIG', 'Project defaults must use safe single-line values and supported work modes');
    const project = this.ports.projects.create({ id: projectId, name: input.name, localPath, description: input.description, note: input.note });
    this.ports.saveProjectConfig(project.id, { ...projectConfig, projectId: project.id });
    this.ports.repositoryDiscovery.request(project, context.commandId);
    this.ports.stageProjectManagementStatus(project.id);
    this.ports.stageProjectModelSelection(project.id, projectConfig.defaultModel);
    this.audit(context, 'project.config.detected', project, {
      language: projectConfig.language.primary,
      packageManagers: projectConfig.dependencies.packageManagers,
      manifestPaths: projectConfig.dependencies.manifestPaths,
      gitRoot: projectConfig.vcs.gitRoot,
      defaultWorkMode: projectConfig.defaultWorkMode,
    });
    this.audit(context, 'project.created', project, { name: project.name, localPath: project.localPath });
    this.ports.afterCommit(() => {
      this.ports.activateProjectManagementStatus(project.id);
      this.ports.publishRealtimeEvent('project.created', { projectId: project.id, name: project.name, localPath: project.localPath });
    });
    return project;
  }

  update(projectId: string, input: UpdateProjectCommandInput, context: WorkManagementTaskCommandContext): ZeusProjectRecord {
    const existing = this.requireMutableProject(projectId);
    const localPath = typeof input.localPath === 'string' && input.localPath !== existing.localPath ? requireReadableProjectDirectory(input.localPath) : undefined;
    const updated = this.ports.projects.update(existing.id, { ...input, localPath });
    if (localPath) this.ports.repositoryDiscovery.request(updated, context.commandId);
    this.audit(context, 'project.updated', updated, { name: updated.name, localPath: updated.localPath });
    this.ports.afterCommit(() => this.ports.publishRealtimeEvent('project.updated', { projectId: updated.id, name: updated.name, localPath: updated.localPath }));
    return updated;
  }

  updateWorkspace(projectId: string, input: UpdateProjectWorkspaceCommandInput, context: WorkManagementTaskCommandContext): { projectId: string; containerPath: string; sharedWritablePaths: ZeusProjectSharedPathRecord[] } {
    const project = this.requireMutableProject(projectId);
    const sharedPaths = normalizeProjectMemberDirectories(project, input.sharedWritablePaths);
    assertPathsDoNotOverlap(sharedPaths.map((entry) => entry.localPath));
    const savedSharedPaths = this.ports.sharedPaths.replaceForProject(
      project.id,
      sharedPaths.map((entry) => ({ projectId: project.id, relativePath: entry.relativePath, localPath: entry.localPath })),
    );
    this.audit(context, 'project.workspace_config.updated', project, { sharedWritablePaths: savedSharedPaths.map((entry) => entry.relativePath) });
    return { projectId: project.id, containerPath: project.localPath, sharedWritablePaths: savedSharedPaths };
  }

  /** 显式刷新只接纳后台发现，不在 HTTP 响应中等待目录扫描。 */
  refreshRepositories(projectId: string, context: WorkManagementTaskCommandContext) {
    return this.ports.repositoryDiscovery.request(this.requireProject(projectId), context.commandId);
  }

  remove(projectId: string, context: WorkManagementTaskCommandContext): ZeusProjectRecord {
    const existing = this.requireMutableProject(projectId);
    const deleted = this.ports.projects.delete(existing.id);
    this.audit(context, 'project.deleted', deleted, { name: deleted.name, localPath: deleted.localPath });
    this.ports.afterCommit(() => this.ports.publishRealtimeEvent('project.deleted', { projectId: deleted.id }));
    return deleted;
  }

  archiveConfirmation(projectId: string): ReturnType<ProjectRepository['prepareArchive']> {
    return this.ports.projects.prepareArchive(this.requireMutableProject(projectId).id);
  }

  archive(projectId: string): ZeusProjectRecord {
    const archived = this.ports.projects.archive(this.requireMutableProject(projectId).id);
    this.ports.afterCommit(() => this.ports.publishRealtimeEvent('project.archived', { projectId: archived.id }));
    return archived;
  }

  restore(projectId: string): ZeusProjectRecord {
    const restored = this.ports.projects.restore(this.requireMutableProject(projectId).id);
    this.ports.afterCommit(() => this.ports.publishRealtimeEvent('project.restored', { projectId: restored.id }));
    return restored;
  }

  setDefaultTemplate(projectId: string, input: SetProjectDefaultTemplateCommandInput): ZeusProjectRecord {
    const project = this.requireMutableProject(projectId);
    const templateId = input.templateId ?? null;
    if (templateId) {
      const template = this.ports.templates.getById(templateId);
      if (!template || (template.projectId && template.projectId !== project.id)) throw routeError(404, 'ZEUS_TEMPLATE_NOT_FOUND', 'Task template not found for this project');
    }
    return this.ports.projects.setDefaultTemplate(project.id, templateId);
  }

  /** 默认工作区只禁止用户修改容器，仓库发现等正常初始化仍可读取。 */
  private requireMutableProject(projectId: string): ZeusProjectRecord {
    if (projectId === temporaryWorkspaceId) throw routeError(409, 'ZEUS_TEMPORARY_WORKSPACE_MANAGED', 'Temporary workspace is managed by Zeus');
    return this.requireProject(projectId);
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) throw routeError(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }

  private audit(context: WorkManagementTaskCommandContext, action: string, project: ZeusProjectRecord, payload: Record<string, unknown>): void {
    this.ports.appendAuditLog({
      actorType: context.actor.kind,
      ...(context.actor.id ? { actorRef: context.actor.id } : {}),
      action,
      resourceType: 'project',
      resourceId: project.id,
      payload: { projectId: project.id, commandId: context.commandId, ...payload },
    });
  }
}

function requireReadableProjectDirectory(value: string): string {
  try {
    const canonicalPath = normalizeProjectDirectoryPath(value);
    if (!statSync(canonicalPath).isDirectory()) throw routeError(400, 'ZEUS_INVALID_PROJECT_PATH', 'Project localPath must point to an existing directory');
    accessSync(canonicalPath, fsConstants.R_OK);
    return canonicalPath;
  } catch (error) {
    if (error instanceof WorkManagementRouteError) throw error;
    throw routeError(400, 'ZEUS_INVALID_PROJECT_PATH', 'Project localPath must exist and be readable');
  }
}

function normalizeProjectMemberDirectories(project: ZeusProjectRecord, values: Array<{ localPath?: unknown }> | undefined): Array<{ localPath: string; relativePath: string }> {
  if (!Array.isArray(values)) throw routeError(400, 'ZEUS_PROJECT_WORKSPACE_CONFIG_INVALID', 'sharedWritablePaths must be an array.');
  const projectRoot = realpathSync(project.localPath);
  const seen = new Set<string>();
  return values.map((value, index) => {
    if (!value || typeof value.localPath !== 'string' || !value.localPath.trim()) throw routeError(400, 'ZEUS_PROJECT_WORKSPACE_PATH_REQUIRED', `Workspace path ${index + 1} is required.`);
    const requestedPath = isAbsolute(value.localPath.trim()) ? value.localPath.trim() : join(projectRoot, value.localPath.trim());
    let localPath: string;
    try {
      localPath = realpathSync(requestedPath);
    } catch {
      throw routeError(400, 'ZEUS_PROJECT_WORKSPACE_PATH_INVALID', `Workspace path does not exist: ${value.localPath}`);
    }
    if (!statSync(localPath).isDirectory() || !isPathInsideRoot(localPath, projectRoot))
      throw routeError(400, 'ZEUS_PROJECT_WORKSPACE_PATH_OUTSIDE_CONTAINER', `Workspace path must be a directory inside the project container: ${value.localPath}`);
    if (localPath === projectRoot) throw routeError(400, 'ZEUS_PROJECT_SHARED_PATH_TOO_BROAD', 'The whole project container cannot be registered as a shared writable path.');
    if (seen.has(localPath)) throw routeError(400, 'ZEUS_PROJECT_WORKSPACE_PATH_DUPLICATE', `Workspace path is duplicated: ${value.localPath}`);
    seen.add(localPath);
    return { localPath, relativePath: relative(projectRoot, localPath).split(sep).join('/') || '.' };
  });
}

function assertPathsDoNotOverlap(paths: string[]): void {
  for (let index = 0; index < paths.length; index += 1) {
    for (let candidateIndex = index + 1; candidateIndex < paths.length; candidateIndex += 1) {
      const left = paths[index]!;
      const right = paths[candidateIndex]!;
      if (isPathInsideRoot(left, right) || isPathInsideRoot(right, left)) throw routeError(400, 'ZEUS_PROJECT_WORKSPACE_PATH_OVERLAP', 'Shared writable paths cannot contain one another.');
    }
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relativePath = relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath));
}

function normalizeProjectDirectoryPath(localPath: string): string {
  const absolutePath = resolve(localPath.trim());
  return absolutePath === '/' ? absolutePath : absolutePath.replace(/\/+$/u, '');
}

function detectProjectConfigFromLocalFiles(projectId: string, projectLocalPath: string): ProjectConfigSnapshot {
  const config = createDefaultProjectConfig(projectId);
  const has = (path: string): boolean => existsSync(join(projectLocalPath, path));
  const manifestPaths = ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'tsconfig.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].filter(has);
  const packageManagers = [
    has('pnpm-workspace.yaml') || has('pnpm-lock.yaml') ? 'pnpm' : null,
    has('package-lock.json') ? 'npm' : null,
    has('yarn.lock') ? 'yarn' : null,
    has('pom.xml') ? 'maven' : null,
    has('build.gradle') || has('build.gradle.kts') || has('settings.gradle') || has('settings.gradle.kts') ? 'gradle' : null,
  ].filter((value): value is string => Boolean(value));
  const hasNodeManifest = has('package.json') || has('tsconfig.json');
  const hasJavaManifest = has('pom.xml') || has('build.gradle') || has('build.gradle.kts');
  const primary = hasJavaManifest && !hasNodeManifest ? 'java' : 'typescript';
  const gitRoot = detectGitRoot(projectLocalPath);
  return {
    ...config,
    language: { primary, additional: [...(hasNodeManifest ? ['javascript'] : []), ...(hasJavaManifest && primary !== 'java' ? ['java'] : [])] },
    dependencies: { packageManagers, manifestPaths },
    vcs: { isGitRepository: gitRoot !== null, gitRoot },
  };
}

function detectGitRoot(projectLocalPath: string): string | null {
  let currentPath = resolve(projectLocalPath);
  while (true) {
    if (existsSync(join(currentPath, '.git'))) return currentPath;
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return null;
    currentPath = parentPath;
  }
}

function routeError(statusCode: number, error: string, message: string): WorkManagementRouteError {
  return new WorkManagementRouteError(statusCode, { error, message });
}
