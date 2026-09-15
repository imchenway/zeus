import { createMemoryApiClient, type MemoryApiClient } from '../memory/memoryApiClient.js';
import type { EmployeeWorkSettings, EmployeeWorkStageInput, EmployeeTeamRecipe } from '@zeus/shared';
import type { EmployeeMemoryProposal, TaskWorkPlan, TaskWorkReviewNote } from './digitalEmployeeContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { commandInputSha256 } from '../../commandRequest.js';
import { buildWorkManagementCommandRequest, workManagementClientCommandTypes } from '../work-management/workManagementCommandClient.js';
import type { CommandRunDetail } from '../runtime/runtimeContracts.js';
import type {
  DigitalEmployeeAutomationInput,
  DigitalEmployeeCapabilitiesSnapshot,
  DigitalEmployeeAutomationRecord,
  DigitalEmployeeCollaborationProjection,
  DigitalEmployeeExecutionRecord,
  DigitalEmployeeInput,
  DigitalEmployeeRecord,
  DigitalEmployeeStageDecisionInput,
  DigitalEmployeeTemplateInput,
  DigitalEmployeeTemplateRecord,
  TaskWorkDecisionRecord,
  TaskWorkDeliverableRecord,
  TaskWorkItemRecord,
  TaskWorkManagementProjection,
  TaskWorkPreview,
  TaskWorkPreviewSelection,
} from './digitalEmployeeContracts.js';

export interface DigitalEmployeeApiClient {
  /** 员工经验复用既有记忆命令和生命周期。 */
  employeeMemory: MemoryApiClient;
  /** 读取员工主动提出的经验建议。 */
  loadEmployeeMemoryProposals(projectId: string, employeeId: string): Promise<EmployeeMemoryProposal[]>;
  /** 审查前可以修改经验，原建议保留。 */
  decideEmployeeMemoryProposal(proposal: EmployeeMemoryProposal, input: { accept: boolean; topic: string; content: string; reviewAfter: string }): Promise<EmployeeMemoryProposal>;
  /** 读取固定成果的审查意见。 */
  loadTaskWorkReviews(taskId: string, deliverableId: string): Promise<TaskWorkReviewNote[]>;
  /** 追加修订绑定意见。 */
  addTaskWorkReview(taskId: string, deliverable: TaskWorkDeliverableRecord, input: { anchor: string; content: string; blocking: boolean }): Promise<TaskWorkReviewNote>;
  /** 解决或重开当前意见。 */
  resolveTaskWorkReview(taskId: string, note: TaskWorkReviewNote, resolved: boolean): Promise<TaskWorkReviewNote>;
  /** 保存尚未启动的团队分工。 */
  saveTaskWorkPlan(taskId: string, input: { expectedRevision: number | null; stages: EmployeeWorkStageInput[]; settings: EmployeeWorkSettings }): Promise<TaskWorkPlan>;
  /** 明确控制后续安排。 */
  controlTaskWorkPlan(taskId: string, expectedRevision: number, state: 'running' | 'paused' | 'cancelled'): Promise<TaskWorkPlan>;
  /** 领取或调整尚未开始的工作。 */
  /** 保存待执行分工的覆盖，不改变已启动运行。 */
  updatePlannedTaskWorkSettings(taskId: string, workItemId: string, expectedRevision: number, settings: EmployeeWorkSettings): Promise<TaskWorkItemRecord>;
  assignPlannedTaskWork(taskId: string, workItemId: string, expectedRevision: number, employeeId: string): Promise<TaskWorkItemRecord>;
  /** 读取当前项目配方。 */
  loadEmployeeTeamRecipes(projectId: string): Promise<EmployeeTeamRecipe[]>;
  /** 保存当前阶段安排为配方。 */
  saveEmployeeTeamRecipe(input: EmployeeTeamRecipe): Promise<EmployeeTeamRecipe>;
  loadDigitalEmployeeCapabilities(): Promise<DigitalEmployeeCapabilitiesSnapshot>;
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
  loadTaskWorkManagement(taskId: string): Promise<TaskWorkManagementProjection>;
  loadTaskWorkDeliverableContent(taskId: string, deliverableId: string): Promise<{ deliverableId: string; version: number; contentSha256: string; content: string }>;
  loadTaskWorkCommandEvidence(runId: string): Promise<CommandRunDetail>;
  previewTaskWorkItem(taskId: string, input: TaskWorkPreviewSelection): Promise<TaskWorkPreview>;
  createTaskWorkItem(taskId: string, preview: TaskWorkPreview): Promise<{ item: TaskWorkItemRecord; run: TaskWorkItemRecord['runs'][number] }>;
  acceptTaskWorkDeliverable(taskId: string, deliverable: TaskWorkDeliverableRecord): Promise<unknown>;
  requestTaskWorkDeliverableChanges(taskId: string, deliverable: TaskWorkDeliverableRecord, reason: string): Promise<unknown>;
  retryTaskWorkItem(taskId: string, item: TaskWorkItemRecord): Promise<unknown>;
  cancelTaskWorkItem(taskId: string, item: TaskWorkItemRecord): Promise<unknown>;
  resolveTaskWorkDecision(taskId: string, decision: TaskWorkDecisionRecord, response: Record<string, unknown>): Promise<unknown>;
}

export function createDigitalEmployeeApiClient(transport: LocalApiTransport): DigitalEmployeeApiClient {
  return {
    employeeMemory: createMemoryApiClient(transport),
    loadEmployeeMemoryProposals: (projectId, employeeId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/digital-employees/${encodeURIComponent(employeeId)}/memory-proposals`),
    decideEmployeeMemoryProposal: async (proposal, input) => {
      const body = await command(workManagementClientCommandTypes.employeeMemoryDecide, 'project', () => proposal.projectId, 'employee_memory_decide_', { ...input, expectedRevision: proposal.revision }, proposal.revision);
      return transport.request(`/api/projects/${encodeURIComponent(proposal.projectId)}/digital-employees/${encodeURIComponent(proposal.employeeId)}/memory-proposals/${encodeURIComponent(proposal.id)}`, jsonRequest('POST', body));
    },
    loadTaskWorkReviews: (taskId, deliverableId) => transport.request(`${taskPath(taskId)}/work-deliverables/${encodeURIComponent(deliverableId)}/reviews`),
    addTaskWorkReview: async (taskId, deliverable, input) => {
      const body = await command(workManagementClientCommandTypes.taskWorkReviewAdd, 'task', () => taskId, 'task_work_review_', { ...input, contentSha256: deliverable.contentSha256 });
      return transport.request(`${taskPath(taskId)}/work-deliverables/${encodeURIComponent(deliverable.id)}/reviews`, jsonRequest('POST', body));
    },
    resolveTaskWorkReview: async (taskId, note, resolved) => {
      const body = await command(workManagementClientCommandTypes.taskWorkReviewResolve, 'task', () => taskId, 'task_work_review_resolve_', { expectedRevision: note.revision, resolved }, note.revision);
      return transport.request(`${taskPath(taskId)}/work-deliverables/${encodeURIComponent(note.deliverableId)}/reviews/${encodeURIComponent(note.id)}`, jsonRequest('POST', body));
    },
    loadDigitalEmployeeCapabilities: () => transport.request('/api/digital-employee-capabilities'),
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
    saveTaskWorkPlan: async (taskId, input) => {
      const body = await command(workManagementClientCommandTypes.taskWorkPlanSave, 'task', () => taskId, 'task_work_plan_', input, input.expectedRevision ?? undefined);
      return transport.request(`${taskPath(taskId)}/work-plan`, jsonRequest('POST', body));
    },
    controlTaskWorkPlan: async (taskId, expectedRevision, state) => {
      const body = await command(workManagementClientCommandTypes.taskWorkPlanControl, 'task', () => taskId, 'task_work_plan_control_', { expectedRevision, state }, expectedRevision);
      return transport.request(`${taskPath(taskId)}/work-plan/control`, jsonRequest('POST', body));
    },
    updatePlannedTaskWorkSettings: async (taskId, workItemId, expectedRevision, settings) => {
      const body = await command(workManagementClientCommandTypes.taskWorkSettingsUpdate, 'task', () => taskId, 'task_work_settings_', { expectedRevision, settings }, expectedRevision);
      return transport.request(`${taskPath(taskId)}/work-items/${encodeURIComponent(workItemId)}/settings`, jsonRequest('POST', body));
    },
    assignPlannedTaskWork: async (taskId, workItemId, expectedRevision, employeeId) => {
      const body = await command(workManagementClientCommandTypes.taskWorkItemAssign, 'task', () => taskId, 'task_work_assign_', { expectedRevision, employeeId }, expectedRevision);
      return transport.request(`${taskPath(taskId)}/work-items/${encodeURIComponent(workItemId)}/assign`, jsonRequest('POST', body));
    },
    loadEmployeeTeamRecipes: (projectId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/employee-team-recipes`),
    saveEmployeeTeamRecipe: async (input) => {
      const body = await command(workManagementClientCommandTypes.employeeTeamRecipeSave, 'project', () => input.projectId, 'employee_team_recipe_', input, input.revision);
      return transport.request(`/api/projects/${encodeURIComponent(input.projectId)}/employee-team-recipes`, jsonRequest('POST', body));
    },
    loadTaskWorkManagement: (taskId) => transport.request(`${taskPath(taskId)}/work-management`),
    loadTaskWorkDeliverableContent: (taskId, deliverableId) => transport.request(`${taskPath(taskId)}/work-deliverables/${encodeURIComponent(deliverableId)}/content`),
    loadTaskWorkCommandEvidence: (runId) => transport.request(`/api/command-runs/${encodeURIComponent(runId)}?tail=true&logLimit=1000`),
    previewTaskWorkItem: (taskId, input) => transport.request(`${taskPath(taskId)}/work-item-previews`, jsonRequest('POST', input)),
    createTaskWorkItem: async (taskId, preview) => {
      const value = {
        selection: preview.selection,
        previewSha256: preview.previewSha256,
        expectedTaskRevision: preview.expectedTaskRevision,
        expectedEmployeeRevision: preview.expectedEmployeeRevision,
      };
      const body = await command(workManagementClientCommandTypes.taskWorkItemCreate, 'task', () => taskId, 'task_work_item_', value);
      return transport.request(`${taskPath(taskId)}/work-items`, jsonRequest('POST', body));
    },
    acceptTaskWorkDeliverable: async (taskId, deliverable) => {
      const value = { expectedRevision: deliverable.revision };
      const body = await command(workManagementClientCommandTypes.taskWorkDeliverableAccept, 'task', () => taskId, 'task_work_deliverable_accept_', value, deliverable.revision);
      return transport.request(`${taskPath(taskId)}/work-deliverables/${encodeURIComponent(deliverable.id)}/accept`, jsonRequest('POST', body));
    },
    requestTaskWorkDeliverableChanges: async (taskId, deliverable, reason) => {
      const value = { expectedRevision: deliverable.revision, reason };
      const body = await command(workManagementClientCommandTypes.taskWorkDeliverableRequestChanges, 'task', () => taskId, 'task_work_deliverable_changes_', value, deliverable.revision);
      return transport.request(`${taskPath(taskId)}/work-deliverables/${encodeURIComponent(deliverable.id)}/request-changes`, jsonRequest('POST', body));
    },
    retryTaskWorkItem: async (taskId, item) => {
      const value = { expectedRevision: item.revision };
      const body = await command(workManagementClientCommandTypes.taskWorkItemRetry, 'task', () => taskId, 'task_work_item_retry_', value, item.revision);
      return transport.request(`${taskPath(taskId)}/work-items/${encodeURIComponent(item.id)}/retry`, jsonRequest('POST', body));
    },
    cancelTaskWorkItem: async (taskId, item) => {
      const value = { expectedRevision: item.revision };
      const body = await command(workManagementClientCommandTypes.taskWorkItemCancel, 'task', () => taskId, 'task_work_item_cancel_', value, item.revision);
      return transport.request(`${taskPath(taskId)}/work-items/${encodeURIComponent(item.id)}/cancel`, jsonRequest('POST', body));
    },
    resolveTaskWorkDecision: async (taskId, decision, response) => {
      const value = { expectedRevision: decision.revision, responseSha256: await commandInputSha256(response) };
      const body = await command(workManagementClientCommandTypes.taskWorkDecisionResolve, 'task', () => taskId, 'task_work_decision_resolve_', value, decision.revision);
      return transport.request(`${taskPath(taskId)}/work-decisions/${encodeURIComponent(decision.id)}/resolve`, jsonRequest('POST', { ...body, runtime: { response } }));
    },
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
