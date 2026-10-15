import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZeusDatabase, ProjectRepository, ConversationRepository, ConversationSubmissionRepository, ConversationSnapshotV2Repository } from '../packages/storage/src/index.js';
import { createInitialSessionState } from '../apps/desktop/src/renderer/session/sessionReducer.js';
import type { NativeConversationChoice, NativeSessionItemBuffer } from '../apps/desktop/src/renderer/session/sessionTypes.js';

/** 只检查状态投影，Node 不加载界面样式，也不连接真实 Provider。 */
registerHooks({
  /** 沿用现有检查脚本的样式加载边界。 */
  load(url, context, nextLoad) {
    return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
  },
});
/** 直接使用侧边栏的实际状态入口，避免复制实现。 */
const { conversationTreeRuntimeStateFromSession, resolveConversationTreeRuntimeState, summarizeProjectConversationStatuses } = await import('../apps/desktop/src/renderer/session/ProjectConversationTree.js');
/** 自由回答与选项共用同一份异步问题状态。 */
const state = createInitialSessionState();
state.conversationState = 'active_prework';
/** 所有身份均为本进程内的虚构数据。 */
const question: NativeSessionItemBuffer = {
  key: 'question',
  conversationId: 'conversation',
  threadId: 'thread',
  turnId: 'turn',
  itemId: 'question',
  providerItemId: 'question',
  type: 'agentMessage',
  status: 'completed',
  phase: 'prework',
  text: '',
  resources: [],
  payload: { delivery: 'async', questions: [{ title: '选择处理方式', options: ['继续', '稍后'] }] },
};
state.items.question = question;
assert.equal(conversationTreeRuntimeStateFromSession(state), 'pending_user_input');
question.payload.questions = [{ title: '补充说明' }];
assert.equal(conversationTreeRuntimeStateFromSession(state), 'pending_user_input');
state.conversationState = 'native_idle';
state.terminalTurnIds.turn = 'completed';
assert.equal(conversationTreeRuntimeStateFromSession(state), 'pending_user_input');
question.payload.questionResponse = { status: 'queued' };
assert.equal(conversationTreeRuntimeStateFromSession(state), 'ready');
question.payload.questionResponse = { status: 'completed' };
assert.equal(conversationTreeRuntimeStateFromSession(state), 'ready');
/** 明确未送达的状态均恢复待回复提示。 */
for (const status of ['failed', 'cancelled', 'deleted']) {
  question.payload.questionResponse = { status };
  assert.equal(conversationTreeRuntimeStateFromSession(state), 'pending_user_input');
}
/** 未打开会话仅有列表投影，也必须覆盖运行图标并参与折叠项目汇总。 */
const choice = { id: 'conversation', title: '会话', archived: false, hasPendingAsyncQuestion: true, listRuntimeState: 'streaming' } as NativeConversationChoice;
assert.equal(resolveConversationTreeRuntimeState(choice, { conversation: 'streaming' }), 'pending_user_input');
assert.equal(resolveConversationTreeRuntimeState(choice, { conversation: 'pending_approval' }), 'pending_approval');
assert.equal(summarizeProjectConversationStatuses([{ projectId: 'project', projectName: '项目', conversations: [choice], tasks: [] }], undefined, 'zh-CN').get('project')?.status, 'waiting_user');
choice.hasPendingAsyncQuestion = false;
assert.equal(resolveConversationTreeRuntimeState(choice, { conversation: 'streaming' }), 'streaming');
/** 真实仓储在临时目录检查 SQL，不读取或写入用户数据库。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-0859-reply-'));
/** 检查结束后关闭并删除隔离数据库。 */
const db = await createZeusDatabase(join(root, 'zeus.db'));
try {
  /** 两个项目用于检查查询范围。 */
  const projects = new ProjectRepository(db);
  /** 当前问题所属项目。 */
  const project = projects.create({ name: '待回复检查', localPath: root });
  /** 不包含问题的另一个项目。 */
  const other = projects.create({ name: '隔离项目', localPath: join(root, 'other') });
  /** 原题和答案使用正式仓储保存。 */
  const conversations = new ConversationRepository(db);
  /** 会话身份不依赖当前打开页面。 */
  const conversation = conversations.create({ projectId: project.id, title: '异步问题', transportKind: 'codex_native' });
  /** 固定时间只用于本次隔离数据。 */
  const createdAt = '2026-10-15T09:00:00.000Z';
  conversations.appendMessage({
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    source: 'codex_native',
    metadata: { delivery: 'async', questions: [{ title: '补充说明' }] },
    createdAt,
    providerThreadId: 'thread',
    providerTurnId: 'turn',
    providerItemId: 'question',
  });
  /** 直接调用生产查询，检查元数据和账本的关联。 */
  const snapshots = new ConversationSnapshotV2Repository(db);
  assert.deepEqual([...snapshots.pendingAsyncQuestionConversationIds([project.id])], [conversation.id]);
  assert.equal(snapshots.pendingAsyncQuestionConversationIds([other.id]).size, 0);
  /** 答复提交状态控制待回复标记，不改变原始问题。 */
  const submissions = new ConversationSubmissionRepository(db);
  /** 使用不同轮次的同名问题，确认不会误清原题。 */
  submissions.createOrGet({
    conversationId: conversation.id,
    idempotencyKey: 'answer',
    requestHash: 'answer',
    clientMessageId: 'answer',
    kind: 'steer',
    requestedDelivery: 'send_now',
    status: 'queued',
    input: { questionAnswer: { providerItemId: 'question', providerTurnId: 'other-turn' } },
    createdAt,
  });
  assert.equal(snapshots.pendingAsyncQuestionConversationIds([project.id]).has(conversation.id), true);
  /** 原提交不可改写；另建属于正确原题的答复。 */
  const answer = submissions.createOrGet({
    conversationId: conversation.id,
    idempotencyKey: 'matching-answer',
    requestHash: 'matching-answer',
    clientMessageId: 'matching-answer',
    kind: 'steer',
    requestedDelivery: 'send_now',
    status: 'queued',
    input: { questionAnswer: { providerItemId: 'question', providerTurnId: 'turn' } },
    createdAt,
  });
  assert.equal(snapshots.pendingAsyncQuestionConversationIds([project.id]).size, 0);
  /** 三种明确未送达结果都要恢复提示。 */
  for (const status of ['failed', 'cancelled', 'deleted']) {
    db.execute('UPDATE conversation_submissions SET status = ? WHERE id = ?', [status, answer.id]);
    assert.equal(snapshots.pendingAsyncQuestionConversationIds([project.id]).has(conversation.id), true);
  }
  db.execute('UPDATE conversation_submissions SET status = ? WHERE id = ?', ['completed', answer.id]);
  assert.equal(snapshots.pendingAsyncQuestionConversationIds([project.id]).size, 0);
} finally {
  await db.close();
  await rm(root, { recursive: true, force: true });
}
console.log('会话待回复状态与持久查询检查通过。');
