import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ReadOnlyValidationIdentity } from '@zeus/shared';
import { createZeusDataLayout } from '../packages/local-server/src/zeusDataLayout.js';
import { expectedBundleIdForDataRootProfile, prepareZeusDataRootIdentity, zeusDataRootHostIdentity, type ZeusDataRootHostIdentity } from '../apps/desktop/src/main/dataRootIdentity.js';
import {
  acquireExecutionHostKernelLease,
  executionHostLockPath,
  executionHostProtocolVersion,
  executionHostRendezvousPath,
  inspectExecutionHostKernelLease,
  readExecutionHostLockObservation,
  writeExecutionHostLockIdentity,
  writeExecutionHostRendezvous,
  writeExecutionHostStartupStatus,
  type ExecutionHostKernelLease,
  type ExecutionHostLockIdentity,
} from '../apps/desktop/src/main/executionHostProtocol.js';
import { readExecutionHostOwnerState } from '../apps/desktop/src/main/localServerRuntime.js';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.js';

const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-execution-host-v2-crash-recovery-')));
const observed: Record<string, unknown> = {};

try {
  const crashRoot = await createSyntheticRoot('crash-recovery');
  const generationA = randomUUID();
  const generationB = randomUUID();
  const lockA = lockIdentity(generationA, crashRoot.identity);
  const leaseA = acquireExecutionHostKernelLease(crashRoot.root, crashRoot.identity);
  await writeExecutionHostLockIdentity(crashRoot.root, lockA, leaseA);
  await writeExecutionHostStartupStatus(crashRoot.root, {
    protocolVersion: executionHostProtocolVersion,
    generationId: generationA,
    pid: process.pid,
    appVersion: 'crashed-v2-a',
    stage: 'control_ready',
    startedAt: lockA.createdAt,
    updatedAt: new Date().toISOString(),
    dataRootIdentity: crashRoot.identity,
  });
  await writeExecutionHostRendezvous(crashRoot.root, rendezvous(generationA, crashRoot.identity));
  const activeOwner = await readExecutionHostOwnerState(crashRoot.root, crashRoot.identity);
  assert.equal(activeOwner.ownerPresent, true);
  assert.equal(activeOwner.kernelLeaseHeld, true);

  // 模拟 SIGKILL：OS 释放 kernel lease，但 Host 没有执行任何 metadata cleanup。
  leaseA.close();
  assert.equal(inspectExecutionHostKernelLease(crashRoot.root, crashRoot.identity), 'available');
  const staleOwner = await readExecutionHostOwnerState(crashRoot.root, crashRoot.identity);
  assert.equal(staleOwner.ownerPresent, false);
  assert.equal(staleOwner.recoverableStaleV2, true);
  assert.equal(staleOwner.pid, process.pid, 'PID 即使仍存活/被复用，也不能否决已释放 lease 的 v2 恢复');

  const leaseB = acquireExecutionHostKernelLease(crashRoot.root, crashRoot.identity);
  const lockB = lockIdentity(generationB, crashRoot.identity);
  await writeExecutionHostLockIdentity(crashRoot.root, lockB, leaseB);
  const currentAfterRecovery = await readExecutionHostLockObservation(crashRoot.root);
  assert.equal(currentAfterRecovery.kind, 'current');
  assert.equal(currentAfterRecovery.kind === 'current' ? currentAfterRecovery.identity.generationId : null, generationB);
  const quarantine = await quarantineEvidence(crashRoot.root);
  assert.equal(quarantine.files.length, 1);
  assert.deepEqual(JSON.parse(quarantine.files[0]!.content) as unknown, lockA);
  assert.equal(quarantine.files[0]!.mode, '0600');
  assert.equal(quarantine.files[0]!.nlink, 1);
  const currentStats = await lstat(executionHostLockPath(crashRoot.root));
  assert.equal(currentStats.mode & 0o777, 0o600);
  assert.equal(currentStats.nlink, 1);
  observed.crashRecovery = {
    staleOwnerRecoverable: true,
    pidReuseIgnored: true,
    oldGeneration: generationA,
    newGeneration: generationB,
    quarantineMode: quarantine.files[0]!.mode,
    quarantineNlink: quarantine.files[0]!.nlink,
    currentLockMode: (currentStats.mode & 0o777).toString(8).padStart(4, '0'),
    currentLockNlink: currentStats.nlink,
  };
  leaseB.close();

  const concurrentRoot = await createStaleV2Root('concurrent');
  const contender = async (generationId: string): Promise<{ generationId: string; outcome: string }> => {
    let lease: ExecutionHostKernelLease | undefined;
    try {
      lease = acquireExecutionHostKernelLease(concurrentRoot.root, concurrentRoot.identity);
      await writeExecutionHostLockIdentity(concurrentRoot.root, lockIdentity(generationId, concurrentRoot.identity), lease);
      return { generationId, outcome: 'won' };
    } catch (error) {
      return { generationId, outcome: errorCode(error) };
    } finally {
      lease?.close();
    }
  };
  const contenderResults = await Promise.all([contender(randomUUID()), contender(randomUUID())]);
  assert.equal(contenderResults.filter((item) => item.outcome === 'won').length, 1);
  assert.equal(contenderResults.filter((item) => item.outcome === 'ZEUS_EXECUTION_HOST_LEASE_HELD').length, 1);
  const concurrentLock = await readExecutionHostLockObservation(concurrentRoot.root);
  assert.equal(concurrentLock.kind, 'current');
  assert.equal(concurrentLock.kind === 'current' ? contenderResults.some((item) => item.outcome === 'won' && item.generationId === concurrentLock.identity.generationId) : false, true);
  observed.concurrentRecovery = { contenders: contenderResults, exactlyOneWinner: true };

  const activeRoot = await createSyntheticRoot('active-owner');
  const activeLease = acquireExecutionHostKernelLease(activeRoot.root, activeRoot.identity);
  await writeExecutionHostLockIdentity(activeRoot.root, lockIdentity(randomUUID(), activeRoot.identity), activeLease);
  const activeBefore = await fileEvidence(executionHostLockPath(activeRoot.root));
  const activeCollision = errorCode(capture(() => acquireExecutionHostKernelLease(activeRoot.root, activeRoot.identity)));
  assert.equal(activeCollision, 'ZEUS_EXECUTION_HOST_LEASE_HELD');
  assert.deepEqual(await fileEvidence(executionHostLockPath(activeRoot.root)), activeBefore);
  assert.equal(await pathExists(join(createZeusDataLayout(activeRoot.root).executionHost, 'quarantine')), false);
  activeLease.close();
  observed.activeOwner = { collisionCode: activeCollision, lockUnchanged: true, quarantineAbsent: true };

  const idempotentRoot = await createStaleV2Root('quarantine-idempotency');
  const staleSerialized = await readFile(executionHostLockPath(idempotentRoot.root), 'utf8');
  const staleHash = createHash('sha256').update(staleSerialized).digest('hex');
  const quarantineDirectory = join(createZeusDataLayout(idempotentRoot.root).executionHost, 'quarantine');
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
  await link(executionHostLockPath(idempotentRoot.root), join(quarantineDirectory, `host-lock-v2-${staleHash}.json`));
  const idempotentLease = acquireExecutionHostKernelLease(idempotentRoot.root, idempotentRoot.identity);
  await writeExecutionHostLockIdentity(idempotentRoot.root, lockIdentity(randomUUID(), idempotentRoot.identity), idempotentLease);
  idempotentLease.close();
  const idempotentQuarantine = await quarantineEvidence(idempotentRoot.root);
  assert.equal(idempotentQuarantine.files.length, 1);
  assert.equal(idempotentQuarantine.files[0]!.nlink, 1);
  observed.quarantineResume = { preexistingCasLinkAccepted: true, finalNlink: idempotentQuarantine.files[0]!.nlink };

  const oppositeRoot = await createSyntheticRoot('opposite-identity-source');
  const mismatchRoot = await createSyntheticRoot('opposite-identity-target');
  const mismatchLock = lockIdentity(randomUUID(), oppositeRoot.identity);
  await writeRawLock(mismatchRoot.root, mismatchLock);
  const mismatchBefore = await fileEvidence(executionHostLockPath(mismatchRoot.root));
  const mismatchOwner = await readExecutionHostOwnerState(mismatchRoot.root, mismatchRoot.identity);
  assert.equal(mismatchOwner.recoverableStaleV2, undefined);
  const mismatchLease = acquireExecutionHostKernelLease(mismatchRoot.root, mismatchRoot.identity);
  const mismatchCode = await rejectionCodeAsync(() => writeExecutionHostLockIdentity(mismatchRoot.root, lockIdentity(randomUUID(), mismatchRoot.identity), mismatchLease));
  mismatchLease.close();
  assert.equal(mismatchCode, 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH');
  assert.deepEqual(await fileEvidence(executionHostLockPath(mismatchRoot.root)), mismatchBefore);
  assert.equal(await pathExists(join(createZeusDataLayout(mismatchRoot.root).executionHost, 'quarantine')), false);
  observed.oppositeIdentity = { code: mismatchCode, originalLockUnchanged: true, quarantineAbsent: true };

  const validationRoot = await createSyntheticRoot('validation-mismatch');
  const validationA = validationIdentity('a');
  const validationB = validationIdentity('b');
  const validationLeaseA = acquireExecutionHostKernelLease(validationRoot.root, validationRoot.identity);
  await writeExecutionHostLockIdentity(validationRoot.root, lockIdentity(randomUUID(), validationRoot.identity, validationA), validationLeaseA);
  validationLeaseA.close();
  const validationBefore = await fileEvidence(executionHostLockPath(validationRoot.root));
  const validationOwner = await readExecutionHostOwnerState(validationRoot.root, validationRoot.identity, validationB);
  assert.equal(validationOwner.recoverableStaleV2, undefined);
  const validationLeaseB = acquireExecutionHostKernelLease(validationRoot.root, validationRoot.identity);
  const validationCode = await rejectionCodeAsync(() => writeExecutionHostLockIdentity(validationRoot.root, lockIdentity(randomUUID(), validationRoot.identity, validationB), validationLeaseB));
  validationLeaseB.close();
  assert.equal(validationCode, 'ZEUS_EXECUTION_HOST_VALIDATION_IDENTITY_MISMATCH');
  assert.deepEqual(await fileEvidence(executionHostLockPath(validationRoot.root)), validationBefore);
  observed.validationMismatch = { code: validationCode, originalLockUnchanged: true };

  const companionRoot = await createStaleV2Root('companion-mismatch');
  await writeFile(executionHostRendezvousPath(companionRoot.root), `${JSON.stringify(rendezvous(randomUUID(), oppositeRoot.identity))}\n`, { mode: 0o600 });
  const companionBefore = await fileEvidence(executionHostLockPath(companionRoot.root));
  const companionLease = acquireExecutionHostKernelLease(companionRoot.root, companionRoot.identity);
  const companionCode = await rejectionCodeAsync(() => writeExecutionHostLockIdentity(companionRoot.root, lockIdentity(randomUUID(), companionRoot.identity), companionLease));
  companionLease.close();
  assert.equal(companionCode, 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH');
  assert.deepEqual(await fileEvidence(executionHostLockPath(companionRoot.root)), companionBefore);
  observed.companionMismatch = { code: companionCode, originalLockUnchanged: true };

  const driftRoot = await createSyntheticRoot('path-drift');
  const layout = createZeusDataLayout(driftRoot.root);
  const redirectedRuntime = join(probeRoot, 'redirected-runtime');
  await mkdir(join(redirectedRuntime, 'execution-host'), { recursive: true, mode: 0o700 });
  await symlink(redirectedRuntime, layout.runtimeDirectory);
  const driftCode = errorCode(capture(() => acquireExecutionHostKernelLease(driftRoot.root, driftRoot.identity)));
  assert.equal(driftCode, 'ZEUS_EXECUTION_HOST_PATH_DRIFT');
  assert.deepEqual(await readdir(join(redirectedRuntime, 'execution-host')), []);
  observed.pathDrift = { code: driftCode, redirectedDirectoryUnchanged: true };
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ status: 'passed', probeRootKind: 'temporary-synthetic-only', observed }, null, 2)}\n`);

async function createSyntheticRoot(name: string): Promise<{ root: string; identity: ZeusDataRootHostIdentity }> {
  const root = join(probeRoot, name);
  await mkdir(root, { mode: 0o700 });
  const profile = 'test' as const;
  const marker = prepareZeusDataRootIdentity({
    rootPath: root,
    profile,
    bundleId: expectedBundleIdForDataRootProfile(profile),
    keychainService: resolveDesktopKeychainService({ profile, dataRootPath: root }),
  });
  await mkdir(join(root, 'data'), { mode: 0o700 });
  return { root: await realpath(root), identity: zeusDataRootHostIdentity(marker) };
}

async function createStaleV2Root(name: string) {
  const value = await createSyntheticRoot(name);
  const lease = acquireExecutionHostKernelLease(value.root, value.identity);
  const identity = lockIdentity(randomUUID(), value.identity);
  await writeExecutionHostLockIdentity(value.root, identity, lease);
  lease.close();
  return { ...value, staleLock: identity };
}

function lockIdentity(generationId: string, dataRootIdentity: ZeusDataRootHostIdentity, readOnlyValidation?: ReadOnlyValidationIdentity): ExecutionHostLockIdentity {
  return {
    protocolVersion: executionHostProtocolVersion,
    generationId,
    pid: process.pid,
    appVersion: `crash-probe-${generationId.slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    ownershipMode: 'kernel_lease_v1',
    dataRootIdentity,
    ...(readOnlyValidation ? { readOnlyValidation } : {}),
  };
}

function rendezvous(instanceId: string, dataRootIdentity: ZeusDataRootHostIdentity) {
  const now = new Date().toISOString();
  return {
    protocolVersion: executionHostProtocolVersion,
    instanceId,
    pid: process.pid,
    appVersion: 'crash-probe',
    baseUrl: 'http://127.0.0.1:48101',
    apiToken: 'synthetic-api-token',
    controlUrl: 'http://127.0.0.1:48102',
    controlToken: 'synthetic-control-token',
    dbPath: createZeusDataLayout(dataRootIdentity.profile === 'test' ? findRootForIdentity(dataRootIdentity) : '').database,
    projectRoot: probeRoot,
    dataRootIdentity,
    startedAt: now,
    updatedAt: now,
    ownershipMode: 'kernel_lease_v1' as const,
  };
}

function findRootForIdentity(identity: ZeusDataRootHostIdentity): string {
  // Rendezvous parser 只要求非空规范字段；真实路径绑定由 bootstrap/Host 启动链校验。
  return join(probeRoot, `identity-${identity.rootId}`);
}

function validationIdentity(seed: string): ReadOnlyValidationIdentity {
  return {
    mode: 'read_only_validation',
    runId: `run-${seed}`,
    manifestHash: seed.repeat(64).slice(0, 64),
    databaseSha256: (seed === 'a' ? 'b' : 'c').repeat(64),
  };
}

async function writeRawLock(root: string, identity: ExecutionHostLockIdentity): Promise<void> {
  const path = executionHostLockPath(root);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(identity)}\n`, { mode: 0o600, flag: 'wx' });
}

async function quarantineEvidence(root: string): Promise<{ mode: string; files: Array<{ name: string; mode: string; nlink: number; content: string }> }> {
  const directory = join(createZeusDataLayout(root).executionHost, 'quarantine');
  const stats = await lstat(directory);
  const files = await Promise.all(
    (await readdir(directory)).sort().map(async (name) => {
      const path = join(directory, name);
      const fileStats = await lstat(path);
      return { name, mode: (fileStats.mode & 0o777).toString(8).padStart(4, '0'), nlink: fileStats.nlink, content: await readFile(path, 'utf8') };
    }),
  );
  return { mode: (stats.mode & 0o777).toString(8).padStart(4, '0'), files };
}

async function fileEvidence(path: string): Promise<Record<string, unknown>> {
  const stats = await lstat(path);
  const bytes = await readFile(path);
  return {
    device: stats.dev,
    inode: stats.ino,
    mode: stats.mode & 0o777,
    nlink: stats.nlink,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function capture(operation: () => unknown): unknown {
  try {
    return operation();
  } catch (error) {
    return error;
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : String(error);
}

async function rejectionCodeAsync(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
