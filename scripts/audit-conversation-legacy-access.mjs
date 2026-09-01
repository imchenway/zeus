import {readdir, readFile} from 'node:fs/promises';
import {extname, relative, resolve} from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceRoots = ['apps', 'packages', 'scripts'];
const selfPath = relative(repositoryRoot, fileURLToPath(import.meta.url));
const legacyTable = ['conversation', 'items'].join('_');
const repositoryName = ['Conversation', 'Item', 'Repository'].join('');
const sourceExtensions = new Set(['.ts', '.tsx', '.cts', '.mts', '.js', '.mjs', '.cjs']);
const ignoredDirectories = new Set(['node_modules', 'dist', 'out', 'release', 'coverage', '.git']);
const writeMethods = new Set(['appendDelta', 'upsertProgress', 'upsertCompleted', 'replaceCompletedPiAgentMessage']);
const readMethods = new Set(['getByProvider', 'getById', 'listByConversation', 'getLatestCompletedPlanByTurn', 'listLatestCompletedPlansByTurns']);
const repositoryMethods = new Set([...writeMethods, ...readMethods]);

const files = (await Promise.all(sourceRoots.map((root) => collectSourceFiles(resolve(repositoryRoot, root))))).flat().sort();
const directSql = [];
const repositoryCalls = [];
const dependencies = [];
const unknown = [];

for (const absolutePath of files) {
  const file = relative(repositoryRoot, absolutePath);
  if (file === selfPath) continue;
  const source = await readFile(absolutePath, 'utf8');
  for (const occurrence of allOccurrences(source, legacyTable)) {
    const line = lineNumber(source, occurrence);
    const classification = classifyDirectAccess(file, source, occurrence);
    const entry = {
      file,
      line,
      operation: sqlOperation(source, occurrence),
      owner: classification.owner,
      lifecycle: classification.lifecycle,
      replacement: classification.replacement,
    };
    directSql.push(entry);
    if (classification.lifecycle === 'unknown') unknown.push({ kind: 'direct_sql', ...entry });
  }

  const callPattern = /\b(?:options\.|input\.)?(?:items|conversationItems)\.(\w+)\s*\(/gu;
  for (const match of source.matchAll(callPattern)) {
    const method = match[1];
    if (!repositoryMethods.has(method)) continue;
    const classification = classifyRepositoryCall(file, method);
    const entry = {
      file,
      line: lineNumber(source, match.index),
      method,
      access: writeMethods.has(method) ? 'write' : 'read',
      owner: classification.owner,
      lifecycle: classification.lifecycle,
      replacement: classification.replacement,
    };
    repositoryCalls.push(entry);
    if (classification.lifecycle === 'unknown') unknown.push({ kind: 'repository_call', ...entry });
  }

  for (const occurrence of allOccurrences(source, repositoryName)) {
    dependencies.push({ file, line: lineNumber(source, occurrence), owner: dependencyOwner(file) });
  }
}

const runtimeReads = repositoryCalls.filter((entry) => entry.access === 'read' && entry.lifecycle === 'runtime_compatibility');
const runtimeWrites = repositoryCalls.filter((entry) => entry.access === 'write' && entry.lifecycle === 'runtime_compatibility');
const report = {
  schemaVersion: 1,
  generation: '2026-08-21-conversation-items-source-audit-v1',
  generatedAt: new Date().toISOString(),
  target: legacyTable,
  sourceRoots,
  directSql,
  repositoryCalls,
  repositoryDependencies: uniqueEntries(dependencies),
  summary: {
    directSqlReferences: directSql.length,
    repositoryCallSites: repositoryCalls.length,
    runtimeReadSites: runtimeReads.length,
    runtimeWriteSites: runtimeWrites.length,
    migrationOrSchemaSites: directSql.filter((entry) => entry.lifecycle.startsWith('migration') || entry.lifecycle === 'schema' || entry.lifecycle === 'deferred_index').length,
    unknownSites: unknown.length,
  },
  cutover: {
    sourceAuditComplete: unknown.length === 0,
    legacyReadRemovalReady: unknown.length === 0 && runtimeReads.length === 0,
    legacyWriteFenceReady: unknown.length === 0 && runtimeWrites.length === 0,
    blockers: [
      ...runtimeReads.map((entry) => `${entry.file}:${entry.line} ${entry.method}`),
      ...runtimeWrites.map((entry) => `${entry.file}:${entry.line} ${entry.method}`),
      ...unknown.map((entry) => `${entry.file}:${entry.line} unknown ${entry.kind}`),
    ],
  },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (unknown.length > 0 || (process.argv.includes('--require-cutover-ready') && (!report.cutover.legacyReadRemovalReady || !report.cutover.legacyWriteFenceReady))) {
  process.exitCode = 1;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) continue;
    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) nested.push(...(await collectSourceFiles(absolutePath)));
    else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) nested.push(absolutePath);
  }
  return nested;
}

function allOccurrences(source, token) {
  const indexes = [];
  let cursor = 0;
  while (cursor < source.length) {
    const index = source.indexOf(token, cursor);
    if (index === -1) break;
    indexes.push(index);
    cursor = index + token.length;
  }
  return indexes;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function sqlOperation(source, occurrence) {
  const start = Math.max(source.lastIndexOf('`', occurrence), source.lastIndexOf("'", occurrence), source.lastIndexOf('"', occurrence));
  const prefix = source.slice(Math.max(0, start), occurrence).replace(/\s+/gu, ' ');
  const matches = [...prefix.matchAll(/\b(CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE|INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM|SELECT(?: DISTINCT)?)[\s\S]*$/giu)];
  if (matches.length === 0) return 'reference';
  return matches.at(-1)[1].toLowerCase().replace(/\s+/gu, '_');
}

function classifyDirectAccess(file, source, occurrence) {
  if (file === 'packages/storage/src/index.ts') {
    const repositoryStart = source.indexOf(`export class ${repositoryName}`);
    if (occurrence >= repositoryStart && repositoryStart !== -1) {
      return {
        owner: 'legacy_conversation_item_repository',
        lifecycle: 'runtime_compatibility',
        replacement: 'ConversationSnapshotV2Repository + unified Provider projectors',
      };
    }
    const operation = sqlOperation(source, occurrence);
    if (operation.startsWith('create_') || operation === 'alter_table') {
      return { owner: 'storage_schema', lifecycle: 'schema', replacement: 'remove only after rollback generation expires' };
    }
    return { owner: 'storage_migration', lifecycle: 'migration_compatibility', replacement: 'candidate reconciliation, then retain only in rollback copy' };
  }
  if (file === 'packages/storage/src/conversationExecutionStore.ts') {
    return { owner: 'unified_store_migration', lifecycle: 'migration_read_only', replacement: 'generation-bound migration manifest' };
  }
  if (file === 'packages/storage/src/conversationHotQueryIndexes.ts') {
    return { owner: 'deferred_hot_index', lifecycle: 'deferred_index', replacement: 'drop after all V1 readers retire' };
  }
  if (file === 'packages/local-server/src/conversationStoreMigration.ts') {
    return { owner: 'candidate_store_migrator', lifecycle: 'migration_read_only', replacement: 'retain until legacy import window closes' };
  }
  if (file === 'packages/storage/src/conversationLegacyReconciliation.ts') {
    return { owner: 'legacy_reconciliation_diagnostic', lifecycle: 'diagnostic_read_only', replacement: 'remove after cutover evidence retention expires' };
  }
  if (file === 'packages/storage/src/conversationLegacyCutover.ts') {
    return { owner: 'legacy_cutover_candidate_migrator', lifecycle: 'migration_read_only', replacement: 'candidate-only migration, fence verification, and cutover receipt' };
  }
  if (file === 'scripts/prepare-conversation-legacy-cutover.ts') {
    return { owner: 'legacy_cutover_operator', lifecycle: 'diagnostic_read_only', replacement: 'offline candidate and rollback preparation; source opened read-only' };
  }
  if (file === 'scripts/compact-conversation-sync-candidate.ts') {
    return { owner: 'conversation_sync_candidate_compactor', lifecycle: 'migration_candidate_only', replacement: 'offline candidate compaction with business-fact identity verification' };
  }
  if (file === 'scripts/promote-conversation-sync-candidate.ts') {
    return { owner: 'conversation_sync_candidate_promoter', lifecycle: 'migration_read_only', replacement: 'offline target/candidate identity comparison before atomic promotion' };
  }
  if (file === 'packages/storage/src/tableOwnership.ts') {
    return { owner: 'storage_table_ownership_registry', lifecycle: 'schema_metadata', replacement: 'retain historical ownership classification' };
  }
  return { owner: 'unclassified', lifecycle: 'unknown', replacement: 'manual classification required' };
}

function classifyRepositoryCall(file, method) {
    if (file === 'packages/local-server/src/taskWorkManagement.ts') {
        return {
            owner: 'task_work_item_repository',
            lifecycle: 'unrelated_domain',
            replacement: 'not a legacy conversation_items access'
        };
    }
  if (file === 'packages/local-server/src/legacyCodexThreadMigration.ts') {
    return { owner: 'legacy_codex_thread_migration', lifecycle: 'migration_compatibility', replacement: 'unified import adapter with stable source identities' };
  }
  if (file === 'packages/local-server/src/codexNativeConversationCoordinator.ts' || file === 'packages/local-server/src/piNativeConversationCoordinator.ts' || file === 'packages/local-server/src/index.ts') {
    return {
      owner: file.includes('codexNative') ? 'codex_provider_adapter' : file.includes('piNative') ? 'pi_provider_adapter' : 'local_server_v1_projection',
      lifecycle: 'runtime_compatibility',
      replacement: writeMethods.has(method) ? 'unified model/process/timeline projector' : 'Snapshot V2 or dedicated unified request/plan/resource projection',
    };
  }
  return { owner: 'unclassified', lifecycle: 'unknown', replacement: 'manual classification required' };
}

function dependencyOwner(file) {
  if (file === 'packages/storage/src/index.ts') return 'repository_definition';
  if (file.includes('legacyCodexThreadMigration')) return 'migration_dependency';
  if (file.includes('codexNativeConversationCoordinator')) return 'codex_provider_dependency';
  if (file.includes('piNativeConversationCoordinator')) return 'pi_provider_dependency';
  if (file === 'packages/local-server/src/index.ts') return 'composition_root_dependency';
  return 'type_dependency';
}

function uniqueEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.file}:${entry.line}:${entry.owner}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
