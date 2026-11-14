import { useCallback, useEffect } from 'react';
import type { ZeusRealtimeEvent } from '../apiClient.js';
import type { InputSuggestionSettings } from '@zeus/shared';
import type { WorkspacePageProps } from '../features/workspace/workspaceContracts.js';
import {
  configureAutomaticInputSuggestionClient,
  getAutomaticInputSuggestionSession,
  getInputSuggestionSession,
  inputSuggestionIdentity,
  refreshAutomaticInputSuggestions,
  synchronizeInputSuggestionSettings,
} from './inputSuggestionStore.js';

/** 工作台只刷新持久状态；自动生成、重试和恢复全部由 Core 负责。 */
export function useBackgroundInputSuggestions(options: {
  /** 已认证的客户端只读取或明确取消自动任务。 */
  client: WorkspacePageProps['nativeConversationClient'];
  /** 手动输入与自动投影继续共用同一配置身份。 */
  settings: InputSuggestionSettings | undefined;
}): (event: ZeusRealtimeEvent) => void {
  const { client } = options;
  const modelKey = inputSuggestionIdentity({ settings: options.settings }).modelKey;
  const enabled = options.settings?.enabled === true;
  useEffect(() => {
    configureAutomaticInputSuggestionClient(client ?? null);
    return () => configureAutomaticInputSuggestionClient(null);
  }, [client]);
  useEffect(() => {
    if (options.settings !== undefined) synchronizeInputSuggestionSettings(modelKey, enabled);
  }, [modelKey, enabled, options.settings]);
  return useCallback((event: ZeusRealtimeEvent) => {
    if (event.type === 'server.connected' || event.type === 'input_suggestions.network.changed') {
      refreshAutomaticInputSuggestions();
      return;
    }
    const userMessageEvent = ['conversation.item.started', 'conversation.item.updated', 'conversation.item.completed'].includes(event.type) && event.payload.itemType === 'userMessage';
    if (event.type !== 'input_suggestions.changed' && !userMessageEvent && !['conversation.submission.accepted', 'conversation.submission.steered'].includes(event.type)) return;
    const { projectId, conversationId } = event.payload;
    if (typeof projectId !== 'string' || typeof conversationId !== 'string') return;
    const session = getAutomaticInputSuggestionSession(projectId, conversationId);
    if (event.type === 'input_suggestions.changed') {
      session.refreshAutomatic();
      return;
    }
    const itemPayload = event.payload.itemPayload && typeof event.payload.itemPayload === 'object' ? (event.payload.itemPayload as Record<string, unknown>) : null;
    const userInputId = event.payload.clientUserMessageId ?? itemPayload?.clientId ?? event.payload.submissionId ?? event.payload.providerItemId ?? event.payload.itemId;
    if (typeof userInputId === 'string') getInputSuggestionSession(inputSuggestionIdentity({ projectId, conversationId }).sessionKey).observeUserInput(userInputId);
    session.invalidateAutomatic();
  }, []);
}
