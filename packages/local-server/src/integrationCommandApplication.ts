import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { ArtifactStore, CommandDeliveryRepository, CommandDeliveryStoreError, type ArtifactRef, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

export const integrationCommandTypes = {
  modelConnectionCreate: 'integration.model_connection.create',
  modelConnectionUpdate: 'integration.model_connection.update',
  modelConnectionDelete: 'integration.model_connection.delete',
  modelConnectionApiKeyClear: 'integration.model_connection.api_key.clear',
  modelConnectionModelsRefresh: 'integration.model_connection.models.refresh',
  modelConnectionDiagnose: 'integration.model_connection.diagnose',
  zentaoInstanceCreate: 'integration.zentao_instance.create',
  zentaoInstanceUpdate: 'integration.zentao_instance.update',
  zentaoInstanceDelete: 'integration.zentao_instance.delete',
  zentaoInstancePasswordClear: 'integration.zentao_instance.password.clear',
  zentaoInstanceVerify: 'integration.zentao_instance.verify',
  projectModelSelectionSave: 'settings.project_model_selection.save',
  telegramBotTokenPut: 'integration.telegram_bot_token.put',
  telegramBotTokenDelete: 'integration.telegram_bot_token.delete',
  externalApiKeyPut: 'integration.external_api_key.put',
  externalApiKeyDelete: 'integration.external_api_key.delete',
} as const;

export type IntegrationCommandType = (typeof integrationCommandTypes)[keyof typeof integrationCommandTypes];
export type IntegrationCommandScopeKind = Extract<CommandScopeKind, 'settings' | 'integration_account' | 'provider_configuration' | 'provider_account'>;
export type IntegrationCommandPayload = { operationIdentity: string; inputSha256: string };

export interface IntegrationCommandRequest<TInput extends object> {
  command: CommandEnvelope<IntegrationCommandPayload>;
  input: TInput;
}

export interface ParsedIntegrationCommand<TInput extends object> {
  command: CommandEnvelope<IntegrationCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface IntegrationCommandResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface PreparedExternal {
  state: 'prepared';
  parsed: ParsedIntegrationCommand<object>;
  outbox: CommandOutboxRecord;
}

interface ReplayedExternal {
  state: 'accepted_replay';
  parsed: ParsedIntegrationCommand<object>;
  outbox: CommandOutboxRecord;
  receipt: CommandDeliveryReceiptRecord;
}

interface ProbeIdentity {
  commandType: string;
  scopeKind: IntegrationCommandScopeKind;
  scopeId: string;
  inputSha256: string;
  operationIdentity: string;
}

interface ProbeReplay extends ProbeIdentity {
  serializedResult: string;
  expiresAtMs: number;
}

interface ActiveProbeIdentity extends ProbeIdentity {
  promise: Promise<IntegrationCommandResult<unknown>>;
}

export const integrationCommandRoutePolicy = {
  externalOperations: [
    'POST /api/model-connections',
    'PUT /api/model-connections/:connectionId',
    'DELETE /api/model-connections/:connectionId',
    'DELETE /api/model-connections/:connectionId/api-key',
    'POST /api/model-connections/:connectionId/models/refresh',
    'POST /api/zentao-instances',
    'PUT /api/zentao-instances/:instanceId',
    'DELETE /api/zentao-instances/:instanceId',
    'DELETE /api/zentao-instances/:instanceId/password',
    'PUT /api/security/secrets/telegram-bot-token',
    'DELETE /api/security/secrets/telegram-bot-token',
    'PUT /api/security/secrets/external-api-key',
    'DELETE /api/security/secrets/external-api-key',
  ],
  coreApplications: ['PUT /api/projects/:projectId/model-selection'],
  readOnlyExternalProbes: ['POST /api/model-connections/:connectionId/diagnose', 'POST /api/zentao-instances/:instanceId/verify'],
  probeReplay: { durable: false, maximumEntries: 128, ttlMs: 30_000, maximumResultBytes: 1024 * 1024 },
  secretPersistence: 'hash-only-command-envelope-and-non-secret-result-artifact',
  postWriteFailure: 'outcome_unknown_after_write',
  automaticRetryAfterUnknown: false,
} as const;

export class IntegrationCommandApplicationError extends Error {
  readonly name = 'IntegrationCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_INTEGRATION_COMMAND_INVALID' | 'ZEUS_INTEGRATION_COMMAND_RESULT_MISSING' | 'ZEUS_INTEGRATION_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN' | 'ZEUS_INTEGRATION_PROBE_CAPACITY_EXCEEDED',
    message: string,
    readonly statusCode: 400 | 409 | 429 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'integration-command-result-v1';
const maximumReplayResultBytes = 8 * 1024 * 1024;
const maximumCoreEvidenceBytes = 64 * 1024;
const maximumErrorMessageBytes = 2 * 1024;

/**
 * 凭据与模型配置的统一应用边界。外部写入先持久化 write marker；accepted 结果只以
 * 非敏感 ArtifactRef 进入回执。纯 Core 选择与 accepted receipt 共用同一耐久事务。
 */
export class IntegrationCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<IntegrationCommandResult<unknown>>>();
  private readonly activeProbes = new Map<string, ActiveProbeIdentity>();
  private readonly probeReplays = new Map<string, ProbeReplay>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
      maximumProbeEntries?: number;
      probeReplayTtlMs?: number;
    },
  ) {}

  parse<TInput extends object>(input: {
    value: unknown;
    commandType: IntegrationCommandType;
    scopeKind: IntegrationCommandScopeKind;
    expectedScopeId(parsed: { input: TInput; operationIdentity: string }): string;
  }): ParsedIntegrationCommand<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<IntegrationCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind) throw invalidCommand(`Expected ${input.scopeKind} command scope.`);
    if (command.expectedRevision !== null) throw invalidCommand('Integration commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = integrationCommandInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    if (command.scope.id !== input.expectedScopeId({ input: commandInput, operationIdentity })) {
      throw invalidCommand('Command scope does not match the addressed integration resource.');
    }
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedIntegrationCommand<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): IntegrationCommandResult<TResult> {
    let result: TResult | undefined;
    const evidence: Record<string, unknown> = {
      source: 'integration_core_application',
      commandType: input.parsed.command.commandType,
      operationIdentity: input.parsed.operationIdentity,
      result: null,
    };
    const delivery = this.options.deliveries.executeCoreApplication({
      envelope: input.parsed.command,
      requestSha256: input.parsed.inputSha256,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      operationIdentity: input.parsed.operationIdentity,
      occurredAt: this.options.now().toISOString(),
      evidence,
      mutateBusinessState: () => {
        result = input.mutateBusinessState();
        evidence.result = result;
        assertJsonBudget(evidence, maximumCoreEvidenceBytes, 'Core command receipt');
      },
    });
    const resolved = delivery.created ? result : readInlineResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return { commandId: delivery.inbox.commandId, operationIdentity: input.parsed.operationIdentity, replayed: !delivery.created, result: resolved };
  }

  replayAcceptedCore<TInput extends object, TResult>(input: { parsed: ParsedIntegrationCommand<TInput>; destinationId: string; resourceId: string }): IntegrationCommandResult<TResult> | undefined {
    const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
    if (latest?.destinationKind !== 'core_application' || latest.outcome !== 'accepted' || !latest.receipt) return undefined;
    return this.executeCore({
      ...input,
      mutateBusinessState: () => {
        throw new Error('Accepted Integration Core command replay must never execute its mutation.');
      },
    });
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedIntegrationCommand<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    sensitiveValues?: readonly string[];
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): void;
  }): Promise<IntegrationCommandResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<IntegrationCommandResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<IntegrationCommandResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedIntegrationCommand<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    sensitiveValues?: readonly string[];
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): void;
  }): Promise<IntegrationCommandResult<TResult>> {
    const preparation = this.prepareExternal({
      parsed: input.parsed,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      externalOperationId: input.externalOperationId,
    });
    if (preparation.state === 'accepted_replay') {
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: await this.readAcceptedResult<TResult>(preparation.receipt, input.parsed.command.commandType),
      };
    }

    let writeStarted = false;
    try {
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = await input.invoke();
      assertJsonBudget(result, maximumReplayResultBytes, 'Integration command result');
      const resultArtifact = await this.options.artifacts.putJson({
        value: result,
        owner: resultOwner(input.parsed.command.commandId),
        mimeType: 'application/vnd.zeus.integration-command-result+json',
        compression: 'gzip-v1',
        createdAt: this.options.now().toISOString(),
      });
      this.options.db.durableTransactionSync(() => {
        input.mutateAcceptedBusinessState(result);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence: acceptedEvidence(preparation.parsed, preparation.outbox.externalOperationId, resultArtifact),
          occurredAt: this.options.now().toISOString(),
        });
      });
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
    } catch (error) {
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'integration_external_operation',
              commandType: input.parsed.command.commandType,
              operationIdentity: input.parsed.operationIdentity,
              externalOperationId: preparation.outbox.externalOperationId,
              result: outcome,
              error: serializeError(error, this.options.redactSensitiveText, input.sensitiveValues),
            },
            occurredAt: this.options.now().toISOString(),
          });
        });
      } catch (receiptError) {
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Integration 外部操作与失败回执同时未能收口。');
      }
      if (writeStarted) throw outcomeUnknown(error, this.options.redactSensitiveText, input.sensitiveValues);
      throw error;
    }
  }

  /** 只读网络探针只在进程内短时去重，不写 Inbox/Outbox/Receipt。 */
  executeReadOnlyProbe<TInput extends object, TResult>(input: { parsed: ParsedIntegrationCommand<TInput>; invoke(): Promise<TResult> }): Promise<IntegrationCommandResult<TResult>> {
    this.pruneProbeReplays();
    const existing = this.probeReplays.get(input.parsed.command.commandId);
    if (existing) {
      assertSameProbeIdentity(existing, input.parsed);
      return Promise.resolve({
        commandId: input.parsed.command.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: JSON.parse(existing.serializedResult) as TResult,
      });
    }
    const active = this.activeProbes.get(input.parsed.command.commandId);
    if (active) {
      assertSameProbeIdentity(active, input.parsed);
      return active.promise as Promise<IntegrationCommandResult<TResult>>;
    }
    const maximumEntries = this.options.maximumProbeEntries ?? integrationCommandRoutePolicy.probeReplay.maximumEntries;
    if (this.activeProbes.size + this.probeReplays.size >= maximumEntries) {
      throw new IntegrationCommandApplicationError('ZEUS_INTEGRATION_PROBE_CAPACITY_EXCEEDED', '只读外部探针并发与重放容量已满，请稍后重试。', 429);
    }
    const execution = (async () => {
      const result = await input.invoke();
      const serializedResult = stringifyWithinBudget(result, integrationCommandRoutePolicy.probeReplay.maximumResultBytes, 'Integration read-only probe result');
      this.pruneProbeReplays();
      this.probeReplays.set(input.parsed.command.commandId, {
        commandType: input.parsed.command.commandType,
        scopeKind: input.parsed.command.scope.kind as IntegrationCommandScopeKind,
        scopeId: input.parsed.command.scope.id,
        inputSha256: input.parsed.inputSha256,
        operationIdentity: input.parsed.operationIdentity,
        serializedResult,
        expiresAtMs: this.options.now().getTime() + (this.options.probeReplayTtlMs ?? integrationCommandRoutePolicy.probeReplay.ttlMs),
      });
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
    })().finally(() => this.activeProbes.delete(input.parsed.command.commandId));
    this.activeProbes.set(input.parsed.command.commandId, {
      commandType: input.parsed.command.commandType,
      scopeKind: input.parsed.command.scope.kind as IntegrationCommandScopeKind,
      scopeId: input.parsed.command.scope.id,
      inputSha256: input.parsed.inputSha256,
      operationIdentity: input.parsed.operationIdentity,
      promise: execution as Promise<IntegrationCommandResult<unknown>>,
    });
    return execution;
  }

  probeSnapshot(): { active: number; replayEntries: number } {
    this.pruneProbeReplays();
    return { active: this.activeProbes.size, replayEntries: this.probeReplays.size };
  }

  private prepareExternal(input: { parsed: ParsedIntegrationCommand<object>; destinationId: string; resourceId: string; externalOperationId: string }): PreparedExternal | ReplayedExternal {
    try {
      const delivery = this.options.deliveries.acceptAndPrepare({
        envelope: input.parsed.command,
        requestSha256: input.parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: input.destinationId,
        resourceId: input.resourceId,
        externalOperationId: input.externalOperationId,
        occurredAt: this.options.now().toISOString(),
      });
      return { state: 'prepared', parsed: input.parsed, outbox: delivery.outbox };
    } catch (error) {
      if (!isCommandDeliveryError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
      if (!latest?.receipt || latest.outcome !== 'accepted') throw error;
      return { state: 'accepted_replay', parsed: input.parsed, outbox: latest, receipt: latest.receipt };
    }
  }

  private async readAcceptedResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): Promise<TResult> {
    try {
      const evidence = requireRecord(JSON.parse(receipt.evidenceJson), 'receipt.evidence');
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'integration_external_operation' || evidence.commandType !== commandType) throw new Error('Accepted Integration result identity mismatch.');
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted Integration result ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof IntegrationCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }

  private pruneProbeReplays(): void {
    const nowMs = this.options.now().getTime();
    for (const [commandId, replay] of this.probeReplays) if (replay.expiresAtMs <= nowMs) this.probeReplays.delete(commandId);
  }
}

export function integrationCommandInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function acceptedEvidence(parsed: ParsedIntegrationCommand<object>, externalOperationId: string | null, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'integration_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    resultArtifact: {
      sha256: artifact.sha256,
      contentSha256: artifact.contentSha256,
      contentByteLength: artifact.contentByteLength,
      generationId: resultArtifactGeneration,
    },
  };
}

function resultOwner(commandId: string) {
  return { kind: 'command_delivery_result', id: commandId, generationId: resultArtifactGeneration } as const;
}

function readInlineResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { source?: unknown; commandType?: unknown; result?: TResult | null };
    if (evidence.source !== 'integration_core_application' || evidence.commandType !== commandType || evidence.result === undefined || evidence.result === null) throw missingResult(receipt.commandId);
    return evidence.result;
  } catch (error) {
    if (error instanceof IntegrationCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
}

function assertSameProbeIdentity(replay: ProbeIdentity, parsed: ParsedIntegrationCommand<object>): void {
  if (
    replay.commandType === parsed.command.commandType &&
    replay.scopeKind === parsed.command.scope.kind &&
    replay.scopeId === parsed.command.scope.id &&
    replay.inputSha256 === parsed.inputSha256 &&
    replay.operationIdentity === parsed.operationIdentity
  )
    return;
  throw invalidCommand('Read-only probe command identity was reused with different input or scope.');
}

function assertJsonBudget(value: unknown, maximumBytes: number, label: string): void {
  stringifyWithinBudget(value, maximumBytes, label);
}

function stringifyWithinBudget(value: unknown, maximumBytes: number, label: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new IntegrationCommandApplicationError('ZEUS_INTEGRATION_COMMAND_RESULT_TOO_LARGE', `${label} exceeds the ${maximumBytes}-byte replay budget.`, 500);
  }
  return serialized;
}

const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }, sensitiveValues: readonly string[] = []): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText, sensitiveValues) };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText, sensitiveValues) };
}

function invalidCommand(message: string): IntegrationCommandApplicationError {
  return new IntegrationCommandApplicationError('ZEUS_INTEGRATION_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): IntegrationCommandApplicationError {
  return new IntegrationCommandApplicationError('ZEUS_INTEGRATION_COMMAND_RESULT_MISSING', `Accepted Integration command ${commandId} is missing its immutable result.`, 500);
}

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }, sensitiveValues: readonly string[] = []): IntegrationCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText, sensitiveValues);
  return new IntegrationCommandApplicationError('ZEUS_INTEGRATION_COMMAND_OUTCOME_UNKNOWN', `Integration command result is unknown after write started: ${detail}`, 409, true);
}

function boundedErrorMessage(value: string, redactSensitiveText: (value: string) => { text: string }, sensitiveValues: readonly string[] = []): string {
  const scrubbed = sensitiveValues.reduce((current, secret) => (secret ? current.replaceAll(secret, '[REDACTED]') : current), value);
  const redacted = redactSensitiveText(scrubbed).text;
  const bytes = Buffer.from(redacted, 'utf8');
  if (bytes.byteLength <= maximumErrorMessageBytes) return redacted;
  return `${bytes
    .subarray(0, maximumErrorMessageBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}

function boundedScalar(value: string | number): string | number {
  return typeof value === 'number' ? value : value.slice(0, 128);
}

function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

export function integrationCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof IntegrationCommandApplicationError) {
    return { statusCode: error.statusCode, payload: { error: error.code, message: error.message, ...(error.recoveryRequired ? { recoveryRequired: true as const } : {}) } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
