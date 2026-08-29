import type { AutomationRunRepository, AutomationRunStatus, AutomationTaskRepository, CreateAutomationTaskInput, UpdateAutomationTaskInput } from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { computeNextRun } from './automationScheduler.js';

export interface RegisterAutomationRoutesOptions {
  server: FastifyInstance;
  tasks: AutomationTaskRepository;
  runs: AutomationRunRepository;
  save(): Promise<void>;
  kick(): void;
  now(): string;
}

export function registerAutomationRoutes(options: RegisterAutomationRoutesOptions): void {
  const { server, tasks, runs } = options;

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
    try {
      const created = tasks.create(request.body);
      tasks.setNextRun(created.id, computeNextRun(created, new Date(options.now())));
      await options.save();
      options.kick();
      return reply.code(201).send({ ...created, projectIds: tasks.listTargets(created.id).map((target) => target.projectId) });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.patch('/api/automations/:automationId', async (request: FastifyRequest<{ Params: { automationId: string }; Body: UpdateAutomationTaskInput }>, reply) => {
    try {
      const updated = tasks.update(request.params.automationId, request.body);
      tasks.setNextRun(updated.id, computeNextRun(updated, new Date(options.now())));
      await options.save();
      options.kick();
      return { ...updated, projectIds: tasks.listTargets(updated.id).map((target) => target.projectId) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.post('/api/automations/:automationId/run', async (request: FastifyRequest<{ Params: { automationId: string } }>, reply) => {
    try {
      const task = tasks.getById(request.params.automationId);
      if (!task) return reply.code(404).send({ error: 'ZEUS_AUTOMATION_CONFIG_NOT_FOUND', message: '自动化任务不存在。' });
      const scheduledAt = options.now();
      const nonce = `${scheduledAt}:${Math.random().toString(36).slice(2, 10)}`;
      const items = tasks.listTargets(task.id).filter((target) => target.enabled).map((target) => runs.enqueue({
        automationId: task.id,
        projectId: target.projectId,
        triggerKind: 'manual',
        triggerIdentity: `manual:${nonce}`,
        scheduledAt,
      }));
      await options.save();
      options.kick();
      return reply.code(202).send({ items });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.post('/api/automations/:automationId/status', async (request: FastifyRequest<{ Params: { automationId: string }; Body: { status?: string } }>, reply) => {
    try {
      if (request.body.status !== 'active' && request.body.status !== 'paused') throw new Error('ZEUS_AUTOMATION_CONFIG_STATUS_INVALID: status 必须是 active 或 paused。');
      const updated = tasks.setStatus(request.params.automationId, request.body.status);
      if (updated.status === 'active' && !updated.nextRunAt) tasks.setNextRun(updated.id, computeNextRun(updated, new Date(options.now())));
      await options.save();
      if (updated.status === 'active') options.kick();
      return updated;
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.post('/api/automations/:automationId/full-access-grant', async (request: FastifyRequest<{ Params: { automationId: string }; Body: { expectedRevision?: number; granted?: boolean } }>, reply) => {
    try {
      if (!Number.isInteger(request.body.expectedRevision) || typeof request.body.granted !== 'boolean') throw new Error('ZEUS_AUTOMATION_PERMISSION_GRANT_INVALID: 授权参数无效。');
      tasks.setFullAccessGrant(request.params.automationId, request.body.expectedRevision!, request.body.granted);
      await options.save();
      return { granted: request.body.granted, revision: request.body.expectedRevision };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.delete('/api/automations/:automationId', async (request: FastifyRequest<{ Params: { automationId: string } }>, reply) => {
    try {
      tasks.delete(request.params.automationId);
      await options.save();
      return reply.code(204).send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  server.post('/api/automation-runs/:runId/read', async (request: FastifyRequest<{ Params: { runId: string } }>, reply) => {
    try {
      const run = runs.acknowledge(request.params.runId);
      await options.save();
      return run;
    } catch (error) {
      return sendError(reply, error);
    }
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const code = /\b(ZEUS_[A-Z0-9_]+)\b/u.exec(message)?.[1] ?? 'ZEUS_AUTOMATION_INTERNAL_ERROR';
  const status = code.endsWith('_NOT_FOUND') ? 404 : code.includes('REVISION_CONFLICT') || code.includes('STALE') ? 409 : code === 'ZEUS_AUTOMATION_INTERNAL_ERROR' ? 500 : 400;
  return reply.code(status).send({ error: code, message });
}
