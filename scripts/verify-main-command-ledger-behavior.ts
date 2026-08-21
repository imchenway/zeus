import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createBeforeQuitCleanupHandler } from '../apps/desktop/src/main/beforeQuitCleanup.js';
import { createConversationInputResourceBroker } from '../apps/desktop/src/main/conversationInputResources.js';
import { hashMainCommandBody, MainCommandLedger, MainCommandLedgerError, type MainCommandRequest } from '../apps/desktop/src/main/mainCommandLedger.js';

const rawProbeRoot = await mkdtemp(join(tmpdir(), 'zeus-main-command-ledger-'));
const probeRoot = await realpath(rawProbeRoot);
const observed: Record<string, unknown> = {};
let clockTick = 0;
const now = () => new Date(Date.UTC(2026, 7, 21, 20, 0, clockTick++)).toISOString();

try {
  const ledgerRoot = join(probeRoot, 'ledger');
  const ledger = new MainCommandLedger({ root: ledgerRoot, now });

  let replayEffects = 0;
  const replayRequest = commandRequest('replay-command', 'desktop.probe.replay', { value: 7 });
  const replayFirst = await ledger.execute(replayRequest, 'desktop.probe.replay', async (body, command) => {
    replayEffects += 1;
    await command.markWriteStarted();
    return { accepted: true, value: (body as { value: number }).value };
  });
  const restartedLedger = new MainCommandLedger({ root: ledgerRoot, now });
  const replaySecond = await restartedLedger.execute(replayRequest, 'desktop.probe.replay', async () => {
    replayEffects += 1;
    return { accepted: false };
  });
  assertProbe(replayEffects === 1 && JSON.stringify(replayFirst) === JSON.stringify(replaySecond), '同 commandId、同正文必须只执行一次并从 receipt 重放；acceptedAt 不能污染 immutable identity。');

  let releaseConcurrentEffect!: () => void;
  let concurrentEffects = 0;
  const concurrentRequest = commandRequest('concurrent-command', 'desktop.probe.concurrent', { value: 'same' });
  const concurrentFirst = ledger.execute(concurrentRequest, 'desktop.probe.concurrent', async (_body, command) => {
    concurrentEffects += 1;
    await command.markWriteStarted();
    await new Promise<void>((resolve) => (releaseConcurrentEffect = resolve));
    return { completed: true };
  });
  await waitUntil(() => typeof releaseConcurrentEffect === 'function');
  const concurrentSame = ledger.execute(concurrentRequest, 'desktop.probe.concurrent', async () => {
    concurrentEffects += 1;
    return { completed: false };
  });
  const concurrentConflict = await captureError(() => ledger.execute(commandRequest('concurrent-command', 'desktop.probe.concurrent', { value: 'different' }), 'desktop.probe.concurrent', async () => ({ completed: false })));
  assertProbe(concurrentConflict instanceof MainCommandLedgerError && concurrentConflict.code === 'ZEUS_MAIN_COMMAND_IDENTITY_CONFLICT', 'in-flight 合流必须核验 request identity，不同正文必须立即冲突。');
  releaseConcurrentEffect();
  const [concurrentFirstResult, concurrentSameResult] = await Promise.all([concurrentFirst, concurrentSame]);
  assertProbe(concurrentEffects === 1 && JSON.stringify(concurrentFirstResult) === JSON.stringify(concurrentSameResult), '相同 in-flight identity 只能共享一次 effect。');

  const beforeWriteRequest = commandRequest('before-write-command', 'desktop.probe.before_write', { secret: 'none' });
  const beforeWriteError = await captureError(() =>
    ledger.execute(beforeWriteRequest, 'desktop.probe.before_write', async () => {
      throw new Error('validation failed before write');
    }),
  );
  const beforeWriteOutcome = await ledger.inspect('before-write-command');
  const beforeWriteReplay = await captureError(() => ledger.execute(beforeWriteRequest, 'desktop.probe.before_write', async () => ({ impossible: true })));
  assertProbe(beforeWriteError instanceof Error && beforeWriteOutcome?.state === 'failed_before_write', 'marker 前失败必须耐久收敛为 failed_before_write。');
  assertProbe(beforeWriteReplay instanceof MainCommandLedgerError && beforeWriteReplay.code === 'ZEUS_MAIN_COMMAND_FAILED_BEFORE_WRITE', 'failed_before_write 重放不得暗中再次执行。');

  const unknownRequest = commandRequest('unknown-command', 'desktop.probe.unknown', { value: true });
  let unknownEffects = 0;
  const unknownFirst = await captureError(() =>
    ledger.execute(unknownRequest, 'desktop.probe.unknown', async (_body, command) => {
      unknownEffects += 1;
      await command.markWriteStarted();
      throw new Error(`${probeRoot}/private Bearer super-secret-token`);
    }),
  );
  const unknownOutcome = await ledger.inspect('unknown-command');
  const unknownReplay = await captureError(() =>
    ledger.execute(unknownRequest, 'desktop.probe.unknown', async () => {
      unknownEffects += 1;
      return { impossible: true };
    }),
  );
  assertProbe(unknownFirst instanceof MainCommandLedgerError && unknownFirst.code === 'ZEUS_MAIN_COMMAND_OUTCOME_UNKNOWN_AFTER_WRITE', 'marker 后异常必须向调用方返回 unknown-after-write。');
  assertProbe(unknownReplay instanceof MainCommandLedgerError && unknownReplay.code === 'ZEUS_MAIN_COMMAND_OUTCOME_UNKNOWN_AFTER_WRITE' && unknownEffects === 1, 'unknown-after-write 必须阻止盲重试。');
  assertProbe(
    unknownOutcome?.state === 'unknown_after_write' && !unknownOutcome.failure?.message.includes(probeRoot) && !unknownOutcome.failure?.message.includes('super-secret-token') && (unknownOutcome.failure?.message.length ?? 0) <= 640,
    'failure receipt 必须有界并脱敏路径与 bearer token。',
  );

  const artifactRequest = commandRequest('artifact-command', 'desktop.probe.artifact', { value: 'artifact' });
  const artifactValue = { payload: 'a'.repeat(96 * 1024), count: 3 };
  await ledger.execute(artifactRequest, 'desktop.probe.artifact', async (_body, command) => {
    await command.markWriteStarted();
    return artifactValue;
  });
  const artifactOutcome = await ledger.inspect('artifact-command');
  const artifactRecord = artifactOutcome?.result as { kind?: string; artifactRef?: { relativePath?: string; sha256?: string; byteLength?: number } } | undefined;
  assertProbe(artifactRecord?.kind === 'artifact_ref' && typeof artifactRecord.artifactRef?.relativePath === 'string', '超过 inline budget 的结果必须只在 receipt 中保留 ArtifactRef。');
  const artifactPath = join(ledgerRoot, artifactRecord!.artifactRef!.relativePath!);
  const artifactBytes = await readFile(artifactPath);
  const artifactStat = await stat(artifactPath);
  assertProbe((artifactStat.mode & 0o777) === 0o600 && createHash('sha256').update(artifactBytes).digest('hex') === artifactRecord?.artifactRef?.sha256, 'ArtifactRef 文件必须是 0600 且摘要匹配。');
  const artifactReplay = await new MainCommandLedger({ root: ledgerRoot, now }).execute(artifactRequest, 'desktop.probe.artifact', async () => ({ impossible: true }));
  assertProbe(isDeepStrictEqual(artifactReplay, artifactValue), '合法 ArtifactRef receipt 必须可重放原结果。');
  await writeFile(artifactPath, '{"tampered":true}', { mode: 0o600 });
  const tamperedReplay = await captureError(() => new MainCommandLedger({ root: ledgerRoot, now }).execute(artifactRequest, 'desktop.probe.artifact', async () => ({ impossible: true })));
  assertProbe(tamperedReplay instanceof MainCommandLedgerError && tamperedReplay.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'ArtifactRef 被篡改后必须失败关闭。');

  const oversizedRequest = commandRequest('oversized-command', 'desktop.probe.oversized', { value: 'large' });
  const oversizedValue = { payload: 'z'.repeat(64 * 1024 * 1024 + 1) };
  await ledger.execute(oversizedRequest, 'desktop.probe.oversized', async (_body, command) => {
    await command.markWriteStarted();
    return oversizedValue;
  });
  const oversizedOutcome = await ledger.inspect('oversized-command');
  const oversizedReplay = await captureError(() => new MainCommandLedger({ root: ledgerRoot, now }).execute(oversizedRequest, 'desktop.probe.oversized', async () => ({ impossible: true })));
  assertProbe((oversizedOutcome?.result as { kind?: string } | undefined)?.kind === 'result_omitted', '超过 64 MiB artifact budget 的结果必须明确记录 result_omitted。');
  assertProbe(oversizedReplay instanceof MainCommandLedgerError && oversizedReplay.code === 'ZEUS_MAIN_COMMAND_RESULT_NOT_REPLAYABLE', 'result_omitted 重放必须明确失败，不能用摘要冒充原结果。');

  const markerFailureRoot = join(probeRoot, 'marker-failure-ledger');
  const markerFailureLedger = new MainCommandLedger({ root: markerFailureRoot, now });
  const markerFailureRequest = commandRequest('marker-failure-command', 'desktop.probe.marker_failure', {});
  const markerFailureOutcomePath = ledgerFilePath(markerFailureRoot, 'outcomes', 'marker-failure-command');
  const markerFailureError = await captureError(() =>
    markerFailureLedger.execute(markerFailureRequest, 'desktop.probe.marker_failure', async (_body, command) => {
      const originalOutcomePath = `${markerFailureOutcomePath}.original`;
      await rename(markerFailureOutcomePath, originalOutcomePath);
      await symlink(originalOutcomePath, markerFailureOutcomePath);
      try {
        await command.markWriteStarted();
      } finally {
        await unlink(markerFailureOutcomePath);
        await rename(originalOutcomePath, markerFailureOutcomePath);
      }
      return { impossible: true };
    }),
  );
  const markerFailureOutcome = await markerFailureLedger.inspect('marker-failure-command');
  assertProbe(
    markerFailureError instanceof MainCommandLedgerError && markerFailureOutcome?.state === 'failed_before_write' && !markerFailureOutcome.writeMarker,
    'marker 耐久写失败时不得先改内存 writeStarted，必须收敛为 failed_before_write。',
  );

  const orphanRoot = join(probeRoot, 'orphan-ledger');
  const orphanRequest = commandRequest('orphan-command', 'desktop.probe.orphan', { value: 'orphaned' });
  const orphanEnvelopePath = ledgerFilePath(orphanRoot, 'envelopes', 'orphan-command');
  await mkdir(dirname(orphanEnvelopePath), { recursive: true, mode: 0o700 });
  await writeFile(orphanEnvelopePath, `${JSON.stringify({ schemaVersion: 1, envelope: orphanRequest.envelope, requestSha256: hashMainCommandBody(orphanRequest.body) })}\n`, { mode: 0o600, flag: 'wx' });
  const orphanLedger = new MainCommandLedger({ root: orphanRoot, now });
  const orphanOutcome = await orphanLedger.inspect('orphan-command');
  const orphanReplay = await captureError(() => orphanLedger.execute(orphanRequest, 'desktop.probe.orphan', async () => ({ impossible: true })));
  assertProbe(
    orphanOutcome?.state === 'failed_before_write' && orphanReplay instanceof MainCommandLedgerError && orphanReplay.code === 'ZEUS_MAIN_COMMAND_FAILED_BEFORE_WRITE',
    '启动时必须将只有 immutable envelope 的崩溃孤儿封口，不得永久 IN_PROGRESS。',
  );

  const replayOrphanRequest = commandRequest('replay-orphan-command', 'desktop.probe.replay_orphan', { value: 'same-process-replay' });
  const replayOrphanEnvelopePath = ledgerFilePath(ledgerRoot, 'envelopes', 'replay-orphan-command');
  await mkdir(dirname(replayOrphanEnvelopePath), { recursive: true, mode: 0o700 });
  await writeFile(replayOrphanEnvelopePath, `${JSON.stringify({ schemaVersion: 1, envelope: replayOrphanRequest.envelope, requestSha256: hashMainCommandBody(replayOrphanRequest.body) })}\n`, { mode: 0o600, flag: 'wx' });
  const replayOrphanError = await captureError(() => ledger.execute(replayOrphanRequest, 'desktop.probe.replay_orphan', async () => ({ impossible: true })));
  const replayOrphanOutcome = await ledger.inspect('replay-orphan-command');
  assertProbe(
    replayOrphanError instanceof MainCommandLedgerError && replayOrphanError.code === 'ZEUS_MAIN_COMMAND_FAILED_BEFORE_WRITE' && replayOrphanOutcome?.state === 'failed_before_write',
    '同进程 replay 遇到 Envelope/Outcome 间崩溃也必须立即封口，不得依赖重启。',
  );

  const malformedJsonError = await corruptOutcomeProbe(probeRoot, now, 'malformed-json', async (path) => writeFile(path, '{', { mode: 0o600 }));
  assertProbe(malformedJsonError instanceof MainCommandLedgerError && malformedJsonError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Outcome JSON parse 失败必须统一映射为 receipt corrupt。');

  const extraKeyError = await corruptOutcomeProbe(probeRoot, now, 'extra-key', async (path) => {
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...record, unexpected: true })}\n`, { mode: 0o600 });
  });
  assertProbe(extraKeyError instanceof MainCommandLedgerError && extraKeyError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Outcome 必须精确 key 校验，额外字段必须失败关闭。');

  const pathIdentityError = await corruptOutcomeProbe(probeRoot, now, 'path-identity', async (path) => {
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({ ...record, commandId: 'another-command' })}\n`, { mode: 0o600 });
  });
  assertProbe(pathIdentityError instanceof MainCommandLedgerError && pathIdentityError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Outcome commandId 必须与文件名、分片及 Envelope 一致。');

  const boundedReadError = await corruptOutcomeProbe(probeRoot, now, 'bounded-read', async (path) => writeFile(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20), { mode: 0o600 }));
  assertProbe(boundedReadError instanceof MainCommandLedgerError && boundedReadError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', '超出 Outcome 读取预算的文件必须在有界读取中被拒绝。');

  const growingReadRoot = join(probeRoot, 'growing-read-ledger');
  const growingReadLedger = new MainCommandLedger({ root: growingReadRoot, now, inlineReceiptByteLimit: 1_900 * 1024 });
  const growingReadRequest = commandRequest('growing-read-command', 'desktop.probe.growing_read', {});
  await growingReadLedger.execute(growingReadRequest, 'desktop.probe.growing_read', async (_body, command) => {
    await command.markWriteStarted();
    return { payload: 'g'.repeat(1_500 * 1024) };
  });
  const growingReadOutcomePath = ledgerFilePath(growingReadRoot, 'outcomes', 'growing-read-command');
  let keepGrowing = true;
  const growthLoop = (async () => {
    while (keepGrowing) {
      await appendFile(growingReadOutcomePath, ' ');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  })();
  const growingReadError = await captureError(() => growingReadLedger.inspect('growing-read-command'));
  keepGrowing = false;
  await growthLoop;
  assertProbe(
    growingReadError instanceof MainCommandLedgerError && growingReadError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT' && growingReadError.message.includes('changed while it was being read'),
    '分块读取期间并发增长的 ledger 文件必须通过同 fd 前后身份/大小校验被检出。',
  );

  const artifactPathRoot = join(probeRoot, 'artifact-path-ledger');
  const artifactPathLedger = new MainCommandLedger({ root: artifactPathRoot, now });
  const artifactPathRequest = commandRequest('artifact-path-command', 'desktop.probe.artifact_path', {});
  await artifactPathLedger.execute(artifactPathRequest, 'desktop.probe.artifact_path', async (_body, command) => {
    await command.markWriteStarted();
    return { payload: 'r'.repeat(96 * 1024) };
  });
  const artifactPathOutcomePath = ledgerFilePath(artifactPathRoot, 'outcomes', 'artifact-path-command');
  const artifactPathOutcome = JSON.parse(await readFile(artifactPathOutcomePath, 'utf8')) as {
    result: { artifactRef: Record<string, unknown> };
  } & Record<string, unknown>;
  artifactPathOutcome.result.artifactRef.relativePath = '../../escaped.json';
  await writeFile(artifactPathOutcomePath, `${JSON.stringify(artifactPathOutcome)}\n`, { mode: 0o600 });
  const artifactPathError = await captureError(() => new MainCommandLedger({ root: artifactPathRoot, now }).inspect('artifact-path-command'));
  assertProbe(artifactPathError instanceof MainCommandLedgerError && artifactPathError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'ArtifactRef relativePath 必须由内容摘要精确派生，不得越界。');

  const mainSource = await readFile(join(process.cwd(), 'apps/desktop/src/main/main.ts'), 'utf8');
  const taskClipboardReadBody = namedFunctionBody(mainSource, 'readTaskClipboardResourcesFromNativeClipboard');
  const quitModeBody = namedFunctionBody(mainSource, 'resolveDesktopQuitMode');
  assertProbe(
    taskClipboardReadBody.includes('readTaskClipboardFileReferencesFromClipboard(') &&
      taskClipboardReadBody.includes('readTaskClipboardAttachmentsFromClipboard(') &&
      !taskClipboardReadBody.includes('saveTaskResourcePaths(') &&
      !taskClipboardReadBody.includes('saveTaskAttachmentPayloads('),
    '任务剪贴板 read helper 必须真正只读，物化只能走后续 Main Command。',
  );
  assertProbe(
    quitModeBody.indexOf("if (readOnlyValidationDescriptor) return 'final_quit';") >= 0 &&
      quitModeBody.indexOf("if (readOnlyValidationDescriptor) return 'final_quit';") < quitModeBody.indexOf('runtime.getStatus()') &&
      mainSource.includes("if (!readOnlyValidationDescriptor && (mode === 'final_quit' || mode === 'force_quit') && app.isPackaged)"),
    '只读验收必须无视历史活动计数直接退出，且关闭时禁止扫描/修改正式 App 备份。',
  );

  const conversationResourceRoot = join(probeRoot, 'conversation-resource-cas');
  const conversationResourceBroker = createConversationInputResourceBroker({
    attachmentRoot: conversationResourceRoot,
    grantSecret: 'behavior-verifier-grant-secret',
    clipboard: {
      availableFormats: () => [],
      readBuffer: () => Buffer.alloc(0),
      readHTML: () => '',
      readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }),
      readText: () => '',
    },
  });
  const conversationPayload = [{ name: 'cas.txt', type: 'text/plain', text: '原子 CAS 内容', source: 'paste' as const, kind: 'pasted_text' as const }];
  const [casFirst, casConcurrent] = await Promise.all([
    conversationResourceBroker.materialize(conversationPayload, 'conversation-resource-cas-command'),
    conversationResourceBroker.materialize(conversationPayload, 'conversation-resource-cas-command'),
  ]);
  const casFiles = (await readdir(conversationResourceRoot)).filter((entry) => !entry.startsWith('.'));
  const casPath = casFirst[0]?.localPath;
  assertProbe(casFiles.length === 1 && typeof casPath === 'string' && casConcurrent[0]?.localPath === casPath, '并发相同资源命令必须通过原子 no-replace 发布收敛为同一文件。');
  await writeFile(casPath, 'tampered', { mode: 0o600 });
  const conversationCasConflict = await captureError(() => conversationResourceBroker.materialize(conversationPayload, 'conversation-resource-cas-command'));
  assertProbe(conversationCasConflict instanceof Error && conversationCasConflict.message.includes('CAS destination contains different bytes'), '资源目标存在不同字节时 CAS 必须拒绝覆盖。');

  let cleanupErrorCalls = 0;
  const cleanupKeepOpenExitCodes: number[] = [];
  const cleanupKeepOpenHandler = createBeforeQuitCleanupHandler({
    closeLocalServer: async () => {
      throw new Error('controlled cleanup rejection');
    },
    onCleanupError: () => {
      cleanupErrorCalls += 1;
      return 'keep_open';
    },
    exitApp: (code) => cleanupKeepOpenExitCodes.push(code),
  });
  cleanupKeepOpenHandler({ preventDefault: () => undefined });
  await waitUntil(() => cleanupErrorCalls === 1);
  assertProbe(cleanupKeepOpenExitCodes.length === 0, 'closeLocalServer reject 后必须调用错误回调且保持进程，不得 finally exitApp(0)。');

  let coreCloseAfterNotificationFailure = 0;
  let aggregatedCleanupError: unknown;
  const notificationFailureHandler = createBeforeQuitCleanupHandler({
    closeSystemNotifications: () => {
      throw new Error('controlled notification cleanup rejection');
    },
    closeLocalServer: async () => {
      coreCloseAfterNotificationFailure += 1;
    },
    onCleanupError: (error) => {
      aggregatedCleanupError = error;
      return 'keep_open';
    },
    exitApp: () => {
      throw new Error('notification failure must not exit');
    },
  });
  notificationFailureHandler({ preventDefault: () => undefined });
  await waitUntil(() => aggregatedCleanupError !== undefined);
  assertProbe(aggregatedCleanupError instanceof AggregateError && coreCloseAfterNotificationFailure === 1, '前序通知清理失败也必须继续尝试 Detached Core close，最终以 AggregateError 报告。');

  const validationFailureExitCodes: number[] = [];
  let validationFailureCallbackCalls = 0;
  const validationFailureHandler = createBeforeQuitCleanupHandler({
    closeLocalServer: async () => {
      throw new Error('controlled validation cleanup rejection');
    },
    onCleanupError: () => {
      validationFailureCallbackCalls += 1;
      return 'force_quit';
    },
    exitApp: (code) => validationFailureExitCodes.push(code),
  });
  validationFailureHandler({ preventDefault: () => undefined });
  await waitUntil(() => validationFailureExitCodes.length === 1);
  assertProbe(validationFailureCallbackCalls === 1 && validationFailureExitCodes[0] === 1, '只读验收 cleanup 失败若退出，必须是显式失败码 1，不得伪造成功。');

  let retryCleanupAttempts = 0;
  const retryCleanupExitCodes: number[] = [];
  const retryCleanupHandler = createBeforeQuitCleanupHandler({
    closeLocalServer: async () => {
      retryCleanupAttempts += 1;
      if (retryCleanupAttempts === 1) throw new Error('controlled first cleanup rejection');
    },
    onCleanupError: () => 'retry',
    exitApp: (code) => retryCleanupExitCodes.push(code),
  });
  retryCleanupHandler({ preventDefault: () => undefined });
  await waitUntil(() => retryCleanupExitCodes.length === 1);
  assertProbe(retryCleanupAttempts === 2 && retryCleanupExitCodes[0] === 0, '只有用户选择重试且 cleanup 真正成功后才允许 exitApp(0)。');

  const envelopePath = ledgerFilePath(ledgerRoot, 'envelopes', 'replay-command');
  const outcomePath = ledgerFilePath(ledgerRoot, 'outcomes', 'replay-command');
  const [rootStat, envelopeStat, outcomeStat] = await Promise.all([stat(ledgerRoot), stat(envelopePath), stat(outcomePath)]);
  assertProbe((rootStat.mode & 0o777) === 0o700 && (envelopeStat.mode & 0o777) === 0o600 && (outcomeStat.mode & 0o777) === 0o600, 'ledger 目录必须为 0700，Envelope/Outcome 必须为 0600。');

  const realSymlinkTarget = join(probeRoot, 'symlink-target');
  const symlinkLedgerRoot = join(probeRoot, 'symlink-ledger');
  await mkdir(realSymlinkTarget, { mode: 0o700 });
  await symlink(realSymlinkTarget, symlinkLedgerRoot);
  const symlinkError = await captureError(() =>
    new MainCommandLedger({ root: symlinkLedgerRoot, now }).execute(commandRequest('symlink-command', 'desktop.probe.symlink', {}), 'desktop.probe.symlink', async (_body, command) => {
      await command.markWriteStarted();
      return { impossible: true };
    }),
  );
  assertProbe(symlinkError instanceof MainCommandLedgerError && symlinkError.code === 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'ledger 根或祖先为符号链接时必须在任何 effect 前失败关闭。');

  observed.replay = { effects: replayEffects, stableReceipt: true };
  observed.concurrent = { effects: concurrentEffects, differentIdentityRejected: true };
  observed.outcomes = { beforeWrite: beforeWriteOutcome?.state, unknown: unknownOutcome?.state, unknownEffects };
  observed.recovery = { orphan: orphanOutcome?.state, replayOrphan: replayOrphanOutcome?.state, markerPersistenceFailure: markerFailureOutcome?.state };
  observed.receipts = {
    artifactKind: artifactRecord?.kind,
    artifactBytes: artifactRecord?.artifactRef?.byteLength,
    oversizedKind: (oversizedOutcome?.result as { kind?: string } | undefined)?.kind,
    permissions: { root: rootStat.mode & 0o777, envelope: envelopeStat.mode & 0o777, outcome: outcomeStat.mode & 0o777 },
  };
  observed.security = {
    symlinkRejected: true,
    tamperedArtifactRejected: true,
    boundedRedaction: true,
    malformedJsonRejected: true,
    exactSchemaRejectedExtraKey: true,
    pathIdentityRejected: true,
    boundedReadRejected: true,
    concurrentGrowthRejected: true,
    artifactPathEscapeRejected: true,
  };
  observed.readOnlyLifecycle = { taskClipboardReadOnly: true, validationFinalQuit: true, validationBackupCleanupSkipped: true };
  observed.localResourceCas = { concurrentPublicationCount: casFiles.length, conflictingBytesRejected: true };
  observed.quitCleanup = {
    rejectedCloseDidNotExitZero: true,
    coreCloseAttemptedAfterEarlierFailure: coreCloseAfterNotificationFailure,
    aggregateErrorReported: aggregatedCleanupError instanceof AggregateError,
    validationFailureExitCode: validationFailureExitCodes[0],
    retryAttempts: retryCleanupAttempts,
    successfulRetryExitCode: retryCleanupExitCodes[0],
  };

  process.stdout.write(`${JSON.stringify({ ok: true, observed }, null, 2)}\n`);
} finally {
  await rm(rawProbeRoot, { recursive: true, force: true });
}

function commandRequest(commandId: string, commandType: string, body: unknown): MainCommandRequest {
  return {
    envelope: {
      schemaGeneration: 'zeus-command-envelope-v1',
      commandId,
      commandType,
      actor: { kind: 'user', id: 'main-command-ledger-probe' },
      scope: { kind: 'execution_host', id: 'main-command-ledger-probe' },
      expectedRevision: null,
      idempotencyKey: `probe:${commandId}`,
      issuedAt: '2026-08-21T20:00:00.000Z',
      payload: { transport: 'behavior-verifier' },
    },
    body,
  };
}

function ledgerFilePath(root: string, kind: 'envelopes' | 'outcomes', commandId: string): string {
  const shard = createHash('sha256').update(commandId).digest('hex').slice(0, 2);
  return join(root, kind, shard, `${commandId}.json`);
}

async function corruptOutcomeProbe(root: string, clock: () => string, name: string, mutate: (path: string) => Promise<unknown>): Promise<unknown> {
  const ledgerRoot = join(root, `${name}-ledger`);
  const commandId = `${name}-command`;
  const commandType = `desktop.probe.${name.replaceAll('-', '_')}`;
  const request = commandRequest(commandId, commandType, { name });
  const ledger = new MainCommandLedger({ root: ledgerRoot, now: clock });
  await ledger.execute(request, commandType, async (_body, command) => {
    await command.markWriteStarted();
    return { completed: true };
  });
  const outcomePath = ledgerFilePath(ledgerRoot, 'outcomes', commandId);
  await mutate(outcomePath);
  return captureError(() => new MainCommandLedger({ root: ledgerRoot, now: clock }).inspect(commandId));
}

function namedFunctionBody(source: string, name: string): string {
  const declarationIndex = source.indexOf(`function ${name}`);
  if (declarationIndex < 0) throw new Error(`Behavior verifier could not find function ${name}.`);
  const openingBrace = source.indexOf('{', declarationIndex);
  if (openingBrace < 0) throw new Error(`Behavior verifier could not find body for ${name}.`);
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] !== '}') continue;
    depth -= 1;
    if (depth === 0) return source.slice(openingBrace + 1, index);
  }
  throw new Error(`Behavior verifier found an unterminated body for ${name}.`);
}

async function captureError(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
    return null;
  } catch (error) {
    return error;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for verifier effect boundary.');
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
