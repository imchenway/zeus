import { Buffer } from 'node:buffer';
import { getNextTaskStatus } from './taskCore.js';
import type { CommandActor, TaskBoardViewUpdateRequest, TaskManagementStatus } from '@zeus/shared';
import {
  type AppendAuditLogInput,
  type ConversationRepository,
  type CreateTaskEventInput,
  isTaskPriority,
  isTaskType,
  type ProjectRepository,
  type TaskBoardRepository,
  type TaskRepository,
  type TaskTemplateRepository,
  type ZeusProjectRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import { type CreateTaskFromTemplateInput, type CreateTaskTemplateInput, type CreateUserTaskInput, type WorkManagementCommandActor, WorkManagementRouteError } from './workManagementCoreCommandRoutes.js';
import { normalizeWorkManagementTaskAttachments } from './workManagementTaskInput.js';

interface CoreOperationContext {
  commandId: string;
  operationIdentity: string;
  actor: WorkManagementCommandActor;
}

interface WorkManagementCoreOperationPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'create' | 'createFromTemplate' | 'getById' | 'updateStatus'>;
  taskBoards: Pick<TaskBoardRepository, 'getSnapshot' | 'updateSettings'>;
  taskTemplates: Pick<TaskTemplateRepository, 'createCustom' | 'getById'>;
  conversations: Pick<ConversationRepository, 'getById'>;
  resolveDefaultManagementStatus(projectId: string): TaskManagementStatus;
  recordTaskEvent(input: CreateTaskEventInput): void;
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  afterCommit(callback: () => void): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): void;
}

/**
 * 模板、看板设置和任务只修改 Core SQLite 事实。公开路由先通过统一命令信封，
 * 再由本对象在同一个 durable transaction 内写业务事实、任务事件、投影 outbox 和 receipt。
 */
export class WorkManagementCoreOperations {
  constructor(private readonly ports: WorkManagementCoreOperationPorts) {}

  createUserTask(input: CreateUserTaskInput, taskId: string, context: CoreOperationContext): ZeusTaskRecord {
    if (!input?.projectId || !input.title || !isTaskType(input.taskType)) throw routeError(400, 'ZEUS_INVALID_TASK', 'projectId, title and taskType are required');
    if (
      [input.description, input.defectCurrentState, input.defectExpectedOutcome, input.defectReproductionSteps, input.optimizationCurrentState, input.optimizationExpectedOutcome].some(
        (value) => value !== undefined && typeof value !== 'string',
      )
    ) {
      throw routeError(400, 'ZEUS_INVALID_TASK_CONTENT', 'Task type content fields must be strings when provided');
    }
    if (input.parentTaskId !== undefined && input.parentTaskId !== null && typeof input.parentTaskId !== 'string') throw routeError(400, 'ZEUS_INVALID_TASK_PARENT', 'parentTaskId must be a string or null.');
    if ([input.allowCodeChanges, input.allowTests, input.allowGitCommit].some((value) => value !== undefined && typeof value !== 'boolean')) {
      throw routeError(400, 'ZEUS_INVALID_TASK_PERMISSIONS', 'allowCodeChanges, allowTests and allowGitCommit must be booleans when provided');
    }
    if (input.priority !== undefined && !isTaskPriority(input.priority)) throw routeError(400, 'ZEUS_INVALID_TASK_PRIORITY', 'priority must be one of p0, p1, p2, p3 or p4');
    if (input.sourceContext !== undefined && (!input.sourceContext || typeof input.sourceContext !== 'object' || Array.isArray(input.sourceContext))) {
      throw routeError(400, 'ZEUS_INVALID_TASK_SOURCE_CONTEXT', 'Task source context must be an object.');
    }
    const sourceContext = { ...(input.sourceContext ?? {}) };
    if (Object.prototype.hasOwnProperty.call(sourceContext, 'attachments')) {
      const attachments = normalizeWorkManagementTaskAttachments(sourceContext.attachments);
      if (attachments === null) throw routeError(400, 'ZEUS_INVALID_TASK_ATTACHMENTS', 'Task attachments must contain at most 24 valid field-owned attachment references.');
      sourceContext.attachments = attachments;
    }
    const task = this.ports.tasks.create({
      id: taskId,
      projectId: input.projectId,
      managementStatus: this.ports.resolveDefaultManagementStatus(input.projectId),
      parentTaskId: input.parentTaskId,
      title: input.title,
      taskType: input.taskType,
      description: input.description ?? '',
      defectCurrentState: input.defectCurrentState,
      defectExpectedOutcome: input.defectExpectedOutcome,
      defectReproductionSteps: input.defectReproductionSteps,
      optimizationCurrentState: input.optimizationCurrentState,
      optimizationExpectedOutcome: input.optimizationExpectedOutcome,
      createdFrom: 'user',
      sourceContext,
      tags: input.tags,
      priority: input.priority,
      allowCodeChanges: input.allowCodeChanges,
      allowTests: input.allowTests,
      allowGitCommit: input.allowGitCommit,
    });
    this.ports.recordTaskEvent({
      taskId: task.id,
      eventType: 'task.created',
      title: '任务已创建',
      payload: { status: task.status, managementStatus: task.managementStatus, taskType: task.taskType, priority: task.priority, source: task.createdFrom },
    });
    this.audit(context.actor, 'task.created', 'task', task.id, { taskId: task.id, projectId: task.projectId, title: task.title, taskType: task.taskType, status: task.status, priority: task.priority });
    this.afterTaskCreated(task, 'user');
    return task;
  }

  updateTaskBoard(projectId: string, input: TaskBoardViewUpdateRequest, context: CoreOperationContext) {
    const project = this.requireProject(projectId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw routeError(400, 'ZEUS_TASK_BOARD_REVISION_REQUIRED', 'expectedRevision is required when updating the task board.');
    if (!isPlainRecord(input.settings)) throw routeError(400, 'ZEUS_TASK_BOARD_SETTINGS_REQUIRED', 'Task board settings are required.');
    try {
      const updated = this.ports.taskBoards.updateSettings(project.id, input.expectedRevision, input.settings);
      this.audit(context.actor, 'task.board.settings.updated', 'project', project.id, {
        projectId: project.id,
        revision: updated.revision,
        groupBy: updated.settings.groupBy,
        subgroupBy: updated.settings.subgroupBy,
      });
      this.ports.afterCommit(() => this.ports.publishRealtimeEvent('task.board.updated', { projectId: project.id, revision: updated.revision, reason: 'settings' }));
      return updated;
    } catch (error) {
      const details = error as { code?: string; currentRevision?: number };
      if (details.code === 'ZEUS_TASK_BOARD_REVISION_CONFLICT') {
        throw new WorkManagementRouteError(409, {
          error: details.code,
          message: 'Task board changed after editing started.',
          currentRevision: details.currentRevision,
          board: this.ports.taskBoards.getSnapshot(project.id),
        });
      }
      throw error;
    }
  }

  retryTask(taskId: string, context: CoreOperationContext): ZeusTaskRecord {
    const task = this.requireTask(taskId);
    let nextStatus: ZeusTaskRecord['status'];
    try {
      nextStatus = getNextTaskStatus(task.status, 'ready');
    } catch (error) {
      throw routeError(409, 'ZEUS_INVALID_TASK_TRANSITION', error instanceof Error ? error.message : 'Invalid task transition');
    }
    const updated = this.ports.tasks.updateStatus(task.id, nextStatus);
    this.ports.recordTaskEvent({ taskId: updated.id, eventType: 'task.runtime.retry', title: '任务已重试', payload: { from: task.status, to: updated.status } });
    this.audit(context.actor, 'task.status.changed', 'task', updated.id, { taskId: updated.id, projectId: updated.projectId, from: task.status, to: updated.status, source: 'task.runtime.retry' });
    this.ports.afterCommit(() =>
      this.ports.publishRealtimeEvent('task.status.changed', {
        taskId: updated.id,
        projectId: updated.projectId,
        title: updated.title,
        from: task.status,
        to: updated.status,
        status: updated.status,
        source: 'task.runtime.retry',
      }),
    );
    return updated;
  }

  createTaskTemplate(input: CreateTaskTemplateInput, templateId: string, context: CoreOperationContext) {
    const name = requiredText(input.name, 512, 'name');
    const description = requiredText(input.description, 8 * 1024, 'description');
    const promptTemplate = requiredText(input.promptTemplate, 32 * 1024, 'promptTemplate');
    const category = optionalText(input.category, 512, 'category');
    if (input.projectId) this.requireProject(input.projectId);
    if (input.defaultOptions !== undefined && (!isPlainRecord(input.defaultOptions) || jsonBytes(input.defaultOptions) > 8 * 1024)) {
      throw routeError(400, 'ZEUS_INVALID_TEMPLATE', 'defaultOptions must be a plain object within 8 KiB.');
    }
    const template = this.ports.taskTemplates.createCustom({
      id: templateId,
      projectId: input.projectId,
      name,
      description,
      promptTemplate,
      ...(category ? { category } : {}),
      ...(input.defaultOptions ? { defaultOptions: input.defaultOptions } : {}),
    });
    this.audit(context.actor, 'task.template.created', 'task_template', template.id, { templateId: template.id, projectId: template.projectId, category: template.category });
    return template;
  }

  createTaskFromTemplate(templateId: string, input: CreateTaskFromTemplateInput, taskId: string, context: CoreOperationContext): ZeusTaskRecord {
    const projectId = requiredText(input.projectId, 512, 'projectId');
    const project = this.requireProject(projectId);
    const template = this.ports.taskTemplates.getById(templateId);
    if (!template || (template.projectId && template.projectId !== project.id)) throw routeError(404, 'ZEUS_TEMPLATE_NOT_FOUND', 'Task template not found for this project');
    const title = optionalText(input.title, 2 * 1024, 'title');
    const variables = normalizeTemplateVariables(input.variables);
    const task = this.ports.tasks.createFromTemplate({
      id: taskId,
      projectId: project.id,
      managementStatus: this.ports.resolveDefaultManagementStatus(project.id),
      template,
      ...(title ? { title } : {}),
      ...(variables ? { variables } : {}),
    });
    this.ports.recordTaskEvent({ taskId: task.id, eventType: 'task.created.from_template', title: '任务从模板创建', payload: { templateId: template.id, templateName: template.name, builtIn: template.builtIn } });
    this.audit(context.actor, 'task.created.from_template', 'task', task.id, { taskId: task.id, projectId: task.projectId, templateId: template.id });
    this.afterTaskCreated(task, 'template');
    return task;
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) throw routeError(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }

  private requireTask(taskId: string): ZeusTaskRecord {
    const task = this.ports.tasks.getById(taskId);
    if (!task) throw routeError(404, 'ZEUS_TASK_NOT_FOUND', 'Task not found');
    return task;
  }

  private audit(actor: CommandActor, action: string, resourceType: string, resourceId: string, payload: Record<string, unknown>): void {
    this.ports.appendAuditLog({ actorType: actor.kind, ...(actor.id ? { actorRef: actor.id } : {}), action, resourceType, resourceId, payload });
  }

  private afterTaskCreated(task: ZeusTaskRecord, source: string): void {
    this.ports.afterCommit(() => this.ports.publishRealtimeEvent('task.created', { taskId: task.id, projectId: task.projectId, title: task.title, status: task.status, priority: task.priority, source }));
  }
}

function routeError(statusCode: number, error: string, message: string): WorkManagementRouteError {
  return new WorkManagementRouteError(statusCode, { error, message });
}

function requiredText(value: unknown, maximumBytes: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw routeError(400, 'ZEUS_WORK_MANAGEMENT_INPUT_INVALID', `${field} must be a non-empty string within ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function optionalText(value: unknown, maximumBytes: number, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw routeError(400, 'ZEUS_WORK_MANAGEMENT_INPUT_INVALID', `${field} must be a string within ${maximumBytes} UTF-8 bytes.`);
  }
  return value;
}

function normalizeTemplateVariables(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) throw routeError(400, 'ZEUS_INVALID_TEMPLATE_VARIABLES', 'variables must be a plain object.');
  const entries = Object.entries(value);
  if (entries.length > 32) throw routeError(400, 'ZEUS_INVALID_TEMPLATE_VARIABLES', 'variables may contain at most 32 entries.');
  const normalized: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (Buffer.byteLength(key, 'utf8') > 128 || typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 4 * 1024) {
      throw routeError(400, 'ZEUS_INVALID_TEMPLATE_VARIABLES', 'variable names and values exceed the bounded input budget.');
    }
    normalized[key] = item;
  }
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
