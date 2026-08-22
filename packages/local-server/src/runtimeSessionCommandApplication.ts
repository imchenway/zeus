import { createHash, randomUUID } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { CommandDeliveryRepository, CommandDeliveryStoreError, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export const runtimeSessionCommandTypes = {
  confirmationCreate: 'runtime.confirmation.create',
  confirmationConfirm: 'runtime.confirmation.confirm',
  confirmationReject: 'runtime.confirmation.reject',
  sessionStart: 'runtime.session.start',
  sessionInterrupt: 'runtime.session.interrupt',
  sessionStop: 'runtime.session.stop',
  sessionSummaryGenerate: 'runtime.session.summary.generate',
  sessionFavoriteSet: 'runtime.session.favorite.set',
  sessionArchive: 'runtime.session.archive',
  sessionRestore: 'runtime.session.restore',
  sessionTaskCreate: 'runtime.session.task.create',
  sessionDelete: 'runtime.session.delete',
} as const;

export type RuntimeSessionCommandType = (typeof runtimeSessionCommandTypes)[keyof typeof runtimeSessionCommandTypes];
export type RuntimeSessionCommandPayload = { operationIdentity: string; inputSha256: string };

export interface RuntimeSessionMutationRequest<TInput extends object> {
  command: CommandEnvelope<RuntimeSessionCommandPayload>;
  input: TInput;
}

export interface ParsedRuntimeSessionMutation<TInput extends object> {
  command: CommandEnvelope<RuntimeSessionCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface RuntimeSessionMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

interface PreparedRuntimeExternal {
  state: 'prepared';
  parsed: ParsedRuntimeSessionMutation<object>;
  outbox: CommandOutboxRecord;
}

interface ReplayedRuntimeExternal<TResult> {
  state: 'accepted_replay';
  parsed: ParsedRuntimeSessionMutation<object>;
  outbox: CommandOutboxRecord;
  result: TResult;
}

type RuntimeExternalPreparation<TResult> = PreparedRuntimeExternal | ReplayedRuntimeExternal<TResult>;

export class RuntimeSessionCommandApplicationError extends Error {
  readonly name = 'RuntimeSessionCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_RUNTIME_COMMAND_INVALID' | 'ZEUS_RUNTIME_COMMAND_RESULT_MISSING',
    message: string,
    readonly statusCode: 400 | 409 | 500,
  ) {
    super(message);
  }
}

/** Runtime 的耐久命令只在账本中保存输入摘要；shell 正文和终端输入不得复制进 Inbox。 */
export class RuntimeSessionCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<RuntimeSessionMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: {
    value: unknown;
    commandType: RuntimeSessionCommandType;
    scopeKind: Extract<CommandScopeKind, 'approval' | 'runtime_segment'>;
    expectedScopeId: (parsed: { input: TInput; operationIdentity: string }) => string;
  }): ParsedRuntimeSessionMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<RuntimeSessionCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind) throw invalidCommand(`Expected ${input.scopeKind} command scope.`);
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = runtimeSessionInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    if (command.scope.id !== input.expectedScopeId({ input: commandInput, operationIdentity })) throw invalidCommand('Command scope does not match the addressed Runtime resource.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedRuntimeSessionMutation<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): RuntimeSessionMutationResult<TResult> {
    let result: TResult | undefined;
    const evidence: RuntimeResultEvidence<TResult> = {
      source: 'runtime_session_application',
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
        evidence.result = boundedReplayResult(result, input.parsed.command.commandId);
      },
    });
    const resolved = delivery.created ? result : readRuntimeResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return { commandId: delivery.inbox.commandId, operationIdentity: input.parsed.operationIdentity, replayed: !delivery.created, result: resolved };
  }

  replayAcceptedCore<TInput extends object, TResult>(input: { parsed: ParsedRuntimeSessionMutation<TInput>; destinationId: string; resourceId: string }): RuntimeSessionMutationResult<TResult> | undefined {
    const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
    if (latest?.destinationKind !== 'core_application' || latest.outcome !== 'accepted' || !latest.receipt) return undefined;
    return this.executeCore({
      ...input,
      mutateBusinessState: () => {
        throw new Error('Accepted Runtime Core command replay must never execute its mutation.');
      },
    });
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedRuntimeSessionMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    mutatePreparedBusinessState?(): void;
    /** 仍处于可安全重试阶段的最后检查；通过后才写 durable write marker。 */
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): TResult;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<RuntimeSessionMutationResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<RuntimeSessionMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<RuntimeSessionMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedRuntimeSessionMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    mutatePreparedBusinessState?(): void;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): TResult;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<RuntimeSessionMutationResult<TResult>> {
    const preparation = this.prepareExternal<TResult>({
      parsed: input.parsed,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      externalOperationId: input.externalOperationId,
      mutatePreparedBusinessState: input.mutatePreparedBusinessState,
    });
    if (preparation.state === 'accepted_replay') {
      return { commandId: preparation.outbox.commandId, operationIdentity: input.parsed.operationIdentity, replayed: true, result: preparation.result };
    }

    let writeStarted = false;
    try {
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const invoked = await input.invoke();
      let result: TResult | undefined;
      this.options.db.durableTransactionSync(() => {
        result = input.mutateAcceptedBusinessState(invoked);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence: externalEvidence(preparation.parsed, preparation.outbox.externalOperationId, result),
          occurredAt: this.options.now().toISOString(),
        });
      });
      if (result === undefined) throw missingResult(input.parsed.command.commandId);
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
    } catch (error) {
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = writeStarted && input.isExplicitRejection?.(error) ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          input.mutateFailureBusinessState?.(outcome, error);
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'runtime_session_external_operation',
              commandType: input.parsed.command.commandType,
              operationIdentity: input.parsed.operationIdentity,
              externalOperationId: preparation.outbox.externalOperationId,
              result: outcome,
              error: serializeError(error, this.options.redactSensitiveText),
            },
            occurredAt: this.options.now().toISOString(),
          });
        });
      } catch (receiptError) {
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Runtime 外部操作与失败回执同时未能收口。');
      }
      throw error;
    }
  }

  private prepareExternal<TResult>(input: { parsed: ParsedRuntimeSessionMutation<object>; destinationId: string; resourceId: string; externalOperationId: string; mutatePreparedBusinessState?(): void }): RuntimeExternalPreparation<TResult> {
    try {
      const delivery = this.options.deliveries.acceptAndPrepare({
        envelope: input.parsed.command,
        requestSha256: input.parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: input.destinationId,
        resourceId: input.resourceId,
        externalOperationId: input.externalOperationId,
        occurredAt: this.options.now().toISOString(),
        mutateBusinessState: input.mutatePreparedBusinessState,
      });
      return { state: 'prepared', parsed: input.parsed, outbox: delivery.outbox };
    } catch (error) {
      if (!isCommandDeliveryStoreError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') throw error;
      const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
      if (!latest?.receipt || latest.outcome !== 'accepted') throw error;
      return { state: 'accepted_replay', parsed: input.parsed, outbox: latest, result: readRuntimeResult<TResult>(latest.receipt, input.parsed.command.commandType) };
    }
  }
}

export interface RuntimeEphemeralCapability {
  leaseId: string;
  clientId: string;
  sessionId: string;
  nextSequence: number;
  expiresAt: string;
}

interface RuntimeEphemeralReplayRecord {
  inputSha256: string;
  operationIdentity: string;
  result: unknown;
  expiresAtMs: number;
}

/** 安全确认等进程内能力用稳定 Command 身份做有界 replay，但不伪造耐久 Inbox/receipt。 */
export class RuntimeBoundedEphemeralReplayService {
  private readonly records = new Map<string, RuntimeEphemeralReplayRecord>();

  constructor(
    private readonly options: {
      nowMs(): number;
      ttlMs?: number;
      maximumRecords?: number;
    },
  ) {}

  execute<TInput extends object, TResult>(parsed: ParsedRuntimeSessionMutation<TInput>, invoke: () => TResult): RuntimeSessionMutationResult<TResult> {
    const replay = this.replay<TInput, TResult>(parsed);
    if (replay) return replay;
    const nowMs = this.options.nowMs();
    const result = invoke();
    this.records.set(parsed.command.commandId, {
      inputSha256: parsed.inputSha256,
      operationIdentity: parsed.operationIdentity,
      result: cloneReplayResult(result),
      expiresAtMs: nowMs + (this.options.ttlMs ?? 10 * 60_000),
    });
    while (this.records.size > (this.options.maximumRecords ?? 512)) this.records.delete(this.records.keys().next().value as string);
    return { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, replayed: false, result };
  }

  replay<TInput extends object, TResult>(parsed: ParsedRuntimeSessionMutation<TInput>): RuntimeSessionMutationResult<TResult> | undefined {
    this.prune(this.options.nowMs());
    const existing = this.records.get(parsed.command.commandId);
    if (existing) {
      if (existing.inputSha256 !== parsed.inputSha256 || existing.operationIdentity !== parsed.operationIdentity) {
        throw new RuntimeEphemeralCapabilityError('ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_CONFLICT', 'Runtime ephemeral request identity was reused with different input.', 409);
      }
      return {
        commandId: parsed.command.commandId,
        operationIdentity: parsed.operationIdentity,
        replayed: true,
        result: cloneReplayResult(existing.result) as TResult,
      };
    }
    return undefined;
  }

  private prune(nowMs: number): void {
    for (const [commandId, record] of this.records) if (record.expiresAtMs <= nowMs) this.records.delete(commandId);
  }
}

export interface RuntimeEphemeralRequest<TInput extends object> {
  capability: { leaseId: string; clientId: string; sequence: number };
  input: TInput;
}

interface RuntimeEphemeralLeaseState {
  leaseId: string;
  clientId: string;
  sessionId: string;
  expiresAtMs: number;
  lastSequence: number;
  recent: Map<number, { inputSha256: string; result: unknown }>;
}

export class RuntimeEphemeralCapabilityError extends Error {
  readonly name = 'RuntimeEphemeralCapabilityError';

  constructor(
    readonly code: 'ZEUS_RUNTIME_EPHEMERAL_INVALID' | 'ZEUS_RUNTIME_EPHEMERAL_LEASE_REQUIRED' | 'ZEUS_RUNTIME_EPHEMERAL_LEASE_EXPIRED' | 'ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_GAP' | 'ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_CONFLICT',
    message: string,
    readonly statusCode: 400 | 409,
  ) {
    super(message);
  }
}

/** 高频 input/resize 只使用进程内 lease 与有界去重，不为每个按键或尺寸变化同步提交 WAL。 */
export class RuntimeEphemeralCapabilityService {
  private readonly leases = new Map<string, RuntimeEphemeralLeaseState>();

  constructor(
    private readonly options: {
      nowMs(): number;
      leaseTtlMs?: number;
      maximumLeases?: number;
      maximumRecentResults?: number;
    },
  ) {}

  issue(sessionId: string, value: unknown): RuntimeEphemeralCapability {
    const body = requireRecord(value, 'Body');
    assertExactKeys(body, ['clientId'], 'runtime.ephemeral.capability.issue');
    const clientId = boundedIdentity(body.clientId, 'clientId');
    const nowMs = this.options.nowMs();
    this.prune(nowMs);
    const existing = this.leases.get(sessionId);
    if (existing && existing.clientId === clientId && existing.expiresAtMs > nowMs) return snapshotLease(existing);
    const lease: RuntimeEphemeralLeaseState = {
      leaseId: `runtime-lease-${randomUUID()}`,
      clientId,
      sessionId,
      expiresAtMs: nowMs + (this.options.leaseTtlMs ?? 60_000),
      lastSequence: 0,
      recent: new Map(),
    };
    this.leases.set(sessionId, lease);
    this.trimLeases();
    return snapshotLease(lease);
  }

  execute<TInput extends object, TResult>(input: { sessionId: string; kind: 'input' | 'resize'; value: unknown; invoke(value: TInput): TResult }): { result: TResult; replayed: boolean } {
    const body = requireRecord(input.value, 'Body');
    assertExactKeys(body, ['capability', 'input'], `runtime.ephemeral.${input.kind}`);
    const capability = requireRecord(body.capability, 'Body.capability');
    assertExactKeys(capability, ['clientId', 'leaseId', 'sequence'], `runtime.ephemeral.${input.kind}`);
    const leaseId = boundedIdentity(capability.leaseId, 'capability.leaseId');
    const clientId = boundedIdentity(capability.clientId, 'capability.clientId');
    const sequence = positiveSequence(capability.sequence);
    const value = requireRecord(body.input, 'Body.input') as TInput;
    const lease = this.leases.get(input.sessionId);
    if (!lease || lease.leaseId !== leaseId || lease.clientId !== clientId) {
      throw new RuntimeEphemeralCapabilityError('ZEUS_RUNTIME_EPHEMERAL_LEASE_REQUIRED', 'Runtime ephemeral lease is missing or no longer owns this session.', 409);
    }
    const nowMs = this.options.nowMs();
    if (lease.expiresAtMs <= nowMs) {
      this.leases.delete(input.sessionId);
      throw new RuntimeEphemeralCapabilityError('ZEUS_RUNTIME_EPHEMERAL_LEASE_EXPIRED', 'Runtime ephemeral lease expired before the operation was accepted.', 409);
    }
    const inputSha256 = runtimeSessionInputSha256({ kind: input.kind, input: value });
    const replay = lease.recent.get(sequence);
    if (replay) {
      if (replay.inputSha256 !== inputSha256) throw new RuntimeEphemeralCapabilityError('ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_CONFLICT', 'Runtime ephemeral sequence was reused with different input.', 409);
      return { result: replay.result as TResult, replayed: true };
    }
    if (sequence !== lease.lastSequence + 1) {
      throw new RuntimeEphemeralCapabilityError('ZEUS_RUNTIME_EPHEMERAL_SEQUENCE_GAP', `Runtime ephemeral sequence must be ${lease.lastSequence + 1}.`, 409);
    }
    const result = input.invoke(value);
    lease.lastSequence = sequence;
    lease.expiresAtMs = nowMs + (this.options.leaseTtlMs ?? 60_000);
    lease.recent.set(sequence, { inputSha256, result });
    while (lease.recent.size > (this.options.maximumRecentResults ?? 64)) lease.recent.delete(lease.recent.keys().next().value as number);
    return { result, replayed: false };
  }

  private prune(nowMs: number): void {
    for (const [sessionId, lease] of this.leases) if (lease.expiresAtMs <= nowMs) this.leases.delete(sessionId);
  }

  private trimLeases(): void {
    while (this.leases.size > (this.options.maximumLeases ?? 128)) this.leases.delete(this.leases.keys().next().value as string);
  }
}

interface RuntimeResultEvidence<TResult> {
  source: 'runtime_session_application';
  commandType: string;
  operationIdentity: string;
  result: TResult | null;
}

export function runtimeSessionInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function externalEvidence<TResult>(parsed: ParsedRuntimeSessionMutation<object>, externalOperationId: string | null, result: TResult): Record<string, unknown> {
  return {
    source: 'runtime_session_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    result: boundedReplayResult(result, parsed.command.commandId),
  };
}

function readRuntimeResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { source?: unknown; commandType?: unknown; result?: TResult | null };
    if ((evidence.source !== 'runtime_session_application' && evidence.source !== 'runtime_session_external_operation') || evidence.commandType !== commandType || evidence.result === undefined || evidence.result === null) {
      throw missingResult(receipt.commandId);
    }
    return evidence.result;
  } catch (error) {
    if (error instanceof RuntimeSessionCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
}

function snapshotLease(lease: RuntimeEphemeralLeaseState): RuntimeEphemeralCapability {
  return { leaseId: lease.leaseId, clientId: lease.clientId, sessionId: lease.sessionId, nextSequence: lease.lastSequence + 1, expiresAt: new Date(lease.expiresAtMs).toISOString() };
}

function cloneReplayResult<TResult>(value: TResult): TResult {
  return JSON.parse(JSON.stringify(value)) as TResult;
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
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 512 || Array.from(value).some((character) => (character.codePointAt(0) ?? 0) <= 31 || character.codePointAt(0) === 127)) {
    throw invalidCommand(`${field} is invalid.`);
  }
  return value;
}

function validSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256.`);
  return value;
}

function positiveSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new RuntimeEphemeralCapabilityError('ZEUS_RUNTIME_EPHEMERAL_INVALID', 'Runtime ephemeral sequence must be a positive safe integer.', 400);
  return Number(value);
}

const maximumReplayResultBytes = 64 * 1024;
const maximumErrorMessageBytes = 2 * 1024;

function boundedReplayResult<TResult>(result: TResult, commandId: string): TResult {
  const json = JSON.stringify(result);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maximumReplayResultBytes) {
    throw new RuntimeSessionCommandApplicationError('ZEUS_RUNTIME_COMMAND_RESULT_MISSING', `Runtime command ${commandId} result exceeds the bounded inline replay budget; use an ArtifactRef.`, 500);
  }
  return JSON.parse(json) as TResult;
}

function serializeError(error: unknown, redactSensitiveText: (value: string) => { text: string }): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? boundedScalar(error.code) : null;
    return { code, name: boundedScalar(error.name), message: boundedErrorMessage(error.message, redactSensitiveText) };
  }
  return { code: null, name: boundedScalar(typeof error), message: boundedErrorMessage(String(error), redactSensitiveText) };
}

function boundedErrorMessage(value: string, redactSensitiveText: (value: string) => { text: string }): string {
  const redacted = redactSensitiveText(value).text;
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

function invalidCommand(message: string): RuntimeSessionCommandApplicationError {
  return new RuntimeSessionCommandApplicationError('ZEUS_RUNTIME_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): RuntimeSessionCommandApplicationError {
  return new RuntimeSessionCommandApplicationError('ZEUS_RUNTIME_COMMAND_RESULT_MISSING', `Accepted Runtime command ${commandId} is missing its immutable result.`, 500);
}

function isCommandDeliveryStoreError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryStoreError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

export function runtimeSessionCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof RuntimeSessionCommandApplicationError || error instanceof RuntimeEphemeralCapabilityError) return { statusCode: error.statusCode, payload: { error: error.code, message: error.message } };
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryStoreError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}
