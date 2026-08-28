import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, ArtifactStoreError, ZeusStorageWriteFaultError, createZeusDatabase, type ArtifactOwnerIdentity } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-artifact-store-probe-'));
const observed: Record<string, unknown> = {};

try {
  await verifyCasAuthorizationAndGc();
  await verifyQuotaCompensation();
  await verifyExternalFaultBridge();
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

async function verifyCasAuthorizationAndGc(): Promise<void> {
  const database = await createZeusDatabase(join(probeRoot, 'cas.db'));
  try {
    const store = new ArtifactStore(database, join(probeRoot, 'cas-artifacts'), () => '2026-08-21T00:00:00.000Z', { minimumFreeBytes: 0, writeFaultReporter: database });
    const ownerA = owner('tool_result', 'result-a');
    const ownerB = owner('portable_context', 'context-b');
    const content = `${'stable artifact payload\n'.repeat(4_096)}tail`;
    const first = await store.putText({ text: content, mimeType: 'text/plain', owner: ownerA, compression: 'gzip-v1' });
    const second = await store.putText({ text: content, mimeType: 'text/plain', owner: ownerB, compression: 'gzip-v1' });
    const authorized = await store.readAuthorized({ sha256: first.sha256, owner: ownerA, maximumContentBytes: Buffer.byteLength(content) + 1 });

    observed.deduplicatedSha256 = first.sha256 === second.sha256;
    observed.objectCount = database.countRows('artifact_objects');
    observed.ownerCount = database.countRows('artifact_owners');
    observed.authorizedRoundTrip = Buffer.from(authorized.bytes).toString('utf8') === content;
    observed.unauthorizedRead = await captureArtifactCode(() => store.readAuthorized({ sha256: first.sha256, owner: { kind: 'tool_result', id: 'not-owner' } }));

    const hold = store.hold({ sha256: first.sha256, owner: ownerA, ownerClass: 'active_conversation', reason: '活动会话仍在引用完整工具结果', createdAt: '2026-08-21T00:00:00.000Z' });
    store.detachOwner({ sha256: first.sha256, owner: ownerA });
    store.detachOwner({ sha256: first.sha256, owner: ownerB });
    const heldCandidate = store.createGcCandidate({ eligibleBefore: '2026-08-22T00:00:00.000Z', minimumQuarantineMs: 60_000, createdAt: '2026-08-22T00:00:00.000Z' });
    observed.heldArtifactExcluded = heldCandidate.artifactCount === 0;
    store.cancelGcCandidate(heldCandidate.id);
    store.releaseHold({ id: hold.id, releasedAt: '2026-08-22T00:00:01.000Z' });

    const candidate = store.createGcCandidate({ eligibleBefore: '2026-08-22T00:00:00.000Z', minimumQuarantineMs: 60_000, createdAt: '2026-08-22T00:00:02.000Z' });
    const newOwner = owner('conversation_tool_result', 'result-referenced-after-candidate');
    store.attachOwner({ sha256: first.sha256, owner: newOwner, createdAt: '2026-08-22T00:00:03.000Z' });
    const revalidated = store.revalidateGcCandidate(candidate.id);
    observed.newOwnerMakesCandidateUnsafe = !revalidated.safe && revalidated.retainedSha256.includes(first.sha256);
    observed.quarantineBlockedByNewOwner = await captureArtifactCode(() => store.quarantineGcCandidate({ manifestId: candidate.id, expectedManifestSha256: candidate.manifestSha256, quarantinedAt: '2026-08-22T00:00:04.000Z' }));
    store.detachOwner({ sha256: first.sha256, owner: newOwner });
    store.cancelGcCandidate(candidate.id);

    const recoverable = store.createGcCandidate({ eligibleBefore: '2026-08-22T00:00:00.000Z', minimumQuarantineMs: 60_000, createdAt: '2026-08-22T00:00:05.000Z' });
    const quarantined = await store.quarantineGcCandidate({
      manifestId: recoverable.id,
      expectedManifestSha256: recoverable.manifestSha256,
      quarantinedAt: '2026-08-22T00:00:06.000Z',
    });
    const restored = await store.restoreQuarantinedGcCandidate({
      manifestId: recoverable.id,
      expectedManifestSha256: recoverable.manifestSha256,
      restoredAt: '2026-08-22T00:00:07.000Z',
    });
    store.attachOwner({ sha256: first.sha256, owner: ownerA, createdAt: '2026-08-22T00:00:08.000Z' });
    const restoredRead = await store.readAuthorized({ sha256: first.sha256, owner: ownerA, maximumContentBytes: Buffer.byteLength(content) + 1 });
    observed.quarantineAndRestore = quarantined.state === 'quarantined' && restored.state === 'cancelled' && Buffer.from(restoredRead.bytes).toString('utf8') === content;
    const capacity = await store.capacityDiagnostic({ recordSample: true, largestLimit: 5 });
    observed.capacityDiagnostic = capacity.categories.length > 0 && capacity.largest.some((entry) => entry.sha256 === first.sha256) && capacity.reclaimability.blockedByOwner >= 1;
    observed.casQuickCheck = database.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(observed.deduplicatedSha256 === true && observed.objectCount === 1 && observed.ownerCount === 2, '同内容双 owner 必须只占一个 CAS 对象');
    assertProbe(observed.authorizedRoundTrip === true && observed.unauthorizedRead === 'ZEUS_ARTIFACT_OWNER_MISMATCH', '授权读必须精确匹配 owner');
    assertProbe(observed.heldArtifactExcluded === true, '活动保留锁必须排除 GC 候选');
    assertProbe(observed.newOwnerMakesCandidateUnsafe === true && observed.quarantineBlockedByNewOwner === 'ZEUS_ARTIFACT_GC_CONFLICT', '候选后新引用必须阻断隔离');
    assertProbe(observed.quarantineAndRestore === true && observed.capacityDiagnostic === true, '隔离必须可恢复且容量诊断可观测');
    assertProbe(observed.casQuickCheck === 'ok', 'Artifact 临时账本 quick_check 必须通过');
  } finally {
    await database.close();
  }
}

async function verifyQuotaCompensation(): Promise<void> {
  const database = await createZeusDatabase(join(probeRoot, 'quota.db'));
  try {
    const store = new ArtifactStore(database, join(probeRoot, 'quota-artifacts'), () => '2026-08-21T01:00:00.000Z', {
      quotaBytes: 1,
      minimumFreeBytes: 0,
      writeFaultReporter: database,
    });
    observed.quotaRejection = await captureArtifactCode(() => store.putText({ text: 'larger than one byte', mimeType: 'text/plain', owner: owner('tool_result', 'quota') }));
    observed.quotaLeavesNoReference = database.countRows('artifact_objects') === 0 && database.countRows('artifact_owners') === 0 && database.countRows('artifact_staging_operations') === 0;
    observed.quotaKeepsCoreWritable = database.storageHealthSnapshot().writesAllowed;
    assertProbe(observed.quotaRejection === 'ZEUS_ARTIFACT_CAPACITY_EXHAUSTED' && observed.quotaLeavesNoReference === true, '配额拒绝必须补偿为零引用');
    assertProbe(observed.quotaKeepsCoreWritable === true, '业务配额拒绝不得冒充硬存储故障');
  } finally {
    await database.close();
  }
}

async function verifyExternalFaultBridge(): Promise<void> {
  const database = await createZeusDatabase(join(probeRoot, 'fault.db'));
  try {
    database.execute(`CREATE TABLE artifact_fault_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)`);
    database.execute(`INSERT INTO artifact_fault_probe (id, value) VALUES (1, 'baseline')`);
    await database.save();
    const injected = Object.assign(new Error('permission denied during artifact staging'), { code: 'EACCES' });
    const store = new ArtifactStore(database, join(probeRoot, 'fault-artifacts'), () => '2026-08-21T02:00:00.000Z', {
      minimumFreeBytes: 0,
      writeFaultReporter: database,
      faultInjection: {
        beforeFileOperation() {
          throw injected;
        },
      },
    });
    observed.externalArtifactFailure = await captureArtifactCode(() => store.putText({ text: 'fault', mimeType: 'text/plain', owner: owner('tool_result', 'fault') }));
    const health = database.storageHealthSnapshot();
    observed.externalFaultHealth = health;
    observed.externalFaultRecorded = database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM artifact_storage_faults WHERE errno = 'EACCES' AND resolved_at IS NULL`)?.count === 1;
    observed.externalFaultOldRead = database.get<{ value: string }>(`SELECT value FROM artifact_fault_probe WHERE id = 1`)?.value === 'baseline';
    observed.externalFaultSecondWrite = captureStorageFault(() => database.execute(`INSERT INTO artifact_fault_probe (id, value) VALUES (2, 'blocked')`));
    observed.externalFaultNoPartialReference = database.countRows('artifact_objects') === 0 && database.countRows('artifact_owners') === 0;
    observed.externalFaultArtifactPreflight = await store.runRecoveryPreflight();

    assertProbe(observed.externalArtifactFailure === 'ZEUS_ARTIFACT_EXTERNAL_WRITE_FAILED', 'Artifact staging EACCES 必须返回外部写故障');
    assertProbe(health.state === 'read_only_fault' && health.fault?.kind === 'permission_denied' && !health.writesAllowed, '外部硬故障必须进入 Core 统一只读态');
    assertProbe(observed.externalFaultRecorded === true && observed.externalFaultOldRead === true, '故障证据和旧事实必须可读');
    assertProbe(observed.externalFaultSecondWrite === 'ZEUS_STORAGE_READ_ONLY_FAULT:permission_denied' && observed.externalFaultNoPartialReference === true, '故障后第二写必须失败关闭且无半引用');
    const artifactPreflight = observed.externalFaultArtifactPreflight as Awaited<ReturnType<typeof store.runRecoveryPreflight>>;
    assertProbe(!artifactPreflight.eligibleForCoreRestart && artifactPreflight.stagingWrite === 'failed' && artifactPreflight.errorCode === 'EACCES', 'Artifact staging 仍不可写时恢复预检必须失败关闭');
  } finally {
    await database.close().catch(() => undefined);
  }
}

function owner(kind: string, id: string): ArtifactOwnerIdentity {
  return { kind, id, generationId: 'artifact-behavior-probe-v1', projectId: 'probe-project', conversationId: 'probe-conversation' };
}

async function captureArtifactCode(operation: () => unknown | Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof ArtifactStoreError ? error.code : error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function captureStorageFault(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof ZeusStorageWriteFaultError ? `${error.code}:${error.fault.kind}` : error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Artifact 行为探针失败：${message}`);
}
