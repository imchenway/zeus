import type { DigitalTeamNodeAttemptRecord, DigitalTeamRunControlState, DigitalTeamWorkflowDefinition, DigitalTeamWorkflowRunRecord, DigitalTeamWorkflowTemplateRecord } from '@zeus/shared';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildWorkManagementCommandRequest, workManagementClientCommandTypes } from '../work-management/workManagementCommandClient.js';

/** 保存模板时只提交可编辑业务字段。 */
export interface DigitalTeamTemplateSaveInput {
  /** 更新时携带模板身份；新建时为空。 */
  id?: string;
  /** 新建时为空，更新时必须匹配当前修订。 */
  expectedRevision: number | null;
  /** 模板名称。 */
  name: string;
  /** 模板说明。 */
  description: string;
  /** 当前画布定义。 */
  definition: DigitalTeamWorkflowDefinition;
}

/** 单个运行详情同时返回完整历史与当前有效尝试。 */
export interface DigitalTeamRunProjection {
  /** 冻结图与运行阶段。 */
  run: DigitalTeamWorkflowRunRecord;
  /** 不可覆盖的全部历史尝试。 */
  nodeAttempts: DigitalTeamNodeAttemptRecord[];
  /** 每个节点当前有效的尝试。 */
  currentAttempts: DigitalTeamNodeAttemptRecord[];
}

/** 创建运行时原子冻结模板、任务事实和当前项目基线。 */
export interface DigitalTeamRunCreateInput {
  /** 指定已有任务时复用其身份，省略则新建任务。 */
  taskId?: string;
  /** 已有任务的读取时间戳，拒绝使用过期任务内容。 */
  expectedTaskUpdatedAt?: string;
  /** 已保存模板身份。 */
  templateId: string;
  /** 用户看到的模板修订。 */
  templateRevision: number;
  /** 新任务标题。 */
  title: string;
  /** 新任务说明。 */
  description: string;
  /** 用户确认的任务事实。 */
  taskFacts: Record<string, unknown>;
}

/** 数字团队页面使用的真实本地 API。 */
export interface DigitalTeamApiClient {
  /** 读取项目模板。 */
  loadDigitalTeamTemplates(projectId: string): Promise<DigitalTeamWorkflowTemplateRecord[]>;
  /** 新建或按修订保存模板。 */
  saveDigitalTeamTemplate(projectId: string, input: DigitalTeamTemplateSaveInput): Promise<DigitalTeamWorkflowTemplateRecord>;
  /** 按修订删除模板。 */
  deleteDigitalTeamTemplate(projectId: string, templateId: string, expectedRevision: number): Promise<DigitalTeamWorkflowTemplateRecord>;
  /** 读取项目运行列表。 */
  loadDigitalTeamRuns(projectId: string, taskId?: string): Promise<DigitalTeamWorkflowRunRecord[]>;
  /** 读取单个运行完整投影。 */
  loadDigitalTeamRun(runId: string): Promise<DigitalTeamRunProjection>;
  /** 原子创建任务并冻结运行。 */
  createDigitalTeamRun(projectId: string, input: DigitalTeamRunCreateInput): Promise<DigitalTeamRunProjection>;
  /** 处理规划批准或最终验收。 */
  decideDigitalTeamApproval(runId: string, nodeId: string, attempt: number, input: { approved: boolean; reason: string; expectedRevision: number }): Promise<DigitalTeamRunProjection>;
  /** 暂停或继续后续派发。 */
  controlDigitalTeamRun(runId: string, input: { state: Extract<DigitalTeamRunControlState, 'running' | 'paused'>; expectedRevision: number }): Promise<DigitalTeamRunProjection>;
  /** 从指定节点发起返工。 */
  requestDigitalTeamRework(runId: string, nodeId: string, input: { reason: string; expectedRevision: number }): Promise<DigitalTeamRunProjection>;
}

/** 组合数字团队 bounded-context client，命令仍使用统一 Command Envelope。 */
export function createDigitalTeamApiClient(transport: LocalApiTransport): DigitalTeamApiClient {
  /** 已加载运行的任务身份用于构造真实 task scope，不用 runId 冒充任务。 */
  const taskIdByRunId = new Map<string, string>();
  /** 记录投影中的真实任务身份。 */
  const rememberRun = (run: DigitalTeamWorkflowRunRecord): DigitalTeamWorkflowRunRecord => {
    taskIdByRunId.set(run.id, run.taskId);
    return run;
  };
  /** 批量记录列表投影。 */
  const rememberRuns = (runs: DigitalTeamWorkflowRunRecord[]): DigitalTeamWorkflowRunRecord[] => runs.map(rememberRun);
  /** 未加载的运行先读取一次，确保后续命令 scope 指向真实任务。 */
  const resolveTaskId = async (runId: string): Promise<string> => {
    const knownTaskId = taskIdByRunId.get(runId);
    if (knownTaskId) return knownTaskId;
    return rememberRun(normalizeRunProjection(await transport.request<unknown>(digitalTeamRunPath(runId))).run).taskId;
  };
  /** 运行命令共用一次加载出的任务 scope。 */
  const runCommand = async <TInput extends object>(
    runId: string,
    commandType: typeof workManagementClientCommandTypes.digitalTeamApprovalDecide | typeof workManagementClientCommandTypes.digitalTeamRunControl | typeof workManagementClientCommandTypes.digitalTeamRework,
    operationPrefix: string,
    value: TInput,
    expectedRevision: number,
  ) => {
    const taskId = await resolveTaskId(runId);
    return buildWorkManagementCommandRequest({ commandType, scopeKind: 'task', scopeId: () => taskId, operationPrefix, value, expectedRevision });
  };

  return {
    loadDigitalTeamTemplates: (projectId) => transport.request(digitalTeamTemplatesPath(projectId)),
    saveDigitalTeamTemplate: async (projectId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.digitalTeamTemplateSave,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'digital_team_template_save_',
        value: input,
        expectedRevision: input.expectedRevision,
      });
      const path = input.id ? `${digitalTeamTemplatesPath(projectId)}/${encodeURIComponent(input.id)}` : digitalTeamTemplatesPath(projectId);
      return transport.request(path, jsonRequest(input.id ? 'PUT' : 'POST', body));
    },
    deleteDigitalTeamTemplate: async (projectId, templateId, expectedRevision) => {
      const value = { expectedRevision };
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.digitalTeamTemplateDelete,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'digital_team_template_delete_',
        value,
        expectedRevision,
      });
      return transport.request(`${digitalTeamTemplatesPath(projectId)}/${encodeURIComponent(templateId)}`, jsonRequest('DELETE', body));
    },
    loadDigitalTeamRuns: async (projectId, taskId) => rememberRuns(await transport.request<DigitalTeamWorkflowRunRecord[]>(`${digitalTeamRunsPath(projectId)}${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`)),
    loadDigitalTeamRun: async (runId) => {
      const projection = normalizeRunProjection(await transport.request<unknown>(digitalTeamRunPath(runId)));
      rememberRun(projection.run);
      return projection;
    },
    createDigitalTeamRun: async (projectId, input) => {
      const body = await buildWorkManagementCommandRequest({
        commandType: workManagementClientCommandTypes.digitalTeamRunCreate,
        scopeKind: 'project',
        scopeId: () => projectId,
        operationPrefix: 'digital_team_run_create_',
        value: input,
        expectedRevision: input.templateRevision,
      });
      const projection = normalizeRunProjection(await transport.request<unknown>(digitalTeamRunsPath(projectId), jsonRequest('POST', body)));
      rememberRun(projection.run);
      return projection;
    },
    decideDigitalTeamApproval: async (runId, nodeId, attempt, input) => {
      const value = { nodeId, attempt, ...input };
      const body = await runCommand(runId, workManagementClientCommandTypes.digitalTeamApprovalDecide, 'digital_team_approval_decide_', value, input.expectedRevision);
      return normalizeRunProjection(await transport.request<unknown>(`${digitalTeamRunPath(runId)}/approval`, jsonRequest('POST', body)));
    },
    controlDigitalTeamRun: async (runId, input) => {
      const body = await runCommand(runId, workManagementClientCommandTypes.digitalTeamRunControl, 'digital_team_run_control_', input, input.expectedRevision);
      return normalizeRunProjection(await transport.request<unknown>(`${digitalTeamRunPath(runId)}/control`, jsonRequest('POST', body)));
    },
    requestDigitalTeamRework: async (runId, nodeId, input) => {
      const value = { nodeId, ...input };
      const body = await runCommand(runId, workManagementClientCommandTypes.digitalTeamRework, 'digital_team_rework_', value, input.expectedRevision);
      return normalizeRunProjection(await transport.request<unknown>(`${digitalTeamRunPath(runId)}/rework`, jsonRequest('POST', body)));
    },
  };
}

/** 校验并保留 Core 的正式运行详情结构，不制造第二套 record。 */
function normalizeRunProjection(value: unknown): DigitalTeamRunProjection {
  if (!isRecord(value) || !isRecord(value.run) || typeof value.run.id !== 'string' || !Array.isArray(value.nodeAttempts) || !Array.isArray(value.currentAttempts)) throw new Error('数字团队运行投影无效。');
  return { run: value.run as unknown as DigitalTeamWorkflowRunRecord, nodeAttempts: value.nodeAttempts as DigitalTeamNodeAttemptRecord[], currentAttempts: value.currentAttempts as DigitalTeamNodeAttemptRecord[] };
}

/** 判断普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 项目模板集合路径。 */
function digitalTeamTemplatesPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/digital-team-templates`;
}

/** 项目运行集合路径。 */
function digitalTeamRunsPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/digital-team-runs`;
}

/** 单个运行路径。 */
function digitalTeamRunPath(runId: string): string {
  return `/api/digital-team-runs/${encodeURIComponent(runId)}`;
}
