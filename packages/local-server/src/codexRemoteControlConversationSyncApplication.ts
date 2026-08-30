import type { CodexAppServerManager } from '@zeus/ai-runtime';
import type { ConversationProviderSyncCheckpointRepository, ConversationSubmissionRepository, ConversationTurnRepository, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { classifySnapshotTurn } from './codexNativeConversationPolicy.js';

interface CodexRemoteControlConversationSyncPorts {
  isClosed(): boolean;
  manager: Pick<CodexAppServerManager, 'listThreadTurns'>;
  syncCheckpoints: Pick<ConversationProviderSyncCheckpointRepository, 'getByConversation'>;
  submissions: Pick<ConversationSubmissionRepository, 'listByConversation'>;
  turns: Pick<ConversationTurnRepository, 'listByConversation'>;
  getConversation(conversationId: string): ZeusConversationWithMessagesRecord | undefined;
  ensureGenerationReconciled(conversationIds: readonly string[]): Promise<void>;
  reconcile(conversation: ZeusConversationWithMessagesRecord): Promise<void>;
  persist(): Promise<void>;
}

/** 追赶当前打开会话的 Provider 水位；同一会话任何时刻最多一次对账。 */
export function createCodexRemoteControlConversationSyncApplication(ports: CodexRemoteControlConversationSyncPorts) {
  const inFlight = new Map<string, Promise<void>>();
  const lastCheckStartedAt = new Map<string, number>();

  function hasLocalProviderWork(conversationId: string): boolean {
    if (ports.submissions.listByConversation(conversationId).some((submission) => submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'active')) return true;
    return ports.turns.listByConversation(conversationId).some((turn) => turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting');
  }

  function needsProjectListCatchUp(conversationId: string): boolean {
    const conversation = ports.getConversation(conversationId);
    if (!conversation) return false;
    if (conversation.providerState === 'binding' || conversation.providerState === 'active' || conversation.providerState === 'waiting') return true;
    return ports.turns.listByConversation(conversationId).some((turn) => turn.status === 'dispatching' || turn.status === 'running' || turn.status === 'waiting');
  }

  function synchronize(input: { conversationId: string; minimumIntervalMs?: number; skipDuringLocalWork?: boolean }): Promise<void> {
    const existing = inFlight.get(input.conversationId);
    if (existing) return existing;
    const startedAt = Date.now();
    const minimumIntervalMs = Math.max(0, input.minimumIntervalMs ?? 0);
    if (startedAt - (lastCheckStartedAt.get(input.conversationId) ?? 0) < minimumIntervalMs) return Promise.resolve();
    const work = (async () => {
      if (ports.isClosed()) return;
      const conversation = ports.getConversation(input.conversationId);
      if (
        !conversation ||
        conversation.agentKind !== 'codex' ||
        conversation.archived ||
        !conversation.providerThreadId ||
        conversation.providerState === 'archived' ||
        conversation.providerState === 'closed' ||
        conversation.providerState === 'failed'
      ) {
        return;
      }
      lastCheckStartedAt.set(input.conversationId, startedAt);
      // 新执行宿主必须先完成当前世代对账和活动线程订阅恢复；本地仍标记为活动
      // 恰好是断线现场，不能在世代恢复之前用普通轮询门禁把它短路。
      await ports.ensureGenerationReconciled([conversation.id]);
      const current = ports.getConversation(conversation.id);
      if (!current || current.archived || !current.providerThreadId) return;
      // 同一世代已经完成权威对账后，当前发送/运行轮次继续只由实时事件推进。
      // 这时才允许跳过普通历史水位轮询，避免与 turn/start 竞争 app-server 通道。
      if (input.skipDuringLocalWork && hasLocalProviderWork(current.id)) return;
      if (!(await providerWaterlineAdvanced(ports, current))) return;
      await ports.reconcile(current);
      await ports.persist();
    })();
    const tracked = work.finally(() => {
      if (inFlight.get(input.conversationId) === tracked) inFlight.delete(input.conversationId);
    });
    inFlight.set(input.conversationId, tracked);
    return tracked;
  }

  return {
    synchronizeOpenConversation(input: { conversationId: string }): Promise<void> {
      // 打开会话的周期读取只负责兜底补齐移动端遗漏事件；实时流仍是主链路。
      // 30 秒间隔和本地活动态隔离可以避免它重新进入用户发送热路径。
      return synchronize({ conversationId: input.conversationId, minimumIntervalMs: 30_000, skipDuringLocalWork: true });
    },
    async synchronizeConversations(input: { conversationIds: readonly string[] }): Promise<void> {
      // 项目列表可能包含数十到上百条空闲历史。逐条恢复并读取完整轮次会制造
      // app-server 惊群，反过来挤死用户当前的发送 RPC；列表后台只修复真实活动态。
      // 空闲会话仍由 Remote Control 实时事件或“当前打开会话”精确追赶。
      const conversationIds = [...new Set(input.conversationIds)].filter(needsProjectListCatchUp);
      for (let index = 0; index < conversationIds.length; index += 4) {
        await Promise.all(conversationIds.slice(index, index + 4).map((conversationId) => synchronize({ conversationId, minimumIntervalMs: 30_000, skipDuringLocalWork: true })));
      }
    },
  };
}

async function providerWaterlineAdvanced(ports: CodexRemoteControlConversationSyncPorts, conversation: ZeusConversationWithMessagesRecord): Promise<boolean> {
  const providerThreadId = conversation.providerThreadId;
  if (!providerThreadId) return false;
  const checkpoint = ports.syncCheckpoints.getByConversation(conversation.id);
  if (!checkpoint) return true;
  const latest = (await ports.manager.listThreadTurns({ threadId: providerThreadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' })).data[0];
  if (!latest) return false;
  const boundaryTurnId = checkpoint.lastSyncedTurnId ?? checkpoint.baselineTurnId;
  if (latest.id !== boundaryTurnId) return true;
  const local = ports.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === latest.id);
  if (!local) return true;
  const providerState = classifySnapshotTurn(latest);
  if (providerState === 'active') return local.status !== 'running' && local.status !== 'waiting' && local.status !== 'dispatching';
  return providerState === 'unknown' || providerState !== local.status;
}
