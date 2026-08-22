import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createZeusDataLayout } from '../packages/local-server/src/zeusDataLayout.ts';
import { createZeusDatabase, assertReadOnlyValidationDatabaseIdentityStable, captureReadOnlyValidationDatabasePathIdentity } from '../packages/storage/src/index.ts';
import type { ReadOnlyValidationDescriptor } from '../packages/shared/src/readOnlyValidation.ts';
import { executionHostProtocolVersion, readExecutionHostBootstrap, writeExecutionHostBootstrap, type ExecutionHostBootstrap } from '../apps/desktop/src/main/executionHostProtocol.ts';
import { assertReadOnlyValidationDesktopOptions } from '../apps/desktop/src/main/localServerRuntime.ts';
import { assertDesktopReadOnlyValidationTrustBoundary } from '../apps/desktop/src/main/readOnlyValidationManifest.ts';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.ts';
import { expectedBundleIdForDataRootProfile, publishProvisionedZeusDataRootIdentity, zeusDataRootHostIdentity, type ZeusDataRootHostIdentity } from '../apps/desktop/src/main/dataRootIdentity.ts';

const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-read-only-bootstrap-security-')));
const homeDirectory = join(probeRoot, 'home');
const testIsolationBase = join(probeRoot, 'test-instance');
const runId = randomUUID();
const validationRoot = join(testIsolationBase, 'read-only-validation', runId);
const sourceRoot = join(probeRoot, 'formal-source');
const sourceDatabasePath = join(sourceRoot, 'data', 'zeus.db');
const alternateRoot = join(probeRoot, 'alternate-writable-root');
const productionRoot = join(homeDirectory, '.zeus');
const layout = createZeusDataLayout(validationRoot);
const keychainService = resolveDesktopKeychainService({ profile: 'test', dataRootPath: validationRoot });
let dataRootIdentity: ZeusDataRootHostIdentity;
const observed: Record<string, unknown> = {};

try {
  for (const directory of [homeDirectory, testIsolationBase, join(testIsolationBase, 'read-only-validation'), validationRoot, layout.dataDirectory, sourceRoot, join(sourceRoot, 'data'), productionRoot]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  dataRootIdentity = zeusDataRootHostIdentity(
    publishProvisionedZeusDataRootIdentity({
      rootPath: validationRoot,
      profile: 'test',
      bundleId: expectedBundleIdForDataRootProfile('test'),
      keychainService,
      allowedExistingRelativePaths: ['data'],
    }),
  );

  const source = await createZeusDatabase(sourceDatabasePath);
  source.execute(`CREATE TABLE bootstrap_security_probe (id INTEGER PRIMARY KEY, fact TEXT NOT NULL)`);
  source.execute(`INSERT INTO bootstrap_security_probe (id, fact) VALUES (1, 'stable')`);
  await source.save();
  await source.close();
  const sourceJournal = new DatabaseSync(sourceDatabasePath);
  try {
    const result = sourceJournal.prepare('PRAGMA journal_mode = DELETE').get() as { journal_mode?: unknown } | undefined;
    assertProbe(String(result?.journal_mode ?? '').toLowerCase() === 'delete', '来源数据库必须转换为 rollback journal。');
  } finally {
    sourceJournal.close();
  }
  await copyFile(sourceDatabasePath, layout.database, 0);
  await chmod(layout.database, 0o600);

  const [sourceStats, databaseStats, sourceSha256, databaseSha256] = await Promise.all([lstat(sourceDatabasePath, { bigint: true }), lstat(layout.database, { bigint: true }), sha256File(sourceDatabasePath), sha256File(layout.database)]);
  const descriptor = {
    formatVersion: 2,
    mode: 'read_only_validation',
    runId,
    createdAt: new Date().toISOString(),
    copyPlanHash: '1'.repeat(64),
    manifestPath: `${layout.database}.read-only-validation.json`,
    manifestHash: '2'.repeat(64),
    validationRoot,
    allowedApplication: { bundleId: 'dev.hypha.zeus.test', executableName: 'Zeus Test' },
    source: {
      path: sourceDatabasePath,
      inferredDataRoot: sourceRoot,
      device: sourceStats.dev.toString(),
      inode: sourceStats.ino.toString(),
      sha256: sourceSha256,
      bytes: Number(sourceStats.size),
      treeImmutability: 'required_quiescent',
    },
    database: {
      path: layout.database,
      device: databaseStats.dev.toString(),
      inode: databaseStats.ino.toString(),
      nlink: 1,
      sha256: databaseSha256,
      bytes: Number(databaseStats.size),
      schemaSha256: '3'.repeat(64),
      journalMode: 'delete',
    },
  } satisfies ReadOnlyValidationDescriptor;
  await writeFile(descriptor.manifestPath, '{}\n', { mode: 0o600 });

  const trusted = assertDesktopReadOnlyValidationTrustBoundary(descriptor, {
    testIsolationBasePath: testIsolationBase,
    sourceDataRoots: [sourceRoot],
    homeDirectory,
  });
  assertProbe(trusted === descriptor, '合法 strict v2 descriptor 必须通过 Desktop 同步 trust-root 校验。');

  const bootstrap = createBootstrap(descriptor, keychainService);
  const desktopOptionsAccepted = assertReadOnlyValidationDesktopOptions({
    userDataPath: validationRoot,
    dataLayout: layout,
    projectRoot: validationRoot,
    dataRootIdentity,
    keychainService,
    readOnlyValidation: descriptor,
    codexNativeEnabled: false,
    taskAttachmentRoot: layout.taskAttachments,
    browserAttachmentRoot: layout.browserComments,
    conversationAttachmentRoot: layout.conversationAttachments,
    conversationAttachmentGrantSecretPath: layout.conversationAttachmentGrantSecret,
  });
  assertProbe(desktopOptionsAccepted?.root === validationRoot, '合法 validation Desktop options 必须返回同一规范布局。');

  const bootstrapPath = await writeExecutionHostBootstrap(validationRoot, bootstrap);
  const acceptedBootstrap = await readExecutionHostBootstrap(bootstrapPath);
  assertProbe(
    acceptedBootstrap.readOnlyValidation?.manifestHash === descriptor.manifestHash && acceptedBootstrap.codexConfigImportSourceRoot === layout.codexHome,
    '合法 validation bootstrap 必须被接受，且 config import 只能绑定 validationRoot 内 Codex Home。',
  );

  const stableTree = await treeSnapshot(validationRoot);
  const mixedBootstrap = createBootstrap(descriptor, resolveDesktopKeychainService({ testDistribution: true, dataRootPath: alternateRoot }), alternateRoot);
  const mixedRejected = await captureRejection(() => writeExecutionHostBootstrap(alternateRoot, mixedBootstrap));
  assertProbe(mixedRejected && !(await pathExists(alternateRoot)), '合法 descriptor 与 alternate writable root 混搭必须在创建 alternate tree 前拒绝。');
  assertProbe(JSON.stringify(stableTree) === JSON.stringify(await treeSnapshot(validationRoot)), 'alternate root 拒绝不得改变 validation tree。');

  const mutationCases: Array<[string, (candidate: ExecutionHostBootstrap) => void]> = [
    ['legacy_layout', (candidate) => (candidate.dataLayoutKind = 'legacy-flat')],
    ['database', (candidate) => (candidate.databasePath = join(validationRoot, 'zeus.db'))],
    ['descriptor_database', (candidate) => ((candidate.readOnlyValidation!.database as { path: string }).path = join(validationRoot, 'zeus.db'))],
    ['execution_host', (candidate) => (candidate.executionHostDirectoryPath = join(validationRoot, 'execution-host'))],
    ['project', (candidate) => (candidate.projectRoot = sourceRoot)],
    ['task_attachments', (candidate) => (candidate.taskAttachmentRoot = sourceRoot)],
    ['browser_attachments', (candidate) => (candidate.browserAttachmentRoot = sourceRoot)],
    ['conversation_attachments', (candidate) => (candidate.conversationAttachmentRoot = sourceRoot)],
    ['grant_secret', (candidate) => (candidate.conversationAttachmentGrantSecretPath = join(sourceRoot, 'grant.secret'))],
    ['codex_home', (candidate) => (candidate.codexHome = join(sourceRoot, 'codex'))],
    ['legacy_import', (candidate) => (candidate.codexLegacyImportRoot = join(sourceRoot, 'legacy-import'))],
    ['config_import', (candidate) => (candidate.codexConfigImportSourceRoot = join(sourceRoot, '.codex'))],
    ['keychain', (candidate) => (candidate.keychainService = 'Zeus')],
    ['codex_native', (candidate) => (candidate.codexNativeEnabled = true)],
    ['release_url', (candidate) => (candidate.releaseUpdateManifestUrl = 'https://example.invalid/manifest.json')],
    ['untrusted_release', (candidate) => (candidate.allowUntrustedReleaseUpdateTest = true)],
    ['telegram', (candidate) => (candidate.telegramAllowedUserIds = [1])],
  ];
  const mutationRejections: string[] = [];
  for (const [name, mutate] of mutationCases) {
    const candidate = structuredClone(bootstrap);
    mutate(candidate);
    const before = await treeSnapshot(validationRoot);
    if (await captureRejection(() => writeExecutionHostBootstrap(validationRoot, candidate))) mutationRejections.push(name);
    assertProbe(JSON.stringify(before) === JSON.stringify(await treeSnapshot(validationRoot)), `${name} 拒绝前后 validation tree 必须不变。`);
  }
  assertProbe(mutationRejections.length === mutationCases.length, '全部规范字段、Provider 与外部身份混搭都必须失败关闭。');

  const outsideDirectory = join(probeRoot, 'outside-bootstrap-directory');
  await mkdir(outsideDirectory, { mode: 0o700 });
  const serializedBootstrap = await readFile(bootstrapPath);
  const outsidePath = join(outsideDirectory, `bootstrap-${bootstrap.requestedInstanceId}-${randomUUID()}.json`);
  await writeFile(outsidePath, serializedBootstrap, { mode: 0o600 });
  const outsideRejected = await rejectWithoutTreeMutation(outsideDirectory, () => readExecutionHostBootstrap(outsidePath));

  const symlinkPath = join(layout.executionHost, `bootstrap-${bootstrap.requestedInstanceId}-${randomUUID()}.json`);
  await symlink(bootstrapPath, symlinkPath);
  const symlinkRejected = await rejectWithoutTreeMutation(validationRoot, () => readExecutionHostBootstrap(symlinkPath));

  const broadPermissionsPath = join(layout.executionHost, `bootstrap-${bootstrap.requestedInstanceId}-${randomUUID()}.json`);
  await writeFile(broadPermissionsPath, serializedBootstrap, { mode: 0o644 });
  await chmod(broadPermissionsPath, 0o644);
  const broadPermissionsRejected = await rejectWithoutTreeMutation(validationRoot, () => readExecutionHostBootstrap(broadPermissionsPath));

  const oversizedPath = join(layout.executionHost, `bootstrap-${bootstrap.requestedInstanceId}-${randomUUID()}.json`);
  await writeFile(oversizedPath, Buffer.alloc(256 * 1024 + 1, 0x78), { mode: 0o600 });
  const oversizeRejected = await rejectWithoutTreeMutation(validationRoot, () => readExecutionHostBootstrap(oversizedPath));

  const retiredExecutionHostDirectory = `${layout.executionHost}.retired`;
  const attackerExecutionHostDirectory = join(probeRoot, 'attacker-execution-host-directory');
  await rename(layout.executionHost, retiredExecutionHostDirectory);
  await mkdir(attackerExecutionHostDirectory, { mode: 0o700 });
  await symlink(attackerExecutionHostDirectory, layout.executionHost);
  const attackerBootstrapPath = join(attackerExecutionHostDirectory, `bootstrap-${bootstrap.requestedInstanceId}-${randomUUID()}.json`);
  await writeFile(attackerBootstrapPath, serializedBootstrap, { mode: 0o600 });
  const lexicalSymlinkBootstrapPath = join(layout.executionHost, basename(attackerBootstrapPath));
  const directorySymlinkRejected = await rejectWithoutTreeMutation(attackerExecutionHostDirectory, () => readExecutionHostBootstrap(lexicalSymlinkBootstrapPath));
  await unlink(layout.executionHost);
  await rm(attackerExecutionHostDirectory, { recursive: true, force: false });
  await rename(retiredExecutionHostDirectory, layout.executionHost);

  const productionDescriptor = structuredClone(descriptor);
  (productionDescriptor as { validationRoot: string }).validationRoot = productionRoot;
  const productionRootBefore = await treeSnapshot(productionRoot);
  const productionRootImpersonationRejected = await captureRejection(async () => {
    assertDesktopReadOnlyValidationTrustBoundary(productionDescriptor, { testIsolationBasePath: testIsolationBase, homeDirectory });
  });
  assertProbe(productionRootImpersonationRejected && JSON.stringify(productionRootBefore) === JSON.stringify(await treeSnapshot(productionRoot)), 'production root impersonation 必须同步拒绝且零写。');

  const sourceTreeOverlapRejected = await captureRejection(async () => {
    assertDesktopReadOnlyValidationTrustBoundary(descriptor, { testIsolationBasePath: testIsolationBase, sourceDataRoots: [testIsolationBase], homeDirectory });
  });
  assertProbe(sourceTreeOverlapRejected, 'validationRoot 与显式来源数据树重叠必须同步拒绝。');

  const validStorage = await createZeusDatabase(layout.database, { readOnlyValidation: descriptor });
  const storedFact = validStorage.get<{ fact: string }>(`SELECT fact FROM bootstrap_security_probe WHERE id = 1`)?.fact ?? null;
  await validStorage.close();
  assertProbe(storedFact === 'stable', '合法 descriptor 必须允许 Storage 打开同一只读副本。');

  const identityBeforeSwap = captureReadOnlyValidationDatabasePathIdentity(layout.database, descriptor);
  const syntheticTimeMutationRejected = await captureRejection(async () => {
    assertReadOnlyValidationDatabaseIdentityStable(identityBeforeSwap, { ...identityBeforeSwap, mtimeNs: identityBeforeSwap.mtimeNs + 1n, ctimeNs: identityBeforeSwap.ctimeNs + 1n }, '行为探针时间身份注入');
  });
  const retiredDatabasePath = `${layout.database}.retired`;
  const replacementDatabasePath = `${layout.database}.replacement`;
  await copyFile(layout.database, replacementDatabasePath, 0);
  await chmod(replacementDatabasePath, 0o600);
  const runtimeSwapStorage = await createZeusDatabase(layout.database, { readOnlyValidation: descriptor });
  await rename(layout.database, retiredDatabasePath);
  await rename(replacementDatabasePath, layout.database);
  const pathSwapRejected = await captureRejection(async () => {
    captureReadOnlyValidationDatabasePathIdentity(layout.database, descriptor);
  });
  const closePathSwapRejected = await captureRejection(() => runtimeSwapStorage.close());
  await rename(layout.database, replacementDatabasePath);
  await rename(retiredDatabasePath, layout.database);
  await rm(replacementDatabasePath, { force: true });
  assertProbe(pathSwapRejected && closePathSwapRejected && syntheticTimeMutationRejected, 'rename-swap 及 mtime/ctime 变化必须在真实 open/close 身份闸机失败关闭。');

  observed.validBootstrapAccepted = true;
  observed.desktopTrustRootAccepted = true;
  observed.desktopOptionsAccepted = true;
  observed.configImportBoundToValidationRoot = true;
  observed.mixedDescriptorAlternateRootRejectedBeforeTreeWrite = true;
  observed.mutationRejectionCount = mutationRejections.length;
  observed.bootstrapDirectoryBound = outsideRejected;
  observed.secureJson = { symlinkRejected, directorySymlinkRejected, broadPermissionsRejected, oversizeRejected };
  observed.productionRootImpersonationRejected = true;
  observed.sourceTreeOverlapRejected = true;
  observed.storageValidOpenAccepted = true;
  observed.pathSwapRejected = true;
  observed.closePathSwapRejected = true;
  observed.mtimeCtimeMutationRejected = true;
  observed.treeUnchangedAcrossRejections = true;

  assertProbe(outsideRejected && symlinkRejected && directorySymlinkRejected && broadPermissionsRejected && oversizeRejected, 'bootstrap 目录、symlink、权限与大小预算必须全部失败关闭且零写。');
  console.log(JSON.stringify({ status: 'passed', observed }, null, 2));
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function createBootstrap(descriptor: ReadOnlyValidationDescriptor, keychainService: string, root = validationRoot): ExecutionHostBootstrap {
  const candidateLayout = createZeusDataLayout(root);
  return {
    protocolVersion: executionHostProtocolVersion,
    requestedInstanceId: randomUUID(),
    userDataPath: root,
    dataLayoutKind: 'layered',
    databasePath: candidateLayout.database,
    executionHostDirectoryPath: candidateLayout.executionHost,
    projectRoot: root,
    keychainService,
    dataRootIdentity,
    codexNativeEnabled: false,
    codexLegacyImportRoot: candidateLayout.codexLegacyImports,
    codexHome: candidateLayout.codexHome,
    codexConfigImportSourceRoot: candidateLayout.codexHome,
    taskAttachmentRoot: candidateLayout.taskAttachments,
    browserAttachmentRoot: candidateLayout.browserComments,
    conversationAttachmentRoot: candidateLayout.conversationAttachments,
    conversationAttachmentGrantSecretPath: candidateLayout.conversationAttachmentGrantSecret,
    allowUntrustedReleaseUpdateTest: false,
    appVersion: '0.3.27',
    createdAt: new Date().toISOString(),
    readOnlyValidation: descriptor,
  };
}

async function rejectWithoutTreeMutation(root: string, operation: () => Promise<unknown>): Promise<boolean> {
  const before = await treeSnapshot(root);
  const rejected = await captureRejection(operation);
  const after = await treeSnapshot(root);
  assertProbe(JSON.stringify(before) === JSON.stringify(after), '安全读取拒绝不得改变目标树。');
  return rejected;
}

async function captureRejection(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
}

async function treeSnapshot(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return [];
  const output: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await import('node:fs/promises').then(({ readdir }) => readdir(directory));
    for (const name of entries.sort()) {
      const path = join(directory, name);
      const stats = await lstat(path, { bigint: true });
      const relativePath = relative(root, path);
      const mode = Number(stats.mode & 0o777n)
        .toString(8)
        .padStart(4, '0');
      if (stats.isSymbolicLink()) {
        output.push(`l:${relativePath}:${mode}:${await readlink(path)}`);
      } else if (stats.isDirectory()) {
        output.push(`d:${relativePath}:${mode}`);
        await visit(path);
      } else {
        output.push(`f:${relativePath}:${mode}:${stats.size.toString()}:${await sha256File(path)}`);
      }
    }
  }
  await visit(root);
  return output;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
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

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`read_only_validation bootstrap 安全行为验证失败：${message}`);
}
