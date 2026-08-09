import type { ZeusConversationMessageRecord, ZeusConversationSubmissionRecord } from '@zeus/storage';

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

/** 按客户端消息、提交记录和提供方轮次的稳定关联，找出同一条本地用户输入。 */
export function resolveNativeUserMessageSubmission(input: ResolveNativeUserMessageSubmissionInput): ResolvedNativeUserMessageSubmission {
  const providerClientId = nonEmptyString(input.providerClientId) ?? null;
  const existingClientId = nonEmptyString(input.existingMessage?.clientMessageId) ?? null;
  const existingClientMessageIds = input.existingClientMessageIds ?? new Set<string>();
  const providerClientIdIsAvailable = providerClientId !== null && !existingClientMessageIds.has(providerClientId);
  // 同一 Provider 项的重复事件沿用原绑定；新项优先使用未被其他消息占用的 Provider 客户端 ID。
  // 若 Provider 返回的 ID 已绑定到其他项，不把另一条 submission 错绑过来。
  const durableClientId = existingClientId ?? (providerClientIdIsAvailable ? providerClientId : null);
  const submission = durableClientId
    ? input.submissions.find((entry) => entry.clientMessageId === durableClientId)
    : providerClientId
      ? undefined
      : (input.submissions.find((entry) => entry.id === input.clientSubmissionId && !existingClientMessageIds.has(entry.clientMessageId)) ??
        input.submissions.find((entry) => entry.providerTurnId === input.providerTurnId && !existingClientMessageIds.has(entry.clientMessageId)));

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
