#!/usr/bin/env node
import {readFile, writeFile} from 'node:fs/promises';
import initSqlJs, {type SqlValue} from 'sql.js';
import {buildProjectGraph, type CodeSymbolFact, type ProjectGraph} from './index.js';

interface CliArgs {
  command: 'generate-views' | 'assert-nonempty';
  db: string;
  project: string;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[2] as CliArgs['command'];
  const values = new Map<string, string>();
    for (let index = 3; index < argv.length; index += 2) values.set(argv[index]!, argv[index + 1]!);
  const db = values.get('--db');
  const project = values.get('--project');
  if (!['generate-views', 'assert-nonempty'].includes(command) || !db || !project) {
    throw new Error('Usage: zeus-graph-engine <generate-views|assert-nonempty> --db <sqlite-file> --project <name>');
  }
  return { command, db, project };
}

async function openDb(filePath: string) {
  const SQL = await initSqlJs();
  return new SQL.Database(await readFile(filePath));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const db = await openDb(args.db);
  if (args.command === 'generate-views') {
      persistGraph(db, graphFromSymbols(db, args.project));
    await writeFile(args.db, Buffer.from(db.export()));
  }
  const counts = readCounts(db);
    if (args.command === 'assert-nonempty' && (counts.symbolCount <= 0 || counts.nodeCount <= 0 || counts.edgeCount <= 0 || counts.viewCount <= 0)) {
    throw new Error(`Zeus graph assertion failed: ${JSON.stringify(counts)}`);
  }
  console.log(JSON.stringify(counts, null, 2));
}

/** CLI 与服务端共用同一图算法；这里只负责把 SQLite 行还原成扫描事实。 */
function graphFromSymbols(db: initSqlJs.Database, projectName: string): ProjectGraph {
    const symbols = selectRows(db, `SELECT * FROM code_symbols WHERE project_name = ? ORDER BY file_path, line_start`, [projectName]).map<CodeSymbolFact>((row) => ({
        id: String(row.id),
        symbolType: String(row.symbol_type),
        name: String(row.name),
        qualifiedName: String(row.qualified_name),
        filePath: String(row.file_path),
        lineStart: Number(row.line_start),
        lineEnd: Number(row.line_end),
        language: String(row.language),
        sourceHash: String(row.source_hash),
        metadata: parseObject(row.metadata_json),
    }));
    const rootPath = String(selectRows(db, `SELECT value FROM scan_metadata WHERE key = 'root_path'`)[0]?.value ?? '');
    return buildProjectGraph({projectName, rootPath, symbols});
}

function persistGraph(db: initSqlJs.Database, graph: ProjectGraph): void {
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
    )
  `);
  db.run(`
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
  db.run(`
    CREATE TABLE IF NOT EXISTS graph_views (
      id TEXT PRIMARY KEY,
      project_name TEXT NOT NULL,
      view_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `);
    db.run('DELETE FROM project_nodes WHERE project_name = ?', [graph.projectName]);
    db.run('DELETE FROM project_edges WHERE project_name = ?', [graph.projectName]);
    db.run('DELETE FROM graph_views WHERE project_name = ?', [graph.projectName]);

  const nodeInsert = db.prepare(`INSERT INTO project_nodes (id, project_name, node_type, name, qualified_name, source_ref, symbol_id, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
      for (const node of graph.nodes) {
          nodeInsert.run([node.id, graph.projectName, node.nodeType, node.name, node.qualifiedName, node.sourceRef, node.symbolId, JSON.stringify(node.metadata)]);
    }
  } finally {
    nodeInsert.free();
  }

    const edgeInsert = db.prepare(`INSERT INTO project_edges (id, project_name, edge_type, source_node_id, target_node_id, source_ref, confidence, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  try {
      for (const edge of graph.edges) {
          edgeInsert.run([edge.id, graph.projectName, edge.edgeType, edge.sourceNodeId, edge.targetNodeId, edge.sourceRef, edge.confidence, JSON.stringify(edge.metadata ?? {})]);
    }
  } finally {
    edgeInsert.free();
  }

    const viewInsert = db.prepare(`INSERT INTO graph_views (id, project_name, view_type, title, payload_json) VALUES (?, ?, ?, ?, ?)`);
  try {
      for (const view of graph.views) {
          viewInsert.run([view.id, graph.projectName, view.viewType, view.title, JSON.stringify({
              schemaVersion: view.schemaVersion,
              nodeIds: view.nodeIds,
              edgeIds: view.edgeIds,
              layout: view.layout
          })]);
      }
  } finally {
      viewInsert.free();
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  try {
      const parsed = JSON.parse(String(value)) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
      return {};
  }
}

function selectRows(db: initSqlJs.Database, sql: string, params: SqlValue[] = []): Record<string, unknown>[] {
    const statement = db.prepare(sql, params);
  const rows: Record<string, unknown>[] = [];
  try {
      while (statement.step()) rows.push(statement.getAsObject());
  } finally {
      statement.free();
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
    return Number(selectRows(db, `SELECT COUNT(*) AS count FROM ${table}`)[0]?.count ?? 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
