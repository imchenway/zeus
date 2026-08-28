import {contextBridge, ipcRenderer, webUtils} from 'electron';
import {createRendererBootstrapReporter, shouldReportRendererWindowError} from './rendererBootstrapState.cjs';

type MainCommandScopeKind = 'project' | 'product_conversation' | 'approval' | 'git_repository' | 'artifact' | 'settings' | 'execution_host';

function mainCommandScopeId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = Array.from(value.trim())
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .slice(0, 256);
  return normalized || fallback;
}

function invokeMainCommand(channel: string, commandType: string, scopeKind: MainCommandScopeKind, scopeId: string, body: unknown = null): Promise<unknown> {
  const commandId = globalThis.crypto.randomUUID();
  const envelope = Object.freeze({
    schemaGeneration: 'zeus-command-envelope-v1',
    commandId,
    commandType,
    actor: Object.freeze({ kind: 'user', id: 'desktop-renderer-user' }),
    scope: Object.freeze({ kind: scopeKind, id: mainCommandScopeId(scopeId, 'desktop-main') }),
    expectedRevision: null,
    idempotencyKey: `desktop-renderer:${commandId}`,
    issuedAt: new Date().toISOString(),
    payload: Object.freeze({ transport: 'electron-ipc', channel }),
  });
  return ipcRenderer.invoke(channel, Object.freeze({ envelope, body }));
}

function invokeProjectSourceCommand(channel: string, commandType: string, input: unknown): Promise<unknown> {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { projectId?: unknown }) : {};
  return invokeMainCommand(channel, commandType, 'project', mainCommandScopeId(candidate.projectId, 'project-source'), input);
}

function invokeBrowserConversationCommand(channel: string, commandType: string, input: unknown): Promise<unknown> {
  const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { conversationId?: unknown }) : {};
  return invokeMainCommand(channel, commandType, 'product_conversation', mainCommandScopeId(candidate.conversationId, 'browser-conversation'), input);
}

async function readTaskClipboardResources(): Promise<{ resources: unknown[]; text: string }> {
  const raw = (await ipcRenderer.invoke('zeus:read-task-clipboard-resources')) as { paths?: unknown; attachments?: unknown; text?: unknown };
  const paths = Array.isArray(raw?.paths) ? raw.paths.filter((path): path is string => typeof path === 'string') : [];
  const attachments = Array.isArray(raw?.attachments) ? raw.attachments : [];
  if (paths.length > 0) {
    const resources = await invokeMainCommand('zeus:store-task-resource-paths', 'desktop.task_resources.store_paths', 'artifact', 'task-input-resources', paths);
    return { resources: Array.isArray(resources) ? resources : [], text: '' };
  }
  if (attachments.length > 0) {
    const resources = await invokeMainCommand('zeus:materialize-task-resources', 'desktop.task_resources.materialize', 'artifact', 'task-input-resources', attachments);
    return { resources: Array.isArray(resources) ? resources : [], text: '' };
  }
  return { resources: [], text: typeof raw?.text === 'string' ? raw.text : '' };
}

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
  const storeNativePaths = (): Promise<unknown> => {
    if (!nativePaths.length) return Promise.resolve([]);
    if (pathChannel === 'zeus:store-task-resource-paths') {
      return invokeMainCommand(pathChannel, 'desktop.task_resources.store_paths', 'artifact', 'task-input-resources', nativePaths);
    }
    return ipcRenderer.invoke(pathChannel, nativePaths, source);
  };
  const materializePayloads = (): Promise<unknown> => {
    if (!pathlessPayloads.length) return Promise.resolve([]);
    const conversation = materializeChannel === 'zeus:materialize-conversation-resources';
    return invokeMainCommand(
      materializeChannel,
      conversation ? 'desktop.conversation_resources.materialize' : 'desktop.task_resources.materialize',
      'artifact',
      conversation ? 'conversation-input-resources' : 'task-input-resources',
      pathlessPayloads,
    );
  };
  const [authorizedResult, materializedResult] = await Promise.allSettled([storeNativePaths(), materializePayloads()]);
  const authorized = authorizedResult.status === 'fulfilled' && Array.isArray(authorizedResult.value) ? authorizedResult.value : [];
  const materialized = materializedResult.status === 'fulfilled' && Array.isArray(materializedResult.value) ? materializedResult.value : [];
  const resources = [...authorized, ...materialized];
  return { resources, failedCount: Math.max(0, files.length - resources.length) };
}

contextBridge.exposeInMainWorld('zeus', {
  appName: 'Zeus',
  getConversationStoreMigrationStatus: () => ipcRenderer.invoke('zeus:conversation-store-migration:get-status'),
  retryConversationStoreMigration: () => invokeMainCommand('zeus:conversation-store-migration:retry', 'desktop.conversation_store_migration.retry', 'execution_host', 'conversation-store-migration'),
  openConversationStoreMigrationDiagnostics: () => ipcRenderer.invoke('zeus:conversation-store-migration:open-diagnostics'),
  exitConversationStoreMigration: () => ipcRenderer.invoke('zeus:conversation-store-migration:exit'),
  getExecutionHostMaintenanceStatus: () => ipcRenderer.invoke('zeus:execution-host-maintenance:get-status'),
  retryExecutionHostMaintenance: () => ipcRenderer.invoke('zeus:execution-host-maintenance:retry'),
  exitExecutionHostMaintenance: () => ipcRenderer.invoke('zeus:execution-host-maintenance:exit'),
    restartAfterStartupFailure: () => ipcRenderer.invoke('zeus:startup-failure:restart'),
    exitAfterStartupFailure: () => ipcRenderer.invoke('zeus:startup-failure:exit'),
  getLocalServerConfig: () => ipcRenderer.invoke('zeus:get-local-server-config'),
  loadSessionViewCache: () => ipcRenderer.invoke('zeus:session-view-cache:load'),
  persistSessionViewCache: (value: unknown) => ipcRenderer.send('zeus:session-view-cache:persist', value),
  runStorageRecoveryPreflightAndRestart: () => invokeMainCommand('zeus:storage-recovery:preflight-and-restart', 'desktop.storage_recovery.preflight_restart', 'execution_host', 'storage-recovery'),
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
  executeProjectGitAction: (input: unknown) => {
    const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { repositoryId?: unknown }) : {};
    return invokeMainCommand('zeus:project-git:execute-action', 'desktop.project_git.execute_action', 'git_repository', mainCommandScopeId(candidate.repositoryId, 'project-git'), input);
  },
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
  onMenuBarUsageSettingsChanged: (listener: (settings: unknown) => void) => {
    const handler = (_event: unknown, settings: unknown) => listener(settings);
    ipcRenderer.on('zeus:menu-bar-usage:settings', handler);
    return () => ipcRenderer.removeListener('zeus:menu-bar-usage:settings', handler);
  },
  showMainWindowFromMenuBarUsage: () => ipcRenderer.invoke('zeus:menu-bar-usage:show-main'),
  openMenuBarUsageSettings: (category: 'usage' | 'runtime') => ipcRenderer.invoke('zeus:menu-bar-usage:open-settings', category),
  quitFromMenuBarUsage: () => ipcRenderer.invoke('zeus:menu-bar-usage:quit'),
  listProjectSourceDirectory: (input: unknown) => ipcRenderer.invoke('zeus:project-source:list-directory', input),
  searchProjectSourceEntries: (input: unknown) => ipcRenderer.invoke('zeus:project-source:search', input),
  readProjectSourceFile: (input: unknown) => ipcRenderer.invoke('zeus:project-source:read-file', input),
  saveProjectSourceFile: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:save-file', 'desktop.project_source.save_file', input),
  createProjectSourceEntry: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:create-entry', 'desktop.project_source.create_entry', input),
  moveProjectSourceEntry: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:move-entry', 'desktop.project_source.move_entry', input),
  trashProjectSourceEntry: (input: unknown) => invokeProjectSourceCommand('zeus:project-source:trash-entry', 'desktop.project_source.trash_entry', input),
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
    reportRendererRuntimeError: (message: string) => ipcRenderer.send('zeus:renderer-runtime-log', message),
  reportRendererBootstrapReady: () => rendererBootstrapReporter.reportReady(),
  chooseProjectDirectory: () => ipcRenderer.invoke('zeus:choose-project-directory'),
  chooseRecoveryBackupDestinations: () => ipcRenderer.invoke('zeus:choose-recovery-backup-destinations'),
  revealProjectInFinder: (projectPath: string) => ipcRenderer.invoke('zeus:reveal-project-in-finder', projectPath),
  chooseConversationResources: () => ipcRenderer.invoke('zeus:choose-conversation-resources'),
  authorizeConversationFiles: (files: File[], source: 'paste' | 'drop') => authorizePendingResourceFiles(files, source, 'zeus:authorize-conversation-files', 'zeus:materialize-conversation-resources'),
  materializeConversationResources: (resources: unknown[]) => invokeMainCommand('zeus:materialize-conversation-resources', 'desktop.conversation_resources.materialize', 'artifact', 'conversation-input-resources', resources),
  readConversationClipboardResources: () => invokeMainCommand('zeus:read-conversation-clipboard-resources', 'desktop.conversation_resources.read_clipboard', 'artifact', 'conversation-input-resources'),
  getConversationResourcePreview: (resource: unknown) => ipcRenderer.invoke('zeus:get-conversation-resource-preview', resource),
  openConversationInputResource: (resource: unknown) => ipcRenderer.invoke('zeus:open-conversation-input-resource', resource),
  discardConversationResources: (resources: unknown[]) => invokeMainCommand('zeus:discard-conversation-resources', 'desktop.conversation_resources.discard', 'artifact', 'conversation-input-resources', resources),
  chooseTaskAttachments: () => invokeMainCommand('zeus:choose-task-attachments', 'desktop.task_resources.choose', 'artifact', 'task-input-resources'),
  authorizeTaskFiles: (files: File[], source: 'paste' | 'drop') => authorizePendingResourceFiles(files, source, 'zeus:store-task-resource-paths', 'zeus:materialize-task-resources'),
  materializeTaskResources: (resources: unknown[]) => invokeMainCommand('zeus:materialize-task-resources', 'desktop.task_resources.materialize', 'artifact', 'task-input-resources', resources),
  readTaskClipboardResources,
  readTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:read-task-clipboard-attachments'),
  readTaskClipboardImage: () => ipcRenderer.invoke('zeus:read-task-clipboard-image'),
  writeClipboardText: (text: string) => ipcRenderer.invoke('zeus:write-clipboard-text', text),
  saveTaskClipboardAttachments: () => invokeMainCommand('zeus:save-task-clipboard-attachments', 'desktop.task_resources.save_clipboard', 'artifact', 'task-input-resources'),
  saveTaskPastedAttachments: (attachments: Array<{ name?: string; type?: string; data?: ArrayBuffer; text?: string; kind?: 'image' | 'file' | 'pasted_text' }>) =>
    invokeMainCommand('zeus:save-task-pasted-attachments', 'desktop.task_resources.save_pasted', 'artifact', 'task-input-resources', attachments),
  getTaskAttachmentPreview: (path: string) => ipcRenderer.invoke('zeus:get-task-attachment-preview', path),
  openTaskAttachment: (path: string) => ipcRenderer.invoke('zeus:open-task-attachment', path),
  parseZentaoTaskLink: (url: string) => ipcRenderer.invoke('zeus:zentao:parse-link', url),
  exportSettingsSnapshotToFile: (snapshot: unknown) => ipcRenderer.invoke('zeus:export-settings-snapshot', snapshot),
  importSettingsSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-settings-snapshot'),
  importBusinessDataSnapshotFromFile: () => ipcRenderer.invoke('zeus:import-business-data-snapshot'),
  clearNetworkCache: () => ipcRenderer.invoke('zeus:clear-network-cache'),
  exportPatchToFile: (patch: unknown) => ipcRenderer.invoke('zeus:export-patch', patch),
  openGraphSource: (source: unknown) => ipcRenderer.invoke('zeus:open-graph-source', source),
  openExternalHttpsUrl: (url: string) => ipcRenderer.invoke('zeus:open-external-https-url', url),
  activateRequestingWindow: () => ipcRenderer.invoke('zeus:activate-requesting-window'),
  getAutomaticUpdateIndicator: () => ipcRenderer.invoke('zeus:automatic-update-indicator:get'),
  openAutomaticUpdateIndicator: () => invokeMainCommand('zeus:automatic-update-indicator:open', 'desktop.automatic_update.open', 'execution_host', 'desktop-update'),
  recordManualUpdateCheck: () => invokeMainCommand('zeus:automatic-update-indicator:record-manual-check', 'desktop.automatic_update.record_manual_check', 'execution_host', 'desktop-update'),
  onAutomaticUpdateIndicatorChanged: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('zeus:automatic-update-indicator:changed', handler);
    return () => ipcRenderer.removeListener('zeus:automatic-update-indicator:changed', handler);
  },
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
  runBrowserCommand: (input: unknown) => invokeBrowserConversationCommand('zeus:browser:command', 'desktop.browser.command', input),
  setBrowserLayout: (input: unknown) => ipcRenderer.invoke('zeus:browser:set-layout', input),
  prepareBrowserComments: (input: unknown) => ipcRenderer.invoke('zeus:browser:prepare-comments', input),
  getBrowserCommentPreview: (path: string) => ipcRenderer.invoke('zeus:browser:comment-preview', path),
  markBrowserCommentsSent: (input: unknown) => invokeBrowserConversationCommand('zeus:browser:mark-comments-sent', 'desktop.browser.mark_comments_sent', input),
  respondToBrowserApproval: (input: unknown) => {
    const candidate = input && typeof input === 'object' && !Array.isArray(input) ? (input as { requestId?: unknown }) : {};
    return invokeMainCommand('zeus:browser:respond-approval', 'desktop.browser.respond_approval', 'approval', mainCommandScopeId(candidate.requestId, 'browser-approval'), input);
  },
  getBrowserSettings: () => ipcRenderer.invoke('zeus:browser:get-settings'),
  updateBrowserSettings: (input: unknown) => invokeMainCommand('zeus:browser:update-settings', 'desktop.browser.update_settings', 'settings', 'browser-settings', input),
  clearBrowserData: () => invokeMainCommand('zeus:browser:clear-data', 'desktop.browser.clear_data', 'settings', 'browser-settings'),
  onBrowserEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: unknown, value: unknown) => listener(value);
    ipcRenderer.on('zeus:browser-event', handler);
    return () => ipcRenderer.removeListener('zeus:browser-event', handler);
  },
});
