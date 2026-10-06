import type { CommandDefinition, ProjectCodeWorkspacePreference, TaskManagementStatusConfig, TaskPageViewMode, TaskStatusFilter } from '@zeus/shared';
import type { ProjectRecord } from '../projects/projectContracts.js';
import type { RuntimeSettings } from '../runtime/runtimeContracts.js';
import type { TaskEventRecord, TaskRecord, TaskTableColumnPreferences, TaskTableEnumSortOrders, TaskTemplateRecord } from '../tasks/taskContracts.js';
import type { TelegramNotificationSettings, TelegramSecuritySettings } from '../telegram/telegramContracts.js';
import type { NetworkProxySettings, SidebarConversationFilters } from '@zeus/shared';

export interface AppShellSettings {
  /** 完全退出并重开应用后使用的网络代理。 */
  networkProxy?: NetworkProxySettings;
  /** 首次接入状态；旧资料未记录时不自动弹出引导。 */
  modelSetupStatus?: 'pending' | 'skipped' | 'completed' | null;
  appLanguage: 'zh-CN' | 'en-US';
  appearance: 'system' | 'light' | 'dark';
  /** 保留已持久化的布局值；界面分别显示为经典布局和紧凑布局。 */
  mainLayout: 'upstream' | 'current';
  /** 新建任务与会话工作树使用的分支命名空间，不包含结尾斜杠。 */
  taskBranchPrefix: string;
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
  /** 侧边栏漏斗随本机设置恢复；缺省时接收旧本地偏好。 */
  sidebarConversationFilters?: SidebarConversationFilters;
  defaultModel: string | null;
  defaultTaskTemplateId: string | null;
  taskTableColumns?: TaskTableColumnPreferences;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  /** 所有项目共用的任务状态筛选。 */
  taskStatusFilter?: TaskStatusFilter;
  /** 所有项目共用的任务层级偏好。 */
  taskViewMode?: 'hierarchy' | 'flat';
  /** 所有项目共用的列表或看板入口。 */
  taskPageView?: TaskPageViewMode;
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

/** 与服务端局部更新保持一致，省略的偏好保留原值。 */
export type UpdateAppShellSettingsRequest = Partial<
  Pick<
    AppShellSettings,
    | 'appLanguage'
    | 'appearance'
    | 'mainLayout'
    | 'taskBranchPrefix'
    | 'webviewDebugEnabled'
    | 'developerModeEnabled'
    | 'multiWindowEnabled'
    | 'backgroundModeEnabled'
    | 'desktopNotificationsEnabled'
    | 'openAtLoginEnabled'
    | 'autoUpdateChannel'
  >
> & {
  /** 省略时保留当前代理，兼容其他设置的局部保存。 */
  networkProxy?: NetworkProxySettings;
  /** 首次接入状态；旧资料未记录时不自动弹出引导。 */
  modelSetupStatus?: 'pending' | 'skipped' | 'completed' | null;
  defaultProjectId?: string | null;
  pinnedProjectIds?: string[];
  collapsedProjectIds?: string[];
  /** 只提交侧边栏拥有的筛选，避免通用设置的旧快照覆盖新选择。 */
  sidebarConversationFilters?: SidebarConversationFilters;
  defaultModel?: string | null;
  defaultTaskTemplateId?: string | null;
  taskTableColumns?: Partial<TaskTableColumnPreferences>;
  taskTableEnumSortOrders?: TaskTableEnumSortOrders;
  taskManagementStatusTemplate?: TaskManagementStatusConfig;
  taskManagementStatusReplacements?: Record<string, Record<string, string>>;
  /** 所有项目共用的任务状态筛选。 */
  taskStatusFilter?: TaskStatusFilter;
  /** 所有项目共用的任务层级偏好。 */
  taskViewMode?: 'hierarchy' | 'flat';
  /** 所有项目共用的列表或看板入口。 */
  taskPageView?: TaskPageViewMode;
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
        /** 仅备份旧项目默认模板引用，不参与新任务配置。 */
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
