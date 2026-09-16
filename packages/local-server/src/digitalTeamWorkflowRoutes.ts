import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CommandActor } from '@zeus/shared';
import type { WorkManagementMutationRequest } from './workManagementCommandApplication.js';
import { WorkManagementCommandApplication, workManagementCommandHttpError, workManagementCommandTypes } from './workManagementCommandApplication.js';

/** 数字团队模板保存输入由共享校验器在协调器内做最终收口。 */
export type DigitalTeamTemplateSaveInput = Record<string, unknown> & { id?: string; expectedRevision?: number };

/** 数字团队运行创建输入与 Renderer 固定调用保持一致。 */
export interface DigitalTeamRunCreateInput {
  /** 已保存模板身份。 */
  templateId: string;
  /** 用户打开模板时看到的修订，避免静默使用较新定义。 */
  templateRevision: number;
  /** 原子创建的任务名称。 */
  title: string;
  /** 原子创建的任务说明。 */
  description: string;
  /** 创建时冻结的任务事实。 */
  taskFacts: Record<string, unknown>;
}

/** 数字团队人工批准输入。 */
export interface DigitalTeamApprovalInput {
  /** 当前人工节点身份。 */
  nodeId: string;
  /** 当前节点尝试序号。 */
  attempt: number;
  /** 用户是否批准。 */
  approved: boolean;
  /** 批准说明或退回理由。 */
  reason: string;
  /** 运行修订，用于拒绝过期按钮。 */
  expectedRevision: number;
}

/** 数字团队派发控制输入。 */
export interface DigitalTeamRunControlInput {
  /** 只开放暂停和恢复；取消需显式独立业务设计后再开放。 */
  state: 'running' | 'paused';
  /** 运行修订，用于拒绝过期按钮。 */
  expectedRevision: number;
}

/** 数字团队人工返工输入。 */
export interface DigitalTeamReworkInput {
  /** 要重新执行的原节点身份。 */
  nodeId: string;
  /** 必填返工原因。 */
  reason: string;
  /** 运行修订，用于拒绝过期按钮。 */
  expectedRevision: number;
}

/** 业务操作保留原始命令和 actor，审批不能退化为固定本地用户。 */
export interface DigitalTeamCommandContext {
  /** 当前命令身份。 */
  commandId: string;
  /** 稳定幂等身份。 */
  operationIdentity: string;
  /** 发起命令的真实主体。 */
  actor: CommandActor;
}

/** 路由只依赖协调器的业务入口，避免 HTTP 层读取或拼接流程状态。 */
export interface DigitalTeamWorkflowRouteCoordinator {
  /** 列出项目模板。 */
  listTemplates(projectId: string): unknown;
  /** 保存模板。 */
  saveTemplate(projectId: string, input: DigitalTeamTemplateSaveInput, operationIdentity: string): unknown;
  /** 删除模板。 */
  deleteTemplate(projectId: string, templateId: string, expectedRevision: number): unknown;
  /** 列出项目运行。 */
  listRuns(projectId: string): unknown;
  /** 读取含节点尝试的运行投影。 */
  getRunProjection(runId: string): unknown;
  /** 读取运行所属真实任务，用于校验 Command Envelope 作用域。 */
  getRunTaskId(runId: string): string | null;
  /** 在 Core 事务前只读解析仓库基线和冻结角色。 */
  prepareRun(projectId: string, input: DigitalTeamRunCreateInput, operationIdentity: string): Promise<unknown>;
  /** 使用已解析快照原子创建任务和运行。 */
  createRun(projectId: string, input: DigitalTeamRunCreateInput, context: DigitalTeamCommandContext, prepared: unknown): unknown;
  /** 处理人工批准。 */
  decideApproval(runId: string, input: DigitalTeamApprovalInput, context: DigitalTeamCommandContext, prepared?: unknown): unknown;
  /** 最终验收前只读复核候选物理提交。 */
  prepareApproval(runId: string, input: DigitalTeamApprovalInput): Promise<unknown>;
  /** 暂停或恢复派发。 */
  controlRun(runId: string, input: DigitalTeamRunControlInput, context: DigitalTeamCommandContext): unknown;
  /** 发起定点返工。 */
  requestRework(runId: string, input: DigitalTeamReworkInput, context: DigitalTeamCommandContext): unknown;
  /** 把命令回执中的紧凑身份解析为当前公开投影。 */
  resolveMutationResult(result: unknown): unknown;
  /** 持久化成功后发布模板或运行变化。 */
  publishMutation(result: unknown): void;
  /** 状态改变后立即唤醒协调循环。 */
  kick(): void;
}

/** 数字团队公开路由全部通过现有 Command Envelope 账本。 */
export function registerDigitalTeamWorkflowRoutes(options: {
  /** 本地 Fastify 服务。 */
  server: FastifyInstance;
  /** 已有工作管理命令应用。 */
  application: WorkManagementCommandApplication;
  /** 数字团队协调器。 */
  coordinator: DigitalTeamWorkflowRouteCoordinator;
  /** 将已提交 SQLite 状态刷入持久文件。 */
  save(): Promise<void>;
}): void {
  options.server.get('/api/projects/:projectId/digital-team-templates', async (request: FastifyRequest<{ Params: { projectId: string } }>) => options.coordinator.listTemplates(request.params.projectId));
  options.server.get('/api/projects/:projectId/digital-team-runs', async (request: FastifyRequest<{ Params: { projectId: string } }>) => options.coordinator.listRuns(request.params.projectId));
  options.server.get('/api/digital-team-runs/:runId', async (request: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    const projection = options.coordinator.getRunProjection(request.params.runId);
    return projection ?? reply.code(404).send({ error: 'ZEUS_DIGITAL_TEAM_RUN_NOT_FOUND', message: '数字团队运行不存在。' });
  });

  options.server.post('/api/projects/:projectId/digital-team-templates', async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<DigitalTeamTemplateSaveInput> }>, reply) =>
    executeCoreRoute<DigitalTeamTemplateSaveInput>(options, reply, request.body, workManagementCommandTypes.digitalTeamTemplateSave, 'project', request.params.projectId, (input, operationIdentity) =>
      options.coordinator.saveTemplate(request.params.projectId, input, operationIdentity),
    ),
  );

  options.server.put(
    '/api/projects/:projectId/digital-team-templates/:templateId',
    async (request: FastifyRequest<{ Params: { projectId: string; templateId: string }; Body: WorkManagementMutationRequest<DigitalTeamTemplateSaveInput> }>, reply) =>
      executeCoreRoute<DigitalTeamTemplateSaveInput>(options, reply, request.body, workManagementCommandTypes.digitalTeamTemplateSave, 'project', request.params.projectId, (input, operationIdentity) =>
        options.coordinator.saveTemplate(request.params.projectId, { ...input, id: request.params.templateId }, operationIdentity),
      ),
  );

  options.server.delete(
    '/api/projects/:projectId/digital-team-templates/:templateId',
    async (request: FastifyRequest<{ Params: { projectId: string; templateId: string }; Body: WorkManagementMutationRequest<{ expectedRevision: number }> }>, reply) =>
      executeCoreRoute<{ expectedRevision: number }>(options, reply, request.body, workManagementCommandTypes.digitalTeamTemplateDelete, 'project', request.params.projectId, (input) =>
        options.coordinator.deleteTemplate(request.params.projectId, request.params.templateId, input.expectedRevision),
      ),
  );

  options.server.post('/api/projects/:projectId/digital-team-runs', async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<DigitalTeamRunCreateInput> }>, reply) =>
    executeCoreRoute<DigitalTeamRunCreateInput>(
      options,
      reply,
      request.body,
      workManagementCommandTypes.digitalTeamRunCreate,
      'project',
      request.params.projectId,
      (input, _operationIdentity, prepared, context) => {
        const result = options.coordinator.createRun(request.params.projectId, input, context, prepared);
        return result;
      },
      201,
      (input, operationIdentity) => options.coordinator.prepareRun(request.params.projectId, input, operationIdentity),
    ),
  );

  options.server.post('/api/digital-team-runs/:runId/approval', async (request: FastifyRequest<{ Params: { runId: string }; Body: WorkManagementMutationRequest<DigitalTeamApprovalInput> }>, reply) =>
    executeCoreRoute<DigitalTeamApprovalInput>(
      options,
      reply,
      request.body,
      workManagementCommandTypes.digitalTeamApprovalDecide,
      'task',
      () => requireRunTaskId(options.coordinator, request.params.runId),
      (input, _operationIdentity, prepared, context) => {
        const result = options.coordinator.decideApproval(request.params.runId, input, context, prepared);
        return result;
      },
      200,
      (input) => options.coordinator.prepareApproval(request.params.runId, input),
    ),
  );

  options.server.post('/api/digital-team-runs/:runId/control', async (request: FastifyRequest<{ Params: { runId: string }; Body: WorkManagementMutationRequest<DigitalTeamRunControlInput> }>, reply) =>
    executeCoreRoute<DigitalTeamRunControlInput>(
      options,
      reply,
      request.body,
      workManagementCommandTypes.digitalTeamRunControl,
      'task',
      () => requireRunTaskId(options.coordinator, request.params.runId),
      (input, _operationIdentity, _prepared, context) => {
        const result = options.coordinator.controlRun(request.params.runId, input, context);
        return result;
      },
    ),
  );

  options.server.post('/api/digital-team-runs/:runId/rework', async (request: FastifyRequest<{ Params: { runId: string }; Body: WorkManagementMutationRequest<DigitalTeamReworkInput> }>, reply) =>
    executeCoreRoute<DigitalTeamReworkInput>(
      options,
      reply,
      request.body,
      workManagementCommandTypes.digitalTeamRework,
      'task',
      () => requireRunTaskId(options.coordinator, request.params.runId),
      (input, _operationIdentity, _prepared, context) => {
        const result = options.coordinator.requestRework(request.params.runId, input, context);
        return result;
      },
    ),
  );
}

/** 统一执行数字团队 Core mutation，并保留命令幂等回执。 */
async function executeCoreRoute<TInput extends object>(
  options: { application: WorkManagementCommandApplication; coordinator: DigitalTeamWorkflowRouteCoordinator; save(): Promise<void> },
  reply: FastifyReply,
  value: unknown,
  commandType: (typeof workManagementCommandTypes)[keyof typeof workManagementCommandTypes],
  scopeKind: 'project' | 'task',
  scopeId: string | (() => string),
  mutate: (input: TInput, operationIdentity: string, prepared: unknown, context: DigitalTeamCommandContext) => unknown,
  successStatusCode = 200,
  prepare?: (input: TInput, operationIdentity: string) => Promise<unknown>,
): Promise<unknown> {
  try {
    /** 动态运行路由先由 runId 解析真实任务身份。 */
    const resolvedScopeId = typeof scopeId === 'function' ? scopeId() : scopeId;
    const parsed = options.application.parse<TInput>({ value, commandType, scopeKind, expectedScopeId: () => resolvedScopeId });
    /** 信封修订必须与实际受保护资源的业务修订一致；创建运行保护的是模板修订。 */
    const inputRevision =
      'expectedRevision' in parsed.input && Number.isSafeInteger(parsed.input.expectedRevision)
        ? (parsed.input.expectedRevision as number)
        : commandType === workManagementCommandTypes.digitalTeamRunCreate && 'templateRevision' in parsed.input && Number.isSafeInteger(parsed.input.templateRevision)
          ? (parsed.input.templateRevision as number)
          : null;
    if (parsed.command.expectedRevision !== inputRevision) throw new DigitalTeamWorkflowRouteError(400, 'ZEUS_DIGITAL_TEAM_COMMAND_REVISION_MISMATCH', '命令修订与业务输入不一致。');
    const replay = options.application.replayAcceptedCore<TInput, unknown>({ parsed, destinationId: 'digital-team-workflow-coordinator', resourceId: resolvedScopeId });
    if (replay) return reply.code(successStatusCode).send(options.coordinator.resolveMutationResult(replay.result));
    /** 只读预检可跨异步边界，任何业务写入仍在随后单一 Core 事务中完成。 */
    const prepared = prepare ? await prepare(parsed.input, parsed.operationIdentity) : undefined;
    let fullResult: unknown;
    const mutation = options.application.executeCore({
      parsed,
      destinationId: 'digital-team-workflow-coordinator',
      resourceId: resolvedScopeId,
      mutateBusinessState: () => {
        fullResult = mutate(parsed.input, parsed.operationIdentity, prepared, { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor });
        return compactMutationResult(fullResult);
      },
    });
    /** Core 回执与业务状态同事务提交后，再刷持久文件并唤醒协调器。 */
    if (!mutation.replayed) {
      await options.save();
      options.coordinator.publishMutation(mutation.result);
      options.coordinator.kick();
    }
    return reply.code(successStatusCode).send(fullResult ?? options.coordinator.resolveMutationResult(mutation.result));
  } catch (error) {
    return sendRouteError(reply, error);
  }
}

/** 命令账本只保存有界身份，完整冻结图和历史结果由成功响应另行读取。 */
function compactMutationResult(value: unknown): Record<string, unknown> {
  if (isRecord(value) && isRecord(value.run) && typeof value.run.id === 'string') {
    return { resourceKind: 'run', runId: value.run.id, taskId: value.run.taskId, projectId: value.run.projectId, revision: value.run.revision };
  }
  if (isRecord(value) && typeof value.id === 'string' && typeof value.projectId === 'string') {
    return { resourceKind: 'template', templateId: value.id, projectId: value.projectId, revision: value.revision };
  }
  throw new DigitalTeamWorkflowRouteError(500, 'ZEUS_DIGITAL_TEAM_MUTATION_RESULT_INVALID', '数字团队命令没有返回可审计资源身份。');
}

/** 判断普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 运行操作必须使用真实任务作用域，拒绝把 runId 伪装成 taskId。 */
function requireRunTaskId(coordinator: DigitalTeamWorkflowRouteCoordinator, runId: string): string {
  const taskId = coordinator.getRunTaskId(runId);
  if (!taskId) throw new DigitalTeamWorkflowRouteError(404, 'ZEUS_DIGITAL_TEAM_RUN_NOT_FOUND', '数字团队运行不存在。');
  return taskId;
}

/** 数字团队路由的稳定错误。 */
export class DigitalTeamWorkflowRouteError extends Error {
  /** 错误名称。 */
  readonly name = 'DigitalTeamWorkflowRouteError';

  /** 保存 HTTP 状态与稳定错误码。 */
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 将已知业务错误投影为有限 HTTP 响应。 */
function sendRouteError(reply: FastifyReply, error: unknown): unknown {
  if (error instanceof DigitalTeamWorkflowRouteError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  const mapped = workManagementCommandHttpError(error);
  if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
  const statusCode = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'statusCode') === 'number' ? Number(Reflect.get(error, 'statusCode')) : null;
  const code = typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string' ? String(Reflect.get(error, 'code')) : null;
  if (statusCode && code) return reply.code(statusCode).send({ error: code, message: error instanceof Error ? error.message : String(error) });
  throw error;
}
