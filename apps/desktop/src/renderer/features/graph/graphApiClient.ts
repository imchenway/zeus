import type {
  AskGraphRequest,
  CreateTaskFromGraphConversationRequest,
  FocusedSemanticGraphView,
  GraphConversationHistoryItem,
  GraphConversationHistoryPage,
  GraphEdgeDetail,
  GraphNeighborhood,
  GraphQuestionAnswer,
  GraphScanResult,
  GraphSearchRequest,
  GraphSearchResult,
  GraphViewSnapshot,
  GraphViewType,
  LoadGraphConversationsRequest,
  SemanticGraphNodeDetail,
  SemanticGraphNodeList,
  SendConversationMessageResult,
} from './graphContracts.js';
import type { ProjectOverview, ProjectScanStatus } from '../projects/projectContracts.js';
import type { CreateProjectGraphTaskRequest, CreateTaskFromGraphNodeRequest, CreateTaskFromTemplateRequest, CreateTaskTemplateRequest, LinkGraphNodeRequest, TaskRecord, TaskTemplateRecord } from '../tasks/taskContracts.js';
import { buildGraphConversationCommandRequest, currentGraphClientScopeId, graphConversationClientCommandTypes } from '../conversations/graphConversationCommandClient.js';
import { buildWorkManagementCommandRequest, workManagementClientCommandTypes } from '../work-management/workManagementCommandClient.js';
import type { LocalApiTransport } from '../../transport/localApiTransport.js';

export interface GraphApiClient {
  loadTaskTemplates: (projectId?: string) => Promise<TaskTemplateRecord[]>;
  scanCurrentGraph: () => Promise<GraphScanResult>;
  loadGraphView: (viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  searchGraph: (input: GraphSearchRequest) => Promise<GraphSearchResult>;
  loadProjectGraphView: (projectId: string, viewType?: GraphViewType) => Promise<GraphViewSnapshot>;
  searchProjectGraph: (projectId: string, input: GraphSearchRequest) => Promise<GraphSearchResult>;
  loadProjectGraphNode: (projectId: string, nodeId: string) => Promise<GraphViewSnapshot['nodes'][number]>;
  loadProjectGraphNeighborhood: (projectId: string, nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  loadProjectApis: (projectId: string) => Promise<SemanticGraphNodeList>;
  loadProjectApi: (projectId: string, apiId: string) => Promise<SemanticGraphNodeDetail>;
  loadProjectApiSequence: (projectId: string, apiId: string) => Promise<FocusedSemanticGraphView>;
  loadProjectModules: (projectId: string) => Promise<SemanticGraphNodeList>;
  loadProjectModule: (projectId: string, moduleId: string) => Promise<SemanticGraphNodeDetail>;
  loadProjectModuleFlow: (projectId: string, moduleId: string) => Promise<FocusedSemanticGraphView>;
  loadProjectTables: (projectId: string) => Promise<SemanticGraphNodeList>;
  searchProjectTableFields: (projectId: string, query: string) => Promise<SemanticGraphNodeList & { query: string }>;
  loadProjectTable: (projectId: string, tableId: string) => Promise<SemanticGraphNodeDetail>;
  loadProjectTableImpact: (projectId: string, tableId: string) => Promise<FocusedSemanticGraphView>;
  loadProjectMethodLogic: (projectId: string, methodId: string) => Promise<FocusedSemanticGraphView>;
  askGraph: (projectId: string, input: AskGraphRequest) => Promise<GraphQuestionAnswer>;
  loadGraphConversations: (projectId: string, input?: LoadGraphConversationsRequest) => Promise<GraphConversationHistoryPage>;
  loadGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  sendConversationMessage: (projectId: string, conversationId: string, content: string) => Promise<SendConversationMessageResult>;
  archiveGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  restoreGraphConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  createTaskFromGraphConversation: (projectId: string, conversationId: string, input?: CreateTaskFromGraphConversationRequest) => Promise<TaskRecord>;
  loadGraphEdgeDetail: (edgeId: string) => Promise<GraphEdgeDetail>;
  loadGraphNeighborhood: (nodeId: string, depth?: 1 | 2) => Promise<GraphNeighborhood>;
  scanProject: (projectId: string) => Promise<GraphScanResult>;
  loadProjectScanStatus: (projectId: string) => Promise<ProjectScanStatus>;
  loadProjectOverview: (projectId: string) => Promise<ProjectOverview>;
  createTaskFromGraphNode: (nodeId: string, input: CreateTaskFromGraphNodeRequest) => Promise<TaskRecord>;
  createProjectTaskFromGraphNode: (projectId: string, nodeId: string, input?: CreateProjectGraphTaskRequest) => Promise<TaskRecord>;
  createProjectTaskFromGraphView: (projectId: string, viewId: string, input?: CreateProjectGraphTaskRequest) => Promise<TaskRecord>;
  linkTaskGraphNode: (taskId: string, input: LinkGraphNodeRequest) => Promise<TaskRecord>;
  createTaskTemplate: (input: CreateTaskTemplateRequest) => Promise<TaskTemplateRecord>;
  createTaskFromTemplate: (templateId: string, input: CreateTaskFromTemplateRequest) => Promise<TaskRecord>;
}

export function createGraphApiClient(transport: LocalApiTransport): GraphApiClient {
  return {
    loadTaskTemplates: (projectId) => transport.request<TaskTemplateRecord[]>(`/api/task-templates${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
    scanCurrentGraph: async () => {
      const body = await buildGraphConversationCommandRequest({
        commandType: graphConversationClientCommandTypes.currentGraphScan,
        scopeKind: 'project',
        scopeId: currentGraphClientScopeId,
        value: {},
      });
      return transport.request<GraphScanResult>('/api/graph/scan-current', { method: 'POST', body: JSON.stringify(body) });
    },
    loadGraphView: (viewType = 'architecture') => transport.request<GraphViewSnapshot>(`/api/graph/views/${viewType}`),
    searchGraph: (input) =>
      transport.request<GraphSearchResult>(
        `/api/graph/search?query=${encodeURIComponent(input.query)}${input.nodeType ? `&nodeType=${encodeURIComponent(input.nodeType)}` : ''}${input.edgeType ? `&edgeType=${encodeURIComponent(input.edgeType)}` : ''}${typeof input.minConfidence === 'number' ? `&minConfidence=${input.minConfidence}` : ''}`,
      ),
    loadProjectGraphView: (projectId, viewType = 'architecture') => transport.request<GraphViewSnapshot>(`/api/projects/${projectId}/graph/views/${viewType}`),
    searchProjectGraph: (projectId, input) =>
      transport.request<GraphSearchResult>(
        `/api/projects/${projectId}/graph/search?query=${encodeURIComponent(input.query)}${input.nodeType ? `&nodeType=${encodeURIComponent(input.nodeType)}` : ''}${input.edgeType ? `&edgeType=${encodeURIComponent(input.edgeType)}` : ''}${typeof input.minConfidence === 'number' ? `&minConfidence=${input.minConfidence}` : ''}`,
      ),
    loadProjectGraphNode: (projectId, nodeId) => transport.request<GraphViewSnapshot['nodes'][number]>(`/api/projects/${projectId}/graph/nodes/${nodeId}`),
    loadProjectGraphNeighborhood: (projectId, nodeId, depth = 1) => transport.request<GraphNeighborhood>(`/api/projects/${projectId}/graph/nodes/${nodeId}/neighborhood?depth=${depth}`),
    loadProjectApis: (projectId) => transport.request<SemanticGraphNodeList>(`/api/projects/${projectId}/apis`),
    loadProjectApi: (projectId, apiId) => transport.request<SemanticGraphNodeDetail>(`/api/projects/${projectId}/apis/${apiId}`),
    loadProjectApiSequence: (projectId, apiId) => transport.request<FocusedSemanticGraphView>(`/api/projects/${projectId}/apis/${apiId}/sequence`),
    loadProjectModules: (projectId) => transport.request<SemanticGraphNodeList>(`/api/projects/${projectId}/modules`),
    loadProjectModule: (projectId, moduleId) => transport.request<SemanticGraphNodeDetail>(`/api/projects/${projectId}/modules/${moduleId}`),
    loadProjectModuleFlow: (projectId, moduleId) => transport.request<FocusedSemanticGraphView>(`/api/projects/${projectId}/modules/${moduleId}/flow`),
    loadProjectTables: (projectId) => transport.request<SemanticGraphNodeList>(`/api/projects/${projectId}/tables`),
    searchProjectTableFields: (projectId, query) => transport.request<SemanticGraphNodeList & { query: string }>(`/api/projects/${projectId}/tables/columns/search?query=${encodeURIComponent(query)}`),
    loadProjectTable: (projectId, tableId) => transport.request<SemanticGraphNodeDetail>(`/api/projects/${projectId}/tables/${tableId}`),
    loadProjectTableImpact: (projectId, tableId) => transport.request<FocusedSemanticGraphView>(`/api/projects/${projectId}/tables/${tableId}/impact`),
    loadProjectMethodLogic: (projectId, methodId) => transport.request<FocusedSemanticGraphView>(`/api/projects/${projectId}/methods/${methodId}/logic`),
    askGraph: async (projectId, input) => {
      const body = await buildGraphConversationCommandRequest({
        commandType: graphConversationClientCommandTypes.projectGraphAsk,
        scopeKind: 'project',
        scopeId: projectId,
        value: input,
      });
      return transport.request<GraphQuestionAnswer>(`/api/projects/${projectId}/ask`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadGraphConversations: (projectId, input) => transport.request<GraphConversationHistoryPage>(`/api/projects/${projectId}/conversations${toGraphConversationQuery(input)}`),
    loadGraphConversation: (projectId, conversationId) => transport.request<GraphConversationHistoryItem>(`/api/projects/${projectId}/conversations/${conversationId}`),
    sendConversationMessage: (projectId, conversationId, content) =>
      transport.request<SendConversationMessageResult>(`/api/projects/${projectId}/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      }),
    archiveGraphConversation: (projectId, conversationId) => transport.request<GraphConversationHistoryItem>(`/api/projects/${projectId}/conversations/${conversationId}/archive`, { method: 'POST' }),
    restoreGraphConversation: (projectId, conversationId) => transport.request<GraphConversationHistoryItem>(`/api/projects/${projectId}/conversations/${conversationId}/restore`, { method: 'POST' }),
    createTaskFromGraphConversation: async (projectId, conversationId, input) => {
      const idempotencyKey = input?.idempotencyKey ?? crypto.randomUUID();
      const value = input?.intent === undefined ? {} : { intent: input.intent };
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskFromGraphConversationCreate,
        scopeKind: 'task',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'task_',
        operationSeed: idempotencyKey,
        value,
      });
      return transport.request<TaskRecord>(`/api/projects/${projectId}/conversations/${conversationId}/tasks`, { method: 'POST', body: JSON.stringify(body) });
    },
    loadGraphEdgeDetail: (edgeId) => transport.request<GraphEdgeDetail>(`/api/graph/edges/${edgeId}`),
    loadGraphNeighborhood: (nodeId, depth = 1) => transport.request<GraphNeighborhood>(`/api/graph/nodes/${nodeId}/neighborhood?depth=${depth}`),
    scanProject: async (projectId) => {
      const body = await buildGraphConversationCommandRequest({
        commandType: graphConversationClientCommandTypes.projectGraphScan,
        scopeKind: 'project',
        scopeId: projectId,
        value: {},
      });
      return transport.request<GraphScanResult>(`/api/projects/${projectId}/scan`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadProjectScanStatus: (projectId) => transport.request<ProjectScanStatus>(`/api/projects/${projectId}/scan-status`),
    loadProjectOverview: (projectId) => transport.request<ProjectOverview>(`/api/projects/${projectId}/overview`),
    createTaskFromGraphNode: async (nodeId, input) => {
      const { idempotencyKey, ...body } = input;
      const commandBody = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskFromGraphNodeCreate,
        scopeKind: 'task',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'task_',
        operationSeed: idempotencyKey,
        value: body,
      });
      return transport.request<TaskRecord>(`/api/graph/nodes/${nodeId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(commandBody),
      });
    },
    createProjectTaskFromGraphNode: async (projectId, nodeId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskFromGraphNodeCreate,
        scopeKind: 'task',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'task_',
        value: input ?? {},
      });
      return transport.request<TaskRecord>(`/api/projects/${projectId}/graph/nodes/${nodeId}/create-task`, { method: 'POST', body: JSON.stringify(body) });
    },
    createProjectTaskFromGraphView: async (projectId, viewId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskFromGraphViewCreate,
        scopeKind: 'task',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'task_',
        value: input ?? {},
      });
      return transport.request<TaskRecord>(`/api/projects/${projectId}/graph/views/${viewId}/create-task`, { method: 'POST', body: JSON.stringify(body) });
    },
    linkTaskGraphNode: async (taskId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskGraphNodeLink,
        scopeKind: 'task',
        scopeId: () => taskId,
        operationPrefix: 'task_graph_node_link_',
        value: input,
      });
      return transport.request<TaskRecord>(`/api/tasks/${taskId}/link-graph-node`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    createTaskTemplate: async (input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskTemplateCreate,
        scopeKind: 'project',
        scopeId: () => input.projectId ?? 'global',
        operationPrefix: 'task_template_',
        value: input,
      });
      return transport.request<TaskTemplateRecord>('/api/task-templates', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    createTaskFromTemplate: async (templateId, input) => {
      const { idempotencyKey, ...body } = input;
      const commandBody = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.taskFromTemplateCreate,
        scopeKind: 'task',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'task_',
        operationSeed: idempotencyKey,
        value: body,
      });
      return transport.request<TaskRecord>(`/api/task-templates/${templateId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(commandBody),
      });
    },
  };
}

function toGraphConversationQuery(input?: LoadGraphConversationsRequest): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  if (typeof input?.offset === 'number') params.set('offset', String(input.offset));
  if (input?.archived) params.set('archived', 'true');
  const query = params.toString();
  return query ? '?' + query : '';
}
