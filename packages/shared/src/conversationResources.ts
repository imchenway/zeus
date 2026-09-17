import type { FileReview } from './filePreview.js';

export type ConversationResourceKind = 'file' | 'website' | 'attachment';
export type ConversationResourcePresentation = 'inline' | 'card';
export type ConversationResourceDelivery = 'assistant';

export interface ConversationFileLocation {
  line?: number;
  column?: number;
  endLine?: number;
}

/** 只解析引用中的位置，不授予路径访问权限；支持常用冒号与锚点写法。 */
export function conversationFileLocationFromReference(reference: string): ConversationFileLocation | undefined {
  /** 百分号编码的路径也可能包含行号后缀，解码失败则保留原文。 */
  let decoded = reference;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    /* 非法编码不影响其他已授权链接。 */
  }
  /** 锚点、带 L 的行号和行列定位分别保留原始含义。 */
  const match = /(?:#L|:L)(\d+)(?:-L?(\d+))?$/iu.exec(decoded) ?? /:(\d+)(?::(\d+))?$/u.exec(decoded);
  if (!match) return undefined;
  /** 非安全整数不进入编辑器，范围终点不能早于起点。 */
  const line = Number(match[1]);
  const extra = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(line) || line < 1 || (extra !== undefined && (!Number.isSafeInteger(extra) || extra < 1))) return undefined;
  return { line, ...(extra === undefined ? {} : /[Ll]/u.test(match[0]) ? (extra >= line ? { endLine: extra } : {}) : { column: extra }) };
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

export type ConversationOpenTarget =
  | 'preferred'
  | 'zeus_source'
  | 'zeus_browser'
  | 'system_default'
  | 'file_manager'
  | 'copy_link'
  | 'copy_path'
  | 'editor:vscode'
  | 'editor:vscode-insiders'
  | 'editor:cursor'
  | 'editor:windsurf'
  | 'terminal:terminal'
  | 'terminal:ghostty';

export interface ConversationResourceOpenTarget {
  id: ConversationOpenTarget;
  label: string;
  available: boolean;
  exactLocation: boolean;
  /** 宿主读取的本机应用图标，仅用于打开方式菜单。 */
  iconDataUrl?: string;
  reason?: string;
}

export interface ConversationSourcePreview {
  /** 当前文件的 Git 审阅状态。 */
  review?: FileReview;
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
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/avif' | 'image/bmp' | 'image/x-icon' | 'image/svg+xml';
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
  /** 实时同步只传 summary；完整 diff 由现有按需读取接口返回。 */
  contentProjection?: 'summary' | 'full';
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

/** 会话审阅与主进程共用文本后缀范围，正文读取仍校验授权、编码和大小。 */
export function isConversationSourcePreviewable(path: string): boolean {
  return /\.(?:c|cc|cpp|css|go|h|hpp|html|java|js|json|jsx|kt|md|markdown|mdx|php|py|rb|rs|scss|sh|sql|swift|ts|tsx|txt|xml|yaml|yml)$/iu.test(path);
}
