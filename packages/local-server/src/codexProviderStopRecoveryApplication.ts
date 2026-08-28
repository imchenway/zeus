import type { CodexAppServerManager } from '@zeus/ai-runtime';
import type {
  ConversationRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  ZeusConversationSubmissionRecord,
  ZeusConversationTurnRecord,
  ZeusConversationWithMessagesRecord,
} from '@zeus/storage';
import type { NativeConversationRunState } from './codexNativeConversationContracts.js';
import { classifySnapshotTurn, coordinatorError, isRecord, serializeError } from './codexNativeConversationPolicy.js';
import { CodexProviderCommandApplicationService } from './codexProviderCommandApplication.js';

const providerStopRecoveryDelaysMs = [1_000, 2_000, 5_000, 15_000] as const;
const providerStopConfirmationDelaysMs = [0, 250, 500, 1_000, 2_000, 4_000] as const;
const providerStopPendingCode = 'ZEUS_PROVIDER_STOP_PENDING';
const providerStopRecoveryRequiredCode = 'ZEUS_PROVIDER_STOP_RECOVERY_REQUIRED';

type ProviderStopCandidate = {
  turn: ZeusConversationTurnRecord;
  stopCommandId: string;
  requestedAt: string;
  compatibility: boolean;
  historicalStopEvidence: boolean;
};

type ProviderStopAuthority =
  | { type: 'terminal'; status: 'completed' | 'interrupted' | 'failed' }
  | { type: 'target_active' }
  | { type: 'unknown_active'; providerTurnIds: string[] };

export interface CodexProviderStopRequestResult {
  terminalConfirmed: boolean;
}

interface CodexProviderStopRecoveryOptions {
  manager: Pick<CodexAppServerManager, 'generationForThread' | 'interruptTurn' | 'readThread' | 'listThreadTurns'>;
  providerCommands: CodexProviderCommandApplicationService;
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  turns: ConversationTurnRepository;
  runStates: Map<string, NativeConversationRunState>;
  ensureProviderReady(): Promise<unknown>;
  persist(): Promise<void>;
  broadcast(type: string, payload: Record<string, unknown>): void;
  requestQueueDrain(): void;
  now(): string;
}

export interface CodexProviderStopRecoveryApplication {
  requestStop(input: {
    conversationId: string;
    providerThreadId: string;
    providerTurnId: string;
    stopCommandId: string;
    confirmationTimeoutMs: number;
  }): Promise<CodexProviderStopRequestResult>;
  hasPendingEvidence(conversationId: string): boolean;
  recoverForNewSubmission(conversationId: string): Promise<'not_applicable' | 'ready' | 'pending' | 'recovery_required'>;
  recoverPersisted(): Promise<void>;
  retry(conversationId: string): Promise<'not_applicable' | 'ready' | 'pending' | 'recovery_required'>;
  close(): void;
}

/**
 * “用户停止”已在本地终态化、但 Provider 尚未确认终态的独立恢复边界。
 * 它只核对原 thread 与精确 turn，不创建 thread，也不发送或复制用户消息。
 */
export function createCodexProviderStopRecoveryApplication(options: CodexProviderStopRecoveryOptions): CodexProviderStopRecoveryApplication {
  const recoveryChains = new Map<string, Promise<'not_applicable' | 'ready' | 'pending' | 'recovery_required'>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryAttempts = new Map<string, number>();
  let closed = false;

  function stopRetry(conversationId: string): void {
    const timer = retryTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(conversationId);
    retryAttempts.delete(conversationId);
  }

  function scheduleRetry(conversationId: string): void {
    if (closed || retryTimers.has(conversationId)) return;
    const attempt = retryAttempts.get(conversationId) ?? 0;
    const delay = providerStopRecoveryDelaysMs[Math.min(attempt, providerStopRecoveryDelaysMs.length - 1)]!;
    retryAttempts.set(conversationId, attempt + 1);
    const timer = setTimeout(() => {
      retryTimers.delete(conversationId);
      void recoverConversation(conversationId, false).catch(() => undefined);
    }, delay);
    timer.unref();
    retryTimers.set(conversationId, timer);
  }

  function candidateForConversation(conversationId: string): ProviderStopCandidate | null {
    const conversation = options.conversations.getById(conversationId);
    if (!conversation?.providerThreadId) return null;
    const turns = options.turns.listByConversation(conversationId);
    const submissions = options.submissions.listByConversation(conversationId);
    const explicit = [...turns].reverse().find((turn) => isTerminalTurn(turn) && isProviderStopPendingError(parseError(turn.errorJson)));
    if (explicit?.providerTurnId && explicit.providerThreadId === conversation.providerThreadId) {
      const error = parseError(explicit.errorJson);
      return {
        turn: explicit,
        stopCommandId: typeof error.stopCommandId === 'string' && error.stopCommandId ? error.stopCommandId : `legacy:${explicit.providerTurnId}`,
        requestedAt: typeof error.requestedAt === 'string' && error.requestedAt ? error.requestedAt : (explicit.completedAt ?? explicit.updatedAt),
        compatibility: false,
        historicalStopEvidence: true,
      };
    }
    const pendingSubmission = [...submissions]
      .reverse()
      .find((submission) => !submission.providerTurnId && submission.status === 'paused' && (submission.pausedReason === 'provider_stop_pending' || submission.pausedReason === 'recovery_required'));
    if (!pendingSubmission) return null;
    const historicalStopSubmission = [...submissions].reverse().find((submission) => {
      const error = parseError(submission.errorJson);
      return submission.status === 'cancelled' && error.code === 'ZEUS_FORCED_QUIT_INTERRUPTED' && (submission.resolvedAt ?? submission.updatedAt) <= pendingSubmission.createdAt;
    });
    if (!historicalStopSubmission) return null;
    const compatibleTurn = [...turns]
      .reverse()
      .find((turn) => Boolean(turn.providerTurnId) && turn.providerThreadId === conversation.providerThreadId && isTerminalTurn(turn) && turn.createdAt <= pendingSubmission.createdAt);
    if (!compatibleTurn?.providerTurnId) return null;
    const historicalStopError = parseError(historicalStopSubmission.errorJson);
    return {
      turn: compatibleTurn,
      stopCommandId:
        typeof historicalStopError.stopCommandId === 'string' && historicalStopError.stopCommandId
          ? historicalStopError.stopCommandId
          : `legacy:${compatibleTurn.providerTurnId}`,
      requestedAt: historicalStopSubmission.resolvedAt ?? historicalStopSubmission.updatedAt,
      compatibility: true,
      historicalStopEvidence: true,
    };
  }

  function hasPendingEvidence(conversationId: string): boolean {
    return candidateForConversation(conversationId) !== null;
  }

  async function requestStop(input: {
    conversationId: string;
    providerThreadId: string;
    providerTurnId: string;
    stopCommandId: string;
    confirmationTimeoutMs: number;
  }): Promise<CodexProviderStopRequestResult> {
    await requestInterrupt({ ...input, attempt: 0 });
    const deadline = Date.now() + Math.max(0, Math.min(8_000, input.confirmationTimeoutMs));
    for (const delay of providerStopConfirmationDelaysMs) {
      if (delay > 0) await wait(Math.min(delay, Math.max(0, deadline - Date.now())));
      try {
        const remainingMs = Math.max(0, deadline - Date.now());
        if (remainingMs === 0) break;
        const authority = await withTimeout(
          readProviderStopAuthority(input.providerThreadId, input.providerTurnId),
          remainingMs,
          () => coordinatorError('ZEUS_PROVIDER_STOP_CONFIRMATION_TIMEOUT', 'Provider turn terminal confirmation exceeded its bounded exit window.'),
        );
        if (authority.type === 'terminal') return { terminalConfirmed: true };
      } catch {
        // 退出确认窗口只决定是否需要持久恢复；线程缺失等明确故障由下一代恢复边界呈现。
      }
      if (Date.now() >= deadline) break;
    }
    return { terminalConfirmed: false };
  }

  function recoverConversation(conversationId: string, manual: boolean): Promise<'not_applicable' | 'ready' | 'pending' | 'recovery_required'> {
    const previous = recoveryChains.get(conversationId);
    const chain = (previous ? previous.catch(() => 'pending' as const) : Promise.resolve('pending' as const)).then(() => recoverConversationUnserialized(conversationId, manual));
    recoveryChains.set(conversationId, chain);
    void chain.finally(() => {
      if (recoveryChains.get(conversationId) === chain) recoveryChains.delete(conversationId);
    });
    return chain;
  }

  async function recoverConversationUnserialized(conversationId: string, manual: boolean): Promise<'not_applicable' | 'ready' | 'pending' | 'recovery_required'> {
    if (closed) return 'pending';
    const candidate = candidateForConversation(conversationId);
    const conversation = options.conversations.getById(conversationId);
    if (!candidate || !conversation?.providerThreadId || !candidate.turn.providerTurnId) {
      stopRetry(conversationId);
      return 'not_applicable';
    }
    const providerThreadId = conversation.providerThreadId;
    const providerTurnId = candidate.turn.providerTurnId;
    try {
      await options.ensureProviderReady();
      const beforeInterrupt = await readProviderStopAuthority(providerThreadId, providerTurnId);
      if (beforeInterrupt.type === 'terminal') {
        if (candidate.compatibility && !candidate.historicalStopEvidence) return 'not_applicable';
        await completeRecovery(conversation, candidate, beforeInterrupt.status);
        return 'ready';
      }
      if (beforeInterrupt.type === 'unknown_active') {
        await failRecovery(conversation, candidate, coordinatorError('ZEUS_PROVIDER_STOP_UNKNOWN_ACTIVE_TURN', 'Provider thread contains an unknown active turn; automatic recovery is blocked.'), beforeInterrupt.providerTurnIds);
        return 'recovery_required';
      }
      await markPending(conversation, candidate);
      const attempt = retryAttempts.get(conversationId) ?? 0;
      let interruptError: unknown;
      try {
        await requestInterrupt({ conversationId, providerThreadId, providerTurnId, stopCommandId: candidate.stopCommandId, attempt });
      } catch (error) {
        interruptError = error;
      }
      const afterInterrupt = await readProviderStopAuthority(providerThreadId, providerTurnId);
      if (afterInterrupt.type === 'terminal') {
        await completeRecovery(options.conversations.getById(conversationId) ?? conversation, candidate, afterInterrupt.status);
        return 'ready';
      }
      if (afterInterrupt.type === 'unknown_active') {
        await failRecovery(conversation, candidate, coordinatorError('ZEUS_PROVIDER_STOP_UNKNOWN_ACTIVE_TURN', 'Provider thread contains an unknown active turn; automatic recovery is blocked.'), afterInterrupt.providerTurnIds);
        return 'recovery_required';
      }
      options.broadcast('conversation.native.provider_stop_pending', {
        conversationId,
        providerThreadId,
        providerTurnId,
        attempt,
        ...(interruptError ? { interruptError: serializeError(interruptError) } : {}),
      });
      scheduleRetry(conversationId);
      return 'pending';
    } catch (error) {
      if (isTerminalRecoveryError(error)) {
        await failRecovery(conversation, candidate, error);
        return 'recovery_required';
      }
      await markPending(conversation, candidate, error);
      options.broadcast('conversation.native.provider_stop_pending', {
        conversationId,
        providerThreadId,
        providerTurnId,
        ...(manual ? { manual: true } : {}),
        error: serializeError(error),
      });
      scheduleRetry(conversationId);
      return 'pending';
    }
  }

  async function readProviderStopAuthority(providerThreadId: string, providerTurnId: string): Promise<ProviderStopAuthority> {
    const thread = await options.manager.readThread({ threadId: providerThreadId, priority: 'control' });
    if (thread.id !== providerThreadId) throw coordinatorError('ZEUS_CODEX_THREAD_IDENTITY_MISMATCH', 'Codex returned a different thread while recovering a stopped turn.');
    const status = thread.status;
    if (!status) throw coordinatorError('ZEUS_NATIVE_PROVIDER_STATE_UNCONFIRMED', 'Provider thread omitted its authoritative runtime status.');
    if (status.type === 'systemError') throw coordinatorError('ZEUS_NATIVE_PROVIDER_SYSTEM_ERROR', 'Provider thread is in systemError state.');
    const page = await options.manager.listThreadTurns({ threadId: providerThreadId, limit: 100, sortDirection: 'desc', itemsView: 'notLoaded', priority: 'control' });
    const target = page.data.find((turn) => turn.id === providerTurnId);
    if (!target) throw coordinatorError('ZEUS_PROVIDER_STOP_TURN_MISSING', 'The stopped Provider turn is missing from its original thread.');
    const targetClassification = classifySnapshotTurn(target);
    if (targetClassification === 'unknown') throw coordinatorError('ZEUS_NATIVE_PROVIDER_TURN_INVALID', 'The stopped Provider turn has an unknown status.');
    const activeTurns = page.data.filter((turn) => classifySnapshotTurn(turn) === 'active');
    const unknownActiveTurnIds = activeTurns.filter((turn) => turn.id !== providerTurnId).map((turn) => turn.id);
    if (unknownActiveTurnIds.length > 0) return { type: 'unknown_active', providerTurnIds: unknownActiveTurnIds };
    if (status.type === 'active') {
      if (targetClassification === 'active' && activeTurns.length === 1) return { type: 'target_active' };
      return { type: 'unknown_active', providerTurnIds: activeTurns.map((turn) => turn.id) };
    }
    if (targetClassification === 'active') return { type: 'unknown_active', providerTurnIds: [providerTurnId] };
    return { type: 'terminal', status: targetClassification };
  }

  async function requestInterrupt(input: { conversationId: string; providerThreadId: string; providerTurnId: string; stopCommandId: string; attempt: number }): Promise<void> {
    const turnScopeId = options.turns.listByConversation(input.conversationId).find((turn) => turn.providerTurnId === input.providerTurnId)?.id ?? input.providerTurnId;
    await options.providerCommands.executeTurn({
      operation: 'turn_interrupt',
      commandKey: `provider-stop:${input.stopCommandId}:${input.providerTurnId}:${input.attempt}`,
      scope: { kind: 'turn', id: turnScopeId },
      idempotencyKey: `provider-stop:${input.stopCommandId}:${input.providerTurnId}:${input.attempt}`,
      issuedAt: options.now(),
      resourceId: input.conversationId,
      requestIdentity: { threadId: input.providerThreadId, turnId: input.providerTurnId, stopCommandId: input.stopCommandId, attempt: input.attempt },
      providerGenerationId: options.manager.generationForThread(input.providerThreadId),
      nativeSessionId: input.providerThreadId,
      nativeTurnId: () => input.providerTurnId,
      invoke: (traceIdentity) => options.manager.interruptTurn({ threadId: input.providerThreadId, turnId: input.providerTurnId, traceIdentity }),
      recoverAccepted: async (nativeSessionId, nativeTurnId) => {
        if (nativeSessionId !== input.providerThreadId || nativeTurnId !== input.providerTurnId) {
          throw coordinatorError('ZEUS_CODEX_PROVIDER_ACCEPTED_IDENTITY_MISMATCH', 'Provider interrupt ledger identity does not match the stopped turn.');
        }
      },
    });
  }

  async function markPending(conversation: ZeusConversationWithMessagesRecord, candidate: ProviderStopCandidate, cause?: unknown): Promise<void> {
    const providerThreadId = conversation.providerThreadId!;
    const providerTurnId = candidate.turn.providerTurnId!;
    const timestamp = options.now();
    const error = providerStopPendingError({
      providerThreadId,
      providerTurnId,
      stopCommandId: candidate.stopCommandId,
      requestedAt: candidate.requestedAt,
      ...(cause ? { cause: serializeError(cause) } : {}),
    });
    options.turns.upsert({ ...candidate.turn, status: 'interrupted', error, completedAt: candidate.turn.completedAt ?? timestamp, updatedAt: timestamp });
    for (const submission of resumableSubmissions(conversation.id, candidate)) {
      if (submission.status === 'queued' || submission.status === 'paused') {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'provider_stop_pending', error, updatedAt: timestamp });
      }
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'paused',
    });
    options.runStates.set(conversation.id, { type: 'paused', reason: 'provider_stop_pending' });
    await options.persist();
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerTurnId, waitReason: 'provider_stop_pending' });
  }

  async function completeRecovery(conversation: ZeusConversationWithMessagesRecord, candidate: ProviderStopCandidate, providerStatus: 'completed' | 'interrupted' | 'failed'): Promise<void> {
    stopRetry(conversation.id);
    const timestamp = options.now();
    const providerThreadId = conversation.providerThreadId!;
    const providerTurnId = candidate.turn.providerTurnId!;
    options.turns.upsert({
      ...candidate.turn,
      status: 'interrupted',
      error: {
        code: 'ZEUS_FORCED_QUIT_INTERRUPTED',
        message: '用户停止活动工作并退出 Zeus。',
        providerOutcomeUnconfirmed: false,
        providerStopPending: false,
        providerTerminalStatus: providerStatus,
        stopCommandId: candidate.stopCommandId,
        providerStopConfirmedAt: timestamp,
      },
      completedAt: candidate.turn.completedAt ?? timestamp,
      updatedAt: timestamp,
    });
    for (const submission of resumableSubmissions(conversation.id, candidate)) {
      if (submission.status !== 'paused' || submission.providerTurnId) continue;
      options.submissions.updateStatus(submission.id, 'queued', { pausedReason: null, updatedAt: timestamp });
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'ready',
    });
    options.runStates.set(conversation.id, { type: 'idle' });
    await options.persist();
    options.broadcast('conversation.native.provider_stop_recovered', { conversationId: conversation.id, providerThreadId, providerTurnId, providerTerminalStatus: providerStatus });
    options.broadcast('conversation.thread.changed', { conversationId: conversation.id, providerThreadId, providerState: 'ready' });
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, providerState: 'ready' });
    options.requestQueueDrain();
  }

  async function failRecovery(conversation: ZeusConversationWithMessagesRecord, candidate: ProviderStopCandidate, cause: unknown, unknownProviderTurnIds: string[] = []): Promise<void> {
    stopRetry(conversation.id);
    const timestamp = options.now();
    const providerThreadId = conversation.providerThreadId!;
    const providerTurnId = candidate.turn.providerTurnId!;
    const error = {
      code: providerStopRecoveryRequiredCode,
      message: '无法确认上次运行已安全停止，需要重新核对或取消待发送消息。',
      recoveryRequired: true,
      retryable: true,
      providerThreadId,
      providerTurnId,
      stopCommandId: candidate.stopCommandId,
      ...(unknownProviderTurnIds.length > 0 ? { unknownProviderTurnIds } : {}),
      cause: serializeError(cause),
    };
    options.turns.upsert({ ...candidate.turn, status: 'interrupted', error: { ...error, providerStopPending: true, providerOutcomeUnconfirmed: true }, completedAt: candidate.turn.completedAt ?? timestamp, updatedAt: timestamp });
    for (const submission of resumableSubmissions(conversation.id, candidate)) {
      if (submission.status === 'queued' || submission.status === 'paused') {
        options.submissions.updateStatus(submission.id, 'paused', { pausedReason: 'recovery_required', error, updatedAt: timestamp });
      }
    }
    options.conversations.bindProvider(conversation.id, {
      providerId: 'codex',
      providerThreadId,
      providerModel: conversation.providerModel,
      providerState: 'paused',
    });
    options.runStates.set(conversation.id, { type: 'paused', reason: 'recovery_required' });
    await options.persist();
    options.broadcast('conversation.native.recovery_failed', { conversationId: conversation.id, providerThreadId, providerTurnId, error });
    options.broadcast('conversation.queue.changed', { conversationId: conversation.id, providerThreadId, waitReason: 'recovery_required' });
  }

  function resumableSubmissions(conversationId: string, candidate: ProviderStopCandidate): ZeusConversationSubmissionRecord[] {
    return options.submissions.listByConversation(conversationId).filter((submission) => {
      if (submission.providerTurnId || (submission.status !== 'queued' && submission.status !== 'paused')) return false;
      if (submission.status === 'queued' && submission.createdAt >= candidate.requestedAt) return true;
      if (submission.pausedReason === 'provider_stop_pending') return true;
      if (parseError(submission.errorJson).code === providerStopRecoveryRequiredCode) return true;
      return candidate.compatibility && submission.pausedReason === 'recovery_required' && submission.createdAt >= candidate.requestedAt;
    });
  }

  async function recoverPersisted(): Promise<void> {
    const conversationIds = options.conversations
      .listNativeBoundRecords('codex')
      .filter((conversation) => !conversation.archived && conversation.providerState !== 'closed' && conversation.providerState !== 'failed')
      .map((conversation) => conversation.id)
      .filter(hasPendingEvidence);
    await Promise.all(conversationIds.map((conversationId) => recoverConversation(conversationId, false).catch(() => 'pending' as const)));
  }

  function close(): void {
    closed = true;
    for (const conversationId of [...retryTimers.keys()]) stopRetry(conversationId);
  }

  return {
    requestStop,
    hasPendingEvidence,
    recoverForNewSubmission: (conversationId) => recoverConversation(conversationId, false),
    recoverPersisted,
    retry: (conversationId) => recoverConversation(conversationId, true),
    close,
  };
}

export function providerStopPendingError(input: { providerThreadId: string; providerTurnId: string; stopCommandId: string; requestedAt: string; cause?: unknown }) {
  return {
    code: providerStopPendingCode,
    message: '正在确认上次运行已停止，确认后将自动继续',
    recoveryRequired: false,
    retryable: true,
    providerStopPending: true,
    providerOutcomeUnconfirmed: true,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    stopCommandId: input.stopCommandId,
    requestedAt: input.requestedAt,
    ...(input.cause ? { cause: input.cause } : {}),
  };
}

export function isProviderStopPendingTurn(turn: ZeusConversationTurnRecord): boolean {
  return isTerminalTurn(turn) && isProviderStopPendingError(parseError(turn.errorJson));
}

export function shouldPreserveProviderStopTerminalTurn(input: {
  turn: ZeusConversationTurnRecord;
  submissions: readonly ZeusConversationSubmissionRecord[];
}): boolean {
  if (!isTerminalTurn(input.turn) || !input.turn.providerTurnId) return false;
  if (isProviderStopPendingTurn(input.turn)) return true;
  const pendingSubmission = input.submissions.find(
    (submission) =>
      !submission.providerTurnId &&
      submission.status === 'paused' &&
      (submission.pausedReason === 'provider_stop_pending' || submission.pausedReason === 'recovery_required') &&
      submission.createdAt >= input.turn.createdAt,
  );
  if (!pendingSubmission) return false;
  return input.submissions.some((submission) => {
    const error = parseError(submission.errorJson);
    return submission.status === 'cancelled' && error.code === 'ZEUS_FORCED_QUIT_INTERRUPTED' && (submission.resolvedAt ?? submission.updatedAt) <= pendingSubmission.createdAt;
  });
}

function isProviderStopPendingError(error: Record<string, unknown>): boolean {
  return error.providerStopPending === true && error.providerOutcomeUnconfirmed !== false;
}

function isTerminalTurn(turn: ZeusConversationTurnRecord): boolean {
  return turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed';
}

function parseError(errorJson: string | null): Record<string, unknown> {
  if (!errorJson) return {};
  try {
    const parsed: unknown = JSON.parse(errorJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isTerminalRecoveryError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === 'ZEUS_CODEX_THREAD_IDENTITY_MISMATCH' ||
    code === 'ZEUS_PROVIDER_STOP_TURN_MISSING' ||
    code === 'ZEUS_NATIVE_PROVIDER_TURN_INVALID' ||
    code === 'ZEUS_PROVIDER_STOP_UNKNOWN_ACTIVE_TURN' ||
    code.includes('THREAD_NOT_FOUND') ||
    code.includes('NOT_FOUND') ||
    code.includes('ARCHIVED') ||
    /\b(?:thread|rollout)\b[\s\S]{0,80}\b(?:not found|does not exist|missing|archived)\b/iu.test(message)
  );
}

function wait(delayMs: number): Promise<void> {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
