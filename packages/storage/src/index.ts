import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, lstatSync, realpathSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import type { ReadOnlyValidationDescriptor, TokenUsageBreakdown } from '@zeus/shared';
import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type SqlValue as SqlJsValue } from 'sql.js';
import { migrateCommandCenterSchema } from './commands.js';
import { migrateArtifactStoreSchema } from './artifactStore.js';
import { migrateColdEvidenceSchema } from './coldEvidenceStore.js';
import { migrateCommandDeliverySchema } from './commandDeliveryStore.js';
import { CONVERSATION_HOT_QUERY_INDEX_CHECKSUM_SOURCE, CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID, conversationHotQueryIndexes } from './conversationHotQueryIndexes.js';
import { migrateUnifiedConversationStoreSchema } from './conversationExecutionStore.js';
import { migrateConversationLegacyCutoverSchema } from './conversationLegacyCutover.js';
import { migrateCompletedProviderPlansToConversationHistory, migrateConversationProviderItemStoreSchema } from './conversationProviderItemStore.js';
import { migrateConversationSyncEventStoreSchema } from './conversationSyncEventStore.js';
import { DatabasePerformanceCollector, type DatabasePerformanceSnapshot } from './databasePerformance.js';
import { migrateExecutionHostHandoffSchema } from './executionHostHandoffStore.js';
import { migrateExecutionHostWorkSchema } from './executionHostWorkStore.js';
import { migrateLongTermMemorySchema } from './longTermMemoryStore.js';
import { migrateTaskEventFileProjectionSchema } from './taskEventFileProjectionStore.js';
import type { SqlValue, ZeusDatabasePort } from './databasePort.js';
import { deriveConversationStageProjection, isPlainRecord, ProviderEventReceiptRepository, subtractTokenUsageBreakdown, validateTokenUsageBreakdown, type DbCodexUsageLedgerRow } from './conversationStore.js';

export * from './commands.js';
export * from './artifactStore.js';
export * from './artifactRetentionLifecycle.js';
export * from './coldEvidenceStore.js';
export * from './commandDeliveryStore.js';
export * from './databasePerformance.js';
export * from './databasePort.js';
export * from './executionHostHandoffStore.js';
export * from './executionHostWorkStore.js';
export * from './conversationHotQueryIndexes.js';
export * from './conversationItemTypes.js';
export * from './conversationExecutionStore.js';
export * from './conversationLegacyReconciliation.js';
export * from './conversationLegacyCutover.js';
export * from './conversationProviderItemStore.js';
export * from './conversationSnapshotV2.js';
export * from './conversationSyncEventStore.js';
export * from './longTermMemoryStore.js';
export * from './taskEventFileProjectionStore.js';
export * from './projectionDatabaseCandidate.js';
export * from './projectionDatabaseRuntime.js';
export * from './recoveryBackup.js';
export * from './recoveryBackupRetention.js';
export * from './recoveryCandidatePromotion.js';
export * from './tableOwnership.js';
export * from './recoveryBackupReplication.js';
export * from './workManagementStore.js';
export * from './runtimeSessionStore.js';
export * from './conversationStore.js';
export * from './turnChangeStore.js';
export * from './auditStore.js';

const builtInTaskTemplates = [
  {
    id: 'task_template_requirement_analysis',
    sortOrder: 1,
    name: '需求分析',
    description: '澄清真实需求、业务规则、边界与验收标准。',
    promptTemplate: '请基于 {{project_context}} 分析需求：{{requirement}}，输出业务规则、边界场景和验收标准。',
  },
  {
    id: 'task_template_code_implementation',
    sortOrder: 2,
    name: '代码实现',
    description: '根据已确认方案实现真实代码变更并补充验证。',
    promptTemplate: '请在 {{project_path}} 按设计实现：{{implementation_goal}}，并说明影响范围与验证方式。',
  },
  {
    id: 'task_template_bug_fix',
    sortOrder: 3,
    name: 'Bug 修复',
    description: '定位真实缺陷、补充回归验证并修复。',
    promptTemplate: '请复现并修复缺陷：{{bug_report}}，给出根因、修法、静态检查和真实运行验证结果。',
  },
  {
    id: 'task_template_code_review',
    sortOrder: 4,
    name: '代码评审',
    description: '审查真实变更的正确性、风险和可维护性。',
    promptTemplate: '请审查以下真实变更：{{diff_context}}，重点关注正确性、风险、验证缺口和回滚建议。',
  },
  {
    id: 'task_template_performance_analysis',
    sortOrder: 5,
    name: '性能分析',
    description: '分析真实代码路径的性能瓶颈与可观测指标。',
    promptTemplate: '请分析 {{target_flow}} 的性能风险，给出瓶颈假设、验证方式、优化建议和回归指标。',
  },
  {
    id: 'task_template_architecture_analysis',
    sortOrder: 6,
    name: '架构分析',
    description: '基于真实图谱理解模块边界、依赖和演进风险。',
    promptTemplate: '请基于 {{graph_context}} 分析架构边界、依赖方向、风险点和改造顺序。',
  },
  {
    id: 'task_template_sql_optimization',
    sortOrder: 7,
    name: 'SQL 优化',
    description: '分析真实 SQL、表结构或查询路径的优化空间。',
    promptTemplate: '请基于 {{sql_context}} 分析 SQL 性能、索引、事务一致性和回滚风险。',
  },
] as const;

const NATIVE_SQLITE_MIGRATION_ID = '20260808_0001_native_sqlite_wal';
const PROVIDER_EVENT_RECEIPTS_MIGRATION_ID = '20260808_0002_provider_event_receipts';
const TASK_BOARD_SCHEMA_MIGRATION_ID = '20260815_0001_task_board_schema';
const NATIVE_SQLITE_BACKUP_SUFFIX = '.pre-native-sqlite.bak';
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_BACKUP_FREE_SPACE_RESERVE_BYTES = 64 * 1024 * 1024;
const LEGACY_PROCESSED_PROVIDER_EVENTS_SETTING_KEY = 'codex.native.processed_provider_events';

let sqlModulePromise: Promise<SqlJsStatic> | undefined;

/** 加载 sql.js SQLite 引擎；保持单例，避免每次打开数据库都重复初始化 wasm。 */
async function loadSqlModule(): Promise<SqlJsStatic> {
  sqlModulePromise ??= initSqlJs();
  return sqlModulePromise;
}

function nowIso(): string {
  return new Date().toISOString();
}

export type ZeusStorageWriteFaultKind = 'disk_full' | 'io_error' | 'read_only_filesystem' | 'permission_denied' | 'integrity_error' | 'database_unavailable' | 'commit_unknown';

export type ZeusStorageHealthState = 'writable' | 'read_only_fault' | 'read_only_validation';

export interface ZeusStorageHealthSnapshot {
  state: ZeusStorageHealthState;
  readsAvailable: boolean;
  writesAllowed: boolean;
  fault: {
    id: string;
    kind: ZeusStorageWriteFaultKind;
    operation: string;
    sqliteCode: string | null;
    occurredAt: string;
    transactionIsolation: 'no_open_transaction' | 'rolled_back' | 'rollback_failed';
    recoveryRequiresCoreRestart: true;
  } | null;
}

export interface ZeusStorageRecoveryPreflight {
  faultId: string;
  transactionRolledBack: boolean;
  quickCheck: 'ok' | 'failed';
  walCheckpoint: 'ok' | 'failed' | 'skipped';
  foreignKeyCheck: 'ok' | 'failed';
  commandLedgerCheck: 'ok' | 'failed';
  commandLedgerViolations: number;
  preparedCommands: number;
  providerWritesAwaitingReconciliation: number;
  recoveryRequiredCommands: number;
  eligibleForCoreRestart: boolean;
  coreRestartRequired: true;
  checkedAt: string;
}

export class ZeusStorageWriteFaultError extends Error {
  readonly code = 'ZEUS_STORAGE_READ_ONLY_FAULT';
  readonly statusCode = 503;
  readonly recoveryRequired = true;

  constructor(
    readonly fault: NonNullable<ZeusStorageHealthSnapshot['fault']>,
    cause: unknown,
  ) {
    super(
      !faultAllowsReads(fault)
        ? 'Zeus 无法证明当前数据库可以安全读取；读取与写入均已停止。请修复存储后执行恢复核验并重启 Zeus Core。'
        : 'Zeus 存储已进入只读故障态；现有已提交数据仍可读取，但新的副作用已被拒绝。请释放空间或修复磁盘权限后执行恢复核验并重启 Zeus Core。',
      { cause },
    );
    this.name = 'ZeusStorageWriteFaultError';
  }
}

/** 正式数据隔离副本的显式只读验证连接拒绝一切事务与业务写入。 */
export class ZeusStorageReadOnlyValidationError extends Error {
  readonly code = 'ZEUS_STORAGE_READ_ONLY_VALIDATION';
  readonly statusCode = 503;
  readonly recoveryRequired = false;

  constructor() {
    super('Zeus 当前使用只读验证数据库；所有持久化副作用均已拒绝。');
    this.name = 'ZeusStorageReadOnlyValidationError';
  }
}

/** Zeus SQLite 包装器：负责迁移、保存、只读故障态和运行态诊断查询。 */
export class ZeusDatabase implements ZeusDatabasePort {
  private requestedSaveRevision = 0;
  private persistedSaveRevision = 0;
  private saveLoop: Promise<void> | null = null;
  private savepointSequence = 0;
  private savepointDepth = 0;
  private closed = false;
  private writeFailure: ZeusStorageWriteFaultError | null = null;
  private businessMutationAdmissionFrozen = false;
  private executionHostHandoffWriteDepth = 0;
  private readonly afterCommitCallbacks: Array<() => void | Promise<void>> = [];
  private readonly writeFaultListeners = new Set<(snapshot: ZeusStorageHealthSnapshot) => void>();
  private readonly databasePerformance: DatabasePerformanceCollector;

  constructor(
    private readonly db: DatabaseSync,
    databasePath: string,
    private readonly accessMode: 'read_write' | 'read_only_validation' = 'read_write',
    private readonly readOnlyValidationIdentity?: {
      descriptor: ReadOnlyValidationDescriptor;
      openedPathIdentity: ReadOnlyValidationDatabasePathIdentity;
    },
  ) {
    this.databasePerformance = new DatabasePerformanceCollector(databasePath);
  }

  execute(sql: string, params: SqlValue[] = []): void {
    this.assertWritable();
    if (isSqlTransactionControl(sql)) {
      throw new Error('ZeusDatabase.execute 不接受事务控制语句，请使用 transaction() 或 save()。');
    }
    try {
      this.ensurePendingTransaction();
      if (params.length === 0) {
        this.databasePerformance.measureSql('execute', sql, () => this.db.exec(sql));
        return;
      }
      this.databasePerformance.measureSql(
        'execute',
        sql,
        () => this.db.prepare(sql).run(...params),
        (result) => (typeof result.changes === 'bigint' ? (result.changes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(result.changes) : null) : result.changes),
      );
    } catch (error) {
      throw this.captureCriticalWriteFailure('execute', error) ?? error;
    }
  }

  select<T>(sql: string, params: SqlValue[] = []): T[] {
    this.assertReadable();
    return this.databasePerformance.measureSql(
      'select',
      sql,
      () => this.db.prepare(sql).all(...params) as unknown as T[],
      (rows) => rows.length,
    );
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.select<T>(sql, params)[0];
  }

  countRows(tableName: string): number {
    if (!/^[a-z_]+$/u.test(tableName)) {
      throw new Error(`Invalid Zeus table name: ${tableName}`);
    }
    return this.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`)?.count ?? 0;
  }

  /**
   * 注册当前 SQLite 事务成功提交后的通知。
   *
   * 回调不得承担业务事实写入；它只适合唤醒 dispatcher 或广播已经持久化的投影。
   * 保存点回滚会丢弃在该保存点内注册的回调，COMMIT 失败则一个也不会执行。
   */
  afterCommit(callback: () => void | Promise<void>): void {
    this.assertWritable();
    if (!this.db.isTransaction) throw new Error('ZeusDatabase.afterCommit 必须绑定到一个已经包含写入的待提交事务。');
    this.afterCommitCallbacks.push(callback);
  }

  storageHealthSnapshot(): ZeusStorageHealthSnapshot {
    this.assertOpen();
    return {
      state: this.accessMode === 'read_only_validation' ? 'read_only_validation' : this.writeFailure ? 'read_only_fault' : 'writable',
      readsAvailable: this.writeFailure ? faultAllowsReads(this.writeFailure.fault) : true,
      writesAllowed: this.accessMode === 'read_write' && this.writeFailure === null,
      fault: this.writeFailure ? { ...this.writeFailure.fault } : null,
    };
  }

  databasePerformanceSnapshot(options: { recentLimit?: number } = {}): DatabasePerformanceSnapshot {
    this.assertOpen();
    return this.databasePerformance.snapshot(
      {
        pageCount: sqlitePageCount(this.db),
        pageSizeBytes: sqlitePageSize(this.db),
        freePageCount: sqliteFreePageCount(this.db),
      },
      options,
    );
  }

  onWriteFault(listener: (snapshot: ZeusStorageHealthSnapshot) => void): () => void {
    this.assertOpen();
    this.writeFaultListeners.add(listener);
    if (this.writeFailure) listener(this.storageHealthSnapshot());
    return () => this.writeFaultListeners.delete(listener);
  }

  /** Artifact/staging 等 Core 耐久边界上报的硬文件系统故障。 */
  reportExternalWriteFault(operation: string, cause: unknown): ZeusStorageWriteFaultError {
    this.assertOpen();
    if (this.accessMode === 'read_only_validation') throw new ZeusStorageReadOnlyValidationError();
    const kind = classifyCriticalStorageWriteFault(cause);
    if (!kind) throw new Error(`外部写故障缺少可分类的硬存储证据：${operation}`);
    return this.enterWriteFault(operation, cause, kind);
  }

  /**
   * 用户明确请求后的恢复预检。它只回滚不确定的本地事务、检查数据库和 WAL，绝不在原连接上清除故障。
   * 通过后仍必须重启 Core，以新的 SQLite generation 重新打开并核验写入能力。
   */
  runWriteRecoveryPreflight(): ZeusStorageRecoveryPreflight {
    this.assertOpen();
    if (this.accessMode === 'read_only_validation') throw new ZeusStorageReadOnlyValidationError();
    if (!this.writeFailure) throw new Error('Zeus 存储当前可写，无需执行故障恢复预检。');
    let transactionRolledBack = !this.db.isTransaction;
    if (transactionRolledBack && this.writeFailure.fault.transactionIsolation === 'rollback_failed') {
      this.writeFailure.fault.transactionIsolation = 'no_open_transaction';
    }
    if (this.db.isTransaction) {
      try {
        this.db.exec('ROLLBACK');
        this.afterCommitCallbacks.length = 0;
        transactionRolledBack = true;
        this.writeFailure.fault.transactionIsolation = 'rolled_back';
      } catch {
        transactionRolledBack = false;
        this.writeFailure.fault.transactionIsolation = 'rollback_failed';
      }
    }
    if (!transactionRolledBack) {
      return {
        faultId: this.writeFailure.fault.id,
        transactionRolledBack: false,
        quickCheck: 'failed',
        walCheckpoint: 'skipped',
        foreignKeyCheck: 'failed',
        commandLedgerCheck: 'failed',
        commandLedgerViolations: 1,
        preparedCommands: 0,
        providerWritesAwaitingReconciliation: 0,
        recoveryRequiredCommands: 0,
        eligibleForCoreRestart: false,
        coreRestartRequired: true,
        checkedAt: new Date().toISOString(),
      };
    }
    let quickCheck: ZeusStorageRecoveryPreflight['quickCheck'] = 'failed';
    try {
      const row = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: unknown } | undefined;
      quickCheck = row?.quick_check === 'ok' ? 'ok' : 'failed';
    } catch {
      quickCheck = 'failed';
    }
    let walCheckpoint: ZeusStorageRecoveryPreflight['walCheckpoint'] = transactionRolledBack ? 'failed' : 'skipped';
    if (transactionRolledBack) {
      try {
        const row = this.databasePerformance.measureOperation('checkpoint', () => this.db.prepare('PRAGMA wal_checkpoint(PASSIVE)').get()) as { busy?: unknown; log?: unknown; checkpointed?: unknown } | undefined;
        const busy = Number(row?.busy ?? 1);
        const logFrames = Number(row?.log ?? -1);
        const checkpointedFrames = Number(row?.checkpointed ?? -2);
        walCheckpoint = busy === 0 && logFrames >= 0 && checkpointedFrames === logFrames ? 'ok' : 'failed';
      } catch {
        walCheckpoint = 'failed';
      }
    }
    let foreignKeyCheck: ZeusStorageRecoveryPreflight['foreignKeyCheck'] = 'failed';
    try {
      // 恢复预检只需要知道是否存在违规；损坏大库若全量 materialize 会放大内存与阻塞。
      const firstViolation = this.db.prepare('PRAGMA foreign_key_check').get();
      foreignKeyCheck = firstViolation === undefined ? 'ok' : 'failed';
    } catch {
      foreignKeyCheck = 'failed';
    }
    const commandLedger = inspectCommandLedgerRecoveryState(this.db);
    return {
      faultId: this.writeFailure.fault.id,
      transactionRolledBack,
      quickCheck,
      walCheckpoint,
      foreignKeyCheck,
      commandLedgerCheck: commandLedger.violations === 0 ? 'ok' : 'failed',
      commandLedgerViolations: commandLedger.violations,
      preparedCommands: commandLedger.preparedCommands,
      providerWritesAwaitingReconciliation: commandLedger.providerWritesAwaitingReconciliation,
      recoveryRequiredCommands: commandLedger.recoveryRequiredCommands,
      eligibleForCoreRestart: transactionRolledBack && quickCheck === 'ok' && walCheckpoint === 'ok' && foreignKeyCheck === 'ok' && commandLedger.violations === 0,
      coreRestartRequired: true,
      checkedAt: new Date().toISOString(),
    };
  }

  async save(): Promise<void> {
    if (this.businessMutationAdmissionFrozen && this.executionHostHandoffWriteDepth === 0 && !this.db.isTransaction && this.persistedSaveRevision >= this.requestedSaveRevision) return;
    this.assertWritable();
    if (this.savepointDepth > 0) throw new Error('事务回调执行期间不能调用 ZeusDatabase.save()。');
    const requestedRevision = ++this.requestedSaveRevision;
    while (this.persistedSaveRevision < requestedRevision) {
      if (!this.saveLoop) {
        const loop = this.runSaveLoop();
        const trackedLoop = loop.finally(() => {
          if (this.saveLoop === trackedLoop) this.saveLoop = null;
        });
        this.saveLoop = trackedLoop;
      }
      await this.saveLoop;
    }
  }

  /**
   * 同一时刻只提交一个待持久事务；并发保存会合并到当前提交后的至多一次补提交流程。
   * SQLite WAL 只追加变化页，不再生成或替换完整数据库文件。
   */
  private async runSaveLoop(): Promise<void> {
    while (this.persistedSaveRevision < this.requestedSaveRevision) {
      const targetRevision = this.requestedSaveRevision;
      const committedCallbacks = this.commitPendingTransaction();
      this.persistedSaveRevision = targetRevision;
      this.publishAfterCommitCallbacks(committedCallbacks);
    }
  }

  transaction<T>(operation: () => T): T {
    this.assertWritable();
    this.ensurePendingTransaction();
    const savepointName = `zeus_transaction_${++this.savepointSequence}`;
    const callbackCheckpoint = this.afterCommitCallbacks.length;
    this.db.exec(`SAVEPOINT ${savepointName}`);
    this.savepointDepth += 1;
    try {
      const result = operation();
      if (result instanceof Promise) throw new Error('ZeusDatabase.transaction 只接受同步事务回调。');
      this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.afterCommitCallbacks.splice(callbackCheckpoint);
      try {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepointName}`);
      } catch (rollbackError) {
        const writeFailure = this.enterWriteFault('savepoint_rollback', rollbackError, 'commit_unknown');
        throw new AggregateError([error, writeFailure], 'Zeus SQLite 事务与回滚同时失败。');
      }
      throw this.captureCriticalWriteFailure('savepoint_operation', error) ?? error;
    } finally {
      this.savepointDepth -= 1;
    }
  }

  /**
   * 在回调返回前把整个事务提交到 SQLite。
   * 该入口只用于 Provider 即将接纳真实请求的窄边界，禁止嵌套或异步回调。
   */
  durableTransactionSync<T>(operation: () => T): T {
    this.assertWritable();
    if (this.savepointDepth > 0) throw new Error('ZeusDatabase.durableTransactionSync 不能嵌套在保存点事务中。');
    if (this.persistedSaveRevision < this.requestedSaveRevision) {
      throw new Error('ZeusDatabase.durableTransactionSync 执行前仍有未完成的异步保存。');
    }
    const previouslyCommittedCallbacks = this.commitPendingTransaction();
    const callbackCheckpoint = this.afterCommitCallbacks.length;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = operation();
      if (result instanceof Promise) throw new Error('ZeusDatabase.durableTransactionSync 只接受同步事务回调。');
      const committedCallbacks = this.commitPendingTransaction();
      const committedRevision = Math.max(this.requestedSaveRevision, this.persistedSaveRevision) + 1;
      this.requestedSaveRevision = committedRevision;
      this.persistedSaveRevision = committedRevision;
      this.publishAfterCommitCallbacks(previouslyCommittedCallbacks);
      this.publishAfterCommitCallbacks(committedCallbacks);
      return result;
    } catch (error) {
      this.afterCommitCallbacks.splice(callbackCheckpoint);
      if (this.db.isTransaction) {
        try {
          this.db.exec('ROLLBACK');
        } catch (rollbackError) {
          const writeFailure = this.enterWriteFault('durable_transaction_rollback', rollbackError, 'commit_unknown');
          throw new AggregateError([error, writeFailure], 'Zeus SQLite 同步持久事务与回滚同时失败。');
        }
      }
      // 进入本次同步事务前的普通事务已经真实提交；后续 BEGIN/operation 失败不能吞掉其通知。
      this.publishAfterCommitCallbacks(previouslyCommittedCallbacks);
      throw this.captureCriticalWriteFailure('durable_transaction', error) ?? error;
    }
  }

  /**
   * 关键事实若已位于命令的同步 savepoint 中就加入同一原子提交；否则在返回调用方前
   * 独立 COMMIT。提交、审批/询问、turn、Provider 接纳与终态不能依赖定时器或后续写入。
   */
  commitCriticalFactSync<T>(operation: () => T): T {
    return this.savepointDepth > 0 ? operation() : this.durableTransactionSync(operation);
  }

  /**
   * 旧 Core 完成已接纳工作排空后，关闭整个业务 SQLite 的新写入入口。
   * 调用方必须先提交普通事务；冻结后仅同库 Execution Host 交接账本可以取得窄写许可。
   */
  freezeBusinessMutationAdmission(): void {
    this.assertOpen();
    if (this.writeFailure) throw this.writeFailure;
    if (this.businessMutationAdmissionFrozen) return;
    if (this.savepointDepth > 0 || this.db.isTransaction || this.saveLoop || this.persistedSaveRevision < this.requestedSaveRevision) {
      throw Object.assign(new Error('冻结业务 SQLite 写入前仍有未提交事务或保存循环。'), {
        code: 'ZEUS_EXECUTION_HOST_MUTATION_FENCE_NOT_DRAINED',
        statusCode: 409,
      });
    }
    this.businessMutationAdmissionFrozen = true;
  }

  /** 只允许 handoff repository 在冻结后提交 prepared/recovery_required 状态。 */
  runExecutionHostHandoffWrite<T>(operation: () => T): T {
    this.assertOpen();
    if (this.writeFailure) throw this.writeFailure;
    this.executionHostHandoffWriteDepth += 1;
    try {
      const result = operation();
      if (result instanceof Promise) throw new Error('Execution Host handoff 写许可只接受同步操作。');
      return result;
    } finally {
      this.executionHostHandoffWriteDepth -= 1;
    }
  }

  /** 正常关闭会先提交、截断 WAL，再释放数据库句柄。 */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.accessMode === 'read_only_validation') {
      this.afterCommitCallbacks.length = 0;
      const errors: unknown[] = [];
      try {
        this.db.close();
        this.closed = true;
      } catch (error) {
        errors.push(error);
      }
      if (this.readOnlyValidationIdentity) {
        try {
          await verifyClosedReadOnlyValidationDatabase(this.readOnlyValidationIdentity);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, '只读验证 SQLite 关闭与身份复核同时失败。');
      return;
    }
    const errors: unknown[] = [];
    try {
      await this.save();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 0) {
      try {
        const checkpoint = this.databasePerformance.measureOperation('checkpoint', () => this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()) as { busy?: unknown } | undefined;
        if (Number(checkpoint?.busy ?? 1) !== 0) throw new Error('Zeus SQLite WAL 截断检查点仍有占用者，拒绝把数据库关闭报告为成功。');
      } catch (error) {
        errors.push(this.enterWriteFault('wal_checkpoint_truncate', error, 'commit_unknown'));
      }
    }
    if (this.db.isTransaction) {
      try {
        this.db.exec('ROLLBACK');
        this.afterCommitCallbacks.length = 0;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      this.db.close();
      this.closed = true;
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Zeus SQLite 关闭失败。');
  }

  /** 启动失败时丢弃未提交变化，正式运行路径不得调用。 */
  discardAndClose(): void {
    if (this.closed) return;
    try {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
    } finally {
      this.afterCommitCallbacks.length = 0;
      this.db.close();
      this.closed = true;
    }
  }

  private ensurePendingTransaction(): void {
    if (this.db.isTransaction) return;
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw this.captureCriticalWriteFailure('begin_immediate', error) ?? error;
    }
  }

  private commitPendingTransaction(): Array<() => void | Promise<void>> {
    if (!this.db.isTransaction) {
      if (this.afterCommitCallbacks.length > 0) {
        throw this.enterWriteFault('after_commit_ownership', 'afterCommit callback without transaction', 'commit_unknown');
      }
      return [];
    }
    try {
      this.databasePerformance.measureOperation('commit', () => this.db.exec('COMMIT'));
    } catch (error) {
      throw this.enterWriteFault('commit', error, 'commit_unknown');
    }
    return this.afterCommitCallbacks.splice(0);
  }

  private publishAfterCommitCallbacks(callbacks: ReadonlyArray<() => void | Promise<void>>): void {
    for (const callback of callbacks) {
      try {
        const result = callback();
        if (result instanceof Promise) {
          void result.catch((error: unknown) => console.error('Zeus SQLite 提交后通知失败；已提交事实保持不变。', error));
        }
      } catch (error) {
        // COMMIT 已经成功，通知失败只能由订阅/派发层恢复，绝不能反向声称事务回滚。
        console.error('Zeus SQLite 提交后通知失败；已提交事实保持不变。', error);
      }
    }
  }

  private assertOpen(): void {
    if (this.closed || !this.db.isOpen) throw new Error('Zeus SQLite 已关闭。');
  }

  private assertReadable(): void {
    this.assertOpen();
    if (this.writeFailure && !faultAllowsReads(this.writeFailure.fault)) throw this.writeFailure;
  }

  private assertWritable(): void {
    this.assertOpen();
    if (this.accessMode === 'read_only_validation') throw new ZeusStorageReadOnlyValidationError();
    if (this.writeFailure) throw this.writeFailure;
    if (this.businessMutationAdmissionFrozen && this.executionHostHandoffWriteDepth === 0) {
      throw Object.assign(new Error('Zeus Core 正在执行持久化升级交接；业务 SQLite 已停止接纳新的写入。'), {
        code: 'ZEUS_EXECUTION_HOST_MUTATION_FROZEN',
        statusCode: 503,
      });
    }
  }

  private captureCriticalWriteFailure(operation: string, cause: unknown): ZeusStorageWriteFaultError | null {
    const classified = classifyCriticalStorageWriteFault(cause);
    return classified ? this.enterWriteFault(operation, cause, classified) : null;
  }

  private enterWriteFault(operation: string, cause: unknown, kind: ZeusStorageWriteFaultKind): ZeusStorageWriteFaultError {
    if (this.writeFailure) return this.writeFailure;
    let transactionIsolation: NonNullable<ZeusStorageHealthSnapshot['fault']>['transactionIsolation'] = 'no_open_transaction';
    if (this.db.isTransaction) {
      try {
        this.db.exec('ROLLBACK');
        transactionIsolation = 'rolled_back';
      } catch {
        transactionIsolation = 'rollback_failed';
      }
    }
    // 对应事务已经回滚或结果不明，提交后回调绝不能在后续路径误发布。
    this.afterCommitCallbacks.length = 0;
    const fault = {
      id: randomUUID(),
      kind,
      operation,
      sqliteCode: storageErrorCode(cause),
      occurredAt: new Date().toISOString(),
      transactionIsolation,
      recoveryRequiresCoreRestart: true as const,
    };
    this.writeFailure = new ZeusStorageWriteFaultError(fault, cause);
    const snapshot = this.storageHealthSnapshot();
    for (const listener of this.writeFaultListeners) {
      try {
        listener(snapshot);
      } catch (listenerError) {
        console.error('Zeus 存储故障监听器失败；只读故障态保持有效。', listenerError);
      }
    }
    return this.writeFailure;
  }
}

function faultAllowsReads(fault: NonNullable<ZeusStorageHealthSnapshot['fault']>): boolean {
  return fault.transactionIsolation !== 'rollback_failed' && fault.kind !== 'integrity_error';
}

interface CommandLedgerRecoveryState {
  violations: number;
  preparedCommands: number;
  providerWritesAwaitingReconciliation: number;
  recoveryRequiredCommands: number;
}

/**
 * 恢复预检只核对命令账本结构，不修改或“清理”任何未决结果。
 * prepared 可在新 Core 中按协议恢复，provider_write_started 必须在启动对账时收口为 unknown；
 * 两者都是合法待恢复状态，只有关联、回执或最新状态矛盾才阻断重启。
 */
function inspectCommandLedgerRecoveryState(db: DatabaseSync): CommandLedgerRecoveryState {
  try {
    const row = db
      .prepare(
        `WITH latest_attempt AS (
           SELECT outbox.*
             FROM command_outbox AS outbox
            WHERE outbox.attempt = (
              SELECT MAX(candidate.attempt)
                FROM command_outbox AS candidate
               WHERE candidate.command_id = outbox.command_id
            )
         ),
         receipt_tail AS (
           SELECT receipt.*
             FROM command_delivery_receipts AS receipt
            WHERE receipt.sequence = (
              SELECT MAX(candidate.sequence)
                FROM command_delivery_receipts AS candidate
               WHERE candidate.outbox_id = receipt.outbox_id
            )
         ),
         violations AS (
           SELECT 1
             FROM command_outbox AS outbox
             LEFT JOIN command_inbox AS inbox ON inbox.command_id = outbox.command_id
            WHERE inbox.command_id IS NULL
           UNION ALL
           SELECT 1
             FROM command_delivery_receipts AS receipt
             LEFT JOIN command_outbox AS outbox ON outbox.id = receipt.outbox_id
             LEFT JOIN command_inbox AS inbox ON inbox.command_id = receipt.command_id
            WHERE outbox.id IS NULL
               OR inbox.command_id IS NULL
               OR receipt.command_id <> outbox.command_id
           UNION ALL
           SELECT 1
             FROM command_outbox AS outbox
             LEFT JOIN receipt_tail AS receipt ON receipt.outbox_id = outbox.id
            WHERE (outbox.state = 'prepared' AND (
                     outbox.outcome IS NOT NULL OR outbox.provider_write_started_at IS NOT NULL OR
                     outbox.resolved_at IS NOT NULL OR outbox.auto_retry_permitted <> 1 OR receipt.id IS NOT NULL
                   ))
               OR (outbox.state = 'provider_write_started' AND (
                     outbox.outcome IS NOT NULL OR outbox.provider_write_started_at IS NULL OR
                     outbox.resolved_at IS NOT NULL OR outbox.auto_retry_permitted <> 0 OR receipt.id IS NOT NULL
                   ))
               OR (outbox.state = 'resolved' AND (
                     outbox.outcome IS NULL OR outbox.resolved_at IS NULL OR receipt.id IS NULL OR
                     receipt.outcome <> outbox.outcome OR
                     outbox.auto_retry_permitted <> CASE
                       WHEN outbox.outcome IN ('failed_before_write', 'explicitly_rejected') THEN 1 ELSE 0
                     END
                   ))
           UNION ALL
           SELECT 1
             FROM command_inbox AS inbox
             LEFT JOIN latest_attempt AS latest ON latest.command_id = inbox.command_id
            WHERE latest.id IS NULL
               OR (latest.state IN ('prepared', 'provider_write_started') AND (
                     inbox.delivery_state <> 'pending' OR inbox.last_outcome IS NOT NULL
                   ))
               OR (latest.state = 'resolved' AND (
                     inbox.last_outcome IS NULL OR inbox.last_outcome <> latest.outcome OR
                     inbox.delivery_state <> CASE
                       WHEN latest.outcome IN ('failed_before_write', 'explicitly_rejected') THEN 'retryable' ELSE 'terminal'
                     END
                   ))
           UNION ALL
           SELECT 1
             FROM command_outbox AS outbox
            WHERE EXISTS (
              SELECT 1
                FROM command_outbox AS newer
               WHERE newer.command_id = outbox.command_id
                 AND newer.attempt > outbox.attempt
            )
              AND outbox.state <> 'resolved'
           UNION ALL
           SELECT 1
             FROM command_outbox
            GROUP BY command_id
           HAVING MIN(attempt) <> 1 OR COUNT(*) <> MAX(attempt)
         )
         SELECT
           (SELECT COUNT(*) FROM violations) AS violations,
           (SELECT COUNT(*) FROM latest_attempt WHERE state = 'prepared') AS prepared_commands,
           (SELECT COUNT(*) FROM latest_attempt WHERE state = 'provider_write_started') AS provider_writes_awaiting_reconciliation,
           (SELECT COUNT(*) FROM command_inbox WHERE delivery_state = 'pending' OR last_outcome = 'outcome_unknown_after_write') AS recovery_required_commands`,
      )
      .get() as
      | {
          violations?: unknown;
          prepared_commands?: unknown;
          provider_writes_awaiting_reconciliation?: unknown;
          recovery_required_commands?: unknown;
        }
      | undefined;
    return {
      violations: nonNegativeSqlCount(row?.violations),
      preparedCommands: nonNegativeSqlCount(row?.prepared_commands),
      providerWritesAwaitingReconciliation: nonNegativeSqlCount(row?.provider_writes_awaiting_reconciliation),
      recoveryRequiredCommands: nonNegativeSqlCount(row?.recovery_required_commands),
    };
  } catch {
    // 缺表、SQL 失败或计数无效都是不可证的账本，必须阻断自动重启。
    return {
      violations: 1,
      preparedCommands: 0,
      providerWritesAwaitingReconciliation: 0,
      recoveryRequiredCommands: 0,
    };
  }
}

function nonNegativeSqlCount(value: unknown): number {
  const count = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('SQLite 恢复账本计数无效。');
  return count;
}

function classifyCriticalStorageWriteFault(cause: unknown): ZeusStorageWriteFaultKind | null {
  const code = storageErrorCode(cause) ?? '';
  const message = cause instanceof Error ? cause.message : String(cause);
  const evidence = `${code} ${message}`.toUpperCase();
  if (/SQLITE_FULL|ENOSPC|EDQUOT|DATABASE OR DISK IS FULL|DISK FULL|QUOTA EXCEEDED/u.test(evidence)) return 'disk_full';
  if (/SQLITE_IOERR|\bEIO\b|DISK I\/O ERROR/u.test(evidence)) return 'io_error';
  if (/SQLITE_READONLY|\bEROFS\b|READONLY DATABASE|READ-ONLY DATABASE/u.test(evidence)) return 'read_only_filesystem';
  if (/SQLITE_PERM|SQLITE_AUTH|\bEACCES\b|\bEPERM\b|PERMISSION DENIED/u.test(evidence)) return 'permission_denied';
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|DATABASE DISK IMAGE IS MALFORMED|NOT A DATABASE/u.test(evidence)) return 'integrity_error';
  if (/SQLITE_CANTOPEN|UNABLE TO OPEN DATABASE|ENOTDIR|NOT A DIRECTORY/u.test(evidence)) return 'database_unavailable';
  return null;
}

function storageErrorCode(cause: unknown): string | null {
  if (!cause || typeof cause !== 'object') return null;
  for (const key of ['code', 'errcode', 'errno'] as const) {
    const value = (cause as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 80);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function isSqlTransactionControl(sql: string): boolean {
  return /^\s*(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/iu.test(sql);
}

function storageWriteError(message: string, cause: unknown): Error {
  return cause instanceof Error ? new Error(`${message} ${cause.message}`, { cause }) : new Error(`${message} ${String(cause)}`);
}

export interface SqliteSchemaIntrospectionSnapshot {
  sourcePath: string;
  statements: Array<{
    type: 'table' | 'index' | 'trigger' | 'view';
    name: string;
    sql: string;
  }>;
}

/** 只读读取用户配置的 SQLite 文件 schema；不执行迁移、不写回目标数据库。 */
export async function introspectSqliteSchema(filePath: string): Promise<SqliteSchemaIntrospectionSnapshot> {
  const SQL = await loadSqlModule();
  const bytes = await readFile(filePath);
  const sqlite = new SQL.Database(bytes);
  try {
    const tableNames = selectSqliteObjects(sqlite, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .map((row) => String(row.name ?? ''))
      .filter(Boolean);
    const statements: SqliteSchemaIntrospectionSnapshot['statements'] = tableNames.map((tableName) => ({
      type: 'table',
      name: tableName,
      sql: renderSqliteCreateTable(sqlite, tableName),
    }));
    statements.push(...tableNames.flatMap((tableName) => renderSqliteCreateIndexes(sqlite, tableName)));
    statements.push(
      ...selectSqliteObjects(sqlite, `SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND sql IS NOT NULL ORDER BY type, name`).flatMap((row) => {
        if ((row.type === 'trigger' || row.type === 'view') && typeof row.name === 'string' && typeof row.sql === 'string') {
          return [
            {
              type: row.type as 'trigger' | 'view',
              name: row.name,
              sql: row.sql,
            },
          ];
        }
        return [];
      }),
    );
    return { sourcePath: filePath, statements };
  } finally {
    sqlite.close();
  }
}

function selectSqliteObjects(sqlite: SqlJsDatabase, sql: string): Array<Record<string, SqlJsValue>> {
  const stmt = sqlite.prepare(sql);
  const rows: Array<Record<string, SqlJsValue>> = [];
  try {
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, SqlJsValue>);
  } finally {
    stmt.free();
  }
  return rows;
}

function renderSqliteCreateTable(sqlite: SqlJsDatabase, tableName: string): string {
  const columns = selectSqliteObjects(sqlite, `PRAGMA table_info(${quoteSqliteIdentifier(tableName)})`);
  const foreignKeys = selectSqliteObjects(sqlite, `PRAGMA foreign_key_list(${quoteSqliteIdentifier(tableName)})`);
  const columnLines = columns.map((column) => {
    const parts = [
      quoteSqliteIdentifier(String(column.name)),
      String(column.type || 'TEXT').toUpperCase(),
      Number(column.notnull ?? 0) === 1 ? 'NOT NULL' : '',
      Number(column.pk ?? 0) === 1 ? 'PRIMARY KEY' : '',
      column.dflt_value !== null && column.dflt_value !== undefined ? `DEFAULT ${String(column.dflt_value)}` : '',
    ].filter(Boolean);
    return `  ${parts.join(' ')}`;
  });
  const foreignKeyLines = foreignKeys.map((foreignKey) => `  FOREIGN KEY (${quoteSqliteIdentifier(String(foreignKey.from))}) REFERENCES ${quoteSqliteIdentifier(String(foreignKey.table))}(${quoteSqliteIdentifier(String(foreignKey.to))})`);
  return `CREATE TABLE ${quoteSqliteIdentifier(tableName)} (\n${[...columnLines, ...foreignKeyLines].join(',\n')}\n)`;
}

function renderSqliteCreateIndexes(sqlite: SqlJsDatabase, tableName: string): SqliteSchemaIntrospectionSnapshot['statements'] {
  return selectSqliteObjects(sqlite, `PRAGMA index_list(${quoteSqliteIdentifier(tableName)})`)
    .filter((index) => String(index.origin ?? 'c') === 'c')
    .flatMap((index) => {
      const indexName = String(index.name ?? '');
      if (!indexName || indexName.startsWith('sqlite_')) return [];
      const columns = selectSqliteObjects(sqlite, `PRAGMA index_info(${quoteSqliteIdentifier(indexName)})`)
        .map((column) => quoteSqliteIdentifier(String(column.name ?? '')))
        .filter((name) => name !== '""');
      if (columns.length === 0) return [];
      const unique = Number(index.unique ?? 0) === 1 ? 'UNIQUE ' : '';
      return [
        {
          type: 'index' as const,
          name: indexName,
          sql: `CREATE ${unique}INDEX ${quoteSqliteIdentifier(indexName)} ON ${quoteSqliteIdentifier(tableName)} (${columns.join(', ')})`,
        },
      ];
    });
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replace(/"/gu, '""')}"`;
}

function migrateTaskBoardSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_board_views (
      project_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_board_positions (
      project_id TEXT NOT NULL,
      layout_key TEXT NOT NULL,
      group_id TEXT NOT NULL,
      subgroup_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL,
      rank INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, layout_key, group_id, subgroup_id, task_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_board_positions_lane ON task_board_positions(project_id, layout_key, group_id, subgroup_id, rank)`);
  recordSchemaMigration(db, {
    migrationId: TASK_BOARD_SCHEMA_MIGRATION_ID,
    description: '新增任务看板项目配置、布局修订和卡片排序位置',
    checksumSource: 'task_board_views:project_id,settings_json,revision,created_at,updated_at;task_board_positions:project_id,layout_key,group_id,subgroup_id,task_id,rank,updated_at',
  });
}

export interface CreateZeusDatabaseOptions {
  /**
   * 只允许离线候选副本维护工具显式开启。既有正式库普通启动绝不能同步创建大表索引。
   * 新建空库不需要设置此项，会自动安装索引。
   */
  applyDeferredConversationHotQueryIndexes?: boolean;
  onConversationHotQueryIndexProgress?: (progress: { index: number; total: number; name: string; status: 'starting' | 'completed' | 'already_present' }) => void;
  /**
   * 只允许已经由 SQLite Backup API 封存、且正式来源本身仍作为回退窗口的离线候选副本。
   * 该模式避免在候选 root 内再生成未入 manifest 的 pre-native 副本；普通正式启动禁止使用。
   */
  offlineCandidateSourceAlreadySealed?: boolean;
  /**
   * 仅由已核验 Test validation manifest 的启动组合传入。Storage 会在真实 SQLite open
   * 前后复验 descriptor device/inode/size 与本轮 mtime/ctime；连接以 readOnly 打开，
   * 不建目录、不 chmod、不迁移、不保存、不 checkpoint；所有写 API 统一失败关闭。
   */
  readOnlyValidation?: ReadOnlyValidationDescriptor;
}

export interface ReadOnlyValidationDatabasePathIdentity {
  readonly device: bigint;
  readonly inode: bigint;
  readonly bytes: bigint;
  readonly links: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

/** 创建或打开 Zeus SQLite 数据库，并执行幂等迁移；不会写入任何 seed 业务记录。 */
export async function createZeusDatabase(filePath: string, options: CreateZeusDatabaseOptions = {}): Promise<ZeusDatabase> {
  if (options.readOnlyValidation) {
    const descriptor = options.readOnlyValidation;
    const beforeHeader = captureReadOnlyValidationDatabasePathIdentity(filePath, descriptor);
    await assertReadOnlyValidationDatabaseHeader(filePath, beforeHeader);
    const beforeOpen = captureReadOnlyValidationDatabasePathIdentity(filePath, descriptor);
    assertReadOnlyValidationDatabaseIdentityStable(beforeHeader, beforeOpen, 'header 核验与 SQLite open 之间');
    const nativeDb = openNativeSqlite(filePath, true);
    try {
      const afterOpen = captureReadOnlyValidationDatabasePathIdentity(filePath, descriptor);
      assertReadOnlyValidationDatabaseIdentityStable(beforeOpen, afterOpen, 'SQLite open 前后');
      if (!hasNativeSqliteMigration(nativeDb)) throw new Error('只读验证数据库 schema 与当前 Zeus 不兼容；验证模式禁止就地迁移。');
      nativeDb.exec('PRAGMA query_only = ON');
      nativeDb.enableDefensive(true);
      return new ZeusDatabase(nativeDb, filePath, 'read_only_validation', { descriptor, openedPathIdentity: afterOpen });
    } catch (error) {
      nativeDb.close();
      throw error;
    }
  }
  const parentPath = dirname(filePath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const databaseExists = await pathExists(filePath);
  let requiresSynchronousIntegrityCheck = !databaseExists;

  if (databaseExists) {
    const sourceDb = openNativeSqlite(filePath, true);
    try {
      if (!hasNativeSqliteMigration(sourceDb)) {
        // 旧格式转换前必须完成全盘校验和备份；正常原生库启动不再因数据库体积同步扫描全部页面。
        assertDatabaseQuickCheck(sourceDb, '现有 Zeus 数据库');
        if (!options.offlineCandidateSourceAlreadySealed) await ensureNativeSqliteBackup(sourceDb, filePath);
        requiresSynchronousIntegrityCheck = true;
      }
    } finally {
      sourceDb.close();
    }
  }

  const nativeDb = openNativeSqlite(filePath, false);
  try {
    await chmod(filePath, 0o600);
    configureNativeSqlite(nativeDb);
  } catch (error) {
    nativeDb.close();
    throw error;
  }

  const zeusDb = new ZeusDatabase(nativeDb, filePath);
  try {
    if (zeusDb.get<{ present: number }>(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_legacy_write_fence'`)) {
      zeusDb.execute(`UPDATE conversation_legacy_write_fence SET current_writer_open = 1 WHERE singleton = 1`);
    }
    migrateCoreSchema(zeusDb);
    migrateTaskBoardSchema(zeusDb);
    migrateRetiredUnitTestTemplate(zeusDb);
    migrateTaskManagementStatus(zeusDb);
    migrateTaskTypesAndContents(zeusDb);
    migrateCodexNativeConversationSchema(zeusDb);
    migrateConversationGoalSchema(zeusDb);
    // 用量身份迁移会读取模型来源字段，新库必须先建立 Agent 会话身份列。
    migrateAgentRuntimeSchema(zeusDb);
    migrateCodexUsageLedgerSchema(zeusDb);
    migrateConversationStageSchema(zeusDb);
    migrateRemoteConversationTurnSchema(zeusDb);
    migrateTaskGitWorkspaceSchema(zeusDb);
    migrateMultiRepositoryTaskSchema(zeusDb);
    migrateCodexLegacyImportSchema(zeusDb);
    migrateMcpServerIdentifierFalsePositiveCleanup(zeusDb);
    migrateContextCompactionItemClassification(zeusDb);
    migrateImageGenerationItemClassification(zeusDb);
    migrateCommandCenterSchema(zeusDb);
    migrateCommandDeliverySchema(zeusDb);
    migrateTaskEventFileProjectionSchema(zeusDb);
    migrateProviderEventReceipts(zeusDb);
    migrateUnifiedConversationStoreSchema(zeusDb);
    migrateConversationLegacyCutoverSchema(zeusDb);
    migrateConversationProviderItemStoreSchema(zeusDb);
    migrateCompletedProviderPlansToConversationHistory(zeusDb);
    migrateArtifactStoreSchema(zeusDb);
    migrateConversationSyncEventStoreSchema(zeusDb);
    migrateLongTermMemorySchema(zeusDb);
    migrateColdEvidenceSchema(zeusDb);
    migrateExecutionHostWorkSchema(zeusDb);
    migrateExecutionHostHandoffSchema(zeusDb);
    if (!databaseExists || options.applyDeferredConversationHotQueryIndexes === true) {
      migrateConversationHotQueryIndexes(zeusDb, options.onConversationHotQueryIndexProgress);
    }
    recordSchemaMigration(zeusDb, {
      migrationId: NATIVE_SQLITE_MIGRATION_ID,
      description: '切换为原生 SQLite WAL 增量持久化',
      checksumSource: 'node:sqlite,WAL,synchronous=FULL,busy_timeout=5000,wal_autocheckpoint=1000',
    });
    if (zeusDb.get<{ present: number }>(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'conversation_legacy_write_fence'`)) {
      zeusDb.execute(`UPDATE conversation_legacy_write_fence SET current_writer_open = 0 WHERE singleton = 1`);
    }
    await zeusDb.save();
    if (requiresSynchronousIntegrityCheck) assertDatabaseQuickCheck(nativeDb, '迁移后的 Zeus 数据库');
    return zeusDb;
  } catch (error) {
    zeusDb.discardAndClose();
    throw error;
  }
}

async function assertReadOnlyValidationDatabaseHeader(filePath: string, expectedIdentity: ReadOnlyValidationDatabasePathIdentity): Promise<void> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = toReadOnlyValidationDatabasePathIdentity(await handle.stat({ bigint: true }));
    assertReadOnlyValidationDatabaseIdentityStable(expectedIdentity, before, 'header 文件描述符打开前后');
    const header = Buffer.alloc(100);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || header.subarray(0, 16).toString('binary') !== 'SQLite format 3\0') throw new Error('只读验证目标不是完整 SQLite 数据库。');
    // WAL 模式的只读打开仍可能在父目录创建 -wal/-shm；正式副本必须先转换为 rollback journal header。
    if (header[18] !== 1 || header[19] !== 1) throw new Error('只读验证数据库仍处于 WAL 文件格式；请使用 Zeus Test Backup API 工具生成 rollback-journal 验证副本。');
    const after = toReadOnlyValidationDatabasePathIdentity(await handle.stat({ bigint: true }));
    assertReadOnlyValidationDatabaseIdentityStable(before, after, 'header 有界读取前后');
  } finally {
    await handle.close();
  }
}

/** 捕获只读副本的 no-follow 路径身份；供实际 open 边界与行为探针复用同一判定。 */
export function captureReadOnlyValidationDatabasePathIdentity(filePath: string, descriptor: ReadOnlyValidationDescriptor): ReadOnlyValidationDatabasePathIdentity {
  const canonicalPath = resolve(filePath);
  if (canonicalPath !== filePath || descriptor.database.path !== canonicalPath || realpathSync(filePath) !== canonicalPath) {
    throw readOnlyValidationDatabaseIdentityError('数据库路径未绑定 descriptor 的规范真实路径。');
  }
  const stats = lstatSync(filePath, { bigint: true });
  if (!stats.isFile() || stats.isSymbolicLink()) throw readOnlyValidationDatabaseIdentityError('数据库必须是普通文件且不能是符号链接。');
  if (Number(stats.mode & 0o777n) !== 0o600) throw readOnlyValidationDatabaseIdentityError('数据库权限必须为 0600。');
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) throw readOnlyValidationDatabaseIdentityError('数据库不属于当前用户。');
  const identity = toReadOnlyValidationDatabasePathIdentity(stats);
  if (identity.device.toString() !== descriptor.database.device || identity.inode.toString() !== descriptor.database.inode || identity.bytes !== BigInt(descriptor.database.bytes) || identity.links !== 1n) {
    throw readOnlyValidationDatabaseIdentityError('数据库 nlink/device/inode/size 与 descriptor 不一致。');
  }
  return identity;
}

export function assertReadOnlyValidationDatabaseIdentityStable(before: ReadOnlyValidationDatabasePathIdentity, after: ReadOnlyValidationDatabasePathIdentity, boundary: string): void {
  if (
    before.device !== after.device ||
    before.inode !== after.inode ||
    before.bytes !== after.bytes ||
    before.links !== after.links ||
    before.mode !== after.mode ||
    before.uid !== after.uid ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw readOnlyValidationDatabaseIdentityError(`数据库身份在${boundary}发生变化。`);
  }
}

function toReadOnlyValidationDatabasePathIdentity(stats: { dev: bigint; ino: bigint; size: bigint; nlink: bigint; mode: bigint; uid: bigint; mtimeNs: bigint; ctimeNs: bigint }): ReadOnlyValidationDatabasePathIdentity {
  return {
    device: stats.dev,
    inode: stats.ino,
    bytes: stats.size,
    links: stats.nlink,
    mode: stats.mode,
    uid: stats.uid,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function readOnlyValidationDatabaseIdentityError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'ZEUS_READ_ONLY_VALIDATION_DATABASE_IDENTITY_MISMATCH' as const,
    failClosed: true as const,
  });
}

async function verifyClosedReadOnlyValidationDatabase(input: { descriptor: ReadOnlyValidationDescriptor; openedPathIdentity: ReadOnlyValidationDatabasePathIdentity }): Promise<void> {
  const beforeDigest = captureReadOnlyValidationDatabasePathIdentity(input.descriptor.database.path, input.descriptor);
  assertReadOnlyValidationDatabaseIdentityStable(input.openedPathIdentity, beforeDigest, 'SQLite 运行窗口与 close 之后');
  const digest = await digestClosedReadOnlyValidationDatabaseNoFollow(input.descriptor.database.path, beforeDigest);
  if (digest.bytes !== input.descriptor.database.bytes || digest.sha256 !== input.descriptor.database.sha256) {
    throw readOnlyValidationDatabaseIdentityError('数据库在只读连接关闭后的 SHA-256 或 bytes 与 descriptor 不一致。');
  }
  const afterDigest = captureReadOnlyValidationDatabasePathIdentity(input.descriptor.database.path, input.descriptor);
  assertReadOnlyValidationDatabaseIdentityStable(beforeDigest, afterDigest, '关闭后全库摘要前后');
  for (const companion of [`${input.descriptor.database.path}-wal`, `${input.descriptor.database.path}-shm`, `${input.descriptor.database.path}-journal`]) {
    if (await pathExists(companion)) throw readOnlyValidationDatabaseIdentityError(`只读连接关闭后出现不允许的 SQLite companion：${companion}`);
  }
}

async function digestClosedReadOnlyValidationDatabaseNoFollow(path: string, expectedIdentity: ReadOnlyValidationDatabasePathIdentity): Promise<{ sha256: string; bytes: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const before = toReadOnlyValidationDatabasePathIdentity(await handle.stat({ bigint: true }));
    assertReadOnlyValidationDatabaseIdentityStable(expectedIdentity, before, '关闭后摘要 fd open 前后');
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      bytes += result.bytesRead;
      if (!Number.isSafeInteger(bytes)) throw readOnlyValidationDatabaseIdentityError('关闭后数据库摘要超出安全整数预算。');
    }
    const after = toReadOnlyValidationDatabasePathIdentity(await handle.stat({ bigint: true }));
    assertReadOnlyValidationDatabaseIdentityStable(before, after, '关闭后摘要 fd 读取前后');
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest('hex'), bytes };
}

function migrateConversationHotQueryIndexes(db: ZeusDatabase, onProgress: CreateZeusDatabaseOptions['onConversationHotQueryIndexProgress']): void {
  const total = conversationHotQueryIndexes.length;
  conversationHotQueryIndexes.forEach((definition, index) => {
    const present = Boolean(db.get<{ present: number }>(`SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = ?`, [definition.name]));
    if (present) {
      onProgress?.({ index: index + 1, total, name: definition.name, status: 'already_present' });
      return;
    }
    onProgress?.({ index: index + 1, total, name: definition.name, status: 'starting' });
    db.execute(definition.createSql);
    onProgress?.({ index: index + 1, total, name: definition.name, status: 'completed' });
  });
  recordSchemaMigration(db, {
    migrationId: CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID,
    description: '增加会话首屏、恢复、资源与证据读取的有界热查询索引',
    checksumSource: CONVERSATION_HOT_QUERY_INDEX_CHECKSUM_SOURCE,
  });
}

function openNativeSqlite(filePath: string, readOnly: boolean): DatabaseSync {
  return new DatabaseSync(filePath, {
    readOnly,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
  });
}

function configureNativeSqlite(db: DatabaseSync): void {
  const journalMode = db.prepare('PRAGMA journal_mode = WAL').get();
  if (String(journalMode?.journal_mode ?? '').toLowerCase() !== 'wal') throw new Error('Zeus SQLite 无法启用 WAL，已中止启动。');
  db.exec(`PRAGMA synchronous = FULL`);
  db.exec(`PRAGMA foreign_keys = ON`);
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec(`PRAGMA wal_autocheckpoint = 1000`);
  db.enableDefensive(true);
}

function hasNativeSqliteMigration(db: DatabaseSync): boolean {
  const ledger = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`).get();
  if (!ledger) return false;
  return Boolean(db.prepare(`SELECT 1 AS present FROM schema_migrations WHERE migration_id = ?`).get(NATIVE_SQLITE_MIGRATION_ID));
}

async function ensureNativeSqliteBackup(sourceDb: DatabaseSync, filePath: string): Promise<void> {
  const backupPath = `${filePath}${NATIVE_SQLITE_BACKUP_SUFFIX}`;
  const sourcePageCount = sqlitePageCount(sourceDb);
  if (await pathExists(backupPath)) {
    const existingBackup = openNativeSqlite(backupPath, true);
    try {
      assertDatabaseQuickCheck(existingBackup, '现有原生 SQLite 迁移备份');
      if (sqlitePageCount(existingBackup) !== sourcePageCount) throw new Error(`原生 SQLite 迁移备份与源数据库页数不一致：${backupPath}`);
      return;
    } finally {
      existingBackup.close();
    }
  }

  const sourceStats = await stat(filePath);
  const filesystemStats = await statfs(dirname(filePath));
  const availableBytes = filesystemStats.bavail * filesystemStats.bsize;
  const logicalDatabaseBytes = sourcePageCount * sqlitePageSize(sourceDb);
  const requiredBytes = Math.max(sourceStats.size, logicalDatabaseBytes) + SQLITE_BACKUP_FREE_SPACE_RESERVE_BYTES;
  if (availableBytes < requiredBytes) {
    throw new Error(`原生 SQLite 迁移至少需要 ${requiredBytes} 字节可用空间，当前仅有 ${availableBytes} 字节。`);
  }

  const temporaryBackupPath = `${backupPath}.creating-${process.pid}-${randomUUID()}`;
  try {
    await backup(sourceDb, temporaryBackupPath);
    await chmod(temporaryBackupPath, 0o600);
    const createdBackup = openNativeSqlite(temporaryBackupPath, true);
    try {
      assertDatabaseQuickCheck(createdBackup, '新建原生 SQLite 迁移备份');
      if (sqlitePageCount(createdBackup) !== sourcePageCount) throw new Error(`新建原生 SQLite 迁移备份与源数据库页数不一致：${temporaryBackupPath}`);
    } finally {
      createdBackup.close();
    }
    await rename(temporaryBackupPath, backupPath);
  } catch (error) {
    await unlink(temporaryBackupPath).catch(() => undefined);
    throw error;
  }
}

function sqlitePageCount(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_count').get();
  const value = Number(row?.page_count ?? -1);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Zeus SQLite 无法读取数据库页数。');
  return value;
}

function sqlitePageSize(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA page_size').get();
  const value = Number(row?.page_size ?? 0);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Zeus SQLite 无法读取数据库页大小。');
  return value;
}

function sqliteFreePageCount(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA freelist_count').get();
  const value = Number(row?.freelist_count ?? -1);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Zeus SQLite 无法读取空闲页数。');
  return value;
}

function assertDatabaseQuickCheck(db: DatabaseSync, label: string): void {
  const rows = db.prepare('PRAGMA quick_check').all();
  const messages = rows.flatMap((row) => Object.values(row)).map(String);
  if (messages.length !== 1 || messages[0]?.toLowerCase() !== 'ok') throw new Error(`${label}完整性检查失败：${messages.join('; ') || '无检查结果'}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function migrateProviderEventReceipts(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS provider_event_receipts (
      identity TEXT PRIMARY KEY,
      generation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      method TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      UNIQUE (generation_id, sequence, method, thread_id, provider_turn_id, provider_item_id, request_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_provider_event_receipts_generation_sequence ON provider_event_receipts(generation_id, sequence)`);
  if (db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [PROVIDER_EVENT_RECEIPTS_MIGRATION_ID])) return;

  const legacySetting = db.get<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`, [LEGACY_PROCESSED_PROVIDER_EVENTS_SETTING_KEY]);
  if (legacySetting) {
    let identities: unknown;
    try {
      identities = JSON.parse(legacySetting.value_json);
    } catch (error) {
      throw storageWriteError('历史 Provider 事件去重记录无法解析，已保留原数据并中止迁移。', error);
    }
    if (!Array.isArray(identities) || identities.some((identity) => typeof identity !== 'string' || !identity)) {
      throw new Error('历史 Provider 事件去重记录格式非法，已保留原数据并中止迁移。');
    }
    const receipts = new ProviderEventReceiptRepository(db);
    for (const identity of new Set(identities)) {
      const [generationId = 'legacy', sequenceValue = '-1', method = 'legacy', threadId = '', providerTurnId = '', providerItemId = ''] = identity.split('|');
      const parsedSequence = Number(sequenceValue);
      receipts.record({
        identity,
        generationId,
        sequence: Number.isSafeInteger(parsedSequence) ? parsedSequence : -1,
        method,
        threadId,
        providerTurnId,
        providerItemId,
        // 旧格式以完整 identity 占位，避免两个不完整旧记录触发复合唯一键冲突。
        requestId: identity,
        receivedAt: nowIso(),
      });
    }
    for (const identity of new Set(identities)) {
      if (!receipts.has(identity)) throw new Error(`Provider 事件回执迁移校验失败：${identity}`);
    }
    db.execute(`DELETE FROM settings WHERE key = ?`, [LEGACY_PROCESSED_PROVIDER_EVENTS_SETTING_KEY]);
  }

  recordSchemaMigration(db, {
    migrationId: PROVIDER_EVENT_RECEIPTS_MIGRATION_ID,
    description: '将 Provider 事件去重记录迁移为逐行事务回执',
    checksumSource: 'provider_event_receipts:identity,generation_id,sequence,method,thread_id,provider_turn_id,provider_item_id,request_id,received_at',
  });
}

function migrateCoreSchema(db: ZeusDatabase): void {
  createSchemaMigrationsLedger(db);

  db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      local_path TEXT NOT NULL,
      git_root TEXT,
      project_type TEXT,
      primary_language TEXT,
      description TEXT,
      note TEXT,
      default_model TEXT,
      default_work_mode TEXT,
      default_template_id TEXT,
      scan_status TEXT NOT NULL DEFAULT 'not_scanned',
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  try {
    db.execute(`ALTER TABLE projects ADD COLUMN note TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE projects ADD COLUMN default_template_id TEXT`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  db.execute(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_task_id TEXT,
      title TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'requirement',
      description TEXT NOT NULL,
      defect_current_state TEXT NOT NULL DEFAULT '',
      defect_expected_outcome TEXT NOT NULL DEFAULT '',
      defect_reproduction_steps TEXT NOT NULL DEFAULT '',
      optimization_current_state TEXT NOT NULL DEFAULT '',
      optimization_expected_outcome TEXT NOT NULL DEFAULT '',
      management_status TEXT NOT NULL DEFAULT 'todo',
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      tags_json TEXT NOT NULL,
      template_id TEXT,
      model TEXT,
      work_dir TEXT,
      allow_code_changes INTEGER NOT NULL DEFAULT 0,
      allow_tests INTEGER NOT NULL DEFAULT 0,
      allow_git_commit INTEGER NOT NULL DEFAULT 0,
      created_from TEXT NOT NULL,
      source_context_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `);
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_code TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN task_sequence INTEGER`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`);
  } catch {
    // 旧数据库可能已经完成迁移；忽略重复字段错误。
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_parent_task_id ON tasks(parent_task_id)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_relations (
      left_task_id TEXT NOT NULL,
      right_task_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (left_task_id, right_task_id),
      CHECK (left_task_id < right_task_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_relations_right_task_id ON task_relations(right_task_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS runtime_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      command TEXT NOT NULL,
      args_json TEXT NOT NULL,
      cwd TEXT NOT NULL,
      status TEXT NOT NULL,
      pid INTEGER,
      process_identity_token TEXT,
      exit_code INTEGER,
      summary TEXT,
      favorite INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  for (const statement of [
    `ALTER TABLE runtime_sessions ADD COLUMN summary TEXT`,
    `ALTER TABLE runtime_sessions ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_sessions ADD COLUMN deleted_at TEXT`,
    `ALTER TABLE runtime_sessions ADD COLUMN process_identity_token TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
    }
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS runtime_logs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      content_sha256 TEXT,
      content_byte_length INTEGER NOT NULL DEFAULT 0,
      projection_truncated INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  for (const statement of [
    `ALTER TABLE runtime_logs ADD COLUMN content_sha256 TEXT`,
    `ALTER TABLE runtime_logs ADD COLUMN content_byte_length INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runtime_logs ADD COLUMN projection_truncated INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 新库已包含；旧库幂等补齐完整日志哈希与有界投影元数据。
    }
  }
  db.execute(`UPDATE runtime_logs SET content_byte_length = length(CAST(text AS BLOB)) WHERE content_byte_length = 0 AND text <> ''`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS terminal_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      task_id TEXT,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      content TEXT NOT NULL,
      raw_chunk_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT,
      session_id TEXT,
      title TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS git_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      snapshot_type TEXT NOT NULL,
      branch TEXT,
      head_sha TEXT,
      status_json TEXT NOT NULL,
      diff_text_path TEXT,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS git_changes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      change_type TEXT NOT NULL,
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      diff_hunk_path TEXT,
      linked_graph_nodes_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_type TEXT NOT NULL,
      actor_ref TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS event_log (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      prompt_template TEXT NOT NULL,
      default_options_json TEXT NOT NULL DEFAULT '{}',
      built_in INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `);
  for (const statement of [
    `CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_status_updated_at ON tasks(project_id, status, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_task_code ON tasks(project_id, task_code)`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_project_sequence ON tasks(project_id, task_sequence)`,
    `CREATE INDEX IF NOT EXISTS idx_task_events_task_created_at ON task_events(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_task_status ON runtime_sessions(task_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_sessions_status ON runtime_sessions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_runtime_logs_session_id ON runtime_logs(session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_terminal_events_session_seq ON terminal_events(session_id, seq)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_project_updated_at ON conversations(project_id, updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_conversation_messages_conversation_created_at ON conversation_messages(conversation_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_git_snapshots_task_created_at ON git_snapshots(task_id, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_git_changes_task_file_path ON git_changes(task_id, file_path)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_action_created_at ON audit_logs(action, created_at)`,
  ]) {
    db.execute(statement);
  }
  backfillMissingTaskCodes(db);
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  try {
    db.execute(`ALTER TABLE task_templates ADD COLUMN default_options_json TEXT NOT NULL DEFAULT '{}'`);
  } catch {
    // 列已存在时忽略；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }

  const timestamp = nowIso();
  for (const template of builtInTaskTemplates) {
    db.execute(
      `INSERT OR IGNORE INTO task_templates (id, name, description, category, prompt_template, default_options_json, built_in, created_at, updated_at)
       VALUES (?, ?, ?, 'built_in', ?, '{}', 1, ?, ?)`,
      [template.id, template.name, template.description, template.promptTemplate, timestamp, timestamp],
    );
    db.execute(`UPDATE task_templates SET sort_order = ?, name = ?, description = ?, category = 'built_in', prompt_template = ?, default_options_json = '{}', updated_at = ? WHERE id = ? AND built_in = 1`, [
      template.sortOrder,
      template.name,
      template.description,
      template.promptTemplate,
      timestamp,
      template.id,
    ]);
  }

  recordSchemaMigration(db, {
    migrationId: '20260613_0001_core_schema',
    description: '初始化 Zeus 核心表、索引和内置任务模板定义',
    checksumSource: 'projects,tasks,task_events,runtime_sessions,runtime_logs,terminal_events,conversations,conversation_messages,git_snapshots,git_changes,audit_logs,event_log,settings,task_templates,indexes,built_in_templates',
  });
}

function migrateRetiredUnitTestTemplate(db: ZeusDatabase): void {
  const migrationId = '20260723_0001_retire_unit_test_template';
  if (
    db.get<{ migration_id: string }>(
      `SELECT migration_id
                                          FROM schema_migrations
                                          WHERE migration_id = ?`,
      [migrationId],
    )
  )
    return;
  db.execute(`DELETE
                FROM task_templates
                WHERE id = 'task_template_unit_test'
                  AND built_in = 1`);
  recordSchemaMigration(db, {
    migrationId,
    description: '退役内置单元测试任务模板',
    checksumSource: 'task_templates:delete:task_template_unit_test:built_in:v1',
  });
}

function migrateTaskManagementStatus(db: ZeusDatabase): void {
  const migrationId = '20260721_0001_task_management_status';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;
  try {
    db.execute(`ALTER TABLE tasks ADD COLUMN management_status TEXT NOT NULL DEFAULT 'todo'`);
  } catch {
    // 新库已在建表语句中包含字段；旧库重复执行时也安全忽略。
  }
  // 只在本迁移首次执行时把旧的 Agent 执行状态映射成项目阶段；后续两套状态互不自动覆盖。
  db.execute(`
    UPDATE tasks
       SET management_status = CASE status
         WHEN 'completed' THEN 'completed'
         WHEN 'cancelled' THEN 'cancelled'
         WHEN 'running' THEN 'in_development'
         WHEN 'paused' THEN 'in_development'
         WHEN 'waiting_confirmation' THEN 'in_development'
         WHEN 'failed' THEN 'in_development'
         ELSE 'todo'
       END
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_project_management_status_updated_at ON tasks(project_id, management_status, updated_at)`);
  recordSchemaMigration(db, {
    migrationId,
    description: '拆分项目管理任务状态与 Coding Agent 执行状态',
    checksumSource: 'tasks.management_status:v1:todo,in_development,in_testing,awaiting_acceptance,blocked,completed,cancelled',
  });
}

function migrateTaskTypesAndContents(db: ZeusDatabase): void {
  const migrationId = '20260805_0001_task_types_and_contents';
  if (db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])) return;
  const columns = [
    `task_type TEXT NOT NULL DEFAULT 'requirement'`,
    `defect_current_state TEXT NOT NULL DEFAULT ''`,
    `defect_expected_outcome TEXT NOT NULL DEFAULT ''`,
    `defect_reproduction_steps TEXT NOT NULL DEFAULT ''`,
    `optimization_current_state TEXT NOT NULL DEFAULT ''`,
    `optimization_expected_outcome TEXT NOT NULL DEFAULT ''`,
  ];
  for (const column of columns) {
    try {
      db.execute(`ALTER TABLE tasks ADD COLUMN ${column}`);
    } catch {
      // 新数据库建表时已经包含这些字段；旧数据库重复执行时也安全忽略。
    }
  }
  // 历史任务按用户确认口径统一归为需求；未知脏值同样收敛到合法类型。
  db.execute(`UPDATE tasks SET task_type = 'requirement' WHERE task_type IS NULL OR task_type NOT IN ('requirement', 'defect', 'optimization')`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_tasks_project_type_updated_at ON tasks(project_id, task_type, updated_at)`);
  recordSchemaMigration(db, {
    migrationId,
    description: '增加任务类型与类型专属内容，历史任务统一迁移为需求',
    checksumSource: 'tasks.task_type:requirement,defect,optimization:typed-content',
  });
}

function migrateTaskGitWorkspaceSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_kind TEXT NOT NULL DEFAULT 'task',
      base_workspace_id TEXT,
      branch_name TEXT NOT NULL,
      source_branch TEXT NOT NULL,
      source_head_sha TEXT NOT NULL,
      remote_name TEXT NOT NULL DEFAULT 'origin',
      remote_branch TEXT NOT NULL,
      worktree_path TEXT,
      head_sha TEXT,
      state TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  for (const statement of [`ALTER TABLE task_workspaces ADD COLUMN workspace_kind TEXT NOT NULL DEFAULT 'task'`, `ALTER TABLE task_workspaces ADD COLUMN base_workspace_id TEXT`]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保留当前数据。
    }
  }
  db.execute(`UPDATE task_workspaces SET workspace_kind = 'task' WHERE workspace_kind IS NULL OR workspace_kind NOT IN ('task', 'conflict')`);
  const usesRepositoryScopedWorkspaces = Boolean(db.get<{ name: string }>(`SELECT name FROM pragma_table_info('task_workspaces') WHERE name = 'repository_id'`));
  if (usesRepositoryScopedWorkspaces) {
    // 多仓模型允许同一项目的不同仓库使用同名任务分支，旧项目级唯一索引必须先移除。
    db.execute(`DROP INDEX IF EXISTS idx_task_workspaces_project_branch`);
  } else {
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workspaces_project_branch ON task_workspaces(project_id, branch_name)`);
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workspaces_worktree_path ON task_workspaces(worktree_path) WHERE worktree_path IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_workspaces_task_state ON task_workspaces(task_id, state, updated_at)`);
  try {
    db.execute(`ALTER TABLE conversations ADD COLUMN workspace_id TEXT`);
  } catch {
    // 新库可能已经完成迁移；SQLite 不支持 ADD COLUMN IF NOT EXISTS。
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_workspace_updated_at ON conversations(workspace_id, updated_at)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_integrations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      target_branch TEXT NOT NULL,
      target_head_sha TEXT NOT NULL,
      task_head_sha TEXT,
      mode TEXT NOT NULL,
      integration_path TEXT,
      result_head_sha TEXT,
      state TEXT NOT NULL,
      local_sync_status TEXT,
      local_head_sha TEXT,
      local_worktree_path TEXT,
      conflict_files_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  for (const statement of [
    `ALTER TABLE task_integrations
            ADD COLUMN local_sync_status TEXT`,
    `ALTER TABLE task_integrations
            ADD COLUMN local_head_sha TEXT`,
    `ALTER TABLE task_integrations
            ADD COLUMN local_worktree_path TEXT`,
    `ALTER TABLE task_integrations
          ADD COLUMN task_head_sha TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保留当前数据。
    }
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_integrations_task_state ON task_integrations(task_id, state, updated_at)`);
  db.execute(`DROP INDEX IF EXISTS idx_task_integrations_active_workspace_target`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_integrations_active_workspace_target ON task_integrations(workspace_id, target_branch) WHERE state IN ('preparing', 'conflicted', 'pending_local_sync')`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS task_integration_attempts (
      id TEXT PRIMARY KEY,
      integration_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      submission_id TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      target_head_sha TEXT NOT NULL,
      task_head_sha TEXT NOT NULL,
      state TEXT NOT NULL,
      result_head_sha TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_integration_attempts_conversation ON task_integration_attempts(conversation_id)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_integration_attempts_worktree ON task_integration_attempts(worktree_path)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_integration_attempts_integration_state ON task_integration_attempts(integration_id, state, updated_at)`);
  recordSchemaMigration(db, {
    migrationId: '20260731_0001_task_git_workspaces',
    description: '增加可跨会话复用的任务分支与 worktree 生命周期记录',
    checksumSource: 'task_workspaces,task_integrations,conversations.workspace_id,project_branch,worktree_path,task_state,integration_state',
  });
  recordSchemaMigration(db, {
    migrationId: '20260803_0002_task_integration_local_sync',
    description: '记录任务分支远端交付后的本地目标分支同步状态',
    checksumSource: 'task_integrations:local_sync_status,local_head_sha,local_worktree_path',
  });
  recordSchemaMigration(db, {
    migrationId: '20260807_0003_task_integration_task_head',
    description: '冻结任务分支合入候选使用的精确提交',
    checksumSource: 'task_integrations:task_head_sha',
  });
  recordSchemaMigration(db, {
    migrationId: '20260811_0001_task_integration_attempts',
    description: '记录每次 AI 冲突处理的独立 worktree 与会话身份',
    checksumSource: 'task_integration_attempts:integration_id,conversation_id,submission_id,worktree_path,target_head_sha,task_head_sha,state,result_head_sha,last_error',
  });
  recordSchemaMigration(db, {
    migrationId: '20260814_0002_conflict_task_workspaces',
    description: '把 AI 冲突处理现场登记为带来源任务开发线的持久命名工作区',
    checksumSource: 'task_workspaces:workspace_kind,base_workspace_id:task,conflict',
  });
}

/**
 * 把单仓任务开发线扩展为任务环境聚合逐仓工作区。
 * 旧记录按一环境一工作区回填，避免升级后丢失既有会话和交付记录。
 */
function migrateMultiRepositoryTaskSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS project_repositories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repositories_project_relative_path ON project_repositories(project_id, relative_path)`);
  db.execute(`DROP INDEX IF EXISTS idx_project_repositories_local_path`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_repositories_project_local_path ON project_repositories(project_id, local_path)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS project_shared_paths (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_project_shared_paths_project_relative_path ON project_shared_paths(project_id, relative_path)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS task_environments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      root_path TEXT,
      state TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_environments_task_state ON task_environments(task_id, state, updated_at)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_environments_root_path ON task_environments(root_path) WHERE root_path IS NOT NULL`);

  for (const statement of [
    `ALTER TABLE task_workspaces ADD COLUMN environment_id TEXT`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_id TEXT`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_relative_path TEXT NOT NULL DEFAULT '.'`,
    `ALTER TABLE task_workspaces ADD COLUMN repository_path TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE conversations ADD COLUMN environment_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保留当前数据。
    }
  }

  // 旧模型按项目限制分支名唯一；多仓项目允许不同仓库使用同名任务分支。
  db.execute(`DROP INDEX IF EXISTS idx_task_workspaces_project_branch`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_task_workspaces_repository_branch ON task_workspaces(repository_id, branch_name) WHERE repository_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_task_workspaces_environment_state ON task_workspaces(environment_id, state, updated_at)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_environment_updated_at ON conversations(environment_id, updated_at)`);

  db.execute(
    `INSERT OR IGNORE INTO task_environments (id, project_id, task_id, root_path, state, last_error, created_at, updated_at)
     SELECT 'task_environment_legacy_' || id,
            project_id,
            task_id,
            worktree_path,
            CASE WHEN state = 'failed' THEN 'failed' WHEN state = 'ready' THEN 'ready' ELSE 'reclaimed' END,
            last_error,
            created_at,
            updated_at
       FROM task_workspaces
      WHERE environment_id IS NULL`,
  );
  db.execute(
    `UPDATE task_workspaces
        SET environment_id = 'task_environment_legacy_' || id,
            repository_name = CASE WHEN repository_name = '' THEN '项目仓库' ELSE repository_name END,
            repository_path = CASE WHEN repository_path = '' THEN COALESCE((SELECT local_path FROM projects WHERE projects.id = task_workspaces.project_id), '') ELSE repository_path END
      WHERE environment_id IS NULL`,
  );
  db.execute(
    `UPDATE conversations
        SET environment_id = (SELECT environment_id FROM task_workspaces WHERE task_workspaces.id = conversations.workspace_id)
      WHERE environment_id IS NULL AND workspace_id IS NOT NULL`,
  );

  recordSchemaMigration(db, {
    migrationId: '20260803_0003_multi_repository_task_environments',
    description: '增加项目仓库、共享可写目录、任务环境与逐仓任务工作区',
    checksumSource: 'project_repositories,project_shared_paths,task_environments,task_workspaces.environment_id,repository_id,repository_relative_path,repository_path,conversations.environment_id',
  });
}

function createSchemaMigrationsLedger(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
}

function recordSchemaMigration(
  db: ZeusDatabase,
  migration: {
    migrationId: string;
    description: string;
    checksumSource: string;
  },
): void {
  // migration 账本只记录结构版本，不写入项目/任务等业务假数据。
  const checksum = `sha256:${createHash('sha256').update(migration.checksumSource).digest('hex')}`;
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [migration.migrationId, migration.description, checksum, nowIso()]);
}

function migrateConversationGoalSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_goals (
      conversation_id TEXT PRIMARY KEY, provider_thread_id TEXT NOT NULL,
      objective TEXT NOT NULL, status TEXT NOT NULL, token_budget INTEGER,
      tokens_used INTEGER NOT NULL, time_used_seconds REAL NOT NULL,
      provider_created_at REAL NOT NULL, provider_updated_at REAL NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_goal_events (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT, kind TEXT NOT NULL, objective TEXT, status TEXT,
      token_budget INTEGER, tokens_used INTEGER, time_used_seconds REAL,
      occurred_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_goal_events_timeline ON conversation_goal_events(conversation_id, occurred_at, id)`);
  recordSchemaMigration(db, {
    migrationId: '20260813_0001_conversation_goals',
    description: '增加原生会话目标投影与不可变时间线',
    checksumSource: 'conversation_goals,conversation_goal_events',
  });
}

function migrateCodexNativeConversationSchema(db: ZeusDatabase): void {
  const needsCollaborationModeBackfill = !db.get<{
    migration_id: string;
  }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, ['20260722_0006_conversation_plan_actions']);
  for (const statement of [
    `ALTER TABLE conversations ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'legacy_cli'`,
    `ALTER TABLE conversations ADD COLUMN provider_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_thread_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_thread_path TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_model TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_state TEXT NOT NULL DEFAULT 'unbound'`,
    `ALTER TABLE conversations ADD COLUMN provider_protocol_version TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_binary_version TEXT`,
    `ALTER TABLE conversations ADD COLUMN legacy_source_conversation_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN provider_settings_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN provider_token_usage_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read-only'`,
    `ALTER TABLE conversations ADD COLUMN collaboration_mode TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE conversations ADD COLUMN next_turn_settings_json TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE conversations ADD COLUMN completion_unread INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN attention_kind TEXT NOT NULL DEFAULT 'none'`,
    `ALTER TABLE conversations ADD COLUMN attention_revision INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE conversations ADD COLUMN attention_turn_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN attention_updated_at TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；重复打开数据库时忽略已存在字段。
    }
  }

  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_provider_thread_id ON conversations(provider_thread_id) WHERE provider_thread_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_task_updated_at ON conversations(task_id, updated_at)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_turns (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT, client_submission_id TEXT NOT NULL, status TEXT NOT NULL,
      error_json TEXT, plan_json TEXT, started_at TEXT, completed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  try {
    db.execute(`ALTER TABLE conversation_turns ADD COLUMN plan_json TEXT`);
  } catch {
    // 新库已在 CREATE TABLE 中包含该列；旧库只补一次。
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_provider ON conversation_turns(provider_thread_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_turn_active ON conversation_turns(conversation_id, status, created_at, id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_items (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, provider_item_id TEXT NOT NULL,
      item_type TEXT NOT NULL, status TEXT NOT NULL, phase TEXT NOT NULL, text_content TEXT NOT NULL,
      payload_json TEXT NOT NULL, started_at TEXT, completed_at TEXT, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_item_provider ON conversation_items(provider_thread_id, provider_item_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_resources (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, item_id TEXT NOT NULL, source_index INTEGER NOT NULL,
      canonical_target_digest TEXT NOT NULL, kind TEXT NOT NULL, presentation TEXT NOT NULL,
      display_json TEXT NOT NULL, target_json TEXT NOT NULL, authority_json TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_resource_source ON conversation_resources(item_id, source_index, canonical_target_digest)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_resources_conversation ON conversation_resources(conversation_id, turn_id, item_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS turn_change_sets (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL, provider_turn_id TEXT NOT NULL, state TEXT NOT NULL,
      unified_diff TEXT NOT NULL, unified_diff_artifact_ref_json TEXT,
      unified_diff_byte_length INTEGER NOT NULL DEFAULT 0,
      unified_diff_character_length INTEGER NOT NULL DEFAULT 0,
      pre_image_digest TEXT, post_image_digest TEXT,
      conflict_json TEXT, unavailable_reason TEXT, journal_ref TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_change_set_turn ON turn_change_sets(conversation_id, turn_id)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_change_set_provider_turn ON turn_change_sets(conversation_id, provider_turn_id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS turn_change_files (
      id TEXT PRIMARY KEY, change_set_id TEXT NOT NULL, source_item_id TEXT,
      source_index INTEGER NOT NULL, old_path TEXT, new_path TEXT, change_type TEXT NOT NULL,
      added_lines INTEGER NOT NULL DEFAULT 0, deleted_lines INTEGER NOT NULL DEFAULT 0,
      pre_hash TEXT, post_hash TEXT, pre_exists INTEGER NOT NULL DEFAULT 0,
      post_exists INTEGER NOT NULL DEFAULT 0, pre_mode INTEGER, post_mode INTEGER,
      unified_diff TEXT NOT NULL, unified_diff_artifact_ref_json TEXT,
      unified_diff_byte_length INTEGER NOT NULL DEFAULT 0,
      unified_diff_character_length INTEGER NOT NULL DEFAULT 0,
      pre_blob_ref TEXT, post_blob_ref TEXT, reversible INTEGER NOT NULL DEFAULT 0,
      unavailable_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `);
  for (const statement of [
    `ALTER TABLE turn_change_files ADD COLUMN pre_exists INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_files ADD COLUMN post_exists INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_files ADD COLUMN pre_mode INTEGER`,
    `ALTER TABLE turn_change_files ADD COLUMN post_mode INTEGER`,
    `ALTER TABLE turn_change_files ADD COLUMN unified_diff_artifact_ref_json TEXT`,
    `ALTER TABLE turn_change_files ADD COLUMN unified_diff_byte_length INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_files ADD COLUMN unified_diff_character_length INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_sets ADD COLUMN unified_diff_artifact_ref_json TEXT`,
    `ALTER TABLE turn_change_sets ADD COLUMN unified_diff_byte_length INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE turn_change_sets ADD COLUMN unified_diff_character_length INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 新库已在 CREATE TABLE 中包含字段；旧库只补一次。
    }
  }
  db.execute(`UPDATE turn_change_sets SET unified_diff_byte_length = length(CAST(unified_diff AS BLOB)) WHERE unified_diff_byte_length = 0 AND unified_diff <> ''`);
  db.execute(`UPDATE turn_change_files SET unified_diff_byte_length = length(CAST(unified_diff AS BLOB)) WHERE unified_diff_byte_length = 0 AND unified_diff <> ''`);
  db.execute(`UPDATE turn_change_sets SET unified_diff_character_length = length(unified_diff) WHERE unified_diff_character_length = 0 AND unified_diff <> ''`);
  db.execute(`UPDATE turn_change_files SET unified_diff_character_length = length(unified_diff) WHERE unified_diff_character_length = 0 AND unified_diff <> ''`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_turn_change_file_source ON turn_change_files(change_set_id, source_item_id, source_index)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_turn_change_files_set ON turn_change_files(change_set_id, source_index, id)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_submissions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, client_message_id TEXT NOT NULL, kind TEXT NOT NULL,
      requested_delivery TEXT NOT NULL, status TEXT NOT NULL, queue_position INTEGER,
      input_json TEXT NOT NULL, target_provider_turn_id TEXT, provider_turn_id TEXT,
      paused_reason TEXT, error_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      dispatched_at TEXT, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_submission_idempotency ON conversation_submissions(conversation_id, idempotency_key)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_submission_created ON conversation_submissions(conversation_id, created_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_submission_queue ON conversation_submissions(conversation_id, status, queue_position, created_at, id)`);
  if (needsCollaborationModeBackfill) backfillConversationCollaborationModes(db);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_server_requests (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT, item_id TEXT,
      transport_generation_id TEXT NOT NULL, provider_request_id_json TEXT NOT NULL,
      request_kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL,
      response_json TEXT, contains_secret INTEGER NOT NULL DEFAULT 0, expires_at TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_server_request_provider ON conversation_server_requests(transport_generation_id, provider_request_id_json)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_server_request_pending ON conversation_server_requests(conversation_id, status, created_at, id)`);
  try {
    db.execute(`ALTER TABLE conversation_server_requests ADD COLUMN auto_resolution_state TEXT NOT NULL DEFAULT 'none'`);
  } catch {
    // 新库已在迁移补列；旧库重复打开时忽略。
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_session_file_edit_grants (
      conversation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    )
  `);

  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_plan_actions (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL,
      plan_item_id TEXT NOT NULL, status TEXT NOT NULL, submission_id TEXT,
      created_at TEXT NOT NULL, resolved_at TEXT, updated_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_plan_action_item ON conversation_plan_actions(plan_item_id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_plan_action_pending ON conversation_plan_actions(conversation_id, status, created_at)`);

  db.execute(`
    CREATE TABLE IF NOT EXISTS idempotency_requests (
      scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      status TEXT NOT NULL, http_status INTEGER, response_json TEXT, resource_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(scope, idempotency_key)
    )
  `);

  for (const statement of [
    `ALTER TABLE conversation_messages ADD COLUMN provider_thread_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN provider_turn_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN provider_item_id TEXT`,
    `ALTER TABLE conversation_messages ADD COLUMN client_message_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；重复打开数据库时忽略已存在字段。
    }
  }
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_provider_item ON conversation_messages(conversation_id, provider_item_id) WHERE provider_item_id IS NOT NULL`);

  recordSchemaMigration(db, {
    migrationId: '20260713_0002_codex_native_conversation',
    description: '增加 Codex native 会话运行表、唯一身份与本地幂等',
    checksumSource: 'codex_native_conversation:conversation_transport_provider,turns,items,submissions,server_requests,idempotency_requests,message_provider_identity,indexes,v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260715_0004_conversation_permission_mode',
    description: '增加 Codex native 会话权限模式事实源',
    checksumSource: 'conversations:permission_mode:read-only,auto,full-access:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260721_0005_conversation_turn_plan',
    description: '增加 Codex native 轮次结构化计划快照',
    checksumSource: 'conversation_turns:plan_json:turn_plan_updated:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260722_0006_conversation_plan_actions',
    description: '增加 PLAN 协作模式、计划实施请求和用户询问自动解决状态',
    checksumSource: 'conversations:collaboration_mode,conversation_plan_actions,conversation_server_requests:auto_resolution_state:v1',
  });
  recordSchemaMigration(db, {
    migrationId: '20260722_0007_conversation_completion_unread',
    description: '增加会话成功完成未读状态',
    checksumSource: 'conversations:completion_unread:successful_turn_completion,acknowledgement:v1',
  });
  const attentionMigrationId = '20260812_0001_conversation_attention_unread';
  if (!db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [attentionMigrationId])) {
    // 历史完成未读继续保留为“已完成”专属关注状态；没有历史未读的会话保持无关注。
    db.execute(`UPDATE conversations
                   SET attention_kind = 'completed',
                       attention_revision = CASE WHEN attention_revision < 1 THEN 1 ELSE attention_revision END,
                       attention_updated_at = COALESCE(attention_updated_at, updated_at)
                 WHERE completion_unread = 1 AND attention_kind = 'none'`);
    recordSchemaMigration(db, {
      migrationId: attentionMigrationId,
      description: '把完成未读提升为跨模型会话关注状态并增加并发已读版本',
      checksumSource: 'conversations:completion_unread_as_attention,attention_kind,attention_revision,attention_turn_id,attention_updated_at:v1',
    });
  }
  recordSchemaMigration(db, {
    migrationId: '20260804_0001_conversation_next_turn_settings',
    description: '增加会话下一轮配置持久化',
    checksumSource: 'conversations:next_turn_settings_json:model,effort,service_tier,permission_mode,collaboration_mode',
  });
  recordSchemaMigration(db, {
    migrationId: '20260727_0008_conversation_resources_and_turn_change_sets',
    description: '增加会话资源与执行轮次变更集持久化',
    checksumSource: 'conversation_resources,turn_change_sets,turn_change_files:resource_authority,turn_patch_undo_reapply:v1',
  });
}

function migrateCodexUsageLedgerSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS codex_usage_ledger (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      account_scope_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      model TEXT NOT NULL,
      service_tier TEXT,
      total_tokens INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL,
      cached_input_tokens INTEGER NOT NULL,
      cache_write_input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      reasoning_output_tokens INTEGER NOT NULL,
      provider_baseline_json TEXT,
      provider_total_json TEXT,
      usage_complete INTEGER NOT NULL DEFAULT 0,
      estimate_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (provider_id, provider_thread_id, provider_turn_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_occurred ON codex_usage_ledger(occurred_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_project_occurred ON codex_usage_ledger(project_id, occurred_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_conversation_occurred ON codex_usage_ledger(conversation_id, occurred_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_usage_ledger_model_occurred ON codex_usage_ledger(model, occurred_at, id)`);
  for (const statement of [
    `ALTER TABLE codex_usage_ledger ADD COLUMN provider_baseline_json TEXT`,
    `ALTER TABLE codex_usage_ledger ADD COLUMN provider_total_json TEXT`,
    `ALTER TABLE codex_usage_ledger ADD COLUMN usage_complete INTEGER NOT NULL DEFAULT 0`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // 新库已包含累计基线字段；旧库只补一次。
    }
  }
  const cumulativeMigrationId = '20260815_0001_codex_usage_cumulative_baseline';
  if (!db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [cumulativeMigrationId])) {
    const latestRows = db.select<
      DbCodexUsageLedgerRow & {
        provider_token_usage_json: string;
      }
    >(
      `SELECT l.*, c.provider_token_usage_json
         FROM codex_usage_ledger l
         JOIN conversations c ON c.id = l.conversation_id
        WHERE l.id = (
          SELECT candidate.id
            FROM codex_usage_ledger candidate
           WHERE candidate.provider_id = l.provider_id
             AND candidate.provider_thread_id = l.provider_thread_id
           ORDER BY candidate.occurred_at DESC, candidate.id DESC
           LIMIT 1
        )`,
    );
    for (const row of latestRows) {
      try {
        const snapshot = JSON.parse(row.provider_token_usage_json) as { total?: TokenUsageBreakdown };
        if (!snapshot.total) continue;
        validateTokenUsageBreakdown(snapshot.total);
        const legacyUsage: TokenUsageBreakdown = {
          totalTokens: row.total_tokens,
          inputTokens: row.input_tokens,
          cachedInputTokens: row.cached_input_tokens,
          cacheWriteInputTokens: row.cache_write_input_tokens,
          outputTokens: row.output_tokens,
          reasoningOutputTokens: row.reasoning_output_tokens,
        };
        const baseline = subtractTokenUsageBreakdown(snapshot.total, legacyUsage);
        db.execute(`UPDATE codex_usage_ledger SET provider_baseline_json = ?, provider_total_json = ?, usage_complete = 0 WHERE id = ?`, [JSON.stringify(baseline), JSON.stringify(snapshot.total), row.id]);
      } catch {
        // 历史快照不可解析时保持未知，后续事件按保守兼容路径建立基线。
      }
    }
    recordSchemaMigration(db, {
      migrationId: cumulativeMigrationId,
      description: '为 Codex 逐轮用量增加会话累计基线，避免把最后一次模型调用冒充整轮用量',
      checksumSource: 'codex_usage_ledger:provider_baseline_json,provider_total_json,usage_complete:cumulative-baseline',
    });
  }
  const externalUsageIdentityMigrationId = '20260815_0002_external_model_usage_identity';
  if (!db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [externalUsageIdentityMigrationId])) {
    // App Server 承载的外部模型仍属于 API 供应源，不能继续混入 Codex 订阅账户统计。
    db.execute(
      `UPDATE codex_usage_ledger
          SET provider_id = 'api:' || (SELECT model_source_id FROM conversations WHERE conversations.id = codex_usage_ledger.conversation_id),
              account_scope_id = (SELECT model_source_id FROM conversations WHERE conversations.id = codex_usage_ledger.conversation_id)
        WHERE provider_id = 'codex'
          AND EXISTS (
            SELECT 1
              FROM conversations
             WHERE conversations.id = codex_usage_ledger.conversation_id
               AND model_source_id IS NOT NULL
               AND model_source_id <> ''
               AND model_source_id <> 'codex'
          )`,
    );
    // Pi 的账本值本来就是逐轮增量；旧记录只缺少完整性标记。
    db.execute(`UPDATE codex_usage_ledger SET usage_complete = 1 WHERE provider_id LIKE 'pi:%'`);
    recordSchemaMigration(db, {
      migrationId: externalUsageIdentityMigrationId,
      description: '外部模型用量从 Codex 订阅统计中拆分，并确认历史 Pi 轮次完整性',
      checksumSource: 'codex_usage_ledger:external-model-provider-identity,pi-turn-usage-complete',
    });
  }
  recordSchemaMigration(db, {
    migrationId: '20260810_0001_codex_usage_ledger',
    description: '增加与项目、会话生命周期独立的 Codex 逐轮用量账本',
    checksumSource: 'codex_usage_ledger:provider,account_scope,project,conversation,thread,turn,model,tier,token_breakdown,estimate,occurred_at',
  });
}

function migrateConversationStageSchema(db: ZeusDatabase): void {
  const migrationId = '20260807_0001_conversation_stage_updated_at';
  const alreadyMigrated = db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId]);
  for (const statement of [`ALTER TABLE conversations ADD COLUMN stage TEXT NOT NULL DEFAULT 'created'`, `ALTER TABLE conversations ADD COLUMN stage_updated_at TEXT NOT NULL DEFAULT ''`]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保持当前数据。
    }
  }
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversations_project_stage_updated_at ON conversations(project_id, stage_updated_at DESC, created_at DESC, id DESC)`);
  if (!alreadyMigrated) {
    for (const row of db.select<{ id: string; created_at: string }>(`SELECT id, created_at FROM conversations`)) {
      const projection = deriveConversationStageProjection(db, row.id);
      if (!projection) continue;
      db.execute(`UPDATE conversations SET stage = ?, stage_updated_at = ? WHERE id = ?`, [projection.stage, projection.evidenceAt || row.created_at, row.id]);
    }
  }
  recordSchemaMigration(db, {
    migrationId,
    description: '增加独立会话阶段与阶段更新时间，并从历史执行事实回填',
    checksumSource: 'conversations:stage,stage_updated_at:turns,submissions,requests,created_at:v1',
  });
}

function migrateAgentRuntimeSchema(db: ZeusDatabase): void {
  const migrationId = '20260803_0001_agent_runtime_framework';
  const needsIdentityBackfill = !db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId]);
  for (const statement of [
    `ALTER TABLE conversations ADD COLUMN agent_kind TEXT`,
    `ALTER TABLE conversations ADD COLUMN agent_transport TEXT`,
    `ALTER TABLE conversations ADD COLUMN model_source_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN model_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN native_session_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN native_session_path TEXT`,
    `ALTER TABLE conversations ADD COLUMN capability_snapshot_id TEXT`,
    `ALTER TABLE conversation_turns ADD COLUMN agent_kind TEXT`,
    `ALTER TABLE conversation_turns ADD COLUMN native_run_id TEXT`,
    `ALTER TABLE conversation_items ADD COLUMN agent_kind TEXT`,
    `ALTER TABLE conversation_items ADD COLUMN native_item_id TEXT`,
  ]) {
    try {
      db.execute(statement);
    } catch {
      // SQLite 不支持 ADD COLUMN IF NOT EXISTS；字段存在时保持当前数据。
    }
  }

  db.execute(`
    CREATE TABLE IF NOT EXISTS agent_capability_snapshots (
      id TEXT PRIMARY KEY,
      agent_kind TEXT NOT NULL,
      transport_kind TEXT NOT NULL,
      support_status TEXT NOT NULL,
      adapter_version TEXT,
      binary_version TEXT,
      protocol_version TEXT,
      capabilities_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      checked_at TEXT NOT NULL
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_capability_snapshots_agent_checked ON agent_capability_snapshots(agent_kind, checked_at DESC)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_agent_native_session ON conversations(agent_kind, native_session_id) WHERE agent_kind IS NOT NULL AND native_session_id IS NOT NULL`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_agent_native_run ON conversation_turns(agent_kind, provider_thread_id, native_run_id) WHERE agent_kind IS NOT NULL AND native_run_id IS NOT NULL`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_item_agent_native_item ON conversation_items(agent_kind, provider_thread_id, native_item_id) WHERE agent_kind IS NOT NULL AND native_item_id IS NOT NULL`);

  if (needsIdentityBackfill) {
    // 只执行一次历史回填；字段已经完整的记录不再进入 UPDATE，避免启动时反复重写大体量会话正文页。
    db.execute(`UPDATE conversations SET
      agent_kind = COALESCE(agent_kind, 'codex'),
      agent_transport = COALESCE(agent_transport, 'app_server'),
      model_id = COALESCE(model_id, provider_model),
      native_session_id = COALESCE(native_session_id, provider_thread_id),
      native_session_path = COALESCE(native_session_path, provider_thread_path)
      WHERE transport_kind = 'codex_native'
        AND (agent_kind IS NULL OR agent_transport IS NULL OR model_id IS NULL OR native_session_id IS NULL OR native_session_path IS NULL)`);
    db.execute(`UPDATE conversation_turns SET
      agent_kind = COALESCE(agent_kind, 'codex'),
      native_run_id = COALESCE(native_run_id, provider_turn_id)
      WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_kind = 'codex')
        AND (agent_kind IS NULL OR native_run_id IS NULL)`);
    db.execute(`UPDATE conversation_items SET
      agent_kind = COALESCE(agent_kind, 'codex'),
      native_item_id = COALESCE(native_item_id, provider_item_id)
      WHERE conversation_id IN (SELECT id FROM conversations WHERE agent_kind = 'codex')
        AND (agent_kind IS NULL OR native_item_id IS NULL)`);
  }

  recordSchemaMigration(db, {
    migrationId,
    description: '增加多 Agent 身份、原生会话映射与能力证据快照',
    checksumSource: 'agent_runtime_framework:conversation_identity,turn_identity,item_identity,capability_snapshot,backfill_codex_native',
  });
}

function migrateRemoteConversationTurnSchema(db: ZeusDatabase): void {
  const migrationId = '20260811_0003_remote_conversation_turns';
  if (db.get<{ migration_id: string }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])) return;

  db.transaction(() => {
    const turnColumns = db.select<{ name: string; notnull: number }>(`PRAGMA table_info(conversation_turns)`);
    const clientSubmissionColumn = turnColumns.find((column) => column.name === 'client_submission_id');
    if (!clientSubmissionColumn) throw new Error('conversation_turns 缺少 client_submission_id，无法迁移远程轮次来源。');

    if (clientSubmissionColumn.notnull === 1) {
      db.execute(`DROP INDEX IF EXISTS idx_conversation_turn_provider`);
      db.execute(`DROP INDEX IF EXISTS idx_conversation_turn_active`);
      db.execute(`DROP INDEX IF EXISTS idx_conversation_turn_agent_native_run`);
      db.execute(`ALTER TABLE conversation_turns RENAME TO conversation_turns_remote_legacy`);
      db.execute(`
        CREATE TABLE conversation_turns (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, provider_thread_id TEXT NOT NULL,
          provider_turn_id TEXT, client_submission_id TEXT, status TEXT NOT NULL,
          error_json TEXT, plan_json TEXT, started_at TEXT, completed_at TEXT,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, agent_kind TEXT, native_run_id TEXT
        )
      `);
      db.execute(`
        INSERT INTO conversation_turns
          (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
           error_json, plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id)
        SELECT id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
               error_json, plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id
          FROM conversation_turns_remote_legacy
      `);
      const previousCount = db.countRows('conversation_turns_remote_legacy');
      const migratedCount = db.countRows('conversation_turns');
      if (previousCount !== migratedCount) throw new Error(`远程轮次来源迁移行数不一致：${previousCount} -> ${migratedCount}`);
      db.execute(`DROP TABLE conversation_turns_remote_legacy`);
    }

    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_provider ON conversation_turns(provider_thread_id, provider_turn_id) WHERE provider_turn_id IS NOT NULL`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_turn_active ON conversation_turns(conversation_id, status, created_at, id)`);
    db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_turn_agent_native_run ON conversation_turns(agent_kind, provider_thread_id, native_run_id) WHERE agent_kind IS NOT NULL AND native_run_id IS NOT NULL`);
    db.execute(`
      CREATE TABLE IF NOT EXISTS conversation_provider_sync_checkpoints (
        conversation_id TEXT PRIMARY KEY,
        provider_thread_id TEXT NOT NULL,
        baseline_turn_id TEXT,
        last_synced_turn_id TEXT,
        initialized_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_provider_sync_thread ON conversation_provider_sync_checkpoints(provider_thread_id)`);
    recordSchemaMigration(db, {
      migrationId,
      description: '允许远程原生轮次不绑定本机提交并增加逐会话同步检查点',
      checksumSource: 'conversation_turns:nullable_client_submission_id,conversation_provider_sync_checkpoints:baseline,last_synced:v1',
    });
  });
}

function backfillConversationCollaborationModes(db: ZeusDatabase): void {
  for (const conversation of db.select<{ id: string }>(`SELECT id FROM conversations`)) {
    const latest = db.get<{
      input_json: string;
    }>(`SELECT input_json FROM conversation_submissions WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [conversation.id]);
    if (!latest) continue;
    try {
      const input = JSON.parse(latest.input_json) as { context?: { workMode?: unknown } };
      const mode = input.context?.workMode;
      if (mode === 'plan' || mode === 'default') db.execute(`UPDATE conversations SET collaboration_mode = ? WHERE id = ?`, [mode, conversation.id]);
    } catch {
      // 旧提交无法解析时保持列默认值 default，避免迁移失败阻断启动。
    }
  }
}

function migrateCodexLegacyImportSchema(db: ZeusDatabase): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS codex_legacy_imports (
      id TEXT PRIMARY KEY,
      provider_import_id TEXT,
      source_conversation_id TEXT NOT NULL,
      target_conversation_id TEXT,
      snapshot_path TEXT NOT NULL,
      snapshot_sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      target_thread_id TEXT,
      failure_stage TEXT,
      failure_message TEXT,
      provider_binary_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_legacy_import_source_snapshot ON codex_legacy_imports(source_conversation_id, snapshot_sha256)`);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_legacy_import_target_thread ON codex_legacy_imports(target_thread_id) WHERE target_thread_id IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_legacy_import_provider_import ON codex_legacy_imports(provider_import_id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_codex_legacy_import_status ON codex_legacy_imports(status, updated_at)`);
  recordSchemaMigration(db, {
    migrationId: '20260714_0003_codex_legacy_import',
    description: '增加 Codex legacy 会话导入快照映射、恢复状态与唯一身份',
    checksumSource: 'codex_legacy_imports:source_snapshot,target_thread,provider_import,status,v1',
  });
}

function migrateMcpServerIdentifierFalsePositiveCleanup(db: ZeusDatabase): void {
  const migrationId = '20260720_0005_mcp_server_identifier_false_positive_cleanup';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;

  const falsePositive = 'Secret-like provider field rejected: snapshot.openai-api-key-local-confirmation';
  db.transaction(() => {
    db.execute(`DELETE FROM conversation_items WHERE item_type = 'error' AND provider_item_id LIKE 'native-provider-event-error-%' AND text_content = ?`, [falsePositive]);

    const providerErrors = db.get<{
      value_json: string;
    }>(`SELECT value_json FROM settings WHERE key = 'codex.native.provider_event_errors'`);
    if (providerErrors) {
      try {
        const parsed = JSON.parse(providerErrors.value_json) as unknown;
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter((entry) => !(isPlainRecord(entry) && entry.method === 'mcpServer/startupStatus/updated' && isPlainRecord(entry.error) && entry.error.message === falsePositive));
          if (filtered.length !== parsed.length) {
            db.execute(`UPDATE settings SET value_json = ?, updated_at = ? WHERE key = 'codex.native.provider_event_errors'`, [JSON.stringify(filtered), nowIso()]);
          }
        }
      } catch {
        // 非法诊断 JSON 保持原样；本迁移只清理能够精确识别的历史误报。
      }
    }

    recordSchemaMigration(db, {
      migrationId,
      description: '清理 MCP 服务标识被误判为密钥字段所产生的历史错误项',
      checksumSource: 'mcp_server_identifier:false_positive:conversation_items,provider_event_errors:v1',
    });
  });
}

function migrateContextCompactionItemClassification(db: ZeusDatabase): void {
  const migrationId = '20260804_0001_context_compaction_item_classification';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;

  db.transaction(() => {
    const candidates = db.select<{ id: string; payload_json: string }>(`SELECT id, payload_json FROM conversation_items WHERE item_type = 'error'`);
    for (const candidate of candidates) {
      try {
        const payload = JSON.parse(candidate.payload_json) as unknown;
        if (isPlainRecord(payload) && payload.type === 'contextCompaction') {
          db.execute(`UPDATE conversation_items SET item_type = 'contextCompaction' WHERE id = ? AND item_type = 'error'`, [candidate.id]);
        }
      } catch {
        // 非法历史负载保持原样；本迁移只修正能够精确识别的上下文整理条目。
      }
    }

    recordSchemaMigration(db, {
      migrationId,
      description: '修正上下文整理条目被误分类为执行错误的历史记录',
      checksumSource: 'context_compaction:item_type:error_to_contextCompaction:20260804',
    });
  });
}

function migrateImageGenerationItemClassification(db: ZeusDatabase): void {
  const migrationId = '20260810_0001_image_generation_item_classification';
  if (
    db.get<{
      migration_id: string;
    }>(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])
  )
    return;

  db.transaction(() => {
    const candidates = db.select<{ id: string; payload_json: string }>(`SELECT id, payload_json FROM conversation_items WHERE item_type = 'error'`);
    for (const candidate of candidates) {
      try {
        const payload = JSON.parse(candidate.payload_json) as unknown;
        if (isPlainRecord(payload) && payload.type === 'imageGeneration') {
          db.execute(`UPDATE conversation_items SET item_type = 'imageGeneration' WHERE id = ? AND item_type = 'error'`, [candidate.id]);
        }
      } catch {
        // 非法历史负载保持原样；本迁移只修正能够精确识别的图片生成条目。
      }
    }

    recordSchemaMigration(db, {
      migrationId,
      description: '修正图片生成条目被误分类为执行错误的历史记录',
      checksumSource: 'image_generation:item_type:error_to_imageGeneration:20260810',
    });
  });
}

function backfillMissingTaskCodes(db: ZeusDatabase): void {
  const projectIds = db.select<{ project_id: string }>(`SELECT DISTINCT project_id FROM tasks WHERE deleted_at IS NULL ORDER BY project_id ASC`).map((row) => row.project_id);
  for (const projectId of projectIds) {
    const rows = db.select<{ id: string; task_sequence: number | null; task_code: string | null }>(`SELECT id, task_sequence, task_code FROM tasks WHERE project_id = ? AND deleted_at IS NULL ORDER BY created_at ASC, id ASC`, [projectId]);
    const firstSequenceOwnerIds = new Map<number, string>();
    for (const row of rows) {
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      if (currentSequence && !firstSequenceOwnerIds.has(currentSequence)) {
        firstSequenceOwnerIds.set(currentSequence, row.id);
      }
    }
    let nextSequence = 1;
    const usedSequences = new Set<number>();
    for (const row of rows) {
      // 预先保留每个合法序号的第一拥有者，避免空/非法行抢占后续合法任务编码。
      const currentSequence = normalizeTaskSequence(row.task_sequence);
      const isFirstSequenceOwner = currentSequence !== null && firstSequenceOwnerIds.get(currentSequence) === row.id;
      while (firstSequenceOwnerIds.has(nextSequence) || usedSequences.has(nextSequence)) nextSequence += 1;
      const sequence = isFirstSequenceOwner && currentSequence !== null ? currentSequence : nextSequence;
      usedSequences.add(sequence);
      nextSequence = Math.max(nextSequence, sequence + 1);
      const code = formatTaskCode(sequence);
      if (row.task_sequence !== sequence || row.task_code !== code) {
        db.execute(`UPDATE tasks SET task_sequence = ?, task_code = ? WHERE id = ?`, [sequence, code, row.id]);
      }
    }
  }
}

function formatTaskCode(sequence: number): string {
  return `ZEUS-${String(sequence).padStart(4, '0')}`;
}

function normalizeTaskSequence(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}
