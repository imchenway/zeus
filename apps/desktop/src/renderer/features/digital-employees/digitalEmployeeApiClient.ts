import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildWorkManagementCommandRequest, workManagementClientCommandTypes } from '../work-management/workManagementCommandClient.js';
import type {
  DigitalEmployeeAutomationInput,
  DigitalEmployeeAutomationRecord,
  DigitalEmployeeCollaborationProjection,
  DigitalEmployeeExecutionRecord,
  DigitalEmployeeInput,
  DigitalEmployeeRecord,
  DigitalEmployeeStageDecisionInput,
  DigitalEmployeeTemplateInput,
  DigitalEmployeeTemplateRecord,
} from './digitalEmployeeContracts.js';

export interface DigitalEmployeeApiClient {
  loadDigitalEmployeeTemplates(): Promise<DigitalEmployeeTemplateRecord[]>;
  createDigitalEmployeeTemplate(input: DigitalEmployeeTemplateInput): Promise<DigitalEmployeeTemplateRecord>;
  updateDigitalEmployeeTemplate(templateId: string, expectedRevision: number, input: Partial<DigitalEmployeeTemplateInput>): Promise<DigitalEmployeeTemplateRecord>;
  deleteDigitalEmployeeTemplate(templateId: string, expectedRevision: number): Promise<DigitalEmployeeTemplateRecord>;
  loadProjectDigitalEmployees(projectId: string): Promise<DigitalEmployeeRecord[]>;
  createProjectDigitalEmployee(projectId: string, input: { templateId: string; overrides?: Partial<DigitalEmployeeInput> } | DigitalEmployeeInput): Promise<DigitalEmployeeRecord>;
  updateProjectDigitalEmployee(projectId: string, employeeId: string, expectedRevision: number, input: Partial<DigitalEmployeeInput>): Promise<DigitalEmployeeRecord>;
  deleteProjectDigitalEmployee(projectId: string, employeeId: string, expectedRevision: number): Promise<DigitalEmployeeRecord>;
  loadDigitalEmployeeAutomations(projectId: string): Promise<DigitalEmployeeAutomationRecord[]>;
  createDigitalEmployeeAutomation(projectId: string, input: DigitalEmployeeAutomationInput): Promise<DigitalEmployeeAutomationRecord>;
  updateDigitalEmployeeAutomation(projectId: string, automationId: string, expectedRevision: number, input: Partial<Omit<DigitalEmployeeAutomationInput, 'employeeId'>>): Promise<DigitalEmployeeAutomationRecord>;
  deleteDigitalEmployeeAutomation(projectId: string, automationId: string, expectedRevision: number): Promise<DigitalEmployeeAutomationRecord>;
  runDigitalEmployeeAutomation(projectId: string, automationId: string): Promise<DigitalEmployeeAutomationRecord>;
  loadProjectDigitalEmployeeExecutions(projectId: string): Promise<DigitalEmployeeExecutionRecord[]>;
  loadTaskDigitalEmployeeExecutions(taskId: string): Promise<DigitalEmployeeExecutionRecord[]>;
  loadTaskDigitalEmployeeCollaboration(taskId: string): Promise<DigitalEmployeeCollaborationProjection>;
  assignTaskToDigitalEmployee(taskId: string, employeeId: string): Promise<DigitalEmployeeExecutionRecord>;
  retryDigitalEmployeeExecution(executionId: string, taskId: string): Promise<DigitalEmployeeExecutionRecord>;
  retryStagedDigitalEmployeeExecution(executionId: string, taskId: string, input: { targetEmployeeId: string; expectedExecutionRevision: number }): Promise<DigitalEmployeeExecutionRecord>;
  cancelDigitalEmployeeExecution(executionId: string, taskId: string): Promise<DigitalEmployeeExecutionRecord>;
  handoffDigitalEmployeeExecution(executionId: string, taskId: string, input: DigitalEmployeeStageDecisionInput & { targetEmployeeId: string }): Promise<DigitalEmployeeExecutionRecord>;
  reworkDigitalEmployeeExecution(executionId: string, taskId: string, input: DigitalEmployeeStageDecisionInput & { targetEmployeeId: string; reason: string }): Promise<DigitalEmployeeExecutionRecord>;
  finalizeDigitalEmployeeExecution(executionId: string, taskId: string, input: DigitalEmployeeStageDecisionInput): Promise<DigitalEmployeeExecutionRecord>;
  adoptLegacyDigitalEmployeeExecution(executionId: string, taskId: string, expectedExecutionRevision: number): Promise<DigitalEmployeeExecutionRecord>;
  loadDigitalEmployeeDeliverableContent(taskId: string, deliverableId: string): Promise<{ content: string }>;
}

export function createDigitalEmployeeApiClient(transport: LocalApiTransport): DigitalEmployeeApiClient {
  return {
    loadDigitalEmployeeTemplates: () => transport.request('/api/digital-employee-templates'),
    createDigitalEmployeeTemplate: async (input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeTemplateCreate, 'settings', () => 'digital-employee-templates', 'digital_employee_template_', input);
      return transport.request('/api/digital-employee-templates', jsonRequest('POST', body));
    },
    updateDigitalEmployeeTemplate: async (templateId, expectedRevision, input) => {
      const value = { ...input, expectedRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeTemplateUpdate, 'settings', () => `digital-employee-template:${templateId}`, 'digital_employee_template_update_', value, expectedRevision);
      return transport.request(`/api/digital-employee-templates/${encodeURIComponent(templateId)}`, jsonRequest('PATCH', body));
    },
    deleteDigitalEmployeeTemplate: async (templateId, expectedRevision) => {
      const value = { expectedRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeTemplateDelete, 'settings', () => `digital-employee-template:${templateId}`, 'digital_employee_template_delete_', value, expectedRevision);
      return transport.request(`/api/digital-employee-templates/${encodeURIComponent(templateId)}`, jsonRequest('DELETE', body));
    },
    loadProjectDigitalEmployees: (projectId) => transport.request(`${projectPath(projectId)}/digital-employees`),
    createProjectDigitalEmployee: async (projectId, input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeCreate, 'project', () => projectId, 'digital_employee_', input);
      return transport.request(`${projectPath(projectId)}/digital-employees`, jsonRequest('POST', body));
    },
    updateProjectDigitalEmployee: async (projectId, employeeId, expectedRevision, input) => {
      const value = { ...input, expectedRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeUpdate, 'project', () => projectId, 'digital_employee_update_', value, expectedRevision);
      return transport.request(`${projectPath(projectId)}/digital-employees/${encodeURIComponent(employeeId)}`, jsonRequest('PATCH', body));
    },
    deleteProjectDigitalEmployee: async (projectId, employeeId, expectedRevision) => {
      const value = { expectedRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeDelete, 'project', () => projectId, 'digital_employee_delete_', value, expectedRevision);
      return transport.request(`${projectPath(projectId)}/digital-employees/${encodeURIComponent(employeeId)}`, jsonRequest('DELETE', body));
    },
    loadDigitalEmployeeAutomations: (projectId) => transport.request(`${projectPath(projectId)}/digital-employee-automations`),
    createDigitalEmployeeAutomation: async (projectId, input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeAutomationCreate, 'project', () => projectId, 'digital_employee_automation_', input);
      return transport.request(`${projectPath(projectId)}/digital-employee-automations`, jsonRequest('POST', body));
    },
    updateDigitalEmployeeAutomation: async (projectId, automationId, expectedRevision, input) => {
      const value = { ...input, expectedRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeAutomationUpdate, 'project', () => projectId, 'digital_employee_automation_update_', value, expectedRevision);
      return transport.request(`${projectPath(projectId)}/digital-employee-automations/${encodeURIComponent(automationId)}`, jsonRequest('PATCH', body));
    },
    deleteDigitalEmployeeAutomation: async (projectId, automationId, expectedRevision) => {
      const value = { expectedRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeAutomationDelete, 'project', () => projectId, 'digital_employee_automation_delete_', value, expectedRevision);
      return transport.request(`${projectPath(projectId)}/digital-employee-automations/${encodeURIComponent(automationId)}`, jsonRequest('DELETE', body));
    },
    runDigitalEmployeeAutomation: async (projectId, automationId) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeAutomationRun, 'project', () => projectId, 'digital_employee_automation_run_', {});
      return transport.request(`${projectPath(projectId)}/digital-employee-automations/${encodeURIComponent(automationId)}/run`, jsonRequest('POST', body));
    },
    loadProjectDigitalEmployeeExecutions: (projectId) => transport.request(`${projectPath(projectId)}/digital-employee-executions`),
    loadTaskDigitalEmployeeExecutions: (taskId) => transport.request(`${taskPath(taskId)}/digital-employee-executions`),
    loadTaskDigitalEmployeeCollaboration: (taskId) => transport.request(`${taskPath(taskId)}/digital-employee-collaboration`),
    assignTaskToDigitalEmployee: async (taskId, employeeId) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionCreate, 'task', () => taskId, 'digital_employee_execution_', { employeeId });
      return transport.request(`${taskPath(taskId)}/digital-employee-executions`, jsonRequest('POST', body));
    },
    retryDigitalEmployeeExecution: async (executionId, taskId) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionRetry, 'task', () => taskId, 'digital_employee_execution_retry_', {});
      return transport.request(`/api/digital-employee-executions/${encodeURIComponent(executionId)}/retry`, jsonRequest('POST', body));
    },
    retryStagedDigitalEmployeeExecution: async (executionId, taskId, input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionRetry, 'task', () => taskId, 'digital_employee_stage_retry_', input, input.expectedExecutionRevision);
      return transport.request(`${taskPath(taskId)}/digital-employee-executions/${encodeURIComponent(executionId)}/retries`, jsonRequest('POST', body));
    },
    cancelDigitalEmployeeExecution: async (executionId, taskId) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionCancel, 'task', () => taskId, 'digital_employee_execution_cancel_', {});
      return transport.request(`/api/digital-employee-executions/${encodeURIComponent(executionId)}/cancel`, jsonRequest('POST', body));
    },
    handoffDigitalEmployeeExecution: async (executionId, taskId, input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionHandoff, 'task', () => taskId, 'digital_employee_handoff_', input, input.expectedExecutionRevision);
      return transport.request(`${taskPath(taskId)}/digital-employee-executions/${encodeURIComponent(executionId)}/handoffs`, jsonRequest('POST', body));
    },
    reworkDigitalEmployeeExecution: async (executionId, taskId, input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionRework, 'task', () => taskId, 'digital_employee_rework_', input, input.expectedExecutionRevision);
      return transport.request(`${taskPath(taskId)}/digital-employee-executions/${encodeURIComponent(executionId)}/reworks`, jsonRequest('POST', body));
    },
    finalizeDigitalEmployeeExecution: async (executionId, taskId, input) => {
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionFinalize, 'task', () => taskId, 'digital_employee_finalize_', input, input.expectedExecutionRevision);
      return transport.request(`${taskPath(taskId)}/digital-employee-executions/${encodeURIComponent(executionId)}/finalize`, jsonRequest('POST', body));
    },
    adoptLegacyDigitalEmployeeExecution: async (executionId, taskId, expectedExecutionRevision) => {
      const value = { expectedExecutionRevision };
      const body = await command(workManagementClientCommandTypes.digitalEmployeeExecutionAdoptLegacy, 'task', () => taskId, 'digital_employee_adopt_legacy_', value, expectedExecutionRevision);
      return transport.request(`${taskPath(taskId)}/digital-employee-executions/${encodeURIComponent(executionId)}/adopt-stage-handoff`, jsonRequest('POST', body));
    },
    loadDigitalEmployeeDeliverableContent: (taskId, deliverableId) => transport.request(`${taskPath(taskId)}/workflow/deliverables/${encodeURIComponent(deliverableId)}/content`),
  };
}

function command<TInput extends object>(
  commandType: Parameters<typeof buildWorkManagementCommandRequest<TInput>>[0]['commandType'],
  scopeKind: 'settings' | 'project' | 'task',
  scopeId: (operationIdentity: string) => string,
  operationPrefix: string,
  value: TInput,
  expectedRevision?: number,
) {
  return buildWorkManagementCommandRequest({ commandType, scopeKind, scopeId, operationPrefix, value, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
}

function projectPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

function taskPath(taskId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}`;
}
