import { createHash } from 'node:crypto';
import { ConversationExecutionRepository, ConversationServerRequestRepository, ConversationSubmissionRepository, type ZeusConversationSubmissionRecord } from '@zeus/storage';

/**
 * Queue 与 request 的纯 Core mutation。调用方负责把这些同步方法包在自己的 durable
 * transaction 中；本类不保存、不广播，也不触发 Provider 派发。
 */
export class ConversationQueueCoreMutationApplication {
  constructor(
    private readonly options: {
      submissions: ConversationSubmissionRepository;
      execution: ConversationExecutionRepository;
      requests: ConversationServerRequestRepository;
      now(): string;
      snapshot(conversationId: string): unknown;
    },
  ) {}

  update(input: { conversationId: string; submissionId: string; content: string }): unknown {
    const submission = this.requireOwnedSubmission(input.conversationId, input.submissionId);
    if (planControlModeForSubmission(submission)) throw mutationError('ZEUS_PLAN_CONTROL_SUBMISSION_IMMUTABLE', 'Plan control submissions cannot be edited.');
    if (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') {
      throw mutationError('ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE', 'Only queued, paused, or failed submissions can be edited.');
    }
    const persisted = parseJsonRecord(submission.inputJson);
    if (isRecord(persisted.taskPushLayout) || persisted.internalOperation === true || typeof persisted.requestAnswerId === 'string') {
      throw mutationError('ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE', 'Structured internal submissions cannot be edited as plain text.');
    }
    const persistedText = persisted.text;
    if (typeof persistedText !== 'string') throw mutationError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted submission text is invalid.');
    const previousText = persistedText.trim();
    const browserComments = Array.isArray(persisted.browserComments) ? persisted.browserComments : [];
    const conversationContext = isRecord(persisted.conversationContext) ? persisted.conversationContext : null;
    const hasStructuredSuffix = browserComments.length > 0 || Boolean(conversationContext);
    const previousComposerDraft = typeof persisted.composerDraft === 'string' ? persisted.composerDraft.trim() : null;
    const previousDisplayText = typeof persisted.displayText === 'string' ? persisted.displayText.trim() : null;
    const automaticStructuredSummary =
      browserComments.length > 0
        ? `Browser comments (${browserComments.length})`
        : conversationContext && Array.isArray(conversationContext.codeComments) && conversationContext.codeComments.length > 0
          ? `Code comments (${conversationContext.codeComments.length})`
          : conversationContext && Array.isArray(conversationContext.responseAnnotations)
            ? `Response annotations (${conversationContext.responseAnnotations.length})`
            : null;
    const previousDraft = previousComposerDraft ?? previousDisplayText;
    let preservedSuffix = '';
    if (previousDraft !== null) {
      if (!previousDraft) preservedSuffix = previousText;
      else if (previousText === previousDraft) preservedSuffix = '';
      else if (previousText.startsWith(`${previousDraft}\n\n`)) preservedSuffix = previousText.slice(previousDraft.length + 2);
      else if (previousComposerDraft === null && hasStructuredSuffix && previousDisplayText === automaticStructuredSummary) preservedSuffix = previousText;
      else throw mutationError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted submission text no longer matches its composer draft.');
    } else if (hasStructuredSuffix) {
      throw mutationError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Structured submission composer metadata is unavailable.');
    }
    const nextComposerDraft = input.content.trim();
    const nextProviderText = [nextComposerDraft, preservedSuffix].filter(Boolean).join('\n\n');
    const next = { ...persisted, text: nextProviderText, composerDraft: nextComposerDraft, displayText: nextComposerDraft };
    this.options.submissions.createReplacement(submission.id, { requestHash: requestHash(next), input: next, reason: 'edit', updatedAt: this.options.now() });
    return this.options.snapshot(input.conversationId);
  }

  delete(input: { conversationId: string; submissionId: string }): unknown {
    const submission = this.requireOwnedSubmission(input.conversationId, input.submissionId);
    if (planControlModeForSubmission(submission)) throw mutationError('ZEUS_PLAN_CONTROL_SUBMISSION_IMMUTABLE', 'Plan control submissions cannot be deleted.');
    if (submission.status !== 'queued' && submission.status !== 'paused' && submission.status !== 'failed') {
      throw mutationError('ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE', 'Only queued, paused, or failed submissions can be deleted.');
    }
    const queuedBeforeDelete = this.queueEntries(input.conversationId);
    const deletedAt = this.options.now();
    this.options.execution.cancelOpenSwitchForSubmission({ conversationId: input.conversationId, submissionId: submission.id, reason: 'submission_deleted', occurredAt: deletedAt });
    this.options.submissions.updateStatus(submission.id, 'deleted', { resolvedAt: deletedAt });
    if (queuedBeforeDelete[0]?.id === submission.id) this.options.execution.resumeQueueBlockedByHead(input.conversationId, deletedAt);
    this.options.submissions.reorderQueued(
      input.conversationId,
      this.queueEntries(input.conversationId).map((entry) => entry.id),
      deletedAt,
    );
    return this.options.snapshot(input.conversationId);
  }

  retry(input: { conversationId: string; submissionId: string }): unknown {
    const submission = this.requireOwnedSubmission(input.conversationId, input.submissionId);
    const queueHead = this.queueEntries(input.conversationId)[0];
    if (!queueHead || queueHead.id !== submission.id) throw mutationError('ZEUS_NATIVE_QUEUE_HEAD_REQUIRED', '只能重试暂停的队首提交。');
    if ((submission.status !== 'paused' && submission.status !== 'failed') || submission.providerTurnId) {
      throw mutationError('ZEUS_NATIVE_SUBMISSION_NOT_RETRYABLE', '只有 Provider 写入前失败且未产生 turn 的队首可以重试。');
    }
    if (submission.pausedReason === 'outcome_unknown' || submission.submissionOutcome === 'outcome_unknown') {
      throw mutationError('ZEUS_NATIVE_SUBMISSION_OUTCOME_UNKNOWN', '接纳结果未知的提交禁止重试，必须先完成恢复核对或取消。');
    }
    if (submission.pausedReason === 'semantic_route_changed' || submission.pausedReason === 'upgrade_interrupted' || !submission.executionSnapshotId) {
      throw mutationError('ZEUS_NATIVE_SUBMISSION_REROUTE_REQUIRED', '原执行路由已变化或不可恢复，请使用当前输入框模型创建改路由 replacement。');
    }
    const persisted = JSON.parse(submission.inputJson) as unknown;
    this.options.submissions.createReplacement(submission.id, { requestHash: requestHash(persisted), input: persisted, reason: 'retry', updatedAt: this.options.now() });
    return this.options.snapshot(input.conversationId);
  }

  reorder(input: { conversationId: string; orderedSubmissionIds: string[] }): unknown {
    const queueEntries = this.queueEntries(input.conversationId);
    const blockedHead = queueEntries[0];
    if (blockedHead && blockedHead.status !== 'queued' && input.orderedSubmissionIds[0] !== blockedHead.id) {
      throw mutationError('ZEUS_NATIVE_QUEUE_HEAD_BLOCKS_REORDER', '暂停或失败的队首必须先重试、改路由替换或取消，不能通过重排绕过。');
    }
    const controlIds = queueEntries.filter((submission) => planControlModeForSubmission(submission)).map((submission) => submission.id);
    if (controlIds.some((id, index) => input.orderedSubmissionIds[index] !== id)) {
      throw mutationError('ZEUS_PLAN_CONTROL_SUBMISSION_IMMUTABLE', 'Plan control submissions must remain ahead of ordinary queued messages.');
    }
    this.options.submissions.reorderQueued(input.conversationId, input.orderedSubmissionIds, this.options.now());
    return this.options.snapshot(input.conversationId);
  }

  snooze(input: { conversationId: string; requestId: string }): unknown {
    const request = this.options.requests.getById(input.requestId);
    if (!request || request.conversationId !== input.conversationId || request.requestKind !== 'request_user_input' || request.status !== 'pending') {
      throw mutationError('ZEUS_CODEX_SERVER_REQUEST_NOT_FOUND', 'Codex user input request is not pending.', 404);
    }
    this.options.requests.snooze(request.id);
    return { requestId: request.id };
  }

  private requireOwnedSubmission(conversationId: string, submissionId: string): ZeusConversationSubmissionRecord {
    const submission = this.options.submissions.getById(submissionId);
    if (!submission || submission.conversationId !== conversationId) throw mutationError('ZEUS_NATIVE_SUBMISSION_NOT_FOUND', 'Native submission was not found.', 404);
    return submission;
  }

  private queueEntries(conversationId: string): ZeusConversationSubmissionRecord[] {
    return this.options.submissions.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
  }
}

function planControlModeForSubmission(submission: ZeusConversationSubmissionRecord): 'default' | 'plan' | null {
  const origin = parseJsonRecord(submission.inputJson).origin;
  return origin === 'implement_plan' ? 'default' : origin === 'refine_plan' ? 'plan' : null;
}

function parseJsonRecord(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw mutationError('ZEUS_NATIVE_PERSISTED_STATE_INVALID', 'Persisted native conversation state is invalid.');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function mutationError(code: string, message: string, statusCode = 409): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}
