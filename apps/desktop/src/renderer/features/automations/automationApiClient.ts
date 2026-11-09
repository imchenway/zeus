import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import type { AutomationRunRecord, AutomationTaskInput, AutomationTaskRecord } from './automationContracts.js';

export interface AutomationApiClient {
  loadAutomations(): Promise<AutomationTaskRecord[]>;
  createAutomation(input: AutomationTaskInput): Promise<AutomationTaskRecord>;
  updateAutomation(automationId: string, expectedRevision: number, input: Partial<AutomationTaskInput>): Promise<AutomationTaskRecord>;
  runAutomation(automationId: string): Promise<AutomationRunRecord[]>;
  /** 恢复原运行的剩余项目，保留已接纳工作和冻结任务身份。 */
  resumeAutomationRun(runId: string): Promise<AutomationRunRecord>;
  setAutomationStatus(automationId: string, status: 'active' | 'paused'): Promise<AutomationTaskRecord>;
  setAutomationFullAccessGrant(automationId: string, expectedRevision: number, granted: boolean): Promise<{ granted: boolean; revision: number }>;
  deleteAutomation(automationId: string): Promise<void>;
  /** 只确认已实际查看的通知修订。 */
  acknowledgeAutomationNotification(id: string, expectedRevision: number): Promise<{ acknowledged: boolean }>;
}

export function createAutomationApiClient(transport: LocalApiTransport): AutomationApiClient {
  return {
    loadAutomations: async () => (await transport.request<{ items: AutomationTaskRecord[] }>('/api/automations')).items,
    createAutomation: (input) => transport.request('/api/automations', automationRequest('POST', input)),
    updateAutomation: (automationId, expectedRevision, input) => transport.request(`/api/automations/${encodeURIComponent(automationId)}`, automationRequest('PATCH', { ...input, expectedRevision })),
    runAutomation: async (automationId) => (await transport.request<{ items: AutomationRunRecord[] }>(`/api/automations/${encodeURIComponent(automationId)}/run`, automationRequest('POST', {}))).items,
    /** 同一次点击沿用幂等请求，不创建新的自动化触发。 */
    resumeAutomationRun: (runId) => transport.request(`/api/automation-runs/${encodeURIComponent(runId)}/resume`, automationRequest('POST', {})),
    setAutomationStatus: (automationId, status) => transport.request(`/api/automations/${encodeURIComponent(automationId)}/status`, automationRequest('POST', { status })),
    setAutomationFullAccessGrant: (automationId, expectedRevision, granted) => transport.request(`/api/automations/${encodeURIComponent(automationId)}/full-access-grant`, automationRequest('POST', { expectedRevision, granted })),
    deleteAutomation: (automationId) => transport.request(`/api/automations/${encodeURIComponent(automationId)}`, automationRequest('DELETE', null)),
    /** 原通知身份和修订随幂等写入一起提交。 */
    acknowledgeAutomationNotification: (id, expectedRevision) => transport.request(`/api/automation-notifications/${encodeURIComponent(id)}/read`, automationRequest('POST', { expectedRevision })),
  };
}

function automationRequest(method: 'POST' | 'PATCH' | 'DELETE', body: unknown): RequestInit {
  return { ...jsonRequest(method, body), headers: { 'idempotency-key': crypto.randomUUID() } };
}
