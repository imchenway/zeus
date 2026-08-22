import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { ArtifactStore, CommandDeliveryRepository, CommandDeliveryStoreError, type ArtifactRef, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export const settingsCommandTypes = {
  projectDatabaseSecretPut: 'settings.project_database_secret.put',
  projectDatabaseSecretDelete: 'settings.project_database_secret.delete',
  projectConfigPut: 'settings.project_config.put',
  runtimeSettingsPut: 'settings.runtime.put',
  appShellSettingsPut: 'settings.app_shell.put',
  projectionCacheClear: 'settings.projection_cache.clear',
  settingsImport: 'settings.import',
  dataImport: 'settings.business_data.import',
  codeMapSettingsPut: 'settings.code_map.put',
} as const;

export type SettingsCommandType = (typeof settingsCommandTypes)[keyof typeof settingsCommandTypes];
export type SettingsCommandScopeKind = Extract<CommandScopeKind, 'project' | 'settings'>;
export type SettingsCommandPayload = { operationIdentity: string; inputSha256: string };

export interface SettingsCommandRequest<TInput extends object> {
  command: CommandEnvelope<SettingsCommandPayload>;
  input: TInput;
}

export interface ParsedSettingsCommand<TInput extends object> {
  command: CommandEnvelope<SettingsCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface SettingsCommandResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface PreparedExternal {
  state: 'prepared';
  parsed: ParsedSettingsCommand<object>;
  outbox: CommandOutboxRecord;
}

interface ReplayedExternal {
  state: 'accepted_replay';
  parsed: ParsedSettingsCommand<object>;
  outbox: CommandOutboxRecord;
  receipt: CommandDeliveryReceiptRecord;
}

export const settingsCommandRoutePolicy = {
  coreApplications: ['PUT /api/projects/:projectId/config', 'PUT /api/settings/app-shell', 'PUT /api/code-map/settings'],
  externalOperations: [
    'PUT /api/projects/:projectId/database/secret',
    'DELETE /api/projects/:projectId/database/secret',
    'PUT /api/runtime/settings',
    'POST /api/settings/code-graph-cache/clear',
    'POST /api/settings/cache/clear',
    'POST /api/settings/import',
    'POST /api/data/import',
  ],
  importBodyBudgets: { settingsBytes: 1024 * 1024, businessDataBytes: 32 * 1024 * 1024 },
  runtimeRetentionFact: 'runtime.settings.logRetentionDays',
  runtimeRetentionDerivedOperation: 'rebuildable_runtime_log_retention',
  projectionCacheFact: 'app.shell.settings.lastCacheClearAt',
  projectionCacheDerivedOperation: 'rebuildable_projection_database_cache',
  secretPersistence: 'hash-only-command-envelope-and-non-secret-result-artifact',
  postWriteFailure: 'outcome_unknown_after_write',
  automaticRetryAfterUnknown: false,
} as const;

export class SettingsCommandApplicationError extends Error {
  readonly name = 'SettingsCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_SETTINGS_COMMAND_INVALID' | 'ZEUS_SETTINGS_COMMAND_RESULT_MISSING' | 'ZEUS_SETTINGS_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_SETTINGS_COMMAND_OUTCOME_UNKNOWN' | 'ZEUS_SETTINGS_COMMAND_EXPLICITLY_REJECTED',
    message: string,
    readonly statusCode: 400 | 409 | 413 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

/** 外部端口明确证明没有产生目标写入时，才能使用 explicitly_rejected。 */
export class SettingsExternalOperationRejectedError extends Error {
  readonly name = 'SettingsExternalOperationRejectedError';

  constructor(
    message: string,
    readonly code = 'ZEUS_SETTINGS_EXTERNAL_OPERATION_REJECTED',
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'settings-command-result-v1';
const importArtifactGeneration = 'settings-command-import-v1';
const maximumReplayResultBytes = 8 * 1024 * 1024;
const maximumCoreEvidenceBytes = 1024 * 1024;
const maximumErrorMessageBytes = 2 * 1024;

/**
 * 本地设置的统一命令边界。Core mutation 与 accepted receipt 共用一个 SQLite
 * 事务；Keychain、文件证据、日志保留和投影清理都先落稳定 write marker。
 */
export class SettingsCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<SettingsCommandResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: SettingsCommandType; scopeKind: SettingsCommandScopeKind; expectedScopeId(parsed: { input: TInput; operationIdentity: string }): string }): ParsedSettingsCommand<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<SettingsCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind) throw invalidCommand(`Expected ${input.scopeKind} command scope.`);
    if (command.expectedRevision !== null) throw invalidCommand('Settings commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = settingsCommandInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    if (command.scope.id !== input.expectedScopeId({ input: commandInput, operationIdentity })) throw invalidCommand('Command scope does not match the addressed settings resource.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedSettingsCommand<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): SettingsCommandResult<TResult> {
    let result: TResult | undefined;
    const evidence: Record<string, unknown> = {
      source: 'settings_core_application',
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
        assertJsonBudget(evidence, maximumCoreEvidenceBytes, 'Settings Core command receipt');
      },
    });
    const resolved = delivery.created ? result : readInlineResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return { commandId: delivery.inbox.commandId, operationIdentity: input.parsed.operationIdentity, replayed: !delivery.created, result: resolved };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedSettingsCommand<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    sensitiveValues?: readonly string[];
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): void;
  }): Promise<SettingsCommandResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<SettingsCommandResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<SettingsCommandResult<unknown>>);
    return execution;
  }

  async stageImportArtifact(input: { parsed: ParsedSettingsCommand<object>; value: unknown; kind: 'settings' | 'business_data' }): Promise<ArtifactRef> {
    const maximumBytes = input.kind === 'settings' ? settingsCommandRoutePolicy.importBodyBudgets.settingsBytes : settingsCommandRoutePolicy.importBodyBudgets.businessDataBytes;
    assertJsonBudget(input.value, maximumBytes, `${input.kind} import body`);
    return this.options.artifacts.putJson({
      value: input.value,
      owner: { kind: 'settings_command_import', id: input.parsed.command.commandId, generationId: importArtifactGeneration },
      mimeType: input.kind === 'settings' ? 'application/vnd.zeus.settings-import+json' : 'application/vnd.zeus.business-data-import+json',
      compression: 'gzip-v1',
      createdAt: this.options.now().toISOString(),
    });
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedSettingsCommand<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    sensitiveValues?: readonly string[];
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): void;
  }): Promise<SettingsCommandResult<TResult>> {
    const preparation = this.prepareExternal({ parsed: input.parsed, destinationId: input.destinationId, resourceId: input.resourceId, externalOperationId: input.externalOperationId });
    if (preparation.state === 'accepted_replay') {
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: await this.readAcceptedResult<TResult>(preparation.receipt, input.parsed.command.commandType),
      };
    }

    try {
      await input.beforeWrite?.();
    } catch (error) {
      this.recordFailure(preparation, 'failed_before_write', error, input.sensitiveValues);
      throw error;
    }

    this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
    try {
      const result = await input.invoke();
      assertJsonBudget(result, maximumReplayResultBytes, 'Settings command result');
      const resultArtifact = await this.options.artifacts.putJson({
        value: result,
        owner: resultOwner(input.parsed.command.commandId),
        mimeType: 'application/vnd.zeus.settings-command-result+json',
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
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted' | 'failed_before_write'> = error instanceof SettingsExternalOperationRejectedError ? 'explicitly_rejected' : 'outcome_unknown_after_write';
      this.recordFailure(preparation, outcome, error, input.sensitiveValues);
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText, input.sensitiveValues);
      throw new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_EXPLICITLY_REJECTED', boundedErrorMessage(error instanceof Error ? error.message : String(error), this.options.redactSensitiveText, input.sensitiveValues), 409);
    }
  }

  private prepareExternal(input: { parsed: ParsedSettingsCommand<object>; destinationId: string; resourceId: string; externalOperationId: string }): PreparedExternal | ReplayedExternal {
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

  private recordFailure(preparation: PreparedExternal, outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown, sensitiveValues: readonly string[] = []): void {
    try {
      this.options.db.durableTransactionSync(() => {
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome,
          evidence: {
            source: 'settings_external_operation',
            commandType: preparation.parsed.command.commandType,
            operationIdentity: preparation.parsed.operationIdentity,
            externalOperationId: preparation.outbox.externalOperationId,
            result: outcome,
            error: serializeError(error, this.options.redactSensitiveText, sensitiveValues),
          },
          occurredAt: this.options.now().toISOString(),
        });
      });
    } catch (receiptError) {
      if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], '设置外部操作与失败回执同时未能收口。');
    }
  }

  private async readAcceptedResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): Promise<TResult> {
    try {
      const evidence = requireRecord(JSON.parse(receipt.evidenceJson), 'receipt.evidence');
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'settings_external_operation' || evidence.commandType !== commandType) throw new Error('Accepted Settings result identity mismatch.');
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration || stored.ref.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted Settings result ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof SettingsCommandApplicationError) throw error;
      throw missingResult(receipt.commandId);
    }
  }
}

export function settingsCommandInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

export function settingsCommandHttpError(error: unknown, redactSensitiveText: (value: string) => { text: string }): { statusCode: number; body: Record<string, unknown> } {
  if (error instanceof SettingsCommandApplicationError) {
    return { statusCode: error.statusCode, body: { error: error.code, message: boundedErrorMessage(error.message, redactSensitiveText), recoveryRequired: error.recoveryRequired } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, body: { error: error.code, message: boundedErrorMessage(error.message, redactSensitiveText), details: error.details } };
  if (isCommandDeliveryError(error)) {
    const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
    return { statusCode: recoveryRequired ? 409 : 400, body: { error: error.code, message: boundedErrorMessage(error.message, redactSensitiveText), recoveryRequired } };
  }
  return { statusCode: 500, body: { error: 'ZEUS_SETTINGS_COMMAND_FAILED', message: boundedErrorMessage(error instanceof Error ? error.message : String(error), redactSensitiveText) } };
}

function acceptedEvidence(parsed: ParsedSettingsCommand<object>, externalOperationId: string | null, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'settings_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    resultArtifact: { sha256: artifact.sha256, contentSha256: artifact.contentSha256, contentByteLength: artifact.contentByteLength, generationId: resultArtifactGeneration },
  };
}

function resultOwner(commandId: string) {
  return { kind: 'command_delivery_result', id: commandId, generationId: resultArtifactGeneration } as const;
}

function readInlineResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { source?: unknown; commandType?: unknown; result?: TResult | null };
    if (evidence.source !== 'settings_core_application' || evidence.commandType !== commandType || evidence.result === undefined || evidence.result === null) throw missingResult(receipt.commandId);
    return evidence.result;
  } catch (error) {
    if (error instanceof SettingsCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
}

function assertJsonBudget(value: unknown, maximumBytes: number, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maximumBytes) throw new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_RESULT_TOO_LARGE', `${label} exceeds the ${maximumBytes}-byte budget.`, 413);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCommand(`${field} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidCommand(`${field} must be a plain object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], commandType: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index])) return;
  throw invalidCommand(`${commandType} must contain exactly: ${normalizedExpected.join(', ')}.`);
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512 || Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127))
    throw invalidCommand(`${field} is invalid.`);
  return value;
}

function validSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256.`);
  return value;
}

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }, sensitiveValues: readonly string[] = []): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText, sensitiveValues) };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText, sensitiveValues) };
}

function invalidCommand(message: string): SettingsCommandApplicationError {
  return new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): SettingsCommandApplicationError {
  return new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_RESULT_MISSING', `Accepted Settings command ${commandId} is missing its immutable result.`, 500);
}

function outcomeUnknown(cause: unknown, redactSensitiveText: (value: string) => { text: string }, sensitiveValues: readonly string[] = []): SettingsCommandApplicationError {
  const detail = boundedErrorMessage(cause instanceof Error ? cause.message : String(cause), redactSensitiveText, sensitiveValues);
  return new SettingsCommandApplicationError('ZEUS_SETTINGS_COMMAND_OUTCOME_UNKNOWN', `Settings command result is unknown after write started: ${detail}`, 409, true);
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
