import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

const defaultDatabasePerformanceCapacity = 4_096;
const databaseTraceIdPattern = /^[A-Za-z0-9_-]{8,80}$/u;
const databasePerformanceTrace = new AsyncLocalStorage<{ traceId: string }>();

export type DatabasePerformanceOperation = 'select' | 'execute' | 'commit' | 'checkpoint' | 'transaction';

export interface DatabasePerformanceSample {
  traceId: string | null;
  operation: DatabasePerformanceOperation;
  statementKind: string;
  statementTarget: string | null;
  sqlFingerprint: string | null;
  durationMs: number;
  returnedOrChangedRows: number | null;
  scannedRows: null;
  success: boolean;
  completedAt: string;
}

/**
 * 把当前异步请求的无正文 trace identity 传给 SQLite 观测器。
 * Fastify 每个 request 拥有独立 async resource；后续同步与异步 Repository 调用会继承该身份。
 */
export function enterDatabasePerformanceTrace(traceId: string): void {
  if (!databaseTraceIdPattern.test(traceId)) throw new Error('Database performance trace identity is invalid.');
  databasePerformanceTrace.enterWith({ traceId });
}

/** 便于 Worker/行为探针在显式作用域内传递 trace，不保留请求正文。 */
export function runWithDatabasePerformanceTrace<T>(traceId: string, operation: () => T): T {
  if (!databaseTraceIdPattern.test(traceId)) throw new Error('Database performance trace identity is invalid.');
  return databasePerformanceTrace.run({ traceId }, operation);
}

export interface DatabasePerformanceStorageSnapshot {
  databaseFileBytes: number | null;
  walFileBytes: number | null;
  sharedMemoryFileBytes: number | null;
  pageCount: number;
  pageSizeBytes: number;
  freePageCount: number;
  logicalDatabaseBytes: number;
}

export interface DatabasePerformanceSnapshot {
  capacity: number;
  capturedSampleCount: number;
  generatedAt: string;
  operations: Array<{
    operation: string;
    sampleCount: number;
    failedCount: number;
    durationMs: { p50: number; p95: number; p99: number; max: number };
    returnedOrChangedRows: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
  }>;
  recent: DatabasePerformanceSample[];
  storage: DatabasePerformanceStorageSnapshot;
  scanEvidence: {
    runtimeScannedRowsAvailable: false;
    reason: 'node_sqlite_statement_scan_status_unavailable';
    offlineQueryPlanGate: 'scripts/verify-conversation-query-plans.ts';
  };
}

/**
 * SQLite 热路径的有界、无正文观测器。
 *
 * SQL 只保存不可逆指纹、语句类型与 schema 标识符，不保存参数、正文或路径。
 * Node `node:sqlite` 当前不公开 sqlite3_stmt_status，因此运行时扫描行数必须明确为 null；
 * 全表扫描由只读 EXPLAIN 门禁核对，禁止用返回行数伪装扫描行数。
 */
export class DatabasePerformanceCollector {
  private readonly samples: DatabasePerformanceSample[] = [];

  constructor(
    private readonly databasePath: string,
    private readonly capacity = defaultDatabasePerformanceCapacity,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Database performance capacity must be a positive integer.');
  }

  measureSql<T>(operation: Extract<DatabasePerformanceOperation, 'select' | 'execute'>, sql: string, run: () => T, rowCount?: (result: T) => number | null): T {
    const startedAt = performance.now();
    const traceId = currentDatabasePerformanceTraceId();
    let succeeded = false;
    let result: T | undefined;
    try {
      result = run();
      succeeded = true;
      return result;
    } finally {
      const identity = sqlIdentity(sql);
      let returnedOrChangedRows: number | null = null;
      if (succeeded && result !== undefined && rowCount) {
        try {
          returnedOrChangedRows = normalizeRowCount(rowCount(result));
        } catch {
          returnedOrChangedRows = null;
        }
      }
      this.append({
        traceId,
        operation,
        statementKind: identity.kind,
        statementTarget: identity.target,
        sqlFingerprint: identity.fingerprint,
        durationMs: roundMetric(performance.now() - startedAt),
        returnedOrChangedRows,
        scannedRows: null,
        success: succeeded,
        completedAt: new Date().toISOString(),
      });
    }
  }

  measureOperation<T>(operation: Exclude<DatabasePerformanceOperation, 'select' | 'execute'>, run: () => T): T {
    const startedAt = performance.now();
    const traceId = currentDatabasePerformanceTraceId();
    let succeeded = false;
    try {
      const result = run();
      succeeded = true;
      return result;
    } finally {
      this.append({
        traceId,
        operation,
        statementKind: operation,
        statementTarget: null,
        sqlFingerprint: null,
        durationMs: roundMetric(performance.now() - startedAt),
        returnedOrChangedRows: null,
        scannedRows: null,
        success: succeeded,
        completedAt: new Date().toISOString(),
      });
    }
  }

  snapshot(sqlite: { pageCount: number; pageSizeBytes: number; freePageCount: number }, options: { recentLimit?: number } = {}): DatabasePerformanceSnapshot {
    const grouped = new Map<string, DatabasePerformanceSample[]>();
    for (const sample of this.samples) {
      const key = [sample.operation, sample.statementKind, sample.statementTarget ?? '-', sample.sqlFingerprint ?? '-'].join(':');
      const entries = grouped.get(key);
      if (entries) entries.push(sample);
      else grouped.set(key, [sample]);
    }
    const operations = [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([operation, entries]) => {
        const durations = entries.map((entry) => entry.durationMs).sort((left, right) => left - right);
        const rows = entries.flatMap((entry) => (entry.returnedOrChangedRows === null ? [] : [entry.returnedOrChangedRows])).sort((left, right) => left - right);
        return {
          operation,
          sampleCount: entries.length,
          failedCount: entries.filter((entry) => !entry.success).length,
          durationMs: summarizeNumbers(durations),
          returnedOrChangedRows: rows.length > 0 ? summarizeNumbers(rows) : { p50: null, p95: null, p99: null, max: null },
        };
      });
    const recentLimit = clampInteger(options.recentLimit ?? 100, 0, 500);
    return {
      capacity: this.capacity,
      capturedSampleCount: this.samples.length,
      generatedAt: new Date().toISOString(),
      operations,
      recent: recentLimit === 0 ? [] : this.samples.slice(-recentLimit).reverse(),
      storage: {
        databaseFileBytes: fileSize(this.databasePath),
        walFileBytes: fileSize(`${this.databasePath}-wal`),
        sharedMemoryFileBytes: fileSize(`${this.databasePath}-shm`),
        pageCount: sqlite.pageCount,
        pageSizeBytes: sqlite.pageSizeBytes,
        freePageCount: sqlite.freePageCount,
        logicalDatabaseBytes: sqlite.pageCount * sqlite.pageSizeBytes,
      },
      scanEvidence: {
        runtimeScannedRowsAvailable: false,
        reason: 'node_sqlite_statement_scan_status_unavailable',
        offlineQueryPlanGate: 'scripts/verify-conversation-query-plans.ts',
      },
    };
  }

  private append(sample: DatabasePerformanceSample): void {
    this.samples.push(sample);
    if (this.samples.length > this.capacity) this.samples.splice(0, this.samples.length - this.capacity);
  }
}

export function currentDatabasePerformanceTraceId(): string | null {
  return databasePerformanceTrace.getStore()?.traceId ?? null;
}

function sqlIdentity(sql: string): { kind: string; target: string | null; fingerprint: string } {
  const compact = sql.replace(/\s+/gu, ' ').trim();
  const kind = /^([A-Za-z]+)/u.exec(compact)?.[1]?.toUpperCase() ?? 'UNKNOWN';
  const targetMatch =
    /^(?:SELECT|WITH)\b[\s\S]*?\bFROM\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(compact) ??
    /^(?:INSERT|REPLACE)(?:\s+OR\s+[A-Za-z]+)?\s+INTO\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(compact) ??
    /^UPDATE\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(compact) ??
    /^DELETE\s+FROM\s+["`[]?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(compact) ??
    /^(?:CREATE|DROP|ALTER)\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`[]?([A-Za-z_][A-Za-z0-9_]*)/iu.exec(compact);
  return {
    kind,
    target: targetMatch?.[1] ?? null,
    fingerprint: createHash('sha256').update(compact).digest('hex').slice(0, 24),
  };
}

function fileSize(path: string): number | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats.size : null;
  } catch {
    return null;
  }
}

function normalizeRowCount(value: number | null): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function summarizeNumbers(values: number[]): { p50: number; p95: number; p99: number; max: number } {
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: roundMetric(values.at(-1) ?? 0),
  };
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return roundMetric(sortedValues[index] ?? 0);
}

function roundMetric(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
