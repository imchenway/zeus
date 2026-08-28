import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZeusDataLayout } from '../packages/local-server/src/zeusDataLayout.js';
import {
  expectedBundleIdForDataRootProfile,
  prepareZeusDataRootIdentity,
  readAndVerifyZeusDataRootIdentity,
  zeusDataRootHostIdentity,
  zeusDataRootIdentityPath,
  type ZeusDataRootHostIdentity,
  type ZeusDataRootProfile,
} from '../apps/desktop/src/main/dataRootIdentity.js';
import { executionHostProtocolVersion, executionHostRendezvousPath, type ExecutionHostRendezvous } from '../apps/desktop/src/main/executionHostProtocol.js';
import { startDesktopLocalServer } from '../apps/desktop/src/main/localServerRuntime.js';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.js';
import { prepareZeusDataRoot } from '../apps/desktop/src/main/zeusDataMigration.js';

const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-data-root-identity-')));
const observed: Record<string, unknown> = {};

try {
  const emptyTestRoot = join(probeRoot, 'empty-test-root');
  const test = claimEmptyRoot(emptyTestRoot, 'test');
  const testStats = await lstat(zeusDataRootIdentityPath(emptyTestRoot));
  observed.emptyRootClaim = {
    profile: test.marker.profile,
    bundleIdentityKind: test.marker.bundleIdentityKind,
    rootId: test.marker.rootId,
    mode: (testStats.mode & 0o777).toString(8).padStart(4, '0'),
    nlink: testStats.nlink,
  };
  assert.equal(observed.emptyRootClaim && (observed.emptyRootClaim as { mode: string }).mode, '0600');
  assert.equal(testStats.nlink, 1);

  const development = claimEmptyRoot(join(probeRoot, 'empty-development-root'), 'development');
  observed.bundleIdentitySemantics = {
    productionAndTestAreCodeSignBundleIds: test.marker.bundleIdentityKind === 'code_sign_bundle_id',
    developmentIsExplicitDistributionLabel: development.marker.bundleIdentityKind === 'development_distribution_label',
    developmentLabel: development.marker.bundleId,
  };
  assert.deepEqual(observed.bundleIdentitySemantics, {
    productionAndTestAreCodeSignBundleIds: true,
    developmentIsExplicitDistributionLabel: true,
    developmentLabel: 'dev.hypha.zeus.development',
  });

  const emptyProductionRoot = join(probeRoot, 'empty-production-root');
  const production = claimEmptyRoot(emptyProductionRoot, 'production');
  observed.profileIsolation = {
    testRejectsProduction: rejectionCode(() =>
      readAndVerifyZeusDataRootIdentity(emptyProductionRoot, {
        profile: 'test',
        bundleId: expectedBundleIdForDataRootProfile('test'),
        keychainService: test.keychainService,
      }),
    ),
    productionRejectsTest: rejectionCode(() =>
      readAndVerifyZeusDataRootIdentity(emptyTestRoot, {
        profile: 'production',
        bundleId: expectedBundleIdForDataRootProfile('production'),
        keychainService: production.keychainService,
      }),
    ),
  };
  assert.deepEqual(observed.profileIsolation, {
    testRejectsProduction: 'ZEUS_DATA_ROOT_PROFILE_MISMATCH',
    productionRejectsTest: 'ZEUS_DATA_ROOT_PROFILE_MISMATCH',
  });

  const customRoot = join(probeRoot, 'unmarked-custom-root');
  await mkdir(customRoot, { mode: 0o700 });
  const sentinel = join(customRoot, 'existing-user-data.txt');
  await writeFile(sentinel, 'must-survive\n', { mode: 0o600 });
  const customService = resolveDesktopKeychainService({ profile: 'test', dataRootPath: customRoot });
  observed.unmarkedCustomRoot = {
    rejection: rejectionCode(() =>
      prepareZeusDataRootIdentity({
        rootPath: customRoot,
        profile: 'test',
        bundleId: expectedBundleIdForDataRootProfile('test'),
        keychainService: customService,
      }),
    ),
    markerAbsent: !(await pathExists(zeusDataRootIdentityPath(customRoot))),
    sentinel: await readFile(sentinel, 'utf8'),
  };
  assert.deepEqual(observed.unmarkedCustomRoot, {
    rejection: 'ZEUS_DATA_ROOT_OFFLINE_ADOPTION_REQUIRED',
    markerAbsent: true,
    sentinel: 'must-survive\n',
  });

  const knownLegacyRoot = join(probeRoot, 'known-production-legacy-root');
  await mkdir(knownLegacyRoot, { mode: 0o700 });
  await writeFile(join(knownLegacyRoot, 'zeus.config.json'), '{}\n', { mode: 0o600 });
  const legacyPreparation = prepareZeusDataRoot(knownLegacyRoot, [], {
    profile: 'production',
    bundleId: expectedBundleIdForDataRootProfile('production'),
    keychainService: production.keychainService,
    knownProductionAdoptionRoots: [knownLegacyRoot],
  });
  observed.knownLegacyAdoption = {
    status: legacyPreparation.status,
    profile: legacyPreparation.rootIdentity.profile,
    markerMode: ((await lstat(zeusDataRootIdentityPath(knownLegacyRoot))).mode & 0o777).toString(8).padStart(4, '0'),
  };
  assert.deepEqual(observed.knownLegacyAdoption, { status: 'initialized', profile: 'production', markerMode: '0600' });

  const writerFenceResults: Record<string, unknown> = {};
  for (const metadataName of ['host.lock', 'rendezvous.json'] as const) {
    const root = join(probeRoot, `known-production-${metadataName.replace('.', '-')}`);
    const hostDirectory = createZeusDataLayout(root).executionHost;
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(root, 'zeus.config.json'), '{}\n', { mode: 0o600 });
    await writeFile(join(hostDirectory, metadataName), '{}\n', { mode: 0o600 });
    writerFenceResults[metadataName] = {
      rejection: rejectionCode(() => prepareKnownProductionRoot(root)),
      markerAbsent: !(await pathExists(zeusDataRootIdentityPath(root))),
    };
  }
  const leasedRoot = join(probeRoot, 'known-production-kernel-lease');
  const leasedHostDirectory = createZeusDataLayout(leasedRoot).executionHost;
  await mkdir(leasedHostDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(leasedRoot, 'zeus.config.json'), '{}\n', { mode: 0o600 });
  const heldLease = new DatabaseSync(join(leasedHostDirectory, 'owner-lease.sqlite'));
  heldLease.exec('BEGIN EXCLUSIVE');
  try {
    writerFenceResults.kernelLease = {
      rejection: rejectionCode(() => prepareKnownProductionRoot(leasedRoot)),
      markerAbsent: !(await pathExists(zeusDataRootIdentityPath(leasedRoot))),
    };
  } finally {
    heldLease.exec('ROLLBACK');
    heldLease.close();
  }
  observed.knownLegacyWriterFences = writerFenceResults;
  assert.deepEqual(writerFenceResults, {
    'host.lock': { rejection: 'ZEUS_DATA_ROOT_OFFLINE_ADOPTION_REQUIRED', markerAbsent: true },
    'rendezvous.json': { rejection: 'ZEUS_DATA_ROOT_OFFLINE_ADOPTION_REQUIRED', markerAbsent: true },
    kernelLease: { rejection: 'ZEUS_DATA_ROOT_OFFLINE_ADOPTION_REQUIRED', markerAbsent: true },
  });

  const reusedRoot = join(probeRoot, 'reused-root-id');
  await mkdir(reusedRoot, { mode: 0o700 });
  await cp(zeusDataRootIdentityPath(emptyTestRoot), zeusDataRootIdentityPath(reusedRoot));
  await chmod(zeusDataRootIdentityPath(reusedRoot), 0o600);
  observed.rootIdReuseRejected = rejectionCode(() => readAndVerifyZeusDataRootIdentity(reusedRoot));
  assert.equal(observed.rootIdReuseRejected, 'ZEUS_DATA_ROOT_IDENTITY_REUSED');

  const symlinkRoot = join(probeRoot, 'test-root-alias');
  await symlink(emptyTestRoot, symlinkRoot);
  observed.symlinkRejected = rejectionCode(() => readAndVerifyZeusDataRootIdentity(symlinkRoot));
  assert.equal(observed.symlinkRejected, 'ZEUS_DATA_ROOT_PATH_UNSAFE');

  observed.oppositeHostFences = {
    testRejectsProductionHost: await verifyOppositeHostRejectedBeforeEffects({
      root: emptyTestRoot,
      ownIdentity: test.hostIdentity,
      ownKeychainService: test.keychainService,
      oppositeIdentity: production.hostIdentity,
    }),
    productionRejectsTestHost: await verifyOppositeHostRejectedBeforeEffects({
      root: emptyProductionRoot,
      ownIdentity: production.hostIdentity,
      ownKeychainService: production.keychainService,
      oppositeIdentity: test.hostIdentity,
    }),
  };
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ status: 'passed', observed }, null, 2)}\n`);

function claimEmptyRoot(root: string, profile: ZeusDataRootProfile): { marker: ReturnType<typeof prepareZeusDataRootIdentity>; hostIdentity: ZeusDataRootHostIdentity; keychainService: string } {
  const keychainService = resolveDesktopKeychainService({ profile, dataRootPath: root });
  const marker = prepareZeusDataRootIdentity({
    rootPath: root,
    profile,
    bundleId: expectedBundleIdForDataRootProfile(profile),
    keychainService,
  });
  return { marker, hostIdentity: zeusDataRootHostIdentity(marker), keychainService };
}

function prepareKnownProductionRoot(root: string): ReturnType<typeof prepareZeusDataRoot> {
  return prepareZeusDataRoot(root, [], {
    profile: 'production',
    bundleId: expectedBundleIdForDataRootProfile('production'),
    keychainService: resolveDesktopKeychainService({ profile: 'production', dataRootPath: root }),
    knownProductionAdoptionRoots: [root],
  });
}

async function verifyOppositeHostRejectedBeforeEffects(input: { root: string; ownIdentity: ZeusDataRootHostIdentity; ownKeychainService: string; oppositeIdentity: ZeusDataRootHostIdentity }): Promise<Record<string, unknown>> {
  const layout = createZeusDataLayout(input.root);
  await mkdir(layout.executionHost, { recursive: true, mode: 0o700 });
  const rendezvous: ExecutionHostRendezvous = {
    protocolVersion: executionHostProtocolVersion,
    instanceId: '88888888-8888-4888-8888-888888888888',
    pid: process.pid,
    appVersion: 'identity-probe',
    baseUrl: 'http://127.0.0.1:48881',
    apiToken: 'synthetic-api-token',
    controlUrl: 'http://127.0.0.1:48882',
    controlToken: 'synthetic-control-token',
    dbPath: layout.database,
    projectRoot: probeRoot,
    dataRootIdentity: input.oppositeIdentity,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ownershipMode: 'kernel_lease_v1',
  };
  await writeFile(executionHostRendezvousPath(input.root), `${JSON.stringify(rendezvous)}\n`, { mode: 0o600, flag: 'wx' });
  const treeBefore = await treeEvidence(input.root);
  let browserInvokeCount = 0;
  const error = await captureRejectionAsync(() =>
    startDesktopLocalServer({
      userDataPath: input.root,
      dataLayout: layout,
      projectRoot: probeRoot,
      dataRootIdentity: input.ownIdentity,
      keychainService: input.ownKeychainService,
      appVersion: 'identity-probe',
      codexNativeEnabled: false,
      conversationAttachmentGrantSecretPath: layout.conversationAttachmentGrantSecret,
      browserAutomation: {
        invoke: async () => {
          browserInvokeCount += 1;
          return { success: false, contentItems: [{ type: 'inputText' as const, text: 'must-not-run' }] };
        },
      },
    }),
  );
  const treeAfter = await treeEvidence(input.root);
  await rm(executionHostRendezvousPath(input.root));
  assert.equal(error.code, 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH');
  assert.equal(browserInvokeCount, 0);
  assert.deepEqual(treeAfter, treeBefore);
  assert.equal(await pathExists(layout.database), false);
  assert.equal(await pathExists(join(layout.executionHost, 'owner-lease.sqlite')), false);
  return { code: error.code, browserInvokeCount, treeUnchanged: true, databaseAbsent: true, ownerLeaseAbsent: true };
}

function rejectionCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : String(error);
  }
}

async function captureRejectionAsync(operation: () => Promise<unknown>): Promise<{ code: string | null; message: string }> {
  try {
    await operation();
    throw new Error('expected rejection');
  } catch (error) {
    return {
      code: error instanceof Error && 'code' in error ? String(error.code) : null,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function treeEvidence(root: string): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  await visit(root);
  return output.sort((left, right) => String(left.path).localeCompare(String(right.path)));

  async function visit(path: string): Promise<void> {
    const stats = await lstat(path);
    const pathFromRoot = relative(root, path) || '.';
    if (stats.isDirectory()) {
      output.push({ path: pathFromRoot, type: 'directory', mode: stats.mode & 0o777 });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    const bytes = await readFile(path);
    output.push({ path: pathFromRoot, type: 'file', mode: stats.mode & 0o777, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
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
