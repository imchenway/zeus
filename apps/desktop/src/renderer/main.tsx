import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { RendererErrorBoundary } from './ErrorBoundary.js';
import { createDashboardClient, type DashboardClient } from './apiClient.js';
import { openGraphSourceInMain } from './appShellBridge.js';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Zeus renderer root element is missing');
}

const reactRoot = createRoot(root);
reactRoot.render(
  <RendererErrorBoundary>
    <App localClientStatus="connecting" />
  </RendererErrorBoundary>,
);

/** 选择真实仓库失败或取消时保留现有列表；开源分发包不能内置维护者本机路径。 */
function resolveProjectDirectoryForCreation(selectedPath: string | null | undefined): { path: string | null; description: string } {
  if (selectedPath) return { path: selectedPath, description: '用户选择的真实本地仓库' };
  return { path: null, description: '用户取消选择，已保留当前项目列表' };
}

async function renderWithClient(client: DashboardClient): Promise<void> {
  const snapshot = await client.loadDashboard();
  reactRoot.render(
    <RendererErrorBoundary>
      <App
        localClientStatus="ready"
        snapshot={snapshot}
        onCreateCurrentProject={async (defaults) => {
          const selectedPath = await window.zeus?.chooseProjectDirectory?.();
          const resolved = resolveProjectDirectoryForCreation(selectedPath);
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
        onCreateTaskFromGraphNode={async (nodeId, projectId) => {
          await client.createTaskFromGraphNode(nodeId, {
            projectId,
            intent: '分析该图谱节点的实现风险、影响范围和建议测试范围',
          });
          return client.loadDashboard();
        }}
        onCreateTaskFromTemplate={async (templateId, projectId) => {
          await client.createTaskFromTemplate(templateId, {
            projectId,
            title: '从模板创建的任务',
            variables: {
              project_path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
              goal: '基于模板补充真实任务目标',
            },
          });
          return client.loadDashboard();
        }}
        onCreateDefaultTask={async (projectId) => {
          await client.createTask({
            projectId,
            title: '分析当前项目结构',
            description: '基于真实扫描和 Git 状态分析当前 Zeus 仓库',
            sourceContext: {
              path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
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
          await client.runTask(taskId);
          return client.loadDashboard();
        }}
        onPauseTask={async (taskId) => {
          await client.pauseTask(taskId);
          return client.loadDashboard();
        }}
        onContinueTask={async (taskId) => {
          await client.continueTask(taskId);
          return client.loadDashboard();
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
        onAskGraph={(projectId, question) => client.askGraph(projectId, { question })}
        onLoadGraphConversations={(projectId, input) => client.loadGraphConversations(projectId, input)}
        onLoadGraphConversation={(projectId, conversationId) => client.loadGraphConversation(projectId, conversationId)}
        onArchiveGraphConversation={(projectId, conversationId) => client.archiveGraphConversation(projectId, conversationId)}
        onRestoreGraphConversation={(projectId, conversationId) => client.restoreGraphConversation(projectId, conversationId)}
        onCreateTaskFromGraphConversation={async (projectId, conversationId) => {
          await client.createTaskFromGraphConversation(projectId, conversationId, { intent: '基于这次图谱问答创建可执行跟进任务' });
          return client.loadDashboard();
        }}
        onOpenGraphSource={(source) => openGraphSourceInMain({ zeus: window.zeus, source })}
        onExportMermaidDiagramFile={(payload) => window.zeus?.exportMermaidDiagramToFile?.(payload) ?? Promise.resolve({ saved: false, filePath: null })}
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
    </RendererErrorBoundary>,
  );
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
  reactRoot.render(
    <RendererErrorBoundary>
      <App localClientStatus="failed" localClientError={formatHydrationError(error)} />
    </RendererErrorBoundary>,
  );
});

function formatHydrationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.split('\n')[0]?.slice(0, 180) ?? '未知错误';
  if (typeof error === 'string' && error.trim()) return error.split('\n')[0]?.slice(0, 180) ?? '未知错误';
  return '未知错误';
}
