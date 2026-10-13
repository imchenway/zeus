import assert from 'node:assert/strict';
import type { ZeusConversationSubmissionRecord, ZeusConversationWithMessagesRecord } from '@zeus/storage';
import { createCodexRemoteControlConversationSyncApplication } from '../packages/local-server/src/codexRemoteControlConversationSyncApplication.js';

/** 在隔离内存中核对候选线程恢复顺序，不连接 Provider 或改写用户数据。 */
async function verifyRecovery(initialThread: string | null, accepted: boolean, fromList: boolean, archived = false): Promise<void> {
  /** 只提供同步入口实际读取的会话事实。 */
  let conversation = { id: 'conversation', agentKind: 'codex', archived, providerState: 'ready', providerThreadId: initialThread } as ZeusConversationWithMessagesRecord;
  /** 未知发送即使没有活动轮次，也必须进入后台核对。 */
  const submission = { status: 'paused', submissionOutcome: 'outcome_unknown' } as ZeusConversationSubmissionRecord;
  /** 记录恢复和历史读取的顺序，确保不会先读取旧线程。 */
  const calls: string[] = [];
  /** 仅接入只读核对端口，整个检查不具备发送消息的能力。 */
  const sync = createCodexRemoteControlConversationSyncApplication({
    isClosed: () => false,
    manager: {
      async listThreadTurns(input) {
        calls.push(`read:${input.threadId}`);
        return { data: [], nextCursor: null };
      },
    },
    syncCheckpoints: { getByConversation: () => undefined },
    submissions: { listByConversation: () => [submission] },
    turns: { listByConversation: () => [] },
    getConversation: () => conversation,
    async reconcileOutcomeUnknownSwitches() {
      calls.push('candidate');
      if (accepted) conversation = { ...conversation, providerThreadId: 'candidate-thread' };
    },
    async ensureGenerationReconciled() {
      calls.push(`generation:${conversation.providerThreadId}`);
    },
    async reconcile(current) {
      calls.push(`project:${current.providerThreadId}`);
    },
    async persist() {
      calls.push('persist');
    },
  });
  /** 并发打开同一会话必须共用一次恢复。 */
  const synchronize = () => (fromList ? sync.synchronizeConversations({ conversationIds: [conversation.id] }) : sync.synchronizeOpenConversation({ conversationId: conversation.id }));
  await Promise.all([synchronize(), synchronize()]);
  assert.deepEqual(calls, archived ? [] : accepted ? ['candidate', 'generation:candidate-thread', 'project:candidate-thread', 'persist'] : ['candidate']);
  assert.equal(conversation.providerThreadId, accepted && !archived ? 'candidate-thread' : initialThread);
  // 同一会话的周期检查继续受既有时间间隔限制，不能形成反复读取。
  await synchronize();
  assert.equal(calls.filter((call) => call === 'candidate').length, archived ? 0 : 1);
}

await verifyRecovery('old-thread', true, false);
await verifyRecovery(null, true, false);
await verifyRecovery('old-thread', true, true);
await verifyRecovery(null, false, false);
await verifyRecovery('old-thread', true, false, true);
console.log('候选线程恢复、首次发送、后台核对、未知保留、归档隔离与并发合并检查通过。');
