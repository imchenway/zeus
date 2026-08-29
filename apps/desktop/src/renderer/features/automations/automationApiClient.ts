import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import type { AutomationRunRecord, AutomationRunStatus, AutomationTaskInput, AutomationTaskRecord } from './automationContracts.js';

export interface AutomationApiClient {
  loadAutomations(): Promise<AutomationTaskRecord[]>;
  createAutomation(input: AutomationTaskInput): Promise<AutomationTaskRecord>;
  updateAutomation(automationId: string, expectedRevision: number, input: Partial<AutomationTaskInput>): Promise<AutomationTaskRecord>;
  runAutomation(automationId: string): Promise<AutomationRunRecord[]>;
  setAutomationStatus(automationId: string, status: 'active' | 'paused'): Promise<AutomationTaskRecord>;
  setAutomationFullAccessGrant(automationId: string, expectedRevision: number, granted: boolean): Promise<{ granted: boolean; revision: number }>;
  deleteAutomation(automationId: string): Promise<void>;
  loadAutomationInbox(input?: { unreadOnly?: boolean; status?: AutomationRunStatus }): Promise<AutomationRunRecord[]>;
  acknowledgeAutomationRun(runId: string): Promise<AutomationRunRecord>;
}

export function createAutomationApiClient(transport: LocalApiTransport): AutomationApiClient {
  return {
    loadAutomations: async () => (await transport.request<{ items: AutomationTaskRecord[] }>('/api/automations')).items,
    createAutomation: (input) => transport.request('/api/automations', jsonRequest('POST', input)),
    updateAutomation: (automationId, expectedRevision, input) => transport.request(`/api/automations/${encodeURIComponent(automationId)}`, jsonRequest('PATCH', { ...input, expectedRevision })),
    runAutomation: async (automationId) => (await transport.request<{ items: AutomationRunRecord[] }>(`/api/automations/${encodeURIComponent(automationId)}/run`, jsonRequest('POST', {}))).items,
    setAutomationStatus: (automationId, status) => transport.request(`/api/automations/${encodeURIComponent(automationId)}/status`, jsonRequest('POST', { status })),
    setAutomationFullAccessGrant: (automationId, expectedRevision, granted) => transport.request(`/api/automations/${encodeURIComponent(automationId)}/full-access-grant`, jsonRequest('POST', { expectedRevision, granted })),
    deleteAutomation: (automationId) => transport.request(`/api/automations/${encodeURIComponent(automationId)}`, { method: 'DELETE' }),
    loadAutomationInbox: async (input = {}) => {
      const query = new URLSearchParams();
      if (input.unreadOnly) query.set('unread', 'true');
      if (input.status) query.set('status', input.status);
      return (await transport.request<{ items: AutomationRunRecord[] }>(`/api/automations/inbox${query.size ? `?${query.toString()}` : ''}`)).items;
    },
    acknowledgeAutomationRun: (runId) => transport.request(`/api/automation-runs/${encodeURIComponent(runId)}/read`, jsonRequest('POST', {})),
  };
}
