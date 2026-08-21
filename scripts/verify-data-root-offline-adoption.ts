import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  adoptZeusDataRootOffline,
  expectedBundleIdForDataRootProfile,
  planZeusDataRootOfflineAdoption,
  readAndVerifyZeusDataRootIdentity,
  zeusDataRootIdentityPath,
  type ZeusDataRootOfflineAdoptionProfile,
} from '../apps/desktop/src/main/dataRootIdentity.js';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-data-root-offline-adoption-')));
const observed: Record<string, unknown> = {};

try {
  observed.noArgumentCli = await verifyNoArgumentCli(probeRoot);

  const productionRoot = await createSyntheticZeusRoot(join(probeRoot, 'production-cli-success'), 'layered');
  const productionBefore = await treeEvidence(productionRoot);
  const planned = runCli([
    '--data-root',
    productionRoot,
    '--profile',
    'production',
    '--distribution-label',
    expectedBundleIdForDataRootProfile('production'),
    '--plan',
  ]);
  assert.equal(planned.status, 0, planned.stderr);
  const planOutput = JSON.parse(planned.stdout) as { status: string; plan: { confirmationToken: string; layoutKind: string; rootDevice: string; rootInode: string } };
  assert.equal(planOutput.status, 'confirmation-required');
  assert.equal(planOutput.plan.layoutKind, 'layered');
  assert.match(planOutput.plan.rootDevice, /^\d+$/u);
  assert.match(planOutput.plan.rootInode, /^\d+$/u);
  assert.deepEqual(await treeEvidence(productionRoot), productionBefore);
  const adopted = runCli([
    '--data-root',
    productionRoot,
    '--profile',
    'production',
    '--distribution-label',
    expectedBundleIdForDataRootProfile('production'),
    '--confirm-token',
    planOutput.plan.confirmationToken,
  ]);
  assert.equal(adopted.status, 0, adopted.stderr);
  const productionMarker = readAndVerifyZeusDataRootIdentity(productionRoot, {
    profile: 'production',
    bundleId: expectedBundleIdForDataRootProfile('production'),
    keychainService: resolveDesktopKeychainService({ profile: 'production', dataRootPath: productionRoot }),
  });
  const productionMarkerStats = await lstat(zeusDataRootIdentityPath(productionRoot));
  assert.equal(productionMarkerStats.mode & 0o777, 0o600);
  assert.equal(productionMarkerStats.nlink, 1);
  assert.equal((await readdir(productionRoot)).some((name) => name.includes('.zeus-root-identity.json.') && name.endsWith('.tmp')), false);
  observed.productionCliSuccess = {
    profile: productionMarker.profile,
    rootId: productionMarker.rootId,
    markerMode: (productionMarkerStats.mode & 0o777).toString(8).padStart(4, '0'),
    markerNlink: productionMarkerStats.nlink,
    preexistingTreePreserved: (await readFile(join(productionRoot, 'data', 'business-sentinel.txt'), 'utf8')) === 'preserve-business-data\n',
  };

  const testRoot = await createSyntheticZeusRoot(join(probeRoot, 'test-success'), 'legacy-flat');
  const testRequest = requestFor(testRoot, 'test');
  const testPlan = planZeusDataRootOfflineAdoption(testRequest);
  assert.equal(testPlan.layoutKind, 'legacy-flat');
  const testMarker = adoptZeusDataRootOffline({ ...testRequest, confirmationToken: testPlan.confirmationToken });
  assert.equal(testMarker.profile, 'test');
  assert.equal(testMarker.bundleId, 'dev.hypha.zeus.test');
  observed.testSuccess = {
    profile: testMarker.profile,
    distributionLabel: testMarker.bundleId,
    layoutKind: testPlan.layoutKind,
    keychainIdentityBound: testPlan.keychainServiceIdentitySha256 === testMarker.keychainServiceIdentitySha256,
  };

  const confirmationRoot = await createSyntheticZeusRoot(join(probeRoot, 'confirmation-mismatch'), 'layered');
  const confirmationRequest = requestFor(confirmationRoot, 'production');
  const confirmationPlan = planZeusDataRootOfflineAdoption(confirmationRequest);
  const confirmationBefore = await treeEvidence(confirmationRoot);
  const confirmationCode = rejectionCode(() =>
    adoptZeusDataRootOffline({
      ...confirmationRequest,
      confirmationToken: confirmationPlan.confirmationToken === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64),
    }),
  );
  assert.equal(confirmationCode, 'ZEUS_DATA_ROOT_OFFLINE_CONFIRMATION_MISMATCH');
  assert.deepEqual(await treeEvidence(confirmationRoot), confirmationBefore);
  observed.confirmationMismatch = { code: confirmationCode, treeUnchanged: true, markerAbsent: !(await pathExists(zeusDataRootIdentityPath(confirmationRoot))) };

  const hostBlockers: Record<string, unknown> = {};
  for (const name of ['host.lock', 'rendezvous.json', 'startup.json', 'owner-lease.sqlite', 'bootstrap-in-flight.json', '.host-lock-in-flight.tmp']) {
    const root = await createSyntheticZeusRoot(join(probeRoot, `host-${safeName(name)}`), 'layered');
    const path = join(root, 'runtime', 'execution-host', name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, '{}\n', { mode: 0o600 });
    hostBlockers[name] = await expectRejectedWithoutTreeMutation(root, () => planZeusDataRootOfflineAdoption(requestFor(root, 'production')), 'ZEUS_DATA_ROOT_OFFLINE_HOST_METADATA_PRESENT');
  }
  observed.hostBlockers = hostBlockers;

  const sqliteSidecars: Record<string, unknown> = {};
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const root = await createSyntheticZeusRoot(join(probeRoot, `sidecar-${safeName(suffix)}`), 'layered');
    await writeFile(join(root, 'data', `zeus.db${suffix}`), 'synthetic-sidecar\n', { mode: 0o600 });
    sqliteSidecars[suffix] = await expectRejectedWithoutTreeMutation(root, () => planZeusDataRootOfflineAdoption(requestFor(root, 'production')), 'ZEUS_DATA_ROOT_OFFLINE_SQLITE_SIDECAR_PRESENT');
  }
  observed.sqliteSidecars = sqliteSidecars;

  const writerRoot = await createSyntheticZeusRoot(join(probeRoot, 'observable-writer'), 'layered');
  const writerDatabase = new DatabaseSync(join(writerRoot, 'data', 'zeus.db'));
  writerDatabase.exec('BEGIN EXCLUSIVE');
  try {
    observed.observableWriter = await expectRejectedWithoutTreeMutation(
      writerRoot,
      () => planZeusDataRootOfflineAdoption(requestFor(writerRoot, 'production')),
      'ZEUS_DATA_ROOT_OFFLINE_WRITER_OBSERVED',
    );
  } finally {
    writerDatabase.exec('ROLLBACK');
    writerDatabase.close();
  }

  const markerBefore = await treeEvidence(productionRoot);
  const existingMarkerCode = rejectionCode(() => planZeusDataRootOfflineAdoption(requestFor(productionRoot, 'production')));
  assert.equal(existingMarkerCode, 'ZEUS_DATA_ROOT_IDENTITY_EXISTS');
  assert.deepEqual(await treeEvidence(productionRoot), markerBefore);
  observed.existingMarker = { code: existingMarkerCode, treeUnchanged: true };

  const symlinkTarget = await createSyntheticZeusRoot(join(probeRoot, 'symlink-target'), 'layered');
  const symlinkAlias = join(probeRoot, 'symlink-alias');
  await symlink(symlinkTarget, symlinkAlias);
  const symlinkBefore = await treeEvidence(symlinkTarget);
  const symlinkCode = rejectionCode(() => planZeusDataRootOfflineAdoption(requestFor(symlinkAlias, 'test')));
  assert.ok(symlinkCode === 'ZEUS_DATA_ROOT_PATH_UNSAFE' || symlinkCode === 'ZEUS_DATA_ROOT_OFFLINE_SYMLINK_REJECTED');
  assert.deepEqual(await treeEvidence(symlinkTarget), symlinkBefore);
  observed.symlinkRoot = { code: symlinkCode, targetTreeUnchanged: true };

  const hardlinkRoot = await createSyntheticZeusRoot(join(probeRoot, 'hardlink-root'), 'layered');
  await link(join(hardlinkRoot, 'data', 'business-sentinel.txt'), join(hardlinkRoot, 'data', 'business-sentinel-hardlink.txt'));
  observed.hardlink = await expectRejectedWithoutTreeMutation(
    hardlinkRoot,
    () => planZeusDataRootOfflineAdoption(requestFor(hardlinkRoot, 'test')),
    'ZEUS_DATA_ROOT_OFFLINE_HARDLINK_REJECTED',
  );

  const ordinaryDirectory = join(probeRoot, 'not-a-zeus-root');
  await mkdir(ordinaryDirectory, { mode: 0o700 });
  await writeFile(join(ordinaryDirectory, 'notes.txt'), 'not Zeus\n', { mode: 0o600 });
  observed.notZeusRoot = await expectRejectedWithoutTreeMutation(
    ordinaryDirectory,
    () => planZeusDataRootOfflineAdoption(requestFor(ordinaryDirectory, 'production')),
    'ZEUS_DATA_ROOT_OFFLINE_NOT_ZEUS_ROOT',
  );

  const stalePlanRoot = await createSyntheticZeusRoot(join(probeRoot, 'stale-plan'), 'layered');
  const staleRequest = requestFor(stalePlanRoot, 'production');
  const stalePlan = planZeusDataRootOfflineAdoption(staleRequest);
  await writeFile(join(stalePlanRoot, 'data', 'business-sentinel.txt'), 'operator changed data after plan\n', { mode: 0o600 });
  const staleBeforeApply = await treeEvidence(stalePlanRoot);
  const staleCode = rejectionCode(() => adoptZeusDataRootOffline({ ...staleRequest, confirmationToken: stalePlan.confirmationToken }));
  assert.equal(staleCode, 'ZEUS_DATA_ROOT_OFFLINE_CONFIRMATION_MISMATCH');
  assert.deepEqual(await treeEvidence(stalePlanRoot), staleBeforeApply);
  observed.stalePlan = { code: staleCode, treeUnchangedDuringApply: true, markerAbsent: !(await pathExists(zeusDataRootIdentityPath(stalePlanRoot))) };

  const distributionRoot = await createSyntheticZeusRoot(join(probeRoot, 'distribution-mismatch'), 'layered');
  observed.distributionMismatch = await expectRejectedWithoutTreeMutation(
    distributionRoot,
    () =>
      planZeusDataRootOfflineAdoption({
        rootPath: distributionRoot,
        profile: 'test',
        distributionLabel: expectedBundleIdForDataRootProfile('production'),
      }),
    'ZEUS_DATA_ROOT_OFFLINE_DISTRIBUTION_MISMATCH',
  );
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ status: 'passed', probeRootKind: 'temporary-synthetic-only', observed }, null, 2)}\n`);

function requestFor(rootPath: string, profile: ZeusDataRootOfflineAdoptionProfile) {
  return { rootPath, profile, distributionLabel: expectedBundleIdForDataRootProfile(profile) } as const;
}

async function createSyntheticZeusRoot(root: string, layoutKind: 'layered' | 'legacy-flat'): Promise<string> {
  const databasePath = layoutKind === 'layered' ? join(root, 'data', 'zeus.db') : join(root, 'zeus.db');
  const configPath = layoutKind === 'layered' ? join(root, 'data', 'zeus.config.json') : join(root, 'zeus.config.json');
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE business_evidence (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO business_evidence(value) VALUES (\'preserve\')');
  database.close();
  await chmod(databasePath, 0o600);
  await writeFile(configPath, '{}\n', { mode: 0o600 });
  await writeFile(join(dirname(databasePath), 'business-sentinel.txt'), 'preserve-business-data\n', { mode: 0o600 });
  return realpath(root);
}

async function verifyNoArgumentCli(root: string): Promise<Record<string, unknown>> {
  const fakeHome = join(root, 'synthetic-home');
  const fakeDefaultRoot = join(fakeHome, '.zeus');
  await mkdir(fakeDefaultRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(fakeDefaultRoot, 'sentinel.txt'), 'must-not-be-read-or-changed\n', { mode: 0o600 });
  const before = await treeEvidence(fakeHome);
  const env = { ...process.env, HOME: fakeHome, ZEUS_USER_DATA_DIR: fakeDefaultRoot };
  const cases = [
    { name: 'no-arguments', args: [], expectedStatus: 2 },
    { name: 'help', args: ['--help'], expectedStatus: 0 },
    { name: 'missing-root', args: ['--profile', 'production', '--distribution-label', 'dev.hypha.zeus', '--plan'], expectedStatus: 1 },
    { name: 'unknown', args: ['--unknown'], expectedStatus: 1 },
  ];
  const results = cases.map((item) => {
    const commandArguments = item.args.length === 0 ? ['--silent', 'data-root:adopt-offline'] : ['--silent', 'data-root:adopt-offline', '--', ...item.args];
    const result = spawnSync('pnpm', commandArguments, {
      cwd: repositoryRoot,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.status, item.expectedStatus, `${item.name}: ${result.stderr}`);
    return { name: item.name, exitCode: result.status };
  });
  assert.deepEqual(await treeEvidence(fakeHome), before);
  assert.equal((await readdir(fakeHome)).some((name) => name.includes('zeus-data-preparation-lock')), false);
  return { cases: results, syntheticDefaultRootUnchanged: true, siblingPreparationLockAbsent: true };
}

function runCli(argumentsList: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('pnpm', ['--silent', 'data-root:adopt-offline', '--', ...argumentsList], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function expectRejectedWithoutTreeMutation(root: string, operation: () => unknown, expectedCode: string): Promise<Record<string, unknown>> {
  const before = await treeEvidence(root);
  const code = rejectionCode(operation);
  const after = await treeEvidence(root);
  assert.equal(code, expectedCode);
  assert.deepEqual(after, before);
  assert.equal(await pathExists(zeusDataRootIdentityPath(root)), false);
  return { code, treeUnchanged: true, markerAbsent: true };
}

function rejectionCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : error instanceof Error ? error.name : String(error);
  }
}

async function treeEvidence(root: string): Promise<Array<Record<string, unknown>>> {
  const output: Array<Record<string, unknown>> = [];
  await visit(root);
  return output.sort((left, right) => String(left.path).localeCompare(String(right.path)));

  async function visit(path: string): Promise<void> {
    const stats = await lstat(path);
    const relativePath = relative(root, path) || '.';
    if (stats.isSymbolicLink()) {
      output.push({ path: relativePath, type: 'symlink', mode: stats.mode & 0o777 });
      return;
    }
    if (stats.isDirectory()) {
      output.push({ path: relativePath, type: 'directory', mode: stats.mode & 0o777 });
      for (const name of (await readdir(path)).sort()) await visit(join(path, name));
      return;
    }
    const bytes = await readFile(path);
    output.push({
      path: relativePath,
      type: 'file',
      mode: stats.mode & 0o777,
      nlink: stats.nlink,
      bytes: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
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

function safeName(value: string): string {
  return value.replaceAll(/[^a-z0-9]+/giu, '-').replaceAll(/^-|-$/gu, '');
}
