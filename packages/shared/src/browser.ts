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

/** 浏览器只对网页自身请求的设备等权限征求同意。 */
export type ZeusBrowserApprovalKind = 'web_permission';

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
export type ZeusFileOpenTarget = 'zeus_source' | 'system_default' | 'editor:vscode' | 'editor:vscode-insiders' | 'editor:cursor' | 'editor:windsurf';

export interface ZeusBrowserSettings {
  enabled: boolean;
  downloadDirectory: string;
  askWhereToSave: boolean;
  screenshotMode: ZeusBrowserScreenshotMode;
  webLinkOpenTarget: ZeusWebLinkOpenTarget;
  localWebOpenTarget: ZeusWebLinkOpenTarget;
  fileOpenTarget: ZeusFileOpenTarget;
  externalChromeEnabled: boolean;
  externalEdgeEnabled: boolean;
  externalConnectionState?: 'disabled' | 'waiting' | 'connected' | 'store_id_pending' | 'error';
  externalConnectionDetail?: string;
}

export interface ZeusComputerSettings {
  enabled: boolean;
  serviceState: 'disabled' | 'idle' | 'starting' | 'ready' | 'stopping' | 'error';
  accessibilityTrusted: boolean;
  screenCaptureAvailable: boolean;
  detail?: string;
}

/** 会话内用户按钮必须携带控制身份，避免迟到的点击停止或恢复另一轮。 */
export interface ZeusComputerControlIdentity {
  /** 发起桌面控制的产品会话。 */
  conversationId: string;
  /** 宿主签发且仅在本次控制期间有效的身份。 */
  sessionId: string;
}

/** 原生采集的实时缩略图，仅供所属会话展示，不作为历史消息持久化。 */
export interface ZeusComputerPreview extends ZeusComputerControlIdentity {
  /** 当前受控应用的系统名称。 */
  appName: string;
  /** 用户接管期间暂让输入，目标窗口空闲后恢复观察资格。 */
  paused: boolean;
  /** 恢复或窗口变化后需由模型重新观察。 */
  needsObservation: boolean;
  /** 有界 JPEG 缩略图；尚未产生首帧时为空。 */
  imageUrl: string | null;
  /** 虚拟光标在受控窗口内的归一化位置。 */
  cursor: { x: number; y: number } | null;
}

export interface ZeusRetiredNativeRuntimeState {
  sourceRoot: string;
  entries: string[];
  latestBackupRoot: string | null;
  archivedAt?: string;
  restoredAt?: string;
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
  /** 页面查找复用 Chromium，搜索内容限制在当前标签内。 */
  | { action: 'find'; text: string; forward?: boolean }
  | { action: 'stop_find' }
  /** 手动菜单操作只作用于经过归属校验的网页。 */
  | { action: 'copy_url' | 'open_external' | 'zoom_in' | 'zoom_out' | 'zoom_reset' | 'devtools' }
  | { action: 'set_annotation_mode'; enabled: boolean }
  | { action: 'clear_comments' }
  | { action: 'delete_comment'; commentId: string }
  | { action: 'focus_comment'; commentId: string };

/** 网页权限按本次请求允许或拒绝，不再管理 AI 站点放行。 */
export type ZeusBrowserApprovalDecision = 'allow_once' | 'deny';

export type ZeusBrowserEvent =
  | { type: 'snapshot'; snapshot: ZeusBrowserConversationSnapshot }
  | { type: 'open_requested'; conversationId: string }
  | { type: 'download'; conversationId: string; tabId: string; state: 'started' | 'completed' | 'failed'; fileName: string; path?: string }
  | { type: 'error'; conversationId: string; tabId?: string; message: string };
