/** 内置浏览器页面中的矩形；坐标均以当前 frame viewport 为参照。 */
export interface ZeusBrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type ZeusBrowserAnnotationKind = 'element' | 'text' | 'region';

export interface ZeusBrowserTextRange {
  text: string;
  startSelector?: string;
  startOffset?: number;
  endSelector?: string;
  endOffset?: number;
  direction?: 'forward' | 'backward';
  rects: ZeusBrowserRect[];
}

/**
 * 页面锚点同时保存语义、路径和几何信息。矩形只负责可视化，不能单独作为恢复依据。
 */
export interface ZeusBrowserPageAnchor {
  kind: ZeusBrowserAnnotationKind;
  pageUrl: string;
  frameUrl: string;
  pageTitle: string;
  selector?: string;
  elementPath?: string;
  shadowHostPath?: string[];
  frameDepth: number;
  role?: string;
  accessibleName?: string;
  tagName?: string;
  immediateText?: string;
  nearbyText?: string;
  rect: ZeusBrowserRect;
  /** 批注编号在锚点内的首选落点；页面移动时仍以语义锚点和 rect 差值恢复。 */
  marker?: { x: number; y: number };
  textRange?: ZeusBrowserTextRange;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  scroll: { x: number; y: number };
  fixed: boolean;
}

export interface ZeusBrowserStyleSource {
  selector?: string;
  sourceUrl?: string;
  line?: number;
  column?: number;
}

/** Adjust 只表达期望变化；它不是源码已经被修改的声明。 */
export interface ZeusBrowserDesignChange {
  kind: 'text' | 'style';
  selector?: string;
  property?: string;
  previous: string;
  next: string;
  source?: ZeusBrowserStyleSource;
}

export interface ZeusBrowserComment {
  id: string;
  number: number;
  conversationId: string;
  tabId: string;
  body: string;
  anchor: ZeusBrowserPageAnchor;
  designChanges: ZeusBrowserDesignChange[];
  screenshotPath?: string;
  status: 'draft' | 'sent';
  createdAt: string;
  updatedAt: string;
}

export interface ZeusBrowserTabSnapshot {
  id: string;
  conversationId: string;
  url: string;
  title: string;
  faviconUrl?: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
  annotationMode: boolean;
  comments: ZeusBrowserComment[];
  createdAt: string;
  updatedAt: string;
}

export type ZeusBrowserApprovalKind = 'site' | 'sensitive_action' | 'web_permission' | 'full_cdp';

export interface ZeusBrowserApprovalRequest {
  id: string;
  conversationId: string;
  tabId?: string;
  kind: ZeusBrowserApprovalKind;
  origin?: string;
  title: string;
  detail: string;
  tool?: string;
  createdAt: string;
}

export type ZeusBrowserScreenshotMode = 'always' | 'necessary';
export type ZeusWebLinkOpenTarget = 'zeus_browser' | 'system_default';
export type ZeusFileOpenTarget =
  | 'zeus_source'
  | 'system_default'
  | 'editor:vscode'
  | 'editor:vscode-insiders'
  | 'editor:cursor'
  | 'editor:windsurf';

export interface ZeusBrowserSettings {
  enabled: boolean;
  downloadDirectory: string;
  askWhereToSave: boolean;
  screenshotMode: ZeusBrowserScreenshotMode;
  fullCdpEnabled: boolean;
  allowAgentAllSites: boolean;
  webLinkOpenTarget: ZeusWebLinkOpenTarget;
  localWebOpenTarget: ZeusWebLinkOpenTarget;
  fileOpenTarget: ZeusFileOpenTarget;
}

export interface ZeusBrowserConversationSnapshot {
  conversationId: string;
  tabs: ZeusBrowserTabSnapshot[];
  activeTabId: string | null;
  pendingApprovals: ZeusBrowserApprovalRequest[];
}

export interface ZeusBrowserPreparedSubmission {
  tabId: string;
  commentIds: string[];
  content: string;
  comments: ZeusBrowserComment[];
  attachments: Array<{
    name: string;
    mime: 'image/png';
    size: number;
    localPath: string;
  }>;
}

export type ZeusBrowserCommand =
  | { action: 'navigate'; url: string }
  | { action: 'back' }
  | { action: 'forward' }
  | { action: 'reload' }
  | { action: 'stop' }
  | { action: 'set_annotation_mode'; enabled: boolean }
  | { action: 'clear_comments' }
  | { action: 'delete_comment'; commentId: string }
  | { action: 'focus_comment'; commentId: string };

export type ZeusBrowserApprovalDecision = 'allow_once' | 'allow_site' | 'allow_all' | 'deny';

export type ZeusBrowserEvent =
  | { type: 'snapshot'; snapshot: ZeusBrowserConversationSnapshot }
  | { type: 'open_requested'; conversationId: string }
  | { type: 'download'; conversationId: string; tabId: string; state: 'started' | 'completed' | 'failed'; fileName: string; path?: string }
  | { type: 'error'; conversationId: string; tabId?: string; message: string };
