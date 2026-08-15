import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLegacyFlatZeusDataLayout, createZeusDataLayout } from '@zeus/local-server/zeus-data-layout';

export const executionHostProtocolVersion = 1;
export const executionHostRendezvousFileName = 'rendezvous.json';

export type ExecutionHostNativeConversationSource = 'task_push' | 'code_review' | 'conflict_resolution';

export interface ExecutionHostCapabilities {
  nativeConversationSources: ExecutionHostNativeConversationSource[];
}

export const currentExecutionHostCapabilities: ExecutionHostCapabilities = {
  nativeConversationSources: ['task_push', 'code_review', 'conflict_resolution'],
};

export interface ExecutionHostBootstrap {
  protocolVersion: number;
  requestedInstanceId: string;
  userDataPath: string;
  projectRoot: string;
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
  startedAt: string;
  updatedAt: string;
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
}

export interface ExecutionHostControlClient {
  health(): Promise<ExecutionHostControlStatus>;
  registerBrowserBridge(input: ExecutionHostBrowserBridgeRegistration): Promise<ExecutionHostLeaseStatus>;
  heartbeat(leaseId: string): Promise<ExecutionHostLeaseStatus>;
  detach(leaseId: string): Promise<ExecutionHostControlStatus>;
  stopActiveWork(): Promise<{
    requestedTurnCount: number;
    closedSubmissionCount: number;
    failedRequestCount: number;
    stoppedRuntimeCount: number;
    stoppedCommandRunCount: number;
    failedTurns: Array<{ conversationId: string; providerTurnId: string; message: string }>;
    requestedAt: string;
  }>;
  shutdown(): Promise<{ accepted: true }>;
}

export function executionHostDirectory(userDataPath: string): string {
  return existsSync(join(userDataPath, 'data')) ? createZeusDataLayout(userDataPath).executionHost : createLegacyFlatZeusDataLayout(userDataPath).executionHost;
}

export function executionHostRendezvousPath(userDataPath: string): string {
  return join(executionHostDirectory(userDataPath), executionHostRendezvousFileName);
}

export function executionHostLockPath(userDataPath: string): string {
  return join(executionHostDirectory(userDataPath), 'host.lock');
}

export async function writeExecutionHostBootstrap(userDataPath: string, input: ExecutionHostBootstrap): Promise<string> {
  const directory = executionHostDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `bootstrap-${input.requestedInstanceId}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(input)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path;
}

export async function readExecutionHostBootstrap(path: string): Promise<ExecutionHostBootstrap> {
  const value = JSON.parse(await readSecureJsonFile(path)) as unknown;
  if (!isExecutionHostBootstrap(value)) throw new Error('Zeus execution-host bootstrap is invalid.');
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
  const directory = executionHostDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const target = executionHostRendezvousPath(userDataPath);
  const temporary = join(directory, `.rendezvous-${input.instanceId}-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(input, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
  await chmod(target, 0o600);
}

export async function removeExecutionHostRendezvous(userDataPath: string, instanceId: string): Promise<void> {
  const current = await readExecutionHostRendezvous(userDataPath);
  if (!current || current.instanceId !== instanceId) return;
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
    stopActiveWork: () =>
      request<{
        requestedTurnCount: number;
        closedSubmissionCount: number;
        failedRequestCount: number;
        stoppedRuntimeCount: number;
        stoppedCommandRunCount: number;
        failedTurns: Array<{ conversationId: string; providerTurnId: string; message: string }>;
        requestedAt: string;
      }>('/work/stop', {
        method: 'POST',
      }),
    shutdown: () =>
      request<{ accepted: true }>('/shutdown', {
        method: 'POST',
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
  const fileStat = await lstat(path);
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error('Zeus execution-host metadata must be a regular file.');
  if ((fileStat.mode & 0o077) !== 0) throw new Error('Zeus execution-host metadata permissions are too broad.');
  if (typeof process.getuid === 'function' && fileStat.uid !== process.getuid()) throw new Error('Zeus execution-host metadata owner does not match the current user.');
  return readFile(path, 'utf8');
}

function isExecutionHostBootstrap(value: unknown): value is ExecutionHostBootstrap {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === executionHostProtocolVersion &&
    isNonEmptyString(value.requestedInstanceId) &&
    isNonEmptyString(value.userDataPath) &&
    isNonEmptyString(value.projectRoot) &&
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
    isNonEmptyString(value.appVersion) &&
    isNonEmptyString(value.createdAt)
  );
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
    !isNonEmptyString(value.startedAt) ||
    !isNonEmptyString(value.updatedAt)
  )
    return false;
  return isLoopbackHttpUrl(value.baseUrl) && isLoopbackHttpUrl(value.controlUrl);
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
