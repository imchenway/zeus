import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { canonicalCommandInputJson, parseCommandEnvelope, type CommandEnvelope } from '@zeus/shared';

export interface MainCommandRequest<TBody = unknown> {
  envelope: unknown;
  body: TBody;
}

export type MainCommandOutcomeState = 'accepted' | 'failed_before_write' | 'unknown_after_write' | 'receipted';

export interface MainCommandArtifactRef {
  kind: 'main_command_result';
  artifactId: string;
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: 'application/json';
}

interface MainCommandStoredResult {
  kind: 'inline';
  value: unknown;
}

interface MainCommandStoredArtifactResult {
  kind: 'artifact_ref';
  artifactRef: MainCommandArtifactRef;
}

interface MainCommandOmittedResult {
  kind: 'result_omitted';
  sha256: string;
  byteLength: number;
  reason: 'exceeds_artifact_receipt_budget';
}

export interface MainCommandOutcome {
  schemaVersion: 1;
  commandId: string;
  commandType: string;
  requestSha256: string;
  state: MainCommandOutcomeState;
  acceptedAt: string;
  updatedAt: string;
  writeMarker?: {
    externalOperationId: string;
    startedAt: string;
  };
  result?: MainCommandStoredResult | MainCommandStoredArtifactResult | MainCommandOmittedResult;
  failure?: {
    code: string;
    message: string;
    errorSha256: string;
  };
}

interface MainCommandEnvelopeRecord {
  schemaVersion: 1;
  envelope: CommandEnvelope;
  requestSha256: string;
}

export interface MainCommandExecutionContext {
  readonly envelope: CommandEnvelope;
  readonly requestSha256: string;
  readonly externalOperationId: string;
  /** 必须紧邻并早于第一个本地或外部写出；此调用已 fsync 后才返回。 */
  markWriteStarted(): Promise<void>;
}

export interface MainCommandLedgerOptions {
  root: string;
  now?: () => string;
  inlineReceiptByteLimit?: number;
}

const maximumInlineReceiptBytes = 64 * 1024;
const maximumArtifactReceiptBytes = 64 * 1024 * 1024;
const maximumLedgerJsonBytes = 2 * 1024 * 1024;

export class MainCommandLedgerError extends Error {
  readonly name = 'MainCommandLedgerError';

  constructor(
    readonly code:
      | 'ZEUS_MAIN_COMMAND_REQUEST_INVALID'
      | 'ZEUS_MAIN_COMMAND_TYPE_MISMATCH'
      | 'ZEUS_MAIN_COMMAND_IDENTITY_CONFLICT'
      | 'ZEUS_MAIN_COMMAND_IN_PROGRESS'
      | 'ZEUS_MAIN_COMMAND_FAILED_BEFORE_WRITE'
      | 'ZEUS_MAIN_COMMAND_OUTCOME_UNKNOWN_AFTER_WRITE'
      | 'ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT'
      | 'ZEUS_MAIN_COMMAND_RESULT_NOT_REPLAYABLE',
    message: string,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(message);
  }
}

/**
 * Electron Main 与独立 Core 不共享 SQLite writer。Main Command ledger 因而使用独立、
 * 分片、append-by-identity 的文件账本：Envelope 永不覆盖，Outcome 只通过 fsync+rename 推进。
 */
export class MainCommandLedger {
  readonly #root: string;
  readonly #envelopeRoot: string;
  readonly #outcomeRoot: string;
  readonly #artifactRoot: string;
  readonly #now: () => string;
  readonly #inlineReceiptByteLimit: number;
  readonly #inFlight = new Map<string, { identitySha256: string; promise: Promise<unknown> }>();
  #prepared: Promise<void> | undefined;

  constructor(options: MainCommandLedgerOptions) {
    this.#root = resolve(options.root);
    this.#envelopeRoot = join(this.#root, 'envelopes');
    this.#outcomeRoot = join(this.#root, 'outcomes');
    this.#artifactRoot = join(this.#root, 'artifacts');
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#inlineReceiptByteLimit = options.inlineReceiptByteLimit ?? maximumInlineReceiptBytes;
  }

  async execute<TBody, TResult>(request: MainCommandRequest<TBody>, expectedCommandType: string, effect: (body: TBody, context: MainCommandExecutionContext) => Promise<TResult> | TResult): Promise<TResult> {
    const parsed = parseMainCommandRequest<TBody>(request, expectedCommandType);
    const requestSha256 = hashMainCommandBody(parsed.body);
    const commandId = parsed.envelope.commandId;
    const identitySha256 = hashCommandIdentity(parsed.envelope, requestSha256);
    const existingInFlight = this.#inFlight.get(commandId);
    if (existingInFlight) {
      if (existingInFlight.identitySha256 !== identitySha256) {
        throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_IDENTITY_CONFLICT', 'Concurrent Main command reuse supplied a different immutable request.', { commandId });
      }
      return (await existingInFlight.promise) as TResult;
    }
    const execution = this.#execute(parsed.envelope, parsed.body, requestSha256, effect);
    this.#inFlight.set(commandId, { identitySha256, promise: execution });
    try {
      return (await execution) as TResult;
    } finally {
      if (this.#inFlight.get(commandId)?.promise === execution) this.#inFlight.delete(commandId);
    }
  }

  /** 行为核验与故障诊断只返回有界、无正文的状态。 */
  async inspect(commandId: string): Promise<MainCommandOutcome | null> {
    await this.#prepare();
    const safeCommandId = assertSafeCommandId(commandId);
    const path = this.#outcomePath(safeCommandId);
    if (!(await lexicalPathExists(path))) return null;
    return this.#readOutcome(path, safeCommandId);
  }

  async #execute<TBody, TResult>(envelope: CommandEnvelope, body: TBody, requestSha256: string, effect: (body: TBody, context: MainCommandExecutionContext) => Promise<TResult> | TResult): Promise<TResult> {
    await this.#prepare();
    const envelopePath = this.#envelopePath(envelope.commandId);
    const outcomePath = this.#outcomePath(envelope.commandId);
    const acceptedAt = this.#now();
    // 接纳时间属于可推进 Outcome；不可放进 immutable identity，否则合法重放会因当前时钟不同而冲突。
    const envelopeRecord: MainCommandEnvelopeRecord = {
      schemaVersion: 1,
      envelope,
      requestSha256,
    };
    const created = await writeImmutableJson(envelopePath, envelopeRecord);
    if (!created) {
      const existingEnvelope = await this.#readEnvelopeRecord(envelopePath, envelope.commandId);
      if (canonicalCommandInputJson(existingEnvelope) !== canonicalCommandInputJson(envelopeRecord)) {
        throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_IDENTITY_CONFLICT', 'Main command identity was already used with a different immutable request.', {
          commandId: envelope.commandId,
        });
      }
      return this.#resolveExisting<TResult>(outcomePath, envelope, requestSha256);
    }

    let outcome: MainCommandOutcome = {
      schemaVersion: 1,
      commandId: envelope.commandId,
      commandType: envelope.commandType,
      requestSha256,
      state: 'accepted',
      acceptedAt,
      updatedAt: acceptedAt,
    };
    await writeAtomicJson(outcomePath, outcome);
    let writeStarted = false;
    let markerInFlight: Promise<void> | undefined;
    const externalOperationId = `main:${envelope.commandType}:${envelope.commandId}`;
    const context: MainCommandExecutionContext = {
      envelope,
      requestSha256,
      externalOperationId,
      markWriteStarted: async () => {
        if (writeStarted) return;
        markerInFlight ??= (async () => {
          const startedAt = this.#now();
          const durableMarkerOutcome: MainCommandOutcome = {
            ...outcome,
            state: 'accepted',
            writeMarker: { externalOperationId, startedAt },
            updatedAt: startedAt,
          };
          // 只有 marker 的原子文件与目录都 fsync 成功后，才允许内存态进入 after-write。
          await writeAtomicJson(outcomePath, durableMarkerOutcome);
          outcome = durableMarkerOutcome;
          writeStarted = true;
        })();
        try {
          await markerInFlight;
        } finally {
          if (!writeStarted) markerInFlight = undefined;
        }
      },
    };

    try {
      const result = await effect(body, context);
      if (!writeStarted) {
        throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main mutation completed without a durable pre-write marker.', {
          commandId: envelope.commandId,
          commandType: envelope.commandType,
        });
      }
      const completedAt = this.#now();
      outcome = {
        ...outcome,
        state: 'receipted',
        result: await this.#storeResult(envelope.commandId, result),
        updatedAt: completedAt,
      };
      await writeAtomicJson(outcomePath, outcome);
      return result;
    } catch (error) {
      const failedAt = this.#now();
      const failure = boundedFailure(error, this.#root, writeStarted);
      outcome = {
        ...outcome,
        state: writeStarted ? 'unknown_after_write' : 'failed_before_write',
        failure,
        updatedAt: failedAt,
      };
      await writeAtomicJson(outcomePath, outcome);
      if (!writeStarted) throw error;
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_OUTCOME_UNKNOWN_AFTER_WRITE', 'Main command outcome is unknown after a durable write marker; automatic retry is forbidden.', {
        commandId: envelope.commandId,
        commandType: envelope.commandType,
        externalOperationId,
      });
    }
  }

  async #resolveExisting<TResult>(outcomePath: string, envelope: CommandEnvelope, requestSha256: string): Promise<TResult> {
    if (!(await lexicalPathExists(outcomePath))) {
      const interruptedAt = this.#now();
      await writeAtomicJson(outcomePath, {
        schemaVersion: 1,
        commandId: envelope.commandId,
        commandType: envelope.commandType,
        requestSha256,
        state: 'failed_before_write',
        acceptedAt: interruptedAt,
        updatedAt: interruptedAt,
        failure: boundedFailure(new Error('replayed_after_immutable_envelope_before_initial_outcome'), this.#root, false),
      } satisfies MainCommandOutcome);
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_FAILED_BEFORE_WRITE', 'Main command replay recovered an immutable envelope that never reached its initial outcome.', {
        commandId: envelope.commandId,
        commandType: envelope.commandType,
      });
    }
    const outcome = await this.#readOutcome(outcomePath, envelope.commandId);
    if (outcome.commandType !== envelope.commandType || outcome.requestSha256 !== requestSha256) {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_IDENTITY_CONFLICT', 'Main command receipt does not match the immutable request identity.', { commandId: envelope.commandId });
    }
    if (outcome.state === 'receipted' && outcome.result) return (await this.#loadResult(outcome.result)) as TResult;
    if (outcome.state === 'unknown_after_write' || (outcome.state === 'accepted' && outcome.writeMarker)) {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_OUTCOME_UNKNOWN_AFTER_WRITE', 'Main command may have written externally; automatic retry is forbidden.', {
        commandId: envelope.commandId,
        commandType: envelope.commandType,
      });
    }
    if (outcome.state === 'failed_before_write') {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_FAILED_BEFORE_WRITE', 'Main command failed before its durable write marker.', { commandId: envelope.commandId, commandType: envelope.commandType });
    }
    throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_IN_PROGRESS', 'Main command is already accepted and has no terminal receipt yet.', { commandId: envelope.commandId });
  }

  async #storeResult(commandId: string, result: unknown): Promise<MainCommandStoredResult | MainCommandStoredArtifactResult | MainCommandOmittedResult> {
    const json = canonicalCommandInputJson(result === undefined ? null : result);
    const bytes = Buffer.from(json, 'utf8');
    if (bytes.byteLength <= this.#inlineReceiptByteLimit) return { kind: 'inline', value: result === undefined ? null : JSON.parse(json) };
    if (bytes.byteLength > maximumArtifactReceiptBytes) {
      return {
        kind: 'result_omitted',
        byteLength: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        reason: 'exceeds_artifact_receipt_budget',
      };
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const artifactId = `main-command-result-${sha256}`;
    const path = join(this.#artifactRoot, sha256.slice(0, 2), `${sha256}.json`);
    const created = await writeImmutableBytes(path, bytes);
    if (!created) {
      const existing = await readBoundedBytes(path, maximumArtifactReceiptBytes);
      if (existing.byteLength !== bytes.byteLength || !existing.equals(bytes)) {
        throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Existing Main command result artifact does not match its content-addressed identity.');
      }
    }
    return {
      kind: 'artifact_ref',
      artifactRef: {
        kind: 'main_command_result',
        artifactId,
        relativePath: relative(this.#root, path),
        sha256,
        byteLength: bytes.byteLength,
        mediaType: 'application/json',
      },
    };
  }

  async #loadResult(result: MainCommandStoredResult | MainCommandStoredArtifactResult | MainCommandOmittedResult): Promise<unknown> {
    if (result.kind === 'inline') return structuredClone(result.value);
    if (result.kind === 'result_omitted') {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RESULT_NOT_REPLAYABLE', 'Main command completed, but its result exceeded the replay artifact budget.', {
        byteLength: result.byteLength,
        sha256: result.sha256,
      });
    }
    const path = resolve(this.#root, result.artifactRef.relativePath);
    if (!isPathInside(path, this.#artifactRoot)) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ArtifactRef escaped the ledger root.');
    const bytes = await readBoundedBytes(path, maximumArtifactReceiptBytes);
    if (bytes.byteLength !== result.artifactRef.byteLength || createHash('sha256').update(bytes).digest('hex') !== result.artifactRef.sha256) {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ArtifactRef hash or size does not match its receipt.');
    }
    return parseLedgerJson(bytes, path);
  }

  async #prepare(): Promise<void> {
    this.#prepared ??= (async () => {
      await ensureSecureDirectory(this.#root);
      await Promise.all([ensureSecureDirectory(this.#envelopeRoot), ensureSecureDirectory(this.#outcomeRoot), ensureSecureDirectory(this.#artifactRoot)]);
      await this.#sealOrphanEnvelopes();
      await this.#sealInterruptedOutcomes();
    })();
    return this.#prepared;
  }

  async #sealOrphanEnvelopes(): Promise<void> {
    for (const shard of await readLedgerDirectory(this.#envelopeRoot)) {
      assertShardName(shard);
      const shardPath = join(this.#envelopeRoot, shard);
      await assertSecureDirectory(shardPath);
      for (const file of await readLedgerDirectory(shardPath)) {
        if (isAtomicLedgerTempFile(file)) continue;
        const commandId = commandIdFromLedgerFile(file, shard);
        const envelopePath = join(shardPath, file);
        const envelopeRecord = await this.#readEnvelopeRecord(envelopePath, commandId);
        const outcomePath = this.#outcomePath(commandId);
        if (await lexicalPathExists(outcomePath)) continue;
        const interruptedAt = this.#now();
        await writeAtomicJson(outcomePath, {
          schemaVersion: 1,
          commandId,
          commandType: envelopeRecord.envelope.commandType,
          requestSha256: envelopeRecord.requestSha256,
          state: 'failed_before_write',
          acceptedAt: interruptedAt,
          updatedAt: interruptedAt,
          failure: boundedFailure(new Error('interrupted_after_immutable_envelope_before_initial_outcome'), this.#root, false),
        } satisfies MainCommandOutcome);
      }
    }
  }

  async #sealInterruptedOutcomes(): Promise<void> {
    for (const shard of await readLedgerDirectory(this.#outcomeRoot)) {
      assertShardName(shard);
      const shardPath = join(this.#outcomeRoot, shard);
      await assertSecureDirectory(shardPath);
      for (const file of await readLedgerDirectory(shardPath)) {
        if (isAtomicLedgerTempFile(file)) continue;
        const commandId = commandIdFromLedgerFile(file, shard);
        const path = join(shardPath, file);
        const outcome = await this.#readOutcome(path, commandId);
        if (outcome.state !== 'accepted') continue;
        const updatedAt = this.#now();
        await writeAtomicJson(path, {
          ...outcome,
          state: outcome.writeMarker ? 'unknown_after_write' : 'failed_before_write',
          failure: boundedFailure(new Error(outcome.writeMarker ? 'interrupted_after_write_marker' : 'interrupted_before_write_marker'), this.#root, Boolean(outcome.writeMarker)),
          updatedAt,
        } satisfies MainCommandOutcome);
      }
    }
  }

  async #readEnvelopeRecord(path: string, expectedCommandId: string): Promise<MainCommandEnvelopeRecord> {
    const safeCommandId = assertSafeCommandId(expectedCommandId);
    if (resolve(path) !== this.#envelopePath(safeCommandId)) throw receiptCorrupt('Main command envelope path does not match its command identity.', path);
    const record = parseMainCommandEnvelopeRecord(await readBoundedJson<unknown>(path, maximumLedgerJsonBytes), safeCommandId, path);
    return record;
  }

  async #readOutcome(path: string, expectedCommandId: string): Promise<MainCommandOutcome> {
    const safeCommandId = assertSafeCommandId(expectedCommandId);
    if (resolve(path) !== this.#outcomePath(safeCommandId)) throw receiptCorrupt('Main command outcome path does not match its command identity.', path);
    const outcome = parseMainCommandOutcome(await readBoundedJson<unknown>(path, maximumLedgerJsonBytes), safeCommandId, path);
    const envelopeRecord = await this.#readEnvelopeRecord(this.#envelopePath(safeCommandId), safeCommandId);
    if (outcome.commandType !== envelopeRecord.envelope.commandType || outcome.requestSha256 !== envelopeRecord.requestSha256) {
      throw receiptCorrupt('Main command outcome identity does not match its immutable envelope.', path);
    }
    return outcome;
  }

  #envelopePath(commandId: string): string {
    const id = assertSafeCommandId(commandId);
    return join(this.#envelopeRoot, shardFor(id), `${id}.json`);
  }

  #outcomePath(commandId: string): string {
    const id = assertSafeCommandId(commandId);
    return join(this.#outcomeRoot, shardFor(id), `${id}.json`);
  }
}

export function parseMainCommandRequest<TBody>(value: unknown, expectedCommandType: string): { envelope: CommandEnvelope; body: TBody } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('envelope' in value) || !('body' in value)) {
    throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main mutation IPC requires an immutable Command Envelope and body.');
  }
  const request = value as { envelope: unknown; body: TBody };
  const envelope = parseCommandEnvelope(request.envelope);
  if (envelope.commandType !== expectedCommandType) {
    throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_TYPE_MISMATCH', 'Main command type does not match the IPC boundary.', {
      expectedCommandType,
      actualCommandType: envelope.commandType,
    });
  }
  return { envelope, body: request.body };
}

export function createSystemMainCommandEnvelope(commandType: string, scopeId: string, now = new Date().toISOString()): CommandEnvelope {
  const commandId = randomUUID();
  return parseCommandEnvelope({
    schemaGeneration: 'zeus-command-envelope-v1',
    commandId,
    commandType,
    actor: { kind: 'user', id: 'desktop-native-user' },
    scope: { kind: 'execution_host', id: scopeId },
    expectedRevision: null,
    idempotencyKey: `desktop-native:${commandId}`,
    issuedAt: now,
    payload: { transport: 'electron-native-menu' },
  });
}

export function hashMainCommandBody(value: unknown): string {
  return createHash('sha256').update(canonicalMainCommandBody(value)).digest('hex');
}

function hashCommandIdentity(envelope: CommandEnvelope, requestSha256: string): string {
  return createHash('sha256').update(canonicalCommandInputJson({ envelope, requestSha256 })).digest('hex');
}

function parseMainCommandEnvelopeRecord(value: unknown, expectedCommandId: string, path: string): MainCommandEnvelopeRecord {
  const record = exactRecord(value, ['schemaVersion', 'envelope', 'requestSha256'], [], 'immutable envelope', path);
  if (record.schemaVersion !== 1 || !isSha256(record.requestSha256)) throw receiptCorrupt('Main command immutable envelope record is malformed.', path);
  const rawEnvelope = exactRecord(record.envelope, ['schemaGeneration', 'commandId', 'commandType', 'actor', 'scope', 'expectedRevision', 'idempotencyKey', 'issuedAt', 'payload'], [], 'command envelope', path);
  exactRecord(rawEnvelope.actor, ['kind', 'id'], [], 'command actor', path);
  exactRecord(rawEnvelope.scope, ['kind', 'id'], [], 'command scope', path);
  let envelope: CommandEnvelope;
  try {
    envelope = parseCommandEnvelope(rawEnvelope);
  } catch {
    throw receiptCorrupt('Main command immutable envelope does not satisfy its schema.', path);
  }
  if (envelope.commandId !== expectedCommandId || shardFor(envelope.commandId) !== basename(dirname(path))) {
    throw receiptCorrupt('Main command immutable envelope identity does not match its path.', path);
  }
  return { schemaVersion: 1, envelope, requestSha256: record.requestSha256 };
}

function parseMainCommandOutcome(value: unknown, expectedCommandId: string, path: string): MainCommandOutcome {
  const record = exactRecord(value, ['schemaVersion', 'commandId', 'commandType', 'requestSha256', 'state', 'acceptedAt', 'updatedAt'], ['writeMarker', 'result', 'failure'], 'outcome', path);
  if (
    record.schemaVersion !== 1 ||
    record.commandId !== expectedCommandId ||
    typeof record.commandType !== 'string' ||
    !/^[a-z][a-z0-9_.-]{0,127}$/u.test(record.commandType) ||
    !isSha256(record.requestSha256) ||
    !['accepted', 'failed_before_write', 'unknown_after_write', 'receipted'].includes(String(record.state))
  ) {
    throw receiptCorrupt('Main command outcome identity or state is malformed.', path);
  }
  const acceptedAt = exactIsoTimestamp(record.acceptedAt, 'acceptedAt', path);
  const updatedAt = exactIsoTimestamp(record.updatedAt, 'updatedAt', path);
  if (Date.parse(updatedAt) < Date.parse(acceptedAt)) throw receiptCorrupt('Main command outcome timestamps move backwards.', path);

  const writeMarker = record.writeMarker === undefined ? undefined : parseWriteMarker(record.writeMarker, record.commandType, expectedCommandId, acceptedAt, updatedAt, path);
  const result = record.result === undefined ? undefined : parseStoredResult(record.result, path);
  const failure = record.failure === undefined ? undefined : parseStoredFailure(record.failure, path);
  const state = record.state as MainCommandOutcomeState;
  const validStateShape =
    (state === 'accepted' && result === undefined && failure === undefined) ||
    (state === 'failed_before_write' && writeMarker === undefined && result === undefined && failure !== undefined) ||
    (state === 'unknown_after_write' && writeMarker !== undefined && result === undefined && failure !== undefined) ||
    (state === 'receipted' && writeMarker !== undefined && result !== undefined && failure === undefined);
  if (!validStateShape) throw receiptCorrupt('Main command outcome fields do not match its state.', path);

  return {
    schemaVersion: 1,
    commandId: expectedCommandId,
    commandType: record.commandType,
    requestSha256: record.requestSha256,
    state,
    acceptedAt,
    updatedAt,
    ...(writeMarker ? { writeMarker } : {}),
    ...(result ? { result } : {}),
    ...(failure ? { failure } : {}),
  };
}

function parseWriteMarker(value: unknown, commandType: string, commandId: string, acceptedAt: string, updatedAt: string, path: string): NonNullable<MainCommandOutcome['writeMarker']> {
  const marker = exactRecord(value, ['externalOperationId', 'startedAt'], [], 'write marker', path);
  const expectedOperationId = `main:${commandType}:${commandId}`;
  const startedAt = exactIsoTimestamp(marker.startedAt, 'writeMarker.startedAt', path);
  if (marker.externalOperationId !== expectedOperationId || Date.parse(startedAt) < Date.parse(acceptedAt) || Date.parse(startedAt) > Date.parse(updatedAt)) {
    throw receiptCorrupt('Main command write marker identity or timestamp is malformed.', path);
  }
  return { externalOperationId: expectedOperationId, startedAt };
}

function parseStoredResult(value: unknown, path: string): MainCommandOutcome['result'] {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') throw receiptCorrupt('Main command stored result is malformed.', path);
  if (value.kind === 'inline') {
    const result = exactRecord(value, ['kind', 'value'], [], 'inline result', path);
    return { kind: 'inline', value: structuredClone(result.value) };
  }
  if (value.kind === 'result_omitted') {
    const result = exactRecord(value, ['kind', 'sha256', 'byteLength', 'reason'], [], 'omitted result', path);
    if (!isSha256(result.sha256) || !isSafeByteLength(result.byteLength) || result.byteLength <= maximumArtifactReceiptBytes || result.reason !== 'exceeds_artifact_receipt_budget') {
      throw receiptCorrupt('Main command omitted-result receipt is malformed.', path);
    }
    return { kind: 'result_omitted', sha256: result.sha256, byteLength: result.byteLength, reason: 'exceeds_artifact_receipt_budget' };
  }
  if (value.kind === 'artifact_ref') {
    const result = exactRecord(value, ['kind', 'artifactRef'], [], 'artifact result', path);
    const reference = exactRecord(result.artifactRef, ['kind', 'artifactId', 'relativePath', 'sha256', 'byteLength', 'mediaType'], [], 'artifact reference', path);
    if (
      reference.kind !== 'main_command_result' ||
      !isSha256(reference.sha256) ||
      reference.artifactId !== `main-command-result-${String(reference.sha256)}` ||
      !isSafeByteLength(reference.byteLength) ||
      reference.byteLength > maximumArtifactReceiptBytes ||
      reference.mediaType !== 'application/json' ||
      reference.relativePath !== join('artifacts', String(reference.sha256).slice(0, 2), `${String(reference.sha256)}.json`)
    ) {
      throw receiptCorrupt('Main command ArtifactRef identity, path or bounds are malformed.', path);
    }
    return {
      kind: 'artifact_ref',
      artifactRef: {
        kind: 'main_command_result',
        artifactId: reference.artifactId,
        relativePath: reference.relativePath,
        sha256: reference.sha256,
        byteLength: reference.byteLength,
        mediaType: 'application/json',
      },
    };
  }
  throw receiptCorrupt('Main command stored result kind is unknown.', path);
}

function parseStoredFailure(value: unknown, path: string): NonNullable<MainCommandOutcome['failure']> {
  const failure = exactRecord(value, ['code', 'message', 'errorSha256'], [], 'failure receipt', path);
  if (typeof failure.code !== 'string' || failure.code.length < 1 || failure.code.length > 128 || typeof failure.message !== 'string' || failure.message.length < 1 || failure.message.length > 640 || !isSha256(failure.errorSha256)) {
    throw receiptCorrupt('Main command failure receipt is malformed or unbounded.', path);
  }
  return { code: failure.code, message: failure.message, errorSha256: failure.errorSha256 };
}

function exactRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string, path: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw receiptCorrupt(`Main command ${label} must be a plain object.`, path);
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key)) || keys.some((key) => !allowed.has(key))) {
    throw receiptCorrupt(`Main command ${label} has missing or unexpected fields.`, path);
  }
  return value;
}

function exactIsoTimestamp(value: unknown, field: string, path: string): string {
  if (typeof value !== 'string' || value.length > 64 || Number.isNaN(Date.parse(value))) throw receiptCorrupt(`Main command ${field} is not a bounded timestamp.`, path);
  const normalized = new Date(value).toISOString();
  if (normalized !== value) throw receiptCorrupt(`Main command ${field} is not canonical ISO-8601.`, path);
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isSafeByteLength(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function receiptCorrupt(message: string, path?: string): MainCommandLedgerError {
  return new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', message, path ? { file: basename(path) } : {});
}

function canonicalMainCommandBody(value: unknown): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const append = (value: string | Buffer): void => {
    const chunk = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
    totalBytes += chunk.byteLength;
    if (totalBytes > 512 * 1024 * 1024) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command body exceeds the hashing byte budget.');
    chunks.push(chunk);
  };
  const visit = (entry: unknown, depth: number, seen: Set<object>): void => {
    if (depth > 32) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command body exceeds the nesting budget.');
    if (entry === null) return append('null;');
    if (entry === undefined) return append('undefined;');
    if (typeof entry === 'string') return append(`string:${Buffer.byteLength(entry)}:${entry};`);
    if (typeof entry === 'boolean') return append(entry ? 'boolean:1;' : 'boolean:0;');
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command body contains a non-finite number.');
      return append(`number:${Object.is(entry, -0) ? '-0' : String(entry)};`);
    }
    if (entry instanceof ArrayBuffer) {
      const bytes = Buffer.from(entry);
      append(`binary:${bytes.byteLength}:`);
      append(bytes);
      return append(';');
    }
    if (ArrayBuffer.isView(entry)) {
      const bytes = Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength);
      append(`binary:${bytes.byteLength}:`);
      append(bytes);
      return append(';');
    }
    if (!entry || typeof entry !== 'object') throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command body contains unsupported data.');
    if (seen.has(entry)) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command body contains a cycle.');
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        append(`array:${entry.length}:[`);
        entry.forEach((item) => visit(item, depth + 1, seen));
        return append('];');
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command body contains a non-plain object.');
      const record = entry as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      append(`object:${keys.length}:{`);
      for (const key of keys) {
        append(`key:${Buffer.byteLength(key)}:${key};`);
        visit(record[key], depth + 1, seen);
      }
      append('};');
    } finally {
      seen.delete(entry);
    }
  };
  visit(value, 0, new Set());
  return Buffer.concat(chunks);
}

function boundedFailure(error: unknown, root: string, afterWrite: boolean): MainCommandOutcome['failure'] {
  const rawCode = error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : 'ZEUS_MAIN_COMMAND_EFFECT_FAILED';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const redacted = rawMessage
    .replaceAll(root, '<zeus-data-root>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, 'Bearer <redacted>')
    .replace(/(?:token|password|secret|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=<redacted>')
    .replace(/(?:^|\s)(\/(?!\/)[^\s,;]*)/gu, (match, absolutePath: string) => match.replace(absolutePath, '<absolute-path>'))
    .replace(/\b[A-Za-z]:\\[^\s,;]*/gu, '<absolute-path>');
  return {
    code: rawCode.slice(0, 128),
    message: (afterWrite ? 'Command failed after its durable write marker; outcome is unknown. ' : 'Command failed before its durable write marker. ') + redacted.slice(0, 512),
    errorSha256: createHash('sha256').update(rawMessage).digest('hex'),
  };
}

async function writeImmutableJson(path: string, value: unknown): Promise<boolean> {
  return writeImmutableBytes(path, Buffer.from(`${canonicalCommandInputJson(value)}\n`, 'utf8'));
}

async function writeImmutableBytes(path: string, bytes: Buffer): Promise<boolean> {
  await ensureSecureDirectory(dirname(path));
  let handle;
  try {
    handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (isFileExistsError(error)) {
      await assertSecureRegularFile(path);
      return false;
    }
    throw error;
  }
  let durable = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    durable = true;
  } finally {
    await handle.close();
    if (!durable) {
      await unlink(path).catch(() => undefined);
      await fsyncDirectory(dirname(path)).catch(() => undefined);
    }
  }
  await fsyncDirectory(dirname(path));
  return true;
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  await ensureSecureDirectory(dirname(path));
  if (await lexicalPathExists(path)) await assertSecureRegularFile(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  let published = false;
  try {
    try {
      await handle.writeFile(`${canonicalCommandInputJson(value)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    published = true;
    await fsyncDirectory(dirname(path));
  } finally {
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const directory = await handle.stat();
    if (!directory.isDirectory()) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger parent is not a directory.');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedJson<T>(path: string, maximumBytes: number): Promise<T> {
  const bytes = await readBoundedBytes(path, maximumBytes);
  if (bytes.byteLength <= 0) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger file is empty.', { file: basename(path) });
  return parseLedgerJson(bytes, path) as T;
}

async function readBoundedBytes(path: string, maximumBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw receiptCorrupt('Main command bounded read budget is invalid.', path);
  await assertSecureDirectory(dirname(path));
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => {
    throw receiptCorrupt('Main command ledger file could not be opened without following links.', path);
  });
  try {
    const before = await handle.stat();
    assertSecureRegularStat(before, path);
    if (before.size < 0 || before.size > maximumBytes) {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger file exceeds its bounded read budget.', { file: basename(path), bytes: before.size, maximumBytes });
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1 - totalBytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, totalBytes);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger file grew beyond its bounded read budget.', { file: basename(path), maximumBytes });
      }
    }
    const [after, pathStatus] = await Promise.all([handle.stat(), lstat(path)]);
    assertSecureRegularStat(after, path);
    assertSecureRegularStat(pathStatus, path);
    if (
      Number(after.dev) !== Number(before.dev) ||
      Number(after.ino) !== Number(before.ino) ||
      Number(pathStatus.dev) !== Number(before.dev) ||
      Number(pathStatus.ino) !== Number(before.ino) ||
      totalBytes !== Number(before.size) ||
      Number(after.size) !== totalBytes ||
      Number(after.mtimeMs) !== Number(before.mtimeMs) ||
      Number(after.ctimeMs) !== Number(before.ctimeMs)
    ) {
      throw receiptCorrupt('Main command ledger file changed while it was being read.', path);
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    await handle.close();
  }
}

function parseLedgerJson(bytes: Buffer, path: string): unknown {
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw receiptCorrupt('Main command ledger JSON is corrupt.', path);
  }
}

async function ensureSecureDirectory(path: string): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  while (true) {
    const status = await lstat(cursor).catch((error: unknown) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (status) {
      if (!status.isDirectory() || status.isSymbolicLink()) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger path contains a non-directory or symbolic link.', { path: cursor });
      if ((await realpath(cursor)) !== cursor) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger ancestor is not canonical.', { path: cursor });
      break;
    }
    missing.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger has no secure existing ancestor.');
    cursor = parent;
  }
  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isFileExistsError(error)) throw error;
    });
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(directory)) !== directory) {
      throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger directory creation crossed an unsafe path.', { path: directory });
    }
    await chmod(directory, 0o700);
    await fsyncDirectory(dirname(directory));
  }
  const beforeChmod = await lstat(target);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!beforeChmod.isDirectory() || beforeChmod.isSymbolicLink() || (currentUid !== null && Number(beforeChmod.uid) !== currentUid)) {
    throw receiptCorrupt('Main command ledger directory is not owned by the current user.', target);
  }
  await chmod(target, 0o700);
  await assertSecureDirectory(target);
}

async function assertSecureDirectory(path: string): Promise<void> {
  const target = resolve(path);
  const status = await lstat(target).catch(() => {
    throw receiptCorrupt('Main command ledger directory is missing.', target);
  });
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!status.isDirectory() || status.isSymbolicLink() || (await realpath(target)) !== target || (Number(status.mode) & 0o777) !== 0o700 || (currentUid !== null && Number(status.uid) !== currentUid)) {
    throw receiptCorrupt('Main command ledger directory must be canonical, current-user owned and mode 0700.', target);
  }
}

async function assertSecureRegularFile(path: string): Promise<void> {
  const status = await lstat(path);
  if (status.isSymbolicLink()) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger refuses symbolic-link files.', { file: basename(path) });
  assertSecureRegularStat(status, path);
}

function assertSecureRegularStat(status: Awaited<ReturnType<typeof lstat>>, path: string): void {
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const mode = Number(status.mode) & 0o777;
  const uid = Number(status.uid);
  if (!status.isFile() || mode !== 0o600 || (currentUid !== null && uid !== currentUid)) {
    throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_RECEIPT_CORRUPT', 'Main command ledger file must be a current-user regular file with mode 0600.', {
      file: basename(path),
      mode,
      ownerMatches: currentUid === null || uid === currentUid,
    });
  }
}

async function lexicalPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function readLedgerDirectory(path: string): Promise<string[]> {
  await assertSecureDirectory(path);
  const entries = await readdir(path).catch(() => {
    throw receiptCorrupt('Main command ledger directory could not be read.', path);
  });
  if (entries.length > 100_000) throw receiptCorrupt('Main command ledger directory exceeds its entry budget.', path);
  return entries.sort();
}

function assertShardName(value: string): void {
  if (!/^[a-f0-9]{2}$/u.test(value)) throw receiptCorrupt('Main command ledger contains an invalid shard directory.');
}

function commandIdFromLedgerFile(file: string, shard: string): string {
  if (!file.endsWith('.json')) throw receiptCorrupt('Main command ledger shard contains an unexpected file.', file);
  const commandId = file.slice(0, -'.json'.length);
  try {
    assertSafeCommandId(commandId);
  } catch {
    throw receiptCorrupt('Main command ledger filename contains an invalid command identity.', file);
  }
  if (shardFor(commandId) !== shard) throw receiptCorrupt('Main command ledger filename is stored in the wrong shard.', file);
  return commandId;
}

function isAtomicLedgerTempFile(file: string): boolean {
  return /^\.[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json\.[a-f0-9-]{36}\.tmp$/u.test(file);
}

function assertSafeCommandId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) throw new MainCommandLedgerError('ZEUS_MAIN_COMMAND_REQUEST_INVALID', 'Main command id is not filesystem safe.');
  return value;
}

function shardFor(commandId: string): string {
  return createHash('sha256').update(commandId).digest('hex').slice(0, 2);
}

function isPathInside(path: string, root: string): boolean {
  const delta = relative(resolve(root), resolve(path));
  return Boolean(delta) && !delta.startsWith('..') && !delta.includes('\0');
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'EEXIST';
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
