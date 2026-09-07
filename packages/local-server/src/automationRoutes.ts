import type { AutomationRunRepository, AutomationRunStatus, AutomationTaskRepository, CreateAutomationTaskInput, UpdateAutomationTaskInput, ZeusDatabasePort } from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AutomationMutationApplication, type AutomationMutationResult } from './automationMutationApplication.js';
import { computeNextRun } from './automationScheduler.js';

export interface RegisterAutomationRoutesOptions {
  server: FastifyInstance;
  tasks: AutomationTaskRepository;
  runs: AutomationRunRepository;
  db: ZeusDatabasePort;
  kick(): void;
  now(): string;
}

export function registerAutomationRoutes(options: RegisterAutomationRoutesOptions): void {
  const { server, tasks, runs } = options;
  const application = new AutomationMutationApplication(options.db);
  const mutate = (request: FastifyRequest, reply: FastifyReply, operation: () => AutomationMutationResult) => {
    try {
      const result = application.execute({ method: request.method, url: request.url, body: request.body, key: request.headers['idempotency-key'] }, operation);
      options.kick();
      return reply.code(result.statusCode).send(result.body);
    } catch (error) {
      return sendError(reply, error);
    }
  };

  server.get('/api/automations', async () => ({
    items: tasks.list().map((task) => ({ ...task, projectIds: tasks.listTargets(task.id).map((target) => target.projectId), runs: runs.listByAutomation(task.id, 20) })),
  }));

  server.get('/api/automations/inbox', async (request: FastifyRequest<{ Querystring: { unread?: string; status?: string } }>, reply) => {
    try {
      return { items: runs.listInbox({ unreadOnly: request.query.unread === 'true', status: request.query.status as AutomationRunStatus | undefined }) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.post('/api/automations', async (request: FastifyRequest<{ Body: CreateAutomationTaskInput }>, reply) => {
    return mutate(request, reply, () => {
      const created = tasks.create(request.body);
      tasks.setNextRun(created.id, computeNextRun(created, new Date(options.now())));
      return { statusCode: 201, body: { ...created, projectIds: tasks.listTargets(created.id).map((target) => target.projectId) } };
    });
  });

  server.patch('/api/automations/:automationId', async (request: FastifyRequest<{ Params: { automationId: string }; Body: UpdateAutomationTaskInput }>, reply) => {
    return mutate(request, reply, () => {
      const updated = tasks.update(request.params.automationId, request.body);
      tasks.setNextRun(updated.id, computeNextRun(updated, new Date(options.now())));
      return { statusCode: 200, body: { ...updated, projectIds: tasks.listTargets(updated.id).map((target) => target.projectId) } };
    });
  });

  server.post('/api/automations/:automationId/run', async (request: FastifyRequest<{ Params: { automationId: string } }>, reply) => {
    return mutate(request, reply, () => {
      const task = tasks.getById(request.params.automationId);
      if (!task) throw new Error('ZEUS_AUTOMATION_CONFIG_NOT_FOUND: 自动化任务不存在。');
      const scheduledAt = options.now();
      const nonce = request.headers['idempotency-key'];
      const items = tasks
        .listTargets(task.id)
        .filter((target) => target.enabled)
        .map((target) =>
          runs.enqueue({
            automationId: task.id,
            projectId: target.projectId,
            triggerKind: 'manual',
            triggerIdentity: `manual:${nonce}`,
            scheduledAt,
          }),
        );
      return { statusCode: 202, body: { items } };
    });
  });

  server.post('/api/automations/:automationId/status', async (request: FastifyRequest<{ Params: { automationId: string }; Body: { status?: string } }>, reply) => {
    return mutate(request, reply, () => {
      if (request.body.status !== 'active' && request.body.status !== 'paused') throw new Error('ZEUS_AUTOMATION_CONFIG_STATUS_INVALID: status 必须是 active 或 paused。');
      const updated = tasks.setStatus(request.params.automationId, request.body.status);
      if (updated.status === 'active' && !updated.nextRunAt) tasks.setNextRun(updated.id, computeNextRun(updated, new Date(options.now())));
      return { statusCode: 200, body: updated };
    });
  });

  server.post('/api/automations/:automationId/full-access-grant', async (request: FastifyRequest<{ Params: { automationId: string }; Body: { expectedRevision?: number; granted?: boolean } }>, reply) => {
    return mutate(request, reply, () => {
      if (!Number.isInteger(request.body.expectedRevision) || typeof request.body.granted !== 'boolean') throw new Error('ZEUS_AUTOMATION_PERMISSION_GRANT_INVALID: 授权参数无效。');
      tasks.setFullAccessGrant(request.params.automationId, request.body.expectedRevision!, request.body.granted);
      return { statusCode: 200, body: { granted: request.body.granted, revision: request.body.expectedRevision } };
    });
  });

  server.delete('/api/automations/:automationId', async (request: FastifyRequest<{ Params: { automationId: string } }>, reply) => {
    return mutate(request, reply, () => {
      tasks.delete(request.params.automationId);
      return { statusCode: 204, body: null };
    });
  });

  server.post('/api/automation-runs/:runId/read', async (request: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    return mutate(request, reply, () => {
      const run = runs.acknowledge(request.params.runId);
      return { statusCode: 200, body: run };
    });
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /\b(ZEUS_[A-Z0-9_]+)\b/u.exec(message)?.[1] ?? 'ZEUS_AUTOMATION_INTERNAL_ERROR';
  const status = code.endsWith('_NOT_FOUND') ? 404 : code.includes('CONFLICT') || code.includes('STALE') || code.includes('OUTCOME_UNKNOWN') ? 409 : code === 'ZEUS_AUTOMATION_INTERNAL_ERROR' ? 500 : 400;
  return reply.code(status).send({ error: code, message });
}
