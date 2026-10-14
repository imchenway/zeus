import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { parseConversationSystemMessage, redactUserFacingErrorDetails, type ConversationSystemMessage, type ConversationSystemMessageInput } from '@zeus/shared';

/** 仅保存尚未由 Core 接纳的记录；草稿和会话使用明确隔离的键。 */
const storageKey = 'zeus.system-message-outbox';
/** 写入失败时仍保留内存副本，后续同步不得无声删除。 */
const pendingByScope = new Map<string, ConversationSystemMessageInput[]>();
/** 当前会话的最新持久位置供输入错误关联，草稿没有假消息身份。 */
const anchors = new Map<string, string | null>();
/** 已读取的权威错误参与前端去重，断连时也不重复显示相同未恢复故障。 */
const acceptedByScope = new Map<string, readonly ConversationSystemMessage[]>();
/** 同一窗口内各个会话区域共享待确认消息变化。 */
const listeners = new Set<() => void>();
/** 外部存储快照只使用递增修订，避免每次渲染重新解析 JSON。 */
let revision = 0;
/** 每个会话同时只有一个补写任务。 */
const syncing = new Set<string>();
/** 整个待确认账本一次落盘，使草稿归属迁移保持原子性。 */
let initialized = false;
/** 本地存储暂不可写时，后续连接恢复继续保存同一账本。 */
let dirty = false;

/** 会话身份和草稿身份不可互换。 */
export function systemMessageScope(projectId: string, conversationId?: string | null, taskId?: string | null): string {
  return JSON.stringify([projectId, conversationId ? 'conversation' : 'draft', conversationId ?? taskId ?? 'project']);
}

/** 向已有页面发布持久待确认记录变化。 */
function notify(): void {
  revision += 1;
  listeners.forEach((listener) => listener());
}

/** 首次读取校验整个待确认账本，不执行诊断中的任何内容。 */
function read(scope: string): ConversationSystemMessageInput[] {
  if (!initialized) {
    try {
      /** 整个账本是一次原子写入；半次草稿迁移不会变成另一会话的记录。 */
      const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(storageKey) ?? '{}');
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('待确认账本格式无效。');
      /** 先完整校验，再替换缓存，不能接纳半份损坏记录。 */
      const entries = Object.entries(stored).map(([key, messages]) => {
        if (!Array.isArray(messages)) throw new Error('待确认消息格式无效。');
        return [key, messages.map(parseConversationSystemMessage)] as const;
      });
      entries.forEach(([key, messages]) => pendingByScope.set(key, [...new Map([...messages, ...(pendingByScope.get(key) ?? [])].map((message) => [message.id, message])).values()]));
      initialized = true;
    } catch (error) {
      console.error('系统消息待确认记录读取失败。', error);
    }
  }
  if (!pendingByScope.has(scope)) pendingByScope.set(scope, []);
  return pendingByScope.get(scope)!;
}

/** 本地写入失败保留内存副本；恢复后补写，不递归生成报错。 */
function persist(): void {
  try {
    if (!initialized) read('');
    if (!initialized || !globalThis.localStorage) {
      dirty = true;
      return;
    }
    globalThis.localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries([...pendingByScope].filter(([, messages]) => messages.length))));
    dirty = false;
  } catch (error) {
    if (!dirty) console.error('系统消息暂未写入本地存储，保留待确认记录。', error);
    dirty = true;
  }
}

/** 先保存记录，再通知正文；恢复及确认删除也使用同一个账本。 */
function write(scope: string, messages: ConversationSystemMessageInput[]): void {
  pendingByScope.set(scope, messages);
  persist();
  notify();
}

/** 正文只发布真实位置，系统提示不成为后续提示的默认锚点。 */
export function setSystemMessageAnchor(scope: string, entryId: string | null): void {
  anchors.set(scope, entryId);
}

/** 同一未恢复故障合并；恢复后再次发生可生成新的系统消息。 */
export function recordSystemMessage(scope: string, error: unknown, operation: ConversationSystemMessageInput['operation'], summary: string, target?: { entryId?: string | null; turnId?: string | null }): string {
  /** 空值只表示清理临时状态，不能冒充已经恢复。 */
  const detail = redactUserFacingErrorDetails(error instanceof Error ? error.message : typeof error === 'string' ? error : (JSON.stringify(error) ?? '未知错误')).slice(0, 8000);
  /** 关联身份首次确定，后续更新不跟随新消息。 */
  const relatedEntryId = target?.entryId === undefined ? (anchors.get(scope) ?? null) : target.entryId;
  /** 待确认恢复覆盖同身份旧状态，已恢复后的新故障仍有独立身份。 */
  const known = new Map<string, ConversationSystemMessageInput>((acceptedByScope.get(scope) ?? []).map((message) => [message.id, message]));
  for (const message of read(scope)) known.set(message.id, { ...message, recoveredAt: known.get(message.id)?.recoveredAt ?? message.recoveredAt });
  /** 同一请求在 React 重渲染时不新增消息。 */
  const previous = [...known.values()].find((message) => !message.recoveredAt && message.operation === operation && message.detail === detail && message.targetTurnId === (target?.turnId ?? null));
  if (previous) return previous.id;
  /** 客户端身份在草稿迁移、断连和命令重放期间保持不变。 */
  const message: ConversationSystemMessageInput = {
    id: `zeus-system-${crypto.randomUUID()}`,
    operation,
    summary,
    detail: detail || '未知错误',
    occurredAt: new Date().toISOString(),
    recoveredAt: null,
    relatedEntryId,
    targetTurnId: target?.turnId ?? null,
  };
  write(scope, [...read(scope), message]);
  return message.id;
}

/** 已接纳消息恢复后重新入待确认队列，同一消息原位更新。 */
export function recoverSystemMessage(scope: string, message: ConversationSystemMessageInput): void {
  if (message.recoveredAt || read(scope).find((candidate) => candidate.id === message.id)?.recoveredAt) return;
  /** 不把会话和显示位置等响应字段写回命令。 */
  const input: ConversationSystemMessageInput = {
    id: message.id,
    operation: message.operation,
    summary: message.summary,
    detail: message.detail,
    occurredAt: message.occurredAt,
    recoveredAt: new Date().toISOString(),
    relatedEntryId: message.relatedEntryId,
    targetTurnId: message.targetTurnId,
  };
  write(scope, [...read(scope).filter((candidate) => candidate.id !== message.id), input]);
}

/** 成功操作只恢复同范围的未恢复记录，异步回调读取最新待确认状态。 */
export function recoverSystemMessageOperation(scope: string, operation: ConversationSystemMessageInput['operation'], accepted: readonly ConversationSystemMessageInput[] = []): void {
  for (const message of [...accepted, ...read(scope)]) if (message.operation === operation && !message.recoveredAt) recoverSystemMessage(scope, message);
}

/** 新会话获得耐久接纳后迁移草稿消息，迁移顺序保证刷新不会丢记录。 */
export function bindDraftSystemMessages(projectId: string, taskId: string | null, conversationId: string): void {
  /** 来源只由本次创建的项目和任务确定，不扫描其他草稿。 */
  const draftScope = systemMessageScope(projectId, null, taskId);
  /** 目标必须使用接纳回执中的产品会话身份。 */
  const scope = systemMessageScope(projectId, conversationId);
  /** 先写目标，再移除来源；中断后重复迁移依靠消息身份去重。 */
  const messages = [
    ...new Map(
      [...read(scope), ...read(draftScope).map((message) => (message.operation === 'conversation_start' && !message.recoveredAt ? { ...message, recoveredAt: new Date().toISOString() } : message))].map((message) => [message.id, message]),
    ).values(),
  ];
  if (!read(draftScope).length) return;
  pendingByScope.set(scope, messages);
  pendingByScope.set(draftScope, []);
  persist();
  notify();
}

/** 订阅在输入区、正文和草稿之间共享的待确认消息。 */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** 快照是稳定原始值，不创建渲染循环。 */
function getRevision(): number {
  return revision;
}

/** 记录失败只补写系统消息，绝不重放模型请求或用户操作。 */
export function useConversationSystemMessages(scope: string, save?: (message: ConversationSystemMessageInput) => Promise<ConversationSystemMessage>, accepted?: Record<string, ConversationSystemMessage>) {
  useEffect(() => {
    if (accepted) acceptedByScope.set(scope, Object.values(accepted));
  }, [scope, accepted]);
  /** 本地草稿变化驱动消息流重新投影。 */
  const currentRevision = useSyncExternalStore(subscribe, getRevision, getRevision);
  /** 补写失败保留原记录，等待重连或下一次有界补写。 */
  const flush = useCallback(async () => {
    if (!save || syncing.has(scope)) return;
    syncing.add(scope);
    try {
      for (const input of [...read(scope)]) {
        /** 当前请求只更新原消息；并行发生的恢复仍留待下一次提交。 */
        const accepted = await save(input);
        const current = read(scope).find((message) => message.id === input.id);
        if (current === input)
          write(
            scope,
            read(scope).filter((message) => message.id !== input.id),
          );
        else if (current)
          write(
            scope,
            read(scope).map((message) => (message.id === input.id ? { ...message, id: accepted.id, occurredAt: accepted.occurredAt, relatedEntryId: accepted.relatedEntryId } : message)),
          );
      }
    } catch {
      /* 补写失败不递归上报，原系统消息仍保留在本地。 */
    } finally {
      syncing.delete(scope);
    }
  }, [scope, save]);
  useEffect(() => {
    void flush();
  }, [flush, currentRevision]);
  useEffect(() => {
    /** 草稿也在本地存储恢复后补写，接通 Core 后再提交同一消息。 */
    const retry = () => {
      if (dirty) persist();
      if (save && read(scope).length) void flush();
    };
    const timer = globalThis.setInterval(retry, 5000);
    globalThis.addEventListener?.('online', retry);
    return () => {
      globalThis.clearInterval(timer);
      globalThis.removeEventListener?.('online', retry);
    };
  }, [scope, save, flush]);
  return read(scope);
}
