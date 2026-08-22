import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ConversationChoiceQueryApplication } from './conversationChoiceQueryApplication.js';

/** HTTP 只校验资源存在性并映射 404；选择、排序与运行态投影均由 Application 拥有。 */
export function registerConversationChoiceQueryRoutes(options: { server: FastifyInstance; application: ConversationChoiceQueryApplication }): void {
  options.server.get('/api/projects/:projectId/conversation-choices', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = options.application.project(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const choices = options.application.listProjectChoices(project.id);
    return { projectId: project.id, choices, items: choices };
  });

  options.server.get('/api/projects/:projectId/conversation-choice-groups', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = options.application.project(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    return options.application.buildProjectGroups(project.id);
  });

  options.server.get('/api/tasks/:taskId/conversation-choices', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = options.application.task(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    const project = options.application.project(task.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    return options.application.listTaskChoices(task.id, project.id);
  });
}
