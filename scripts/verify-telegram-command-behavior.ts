import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import type { TelegramPollingService } from '../packages/telegram-adapter/src/index.js';
import {
  TelegramCommandApplication,
  telegramChildOperation,
  telegramCommandInputSha256,
  telegramCommandRoutePolicy,
  telegramCommandTypes,
  type TelegramCommandPayload,
  type TelegramCommandRequest,
  type TelegramCommandType,
} from '../packages/local-server/src/telegramCommandApplication.js';
import { registerTelegramPollingApi } from '../packages/local-server/src/telegramPollingApi.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-telegram-command-probe-'));
const secretSentinel = 'telegram-secret-probe-never-persist';
const fixedNow = new Date('2026-08-21T20:00:00.000Z');
const observed: Record<string, unknown> = {};

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const deliveries = new CommandDeliveryRepository(db);
  const application = new TelegramCommandApplication({ db, deliveries, redactSensitiveText, now: () => fixedNow, pollingOnceMaximumActive: 1 });
  const server = Fastify({ logger: false });
  let pollingTimer: ReturnType<typeof setInterval> | undefined;
  try {
    db.execute(`CREATE TABLE telegram_probe_settings (id TEXT PRIMARY KEY, value_json TEXT NOT NULL)`);

    let coreWrites = 0;
    const core = commandRequest('core-settings', telegramCommandTypes.notificationSettingsUpdate, 'telegram.notification-settings', 'telegram_core_settings', {
      enabled: true,
      chatIds: [1001],
      silentMode: true,
    });
    const coreParsed = application.parse<typeof core.input>({ value: core.body, commandType: telegramCommandTypes.notificationSettingsUpdate, scopeId: 'telegram.notification-settings' });
    const coreFirst = application.executeCore({
      parsed: coreParsed,
      destinationId: 'telegram-settings-core',
      resourceId: 'telegram.notification-settings',
      mutateBusinessState: () => {
        coreWrites += 1;
        db.execute(`INSERT INTO telegram_probe_settings (id, value_json) VALUES (?, ?)`, ['notification', JSON.stringify(core.input)]);
        return core.input;
      },
    });
    const coreReplay = application.executeCore({
      parsed: coreParsed,
      destinationId: 'telegram-settings-core',
      resourceId: 'telegram.notification-settings',
      mutateBusinessState: () => {
        throw new Error('Core replay must not execute.');
      },
    });
    observed.core = { writes: coreWrites, replayed: coreReplay.replayed, sameResult: telegramCommandInputSha256(coreFirst.result) === telegramCommandInputSha256(coreReplay.result) };

    let acceptedInvocations = 0;
    const accepted = commandRequest('external-accepted', telegramCommandTypes.connectionTest, 'telegram.connection-test', 'telegram_external_accepted', {});
    const acceptedParsed = application.parse<Record<string, never>>({ value: accepted.body, commandType: telegramCommandTypes.connectionTest, scopeId: 'telegram.connection-test' });
    const acceptedChildren = [telegramChildOperation(acceptedParsed.operationIdentity, 'telegram_configuration_check'), telegramChildOperation(acceptedParsed.operationIdentity, 'send_message_0')];
    const acceptedFirst = await application.executeExternal({
      parsed: acceptedParsed,
      destinationId: 'telegram-send-message',
      resourceId: 'telegram.connection-test',
      children: acceptedChildren,
      invoke: async () => {
        acceptedInvocations += 1;
        return { ok: true, body: 'x'.repeat(48 * 1024) };
      },
    });
    const acceptedReplay = await application.executeExternal({
      parsed: acceptedParsed,
      destinationId: 'telegram-send-message',
      resourceId: 'telegram.connection-test',
      children: acceptedChildren,
      invoke: async () => {
        acceptedInvocations += 1;
        return { ok: false, body: '' };
      },
    });
    const acceptedAttempt = requiredLatestAttempt(deliveries, accepted.commandId);
    const acceptedEvidence = JSON.parse(acceptedAttempt.receipt.evidenceJson) as { childOperations?: unknown[] };
    observed.accepted = {
      invocations: acceptedInvocations,
      replayed: acceptedReplay.replayed,
      sameResult: acceptedFirst.result.body === acceptedReplay.result.body,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      childCount: acceptedEvidence.childOperations?.length ?? 0,
      writeMarker: acceptedAttempt.attempt.providerWriteStartedAt !== null,
    };

    let unknownInvocations = 0;
    const unknown = commandRequest('external-unknown', telegramCommandTypes.dispatchPreview, 'telegram.dispatch-preview', 'telegram_external_unknown', { text: `token=${secretSentinel}` });
    const unknownParsed = application.parse<typeof unknown.input>({ value: unknown.body, commandType: telegramCommandTypes.dispatchPreview, scopeId: 'telegram.dispatch-preview' });
    const unknownChildren = [telegramChildOperation(unknownParsed.operationIdentity, 'telegram_update_dispatch')];
    let unknownFirstCode: unknown = null;
    let unknownReplayCode: unknown = null;
    try {
      await application.executeExternal({
        parsed: unknownParsed,
        destinationId: 'telegram-dispatch-preview',
        resourceId: 'telegram.dispatch-preview',
        children: unknownChildren,
        invoke: async () => {
          unknownInvocations += 1;
          throw new Error(`${'z'.repeat(8 * 1024)} token=${secretSentinel}`);
        },
      });
    } catch (error) {
      unknownFirstCode = (error as { code?: unknown }).code;
    }
    try {
      await application.executeExternal({
        parsed: unknownParsed,
        destinationId: 'telegram-dispatch-preview',
        resourceId: 'telegram.dispatch-preview',
        children: unknownChildren,
        invoke: async () => {
          unknownInvocations += 1;
          return { allowed: true };
        },
      });
    } catch (error) {
      unknownReplayCode = (error as { code?: unknown }).code;
    }
    const unknownAttempt = requiredLatestAttempt(deliveries, unknown.commandId);
    observed.unknown = {
      invocations: unknownInvocations,
      firstCode: unknownFirstCode,
      replayCode: unknownReplayCode,
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      evidenceBytes: Buffer.byteLength(unknownAttempt.receipt.evidenceJson, 'utf8'),
      evidenceRedacted: !unknownAttempt.receipt.evidenceJson.includes(secretSentinel),
    };

    const rejected = commandRequest('external-rejected', telegramCommandTypes.connectionTest, 'telegram.connection-test', 'telegram_external_rejected', {});
    const rejectedParsed = application.parse<Record<string, never>>({ value: rejected.body, commandType: telegramCommandTypes.connectionTest, scopeId: 'telegram.connection-test' });
    try {
      await application.executeExternal({
        parsed: rejectedParsed,
        destinationId: 'telegram-send-message',
        resourceId: 'telegram.connection-test',
        children: [telegramChildOperation(rejectedParsed.operationIdentity, 'send_message_0')],
        invoke: async () => {
          throw Object.assign(new Error('Telegram returned ok=false'), { dispatchDisposition: 'explicitly_rejected' as const });
        },
      });
    } catch {
      // 明确拒绝由不可变 receipt 证明，不在 verifier 中重发同一用户意图。
    }
    observed.explicitlyRejected = requiredLatestAttempt(deliveries, rejected.commandId).receipt.outcome;

    let failedBeforeWriteInvocations = 0;
    const failedBeforeWrite = commandRequest('failed-before-write', telegramCommandTypes.securityReset, 'security.reset', 'telegram_failed_before_write', {});
    const failedBeforeWriteParsed = application.parse<Record<string, never>>({ value: failedBeforeWrite.body, commandType: telegramCommandTypes.securityReset, scopeId: 'security.reset' });
    const failedChildren = [telegramChildOperation(failedBeforeWriteParsed.operationIdentity, 'keychain_delete')];
    try {
      await application.executeExternal({
        parsed: failedBeforeWriteParsed,
        destinationId: 'telegram-security-reset',
        resourceId: 'security.reset',
        children: failedChildren,
        beforeWrite: async () => {
          throw Object.assign(new Error('configuration unavailable'), { code: 'ZEUS_PROBE_BEFORE_WRITE' });
        },
        invoke: async () => {
          failedBeforeWriteInvocations += 1;
          return { reset: true };
        },
      });
    } catch {
      // write marker 前失败可由相同 command 安全重试。
    }
    const failedOutcome = requiredLatestAttempt(deliveries, failedBeforeWrite.commandId).receipt.outcome;
    const failedRetry = await application.executeExternal({
      parsed: failedBeforeWriteParsed,
      destinationId: 'telegram-security-reset',
      resourceId: 'security.reset',
      children: failedChildren,
      invoke: async () => {
        failedBeforeWriteInvocations += 1;
        return { reset: true };
      },
    });
    observed.failedBeforeWrite = { firstOutcome: failedOutcome, retryAccepted: failedRetry.result.reset, invocations: failedBeforeWriteInvocations, attempts: deliveries.get(failedBeforeWrite.commandId)?.attempts.length };

    let releasePoll: (() => void) | undefined;
    const heldPoll = new Promise<void>((resolve) => (releasePoll = resolve));
    let pollInvocations = 0;
    const pollA = commandRequest('poll-capacity-a', telegramCommandTypes.pollingOnce, 'telegram.polling', 'telegram_poll_capacity_a', {});
    const pollB = commandRequest('poll-capacity-b', telegramCommandTypes.pollingOnce, 'telegram.polling', 'telegram_poll_capacity_b', {});
    const pollAParsed = application.parse<Record<string, never>>({ value: pollA.body, commandType: telegramCommandTypes.pollingOnce, scopeId: 'telegram.polling' });
    const pollBParsed = application.parse<Record<string, never>>({ value: pollB.body, commandType: telegramCommandTypes.pollingOnce, scopeId: 'telegram.polling' });
    const runPollA = () =>
      application.executeExternal({
        parsed: pollAParsed,
        destinationId: 'telegram-polling-network',
        resourceId: 'telegram.polling',
        children: [telegramChildOperation(pollAParsed.operationIdentity, 'telegram_get_updates')],
        capacityGroup: 'poll_once',
        invoke: async () => {
          pollInvocations += 1;
          await heldPoll;
          return { running: true };
        },
      });
    const firstPoll = runPollA();
    const duplicatePoll = runPollA();
    await waitFor(() => application.activeCapacitySnapshot().poll_once === 1);
    let capacityCode: unknown = null;
    try {
      await application.executeExternal({
        parsed: pollBParsed,
        destinationId: 'telegram-polling-network',
        resourceId: 'telegram.polling',
        children: [telegramChildOperation(pollBParsed.operationIdentity, 'telegram_get_updates')],
        capacityGroup: 'poll_once',
        invoke: async () => ({ running: true }),
      });
    } catch (error) {
      capacityCode = (error as { code?: unknown }).code;
    }
    releasePoll?.();
    await Promise.all([firstPoll, duplicatePoll]);
    observed.pollCapacity = { invocations: pollInvocations, capacityCode, activeAfter: application.activeCapacitySnapshot().poll_once ?? 0, overflowOutcome: requiredLatestAttempt(deliveries, pollB.commandId).receipt.outcome };

    const fakePolling = createFakePollingService();
    registerTelegramPollingApi({
      server,
      application,
      requireService: async () => fakePolling,
      getService: () => fakePolling,
      getTimer: () => pollingTimer,
      setTimer: (timer) => (pollingTimer = timer),
      redactSensitiveText,
    });
    const aliasStart = commandRequest('alias-start', telegramCommandTypes.pollingStart, 'telegram.polling', 'telegram_alias_start', {});
    const aliasStop = commandRequest('alias-stop', telegramCommandTypes.pollingStop, 'telegram.polling', 'telegram_alias_stop', {});
    const aliasStartResponse = await server.inject({ method: 'POST', url: '/api/telegram/start', payload: aliasStart.body });
    const aliasStopResponse = await server.inject({ method: 'POST', url: '/api/telegram/polling/stop', payload: aliasStop.body });
    observed.aliases = { startStatus: aliasStartResponse.statusCode, stopStatus: aliasStopResponse.statusCode, sharedStartType: aliasStart.body.command.commandType, sharedStopType: aliasStop.body.command.commandType };

    const receipts = db.select<{ outcome: string; evidence_json: string }>(`SELECT outcome, evidence_json FROM command_delivery_receipts ORDER BY occurred_at, id`);
    const durableText = db
      .select<{ value: string }>(`SELECT envelope_json AS value FROM command_inbox UNION ALL SELECT evidence_json AS value FROM command_delivery_receipts`)
      .map((row) => row.value)
      .join('\n');
    observed.protocol = {
      outcomes: [...new Set(receipts.map((row) => row.outcome))].sort(),
      maximumReceiptBytes: Math.max(...receipts.map((row) => Buffer.byteLength(row.evidence_json, 'utf8'))),
      durableSecretPresent: durableText.includes(secretSentinel),
      routeCounts: { external: telegramCommandRoutePolicy.externalOperations.length, core: telegramCommandRoutePolicy.coreApplications.length },
    };
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    observed.realExternalServicesStarted = false;

    assertProbe(coreWrites === 1 && coreReplay.replayed && telegramCommandInputSha256(coreFirst.result) === telegramCommandInputSha256(coreReplay.result), 'Core 设置与 accepted receipt 必须原子提交，replay 不得重做 mutation。');
    assertProbe(acceptedInvocations === 1 && acceptedReplay.replayed && acceptedFirst.result.body === acceptedReplay.result.body, 'accepted external replay 必须返回同一有界结果且不得二次写出。');
    assertProbe(acceptedAttempt.attempt.providerWriteStartedAt !== null && (acceptedEvidence.childOperations?.length ?? 0) === 2, '外部组合命令必须保留父 write marker 与稳定 child identities。');
    assertProbe(unknownFirstCode === 'ZEUS_TELEGRAM_COMMAND_OUTCOME_UNKNOWN' && unknownReplayCode === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && unknownInvocations === 1, 'unknown 后必须阻断自动重发。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && !unknownAttempt.receipt.evidenceJson.includes(secretSentinel), 'unknown 回执必须脱敏且保留保守结论。');
    assertProbe(observed.explicitlyRejected === 'explicitly_rejected' && failedOutcome === 'failed_before_write', '四态协议必须区分明确拒绝与写出前失败。');
    assertProbe(failedRetry.result.reset && failedBeforeWriteInvocations === 1, '只有 failed_before_write 可以用相同 immutable command 安全重试。');
    assertProbe(
      pollInvocations === 1 && capacityCode === 'ZEUS_TELEGRAM_POLL_CAPACITY_EXCEEDED' && requiredLatestAttempt(deliveries, pollB.commandId).receipt.outcome === 'failed_before_write',
      'poll-once 必须 singleflight 且在第二个网络写出前执行硬容量拒绝。',
    );
    assertProbe(aliasStartResponse.statusCode === 200 && aliasStopResponse.statusCode === 200, 'Telegram start/stop 兼容 alias 必须经过统一命令应用。');
    assertProbe(
      receipts.every((row) => Buffer.byteLength(row.evidence_json, 'utf8') <= telegramCommandRoutePolicy.maximumReceiptBytes),
      '所有 Telegram receipt 必须受 64 KiB 预算约束。',
    );
    assertProbe(!durableText.includes(secretSentinel), 'Telegram input 明文与错误中的 token sentinel 不得进入 Inbox/Receipt。');
    assertProbe(telegramCommandRoutePolicy.externalOperations.length === 10 && telegramCommandRoutePolicy.coreApplications.length === 1, 'Telegram 命令清单必须精确覆盖 11 个 mutation 入口。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));
  } finally {
    if (pollingTimer) clearInterval(pollingTimer);
    await server.close();
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function commandRequest<TInput extends object>(label: string, commandType: TelegramCommandType, scopeId: string, operationIdentity: string, input: TInput): { commandId: string; input: TInput; body: TelegramCommandRequest<TInput> } {
  const commandId = `command_telegram_probe_${label}`;
  const payload: TelegramCommandPayload = { operationIdentity, inputSha256: telegramCommandInputSha256(input) };
  const command: CommandEnvelope<TelegramCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType,
    actor: { kind: 'local_api', id: 'telegram-command-verifier' },
    scope: { kind: 'settings', id: scopeId },
    expectedRevision: null,
    idempotencyKey: `${commandType}:${operationIdentity}`,
    issuedAt: fixedNow.toISOString(),
    payload,
  };
  return { commandId, input, body: { command, input } };
}

function requiredLatestAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const attempt = deliveries.get(commandId)?.attempts.at(-1);
  if (!attempt?.receipt) throw new Error(`Missing durable Telegram command attempt for ${commandId}.`);
  return { attempt, receipt: attempt.receipt };
}

function createFakePollingService(): TelegramPollingService {
  let running = false;
  return {
    start: async () => ({ running: (running = true), offset: 0, lastError: null, handledUpdates: 0 }),
    stop: async () => ({ running: (running = false), offset: 0, lastError: null, handledUpdates: 0 }),
    pollOnce: async () => ({ running, offset: 0, lastError: null, handledUpdates: 0 }),
    status: () => ({ running, offset: 0, lastError: null, handledUpdates: 0 }),
    logs: () => [],
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for Telegram command verifier state.');
}

function redactSensitiveText(value: string): { text: string } {
  return { text: value.replaceAll(secretSentinel, '[REDACTED]').replace(/(token\s*=\s*)[^\s"']+/giu, '$1[REDACTED]') };
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Telegram command verifier failed: ${message}`);
}
