import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import type { AutomationRunRecord, AutomationTaskInput, AutomationTaskRecord } from './automationContracts.js';
import type { AutomationNotificationPage } from '@zeus/shared';

export interface AutomationApiClient {
  loadAutomations(): Promise<AutomationTaskRecord[]>;
  createAutomation(input: AutomationTaskInput): Promise<AutomationTaskRecord>;
  updateAutomation(automationId: string, expectedRevision: number, input: Partial<AutomationTaskInput>): Promise<AutomationTaskRecord>;
  runAutomation(automationId: string): Promise<AutomationRunRecord[]>;
  setAutomationStatus(automationId: string, status: 'active' | 'paused'): Promise<AutomationTaskRecord>;
  setAutomationFullAccessGrant(automationId: string, expectedRevision: number, granted: boolean): Promise<{ granted: boolean; revision: number }>;
  deleteAutomation(automationId: string): Promise<void>;
  /** 查询逐会话未读列表及全量角标。 */
  loadAutomationNotifications(cursor?: string): Promise<AutomationNotificationPage>;
  /** 只确认已实际查看的通知修订。 */
  acknowledgeAutomationNotification(id: string, expectedRevision: number): Promise<{ acknowledged: boolean }>;
  /** 沿原运行身份继续尚未接纳的目标，不重跑已接纳工作。 */
  resumeAutomationRun(runId: string): Promise<AutomationRunRecord>;
}

export function createAutomationApiClient(transport: LocalApiTransport): AutomationApiClient {
  return {
    loadAutomations: async () => (await transport.request<{ items: AutomationTaskRecord[] }>('/api/automations')).items,
    createAutomation: (input) => transport.request('/api/automations', automationRequest('POST', input)),
    updateAutomation: (automationId, expectedRevision, input) => transport.request(`/api/automations/${encodeURIComponent(automationId)}`, automationRequest('PATCH', { ...input, expectedRevision })),
    runAutomation: async (automationId) => (await transport.request<{ items: AutomationRunRecord[] }>(`/api/automations/${encodeURIComponent(automationId)}/run`, automationRequest('POST', {}))).items,
    setAutomationStatus: (automationId, status) => transport.request(`/api/automations/${encodeURIComponent(automationId)}/status`, automationRequest('POST', { status })),
    setAutomationFullAccessGrant: (automationId, expectedRevision, granted) => transport.request(`/api/automations/${encodeURIComponent(automationId)}/full-access-grant`, automationRequest('POST', { expectedRevision, granted })),
    deleteAutomation: (automationId) => transport.request(`/api/automations/${encodeURIComponent(automationId)}`, automationRequest('DELETE', null)),
    /** 游标通过 URLSearchParams 编码，不拼接未验证的查询内容。 */
    loadAutomationNotifications: (cursor) => transport.request(`/api/automations/notifications${cursor ? `?${new URLSearchParams({ cursor })}` : ''}`),
    /** 服务端以当前冻结进度控制恢复，幂等键防止重复操作。 */
    resumeAutomationRun: (runId) => transport.request(`/api/automation-runs/${encodeURIComponent(runId)}/resume`, automationRequest('POST', {})),
    /** 原通知身份和修订随幂等写入一起提交。 */
    acknowledgeAutomationNotification: (id, expectedRevision) => transport.request(`/api/automation-notifications/${encodeURIComponent(id)}/read`, automationRequest('POST', { expectedRevision })),
  };
}

function automationRequest(method: 'POST' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
  return { ...jsonRequest(method, body), headers: { 'idempotency-key': crypto.randomUUID() } };
}
