import type { ConversationRepository, ConversationSubmissionRepository, ZeusConversationSubmissionRecord, ZeusDatabase } from '@zeus/storage';
import type { ConversationDispatchContext } from './codexNativeConversationContracts.js';
import { isRecord, parseJsonRecord } from './codexNativeConversationPolicy.js';

type ServiceTierDowngradeReason = 'model_unsupported' | 'app_server_rejected' | 'provider_reported_standard';

export function createCodexServiceTierDowngrade(options: {
  db: ZeusDatabase;
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  broadcast: (event: string, payload: Record<string, unknown>) => void;
  now: () => string;
  contextFromSubmission: (submission: ZeusConversationSubmissionRecord) => ConversationDispatchContext;
  conversationMessageClientId: (message: { clientMessageId: string | null; metadataJson: string }) => string | null;
}) {
  function persistNotice(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, reason: ServiceTierDowngradeReason, actualServiceTier: string | null): void {
    const providerItemId = `zeus-service-tier-downgrade:${submission.id}:${reason}`;
    const conversation = options.conversations.getById(conversationId);
    if (conversation?.messages.some((message) => message.providerItemId === providerItemId)) return;
    const reasonLabel = reason === 'model_unsupported' ? '模型目录未声明 priority 能力' : reason === 'app_server_rejected' ? 'app-server 明确拒绝 priority 服务档位' : 'Provider 接受请求后实际采用 Standard';
    const actualTierLabel = actualServiceTier === 'default' ? 'Standard（default）' : actualServiceTier ? actualServiceTier : 'Standard（null）';
    const content = `服务档位已降级。模型：${context.model}；请求档位：Fast（priority）；实际档位：${actualTierLabel}；原因：${reasonLabel}。会话继续执行，模型和推理强度保持不变。`;
    const metadata = {
      kind: 'service_tier_downgrade',
      requestedServiceTier: 'priority',
      dispatchedServiceTier: context.serviceTier ?? null,
      actualServiceTier,
      reason,
      model: context.model,
      modelSourceId: context.modelSourceId,
      submissionId: submission.id,
    };
    const triggeringUserMessage = conversation?.messages.find((message) => message.role === 'user' && options.conversationMessageClientId(message) === submission.clientMessageId);
    const currentTimestamp = options.now();
    const userTimestamp = triggeringUserMessage ? Date.parse(triggeringUserMessage.createdAt) : Number.NaN;
    const currentTime = Date.parse(currentTimestamp);
    const createdAt = Number.isFinite(userTimestamp) && (!Number.isFinite(currentTime) || currentTime <= userTimestamp) ? new Date(userTimestamp + 1).toISOString() : currentTimestamp;
    options.conversations.appendMessage({
      conversationId,
      role: 'system',
      content,
      source: 'zeus_service_tier',
      metadata,
      createdAt,
      ...(conversation?.providerThreadId ? { providerThreadId: conversation.providerThreadId } : {}),
      providerItemId,
      clientMessageId: submission.clientMessageId,
    });
    if (!conversation?.providerThreadId) return;
    options.broadcast('conversation.item.updated', {
      conversationId,
      providerThreadId: conversation.providerThreadId,
      providerTurnId: `message:${submission.id}`,
      providerItemId,
      itemType: 'serviceTierNotice',
      itemPayload: metadata,
      textContent: content,
      status: 'completed',
      phase: 'prework',
      itemResources: [],
    });
  }

  function record(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, reason: ServiceTierDowngradeReason, actualServiceTier: string | null = null): void {
    const current = options.submissions.getById(submission.id) ?? submission;
    const input = parseJsonRecord(current.inputJson);
    const marker = isRecord(input.serviceTierDowngrade) ? input.serviceTierDowngrade : null;
    if (marker?.reason !== reason || marker.actualServiceTier !== actualServiceTier) {
      options.db.execute(`UPDATE conversation_submissions SET input_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ ...input, serviceTierDowngrade: { reason, actualServiceTier } }), options.now(), current.id]);
    }
    persistNotice(conversationId, current, context, reason, actualServiceTier);
  }

  function persistSubmissionDispatchContext(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext): void {
    const current = options.submissions.getById(submission.id) ?? submission;
    const input = parseJsonRecord(current.inputJson);
    options.db.execute(`UPDATE conversation_submissions SET input_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ ...input, context }), options.now(), current.id]);
  }

  function flushNotice(submission: ZeusConversationSubmissionRecord | undefined): void {
    if (!submission) return;
    const current = options.submissions.getById(submission.id) ?? submission;
    const marker = parseJsonRecord(current.inputJson).serviceTierDowngrade;
    if (!isRecord(marker) || (marker.reason !== 'model_unsupported' && marker.reason !== 'app_server_rejected' && marker.reason !== 'provider_reported_standard')) return;
    const actualServiceTier = marker.actualServiceTier === null || typeof marker.actualServiceTier === 'string' ? marker.actualServiceTier : null;
    persistNotice(current.conversationId, current, options.contextFromSubmission(current), marker.reason, actualServiceTier);
  }

  function persistProviderReported(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, actualServiceTier: string | null): void {
    const persistedInput = parseJsonRecord(submission.inputJson);
    if (persistedInput.requestedServiceTier !== 'priority' || context.serviceTier !== 'priority') return;
    if (actualServiceTier !== null && actualServiceTier !== 'default') return;
    record(conversationId, submission, context, 'provider_reported_standard', actualServiceTier);
  }

  return { flushNotice, persistProviderReported, persistSubmissionDispatchContext, record };
}

export function isServiceTierUnavailableError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 'ZEUS_CODEX_SERVICE_TIER_UNAVAILABLE') return true;
  const code = error.code;
  if (code !== -32602 && code !== -32000 && code !== 'INVALID_PARAMS' && code !== 'UNSUPPORTED_CONFIG') return false;
  const evidence = `${error instanceof Error ? error.message : ''} ${safeErrorDataText(error.data)}`.toLowerCase();
  return /service[ _-]?tier/u.test(evidence) && /priority|unsupported|unavailable|invalid/u.test(evidence);
}

function safeErrorDataText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
