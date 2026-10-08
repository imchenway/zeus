import type { AiRuntimeSession } from '../runtime/runtimeContracts.js';
import type { NativeProjectConversationChoicesSnapshot, NativeConversationChoicesSnapshot } from '../../session/sessionTypes.js';

export interface NativeProjectConversationChoiceGroupsSnapshot {
  /** 带会话的任务入口不受任务列表分页限制。 */
  tasks: import('../tasks/taskContracts.js').TaskSummary[];
  projectId: string;
  projectChoices: NativeProjectConversationChoicesSnapshot;
  taskChoicesByTaskId: Record<string, NativeConversationChoicesSnapshot>;
}

export interface ConversationHistoryItem {
  id: string;
  projectId: string;
  taskId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messages: ConversationMessage[];
}

export interface ConversationHistoryPage {
  items: ConversationHistoryItem[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface SendConversationMessageResult {
  conversation: ConversationHistoryItem;
  runtimeSession?: AiRuntimeSession;
  runtimeError?: { message: string };
}
