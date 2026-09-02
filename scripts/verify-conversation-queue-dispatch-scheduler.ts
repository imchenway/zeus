import { ConversationQueueDispatchScheduler, mustWaitForInProcessRuntimeTurn, shouldRequestConversationQueueDispatch } from '../packages/local-server/src/conversationQueueDispatchScheduler.js';
import { formatVisibleApplicationError } from '../apps/desktop/src/renderer/ui/ApplicationErrorDialog.js';

function assertBehavior(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

let dispatchCalls = 0;
let releaseFirstDispatch: (() => void) | null = null;
const firstDispatchBlocked = new Promise<void>((resolve) => {
  releaseFirstDispatch = resolve;
});
let firstDispatchStarted: (() => void) | null = null;
const firstDispatchActive = new Promise<void>((resolve) => {
  firstDispatchStarted = resolve;
});
const failures: string[] = [];
const scheduler = new ConversationQueueDispatchScheduler({
  dispatch: async () => {
    dispatchCalls += 1;
    if (dispatchCalls !== 1) return;
    firstDispatchStarted?.();
    await firstDispatchBlocked;
  },
  onError: (_conversationId, error) => failures.push(error instanceof Error ? error.message : String(error)),
});

const first = scheduler.request('conversation-dispatch-owner');
await firstDispatchActive;
const second = scheduler.request('conversation-dispatch-owner');
releaseFirstDispatch?.();
await Promise.all([first, second]);

assertBehavior(dispatchCalls === 2, '派发 owner 忙碌期间到达的第二次唤醒不得被丢弃。');
assertBehavior(scheduler.snapshot('conversation-dispatch-owner') === null, '完成所有 revision 后必须释放会话派发 owner。');
assertBehavior(failures.length === 0, '正常派发 revision 不应进入失败边界。');
assertBehavior(!shouldRequestConversationQueueDispatch('conversation.queue.changed', { queueDispatchRequested: false }), '已有直接派发 owner 的 UI 刷新事件不得启动第二个队列 owner。');
assertBehavior(shouldRequestConversationQueueDispatch('conversation.queue.changed', {}), '普通队列变更仍必须唤醒派发。');
assertBehavior(shouldRequestConversationQueueDispatch('conversation.turn.completed', { queueDispatchRequested: false }), '回合终态必须始终唤醒后续队列。');

const staleCodexTurn = [{ agentKind: 'codex' }];
const activePiTurn = [{ agentKind: 'pi' }];
assertBehavior(!mustWaitForInProcessRuntimeTurn('codex', staleCodexTurn), 'Codex 本地残留 active 状态必须进入 Provider authority 观察，不能在全局队列门禁提前返回。');
assertBehavior(mustWaitForInProcessRuntimeTurn('codex', activePiTurn), 'Pi 活动轮次结束前不得派发后续 Codex 队首。');
assertBehavior(mustWaitForInProcessRuntimeTurn('pi', staleCodexTurn), 'Pi 队首遇到任意活动轮次时必须等待进程内终态事件。');
assertBehavior(
  formatVisibleApplicationError({ error: 'ZEUS_CODEX_LOGIN_REQUIRED', message: 'internal detail' }) === 'Zeus 专属 Codex 尚未登录。请先前往“设置 > AI CLI / Runtime”完成登录，再重试。',
  '已知且可操作的登录错误不得再降级成通用失败文案。',
);
const visibleSchedulerFailure = formatVisibleApplicationError({ code: 'ZEUS_UNIFIED_QUEUE_SCHEDULER_FAILED', message: 'internal detail' });
assertBehavior(visibleSchedulerFailure.includes('消息已保存') && visibleSchedulerFailure.includes('重新恢复'), '队列 owner 失败必须明确说明 Core 已保存消息并给出可见恢复动作，避免用户重复发送。');

console.log(
  JSON.stringify(
    {
      status: 'passed',
      dispatchCalls,
      retainedWakeups: 1,
      directDispatchOwnerPreserved: true,
      failures: failures.length,
      codexStaleTurnDelegatedToProviderAuthority: true,
      actionableQueueErrorsVisible: true,
    },
    null,
    2,
  ),
);
