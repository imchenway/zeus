import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLegacyFlatZeusDataLayout, createZeusDataLayout, type ZeusDataLayout } from '@zeus/local-server';

export type ZeusDataPreparationStatus = 'initialized' | 'already-layered' | 'migrated' | 'legacy-host-active';

export interface ZeusDataPreparationResult {
  status: ZeusDataPreparationStatus;
  layout: ZeusDataLayout;
  migrationManifestPath: string | null;
}

interface PathMapping {
  source: string;
  destination: string;
}

interface RecordedMove {
  source: string;
  destination: string;
}

interface LegacyRootValidation {
  root: string;
  managedPathCount: number;
  fileCount: number;
  directoryCount: number;
  totalFileBytes: number;
  authoritativeOverrideCount: number;
  evidenceMode?: 'live-mirror' | 'retired-record';
}

interface LegacyRootRetirementRecord {
  schema: 1;
  removedAt: string;
  legacyRoot: string;
  removedBytes: number;
  removedFiles: number;
  migrationManifestPath: string;
}

export interface MigrationManifest {
  schema: 1;
  id: string;
  status: 'committed';
  createdAt: string;
  root: string;
  databaseBackupPath: string;
  rewrittenRowCount: number;
  validatedLegacyRoots: LegacyRootValidation[];
  moves: RecordedMove[];
  cleanup: {
    removedBytes: number;
    removedFiles: number;
    removedEntries: string[];
    failedEntries: string[];
  };
}

const structuredRootNames = new Set(['data', 'artifacts', 'providers', 'backups', 'runtime', 'profile']);
const electronProfileEntries = new Set([
  '.DS_Store',
  'blob_storage',
  'Cache',
  'Code Cache',
  'Cookies',
  'Cookies-journal',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DevToolsActivePort',
  'DIPS',
  'DIPS-wal',
  'GPUCache',
  'Local State',
  'Local Storage',
  'main-window-state.json',
  'Network Persistent State',
  'Partitions',
  'Preferences',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'SharedStorage-wal',
  'SingletonCookie',
  'SingletonLock',
  'SingletonSocket',
  'Trust Tokens',
  'Trust Tokens-journal',
]);

const directPathColumns = [
  ['command_artifacts', 'absolute_path'],
  ['conversations', 'provider_thread_path'],
  ['conversations', 'native_session_path'],
  ['terminal_events', 'raw_chunk_path'],
  ['turn_change_files', 'pre_blob_ref'],
  ['turn_change_files', 'post_blob_ref'],
  ['turn_change_sets', 'journal_ref'],
] as const;

const jsonPathColumns = [
  ['conversation_resources', 'target_json'],
  ['conversation_resources', 'authority_json'],
  ['tasks', 'source_context_json'],
  ['settings', 'value_json'],
  ['conversation_submissions', 'input_json'],
] as const;

const contentMirroredLegacyTopLevels = new Set(['task-attachments', 'conversation-attachments', 'browser-comments', 'browser-downloads', 'sessions', 'turn-change-sets', 'command-runs', 'command-scripts', 'pi-sessions', 'agent-runtimes']);
const dataRootPreparationTimeoutMs = 15_000;
const staleDataRootPreparationLockMs = 30_000;
const dataRootPreparationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * 在 Electron 建立 profile 前准备 Zeus 本机资料目录。
 * 旧执行宿主仍存活时只返回兼容布局，绝不与它争抢数据库或移动文件。
 */
export function prepareZeusDataRoot(rootPath: string, legacyRoots: readonly string[] = []): ZeusDataPreparationResult {
  const root = normalizeAbsolutePath(rootPath, 'Zeus 数据根目录');
  const releasePreparationLock = acquireDataRootPreparationLock(root);
  try {
    return prepareZeusDataRootWithoutLock(root, legacyRoots);
  } finally {
    releasePreparationLock();
  }
}

function prepareZeusDataRootWithoutLock(root: string, legacyRoots: readonly string[] = []): ZeusDataPreparationResult {
  const layered = createZeusDataLayout(root);
  const flat = createLegacyFlatZeusDataLayout(root);
  const hasLayeredDatabase = existsSync(layered.database);
  const hasFlatDatabase = existsSync(flat.database);
  if (hasLayeredDatabase && hasFlatDatabase) throw new Error('Zeus 同时存在分层与平铺数据库，已停止启动以避免选错数据源。');

  if (hasLayeredDatabase) {
    ensureLayeredDirectories(layered);
    // 正常分层目录已经完成过迁移校验；每次启动再全库 quick_check 会随历史数据线性变慢。
    // SQLite 打开、迁移和业务读写仍会显式报错，完整校验保留给迁移、维护与正式发布验证。
    return { status: 'already-layered', layout: layered, migrationManifestPath: null };
  }

  if (!hasFlatDatabase) {
    ensureLayeredDirectories(layered);
    return { status: 'initialized', layout: layered, migrationManifestPath: null };
  }

  if (executionHostIsRunning(flat.executionHost)) {
    return { status: 'legacy-host-active', layout: flat, migrationManifestPath: null };
  }

  return migrateFlatRoot({ flat, layered, legacyRoots });
}

function acquireDataRootPreparationLock(root: string): () => void {
  const lockPath = join(dirname(root), `.${basename(root)}.zeus-data-preparation.lock`);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + dataRootPreparationTimeoutMs;
  const ownerToken = randomUUID();

  while (Date.now() < deadline) {
    try {
      const fileDescriptor = openSync(lockPath, 'wx', 0o600);
      try {
        writeSync(
          fileDescriptor,
          JSON.stringify({
            pid: process.pid,
            root,
            ownerToken,
            startedAt: new Date().toISOString(),
          }),
        );
      } finally {
        closeSync(fileDescriptor);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; ownerToken?: unknown };
          if (owner.pid === process.pid && owner.ownerToken === ownerToken) unlinkSync(lockPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStaleDataRootPreparationLock(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      Atomics.wait(dataRootPreparationWaitBuffer, 0, 0, 50);
    }
  }

  throw new Error(`Zeus 数据根正在被另一个进程准备：${root}`);
}

function isStaleDataRootPreparationLock(lockPath: string): boolean {
  let lockStat;
  try {
    lockStat = statSync(lockPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }

  try {
    const owner = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown };
    if (typeof owner.pid === 'number' && Number.isInteger(owner.pid) && owner.pid > 0) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return false;
        return true;
      }
    }
  } catch {
    // 文件可能正处于写入阶段，先按时间窗口保护它，避免误删别的进程刚创建的锁。
  }

  return Date.now() - lockStat.mtimeMs > staleDataRootPreparationLockMs;
}

export function readLatestZeusDataMigrationManifest(rootPath: string): MigrationManifest | null {
  const layout = createZeusDataLayout(normalizeAbsolutePath(rootPath, 'Zeus 数据根目录'));
  if (!existsSync(layout.migrationState)) return null;
  const names = readdirSync(layout.migrationState)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of names) {
    try {
      const value = JSON.parse(readFileSync(join(layout.migrationState, name), 'utf8')) as MigrationManifest;
      if (value.schema === 1 && value.status === 'committed' && value.root === layout.root) return value;
    } catch {
      // 损坏或非本迁移器生成的文件不参与旧根回收判定。
    }
  }
  return null;
}

/**
 * 删除已由迁移清单逐文件确认镜像一致的旧根。
 * 该动作只提供给显式维护流程，应用启动不会自动调用。
 */
export function retireVerifiedLegacyRoot(rootPath: string, legacyRootPath: string): { removedBytes: number; removedFiles: number } {
  const root = normalizeAbsolutePath(rootPath, 'Zeus 数据根目录');
  const legacyRoot = normalizeAbsolutePath(legacyRootPath, 'Zeus 旧数据根目录');
  if (legacyRoot === root || isPathInside(legacyRoot, root) || isPathInside(root, legacyRoot)) throw new Error('Zeus 旧根与正式根存在包含关系，拒绝删除。');
  const layout = createZeusDataLayout(root);
  if (!existsSync(layout.database)) throw new Error('Zeus 分层数据库不存在，拒绝回收旧根。');
  if (executionHostIsRunning(layout.executionHost) || executionHostIsRunning(join(legacyRoot, 'execution-host'))) {
    throw new Error('Zeus 执行宿主仍在运行，拒绝回收旧根。');
  }
  assertDatabaseQuickCheck(layout.database);
  const manifest = readLatestZeusDataMigrationManifest(root);
  const validation = manifest?.validatedLegacyRoots.find((item) => item.root === legacyRoot);
  if (!validation || validation.managedPathCount <= 0) throw new Error('迁移清单没有该旧根的逐路径镜像校验证据，拒绝删除。');
  const db = new DatabaseSync(layout.database, { readOnly: true });
  try {
    const remaining = collectManagedPaths(db, [legacyRoot]);
    if (remaining.size > 0) throw new Error(`数据库仍有 ${remaining.size} 个旧根托管路径引用，拒绝删除。`);
  } finally {
    db.close();
  }
  if (!existsSync(legacyRoot)) return { removedBytes: 0, removedFiles: 0 };
  const inventory = inventoryTree(legacyRoot);
  const retiringPath = join(dirname(legacyRoot), `.${basename(legacyRoot)}.retiring-${randomUUID()}`);
  renameSync(legacyRoot, retiringPath);
  try {
    rmSync(retiringPath, { recursive: true, force: false, maxRetries: 2, retryDelay: 250 });
  } catch (error) {
    if (existsSync(retiringPath) && !existsSync(legacyRoot)) renameSync(retiringPath, legacyRoot);
    throw error;
  }
  const recordPath = join(layout.backupsDirectory, 'legacy-roots', `${fileTimestamp()}-${basename(legacyRoot)}.json`);
  mkdirSecure(dirname(recordPath));
  writeJsonFile(recordPath, {
    schema: 1,
    removedAt: new Date().toISOString(),
    legacyRoot,
    removedBytes: inventory.bytes,
    removedFiles: inventory.files,
    migrationManifestPath: join(layout.migrationState, `${manifest!.createdAt.replaceAll(':', '-')}-${manifest!.id}.json`),
  });
  return { removedBytes: inventory.bytes, removedFiles: inventory.files };
}

function migrateFlatRoot(input: { flat: ZeusDataLayout; layered: ZeusDataLayout; legacyRoots: readonly string[] }): ZeusDataPreparationResult {
  const { flat, layered } = input;
  const migrationId = randomUUID();
  const createdAt = new Date().toISOString();
  const moves: RecordedMove[] = [];
  const requestedLegacyRoots = [...new Set(input.legacyRoots.map((item) => resolve(item)).filter((item) => item !== flat.root))];
  checkpointAndCheckDatabase(flat.database);
  const database = new DatabaseSync(flat.database, { readOnly: true });
  let legacyValidations: LegacyRootValidation[];
  try {
    legacyValidations = requestedLegacyRoots.flatMap((legacyRoot) => {
      if (existsSync(legacyRoot)) return [validateLegacyRootMirror(database, legacyRoot, flat.root)];
      const managedPaths = [...collectManagedPaths(database, [legacyRoot])];
      if (managedPaths.length === 0) return [];
      return [validateRetiredLegacyRootRecovery(database, legacyRoot, flat.root, layered, managedPaths)];
    });
  } finally {
    database.close();
  }
  const normalizedLegacyRoots = legacyValidations.map((item) => item.root);

  mkdirSecure(layered.databaseBackups);
  const databaseBackupPath = join(layered.databaseBackups, `zeus.db.pre-layered-${fileTimestamp()}-${migrationId}.bak`);
  copyFileSync(flat.database, databaseBackupPath, 0);
  chmodSync(databaseBackupPath, 0o600);

  try {
    moveIfPresent(flat.database, layered.database, moves);
    moveIfPresent(`${flat.database}-wal`, `${layered.database}-wal`, moves);
    moveIfPresent(`${flat.database}-shm`, `${layered.database}-shm`, moves);
    moveIfPresent(flat.localConfig, layered.localConfig, moves);
    moveIfPresent(flat.localLogs, layered.localLogs, moves);
    moveIfPresent(flat.taskAttachments, layered.taskAttachments, moves);
    moveIfPresent(flat.conversationAttachments, layered.conversationAttachments, moves);
    moveIfPresent(flat.conversationAttachmentGrantSecret, layered.conversationAttachmentGrantSecret, moves);
    moveIfPresent(flat.browserComments, layered.browserComments, moves);
    moveIfPresent(flat.browserDownloads, layered.browserDownloads, moves);
    moveIfPresent(flat.browserState, layered.browserState, moves);
    moveIfPresent(flat.turnChangeSets, layered.turnChangeSets, moves);
    moveIfPresent(flat.runtimeSessions, layered.runtimeSessions, moves);
    moveIfPresent(flat.commandScripts, layered.commandScripts, moves);
    moveIfPresent(flat.commandRuns, layered.commandRuns, moves);
    moveIfPresent(flat.providersDirectory, layered.providersDirectory, moves);
    mergeDirectoryIfPresent(join(flat.root, 'pi-agent'), layered.piConfig, moves);
    mergeDirectoryIfPresent(join(flat.root, 'pi-sessions'), layered.piSessions, moves);
    moveIfPresent(join(flat.root, 'imports'), join(layered.backupsDirectory, 'imports'), moves);
    moveIfPresent(flat.codexLegacyImports, layered.codexLegacyImports, moves);
    moveIfPresent(flat.executionHost, layered.executionHost, moves);
    moveIfPresent(flat.releaseUpdates, layered.releaseUpdates, moves);
    for (const name of readdirSync(flat.root).filter((item) => /^zeus\.db\..*\.bak$/u.test(item))) {
      moveIfPresent(join(flat.root, name), join(layered.databaseBackups, name), moves);
    }
    for (const name of electronProfileEntries) moveIfPresent(join(flat.root, name), join(layered.electronUserData, name), moves);

    const remaining = readdirSync(flat.root).filter((name) => !structuredRootNames.has(name));
    if (remaining.length > 0) throw new Error(`Zeus 平铺根仍有未分类内容：${remaining.join('、')}`);
    ensureLayeredDirectories(layered);

    const mappings = buildPathMappings(flat, layered, normalizedLegacyRoots);
    const rewrittenRowCount = rebindDatabasePaths(layered.database, mappings);
    rewriteJsonFilePaths(layered.localConfig, mappings);
    checkpointAndCheckDatabase(layered.database);
    cleanupStaleExecutionHostFiles(layered.executionHost);
    const cleanup = cleanupSupersededBackups(layered, databaseBackupPath);

    const manifest: MigrationManifest = {
      schema: 1,
      id: migrationId,
      status: 'committed',
      createdAt,
      root: layered.root,
      databaseBackupPath,
      rewrittenRowCount,
      validatedLegacyRoots: legacyValidations,
      moves,
      cleanup,
    };
    const manifestPath = join(layered.migrationState, `${createdAt.replaceAll(':', '-')}-${migrationId}.json`);
    writeJsonFile(manifestPath, manifest);
    return { status: 'migrated', layout: layered, migrationManifestPath: manifestPath };
  } catch (error) {
    restoreMigration(databaseBackupPath, flat, layered, moves);
    throw error;
  }
}

function ensureLayeredDirectories(layout: ZeusDataLayout): void {
  const directories = [
    layout.dataDirectory,
    dirname(layout.localLogs),
    layout.artifactsDirectory,
    layout.providersDirectory,
    layout.backupsDirectory,
    layout.databaseBackups,
    layout.runtimeDirectory,
    layout.migrationState,
    layout.migrationQuarantine,
    layout.profileDirectory,
    layout.electronUserData,
    dirname(layout.browserState),
    layout.browserDownloads,
  ];
  for (const directory of directories) mkdirSecure(directory);
}

function buildPathMappings(flat: ZeusDataLayout, layered: ZeusDataLayout, legacyRoots: readonly string[]): PathMapping[] {
  const pairs: Array<[string, string]> = [
    [flat.taskAttachments, layered.taskAttachments],
    [flat.conversationAttachments, layered.conversationAttachments],
    [flat.browserComments, layered.browserComments],
    [flat.browserDownloads, layered.browserDownloads],
    [flat.turnChangeSets, layered.turnChangeSets],
    [flat.runtimeSessions, layered.runtimeSessions],
    [flat.commandScripts, layered.commandScripts],
    [flat.commandRuns, layered.commandRuns],
    [flat.codexHome, layered.codexHome],
    [flat.piConfig, layered.piConfig],
    [flat.piSessions, layered.piSessions],
    [join(flat.root, 'pi-agent'), layered.piConfig],
    [join(flat.root, 'pi-sessions'), layered.piSessions],
    [flat.codexLegacyImports, layered.codexLegacyImports],
    [flat.codexConfigImportBackups, layered.codexConfigImportBackups],
    [flat.executionHost, layered.executionHost],
    [flat.releaseUpdates, layered.releaseUpdates],
    [flat.localLogs, layered.localLogs],
    [flat.localConfig, layered.localConfig],
    [flat.database, layered.database],
  ];
  const mappings = pairs.map(([source, destination]) => ({ source: resolve(source), destination: resolve(destination) }));
  for (const legacyRoot of legacyRoots) {
    for (const mapping of [...mappings]) {
      if (!isPathInside(mapping.source, flat.root) && mapping.source !== flat.root) continue;
      mappings.push({ source: join(legacyRoot, relative(flat.root, mapping.source)), destination: mapping.destination });
    }
  }
  return mappings.sort((left, right) => right.source.length - left.source.length);
}

function rebindDatabasePaths(databasePath: string, mappings: readonly PathMapping[]): number {
  const db = new DatabaseSync(databasePath);
  let rewritten = 0;
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const [table, column] of directPathColumns) rewritten += rewriteDirectColumn(db, table, column, mappings);
    for (const [table, column] of jsonPathColumns) rewritten += rewriteJsonColumn(db, table, column, mappings);
    db.exec('COMMIT');
    assertDatabaseQuickCheckConnection(db);
    const remaining = collectManagedPaths(
      db,
      mappings.map((mapping) => mapping.source),
    );
    if (remaining.size > 0) throw new Error(`Zeus 路径重绑后仍有 ${remaining.size} 个托管字段指向旧位置。`);
    return rewritten;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 已提交后的校验失败由外层数据库备份负责恢复。
    }
    throw error;
  } finally {
    db.close();
  }
}

function rewriteDirectColumn(db: DatabaseSync, table: string, column: string, mappings: readonly PathMapping[]): number {
  if (!hasColumn(db, table, column)) return 0;
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const rows = db.prepare(`SELECT rowid AS migration_rowid, ${quotedColumn} AS value FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`).all() as Array<{
    migration_rowid: number | bigint;
    value: unknown;
  }>;
  const update = db.prepare(`UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?`);
  let rewritten = 0;
  for (const row of rows) {
    if (typeof row.value !== 'string') continue;
    const value = rewriteManagedPath(row.value, mappings);
    if (value === row.value) continue;
    assertRewrittenTargetExists(value);
    update.run(value, row.migration_rowid);
    rewritten += 1;
  }
  return rewritten;
}

function rewriteJsonColumn(db: DatabaseSync, table: string, column: string, mappings: readonly PathMapping[]): number {
  if (!hasColumn(db, table, column)) return 0;
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const rows = db.prepare(`SELECT rowid AS migration_rowid, ${quotedColumn} AS value FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`).all() as Array<{
    migration_rowid: number | bigint;
    value: unknown;
  }>;
  const update = db.prepare(`UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?`);
  let rewritten = 0;
  for (const row of rows) {
    if (typeof row.value !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      continue;
    }
    const result = rewriteJsonValue(parsed, mappings);
    if (!result.changed) continue;
    update.run(JSON.stringify(result.value), row.migration_rowid);
    rewritten += 1;
  }
  return rewritten;
}

function rewriteJsonValue(value: unknown, mappings: readonly PathMapping[]): { value: unknown; changed: boolean } {
  if (typeof value === 'string') {
    const rewritten = rewriteManagedPath(value, mappings);
    if (rewritten !== value) assertRewrittenTargetExists(rewritten);
    return { value: rewritten, changed: rewritten !== value };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const output = value.map((item) => {
      const result = rewriteJsonValue(item, mappings);
      changed ||= result.changed;
      return result.value;
    });
    return { value: changed ? output : value, changed };
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const result = rewriteJsonValue(item, mappings);
      changed ||= result.changed;
      output[key] = result.value;
    }
    return { value: changed ? output : value, changed };
  }
  return { value, changed: false };
}

function collectManagedPaths(db: DatabaseSync, roots: readonly string[]): Set<string> {
  const normalizedRoots = roots.map((item) => resolve(item));
  const output = new Set<string>();
  for (const [table, column] of directPathColumns) {
    if (!hasColumn(db, table, column)) continue;
    const rows = db.prepare(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`).all() as Array<{
      value: unknown;
    }>;
    for (const row of rows) if (typeof row.value === 'string' && isManagedPathString(row.value, normalizedRoots)) output.add(row.value);
  }
  for (const [table, column] of jsonPathColumns) {
    if (!hasColumn(db, table, column)) continue;
    const rows = db.prepare(`SELECT ${quoteIdentifier(column)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} IS NOT NULL`).all() as Array<{
      value: unknown;
    }>;
    for (const row of rows) {
      if (typeof row.value !== 'string') continue;
      try {
        collectJsonPaths(JSON.parse(row.value), normalizedRoots, output);
      } catch {
        // 非 JSON 历史值没有可安全重绑的结构化路径。
      }
    }
  }
  return output;
}

function collectJsonPaths(value: unknown, roots: readonly string[], output: Set<string>): void {
  if (typeof value === 'string') {
    if (isManagedPathString(value, roots)) output.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonPaths(item, roots, output);
    return;
  }
  if (value && typeof value === 'object') for (const item of Object.values(value)) collectJsonPaths(item, roots, output);
}

function validateLegacyRootMirror(db: DatabaseSync, legacyRoot: string, authoritativeRoot: string): LegacyRootValidation {
  if (executionHostIsRunning(join(legacyRoot, 'execution-host'))) throw new Error(`Zeus 旧根执行宿主仍在运行：${legacyRoot}`);
  const managedPaths = [...collectManagedPaths(db, [legacyRoot])];
  let fileCount = 0;
  let directoryCount = 0;
  let totalFileBytes = 0;
  let authoritativeOverrideCount = 0;
  for (const legacyPath of managedPaths) {
    const mirrorPath = join(authoritativeRoot, relative(legacyRoot, legacyPath));
    if (!existsSync(legacyPath) || !existsSync(mirrorPath)) throw new Error(`Zeus 旧根托管内容缺少镜像：${legacyPath}`);
    const legacyStat = statSync(legacyPath);
    const mirrorStat = statSync(mirrorPath);
    if (legacyStat.isDirectory() || mirrorStat.isDirectory()) {
      if (!legacyStat.isDirectory() || !mirrorStat.isDirectory()) throw new Error(`Zeus 旧根镜像类型不一致：${legacyPath}`);
      directoryCount += 1;
      continue;
    }
    const topLevel = relative(legacyRoot, legacyPath).split(sep)[0];
    if (!contentMirroredLegacyTopLevels.has(topLevel)) {
      authoritativeOverrideCount += 1;
      continue;
    }
    if (!legacyStat.isFile() || !mirrorStat.isFile() || legacyStat.size !== mirrorStat.size || hashFile(legacyPath) !== hashFile(mirrorPath)) {
      throw new Error(`Zeus 旧根镜像内容不一致：${legacyPath}`);
    }
    fileCount += 1;
    totalFileBytes += legacyStat.size;
  }
  return { root: legacyRoot, managedPathCount: managedPaths.length, fileCount, directoryCount, totalFileBytes, authoritativeOverrideCount, evidenceMode: 'live-mirror' };
}

/**
 * 处理“旧根已按已提交清单回收，但数据库回滚到迁移前快照”的恢复场景。
 * 旧根已经不存在时不能重新比较内容，只能复用原逐路径校验证据，并要求当前镜像集合完全一致。
 */
function validateRetiredLegacyRootRecovery(db: DatabaseSync, legacyRoot: string, authoritativeRoot: string, layered: ZeusDataLayout, managedPaths: readonly string[]): LegacyRootValidation {
  const evidence = readLegacyRootRetirementEvidence(layered, legacyRoot);
  if (!evidence) throw new Error(`Zeus 数据库仍引用已不存在的旧根，且缺少可信回收记录：${legacyRoot}`);
  const { validation } = evidence;
  if (managedPaths.length !== validation.managedPathCount) {
    throw new Error(`Zeus 已回收旧根的当前引用数为 ${managedPaths.length}，与原校验清单 ${validation.managedPathCount} 不一致，拒绝自动恢复。`);
  }
  if (validation.fileCount + validation.directoryCount + validation.authoritativeOverrideCount !== validation.managedPathCount) {
    throw new Error('Zeus 旧根原校验清单计数不闭合，拒绝自动恢复。');
  }
  for (const legacyPath of managedPaths) {
    const mirrorPath = join(authoritativeRoot, relative(legacyRoot, legacyPath));
    if (!existsSync(mirrorPath)) throw new Error(`Zeus 已回收旧根的当前镜像缺失：${mirrorPath}`);
  }
  // 再次从当前连接收集，防止调用方传入的集合与实际数据库漂移。
  if (collectManagedPaths(db, [legacyRoot]).size !== managedPaths.length) throw new Error('Zeus 已回收旧根的路径集合在校验期间发生变化。');
  return { ...validation, evidenceMode: 'retired-record' };
}

function readLegacyRootRetirementEvidence(
  layout: ZeusDataLayout,
  legacyRoot: string,
): {
  record: LegacyRootRetirementRecord;
  manifest: MigrationManifest;
  validation: LegacyRootValidation;
} | null {
  const recordDirectory = join(layout.backupsDirectory, 'legacy-roots');
  if (!existsSync(recordDirectory) || !existsSync(layout.migrationState)) return null;
  const recordNames = readdirSync(recordDirectory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .reverse();
  for (const name of recordNames) {
    try {
      const record = JSON.parse(readFileSync(join(recordDirectory, name), 'utf8')) as LegacyRootRetirementRecord;
      if (
        record.schema !== 1 ||
        record.legacyRoot !== legacyRoot ||
        typeof record.removedAt !== 'string' ||
        !Number.isFinite(record.removedBytes) ||
        record.removedBytes <= 0 ||
        !Number.isInteger(record.removedFiles) ||
        record.removedFiles <= 0 ||
        typeof record.migrationManifestPath !== 'string'
      ) {
        continue;
      }
      const manifestPath = resolve(record.migrationManifestPath);
      if (!isPathInside(manifestPath, layout.migrationState) || !existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as MigrationManifest;
      const expectedManifestPath = join(layout.migrationState, `${manifest.createdAt.replaceAll(':', '-')}-${manifest.id}.json`);
      const removedAt = Date.parse(record.removedAt);
      const createdAt = Date.parse(manifest.createdAt);
      if (manifest.schema !== 1 || manifest.status !== 'committed' || manifest.root !== layout.root || manifestPath !== expectedManifestPath || !Number.isFinite(removedAt) || !Number.isFinite(createdAt) || removedAt < createdAt) {
        continue;
      }
      const validation = manifest.validatedLegacyRoots.find((item) => item.root === legacyRoot);
      if (!validation || validation.managedPathCount <= 0) continue;
      return { record, manifest, validation };
    } catch {
      // 损坏或不完整的历史证据不参与已回收旧根恢复。
    }
  }
  return null;
}

function rewriteManagedPath(value: string, mappings: readonly PathMapping[]): string {
  if (
    !isManagedPathString(
      value,
      mappings.map((mapping) => mapping.source),
    )
  )
    return value;
  for (const mapping of mappings) {
    if (value === mapping.source) return mapping.destination;
    if (value.startsWith(`${mapping.source}${sep}`)) return join(mapping.destination, relative(mapping.source, value));
  }
  return value;
}

function rewriteJsonFilePaths(path: string, mappings: readonly PathMapping[]): void {
  if (!existsSync(path)) return;
  const original = readFileSync(path, 'utf8');
  const result = rewriteJsonValue(JSON.parse(original), mappings);
  if (!result.changed) return;
  writeFileSync(path, `${JSON.stringify(result.value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function moveIfPresent(source: string, destination: string, moves: RecordedMove[]): void {
  if (!pathEntryExists(source)) return;
  if (pathEntryExists(destination)) throw new Error(`Zeus 目录迁移遇到同名目标：${destination}`);
  mkdirSecure(dirname(destination));
  renameSync(source, destination);
  moves.push({ source, destination });
}

function mergeDirectoryIfPresent(source: string, destination: string, moves: RecordedMove[]): void {
  if (!pathEntryExists(source)) return;
  mkdirSecure(destination);
  for (const name of readdirSync(source)) {
    const sourceChild = join(source, name);
    const destinationChild = join(destination, name);
    if (lstatSync(sourceChild).isDirectory()) mergeDirectoryIfPresent(sourceChild, destinationChild, moves);
    else moveIfPresent(sourceChild, destinationChild, moves);
  }
  rmdirSync(source);
}

function restoreMigration(databaseBackupPath: string, flat: ZeusDataLayout, layered: ZeusDataLayout, moves: readonly RecordedMove[]): void {
  if (existsSync(layered.database) && existsSync(databaseBackupPath)) copyFileSync(databaseBackupPath, layered.database, 0);
  for (const move of [...moves].reverse()) {
    if (!pathEntryExists(move.destination) || pathEntryExists(move.source)) continue;
    mkdirSecure(dirname(move.source));
    renameSync(move.destination, move.source);
  }
  if (existsSync(flat.database) && existsSync(databaseBackupPath)) copyFileSync(databaseBackupPath, flat.database, 0);
}

function checkpointAndCheckDatabase(path: string): void {
  const db = new DatabaseSync(path);
  try {
    assertDatabaseQuickCheckConnection(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assertDatabaseQuickCheckConnection(db);
  } finally {
    db.close();
  }
}

function assertDatabaseQuickCheck(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assertDatabaseQuickCheckConnection(db);
  } finally {
    db.close();
  }
}

function assertDatabaseQuickCheckConnection(db: DatabaseSync): void {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: unknown }>;
  if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') throw new Error('Zeus 数据库完整性检查失败，已停止目录迁移。');
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const row = db.prepare('SELECT 1 AS present FROM sqlite_master WHERE type = ? AND name = ?').get('table', table) as { present?: unknown } | undefined;
  if (!row) return false;
  const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: unknown }>;
  return columns.some((item) => item.name === column);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function executionHostIsRunning(executionHostDirectory: string): boolean {
  try {
    const value = JSON.parse(readFileSync(join(executionHostDirectory, 'rendezvous.json'), 'utf8')) as { pid?: unknown };
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid) || value.pid <= 0) return false;
    process.kill(value.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleExecutionHostFiles(directory: string): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    if (name === 'rendezvous.json' || name === 'host.lock' || name.startsWith('bootstrap-') || name.startsWith('.rendezvous-')) {
      rmSync(join(directory, name), { force: true });
    }
  }
}

function cleanupSupersededBackups(
  layout: ZeusDataLayout,
  currentDatabaseBackupPath: string,
): {
  removedBytes: number;
  removedFiles: number;
  removedEntries: string[];
  failedEntries: string[];
} {
  const candidates: string[] = [];
  if (existsSync(layout.databaseBackups)) {
    for (const name of readdirSync(layout.databaseBackups)) {
      const path = join(layout.databaseBackups, name);
      if (path !== currentDatabaseBackupPath && name.endsWith('.bak')) candidates.push(path);
    }
  }
  if (existsSync(layout.codexConfigImportBackups)) {
    for (const transaction of readdirSync(layout.codexConfigImportBackups)) {
      const plugins = join(layout.codexConfigImportBackups, transaction, 'plugins');
      for (const generatedEntry of ['.plugin-appserver', '.remote-plugin-install-staging', '.tmp', 'cache', '.DS_Store']) {
        candidates.push(join(plugins, generatedEntry));
      }
    }
  }

  let removedBytes = 0;
  let removedFiles = 0;
  const removedEntries: string[] = [];
  const failedEntries: string[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    try {
      const inventory = inventoryTree(path);
      rmSync(path, { recursive: true, force: false, maxRetries: 2, retryDelay: 250 });
      removedBytes += inventory.bytes;
      removedFiles += inventory.files;
      removedEntries.push(relative(layout.root, path));
    } catch {
      failedEntries.push(relative(layout.root, path));
    }
  }
  return { removedBytes, removedFiles, removedEntries, failedEntries };
}

function assertRewrittenTargetExists(path: string): void {
  if (!existsSync(path)) throw new Error(`Zeus 路径重绑后的目标不存在：${path}`);
}

function matchesRoot(value: string, roots: readonly string[]): boolean {
  return roots.some((root) => value === root || value.startsWith(`${root}${sep}`));
}

function isManagedPathString(value: string, roots: readonly string[]): boolean {
  if (value.length === 0 || value.length > 8_192 || value.includes('\n') || value.includes('\r') || value.includes('\0') || !isAbsolute(value)) return false;
  return matchesRoot(value, roots);
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function inventoryTree(root: string): { bytes: number; files: number } {
  const stat = lstatSync(root);
  if (!stat.isDirectory()) return { bytes: stat.size, files: 1 };
  let bytes = 0;
  let files = 0;
  for (const name of readdirSync(root)) {
    const child = inventoryTree(join(root, name));
    bytes += child.bytes;
    files += child.files;
  }
  return { bytes, files };
}

function mkdirSecure(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSecure(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}必须是绝对路径。`);
  return resolve(path);
}

function isPathInside(path: string, root: string): boolean {
  const nested = relative(root, path);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function fileTimestamp(): string {
  return new Date()
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/u, 'Z');
}
