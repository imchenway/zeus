import type { ZentaoRemoteKind, ZentaoTaskSyncRequest, ZentaoTaskEffortRequest } from '@zeus/shared';
import type { AppendAuditLogInput, TaskRepository } from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { IntegrationCommandApplication, integrationCommandHttpError, integrationCommandTypes, type IntegrationCommandRequest } from './integrationCommandApplication.js';
import { requireZentaoTaskLink, validateZentaoEffort, validateZentaoTaskSyncInput, type ZentaoSyncService } from './zentaoSyncService.js';

/** 禅道列表是只读直连；远端写入必须经过 IntegrationCommandApplication 的确认后命令。 */
export function registerZentaoSyncRoutes(options: {
  server: FastifyInstance;
  application: IntegrationCommandApplication;
  service: ZentaoSyncService;
  tasks: Pick<TaskRepository, 'getById' | 'updateContent'>;
  recordTaskEvent(input: { taskId: string; eventType: string; title: string; payload: Record<string, unknown> }): void;
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  redactSensitiveText(value: string): { text: string };
}): void {
  const { server } = options;

  server.get('/api/zentao-instances/:instanceId/projects', async (request: FastifyRequest<{ Params: { instanceId: string } }>, reply) => {
    try {
      return { items: await options.service.listProjects(request.params.instanceId) };
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '禅道项目读取失败。');
    }
  });

  server.get('/api/zentao-instances/:instanceId/projects/:projectId/executions', async (request: FastifyRequest<{ Params: { instanceId: string; projectId: string } }>, reply) => {
    try {
      return { items: await options.service.listExecutions(request.params.instanceId, request.params.projectId) };
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '禅道执行读取失败。');
    }
  });

  server.get('/api/zentao-instances/:instanceId/products', async (request: FastifyRequest<{ Params: { instanceId: string } }>, reply) => {
    try {
      return { items: await options.service.listProducts(request.params.instanceId) };
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '禅道产品读取失败。');
    }
  });

  server.get(
    '/api/zentao-instances/:instanceId/my-items',
    async (
      request: FastifyRequest<{
        Params: { instanceId: string };
        Querystring: { kind?: string; query?: string; offset?: string; limit?: string };
      }>,
      reply,
    ) => {
      try {
        const query = request.query;
        const kind = parseRemoteKind(query.kind);
        if (query.kind && !kind) return reply.code(400).send({ error: 'ZEUS_ZENTAO_LIST_INPUT_INVALID', message: 'kind 仅支持 task 或 bug。' });
        return options.service.listMyItems(request.params.instanceId, {
          kind: kind ?? undefined,
          query: query.query,
          offset: parseQueryInteger(query.offset),
          limit: parseQueryInteger(query.limit),
        });
      } catch (error) {
        return sendZentaoError(reply, error, options.redactSensitiveText, '禅道我的任务和缺陷读取失败。');
      }
    },
  );

  server.get(
    '/api/zentao-instances/:instanceId/items',
    async (
      request: FastifyRequest<{
        Params: { instanceId: string };
        Querystring: { kind?: string; projectId?: string; executionId?: string; productId?: string; query?: string; offset?: string; limit?: string };
      }>,
      reply,
    ) => {
      try {
        const query = request.query;
        const kind = parseRemoteKind(query.kind);
        if (!kind || !query.projectId) return reply.code(400).send({ error: 'ZEUS_ZENTAO_LIST_INPUT_INVALID', message: 'kind 和 projectId 是必填项。' });
        return options.service.listItems(request.params.instanceId, {
          kind,
          projectId: query.projectId,
          executionId: query.executionId,
          productId: query.productId,
          query: query.query,
          offset: parseQueryInteger(query.offset),
          limit: parseQueryInteger(query.limit),
        });
      } catch (error) {
        return sendZentaoError(reply, error, options.redactSensitiveText, '禅道任务列表读取失败。');
      }
    },
  );

  server.get('/api/zentao-instances/:instanceId/items/:kind/:objectId', async (request: FastifyRequest<{ Params: { instanceId: string; kind: string; objectId: string } }>, reply) => {
    try {
      const kind = parseRemoteKind(request.params.kind);
      if (!kind) return reply.code(400).send({ error: 'ZEUS_ZENTAO_KIND_INVALID', message: '禅道对象类型无效。' });
      return options.service.getItem(request.params.instanceId, kind, request.params.objectId);
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '禅道对象读取失败。');
    }
  });

  server.post('/api/zentao-instances/:instanceId/sync-task', async (request: FastifyRequest<{ Params: { instanceId: string }; Body: IntegrationCommandRequest<ZentaoTaskSyncRequest> }>, reply) => {
    try {
      const parsed = options.application.parse<ZentaoTaskSyncRequest>({
        value: request.body,
        commandType: integrationCommandTypes.zentaoTaskSync,
        scopeKind: 'integration_account',
        expectedScopeId: () => request.params.instanceId,
      });
      assertSyncInput(parsed.input);
      let task = options.tasks.getById(parsed.input.taskId);
      if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: '本地任务不存在。' });
      const mutation = await options.application.executeExternal({
        parsed,
        destinationId: 'zentao_task',
        resourceId: `${request.params.instanceId}:${parsed.input.taskId}`,
        externalOperationId: `${parsed.command.commandType}:${parsed.operationIdentity}`,
        beforeWrite: async () => {
          task = options.tasks.getById(parsed.input.taskId);
          if (!task) throw routeError('ZEUS_TASK_NOT_FOUND', '本地任务不存在。', 404);
          if (task.updatedAt !== parsed.input.expectedUpdatedAt) throw routeError('ZEUS_TASK_EDIT_CONFLICT', '本地任务在确认后发生了变化，请重新打开同步窗口。', 409);
        },
        invoke: () => options.service.pushTask(request.params.instanceId, parsed.input, task!),
        mutateAcceptedBusinessState: (result) => {
          const existingTask = options.tasks.getById(parsed.input.taskId);
          if (!existingTask) throw routeError('ZEUS_TASK_NOT_FOUND', '本地任务不存在。', 404);
          const sourceContext = parseSourceContext(existingTask.sourceContextJson);
          const updated = options.tasks.updateContent(existingTask.id, {
            expectedUpdatedAt: parsed.input.expectedUpdatedAt,
            sourceContext: { ...sourceContext, zentao: result.link },
          });
          options.recordTaskEvent({
            taskId: updated.task.id,
            eventType: `task.zentao.${result.mode}`,
            title: result.mode === 'created' ? '已创建到禅道' : '已同步到禅道',
            payload: { instanceId: request.params.instanceId, kind: result.link.kind, objectId: result.link.objectId, sourceUrl: result.link.sourceUrl },
          });
          options.appendAuditLog({
            actorType: 'local_api',
            action: `zentao.task.${result.mode}`,
            resourceType: 'task',
            resourceId: updated.task.id,
            payload: { instanceId: request.params.instanceId, kind: result.link.kind, objectId: result.link.objectId },
          });
        },
      });
      const latestTask = options.tasks.getById(parsed.input.taskId);
      return { ...mutation.result, task: latestTask ?? task };
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '同步任务到禅道失败。');
    }
  });
  /** 工时查询的 taskId 是本地任务身份，不能作为任意远端编号透传。 */
  server.get('/api/zentao-instances/:instanceId/tasks/:taskId/efforts', async (request: FastifyRequest<{ Params: { instanceId: string; taskId: string } }>, reply) => {
    try {
      /** 从任务仓库解析已经保存的关联。 */
      const task = options.tasks.getById(request.params.taskId);
      if (!task) throw routeError('ZEUS_TASK_NOT_FOUND', '本地任务不存在。', 404);
      return await options.service.getEfforts(request.params.instanceId, task);
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '禅道工时读取失败。');
    }
  });

  /** 工时写入沿用集成命令的去重、未知结果保护和耐久回执。 */
  server.post('/api/zentao-instances/:instanceId/tasks/:taskId/efforts', async (request: FastifyRequest<{ Params: { instanceId: string; taskId: string }; Body: IntegrationCommandRequest<ZentaoTaskEffortRequest> }>, reply) => {
    try {
      /** 命令身份与实例范围必须与当前路由匹配。 */
      const parsed = options.application.parse<ZentaoTaskEffortRequest>({
        value: request.body,
        commandType: integrationCommandTypes.zentaoTaskEffortRecord,
        scopeKind: 'integration_account',
        expectedScopeId: () => request.params.instanceId,
      });
      /** 只接受本次登记需要的明确字段。 */
      const allowed = ['taskId', 'expectedUpdatedAt', 'date', 'consumed', 'left', 'work'];
      if (Object.keys(parsed.input).some((key) => !allowed.includes(key)) || parsed.input.taskId !== request.params.taskId) throw routeError('ZEUS_ZENTAO_EFFORT_INPUT_INVALID', '工时参数或任务编号无效。', 400);
      validateZentaoEffort(parsed.input);
      /** 写入前重新读取任务，禁止将确认过的工时提交到新关联。 */
      let task = options.tasks.getById(parsed.input.taskId);
      if (!task) throw routeError('ZEUS_TASK_NOT_FOUND', '本地任务不存在。', 404);
      /** 回执记录的远端身份只取自任务关联。 */
      const link = requireZentaoTaskLink(task, request.params.instanceId);
      /** 重放已接受的命令只返回原回执，不再次登记工时。 */
      const mutation = await options.application.executeExternal({
        parsed,
        destinationId: 'zentao_task',
        resourceId: `${request.params.instanceId}:${parsed.input.taskId}`,
        externalOperationId: `${parsed.command.commandType}:${parsed.operationIdentity}`,
        beforeWrite: async () => {
          task = options.tasks.getById(parsed.input.taskId);
          if (!task) throw routeError('ZEUS_TASK_NOT_FOUND', '本地任务不存在。', 404);
          if (task.updatedAt !== parsed.input.expectedUpdatedAt) throw routeError('ZEUS_TASK_EDIT_CONFLICT', '任务在确认后发生变化，请重新打开工时窗口。', 409);
          requireZentaoTaskLink(task, request.params.instanceId);
        },
        invoke: () => options.service.recordEffort(request.params.instanceId, parsed.input, task!),
        mutateAcceptedBusinessState: () => {
          options.recordTaskEvent({
            taskId: parsed.input.taskId,
            eventType: 'task.zentao.effort.recorded',
            title: '已登记禅道工时',
            payload: { instanceId: request.params.instanceId, objectId: link.objectId, date: parsed.input.date, consumed: parsed.input.consumed, left: parsed.input.left, work: parsed.input.work.trim() },
          });
          options.appendAuditLog({
            actorType: 'local_api',
            action: 'zentao.task.effort.recorded',
            resourceType: 'task',
            resourceId: parsed.input.taskId,
            payload: { instanceId: request.params.instanceId, objectId: link.objectId, date: parsed.input.date, consumed: parsed.input.consumed, left: parsed.input.left },
          });
        },
      });
      return { task: mutation.result };
    } catch (error) {
      return sendZentaoError(reply, error, options.redactSensitiveText, '禅道工时登记失败。');
    }
  });
}

/** 远端对象类型只接受已知枚举。 */
function parseRemoteKind(value: string | undefined): ZentaoRemoteKind | null {
  return value === 'task' || value === 'bug' ? value : null;
}

function parseQueryInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/u.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function assertSyncInput(value: ZentaoTaskSyncRequest): void {
  const allowed = ['taskId', 'expectedUpdatedAt', 'kind', 'projectId', 'executionId', 'productId', 'estStarted', 'deadline', 'remoteType', 'estimate'];
  const actual = Object.keys(value as object);
  const unexpected = actual.filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw routeError('ZEUS_INTEGRATION_COMMAND_INVALID', `禅道同步参数包含不支持的字段：${unexpected.join(', ')}。`, 400);
  if (typeof value.taskId !== 'string' || typeof value.expectedUpdatedAt !== 'string' || typeof value.projectId !== 'string' || !parseRemoteKind(value.kind)) {
    throw routeError('ZEUS_ZENTAO_SYNC_INPUT_INVALID', '禅道同步参数不完整。', 400);
  }
  for (const id of [value.projectId, value.executionId, value.productId].filter((candidate): candidate is string => candidate !== undefined)) {
    if (typeof id !== 'string' || !/^\d+$/u.test(id)) throw routeError('ZEUS_ZENTAO_ID_INVALID', '禅道目标编号无效。', 400);
  }
  validateZentaoTaskSyncInput(value);
}

function parseSourceContext(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function routeError(code: string, message: string, statusCode: number): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode });
}

function sendZentaoError(reply: FastifyReply, error: unknown, redactSensitiveText: (value: string) => { text: string }, fallback: string) {
  const commandError = integrationCommandHttpError(error);
  if (commandError) return reply.code(commandError.statusCode).send(commandError.payload);
  const candidate = error as { code?: unknown; statusCode?: unknown; message?: unknown };
  const code = typeof candidate?.code === 'string' ? candidate.code : 'ZEUS_ZENTAO_OPERATION_FAILED';
  const statusCode = typeof candidate?.statusCode === 'number' && candidate.statusCode >= 400 && candidate.statusCode <= 599 ? candidate.statusCode : 500;
  const message = typeof candidate?.message === 'string' && candidate.message.trim() ? redactSensitiveText(candidate.message).text.slice(0, 2_048) : fallback;
  return reply.code(statusCode).send({ error: code, message });
}
