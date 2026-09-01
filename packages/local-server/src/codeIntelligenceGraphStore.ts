import {existsSync, statSync} from 'node:fs';
import {join, relative, resolve} from 'node:path';
import {GRAPH_VIEW_SCHEMA_VERSION, type ProjectGraph} from '@zeus/graph-engine';
import type {ProjectConfigSnapshot} from './projectCore.js';
import type {SqlValue} from '@zeus/storage';

interface CodeMapSettings {
  defaultScanScope: 'project' | 'src' | 'custom';
  tableRelationInference: 'foreign_key_and_name' | 'foreign_key_only' | 'name_only' | 'disabled';
}

export interface GraphViewSnapshot {
  id: string;
  schemaVersion: number;
  projectId?: string;
  projectName?: string;
  title: string;
  viewType: string;
  layout?: {
    algorithm: string;
    width: number;
    height: number;
    positions: Array<{ nodeId: string; x: number; y: number }>;
  };
  nodes: Array<{
    id: string;
    nodeType: string;
    name: string;
    qualifiedName: string;
    sourceRef: string;
    symbolId: string;
    metadata: Record<string, unknown>;
  }>;
  edges: Array<{
    id: string;
    edgeType: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceRef: string;
    confidence: number;
    metadata: Record<string, unknown>;
  }>;
  performance?: { durationMs: number; nodeCount: number; edgeCount: number };
}

export interface GraphSearchResult {
  query: string;
  nodeType: string | null;
  edgeType: string | null;
  minConfidence: number;
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
}

export type GraphEdgeDetail = GraphViewSnapshot['edges'][number] & {
  sourceNode: GraphViewSnapshot['nodes'][number];
  targetNode: GraphViewSnapshot['nodes'][number];
};

export interface GraphNeighborhood {
  centerNode: GraphViewSnapshot['nodes'][number];
  depth: number;
  nodes: GraphViewSnapshot['nodes'];
  edges: GraphViewSnapshot['edges'];
}
export function readGraphEdgeDetail(
  db: {
    get: <T>(sql: string, params?: SqlValue[]) => T | undefined;
  },
  edgeId: string,
): GraphEdgeDetail | undefined {
  const edge = db.get<{
    id: string;
    edge_type: string;
    source_node_id: string;
    target_node_id: string;
    source_ref: string;
    confidence: number;
    metadata_json: string;
  }>(
    `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges WHERE id = ? LIMIT 1`,
    [edgeId],
  );
  if (!edge) return undefined;
  const sourceNode = readGraphNodeById(db, edge.source_node_id);
  const targetNode = readGraphNodeById(db, edge.target_node_id);
  if (!sourceNode || !targetNode) return undefined;
  return {
    id: edge.id,
    edgeType: edge.edge_type,
    sourceNodeId: edge.source_node_id,
    targetNodeId: edge.target_node_id,
    sourceRef: edge.source_ref,
    confidence: edge.confidence,
    metadata: parseJsonObject(edge.metadata_json),
    sourceNode,
    targetNode,
  };
}

export function readGraphNeighborhood(
  db: {
    get: <T>(sql: string, params?: SqlValue[]) => T | undefined;
    select: <T>(sql: string, params?: SqlValue[]) => T[];
  },
  nodeId: string,
  depth: number,
  projectName?: string,
): GraphNeighborhood | undefined {
  const centerNode = readGraphNodeById(db, nodeId, projectName);
  if (!centerNode) return undefined;
  type GraphNeighborhoodEdgeRow = {
    id: string;
    edge_type: string;
    source_node_id: string;
    target_node_id: string;
    source_ref: string;
    confidence: number;
    metadata_json: string;
  };
  const normalizedDepth = depth === 2 ? 2 : 1;
  const maxNodes = normalizedDepth === 1 ? 40 : 80;
  const nodeIds = new Set<string>([nodeId]);
  const edgeRowsById = new Map<string, GraphNeighborhoodEdgeRow>();
  let frontier = [nodeId];

  for (let hop = 0; hop < normalizedDepth && frontier.length > 0; hop += 1) {
    const placeholders = frontier.map(() => '?').join(', ');
    const rows = db.select<GraphNeighborhoodEdgeRow>(
      `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
       FROM project_edges
       WHERE (? IS NULL OR project_name = ?)
         AND (source_node_id IN (${placeholders}) OR target_node_id IN (${placeholders}))
       ORDER BY rowid ASC
       LIMIT 240`,
      [projectName ?? null, projectName ?? null, ...frontier, ...frontier],
    );
    const nextFrontier: string[] = [];
    for (const edge of rows) {
      edgeRowsById.set(edge.id, edge);
      for (const candidateId of [edge.source_node_id, edge.target_node_id]) {
        if (nodeIds.has(candidateId) || nodeIds.size >= maxNodes) continue;
        nodeIds.add(candidateId);
        nextFrontier.push(candidateId);
      }
    }
    frontier = nextFrontier;
  }

  const edges = Array.from(edgeRowsById.values())
    .filter((edge) => nodeIds.has(edge.source_node_id) && nodeIds.has(edge.target_node_id))
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edge_type,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      sourceRef: edge.source_ref,
      confidence: edge.confidence,
      metadata: parseJsonObject(edge.metadata_json),
    }));
  const nodes = Array.from(nodeIds)
    .map((id) => readGraphNodeById(db, id, projectName))
    .filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return { centerNode, depth: normalizedDepth, nodes, edges };
}

export function normalizeGraphSearchFilters(
  rawQuery: string,
  nodeType?: string,
  edgeType?: string,
  rawMinConfidence?: string,
): {
  query: string;
  nodeType: string | null;
  edgeType: string | null;
  minConfidence: number;
} {
  return {
    query: rawQuery.trim(),
    nodeType: nodeType?.trim() || null,
    edgeType: edgeType?.trim() || null,
    minConfidence: Number.isFinite(Number(rawMinConfidence)) ? Number(rawMinConfidence) : 0,
  };
}

export function emptyGraphSearchResult(rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string): GraphSearchResult {
  const filters = normalizeGraphSearchFilters(rawQuery, nodeType, edgeType, rawMinConfidence);
  return {
    query: filters.query,
    nodeType: filters.nodeType,
    edgeType: filters.edgeType,
    minConfidence: filters.minConfidence,
    nodes: [],
    edges: [],
  };
}

export function searchGraphNodesInMemory(graph: ProjectGraph, rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string): GraphSearchResult {
  const filters = normalizeGraphSearchFilters(rawQuery, nodeType, edgeType, rawMinConfidence);
  const normalizedQuery = filters.query.toLowerCase();
  const includesQuery = (value: string): boolean => normalizedQuery.length === 0 || value.toLowerCase().includes(normalizedQuery);
  const nodes = graph.nodes
    .filter((node) => includesQuery(node.name) || includesQuery(node.qualifiedName) || includesQuery(node.sourceRef))
    .filter((node) => !filters.nodeType || node.nodeType === filters.nodeType)
    .sort((left, right) => {
      const leftSourceHit = includesQuery(left.sourceRef) ? 0 : 1;
      const rightSourceHit = includesQuery(right.sourceRef) ? 0 : 1;
      if (leftSourceHit !== rightSourceHit) return leftSourceHit - rightSourceHit;
      const leftQualifiedHit = includesQuery(left.qualifiedName) ? 0 : 1;
      const rightQualifiedHit = includesQuery(right.qualifiedName) ? 0 : 1;
      if (leftQualifiedHit !== rightQualifiedHit) return leftQualifiedHit - rightQualifiedHit;
      return left.sourceRef.localeCompare(right.sourceRef) || left.name.localeCompare(right.name);
    })
    .slice(0, 50)
    .map((node) => ({
      id: node.id,
      nodeType: node.nodeType,
      name: node.name,
      qualifiedName: node.qualifiedName,
      sourceRef: node.sourceRef,
      symbolId: node.symbolId,
      metadata: node.metadata,
    }));
  const edges = graph.edges
    .filter((edge) => !filters.edgeType || edge.edgeType === filters.edgeType)
    .filter((edge) => edge.confidence >= filters.minConfidence)
    .filter((edge) => filters.query.length === 0 || edge.sourceRef.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => right.confidence - left.confidence || left.sourceRef.localeCompare(right.sourceRef))
    .slice(0, 50)
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edgeType,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      sourceRef: edge.sourceRef,
      confidence: edge.confidence,
      metadata: edge.metadata ?? {},
    }));
  return {
    query: filters.query,
    nodeType: filters.nodeType,
    edgeType: filters.edgeType,
    minConfidence: filters.minConfidence,
    nodes,
    edges,
  };
}

export function searchGraphNodes(db: { select: <T>(sql: string, params?: SqlValue[]) => T[] }, rawQuery: string, nodeType?: string, edgeType?: string, rawMinConfidence?: string, projectName?: string): GraphSearchResult {
  const { query, nodeType: normalizedType, edgeType: normalizedEdgeType, minConfidence } = normalizeGraphSearchFilters(rawQuery, nodeType, edgeType, rawMinConfidence);
  const rows = db.select<{
    id: string;
    node_type: string;
    name: string;
    qualified_name: string;
    source_ref: string;
    symbol_id: string;
    metadata_json: string;
  }>(
    `SELECT id, node_type, name, qualified_name, source_ref, symbol_id, metadata_json
     FROM project_nodes
     WHERE (? IS NULL OR project_name = ?)
       AND (? = '' OR lower(name) LIKE lower(?) OR lower(qualified_name) LIKE lower(?) OR lower(source_ref) LIKE lower(?))
       AND (? IS NULL OR node_type = ?)
     ORDER BY
       CASE
         WHEN lower(source_ref) LIKE lower(?) THEN 0
         WHEN lower(qualified_name) LIKE lower(?) THEN 1
         ELSE 2
       END ASC,
       source_ref ASC,
       name ASC
     LIMIT 50`,
    [projectName ?? null, projectName ?? null, query, `%${query}%`, `%${query}%`, `%${query}%`, normalizedType, normalizedType, `%${query}%`, `%${query}%`],
  );
  const edges = db
    .select<{
      id: string;
      edge_type: string;
      source_node_id: string;
      target_node_id: string;
      source_ref: string;
      confidence: number;
      metadata_json: string;
    }>(
      `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges
     WHERE (? IS NULL OR project_name = ?)
       AND (? IS NULL OR edge_type = ?)
       AND confidence >= ?
       AND (? = '' OR lower(source_ref) LIKE lower(?))
     ORDER BY confidence DESC, source_ref ASC
     LIMIT 50`,
      [projectName ?? null, projectName ?? null, normalizedEdgeType, normalizedEdgeType, minConfidence, query, `%${query}%`],
    )
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edge_type,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      sourceRef: edge.source_ref,
      confidence: edge.confidence,
      metadata: parseJsonObject(edge.metadata_json),
    }));
  return {
    query,
    nodeType: normalizedType,
    edgeType: normalizedEdgeType,
    minConfidence,
    nodes: rows.map((node) => ({
      id: node.id,
      nodeType: node.node_type,
      name: node.name,
      qualifiedName: node.qualified_name,
      sourceRef: node.source_ref,
      symbolId: node.symbol_id,
      metadata: parseJsonObject(node.metadata_json),
    })),
    edges,
  };
}

export function readGraphNodeById(
  db: {
    get: <T>(sql: string, params?: SqlValue[]) => T | undefined;
  },
  nodeId: string,
  projectName?: string,
): GraphViewSnapshot['nodes'][number] | undefined {
  const node = db.get<{
    id: string;
    node_type: string;
    name: string;
    qualified_name: string;
    source_ref: string;
    symbol_id: string;
    metadata_json: string;
  }>(
    `SELECT id, node_type, name, qualified_name, source_ref, symbol_id, metadata_json
     FROM project_nodes WHERE id = ? AND (? IS NULL OR project_name = ?) LIMIT 1`,
    [nodeId, projectName ?? null, projectName ?? null],
  );
  if (!node) return undefined;
  return {
    id: node.id,
    nodeType: node.node_type,
    name: node.name,
    qualifiedName: node.qualified_name,
    sourceRef: node.source_ref,
    symbolId: node.symbol_id,
    metadata: parseJsonObject(node.metadata_json),
  };
}

export function readGraphNodeIdsBySourceRef(db: { select: <T>(sql: string, params?: SqlValue[]) => T[] }, sourceRef: string): string[] {
  return db
    .select<{ id: string }>(
      `SELECT id
     FROM project_nodes
     WHERE source_ref = ?
     ORDER BY node_type ASC, qualified_name ASC, id ASC`,
      [sourceRef],
    )
    .map((node) => node.id);
}

export function readGraphEdgesByNodeId(db: { select: <T>(sql: string, params?: SqlValue[]) => T[] }, nodeId: string, projectName?: string): GraphViewSnapshot['edges'] {
  return db
    .select<{
      id: string;
      edge_type: string;
      source_node_id: string;
      target_node_id: string;
      source_ref: string;
      confidence: number;
      metadata_json: string;
    }>(
      `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges WHERE (? IS NULL OR project_name = ?) AND (source_node_id = ? OR target_node_id = ?) ORDER BY rowid ASC LIMIT 20`,
      [projectName ?? null, projectName ?? null, nodeId, nodeId],
    )
    .map((edge) => ({
      id: edge.id,
      edgeType: edge.edge_type,
      sourceNodeId: edge.source_node_id,
      targetNodeId: edge.target_node_id,
      sourceRef: edge.source_ref,
      confidence: edge.confidence,
      metadata: parseJsonObject(edge.metadata_json),
    }));
}

// 项目级图谱读取必须带 projectName 过滤，否则同 view_type 的第一条缓存会把 Zeus 图谱串到其他项目。
export function readGraphView(
  db: {
    get: <T>(sql: string, params?: SqlValue[]) => T | undefined;
    select: <T>(sql: string, params?: SqlValue[]) => T[];
  },
  viewType: string,
  projectName?: string,
): GraphViewSnapshot | undefined {
  try {
    const view = db.get<{
      id: string;
      project_name: string;
      view_type: string;
      title: string;
      payload_json: string;
    }>(`SELECT id, project_name, view_type, title, payload_json FROM graph_views WHERE view_type = ? AND (? IS NULL OR project_name = ?) ORDER BY id ASC LIMIT 1`, [viewType, projectName ?? null, projectName ?? null]);
    if (!view) return undefined;
    const payload = parseGraphViewPayload(view.payload_json);
    if (payload.schemaVersion !== GRAPH_VIEW_SCHEMA_VERSION) return undefined;
    const nodes = db
      .select<{
        id: string;
        node_type: string;
        name: string;
        qualified_name: string;
        source_ref: string;
        symbol_id: string;
        metadata_json: string;
      }>(
        `SELECT id, node_type, name, qualified_name, source_ref, symbol_id, metadata_json
     FROM project_nodes WHERE project_name = ? ORDER BY rowid ASC`,
        [view.project_name],
      )
      .filter((node) => !payload.hasNodeFilter || payload.nodeIds.has(node.id))
      .map((node) => ({
        id: node.id,
        nodeType: node.node_type,
        name: node.name,
        qualifiedName: node.qualified_name,
        sourceRef: node.source_ref,
        symbolId: node.symbol_id,
        metadata: parseJsonObject(node.metadata_json),
      }));
    const edges = db
      .select<{
        id: string;
        edge_type: string;
        source_node_id: string;
        target_node_id: string;
        source_ref: string;
        confidence: number;
        metadata_json: string;
      }>(
        `SELECT id, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json
     FROM project_edges WHERE project_name = ? ORDER BY rowid ASC`,
        [view.project_name],
      )
      .filter((edge) => !payload.hasEdgeFilter || payload.edgeIds.has(edge.id))
      .map((edge) => ({
        id: edge.id,
        edgeType: edge.edge_type,
        sourceNodeId: edge.source_node_id,
        targetNodeId: edge.target_node_id,
        sourceRef: edge.source_ref,
        confidence: edge.confidence,
        metadata: parseJsonObject(edge.metadata_json),
      }));
    return {
      id: view.id,
      schemaVersion: payload.schemaVersion,
      projectName: view.project_name,
      title: view.title,
      viewType: view.view_type,
      layout: payload.layout,
      nodes,
      edges,
    };
  } catch {
    // 项目首次创建且尚未扫描时，图谱缓存表可能还不存在；此时返回空态让 API 给出可恢复 404，而不是把界面打成 500。
    return undefined;
  }
}

export function graphNodeToSnapshot(node: ProjectGraph['nodes'][number]): GraphViewSnapshot['nodes'][number] {
  return {
    id: node.id,
    nodeType: node.nodeType,
    name: node.name,
    qualifiedName: node.qualifiedName,
    sourceRef: node.sourceRef,
    symbolId: node.symbolId,
    metadata: node.metadata,
  };
}

export function graphEdgeToSnapshot(edge: ProjectGraph['edges'][number]): GraphViewSnapshot['edges'][number] {
  return {
    id: edge.id,
    edgeType: edge.edgeType,
    sourceNodeId: edge.sourceNodeId,
    targetNodeId: edge.targetNodeId,
    sourceRef: edge.sourceRef,
    confidence: edge.confidence,
    metadata: edge.metadata ?? {},
  };
}

export function graphNodeSnapshotFromGraph(graph: ProjectGraph, nodeId: string): GraphViewSnapshot['nodes'][number] | undefined {
  const node = graph.nodes.find((item) => item.id === nodeId);
  return node ? graphNodeToSnapshot(node) : undefined;
}

export function graphEdgesByNodeIdFromGraph(graph: ProjectGraph, nodeId: string, limit: number): GraphViewSnapshot['edges'] {
  return graph.edges
    .filter((edge) => edge.sourceNodeId === nodeId || edge.targetNodeId === nodeId)
    .slice(0, limit)
    .map(graphEdgeToSnapshot);
}

export function graphEdgeDetailFromGraph(graph: ProjectGraph, edgeId: string): GraphEdgeDetail | undefined {
  const edge = graph.edges.find((item) => item.id === edgeId);
  if (!edge) return undefined;
  const sourceNode = graphNodeSnapshotFromGraph(graph, edge.sourceNodeId);
  const targetNode = graphNodeSnapshotFromGraph(graph, edge.targetNodeId);
  if (!sourceNode || !targetNode) return undefined;
  return { ...graphEdgeToSnapshot(edge), sourceNode, targetNode };
}

export function graphNeighborhoodFromGraph(graph: ProjectGraph, nodeId: string, depth: number): GraphNeighborhood | undefined {
  const centerNode = graphNodeSnapshotFromGraph(graph, nodeId);
  if (!centerNode) return undefined;
  const normalizedDepth = depth === 2 ? 2 : 1;
  const maxNodes = normalizedDepth === 1 ? 40 : 80;
  const nodeIds = new Set<string>([nodeId]);
  const edgesById = new Map<string, GraphViewSnapshot['edges'][number]>();
  let frontier = [nodeId];

  for (let hop = 0; hop < normalizedDepth && frontier.length > 0; hop += 1) {
    const frontierIds = new Set(frontier);
    const nextFrontier: string[] = [];
    for (const edge of graph.edges) {
      if (!frontierIds.has(edge.sourceNodeId) && !frontierIds.has(edge.targetNodeId)) continue;
      const snapshotEdge = graphEdgeToSnapshot(edge);
      edgesById.set(snapshotEdge.id, snapshotEdge);
      for (const candidateId of [edge.sourceNodeId, edge.targetNodeId]) {
        if (nodeIds.has(candidateId) || nodeIds.size >= maxNodes) continue;
        nodeIds.add(candidateId);
        nextFrontier.push(candidateId);
      }
    }
    frontier = nextFrontier;
  }

  const edges = Array.from(edgesById.values()).filter((edge) => nodeIds.has(edge.sourceNodeId) && nodeIds.has(edge.targetNodeId));
  const nodes = Array.from(nodeIds)
    .map((id) => graphNodeSnapshotFromGraph(graph, id))
    .filter((node): node is GraphViewSnapshot['nodes'][number] => Boolean(node));
  return { centerNode, depth: normalizedDepth, nodes, edges };
}

export function graphViewSnapshotFromGraph(graph: ProjectGraph, viewType: string): GraphViewSnapshot | undefined {
  const view = graph.views.find((item) => item.viewType === viewType);
  if (!view) return undefined;
  const nodeIds = new Set(view.nodeIds);
  const edgeIds = new Set(view.edgeIds);
  return {
    id: view.id,
    schemaVersion: view.schemaVersion,
    projectName: graph.projectName,
    title: view.title,
    viewType: view.viewType,
    layout: view.layout,
    nodes: graph.nodes
      .filter((node) => nodeIds.has(node.id))
      .map((node) => ({
        id: node.id,
        nodeType: node.nodeType,
        name: node.name,
        qualifiedName: node.qualifiedName,
        sourceRef: node.sourceRef,
        symbolId: node.symbolId,
        metadata: node.metadata,
      })),
    edges: graph.edges
      .filter((edge) => edgeIds.has(edge.id))
      .map((edge) => ({
        id: edge.id,
        edgeType: edge.edgeType,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        sourceRef: edge.sourceRef,
        confidence: edge.confidence,
        metadata: edge.metadata ?? {},
      })),
  };
}

export function parseGraphViewPayload(payloadJson: string): {
  schemaVersion: number | undefined;
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  hasNodeFilter: boolean;
  hasEdgeFilter: boolean;
  layout?: GraphViewSnapshot['layout'];
} {
  try {
    const payload = JSON.parse(payloadJson) as {
      schemaVersion?: number;
      nodeIds?: string[];
      edgeIds?: string[];
      layout?: unknown;
    };
    return {
      schemaVersion: payload.schemaVersion,
      nodeIds: new Set(payload.nodeIds ?? []),
      edgeIds: new Set(payload.edgeIds ?? []),
      hasNodeFilter: Array.isArray(payload.nodeIds),
      hasEdgeFilter: Array.isArray(payload.edgeIds),
      layout: parseGraphViewLayout(payload.layout),
    };
  } catch {
    return {
      schemaVersion: undefined,
      nodeIds: new Set(),
      edgeIds: new Set(),
      hasNodeFilter: false,
      hasEdgeFilter: false,
    };
  }
}

export function parseGraphViewLayout(value: unknown): GraphViewSnapshot['layout'] | undefined {
  const layout = value as Partial<NonNullable<GraphViewSnapshot['layout']>>;
  if (!layout || typeof layout !== 'object' || typeof layout.algorithm !== 'string' || typeof layout.width !== 'number' || typeof layout.height !== 'number' || !Array.isArray(layout.positions)) return undefined;
  const positions = layout.positions.filter((position): position is { nodeId: string; x: number; y: number } => {
    const item = position as Partial<{
      nodeId: string;
      x: number;
      y: number;
    }>;
    return typeof item.nodeId === 'string' && typeof item.x === 'number' && typeof item.y === 'number';
  });
  return {
    algorithm: layout.algorithm,
    width: layout.width,
    height: layout.height,
    positions,
  };
}

export function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
export function readGraphSummary(db: { countRows: (tableName: string) => number }): {
  nodeCount: number;
  edgeCount: number;
  viewCount: number;
} {
  return {
    nodeCount: safeCount(db, 'project_nodes'),
    edgeCount: safeCount(db, 'project_edges'),
    viewCount: safeCount(db, 'graph_views'),
  };
}

export function readGraphSummaryByProject(
  db: {
    get: <T>(sql: string, params?: SqlValue[]) => T | undefined;
  },
  projectName: string,
): { nodeCount: number; edgeCount: number; viewCount: number } {
  try {
    const counts = db.get<{
      node_count: number;
      edge_count: number;
      view_count: number;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM project_nodes WHERE project_name = ?) AS node_count,
         (SELECT COUNT(*) FROM project_edges WHERE project_name = ?) AS edge_count,
         (SELECT COUNT(*) FROM graph_views WHERE project_name = ?) AS view_count`,
      [projectName, projectName, projectName],
    );
    return {
      nodeCount: counts?.node_count ?? 0,
      edgeCount: counts?.edge_count ?? 0,
      viewCount: counts?.view_count ?? 0,
    };
  } catch {
    // 扫描失败前可能尚未创建图谱缓存表；状态接口仍应返回项目状态，而不是二次失败。
    return { nodeCount: 0, edgeCount: 0, viewCount: 0 };
  }
}

export function safeCount(db: { countRows: (tableName: string) => number }, tableName: string): number {
  try {
    return db.countRows(tableName);
  } catch {
    return 0;
  }
}

export function resolveCodeMapScanRoot(projectRoot: string, settings: CodeMapSettings): string {
  if (settings.defaultScanScope !== 'src') return projectRoot;
  const srcRoot = join(projectRoot, 'src');
  // src 范围只在真实 src 目录存在时生效；不存在时回退项目根，避免扫描失败或制造虚假目录。
  return existsSync(srcRoot) ? srcRoot : projectRoot;
}

export function hasDatabaseUriPassword(value: string | null | undefined): boolean {
  const text = value?.trim();
  if (!text || !/^(?:postgresql?|mysql|mariadb):/iu.test(text)) return false;
  try {
    return Boolean(new URL(text).password);
  } catch {
    // URI 格式不完整时也按 user:password@ 形态拦截，避免敏感信息落入本地设置表。
    return /:\/\/[^:@\s]+:[^@\s]+@/u.test(text);
  }
}

export function resolveImportedSchemaFiles(projectRoot: string, config?: ProjectConfigSnapshot): Array<{ absolutePath: string; relativePath: string }> {
  if (!config?.database.schemaPaths.length) return [];
  const projectRootPath = resolve(projectRoot);
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const seen = new Set<string>();
  for (const schemaPath of config.database.schemaPaths) {
    const absolutePath = resolve(projectRootPath, schemaPath);
    const relativePath = relative(projectRootPath, absolutePath);
    if (!relativePath || relativePath.startsWith('..') || relativePath === '..' || relativePath.startsWith('/')) continue;
    if (seen.has(absolutePath)) continue;
    if (!existsSync(absolutePath)) continue;
    const info = statSync(absolutePath);
    if (!info.isFile()) continue;
    // DDL 导入只接受真实文件；缺失、目录或不在项目内的路径不会生成任何 schema 节点。
    files.push({ absolutePath, relativePath });
    seen.add(absolutePath);
  }
  return files;
}

export function resolveConfiguredSqliteDatabase(projectRoot: string, config?: ProjectConfigSnapshot): { absolutePath: string; relativePath: string } | null {
  const connectionName = config?.database.connectionName?.trim();
  const explicitExternalConnection = connectionName?.match(/^(postgresql?|mysql|mariadb):/iu);
  if (explicitExternalConnection?.[1]) {
    const dialect = explicitExternalConnection[1].toLowerCase() === 'postgresql' ? 'postgres' : explicitExternalConnection[1].toLowerCase();
    const displayName = dialect === 'postgres' ? 'Postgres' : dialect === 'mariadb' ? 'MariaDB' : 'MySQL';
    // 外部数据库驱动尚未纳入依赖清单；明确失败比静默跳过 schema 更符合“不伪造真实来源”的设计书约束。
    throw new Error(`${displayName} database introspection driver is not installed; connection scheme ${explicitExternalConnection[1].toLowerCase()} is waiting for approved dependency setup`);
  }
  const match = connectionName?.match(/^sqlite:(.+)$/iu);
  if (!match?.[1]) return null;
  const rawRelativePath = match[1].trim().replace(/\\/gu, '/');
  if (!rawRelativePath || rawRelativePath.startsWith('/') || rawRelativePath.includes('\0')) {
    throw new Error('SQLite database connection must use a project-relative path');
  }
  const projectRootPath = resolve(projectRoot);
  const absolutePath = resolve(projectRootPath, rawRelativePath);
  const relativePath = relative(projectRootPath, absolutePath).replace(/\\/gu, '/');
  if (!relativePath || relativePath.startsWith('..') || relativePath === '..' || relativePath.startsWith('/')) {
    throw new Error(`SQLite database path is outside the project: ${rawRelativePath}`);
  }
  if (!/\.(?:sqlite|sqlite3|db)$/iu.test(relativePath)) {
    throw new Error(`SQLite database file must end with .sqlite, .sqlite3, or .db: ${relativePath}`);
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`SQLite database file is not accessible: ${relativePath}`);
  }
  const info = statSync(absolutePath);
  if (!info.isFile()) {
    throw new Error(`SQLite database path is not a file: ${relativePath}`);
  }
  return { absolutePath, relativePath };
}

export function applyCodeMapSettingsToGraph(graph: ProjectGraph, settings: CodeMapSettings): ProjectGraph {
  if (settings.tableRelationInference === 'foreign_key_and_name' || settings.tableRelationInference === 'name_only') {
    return graph;
  }
  const edges = graph.edges.filter((edge) => edge.edgeType !== 'references');
  const allowedEdgeIds = new Set(edges.map((edge) => edge.id));
  // 当前 references 边来自命名推断；关闭推断或只保留真实外键时，同步裁剪视图 edgeIds，避免展示被禁用的推断关系。
  const views = graph.views.map((view) => ({
    ...view,
    edgeIds: view.edgeIds.filter((edgeId) => allowedEdgeIds.has(edgeId)),
  }));
  return { ...graph, edges, views };
}
