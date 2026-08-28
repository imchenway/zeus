import { createHash } from 'node:crypto';
import { canonicalCommandInputJson, CommandEnvelopeError, commandEnvelopeSchemaGeneration, parseCommandEnvelope, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';
import { CommandDeliveryRepository, CommandDeliveryStoreError, type CommandDeliveryOutcome, type CommandDeliveryReceiptRecord, type CommandOutboxRecord, type ZeusDatabase } from '@zeus/storage';

export const workManagementCommandTypes = {
  projectCreate: 'work_management.project.create',
  projectUpdate: 'work_management.project.update',
  projectWorkspaceUpdate: 'work_management.project.workspace.update',
  projectDelete: 'work_management.project.delete',
  projectArchive: 'work_management.project.archive',
  projectRestore: 'work_management.project.restore',
  projectDefaultTemplateSet: 'work_management.project.default_template.set',
  taskCreate: 'work_management.task.create',
  taskStatusUpdate: 'work_management.task.status.update',
  taskManagementStatusUpdate: 'work_management.task.management_status.update',
  taskBoardUpdate: 'work_management.task_board.update',
  taskBoardMove: 'work_management.task_board.move',
  taskRun: 'work_management.task.run',
  taskPause: 'work_management.task.pause',
  taskContinue: 'work_management.task.continue',
  taskCancel: 'work_management.task.cancel',
  taskRetry: 'work_management.task.retry',
  taskUpdate: 'work_management.task.update',
  taskTagsUpdate: 'work_management.task.tags.update',
  taskRelationshipsUpdate: 'work_management.task.relationships.update',
  taskDelete: 'work_management.task.delete',
  taskArchive: 'work_management.task.archive',
  taskRestore: 'work_management.task.restore',
  taskTemplateCreate: 'work_management.task_template.create',
  taskFromTemplateCreate: 'work_management.task.from_template.create',
  taskFromGraphConversationCreate: 'work_management.task.from_graph_conversation.create',
  taskFromGraphNodeCreate: 'work_management.task.from_graph_node.create',
  taskFromGraphViewCreate: 'work_management.task.from_graph_view.create',
  taskGraphNodeLink: 'work_management.task.graph_node.link',
  taskIntegrationStart: 'work_management.task.integration.start',
  taskIntegrationConflictResolve: 'work_management.task.integration.conflict.resolve',
  taskIntegrationFinalize: 'work_management.task.integration.finalize',
  taskIntegrationPush: 'work_management.task.integration.push',
  digitalEmployeeTemplateCreate: 'work_management.digital_employee_template.create',
  digitalEmployeeTemplateUpdate: 'work_management.digital_employee_template.update',
  digitalEmployeeTemplateDelete: 'work_management.digital_employee_template.delete',
  digitalEmployeeCreate: 'work_management.digital_employee.create',
  digitalEmployeeUpdate: 'work_management.digital_employee.update',
  digitalEmployeeDelete: 'work_management.digital_employee.delete',
  digitalEmployeeAutomationCreate: 'work_management.digital_employee_automation.create',
  digitalEmployeeAutomationUpdate: 'work_management.digital_employee_automation.update',
  digitalEmployeeAutomationDelete: 'work_management.digital_employee_automation.delete',
  digitalEmployeeAutomationRun: 'work_management.digital_employee_automation.run',
  digitalEmployeeExecutionCreate: 'work_management.digital_employee_execution.create',
  digitalEmployeeExecutionHandoff: 'work_management.digital_employee_execution.handoff',
  digitalEmployeeExecutionRework: 'work_management.digital_employee_execution.rework',
  digitalEmployeeExecutionFinalize: 'work_management.digital_employee_execution.finalize',
  digitalEmployeeExecutionAdoptLegacy: 'work_management.digital_employee_execution.adopt_legacy',
  digitalEmployeeExecutionRetry: 'work_management.digital_employee_execution.retry',
  digitalEmployeeExecutionCancel: 'work_management.digital_employee_execution.cancel',
  taskWorkflowInitialize: 'work_management.task.workflow.initialize',
  taskStageUpdate: 'work_management.task.stage.update',
  taskStageDeliverableCapture: 'work_management.task.stage.deliverable.capture',
  taskStageDeliverableCreate: 'work_management.task.stage.deliverable.create',
  taskStageSkip: 'work_management.task.stage.skip',
  taskStageDeliverableAccept: 'work_management.task.stage.deliverable.accept',
  taskStageDeliverableRequestChanges: 'work_management.task.stage.deliverable.request_changes',
} as const;

export type WorkManagementCommandType = (typeof workManagementCommandTypes)[keyof typeof workManagementCommandTypes];
export type WorkManagementCommandPayload = { operationIdentity: string; inputSha256: string };

export const workManagementChildEffectCommandTypes = {
  taskStatusTelegramNotify: 'work_management.task.status.telegram_notify',
} as const;

export interface TaskStatusTelegramEffectInput {
  taskId: string;
  status: string;
}

export interface PreparedTaskStatusTelegramEffect {
  parsed: ParsedWorkManagementMutation<TaskStatusTelegramEffectInput>;
  externalOperationId: string;
}

export interface WorkManagementMutationRequest<TInput extends object> {
  command: CommandEnvelope<WorkManagementCommandPayload>;
  input: TInput;
}

export interface ParsedWorkManagementMutation<TInput extends object> {
  command: CommandEnvelope<WorkManagementCommandPayload>;
  input: TInput;
  inputSha256: string;
  operationIdentity: string;
}

export interface WorkManagementMutationResult<TResult> {
  commandId: string;
  operationIdentity: string;
  replayed: boolean;
  result: TResult;
}

const workManagementExternalOutcomes = new WeakMap<object, Exclude<CommandDeliveryOutcome, 'accepted'>>();

interface PreparedWorkManagementExternal {
  state: 'prepared';
  parsed: ParsedWorkManagementMutation<object>;
  outbox: CommandOutboxRecord;
}

interface ReplayedWorkManagementExternal<TResult> {
  state: 'accepted_replay';
  parsed: ParsedWorkManagementMutation<object>;
  outbox: CommandOutboxRecord;
  result: TResult;
}

type WorkManagementExternalPreparation<TResult> = PreparedWorkManagementExternal | ReplayedWorkManagementExternal<TResult>;

export class WorkManagementCommandApplicationError extends Error {
  readonly name = 'WorkManagementCommandApplicationError';

  constructor(
    readonly code: 'ZEUS_WORK_MANAGEMENT_COMMAND_INVALID' | 'ZEUS_WORK_MANAGEMENT_RESULT_MISSING',
    message: string,
    readonly statusCode: 400 | 409 | 500,
  ) {
    super(message);
  }
}

/**
 * 项目、任务、模板和图谱建任务共享的公开命令边界。Core mutation 与 accepted receipt
 * 在同一耐久事务提交；真实 Git/Runtime 操作必须走带 write marker 的 external_operation。
 */
export class WorkManagementCommandApplication {
  private readonly activeExternalExecutions = new Map<string, Promise<WorkManagementMutationResult<unknown>>>();

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
    commandType: WorkManagementCommandType;
    scopeKind: Extract<CommandScopeKind, 'project' | 'task' | 'settings'>;
    expectedScopeId: (parsed: { input: TInput; operationIdentity: string }) => string;
  }): ParsedWorkManagementMutation<TInput> {
    const request = requireRecord(input.value, 'Body');
    assertExactKeys(request, ['command', 'input'], input.commandType);
    const command = parseCommandEnvelope<WorkManagementCommandPayload>(request.command);
    if (command.commandType !== input.commandType) throw invalidCommand(`Expected commandType ${input.commandType}.`);
    if (command.scope.kind !== input.scopeKind) throw invalidCommand(`Expected ${input.scopeKind} command scope.`);
    assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], input.commandType);
    const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
    const declaredInputSha256 = validSha256(command.payload.inputSha256, 'command.payload.inputSha256');
    const commandInput = requireRecord(request.input, 'Body.input') as TInput;
    const inputSha256 = workManagementInputSha256(commandInput);
    if (inputSha256 !== declaredInputSha256) throw invalidCommand('Command inputSha256 does not match Body.input.');
    if (command.scope.id !== input.expectedScopeId({ input: commandInput, operationIdentity })) {
      throw invalidCommand('Command scope does not match the addressed work-management resource.');
    }
    return { command, input: commandInput, inputSha256, operationIdentity };
  }

  executeCore<TInput extends object, TResult>(input: { parsed: ParsedWorkManagementMutation<TInput>; destinationId: string; resourceId: string; mutateBusinessState(): TResult }): WorkManagementMutationResult<TResult> {
    let result: TResult | undefined;
    const evidence: WorkManagementResultEvidence<TResult> = {
      source: 'work_management_application',
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
    const resolved = delivery.created ? result : readWorkManagementResult<TResult>(delivery.receipt, input.parsed.command.commandType);
    if (resolved === undefined) throw missingResult(input.parsed.command.commandId);
    return {
      commandId: delivery.inbox.commandId,
      operationIdentity: input.parsed.operationIdentity,
      replayed: !delivery.created,
      result: resolved,
    };
  }

  /**
   * Task status 是 Core 事实，Telegram 是从该事实派生的可恢复外部效果。子命令必须在父 Core
   * transaction 内准备；提交后的 dispatcher 才允许设置 write marker 并访问 Telegram。
   */
  enqueueTaskStatusTelegramEffectInCurrentTransaction(input: { parent: ParsedWorkManagementMutation<object>; taskId: string; status: string }): PreparedTaskStatusTelegramEffect {
    const taskId = boundedIdentity(input.taskId, 'taskStatusTelegram.taskId');
    const status = boundedTaskStatus(input.status);
    const effectInput = { taskId, status };
    const inputSha256 = workManagementInputSha256(effectInput);
    const childDigest = createHash('sha256').update(`${input.parent.command.commandId}\0${input.parent.operationIdentity}\0${taskId}\0${status}`).digest('hex');
    const operationIdentity = `task-status-telegram:${status}:${childDigest}`;
    const command: CommandEnvelope<WorkManagementCommandPayload> = {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_work_management_child_${childDigest}`,
      commandType: workManagementChildEffectCommandTypes.taskStatusTelegramNotify,
      actor: input.parent.command.actor,
      scope: { kind: 'task', id: taskId },
      expectedRevision: null,
      idempotencyKey: `${workManagementChildEffectCommandTypes.taskStatusTelegramNotify}:${childDigest}`,
      issuedAt: input.parent.command.issuedAt,
      payload: { operationIdentity, inputSha256 },
    };
    const parsed: ParsedWorkManagementMutation<TaskStatusTelegramEffectInput> = {
      command,
      input: effectInput,
      inputSha256,
      operationIdentity,
    };
    const externalOperationId = `task-status-telegram:${childDigest}`;
    this.options.deliveries.acceptAndPrepareInCurrentTransaction({
      envelope: command,
      requestSha256: inputSha256,
      destinationKind: 'external_operation',
      destinationId: workManagementTelegramDestinationId,
      resourceId: taskId,
      externalOperationId,
      occurredAt: this.options.now().toISOString(),
    });
    return { parsed, externalOperationId };
  }

  listPreparedTaskStatusTelegramEffects(afterCommandId: string | null = null, limit = 256): PreparedTaskStatusTelegramEffect[] {
    return this.options.deliveries.listPreparedExternalByDestination(workManagementTelegramDestinationId, afterCommandId, limit).flatMap((snapshot) => {
      const latest = snapshot.attempts.at(-1);
      if (
        snapshot.inbox.commandType !== workManagementChildEffectCommandTypes.taskStatusTelegramNotify ||
        latest?.destinationKind !== 'external_operation' ||
        latest.destinationId !== workManagementTelegramDestinationId ||
        latest.state !== 'prepared' ||
        !latest.externalOperationId
      ) {
        return [];
      }
      const parsed = parseTaskStatusTelegramEffect(snapshot.inbox.envelopeJson, snapshot.inbox.requestSha256);
      return [{ parsed, externalOperationId: latest.externalOperationId }];
    });
  }

  dispatchTaskStatusTelegramEffect<TResult>(input: {
    effect: PreparedTaskStatusTelegramEffect;
    beforeWrite(): Promise<void>;
    invoke(): Promise<TResult>;
    mutateAcceptedBusinessState(result: TResult): TResult;
    mutateFailureBusinessState(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<WorkManagementMutationResult<TResult>> {
    return this.executeExternal({
      parsed: input.effect.parsed,
      destinationId: workManagementTelegramDestinationId,
      resourceId: input.effect.parsed.input.taskId,
      externalOperationId: input.effect.externalOperationId,
      beforeWrite: input.beforeWrite,
      invoke: input.invoke,
      mutateAcceptedBusinessState: input.mutateAcceptedBusinessState,
      mutateFailureBusinessState: input.mutateFailureBusinessState,
      isExplicitRejection: input.isExplicitRejection,
    });
  }

  replayAcceptedCore<TInput extends object, TResult>(input: { parsed: ParsedWorkManagementMutation<TInput>; destinationId: string; resourceId: string }): WorkManagementMutationResult<TResult> | undefined {
    const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
    if (latest?.destinationKind !== 'core_application' || latest.outcome !== 'accepted' || !latest.receipt) return undefined;
    return this.executeCore({
      ...input,
      mutateBusinessState: () => {
        throw new Error('Accepted work-management Core command replay must never execute its mutation.');
      },
    });
  }

  replayAccepted<TInput extends object, TResult>(input: { parsed: ParsedWorkManagementMutation<TInput>; destinationIds: readonly string[]; resourceId: string }): WorkManagementMutationResult<TResult> | undefined {
    const latest = this.options.deliveries.get(input.parsed.command.commandId)?.attempts.at(-1);
    if (
      !latest?.receipt ||
      latest.outcome !== 'accepted' ||
      (latest.destinationKind !== 'core_application' && latest.destinationKind !== 'external_operation') ||
      !input.destinationIds.includes(latest.destinationId) ||
      latest.resourceId !== input.resourceId
    ) {
      return undefined;
    }
    return {
      commandId: input.parsed.command.commandId,
      operationIdentity: input.parsed.operationIdentity,
      replayed: true,
      result: readWorkManagementResult<TResult>(latest.receipt, input.parsed.command.commandType),
    };
  }

  executeExternal<TInput extends object, TInvoked, TResult>(input: {
    parsed: ParsedWorkManagementMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    mutatePreparedBusinessState?(): void;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TInvoked>;
    mutateAcceptedBusinessState(result: TInvoked): TResult;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<WorkManagementMutationResult<TResult>> {
    const activeKey = `${input.parsed.command.commandId}:${input.parsed.inputSha256}`;
    const active = this.activeExternalExecutions.get(activeKey);
    if (active) return active as Promise<WorkManagementMutationResult<TResult>>;
    const execution = this.executeExternalOnce(input).finally(() => this.activeExternalExecutions.delete(activeKey));
    this.activeExternalExecutions.set(activeKey, execution as Promise<WorkManagementMutationResult<unknown>>);
    return execution;
  }

  private async executeExternalOnce<TInput extends object, TInvoked, TResult>(input: {
    parsed: ParsedWorkManagementMutation<TInput>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    mutatePreparedBusinessState?(): void;
    beforeWrite?(): Promise<void>;
    invoke(): Promise<TInvoked>;
    mutateAcceptedBusinessState(result: TInvoked): TResult;
    mutateFailureBusinessState?(outcome: Exclude<CommandDeliveryOutcome, 'accepted'>, error: unknown): void;
    isExplicitRejection?(error: unknown): boolean;
  }): Promise<WorkManagementMutationResult<TResult>> {
    const preparation = this.prepareExternal<TResult>({
      parsed: input.parsed,
      destinationId: input.destinationId,
      resourceId: input.resourceId,
      externalOperationId: input.externalOperationId,
      mutatePreparedBusinessState: input.mutatePreparedBusinessState,
    });
    if (preparation.state === 'accepted_replay') {
      return {
        commandId: preparation.outbox.commandId,
        operationIdentity: input.parsed.operationIdentity,
        replayed: true,
        result: preparation.result,
      };
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
              source: 'work_management_external_operation',
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
        if (!isReceiptConflict(receiptError)) throw new AggregateError([error, receiptError], '工作管理外部操作与失败回执同时未能收口。');
      }
      if ((typeof error === 'object' && error !== null) || typeof error === 'function') workManagementExternalOutcomes.set(error as object, outcome);
      throw error;
    }
  }

  private prepareExternal<TResult>(input: {
    parsed: ParsedWorkManagementMutation<object>;
    destinationId: string;
    resourceId: string;
    externalOperationId: string;
    mutatePreparedBusinessState?(): void;
  }): WorkManagementExternalPreparation<TResult> {
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
      return { state: 'accepted_replay', parsed: input.parsed, outbox: latest, result: readWorkManagementResult<TResult>(latest.receipt, input.parsed.command.commandType) };
    }
  }
}

interface WorkManagementResultEvidence<TResult> {
  source: 'work_management_application';
  commandType: string;
  operationIdentity: string;
  result: TResult | null;
}

export function workManagementInputSha256(input: unknown): string {
  return createHash('sha256').update(canonicalCommandInputJson(input)).digest('hex');
}

function externalEvidence<TResult>(parsed: ParsedWorkManagementMutation<object>, externalOperationId: string | null, result: TResult): Record<string, unknown> {
  return {
    source: 'work_management_external_operation',
    commandType: parsed.command.commandType,
    operationIdentity: parsed.operationIdentity,
    externalOperationId,
    result: boundedReplayResult(result, parsed.command.commandId),
  };
}

function readWorkManagementResult<TResult>(receipt: CommandDeliveryReceiptRecord, commandType: string): TResult {
  try {
    const evidence = JSON.parse(receipt.evidenceJson) as { source?: unknown; commandType?: unknown; result?: TResult | null };
    if ((evidence.source !== 'work_management_application' && evidence.source !== 'work_management_external_operation') || evidence.commandType !== commandType || evidence.result === undefined || evidence.result === null) {
      throw missingResult(receipt.commandId);
    }
    return evidence.result;
  } catch (error) {
    if (error instanceof WorkManagementCommandApplicationError) throw error;
    throw missingResult(receipt.commandId);
  }
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
  if (
    typeof value !== 'string' ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > 512 ||
    Array.from(value).some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || point === 127;
    })
  ) {
    throw invalidCommand(`${field} is invalid.`);
  }
  return value;
}

function validSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/u.test(value)) throw invalidCommand(`${field} must be a lowercase SHA-256.`);
  return value;
}

const maximumReplayResultBytes = 64 * 1024;
const maximumErrorMessageBytes = 2 * 1024;
const workManagementTelegramDestinationId = 'work-management-telegram-notification';
const taskStatusValues = new Set(['draft', 'ready', 'running', 'waiting_confirmation', 'paused', 'completed', 'failed', 'cancelled']);

function parseTaskStatusTelegramEffect(envelopeJson: string, requestSha256: string): ParsedWorkManagementMutation<TaskStatusTelegramEffectInput> {
  let command: CommandEnvelope<WorkManagementCommandPayload>;
  try {
    command = parseCommandEnvelope<WorkManagementCommandPayload>(JSON.parse(envelopeJson));
  } catch (error) {
    if (error instanceof CommandEnvelopeError) throw error;
    throw invalidCommand('Stored Telegram child command envelope is invalid.');
  }
  if (command.commandType !== workManagementChildEffectCommandTypes.taskStatusTelegramNotify || command.scope.kind !== 'task') {
    throw invalidCommand('Stored Telegram child command has an invalid type or scope.');
  }
  assertExactKeys(command.payload, ['inputSha256', 'operationIdentity'], command.commandType);
  const operationIdentity = boundedIdentity(command.payload.operationIdentity, 'command.payload.operationIdentity');
  const match = /^task-status-telegram:([^:]+):[0-9a-f]{64}$/u.exec(operationIdentity);
  if (!match) throw invalidCommand('Stored Telegram child operation identity is invalid.');
  const input = { taskId: command.scope.id, status: boundedTaskStatus(match[1]) };
  const inputSha256 = workManagementInputSha256(input);
  if (inputSha256 !== requestSha256 || inputSha256 !== command.payload.inputSha256) {
    throw invalidCommand('Stored Telegram child input digest is inconsistent.');
  }
  return { command, input, inputSha256, operationIdentity };
}

function boundedTaskStatus(value: string): string {
  if (!taskStatusValues.has(value)) throw invalidCommand('Task status is invalid for a Telegram child effect.');
  return value;
}

function boundedReplayResult<TResult>(result: TResult, commandId: string): TResult {
  const json = JSON.stringify(result);
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maximumReplayResultBytes) {
    throw new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_RESULT_MISSING', `Work-management command ${commandId} result exceeds the bounded inline replay budget; use an ArtifactRef.`, 500);
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

function invalidCommand(message: string): WorkManagementCommandApplicationError {
  return new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', message, 400);
}

function missingResult(commandId: string): WorkManagementCommandApplicationError {
  return new WorkManagementCommandApplicationError('ZEUS_WORK_MANAGEMENT_RESULT_MISSING', `Accepted work-management command ${commandId} is missing its immutable result.`, 500);
}

function isCommandDeliveryStoreError(error: unknown): error is CommandDeliveryStoreError {
  return Boolean(error) && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' && (error as { code: string }).code.startsWith('ZEUS_COMMAND_DELIVERY_');
}

function isReceiptConflict(error: unknown): boolean {
  return isCommandDeliveryStoreError(error) && error.code === 'ZEUS_COMMAND_DELIVERY_RECEIPT_CONFLICT';
}

export function workManagementCommandHttpError(error: unknown): { statusCode: number; payload: { error: string; message: string; recoveryRequired?: true } } | null {
  if (error instanceof WorkManagementCommandApplicationError) return { statusCode: error.statusCode, payload: { error: error.code, message: error.message } };
  if (error instanceof CommandEnvelopeError) return { statusCode: 400, payload: { error: error.code, message: error.message } };
  if (!isCommandDeliveryStoreError(error)) return null;
  const recoveryRequired = error.code === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED';
  const statusCode = error.code === 'ZEUS_COMMAND_DELIVERY_NOT_FOUND' ? 404 : error.code === 'ZEUS_COMMAND_DELIVERY_INVALID_ARGUMENT' ? 400 : error.code === 'ZEUS_COMMAND_DELIVERY_SCHEMA_CONFLICT' ? 500 : 409;
  return { statusCode, payload: { error: error.code, message: error.message, ...(recoveryRequired ? { recoveryRequired: true as const } : {}) } };
}

export function workManagementExternalOutcome(error: unknown): Exclude<CommandDeliveryOutcome, 'accepted'> | null {
  return (typeof error === 'object' && error !== null) || typeof error === 'function' ? (workManagementExternalOutcomes.get(error as object) ?? null) : null;
}
