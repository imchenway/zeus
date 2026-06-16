#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import initSqlJs from 'sql.js';
import { scanProjectSource } from './index.js';

interface CliArgs {
  command: string;
  path: string;
  projectName: string;
  db: string;
}

function parseArgs(argv: string[]): CliArgs {
  const command = argv[2] ?? '';
  const values = new Map<string, string>();
  for (let index = 3; index < argv.length; index += 2) {
    values.set(argv[index], argv[index + 1]);
  }
  const path = values.get('--path');
  const projectName = values.get('--project-name');
  const db = values.get('--db');
  if (command !== 'scan' || !path || !projectName || !db) {
    throw new Error('Usage: zeus-code-indexer scan --path <path> --project-name <name> --db <sqlite-file>');
  }
  return { command, path, projectName, db };
}

/** CLI 入口：只扫描真实路径并写入带来源的 SQLite facts。 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const scan = await scanProjectSource({
    rootPath: args.path,
    projectName: args.projectName,
  });
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE scan_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE code_symbols (
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
    );
  `);
  db.run('INSERT INTO scan_metadata (key, value) VALUES (?, ?), (?, ?), (?, ?)', ['project_name', scan.projectName, 'root_path', scan.rootPath, 'file_count', String(scan.files.length)]);
  const insert = db.prepare(`
    INSERT INTO code_symbols (
      id, project_name, symbol_type, name, qualified_name, file_path, line_start, line_end, language, metadata_json, source_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  try {
    for (const symbol of scan.symbols) {
      insert.run([symbol.id, scan.projectName, symbol.symbolType, symbol.name, symbol.qualifiedName, symbol.filePath, symbol.lineStart, symbol.lineEnd, symbol.language, JSON.stringify(symbol.metadata), symbol.sourceHash]);
    }
  } finally {
    insert.free();
  }
  await mkdir(dirname(args.db), { recursive: true });
  await writeFile(args.db, Buffer.from(db.export()));
  console.log(
    JSON.stringify(
      {
        projectName: scan.projectName,
        fileCount: scan.files.length,
        symbolCount: scan.symbols.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
