/** Snapshot V2 的服务端、桌面端与存储层共用协议代次。 */
export const conversationSnapshotV2StructureGeneration = '2026-09-01-conversation-snapshot-v2-turn-output-anchors' as const;

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
