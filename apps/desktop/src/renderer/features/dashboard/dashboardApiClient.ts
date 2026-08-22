import type { DashboardSnapshot } from './dashboardContracts.js';
import type { SecurityAuditLogEntry } from '../integrations/integrationContracts.js';
import type { ReleaseStatusSnapshot, ReleaseUpdateOperationSnapshot, ReleaseUpdateStatusSnapshot } from '../release/releaseContracts.js';
import type { ImportLocalBusinessDataResult, LocalBusinessDataSnapshot } from '../settings/settingsContracts.js';
import { buildSettingsCommandRequest, settingsClientCommandTypes } from '../settings/settingsCommandClient.js';
import type { LocalApiTransport } from '../../transport/localApiTransport.js';

export interface DashboardApiClient {
  loadDashboard: () => Promise<DashboardSnapshot>;
  exportLocalBusinessData: () => Promise<LocalBusinessDataSnapshot>;
  importLocalBusinessData: (input: LocalBusinessDataSnapshot) => Promise<ImportLocalBusinessDataResult>;
  loadSecurityAuditLogs: () => Promise<SecurityAuditLogEntry[]>;
  loadReleaseStatus: () => Promise<ReleaseStatusSnapshot>;
  loadReleaseUpdateStatus: () => Promise<ReleaseUpdateStatusSnapshot>;
  checkReleaseUpdate: () => Promise<ReleaseUpdateStatusSnapshot>;
  downloadReleaseUpdate: () => Promise<ReleaseUpdateOperationSnapshot>;
  installReleaseUpdate: () => Promise<ReleaseUpdateOperationSnapshot>;
}

export function createDashboardApiClient(transport: LocalApiTransport): DashboardApiClient {
  return {
    loadDashboard: async () => normalizeDashboardSnapshot(await transport.request<DashboardSnapshot>('/api/dashboard')),
    exportLocalBusinessData: () => transport.request<LocalBusinessDataSnapshot>('/api/data/export'),
    importLocalBusinessData: async (input) => {
      const body = await buildSettingsCommandRequest({ commandType: settingsClientCommandTypes.dataImport, scopeKind: 'settings', scopeId: 'local-business-data-import', operationPrefix: 'business_data_import', value: input });
      return transport.request<ImportLocalBusinessDataResult>('/api/data/import', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    loadSecurityAuditLogs: () => transport.request<SecurityAuditLogEntry[]>('/api/security/audit-logs'),
    loadReleaseStatus: () => transport.request<ReleaseStatusSnapshot>('/api/release/status'),
    loadReleaseUpdateStatus: () => transport.request<ReleaseUpdateStatusSnapshot>('/api/release/update-status'),
    checkReleaseUpdate: () =>
      transport.request<ReleaseUpdateStatusSnapshot>('/api/release/check-update', {
        method: 'POST',
      }),
    downloadReleaseUpdate: () =>
      transport.request<ReleaseUpdateOperationSnapshot>('/api/release/download-update', {
        method: 'POST',
      }),
    installReleaseUpdate: () =>
      transport.request<ReleaseUpdateOperationSnapshot>('/api/release/install-update', {
        method: 'POST',
      }),
  };
}

/**
 * 上一正式版宿主可能缺少新增的纯投影字段。Renderer 在边界统一补齐，
 * 避免后端任务正常运行时，整个工作台因一个可缺省字段进入崩溃页。
 */
export function normalizeDashboardSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return {
    ...snapshot,
    conversationAttentionByProject: snapshot.conversationAttentionByProject && typeof snapshot.conversationAttentionByProject === 'object' ? snapshot.conversationAttentionByProject : {},
    conversationUnreadCountByProject: snapshot.conversationUnreadCountByProject && typeof snapshot.conversationUnreadCountByProject === 'object' ? snapshot.conversationUnreadCountByProject : {},
  };
}

/** 首次渲染兜底 snapshot，不包含任何假业务记录。 */
export function createEmptyDashboardSnapshot(): DashboardSnapshot {
  return {
    app: 'Zeus',
    localServer: { host: '127.0.0.1', port: null },
    projects: [],
    tasks: [],
    conversationAttentionByProject: {},
    conversationUnreadCountByProject: {},
    runtime: {
      aiCli: {
        available: false,
        reason: 'Zeus 不会在启动时扫描或执行外部 CLI；请在 Runtime 适配器中手动检查。',
      },
      telegram: { enabled: false, reason: 'Telegram Bot Token 未配置。' },
    },
    git: {
      isRepository: false,
      branch: '',
      clean: true,
      changedFiles: [],
      conflictFiles: [],
      fileStatuses: [],
      remoteBranches: [],
      recentCommits: [],
    },
    graph: { nodeCount: 0, edgeCount: 0, viewCount: 0 },
  };
}
