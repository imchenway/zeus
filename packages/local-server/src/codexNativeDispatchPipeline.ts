import { type CodexThreadGoal, toCodexWireReasoningEffort } from '@zeus/ai-runtime';
import type { ConversationCollaborationMode, ConversationNextTurnSettings, ConversationRepository, ZeusConversationGoalRecord, ZeusConversationSubmissionRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { ensureInitialCodexGoal } from './codexGoalApplication.js';
import type {
  ConversationDispatchContext,
  CreateCodexNativeConversationCoordinatorOptions,
  NativeAcceptedOperation,
  NativeConversationRunState,
  NativeOperationStatus,
  NativeProviderWriteLifecycle,
  NativeQueueSnapshot,
  NativeSessionCommandExecutor,
} from './codexNativeConversationContracts.js';
import {
  conversationSubmissionDispatchEnvelope,
  coordinatorError,
  developerInstructionsFor,
  isProviderThreadArchivedError,
  parseJsonRecord,
  parseStoredConversationSubmissionDispatchEnvelope,
  providerPermissionProfile,
  requestHash,
  requireString,
  serializeError,
  toRecoverySubmissionError,
} from './codexNativeConversationPolicy.js';
import { assertCallerDoesNotOverrideCompiledContext, mergeCodexAdditionalContext } from './codexNativeContextProtocol.js';
import { prepareCodexDispatchContext } from './codexContextDispatchPreparation.js';
import { CodexProviderCommandApplicationService } from './codexProviderCommandApplication.js';
import type { CodexProviderThreadAuthorityApplication } from './codexProviderThreadAuthority.js';
import { conversationToolResultDynamicTools } from './conversationPortableContext.js';
import type { ConversationSegmentLifecycle } from './conversationExecutionCoordinator.js';
import { isServiceTierUnavailableError } from './codexServiceTierDowngrade.js';
import { persistThreadProviderSettings } from './codexThreadMetadataProjection.js';
import type { ZeusToolBroker } from './zeusToolRegistry.js';

interface NativeConversationDispatchLease {
  submissionId: string;
  lifecycles: Set<NativeProviderWriteLifecycle>;
  rpcStartedResourceId: string | null;
  promise?: Promise<NativeAcceptedOperation>;
}

interface CodexNativeDispatchPipelineDependencies {
  options: CreateCodexNativeConversationCoordinatorOptions;
  providerCommands: CodexProviderCommandApplicationService;
  providerThreadAuthority: CodexProviderThreadAuthorityApplication;
  runStates: Map<string, NativeConversationRunState>;
  contexts: Map<string, ConversationDispatchContext>;
  volatileSubmissionText: Map<string, string>;
  zeusToolBroker?: ZeusToolBroker;

  accepted(submission: ZeusConversationSubmissionRecord, status: NativeOperationStatus, providerThreadId: string | null, providerTurnId: string | null): NativeAcceptedOperation;

  dispatchContextForSubmission(submission: ZeusConversationSubmissionRecord): ConversationDispatchContext;

  ensureConversationExecutionContext(conversationId: string, mode: 'dispatch', allowProductConversation?: boolean): Promise<void>;

  ensureGenerationReconciled(conversationIds: readonly string[]): Promise<void>;

  executeSessionCommand: NativeSessionCommandExecutor;

  inferRunState(conversation: ZeusConversationWithMessagesRecord): NativeConversationRunState;

  markConversationProviderArchived(conversationId: string, error: unknown): void;

  nextTurnSettingsFromContext(context: ConversationDispatchContext): ConversationNextTurnSettings;

  persistProviderReportedServiceTierDowngrade(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, actualServiceTier: string | null): void;

  persistSubmissionDispatchContext(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): void;

  planControlModeForSubmission(submission: ZeusConversationSubmissionRecord): ConversationCollaborationMode | null;

  projectGoal(conversationId: string, goal: CodexThreadGoal, providerTurnId: string | null, occurredAt: string): ZeusConversationGoalRecord;

  recordServiceTierDowngrade(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, reason: 'model_unsupported' | 'app_server_rejected', actualServiceTier?: string | null): void;

  recoverPausedConversation(conversationId: string, mode: 'dispatch'): Promise<ZeusConversationWithMessagesRecord>;

  requireConversation(conversationId: string): ZeusConversationWithMessagesRecord;

  requestQueueDrain(): void;

  restoreArchivedProviderThread(conversationId: string): Promise<NativeQueueSnapshot>;

  submissionGoalObjective(submission: ZeusConversationSubmissionRecord): string | null;

  submissionProviderInput(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): Record<string, unknown>[];

  submissionText(submission: ZeusConversationSubmissionRecord): string;
}

export function createCodexNativeDispatchPipeline(dependencies: CodexNativeDispatchPipelineDependencies) {
  const {
    accepted,
    contexts,
    dispatchContextForSubmission,
    ensureConversationExecutionContext,
    ensureGenerationReconciled,
    executeSessionCommand,
    inferRunState,
    markConversationProviderArchived,
    nextTurnSettingsFromContext,
    options,
    persistProviderReportedServiceTierDowngrade,
    persistSubmissionDispatchContext,
    planControlModeForSubmission,
    projectGoal,
    providerCommands,
    providerThreadAuthority,
    recordServiceTierDowngrade,
    recoverPausedConversation,
    requestQueueDrain,
    requireConversation,
    restoreArchivedProviderThread,
    runStates,
    submissionGoalObjective,
    submissionProviderInput,
    submissionText,
    volatileSubmissionText,
    zeusToolBroker,
  } = dependencies;
  const dispatchLeases = new Map<string, NativeConversationDispatchLease>();
  const now = options.now;
  const commandPath = () => (typeof options.commandPath === 'function' ? options.commandPath() : options.commandPath);
  const persist = () => options.db.save();
  const readyGenerationId = () => {
    const state = options.manager.getState();
    return state.type === 'ready' ? state.generationId : null;
  };

  function dispatchSubmission(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    providerWriteLifecycle?: NativeProviderWriteLifecycle,
    providerArchiveRecoveryAttempted = false,
    segmentLifecycle?: ConversationSegmentLifecycle,
  ): Promise<NativeAcceptedOperation> {
    const activeLease = dispatchLeases.get(conversationInput.id);
    if (activeLease) {
      if (activeLease.submissionId !== submission.id) {
        const conversation = options.conversations.getById(conversationInput.id);
        return Promise.resolve(accepted(submission, 'queued', conversation?.providerThreadId ?? null, null));
      }
      attachDispatchLifecycle(activeLease, providerWriteLifecycle);
      if (activeLease.promise) return activeLease.promise;
    }

    const lease: NativeConversationDispatchLease = {
      submissionId: submission.id,
      lifecycles: new Set(),
      rpcStartedResourceId: null,
    };
    attachDispatchLifecycle(lease, providerWriteLifecycle);
    const promise = dispatchSubmissionWithLease(conversationInput, submission, lease, providerArchiveRecoveryAttempted, segmentLifecycle).finally(() => {
      if (dispatchLeases.get(conversationInput.id) === lease) dispatchLeases.delete(conversationInput.id);
    });
    lease.promise = promise;
    dispatchLeases.set(conversationInput.id, lease);
    return promise;
  }

  async function dispatchSubmissionWithLease(
    conversationInput: ZeusConversationWithMessagesRecord | ReturnType<ConversationRepository['create']>,
    submission: ZeusConversationSubmissionRecord,
    lease: NativeConversationDispatchLease,
    providerArchiveRecoveryAttempted: boolean,
    segmentLifecycle?: ConversationSegmentLifecycle,
    serviceTierFallbackAttempted = false,
  ): Promise<NativeAcceptedOperation> {
    let conversation = options.conversations.getById(conversationInput.id);
    if (!conversation) throw coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_FOUND', 'Native conversation was not found.');
    if (!serviceTierFallbackAttempted) await segmentLifecycle?.beginDispatch();
    try {
      await ensureConversationExecutionContext(conversation.id, 'dispatch', segmentLifecycle?.requiresNewSegment === true);
      const recoveryState = runStates.get(conversation.id) ?? inferRunState(conversation);
      if (!segmentLifecycle?.requiresNewSegment && recoveryState.type === 'paused' && recoveryState.reason === 'provider_stop_pending') {
        return accepted(submission, 'queued', conversation.providerThreadId, null);
      }
      if (!segmentLifecycle?.requiresNewSegment && recoveryState.type === 'paused' && recoveryState.reason === 'recovery_required') {
        conversation = await recoverPausedConversation(conversation.id, 'dispatch');
      }
    } catch (error) {
      options.submissions.updateStatus(submission.id, 'paused', {
        pausedReason: 'recovery_required',
        error: toRecoverySubmissionError(error),
        updatedAt: now(),
      });
      runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      await persist();
      options.broadcast('conversation.native.recovery_failed', {
        conversationId: conversation.id,
        providerThreadId: conversation.providerThreadId,
        submissionId: submission.id,
        error: serializeError(error),
      });
      return accepted(submission, 'recovery_required', conversation.providerThreadId, null);
    }
    const context = dispatchContextForSubmission(submission);
    if (conversation.permissionMode !== context.permissionMode) options.conversations.updatePermissionMode(conversation.id, context.permissionMode);
    if (conversation.collaborationMode !== context.workMode) options.conversations.updateCollaborationMode(conversation.id, context.workMode);
    conversation = segmentLifecycle?.requiresNewSegment ? conversation : requireConversation(conversation.id);
    contexts.set(conversation.id, context);
    let candidateProviderThreadId: string | null = null;
    let commandOutboxId: string | null = null;
    let commandTraceIdentity: string | null = null;
    let commandProviderGenerationId: string | null = null;
    let providerWriteStarted = false;
    let threadStartedForSubmission = false;
    try {
      if (!segmentLifecycle?.requiresNewSegment) await ensureGenerationReconciled([conversation.id]);
      conversation = options.conversations.getById(conversation.id) ?? conversation;
      if (!segmentLifecycle?.requiresNewSegment && conversation.providerThreadId) {
        const reconciledState = runStates.get(conversation.id) ?? inferRunState(conversation);
        if (reconciledState.type === 'active') {
          providerThreadAuthority.observe(conversation.id, conversation.providerThreadId);
          return accepted(submission, 'queued', conversation.providerThreadId, null);
        }
        if (reconciledState.type === 'waiting' || reconciledState.type === 'dispatching') return accepted(submission, 'queued', conversation.providerThreadId, null);
        if (reconciledState.type !== 'idle') return accepted(submission, 'recovery_required', conversation.providerThreadId, null);
        const authority = await providerThreadAuthority.inspect(conversation, context);
        if (authority.type === 'active') return accepted(submission, 'queued', conversation.providerThreadId, null);
        conversation = requireConversation(conversation.id);
      }
      if (options.planActions.listByConversation(conversation.id).some((request) => request.status === 'pending') && !planControlModeForSubmission(submission)) {
        return accepted(submission, 'queued', conversation.providerThreadId, null);
      }
      const freshDispatchEnvelope = conversationSubmissionDispatchEnvelope(submission);
      const existingDelivery = options.commandDeliveries.get(freshDispatchEnvelope.commandId);
      const dispatchEnvelope = existingDelivery ? parseStoredConversationSubmissionDispatchEnvelope(existingDelivery.inbox.envelopeJson, freshDispatchEnvelope) : freshDispatchEnvelope;
      const preparedDelivery = options.commandDeliveries.acceptAndPrepare({
        envelope: dispatchEnvelope,
        requestSha256: submission.requestHash,
        destinationKind: 'provider_turn',
        destinationId: 'codex:turn',
        resourceId: submission.id,
        occurredAt: now(),
        mutateBusinessState: () => options.submissions.updateStatus(submission.id, 'dispatching', { dispatchedAt: now() }),
      });
      commandOutboxId = preparedDelivery.outbox.id;
      commandTraceIdentity = dispatchEnvelope.traceIdentity ?? null;
      segmentLifecycle?.bindCommandDelivery({ outboxId: preparedDelivery.outbox.id, providerId: 'codex' });
      runStates.set(conversation.id, { type: 'dispatching', submissionId: submission.id });
      const responsesRuntime = await options.resolveResponsesRuntime({
        modelSourceId: context.modelSourceId,
        model: context.model,
      });
      if (responsesRuntime) {
        await options.manager.ensureReady({
          commandPath: commandPath(),
          ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}),
          providerEnvironment: responsesRuntime.environment,
          responsesProvider: responsesRuntime.provider,
        });
      }
      let providerThreadId = segmentLifecycle?.requiresNewSegment ? null : conversation.providerThreadId;
      commandProviderGenerationId = providerThreadId ? options.manager.generationForThread(providerThreadId) : readyGenerationId();
      if (!providerThreadId && !commandProviderGenerationId) {
        commandProviderGenerationId = (await options.manager.ensureReady({ commandPath: commandPath(), ...(options.externalAgentHome ? { externalAgentHome: options.externalAgentHome } : {}) })).generationId;
      }
      if (!providerThreadId) {
        options.preflightCodexModelBudget({
          modelId: context.model,
          modelSourceId: context.modelSourceId,
          providerGenerationId: commandProviderGenerationId,
        });
      }
      const pluginPreparation = await options.plugins?.prepare({
        conversationId: conversation.id,
        projectId: context.projectId,
        cwd: context.projectLocalPath,
        model: context.model,
        source: providerThreadId ? 'resume' : 'startup',
        ...(providerThreadId ? {} : { prompt: submissionText(submission) }),
      });
      const developerInstructions = [developerInstructionsFor(context, options.browserAutomation !== undefined), pluginPreparation?.developerInstructions ?? ''].filter(Boolean).join('\n');
      const dynamicTools = [...conversationToolResultDynamicTools(), ...(zeusToolBroker ? zeusToolBroker.registry.codexTools : []), ...(pluginPreparation?.codexDynamicTools ?? [])];
      const providerBootstrapUtf8Bytes = Buffer.byteLength(
        JSON.stringify({
          developerInstructions,
          dynamicTools,
        }),
        'utf8',
      );
      if (!providerThreadId) {
        const profile = providerPermissionProfile(context);
        const threadRequest = {
          model: context.model,
          ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
          cwd: context.projectLocalPath,
          sandbox: profile.sandbox,
          approvalPolicy: profile.approvalPolicy,
          approvalsReviewer: profile.approvalsReviewer,
          developerInstructions,
          ephemeral: context.ephemeral,
          dynamicTools,
          ...(responsesRuntime ? { responsesRuntime } : {}),
        };
        markDispatchRpcStarted(lease, submission.id);
        const thread = await providerCommands.executeSession({
          operation: 'thread_start',
          commandKey: submission.id,
          scope: { kind: 'submission', id: submission.id },
          idempotencyKey: `thread-start:${submission.id}`,
          issuedAt: submission.createdAt,
          resourceId: submission.id,
          requestIdentity: {
            conversationId: conversation.id,
            model: context.model,
            modelSourceId: context.modelSourceId,
            serviceTier: Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? context.serviceTier : null,
            cwd: context.projectLocalPath,
            sandbox: profile.sandbox,
            approvalPolicy: profile.approvalPolicy,
            approvalsReviewer: profile.approvalsReviewer,
            ephemeral: context.ephemeral === true,
            developerInstructionsSha256: requestHash(developerInstructions),
            dynamicToolsSha256: requestHash(dynamicTools),
          },
          providerGenerationId: commandProviderGenerationId,
          invoke: (traceIdentity) => options.manager.startThread({ ...threadRequest, traceIdentity }),
          recoverAccepted: (nativeSessionId) => options.manager.readThread({ threadId: nativeSessionId }),
          isExplicitRejection: isRuntimeRejected,
          nativeSessionId: (acceptedThread) => acceptedThread.id,
          acceptedProviderGenerationId: (acceptedThread) => options.manager.generationForThread(acceptedThread.id),
        });
        providerThreadId = thread.id;
        threadStartedForSubmission = true;
        providerThreadAuthority.markSubscribed(thread.id);
        candidateProviderThreadId = thread.id;
        segmentLifecycle?.nativeSessionReady({
          nativeSessionId: thread.id,
          nativeSessionPath: typeof thread.path === 'string' ? thread.path : null,
          providerId: 'codex',
          providerModel: context.model,
          providerProtocolVersion: 'app-server',
          observedAt: now(),
        });
        if (!segmentLifecycle?.requiresNewSegment) {
          conversation = options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: thread.id,
            providerModel: context.model,
            providerState: 'ready',
          });
          persistThreadProviderSettings(options.conversations, conversation.id, thread);
        }
        await persist();
        if (!segmentLifecycle?.requiresNewSegment) {
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
      } else if (segmentLifecycle) {
        segmentLifecycle.nativeSessionReady({
          nativeSessionId: providerThreadId,
          nativeSessionPath: conversation.providerThreadPath,
          observedAt: now(),
        });
      }
      providerThreadId = requireString(providerThreadId, 'provider thread id');
      commandProviderGenerationId = options.manager.generationForThread(providerThreadId);
      if (segmentLifecycle && commandOutboxId) {
        segmentLifecycle.bindCommandDelivery({
          outboxId: commandOutboxId,
          providerId: 'codex',
          providerGenerationId: commandProviderGenerationId,
        });
      }
      const providerInput = submissionProviderInput(submission, context);
      const pluginPromptContext = await options.plugins?.beforeUserPrompt({
        conversationId: conversation.id,
        prompt: providerInput,
        permissionMode: context.permissionMode,
      });
      const profile = providerPermissionProfile(context);
      const serializedAt = now();
      const wireEffort = toCodexWireReasoningEffort(context.effort) ?? null;
      segmentLifecycle?.adapterSerialized(
        {
          model: context.model,
          effort: wireEffort,
          serviceTier: Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? context.serviceTier : null,
          collaborationMode: context.workMode,
          permissionMode: context.permissionMode,
        },
        { adapter: 'codex_app_server', method: 'turn/start', protocol: 'openai_responses' },
        serializedAt,
      );
      const preparedContext = await prepareCodexDispatchContext({
        manager: options.manager,
        providerCommands,
        compileDispatchContext: options.compileDispatchContext,
        plugins: options.plugins,
        segmentLifecycle,
        conversation: { id: conversation.id, projectId: context.projectId },
        submission: { id: submission.id, createdAt: submission.createdAt },
        providerGenerationId: commandProviderGenerationId,
        providerInput,
        providerBootstrapUtf8Bytes,
        threadStartedForSubmission,
        context: {
          projectLocalPath: context.projectLocalPath,
          taskId: context.taskId,
          model: context.model,
          modelSourceId: context.modelSourceId,
          effort: wireEffort,
          serviceTier: Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? context.serviceTier : undefined,
          permissionMode: context.permissionMode,
          allowCodeChanges: context.allowCodeChanges,
          additionalContext: context.additionalContext,
        },
        pluginPromptContext,
        responsesRuntime,
        beforePortableProviderWrite: () => markDispatchRpcStarted(lease, submission.id),
        now,
      });
      const compiledDispatchContext = preparedContext.compiled;
      const pluginCompactContext = preparedContext.pluginCompactContext;
      if (compiledDispatchContext) assertCallerDoesNotOverrideCompiledContext(context.additionalContext);
      const initialGoalObjective = submissionGoalObjective(submission);
      if (initialGoalObjective) {
        const goalConversationId = conversation.id;
        await ensureInitialCodexGoal({
          conversationId: goalConversationId,
          providerThreadId,
          objective: initialGoalObjective,
          goals: options.goals,
          manager: options.manager,
          markProviderWriteStarted: () => markDispatchRpcStarted(lease, submission.id),
          execute: ({ objective, invoke, recoverAccepted }) =>
            executeSessionCommand({
              operation: 'goal_set',
              conversationId: goalConversationId,
              threadId: providerThreadId,
              commandKey: `initial-goal:${submission.id}`,
              requestIdentity: { objective, status: 'active' },
              invoke,
              recoverAccepted,
            }),
          project: (goal) => projectGoal(goalConversationId, goal, null, now()),
          persist,
        });
      }
      const additionalContext = mergeCodexAdditionalContext(segmentLifecycle?.codexBootstrapAdditionalContext, compiledDispatchContext?.codexAdditionalContext, context.additionalContext, pluginPromptContext, pluginCompactContext);
      if (segmentLifecycle) segmentLifecycle.markProviderWriteStarted();
      else
        options.commandDeliveries.markProviderWriteStarted({
          outboxId: requireString(commandOutboxId, 'command outbox id'),
          occurredAt: now(),
        });
      providerWriteStarted = true;
      markDispatchRpcStarted(lease, submission.id);
      const turn = await options.manager.startTurn({
        threadId: providerThreadId,
        traceIdentity: commandTraceIdentity,
        ...(responsesRuntime ? { responsesRuntime } : {}),
        clientUserMessageId: submission.clientMessageId,
        input: providerInput,
        ...(additionalContext ? { additionalContext } : {}),
        ...(segmentLifecycle ? { requestWritten: () => segmentLifecycle.markProviderWriteStarted() } : {}),
        model: context.model,
        ...(wireEffort ? { effort: wireEffort } : {}),
        ...(Object.prototype.hasOwnProperty.call(context, 'serviceTier') ? { serviceTier: context.serviceTier } : {}),
        summary: 'auto',
        ...(context.workMode
          ? {
              collaborationMode: {
                mode: context.workMode,
                settings: {
                  model: context.model,
                  reasoning_effort: wireEffort,
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
      volatileSubmissionText.delete(submission.id);
      const timestamp = now();
      const acceptedTurnId = segmentLifecycle?.acceptSynchronously({
        providerTurnId: turn.id,
        acceptedAt: timestamp,
        runtimeEvidence: { method: 'turn/start', turnId: turn.id, responseReceived: true },
        providerEcho: turn,
      });
      if (segmentLifecycle?.requiresNewSegment) conversation = options.conversations.getById(conversation.id) ?? conversation;
      const existingProviderTurn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === turn.id);
      options.turns.upsert({
        ...(existingProviderTurn ? { id: existingProviderTurn.id } : acceptedTurnId ? { id: acceptedTurnId } : {}),
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
      const syncCheckpoint = options.syncCheckpoints.getByConversation(conversation.id);
      if (syncCheckpoint) {
        if (syncCheckpoint.providerThreadId === providerThreadId) {
          options.syncCheckpoints.advance({
            conversationId: conversation.id,
            providerThreadId,
            lastSyncedTurnId: turn.id,
            timestamp,
          });
        } else {
          options.syncCheckpoints.rebind({
            conversationId: conversation.id,
            providerThreadId,
            baselineTurnId: turn.id,
            timestamp,
          });
        }
      } else {
        options.syncCheckpoints.initialize({
          conversationId: conversation.id,
          providerThreadId,
          baselineTurnId: turn.id,
          timestamp,
        });
      }
      options.submissions.updateStatus(submission.id, 'active', {
        providerTurnId: turn.id,
        dispatchedAt: timestamp,
      });
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId,
        providerModel: context.model,
        providerState: 'active',
      });
      if (!segmentLifecycle && commandOutboxId) {
        options.commandDeliveries.recordOutcomeInCurrentTransaction({
          outboxId: commandOutboxId,
          outcome: 'accepted',
          evidence: {
            method: 'turn/start',
            traceIdentity: commandTraceIdentity,
            turnId: turn.id,
            responseReceived: true,
          },
          providerId: 'codex',
          providerGenerationId: commandProviderGenerationId,
          nativeSessionId: providerThreadId,
          nativeTurnId: turn.id,
          occurredAt: timestamp,
        });
      }
      runStates.set(conversation.id, { type: 'active', turnId: turn.id, phase: 'prework' });
      if (!serviceTierFallbackAttempted && parseJsonRecord(submission.inputJson).requestedServiceTier === 'priority' && context.serviceTier !== 'priority') {
        recordServiceTierDowngrade(conversation.id, submission, context, 'model_unsupported');
      }
      const providerSettings = options.conversations.getProviderSettingsSnapshot(conversation.id);
      if (threadStartedForSubmission && providerSettings && Object.prototype.hasOwnProperty.call(providerSettings, 'serviceTier')) {
        persistProviderReportedServiceTierDowngrade(conversation.id, submission, context, providerSettings.serviceTier ?? null);
      }
      await persist();
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        providerThreadId,
        providerTurnId: turn.id,
        submissionId: submission.id,
      });
      if (!existingProviderTurn) {
        options.broadcast('conversation.turn.started', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: turn.id,
          submissionId: submission.id,
          status: 'running',
          startedAt: timestamp,
        });
      }
      return accepted(submission, 'active', providerThreadId, turn.id);
    } catch (error) {
      if (!serviceTierFallbackAttempted && context.serviceTier === 'priority' && isServiceTierUnavailableError(error)) {
        const standardContext: ConversationDispatchContext = { ...context, serviceTier: null };
        persistSubmissionDispatchContext(submission, standardContext);
        options.conversations.updateNextTurnSettings(conversation.id, nextTurnSettingsFromContext(standardContext));
        contexts.set(conversation.id, standardContext);
        options.submissions.updateStatus(submission.id, 'queued', { providerTurnId: null, updatedAt: now() });
        runStates.set(conversation.id, { type: 'idle' });
        await persist();
        const retrySubmission = options.submissions.getById(submission.id) ?? submission;
        const retryConversation = options.conversations.getById(conversation.id) ?? conversation;
        const result = await dispatchSubmissionWithLease(retryConversation, retrySubmission, lease, providerArchiveRecoveryAttempted, segmentLifecycle, true);
        if (result.status !== 'recovery_required' && result.status !== 'provider_archived') {
          recordServiceTierDowngrade(conversation.id, retrySubmission, standardContext, 'app_server_rejected');
          await persist();
        }
        return result;
      }
      const providerArchived = isProviderThreadArchivedError(error);
      const explicitlyRejected = isRuntimeRejected(error) || providerArchived;
      const runtimeRejected = segmentLifecycle !== undefined && isRuntimeRejected(error);
      if (segmentLifecycle) {
        if (explicitlyRejected) await segmentLifecycle.rejectBeforeAcceptance(error, now());
        else await segmentLifecycle.fail(error, now());
      } else if (commandOutboxId) {
        options.commandDeliveries.recordOutcome({
          outboxId: commandOutboxId,
          outcome: explicitlyRejected ? 'explicitly_rejected' : providerWriteStarted ? 'outcome_unknown_after_write' : 'failed_before_write',
          evidence: serializeError(error),
          providerId: 'codex',
          providerGenerationId: commandProviderGenerationId,
          nativeSessionId: candidateProviderThreadId ?? conversation.providerThreadId,
          occurredAt: now(),
        });
      }
      if (runtimeRejected) {
        runStates.set(conversation.id, { type: 'paused', reason: 'runtime_rejected' });
        options.broadcast('conversation.queue.changed', {
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        return accepted(submission, 'queued', segmentLifecycle.requiresNewSegment ? candidateProviderThreadId : conversation.providerThreadId, null);
      }
      if (segmentLifecycle?.requiresNewSegment) {
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        options.broadcast('conversation.queue.changed', {
          conversationId: conversation.id,
          submissionId: submission.id,
        });
        return accepted(submission, 'recovery_required', candidateProviderThreadId, null);
      }
      const current = options.conversations.getById(conversation.id);
      const providerThreadId = current?.providerThreadId ?? null;
      if (context.ephemeral) {
        options.submissions.updateStatus(submission.id, 'failed', {
          resolvedAt: now(),
          error: serializeError(error),
        });
        if (current?.providerThreadId) {
          options.conversations.bindProvider(current.id, {
            providerId: 'codex',
            providerThreadId: current.providerThreadId,
            providerModel: current.providerModel,
            providerState: 'closed',
          });
        } else if (current) {
          options.conversations.updateRuntimeState(current.id, {
            status: 'failed',
            summary: 'Codex native ephemeral dispatch failed.',
          });
          options.conversations.archive(current.id);
        }
        runStates.delete(conversation.id);
        contexts.delete(conversation.id);
      } else if (providerThreadId === null && options.manager.getState().type !== 'ready') {
        options.submissions.updateStatus(submission.id, 'paused', {
          pausedReason: 'transport_unavailable',
          error: serializeError(error),
        });
        runStates.set(conversation.id, { type: 'paused', reason: 'transport_unavailable' });
      } else if (providerArchived) {
        markConversationProviderArchived(conversation.id, error);
        await persist();
        if (!providerArchiveRecoveryAttempted) {
          try {
            await restoreArchivedProviderThread(conversation.id);
            const retrySubmission = options.submissions.getById(submission.id);
            const retryConversation = options.conversations.getById(conversation.id);
            if (retrySubmission && retryConversation) return dispatchSubmissionWithLease(retryConversation, retrySubmission, lease, true, segmentLifecycle, serviceTierFallbackAttempted);
          } catch {
            // 恢复函数已保留原始消息与可重试状态。
          }
        }
        return accepted(submission, 'provider_archived', providerThreadId, null);
      } else {
        options.submissions.updateStatus(submission.id, 'paused', {
          pausedReason: 'recovery_required',
          error: serializeError(error),
        });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      }
      await persist();
      options.broadcast('conversation.queue.changed', {
        conversationId: conversation.id,
        submissionId: submission.id,
      });
      requestQueueDrain();
      return accepted(submission, 'recovery_required', providerThreadId, null);
    }
  }

  function attachDispatchLifecycle(lease: NativeConversationDispatchLease, lifecycle: NativeProviderWriteLifecycle | undefined): void {
    if (!lifecycle || lease.lifecycles.has(lifecycle)) return;
    lease.lifecycles.add(lifecycle);
    if (lease.rpcStartedResourceId) lifecycle.markRpcStarted(lease.rpcStartedResourceId);
  }

  function markDispatchRpcStarted(lease: NativeConversationDispatchLease, resourceId: string): void {
    lease.rpcStartedResourceId = resourceId;
    for (const lifecycle of lease.lifecycles) lifecycle.markRpcStarted(resourceId);
  }

  return dispatchSubmission;
}

function isRuntimeRejected(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'dispatchDisposition' in error && error.dispatchDisposition === 'runtime_rejected');
}
