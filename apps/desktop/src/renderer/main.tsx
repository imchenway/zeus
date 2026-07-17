import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App, buildGraphConversationTaskIntent, buildGraphNodeTaskIntent, buildProjectDirectoryResolution, buildTemplateTaskDraft } from './App.js';
import { RendererErrorBoundary } from './ErrorBoundary.js';
import { createDashboardClient, type DashboardClient } from './apiClient.js';
import { openGraphSourceInMain } from './appShellBridge.js';

/** 选择真实仓库失败或取消时保留现有列表；开源分发包不能内置维护者本机路径。 */
function resolveProjectDirectoryForCreation(selectedPath: string | null | undefined, appLanguage: Parameters<typeof buildProjectDirectoryResolution>[1]): { path: string | null; description: string } {
  return buildProjectDirectoryResolution(selectedPath, appLanguage);
}

async function renderWithClient(client: DashboardClient): Promise<void> {
  const snapshot = await client.loadDashboard();
  const appShellSettings = await client.loadAppShellSettings();
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  const reactRoot = createRoot(root);
  reactRoot.render(
    <RendererErrorBoundary appLanguage={appShellSettings.appLanguage} onFatalError={reportRendererFatalFailure}>
      <App
        initialAppShellSettings={appShellSettings}
        snapshot={snapshot}
        nativeConversationClient={client}
        onCreateCurrentProject={async (defaults) => {
          const selectedPath = await window.zeus?.chooseProjectDirectory?.();
          const resolved = resolveProjectDirectoryForCreation(selectedPath, appShellSettings.appLanguage);
          if (!resolved.path) return client.loadDashboard();
          await client.createProject({
            name: resolved.path.split('/').filter(Boolean).at(-1) ?? 'Zeus',
            localPath: resolved.path,
            description: resolved.description,
            ...defaults,
          });
          return client.loadDashboard();
        }}
        onArchiveProject={async (projectId) => {
          await client.archiveProject(projectId);
          return client.loadDashboard();
        }}
        onLoadProjects={(query) => client.loadProjects({ query })}
        onLoadProject={(projectId) => client.loadProject(projectId)}
        onLoadProjectConfig={(projectId) => client.loadProjectConfig(projectId)}
        onSaveProjectConfig={(projectId, input) => client.saveProjectConfig(projectId, input)}
        onLoadProjectDatabaseSecret={(projectId) => client.loadProjectDatabaseSecret(projectId)}
        onSaveProjectDatabasePassword={(projectId, password) => client.saveProjectDatabasePassword(projectId, password)}
        onClearProjectDatabasePassword={(projectId) => client.clearProjectDatabasePassword(projectId)}
        onUpdateProject={async (projectId, input) => {
          await client.updateProject(projectId, input);
          return client.loadDashboard();
        }}
        onDeleteProject={async (projectId) => {
          await client.deleteProject(projectId);
          return client.loadDashboard();
        }}
        onCreateProjectArchiveConfirmation={(projectId) => client.createProjectArchiveConfirmation(projectId)}
        onRestoreProject={async (projectId) => {
          await client.restoreProject(projectId);
          return client.loadDashboard();
        }}
        onLoadArchivedProjects={() => client.loadArchivedProjects()}
        onLoadArchivedTasks={(projectId) => client.loadArchivedTasks(projectId)}
        onSetProjectDefaultTemplate={async (projectId, templateId) => {
          await client.setProjectDefaultTemplate(projectId, templateId);
          return client.loadDashboard();
        }}
        onSaveTaskPastedAttachments={(attachments) => window.zeus?.saveTaskPastedAttachments?.(attachments) ?? Promise.resolve([])}
        onSaveTaskClipboardAttachments={() => window.zeus?.saveTaskClipboardAttachments?.() ?? Promise.resolve([])}
        onLoadTaskAttachmentPreview={(path) => window.zeus?.getTaskAttachmentPreview?.(path) ?? Promise.resolve(null)}
        onOpenTaskAttachment={(path) => window.zeus?.openTaskAttachment?.(path) ?? Promise.resolve({ opened: false, error: 'open_attachment_unavailable' })}
        onReadTaskClipboardAttachments={() => window.zeus?.readTaskClipboardAttachments?.() ?? Promise.resolve([])}
        onReadTaskClipboardImage={() => window.zeus?.readTaskClipboardImage?.() ?? Promise.resolve(null)}
        onCreateTaskFromGraphNode={async (nodeId, projectId) => {
          await client.createTaskFromGraphNode(nodeId, {
            projectId,
            intent: buildGraphNodeTaskIntent(appShellSettings.appLanguage),
          });
          return client.loadDashboard();
        }}
        onCreateTaskFromTemplate={async (templateId, projectId) => {
          const templateTaskDraft = buildTemplateTaskDraft(appShellSettings.appLanguage);
          await client.createTaskFromTemplate(templateId, {
            projectId,
            title: templateTaskDraft.title,
            variables: {
              project_path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
              ...templateTaskDraft.variables,
            },
          });
          return client.loadDashboard();
        }}
        onChooseTaskAttachments={() => window.zeus?.chooseTaskAttachments?.() ?? Promise.resolve([])}
        onCreateTaskDraft={async (projectId, draft) => {
          await client.createTask({
            projectId,
            title: draft.title,
            description: draft.description,
            tags: draft.tags,
            sourceContext: {
              path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
              attachments: draft.attachments,
            },
          });
          return client.loadDashboard();
        }}
        onLoadTasks={async (projectId, query, status, tag, sortBy) =>
          client.loadTasks({
            projectId,
            query,
            status,
            tag,
            sortBy,
            sortDirection: 'asc',
          })
        }
        onLoadTask={(taskId) => client.loadTask(taskId)}
        onUpdateTask={async (taskId, input) => {
          await client.updateTask(taskId, input);
          return client.loadDashboard();
        }}
        onUpdateTaskTags={async (taskId, tags) => {
          await client.updateTaskTags(taskId, tags);
          return client.loadDashboard();
        }}
        onDeleteTask={async (taskId) => {
          await client.deleteTask(taskId);
          return client.loadDashboard();
        }}
        onRunTask={async (taskId) => {
          const result = await client.runTask(taskId);
          return {
            snapshot: await client.loadDashboard(),
            task: result.task,
            conversation: result.conversation,
            runtimeError: result.runtimeError,
          };
        }}
        onPauseTask={async (taskId) => {
          await client.pauseTask(taskId);
          return client.loadDashboard();
        }}
        onContinueTask={async (taskId) => {
          const result = await client.continueTask(taskId);
          return {
            snapshot: await client.loadDashboard(),
            task: result.task,
            conversation: result.conversation,
            runtimeError: result.runtimeError,
          };
        }}
        onCancelTask={async (taskId) => {
          await client.cancelTask(taskId);
          return client.loadDashboard();
        }}
        onRetryTask={async (taskId) => {
          await client.retryTask(taskId);
          return client.loadDashboard();
        }}
        onScanCurrentGraph={async () => {
          await client.scanCurrentGraph();
          return client.loadDashboard();
        }}
        onLoadGraphView={(viewType) => client.loadGraphView(viewType ?? 'architecture')}
        onSearchGraph={(query, nodeType, edgeType, minConfidence) => client.searchGraph({ query, nodeType, edgeType, minConfidence })}
        onScanProjectGraph={async (projectId) => {
          await client.scanProject(projectId);
          return client.loadDashboard();
        }}
        onLoadProjectGraphView={(projectId, viewType) => client.loadProjectGraphView(projectId, viewType ?? 'architecture')}
        onSearchProjectGraph={(projectId, query, nodeType, edgeType, minConfidence) => client.searchProjectGraph(projectId, { query, nodeType, edgeType, minConfidence })}
        onAskGraph={(projectId, question) => client.askGraph(projectId, { question })}
        onLoadGraphConversations={(projectId, input) => client.loadGraphConversations(projectId, input)}
        onLoadGraphConversation={(projectId, conversationId) => client.loadGraphConversation(projectId, conversationId)}
        onSendConversationMessage={(projectId, conversationId, content) => client.sendConversationMessage(projectId, conversationId, content)}
        onSubscribeRealtimeEvents={(onEvent) => {
          const socket = client.connectEvents(onEvent);
          return () => socket.close();
        }}
        onArchiveGraphConversation={(projectId, conversationId) => client.archiveGraphConversation(projectId, conversationId)}
        onRestoreGraphConversation={(projectId, conversationId) => client.restoreGraphConversation(projectId, conversationId)}
        onCreateTaskFromGraphConversation={async (projectId, conversationId) => {
          await client.createTaskFromGraphConversation(projectId, conversationId, { intent: buildGraphConversationTaskIntent(appShellSettings.appLanguage) });
          return client.loadDashboard();
        }}
        onOpenGraphSource={(source) => openGraphSourceInMain({ zeus: window.zeus, source })}
        onExportMermaidDiagramFile={(payload) => window.zeus?.exportMermaidDiagramToFile?.(payload) ?? Promise.resolve({ saved: false, filePath: null })}
        onExportPlantUmlDiagramFile={(payload) => window.zeus?.exportPlantUmlDiagramToFile?.(payload) ?? Promise.resolve({ saved: false, filePath: null })}
        onLoadTaskTemplates={(projectId) => client.loadTaskTemplates(projectId)}
        onLoadGitDiff={() => client.loadGitDiff()}
        onExportGitPatch={() => client.exportGitPatch()}
        onExportPatchFile={(patch) => window.zeus?.exportPatchToFile?.(patch) ?? Promise.resolve({ saved: false, filePath: null })}
        onLoadRuntimeStatus={() => client.loadRuntimeStatus()}
        onLoadReleaseStatus={() => client.loadReleaseStatus()}
        onCheckReleaseUpdate={() => client.checkReleaseUpdate()}
        onLoadRuntimeSettings={() => client.loadRuntimeSettings()}
        onSaveRuntimeSettings={(input) => client.saveRuntimeSettings(input)}
        onLoadCodeMapSettings={() => client.loadCodeMapSettings()}
        onSaveCodeMapSettings={(input) => client.saveCodeMapSettings(input)}
        onLoadAppShellSettings={() => client.loadAppShellSettings()}
        onSaveAppShellSettings={(input) => client.saveAppShellSettings(input)}
        onLoadCodexLegacyImports={() => client.loadCodexLegacyImports()}
        onStartCodexLegacyImport={(sourceConversationIds) => client.startCodexLegacyImport(sourceConversationIds)}
        onClearLocalCaches={() => client.clearLocalCaches()}
        onExportLocalSettings={() => client.exportLocalSettings()}
        onImportLocalSettings={(input) => client.importLocalSettings(input)}
        onExportLocalBusinessData={() => client.exportLocalBusinessData()}
        onImportLocalBusinessData={(input) => client.importLocalBusinessData(input)}
        onExportSettingsFile={(snapshot) => window.zeus?.exportSettingsSnapshotToFile?.(snapshot) ?? Promise.resolve({ saved: false, filePath: null })}
        onExportBusinessDataFile={(snapshot) => window.zeus?.exportSettingsSnapshotToFile?.(snapshot) ?? Promise.resolve({ saved: false, filePath: null })}
        onImportSettingsFile={() => window.zeus?.importSettingsSnapshotFromFile?.() ?? Promise.resolve({ imported: false, filePath: null })}
        onImportBusinessDataFile={() => window.zeus?.importBusinessDataSnapshotFromFile?.() ?? Promise.resolve({ imported: false, filePath: null })}
        onLoadRuntimeAdapters={() => client.loadRuntimeAdapters()}
        onCheckRuntimeAdapter={(adapterId) => client.checkRuntimeAdapter(adapterId)}
        onLoadRuntimeSessions={() => client.loadRuntimeSessions()}
        onCreateRuntimeConfirmation={(input) => client.createRuntimeConfirmation(input)}
        onConfirmRuntimeOperation={(confirmationId) => client.confirmRuntimeOperation(confirmationId)}
        onRejectRuntimeOperation={(confirmationId, reason) => client.rejectRuntimeOperation(confirmationId, reason)}
        onStartRuntimeSession={(input) => client.startRuntimeSession(input)}
        onStopRuntimeSession={(sessionId) => client.stopRuntimeSession(sessionId)}
        onLoadRuntimeSessionLogs={(sessionId) => client.loadRuntimeSessionLogs(sessionId)}
        onSendRuntimeInput={(sessionId, input) => client.sendRuntimeInput(sessionId, input)}
        onInterruptRuntimeSession={(sessionId) => client.interruptRuntimeSession(sessionId)}
        onResizeRuntimeSession={(sessionId, size) => client.resizeRuntimeSession(sessionId, size)}
        onLoadRuntimeTerminalSnapshot={(sessionId) => client.loadRuntimeTerminalSnapshot(sessionId)}
        onLoadRuntimeTerminalEvents={(sessionId, input) => client.loadRuntimeTerminalEvents(sessionId, input)}
        onGenerateRuntimeSessionSummary={(sessionId) => client.generateRuntimeSessionSummary(sessionId)}
        onSetRuntimeSessionFavorite={(sessionId, favorite) => client.setRuntimeSessionFavorite(sessionId, favorite)}
        onArchiveRuntimeSession={(sessionId) => client.archiveRuntimeSession(sessionId)}
        onRestoreRuntimeSession={(sessionId) => client.restoreRuntimeSession(sessionId)}
        onDeleteRuntimeSession={(sessionId) => client.deleteRuntimeSession(sessionId)}
        onCreateTaskFromRuntimeSession={async (sessionId, input) => {
          await client.createTaskFromRuntimeSession(sessionId, input);
          return client.loadDashboard();
        }}
        onLoadSecuritySecrets={() => client.loadSecuritySecrets()}
        onLoadSecurityAuditLogs={() => client.loadSecurityAuditLogs()}
        onSaveTelegramBotToken={(token) => client.saveTelegramBotToken(token)}
        onClearTelegramBotToken={() => client.clearTelegramBotToken()}
        onSaveExternalApiKey={(key) => client.saveExternalApiKey(key)}
        onClearExternalApiKey={() => client.clearExternalApiKey()}
        onResetSecurity={() => client.resetSecurity()}
        onLoadTelegramPollingStatus={() => client.loadTelegramPollingStatus()}
        onLoadTelegramPollingLogs={() => client.loadTelegramMessages()}
        onStartTelegramPolling={() => client.startTelegramPolling()}
        onStopTelegramPolling={() => client.stopTelegramPolling()}
        onPollTelegramOnce={() => client.pollTelegramOnce()}
        onTestTelegramConnection={() => client.testTelegramConnection()}
        onLoadTelegramNotificationSettings={() => client.loadTelegramNotificationSettings()}
        onSaveTelegramNotificationSettings={(input) => client.saveTelegramNotificationSettings(input)}
        onLoadTelegramSecuritySettings={() => client.loadTelegramSecuritySettings()}
        onSaveTelegramSecuritySettings={(input) => client.saveTelegramSecuritySettings(input)}
        onLoadTaskEvents={(taskId) => client.loadTaskEvents(taskId)}
        onUpdateTaskStatus={async (taskId, status) => {
          await client.updateTaskStatus(taskId, status);
          return client.loadDashboard();
        }}
        onArchiveTask={async (taskId) => {
          await client.archiveTask(taskId);
          return client.loadDashboard();
        }}
        onRestoreTask={async (taskId) => {
          await client.restoreTask(taskId);
          return client.loadDashboard();
        }}
        onCreateGitConfirmation={(operation, message) =>
          client.createGitConfirmation({
            operation,
            reason: gitOperationReason(operation),
            message,
          })
        }
        onConfirmGitOperation={(confirmationId) => client.confirmGitOperation(confirmationId)}
        onRejectGitOperation={(confirmationId, reason) => client.rejectGitOperation(confirmationId, reason)}
        onExecuteGitOperation={(input) => client.executeGitOperation(input)}
      />
      <RendererBootstrapReady />
    </RendererErrorBoundary>,
  );
}

/** React 首次 commit 后再通知 Main；在此之前的模块、加载和渲染异常都由启动监控器兜底。 */
function RendererBootstrapReady(): null {
  useEffect(() => {
    window.zeus?.reportRendererBootstrapReady?.();
  }, []);
  return null;
}

function gitOperationReason(operation: string): string {
  const reasons: Record<string, string> = {
    stash: '用户从 Git Diff 面板请求暂存当前变更',
    commit: '用户从 Git Diff 面板请求提交已审查变更',
    branch: '用户从 Git Diff 面板请求创建分支',
    switch_branch: '用户从 Git Diff 面板请求切换已有分支',
    apply_stash: '用户从 Git Diff 面板请求恢复 stash',
    pull: '用户从 Git Diff 面板请求拉取远端变更',
    push: '用户从 Git Diff 面板请求推送分支',
    rollback: '用户从 Git Diff 面板请求回滚工作区',
  };
  return reasons[operation] ?? '用户从 Git Diff 面板请求执行 Git 高风险操作';
}

async function hydrateDashboard(): Promise<void> {
  if (!window.zeus?.getLocalServerConfig) throw new Error('Electron 本地桥接未就绪');
  const config = await window.zeus.getLocalServerConfig();
  await renderWithClient(
    createDashboardClient({
      ...config,
      refreshLocalServerConfig: window.zeus.getLocalServerConfig,
    }),
  );
}

hydrateDashboard().catch((error: unknown) => {
  console.error('Zeus dashboard hydration failed', error);
  reportRendererFatalFailure(error);
});

function reportRendererFatalFailure(error: unknown): void {
  window.zeus?.reportRendererFatalFailure?.(formatHydrationError(error));
}

function formatHydrationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.split('\n')[0]?.slice(0, 180) ?? '未知错误';
  if (typeof error === 'string' && error.trim()) return error.split('\n')[0]?.slice(0, 180) ?? '未知错误';
  return '未知错误';
}
