import { createHash } from 'node:crypto';
import { modelRef } from '@zeus/ai-runtime';
import type { ConversationRepository } from '@zeus/storage';
import { isNativeApiRecord, nativeApiError, type createConversationApplicationOperations } from './conversationApplicationOperations.js';
import type { ModelConnectionService } from './modelConnectionService.js';
import type { AutomationSchedulerOptions } from './automationScheduler.js';

type ConversationOperations = ReturnType<typeof createConversationApplicationOperations>;

/** 自动化到会话的适配只负责请求映射；运行状态和恢复由调度器拥有。 */
export function createAutomationConversationDispatch(options: {
  conversations: Pick<ConversationRepository, 'getById'>;
  modelConnections: Pick<ModelConnectionService, 'listMetadata'>;
  executeConversationDispatchMessage: ConversationOperations['executeConversationDispatchMessage'];
  executeProjectConversationIdempotent: ConversationOperations['executeProjectConversationIdempotent'];
}): AutomationSchedulerOptions['dispatch'] {
  const { conversations, modelConnections, executeConversationDispatchMessage, executeProjectConversationIdempotent } = options;
  return async ({ run, snapshot, project, projects }) => {
    const digest = createHash('sha256').update(run.id).digest('hex').slice(0, 24);
    if (snapshot.conversationMode === 'original') {
      const originalConversation = snapshot.originalConversationId ? conversations.getById(snapshot.originalConversationId) : undefined;
      if (!originalConversation || originalConversation.projectId !== project.id) throw nativeApiError('ZEUS_AUTOMATION_CONFIG_ORIGINAL_CONVERSATION_UNAVAILABLE', '原会话已不存在或不属于目标项目。');
      if (originalConversation.archived) throw nativeApiError('ZEUS_AUTOMATION_DISPATCH_ORIGINAL_CONVERSATION_ARCHIVED', '原会话已归档，自动化不会自行恢复。');
      const response = await executeConversationDispatchMessage({
        params: { projectId: project.id, conversationId: originalConversation.id },
        body: {
          content: snapshot.prompt,
          delivery: 'queue',
          idempotencyKey: `automation:${run.id}`,
          model: snapshot.modelId,
          ...(snapshot.reasoningEffort ? { effort: snapshot.reasoningEffort } : {}),
          ...(snapshot.serviceTier ? { serviceTier: snapshot.serviceTier } : {}),
          permissionMode: snapshot.permissionMode,
        },
        operationIdentity: `automation:${run.id}`,
        providerWriteLifecycle: { markPrepared: async () => undefined, markRpcStarted: () => undefined },
      });
      return readAcceptance(response.body);
    }
    const idempotencyKey = `automation:${run.id}`;
    /** 模型收到一份包含全部项目顺序的单轮指令。 */
    const content = automationTurnPrompt(snapshot.prompt, projects);
    const connection = snapshot.modelSourceId === 'codex' ? undefined : modelConnections.listMetadata().find((candidate: { id: string }) => candidate.id === snapshot.modelSourceId);
    const configuredModel = connection?.models.find((candidate: { id: string }) => candidate.id === snapshot.modelId);
    // 命中的是模型连接就走 Zeus 内核；只有 Codex 订阅来源才交给 app-server。
    const runtimeKind = configuredModel ? 'pi' : 'codex';
    const result = await executeProjectConversationIdempotent(
      project,
      {
        mode: 'create',
        content,
        displayText: snapshot.prompt,
        model: snapshot.modelSourceId === 'codex' ? snapshot.modelId : modelRef(snapshot.modelSourceId, snapshot.modelId),
        agentKind: runtimeKind,
        ...(snapshot.reasoningEffort ? { effort: snapshot.reasoningEffort } : {}),
        ...(snapshot.serviceTier ? { serviceTier: snapshot.serviceTier } : {}),
        permissionMode: snapshot.permissionMode,
        collaborationMode: 'default',
        clientUserMessageId: `automation-client-${digest}`,
        ...(snapshot.skillId ? { skillReferences: [{ id: snapshot.skillId }] } : {}),
        ...(snapshot.pluginIds.length > 0
          ? {
              pluginReferences: snapshot.pluginIds.map((id) => ({
                kind: 'plugin',
                id,
              })),
            }
          : {}),
      },
      idempotencyKey,
      undefined,
      projects.length > 0 ? projects.map((target) => target.id) : [project.id],
    );
    return readAcceptance(result.body);
  };
}

/** 把服务端冻结的项目顺序写进本轮指令，模型不得再把项目拆成会话。 */
function automationTurnPrompt(prompt: string, projects: Array<{ id: string; name: string; localPath: string }>): string {
  if (projects.length === 0) {
    return ['你正在执行一次无项目自动化。本次触发只有一个会话和一个轮次。', '本次运行未选择任何用户项目。不要读取、修改或推断任何用户项目；仅在 Zeus 临时工作区内完成不依赖项目的工作。', '', '用户指令：', prompt].join('\n');
  }
  /** 目标清单保留用户配置顺序，避免模型自行重排。 */
  const targets = projects.map((project, index) => `${index + 1}. ${project.name}\n   目录：${project.localPath}`).join('\n');
  return [
    '你正在执行一次多项目自动化。本次触发只有一个会话和一个轮次。',
    '请按下列顺序将用户指令应用到每个目标项目，保留项目之间的上下文，并明确区分各项目结果；不要为项目另建会话。',
    '',
    '目标项目：',
    targets,
    '',
    '用户指令：',
    prompt,
  ].join('\n');
}

function readAcceptance(value: unknown): { conversationId: string; submissionId: string } {
  const body: Record<string, unknown> = isNativeApiRecord(value) ? value : {};
  const conversation: Record<string, unknown> = isNativeApiRecord(body.conversation) ? body.conversation : {};
  const submission: Record<string, unknown> = isNativeApiRecord(body.submission) ? body.submission : {};
  if (typeof conversation.id !== 'string' || typeof submission.id !== 'string') throw nativeApiError('ZEUS_AUTOMATION_ACCEPTANCE_INVALID', '自动化会话接收结果缺少持久身份。');
  return { conversationId: conversation.id, submissionId: submission.id };
}
