import type { CodexAppServerManager } from '@zeus/ai-runtime';
import type { ConversationProviderSyncCheckpointRepository, ConversationTurnRepository, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { classifySnapshotTurn } from './codexNativeConversationPolicy.js';

interface CodexRemoteControlConversationSyncPorts {
  isClosed(): boolean;
  manager: Pick<CodexAppServerManager, 'listThreadTurns'>;
  syncCheckpoints: Pick<ConversationProviderSyncCheckpointRepository, 'getByConversation'>;
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
  function synchronize(input: { conversationId: string; minimumIntervalMs?: number }): Promise<void> {
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
      await ports.ensureGenerationReconciled([conversation.id]);
      const current = ports.getConversation(conversation.id);
      if (!current || current.archived || !current.providerThreadId) return;
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
      return synchronize({ conversationId: input.conversationId, minimumIntervalMs: 5_000 });
    },
    async synchronizeConversations(input: { conversationIds: readonly string[] }): Promise<void> {
      const conversationIds = [...new Set(input.conversationIds)];
      for (let index = 0; index < conversationIds.length; index += 4) {
        await Promise.all(conversationIds.slice(index, index + 4).map((conversationId) => synchronize({ conversationId, minimumIntervalMs: 30_000 })));
      }
    },
  };
}

async function providerWaterlineAdvanced(ports: CodexRemoteControlConversationSyncPorts, conversation: ZeusConversationWithMessagesRecord): Promise<boolean> {
  const providerThreadId = conversation.providerThreadId;
  if (!providerThreadId) return false;
  const checkpoint = ports.syncCheckpoints.getByConversation(conversation.id);
  if (!checkpoint) return true;
  const latest = (await ports.manager.listThreadTurns({ threadId: providerThreadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded', priority: 'control' })).data[0];
  if (!latest) return false;
  const boundaryTurnId = checkpoint.lastSyncedTurnId ?? checkpoint.baselineTurnId;
  if (latest.id !== boundaryTurnId) return true;
  const local = ports.turns.listByConversation(conversation.id).find((turn) => turn.providerTurnId === latest.id);
  if (!local) return true;
  const providerState = classifySnapshotTurn(latest);
  if (providerState === 'active') return local.status !== 'running' && local.status !== 'waiting' && local.status !== 'dispatching';
  return providerState === 'unknown' || providerState !== local.status;
}
