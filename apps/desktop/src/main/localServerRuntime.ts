import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createCodexRuntimeGenerationManager } from '@zeus/ai-runtime';
import { type BrowserAutomationPort, createZeusDataLayout, hasCodexFinalizationOwnershipClaim, type RunningZeusLocalServer, startZeusLocalServer, type ZeusDataLayout } from '@zeus/local-server';
import { startDesktopBrowserAutomationBridge } from './browserAutomationBridge.js';
import {
  createExecutionHostControlClient,
  currentExecutionHostCapabilities,
  type ExecutionHostCapabilities,
  executionHostLockPath,
  executionHostProtocolVersion,
  type ExecutionHostRendezvous,
  type ExecutionHostWorkStatus,
  readExecutionHostRendezvous,
  removeExecutionHostRendezvous,
  writeExecutionHostBootstrap,
} from './executionHostProtocol.js';

export interface RendererLocalServerConfig {
  baseUrl: string;
  apiToken: string;
  executionHostTransition: {
    state: 'current' | 'draining_previous';
    currentAppVersion: string;
    hostAppVersion: string;
    capabilities: ExecutionHostCapabilities;
  };
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

export type DesktopLocalServerCloseMode = 'continue_in_background' | 'upgrade_handoff' | 'final_quit' | 'force_quit';

interface ExecutionHostHandoffCheckpoint {
  sourceInstanceId: string;
  capturedAt: string;
  requests: Array<{
    id: string;
    conversationId: string;
    transportGenerationId: string;
    requestKind: 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp';
  }>;
}

export interface StartDesktopLocalServerOptions {
  userDataPath: string;
  dataLayout?: ZeusDataLayout;
  projectRoot: string;
  appVersion?: string;
  currentAppVersion?: () => string;
  apiToken?: string;
  telegramToken?: string;
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

export function parseCodexNativeEnabled(value: string | undefined): boolean {
  return value !== '0';
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
 * Electron Main 只连接独立执行宿主。宿主进程使用 Electron 的 Node 模式启动并脱离父进程，
 * 因而窗口重启、Main 退出或 App 原子替换不会直接终止正在执行的轮次。
 */
export async function startDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
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
  let closePromise: Promise<void> | undefined;
  let closing = false;
  try {
    let connection = await connectOrLaunchExecutionHost(options);
    let client = createExecutionHostControlClient(connection);
    const currentAppVersion = options.appVersion?.trim() || '0.0.0';
    const registration = {
      leaseId,
      baseUrl: browserBridge.baseUrl,
      token: browserBridge.token,
      appVersion: options.appVersion?.trim() || '0.0.0',
    };
    let lease = await client.registerBrowserBridge(registration);
    const config: RendererLocalServerConfig = {
      baseUrl: connection.baseUrl,
      apiToken: connection.apiToken,
      executionHostTransition: buildExecutionHostTransition(currentAppVersion, connection.appVersion, lease.capabilities),
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

    const attach = async (next: ExecutionHostRendezvous): Promise<void> => {
      const nextClient = createExecutionHostControlClient(next);
      const nextLease = await nextClient.registerBrowserBridge(registration);
      const changed = connectionChanged(next);
      connection = next;
      client = nextClient;
      lease = nextLease;
      config.baseUrl = next.baseUrl;
      config.apiToken = next.apiToken;
      config.executionHostTransition = buildExecutionHostTransition(currentAppVersion, next.appVersion, nextLease.capabilities);
      executionHost.instanceId = next.instanceId;
      executionHost.pid = next.pid;
      executionHost.protocolVersion = next.protocolVersion;
      if (changed) await options.onRestarted?.(config);
    };

    const handoffPreviousHostIfSafe = async (work: ExecutionHostWorkStatus): Promise<void> => {
      if (connection.appVersion === currentAppVersion || hasEffectfulExecution(work) || handoffPromise) return;

      const previousInstanceId = connection.instanceId;
      const previousClient = client;
      const switching = (async () => {
        const checkpoint = work.waitingRequestCount > 0 ? await captureExecutionHostHandoffCheckpoint(connection) : { sourceInstanceId: connection.instanceId, capturedAt: new Date().toISOString(), requests: [] };
        // 旧宿主没有一次性快照接口时继续安全运行，不能退化为逐会话扫描并拖死 UI 心跳。
        if (!checkpoint) return;
        const confirmed = await previousClient.health();
        // 枚举待回复项后再次确认：若此时出现新的真实执行，本轮交接立即让路，不中断它。
        if (hasEffectfulExecution(confirmed.work) || confirmed.work.waitingRequestCount !== checkpoint.requests.length) return;
        // 可恢复边界无需额外等待；锁和 rendezvous 释放前绝不创建第二个 SQLite 写入者。
        await previousClient.shutdown();
        await waitForExecutionHostExit(options.userDataPath, previousInstanceId);
        const next = await connectOrLaunchExecutionHost(options);
        if (checkpoint.requests.length > 0) await restoreExecutionHostHandoffCheckpoint(next, checkpoint);
        await attach(next);
      })();
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
            config.executionHostTransition = buildExecutionHostTransition(currentAppVersion, connection.appVersion, lease.capabilities);
            return;
          } catch {
            // 当前控制端点已经不可用时，继续通过安全 rendezvous 发现唯一宿主。
          }
        }
        const advertised = await readExecutionHostRendezvous(options.userDataPath);
        if (advertised) {
          try {
            await attach(advertised);
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
      // 交接可能需要等待旧宿主排空；Renderer 配置读取不得因此阻塞。
      if (handoffPromise) return cloneRendererLocalServerConfig(config);
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
        try {
          await client.stopActiveWork();
        } catch {
          await recover(true);
          await client.stopActiveWork();
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
                // 控制面已经不可达时不得按陈旧 PID 强杀；只清理当前实例的陈旧发现文件。
                await removeExecutionHostRendezvous(options.userDataPath, connection.instanceId);
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
                await removeExecutionHostRendezvous(options.userDataPath, connection.instanceId);
              }
            } else if (mode === 'final_quit') await client.shutdown();
            else await client.detach(leaseId);
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
  await retireDetachedExecutionHost(options.userDataPath);
  return startOwnedDesktopLocalServer(options);
}

/** Local Server、SQLite 与 Codex app-server 由当前进程直接持有。 */
export async function startOwnedDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
  const apiToken = options.apiToken ?? randomBytes(24).toString('base64url');
  const dataLayout = options.dataLayout ?? createZeusDataLayout(options.userDataPath);
  const dbPath = dataLayout.database;
  const configPath = dataLayout.localConfig;
  const restartDelayMs = 1_000;
  // 内嵌 Local Server 不再经过独立宿主的 spawn 环境，必须显式固定 Zeus 的 Codex Home。
  const codexAppServerManager = createCodexRuntimeGenerationManager({ codexHome: options.codexHome ?? dataLayout.codexHome });
  let closingIntentionally = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let shutdownOwner: RunningZeusLocalServer | undefined;
  let shutdownOwnerFinalized = false;
  await writeDesktopLocalAppConfig({
    configPath,
    userDataPath: options.userDataPath,
    projectRoot: options.projectRoot,
    dbPath,
  });
  let currentServer: RunningZeusLocalServer;
  try {
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
    executionHostTransition: buildExecutionHostTransition(options.appVersion?.trim() || '0.0.0', options.appVersion?.trim() || '0.0.0', currentExecutionHostCapabilities),
  };

  async function launchServer(): Promise<RunningZeusLocalServer> {
    const server = await startZeusLocalServer({
      dbPath,
      dataLayout,
      localConfigPath: configPath,
      apiToken,
      projectRoot: options.projectRoot,
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
      try {
        await restartedServer.prepareForShutdown();
      } catch (error) {
        errors.push(error);
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
      const response = await fetch(`${config.baseUrl}/api/execution-host/stop-active`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Zeus execution-host stop failed with HTTP ${response.status}.`);
    },
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closingIntentionally = true;
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
          try {
            await finalizationOwner.prepareForShutdown();
          } catch (error) {
            errors.push(error);
          }
          try {
            await finalizationOwner.close();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await codexAppServerManager.prepareForShutdown();
        } catch (error) {
          errors.push(error);
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

async function connectOrLaunchExecutionHost(options: StartDesktopLocalServerOptions): Promise<ExecutionHostRendezvous> {
  const dataLayout = options.dataLayout ?? createZeusDataLayout(options.userDataPath);
  const existing = await readHealthyExecutionHost(options.userDataPath);
  if (existing) return existing;

  const requestedInstanceId = randomUUID();
  const bootstrapPath = await writeExecutionHostBootstrap(options.userDataPath, {
    protocolVersion: executionHostProtocolVersion,
    requestedInstanceId,
    userDataPath: options.userDataPath,
    projectRoot: options.projectRoot,
    codexNativeEnabled: options.codexNativeEnabled ?? true,
    codexLegacyImportRoot: options.codexLegacyImportRoot ?? dataLayout.codexLegacyImports,
    codexHome: options.codexHome ?? dataLayout.codexHome,
    codexConfigImportSourceRoot: options.codexConfigImportSourceRoot ?? join(homedir(), '.codex'),
    releaseUpdateManifestUrl: options.releaseUpdateManifestUrl,
    allowUntrustedReleaseUpdateTest: options.allowUntrustedReleaseUpdateTest,
    taskAttachmentRoot: options.taskAttachmentRoot ?? dataLayout.taskAttachments,
    browserAttachmentRoot: options.browserAttachmentRoot ?? dataLayout.browserComments,
    conversationAttachmentRoot: options.conversationAttachmentRoot ?? dataLayout.conversationAttachments,
    conversationAttachmentGrantSecretPath: options.conversationAttachmentGrantSecretPath!,
    telegramAllowedUserIds: options.telegramAllowedUserIds,
    appVersion: options.appVersion?.trim() || '0.0.0',
    createdAt: new Date().toISOString(),
  });
  const entryPath = join(dirname(fileURLToPath(import.meta.url)), 'executionHost.js');
  const child = spawn(process.execPath, [entryPath], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH: bootstrapPath,
      CODEX_HOME: options.codexHome ?? dataLayout.codexHome,
      ...(options.telegramToken ? { ZEUS_TELEGRAM_BOT_TOKEN: options.telegramToken } : {}),
    },
  });
  child.unref();

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const launched = await readHealthyExecutionHost(options.userDataPath);
    if (launched) return launched;
    await wait(200);
  }
  throw new Error('Zeus execution-host did not become ready within 20 seconds.');
}

function buildExecutionHostTransition(currentAppVersion: string, hostAppVersion: string, reportedCapabilities?: ExecutionHostCapabilities): RendererLocalServerConfig['executionHostTransition'] {
  return {
    state: currentAppVersion === hostAppVersion ? 'current' : 'draining_previous',
    currentAppVersion,
    hostAppVersion,
    capabilities: resolveExecutionHostCapabilities(hostAppVersion, reportedCapabilities),
  };
}

function resolveExecutionHostCapabilities(hostAppVersion: string, reported?: ExecutionHostCapabilities): ExecutionHostCapabilities {
  if (reported && Array.isArray(reported.nativeConversationSources)) {
    const supported = new Set(currentExecutionHostCapabilities.nativeConversationSources);
    return {
      nativeConversationSources: reported.nativeConversationSources.filter((source) => supported.has(source)),
    };
  }

  // 0.2.37 首次完整交付 code_review/conflict_resolution 主链；更旧宿主缺少能力表时继续 fail-closed。
  const legacySources: ExecutionHostCapabilities['nativeConversationSources'] = ['task_push'];
  if (isVersionAtLeast(hostAppVersion, [0, 2, 37])) legacySources.push('code_review', 'conflict_resolution');
  return { nativeConversationSources: legacySources };
}

function isVersionAtLeast(value: string, minimum: readonly [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  if (!match) return false;
  const actual = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

function cloneRendererLocalServerConfig(config: RendererLocalServerConfig): RendererLocalServerConfig {
  return {
    ...config,
    executionHostTransition: {
      ...config.executionHostTransition,
      capabilities: {
        nativeConversationSources: [...config.executionHostTransition.capabilities.nativeConversationSources],
      },
    },
  };
}

function hasEffectfulExecution(work: ExecutionHostWorkStatus): boolean {
  // 旧宿主把等待用户的 turn 同时计入 activeTurnCount；相减后才是真正仍在生成或执行副作用的 turn。
  const effectfulNativeTurnCount = work.effectfulTurnCount ?? Math.max(0, work.activeTurnCount - work.waitingRequestCount);
  return effectfulNativeTurnCount > 0 || work.activeRuntimeCount > 0 || work.activeCommandRunCount > 0;
}

async function captureExecutionHostHandoffCheckpoint(connection: ExecutionHostRendezvous): Promise<ExecutionHostHandoffCheckpoint | null> {
  try {
    const checkpoint = await requestExecutionHostApi<unknown>(connection, '/api/execution-host/handoff-checkpoint');
    if (!isExecutionHostHandoffCheckpoint(checkpoint) || checkpoint.sourceInstanceId !== connection.instanceId) {
      throw new Error('Zeus execution-host returned an invalid handoff checkpoint.');
    }
    return checkpoint;
  } catch (error) {
    if (error instanceof Error && 'statusCode' in error && error.statusCode === 404) return null;
    throw error;
  }
}

async function restoreExecutionHostHandoffCheckpoint(connection: ExecutionHostRendezvous, checkpoint: ExecutionHostHandoffCheckpoint): Promise<void> {
  const result = await requestExecutionHostApi<{ restoredRequestCount?: unknown }>(connection, '/api/execution-host/handoff-checkpoint', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(checkpoint),
  });
  if (result.restoredRequestCount !== checkpoint.requests.length) {
    throw new Error(`Zeus 仅恢复 ${String(result.restoredRequestCount)} / ${checkpoint.requests.length} 个宿主交接待回复项。`);
  }
}

async function requestExecutionHostApi<T>(connection: ExecutionHostRendezvous, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      ...Object.fromEntries(new Headers(init.headers).entries()),
      authorization: `Bearer ${connection.apiToken}`,
    },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) throw Object.assign(new Error(`Zeus execution-host handoff API failed with HTTP ${response.status}.`), { statusCode: response.status });
  return payload as T;
}

function isExecutionHostHandoffCheckpoint(value: unknown): value is ExecutionHostHandoffCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const checkpoint = value as Record<string, unknown>;
  if (typeof checkpoint.sourceInstanceId !== 'string' || !checkpoint.sourceInstanceId || typeof checkpoint.capturedAt !== 'string' || !Number.isFinite(Date.parse(checkpoint.capturedAt)) || !Array.isArray(checkpoint.requests)) return false;
  return checkpoint.requests.every((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const request = candidate as Record<string, unknown>;
    return (
      typeof request.id === 'string' &&
      Boolean(request.id.trim()) &&
      typeof request.conversationId === 'string' &&
      Boolean(request.conversationId.trim()) &&
      typeof request.transportGenerationId === 'string' &&
      Boolean(request.transportGenerationId.trim()) &&
      ['command', 'file', 'permissions', 'request_user_input', 'mcp'].includes(String(request.requestKind))
    );
  });
}

async function waitForExecutionHostExit(userDataPath: string, instanceId: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const advertised = await readExecutionHostRendezvous(userDataPath);
    if (!advertised || advertised.instanceId !== instanceId) return;
    try {
      await createExecutionHostControlClient(advertised).health();
    } catch {
      return;
    }
    await wait(200);
  }
  throw new Error('Zeus 旧版 execution-host 未能在 45 秒内完成安全交接。');
}

async function readHealthyExecutionHost(userDataPath: string): Promise<ExecutionHostRendezvous | null> {
  const rendezvous = await readExecutionHostRendezvous(userDataPath);
  if (!rendezvous || rendezvous.protocolVersion !== executionHostProtocolVersion) return null;
  try {
    const status = await createExecutionHostControlClient(rendezvous).health();
    if (status.instanceId !== rendezvous.instanceId || status.pid !== rendezvous.pid || status.protocolVersion !== executionHostProtocolVersion) return null;
    return rendezvous;
  } catch {
    return null;
  }
}

async function retireDetachedExecutionHost(userDataPath: string): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const existing = await readHealthyExecutionHost(userDataPath);
    if (existing) {
      const client = createExecutionHostControlClient(existing);
      await client.stopActiveWork();
      await client.shutdown();
      await waitForProcessExit(existing.pid, deadline);
      await removeExecutionHostRendezvous(userDataPath, existing.instanceId);
      return;
    }

    const advertised = await readExecutionHostRendezvous(userDataPath);
    const lockOwnerPid = await readExecutionHostLockOwnerPid(userDataPath);
    const advertisedPid = advertised?.pid ?? null;
    if (!processExists(lockOwnerPid) && !processExists(advertisedPid)) {
      if (advertised) await removeExecutionHostRendezvous(userDataPath, advertised.instanceId);
      return;
    }

    // 旧宿主可能已持有单实例锁但仍在迁移数据库；等待其控制面就绪后再安全清退。
    await wait(200);
  }
  throw new Error('Zeus 旧版 execution-host 在 45 秒内仍不可控，为避免两个 SQLite 写入者，已取消本次启动。');
}

async function readExecutionHostLockOwnerPid(userDataPath: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(executionHostLockPath(userDataPath), 'utf8')) as { pid?: unknown };
    return typeof value.pid === 'number' && Number.isInteger(value.pid) && value.pid > 0 ? value.pid : null;
  } catch {
    return null;
  }
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

export interface BeforeQuitCleanupEvent {
  preventDefault: () => void;
}

export interface BeforeQuitCleanupResources {
  closeSystemNotifications?: () => void;
  resolveQuitMode?: () => Promise<DesktopLocalServerCloseMode | 'cancel'>;
  closeLocalServer?: (mode: DesktopLocalServerCloseMode) => Promise<void>;
  shouldDeferQuit?: () => boolean;
  requestQuitConfirmation?: () => void;
  exitApp: (code: number) => void;
}

/**
 * Electron 的 before-quit 不会等待 async listener；这里先同步拦截退出，
 * 等系统通知桥和本地服务都关闭后再显式退出，避免残留本机进程或旧 WebSocket。
 */
export function createBeforeQuitCleanupHandler(resources: BeforeQuitCleanupResources): (event: BeforeQuitCleanupEvent) => void {
  let cleanupStarted = false;
  return (event) => {
    event.preventDefault();
    if (cleanupStarted) return;
    if (resources.shouldDeferQuit?.()) {
      resources.requestQuitConfirmation?.();
      return;
    }
    cleanupStarted = true;
    void (async () => {
      try {
        const quitMode = (await resources.resolveQuitMode?.()) ?? 'final_quit';
        if (quitMode === 'cancel') {
          cleanupStarted = false;
          return;
        }
        resources.closeSystemNotifications?.();
        await resources.closeLocalServer?.(quitMode);
      } finally {
        if (cleanupStarted) resources.exitApp(0);
      }
    })();
  };
}
