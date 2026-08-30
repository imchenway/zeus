/**
 * Renderer API 稳定公共入口。
 *
 * contracts 与 HTTP 映射由各 bounded context 拥有；此文件只保留兼容再导出，
 * DashboardClient 的运行时组合位于 dashboardClient.ts。
 */
export { createDashboardClient, type DashboardClient } from './dashboardClient.js';
export { createEmptyDashboardSnapshot, normalizeDashboardSnapshot } from './features/dashboard/dashboardApiClient.js';
export { ZeusApiError, type ZeusClientPerformanceSpan } from './transport/localApiTransport.js';

export type {
  CommandArtifact,
  CommandConfirmation,
  CommandDefinition,
  CommandDefinitionInput,
  CommandParameterDefinition,
  CommandRun,
  CommandRunStatus,
  SaveZentaoInstanceRequest,
  TaskBoardMoveRequest,
  TaskBoardOpenMode,
  TaskBoardViewSettings,
  TaskBoardViewSnapshot,
  TaskManagementStatus,
  TaskManagementStatusConfig,
  TaskPageViewMode,
  TaskPriority,
  TaskStatusFilter,
  TaskType,
  ZentaoInstanceRecord,
  ZentaoInstanceVerifyResult,
} from '@zeus/shared';

export type * from './features/codex/codexContracts.js';
export type * from './features/automations/automationContracts.js';
export type * from './features/conversations/conversationContracts.js';
export type * from './features/dashboard/dashboardContracts.js';
export type * from './features/git/gitContracts.js';
export type * from './features/graph/graphContracts.js';
export type * from './features/integrations/integrationContracts.js';
export type * from './features/projects/projectContracts.js';
export type * from './features/release/releaseContracts.js';
export type * from './features/remote/remoteControlContracts.js';
export type * from './features/runtime/runtimeContracts.js';
export type * from './features/settings/settingsContracts.js';
export type * from './features/tasks/taskContracts.js';
export type * from './features/digital-employees/digitalEmployeeContracts.js';
export type * from './features/telegram/telegramContracts.js';
export type * from './transport/dashboardClientContracts.js';
