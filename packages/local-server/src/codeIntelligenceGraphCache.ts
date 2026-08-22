import type { ProjectScanResult } from '@zeus/code-indexer';
import type { ProjectGraph } from '@zeus/graph-engine';
import type { SqlValue } from '@zeus/storage';

export function clearPersistedGraphCache(db: { execute: (sql: string, params?: SqlValue[]) => void }, projectName: string): void {
  ensureGraphCacheTables(db);
  // 图缓存禁用时只返回本次扫描结果，不保留旧 SQLite 视图，避免 UI 读取到过期图谱。
  db.execute('DELETE FROM code_symbols WHERE project_name = ?', [projectName]);
  db.execute('DELETE FROM project_nodes WHERE project_name = ?', [projectName]);
  db.execute('DELETE FROM project_edges WHERE project_name = ?', [projectName]);
  db.execute('DELETE FROM graph_views WHERE project_name = ?', [projectName]);
}

export function clearAllPersistedGraphCaches(db: { execute: (sql: string, params?: SqlValue[]) => void }): void {
  ensureGraphCacheTables(db);
  // 设置页缓存清理只删除可重建的代码索引/图谱/布局缓存，不触碰项目、任务、Runtime 日志或 Git 快照。
  db.execute('DELETE FROM code_symbols');
  db.execute('DELETE FROM project_nodes');
  db.execute('DELETE FROM project_edges');
  db.execute('DELETE FROM graph_views');
}

const RUNTIME_GRAPH_CACHE_NODE_BUDGET = 12000;
const RUNTIME_GRAPH_CACHE_EDGE_BUDGET = 24000;

export function compactProjectGraphForRuntimeCache(graph: ProjectGraph): ProjectGraph {
  const retainedNodeIds = new Set<string>();
  const retainedEdgeIds = new Set<string>();

  for (const view of graph.views) {
    for (const nodeId of view.nodeIds) {
      if (retainedNodeIds.size >= RUNTIME_GRAPH_CACHE_NODE_BUDGET) break;
      retainedNodeIds.add(nodeId);
    }
  }
  for (const view of graph.views) {
    for (const edgeId of view.edgeIds) {
      if (retainedEdgeIds.size >= RUNTIME_GRAPH_CACHE_EDGE_BUDGET) break;
      retainedEdgeIds.add(edgeId);
    }
  }

  if (retainedNodeIds.size === 0) return graph;
  const nodes = graph.nodes.filter((node) => retainedNodeIds.has(node.id));
  const retainedConcreteNodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => retainedEdgeIds.has(edge.id))
    .filter((edge) => retainedConcreteNodeIds.has(edge.sourceNodeId) && retainedConcreteNodeIds.has(edge.targetNodeId))
    .slice(0, RUNTIME_GRAPH_CACHE_EDGE_BUDGET);
  const retainedConcreteEdgeIds = new Set(edges.map((edge) => edge.id));
  const views = graph.views.map((view) => ({
    ...view,
    nodeIds: view.nodeIds.filter((nodeId) => retainedConcreteNodeIds.has(nodeId)),
    edgeIds: view.edgeIds.filter((edgeId) => retainedConcreteEdgeIds.has(edgeId)),
    layout: {
      ...view.layout,
      // 大型项目只把各视图实际可打开的节点坐标留进运行时缓存，防止 Electron 主进程为不可见全量符号撑爆内存。
      positions: view.layout.positions.filter((position) => retainedConcreteNodeIds.has(position.nodeId)),
    },
  }));

  return {
    ...graph,
    nodes,
    edges,
    views,
  };
}

export function ensureGraphCacheTables(db: { execute: (sql: string, params?: SqlValue[]) => void }): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS code_symbols (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      symbol_type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      language TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      source_hash TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS project_nodes (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      node_type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS project_edges (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      confidence REAL NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    )
  `);
  try {
    // 旧版本本地图缓存没有边 metadata；启动时补列，失败仅代表列已存在。
    db.execute(`ALTER TABLE project_edges ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // SQLite 不支持 ADD COLUMN IF NOT EXISTS，重复迁移时忽略即可。
  }
  db.execute(`
    CREATE TABLE IF NOT EXISTS graph_views (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      view_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
}

export function persistScanAndGraph(db: { execute: (sql: string, params?: SqlValue[]) => void }, scan: ProjectScanResult, graph: ProjectGraph): void {
  ensureGraphCacheTables(db);
  db.execute('DELETE FROM code_symbols WHERE project_name = ?', [scan.projectName]);
  db.execute('DELETE FROM project_nodes WHERE project_name = ?', [scan.projectName]);
  db.execute('DELETE FROM project_edges WHERE project_name = ?', [scan.projectName]);
  db.execute('DELETE FROM graph_views WHERE project_name = ?', [scan.projectName]);
  const retainedSymbolIds = new Set(graph.nodes.map((node) => node.symbolId));
  for (const symbol of scan.symbols.filter((item) => retainedSymbolIds.has(item.id))) {
    db.execute(
      `INSERT INTO code_symbols (id, project_name, symbol_type, name, qualified_name, file_path, line_start, line_end, language, metadata_json, source_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [symbol.id, scan.projectName, symbol.symbolType, symbol.name, symbol.qualifiedName, symbol.filePath, symbol.lineStart, symbol.lineEnd, symbol.language, JSON.stringify(symbol.metadata), symbol.sourceHash],
    );
  }
  for (const node of graph.nodes) {
    db.execute(
      `INSERT INTO project_nodes (id, project_name, node_type, name, qualified_name, source_ref, symbol_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [node.id, scan.projectName, node.nodeType, node.name, node.qualifiedName, node.sourceRef, node.symbolId, JSON.stringify(node.metadata)],
    );
  }
  for (const edge of graph.edges) {
    db.execute(
      `INSERT INTO project_edges (id, project_name, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [edge.id, scan.projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, edge.confidence, JSON.stringify(edge.metadata ?? {})],
    );
  }
  for (const view of graph.views) {
    db.execute(`INSERT INTO graph_views (id, project_name, view_type, title, payload_json) VALUES (?, ?, ?, ?, ?)`, [
      view.id,
      scan.projectName,
      view.viewType,
      view.title,
      JSON.stringify({
        schemaVersion: view.schemaVersion,
        nodeIds: view.nodeIds,
        edgeIds: view.edgeIds,
        layout: view.layout,
      }),
    ]);
  }
}
