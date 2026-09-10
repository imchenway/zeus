import type { ZeusConversationMessageRecord, ZeusConversationSubmissionRecord } from '@zeus/storage';
import type { CreateCodexNativeConversationCoordinatorOptions } from './codexNativeConversationContracts.js';
import { isSteeringSubmission } from './codexNativeConversationPolicy.js';

/** 精确用户回显补交同分段续发的丢失回执，恢复原提交而不重发请求。 */
export function reconcileNativeUserMessageAcceptance(
  options: Pick<CreateCodexNativeConversationCoordinatorOptions, 'execution' | 'submissions' | 'turns' | 'commandDeliveries'>,
  message: ZeusConversationMessageRecord,
  providerClientId: string | null,
  observedAt: string,
): boolean {
  if (message.role !== 'user' || !providerClientId || message.clientMessageId !== providerClientId || !message.providerThreadId || !message.providerTurnId || !message.providerItemId) return false;
  /** 只恢复已写出但回执未知的普通续发；引导与分段切换保留各自接纳契约。 */
  const submission = options.submissions
    .listByConversation(message.conversationId)
    .find((entry) => entry.clientMessageId === providerClientId && entry.kind === 'message' && entry.status === 'paused' && entry.submissionOutcome === 'outcome_unknown');
  if (!submission || submission.providerTurnId || !submission.executionSnapshotId) return false;
  /** 本地分段、原生轮次、请求回执必须属于同一次已写出的发送。 */
  const segment = options.execution.currentSegment(message.conversationId);
  /** 原生轮次只能关联当前提交，不能挪用另一条消息的接纳。 */
  const turn = options.turns.getByProvider(message.providerThreadId, message.providerTurnId);
  /** 核对原派发尝试，恢复时不建立新的发送记录。 */
  const attempt = options.commandDeliveries.getByScope('submission', submission.id)?.attempts.at(-1);
  if (
    !segment ||
    segment.id !== submission.segmentId ||
    segment.runtimeKind !== 'codex' ||
    segment.nativeSessionId !== message.providerThreadId ||
    !turn ||
    turn.conversationId !== message.conversationId ||
    (turn.clientSubmissionId && turn.clientSubmissionId !== submission.id)
  )
    return false;
  if (
    attempt?.outcome !== 'outcome_unknown_after_write' ||
    attempt.destinationKind !== 'provider_turn' ||
    attempt.receipt?.providerId !== 'codex' ||
    attempt.receipt?.nativeSessionId !== message.providerThreadId ||
    (attempt.receipt.nativeTurnId && attempt.receipt.nativeTurnId !== message.providerTurnId)
  )
    return false;
  /** 原始提交与已保存消息提供完整正文和附件，不依赖有界历史预览。 */
  const input = JSON.parse(submission.inputJson) as Record<string, unknown>;
  /** 展示内容沿用已持久保存的完整附件等信息。 */
  const metadata = JSON.parse(message.metadataJson) as Record<string, unknown>;
  /** 模型原文与界面短文案分别保留。 */
  const text = typeof input.text === 'string' ? input.text : message.content;
  /** 送达确认不能把已经结束的工作重新标为执行中。 */
  const terminal = turn.status === 'completed' || turn.status === 'interrupted' || turn.status === 'failed';
  /** 失败或用户中断的轮次只补送达事实，后续消息继续遵循原有暂停规则。 */
  const blockedSubmissions =
    turn.status === 'failed' || turn.status === 'interrupted'
      ? options.submissions.listByConversation(message.conversationId).filter((entry) => entry.status === 'paused' && entry.pausedReason === 'blocked_by_head' && !entry.providerTurnId)
      : [];
  options.execution.acceptOnCurrentSegmentDurably(
    {
      conversationId: message.conversationId,
      submissionId: submission.id,
      segmentId: segment.id,
      providerTurnId: message.providerTurnId!,
      turnId: turn.id,
      userHistoryContent: {
        text,
        ...(text !== message.content ? { displayText: message.content } : {}),
        providerItemId: message.providerItemId,
        ...Object.fromEntries(['attachments', 'taskPushLayout', 'browserComments', 'conversationContext', 'questionAnswer'].filter((key) => metadata[key] !== undefined).map((key) => [key, metadata[key]])),
      },
      acceptedAt: observedAt,
    },
    () => {
      options.commandDeliveries.reconcileUnknownAsAcceptedInCurrentTransaction({
        outboxId: attempt.id,
        providerId: 'codex',
        providerGenerationId: attempt.receipt!.providerGenerationId,
        nativeSessionId: message.providerThreadId,
        nativeTurnId: message.providerTurnId,
        evidence: { source: 'provider_user_message', clientUserMessageId: providerClientId, providerItemId: message.providerItemId },
        occurredAt: observedAt,
      });
      // 恢复回执不能重开已经完成的轮次，也不能清掉真实失败状态。
      options.turns.upsert({ ...turn, clientSubmissionId: submission.id, ...(turn.errorJson ? { error: JSON.parse(turn.errorJson) } : {}) });
      options.submissions.updateStatus(submission.id, terminal ? (turn.status === 'failed' ? 'failed' : 'completed') : 'active', {
        providerTurnId: message.providerTurnId,
        updatedAt: observedAt,
        ...(terminal ? { resolvedAt: turn.completedAt ?? turn.updatedAt } : {}),
        ...(turn.status === 'failed' && turn.errorJson ? { error: JSON.parse(turn.errorJson) } : {}),
      });
      for (const blocked of blockedSubmissions) {
        options.submissions.updateStatus(blocked.id, 'paused', {
          pausedReason: turn.status === 'interrupted' ? 'interrupted' : 'recovery_required',
          updatedAt: observedAt,
          ...(turn.errorJson ? { error: JSON.parse(turn.errorJson) } : {}),
        });
      }
    },
  );
  return true;
}

export interface ResolveNativeUserMessageSubmissionInput {
  submissions: readonly ZeusConversationSubmissionRecord[];
  providerClientId?: string | null;
  clientSubmissionId?: string | null;
  providerTurnId?: string | null;
  existingMessage?: Pick<ZeusConversationMessageRecord, 'clientMessageId'>;
  existingClientMessageIds?: ReadonlySet<string>;
}

export interface ResolvedNativeUserMessageSubmission {
  clientMessageId: string | null;
  submission?: ZeusConversationSubmissionRecord;
}

export interface NativeUserMessageProjection extends ResolvedNativeUserMessageSubmission {
  content: string;
}

/** 按客户端消息、提交记录和提供方轮次的稳定关联，找出同一条本地用户输入。 */
export function resolveNativeUserMessageSubmission(input: ResolveNativeUserMessageSubmissionInput): ResolvedNativeUserMessageSubmission {
  const providerClientId = nonEmptyString(input.providerClientId) ?? null;
  const existingClientId = nonEmptyString(input.existingMessage?.clientMessageId) ?? null;
  const existingClientMessageIds = input.existingClientMessageIds ?? new Set<string>();
  // Provider 客户端消息编号是跨实时事件、历史回放和兼容项别名的稳定身份。
  // 即使另一个 Provider item 已经使用该编号，也必须继续沿用同一消息身份，不能降级成第二条远端消息。
  const durableClientId = existingClientId ?? providerClientId;
  const submission = durableClientId
    ? input.submissions.find((entry) => entry.clientMessageId === durableClientId)
    : providerClientId
      ? undefined
      : (input.submissions.find((entry) => entry.id === input.clientSubmissionId && !existingClientMessageIds.has(entry.clientMessageId)) ??
        input.submissions.find((entry) => entry.providerTurnId === input.providerTurnId && !isSteeringSubmission(entry) && !existingClientMessageIds.has(entry.clientMessageId)));

  return {
    clientMessageId: durableClientId ?? submission?.clientMessageId ?? null,
    ...(submission ? { submission } : {}),
  };
}

export interface ChooseNativeUserMessageContentInput {
  /** 提供方或当前事件明确给出的展示短文案。 */
  displayText?: unknown;
  /** 提交记录中明确保存的展示短文案。 */
  submissionDisplayText?: unknown;
  /** 精确匹配的本地提交正文；空字符串也代表有效输入，例如仅有附件的消息。 */
  submissionText?: string;
  /** 同一提供方消息已经保存过的非空正文。 */
  existingContent?: string;
  /** 没有关联本地提交时，才使用提供方事件正文。 */
  providerContent: string;
}

/** 统一决定用户消息的可见正文，避免空的提供方回放覆盖本地完整输入。 */
export function chooseNativeUserMessageContent(input: ChooseNativeUserMessageContentInput): string {
  const displayText = nonEmptyString(input.displayText) ?? nonEmptyString(input.submissionDisplayText);
  if (displayText) return displayText;
  if (input.submissionText !== undefined) return input.submissionText;
  if (input.existingContent?.trim()) return input.existingContent;
  return input.providerContent;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
