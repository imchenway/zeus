import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  createZeusDatabase,
  ProjectRepository,
  ConversationRepository,
  ConversationTurnRepository,
  ConversationSnapshotV2Repository,
  ConversationTranscriptRepository,
  ConversationSyncEventRepository,
  CommandDeliveryRepository,
  type ZeusDatabase,
} from '../packages/storage/src/index.js';
import { parseConversationSystemMessage, type ConversationSystemMessageInput } from '../packages/shared/src/conversationSystemMessage.js';
import { ConversationSyncProtocol } from '../packages/local-server/src/conversationSyncProtocol.js';
import { registerConversationSnapshotV2Api } from '../packages/local-server/src/conversationSnapshotV2Api.js';
import { registerConversationCommandRoutes } from '../packages/local-server/src/conversationCommandRoutes.js';
import { ConversationCommandApplication } from '../packages/local-server/src/conversationCommandApplication.js';
import { buildConversationCommandRequest, conversationClientCommandTypes } from '../apps/desktop/src/renderer/features/conversations/conversationCommandClient.js';
import { createInitialSessionState, sessionReducer } from '../apps/desktop/src/renderer/session/sessionReducer.js';

/** 所有数据库和产物都属于本次隔离校验，不读取用户数据。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-0844-system-messages-'));
/** 重启校验复用同一临时数据库文件。 */
const path = join(root, 'zeus.db');
/** 固定时钟使位置和恢复断言可以复现。 */
const startedAt = '2026-10-14T06:00:00.000Z';
/** 数据库对象会在重启场景替换，最终统一关闭。 */
let db = await createZeusDatabase(path);
try {
  /** 正式仓储创建隔离项目与会话。 */
  const project = new ProjectRepository(db).create({ name: '系统消息校验', localPath: root });
  const conversations = new ConversationRepository(db);
  const conversation = conversations.create({ projectId: project.id, title: '系统消息持久化', transportKind: 'codex_native' });
  const other = conversations.create({ projectId: project.id, title: '隔离会话', transportKind: 'codex_native' });
  const transcript = new ConversationTranscriptRepository(db);
  /** 两条真实来源位置夹住错误，后续消息不得改变夹入位置。 */
  const anchor = transcript.registerSource({
    conversationId: conversation.id,
    sourceDomain: 'qa',
    sourceScope: conversation.id,
    sourceId: 'before',
    facet: 'body',
    preferredEntryId: 'qa-before',
    kind: 'content',
    turnId: null,
    segmentId: null,
    firstSeenAt: startedAt,
    orderingEvidence: 'live',
    contentHash: 'before',
  });
  const later = transcript.registerSource({
    conversationId: conversation.id,
    sourceDomain: 'qa',
    sourceScope: conversation.id,
    sourceId: 'after',
    facet: 'body',
    preferredEntryId: 'qa-after',
    kind: 'content',
    turnId: null,
    segmentId: null,
    firstSeenAt: '2026-10-14T06:01:00.000Z',
    orderingEvidence: 'live',
    contentHash: 'after',
  });
  const snapshot = new ConversationSnapshotV2Repository(db);
  /** 生产读取执行真实 SQL，能够捕获不存在字段的回归。 */
  assert.doesNotThrow(() => snapshot.readNavigation(conversation.id));
  const input: ConversationSystemMessageInput = {
    id: 'zeus-system-first',
    operation: 'navigation',
    summary: '会话目录读取失败。',
    detail: 'no such column: process.protocol_family',
    occurredAt: '2026-10-14T06:00:30.000Z',
    recoveredAt: null,
    relatedEntryId: anchor.placement.entryId,
    targetTurnId: null,
  };
  const saved = snapshot.systemMessages.save(conversation.id, input);
  assert(saved.transcript.placement.order! > anchor.placement.order!);
  assert(saved.transcript.placement.order! < later.placement.order!);
  assert.equal(snapshot.systemMessages.save(conversation.id, input).id, saved.id);
  assert.equal(snapshot.systemMessages.save(conversation.id, { ...input, id: 'zeus-system-repeat' }).id, saved.id);
  /** 同一未恢复后台故障再次上报时，即使页面锚点已变化仍沿用原记录。 */
  assert.equal(snapshot.systemMessages.save(conversation.id, { ...input, id: 'zeus-system-repeat-later', relatedEntryId: later.placement.entryId }).id, saved.id);
  assert.equal(snapshot.systemMessages.list(conversation.id).items.length, 1);
  /** 恢复只能更新原记录，不删除、不重新分配位置。 */
  const recovered = snapshot.systemMessages.save(conversation.id, { ...input, recoveredAt: '2026-10-14T06:02:00.000Z' });
  assert.equal(recovered.transcript.placement.order, saved.transcript.placement.order);
  assert.equal(snapshot.systemMessages.save(conversation.id, input).recoveredAt, recovered.recoveredAt);
  assert.equal(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversation_model_history WHERE conversation_id = ?', [conversation.id])!.count, 0);
  assert.equal(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversation_turns WHERE conversation_id = ?', [conversation.id])!.count, 0);
  assert.throws(() => snapshot.systemMessages.save(other.id, input));
  assert.throws(() => parseConversationSystemMessage({ ...input, id: 'invalid' }));
  /** 回滚不能留下消息或位置来源。 */
  assert.throws(() =>
    db.transaction(() => {
      snapshot.systemMessages.save(conversation.id, { ...input, id: 'zeus-system-rollback', detail: 'rollback' });
      throw new Error('rollback');
    }),
  );
  assert.equal(snapshot.systemMessages.list(conversation.id).items.length, 1);
  /** 服务端脱敏，不信任调用方的诊断内容。 */
  const redacted = snapshot.systemMessages.save(conversation.id, { ...input, id: 'zeus-system-redacted', detail: 'Authorization: Bearer private-token' });
  assert(!redacted.detail.includes('private-token'));
  /** 早于首条正式消息的草稿诊断按首次发生位置补入。 */
  const draft = snapshot.systemMessages.save(conversation.id, { ...input, id: 'zeus-system-draft', relatedEntryId: null, occurredAt: '2026-10-14T05:59:00.000Z', detail: 'draft' });
  assert(draft.transcript.placement.order! < anchor.placement.order!);
  /** 超过一页的系统消息可完整读取，稳定游标不重复。 */
  for (let index = 0; index < 38; index += 1)
    snapshot.systemMessages.save(conversation.id, { ...input, id: `zeus-system-page-${index}`, detail: `page ${index}`, relatedEntryId: null, occurredAt: new Date(Date.parse(startedAt) + 120000 + index * 1000).toISOString() });
  const firstPage = snapshot.systemMessages.list(conversation.id);
  assert(firstPage.nextCursor);
  const secondPage = snapshot.systemMessages.list(conversation.id, firstPage.nextCursor);
  assert.equal(new Set([...firstPage.items, ...secondPage.items].map((message) => message.id)).size, 41);
  /** 同步事件与消息在同一个事务中接纳，回滚不能广播。 */
  const events: unknown[] = [];
  const protocol = new ConversationSyncProtocol({
    db,
    repository: new ConversationSyncEventRepository(db),
    broadcast: (event) => {
      events.push(event);
    },
  });
  const writeEvent = () =>
    protocol.append({
      conversationId: conversation.id,
      type: 'conversation.system_message.updated',
      eventId: 'qa-system-message-event',
      occurredAt: recovered.recoveredAt!,
      payload: { projectId: project.id, entityRevision: recovered.transcript.sources[0]!.revision, message: recovered },
    });
  assert.throws(() =>
    db.transaction(() => {
      writeEvent();
      throw new Error('rollback');
    }),
  );
  assert.equal(events.length, 0);
  db.durableTransactionSync(writeEvent);
  assert.equal(events.length, 1);
  db.durableTransactionSync(writeEvent);
  assert.equal(events.length, 1);
  /** 渲染器同身份合并并拒绝旧页覆盖已恢复事实。 */
  const state = { ...createInitialSessionState(), projectId: project.id, conversationId: conversation.id };
  const loaded = sessionReducer(state, { type: 'system_messages_loaded', page: { conversationId: conversation.id, items: [recovered], nextCursor: null } });
  const stale = sessionReducer(loaded, { type: 'system_messages_loaded', page: { conversationId: conversation.id, items: [saved], nextCursor: null } });
  assert.equal(stale.systemMessages?.[saved.id]?.recoveredAt, recovered.recoveredAt);
  /** 实际 HTTP 只读入口包含系统消息，且限制在指定项目。 */
  const server = verificationServer(db, project.id);
  const response = await server.inject({ method: 'GET', url: `/api/projects/${project.id}/conversations/${conversation.id}/readable-snapshot` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().systemMessages.items.length, 32);
  assert.equal((await server.inject({ method: 'GET', url: `/api/projects/other/conversations/${conversation.id}/system-messages` })).statusCode, 404);
  /** 实际公开写入路由沿用命令回执；同一请求重放不新增消息。 */
  const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.systemMessageSave, conversationId: conversation.id, value: { ...input, id: 'zeus-system-command', detail: 'command route' } });
  const posted = await server.inject({ method: 'POST', url: `/api/projects/${project.id}/conversations/${conversation.id}/system-messages`, payload: body });
  assert.equal(posted.statusCode, 200, posted.body);
  assert.equal((await server.inject({ method: 'POST', url: `/api/projects/${project.id}/conversations/${conversation.id}/system-messages`, payload: body })).json().id, posted.json().id);
  assert.equal((await server.inject({ method: 'POST', url: `/api/projects/other/conversations/${conversation.id}/system-messages`, payload: body })).statusCode, 404);
  await server.close();
  await db.close();
  db = await createZeusDatabase(path);
  const reopened = new ConversationSnapshotV2Repository(db).systemMessages;
  const reopenedFirst = reopened.list(conversation.id);
  const reopenedSecond = reopened.list(conversation.id, reopenedFirst.nextCursor!);
  assert.equal(reopenedSecond.items.find((message) => message.id === saved.id)?.recoveredAt, recovered.recoveredAt);
  assert.equal(reopenedSecond.items.find((message) => message.id === saved.id)?.transcript.placement.order, saved.transcript.placement.order);
  /** 已恢复诊断不进入模型历史，重启也不能被初始化过程误收录。 */
  assert.equal(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversation_model_history WHERE conversation_id = ?', [conversation.id])!.count, 0);
  /** Node 只校验真实投影逻辑，样式由随后浏览器验收。 */
  registerHooks({
    load(url, context, nextLoad) {
      return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context);
    },
  });
  /** tsx 直接执行复用仓库探针的 JSX 运行环境。 */
  (globalThis as typeof globalThis & { React: typeof import('react') }).React = await import('react');
  const { projectSystemMessageRows } = await import('../apps/desktop/src/renderer/session/ConversationTranscript.js');
  /** 显示行使用真实持久位置，新增与补页只改变正文集合。 */
  const row = (key: string, placement: typeof anchor.placement, occurredAt: string) => ({
    kind: 'navigation_placeholder' as const,
    key,
    entry: {
      id: key,
      rowKey: key,
      loaded: false,
      clientUserMessageId: null,
      kind: 'message' as const,
      turnId: '',
      providerTurnId: null,
      providerItemId: null,
      sequence: 1,
      occurredAt,
      prompt: key,
      response: '',
      status: 'completed',
      placement,
    },
  });
  const rows = [row('before', anchor.placement, startedAt), row('after', later.placement, '2026-10-14T06:01:00.000Z')];
  assert.deepEqual(
    projectSystemMessageRows(rows, [saved]).map((entry) => entry.key),
    ['before', `system-message:${saved.id}`, 'after'],
  );
  assert.deepEqual(
    projectSystemMessageRows(rows, [recovered]).map((entry) => entry.key),
    ['before', `system-message:${saved.id}`, 'after'],
  );
  assert.deepEqual(
    projectSystemMessageRows(rows, [recovered, draft]).map((entry) => entry.key),
    [`system-message:${draft.id}`, 'before', `system-message:${saved.id}`, 'after'],
  );
  /** 过程跨过系统消息时切开，后续流式工具不能把提示移到组尾。 */
  const processItem = (key: string, envelope: typeof saved.transcript) => ({
    kind: 'item' as const,
    key,
    item: {
      key,
      itemId: key,
      providerItemId: key,
      conversationId: conversation.id,
      threadId: 'qa',
      turnId: 'qa',
      type: 'reasoning',
      phase: 'commentary',
      status: 'completed',
      text: key,
      payload: {},
      resources: [],
      timelineAt: startedAt,
      updatedAt: startedAt,
      transcript: envelope,
    },
  });
  const work = { kind: 'turn_work' as const, key: 'qa-work', turnId: 'qa', segments: [{ key: 'qa-work', summary: null, rows: [processItem('first-tool', anchor), processItem('next-tool', later)] }], live: true, loadMore: true };
  assert.deepEqual(
    projectSystemMessageRows([work], [recovered]).map((entry) => entry.key),
    ['qa-work', `system-message:${saved.id}`, `qa-work:after-system:${saved.id}`],
  );
  /** 本地账本只属于此进程，覆盖草稿隔离与原子迁移。 */
  const local = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => local.get(key) ?? null, setItem: (key: string, value: string) => local.set(key, value) } });
  const outbox = await import('../apps/desktop/src/renderer/session/conversationSystemMessages.js');
  /** 通过真实订阅 Hook 读取缓存，不绕过草稿恢复逻辑。 */
  const pending = (scope: string) => {
    let result: ConversationSystemMessageInput[] = [];
    renderToStaticMarkup(
      createElement(function PendingMessages() {
        result = outbox.useConversationSystemMessages(scope);
        return null;
      }),
    );
    return result;
  };
  const scope = outbox.systemMessageScope(project.id, null, 'qa-task');
  const otherScope = outbox.systemMessageScope(project.id, null, 'other-task');
  const draftId = outbox.recordSystemMessage(scope, 'draft failure', 'conversation_start', '会话创建失败。');
  assert.equal(outbox.recordSystemMessage(scope, 'draft failure', 'conversation_start', '会话创建失败。'), draftId);
  const otherId = outbox.recordSystemMessage(otherScope, 'draft failure', 'conversation_start', '会话创建失败。');
  assert.notEqual(draftId, otherId);
  outbox.bindDraftSystemMessages(project.id, 'qa-task', conversation.id);
  assert.equal(pending(scope).length, 0);
  assert.equal(pending(otherScope)[0]!.id, otherId);
  const bound = pending(outbox.systemMessageScope(project.id, conversation.id));
  assert.equal(bound[0]!.id, draftId);
  assert(bound[0]!.recoveredAt);
  outbox.bindDraftSystemMessages(project.id, 'qa-task', other.id);
  assert.equal(pending(outbox.systemMessageScope(project.id, other.id)).length, 0);
  assert(!Object.hasOwn(JSON.parse(local.get('zeus.system-message-outbox')!), scope));
  if (process.argv.includes('--serve')) {
    /** 浏览器只访问本任务隔离实例，不能连接用户应用或 Provider。 */
    const uiServer = verificationServer(db, project.id);
    const uiConversation = new ConversationRepository(db).create({ projectId: project.id, title: '界面验收', transportKind: 'codex_native' });
    const uiTranscript = new ConversationTranscriptRepository(db);
    const uiAnchor = uiTranscript.registerSource({
      conversationId: uiConversation.id,
      sourceDomain: 'qa',
      sourceScope: uiConversation.id,
      sourceId: 'ui-before',
      facet: 'body',
      preferredEntryId: 'qa-ui-before',
      kind: 'content',
      turnId: null,
      segmentId: null,
      firstSeenAt: startedAt,
      orderingEvidence: 'live',
      contentHash: 'ui-before',
    });
    /** 正文定位使用隔离数据库中的真实轮次和位置，系统消息不生成它们。 */
    const bodyTurn = new ConversationTurnRepository(db).upsert({
      conversationId: uiConversation.id,
      providerThreadId: 'qa-thread',
      providerTurnId: 'qa-body-turn',
      clientSubmissionId: null,
      status: 'completed',
      startedAt,
      completedAt: startedAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
    const bodyAnchor = uiTranscript.registerSource({
      conversationId: uiConversation.id,
      sourceDomain: 'qa',
      sourceScope: uiConversation.id,
      sourceId: 'qa-body',
      preferredEntryId: 'qa-body',
      facet: 'body',
      kind: 'content',
      turnId: bodyTurn.id,
      segmentId: null,
      firstSeenAt: '2026-10-14T06:01:00.000Z',
      orderingEvidence: 'live',
      contentHash: 'qa-body',
    });
    const bodyEntry = {
      id: 'qa-body',
      turnId: bodyTurn.id,
      providerTurnId: 'qa-body-turn',
      clientUserMessageId: null,
      providerItemId: 'qa-body',
      sequence: 2,
      occurredAt: '2026-10-14T06:01:00.000Z',
      prompt: '待按需加载的历史正文',
      response: '',
      status: 'completed',
      placement: bodyAnchor.placement,
    };
    uiServer.get('/qa-fixture', () => ({ projectId: project.id, conversationId: uiConversation.id, anchor: uiAnchor, startedAt, bodyEntry, bodyAnchor }));
    uiServer.post('/qa-next', () =>
      uiTranscript.registerSource({
        conversationId: uiConversation.id,
        sourceDomain: 'qa',
        sourceScope: uiConversation.id,
        sourceId: crypto.randomUUID(),
        preferredEntryId: crypto.randomUUID(),
        facet: 'body',
        kind: 'ordinary_input',
        turnId: null,
        segmentId: null,
        firstSeenAt: new Date().toISOString(),
        orderingEvidence: 'live',
        contentHash: crypto.randomUUID(),
      }),
    );
    await uiServer.listen({ port: 18545, host: '127.0.0.1' });
    console.log('QA READY http://127.0.0.1:18545');
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await uiServer.close();
  }
  console.log('PASS: SQL、原位持久化、恢复、去重、分页、事务回滚、耐久事件、跨会话隔离、脱敏、首屏、重启、前端固定位置和草稿原子归属。');
} finally {
  await db.close();
  await rm(root, { recursive: true, force: true });
}

/** 生产公开命令与读取路由组合，禁止校验过程意外触发模型操作。 */
function verificationServer(database: ZeusDatabase, projectId: string) {
  /** 仅监听回环地址，允许本任务 Vite 页面读取隔离数据。 */
  const server = Fastify();
  server.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin === 'http://127.0.0.1:18544')
      reply.header('Access-Control-Allow-Origin', request.headers.origin).header('Access-Control-Allow-Headers', 'Content-Type').header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') return reply.code(204).send();
  });
  /** 存储及同步均使用正式实现，不伪造持久化回执。 */
  const repository = new ConversationSnapshotV2Repository(database);
  const conversations = new ConversationRepository(database);
  const protocol = new ConversationSyncProtocol({ db: database, repository: new ConversationSyncEventRepository(database), broadcast: () => undefined });
  registerConversationSnapshotV2Api({ server, repository, projectExists: (id) => id === projectId, getConversation: (id) => conversations.getRecordById(id), readQueueState: () => ({}), readSubmissionReceipt: () => null });
  /** 未使用的依赖一旦被调用直接中止，证明系统消息不走模型动作。 */
  const unavailable = () => {
    throw new Error('系统消息不允许调用 Provider。');
  };
  const dependencies = new Proxy({}, { get: () => unavailable });
  registerConversationCommandRoutes({
    server,
    application: new ConversationCommandApplication({ db: database, deliveries: new CommandDeliveryRepository(database), redactSensitiveText: (text) => ({ text }), now: () => new Date() }),
    conversations,
    projects: new ProjectRepository(database),
    tasks: dependencies,
    goals: dependencies,
    codex: dependencies,
    saveSystemMessage(conversationId: string, input: ConversationSystemMessageInput) {
      const message = repository.systemMessages.save(conversationId, input);
      const revision = `${message.transcript.sources[0]!.revision}:${message.transcript.placement.placementRevision}:${message.transcript.placement.orderEpoch}`;
      protocol.append({
        conversationId,
        type: 'conversation.system_message.updated',
        eventId: `system-message:${conversationId}:${message.id}:${revision}`,
        occurredAt: message.recoveredAt ?? message.occurredAt,
        payload: { projectId, message, entityRevision: message.transcript.sources[0]!.revision },
      });
      return message;
    },
    sendNativeError: (reply, error) => reply.code(500).send({ error: String(error) }),
    archiveNativeConversation: unavailable,
    restoreNativeConversation: unavailable,
    validateContextCapacity: unavailable,
    isConversationIdle: unavailable,
    isTaskTerminal: unavailable,
    goalCapability: unavailable,
    toConversationChoice: unavailable,
    toConversationHistoryItem: unavailable,
    appendAuditLog: unavailable,
    publishNativeEvent: unavailable,
  } as Parameters<typeof registerConversationCommandRoutes>[0]);
  return server;
}
