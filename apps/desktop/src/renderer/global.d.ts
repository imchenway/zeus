import type { DashboardClientOptions, LocalBusinessDataSnapshot, LocalSettingsExportSnapshot } from './apiClient.js';

declare global {
  interface Window {
    zeus?: {
      appName: 'Zeus';
      getLocalServerConfig: () => Promise<DashboardClientOptions>;
      reportRendererFatalFailure: (message: string) => void;
      reportRendererBootstrapReady: () => void;
      chooseProjectDirectory: () => Promise<string | null>;
      chooseTaskAttachments: () => Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>>;
      readTaskClipboardAttachments: () => Promise<Array<{ name: string; type: string; data: ArrayBuffer }>>;
      readTaskClipboardImage: () => Promise<{ name: string; type: 'image/png'; data: ArrayBuffer } | null>;
      saveTaskClipboardAttachments: () => Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>>;
      saveTaskPastedAttachments: (attachments: Array<{ name: string; type: string; data: ArrayBuffer }>) => Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>>;
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
      exportMermaidDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.mermaid'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
      exportPlantUmlDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.plantuml'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
      notifyAppShellSettingsChanged: (settings: {
        webviewDebugEnabled: boolean;
        multiWindowEnabled: boolean;
        backgroundModeEnabled: boolean;
        desktopNotificationsEnabled: boolean;
        openAtLoginEnabled: boolean;
      }) => Promise<{ applied: boolean }>;
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
    };
  }
}
