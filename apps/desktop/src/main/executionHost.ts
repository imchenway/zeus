import { randomBytes } from 'node:crypto';
import { appendFile, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { createReconnectableBrowserAutomationProxy } from './browserAutomationBridge.js';
import {
  type ExecutionHostBrowserBridgeRegistration,
  type ExecutionHostControlStatus,
  type ExecutionHostLeaseStatus,
  executionHostLockPath,
  executionHostProtocolVersion,
  type ExecutionHostRendezvous,
  type ExecutionHostWorkStatus,
  readExecutionHostBootstrap,
  removeExecutionHostRendezvous,
  writeExecutionHostRendezvous,
} from './executionHostProtocol.js';
import { type DesktopLocalServerRuntime, startOwnedDesktopLocalServer } from './localServerRuntime.js';

const uiLeaseTimeoutMs = 15_000;
const detachedIdleShutdownMs = 30_000;
const monitorIntervalMs = 5_000;
const maximumControlBodyBytes = 64 * 1024;

interface UiLeaseState {
  leaseId: string;
  lastHeartbeatAt: string;
  appVersion: string;
}

async function runExecutionHost(): Promise<void> {
  const bootstrapPath = process.env.ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH?.trim();
  if (!bootstrapPath) throw new Error('ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH is required.');
  const bootstrap = await readExecutionHostBootstrap(bootstrapPath);
  await unlink(bootstrapPath).catch(() => undefined);
  if (bootstrap.protocolVersion !== executionHostProtocolVersion) throw new Error('Zeus execution-host bootstrap protocol is incompatible.');

  const lockPath = executionHostLockPath(bootstrap.userDataPath);
  const lock = await acquireExecutionHostLock(lockPath);
  const logPath = join(bootstrap.userDataPath, 'execution-host', 'host.log');
  const instanceId = bootstrap.requestedInstanceId;
  const startedAt = new Date().toISOString();
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
    };
  }

  async function closeHost(reason: string): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      await record('execution_host.closing', { reason });
      if (monitor) clearInterval(monitor);
      await closeHttpServer(controlServer).catch(() => undefined);
      await runtime?.close('final_quit');
      await removeExecutionHostRendezvous(bootstrap.userDataPath, instanceId);
      await lock.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
      await record('execution_host.closed', { reason });
    })();
    return closePromise;
  }

  const conversationAttachmentGrantSecret = (await readFile(bootstrap.conversationAttachmentGrantSecretPath, 'utf8')).trim();
  const runtime: DesktopLocalServerRuntime = await startOwnedDesktopLocalServer({
    userDataPath: bootstrap.userDataPath,
    projectRoot: bootstrap.projectRoot,
    currentAppVersion: () => currentUiAppVersion,
    apiToken,
    telegramToken: process.env.ZEUS_TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: bootstrap.telegramAllowedUserIds,
    codexNativeEnabled: bootstrap.codexNativeEnabled,
    codexLegacyImportRoot: bootstrap.codexLegacyImportRoot,
    codexHome: bootstrap.codexHome,
    codexConfigImportSourceRoot: bootstrap.codexConfigImportSourceRoot,
    releaseUpdateManifestUrl: bootstrap.releaseUpdateManifestUrl,
    allowUntrustedReleaseUpdateTest: bootstrap.allowUntrustedReleaseUpdateTest,
    taskAttachmentRoot: bootstrap.taskAttachmentRoot,
    browserAttachmentRoot: bootstrap.browserAttachmentRoot,
    conversationAttachmentRoot: bootstrap.conversationAttachmentRoot,
    conversationAttachmentGrantSecret,
    browserAutomation,
    executionHost: {
      instanceId,
      protocolVersion: executionHostProtocolVersion,
      startedAt,
      mode: 'detached',
    },
    onRestarted: async (config) => {
      if (!rendezvous) return;
      rendezvous = { ...rendezvous, baseUrl: config.baseUrl, updatedAt: new Date().toISOString() };
      await writeExecutionHostRendezvous(bootstrap.userDataPath, rendezvous);
      await record('execution_host.local_server_restarted', { baseUrl: config.baseUrl });
    },
  });

  const controlServer = createServer((request, response) => {
    void handleControlRequest(request, response, {
      token: controlToken,
      status: controlStatus,
      registerBrowserBridge: async (registration) => {
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
      stopActiveWork: async () => {
        if (!runtime) throw new Error('Zeus execution-host runtime is not ready.');
        const response = await fetch(`${runtime.config.baseUrl}/api/execution-host/stop-active`, {
          method: 'POST',
          headers: { authorization: `Bearer ${runtime.config.apiToken}` },
          signal: AbortSignal.timeout(15_000),
        });
        const payload = (await response.json().catch(() => ({}))) as unknown;
        if (!response.ok) throw new Error(`Zeus execution-host stop failed with HTTP ${response.status}.`);
        await record('execution_host.stop_requested');
        return payload;
      },
      shutdown: async () => {
        setImmediate(() => {
          void closeHost('final_quit').finally(() => process.exit(0));
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
    startedAt,
    updatedAt: new Date().toISOString(),
  };
  await writeExecutionHostRendezvous(bootstrap.userDataPath, rendezvous);
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
      await closeHost('detached_idle');
      process.exit(0);
    })().catch((error: unknown) => {
      void record('execution_host.monitor_failed', { message: error instanceof Error ? error.message : String(error) });
    });
  }, monitorIntervalMs);
  monitor.unref();

  const handleSignal = (signal: NodeJS.Signals) => {
    void closeHost(signal).finally(() => process.exit(0));
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
  stopActiveWork(): Promise<unknown>;
  shutdown(): Promise<void>;
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
      sendJson(response, 200, await services.stopActiveWork());
      return;
    }
    if (request.method === 'POST' && request.url === '/shutdown') {
      sendJson(response, 202, { accepted: true });
      await services.shutdown();
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

async function acquireExecutionHostLock(path: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, 'utf8');
      return handle;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST') || attempt > 0) throw error;
      const existing = await readLockPid(path);
      if (existing && processExists(existing)) throw new Error(`Zeus execution-host is already running with PID ${existing}.`);
      await unlink(path).catch((unlinkError: unknown) => {
        if (!isNodeError(unlinkError, 'ENOENT')) throw unlinkError;
      });
    }
  }
  throw new Error('Zeus execution-host lock could not be acquired.');
}

async function readLockPid(path: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
    return isRecord(value) && Number.isInteger(value.pid) ? Number(value.pid) : null;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isBrowserBridgeRegistration(value: unknown): value is ExecutionHostBrowserBridgeRegistration {
  return isRecord(value) && isNonEmptyString(value.leaseId) && isNonEmptyString(value.baseUrl) && isNonEmptyString(value.token) && isNonEmptyString(value.appVersion);
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

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

void runExecutionHost().catch(async (error: unknown) => {
  const bootstrapPath = process.env.ZEUS_EXECUTION_HOST_BOOTSTRAP_PATH?.trim();
  const fallbackDirectory = bootstrapPath ? dirname(bootstrapPath) : process.cwd();
  await writeFile(join(fallbackDirectory, 'host-startup-error.log'), `${new Date().toISOString()} ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  }).catch(() => undefined);
  process.exitCode = 1;
});
