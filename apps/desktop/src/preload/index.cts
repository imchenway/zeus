import { contextBridge, ipcRenderer } from 'electron';
import { createRendererBootstrapReporter, shouldReportRendererWindowError } from './rendererBootstrapState.cjs';

const rendererBootstrapReporter = createRendererBootstrapReporter({
  send: (channel, message) => {
    if (message === undefined) ipcRenderer.send(channel);
    else ipcRenderer.send(channel, message);
  },
});

globalThis.addEventListener(
  'error',
  (event) => {
    if (!shouldReportRendererWindowError(rendererBootstrapReporter.getState(), event)) return;
    rendererBootstrapReporter.reportFailure(event.error ?? event.message);
  },
  true,
);
globalThis.addEventListener('unhandledrejection', (event) => {
  rendererBootstrapReporter.reportFailure(event.reason);
});

contextBridge.exposeInMainWorld('zeus', {
  appName: 'Zeus',
  getLocalServerConfig: () => ipcRenderer.invoke('zeus:get-local-server-config'),
  reportRendererFatalFailure: (message: string) => rendererBootstrapReporter.reportFailure(message),
  reportRendererBootstrapReady: () => rendererBootstrapReporter.reportReady(),
  chooseProjectDirectory: () => ipcRenderer.invoke('zeus:choose-project-directory'),
  chooseTaskAttachments: () => ipcRenderer.invoke('zeus:choose-task-attachments'),
  readTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:read-task-clipboard-attachments'),
  readTaskClipboardImage: () => ipcRenderer.invoke('zeus:read-task-clipboard-image'),
  saveTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:save-task-clipboard-attachments'),
  saveTaskPastedAttachments: (attachments: Array<{ name: string; type: string; data: ArrayBuffer }>) => ipcRenderer.invoke('zeus:save-task-pasted-attachments', attachments),
  getTaskAttachmentPreview: (path: string) => ipcRenderer.invoke('zeus:get-task-attachment-preview', path),
  openTaskAttachment: (path: string) => ipcRenderer.invoke('zeus:open-task-attachment', path),
  exportSettingsSnapshotToFile: (snapshot: unknown) => ipcRenderer.invoke('zeus:export-settings-snapshot', snapshot),
  importSettingsSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-settings-snapshot'),
  importBusinessDataSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-business-data-snapshot'),
  exportPatchToFile: (patch: unknown) => ipcRenderer.invoke('zeus:export-patch', patch),
  openGraphSource: (source: unknown) => ipcRenderer.invoke('zeus:open-graph-source', source),
  openExternalHttpsUrl: (url: string) => ipcRenderer.invoke('zeus:open-external-https-url', url),
  exportMermaidDiagramToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-mermaid-diagram', payload),
  exportPlantUmlDiagramToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-plantuml-diagram', payload),
  notifyAppShellSettingsChanged: (settings: unknown) => ipcRenderer.invoke('zeus:app-shell-settings-changed', settings),
  exportRuntimeLogsToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-runtime-logs', payload),
  beginWindowDrag: (point: unknown) => ipcRenderer.invoke('zeus:window-drag-start', point),
  moveWindowDrag: (point: unknown) => ipcRenderer.invoke('zeus:window-drag-move', point),
  endWindowDrag: () => ipcRenderer.invoke('zeus:window-drag-end'),
  onNativeNewConversation: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('zeus:native-new-conversation', handler);
    return () => ipcRenderer.removeListener('zeus:native-new-conversation', handler);
  },
});
