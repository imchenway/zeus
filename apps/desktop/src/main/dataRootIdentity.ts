import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { resolveDesktopKeychainService } from './secretServiceIdentity.js';
import { assertTestDataRootIsolation } from './testDataRootIsolation.js';

export const zeusDataRootIdentityFileName = '.zeus-root-identity.json';
export const zeusDataRootIdentitySchemaGeneration = 1;

const markerFormat = 'zeus-data-root-identity';
const markerFormatVersion = 1;
const maximumMarkerBytes = 32 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const sqliteHeader = Buffer.from('SQLite format 3\0', 'binary');
const offlineAdoptionConfirmationVersion = 'zeus-data-root-offline-adoption-v1';
const dataRootPreparationTimeoutMs = 15_000;
const dataRootPreparationWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const executionHostMetadataNames = new Set(['host.lock', 'rendezvous.json', 'startup.json', 'owner-lease.sqlite']);

export type ZeusDataRootProfile = 'production' | 'test' | 'development';
export type ZeusDataRootBundleIdentityKind = 'code_sign_bundle_id' | 'development_distribution_label';

interface ZeusDataRootIdentityPayload {
  format: typeof markerFormat;
  formatVersion: typeof markerFormatVersion;
  rootId: string;
  profile: ZeusDataRootProfile;
  bundleId: string;
  bundleIdentityKind: ZeusDataRootBundleIdentityKind;
  schemaGeneration: typeof zeusDataRootIdentitySchemaGeneration;
  canonicalRoot: string;
  keychainServiceIdentitySha256: string;
  claimedAt: string;
}

export interface ZeusDataRootIdentityMarker extends ZeusDataRootIdentityPayload {
  integritySha256: string;
}

/**
 * Execution Host 元数据只携带完成 attach 判定所需的稳定身份；不携带 Keychain service 明文。
 * markerIntegritySha256 是误配置/损坏检测，不是抵抗同 UID 篡改的签名或信任根。
 */
export interface ZeusDataRootHostIdentity {
  rootId: string;
  profile: ZeusDataRootProfile;
  bundleId: string;
  bundleIdentityKind: ZeusDataRootBundleIdentityKind;
  schemaGeneration: typeof zeusDataRootIdentitySchemaGeneration;
  canonicalRootSha256: string;
  markerIntegritySha256: string;
  keychainServiceIdentitySha256: string;
}

export interface ExpectedZeusDataRootIdentity {
  profile: ZeusDataRootProfile;
  bundleId: string;
  keychainService: string;
}

export interface PrepareZeusDataRootIdentityInput extends ExpectedZeusDataRootIdentity {
  rootPath: string;
  /** 只允许 Main 在已持有数据根准备锁且确认无 writer 时传入。 */
  knownProductionAdoptionRoots?: readonly string[];
  writerAbsenceConfirmed?: boolean;
}

export type ZeusDataRootOfflineAdoptionProfile = Extract<ZeusDataRootProfile, 'production' | 'test'>;

export interface ZeusDataRootOfflineAdoptionRequest {
  /** 必须由操作者逐字提供；没有默认值，也不会回退到 ~/.zeus。 */
  rootPath: string;
  profile: ZeusDataRootOfflineAdoptionProfile;
  /** production/test 对应的精确 distribution/bundle label。 */
  distributionLabel: string;
}

export interface ZeusDataRootOfflineAdoptionPlan {
  format: 'zeus-data-root-offline-adoption-plan';
  formatVersion: 1;
  canonicalRoot: string;
  profile: ZeusDataRootOfflineAdoptionProfile;
  distributionLabel: string;
  bundleIdentityKind: 'code_sign_bundle_id';
  layoutKind: 'layered' | 'legacy-flat';
  markerPath: string;
  rootDevice: string;
  rootInode: string;
  inventoryEntryCount: number;
  sqliteDatabaseCount: number;
  sqliteDatabaseRelativePaths: readonly string[];
  inventorySha256: string;
  keychainServiceIdentitySha256: string;
  confirmationToken: string;
}

interface NormalizedOfflineAdoptionRequest {
  root: string;
  profile: ZeusDataRootOfflineAdoptionProfile;
  distributionLabel: string;
  expected: ReturnType<typeof normalizeExpectedIdentity>;
}

interface OfflineAdoptionInspection {
  inventoryEntryCount: number;
  sqliteDatabasePaths: readonly string[];
  inventorySha256: string;
  rootDevice: string;
  rootInode: string;
  layoutKind: 'layered' | 'legacy-flat';
}

export function expectedBundleIdForDataRootProfile(profile: ZeusDataRootProfile): string {
  if (profile === 'production') return 'dev.hypha.zeus';
  if (profile === 'test') return 'dev.hypha.zeus.test';
  // 开发态通常运行于共享 Electron.app，没有 Zeus 独立 code-sign bundle ID。
  // 该值只是一项显式 distribution label，marker 的 bundleIdentityKind 会防止把它误述为签名身份。
  return 'dev.hypha.zeus.development';
}

export function bundleIdentityKindForDataRootProfile(profile: ZeusDataRootProfile): ZeusDataRootBundleIdentityKind {
  return profile === 'development' ? 'development_distribution_label' : 'code_sign_bundle_id';
}

export function keychainServiceIdentitySha256(keychainService: string): string {
  const value = keychainService.trim();
  if (!value || value.length > 255) throw dataRootIdentityError('ZEUS_DATA_ROOT_KEYCHAIN_IDENTITY_INVALID', 'Zeus Keychain service 身份为空或超出长度上限。');
  return sha256(value);
}

/**
 * 在数据根准备锁内执行。空根可以认领；非空无标记根只有已知正式默认/legacy 根可安全补标。
 */
export function prepareZeusDataRootIdentity(input: PrepareZeusDataRootIdentityInput): ZeusDataRootIdentityMarker {
  const root = normalizeRoot(input.rootPath);
  const expected = normalizeExpectedIdentity(input);
  if (existsSync(zeusDataRootIdentityPath(root))) return readAndVerifyZeusDataRootIdentity(root, expected);

  const rootExists = existsSync(root);
  if (rootExists) assertCanonicalPrivateRoot(root);
  const existingEntries = rootExists ? readdirSync(root) : [];
  const mayAdoptKnownProductionRoot =
    existingEntries.length > 0 &&
    input.writerAbsenceConfirmed === true &&
    expected.profile === 'production' &&
    expected.bundleId === expectedBundleIdForDataRootProfile('production') &&
    (input.knownProductionAdoptionRoots ?? []).some((candidate) => normalizeRoot(candidate) === root);

  if (existingEntries.length > 0 && !mayAdoptKnownProductionRoot) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_ADOPTION_REQUIRED', `Zeus 数据根 ${root} 非空但缺少持久身份标记。为避免 Test/正式资料互认，必须在所有 Zeus/Provider/Execution Host 退出后执行显式离线 adoption；启动链不会自动猜测。`);
  }

  if (!rootExists) createCanonicalPrivateRoot(root);
  return publishNewMarker(root, expected);
}

/**
 * 离线 adoption 的第一阶段：只检查操作者明确给出的根，不猜测任何默认路径。
 * 计划令牌绑定 canonical root、production/test 语义和当前目录 inventory；目录发生变化后必须重新计划。
 */
export function planZeusDataRootOfflineAdoption(input: ZeusDataRootOfflineAdoptionRequest): ZeusDataRootOfflineAdoptionPlan {
  const normalized = normalizeOfflineAdoptionRequest(input);
  return withZeusDataRootPreparationLock(normalized.root, () => {
    const first = inspectOfflineAdoptionRoot(normalized.root);
    assertNoObservableDataRootUser(normalized.root);
    const second = inspectOfflineAdoptionRoot(normalized.root);
    assertStableOfflineInventory(first, second);
    return createOfflineAdoptionPlan(normalized, second);
  });
}

/**
 * 离线 adoption 的第二阶段。确认令牌必须来自相同根、profile、distribution label 和未变化 inventory。
 * 成功时唯一写入目标根的内容是 0600、hard-link no-replace 发布的身份 marker。
 */
export function adoptZeusDataRootOffline(input: ZeusDataRootOfflineAdoptionRequest & { confirmationToken: string }): ZeusDataRootIdentityMarker {
  const normalized = normalizeOfflineAdoptionRequest(input);
  return withZeusDataRootPreparationLock(normalized.root, () => {
    const first = inspectOfflineAdoptionRoot(normalized.root);
    assertNoObservableDataRootUser(normalized.root);
    const second = inspectOfflineAdoptionRoot(normalized.root);
    assertStableOfflineInventory(first, second);
    const plan = createOfflineAdoptionPlan(normalized, second);
    if (input.confirmationToken !== plan.confirmationToken) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_CONFIRMATION_MISMATCH', '离线 adoption 确认令牌与当前 canonical root、profile、distribution label 或目录 inventory 不匹配；请重新执行 --plan。');
    }

    // 缩短“确认 writer 缺席”到 marker 发布的窗口；这仍不是抵抗同 UID 恶意竞态的系统安全边界。
    assertNoObservableDataRootUser(normalized.root);
    const finalInspection = inspectOfflineAdoptionRoot(normalized.root);
    assertStableOfflineInventory(second, finalInspection);
    const marker = publishNewMarker(normalized.root, normalized.expected);
    const rootAfterPublish = lstatSync(normalized.root, { bigint: true });
    if (rootAfterPublish.dev.toString() !== finalInspection.rootDevice || rootAfterPublish.ino.toString() !== finalInspection.rootInode || realpathSync(normalized.root) !== normalized.root) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_ROOT_IDENTITY_CHANGED', '身份 marker 发布期间数据根 device/inode/canonical path 发生变化，拒绝继续使用。');
    }
    return marker;
  });
}

/** 与 Main 的启动/迁移使用同一 sibling SQLite lease；锁文件不位于数据根内。 */
export function withZeusDataRootPreparationLock<T>(rootPath: string, operation: () => T): T {
  const root = normalizeRoot(rootPath);
  const release = acquireDataRootPreparationLock(root);
  try {
    return operation();
  } finally {
    release();
  }
}

/** 供 Backup API 复制编排在全新 validationRoot 中发布 test 身份；不提供一般自定义根 adoption。 */
export function publishProvisionedZeusDataRootIdentity(
  input: ExpectedZeusDataRootIdentity & {
    rootPath: string;
    /** Backup/验证编排已经发布的精确相对路径；任何预置 profile/config/未知文件都会失败关闭。 */
    allowedExistingRelativePaths: readonly string[];
  },
): ZeusDataRootIdentityMarker {
  const root = normalizeRoot(input.rootPath);
  assertCanonicalPrivateRoot(root);
  if (existsSync(zeusDataRootIdentityPath(root))) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_EXISTS', `Zeus 数据根身份已经存在，拒绝覆盖：${root}`);
  }
  assertExactProvisioningInventory(root, input.allowedExistingRelativePaths);
  return publishNewMarker(root, normalizeExpectedIdentity(input));
}

export function readAndVerifyZeusDataRootIdentity(rootPath: string, expected?: ExpectedZeusDataRootIdentity): ZeusDataRootIdentityMarker {
  const root = normalizeRoot(rootPath);
  assertCanonicalPrivateRoot(root);
  const markerPath = zeusDataRootIdentityPath(root);
  const descriptor = openSync(markerPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertPrivateMarkerStats(before);
    const serialized = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      serialized.byteLength !== Number(before.size) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.nlink !== after.nlink ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_CHANGED', 'Zeus 数据根身份标记在读取期间发生变化。');
    }
    let value: unknown;
    try {
      value = JSON.parse(serialized.toString('utf8')) as unknown;
    } catch (error) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_INVALID', 'Zeus 数据根身份标记不是有效 JSON。', error);
    }
    const marker = parseMarker(value);
    if (marker.canonicalRoot !== root) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_REUSED', `Zeus 数据根 rootId ${marker.rootId} 绑定 ${marker.canonicalRoot}，不能复用于 ${root}。`);
    }
    if (expected) assertMarkerMatchesExpected(marker, normalizeExpectedIdentity(expected));
    return Object.freeze(marker);
  } finally {
    closeSync(descriptor);
  }
}

export function zeusDataRootHostIdentity(marker: ZeusDataRootIdentityMarker): ZeusDataRootHostIdentity {
  return Object.freeze({
    rootId: marker.rootId,
    profile: marker.profile,
    bundleId: marker.bundleId,
    bundleIdentityKind: marker.bundleIdentityKind,
    schemaGeneration: marker.schemaGeneration,
    canonicalRootSha256: sha256(marker.canonicalRoot),
    markerIntegritySha256: marker.integritySha256,
    keychainServiceIdentitySha256: marker.keychainServiceIdentitySha256,
  });
}

export function verifyZeusDataRootHostIdentity(input: { rootPath: string; expected: ZeusDataRootHostIdentity; keychainService?: string }): ZeusDataRootIdentityMarker {
  const marker = readAndVerifyZeusDataRootIdentity(input.rootPath);
  const actual = zeusDataRootHostIdentity(marker);
  if (!sameZeusDataRootHostIdentity(actual, input.expected) || (input.keychainService !== undefined && actual.keychainServiceIdentitySha256 !== keychainServiceIdentitySha256(input.keychainService))) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_HOST_IDENTITY_MISMATCH', 'Zeus 数据根、distribution/profile 或 Keychain service 身份与 Execution Host 绑定不一致。');
  }
  return marker;
}

export function sameZeusDataRootHostIdentity(left: ZeusDataRootHostIdentity | undefined, right: ZeusDataRootHostIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return (
    left.rootId === right.rootId &&
    left.profile === right.profile &&
    left.bundleId === right.bundleId &&
    left.bundleIdentityKind === right.bundleIdentityKind &&
    left.schemaGeneration === right.schemaGeneration &&
    left.canonicalRootSha256 === right.canonicalRootSha256 &&
    left.markerIntegritySha256 === right.markerIntegritySha256 &&
    left.keychainServiceIdentitySha256 === right.keychainServiceIdentitySha256
  );
}

export function isZeusDataRootHostIdentity(value: unknown): value is ZeusDataRootHostIdentity {
  if (!isRecord(value)) return false;
  return (
    typeof value.rootId === 'string' &&
    uuidPattern.test(value.rootId) &&
    isDataRootProfile(value.profile) &&
    typeof value.bundleId === 'string' &&
    value.bundleId === expectedBundleIdForDataRootProfile(value.profile) &&
    value.bundleIdentityKind === bundleIdentityKindForDataRootProfile(value.profile) &&
    value.schemaGeneration === zeusDataRootIdentitySchemaGeneration &&
    typeof value.canonicalRootSha256 === 'string' &&
    sha256Pattern.test(value.canonicalRootSha256) &&
    typeof value.markerIntegritySha256 === 'string' &&
    sha256Pattern.test(value.markerIntegritySha256) &&
    typeof value.keychainServiceIdentitySha256 === 'string' &&
    sha256Pattern.test(value.keychainServiceIdentitySha256)
  );
}

export function zeusDataRootIdentityPath(rootPath: string): string {
  return join(normalizeRoot(rootPath), zeusDataRootIdentityFileName);
}

function normalizeOfflineAdoptionRequest(input: ZeusDataRootOfflineAdoptionRequest): NormalizedOfflineAdoptionRequest {
  const root = normalizeRoot(input.rootPath);
  if (input.profile !== 'production' && input.profile !== 'test') {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_PROFILE_INVALID', '离线 adoption 只接受显式 production 或 test profile；development 不在该迁移边界内。');
  }
  const expectedDistributionLabel = expectedBundleIdForDataRootProfile(input.profile);
  if (input.distributionLabel !== expectedDistributionLabel) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_DISTRIBUTION_MISMATCH', `离线 adoption 的 distribution label 必须精确为 ${expectedDistributionLabel}，收到 ${input.distributionLabel || '<empty>'}。`);
  }
  assertOfflineAdoptionProfilePathIsolation(root, input.profile);
  const expected = normalizeExpectedIdentity({
    profile: input.profile,
    bundleId: input.distributionLabel,
    keychainService: resolveDesktopKeychainService({ profile: input.profile, dataRootPath: root }),
  });
  return { root, profile: input.profile, distributionLabel: input.distributionLabel, expected };
}

function assertOfflineAdoptionProfilePathIsolation(root: string, profile: ZeusDataRootOfflineAdoptionProfile): void {
  // 使用系统账号数据库中的 home，而不是可被 CLI 调用方改写的 HOME 环境变量。
  const homeDirectory = userInfo().homedir;
  const appDataDirectory = join(homeDirectory, 'Library', 'Application Support');
  if (profile === 'test') {
    assertTestDataRootIsolation({ requestedRoot: root, homeDirectory, appDataDirectory });
    return;
  }
  const protectedNonProductionRoots = [join(homeDirectory, '.zeus-test'), join(homeDirectory, '.zeus-development')].map(canonicalizePotentialPathForComparison);
  const conflicting = protectedNonProductionRoots.find((candidate) => pathsOverlap(root, candidate));
  if (conflicting) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_PROFILE_PATH_MISMATCH', `production adoption 不能认领 Test/development 路径或其父子目录：${conflicting}`);
  }
}

function inspectOfflineAdoptionRoot(root: string): OfflineAdoptionInspection {
  assertCanonicalPrivateRoot(root);
  if (pathEntryExistsNoFollow(zeusDataRootIdentityPath(root))) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_EXISTS', `Zeus 数据根身份已经存在，离线 adoption 拒绝覆盖：${root}`);
  }
  const rootEntries = readdirSync(root);
  if (rootEntries.length === 0) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_ADOPTION_NOT_REQUIRED', '空数据根应由正常启动链认领，不得使用非空根离线 adoption。');
  }

  const rootStats = lstatSync(root, { bigint: true });
  const inventory: string[][] = [offlineInventoryRecord('.', rootStats)];
  const sqliteDatabasePaths: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = prefix ? join(prefix, name) : name;
      const stats = lstatSync(path, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_SYMLINK_REJECTED', `离线 adoption 不允许数据根内存在符号链接：${relativePath}`);
      }
      assertNotOfflineAdoptionBlocker(relativePath);
      if (stats.isDirectory()) {
        inventory.push(offlineInventoryRecord(relativePath, stats));
        visit(path, relativePath);
        continue;
      }
      if (!stats.isFile()) {
        throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_SPECIAL_FILE_REJECTED', `离线 adoption 不允许数据根内存在非普通文件：${relativePath}`);
      }
      if (stats.nlink !== 1n) {
        throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_HARDLINK_REJECTED', `离线 adoption 不允许业务文件通过硬链接复用其他数据根 inode：${relativePath}`);
      }
      inventory.push(offlineInventoryRecord(relativePath, stats));
      if (hasSqliteHeader(path)) sqliteDatabasePaths.push(path);
    }
  };
  visit(root, '');
  inventory.sort((left, right) => left[0]!.localeCompare(right[0]!));
  sqliteDatabasePaths.sort();
  const layoutKind = classifyOfflineAdoptionLayout(root, sqliteDatabasePaths);
  return {
    inventoryEntryCount: inventory.length - 1,
    sqliteDatabasePaths,
    inventorySha256: sha256(JSON.stringify(inventory)),
    rootDevice: rootStats.dev.toString(),
    rootInode: rootStats.ino.toString(),
    layoutKind,
  };
}

function offlineInventoryRecord(relativePath: string, stats: BigIntStats): string[] {
  return [
    relativePath,
    stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'special',
    (stats.mode & 0o777n).toString(8),
    stats.uid.toString(),
    stats.dev.toString(),
    stats.ino.toString(),
    stats.nlink.toString(),
    stats.size.toString(),
    stats.mtimeNs.toString(),
    stats.ctimeNs.toString(),
  ];
}

function classifyOfflineAdoptionLayout(root: string, sqliteDatabasePaths: readonly string[]): 'layered' | 'legacy-flat' {
  const layeredDatabase = join(root, 'data', 'zeus.db');
  const flatDatabase = join(root, 'zeus.db');
  const hasLayeredDatabase = pathEntryExistsNoFollow(layeredDatabase);
  const hasFlatDatabase = pathEntryExistsNoFollow(flatDatabase);
  if (hasLayeredDatabase && hasFlatDatabase) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_LAYOUT_AMBIGUOUS', '离线 adoption 同时发现分层和平铺 zeus.db，不能判断业务权威布局。');
  }
  for (const database of [layeredDatabase, flatDatabase]) {
    if (pathEntryExistsNoFollow(database) && !sqliteDatabasePaths.includes(database)) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_DATABASE_INVALID', `Zeus 主数据库没有有效 SQLite 文件头，拒绝 adoption：${database}`);
    }
  }

  const hasLayeredEvidence = hasLayeredDatabase || pathEntryExistsNoFollow(join(root, 'data', 'zeus.config.json'));
  const hasFlatEvidence = hasFlatDatabase || pathEntryExistsNoFollow(join(root, 'zeus.config.json'));
  if (hasLayeredEvidence === hasFlatEvidence) {
    throw dataRootIdentityError(
      hasLayeredEvidence ? 'ZEUS_DATA_ROOT_OFFLINE_LAYOUT_AMBIGUOUS' : 'ZEUS_DATA_ROOT_OFFLINE_NOT_ZEUS_ROOT',
      hasLayeredEvidence ? '离线 adoption 同时发现分层和平铺 Zeus 权威证据，拒绝猜测布局。' : '目录非空但没有分层或平铺 zeus.db/zeus.config.json 证据，拒绝把普通目录认领为 Zeus 数据根。',
    );
  }
  return hasLayeredEvidence ? 'layered' : 'legacy-flat';
}

function assertNotOfflineAdoptionBlocker(relativePath: string): void {
  const pathParts = relativePath.split(sep);
  const name = pathParts.at(-1) ?? relativePath;
  if (pathParts.includes('execution-host') && name !== 'execution-host') {
    const evidenceKind = executionHostMetadataNames.has(name) ? name : '未知/临时 Host 条目';
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_HOST_METADATA_PRESENT', `离线 adoption 检测到 ${evidenceKind}，Execution Host 目录必须为空：${relativePath}`);
  }
  if (/(?:-wal|-shm|-journal)$/u.test(name)) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_SQLITE_SIDECAR_PRESENT', `离线 adoption 检测到 SQLite WAL/SHM/journal，不能证明数据根静止：${relativePath}`);
  }
}

function hasSqliteHeader(path: string): boolean {
  const descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(sqliteHeader.byteLength);
    const bytesRead = readSync(descriptor, header, 0, header.byteLength, 0);
    return bytesRead === sqliteHeader.byteLength && header.equals(sqliteHeader);
  } finally {
    closeSync(descriptor);
  }
}

function assertNoObservableDataRootUser(root: string): void {
  const lsofPath = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => existsSync(candidate));
  if (!lsofPath) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_WRITER_CHECK_UNAVAILABLE', '找不到系统 lsof，无法证明离线数据根没有可观察 writer，拒绝 adoption。');
  }
  const result = spawnSync(lsofPath, ['-n', '-P', '-F', 'pcfn', '+D', root], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 15_000,
  });
  if (result.stdout.trim()) {
    const evidence = result.stdout.trim().split('\n').slice(0, 12).join(' ');
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_WRITER_OBSERVED', `离线 adoption 检测到仍在使用数据根的进程或句柄：${evidence}`);
  }
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1) || result.stderr.trim()) {
    const failureDetail = result.error?.message ?? (result.stderr.trim() || `lsof exit=${String(result.status)} signal=${String(result.signal)}`);
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_WRITER_CHECK_FAILED', `无法完整检查数据根的打开文件/目录句柄，拒绝 adoption：${failureDetail}`, result.error);
  }
}

function assertStableOfflineInventory(left: OfflineAdoptionInspection, right: OfflineAdoptionInspection): void {
  if (
    left.inventoryEntryCount !== right.inventoryEntryCount ||
    left.inventorySha256 !== right.inventorySha256 ||
    left.rootDevice !== right.rootDevice ||
    left.rootInode !== right.rootInode ||
    left.layoutKind !== right.layoutKind ||
    left.sqliteDatabasePaths.length !== right.sqliteDatabasePaths.length ||
    left.sqliteDatabasePaths.some((path, index) => path !== right.sqliteDatabasePaths[index])
  ) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_OFFLINE_INVENTORY_CHANGED', '离线 adoption 检查期间目录 inventory 发生变化，可能仍有 writer；拒绝发布身份。');
  }
}

function createOfflineAdoptionPlan(normalized: NormalizedOfflineAdoptionRequest, inspection: OfflineAdoptionInspection): ZeusDataRootOfflineAdoptionPlan {
  const tokenPayload = {
    version: offlineAdoptionConfirmationVersion,
    canonicalRoot: normalized.root,
    profile: normalized.profile,
    distributionLabel: normalized.distributionLabel,
    bundleIdentityKind: normalized.expected.bundleIdentityKind,
    keychainServiceIdentitySha256: normalized.expected.keychainServiceIdentitySha256,
    rootDevice: inspection.rootDevice,
    rootInode: inspection.rootInode,
    layoutKind: inspection.layoutKind,
    sqliteDatabasePaths: inspection.sqliteDatabasePaths,
    inventorySha256: inspection.inventorySha256,
  };
  return Object.freeze({
    format: 'zeus-data-root-offline-adoption-plan',
    formatVersion: 1,
    canonicalRoot: normalized.root,
    profile: normalized.profile,
    distributionLabel: normalized.distributionLabel,
    bundleIdentityKind: 'code_sign_bundle_id',
    layoutKind: inspection.layoutKind,
    markerPath: zeusDataRootIdentityPath(normalized.root),
    rootDevice: inspection.rootDevice,
    rootInode: inspection.rootInode,
    inventoryEntryCount: inspection.inventoryEntryCount,
    sqliteDatabaseCount: inspection.sqliteDatabasePaths.length,
    sqliteDatabaseRelativePaths: inspection.sqliteDatabasePaths.map((path) => relative(normalized.root, path)),
    inventorySha256: inspection.inventorySha256,
    keychainServiceIdentitySha256: normalized.expected.keychainServiceIdentitySha256,
    confirmationToken: sha256(JSON.stringify(tokenPayload)),
  });
}

function acquireDataRootPreparationLock(root: string): () => void {
  const lockPath = join(dirname(root), `.${basename(root)}.zeus-data-preparation-lock.sqlite`);
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + dataRootPreparationTimeoutMs;

  while (Date.now() < deadline) {
    const lease = new DatabaseSync(lockPath);
    try {
      chmodSync(lockPath, 0o600);
      lease.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (lease.isTransaction) lease.exec('ROLLBACK');
        } finally {
          lease.close();
        }
      };
    } catch (error) {
      lease.close();
      if (!isSqliteBusy(error)) throw error;
      Atomics.wait(dataRootPreparationWaitBuffer, 0, 0, 50);
    }
  }

  throw dataRootIdentityError('ZEUS_DATA_ROOT_PREPARATION_BUSY', `Zeus 数据根正在被另一个进程准备：${root}`);
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  const errcode = 'errcode' in error ? Number(error.errcode) : Number.NaN;
  return code === 'ERR_SQLITE_ERROR' && (errcode === 5 || /\bdatabase is locked\b|\bdatabase is busy\b/iu.test(error.message));
}

function pathEntryExistsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

function publishNewMarker(root: string, expected: ReturnType<typeof normalizeExpectedIdentity>): ZeusDataRootIdentityMarker {
  assertCanonicalPrivateRoot(root);
  const payload: ZeusDataRootIdentityPayload = {
    format: markerFormat,
    formatVersion: markerFormatVersion,
    rootId: randomUUID(),
    profile: expected.profile,
    bundleId: expected.bundleId,
    bundleIdentityKind: expected.bundleIdentityKind,
    schemaGeneration: zeusDataRootIdentitySchemaGeneration,
    canonicalRoot: root,
    keychainServiceIdentitySha256: expected.keychainServiceIdentitySha256,
    claimedAt: new Date().toISOString(),
  };
  const marker: ZeusDataRootIdentityMarker = { ...payload, integritySha256: markerIntegrity(payload) };
  const target = zeusDataRootIdentityPath(root);
  const temporary = join(root, `.${basename(target)}.${randomUUID()}.tmp`);
  let temporaryPresent = false;
  try {
    const descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    temporaryPresent = true;
    try {
      writeFileSync(descriptor, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporary, 0o600);
    linkSync(temporary, target);
    unlinkSync(temporary);
    temporaryPresent = false;
    syncDirectory(root);
    return readAndVerifyZeusDataRootIdentity(root, {
      profile: expected.profile,
      bundleId: expected.bundleId,
      keychainService: expected.keychainService,
    });
  } catch (error) {
    if (temporaryPresent) {
      try {
        unlinkSync(temporary);
      } catch {
        // 原错误优先；临时文件只存在于尚未成为有效数据根的隔离目录。
      }
    }
    if (isNodeError(error, 'EEXIST')) {
      throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_EXISTS', `Zeus 数据根身份发布发生并发冲突，拒绝覆盖：${root}`, error);
    }
    throw error;
  }
}

function parseMarker(value: unknown): ZeusDataRootIdentityMarker {
  if (!isRecord(value)) throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_INVALID', 'Zeus 数据根身份标记必须是对象。');
  const keys = Object.keys(value).sort();
  const expectedKeys = ['bundleId', 'bundleIdentityKind', 'canonicalRoot', 'claimedAt', 'format', 'formatVersion', 'integritySha256', 'keychainServiceIdentitySha256', 'profile', 'rootId', 'schemaGeneration'].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_INVALID', 'Zeus 数据根身份标记字段集合不符合当前 schema。');
  }
  if (
    value.format !== markerFormat ||
    value.formatVersion !== markerFormatVersion ||
    typeof value.rootId !== 'string' ||
    !uuidPattern.test(value.rootId) ||
    !isDataRootProfile(value.profile) ||
    typeof value.bundleId !== 'string' ||
    value.bundleId !== expectedBundleIdForDataRootProfile(value.profile) ||
    value.bundleIdentityKind !== bundleIdentityKindForDataRootProfile(value.profile) ||
    value.schemaGeneration !== zeusDataRootIdentitySchemaGeneration ||
    typeof value.canonicalRoot !== 'string' ||
    !isAbsolute(value.canonicalRoot) ||
    resolve(value.canonicalRoot) !== value.canonicalRoot ||
    typeof value.keychainServiceIdentitySha256 !== 'string' ||
    !sha256Pattern.test(value.keychainServiceIdentitySha256) ||
    typeof value.claimedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.claimedAt)) ||
    typeof value.integritySha256 !== 'string' ||
    !sha256Pattern.test(value.integritySha256)
  ) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_INVALID', 'Zeus 数据根身份标记字段值不符合当前 schema。');
  }
  const payload: ZeusDataRootIdentityPayload = {
    format: value.format,
    formatVersion: value.formatVersion,
    rootId: value.rootId,
    profile: value.profile,
    bundleId: value.bundleId,
    bundleIdentityKind: bundleIdentityKindForDataRootProfile(value.profile),
    schemaGeneration: value.schemaGeneration,
    canonicalRoot: value.canonicalRoot,
    keychainServiceIdentitySha256: value.keychainServiceIdentitySha256,
    claimedAt: value.claimedAt,
  };
  if (markerIntegrity(payload) !== value.integritySha256) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_INTEGRITY_MISMATCH', 'Zeus 数据根身份标记完整性摘要不匹配。');
  }
  return { ...payload, integritySha256: value.integritySha256 };
}

function assertMarkerMatchesExpected(marker: ZeusDataRootIdentityMarker, expected: ReturnType<typeof normalizeExpectedIdentity>): void {
  if (marker.profile !== expected.profile || marker.bundleId !== expected.bundleId || marker.keychainServiceIdentitySha256 !== expected.keychainServiceIdentitySha256) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_PROFILE_MISMATCH', `Zeus 数据根 ${marker.canonicalRoot} 已绑定 ${marker.profile}/${marker.bundleId}，不能由 ${expected.profile}/${expected.bundleId} 使用。`);
  }
}

function normalizeExpectedIdentity(input: ExpectedZeusDataRootIdentity): ExpectedZeusDataRootIdentity & { bundleIdentityKind: ZeusDataRootBundleIdentityKind; keychainServiceIdentitySha256: string } {
  if (!isDataRootProfile(input.profile) || input.bundleId !== expectedBundleIdForDataRootProfile(input.profile)) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_PROFILE_INVALID', 'Zeus distribution/profile 与 bundle ID 组合无效。');
  }
  return {
    profile: input.profile,
    bundleId: input.bundleId,
    bundleIdentityKind: bundleIdentityKindForDataRootProfile(input.profile),
    keychainService: input.keychainService,
    keychainServiceIdentitySha256: keychainServiceIdentitySha256(input.keychainService),
  };
}

function assertExactProvisioningInventory(root: string, allowedExistingRelativePaths: readonly string[]): void {
  const allowed = [...new Set(allowedExistingRelativePaths.map((path) => normalizeProvisioningRelativePath(root, path)))].sort();
  const actual: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const relativePath = prefix ? join(prefix, entry) : entry;
      const path = join(directory, entry);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) throw dataRootIdentityError('ZEUS_DATA_ROOT_PROVISIONING_INVENTORY_MISMATCH', `Zeus validationRoot 预置了符号链接，拒绝认领：${relativePath}`);
      actual.push(relativePath);
      if (stats.isDirectory()) visit(path, relativePath);
    }
  };
  visit(root, '');
  actual.sort();
  if (actual.length !== allowed.length || actual.some((path, index) => path !== allowed[index])) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_PROVISIONING_INVENTORY_MISMATCH', `Zeus validationRoot 不是编排声明的全新目录；expected=${allowed.join(',') || '<empty>'} actual=${actual.join(',') || '<empty>'}`);
  }
}

function normalizeProvisioningRelativePath(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw dataRootIdentityError('ZEUS_DATA_ROOT_PROVISIONING_INVENTORY_MISMATCH', 'Zeus validationRoot inventory 必须使用非空相对路径。');
  const normalized = relative(root, resolve(root, path));
  if (!normalized || normalized.startsWith('..') || isAbsolute(normalized)) {
    throw dataRootIdentityError('ZEUS_DATA_ROOT_PROVISIONING_INVENTORY_MISMATCH', `Zeus validationRoot inventory 路径逃逸：${path}`);
  }
  return normalized;
}

function assertPrivateMarkerStats(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_UNSAFE', 'Zeus 数据根身份标记必须是普通文件且不能是符号链接。');
  if (Number(stats.mode & 0o777n) !== 0o600) throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_UNSAFE', 'Zeus 数据根身份标记权限必须精确为 0600。');
  if (stats.nlink !== 1n) throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_REUSED', 'Zeus 数据根身份标记不能使用硬链接复用。');
  if (typeof process.getuid === 'function' && stats.uid !== BigInt(process.getuid())) throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_UNSAFE', 'Zeus 数据根身份标记不属于当前用户。');
  if (stats.size <= 0n || stats.size > BigInt(maximumMarkerBytes)) throw dataRootIdentityError('ZEUS_DATA_ROOT_IDENTITY_INVALID', 'Zeus 数据根身份标记超出有界读取范围。');
}

function assertCanonicalPrivateRoot(root: string): void {
  const stats = lstatSync(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw dataRootIdentityError('ZEUS_DATA_ROOT_PATH_UNSAFE', `Zeus 数据根必须是普通目录且不能是符号链接：${root}`);
  if ((stats.mode & 0o077) !== 0) throw dataRootIdentityError('ZEUS_DATA_ROOT_PATH_UNSAFE', `Zeus 数据根权限范围过宽：${root}`);
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) throw dataRootIdentityError('ZEUS_DATA_ROOT_PATH_UNSAFE', `Zeus 数据根不属于当前用户：${root}`);
  if (realpathSync(root) !== root) throw dataRootIdentityError('ZEUS_DATA_ROOT_PATH_DRIFT', `Zeus 数据根包含符号链接或规范路径漂移：${root}`);
}

function createCanonicalPrivateRoot(root: string): void {
  let ancestor = dirname(root);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (realpathSync(ancestor) !== ancestor) throw dataRootIdentityError('ZEUS_DATA_ROOT_PATH_DRIFT', `Zeus 数据根父路径包含符号链接：${ancestor}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  assertCanonicalPrivateRoot(root);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, fsConstants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function markerIntegrity(payload: ZeusDataRootIdentityPayload): string {
  return sha256(JSON.stringify(payload));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeRoot(rootPath: string): string {
  if (!isAbsolute(rootPath) || resolve(rootPath) !== rootPath) throw dataRootIdentityError('ZEUS_DATA_ROOT_PATH_DRIFT', 'Zeus 数据根必须是规范绝对路径。');
  return resolve(rootPath);
}

function canonicalizePotentialPathForComparison(value: string): string {
  const normalized = resolve(value);
  let cursor = normalized;
  const missingSegments: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(existsSync(cursor) ? realpathSync(cursor) : cursor, ...missingSegments);
}

function pathsOverlap(left: string, right: string): boolean {
  return sameOrInside(left, right) || sameOrInside(right, left);
}

function sameOrInside(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const nested = relative(root, candidate);
  return nested !== '' && nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested);
}

function isDataRootProfile(value: unknown): value is ZeusDataRootProfile {
  return value === 'production' || value === 'test' || value === 'development';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function dataRootIdentityError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, failClosed: true as const });
}
