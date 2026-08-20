import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RendererErrorBoundary } from './ErrorBoundary.js';
import { createDashboardClient, type DashboardClient, type ExecutionHostTransition } from './apiClient.js';
import { openGraphSourceInMain, revealProjectInFinderInMain } from './appShellBridge.js';
import { initializeNativeCloseLayerRouting } from './ui/nativeCloseLayer.js';
import { ApplicationErrorDialogHost, reportApplicationError } from './ui/ApplicationErrorDialog.js';

initializeNativeCloseLayerRouting();

async function renderWithClient(client: DashboardClient, executionHostTransition?: ExecutionHostTransition): Promise<void> {
  const { App, buildGraphConversationTaskIntent, buildGraphNodeTaskIntent, buildProjectDirectoryResolution, buildTemplateTaskDraft } = await import('./App.js');
  const snapshot = await client.loadDashboard();
  const appShellSettings = await client.loadAppShellSettings();
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  const reactRoot = createRoot(root);
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  reactRoot.render(
    <>
      <RendererErrorBoundary
        appLanguage={appShellSettings.appLanguage}
        onFatalError={(error, info) => {
          reportRendererFatalFailure(error);
          reportApplicationError(error, {
            language: errorLanguage,
            title: errorLanguage === 'zh-CN' ? 'Zeus 遇到界面错误' : 'Zeus encountered an interface error',
            summary: errorLanguage === 'zh-CN' ? '当前界面已安全暂停。你可以查看详情，然后刷新窗口恢复。' : 'The current interface is safely paused. Review the details, then refresh the window to recover.',
            source: 'RendererErrorBoundary',
            details: `${error.message}\n${info.componentStack ?? ''}`,
            primaryAction: {
              label: errorLanguage === 'zh-CN' ? '刷新窗口' : 'Refresh window',
              run: () => globalThis.location?.reload(),
            },
          });
        }}
      >
        <App
          initialAppShellSettings={appShellSettings}
          snapshot={snapshot}
          executionHostTransition={executionHostTransition}
          nativeConversationClient={client}
          commandClient={client}
          onChooseProjectDirectory={async () => {
            const selectedPath = await window.zeus?.chooseProjectDirectory?.();
            // 选择真实仓库失败或取消时保留现有列表；开源分发包不能内置维护者本机路径。
            const resolved = buildProjectDirectoryResolution(selectedPath, appShellSettings.appLanguage);
            return resolved.path;
          }}
          onCreateCurrentProject={async (request) => {
            await client.createProject(request);
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
          onRevealProjectInFinder={(projectPath) => revealProjectInFinderInMain({ zeus: window.zeus, projectPath })}
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
          onAuthorizeTaskFiles={(files, source) => window.zeus?.authorizeTaskFiles?.(files, source) ?? Promise.resolve({ resources: [], failedCount: files.length })}
          onMaterializeTaskResources={(resources) => window.zeus?.materializeTaskResources?.(resources) ?? Promise.resolve([])}
          onReadTaskClipboardResources={() => window.zeus?.readTaskClipboardResources?.() ?? Promise.resolve({ resources: [], text: '' })}
          onParseZentaoTaskLink={(url) => window.zeus?.parseZentaoTaskLink?.(url) ?? Promise.resolve({ kind: 'unsupported', sourceUrl: url })}
          onLoadTaskAttachmentPreview={(path) => window.zeus?.getTaskAttachmentPreview?.(path) ?? Promise.resolve(null)}
          onOpenTaskAttachment={(path) => window.zeus?.openTaskAttachment?.(path) ?? Promise.resolve({ opened: false, error: 'open_attachment_unavailable' })}
          onCreateTaskFromGraphNode={async (nodeId, projectId, idempotencyKey) => {
            await client.createTaskFromGraphNode(nodeId, {
              projectId,
              intent: buildGraphNodeTaskIntent(appShellSettings.appLanguage),
              idempotencyKey,
            });
            return client.loadDashboard();
          }}
          onCreateTaskFromTemplate={async (templateId, projectId, idempotencyKey) => {
            const templateTaskDraft = buildTemplateTaskDraft(appShellSettings.appLanguage);
            await client.createTaskFromTemplate(templateId, {
              idempotencyKey,
              projectId,
              title: templateTaskDraft.title,
              variables: {
                project_path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
                ...templateTaskDraft.variables,
              },
            });
            return client.loadDashboard();
          }}
          onChooseConversationResources={() => window.zeus?.chooseConversationResources?.() ?? Promise.resolve([])}
          onChooseTaskAttachments={() => window.zeus?.chooseTaskAttachments?.() ?? Promise.resolve([])}
          onCreateTaskDraft={async (projectId, draft, idempotencyKey) => {
            await client.createTask({
              idempotencyKey,
              projectId,
              parentTaskId: draft.parentTaskId,
              title: draft.title,
              taskType: draft.taskType,
              description: draft.description,
              defectCurrentState: draft.defectCurrentState,
              defectExpectedOutcome: draft.defectExpectedOutcome,
              defectReproductionSteps: draft.defectReproductionSteps,
              optimizationCurrentState: draft.optimizationCurrentState,
              optimizationExpectedOutcome: draft.optimizationExpectedOutcome,
              tags: draft.tags,
              priority: draft.priority,
              sourceContext: {
                path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
                attachments: draft.attachments,
              },
            });
            return client.loadDashboard();
          }}
          onLoadTasks={async (projectId, query, managementStatus, tag, sortBy) =>
            client.loadTasks({
              projectId,
              query,
              managementStatus,
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
          onUpdateTaskRelationships={async (taskId, input) => {
            await client.updateTaskRelationships(taskId, input);
            return client.loadDashboard();
          }}
          onUpdateTaskTags={async (taskId, tags, expectedUpdatedAt) => {
            await client.updateTaskTags(taskId, tags, expectedUpdatedAt);
            return client.loadDashboard();
          }}
          onDeleteTask={async (taskId, input) => {
            await client.deleteTask(taskId, input);
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
          onLoadGraphNeighborhood={(nodeId, depth) => client.loadGraphNeighborhood(nodeId, depth)}
          onSearchGraph={(query, nodeType, edgeType, minConfidence) => client.searchGraph({ query, nodeType, edgeType, minConfidence })}
          onScanProjectGraph={async (projectId) => {
            await client.scanProject(projectId);
            return client.loadDashboard();
          }}
          onLoadProjectGraphView={(projectId, viewType) => client.loadProjectGraphView(projectId, viewType ?? 'architecture')}
          onLoadProjectGraphNeighborhood={(projectId, nodeId, depth) => client.loadProjectGraphNeighborhood(projectId, nodeId, depth)}
          onSearchProjectGraph={(projectId, query, nodeType, edgeType, minConfidence) => client.searchProjectGraph(projectId, { query, nodeType, edgeType, minConfidence })}
          onAskGraph={(projectId, question) => client.askGraph(projectId, { question })}
          onLoadGraphConversations={(projectId, input) => client.loadGraphConversations(projectId, input)}
          onLoadGraphConversation={(projectId, conversationId) => client.loadGraphConversation(projectId, conversationId)}
          onSendConversationMessage={(projectId, conversationId, content) => client.sendConversationMessage(projectId, conversationId, content)}
          onSubscribeRealtimeEvents={(onEvent, onConnectionState) => client.subscribeEvents(onEvent, onConnectionState)}
          onArchiveGraphConversation={(projectId, conversationId) => client.archiveGraphConversation(projectId, conversationId)}
          onRestoreGraphConversation={(projectId, conversationId) => client.restoreGraphConversation(projectId, conversationId)}
          onCreateTaskFromGraphConversation={async (projectId, conversationId, idempotencyKey) => {
            await client.createTaskFromGraphConversation(projectId, conversationId, { intent: buildGraphConversationTaskIntent(appShellSettings.appLanguage), idempotencyKey });
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
          onInspectCodexConfigImport={() => client.inspectCodexConfigImport()}
          onImportCodexConfig={() => client.importCodexConfig()}
          onActivateCodexConfig={() => client.activateCodexConfig()}
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
          onCreateTaskFromRuntimeSession={async (sessionId, input, idempotencyKey) => {
            await client.createTaskFromRuntimeSession(sessionId, { ...input, idempotencyKey });
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
          onUpdateTaskManagementStatus={async (taskId, status, expectedUpdatedAt, confirmWorktreeCleanup, reopenConversationId) => {
            await client.updateTaskManagementStatus(taskId, status, expectedUpdatedAt, confirmWorktreeCleanup, reopenConversationId);
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
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
  );
}

async function renderMenuBarUsageWithClient(client: DashboardClient): Promise<void> {
  const [{ MenuBarUsageWindow }, appShellSettings] = await Promise.all([import('./settings/MenuBarUsageWindow.js'), client.loadAppShellSettings().catch(() => ({ appLanguage: 'zh-CN' as const, appearance: 'system' as const }))]);
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  document.body.dataset.surface = 'menu-bar-usage';
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  createRoot(root).render(
    <>
      <RendererErrorBoundary appLanguage={appShellSettings.appLanguage} onFatalError={(error) => reportSurfaceFatalError(error, errorLanguage, 'MenuBarUsageWindow')}>
        <MenuBarUsageWindow client={client} language={appShellSettings.appLanguage} appearance={appShellSettings.appearance} />
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
  );
}

async function renderTaskGitDeliveryWithClient(client: DashboardClient, taskId: string): Promise<void> {
  const [{ TaskGitDeliveryWindow }, task, snapshot, appShellSettings, currentContext] = await Promise.all([
    import('./task/TaskGitDeliveryWindow.js'),
    client.loadTask(taskId),
    client.loadDashboard(),
    client.loadAppShellSettings(),
    window.zeus?.getTaskGitDeliveryCurrentContext?.() ?? Promise.resolve({ taskId: null, workspaceId: null }),
  ]);
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  const projectName = snapshot.projects.find((project) => project.id === task.projectId)?.name;
  document.body.dataset.surface = 'task-git-delivery';
  document.title = `${appShellSettings.appLanguage === 'zh-CN' ? '代码交付' : 'Code Delivery'} · ${task.taskCode ?? task.id}`;
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  createRoot(root).render(
    <>
      <RendererErrorBoundary appLanguage={appShellSettings.appLanguage} onFatalError={(error) => reportSurfaceFatalError(error, errorLanguage, 'TaskGitDeliveryWindow')}>
        <TaskGitDeliveryWindow client={client} task={task} projectName={projectName} language={appShellSettings.appLanguage} appearance={appShellSettings.appearance} initialCurrentContext={currentContext} />
        <RendererBootstrapReady />
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
  );
}

async function renderProjectGitDiffWithClient(client: DashboardClient, parameters: URLSearchParams): Promise<void> {
  const [{ ProjectGitDiffWindow }, appShellSettings] = await Promise.all([import('./git/ProjectGitDiffViewer.js'), client.loadAppShellSettings()]);
  const projectId = parameters.get('projectId')?.trim();
  const repositoryId = parameters.get('repositoryId')?.trim();
  const filePath = parameters.get('filePath') ?? '';
  if (!projectId || !repositoryId) throw new Error('仓库差异窗口缺少项目或仓库身份。');
  const stage = parameters.get('stage') === 'staged' || parameters.get('stage') === 'unstaged' ? (parameters.get('stage') as 'staged' | 'unstaged') : 'combined';
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  document.body.dataset.surface = 'project-git-diff';
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  createRoot(root).render(
    <>
      <RendererErrorBoundary appLanguage={appShellSettings.appLanguage} onFatalError={(error) => reportSurfaceFatalError(error, errorLanguage, 'ProjectGitDiffWindow')}>
        <ProjectGitDiffWindow
          client={client}
          projectId={projectId}
          repositoryId={repositoryId}
          filePath={filePath}
          stage={stage}
          commitHash={parameters.get('commitHash') ?? undefined}
          comparisonRef={parameters.get('comparisonRef') ?? undefined}
          comparisonMode={parameters.get('comparisonMode') === 'working-tree' ? 'working-tree' : 'current'}
          language={appShellSettings.appLanguage}
        />
        <RendererBootstrapReady />
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
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

async function hydrateRenderer(): Promise<void> {
  if (!window.zeus?.getLocalServerConfig) throw new Error('Electron 本地桥接未就绪');
  await waitForConversationStoreMigration();
  const config = await window.zeus.getLocalServerConfig();
  const client = createDashboardClient({
    ...config,
    refreshLocalServerConfig: window.zeus.getLocalServerConfig,
    ...(window.zeus.loadProjectGitWorkbench
      ? {
          projectGitWorkbench: {
            loadWorkbench: window.zeus.loadProjectGitWorkbench,
            loadCommit: (projectId, repositoryId, commitHash) => window.zeus!.loadProjectGitCommit({ projectId, repositoryId, commitHash }),
            loadComparison: (projectId, repositoryId, ref, mode) => window.zeus!.loadProjectGitComparisonDiff({ projectId, repositoryId, ref, mode }),
            execute: (projectId, repositoryId, action) => window.zeus!.executeProjectGitAction({ projectId, repositoryId, action }),
          },
        }
      : {}),
  });
  const parameters = new URLSearchParams(window.location.search);
  const surface = parameters.get('surface');
  if (surface === 'menu-bar-usage') {
    await renderMenuBarUsageWithClient(client);
    return;
  }
  if (surface === 'task-git-delivery') {
    const taskId = parameters.get('taskId')?.trim();
    if (!taskId) throw new Error('代码交付窗口缺少任务身份。');
    await renderTaskGitDeliveryWithClient(client, taskId);
    return;
  }
  if (surface === 'project-git-diff') {
    await renderProjectGitDiffWithClient(client, parameters);
    return;
  }
  await renderWithClient(client, config.executionHostTransition);
}

async function waitForConversationStoreMigration(): Promise<void> {
  const bridge = window.zeus;
  if (!bridge?.getConversationStoreMigrationStatus) return;
  await new Promise((resolve) => setTimeout(resolve, 180));
  let status = await bridge.getConversationStoreMigrationStatus();
  if (!status || status.phase === 'completed' || status.phase === 'not_required') return;
  bridge.reportRendererBootstrapReady?.();
  while (status && status.phase !== 'completed' && status.phase !== 'not_required') {
    renderConversationStoreMigration(status);
    if (status.phase === 'failed' || status.phase === 'promoted_but_validation_failed') await new Promise<void>(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await bridge.getConversationStoreMigrationStatus();
  }
  document.getElementById('root')?.replaceChildren();
}

function renderConversationStoreMigration(status: NonNullable<Awaited<ReturnType<NonNullable<Window['zeus']>['getConversationStoreMigrationStatus']>>>): void {
  const root = document.getElementById('root');
  if (!root) return;
  const shell = document.createElement('main');
  shell.className = 'zeus-conversation-migration';
  Object.assign(shell.style, {
    minHeight: '100%',
    display: 'grid',
    placeItems: 'center',
    padding: '32px',
    boxSizing: 'border-box',
    background: '#f7f7f8',
    color: '#202124',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  const panel = document.createElement('section');
  Object.assign(panel.style, { width: 'min(620px, 100%)', padding: '28px', border: '1px solid #dedfe3', borderRadius: '18px', background: '#fff', boxSizing: 'border-box' });
  const title = document.createElement('h1');
  const migrationFailed = status.phase === 'failed' || status.phase === 'promoted_but_validation_failed';
  title.textContent = migrationFailed ? '会话数据升级已安全暂停' : '正在升级会话数据';
  Object.assign(title.style, { margin: '0 0 12px', fontSize: '22px', lineHeight: '1.3' });
  const detail = document.createElement('p');
  detail.textContent = migrationFailed
    ? status.phase === 'promoted_but_validation_failed'
      ? `候选库已提升为正式数据库，但提升后校验未完成。请查看诊断并重试收敛状态。${status.error?.message ? `\n${status.error.message}` : ''}`
      : (status.error?.message ?? '候选库未通过校验，正式数据库没有被替换。')
    : `${migrationPhaseLabel(status.phase)}。升级完成前，本地服务和正常业务界面不会启动。`;
  Object.assign(detail.style, { margin: '0', color: '#5f6368', lineHeight: '1.65', whiteSpace: 'pre-wrap' });
  panel.append(title, detail);
  if (migrationFailed) {
    const actions = document.createElement('div');
    Object.assign(actions.style, { display: 'flex', gap: '10px', marginTop: '22px', flexWrap: 'wrap' });
    const retry = migrationButton('重试迁移', true);
    retry.onclick = async () => {
      retry.disabled = true;
      retry.textContent = '正在重试…';
      try {
        await window.zeus?.retryConversationStoreMigration?.();
      } catch (error) {
        retry.disabled = false;
        retry.textContent = '重试迁移';
        detail.textContent = error instanceof Error ? error.message : String(error);
      }
    };
    const diagnostics = migrationButton('查看诊断', false);
    diagnostics.onclick = () => void window.zeus?.openConversationStoreMigrationDiagnostics?.();
    const exit = migrationButton('退出 Zeus', false);
    exit.onclick = () => void window.zeus?.exitConversationStoreMigration?.();
    actions.append(retry, diagnostics, exit);
    panel.append(actions);
  }
  shell.append(panel);
  root.replaceChildren(shell);
}

function migrationButton(label: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  Object.assign(button.style, {
    minHeight: '38px',
    padding: '0 16px',
    borderRadius: '10px',
    border: primary ? '1px solid #202124' : '1px solid #d0d2d7',
    background: primary ? '#202124' : '#fff',
    color: primary ? '#fff' : '#202124',
    cursor: 'pointer',
  });
  return button;
}

function migrationPhaseLabel(phase: string): string {
  if (phase === 'preflight') return '正在检查磁盘空间、权限和数据库锁';
  if (phase === 'candidate_build') return '正在构建候选库和安全回退库';
  if (phase === 'candidate_validation') return '正在逐项校验迁移映射和数据库一致性';
  if (phase === 'promotion') return '正在同卷原子提升候选库';
  if (phase === 'promoted_but_validation_failed') return '候选库已经提升，正在等待提升后校验收敛';
  return '正在准备会话数据';
}

hydrateRenderer().catch((error: unknown) => {
  const surface = new URLSearchParams(window.location.search).get('surface');
  const auxiliarySurface = surface === 'menu-bar-usage' || surface === 'task-git-delivery' || surface === 'project-git-diff';
  console.error(surface === 'menu-bar-usage' ? 'Zeus menu bar usage hydration failed' : surface === 'task-git-delivery' ? 'Zeus task Git delivery hydration failed' : 'Zeus dashboard hydration failed', error);
  const root = document.getElementById('root');
  reportApplicationError(error, {
    language: 'zh-CN',
    title: auxiliarySurface ? '窗口加载失败' : 'Zeus 启动失败',
    summary: auxiliarySurface ? '当前窗口未能完成加载。查看详情后请关闭窗口并重试。' : 'Zeus 未能完成界面加载。查看详情后请重新打开应用。',
    source: surface ?? 'dashboard',
  });
  if (root) createRoot(root).render(<ApplicationErrorDialogHost language="zh-CN" />);
  if (!auxiliarySurface) reportRendererFatalFailure(error);
});

function reportSurfaceFatalError(error: Error, language: 'zh-CN' | 'en', source: string): void {
  console.error(`Zeus ${source} render failed`, error);
  reportApplicationError(error, {
    language,
    title: language === 'zh-CN' ? '窗口遇到界面错误' : 'The window encountered an interface error',
    summary: language === 'zh-CN' ? '当前窗口已安全暂停。请查看详情，然后关闭并重新打开窗口。' : 'The window is safely paused. Review the details, then close and reopen it.',
    source,
  });
}

function reportRendererFatalFailure(error: unknown): void {
  window.zeus?.reportRendererFatalFailure?.(formatHydrationError(error));
}

function formatHydrationError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.split('\n')[0]?.slice(0, 180) ?? '未知错误';
  if (typeof error === 'string' && error.trim()) return error.split('\n')[0]?.slice(0, 180) ?? '未知错误';
  return '未知错误';
}
