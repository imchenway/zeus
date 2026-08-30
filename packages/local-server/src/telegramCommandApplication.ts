import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope } from '@zeus/shared';
import { CommandDeliveryRepository, CommandDeliveryStoreError, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export const telegramCommandTypes = {
  securityReset: 'security.reset',
  notificationSettingsUpdate: 'telegram.notification_settings.update',
  connectionTest: 'telegram.connection.test',
  securitySettingsUpdate: 'telegram.security_settings.update',
  dispatchPreview: 'telegram.dispatch_preview',
  settingsUpdate: 'telegram.settings.update',
  pollingStart: 'telegram.polling.start',
  pollingStop: 'telegram.polling.stop',
  pollingOnce: 'telegram.polling.poll_once',
  imConnectionCreate: 'im.telegram.connection.create',
  imConnectionRepair: 'im.telegram.connection.repair',
  imConnectionCheck: 'im.telegram.connection.check',
  imConnectionUpdate: 'im.telegram.connection.update',
  imConnectionRemove: 'im.telegram.connection.remove',
  imMessageSend: 'im.telegram.message.send',
  imMessageEdit: 'im.telegram.message.edit',
} as const;

export type TelegramCommandType = (typeof telegramCommandTypes)[keyof typeof telegramCommandTypes];
export type TelegramCommandPayload = { operationIdentity: string; inputSha256: string };

export interface TelegramCommandRequest<TInput extends object> {
  command: CommandEnvelope<TelegramCommandPayload>;
  input: TInput;
}

export interface ParsedTelegramCommand<TInput extends object> {
  command: CommandEnvelope<TelegramCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface TelegramCommandResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

export interface TelegramExternalChildOperation {
  /** 由父 operationIdentity 与固定 child key 派生，不含 token、chat id 或正文。 */
  operationId: string;
  kind: string;
}

interface PreparedExternal {
  state: 'prepared';
  parsed: ParsedTelegramCommand<object>;
  outbox: CommandOutboxRecord;
}

interface ReplayedExternal {
  state: 'accepted_replay';
  parsed: ParsedTelegramCommand<object>;
  outbox: CommandOutboxRecord;
  receipt: CommandDeliveryReceiptRecord;
}

type ExternalPreparation = PreparedExternal | ReplayedExternal;

export const telegramCommandRoutePolicy = {
  externalOperations: [
    'POST /api/security/reset',
    'POST /api/telegram/test',
    'PUT /api/telegram/security-settings',
    'POST /api/telegram/dispatch-preview',
    'PATCH /api/telegram/settings',
    'POST /api/telegram/start',
    'POST /api/telegram/stop',
    'POST /api/telegram/polling/start',
    'POST /api/telegram/polling/poll-once',
    'POST /api/telegram/polling/stop',
  ],
  coreApplications: ['PUT /api/telegram/notification-settings'],
  pollingOnceMaximumActive: 1,
  maximumReceiptBytes: 64 * 1024,
  maximumErrorBytes: 2 * 1024,
  postWriteFailure: 'outcome_unknown_after_write',
  automaticRetryAfterUnknown: false,
} as const;

export class TelegramCommandApplicationError extends Error {
  readonly name = 'TelegramCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_TELEGRAM_COMMAND_INVALID' | 'ZEUS_TELEGRAM_COMMAND_RESULT_MISSING' | 'ZEUS_TELEGRAM_COMMAND_RESULT_TOO_LARGE' | 'ZEUS_TELEGRAM_COMMAND_OUTCOME_UNKNOWN' | 'ZEUS_TELEGRAM_POLL_CAPACITY_EXCEEDED',
    message: string,
    readonly statusCode: 400 | 409 | 429 | 500,
    readonly recoveryRequired = false,
  ) {
    super(message);
  }
}

/**
 * Telegram 与安全设置的统一命令边界。
 *
 * 纯 Core 设置和 accepted receipt 在同一耐久事务中提交。Keychain、Telegram 网络与
 * poller 生命周期在调用前先写 external_operation marker；写出后不能证明结果时只记
 * unknown，绝不由 HTTP 重连或定时器盲重放。
 */
export class TelegramCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<TelegramCommandResult<unknown>>>();
  private readonly activeCapacityGroups = new Map<string, Set<string>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      redactSensitiveText(value: string): { text: string };
      now(): Date;
      pollingOnceMaximumActive?: number;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: TelegramCommandType; scopeId: string }): ParsedTelegramCommand<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<TelegramCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== 'settings' || command.scope.id !== input.scopeId) throw invalidCommand('Telegram command scope does not match the addressed settings resource.');
    if (command.expectedRevision !== null) throw invalidCommand('Telegram commands require expectedRevision=null.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = telegramCommandInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedTelegramCommand<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): TelegramCommandResult<TResult> {
    let result: TResult | undefined;
    const evidence: Record<string, unknown> = {
      source: 'telegram_core_application',
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
        evidence.result = redactJsonValue(result, this.options.redactSensitiveText);
        assertReceiptBudget(evidence);
      },
    });
    const resolved = delivery.created ? result : readResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return { commandId: delivery.inbox.commandId, operationIdentity: input.parsed.operationIdentity, replayed: !delivery.created, result: resolved };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedTelegramCommand<TInput>;
    destinationId: string;
    resourceId: string;
    children: readonly TelegramExternalChildOperation[];
    capacityGroup?: 'poll_once';
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<TelegramCommandResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<TelegramCommandResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<TelegramCommandResult<unknown>>);
    return execution;
  }

  activeCapacitySnapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.activeCapacityGroups].map(([key, entries]) => [key, entries.size]));
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedTelegramCommand<TInput>;
    destinationId: string;
    resourceId: string;
    children: readonly TelegramExternalChildOperation[];
    capacityGroup?: 'poll_once';
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState?(result: TResult): void;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<TelegramCommandResult<TResult>> {
    const children = normalizeChildren(input.children);
    const preparation = this.prepareExternal({
      parsed: input.parsed,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      externalOperationId: telegramExternalOperationId(input.parsed.operationIdentity),
    });
    if (preparation.state === 'accepted_replay') {
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: readResult<TResult>(preparation.receipt, input.parsed.command.commandType),
      };
    }

    let writeStarted = false;
    let releaseCapacity: (() => void) | undefined;
    try {
      releaseCapacity = this.acquireCapacity(input.capacityGroup, preparation.outbox.id);
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId: preparation.outbox.id, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = await input.invoke();
      const evidence = {
        source: 'telegram_external_operation',
        commandType: input.parsed.command.commandType,
        operationIdentity: input.parsed.operationIdentity,
        externalOperationId: preparation.outbox.externalOperationId,
        childOperations: children,
        result: redactJsonValue(result, this.options.redactSensitiveText),
      };
      assertReceiptBudget(evidence);
      this.options.db.durableTransactionSync(() => {
        input.mutateAcceptedBusinessState?.(result);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId: preparation.outbox.id,
          outcome: 'accepted',
          evidence,
          occurredAt: this.options.now().toISOString(),
        });
      });
      return { commandId: input.parsed.command.commandId, operationIdentity: input.parsed.operationIdentity, replayed: false, result };
    } catch (error) {
      const explicitlyRejected = writeStarted && (input.isExplicitRejection?.(error) ?? isExplicitTelegramRejection(error));
      const outcome: Exclude<CommandDeliveryOutcome, 'accepted'> = explicitlyRejected ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.db.durableTransactionSync(() => {
          input.mutateFailureBusinessState?.(outcome, error);
          this.options.deliveries.recordOutcomeInCurrentTransaction({
            outboxId: preparation.outbox.id,
            outcome,
            evidence: {
              source: 'telegram_external_operation',
              commandType: input.parsed.command.commandType,
              operationIdentity: input.parsed.operationIdentity,
              externalOperationId: preparation.outbox.externalOperationId,
              childOperations: children,
              result: outcome,
              error: serializeError(error, this.options.redactSensitiveText),
            },
            occurredAt: this.options.now().toISOString(),
          });
        });
      } catch (receiptError) {
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Telegram 外部操作与失败回执同时未能收口。');
      }
      if (outcome === 'outcome_unknown_after_write') throw outcomeUnknown(error, this.options.redactSensitiveText);
      throw error;
    } finally {
      releaseCapacity?.();
    }
  }

  private prepareExternal(input: { parsed: ParsedTelegramCommand<object>; destinationId: string; resourceId: string; externalOperationId: string }): ExternalPreparation {
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

  private acquireCapacity(group: 'poll_once' | undefined, identity: string): (() => void) | undefined {
    if (!group) return undefined;
    const entries = this.activeCapacityGroups.get(group) ?? new Set<string>();
    const maximum = this.options.pollingOnceMaximumActive ?? telegramCommandRoutePolicy.pollingOnceMaximumActive;
    if (!entries.has(identity) && entries.size >= maximum) {
      throw new TelegramCommandApplicationError('ZEUS_TELEGRAM_POLL_CAPACITY_EXCEEDED', 'Telegram poll-once 并发容量已满，请稍后使用新的用户意图重试。', 429);
    }
    entries.add(identity);
    this.activeCapacityGroups.set(group, entries);
    return () => {
      entries.delete(identity);
      if (entries.size === 0) this.activeCapacityGroups.delete(group);
    };
  }
}

export function telegramCommandInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

export function telegramExternalOperationId(operationIdentity: string): string {
  return `telegram_external_${createHash('sha256').update(operationIdentity).digest('hex').slice(0, 32)}`;
}

export function telegramChildOperation(operationIdentity: string, kind: string): TelegramExternalChildOperation {
  const normalizedKind = boundedIdentity(kind, 'child.kind');
  return {
    kind: normalizedKind,
    operationId: `telegram_child_${createHash('sha256').update(`${operationIdentity}\0${normalizedKind}`).digest('hex').slice(0, 32)}`,
  };
}

export function telegramCommandHttpError(error: unknown): { statusCode: number; payload: Record<string, unknown> } | undefined {
  if (error instanceof TelegramCommandApplicationError) {
    return { statusCode: error.statusCode, payload: { error: error.code, message: error.message, recoveryRequired: error.recoveryRequired } };
  }
  if (error instanceof CommandEnvelopeError) return { statusCode: error.code === 'ZEUS_COMMAND_EXPECTED_REVISION_CONFLICT' ? 409 : 400, payload: { error: error.code, message: error.message, details: error.details } };
  if (isCommandDeliveryError(error)) {
    const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_IDEMPOTENCY_CONFLICT' || error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' || error.code === 'ZEUS_COMMAND_DELIVERY_STATE_CONFLICT' ? 409 : 500;
    return { statusCode, payload: { error: error.code, message: error.message, details: error.details, recoveryRequired: error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' } };
  }
  if (isExplicitTelegramRejection(error)) {
    return { statusCode: 502, payload: { error: 'ZEUS_TELEGRAM_EXPLICITLY_REJECTED', message: 'Telegram 已明确拒绝该操作，本次未自动重试。', recoveryRequired: false } };
  }
  return undefined;
}

function normalizeChildren(children: readonly TelegramExternalChildOperation[]): TelegramExternalChildOperation[] {
  if (children.length === 0 || children.length > 256) throw invalidCommand('Telegram external commands require between 1 and 256 stable child operations.');
  const seen = new Set<string>();
  return children.map((child) => {
    const operationId = boundedIdentity(child.operationId, 'child.operationId');
    const kind = boundedIdentity(child.kind, 'child.kind');
    if (seen.has(operationId)) throw invalidCommand('Telegram child operation identities must be unique.');
    seen.add(operationId);
    return { operationId, kind };
  });
}

function redactJsonValue<T>(value: T, redactor: (text: string) => { text: string }): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return value;
  const redacted = redactor(serialized).text;
  try {
    return JSON.parse(redacted) as T;
  } catch {
    return { redacted: true } as T;
  }
}

function readResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  const evidence = JSON.parse(receipt.evidenceJson) as { commandType?: unknown; result?: unknown };
  if (evidence.commandType !== commandType || !Object.prototype.hasOwnProperty.call(evidence, 'result')) throw missingResult(receipt.commandId);
  return evidence.result as TResult;
}

function assertReceiptBudget(value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  if (bytes > telegramCommandRoutePolicy.maximumReceiptBytes) {
    throw new TelegramCommandApplicationError('ZEUS_TELEGRAM_COMMAND_RESULT_TOO_LARGE', 'Telegram command receipt exceeds the bounded evidence budget.', 500, true);
  }
}

function serializeError(error: unknown, redactor: (value: string) => { text: string }): Record<string, unknown> {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? String((error as { code: string }).code).slice(0, 128) : null;
  const raw = error instanceof Error ? error.message : String(error);
  const message = truncateUtf8(redactor(raw).text, telegramCommandRoutePolicy.maximumErrorBytes);
  return { name: error instanceof Error ? error.name.slice(0, 128) : 'Error', code, message, truncated: Buffer.byteLength(raw, 'utf8') > telegramCommandRoutePolicy.maximumErrorBytes };
}

function outcomeUnknown(error: unknown, redactor: (value: string) => { text: string }): TelegramCommandApplicationError {
  const message = serializeError(error, redactor).message;
  return new TelegramCommandApplicationError('ZEUS_TELEGRAM_COMMAND_OUTCOME_UNKNOWN', `Telegram 外部操作写出后结果未知，已阻断自动重试：${String(message)}`, 409, true);
}

function isExplicitTelegramRejection(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { dispatchDisposition?: unknown }).dispatchDisposition === 'explicitly_rejected');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error && typeof error === 'object' && (error instanceof CommandDeliveryStoreError || (error as { name?: unknown }).name === 'CommandDeliveryStoreError') && typeof (error as { code?: unknown }).code === 'string');
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidCommand(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  if (actual.length !== normalizedExpected.length || actual.some((key, index) => key !== normalizedExpected[index])) throw invalidCommand(`${label} contains unsupported or missing fields.`);
}

function validSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256 digest.`);
  return value;
}

function boundedIdentity(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > 512 || Array.from(value).some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
    throw invalidCommand(`${field} is invalid.`);
  }
  return value;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maximumBytes) return value;
  return bytes
    .subarray(0, maximumBytes)
    .toString('utf8')
    .replace(/\uFFFD$/u, '');
}

function invalidCommand(message: string): TelegramCommandApplicationError {
  return new TelegramCommandApplicationError('ZEUS_TELEGRAM_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): TelegramCommandApplicationError {
  return new TelegramCommandApplicationError('ZEUS_TELEGRAM_COMMAND_RESULT_MISSING', `Telegram command ${commandId} has no replayable accepted result.`, 500, true);
}
