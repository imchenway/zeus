#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import initSqlJs, { type SqlValue } from 'sql.js';
import { nanoid } from 'nanoid';

interface CliArgs {
  command: 'generate-views' | 'assert-nonempty';
  db: string;
  project: string;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[2] as CliArgs['command'];
  const values = new Map<string, string>();
  for (let index = 3; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const db = values.get('--db');
  const project = values.get('--project');
  if (!['generate-views', 'assert-nonempty'].includes(command) || !db || !project) {
    throw new Error('Usage: zeus-graph-engine <generate-views|assert-nonempty> --db <sqlite-file> --project <name>');
  }
  return { command, db, project };
}

/** 打开真实扫描产生的 SQLite 文件，后续图谱 facts 继续写回同一文件。 */
async function openDb(filePath: string) {
  const SQL = await initSqlJs();
  return new SQL.Database(await readFile(filePath));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = await openDb(args.db);
  if (args.command === 'generate-views') {
    generateViews(db, args.project);
    await writeFile(args.db, Buffer.from(db.export()));
    const counts = readCounts(db);
    console.log(JSON.stringify(counts, null, 2));
    return;
  }
  const counts = readCounts(db);
  if (counts.symbolCount <= 0 || counts.nodeCount <= 0 || counts.edgeCount <= 0 || counts.viewCount <= 0) {
    throw new Error(`Zeus graph assertion failed: ${JSON.stringify(counts)}`);
  }
  console.log(JSON.stringify(counts, null, 2));
}

function generateViews(db: initSqlJs.Database, projectName: string): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS project_nodes (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      node_type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      symbol_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS project_edges (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      target_node_id TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      confidence REAL NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS graph_views (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      view_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
  `);
  db.run('DELETE FROM project_nodes WHERE project_name = ?', [projectName]);
  db.run('DELETE FROM project_edges WHERE project_name = ?', [projectName]);
  db.run('DELETE FROM graph_views WHERE project_name = ?', [projectName]);

  const symbols = selectRows(db, `SELECT * FROM code_symbols WHERE project_name = ? ORDER BY file_path, line_start`, [projectName]);
  const nodeBySymbol = new Map<string, string>();
  const fileNodeByPath = new Map<string, string>();
  const nodeInsert = db.prepare(`INSERT INTO project_nodes (id, project_name, node_type, name, qualified_name, source_ref, symbol_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
    for (const symbol of symbols) {
      const nodeId = `node_${nanoid(12)}`;
      nodeBySymbol.set(String(symbol.id), nodeId);
      if (symbol.symbol_type === 'file') fileNodeByPath.set(String(symbol.file_path), nodeId);
      nodeInsert.run([nodeId, projectName, String(symbol.symbol_type), String(symbol.name), String(symbol.qualified_name), String(symbol.file_path), String(symbol.id), String(symbol.metadata_json)]);
    }
  } finally {
    nodeInsert.free();
  }
  const edgeIds: string[] = [];
  const edgeInsert = db.prepare(`INSERT INTO project_edges (id, project_name, edge_type, source_node_id, target_node_id, source_ref, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  try {
    for (const symbol of symbols) {
      if (symbol.symbol_type === 'file') continue;
      const sourceNodeId = fileNodeByPath.get(String(symbol.file_path));
      const targetNodeId = nodeBySymbol.get(String(symbol.id));
      if (!sourceNodeId || !targetNodeId) continue;
      const edgeId = `edge_${nanoid(12)}`;
      edgeIds.push(edgeId);
      edgeInsert.run([edgeId, projectName, cliEdgeTypeForSymbol(String(symbol.symbol_type)), sourceNodeId, targetNodeId, String(symbol.file_path), 1]);
    }
    const nodeRows = selectRows(db, `SELECT id, node_type, name, qualified_name, source_ref, metadata_json FROM project_nodes WHERE project_name = ? ORDER BY rowid ASC`, [projectName]);
    for (const edge of buildCliApiHandlerEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'handles_api', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.9]);
    }
    for (const edge of buildCliFunctionCallEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'calls', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.8]);
    }
    for (const edge of buildCliResolvedCallTargetEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'resolves_to', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.7]);
    }
    for (const edge of buildCliFunctionControlFlowEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'control_flow', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.9]);
    }
    for (const edge of buildCliSequentialControlFlowEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'next_control_flow', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.75]);
    }
    for (const edge of buildCliLoopBackEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'loop_back', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.66]);
    }
    for (const edge of buildCliLoopControlTransferEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, edge.confidence]);
    }
    for (const edge of buildCliExceptionBranchEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, edge.confidence]);
    }
    for (const edge of buildCliAwaitedCallEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'awaits_call', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.78]);
    }
    for (const edge of buildCliPromiseChainEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, edge.confidence]);
    }
    for (const edge of buildCliFunctionSqlCallEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'executes_sql', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.9]);
    }
    for (const edge of buildCliSqlTableImpactEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.85]);
    }
    for (const edge of buildCliTableColumnEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'contains', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.95]);
    }
    for (const edge of buildCliSqlColumnImpactEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'uses_column', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.72]);
    }
    for (const edge of buildCliImportDependencyEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'module_depends_on', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.9]);
    }
    for (const edge of buildCliTableReferenceEdges(nodeRows)) {
      edgeIds.push(edge.id);
      edgeInsert.run([edge.id, projectName, 'references', edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, 0.6]);
    }
  } finally {
    edgeInsert.free();
  }
  const nodeRows = selectRows(db, `SELECT id, node_type, qualified_name, source_ref, metadata_json FROM project_nodes WHERE project_name = ? ORDER BY rowid ASC`, [projectName]);
  const edgeRows = selectRows(db, `SELECT id, edge_type, source_node_id, target_node_id, confidence FROM project_edges WHERE project_name = ? ORDER BY rowid ASC`, [projectName]);
  for (const view of buildCliGraphViews(projectName, nodeRows, edgeRows)) {
    db.run(`INSERT INTO graph_views (id, project_name, view_type, title, payload_json) VALUES (?, ?, ?, ?, ?)`, [
      `view_${nanoid(12)}`,
      projectName,
      view.viewType,
      view.title,
      JSON.stringify({ nodeIds: view.nodeIds, edgeIds: view.edgeIds }),
    ]);
  }
}

function buildCliGraphViews(
  projectName: string,
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
): Array<{
  viewType: string;
  title: string;
  nodeIds: string[];
  edgeIds: string[];
}> {
  const allNodeIds = nodes.map((node) => String(node.id));
  const architectureNodeIds = allNodeIds.slice(0, 250);
  const moduleNodeIds = pickCliNodeIds(nodes, ['package', 'file', 'class', 'interface', 'type']);
  const tableNodeIds = nodes.filter((node) => ['table', 'column'].includes(String(node.node_type)) || String(node.source_ref).endsWith('.sql') || cliMetadataLanguage(node) === 'sql').map((node) => String(node.id));
  const detailNodeIds = pickCliNodeIds(nodes, ['file', 'function', 'class', 'interface', 'type']).slice(0, 250);
  const apiNodeIds = pickCliApiSequenceNodeIds(nodes).slice(0, 1000);
  const flowNodeIds = pickCliNodeIds(nodes, ['package', 'file', 'function']).slice(0, 220);
  const methodNodeIds = pickCliMethodLogicNodeIds(nodes).slice(0, 5000);
  return [
    {
      viewType: 'architecture',
      title: `${projectName} 系统架构图`,
      nodeIds: architectureNodeIds,
      // CLI 导入路径也按最终可见节点裁剪边，避免生成会让桌面画布崩溃的悬空边。
      edgeIds: pickCliEdgeIds(edges, architectureNodeIds).slice(0, 500),
    },
    {
      viewType: 'module',
      title: `${projectName} 模块图`,
      nodeIds: moduleNodeIds.slice(0, 250),
      edgeIds: pickCliEdgeIds(edges, moduleNodeIds).slice(0, 500),
    },
    {
      viewType: 'table',
      title: `${projectName} 表关系图`,
      nodeIds: tableNodeIds.slice(0, 250),
      edgeIds: pickCliEdgeIds(edges, tableNodeIds).slice(0, 1000),
    },
    {
      viewType: 'module_detail',
      title: `${projectName} 模块详情图`,
      nodeIds: detailNodeIds,
      edgeIds: pickCliEdgeIds(edges, detailNodeIds).slice(0, 500),
    },
    {
      viewType: 'api_sequence',
      title: `${projectName} 接口时序图`,
      nodeIds: apiNodeIds,
      edgeIds: pickCliApiSequenceEdgeIds(edges, apiNodeIds).slice(0, 5000),
    },
    {
      viewType: 'module_flow',
      title: `${projectName} 模块流程图`,
      nodeIds: flowNodeIds,
      edgeIds: pickCliEdgeIds(edges, flowNodeIds).slice(0, 440),
    },
    {
      viewType: 'method_logic',
      title: `${projectName} 方法逻辑图`,
      nodeIds: methodNodeIds,
      edgeIds: pickCliMethodLogicEdgeIds(edges, methodNodeIds).slice(0, 20000),
    },
  ];
}

function cliEdgeTypeForSymbol(symbolType: string): string {
  if (symbolType === 'package') return 'contains';
  if (symbolType === 'api') return 'exposes_api';
  if (symbolType === 'control_flow') return 'control_flow';
  return 'declares';
}

function pickCliNodeIds(nodes: Record<string, unknown>[], nodeTypes: string[]): string[] {
  const allowed = new Set(nodeTypes);
  return nodes.filter((node) => allowed.has(String(node.node_type))).map((node) => String(node.id));
}

function pickCliEdgeIds(edges: Record<string, unknown>[], nodeIds: string[]): string[] {
  const allowed = new Set(nodeIds);
  return edges.filter((edge) => allowed.has(String(edge.source_node_id)) && allowed.has(String(edge.target_node_id))).map((edge) => String(edge.id));
}

function pickCliApiSequenceEdgeIds(edges: Record<string, unknown>[], nodeIds: string[]): string[] {
  const allowed = new Set(nodeIds);
  return edges
    .filter((edge) => allowed.has(String(edge.source_node_id)) && allowed.has(String(edge.target_node_id)))
    .sort((a, b) => cliApiSequenceEdgePriority(a) - cliApiSequenceEdgePriority(b))
    .map((edge) => String(edge.id));
}

function cliApiSequenceEdgePriority(edge: Record<string, unknown>): number {
  if (String(edge.edge_type) === 'handles_api') return 0;
  if (String(edge.edge_type) === 'calls') return 1;
  if (String(edge.edge_type) === 'resolves_to') return 2;
  if (String(edge.edge_type) === 'executes_sql') return 3;
  if (['reads_table', 'writes_table'].includes(String(edge.edge_type))) return 4;
  if (String(edge.edge_type) === 'uses_column') return 5;
  if (String(edge.edge_type) === 'exposes_api') return 5;
  return 6;
}

function pickCliMethodLogicEdgeIds(edges: Record<string, unknown>[], nodeIds: string[]): string[] {
  const allowed = new Set(nodeIds);
  return edges
    .filter((edge) => allowed.has(String(edge.source_node_id)) && allowed.has(String(edge.target_node_id)))
    .sort((a, b) => cliMethodLogicEdgePriority(a) - cliMethodLogicEdgePriority(b))
    .map((edge) => String(edge.id));
}

function cliMethodLogicEdgePriority(edge: Record<string, unknown>): number {
  if (String(edge.edge_type) === 'control_flow' && Number(edge.confidence) === 0.9) return 0;
  if (String(edge.edge_type) === 'executes_sql') return 1;
  if (['reads_table', 'writes_table'].includes(String(edge.edge_type))) return 2;
  if (String(edge.edge_type) === 'uses_column') return 3;
  if (['branch_true', 'branch_false'].includes(String(edge.edge_type))) return 4;
  if (String(edge.edge_type) === 'loop_back') return 5;
  if (['loop_continue', 'loop_break'].includes(String(edge.edge_type))) return 6;
  if (String(edge.edge_type) === 'try_catch') return 7;
  if (String(edge.edge_type) === 'try_finally') return 8;
  if (String(edge.edge_type) === 'promise_catch') return 9;
  if (String(edge.edge_type) === 'promise_then') return 10;
  if (String(edge.edge_type) === 'awaits_call') return 11;
  if (String(edge.edge_type) === 'next_control_flow') return 12;
  if (String(edge.edge_type) === 'control_flow') return 7;
  return 7;
}

function pickCliApiSequenceNodeIds(nodes: Record<string, unknown>[]): string[] {
  const apiNodes = nodes.filter((node) => String(node.node_type) === 'api');
  const apiSourceRefs = new Set(apiNodes.map((node) => String(node.source_ref)));
  const apiHandlerQualifiedNames = new Set(apiNodes.map((node) => cliMetadataHandlerQualifiedName(node)).filter((value) => value.length > 0));
  const apiSourceFileNodes = nodes.filter((node) => String(node.node_type) === 'file' && apiSourceRefs.has(String(node.source_ref)));
  const apiHandlerNodes = nodes.filter((node) => String(node.node_type) === 'function' && apiHandlerQualifiedNames.has(String(node.qualified_name)));
  const apiHandlerCallNodes = nodes.filter((node) => String(node.node_type) === 'function_call' && apiHandlerQualifiedNames.has(cliMetadataOwnerQualifiedName(node)));
  const resolvedTargetQualifiedNames = new Set(apiHandlerCallNodes.map((node) => cliMetadataTargetQualifiedName(node)).filter((value) => value.length > 0));
  const transitiveTargetCallNodes = collectCliApiSequenceTransitiveCallNodes(nodes, resolvedTargetQualifiedNames);
  const resolvedTargetNodes = nodes.filter((node) => String(node.node_type) === 'function' && resolvedTargetQualifiedNames.has(String(node.qualified_name)));
  const resolvedTargetSqlNodes = nodes.filter((node) => String(node.node_type) === 'sql_call' && resolvedTargetQualifiedNames.has(cliMetadataOwnerQualifiedName(node)));
  const resolvedTargetTableQualifiedNames = new Set(resolvedTargetSqlNodes.flatMap((node) => cliMetadataTableQualifiedNames(node)));
  const resolvedTargetTableNodes = nodes.filter((node) => String(node.node_type) === 'table' && resolvedTargetTableQualifiedNames.has(String(node.qualified_name)));
  const handlerLikeNodes = nodes.filter((node) => ['function', 'class'].includes(String(node.node_type)));
  return Array.from(
    new Set(
      [...apiNodes, ...apiSourceFileNodes, ...apiHandlerNodes, ...apiHandlerCallNodes, ...transitiveTargetCallNodes, ...resolvedTargetNodes, ...resolvedTargetSqlNodes, ...resolvedTargetTableNodes, ...handlerLikeNodes].map((node) =>
        String(node.id),
      ),
    ),
  );
}

/** CLI 产物与服务端一致：API 调用链最多展开 3 层，并防止循环调用无限膨胀。 */
function collectCliApiSequenceTransitiveCallNodes(nodes: Record<string, unknown>[], resolvedTargetQualifiedNames: Set<string>): Record<string, unknown>[] {
  const maxCallDepth = 3;
  const transitiveCallNodes: Record<string, unknown>[] = [];
  const visitedCallNodeIds = new Set<string>();
  let frontier = new Set(resolvedTargetQualifiedNames);
  for (let depth = 2; depth <= maxCallDepth && frontier.size > 0; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const node of nodes) {
      const nodeId = String(node.id);
      if (String(node.node_type) !== 'function_call' || visitedCallNodeIds.has(nodeId) || !frontier.has(cliMetadataOwnerQualifiedName(node))) continue;
      visitedCallNodeIds.add(nodeId);
      transitiveCallNodes.push(node);
      const targetQualifiedName = cliMetadataTargetQualifiedName(node);
      if (targetQualifiedName.length > 0 && !resolvedTargetQualifiedNames.has(targetQualifiedName)) {
        resolvedTargetQualifiedNames.add(targetQualifiedName);
        nextFrontier.add(targetQualifiedName);
      }
    }
    frontier = nextFrontier;
  }
  return transitiveCallNodes;
}

function pickCliMethodLogicNodeIds(nodes: Record<string, unknown>[]): string[] {
  const logicNodes = nodes.filter((node) => ['control_flow', 'sql_call'].includes(String(node.node_type)));
  const awaitedCallNodes = nodes.filter((node) => String(node.node_type) === 'function_call' && cliMetadataIsAwaited(node));
  const promiseChainCallNodes = nodes.filter((node) => String(node.node_type) === 'function_call' && cliMetadataIsPromiseChainRoot(node));
  const sqlCallNodes = logicNodes.filter((node) => String(node.node_type) === 'sql_call');
  const promiseControlNodes = logicNodes.filter((node) => ['promise_catch', 'promise_then'].includes(cliMetadataControlType(node)));
  const representativeControlNodes = pickCliRepresentativeControlFlowNodesByOwner(logicNodes);
  const remainingLogicNodes = logicNodes.filter((node) => String(node.node_type) !== 'sql_call' && !['promise_catch', 'promise_then'].includes(cliMetadataControlType(node)));
  const logicSourceRefs = new Set(logicNodes.map((node) => String(node.source_ref)));
  for (const node of [...awaitedCallNodes, ...promiseChainCallNodes]) logicSourceRefs.add(String(node.source_ref));
  const ownerQualifiedNames = new Set([...logicNodes, ...awaitedCallNodes, ...promiseChainCallNodes].map((node) => cliMetadataOwnerQualifiedName(node)).filter((value) => value.length > 0));
  const tableQualifiedNames = new Set(logicNodes.flatMap((node) => cliMetadataTableQualifiedNames(node)));
  const columnQualifiedNames = new Set(logicNodes.flatMap((node) => cliSqlColumnQualifiedNamesForNode(node)));
  const logicSourceFileNodes = nodes.filter((node) => String(node.node_type) === 'file' && logicSourceRefs.has(String(node.source_ref)));
  const ownerFunctionNodes = nodes.filter((node) => String(node.node_type) === 'function' && ownerQualifiedNames.has(String(node.qualified_name)));
  const impactedTableNodes = nodes.filter((node) => String(node.node_type) === 'table' && tableQualifiedNames.has(String(node.qualified_name)));
  const impactedColumnNodes = nodes.filter((node) => String(node.node_type) === 'column' && columnQualifiedNames.has(String(node.qualified_name)));
  const functionNodes = nodes.filter((node) => String(node.node_type) === 'function');
  // 关键证据节点必须优先进入方法逻辑图，避免大型项目中被普通控制流节点截断。
  return Array.from(
    new Set(
      [
        ...logicSourceFileNodes,
        ...ownerFunctionNodes,
        ...awaitedCallNodes,
        ...promiseChainCallNodes,
        ...promiseControlNodes,
        ...sqlCallNodes,
        ...impactedTableNodes,
        ...impactedColumnNodes,
        ...representativeControlNodes,
        ...remainingLogicNodes,
        ...functionNodes,
      ].map((node) => String(node.id)),
    ),
  );
}

function pickCliRepresentativeControlFlowNodesByOwner(logicNodes: Record<string, unknown>[]): Record<string, unknown>[] {
  const maxPerOwner = 5;
  const countsByOwner = new Map<string, number>();
  const representatives: Record<string, unknown>[] = [];
  for (const node of logicNodes) {
    if (String(node.node_type) !== 'control_flow') continue;
    const owner = cliMetadataOwnerQualifiedName(node);
    if (!owner) continue;
    const currentCount = countsByOwner.get(owner) ?? 0;
    if (currentCount >= maxPerOwner) continue;
    countsByOwner.set(owner, currentCount + 1);
    representatives.push(node);
  }
  return representatives;
}

/** CLI 路径同样连接 API route 到 handler，保证离线接口时序图可追到处理逻辑。 */
function buildCliApiHandlerEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'api' && cliMetadataHandlerQualifiedName(node).length > 0)
    .flatMap((apiNode) => {
      const handler = nodeByQualifiedName.get(cliMetadataHandlerQualifiedName(apiNode));
      if (!handler) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(apiNode.id),
          targetNodeId: String(handler.id),
          sourceRef: String(apiNode.source_ref),
        },
      ];
    });
}

/** CLI 路径连接函数到其内部调用点，保持 API 时序图调用链一致。 */
function buildCliFunctionCallEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'function_call' && cliMetadataOwnerQualifiedName(node).length > 0)
    .flatMap((callNode) => {
      const owner = nodeByQualifiedName.get(cliMetadataOwnerQualifiedName(callNode));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(owner.id),
          targetNodeId: String(callNode.id),
          sourceRef: String(callNode.source_ref),
        },
      ];
    });
}

/** CLI 路径连接调用点到已解析目标方法，保持跨文件调用链一致。 */
function buildCliResolvedCallTargetEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'function_call' && cliMetadataTargetQualifiedName(node).length > 0)
    .flatMap((callNode) => {
      const target = nodeByQualifiedName.get(cliMetadataTargetQualifiedName(callNode));
      if (!target) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(callNode.id),
          targetNodeId: String(target.id),
          sourceRef: String(callNode.source_ref),
        },
      ];
    });
}

function buildCliFunctionControlFlowEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'control_flow' && cliMetadataOwnerQualifiedName(node).length > 0)
    .flatMap((controlFlowNode) => {
      const owner = nodeByQualifiedName.get(cliMetadataOwnerQualifiedName(controlFlowNode));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(owner.id),
          targetNodeId: String(controlFlowNode.id),
          sourceRef: String(controlFlowNode.source_ref),
        },
      ];
    });
}

/** CLI 路径按源码行号连接同一函数内的控制流节点，保持方法逻辑图顺序一致。 */
function buildCliSequentialControlFlowEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const controlNodesByOwner = new Map<string, Record<string, unknown>[]>();
  for (const node of nodes) {
    if (String(node.node_type) !== 'control_flow') continue;
    const ownerQualifiedName = cliMetadataOwnerQualifiedName(node);
    if (!ownerQualifiedName) continue;
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }
  const edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceRef: string;
  }> = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => cliMetadataLineStart(a) - cliMetadataLineStart(b) || String(a.qualified_name).localeCompare(String(b.qualified_name)));
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const source = ordered[index];
      const target = ordered[index + 1];
      if (!source || !target) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        sourceNodeId: String(source.id),
        targetNodeId: String(target.id),
        sourceRef: String(source.source_ref),
      });
    }
  }
  return edges;
}

/** CLI 路径为循环控制流写入回边，确保真实扫描产物和服务端图谱一致。 */
function buildCliLoopBackEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  return nodes
    .filter((node) => String(node.node_type) === 'control_flow' && cliMetadataControlType(node) === 'loop')
    .map((loopNode) => ({
      id: `edge_${nanoid(12)}`,
      sourceNodeId: String(loopNode.id),
      targetNodeId: String(loopNode.id),
      sourceRef: String(loopNode.source_ref),
    }));
}

/** CLI 路径连接 continue/break 到最近循环头，保持真实扫描 SQLite 产物和服务端图谱一致。 */
function buildCliLoopControlTransferEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
}> {
  const controlNodesByOwner = new Map<string, Record<string, unknown>[]>();
  for (const node of nodes) {
    if (String(node.node_type) !== 'control_flow') continue;
    const ownerQualifiedName = cliMetadataOwnerQualifiedName(node);
    if (!ownerQualifiedName) continue;
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }

  const edges: Array<{
    id: string;
    edgeType: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceRef: string;
    confidence: number;
  }> = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => cliMetadataLineStart(a) - cliMetadataLineStart(b) || String(a.qualified_name).localeCompare(String(b.qualified_name)));
    for (const node of ordered) {
      const controlType = cliMetadataControlType(node);
      if (!['continue', 'break'].includes(controlType)) continue;
      const lineStart = cliMetadataLineStart(node);
      const nearestLoop = [...ordered].reverse().find((candidate) => cliMetadataControlType(candidate) === 'loop' && cliMetadataLineStart(candidate) < lineStart);
      if (!nearestLoop) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: controlType === 'continue' ? 'loop_continue' : 'loop_break',
        sourceNodeId: String(node.id),
        targetNodeId: String(nearestLoop.id),
        sourceRef: String(node.source_ref),
        confidence: controlType === 'continue' ? 0.64 : 0.6,
      });
    }
  }
  return edges;
}

/** CLI 路径连接同一函数内的 try/catch/finally，保持 SQLite 产物和服务端图谱一致。 */
function buildCliExceptionBranchEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
}> {
  const controlNodesByOwner = new Map<string, Record<string, unknown>[]>();
  for (const node of nodes) {
    if (String(node.node_type) !== 'control_flow') continue;
    const ownerQualifiedName = cliMetadataOwnerQualifiedName(node);
    if (!ownerQualifiedName) continue;
    controlNodesByOwner.set(ownerQualifiedName, [...(controlNodesByOwner.get(ownerQualifiedName) ?? []), node]);
  }

  const edges: Array<{
    id: string;
    edgeType: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceRef: string;
    confidence: number;
  }> = [];
  for (const controlNodes of controlNodesByOwner.values()) {
    const ordered = [...controlNodes].sort((a, b) => cliMetadataLineStart(a) - cliMetadataLineStart(b) || String(a.qualified_name).localeCompare(String(b.qualified_name)));
    for (const branchNode of ordered.filter((node) => ['catch', 'finally'].includes(cliMetadataControlType(node)))) {
      const branchLine = cliMetadataLineStart(branchNode);
      const nearestTry = [...ordered].reverse().find((candidate) => cliMetadataControlType(candidate) === 'try' && cliMetadataLineStart(candidate) < branchLine);
      if (!nearestTry) continue;
      const isFinally = cliMetadataControlType(branchNode) === 'finally';
      edges.push({
        id: `edge_${nanoid(12)}`,
        edgeType: isFinally ? 'try_finally' : 'try_catch',
        sourceNodeId: String(nearestTry.id),
        targetNodeId: String(branchNode.id),
        sourceRef: String(branchNode.source_ref),
        confidence: isFinally ? 0.58 : 0.62,
      });
    }
  }
  return edges;
}

/** CLI 路径把 await 调用点连回所属函数，支撑方法逻辑图展示异步等待关系。 */
function buildCliAwaitedCallEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'function_call' && cliMetadataIsAwaited(node) && cliMetadataOwnerQualifiedName(node).length > 0)
    .flatMap((callNode) => {
      const owner = nodeByQualifiedName.get(cliMetadataOwnerQualifiedName(callNode));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(owner.id),
          targetNodeId: String(callNode.id),
          sourceRef: String(callNode.source_ref),
        },
      ];
    });
}

/** CLI 路径连接 Promise 链根调用到同一行的 then/catch 控制流。 */
function buildCliPromiseChainEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
  confidence: number;
}> {
  const promiseControlNodes = nodes.filter((node) => String(node.node_type) === 'control_flow' && ['promise_catch', 'promise_then'].includes(cliMetadataControlType(node)));
  return nodes
    .filter((node) => String(node.node_type) === 'function_call' && ['catch', 'then'].includes(cliMetadataPromiseChainHandler(node)))
    .flatMap((callNode) => {
      const handler = cliMetadataPromiseChainHandler(callNode);
      const controlNode = promiseControlNodes.find((node) => String(node.source_ref) === String(callNode.source_ref) && cliMetadataLineStart(node) === cliMetadataLineStart(callNode) && cliMetadataPromiseChainHandler(node) === handler);
      if (!controlNode) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          edgeType: handler === 'then' ? 'promise_then' : 'promise_catch',
          sourceNodeId: String(callNode.id),
          targetNodeId: String(controlNode.id),
          sourceRef: String(callNode.source_ref),
          confidence: handler === 'then' ? 0.6 : 0.61,
        },
      ];
    });
}

/** CLI 路径同样把 SQL 调用节点连回所属函数，避免服务端和离线生成结果不一致。 */
function buildCliFunctionSqlCallEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'sql_call' && cliMetadataOwnerQualifiedName(node).length > 0)
    .flatMap((sqlCallNode) => {
      const owner = nodeByQualifiedName.get(cliMetadataOwnerQualifiedName(sqlCallNode));
      if (!owner) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(owner.id),
          targetNodeId: String(sqlCallNode.id),
          sourceRef: String(sqlCallNode.source_ref),
        },
      ];
    });
}

/** CLI 路径连接 SQL 调用与真实表节点，保持读写影响边和服务端一致。 */
function buildCliSqlTableImpactEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  edgeType: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'sql_call')
    .flatMap((sqlCallNode) =>
      cliMetadataTableQualifiedNames(sqlCallNode).flatMap((tableQualifiedName) => {
        const tableNode = nodeByQualifiedName.get(tableQualifiedName);
        if (!tableNode) return [];
        return [
          {
            id: `edge_${nanoid(12)}`,
            edgeType: cliMetadataAccessMode(sqlCallNode) === 'write' ? 'writes_table' : 'reads_table',
            sourceNodeId: String(sqlCallNode.id),
            targetNodeId: String(tableNode.id),
            sourceRef: String(sqlCallNode.source_ref),
          },
        ];
      }),
    );
}

/** CLI 路径把表节点连接到字段节点，支撑离线表关系图展示字段明细。 */
function buildCliTableColumnEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'column' && cliMetadataTableQualifiedName(node).length > 0)
    .flatMap((columnNode) => {
      const tableNode = nodeByQualifiedName.get(cliMetadataTableQualifiedName(columnNode));
      if (!tableNode) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(tableNode.id),
          targetNodeId: String(columnNode.id),
          sourceRef: String(columnNode.source_ref),
        },
      ];
    });
}

/** CLI 路径连接 SQL 调用与真实字段节点，表达字段级影响分析。 */
function buildCliSqlColumnImpactEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'sql_call')
    .flatMap((sqlCallNode) =>
      cliSqlColumnQualifiedNamesForNode(sqlCallNode).flatMap((columnQualifiedName) => {
        const columnNode = nodeByQualifiedName.get(columnQualifiedName);
        if (!columnNode) return [];
        return [
          {
            id: `edge_${nanoid(12)}`,
            sourceNodeId: String(sqlCallNode.id),
            targetNodeId: String(columnNode.id),
            sourceRef: String(sqlCallNode.source_ref),
          },
        ];
      }),
    );
}

function cliSqlColumnQualifiedNamesForNode(node: Record<string, unknown>): string[] {
  const fieldNames = new Set([
    ...cliMetadataStringArray(node, 'selectedFields'),
    ...cliMetadataStringArray(node, 'whereFields'),
    ...cliMetadataStringArray(node, 'orderByFields'),
    ...cliMetadataStringArray(node, 'groupByFields'),
    ...cliMetadataStringArray(node, 'joinFields'),
  ]);
  return cliMetadataTableQualifiedNames(node).flatMap((tableQualifiedName) => Array.from(fieldNames).map((fieldName) => `${tableQualifiedName}#column:${fieldName}`));
}

/** CLI 路径把 import 事实转成模块依赖边，保证离线生成和服务端图谱一致。 */
function buildCliImportDependencyEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const fileNodeBySourceRef = new Map(nodes.filter((node) => String(node.node_type) === 'file').map((node) => [String(node.source_ref), node]));
  const nodeByQualifiedName = new Map(nodes.map((node) => [String(node.qualified_name), node]));
  return nodes
    .filter((node) => String(node.node_type) === 'import' && cliMetadataResolvedRelativePath(node).length > 0)
    .flatMap((importNode) => {
      const sourceFile = fileNodeBySourceRef.get(String(importNode.source_ref));
      const targetFile = nodeByQualifiedName.get(cliMetadataResolvedRelativePath(importNode));
      if (!sourceFile || !targetFile || String(sourceFile.id) === String(targetFile.id)) return [];
      return [
        {
          id: `edge_${nanoid(12)}`,
          sourceNodeId: String(sourceFile.id),
          targetNodeId: String(targetFile.id),
          sourceRef: String(importNode.source_ref),
        },
      ];
    });
}

function buildCliTableReferenceEdges(nodes: Record<string, unknown>[]): Array<{
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceRef: string;
}> {
  const tableNodes = nodes.filter((node) => String(node.node_type) === 'table');
  const tableBySingularName = new Map(tableNodes.map((node) => [singularizeCliTableName(String(node.name)), node]));
  const edges: Array<{
    id: string;
    sourceNodeId: string;
    targetNodeId: string;
    sourceRef: string;
  }> = [];
  for (const tableNode of tableNodes) {
    for (const column of cliMetadataColumns(tableNode)) {
      if (!column.endsWith('_id')) continue;
      const target = tableBySingularName.get(column.slice(0, -3));
      if (!target || String(target.id) === String(tableNode.id)) continue;
      edges.push({
        id: `edge_${nanoid(12)}`,
        sourceNodeId: String(tableNode.id),
        targetNodeId: String(target.id),
        sourceRef: String(tableNode.source_ref),
      });
    }
  }
  return edges;
}

function cliMetadataColumns(node: Record<string, unknown>): string[] {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      columns?: unknown;
    };
    return Array.isArray(parsed.columns) ? parsed.columns.filter((column): column is string => typeof column === 'string') : [];
  } catch {
    return [];
  }
}

function cliMetadataStringArray(node: Record<string, unknown>, key: string): string[] {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as Record<string, unknown>;
    const value = parsed[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function singularizeCliTableName(tableName: string): string {
  return tableName.endsWith('ies') ? `${tableName.slice(0, -3)}y` : tableName.endsWith('s') ? tableName.slice(0, -1) : tableName;
}

function cliMetadataLanguage(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      language?: unknown;
    };
    return typeof parsed.language === 'string' ? parsed.language : '';
  } catch {
    return '';
  }
}

function cliMetadataTableQualifiedNames(node: Record<string, unknown>): string[] {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      tableQualifiedNames?: unknown;
    };
    return Array.isArray(parsed.tableQualifiedNames) ? parsed.tableQualifiedNames.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function cliMetadataTableQualifiedName(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      tableQualifiedName?: unknown;
    };
    return typeof parsed.tableQualifiedName === 'string' ? parsed.tableQualifiedName : '';
  } catch {
    return '';
  }
}

function cliMetadataAccessMode(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      accessMode?: unknown;
    };
    return typeof parsed.accessMode === 'string' ? parsed.accessMode : '';
  } catch {
    return '';
  }
}

function cliMetadataResolvedRelativePath(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      resolvedRelativePath?: unknown;
    };
    return typeof parsed.resolvedRelativePath === 'string' ? parsed.resolvedRelativePath : '';
  } catch {
    return '';
  }
}

function cliMetadataLineStart(node: Record<string, unknown>): number {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      lineStart?: unknown;
    };
    const lineStart = Number(parsed.lineStart ?? 0);
    if (lineStart > 0) return lineStart;
  } catch {
    // 继续走 qualified_name/name 兜底解析。
  }
  const qualifiedLine = String(node.qualified_name ?? '').match(/:L(\d+)$/u)?.[1];
  if (qualifiedLine) return Number(qualifiedLine);
  const nameLine = String(node.name ?? '').match(/\bL(\d+)$/u)?.[1];
  return nameLine ? Number(nameLine) : 0;
}

function cliMetadataTargetQualifiedName(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      targetQualifiedName?: unknown;
    };
    return typeof parsed.targetQualifiedName === 'string' ? parsed.targetQualifiedName : '';
  } catch {
    return '';
  }
}

function cliMetadataHandlerQualifiedName(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      handlerQualifiedName?: unknown;
    };
    return typeof parsed.handlerQualifiedName === 'string' ? parsed.handlerQualifiedName : '';
  } catch {
    return '';
  }
}

function cliMetadataControlType(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      controlType?: unknown;
    };
    return typeof parsed.controlType === 'string' ? parsed.controlType : '';
  } catch {
    return '';
  }
}

function cliMetadataIsAwaited(node: Record<string, unknown>): boolean {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      isAwaited?: unknown;
    };
    return parsed.isAwaited === true;
  } catch {
    return false;
  }
}

function cliMetadataIsPromiseChainRoot(node: Record<string, unknown>): boolean {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      isPromiseChainRoot?: unknown;
    };
    return parsed.isPromiseChainRoot === true;
  } catch {
    return false;
  }
}

function cliMetadataPromiseChainHandler(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      promiseChainHandler?: unknown;
    };
    return typeof parsed.promiseChainHandler === 'string' ? parsed.promiseChainHandler : '';
  } catch {
    return '';
  }
}

function cliMetadataOwnerQualifiedName(node: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(String(node.metadata_json ?? '{}')) as {
      ownerQualifiedName?: unknown;
    };
    return typeof parsed.ownerQualifiedName === 'string' ? parsed.ownerQualifiedName : '';
  } catch {
    return '';
  }
}

function selectRows(db: initSqlJs.Database, sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
  const stmt = db.prepare(sql, params);
  const rows: Record<string, unknown>[] = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject());
  } finally {
    stmt.free();
  }
  return rows;
}

function readCounts(db: initSqlJs.Database): Record<string, number> {
  return {
    symbolCount: count(db, 'code_symbols'),
    nodeCount: count(db, 'project_nodes'),
    edgeCount: count(db, 'project_edges'),
    viewCount: count(db, 'graph_views'),
  };
}

function count(db: initSqlJs.Database, table: string): number {
  const row = selectRows(db, `SELECT COUNT(*) AS count FROM ${table}`)[0];
  return Number(row?.count ?? 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
