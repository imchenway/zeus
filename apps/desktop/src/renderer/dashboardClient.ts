import { createCodexApiClient, type CodexApiClient } from './features/codex/codexApiClient.js';
import { createCommandCenterApiClient, type CommandCenterApiClient } from './features/command-center/commandCenterApiClient.js';
import { createConversationApiClient, type ConversationApiClient } from './features/conversations/conversationApiClient.js';
import { createDashboardApiClient, type DashboardApiClient } from './features/dashboard/dashboardApiClient.js';
import { createGitApiClient, type GitApiClient } from './features/git/gitApiClient.js';
import { createGraphApiClient, type GraphApiClient } from './features/graph/graphApiClient.js';
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
    CodexApiClient,
    CommandCenterApiClient,
    ConversationApiClient,
    GitApiClient,
    GraphApiClient,
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
  let currentOptions = options;
  const refreshConnection = options.refreshLocalServerConfig
    ? async () => {
        const refreshLocalServerConfig = currentOptions.refreshLocalServerConfig;
        if (!refreshLocalServerConfig) return currentOptions;
        const refreshed = await refreshLocalServerConfig();
        currentOptions = {
          ...refreshed,
          refreshLocalServerConfig,
          projectGitWorkbench: currentOptions.projectGitWorkbench,
          onPerformanceSpan: currentOptions.onPerformanceSpan,
        };
        return currentOptions;
      }
    : undefined;
  const transport = createLocalApiTransport({
    getConnection: () => currentOptions,
    refreshConnection,
    onPerformanceSpan: (span) => currentOptions.onPerformanceSpan?.(span),
  });
  const memory = createMemoryApiClient(transport);
  const conversations = createConversationApiClient(transport);
  const projects = createProjectApiClient(transport);
  const tasks = createTaskApiClient(transport);
  const git = createGitApiClient(transport, () => currentOptions.projectGitWorkbench);
  const settings = createSettingsApiClient(transport);
  const remoteControl = createRemoteControlApiClient(transport);

  return {
    memory,
    conversations,
    projects,
    tasks,
    git,
    settings,
    remoteControl,
    subscribeEvents: createLocalApiEventSubscription({
      transport,
      refreshConnection: refreshConnection ? async () => void (await refreshConnection()) : undefined,
    }),
    ...createDashboardApiClient(transport),
    ...createCodexApiClient(transport),
    ...createCommandCenterApiClient(transport),
    ...conversations,
    ...git,
    ...createGraphApiClient(transport),
    ...createIntegrationApiClient(transport),
    ...projects,
    ...remoteControl,
    ...createRuntimeApiClient(transport),
    ...settings,
    ...tasks,
    ...createTelegramApiClient(transport),
  };
}
