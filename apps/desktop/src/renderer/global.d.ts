import type { DashboardClientOptions, LocalBusinessDataSnapshot, LocalSettingsExportSnapshot } from './apiClient.js';

declare global {
  interface Window {
    zeus?: {
      appName: 'Zeus';
      getLocalServerConfig: () => Promise<DashboardClientOptions>;
      chooseProjectDirectory: () => Promise<string | null>;
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
      openGraphSource: (source: { sourceRef: string; lineStart?: number }) => Promise<{
        opened: boolean;
        filePath: string | null;
        lineStart?: number | null;
      }>;
      exportMermaidDiagramToFile: (payload: { fileName: string; mimeType: 'text/vnd.mermaid'; content: string }) => Promise<{ saved: boolean; filePath: string | null }>;
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
    };
  }
}
