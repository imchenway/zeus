import type { ConversationTranscriptEnvelope } from './conversationTranscriptWire.js';

/** Zeus 系统消息只描述产品行为，不属于模型输入或输出。 */
export interface ConversationSystemMessageInput {
  /** 客户端首次记录时生成；重连、草稿迁移和恢复沿用同一身份。 */
  id: string;
  /** 产生提示的操作种类，不接受任意可执行指令。 */
  operation: 'navigation' | 'navigation_body' | 'input_resource' | 'message_send' | 'conversation_start' | 'model_capabilities' | 'browser_close' | 'input_validation';
  /** 可操作的简短说明。 */
  summary: string;
  /** 经脱敏的原始诊断，仅在详情中展示。 */
  detail: string;
  /** 首次发生时间，后续状态更新不得覆盖。 */
  occurredAt: string;
  /** 已恢复时保留时间；空值不能覆盖已有恢复事实。 */
  recoveredAt: string | null;
  /** 明确关联的持久消息身份；缺失时按首次写入位置显示。 */
  relatedEntryId: string | null;
  /** 导航重试的目标本地轮次，不用于创建轮次。 */
  targetTurnId: string | null;
}

/** 已经由 Core 持久接纳的系统消息。 */
export interface ConversationSystemMessage extends ConversationSystemMessageInput {
  /** 真实产品会话身份。 */
  conversationId: string;
  /** 原消息及状态更新共享的持久位置。 */
  transcript: ConversationTranscriptEnvelope;
}

/** 系统消息使用独立有界历史页，不混入模型历史。 */
export interface ConversationSystemMessagePage {
  /** 当前页所属会话。 */
  conversationId: string;
  /** 按持久位置升序显示的系统消息。 */
  items: ConversationSystemMessage[];
  /** 更早页的稳定消息身份，空值表示已读完。 */
  nextCursor: string | null;
}

/** 在公开写入边界拒绝无效身份、过长诊断和未知操作。 */
export function parseConversationSystemMessage(value: unknown): ConversationSystemMessageInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('系统消息格式无效。');
  const input = value as Record<string, unknown>;
  const keys = ['id', 'operation', 'summary', 'detail', 'occurredAt', 'recoveredAt', 'relatedEntryId', 'targetTurnId'];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error('系统消息包含未知字段。');
  for (const [key, limit] of [
    ['id', 160],
    ['summary', 500],
    ['detail', 8000],
  ] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > limit) throw new Error('系统消息内容或身份无效。');
  }
  if (!/^zeus-system-[a-zA-Z0-9-]+$/.test(input.id as string)) throw new Error('系统消息身份无效。');
  if (!['navigation', 'navigation_body', 'input_resource', 'message_send', 'conversation_start', 'model_capabilities', 'browser_close', 'input_validation'].includes(String(input.operation))) throw new Error('系统消息操作无效。');
  for (const key of ['occurredAt', 'recoveredAt'] as const) {
    if (key === 'recoveredAt' && input[key] === null) continue;
    if (typeof input[key] !== 'string' || !Number.isFinite(Date.parse(input[key])) || new Date(input[key]).toISOString() !== input[key]) throw new Error('系统消息时间无效。');
  }
  for (const key of ['relatedEntryId', 'targetTurnId'] as const) {
    if (input[key] !== null && (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 256)) throw new Error('系统消息关联身份无效。');
  }
  return input as unknown as ConversationSystemMessageInput;
}
