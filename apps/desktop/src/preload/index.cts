import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('zeus', {
  appName: 'Zeus',
  getLocalServerConfig: () => ipcRenderer.invoke('zeus:get-local-server-config'),
  chooseProjectDirectory: () => ipcRenderer.invoke('zeus:choose-project-directory'),
  exportSettingsSnapshotToFile: (snapshot: unknown) => ipcRenderer.invoke('zeus:export-settings-snapshot', snapshot),
  importSettingsSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-settings-snapshot'),
  importBusinessDataSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-business-data-snapshot'),
  exportPatchToFile: (patch: unknown) => ipcRenderer.invoke('zeus:export-patch', patch),
  openGraphSource: (source: unknown) => ipcRenderer.invoke('zeus:open-graph-source', source),
  exportMermaidDiagramToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-mermaid-diagram', payload),
  notifyAppShellSettingsChanged: (settings: unknown) => ipcRenderer.invoke('zeus:app-shell-settings-changed', settings),
  exportRuntimeLogsToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-runtime-logs', payload),
  beginWindowDrag: (point: unknown) => ipcRenderer.invoke('zeus:window-drag-start', point),
  moveWindowDrag: (point: unknown) => ipcRenderer.invoke('zeus:window-drag-move', point),
  endWindowDrag: () => ipcRenderer.invoke('zeus:window-drag-end'),
});
