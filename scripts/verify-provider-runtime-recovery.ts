import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntimeHealthSnapshot } from '../packages/ai-runtime/src/index.js';
import { ProviderRuntimeRecoveryApplicationService } from '../packages/local-server/src/providerRuntimeRecoveryService.js';
import { CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-provider-runtime-recovery-'));
const database = await createZeusDatabase(join(probeRoot, 'probe.db'));
const repository = new CommandDeliveryRepository(database);
let generationId = 'generation-old';
let recoverCalls = 0;
let behavior: 'success' | 'unknown' | 'unknown_observed' | 'busy' | 'deferred' = 'success';
let releaseDeferredRecovery: (() => void) | null = null;

const readHealth = (): AgentRuntimeHealthSnapshot => ({
  agentKind: 'pi',
  transport: 'rpc',
  generationId,
  lifecycle: behavior === 'unknown_observed' ? 'circuit_open' : 'healthy',
  protocolVersion: 'zeus.pi-runtime-worker.v1',
  processId: 123,
  checkedAt: '2026-08-21T10:00:00.000Z',
  consecutiveFailures: 0,
  circuit: {
    state: behavior === 'unknown_observed' ? 'open' : 'closed',
    openedAt: null,
    reason: behavior === 'unknown_observed' ? 'unknown' : null,
    recovery: 'explicit',
  },
  lastFailure: null,
});

const service = new ProviderRuntimeRecoveryApplicationService({
  commandDeliveries: repository,
  readPiHealth: readHealth,
  async recoverPi() {
    recoverCalls += 1;
    if (behavior === 'unknown') {
      generationId = 'generation-unknown';
      behavior = 'unknown_observed';
      throw Object.assign(new Error('probe result unknown'), { code: 'ZEUS_PI_SESSION_RECOVERY_FAILED' });
    }
    if (behavior === 'busy') {
      behavior = 'success';
      throw Object.assign(new Error('probe busy'), { code: 'ZEUS_PI_WORKER_RECOVERY_BUSY' });
    }
    if (behavior === 'deferred') {
      await new Promise<void>((resolve) => {
        releaseDeferredRecovery = resolve;
      });
      behavior = 'success';
    }
    generationId = `generation-success-${recoverCalls}`;
    return readHealth();
  },
  now: () => '2026-08-21T10:00:00.000Z',
});

try {
  const acceptedCommand = envelope('runtime-command-accepted', 'runtime-key-accepted', generationId);
  const accepted = await service.execute(acceptedCommand);
  const acceptedReplay = await service.execute(acceptedCommand);
  const acceptedAttempt = repository.get(acceptedCommand.commandId)?.attempts.at(-1);
  assertBehavior(recoverCalls === 1 && acceptedReplay.idempotentReplay, 'accepted 同命令重连不得再次调用 Runtime。');
  assertBehavior(acceptedAttempt?.receipt?.nativeSessionId === accepted.generationId && acceptedAttempt.receipt.nativeTurnId === null, 'Runtime generation 必须只保存为 nativeSessionId，不能伪装成 turn。');

  behavior = 'unknown';
  const unknownCommand = envelope('runtime-command-unknown', 'runtime-key-unknown', generationId);
  const unknownFirst = await captureCode(() => service.execute(unknownCommand));
  const callsAfterUnknown = recoverCalls;
  const unknownReplay = await captureCode(() => service.execute(unknownCommand));
  const unknownAttempt = repository.get(unknownCommand.commandId)?.attempts.at(-1);
  assertBehavior(unknownFirst === 'ZEUS_PROVIDER_RECOVERY_OUTCOME_UNKNOWN' && unknownReplay === unknownFirst, 'unknown 首次与重连都必须失败关闭。');
  assertBehavior(recoverCalls === callsAfterUnknown && unknownAttempt?.outcome === 'outcome_unknown_after_write', 'unknown 命令不得创建新 attempt 或再次调用 Runtime。');

  behavior = 'busy';
  const rejectedCommand = envelope('runtime-command-rejected', 'runtime-key-rejected', generationId);
  const rejectedFirst = await captureCode(() => service.execute(rejectedCommand));
  await service.execute(rejectedCommand);
  const rejectedAttempts = repository.get(rejectedCommand.commandId)?.attempts.map((attempt) => attempt.outcome) ?? [];
  assertBehavior(rejectedFirst === 'ZEUS_PI_WORKER_RECOVERY_BUSY' && JSON.stringify(rejectedAttempts) === '["explicitly_rejected","accepted"]', '只有明确拒绝才允许建立安全新 attempt。');

  const staleCommand = envelope('runtime-command-stale', 'runtime-key-stale', 'stale-generation');
  const stale = await captureCode(() => service.execute(staleCommand));
  assertBehavior(stale === 'ZEUS_PROVIDER_RECOVERY_STALE_GENERATION' && repository.get(staleCommand.commandId) === undefined, 'stale generation 必须在 Inbox 前失败关闭。');

  behavior = 'deferred';
  const concurrentCommand = envelope('runtime-command-concurrent', 'runtime-key-concurrent', generationId);
  const firstConcurrent = service.execute(concurrentCommand);
  const sameConcurrent = service.execute(concurrentCommand);
  const otherConcurrent = envelope('runtime-command-concurrent-other', 'runtime-key-concurrent-other', generationId);
  const concurrentBusy = await captureCode(() => service.execute(otherConcurrent));
  assertBehavior(firstConcurrent === sameConcurrent && concurrentBusy === 'ZEUS_PROVIDER_RECOVERY_BUSY', '同命令并发必须合并，其他命令必须有界拒绝。');
  if (!releaseDeferredRecovery) throw new Error('Runtime 并发行为核验没有进入 deferred 边界。');
  releaseDeferredRecovery();
  await Promise.all([firstConcurrent, sameConcurrent]);
  assertBehavior(repository.get(otherConcurrent.commandId) === undefined, '被有界拒绝的并发命令不得写入 Inbox。');

  const quickCheck = database.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check;
  assertBehavior(quickCheck === 'ok', `临时数据库 quick_check 失败：${quickCheck ?? 'missing'}`);
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        recoverCalls,
        accepted: {
          idempotentReplay: acceptedReplay.idempotentReplay,
          nativeSessionId: acceptedAttempt?.receipt?.nativeSessionId ?? null,
          nativeTurnId: acceptedAttempt?.receipt?.nativeTurnId ?? null,
        },
        unknown: { first: unknownFirst, replay: unknownReplay, attempts: repository.get(unknownCommand.commandId)?.attempts.length ?? 0 },
        explicitRejectionAttempts: rejectedAttempts,
        stale,
        concurrency: { sameCommandPromise: firstConcurrent === sameConcurrent, otherCommand: concurrentBusy },
        quickCheck,
      },
      null,
      2,
    ),
  );
} finally {
  await database.close();
  await rm(probeRoot, { recursive: true, force: true });
}

function envelope(commandId: string, idempotencyKey: string, expectedGenerationId: string | null) {
  return {
    schemaGeneration: 'zeus-command-envelope-v1' as const,
    commandId,
    commandType: 'provider.runtime.pi.recover',
    actor: { kind: 'local_api' as const, id: 'runtime-recovery-verifier' },
    scope: { kind: 'runtime_segment' as const, id: 'provider:pi' },
    expectedRevision: null,
    idempotencyKey,
    issuedAt: '2026-08-21T10:00:00.000Z',
    payload: { provider: 'pi' as const, expectedGenerationId, acknowledgeUnknownResultNoReplay: true as const },
  };
}

async function captureCode(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return readErrorCode(error);
  }
}

function readErrorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : null;
}

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Provider Runtime 恢复行为核验失败：${message}`);
}
