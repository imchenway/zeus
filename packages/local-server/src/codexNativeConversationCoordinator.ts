import {createHash, randomUUID} from 'node:crypto';
import {realpathSync, statSync} from 'node:fs';
import {dirname, extname, isAbsolute, relative, resolve} from 'node:path';
import type {
    CodexAppServerEvent,
    CodexAppServerManager,
    CodexCommandApprovalDecision,
    CodexSandboxPolicy,
    CodexServerRequestResponse,
    CodexThreadSnapshot
} from '@zeus/ai-runtime';
import {
    type CodexMcpServerStartupState,
    type ConversationCollaborationMode,
    type ConversationItemPhase,
    ConversationItemRepository,
    type ConversationItemType,
    type ConversationPermissionMode,
    ConversationPlanActionRepository,
    ConversationRepository,
    type ConversationServerRequestKind,
    ConversationServerRequestRepository,
    ConversationSubmissionRepository,
    ConversationTurnRepository,
    SettingRepository,
    type ZeusConversationServerRequestRecord,
    type ZeusConversationSubmissionRecord,
    type ZeusConversationTurnRecord,
    type ZeusConversationWithMessagesRecord,
    type ZeusDatabase,
} from '@zeus/storage';
import type {
    CodexNativeConversationCoordinator,
    InterruptNativeTurnInput,
    NativeAcceptedOperation,
    NativeConversationAttachmentInput,
    NativeConversationRunState,
    NativeProviderWriteLifecycle,
    NativeQueueSnapshot,
    NativeTurnResult,
    RespondNativeRequestInput,
    RespondPlanImplementationRequestInput,
    RestoreArchivedConversationInput,
    SendQueuedNowInput,
    SnoozeNativeRequestInput,
    StartNativeEphemeralConversationInput,
    StartProjectConversationInput,
    StartTaskConversationInput,
    SubmitNativeMessageInput,
    WaitForNativeTurnResultInput,
} from './codexNativeConversationContracts.js';
import {
    parseCanonicalRequestUserInputQuestions,
    validateCanonicalRequestUserInputAnswers
} from './codexNativeRuiValidation.js';

interface ConversationDispatchContext {
  projectId: string;
  projectLocalPath: string;
  taskId: string | null;
  model: string;
  effort?: string;
  allowCodeChanges: boolean;
  allowTests: boolean;
  allowGitCommit: boolean;
  permissionMode: ConversationPermissionMode;
  allowedAttachmentRoots?: string[];
  bypassConcurrency?: boolean;
    workMode: ConversationCollaborationMode;
  applyLegacyTaskGuards?: boolean;
  ephemeral?: boolean;
  additionalContext?: Record<string, unknown>;
}

interface PersistedSubmissionInput {
  text: string;
  attachments?: NativeConversationAttachmentInput[];
  context: ConversationDispatchContext;
    displayText?: string;
    origin?: 'implement_plan';
    planItemId?: string;
}

interface NativeTurnResultWaiter {
  resolve(result: NativeTurnResult): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface CreateCodexNativeConversationCoordinatorOptions {
  manager: CodexAppServerManager;
  enabled?: boolean;
  commandPath: string | (() => string);
  externalAgentHome?: string;
  db: ZeusDatabase;
  conversations: ConversationRepository;
  turns: ConversationTurnRepository;
  items: ConversationItemRepository;
  submissions: ConversationSubmissionRepository;
  requests: ConversationServerRequestRepository;
    planActions?: ConversationPlanActionRepository;
  settings: SettingRepository;
  getConcurrency: (projectId: string) => { project: number; global: number; maxPerProject: number; maxGlobal: number };
  broadcast: (type: string, payload: Record<string, unknown>) => void;
  now?: () => string;
  operationId?: () => string;
  turnResultTimeoutMs?: number;
}

export interface CodexNativeConversationRuntime extends CodexNativeConversationCoordinator {
  startEphemeralConversation(input: StartNativeEphemeralConversationInput): Promise<NativeAcceptedOperation>;
  waitForTurnResult(input: WaitForNativeTurnResultInput): Promise<NativeTurnResult>;
  close(input?: { mode: 'handoff' | 'final' }): Promise<void>;
}

const processedEventsSettingKey = 'codex.native.processed_provider_events';
const providerEventErrorsSettingKey = 'codex.native.provider_event_errors';

export function createCodexNativeConversationCoordinator(options: CreateCodexNativeConversationCoordinatorOptions): CodexNativeConversationRuntime {
  const now = options.now ?? (() => new Date().toISOString());
  const operationId = options.operationId ?? randomUUID;
    const planActions = options.planActions ?? new ConversationPlanActionRepository(options.db);
  const runStates = new Map<string, NativeConversationRunState>();
  const contexts = new Map<string, ConversationDispatchContext>();
  const processedEvents = new Set(options.settings.getJson<string[]>(processedEventsSettingKey) ?? []);
  const completedTurnResults = new Map<string, NativeTurnResult>();
  const failedTurnResults = new Map<string, Error & { code: string }>();
  const turnResultWaiters = new Map<string, NativeTurnResultWaiter[]>();
    const autoResolutionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let closing = false;
  let closed = false;
  let providerEventChain = Promise.resolve();
  let generationReconcileChain = Promise.resolve();
  let reconciledGenerationId: string | null = null;
  let queueDrainPromise: Promise<void> | null = null;
  let handoffPromise: Promise<void> | null = null;
  let finalizationPromise: Promise<void> | null = null;

  const unsubscribe = options.manager.subscribe((event) => {
    providerEventChain = providerEventChain.then(() => handleProviderEvent(event)).catch((error) => safelyHandleProviderEventError(event, error));
    return providerEventChain;
  });

  function assertOpen(): void {
    if (closing || closed) throw coordinatorError('ZEUS_CODEX_COORDINATOR_CLOSED', 'Codex native conversation coordinator is closed.');
    if (options.enabled === false) throw coordinatorError('ZEUS_CODEX_NATIVE_DISABLED', 'Codex native conversation writes are disabled by ZEUS_CODEX_NATIVE_ENABLED.');
  }

  async function persist(): Promise<void> {
    await options.db.save();
  }

  function commandPath(): string {
    return typeof options.commandPath === 'function' ? options.commandPath() : options.commandPath;
  }

  function activeNativeCounts(projectId: string): { project: number; global: number } {
    let project = 0;
    let global = 0;
    for (const [conversationId, state] of runStates) {
      if (state.type !== 'dispatching' && state.type !== 'active' && state.type !== 'waiting') continue;
      global += 1;
      if (contexts.get(conversationId)?.projectId === projectId) project += 1;
    }
    return { project, global };
  }

  function hasConcurrency(context: ConversationDispatchContext): boolean {
    if (context.bypassConcurrency) return true;
    const external = options.getConcurrency(context.projectId);
    const active = activeNativeCounts(context.projectId);
    return external.project + active.project < external.maxPerProject && external.global + active.global < external.maxGlobal;
  }

  function contextFromSubmission(submission: ZeusConversationSubmissionRecord): ConversationDispatchContext {
    const parsed = parseJsonRecord(submission.inputJson);
    const context = isRecord(parsed.context) ? parsed.context : {};
    return {
      projectId: requireString(context.projectId, 'submission projectId'),
      projectLocalPath: requireString(context.projectLocalPath, 'submission projectLocalPath'),
      taskId: typeof context.taskId === 'string' ? context.taskId : null,
      model: requireString(context.model, 'submission model'),
      ...(typeof context.effort === 'string' ? { effort: context.effort } : {}),
      allowCodeChanges: context.allowCodeChanges === true,
      allowTests: context.allowTests === true,
      allowGitCommit: context.allowGitCommit === true,
      permissionMode: permissionModeFromValue(context.permissionMode, context.allowCodeChanges === true ? 'auto' : 'read-only'),
      ...(Array.isArray(context.allowedAttachmentRoots) && context.allowedAttachmentRoots.every((root) => typeof root === 'string') ? { allowedAttachmentRoots: context.allowedAttachmentRoots } : {}),
      ...(context.bypassConcurrency === true ? { bypassConcurrency: true } : {}),
        workMode: context.workMode === 'plan' || context.workMode === 'default' ? context.workMode : 'default',
      ...(context.applyLegacyTaskGuards === false ? { applyLegacyTaskGuards: false } : {}),
      ...(context.ephemeral === true ? { ephemeral: true } : {}),
      ...(isRecord(context.additionalContext) ? { additionalContext: context.additionalContext } : {}),
    };
  }

  function submissionText(submission: ZeusConversationSubmissionRecord): string {
    return requireString(parseJsonRecord(submission.inputJson).text, 'submission text');
  }

  function submissionAttachments(submission: ZeusConversationSubmissionRecord): NativeConversationAttachmentInput[] {
    const value = parseJsonRecord(submission.inputJson).attachments;
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment input is invalid.');
    return value.map((attachment) => {
      if (
        !isRecord(attachment) ||
        typeof attachment.name !== 'string' ||
        !attachment.name ||
        typeof attachment.mime !== 'string' ||
        !attachment.mime ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        attachment.size < 0
      ) {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment metadata is invalid.');
      }
      const localPath = typeof attachment.localPath === 'string' && attachment.localPath ? attachment.localPath : undefined;
      const uploadRef = typeof attachment.uploadRef === 'string' && attachment.uploadRef ? attachment.uploadRef : undefined;
      if ((localPath ? 1 : 0) + (uploadRef ? 1 : 0) !== 1) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Durable native attachment identity is invalid.');
      return { name: attachment.name, mime: attachment.mime, size: attachment.size, ...(localPath ? { localPath } : {}), ...(uploadRef ? { uploadRef } : {}) };
    });
  }

  function submissionProviderInput(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): Array<Record<string, unknown>> {
    const inputs: Array<Record<string, unknown>> = [{ type: 'text', text: submissionText(submission) }];
    const allowedRoots = (context.allowedAttachmentRoots?.length ? context.allowedAttachmentRoots : [context.projectLocalPath]).map(existingDirectoryRealpath).filter((root): root is string => Boolean(root));
    if (allowedRoots.length === 0 && submissionAttachments(submission).length > 0) {
      throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_PROJECT_UNAVAILABLE', 'No trusted attachment root can be resolved.');
    }
    for (const attachment of submissionAttachments(submission)) {
      if (attachment.uploadRef) {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_UPLOAD_UNSUPPORTED', 'Native attachment uploadRef has no provider resolver.');
      }
      const localPath = attachment.localPath;
      if (!localPath || !isAbsolute(localPath)) throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_INPUT_INVALID', 'Native attachment localPath must be absolute.');
      let canonicalPath: string;
      try {
        canonicalPath = realpathSync(localPath);
        if (!allowedRoots.some((root) => isInsideRoot(canonicalPath, root)) || !statSync(canonicalPath).isFile()) throw new Error('outside trusted roots or not a file');
      } catch {
        throw coordinatorError('ZEUS_NATIVE_ATTACHMENT_PATH_UNAVAILABLE', 'Native attachment must resolve to a file inside a trusted attachment root.');
      }
      if (isSupportedLocalImageAttachment(attachment, canonicalPath)) inputs.push({ type: 'localImage', path: canonicalPath });
      else inputs.push({ type: 'mention', name: attachment.name, path: canonicalPath });
    }
    return inputs;
  }

  function toQueueSnapshot(conversationId: string): NativeQueueSnapshot {
    const entries = options.submissions.listByConversation(conversationId).filter((submission) => submission.status === 'queued' || submission.status === 'paused' || submission.status === 'failed');
    return {
      conversationId,
      state: runStates.get(conversationId) ?? { type: 'idle' },
      submissions: entries.map((submission, index) => ({
        id: submission.id,
        content: submissionText(submission),
        status: submission.status as 'queued' | 'paused' | 'failed',
        position: submission.queuePosition ?? index + 1,
        pausedReason: submission.pausedReason,
      })),
    };
  }

  function createSubmission(
    conversationId: string,
    content: string,
    input: {
        submissionId?: string;
        idempotencyKey: string;
        clientUserMessageId: string;
        attachments?: NativeConversationAttachmentInput[];
        displayText?: string;
        origin?: 'implement_plan';
        planItemId?: string;
    },
    context: ConversationDispatchContext,
  ): ZeusConversationSubmissionRecord {
    const queuedCount = options.submissions.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed').length;
      const payload: PersistedSubmissionInput = {
          text: content,
          ...(input.attachments?.length ? {attachments: input.attachments} : {}),
          context,
          ...(input.displayText ? {displayText: input.displayText} : {}),
          ...(input.origin ? {origin: input.origin} : {}),
          ...(input.planItemId ? {planItemId: input.planItemId} : {}),
      };
    return options.submissions.createOrGet({
      ...(input.submissionId ? { id: input.submissionId } : {}),
      conversationId,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(payload),
      clientMessageId: input.clientUserMessageId,
      kind: 'message',
      requestedDelivery: 'queue',
      status: 'queued',
      queuePosition: queuedCount + 1,
      input: payload,
      createdAt: now(),
    });
  }

  async function startTaskConversation(input: StartTaskConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const additionalContext = resolveLegacyReference(input);
    const existingConversation = input.conversationId ? options.conversations.getById(input.conversationId) : undefined;
    const permissionMode = existingConversation?.permissionMode ?? input.permissionMode ?? (input.allowCodeChanges ? 'auto' : 'read-only');
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: input.taskId,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      allowCodeChanges: input.allowCodeChanges,
      allowTests: input.allowTests,
      allowGitCommit: input.allowGitCommit,
      permissionMode,
      ...(input.allowedAttachmentRoots?.length ? { allowedAttachmentRoots: input.allowedAttachmentRoots.map((root) => resolve(root)) } : {}),
      ...(input.bypassConcurrency ? { bypassConcurrency: true } : {}),
        workMode: input.workMode ?? existingConversation?.collaborationMode ?? 'default',
      ...(input.applyLegacyTaskGuards === false ? { applyLegacyTaskGuards: false } : {}),
      ...(input.ephemeral ? { ephemeral: true } : {}),
      ...(additionalContext ? { additionalContext } : {}),
    };
    if (existingConversation && (existingConversation.projectId !== input.projectId || existingConversation.taskId !== input.taskId || existingConversation.transportKind !== 'codex_native')) {
      throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved native conversation id is already owned by another resource.');
    }
    const conversation =
      existingConversation ??
      options.conversations.create({
        ...(input.conversationId ? { id: input.conversationId } : {}),
        projectId: input.projectId,
        taskId: input.taskId,
        title: `任务会话：${input.taskTitle.slice(0, 48)}`,
        summary: input.prompt.slice(0, 240),
        status: 'starting',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerModel: input.model,
        providerState: 'unbound',
        legacySourceConversationId: input.legacyReference?.conversationId,
        permissionMode,
          collaborationMode: context.workMode,
      });
      if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (!hasConcurrency(context)) return accepted(submission, 'queued', null, null);
    return dispatchSubmission(conversation, submission, input.providerWriteLifecycle);
  }

  async function startProjectConversation(input: StartProjectConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const title = projectConversationTitle(input.prompt);
    const existingConversation = input.conversationId ? options.conversations.getById(input.conversationId) : undefined;
    const permissionMode = existingConversation?.permissionMode ?? input.permissionMode ?? 'auto';
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: null,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      allowCodeChanges: permissionMode !== 'read-only',
      allowTests: permissionMode !== 'read-only',
      allowGitCommit: false,
      permissionMode,
        workMode: input.collaborationMode ?? existingConversation?.collaborationMode ?? 'default',
    };
    if (existingConversation && (existingConversation.projectId !== input.projectId || existingConversation.taskId !== null || existingConversation.transportKind !== 'codex_native')) {
      throw coordinatorError('ZEUS_NATIVE_RESERVED_RESOURCE_CONFLICT', 'Reserved project conversation id is already owned by another resource.');
    }
    const conversation =
      existingConversation ??
      options.conversations.create({
        ...(input.conversationId ? { id: input.conversationId } : {}),
        projectId: input.projectId,
        title,
        summary: [...input.prompt].slice(0, 240).join(''),
        status: 'starting',
        transportKind: 'codex_native',
        providerId: 'codex',
        providerModel: input.model,
        providerState: 'unbound',
        permissionMode,
          collaborationMode: context.workMode,
      });
      if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    if (!hasConcurrency(context)) return accepted(submission, 'queued', null, null);
    return dispatchSubmission(conversation, submission, input.providerWriteLifecycle);
  }

  function projectConversationTitle(prompt: string): string {
    const firstLine = prompt
      .split(/\r\n?|\n/u)
      .map((line) => line.replace(/\s+/gu, ' ').trim())
      .find(Boolean);
    if (!firstLine) throw coordinatorError('ZEUS_INVALID_CONVERSATION_START', 'Project conversation content is required.');
    return [...firstLine].slice(0, 48).join('');
  }

  async function startEphemeralConversation(input: StartNativeEphemeralConversationInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const context: ConversationDispatchContext = {
      projectId: input.projectId,
      projectLocalPath: resolve(input.projectLocalPath),
      taskId: null,
      model: input.model,
      ...(input.effort ? { effort: input.effort } : {}),
      allowCodeChanges: false,
      allowTests: false,
      allowGitCommit: false,
      permissionMode: 'read-only',
        workMode: 'default',
      ephemeral: true,
    };
    if (!hasConcurrency(context)) throw coordinatorError('ZEUS_CODEX_CONCURRENCY_FULL', 'Codex native Graph question cannot start because concurrency is full.');
    const conversation = options.conversations.create({
      projectId: input.projectId,
      title: input.title,
      summary: input.prompt.slice(0, 240),
      status: 'starting',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerModel: input.model,
      providerState: 'unbound',
      permissionMode: 'read-only',
        collaborationMode: 'default',
    });
    contexts.set(conversation.id, context);
    runStates.set(conversation.id, { type: 'idle' });
    const submission = createSubmission(conversation.id, input.prompt, input, context);
    await persist();
    const operation = await dispatchSubmission(conversation, submission);
    if (operation.status === 'queued') {
      await closeEphemeralConversation(conversation.id, null, 'cancelled', { code: 'ZEUS_CODEX_CONCURRENCY_FULL' }, false);
      throw coordinatorError('ZEUS_CODEX_CONCURRENCY_FULL', 'Codex native Graph question cannot start because concurrency is full.');
    }
    if (operation.status === 'recovery_required') {
      throw coordinatorError('ZEUS_CODEX_EPHEMERAL_DISPATCH_FAILED', 'Codex native Graph provider dispatch failed.');
    }
    return operation;
  }

  function waitForTurnResult(input: WaitForNativeTurnResultInput): Promise<NativeTurnResult> {
    assertOpen();
    const key = `${input.conversationId}:${input.providerTurnId}`;
    const completed = completedTurnResults.get(key);
    if (completed) return Promise.resolve(completed);
    const failed = failedTurnResults.get(key);
    if (failed) return Promise.reject(failed);
    const persistedTurn = options.turns.listByConversation(input.conversationId).find((turn) => turn.providerTurnId === input.providerTurnId);
    if (persistedTurn?.status === 'failed') return Promise.reject(failedTurnErrorFromRecord(persistedTurn));
    const timeoutMs = input.timeoutMs ?? options.turnResultTimeoutMs ?? 60_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(coordinatorError('ZEUS_CODEX_TURN_RESULT_TIMEOUT_INVALID', 'Native turn result timeout must be a positive number.'));
    return new Promise((resolveResult, rejectResult) => {
      const waiters = turnResultWaiters.get(key) ?? [];
      const waiter: NativeTurnResultWaiter = {
        resolve: resolveResult,
        reject: rejectResult,
        timer: setTimeout(() => {
          void timeoutTurnResult(input, key).catch((error) => rejectResult(error instanceof Error ? error : new Error(String(error))));
        }, timeoutMs),
      };
      waiters.push(waiter);
      turnResultWaiters.set(key, waiters);
    });
  }

  async function timeoutTurnResult(input: WaitForNativeTurnResultInput, key: string): Promise<void> {
    if (!turnResultWaiters.has(key)) return;
    const error = coordinatorError('ZEUS_CODEX_TURN_RESULT_TIMEOUT', 'Codex native turn did not complete before the timeout.');
    await closeEphemeralConversation(input.conversationId, input.providerTurnId, 'cancelled', serializeError(error), true);
    rejectTurnResultWaiters(key, error);
  }

  function resolveLegacyReference(input: StartTaskConversationInput): Record<string, unknown> | undefined {
    if (!input.legacyReference) return undefined;
    const legacy = options.conversations.getById(input.legacyReference.conversationId);
    if (!legacy || legacy.transportKind !== 'legacy_cli') throw coordinatorError('ZEUS_LEGACY_CONVERSATION_NOT_FOUND', 'Selected legacy conversation was not found.');
    const selected = new Set(input.legacyReference.messageIds);
    if (selected.size !== input.legacyReference.messageIds.length) throw coordinatorError('ZEUS_LEGACY_MESSAGE_SELECTION_INVALID', 'Legacy message ids must be explicit and unique.');
    const messages = input.legacyReference.messageIds.map((messageId) => {
      const message = legacy.messages.find((candidate) => candidate.id === messageId);
      if (!message) throw coordinatorError('ZEUS_LEGACY_MESSAGE_SELECTION_INVALID', `Legacy message does not belong to selected conversation: ${messageId}`);
      return { messageId: message.id, role: message.role, content: message.content };
    });
    return { kind: 'untrusted', items: messages };
  }

  async function submitMessage(input: SubmitNativeMessageInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
      const previousContext = contexts.get(conversation.id) ?? contextFromConversation(conversation);
      const context: ConversationDispatchContext = {
          ...previousContext,
          permissionMode: conversation.permissionMode,
          workMode: input.collaborationMode ?? conversation.collaborationMode,
          ...(input.model ? {model: input.model} : {}),
          ...(input.effort ? {effort: input.effort} : {}),
      };
      if (input.model && input.model !== previousContext.model && !input.effort) delete context.effort;
      if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    contexts.set(conversation.id, context);
    const submission = createSubmission(conversation.id, input.content, input, context);
    await persist();
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    try {
      await ensureGenerationReconciled();
    } catch {
      return accepted(submission, 'queued', conversation.providerThreadId, null);
    }
      let refreshed = requireConversation(conversation.id);
      if (refreshed.providerState === 'archived') {
          try {
              await restoreArchivedProviderThread(refreshed.id);
              refreshed = requireConversation(refreshed.id);
          } catch {
              return accepted(submission, 'provider_archived', refreshed.providerThreadId, null);
          }
      }
    const state = runStates.get(conversation.id) ?? inferRunState(refreshed);
    runStates.set(conversation.id, state);
    if (state.type !== 'idle' || !hasConcurrency(context)) return accepted(submission, 'queued', refreshed.providerThreadId, null);
    return dispatchSubmission(refreshed, submission, input.providerWriteLifecycle);
  }

  function contextFromConversation(conversation: ZeusConversationWithMessagesRecord): ConversationDispatchContext {
      const submission = [...options.submissions.listByConversation(conversation.id)].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).at(-1);
    if (!submission) throw coordinatorError('ZEUS_NATIVE_CONTEXT_UNAVAILABLE', 'Native conversation dispatch context is unavailable.');
      return {
          ...contextFromSubmission(submission),
          permissionMode: conversation.permissionMode,
          workMode: conversation.collaborationMode
      };
  }

  function inferRunState(conversation: ZeusConversationWithMessagesRecord): NativeConversationRunState {
      if (conversation.providerState === 'archived') return {type: 'paused', reason: 'provider_archived'};
    if (options.submissions.listByConversation(conversation.id).some((submission) => submission.status === 'paused' && submission.pausedReason === 'interrupted')) {
      return { type: 'paused', reason: 'interrupted' };
    }
    const activeTurn = [...options.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting' || turn.status === 'dispatching');
    if (activeTurn?.providerTurnId) {
      if (activeTurn.status === 'waiting') {
        const currentGenerationId = readyGenerationId();
        const pending = options.requests.listByConversation(conversation.id).find((request) => request.turnId === activeTurn.id && request.status === 'pending' && request.transportGenerationId === currentGenerationId);
        if (pending) {
          return {
            type: 'waiting',
            turnId: activeTurn.providerTurnId,
            requestId: pending.id,
            reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
          };
        }
      }
      return { type: 'active', turnId: activeTurn.providerTurnId, phase: 'prework' };
    }
    return conversation.providerState === 'paused' ? { type: 'paused', reason: 'recovery_required' } : { type: 'idle' };
  }

  function readyGenerationId(): string | null {
    const state = options.manager.getState();
    return state.type === 'ready' ? state.generationId : null;
  }

  function failStalePendingRequests(conversationId: string, currentGenerationId: string): void {
    const timestamp = now();
    for (const request of options.requests.listByConversation(conversationId)) {
      if (request.status !== 'pending' || request.transportGenerationId === currentGenerationId) continue;
      options.requests.fail(request.id, {
        error: {
          error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
          message: 'The provider request belongs to a retired app-server generation and requires explicit recovery.',
          recoveryRequired: true,
          requestGenerationId: request.transportGenerationId,
          currentGenerationId,
        },
        resolvedAt: timestamp,
      });
    }
  }

  async function dispatchSubmission(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    providerWriteLifecycle?: NativeProviderWriteLifecycle,
    providerArchiveRecoveryAttempted = false,
  ): Promise<NativeAcceptedOperation> {
    let conversation = options.conversations.getById(conversationInput.id);
    if (!conversation) throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation was not found.');
      const context = {...contextFromSubmission(submission), permissionMode: conversation.permissionMode};
    contexts.set(conversation.id, context);
    try {
      await ensureGenerationReconciled();
      conversation = options.conversations.getById(conversation.id) ?? conversation;
      if (!hasConcurrency(context)) return accepted(submission, 'queued', conversation.providerThreadId, null);
      providerWriteLifecycle?.markRpcStarted(submission.id);
      runStates.set(conversation.id, { type: 'dispatching', submissionId: submission.id });
      options.submissions.updateStatus(submission.id, 'dispatching', { dispatchedAt: now() });
      await persist();
      if (!conversation.providerThreadId) {
        const profile = providerPermissionProfile(context);
        const thread = await options.manager.startThread({
          model: context.model,
          cwd: context.projectLocalPath,
          sandbox: profile.sandbox,
          approvalPolicy: profile.approvalPolicy,
          approvalsReviewer: profile.approvalsReviewer,
          developerInstructions: developerInstructionsFor(context),
          ephemeral: context.ephemeral,
        });
        conversation = options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: thread.id,
          providerModel: context.model,
          providerState: 'ready',
        });
        await persist();
        options.broadcast('conversation.transport.changed', {
          conversationId: conversation.id,
          transportKind: 'codex_native',
          providerState: conversation.providerState,
          providerThreadId: conversation.providerThreadId,
        });
        options.broadcast('conversation.thread.changed', {
          conversationId: conversation.id,
          providerThreadId: conversation.providerThreadId,
          providerState: conversation.providerState,
        });
      }
      const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
      const profile = providerPermissionProfile(context);
      const turn = await options.manager.startTurn({
        threadId: providerThreadId,
        clientUserMessageId: submission.clientMessageId,
        input: submissionProviderInput(submission, context),
        ...(context.additionalContext ? { additionalContext: context.additionalContext } : {}),
        model: context.model,
        ...(context.effort ? { effort: context.effort } : {}),
        ...(context.workMode
          ? {
              collaborationMode: {
                mode: context.workMode,
                settings: {
                  model: context.model,
                  reasoning_effort: context.effort ?? null,
                  developer_instructions: null,
                },
              },
            }
          : {}),
        cwd: context.projectLocalPath,
        approvalPolicy: profile.approvalPolicy,
        approvalsReviewer: profile.approvalsReviewer,
        sandboxPolicy: profile.sandbox,
      });
      const timestamp = now();
      options.turns.upsert({
        conversationId: conversation.id,
        providerThreadId,
        providerTurnId: turn.id,
        clientSubmissionId: submission.id,
        status: 'running',
        startedAt: timestamp,
        completedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      options.submissions.updateStatus(submission.id, 'active', { providerTurnId: turn.id, dispatchedAt: timestamp });
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: context.model, providerState: 'active' });
      runStates.set(conversation.id, { type: 'active', turnId: turn.id, phase: 'prework' });
      await persist();
      options.broadcast('conversation.turn.started', { conversationId: conversation.id, providerThreadId, providerTurnId: turn.id, submissionId: submission.id });
      return accepted(submission, 'active', providerThreadId, turn.id);
    } catch (error) {
      const current = options.conversations.getById(conversation.id);
      const providerThreadId = current?.providerThreadId ?? null;
      if (context.ephemeral) {
        options.submissions.updateStatus(submission.id, 'failed', { resolvedAt: now(), error: serializeError(error) });
        if (current?.providerThreadId) {
          options.conversations.bindProvider(current.id, {
            providerId: 'codex',
            providerThreadId: current.providerThreadId,
            providerModel: current.providerModel,
            providerState: 'closed',
          });
        } else if (current) {
          options.conversations.updateRuntimeState(current.id, { status: 'failed', summary: 'Codex native ephemeral dispatch failed.' });
          options.conversations.archive(current.id);
        }
        runStates.delete(conversation.id);
        contexts.delete(conversation.id);
      } else if (providerThreadId === null && options.manager.getState().type !== 'ready') {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'transport_unavailable', error: serializeError(error) });
        runStates.set(conversation.id, { type: 'paused', reason: 'transport_unavailable' });
      } else if (isProviderThreadArchivedError(error)) {
          markConversationProviderArchived(conversation.id, error);
          await persist();
          if (!providerArchiveRecoveryAttempted) {
              try {
                  await restoreArchivedProviderThread(conversation.id);
                  const retrySubmission = options.submissions.getById(submission.id);
                  const retryConversation = options.conversations.getById(conversation.id);
                  if (retrySubmission && retryConversation) return dispatchSubmission(retryConversation, retrySubmission, providerWriteLifecycle, true);
              } catch {
                  // 恢复函数已保留原始消息与可重试状态。
              }
          }
          return accepted(submission, 'provider_archived', providerThreadId, null);
      } else {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: serializeError(error) });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      }
      await persist();
      requestQueueDrain();
      return accepted(submission, 'recovery_required', providerThreadId, null);
    }
  }

  async function closeEphemeralConversation(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown, interrupt: boolean): Promise<void> {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
    if (!context.ephemeral) return;
    if (interrupt && providerTurnId && conversation.providerThreadId) {
      try {
        await options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId });
      } catch (interruptError) {
        options.broadcast('conversation.native.ephemeral_interrupt_failed', {
          conversationId,
          providerThreadId: conversation.providerThreadId,
          providerTurnId,
          error: serializeError(interruptError),
        });
      }
    }
    markEphemeralConversationClosed(conversationId, providerTurnId, submissionStatus, error);
    await persist();
    requestQueueDrain();
  }

  function markEphemeralConversationClosed(conversationId: string, providerTurnId: string | null, submissionStatus: 'cancelled' | 'failed', error: unknown): void {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation) return;
    const context = contexts.get(conversationId) ?? contextFromConversation(conversation);
    if (!context.ephemeral) return;
    const timestamp = now();
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active' || submission.status === 'paused') {
        options.submissions.updateStatus(submission.id, submissionStatus, { resolvedAt: timestamp, error });
      }
    }
    const turn = providerTurnId ? options.turns.listByConversation(conversationId).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (turn) {
      options.turns.upsert({
        ...turn,
        status: submissionStatus === 'cancelled' ? 'interrupted' : 'failed',
        error,
        completedAt: timestamp,
        updatedAt: timestamp,
      });
    }
    options.conversations.updateRuntimeState(conversationId, {
      status: submissionStatus === 'failed' ? 'failed' : 'closed',
      summary: submissionStatus === 'failed' ? 'Codex native ephemeral conversation failed.' : 'Codex native ephemeral conversation closed.',
    });
    if (conversation.providerThreadId) {
      options.conversations.bindProvider(conversationId, {
        providerId: 'codex',
        providerThreadId: conversation.providerThreadId,
        providerModel: conversation.providerModel,
        providerState: 'closed',
      });
    } else {
      options.conversations.updateRuntimeState(conversationId, { status: submissionStatus === 'failed' ? 'failed' : 'closed' });
      options.conversations.archive(conversationId);
    }
    runStates.delete(conversationId);
    contexts.delete(conversationId);
  }

  function rejectTurnResultWaiters(key: string, error: Error): void {
    const waiters = turnResultWaiters.get(key) ?? [];
    turnResultWaiters.delete(key);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function persistProviderUserMessage(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>, content: string, providerItemId: string, createdAt: string): string | null {
    const providerClientId = typeof itemPayload.clientId === 'string' && itemPayload.clientId.trim() ? itemPayload.clientId : null;
    const existingProviderMessage = conversation.messages.find((message) => message.providerItemId === providerItemId);
    const existingClientIds = new Set(
      conversation.messages
        .filter((message) => message.providerItemId !== providerItemId)
        .map((message) => message.clientMessageId)
        .filter((value): value is string => Boolean(value)),
    );
    const submissions = options.submissions.listByConversation(conversation.id);
    const durableClientId = providerClientId ?? existingProviderMessage?.clientMessageId ?? null;
    const submission = durableClientId
      ? submissions.find((entry) => entry.clientMessageId === durableClientId)
      : (submissions.find((entry) => entry.id === turn.clientSubmissionId && !existingClientIds.has(entry.clientMessageId)) ??
        submissions.find((entry) => entry.providerTurnId === turn.providerTurnId && !existingClientIds.has(entry.clientMessageId)));
    const clientMessageId = durableClientId ?? submission?.clientMessageId ?? null;
      const visibleContent = typeof itemPayload.displayText === 'string' && itemPayload.displayText.trim() ? itemPayload.displayText : content;
    options.conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
        content: visibleContent,
      source: 'codex_native',
      metadata: {
        ...(existingProviderMessage ? parseJsonRecord(existingProviderMessage.metadataJson) : {}),
        ...(clientMessageId ? { clientUserMessageId: clientMessageId } : {}),
        ...(submission ? { attachments: submissionAttachments(submission) } : {}),
          ...(typeof itemPayload.origin === 'string' ? {origin: itemPayload.origin} : {}),
          ...(typeof itemPayload.planItemId === 'string' ? {planItemId: itemPayload.planItemId} : {}),
      },
      createdAt,
      providerThreadId: turn.providerThreadId,
      providerTurnId: requireString(turn.providerTurnId, 'provider turn id'),
      providerItemId,
      ...(clientMessageId ? { clientMessageId } : {}),
    });
    return clientMessageId;
  }

    function submissionPresentation(turn: ZeusConversationTurnRecord): Record<string, unknown> {
        const submission = options.submissions.getById(turn.clientSubmissionId);
        if (!submission) return {};
        const input = parseJsonRecord(submission.inputJson);
        return {
            ...(typeof input.displayText === 'string' && input.displayText.trim() ? {displayText: input.displayText} : {}),
            ...(input.origin === 'implement_plan' ? {origin: input.origin} : {}),
            ...(typeof input.planItemId === 'string' ? {planItemId: input.planItemId} : {}),
        };
    }

  async function editQueuedSubmission(input: { conversationId: string; submissionId: string; content: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    const persisted = parseJsonRecord(submission.inputJson);
    const next = { ...persisted, text: input.content };
    options.submissions.updateQueuedInput(submission.id, { requestHash: requestHash(next), input: next, updatedAt: now() });
    await persist();
    return toQueueSnapshot(input.conversationId);
  }

  async function deleteQueuedSubmission(input: { conversationId: string; submissionId: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    if (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') {
      throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE', 'Only queued, paused, or failed submissions can be deleted.');
    }
    options.submissions.updateStatus(submission.id, 'deleted', { resolvedAt: now() });
    const remaining = options.submissions.listByConversation(input.conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    options.submissions.reorderQueued(
      input.conversationId,
      remaining.map((entry) => entry.id),
      now(),
    );
    await persist();
    return toQueueSnapshot(input.conversationId);
  }

  async function reorderQueue(input: { conversationId: string; orderedSubmissionIds: string[] }): Promise<NativeQueueSnapshot> {
    assertOpen();
    requireConversation(input.conversationId);
    options.submissions.reorderQueued(input.conversationId, input.orderedSubmissionIds, now());
    await persist();
    return toQueueSnapshot(input.conversationId);
  }

  async function sendQueuedNow(input: SendQueuedNowInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const submission = requireOwnedSubmission(input.conversationId, input.submissionId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'active' && state.type !== 'waiting') throw coordinatorError('ZEUS_NATIVE_TURN_NOT_ACTIVE', 'send-now requires a current active Codex native turn.');
    if (submission.status !== 'queued') throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_QUEUED', 'Submission is not queued.');
    const turnId = state.turnId;
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
      const context = {...contextFromSubmission(submission), permissionMode: conversation.permissionMode};
    await input.providerWriteLifecycle?.markPrepared(submission.id);
    input.providerWriteLifecycle?.markRpcStarted(submission.id);
    options.submissions.updateStatus(submission.id, 'dispatching', { providerTurnId: turnId, dispatchedAt: now() });
    await persist();
    try {
      await options.manager.steerTurn({ threadId: providerThreadId, turnId, clientUserMessageId: submission.clientMessageId, input: submissionProviderInput(submission, context) });
    } catch (error) {
      options.submissions.updateStatus(submission.id, 'paused', {
        providerTurnId: turnId,
        pausedReason: 'recovery_required',
        error: serializeError(error),
        updatedAt: now(),
      });
      await persist();
      throw error;
    }
    options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId: turnId, resolvedAt: now() });
    await persist();
    options.broadcast('conversation.submission.steered', { conversationId: conversation.id, submissionId: submission.id, providerThreadId, providerTurnId: turnId });
    return accepted(submission, 'steered', providerThreadId, turnId);
  }

  async function interruptTurn(input: InterruptNativeTurnInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'active' && state.type !== 'waiting') throw coordinatorError('ZEUS_NATIVE_TURN_NOT_ACTIVE', 'No active Codex native turn to interrupt.');
    if (state.turnId !== input.providerTurnId) throw coordinatorError('ZEUS_NATIVE_TURN_MISMATCH', 'Interrupt target is not the current active provider turn.');
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    await input.providerWriteLifecycle?.markPrepared(input.providerTurnId);
    input.providerWriteLifecycle?.markRpcStarted(input.providerTurnId);
    await persist();
    await options.manager.interruptTurn({ threadId: providerThreadId, turnId: input.providerTurnId });
    const submission = options.submissions.listByConversation(conversation.id).find((entry) => entry.providerTurnId === input.providerTurnId);
    return {
      operationId: operationId(),
      conversationId: conversation.id,
      submissionId: submission?.id ?? '',
      status: 'interrupted',
      providerThreadId,
      providerTurnId: input.providerTurnId,
    };
  }

  async function resumeInterruptedQueue(input: { conversationId: string }): Promise<NativeQueueSnapshot> {
    assertOpen();
    const conversation = requireConversation(input.conversationId);
    const state = runStates.get(conversation.id) ?? inferRunState(conversation);
    if (state.type !== 'paused' || state.reason !== 'interrupted') throw coordinatorError('ZEUS_NATIVE_QUEUE_NOT_INTERRUPTED', 'Queue is not paused by an interrupted turn.');
    const paused = options.submissions.listByConversation(conversation.id).filter((entry) => entry.status === 'paused' && entry.pausedReason === 'interrupted');
    for (const submission of paused) options.submissions.updateStatus(submission.id, 'queued');
    runStates.set(conversation.id, { type: 'idle' });
    await persist();
    const next = options.submissions.listByConversation(conversation.id).find((entry) => entry.status === 'queued');
    if (next) await dispatchSubmission(conversation, next);
    return toQueueSnapshot(conversation.id);
  }

    async function restoreArchivedConversation(input: RestoreArchivedConversationInput): Promise<NativeQueueSnapshot> {
        assertOpen();
        let conversation = requireConversation(input.conversationId);
        if (conversation.providerState !== 'archived') return toQueueSnapshot(conversation.id);
        await ensureGenerationReconciled();
        conversation = requireConversation(input.conversationId);
        if (conversation.providerState !== 'archived') return toQueueSnapshot(conversation.id);
        await restoreArchivedProviderThread(conversation.id);
        await drainQueuedSubmissions();
        return toQueueSnapshot(conversation.id);
    }

    async function restoreArchivedProviderThread(conversationId: string): Promise<NativeQueueSnapshot> {
        let conversation = requireConversation(conversationId);
        if (conversation.providerState !== 'archived') return toQueueSnapshot(conversation.id);
        const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
        const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
        contexts.set(conversation.id, context);
        try {
            await options.manager.unarchiveThread({threadId: providerThreadId});
            await options.manager.resumeThread({threadId: providerThreadId, cwd: context.projectLocalPath});
            const snapshot = await options.manager.readThread({threadId: providerThreadId});
            for (const submission of options.submissions.listByConversation(conversation.id)) {
                if (submission.status === 'paused' && submission.pausedReason === 'provider_archived') options.submissions.updateStatus(submission.id, 'queued');
            }
            conversation = options.conversations.bindProvider(conversation.id, {
                providerId: 'codex',
                providerThreadId,
                providerModel: conversation.providerModel,
                providerState: 'ready',
            });
            runStates.set(conversation.id, {type: 'idle'});
            reconcileConversationSnapshot(conversation, snapshot, requireString(readyGenerationId(), 'transport generation id'));
            await persist();
            options.broadcast('conversation.thread.changed', {
                conversationId: conversation.id,
                providerThreadId,
                providerState: 'ready'
            });
            options.broadcast('conversation.queue.changed', {
                conversationId: conversation.id,
                providerThreadId,
                providerState: 'ready'
            });
            return toQueueSnapshot(conversation.id);
        } catch (error) {
            markConversationProviderArchived(conversation.id, error);
            await persist();
            throw error;
        }
    }

    async function restoreArchivedConversationsWithPendingSubmissions(): Promise<void> {
        for (const conversation of options.conversations.listNativeBound()) {
            if (conversation.providerState !== 'archived') continue;
            const hasPendingSubmission = options.submissions.listByConversation(conversation.id).some((submission) => submission.status === 'queued' || (submission.status === 'paused' && submission.pausedReason === 'provider_archived'));
            if (!hasPendingSubmission) continue;
            try {
                await restoreArchivedProviderThread(conversation.id);
            } catch (error) {
                options.broadcast('conversation.native.queue_dispatch_failed', {
                    conversationId: conversation.id,
                    providerThreadId: conversation.providerThreadId,
                    error: serializeError(error),
                });
            }
        }
    }

  async function respondToRequest(input: RespondNativeRequestInput): Promise<NativeAcceptedOperation> {
    assertOpen();
    const request = options.requests.getById(input.requestId);
    if (!request) throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
    const currentGenerationId = readyGenerationId();
    if (!currentGenerationId || request.transportGenerationId !== currentGenerationId) {
      if (request.status === 'pending') {
        options.requests.fail(request.id, {
          error: {
            error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
            message: 'The provider request belongs to a retired or unavailable app-server generation.',
            recoveryRequired: true,
            requestGenerationId: request.transportGenerationId,
            currentGenerationId,
          },
          resolvedAt: now(),
        });
        await persist();
      }
      throw coordinatorError('ZEUS_CODEX_REQUEST_GENERATION_STALE', 'Codex server request is not authoritative for the current app-server generation.');
    }
    if (request.status !== 'pending') throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex server request is not pending.');
      clearAutoResolutionTimer(request.id);
    const conversation = requireConversation(request.conversationId);
    const context = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    const providerRequestId = JSON.parse(request.providerRequestIdJson) as string | number;
    const response = input.response;
    let wireResponse = { ...response, generationId: request.transportGenerationId, requestId: providerRequestId } as CodexServerRequestResponse;
    const payload = parseJsonRecord(request.payloadJson);

    if (request.requestKind === 'command') {
      if (response.type !== 'command') throw invalidServerRequestResponse('Response type does not match the pending command approval.');
        if (isExecpolicyAmendmentDecision(response.decision)) {
            if (!isAdvertisedCommandDecision(payload, response.decision)) {
                throw invalidServerRequestResponse('The provider did not advertise the requested execpolicy amendment.');
            }
        } else if (isGrantDecision(response.decision)) {
        if (!isAdvertisedCommandDecision(payload, response.decision)) {
          const policy = evaluateCommandApproval(payload, context);
          if (!policy.allowed) wireResponse = { type: 'command', decision: 'decline', generationId: request.transportGenerationId, requestId: providerRequestId };
          else throw invalidServerRequestResponse('The provider did not advertise the requested command approval decision.');
        }
      }
    }
    if (request.requestKind === 'file') {
      if (response.type !== 'file') throw invalidServerRequestResponse('Response type does not match the pending file approval.');
      if (isGrantDecision(response.decision) && payload.grantRoot !== undefined && payload.grantRoot !== null) {
        throw invalidServerRequestResponse('File approvals cannot grant provider-requested root scope.');
      } else if (isGrantDecision(response.decision) && !hasAuditableFileApprovalTarget(payload, conversation, context, options.items)) {
        throw invalidServerRequestResponse('The pending file approval does not identify an auditable project-local target.');
      }
    }
    if (request.requestKind === 'permissions') {
      if (response.type !== 'permissions' || !isSupportedPermissionRequest(payload) || !isSupportedPermissionGrant(response.permissions)) {
        await failPermissionRequest(conversation, request, payload, coordinatorError('ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', 'Codex permission request or grant schema is unsupported.'));
      }
      if (response.type !== 'permissions') throw coordinatorError('ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', 'Codex permission response type is unsupported.');
      try {
        validatePermissionGrant(payload, response.permissions, context);
      } catch (error) {
        await failPermissionRequest(conversation, request, payload, error);
      }
    }
    if (request.requestKind === 'mcp') {
      if (response.type !== 'mcp' || !isValidMcpElicitationResponse(payload, response)) {
        throw invalidServerRequestResponse('MCP elicitation response does not satisfy the pending request mode and schema.');
      }
    }
    if (request.requestKind === 'request_user_input') {
      if (response.type !== 'request_user_input') throw invalidServerRequestResponse('Response type does not match the pending request_user_input request.');
      const validationError = validateCanonicalRequestUserInputAnswers(payload, response.answers);
      if (validationError) throw invalidServerRequestResponse(validationError);
    }
    await input.providerWriteLifecycle?.markPrepared(request.id);
    input.providerWriteLifecycle?.markRpcStarted(request.id);
    await persist();
    await options.manager.respondToServerRequest(wireResponse);
    const effectiveResponse = stripRequestTransport(wireResponse);
    const secret = request.containsSecret && effectiveResponse.type === 'request_user_input';
    options.requests.resolve(request.id, {
      response: effectiveResponse,
      isSecret: secret,
      ...(secret && effectiveResponse.type === 'request_user_input'
        ? { questionIds: Object.keys(effectiveResponse.answers), answerCount: Object.values(effectiveResponse.answers).reduce((total, answer) => total + answer.answers.length, 0) }
        : {}),
      resolvedAt: now(),
    });
    const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    if (turn?.providerTurnId) {
      const pending = options.requests.listByConversation(conversation.id).find((candidate) => candidate.turnId === turn.id && candidate.status === 'pending' && candidate.transportGenerationId === currentGenerationId);
      if (pending) {
        options.turns.upsert({ ...turn, status: 'waiting', updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'waiting',
        });
        runStates.set(conversation.id, {
          type: 'waiting',
          turnId: turn.providerTurnId,
          requestId: pending.id,
          reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
        });
      } else {
        options.turns.upsert({ ...turn, status: 'running', updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'active',
        });
        runStates.set(conversation.id, { type: 'active', turnId: turn.providerTurnId, phase: 'prework' });
      }
    }
    await persist();
    options.broadcast('conversation.request.resolved', {
      conversationId: conversation.id,
      requestId: request.id,
      requestKind: request.requestKind,
      ...('decision' in effectiveResponse ? { effectiveDecision: effectiveResponse.decision } : {}),
    });
    const submission = request.turnId ? options.submissions.listByConversation(conversation.id).find((entry) => entry.providerTurnId === options.turns.getById(request.turnId ?? '')?.providerTurnId) : undefined;
    return {
      operationId: operationId(),
      conversationId: conversation.id,
      submissionId: submission?.id ?? '',
      status: 'responded',
      providerThreadId: conversation.providerThreadId,
      providerTurnId: request.turnId ? (options.turns.getById(request.turnId)?.providerTurnId ?? null) : null,
    };
  }

    async function snoozeRequest(input: SnoozeNativeRequestInput): Promise<void> {
        assertOpen();
        const request = options.requests.getById(input.requestId);
        if (!request || request.requestKind !== 'request_user_input' || request.status !== 'pending') {
            throw coordinatorError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex user input request is not pending.');
        }
        clearAutoResolutionTimer(request.id);
        options.requests.snooze(request.id);
        await persist();
        options.broadcast('conversation.request.snoozed', {
            conversationId: request.conversationId,
            requestId: request.id
        });
    }

    function clearAutoResolutionTimer(requestId: string): void {
        const timer = autoResolutionTimers.get(requestId);
        if (timer) clearTimeout(timer);
        autoResolutionTimers.delete(requestId);
    }

    function scheduleAutoResolution(request: ZeusConversationServerRequestRecord): void {
        clearAutoResolutionTimer(request.id);
        if (request.requestKind !== 'request_user_input' || request.status !== 'pending' || request.autoResolutionState !== 'scheduled' || !request.expiresAt) return;
        const deadline = Date.parse(request.expiresAt);
        const current = Date.parse(now());
        if (!Number.isFinite(deadline) || !Number.isFinite(current)) return;
        const delay = Math.max(0, Math.min(2_147_000_000, deadline - current));
        autoResolutionTimers.set(
            request.id,
            setTimeout(() => {
                autoResolutionTimers.delete(request.id);
                void autoResolveRequest(request.id).catch((error) => options.broadcast('conversation.native.error', {
                    conversationId: request.conversationId,
                    requestId: request.id,
                    error: serializeError(error)
                }));
            }, delay),
        );
    }

    async function autoResolveRequest(requestId: string): Promise<void> {
        const request = options.requests.getById(requestId);
        if (!request || request.status !== 'pending' || request.autoResolutionState !== 'scheduled') return;
        await respondToRequest({requestId, response: {type: 'request_user_input', answers: {}}});
        options.requests.expire(requestId, {response: {type: 'request_user_input', answers: {}}, resolvedAt: now()});
        await persist();
    }

    async function respondToPlanImplementationRequest(input: RespondPlanImplementationRequestInput): Promise<NativeAcceptedOperation> {
        assertOpen();
        const conversation = requireConversation(input.conversationId);
        const request = planActions.getById(input.requestId);
        if (!request || request.conversationId !== conversation.id) {
            throw coordinatorError('ZEUS_PLAN_IMPLEMENTATION_REQUEST_NOT_FOUND', 'Plan implementation request was not found.');
        }
        const planItem = options.items.listByConversation(conversation.id).find((item) => item.id === request.planItemId);
        if (!planItem || planItem.itemType !== 'plan' || planItem.status !== 'completed' || !planItem.textContent.trim()) {
            throw coordinatorError('ZEUS_PLAN_IMPLEMENTATION_REQUEST_INVALID', 'Plan implementation request does not reference a completed non-empty plan.');
        }
        const timestamp = now();
        if (input.action === 'dismiss') {
            planActions.resolveLatestPending(request.id, conversation.id, {status: 'dismissed', resolvedAt: timestamp});
            await persist();
            options.broadcast('conversation.plan_implementation_request.changed', {
                conversationId: conversation.id,
                requestId: request.id,
                status: 'dismissed'
            });
            return {
                operationId: operationId(),
                conversationId: conversation.id,
                submissionId: '',
                status: 'responded',
                providerThreadId: conversation.providerThreadId,
                providerTurnId: null,
            };
        }

        const refinement = input.action === 'refine';
        const feedback = input.feedback?.trim() ?? '';
        if (refinement && !feedback) throw coordinatorError('ZEUS_PLAN_REFINEMENT_REQUIRED', 'Plan refinement feedback is required.');
        const previousContext = contexts.get(conversation.id) ?? contextFromConversation(conversation);
        const nextMode: ConversationCollaborationMode = refinement ? 'plan' : 'default';
        const context: ConversationDispatchContext = {
            ...previousContext,
            permissionMode: conversation.permissionMode,
            workMode: nextMode
        };
        const content = refinement ? feedback : `请实施以下已确认计划。严格按计划执行，并在完成后报告验证结果。\n\n${planItem.textContent}`;
        const submissionIdentity = operationId();
        const submission = options.db.transaction(() => {
            options.conversations.updateCollaborationMode(conversation.id, nextMode);
            const created = createSubmission(
                conversation.id,
                content,
                {
                    submissionId: `conversation_submission_${submissionIdentity}`,
                    idempotencyKey: `plan-action:${request.id}:${input.action}`,
                    clientUserMessageId: `plan-action-client:${request.id}:${input.action}`,
                    ...(refinement ? {} : {
                        displayText: '是，实施此计划',
                        origin: 'implement_plan' as const,
                        planItemId: planItem.id
                    }),
                },
                context,
            );
            planActions.resolveLatestPendingInCurrentTransaction(request.id, conversation.id, {
                status: refinement ? 'refinement_requested' : 'implemented',
                submissionId: created.id,
                resolvedAt: timestamp,
            });
            return created;
        });
        contexts.set(conversation.id, context);
        await persist();
        options.broadcast('conversation.plan_implementation_request.changed', {
            conversationId: conversation.id,
            requestId: request.id,
            status: refinement ? 'refinement_requested' : 'implemented',
            submissionId: submission.id,
            collaborationMode: nextMode,
        });
        const refreshed = requireConversation(conversation.id);
        const state = runStates.get(conversation.id) ?? inferRunState(refreshed);
        runStates.set(conversation.id, state);
        if (state.type !== 'idle' || !hasConcurrency(context)) return accepted(submission, 'queued', refreshed.providerThreadId, null);
        return dispatchSubmission(refreshed, submission);
    }

  async function failPermissionRequest(conversation: ZeusConversationWithMessagesRecord, request: ReturnType<ConversationServerRequestRepository['getById']> & {}, payload: Record<string, unknown>, failure: unknown): Promise<never> {
    const turn = request?.turnId ? options.turns.getById(request.turnId) : undefined;
    const serialized: { message: string; code?: string; interruptError?: { message: string; code?: string } } = serializeError(failure);
    try {
      if (turn?.providerTurnId && conversation.providerThreadId) await options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: turn.providerTurnId });
    } catch (interruptError) {
      serialized.interruptError = serializeError(interruptError);
    }
    options.requests.upsert({
      conversationId: conversation.id,
      turnId: request?.turnId,
      itemId: request?.itemId,
      transportGenerationId: request!.transportGenerationId,
      providerRequestId: JSON.parse(request!.providerRequestIdJson) as string | number,
      requestKind: 'permissions',
      payload,
      status: 'failed',
      response: { error: serialized.code ?? 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', message: serialized.message },
      createdAt: request!.createdAt,
      resolvedAt: now(),
    });
    await persist();
    throw coordinatorError(serialized.code ?? 'ZEUS_CODEX_PERMISSION_SCHEMA_UNSUPPORTED', serialized.message);
  }

  async function recover(): Promise<void> {
    assertOpen();
    await providerEventChain;
    try {
      await ensureGenerationReconciled(true);
    } catch (error) {
      for (const submission of options.submissions.listRecoverable()) {
        if (submission.status !== 'dispatching' && submission.status !== 'active') continue;
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error: { code: 'ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', cause: serializeError(error) } });
        runStates.set(submission.conversationId, { type: 'paused', reason: 'recovery_required' });
      }
      await persist();
      return;
    }
      recoverCompletedPlanImplementationRequests();
    await persist();
      for (const conversation of options.conversations.listNativeBound()) {
          for (const request of options.requests.listByConversation(conversation.id)) scheduleAutoResolution(request);
      }
      await restoreArchivedConversationsWithPendingSubmissions();
    await drainQueuedSubmissions();
  }

    function recoverCompletedPlanImplementationRequests(): void {
        for (const conversation of options.conversations.listNativeBound()) {
            const submissions = options.submissions.listByConversation(conversation.id);
            for (const turn of options.turns.listByConversation(conversation.id)) {
                if (turn.status !== 'completed') continue;
                const submission = submissions.find((candidate) => candidate.id === turn.clientSubmissionId);
                ensurePlanImplementationRequest(conversation.id, turn, submission, turn.completedAt ?? turn.updatedAt);
            }
        }
    }

  async function capacityChanged(): Promise<void> {
    if (closing || closed || options.enabled === false) return;
      await restoreArchivedConversationsWithPendingSubmissions();
    await drainQueuedSubmissions();
    // 容量信号若与既有 drain 竞态，须在其 finalizer 清空 queueDrainPromise 后再跑一轮，避免丢失 terminal runtime 释放事件。
    if (!closing && !closed) await drainQueuedSubmissions();
  }

  function requestQueueDrain(): void {
    queueMicrotask(() => {
      void drainQueuedSubmissions().catch((error) => {
        options.broadcast('conversation.native.queue_dispatch_failed', { error: serializeError(error) });
      });
    });
  }

  function drainQueuedSubmissions(): Promise<void> {
    if (queueDrainPromise) return queueDrainPromise;
    const drain = (async () => {
      while (!closing && !closed) {
        const candidates = nextQueuedSubmissionPerConversation();
        let dispatched = false;
        for (const submission of candidates) {
          const conversation = options.conversations.getById(submission.conversationId);
            if (!conversation || conversation.archived || conversation.providerState === 'archived' || conversation.providerState === 'closed' || conversation.providerState === 'failed') continue;
            const context = {...contextFromSubmission(submission), permissionMode: conversation.permissionMode};
          contexts.set(conversation.id, context);
          const state = runStates.get(conversation.id) ?? inferRunState(conversation);
          runStates.set(conversation.id, state);
          if (state.type !== 'idle' || !hasConcurrency(context)) continue;
          if (closing || closed) return;
          const result = await dispatchSubmission(conversation, submission);
          if (result.status === 'active') dispatched = true;
        }
        if (!dispatched) return;
      }
    })();
    queueDrainPromise = drain.finally(() => {
      queueDrainPromise = null;
    });
    return queueDrainPromise;
  }

  function nextQueuedSubmissionPerConversation(): ZeusConversationSubmissionRecord[] {
    const heads = new Map<string, ZeusConversationSubmissionRecord>();
    for (const submission of options.submissions.listRecoverable()) {
      if (submission.status !== 'queued') continue;
      const current = heads.get(submission.conversationId);
      if (!current || compareConversationQueueOrder(submission, current) < 0) heads.set(submission.conversationId, submission);
    }
    return [...heads.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  }

  function compareConversationQueueOrder(left: ZeusConversationSubmissionRecord, right: ZeusConversationSubmissionRecord): number {
    return (left.queuePosition ?? Number.MAX_SAFE_INTEGER) - (right.queuePosition ?? Number.MAX_SAFE_INTEGER) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  }

  async function ensureGenerationReconciled(force = false): Promise<void> {
    const capabilities = await options.manager.ensureReady({ commandPath: commandPath(), ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) });
    if (!force && reconciledGenerationId === capabilities.generationId) return;
    const targetGenerationId = capabilities.generationId;
    const reconcile = generationReconcileChain
      .catch(() => undefined)
      .then(async () => {
        if (!force && reconciledGenerationId === targetGenerationId) return;
        await reconcileBoundConversations(targetGenerationId);
        const current = options.manager.getState();
        if (current.type !== 'ready' || current.generationId !== targetGenerationId) {
          throw coordinatorError('ZEUS_CODEX_GENERATION_CHANGED_DURING_RECOVERY', 'Codex app-server generation changed during native conversation recovery.');
        }
        reconciledGenerationId = targetGenerationId;
      });
    generationReconcileChain = reconcile.catch(() => undefined);
    await reconcile;
  }

  async function reconcileBoundConversations(generationId: string): Promise<void> {
    const boundConversationIds = new Set<string>();
    for (const conversation of options.conversations.listNativeBound()) {
      boundConversationIds.add(conversation.id);
      try {
        failStalePendingRequests(conversation.id, generationId);
        const contextual = options.submissions.listByConversation(conversation.id).find((submission) => isRecord(parseJsonRecord(submission.inputJson).context));
        if (contextual) contexts.set(conversation.id, contextFromSubmission(contextual));
        const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
        await options.manager.resumeThread({ threadId: providerThreadId, ...(contexts.get(conversation.id)?.projectLocalPath ? { cwd: contexts.get(conversation.id)!.projectLocalPath } : {}) });
        const snapshot = await options.manager.readThread({ threadId: providerThreadId });
        reconcileConversationSnapshot(conversation, snapshot, generationId);
      } catch (error) {
          if (isProviderThreadArchivedError(error)) markConversationProviderArchived(conversation.id, error);
          else markConversationRecoveryRequired(conversation.id, error);
          options.broadcast(isProviderThreadArchivedError(error) ? 'conversation.thread.archived' : 'conversation.native.recovery_failed', {
          conversationId: conversation.id,
          providerThreadId: conversation.providerThreadId,
          generationId,
          error: serializeError(error),
        });
      }
      await persist();
    }
    for (const submission of options.submissions.listRecoverable()) {
      if ((submission.status !== 'dispatching' && submission.status !== 'active') || boundConversationIds.has(submission.conversationId)) continue;
      markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'Native submission has no recoverable provider thread.'));
    }
  }

  function reconcileConversationSnapshot(conversation: ZeusConversationWithMessagesRecord, snapshot: CodexThreadSnapshot, generationId: string): void {
    const submissions = options.submissions.listByConversation(conversation.id);
    if (submissions.some((submission) => submission.status === 'paused' && submission.pausedReason === 'interrupted')) {
      runStates.set(conversation.id, { type: 'paused', reason: 'interrupted' });
      return;
    }
    const inFlight = submissions.filter((submission) => submission.status === 'dispatching' || submission.status === 'active');
    if (inFlight.length === 0) {
      runStates.set(conversation.id, inferRunState(conversation));
      return;
    }
    for (const submission of inFlight) {
      const snapshotTurn = findSnapshotTurn(snapshot, submission);
      const providerTurnId = snapshotTurn && typeof snapshotTurn.id === 'string' ? snapshotTurn.id : submission.providerTurnId;
      const classification = classifySnapshotTurn(snapshotTurn);
      if (!snapshotTurn || !providerTurnId || classification === 'unknown') {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'Provider thread state cannot confirm the in-flight submission.'));
        continue;
      }
      const timestamp = now();
      const existingTurn = options.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === providerTurnId || turn.clientSubmissionId === submission.id);
      const turn = upsertRecoveredTurn(existingTurn, {
        conversationId: conversation.id,
        providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
        providerTurnId,
        clientSubmissionId: submission.id,
        status: classification === 'completed' ? 'completed' : classification === 'interrupted' ? 'interrupted' : classification === 'failed' ? 'failed' : 'running',
        timestamp,
      });
      if (classification === 'active') {
        const pending = options.requests.listByConversation(conversation.id).find((request) => request.turnId === turn.id && request.status === 'pending' && request.transportGenerationId === generationId);
        if (pending) options.turns.upsert({ ...turn, status: 'waiting', updatedAt: timestamp });
        options.submissions.updateStatus(submission.id, 'active', { providerTurnId });
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: pending ? 'waiting' : 'active' });
        runStates.set(
          conversation.id,
          pending ? { type: 'waiting', turnId: providerTurnId, requestId: pending.id, reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval' } : { type: 'active', turnId: providerTurnId, phase: 'prework' },
        );
      } else if (classification === 'completed') {
        options.submissions.updateStatus(submission.id, 'completed', { providerTurnId, resolvedAt: timestamp });
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: 'ready' });
        runStates.set(conversation.id, { type: 'idle' });
      } else if (classification === 'interrupted') {
        options.submissions.updateStatus(submission.id, 'completed', { providerTurnId, resolvedAt: timestamp });
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: 'paused' });
        runStates.set(conversation.id, { type: 'paused', reason: 'interrupted' });
      } else {
        const failureParams = { turn: snapshotTurn };
        const failure = providerTurnFailure(failureParams, providerTurnId);
        const failureRecord = providerTurnFailureRecord(failureParams, failure);
        options.turns.upsert({ ...turn, status: 'failed', error: failureRecord, completedAt: timestamp, updatedAt: timestamp });
        options.submissions.updateStatus(submission.id, 'failed', { providerTurnId, resolvedAt: timestamp, error: failureRecord });
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) {
          options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required', error: failureRecord });
        }
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: 'failed' });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        const resultKey = `${conversation.id}:${providerTurnId}`;
        failedTurnResults.set(resultKey, failure);
        rejectTurnResultWaiters(resultKey, failure);
      }
    }
  }

  function upsertRecoveredTurn(
    existing: ZeusConversationTurnRecord | undefined,
    input: {
      conversationId: string;
      providerThreadId: string;
      providerTurnId: string;
      clientSubmissionId: string;
      status: ZeusConversationTurnRecord['status'];
      timestamp: string;
    },
  ): ZeusConversationTurnRecord {
    return options.turns.upsert({
      ...(existing ? { id: existing.id } : {}),
      conversationId: input.conversationId,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      clientSubmissionId: input.clientSubmissionId,
      status: input.status,
      startedAt: existing?.startedAt ?? input.timestamp,
      completedAt: input.status === 'completed' || input.status === 'interrupted' || input.status === 'failed' ? input.timestamp : null,
      createdAt: existing?.createdAt ?? input.timestamp,
      updatedAt: input.timestamp,
    });
  }

  function markConversationRecoveryRequired(conversationId: string, error: unknown): void {
    for (const submission of options.submissions.listByConversation(conversationId)) {
      if (submission.status === 'dispatching' || submission.status === 'active') markSubmissionRecoveryRequired(submission, error);
    }
    runStates.set(conversationId, { type: 'paused', reason: 'recovery_required' });
  }

    function markConversationProviderArchived(conversationId: string, error: unknown): void {
        const conversation = options.conversations.getById(conversationId);
        if (!conversation?.providerThreadId) return;
        const archivedError = {
            code: 'ZEUS_CODEX_THREAD_ARCHIVED',
            message: 'The Codex provider thread is archived.',
            cause: serializeError(error)
        };
        for (const submission of options.submissions.listByConversation(conversationId)) {
            if (submission.status !== 'queued' && submission.status !== 'dispatching' && submission.status !== 'active') continue;
            options.submissions.updateStatus(submission.id, 'paused', {
                pausedReason: 'provider_archived',
                error: archivedError
            });
        }
        options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: conversation.providerThreadId,
            providerModel: conversation.providerModel,
            providerState: 'archived',
        });
        runStates.set(conversationId, {type: 'paused', reason: 'provider_archived'});
        options.broadcast('conversation.thread.changed', {
            conversationId,
            providerThreadId: conversation.providerThreadId,
            providerState: 'archived',
        });
        options.broadcast('conversation.queue.changed', {conversationId});
    }

  function markSubmissionRecoveryRequired(submission: ZeusConversationSubmissionRecord, error: unknown): void {
    options.submissions.updateStatus(submission.id, 'paused', {
      pausedReason: 'recovery_required',
      error: { code: 'ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', cause: serializeError(error) },
    });
    runStates.set(submission.conversationId, { type: 'paused', reason: 'recovery_required' });
  }

    function ensurePlanImplementationRequest(conversationId: string, turn: ZeusConversationTurnRecord, submission: ZeusConversationSubmissionRecord | undefined, timestamp: string) {
        if (!submission || contextFromSubmission(submission).workMode !== 'plan') return null;
        const planItem = options.items
            .listByConversation(conversationId)
            .filter((item) => item.turnId === turn.id && item.itemType === 'plan' && item.status === 'completed' && item.textContent.trim())
            .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id))
            .at(-1);
        if (!planItem) return null;
        return planActions.createPending({
            conversationId,
            turnId: turn.id,
            planItemId: planItem.id,
            createdAt: timestamp
        });
    }

  async function pauseConversationForInvalidAuthority(input: {
    conversation: ZeusConversationWithMessagesRecord;
    threadId: string;
    providerTurnId: string | null;
    turn: ZeusConversationTurnRecord | undefined;
    request: { id: string; status: string };
    error: Record<string, unknown>;
    timestamp: string;
  }): Promise<Record<string, unknown>> {
    const recoveryError = { ...input.error };
    if (input.request.status === 'pending') options.requests.fail(input.request.id, { error: recoveryError, resolvedAt: input.timestamp });
    if (input.turn) options.turns.upsert({ ...input.turn, status: 'paused', error: recoveryError, updatedAt: input.timestamp });
    for (const submission of options.submissions.listByConversation(input.conversation.id)) {
      if (submission.status !== 'dispatching' && submission.status !== 'active' && submission.status !== 'queued') continue;
      options.submissions.updateStatus(submission.id, 'paused', {
        pausedReason: 'recovery_required',
        error: recoveryError,
        updatedAt: input.timestamp,
      });
    }
    options.conversations.bindProvider(input.conversation.id, {
      providerId: 'codex',
      providerThreadId: input.threadId,
      providerModel: input.conversation.providerModel,
      providerState: 'paused',
    });
    runStates.set(input.conversation.id, { type: 'paused', reason: 'recovery_required' });
    await persist();
    if (input.providerTurnId) {
      try {
        await options.manager.interruptTurn({ threadId: input.threadId, turnId: input.providerTurnId });
      } catch (error) {
        recoveryError.interruptError = serializeError(error);
      }
    }
    return recoveryError;
  }

  async function handleProviderEvent(event: CodexAppServerEvent): Promise<void> {
    if (closed) return;
    const identity = eventIdentity(event);
    if (processedEvents.has(identity)) return;
    const params = isRecord(event.params) ? event.params : {};
    const threadId = typeof params.threadId === 'string' ? params.threadId : null;
    const conversation = threadId ? options.conversations.getByProviderThreadId(threadId) : undefined;
    let broadcast: { type: string; payload: Record<string, unknown> } | null = null;
    let drainAfterTurn = false;
      let createdPlanImplementationRequest: ReturnType<ConversationPlanActionRepository['getById']> | null = null;

    if (event.method === 'transport/server_request_identity_conflict' && event.requestId !== undefined) {
      const request = options.requests.getByProvider(event.generationId, event.requestId);
      if (request?.status === 'pending') {
        const durableConversation = options.conversations.getById(request.conversationId);
        const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
        const durableThreadId = durableConversation?.providerThreadId ?? turn?.providerThreadId ?? threadId;
        const providerTurnId = turn?.providerTurnId ?? providerTurnIdFrom(params);
        if (durableConversation && durableThreadId) {
          const recoveryError = await pauseConversationForInvalidAuthority({
            conversation: durableConversation,
            threadId: durableThreadId,
            providerTurnId,
            turn,
            request,
            error: {
              error: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT',
              message: 'The provider reused one generation-scoped request identity with conflicting method or payload authority.',
              recoveryRequired: true,
              generationId: event.generationId,
              providerRequestId: event.requestId,
              originalMethod: params.originalMethod,
              receivedMethod: params.receivedMethod,
            },
            timestamp: event.receivedAt,
          });
          options.broadcast('conversation.request.resolved', {
            conversationId: durableConversation.id,
            requestId: request.id,
            providerTurnId,
            generationId: event.generationId,
            sequence: event.sequence,
          });
          broadcast = {
            type: 'conversation.native.error',
            payload: {
              conversationId: durableConversation.id,
              providerThreadId: durableThreadId,
              providerTurnId,
              requestId: request.id,
              ...recoveryError,
            },
          };
        }
      }
    } else if (event.method === 'turn/plan/updated' && conversation && threadId) {
        const providerTurnId = providerTurnIdFrom(params);
        if (!providerTurnId) return;
        const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
        if (!turn) return;
        const plan = normalizeTurnPlan(params);
        options.turns.updatePlan(turn.id, plan, event.receivedAt);
        broadcast = {
            type: 'conversation.turn.plan.updated',
            payload: {
                conversationId: conversation.id,
                projectId: conversation.projectId,
                providerThreadId: threadId,
                providerTurnId,
                plan,
            },
        };
    } else if (event.method === 'turn/completed' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      if (!providerTurnId) return;
      const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
      if (!turn) return;
      if (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') return;
      const terminalStatus = providerTurnTerminalStatus(params);
      const interrupted = terminalStatus === 'interrupted';
      const failed = terminalStatus === 'failed';
      const timestamp = event.receivedAt;
      const failure = failed ? providerTurnFailure(params, providerTurnId) : null;
      options.turns.upsert({
        ...turn,
        status: terminalStatus,
        ...(failure ? { error: providerTurnFailureRecord(params, failure) } : {}),
        completedAt: timestamp,
        updatedAt: timestamp,
      });
      const submissions = options.submissions.listByConversation(conversation.id);
      const activeSubmission = submissions.find((entry) => entry.providerTurnId === providerTurnId && (entry.status === 'active' || entry.status === 'dispatching'));
      if (activeSubmission) {
        options.submissions.updateStatus(activeSubmission.id, failed ? 'failed' : 'completed', {
          resolvedAt: timestamp,
          ...(failure ? { error: providerTurnFailureRecord(params, failure) } : {}),
        });
      }
        if (!failed && !interrupted) createdPlanImplementationRequest = ensurePlanImplementationRequest(conversation.id, turn, activeSubmission, timestamp);
      if (failed) {
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required' });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      } else if (interrupted) {
        for (const queued of options.submissions.listByConversation(conversation.id).filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
        runStates.set(conversation.id, { type: 'paused', reason: 'interrupted' });
      } else {
        runStates.set(conversation.id, { type: 'idle' });
      }
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId: threadId,
        providerModel: conversation.providerModel,
        providerState: failed ? 'failed' : interrupted ? 'paused' : 'ready',
      });
        const ephemeral = contexts.get(conversation.id)?.ephemeral === true;
        if (!failed && !interrupted && !ephemeral) options.conversations.setCompletionUnread(conversation.id, true);
      const resultKey = `${conversation.id}:${providerTurnId}`;
      if (failure) {
        failedTurnResults.set(resultKey, failure);
        rejectTurnResultWaiters(resultKey, failure);
      } else {
        const refreshed = options.conversations.getById(conversation.id);
        const answer = [...(refreshed?.messages ?? [])].reverse().find((message) => message.providerTurnId === providerTurnId && message.role === 'assistant')?.content ?? '';
        const result: NativeTurnResult = {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          status: interrupted ? 'interrupted' : 'completed',
          answer,
        };
        completedTurnResults.set(resultKey, result);
        for (const waiter of turnResultWaiters.get(resultKey) ?? []) {
          clearTimeout(waiter.timer);
          waiter.resolve(result);
        }
        turnResultWaiters.delete(resultKey);
      }
        if (ephemeral) {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: threadId,
          providerModel: conversation.providerModel,
          providerState: 'closed',
        });
        runStates.delete(conversation.id);
        contexts.delete(conversation.id);
      }
        broadcast = {
            type: 'conversation.turn.completed',
            payload: {
                conversationId: conversation.id,
                projectId: conversation.projectId,
                providerThreadId: threadId,
                providerTurnId,
                status: terminalStatus,
                hasUnreadCompletion: options.conversations.getById(conversation.id)?.completionUnread === true,
            },
        };
      drainAfterTurn = !failed;
    } else if (event.method === 'item/started' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const itemPayload = isRecord(params.item) ? params.item : {};
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn) return;
        const presentedItemPayload = itemPayload.type === 'userMessage' ? {...itemPayload, ...submissionPresentation(turn)} : itemPayload;
      const item = options.items.appendDelta({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: itemTypeFromValue(itemPayload.type),
        phase: phaseFromItem(itemPayload),
          payload: presentedItemPayload,
        delta: '',
        startedAt: event.receivedAt,
        updatedAt: event.receivedAt,
      });
        const durableClientMessageId = item.itemType === 'userMessage' ? persistProviderUserMessage(conversation, turn, presentedItemPayload, item.textContent || itemText(itemPayload), providerItemId, event.receivedAt) : null;
      broadcast = {
        type: 'conversation.item.started',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: { ...parseJsonRecord(item.payloadJson), ...(item.itemType === 'userMessage' ? { clientId: durableClientMessageId } : {}) },
          textContent: item.itemType === 'userMessage' ? itemText(itemPayload) : item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (isItemDeltaEvent(event.method) && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn || typeof params.delta !== 'string') return;
      const item = options.items.appendDelta({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: itemTypeFromMethod(event.method),
        phase: 'prework',
        payload: params,
        delta: params.delta,
        updatedAt: event.receivedAt,
      });
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: parseJsonRecord(item.payloadJson),
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (event.method === 'item/completed' && conversation && threadId) {
      const providerTurnId = providerTurnIdFrom(params);
      const itemPayload = isRecord(params.item) ? params.item : {};
      const providerItemId = providerItemIdFrom(params);
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      if (!providerTurnId || !providerItemId || !turn) return;
        const presentedItemPayload = itemPayload.type === 'userMessage' ? {...itemPayload, ...submissionPresentation(turn)} : itemPayload;
      const item = options.items.upsertCompleted({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId,
        itemType: itemTypeFromValue(itemPayload.type),
        phase: phaseFromItem(itemPayload),
          payload: presentedItemPayload,
        textContent: itemText(itemPayload),
        status: itemPayload.status === 'failed' ? 'failed' : 'completed',
        startedAt: typeof itemPayload.startedAt === 'string' ? itemPayload.startedAt : null,
        completedAt: event.receivedAt,
        updatedAt: event.receivedAt,
      });
      let durableClientMessageId: string | null = null;
      if (item.itemType === 'userMessage') {
          durableClientMessageId = persistProviderUserMessage(conversation, turn, presentedItemPayload, item.textContent, providerItemId, event.receivedAt);
      } else if (item.itemType === 'agentMessage') {
        options.conversations.appendMessage({
          conversationId: conversation.id,
          role: 'assistant',
          content: item.textContent,
          source: 'codex_native',
          metadata: { phase: item.phase },
          createdAt: event.receivedAt,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
        });
      }
      if (item.phase === 'final_answer') runStates.set(conversation.id, { type: 'active', turnId: providerTurnId, phase: 'final_answer' });
      broadcast = {
        type: 'conversation.item.updated',
        payload: {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType: item.itemType,
          itemPayload: { ...parseJsonRecord(item.payloadJson), ...(item.itemType === 'userMessage' ? { clientId: durableClientMessageId } : {}) },
          textContent: item.textContent,
          status: item.status,
          phase: item.phase,
        },
      };
    } else if (event.method === 'thread/settings/updated' && conversation) {
      const settings = isRecord(params.threadSettings) ? params.threadSettings : params;
      const snapshot = { generationId: event.generationId, sequence: event.sequence, model: requireString(settings.model, 'provider settings model'), ...(typeof settings.effort === 'string' ? { effort: settings.effort } : {}) };
      options.conversations.upsertProviderSettingsSnapshot(conversation.id, snapshot);
      broadcast = { type: 'conversation.provider.settings.updated', payload: { conversationId: conversation.id, ...snapshot } };
    } else if (event.method === 'thread/tokenUsage/updated' && conversation) {
      const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : params;
      const usage = isRecord(tokenUsage.total) ? tokenUsage.total : tokenUsage;
      const snapshot = {
        generationId: event.generationId,
        sequence: event.sequence,
        inputTokens: requireNumber(usage.inputTokens, 'inputTokens'),
        outputTokens: requireNumber(usage.outputTokens, 'outputTokens'),
        totalTokens: requireNumber(usage.totalTokens, 'totalTokens'),
      };
      options.conversations.upsertProviderTokenUsageSnapshot(conversation.id, snapshot);
      broadcast = { type: 'conversation.provider.token_usage.updated', payload: { conversationId: conversation.id, ...snapshot } };
    } else if (event.method === 'account/rateLimits/updated') {
      const value = isRecord(params.rateLimits) ? params.rateLimits : params;
      const snapshot = { generationId: event.generationId, sequence: event.sequence, value };
      options.settings.upsertCodexRateLimitsSnapshot(snapshot);
      broadcast = { type: 'codex.rate_limits.updated', payload: snapshot };
    } else if (event.method === 'mcpServer/startupStatus/updated') {
      const legacyStatuses = isRecord(params.statuses) ? normalizeMcpStartupStatusMap(params.statuses) : null;
      const currentStatus = legacyStatuses ? null : normalizeSingleMcpStartupStatus(params);
      const currentSnapshot = options.settings.getCodexMcpStartupStatusSnapshot();
      const value = legacyStatuses ?? Object.fromEntries([...(currentSnapshot?.generationId === event.generationId ? Object.entries(currentSnapshot.value) : []), [currentStatus!.serverId, currentStatus!.state]]);
      const snapshot = { generationId: event.generationId, sequence: event.sequence, value };
      const stored = options.settings.upsertCodexMcpStartupStatusSnapshot(snapshot);
      if (stored?.generationId === snapshot.generationId && stored.sequence === snapshot.sequence) {
        broadcast = { type: 'codex.mcp_startup_status.updated', payload: snapshot };
      }
    } else if (event.requestId !== undefined && conversation && threadId) {
      const requestKind = requestKindFromMethod(event.method);
      if (requestKind) {
        const providerTurnId = providerTurnIdFrom(params);
        const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
        const request = options.requests.upsert({
          conversationId: conversation.id,
          turnId: turn?.id,
            ...(typeof params.itemId === 'string' && params.itemId.trim() ? {itemId: params.itemId} : {}),
          transportGenerationId: event.generationId,
          providerRequestId: event.requestId,
          requestKind,
          payload: params,
          status: 'pending',
          containsSecret: requestKind === 'request_user_input' && hasSecretQuestion(params),
            ...(requestKind === 'request_user_input' && typeof params.autoResolutionMs === 'number' && Number.isFinite(params.autoResolutionMs) && params.autoResolutionMs >= 0
                ? {
                    expiresAt: new Date(Date.parse(event.receivedAt) + params.autoResolutionMs).toISOString(),
                    autoResolutionState: 'scheduled' as const,
                }
                : {}),
          createdAt: event.receivedAt,
        });
        const currentGenerationId = readyGenerationId();
        const canonicalRui = requestKind === 'request_user_input' ? parseCanonicalRequestUserInputQuestions(params) : null;
        if (canonicalRui && !canonicalRui.ok) {
          const recoveryError = await pauseConversationForInvalidAuthority({
            conversation,
            threadId,
            providerTurnId,
            turn,
            request,
            error: {
              error: 'ZEUS_CODEX_REQUEST_USER_INPUT_ENVELOPE_INVALID',
              message: canonicalRui.message,
              recoveryRequired: true,
              generationId: event.generationId,
              providerRequestId: event.requestId,
            },
            timestamp: event.receivedAt,
          });
          broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
        } else if (currentGenerationId !== event.generationId) {
          const recoveryError = {
            error: 'ZEUS_CODEX_REQUEST_GENERATION_STALE',
            message: 'The provider request arrived from a retired app-server generation and cannot become interaction authority.',
            recoveryRequired: true,
            requestGenerationId: event.generationId,
            currentGenerationId,
          };
          if (request.status === 'pending') options.requests.fail(request.id, { error: recoveryError, resolvedAt: event.receivedAt });
          broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
        } else if (request.status === 'resolved') {
          const replay = replayResolvedRequest(request, event.requestId);
          if (replay) {
            await options.manager.respondToServerRequest(replay);
          } else if (request.containsSecret) {
            const recoveryError: Record<string, unknown> = {
              error: 'ZEUS_CODEX_SECRET_REQUEST_REPLAY_UNAVAILABLE',
              message: 'A resolved secret request was delivered again, but its redacted answer cannot be replayed safely.',
              recoveryRequired: true,
              generationId: event.generationId,
              providerRequestId: event.requestId,
            };
            if (providerTurnId && conversation.providerThreadId) {
              try {
                await options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId });
              } catch (error) {
                recoveryError.interruptError = serializeError(error);
              }
            }
            options.requests.fail(request.id, { error: recoveryError, resolvedAt: event.receivedAt });
            if (turn) {
              options.turns.upsert({ ...turn, status: 'paused', error: recoveryError, updatedAt: event.receivedAt });
              const submission = options.submissions.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
              if (submission && (submission.status === 'active' || submission.status === 'dispatching')) {
                options.submissions.updateStatus(submission.id, 'paused', {
                  providerTurnId,
                  pausedReason: 'recovery_required',
                  error: recoveryError,
                  updatedAt: event.receivedAt,
                });
              }
            }
            options.conversations.bindProvider(conversation.id, {
              providerId: 'codex',
              providerThreadId: threadId,
              providerModel: conversation.providerModel,
              providerState: 'paused',
            });
            runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
            broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
          }
        } else if (request.status === 'pending') {
          if (providerTurnId && turn) {
            options.turns.upsert({ ...turn, status: 'waiting', updatedAt: event.receivedAt });
            options.conversations.bindProvider(conversation.id, {
              providerId: 'codex',
              providerThreadId: threadId,
              providerModel: conversation.providerModel,
              providerState: 'waiting',
            });
            runStates.set(conversation.id, { type: 'waiting', turnId: providerTurnId, requestId: request.id, reason: requestKind === 'request_user_input' ? 'user_input' : 'approval' });
          }
          broadcast = { type: 'conversation.request.created', payload: { conversationId: conversation.id, requestId: request.id, requestKind, providerTurnId } };
            scheduleAutoResolution(request);
        }
      }
    }

    processedEvents.add(identity);
    options.settings.setJson(processedEventsSettingKey, [...processedEvents].slice(-10_000));
    await persist();
    if (broadcast) {
      options.broadcast(broadcast.type, {
        ...broadcast.payload,
        generationId: event.generationId,
        sequence: event.sequence,
      });
    }
      if (createdPlanImplementationRequest) {
          options.broadcast('conversation.plan_implementation_request.changed', {
              conversationId: createdPlanImplementationRequest.conversationId,
              requestId: createdPlanImplementationRequest.id,
              status: createdPlanImplementationRequest.status,
              turnId: createdPlanImplementationRequest.turnId,
              planItemId: createdPlanImplementationRequest.planItemId,
          });
      }
    if (drainAfterTurn && conversation) await drainQueuedSubmissions();
  }

  async function safelyHandleProviderEventError(event: CodexAppServerEvent, error: unknown): Promise<void> {
    try {
      const params = isRecord(event.params) ? event.params : {};
      const threadId = typeof params.threadId === 'string' ? params.threadId : null;
      const conversation = threadId ? options.conversations.getByProviderThreadId(threadId) : undefined;
      const serialized = serializeError(error);
      const errorEntry = {
        generationId: event.generationId,
        sequence: event.sequence,
        method: event.method,
        receivedAt: event.receivedAt,
        error: serialized,
        ...(conversation ? { conversationId: conversation.id } : {}),
        ...(threadId ? { providerThreadId: threadId } : {}),
      };
      const currentErrors = options.settings.getJson<Array<typeof errorEntry>>(providerEventErrorsSettingKey) ?? [];
      options.settings.setJson(providerEventErrorsSettingKey, [...currentErrors, errorEntry].slice(-1_000));
      if (conversation && threadId) {
        const providerTurnId = providerTurnIdFrom(params) ?? [...options.turns.listByConversation(conversation.id)].reverse().find((turn) => turn.status === 'running' || turn.status === 'waiting')?.providerTurnId ?? null;
        const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
        if (providerTurnId && turn) {
          options.items.upsertCompleted({
            conversationId: conversation.id,
            turnId: turn.id,
            providerThreadId: threadId,
            providerTurnId,
            providerItemId: `native-provider-event-error-${event.generationId}-${event.sequence}`,
            itemType: 'error',
            phase: 'prework',
            payload: errorEntry,
            textContent: `${serialized.code ? `${serialized.code}: ` : ''}${serialized.message}`,
            status: 'failed',
            completedAt: event.receivedAt,
            updatedAt: event.receivedAt,
          });
        }
      }
      processedEvents.add(eventIdentity(event));
      options.settings.setJson(processedEventsSettingKey, [...processedEvents].slice(-10_000));
      await persist();
      options.broadcast(conversation ? 'conversation.native.error' : 'codex.native.error', errorEntry);
    } catch (diagnosticError) {
      try {
        options.broadcast('codex.native.error', {
          generationId: event.generationId,
          sequence: event.sequence,
          method: event.method,
          error: serializeError(error),
          diagnosticError: serializeError(diagnosticError),
        });
      } catch {
        // Provider 监听器异常不得污染 manager 的后续事件链。
      }
    }
  }

  function beginHandoff(waiterError: Error): Promise<void> {
    if (handoffPromise) return handoffPromise;
    closing = true;
      for (const requestId of [...autoResolutionTimers.keys()]) clearAutoResolutionTimer(requestId);
    unsubscribe();
    // unsubscribe 后冻结已接收链；这些 handler 仍可完整持久化和广播，closed 只能在 drain 之后设置。
    const acceptedProviderEventChain = providerEventChain;
    const activeQueueDrain = queueDrainPromise;
    handoffPromise = (async () => {
      await Promise.all([acceptedProviderEventChain, activeQueueDrain]);
      closed = true;
      for (const key of [...turnResultWaiters.keys()]) rejectTurnResultWaiters(key, waiterError);
    })();
    return handoffPromise;
  }

  return {
    startTaskConversation,
    startProjectConversation,
    startEphemeralConversation,
    waitForTurnResult,
    submitMessage,
    editQueuedSubmission,
    deleteQueuedSubmission,
    reorderQueue,
    sendQueuedNow,
    resumeInterruptedQueue,
      restoreArchivedConversation,
    interruptTurn,
    respondToRequest,
      snoozeRequest,
      respondToPlanImplementationRequest,
    recover,
    capacityChanged,
    close(input = { mode: 'final' }) {
      if (input.mode === 'handoff') {
        if (finalizationPromise) return finalizationPromise;
        return beginHandoff(coordinatorError('ZEUS_CODEX_SERVER_RESTARTING', 'The local server is restarting; retry the Graph request after reconnecting.'));
      }
      if (finalizationPromise) return finalizationPromise;
      finalizationPromise = (async () => {
        const error = coordinatorError('ZEUS_CODEX_COORDINATOR_CLOSED', 'Codex native conversation coordinator is closed.');
          for (const requestId of [...autoResolutionTimers.keys()]) clearAutoResolutionTimer(requestId);
        await beginHandoff(error);
        const interrupts: Promise<void>[] = [];
        const interruptedTurns = new Set<string>();
        // Ephemeral terminalization moves providerState to closed, so snapshot bound conversations before that transition.
        const nativeBoundConversations = options.conversations.listNativeBound();

        for (const [conversationId, context] of [...contexts]) {
          if (!context.ephemeral) continue;
          const conversation = options.conversations.getById(conversationId);
          if (!conversation) continue;
          const state = runStates.get(conversationId);
          const providerTurnId = state?.type === 'active' || state?.type === 'waiting' ? state.turnId : null;
          markEphemeralConversationClosed(conversationId, providerTurnId, 'failed', serializeError(error));
          if (providerTurnId && conversation.providerThreadId) {
            const interruptKey = `${conversation.providerThreadId}\0${providerTurnId}`;
            if (interruptedTurns.has(interruptKey)) continue;
            interruptedTurns.add(interruptKey);
            try {
              interrupts.push(
                options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: providerTurnId }).catch((interruptError) => {
                  options.broadcast('conversation.native.ephemeral_interrupt_failed', {
                    conversationId,
                    providerThreadId: conversation.providerThreadId,
                    providerTurnId,
                    error: serializeError(interruptError),
                  });
                }),
              );
            } catch (interruptError) {
              options.broadcast('conversation.native.ephemeral_interrupt_failed', {
                conversationId,
                providerThreadId: conversation.providerThreadId,
                providerTurnId,
                error: serializeError(interruptError),
              });
            }
          }
        }
        for (const key of [...turnResultWaiters.keys()]) rejectTurnResultWaiters(key, error);

        for (const conversation of nativeBoundConversations) {
          for (const request of options.requests.listByConversation(conversation.id)) {
            if (request.status !== 'pending') continue;
            const providerRequestId = JSON.parse(request.providerRequestIdJson) as string | number;
            if (request.requestKind === 'command' || request.requestKind === 'file') {
              const response = {
                type: request.requestKind,
                decision: 'cancel',
                generationId: request.transportGenerationId,
                requestId: providerRequestId,
              } as CodexServerRequestResponse;
              try {
                await options.manager.respondToServerRequest(response);
                options.requests.resolve(request.id, {
                  response: { type: request.requestKind, decision: 'cancel' },
                  resolvedAt: now(),
                });
              } catch (cancelError) {
                options.requests.fail(request.id, {
                  error: {
                    error: 'ZEUS_CODEX_SHUTDOWN_CANCEL_FAILED',
                    message: 'Pending Codex approval could not be cancelled during shutdown.',
                    cause: serializeError(cancelError),
                  },
                  resolvedAt: now(),
                });
              }
              continue;
            }

            options.requests.fail(request.id, {
              error: {
                error: 'ZEUS_CODEX_SHUTDOWN_INTERRUPTED',
                message: 'The unresolved Codex request was interrupted during shutdown.',
                requestKind: request.requestKind,
              },
              resolvedAt: now(),
            });
            const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
            if (!turn?.providerTurnId || !conversation.providerThreadId) continue;
            const interruptKey = `${conversation.providerThreadId}\0${turn.providerTurnId}`;
            if (interruptedTurns.has(interruptKey)) continue;
            interruptedTurns.add(interruptKey);
            interrupts.push(
              options.manager.interruptTurn({ threadId: conversation.providerThreadId, turnId: turn.providerTurnId }).catch((interruptError) => {
                options.broadcast('conversation.native.shutdown_interrupt_failed', {
                  conversationId: conversation.id,
                  providerThreadId: conversation.providerThreadId,
                  providerTurnId: turn.providerTurnId,
                  error: serializeError(interruptError),
                });
              }),
            );
          }
        }
        await persist();
        await Promise.all(interrupts);
      })();
      return finalizationPromise;
    },
  };

  function requireConversation(conversationId: string): ZeusConversationWithMessagesRecord {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.transportKind !== 'codex_native') throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation was not found.');
    return conversation;
  }

  function requireOwnedSubmission(conversationId: string, submissionId: string): ZeusConversationSubmissionRecord {
    const submission = options.submissions.getById(submissionId);
    if (!submission || submission.conversationId !== conversationId) throw coordinatorError('ZEUS_NATIVE_SUBMISSION_NOT_FOUND', 'Native submission was not found.');
    return submission;
  }

  function accepted(submission: ZeusConversationSubmissionRecord, status: NativeAcceptedOperation['status'], providerThreadId: string | null, providerTurnId: string | null): NativeAcceptedOperation {
    return { operationId: operationId(), conversationId: submission.conversationId, submissionId: submission.id, status, providerThreadId, providerTurnId };
  }
}

function providerPermissionProfile(context: ConversationDispatchContext): { sandbox: CodexSandboxPolicy; approvalPolicy: 'on-request' | 'never'; approvalsReviewer: 'user' } {
  if (context.permissionMode === 'full-access') return { sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never', approvalsReviewer: 'user' };
  if (context.permissionMode === 'auto') {
    return { sandbox: { type: 'workspaceWrite', writableRoots: [resolve(context.projectLocalPath)], networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
  }
  return { sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'on-request', approvalsReviewer: 'user' };
}

function stripRequestTransport(response: CodexServerRequestResponse): RespondNativeRequestInput['response'] {
  const effectiveResponse = { ...response } as Record<string, unknown>;
  delete effectiveResponse.generationId;
  delete effectiveResponse.requestId;
  return effectiveResponse as RespondNativeRequestInput['response'];
}

function replayResolvedRequest(request: NonNullable<ReturnType<ConversationServerRequestRepository['getById']>>, providerRequestId: string | number): CodexServerRequestResponse | null {
  if (request.containsSecret || !request.responseJson) return null;
  let response: unknown;
  try {
    response = JSON.parse(request.responseJson);
  } catch {
    return null;
  }
  if (!isRecord(response)) return null;
  const expectedType: Record<ConversationServerRequestKind, string> = {
    command: 'command',
    file: 'file',
    permissions: 'permissions',
    request_user_input: 'request_user_input',
    mcp: 'mcp',
  };
  if (response.type !== expectedType[request.requestKind]) return null;
  return {
    ...response,
    generationId: request.transportGenerationId,
    requestId: providerRequestId,
  } as CodexServerRequestResponse;
}

function developerInstructionsFor(context: ConversationDispatchContext): string {
  if (context.applyLegacyTaskGuards === false) return '';
  const instructions: string[] = [];
  if (!context.allowTests) instructions.push('不得运行会修改项目状态的测试。');
  if (!context.allowGitCommit) instructions.push('不得执行 git commit、push、merge、rebase、reset、revert、stash、checkout -b 或其他 Git 历史修改动作。');
  return instructions.join('\n');
}

function permissionModeFromValue(value: unknown, fallback: ConversationPermissionMode): ConversationPermissionMode {
  return value === 'read-only' || value === 'auto' || value === 'full-access' ? value : fallback;
}

function eventIdentity(event: CodexAppServerEvent): string {
  const params = isRecord(event.params) ? event.params : {};
  return [event.generationId, event.sequence, event.method, params.threadId ?? '', providerTurnIdFrom(params) ?? '', providerItemIdFrom(params) ?? '', event.requestId ?? ''].join('|');
}

function providerTurnIdFrom(params: Record<string, unknown>): string | null {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof params.turnId === 'string' ? params.turnId : typeof turn.id === 'string' ? turn.id : null;
}

function providerTurnStatus(params: Record<string, unknown>): string {
  const turn = isRecord(params.turn) ? params.turn : {};
  return typeof turn.status === 'string' ? turn.status : typeof params.status === 'string' ? params.status : 'unknown';
}

function providerTurnTerminalStatus(params: Record<string, unknown>): 'completed' | 'interrupted' | 'failed' {
  const status = providerTurnStatus(params);
  return status === 'completed' || status === 'interrupted' || status === 'failed' ? status : 'failed';
}

function normalizeTurnPlan(params: Record<string, unknown>): {
    explanation: string | null;
    steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>
} {
    if (!(params.explanation === null || typeof params.explanation === 'string')) {
        throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Invalid turn plan explanation.');
    }
    if (!Array.isArray(params.plan)) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Invalid turn plan steps.');
    const steps = params.plan.map((candidate, index) => {
        if (!isRecord(candidate) || typeof candidate.step !== 'string' || !candidate.step.trim()) {
            throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid turn plan step at index ${index}.`);
        }
        const statusValue = candidate.status;
        if (statusValue !== 'pending' && statusValue !== 'inProgress' && statusValue !== 'completed') {
            throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid turn plan status at index ${index}.`);
        }
        const status = statusValue as 'pending' | 'inProgress' | 'completed';
        return {step: candidate.step.trim(), status};
    });
    return {explanation: params.explanation, steps};
}

function providerTurnFailure(params: Record<string, unknown>, providerTurnId: string): Error & { code: string } {
  const turn = isRecord(params.turn) ? params.turn : {};
  const providerError = isRecord(turn.error) ? turn.error : isRecord(params.error) ? params.error : null;
  const providerStatus = providerTurnStatus(params);
  const message =
    typeof providerError?.message === 'string' && providerError.message.trim() ? providerError.message : providerStatus === 'failed' ? 'Codex provider turn failed.' : `Codex provider emitted unsupported terminal status: ${providerStatus}.`;
  return Object.assign(coordinatorError('ZEUS_CODEX_TURN_FAILED', message), { providerTurnId, providerStatus });
}

function providerTurnFailureRecord(params: Record<string, unknown>, failure: Error & { code: string }): Record<string, unknown> {
  const turn = isRecord(params.turn) ? params.turn : {};
  const providerError = isRecord(turn.error) ? turn.error : isRecord(params.error) ? params.error : null;
  return {
    code: failure.code,
    message: failure.message,
    providerTurnId: typeof turn.id === 'string' ? turn.id : null,
    providerStatus: providerTurnStatus(params),
    ...(providerError
      ? {
          providerError: {
            ...(typeof providerError.message === 'string' ? { message: providerError.message } : {}),
            ...(providerError.codexErrorInfo !== undefined ? { codexErrorInfo: providerError.codexErrorInfo } : {}),
            ...(typeof providerError.additionalDetails === 'string' ? { additionalDetails: providerError.additionalDetails } : {}),
          },
        }
      : {}),
  };
}

function failedTurnErrorFromRecord(turn: ZeusConversationTurnRecord): Error & { code: string } {
  let persisted: Record<string, unknown> = {};
  try {
    const parsed = turn.errorJson ? JSON.parse(turn.errorJson) : null;
    if (isRecord(parsed)) persisted = parsed;
  } catch {
    // Corrupt historical error details must not upgrade a failed turn to success.
  }
  const message = typeof persisted.message === 'string' && persisted.message ? persisted.message : 'Codex provider turn failed.';
  return Object.assign(coordinatorError('ZEUS_CODEX_TURN_FAILED', message), { providerTurnId: turn.providerTurnId });
}

function findSnapshotTurn(snapshot: CodexThreadSnapshot, submission: ZeusConversationSubmissionRecord): Record<string, unknown> | null {
  const turns = Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : [];
  if (submission.providerTurnId) {
    const byProviderId = turns.find((turn) => turn.id === submission.providerTurnId);
    if (byProviderId) return byProviderId;
  }
  return turns.find((turn) => turn.clientUserMessageId === submission.clientMessageId || turn.clientMessageId === submission.clientMessageId) ?? null;
}

function classifySnapshotTurn(turn: Record<string, unknown> | null): 'active' | 'completed' | 'interrupted' | 'failed' | 'unknown' {
  if (!turn) return 'unknown';
  const rawStatus = typeof turn.status === 'string' ? turn.status : isRecord(turn.state) && typeof turn.state.type === 'string' ? turn.state.type : '';
  const status = rawStatus.toLowerCase().replaceAll(/[^a-z]/gu, '');
  if (['active', 'running', 'started', 'inprogress', 'waiting', 'pending'].includes(status)) return 'active';
  if (['completed', 'complete', 'succeeded', 'success'].includes(status)) return 'completed';
  if (['interrupted', 'cancelled', 'canceled'].includes(status)) return 'interrupted';
  if (['failed', 'error'].includes(status)) return 'failed';
  return 'unknown';
}

function providerItemIdFrom(params: Record<string, unknown>): string | null {
  const item = isRecord(params.item) ? params.item : {};
  return typeof params.itemId === 'string' ? params.itemId : typeof item.id === 'string' ? item.id : null;
}

function isItemDeltaEvent(method: string): boolean {
  return method.startsWith('item/') && method.endsWith('/delta');
}

function itemTypeFromMethod(method: string): ConversationItemType {
  return itemTypeFromValue(method.split('/')[1]);
}

function itemTypeFromValue(value: unknown): ConversationItemType {
  const normalized = typeof value === 'string' ? value : 'error';
  const allowed: ConversationItemType[] = ['userMessage', 'agentMessage', 'reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'plan', 'imageView', 'webSearch', 'error'];
  return allowed.includes(normalized as ConversationItemType) ? (normalized as ConversationItemType) : 'error';
}

function phaseFromItem(item: Record<string, unknown>): ConversationItemPhase {
  return item.phase === 'final_answer' || item.phase === 'finalAnswer' ? 'final_answer' : item.type === 'agentMessage' ? 'final_answer' : 'prework';
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');
  return '';
}

function requestKindFromMethod(method: string): ConversationServerRequestKind | null {
  if (method === 'item/commandExecution/requestApproval') return 'command';
  if (method === 'item/fileChange/requestApproval') return 'file';
  if (method === 'item/permissions/requestApproval') return 'permissions';
  if (method === 'item/tool/requestUserInput') return 'request_user_input';
  if (method === 'mcpServer/elicitation/request') return 'mcp';
  return null;
}

function hasSecretQuestion(params: Record<string, unknown>): boolean {
  return Array.isArray(params.questions) && params.questions.some((question) => isRecord(question) && (question.isSecret === true || question.secret === true));
}

function invalidServerRequestResponse(message: string): Error & { code: string } {
  return coordinatorError('ZEUS_INVALID_SERVER_REQUEST_RESPONSE', message);
}

function isGrantDecision(decision: unknown): boolean {
  return decision === 'accept' || decision === 'acceptForSession';
}

function isExecpolicyAmendmentDecision(value: unknown): value is Exclude<CodexCommandApprovalDecision, string> {
    if (!isRecord(value) || !hasOnlyKeys(value, ['acceptWithExecpolicyAmendment'])) return false;
    const amendment = value.acceptWithExecpolicyAmendment;
    return (
        isRecord(amendment) &&
        hasOnlyKeys(amendment, ['execpolicy_amendment']) &&
        Array.isArray(amendment.execpolicy_amendment) &&
        amendment.execpolicy_amendment.length > 0 &&
        amendment.execpolicy_amendment.every((entry) => typeof entry === 'string' && entry.length > 0)
    );
}

function isAdvertisedCommandDecision(payload: Record<string, unknown>, decision: CodexCommandApprovalDecision): boolean {
  if (!Array.isArray(payload.availableDecisions)) return false;
    if (isExecpolicyAmendmentDecision(decision)) return payload.availableDecisions.some((entry) => jsonValuesEqual(entry, decision));
  return payload.availableDecisions.some((entry) => entry === decision || (isRecord(entry) && [entry.decision, entry.id, entry.value, entry.name].includes(decision)));
}

function hasAuditableFileApprovalTarget(payload: Record<string, unknown>, conversation: ZeusConversationWithMessagesRecord, context: ConversationDispatchContext, items: ConversationItemRepository): boolean {
  const directTargetKeys = ['path', 'filePath', 'targetPath'] as const;
  const directTargets: string[] = [];
  for (const key of directTargetKeys) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim()) return false;
    directTargets.push(value.trim());
  }
  if (directTargets.length > 0) return directTargets.every((target) => isAuditableProjectTarget(target, context.projectLocalPath));

  if (typeof payload.itemId !== 'string' || !payload.itemId || !conversation.providerThreadId) return false;
  const item = items.getByProvider(conversation.providerThreadId, payload.itemId);
  if (!item || item.conversationId !== conversation.id || item.itemType !== 'fileChange') return false;
  const itemPayload = parseJsonRecord(item.payloadJson);
  if (!Array.isArray(itemPayload.changes) || itemPayload.changes.length === 0) return false;
  const linkedTargets = itemPayload.changes.map((change) => (isRecord(change) && typeof change.path === 'string' && change.path.trim() ? change.path.trim() : null));
  return linkedTargets.every((target): target is string => target !== null) && linkedTargets.every((target) => isAuditableProjectTarget(target, context.projectLocalPath));
}

function isAuditableProjectTarget(value: string, projectRoot: string): boolean {
  const projectRealPath = existingDirectoryRealpath(projectRoot);
  if (!projectRealPath) return false;
  const projectLexicalPath = resolve(projectRoot);
  const targetPath = resolve(isAbsolute(value) ? value : resolve(projectLexicalPath, value));
  if (!isInsideRoot(targetPath, projectLexicalPath)) return false;
  let existingAncestor = targetPath;
  while (true) {
    try {
      return isInsideRoot(realpathSync(existingAncestor), projectRealPath);
    } catch {
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) return false;
      existingAncestor = parent;
    }
  }
}

function isValidMcpElicitationResponse(payload: Record<string, unknown>, response: Extract<RespondNativeRequestInput['response'], { type: 'mcp' }>): boolean {
  if (!isJsonValue(response.content) || !isJsonValue(response._meta)) return false;
  if (response.action === 'decline' || response.action === 'cancel') return response.content === null && response._meta === null;
  if (response.action !== 'accept') return false;
  if (!hasCanonicalMcpElicitationEnvelope(payload)) return false;
  if (payload.mode === 'url') return response.content === null && response._meta === null;
  if (response._meta !== null) return false;
  if (payload.mode === 'form') return response.content !== null && matchesCanonicalMcpFormSchema(payload.requestedSchema, response.content);
  if (payload.mode === 'openai/form') return response.content !== null && matchesSupportedJsonSchema(payload.requestedSchema, response.content);
  return false;
}

function hasCanonicalMcpElicitationEnvelope(payload: Record<string, unknown>): boolean {
  const commonKeys = ['threadId', 'turnId', 'serverName', 'mode', '_meta', 'message'];
  if (
    typeof payload.threadId !== 'string' ||
    !payload.threadId.trim() ||
    !(payload.turnId === null || (typeof payload.turnId === 'string' && Boolean(payload.turnId.trim()))) ||
    typeof payload.serverName !== 'string' ||
    !payload.serverName.trim() ||
    typeof payload.message !== 'string' ||
    !payload.message.trim() ||
    !Object.prototype.hasOwnProperty.call(payload, '_meta') ||
    !isJsonValue(payload._meta)
  ) {
    return false;
  }
  if (payload.mode === 'form' || payload.mode === 'openai/form') {
    return hasOnlyKeys(payload, [...commonKeys, 'requestedSchema']) && Object.prototype.hasOwnProperty.call(payload, 'requestedSchema');
  }
  if (payload.mode !== 'url' || !hasOnlyKeys(payload, [...commonKeys, 'url', 'elicitationId'])) return false;
  if (typeof payload.elicitationId !== 'string' || !payload.elicitationId.trim() || typeof payload.url !== 'string') return false;
  try {
    const url = new URL(payload.url);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function matchesCanonicalMcpFormSchema(schemaValue: unknown, value: unknown): boolean {
  if (!isRecord(schemaValue) || schemaValue.type !== 'object' || !isRecord(schemaValue.properties) || !hasOnlyKeys(schemaValue, ['$schema', 'type', 'properties', 'required'])) return false;
  if (schemaValue.$schema !== undefined && typeof schemaValue.$schema !== 'string') return false;
  const propertyEntries = Object.entries(schemaValue.properties);
  const required = schemaValue.required === undefined ? [] : schemaValue.required;
  if (!Array.isArray(required) || !required.every((entry) => typeof entry === 'string') || new Set(required).size !== required.length) return false;
  const propertyNames = new Set(propertyEntries.map(([name]) => name));
  if (required.some((name) => !propertyNames.has(name))) return false;
  if (!isRecord(value) || Object.keys(value).some((name) => !propertyNames.has(name))) return false;
  if (required.some((name) => !Object.prototype.hasOwnProperty.call(value, name))) return false;
  return propertyEntries.every(([name, propertySchema]) => isSupportedMcpPrimitiveSchema(propertySchema) && (!Object.prototype.hasOwnProperty.call(value, name) || matchesSupportedMcpPrimitiveSchema(propertySchema, value[name])));
}

function isSupportedMcpPrimitiveSchema(schemaValue: unknown): schemaValue is Record<string, unknown> {
  if (!isRecord(schemaValue) || typeof schemaValue.type !== 'string') return false;
  const commonKeys = ['type', 'title', 'description', 'default'];
  if ((schemaValue.title !== undefined && typeof schemaValue.title !== 'string') || (schemaValue.description !== undefined && typeof schemaValue.description !== 'string')) return false;
  if (schemaValue.type === 'string') {
    const hasEnum = Object.prototype.hasOwnProperty.call(schemaValue, 'enum');
    const hasOneOf = Object.prototype.hasOwnProperty.call(schemaValue, 'oneOf');
    if (hasEnum && hasOneOf) return false;
    if (hasEnum) {
      if (!hasOnlyKeys(schemaValue, [...commonKeys, 'enum', 'enumNames'])) return false;
      const choices = supportedStringChoices(schemaValue);
      return choices !== null && (schemaValue.default === undefined || (typeof schemaValue.default === 'string' && choices.includes(schemaValue.default)));
    }
    if (hasOneOf) {
      if (!hasOnlyKeys(schemaValue, [...commonKeys, 'oneOf'])) return false;
      const choices = supportedStringChoices(schemaValue);
      return choices !== null && (schemaValue.default === undefined || (typeof schemaValue.default === 'string' && choices.includes(schemaValue.default)));
    }
    if (!hasOnlyKeys(schemaValue, [...commonKeys, 'minLength', 'maxLength', 'format'])) return false;
    if (!isOptionalNonNegativeInteger(schemaValue.minLength) || !isOptionalNonNegativeInteger(schemaValue.maxLength)) return false;
    if (typeof schemaValue.minLength === 'number' && typeof schemaValue.maxLength === 'number' && schemaValue.minLength > schemaValue.maxLength) return false;
    if (schemaValue.format !== undefined && (typeof schemaValue.format !== 'string' || !['email', 'uri', 'date', 'date-time'].includes(schemaValue.format))) return false;
    return schemaValue.default === undefined || (typeof schemaValue.default === 'string' && matchesCanonicalStringValue(schemaValue.default, schemaValue));
  }
  if (schemaValue.type === 'number' || schemaValue.type === 'integer') {
    if (!hasOnlyKeys(schemaValue, [...commonKeys, 'minimum', 'maximum'])) return false;
    if (![schemaValue.minimum, schemaValue.maximum, schemaValue.default].every((entry) => entry === undefined || (typeof entry === 'number' && Number.isFinite(entry)))) return false;
    if (typeof schemaValue.minimum === 'number' && typeof schemaValue.maximum === 'number' && schemaValue.minimum > schemaValue.maximum) return false;
    return schemaValue.default === undefined || matchesCanonicalNumberValue(schemaValue.default, schemaValue);
  }
  if (schemaValue.type === 'boolean') return hasOnlyKeys(schemaValue, commonKeys) && (schemaValue.default === undefined || typeof schemaValue.default === 'boolean');
  if (schemaValue.type === 'array') {
    if (!hasOnlyKeys(schemaValue, [...commonKeys, 'minItems', 'maxItems', 'items'])) return false;
    if (!isOptionalNonNegativeInteger(schemaValue.minItems) || !isOptionalNonNegativeInteger(schemaValue.maxItems)) return false;
    if (typeof schemaValue.minItems === 'number' && typeof schemaValue.maxItems === 'number' && schemaValue.minItems > schemaValue.maxItems) return false;
    const choices = supportedArrayChoices(schemaValue.items);
    if (choices === null || (typeof schemaValue.minItems === 'number' && schemaValue.minItems > choices.length)) return false;
    return schemaValue.default === undefined || matchesCanonicalArrayValue(schemaValue.default, schemaValue, choices);
  }
  return false;
}

function matchesSupportedMcpPrimitiveSchema(schemaValue: unknown, value: unknown): boolean {
  if (!isSupportedMcpPrimitiveSchema(schemaValue)) return false;
  if (schemaValue.type === 'string') {
    if (typeof value !== 'string') return false;
    const choices = supportedStringChoices(schemaValue);
    return choices !== null && (choices.length > 0 ? choices.includes(value) : matchesCanonicalStringValue(value, schemaValue));
  }
  if (schemaValue.type === 'number' || schemaValue.type === 'integer') return matchesCanonicalNumberValue(value, schemaValue);
  if (schemaValue.type === 'boolean') return typeof value === 'boolean';
  if (schemaValue.type === 'array') {
    const choices = supportedArrayChoices(schemaValue.items);
    return choices !== null && matchesCanonicalArrayValue(value, schemaValue, choices);
  }
  return false;
}

function supportedStringChoices(schema: Record<string, unknown>): string[] | null {
  const choiceShapes = [schema.enum !== undefined, schema.oneOf !== undefined].filter(Boolean).length;
  if (choiceShapes > 1) return null;
  if (schema.enum !== undefined) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every((entry) => typeof entry === 'string') || new Set(schema.enum).size !== schema.enum.length) return null;
    if (schema.enumNames !== undefined && (!Array.isArray(schema.enumNames) || schema.enumNames.length !== schema.enum.length || !schema.enumNames.every((entry) => typeof entry === 'string'))) return null;
    return schema.enum;
  }
  if (schema.enumNames !== undefined) return null;
  if (schema.oneOf !== undefined) return supportedConstOptions(schema.oneOf);
  return [];
}

function matchesCanonicalStringValue(value: string, schema: Record<string, unknown>): boolean {
  const length = Array.from(value).length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
  if (schema.format === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (schema.format === 'uri') {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (schema.format === 'date') return isValidCanonicalDate(value);
  if (schema.format === 'date-time') return isValidCanonicalDateTime(value);
  return true;
}

function matchesCanonicalNumberValue(value: unknown, schema: Record<string, unknown>): boolean {
  if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) return false;
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  return typeof schema.maximum !== 'number' || value <= schema.maximum;
}

function matchesCanonicalArrayValue(value: unknown, schema: Record<string, unknown>, choices: readonly string[]): boolean {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string') || new Set(value).size !== value.length) return false;
  if (!value.every((entry) => choices.includes(entry))) return false;
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
  return typeof schema.maxItems !== 'number' || value.length <= schema.maxItems;
}

function isValidCanonicalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isValidCanonicalDateTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/u.exec(value);
  if (!match || !isValidCanonicalDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
  const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);
  return hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && Number.isFinite(Date.parse(value));
}

function supportedArrayChoices(itemsValue: unknown): string[] | null {
  if (!isRecord(itemsValue)) return null;
  if (itemsValue.type === 'string' && hasOnlyKeys(itemsValue, ['type', 'enum'])) {
    return Array.isArray(itemsValue.enum) && itemsValue.enum.length > 0 && itemsValue.enum.every((entry) => typeof entry === 'string') && new Set(itemsValue.enum).size === itemsValue.enum.length ? itemsValue.enum : null;
  }
  if (hasOnlyKeys(itemsValue, ['anyOf'])) return supportedConstOptions(itemsValue.anyOf);
  return null;
}

function supportedConstOptions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const choices: string[] = [];
  for (const option of value) {
    if (!isRecord(option) || !hasOnlyKeys(option, ['const', 'title']) || typeof option.const !== 'string' || typeof option.title !== 'string') return null;
    choices.push(option.const);
  }
  return new Set(choices).size === choices.length ? choices : null;
}

function matchesSupportedJsonSchema(schemaValue: unknown, value: unknown): boolean {
  if (!isSupportedJsonSchemaDefinition(schemaValue)) return false;
  if (Array.isArray(schemaValue.enum) && !schemaValue.enum.some((entry) => jsonValuesEqual(entry, value))) return false;
  const type = typeof schemaValue.type === 'string' ? schemaValue.type : null;
  if (type === 'object') {
    if (!isRecord(value)) return false;
    const properties = isRecord(schemaValue.properties) ? schemaValue.properties : {};
    const required = Array.isArray(schemaValue.required) ? (schemaValue.required as string[]) : [];
    if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
    if (schemaValue.additionalProperties === false && Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(properties, key))) return false;
    return Object.entries(properties).every(([key, schema]) => !Object.prototype.hasOwnProperty.call(value, key) || matchesSupportedJsonSchema(schema, value[key]));
  }
  if (type === 'array') return Array.isArray(value) && (schemaValue.items === undefined || value.every((entry) => matchesSupportedJsonSchema(schemaValue.items, entry)));
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return type === null && isJsonValue(value);
}

function isSupportedJsonSchemaDefinition(schemaValue: unknown): schemaValue is Record<string, unknown> {
  if (!isRecord(schemaValue) || !hasOnlyKeys(schemaValue, ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'title', 'description', 'default'])) return false;
  if (schemaValue.enum !== undefined && (!Array.isArray(schemaValue.enum) || !schemaValue.enum.every(isJsonValue))) return false;
  if (schemaValue.title !== undefined && typeof schemaValue.title !== 'string') return false;
  if (schemaValue.description !== undefined && typeof schemaValue.description !== 'string') return false;
  if (schemaValue.default !== undefined && !isJsonValue(schemaValue.default)) return false;
  const type = schemaValue.type;
  if (type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(String(type))) return false;
  if (type === 'object') {
    if (schemaValue.properties !== undefined && (!isRecord(schemaValue.properties) || !Object.values(schemaValue.properties).every(isSupportedJsonSchemaDefinition))) return false;
    if (schemaValue.required !== undefined && (!Array.isArray(schemaValue.required) || !schemaValue.required.every((entry) => typeof entry === 'string'))) return false;
    if (schemaValue.additionalProperties !== undefined && typeof schemaValue.additionalProperties !== 'boolean') return false;
  } else if (schemaValue.properties !== undefined || schemaValue.required !== undefined || schemaValue.additionalProperties !== undefined) {
    return false;
  }
  if (type === 'array') {
    if (schemaValue.items !== undefined && !isSupportedJsonSchemaDefinition(schemaValue.items)) return false;
  } else if (schemaValue.items !== undefined) {
    return false;
  }
  return true;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

function isOptionalNonNegativeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && jsonValuesEqual(left[key], right[key]));
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function evaluateCommandApproval(payload: Record<string, unknown>, context: ConversationDispatchContext): { allowed: boolean; reason: string | null } {
  if (context.permissionMode === 'read-only') return { allowed: false, reason: 'read_only_mode' };
  const projectRealPath = existingDirectoryRealpath(context.projectLocalPath);
  if (!projectRealPath) return { allowed: false, reason: 'project_realpath_unavailable' };
  if (!isSupportedCommandApprovalPolicy(payload, context, projectRealPath)) return { allowed: false, reason: 'unsupported_or_elevated_policy' };
  const argv = directCommandArgv(payload);
  if (!argv || argv.some(hasShellMetaOrVariable)) return { allowed: false, reason: 'command_not_direct_argv' };
  if (isDirectPwd(argv)) return { allowed: true, reason: null };
  if (isDirectGitStatus(argv, context, projectRealPath)) return { allowed: true, reason: null };
  return { allowed: false, reason: 'command_not_allowlisted' };
}

function directCommandArgv(payload: Record<string, unknown>): string[] | null {
  const item = isRecord(payload.item) ? payload.item : {};
  if ([payload.commandText, payload.cmd, payload.argv, item.command, item.commandText, item.argv].some((candidate) => candidate !== undefined)) return null;
  if (Array.isArray(payload.command)) return payload.command.length > 0 && payload.command.every((entry) => typeof entry === 'string' && entry.length > 0) ? payload.command : null;
  if (typeof payload.command !== 'string') return null;
  return strictSimpleCommandArgv(payload.command);
}

function strictSimpleCommandArgv(command: string): string[] | null {
  if (command.length === 0 || command.trim() !== command || /[^\S ]/u.test(command)) return null;
  const argv = command.split(/ +/u);
  return argv.every((token) => token.length > 0 && !hasShellMetaOrVariable(token)) ? argv : null;
}

const shellMetaOrVariableCharacters = new Set(`;&|<>\`$\\\n\r*?[]{}()'"~!#`);

function hasShellMetaOrVariable(value: string): boolean {
  return [...value].some((character) => shellMetaOrVariableCharacters.has(character));
}

const allowedCommandRequestFields = new Set([
  'threadId',
  'turnId',
  'itemId',
  'startedAtMs',
  'approvalId',
  'environmentId',
  'reason',
  'networkApprovalContext',
  'command',
  'cwd',
  'commandActions',
  'additionalPermissions',
  'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments',
  'availableDecisions',
  'sandboxPolicy',
  'sandbox',
  'networkAccess',
  'writableRoots',
  'sandboxPermissions',
  'sandbox_permissions',
  'approvalPolicy',
]);

function isSupportedCommandApprovalPolicy(payload: Record<string, unknown>, context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (Object.keys(payload).some((key) => !allowedCommandRequestFields.has(key))) return false;
  for (const key of ['threadId', 'turnId', 'itemId'] as const) if (payload[key] !== undefined && typeof payload[key] !== 'string') return false;
  if (payload.startedAtMs !== undefined && !isNonNegativeInteger(payload.startedAtMs)) return false;
  for (const key of ['approvalId', 'reason'] as const) if (payload[key] !== undefined && payload[key] !== null && typeof payload[key] !== 'string') return false;
  if (payload.environmentId !== undefined && payload.environmentId !== null) return false;
  if (payload.networkApprovalContext !== undefined && payload.networkApprovalContext !== null) return false;
  if (payload.commandActions !== undefined && payload.commandActions !== null && (!Array.isArray(payload.commandActions) || !payload.commandActions.every(isJsonValue))) return false;
  if (payload.additionalPermissions !== undefined && payload.additionalPermissions !== null) return false;
  if (payload.proposedExecpolicyAmendment !== undefined && payload.proposedExecpolicyAmendment !== null) return false;
  if (payload.proposedNetworkPolicyAmendments !== undefined && payload.proposedNetworkPolicyAmendments !== null && (!Array.isArray(payload.proposedNetworkPolicyAmendments) || payload.proposedNetworkPolicyAmendments.length > 0))
    return false;
  if (payload.networkAccess !== undefined && payload.networkAccess !== false) return false;
  if (payload.sandboxPermissions !== undefined && payload.sandboxPermissions !== 'use_default') return false;
  if (payload.sandbox_permissions !== undefined && payload.sandbox_permissions !== 'use_default') return false;
  if (payload.approvalPolicy !== undefined && payload.approvalPolicy !== 'untrusted') return false;
  if (payload.cwd !== undefined && payload.cwd !== null && (typeof payload.cwd !== 'string' || !isExistingProjectDirectory(payload.cwd, context.projectLocalPath, projectRealPath))) return false;
  if (payload.writableRoots !== undefined && !areProjectWritableRoots(payload.writableRoots, context, projectRealPath)) return false;
  if (payload.sandboxPolicy !== undefined && !isSupportedCommandSandbox(payload.sandboxPolicy, context, projectRealPath)) return false;
  if (payload.sandbox !== undefined && !isSupportedCommandSandbox(payload.sandbox, context, projectRealPath)) return false;
  return true;
}

function isSupportedCommandSandbox(value: unknown, context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (!isRecord(value)) return false;
  if (value.type === 'readOnly') return Object.keys(value).every((key) => key === 'type' || key === 'networkAccess') && value.networkAccess === false;
  if (value.type !== 'workspaceWrite') return false;
  if (Object.keys(value).some((key) => key !== 'type' && key !== 'writableRoots' && key !== 'networkAccess')) return false;
  return value.networkAccess === false && areProjectWritableRoots(value.writableRoots, context, projectRealPath);
}

function areProjectWritableRoots(value: unknown, context: ConversationDispatchContext, projectRealPath: string): boolean {
  return context.permissionMode !== 'read-only' && Array.isArray(value) && value.every((entry) => typeof entry === 'string' && isExistingProjectDirectory(entry, context.projectLocalPath, projectRealPath));
}

function isExistingProjectDirectory(value: string, projectRoot: string, projectRealPath: string): boolean {
  const targetRealPath = existingDirectoryRealpath(isAbsolute(value) ? value : resolve(projectRoot, value));
  return targetRealPath !== null && isInsideRoot(targetRealPath, projectRealPath);
}

function existingDirectoryRealpath(value: string): string | null {
  try {
    const realPath = realpathSync(resolve(value));
    return statSync(realPath).isDirectory() ? realPath : null;
  } catch {
    return null;
  }
}

function trustedExecutableRealpath(value: string, allowlist: ReadonlySet<string>): boolean {
  if (!isAbsolute(value)) return false;
  try {
    const realPath = realpathSync(value);
    return statSync(realPath).isFile() && allowlist.has(realPath);
  } catch {
    return false;
  }
}

function isDirectPwd(argv: readonly string[]): boolean {
  return argv.length === 1 && trustedExecutableRealpath(argv[0] ?? '', trustedPwdExecutableRealpaths);
}

function isSupportedPermissionRequest(payload: Record<string, unknown>): boolean {
  const permissions = isRecord(payload.permissions) ? payload.permissions : null;
  if (!permissions || Object.keys(permissions).some((key) => key !== 'network' && key !== 'fileSystem')) return false;
  if (permissions.network !== undefined) {
    if (!isRecord(permissions.network) || Object.keys(permissions.network).some((key) => key !== 'enabled') || (permissions.network.enabled !== null && typeof permissions.network.enabled !== 'boolean')) return false;
  }
  if (permissions.fileSystem !== undefined) {
    if (!isRecord(permissions.fileSystem) || Object.keys(permissions.fileSystem).some((key) => !['read', 'write', 'globScanMaxDepth'].includes(key))) return false;
    for (const key of ['read', 'write'] as const) {
      const value = permissions.fileSystem[key];
      if (value !== undefined && value !== null && (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string'))) return false;
    }
    if (permissions.fileSystem.globScanMaxDepth !== undefined && !isNonNegativeInteger(permissions.fileSystem.globScanMaxDepth)) return false;
  }
  return true;
}

function isSupportedPermissionGrant(value: unknown): value is Extract<CodexServerRequestResponse, { type: 'permissions' }>['permissions'] {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'network' && key !== 'fileSystem')) return false;
  if (value.network !== undefined) {
    if (!isRecord(value.network) || Object.keys(value.network).some((key) => key !== 'enabled') || (value.network.enabled !== null && typeof value.network.enabled !== 'boolean')) return false;
  }
  if (value.fileSystem !== undefined) {
    if (!isRecord(value.fileSystem) || Object.keys(value.fileSystem).some((key) => !['read', 'write', 'globScanMaxDepth'].includes(key))) return false;
    for (const key of ['read', 'write'] as const) {
      const paths = value.fileSystem[key];
      if (paths !== undefined && paths !== null && (!Array.isArray(paths) || !paths.every((entry) => typeof entry === 'string'))) return false;
    }
    if (value.fileSystem.globScanMaxDepth !== undefined && !isNonNegativeInteger(value.fileSystem.globScanMaxDepth)) return false;
  }
  return true;
}

function validatePermissionGrant(requestPayload: Record<string, unknown>, grant: Extract<CodexServerRequestResponse, { type: 'permissions' }>['permissions'], context: ConversationDispatchContext): void {
  const requested = requestPayload.permissions as { network?: { enabled: boolean | null }; fileSystem?: { read: string[] | null; write: string[] | null; globScanMaxDepth?: number } };
  if (grant.network?.enabled === true) throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'Network access is disabled by the Task execution policy.');
  const projectRealPath = existingDirectoryRealpath(context.projectLocalPath);
  if (!projectRealPath) throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'Project root cannot be resolved for a filesystem permission grant.');
  const requestedFs = requested.fileSystem;
  const grantedFs = grant.fileSystem;
  if (!grantedFs) return;
  for (const key of ['read', 'write'] as const) {
    const grantedPaths = grantedFs[key];
    if (grantedPaths === null || grantedPaths === undefined) continue;
    if (key === 'write' && context.permissionMode === 'read-only' && grantedPaths.length > 0) {
      throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_POLICY', 'Filesystem write access is disabled by the conversation permission mode.');
    }
    if (grantedPaths.length === 0) continue;
    const requestedPaths = requestedFs?.[key];
    if (!Array.isArray(requestedPaths)) throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST', `Filesystem ${key} grant exceeds requested permissions.`);
    for (const path of grantedPaths) {
      const grantedRealPath = existingPermissionRealpath(path, context.projectLocalPath, projectRealPath);
      const requestedRealPaths = requestedPaths.map((requestedPath) => existingPermissionRealpath(requestedPath, context.projectLocalPath, projectRealPath));
      if (!grantedRealPath || !requestedRealPaths.includes(grantedRealPath)) {
        throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST', `Filesystem ${key} grant exceeds project or request boundary.`);
      }
    }
  }
  if (grantedFs.globScanMaxDepth !== undefined) {
    if (requestedFs?.globScanMaxDepth === undefined || grantedFs.globScanMaxDepth > requestedFs.globScanMaxDepth) {
      throw coordinatorError('ZEUS_CODEX_PERMISSION_GRANT_EXCEEDS_REQUEST', 'Filesystem glob scan depth exceeds requested permissions.');
    }
  }
}

function existingPermissionRealpath(value: string, projectRoot: string, projectRealPath: string): string | null {
  try {
    const targetRealPath = realpathSync(isAbsolute(value) ? value : resolve(projectRoot, value));
    return isInsideRoot(targetRealPath, projectRealPath) ? targetRealPath : null;
  } catch {
    return null;
  }
}

const supportedLocalImageExtensions: Readonly<Record<string, readonly string[]>> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'image/bmp': ['.bmp'],
  'image/heic': ['.heic', '.heif'],
  'image/tiff': ['.tif', '.tiff'],
};

function isSupportedLocalImageAttachment(attachment: NativeConversationAttachmentInput, canonicalPath: string): boolean {
  return supportedLocalImageExtensions[attachment.mime.toLowerCase()]?.includes(extname(canonicalPath).toLowerCase()) === true;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

const trustedPwdExecutableRealpaths = new Set(['/bin/pwd']);
const trustedGitExecutableRealpaths = new Set(['/usr/bin/git']);
const directGitStatusOptions = new Set([
  '--short',
  '-s',
  '--porcelain',
  '--porcelain=v1',
  '--porcelain=v2',
  '--branch',
  '-b',
  '--show-stash',
  '--ahead-behind',
  '--no-ahead-behind',
  '--ignored',
  '--long',
  '--verbose',
  '-v',
  '-vv',
  '--null',
  '-z',
  '--untracked-files=no',
  '--untracked-files=normal',
  '--untracked-files=all',
]);

function isDirectGitStatus(argv: readonly string[], context: ConversationDispatchContext, projectRealPath: string): boolean {
  if (!context.allowGitCommit || !trustedExecutableRealpath(argv[0] ?? '', trustedGitExecutableRealpaths)) return false;
  let index = 1;
  while (index < argv.length) {
    const option = argv[index] ?? '';
    if (option === '-C') {
      const path = argv[index + 1];
      if (!path || !isExistingProjectDirectory(path, context.projectLocalPath, projectRealPath)) return false;
      index += 2;
      continue;
    }
    if (option === '--no-pager') {
      index += 1;
      continue;
    }
    break;
  }
  if ((argv[index] ?? '').toLowerCase() !== 'status') return false;
  return argv.slice(index + 1).every((argument) => argument === '--' || directGitStatusOptions.has(argument) || !argument.startsWith('-'));
}

function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && rel !== '..');
}

function requestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw coordinatorError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted native conversation state is invalid.');
  return parsed;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Missing ${label}.`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid ${label}.`);
  return value;
}

function normalizeMcpStartupStatusMap(value: Record<string, unknown>): Record<string, CodexMcpServerStartupState> {
  return Object.fromEntries(
    Object.entries(value).map(([serverId, state]) => {
      if (typeof state === 'string') return [serverId, state];
      if (isRecord(state) && typeof state.status === 'string' && (state.error === undefined || state.error === null || typeof state.error === 'string')) {
        return [serverId, { status: state.status, ...(state.error === undefined ? {} : { error: state.error as string | null }) } satisfies CodexMcpServerStartupState];
      }
      throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid MCP startup status for ${serverId}.`);
    }),
  );
}

function normalizeSingleMcpStartupStatus(params: Record<string, unknown>): { serverId: string; state: CodexMcpServerStartupState } {
  const serverId = requireString(params.name, 'MCP server name');
  const status = requireString(params.status, `MCP startup status for ${serverId}`);
  if (params.error !== undefined && params.error !== null && typeof params.error !== 'string') {
    throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid MCP startup error for ${serverId}.`);
  }
  if (params.failureReason !== undefined && params.failureReason !== null && typeof params.failureReason !== 'string') {
    throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', `Invalid MCP startup failure reason for ${serverId}.`);
  }
  const error = typeof params.error === 'string' ? params.error : typeof params.failureReason === 'string' ? params.failureReason : params.error === null || params.failureReason === null ? null : undefined;
  return {
    serverId,
    state: { status, ...(error === undefined ? {} : { error }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeError(error: unknown): { message: string; code?: string } {
  return { message: error instanceof Error ? error.message : String(error), ...(isRecord(error) && typeof error.code === 'string' ? { code: error.code } : {}) };
}

function isProviderThreadArchivedError(error: unknown): boolean {
    return /\bis archived\b[\s\S]*\bunarchive\b/i.test(error instanceof Error ? error.message : String(error));
}

function coordinatorError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
