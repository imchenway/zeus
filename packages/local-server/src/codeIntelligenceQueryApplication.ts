import type { ProjectRepository, ZeusProjectRecord } from '@zeus/storage';

export class CodeIntelligenceQueryError extends Error {
  constructor(
    readonly statusCode: number,
    readonly payload: Record<string, unknown>,
  ) {
    super(typeof payload.message === 'string' ? payload.message : 'Code intelligence query failed.');
  }
}

interface GraphViewLike {
  id: string;
  schemaVersion: number;
  title: string;
  viewType: string;
  nodes: GraphNodeLike[];
  edges: GraphEdgeLike[];
}

interface GraphNodeLike {
  id: string;
  nodeType: string;
  name: string;
  qualifiedName: string;
  sourceRef: string;
  metadata: Record<string, unknown>;
}

interface GraphEdgeLike {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
}

interface CodeIntelligenceQueryPorts {
  projects: Pick<ProjectRepository, 'getById'>;
  resolveGraphProjectName(project: ZeusProjectRecord): string;
  readEdge(edgeId: string): unknown | undefined;
  readNeighborhood(nodeId: string, depth: number, projectName?: string): unknown | undefined;
  search(query: string, nodeType?: string, edgeType?: string, minConfidence?: string, projectName?: string): unknown;
  readView(viewType: string, projectName?: string): GraphViewLike | undefined;
  readNode(nodeId: string, projectName?: string): unknown | undefined;
  readEdgesByNodeId(nodeId: string, projectName?: string): GraphEdgeLike[];
  attachViewPerformance(view: GraphViewLike, startedAtMs: number): GraphViewLike;
  formatProjectViewTitle(view: GraphViewLike, projectName: string): string;
}

/** 代码智能只读应用；HTTP 不再直接解析图谱缓存或拼装项目级视图。 */
export class CodeIntelligenceQueryApplication {
  constructor(private readonly ports: CodeIntelligenceQueryPorts) {}

  readEdge(edgeId: string): unknown {
    return this.ports.readEdge(edgeId) ?? reject(404, 'ZEUS_GRAPH_EDGE_NOT_FOUND', 'Graph edge not found. Scan the project first.');
  }

  readNeighborhood(nodeId: string, depth: string | undefined, projectId?: string): unknown {
    const projectName = projectId ? this.ports.resolveGraphProjectName(this.requireProject(projectId)) : undefined;
    return this.ports.readNeighborhood(nodeId, normalizeDepth(depth), projectName) ?? reject(404, 'ZEUS_GRAPH_NODE_NOT_FOUND', 'Graph node not found. Scan the project first.');
  }

  search(input: { query?: string; nodeType?: string; edgeType?: string; minConfidence?: string }, projectId?: string): unknown {
    const projectName = projectId ? this.ports.resolveGraphProjectName(this.requireProject(projectId)) : undefined;
    return this.ports.search(input.query ?? '', input.nodeType, input.edgeType, input.minConfidence, projectName);
  }

  listProjectViews(projectId: string): { projectId: string; views: Array<{ id: string; title: string; viewType: string; nodeCount: number; edgeCount: number }> } {
    const project = this.requireProject(projectId);
    const graphProjectName = this.ports.resolveGraphProjectName(project);
    const views = ['architecture', 'module', 'table', 'module_detail', 'api_sequence', 'module_flow', 'method_logic']
      .map((viewType) => this.ports.readView(viewType, graphProjectName))
      .filter((view): view is GraphViewLike => Boolean(view))
      .map((view) => ({ id: view.id, title: this.ports.formatProjectViewTitle(view, project.name), viewType: view.viewType, nodeCount: view.nodes.length, edgeCount: view.edges.length }));
    return { projectId: project.id, views };
  }

  readProjectView(projectId: string, viewId: string): GraphViewLike & { projectId: string; projectName: string } {
    const project = this.requireProject(projectId);
    const startedAt = Date.now();
    const view = this.ports.readView(viewId, this.ports.resolveGraphProjectName(project));
    if (!view) reject(404, 'ZEUS_GRAPH_VIEW_NOT_FOUND', 'Graph view not found. Scan the project first.');
    const measured = this.ports.attachViewPerformance(view, startedAt);
    return { ...measured, title: this.ports.formatProjectViewTitle(measured, project.name), projectId: project.id, projectName: project.name };
  }

  readProjectNode(projectId: string, nodeId: string): unknown {
    const project = this.requireProject(projectId);
    return this.ports.readNode(nodeId, this.ports.resolveGraphProjectName(project)) ?? reject(404, 'ZEUS_GRAPH_NODE_NOT_FOUND', 'Graph node not found. Scan the project first.');
  }

  readGlobalView(viewType: string): GraphViewLike {
    const startedAt = Date.now();
    const view = this.ports.readView(viewType);
    if (!view) reject(404, 'ZEUS_GRAPH_VIEW_NOT_FOUND', 'Graph view not found. Scan the project first.');
    return this.ports.attachViewPerformance(view, startedAt);
  }

  listSemanticNodes(projectId: string, viewType: string, nodeTypes: readonly string[]): { projectId: string; viewType: string; items: GraphNodeLike[] } {
    const project = this.requireProject(projectId);
    const view = this.ports.readView(viewType, this.ports.resolveGraphProjectName(project));
    const allowedTypes = new Set(nodeTypes);
    return { projectId, viewType, items: view?.nodes.filter((node) => allowedTypes.has(node.nodeType)) ?? [] };
  }

  searchTableFields(projectId: string, query: string): { projectId: string; viewType: 'table'; query: string; items: GraphNodeLike[] } {
    const project = this.requireProject(projectId);
    const view = this.ports.readView('table', this.ports.resolveGraphProjectName(project));
    const normalizedQuery = query.trim().toLowerCase();
    const fields = view?.nodes.filter((node) => node.nodeType === 'column') ?? [];
    const items = normalizedQuery
      ? fields.filter((node) => [node.name, node.qualifiedName, node.sourceRef, textMetadata(node, 'tableName'), textMetadata(node, 'tableQualifiedName')].join('\n').toLowerCase().includes(normalizedQuery))
      : fields;
    return { projectId, viewType: 'table', query: query.trim(), items };
  }

  readSemanticNode(projectId: string, nodeId: string, nodeTypes: readonly string[]): { projectId: string; node: GraphNodeLike; relatedEdges: GraphEdgeLike[] } {
    const project = this.requireProject(projectId);
    const graphProjectName = this.ports.resolveGraphProjectName(project);
    const node = this.ports.readNode(nodeId, graphProjectName);
    if (!isGraphNodeLike(node) || !nodeTypes.includes(node.nodeType)) reject(404, 'ZEUS_GRAPH_NODE_NOT_FOUND', 'Graph node not found. Scan the project first.');
    return { projectId, node, relatedEdges: this.ports.readEdgesByNodeId(node.id, graphProjectName) };
  }

  readFocusedSemanticView(
    projectId: string,
    nodeId: string,
    nodeTypes: readonly string[],
    viewType: string,
  ): { projectId: string; node: GraphNodeLike; view: Pick<GraphViewLike, 'id' | 'title' | 'viewType'>; nodes: GraphNodeLike[]; edges: GraphEdgeLike[] } {
    const project = this.requireProject(projectId);
    const graphProjectName = this.ports.resolveGraphProjectName(project);
    const node = this.ports.readNode(nodeId, graphProjectName);
    if (!isGraphNodeLike(node) || !nodeTypes.includes(node.nodeType)) reject(404, 'ZEUS_GRAPH_NODE_NOT_FOUND', 'Graph node not found. Scan the project first.');
    const view = this.ports.readView(viewType, graphProjectName);
    if (!view) reject(404, 'ZEUS_GRAPH_VIEW_NOT_FOUND', 'Graph view not found. Scan the project first.');
    const edges = view.edges.filter((edge) => edge.sourceNodeId === node.id || edge.targetNodeId === node.id);
    const nodeIds = new Set<string>([node.id]);
    for (const edge of edges) {
      nodeIds.add(edge.sourceNodeId);
      nodeIds.add(edge.targetNodeId);
    }
    const relatedNodes = view.nodes.filter((item) => nodeIds.has(item.id));
    return {
      projectId,
      node,
      view: { id: view.id, title: view.title, viewType: view.viewType },
      nodes: relatedNodes.some((item) => item.id === node.id) ? relatedNodes : [node, ...relatedNodes],
      edges,
    };
  }

  private requireProject(projectId: string): ZeusProjectRecord {
    const project = this.ports.projects.getById(projectId);
    if (!project) reject(404, 'ZEUS_PROJECT_NOT_FOUND', 'Project not found');
    return project;
  }
}

function textMetadata(node: GraphNodeLike, key: string): string {
  const value = node.metadata[key];
  return typeof value === 'string' ? value : '';
}

function isGraphNodeLike(value: unknown): value is GraphNodeLike {
  if (!value || typeof value !== 'object') return false;
  const node = value as Partial<GraphNodeLike>;
  return (
    typeof node.id === 'string' &&
    typeof node.nodeType === 'string' &&
    typeof node.name === 'string' &&
    typeof node.qualifiedName === 'string' &&
    typeof node.sourceRef === 'string' &&
    Boolean(node.metadata) &&
    typeof node.metadata === 'object'
  );
}

function normalizeDepth(value: string | undefined): number {
  return Math.max(1, Math.min(2, Number(value ?? '1') || 1));
}

function reject(statusCode: number, error: string, message: string): never {
  throw new CodeIntelligenceQueryError(statusCode, { error, message });
}
