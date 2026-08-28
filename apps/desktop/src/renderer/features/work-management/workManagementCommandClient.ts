import { canonicalCommandInputJson, commandEnvelopeSchemaGeneration, type CommandEnvelope, type CommandScopeKind } from '@zeus/shared';

export const workManagementClientCommandTypes = {
  projectCreate: 'work_management.project.create',
  projectUpdate: 'work_management.project.update',
  projectWorkspaceUpdate: 'work_management.project.workspace.update',
  projectDelete: 'work_management.project.delete',
  projectArchive: 'work_management.project.archive',
  projectRestore: 'work_management.project.restore',
  projectDefaultTemplateSet: 'work_management.project.default_template.set',
  taskCreate: 'work_management.task.create',
  taskStatusUpdate: 'work_management.task.status.update',
  taskManagementStatusUpdate: 'work_management.task.management_status.update',
  taskBoardUpdate: 'work_management.task_board.update',
  taskBoardMove: 'work_management.task_board.move',
  taskRun: 'work_management.task.run',
  taskPause: 'work_management.task.pause',
  taskContinue: 'work_management.task.continue',
  taskCancel: 'work_management.task.cancel',
  taskRetry: 'work_management.task.retry',
  taskUpdate: 'work_management.task.update',
  taskTagsUpdate: 'work_management.task.tags.update',
  taskRelationshipsUpdate: 'work_management.task.relationships.update',
  taskDelete: 'work_management.task.delete',
  taskArchive: 'work_management.task.archive',
  taskRestore: 'work_management.task.restore',
  taskTemplateCreate: 'work_management.task_template.create',
  taskFromTemplateCreate: 'work_management.task.from_template.create',
  taskFromGraphConversationCreate: 'work_management.task.from_graph_conversation.create',
  taskFromGraphNodeCreate: 'work_management.task.from_graph_node.create',
  taskFromGraphViewCreate: 'work_management.task.from_graph_view.create',
  taskGraphNodeLink: 'work_management.task.graph_node.link',
  digitalEmployeeTemplateCreate: 'work_management.digital_employee_template.create',
  digitalEmployeeTemplateUpdate: 'work_management.digital_employee_template.update',
  digitalEmployeeTemplateDelete: 'work_management.digital_employee_template.delete',
  digitalEmployeeCreate: 'work_management.digital_employee.create',
  digitalEmployeeUpdate: 'work_management.digital_employee.update',
  digitalEmployeeDelete: 'work_management.digital_employee.delete',
  digitalEmployeeAutomationCreate: 'work_management.digital_employee_automation.create',
  digitalEmployeeAutomationUpdate: 'work_management.digital_employee_automation.update',
  digitalEmployeeAutomationDelete: 'work_management.digital_employee_automation.delete',
  digitalEmployeeAutomationRun: 'work_management.digital_employee_automation.run',
  digitalEmployeeExecutionCreate: 'work_management.digital_employee_execution.create',
  digitalEmployeeExecutionRetry: 'work_management.digital_employee_execution.retry',
  digitalEmployeeExecutionCancel: 'work_management.digital_employee_execution.cancel',
} as const;

type WorkManagementClientCommandType = (typeof workManagementClientCommandTypes)[keyof typeof workManagementClientCommandTypes];
type WorkManagementCommandPayload = { operationIdentity: string; inputSha256: string };

/** Local transport 重连复用此处一次生成的 Body，不能重新生成 command 或 operation identity。 */
export async function buildWorkManagementCommandRequest<TInput extends object>(input: {
  commandType: WorkManagementClientCommandType;
  scopeKind: Extract<CommandScopeKind, 'project' | 'task' | 'settings'>;
  scopeId(operationIdentity: string): string;
  expectedRevision?: number | null;
  operationPrefix: string;
  /** 既有公开幂等键可映射为稳定资源身份；网络重连仍复用同一个已构造 Body。 */
  operationSeed?: string;
  value: TInput;
}): Promise<{ command: CommandEnvelope<WorkManagementCommandPayload>; input: TInput }> {
  const operationIdentity = `${input.operationPrefix}${input.operationSeed ? (await sha256(`${input.commandType}\0${input.operationSeed}`)).slice(0, 32) : randomIdentity()}`;
  const inputSha256 = await sha256(canonicalCommandInputJson(input.value));
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: `command_work_management_${randomIdentity()}`,
      commandType: input.commandType,
      actor: { kind: 'local_api', id: 'zeus-desktop-work-management' },
      scope: { kind: input.scopeKind, id: input.scopeId(operationIdentity) },
      expectedRevision: input.expectedRevision ?? null,
      idempotencyKey: `${input.commandType}:${operationIdentity}`,
      issuedAt: new Date().toISOString(),
      payload: { operationIdentity, inputSha256 },
    },
    input: input.value,
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomIdentity(): string {
  if (typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID().replaceAll('-', '');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
