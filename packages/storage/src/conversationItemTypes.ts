/** Provider 适配与旧投影切换共用的最小会话 item 契约。 */
export type ConversationAgentKind = 'codex' | 'pi' | 'claude';

export type ConversationItemType =
  | 'userMessage'
  | 'agentMessage'
  | 'reasoning'
  | 'commandExecution'
  | 'fileChange'
  | 'mcpToolCall'
  | 'dynamicToolCall'
  | 'plan'
  | 'imageView'
  | 'imageGeneration'
  | 'webSearch'
  | 'contextCompaction'
  | 'collabAgentToolCall'
  | 'subAgentActivity'
  | 'providerEvent'
  | 'error';

export type ConversationItemStatus = 'in_progress' | 'completed' | 'failed';
export type ConversationItemPhase = 'prework' | 'final_answer';

export interface ZeusConversationItemRecord {
  id: string;
  conversationId: string;
  turnId: string;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
  itemType: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  textContent: string;
  payloadJson: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  agentKind: ConversationAgentKind | null;
  nativeItemId: string | null;
}
