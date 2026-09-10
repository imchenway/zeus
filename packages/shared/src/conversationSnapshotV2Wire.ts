/** Snapshot V2 的服务端、桌面端与存储层共用协议代次。 */
export const conversationSnapshotV2StructureGeneration = '2026-09-03-conversation-stage-identity' as const;

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
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  limits: { entryLimit: number; byteLimit: number; returnedItems: number; responseBytes: number };
}

/** 全历史用户发言目录；仅携带定位身份与短摘录，不代替正文或消息送达凭据。 */
export interface ConversationNavigationEntry {
  /** 持久历史消息身份。 */
  id: string;
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
  /** 最多 320 字的最终答复或正式计划摘录。 */
  response: string;
  /** 所属轮次的真实状态。 */
  status: string;
}

/** 完整目录的只读结果；事件进度只用于判断新旧，不能推进实时同步游标。 */
export interface ConversationNavigationSnapshot {
  /** 当前目录所属会话。 */
  conversationId: string;
  /** 同步读取目录时的事件进度。 */
  throughEventSeq: number;
  /** 按发言顺序排列的完整目录。 */
  entries: ConversationNavigationEntry[];
}

/** 摘录按字符截断，避免拆开表情；只合并空白，不执行 Markdown 或 HTML。 */
export function conversationNavigationExcerpt(text: string, limit: number): string {
  /** 只保留界面可读的单段文本。 */
  const characters = Array.from(text.replace(/\s+/gu, ' ').trim());
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : characters.join('');
}
