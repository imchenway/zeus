import { contextBridge, ipcRenderer, webUtils } from 'electron';
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

async function authorizePendingResourceFiles(files: File[], source: 'paste' | 'drop', pathChannel: string, materializeChannel: string): Promise<{ resources: unknown[]; failedCount: number }> {
  const nativePaths: string[] = [];
  const pathlessFiles: File[] = [];
  for (const file of files) {
    let nativePath = '';
    try {
      nativePath = webUtils.getPathForFile(file);
    } catch {
      // 截图/浏览器 Blob 没有稳定本地路径，转入 Main 物化链路。
    }
    if (nativePath) nativePaths.push(nativePath);
    else pathlessFiles.push(file);
  }
  const pathlessPayloadResults = await Promise.allSettled(
    pathlessFiles.map(async (file) => ({
      name: file.name,
      type: file.type,
      data: await file.arrayBuffer(),
      source,
    })),
  );
  const pathlessPayloads = pathlessPayloadResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
  const [authorizedResult, materializedResult] = await Promise.allSettled([
    nativePaths.length ? ipcRenderer.invoke(pathChannel, nativePaths, source) : Promise.resolve([]),
    pathlessPayloads.length ? ipcRenderer.invoke(materializeChannel, pathlessPayloads) : Promise.resolve([]),
  ]);
  const authorized = authorizedResult.status === 'fulfilled' && Array.isArray(authorizedResult.value) ? authorizedResult.value : [];
  const materialized = materializedResult.status === 'fulfilled' && Array.isArray(materializedResult.value) ? materializedResult.value : [];
  const resources = [...authorized, ...materialized];
  return { resources, failedCount: Math.max(0, files.length - resources.length) };
}

contextBridge.exposeInMainWorld('zeus', {
  appName: 'Zeus',
  getLocalServerConfig: () => ipcRenderer.invoke('zeus:get-local-server-config'),
  openTaskGitDeliveryWindow: (input: unknown) => ipcRenderer.invoke('zeus:task-git-delivery:open', input),
  closeTaskGitDeliveryWindow: () => ipcRenderer.invoke('zeus:task-git-delivery:close'),
  getTaskGitDeliveryCurrentContext: () => ipcRenderer.invoke('zeus:task-git-delivery:get-current-context'),
  notifyTaskGitDeliveryCurrentContext: (context: unknown) => ipcRenderer.send('zeus:task-git-delivery:current-context-changed', context),
  notifyTaskGitDeliveryChanged: (taskId: string) => ipcRenderer.send('zeus:task-git-delivery:changed', taskId),
  openTaskGitDeliveryConversation: (input: unknown) => ipcRenderer.invoke('zeus:task-git-delivery:open-conversation', input),
  openProjectGitDiffWindow: (input: unknown) => ipcRenderer.invoke('zeus:project-git-diff:open', input),
  loadProjectGitWorkbench: (projectId: string) => ipcRenderer.invoke('zeus:project-git:load-workbench', projectId),
  loadProjectGitCommit: (input: unknown) => ipcRenderer.invoke('zeus:project-git:load-commit', input),
  loadProjectGitComparisonDiff: (input: unknown) => ipcRenderer.invoke('zeus:project-git:load-comparison', input),
  executeProjectGitAction: (input: unknown) => ipcRenderer.invoke('zeus:project-git:execute-action', input),
  onTaskGitDeliveryCurrentContext: (listener: (context: unknown) => void) => {
    const handler = (_event: unknown, context: unknown) => listener(context);
    ipcRenderer.on('zeus:task-git-delivery:current-context', handler);
    return () => ipcRenderer.removeListener('zeus:task-git-delivery:current-context', handler);
  },
  onTaskGitDeliveryAppearance: (listener: (settings: unknown) => void) => {
    const handler = (_event: unknown, settings: unknown) => listener(settings);
    ipcRenderer.on('zeus:task-git-delivery:appearance', handler);
    return () => ipcRenderer.removeListener('zeus:task-git-delivery:appearance', handler);
  },
  onTaskGitDeliveryChanged: (listener: (taskId: string) => void) => {
    const handler = (_event: unknown, taskId: string) => listener(taskId);
    ipcRenderer.on('zeus:task-git-delivery:changed', handler);
    return () => ipcRenderer.removeListener('zeus:task-git-delivery:changed', handler);
  },
  onOpenTaskGitDeliveryConversation: (listener: (input: unknown) => void) => {
    const handler = (_event: unknown, input: unknown) => listener(input);
    ipcRenderer.on('zeus:task-git-delivery:open-conversation', handler);
    return () => ipcRenderer.removeListener('zeus:task-git-delivery:open-conversation', handler);
  },
  onOpenConversationNotification: (listener: (input: unknown) => void) => {
    const handler = (_event: unknown, input: unknown) => listener(input);
    ipcRenderer.on('zeus:conversation-notification:open', handler);
    return () => ipcRenderer.removeListener('zeus:conversation-notification:open', handler);
  },
  getRequestingWindowForeground: () => ipcRenderer.invoke('zeus:requesting-window-foreground'),
  onRequestingWindowForegroundChanged: (listener: (foreground: boolean) => void) => {
    const handler = (_event: unknown, foreground: boolean) => listener(foreground);
    ipcRenderer.on('zeus:requesting-window-foreground-changed', handler);
    return () => ipcRenderer.removeListener('zeus:requesting-window-foreground-changed', handler);
  },
  hideMenuBarUsage: () => ipcRenderer.invoke('zeus:menu-bar-usage:hide'),
  showMainWindowFromMenuBarUsage: () => ipcRenderer.invoke('zeus:menu-bar-usage:show-main'),
  openMenuBarUsageSettings: (category: 'usage' | 'runtime') => ipcRenderer.invoke('zeus:menu-bar-usage:open-settings', category),
  quitFromMenuBarUsage: () => ipcRenderer.invoke('zeus:menu-bar-usage:quit'),
  listProjectSourceDirectory: (input: unknown) => ipcRenderer.invoke('zeus:project-source:list-directory', input),
  searchProjectSourceEntries: (input: unknown) => ipcRenderer.invoke('zeus:project-source:search', input),
  readProjectSourceFile: (input: unknown) => ipcRenderer.invoke('zeus:project-source:read-file', input),
  saveProjectSourceFile: (input: unknown) => ipcRenderer.invoke('zeus:project-source:save-file', input),
  createProjectSourceEntry: (input: unknown) => ipcRenderer.invoke('zeus:project-source:create-entry', input),
  moveProjectSourceEntry: (input: unknown) => ipcRenderer.invoke('zeus:project-source:move-entry', input),
  trashProjectSourceEntry: (input: unknown) => ipcRenderer.invoke('zeus:project-source:trash-entry', input),
  revealProjectSourceEntry: (input: unknown) => ipcRenderer.invoke('zeus:project-source:reveal-entry', input),
  openProjectSourceExternally: (input: unknown) => ipcRenderer.invoke('zeus:project-source:open-external', input),
  watchProjectSource: (projectId: string) => ipcRenderer.invoke('zeus:project-source:watch', projectId),
  unwatchProjectSource: () => ipcRenderer.invoke('zeus:project-source:unwatch'),
  onProjectSourceEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on('zeus:project-source-event', handler);
    return () => ipcRenderer.removeListener('zeus:project-source-event', handler);
  },
  reportRendererFatalFailure: (message: string) => rendererBootstrapReporter.reportFailure(message),
  reportRendererBootstrapReady: () => rendererBootstrapReporter.reportReady(),
  chooseProjectDirectory: () => ipcRenderer.invoke('zeus:choose-project-directory'),
  revealProjectInFinder: (projectPath: string) => ipcRenderer.invoke('zeus:reveal-project-in-finder', projectPath),
  chooseConversationResources: () => ipcRenderer.invoke('zeus:choose-conversation-resources'),
  authorizeConversationFiles: (files: File[], source: 'paste' | 'drop') => authorizePendingResourceFiles(files, source, 'zeus:authorize-conversation-files', 'zeus:materialize-conversation-resources'),
  materializeConversationResources: (resources: unknown[]) => ipcRenderer.invoke('zeus:materialize-conversation-resources', resources),
  readConversationClipboardResources: () => ipcRenderer.invoke('zeus:read-conversation-clipboard-resources'),
  getConversationResourcePreview: (resource: unknown) => ipcRenderer.invoke('zeus:get-conversation-resource-preview', resource),
  openConversationInputResource: (resource: unknown) => ipcRenderer.invoke('zeus:open-conversation-input-resource', resource),
  discardConversationResources: (resources: unknown[]) => ipcRenderer.invoke('zeus:discard-conversation-resources', resources),
  chooseTaskAttachments: () => ipcRenderer.invoke('zeus:choose-task-attachments'),
  authorizeTaskFiles: (files: File[], source: 'paste' | 'drop') => authorizePendingResourceFiles(files, source, 'zeus:store-task-resource-paths', 'zeus:materialize-task-resources'),
  materializeTaskResources: (resources: unknown[]) => ipcRenderer.invoke('zeus:materialize-task-resources', resources),
  readTaskClipboardResources: () => ipcRenderer.invoke('zeus:read-task-clipboard-resources'),
  readTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:read-task-clipboard-attachments'),
  readTaskClipboardImage: () => ipcRenderer.invoke('zeus:read-task-clipboard-image'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('zeus:write-clipboard-text', text),
  saveTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:save-task-clipboard-attachments'),
  saveTaskPastedAttachments: (attachments: Array<{ name?: string; type?: string; data?: ArrayBuffer; text?: string; kind?: 'image' | 'file' | 'pasted_text' }>) => ipcRenderer.invoke('zeus:save-task-pasted-attachments', attachments),
  getTaskAttachmentPreview: (path: string) => ipcRenderer.invoke('zeus:get-task-attachment-preview', path),
  openTaskAttachment: (path: string) => ipcRenderer.invoke('zeus:open-task-attachment', path),
  exportSettingsSnapshotToFile: (snapshot: unknown) => ipcRenderer.invoke('zeus:export-settings-snapshot', snapshot),
  importSettingsSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-settings-snapshot'),
  importBusinessDataSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-business-data-snapshot'),
  clearNetworkCache: () => ipcRenderer.invoke('zeus:clear-network-cache'),
  exportPatchToFile: (patch: unknown) => ipcRenderer.invoke('zeus:export-patch', patch),
  openGraphSource: (source: unknown) => ipcRenderer.invoke('zeus:open-graph-source', source),
  openExternalHttpsUrl: (url: string) => ipcRenderer.invoke('zeus:open-external-https-url', url),
  activateRequestingWindow: () => ipcRenderer.invoke('zeus:activate-requesting-window'),
  listConversationResourceOpenTargets: (request: unknown) => ipcRenderer.invoke('zeus:conversation-resource:list-open-targets', request),
  openConversationResource: (request: unknown) => ipcRenderer.invoke('zeus:conversation-resource:open', request),
  openTurnChangeFile: (request: unknown) => ipcRenderer.invoke('zeus:turn-change-file:open', request),
  exportMermaidDiagramToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-mermaid-diagram', payload),
  exportPlantUmlDiagramToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-plantuml-diagram', payload),
  notifyAppShellSettingsChanged: (settings: unknown) => ipcRenderer.invoke('zeus:app-shell-settings-changed', settings),
  notifyTaskTableLayoutDirty: (dirty: boolean) => ipcRenderer.send('zeus:task-table-layout-dirty-changed', dirty),
  setUnsavedChangeState: (key: string, dirty: boolean) => ipcRenderer.send('zeus:unsaved-change-state', { key, dirty }),
  notifySensitiveRequestDraft: (payload: { requestId: string; present: boolean }) => ipcRenderer.send('zeus:sensitive-request-draft-changed', payload),
  notifySessionContextActivity: (payload: unknown) => ipcRenderer.send('zeus:session-context-activity-changed', payload),
  notifyAppCloseLayerActivity: (active: boolean) => ipcRenderer.send('zeus:app-close-layer-activity-changed', active),
  resolveTaskTableLayoutCloseRequest: (proceed: boolean) => ipcRenderer.send('zeus:task-table-layout-close-resolution', { proceed }),
  resolveUnsavedChangesCloseRequest: (proceed: boolean) => ipcRenderer.send('zeus:unsaved-changes-close-resolution', { proceed }),
  onTaskTableLayoutCloseRequested: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('zeus:task-table-layout-close-requested', handler);
    return () => ipcRenderer.removeListener('zeus:task-table-layout-close-requested', handler);
  },
  onUnsavedChangesCloseRequested: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('zeus:unsaved-changes-close-requested', handler);
    return () => ipcRenderer.removeListener('zeus:unsaved-changes-close-requested', handler);
  },
  exportRuntimeLogsToFile: (payload: unknown) => ipcRenderer.invoke('zeus:export-runtime-logs', payload),
  beginWindowDrag: (point: unknown) => ipcRenderer.invoke('zeus:window-drag-start', point),
  moveWindowDrag: (point: unknown) => ipcRenderer.invoke('zeus:window-drag-move', point),
  endWindowDrag: () => ipcRenderer.invoke('zeus:window-drag-end'),
  onNativeNewConversation: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('zeus:native-new-conversation', handler);
    return () => ipcRenderer.removeListener('zeus:native-new-conversation', handler);
  },
  onNativeCloseActiveContextTab: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('zeus:session-context-close-active-tab', handler);
    return () => ipcRenderer.removeListener('zeus:session-context-close-active-tab', handler);
  },
  onNativeCloseFrontmostLayer: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on('zeus:app-close-frontmost-layer', handler);
    return () => ipcRenderer.removeListener('zeus:app-close-frontmost-layer', handler);
  },
  getBrowserSnapshot: (conversationId: string) => ipcRenderer.invoke('zeus:browser:get-snapshot', conversationId),
  openBrowserTab: (input: unknown) => ipcRenderer.invoke('zeus:browser:open-tab', input),
  activateBrowserTab: (input: unknown) => ipcRenderer.invoke('zeus:browser:activate-tab', input),
  closeBrowserTab: (input: unknown) => ipcRenderer.invoke('zeus:browser:close-tab', input),
  runBrowserCommand: (input: unknown) => ipcRenderer.invoke('zeus:browser:command', input),
  setBrowserLayout: (input: unknown) => ipcRenderer.invoke('zeus:browser:set-layout', input),
  prepareBrowserComments: (input: unknown) => ipcRenderer.invoke('zeus:browser:prepare-comments', input),
  getBrowserCommentPreview: (path: string) => ipcRenderer.invoke('zeus:browser:comment-preview', path),
  markBrowserCommentsSent: (input: unknown) => ipcRenderer.invoke('zeus:browser:mark-comments-sent', input),
  respondToBrowserApproval: (input: unknown) => ipcRenderer.invoke('zeus:browser:respond-approval', input),
  getBrowserSettings: () => ipcRenderer.invoke('zeus:browser:get-settings'),
  updateBrowserSettings: (input: unknown) => ipcRenderer.invoke('zeus:browser:update-settings', input),
  clearBrowserData: () => ipcRenderer.invoke('zeus:browser:clear-data'),
  onBrowserEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on('zeus:browser-event', handler);
    return () => ipcRenderer.removeListener('zeus:browser-event', handler);
  },
});
