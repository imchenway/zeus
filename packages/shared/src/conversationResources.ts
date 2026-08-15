export type ConversationResourceKind = 'file' | 'website' | 'attachment';
export type ConversationResourcePresentation = 'inline' | 'card';
export type ConversationResourceDelivery = 'assistant';

export interface ConversationFileLocation {
  line?: number;
  column?: number;
  endLine?: number;
}

export type ConversationFileIconKind = 'code' | 'java' | 'javascript' | 'typescript' | 'json' | 'markdown' | 'sql' | 'html' | 'css' | 'image' | 'pdf' | 'spreadsheet' | 'presentation' | 'document' | 'archive' | 'file';

interface ConversationResourceBase {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  kind: ConversationResourceKind;
  presentation: ConversationResourcePresentation;
  /** 明确交给用户的助手产物；普通工具预览不得设置该字段。 */
  delivery?: ConversationResourceDelivery;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationFileResource extends ConversationResourceBase {
  kind: 'file';
  projectRelativePath: string;
  location?: ConversationFileLocation;
  mimeType?: string;
  iconKind: ConversationFileIconKind;
}

export interface ConversationWebsiteResource extends ConversationResourceBase {
  kind: 'website';
  url: string;
  domain: string;
  title?: string;
  local: boolean;
}

export interface ConversationAttachmentResource extends ConversationResourceBase {
  kind: 'attachment';
  attachmentRef: string;
  mimeType?: string;
  previewKind: 'image' | 'document' | 'none';
  iconKind: ConversationFileIconKind;
  taskPushAttachmentKey?: string;
}

export type ConversationResource = ConversationFileResource | ConversationWebsiteResource | ConversationAttachmentResource;

export type ConversationOpenTarget = 'preferred' | 'zeus_source' | 'zeus_browser' | 'system_default' | 'file_manager' | 'copy_link' | 'copy_path' | 'editor:vscode' | 'editor:vscode-insiders' | 'editor:cursor' | 'editor:windsurf';

export interface ConversationResourceOpenTarget {
  id: ConversationOpenTarget;
  label: string;
  available: boolean;
  exactLocation: boolean;
  reason?: string;
}

export interface ConversationSourcePreview {
  kind: 'source';
  resource: ConversationFileResource | ConversationAttachmentResource;
  language: string | null;
  content: string;
  lineCount: number;
  truncated: boolean;
  location?: ConversationFileLocation;
}

export interface ConversationImagePreview {
  kind: 'image';
  resource: ConversationFileResource | ConversationAttachmentResource;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif' | 'image/bmp' | 'image/x-icon';
  dataUrl: string;
  byteLength: number;
}

export type ConversationResourcePreview = ConversationSourcePreview | ConversationImagePreview;

export type TurnChangeSetState = 'capturing' | 'applied' | 'undoing' | 'undone' | 'reapplying' | 'conflicted' | 'unavailable';

export const historicalTurnChangeUnavailableReason = 'Historical file-change records are available, but safe Undo/Reapply snapshots were not captured.';

export type TurnChangeFileType = 'added' | 'deleted' | 'modified' | 'renamed' | 'binary';

export interface TurnChangeFile {
  id: string;
  oldPath: string | null;
  newPath: string | null;
  changeType: TurnChangeFileType;
  addedLines: number;
  deletedLines: number;
  unifiedDiff: string;
  preHash: string | null;
  postHash: string | null;
  reversible: boolean;
  unavailableReason: string | null;
}

export interface TurnChangeConflict {
  code: string;
  message: string;
  paths: string[];
}

export interface TurnChangeSet {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  providerTurnId: string;
  state: TurnChangeSetState;
  files: TurnChangeFile[];
  unifiedDiff: string;
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  preImageDigest: string | null;
  postImageDigest: string | null;
  unavailableReason: string | null;
  conflict: TurnChangeConflict | null;
  createdAt: string;
  updatedAt: string;
}

export interface TurnChangeSetOperationRequest {
  changeSetId: string;
  expectedState: 'applied' | 'undone';
  idempotencyKey: string;
}

export interface TurnChangeSetOperationResult {
  changeSet: TurnChangeSet;
  auditEventId: string | null;
}
