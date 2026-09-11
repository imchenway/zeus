import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { createZeusDatabase, ProjectRepository, ConversationRepository, ConversationSnapshotV2Repository } from '../packages/storage/src/index.js';
import { registerConversationSnapshotV2Api } from '../packages/local-server/src/conversationSnapshotV2Api.js';
import { mergeConversationTurnHistoryV2 } from '../apps/desktop/src/renderer/session/conversationSnapshotV2Adapter.js';
import { mergeNavigationEntries, navigationRowKey } from '../apps/desktop/src/renderer/session/ConversationNavigation.js';
import { createThreadScrollController } from '../apps/desktop/src/renderer/session/useThreadScrollController.js';
import { resolveConversationNavigationId, resolveSelectedNativeConversationForProject } from '../apps/desktop/src/renderer/features/workspace/workspaceSupport.js';
import type { ConversationNavigationSnapshot } from '@zeus/shared';
import { isSubmissionWaitingInQueue, orderTranscriptItemsWithQueue } from '../apps/desktop/src/renderer/session/conversationQueuePresentation.js';
import { TranscriptRowMeasurementCache, TranscriptViewportLayout, transcriptViewportMaximumWindowRows, transcriptViewportMeasurementCacheLimit } from '../apps/desktop/src/renderer/session/transcriptViewportVirtualizer.js';
import { rememberSessionHotState, sessionHotCacheByteLimit, sessionHotCacheEntryByteLimit, type SessionHotCache } from '../apps/desktop/src/renderer/session/sessionHotCache.js';
import type {
  NativeConversationChoice,
  NativeConversationSnapshot,
  NativeConversationSnapshotV2Page,
  NativeConversationModelHistoryV2Item,
  NativeSessionState,
  NativeQueuedSubmission,
  NativeQueueSnapshot,
} from '../apps/desktop/src/renderer/session/sessionTypes.js';

/** 已有消息的任务会话仍保留首发工作面的导航身份；入口可能只持有真实身份。 */
const linkedConversation = { id: 'linked-conversation', navigationId: 'task-push:linked-operation', projectId: 'linked-project' } as NativeConversationChoice;
assertProbe(resolveSelectedNativeConversationForProject([linkedConversation], linkedConversation.id, linkedConversation.projectId) === linkedConversation, '关联会话的真实身份必须解析到当前工作面，不能退回空白新对话。');
assertProbe(resolveSelectedNativeConversationForProject([linkedConversation], linkedConversation.navigationId!, linkedConversation.projectId) === linkedConversation, '侧栏的稳定导航身份仍须命中同一会话。');
assertProbe(
  resolveConversationNavigationId(resolveSelectedNativeConversationForProject([linkedConversation], linkedConversation.id, linkedConversation.projectId)!) === linkedConversation.navigationId,
  '关联入口必须沿用稳定导航身份，保留首发工作面。',
);
assertProbe(resolveSelectedNativeConversationForProject([linkedConversation], linkedConversation.id, 'another-project') === null, '真实身份不能绕过项目边界。');
assertProbe(resolveSelectedNativeConversationForProject([linkedConversation], 'missing-conversation', linkedConversation.projectId) === null, '不存在的会话不能误选其他消息。');
assertProbe(resolveSelectedNativeConversationForProject([{ ...linkedConversation, navigationId: undefined }], linkedConversation.id, linkedConversation.projectId)?.id === linkedConversation.id, '未经历本地首发的普通会话仍可打开。');

/** 普通发送已保存、模型尚未接手时的队首。 */
const dispatchPendingSubmission: NativeQueuedSubmission = { id: 'pending-head', content: '普通发送', position: 1, status: 'queued', pausedReason: null };
/** 复用真实队列状态核对提示与操作的展示条件。 */
const dispatchPendingQueue: NativeQueueSnapshot = { state: { type: 'idle' }, waitReason: 'dispatch_pending', submissions: [dispatchPendingSubmission] };
assertProbe(!isSubmissionWaitingInQueue(null, null), '队列确认前不得猜测排队状态。');
assertProbe(!isSubmissionWaitingInQueue(dispatchPendingQueue, dispatchPendingSubmission), '空闲队首不得闪现排队提示和引导操作。');
assertProbe(!isSubmissionWaitingInQueue({ ...dispatchPendingQueue, waitReason: undefined }, dispatchPendingSubmission), '缺少等待原因时仍须按空闲队首识别发送交接。');
assertProbe(!isSubmissionWaitingInQueue({ ...dispatchPendingQueue, state: { type: 'dispatching', submissionId: dispatchPendingSubmission.id } }, dispatchPendingSubmission), '自身正在派发时不得显示排队操作。');
assertProbe(isSubmissionWaitingInQueue({ ...dispatchPendingQueue, state: { type: 'dispatching', submissionId: 'earlier-message' } }, dispatchPendingSubmission), '前序消息正在派发时必须保留排队操作。');
assertProbe(isSubmissionWaitingInQueue({ ...dispatchPendingQueue, state: { type: 'active', turnId: 'current-turn', phase: 'prework' }, waitReason: 'current_turn' }, dispatchPendingSubmission), '当前轮次执行中必须保留排队提示与引导入口。');
assertProbe(
  isSubmissionWaitingInQueue({ ...dispatchPendingQueue, submissions: [dispatchPendingSubmission, { ...dispatchPendingSubmission, id: 'earlier-message', position: 0 }] }, dispatchPendingSubmission),
  '空闲时仍被前序消息阻塞的提交必须保留排队状态。',
);
assertProbe(isSubmissionWaitingInQueue({ ...dispatchPendingQueue, waitReason: 'conversation_restoring' }, dispatchPendingSubmission), '恢复中的真实等待不能隐藏。');
assertProbe(isSubmissionWaitingInQueue({ ...dispatchPendingQueue, waitReason: 'plan_confirmation' }, dispatchPendingSubmission), '等待计划确认的队首不能隐藏。');
assertProbe(isSubmissionWaitingInQueue(dispatchPendingQueue, { ...dispatchPendingSubmission, status: 'paused', pausedReason: 'user_confirmation' }), '已暂停消息必须保留后续处理入口。');
assertProbe(!isSubmissionWaitingInQueue(dispatchPendingQueue, { ...dispatchPendingSubmission, providerTurnId: 'accepted-turn' }), '模型已接手的消息不得重新出现排队操作。');

const rowCount = 100_000;
const rowKeys = Array.from({ length: rowCount }, (_, index) => `row-${index}`);
const measurements = new TranscriptRowMeasurementCache();
for (let index = 0; index < 10_000; index += 1) measurements.remember(`row-${index}`, 96 + (index % 73));

const layout = new TranscriptViewportLayout();
layout.syncKeys(rowKeys, measurements);
const pinnedRowKeys = new Set(['row-0', 'row-50000', 'row-99999']);
const middleProjection = layout.project({
  scrollTop: 7_300_000,
  viewportHeight: 900,
  pinnedRowKeys,
});
const middleProjectedKeys = projectedKeys(middleProjection.slots);

assertProbe(measurements.size === transcriptViewportMeasurementCacheLimit, '变高行测量缓存必须按上限淘汰');
assertProbe(middleProjection.renderedRowCount <= transcriptViewportMaximumWindowRows + pinnedRowKeys.size, '视口窗口只能附加显式保留行');
assertProbe(
  [...pinnedRowKeys].every((key) => middleProjectedKeys.has(key)),
  '活动、展开或焦点保留行不能被窗口淘汰',
);
assertProbe(middleProjection.slots.length <= middleProjection.renderedRowCount * 2 + 1, '占位与行节点数量必须随窗口而不是随历史总量增长');

const prependLayout = new TranscriptViewportLayout();
const oldKeys = rowKeys.slice(50_000);
const frozenAnchorKey = 'row-75000';
prependLayout.syncKeys(oldKeys, measurements);
const oldScrollTop = 25_000 * 146;
const beforePrepend = prependLayout.project({ scrollTop: oldScrollTop, viewportHeight: 900 });
assertProbe(projectedKeys(beforePrepend.slots).has(frozenAnchorKey), '前插前的视口锚点必须已挂载');
prependLayout.syncKeys(rowKeys, measurements);
const afterPrepend = prependLayout.project({ scrollTop: oldScrollTop, viewportHeight: 900, pinnedRowKeys: new Set([frozenAnchorKey]) });
assertProbe(projectedKeys(afterPrepend.slots).has(frozenAnchorKey), '冻结游标返回更早页后，稳定锚点必须继续挂载以校准 scrollTop');
assertProbe(afterPrepend.renderedRowCount <= transcriptViewportMaximumWindowRows + 1, '历史前插不能把中间全部行重新挂入 DOM');

const appendedKeys = [...rowKeys, 'row-100000'];
layout.syncKeys(appendedKeys, measurements);
const tailProjection = layout.project({ scrollTop: null, viewportHeight: 900, pinnedRowKeys: new Set(['row-100000']) });
assertProbe(projectedKeys(tailProjection.slots).has('row-100000'), '尾部增量必须进入尾部窗口');
assertProbe(tailProjection.renderedRowCount <= transcriptViewportMaximumWindowRows + 1, '尾部增量不能重建完整历史 DOM');

const hotCache: SessionHotCache = new Map();
const boundedEntryPayload = 'x'.repeat(3 * 1024 * 1024);
for (let index = 0; index < 6; index += 1) {
  const conversationId = `conversation-${index}`;
  rememberSessionHotState(hotCache, conversationId, probeSessionState(conversationId, boundedEntryPayload));
}
const cachedBytes = [...hotCache.values()].reduce((total, entry) => total + entry.estimatedBytes, 0);
assertProbe(cachedBytes <= sessionHotCacheByteLimit, '会话数未超限时也必须执行总字节淘汰');
assertProbe(
  [...hotCache.values()].every((entry) => Boolean(entry.state.snapshot?.v2Paging?.history.nextCursor)),
  '保留的 UI 热状态必须携带 V2 冻结历史游标',
);

const oversizedConversationId = 'conversation-oversized';
rememberSessionHotState(hotCache, oversizedConversationId, probeSessionState(oversizedConversationId, 'y'.repeat(sessionHotCacheEntryByteLimit / 2 + 1024)));
assertProbe(!hotCache.has(oversizedConversationId), '超过单会话字节上限的状态必须直接放弃并由 Snapshot V2 重建');

/** 完整目录、按轮读取与前端身份共同经过真实存储和接口。 */
const navigationProbe = await probeNavigation();
/** 同时落盘的消息必须按持久顺序排列，不能按 key 字母顺序颠倒提问和回答。 */
const equalTimeItems = [3, 1, 2].map((sequence) => ({ key: `reverse-${4 - sequence}`, updatedAt: '2026-01-01T00:00:00Z', payload: { v2Sequence: sequence } }) as NativeSessionItemBuffer);
assertProbe(
  orderTranscriptItemsWithQueue(equalTimeItems, null)
    .map((item) => item.payload.v2Sequence)
    .join(',') === '1,2,3',
  '同时间戳必须沿用持久顺序',
);

console.log(
  JSON.stringify(
    {
      status: 'passed',
      observed: {
        queuePresentationCases: 11,
        navigation: navigationProbe,
        totalRows: rowCount,
        middleProjectedRows: middleProjection.renderedRowCount,
        middleProjectionSlots: middleProjection.slots.length,
        measurementCacheEntries: measurements.size,
        prependProjectedRows: afterPrepend.renderedRowCount,
        tailProjectedRows: tailProjection.renderedRowCount,
        retainedHotSessions: hotCache.size,
        retainedHotBytes: cachedBytes,
        hotByteLimit: sessionHotCacheByteLimit,
      },
    },
    null,
    2,
  ),
);

function projectedKeys(slots: ReturnType<TranscriptViewportLayout['project']>['slots']): Set<string> {
  return new Set(slots.flatMap((slot) => (slot.kind === 'row' ? [slot.rowKey] : [])));
}

function probeSessionState(conversationId: string, payload: string): NativeSessionState {
  return {
    conversationId,
    conversationState: 'idle',
    pendingRequests: [],
    planImplementationRequests: [],
    queue: null,
    snapshot: {
      id: conversationId,
      projectId: 'probe-project',
      v2Paging: {
        history: { nextCursor: `frozen:${conversationId}`, hasMore: true, loading: false, error: null, loadedThroughSequence: null, oldestLoadedSequence: null },
      },
    },
    probePayload: payload,
  } as unknown as NativeSessionState;
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Renderer 长历史行为探针失败：${message}`);
}

/** 在临时数据库中检查完整目录和读取纯度，不访问正式历史。 */
async function probeNavigation() {
  /** 临时目录仅包含本探针创建的数据。 */
  const root = await mkdtemp(join(tmpdir(), 'zeus-0553-navigation-'));
  /** 使用正式迁移创建完整数据库结构。 */
  const db = await createZeusDatabase(join(root, 'probe.db'));
  /** 复用真实路由的范围校验与响应约定。 */
  const server = Fastify();
  try {
    /** 数据量明显超过首屏分页和七条刻度。 */
    const count = 1_000;
    /** 项目和会话经过真实存储入口创建。 */
    const project = new ProjectRepository(db).create({ id: 'navigation-project', name: '刻度探针', localPath: root });
    /** 只读历史不需要启动模型。 */
    const conversation = new ConversationRepository(db).create({
      id: 'navigation-conversation',
      projectId: project.id,
      title: '完整目录',
      transportKind: 'codex_native',
      providerId: 'codex',
      providerThreadId: 'navigation-thread',
      providerState: 'ready',
      agentKind: 'codex',
      agentTransport: 'app_server',
      nativeSessionId: 'navigation-thread',
    });
    for (let index = 0; index < count; index += 1) {
      /** 每轮有独立、稳定的发送身份。 */
      const turn = `turn-${index}`;
      /** 固定起始时间使顺序可重复检查。 */
      const at = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
      db.execute('INSERT INTO conversation_turns (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        turn,
        conversation.id,
        'navigation-thread',
        `provider-${turn}`,
        `submission-${index}`,
        'completed',
        at,
        at,
      ]);
      db.execute(
        'INSERT INTO conversation_submissions (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`submission-${index}`, conversation.id, `request-${index}`, `hash-${index}`, `client-${index}`, 'message', 'normal', 'resolved', '{}', at, at],
      );
      for (const [offset, role, content, reasoning] of [
        [0, 'user', { text: index === 0 ? '' : `第 ${index + 1} 次发言 ` + '问题'.repeat(100), providerItemId: `user-${index}`, ...(index === 0 ? { attachments: [{ name: '设计稿.png' }] } : {}) }, null],
        // 普通答复与 Codex 来源答复共用摘录；后续过程说明和思考摘要不能覆盖最终答复。
        [
          1,
          'assistant',
          { text: `第 ${index + 1} 轮最终答复 ` + '说明'.repeat(200), providerItemId: `answer-${index}`, assistantMessage: { phase: 'final_answer' } },
          index % 2 === 0 ? null : JSON.stringify({ provider: 'codex', itemId: `answer-${index}`, itemType: 'agentMessage', readableSummary: false }),
        ],
        [
          2,
          'assistant',
          { text: '中途说明不应进入摘录', providerItemId: `progress-${index}`, assistantMessage: { phase: 'commentary' } },
          JSON.stringify({ provider: 'codex', itemId: `progress-${index}`, itemType: 'agentMessage', readableSummary: false }),
        ],
        [3, 'assistant', { text: '内部思考不应进入摘录', providerItemId: `reasoning-${index}` }, JSON.stringify({ provider: 'codex', itemId: `reasoning-${index}`, readableSummary: true })],
      ] as const)
        db.execute('INSERT INTO conversation_model_history (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json, reasoning_source_json, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
          `history-${index}-${offset}`,
          conversation.id,
          index * 4 + offset + 1,
          turn,
          role === 'user' ? `submission-${index}` : null,
          'probe-segment',
          role,
          JSON.stringify(content),
          reasoning,
          at,
        ]);
    }
    /** 重复持久投影必须沿相同客户端身份折叠。 */
    db.execute(
      'INSERT INTO conversation_model_history (id, conversation_id, sequence, turn_id, submission_id, segment_id, role, content_json, confirmed_at) SELECT ?, conversation_id, ?, turn_id, submission_id, segment_id, role, content_json, confirmed_at FROM conversation_model_history WHERE id = ?',
      ['duplicate-user', count * 4 + 1, 'history-0-0'],
    );
    await db.save();
    /** 查询前后核对写入计数，GET 不改变消息送达。 */
    const changes = db.get<{ count: number }>('SELECT total_changes() AS count')!.count;
    /** 目录、正文页均由同一正式仓库提供。 */
    const repository = new ConversationSnapshotV2Repository(db);
    registerConversationSnapshotV2Api({ server, repository, projectExists: (id) => id === project.id, getConversation: (id) => (id === conversation.id ? conversation : undefined), readQueueState: () => null });
    /** 记录真实查询时间，不用截图推断性能。 */
    const started = performance.now();
    /** 完整目录一次返回，不携带分页游标。 */
    const response = await server.inject({ method: 'GET', url: `/api/projects/${project.id}/conversations/${conversation.id}/navigation` });
    assertProbe(response.statusCode === 200, `目录接口失败：${response.body}`);
    /** 使用真实接口返回值检查提问和答复界限。 */
    const snapshot = response.json<ConversationNavigationSnapshot>();
    assertProbe(snapshot.entries.length === count && new Set(snapshot.entries.map(navigationRowKey)).size === count, '完整目录不得截断或重复身份');
    assertProbe(snapshot.entries[0]?.prompt === '设计稿.png', '纯附件发言必须使用名称');
    assertProbe(
      snapshot.entries.every((entry, index) => entry.sequence === index * 4 + 1 && Array.from(entry.prompt).length <= 160 && Array.from(entry.response).length <= 320 && entry.response.startsWith(`第 ${index + 1} 轮最终答复`)),
      '顺序、字数与最终答复分类必须一致',
    );
    assertProbe((await server.inject({ method: 'GET', url: `/api/projects/another-project/conversations/${conversation.id}/navigation` })).statusCode === 404, '其他项目不得读取会话目录');
    /** 实时身份转为持久身份后不能增加第二条刻度。 */
    const tail = snapshot.entries[count - 1]!;
    /** 与完整目录合并的是末页，不是完整正文。 */
    const merged = mergeNavigationEntries(
      snapshot.entries,
      ['optimistic-id', 'confirmed-id'].map((id) => ({ ...tail, id, rowKey: navigationRowKey(tail), loaded: true })),
    );
    assertProbe(merged.length === count && merged.filter((entry) => entry.loaded).length === 1, '实时确认必须按客户端身份去重，保留未加载占位');
    assertProbe(
      mergeNavigationEntries(
        [],
        ['optimistic-id', 'confirmed-id'].map((id) => ({ ...tail, id, rowKey: navigationRowKey(tail), loaded: true })),
      ).length === 1,
      '目录返回前的重复实时回声也只能产生一条刻度',
    );
    /** 远处目标被显式保留，正文窗口仍保持数量边界。 */
    const navigationLayout = new TranscriptViewportLayout();
    navigationLayout.syncKeys(
      merged.map((entry) => entry.rowKey),
      new TranscriptRowMeasurementCache(),
    );
    const distant = navigationLayout.project({ scrollTop: null, viewportHeight: 800, pinnedRowKeys: new Set([merged[0]!.rowKey]) });
    assertProbe(projectedKeys(distant.slots).has(merged[0]!.rowKey) && distant.renderedRowCount <= transcriptViewportMaximumWindowRows + 1, '从末页定位最早发言必须保留目标且不渲染整段历史');
    /** 直接按最早轮次补正文，不通过倒翻全部页面定位。 */
    const body = await server.inject({ method: 'GET', url: `/api/projects/${project.id}/conversations/${conversation.id}/turns/turn-0/model-history` });
    assertProbe(body.statusCode === 200 && body.json<{ items: unknown[] }>().items.length > 0, `最早轮次读取失败：${body.body}`);
    /** 实际轮次页经过正文适配器，纯附件不能显示技术 JSON。 */
    const page = body.json<NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>>();
    /** 轮次合并只依赖已有的身份、分页和条目状态。 */
    const mounted = mergeConversationTurnHistoryV2({ id: conversation.id, items: [], turns: [], snapshotV2: { structureGeneration: page.structureGeneration }, v2Paging: {} } as unknown as NativeConversationSnapshot, 'turn-0', page);
    assertProbe(mounted.items.find((item) => item.type === 'userMessage')?.text === '', '纯附件正文不得回退到 JSON 包装层');
    assertProbe(db.get<{ count: number }>('SELECT total_changes() AS count')!.count === changes, '目录与正文 GET 不得产生写入');
    /** 主动历史定位必须先停止自动跟随。 */
    const scroll = createThreadScrollController();
    scroll.onExplicitHistoryRequest();
    assertProbe(scroll.onDelta().type === 'none' && scroll.onTurnStarted().type === 'none', '生成内容不得抢走历史位置');
    assertProbe(scroll.onExplicitLatestRequest().type === 'scroll_to_bottom', '返回最新必须恢复跟随');
    scroll.onExplicitHistoryRequest();
    assertProbe(scroll.onMessageSubmitted().type === 'scroll_to_bottom', '主动发送必须恢复跟随');
    return { entries: count, unfilledPlaceholders: count - 1, distantRenderedRows: distant.renderedRowCount, elapsedMs: Math.round(performance.now() - started), writes: 0 };
  } finally {
    await server.close();
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}
