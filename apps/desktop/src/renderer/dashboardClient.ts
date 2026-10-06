import { createCodexApiClient, type CodexApiClient } from './features/codex/codexApiClient.js';
import { createAutomationApiClient, type AutomationApiClient } from './features/automations/automationApiClient.js';
import { createCommandCenterApiClient, type CommandCenterApiClient } from './features/command-center/commandCenterApiClient.js';
import { createConversationApiClient, type ConversationApiClient } from './features/conversations/conversationApiClient.js';
import { createDashboardApiClient, type DashboardApiClient } from './features/dashboard/dashboardApiClient.js';
import { createDigitalEmployeeApiClient, type DigitalEmployeeApiClient } from './features/digital-employees/digitalEmployeeApiClient.js';
import { createDigitalTeamApiClient, type DigitalTeamApiClient } from './features/digital-teams/digitalTeamApiClient.js';
import { createGitApiClient, type GitApiClient } from './features/git/gitApiClient.js';
import { createIntegrationApiClient, type IntegrationApiClient } from './features/integrations/integrationApiClient.js';
import { createMemoryApiClient, type MemoryApiClient } from './features/memory/memoryApiClient.js';
import { createProjectApiClient, type ProjectApiClient } from './features/projects/projectApiClient.js';
import { createRemoteControlApiClient, type RemoteControlApiClient } from './features/remote/remoteControlApiClient.js';
import { createRuntimeApiClient, type RuntimeApiClient } from './features/runtime/runtimeApiClient.js';
import { createSettingsApiClient, type SettingsApiClient } from './features/settings/settingsApiClient.js';
import { createTaskApiClient, type TaskApiClient } from './features/tasks/taskApiClient.js';
import { createTelegramApiClient, type TelegramApiClient } from './features/telegram/telegramApiClient.js';
import type { DashboardClientOptions, ZeusRealtimeConnectionState, ZeusRealtimeEvent } from './transport/dashboardClientContracts.js';
import { createLocalApiEventSubscription } from './transport/localApiEventSubscription.js';
import { createLocalApiTransport } from './transport/localApiTransport.js';

export interface DashboardClient
  extends
    DashboardApiClient,
    AutomationApiClient,
    DigitalEmployeeApiClient,
    DigitalTeamApiClient,
    CodexApiClient,
    CommandCenterApiClient,
    ConversationApiClient,
    GitApiClient,
    IntegrationApiClient,
    ProjectApiClient,
    RemoteControlApiClient,
    RuntimeApiClient,
    SettingsApiClient,
    TaskApiClient,
    TelegramApiClient {
  memory: MemoryApiClient;
  conversations: ConversationApiClient;
  projects: ProjectApiClient;
  tasks: TaskApiClient;
  git: GitApiClient;
  settings: SettingsApiClient;
  remoteControl: RemoteControlApiClient;
  subscribeEvents: (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void) => () => void;
}

/** Renderer API client：只组合 bounded-context client 与统一本机 transport。 */
export function createDashboardClient(options: DashboardClientOptions): DashboardClient {
  /** HTTP 与事件流共用最近一次由 Main 确认的连接。 */
  let currentOptions = options;
  /** 同一客户端只保留一个连接刷新，避免并发交接和迟到配置相互覆盖。 */
  let refreshingConnection: Promise<DashboardClientOptions> | null = null;
  /** 所有恢复入口合流到 Main 的真实宿主恢复，不在业务客户端创建重试循环。 */
  const refreshConnection = options.refreshLocalServerConfig
    ? () => {
        if (refreshingConnection) return refreshingConnection;
        refreshingConnection = (async () => {
          /** 刷新期间保留 Renderer 专用端口与观察器。 */
          const refreshLocalServerConfig = currentOptions.refreshLocalServerConfig;
          if (!refreshLocalServerConfig) return currentOptions;
          /** Main 会等待真实交接并确认心跳，不能提前用旧端口重试。 */
          const refreshed = await refreshLocalServerConfig();
          currentOptions = {
            ...refreshed,
            refreshLocalServerConfig,
            projectGitWorkbench: currentOptions.projectGitWorkbench,
            onPerformanceSpan: currentOptions.onPerformanceSpan,
          };
          return currentOptions;
        })().finally(() => {
          refreshingConnection = null;
        });
        return refreshingConnection;
      }
    : undefined;
  const transport = createLocalApiTransport({
    getConnection: () => currentOptions,
    refreshConnection,
    onPerformanceSpan: (span) => currentOptions.onPerformanceSpan?.(span),
  });
  const memory = createMemoryApiClient(transport);
  const automations = createAutomationApiClient(transport);
  const conversations = createConversationApiClient(transport);
  const digitalEmployees = createDigitalEmployeeApiClient(transport);
  /** 数字团队只组合独立的图模板与运行 API，不扩展旧员工编排语义。 */
  const digitalTeams = createDigitalTeamApiClient(transport);
  const projects = createProjectApiClient(transport);
  const tasks = createTaskApiClient(transport);
  const git = createGitApiClient(transport, () => currentOptions.projectGitWorkbench);
  const settings = createSettingsApiClient(transport);
  const remoteControl = createRemoteControlApiClient(transport);

  return {
    memory,
    ...automations,
    conversations,
    projects,
    tasks,
    git,
    settings,
    remoteControl,
    ...digitalEmployees,
    ...digitalTeams,
    subscribeEvents: createLocalApiEventSubscription({
      transport,
      refreshConnection: refreshConnection ? async () => void (await refreshConnection()) : undefined,
    }),
    ...createDashboardApiClient(transport),
    ...createCodexApiClient(transport),
    ...createCommandCenterApiClient(transport),
    ...conversations,
    ...git,
    ...createIntegrationApiClient(transport),
    ...projects,
    ...remoteControl,
    ...createRuntimeApiClient(transport),
    ...settings,
    ...tasks,
    ...createTelegramApiClient(transport),
  };
}
