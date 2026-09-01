import type {CodexThreadSnapshot, CodexTurnSnapshot} from '@zeus/ai-runtime';
import type {ConversationResource} from '@zeus/shared';
import {
    type ConversationTurnStatus,
    projectConversationTurnFailure,
    resolveSnapshotProviderItemId,
    type ZeusConversationItemRecord,
    type ZeusConversationSubmissionRecord,
    type ZeusConversationTurnRecord,
    type ZeusConversationWithMessagesRecord,
} from '@zeus/storage';
import type {
    CreateCodexNativeConversationCoordinatorOptions,
    NativeConversationRunState,
    NativeTurnResult,
    NativeTurnResultWaiter
} from './codexNativeConversationContracts.js';
import {
    classifySnapshotTurn,
    completedItemProjection,
    coordinatorError,
    findSnapshotTurn,
    isRecord,
    isRejectedHistoricalFileChangeError,
    itemText,
    itemTypeFromValue,
    parseJsonRecord,
    phaseFromItem,
    providerTimestamp,
    providerTurnFailure,
    providerTurnFailureRecord,
    providerTurnUserClientId,
    requireString,
    snapshotConfirmsIdleProviderThread,
    snapshotConfirmsSafeResumeBoundary,
} from './codexNativeConversationPolicy.js';
import {appendProviderSyncAudit, type ProviderSyncAuditOutcome} from './providerSyncAudit.js';
import {sanitizeConversationItemPayload} from './conversationResources.js';
import {shouldPreserveProviderStopTerminalTurn} from './codexProviderStopRecoveryApplication.js';
import {inspectCodexRolloutRequestUserInputEvidence} from './codexRolloutRequestUserInput.js';
import {interruptedQueueSubmissions} from './codexNativeRunStateProjection.js';
import {threadPath} from './codexThreadMetadataProjection.js';
import type {NativeUserMessageProjection} from './codexNativeUserMessageProjection.js';
import type {TurnProcessProjector} from './turnProcessProjector.js';

const compatibilitySnapshotItemIdPattern = /^item-\d+$/u;
const providerHistoryReconcilePageLimit = 20;
const providerHistoryReconcileTurnLimit = 2_000;

function isCompatibilitySnapshotItem(item: Pick<ZeusConversationItemRecord, 'providerItemId' | 'nativeItemId'>): boolean {
  return compatibilitySnapshotItemIdPattern.test(item.nativeItemId ?? item.providerItemId);
}

function compatibilitySnapshotItemIdentity(item: Pick<ZeusConversationItemRecord, 'providerThreadId' | 'providerTurnId' | 'itemType' | 'status' | 'phase' | 'textContent'>): string {
  return JSON.stringify([item.providerThreadId, item.providerTurnId, item.itemType, item.status, item.phase]);
}

function isInteractionAuthorityMissingTurn(turn: ZeusConversationTurnRecord | undefined): boolean {
  return Boolean(turn && parseJsonRecord(turn.errorJson ?? '{}').code === 'ZEUS_PROVIDER_INTERACTION_AUTHORITY_MISSING');
}

function claimCompatibilitySnapshotSourceItems(
  target: Pick<ZeusConversationItemRecord, 'providerThreadId' | 'providerTurnId' | 'itemType' | 'status' | 'phase' | 'textContent'>,
  candidates: readonly ZeusConversationItemRecord[],
  claimedItemIds: Set<string>,
): ZeusConversationItemRecord[] {
  const scoped = candidates.filter((candidate) => !isCompatibilitySnapshotItem(candidate) && !claimedItemIds.has(candidate.id) && compatibilitySnapshotItemIdentity(candidate) === compatibilitySnapshotItemIdentity(target));
  const maximumSegmentCount = target.itemType === 'reasoning' ? scoped.length : Math.min(scoped.length, 1);
  for (let start = 0; start < scoped.length; start += 1) {
    const matched: ZeusConversationItemRecord[] = [];
    let combinedText = '';
    for (let index = start; index < scoped.length && matched.length < maximumSegmentCount; index += 1) {
      const candidate = scoped[index]!;
      matched.push(candidate);
      combinedText = combinedText ? `${combinedText}\n\n${candidate.textContent}` : candidate.textContent;
      if (combinedText === target.textContent) return matched;
      if (!target.textContent.startsWith(combinedText)) break;
    }
  }
  return [];
}

/** 抑制 Provider 恢复旧 JSONL 时生成、且有真实身份条目可对应的 `item-N` 兼容别名。 */
export function filterCompatibilitySnapshotItemAliases(items: readonly ZeusConversationItemRecord[]): {
  items: ZeusConversationItemRecord[];
  suppressedProviderItemIds: Set<string>;
} {
  const claimedItemIds = new Set<string>();
  const suppressedProviderItemIds = new Set<string>();
  const projectedItems = items.filter((item) => {
    if (!isCompatibilitySnapshotItem(item)) return true;
    const sourceItems = claimCompatibilitySnapshotSourceItems(item, items, claimedItemIds);
    if (sourceItems.length === 0) return true;
    for (const sourceItem of sourceItems) claimedItemIds.add(sourceItem.id);
    suppressedProviderItemIds.add(item.providerItemId);
    return false;
  });
  return { items: projectedItems, suppressedProviderItemIds };
}

export interface CodexProviderHistoryProjectionDependencies {
  options: CreateCodexNativeConversationCoordinatorOptions;
    failedTurnResults: Map<string, Error & { code: string }>;
    processProjector: TurnProcessProjector;
    runStates: Map<string, NativeConversationRunState>;
    turnResultWaiters: Map<string, NativeTurnResultWaiter[]>;
  now(): string;

    hasExactProviderUserMessage(conversation: ZeusConversationWithMessagesRecord, submission: ZeusConversationSubmissionRecord, providerTurnId: string): boolean;

    isSteeringSubmission(submission: ZeusConversationSubmissionRecord): boolean;

    markConversationRecoveryRequired(conversationId: string, error: unknown): boolean;

    markSubmissionRecoveryRequired(submission: ZeusConversationSubmissionRecord, error: unknown): void;

    failUnsentSubmissionsBeforeProviderDispatch(conversationId: string): void;

    persistProviderUserMessage(
        conversation: ZeusConversationWithMessagesRecord,
        itemPayload: Record<string, unknown>,
        projection: NativeUserMessageProjection,
        providerTurnId: string,
        providerThreadId: string,
        providerItemId: string,
        createdAt: string,
    ): string | null;

    projectProviderUserMessage(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>, providerContent: string, providerItemId: string): NativeUserMessageProjection | null;

    reconcileTerminalTurnSubmissions(
        conversation: ZeusConversationWithMessagesRecord,
        turn: ZeusConversationTurnRecord,
        timestamp: string,
        failure?: unknown,
    ): {
        primarySubmission: ZeusConversationSubmissionRecord | undefined;
        recoveryRequired: ZeusConversationSubmissionRecord[];
        reconciledCount: number
    };

    rejectTurnResultWaiters(key: string, error: Error): void;

    resolveTurnResult(result: NativeTurnResult): void;

    submissionPresentation(conversationId: string, turn: ZeusConversationTurnRecord, itemPayload: Record<string, unknown>): Record<string, unknown>;

    syncItemResources(conversation: ZeusConversationWithMessagesRecord, turn: ZeusConversationTurnRecord, item: ZeusConversationItemRecord, payload: Record<string, unknown>, text: string, timestamp: string): ConversationResource[];

    upsertRecoveredTurn(
        existing: ZeusConversationTurnRecord | undefined,
        input: {
            conversationId: string;
            providerThreadId: string;
            providerTurnId: string;
            clientSubmissionId: string | null;
            status: ConversationTurnStatus;
            timestamp: string;
        },
    ): ZeusConversationTurnRecord;
}

export function createCodexProviderHistoryProjection(dependencies: CodexProviderHistoryProjectionDependencies) {
  const {
    failedTurnResults,
    hasExactProviderUserMessage,
    isSteeringSubmission,
    markConversationRecoveryRequired,
    markSubmissionRecoveryRequired,
    now,
    options,
    failUnsentSubmissionsBeforeProviderDispatch,
    persistProviderUserMessage,
    projectProviderUserMessage,
    processProjector,
    reconcileTerminalTurnSubmissions,
    rejectTurnResultWaiters,
    resolveTurnResult,
    runStates,
    submissionPresentation,
    syncItemResources,
    turnResultWaiters,
    upsertRecoveredTurn,
  } = dependencies;
  const inspectedRolloutTurnStates = new Set<string>();

  async function reconcileRecoveredRequestUserInput(
    conversation: ZeusConversationWithMessagesRecord,
    providerThreadId: string,
    providerTurns: readonly CodexTurnSnapshot[],
    localTurns: ReadonlyMap<string, ZeusConversationTurnRecord>,
  ): Promise<void> {
    const managerState = options.manager.getState();
    const generationId = options.manager.generationForThread(providerThreadId) ?? (managerState.type === 'ready' ? managerState.generationId : null);
    if (!generationId) return;
    const candidates = providerTurns.filter((turn) => !inspectedRolloutTurnStates.has(`${generationId}:${turn.id}:${classifySnapshotTurn(turn)}`));
    if (candidates.length === 0) return;
    const inspection = await inspectCodexRolloutRequestUserInputEvidence({
      rolloutPath: conversation.nativeSessionPath,
      providerThreadId,
      providerTurnIds: candidates.map((turn) => turn.id),
    });
    if (inspection.status !== 'found') return;
    for (const turn of candidates) inspectedRolloutTurnStates.add(`${generationId}:${turn.id}:${classifySnapshotTurn(turn)}`);
    const providerTurnsById = new Map(candidates.map((turn) => [turn.id, turn]));
    const segment = options.execution.segmentByNativeSession(providerThreadId, conversation.id);
    if (!segment || segment.state === 'sealed' || segment.state === 'abandoned') return;
    for (const evidence of inspection.requests) {
      const localTurn = localTurns.get(evidence.providerTurnId);
      const providerTurn = providerTurnsById.get(evidence.providerTurnId);
      if (!localTurn || !providerTurn) continue;
      const classification = classifySnapshotTurn(providerTurn);
      processProjector.projectRecoveredRequestUserInput({
        conversationId: conversation.id,
        turnId: localTurn.id,
        segment,
        evidence,
        providerThreadId,
        turnTerminal: classification !== 'active',
        turnCompletedAt: localTurn.completedAt,
        observedAt: now(),
      });
    }
  }

  async function ensureProviderSyncCheckpoint(conversation: ZeusConversationWithMessagesRecord, input: { priority?: 'control' } = {}) {
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
      const existing = options.syncCheckpoints.getByConversation(conversation.id);
    if (existing) {
      if (existing.providerThreadId === providerThreadId) return existing;
      const currentSegment = options.execution.segmentByNativeSession(providerThreadId, conversation.id);
      if (currentSegment?.state !== 'current') throw coordinatorError('ZEUS_NATIVE_SYNC_CHECKPOINT_CONFLICT', 'Provider sync checkpoint belongs to another thread.');
      const latest = await options.manager.listThreadTurns({ threadId: providerThreadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...input });
        return options.syncCheckpoints.rebind({
        conversationId: conversation.id,
        providerThreadId,
        baselineTurnId: latest.data[0]?.id ?? null,
        timestamp: now(),
      });
    }
    const latest = await options.manager.listThreadTurns({ threadId: providerThreadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', ...input });
      return options.syncCheckpoints.initialize({
      conversationId: conversation.id,
      providerThreadId,
      baselineTurnId: latest.data[0]?.id ?? null,
      timestamp: now(),
    });
  }

  async function reconcileProviderTurnsSinceCheckpoint(conversation: ZeusConversationWithMessagesRecord, input: { priority?: 'control' } = {}): Promise<void> {
    const providerThreadId = requireString(conversation.providerThreadId, 'provider thread id');
    const checkpoint = await ensureProviderSyncCheckpoint(conversation, input);
    const checkpointBoundaryTurnId = checkpoint.lastSyncedTurnId ?? checkpoint.baselineTurnId;
    const turnsDescending: CodexTurnSnapshot[] = [];
    const seenTurnIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let pageCount = 0;
    let checkpointIndex = -1;
    do {
      const page = await options.manager.listThreadTurns({
        threadId: providerThreadId,
        ...(cursor ? { cursor } : {}),
        limit: 100,
        sortDirection: 'desc',
        itemsView: 'full',
        ...input,
      });
      pageCount += 1;
      for (const turn of page.data) {
        if (seenTurnIds.has(turn.id)) continue;
        seenTurnIds.add(turn.id);
        turnsDescending.push(turn);
      }
      if (checkpointBoundaryTurnId) checkpointIndex = turnsDescending.findIndex((turn) => turn.id === checkpointBoundaryTurnId);
      cursor = page.nextCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw coordinatorError('ZEUS_NATIVE_SYNC_CURSOR_INVALID', 'Provider turn pagination repeated one cursor.');
        seenCursors.add(cursor);
      }
      if (cursor && checkpointIndex < 0 && (pageCount >= providerHistoryReconcilePageLimit || turnsDescending.length >= providerHistoryReconcileTurnLimit)) {
        recordProviderSyncAudit({
          conversationId: conversation.id,
          providerThreadId,
          baselineTurnId: checkpoint.baselineTurnId,
          previousWaterlineTurnId: checkpoint.lastSyncedTurnId,
          nextWaterlineTurnId: checkpoint.lastSyncedTurnId,
          inspectedPageCount: pageCount,
          inspectedTurnCount: turnsDescending.length,
          outcome: 'history_gap_budget_exceeded',
        });
        options.execution.persistWarning({
          conversationId: conversation.id,
          warningKind: 'provider_history_gap',
          payload: {
            provider: 'codex',
            providerThreadId,
            generationId: options.manager.generationForThread(providerThreadId) ?? null,
            baselineTurnId: checkpoint.baselineTurnId,
            lastSyncedTurnId: checkpoint.lastSyncedTurnId,
            inspectedTurnCount: turnsDescending.length,
            inspectedPageCount: pageCount,
            pageLimit: providerHistoryReconcilePageLimit,
            turnLimit: providerHistoryReconcileTurnLimit,
            reason: 'reconciliation_budget_exceeded',
          },
          occurredAt: now(),
        });
        throw coordinatorError('ZEUS_NATIVE_SYNC_CHECKPOINT_BUDGET_EXCEEDED', 'Provider history reconciliation exceeded its bounded page budget; historical boundaries will not be guessed.');
      }
    } while (cursor && (!checkpointBoundaryTurnId || checkpointIndex < 0));

    if (checkpointBoundaryTurnId && checkpointIndex < 0) {
      const occurredAt = now();
      recordProviderSyncAudit({
        conversationId: conversation.id,
        providerThreadId,
        baselineTurnId: checkpoint.baselineTurnId,
        previousWaterlineTurnId: checkpoint.lastSyncedTurnId,
        nextWaterlineTurnId: checkpoint.lastSyncedTurnId,
        inspectedPageCount: pageCount,
        inspectedTurnCount: turnsDescending.length,
        outcome: 'history_gap_boundary_missing',
        observedAt: occurredAt,
      });
      options.execution.persistWarning({
        conversationId: conversation.id,
        warningKind: 'provider_history_gap',
        payload: {
          provider: 'codex',
          providerThreadId,
          generationId: options.manager.generationForThread(providerThreadId) ?? null,
          baselineTurnId: checkpoint.baselineTurnId,
          lastSyncedTurnId: checkpoint.lastSyncedTurnId,
          inspectedTurnCount: turnsDescending.length,
          inspectedPageCount: pageCount,
          reason: 'last_synchronized_turn_missing',
        },
        occurredAt,
      });
      throw coordinatorError('ZEUS_NATIVE_SYNC_CHECKPOINT_MISSING', 'Provider history no longer contains the last synchronized turn; historical boundaries will not be guessed.');
    }

    const eligibleDescending = checkpointBoundaryTurnId ? turnsDescending.slice(0, checkpointIndex + 1) : turnsDescending;
    const localTurns = new Map(
      options.turns
        .listByConversation(conversation.id)
        .filter((turn) => turn.providerTurnId)
        .map((turn) => [turn.providerTurnId as string, turn]),
    );
    for (const providerTurn of [...eligibleDescending].reverse()) {
      const existingTurn = localTurns.get(providerTurn.id);
      // 终态基线只定义历史边界；仍在执行的基线必须投影，否则首次对账会再次把目标自主 turn 误判为空闲。
      if (providerTurn.id === checkpoint.baselineTurnId && !existingTurn && classifySnapshotTurn(providerTurn) !== 'active') continue;
      const projected = projectProviderSnapshotTurn(conversation, providerThreadId, providerTurn, existingTurn);
      localTurns.set(providerTurn.id, projected);
    }
    await reconcileRecoveredRequestUserInput(options.conversations.getById(conversation.id) ?? conversation, providerThreadId, eligibleDescending, localTurns);

    const newest = eligibleDescending[0];
      if (newest) options.syncCheckpoints.advance({
          conversationId: conversation.id,
          providerThreadId,
          lastSyncedTurnId: newest.id,
          timestamp: now()
      });
    recordProviderSyncAudit({
      conversationId: conversation.id,
      providerThreadId,
      baselineTurnId: checkpoint.baselineTurnId,
      previousWaterlineTurnId: checkpoint.lastSyncedTurnId,
      nextWaterlineTurnId: newest?.id ?? checkpoint.lastSyncedTurnId,
      inspectedPageCount: pageCount,
      inspectedTurnCount: turnsDescending.length,
      outcome: 'reconciled',
    });
    options.execution.resolveWarning(conversation.id, 'provider_history_gap', now());
  }

  function recordProviderSyncAudit(input: {
    conversationId: string;
    providerThreadId: string;
    baselineTurnId: string | null;
    previousWaterlineTurnId: string | null;
    nextWaterlineTurnId: string | null;
    inspectedPageCount: number;
    inspectedTurnCount: number;
    outcome: ProviderSyncAuditOutcome;
    observedAt?: string;
  }): void {
    const state = options.manager.getState();
    const runtimeGenerationId = options.manager.generationForThread(input.providerThreadId) ?? (state.type === 'ready' ? state.generationId : null);
    if (!runtimeGenerationId) throw coordinatorError('ZEUS_PROVIDER_SYNC_AUDIT_GENERATION_REQUIRED', 'Provider 同步审计缺少运行 generation，已失败关闭。');
    appendProviderSyncAudit(options.execution, {
      conversationId: input.conversationId,
      provider: 'codex',
      providerVersion: state.type === 'ready' && state.generationId === runtimeGenerationId ? state.capabilities.providerVersion : null,
      protocolVersion: state.type === 'ready' && state.generationId === runtimeGenerationId ? state.capabilities.protocolVersion : 'codex-app-server-v2',
      runtimeGenerationId,
      nativeThreadId: input.providerThreadId,
      nativeSessionId: input.providerThreadId,
      baselineTurnId: input.baselineTurnId,
      previousWaterlineTurnId: input.previousWaterlineTurnId,
      nextWaterlineTurnId: input.nextWaterlineTurnId,
      inspectedPageCount: input.inspectedPageCount,
      inspectedTurnCount: input.inspectedTurnCount,
      outcome: input.outcome,
      observedAt: input.observedAt ?? now(),
    });
  }

  function projectProviderSnapshotTurn(conversation: ZeusConversationWithMessagesRecord, providerThreadId: string, providerTurn: CodexTurnSnapshot, existingTurn: ZeusConversationTurnRecord | undefined): ZeusConversationTurnRecord {
    const classification = classifySnapshotTurn(providerTurn);
    if (classification === 'unknown') throw coordinatorError('ZEUS_NATIVE_PROVIDER_TURN_INVALID', `Provider turn has an unknown status: ${providerTurn.id}`);
    const timestamp = now();
    const startedAt = providerTimestamp(providerTurn.startedAt, existingTurn?.startedAt ?? timestamp);
    const completedAt = classification === 'active' ? null : providerTimestamp(providerTurn.completedAt, existingTurn?.completedAt ?? timestamp);
    const submissions = options.submissions.listByConversation(conversation.id);
    if (classification === 'active' && existingTurn && shouldPreserveProviderStopTerminalTurn({ turn: existingTurn, submissions })) {
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: conversation.providerModel, providerState: 'paused' });
      runStates.set(conversation.id, { type: 'paused', reason: 'provider_stop_pending' });
      return existingTurn;
    }
    if (classification === 'active' && isInteractionAuthorityMissingTurn(existingTurn)) {
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: conversation.providerModel, providerState: 'paused' });
      runStates.set(conversation.id, { type: 'paused', reason: 'interaction_authority_missing' });
      return existingTurn!;
    }
    const providerClientId = providerTurnUserClientId(providerTurn);
    const providerMatchedSubmission = providerClientId ? submissions.find((candidate) => candidate.clientMessageId === providerClientId) : undefined;
    const existingOwnedSubmission = existingTurn?.clientSubmissionId ? submissions.find((candidate) => candidate.id === existingTurn.clientSubmissionId) : undefined;
    const existingOwnerConfirmed = Boolean(existingOwnedSubmission && (existingOwnedSubmission.acceptedAt || existingOwnedSubmission.clientMessageId === providerClientId));
    // provider_turn_id 对 steer 只表示目标轮次，不能反向证明该消息已经被 Provider 接收。
    const matchedSubmission = (existingOwnerConfirmed ? existingOwnedSubmission : undefined) ?? providerMatchedSubmission;
    const clientSubmissionId = (existingOwnerConfirmed ? existingTurn?.clientSubmissionId : null) ?? providerMatchedSubmission?.id ?? null;
    const status = classification === 'active' ? 'running' : classification;
    const wasTerminal = existingTurn?.status === 'completed' || existingTurn?.status === 'interrupted' || existingTurn?.status === 'failed';
    const stateChanged = !existingTurn || existingTurn.status !== status;
    const turnProjectionChanged = !existingTurn || existingTurn.status !== status || existingTurn.clientSubmissionId !== clientSubmissionId || existingTurn.startedAt !== startedAt || existingTurn.completedAt !== completedAt;
    let turn = turnProjectionChanged
      ? options.turns.upsert({
          ...(existingTurn ? { id: existingTurn.id } : {}),
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: providerTurn.id,
          clientSubmissionId,
          status,
          ...(classification === 'failed' ? { error: providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id)) } : {}),
          startedAt,
          completedAt,
          createdAt: existingTurn?.createdAt ?? startedAt,
          updatedAt: timestamp,
        })
      : existingTurn;

    const matchedCompatibilityItemIds = new Set<string>();
    let itemProjectionChanged = false;
    for (const candidate of Array.isArray(providerTurn.items) ? providerTurn.items : []) {
      if (!isRecord(candidate)) continue;
      if (projectProviderSnapshotItem(conversation, turn, candidate, classification, timestamp, matchedCompatibilityItemIds)) itemProjectionChanged = true;
    }
    if (itemProjectionChanged && !turnProjectionChanged) {
      turn = options.turns.upsert({
        ...turn,
        status: turn.status,
        ...(classification === 'failed' ? { error: providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id)) } : {}),
        updatedAt: timestamp,
      });
    }

    if (classification === 'active') {
      if (matchedSubmission && (matchedSubmission.status === 'dispatching' || matchedSubmission.status === 'queued')) {
        options.submissions.updateStatus(matchedSubmission.id, 'active', { providerTurnId: providerTurn.id, dispatchedAt: startedAt });
      }
      options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId, providerModel: conversation.providerModel, providerState: 'active' });
      runStates.set(conversation.id, { type: 'active', turnId: providerTurn.id, phase: 'prework' });
      if (stateChanged) {
        options.broadcast('conversation.turn.started', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: providerTurn.id,
          ...(turn.clientSubmissionId ? { submissionId: turn.clientSubmissionId } : {}),
          status: 'running',
          startedAt,
        });
      }
    } else {
      const terminalReconciliation = reconcileTerminalTurnSubmissions(
        conversation,
        turn,
        completedAt ?? timestamp,
        classification === 'failed' ? providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id)) : undefined,
      );
      if (classification === 'failed') {
        const failureRecord = providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id));
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) {
          options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required', error: failureRecord });
        }
      }
      const interruptedQueue = classification === 'interrupted' ? interruptedQueueSubmissions(submissions) : [];
      for (const queued of interruptedQueue.filter((entry: ZeusConversationSubmissionRecord) => entry.status === 'queued')) {
        options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
      }
      const recoveryRequired = terminalReconciliation.recoveryRequired.length > 0;
      const interruptedWithQueue = classification === 'interrupted' && interruptedQueue.length > 0;
      options.conversations.bindProvider(conversation.id, {
        providerId: 'codex',
        providerThreadId,
        providerModel: conversation.providerModel,
        providerState: classification === 'failed' ? 'failed' : recoveryRequired || interruptedWithQueue ? 'paused' : 'ready',
      });
      runStates.set(conversation.id, classification === 'failed' || recoveryRequired ? { type: 'paused', reason: 'recovery_required' } : interruptedWithQueue ? { type: 'paused', reason: 'interrupted' } : { type: 'idle' });
      options.execution.resolveWarning(conversation.id, 'provider_interaction_authority_missing', completedAt ?? timestamp);
        if (!wasTerminal) options.changeSets.seal({conversation, turn, timestamp});
        if (!wasTerminal && !options.goals.get(conversation.id)) {
        options.conversations.markAttentionUnread(conversation.id, {
          kind: classification,
          turnId: providerTurn.id,
          occurredAt: completedAt ?? timestamp,
        });
      }
      if (stateChanged) {
        options.broadcast('conversation.turn.completed', {
          conversationId: conversation.id,
          providerThreadId,
          providerTurnId: providerTurn.id,
          status: classification,
          completedAt: completedAt ?? timestamp,
          ...(classification === 'failed' ? { error: projectConversationTurnFailure(providerTurnFailureRecord({ turn: providerTurn }, providerTurnFailure({ turn: providerTurn }, providerTurn.id))) } : {}),
        });
      }
      const resultKey = `${conversation.id}:${providerTurn.id}`;
      if (!turnResultWaiters.has(resultKey)) {
        // 历史同步可能遍历大量旧轮次；没有调用方等待时只落盘状态，避免把结果缓存扩展成无界历史索引。
      } else if (classification === 'failed') {
        const failure = providerTurnFailure({ turn: providerTurn }, providerTurn.id);
        failedTurnResults.set(resultKey, failure);
        rejectTurnResultWaiters(resultKey, failure);
      } else {
        const refreshed = options.conversations.getById(conversation.id);
        const answer = [...(refreshed?.messages ?? [])].reverse().find((message) => message.providerTurnId === providerTurn.id && message.role === 'assistant')?.content ?? '';
        resolveTurnResult({ conversationId: conversation.id, providerThreadId, providerTurnId: providerTurn.id, status: classification, answer });
      }
    }
    return turn;
  }

  function projectProviderSnapshotItem(
    conversation: ZeusConversationWithMessagesRecord,
    turn: ZeusConversationTurnRecord,
    itemPayload: Record<string, unknown>,
    turnClassification: ReturnType<typeof classifySnapshotTurn>,
    timestamp: string,
    matchedCompatibilityItemIds: Set<string>,
  ): boolean {
    const providerThreadId = turn.providerThreadId;
    const providerTurnId = requireString(turn.providerTurnId, 'provider turn id');
    const nativeProviderItemId = typeof itemPayload.id === 'string' && itemPayload.id.trim() ? itemPayload.id : null;
    if (!nativeProviderItemId) return false;
    const compatibilitySnapshotItem = compatibilitySnapshotItemIdPattern.test(nativeProviderItemId);
    const existingRaw = options.providerItems.getByProvider(providerThreadId, nativeProviderItemId);
    const providerItemId = resolveSnapshotProviderItemId(providerTurnId, nativeProviderItemId, existingRaw);
    const itemType = itemTypeFromValue(itemPayload.type);
    const identityPayload = compatibilitySnapshotItem ? { ...itemPayload, compatibilitySnapshotItemId: nativeProviderItemId } : itemPayload;
    const presentedItemPayload = sanitizeConversationItemPayload(itemType === 'userMessage' ? { ...identityPayload, ...submissionPresentation(conversation.id, turn, itemPayload) } : identityPayload);
    const existing = providerItemId === nativeProviderItemId ? existingRaw : options.providerItems.getByProvider(providerThreadId, providerItemId);
    const userMessageProjection = itemType === 'userMessage' ? projectProviderUserMessage(conversation, turn, presentedItemPayload, itemText(itemPayload), providerItemId) : null;
    if (itemType === 'userMessage' && !userMessageProjection) return false;
    const completedProjection = userMessageProjection
      ? { ...completedItemProjection(existing, presentedItemPayload, itemType), textContent: userMessageProjection.content }
      : completedItemProjection(existing, presentedItemPayload, itemType);
    const itemFailed = itemPayload.status === 'failed';
    const itemTerminal = turnClassification !== 'active' || itemFailed || itemPayload.status === 'completed';
    const projectedStatus = itemFailed ? 'failed' : itemTerminal ? 'completed' : 'in_progress';
    if (compatibilitySnapshotItem) {
      const sourceItems = claimCompatibilitySnapshotSourceItems(
        {
          providerThreadId,
          providerTurnId,
          itemType,
          status: projectedStatus,
          phase: phaseFromItem(itemPayload),
          textContent: completedProjection.textContent,
        },
        options.providerItems.listByConversation(conversation.id).filter((candidate) => candidate.turnId === turn.id),
        matchedCompatibilityItemIds,
      );
      if (sourceItems.length > 0) {
        for (const sourceItem of sourceItems) matchedCompatibilityItemIds.add(sourceItem.id);
        return false;
      }
    }
    const projectedPhase = phaseFromItem(itemPayload);
    if (
      existing &&
      existing.itemType === itemType &&
      existing.status === projectedStatus &&
      existing.phase === projectedPhase &&
      existing.textContent === completedProjection.textContent &&
      existing.payloadJson === JSON.stringify(completedProjection.payload)
    ) {
      return false;
    }
    const item = itemTerminal
      ? options.providerItems.upsertCompleted({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId,
          providerTurnId,
          providerItemId,
          nativeItemId: nativeProviderItemId,
          itemType,
          phase: projectedPhase,
          payload: completedProjection.payload,
          textContent: completedProjection.textContent,
          status: projectedStatus,
          startedAt: existing?.startedAt ?? turn.startedAt,
          completedAt: itemFailed || turnClassification !== 'active' ? (turn.completedAt ?? timestamp) : timestamp,
          updatedAt: timestamp,
        })
      : options.providerItems.upsertProgress({
          conversationId: conversation.id,
          turnId: turn.id,
          providerThreadId,
          providerTurnId,
          providerItemId,
          nativeItemId: nativeProviderItemId,
          itemType,
          phase: projectedPhase,
          payload: completedProjection.payload,
          textContent: completedProjection.textContent,
          startedAt: existing?.startedAt ?? turn.startedAt,
          updatedAt: timestamp,
        });
    if (itemTerminal && item.itemType === 'plan' && item.textContent.trim()) {
      if (!turn.planJson) options.turns.updatePlan(turn.id, { explanation: item.textContent.trim(), steps: [] }, timestamp);
      const executionSegment = options.execution.segmentByNativeSession(providerThreadId, conversation.id);
      if (executionSegment && !options.execution.modelHistoryByProviderItem(conversation.id, providerItemId, 'plan')) {
        options.execution.appendModelHistory({
          conversationId: conversation.id,
          turnId: turn.id,
          segmentId: executionSegment.id,
          role: 'assistant',
          content: { type: 'plan', text: item.textContent },
          submissionId: turn.clientSubmissionId,
          reasoningSource: { provider: 'codex', itemId: providerItemId, itemType: 'plan', readableSummary: false },
          confirmedAt: timestamp,
        });
      }
    }
    let durableClientMessageId: string | null = null;
    if (item.itemType === 'userMessage' && userMessageProjection) {
      durableClientMessageId = persistProviderUserMessage(conversation, presentedItemPayload, userMessageProjection, providerTurnId, providerThreadId, providerItemId, timestamp);
    } else if (item.itemType === 'agentMessage' && itemTerminal) {
      options.conversations.appendMessage({
        conversationId: conversation.id,
        role: 'assistant',
        content: item.textContent,
        source: 'codex_native',
        metadata: { phase: item.phase },
        createdAt: timestamp,
        providerThreadId,
        providerTurnId,
        providerItemId,
      });
    }
    if (item.itemType === 'fileChange') {
      try {
          options.changeSets.capture({
              conversation,
              turn,
              providerItemId,
              changes: itemPayload.changes,
              phase: itemTerminal ? 'post' : 'pre',
              timestamp
          });
      } catch (error) {
        if (!isRejectedHistoricalFileChangeError(error)) throw error;
      }
    }
    const itemResources = syncItemResources(conversation, turn, item, presentedItemPayload, item.textContent, timestamp);
    options.broadcast('conversation.item.updated', {
      conversationId: conversation.id,
      providerThreadId,
      providerTurnId,
      providerItemId,
      itemType: item.itemType,
      itemPayload: { ...parseJsonRecord(item.payloadJson), ...(item.itemType === 'userMessage' ? { clientId: durableClientMessageId } : {}) },
      textContent: item.textContent,
      status: item.status,
      phase: item.phase,
      itemResources,
    });
    return true;
  }

  /**
   * 检查点分页已经把 Provider turn 投影到本地；后续恢复判断只消费该有界结果与轻量 thread 元数据，
   * 禁止再次 thread/read(includeTurns=true) 把完整原生日志拉回热路径。
   */
  function projectedProviderThreadSnapshot(conversationId: string, metadata: CodexThreadSnapshot): CodexThreadSnapshot {
    const submissionsById = new Map(options.submissions.listByConversation(conversationId).map((submission) => [submission.id, submission]));
    return {
      ...metadata,
      turns: options.turns.listByConversation(conversationId).flatMap((turn) => {
        if (!turn.providerTurnId) return [];
        const submission = turn.clientSubmissionId ? submissionsById.get(turn.clientSubmissionId) : undefined;
        return [
          {
            id: turn.providerTurnId,
            status: turn.status,
            startedAt: turn.startedAt,
            completedAt: turn.completedAt,
            ...(submission?.clientMessageId ? { clientUserMessageId: submission.clientMessageId } : {}),
          },
        ];
      }),
    };
  }

  function reconcileConversationSnapshot(conversation: ZeusConversationWithMessagesRecord, snapshot: CodexThreadSnapshot, generationId: string, input: { preserveUnsentQueue?: boolean } = {}): void {
    const snapshotPath = threadPath(snapshot);
    if (snapshotPath && conversation.nativeSessionPath !== snapshotPath) {
      conversation = options.conversations.updateProviderThreadPath(conversation.id, {
        providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
        providerThreadPath: snapshotPath,
      });
    }
    const submissions = options.submissions.listByConversation(conversation.id);
    const pendingSteering = submissions.filter((submission) => isSteeringSubmission(submission) && (submission.status === 'dispatching' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required')));
    const inFlight = submissions.filter(
      (submission) =>
        !isSteeringSubmission(submission) &&
        (submission.status === 'dispatching' || submission.status === 'active' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required' && Boolean(submission.providerTurnId))),
    );
    for (const submission of pendingSteering) {
      const snapshotTurn = findSnapshotTurn(snapshot, submission);
      const providerTurnId = snapshotTurn && typeof snapshotTurn.id === 'string' ? snapshotTurn.id : submission.providerTurnId;
      const classification = classifySnapshotTurn(snapshotTurn);
      if (providerTurnId && hasExactProviderUserMessage(conversation, submission, providerTurnId)) {
        if (submission.status !== 'resolved') options.submissions.updateStatus(submission.id, 'resolved', { providerTurnId, resolvedAt: now() });
        continue;
      }
      if (!snapshotTurn || !providerTurnId || classification === 'unknown' || classification !== 'active') {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_STEER_OUTCOME_UNKNOWN', 'Provider thread state cannot confirm the steering user message.'));
      }
    }
    if (inFlight.length === 0) {
      const protectedProviderStopTurn = options.turns.listByConversation(conversation.id).find((turn) => shouldPreserveProviderStopTerminalTurn({ turn, submissions }) && snapshot.status?.type === 'active');
      if (protectedProviderStopTurn) {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerModel: conversation.providerModel,
          providerState: 'paused',
        });
        runStates.set(conversation.id, { type: 'paused', reason: 'provider_stop_pending' });
        return;
      }
      const activeProviderTurn = (Array.isArray(snapshot.turns) ? snapshot.turns.filter(isRecord) : []).find((candidate) => classifySnapshotTurn(candidate) === 'active');
      const activeProviderTurnId = activeProviderTurn && typeof activeProviderTurn.id === 'string' ? activeProviderTurn.id : null;
      const projectedRemoteTurn = activeProviderTurnId ? options.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === activeProviderTurnId && !turn.clientSubmissionId) : undefined;
      if (activeProviderTurnId && projectedRemoteTurn) {
        options.turns.upsert({ ...projectedRemoteTurn, status: 'running', completedAt: null, updatedAt: now() });
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerModel: conversation.providerModel,
          providerState: 'active',
        });
        runStates.set(conversation.id, { type: 'active', turnId: activeProviderTurnId, phase: 'prework' });
        return;
      }
      const unresolvedSteering = pendingSteering.some((submission) => {
        const current = options.submissions.getById(submission.id);
        return current?.status === 'paused' && current.pausedReason === 'recovery_required';
      });
      if (unresolvedSteering) {
        if (conversation.providerThreadId && conversation.providerState !== 'archived' && conversation.providerState !== 'closed' && conversation.providerState !== 'failed') {
          options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: conversation.providerThreadId,
            providerModel: conversation.providerModel,
            providerState: 'paused',
          });
        }
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        return;
      }
      if (!snapshotConfirmsIdleProviderThread(snapshot)) {
        markConversationRecoveryRequired(conversation.id, coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread state cannot confirm that there is no active turn.'));
        return;
      }
      if (conversation.providerState === 'closed') {
        markConversationRecoveryRequired(conversation.id, coordinatorError('ZEUS_NATIVE_CONVERSATION_NOT_RESUMABLE', 'The provider conversation cannot be resumed safely.'));
        return;
      }
      // 单轮失败不终止 thread；只有 Provider 快照能对上本地终态轮次时才恢复下一轮派发。
      if (conversation.providerState === 'paused' || conversation.providerState === 'failed') {
        if (!snapshotConfirmsSafeResumeBoundary(snapshot, options.turns.listByConversation(conversation.id))) {
          markConversationRecoveryRequired(conversation.id, coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread state cannot confirm that the previous turn is terminal.'));
          return;
        }
      }
      if (conversation.providerState !== 'ready') {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerModel: conversation.providerModel,
          providerState: 'ready',
        });
      }
      // Provider 没有接收事实的旧提交直接收敛为失败审计，不能回到输入框或等待隐式重放。
      if (input.preserveUnsentQueue !== true) failUnsentSubmissionsBeforeProviderDispatch(conversation.id);
      runStates.set(conversation.id, { type: 'idle' });
      return;
    }
    for (const submission of inFlight) {
      const currentSubmission = options.submissions.getById(submission.id);
      if (
        !currentSubmission ||
        (currentSubmission.status !== 'dispatching' && currentSubmission.status !== 'active' && !(currentSubmission.status === 'paused' && currentSubmission.pausedReason === 'recovery_required' && Boolean(currentSubmission.providerTurnId)))
      )
        continue;
      const snapshotTurn = findSnapshotTurn(snapshot, submission);
      const providerTurnId = snapshotTurn && typeof snapshotTurn.id === 'string' ? snapshotTurn.id : submission.providerTurnId;
      const classification = classifySnapshotTurn(snapshotTurn);
      if (!snapshotTurn || !providerTurnId || classification === 'unknown') {
        markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_UNKNOWN_DISPATCH_WINDOW', 'Provider thread state cannot confirm the in-flight submission.'));
        continue;
      }
      const timestamp = now();
      const existingTurn = options.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === providerTurnId || turn.clientSubmissionId === submission.id);
      if (classification === 'active' && isInteractionAuthorityMissingTurn(existingTurn)) {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
          providerModel: conversation.providerModel,
          providerState: 'paused',
        });
        runStates.set(conversation.id, { type: 'paused', reason: 'interaction_authority_missing' });
        continue;
      }
      const exactDeliveryConfirmed = hasExactProviderUserMessage(conversation, submission, providerTurnId);
      const initialTurnAcceptanceConfirmed = submission.submissionOutcome === 'accepted' && Boolean(submission.acceptedAt);
      const turn = upsertRecoveredTurn(existingTurn, {
        conversationId: conversation.id,
        providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
        providerTurnId,
        clientSubmissionId: existingTurn ? existingTurn.clientSubmissionId : exactDeliveryConfirmed || initialTurnAcceptanceConfirmed ? submission.id : null,
        status: classification === 'completed' ? 'completed' : classification === 'interrupted' ? 'interrupted' : classification === 'failed' ? 'failed' : 'running',
        timestamp,
      });
      if (classification === 'active') {
        const pending = options.requests.listByConversation(conversation.id).find((request) => request.turnId === turn.id && request.status === 'pending' && request.transportGenerationId === generationId);
        if (pending) options.turns.upsert({ ...turn, status: 'waiting', updatedAt: timestamp });
        if (exactDeliveryConfirmed || initialTurnAcceptanceConfirmed) {
          options.submissions.updateStatus(submission.id, 'active', { providerTurnId });
        } else {
          markSubmissionRecoveryRequired(submission, coordinatorError('ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED', 'The active provider turn does not contain exact evidence that this user message was received.'));
        }
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: pending ? 'waiting' : 'active' });
        runStates.set(
          conversation.id,
          pending ? { type: 'waiting', turnId: providerTurnId, requestId: pending.id, reason: pending.requestKind === 'request_user_input' ? 'user_input' : 'approval' } : { type: 'active', turnId: providerTurnId, phase: 'prework' },
        );
      } else if (classification === 'completed') {
        const result = reconcileTerminalTurnSubmissions(conversation, turn, timestamp);
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: result.recoveryRequired.length > 0 ? 'paused' : 'ready',
        });
        runStates.set(conversation.id, result.recoveryRequired.length > 0 ? { type: 'paused', reason: 'recovery_required' } : { type: 'idle' });
      } else if (classification === 'interrupted') {
        const result = reconcileTerminalTurnSubmissions(conversation, turn, timestamp);
        const interruptedQueue = interruptedQueueSubmissions(submissions);
        for (const queued of interruptedQueue.filter((entry: ZeusConversationSubmissionRecord) => entry.status === 'queued')) options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'interrupted' });
        const hasInterruptedQueue = interruptedQueue.length > 0;
        const requiresRecovery = result.recoveryRequired.length > 0;
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: turn.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: requiresRecovery || hasInterruptedQueue ? 'paused' : 'ready',
        });
        runStates.set(conversation.id, requiresRecovery ? { type: 'paused', reason: 'recovery_required' } : hasInterruptedQueue ? { type: 'paused', reason: 'interrupted' } : { type: 'idle' });
      } else {
        const failureParams = { turn: snapshotTurn };
        const failure = providerTurnFailure(failureParams, providerTurnId);
        const failureRecord = providerTurnFailureRecord(failureParams, failure);
        const failedTurn = options.turns.upsert({ ...turn, status: 'failed', error: failureRecord, completedAt: timestamp, updatedAt: timestamp });
        reconcileTerminalTurnSubmissions(conversation, failedTurn, timestamp, failureRecord);
        for (const queued of submissions.filter((entry) => entry.status === 'queued')) {
          options.submissions.updateStatus(queued.id, 'paused', { pausedReason: 'recovery_required', error: failureRecord });
        }
        options.conversations.bindProvider(conversation.id, { providerId: 'codex', providerThreadId: turn.providerThreadId, providerModel: conversation.providerModel, providerState: 'failed' });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
        const resultKey = `${conversation.id}:${providerTurnId}`;
        if (turnResultWaiters.has(resultKey)) {
          failedTurnResults.set(resultKey, failure);
          rejectTurnResultWaiters(resultKey, failure);
        }
      }
    }
  }

  /** 执行宿主启动时先用本地终态轮次和消息身份修复历史残留，不依赖 Provider 联机。 */
  function reconcilePersistedTerminalTurnSubmissions(): number {
    const candidatesByConversation = new Map<string, ZeusConversationSubmissionRecord[]>();
    for (const submission of options.submissions.listRecoverable()) {
      if ((submission.status !== 'dispatching' && submission.status !== 'active' && !(submission.status === 'paused' && submission.pausedReason === 'recovery_required')) || !submission.providerTurnId) continue;
      const entries = candidatesByConversation.get(submission.conversationId) ?? [];
      entries.push(submission);
      candidatesByConversation.set(submission.conversationId, entries);
    }

    let reconciledCount = 0;
    for (const [conversationId, candidates] of candidatesByConversation) {
      const conversation = options.conversations.getById(conversationId);
      if (!conversation || conversation.agentKind !== 'codex' || conversation.transportKind !== 'codex_native') continue;
      const candidateTurnIds = new Set(candidates.map((submission) => submission.providerTurnId).filter((providerTurnId): providerTurnId is string => Boolean(providerTurnId)));
      const terminalTurns = options.turns
        .listByConversation(conversationId)
        .filter((turn) => Boolean(turn.providerTurnId && candidateTurnIds.has(turn.providerTurnId)) && (turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed'));
      let requiresRecovery = false;
      for (const turn of terminalTurns) {
        const result = reconcileTerminalTurnSubmissions(conversation, turn, turn.completedAt ?? turn.updatedAt);
        reconciledCount += result.reconciledCount;
        requiresRecovery ||= result.recoveryRequired.length > 0;
      }
      if (requiresRecovery && conversation.providerThreadId && conversation.providerState !== 'archived' && conversation.providerState !== 'closed' && conversation.providerState !== 'failed') {
        options.conversations.bindProvider(conversation.id, {
          providerId: 'codex',
          providerThreadId: conversation.providerThreadId,
          providerModel: conversation.providerModel,
          providerState: 'paused',
        });
        runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
      } else if (terminalTurns.length > 0 && conversation.providerThreadId && conversation.providerState === 'paused') {
        const unresolvedAcceptedDelivery = options.submissions
          .listByConversation(conversation.id)
          .some((submission) => submission.status === 'dispatching' || submission.status === 'active' || (submission.status === 'paused' && submission.pausedReason === 'recovery_required' && Boolean(submission.providerTurnId)));
        if (!unresolvedAcceptedDelivery) {
          options.conversations.bindProvider(conversation.id, {
            providerId: 'codex',
            providerThreadId: conversation.providerThreadId,
            providerModel: conversation.providerModel,
            providerState: 'ready',
          });
          runStates.set(conversation.id, { type: 'idle' });
        }
      }
    }
    return reconciledCount;
  }

  return {
    ensureProviderSyncCheckpoint,
    reconcilePersistedTerminalTurnSubmissions,
    reconcileProviderTurnsSinceCheckpoint,
    projectedProviderThreadSnapshot,
    reconcileConversationSnapshot,
  };
}
