import { createHash, randomBytes } from 'node:crypto';
import { appendFile, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { readOnlyValidationIdentity, type ExecutionHostStopActiveCommandRequest } from '@zeus/shared';
import { createReconnectableBrowserAutomationProxy } from './browserAutomationBridge.js';
import {
  acquireExecutionHostKernelLease,
  executionHostCapabilitiesFor,
  type ExecutionHostBrowserBridgeRegistration,
  type ExecutionHostControlStatus,
  executionHostBootstrapDataLayout,
  type ExecutionHostLeaseStatus,
  type ExecutionHostKernelLease,
  type ExecutionHostLockIdentity,
  executionHostProtocolVersion,
  type ExecutionHostStartupStage,
  type ExecutionHostRendezvous,
  type ExecutionHostWorkStatus,
  readExecutionHostBootstrap,
  removeExecutionHostLockIdentity,
  removeExecutionHostRendezvous,
  removeExecutionHostStartupStatus,
  writeExecutionHostLockIdentity,
  writeExecutionHostRendezvous,
  writeExecutionHostStartupStatus,
} from './executionHostProtocol.js';
import { type DesktopLocalServerRuntime, startOwnedDesktopLocalServer, verifyReadOnlyValidationBeforeOwnedCoreLock } from './localServerRuntime.js';
import { closeExecutionHostResources } from './executionHostClosePlan.js';
import { isZeusDataRootHostIdentity, sameZeusDataRootHostIdentity, type ZeusDataRootHostIdentity } from './dataRootIdentity.js';

const uiLeaseTimeoutMs = 15_000;
const detachedIdleShutdownMs = 30_000;
const monitorIntervalMs = 5_000;
const maximumControlBodyBytes = 64 * 1024;

let startupFailureContext:
  | {
      userDataPath: string;
      generationId: string;
      appVersion: string;
      startedAt: string;
      readOnlyValidation?: ReturnType<typeof readOnlyValidationIdentity>;
      dataRootIdentity: ZeusDataRootHostIdentity;
    }
  | undefined;
let startupKernelLease:
  | {
      userDataPath: string;
      generationId: string;
      lease: ExecutionHostKernelLease;
      dataRootIdentity: ZeusDataRootHostIdentity;
    }
  | undefined;
let startupFailureLogDirectory: string | undefined;

interface UiLeaseState {
  leaseId: string;
  lastHeartbeatAt: string;
  appVersion: string;
}

async function runExecutionHost(): Promise<void> {
  const bootstrapPath = process.env.ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH?.trim();
  if (!bootstrapPath) throw new Error('ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH is required.');
  const bootstrap = await readExecutionHostBootstrap(bootstrapPath);
  const dataLayout = executionHostBootstrapDataLayout(bootstrap);
  if (bootstrap.readOnlyValidation) await verifyReadOnlyValidationBeforeOwnedCoreLock(bootstrap.readOnlyValidation);
  // 只有 bootstrap 路径、descriptor 与全部 validationRoot 规范身份验证后，失败路径才允许写入该宿主目录。
  startupFailureLogDirectory = dataLayout.executionHost;
  await unlink(bootstrapPath).catch(() => undefined);
  if (bootstrap.protocolVersion !== executionHostProtocolVersion) throw new Error('Zeus execution-host bootstrap protocol is incompatible.');

  const instanceId = bootstrap.requestedInstanceId;
  const startedAt = new Date().toISOString();
  const validationIdentity = bootstrap.readOnlyValidation ? readOnlyValidationIdentity(bootstrap.readOnlyValidation) : undefined;
  const hostCapabilities = executionHostCapabilitiesFor(bootstrap.dataRootIdentity, bootstrap.readOnlyValidation);
  const lock = await acquireExecutionHostLock(bootstrap.userDataPath, {
    protocolVersion: executionHostProtocolVersion,
    generationId: instanceId,
    pid: process.pid,
    appVersion: bootstrap.appVersion,
    createdAt: startedAt,
    ownershipMode: 'kernel_lease_v1',
    dataRootIdentity: bootstrap.dataRootIdentity,
    readOnlyValidation: validationIdentity,
  });
  startupKernelLease = { userDataPath: bootstrap.userDataPath, generationId: instanceId, lease: lock, dataRootIdentity: bootstrap.dataRootIdentity };
  startupFailureContext = {
    userDataPath: bootstrap.userDataPath,
    generationId: instanceId,
    appVersion: bootstrap.appVersion,
    startedAt,
    dataRootIdentity: bootstrap.dataRootIdentity,
    readOnlyValidation: validationIdentity,
  };
  const updateStartupStage = async (stage: ExecutionHostStartupStage): Promise<void> => {
    await writeExecutionHostStartupStatus(bootstrap.userDataPath, {
      protocolVersion: executionHostProtocolVersion,
      generationId: instanceId,
      pid: process.pid,
      appVersion: bootstrap.appVersion,
      stage,
      startedAt,
      updatedAt: new Date().toISOString(),
      dataRootIdentity: bootstrap.dataRootIdentity,
      readOnlyValidation: validationIdentity,
    });
  };
  await updateStartupStage('lock_acquired');
  const logPath = join(dataLayout.executionHost, 'host.log');
  const apiToken = randomBytes(32).toString('base64url');
  const controlToken = randomBytes(32).toString('base64url');
  const browserAutomation = createReconnectableBrowserAutomationProxy();
  let currentUiAppVersion = bootstrap.appVersion;
  let rendezvous: ExecutionHostRendezvous | undefined;
  let uiLease: UiLeaseState | null = null;
  let detachedIdleSince: number | null = null;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined = undefined;

  const record = async (event: string, detail: Record<string, unknown> = {}) => {
    await appendFile(logPath, `${JSON.stringify({ timestamp: new Date().toISOString(), event, instanceId, pid: process.pid, ...detail })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    }).catch(() => undefined);
  };

  async function readWorkStatus(): Promise<ExecutionHostWorkStatus> {
    if (!runtime) throw new Error('Zeus execution-host runtime is not ready.');
    const response = await fetch(`${runtime.config.baseUrl}/api/execution-host/status`, {
      headers: { authorization: `Bearer ${runtime.config.apiToken}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`Zeus execution-host work status failed with HTTP ${response.status}.`);
    return (await response.json()) as ExecutionHostWorkStatus;
  }

  async function controlStatus(): Promise<ExecutionHostControlStatus> {
    return {
      protocolVersion: executionHostProtocolVersion,
      instanceId,
      pid: process.pid,
      appVersion: bootstrap.appVersion,
      startedAt,
      capabilities: hostCapabilities,
      uiLease: {
        connected: uiLease !== null,
        leaseId: uiLease?.leaseId ?? null,
        lastHeartbeatAt: uiLease?.lastHeartbeatAt ?? null,
        appVersion: uiLease?.appVersion ?? null,
      },
      work: await readWorkStatus(),
    };
  }

  function leaseStatus(): ExecutionHostLeaseStatus {
    return {
      protocolVersion: executionHostProtocolVersion,
      instanceId,
      connected: uiLease !== null,
      leaseId: uiLease?.leaseId ?? null,
      lastHeartbeatAt: uiLease?.lastHeartbeatAt ?? null,
      capabilities: hostCapabilities,
    };
  }

  async function closeHost(reason: string, mode: 'upgrade_handoff' | 'final_quit' = 'final_quit'): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      if (monitor) clearInterval(monitor);
      await closeExecutionHostResources({
        recordClosing: () => record('execution_host.closing', { reason }),
        closeRuntime: () => runtime.close(mode),
        closeControlServer: () => closeHttpServer(controlServer),
        removeRendezvous: () => removeExecutionHostRendezvous(bootstrap.userDataPath, instanceId, bootstrap.dataRootIdentity),
        removeStartupStatus: () => removeExecutionHostStartupStatus(bootstrap.userDataPath, instanceId, bootstrap.dataRootIdentity),
        removeLockIdentity: () => removeExecutionHostLockIdentity(bootstrap.userDataPath, instanceId, bootstrap.dataRootIdentity),
        // 发现身份在内核租约仍被持有时清理；租约最后释放，下一任宿主才可能发布新身份。
        releaseKernelLease: () => {
          lock.close();
          startupKernelLease = undefined;
        },
        recordClosed: () => record('execution_host.closed', { reason }),
      });
    })();
    return closePromise;
  }

  const conversationAttachmentGrantSecret = bootstrap.readOnlyValidation
    ? createHash('sha256').update(`zeus-read-only-validation-grant:${bootstrap.readOnlyValidation.runId}:${bootstrap.readOnlyValidation.manifestHash}`).digest('base64url')
    : (await readFile(bootstrap.conversationAttachmentGrantSecretPath, 'utf8')).trim();
  const runtime: DesktopLocalServerRuntime = await startOwnedDesktopLocalServer({
    userDataPath: bootstrap.userDataPath,
    projectRoot: bootstrap.projectRoot,
    keychainService: bootstrap.keychainService,
    dataRootIdentity: bootstrap.dataRootIdentity,
    currentAppVersion: () => currentUiAppVersion,
    apiToken,
    telegramToken: bootstrap.readOnlyValidation ? undefined : process.env.ZEUS_TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: bootstrap.readOnlyValidation ? undefined : bootstrap.telegramAllowedUserIds,
    codexNativeEnabled: bootstrap.readOnlyValidation ? false : bootstrap.codexNativeEnabled,
    codexLegacyImportRoot: bootstrap.readOnlyValidation ? undefined : bootstrap.codexLegacyImportRoot,
    codexHome: bootstrap.readOnlyValidation ? undefined : bootstrap.codexHome,
    codexConfigImportSourceRoot: bootstrap.readOnlyValidation ? undefined : bootstrap.codexConfigImportSourceRoot,
    releaseUpdateManifestUrl: bootstrap.readOnlyValidation ? undefined : bootstrap.releaseUpdateManifestUrl,
    allowUntrustedReleaseUpdateTest: bootstrap.readOnlyValidation ? false : bootstrap.allowUntrustedReleaseUpdateTest,
    taskAttachmentRoot: bootstrap.taskAttachmentRoot,
    browserAttachmentRoot: bootstrap.browserAttachmentRoot,
    conversationAttachmentRoot: bootstrap.conversationAttachmentRoot,
    conversationAttachmentGrantSecret,
    conversationAttachmentGrantSecretPath: bootstrap.conversationAttachmentGrantSecretPath,
    dataLayout,
    browserAutomation,
    executionHost: {
      instanceId,
      protocolVersion: executionHostProtocolVersion,
      startedAt,
      mode: 'detached',
    },
    readOnlyValidation: bootstrap.readOnlyValidation,
    onStartupStage: updateStartupStage,
    onRestarted: async (config) => {
      if (!rendezvous) return;
      rendezvous = { ...rendezvous, baseUrl: config.baseUrl, updatedAt: new Date().toISOString() };
      await writeExecutionHostRendezvous(bootstrap.userDataPath, rendezvous);
      await record('execution_host.local_server_restarted', { baseUrl: config.baseUrl });
    },
  });
  await updateStartupStage('local_server_ready');

  const controlServer = createServer((request, response) => {
    void handleControlRequest(request, response, {
      token: controlToken,
      status: controlStatus,
      registerBrowserBridge: async (registration) => {
        if (!sameZeusDataRootHostIdentity(registration.dataRootIdentity, bootstrap.dataRootIdentity)) {
          throw Object.assign(new Error('Zeus Browser bridge 的数据根 profile/identity 与 Execution Host 不一致。'), { statusCode: 409 });
        }
        assertLoopbackUrl(registration.baseUrl);
        currentUiAppVersion = registration.appVersion;
        uiLease = { leaseId: registration.leaseId, lastHeartbeatAt: new Date().toISOString(), appVersion: registration.appVersion };
        detachedIdleSince = null;
        browserAutomation.register(registration);
        await record('execution_host.ui_attached', { leaseId: registration.leaseId });
        return leaseStatus();
      },
      heartbeat: async (leaseId) => {
        if (!uiLease || uiLease.leaseId !== leaseId) throw Object.assign(new Error('Zeus 界面租约已经失效。'), { statusCode: 409 });
        uiLease = { ...uiLease, lastHeartbeatAt: new Date().toISOString() };
        return leaseStatus();
      },
      detach: async (leaseId) => {
        if (uiLease?.leaseId === leaseId) {
          uiLease = null;
          detachedIdleSince = Date.now();
          browserAutomation.register(null);
          await record('execution_host.ui_detached', { leaseId });
        }
        return controlStatus();
      },
      stopActiveWork: async (input) => {
        if (!runtime) throw new Error('Zeus execution-host runtime is not ready.');
        const response = await fetch(`${runtime.config.baseUrl}/api/execution-host/stop-active`, {
          method: 'POST',
          headers: { authorization: `Bearer ${runtime.config.apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(15_000),
        });
        const payload = (await response.json().catch(() => ({}))) as unknown;
        if (!response.ok) throw new Error(`Zeus execution-host stop failed with HTTP ${response.status}.`);
        await record('execution_host.stop_requested', {
          commandId: input.command.commandId,
          operationIdentity: input.command.payload.operationIdentity,
        });
        return payload;
      },
      shutdown: async () => {
        setImmediate(() => {
          void closeHost('final_quit')
            .then(() => process.exit(0))
            .catch(async (error: unknown) => {
              await record('execution_host.close_failed', { reason: 'final_quit', message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
              process.exit(1);
            });
        });
      },
      handoff: async (input) => {
        if (!runtime) throw new Error('Zeus execution-host runtime is not ready.');
        const verificationUrl = new URL(`/api/execution-host/handoff/${encodeURIComponent(input.handoffId)}/prepared`, runtime.config.baseUrl);
        verificationUrl.searchParams.set('checkpointSha256', input.checkpointSha256);
        const verification = await fetch(verificationUrl, {
          headers: { authorization: `Bearer ${runtime.config.apiToken}` },
          signal: AbortSignal.timeout(5_000),
        });
        if (!verification.ok) throw Object.assign(new Error('Execution Host 持久化交接账本尚未 prepared 或 hash 不匹配。'), { statusCode: 409 });
        await record('execution_host.handoff_accepted', { handoffId: input.handoffId, checkpointSha256: input.checkpointSha256 });
        setImmediate(() => {
          void closeHost('upgrade_handoff', 'upgrade_handoff')
            .then(() => process.exit(0))
            .catch(async (error: unknown) => {
              await record('execution_host.close_failed', { reason: 'upgrade_handoff', message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
              process.exit(1);
            });
        });
      },
    });
  });
  await listenOnLoopback(controlServer);
  const controlAddress = controlServer.address() as AddressInfo;
  rendezvous = {
    protocolVersion: executionHostProtocolVersion,
    instanceId,
    pid: process.pid,
    appVersion: bootstrap.appVersion,
    baseUrl: runtime.config.baseUrl,
    apiToken,
    controlUrl: `http://127.0.0.1:${controlAddress.port}`,
    controlToken,
    dbPath: runtime.dbPath,
    projectRoot: bootstrap.projectRoot,
    dataRootIdentity: bootstrap.dataRootIdentity,
    readOnlyValidation: validationIdentity,
    startedAt,
    updatedAt: new Date().toISOString(),
    ownershipMode: 'kernel_lease_v1',
  };
  await writeExecutionHostRendezvous(bootstrap.userDataPath, rendezvous);
  await updateStartupStage('control_ready');
  startupFailureContext = undefined;
  await record('execution_host.ready', { baseUrl: rendezvous.baseUrl, controlUrl: rendezvous.controlUrl, appVersion: bootstrap.appVersion });

  monitor = setInterval(() => {
    void (async () => {
      if (closing) return;
      if (uiLease && Date.now() - Date.parse(uiLease.lastHeartbeatAt) > uiLeaseTimeoutMs) {
        await record('execution_host.ui_lease_expired', { leaseId: uiLease.leaseId });
        uiLease = null;
        detachedIdleSince = null;
        browserAutomation.register(null);
      }
      if (uiLease) return;
      const work = await readWorkStatus();
      if (work.hasActiveWork) {
        detachedIdleSince = null;
        return;
      }
      detachedIdleSince ??= Date.now();
      if (Date.now() - detachedIdleSince < detachedIdleShutdownMs) return;
      try {
        await closeHost('detached_idle');
        process.exit(0);
      } catch (error) {
        await record('execution_host.close_failed', { reason: 'detached_idle', message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        // close 失败后不能让 closing=true 的宿主永久占有 writer lease；进程退出由 OS 最终释放未能收口的 fd/租约。
        process.exit(1);
      }
    })().catch((error: unknown) => {
      void record('execution_host.monitor_failed', { message: error instanceof Error ? error.message : String(error) });
    });
  }, monitorIntervalMs);
  monitor.unref();

  const handleSignal = (signal: NodeJS.Signals) => {
    void closeHost(signal)
      .then(() => process.exit(0))
      .catch(async (error: unknown) => {
        await record('execution_host.close_failed', { reason: signal, message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
        process.exit(1);
      });
  };
  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);
  process.on('SIGHUP', () => {
    // UI、终端或安装器会话挂断不代表用户要求停止长任务；宿主只记录该信号并继续按工作租约运行。
    void record('execution_host.sighup_ignored');
  });
}

interface ControlRequestServices {
  token: string;
  status(): Promise<ExecutionHostControlStatus>;
  registerBrowserBridge(input: ExecutionHostBrowserBridgeRegistration): Promise<ExecutionHostLeaseStatus>;
  heartbeat(leaseId: string): Promise<ExecutionHostLeaseStatus>;
  detach(leaseId: string): Promise<ExecutionHostControlStatus>;
  stopActiveWork(input: ExecutionHostStopActiveCommandRequest): Promise<unknown>;
  shutdown(): Promise<void>;
  handoff(input: { handoffId: string; checkpointSha256: string }): Promise<void>;
}

async function handleControlRequest(request: IncomingMessage, response: ServerResponse, services: ControlRequestServices): Promise<void> {
  if (request.headers.authorization !== `Bearer ${services.token}`) {
    sendJson(response, 401, { error: 'ZEUS_EXECUTION_HOST_UNAUTHORIZED', message: '执行宿主控制凭据无效。' });
    return;
  }
  try {
    if (request.method === 'GET' && request.url === '/health') {
      sendJson(response, 200, await services.status());
      return;
    }
    if (request.method === 'POST' && request.url === '/ui/browser-bridge') {
      const body = await readJsonBody(request);
      if (!isBrowserBridgeRegistration(body)) throw Object.assign(new Error('浏览器自动化租约格式无效。'), { statusCode: 400 });
      sendJson(response, 200, await services.registerBrowserBridge(body));
      return;
    }
    if (request.method === 'POST' && request.url === '/ui/heartbeat') {
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.leaseId !== 'string') throw Object.assign(new Error('界面租约心跳格式无效。'), { statusCode: 400 });
      sendJson(response, 200, await services.heartbeat(body.leaseId));
      return;
    }
    if (request.method === 'POST' && request.url === '/ui/detach') {
      const body = await readJsonBody(request);
      if (!isRecord(body) || typeof body.leaseId !== 'string') throw Object.assign(new Error('界面租约退出格式无效。'), { statusCode: 400 });
      sendJson(response, 200, await services.detach(body.leaseId));
      return;
    }
    if (request.method === 'POST' && request.url === '/work/stop') {
      const body = await readJsonBody(request);
      sendJson(response, 200, await services.stopActiveWork(body as ExecutionHostStopActiveCommandRequest));
      return;
    }
    if (request.method === 'POST' && request.url === '/shutdown') {
      sendJson(response, 202, { accepted: true });
      await services.shutdown();
      return;
    }
    if (request.method === 'POST' && request.url === '/handoff') {
      const body = await readJsonBody(request);
      if (!isHandoffControlRequest(body)) throw Object.assign(new Error('Execution Host 交接控制格式无效。'), { statusCode: 400 });
      await services.handoff(body);
      sendJson(response, 202, { accepted: true });
      return;
    }
    sendJson(response, 404, { error: 'ZEUS_EXECUTION_HOST_CONTROL_NOT_FOUND', message: '执行宿主控制路径不存在。' });
  } catch (error) {
    const statusCode = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 500;
    sendJson(response, statusCode, {
      error: 'ZEUS_EXECUTION_HOST_CONTROL_FAILED',
      message: error instanceof Error ? error.message : '执行宿主控制请求失败。',
    });
  }
}

async function acquireExecutionHostLock(userDataPath: string, identity: ExecutionHostLockIdentity) {
  const lease = acquireExecutionHostKernelLease(userDataPath, identity.dataRootIdentity);
  try {
    await writeExecutionHostLockIdentity(userDataPath, identity, lease);
    return lease;
  } catch (error) {
    lease.close();
    throw error;
  }
}

function isBrowserBridgeRegistration(value: unknown): value is ExecutionHostBrowserBridgeRegistration {
  return isRecord(value) && isNonEmptyString(value.leaseId) && isNonEmptyString(value.baseUrl) && isNonEmptyString(value.token) && isNonEmptyString(value.appVersion) && isZeusDataRootHostIdentity(value.dataRootIdentity);
}

function isHandoffControlRequest(value: unknown): value is { handoffId: string; checkpointSha256: string } {
  return isRecord(value) && isNonEmptyString(value.handoffId) && /^[a-f0-9]{64}$/u.test(typeof value.checkpointSha256 === 'string' ? value.checkpointSha256 : '');
}

function assertLoopbackUrl(value: string): void {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password) {
    throw Object.assign(new Error('浏览器自动化桥只能监听本机回环地址。'), { statusCode: 400 });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximumControlBodyBytes) throw Object.assign(new Error('执行宿主控制请求超过允许大小。'), { statusCode: 413 });
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeHttpServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

void runExecutionHost().catch(async (error: unknown) => {
  if (startupFailureContext) {
    await writeExecutionHostStartupStatus(startupFailureContext.userDataPath, {
      protocolVersion: executionHostProtocolVersion,
      generationId: startupFailureContext.generationId,
      pid: process.pid,
      appVersion: startupFailureContext.appVersion,
      stage: 'failed',
      startedAt: startupFailureContext.startedAt,
      updatedAt: new Date().toISOString(),
      dataRootIdentity: startupFailureContext.dataRootIdentity,
      readOnlyValidation: startupFailureContext.readOnlyValidation,
    }).catch(() => undefined);
  }
  if (startupKernelLease) {
    await removeExecutionHostLockIdentity(startupKernelLease.userDataPath, startupKernelLease.generationId, startupKernelLease.dataRootIdentity).catch(() => undefined);
    startupKernelLease.lease.close();
    startupKernelLease = undefined;
  }
  if (startupFailureLogDirectory) {
    await writeFile(join(startupFailureLogDirectory, 'host-startup-error.log'), `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    }).catch(() => undefined);
  }
  process.exitCode = 1;
});
