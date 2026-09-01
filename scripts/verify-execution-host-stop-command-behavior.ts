import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AddressInfo} from 'node:net';
import Fastify from 'fastify';
import type {
    ExecutionHostStopActiveCommandRequest,
    ExecutionHostStopActiveCommandResponse,
    ExecutionHostStopActiveResult
} from '../packages/shared/src/index.js';
import {CommandDeliveryRepository, createZeusDatabase} from '../packages/storage/src/index.js';
import {
    ExecutionHostStopCommandApplication,
    executionHostStopCommandPolicy
} from '../packages/local-server/src/executionHostStopCommandApplication.js';
import {registerExecutionHostControlApi} from '../packages/local-server/src/executionHostControlApi.js';
import {createExecutionHostStopActiveCommandRequest} from '../apps/desktop/src/main/executionHostStopCommand.js';
import {
    createExecutionHostControlClient,
    executionHostProtocolVersion,
    type ExecutionHostRendezvous
} from '../apps/desktop/src/main/executionHostProtocol.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-execution-host-stop-command-'));
const observed: Record<string, unknown> = {};
const fixedNow = new Date('2026-08-21T18:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  const deliveries = new CommandDeliveryRepository(db);
  const application = new ExecutionHostStopCommandApplication({ db, deliveries, redactSensitiveText, now: () => fixedNow });
  const server = Fastify({ logger: false });
  try {
    const acceptedRequest = commandRequest('accepted');
    let codexInterrupts = 0;
    let piInterrupts = 0;
    let goalPauses = 0;
    let saveCalls = 0;
    let commandRunStops = 0;
    const stoppedRuntimeSessions: string[] = [];
    const killedRuntimeSessions: string[] = [];
    const updatedTurns: Array<Record<string, unknown>> = [];
    const updatedSubmissions: Array<{ id: string; status: string }> = [];
    const failedRequests: string[] = [];
    const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let resolveParallelInterrupts: (() => void) | undefined;
    const parallelInterrupts = new Promise<void>((resolve) => (resolveParallelInterrupts = resolve));
    const releaseIfParallel = () => {
      if (codexInterrupts === 1 && piInterrupts === 1) resolveParallelInterrupts?.();
    };
    const submissions = [
      { id: 'submission-codex-a', conversationId: 'conversation-codex', status: 'active', providerTurnId: 'turn-codex' },
      { id: 'submission-codex-duplicate', conversationId: 'conversation-codex', status: 'dispatching', providerTurnId: 'turn-codex' },
      { id: 'submission-pi', conversationId: 'conversation-pi', status: 'active', providerTurnId: 'turn-pi' },
      { id: 'submission-queued', conversationId: 'conversation-codex', status: 'queued', providerTurnId: null },
    ];
    const conversations = new Map<string, Record<string, unknown>>([
      ['conversation-codex', { id: 'conversation-codex', agentKind: 'codex', providerThreadId: 'thread-codex' }],
      ['conversation-pi', { id: 'conversation-pi', agentKind: 'pi', providerThreadId: 'session-pi' }],
    ]);

    registerExecutionHostControlApi({
      server,
      work: { readCounts: () => ({ activeSubmissionCount: 3, effectfulTurnCount: 2, pendingRequestCount: 1, activeRuntimeCount: 1, activeCommandRunCount: 3 }) },
      codexManager: {
        getState: () => ({ type: 'ready', generationId: 'generation-probe' }),
        listRuntimeGenerations: () => [],
        interruptTurn: async () => {
          codexInterrupts += 1;
          releaseIfParallel();
          await parallelInterrupts;
          return {};
        },
      },
      codexCoordinator: {
        pauseGoal: async () => {
          goalPauses += 1;
          return {};
        },
          requestProviderTurnStop: async () => {
              codexInterrupts += 1;
              releaseIfParallel();
              await parallelInterrupts;
              return {terminalConfirmed: true};
          },
      },
      piCoordinator: {
        interruptTurn: async () => {
          piInterrupts += 1;
          releaseIfParallel();
          await parallelInterrupts;
          return {};
        },
      },
      goals: { listActive: () => [{ conversationId: 'conversation-codex' }] },
      conversations: {
        getById: (id: string) => conversations.get(id),
        updateAgentRuntime: () => undefined,
      },
      turns: {
        listInProgress: () => [{ id: 'local-turn', conversationId: 'conversation-codex', status: 'running' }],
        upsert: (turn: Record<string, unknown>) => {
          updatedTurns.push(turn);
          return turn;
        },
      },
      submissions: {
        listRecoverable: () => submissions,
        updateStatus: (id: string, status: string) => {
          updatedSubmissions.push({ id, status });
          return {};
        },
      },
      requests: {
        listPending: () => [{ id: 'request-pending' }],
        fail: (id: string) => failedRequests.push(id),
      },
      commandCenter: {
        stopActiveRuns: () => {
          commandRunStops += 1;
          return 3;
        },
      },
      runtimeManager: {
        listSessions: () => [
          { id: 'runtime-active', status: 'running' },
          { id: 'runtime-ended', status: 'exited' },
        ],
        stopSession: (id: string) => {
          stoppedRuntimeSessions.push(id);
          return {};
        },
        killSession: (id: string) => {
          killedRuntimeSessions.push(id);
          return {};
        },
      },
      stopCommands: application,
      redactSensitiveText,
      publish: (type: string, payload: Record<string, unknown>) => published.push({ type, payload }),
      save: async () => {
        saveCalls += 1;
        await db.save();
      },
      now: () => fixedNow,
    } as Parameters<typeof registerExecutionHostControlApi>[0]);

    const acceptedFirst = await server.inject({ method: 'POST', url: '/api/execution-host/stop-active', payload: acceptedRequest });
    const acceptedReplay = await server.inject({ method: 'POST', url: '/api/execution-host/stop-active', payload: acceptedRequest });
    const acceptedBody = acceptedFirst.json<ExecutionHostStopActiveCommandResponse>();
    const replayBody = acceptedReplay.json<ExecutionHostStopActiveCommandResponse>();
    const acceptedAttempt = requiredAttempt(deliveries, acceptedRequest.command.commandId);
    observed.accepted = {
      firstStatus: acceptedFirst.statusCode,
      replayStatus: acceptedReplay.statusCode,
      firstReplayed: acceptedBody.replayed,
      replayReplayed: replayBody.replayed,
      codexInterrupts,
      piInterrupts,
      goalPauses,
      saveCalls,
      receiptBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      writeMarker: acceptedAttempt.attempt.providerWriteStartedAt !== null,
      outcome: acceptedAttempt.receipt.outcome,
    };

    assertProbe(acceptedFirst.statusCode === 200 && acceptedReplay.statusCode === 200, 'accepted 与 replay 都必须成功。');
    assertProbe(!acceptedBody.replayed && replayBody.replayed && JSON.stringify(acceptedBody.result) === JSON.stringify(replayBody.result), 'accepted replay 必须返回同一不可变结果。');
    assertProbe(codexInterrupts === 1 && piInterrupts === 1, '同一 Provider turn 只能并行发送一次 interrupt，重复 submission 与 HTTP replay 不得二次执行。');
    assertProbe(goalPauses === 1 && saveCalls === 1 && commandRunStops === 1, 'accepted replay 不得再次暂停 Goal、停止命令或提交本机事实。');
    assertProbe(updatedTurns.length === 1 && updatedTurns[0]?.status === 'interrupted', '本机 turn 必须持久化为 interrupted。');
    assertProbe(updatedSubmissions.length === submissions.length && updatedSubmissions.every((entry) => entry.status === 'cancelled'), '所有可恢复 submission 必须持久化为 cancelled。');
    assertProbe(failedRequests.join(',') === 'request-pending', '等待中的本机请求必须收口失败。');
    assertProbe(stoppedRuntimeSessions.join(',') === 'runtime-active' && killedRuntimeSessions.join(',') === 'runtime-active', '只停止运行中的 Runtime。');
      assertProbe(acceptedBody.result.providerOutcomeUnconfirmed === false, 'Codex 与 Pi 均已确认终态时，不得继续误报 Provider 结果未知。');
    assertProbe(acceptedAttempt.receipt.outcome === 'accepted' && acceptedAttempt.attempt.providerWriteStartedAt !== null, 'accepted 必须具有外部 write marker。');
    assertProbe(Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') <= executionHostStopCommandPolicy.receiptMaximumBytes, 'accepted receipt 必须有界。');
    assertProbe(published.length === 0, '无失败的停止操作不应产生失败事件。');

    let unknownInvocations = 0;
    const unknownRequest = commandRequest('unknown');
    const unknownParsed = application.parse(unknownRequest);
    const unknownFirst = await captureError(() =>
      application.execute({
        parsed: unknownParsed,
        invoke: async () => {
          unknownInvocations += 1;
          throw new Error(`${probeRoot}/secret-token ${'sensitive '.repeat(600)}`);
        },
      }),
    );
    const unknownReplay = await captureError(() =>
      application.execute({
        parsed: unknownParsed,
        invoke: async () => {
          unknownInvocations += 1;
          return stopResult();
        },
      }),
    );
    const unknownAttempt = requiredAttempt(deliveries, unknownRequest.command.commandId);
    const unknownEvidence = JSON.parse(unknownAttempt.receipt.evidenceJson) as { error?: { message?: string } };
    observed.unknown = {
      firstCode: errorCode(unknownFirst),
      replayCode: errorCode(unknownReplay),
      invocations: unknownInvocations,
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
      errorBytes: Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8'),
      redacted: !(unknownEvidence.error?.message ?? '').includes(probeRoot),
    };
    assertProbe(errorCode(unknownFirst) === 'ZEUS_EXECUTION_HOST_STOP_OUTCOME_UNKNOWN', 'write marker 后失败必须返回 outcome unknown。');
    assertProbe(errorCode(unknownReplay) === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' && unknownInvocations === 1, 'unknown 必须阻断同一请求自动重发。');
    assertProbe(unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, 'unknown receipt 必须保留 write marker。');
    assertProbe(Buffer.byteLength(unknownEvidence.error?.message ?? '', 'utf8') <= executionHostStopCommandPolicy.errorMaximumBytes && !(unknownEvidence.error?.message ?? '').includes(probeRoot), 'unknown 错误必须脱敏并限长。');

    let beforeWriteInvocations = 0;
    const beforeWriteRequest = commandRequest('failed-before-write');
    const beforeWriteParsed = application.parse(beforeWriteRequest);
    await captureError(() =>
      application.execute({
        parsed: beforeWriteParsed,
        beforeWrite: async () => {
          throw new Error('preflight failed');
        },
        invoke: async () => {
          beforeWriteInvocations += 1;
          return stopResult();
        },
      }),
    );
    const beforeWriteRetry = await application.execute({
      parsed: beforeWriteParsed,
      invoke: async () => {
        beforeWriteInvocations += 1;
        return stopResult();
      },
    });
    const beforeWriteAttempts = deliveries.get(beforeWriteRequest.command.commandId)?.attempts ?? [];
    observed.failedBeforeWrite = { invocations: beforeWriteInvocations, attempts: beforeWriteAttempts.map((attempt) => attempt.outcome), replayed: beforeWriteRetry.replayed };
    assertProbe(
      beforeWriteInvocations === 1 && beforeWriteAttempts.length === 2 && beforeWriteAttempts[0]?.outcome === 'failed_before_write' && beforeWriteAttempts[0]?.providerWriteStartedAt === null,
      'write 前失败可安全新建 attempt，首次不得调用外部操作。',
    );

    const rejectedRequest = commandRequest('explicit-rejection');
    const rejectedParsed = application.parse(rejectedRequest);
    await captureError(() =>
      application.execute({
        parsed: rejectedParsed,
        invoke: async () => {
          throw Object.assign(new Error('explicitly rejected'), { explicit: true });
        },
        isExplicitRejection: (error) => Boolean(error && typeof error === 'object' && 'explicit' in error),
      }),
    );
    const rejectedAttempt = requiredAttempt(deliveries, rejectedRequest.command.commandId);
    observed.explicitRejection = { outcome: rejectedAttempt.receipt.outcome, writeMarker: rejectedAttempt.attempt.providerWriteStartedAt !== null };
    assertProbe(rejectedAttempt.receipt.outcome === 'explicitly_rejected' && rejectedAttempt.attempt.providerWriteStartedAt !== null, '可证明的整体外部拒绝必须保留第四态；真实 stop 路由不猜测该证据。');

    const transportBodies: string[] = [];
    const controlServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        transportBodies.push(Buffer.concat(chunks).toString('utf8'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(acceptedBody));
      });
    });
    await listen(controlServer);
    try {
      const address = controlServer.address() as AddressInfo;
      const rendezvous: ExecutionHostRendezvous = {
        protocolVersion: executionHostProtocolVersion,
        instanceId: 'generation-probe',
        pid: process.pid,
        appVersion: '0.0.0-probe',
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiToken: 'unused-api-token',
        controlUrl: `http://127.0.0.1:${address.port}`,
        controlToken: 'control-token',
        dbPath: join(probeRoot, 'probe.db'),
        projectRoot: probeRoot,
        startedAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
      };
      const client = createExecutionHostControlClient(rendezvous);
      await client.stopActiveWork(acceptedRequest);
      await client.stopActiveWork(acceptedRequest);
    } finally {
      await close(controlServer);
    }
    observed.mainControlIdentity = {
      bodies: transportBodies.length,
      byteIdentical: transportBodies[0] === transportBodies[1],
      objectIdentical: transportBodies.every((body) => JSON.stringify(JSON.parse(body)) === JSON.stringify(acceptedRequest)),
    };
    assertProbe(transportBodies.length === 2 && transportBodies[0] === transportBodies[1], 'Main control 网络 retry 必须复用完全相同的序列化命令正文。');
    assertProbe(
      transportBodies.every((body) => JSON.stringify(JSON.parse(body)) === JSON.stringify(acceptedRequest)),
      'control /work/stop 不得改写公开 {command,input}。',
    );

    observed.inboxRows = db.countRows('command_inbox');
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;
    assertProbe(observed.quickCheck === 'ok', '临时命令账本 quick_check 必须为 ok。');
  } finally {
    await server.close();
    db.discardAndClose();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ status: 'passed', observed }, null, 2)}\n`);

function commandRequest(label: string): ExecutionHostStopActiveCommandRequest {
  let index = 0;
  return createExecutionHostStopActiveCommandRequest({
    now: () => fixedNow,
    createId: () => `${label}-${++index}`,
  });
}

function stopResult(): ExecutionHostStopActiveResult {
  return {
    requestedTurnCount: 0,
    providerInterruptFailureCount: 0,
    closedSubmissionCount: 0,
    failedRequestCount: 0,
    stoppedRuntimeCount: 0,
    stoppedCommandRunCount: 0,
    failedGoalPauseCount: 0,
    failedTurns: [],
    providerOutcomeUnconfirmed: true,
    requestedAt: fixedNow.toISOString(),
  };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const attempt = deliveries.get(commandId)?.attempts.at(-1);
  if (!attempt?.receipt) throw new Error(`Command ${commandId} is missing its receipt.`);
  return { attempt, receipt: attempt.receipt };
}

function redactSensitiveText(value: string): { text: string } {
  return { text: value.replaceAll(probeRoot, '[REDACTED_PATH]').replaceAll('secret-token', '[REDACTED]') };
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
    throw new Error('Expected operation to fail.');
  } catch (error) {
    return error;
  }
}

function errorCode(error: unknown): string | null {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Execution Host stop command verifier failed: ${message}`);
}

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
