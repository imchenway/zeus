import type {DashboardClientOptions, LocalBusinessDataSnapshot, LocalSettingsExportSnapshot} from './apiClient.js';
import type {
  ZeusBrowserApprovalDecision,
  ZeusBrowserCommand,
  ZeusBrowserConversationSnapshot,
  ZeusBrowserEvent,
  ZeusBrowserPreparedSubmission,
  ZeusBrowserSettings,
} from '@zeus/shared';
import type {
  ConversationFileLocation,
  ConversationOpenTarget,
  ConversationResourceOpenTarget,
} from '@zeus/shared';

type ConversationInputResourceBridge = {
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  source: 'picker' | 'paste' | 'drop';
  characterCount?: number;
  restorableText?: string;
} & ({localPath: string; uploadRef?: never} | {localPath?: never; uploadRef: string});

type TaskInputResourceBridge = {
  path: string;
  name: string;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  mimeType?: string;
  size?: number;
  characterCount?: number;
  previewUrl?: string;
  restorableText?: string;
};

declare global {
  interface Window {
    zeus?: {
      appName: 'Zeus';
      getLocalServerConfig: () => Promise<DashboardClientOptions>;
      reportRendererFatalFailure: (message: string) => void;
      reportRendererBootstrapReady: () => void;
      chooseProjectDirectory: () => Promise<string | null>;
      revealProjectInFinder: (projectPath: string) => Promise<{ revealed: true; path: string }>;
      chooseConversationResources: () => Promise<ConversationInputResourceBridge[]>;
      authorizeConversationFiles: (files: File[], source: 'paste' | 'drop') => Promise<{
        resources: ConversationInputResourceBridge[];
        failedCount: number;
      }>;
      materializeConversationResources: (resources: Array<{
        name?: string;
        type?: string;
        data?: ArrayBuffer;
        text?: string;
        source?: 'paste' | 'drop';
        kind?: 'image' | 'file' | 'pasted_text';
      }>) => Promise<ConversationInputResourceBridge[]>;
      readConversationClipboardResources: () => Promise<{resources: ConversationInputResourceBridge[]; text: string}>;
      getConversationResourcePreview: (resource: {localPath?: string; uploadRef?: string}) => Promise<{previewUrl: string; mimeType: string} | null>;
      chooseTaskAttachments: () => Promise<TaskInputResourceBridge[]>;
      authorizeTaskFiles: (files: File[], source: 'paste' | 'drop') => Promise<{
        resources: TaskInputResourceBridge[];
        failedCount: number;
      }>;
      materializeTaskResources: (resources: Array<{
        name?: string;
        type?: string;
        data?: ArrayBuffer;
        text?: string;
        kind?: 'image' | 'file' | 'pasted_text';
      }>) => Promise<TaskInputResourceBridge[]>;
      readTaskClipboardResources: () => Promise<{resources: TaskInputResourceBridge[]; text: string}>;
      readTaskClipboardAttachments: () => Promise<Array<{ name: string; type: string; data: ArrayBuffer }>>;
      readTaskClipboardImage: () => Promise<{ name: string; type: 'image/png'; data: ArrayBuffer } | null>;
        writeClipboardText: (text: string) => Promise<{ written: boolean }>;
      saveTaskClipboardAttachments: () => Promise<TaskInputResourceBridge[]>;
      saveTaskPastedAttachments: (attachments: Array<{
        name?: string;
        type?: string;
        data?: ArrayBuffer;
        text?: string;
        kind?: 'image' | 'file' | 'pasted_text';
      }>) => Promise<TaskInputResourceBridge[]>;
      getTaskAttachmentPreview: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
      openTaskAttachment: (path: string) => Promise<{ opened: boolean; error?: string }>;
      exportSettingsSnapshotToFile: (snapshot: unknown) => Promise<{ saved: boolean; filePath: string | null }>;
      importSettingsSnapshotFromFile: () => Promise<{
        imported: boolean;
        filePath: string | null;
        snapshot?: LocalSettingsExportSnapshot;
      }>;
      importBusinessDataSnapshotFromFile: () => Promise<{
        imported: boolean;
        filePath: string | null;
        snapshot?: LocalBusinessDataSnapshot;
      }>;
      exportPatchToFile: (patch: unknown) => Promise<{ saved: boolean; filePath: string | null }>;
      openGraphSource: (source: { projectRoot?: string; sourceRef: string; lineStart?: number }) => Promise<{
        opened: boolean;
        filePath: string | null;
        lineStart?: number | null;
      }>;
      openExternalHttpsUrl: (url: string) => Promise<{ opened: boolean; url?: string; error?: string }>;
      listConversationResourceOpenTargets: (request: {
        projectId: string;
        conversationId: string;
        resourceId: string;
      }) => Promise<{resourceId: string; targets: ConversationResourceOpenTarget[]}>;
      openConversationResource: (request: {
        projectId: string;
        conversationId: string;
        resourceId: string;
        target: ConversationOpenTarget;
        location?: ConversationFileLocation;
      }) => Promise<{
        opened: boolean;
        resourceId: string;
        target: ConversationOpenTarget;
        mode?: 'zeus_source' | 'zeus_browser' | 'external' | 'file' | 'clipboard';
        error?: string;
      }>;
      exportMermaidDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.mermaid'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
      exportPlantUmlDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.plantuml'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
      notifyAppShellSettingsChanged: (settings: {
        webviewDebugEnabled: boolean;
        multiWindowEnabled: boolean;
        backgroundModeEnabled: boolean;
        desktopNotificationsEnabled: boolean;
        openAtLoginEnabled: boolean;
      }) => Promise<{ applied: boolean }>;
      notifyTaskTableLayoutDirty: (dirty: boolean) => void;
      resolveTaskTableLayoutCloseRequest: (proceed: boolean) => void;
      onTaskTableLayoutCloseRequested: (listener: () => void) => () => void;
      exportRuntimeLogsToFile: (payload: {
        fileName: string;
        mimeType: 'text/plain';
        sessionId: string;
        sourceFilePath?: string;
        logs: Array<{ createdAt: string; stream: string; text: string }>;
      }) => Promise<{ saved: boolean; filePath: string | null }>;
      beginWindowDrag: (point: { screenX: number; screenY: number }) => Promise<{ dragging: boolean }>;
      moveWindowDrag: (point: { screenX: number; screenY: number }) => Promise<{ dragging: boolean; x?: number; y?: number }>;
      endWindowDrag: () => Promise<{ dragging: false }>;
      onNativeNewConversation: (listener: () => void) => () => void;
      getBrowserSnapshot: (conversationId: string) => Promise<ZeusBrowserConversationSnapshot>;
      openBrowserTab: (input: {conversationId: string; url?: string}) => Promise<ZeusBrowserConversationSnapshot>;
      activateBrowserTab: (input: {conversationId: string; tabId: string}) => Promise<ZeusBrowserConversationSnapshot>;
      closeBrowserTab: (input: {conversationId: string; tabId: string}) => Promise<ZeusBrowserConversationSnapshot>;
      runBrowserCommand: (input: {conversationId: string; tabId: string; command: ZeusBrowserCommand}) => Promise<ZeusBrowserConversationSnapshot>;
      setBrowserLayout: (input: {
        conversationId: string;
        tabId: string;
        bounds: {x: number; y: number; width: number; height: number};
        visible: boolean;
      }) => Promise<{applied: boolean}>;
      prepareBrowserComments: (input: {conversationId: string; tabId: string; commentIds?: string[]}) => Promise<ZeusBrowserPreparedSubmission>;
      getBrowserCommentPreview: (path: string) => Promise<{previewUrl: string; mimeType: 'image/png'} | null>;
      markBrowserCommentsSent: (input: {conversationId: string; tabId: string; commentIds: string[]}) => Promise<ZeusBrowserConversationSnapshot>;
      respondToBrowserApproval: (input: {requestId: string; decision: ZeusBrowserApprovalDecision}) => Promise<{resolved: boolean}>;
      getBrowserSettings: () => Promise<ZeusBrowserSettings>;
      updateBrowserSettings: (input: Partial<ZeusBrowserSettings>) => Promise<ZeusBrowserSettings>;
      clearBrowserData: () => Promise<{cleared: boolean}>;
      onBrowserEvent: (listener: (event: ZeusBrowserEvent) => void) => () => void;
    };
  }
}
