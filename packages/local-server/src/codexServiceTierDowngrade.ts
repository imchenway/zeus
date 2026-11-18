import type { ConversationRepository, ConversationSubmissionRepository, ZeusConversationSubmissionRecord, ZeusDatabase } from '@zeus/storage';
import { isCodexServiceTierId, normalizeCodexPricingServiceTier, type CodexServiceTierId } from '@zeus/shared';
import type { ConversationDispatchContext } from './codexNativeConversationContracts.js';
import { isRecord, parseJsonRecord } from './codexNativeConversationPolicy.js';

/** 记录档位在目录校验、请求提交或 Provider 执行时发生降级的原因。 */
type ServiceTierDowngradeReason = 'model_unsupported' | 'app_server_rejected' | 'provider_reported_standard' | 'provider_reported_fast';

/** 记录会话选中的速度与实际派发或执行速度之间的差异。 */
export function createCodexServiceTierDowngrade(options: {
  db: ZeusDatabase;
  conversations: ConversationRepository;
  submissions: ConversationSubmissionRepository;
  broadcast: (event: string, payload: Record<string, unknown>) => void;
  now: () => string;
  contextFromSubmission: (submission: ZeusConversationSubmissionRecord) => ConversationDispatchContext;
  conversationMessageClientId: (message: { clientMessageId: string | null; metadataJson: string }) => string | null;
}) {
  /** 按提交记录原档位和实际档位，恢复时复用同一条系统消息。 */
  function persistNotice(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, reason: ServiceTierDowngradeReason, actualServiceTier: string | null): void {
    const providerItemId = `zeus-service-tier-downgrade:${submission.id}:${reason}`;
    const conversation = options.conversations.getById(conversationId);
    if (conversation?.messages.some((message) => message.providerItemId === providerItemId)) return;
    /** 早期的降级记录只用于 Fast，部分记录未保存原档位。 */
    const savedTier = parseJsonRecord(submission.inputJson).requestedServiceTier;
    const requestedServiceTier = isCodexServiceTierId(savedTier) ? savedTier : 'priority';
    /** 系统消息同时显示可读名称和 Provider 档位 ID。 */
    const requestedTierLabel = formatServiceTier(requestedServiceTier);
    /** 区分模型目录校验、app-server 拒绝和 Provider 实际执行。 */
    const reasonLabel = reason === 'model_unsupported' ? `模型目录未声明 ${requestedServiceTier} 能力` : reason === 'app_server_rejected' ? `app-server 明确拒绝 ${requestedServiceTier} 服务档位` : 'Provider 采用了较低的服务档位';
    /** 实际档位来自请求结果，空值表示显式使用标准速度。 */
    const actualTierLabel = formatServiceTier(actualServiceTier);
    const content = `服务档位已降级。模型：${context.model}；请求档位：${requestedTierLabel}；实际档位：${actualTierLabel}；原因：${reasonLabel}。会话继续执行，模型和推理强度保持不变。`;
    const metadata = {
      kind: 'service_tier_downgrade',
      requestedServiceTier,
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

  /** 保存重试上下文时保留被拒绝的加速档位，供后续提示使用。 */
  function persistSubmissionDispatchContext(submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, rejectedServiceTier: CodexServiceTierId): void {
    const current = options.submissions.getById(submission.id) ?? submission;
    const input = parseJsonRecord(current.inputJson);
    options.db.execute(`UPDATE conversation_submissions SET input_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify({ ...input, context, requestedServiceTier: rejectedServiceTier }), options.now(), current.id]);
  }

  function flushNotice(submission: ZeusConversationSubmissionRecord | undefined): void {
    if (!submission) return;
    const current = options.submissions.getById(submission.id) ?? submission;
    const marker = parseJsonRecord(current.inputJson).serviceTierDowngrade;
    if (!isRecord(marker) || (marker.reason !== 'model_unsupported' && marker.reason !== 'app_server_rejected' && marker.reason !== 'provider_reported_standard' && marker.reason !== 'provider_reported_fast')) return;
    const actualServiceTier = marker.actualServiceTier === null || typeof marker.actualServiceTier === 'string' ? marker.actualServiceTier : null;
    persistNotice(current.conversationId, current, options.contextFromSubmission(current), marker.reason, actualServiceTier);
  }

  /** 仅当 Provider 回报了已知的较低档位时记录本次降级。 */
  function persistProviderReported(conversationId: string, submission: ZeusConversationSubmissionRecord, context: ConversationDispatchContext, actualServiceTier: string | null): void {
    /** 提交记录明确选择的档位必须和发送档位一致。 */
    const requestedServiceTier = parseJsonRecord(submission.inputJson).requestedServiceTier;
    if (!isCodexServiceTierId(requestedServiceTier) || context.serviceTier !== requestedServiceTier) return;
    if (normalizeCodexPricingServiceTier(actualServiceTier) === 'default' && normalizeCodexPricingServiceTier(requestedServiceTier) !== 'default') {
      record(conversationId, submission, context, 'provider_reported_standard', actualServiceTier);
    } else if (requestedServiceTier === 'ultrafast' && (actualServiceTier === 'priority' || actualServiceTier === 'fast')) {
      record(conversationId, submission, context, 'provider_reported_fast', actualServiceTier);
    }
  }

  return { flushNotice, persistProviderReported, persistSubmissionDispatchContext, record };
}

/** 旧档位保留既有名称，其他档位显示实际 ID。 */
function formatServiceTier(id: string | null): string {
  const tier = normalizeCodexPricingServiceTier(id);
  const label = tier === 'default' ? 'Standard' : tier === 'priority' ? 'Fast' : tier === 'ultrafast' ? '超快' : null;
  return label ? `${label}（${id ?? 'null'}）` : tier;
}

/** 只在错误明确指向服务档位时按标准速度重试。 */
export function isServiceTierUnavailableError(error: unknown, requestedServiceTier: CodexServiceTierId): boolean {
  if (!isRecord(error)) return false;
  if (error.code === 'ZEUS_CODEX_SERVICE_TIER_UNAVAILABLE') return true;
  const code = error.code;
  if (code !== -32602 && code !== -32000 && code !== 'INVALID_PARAMS' && code !== 'UNSUPPORTED_CONFIG') return false;
  const evidence = `${error instanceof Error ? error.message : ''} ${safeErrorDataText(error.data)}`.toLowerCase();
  return /service[ _-]?tier/u.test(evidence) && (/unsupported|unavailable|invalid/u.test(evidence) || evidence.includes(requestedServiceTier.toLowerCase()));
}

function safeErrorDataText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
