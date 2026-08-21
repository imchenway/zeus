import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { CommandDeliveryRepository } from '../packages/storage/src/commandDeliveryStore.js';
import { createZeusDatabase, ZeusStorageWriteFaultError } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-storage-fault-probe-'));
const databasePath = join(probeRoot, 'probe.db');
const observed: Record<string, unknown> = {};

try {
  const database = await createZeusDatabase(databasePath);
  try {
    database.execute(`CREATE TABLE storage_fault_probe (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)`);
    database.execute(`INSERT INTO storage_fault_probe (id, payload) VALUES (1, x'626173656c696e65')`);
    await database.save();

    const commandDelivery = new CommandDeliveryRepository(database);
    const unresolvedCommand = recoveryProbeEnvelope();
    const unresolvedAttempt = commandDelivery.acceptAndPrepare({
      envelope: unresolvedCommand,
      requestSha256: createHash('sha256').update('storage-fault-provider-request').digest('hex'),
      destinationKind: 'provider_turn',
      destinationId: 'storage-fault-provider',
      resourceId: 'storage-fault-turn',
      occurredAt: '2026-08-21T00:00:00.000Z',
    });
    commandDelivery.markProviderWriteStarted({ outboxId: unresolvedAttempt.outbox.id, occurredAt: '2026-08-21T00:00:01.000Z' });
    commandDelivery.acceptAndPrepare({
      envelope: recoveryProbeEnvelope('storage-fault-prepared-command', 'storage-fault-prepared-submission'),
      requestSha256: createHash('sha256').update('storage-fault-prepared-request').digest('hex'),
      destinationKind: 'provider_turn',
      destinationId: 'storage-fault-provider',
      resourceId: 'storage-fault-prepared-turn',
      occurredAt: '2026-08-21T00:00:02.000Z',
    });

    const pageCount = database.get<{ page_count: number }>(`PRAGMA page_count`)?.page_count ?? 0;
    const pageSize = database.get<{ page_size: number }>(`PRAGMA page_size`)?.page_size ?? 0;
    assertProbe(pageCount > 0 && pageSize > 0, '临时数据库必须暴露有效页边界');

    const constrainedPageCount = pageCount + 1;
    const maximum = database.get<{ max_page_count: number }>(`PRAGMA max_page_count = ${constrainedPageCount}`)?.max_page_count ?? 0;
    assertProbe(maximum === constrainedPageCount, '临时数据库必须成功进入受控容量上限');

    observed.firstWriteFailure = captureFault(() => database.execute(`INSERT INTO storage_fault_probe (id, payload) VALUES (2, zeroblob(?))`, [pageSize * 8]));
    observed.healthAfterFailure = database.storageHealthSnapshot();
    observed.baselineStillReadable = database.get<{ payload: Uint8Array }>(`SELECT payload FROM storage_fault_probe WHERE id = 1`)?.payload.byteLength === 8;
    observed.failedWriteInvisible = database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM storage_fault_probe WHERE id = 2`)?.count === 0;
    observed.secondWriteFailure = captureFault(() => database.execute(`INSERT INTO storage_fault_probe (id, payload) VALUES (3, x'78')`));
    observed.preflight = database.runWriteRecoveryPreflight();

    const health = observed.healthAfterFailure as ReturnType<typeof database.storageHealthSnapshot>;
    const preflight = observed.preflight as ReturnType<typeof database.runWriteRecoveryPreflight>;
    assertProbe(observed.firstWriteFailure === 'ZEUS_STORAGE_READ_ONLY_FAULT:disk_full', '首次 SQLITE_FULL 必须进入全局只读故障态');
    assertProbe(health.state === 'read_only_fault' && health.readsAvailable && !health.writesAllowed, '故障态必须保留读取并拒绝写入');
    assertProbe(observed.baselineStillReadable === true && observed.failedWriteInvisible === true, '故障后旧事实必须可读，失败写入不得可见');
    assertProbe(observed.secondWriteFailure === 'ZEUS_STORAGE_READ_ONLY_FAULT:disk_full', '后续副作用必须由同一故障身份失败关闭');
    assertProbe(preflight.transactionRolledBack && preflight.quickCheck === 'ok' && preflight.walCheckpoint === 'ok', '恢复预检必须核对事务、quick_check 与 WAL');
    assertProbe(preflight.foreignKeyCheck === 'ok' && preflight.commandLedgerCheck === 'ok' && preflight.commandLedgerViolations === 0, '恢复预检必须核对外键与 Command Inbox/Outbox/receipt 语义');
    assertProbe(
      preflight.preparedCommands === 1 && preflight.providerWritesAwaitingReconciliation === 1 && preflight.recoveryRequiredCommands === 2,
      'prepared 与已写出但无回执的 Provider 命令必须保留为待恢复，不得被预检清理或误报账本损坏',
    );
    assertProbe(preflight.eligibleForCoreRestart && preflight.coreRestartRequired, '预检通过后仍必须要求新 Core generation');
  } finally {
    await database.close().catch(() => undefined);
  }

  const maintenanceDatabase = new DatabaseSync(databasePath);
  try {
    maintenanceDatabase.exec(`PRAGMA max_page_count = 2147483646`);
  } finally {
    maintenanceDatabase.close();
  }

  const restartedDatabase = await createZeusDatabase(databasePath);
  try {
    observed.restartHealth = restartedDatabase.storageHealthSnapshot();
    observed.restartBaselineReadable = restartedDatabase.get<{ payload: Uint8Array }>(`SELECT payload FROM storage_fault_probe WHERE id = 1`)?.payload.byteLength === 8;
    restartedDatabase.execute(`INSERT INTO storage_fault_probe (id, payload) VALUES (4, x'7265636f7665726564')`);
    await restartedDatabase.save();
    observed.restartWriteCommitted = restartedDatabase.get<{ payload: Uint8Array }>(`SELECT payload FROM storage_fault_probe WHERE id = 4`)?.payload.byteLength === 9;
    assertProbe(observed.restartHealth && (observed.restartHealth as ReturnType<typeof restartedDatabase.storageHealthSnapshot>).state === 'writable', '新 Core generation 必须重新核验为可写');
    assertProbe(observed.restartBaselineReadable === true && observed.restartWriteCommitted === true, '恢复后的新 generation 必须保留旧事实并能提交新事实');
  } finally {
    await restartedDatabase.close();
  }

  const permissionDatabasePath = join(probeRoot, 'permission.db');
  const permissionDatabase = await createZeusDatabase(permissionDatabasePath);
  let blockingReader: DatabaseSync | null = null;
  try {
    permissionDatabase.execute(`CREATE TABLE permission_fault_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
    permissionDatabase.execute(`INSERT INTO permission_fault_probe (id, payload) VALUES (1, 'baseline')`);
    await permissionDatabase.save();

    blockingReader = new DatabaseSync(permissionDatabasePath, { readOnly: true });
    blockingReader.exec('BEGIN');
    blockingReader.prepare(`SELECT payload FROM permission_fault_probe WHERE id = 1`).get();
    permissionDatabase.execute(`INSERT INTO permission_fault_probe (id, payload) VALUES (2, 'wal-frame-after-reader')`);
    await permissionDatabase.save();

    const permissionCause = Object.assign(new Error('permission denied for artifact staging'), { code: 'EACCES' });
    const reported = permissionDatabase.reportExternalWriteFault('artifact_staging_write', permissionCause);
    observed.permissionFaultReported = `${reported.code}:${reported.fault.kind}`;
    observed.permissionHealth = permissionDatabase.storageHealthSnapshot();
    observed.permissionOldRead = permissionDatabase.get<{ payload: string }>(`SELECT payload FROM permission_fault_probe WHERE id = 1`)?.payload === 'baseline';
    observed.permissionSecondWrite = captureFault(() => permissionDatabase.execute(`INSERT INTO permission_fault_probe (id, payload) VALUES (3, 'blocked')`));
    observed.busyCheckpointPreflight = permissionDatabase.runWriteRecoveryPreflight();
    observed.healthAfterFailedPreflight = permissionDatabase.storageHealthSnapshot();

    const failedPreflight = observed.busyCheckpointPreflight as ReturnType<typeof permissionDatabase.runWriteRecoveryPreflight>;
    assertProbe(observed.permissionFaultReported === 'ZEUS_STORAGE_READ_ONLY_FAULT:permission_denied', 'EACCES 必须进入 permission_denied 统一只读故障态');
    assertProbe(observed.permissionOldRead === true && observed.permissionSecondWrite === 'ZEUS_STORAGE_READ_ONLY_FAULT:permission_denied', '权限故障后旧事实必须可读且第二写失败关闭');
    assertProbe(failedPreflight.walCheckpoint === 'failed' && !failedPreflight.eligibleForCoreRestart, '有活动 reader 阻断 WAL 完整 checkpoint 时预检不得报成功');
    assertProbe((observed.healthAfterFailedPreflight as ReturnType<typeof permissionDatabase.storageHealthSnapshot>).writesAllowed === false, '用户预检未通过不得在原 Core generation 恢复写入');

    blockingReader.exec('ROLLBACK');
    blockingReader.close();
    blockingReader = null;
    observed.preflightAfterReaderRelease = permissionDatabase.runWriteRecoveryPreflight();
    observed.healthAfterSuccessfulPreflight = permissionDatabase.storageHealthSnapshot();
    const releasedPreflight = observed.preflightAfterReaderRelease as ReturnType<typeof permissionDatabase.runWriteRecoveryPreflight>;
    assertProbe(releasedPreflight.walCheckpoint === 'ok' && releasedPreflight.eligibleForCoreRestart, '阻塞 reader 释放后预检应允许进入 Core 重启流程');
    assertProbe((observed.healthAfterSuccessfulPreflight as ReturnType<typeof permissionDatabase.storageHealthSnapshot>).writesAllowed === false, '即使预检通过也只能要求重启，不得就地解锁写入');
  } finally {
    if (blockingReader) {
      try {
        blockingReader.exec('ROLLBACK');
      } catch {
        // 保留原始探针失败。
      }
      blockingReader.close();
    }
    await permissionDatabase.close().catch(() => undefined);
  }

  const permissionRestart = await createZeusDatabase(permissionDatabasePath);
  try {
    observed.permissionRestartWritable = permissionRestart.storageHealthSnapshot().writesAllowed;
    observed.permissionRestartOldRead = permissionRestart.get<{ payload: string }>(`SELECT payload FROM permission_fault_probe WHERE id = 1`)?.payload === 'baseline';
    assertProbe(observed.permissionRestartWritable === true && observed.permissionRestartOldRead === true, '只有新 Core generation 才可重新核验可写并保留旧事实');
  } finally {
    await permissionRestart.close();
  }

  const transactionVisibilityPath = join(probeRoot, 'transaction-visibility.db');
  const transactionVisibilityDatabase = await createZeusDatabase(transactionVisibilityPath);
  let uncommittedCallbackPublished = false;
  try {
    transactionVisibilityDatabase.execute(`CREATE TABLE transaction_visibility_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
    await transactionVisibilityDatabase.save();
    transactionVisibilityDatabase.execute(`INSERT INTO transaction_visibility_probe (id, payload) VALUES (1, 'must-never-be-visible')`);
    transactionVisibilityDatabase.afterCommit(() => {
      uncommittedCallbackPublished = true;
    });
    transactionVisibilityDatabase.reportExternalWriteFault('transaction-visibility-probe', Object.assign(new Error('synthetic permission denied'), { code: 'EACCES' }));
    observed.transactionVisibilityHealth = transactionVisibilityDatabase.storageHealthSnapshot();
    observed.uncommittedRowsAfterFault = transactionVisibilityDatabase.get<{ row_count: number }>(`SELECT COUNT(*) AS row_count FROM transaction_visibility_probe`)?.row_count ?? -1;
    observed.uncommittedCallbackPublished = uncommittedCallbackPublished;
    const transactionVisibilityHealth = observed.transactionVisibilityHealth as ReturnType<typeof transactionVisibilityDatabase.storageHealthSnapshot>;
    assertProbe(
      transactionVisibilityHealth.readsAvailable && transactionVisibilityHealth.fault?.transactionIsolation === 'rolled_back',
      '故障切换必须在继续提供读取前立即隔离并回滚当前事务',
    );
    assertProbe(observed.uncommittedRowsAfterFault === 0 && observed.uncommittedCallbackPublished === false, '未提交事实与 afterCommit 回调不得在只读故障态短暂可见或发布');
  } finally {
    await transactionVisibilityDatabase.close().catch(() => undefined);
  }

  const integrityFaultPath = join(probeRoot, 'integrity-fault.db');
  const integrityFaultDatabase = await createZeusDatabase(integrityFaultPath);
  try {
    integrityFaultDatabase.execute(`CREATE TABLE integrity_fault_probe (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
    integrityFaultDatabase.execute(`INSERT INTO integrity_fault_probe (id, payload) VALUES (1, 'committed-but-not-safe-after-corruption-signal')`);
    await integrityFaultDatabase.save();
    integrityFaultDatabase.reportExternalWriteFault('integrity-fault-probe', Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' }));
    observed.integrityFaultHealth = integrityFaultDatabase.storageHealthSnapshot();
    observed.integrityFaultRead = captureFault(() => integrityFaultDatabase.get(`SELECT payload FROM integrity_fault_probe WHERE id = 1`));
    const integrityHealth = observed.integrityFaultHealth as ReturnType<typeof integrityFaultDatabase.storageHealthSnapshot>;
    assertProbe(!integrityHealth.readsAvailable && observed.integrityFaultRead === 'ZEUS_STORAGE_READ_ONLY_FAULT:integrity_error', '已知 SQLite 完整性错误不得继续宣称或提供历史读取');
  } finally {
    await integrityFaultDatabase.close().catch(() => undefined);
  }

  const corruptedLedgerPath = join(probeRoot, 'corrupted-command-ledger.db');
  const corruptedLedgerDatabase = await createZeusDatabase(corruptedLedgerPath);
  try {
    const corruptedDelivery = new CommandDeliveryRepository(corruptedLedgerDatabase);
    const corruptedAttempt = corruptedDelivery.acceptAndPrepare({
      envelope: recoveryProbeEnvelope('storage-fault-corrupted-command', 'storage-fault-corrupted-submission'),
      requestSha256: createHash('sha256').update('storage-fault-corrupted-request').digest('hex'),
      destinationKind: 'provider_turn',
      destinationId: 'storage-fault-provider',
      resourceId: 'storage-fault-corrupted-turn',
      occurredAt: '2026-08-21T00:00:03.000Z',
    });
    corruptedLedgerDatabase.execute(`UPDATE command_outbox SET auto_retry_permitted = 0 WHERE id = ?`, [corruptedAttempt.outbox.id]);
    await corruptedLedgerDatabase.save();
    corruptedLedgerDatabase.reportExternalWriteFault('command-ledger-corruption-probe', Object.assign(new Error('synthetic disk I/O error'), { code: 'EIO' }));
    observed.corruptedLedgerPreflight = corruptedLedgerDatabase.runWriteRecoveryPreflight();
    const corruptedPreflight = observed.corruptedLedgerPreflight as ReturnType<typeof corruptedLedgerDatabase.runWriteRecoveryPreflight>;
    assertProbe(corruptedPreflight.quickCheck === 'ok' && corruptedPreflight.foreignKeyCheck === 'ok', '账本语义损坏场景必须保持 SQLite 结构与外键完整，避免把一般数据库损坏误当成 Command 检查证据');
    assertProbe(
      corruptedPreflight.commandLedgerCheck === 'failed' && corruptedPreflight.commandLedgerViolations > 0 && !corruptedPreflight.eligibleForCoreRestart,
      'Command Inbox/Outbox/receipt 状态矛盾必须独立阻断 Core 重启',
    );
  } finally {
    await corruptedLedgerDatabase.close().catch(() => undefined);
  }

  const foreignKeyViolationPath = join(probeRoot, 'foreign-key-violation.db');
  const foreignKeySeed = await createZeusDatabase(foreignKeyViolationPath);
  try {
    foreignKeySeed.execute(`CREATE TABLE recovery_parent (id INTEGER PRIMARY KEY)`);
    foreignKeySeed.execute(`CREATE TABLE recovery_child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES recovery_parent(id))`);
    await foreignKeySeed.save();
  } finally {
    await foreignKeySeed.close();
  }
  const foreignKeyInjector = new DatabaseSync(foreignKeyViolationPath);
  try {
    foreignKeyInjector.exec(`PRAGMA foreign_keys = OFF; INSERT INTO recovery_child (id, parent_id) VALUES (1, 404)`);
  } finally {
    foreignKeyInjector.close();
  }
  const foreignKeyViolationDatabase = await createZeusDatabase(foreignKeyViolationPath);
  try {
    foreignKeyViolationDatabase.reportExternalWriteFault('foreign-key-violation-probe', Object.assign(new Error('synthetic disk I/O error'), { code: 'EIO' }));
    observed.foreignKeyViolationPreflight = foreignKeyViolationDatabase.runWriteRecoveryPreflight();
    const foreignKeyPreflight = observed.foreignKeyViolationPreflight as ReturnType<typeof foreignKeyViolationDatabase.runWriteRecoveryPreflight>;
    assertProbe(
      foreignKeyPreflight.quickCheck === 'ok' && foreignKeyPreflight.foreignKeyCheck === 'failed' && !foreignKeyPreflight.eligibleForCoreRestart,
      '首条外键违规必须以有界探测阻断 Core 重启，即使 quick_check 仍为 ok',
    );
  } finally {
    await foreignKeyViolationDatabase.close().catch(() => undefined);
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function captureFault(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    if (error instanceof ZeusStorageWriteFaultError) return `${error.code}:${error.fault.kind}`;
    return error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function recoveryProbeEnvelope(commandId = 'storage-fault-provider-write', scopeId = 'storage-fault-submission'): CommandEnvelope {
  return {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: 'conversation.submission.dispatch',
    actor: { kind: 'local_api', id: 'storage-fault-probe' },
    scope: { kind: 'submission', id: scopeId },
    expectedRevision: null,
    idempotencyKey: commandId,
    issuedAt: '2026-08-21T00:00:00.000Z',
    payload: { probe: true },
  };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`存储故障行为探针失败：${message}`);
}
