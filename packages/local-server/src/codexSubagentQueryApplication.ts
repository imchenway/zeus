import type { CodexThreadListInput, CodexThreadSnapshot, CodexThreadsPage, CodexTransportState } from '@zeus/ai-runtime';
import type { ConversationProviderItemRepository, ConversationRepository, ZeusConversationRecord } from '@zeus/storage';
import { sanitizeConversationItemPayload } from './conversationResources.js';

export interface CodexSubagentProviderReadPort {
  /** 只观察既有 transport；查询路径禁止调用 ensureReady。 */
  getState(): CodexTransportState;
  /** 只读取 Provider 已有线程状态，不得创建/恢复线程。 */
  listThreads(input: CodexThreadListInput): Promise<CodexThreadsPage>;
  readThread(input: { threadId: string; includeTurns?: boolean }): Promise<CodexThreadSnapshot>;
}

interface CodexSubagentQueryPorts {
  conversations: Pick<ConversationRepository, 'getById'>;
  providerItems: Pick<ConversationProviderItemRepository, 'listByConversation'>;
  provider: CodexSubagentProviderReadPort;
  now(): Date;
}

type SubagentActivity = {
  threadIds: Set<string>;
  paths: Map<string, string>;
  interrupted: Set<string>;
  states: Map<string, string>;
};

const codexSubagentSourceKinds = ['subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther'] as const;

/** Codex 子智能体查询拥有者：数据库活动投影可补齐既有 Provider 索引，但绝不启动 Provider。 */
export class CodexSubagentQueryApplication {
  constructor(private readonly ports: CodexSubagentQueryPorts) {}

  async list(projectId: string, conversationId: string): Promise<ConversationSubagentsSnapshot> {
    return this.load(this.requireCodexConversation(projectId, conversationId));
  }

  async read(projectId: string, conversationId: string, threadId: string): Promise<ConversationSubagentThreadSnapshot> {
    const conversation = this.requireCodexConversation(projectId, conversationId);
    const snapshot = await this.load(conversation);
    const agent = snapshot.items.find((item) => item.id === threadId);
    if (!agent) throw queryError('ZEUS_CODEX_SUBAGENT_NOT_FOUND', 'Subagent thread not found.', 404);
    this.assertProviderReady();
    const thread = await this.ports.provider.readThread({ threadId: agent.id, includeTurns: true });
    return {
      conversationId: conversation.id,
      parentThreadId: snapshot.parentThreadId,
      agent,
      turns: this.toTurns(thread),
    };
  }

  private requireCodexConversation(projectId: string, conversationId: string): ZeusConversationRecord {
    const conversation = this.ports.conversations.getById(conversationId);
    if (!conversation || conversation.projectId !== projectId) throw queryError('ZEUS_CONVERSATION_NOT_FOUND', 'Conversation not found', 404);
    if (conversation.transportKind !== 'codex_native' || (conversation.agentKind !== 'codex' && conversation.providerId !== 'codex')) {
      throw queryError('ZEUS_CODEX_SUBAGENTS_UNAVAILABLE', 'Subagents are only available for native Codex conversations.', 409);
    }
    return conversation;
  }

  private async load(conversation: ZeusConversationRecord): Promise<ConversationSubagentsSnapshot> {
    const parentThreadId = conversation.providerThreadId;
    if (!parentThreadId) throw queryError('ZEUS_CODEX_THREAD_UNAVAILABLE', '当前会话没有可读取的 Codex 线程。');
    const activity = this.readActivity(conversation.id);
    let listError: unknown;
    const listed = await this.listProviderThreads(parentThreadId).catch((error) => {
      listError = error;
      return [];
    });
    const byId = new Map(listed.map((thread) => [thread.id, thread]));
    // Provider 索引可能慢于活动事件；只读取已知缺口，仍不创建或恢复线程。
    for (const threadId of activity.threadIds) {
      if (byId.has(threadId)) continue;
      if (this.ports.provider.getState().type !== 'ready') break;
      const thread = await this.ports.provider.readThread({ threadId }).catch(() => null);
      if (thread) byId.set(thread.id, thread);
    }
    if (byId.size === 0 && listError) throw listError;
    return {
      conversationId: conversation.id,
      parentThreadId,
      items: [...byId.values()].map((thread) => toSummary(thread, activity)).sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id)),
    };
  }

  private async listProviderThreads(parentThreadId: string): Promise<CodexThreadSnapshot[]> {
    this.assertProviderReady();
    const threads: CodexThreadSnapshot[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.ports.provider.listThreads({
        ancestorThreadId: parentThreadId,
        cursor,
        limit: 200,
        sortKey: 'created_at',
        sortDirection: 'asc',
        sourceKinds: [...codexSubagentSourceKinds],
        useStateDbOnly: true,
      });
      threads.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor && threads.length < 1_000);
    return threads;
  }

  private assertProviderReady(): void {
    if (this.ports.provider.getState().type !== 'ready') {
      throw queryError('ZEUS_CODEX_SUBAGENTS_UNAVAILABLE', 'Codex transport 尚未就绪；只读子智能体查询不会启动 Provider。');
    }
  }

  private readActivity(conversationId: string): SubagentActivity {
    const threadIds = new Set<string>();
    const paths = new Map<string, string>();
    const interrupted = new Set<string>();
    const states = new Map<string, string>();
    for (const item of this.ports.providerItems.listByConversation(conversationId)) {
      const payload = parseJsonObject(item.payloadJson);
      const payloadType = typeof payload.type === 'string' ? payload.type : item.itemType;
      if (payloadType === 'subAgentActivity') {
        const threadId = typeof payload.agentThreadId === 'string' ? payload.agentThreadId : null;
        if (!threadId) continue;
        threadIds.add(threadId);
        if (typeof payload.agentPath === 'string' && payload.agentPath.trim()) paths.set(threadId, payload.agentPath);
        if (payload.kind === 'interrupted') interrupted.add(threadId);
        continue;
      }
      if (payloadType !== 'collabAgentToolCall') continue;
      if (isRecord(payload.agentsStates)) {
        for (const [threadId, rawState] of Object.entries(payload.agentsStates)) {
          if (!isRecord(rawState) || typeof rawState.status !== 'string') continue;
          threadIds.add(threadId);
          states.set(threadId, rawState.status);
        }
      }
      if (Array.isArray(payload.receiverThreadIds)) {
        for (const threadId of payload.receiverThreadIds) if (typeof threadId === 'string' && threadId) threadIds.add(threadId);
      }
    }
    return { threadIds, paths, interrupted, states };
  }

  private toTurns(thread: Record<string, unknown>): SubagentTurn[] {
    const threadUpdatedAt = epochIso(thread.updatedAt) ?? this.ports.now().toISOString();
    return (Array.isArray(thread.turns) ? thread.turns : []).flatMap((rawTurn) => {
      if (!isRecord(rawTurn) || typeof rawTurn.id !== 'string') return [];
      const turnId = rawTurn.id;
      const turnStatus = typeof rawTurn.status === 'string' ? rawTurn.status : 'completed';
      const startedAt = epochIso(rawTurn.startedAt);
      const completedAt = epochIso(rawTurn.completedAt);
      const items = (Array.isArray(rawTurn.items) ? rawTurn.items : []).flatMap((rawItem) => {
        if (!isRecord(rawItem) || typeof rawItem.id !== 'string' || typeof rawItem.type !== 'string') return [];
        const phase = rawItem.phase === 'final_answer' || rawItem.phase === 'finalAnswer' || rawItem.type === 'agentMessage' ? ('final_answer' as const) : ('prework' as const);
        return [
          {
            id: rawItem.id,
            turnId,
            providerItemId: rawItem.id,
            type: rawItem.type,
            status: itemStatus(rawItem, turnStatus),
            phase,
            text: itemText(rawItem),
            payload: sanitizeConversationItemPayload(rawItem),
            resources: [],
            startedAt,
            completedAt,
            updatedAt: completedAt ?? startedAt ?? threadUpdatedAt,
          },
        ];
      });
      return [{ id: turnId, status: turnStatus, items }];
    });
  }
}

export interface ConversationSubagentSummary {
  id: string;
  parentThreadId: string | null;
  title: string;
  nickname: string | null;
  role: string | null;
  path: string | null;
  preview: string;
  status: 'pending' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed' | 'unknown';
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ConversationSubagentsSnapshot {
  conversationId: string;
  parentThreadId: string;
  items: ConversationSubagentSummary[];
}

interface SubagentTurn {
  id: string;
  status: string;
  items: Array<{
    id: string;
    turnId: string;
    providerItemId: string;
    type: string;
    status: 'in_progress' | 'completed' | 'failed';
    phase: 'prework' | 'final_answer';
    text: string;
    payload: Record<string, unknown>;
    resources: never[];
    startedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
  }>;
}

interface ConversationSubagentThreadSnapshot {
  conversationId: string;
  parentThreadId: string;
  agent: ConversationSubagentSummary;
  turns: SubagentTurn[];
}

function toSummary(thread: Record<string, unknown>, activity: SubagentActivity): ConversationSubagentSummary {
  const id = typeof thread.id === 'string' ? thread.id : '';
  const path = activity.paths.get(id) ?? null;
  return {
    id,
    parentThreadId: typeof thread.parentThreadId === 'string' ? thread.parentThreadId : null,
    title: title(thread, path),
    nickname: typeof thread.agentNickname === 'string' ? thread.agentNickname : null,
    role: typeof thread.agentRole === 'string' ? thread.agentRole : null,
    path,
    preview: typeof thread.preview === 'string' ? thread.preview : '',
    status: status(thread, activity.states.get(id), activity.interrupted.has(id)),
    createdAt: epochIso(thread.createdAt),
    updatedAt: epochIso(thread.updatedAt),
  };
}

function status(thread: Record<string, unknown>, providerStatus: string | undefined, interrupted: boolean): ConversationSubagentSummary['status'] {
  if (interrupted || providerStatus === 'interrupted') return 'interrupted';
  if (providerStatus === 'pendingInit') return 'pending';
  if (providerStatus === 'running') return 'running';
  if (providerStatus === 'completed' || providerStatus === 'shutdown') return 'completed';
  if (providerStatus === 'errored' || providerStatus === 'notFound') return 'failed';
  const providerThreadStatus = isRecord(thread.status) ? thread.status : {};
  if (providerThreadStatus.type === 'active') return Array.isArray(providerThreadStatus.activeFlags) && providerThreadStatus.activeFlags.length > 0 ? 'waiting' : 'running';
  if (providerThreadStatus.type === 'systemError') return 'failed';
  if (providerThreadStatus.type === 'idle' || providerThreadStatus.type === 'notLoaded') return 'completed';
  return 'unknown';
}

function title(thread: Record<string, unknown>, path: string | null): string {
  if (typeof thread.name === 'string' && thread.name.trim()) return thread.name.trim();
  if (typeof thread.agentNickname === 'string' && thread.agentNickname.trim()) return thread.agentNickname.trim();
  const segment = path?.split('/').filter(Boolean).pop();
  if (segment) return segment;
  if (typeof thread.agentRole === 'string' && thread.agentRole.trim()) return thread.agentRole.trim();
  return '智能体';
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.content === 'string') return item.content;
  if (Array.isArray(item.content)) return item.content.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : [])).join('');
  if (Array.isArray(item.summary)) return item.summary.filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n\n');
  return '';
}

function itemStatus(item: Record<string, unknown>, turnStatus: string): 'in_progress' | 'completed' | 'failed' {
  const raw = typeof item.status === 'string' ? item.status : turnStatus;
  if (raw === 'failed' || raw === 'errored') return 'failed';
  if (raw === 'inProgress' || raw === 'in_progress' || raw === 'running') return 'in_progress';
  return 'completed';
}

function epochIso(value: unknown): string | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? new Date(value * 1_000).toISOString() : null;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function queryError(code: string, message: string, statusCode?: number): Error & { code: string; statusCode?: number } {
  return Object.assign(new Error(message), { code, ...(statusCode ? { statusCode } : {}) });
}
