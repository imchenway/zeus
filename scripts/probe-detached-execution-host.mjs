#!/usr/bin/env node
/* global AbortSignal, console, fetch, setTimeout */
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const repositoryRoot = resolve(import.meta.dirname, '..');
const runtimeModulePath = join(repositoryRoot, 'apps/desktop/dist/main/localServerRuntime.js');
const protocolModulePath = join(repositoryRoot, 'apps/desktop/dist/main/executionHostProtocol.js');
const dataMigrationModulePath = join(repositoryRoot, 'apps/desktop/dist/main/zeusDataMigration.js');
const dataRootIdentityModulePath = join(repositoryRoot, 'apps/desktop/dist/main/dataRootIdentity.js');
const secretServiceIdentityModulePath = join(repositoryRoot, 'apps/desktop/dist/main/secretServiceIdentity.js');
const storageModulePath = join(repositoryRoot, 'packages/storage/dist/index.js');
await Promise.all([access(runtimeModulePath), access(protocolModulePath), access(dataMigrationModulePath), access(dataRootIdentityModulePath), access(secretServiceIdentityModulePath), access(storageModulePath)]).catch(() => {
  throw new Error('Detached Core 探针要求先完成 Desktop 与 Storage 构建；不能用源码或旧包冒充运行产物。');
});

const [{ startDesktopLocalServer }, protocol, { prepareZeusDataRoot }, dataRootIdentity, { resolveDesktopKeychainService }, storage] = await Promise.all([
  import(pathToFileURL(runtimeModulePath).href),
  import(pathToFileURL(protocolModulePath).href),
  import(pathToFileURL(dataMigrationModulePath).href),
  import(pathToFileURL(dataRootIdentityModulePath).href),
  import(pathToFileURL(secretServiceIdentityModulePath).href),
  import(pathToFileURL(storageModulePath).href),
]);
const probeRoot = await realpath(await mkdtemp(join(tmpdir(), 'zeus-detached-core-probe-')));
const codexHome = join(probeRoot, 'codex-home');
const codexImportRoot = join(probeRoot, 'codex-import');
const grantSecretPath = join(probeRoot, 'conversation-attachment-grant-secret');
const observed = { probeRoot };
let activeRuntime = null;
let expectedHost = null;
let databasePath = null;
let cleanExit = false;
let primaryError = null;
const cleanupErrors = [];

try {
  // 真实 Main 在启动 Detached Core 前先锁定 layered/legacy 数据布局；
  // 探针必须走同一准备边界，否则空目录会在创建 data/ 前被误判为旧布局。
  const profile = 'test';
  const identityOptions = {
    profile,
    bundleId: dataRootIdentity.expectedBundleIdForDataRootProfile(profile),
    keychainService: resolveDesktopKeychainService({ profile, dataRootPath: probeRoot }),
  };
  const preparedData = prepareZeusDataRoot(probeRoot, [], identityOptions);
  const hostDataRootIdentity = dataRootIdentity.zeusDataRootHostIdentity(preparedData.rootIdentity);
  assertProbe(preparedData.status === 'initialized' && preparedData.layout.kind === 'layered', '临时资料根必须与真实 Main 一样先固定为分层布局');
  observed.dataPreparation = { status: preparedData.status, layoutKind: preparedData.layout.kind };
  await Promise.all([mkdir(codexHome, { mode: 0o700 }), mkdir(codexImportRoot, { mode: 0o700 })]);
  await writeFile(grantSecretPath, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n', { mode: 0o600 });
  const buildOptions = (appVersion) => ({
    userDataPath: probeRoot,
    dataLayout: preparedData.layout,
    dataRootIdentity: hostDataRootIdentity,
    projectRoot: repositoryRoot,
    appVersion,
    codexNativeEnabled: false,
    codexHome,
    codexConfigImportSourceRoot: codexImportRoot,
    keychainService: identityOptions.keychainService,
    conversationAttachmentGrantSecretPath: grantSecretPath,
    browserAutomation: {
      invoke: async () => ({ success: false, contentItems: [{ type: 'inputText', text: 'Detached Core 行为探针不执行浏览器工具。' }] }),
    },
  });

  const firstStartedAt = performance.now();
  const first = await startDesktopLocalServer(buildOptions('0.3.27'));
  activeRuntime = first;
  databasePath = first.dbPath;
  observed.firstStartupMs = roundMetric(performance.now() - firstStartedAt);
  observed.firstHost = { ...first.executionHost };
  expectedHost = currentHost(first);
  const firstHealth = await requestHealth(first.config);
  const firstStatus = await first.getStatus();
  observed.firstHealth = compactHealth(firstHealth);
  observed.firstStatus = compactStatus(firstStatus);
  assertProbe(first.executionHost.mode === 'detached' && first.executionHost.instanceId && first.executionHost.pid > 1, '首次启动必须由独立 Core 持有数据库');

  await first.close('continue_in_background');
  activeRuntime = null;
  observed.hostAliveAfterUiDetach = processExists(expectedHost.pid);
  assertProbe(observed.hostAliveAfterUiDetach, '窗口租约断开后 Detached Core 必须继续存活');

  const reconnectStartedAt = performance.now();
  const second = await startDesktopLocalServer(buildOptions('0.3.27'));
  activeRuntime = second;
  observed.reconnectMs = roundMetric(performance.now() - reconnectStartedAt);
  observed.secondHost = { ...second.executionHost };
  const secondHealth = await requestHealth(second.config);
  observed.secondHealth = compactHealth(secondHealth);
  assertProbe(second.executionHost.instanceId === expectedHost.instanceId && second.executionHost.pid === expectedHost.pid, 'Renderer/Main 重连必须复用同一 generation 和 PID');

  const [lock, rendezvous] = await Promise.all([protocol.readExecutionHostLockIdentity(probeRoot), protocol.readExecutionHostRendezvous(probeRoot)]);
  observed.singleWriterIdentity = {
    lockGeneration: lock?.generationId ?? null,
    lockPid: lock?.pid ?? null,
    rendezvousGeneration: rendezvous?.instanceId ?? null,
    rendezvousPid: rendezvous?.pid ?? null,
  };
  assertProbe(lock?.generationId === expectedHost.instanceId && lock?.pid === expectedHost.pid, '单写锁必须绑定当前 generation 与 PID');
  assertProbe(rendezvous?.instanceId === expectedHost.instanceId && rendezvous?.pid === expectedHost.pid, '发现文件必须绑定同一宿主身份');

  // 离线写入真实 Core 表，再验证“有副作用轮次时不交接；用户显式停止后才交接”。
  await second.close('final_quit');
  activeRuntime = null;
  assertProbe(!processExists(expectedHost.pid), '构造活动轮次现场前旧宿主必须已经退出');
  const activeSeed = await seedEffectfulTurn(databasePath);
  observed.effectfulSeed = activeSeed;

  const effectfulHost = await startDesktopLocalServer(buildOptions('0.3.27'));
  activeRuntime = effectfulHost;
  expectedHost = currentHost(effectfulHost);
  const effectfulStatus = await effectfulHost.getStatus();
  observed.effectfulStatusBeforeUpgrade = compactStatus(effectfulStatus);
  assertProbe(effectfulStatus.effectfulTurnCount >= 1 && effectfulStatus.activeTurnCount >= 1, '活动轮次现场必须由真实 submission/turn 表投影为有副作用工作');

  await effectfulHost.close('continue_in_background');
  activeRuntime = null;
  const previousEffectfulHost = { ...expectedHost };
  const blockedUpgrade = await startDesktopLocalServer(buildOptions('0.3.28'));
  activeRuntime = blockedUpgrade;
  const blockedTransition = await blockedUpgrade.refreshConfig();
  await delay(2_500);
  const stillEffectful = await blockedUpgrade.getStatus();
  observed.effectfulUpgradeBlocked = {
    transition: blockedTransition.executionHostTransition.state,
    host: { ...blockedUpgrade.executionHost },
    status: compactStatus(stillEffectful),
    previousPidAlive: processExists(previousEffectfulHost.pid),
  };
  assertProbe(blockedTransition.executionHostTransition.state === 'draining_previous', '跨版本 Main 连接活动旧宿主时必须显示 draining_previous');
  assertProbe(blockedUpgrade.executionHost.instanceId === previousEffectfulHost.instanceId && blockedUpgrade.executionHost.pid === previousEffectfulHost.pid, '真实执行未结束时不得交接到第二宿主');
  assertProbe(processExists(previousEffectfulHost.pid), '真实执行未结束时旧宿主 PID 必须继续存活');

  const effectfulHandoffStartedAt = performance.now();
  await blockedUpgrade.stopActiveWork();
  await waitFor(
    async () => {
      const status = await blockedUpgrade.getStatus();
      return (status.effectfulTurnCount ?? 0) === 0;
    },
    5_000,
    '活动轮次停止持久化',
  );
  await waitFor(() => blockedUpgrade.executionHost.instanceId !== previousEffectfulHost.instanceId && blockedUpgrade.executionHost.pid !== previousEffectfulHost.pid, 12_000, '活动轮次停止后的跨版本宿主交接');
  observed.effectfulHandoffAfterExplicitStopMs = roundMetric(performance.now() - effectfulHandoffStartedAt);
  observed.effectfulPreviousHostExited = !processExists(previousEffectfulHost.pid);
  assertProbe(observed.effectfulPreviousHostExited, '显式停止并交接后旧 PID 必须退出');
  expectedHost = currentHost(blockedUpgrade);
  await assertCurrentHostIdentity(expectedHost, '活动轮次交接后');

  await blockedUpgrade.close('final_quit');
  activeRuntime = null;
  assertProbe(!processExists(expectedHost.pid), '等待用户现场写入前活动轮次新宿主必须退出');

  // Pi waiting 依赖旧进程内运行内核，不能伪装成 Codex pending；prepare 必须在旧宿主内失败关闭。
  const piWaitingSeed = await seedWaitingRequest(databasePath, { agentKind: 'pi', suffix: 'pi_waiting', requestCount: 1 });
  observed.piWaitingSeed = piWaitingSeed;
  const piWaitingHost = await startDesktopLocalServer(buildOptions('0.3.28'));
  activeRuntime = piWaitingHost;
  expectedHost = currentHost(piWaitingHost);
  const piWaitingStatus = await piWaitingHost.getStatus();
  assertProbe(piWaitingStatus.waitingRequestCount === 1 && (piWaitingStatus.effectfulTurnCount ?? 0) === 0, 'Pi waiting 现场必须保持一个待回复请求且没有 effectful work');
  await piWaitingHost.close('continue_in_background');
  activeRuntime = null;
  const piWaitingRendezvous = await protocol.readExecutionHostRendezvous(probeRoot);
  assertProbe(piWaitingRendezvous?.instanceId === expectedHost.instanceId, 'Pi waiting 阻断探针必须连接真实旧宿主');
  const piPreparation = await requestDurableHandoff(piWaitingRendezvous, '0.3.29');
  observed.piWaitingBlocked = {
    statusCode: piPreparation.statusCode,
    error: piPreparation.payload?.error ?? null,
    oldPidAlive: processExists(expectedHost.pid),
    journal: inspectLatestHandoff(databasePath),
  };
  assertProbe(piPreparation.statusCode === 409 && piPreparation.payload?.error === 'ZEUS_EXECUTION_HOST_PI_WAITING_BLOCKED', 'Pi waiting 必须以专用 409 拒绝 durable handoff');
  assertProbe(observed.piWaitingBlocked.oldPidAlive && observed.piWaitingBlocked.journal.status === 'aborted' && observed.piWaitingBlocked.journal.dispatchEnabled === 1, 'Pi waiting 阻断后旧宿主必须存活、账本 aborted 且重新开放派发');
  await protocol.createExecutionHostControlClient(piWaitingRendezvous).shutdown();
  await waitFor(() => !processExists(expectedHost.pid), 10_000, 'Pi waiting 阻断现场最终退出');
  await settleSyntheticWaitingSeed(databasePath, piWaitingSeed);

  // Codex 同一 turn 的多个 pending 请求通过同库 journal 交接；旧宿主退出后刻意不保留 Main 运行时，随后由新 Core 自动 claim。
  const waitingSeed = await seedWaitingRequest(databasePath, { agentKind: 'codex', suffix: 'codex_waiting', requestCount: 2 });
  observed.waitingSeed = waitingSeed;
  const waitingHost = await startDesktopLocalServer(buildOptions('0.3.28'));
  activeRuntime = waitingHost;
  expectedHost = currentHost(waitingHost);
  const waitingStatus = await waitingHost.getStatus();
  observed.waitingStatusBeforeUpgrade = compactStatus(waitingStatus);
  assertProbe(waitingStatus.waitingRequestCount === 2 && (waitingStatus.effectfulTurnCount ?? 0) === 0, `同一 Codex turn 的两个待用户请求必须计入 waiting，但不能伪装成仍在执行副作用，实际=${JSON.stringify(compactStatus(waitingStatus))}`);

  await waitingHost.close('continue_in_background');
  activeRuntime = null;
  const previousWaitingHost = { ...expectedHost };
  const waitingRendezvous = await protocol.readExecutionHostRendezvous(probeRoot);
  assertProbe(waitingRendezvous?.instanceId === previousWaitingHost.instanceId, 'Codex waiting 交接必须连接真实旧宿主');
  const waitingUpgradeStartedAt = performance.now();
  const waitingPreparation = await requestDurableHandoff(waitingRendezvous, '0.3.29');
  assertProbe(waitingPreparation.statusCode === 200 && isDurableHandoffPreparation(waitingPreparation.payload), 'Codex waiting 必须只返回 durable journal 身份与 hash');
  const prepared = waitingPreparation.payload;
  assertProbe(prepared.requestCount === 2 && !('requests' in prepared) && !('checkpoint' in prepared), 'prepare 响应不得把 pending request 或完整 checkpoint 交给 Main');
  await protocol.createExecutionHostControlClient(waitingRendezvous).handoff({ handoffId: prepared.handoffId, checkpointSha256: prepared.checkpointSha256 });
  await waitFor(() => !processExists(previousWaitingHost.pid), 10_000, 'Codex waiting 旧宿主 durable drain');
  observed.crashGapPrepared = inspectLatestHandoff(databasePath);
  assertProbe(
    observed.crashGapPrepared.id === prepared.handoffId &&
      observed.crashGapPrepared.status === 'prepared' &&
      observed.crashGapPrepared.requestCount === 2 &&
      observed.crashGapPrepared.restoredRequestCount === 0 &&
      observed.crashGapPrepared.dispatchEnabled === 0,
    '旧宿主退出且 Main 尚未重连时，同库 journal 必须保持 prepared、零恢复且派发关闭',
  );
  await delay(250);
  const waitingUpgrade = await startDesktopLocalServer(buildOptions('0.3.29'));
  activeRuntime = waitingUpgrade;
  observed.waitingHandoffMs = roundMetric(performance.now() - waitingUpgradeStartedAt);
  observed.waitingPreviousHostExited = !processExists(previousWaitingHost.pid);
  expectedHost = currentHost(waitingUpgrade);
  const waitingStatusAfter = await waitingUpgrade.getStatus();
  observed.waitingStatusAfterUpgrade = compactStatus(waitingStatusAfter);
  assertProbe(observed.waitingPreviousHostExited, '待用户输入 journal 交接后旧 PID 必须退出');
  assertProbe(waitingStatusAfter.waitingRequestCount === 2 && (waitingStatusAfter.effectfulTurnCount ?? 0) === 0, `新宿主必须恢复同 turn 两个待回复请求且保持零副作用执行，实际=${JSON.stringify(compactStatus(waitingStatusAfter))}`);
  await assertCurrentHostIdentity(expectedHost, '待用户输入交接后');

  observed.waitingRecovery = inspectWaitingRecovery(databasePath, waitingSeed);
  observed.completedHandoff = inspectLatestHandoff(databasePath);
  assertProbe(observed.waitingRecovery.requestStatus === 'pending', '宿主交接后待用户请求必须继续保持 pending');
  assertProbe(observed.waitingRecovery.turnStatus === 'waiting', '宿主交接后对应轮次必须继续保持 waiting');
  assertProbe(observed.waitingRecovery.interactionRecoveryCheckpoint === true && observed.waitingRecovery.recoveryReason === 'host_handoff', '待用户请求必须记录真实 host_handoff 恢复 checkpoint');
  assertProbe(
    observed.completedHandoff.id === prepared.handoffId &&
      observed.completedHandoff.status === 'completed' &&
      observed.completedHandoff.claimedByInstanceId === expectedHost.instanceId &&
      observed.completedHandoff.restoredRequestCount === 2 &&
      observed.completedHandoff.dispatchEnabled === 1,
    '新 Core 必须在队列恢复前自动 claim journal、恢复全部请求并重新开放派发',
  );

  await waitingUpgrade.close('final_quit');
  activeRuntime = null;
  assertProbe(!processExists(expectedHost.pid), '检查交接后的等待请求前宿主必须退出');
  observed.waitingAfterFinalQuit = inspectWaitingRecovery(databasePath, waitingSeed);
  assertProbe(observed.waitingAfterFinalQuit.requestStatus === 'failed', 'final_quit 必须结束 pending request');
  assertProbe(observed.waitingAfterFinalQuit.turnStatus === 'failed', 'final_quit 必须让对应 waiting turn 进入同一耐久终态');
  assertProbe(observed.waitingAfterFinalQuit.conversationProviderState === 'paused', 'Provider 终态未知时 final_quit 必须让 conversation 进入 recovery_required 对应的 paused 状态');
  assertProbe(observed.waitingAfterFinalQuit.providerOutcomeUnconfirmed === true && observed.waitingAfterFinalQuit.recoveryRequired === true, 'final_quit 必须保留 Provider 结果未知与显式恢复证据');

  // 人工制造“仍存活宿主使用未来协议”的发现现场。新 Main 必须快速进入维护态，不能删锁、强杀或 spawn 第二 writer。
  const compatibilityHost = await startDesktopLocalServer(buildOptions('0.3.29'));
  activeRuntime = compatibilityHost;
  expectedHost = currentHost(compatibilityHost);
  const lockPath = protocol.executionHostLockPath(probeRoot);
  const rendezvousPath = protocol.executionHostRendezvousPath(probeRoot);
  const [rawLock, rawRendezvous] = await Promise.all([readFile(lockPath, 'utf8'), readFile(rendezvousPath, 'utf8')]);
  const incompatibleProtocolVersion = protocol.executionHostProtocolVersion + 999;
  try {
    await Promise.all([
      writeFile(lockPath, `${JSON.stringify({ ...JSON.parse(rawLock), protocolVersion: incompatibleProtocolVersion }, null, 2)}\n`, { mode: 0o600 }),
      writeFile(rendezvousPath, `${JSON.stringify({ ...JSON.parse(rawRendezvous), protocolVersion: incompatibleProtocolVersion }, null, 2)}\n`, { mode: 0o600 }),
    ]);
    const incompatibleStartedAt = performance.now();
    let incompatibleError = null;
    try {
      await startDesktopLocalServer(buildOptions('0.3.30'));
    } catch (error) {
      incompatibleError = error;
    }
    observed.incompatibleProtocol = {
      rejectedMs: roundMetric(performance.now() - incompatibleStartedAt),
      errorCode: incompatibleError?.code ?? null,
      maintenance: incompatibleError?.maintenance ?? null,
      originalPidAlive: processExists(expectedHost.pid),
      advertisedIdentityPreserved: JSON.parse(await readFile(rendezvousPath, 'utf8')).instanceId === expectedHost.instanceId,
    };
    assertProbe(incompatibleError?.code === 'ZEUS_EXECUTION_HOST_PROTOCOL_INCOMPATIBLE', '协议不兼容必须返回结构化维护错误');
    assertProbe(incompatibleError?.maintenance?.hostPid === expectedHost.pid && incompatibleError?.maintenance?.hostGenerationId === expectedHost.instanceId, '维护错误必须指向真实旧宿主身份');
    assertProbe(observed.incompatibleProtocol.originalPidAlive && observed.incompatibleProtocol.advertisedIdentityPreserved, '协议不兼容不得结束旧 PID 或替换其 generation');
  } finally {
    // 恢复同一宿主原始元数据后再走授权控制面关闭；探针也禁止删除锁或强杀。
    await Promise.all([writeFile(lockPath, rawLock, { mode: 0o600 }), writeFile(rendezvousPath, rawRendezvous, { mode: 0o600 })]);
  }

  await compatibilityHost.close('final_quit');
  activeRuntime = null;
  await waitFor(() => !processExists(expectedHost.pid), 10_000, 'Detached Core 最终退出');
  const [remainingLock, remainingRendezvous, remainingStartup] = await Promise.all([protocol.readExecutionHostLockIdentity(probeRoot), protocol.readExecutionHostRendezvous(probeRoot), protocol.readExecutionHostStartupStatus(probeRoot)]);
  observed.discoveryCleaned = remainingLock === null && remainingRendezvous === null && remainingStartup === null;
  assertProbe(observed.discoveryCleaned, '最终退出后 lock、rendezvous 与 startup 身份必须全部清理');

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    observed.databaseQuickCheck = database.prepare('PRAGMA quick_check').get()?.quick_check ?? null;
  } finally {
    database.close();
  }
  assertProbe(observed.databaseQuickCheck === 'ok', 'Detached Core 最终退出后的临时数据库必须通过 quick_check');
  cleanExit = true;
} catch (error) {
  primaryError = error;
} finally {
  if (activeRuntime) {
    try {
      await activeRuntime.close('final_quit');
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (expectedHost && processExists(expectedHost.pid)) {
    try {
      const rendezvous = await protocol.readExecutionHostRendezvous(probeRoot);
      if (rendezvous?.instanceId === expectedHost.instanceId && rendezvous.pid === expectedHost.pid) {
        await protocol.createExecutionHostControlClient(rendezvous).shutdown();
        await waitFor(() => !processExists(expectedHost.pid), 10_000, '异常路径 Detached Core 收口');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (!expectedHost || !processExists(expectedHost.pid)) await rm(probeRoot, { recursive: true, force: true });
}

if (primaryError && cleanupErrors.length > 0) throw new AggregateError([primaryError, ...cleanupErrors], `Detached Core 探针与清理均失败；临时现场保留在 ${probeRoot}`);
if (primaryError) throw primaryError;
if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `Detached Core 探针清理失败；临时现场保留在 ${probeRoot}`);
assertProbe(cleanExit, 'Detached Core 探针未到达安全终态');
delete observed.probeRoot;
console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

async function seedEffectfulTurn(dbPath) {
  return withWritableDatabase(dbPath, async (db) => {
    const project = ensureProbeProject(db);
    const conversations = new storage.ConversationRepository(db);
    const submissions = new storage.ConversationSubmissionRepository(db);
    const turns = new storage.ConversationTurnRepository(db);
    const timestamp = new Date().toISOString();
    const conversation = conversations.create({
      id: 'probe_effectful_conversation',
      projectId: project.id,
      title: 'Detached Core 活动轮次探针',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'probe_effectful_thread',
      providerModel: 'probe-model',
      providerState: 'active',
      agentKind: 'codex',
      agentTransport: 'app_server',
      nativeSessionId: 'probe_effectful_thread',
    });
    const submission = submissions.createOrGet({
      id: 'probe_effectful_submission',
      conversationId: conversation.id,
      idempotencyKey: 'probe-effectful-submission-v1',
      requestHash: 'a'.repeat(64),
      clientMessageId: 'probe_effectful_client_message',
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'active',
      input: { content: '仅用于验证宿主交接边界，不会发送给 Provider。' },
      providerTurnId: 'probe_effectful_provider_turn',
      createdAt: timestamp,
      dispatchedAt: timestamp,
    });
    const turn = turns.upsert({
      id: 'probe_effectful_turn',
      conversationId: conversation.id,
      providerThreadId: 'probe_effectful_thread',
      providerTurnId: 'probe_effectful_provider_turn',
      clientSubmissionId: submission.id,
      status: 'running',
      startedAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      agentKind: 'codex',
      nativeRunId: 'probe_effectful_provider_turn',
    });
    return { conversationId: conversation.id, submissionId: submission.id, turnId: turn.id };
  });
}

async function seedWaitingRequest(dbPath, { agentKind, suffix, requestCount }) {
  return withWritableDatabase(dbPath, async (db) => {
    const project = ensureProbeProject(db);
    const conversations = new storage.ConversationRepository(db);
    const turns = new storage.ConversationTurnRepository(db);
    const requests = new storage.ConversationServerRequestRepository(db);
    const timestamp = new Date().toISOString();
    const providerThreadId = `probe_${suffix}_thread`;
    const conversation = conversations.create({
      id: `probe_${suffix}_conversation`,
      projectId: project.id,
      title: `Detached Core ${agentKind} 待用户输入探针`,
      transportKind: 'codex_native',
      providerId: agentKind === 'codex' ? 'codex' : 'pi:probe',
      providerThreadId,
      providerModel: 'probe-model',
      providerState: 'waiting',
      agentKind,
      agentTransport: agentKind === 'codex' ? 'app_server' : 'rpc',
      nativeSessionId: providerThreadId,
    });
    const turn = turns.upsert({
      id: `probe_${suffix}_turn`,
      conversationId: conversation.id,
      providerThreadId,
      providerTurnId: `probe_${suffix}_provider_turn`,
      clientSubmissionId: null,
      status: 'waiting',
      startedAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      agentKind,
      nativeRunId: `probe_${suffix}_provider_turn`,
    });
    const requestIds = [];
    for (let index = 0; index < requestCount; index += 1) {
      const request = requests.upsert({
        conversationId: conversation.id,
        turnId: turn.id,
        transportGenerationId: `probe_${suffix}_transport_generation`,
        providerRequestId: `probe_${suffix}_request_${index + 1}`,
        requestKind: 'request_user_input',
        payload: {
          questions: [
            {
              id: `confirm_handoff_${index + 1}`,
              header: '交接确认',
              question: '是否继续？',
              options: [
                { label: '继续', description: '继续该隔离探针。' },
                { label: '停止', description: '停止该隔离探针。' },
              ],
            },
          ],
        },
        status: 'pending',
        containsSecret: false,
        createdAt: timestamp,
      });
      requestIds.push(request.id);
    }
    return { agentKind, conversationId: conversation.id, turnId: turn.id, requestIds };
  });
}

async function withWritableDatabase(dbPath, operation) {
  const db = await storage.createZeusDatabase(dbPath);
  let completed = false;
  try {
    const result = await operation(db);
    await db.save();
    completed = true;
    return result;
  } finally {
    if (completed) await db.close();
    else db.discardAndClose();
  }
}

async function settleSyntheticWaitingSeed(dbPath, seed) {
  return withWritableDatabase(dbPath, async (db) => {
    const conversations = new storage.ConversationRepository(db);
    const turns = new storage.ConversationTurnRepository(db);
    const requests = new storage.ConversationServerRequestRepository(db);
    const timestamp = new Date().toISOString();
    const error = { code: 'ZEUS_DETACHED_PROBE_SYNTHETIC_SEED_SETTLED', message: '隔离探针已完成 Pi waiting 阻断验证。' };
    for (const requestId of seed.requestIds) requests.fail(requestId, { error, resolvedAt: timestamp });
    const turn = turns.getById(seed.turnId);
    if (turn) turns.upsert({ ...turn, status: 'failed', error, completedAt: timestamp, updatedAt: timestamp });
    conversations.updateAgentRuntime(seed.conversationId, { providerState: 'paused', status: 'open' });
  });
}

function ensureProbeProject(db) {
  return new storage.ProjectRepository(db).create({
    name: 'Detached Core Probe',
    localPath: repositoryRoot,
    description: '仅存在于临时 SQLite 的 Execution Host 行为探针项目。',
  });
}

function inspectWaitingRecovery(dbPath, seed) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const requests = seed.requestIds.map((requestId) => db.prepare('SELECT status, response_json FROM conversation_server_requests WHERE id = ?').get(requestId));
    const turn = db.prepare('SELECT status FROM conversation_turns WHERE id = ?').get(seed.turnId);
    const conversation = db.prepare('SELECT provider_state FROM conversations WHERE id = ?').get(seed.conversationId);
    const responses = requests.map((request) => (request?.response_json ? JSON.parse(request.response_json) : null));
    return {
      requestStatus: requests.every((request) => request?.status === requests[0]?.status) ? (requests[0]?.status ?? null) : 'mixed',
      requestCount: requests.length,
      turnStatus: turn?.status ?? null,
      conversationProviderState: conversation?.provider_state ?? null,
      interactionRecoveryCheckpoint: responses.every((response) => response?.interactionRecoveryCheckpoint === true),
      recoveryReason: responses.every((response) => response?.recoveryReason === responses[0]?.recoveryReason) ? (responses[0]?.recoveryReason ?? null) : 'mixed',
      sourceInstanceId: responses.every((response) => response?.sourceInstanceId === responses[0]?.sourceInstanceId) ? (responses[0]?.sourceInstanceId ?? null) : 'mixed',
      providerOutcomeUnconfirmed: responses.every((response) => response?.providerOutcomeUnconfirmed === true),
      recoveryRequired: responses.every((response) => response?.recoveryRequired === true),
    };
  } finally {
    db.close();
  }
}

async function assertCurrentHostIdentity(host, label) {
  const [lock, rendezvous] = await Promise.all([protocol.readExecutionHostLockIdentity(probeRoot), protocol.readExecutionHostRendezvous(probeRoot)]);
  assertProbe(lock?.generationId === host.instanceId && lock?.pid === host.pid, `${label}单写锁必须只属于新 generation`);
  assertProbe(rendezvous?.instanceId === host.instanceId && rendezvous?.pid === host.pid, `${label}发现文件必须只指向新宿主`);
}

function currentHost(runtime) {
  assertProbe(runtime.executionHost.instanceId && runtime.executionHost.pid > 1, 'Detached Core 必须发布有效 generation 与 PID');
  return { instanceId: runtime.executionHost.instanceId, pid: runtime.executionHost.pid };
}

async function requestDurableHandoff(rendezvous, targetAppVersion) {
  const response = await fetch(`${rendezvous.baseUrl}/api/execution-host/handoff/prepare`, {
    method: 'POST',
    headers: { authorization: `Bearer ${rendezvous.apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetAppVersion }),
    signal: AbortSignal.timeout(15_000),
  });
  return { statusCode: response.status, payload: await response.json().catch(() => ({})) };
}

function isDurableHandoffPreparation(value) {
  return value && typeof value === 'object' && typeof value.handoffId === 'string' && /^[a-f0-9]{64}$/u.test(value.checkpointSha256) && Number.isSafeInteger(value.requestCount) && Number.isFinite(Date.parse(value.preparedAt));
}

function inspectLatestHandoff(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const handoff = db
      .prepare(
        `SELECT id, status, request_count, claimed_by_instance_id
           FROM execution_host_handoffs
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
      .get();
    const restored = handoff ? db.prepare(`SELECT COUNT(*) AS count FROM execution_host_handoff_requests WHERE handoff_id = ? AND restore_outcome = 'restored'`).get(handoff.id) : null;
    const metadata = db.prepare('SELECT dispatch_enabled FROM conversation_store_metadata WHERE singleton = 1').get();
    return {
      id: handoff?.id ?? null,
      status: handoff?.status ?? null,
      requestCount: handoff?.request_count ?? null,
      claimedByInstanceId: handoff?.claimed_by_instance_id ?? null,
      restoredRequestCount: restored?.count ?? 0,
      dispatchEnabled: metadata?.dispatch_enabled ?? null,
    };
  } finally {
    db.close();
  }
}

async function requestHealth(config) {
  const response = await fetch(`${config.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`Detached Core health 返回 HTTP ${response.status}`);
  return response.json();
}

function compactHealth(value) {
  return {
    ok: value?.ok ?? null,
    status: value?.status ?? null,
    database: value?.database ?? null,
    storageState: value?.storage?.state ?? null,
  };
}

function compactStatus(value) {
  return {
    mode: value?.mode ?? null,
    pid: value?.pid ?? null,
    instanceId: value?.instanceId ?? null,
    hasActiveWork: value?.hasActiveWork ?? null,
    activeTurnCount: value?.activeTurnCount ?? null,
    effectfulTurnCount: value?.effectfulTurnCount ?? null,
    waitingRequestCount: value?.waitingRequestCount ?? null,
    activeRuntimeCount: value?.activeRuntimeCount ?? null,
    activeCommandRunCount: value?.activeCommandRunCount ?? null,
  };
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`${label} 在 ${timeoutMs}ms 内未完成。`);
}

function delay(timeoutMs) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, timeoutMs));
}

function roundMetric(value) {
  return Math.round(value * 100) / 100;
}

function assertProbe(condition, message) {
  if (!condition) throw new Error(`Detached Core 行为探针失败：${message}`);
}
