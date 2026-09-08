import type { CommandDefinition, ProjectCodeWorkspacePreference, TaskManagementStatusConfig, TaskPageViewMode, TaskStatusFilter } from '@zeus/shared';
import type { ProjectRecord } from '../projects/projectContracts.js';
import type { RuntimeSettings } from '../runtime/runtimeContracts.js';
import type { TaskEventRecord, TaskRecord, TaskTableColumnPreferences, TaskTableEnumSortOrders, TaskTemplateRecord } from '../tasks/taskContracts.js';
import type { TelegramNotificationSettings, TelegramSecuritySettings } from '../telegram/telegramContracts.js';
import type { NetworkProxySettings } from '@zeus/shared';

export interface AppShellSettings {
  /** 完全退出并重开应用后使用的网络代理。 */
  networkProxy?: NetworkProxySettings;
  /** 首次接入状态；旧资料未记录时不自动弹出引导。 */
  modelSetupStatus?: 'pending' | 'skipped' | 'completed' | null;
  /** 只用于之后新建项目的完整供应商模型引用。 */
  newProjectDefaultModelRef?: string | null;
  appLanguage: 'zh-CN' | 'en-US';
  appearance: 'system' | 'light' | 'dark';
  webviewDebugEnabled: boolean;
  developerModeEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
  autoUpdateChannel: 'manual';
  defaultProjectId: string | null;
  pinnedProjectIds: string[];
  collapsedProjectIds: string[];
  sidebarConversationOrganization: 'flat' | 'task_status';
  sidebarConversationCollapsedStatusIdsByProject: Record<string, string[]>;
  defaultModel: string | null;
  defaultTaskTemplateId: string | null;
  taskTableColumns?: TaskTableColumnPreferences;
  taskTableColumnsByProject?: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  taskManagementStatusByProject?: Record<string, TaskManagementStatusConfig>;
  taskStatusFilterByProject?: Record<string, TaskStatusFilter>;
  taskViewModeByProject?: Record<string, 'hierarchy' | 'flat'>;
  taskPageViewByProject?: Record<string, TaskPageViewMode>;
  taskExpandedIdsByProject?: Record<string, string[]>;
  codeWorkspaceByProject?: Record<string, ProjectCodeWorkspacePreference>;
  localLogDirectory: string;
  localConfigPath: string;
  dataPortability: {
    importSupported: boolean;
    exportSupported: boolean;
    redactsSecrets: boolean;
  };
}

export type UpdateAppShellSettingsRequest = Pick<
  AppShellSettings,
  'appLanguage' | 'appearance' | 'webviewDebugEnabled' | 'developerModeEnabled' | 'multiWindowEnabled' | 'backgroundModeEnabled' | 'desktopNotificationsEnabled' | 'openAtLoginEnabled' | 'autoUpdateChannel'
> & {
  /** 省略时保留当前代理，兼容其他设置的局部保存。 */
  networkProxy?: NetworkProxySettings;
  /** 首次接入状态；旧资料未记录时不自动弹出引导。 */
  modelSetupStatus?: 'pending' | 'skipped' | 'completed' | null;
  /** 只用于之后新建项目的完整供应商模型引用。 */
  newProjectDefaultModelRef?: string | null;
  defaultProjectId?: string | null;
  pinnedProjectIds?: string[];
  collapsedProjectIds?: string[];
  sidebarConversationOrganization?: 'flat' | 'task_status';
  sidebarConversationCollapsedStatusIdsByProject?: Record<string, string[]>;
  defaultModel?: string | null;
  defaultTaskTemplateId?: string | null;
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  taskTableColumnsByProject?: Record<string, TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  taskManagementStatusByProject?: Record<string, TaskManagementStatusConfig>;
  taskManagementStatusReplacements?: Record<string, Record<string, string>>;
  taskStatusFilterByProject?: Record<string, TaskStatusFilter>;
  taskViewModeByProject?: Record<string, 'hierarchy' | 'flat'>;
  taskPageViewByProject?: Record<string, TaskPageViewMode>;
  taskExpandedIdsByProject?: Record<string, string[]>;
  codeWorkspaceByProject?: Record<string, ProjectCodeWorkspacePreference>;
};

export interface LocalSettingsExportSnapshot {
  app: 'Zeus';
  schemaVersion: 1;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  settings: {
    appShell: AppShellSettings;
    runtime: RuntimeSettings;
    telegramNotification: TelegramNotificationSettings;
    telegramSecurity: TelegramSecuritySettings;
  };
}

export interface ImportLocalSettingsRequest {
  schemaVersion: 1;
  settings: {
    appShell?: UpdateAppShellSettingsRequest;
    runtime?: RuntimeSettings;
    telegramNotification?: TelegramNotificationSettings;
    telegramSecurity?: TelegramSecuritySettings;
  };
}

export interface ImportLocalSettingsResult {
  imported: boolean;
  importedSettings: string[];
  importedAt: string;
}

export interface LocalBusinessDataSnapshot {
  app: 'Zeus';
  schemaVersion: 1 | 2;
  exportedAt: string;
  redaction: {
    secretsRedacted: true;
  };
  data: {
    projects: Array<
      ProjectRecord & {
        slug?: string;
        defaultTemplateId?: string | null;
        createdAt?: string;
        updatedAt?: string;
      }
    >;
    tasks: Array<
      TaskRecord & {
        sourceContextJson?: string;
        createdAt?: string;
        updatedAt?: string;
      }
    >;
    taskEvents: TaskEventRecord[];
    taskTemplates: TaskTemplateRecord[];
    commandDefinitions?: CommandDefinition[];
  };
}

export interface ImportLocalBusinessDataResult {
  imported: boolean;
  importedCounts: {
    projects: number;
    tasks: number;
    taskEvents: number;
    taskTemplates: number;
    commandDefinitions: number;
  };
  importedAt: string;
}
