import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ConversationChoiceQueryApplication } from './conversationChoiceQueryApplication.js';

interface CatchUpConversationChoice {
  id: string;
  archived: boolean;
  transportKind: string;
  providerThreadId: string | null;
  providerState: string | null;
}

/** HTTP 只校验资源存在性并映射 404；选择、排序与运行态投影均由 Application 拥有。 */
export function registerConversationChoiceQueryRoutes(options: {
  server: FastifyInstance;
  application: ConversationChoiceQueryApplication;
  synchronizeConversations?: (conversationIds: readonly string[]) => Promise<void>;
}): void {
  options.server.get('/api/projects/:projectId/conversation-choices', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = options.application.project(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const choices = options.application.listProjectChoices(project.id);
    scheduleConversationCatchUp(options, choices);
    return { projectId: project.id, choices, items: choices };
  });

  options.server.get('/api/projects/:projectId/conversation-choice-groups', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    const project = options.application.project(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const snapshot = options.application.buildProjectGroups(project.id);
    scheduleConversationCatchUp(options, [snapshot.projectChoices.choices, ...Object.values(snapshot.taskChoicesByTaskId).map((choices) => choices.choices)].flat());
    return snapshot;
  });

  options.server.get('/api/tasks/:taskId/conversation-choices', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = options.application.task(request.params.taskId);
    if (!task) return reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
    const project = options.application.project(task.projectId);
    if (!project) return reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
    const snapshot = options.application.listTaskChoices(task.id, project.id);
    scheduleConversationCatchUp(options, snapshot.choices);
    return snapshot;
  });
}

function scheduleConversationCatchUp(
  options: { synchronizeConversations?: (conversationIds: readonly string[]) => Promise<void> },
  choices: readonly CatchUpConversationChoice[],
): void {
  if (!options.synchronizeConversations) return;
  const conversationIds = choices
    .filter(
      (choice) =>
        !choice.archived &&
        choice.transportKind === 'codex_native' &&
        Boolean(choice.providerThreadId?.trim()) &&
        choice.providerState !== 'archived' &&
        choice.providerState !== 'closed' &&
        choice.providerState !== 'failed',
    )
    .map((choice) => choice.id);
  if (conversationIds.length === 0) return;
  // 列表读取不等待 Provider；对账完成后会通过耐久事件与下一轮权威快照自动收口侧栏。
  void options.synchronizeConversations(conversationIds).catch(() => undefined);
}
