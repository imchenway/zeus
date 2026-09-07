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
  return async ({ run, snapshot, project }) => {
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
    const connection = snapshot.modelSourceId === 'codex' ? undefined : modelConnections.listMetadata().find((candidate: { id: string }) => candidate.id === snapshot.modelSourceId);
    const configuredModel = connection?.models.find((candidate: { id: string; runtimeAdapter?: string }) => candidate.id === snapshot.modelId);
    const runtimeKind = configuredModel?.runtimeAdapter === 'pi_sdk' ? 'pi' : 'codex';
    const result = await executeProjectConversationIdempotent(
      project,
      {
        mode: 'create',
        content: snapshot.prompt,
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
    );
    return readAcceptance(result.body);
  };
}

function readAcceptance(value: unknown): { conversationId: string; submissionId: string } {
  const body: Record<string, unknown> = isNativeApiRecord(value) ? value : {};
  const conversation: Record<string, unknown> = isNativeApiRecord(body.conversation) ? body.conversation : {};
  const submission: Record<string, unknown> = isNativeApiRecord(body.submission) ? body.submission : {};
  if (typeof conversation.id !== 'string' || typeof submission.id !== 'string') throw nativeApiError('ZEUS_AUTOMATION_ACCEPTANCE_INVALID', '自动化会话接收结果缺少持久身份。');
  return { conversationId: conversation.id, submissionId: submission.id };
}
