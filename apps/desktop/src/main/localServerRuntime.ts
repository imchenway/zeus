import {spawn} from 'node:child_process';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createCodexRuntimeGenerationManager} from '@zeus/ai-runtime';
import {
    type BrowserAutomationPort,
    createZeusDataLayout,
    hasCodexFinalizationOwnershipClaim,
    type RunningZeusLocalServer,
    startZeusLocalServer,
    type ZeusDataLayout
} from '@zeus/local-server';
import {startDesktopBrowserAutomationBridge} from './browserAutomationBridge.js';
import {
    createExecutionHostControlClient,
    executionHostProtocolVersion,
    type ExecutionHostRendezvous,
    type ExecutionHostWorkStatus,
    readExecutionHostRendezvous,
    writeExecutionHostBootstrap
} from './executionHostProtocol.js';

export interface RendererLocalServerConfig {
  baseUrl: string;
  apiToken: string;
  executionHostTransition: {
    state: 'current' | 'draining_previous';
    currentAppVersion: string;
    hostAppVersion: string;
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

export type DesktopLocalServerCloseMode = 'continue_in_background' | 'upgrade_handoff' | 'final_quit';

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
  let heartbeatCyclePromise: Promise<void> | undefined;
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
    await client.registerBrowserBridge(registration);
    const config: RendererLocalServerConfig = {
      baseUrl: connection.baseUrl,
      apiToken: connection.apiToken,
      executionHostTransition: buildExecutionHostTransition(currentAppVersion, connection.appVersion),
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
      await nextClient.registerBrowserBridge(registration);
      const changed = connectionChanged(next);
      connection = next;
      client = nextClient;
      config.baseUrl = next.baseUrl;
      config.apiToken = next.apiToken;
      config.executionHostTransition = buildExecutionHostTransition(currentAppVersion, next.appVersion);
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
            await client.registerBrowserBridge(registration);
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
      if (handoffPromise) await handoffPromise;
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
        const status = await client.health();
        await handoffPreviousHostIfSafe(status.work);
        if (handoffPromise) return;
        await client.heartbeat(leaseId);
      } catch {
        await recover(false);
      }
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
        let result;
        try {
          result = await client.stopActiveWork();
        } catch {
          await recover(true);
          result = await client.stopActiveWork();
        }
        if (result.failedTurns.length > 0) {
          throw new Error(`Zeus 无法停止 ${result.failedTurns.length} 个执行轮次。`);
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
          const pendingHandoff = handoffPromise;
          if (pendingHandoff) {
            try {
              await pendingHandoff;
            } catch (error) {
              errors.push(error);
            }
          }
          try {
            if (mode === 'final_quit') await client.shutdown();
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

/** 独立执行宿主拥有 Local Server、SQLite 与 Codex app-server；该函数不能由 Renderer 生命周期直接关闭。 */
export async function startOwnedDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
  const apiToken = options.apiToken ?? randomBytes(24).toString('base64url');
  const dataLayout = options.dataLayout ?? createZeusDataLayout(options.userDataPath);
  const dbPath = dataLayout.database;
  const configPath = dataLayout.localConfig;
  const restartDelayMs = 1_000;
  const codexAppServerManager = createCodexRuntimeGenerationManager();
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
    executionHostTransition: buildExecutionHostTransition(options.appVersion?.trim() || '0.0.0', options.appVersion?.trim() || '0.0.0'),
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

function buildExecutionHostTransition(currentAppVersion: string, hostAppVersion: string): RendererLocalServerConfig['executionHostTransition'] {
  return {
    state: currentAppVersion === hostAppVersion ? 'current' : 'draining_previous',
    currentAppVersion,
    hostAppVersion,
  };
}

function cloneRendererLocalServerConfig(config: RendererLocalServerConfig): RendererLocalServerConfig {
  return {
    ...config,
    executionHostTransition: { ...config.executionHostTransition },
  };
}

function hasEffectfulExecution(work: ExecutionHostWorkStatus): boolean {
  // 旧宿主把等待用户的 turn 同时计入 activeTurnCount；相减后才是真正仍在生成或执行副作用的 turn。
  const effectfulNativeTurnCount = work.effectfulTurnCount ?? Math.max(0, work.activeTurnCount - work.waitingRequestCount);
  return effectfulNativeTurnCount > 0 || work.activeRuntimeCount > 0 || work.activeCommandRunCount > 0;
}

async function captureExecutionHostHandoffCheckpoint(connection: ExecutionHostRendezvous): Promise<ExecutionHostHandoffCheckpoint> {
  const dashboard = await requestExecutionHostApi<{
    projects?: Array<{ id?: unknown }>;
    conversationAttentionByProject?: Record<string, unknown>;
  }>(connection, '/api/dashboard');
  const requests = new Map<string, ExecutionHostHandoffCheckpoint['requests'][number]>();
  for (const project of dashboard.projects ?? []) {
    if (typeof project.id !== 'string' || !project.id) continue;
    if (dashboard.conversationAttentionByProject?.[project.id] !== 'reply_required') continue;
    let offset = 0;
    const limit = 200;
    while (true) {
      const page = await requestExecutionHostApi<{ items?: Array<{ id?: unknown }>; total?: unknown }>(connection, `/api/projects/${encodeURIComponent(project.id)}/conversations?limit=${limit}&offset=${offset}`);
      const items = Array.isArray(page.items) ? page.items : [];
      for (const item of items) {
        if (typeof item.id !== 'string' || !item.id) continue;
        const snapshot = await requestExecutionHostApi<{
          requests?: Array<{
            id?: unknown;
            conversationId?: unknown;
            generationId?: unknown;
            type?: unknown;
            status?: unknown;
          }>;
        }>(connection, `/api/projects/${encodeURIComponent(project.id)}/conversations/${encodeURIComponent(item.id)}`);
        for (const candidate of snapshot.requests ?? []) {
          if (candidate.status !== 'pending' || typeof candidate.id !== 'string' || typeof candidate.conversationId !== 'string' || typeof candidate.generationId !== 'string') continue;
          const requestKind = candidate.type === 'userInput' ? 'request_user_input' : candidate.type === 'MCP' ? 'mcp' : candidate.type;
          if (requestKind !== 'command' && requestKind !== 'file' && requestKind !== 'permissions' && requestKind !== 'request_user_input' && requestKind !== 'mcp') continue;
          requests.set(candidate.id, {
            id: candidate.id,
            conversationId: candidate.conversationId,
            transportGenerationId: candidate.generationId,
            requestKind,
          });
        }
      }
      const total = typeof page.total === 'number' ? page.total : items.length;
      offset += items.length;
      if (items.length === 0 || offset >= total) break;
    }
  }
  return {
    sourceInstanceId: connection.instanceId,
    capturedAt: new Date().toISOString(),
    requests: [...requests.values()],
  };
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
  if (!response.ok) throw new Error(`Zeus execution-host handoff API failed with HTTP ${response.status}.`);
  return payload as T;
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
