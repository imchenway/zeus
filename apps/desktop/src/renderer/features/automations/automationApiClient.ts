import { buildRendererCommandRequest, randomIdentity } from '../../commandRequest.js';
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
    createAutomation: (input) => automationRequest(transport, '/api/automations', 'POST', input),
    updateAutomation: (automationId, expectedRevision, input) => automationRequest(transport, `/api/automations/${encodeURIComponent(automationId)}`, 'PATCH', { ...input, expectedRevision }),
    runAutomation: async (automationId) => (await automationRequest<{ items: AutomationRunRecord[] }>(transport, `/api/automations/${encodeURIComponent(automationId)}/run`, 'POST', {})).items,
    /** 同一次点击沿用幂等请求，不创建新的自动化触发。 */
    resumeAutomationRun: (runId) => automationRequest(transport, `/api/automation-runs/${encodeURIComponent(runId)}/resume`, 'POST', {}),
    setAutomationStatus: (automationId, status) => automationRequest(transport, `/api/automations/${encodeURIComponent(automationId)}/status`, 'POST', { status }),
    setAutomationFullAccessGrant: (automationId, expectedRevision, granted) => automationRequest(transport, `/api/automations/${encodeURIComponent(automationId)}/full-access-grant`, 'POST', { expectedRevision, granted }),
    deleteAutomation: (automationId) => automationRequest(transport, `/api/automations/${encodeURIComponent(automationId)}`, 'DELETE', null),
    /** 原通知身份和修订随幂等写入一起提交。 */
    acknowledgeAutomationNotification: (id, expectedRevision) => automationRequest(transport, `/api/automation-notifications/${encodeURIComponent(id)}/read`, 'POST', { expectedRevision }),
  };
}

/** 未确认的自动化操作复用耐久身份，明确成功或拒绝后才允许生成新操作。 */
async function automationRequest<T>(transport: LocalApiTransport, path: string, method: 'POST' | 'PATCH' | 'DELETE', body: unknown): Promise<T> {
  const { command } = await buildRendererCommandRequest({
    commandType: 'automation.mutate',
    commandIdPrefix: 'automation_command_',
    actorId: 'zeus-desktop-automation',
    scopeKind: 'settings',
    scopeId: path,
    operationIdentity: randomIdentity(),
    value: { method, body },
  });
  return transport.request<T>(path, { ...jsonRequest(method, body), commandEnvelope: command });
}
