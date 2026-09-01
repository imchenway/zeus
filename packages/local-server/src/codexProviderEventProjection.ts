import type { CodexAppServerEvent } from '@zeus/ai-runtime';
import { calculateCacheHitRate, type NativeTokenUsageSnapshot } from '@zeus/shared';
import { ConversationPlanActionRepository, projectConversationTurnFailure, type ZeusConversationSubmissionRecord } from '@zeus/storage';
import { parseCanonicalRequestUserInputQuestions } from './codexNativeRuiValidation.js';
import { sanitizeConversationItemPayload } from './conversationResources.js';
import { codexProviderEventIdentity, isCodexReadableItemTextDeltaEvent } from './codexProviderEventFlow.js';
import type { NativeTurnResult } from './codexNativeConversationContracts.js';
import type { CreateCodexNativeConversationCoordinatorOptions } from './codexNativeConversationCoordinator.js';
import type { ConversationDispatchContext } from './codexNativeConversationContracts.js';
import {
  completedItemProjection,
  coordinatorError,
  hasAuditableFileApprovalTarget,
  hasSecretQuestion,
  integerValue,
  isRecord,
  isToolResultItem,
  itemText,
  itemTypeFromMethod,
  itemTypeFromValue,
  liveProgressProjection,
  nativePendingRequestProjection,
  normalizeMcpStartupStatusMap,
  normalizeSingleMcpStartupStatus,
  normalizeTurnPlan,
  parseJsonRecord,
  phaseFromItem,
  providerEventReceipt,
  providerItemIdFrom,
  providerTimestamp,
  providerTurnFailure,
  providerTurnFailureRecord,
  providerTurnIdFrom,
  providerTurnTerminalStatus,
  providerTurnUserClientId,
  reasoningSummaryProjection,
  replayResolvedRequest,
  requestKindFromMethod,
  requireNumber,
  requireString,
  serializeError,
  tokenUsageBreakdown,
} from './codexNativeConversationPolicy.js';

// 拆分期间保留结构化工厂依赖，后续按领域端口继续收窄。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodexProviderEventProjectionDependencies = Record<string, any> & {
  options: CreateCodexNativeConversationCoordinatorOptions;
  markScheduledPersistDirty(): void;
};

export async function projectCodexProviderEvent(dependencies: CodexProviderEventProjectionDependencies, event: CodexAppServerEvent, receiptEvents: readonly CodexAppServerEvent[] = [event]): Promise<void> {
  const {
    clearAutoResolutionTimer,
    closed,
    contextFromConversation,
    contextFromSubmission,
    contexts,
    drainQueuedSubmissions,
    ensurePlanImplementationRequest,
    executeTurnCommand,
    failInvalidInteractionAuthority,
    failedTurnResults,
    flushScheduledPersist,
    goals,
    hasProcessedProviderEvent,
    interruptedQueueSubmissions,
    maintainProviderReceiptGenerations,
    markScheduledPersistDirty,
    options,
    modelRequestTiming,
    persist,
    persistProviderUserMessage,
    persistProviderReportedServiceTierDowngrade,
    projectGoal,
    projectProcessItem,
    projectProviderUserMessage,
    readyGenerationId,
    receipts,
    reconcileTerminalTurnSubmissions,
    recoverExternalRequestUserInputAnswer,
    recoverExternallyResolvedRequestUserInputAnswers,
    rejectTurnResultWaiters,
    resolveTurnResult,
    rememberProcessedProviderEvent,
    requiresImmediatePersist,
    respondToRequest,
    runStates,
    scheduleAutoResolution,
    scheduleExternalAnswerRecovery,
    schedulePersist,
    submissionPresentation,
    syncCheckpoints,
    syncItemResources,
  } = dependencies;
  if (closed) return;
  const identity = codexProviderEventIdentity(event);
  if (hasProcessedProviderEvent(event, identity)) return;
  const params: Record<string, unknown> = isRecord(event.params) ? event.params : {};
  const threadId = typeof params.threadId === 'string' ? params.threadId : null;
  const eventSegment = threadId ? options.execution.segmentByNativeSession(threadId) : undefined;
  const conversation = threadId ? (options.conversations.getByProviderThreadId(threadId) ?? (eventSegment ? options.conversations.getById(eventSegment.conversationId) : undefined)) : undefined;
  if (eventSegment?.state === 'sealed') {
    options.execution.persistWarning({
      conversationId: eventSegment.conversationId,
      warningKind: 'late_external_activity',
      payload: { segmentId: eventSegment.id, providerThreadId: threadId, method: event.method, receivedAt: event.receivedAt },
      occurredAt: event.receivedAt,
    });
    for (const receiptEvent of receiptEvents) {
      const receiptIdentity = codexProviderEventIdentity(receiptEvent);
      receipts.record(providerEventReceipt(receiptEvent, receiptIdentity));
      maintainProviderReceiptGenerations(receiptEvent.generationId);
      rememberProcessedProviderEvent(receiptEvent, receiptIdentity);
    }
    await persist();
    options.broadcast('conversation.warning.changed', {
      conversationId: eventSegment.conversationId,
      warningKind: 'late_external_activity',
    });
    return;
  }
  let broadcast: { type: string; payload: Record<string, unknown> } | null = null;
  let drainAfterTurn = false;
  let queueChangedAfterTurn = false;
  let sessionMetricsChanged = false;
  let createdPlanImplementationRequest: ReturnType<ConversationPlanActionRepository['getById']> | null = null;

  function broadcastLinkedFileApprovalChanges(providerItemId: string, providerTurnId: string): void {
    if (!conversation) return;
    const linkedRequests = options.requests.listPendingByConversation(conversation.id).filter((request) => request.requestKind === 'file' && parseJsonRecord(request.payloadJson).itemId === providerItemId);
    if (linkedRequests.length === 0) return;
    const approvalContext = contexts.get(conversation.id) ?? contextFromConversation(conversation);
    for (const request of linkedRequests) {
      options.broadcast('conversation.request.changed', {
        conversationId: conversation.id,
        requestId: request.id,
        requestKind: request.requestKind,
        providerTurnId,
        request: nativePendingRequestProjection(request, {
          conversation,
          projectRoot: approvalContext.projectLocalPath,
          providerItems: options.providerItems,
        }),
      });
    }
  }

  if (event.method === 'thread/goal/updated' && conversation && threadId) {
    const goal = await options.manager.readThreadGoal({ threadId });
    if (goal) projectGoal(conversation.id, goal, typeof params.turnId === 'string' ? params.turnId : null, event.receivedAt);
  } else if (event.method === 'thread/goal/cleared' && conversation && threadId) {
    const cleared = goals.clear({ conversationId: conversation.id, providerThreadId: threadId, occurredAt: event.receivedAt });
    if (cleared) options.broadcast('conversation.goal.cleared', { conversationId: conversation.id, cleared: true, timeline: goals.listEvents(conversation.id) });
  } else if (event.method === 'serverRequest/resolved') {
    const providerRequestId = typeof params.requestId === 'string' || typeof params.requestId === 'number' ? params.requestId : null;
    if (providerRequestId === null) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Codex serverRequest/resolved omitted requestId.');
    const request = options.requests.getByProvider(event.generationId, providerRequestId);
    if (request?.status === 'pending') {
      const durableConversation = options.conversations.getById(request.conversationId);
      if (durableConversation) {
        clearAutoResolutionTimer(request.id);
        const recovered = request.requestKind === 'request_user_input' ? await recoverExternalRequestUserInputAnswer(durableConversation, request, event.receivedAt) : null;
        const resolvedRequest =
          recovered?.recovery.status === 'found'
            ? recovered.request
            : options.requests.resolveExternally(request.id, {
                source: 'provider',
                resolvedAt: event.receivedAt,
                ...(recovered ? { answerRecovery: recovered.recovery.reason } : {}),
              });
        if (recovered && recovered.recovery.status !== 'found' && recovered.recovery.reason === 'answer_output_missing') scheduleExternalAnswerRecovery(durableConversation.id, request.id);
        const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
        if (turn?.providerTurnId) {
          const nextPending = options.requests.listByConversation(durableConversation.id).find((candidate) => candidate.turnId === turn.id && candidate.status === 'pending' && options.manager.hasGeneration(candidate.transportGenerationId));
          if (nextPending) {
            options.turns.upsert({ ...turn, status: 'waiting', updatedAt: event.receivedAt });
            options.conversations.bindProvider(durableConversation.id, {
              providerId: 'codex',
              providerThreadId: turn.providerThreadId,
              providerModel: durableConversation.providerModel,
              providerState: 'waiting',
            });
            runStates.set(durableConversation.id, {
              type: 'waiting',
              turnId: turn.providerTurnId,
              requestId: nextPending.id,
              reason: nextPending.requestKind === 'request_user_input' ? 'user_input' : 'approval',
            });
          } else {
            options.turns.upsert({ ...turn, status: 'running', updatedAt: event.receivedAt });
            options.conversations.bindProvider(durableConversation.id, {
              providerId: 'codex',
              providerThreadId: turn.providerThreadId,
              providerModel: durableConversation.providerModel,
              providerState: 'active',
            });
            runStates.set(durableConversation.id, { type: 'active', turnId: turn.providerTurnId, phase: 'prework' });
          }
        }
        broadcast = {
          type: 'conversation.request.resolved',
          payload: {
            conversationId: durableConversation.id,
            requestId: request.id,
            requestKind: request.requestKind,
            resolvedBy: 'provider',
            answerAvailability: recovered?.recovery.status === 'found' ? 'complete' : request.requestKind === 'request_user_input' ? 'unavailable' : 'not_applicable',
            request: nativePendingRequestProjection(resolvedRequest),
          },
        };
      }
    }
  } else if (event.method === 'transport/server_request_identity_conflict' && event.requestId !== undefined) {
    const request = options.requests.getByProvider(event.generationId, event.requestId);
    if (request?.status === 'pending') {
      const durableConversation = options.conversations.getById(request.conversationId);
      const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
      const durableThreadId = durableConversation?.providerThreadId ?? turn?.providerThreadId ?? threadId;
      const providerTurnId = turn?.providerTurnId ?? providerTurnIdFrom(params);
      if (durableConversation && durableThreadId) {
        const recoveryError = await failInvalidInteractionAuthority({
          conversation: durableConversation,
          threadId: durableThreadId,
          providerTurnId,
          turn,
          request,
          error: {
            error: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT',
            message: 'The provider reused one generation-scoped request identity with conflicting method or payload authority.',
            recoveryRequired: false,
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
  } else if (event.method === 'turn/started' && conversation && threadId) {
    const providerTurn = isRecord(params.turn) ? params.turn : params;
    const providerTurnId = providerTurnIdFrom(params);
    if (!providerTurnId) return;
    const timestamp = providerTimestamp(providerTurn.startedAt, event.receivedAt);
    const submissions = options.submissions.listByConversation(conversation.id);
    const providerClientId = providerTurnUserClientId(providerTurn);
    const existingTurn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
    const providerMatchedSubmission = providerClientId ? submissions.find((candidate) => candidate.clientMessageId === providerClientId) : undefined;
    const existingOwnedSubmission = existingTurn?.clientSubmissionId ? submissions.find((candidate) => candidate.id === existingTurn.clientSubmissionId) : undefined;
    const matchedSubmission = providerMatchedSubmission ?? existingOwnedSubmission;
    const existingTerminal = existingTurn?.status === 'completed' || existingTurn?.status === 'interrupted' || existingTurn?.status === 'failed';
    const turn =
      existingTerminal && existingTurn
        ? existingTurn
        : options.turns.upsert({
            ...(existingTurn ? { id: existingTurn.id } : {}),
            conversationId: conversation.id,
            providerThreadId: threadId,
            providerTurnId,
            clientSubmissionId: existingTurn ? existingTurn.clientSubmissionId : (providerMatchedSubmission?.id ?? null),
            status: 'running',
            startedAt: existingTurn?.startedAt ?? timestamp,
            completedAt: null,
            createdAt: existingTurn?.createdAt ?? timestamp,
            updatedAt: event.receivedAt,
          });
    // 迟到的 started 事件不能把已经终态的轮次和会话重新激活。
    if (!existingTerminal) {
      if (matchedSubmission && (matchedSubmission.status === 'dispatching' || matchedSubmission.status === 'queued')) {
        options.submissions.updateStatus(matchedSubmission.id, 'active', { providerTurnId, dispatchedAt: timestamp });
      }
      const checkpoint = syncCheckpoints.getByConversation(conversation.id);
      if (checkpoint) {
        if (checkpoint.providerThreadId === threadId) {
          syncCheckpoints.advance({ conversationId: conversation.id, providerThreadId: threadId, lastSyncedTurnId: providerTurnId, timestamp: event.receivedAt });
        } else {
          // sealed 分段已在函数入口拦截；抵达这里的不同线程只能是刚提升的 current 分段。
          syncCheckpoints.rebind({ conversationId: conversation.id, providerThreadId: threadId, baselineTurnId: providerTurnId, timestamp: event.receivedAt });
        }
      } else {
        syncCheckpoints.initialize({ conversationId: conversation.id, providerThreadId: threadId, baselineTurnId: providerTurnId, timestamp: event.receivedAt });
      }
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: threadId, providerModel: conversation.providerModel, providerState: 'active' });
      runStates.set(conversation.id, { type: 'active', turnId: providerTurnId, phase: 'prework' });
      if (!existingTurn) {
        broadcast = {
          type: 'conversation.turn.started',
          payload: {
            conversationId: conversation.id,
            projectId: conversation.projectId,
            providerThreadId: threadId,
            providerTurnId,
            ...(turn.clientSubmissionId ? { submissionId: turn.clientSubmissionId } : {}),
            status: 'running',
            startedAt: turn.startedAt ?? timestamp,
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
  } else if (event.method === 'turn/diff/updated' && conversation && threadId && options.changeSets) {
    const providerTurnId = providerTurnIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (!providerTurnId || !turn || typeof params.diff !== 'string') return;
    options.changeSets.updateUnifiedDiff({
      conversation,
      turn,
      diff: params.diff,
      timestamp: event.receivedAt,
    });
  } else if (event.method === 'turn/completed' && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    if (!providerTurnId) return;
    const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
    if (!turn) return;
    await recoverExternallyResolvedRequestUserInputAnswers(conversation, providerTurnId);
    if (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed') return;
    const terminalStatus = providerTurnTerminalStatus(params);
    const interrupted = terminalStatus === 'interrupted';
    const failed = terminalStatus === 'failed';
    const timestamp = event.receivedAt;
    modelRequestTiming.clear(conversation.id, turn.id);
    sessionMetricsChanged = true;
    const failure = failed ? providerTurnFailure(params, providerTurnId) : null;
    const turnItems = options.providerItems.listByConversation(conversation.id).filter((item) => item.turnId === turn.id);
    const completedTurnItems = turnItems.filter((item) => item.status === 'completed');
    for (const streamedItem of turnItems.filter((item) => item.status === 'in_progress')) {
      const streamedText = streamedItem.textContent.trim();
      const supersedingItem =
        streamedText.length > 0
          ? completedTurnItems.find(
              (candidate) =>
                candidate.itemType === streamedItem.itemType &&
                candidate.phase === streamedItem.phase &&
                candidate.updatedAt > streamedItem.updatedAt &&
                candidate.textContent.trim().length > streamedText.length &&
                candidate.textContent.trim().startsWith(streamedText),
            )
          : undefined;
      const streamedPayload = parseJsonRecord(streamedItem.payloadJson);
      const streamedPresentation = isRecord(streamedPayload.presentation) ? streamedPayload.presentation : {};
      const reconciledItem = options.providerItems.upsertCompleted({
        conversationId: conversation.id,
        turnId: turn.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId: streamedItem.providerItemId,
        itemType: streamedItem.itemType,
        phase: streamedItem.phase,
        payload: supersedingItem
          ? {
              ...streamedPayload,
              presentation: {
                ...streamedPresentation,
                supersededBy: supersedingItem.providerItemId,
              },
            }
          : streamedPayload,
        textContent: supersedingItem ? '' : streamedItem.textContent,
        status: failed ? 'failed' : 'completed',
        startedAt: streamedItem.startedAt,
        completedAt: timestamp,
        updatedAt: timestamp,
      });
      projectProcessItem({
        conversationId: conversation.id,
        turnId: turn.id,
        threadId,
        providerItemId: reconciledItem.providerItemId,
        itemType: reconciledItem.itemType,
        status: reconciledItem.status === 'failed' ? 'failed' : 'completed',
        payload: parseJsonRecord(reconciledItem.payloadJson),
        text: reconciledItem.textContent,
        occurredAt: timestamp,
      });
      options.broadcast('conversation.item.updated', {
        conversationId: conversation.id,
        providerThreadId: threadId,
        providerTurnId,
        providerItemId: reconciledItem.providerItemId,
        itemType: reconciledItem.itemType,
        itemPayload: parseJsonRecord(reconciledItem.payloadJson),
        textContent: reconciledItem.textContent,
        status: reconciledItem.status,
        phase: reconciledItem.phase,
      });
    }
    const terminalTurn = options.turns.upsert({
      ...turn,
      status: terminalStatus,
      ...(failure ? { error: providerTurnFailureRecord(params, failure) } : {}),
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    options.changeSets?.seal({ conversation, turn, timestamp });
    const submissions = options.submissions.listByConversation(conversation.id);
    const internalContextCompaction = turn.clientSubmissionId === null && turnItems.some((item) => item.itemType === 'contextCompaction');
    const terminalReconciliation = internalContextCompaction
      ? { primarySubmission: undefined, recoveryRequired: [], reconciledCount: 0 }
      : reconcileTerminalTurnSubmissions(conversation, terminalTurn, timestamp, failure ? providerTurnFailureRecord(params, failure) : undefined);
    const activeSubmission = terminalReconciliation.primarySubmission;
    const recoveryRequiredSubmissions = terminalReconciliation.recoveryRequired;
    for (const submission of recoveryRequiredSubmissions) {
      options.broadcast('conversation.submission.steering', {
        conversationId: conversation.id,
        submissionId: submission.id,
        providerThreadId: threadId,
        providerTurnId,
      });
    }
    if (!internalContextCompaction && !failed && !interrupted) createdPlanImplementationRequest = ensurePlanImplementationRequest(conversation.id, turn, activeSubmission, timestamp);
    if (internalContextCompaction) {
      runStates.set(conversation.id, { type: 'idle' });
    } else if (failed) {
      for (const queued of submissions.filter((entry) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required' });
      runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
    } else if (recoveryRequiredSubmissions.length > 0) {
      runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
    } else if (interrupted) {
      const interruptedQueue = interruptedQueueSubmissions(submissions);
      for (const queued of interruptedQueue.filter((entry: ZeusConversationSubmissionRecord) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
      const hasInterruptedQueue = interruptedQueue.length > 0;
      runStates.set(conversation.id, hasInterruptedQueue ? { type: 'paused', reason: 'interrupted' } : { type: 'idle' });
    } else {
      runStates.set(conversation.id, { type: 'idle' });
    }
    const hasInterruptedQueue = interrupted && interruptedQueueSubmissions(submissions).length > 0;
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId: threadId,
      providerModel: conversation.providerModel,
      providerState: internalContextCompaction ? 'ready' : failed ? 'failed' : recoveryRequiredSubmissions.length > 0 || (interrupted && hasInterruptedQueue) ? 'paused' : 'ready',
    });
    const ephemeral = contexts.get(conversation.id)?.ephemeral === true;
    const conversationGoal = goals.get(conversation.id);
    if (!internalContextCompaction && !ephemeral && !conversationGoal) {
      options.conversations.markAttentionUnread(conversation.id, {
        kind: failed ? 'failed' : interrupted ? 'interrupted' : 'completed',
        turnId: providerTurnId,
        occurredAt: timestamp,
      });
    }
    const resultKey = `${conversation.id}:${providerTurnId}`;
    if (internalContextCompaction) {
      // 压缩轮次没有用户提交和回答等待者；只保留过程、usage 与终态，不制造普通回答结果。
    } else if (failure) {
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
      resolveTurnResult(result);
    }
    if (!internalContextCompaction && ephemeral) {
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
        completedAt: timestamp,
        ...(failure ? { error: projectConversationTurnFailure(providerTurnFailureRecord(params, failure)) } : {}),
        hasUnreadAttention: options.conversations.getById(conversation.id)?.attentionUnread === true,
        notificationEligible: !internalContextCompaction && !conversationGoal,
        ...(internalContextCompaction ? { internalOperation: 'context_compaction' } : {}),
      },
    };
    queueChangedAfterTurn = !internalContextCompaction && (interrupted || recoveryRequiredSubmissions.length > 0 || createdPlanImplementationRequest !== null);
    drainAfterTurn = !internalContextCompaction && !failed && !interrupted && recoveryRequiredSubmissions.length === 0 && conversationGoal?.status !== 'active';
  } else if (event.method === 'item/started' && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const itemPayload = isRecord(params.item) ? params.item : {};
    const providerItemId = providerItemIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (!providerTurnId || !providerItemId || !turn) return;
    const presentedItemPayload = sanitizeConversationItemPayload(itemPayload.type === 'userMessage' ? { ...itemPayload, ...submissionPresentation(conversation.id, turn, itemPayload) } : itemPayload);
    const itemType = itemTypeFromValue(itemPayload.type);
    if (itemType === 'contextCompaction') options.execution.markTurnModelRequestsAsContextCompaction(conversation.id, turn.id);
    // 兼容 app-server 不发送 rawResponseItem/completed 的版本：模型一旦产出工具、命令、
    // 文件变更等非文本项，本次请求即不能用总输出 Token 计算纯文本生成速率。
    if (isNonTextModelRequestOutput(itemType)) modelRequestTiming.observe(conversation.id, turn.id, event.receivedAt, 'non_text');
    const userMessageProjection = itemType === 'userMessage' ? projectProviderUserMessage(conversation, turn, presentedItemPayload, itemText(itemPayload), providerItemId) : null;
    if (itemType === 'userMessage' && !userMessageProjection) return;
    const item = userMessageProjection
      ? options.providerItems.upsertProgress({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType,
          phase: phaseFromItem(itemPayload),
          payload: presentedItemPayload,
          textContent: userMessageProjection.content,
          startedAt: event.receivedAt,
          updatedAt: event.receivedAt,
        })
      : options.providerItems.appendDelta({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId: threadId,
          providerTurnId,
          providerItemId,
          itemType,
          phase: phaseFromItem(itemPayload),
          payload: presentedItemPayload,
          delta: '',
          startedAt: event.receivedAt,
          updatedAt: event.receivedAt,
        });
    if (item.itemType === 'fileChange') {
      options.changeSets?.capture({
        conversation,
        turn,
        providerItemId,
        changes: itemPayload.changes,
        phase: 'pre',
        timestamp: event.receivedAt,
      });
      broadcastLinkedFileApprovalChanges(providerItemId, providerTurnId);
    }
    projectProcessItem({
      conversationId: conversation.id,
      turnId: turn.id,
      threadId,
      providerItemId,
      itemType: item.itemType,
      status: 'in_progress',
      payload: presentedItemPayload,
      text: item.textContent,
      occurredAt: event.receivedAt,
    });
    const durableClientMessageId =
      item.itemType === 'userMessage' && userMessageProjection ? persistProviderUserMessage(conversation, presentedItemPayload, userMessageProjection, providerTurnId, threadId, providerItemId, event.receivedAt) : null;
    const itemResources = syncItemResources(conversation, turn, item, presentedItemPayload, item.textContent, event.receivedAt);
    broadcast = {
      type: 'conversation.item.started',
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
        itemResources,
      },
    };
  } else if (event.method === 'item/fileChange/patchUpdated' && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const providerItemId = providerItemIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (!providerTurnId || !providerItemId || !turn || !Array.isArray(params.changes)) return;
    const existing = options.providerItems.getByProvider(threadId, providerItemId);
    const item = options.providerItems.appendDelta({
      conversationId: conversation.id,
      turnId: turn.id,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId,
      itemType: 'fileChange',
      phase: 'prework',
      payload: { ...(existing ? parseJsonRecord(existing.payloadJson) : {}), ...params, changes: params.changes },
      delta: '',
      startedAt: existing?.startedAt ?? event.receivedAt,
      updatedAt: event.receivedAt,
    });
    options.changeSets?.capture({
      conversation,
      turn,
      providerItemId,
      changes: params.changes,
      phase: 'pre',
      timestamp: event.receivedAt,
    });
    broadcastLinkedFileApprovalChanges(providerItemId, providerTurnId);
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
  } else if ((event.method === 'item/reasoning/summaryTextDelta' || event.method === 'item/reasoning/summaryPartAdded') && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const providerItemId = providerItemIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    const summaryIndex = integerValue(params.summaryIndex);
    if (!providerTurnId || !providerItemId || !turn || summaryIndex === null || (event.method === 'item/reasoning/summaryTextDelta' && typeof params.delta !== 'string')) return;
    if (event.method === 'item/reasoning/summaryTextDelta' && typeof params.delta === 'string' && params.delta.trim()) {
      modelRequestTiming.observe(conversation.id, turn.id, firstVisibleReceiptAt(receiptEvents, event.receivedAt), 'visible_non_text');
    }
    const existing = options.providerItems.getByProvider(threadId, providerItemId);
    const projection = reasoningSummaryProjection(existing, params, summaryIndex);
    const item = options.providerItems.upsertProgress({
      conversationId: conversation.id,
      turnId: turn.id,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId,
      itemType: 'reasoning',
      phase: 'prework',
      payload: projection.payload,
      textContent: projection.textContent,
      startedAt: existing?.startedAt ?? event.receivedAt,
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
  } else if (event.method === 'item/commandExecution/outputDelta' && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const providerItemId = providerItemIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (!providerTurnId || !providerItemId || !turn || typeof params.delta !== 'string') return;
    const existing = options.providerItems.getByProvider(threadId, providerItemId);
    const projection = liveProgressProjection(existing, 'command_output', params.delta, true);
    const item = options.providerItems.upsertProgress({
      conversationId: conversation.id,
      turnId: turn.id,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId,
      itemType: 'commandExecution',
      phase: 'prework',
      payload: projection.payload,
      textContent: existing?.textContent ?? '',
      startedAt: existing?.startedAt ?? event.receivedAt,
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
  } else if (event.method === 'item/mcpToolCall/progress' && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const providerItemId = providerItemIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (!providerTurnId || !providerItemId || !turn || typeof params.message !== 'string') return;
    const existing = options.providerItems.getByProvider(threadId, providerItemId);
    const projection = liveProgressProjection(existing, 'tool_progress', params.message, false);
    const item = options.providerItems.upsertProgress({
      conversationId: conversation.id,
      turnId: turn.id,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId,
      itemType: 'mcpToolCall',
      phase: 'prework',
      payload: projection.payload,
      textContent: existing?.textContent ?? '',
      startedAt: existing?.startedAt ?? event.receivedAt,
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
  } else if (isCodexReadableItemTextDeltaEvent(event.method) && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const providerItemId = providerItemIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    if (!providerTurnId || !providerItemId || !turn || typeof params.delta !== 'string') return;
    if (params.delta.trim()) modelRequestTiming.observe(conversation.id, turn.id, firstVisibleReceiptAt(receiptEvents, event.receivedAt), 'visible_text');
    const item = options.providerItems.appendDelta({
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
    // 目标存在期间，普通中间回复只更新会话进度；关注状态只由目标关键终态统一产生。
    if (event.method === 'item/agentMessage/delta' && params.delta.trim() && !goals.get(conversation.id)) {
      const previousRevision = options.conversations.getById(conversation.id)?.attentionRevision ?? 0;
      const attention = options.conversations.markAttentionUnread(conversation.id, {
        kind: 'unread',
        turnId: providerTurnId,
        occurredAt: event.receivedAt,
      });
      if (attention.attentionRevision !== previousRevision) {
        options.broadcast('conversation.attention.changed', {
          conversationId: conversation.id,
          providerThreadId: threadId,
          providerTurnId,
          attentionKind: attention.attentionKind,
          attentionRevision: attention.attentionRevision,
        });
      }
    }
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
    const presentedItemPayload = sanitizeConversationItemPayload(itemPayload.type === 'userMessage' ? { ...itemPayload, ...submissionPresentation(conversation.id, turn, itemPayload) } : itemPayload);
    const itemType = itemTypeFromValue(itemPayload.type);
    if (itemType === 'contextCompaction') options.execution.markTurnModelRequestsAsContextCompaction(conversation.id, turn.id);
    const existing = options.providerItems.getByProvider(threadId, providerItemId);
    const userMessageProjection = itemType === 'userMessage' ? projectProviderUserMessage(conversation, turn, presentedItemPayload, itemText(itemPayload), providerItemId) : null;
    if (itemType === 'userMessage' && !userMessageProjection) return;
    const completedProjection = userMessageProjection
      ? { ...completedItemProjection(existing, presentedItemPayload, itemType), textContent: userMessageProjection.content }
      : completedItemProjection(existing, presentedItemPayload, itemType);
    const item = options.providerItems.upsertCompleted({
      conversationId: conversation.id,
      turnId: turn.id,
      providerThreadId: threadId,
      providerTurnId,
      providerItemId,
      itemType,
      phase: phaseFromItem(itemPayload),
      payload: completedProjection.payload,
      textContent: completedProjection.textContent,
      status: itemPayload.status === 'failed' ? 'failed' : 'completed',
      startedAt: typeof itemPayload.startedAt === 'string' ? itemPayload.startedAt : null,
      completedAt: event.receivedAt,
      updatedAt: event.receivedAt,
    });
    projectProcessItem({
      conversationId: conversation.id,
      turnId: turn.id,
      threadId,
      providerItemId,
      itemType: item.itemType,
      status: item.status === 'failed' ? 'failed' : 'completed',
      payload: completedProjection.payload,
      text: item.textContent,
      occurredAt: event.receivedAt,
    });
    if (isToolResultItem(item.itemType)) sessionMetricsChanged = true;
    const executionSegment = options.execution.segmentByNativeSession(threadId, conversation.id);
    if (executionSegment && executionSegment.state !== 'sealed') {
      if (item.itemType === 'agentMessage') {
        options.execution.appendModelHistory({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: executionSegment.id,
          role: 'assistant',
          content: { text: item.textContent },
          submissionId: turn.clientSubmissionId,
          confirmedAt: event.receivedAt,
        });
      } else if (item.itemType === 'reasoning' && item.textContent.trim()) {
        options.execution.appendModelHistory({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: executionSegment.id,
          role: 'assistant',
          content: { text: item.textContent, provenance: 'Codex 可读思考摘要' },
          submissionId: turn.clientSubmissionId,
          reasoningSource: { provider: 'codex', itemId: providerItemId, readableSummary: true },
          confirmedAt: event.receivedAt,
        });
      } else if (item.itemType === 'plan' && item.textContent.trim()) {
        if (!turn.planJson) options.turns.updatePlan(turn.id, { explanation: item.textContent.trim(), steps: [] }, event.receivedAt);
        if (!options.execution.modelHistoryByProviderItem(conversation.id, providerItemId, 'plan')) {
          options.execution.appendModelHistory({
            conversationId: conversation.id,
            turnId: turn.id,
            segmentId: executionSegment.id,
            role: 'assistant',
            content: { type: 'plan', text: item.textContent },
            submissionId: turn.clientSubmissionId,
            reasoningSource: { provider: 'codex', itemId: providerItemId, itemType: 'plan', readableSummary: false },
            confirmedAt: event.receivedAt,
          });
        }
      } else if (isToolResultItem(item.itemType)) {
        const rawText = item.textContent || JSON.stringify(completedProjection.payload);
        const toolKind = item.itemType === 'commandExecution' ? 'command' : /search/i.test(item.itemType) ? 'search' : 'other';
        const stored = await options.toolResults.store({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: executionSegment.id,
          toolPairId: providerItemId,
          toolKind,
          text: rawText,
          createdAt: event.receivedAt,
        });
        options.execution.appendModelHistory({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: executionSegment.id,
          role: 'assistant',
          content: { type: 'tool_call', itemType: item.itemType, payload: completedProjection.payload },
          submissionId: turn.clientSubmissionId,
          toolPairId: providerItemId,
          confirmedAt: event.receivedAt,
        });
        options.execution.appendModelHistory({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: executionSegment.id,
          role: 'tool',
          content: { projection: stored.projection, handle: stored.record.handle, sha256: stored.record.sha256, byteLength: stored.record.byteLength },
          submissionId: turn.clientSubmissionId,
          toolPairId: providerItemId,
          confirmedAt: event.receivedAt,
        });
      }
    }
    let durableClientMessageId: string | null = null;
    if (item.itemType === 'userMessage' && userMessageProjection) {
      durableClientMessageId = persistProviderUserMessage(conversation, presentedItemPayload, userMessageProjection, providerTurnId, threadId, providerItemId, event.receivedAt);
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
      if (item.textContent.trim() && !goals.get(conversation.id)) {
        const previousRevision = options.conversations.getById(conversation.id)?.attentionRevision ?? 0;
        const attention = options.conversations.markAttentionUnread(conversation.id, {
          kind: 'unread',
          turnId: providerTurnId,
          occurredAt: event.receivedAt,
        });
        if (attention.attentionRevision !== previousRevision) {
          options.broadcast('conversation.attention.changed', {
            conversationId: conversation.id,
            providerThreadId: threadId,
            providerTurnId,
            attentionKind: attention.attentionKind,
            attentionRevision: attention.attentionRevision,
          });
        }
      }
    }
    if (item.itemType === 'fileChange') {
      options.changeSets?.capture({
        conversation,
        turn,
        providerItemId,
        changes: itemPayload.changes,
        phase: 'post',
        timestamp: event.receivedAt,
      });
      broadcastLinkedFileApprovalChanges(providerItemId, providerTurnId);
    }
    if (item.phase === 'final_answer') runStates.set(conversation.id, { type: 'active', turnId: providerTurnId, phase: 'final_answer' });
    const itemResources = syncItemResources(conversation, turn, item, presentedItemPayload, item.textContent, event.receivedAt);
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
        itemResources,
      },
    };
  } else if (event.method === 'thread/settings/updated' && conversation) {
    const settings = isRecord(params.threadSettings) ? params.threadSettings : params;
    const snapshot = {
      generationId: event.generationId,
      sequence: event.sequence,
      model: requireString(settings.model, 'provider settings model'),
      ...(typeof settings.effort === 'string' ? { effort: settings.effort } : {}),
      ...(Object.prototype.hasOwnProperty.call(settings, 'serviceTier') && (settings.serviceTier === null || typeof settings.serviceTier === 'string') ? { serviceTier: settings.serviceTier } : {}),
    };
    options.conversations.upsertProviderSettingsSnapshot(conversation.id, snapshot);
    if (Object.prototype.hasOwnProperty.call(snapshot, 'serviceTier')) {
      const state = runStates.get(conversation.id);
      const providerTurnId = state?.type === 'active' || state?.type === 'waiting' ? state.turnId : null;
      const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
      const submission = turn?.clientSubmissionId ? options.submissions.getById(turn.clientSubmissionId) : undefined;
      if (submission) persistProviderReportedServiceTierDowngrade(conversation.id, submission, contextFromSubmission(submission), snapshot.serviceTier ?? null);
    }
    broadcast = { type: 'conversation.provider.settings.updated', payload: { conversationId: conversation.id, ...snapshot } };
  } else if (event.method === 'rawResponseItem/completed' && conversation && threadId) {
    const providerTurnId = providerTurnIdFrom(params);
    const turn = providerTurnId ? options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId) : undefined;
    const item = isRecord(params.item) ? params.item : null;
    if (turn && item && item.type !== 'message' && item.type !== 'reasoning') {
      modelRequestTiming.observe(conversation.id, turn.id, event.receivedAt, 'non_text');
    }
  } else if (event.method === 'rawResponse/completed' && conversation && threadId) {
    const providerTurnId = requireString(providerTurnIdFrom(params), 'provider turn id');
    const providerRequestId = requireString(params.responseId, 'provider response id');
    const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
    const segment = options.execution.segmentByNativeSession(threadId, conversation.id);
    if (!turn || !segment) return;
    const submission = turn.clientSubmissionId ? options.submissions.getById(turn.clientSubmissionId) : undefined;
    let context: ConversationDispatchContext | null = null;
    if (submission) {
      try {
        context = contextFromSubmission(submission);
      } catch {
        context = null;
      }
    }
    const settings = options.conversations.getProviderSettingsSnapshot(conversation.id);
    const model = context?.model ?? settings?.model ?? conversation.providerModel;
    if (!model) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Raw response event cannot resolve its model.');
    const usage = isRecord(params.usage) ? tokenUsageBreakdown(params.usage) : null;
    const timing = modelRequestTiming.complete(conversation.id, turn.id);
    const completedAt = event.receivedAt;
    const measurementComplete = usage !== null && timing.firstTextOutputAt !== null && Date.parse(completedAt) > Date.parse(timing.firstTextOutputAt) && !timing.hasNonTextOutput;
    const recordedRequests = options.execution.listModelRequestsForTurn(conversation.id, turn.id);
    const matchingFallback = usage
      ? [...recordedRequests]
          .reverse()
          .find(
            (request) =>
              request.providerRequestId === null &&
              request.inputTokens === usage.inputTokens &&
              request.cachedInputTokens === usage.cachedInputTokens &&
              request.cacheWriteInputTokens === usage.cacheWriteInputTokens &&
              request.outputTokens === usage.outputTokens &&
              request.reasoningOutputTokens === usage.reasoningOutputTokens &&
              request.totalTokens === usage.totalTokens,
          )
      : undefined;
    if (matchingFallback) {
      options.execution.attachModelRequestMeasurement(matchingFallback.id, {
        providerRequestId,
        firstVisibleOutputAt: timing.firstVisibleOutputAt,
        firstTextOutputAt: timing.firstTextOutputAt,
        completedAt,
        measurementComplete,
      });
    } else {
      const exactRequestCount = recordedRequests.filter((request) => request.providerRequestId !== null).length;
      options.execution.observeModelRequest({
        conversationId: conversation.id,
        turnId: turn.id,
        segmentId: segment.id,
        requestKind: exactRequestCount === 0 ? 'inference' : 'tool_continuation',
        observationIdentity: `codex-response:${threadId}:${providerRequestId}`,
        modelId: model,
        contextWindow: null,
        inputTokens: usage?.inputTokens ?? null,
        cachedInputTokens: usage?.cachedInputTokens ?? null,
        cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        reasoningOutputTokens: usage?.reasoningOutputTokens ?? null,
        totalTokens: usage?.totalTokens ?? null,
        estimatedUsd: null,
        usageComplete: usage !== null,
        providerRequestId,
        firstVisibleOutputAt: timing.firstVisibleOutputAt,
        firstTextOutputAt: timing.firstTextOutputAt,
        completedAt,
        measurementComplete,
        occurredAt: completedAt,
      });
    }
    sessionMetricsChanged = true;
  } else if (event.method === 'thread/tokenUsage/updated' && conversation) {
    const tokenUsage = isRecord(params.tokenUsage) ? params.tokenUsage : params;
    const total = tokenUsageBreakdown(isRecord(tokenUsage.total) ? tokenUsage.total : tokenUsage);
    const last = tokenUsageBreakdown(isRecord(tokenUsage.last) ? tokenUsage.last : tokenUsage);
    const providerTurnId = requireString(providerTurnIdFrom(params), 'provider turn id');
    const turn = options.turns.listByConversation(conversation.id).find((candidate) => candidate.providerTurnId === providerTurnId);
    const submission = turn?.clientSubmissionId ? options.submissions.getById(turn.clientSubmissionId) : undefined;
    let context: ConversationDispatchContext | null = null;
    if (submission) {
      try {
        context = contextFromSubmission(submission);
      } catch {
        context = null;
      }
    }
    const settings = options.conversations.getProviderSettingsSnapshot(conversation.id);
    const eventServiceTier = Object.prototype.hasOwnProperty.call(tokenUsage, 'serviceTier') && (tokenUsage.serviceTier === null || typeof tokenUsage.serviceTier === 'string') ? tokenUsage.serviceTier : undefined;
    const actualServiceTier = eventServiceTier !== undefined ? eventServiceTier : settings && Object.prototype.hasOwnProperty.call(settings, 'serviceTier') ? (settings.serviceTier ?? null) : (context?.serviceTier ?? null);
    const model = context?.model ?? settings?.model ?? conversation.providerModel;
    if (!model) throw coordinatorError('ZEUS_NATIVE_PROVIDER_EVENT_INVALID', 'Token usage event cannot resolve its model.');
    const modelContextWindow = tokenUsage.modelContextWindow === null || tokenUsage.modelContextWindow === undefined ? null : requireNumber(tokenUsage.modelContextWindow, 'modelContextWindow');
    const snapshot: NativeTokenUsageSnapshot = options.usage
      ? await options.usage.recordTurn({
          generationId: event.generationId,
          sequence: event.sequence,
          projectId: conversation.projectId,
          conversationId: conversation.id,
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerTurnId,
          model,
          modelSourceId: context?.modelSourceId ?? conversation.modelSourceId,
          serviceTier: actualServiceTier,
          total,
          last,
          modelContextWindow,
          occurredAt: turn?.completedAt ?? event.receivedAt,
        })
      : {
          generationId: event.generationId,
          sequence: event.sequence,
          serviceTier: actualServiceTier,
          total,
          last,
          modelContextWindow,
          cacheHitRate: calculateCacheHitRate(total),
          estimatedCredits: null,
          apiEquivalentUsd: null,
          lastApiEquivalentUsd: null,
          cacheSavingsUsd: null,
          priceCoverage: null,
          pricingCatalogDate: null,
          pricingSourceUrls: [],
          historyComplete: false,
        };
    options.conversations.upsertProviderTokenUsageSnapshot(conversation.id, snapshot);
    const segment = threadId ? options.execution.segmentByNativeSession(threadId, conversation.id) : undefined;
    if (segment && turn) {
      const recordedRequests = options.execution.listModelRequestsForTurn(conversation.id, turn.id);
      const latestRecordedRequest = recordedRequests.at(-1);
      const contextCompactionTurn = options.providerItems.listByConversation(conversation.id).some((item) => item.turnId === turn.id && item.itemType === 'contextCompaction');
      const exactRequest =
        latestRecordedRequest &&
        latestRecordedRequest.providerRequestId !== null &&
        latestRecordedRequest.inputTokens === last.inputTokens &&
        latestRecordedRequest.cachedInputTokens === last.cachedInputTokens &&
        latestRecordedRequest.cacheWriteInputTokens === last.cacheWriteInputTokens &&
        latestRecordedRequest.outputTokens === last.outputTokens &&
        latestRecordedRequest.reasoningOutputTokens === last.reasoningOutputTokens &&
        latestRecordedRequest.totalTokens === last.totalTokens
          ? latestRecordedRequest
          : undefined;
      // app-server 的兼容 token_count 事件通常不带 requestKind；同轮首个请求是推理，
      // 后续请求只会在工具结果续跑后出现。显式 retry/compaction 标记仍优先。
      const requestKind =
        tokenUsage.requestKind === 'context_compaction' || contextCompactionTurn
          ? 'context_compaction'
          : tokenUsage.requestKind === 'retry'
            ? 'retry'
            : tokenUsage.requestKind === 'tool_continuation' || recordedRequests.length > 0
              ? 'tool_continuation'
              : 'inference';
      if (exactRequest) {
        options.execution.enrichModelRequest(exactRequest.id, { contextWindow: modelContextWindow, estimatedUsd: snapshot.lastApiEquivalentUsd });
      } else {
        // 当前 Codex app-server 的兼容协议会在每个模型请求及其工具输出完成后发送
        // tokenUsage/updated，但不发送 rawResponse/completed。只有本段没有非文本输出时，
        // 该事件才同时构成可信的纯文本请求完成边界。
        const timing = modelRequestTiming.complete(conversation.id, turn.id);
        const completedAt = event.receivedAt;
        const measurementComplete = timing.firstTextOutputAt !== null && Date.parse(completedAt) > Date.parse(timing.firstTextOutputAt) && !timing.hasNonTextOutput;
        options.execution.observeModelRequest({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: segment.id,
          requestKind,
          // 老版本 app-server 没有 rawResponse 事件时仍保留精确用量，但不伪造请求时序。
          observationIdentity: `codex:${providerTurnId}:${JSON.stringify([last.inputTokens, last.cachedInputTokens, last.cacheWriteInputTokens, last.outputTokens, last.reasoningOutputTokens, last.totalTokens, modelContextWindow])}`,
          modelId: model,
          contextWindow: modelContextWindow,
          inputTokens: last.inputTokens,
          cachedInputTokens: last.cachedInputTokens,
          cacheWriteInputTokens: last.cacheWriteInputTokens,
          outputTokens: last.outputTokens,
          reasoningOutputTokens: last.reasoningOutputTokens,
          totalTokens: last.totalTokens,
          estimatedUsd: snapshot.lastApiEquivalentUsd,
          usageComplete: true,
          providerRequestId: null,
          firstVisibleOutputAt: timing.firstVisibleOutputAt,
          firstTextOutputAt: timing.firstTextOutputAt,
          completedAt,
          measurementComplete,
          occurredAt: turn.completedAt ?? event.receivedAt,
        });
      }
    }
    sessionMetricsChanged = true;
    broadcast = { type: 'conversation.provider.token_usage.updated', payload: { conversationId: conversation.id, ...snapshot } };
  } else if (event.method === 'account/rateLimits/updated') {
    // 官方协议明确这是稀疏更新；只把它当作重读信号，不用不完整包覆盖快照。
    options.usage?.handleSparseRateLimitUpdate();
  } else if (event.method === 'account/updated') {
    options.usage?.handleAccountChanged();
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
        ...(typeof params.itemId === 'string' && params.itemId.trim() ? { itemId: params.itemId } : {}),
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
        const recoveryError = await failInvalidInteractionAuthority({
          conversation,
          threadId,
          providerTurnId,
          turn,
          request,
          error: {
            error: 'ZEUS_CODEX_REQUEST_USER_INPUT_ENVELOPE_INVALID',
            message: canonicalRui.message,
            recoveryRequired: false,
            generationId: event.generationId,
            providerRequestId: event.requestId,
          },
          timestamp: event.receivedAt,
        });
        broadcast = { type: 'conversation.native.error', payload: { conversationId: conversation.id, providerThreadId: threadId, providerTurnId, ...recoveryError } };
      } else if (!options.manager.hasGeneration(event.generationId)) {
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
        if (replay && providerTurnId) {
          await executeTurnCommand({
            operation: 'server_request_response',
            conversationId: conversation.id,
            threadId,
            turnId: providerTurnId,
            commandKey: `server-request-replay:${request.id}:${event.generationId}:${event.sequence}`,
            requestIdentity: replay,
            issuedAt: event.receivedAt,
            providerGenerationId: event.generationId,
            invoke: (traceIdentity: string) => options.manager.respondToServerRequest({ ...replay, traceIdentity }),
          });
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
              const providerThreadId = conversation.providerThreadId;
              await executeTurnCommand({
                operation: 'turn_interrupt',
                conversationId: conversation.id,
                threadId: providerThreadId,
                turnId: providerTurnId,
                commandKey: `turn-interrupt:${providerTurnId}`,
                requestIdentity: { threadId: providerThreadId, turnId: providerTurnId },
                issuedAt: event.receivedAt,
                providerGenerationId: event.generationId,
                invoke: (traceIdentity: string) => options.manager.interruptTurn({ threadId: providerThreadId, turnId: providerTurnId, traceIdentity }),
              });
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
        const sessionFileEditGrantApplies =
          requestKind === 'file' &&
          options.conversations.hasSessionFileEditGrant(conversation.id) &&
          hasAuditableFileApprovalTarget(params, conversation, contexts.get(conversation.id) ?? contextFromConversation(conversation), options.providerItems);
        let automaticallyApproved = false;
        if (sessionFileEditGrantApplies) {
          try {
            await respondToRequest({ requestId: request.id, response: { type: 'file', decision: 'accept' } });
            automaticallyApproved = true;
          } catch {
            // Provider 拒绝自动答复时保留真实待授权弹窗，禁止伪造已允许状态。
          }
        }
        if (!automaticallyApproved && !goals.get(conversation.id)) {
          options.conversations.markAttentionUnread(conversation.id, {
            kind: 'unread',
            turnId: providerTurnId,
            occurredAt: event.receivedAt,
          });
        }
        if (!automaticallyApproved && providerTurnId && turn) {
          options.turns.upsert({ ...turn, status: 'waiting', updatedAt: event.receivedAt });
          const pausedSubmission = options.submissions
            .listByConversation(conversation.id)
            .find(
              (candidate) =>
                candidate.providerTurnId === providerTurnId &&
                candidate.status === 'paused' &&
                candidate.pausedReason === 'recovery_required' &&
                parseJsonRecord(candidate.errorJson ?? '{}').code === 'ZEUS_PROVIDER_INTERACTION_AUTHORITY_MISSING',
            );
          if (pausedSubmission) options.submissions.updateStatus(pausedSubmission.id, 'active', { providerTurnId, updatedAt: event.receivedAt });
          options.execution.resolveWarning(conversation.id, 'provider_interaction_authority_missing', event.receivedAt);
          options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: threadId,
            providerModel: conversation.providerModel,
            providerState: 'waiting',
          });
          runStates.set(conversation.id, { type: 'waiting', turnId: providerTurnId, requestId: request.id, reason: requestKind === 'request_user_input' ? 'user_input' : 'approval' });
        }
        if (!automaticallyApproved) {
          broadcast = {
            type: 'conversation.request.created',
            payload: {
              conversationId: conversation.id,
              requestId: request.id,
              requestKind,
              providerTurnId,
              request: nativePendingRequestProjection(request, {
                conversation,
                projectRoot: (contexts.get(conversation.id) ?? contextFromConversation(conversation)).projectLocalPath,
                providerItems: options.providerItems,
              }),
              notificationEligible: !goals.get(conversation.id),
            },
          };
          scheduleAutoResolution(request);
        }
      }
    }
  }

  for (const receiptEvent of receiptEvents) {
    const receiptIdentity = codexProviderEventIdentity(receiptEvent);
    receipts.record(providerEventReceipt(receiptEvent, receiptIdentity));
    maintainProviderReceiptGenerations(receiptEvent.generationId);
    rememberProcessedProviderEvent(receiptEvent, receiptIdentity);
  }
  if (requiresImmediatePersist(event, createdPlanImplementationRequest)) {
    markScheduledPersistDirty();
    await flushScheduledPersist();
  } else {
    schedulePersist();
  }
  // Plan 终态会把会话从 active 收敛为 idle。先发布耐久的计划确认请求，
  // 避免 Renderer 收到 turn completed 后释放实时连接，错过随后才到的确认动作。
  if (createdPlanImplementationRequest) {
    const formalPlanItem = options.providerItems.getById(createdPlanImplementationRequest.planItemId);
    options.broadcast('conversation.plan_implementation_request.changed', {
      conversationId: createdPlanImplementationRequest.conversationId,
      requestId: createdPlanImplementationRequest.id,
      status: createdPlanImplementationRequest.status,
      turnId: createdPlanImplementationRequest.turnId,
      planItemId: createdPlanImplementationRequest.planItemId,
      ...(formalPlanItem?.providerItemId ? { providerPlanItemId: formalPlanItem.providerItemId } : {}),
    });
  }
  if (broadcast) {
    options.broadcast(broadcast.type, {
      ...broadcast.payload,
      generationId: event.generationId,
      sequence: event.sequence,
    });
  }
  if (sessionMetricsChanged && conversation) {
    options.broadcast('conversation.sessionMetrics.changed', {
      conversationId: conversation.id,
      generationId: event.generationId,
      sequence: event.sequence,
    });
  }
  if (queueChangedAfterTurn && conversation) {
    options.broadcast('conversation.queue.changed', {
      conversationId: conversation.id,
      providerThreadId: conversation.providerThreadId,
    });
  }
  if (drainAfterTurn && conversation) await drainQueuedSubmissions();
}

function firstVisibleReceiptAt(events: readonly CodexAppServerEvent[], fallback: string): string {
  return events.find((event) => isRecord(event.params) && typeof event.params.delta === 'string' && event.params.delta.trim())?.receivedAt ?? fallback;
}

function isNonTextModelRequestOutput(itemType: ReturnType<typeof itemTypeFromValue>): boolean {
  return itemType !== 'userMessage' && itemType !== 'agentMessage' && itemType !== 'reasoning';
}
