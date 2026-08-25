import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createCodexRuntimeGenerationManager } from '@zeus/ai-runtime';
import {
  type BrowserAutomationPort,
  createZeusDataLayout,
  hasCodexFinalizationOwnershipClaim,
  prepareUnifiedConversationStoreMigration,
  type RunningZeusLocalServer,
  startZeusLocalServer,
  verifyReadOnlyValidationDescriptor,
  type ZeusDataLayout,
} from '@zeus/local-server';
import { type ReadOnlyValidationDescriptor, readOnlyValidationIdentity, type ReadOnlyValidationIdentity, sameReadOnlyValidationIdentity } from '@zeus/shared';
import { startDesktopBrowserAutomationBridge } from './browserAutomationBridge.js';
import { createExecutionHostStopActiveCommandRequest } from './executionHostStopCommand.js';
import { createReadOnlyValidationCodexManager } from './readOnlyValidationCodexManager.js';
import { resolveDesktopKeychainService } from './secretServiceIdentity.js';
import {
  createExecutionHostControlClient,
  currentExecutionHostCapabilityFeatures,
  type ExecutionHostCapabilities,
  executionHostCapabilitiesFor,
  type ExecutionHostLeaseStatus,
  type ExecutionHostLockObservation,
  executionHostProtocolVersion,
  type ExecutionHostRendezvous,
  executionHostRendezvousPath,
  executionHostStartupPath,
  type ExecutionHostStartupStage,
  type ExecutionHostWorkStatus,
  type IncompatibleExecutionHostIdentity,
  inspectExecutionHostKernelLease,
  readExecutionHostLockIdentity,
  readExecutionHostLockObservation,
  readExecutionHostRendezvous,
  readExecutionHostStartupStatus,
  readIncompatibleExecutionHostIdentity,
  writeExecutionHostBootstrap,
} from './executionHostProtocol.js';
import type { DesktopLocalServerCloseMode } from './beforeQuitCleanup.js';
import { sameZeusDataRootHostIdentity, verifyZeusDataRootHostIdentity, type ZeusDataRootHostIdentity } from './dataRootIdentity.js';

const readOnlyValidationVerifiedBeforeOwnedCoreLock = new WeakSet<ReadOnlyValidationDescriptor>();
const executionHostHandoffPrepareTimeoutMs = 60_000;

/**
 * Detached Core 在取得 owner lock 前完成一次全库核验，并以同进程对象能力交给 startOwned。
 * WeakSet 不可序列化、descriptor 自身已冻结；这里只消除同一 Core 进程内的重复哈希，不能跨进程伪造 Main 的核验。
 */
export async function verifyReadOnlyValidationBeforeOwnedCoreLock(descriptor: ReadOnlyValidationDescriptor): Promise<void> {
  await verifyReadOnlyValidationDescriptor(descriptor);
  readOnlyValidationVerifiedBeforeOwnedCoreLock.add(descriptor);
}

export type { DesktopLocalServerCloseMode } from './beforeQuitCleanup.js';

export interface RendererLocalServerConfig {
  baseUrl: string;
  apiToken: string;
  executionHostTransition: {
    state: 'current' | 'draining_previous';
    currentAppVersion: string;
    hostAppVersion: string;
    capabilities: ExecutionHostCapabilities;
  };
  readOnlyValidation?: ReadOnlyValidationIdentity;
}

export interface DesktopLocalServerRuntime {
  dbPath: string;
  configPath: string;
  config: RendererLocalServerConfig;
  readonly server?: RunningZeusLocalServer;
  executionHost: {
    mode: 'embedded' | 'detached';
    instanceId: string | null;
    pid: number;
    protocolVersion: number;
  };
  getStatus: () => Promise<ExecutionHostWorkStatus>;
  refreshConfig: () => Promise<RendererLocalServerConfig>;
  stopActiveWork: () => Promise<void>;
  close: (mode?: DesktopLocalServerCloseMode) => Promise<void>;
}

interface ExecutionHostHandoffPreparation {
  handoffId: string;
  checkpointSha256: string;
  requestCount: number;
  preparedAt: string;
}

export interface StartDesktopLocalServerOptions {
  userDataPath: string;
  dataLayout?: ZeusDataLayout;
  projectRoot: string;
  /** Main 已从 0600 root marker 核验；Browser/Core/Host 写入前必须再次匹配。 */
  dataRootIdentity: ZeusDataRootHostIdentity;
  /** Main 按正式/Test 身份与规范数据根派生；Detached Core 只能原样消费。 */
  keychainService: string;
  /** Main 已核验的正式副本描述符；Detached Core 必须复验并绑定同一 identity。 */
  readOnlyValidation?: ReadOnlyValidationDescriptor;
  appVersion?: string;
  currentAppVersion?: () => string;
  apiToken?: string;
  telegramToken?: string;
  /** 仅供已完成同一轮旧宿主清退与迁移预检的内嵌启动链使用。 */
  conversationStoreMigrationPrepared?: boolean;
  telegramAllowedUserIds?: number[];
  codexNativeEnabled?: boolean;
  codexLegacyImportRoot?: string;
  codexHome?: string;
  codexConfigImportSourceRoot?: string;
  releaseUpdateManifestUrl?: string;
  allowUntrustedReleaseUpdateTest?: boolean;
  taskAttachmentRoot?: string;
  browserAttachmentRoot?: string;
  conversationAttachmentRoot?: string;
  conversationAttachmentGrantSecret?: string;
  conversationAttachmentGrantSecretPath?: string;
  browserAutomation?: BrowserAutomationPort;
  executionHost?: {
    instanceId: string;
    protocolVersion: number;
    startedAt: string;
    mode: 'embedded' | 'detached';
  };
  /** 仅由拥有数据库生命周期的 Core 上报，不携带路径、token 或业务正文。 */
  onStartupStage?: (stage: ExecutionHostStartupStage) => void | Promise<void>;
  onRestarted?: (config: RendererLocalServerConfig) => void | Promise<void>;
}

export interface DesktopLocalAppConfigFile {
  appName: 'Zeus';
  projectRoot: string;
  dbPath: string;
  localLogDirectory: string;
  localServerHost: '127.0.0.1';
  updatedAt: string;
}

export interface ExecutionHostMaintenanceStatus {
  code: 'ZEUS_EXECUTION_HOST_PROTOCOL_INCOMPATIBLE' | 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH' | 'ZEUS_EXECUTION_HOST_OWNER_METADATA_CONFLICT' | 'ZEUS_EXECUTION_HOST_OWNER_UNCONFIRMED' | 'ZEUS_EXECUTION_HOST_STARTUP_TIMEOUT';
  currentProtocolVersion: number;
  hostProtocolVersion: number | null;
  hostAppVersion: string | null;
  hostPid: number | null;
  hostGenerationId: string | null;
  stage: string | null;
  detectedAt: string;
  message: string;
}

export type ExecutionHostLaunchCleanupOutcome = 'shutdown_completed' | 'already_exited' | 'identity_mismatch';

/**
 * 仅在本 Main 调用实际启动的 PID、请求 generation 与已发布 instance 三者完全一致时签发。
 * 这是进程内一次性对象能力，不写入 bootstrap/rendezvous，也不能转交给 Renderer。
 */
export interface ExecutionHostLaunchCleanupCapability {
  readonly launchedByThisInvocation: true;
  readonly requestedGenerationId: string;
  readonly instanceId: string;
  readonly pid: number;
  cleanupAfterAttachFailure(): Promise<ExecutionHostLaunchCleanupOutcome>;
}

export interface ExecutionHostLaunchCleanupCapabilityInput {
  userDataPath: string;
  dataRootIdentity: ZeusDataRootHostIdentity;
  requestedGenerationId: string;
  spawnedPid: number | null;
  rendezvous: ExecutionHostRendezvous;
}

export type ExecutionHostConnection =
  | {
      readonly rendezvous: ExecutionHostRendezvous;
      readonly launchedByThisInvocation: false;
    }
  | {
      readonly rendezvous: ExecutionHostRendezvous;
      readonly launchedByThisInvocation: true;
      readonly cleanupCapability: ExecutionHostLaunchCleanupCapability;
    };

export class ExecutionHostCompatibilityError extends Error {
  readonly name = 'ExecutionHostCompatibilityError';
  readonly code = 'ZEUS_EXECUTION_HOST_PROTOCOL_INCOMPATIBLE' as const;
  readonly maintenance: ExecutionHostMaintenanceStatus;

  constructor(identity: IncompatibleExecutionHostIdentity) {
    const message = `Zeus ${identity.appVersion} 的执行宿主仍在运行，但其协议 ${identity.protocolVersion} 与当前协议 ${executionHostProtocolVersion} 不兼容。为保护 SQLite 唯一写入者，当前版本已进入维护模式且没有启动第二宿主。`;
    super(message);
    this.maintenance = {
      code: this.code,
      currentProtocolVersion: executionHostProtocolVersion,
      hostProtocolVersion: identity.protocolVersion,
      hostAppVersion: identity.appVersion,
      hostPid: identity.pid,
      hostGenerationId: identity.generationId,
      stage: null,
      detectedAt: new Date().toISOString(),
      message,
    };
  }
}

class ExecutionHostOwnershipError extends Error {
  readonly name = 'ExecutionHostOwnershipError';
  readonly code: ExecutionHostMaintenanceStatus['code'];
  readonly maintenance: ExecutionHostMaintenanceStatus;

  constructor(input: {
    code: Exclude<ExecutionHostMaintenanceStatus['code'], 'ZEUS_EXECUTION_HOST_PROTOCOL_INCOMPATIBLE'>;
    message: string;
    protocolVersion?: number | null;
    appVersion?: string | null;
    pid?: number | null;
    generationId?: string | null;
    stage?: string | null;
  }) {
    super(input.message);
    this.code = input.code;
    this.maintenance = {
      code: input.code,
      currentProtocolVersion: executionHostProtocolVersion,
      hostProtocolVersion: input.protocolVersion ?? null,
      hostAppVersion: input.appVersion ?? null,
      hostPid: input.pid ?? null,
      hostGenerationId: input.generationId ?? null,
      stage: input.stage ?? null,
      detectedAt: new Date().toISOString(),
      message: input.message,
    };
  }
}

export function executionHostMaintenanceStatus(error: unknown): ExecutionHostMaintenanceStatus | null {
  return error instanceof ExecutionHostCompatibilityError || error instanceof ExecutionHostOwnershipError ? { ...error.maintenance } : null;
}

/**
 * 写入可追踪的本机运行配置文件；该文件只记录路径与监听边界，
 * 严禁写入 Renderer API token、Telegram token 等敏感凭据。
 */
async function writeDesktopLocalAppConfig(input: { configPath: string; userDataPath: string; projectRoot: string; dbPath: string }): Promise<void> {
  const configFile: DesktopLocalAppConfigFile = {
    appName: 'Zeus',
    projectRoot: input.projectRoot,
    dbPath: input.dbPath,
    localLogDirectory: `${input.dbPath}.logs`,
    localServerHost: '127.0.0.1',
    updatedAt: new Date().toISOString(),
  };

  await mkdir(dirname(input.configPath), { recursive: true });
  await writeFile(input.configPath, `${JSON.stringify(configFile, null, 2)}\n`, 'utf8');
}

/**
 * Browser bridge、Core、kernel lease 或配置文件产生任何副作用前的只读身份闸机。
 * 有发现文件但无法解析，或任一 rootId/profile/digest 不同，都不能降级成“没有 Host”。
 */
export async function assertDataRootAndAdvertisedHostIdentityBeforeEffects(options: StartDesktopLocalServerOptions): Promise<void> {
  verifyZeusDataRootHostIdentity({ rootPath: options.userDataPath, expected: options.dataRootIdentity, keychainService: options.keychainService });
  if (options.readOnlyValidation && options.dataRootIdentity.profile !== 'test') {
    throw Object.assign(new Error('Zeus read_only_validation 只能使用 test 数据根 profile。'), {
      code: 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH',
      failClosed: true as const,
    });
  }

  const incompatible = await readIncompatibleExecutionHostIdentity(options.userDataPath);
  if (incompatible) throw new ExecutionHostCompatibilityError(incompatible);
  const [lock, rendezvous, startup] = await Promise.all([readExecutionHostLockObservation(options.userDataPath), readExecutionHostRendezvous(options.userDataPath), readExecutionHostStartupStatus(options.userDataPath)]);
  if (lock.kind === 'legacy' || lock.kind === 'unconfirmed') throw advertisedHostIdentityError('host.lock 缺少可证明的数据根身份。');
  if (existsSync(executionHostRendezvousPath(options.userDataPath)) && !rendezvous) throw advertisedHostIdentityError('rendezvous.json 存在但无法安全解析。');
  if (existsSync(executionHostStartupPath(options.userDataPath)) && !startup) throw advertisedHostIdentityError('startup.json 存在但无法安全解析。');
  for (const identity of [lock.kind === 'current' ? lock.identity.dataRootIdentity : undefined, rendezvous?.dataRootIdentity, startup?.dataRootIdentity]) {
    if (identity && !sameZeusDataRootHostIdentity(identity, options.dataRootIdentity)) {
      throw advertisedHostIdentityError('既有 Execution Host 元数据绑定了不同的 rootId/profile/distribution。');
    }
  }
}

function advertisedHostIdentityError(detail: string): ExecutionHostOwnershipError {
  return new ExecutionHostOwnershipError({
    code: 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH',
    message: `Zeus 在 Browser/Core 启动前拒绝相反数据根 Host：${detail}`,
  });
}

/**
 * Electron Main 只连接独立执行宿主。宿主进程使用 Electron 的 Node 模式启动并脱离父进程，
 * 因而窗口重启、Main 退出或 App 原子替换不会直接终止正在执行的轮次。
 */
export async function startDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
  assertReadOnlyValidationDesktopOptions(options);
  await assertDataRootAndAdvertisedHostIdentityBeforeEffects(options);
  if (!options.browserAutomation) throw new Error('Zeus execution-host requires the Electron BrowserHost bridge.');
  if (!options.conversationAttachmentGrantSecretPath) throw new Error('Zeus execution-host requires a durable conversation attachment grant secret path.');

  const browserBridge = await startDesktopBrowserAutomationBridge(options.browserAutomation);
  const leaseId = randomUUID();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let handoffTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatCyclePromise: Promise<void> | undefined;
  let handoffProbePromise: Promise<void> | undefined;
  let recoveryPromise: Promise<void> | undefined;
  let handoffPromise: Promise<void> | undefined;
  let handoffRetryNotBeforeMs = 0;
  let legacyIdleHandoffObservation: { instanceId: string; fingerprint: string; observedAtMs: number } | undefined;
  let closePromise: Promise<void> | undefined;
  let closing = false;
  try {
    const initialConnection = await connectOrLaunchExecutionHost(options);
    let connection = initialConnection.rendezvous;
    let client = createExecutionHostControlClient(connection);
    const currentAppVersion = options.appVersion?.trim() || '0.0.0';
    const registration = {
      leaseId,
      baseUrl: browserBridge.baseUrl,
      token: browserBridge.token,
      appVersion: options.appVersion?.trim() || '0.0.0',
      dataRootIdentity: options.dataRootIdentity,
    };
    let lease: ExecutionHostLeaseStatus = await client
      .registerBrowserBridge(registration)
      .catch((error: unknown) => handleExecutionHostAttachFailure(error, initialConnection.launchedByThisInvocation ? initialConnection.cleanupCapability : undefined));
    assertReportedDataRootIdentity(lease.capabilities, options.dataRootIdentity);
    const config: RendererLocalServerConfig = {
      baseUrl: connection.baseUrl,
      apiToken: connection.apiToken,
      executionHostTransition: buildExecutionHostTransition(currentAppVersion, connection.appVersion, lease.capabilities),
      ...(connection.readOnlyValidation ? { readOnlyValidation: connection.readOnlyValidation } : {}),
    };
    const executionHost = {
      mode: 'detached' as const,
      instanceId: connection.instanceId,
      pid: connection.pid,
      protocolVersion: connection.protocolVersion,
    };

    const connectionChanged = (next: ExecutionHostRendezvous): boolean =>
      next.instanceId !== connection.instanceId ||
      next.pid !== connection.pid ||
      next.baseUrl !== connection.baseUrl ||
      next.apiToken !== connection.apiToken ||
      next.controlUrl !== connection.controlUrl ||
      next.controlToken !== connection.controlToken ||
      next.appVersion !== connection.appVersion;

    const attach = async (nextConnection: ExecutionHostConnection): Promise<void> => {
      const next = nextConnection.rendezvous;
      const nextClient = createExecutionHostControlClient(next);
      const nextLease: ExecutionHostLeaseStatus = await nextClient
        .registerBrowserBridge(registration)
        .catch((error: unknown) => handleExecutionHostAttachFailure(error, nextConnection.launchedByThisInvocation ? nextConnection.cleanupCapability : undefined));
      assertReportedDataRootIdentity(nextLease.capabilities, options.dataRootIdentity);
      const changed = connectionChanged(next);
      connection = next;
      client = nextClient;
      lease = nextLease;
      config.baseUrl = next.baseUrl;
      config.apiToken = next.apiToken;
      config.executionHostTransition = buildExecutionHostTransition(currentAppVersion, next.appVersion, nextLease.capabilities);
      if (next.readOnlyValidation) config.readOnlyValidation = next.readOnlyValidation;
      else delete config.readOnlyValidation;
      executionHost.instanceId = next.instanceId;
      executionHost.pid = next.pid;
      executionHost.protocolVersion = next.protocolVersion;
      legacyIdleHandoffObservation = undefined;
      if (changed) await options.onRestarted?.(config);
    };

    const handoffPreviousHostIfSafe = async (work: ExecutionHostWorkStatus): Promise<void> => {
      if (connection.appVersion === currentAppVersion || hasEffectfulExecution(work)) {
        legacyIdleHandoffObservation = undefined;
        return;
      }
      if (handoffPromise || Date.now() < handoffRetryNotBeforeMs) return;

      const previousInstanceId = connection.instanceId;
      const previousPid = connection.pid;
      const previousClient = client;
      const switching = (async () => {
        const capabilities = resolveExecutionHostCapabilities(connection.appVersion, lease.capabilities);
        if (capabilities.durableHandoff === 'sqlite_journal_v1') {
          try {
            const prepared = await prepareExecutionHostDurableHandoff(connection, currentAppVersion);
            await previousClient.handoff({ handoffId: prepared.handoffId, checkpointSha256: prepared.checkpointSha256 });
          } catch (error) {
            // 0.3.36/0.3.37 会把所有冲突交付 Map 项都当成写入，即使 Provider 已完成、
            // 只剩持久化 active 记录等待用户代码交付。新 Main 只能在重新读取宿主状态和
            // SQLite 后同时证明“没有执行工作、没有 preparing、阻断数不超过 active 数”时，
            // 退回旧协议已有的 graceful shutdown；任何不确定性都继续失败关闭。
            const refreshed = await previousClient.health();
            const legacyCandidate =
              refreshed.instanceId === previousInstanceId && refreshed.pid === previousPid
                ? legacyIdleTaskIntegrationHandoffCandidate({
                    error,
                    work: refreshed.work,
                    dbPath: connection.dbPath,
                    hostAppVersion: connection.appVersion,
                  })
                : null;
            if (!legacyCandidate) {
              legacyIdleHandoffObservation = undefined;
              throw error;
            }
            const nowMs = Date.now();
            const previousObservation = legacyIdleHandoffObservation;
            if (!previousObservation || previousObservation.instanceId !== previousInstanceId || previousObservation.fingerprint !== legacyCandidate.fingerprint || nowMs - previousObservation.observedAtMs < 30_000) {
              legacyIdleHandoffObservation =
                previousObservation?.instanceId === previousInstanceId && previousObservation.fingerprint === legacyCandidate.fingerprint
                  ? previousObservation
                  : { instanceId: previousInstanceId, fingerprint: legacyCandidate.fingerprint, observedAtMs: nowMs };
              throw error;
            }
            await previousClient.shutdown();
            legacyIdleHandoffObservation = undefined;
          }
        } else {
          // 旧宿主没有同库 journal 时，只有“完全没有任何工作”才可最终退出；存在 waiting 时绝不把 Main 内存当恢复权威。
          if (work.hasActiveWork || work.waitingRequestCount > 0) return;
          const confirmed = await previousClient.health();
          if (confirmed.work.hasActiveWork) return;
          await previousClient.shutdown();
        }
        await waitForExecutionHostExit(options.userDataPath, previousInstanceId, previousPid, options.dataRootIdentity);
        const next = await connectOrLaunchExecutionHost(options);
        await attach(next);
        handoffRetryNotBeforeMs = 0;
      })().catch((error: unknown) => {
        // 旧 Core 只能在 prepare 后报告后台阻断；对这类可恢复 409 做退避，避免
        // 每秒关闸一次。新 Core 会在关闸前预检，此分支保留跨版本兼容。
        if (isRetryableExecutionHostHandoffBlock(error)) handoffRetryNotBeforeMs = Date.now() + 15_000;
        throw error;
      });
      const tracked = switching.finally(() => {
        if (handoffPromise === tracked) handoffPromise = undefined;
      });
      handoffPromise = tracked;
      await tracked;
    };

    const recover = (discoverCurrent: boolean): Promise<void> => {
      if (recoveryPromise) return recoveryPromise;
      if (closing) return Promise.reject(new Error('Zeus execution-host connection is closing.'));
      const recovering = (async () => {
        if (!discoverCurrent) {
          try {
            lease = await client.registerBrowserBridge(registration);
            assertReportedDataRootIdentity(lease.capabilities, options.dataRootIdentity);
            config.executionHostTransition = buildExecutionHostTransition(currentAppVersion, connection.appVersion, lease.capabilities);
            return;
          } catch {
            // 当前控制端点已经不可用时，继续通过安全 rendezvous 发现唯一宿主。
          }
        }
        const advertised = await readExecutionHostRendezvous(options.userDataPath);
        if (advertised) {
          try {
            await attach(existingExecutionHostConnection(advertised));
            return;
          } catch {
            // 陈旧 rendezvous 不能成为第二数据库写入者的创建依据，由单实例锁继续裁决。
          }
        }
        await attach(await connectOrLaunchExecutionHost(options));
      })();
      const tracked = recovering.finally(() => {
        if (recoveryPromise === tracked) recoveryPromise = undefined;
      });
      recoveryPromise = tracked;
      return tracked;
    };

    const refreshConfig = async (): Promise<RendererLocalServerConfig> => {
      if (closing) throw new Error('Zeus execution-host connection is closing.');
      // 交接期间立即返回旧端口会让 Renderer 把 draining Core 当成当前连接，启动水合会把
      // ZEUS_EXECUTION_HOST_DRAINING 误报成整机启动失败。handoff 自身的 prepare、退出和新宿主
      // 发布都有独立上限，这里必须等待本次有界交接真正收口，不能再用更短的 8 秒窗口截断。
      if (handoffPromise) {
        const pendingHandoff = handoffPromise;
        await pendingHandoff.catch(() => undefined);
      }
      const advertised = await readExecutionHostRendezvous(options.userDataPath);
      if (advertised && connectionChanged(advertised)) await recover(true);
      else {
        try {
          await client.heartbeat(leaseId);
        } catch {
          await recover(false);
        }
      }
      return cloneRendererLocalServerConfig(config);
    };

    const maintainLease = async (): Promise<void> => {
      if (closing) return;
      try {
        await client.heartbeat(leaseId);
      } catch {
        // 旧宿主正在退出时由交接链负责注册新宿主，避免恢复链与交接争抢唯一 SQLite 写入者。
        if (handoffPromise) return;
        await recover(false);
      }
    };

    const probeHostHandoff = async (): Promise<void> => {
      if (closing || handoffPromise || recoveryPromise || connection.appVersion === currentAppVersion) return;
      const probeClient = client;
      const probedInstanceId = connection.instanceId;
      const status = await probeClient.health();
      // 心跳可能在探测期间完成重连；旧宿主状态不得驱动新宿主交接。
      if (client !== probeClient || connection.instanceId !== probedInstanceId) return;
      // 交接在独立任务中推进；无论快照多慢，1 秒心跳都不等待它。
      await handoffPreviousHostIfSafe(status.work);
    };

    heartbeatTimer = setInterval(() => {
      if (heartbeatCyclePromise || closing) return;
      const cycle = maintainLease().finally(() => {
        if (heartbeatCyclePromise === cycle) heartbeatCyclePromise = undefined;
      });
      heartbeatCyclePromise = cycle;
      void cycle.catch(() => undefined);
    }, 1_000);
    heartbeatTimer.unref();

    // 冷启动发现旧版本且当前没有执行工作时，先完成一次安全交接，再把业务配置交给 Renderer。
    // 心跳必须先开始：正式大库的持久化准备可能超过租约窗口的一半，不能在安全交接期间把正常
    // Main 误判成已离线。有活动工作或 preflight 阻断时旧 Core 继续正常提供界面。
    if (connection.appVersion !== currentAppVersion) {
      await probeHostHandoff().catch((error: unknown) => {
        console.warn('Zeus initial execution-host handoff did not complete; background supervision will continue.', error);
      });
    }

    handoffTimer = setInterval(() => {
      if (handoffProbePromise || handoffPromise || closing) return;
      const probe = probeHostHandoff().finally(() => {
        if (handoffProbePromise === probe) handoffProbePromise = undefined;
      });
      handoffProbePromise = probe;
      void probe.catch(() => undefined);
    }, 1_000);
    handoffTimer.unref();

    return {
      dbPath: connection.dbPath,
      configPath: (options.dataLayout ?? createZeusDataLayout(options.userDataPath)).localConfig,
      config,
      executionHost,
      getStatus: async () => {
        try {
          return (await client.health()).work;
        } catch {
          await recover(true);
          return (await client.health()).work;
        }
      },
      refreshConfig,
      stopActiveWork: async () => {
        // 一次用户动作只生成一次命令；recover 后必须复用同一对象，不能重新发 interrupt 身份。
        const commandRequest = createExecutionHostStopActiveCommandRequest();
        try {
          await client.stopActiveWork(commandRequest);
        } catch {
          await recover(true);
          await client.stopActiveWork(commandRequest);
        }
      },
      close: (mode = 'final_quit') => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          closing = true;
          if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
          }
          if (handoffTimer) {
            clearInterval(handoffTimer);
            handoffTimer = undefined;
          }
          const errors: unknown[] = [];
          const pendingHeartbeat = heartbeatCyclePromise;
          if (pendingHeartbeat) {
            try {
              await pendingHeartbeat;
            } catch (error) {
              errors.push(error);
            }
          }
          const pendingRecovery = recoveryPromise;
          if (pendingRecovery) {
            try {
              await pendingRecovery;
            } catch (error) {
              errors.push(error);
            }
          }
          const pendingHandoffProbe = handoffProbePromise;
          if (pendingHandoffProbe) {
            try {
              await pendingHandoffProbe;
            } catch (error) {
              errors.push(error);
            }
          }
          const pendingHandoff = handoffPromise;
          if (pendingHandoff) {
            try {
              await pendingHandoff;
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            if (mode === 'force_quit') {
              let status;
              try {
                status = await client.health();
              } catch {
                // 控制面不可达时不得按陈旧 PID 强杀，也不得删除可能刚由新宿主替换的发现路径。
                status = undefined;
              }
              if (status) {
                if (status.instanceId !== connection.instanceId || status.pid !== connection.pid || connection.pid <= 1 || connection.pid === process.pid) {
                  throw new Error('Zeus 拒绝强制结束身份不匹配的执行宿主。');
                }
                try {
                  // 执行宿主以独立进程组启动；结束进程组才能同时收口其 Codex、Pi 和 Runtime 子进程。
                  process.kill(-connection.pid, 'SIGKILL');
                } catch (error) {
                  if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
                }
                await waitForExecutionHostExit(options.userDataPath, connection.instanceId, connection.pid, options.dataRootIdentity);
              }
            } else if (mode === 'final_quit') {
              await client.shutdown();
              await waitForExecutionHostExit(options.userDataPath, connection.instanceId, connection.pid, options.dataRootIdentity);
            } else await client.detach(leaseId);
          } catch (error) {
            errors.push(error);
          }
          try {
            await browserBridge.close();
          } catch (error) {
            errors.push(error);
          }
          throwCollectedCleanupErrors(errors, 'Zeus desktop execution-host disconnect failed.');
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await browserBridge.close().catch(() => undefined);
    throw error;
  }
}

/**
 * 主进程内嵌启动前先清退旧版本遗留的独立宿主，避免升级后出现两个 SQLite 写入者。
 * 独立宿主上的活动工作会先停止；这是移除后台常驻能力后的明确退出语义。
 */
export async function startEmbeddedDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
  if (options.readOnlyValidation) return startOwnedDesktopLocalServer({ ...options, conversationStoreMigrationPrepared: true });
  await prepareDesktopConversationStoreMigration(options.userDataPath, options.dataRootIdentity, options.dataLayout);
  return startOwnedDesktopLocalServer({ ...options, conversationStoreMigrationPrepared: true });
}

/** 首次启动和维护页重试共享完全相同的旧宿主清退与数据库预检顺序。 */
export async function prepareDesktopConversationStoreMigration(userDataPath: string, dataRootIdentity: ZeusDataRootHostIdentity, providedLayout?: ZeusDataLayout) {
  const dataLayout = providedLayout ?? createZeusDataLayout(userDataPath);
  return prepareUnifiedConversationStoreMigration(dataLayout, {
    preflightGuard: () => retireDetachedExecutionHost(userDataPath, dataRootIdentity),
  });
}

/** Local Server、SQLite 与 Codex app-server 由当前进程直接持有。 */
export async function startOwnedDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
  verifyZeusDataRootHostIdentity({ rootPath: options.userDataPath, expected: options.dataRootIdentity, keychainService: options.keychainService });
  const canonicalValidationLayout = assertReadOnlyValidationDesktopOptions(options);
  if (options.readOnlyValidation && !readOnlyValidationVerifiedBeforeOwnedCoreLock.delete(options.readOnlyValidation)) {
    await verifyReadOnlyValidationDescriptor(options.readOnlyValidation);
  }
  const apiToken = options.apiToken ?? randomBytes(24).toString('base64url');
  const dataLayout = canonicalValidationLayout ?? options.dataLayout ?? createZeusDataLayout(options.userDataPath);
  const dbPath = dataLayout.database;
  const configPath = dataLayout.localConfig;
  const restartDelayMs = 1_000;
  // 内嵌 Local Server 不再经过独立宿主的 spawn 环境，必须让所有运行世代固定使用 Zeus 的 Codex Home。
  const codexAppServerManager = options.readOnlyValidation
    ? createReadOnlyValidationCodexManager()
    : createCodexRuntimeGenerationManager({
        codexHome: options.codexHome ?? dataLayout.codexHome,
      });
  let closingIntentionally = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let closingMode: DesktopLocalServerCloseMode = 'final_quit';
  let shutdownOwner: RunningZeusLocalServer | undefined;
  let shutdownOwnerFinalized = false;
  // 业务 HTTP 服务启动前先完成候选库构建、校验和同卷提升，并暴露不含数据内容的阶段水位。
  await options.onStartupStage?.('migration_preflight_started');
  if (!options.readOnlyValidation && !options.conversationStoreMigrationPrepared) await prepareUnifiedConversationStoreMigration(dataLayout);
  await options.onStartupStage?.('migration_preflight_completed');
  if (!options.readOnlyValidation) {
    await writeDesktopLocalAppConfig({
      configPath,
      userDataPath: options.userDataPath,
      projectRoot: options.projectRoot,
      dbPath,
    });
  }
  let currentServer: RunningZeusLocalServer;
  try {
    await options.onStartupStage?.('core_runtime_starting');
    currentServer = await launchServer();
  } catch (launchError) {
    const cleanupErrors: unknown[] = [];
    try {
      await codexAppServerManager.prepareForShutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await codexAppServerManager.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError([launchError, ...cleanupErrors], 'Initial Zeus local-server launch and manager cleanup failed.');
    throw launchError;
  }
  const config: RendererLocalServerConfig = {
    baseUrl: currentServer.baseUrl,
    apiToken,
    executionHostTransition: buildExecutionHostTransition(options.appVersion?.trim() || '0.0.0', options.appVersion?.trim() || '0.0.0', executionHostCapabilitiesFor(options.dataRootIdentity, options.readOnlyValidation)),
    ...(options.readOnlyValidation ? { readOnlyValidation: readOnlyValidationIdentity(options.readOnlyValidation) } : {}),
  };

  async function launchServer(): Promise<RunningZeusLocalServer> {
    const server = await startZeusLocalServer({
      dbPath,
      dataLayout,
      localConfigPath: configPath,
      apiToken,
      projectRoot: options.projectRoot,
      keychainService: options.keychainService,
      currentAppVersion: options.currentAppVersion ?? options.appVersion,
      telegramToken: options.telegramToken,
      telegramAllowedUserIds: options.telegramAllowedUserIds,
      codexNativeEnabled: options.codexNativeEnabled ?? true,
      codexRuntimeCommandPath: 'codex',
      codexLegacyImportRoot: options.codexLegacyImportRoot,
      codexHome: options.codexHome,
      codexConfigImportSourceRoot: options.codexConfigImportSourceRoot,
      releaseUpdateManifestUrl: options.releaseUpdateManifestUrl,
      allowUntrustedReleaseUpdateTest: options.allowUntrustedReleaseUpdateTest,
      taskAttachmentRoot: options.taskAttachmentRoot,
      browserAttachmentRoot: options.browserAttachmentRoot,
      conversationAttachmentRoot: options.conversationAttachmentRoot,
      conversationAttachmentGrantSecret: options.conversationAttachmentGrantSecret,
      browserAutomation: options.browserAutomation,
      executionHost: options.executionHost,
      codexAppServerManager,
      readOnlyValidation: options.readOnlyValidation,
    });
    server.server.server.once('close', () => {
      if (closingIntentionally) return;
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (restartPromise) return;
        const restarting = restartAfterUnexpectedClose().catch((error: unknown) => {
          if (hasCodexFinalizationOwnershipClaim(error)) shutdownOwnerFinalized = true;
          throw error;
        });
        const trackedRestart = restarting.finally(() => {
          if (restartPromise === trackedRestart) restartPromise = undefined;
        });
        restartPromise = trackedRestart;
        void restartPromise.catch(() => undefined);
      }, restartDelayMs);
    });
    return server;
  }

  async function restartAfterUnexpectedClose(): Promise<void> {
    if (closingIntentionally) return;
    const restartedServer = await launchServer();
    if (closingIntentionally) {
      const errors: unknown[] = [];
      shutdownOwner = restartedServer;
      if (closingMode !== 'upgrade_handoff') {
        try {
          await restartedServer.prepareForShutdown();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await restartedServer.close();
      } catch (error) {
        errors.push(error);
      }
      shutdownOwnerFinalized = true;
      throwCollectedCleanupErrors(errors, 'Late Zeus local-server restart cleanup failed.');
      return;
    }
    currentServer = restartedServer;
    config.baseUrl = restartedServer.baseUrl;
    await options.onRestarted?.(config);
  }

  return {
    dbPath,
    configPath,
    get server() {
      return currentServer;
    },
    config,
    executionHost: {
      mode: options.executionHost?.mode ?? 'embedded',
      instanceId: options.executionHost?.instanceId ?? null,
      pid: process.pid,
      protocolVersion: options.executionHost?.protocolVersion ?? executionHostProtocolVersion,
    },
    getStatus: async () => {
      const response = await fetch(`${config.baseUrl}/api/execution-host/status`, {
        headers: { authorization: `Bearer ${config.apiToken}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Zeus execution-host status failed with HTTP ${response.status}.`);
      return (await response.json()) as ExecutionHostWorkStatus;
    },
    refreshConfig: async () => cloneRendererLocalServerConfig(config),
    stopActiveWork: async () => {
      const commandRequest = createExecutionHostStopActiveCommandRequest();
      const serializedBody = JSON.stringify(commandRequest);
      const response = await fetch(`${config.baseUrl}/api/execution-host/stop-active`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiToken}`, 'content-type': 'application/json' },
        body: serializedBody,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Zeus execution-host stop failed with HTTP ${response.status}.`);
    },
    close: (mode = 'final_quit') => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closingIntentionally = true;
        closingMode = mode;
        const errors: unknown[] = [];
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = undefined;
        }
        const pendingRestart = restartPromise;
        if (pendingRestart) {
          try {
            await pendingRestart;
          } catch (error) {
            if (hasCodexFinalizationOwnershipClaim(error)) shutdownOwnerFinalized = true;
            collectCleanupError(errors, error);
          }
        }
        if (!shutdownOwnerFinalized) {
          const finalizationOwner = shutdownOwner ?? currentServer;
          if (mode !== 'upgrade_handoff') {
            try {
              await finalizationOwner.prepareForShutdown();
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            await finalizationOwner.close();
          } catch (error) {
            errors.push(error);
          }
        }
        if (mode !== 'upgrade_handoff') {
          try {
            await codexAppServerManager.prepareForShutdown();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await codexAppServerManager.close();
        } catch (error) {
          errors.push(error);
        }
        throwCollectedCleanupErrors(errors, 'Zeus desktop local-server shutdown failed.');
      })();
      return closePromise;
    },
  };
}

function existingExecutionHostConnection(rendezvous: ExecutionHostRendezvous): ExecutionHostConnection {
  return { rendezvous, launchedByThisInvocation: false };
}

/**
 * 为“本次 spawn 确实赢得唯一 owner”创建一次性失败补偿能力。
 * 任一身份不一致都意味着本调用没有处置该 Host 的授权。
 */
export function createExecutionHostLaunchCleanupCapability(input: ExecutionHostLaunchCleanupCapabilityInput): ExecutionHostLaunchCleanupCapability | null {
  const { rendezvous } = input;
  if (
    !input.requestedGenerationId ||
    !input.spawnedPid ||
    input.spawnedPid <= 1 ||
    input.spawnedPid === process.pid ||
    rendezvous.protocolVersion !== executionHostProtocolVersion ||
    rendezvous.ownershipMode !== 'kernel_lease_v1' ||
    rendezvous.instanceId !== input.requestedGenerationId ||
    rendezvous.pid !== input.spawnedPid
  ) {
    return null;
  }

  const boundInput: ExecutionHostLaunchCleanupCapabilityInput = Object.freeze({
    userDataPath: input.userDataPath,
    dataRootIdentity: Object.freeze({ ...input.dataRootIdentity }),
    requestedGenerationId: input.requestedGenerationId,
    spawnedPid: input.spawnedPid,
    rendezvous: Object.freeze({
      ...rendezvous,
      ...(rendezvous.readOnlyValidation ? { readOnlyValidation: Object.freeze({ ...rendezvous.readOnlyValidation }) } : {}),
    }),
  });
  let cleanupPromise: Promise<ExecutionHostLaunchCleanupOutcome> | undefined;
  const capability: ExecutionHostLaunchCleanupCapability = {
    launchedByThisInvocation: true,
    requestedGenerationId: boundInput.requestedGenerationId,
    instanceId: rendezvous.instanceId,
    pid: rendezvous.pid,
    cleanupAfterAttachFailure() {
      cleanupPromise ??= cleanupExecutionHostLaunchedByInvocation(boundInput);
      return cleanupPromise;
    },
  };
  return Object.freeze(capability);
}

/** Attach 失败必须保留原错误；补偿本身失败时把两条故障链一起上报，不能伪报已收口。 */
export async function handleExecutionHostAttachFailure(error: unknown, capability?: ExecutionHostLaunchCleanupCapability): Promise<never> {
  if (!capability) throw error;
  try {
    const outcome = await capability.cleanupAfterAttachFailure();
    if (outcome === 'identity_mismatch') {
      throw Object.assign(new Error('Zeus 拒绝收口身份已漂移或不可证明仍属于本次启动的 execution-host。'), {
        code: 'ZEUS_EXECUTION_HOST_ATTACH_CLEANUP_IDENTITY_MISMATCH' as const,
      });
    }
  } catch (cleanupError) {
    throw new AggregateError([error, cleanupError], 'Zeus 新建 execution-host attach 失败，且本次启动的 Host 未能完成安全收口。');
  }
  throw error;
}

async function cleanupExecutionHostLaunchedByInvocation(input: ExecutionHostLaunchCleanupCapabilityInput): Promise<ExecutionHostLaunchCleanupOutcome> {
  const expected = input.rendezvous;
  if (!processExists(expected.pid) && inspectExecutionHostKernelLease(input.userDataPath, input.dataRootIdentity) === 'available') return 'already_exited';

  const current = await readHealthyExecutionHost(input.userDataPath, input.dataRootIdentity, expected.readOnlyValidation);
  if (!current || !sameExecutionHostLaunchIdentity(current, expected, input.requestedGenerationId, input.spawnedPid)) return 'identity_mismatch';

  const lock = await readExecutionHostLockIdentity(input.userDataPath);
  if (
    !lock ||
    lock.ownershipMode !== 'kernel_lease_v1' ||
    lock.generationId !== input.requestedGenerationId ||
    lock.pid !== input.spawnedPid ||
    lock.protocolVersion !== expected.protocolVersion ||
    lock.appVersion !== expected.appVersion ||
    !sameReadOnlyValidationIdentity(lock.readOnlyValidation, expected.readOnlyValidation) ||
    !sameZeusDataRootHostIdentity(lock.dataRootIdentity, input.dataRootIdentity) ||
    inspectExecutionHostKernelLease(input.userDataPath, input.dataRootIdentity) !== 'held' ||
    !processExists(input.spawnedPid)
  ) {
    return 'identity_mismatch';
  }

  const client = createExecutionHostControlClient(current);
  const status = await client.health();
  if (
    status.instanceId !== input.requestedGenerationId ||
    status.pid !== input.spawnedPid ||
    status.protocolVersion !== expected.protocolVersion ||
    status.appVersion !== expected.appVersion ||
    status.startedAt !== expected.startedAt ||
    !sameReadOnlyValidationIdentity(status.capabilities?.readOnlyValidation, expected.readOnlyValidation) ||
    !sameZeusDataRootHostIdentity(status.capabilities?.dataRootIdentity, input.dataRootIdentity)
  ) {
    return 'identity_mismatch';
  }

  // validation 也只走本机控制面的 final shutdown；不 stop work、不触碰正式根、不按陈旧 PID 发信号。
  await client.shutdown();
  await waitForExecutionHostExit(input.userDataPath, input.requestedGenerationId, input.spawnedPid, input.dataRootIdentity);
  return 'shutdown_completed';
}

function sameExecutionHostLaunchIdentity(current: ExecutionHostRendezvous, expected: ExecutionHostRendezvous, requestedGenerationId: string, spawnedPid: number | null): boolean {
  return (
    current.instanceId === requestedGenerationId &&
    current.instanceId === expected.instanceId &&
    current.pid === spawnedPid &&
    current.pid === expected.pid &&
    current.protocolVersion === expected.protocolVersion &&
    current.appVersion === expected.appVersion &&
    current.startedAt === expected.startedAt &&
    current.baseUrl === expected.baseUrl &&
    current.apiToken === expected.apiToken &&
    current.controlUrl === expected.controlUrl &&
    current.controlToken === expected.controlToken &&
    current.dbPath === expected.dbPath &&
    current.projectRoot === expected.projectRoot &&
    current.ownershipMode === 'kernel_lease_v1' &&
    sameZeusDataRootHostIdentity(current.dataRootIdentity, expected.dataRootIdentity) &&
    sameReadOnlyValidationIdentity(current.readOnlyValidation, expected.readOnlyValidation)
  );
}

async function connectOrLaunchExecutionHost(options: StartDesktopLocalServerOptions): Promise<ExecutionHostConnection> {
  const dataLayout = assertReadOnlyValidationDesktopOptions(options) ?? options.dataLayout ?? createZeusDataLayout(options.userDataPath);
  const expectedValidationIdentity = options.readOnlyValidation ? readOnlyValidationIdentity(options.readOnlyValidation) : undefined;
  const ownerBeforeConnect = await readExecutionHostOwnerState(options.userDataPath, options.dataRootIdentity, expectedValidationIdentity);
  assertExecutionHostIdentities(ownerBeforeConnect, options.dataRootIdentity, expectedValidationIdentity);
  const incompatible = await readIncompatibleExecutionHostIdentity(options.userDataPath);
  if (incompatible && (ownerBeforeConnect.kernelLeaseHeld || processExists(incompatible.pid) || ownerBeforeConnect.lock.kind !== 'absent')) throw new ExecutionHostCompatibilityError(incompatible);
  const existing = await readHealthyExecutionHost(options.userDataPath, options.dataRootIdentity, expectedValidationIdentity);
  if (existing) return existingExecutionHostConnection(existing);

  // 内核租约可能早于诊断身份、控制面与 rendezvous 写出。只要租约仍被持有，就等待唯一 Core；
  // PID/JSON 只用于诊断，不能代替由 SQLite/OS 裁决的互斥事实。
  if (ownerBeforeConnect.ownerPresent) {
    const awaited = await waitForExecutionHostReady({
      userDataPath: options.userDataPath,
      initialOwnerPid: ownerBeforeConnect.pid,
      allowOwnerExit: true,
      expectedDataRootIdentity: options.dataRootIdentity,
      expectedValidationIdentity,
    });
    if (awaited) return existingExecutionHostConnection(awaited);
  }

  const requestedInstanceId = randomUUID();
  const bootstrapPath = await writeExecutionHostBootstrap(options.userDataPath, {
    protocolVersion: executionHostProtocolVersion,
    requestedInstanceId,
    userDataPath: options.userDataPath,
    dataLayoutKind: dataLayout.kind,
    databasePath: dataLayout.database,
    executionHostDirectoryPath: dataLayout.executionHost,
    projectRoot: options.projectRoot,
    keychainService: options.keychainService,
    dataRootIdentity: options.dataRootIdentity,
    codexNativeEnabled: options.readOnlyValidation ? false : (options.codexNativeEnabled ?? true),
    codexLegacyImportRoot: options.readOnlyValidation ? dataLayout.codexLegacyImports : (options.codexLegacyImportRoot ?? dataLayout.codexLegacyImports),
    codexHome: options.readOnlyValidation ? dataLayout.codexHome : (options.codexHome ?? dataLayout.codexHome),
    // validation bootstrap 也必须携带 validationRoot 内的规范占位路径，不能因功能已禁用而回退到正式 ~/.codex。
    codexConfigImportSourceRoot: options.readOnlyValidation ? dataLayout.codexHome : (options.codexConfigImportSourceRoot ?? join(homedir(), '.codex')),
    releaseUpdateManifestUrl: options.readOnlyValidation ? undefined : options.releaseUpdateManifestUrl,
    allowUntrustedReleaseUpdateTest: options.readOnlyValidation ? false : options.allowUntrustedReleaseUpdateTest,
    taskAttachmentRoot: options.taskAttachmentRoot ?? dataLayout.taskAttachments,
    browserAttachmentRoot: options.browserAttachmentRoot ?? dataLayout.browserComments,
    conversationAttachmentRoot: options.conversationAttachmentRoot ?? dataLayout.conversationAttachments,
    conversationAttachmentGrantSecretPath: options.conversationAttachmentGrantSecretPath!,
    telegramAllowedUserIds: options.readOnlyValidation ? undefined : options.telegramAllowedUserIds,
    appVersion: options.appVersion?.trim() || '0.0.0',
    createdAt: new Date().toISOString(),
    readOnlyValidation: options.readOnlyValidation,
  });
  const entryPath = join(dirname(fileURLToPath(import.meta.url)), 'executionHost.js');
  const childEnvironment = { ...process.env };
  if (options.readOnlyValidation) {
    for (const key of ['CODEX_HOME', 'ZEUS_TELEGRAM_BOT_TOKEN', 'ZEUS_TELEGRAM_ALLOWED_USER_IDS', 'ZEUS_RELEASE_UPDATE_MANIFEST_URL', 'ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST']) delete childEnvironment[key];
  }
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...childEnvironment,
      ELECTRON_RUN_AS_NODE: '1',
      ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH: bootstrapPath,
      ...(options.readOnlyValidation ? {} : { CODEX_HOME: options.codexHome ?? dataLayout.codexHome }),
      ...(!options.readOnlyValidation && options.telegramToken ? { ZEUS_TELEGRAM_BOT_TOKEN: options.telegramToken } : {}),
    },
  });
  let childFailure: Error | null = null;
  child.once('error', (error) => {
    childFailure = error;
  });
  child.once('exit', (code, signal) => {
    childFailure ??= new Error(`Zeus Core 在发布控制面前退出（code=${String(code)}, signal=${String(signal)}）。`);
  });
  child.unref();
  const launched = await waitForExecutionHostReady({
    userDataPath: options.userDataPath,
    initialOwnerPid: child.pid ?? null,
    allowOwnerExit: false,
    expectedDataRootIdentity: options.dataRootIdentity,
    expectedValidationIdentity,
    childFailure: () => childFailure,
  });
  if (launched) {
    const cleanupCapability = createExecutionHostLaunchCleanupCapability({
      userDataPath: options.userDataPath,
      dataRootIdentity: options.dataRootIdentity,
      requestedGenerationId: requestedInstanceId,
      spawnedPid: child.pid ?? null,
      rendezvous: launched,
    });
    return cleanupCapability ? { rendezvous: launched, launchedByThisInvocation: true, cleanupCapability } : existingExecutionHostConnection(launched);
  }
  throw new Error('Zeus Core 未发布可连接控制面。');
}

/**
 * read_only_validation 在任何 Browser bridge、宿主锁或 bootstrap 目录动作前绑定唯一规范根。
 * 返回值只供调用方复用已验证布局；普通可写启动不改变既有布局选择规则。
 */
export function assertReadOnlyValidationDesktopOptions(options: StartDesktopLocalServerOptions): ZeusDataLayout | null {
  const descriptor = options.readOnlyValidation;
  if (!descriptor) return null;
  const expected = createZeusDataLayout(descriptor.validationRoot);
  const provided = options.dataLayout ?? createZeusDataLayout(options.userDataPath);
  const expectedKeychainService = resolveDesktopKeychainService({ profile: 'test', dataRootPath: expected.root });
  const expectedGrantSecret = createHash('sha256').update(`zeus-read-only-validation-grant:${descriptor.runId}:${descriptor.manifestHash}`).digest('base64url');
  const pathBindings: Array<[label: string, actual: string | undefined, canonical: string]> = [
    ['userDataPath', options.userDataPath, expected.root],
    ['dataLayout.root', provided.root, expected.root],
    ['dataLayout.database', provided.database, expected.database],
    ['dataLayout.executionHost', provided.executionHost, expected.executionHost],
    ['projectRoot', options.projectRoot, expected.root],
    ['taskAttachmentRoot', options.taskAttachmentRoot, expected.taskAttachments],
    ['browserAttachmentRoot', options.browserAttachmentRoot, expected.browserComments],
    ['conversationAttachmentRoot', options.conversationAttachmentRoot, expected.conversationAttachments],
    ['conversationAttachmentGrantSecretPath', options.conversationAttachmentGrantSecretPath, expected.conversationAttachmentGrantSecret],
  ];
  for (const [label, actual, canonical] of pathBindings) {
    if (actual !== canonical) throw readOnlyValidationDesktopBindingError(`${label} 未绑定 validationRoot 的规范路径。`);
  }
  for (const [label, actual, canonical] of [
    ['codexHome', options.codexHome, expected.codexHome],
    ['codexLegacyImportRoot', options.codexLegacyImportRoot, expected.codexLegacyImports],
    ['codexConfigImportSourceRoot', options.codexConfigImportSourceRoot, expected.codexHome],
  ] as const) {
    if (actual !== undefined && actual !== canonical) throw readOnlyValidationDesktopBindingError(`${label} 不能指向 validationRoot 之外。`);
  }
  if (
    provided.kind !== 'layered' ||
    descriptor.validationRoot !== expected.root ||
    descriptor.database.path !== expected.database ||
    options.dataRootIdentity.profile !== 'test' ||
    options.keychainService !== expectedKeychainService ||
    options.codexNativeEnabled !== false ||
    options.telegramToken !== undefined ||
    options.telegramAllowedUserIds !== undefined ||
    options.releaseUpdateManifestUrl !== undefined ||
    options.allowUntrustedReleaseUpdateTest === true ||
    (options.conversationAttachmentGrantSecret !== undefined && options.conversationAttachmentGrantSecret !== expectedGrantSecret)
  ) {
    throw readOnlyValidationDesktopBindingError('启动选项混入可写根、Provider、Keychain、Telegram 或 Release 身份。');
  }
  return expected;
}

function readOnlyValidationDesktopBindingError(detail: string): Error {
  return Object.assign(new Error(`Zeus read_only_validation 启动身份不一致：${detail}`), {
    code: 'ZEUS_READ_ONLY_VALIDATION_BOOTSTRAP_MISMATCH' as const,
    failClosed: true as const,
  });
}

const executionHostSafeStartupLimitMs = 120_000;
const executionHostUnconfirmedOwnerLimitMs = 5_000;
const executionHostChildExitDiscoveryGraceMs = 5_000;

async function waitForExecutionHostReady(input: {
  userDataPath: string;
  initialOwnerPid: number | null;
  allowOwnerExit: boolean;
  expectedDataRootIdentity: ZeusDataRootHostIdentity;
  expectedValidationIdentity?: ReadOnlyValidationIdentity;
  childFailure?: () => Error | null;
}): Promise<ExecutionHostRendezvous | null> {
  const deadline = Date.now() + executionHostSafeStartupLimitMs;
  let observedOwnerPid = input.initialOwnerPid;
  let ownerUnconfirmedSince: number | null = null;
  let childFailureObservedAt: number | null = null;
  while (Date.now() < deadline) {
    const healthy = await readHealthyExecutionHost(input.userDataPath, input.expectedDataRootIdentity, input.expectedValidationIdentity);
    if (healthy) return healthy;

    const owner = await readExecutionHostOwnerState(input.userDataPath, input.expectedDataRootIdentity, input.expectedValidationIdentity);
    assertExecutionHostIdentities(owner, input.expectedDataRootIdentity, input.expectedValidationIdentity);
    if (owner.pid) observedOwnerPid = owner.pid;
    if (owner.certainty === 'unconfirmed') {
      ownerUnconfirmedSince ??= Date.now();
      if (Date.now() - ownerUnconfirmedSince >= executionHostUnconfirmedOwnerLimitMs) {
        throw await createExecutionHostOwnershipError(input.userDataPath, owner, owner.metadataConflict ? 'ZEUS_EXECUTION_HOST_OWNER_METADATA_CONFLICT' : 'ZEUS_EXECUTION_HOST_OWNER_UNCONFIRMED');
      }
    } else {
      ownerUnconfirmedSince = null;
    }
    const childFailure = input.childFailure?.() ?? null;
    if (childFailure) childFailureObservedAt ??= Date.now();
    else childFailureObservedAt = null;
    // 两个 Main 在升级重启窗口可能同时观察到旧 Core 退出并各自启动候选宿主。
    // 败选子进程会先退出，而胜选者的内核租约、lock 与 rendezvous 仍在发布途中；
    // 给唯一宿主一个短发现窗口，避免把正常竞争误报成整机启动失败。
    if (!owner.ownerPresent && childFailure && childFailureObservedAt !== null && Date.now() - childFailureObservedAt >= executionHostChildExitDiscoveryGraceMs) throw childFailure;
    if (!owner.ownerPresent && input.allowOwnerExit) return null;
    await wait(100);
  }

  const startup = await readExecutionHostStartupStatus(input.userDataPath);
  const lock = await readExecutionHostLockIdentity(input.userDataPath);
  const generationId = startup?.generationId ?? lock?.generationId ?? 'unknown';
  const stage = startup?.stage ?? 'lock_or_bootstrap_pending';
  const pid = lock?.pid ?? observedOwnerPid ?? 'unknown';
  throw new ExecutionHostOwnershipError({
    code: 'ZEUS_EXECUTION_HOST_STARTUP_TIMEOUT',
    message: `Zeus Core 在 ${executionHostSafeStartupLimitMs / 1_000} 秒安全上限内仍未就绪（generation=${generationId}, pid=${String(pid)}, stage=${stage}）；为保护 SQLite 唯一写入者，未创建第二宿主。`,
    generationId: generationId === 'unknown' ? null : generationId,
    pid: typeof pid === 'number' ? pid : null,
    stage,
  });
}

export interface ExecutionHostOwnerState {
  ownerPresent: boolean;
  certainty: 'none' | 'confirmed' | 'unconfirmed';
  kernelLeaseHeld: boolean;
  recoverableStaleV2?: boolean;
  pid: number | null;
  lock: ExecutionHostLockObservation;
  rendezvous: ExecutionHostRendezvous | null;
  metadataConflict: boolean;
}

export async function readExecutionHostOwnerState(userDataPath: string, expectedDataRootIdentity: ZeusDataRootHostIdentity, expectedValidationIdentity?: ReadOnlyValidationIdentity): Promise<ExecutionHostOwnerState> {
  const kernelLeaseHeld = inspectExecutionHostKernelLease(userDataPath, expectedDataRootIdentity) === 'held';
  const lock = await readExecutionHostLockObservation(userDataPath);
  const rendezvous = await readExecutionHostRendezvous(userDataPath);
  const lockPid = lock.kind === 'current' || lock.kind === 'legacy' ? lock.identity.pid : null;
  if (kernelLeaseHeld) {
    const pid = processExists(lockPid) ? lockPid : processExists(rendezvous?.pid ?? null) ? rendezvous!.pid : null;
    const metadataConflict =
      lock.kind === 'current' &&
      (!sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, expectedDataRootIdentity) ||
        !sameReadOnlyValidationIdentity(lock.identity.readOnlyValidation, expectedValidationIdentity) ||
        (rendezvous !== null && (!sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, rendezvous.dataRootIdentity) || !sameReadOnlyValidationIdentity(lock.identity.readOnlyValidation, rendezvous.readOnlyValidation))));
    return { ownerPresent: true, certainty: metadataConflict ? 'unconfirmed' : 'confirmed', kernelLeaseHeld: true, pid, lock, rendezvous, metadataConflict };
  }

  // 当前 v2 lock 明确声明 kernel lease、但 OS 已释放租约时，允许 Main 启动竞争 Child；
  // 只有实际取得同 rootId lease 的 Child 才能 CAS quarantine/replace。PID 可能复用，不参与否决。
  if (lock.kind === 'current' && lock.identity.ownershipMode === 'kernel_lease_v1') {
    const metadataConflict =
      !sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, expectedDataRootIdentity) ||
      !sameReadOnlyValidationIdentity(lock.identity.readOnlyValidation, expectedValidationIdentity) ||
      (rendezvous !== null && (!sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, rendezvous.dataRootIdentity) || !sameReadOnlyValidationIdentity(lock.identity.readOnlyValidation, rendezvous.readOnlyValidation)));
    if (metadataConflict) {
      return { ownerPresent: true, certainty: 'unconfirmed', kernelLeaseHeld: false, pid: lock.identity.pid, lock, rendezvous, metadataConflict: true };
    }
    return {
      ownerPresent: false,
      certainty: 'none',
      kernelLeaseHeld: false,
      recoverableStaleV2: true,
      pid: lock.identity.pid,
      lock,
      rendezvous,
      metadataConflict: false,
    };
  }

  // legacy、未声明 kernel ownership、空/非法/不安全文件仍进入维护；Main 永不删除/覆盖。
  if (lock.kind === 'unconfirmed') {
    return { ownerPresent: true, certainty: 'unconfirmed', kernelLeaseHeld: false, pid: processExists(lockPid) ? lockPid : null, lock, rendezvous, metadataConflict: false };
  }
  if (lock.kind === 'current' || lock.kind === 'legacy') {
    const metadataConflict =
      rendezvous !== null &&
      (lock.identity.pid !== rendezvous.pid ||
        (lock.kind === 'current' &&
          (lock.identity.generationId !== rendezvous.instanceId ||
            !sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, rendezvous.dataRootIdentity) ||
            !sameReadOnlyValidationIdentity(lock.identity.readOnlyValidation, rendezvous.readOnlyValidation))));
    if (metadataConflict) return { ownerPresent: true, certainty: 'unconfirmed', kernelLeaseHeld: false, pid: lock.identity.pid, lock, rendezvous, metadataConflict: true };
    if (processExists(lock.identity.pid)) return { ownerPresent: true, certainty: 'confirmed', kernelLeaseHeld: false, pid: lock.identity.pid, lock, rendezvous, metadataConflict: false };
    return { ownerPresent: true, certainty: 'unconfirmed', kernelLeaseHeld: false, pid: lock.identity.pid, lock, rendezvous, metadataConflict: false };
  }
  if (rendezvous && processExists(rendezvous.pid)) {
    return { ownerPresent: true, certainty: 'confirmed', kernelLeaseHeld: false, pid: rendezvous.pid, lock, rendezvous, metadataConflict: false };
  }
  return { ownerPresent: false, certainty: 'none', kernelLeaseHeld: false, pid: null, lock, rendezvous, metadataConflict: false };
}

function assertExecutionHostIdentities(owner: ExecutionHostOwnerState, expectedDataRootIdentity: ZeusDataRootHostIdentity, expected: ReadOnlyValidationIdentity | undefined): void {
  const observedRoots = [owner.lock.kind === 'current' ? owner.lock.identity.dataRootIdentity : undefined, owner.rendezvous?.dataRootIdentity].filter((identity): identity is ZeusDataRootHostIdentity => identity !== undefined);
  if (observedRoots.some((identity) => !sameZeusDataRootHostIdentity(identity, expectedDataRootIdentity))) {
    throw Object.assign(new Error('Zeus 拒绝附着 distribution/profile 或 rootId 不匹配的既有 Core。'), {
      code: 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH',
      failClosed: true as const,
    });
  }
  const observed = [owner.lock.kind === 'current' ? owner.lock.identity.readOnlyValidation : undefined, owner.rendezvous?.readOnlyValidation].filter((identity): identity is ReadOnlyValidationIdentity => identity !== undefined);
  if (!owner.ownerPresent && observed.length === 0) return;
  if (observed.length === 0 && expected === undefined) return;
  if (observed.length > 0 && observed.every((identity) => sameReadOnlyValidationIdentity(identity, expected))) return;
  throw Object.assign(new Error('Zeus 拒绝附着 read_only_validation 身份不匹配的既有 Core。'), {
    code: 'ZEUS_EXECUTION_HOST_VALIDATION_IDENTITY_MISMATCH',
    failClosed: true as const,
  });
}

async function createExecutionHostOwnershipError(userDataPath: string, owner: ExecutionHostOwnerState, code: 'ZEUS_EXECUTION_HOST_OWNER_METADATA_CONFLICT' | 'ZEUS_EXECUTION_HOST_OWNER_UNCONFIRMED'): Promise<ExecutionHostOwnershipError> {
  const startup = await readExecutionHostStartupStatus(userDataPath);
  const lockIdentity = owner.lock.kind === 'current' ? owner.lock.identity : null;
  const reason =
    owner.lock.kind === 'unconfirmed'
      ? owner.lock.reason === 'unsafe_file'
        ? 'host.lock 不是当前用户的 0600 普通文件'
        : 'host.lock 为空、正在写入或内容无法验证'
      : owner.lock.kind === 'absent'
        ? '仅发现宿主控制面身份'
        : 'host.lock 存在，但无法证明其 owner 已安全退出';
  return new ExecutionHostOwnershipError({
    code,
    message: `Zeus 无法确认旧执行宿主的唯一写入者状态：${reason}。当前版本已进入维护模式，没有删除锁、结束进程或启动第二个 Core。`,
    protocolVersion: lockIdentity?.protocolVersion ?? owner.rendezvous?.protocolVersion ?? null,
    appVersion: lockIdentity?.appVersion ?? owner.rendezvous?.appVersion ?? null,
    pid: owner.pid,
    generationId: lockIdentity?.generationId ?? owner.rendezvous?.instanceId ?? null,
    stage: startup?.stage ?? null,
  });
}

function buildExecutionHostTransition(currentAppVersion: string, hostAppVersion: string, reportedCapabilities?: ExecutionHostCapabilities): RendererLocalServerConfig['executionHostTransition'] {
  return {
    state: currentAppVersion === hostAppVersion ? 'current' : 'draining_previous',
    currentAppVersion,
    hostAppVersion,
    capabilities: resolveExecutionHostCapabilities(hostAppVersion, reportedCapabilities),
  };
}

function assertReportedDataRootIdentity(capabilities: ExecutionHostCapabilities | undefined, expected: ZeusDataRootHostIdentity): void {
  if (!sameZeusDataRootHostIdentity(capabilities?.dataRootIdentity, expected)) {
    throw advertisedHostIdentityError('Execution Host capability/attach 回执的数据根身份不匹配。');
  }
}

function resolveExecutionHostCapabilities(hostAppVersion: string, reported?: ExecutionHostCapabilities): ExecutionHostCapabilities {
  if (reported && Array.isArray(reported.nativeConversationSources) && reported.dataRootIdentity) {
    const supported = new Set(currentExecutionHostCapabilityFeatures.nativeConversationSources);
    return {
      nativeConversationSources: reported.nativeConversationSources.filter((source) => supported.has(source)),
      dataRootIdentity: reported.dataRootIdentity,
      ...(reported.durableHandoff === 'sqlite_journal_v1' ? { durableHandoff: 'sqlite_journal_v1' as const } : {}),
      ...(reported.readOnlyValidation ? { readOnlyValidation: reported.readOnlyValidation } : {}),
    };
  }
  throw Object.assign(new Error(`Zeus ${hostAppVersion} 的 Execution Host 未声明数据根身份能力，拒绝兼容附着。`), {
    code: 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH' as const,
    failClosed: true as const,
  });
}

function cloneRendererLocalServerConfig(config: RendererLocalServerConfig): RendererLocalServerConfig {
  return {
    ...config,
    executionHostTransition: {
      ...config.executionHostTransition,
      capabilities: {
        nativeConversationSources: [...config.executionHostTransition.capabilities.nativeConversationSources],
        dataRootIdentity: { ...config.executionHostTransition.capabilities.dataRootIdentity },
        ...(config.executionHostTransition.capabilities.durableHandoff ? { durableHandoff: config.executionHostTransition.capabilities.durableHandoff } : {}),
        ...(config.executionHostTransition.capabilities.readOnlyValidation ? { readOnlyValidation: { ...config.executionHostTransition.capabilities.readOnlyValidation } } : {}),
      },
    },
    ...(config.readOnlyValidation ? { readOnlyValidation: { ...config.readOnlyValidation } } : {}),
  };
}

function hasEffectfulExecution(work: ExecutionHostWorkStatus): boolean {
  // 旧宿主缺少 effectfulTurnCount 时，active 与 waiting 是全局计数且无法一一对应；相减会让另一会话的
  // waiting 抵消真实 active。兼容边界必须失败关闭：只要旧协议报告任何 active turn，就不自动交接。
  const effectfulNativeTurnCount = work.effectfulTurnCount ?? work.activeTurnCount;
  return effectfulNativeTurnCount > 0 || work.activeRuntimeCount > 0 || work.activeCommandRunCount > 0;
}

async function prepareExecutionHostDurableHandoff(connection: ExecutionHostRendezvous, targetAppVersion: string): Promise<ExecutionHostHandoffPreparation> {
  const prepared = await requestExecutionHostApi<unknown>(connection, '/api/execution-host/handoff/prepare', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ targetAppVersion }),
  });
  if (!isExecutionHostHandoffPreparation(prepared)) {
    throw new Error('Zeus execution-host returned an invalid durable handoff preparation.');
  }
  return prepared;
}

async function requestExecutionHostApi<T>(connection: ExecutionHostRendezvous, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${connection.apiToken}`,
    },
    // 正式库的 durable save / Provider 协调器冻结可能明显超过普通本地 GET 的 8 秒读取上限。
    // 交接接口有 SQLite journal、单飞 promise 与外层 Host 退出上限，允许完整等待一次持久化准备，
    // 避免 Main 先超时而旧 Core 随后独自进入 prepared，留下 Renderer 面向 draining 端口启动。
    signal: AbortSignal.timeout(executionHostHandoffPrepareTimeoutMs),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) {
    const errorPayload = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
    throw Object.assign(new Error(typeof errorPayload.message === 'string' ? errorPayload.message : `Zeus execution-host handoff API failed with HTTP ${response.status}.`), {
      statusCode: response.status,
      ...(typeof errorPayload.error === 'string' ? { code: errorPayload.error } : {}),
      handoffPayload: errorPayload,
    });
  }
  return payload as T;
}

function legacyIdleTaskIntegrationHandoffCandidate(input: { error: unknown; work: ExecutionHostWorkStatus; dbPath: string; hostAppVersion: string }): { fingerprint: string } | null {
  if (input.hostAppVersion !== '0.3.36' && input.hostAppVersion !== '0.3.37') return null;
  if (hasEffectfulExecution(input.work) || input.work.hasActiveWork || input.work.waitingRequestCount > 0 || input.work.activeTurnCount > 0) return null;
  const blockers = readLegacyTaskIntegrationHandoffBlockers(input.error);
  if (!blockers || blockers.taskIntegrationOperations <= 0) return null;
  const attempts = readTaskIntegrationAttemptStateCounts(input.dbPath);
  if (!attempts || attempts.preparing !== 0 || attempts.active < blockers.taskIntegrationOperations) return null;
  return {
    fingerprint: JSON.stringify({
      taskIntegrationOperations: blockers.taskIntegrationOperations,
      activeAttempts: attempts.active,
      latestActiveUpdatedAt: attempts.latestActiveUpdatedAt,
    }),
  };
}

function readLegacyTaskIntegrationHandoffBlockers(error: unknown): { taskIntegrationOperations: number } | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; statusCode?: unknown; handoffPayload?: unknown };
  if (candidate.statusCode !== 409 || candidate.code !== 'ZEUS_EXECUTION_HOST_HANDOFF_WORK_BLOCKED') return null;
  const payload = candidate.handoffPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const message = (payload as Record<string, unknown>).message;
  if (typeof message !== 'string') return null;
  const jsonStart = message.indexOf('{');
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(message.slice(jsonStart)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const business = (parsed as Record<string, unknown>).business;
    const background = (parsed as Record<string, unknown>).background;
    if (!isZeroCountRecord(business) || !background || typeof background !== 'object' || Array.isArray(background)) return null;
    const backgroundCounts = background as Record<string, unknown>;
    const taskIntegrationOperations = backgroundCounts.taskIntegrationOperations;
    if (!Number.isSafeInteger(taskIntegrationOperations) || Number(taskIntegrationOperations) <= 0) return null;
    for (const [key, count] of Object.entries(backgroundCounts)) {
      if (!Number.isSafeInteger(count) || Number(count) < 0) return null;
      if (key !== 'taskIntegrationOperations' && Number(count) !== 0) return null;
    }
    return { taskIntegrationOperations: Number(taskIntegrationOperations) };
  } catch {
    return null;
  }
}

function isZeroCountRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length > 0 && entries.every(([, count]) => Number.isSafeInteger(count) && Number(count) === 0);
}

function readTaskIntegrationAttemptStateCounts(dbPath: string): { preparing: number; active: number; latestActiveUpdatedAt: string | null } | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const table = db.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'task_integration_attempts'`).get();
    if (!table) return null;
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN state = 'preparing' THEN 1 ELSE 0 END) AS preparing,
           SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END) AS active,
           MAX(CASE WHEN state = 'active' THEN updated_at ELSE NULL END) AS latest_active_updated_at
         FROM task_integration_attempts`,
      )
      .get() as { preparing?: unknown; active?: unknown; latest_active_updated_at?: unknown } | undefined;
    if (!row || !Number.isSafeInteger(row.preparing) || !Number.isSafeInteger(row.active)) return null;
    if (row.latest_active_updated_at !== null && typeof row.latest_active_updated_at !== 'string') return null;
    return {
      preparing: Number(row.preparing),
      active: Number(row.active),
      latestActiveUpdatedAt: row.latest_active_updated_at ?? null,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function isRetryableExecutionHostHandoffBlock(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; statusCode?: unknown };
  return candidate.statusCode === 409 && (candidate.code === 'ZEUS_EXECUTION_HOST_HANDOFF_WORK_BLOCKED' || candidate.code === 'ZEUS_EXECUTION_HOST_PI_WAITING_BLOCKED' || candidate.code === 'ZEUS_EXECUTION_HOST_HANDOFF_ALREADY_ACTIVE');
}

function isExecutionHostHandoffPreparation(value: unknown): value is ExecutionHostHandoffPreparation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prepared = value as Record<string, unknown>;
  return (
    typeof prepared.handoffId === 'string' &&
    Boolean(prepared.handoffId.trim()) &&
    typeof prepared.checkpointSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(prepared.checkpointSha256) &&
    Number.isSafeInteger(prepared.requestCount) &&
    Number(prepared.requestCount) >= 0 &&
    typeof prepared.preparedAt === 'string' &&
    Number.isFinite(Date.parse(prepared.preparedAt))
  );
}

async function waitForExecutionHostExit(userDataPath: string, instanceId: string, pid: number, dataRootIdentity: ZeusDataRootHostIdentity): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    // Main 永不清理 lock/rendezvous 路径；旧宿主在仍持有内核租约时清理自己的身份，随后才退出。
    // SIGKILL 等异常路径允许保留诊断残迹，下一任宿主会在取得内核租约后原子替换，避免 check-then-unlink 误删新身份。
    if (!processExists(pid) && inspectExecutionHostKernelLease(userDataPath, dataRootIdentity) === 'available') return;
    await wait(200);
  }
  throw new Error(`Zeus execution-host 未能在 45 秒内完成安全退出（generation=${instanceId}, pid=${pid}）。`);
}

async function readHealthyExecutionHost(userDataPath: string, expectedDataRootIdentity: ZeusDataRootHostIdentity, expectedValidationIdentity?: ReadOnlyValidationIdentity): Promise<ExecutionHostRendezvous | null> {
  const kernelLeaseHeld = inspectExecutionHostKernelLease(userDataPath, expectedDataRootIdentity) === 'held';
  const lock = await readExecutionHostLockObservation(userDataPath);
  const rendezvous = await readExecutionHostRendezvous(userDataPath);
  if (!rendezvous || rendezvous.protocolVersion !== executionHostProtocolVersion) return null;
  if (!sameZeusDataRootHostIdentity(rendezvous.dataRootIdentity, expectedDataRootIdentity)) return null;
  if (!sameReadOnlyValidationIdentity(rendezvous.readOnlyValidation, expectedValidationIdentity)) return null;
  if (kernelLeaseHeld) {
    if (
      lock.kind !== 'current' ||
      lock.identity.ownershipMode !== 'kernel_lease_v1' ||
      rendezvous.ownershipMode !== 'kernel_lease_v1' ||
      lock.identity.generationId !== rendezvous.instanceId ||
      lock.identity.pid !== rendezvous.pid ||
      !sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, rendezvous.dataRootIdentity) ||
      !sameReadOnlyValidationIdentity(lock.identity.readOnlyValidation, rendezvous.readOnlyValidation)
    )
      return null;
  } else {
    // 已发布旧 Host 没有 kernel lease；只有两字段 lock/full transitional lock
    // 与 rendezvous 的 live PID 一致，或 lock 在 closing 窗口已消失时，才允许继续健康校验。
    if (!processExists(rendezvous.pid) || rendezvous.ownershipMode === 'kernel_lease_v1') return null;
    if (lock.kind === 'legacy' && lock.identity.pid !== rendezvous.pid) return null;
    if (
      lock.kind === 'current' &&
      (lock.identity.ownershipMode !== undefined || lock.identity.generationId !== rendezvous.instanceId || lock.identity.pid !== rendezvous.pid || !sameZeusDataRootHostIdentity(lock.identity.dataRootIdentity, rendezvous.dataRootIdentity))
    )
      return null;
    if (lock.kind === 'unconfirmed') return null;
  }
  try {
    const status = await createExecutionHostControlClient(rendezvous).health();
    if (
      status.instanceId !== rendezvous.instanceId ||
      status.pid !== rendezvous.pid ||
      status.protocolVersion !== executionHostProtocolVersion ||
      !sameZeusDataRootHostIdentity(status.capabilities?.dataRootIdentity, expectedDataRootIdentity) ||
      !sameReadOnlyValidationIdentity(status.capabilities?.readOnlyValidation, expectedValidationIdentity)
    )
      return null;
    return rendezvous;
  } catch {
    return null;
  }
}

async function retireDetachedExecutionHost(userDataPath: string, dataRootIdentity: ZeusDataRootHostIdentity): Promise<void> {
  const deadline = Date.now() + 45_000;
  const commandRequest = createExecutionHostStopActiveCommandRequest({ reason: 'embedded_owner_retirement' });
  while (Date.now() < deadline) {
    const existing = await readHealthyExecutionHost(userDataPath, dataRootIdentity);
    if (existing) {
      const client = createExecutionHostControlClient(existing);
      await client.stopActiveWork(commandRequest);
      await client.shutdown();
      await waitForProcessExit(existing.pid, deadline);
      return;
    }

    if (inspectExecutionHostKernelLease(userDataPath, dataRootIdentity) === 'available') return;

    // 旧宿主可能已持有内核租约但仍在迁移数据库；等待其控制面就绪后再安全清退。
    await wait(200);
  }
  throw new Error('Zeus 旧版 execution-host 在 45 秒内仍不可控，为避免两个 SQLite 写入者，已取消本次启动。');
}

async function waitForProcessExit(pid: number, deadline: number): Promise<void> {
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await wait(200);
  }
  throw new Error(`Zeus 旧版 execution-host PID ${pid} 未能在 45 秒内退出。`);
}

function processExists(pid: number | null): boolean {
  if (!pid || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

function collectCleanupError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    errors.push(...error.errors);
    return;
  }
  errors.push(error);
}

function throwCollectedCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
}
