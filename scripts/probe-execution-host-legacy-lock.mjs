#!/usr/bin/env node
/* global clearTimeout, console, setTimeout */
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const runtimeModulePath = join(repositoryRoot, 'apps/desktop/dist/main/localServerRuntime.js');
const protocolModulePath = join(repositoryRoot, 'apps/desktop/dist/main/executionHostProtocol.js');
const dataMigrationModulePath = join(repositoryRoot, 'apps/desktop/dist/main/zeusDataMigration.js');
const dataRootIdentityModulePath = join(repositoryRoot, 'apps/desktop/dist/main/dataRootIdentity.js');
const secretServiceIdentityModulePath = join(repositoryRoot, 'apps/desktop/dist/main/secretServiceIdentity.js');
await Promise.all([access(runtimeModulePath), access(protocolModulePath), access(dataMigrationModulePath), access(dataRootIdentityModulePath), access(secretServiceIdentityModulePath)]).catch(() => {
  throw new Error('旧版 Execution Host 互斥探针要求先完成 Desktop build。');
});

const [{ startDesktopLocalServer }, protocol, { prepareZeusDataRoot }, dataRootIdentity, { resolveDesktopKeychainService }] = await Promise.all([
  import(pathToFileURL(runtimeModulePath).href),
  import(pathToFileURL(protocolModulePath).href),
  import(pathToFileURL(dataMigrationModulePath).href),
  import(pathToFileURL(dataRootIdentityModulePath).href),
  import(pathToFileURL(secretServiceIdentityModulePath).href),
]);

const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-legacy-host-lock-probe-')));
const flatProbeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-legacy-flat-layout-probe-')));
const codexHome = join(probeRoot, 'codex-home');
const codexImportRoot = join(probeRoot, 'codex-import');
const grantSecretPath = join(probeRoot, 'conversation-attachment-grant-secret');
const observed = {};
let legacyFixture = null;
const activeRuntimes = [];

try {
  const flatIdentityOptions = identityOptionsFor(flatProbeRoot);
  dataRootIdentity.prepareZeusDataRootIdentity({ rootPath: flatProbeRoot, ...flatIdentityOptions });
  await mkdir(join(flatProbeRoot, 'execution-host'), { recursive: true, mode: 0o700 });
  await Promise.all([writeFile(join(flatProbeRoot, 'zeus.db'), '', { mode: 0o600 }), writeFile(join(flatProbeRoot, 'execution-host', 'host.lock'), '', { mode: 0o600 })]);
  const blockedFlatMigration = prepareZeusDataRoot(flatProbeRoot, [], flatIdentityOptions);
  observed.flatMigrationFence = {
    status: blockedFlatMigration.status,
    layoutKind: blockedFlatMigration.layout.kind,
    layeredDatabaseCreated: await pathExists(join(flatProbeRoot, 'data', 'zeus.db')),
  };
  assertProbe(blockedFlatMigration.status === 'legacy-host-active' && blockedFlatMigration.layout.kind === 'legacy-flat', '平铺根存在空/未确认 host.lock 时必须阻断目录迁移');
  assertProbe(!observed.flatMigrationFence.layeredDatabaseCreated, '被宿主围栏阻断时不得创建分层数据库');

  const identityOptions = identityOptionsFor(probeRoot);
  const prepared = prepareZeusDataRoot(probeRoot, [], identityOptions);
  const hostDataRootIdentity = dataRootIdentity.zeusDataRootHostIdentity(prepared.rootIdentity);
  assertProbe(prepared.status === 'initialized' && prepared.layout.kind === 'layered', '探针必须使用隔离分层资料根');
  await Promise.all([mkdir(codexHome, { mode: 0o700 }), mkdir(codexImportRoot, { mode: 0o700 })]);
  await writeFile(grantSecretPath, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });
  const options = {
    userDataPath: probeRoot,
    dataLayout: prepared.layout,
    dataRootIdentity: hostDataRootIdentity,
    projectRoot: repositoryRoot,
    appVersion: '0.3.27',
    keychainService: identityOptions.keychainService,
    codexNativeEnabled: false,
    codexHome,
    codexConfigImportSourceRoot: codexImportRoot,
    conversationAttachmentGrantSecretPath: grantSecretPath,
    browserAutomation: {
      invoke: async () => ({ success: false, contentItems: [{ type: 'inputText', text: '旧版锁探针不执行浏览器工具。' }] }),
    },
  };

  const lockPath = protocol.executionHostLockPath(probeRoot);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  legacyFixture = await spawnLegacyLockOwner(lockPath);
  const legacyObservation = await protocol.readExecutionHostLockObservation(probeRoot);
  observed.liveLegacyLock = legacyObservation;
  assertProbe(legacyObservation.kind === 'legacy' && legacyObservation.identity.pid === legacyFixture.pid, '必须识别已发布版本的 {pid,createdAt} lock');

  const lease = protocol.acquireExecutionHostKernelLease(probeRoot, hostDataRootIdentity);
  let collisionCode = null;
  try {
    await protocol.writeExecutionHostLockIdentity(probeRoot, {
      protocolVersion: protocol.executionHostProtocolVersion,
      generationId: 'probe-new-generation',
      pid: process.pid,
      appVersion: '0.3.30',
      createdAt: new Date().toISOString(),
      ownershipMode: 'kernel_lease_v1',
      dataRootIdentity: hostDataRootIdentity,
    }, lease);
  } catch (error) {
    collisionCode = error?.code ?? null;
  } finally {
    lease.close();
  }
  const preservedLegacyLock = JSON.parse(await readFile(lockPath, 'utf8'));
  observed.atomicLegacyCollision = { collisionCode, preservedPid: preservedLegacyLock.pid };
  assertProbe(collisionCode === 'ZEUS_EXECUTION_HOST_LEGACY_LOCK_HELD', '新 Host 必须在 no-replace 原子发布时输给存活旧 lock');
  assertProbe(preservedLegacyLock.pid === legacyFixture.pid, '新 Host 不得覆盖旧 Host 身份');

  await stopFixture(legacyFixture);
  legacyFixture = null;
  const staleStartedAt = Date.now();
  const staleError = await captureFailure(() => startDesktopLocalServer(options));
  observed.staleLegacyLock = {
    rejectedMs: Date.now() - staleStartedAt,
    code: staleError?.code ?? null,
    lockPreserved: (await protocol.readExecutionHostLockObservation(probeRoot)).kind === 'legacy',
    rendezvousCreated: Boolean(await protocol.readExecutionHostRendezvous(probeRoot)),
  };
  assertProbe(staleError?.code === 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH', '旧 lock PID 已退出但缺少 v2 数据根身份时必须在 Browser/Core 前进入结构化维护态');
  assertProbe(observed.staleLegacyLock.lockPreserved && !observed.staleLegacyLock.rendezvousCreated, '维护态不得删 lock 或启动第二 Host');

  // 仅清理本探针自己在临时根中创建、且已确认子进程退出的 fixture lock。
  await unlink(lockPath);
  await writeFile(lockPath, '', { mode: 0o600, flag: 'wx' });
  const emptyStartedAt = Date.now();
  const emptyError = await captureFailure(() => startDesktopLocalServer(options));
  const emptyObservation = await protocol.readExecutionHostLockObservation(probeRoot);
  observed.emptyLegacyWindow = {
    rejectedMs: Date.now() - emptyStartedAt,
    code: emptyError?.code ?? null,
    observation: emptyObservation,
    lockBytes: (await readFile(lockPath)).byteLength,
  };
  assertProbe(emptyError?.code === 'ZEUS_EXECUTION_HOST_DATA_ROOT_IDENTITY_MISMATCH', '旧 Host open(wx) 后的空 lock 窗口缺少 v2 数据根身份，必须失败关闭');
  assertProbe(emptyObservation.kind === 'unconfirmed' && observed.emptyLegacyWindow.lockBytes === 0, '空 lock 不得被当成 absent 或自动删除');
  await unlink(lockPath);

  let first;
  let second;
  try {
    [first, second] = await Promise.all([startDesktopLocalServer(options), startDesktopLocalServer(options)]);
  } catch (error) {
    const hostLog = await readFile(join(prepared.layout.executionHost, 'host.log'), 'utf8').catch(() => '<host.log unavailable>');
    throw new Error(`并发新 Main 启动失败；host.log=${hostLog.slice(-4_000)}`, { cause: error });
  }
  activeRuntimes.push(first, second);
  observed.concurrentCurrentStarters = {
    first: { ...first.executionHost },
    second: { ...second.executionHost },
    sameGeneration: first.executionHost.instanceId === second.executionHost.instanceId,
    samePid: first.executionHost.pid === second.executionHost.pid,
  };
  assertProbe(observed.concurrentCurrentStarters.sameGeneration && observed.concurrentCurrentStarters.samePid, '并发新 Main 必须收敛到同一内核租约/generation');
  await first.close('continue_in_background');
  activeRuntimes.splice(activeRuntimes.indexOf(first), 1);
  await second.close('final_quit');
  activeRuntimes.splice(activeRuntimes.indexOf(second), 1);
  assertProbe(!(await protocol.readExecutionHostRendezvous(probeRoot)), '最终退出后必须清理 rendezvous');
} finally {
  if (legacyFixture) await stopFixture(legacyFixture).catch(() => undefined);
  for (const runtime of [...activeRuntimes].reverse()) await runtime.close('final_quit').catch(() => undefined);
  await Promise.all([rm(probeRoot, { recursive: true, force: true }), rm(flatProbeRoot, { recursive: true, force: true })]);
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function identityOptionsFor(rootPath) {
  const profile = 'test';
  return {
    profile,
    bundleId: dataRootIdentity.expectedBundleIdForDataRootProfile(profile),
    keychainService: resolveDesktopKeychainService({ profile, dataRootPath: rootPath }),
  };
}

async function spawnLegacyLockOwner(lockPath) {
  const source = `
    const { open } = require('node:fs/promises');
    (async () => {
      const handle = await open(process.argv[1], 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\\n', 'utf8');
      if (process.send) process.send({ ready: true });
      process.on('SIGTERM', async () => { await handle.close().catch(() => undefined); process.exit(0); });
      setInterval(() => undefined, 1_000);
    })().catch((error) => { if (process.send) process.send({ error: error.message }); process.exit(1); });
  `;
  const child = spawn(process.execPath, ['-e', source, lockPath], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  await new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error('旧 Host lock fixture 未在 5 秒内就绪。')), 5_000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectReady(new Error(`旧 Host lock fixture 提前退出（code=${String(code)}, signal=${String(signal)}）。`));
    });
    child.once('message', (message) => {
      clearTimeout(timer);
      if (message?.ready) resolveReady();
      else rejectReady(new Error(message?.error ?? '旧 Host lock fixture 返回未知错误。'));
    });
  });
  return child;
}

async function stopFixture(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('旧 Host lock fixture 未在 5 秒内退出。')), 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
  });
}

async function captureFailure(operation) {
  try {
    const runtime = await operation();
    activeRuntimes.push(runtime);
    return null;
  } catch (error) {
    return error;
  }
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function assertProbe(condition, message) {
  if (!condition) throw new Error(`旧版 Execution Host 互斥探针失败：${message}`);
}
