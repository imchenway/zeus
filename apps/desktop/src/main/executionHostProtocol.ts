import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, realpathSync, type BigIntStats } from 'node:fs';
import { chmod, link, mkdir, open, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLegacyFlatZeusDataLayout, createZeusDataLayout, type ZeusDataLayout, type ZeusDataLayoutKind } from '@zeus/local-server/zeus-data-layout';
import { readOnlyValidationIdentity, type ExecutionHostStopActiveCommandRequest, type ExecutionHostStopActiveCommandResponse, type ReadOnlyValidationDescriptor, type ReadOnlyValidationIdentity } from '@zeus/shared';
import { isZeusDataRootHostIdentity, sameZeusDataRootHostIdentity, verifyZeusDataRootHostIdentity, type ZeusDataRootHostIdentity } from './dataRootIdentity.js';
import { resolveDesktopKeychainService } from './secretServiceIdentity.js';

export const executionHostProtocolVersion = 2;
export const executionHostRendezvousFileName = 'rendezvous.json';
export const executionHostStartupFileName = 'startup.json';
export const executionHostKernelLeaseFileName = 'owner-lease.sqlite';
const maximumExecutionHostMetadataBytes = 256 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ExecutionHostNativeConversationSource = 'task_push' | 'code_review' | 'conflict_resolution';

export interface ExecutionHostCapabilities {
  nativeConversationSources: ExecutionHostNativeConversationSource[];
  dataRootIdentity: ZeusDataRootHostIdentity;
  /** 缺失表示旧宿主没有同库 durable handoff journal。 */
  durableHandoff?: 'sqlite_journal_v1';
  /** 缺失表示普通可写宿主；验证 Main 只能附着完全相同的 manifest 世代。 */
  readOnlyValidation?: ReadOnlyValidationIdentity;
}

export const currentExecutionHostCapabilityFeatures = {
  nativeConversationSources: ['task_push', 'code_review', 'conflict_resolution'],
  durableHandoff: 'sqlite_journal_v1',
} as const;

export function executionHostCapabilitiesFor(dataRootIdentity: ZeusDataRootHostIdentity, readOnlyValidation?: ReadOnlyValidationDescriptor): ExecutionHostCapabilities {
  return {
    nativeConversationSources: [...currentExecutionHostCapabilityFeatures.nativeConversationSources],
    durableHandoff: currentExecutionHostCapabilityFeatures.durableHandoff,
    dataRootIdentity,
    ...(readOnlyValidation ? { readOnlyValidation: readOnlyValidationIdentity(readOnlyValidation) } : {}),
  };
}

export interface ExecutionHostBootstrap {
  protocolVersion: number;
  requestedInstanceId: string;
  userDataPath: string;
  dataLayoutKind: ZeusDataLayoutKind;
  databasePath: string;
  executionHostDirectoryPath: string;
  projectRoot: string;
  keychainService: string;
  dataRootIdentity: ZeusDataRootHostIdentity;
  codexNativeEnabled: boolean;
  codexLegacyImportRoot: string;
  codexHome: string;
  codexConfigImportSourceRoot: string;
  releaseUpdateManifestUrl?: string;
  allowUntrustedReleaseUpdateTest?: boolean;
  taskAttachmentRoot: string;
  browserAttachmentRoot: string;
  conversationAttachmentRoot: string;
  conversationAttachmentGrantSecretPath: string;
  telegramAllowedUserIds?: number[];
  appVersion: string;
  createdAt: string;
  readOnlyValidation?: ReadOnlyValidationDescriptor;
}

/** host.lock 的 generation 身份；锁文件本身只由持有该文件描述符的 Core 创建。 */
export interface ExecutionHostLockIdentity {
  protocolVersion: number;
  generationId: string;
  pid: number;
  appVersion: string;
  createdAt: string;
  /** 旧宿主没有该字段；缺失时必须走 legacy owner 兼容期，不能假定内核租约存在。 */
  ownershipMode?: 'kernel_lease_v1';
  dataRootIdentity: ZeusDataRootHostIdentity;
  readOnlyValidation?: ReadOnlyValidationIdentity;
}

/** 已发布版本只写入这两个字段，仍需在过渡期参与唯一写入者仲裁。 */
export interface LegacyExecutionHostLockIdentity {
  pid: number;
  createdAt: string;
}

export type ExecutionHostLockObservation =
  | { kind: 'absent' }
  | { kind: 'current'; identity: ExecutionHostLockIdentity }
  | { kind: 'legacy'; identity: LegacyExecutionHostLockIdentity }
  | { kind: 'unconfirmed'; reason: 'unsafe_file' | 'empty_or_invalid' };

export type ExecutionHostKernelLeaseState = 'available' | 'held';

export interface ExecutionHostKernelLease {
  close(): void;
}

const executionHostKernelLeaseCapability = Symbol('execution-host-kernel-lease-capability');

interface InternalExecutionHostKernelLease extends ExecutionHostKernelLease {
  [executionHostKernelLeaseCapability]: {
    active: boolean;
    userDataPath: string;
    dataRootIdentity: ZeusDataRootHostIdentity;
  };
}

interface SecureExecutionHostMetadataSnapshot {
  serialized: string;
  stats: BigIntStats;
}

/**
 * 只用于在新 Main 无法连接旧协议宿主时进入维护页。
 * 该投影故意不包含 API/control token、路径或其他可用于接管宿主的字段。
 */
export interface IncompatibleExecutionHostIdentity {
  source: 'lock' | 'rendezvous';
  protocolVersion: number;
  generationId: string;
  pid: number;
  appVersion: string;
}

export type ExecutionHostStartupStage = 'lock_acquired' | 'migration_preflight_started' | 'migration_preflight_completed' | 'core_runtime_starting' | 'local_server_ready' | 'control_ready' | 'failed';

/** 不含 token、路径或正文，可在 Core 控制面就绪前由 Main 安全读取。 */
export interface ExecutionHostStartupStatus {
  protocolVersion: number;
  generationId: string;
  pid: number;
  appVersion: string;
  stage: ExecutionHostStartupStage;
  startedAt: string;
  updatedAt: string;
  dataRootIdentity: ZeusDataRootHostIdentity;
  readOnlyValidation?: ReadOnlyValidationIdentity;
}

export interface ExecutionHostRendezvous {
  protocolVersion: number;
  instanceId: string;
  pid: number;
  appVersion: string;
  baseUrl: string;
  apiToken: string;
  controlUrl: string;
  controlToken: string;
  dbPath: string;
  projectRoot: string;
  dataRootIdentity: ZeusDataRootHostIdentity;
  readOnlyValidation?: ReadOnlyValidationIdentity;
  startedAt: string;
  updatedAt: string;
  /** 旧宿主没有该字段；用于阻止新 Main 把旧 JSON lock 当作新内核租约。 */
  ownershipMode?: 'kernel_lease_v1';
}

export interface ExecutionHostWorkStatus {
  instanceId: string | null;
  protocolVersion: number;
  mode: 'embedded' | 'detached';
  pid: number;
  startedAt: string | null;
  transport: {
    state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
    generationId: string | null;
  };
  runtimeGenerations: Array<{
    generationId: string;
    state: 'idle' | 'starting' | 'ready' | 'restarting' | 'closed';
    active: boolean;
    activeThreadCount: number;
    pendingRequestCount: number;
  }>;
  activeTurnCount: number;
  /** 不包含等待用户输入或审批的真实执行轮次数；旧宿主缺少该字段时由 Main 兼容推导。 */
  effectfulTurnCount?: number;
  waitingRequestCount: number;
  activeRuntimeCount: number;
  activeCommandRunCount: number;
  hasActiveWork: boolean;
  observedAt: string;
}

export interface ExecutionHostControlStatus {
  protocolVersion: number;
  instanceId: string;
  pid: number;
  appVersion: string;
  startedAt: string;
  /** 旧宿主没有该字段时由 Main 使用已验证的发布边界兼容收敛。 */
  capabilities?: ExecutionHostCapabilities;
  uiLease: {
    connected: boolean;
    leaseId: string | null;
    lastHeartbeatAt: string | null;
    appVersion: string | null;
  };
  work: ExecutionHostWorkStatus;
}

export interface ExecutionHostLeaseStatus {
  protocolVersion: number;
  instanceId: string;
  connected: boolean;
  leaseId: string | null;
  lastHeartbeatAt: string | null;
  /** 只表达宿主真实声明的业务能力，不用 App 版本差异代替。 */
  capabilities?: ExecutionHostCapabilities;
}

export interface ExecutionHostBrowserBridgeRegistration {
  leaseId: string;
  baseUrl: string;
  token: string;
  appVersion: string;
  dataRootIdentity: ZeusDataRootHostIdentity;
}

export interface ExecutionHostControlClient {
  health(): Promise<ExecutionHostControlStatus>;
  registerBrowserBridge(input: ExecutionHostBrowserBridgeRegistration): Promise<ExecutionHostLeaseStatus>;
  heartbeat(leaseId: string): Promise<ExecutionHostLeaseStatus>;
  detach(leaseId: string): Promise<ExecutionHostControlStatus>;
  stopActiveWork(input: ExecutionHostStopActiveCommandRequest): Promise<ExecutionHostStopActiveCommandResponse>;
  shutdown(): Promise<{ accepted: true }>;
  handoff(input: { handoffId: string; checkpointSha256: string }): Promise<{ accepted: true }>;
}

export function executionHostDirectory(userDataPath: string): string {
  const layered = createZeusDataLayout(userDataPath);
  const legacy = createLegacyFlatZeusDataLayout(userDataPath);
  const layeredDatabaseExists = existsSync(layered.database);
  const legacyDatabaseExists = existsSync(legacy.database);
  if (layeredDatabaseExists && legacyDatabaseExists) throw new Error('Zeus 同时存在分层与平铺数据库，拒绝猜测 Execution Host 目录。');
  if (layeredDatabaseExists) return layered.executionHost;
  if (legacyDatabaseExists) return legacy.executionHost;
  if (existsSync(layered.executionHost) && existsSync(legacy.executionHost)) throw new Error('Zeus 同时存在分层与平铺 Execution Host 目录，拒绝猜测宿主身份。');
  if (existsSync(layered.executionHost)) return layered.executionHost;
  if (existsSync(legacy.executionHost)) return legacy.executionHost;
  return existsSync(join(userDataPath, 'data')) ? layered.executionHost : legacy.executionHost;
}

export function executionHostBootstrapDataLayout(bootstrap: ExecutionHostBootstrap): ZeusDataLayout {
  const layout = bootstrap.dataLayoutKind === 'layered' ? createZeusDataLayout(bootstrap.userDataPath) : createLegacyFlatZeusDataLayout(bootstrap.userDataPath);
  if (layout.root !== bootstrap.userDataPath || layout.database !== bootstrap.databasePath || layout.executionHost !== bootstrap.executionHostDirectoryPath) {
    throw new Error('Zeus execution-host bootstrap data layout identity does not match its canonical root.');
  }
  verifyZeusDataRootHostIdentity({ rootPath: layout.root, expected: bootstrap.dataRootIdentity, keychainService: bootstrap.keychainService });
  if (bootstrap.readOnlyValidation && bootstrap.dataRootIdentity.profile !== 'test') {
    throw readOnlyValidationBootstrapError('Zeus read_only_validation 的数据根 profile 必须为 test。');
  }
  if (!bootstrap.readOnlyValidation) return layout;

  const descriptor = bootstrap.readOnlyValidation;
  const canonical = createZeusDataLayout(descriptor.validationRoot);
  const expectedKeychainService = resolveDesktopKeychainService({ profile: 'test', dataRootPath: canonical.root });
  const pathBindings: Array<[label: string, actual: string, expected: string]> = [
    ['userDataPath', bootstrap.userDataPath, canonical.root],
    ['databasePath', bootstrap.databasePath, canonical.database],
    ['descriptor.database.path', descriptor.database.path, canonical.database],
    ['executionHostDirectoryPath', bootstrap.executionHostDirectoryPath, canonical.executionHost],
    ['projectRoot', bootstrap.projectRoot, canonical.root],
    ['taskAttachmentRoot', bootstrap.taskAttachmentRoot, canonical.taskAttachments],
    ['browserAttachmentRoot', bootstrap.browserAttachmentRoot, canonical.browserComments],
    ['conversationAttachmentRoot', bootstrap.conversationAttachmentRoot, canonical.conversationAttachments],
    ['conversationAttachmentGrantSecretPath', bootstrap.conversationAttachmentGrantSecretPath, canonical.conversationAttachmentGrantSecret],
    ['codexHome', bootstrap.codexHome, canonical.codexHome],
    ['codexLegacyImportRoot', bootstrap.codexLegacyImportRoot, canonical.codexLegacyImports],
    ['codexConfigImportSourceRoot', bootstrap.codexConfigImportSourceRoot, canonical.codexHome],
    ['descriptor.manifestPath', descriptor.manifestPath, `${canonical.database}.read-only-validation.json`],
  ];
  const mismatch = pathBindings.find(([, actual, expected]) => actual !== expected);
  if (
    descriptor.validationRoot !== canonical.root ||
    bootstrap.dataLayoutKind !== 'layered' ||
    layout.kind !== 'layered' ||
    mismatch ||
    bootstrap.keychainService !== expectedKeychainService ||
    bootstrap.codexNativeEnabled !== false ||
    bootstrap.releaseUpdateManifestUrl !== undefined ||
    bootstrap.allowUntrustedReleaseUpdateTest === true ||
    bootstrap.telegramAllowedUserIds !== undefined
  ) {
    const detail = mismatch ? ` 路径字段 ${mismatch[0]} 未绑定 validationRoot。` : '';
    throw readOnlyValidationBootstrapError(`Zeus read_only_validation bootstrap 与 descriptor 规范身份不一致。${detail}`);
  }
  return layout;
}

export function executionHostRendezvousPath(userDataPath: string): string {
  return join(executionHostDirectory(userDataPath), executionHostRendezvousFileName);
}

export function executionHostLockPath(userDataPath: string): string {
  return join(executionHostDirectory(userDataPath), 'host.lock');
}

export function executionHostKernelLeasePath(userDataPath: string): string {
  return join(executionHostDirectory(userDataPath), executionHostKernelLeaseFileName);
}

export function executionHostStartupPath(userDataPath: string): string {
  return join(executionHostDirectory(userDataPath), executionHostStartupFileName);
}

export async function readExecutionHostLockIdentity(userDataPath: string): Promise<ExecutionHostLockIdentity | null> {
  const observation = await readExecutionHostLockObservation(userDataPath);
  return observation.kind === 'current' ? observation.identity : null;
}

/**
 * 安全区分当前身份、已发布两字段身份与不可证状态。
 * 存在但不可解析的 lock 绝不能降级成“无 owner”，它可能正处于旧 Host open(wx) 后的写入窗口。
 */
export async function readExecutionHostLockObservation(userDataPath: string): Promise<ExecutionHostLockObservation> {
  try {
    const serialized = await readSecureJsonFile(executionHostLockPath(userDataPath));
    let value: unknown;
    try {
      value = JSON.parse(serialized) as unknown;
    } catch {
      return { kind: 'unconfirmed', reason: 'empty_or_invalid' };
    }
    if (isExecutionHostLockIdentity(value)) return { kind: 'current', identity: value };
    if (isLegacyExecutionHostLockIdentity(value)) return { kind: 'legacy', identity: value };
    return { kind: 'unconfirmed', reason: 'empty_or_invalid' };
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return { kind: 'absent' };
    return { kind: 'unconfirmed', reason: 'unsafe_file' };
  }
}

/**
 * 使用独立 SQLite 文件的 BEGIN EXCLUSIVE 作为由内核持有的宿主租约。
 *
 * JSON lock 只承担可诊断身份；即使路径被删除或替换，也不能释放这个租约。进程崩溃时 SQLite/OS
 * 会自动释放锁，因此不需要任何存在 TOCTOU 风险的“判断陈旧后 unlink”流程。
 */
export function acquireExecutionHostKernelLease(userDataPath: string, dataRootIdentity: ZeusDataRootHostIdentity): ExecutionHostKernelLease {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: dataRootIdentity });
  const directory = executionHostDirectory(userDataPath);
  if (existsSync(directory)) assertSecureLeasePath(directory, 'directory');
  else mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertSecureLeasePath(directory, 'directory');
  if (realpathSync(directory) !== directory) throw executionHostLockError('ZEUS_EXECUTION_HOST_PATH_DRIFT', 'Zeus execution-host 目录包含符号链接或规范路径漂移。');
  chmodSync(directory, 0o700);
  const path = executionHostKernelLeasePath(userDataPath);
  if (existsSync(path)) assertSecureLeasePath(path, 'file');
  const database = new DatabaseSync(path);
  let acquired = false;
  try {
    chmodSync(path, 0o600);
    assertSecureLeasePath(path, 'file');
    database.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE');
    acquired = true;
    const state: InternalExecutionHostKernelLease[typeof executionHostKernelLeaseCapability] = {
      active: true,
      userDataPath,
      dataRootIdentity,
    };
    const lease: InternalExecutionHostKernelLease = {
      [executionHostKernelLeaseCapability]: state,
      close() {
        if (!acquired) return;
        acquired = false;
        state.active = false;
        try {
          if (database.isTransaction) database.exec('ROLLBACK');
        } finally {
          database.close();
        }
      },
    };
    return lease;
  } catch (error) {
    database.close();
    if (isSqliteBusy(error)) {
      throw Object.assign(new Error('Zeus execution-host kernel lease is already held.'), {
        code: 'ZEUS_EXECUTION_HOST_LEASE_HELD' as const,
      });
    }
    throw error;
  }
}

/** 只探测内核租约，不读取或修改业务数据库，也不删除任何发现文件。 */
export function inspectExecutionHostKernelLease(userDataPath: string, dataRootIdentity: ZeusDataRootHostIdentity): ExecutionHostKernelLeaseState {
  try {
    const lease = acquireExecutionHostKernelLease(userDataPath, dataRootIdentity);
    lease.close();
    return 'available';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ZEUS_EXECUTION_HOST_LEASE_HELD') return 'held';
    throw error;
  }
}

/**
 * 只有内核租约持有者可以发布该诊断身份。先完整写入并 fsync 临时文件，
 * 再以 hard-link 的 no-replace 语义与已发布旧 Host 的 open(wx) 竞争同一 host.lock。
 * 这样不会暴露空 lock，也不会覆盖仍存活的旧版 owner。
 */
export async function writeExecutionHostLockIdentity(userDataPath: string, input: ExecutionHostLockIdentity, lease: ExecutionHostKernelLease): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: input.dataRootIdentity });
  assertActiveExecutionHostKernelLease(lease, userDataPath, input.dataRootIdentity);
  const directory = executionHostDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  assertSecureLeasePath(directory, 'directory');
  if (realpathSync(directory) !== directory) throw executionHostLockError('ZEUS_EXECUTION_HOST_PATH_DRIFT', 'Zeus execution-host lock 目录包含符号链接或规范路径漂移。');
  const target = executionHostLockPath(userDataPath);
  const temporary = join(directory, `.host-lock-${input.generationId}-${randomUUID()}.tmp`);
  let published = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(input)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
      await replaceRecoverableStaleExecutionHostLock({ userDataPath, input, lease, target, temporary, directory });
    }
    published = true;
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, 'ENOENT')) throw error;
    });
    if (published) await syncExecutionHostDirectory(directory);
  }
}

async function replaceRecoverableStaleExecutionHostLock(input: { userDataPath: string; input: ExecutionHostLockIdentity; lease: ExecutionHostKernelLease; target: string; temporary: string; directory: string }): Promise<void> {
  assertActiveExecutionHostKernelLease(input.lease, input.userDataPath, input.input.dataRootIdentity);
  const staleSnapshot = await readSecureJsonFileSnapshot(input.target);
  const staleIdentity = parseCurrentExecutionHostLockSnapshot(staleSnapshot);
  if (!staleIdentity || staleIdentity.ownershipMode !== 'kernel_lease_v1') {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_LEGACY_LOCK_HELD', 'Zeus execution-host lock 不是可由 v2 kernel lease 接管的残留身份。');
  }
  if (!sameZeusDataRootHostIdentity(staleIdentity.dataRootIdentity, input.input.dataRootIdentity)) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH', '残留 host.lock 的 distribution/profile/rootId 与当前 kernel lease 不一致。');
  }
  if (!sameReadOnlyValidationIdentity(staleIdentity.readOnlyValidation, input.input.readOnlyValidation)) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_VALIDATION_IDENTITY_MISMATCH', '残留 host.lock 的 read_only_validation 身份与当前 Host 不一致。');
  }
  if (staleIdentity.generationId === input.input.generationId) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_LOCK_GENERATION_COLLISION', '当前 generation 已经存在 host.lock，拒绝覆盖。');
  }
  await assertRecoverableStaleExecutionHostCompanions(input.userDataPath, input.input);

  const quarantineDirectory = join(input.directory, 'quarantine');
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
  await chmod(quarantineDirectory, 0o700);
  assertSecureLeasePath(quarantineDirectory, 'directory');
  if (realpathSync(quarantineDirectory) !== quarantineDirectory) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_PATH_DRIFT', 'Zeus execution-host quarantine 目录包含符号链接或规范路径漂移。');
  }
  const staleHash = createHash('sha256').update(staleSnapshot.serialized).digest('hex');
  const quarantinePath = join(quarantineDirectory, `host-lock-v2-${staleHash}.json`);
  let quarantineCreated = false;
  try {
    await link(input.target, quarantinePath);
    quarantineCreated = true;
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  try {
    const quarantineSnapshot = await readSecureJsonFileSnapshot(quarantinePath);
    if (!sameSecureMetadataIdentity(staleSnapshot, quarantineSnapshot) || quarantineSnapshot.serialized !== staleSnapshot.serialized) {
      throw executionHostLockError('ZEUS_EXECUTION_HOST_STALE_LOCK_CAS_MISMATCH', 'host.lock quarantine 与已验证残留 inode/content 不一致。');
    }
  } catch (error) {
    if (quarantineCreated) {
      await unlink(quarantinePath).catch(() => undefined);
    }
    throw error;
  }
  await syncExecutionHostDirectory(quarantineDirectory);

  // kernel lease 串行化所有合规 Host；第二次同 fd 安全读取把普通 path swap 收敛为失败关闭。
  const immediatelyBeforeReplace = await readSecureJsonFileSnapshot(input.target);
  if (!sameSecureMetadataIdentity(staleSnapshot, immediatelyBeforeReplace) || immediatelyBeforeReplace.serialized !== staleSnapshot.serialized) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_STALE_LOCK_CAS_MISMATCH', 'host.lock 在 quarantine 后发生 path/inode/content 漂移，拒绝替换。');
  }
  await rename(input.temporary, input.target);
  await syncExecutionHostDirectory(input.directory);
  const publishedSnapshot = await readSecureJsonFileSnapshot(input.target);
  const publishedIdentity = parseCurrentExecutionHostLockSnapshot(publishedSnapshot);
  if (!publishedIdentity || publishedIdentity.generationId !== input.input.generationId || !sameZeusDataRootHostIdentity(publishedIdentity.dataRootIdentity, input.input.dataRootIdentity)) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_LOCK_PUBLISH_MISMATCH', '替换后的 host.lock 未保持当前 generation/root identity。');
  }
}

async function assertRecoverableStaleExecutionHostCompanions(userDataPath: string, expected: ExecutionHostLockIdentity): Promise<void> {
  for (const [kind, path] of [
    ['startup', executionHostStartupPath(userDataPath)],
    ['rendezvous', executionHostRendezvousPath(userDataPath)],
  ] as const) {
    let snapshot: SecureExecutionHostMetadataSnapshot;
    try {
      snapshot = await readSecureJsonFileSnapshot(path);
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) continue;
      throw executionHostLockError('ZEUS_EXECUTION_HOST_STALE_METADATA_UNSAFE', `残留 ${kind} 元数据不能安全读取，拒绝接管。`, error);
    }
    let value: unknown;
    try {
      value = JSON.parse(snapshot.serialized) as unknown;
    } catch (error) {
      throw executionHostLockError('ZEUS_EXECUTION_HOST_STALE_METADATA_INVALID', `残留 ${kind} 元数据不是有效 JSON，拒绝接管。`, error);
    }
    const dataRootIdentity = kind === 'startup' && isExecutionHostStartupStatus(value) ? value.dataRootIdentity : kind === 'rendezvous' && isExecutionHostRendezvous(value) ? value.dataRootIdentity : undefined;
    const validationIdentity = kind === 'startup' && isExecutionHostStartupStatus(value) ? value.readOnlyValidation : kind === 'rendezvous' && isExecutionHostRendezvous(value) ? value.readOnlyValidation : undefined;
    if (!dataRootIdentity) {
      throw executionHostLockError('ZEUS_EXECUTION_HOST_STALE_METADATA_INVALID', `残留 ${kind} 元数据不是当前协议 v2 身份，拒绝接管。`);
    }
    if (!sameZeusDataRootHostIdentity(dataRootIdentity, expected.dataRootIdentity)) {
      throw executionHostLockError('ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH', `残留 ${kind} 元数据的 distribution/profile/rootId 不一致。`);
    }
    if (!sameReadOnlyValidationIdentity(validationIdentity, expected.readOnlyValidation)) {
      throw executionHostLockError('ZEUS_EXECUTION_HOST_VALIDATION_IDENTITY_MISMATCH', `残留 ${kind} 元数据的 read_only_validation 身份不一致。`);
    }
  }
}

function parseCurrentExecutionHostLockSnapshot(snapshot: SecureExecutionHostMetadataSnapshot): ExecutionHostLockIdentity | null {
  try {
    const value = JSON.parse(snapshot.serialized) as unknown;
    return isExecutionHostLockIdentity(value) ? value : null;
  } catch {
    return null;
  }
}

function sameSecureMetadataIdentity(left: SecureExecutionHostMetadataSnapshot, right: SecureExecutionHostMetadataSnapshot): boolean {
  return (
    left.stats.dev === right.stats.dev && left.stats.ino === right.stats.ino && left.stats.size === right.stats.size && left.stats.mode === right.stats.mode && left.stats.uid === right.stats.uid && left.stats.mtimeNs === right.stats.mtimeNs
  );
}

function assertActiveExecutionHostKernelLease(lease: ExecutionHostKernelLease, userDataPath: string, dataRootIdentity: ZeusDataRootHostIdentity): void {
  const candidate = lease as Partial<InternalExecutionHostKernelLease>;
  const state = candidate[executionHostKernelLeaseCapability];
  if (!state?.active || state.userDataPath !== userDataPath || !sameZeusDataRootHostIdentity(state.dataRootIdentity, dataRootIdentity)) {
    throw executionHostLockError('ZEUS_EXECUTION_HOST_LEASE_CAPABILITY_INVALID', '只有持有相同 dataRootIdentity/rootId 的活动 kernel lease 才能发布或接管 host.lock。');
  }
}

async function syncExecutionHostDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** 必须在释放内核租约之前调用；这样下一任宿主不可能在身份清理过程中发布新文件。 */
export async function removeExecutionHostLockIdentity(userDataPath: string, generationId: string, dataRootIdentity: ZeusDataRootHostIdentity): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: dataRootIdentity });
  const current = await readExecutionHostLockIdentity(userDataPath);
  if (!current || current.generationId !== generationId || !sameZeusDataRootHostIdentity(current.dataRootIdentity, dataRootIdentity)) return;
  await unlink(executionHostLockPath(userDataPath)).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
}

/**
 * 读取仍由当前用户拥有、但协议代次不是当前版本的最小宿主身份。
 *
 * 这不是兼容解析器：调用方只能据此等待/展示维护状态，不能发送控制命令、删除锁或启动第二写入者。
 */
export async function readIncompatibleExecutionHostIdentity(userDataPath: string): Promise<IncompatibleExecutionHostIdentity | null> {
  const candidates: IncompatibleExecutionHostIdentity[] = [];
  for (const [source, path] of [
    ['lock', executionHostLockPath(userDataPath)],
    ['rendezvous', executionHostRendezvousPath(userDataPath)],
  ] as const) {
    try {
      const value = JSON.parse(await readSecureJsonFile(path)) as unknown;
      const candidate = parseIncompatibleExecutionHostIdentity(source, value);
      if (candidate) candidates.push(candidate);
    } catch {
      // 缺失、权限不符、符号链接或非法 JSON 都不能成为接管依据；正常启动链仍会由锁裁决。
    }
  }
  if (candidates.length === 0) return null;
  const lock = candidates.find((candidate) => candidate.source === 'lock');
  const rendezvous = candidates.find((candidate) => candidate.source === 'rendezvous');
  if (lock && rendezvous && (lock.generationId !== rendezvous.generationId || lock.pid !== rendezvous.pid || lock.protocolVersion !== rendezvous.protocolVersion)) {
    throw new Error('Zeus execution-host incompatible metadata identities conflict.');
  }
  return lock ?? rendezvous ?? null;
}

export async function readExecutionHostStartupStatus(userDataPath: string): Promise<ExecutionHostStartupStatus | null> {
  try {
    const value = JSON.parse(await readSecureJsonFile(executionHostStartupPath(userDataPath))) as unknown;
    return isExecutionHostStartupStatus(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeExecutionHostStartupStatus(userDataPath: string, input: ExecutionHostStartupStatus): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: input.dataRootIdentity });
  const directory = executionHostDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = executionHostStartupPath(userDataPath);
  const temporary = join(directory, `.startup-${input.generationId}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function removeExecutionHostStartupStatus(userDataPath: string, generationId: string, dataRootIdentity: ZeusDataRootHostIdentity): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: dataRootIdentity });
  const current = await readExecutionHostStartupStatus(userDataPath);
  if (!current || current.generationId !== generationId || !sameZeusDataRootHostIdentity(current.dataRootIdentity, dataRootIdentity)) return;
  await unlink(executionHostStartupPath(userDataPath)).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
}

export async function writeExecutionHostBootstrap(userDataPath: string, input: ExecutionHostBootstrap): Promise<string> {
  const layout = executionHostBootstrapDataLayout(input);
  if (userDataPath !== layout.root) throw new Error('Zeus execution-host bootstrap writer root does not match the canonical bootstrap root.');
  const directory = layout.executionHost;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  assertSecureLeasePath(directory, 'directory');
  if (realpathSync(directory) !== directory) throw new Error('Zeus execution-host bootstrap directory must be canonical and must not traverse symbolic links.');
  await chmod(directory, 0o700);
  const path = join(directory, `bootstrap-${input.requestedInstanceId}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(input)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

export async function readExecutionHostBootstrap(path: string): Promise<ExecutionHostBootstrap> {
  if (resolve(path) !== path) throw new Error('Zeus execution-host bootstrap path must be canonical and absolute.');
  const value = JSON.parse(await readSecureJsonFile(path)) as unknown;
  if (!isExecutionHostBootstrap(value)) throw new Error('Zeus execution-host bootstrap is invalid.');
  const layout = executionHostBootstrapDataLayout(value);
  const expectedPrefix = `bootstrap-${value.requestedInstanceId}-`;
  const fileName = basename(path);
  const bootstrapDirectory = dirname(path);
  assertSecureLeasePath(bootstrapDirectory, 'directory');
  if (bootstrapDirectory !== layout.executionHost || realpathSync(bootstrapDirectory) !== layout.executionHost || !fileName.startsWith(expectedPrefix) || !fileName.endsWith('.json')) {
    throw readOnlyValidationBootstrapError('Zeus execution-host bootstrap 文件未绑定规范 executionHostDirectory。');
  }
  return value;
}

export async function readExecutionHostRendezvous(userDataPath: string): Promise<ExecutionHostRendezvous | null> {
  const path = executionHostRendezvousPath(userDataPath);
  try {
    const value = JSON.parse(await readSecureJsonFile(path)) as unknown;
    return isExecutionHostRendezvous(value) ? value : null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    return null;
  }
}

export async function writeExecutionHostRendezvous(userDataPath: string, input: ExecutionHostRendezvous): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: input.dataRootIdentity });
  const directory = executionHostDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = executionHostRendezvousPath(userDataPath);
  const temporary = join(directory, `.rendezvous-${input.instanceId}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function removeExecutionHostRendezvous(userDataPath: string, instanceId: string, dataRootIdentity: ZeusDataRootHostIdentity): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: userDataPath, expected: dataRootIdentity });
  const current = await readExecutionHostRendezvous(userDataPath);
  if (!current || current.instanceId !== instanceId || !sameZeusDataRootHostIdentity(current.dataRootIdentity, dataRootIdentity)) return;
  await unlink(executionHostRendezvousPath(userDataPath)).catch((error: unknown) => {
    if (!isNodeError(error, 'ENOENT')) throw error;
  });
}

export function createExecutionHostControlClient(rendezvous: ExecutionHostRendezvous): ExecutionHostControlClient {
  const request = <T>(path: string, init?: RequestInit) => requestExecutionHostControl<T>(rendezvous.controlUrl, rendezvous.controlToken, path, init);
  return {
    health: () => request<ExecutionHostControlStatus>('/health'),
    registerBrowserBridge: (input) =>
      request<ExecutionHostLeaseStatus>('/ui/browser-bridge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    heartbeat: (leaseId) =>
      request<ExecutionHostLeaseStatus>('/ui/heartbeat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseId }),
      }),
    detach: (leaseId) =>
      request<ExecutionHostControlStatus>('/ui/detach', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leaseId }),
      }),
    stopActiveWork: (input) =>
      request<ExecutionHostStopActiveCommandResponse>('/work/stop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
    shutdown: () =>
      request<{ accepted: true }>('/shutdown', {
        method: 'POST',
      }),
    handoff: (input) =>
      request<{ accepted: true }>('/handoff', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }),
  };
}

async function requestExecutionHostControl<T>(controlUrl: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${controlUrl}${path}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${token}`,
    },
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const detail = isRecord(payload) && typeof payload.message === 'string' ? payload.message : `HTTP ${response.status}`;
    throw new Error(`Zeus execution-host control request failed: ${detail}`);
  }
  return payload as T;
}

async function readSecureJsonFile(path: string): Promise<string> {
  return (await readSecureJsonFileSnapshot(path)).serialized;
}

async function readSecureJsonFileSnapshot(path: string): Promise<SecureExecutionHostMetadataSnapshot> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error('Zeus execution-host metadata must be a regular file.');
    if ((before.mode & 0o077n) !== 0n) throw new Error('Zeus execution-host metadata permissions are too broad.');
    if (typeof process.getuid === 'function' && before.uid !== BigInt(process.getuid())) throw new Error('Zeus execution-host metadata owner does not match the current user.');
    if (before.size <= 0n || before.size > BigInt(maximumExecutionHostMetadataBytes)) throw new Error('Zeus execution-host metadata exceeds the bounded file budget.');

    const byteLength = Number(before.size);
    const content = Buffer.allocUnsafe(byteLength);
    let offset = 0;
    while (offset < byteLength) {
      const { bytesRead } = await handle.read(content, offset, byteLength - offset, offset);
      if (bytesRead === 0) throw new Error('Zeus execution-host metadata changed while it was being read.');
      offset += bytesRead;
    }
    const overflow = Buffer.allocUnsafe(1);
    const overflowRead = await handle.read(overflow, 0, 1, byteLength);
    const after = await handle.stat({ bigint: true });
    if (
      overflowRead.bytesRead !== 0 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.uid !== after.uid ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('Zeus execution-host metadata identity changed while it was being read.');
    }
    return { serialized: content.toString('utf8'), stats: after };
  } finally {
    await handle.close();
  }
}

function isExecutionHostBootstrap(value: unknown): value is ExecutionHostBootstrap {
  if (!isRecord(value)) return false;
  const structurallyValid =
    value.protocolVersion === executionHostProtocolVersion &&
    typeof value.requestedInstanceId === 'string' &&
    uuidPattern.test(value.requestedInstanceId) &&
    isNonEmptyString(value.userDataPath) &&
    (value.dataLayoutKind === 'layered' || value.dataLayoutKind === 'legacy-flat') &&
    isNonEmptyString(value.databasePath) &&
    isNonEmptyString(value.executionHostDirectoryPath) &&
    isNonEmptyString(value.projectRoot) &&
    isNonEmptyString(value.keychainService) &&
    isZeusDataRootHostIdentity(value.dataRootIdentity) &&
    typeof value.codexNativeEnabled === 'boolean' &&
    isNonEmptyString(value.codexLegacyImportRoot) &&
    isNonEmptyString(value.codexHome) &&
    isNonEmptyString(value.codexConfigImportSourceRoot) &&
    (value.releaseUpdateManifestUrl === undefined || isNonEmptyString(value.releaseUpdateManifestUrl)) &&
    (value.allowUntrustedReleaseUpdateTest === undefined || typeof value.allowUntrustedReleaseUpdateTest === 'boolean') &&
    isNonEmptyString(value.taskAttachmentRoot) &&
    isNonEmptyString(value.browserAttachmentRoot) &&
    isNonEmptyString(value.conversationAttachmentRoot) &&
    isNonEmptyString(value.conversationAttachmentGrantSecretPath) &&
    (value.telegramAllowedUserIds === undefined || (Array.isArray(value.telegramAllowedUserIds) && value.telegramAllowedUserIds.every((entry) => Number.isSafeInteger(entry) && Number(entry) > 0))) &&
    isNonEmptyString(value.appVersion) &&
    isNonEmptyString(value.createdAt) &&
    (value.readOnlyValidation === undefined || isReadOnlyValidationDescriptor(value.readOnlyValidation));
  if (!structurallyValid) return false;
  try {
    executionHostBootstrapDataLayout(value as unknown as ExecutionHostBootstrap);
    return true;
  } catch {
    return false;
  }
}

function parseIncompatibleExecutionHostIdentity(source: IncompatibleExecutionHostIdentity['source'], value: unknown): IncompatibleExecutionHostIdentity | null {
  if (!isRecord(value) || !Number.isInteger(value.protocolVersion) || Number(value.protocolVersion) < 1 || value.protocolVersion === executionHostProtocolVersion) return null;
  const generationId = source === 'lock' ? value.generationId : value.instanceId;
  if (!isNonEmptyString(generationId) || !Number.isInteger(value.pid) || Number(value.pid) <= 1 || !isNonEmptyString(value.appVersion)) return null;
  return {
    source,
    protocolVersion: Number(value.protocolVersion),
    generationId,
    pid: Number(value.pid),
    appVersion: value.appVersion,
  };
}

function isExecutionHostRendezvous(value: unknown): value is ExecutionHostRendezvous {
  if (!isRecord(value)) return false;
  if (
    value.protocolVersion !== executionHostProtocolVersion ||
    !isNonEmptyString(value.instanceId) ||
    !Number.isInteger(value.pid) ||
    !isNonEmptyString(value.appVersion) ||
    !isNonEmptyString(value.apiToken) ||
    !isNonEmptyString(value.controlToken) ||
    !isNonEmptyString(value.dbPath) ||
    !isNonEmptyString(value.projectRoot) ||
    !isZeusDataRootHostIdentity(value.dataRootIdentity) ||
    !isNonEmptyString(value.startedAt) ||
    !isNonEmptyString(value.updatedAt)
  )
    return false;
  return (
    isLoopbackHttpUrl(value.baseUrl) &&
    isLoopbackHttpUrl(value.controlUrl) &&
    (value.ownershipMode === undefined || value.ownershipMode === 'kernel_lease_v1') &&
    (value.readOnlyValidation === undefined || isReadOnlyValidationIdentity(value.readOnlyValidation))
  );
}

function isExecutionHostLockIdentity(value: unknown): value is ExecutionHostLockIdentity {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === executionHostProtocolVersion &&
    isNonEmptyString(value.generationId) &&
    Number.isInteger(value.pid) &&
    Number(value.pid) > 1 &&
    isNonEmptyString(value.appVersion) &&
    isValidIsoTimestamp(value.createdAt) &&
    isZeusDataRootHostIdentity(value.dataRootIdentity) &&
    (value.ownershipMode === undefined || value.ownershipMode === 'kernel_lease_v1') &&
    (value.readOnlyValidation === undefined || isReadOnlyValidationIdentity(value.readOnlyValidation))
  );
}

function isLegacyExecutionHostLockIdentity(value: unknown): value is LegacyExecutionHostLockIdentity {
  if (!isRecord(value)) return false;
  return Number.isInteger(value.pid) && Number(value.pid) > 1 && isValidIsoTimestamp(value.createdAt);
}

function isExecutionHostStartupStatus(value: unknown): value is ExecutionHostStartupStatus {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === executionHostProtocolVersion &&
    isNonEmptyString(value.generationId) &&
    Number.isInteger(value.pid) &&
    Number(value.pid) > 1 &&
    isNonEmptyString(value.appVersion) &&
    ['lock_acquired', 'migration_preflight_started', 'migration_preflight_completed', 'core_runtime_starting', 'local_server_ready', 'control_ready', 'failed'].includes(String(value.stage)) &&
    isValidIsoTimestamp(value.startedAt) &&
    isValidIsoTimestamp(value.updatedAt) &&
    isZeusDataRootHostIdentity(value.dataRootIdentity) &&
    (value.readOnlyValidation === undefined || isReadOnlyValidationIdentity(value.readOnlyValidation))
  );
}

function isReadOnlyValidationIdentity(value: unknown): value is ReadOnlyValidationIdentity {
  if (!isRecord(value)) return false;
  return value.mode === 'read_only_validation' && isNonEmptyString(value.runId) && isSha256(value.manifestHash) && isSha256(value.databaseSha256);
}

function sameReadOnlyValidationIdentity(left: ReadOnlyValidationIdentity | undefined, right: ReadOnlyValidationIdentity | undefined): boolean {
  if (!left || !right) return left === right;
  return left.mode === right.mode && left.runId === right.runId && left.manifestHash === right.manifestHash && left.databaseSha256 === right.databaseSha256;
}

function isReadOnlyValidationDescriptor(value: unknown): value is ReadOnlyValidationDescriptor {
  if (!isRecord(value) || !isRecord(value.allowedApplication) || !isRecord(value.source) || !isRecord(value.database)) return false;
  return (
    (value.formatVersion === 2 || value.formatVersion === 3 || value.formatVersion === 4) &&
    value.mode === 'read_only_validation' &&
    isNonEmptyString(value.runId) &&
    isValidIsoTimestamp(value.createdAt) &&
    isSha256(value.copyPlanHash) &&
    isNonEmptyString(value.manifestPath) &&
    isSha256(value.manifestHash) &&
    isNonEmptyString(value.validationRoot) &&
    value.allowedApplication.bundleId === 'dev.hypha.zeus.test' &&
    value.allowedApplication.executableName === 'Zeus Test' &&
    isNonEmptyString(value.source.path) &&
    isNonEmptyString(value.source.inferredDataRoot) &&
    isNonEmptyString(value.source.device) &&
    isNonEmptyString(value.source.inode) &&
    ((value.formatVersion === 2 &&
      isSha256(value.source.sha256) &&
      Number.isSafeInteger(value.source.bytes) &&
      Number(value.source.bytes) >= 0 &&
      value.source.treeImmutability === 'required_quiescent' &&
      value.backup === undefined &&
      value.migration === undefined) ||
      (value.formatVersion === 3 &&
        value.source.sha256 === undefined &&
        value.source.bytes === undefined &&
        value.source.treeImmutability === 'online_backup_snapshot' &&
        isOnlineBackupEvidence(value.backup) &&
        value.migration === undefined) ||
      (value.formatVersion === 4 &&
        value.source.sha256 === undefined &&
        value.source.bytes === undefined &&
        value.source.treeImmutability === 'online_backup_snapshot' &&
        isOnlineBackupEvidence(value.backup) &&
        isOfflineCandidateMigrationEvidence(value.migration))) &&
    isNonEmptyString(value.database.path) &&
    isNonEmptyString(value.database.device) &&
    isNonEmptyString(value.database.inode) &&
    value.database.nlink === 1 &&
    isSha256(value.database.sha256) &&
    Number.isSafeInteger(value.database.bytes) &&
    Number(value.database.bytes) >= 0 &&
    isSha256(value.database.schemaSha256) &&
    value.database.journalMode === 'delete'
  );
}

function isOnlineBackupEvidence(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isValidIsoTimestamp(value.startedAt) &&
    isValidIsoTimestamp(value.completedAt) &&
    Date.parse(String(value.completedAt)) >= Date.parse(String(value.startedAt)) &&
    [value.sourcePageCountBefore, value.sourcePageCountAfter, value.sourceDataVersionBefore, value.sourceDataVersionAfter, value.targetPageCount, value.pageSize].every((entry) => Number.isSafeInteger(entry) && Number(entry) > 0) &&
    typeof value.sourceAdvancedAfterBackup === 'boolean'
  );
}

function isOfflineCandidateMigrationEvidence(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.appliedMigrationIds)) return false;
  const appliedMigrationIds = value.appliedMigrationIds;
  return (
    value.strategy === 'offline_candidate_schema_migration' &&
    isValidIsoTimestamp(value.startedAt) &&
    isValidIsoTimestamp(value.completedAt) &&
    Date.parse(String(value.completedAt)) >= Date.parse(String(value.startedAt)) &&
    value.sourceAccessClosedBeforeMigration === true &&
    value.runtimeWriterCount === 0 &&
    value.rollbackWindow === 'source_unchanged_candidate_only' &&
    Number.isSafeInteger(value.preMigrationPageCount) &&
    Number(value.preMigrationPageCount) > 0 &&
    isSha256(value.preMigrationSchemaSha256) &&
    isSha256(value.preMigrationLedgerSha256) &&
    Number.isSafeInteger(value.postMigrationPageCount) &&
    Number(value.postMigrationPageCount) > 0 &&
    isSha256(value.postMigrationSchemaSha256) &&
    isSha256(value.postMigrationLedgerSha256) &&
    appliedMigrationIds.length <= 512 &&
    appliedMigrationIds.every((entry) => isNonEmptyString(entry)) &&
    new Set(appliedMigrationIds).size === appliedMigrationIds.length &&
    JSON.stringify(appliedMigrationIds) === JSON.stringify([...appliedMigrationIds].sort())
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isValidIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = 'code' in error ? String(error.code) : '';
  const errcode = 'errcode' in error ? Number(error.errcode) : Number.NaN;
  return code === 'ERR_SQLITE_ERROR' && (errcode === 5 || /\bdatabase is locked\b|\bdatabase is busy\b/iu.test(error.message));
}

function readOnlyValidationBootstrapError(message: string): Error {
  return Object.assign(new Error(message), {
    code: 'ZEUS_READ_ONLY_VALIDATION_BOOTSTRAP_MISMATCH' as const,
    failClosed: true as const,
  });
}

function executionHostLockError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code, failClosed: true as const });
}

function assertSecureLeasePath(path: string, kind: 'directory' | 'file'): void {
  const value = lstatSync(path);
  const expectedKind = kind === 'directory' ? value.isDirectory() : value.isFile();
  if (!expectedKind || value.isSymbolicLink()) throw new Error(`Zeus execution-host lease ${kind} must not be a symbolic link.`);
  if ((value.mode & 0o077) !== 0) throw new Error(`Zeus execution-host lease ${kind} permissions are too broad.`);
  if (typeof process.getuid === 'function' && value.uid !== process.getuid()) throw new Error(`Zeus execution-host lease ${kind} owner does not match the current user.`);
}
