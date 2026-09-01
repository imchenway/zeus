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
import {
  type CreateProjectGraphTaskInput,
  type CreateTaskFromGraphConversationInput,
  type CreateTaskFromGraphNodeInput,
  type CreateTaskFromTemplateInput,
  type CreateTaskTemplateInput,
  type CreateUserTaskInput,
  type LinkGraphNodeInput,
  type WorkManagementCommandActor,
  WorkManagementRouteError,
} from './workManagementCoreCommandRoutes.js';
import { normalizeWorkManagementTaskAttachments } from './workManagementTaskInput.js';

interface CoreOperationContext {
  commandId: string;
  operationIdentity: string;
  actor: WorkManagementCommandActor;
}

interface GraphNodeSource {
  id: string;
  nodeType: string;
  name: string;
  qualifiedName: string;
  sourceRef: string;
  symbolId: string;
  metadata: Record<string, unknown>;
}

interface GraphEdgeSource {
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
  metadata: Record<string, unknown>;
}

interface GraphViewSource {
  id: string;
  title: string;
  viewType: string;
  nodes: GraphNodeSource[];
  edges: GraphEdgeSource[];
}

interface WorkManagementCoreOperationPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'create' | 'createFromTemplate' | 'getById' | 'updateSourceContext' | 'updateStatus'>;
  taskBoards: Pick<TaskBoardRepository, 'getSnapshot' | 'updateSettings'>;
  taskTemplates: Pick<TaskTemplateRepository, 'createCustom' | 'getById'>;
  conversations: Pick<ConversationRepository, 'getById'>;
  resolveDefaultManagementStatus(projectId: string): TaskManagementStatus;
  readGraphNodeForProject(nodeId: string, project: ZeusProjectRecord): { graphProjectName: string; node: GraphNodeSource } | undefined;
  readGraphViewForProject(viewId: string, project: ZeusProjectRecord): { graphProjectName: string; view: GraphViewSource } | undefined;
  readGraphEdgesByNode(nodeId: string, graphProjectName: string): GraphEdgeSource[];
  readGraphEdge(edgeId: string): (GraphEdgeSource & { sourceNode: GraphNodeSource; targetNode: GraphNodeSource }) | undefined;
  recordTaskEvent(input: CreateTaskEventInput): void;
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  afterCommit(callback: () => void): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): void;
}

/**
 * 模板、看板设置和图谱建任务只修改 Core SQLite 事实。公开路由先通过统一命令信封，
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

  createTaskFromGraphConversation(projectId: string, conversationId: string, input: CreateTaskFromGraphConversationInput, taskId: string, context: CoreOperationContext): ZeusTaskRecord {
    const project = this.requireProject(projectId);
    const conversation = this.ports.conversations.getById(conversationId);
    if (!conversation || conversation.projectId !== project.id) throw routeError(404, 'ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found');
    const userMessage = conversation.messages.find((message) => message.role === 'user');
    const assistantMessage = [...conversation.messages].reverse().find((message) => message.role === 'assistant');
    if (!userMessage || !assistantMessage) throw routeError(409, 'ZEUS_CONVERSATION_INCOMPLETE', 'Conversation does not contain both question and answer messages');
    const metadata = parseJsonObject(assistantMessage.metadataJson);
    const sourceNodeIds = boundedStringArray(metadata.sourceNodeIds, 20);
    const sourceEdgeIds = boundedStringArray(metadata.sourceEdgeIds, 40);
    const sourceNodes = sourceNodeIds
      .map((nodeId) => this.ports.readGraphNodeForProject(nodeId, project)?.node)
      .filter((node): node is GraphNodeSource => Boolean(node))
      .slice(0, 12)
      .map(boundedGraphNode);
    const sourceEdges = sourceEdgeIds
      .map((edgeId) => this.ports.readGraphEdge(edgeId))
      .filter((edge): edge is GraphEdgeSource & { sourceNode: GraphNodeSource; targetNode: GraphNodeSource } => Boolean(edge))
      .slice(0, 24)
      .map(boundedGraphEdge);
    const suggestedTestScope = Array.from(new Set([...sourceNodes.map((node) => node.sourceRef), ...sourceEdges.map((edge) => edge.sourceRef)].filter(Boolean))).slice(0, 24);
    const question = boundedText(userMessage.content, 4 * 1024);
    const answer = boundedText(assistantMessage.content, 8 * 1024);
    const intent = optionalText(input.intent, 8 * 1024, 'intent') ?? '基于这次图谱问答创建可执行跟进任务。';
    const task = this.ports.tasks.create({
      id: taskId,
      projectId: project.id,
      managementStatus: this.ports.resolveDefaultManagementStatus(project.id),
      title: `跟进图谱问答：${boundedText(userMessage.content, 192)}`,
      taskType: 'requirement',
      description: [intent, `问题：${question}`, `回答摘要：${boundedText(assistantMessage.content, 2 * 1024)}`, suggestedTestScope.length > 0 ? `建议验证范围：${suggestedTestScope.join(', ')}` : '建议验证范围：等待更多图谱来源'].join(
        '\n',
      ),
      createdFrom: 'graph_question',
      sourceContext: {
        graphQuestion: { conversationId: conversation.id, question, answer, sourceNodeIds, sourceEdgeIds },
        sourceNodes,
        sourceEdges,
        suggestedTestScope,
        riskHints: ['核对 AI 回答来源节点是否仍与当前代码一致', '优先补充来源文件相关验收', '若图谱来源不足，先重新扫描真实代码库'],
      },
      tags: ['graph-question'],
    });
    this.ports.recordTaskEvent({ taskId: task.id, eventType: 'task.created.from_graph_question', title: '任务从图谱问答创建', payload: { conversationId: conversation.id, sourceNodeIds, sourceEdgeIds } });
    this.audit(context.actor, 'graph.conversation.task.created', 'task', task.id, { projectId: project.id, conversationId: conversation.id, sourceNodeCount: sourceNodeIds.length, sourceEdgeCount: sourceEdgeIds.length });
    this.afterTaskCreated(task, 'graph_question');
    return task;
  }

  createTaskFromGraphNode(projectId: string | null, nodeId: string, input: CreateTaskFromGraphNodeInput | CreateProjectGraphTaskInput, taskId: string, context: CoreOperationContext): ZeusTaskRecord {
    if (!projectId) throw routeError(400, 'ZEUS_PROJECT_REQUIRED', 'projectId is required');
    const project = this.requireProject(projectId);
    const resolved = this.ports.readGraphNodeForProject(requiredText(nodeId, 512, 'nodeId'), project);
    if (!resolved) throw routeError(404, 'ZEUS_GRAPH_NODE_NOT_FOUND', 'Graph node not found. Scan the project first.');
    const node = boundedGraphNode(resolved.node);
    const edges = this.ports.readGraphEdgesByNode(node.id, resolved.graphProjectName).slice(0, 24).map(boundedGraphEdge);
    const lineStart = finiteMetadataNumber(resolved.node.metadata.lineStart);
    const lineEnd = finiteMetadataNumber(resolved.node.metadata.lineEnd);
    const intent = optionalText(input.intent, 8 * 1024, 'intent') ?? '基于代码图谱分析该节点的实现风险、影响范围和建议验证范围。';
    const task = this.ports.tasks.create({
      id: taskId,
      projectId: project.id,
      managementStatus: this.ports.resolveDefaultManagementStatus(project.id),
      title: `分析图谱节点：${node.name}`,
      taskType: 'requirement',
      description: [intent, `节点类型：${node.nodeType}`, `来源：${node.sourceRef}${lineStart ? `:${lineStart}${lineEnd ? `-${lineEnd}` : ''}` : ''}`].join('\n'),
      createdFrom: 'graph_node',
      sourceContext: {
        graphNode: node,
        relatedEdges: edges,
        suggestedVerificationScope: Array.from(new Set([node.sourceRef, ...edges.map((edge) => edge.sourceRef)])).slice(0, 24),
        riskHints: ['检查节点上下游影响', '执行相关静态检查与构建', '如节点涉及运行时入口需验证本地服务 API'],
      },
    });
    this.ports.recordTaskEvent({ taskId: task.id, eventType: 'task.created.from_graph_node', title: '任务从图谱节点创建', payload: { nodeId: node.id, sourceRef: node.sourceRef } });
    this.audit(context.actor, 'graph.node.task.created', 'task', task.id, { taskId: task.id, projectId: project.id, nodeId: node.id });
    this.afterTaskCreated(task, 'graph_node');
    return task;
  }

  createTaskFromGraphView(projectId: string, viewId: string, input: CreateProjectGraphTaskInput, taskId: string, context: CoreOperationContext): ZeusTaskRecord {
    const project = this.requireProject(projectId);
    const resolved = this.ports.readGraphViewForProject(requiredText(viewId, 512, 'viewId'), project);
    if (!resolved) throw routeError(404, 'ZEUS_GRAPH_VIEW_NOT_FOUND', 'Graph view not found. Scan the project first.');
    const view = resolved.view;
    const sourceNodes = view.nodes.slice(0, 12).map(boundedGraphNode);
    const sourceEdges = view.edges.slice(0, 24).map(boundedGraphEdge);
    const intent = optionalText(input.intent, 8 * 1024, 'intent') ?? '基于当前代码图谱视图分析架构风险、影响范围和建议验收范围。';
    const task = this.ports.tasks.create({
      id: taskId,
      projectId: project.id,
      managementStatus: this.ports.resolveDefaultManagementStatus(project.id),
      title: `分析图谱视图：${boundedText(view.title, 512)}`,
      taskType: 'requirement',
      description: [intent, `视图类型：${boundedText(view.viewType, 256)}`, `节点数：${view.nodes.length}`, `边数：${view.edges.length}`].join('\n'),
      createdFrom: 'graph_view',
      sourceContext: {
        graphView: { id: boundedText(view.id, 512), title: boundedText(view.title, 512), viewType: boundedText(view.viewType, 256), nodeCount: view.nodes.length, edgeCount: view.edges.length },
        sourceNodes,
        sourceEdges,
        suggestedTestScope: Array.from(new Set(sourceNodes.map((node) => node.sourceRef).filter(Boolean))).slice(0, 24),
        riskHints: ['按视图节点逐项核对影响面', '优先补齐来源文件验收', '如果视图过大，先缩小到关键节点再执行'],
      },
    });
    this.ports.recordTaskEvent({ taskId: task.id, eventType: 'task.created.from_graph_view', title: '任务从图谱视图创建', payload: { viewId: view.id, viewType: view.viewType, nodeCount: view.nodes.length, edgeCount: view.edges.length } });
    this.audit(context.actor, 'graph.view.task.created', 'task', task.id, { taskId: task.id, projectId: project.id, viewId: view.id });
    this.afterTaskCreated(task, 'graph_view');
    return task;
  }

  linkTaskGraphNode(taskId: string, input: LinkGraphNodeInput, context: CoreOperationContext): ZeusTaskRecord {
    const task = this.requireTask(taskId);
    const nodeId = requiredText(input.nodeId, 512, 'nodeId');
    const project = this.requireProject(task.projectId);
    const resolved = this.ports.readGraphNodeForProject(nodeId, project);
    if (!resolved) throw routeError(404, 'ZEUS_GRAPH_NODE_NOT_FOUND', 'Graph node not found. Scan the project first.');
    const node = boundedGraphNode(resolved.node);
    const reason = optionalText(input.reason, 2 * 1024, 'reason') ?? '手动关联图谱节点';
    const sourceContext = parseJsonObject(task.sourceContextJson);
    const existingLinks = Array.isArray(sourceContext.linkedGraphNodes)
      ? sourceContext.linkedGraphNodes
          .filter(isPlainRecord)
          .filter((item) => item.id !== node.id)
          .slice(-23)
      : [];
    const linkedGraphNodes = [...existingLinks, { id: node.id, name: node.name, nodeType: node.nodeType, sourceRef: node.sourceRef, reason }];
    const existingScopes = boundedStringArray(sourceContext.suggestedTestScope, 23);
    const updated = this.ports.tasks.updateSourceContext(task.id, {
      ...sourceContext,
      linkedGraphNodes,
      suggestedTestScope: Array.from(new Set([...existingScopes, node.sourceRef])).slice(-24),
    });
    this.ports.recordTaskEvent({ taskId: updated.id, eventType: 'task.linked_graph_node', title: '任务关联图谱节点', payload: { nodeId: node.id, sourceRef: node.sourceRef, reason } });
    this.audit(context.actor, 'task.graph_node.linked', 'task', updated.id, { taskId: updated.id, projectId: updated.projectId, nodeId: node.id });
    this.ports.afterCommit(() => this.ports.publishRealtimeEvent('task.updated', { taskId: updated.id, projectId: updated.projectId, changedFields: ['sourceContext'], updatedAt: updated.updatedAt }));
    return updated;
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

function boundedText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function boundedStringArray(value: unknown, maximumItems: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maximumItems)
    .map((item) => boundedText(item, 512));
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

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boundedGraphNode(node: GraphNodeSource) {
  return {
    id: boundedText(node.id, 256),
    nodeType: boundedText(node.nodeType, 128),
    name: boundedText(node.name, 512),
    qualifiedName: boundedText(node.qualifiedName, 768),
    sourceRef: boundedText(node.sourceRef, 768),
    symbolId: boundedText(node.symbolId, 256),
    metadata: boundedMetadata(node.metadata),
  };
}

function boundedGraphEdge(edge: GraphEdgeSource) {
  return {
    id: boundedText(edge.id, 256),
    edgeType: boundedText(edge.edgeType, 128),
    sourceNodeId: boundedText(edge.sourceNodeId, 256),
    targetNodeId: boundedText(edge.targetNodeId, 256),
    sourceRef: boundedText(edge.sourceRef, 768),
    confidence: Number.isFinite(edge.confidence) ? edge.confidence : 0,
  };
}

function boundedMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ['lineStart', 'lineEnd', 'language', 'kind', 'visibility']) {
    const value = metadata[key];
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
    else if (typeof value === 'string') result[key] = boundedText(value, 256);
    else if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

function finiteMetadataNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
