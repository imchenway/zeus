import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/index.js';
import { ArtifactStore, CommandDeliveryRepository, createZeusDatabase } from '../packages/storage/src/index.js';
import {
  ConversationDispatchCommandApplication,
  conversationDispatchCommandTypes,
  conversationDispatchInputSha256,
  type ConversationDispatchCommandPayload,
  type ConversationDispatchCommandType,
  type ConversationDispatchMutationRequest,
} from '../packages/local-server/src/conversationDispatchCommandApplication.js';

const repositoryRoot = resolve(import.meta.dirname, '..');
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-conversation-dispatch-command-probe-'));
const observed: Record<string, unknown> = {};
let clockMs = Date.parse('2026-08-21T18:00:00.000Z');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    const deliveries = new CommandDeliveryRepository(db);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), () => now().toISOString(), { minimumFreeBytes: 0 });
    const application = new ConversationDispatchCommandApplication({ db, deliveries, artifacts, redactSensitiveText, now });
    db.execute('CREATE TABLE conversation_dispatch_probe (id TEXT PRIMARY KEY, value TEXT NOT NULL)');

    const coreRequest = commandRequest({
      label: 'core',
      commandType: conversationDispatchCommandTypes.queueUpdate,
      scopeKind: 'submission',
      scopeId: 'submission-core',
      operationIdentity: 'conversation-dispatch-core-operation',
      input: { content: 'durable queue edit' },
    });
    const coreParsed = application.parse<{ content: string }>({
      value: coreRequest.body,
      commandType: conversationDispatchCommandTypes.queueUpdate,
      scopeKind: 'submission',
      scopeId: 'submission-core',
    });
    let coreInvocations = 0;
    const executeCore = () =>
      application.executeCore({
        parsed: coreParsed,
        destinationId: 'conversation-queue-application',
        resourceId: 'submission-core',
        mutateBusinessState: () => {
          coreInvocations += 1;
          db.execute('INSERT INTO conversation_dispatch_probe (id, value) VALUES (?, ?)', ['core', coreParsed.input.content]);
          return { content: coreParsed.input.content, revision: 1 };
        },
      });
    const coreAccepted = executeCore();
    db.execute("UPDATE conversation_dispatch_probe SET value = 'later' WHERE id = 'core'");
    const coreReplay = executeCore();
    observed.core = {
      invocations: coreInvocations,
      firstReplayed: coreAccepted.replayed,
      replayed: coreReplay.replayed,
      immutableReplay: coreReplay.result.content,
      currentBusinessValue: db.get<{ value: string }>("SELECT value FROM conversation_dispatch_probe WHERE id = 'core'")?.value ?? null,
    };

    const oversizedRequest = commandRequest({
      label: 'core-oversized',
      commandType: conversationDispatchCommandTypes.queueReorder,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-core-oversized',
      operationIdentity: 'conversation-dispatch-core-oversized-operation',
      input: { orderedSubmissionIds: ['submission-a'] },
    });
    const oversizedParsed = application.parse<{ orderedSubmissionIds: string[] }>({
      value: oversizedRequest.body,
      commandType: conversationDispatchCommandTypes.queueReorder,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-core-oversized',
    });
    observed.oversizedCoreError = captureCode(() =>
      application.executeCore({
        parsed: oversizedParsed,
        destinationId: 'conversation-queue-application',
        resourceId: 'conversation-core-oversized',
        mutateBusinessState: () => {
          db.execute('INSERT INTO conversation_dispatch_probe (id, value) VALUES (?, ?)', ['oversized', 'must-roll-back']);
          return { snapshot: 'x'.repeat(300_000) };
        },
      }),
    );
    observed.oversizedCoreBusinessRows = rowCount(db, 'conversation_dispatch_probe', "id = 'oversized'");
    observed.oversizedCoreInboxRows = rowCount(db, 'command_inbox', `command_id = '${oversizedRequest.commandId}'`);

    const tamperedRequest = commandRequest({
      label: 'tampered',
      commandType: conversationDispatchCommandTypes.messageSubmit,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-tampered',
      operationIdentity: 'conversation-dispatch-tampered-operation',
      input: { idempotencyKey: 'message-tampered', content: 'original' },
    });
    observed.tamperedInputError = captureCode(() =>
      application.parse({
        value: { command: tamperedRequest.body.command, input: { idempotencyKey: 'message-tampered', content: 'changed' } },
        commandType: conversationDispatchCommandTypes.messageSubmit,
        scopeKind: 'product_conversation',
        scopeId: 'conversation-tampered',
      }),
    );

    const acceptedRequest = commandRequest({
      label: 'accepted',
      commandType: conversationDispatchCommandTypes.sideChatAsk,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-external-accepted',
      operationIdentity: 'conversation-dispatch-external-accepted-operation',
      input: { selectedText: 'selection', question: 'why?' },
    });
    const acceptedParsed = application.parse<{ selectedText: string; question: string }>({
      value: acceptedRequest.body,
      commandType: conversationDispatchCommandTypes.sideChatAsk,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-external-accepted',
    });
    let acceptedInvocations = 0;
    const acceptedFirst = await application.executeExternal({
      parsed: acceptedParsed,
      destinationId: 'conversation-side-chat-provider',
      resourceId: 'conversation-external-accepted',
      externalOperationId: 'side-chat:conversation-dispatch-external-accepted-operation',
      invoke: async () => {
        acceptedInvocations += 1;
        return { answer: 'a'.repeat(1_250_000) };
      },
    });
    const acceptedReplay = await application.executeExternal({
      parsed: acceptedParsed,
      destinationId: 'conversation-side-chat-provider',
      resourceId: 'conversation-external-accepted',
      externalOperationId: 'side-chat:conversation-dispatch-external-accepted-operation',
      invoke: async () => {
        acceptedInvocations += 1;
        return { answer: 'must-not-run' };
      },
    });
    const acceptedAttempt = requiredAttempt(deliveries, acceptedRequest.commandId);
    const acceptedArtifact = requireArtifactEvidence(acceptedAttempt.receipt.evidenceJson);
    observed.acceptedExternal = {
      invocations: acceptedInvocations,
      replayed: acceptedReplay.replayed,
      immutableReplayBytes: Buffer.byteLength(acceptedReplay.result.answer, 'utf8'),
      firstEqualsReplay: acceptedFirst.result.answer === acceptedReplay.result.answer,
      receiptEvidenceBytes: Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8'),
      artifactContentBytes: acceptedArtifact.contentByteLength,
      artifactGeneration: acceptedArtifact.generationId,
    };

    const concurrentRequest = commandRequest({
      label: 'concurrent',
      commandType: conversationDispatchCommandTypes.queueResume,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-concurrent',
      operationIdentity: 'conversation-dispatch-concurrent-operation',
      input: {},
    });
    const concurrentParsed = application.parse<Record<string, never>>({
      value: concurrentRequest.body,
      commandType: conversationDispatchCommandTypes.queueResume,
      scopeKind: 'product_conversation',
      scopeId: 'conversation-concurrent',
    });
    let concurrentInvocations = 0;
    let releaseConcurrent = (): void => undefined;
    const barrier = new Promise<void>((resolveBarrier) => {
      releaseConcurrent = resolveBarrier;
    });
    const concurrentInput = {
      parsed: concurrentParsed,
      destinationId: 'conversation-queue-resume',
      resourceId: 'conversation-concurrent',
      externalOperationId: 'queue-resume:conversation-concurrent:conversation-dispatch-concurrent-operation',
      invoke: async () => {
        concurrentInvocations += 1;
        await barrier;
        return { status: 'resumed' };
      },
    };
    const concurrentFirst = application.executeExternal(concurrentInput);
    const concurrentDuplicate = application.executeExternal(concurrentInput);
    releaseConcurrent();
    const concurrentResults = await Promise.all([concurrentFirst, concurrentDuplicate]);
    observed.concurrent = { invocations: concurrentInvocations, statuses: concurrentResults.map((entry) => entry.result.status) };

    const beforeWrite = externalRequest(application, 'before-write');
    observed.failedBeforeWriteError = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: beforeWrite.parsed,
        destinationId: 'conversation-provider-turn-interrupt',
        resourceId: 'turn-before-write',
        externalOperationId: beforeWrite.externalOperationId,
        beforeWrite: async () => {
          throw Object.assign(new Error('preflight rejected'), { code: 'ZEUS_DISPATCH_PROBE_PREFLIGHT' });
        },
        invoke: async () => ({ status: 'must-not-run' }),
      }),
    );
    const beforeWriteRetry = await application.executeExternal({
      parsed: beforeWrite.parsed,
      destinationId: 'conversation-provider-turn-interrupt',
      resourceId: 'turn-before-write',
      externalOperationId: beforeWrite.externalOperationId,
      invoke: async () => ({ status: 'accepted-after-safe-retry' }),
    });
    const beforeWriteSnapshot = deliveries.get(beforeWrite.parsed.command.commandId);
    observed.failedBeforeWrite = {
      attempts: beforeWriteSnapshot?.attempts.length ?? 0,
      firstOutcome: beforeWriteSnapshot?.attempts[0]?.outcome ?? null,
      retryResult: beforeWriteRetry.result.status,
    };

    const explicit = externalRequest(application, 'explicit');
    observed.explicitError = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: explicit.parsed,
        destinationId: 'conversation-provider-turn-interrupt',
        resourceId: 'turn-explicit',
        externalOperationId: explicit.externalOperationId,
        invoke: async () => {
          throw Object.assign(new Error(`/secret/conversation token=probe ${'sensitive '.repeat(512)}`), { code: 'ZEUS_DISPATCH_PROBE_EXPLICIT', statusCode: 409 });
        },
        isExplicitRejection: (error) => Boolean(error) && typeof error === 'object' && (error as { statusCode?: unknown }).statusCode === 409,
      }),
    );
    const explicitAttempt = requiredAttempt(deliveries, explicit.parsed.command.commandId);
    const explicitEvidence = JSON.parse(explicitAttempt.receipt.evidenceJson) as { error?: { message?: string } };
    observed.explicit = {
      outcome: explicitAttempt.receipt.outcome,
      messageBytes: Buffer.byteLength(explicitEvidence.error?.message ?? '', 'utf8'),
      redacted: !(explicitEvidence.error?.message ?? '').includes('/secret/conversation') && !(explicitEvidence.error?.message ?? '').includes('token=probe'),
    };

    const unknown = externalRequest(application, 'unknown');
    let unknownInvocations = 0;
    observed.unknownError = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown.parsed,
        destinationId: 'conversation-provider-turn-interrupt',
        resourceId: 'turn-unknown',
        externalOperationId: unknown.externalOperationId,
        invoke: async () => {
          unknownInvocations += 1;
          throw Object.assign(new Error('connection lost after write'), { code: 'ZEUS_DISPATCH_PROBE_UNKNOWN' });
        },
      }),
    );
    observed.unknownReplayError = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown.parsed,
        destinationId: 'conversation-provider-turn-interrupt',
        resourceId: 'turn-unknown',
        externalOperationId: unknown.externalOperationId,
        invoke: async () => {
          unknownInvocations += 1;
          return { status: 'must-not-run' };
        },
      }),
    );
    const unknownAttempt = requiredAttempt(deliveries, unknown.parsed.command.commandId);
    observed.unknown = {
      invocations: unknownInvocations,
      outcome: unknownAttempt.receipt.outcome,
      writeMarker: unknownAttempt.attempt.providerWriteStartedAt !== null,
    };

    const structure = await inspectStructure();
    observed.structure = structure;
    observed.quickCheck = db.get<{ quick_check: string }>('PRAGMA quick_check')?.quick_check ?? null;

    assertProbe(coreInvocations === 1 && !coreAccepted.replayed && coreReplay.replayed && coreReplay.result.content === 'durable queue edit', 'Core replay 必须返回首次不可变结果且不得重做业务写。');
    assertProbe(
      observed.oversizedCoreError === 'ZEUS_CONVERSATION_DISPATCH_COMMAND_RESULT_TOO_LARGE' && observed.oversizedCoreBusinessRows === 0 && observed.oversizedCoreInboxRows === 0,
      'Core 大结果拒绝必须与业务事实及 Command receipt 一起回滚。',
    );
    assertProbe(observed.tamperedInputError === 'ZEUS_CONVERSATION_DISPATCH_COMMAND_INVALID', '公开正文摘要漂移必须在写入前失败关闭。');
    assertProbe(acceptedInvocations === 1 && acceptedReplay.replayed && acceptedFirst.result.answer === acceptedReplay.result.answer, 'accepted external replay 不得二次调用外部操作。');
    assertProbe(
      acceptedArtifact.contentByteLength > 1_000_000 && Buffer.byteLength(acceptedAttempt.receipt.evidenceJson, 'utf8') < 16_384 && acceptedArtifact.generationId === 'conversation-dispatch-command-result-v1',
      '大型 external 结果必须以有界 ArtifactRef replay。',
    );
    assertProbe(concurrentInvocations === 1 && concurrentResults.every((entry) => entry.result.status === 'resumed'), '同进程并发重复命令必须折叠成一次外部调用。');
    assertProbe(
      beforeWriteSnapshot?.attempts[0]?.outcome === 'failed_before_write' && beforeWriteSnapshot.attempts.length === 2 && beforeWriteRetry.result.status === 'accepted-after-safe-retry',
      'write marker 前失败必须允许稳定 attempt 2。',
    );
    assertProbe(
      explicitAttempt.receipt.outcome === 'explicitly_rejected' && (observed.explicit as { redacted: boolean }).redacted && (observed.explicit as { messageBytes: number }).messageBytes <= 2_048,
      '明确拒绝必须形成有界脱敏 explicitly_rejected receipt。',
    );
    assertProbe(observed.unknownError === 'ZEUS_CONVERSATION_DISPATCH_COMMAND_OUTCOME_UNKNOWN' && observed.unknownReplayError === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', 'write marker 后未知必须要求恢复并阻断自动重发。');
    assertProbe(unknownInvocations === 1 && unknownAttempt.receipt.outcome === 'outcome_unknown_after_write' && unknownAttempt.attempt.providerWriteStartedAt !== null, '未知结果必须保留 write marker 且不得二次写出。');
    assertProbe(structure.routeRegistrationCount === 15 && structure.commandTypeCount === 16 && structure.rendererCommandTypeCount === 16, '公开路由必须精确覆盖 15 个 registration 与 16 个 command type。');
    assertProbe(structure.rendererBuildsEnvelopeOnce && structure.rendererReconnectCache && structure.oldInlineRoutesRemoved, 'Renderer 必须一次构造 Envelope 并在重连复用，旧 inline mutation handler 必须删除。');
    assertProbe(structure.providerChildIdentityBound && structure.queueCoreHasNoExternalEffect, '父 Command 必须稳定绑定既有 Provider 子操作，纯 Core queue mutation 不得触发外部副作用。');
    assertProbe(observed.quickCheck === 'ok', '临时 SQLite quick_check 必须通过。');

    console.log(JSON.stringify({ status: 'passed', observed }, null, 2));
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

function now(): Date {
  return new Date((clockMs += 1_000));
}

function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  const text = value.replace(/\/secret\/conversation|token=probe/gu, '[REDACTED]');
  return { text, redacted: text !== value };
}

function commandRequest<TInput extends object>(input: {
  label: string;
  commandType: ConversationDispatchCommandType;
  scopeKind: 'product_conversation' | 'submission' | 'turn' | 'approval';
  scopeId: string;
  operationIdentity: string;
  input: TInput;
}): { commandId: string; body: ConversationDispatchMutationRequest<TInput> } {
  const commandId = `command_conversation_dispatch_probe_${input.label}`;
  const payload: ConversationDispatchCommandPayload = { operationIdentity: input.operationIdentity, inputSha256: conversationDispatchInputSha256(input.input) };
  const command: CommandEnvelope<ConversationDispatchCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'conversation-dispatch-command-probe' },
    scope: { kind: input.scopeKind, id: input.scopeId },
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: now().toISOString(),
    payload,
  };
  assertProbe(conversationDispatchInputSha256(input.input) === createInputSha256(input.input), 'probe 与产品必须使用相同 canonical input SHA-256。');
  return { commandId, body: { command, input: input.input } };
}

function externalRequest(application: ConversationDispatchCommandApplication, label: string) {
  const scopeId = `turn-${label}`;
  const externalOperationId = `provider-turn-interrupt:${scopeId}`;
  const request = commandRequest({
    label,
    commandType: conversationDispatchCommandTypes.turnInterrupt,
    scopeKind: 'turn',
    scopeId,
    operationIdentity: `conversation-dispatch-${label}-operation`,
    input: {},
  });
  return {
    parsed: application.parse<Record<string, never>>({ value: request.body, commandType: conversationDispatchCommandTypes.turnInterrupt, scopeKind: 'turn', scopeId }),
    externalOperationId,
  };
}

async function inspectStructure(): Promise<{
  routeRegistrationCount: number;
  commandTypeCount: number;
  rendererCommandTypeCount: number;
  rendererBuildsEnvelopeOnce: boolean;
  rendererReconnectCache: boolean;
  oldInlineRoutesRemoved: boolean;
  providerChildIdentityBound: boolean;
  queueCoreHasNoExternalEffect: boolean;
}> {
  const [application, routes, queueCore, rendererEnvelope, rendererClient, rendererApi, indexComposition, routeAssembly, conversationOperations, coordinator] = await Promise.all([
    readFile(join(repositoryRoot, 'packages/local-server/src/conversationDispatchCommandApplication.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'packages/local-server/src/conversationDispatchCommandRoutes.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'packages/local-server/src/conversationQueueCoreMutationApplication.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'apps/desktop/src/renderer/commandRequest.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/conversations/conversationDispatchCommandClient.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'apps/desktop/src/renderer/features/conversations/conversationApiClient.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'packages/local-server/src/index.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'packages/local-server/src/localServerPlatformRoutes.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'packages/local-server/src/conversationApplicationOperations.ts'), 'utf8'),
    readFile(join(repositoryRoot, 'packages/local-server/src/codexNativeConversationCoordinator.ts'), 'utf8'),
  ]);
  const composition = `${indexComposition}\n${routeAssembly}\n${conversationOperations}`;
  const routeRegistrationCount = routes.match(/\bserver\.(?:post|patch|delete)\s*\(/gu)?.length ?? 0;
  const commandTypeCount = application.match(/'conversation\.[a-z_.]+'/gu)?.filter((value) => !value.includes('conversation_dispatch_')).length ?? 0;
  const rendererCommandTypeCount = rendererClient.match(/'conversation\.[a-z_.]+'/gu)?.length ?? 0;
  const oldRoutes = [
    "server.post('/api/projects/:projectId/conversations/:conversationId/messages'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/side-chat'",
    "server.patch('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/retry'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/reroute'",
    "server.delete('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/queue/:submissionId/send-now'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/turns/:turnId/interrupt'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/requests/:requestId/respond'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/requests/:requestId/snooze'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/queue/resume'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/queue/recover'",
    "server.post('/api/projects/:projectId/conversations/:conversationId/queue/reorder'",
  ];
  return {
    routeRegistrationCount,
    commandTypeCount,
    rendererCommandTypeCount,
    rendererBuildsEnvelopeOnce:
      rendererClient.includes('createConversationDispatchCommandRequest(input)') &&
      rendererClient.includes('return createRendererCommandEnvelope({') &&
      rendererEnvelope.includes('payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 }') &&
      (rendererApi.match(/buildConversationDispatchCommandRequest\(\{/gu)?.length ?? 0) === 15,
    rendererReconnectCache:
      rendererClient.includes('const stableRequests = new Map<') &&
      rendererClient.includes('const maximumStableRequests = 256') &&
      rendererClient.includes('A reconnect identity cannot be reused with different conversation command input.') &&
      (rendererApi.match(/reconnectIdentity: input\.idempotencyKey/gu)?.length ?? 0) === 2,
    oldInlineRoutesRemoved: oldRoutes.every((marker) => !composition.includes(marker)) && composition.includes('registerConversationDispatchCommandRoutes({'),
    providerChildIdentityBound:
      composition.includes('acceptNativeConversationMessage(conversation, content, body, idempotencyKey, input.operationIdentity') &&
      composition.includes('idempotencyKey: input.operationIdentity') &&
      composition.includes('operationIdentity,') &&
      coordinator.includes('const submissionIdentity = input.operationIdentity ?? operationId()'),
    queueCoreHasNoExternalEffect: !['db.save(', 'publishRealtimeEvent(', 'codexNativeCoordinator', 'piNativeCoordinator', 'manager.', 'writeFile('].some((marker) => queueCore.includes(marker)),
  };
}

function requiredAttempt(deliveries: CommandDeliveryRepository, commandId: string) {
  const snapshot = deliveries.get(commandId);
  const attempt = snapshot?.attempts.at(-1);
  const receipt = attempt?.receipt;
  assertProbe(snapshot && attempt && receipt, `Command ${commandId} 必须存在耐久 attempt/receipt。`);
  return { snapshot, attempt, receipt };
}

function requireArtifactEvidence(evidenceJson: string): { sha256: string; contentSha256: string; contentByteLength: number; generationId: string } {
  const evidence = JSON.parse(evidenceJson) as { resultArtifact?: Record<string, unknown> };
  const artifact = evidence.resultArtifact;
  assertProbe(
    artifact && typeof artifact.sha256 === 'string' && typeof artifact.contentSha256 === 'string' && typeof artifact.contentByteLength === 'number' && typeof artifact.generationId === 'string',
    'accepted receipt 必须只引用完整 ArtifactRef evidence。',
  );
  return artifact as { sha256: string; contentSha256: string; contentByteLength: number; generationId: string };
}

function rowCount(db: { get<T>(sql: string): T | undefined }, table: string, where: string): number {
  return db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)?.count ?? -1;
}

function createInputSha256(value: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(value)).digest('hex');
}

function captureCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

async function captureAsyncCode(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (error) {
    return errorCode(error);
  }
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return error instanceof Error ? error.name : String(error);
}

function assertProbe(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
