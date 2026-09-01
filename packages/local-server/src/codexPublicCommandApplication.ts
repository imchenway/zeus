import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { ArtifactStore, CommandDeliveryRepository, CommandDeliveryStoreError, type ArtifactRef, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type ZeusDatabase } from '@zeus/storage';
import { createCommandValidation } from './commandApplicationPrimitives.js';

export const codexPublicCommandTypes = {
  accountLoginStart: 'codex.account.login.start',
  accountLoginCancel: 'codex.account.login.cancel',
  remoteControlEnable: 'codex.remote_control.enable',
  remoteControlDisable: 'codex.remote_control.disable',
  remoteControlPairingStart: 'codex.remote_control.pairing.start',
  remoteControlClientRevoke: 'codex.remote_control.client.revoke',
  configurationImport: 'codex.configuration.import',
  configurationActivate: 'codex.configuration.activate',
  skillInstall: 'skill.install',
  skillRemove: 'skill.remove',
  legacyImportStart: 'codex.legacy_import.start',
} as const;

export const codexPublicCommandScopeIds = {
  account: 'codex-account',
  remoteControl: 'codex-remote-control',
  configuration: 'codex-configuration',
  skills: 'zeus-skills',
  legacyImport: 'codex-legacy-import',
} as const;

export type CodexPublicCommandType = (typeof codexPublicCommandTypes)[keyof typeof codexPublicCommandTypes];
export type CodexPublicCommandScopeKind = Extract<CommandScopeKind, 'provider_account' | 'provider_remote_control' | 'provider_configuration' | 'provider_import'>;
export type CodexPublicCommandPayload = { operationIdentity: string; inputSha256: string };

export interface CodexPublicMutationRequest<TInput extends object> {
  command: CommandEnvelope<CodexPublicCommandPayload>;
  input: TInput;
}

export interface ParsedCodexPublicMutation<TInput extends object> {
  command: CommandEnvelope<CodexPublicCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface CodexPublicMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

export class CodexPublicCommandApplicationError extends Error {
  readonly name = 'CodexPublicCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_CODEX_PUBLIC_COMMAND_INVALID' | 'ZEUS_CODEX_PUBLIC_COMMAND_RESULT_UNAVAILABLE',
    message: string,
    readonly statusCode: 400 | 500,
  ) {
    super(message);
  }
}

const resultArtifactGeneration = 'codex-public-command-result-v1';
const maximumReplayResultBytes = 16 * 1024 * 1024;

/** Codex 公开控制面的唯一 External Operation Command 边界。 */
export class CodexPublicCommandApplicationService {
  private readonly activeExecutions = new Map<string, Promise<CodexPublicMutationResult<unknown>>>();

  constructor(
    private readonly options: {
      db: ZeusDatabase;
      deliveries: CommandDeliveryRepository;
      artifacts: ArtifactStore;
      now(): Date;
    },
  ) {}

  parse<TInput extends object>(input: { value: unknown; commandType: CodexPublicCommandType; scopeKind: CodexPublicCommandScopeKind; scopeId: string }): ParsedCodexPublicMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<CodexPublicCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind || command.scope.id !== input.scopeId) throw invalidCommand('Command scope does not match the addressed Codex resource.');
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = sha256(canonicalCommandInputJson(commandInput));
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeExternal<TInput extends object, TResult>(input: {
    parsed: ParsedCodexPublicMutation<TInput>;
    destinationId: string;
    resourceId: string;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateBusinessState?(result: TResult): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<CodexPublicMutationResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExecutions.get(activeKey);
    if (active) return active as Promise<CodexPublicMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExecutions.delete(activeKey));
    this.activeExecutions.set(activeKey, execution as Promise<CodexPublicMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TResult>(input: {
    parsed: ParsedCodexPublicMutation<TInput>;
    destinationId: string;
    resourceId: string;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateBusinessState?(result: TResult): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<CodexPublicMutationResult<TResult>> {
    let outboxId: string;
    try {
      const prepared = this.options.deliveries.acceptAndPrepare({
        envelope: input.parsed.command,
        requestSha256: input.parsed.inputSha256,
        destinationKind: 'external_operation',
        destinationId: input.destinationId,
        resourceId: input.resourceId,
        externalOperationId: input.parsed.operationIdentity,
        occurredAt: this.options.now().toISOString(),
      });
      outboxId = prepared.outbox.id;
    } catch (error) {
      const accepted = acceptedReplayReceipt(this.options.deliveries, input.parsed.command.commandId, error);
      if (!accepted) throw error;
      return {
        commandId: accepted.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: await this.readAcceptedResult<TResult>(accepted, input.parsed.command.commandType),
      };
    }

    let writeStarted = false;
    try {
      await input.beforeWrite?.();
      this.options.deliveries.markExternalWriteStarted({ outboxId, occurredAt: this.options.now().toISOString() });
      writeStarted = true;
      const result = await input.invoke();
      const resultArtifact = await this.options.artifacts.putJson({
        value: result,
        owner: resultOwner(input.parsed.command.commandId),
        mimeType: 'application/vnd.zeus.codex-public-command-result+json',
        compression: 'gzip-v1',
        createdAt: this.options.now().toISOString(),
      });
      this.options.db.durableTransactionSync(() => {
        input.mutateBusinessState?.(result);
        this.options.deliveries.recordOutcomeInCurrentTransaction({
          outboxId,
          outcome: 'accepted',
          evidence: acceptedEvidence(input.parsed, resultArtifact),
          occurredAt: this.options.now().toISOString(),
        });
      });
      return {
        commandId: input.parsed.command.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: false,
        result,
      };
    } catch (error) {
      const explicitlyRejected = writeStarted && (input.isExplicitRejection?.(error) ?? isExplicitProviderRejection(error));
      const outcome: CommandDeliveryOutcome = explicitlyRejected ? 'explicitly_rejected' : writeStarted ? 'outcome_unknown_after_write' : 'failed_before_write';
      try {
        this.options.deliveries.recordOutcome({
          outboxId,
          outcome,
          evidence: {
            source: 'codex_public_command_application',
            commandType: input.parsed.command.commandType,
            externalOperationId: input.parsed.operationIdentity,
            result: outcome,
            error: serializeError(error),
          },
          occurredAt: this.options.now().toISOString(),
        });
      } catch (receiptError) {
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], 'Codex 公开操作与失败回执同时未能收口。');
      }
      throw error;
    }
  }

  private async readAcceptedResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): Promise<TResult> {
    try {
      const evidence = JSON.parse(receipt.evidenceJson) as Record<string, unknown>;
      const artifact = requireRecord(evidence.resultArtifact, 'receipt.evidence.resultArtifact');
      if (evidence.source !== 'codex_public_command_application' || evidence.commandType !== commandType) throw new Error('Accepted evidence identity mismatch.');
      const stored = await this.options.artifacts.readAuthorized({
        sha256: validSha256(artifact.sha256, 'receipt.evidence.resultArtifact.sha256'),
        owner: { kind: 'command_delivery_result', id: receipt.commandId },
        maximumContentBytes: maximumReplayResultBytes,
      });
      if (artifact.contentSha256 !== stored.ref.contentSha256 || artifact.contentByteLength !== stored.ref.contentByteLength || artifact.generationId !== resultArtifactGeneration) {
        throw new Error('Accepted result ArtifactRef does not match durable content.');
      }
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as TResult;
    } catch (error) {
      if (error instanceof CodexPublicCommandApplicationError) throw error;
      throw new CodexPublicCommandApplicationError('ZEUS_CODEX_PUBLIC_COMMAND_RESULT_UNAVAILABLE', `Accepted Codex command ${receipt.commandId} is missing its immutable result.`, 500);
    }
  }
}

function acceptedEvidence(parsed: ParsedCodexPublicMutation<object>, artifact: ArtifactRef): Record<string, unknown> {
  return {
    source: 'codex_public_command_application',
    commandType: parsed.command.commandType,
    externalOperationId: parsed.operationIdentity,
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

function acceptedReplayReceipt(deliveries: CommandDeliveryRepository, commandId: string, error: unknown): CommandDeliveryReceiptRecord | null {
  if (!isCommandDeliveryError(error) || error.code !== 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED') return null;
  const latest = deliveries.get(commandId)?.attempts.at(-1);
  return latest?.outcome === 'accepted' && latest.receipt ? latest.receipt : null;
}

function isExplicitProviderRejection(error: unknown): boolean {
  return Boolean(error) && typeof error === 'object' && (error as { dispatchDisposition?: unknown }).dispatchDisposition === 'runtime_rejected';
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

function isCommandDeliveryError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = 'code' in error && (typeof error.code === 'string' || typeof error.code === 'number') ? error.code : null;
    return { code, name: error.name, message: error.message, dispatchDisposition: 'dispatchDisposition' in error ? error.dispatchDisposition : null };
  }
  return { code: null, name: typeof error, message: String(error), dispatchDisposition: null };
}

const { requireRecord, assertExactKeys, boundedIdentity, validSha256 } = createCommandValidation(invalidCommand);

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalidCommand(message: string): CodexPublicCommandApplicationError {
  return new CodexPublicCommandApplicationError('ZEUS_CODEX_PUBLIC_COMMAND_INVALID', message, 400);
}

export function codexPublicCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof CodexPublicCommandApplicationError) return { statusCode: error.statusCode, payload: { error: error.code, message: error.message } };
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return {
    statusCode,
    payload: {
      error: error.code,
      message: error.message,
      ...(recoveryRequired ? { recoveryRequired: true as const } : {}),
    },
  };
}
