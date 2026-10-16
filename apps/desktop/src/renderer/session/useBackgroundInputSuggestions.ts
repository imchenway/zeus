import { useCallback, useEffect, useRef } from 'react';
import type { ZeusRealtimeEvent } from '../apiClient.js';
import type { InputSuggestionSettings } from '@zeus/shared';
import type { WorkspacePageProps } from '../features/workspace/workspaceContracts.js';
import { getInputSuggestionSession, inputSuggestionIdentity, synchronizeInputSuggestionSettings } from './inputSuggestionStore.js';
import { conversationDraftAllowsInputSuggestion } from './useSessionController.js';

/** 工作台只订阅一次全局完成事件，生成不依赖当前页面或输入框挂载。 */
export function useBackgroundInputSuggestions(options: {
  /** 已认证的客户端负责读取待处理交互和生成建议。 */
  client: WorkspacePageProps['nativeConversationClient'];
  /** 自动开关和专用模型在事件发生时读取。 */
  settings: InputSuggestionSettings | undefined;
}): (event: ZeusRealtimeEvent) => void {
  /** 客户端沿用工作台已有连接。 */
  const { client } = options;
  /** 设置更新不重新订阅，不重放历史完成事件。 */
  const settings = useRef(options.settings);
  settings.current = options.settings;
  /** 统一清理后台请求与候选，包括当前不显示输入框时的配置修改。 */
  const modelKey = inputSuggestionIdentity({ settings: options.settings }).modelKey;
  /** 自动开关不影响已经由用户主动触发的润色。 */
  const enabled = options.settings?.enabled === true;
  useEffect(() => {
    if (options.settings !== undefined) synchronizeInputSuggestionSettings(modelKey, enabled);
  }, [modelKey, enabled, options.settings]);

  /** 交给工作台已有全局订阅消费，不另外创建 WebSocket。 */
  return useCallback(
    (event: ZeusRealtimeEvent) => {
      if (!client?.generateInputSuggestion) return;
      /** 生成仍复用已认证的客户端函数。 */
      const generate = client.generateInputSuggestion;
      /** 只处理真实会话生命周期，正文增量不会触发额外生成。 */
      const userMessageEvent = ['conversation.item.started', 'conversation.item.updated', 'conversation.item.completed'].includes(event.type);
      if (!userMessageEvent && !['conversation.turn.started', 'conversation.turn.completed', 'conversation.request.created', 'conversation.plan_implementation_request.changed', 'conversation.submission.steered'].includes(event.type))
        return;
      if (userMessageEvent && event.payload.itemType !== 'userMessage') return;
      /** 所有读写都使用服务端事件中的项目和会话身份。 */
      const { projectId, conversationId } = event.payload;
      if (typeof projectId !== 'string' || typeof conversationId !== 'string') return;
      /** 当前设置冻结到本次请求，不继承主会话模型。 */
      const selectedSettings = settings.current;
      /** Provider 身份与已打开会话的轮次映射一致。 */
      const turnId = typeof event.payload.providerTurnId === 'string' ? event.payload.providerTurnId : event.payload.turnId;
      /** 后台和前台通过同一身份访问同一个状态对象。 */
      const identity = inputSuggestionIdentity({ projectId, conversationId, settings: selectedSettings, turnId: typeof turnId === 'string' ? turnId : null });
      /** 状态层保持后台运行，当前页面只订阅其需要显示的会话。 */
      const session = getInputSuggestionSession(identity.sessionKey);
      if (userMessageEvent || event.type === 'conversation.submission.steered') {
        /** 原生消息投影把稳定的客户端身份放在正文对象中。 */
        const itemPayload = event.payload.itemPayload && typeof event.payload.itemPayload === 'object' ? (event.payload.itemPayload as Record<string, unknown>) : null;
        /** 使用服务端消息身份清除旧要求对应的结果，不根据正文猜测用户是否改意。 */
        const userInputId = event.payload.clientUserMessageId ?? itemPayload?.clientId ?? event.payload.submissionId ?? event.payload.providerItemId ?? event.payload.itemId;
        if (typeof userInputId === 'string') session.observeUserInput(userInputId);
        return;
      }
      if (event.type === 'conversation.turn.started' || event.type === 'conversation.request.created' || (event.type === 'conversation.plan_implementation_request.changed' && event.payload.status === 'pending')) {
        session.dismissAutomatic();
        return;
      }
      if (event.type !== 'conversation.turn.completed') return;
      if (event.payload.status !== 'completed' || event.payload.error) {
        session.dismissAutomatic();
        return;
      }
      // Provider 明确发布的用户可见完成事件才触发；历史补齐、内部重连和压缩不补发。
      if (event.payload.inputSuggestionEligible !== true || event.payload.internalOperation || event.payload.retrying || typeof turnId !== 'string' || !selectedSettings?.enabled || !selectedSettings.modelRef) return;
      if (!session.consumeAutomaticTurn(turnId)) return;
      /** 断线后直接收到下一轮完成时，也淘汰上一轮的自动候选。 */
      const previous = session.getSnapshot();
      if (previous?.trigger === 'automatic' && previous.key !== identity.automaticResultKey) session.dismissAutomatic();
      if (!session.automaticAllowed || !conversationDraftAllowsInputSuggestion(projectId, conversationId)) return;
      session.start({
        key: identity.automaticResultKey,
        modelKey: identity.modelKey,
        sourceDraft: '',
        modelRef: selectedSettings.modelRef,
        request: { mode: 'suggest', trigger: 'automatic', projectId, conversationId, completedTurnId: turnId },
        generate: async (request, signal, diagnosticId) => {
          /** 隐藏会话也核对问题和计划确认，不能依赖可见输入框替它阻止生成。 */
          const pending = await client.loadNativePendingRequests(projectId, conversationId);
          signal.throwIfAborted();
          // 编辑事件会取消本次请求；后台准备阶段也要核对是否出现待处理交互。
          if (pending.requests.some((item) => item.status === 'pending') || pending.planImplementationRequests?.some((item) => item.status === 'pending')) {
            return { completedTurnId: turnId, modelRef: selectedSettings.modelRef, text: null, reason: 'cancelled' };
          }
          // 完整最终正文、最新成功轮次、队列和归档状态继续由服务端在生成前后核对。
          return generate(request, signal, diagnosticId);
        },
      });
    },
    [client],
  );
}
