import {
  type ConversationRepository,
  type ConversationServerRequestRepository,
  type ConversationTurnRepository,
  type ZeusConversationServerRequestRecord,
  type ZeusConversationWithMessagesRecord,
} from '@zeus/storage';
import { nativePendingRequestProjection, isRecord, parseJsonRecord, requireString } from './codexNativeConversationPolicy.js';
import { validateCanonicalRequestUserInputAnswers } from './codexNativeRuiValidation.js';
import { recoverRequestUserInputAnswersFromCodexRollout, type CodexRolloutRequestUserInputRecovery } from './codexRolloutRequestUserInput.js';

export interface CodexExternalRequestAnswerRecoveryOptions {
  conversations: ConversationRepository;
  requests: ConversationServerRequestRepository;
  turns: ConversationTurnRepository;
  now(): string;
  persist(): Promise<void>;
  broadcast(type: string, payload: Record<string, unknown>): void;
  enqueueBarrier<T>(work: () => Promise<T>): Promise<T>;
  isClosed(): boolean;
}

export interface CodexExternalRequestAnswerRecovery {
  recover(
    conversation: ZeusConversationWithMessagesRecord,
    request: ZeusConversationServerRequestRecord,
    resolvedAt: string,
  ): Promise<{ request: ZeusConversationServerRequestRecord; recovery: CodexRolloutRequestUserInputRecovery }>;
  recoverAll(conversation: ZeusConversationWithMessagesRecord, providerTurnId?: string): Promise<number>;
  schedule(conversationId: string, requestId: string, attempt?: number): void;
  close(): void;
}

const retryDelaysMs = [200, 800, 4_000] as const;

export function createCodexExternalRequestAnswerRecovery(options: CodexExternalRequestAnswerRecoveryOptions): CodexExternalRequestAnswerRecovery {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearTimer(requestId: string): void {
    const timer = timers.get(requestId);
    if (timer) clearTimeout(timer);
    timers.delete(requestId);
  }

  function hasExternalResolution(request: ZeusConversationServerRequestRecord): boolean {
    if (request.status !== 'resolved' || !request.responseJson) return false;
    try {
      const response = JSON.parse(request.responseJson) as unknown;
      return isRecord(response) && response.type === 'external_resolution';
    } catch {
      return false;
    }
  }

  async function recover(
    conversation: ZeusConversationWithMessagesRecord,
    request: ZeusConversationServerRequestRecord,
    resolvedAt: string,
  ): Promise<{ request: ZeusConversationServerRequestRecord; recovery: CodexRolloutRequestUserInputRecovery }> {
    const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
    const recovery = await recoverRequestUserInputAnswersFromCodexRollout({
      rolloutPath: conversation.nativeSessionPath,
      providerThreadId: requireString(conversation.providerThreadId, 'provider thread id'),
      providerTurnId: turn?.providerTurnId ?? null,
      providerItemId: request.itemId,
      requestPayload: parseJsonRecord(request.payloadJson),
    });
    if (recovery.status !== 'found') return { request, recovery };
    const validationError = validateCanonicalRequestUserInputAnswers(parseJsonRecord(request.payloadJson), recovery.answers);
    if (validationError) return { request, recovery: { status: 'invalid', reason: 'answer_output_invalid' } };
    return {
      request: options.requests.resolve(request.id, {
        response: { type: 'request_user_input', answers: recovery.answers },
        isSecret: request.containsSecret,
        questionIds: Object.keys(recovery.answers),
        answerCount: Object.values(recovery.answers).reduce((total, answer) => total + answer.answers.length, 0),
        resolvedAt: recovery.occurredAt ?? resolvedAt,
      }),
      recovery,
    };
  }

  async function recoverAll(conversation: ZeusConversationWithMessagesRecord, providerTurnId?: string): Promise<number> {
    let recoveredCount = 0;
    for (const request of options.requests.listByConversation(conversation.id)) {
      if (request.requestKind !== 'request_user_input' || !hasExternalResolution(request)) continue;
      const turn = request.turnId ? options.turns.getById(request.turnId) : undefined;
      if (providerTurnId && turn?.providerTurnId !== providerTurnId) continue;
      const recovered = await recover(conversation, request, request.resolvedAt ?? options.now());
      if (recovered.recovery.status !== 'found') continue;
      clearTimer(request.id);
      recoveredCount += 1;
      options.broadcast('conversation.request.resolved', {
        conversationId: conversation.id,
        requestId: request.id,
        requestKind: request.requestKind,
        resolvedBy: 'provider_rollout',
        answerAvailability: 'complete',
        request: nativePendingRequestProjection(recovered.request),
      });
    }
    return recoveredCount;
  }

  function schedule(conversationId: string, requestId: string, attempt = 0): void {
    if (options.isClosed() || attempt >= retryDelaysMs.length) return;
    clearTimer(requestId);
    const timer = setTimeout(() => {
      timers.delete(requestId);
      void options
        .enqueueBarrier(async () => {
          if (options.isClosed()) return;
          const request = options.requests.getById(requestId);
          const conversation = options.conversations.getById(conversationId);
          if (!request || !conversation || request.requestKind !== 'request_user_input' || !hasExternalResolution(request)) return;
          const recovered = await recover(conversation, request, request.resolvedAt ?? options.now());
          if (recovered.recovery.status === 'found') {
            clearTimer(requestId);
            await options.persist();
            options.broadcast('conversation.request.resolved', {
              conversationId,
              requestId,
              requestKind: request.requestKind,
              resolvedBy: 'provider_rollout_retry',
              answerAvailability: 'complete',
              request: nativePendingRequestProjection(recovered.request),
            });
            return;
          }
          if (recovered.recovery.reason === 'answer_output_missing') schedule(conversationId, requestId, attempt + 1);
        })
        .catch((error) => {
          options.broadcast('codex.native.error', {
            conversationId,
            requestId,
            error: 'ZEUS_CODEX_EXTERNAL_ANSWER_RECOVERY_FAILED',
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }, retryDelaysMs[attempt]);
    timers.set(requestId, timer);
  }

  return {
    recover,
    recoverAll,
    schedule,
    close() {
      for (const requestId of [...timers.keys()]) clearTimer(requestId);
    },
  };
}
