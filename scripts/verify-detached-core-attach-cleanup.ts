import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZeusDataLayout } from '../packages/local-server/src/index.ts';
import {
  acquireExecutionHostKernelLease,
  createExecutionHostControlClient,
  executionHostCapabilitiesFor,
  executionHostProtocolVersion,
  inspectExecutionHostKernelLease,
  readExecutionHostLockIdentity,
  readExecutionHostRendezvous,
  removeExecutionHostLockIdentity,
  removeExecutionHostRendezvous,
  type ExecutionHostControlStatus,
  type ExecutionHostRendezvous,
  type ExecutionHostWorkStatus,
  writeExecutionHostLockIdentity,
  writeExecutionHostRendezvous,
} from '../apps/desktop/src/main/executionHostProtocol.js';
import { createExecutionHostLaunchCleanupCapability, handleExecutionHostAttachFailure } from '../apps/desktop/src/main/localServerRuntime.js';
import { expectedBundleIdForDataRootProfile, prepareZeusDataRootIdentity, readAndVerifyZeusDataRootIdentity, zeusDataRootHostIdentity, type ZeusDataRootHostIdentity } from '../apps/desktop/src/main/dataRootIdentity.js';
import { resolveDesktopKeychainService } from '../apps/desktop/src/main/secretServiceIdentity.js';

const childMode = process.argv[2] === '--host-child';

if (childMode) await runVerificationHostChild(process.argv[3] ?? '', process.argv[4] ?? '');
else await verifyBehavior();

async function verifyBehavior(): Promise<void> {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-detached-attach-cleanup-')));
  await chmod(temporaryRoot, 0o700);
  const children = new Set<ChildProcess>();
  // Production Main 自身持有 Electron event loop；探针显式保活，才能覆盖 runtime 内部刻意 unref 的 200ms 轮询。
  const keepAlive = setInterval(() => undefined, 1_000);

  try {
    const launchedRoot = join(temporaryRoot, 'launched');
    const launchedGeneration = `generation-${randomUUID()}`;
    const launched = await startVerificationHost(launchedRoot, launchedGeneration, children);
    const cleanupCapability = createExecutionHostLaunchCleanupCapability({
      userDataPath: launchedRoot,
      dataRootIdentity: launched.dataRootIdentity,
      requestedGenerationId: launchedGeneration,
      spawnedPid: launched.child.pid ?? null,
      rendezvous: launched.rendezvous,
    });
    assert(cleanupCapability, '本次 spawn 的 PID、generation 与 instance 完全一致时必须签发清理能力。');
    const attachFailure = new Error('injected browser bridge registration failure');
    await assert.rejects(handleExecutionHostAttachFailure(attachFailure, cleanupCapability), (error: unknown) => error === attachFailure, '新建 Host attach 失败后必须保留原始注册错误。');
    await waitForChildExit(launched.child);
    assert.equal(launched.child.exitCode, 0, '本次新建 Host 必须立即正常退出。');
    assert.equal(inspectExecutionHostKernelLease(launchedRoot, launched.dataRootIdentity), 'available', '本次新建 Host 清理返回前必须释放内核租约。');
    assert.equal(await readExecutionHostRendezvous(launchedRoot), null, '本次新建 Host 必须清理自己的 rendezvous。');
    assert.equal(await readExecutionHostLockIdentity(launchedRoot), null, '本次新建 Host 必须清理自己的 generation lock。');

    const existingRoot = join(temporaryRoot, 'existing');
    const existing = await startVerificationHost(existingRoot, `generation-${randomUUID()}`, children);
    const existingAttachFailure = new Error('injected existing host registration failure');
    await assert.rejects(handleExecutionHostAttachFailure(existingAttachFailure), (error: unknown) => error === existingAttachFailure, '既有 Host attach 失败必须保留原错误。');
    assert.equal(existing.child.exitCode, null, '没有本次启动能力时不得关闭既有 Host。');
    assert.equal(inspectExecutionHostKernelLease(existingRoot, existing.dataRootIdentity), 'held', '既有 Host 的内核租约必须保持。');
    await stopVerificationHost(existing);

    const mismatchRoot = join(temporaryRoot, 'identity-mismatch');
    const currentGeneration = `generation-${randomUUID()}`;
    const mismatch = await startVerificationHost(mismatchRoot, currentGeneration, children);
    const staleGeneration = `generation-${randomUUID()}`;
    const staleRendezvous: ExecutionHostRendezvous = { ...mismatch.rendezvous, instanceId: staleGeneration };
    const staleCapability = createExecutionHostLaunchCleanupCapability({
      userDataPath: mismatchRoot,
      dataRootIdentity: mismatch.dataRootIdentity,
      requestedGenerationId: staleGeneration,
      spawnedPid: mismatch.child.pid ?? null,
      rendezvous: staleRendezvous,
    });
    assert(staleCapability, '行为探针需要构造一份先前合法、随后发生身份漂移的对象能力。');
    assert.equal(await staleCapability.cleanupAfterAttachFailure(), 'identity_mismatch', '当前 generation/instance 漂移时必须拒绝 shutdown。');
    assert.equal(mismatch.child.exitCode, null, 'identity mismatch 不得关闭当前 Host。');
    assert.equal(inspectExecutionHostKernelLease(mismatchRoot, mismatch.dataRootIdentity), 'held', 'identity mismatch 后当前 Host 必须继续持有租约。');
    await stopVerificationHost(mismatch);

    console.log(
      JSON.stringify(
        {
          verified: true,
          launchedAttachFailure: { pidExited: true, kernelLeaseReleased: true, discoveryIdentityRemoved: true },
          existingHostAttachFailure: { shutdownIssued: false, pidAlive: true, kernelLeaseHeld: true },
          identityMismatch: { outcome: 'identity_mismatch', shutdownIssued: false, pidAlive: true, kernelLeaseHeld: true },
        },
        null,
        2,
      ),
    );
  } finally {
    clearInterval(keepAlive);
    for (const child of children) {
      if (child.exitCode === null && child.pid) process.kill(child.pid, 'SIGTERM');
    }
    await Promise.all([...children].map((child) => waitForChildExit(child).catch(() => undefined)));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

interface VerificationHost {
  child: ChildProcess;
  rendezvous: ExecutionHostRendezvous;
  dataRootIdentity: ZeusDataRootHostIdentity;
}

async function startVerificationHost(userDataPath: string, generationId: string, children: Set<ChildProcess>): Promise<VerificationHost> {
  await mkdir(userDataPath, { recursive: true, mode: 0o700 });
  const keychainService = resolveDesktopKeychainService({ profile: 'test', dataRootPath: userDataPath });
  const dataRootIdentity = zeusDataRootHostIdentity(
    prepareZeusDataRootIdentity({
      rootPath: userDataPath,
      profile: 'test',
      bundleId: expectedBundleIdForDataRootProfile('test'),
      keychainService,
    }),
  );
  await mkdir(dirname(createZeusDataLayout(userDataPath).database), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ['--import=tsx', fileURLToPath(import.meta.url), '--host-child', userDataPath, generationId], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  children.add(child);
  await waitForReadyMessage(child);
  const rendezvous = await readExecutionHostRendezvous(userDataPath);
  assert(rendezvous, '验证 Host 必须发布 rendezvous。');
  assert.equal(rendezvous.instanceId, generationId, '验证 Host 必须发布请求的 generation。');
  assert.equal(rendezvous.pid, child.pid, '验证 Host rendezvous 必须绑定真实子进程 PID。');
  assert.equal(inspectExecutionHostKernelLease(userDataPath, dataRootIdentity), 'held', '验证 Host 必须持有真实 SQLite 内核租约。');
  return { child, rendezvous, dataRootIdentity };
}

async function stopVerificationHost(host: VerificationHost): Promise<void> {
  await createExecutionHostControlClient(host.rendezvous).shutdown();
  await waitForChildExit(host.child);
  assert.equal(inspectExecutionHostKernelLease(dirname(dirname(host.rendezvous.dbPath)), host.dataRootIdentity), 'available', '探针清理 Host 后必须释放租约。');
}

async function waitForReadyMessage(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('验证 Host 未在 15 秒内发布身份。')), 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`验证 Host 在 ready 前退出（code=${String(code)}, signal=${String(signal)}）。`));
    };
    const onMessage = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('ready' in message) || message.ready !== true) return;
      cleanup();
      resolve();
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`验证 Host PID ${String(child.pid)} 未在 15 秒内退出。`)), 15_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function runVerificationHostChild(userDataPath: string, generationId: string): Promise<void> {
  assert(userDataPath && generationId, '验证 Host child 缺少身份参数。');
  await mkdir(dirname(createZeusDataLayout(userDataPath).database), { recursive: true, mode: 0o700 });
  const dataRootIdentity = zeusDataRootHostIdentity(readAndVerifyZeusDataRootIdentity(userDataPath));
  const kernelLease = acquireExecutionHostKernelLease(userDataPath, dataRootIdentity);
  const startedAt = new Date().toISOString();
  const controlToken = randomBytes(32).toString('base64url');
  const apiToken = randomBytes(32).toString('base64url');
  let controlServer: Server | undefined;
  let closing = false;

  const closeHost = async (exitCode: number): Promise<void> => {
    if (closing) return;
    closing = true;
    if (controlServer) await new Promise<void>((resolve) => controlServer!.close(() => resolve()));
    await removeExecutionHostRendezvous(userDataPath, generationId, dataRootIdentity);
    await removeExecutionHostLockIdentity(userDataPath, generationId, dataRootIdentity);
    kernelLease.close();
    if (process.connected) process.disconnect();
    process.exit(exitCode);
  };

  process.once('SIGTERM', () => void closeHost(0));
  process.once('SIGINT', () => void closeHost(0));

  try {
    await writeExecutionHostLockIdentity(userDataPath, {
      protocolVersion: executionHostProtocolVersion,
      generationId,
      pid: process.pid,
      appVersion: 'verification-host',
      createdAt: startedAt,
      ownershipMode: 'kernel_lease_v1',
      dataRootIdentity,
    }, kernelLease);

    const work = verificationWorkStatus(generationId, startedAt);
    controlServer = createServer((request, response) => {
      if (request.headers.authorization !== `Bearer ${controlToken}`) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'unauthorized' }));
        return;
      }
      if (request.method === 'GET' && request.url === '/health') {
        const status: ExecutionHostControlStatus = {
          protocolVersion: executionHostProtocolVersion,
          instanceId: generationId,
          pid: process.pid,
          appVersion: 'verification-host',
          startedAt,
          capabilities: executionHostCapabilitiesFor(dataRootIdentity),
          uiLease: { connected: false, leaseId: null, lastHeartbeatAt: null, appVersion: null },
          work,
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(status));
        return;
      }
      if (request.method === 'POST' && request.url === '/shutdown') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: true }), () => setImmediate(() => void closeHost(0)));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'not found' }));
    });
    await new Promise<void>((resolve, reject) => {
      controlServer!.once('error', reject);
      controlServer!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = controlServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await writeExecutionHostRendezvous(userDataPath, {
      protocolVersion: executionHostProtocolVersion,
      instanceId: generationId,
      pid: process.pid,
      appVersion: 'verification-host',
      baseUrl,
      apiToken,
      controlUrl: baseUrl,
      controlToken,
      dbPath: createZeusDataLayout(userDataPath).database,
      projectRoot: userDataPath,
      dataRootIdentity,
      startedAt,
      updatedAt: startedAt,
      ownershipMode: 'kernel_lease_v1',
    });
    process.send?.({ ready: true });
  } catch (error) {
    console.error(error);
    await closeHost(1);
  }
}

function verificationWorkStatus(generationId: string, startedAt: string): ExecutionHostWorkStatus {
  return {
    instanceId: generationId,
    protocolVersion: executionHostProtocolVersion,
    mode: 'detached',
    pid: process.pid,
    startedAt,
    transport: { state: 'idle', generationId: null },
    runtimeGenerations: [],
    activeTurnCount: 0,
    effectfulTurnCount: 0,
    waitingRequestCount: 0,
    activeRuntimeCount: 0,
    activeCommandRunCount: 0,
    hasActiveWork: false,
    observedAt: new Date().toISOString(),
  };
}
