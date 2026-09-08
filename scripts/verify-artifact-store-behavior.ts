import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, ArtifactStoreError, ConversationExecutionRepository, ZeusStorageWriteFaultError, createZeusDatabase, type ArtifactOwnerIdentity } from '../packages/storage/src/index.js';
import { ManagedConversationToolResultStore } from '../packages/local-server/src/conversationPortableContext.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-artifact-store-probe-'));
const observed: Record<string, unknown> = {};

try {
  await verifyCasAuthorizationAndGc();
  await verifyQuotaCompensation();
  await verifyExternalFaultBridge();
  await verifyConversationToolResultReplay();
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

/** 在真实临时 SQLite 与 Artifact 文件上验证原文归档、完成回显和并发重复归档。 */
async function verifyConversationToolResultReplay(): Promise<void> {
  /** 独立数据库用于验证关闭重开后的稳定句柄。 */
  const databasePath = join(probeRoot, 'tool-results.db');
  /** 工具原件只落在本次探针的临时目录。 */
  const artifactRoot = join(probeRoot, 'tool-artifacts');
  /** 首次打开的数据库连接。 */
  const database = await createZeusDatabase(databasePath);
  /** 保存重启后仍需读取的原始句柄。 */
  let originalHandle = '';
  /** 超过投影上限的原文，确保回显不是完整原件。 */
  const originalText = `${'完整工具结果\n'.repeat(4_096)}原文结尾`;
  /** 同一真实调用的固定归档身份。 */
  const input = { conversationId: 'tool-conversation', turnId: 'tool-turn', segmentId: 'tool-segment', toolPairId: 'tool-call', toolKind: 'other' as const, text: originalText, createdAt: '2026-09-08T03:05:17.586Z' };
  try {
    /** 使用产品中的真实存储实现，不替换数据库或文件写入。 */
    const execution = new ConversationExecutionRepository(database);
    /** 禁止探针触碰正式 Artifact。 */
    const artifacts = new ArtifactStore(database, artifactRoot, undefined, { minimumFreeBytes: 0 });
    /** 动态工具执行和完成通知共用的归档入口。 */
    const store = new ManagedConversationToolResultStore(artifactRoot, execution, artifacts);
    /** 首次执行保存完整原文。 */
    const original = await store.store(input);
    originalHandle = original.record.handle;
    /** 完成事件只回显已经截断的模型投影。 */
    const echoed = await store.store({ ...input, text: original.projection, createdAt: '2026-09-08T03:05:18.586Z' });
    assertProbe(echoed.record.handle === originalHandle && echoed.projection === original.projection, '完成回显必须复用原句柄和原投影');
    assertProbe(database.countRows('conversation_tool_results') === 1 && database.countRows('artifact_owners') === 1 && database.countRows('artifact_objects') === 1, '重复通知不得新增结果或 Artifact 引用');
    assertProbe((await store.readPage({ conversationId: input.conversationId, handle: originalHandle, offset: originalText.length - 4 })).text === '原文结尾', '完成回显不能覆盖原件尾部');
    assertProbe(execution.recordToolResult({ ...original.record, handle: 'duplicate-candidate' }).handle === originalHandle, '数据库插入冲突必须返回首次记录');
    assertProbe(captureStorageFault(() => execution.recordToolResult({ ...original.record, toolPairId: 'another-call' }))?.includes('身份冲突'), '同一句柄不能属于另一调用');
    for (const scope of [{ turnId: 'another-turn' }, { segmentId: 'another-segment' }]) {
      assertProbe((await captureArtifactCode(() => store.store({ ...input, ...scope })))?.includes('身份冲突'), '跨轮次或分段的调用编号冲突必须拒绝');
    }
    assertProbe((await captureArtifactCode(() => store.readPage({ conversationId: 'another-conversation', handle: originalHandle })))?.includes('不属于当前'), '句柄不能被其他会话读取');
    assertProbe((await store.store({ ...input, conversationId: 'another-conversation' })).record.handle !== originalHandle, '不同会话中的同名调用必须独立保存');

    /** 两个存储实例同时首次归档，强制经过数据库唯一键裁定。 */
    const concurrentStores = [store, new ManagedConversationToolResultStore(artifactRoot, new ConversationExecutionRepository(database), artifacts)];
    /** 不同候选原文也必须返回唯一记录对应的投影。 */
    const concurrent = await Promise.all(concurrentStores.map((candidate, index) => candidate.store({ ...input, toolPairId: 'concurrent-call', text: `${originalText}${index}` })));
    assertProbe(
      concurrent[0]!.record.handle === concurrent[1]!.record.handle && concurrent[0]!.projection === concurrent[1]!.projection && concurrent[0]!.projection.includes(concurrent[0]!.record.handle),
      '并发归档不能返回悬空句柄或不同投影',
    );

    /** 最小 PNG 原件用于核对图片重入和图片序号隔离。 */
    const imageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9e0AAAAASUVORK5CYII=';
    /** 同一图片的两个并发归档请求。 */
    const images = await Promise.all(concurrentStores.map((candidate) => candidate.storeImage({ ...input, toolPairId: 'tool-call:image:0', imageUrl })));
    assertProbe(images[0]!.record.handle === images[1]!.record.handle && images[0]!.projectionText === images[1]!.projectionText && images.every((image) => image.projectedImageUrl === imageUrl), '并发图片必须复用原件、句柄和投影说明');
    assertProbe((await store.storeImage({ ...input, toolPairId: 'tool-call:image:1', imageUrl })).record.handle !== images[0]!.record.handle, '同一调用的不同图片序号不能合并');
    assertProbe((await captureArtifactCode(() => store.storeImage({ ...input, imageUrl })))?.includes('类型不匹配'), '图片与文字不得共享同一结果编号');
    /** 以另一张超过热投影上限的图片验证重入必须读取原件。 */
    const largeImageUrl = `data:image/png;base64,${Buffer.concat([Buffer.from(imageUrl.split(',')[1]!, 'base64'), Buffer.alloc(800 * 1024)]).toString('base64')}`;
    assertProbe((await store.storeImage({ ...input, toolPairId: 'tool-call:image:0', imageUrl: largeImageUrl })).projectedImageUrl === imageUrl, '原图句柄不能配上重入请求中的另一张图');
    /** 超限图片只能通过显式原图读取获得内容。 */
    const largeImage = await store.storeImage({ ...input, toolPairId: 'large-call:image:0', imageUrl: largeImageUrl });
    assertProbe(largeImage.projectedImageUrl === null && (await store.storeImage({ ...input, toolPairId: 'large-call:image:0', imageUrl })).projectedImageUrl === null, '超限原图重入仍应保持有界热投影');
    assertProbe((await store.readImage({ conversationId: input.conversationId, handle: largeImage.record.handle, detail: 'original' })).imageUrl === largeImageUrl, '原图读取必须保留完整内容');
    assertProbe(database.countRows('artifact_owners') === database.countRows('conversation_tool_results'), '并发未采用的候选不能遗留 owner 引用');
    assertProbe(database.get<{ count: number }>(`SELECT COUNT(*) AS count FROM artifact_retention_holds WHERE state = 'active'`)?.count === database.countRows('conversation_tool_results'), '并发未采用的候选不能遗留活动保留锁');
    assertProbe(database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check === 'ok', '工具结果账本必须完整');
    observed.toolResultReplay = { originalRetained: true, concurrentText: true, concurrentImages: true, scopeIsolation: true, boundedImages: true, candidateReferencesReleased: true };
  } finally {
    await database.close();
  }
  /** 重开数据库排除仅靠进程内缓存去重的实现。 */
  const reopened = await createZeusDatabase(databasePath);
  try {
    /** 新实例仍通过已保存的唯一键复用结果。 */
    const store = new ManagedConversationToolResultStore(artifactRoot, new ConversationExecutionRepository(reopened), new ArtifactStore(reopened, artifactRoot, undefined, { minimumFreeBytes: 0 }));
    assertProbe((await store.store({ ...input, text: '重启后的完成回显' })).record.handle === originalHandle, '重启后的回显必须复用旧句柄');
    observed.toolResultReplayAfterReopen = true;
  } finally {
    await reopened.close();
  }
}

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
