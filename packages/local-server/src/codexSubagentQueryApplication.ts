import { classifyAssistantMessage } from '@zeus/shared';
import type { CodexThreadListInput, CodexThreadSnapshot, CodexThreadsPage, CodexTransportState } from '@zeus/ai-runtime';
import type { ConversationProviderItemRepository, ConversationRepository, ZeusConversationRecord } from '@zeus/storage';
import { readSubagentInputMessage, type CodexSubagentRuntimeReadPort, type SubagentInputMessage, type SubagentRuntimeDetails } from './codexSubagentRuntimeProjection.js';
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
  runtime: CodexSubagentRuntimeReadPort;
  now(): Date;
}

type SubagentActivity = {
  threadIds: Set<string>;
  paths: Map<string, string>;
  interrupted: Set<string>;
  states: Map<string, string>;
  instructions: Map<string, string>;
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
    const activity = this.readActivity(conversation.id);
    const snapshot = await this.load(conversation, activity);
    const agent = snapshot.items.find((item) => item.id === threadId);
    if (!agent) throw queryError('ZEUS_CODEX_SUBAGENT_NOT_FOUND', 'Subagent thread not found.', 404);
    this.assertProviderReady();
    const thread = await this.ports.provider.readThread({ threadId: agent.id, includeTurns: true });
    if (thread.id !== agent.id) throw queryError('ZEUS_CODEX_SUBAGENT_IDENTITY_MISMATCH', '返回的子线程身份与请求不一致。', 409);
    const history = ownedThreadHistory(thread);
    const { runtime, inputMessages } = await this.ports.runtime.read({ thread, ownedTurns: history.turns });
    /** 原生输入已存在时不再单独插入任务摘要；仅保留确实可读的首发指令缺口。 */
    const instruction = taskInstruction(thread, agent.id, activity);
    /** 消息集合是唯一展示来源，独立指令栏移除后不能丢失已有明文。 */
    const turns = this.toTurns(thread, history.turns, inputMessages, agent.path);
    /** 没有可靠首轮时不为任务指令制造轮次。 */
    const firstTurn = turns[0];
    if (history.boundary.state === 'confirmed' && firstTurn && instruction.state === 'available' && instruction.text && !firstTurn.items.some((item) => item.type === 'userMessage')) {
      firstTurn.items.unshift({
        ...subagentInputItem({
          id: `subagent-instruction:${agent.id}`,
          turnId: firstTurn.id,
          sender: agent.path?.slice(0, agent.path.lastIndexOf('/')) ?? '',
          fromParent: true,
          timestamp: null,
          contentState: 'available',
          text: instruction.text,
        }),
        // 字段来源没有原生消息编号，不能把本地展示编号冒充 Provider 身份。
        providerItemId: null,
      });
    }
    return {
      conversationId: conversation.id,
      parentThreadId: snapshot.parentThreadId,
      agent,
      taskInstruction: instruction,
      inheritedContext: inheritedContext(thread),
      historyBoundary: history.boundary,
      runtime,
      turns,
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

  private async load(conversation: ZeusConversationRecord, activity = this.readActivity(conversation.id)): Promise<ConversationSubagentsSnapshot> {
    const parentThreadId = conversation.providerThreadId;
    if (!parentThreadId) throw queryError('ZEUS_CODEX_THREAD_UNAVAILABLE', '当前会话没有可读取的 Codex 线程。');
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
    const instructions = new Map<string, string>();
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
      const receiverThreadIds = new Set<string>();
      if (isRecord(payload.agentsStates)) {
        for (const [threadId, rawState] of Object.entries(payload.agentsStates)) {
          if (!isRecord(rawState)) continue;
          threadIds.add(threadId);
          receiverThreadIds.add(threadId);
          if (typeof rawState.status === 'string') states.set(threadId, rawState.status);
          const agentInstruction = firstNonEmptyString(rawState.prompt, rawState.instruction, rawState.message, rawState.task);
          if (agentInstruction) instructions.set(threadId, agentInstruction);
        }
      }
      if (Array.isArray(payload.receiverThreadIds)) {
        for (const threadId of payload.receiverThreadIds) {
          if (typeof threadId !== 'string' || !threadId) continue;
          threadIds.add(threadId);
          receiverThreadIds.add(threadId);
        }
      }
      const tool = typeof payload.tool === 'string' ? payload.tool.toLowerCase().replaceAll(/[^a-z]/gu, '') : '';
      const prompt = firstNonEmptyString(payload.prompt, payload.instruction, payload.message, payload.task);
      if (prompt && (tool === 'spawn' || tool === 'spawnagent')) for (const receiverThreadId of receiverThreadIds) instructions.set(receiverThreadId, prompt);
    }
    return { threadIds, paths, interrupted, states, instructions };
  }

  /** 原生线程优先，历史只补缺少的输入；轮次时间与消息时间分别保留。 */
  private toTurns(thread: Record<string, unknown>, ownedTurns: Record<string, unknown>[], inputMessages: SubagentInputMessage[], agentPath: string | null): SubagentTurn[] {
    const threadUpdatedAt = epochIso(thread.updatedAt) ?? this.ports.now().toISOString();
    return ownedTurns.flatMap((rawTurn) => {
      const turnId = rawTurn.id as string;
      const turnStatus = typeof rawTurn.status === 'string' ? rawTurn.status : 'completed';
      const startedAt = epochIso(rawTurn.startedAt);
      const completedAt = epochIso(rawTurn.completedAt);
      /** 每个原生身份只展示一次，原生线程记录优先于磁盘补充。 */
      const items: SubagentTurn['items'] = (Array.isArray(rawTurn.items) ? rawTurn.items : []).flatMap<SubagentTurn['items'][number]>((rawItem) => {
        if (!isRecord(rawItem) || typeof rawItem.id !== 'string' || typeof rawItem.type !== 'string') return [];
        if (rawItem.type === 'agent_message') {
          /** 输入信封只能按结构化收件方进入自身轮次。 */
          const message = readSubagentInputMessage(rawItem, { agentPath, turnId, timestamp: rawItem.startedAt });
          /** 协议未提供消息时间时，仍保留同身份历史记录中的真实时间。 */
          const historical = inputMessages.find((input) => input.id === rawItem.id && input.turnId === turnId);
          return message?.turnId === turnId ? [subagentInputItem({ ...message, timestamp: message.timestamp ?? historical?.timestamp ?? null })] : [];
        }
        /** 协议已转成普通输入时，按同一原生编号补来源，仍优先使用线程中的明文。 */
        const input = rawItem.type === 'userMessage' ? inputMessages.find((message) => message.id === rawItem.id && message.turnId === turnId) : null;
        if (input) {
          /** 不用轮次开始时间覆盖历史中更精确的消息时间。 */
          const text = itemText(rawItem);
          return [subagentInputItem({ ...input, timestamp: epochIso(rawItem.startedAt) ?? input.timestamp, ...(text.trim() ? { text, contentState: 'available' as const } : {}) })];
        }
        const phase = classifyAssistantMessage(rawItem, rawItem.type === 'agentMessage' ? 'final_answer' : 'prework') === 'final' ? ('final_answer' as const) : ('prework' as const);
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
            startedAt: epochIso(rawItem.startedAt) ?? (phase === 'final_answer' ? (completedAt ?? startedAt) : startedAt),
            completedAt,
            updatedAt: completedAt ?? startedAt ?? threadUpdatedAt,
          },
        ];
      });
      /** 仅补当前轮次的缺口，不按正文相似度合并真实的重复指令。 */
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const message of inputMessages) {
        if (message.turnId === turnId && !byId.has(message.id)) byId.set(message.id, subagentInputItem(message));
      }
      /** 首条输入在本轮工作之前；后续输入按真实时间插入，原生同时间项保持原顺序。 */
      const firstInput = [...byId.values()].filter((item) => item.type === 'userMessage').sort((left, right) => (left.startedAt ?? '').localeCompare(right.startedAt ?? ''))[0];
      /** 这里只决定展示次序，不修改消息自身的真实时间。 */
      const ordered = [...byId.values()].sort((left, right) => {
        if (left === firstInput) return -1;
        if (right === firstInput) return 1;
        return (left.startedAt ?? startedAt ?? '').localeCompare(right.startedAt ?? startedAt ?? '');
      });
      return [{ id: turnId, status: turnStatus, startedAt, completedAt, items: ordered }];
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
  /** 真实轮次时间，不能以消息到达时间重建耗时。 */
  startedAt: string | null;
  /** 只有原生轮次结束时间才停止耗时计算。 */
  completedAt: string | null;
  items: Array<{
    id: string;
    turnId: string;
    providerItemId: string | null;
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

/** 输入沿用普通消息结构，来源与不可读状态由共享消息组件呈现。 */
function subagentInputItem(message: SubagentInputMessage): SubagentTurn['items'][number] {
  return {
    id: message.id,
    turnId: message.turnId,
    providerItemId: message.id,
    type: 'userMessage',
    status: 'completed',
    phase: 'prework',
    text: message.text,
    payload: { type: 'userMessage', subagentInput: { sender: message.sender, fromParent: message.fromParent, contentState: message.contentState } },
    resources: [],
    startedAt: message.timestamp,
    completedAt: message.timestamp,
    updatedAt: message.timestamp ?? '',
  };
}

export interface ConversationSubagentHistoryBoundary {
  state: 'confirmed' | 'unavailable';
  createdAt: string | null;
  ownedTurnCount: number;
  hiddenInheritedTurnCount: number;
  hiddenAmbiguousTurnCount: number;
  reason: string | null;
}

export interface ConversationSubagentThreadSnapshot {
  conversationId: string;
  parentThreadId: string;
  agent: ConversationSubagentSummary;
  taskInstruction: ConversationSubagentPromptFact;
  inheritedContext: ConversationSubagentPromptFact;
  historyBoundary: ConversationSubagentHistoryBoundary;
  runtime: SubagentRuntimeDetails;
  turns: SubagentTurn[];
}

export interface ConversationSubagentPromptFact {
  state: 'available' | 'unavailable';
  text: string | null;
  source: 'collaboration_prompt' | 'provider_thread_source' | 'provider_thread_preview' | null;
  reason: string | null;
}

function taskInstruction(thread: Record<string, unknown>, threadId: string, activity: SubagentActivity): ConversationSubagentPromptFact {
  const projected = activity.instructions.get(threadId);
  if (projected) return availablePrompt(projected, 'collaboration_prompt');
  const source = isRecord(thread.source) ? thread.source : {};
  const subagent = isRecord(source.subagent) ? source.subagent : {};
  const spawn = isRecord(subagent.thread_spawn) ? subagent.thread_spawn : isRecord(subagent.threadSpawn) ? subagent.threadSpawn : {};
  const explicit = firstNonEmptyString(thread.taskInstruction, thread.subagentPrompt, thread.spawnPrompt, spawn.prompt, spawn.instruction, spawn.message, spawn.task);
  if (explicit) return availablePrompt(explicit, 'provider_thread_source');
  return {
    state: 'unavailable',
    text: null,
    source: null,
    reason: '当前 Codex Provider 未在子线程读取协议中返回原始子任务指令；Zeus 不会用继承的主任务提示词冒充。',
  };
}

function inheritedContext(thread: Record<string, unknown>): ConversationSubagentPromptFact {
  const text = firstNonEmptyString(thread.firstUserMessage, thread.preview);
  return text
    ? availablePrompt(text, 'provider_thread_preview')
    : {
        state: 'unavailable',
        text: null,
        source: null,
        reason: 'Provider 未返回可读的上层任务上下文。',
      };
}

function availablePrompt(text: string, source: Exclude<ConversationSubagentPromptFact['source'], null>): ConversationSubagentPromptFact {
  return { state: 'available', text, source, reason: null };
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
}

function ownedThreadHistory(thread: Record<string, unknown>): { boundary: ConversationSubagentHistoryBoundary; turns: Record<string, unknown>[] } {
  const createdAtEpoch = epochSeconds(thread.createdAt);
  const createdAt = createdAtEpoch === null ? null : new Date(createdAtEpoch * 1_000).toISOString();
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (createdAtEpoch === null) {
    return {
      turns: [],
      boundary: {
        state: 'unavailable',
        createdAt: null,
        ownedTurnCount: 0,
        hiddenInheritedTurnCount: 0,
        hiddenAmbiguousTurnCount: turns.length,
        reason: 'Codex 子线程未提供可靠的创建时间，已隐藏无法确认归属的历史内容。',
      },
    };
  }
  const owned: Record<string, unknown>[] = [];
  let hiddenInheritedTurnCount = 0;
  let hiddenAmbiguousTurnCount = 0;
  for (const rawTurn of turns) {
    if (!isRecord(rawTurn) || typeof rawTurn.id !== 'string') {
      hiddenAmbiguousTurnCount += 1;
      continue;
    }
    const turn = rawTurn;
    const startedAt = epochSeconds(turn.startedAt);
    if (startedAt === null) hiddenAmbiguousTurnCount += 1;
    else if (startedAt < createdAtEpoch) hiddenInheritedTurnCount += 1;
    else owned.push(turn);
  }
  return {
    turns: owned,
    boundary: {
      state: hiddenAmbiguousTurnCount === 0 ? 'confirmed' : 'unavailable',
      createdAt,
      ownedTurnCount: owned.length,
      hiddenInheritedTurnCount,
      hiddenAmbiguousTurnCount,
      reason: hiddenAmbiguousTurnCount === 0 ? null : '部分 turn 缺少可靠的开始时间，已隐藏这些无法确认归属的内容。',
    },
  };
}

function toSummary(thread: Record<string, unknown>, activity: SubagentActivity): ConversationSubagentSummary {
  const id = typeof thread.id === 'string' ? thread.id : '';
  const source = isRecord(thread.source) ? thread.source : {};
  const subagent = isRecord(source.subagent) ? source.subagent : {};
  const spawn = isRecord(subagent.thread_spawn) ? subagent.thread_spawn : isRecord(subagent.threadSpawn) ? subagent.threadSpawn : {};
  const path = activity.paths.get(id) ?? firstNonEmptyString(thread.agentPath, spawn.agent_path, spawn.agentPath);
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
  const seconds = epochSeconds(value);
  return seconds === null ? null : new Date(seconds * 1_000).toISOString();
}

function epochSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed / 1_000 : null;
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
