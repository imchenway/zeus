import { describeUserFacingError } from '@zeus/shared';
import { Profiler, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RendererErrorBoundary } from './ErrorBoundary.js';
import { createDashboardClient, type DashboardClient, type WorkspaceSnapshot, type ExecutionHostTransition, type ReadOnlyValidationIdentity, ZeusApiError } from './apiClient.js';
import { openSourceInMain, revealProjectInFinderInMain } from './appShellBridge.js';
import { initializeNativeCloseLayerRouting } from './ui/nativeCloseLayer.js';
import { ApplicationErrorDialogHost, reportApplicationError } from './ui/ApplicationErrorDialog.js';
import { RendererPerformanceCollector } from './rendererPerformanceObservability.js';
// 启动失败可能早于工作台模块加载，恢复页样式必须随入口就绪。
import './styles.css';

/** 启动阶段尚未加载设置时采用中文；设置就绪后沿用用户选择。 */
let startupLanguage: 'zh-CN' | 'en-US' = 'zh-CN';

/** 占位页只反映真实阶段；React 挂载后对应节点自然移除。 */
function showStartupStage(snapshot: { stage: string }): void {
  /** 主页读取阶段只显示启动图标。 */
  const labels: Record<string, string> = { preparing_local_data: '准备本地数据', connecting_local_service: '连接本地服务' };
  /** 隐藏空文案节点，避免保留上一阶段的描述或空白间距。 */
  const target = document.getElementById('zeus-startup-stage');
  if (!target) return;
  target.textContent = labels[snapshot.stage] ?? '';
  target.hidden = !target.textContent;
}
window.zeus?.onStartupStageChanged?.(showStartupStage);
void window.zeus?.getStartupStage?.().then(showStartupStage);
initializeNativeCloseLayerRouting();
const rendererPerformance = new RendererPerformanceCollector();
const rendererHydrationStartedAt = performance.now();
rendererPerformance.install();
Object.defineProperty(window, '__zeusPerformanceSnapshot', {
  configurable: false,
  enumerable: false,
  value: () => rendererPerformance.snapshot(),
  writable: false,
});

async function renderWithClient(
  client: DashboardClient,
  executionHostTransition?: ExecutionHostTransition,
  readOnlyValidation?: ReadOnlyValidationIdentity,
  bootstrap?: {
    appModule: Promise<typeof import('./App.js')>;
  },
): Promise<void> {
  const [appModule, snapshot, appShellSettings] = await Promise.all([
    bootstrap?.appModule ?? import('./App.js'),
    (() => {
      const startedAt = performance.now();
      return client.loadHome().then((home) => {
        window.zeus?.reportStartupSpan?.({ stage: 'home_query', durationMs: performance.now() - startedAt });
        return home;
      });
    })(),
    window.zeus?.getStartupSettings?.().then((settings) => settings ?? client.settings.loadAppShellSettings()) ?? client.settings.loadAppShellSettings(),
  ]);
  const { App, buildProjectDirectoryResolution, buildTemplateTaskDraft } = appModule;
  /** 命令回执提供精确变更，工作台自己维护已经加载的项目和分页。 */
  const changed = (change: Partial<Pick<WorkspaceSnapshot, 'projects' | 'tasks' | 'removedProjectIds' | 'removedTaskIds'>>): WorkspaceSnapshot => ({ ...snapshot, kind: 'change', projects: [], tasks: [], ...change });
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  const reactRoot = createRoot(root);
  startupLanguage = appShellSettings.appLanguage;
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  reactRoot.render(
    <>
      {readOnlyValidation ? (
        <aside
          data-zeus-read-only-validation="true"
          style={{
            position: 'fixed',
            zIndex: 2147483647,
            left: '50%',
            top: 8,
            transform: 'translateX(-50%)',
            maxWidth: 'calc(100vw - 32px)',
            padding: '6px 12px',
            border: '1px solid rgba(146, 99, 20, 0.45)',
            borderRadius: 999,
            background: 'rgba(255, 247, 224, 0.96)',
            color: '#68430b',
            boxShadow: '0 6px 22px rgba(48, 32, 8, 0.14)',
            fontSize: 12,
            fontWeight: 650,
            lineHeight: 1.4,
            pointerEvents: 'none',
          }}
        >
          正式数据只读验证 · 不会写副本或连接外部服务 · run {readOnlyValidation.runId} · manifest {readOnlyValidation.manifestHash.slice(0, 12)}
        </aside>
      ) : null}
      <RendererErrorBoundary
        appLanguage={appShellSettings.appLanguage}
        onFatalError={(error) => {
          reportApplicationError(error, {
            language: errorLanguage,
          });
        }}
      >
        <Profiler id="App" onRender={rendererPerformance.onReactRender}>
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
              return changed({ projects: [await client.projects.createProject(request)] });
            }}
            onArchiveProject={async (projectId) => {
              await client.projects.archiveProject(projectId);
              return changed({ removedProjectIds: [projectId] });
            }}
            onLoadProjects={(query) => client.projects.loadProjects({ query })}
            onLoadProject={(projectId) => client.projects.loadProject(projectId)}
            onLoadProjectConfig={(projectId) => client.projects.loadProjectConfig(projectId)}
            onSaveProjectConfig={(projectId, input) => client.projects.saveProjectConfig(projectId, input)}
            onLoadProjectDatabaseSecret={(projectId) => client.projects.loadProjectDatabaseSecret(projectId)}
            onSaveProjectDatabasePassword={(projectId, password) => client.projects.saveProjectDatabasePassword(projectId, password)}
            onClearProjectDatabasePassword={(projectId) => client.projects.clearProjectDatabasePassword(projectId)}
            onUpdateProject={async (projectId, input) => {
              return changed({ projects: [await client.projects.updateProject(projectId, input)] });
            }}
            onRevealProjectInFinder={(projectPath) => revealProjectInFinderInMain({ zeus: window.zeus, projectPath })}
            onDeleteProject={async (projectId) => {
              await client.projects.deleteProject(projectId);
              return changed({ removedProjectIds: [projectId] });
            }}
            onCreateProjectArchiveConfirmation={(projectId) => client.projects.createProjectArchiveConfirmation(projectId)}
            onRestoreProject={async (projectId) => {
              return changed({ projects: [await client.projects.restoreProject(projectId)] });
            }}
            onLoadArchivedProjects={() => client.projects.loadArchivedProjects()}
            onLoadArchivedTasks={(projectId) => client.tasks.loadArchivedTasks(projectId)}
            onAuthorizeTaskFiles={(files, source) => window.zeus?.authorizeTaskFiles?.(files, source) ?? Promise.resolve({ resources: [], failedCount: files.length })}
            onMaterializeTaskResources={(resources) => window.zeus?.materializeTaskResources?.(resources) ?? Promise.resolve([])}
            onReadTaskClipboardResources={() => window.zeus?.readTaskClipboardResources?.() ?? Promise.resolve({ resources: [], text: '' })}
            onParseThirdPartyTaskLink={(url) => window.zeus?.parseThirdPartyTaskLink?.(url) ?? Promise.resolve({ kind: 'unsupported', sourceUrl: url })}
            onLoadTaskAttachmentPreview={(path) => window.zeus?.getTaskAttachmentPreview?.(path) ?? Promise.resolve(null)}
            onOpenTaskAttachment={(path) => window.zeus?.openTaskAttachment?.(path) ?? Promise.resolve({ opened: false, error: 'open_attachment_unavailable' })}
            onCreateTaskFromTemplate={async (templateId, projectId, idempotencyKey) => {
              const templateTaskDraft = buildTemplateTaskDraft(appShellSettings.appLanguage);
              const task = await client.createTaskFromTemplate(templateId, {
                idempotencyKey,
                projectId,
                title: templateTaskDraft.title,
                variables: {
                  project_path: snapshot.projects.find((project) => project.id === projectId)?.localPath ?? snapshot.projects[0]?.localPath ?? '',
                  ...templateTaskDraft.variables,
                },
              });
              return changed({ tasks: [task] });
            }}
            onChooseConversationResources={() => window.zeus?.chooseConversationResources?.() ?? Promise.resolve([])}
            onChooseTaskAttachments={() => window.zeus?.chooseTaskAttachments?.() ?? Promise.resolve([])}
            onCreateTaskDraft={async (projectId, draft, idempotencyKey) => {
              const task = await client.tasks.createTask({
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
              return changed({ tasks: [task] });
            }}
            onLoadTasks={async (projectId, query, managementStatus, tag, sortBy) =>
              client.tasks.loadTasks({
                projectId,
                query,
                managementStatus,
                tag,
                sortBy,
                sortDirection: 'asc',
              })
            }
            onLoadTask={(taskId) => client.tasks.loadTask(taskId)}
            onUpdateTask={async (taskId, input) => {
              return changed({ tasks: [await client.tasks.updateTask(taskId, input)] });
            }}
            onUpdateTaskRelationships={async (taskId, input) => {
              return changed({ tasks: [await client.tasks.updateTaskRelationships(taskId, input)] });
            }}
            onUpdateTaskTags={async (taskId, tags, expectedUpdatedAt) => {
              return changed({ tasks: [await client.tasks.updateTaskTags(taskId, tags, expectedUpdatedAt)] });
            }}
            onDeleteTask={async (taskId, input) => {
              const result = await client.tasks.deleteTask(taskId, input);
              return changed({ removedTaskIds: result.deletedTaskIds, tasks: await Promise.all(result.movedChildTaskIds.map((id) => client.tasks.loadTask(id))) });
            }}
            onRunTask={async (taskId) => {
              const result = await client.tasks.runTask(taskId);
              return {
                snapshot: changed({ tasks: [result.task] }),
                task: result.task,
                conversation: result.conversation,
                runtimeError: result.runtimeError,
              };
            }}
            onPauseTask={async (taskId) => {
              return changed({ tasks: [await client.tasks.pauseTask(taskId)] });
            }}
            onContinueTask={async (taskId) => {
              const result = await client.tasks.continueTask(taskId);
              return {
                snapshot: changed({ tasks: [result.task] }),
                task: result.task,
                conversation: result.conversation,
                runtimeError: result.runtimeError,
              };
            }}
            onCancelTask={async (taskId) => {
              return changed({ tasks: [await client.tasks.cancelTask(taskId)] });
            }}
            onRetryTask={async (taskId) => {
              return changed({ tasks: [await client.tasks.retryTask(taskId)] });
            }}
            onLoadLegacyConversation={(projectId, conversationId) => client.loadLegacyConversation(projectId, conversationId)}
            onSendConversationMessage={(projectId, conversationId, content) => client.sendConversationMessage(projectId, conversationId, content)}
            onSubscribeRealtimeEvents={(onEvent, onConnectionState) => client.subscribeEvents(onEvent, onConnectionState)}
            onOpenSource={(source) => openSourceInMain({ zeus: window.zeus, source })}
            onLoadTaskTemplates={(projectId) => client.loadTaskTemplates(projectId)}
            onLoadGitDiff={() => client.git.loadGitDiff()}
            onExportGitPatch={() => client.git.exportGitPatch()}
            onExportPatchFile={(patch) => window.zeus?.exportPatchToFile?.(patch) ?? Promise.resolve({ saved: false, filePath: null })}
            onLoadRuntimeStatus={() => client.loadRuntimeStatus()}
            onLoadReleaseStatus={() => client.loadReleaseStatus()}
            onLoadReleaseUpdateStatus={() => client.loadReleaseUpdateStatus()}
            onCheckReleaseUpdate={() => client.checkReleaseUpdate()}
            onLoadRuntimeSettings={() => client.settings.loadRuntimeSettings()}
            onLoadAppShellSettings={() => client.settings.loadAppShellSettings()}
            onSaveAppShellSettings={(input) => client.settings.saveAppShellSettings(input)}
            onInspectCodexConfigImport={() => client.inspectCodexConfigImport()}
            onImportCodexConfig={() => client.importCodexConfig()}
            onActivateCodexConfig={() => client.activateCodexConfig()}
            onExportLocalSettings={() => client.settings.exportLocalSettings()}
            onImportLocalSettings={(input) => client.settings.importLocalSettings(input)}
            onExportLocalBusinessData={() => client.exportLocalBusinessData()}
            onImportLocalBusinessData={(input) => client.importLocalBusinessData(input)}
            onExportSettingsFile={(snapshot) => window.zeus?.exportSettingsSnapshotToFile?.(snapshot) ?? Promise.resolve({ saved: false, filePath: null })}
            onExportBusinessDataFile={(snapshot) => window.zeus?.exportSettingsSnapshotToFile?.(snapshot) ?? Promise.resolve({ saved: false, filePath: null })}
            onImportSettingsFile={() => window.zeus?.importSettingsSnapshotFromFile?.() ?? Promise.resolve({ imported: false, filePath: null })}
            onImportBusinessDataFile={() => window.zeus?.importBusinessDataSnapshotFromFile?.() ?? Promise.resolve({ imported: false, filePath: null })}
            onLoadRuntimeAdapters={() => client.loadRuntimeAdapters()}
            onCheckRuntimeAdapter={(adapterId) => client.checkRuntimeAdapter(adapterId)}
            onLoadRuntimeSessions={(input) => client.loadRuntimeSessions(input)}
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
              const task = await client.createTaskFromRuntimeSession(sessionId, { ...input, idempotencyKey });
              return changed({ tasks: [task] });
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
            onLoadTaskEvents={(taskId) => client.tasks.loadTaskEvents(taskId)}
            onUpdateTaskStatus={async (taskId, status) => {
              return changed({ tasks: [await client.tasks.updateTaskStatus(taskId, status)] });
            }}
            onUpdateTaskManagementStatus={async (taskId, status, expectedUpdatedAt, confirmWorktreeCleanup, reopenConversationId) => {
              return changed({ tasks: [await client.tasks.updateTaskManagementStatus(taskId, status, expectedUpdatedAt, confirmWorktreeCleanup, reopenConversationId)] });
            }}
            onArchiveTask={async (taskId) => {
              await client.tasks.archiveTask(taskId);
              return changed({ removedTaskIds: [taskId] });
            }}
            onRestoreTask={async (taskId) => {
              return changed({ tasks: [await client.tasks.restoreTask(taskId)] });
            }}
            onCreateGitConfirmation={(operation, message) =>
              client.git.createGitConfirmation({
                operation,
                reason: gitOperationReason(operation),
                message,
              })
            }
            onConfirmGitOperation={(confirmationId) => client.git.confirmGitOperation(confirmationId)}
            onRejectGitOperation={(confirmationId, reason) => client.git.rejectGitOperation(confirmationId, reason)}
            onExecuteGitOperation={(input) => client.git.executeGitOperation(input)}
          />
        </Profiler>
        <RendererBootstrapReady />
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
  );
}

async function renderMenuBarUsageWithClient(client: DashboardClient): Promise<void> {
  const [{ MenuBarUsageWindow }, appShellSettings] = await Promise.all([import('./settings/MenuBarUsageWindow.js'), client.settings.loadAppShellSettings().catch(() => ({ appLanguage: 'zh-CN' as const, appearance: 'system' as const }))]);
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  document.body.dataset.surface = 'menu-bar-usage';
  startupLanguage = appShellSettings.appLanguage;
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

/** 独立费用明细只依赖主进程桥接数据，不启动 Dashboard API 客户端。 */
async function renderMenuBarUsageCostDetail(): Promise<void> {
  const [{ MenuBarUsageCostDetailWindow }, initialPayload = null] = await Promise.all([import('./settings/MenuBarUsageWindow.js'), window.zeus?.getMenuBarUsageCostDetail?.()]);
  /** 独立窗口使用自己的透明 surface，避免继承菜单栏主体尺寸。 */
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  document.body.dataset.surface = 'menu-bar-usage-cost-detail';
  /** 首次悬停可能在窗口加载完成前结束；无载荷时保持空白并等待下一次主进程广播。 */
  const initialLanguage = initialPayload?.language ?? startupLanguage;
  if (initialPayload) document.title = initialPayload.label;
  startupLanguage = initialLanguage;
  /** 错误界面语言与当前明细语言保持一致。 */
  const errorLanguage = initialLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  createRoot(root).render(
    <>
      <RendererErrorBoundary appLanguage={initialLanguage} onFatalError={(error) => reportSurfaceFatalError(error, errorLanguage, 'MenuBarUsageCostDetailWindow')}>
        <MenuBarUsageCostDetailWindow initialPayload={initialPayload} />
        <RendererBootstrapReady />
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
  );
}

/** 两种代码交付范围都挂载到同一个原生窗口页面。 */
async function renderTaskGitDeliveryWithClient(client: DashboardClient, parameters: URLSearchParams): Promise<void> {
  /** URL 只携带真实业务身份，记录和工作目录由已有接口重新读取。 */
  const taskId = parameters.get('taskId')?.trim();
  /** 普通会话必须同时指定归属项目与会话。 */
  const projectId = parameters.get('projectId')?.trim();
  /** 任务和会话两种范围不能混用。 */
  const conversationId = parameters.get('conversationId')?.trim();
  if (taskId ? projectId || conversationId : !projectId || !conversationId) throw new Error('代码交付窗口范围无效。');
  /** 元数据与设置并行读取，完整交付页只创建一次。 */
  const [{ TaskGitDeliveryWindow }, task, conversation, snapshot, appShellSettings, currentContext] = await Promise.all([
    import('./task/TaskGitDeliveryWindow.js'),
    taskId ? client.tasks.loadTask(taskId) : Promise.resolve(null),
    projectId && conversationId ? client.loadNativeConversationChoice(projectId, conversationId) : Promise.resolve(null),
    client.loadDashboard(),
    client.settings.loadAppShellSettings(),
    window.zeus?.getTaskGitDeliveryCurrentContext?.() ?? Promise.resolve({ taskId: null, workspaceId: null }),
  ]);
  /** 所有窗口使用同一 React 根及启动错误边界。 */
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  /** 不接受从其他项目借用的会话或缺失记录。 */
  const project = snapshot.projects.find((item) => item.id === (task?.projectId ?? projectId));
  if (!task && (!project || !conversation || conversation.projectId !== project.id || conversation.id !== conversationId || conversation.taskId)) throw new Error('代码交付会话归属无效，请从当前会话重新打开。');
  /** 控制器能力由真实记录选择，原生窗口壳与交付视图保持一致。 */
  const scope: import('./task/TaskGitDeliveryWindow.js').GitDeliveryWindowScope = task ? { kind: 'task', task, projectName: project?.name } : { kind: 'conversation', project: project!, conversation: conversation! };
  document.body.dataset.surface = 'task-git-delivery';
  document.title = `${appShellSettings.appLanguage === 'zh-CN' ? '代码交付' : 'Code Delivery'} · ${task ? (task.taskCode ?? task.id) : conversation!.title}`;
  startupLanguage = appShellSettings.appLanguage;
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  createRoot(root).render(
    <>
      <RendererErrorBoundary appLanguage={appShellSettings.appLanguage} onFatalError={(error) => reportSurfaceFatalError(error, errorLanguage, 'TaskGitDeliveryWindow')}>
        <TaskGitDeliveryWindow client={client} scope={scope} language={appShellSettings.appLanguage} appearance={appShellSettings.appearance} initialCurrentContext={currentContext} />
        <RendererBootstrapReady />
      </RendererErrorBoundary>
      <ApplicationErrorDialogHost language={errorLanguage} />
    </>,
  );
}

async function renderProjectGitDiffWithClient(client: DashboardClient, parameters: URLSearchParams): Promise<void> {
  const [{ ProjectGitDiffWindow }, appShellSettings] = await Promise.all([import('./git/ProjectGitDiffViewer.js'), client.settings.loadAppShellSettings()]);
  const projectId = parameters.get('projectId')?.trim();
  const repositoryId = parameters.get('repositoryId')?.trim();
  const filePath = parameters.get('filePath') ?? '';
  /** 任务来源必须同时指定工作区和比较范围。 */
  const taskId = parameters.get('taskId');
  /** 任务工作区与项目仓库使用不同的身份。 */
  const workspaceId = parameters.get('workspaceId');
  /** 任务差异明确区分未提交文件和已提交成果。 */
  const scope = parameters.get('scope');
  if (taskId ? !workspaceId || !filePath || (scope !== 'working' && scope !== 'committed') : !projectId || !repositoryId) throw new Error('差异窗口缺少有效的读取身份。');
  const stage = parameters.get('stage') === 'staged' || parameters.get('stage') === 'unstaged' ? (parameters.get('stage') as 'staged' | 'unstaged') : 'combined';
  const root = document.getElementById('root');
  if (!root) throw new Error('Zeus renderer root element is missing');
  document.body.dataset.surface = 'project-git-diff';
  startupLanguage = appShellSettings.appLanguage;
  const errorLanguage = appShellSettings.appLanguage === 'zh-CN' ? 'zh-CN' : 'en';
  createRoot(root).render(
    <>
      <RendererErrorBoundary appLanguage={appShellSettings.appLanguage} onFatalError={(error) => reportSurfaceFatalError(error, errorLanguage, 'ProjectGitDiffWindow')}>
        <ProjectGitDiffWindow
          client={client}
          source={
            taskId && workspaceId && (scope === 'working' || scope === 'committed')
              ? {
                  kind: 'task-git',
                  taskId,
                  workspaceId,
                  path: filePath,
                  scope,
                }
              : {
                  kind: 'project-git',
                  projectId: projectId!,
                  repositoryId: repositoryId!,
                  path: filePath,
                  stage,
                  commitHash: parameters.get('commitHash') ?? undefined,
                  comparisonRef: parameters.get('comparisonRef') ?? undefined,
                  comparisonMode: parameters.get('comparisonMode') === 'working-tree' ? 'working-tree' : 'current',
                }
          }
          language={appShellSettings.appLanguage}
          appearance={appShellSettings.appearance}
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
    let contentFrame: number | null = null;
    const frame = requestAnimationFrame(() => {
      contentFrame = requestAnimationFrame(() => rendererPerformance.recordFirstContentFrame(rendererHydrationStartedAt));
    });
    return () => {
      cancelAnimationFrame(frame);
      if (contentFrame !== null) cancelAnimationFrame(contentFrame);
    };
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
  const parameters = new URLSearchParams(window.location.search);
  const surface = parameters.get('surface');
  /** 明细窗口不依赖本地服务或数据库迁移，避免无关启动状态阻塞短时悬浮展示。 */
  if (surface === 'menu-bar-usage-cost-detail') {
    await renderMenuBarUsageCostDetail();
    return;
  }
  await waitForConversationStoreMigration();
  // App 模块与宿主就绪检查并行；会话缓存只在选择会话后读取。
  const appModuleStartedAt = performance.now();
  const mainWindowBootstrap = surface
    ? undefined
    : {
        appModule: import('./App.js').then((module) => {
          window.zeus?.reportStartupSpan?.({ stage: 'app_module', durationMs: performance.now() - appModuleStartedAt });
          return module;
        }),
      };
  const executionHostMaintenance = await window.zeus.getExecutionHostMaintenanceStatus?.();
  if (executionHostMaintenance) {
    renderExecutionHostMaintenance(executionHostMaintenance);
    window.zeus.reportRendererBootstrapReady?.();
    return;
  }
  const config = await window.zeus.getLocalServerConfig();
  const client = createDashboardClient({
    ...config,
    onPerformanceSpan: (span) => {
      rendererPerformance.onApiSpan(span);
      if (span.operation === 'GET /api/task-summaries') window.zeus?.reportStartupSpan?.({ stage: 'task_page', durationMs: span.durationMs });
    },
    refreshLocalServerConfig: window.zeus.getLocalServerConfig,
    ...(window.zeus.loadProjectGitWorkbench
      ? {
          projectGitWorkbench: {
            loadWorkbench: window.zeus.loadProjectGitWorkbench,
            /** 桌面历史与动作执行使用同一主进程。 */
            loadOperations: (projectId, cursor) => window.zeus!.loadProjectGitOperations({ projectId, cursor }),
            loadCommit: (projectId, repositoryId, commitHash) => window.zeus!.loadProjectGitCommit({ projectId, repositoryId, commitHash }),
            loadComparison: (projectId, repositoryId, ref, mode) => window.zeus!.loadProjectGitComparisonDiff({ projectId, repositoryId, ref, mode }),
            execute: (projectId, repositoryId, action) => window.zeus!.executeProjectGitAction({ projectId, repositoryId, action }),
          },
        }
      : {}),
  });
  if (surface === 'menu-bar-usage') {
    await renderMenuBarUsageWithClient(client);
    return;
  }
  if (surface === 'task-git-delivery') {
    await renderTaskGitDeliveryWithClient(client, parameters);
    return;
  }
  if (surface === 'project-git-diff') {
    await renderProjectGitDiffWithClient(client, parameters);
    return;
  }
  await renderWithClient(client, config.executionHostTransition, config.readOnlyValidation, mainWindowBootstrap);
}

function renderExecutionHostMaintenance(status: NonNullable<Awaited<ReturnType<NonNullable<Window['zeus']>['getExecutionHostMaintenanceStatus']>>>): void {
  renderStartupFailure(status);
}

/** 首屏只显示简述，诊断信息经独立入口展开；原生折叠保留键盘操作。 */
function renderStartupFailure(error: unknown): void {
  const zh = startupLanguage === 'zh-CN';
  const failure = describeUserFacingError(error, startupLanguage, zh ? '启动未能完成，请查看错误详情。' : 'Startup could not finish. See the error details.');
  reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' });
  const root = document.getElementById('root');
  if (!root) return;
  document.body.dataset.surface = 'startup-failure';

  const shell = document.createElement('main');
  shell.className = 'startup-failure-shell';
  shell.setAttribute('aria-labelledby', 'startup-failure-title');

  const content = document.createElement('section');
  content.className = 'startup-failure-content';

  const mark = document.createElement('span');
  mark.className = 'startup-failure-mark';
  mark.setAttribute('aria-hidden', 'true');

  const title = document.createElement('h1');
  title.id = 'startup-failure-title';
  title.textContent = zh ? 'Zeus 无法启动' : 'Zeus could not start';

  const details = document.createElement('details');
  const description = document.createElement('p');
  description.className = 'startup-failure-description';
  description.textContent = failure.message;
  /** 详情入口与简述分离，初始保持原生 details 的收起状态。 */
  const detailsLink = document.createElement('summary');
  detailsLink.textContent = zh ? '错误详情' : 'Error details';

  const logHint = document.createElement('p');
  logHint.className = 'startup-failure-log-hint';
  logHint.textContent = zh ? '重启会中断仍在运行的工作。' : 'Restarting will interrupt any work still running.';
  const original = document.createElement('pre');
  original.textContent = failure.details;
  original.style.whiteSpace = 'pre-wrap';
  original.style.overflowWrap = 'anywhere';
  details.append(detailsLink, original);

  const actions = document.createElement('div');
  actions.className = 'startup-failure-actions';
  const restart = startupFailureButton(zh ? '重新启动' : 'Restart', true);
  restart.onclick = async () => {
    restart.disabled = true;
    restart.textContent = zh ? '正在重启…' : 'Restarting…';
    try {
      await window.zeus?.restartAfterStartupFailure?.();
    } catch (restartError) {
      reportApplicationError(restartError, { language: zh ? 'zh-CN' : 'en' });
      restart.disabled = false;
      restart.textContent = zh ? '重新启动' : 'Restart';
    }
  };
  const exit = startupFailureButton(zh ? '退出 Zeus' : 'Quit Zeus', false);
  exit.onclick = async () => {
    exit.disabled = true;
    try {
      await window.zeus?.exitAfterStartupFailure?.();
    } catch (exitError) {
      reportApplicationError(exitError, { language: zh ? 'zh-CN' : 'en' });
      exit.disabled = false;
    }
  };
  actions.append(exit, restart);
  content.append(mark, title, description, details, actions, logHint);
  shell.append(content);
  root.replaceChildren(shell);
}

function startupFailureButton(label: string, primary: boolean): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = primary ? 'startup-failure-button is-primary' : 'startup-failure-button';
  return button;
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
    // 迁移早于应用设置加载，颜色继承首屏的系统或明确主题。
    background: 'light-dark(#f7f8fa, #17191d)',
    color: 'light-dark(#202124, #ebedf0)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  });
  const panel = document.createElement('section');
  Object.assign(panel.style, { width: 'min(620px, 100%)', padding: '28px', border: '0', borderRadius: '18px', background: 'transparent', boxSizing: 'border-box' });
  const title = document.createElement('h1');
  const migrationFailed = status.phase === 'failed' || status.phase === 'promoted_but_validation_failed';
  if (migrationFailed) {
    renderStartupFailure(status.error ?? status);
    return;
  }
  const zh = startupLanguage === 'zh-CN';
  title.textContent = zh ? '正在升级对话数据' : 'Updating conversation data';
  Object.assign(title.style, { margin: '0 0 12px', fontSize: '22px', lineHeight: '1.3' });
  const detail = document.createElement('p');
  detail.textContent = zh ? '正在准备和检查你的对话记录。完成后会自动打开 Zeus，请保持应用开启。' : 'Preparing and checking your conversation history. Zeus will open automatically when ready. Keep the app open.';
  Object.assign(detail.style, { margin: '0', color: 'light-dark(#5f6368, #a7acb4)', lineHeight: '1.65', whiteSpace: 'pre-wrap' });
  panel.append(title);
  panel.append(detail);
  shell.append(panel);
  root.replaceChildren(shell);
}

const executionHostDrainRecoveryLimitMs = 120_000;

async function hydrateRendererWithExecutionHostRecovery(): Promise<void> {
  const deadline = Date.now() + executionHostDrainRecoveryLimitMs;
  while (true) {
    try {
      await hydrateRenderer();
      return;
    } catch (error) {
      // 跨版本持久化交接会暂时拒绝普通 API。它不是 Renderer 模块、React 或本地数据库启动失败，
      // 不能上报给 Main 的 fatal startup 路径（该路径会用同步系统弹窗阻塞心跳，反过来拖死交接）。
      if (!(error instanceof ZeusApiError) || error.error !== 'ZEUS_EXECUTION_HOST_DRAINING' || Date.now() >= deadline) throw error;
      await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
    }
  }
}

hydrateRendererWithExecutionHostRecovery().catch((error: unknown) => {
  const surface = new URLSearchParams(window.location.search).get('surface');
  const auxiliarySurface = surface === 'menu-bar-usage' || surface === 'menu-bar-usage-cost-detail' || surface === 'task-git-delivery' || surface === 'project-git-diff';
  console.error(
    surface === 'menu-bar-usage'
      ? 'Zeus menu bar usage hydration failed'
      : surface === 'menu-bar-usage-cost-detail'
        ? 'Zeus menu bar usage cost detail hydration failed'
        : surface === 'task-git-delivery'
          ? 'Zeus task Git delivery hydration failed'
          : 'Zeus dashboard hydration failed',
    error,
  );
  renderStartupFailure(error);
  if (!auxiliarySurface) window.zeus?.reportRendererBootstrapReady?.();
});

function reportSurfaceFatalError(error: Error, language: 'zh-CN' | 'en', source: string): void {
  console.error(`Zeus ${source} render failed`, error);
  reportApplicationError(error, {
    language,
  });
}
