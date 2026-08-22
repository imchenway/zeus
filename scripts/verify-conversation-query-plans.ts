import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID, conversationHotQueryIndexes, conversationQueryPlanDefinitions, createZeusDatabase } from '../packages/storage/src/index.js';

interface QueryPlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

function parseDatabaseArgument(arguments_: string[]): { databasePath: string | null } {
  if (arguments_.length === 0) return { databasePath: null };
  if (arguments_.length !== 2 || arguments_[0] !== '--db' || !arguments_[1]) {
    throw new Error('用法：tsx scripts/verify-conversation-query-plans.ts [--db <显式数据库路径>]');
  }
  return { databasePath: resolve(arguments_[1]) };
}

async function prepareTemporaryDatabase(): Promise<{ root: string; databasePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'zeus-zarch-010-query-plan-'));
  const databasePath = join(root, 'zeus-query-plan.db');
  const database = await createZeusDatabase(databasePath);
  await database.close();
  return { root, databasePath };
}

function immutableReadOnlyLocation(databasePath: string): string {
  const location = pathToFileURL(databasePath);
  location.searchParams.set('mode', 'ro');
  location.searchParams.set('immutable', '1');
  return location.href;
}

async function assertCheckpointedSnapshot(databasePath: string): Promise<void> {
  for (const suffix of ['-wal', '-journal']) {
    try {
      const sidecar = await stat(`${databasePath}${suffix}`);
      if (sidecar.size > 0) throw new Error(`只读核验拒绝未 checkpoint 的数据库：${databasePath}${suffix} (${sidecar.size} bytes)`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function readQueryPlans(databasePath: string): {
  queryOnly: boolean;
  migrationRecorded: boolean;
  indexes: Array<{ name: string; table: string; columns: readonly string[]; predicate: string | null; present: boolean }>;
  queries: Array<{
    id: string;
    description: string;
    scanBudgetRows: number;
    expectedIndex: string | null;
    details: string[];
    violations: string[];
  }>;
} {
  const database = new DatabaseSync(immutableReadOnlyLocation(databasePath), {
    readOnly: true,
    timeout: 5_000,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
  try {
    database.exec('PRAGMA query_only = ON');
    const queryOnly = Number(database.prepare('PRAGMA query_only').get()?.query_only ?? 0) === 1;
    const hasLedger = Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get());
    const migrationRecorded = hasLedger && Boolean(database.prepare('SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?').get(CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID));
    const indexes = conversationHotQueryIndexes.map((definition) => ({
      name: definition.name,
      table: definition.table,
      columns: definition.columns,
      predicate: definition.predicate,
      present: Boolean(database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?").get(definition.name)),
    }));
    const queries = conversationQueryPlanDefinitions.map((definition) => {
      const details: string[] = [];
      const violations: string[] = [];
      try {
        const rows = database.prepare(`EXPLAIN QUERY PLAN ${definition.sql}`).all(...definition.params) as unknown as QueryPlanRow[];
        details.push(...rows.map((row) => row.detail));
        const normalizedTable = definition.scannedTable.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const unindexedScan = new RegExp(`\\bSCAN\\s+(?:TABLE\\s+)?${normalizedTable}\\b(?!.*\\bUSING\\b)`, 'iu');
        if (details.some((detail) => unindexedScan.test(detail))) {
          violations.push(`超过扫描预算：${definition.scannedTable} 出现无索引全表扫描`);
        }
        if (details.some((detail) => /USE TEMP B-TREE/iu.test(detail))) {
          violations.push('出现临时 B-Tree 排序');
        }
        if (definition.expectedIndex && !details.some((detail) => detail.includes(definition.expectedIndex!))) {
          violations.push(`未命中预期索引 ${definition.expectedIndex}`);
        }
        if (!definition.expectedIndex && !details.some((detail) => /USING (?:COVERING )?INDEX/iu.test(detail))) {
          violations.push('未命中现有 sequence 索引');
        }
      } catch (error) {
        violations.push(error instanceof Error ? error.message : String(error));
      }
      return {
        id: definition.id,
        description: definition.description,
        scanBudgetRows: definition.scanBudgetRows,
        expectedIndex: definition.expectedIndex,
        details,
        violations,
      };
    });
    return { queryOnly, migrationRecorded, indexes, queries };
  } finally {
    database.close();
  }
}

const argument = parseDatabaseArgument(process.argv.slice(2));
let temporaryRoot: string | null = null;
try {
  const databasePath = argument.databasePath
    ? argument.databasePath
    : await prepareTemporaryDatabase().then((temporary) => {
        temporaryRoot = temporary.root;
        return temporary.databasePath;
      });
  await stat(databasePath);
  await assertCheckpointedSnapshot(databasePath);
  const result = readQueryPlans(databasePath);
  const failures = [
    ...(result.queryOnly ? [] : ['连接未进入 query_only 模式']),
    ...(result.migrationRecorded ? [] : [`缺少迁移账本 ${CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID}`]),
    ...result.indexes.filter((index) => !index.present).map((index) => `缺少索引 ${index.name}`),
    ...result.queries.flatMap((query) => query.violations.map((violation) => `${query.id}: ${violation}`)),
  ];
  console.log(
    JSON.stringify(
      {
        status: failures.length === 0 ? 'passed' : 'failed',
        mode: argument.databasePath ? 'explicit-read-only' : 'temporary',
        databasePath,
        queryOnly: result.queryOnly,
        migrationRecorded: result.migrationRecorded,
        indexes: result.indexes,
        queries: result.queries,
        failures,
      },
      null,
      2,
    ),
  );
  if (failures.length > 0) process.exitCode = 1;
} finally {
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
}
