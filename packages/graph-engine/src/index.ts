import {nanoid} from 'nanoid';

interface CodeSymbolFact {
  id: string;
  symbolType: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  language: string;
  sourceHash: string;
  metadata: Record<string, unknown>;
}

interface ProjectScanResult {
  projectName: string;
  rootPath: string;
  symbols: CodeSymbolFact[];
}

export interface ProjectGraphNode {
  id: string;
  nodeType: string;
  name: string;
  qualifiedName: string;
  sourceRef: string;
  symbolId: string;
  metadata: Record<string, unknown>;
}

export interface ProjectGraphEdge {
  id: string;
  edgeType:
    | 'contains'
    | 'declares'
    | 'references'
    | 'exposes_api'
    | 'handles_api'
    | 'control_flow'
    | 'next_control_flow'
    | 'branch_true'
    | 'branch_false'
    | 'loop_back'
    | 'loop_continue'
    | 'loop_break'
    | 'try_catch'
    | 'try_finally'
    | 'promise_catch'
    | 'promise_then'
    | 'awaits_call'
    | 'executes_sql'
    | 'reads_table'
    | 'writes_table'
    | 'uses_column'
    | 'calls'
    | 'resolves_to'
    | 'module_depends_on';
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export type GraphViewType = 'architecture' | 'module' | 'table' | 'module_detail' | 'api_sequence' | 'module_flow' | 'method_logic';
const ARCHITECTURE_VIEW_NODE_LIMIT = 250;
const MODULE_VIEW_NODE_LIMIT = 1200;
const TABLE_VIEW_NODE_LIMIT = 1200;
const MODULE_DETAIL_VIEW_NODE_LIMIT = 250;
const MODULE_FLOW_VIEW_NODE_LIMIT = 220;
const METHOD_LOGIC_VIEW_NODE_LIMIT = 6000;

export interface ProjectGraphView {
  id: string;
  viewType: GraphViewType;
  title: string;
  nodeIds: string[];
  edgeIds: string[];
  layout: ProjectGraphLayout;
}

export interface ProjectGraphLayout {
  algorithm: 'hierarchical';
  width: number;
  height: number;
  positions: Array<{ nodeId: string; x: number; y: number }>;
}

export interface ProjectGraph {
  projectName: string;
  rootPath: string;
  nodes: ProjectGraphNode[];
  edges: ProjectGraphEdge[];
  views: ProjectGraphView[];
}

/** 从真实扫描事实生成图谱节点和边，不创建无来源节点。 */
export function buildProjectGraph(scan: ProjectScanResult): ProjectGraph {
  const nodes = scan.symbols.map((symbol) => toGraphNode(symbol));
  const nodeBySymbolId = new Map(nodes.map((node) => [node.symbolId, node]));
  const nodeByQualifiedName = new Map(nodes.map((node) => [node.qualifiedName, node]));
  const fileNodesByPath = new Map(nodes.filter((node) => node.nodeType === 'file').map((node) => [node.sourceRef, node]));
  const edges: ProjectGraphEdge[] = [];
  for (const symbol of scan.symbols) {
    if (symbol.symbolType === 'file') continue;
    const fileNode = fileNodesByPath.get(symbol.filePath);
    const target = nodeBySymbolId.get(symbol.id);
    if (!fileNode || !target) continue;
    edges.push({
      id: `edge_${nanoid(12)}`,
      edgeType: graphEdgeTypeForSymbol(symbol.symbolType),
      sourceNodeId: fileNode.id,
      targetNodeId: target.id,
      sourceRef: symbol.filePath,
      confidence: 1,
    });
  }
  edges.push(...buildApiHandlerEdges(nodes, nodeByQualifiedName));
  edges.push(...buildFunctionCallEdges(nodes, nodeByQualifiedName));
  edges.push(...buildResolvedCallTargetEdges(nodes, nodeByQualifiedName));
  edges.push(...buildFunctionControlFlowEdges(nodes, nodeByQualifiedName));
  edges.push(...buildSequentialControlFlowEdges(nodes));
  edges.push(...buildControlBranchEdges(nodes));
  edges.push(...buildLoopBackEdges(nodes));
  edges.push(...buildLoopControlTransferEdges(nodes));
  edges.push(...buildExceptionBranchEdges(nodes));
  edges.push(...buildAwaitedCallEdges(nodes, nodeByQualifiedName));
  edges.push(...buildPromiseChainEdges(nodes));
  edges.push(...buildFunctionSqlCallEdges(nodes, nodeByQualifiedName));
  edges.push(...buildSqlTableImpactEdges(nodes, nodeByQualifiedName));
  edges.push(...buildTableColumnEdges(nodes, nodeByQualifiedName));
  edges.push(...buildSqlColumnImpactEdges(nodes, nodeByQualifiedName));
  edges.push(...buildImportDependencyEdges(nodes, nodeByQualifiedName));
  edges.push(...buildSqlJoinRelationEdges(nodes));
  edges.push(...buildTableReferenceEdges(nodes));
  return {
    projectName: scan.projectName,
    rootPath: scan.rootPath,
    nodes,
    edges,
    views: buildGraphViews(scan.projectName, nodes, edges),
  };
}

export function assertNonEmptyGraph(graph: ProjectGraph): void {
  if (graph.nodes.length === 0 || graph.edges.length === 0 || graph.views.length === 0) {
    throw new Error(`Zeus graph is empty: nodes=${graph.nodes.length}, edges=${graph.edges.length}, views=${graph.views.length}`);
  }
}

function toGraphNode(symbol: CodeSymbolFact): ProjectGraphNode {
  return {
    id: `node_${nanoid(12)}`,
    nodeType: symbol.symbolType,
    name: symbol.name,
    qualifiedName: symbol.qualifiedName,
    sourceRef: symbol.filePath,
    symbolId: symbol.id,
    metadata: {
      language: symbol.language,
      lineStart: symbol.lineStart,
      lineEnd: symbol.lineEnd,
      sourceHash: symbol.sourceHash,
      ...symbol.metadata,
    },
  };
}

/** 生成设计书要求的多类图谱视图；所有节点和边都来自真实扫描事实。 */
function buildGraphViews(projectName: string, nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): ProjectGraphView[] {
  const nodeIds = nodes.map((node) => node.id);
  const architectureNodeIds = nodeIds.slice(0, ARCHITECTURE_VIEW_NODE_LIMIT);
  // 架构图节点有上限时，边必须跟随可见节点二次裁剪；否则大型仓库会把不可见端点交给 Graphology/Sigma 导致渲染崩溃。
  const architectureEdgeIds = pickEdgesForNodes(edges, architectureNodeIds).slice(0, 500);
  // 模块图和表关系图也必须在服务端裁剪；真实 Java 大仓可能有上万文件/表字段，不能把超大 payload 交给 Electron 渲染进程。
  const moduleNodeIds = pickNodeIdsByTypePriority(nodes, ['package', 'file', 'class', 'interface', 'type']).slice(0, MODULE_VIEW_NODE_LIMIT);
  const tableNodeIds = pickSqlNodeIds(nodes).slice(0, TABLE_VIEW_NODE_LIMIT);
  const moduleDetailNodeIds = pickNodeIds(nodes, ['file', 'function', 'class', 'interface', 'type']).slice(0, MODULE_DETAIL_VIEW_NODE_LIMIT);
  const moduleFlowNodeIds = pickNodeIds(nodes, ['package', 'file', 'function']).slice(0, MODULE_FLOW_VIEW_NODE_LIMIT);
  const methodLogicNodeIds = pickMethodLogicNodeIds(nodes, edges).slice(0, METHOD_LOGIC_VIEW_NODE_LIMIT);
  return [
    makeGraphView(projectName, 'architecture', '系统架构图', architectureNodeIds, architectureEdgeIds),
    makeGraphView(projectName, 'module', '模块图', moduleNodeIds, pickModuleViewEdgeIds(edges, moduleNodeIds).slice(0, 500)),
    makeGraphView(projectName, 'table', '表关系图', tableNodeIds, pickEdgesForNodes(edges, tableNodeIds).slice(0, 1000)),
    makeGraphView(
      projectName,
      'module_detail',
      '模块详情图',
      moduleDetailNodeIds,
      // 所有带节点上限的视图都必须按最终可见节点裁剪边，避免扫描大仓库后画布拿到悬空边直接崩溃。
      pickEdgesForNodes(edges, moduleDetailNodeIds).slice(0, 500),
    ),
    makeApiSequenceGraphView(projectName, nodes, edges),
    makeGraphView(projectName, 'module_flow', '模块流程图', moduleFlowNodeIds, pickEdgesForNodes(edges, moduleFlowNodeIds).slice(0, 440)),
    // 方法逻辑图保留真实源码控制流，但默认视图不能把整仓控制流全量交给 Electron；先按证据优先级选节点，再用可见节点裁剪边。
    makeGraphView(projectName, 'method_logic', '方法逻辑图', methodLogicNodeIds, pickMethodLogicEdgeIds(edges, methodLogicNodeIds).slice(0, 20000)),
  ];
}

function graphEdgeTypeForSymbol(symbolType: string): ProjectGraphEdge['edgeType'] {
  if (symbolType === 'package') return 'contains';
  if (symbolType === 'api') return 'exposes_api';
  if (symbolType === 'control_flow') return 'control_flow';
  return 'declares';
}

function makeApiSequenceGraphView(projectName: string, nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): ProjectGraphView {
  const nodeIds = pickApiSequenceNodeIds(nodes).slice(0, 2000);
  // API 时序图边必须基于最终进入视图的节点裁剪，避免真实大仓库节点上限造成边引用视图外节点。
  return makeGraphView(projectName, 'api_sequence', '接口时序图', nodeIds, pickApiSequenceEdgeIds(edges, nodeIds).slice(0, 5000));
}

function makeGraphView(projectName: string, viewType: GraphViewType, label: string, nodeIds: string[], edgeIds: string[]): ProjectGraphView {
  return {
    id: `view_${nanoid(12)}`,
    viewType,
    title: `${projectName} ${label}`,
    nodeIds,
    edgeIds,
    layout: buildDeterministicGraphLayout(nodeIds),
  };
}

/** 在服务端为缓存视图预计算确定性布局；只使用真实节点 ID，不生成额外图谱事实。 */
function buildDeterministicGraphLayout(nodeIds: string[]): ProjectGraphLayout {
  const width = 1440;
  const height = 900;
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(nodeIds.length, 1))));
  const rows = Math.max(1, Math.ceil(Math.max(nodeIds.length, 1) / columns));
  const columnGap = width / (columns + 1);
  const rowGap = height / (rows + 1);
  return {
    algorithm: 'hierarchical',
    width,
    height,
    positions: nodeIds.map((nodeId, index) => ({
      nodeId,
      x: Math.round(((index % columns) + 1) * columnGap),
      y: Math.round((Math.floor(index / columns) + 1) * rowGap),
    })),
  };
}

function pickNodeIds(nodes: ProjectGraphNode[], nodeTypes: string[]): string[] {
  const allowedTypes = new Set(nodeTypes);
  return nodes.filter((node) => allowedTypes.has(node.nodeType)).map((node) => node.id);
}

function pickNodeIdsByTypePriority(nodes: ProjectGraphNode[], nodeTypes: string[]): string[] {
  return nodeTypes.flatMap((nodeType) => nodes.filter((node) => node.nodeType === nodeType).map((node) => node.id));
}

function pickApiSequenceNodeIds(nodes: ProjectGraphNode[]): string[] {
  const apiNodes = nodes.filter((node) => node.nodeType === 'api');
  const apiSourceRefs = new Set(apiNodes.map((node) => node.sourceRef));
  const apiHandlerQualifiedNames = new Set(apiNodes.map((node) => node.metadata.handlerQualifiedName).filter((value): value is string => typeof value === 'string'));
  const apiSourceFileNodes = nodes.filter((node) => node.nodeType === 'file' && apiSourceRefs.has(node.sourceRef));
  const apiHandlerNodes = nodes.filter((node) => node.nodeType === 'function' && apiHandlerQualifiedNames.has(node.qualifiedName));
  const apiHandlerCallNodes = nodes.filter((node) => node.nodeType === 'function_call' && typeof node.metadata.ownerQualifiedName === 'string' && apiHandlerQualifiedNames.has(node.metadata.ownerQualifiedName));
  const resolvedApiHandlerCallNodes = apiHandlerCallNodes.filter((node) => typeof node.metadata.targetQualifiedName === 'string');
  const unresolvedApiHandlerCallNodes = apiHandlerCallNodes.filter((node) => typeof node.metadata.targetQualifiedName !== 'string');
  const resolvedTargetQualifiedNames = new Set(apiHandlerCallNodes.map((node) => node.metadata.targetQualifiedName).filter((value): value is string => typeof value === 'string'));
  const transitiveTargetCallNodes = collectApiSequenceTransitiveCallNodes(nodes, resolvedTargetQualifiedNames);
  const resolvedTransitiveTargetCallNodes = transitiveTargetCallNodes.filter((node) => typeof node.metadata.targetQualifiedName === 'string');
  const unresolvedTransitiveTargetCallNodes = transitiveTargetCallNodes.filter((node) => typeof node.metadata.targetQualifiedName !== 'string');
  const resolvedTargetNodes = nodes.filter((node) => node.nodeType === 'function' && resolvedTargetQualifiedNames.has(node.qualifiedName));
  const resolvedTargetSqlNodes = nodes.filter((node) => node.nodeType === 'sql_call' && typeof node.metadata.ownerQualifiedName === 'string' && resolvedTargetQualifiedNames.has(node.metadata.ownerQualifiedName));
  const resolvedTargetTableQualifiedNames = new Set(resolvedTargetSqlNodes.flatMap((node) => metadataStringArray(node.metadata.tableQualifiedNames)));
  const resolvedTargetTableNodes = nodes.filter((node) => node.nodeType === 'table' && resolvedTargetTableQualifiedNames.has(node.qualifiedName));
  const handlerLikeNodes = nodes.filter((node) => ['function', 'class'].includes(node.nodeType));
  // API 时序图有节点数量上限；先保留入口、直接调用和目标数据影响，再用剩余额度展开递归调用链。
  return uniqueNodeIds([
    ...apiNodes,
    ...apiSourceFileNodes,
    ...apiHandlerNodes,
    ...resolvedTargetNodes,
    ...resolvedApiHandlerCallNodes,
    ...resolvedTargetSqlNodes,
    ...resolvedTargetTableNodes,
      ...resolvedTransitiveTargetCallNodes,
    ...unresolvedApiHandlerCallNodes,
    ...unresolvedTransitiveTargetCallNodes,
    ...handlerLikeNodes,
  ]);
}

/** 按设计书默认深度 3 展开 API 调用链，并用已访问集合避免循环调用导致视图失控。 */
function collectApiSequenceTransitiveCallNodes(nodes: ProjectGraphNode[], resolvedTargetQualifiedNames: Set<string>): ProjectGraphNode[] {
  const maxCallDepth = 3;
  const transitiveCallNodes: ProjectGraphNode[] = [];
  const visitedCallNodeIds = new Set<string>();
  let frontier = new Set(resolvedTargetQualifiedNames);
  for (let depth = 2; depth <= maxCallDepth && frontier.size > 0; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const node of nodes) {
      if (node.nodeType !== 'function_call' || visitedCallNodeIds.has(node.id) || typeof node.metadata.ownerQualifiedName !== 'string') continue;
      if (!frontier.has(node.metadata.ownerQualifiedName)) continue;
      visitedCallNodeIds.add(node.id);
      transitiveCallNodes.push(node);
      if (typeof node.metadata.targetQualifiedName === 'string' && !resolvedTargetQualifiedNames.has(node.metadata.targetQualifiedName)) {
        resolvedTargetQualifiedNames.add(node.metadata.targetQualifiedName);
        nextFrontier.add(node.metadata.targetQualifiedName);
      }
    }
    frontier = nextFrontier;
  }
  return transitiveCallNodes;
}

function pickMethodLogicNodeIds(nodes: ProjectGraphNode[], edges: ProjectGraphEdge[]): string[] {
  const logicNodes = nodes.filter((node) => ['control_flow', 'sql_call'].includes(node.nodeType));
  const awaitedCallNodes = nodes.filter((node) => node.nodeType === 'function_call' && node.metadata.isAwaited === true);
  const promiseChainCallNodes = nodes.filter((node) => node.nodeType === 'function_call' && node.metadata.isPromiseChainRoot === true);
  const sqlCallNodes = logicNodes.filter((node) => node.nodeType === 'sql_call');
  const promiseControlNodes = logicNodes.filter((node) => ['promise_catch', 'promise_then'].includes(String(node.metadata.controlType)));
  const cleanupBranchControlNodes = logicNodes.filter((node) => node.nodeType === 'control_flow' && ['catch', 'finally', 'continue', 'break'].includes(String(node.metadata.controlType)));
  const representativeControlNodes = pickRepresentativeControlFlowNodesByOwner(logicNodes);
  const remainingLogicNodes = logicNodes.filter((node) => node.nodeType !== 'sql_call' && !['promise_catch', 'promise_then'].includes(String(node.metadata.controlType)));
  const logicSourceRefs = new Set(logicNodes.map((node) => node.sourceRef));
  for (const node of [...awaitedCallNodes, ...promiseChainCallNodes]) logicSourceRefs.add(node.sourceRef);
  const ownerQualifiedNames = new Set([...logicNodes, ...awaitedCallNodes, ...promiseChainCallNodes].map((node) => node.metadata.ownerQualifiedName).filter((value): value is string => typeof value === 'string'));
  const impactedTableQualifiedNames = new Set(logicNodes.flatMap((node) => metadataStringArray(node.metadata.tableQualifiedNames)));
  const impactedColumnQualifiedNames = new Set(logicNodes.flatMap((node) => sqlColumnQualifiedNamesForNode(node)));
  const logicSourceFileNodes = nodes.filter((node) => node.nodeType === 'file' && logicSourceRefs.has(node.sourceRef));
  const ownerFunctionNodes = nodes.filter((node) => node.nodeType === 'function' && ownerQualifiedNames.has(node.qualifiedName));
  const impactedTableNodes = nodes.filter((node) => node.nodeType === 'table' && impactedTableQualifiedNames.has(node.qualifiedName));
  const impactedColumnNodes = nodes.filter((node) => node.nodeType === 'column' && impactedColumnQualifiedNames.has(node.qualifiedName));
  const functionNodes = nodes.filter((node) => node.nodeType === 'function');
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const evidenceEdgeTypes = new Set<ProjectGraphEdge['edgeType']>([
    'loop_back',
    'loop_continue',
    'loop_break',
    'try_catch',
    'try_finally',
    'promise_catch',
    'promise_then',
    'awaits_call',
    'executes_sql',
    'reads_table',
    'writes_table',
    'uses_column',
  ]);
  const edgeBackedEvidenceNodes = edges
    .filter((edge) => evidenceEdgeTypes.has(edge.edgeType))
    .flatMap((edge) => [nodeById.get(edge.sourceNodeId), nodeById.get(edge.targetNodeId)])
    .filter((node): node is ProjectGraphNode => node !== undefined);
  const edgeBackedEvidenceNodeIds = new Set(edgeBackedEvidenceNodes.map((node) => node.id));
  // 没有语义边的孤立 SQL 仍保留少量样本，避免它们无限占用方法逻辑图额度并挤掉成对的控制流证据。
  const orphanSqlCallNodes = sqlCallNodes.filter((node) => !edgeBackedEvidenceNodeIds.has(node.id)).slice(0, 64);
  const evidenceOwnerQualifiedNames = new Set(edgeBackedEvidenceNodes.map((node) => node.metadata.ownerQualifiedName).filter((value): value is string => typeof value === 'string'));
  const evidenceOwnerFunctionNodes = nodes.filter((node) => node.nodeType === 'function' && evidenceOwnerQualifiedNames.has(node.qualifiedName));
  const controlCountsByOwner = new Map<string, number>();
  const evidenceControlNodesByOwner = new Map<string, ProjectGraphNode[]>();
  for (const node of logicNodes) {
    if (node.nodeType !== 'control_flow' || typeof node.metadata.ownerQualifiedName !== 'string') continue;
    controlCountsByOwner.set(node.metadata.ownerQualifiedName, (controlCountsByOwner.get(node.metadata.ownerQualifiedName) ?? 0) + 1);
    if (evidenceOwnerQualifiedNames.has(node.metadata.ownerQualifiedName)) {
      evidenceControlNodesByOwner.set(node.metadata.ownerQualifiedName, [...(evidenceControlNodesByOwner.get(node.metadata.ownerQualifiedName) ?? []), node]);
    }
  }
  const completeSmallOwnerControlNodes = logicNodes.filter((node) => node.nodeType === 'control_flow' && typeof node.metadata.ownerQualifiedName === 'string' && (controlCountsByOwner.get(node.metadata.ownerQualifiedName) ?? 0) <= 3);
  const leadingEvidenceControlNodes = [...evidenceControlNodesByOwner.values()].flatMap((ownerNodes) =>
    [...ownerNodes].sort((left, right) => Number(left.metadata.lineStart) - Number(right.metadata.lineStart) || left.qualifiedName.localeCompare(right.qualifiedName)).slice(0, 2),
  );
  // 关键证据节点必须优先进入方法逻辑图；否则大型项目中普通控制流节点会在视图上限前挤掉 SQL 字段或 Promise 链证据。
  // 以真实语义边为最小完整单元，并保留小函数的完整控制链；仓库增长后也不能只留下 catch/finally 而截掉对应 try。
  return uniqueNodeIds([
    ...edgeBackedEvidenceNodes,
    ...orphanSqlCallNodes,
    ...evidenceOwnerFunctionNodes,
    ...logicSourceFileNodes,
    ...completeSmallOwnerControlNodes,
    ...leadingEvidenceControlNodes,
    ...promiseControlNodes,
    ...cleanupBranchControlNodes,
    ...promiseChainCallNodes,
    ...awaitedCallNodes,
    ...impactedTableNodes,
    ...impactedColumnNodes,
    ...sqlCallNodes,
    ...representativeControlNodes,
    ...ownerFunctionNodes,
    ...remainingLogicNodes,
    ...functionNodes,
  ]);
}

function pickRepresentativeControlFlowNodesByOwner(logicNodes: ProjectGraphNode[]): ProjectGraphNode[] {
  const maxPerOwner = 3;
  const countsByOwner = new Map<string, number>();
  const representatives: ProjectGraphNode[] = [];
  for (const node of logicNodes) {
    if (node.nodeType !== 'control_flow' || typeof node.metadata.ownerQualifiedName !== 'string') continue;
    const currentCount = countsByOwner.get(node.metadata.ownerQualifiedName) ?? 0;
    if (currentCount >= maxPerOwner) continue;
    countsByOwner.set(node.metadata.ownerQualifiedName, currentCount + 1);
    representatives.push(node);
  }
  return representatives;
}

function pickSqlNodeIds(nodes: ProjectGraphNode[]): string[] {
  return nodes.filter((node) => node.nodeType === 'table' || node.nodeType === 'column' || node.metadata.language === 'sql' || node.sourceRef.endsWith('.sql')).map((node) => node.id);
}

function pickEdgesForNodes(edges: ProjectGraphEdge[], nodeIds: string[]): string[] {
  const allowedNodeIds = new Set(nodeIds);
  return edges.filter((edge) => allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId)).map((edge) => edge.id);
}

function pickModuleViewEdgeIds(edges: ProjectGraphEdge[], nodeIds: string[]): string[] {
  const allowedNodeIds = new Set(nodeIds);
  return edges
    .filter((edge) => allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId))
    .sort((left, right) => moduleViewEdgePriority(left) - moduleViewEdgePriority(right))
    .map((edge) => edge.id);
}

function moduleViewEdgePriority(edge: ProjectGraphEdge): number {
  if (edge.edgeType === 'module_depends_on') return 0;
  if (edge.edgeType === 'contains') return 1;
  return 2;
}

function pickApiSequenceEdgeIds(edges: ProjectGraphEdge[], nodeIds: string[]): string[] {
  const allowedNodeIds = new Set(nodeIds);
  return edges
    .filter((edge) => allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId))
    .sort((a, b) => apiSequenceEdgePriority(a) - apiSequenceEdgePriority(b))
    .map((edge) => edge.id);
}

function apiSequenceEdgePriority(edge: ProjectGraphEdge): number {
  if (edge.edgeType === 'handles_api') return 0;
  if (edge.edgeType === 'calls') return 1;
  if (edge.edgeType === 'resolves_to') return 2;
  if (edge.edgeType === 'executes_sql') return 3;
  if (edge.edgeType === 'reads_table' || edge.edgeType === 'writes_table') return 4;
  if (edge.edgeType === 'uses_column') return 5;
  if (edge.edgeType === 'exposes_api') return 5;
  return 6;
}

function pickMethodLogicEdgeIds(edges: ProjectGraphEdge[], nodeIds: string[]): string[] {
  const allowedNodeIds = new Set(nodeIds);
  return edges
    .filter((edge) => allowedNodeIds.has(edge.sourceNodeId) && allowedNodeIds.has(edge.targetNodeId))
    .sort((a, b) => methodLogicEdgePriority(a) - methodLogicEdgePriority(b))
    .map((edge) => edge.id);
}

function methodLogicEdgePriority(edge: ProjectGraphEdge): number {
  if (edge.edgeType === 'control_flow' && edge.confidence === 0.9) return 0;
  if (edge.edgeType === 'executes_sql') return 1;
  if (edge.edgeType === 'reads_table' || edge.edgeType === 'writes_table') return 2;
  if (edge.edgeType === 'uses_column') return 3;
  if (edge.edgeType === 'branch_true' || edge.edgeType === 'branch_false') return 3;
  if (edge.edgeType === 'loop_back') return 4;
  if (edge.edgeType === 'loop_continue' || edge.edgeType === 'loop_break') return 5;
  if (edge.edgeType === 'try_catch') return 6;
  if (edge.edgeType === 'try_finally') return 7;
  if (edge.edgeType === 'promise_catch') return 8;
  if (edge.edgeType === 'promise_then') return 9;
  if (edge.edgeType === 'awaits_call') return 10;
  if (edge.edgeType === 'next_control_flow') return 11;
  if (edge.edgeType === 'control_flow') return 5;
  return 5;
}

/** 基于真实表列名推断 *_id 到目标表的引用关系；不创建缺少来源的表或边。 */
function buildTableReferenceEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const tableNodes = nodes.filter((node) => node.nodeType === 'table');
  const tableBySingularName = new Map(tableNodes.map((node) => [singularizeTableName(node.name), node]));
  const tableBySchemaAndName = new Map(tableNodes.map((node) => [`${String(node.metadata.schemaName ?? 'default')}.${node.name}`, node]));
  const edges: ProjectGraphEdge[] = [];
  const declaredReferenceKeys = new Set<string>();
  for (const tableNode of tableNodes) {
    const foreignKeys = Array.isArray(tableNode.metadata.foreignKeys) ? tableNode.metadata.foreignKeys.filter(isForeignKeyMetadata) : [];
    for (const foreignKey of foreignKeys) {
      const referencedSchema = foreignKey.referencedSchema ?? String(tableNode.metadata.schemaName ?? 'default');
      const target = tableBySchemaAndName.get(`${referencedSchema}.${foreignKey.referencedTable}`) ?? tableBySingularName.get(singularizeTableName(foreignKey.referencedTable));
      if (!target || target.id === tableNode.id) continue;
      declaredReferenceKeys.add(`${tableNode.id}->${target.id}`);
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: 'references',
        sourceNodeId: tableNode.id,
        targetNodeId: target.id,
        sourceRef: tableNode.sourceRef,
        confidence: 1,
      });
    }
  }
  for (const tableNode of tableNodes) {
    const columns = Array.isArray(tableNode.metadata.columns) ? tableNode.metadata.columns.filter((column): column is string => typeof column === 'string') : [];
    for (const column of columns) {
      if (!column.endsWith('_id')) continue;
      const target = tableBySingularName.get(column.slice(0, -3));
      if (!target || target.id === tableNode.id) continue;
      if (declaredReferenceKeys.has(`${tableNode.id}->${target.id}`)) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: 'references',
        sourceNodeId: tableNode.id,
        targetNodeId: target.id,
        sourceRef: tableNode.sourceRef,
        confidence: 0.6,
      });
    }
  }
  return edges;
}

function isForeignKeyMetadata(value: unknown): value is { referencedSchema?: string; referencedTable: string } {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    typeof (value as { referencedTable?: unknown }).referencedTable === 'string' &&
    ((value as { referencedSchema?: unknown }).referencedSchema === undefined || typeof (value as { referencedSchema?: unknown }).referencedSchema === 'string')
  );
}

/** 将 API route 节点连到真实 handler 函数节点，支撑接口时序图从入口跳到处理逻辑。 */
function buildApiHandlerEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'api' && typeof node.metadata.handlerQualifiedName === 'string')
    .flatMap((apiNode) => {
      const handler = nodeByQualifiedName.get(String(apiNode.metadata.handlerQualifiedName));
      if (!handler) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'handles_api' as const,
          sourceNodeId: apiNode.id,
          targetNodeId: handler.id,
          sourceRef: apiNode.sourceRef,
          confidence: 0.9,
        },
      ];
    });
}

/** 将函数内调用点连回所属函数，形成可展开的真实调用链入口。 */
function buildFunctionCallEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'function_call' && typeof node.metadata.ownerQualifiedName === 'string')
    .flatMap((callNode) => {
      const owner = nodeByQualifiedName.get(String(callNode.metadata.ownerQualifiedName));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'calls' as const,
          sourceNodeId: owner.id,
          targetNodeId: callNode.id,
          sourceRef: callNode.sourceRef,
          confidence: 0.8,
        },
      ];
    });
}

/** 将调用点连到已解析出的真实函数/方法目标，形成跨文件调用链。 */
function buildResolvedCallTargetEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'function_call' && typeof node.metadata.targetQualifiedName === 'string')
    .flatMap((callNode) => {
      const target = nodeByQualifiedName.get(String(callNode.metadata.targetQualifiedName));
      if (!target) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'resolves_to' as const,
          sourceNodeId: callNode.id,
          targetNodeId: target.id,
          sourceRef: callNode.sourceRef,
          confidence: 0.7,
        },
      ];
    });
}

/** 将控制流节点连回所属函数，支撑“点击方法后查看方法内部逻辑”的图谱入口。 */
function buildFunctionControlFlowEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'control_flow' && typeof node.metadata.ownerQualifiedName === 'string')
    .flatMap((controlFlowNode) => {
      const owner = nodeByQualifiedName.get(String(controlFlowNode.metadata.ownerQualifiedName));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'control_flow' as const,
          sourceNodeId: owner.id,
          targetNodeId: controlFlowNode.id,
          sourceRef: controlFlowNode.sourceRef,
          confidence: 0.9,
        },
      ];
    });
}

/** 按源码行号连接同一函数内的控制流节点，提供可读的顺序路径。 */
function buildSequentialControlFlowEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const controlNodesByOwner = new Map<string, ProjectGraphNode[]>();
  for (const node of nodes) {
    if (node.nodeType !== 'control_flow' || typeof node.metadata.ownerQualifiedName !== 'string') continue;
    const ownerQualifiedName = node.metadata.ownerQualifiedName;
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }
  const edges: ProjectGraphEdge[] = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => Number(a.metadata.lineStart) - Number(b.metadata.lineStart) || a.qualifiedName.localeCompare(b.qualifiedName));
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const source = ordered[index];
      const target = ordered[index + 1];
      if (!source || !target) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: 'next_control_flow',
        sourceNodeId: source.id,
        targetNodeId: target.id,
        sourceRef: source.sourceRef,
        confidence: 0.75,
      });
    }
  }
  return edges;
}

/** 为 guard-style if 生成真假分支边；只用同函数源码顺序推断，置信度低于顺序边。 */
function buildControlBranchEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const controlNodesByOwner = new Map<string, ProjectGraphNode[]>();
  for (const node of nodes) {
    if (node.nodeType !== 'control_flow' || typeof node.metadata.ownerQualifiedName !== 'string') continue;
    const ownerQualifiedName = String(node.metadata.ownerQualifiedName);
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }
  const edges: ProjectGraphEdge[] = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => Number(a.metadata.lineStart) - Number(b.metadata.lineStart) || a.qualifiedName.localeCompare(b.qualifiedName));
    for (const ifNode of ordered.filter((node) => node.metadata.controlType === 'if')) {
      const ifLine = Number(ifNode.metadata.lineStart);
      const laterNodes = ordered.filter((node) => Number(node.metadata.lineStart) > ifLine);
      const trueTarget = laterNodes[0];
      if (!trueTarget) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: 'branch_true',
        sourceNodeId: ifNode.id,
        targetNodeId: trueTarget.id,
        sourceRef: ifNode.sourceRef,
        confidence: 0.72,
      });

      // 对常见 guard 写法 `if (...) { throw/return } return ...` 推断 false 分支落到后续返回。
      const trueTargetType = String(trueTarget.metadata.controlType);
      const falseTarget = ['throw', 'return'].includes(trueTargetType)
        ? laterNodes.find((node) => node.id !== trueTarget.id && ['return', 'else'].includes(String(node.metadata.controlType)))
        : laterNodes.find((node) => String(node.metadata.controlType) === 'else');
      if (!falseTarget) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: 'branch_false',
        sourceNodeId: ifNode.id,
        targetNodeId: falseTarget.id,
        sourceRef: ifNode.sourceRef,
        confidence: 0.68,
      });
    }
  }
  return edges;
}

/** 为循环控制流生成回边，表达方法逻辑图中的循环可回到循环头继续执行。 */
function buildLoopBackEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'control_flow' && node.metadata.controlType === 'loop')
    .map((loopNode) => ({
      id: `edge_${nanoid(12)}`,
      edgeType: 'loop_back' as const,
      sourceNodeId: loopNode.id,
      targetNodeId: loopNode.id,
      sourceRef: loopNode.sourceRef,
      confidence: 0.66,
    }));
}

/** 将 continue/break 连接到同函数内最近的循环头，表达循环内跳转语义。 */
function buildLoopControlTransferEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const controlNodesByOwner = new Map<string, ProjectGraphNode[]>();
  for (const node of nodes) {
    if (node.nodeType !== 'control_flow' || typeof node.metadata.ownerQualifiedName !== 'string') continue;
    const ownerQualifiedName = String(node.metadata.ownerQualifiedName);
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }

  const edges: ProjectGraphEdge[] = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => Number(a.metadata.lineStart) - Number(b.metadata.lineStart) || a.qualifiedName.localeCompare(b.qualifiedName));
    for (const node of ordered) {
      const controlType = String(node.metadata.controlType);
      if (!['continue', 'break'].includes(controlType)) continue;
      const lineStart = Number(node.metadata.lineStart);
      const nearestLoop = [...ordered].reverse().find((candidate) => candidate.metadata.controlType === 'loop' && Number(candidate.metadata.lineStart) < lineStart);
      if (!nearestLoop) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: controlType === 'continue' ? 'loop_continue' : 'loop_break',
        sourceNodeId: node.id,
        targetNodeId: nearestLoop.id,
        sourceRef: node.sourceRef,
        confidence: controlType === 'continue' ? 0.64 : 0.6,
      });
    }
  }
  return edges;
}

/** 连接同一函数内的 try/catch/finally，表达异常处理与资源释放分支。 */
function buildExceptionBranchEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const controlNodesByOwner = new Map<string, ProjectGraphNode[]>();
  for (const node of nodes) {
    if (node.nodeType !== 'control_flow' || typeof node.metadata.ownerQualifiedName !== 'string') continue;
    const ownerQualifiedName = String(node.metadata.ownerQualifiedName);
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }

  const edges: ProjectGraphEdge[] = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => Number(a.metadata.lineStart) - Number(b.metadata.lineStart) || a.qualifiedName.localeCompare(b.qualifiedName));
    for (const branchNode of ordered.filter((node) => ['catch', 'finally'].includes(String(node.metadata.controlType)))) {
      const branchLine = Number(branchNode.metadata.lineStart);
      const nearestTry = [...ordered].reverse().find((candidate) => candidate.metadata.controlType === 'try' && Number(candidate.metadata.lineStart) < branchLine);
      if (!nearestTry) continue;
      const isFinally = branchNode.metadata.controlType === 'finally';
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: isFinally ? 'try_finally' : 'try_catch',
        sourceNodeId: nearestTry.id,
        targetNodeId: branchNode.id,
        sourceRef: branchNode.sourceRef,
        confidence: isFinally ? 0.58 : 0.62,
      });
    }
  }
  return edges;
}

/** 将 await 调用点连回所属函数，表达方法逻辑图中的异步等待关系。 */
function buildAwaitedCallEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'function_call' && node.metadata.isAwaited === true && typeof node.metadata.ownerQualifiedName === 'string')
    .flatMap((callNode) => {
      const owner = nodeByQualifiedName.get(String(callNode.metadata.ownerQualifiedName));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'awaits_call' as const,
          sourceNodeId: owner.id,
          targetNodeId: callNode.id,
          sourceRef: callNode.sourceRef,
          confidence: 0.78,
        },
      ];
    });
}

/** 将 Promise 链根调用连接到同一行的 then/catch 控制流，表达异步续接与异常分支。 */
function buildPromiseChainEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const promiseControlNodes = nodes.filter((node) => node.nodeType === 'control_flow' && ['promise_catch', 'promise_then'].includes(String(node.metadata.controlType)));
  return nodes
    .filter((node) => node.nodeType === 'function_call' && ['catch', 'then'].includes(String(node.metadata.promiseChainHandler)))
    .flatMap((callNode) => {
      const handler = String(callNode.metadata.promiseChainHandler);
      const controlNode = promiseControlNodes.find((node) => node.sourceRef === callNode.sourceRef && Number(node.metadata.lineStart) === Number(callNode.metadata.lineStart) && node.metadata.promiseChainHandler === handler);
      if (!controlNode) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: handler === 'then' ? ('promise_then' as const) : ('promise_catch' as const),
          sourceNodeId: callNode.id,
          targetNodeId: controlNode.id,
          sourceRef: callNode.sourceRef,
          confidence: handler === 'then' ? 0.6 : 0.61,
        },
      ];
    });
}

/** 将 SQL 调用节点连回所属函数，支撑方法逻辑图展示真实数据访问点。 */
function buildFunctionSqlCallEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'sql_call' && typeof node.metadata.ownerQualifiedName === 'string')
    .flatMap((sqlCallNode) => {
      const owner = nodeByQualifiedName.get(String(sqlCallNode.metadata.ownerQualifiedName));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'executes_sql' as const,
          sourceNodeId: owner.id,
          targetNodeId: sqlCallNode.id,
          sourceRef: sqlCallNode.sourceRef,
          confidence: 0.9,
        },
      ];
    });
}

/** 将 SQL 调用连接到真实表节点，表达方法对表的读写影响。 */
function buildSqlTableImpactEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'sql_call')
    .flatMap((sqlCallNode) =>
      metadataStringArray(sqlCallNode.metadata.tableQualifiedNames).flatMap((tableQualifiedName) => {
        const tableNode = nodeByQualifiedName.get(tableQualifiedName);
        if (!tableNode) return [];
        return [
          {
            id: `edge_${nanoid(12)}`,
            edgeType: sqlCallNode.metadata.accessMode === 'write' ? ('writes_table' as const) : ('reads_table' as const),
            sourceNodeId: sqlCallNode.id,
            targetNodeId: tableNode.id,
            sourceRef: sqlCallNode.sourceRef,
            confidence: 0.85,
          },
        ];
      }),
    );
}

/** 将表节点连接到字段节点，让表关系图可以展示真实字段详情。 */
function buildTableColumnEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'column' && typeof node.metadata.tableQualifiedName === 'string')
    .flatMap((columnNode) => {
      const tableNode = nodeByQualifiedName.get(String(columnNode.metadata.tableQualifiedName));
      if (!tableNode) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'contains' as const,
          sourceNodeId: tableNode.id,
          targetNodeId: columnNode.id,
          sourceRef: columnNode.sourceRef,
          confidence: 0.95,
        },
      ];
    });
}

/** 将 SQL 调用连接到真实字段节点，表达字段级影响分析。 */
function buildSqlColumnImpactEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  return nodes
    .filter((node) => node.nodeType === 'sql_call')
    .flatMap((sqlCallNode) =>
      sqlColumnQualifiedNamesForNode(sqlCallNode).flatMap((columnQualifiedName) => {
        const columnNode = nodeByQualifiedName.get(columnQualifiedName);
        if (!columnNode) return [];
        return [
          {
            id: `edge_${nanoid(12)}`,
            edgeType: 'uses_column' as const,
            sourceNodeId: sqlCallNode.id,
            targetNodeId: columnNode.id,
            sourceRef: sqlCallNode.sourceRef,
            confidence: 0.72,
          },
        ];
      }),
    );
}

function sqlColumnQualifiedNamesForNode(node: ProjectGraphNode): string[] {
  const fieldNames = new Set([
    ...metadataStringArray(node.metadata.selectedFields),
    ...metadataStringArray(node.metadata.whereFields),
    ...metadataStringArray(node.metadata.orderByFields),
    ...metadataStringArray(node.metadata.groupByFields),
    ...metadataStringArray(node.metadata.joinFields),
  ]);
  return metadataStringArray(node.metadata.tableQualifiedNames).flatMap((tableQualifiedName) => Array.from(fieldNames).map((fieldName) => `${tableQualifiedName}#column:${fieldName}`));
}

/** 将 SQL JOIN 条件提升为表关系边；这是来源可追踪的推断关系，不等同于数据库外键。 */
function buildSqlJoinRelationEdges(nodes: ProjectGraphNode[]): ProjectGraphEdge[] {
  const tableNodes = nodes.filter((node) => node.nodeType === 'table');
  const tableBySourceAndName = new Map(tableNodes.map((node) => [`${node.sourceRef}#${node.name}`, node]));
  const edges: ProjectGraphEdge[] = [];
  for (const sqlNode of nodes.filter((node) => node.nodeType === 'sql_call')) {
    for (const relation of metadataJoinRelations(sqlNode.metadata.joinRelations)) {
      const leftTable = tableBySourceAndName.get(`${sqlNode.sourceRef}#${relation.leftTable}`);
      const rightTable = tableBySourceAndName.get(`${sqlNode.sourceRef}#${relation.rightTable}`);
      if (!leftTable || !rightTable || leftTable.id === rightTable.id) continue;
      const direction = sqlJoinReferenceDirection(leftTable, relation.leftColumn, rightTable, relation.rightColumn);
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: 'references',
        sourceNodeId: direction.source.id,
        targetNodeId: direction.target.id,
        sourceRef: sqlNode.sourceRef,
        confidence: 0.6,
        metadata: {
          relationSource: 'sql_join',
          sqlQualifiedName: sqlNode.qualifiedName,
          leftTable: relation.leftTable,
          leftColumn: relation.leftColumn,
          rightTable: relation.rightTable,
          rightColumn: relation.rightColumn,
        },
      });
    }
  }
  return edges;
}

function sqlJoinReferenceDirection(leftTable: ProjectGraphNode, leftColumn: string, rightTable: ProjectGraphNode, rightColumn: string): { source: ProjectGraphNode; target: ProjectGraphNode } {
  const leftLooksReference = leftColumn === `${singularizeTableName(rightTable.name)}_id`;
  const rightLooksReference = rightColumn === `${singularizeTableName(leftTable.name)}_id`;
  if (rightLooksReference && !leftLooksReference) return { source: rightTable, target: leftTable };
  return { source: leftTable, target: rightTable };
}

function metadataJoinRelations(value: unknown): Array<{
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (
      item,
    ): item is {
      leftTable: string;
      leftColumn: string;
      rightTable: string;
      rightColumn: string;
    } =>
      Boolean(item) &&
      typeof item === 'object' &&
      typeof (item as { leftTable?: unknown }).leftTable === 'string' &&
      typeof (item as { leftColumn?: unknown }).leftColumn === 'string' &&
      typeof (item as { rightTable?: unknown }).rightTable === 'string' &&
      typeof (item as { rightColumn?: unknown }).rightColumn === 'string',
  );
}

/** 将 import 事实提升为文件到文件的模块依赖边，避免模块图只停留在声明层。 */
function buildImportDependencyEdges(nodes: ProjectGraphNode[], nodeByQualifiedName: Map<string, ProjectGraphNode>): ProjectGraphEdge[] {
  const fileNodeBySourceRef = new Map(nodes.filter((node) => node.nodeType === 'file').map((node) => [node.sourceRef, node]));
  return nodes
    .filter((node) => node.nodeType === 'import' && typeof node.metadata.resolvedRelativePath === 'string')
    .flatMap((importNode) => {
      const sourceFile = fileNodeBySourceRef.get(importNode.sourceRef);
      const targetFile = nodeByQualifiedName.get(String(importNode.metadata.resolvedRelativePath));
      if (!sourceFile || !targetFile || sourceFile.id === targetFile.id) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: 'module_depends_on' as const,
          sourceNodeId: sourceFile.id,
          targetNodeId: targetFile.id,
          sourceRef: importNode.sourceRef,
          confidence: 0.9,
        },
      ];
    });
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function uniqueNodeIds(nodes: ProjectGraphNode[]): string[] {
  return Array.from(new Set(nodes.map((node) => node.id)));
}

function singularizeTableName(tableName: string): string {
  return tableName.endsWith('ies') ? `${tableName.slice(0, -3)}y` : tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
}
