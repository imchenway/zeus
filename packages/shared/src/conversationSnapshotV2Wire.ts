import { parseCanonicalRequestUserInputQuestions } from './requestUserInput.js';
import type { ConversationTranscriptEnvelope, ConversationTranscriptPlacement } from './conversationTranscriptWire.js';

/** Snapshot V2 的服务端、桌面端与存储层共用协议代次。 */
export const conversationSnapshotV2StructureGeneration = '2026-09-16-transcript-placement' as const;

export type ConversationSnapshotV2PageKind = 'timeline' | 'model_history' | 'process' | 'commands' | 'resources' | 'change_files';

export interface ConversationSnapshotV2BoundedContent {
  preview: string;
  byteLength: number;
  truncated: boolean;
  redacted: boolean;
  contentHandle: string | null;
  refreshRequired: boolean;
}

export interface ConversationSnapshotV2ToolResult {
  handle: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  projection: string;
  projectionTruncated: boolean;
  redacted: boolean;
}

export interface ConversationSnapshotV2Page<T> {
  schemaVersion: 2;
  structureGeneration: typeof conversationSnapshotV2StructureGeneration;
  conversationId: string;
  kind: ConversationSnapshotV2PageKind;
  throughEventSeq: number;
  throughSequence: number;
  /** 本页显示位置所属的持久代次。 */
  orderEpoch: number;
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  limits: { entryLimit: number; byteLimit: number; returnedItems: number; responseBytes: number };
}

/** 全历史用户发言目录；仅携带定位身份与短摘录，不代替正文或消息送达凭据。 */
export interface ConversationNavigationEntry {
  /** 持久历史消息身份。 */
  id: string;
  /** 已回答询问的稳定身份；普通发言不携带。 */
  requestId?: string;
  /** 所属本地轮次，用于按需读取正文。 */
  turnId: string;
  /** 实时消息使用的轮次身份。 */
  providerTurnId: string | null;
  /** 同一次发言从本地发送到模型确认期间保持不变的身份。 */
  clientUserMessageId: string | null;
  /** 模型消息身份，用于历史与实时投影去重。 */
  providerItemId: string | null;
  /** 持久历史中的顺序。 */
  sequence: number;
  /** 发言首次出现的时间，不随流式回复变化。 */
  occurredAt: string;
  /** 最多 160 字的提问摘录。 */
  prompt: string;
  /** 最多 320 字的最终答复、正式计划或答题卡答案摘录。 */
  response: string;
  /** 所属轮次的真实状态。 */
  status: string;
  /** 目录与正文共用的稳定显示位置。 */
  placement?: ConversationTranscriptPlacement;
}

/** 完整目录的只读结果；事件进度只用于判断新旧，不能推进实时同步游标。 */
export interface ConversationNavigationSnapshot {
  /** 当前目录所属会话。 */
  conversationId: string;
  /** 同步读取目录时的事件进度。 */
  throughEventSeq: number;
  /** 目录显示位置所属的持久代次。 */
  orderEpoch: number;
  /** 按发言顺序排列的完整目录。 */
  entries: ConversationNavigationEntry[];
}

/** 为 Snapshot V2 可见条目附加稳定位置和来源修订。 */
export interface ConversationSnapshotV2TranscriptItem {
  /** 条目当前持久位置和来源修订。 */
  transcript: ConversationTranscriptEnvelope;
}

/** 摘录按字符截断，避免拆开表情；只合并空白，不执行 Markdown 或 HTML。 */
export function conversationNavigationExcerpt(text: string, limit: number): string {
  /** 只保留界面可读的单段文本。 */
  const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('');
}

/** 整张答题卡共用一个摘录，实时与历史目录沿用相同的问题校验和敏感答案规则。 */
export function conversationQuestionNavigationExcerpt(payload: unknown, response: Record<string, unknown> | null, containsSecret = false): Pick<ConversationNavigationEntry, 'prompt' | 'response'> | null {
  /** 不根据正文猜测题目；无效题目不能生成无法定位的刻度。 */
  const parsed = parseCanonicalRequestUserInputQuestions(payload);
  if (!parsed.ok || !response) return null;
  /** 含敏感答案的记录只允许使用已经公开的回答。 */
  const visible = containsSecret ? response.publicAnswers : response.answers;
  /** 只读经过结构检查的答案映射。 */
  const answers = visible && typeof visible === 'object' && !Array.isArray(visible) ? (visible as Record<string, unknown>) : {};
  return {
    prompt: conversationNavigationExcerpt(parsed.questions.map((question) => question.question).join('；'), 160),
    response: conversationNavigationExcerpt(
      parsed.questions
        .map((question) => {
          if (question.isSecret) return '敏感回答已提交';
          if (response.type === 'external_resolution') return '答案尚未同步';
          /** 普通答案使用规范对象，敏感记录的公开答案使用字符串数组。 */
          const value = answers[question.id];
          /** 仅接受字符串数组，不序列化未知内容或附件路径。 */
          const values = containsSecret ? value : value && typeof value === 'object' && 'answers' in value ? value.answers : null;
          return Array.isArray(values) && values.length && values.every((answer) => typeof answer === 'string') ? values.join('、') : '回答已提交，历史内容已脱敏';
        })
        .join('；'),
      320,
    ),
  };
}
