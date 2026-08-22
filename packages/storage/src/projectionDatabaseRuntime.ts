import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  createProjectionCacheCandidate,
  createProjectionIndexCandidate,
  projectionCacheCandidateGeneration,
  projectionIndexCandidateGeneration,
  verifyProjectionDatabaseCandidate,
  type ProjectionDatabaseCandidateReceipt,
} from './projectionDatabaseCandidate.js';
import type { ZeusDatabasePort } from './databasePort.js';

export type ProjectionDatabaseKind = 'index' | 'cache';
export type ProjectionDatabaseAvailability = 'ready' | 'rebuilding' | 'unavailable' | 'closed';

export interface ProjectionDatabaseRuntimeState {
  kind: ProjectionDatabaseKind;
  availability: ProjectionDatabaseAvailability;
  activePath: string;
  generationId: string | null;
  structureGeneration: string;
  sourceDatabaseIdentity: string;
  eventWaterline: number;
  pendingWrites: number;
  rebuildScheduled: boolean;
  previousAvailable: boolean;
  lastError: string | null;
  activatedAt: string | null;
}

export interface ProjectionDatabaseReadPort {
  get<T>(sql: string, params?: SQLInputValue[]): T | undefined;
  select<T>(sql: string, params?: SQLInputValue[]): T[];
  countRows(tableName: string): number;
}

export interface ProjectionDatabaseWritePort extends ProjectionDatabaseReadPort {
  execute(sql: string, params?: SQLInputValue[]): void;
}

export interface ProjectionDatabaseRuntimeOptions {
  source: ZeusDatabasePort;
  directory: string;
  sourceDatabaseIdentity: string;
  now?: () => string;
  onDiagnostic?: (state: ProjectionDatabaseRuntimeState) => void;
  /** 只供候选切换故障演练；产品运行时不得配置。 */
  faultInjection?: { beforeCandidatePublish(kind: ProjectionDatabaseKind): void | Promise<void> };
}

interface ProjectionMetadataRow {
  structure_generation: string;
  generation_id: string;
  source_database_identity: string;
  publication_state: string;
  event_waterline: number;
  activated_at: string | null;
}

interface RuntimeSlot {
  database: DatabaseSync | null;
  queue: Promise<void>;
  state: ProjectionDatabaseRuntimeState;
  rebuilding: boolean;
}

/**
 * index.db/cache.db 的独立运行时边界。
 *
 * 两个库各自拥有串行写队列和 generation/waterline；读取失败只降级该投影，
 * 不会把 Core SQLite 置为故障态。候选验证、同目录切换和 previous 回退均在关闭句柄后执行。
 */
export class ProjectionDatabaseRuntimeManager {
  readonly index: ProjectionDatabaseReadPort;
  readonly cache: ProjectionDatabaseReadPort;
  private readonly directory: string;
  private readonly now: () => string;
  private readonly slots: Record<ProjectionDatabaseKind, RuntimeSlot>;
  private closed = false;

  constructor(private readonly options: ProjectionDatabaseRuntimeOptions) {
    this.directory = resolve(options.directory);
    this.now = options.now ?? (() => new Date().toISOString());
    this.slots = {
      index: this.createSlot('index'),
      cache: this.createSlot('cache'),
    };
    this.index = this.createReadPort('index');
    this.cache = this.createReadPort('cache');
  }

  async start(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const kind of ['index', 'cache'] as const) {
      try {
        if (!(await pathExists(this.activePath(kind)))) throw new Error(`${kind}.db 不存在，已进入后台重建。`);
        this.openActive(kind);
      } catch (error) {
        this.degrade(kind, error, false);
        this.scheduleRebuild(kind);
      }
    }
  }

  snapshot(): { index: ProjectionDatabaseRuntimeState; cache: ProjectionDatabaseRuntimeState } {
    return { index: { ...this.slots.index.state }, cache: { ...this.slots.cache.state } };
  }

  enqueueIndexWrite<T>(operation: (database: ProjectionDatabaseWritePort) => T): Promise<T> {
    return this.enqueueWrite('index', operation);
  }

  enqueueCacheWrite<T>(operation: (database: ProjectionDatabaseWritePort) => T): Promise<T> {
    return this.enqueueWrite('cache', operation);
  }

  async putCache(input: { namespace: string; key: string; payload: Uint8Array; expiresAt: string }): Promise<void> {
    await this.enqueueCacheWrite((database) => {
      const generationId = this.requireReadyState('cache').generationId!;
      database.execute(
        `INSERT INTO cache_entries (namespace, cache_key, generation_id, payload, byte_length, expires_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(namespace, cache_key, generation_id) DO UPDATE SET
           payload = excluded.payload, byte_length = excluded.byte_length,
           expires_at = excluded.expires_at, last_accessed_at = excluded.last_accessed_at`,
        [boundedIdentity(input.namespace, 'namespace'), boundedIdentity(input.key, 'key'), generationId, input.payload, input.payload.byteLength, validTimestamp(input.expiresAt), this.now()],
      );
    });
  }

  getCache(namespace: string, key: string, at = this.now()): Uint8Array | undefined {
    const generationId = this.slots.cache.state.generationId;
    if (!generationId) return undefined;
    const row = this.cache.get<{ payload: Uint8Array }>(
      `SELECT payload FROM cache_entries
        WHERE namespace = ? AND cache_key = ? AND generation_id = ? AND expires_at > ?`,
      [boundedIdentity(namespace, 'namespace'), boundedIdentity(key, 'key'), generationId, validTimestamp(at)],
    );
    return row?.payload;
  }

  async rebuild(kind: ProjectionDatabaseKind): Promise<ProjectionDatabaseRuntimeState> {
    const slot = this.slots[kind];
    if (slot.rebuilding) return { ...slot.state };
    slot.rebuilding = true;
    slot.state.availability = 'rebuilding';
    slot.state.rebuildScheduled = false;
    this.publish(kind);
    const generationId = `${kind}-${randomUUID()}`;
    const candidatePath = join(this.directory, `${generationId}.${kind}.candidate.db`);
    try {
      const receipt =
        kind === 'index'
          ? await createProjectionIndexCandidate({
              source: this.options.source,
              candidatePath,
              generationId,
              sourceDatabaseIdentity: this.options.sourceDatabaseIdentity,
              createdAt: this.now(),
            })
          : await createProjectionCacheCandidate({
              candidatePath,
              generationId,
              sourceDatabaseIdentity: this.options.sourceDatabaseIdentity,
              createdAt: this.now(),
            });
      await this.promote(receipt);
      return { ...slot.state };
    } catch (error) {
      this.degrade(kind, error, false);
      throw error;
    } finally {
      slot.rebuilding = false;
      slot.state.rebuildScheduled = false;
      this.publish(kind);
    }
  }

  async promote(receipt: ProjectionDatabaseCandidateReceipt): Promise<ProjectionDatabaseRuntimeState> {
    await verifyProjectionDatabaseCandidate(receipt);
    const kind = receipt.candidateKind;
    if (resolve(receipt.candidatePath) === this.activePath(kind) || resolve(receipt.candidatePath) === this.previousPath(kind)) {
      throw new Error('投影候选路径不能与 active/previous 路径相同。');
    }
    return this.enqueue(kind, async () => {
      const slot = this.slots[kind];
      const activePath = this.activePath(kind);
      const previousPath = this.previousPath(kind);
      this.closeSlotDatabase(kind);
      let hadActive = false;
      let activeMoved = false;
      let candidateActivated = false;
      let candidatePublished = false;
      try {
        await safeUnlink(previousPath);
        hadActive = await pathExists(activePath);
        if (hadActive) {
          await rename(activePath, previousPath);
          activeMoved = true;
        }
        activateCandidate(receipt, this.now());
        candidateActivated = true;
        await this.options.faultInjection?.beforeCandidatePublish(kind);
        await rename(resolve(receipt.candidatePath), activePath);
        candidatePublished = true;
        this.openActive(kind);
        slot.state.previousAvailable = hadActive;
        this.publish(kind);
        return { ...slot.state };
      } catch (error) {
        this.closeSlotDatabase(kind);
        if (candidatePublished) await safeUnlink(activePath);
        else if (candidateActivated) await safeUnlink(resolve(receipt.candidatePath));
        if (activeMoved && (await pathExists(previousPath))) await rename(previousPath, activePath);
        try {
          if (hadActive || (await pathExists(activePath))) this.openActive(kind);
          else this.degrade(kind, error, false);
        } catch (rollbackError) {
          this.degrade(kind, new AggregateError([error, rollbackError], '投影候选切换与回退重开均失败。'), false);
        }
        throw error;
      }
    });
  }

  async rollback(kind: ProjectionDatabaseKind): Promise<ProjectionDatabaseRuntimeState> {
    return this.enqueue(kind, async () => {
      const activePath = this.activePath(kind);
      const previousPath = this.previousPath(kind);
      if (!(await pathExists(previousPath))) throw new Error(`${kind}.db 没有可回退 previous generation。`);
      this.closeSlotDatabase(kind);
      const rejectedPath = `${activePath}.rejected-${randomUUID()}`;
      if (await pathExists(activePath)) await rename(activePath, rejectedPath);
      try {
        await rename(previousPath, activePath);
        this.openActive(kind);
        await safeUnlink(rejectedPath);
        this.slots[kind].state.previousAvailable = false;
        this.publish(kind);
        return { ...this.slots[kind].state };
      } catch (error) {
        if (await pathExists(rejectedPath)) await rename(rejectedPath, activePath);
        this.openActive(kind);
        throw error;
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([this.slots.index.queue, this.slots.cache.queue]);
    for (const kind of ['index', 'cache'] as const) {
      this.closeSlotDatabase(kind);
      this.slots[kind].state.availability = 'closed';
      this.publish(kind);
    }
  }

  private createSlot(kind: ProjectionDatabaseKind): RuntimeSlot {
    return {
      database: null,
      queue: Promise.resolve(),
      rebuilding: false,
      state: {
        kind,
        availability: 'unavailable',
        activePath: this.activePath(kind),
        generationId: null,
        structureGeneration: expectedStructureGeneration(kind),
        sourceDatabaseIdentity: this.options.sourceDatabaseIdentity,
        eventWaterline: 0,
        pendingWrites: 0,
        rebuildScheduled: false,
        previousAvailable: false,
        lastError: null,
        activatedAt: null,
      },
    };
  }

  private createReadPort(kind: ProjectionDatabaseKind): ProjectionDatabaseReadPort {
    return {
      get: <T>(sql: string, params: SQLInputValue[] = []): T | undefined =>
        this.read(
          kind,
          () =>
            this.requireDatabase(kind)
              .prepare(sql)
              .get(...params) as T | undefined,
          undefined,
        ),
      select: <T>(sql: string, params: SQLInputValue[] = []): T[] =>
        this.read(
          kind,
          () =>
            this.requireDatabase(kind)
              .prepare(sql)
              .all(...params) as unknown as T[],
          [],
        ),
      countRows: (tableName: string): number => {
        if (!/^[a-z][a-z0-9_]*$/u.test(tableName)) throw new Error('投影表名格式无效。');
        return this.read(kind, () => Number((this.requireDatabase(kind).prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number | bigint }).count), 0);
      },
    };
  }

  private enqueueWrite<T>(kind: ProjectionDatabaseKind, operation: (database: ProjectionDatabaseWritePort) => T): Promise<T> {
    return this.enqueue(kind, () => {
      const database = this.requireDatabase(kind);
      const port = createWritePort(database);
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation(port);
        const metadataTable = kind === 'index' ? 'projection_metadata' : 'cache_metadata';
        database.exec(`UPDATE ${metadataTable} SET event_waterline = event_waterline + 1 WHERE singleton = 1`);
        database.exec('COMMIT');
        this.refreshState(kind);
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    });
  }

  private enqueue<T>(kind: ProjectionDatabaseKind, operation: () => T | Promise<T>): Promise<T> {
    const slot = this.slots[kind];
    slot.state.pendingWrites += 1;
    this.publish(kind);
    const result = slot.queue.then(operation);
    slot.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      slot.state.pendingWrites = Math.max(0, slot.state.pendingWrites - 1);
      this.publish(kind);
    });
  }

  private read<T>(kind: ProjectionDatabaseKind, operation: () => T, fallback: T): T {
    if (!this.slots[kind].database) return fallback;
    try {
      return operation();
    } catch (error) {
      this.degrade(kind, error, true);
      return fallback;
    }
  }

  private openActive(kind: ProjectionDatabaseKind): void {
    const path = this.activePath(kind);
    const database = new DatabaseSync(path);
    try {
      configureRuntimeDatabase(database);
      assertQuickCheck(database, `${kind}.db`);
      const row = readMetadata(database, kind);
      if (row.publication_state !== 'active' || row.structure_generation !== expectedStructureGeneration(kind) || row.source_database_identity !== this.options.sourceDatabaseIdentity) {
        throw new Error(`${kind}.db generation/source/publication_state 不符合运行时契约。`);
      }
      this.slots[kind].database = database;
      this.slots[kind].state = {
        ...this.slots[kind].state,
        availability: 'ready',
        generationId: row.generation_id,
        eventWaterline: row.event_waterline,
        previousAvailable: false,
        lastError: null,
        activatedAt: row.activated_at,
      };
      this.publish(kind);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private refreshState(kind: ProjectionDatabaseKind): void {
    const row = readMetadata(this.requireDatabase(kind), kind);
    this.slots[kind].state.generationId = row.generation_id;
    this.slots[kind].state.eventWaterline = row.event_waterline;
    this.slots[kind].state.activatedAt = row.activated_at;
    this.publish(kind);
  }

  private degrade(kind: ProjectionDatabaseKind, error: unknown, schedule: boolean): void {
    this.closeSlotDatabase(kind);
    const slot = this.slots[kind];
    slot.state.availability = 'unavailable';
    slot.state.generationId = null;
    slot.state.lastError = error instanceof Error ? error.message : String(error);
    this.publish(kind);
    if (schedule) this.scheduleRebuild(kind);
  }

  private scheduleRebuild(kind: ProjectionDatabaseKind): void {
    if (this.closed || this.slots[kind].rebuilding || this.slots[kind].state.rebuildScheduled) return;
    this.slots[kind].state.rebuildScheduled = true;
    this.publish(kind);
    queueMicrotask(() => {
      if (this.closed) return;
      void this.rebuild(kind).catch(() => undefined);
    });
  }

  private closeSlotDatabase(kind: ProjectionDatabaseKind): void {
    const database = this.slots[kind]?.database;
    this.slots[kind].database = null;
    if (!database) return;
    try {
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 独立投影已进入降级路径时，关闭优先于保留 WAL 诊断。
    }
    database.close();
  }

  private requireDatabase(kind: ProjectionDatabaseKind): DatabaseSync {
    const database = this.slots[kind].database;
    if (!database) throw new Error(`${kind}.db 当前不可用；Core 业务仍可继续。`);
    return database;
  }

  private requireReadyState(kind: ProjectionDatabaseKind): ProjectionDatabaseRuntimeState {
    const state = this.slots[kind].state;
    if (state.availability !== 'ready' || !state.generationId) throw new Error(`${kind}.db 当前不可用；Core 业务仍可继续。`);
    return state;
  }

  private activePath(kind: ProjectionDatabaseKind): string {
    return join(this.directory, `${kind}.db`);
  }

  private previousPath(kind: ProjectionDatabaseKind): string {
    return join(this.directory, `${kind}.previous.db`);
  }

  private publish(kind: ProjectionDatabaseKind): void {
    this.options.onDiagnostic?.({ ...this.slots[kind].state });
  }
}

function createWritePort(database: DatabaseSync): ProjectionDatabaseWritePort {
  return {
    execute(sql, params = []) {
      if (params.length === 0) database.exec(sql);
      else database.prepare(sql).run(...params);
    },
    get<T>(sql: string, params: SQLInputValue[] = []): T | undefined {
      return database.prepare(sql).get(...params) as T | undefined;
    },
    select<T>(sql: string, params: SQLInputValue[] = []): T[] {
      return database.prepare(sql).all(...params) as unknown as T[];
    },
    countRows(tableName: string): number {
      if (!/^[a-z][a-z0-9_]*$/u.test(tableName)) throw new Error('投影表名格式无效。');
      return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number | bigint }).count);
    },
  };
}

function configureRuntimeDatabase(database: DatabaseSync): void {
  database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA wal_autocheckpoint = 1000;');
}

function readMetadata(database: DatabaseSync, kind: ProjectionDatabaseKind): ProjectionMetadataRow {
  const table = kind === 'index' ? 'projection_metadata' : 'cache_metadata';
  const row = database.prepare(`SELECT structure_generation, generation_id, source_database_identity, publication_state, event_waterline, activated_at FROM ${table} WHERE singleton = 1`).get() as ProjectionMetadataRow | undefined;
  if (!row) throw new Error(`${kind}.db 缺少运行时 metadata。`);
  return row;
}

function activateCandidate(receipt: ProjectionDatabaseCandidateReceipt, activatedAt: string): void {
  const database = new DatabaseSync(resolve(receipt.candidatePath));
  try {
    const table = receipt.candidateKind === 'index' ? 'projection_metadata' : 'cache_metadata';
    database.exec('BEGIN IMMEDIATE');
    database.prepare(`UPDATE ${table} SET publication_state = 'active', activated_at = ? WHERE singleton = 1 AND publication_state = 'candidate_only'`).run(activatedAt);
    database.exec('COMMIT');
    assertQuickCheck(database, `${receipt.candidateKind}.db 激活候选`);
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // 没有活跃事务时忽略；原始激活错误必须保留。
    }
    throw error;
  } finally {
    database.close();
  }
}

function assertQuickCheck(database: DatabaseSync, label: string): void {
  const values = (database.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>).flatMap((row) => Object.values(row)).map(String);
  if (values.length !== 1 || values[0] !== 'ok') throw new Error(`${label} quick_check 失败：${values.join('; ')}`);
}

function expectedStructureGeneration(kind: ProjectionDatabaseKind): string {
  return kind === 'index' ? projectionIndexCandidateGeneration : projectionCacheCandidateGeneration;
}

function boundedIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error(`${field} 无效。`);
  return normalized;
}

function validTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error('时间戳无效。');
  return new Date(value).toISOString();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
