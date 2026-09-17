import { conversationProcessPresentation } from '../packages/shared/src/conversationProcessPresentation.js';
import { activityOutcome, nativeActivityTitle, nativeActivityTool } from '../apps/desktop/src/renderer/session/activityPresentation.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import {
  createZeusDatabase,
  ProjectRepository,
  ConversationRepository,
  ConversationSnapshotV2Repository,
  ConversationTranscriptRepository,
  ConversationProviderItemRepository,
  ConversationExecutionRepository,
} from '../packages/storage/src/index.js';
import { registerConversationSnapshotV2Api } from '../packages/local-server/src/conversationSnapshotV2Api.js';
import { initializeConversationTranscriptIndexes, stopConversationTranscriptInitialization } from '../packages/storage/src/conversationTranscriptStore.js';
import { mergeConversationProcessV2, mergeConversationTurnHistoryV2 } from '../apps/desktop/src/renderer/session/conversationSnapshotV2Adapter.js';
import { createHydratedSessionState, sessionReducer } from '../apps/desktop/src/renderer/session/sessionReducer.js';
import { createTranscriptProjection, reuseTranscriptRows, reuseTranscriptTurnRows, updateTranscriptProjection } from '../apps/desktop/src/renderer/session/transcriptProjection.js';
import { reconcileTranscriptItems } from '../apps/desktop/src/renderer/session/transcriptReconciliation.js';
import { mergeNavigationEntries, navigationRowKey } from '../apps/desktop/src/renderer/session/ConversationNavigation.js';
import { createThreadScrollController } from '../apps/desktop/src/renderer/session/useThreadScrollController.js';
import type { ConversationNavigationSnapshot } from '@zeus/shared';
import { isSubmissionWaitingInQueue, orderTranscriptItemsWithQueue } from '../apps/desktop/src/renderer/session/conversationQueuePresentation.js';
import { TranscriptRowMeasurementCache, TranscriptViewportLayout, transcriptViewportMaximumWindowRows, transcriptViewportMeasurementCacheLimit } from '../apps/desktop/src/renderer/session/transcriptViewportVirtualizer.js';
import { rememberSessionHotState, sessionHotCacheByteLimit, sessionHotCacheEntryByteLimit, type SessionHotCache } from '../apps/desktop/src/renderer/session/sessionHotCache.js';
import type {
  NativeConversationChoice,
  NativeConversationSnapshot,
  NativeConversationSnapshotV2Page,
  NativeConversationModelHistoryV2Item,
  NativeConversationProcessV2Item,
  NativeSessionState,
  NativeQueuedSubmission,
  NativeQueueSnapshot,
  NativeSessionItemBuffer,
} from '../apps/desktop/src/renderer/session/sessionTypes.js';

// 复用事件流探针的样式跳过方式，仅调用真实转录投影，不启动渲染器。
registerHooks({
  /** Node 无需加载组件样式，其他模块仍使用正常解析。 */
  load(url, context, nextLoad) {
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true };
    return nextLoad(url, context);
  },
});
/** tsx 探针不经过 Vite 的 JSX 自动运行时，显式提供组件模块需要的 React 命名空间。 */
(globalThis as typeof globalThis & { React: typeof import('react') }).React = await import('react');
/** 将历史过程分页串联到正式行编号和轮次分组，覆盖同轮多段思考。 */
const { projectTranscriptRows, projectTranscriptTurnRows, projectTranscriptFailureRows } = await import('../apps/desktop/src/renderer/session/ConversationTranscript.js');
/** 工作面入口也引用组件样式，必须在样式加载钩子安装后导入。 */
const { resolveConversationNavigationId, resolveSelectedNativeConversationForProject } = await import('../apps/desktop/src/renderer/features/workspace/workspaceSupport.js');

/** 为探针条目建立与正式协议相同的最小持久位置。 */
function probeTranscript(entryId: string, order: number, openingInputId: string | null = 'probe-input', displayStageId: string | null = null, revision = order) {
  return {
    placement: { entryId, order, orderEpoch: 1, placementRevision: revision, turnId: 'turn', openingInputId, displayStageId },
    sources: [{ domain: 'probe', scope: 'turn', sourceId: entryId, facet: 'body', revision, contentRevision: revision }],
  };
}

/** 失败记录必须早于后续发言，不能随缺页、排队或重复身份移动到底部。 */
function verifyFailureOrder(): void {
  /** 固定时间覆盖同刻结束与后续轮次、缺失结束时间两种边界。 */
  const at = (second: number) => new Date(Date.UTC(2026, 8, 16, 0, 0, second)).toISOString();
  /** 最小消息直接经过生产行投影，保留普通输入身份。 */
  const message = (id: string, turnId: string, second: number): NativeSessionItemBuffer => ({
    key: id,
    itemId: id,
    turnId,
    conversationId: 'failure-order',
    threadId: 'failure-order',
    type: 'userMessage',
    phase: 'user',
    status: 'completed',
    text: id,
    payload: {},
    resources: [],
    timelineAt: at(second),
    updatedAt: at(second),
  });
  /** 无原生轮次身份时也必须能按本地轮次恢复失败位置。 */
  for (const providerTurnId of ['failed', null]) {
    /** 失败轮次别名由同一持久身份去重。 */
    const turn: NativeSessionState['turnsByProviderId'][string] = {
      id: 'failed',
      providerTurnId,
      submissionId: null,
      status: 'failed',
      startedAt: at(0),
      createdAt: at(0),
      completedAt: at(1),
      updatedAt: at(1),
      error: { category: 'rate_limit', code: 'insufficient_quota', message: '额度不足', providerStatus: 'failed', additionalDetails: [] },
    };
    for (const orphan of [false, true]) {
      for (const completedAt of [at(1), null]) {
        /** 报错前提交但仍未发送的队列消息也应位于失败提示之后。 */
        const queued = { ...message('queued', 'pending', 0), optimistic: true, status: 'queued' };
        /** 同轮继续输入、下一轮输入和队尾均保持各自顺序。 */
        const items = [...(orphan ? [] : [message('opening', 'failed', 0)]), message('same-turn-after', 'failed', 2), message('next-turn', 'next', 3), queued];
        /** 两个别名只能生成一条失败行。 */
        const turns = { failed: { ...turn, completedAt }, alias: { ...turn, completedAt } };
        /** 重建投影等同重新进入会话，不依赖组件内临时记忆。 */
        const rows = projectTranscriptFailureRows(projectTranscriptTurnRows(projectTranscriptRows(items), null, { failed: 'failed' }), turns);
        assertProbe(rows.map((row) => row.key).join('|') === [...(orphan ? [] : ['opening']), 'turn-failure:failed', 'same-turn-after', 'next-turn', 'queued'].join('|'), '失败位置必须保持在原输入之后、后续发言之前，且不重复。');
        /** 队尾消息早于失败提交时，也不能跑到失败提示上方。 */
        const pendingRows = projectTranscriptFailureRows(projectTranscriptRows([queued]), turns);
        assertProbe(pendingRows[0]?.kind === 'turn_failure', '未被模型接手的排队消息必须位于失败记录之后。');
      }
    }
  }
}
verifyFailureOrder();

// 通过历史分页投影检查各协议的 Pi 思考；截断预览也必须保留入口。
for (const protocolFamily of ['openai_completions', 'openai_responses', 'anthropic_messages']) {
  for (const truncated of [false, true]) {
    /** 旧记录没有详情标记，正文截断时也无法依赖 JSON 内部的 Provider 字段。 */
    const processItem = {
      id: 'thinking',
      turnId: 'turn',
      kind: 'reasoning',
      status: 'completed',
      protocolFamily,
      sourceEventId: 'pi:block:104:0',
      stageId: 'stage',
      title: '思考摘要',
      startedAt: '2026-09-14T03:00:00Z',
      completedAt: '2026-09-14T03:00:01Z',
      detail: { preview: truncated ? '{"block":{"thinking":"已确认性能瓶颈' : JSON.stringify({ block: { type: 'thinking', thinking: '已确认性能瓶颈' } }), truncated },
      transcript: probeTranscript('thinking', 1, 'probe-input', 'stage'),
    } as NativeConversationProcessV2Item;
    /** 过程页沿用正式入口，不启动模型或读写正式会话。 */
    const snapshot = { id: 'thinking-probe', items: [], turns: [], snapshotV2: { structureGeneration: 1 }, v2Paging: {} } as unknown as NativeConversationSnapshot;
    /** 同轮保留 Codex 状态摘要，防止修复时把所有 reasoning 都改成详情。 */
    const page = {
      schemaVersion: 2,
      conversationId: snapshot.id,
      structureGeneration: 1,
      kind: 'process',
      items: [
        processItem,
        { ...processItem, id: 'thinking-next', sourceEventId: 'pi:block:105:0', transcript: probeTranscript('thinking-next', 2, 'probe-input', 'stage') },
        { ...processItem, id: 'codex-summary', protocolFamily: 'openai_responses', sourceEventId: 'codex:item:summary', transcript: probeTranscript('codex-summary', 3, 'probe-input', 'stage') },
      ],
    } as NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>;
    /** 真实分页必须保留详情身份和可读文字；界面展开交互由浏览器另行检查。 */
    const items = mergeConversationProcessV2(snapshot, 'turn', page).items;
    assertProbe(
      items.some((item) => item.id === 'thinking' && item.payload.reasoningPresentation === 'process_text' && item.text.includes('已确认性能瓶颈')) &&
        items.some((item) => item.id === 'codex-summary' && item.payload.reasoningPresentation === undefined),
      'Pi 各协议的完整或截断思考必须可回看，且不能混入 Codex 状态摘要。',
    );
    /** 分页所得各条记录按正式缓冲字段进入转录，不改变原始条目身份。 */
    const buffered: NativeSessionItemBuffer[] = items.map((item) => ({ ...item, key: item.id, itemId: item.id, conversationId: snapshot.id, threadId: 'thread', phase: item.phase ?? 'prework' }));
    for (const presentation of ['process_text', 'details_collapsed']) {
      /** 旧详情标记可能只存在于 detail，仍须保留每段正文的独立编号。 */
      const reasoningItems = buffered.map((item) =>
        item.key === 'codex-summary' || presentation === 'process_text' ? item : { ...item, payload: { ...item.payload, reasoningPresentation: undefined, detail: { reasoningPresentation: presentation } } },
      );
      /** 流式摘要换条目后仍使用同一轮次编号，正文编号保持原值。 */
      const replacementSummary = { ...reasoningItems.find((item) => item.key === 'codex-summary')!, key: 'codex-summary-next', itemId: 'codex-summary-next', text: '继续核对结果', status: 'in_progress' };
      for (const historyOnly of [false, true]) {
        /** 两段正文和最新摘要共存；历史模式只隐藏状态摘要。 */
        const rows = projectTranscriptRows([...reasoningItems, replacementSummary], [], 'turn', historyOnly);
        assertProbe(
          rows.map((row) => row.key).join('|') === (historyOnly ? 'transcript:thinking|transcript:thinking-next' : 'transcript:thinking|transcript:thinking-next|reasoning-summary:turn'),
          `思考正文须各自保留，最新状态摘要独立且编号稳定：${protocolFamily}/${presentation}/${historyOnly}/${rows.map((row) => row.key).join('|')}`,
        );
        /** 同时核对未分组和已结束轮次，重复编号不能进入布局索引。 */
        for (const terminalTurns of [{}, { turn: 'completed' as const }]) {
          /** 真实布局校验保持开启，不能通过删行或跳过重复校验掩盖冲突。 */
          const projected = projectTranscriptTurnRows(rows, null, terminalTurns);
          new TranscriptViewportLayout().syncKeys(
            projected.map((row) => row.key),
            new TranscriptRowMeasurementCache(),
          );
        }
      }
    }
  }
}

/** 工具定义跨模型共用标准活动类型；未知工具和状态说明不得误分类。 */
for (const [name, expected] of [
  ['bash', 'commandExecution'],
  ['read', 'commandExecution'],
  ['ls', 'commandExecution'],
  ['grep', 'commandExecution'],
  ['find', 'commandExecution'],
  ['write', 'fileChange'],
  ['edit', 'fileChange'],
  ['plugin_tool', 'dynamicToolCall'],
]) {
  /** 同一条调用的声明与完成结果共同生成共享展示字段。 */
  const presentation = conversationProcessPresentation('tool', {
    provider: 'pi',
    block: { name, arguments: { command: 'pwd', path: 'src/index.ts', pattern: 'export' } },
    payload: { toolName: name, result: { content: [{ type: 'text', text: '完成' }] } },
  });
  assertProbe(presentation.type === expected && presentation.payload.toolName === name && presentation.payload.output === '完成', 'Pi 工具声明和结果必须统一为既有活动组件使用的类型和字段。');
  if (name === 'bash') assertProbe(presentation.payload.command === 'pwd', '工具结束后不能丢失原始命令。');
}
/** 受管命令的真实非零退出码必须进入公共展示，不能因工具已返回而丢失失败依据。 */
const failedCommand = conversationProcessPresentation('tool', { provider: 'pi', payload: { toolName: 'bash', result: { details: { exitCode: 7 } } } });
assertProbe(failedCommand.payload.exitCode === 7, '命令失败退出码必须在实时与历史共用的转换中保留。');
/** 原生身份和状态经历史转换后仍能驱动真实组件，未知名称不得误分类。 */
for (const [name, kind] of [
  ['zeus_browser_open', 'browser'],
  ['zeus_computer__click', 'computer'],
  ['zeus_browser.snapshot', 'browser'],
]) {
  assertProbe(nativeActivityTool({ toolName: name })?.kind === kind, '两个 Provider 的原生工具命名必须映射到同一展示类别。');
}
assertProbe(nativeActivityTool({ toolName: 'plugin_zeus_browser_open' }) === null, '插件名称包含原生工具字样也不能冒充原生操作。');
/** 使用原生观察的应用名称，禁止从内部标识猜测产品。 */
const desktopPresentation = conversationProcessPresentation('tool', {
  itemType: 'dynamicToolCall',
  payload: { namespace: 'zeus_computer', tool: 'get_app_state', arguments: { app: 'com.github.electron' }, contentItems: [{ type: 'inputText', text: JSON.stringify({ application: { name: 'Zeus Test' } }) }], success: true },
});
assertProbe(nativeActivityTitle({ status: 'completed', payload: desktopPresentation.payload }, true)?.includes('Zeus Test') === true, '历史投影必须保留工具身份和真实应用元信息。');
assertProbe(
  !nativeActivityTitle({ status: 'completed', payload: { namespace: 'zeus_computer', tool: 'get_app_state', arguments: { app: 'com.github.electron' } } }, true)?.includes('com.github.electron'),
  '缺少真实名称时不得在摘要暴露内部标识。',
);
/** 已完成返回、用户接管与动作结果未知是不同的展示状态。 */
for (const [result, expected] of [
  [{ status: 'waiting_for_user' }, 'waiting'],
  [{ status: 'user_control_resumed' }, 'observe'],
  [{ action: { outcome: 'unknown' } }, 'unknown'],
] as const) {
  assertProbe(activityOutcome({ status: 'completed', payload: { namespace: 'zeus_computer', tool: 'click', contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] } }) === expected, '调用已返回不能覆盖实际接管或未确认结果。');
}
assertProbe(activityOutcome({ status: 'completed', payload: { success: false } }) === 'failed' && activityOutcome({ status: 'completed', payload: { status: 'cancelled' } }) === 'cancelled', '结束记录仍保留失败与取消的真实状态。');
assertProbe(activityOutcome({ status: 'completed', payload: failedCommand.payload }) === 'failed', '非零退出码不能显示已完成。');
assertProbe(activityOutcome({ status: 'completed', payload: { namespace: 'zeus_computer', tool: 'click', v2ContentTruncated: true } }) === 'unknown', '桌面结果截断时不能丢失潜在的接管状态并误报完成。');
/** 工具展示可单独检查，不依赖后续长历史游标与数据库场景。 */
if (process.argv.includes('--activity-presentation')) {
  await probeNavigation();
  console.log('工具展示探针通过：原生身份、应用名称、失败、取消、接管与未确认结果。');
  process.exit(0);
}
assertProbe(
  conversationProcessPresentation('waiting', { provider: 'pi' }).type === 'commentary' && conversationProcessPresentation('retry', { provider: 'pi' }).type === 'commentary',
  'Pi 等待和重试只显示状态说明，不伪装工具或可回答问题。',
);

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

/** 错误回执未确认时，后发消息必须仍在原消息之后。 */
const failedMessage = { key: 'first', type: 'userMessage', optimistic: true, clientUserMessageId: 'first', payload: { submissionId: 'first-submission' }, timelineAt: '2026-09-14T04:00:00Z' } as NativeSessionItemBuffer;
/** 尚无队列回执的后发消息，正是旧排序缺口。 */
const newMessage = { ...failedMessage, key: 'second', clientUserMessageId: 'second', payload: {}, timelineAt: '2026-09-14T04:01:00Z' };
/** 引导已送入当前轮次，即使原生回显未到，也必须先于之后的提问和回答。 */
const steering = { ...failedMessage, status: 'steering', payload: { delivery: 'steer_now' } };
/** 答题记录保持原问题之后的展示顺序。 */
const question = { ...newMessage, key: 'question', type: 'agentMessage', optimistic: false };
const answer = { ...steering, key: 'answer', timelineAt: '2026-09-14T04:02:00Z' };
assertProbe(
  orderTranscriptItemsWithQueue([steering, question, answer], null)
    .map((item) => item.key)
    .join(',') === 'first,question,answer',
  '已接纳的引导消息不得被推到问答之后。',
);
/** 已确认历史即使更新时间更晚，也必须保持已有相对顺序。 */
const confirmedHistory = [
  { ...failedMessage, key: 'history-first', optimistic: false },
  { ...newMessage, key: 'history-second', optimistic: false },
];
for (const status of ['paused', 'failed']) {
  /** 两种发送结果都保留原提交的队列位置。 */
  const queue = { ...dispatchPendingQueue, submissions: [{ ...dispatchPendingSubmission, id: 'first-submission', clientUserMessageId: 'first', status, pausedReason: status === 'paused' ? 'outcome_unknown' : null }] };
  assertProbe(
    orderTranscriptItemsWithQueue([...confirmedHistory, failedMessage, newMessage], queue)
      .map((item) => item.key)
      .join(',') === 'history-first,history-second,first,second',
    '本地回执未到达时，失败消息和后发消息不得倒序。',
  );
}
assertProbe(orderTranscriptItemsWithQueue([confirmedHistory[1]!, confirmedHistory[0]!], null)[0]!.key === 'history-second', '排序补队列不能再次按时间改排持久历史。');

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
const equalTimeItems = [1, 2, 3].map(
  (sequence) => ({ key: `entry-${sequence}`, updatedAt: '2026-01-01T00:00:00Z', payload: { v2Sequence: 4 - sequence }, transcript: probeTranscript(`entry-${sequence}`, sequence) }) as NativeSessionItemBuffer,
);
assertProbe(
  orderTranscriptItemsWithQueue(equalTimeItems, null)
    .map((item) => item.transcript?.placement.order)
    .join(',') === '1,2,3',
  '队列层必须沿用上游持久顺序，不能按来源序号再次改排',
);

/** 实时、快照和分页乱序到达时只按显示位置合并，旧来源修订不能覆盖新正文。 */
const transcriptItem = (entryId: string, order: number, revision: number, text: string): import('../apps/desktop/src/renderer/session/sessionTypes.js').NativeItemSnapshot => ({
  id: entryId,
  turnId: 'turn',
  providerItemId: entryId,
  type: 'agentMessage',
  status: 'completed',
  phase: 'final_answer',
  text,
  payload: {},
  resources: [],
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  updatedAt: '2026-01-01T00:00:01Z',
  transcript: probeTranscript(entryId, order, 'probe-input', null, revision),
});
const reconciled = reconcileTranscriptItems([transcriptItem('second', 2, 3, '新正文')], [transcriptItem('first', 1, 2, '第一条'), transcriptItem('second', 2, 1, '旧正文')]);
assertProbe(reconciled.items.map((item) => item.id).join(',') === 'first,second' && reconciled.items[1]?.text === '新正文', '统一合并必须按持久位置排序并拒绝旧来源覆盖');

/** 来源写入修订不能冒充正文新鲜度，同修订轻量预览也不能降级全文。 */
const completeBody = { ...transcriptItem('body', 1, 10, '完整的新正文'), status: 'in_progress' };
const staleCopy = transcriptItem('body', 1, 11, '旧正文');
staleCopy.transcript.sources[0]!.contentRevision = 4;
assertProbe(reconcileTranscriptItems([completeBody], [staleCopy]).items[0]!.text === completeBody.text, '迟到历史副本必须继承其正文修订');
assertProbe(reconcileTranscriptItems([completeBody], [{ ...completeBody, text: '完整', payload: { v2ContentTruncated: true } }]).items[0]!.text === completeBody.text, '同修订预览不得覆盖全文');
assertProbe(reconcileTranscriptItems([completeBody], [transcriptItem('body', 1, 12, '短修正')]).items[0]!.text === '短修正', '更新修订允许合法缩短正文');

/** 正式快照和实时归约共同验证正文、位置、顺序与投影引用。 */
const probeSnapshot = {
  id: 'reconciliation',
  projectId: 'project',
  providerThreadId: 'thread',
  items: [completeBody, transcriptItem('other', 2, 10, '另一条')],
  turns: [],
  messages: [],
  requests: [],
  submissions: [],
  queue: { state: { type: 'idle' }, submissions: [] },
  throughEventSeq: 1,
} as unknown as NativeConversationSnapshot;
const beforeContent = createHydratedSessionState(probeSnapshot);
const staleHydrated = sessionReducer(beforeContent, { type: 'snapshot_hydrated', snapshot: { ...probeSnapshot, items: [staleCopy] } });
assertProbe(staleHydrated.items[beforeContent.itemOrder[0]!]!.text === completeBody.text, '快照必须走统一正文合并');
const contentEvent = {
  id: 'content-change',
  type: 'conversation.item.delta',
  createdAt: '2026-09-16T00:00:00Z',
  payload: {
    projectId: 'project',
    conversationId: 'reconciliation',
    threadId: 'thread',
    turnId: 'turn',
    itemId: 'body',
    itemType: completeBody.type,
    textContent: '完整的新正文追加',
    transcript: probeTranscript('body', 1, 'probe-input', null, 12),
  },
} as const;
const afterContent = sessionReducer(beforeContent, { type: 'event_received', event: contentEvent });
assertProbe(afterContent.items[beforeContent.itemOrder[0]!]!.text === '完整的新正文追加' && afterContent.itemOrder === beforeContent.itemOrder, '纯内容更新必须沿用顺序数组');
const beforeItems = beforeContent.itemOrder.map((key) => beforeContent.items[key]!);
const beforeRows = projectTranscriptRows(beforeItems);
const projection = createTranscriptProjection(beforeContent, [], beforeItems, beforeRows, projectTranscriptTurnRows(beforeRows));
const updatedProjection = updateTranscriptProjection(projection, afterContent, []);
assertProbe(updatedProjection !== null && updatedProjection.rowKeys === projection.rowKeys && updatedProjection.items[1] === projection.items[1], '内容批次必须保留未变条目和顶层键数组');
const rebuiltRows = reuseTranscriptRows(beforeRows, projectTranscriptRows(beforeItems));
const rebuiltTurns = reuseTranscriptTurnRows(projection.turnRows, projectTranscriptTurnRows(rebuiltRows));
assertProbe(rebuiltRows.every((row, index) => row === beforeRows[index]) && rebuiltTurns.every((row, index) => row === projection.turnRows[index]), '结构核对必须复用未变化条目及父组');
const changedPosition = { ...completeBody, transcript: { ...completeBody.transcript, placement: { ...completeBody.transcript.placement, order: 5, orderEpoch: 2, placementRevision: 20 } } };
const movedHydrated = sessionReducer(beforeContent, { type: 'snapshot_hydrated', snapshot: { ...probeSnapshot, items: [changedPosition] } });
assertProbe(movedHydrated.items[beforeContent.itemOrder[0]!]!.transcript?.placement.orderEpoch === 2, '纯位置快照不能被内容对象复用规则丢弃');

/** 使用正式仓库验证迟到历史、重编号、事务回滚和 Pi 来源别名。 */
async function verifyTranscriptStorageBoundaries(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'zeus-transcript-boundaries-'));
  const db = await createZeusDatabase(join(directory, 'probe.db'));
  try {
    const repo = new ConversationTranscriptRepository(db);
    const at = '2026-09-16T00:00:00Z';
    const register = (id: string, turnId: string, kind: 'ordinary_input' | 'content' = 'content') =>
      repo.registerSource({
        conversationId: 'ordering',
        sourceDomain: 'provider_item',
        sourceScope: 'segment',
        sourceId: id,
        facet: 'body',
        preferredEntryId: id,
        kind,
        turnId,
        segmentId: 'segment',
        firstSeenAt: at,
        orderingEvidence: 'provider',
        contentHash: id,
      });
    register('a', 'a', 'ordinary_input');
    const second = register('b', 'b', 'ordinary_input');
    const late = register('late-a', 'a');
    assertProbe(late.placement.order! < second.placement.order!, '旧轮次迟到内容必须位于新轮次之前');
    db.execute('CREATE TABLE probe_placement_events (epoch INTEGER, revision INTEGER)');
    repo.onPlacementChanged((_conversationId, epoch, revision) => db.execute('INSERT INTO probe_placement_events VALUES (?, ?)', [epoch, revision]));
    for (let index = 0; index < 20; index += 1) register(`late-${index}`, 'a');
    assertProbe(repo.orderEpoch('ordering') > 1 && db.countRows('probe_placement_events') > 0, '空隙耗尽必须重编号并在同一事务记录通知');
    repo.startStage({ conversationId: 'ordering', turnId: 'a', segmentId: 'segment', stageId: 'early-stage', occurredAt: at });
    register('steer-a', 'a', 'ordinary_input');
    const stageResult = repo.registerSource({
      conversationId: 'ordering',
      sourceDomain: 'provider_item',
      sourceScope: 'segment',
      sourceId: 'early-stage-result',
      facet: 'body',
      preferredEntryId: 'early-stage-result',
      kind: 'content',
      turnId: 'a',
      segmentId: 'segment',
      displayStageId: 'early-stage',
      firstSeenAt: at,
      orderingEvidence: 'provider',
      contentHash: 'result',
    });
    assertProbe(stageResult.placement.openingInputId === 'a', '阶段先开始、正文后完成时不能被中途插话吸走');
    // 复现 Pi 将同一用户输入登记两次后，过程挂在 Provider 身份下的真实故障。
    register('duplicate-a', 'a', 'ordinary_input');
    repo.startStage({ conversationId: 'ordering', turnId: 'a', segmentId: 'segment', stageId: 'duplicate-stage', occurredAt: at });
    register('duplicate-result', 'a');
    repo.mergeSourceIdentity('ordering', 'duplicate-a', 'steer-a');
    assertProbe(repo.envelopeForEntry('ordering', 'duplicate-result')?.placement.openingInputId === 'steer-a', '输入合并必须同步修正已有过程归属');
    assertProbe(repo.envelopeForEntry('ordering', 'duplicate-stage')?.placement.openingInputId === 'steer-a', '输入合并必须同步修正阶段归属');
    assertProbe(repo.envelopeForEntry('ordering', 'early-stage-result')?.placement.openingInputId === 'a', '输入合并不能跨越真实追加消息');
    assertProbe(
      db.get<{ current_stage_id: string }>('SELECT current_stage_id FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?', ['ordering', 'steer-a'])?.current_stage_id === 'duplicate-stage',
      '输入合并必须保留后续工具继续使用的当前阶段',
    );
    const beforeRollback = repo.revision('ordering');
    try {
      db.transaction(() => {
        register('rollback', 'a');
        throw new Error('回滚探针');
      });
    } catch {
      /* 预期回滚。 */
    }
    assertProbe(repo.revision('ordering') === beforeRollback && repo.envelopeForEntry('ordering', 'rollback') === null, '来源和位置必须共同回滚');
    const placements = repo.readPlacementBatch('ordering', ['a', 'b', 'late-a', 'unknown']);
    assertProbe(placements.uncoveredEntryIds.includes('unknown') && !placements.removedEntryIds.includes('unknown') && Buffer.byteLength(JSON.stringify(placements)) <= 128 * 1024, '位置缺项不代表删除且整包必须有界');
    db.execute('INSERT INTO conversation_runtime_segments (id, conversation_id, runtime_kind, state, native_session_id, opened_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      'pi-segment',
      'pi',
      'pi',
      'current',
      'pi-thread',
      at,
      at,
      at,
    ]);
    const provider = new ConversationProviderItemRepository(db);
    const execution = new ConversationExecutionRepository(db);
    provider.upsertCompleted({
      conversationId: 'pi',
      turnId: 'pi-turn',
      providerThreadId: 'pi-thread',
      providerTurnId: 'pi-turn',
      providerItemId: 'pi-message',
      itemType: 'agentMessage',
      phase: 'final_answer',
      payload: { stageId: 'pi-message' },
      textContent: '完成正文',
      updatedAt: at,
      agentKind: 'pi',
      status: 'completed',
      completedAt: at,
    });
    const history = execution.appendModelHistory({ conversationId: 'pi', turnId: 'pi-turn', segmentId: 'pi-segment', role: 'assistant', content: { text: '完成正文', stageId: 'pi-message' }, confirmedAt: at });
    const active = repo.envelopeForSource({ conversationId: 'pi', sourceDomain: 'provider_item', sourceScope: 'pi-thread', sourceId: 'pi-message', facet: 'body' })!;
    const confirmed = repo.envelopeForSource({ conversationId: 'pi', sourceDomain: 'model_history', sourceScope: 'pi-segment', sourceId: history.id, facet: 'body' })!;
    assertProbe(active.placement.entryId === confirmed.placement.entryId && active.sources[0]!.contentRevision === confirmed.sources[0]!.contentRevision, 'Pi 活动正文与确认历史必须共用显示身份与正文修订');
    /** 旧资料队列应立即返回，并优先推进前台刚请求的会话。 */
    const project = new ProjectRepository(db).create({ id: 'background-project', name: '后台初始化', localPath: directory });
    for (const id of ['background-a', 'background-b']) new ConversationRepository(db).create({ id, projectId: project.id, title: id, transportKind: 'codex_native', providerId: 'codex' });
    await initializeConversationTranscriptIndexes(db, true);
    let initializing = false;
    try {
      repo.readPlacementBatch('background-a', []);
    } catch (error) {
      initializing = (error as { code?: string }).code === 'ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZING';
    }
    assertProbe(initializing, '后台未完成时必须返回明确初始化状态');
    let ready = false;
    const barrier = repo.waitUntilReady('background-a').then(() => {
      ready = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assertProbe(!ready, '摄取屏障不能在首批索引完成时提前放行');
    assertProbe(
      db.get<{ initialization_cursor_json: string | null }>('SELECT initialization_cursor_json FROM conversation_transcript_state WHERE conversation_id = ?', ['background-a'])?.initialization_cursor_json !== null,
      '前台请求会话必须先推进一个批次',
    );
    assertProbe(
      db.get<{ initialization_cursor_json: string | null }>('SELECT initialization_cursor_json FROM conversation_transcript_state WHERE conversation_id = ?', ['background-b'])?.initialization_cursor_json === null,
      '未请求会话不能抢占前台批次',
    );
    await barrier;
    assertProbe(repo.readPlacementBatch('background-a', []).placements.length === 0, '完整就绪后才能放行摄取屏障');
    stopConversationTranscriptInitialization(db);
    await initializeConversationTranscriptIndexes(db);
    assertProbe(repo.readPlacementBatch('background-a', []).placements.length === 0, '暂停后必须能从持久断点继续完成');
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
}
await verifyTranscriptStorageBoundaries();

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
    /** 单轮超过附件规模的过程，包含足以触发字节分页的工具详情。 */
    const processCount = 1536;
    for (let index = 1; index <= processCount; index += 1) {
      db.execute(
        'INSERT INTO conversation_process_items (id, conversation_id, turn_id, segment_id, process_sequence, kind, status, title, detail_json, source_event_id, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          `long-process-${index}`,
          conversation.id,
          'turn-0',
          'probe-segment',
          index,
          index === 2 ? 'tool' : index % 2 ? 'reasoning' : 'command',
          'completed',
          `过程 ${index}`,
          JSON.stringify(
            index === 2
              ? { provider: 'codex', itemType: 'dynamicToolCall', payload: { output: '工具长结果'.repeat(3000), namespace: 'zeus_browser', tool: 'click', success: false, arguments: { surface: 'edge' } } }
              : { text: '完整过程内容'.repeat(500) },
          ),
          `codex:item:long-${index}`,
          '2026-01-01T00:00:00Z',
          '2026-01-01T00:00:01Z',
        ],
      );
    }
    /** 探针故意模拟升级前直写数据，再走正式旧数据初始化建立显示位置。 */
    const initializing = new ConversationTranscriptRepository(db);
    assertProbe(initializing.initializeConversation(conversation.id, 1) === false, '首批初始化必须留下可恢复断点');
    assertProbe(db.get<{ initialization_state: string }>('SELECT initialization_state FROM conversation_transcript_state WHERE conversation_id = ?', [conversation.id])?.initialization_state === 'building', '半份索引不能提前标记就绪');
    new ConversationTranscriptRepository(db).initializeConversation(conversation.id);
    /** 超过十个初始化批次后必须原子就绪，并清理持久暂存事实。 */
    const initialization = db.get<{ initialization_state: string; reconstructed_count: number }>('SELECT initialization_state, reconstructed_count FROM conversation_transcript_state WHERE conversation_id = ?', [conversation.id]);
    assertProbe(initialization?.initialization_state === 'ready' && initialization.reconstructed_count === count * 4 + 1 + processCount, '旧数据必须按 512 条批次完整初始化');
    assertProbe(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM conversation_transcript_initialization_facts WHERE conversation_id = ?', [conversation.id])?.count === 0, '初始化就绪后必须清理暂存事实');
    await db.save();
    /** 查询前后核对写入计数，GET 不改变消息送达。 */
    const changes = db.get<{ count: number }>('SELECT total_changes() AS count')!.count;
    /** 目录、正文页均由同一正式仓库提供。 */
    const repository = new ConversationSnapshotV2Repository(db);
    /** 原生身份位于长结果之后，正文截断时仍必须从有界元信息恢复。 */
    const nativeItem = repository.listProcessPage({ conversationId: conversation.id, turnId: 'turn-0', entryLimit: 3 }).items.find((item) => item.id === 'long-process-2');
    assertProbe(nativeItem?.detail.truncated === true, '原生展示探针必须实际覆盖长结果截断。');
    /** 使用与真实历史列表一致的共享转换检查身份和失败状态。 */
    const nativePresentation = conversationProcessPresentation(nativeItem.kind, nativeItem.presentation);
    assertProbe(nativeActivityTitle({ status: nativeItem.status, payload: nativePresentation.payload }, true) === 'Edge · 点击 · 失败', '截断历史必须保留原生来源、具体动作与失败结果。');
    if (process.argv.includes('--activity-presentation')) return { entries: count, unfilledPlaceholders: count - 1, distantRenderedRows: 0, elapsedMs: 0, writes: 0 };
    registerConversationSnapshotV2Api({
      server,
      repository,
      projectExists: (id) => id === project.id,
      getConversation: (id) => (id === conversation.id ? conversation : undefined),
      readQueueState: () => null,
      readSubmissionReceipt: () => null,
    });
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
    /** 倒序只改变读取方向，每页交付给界面的条目仍保持正序。 */
    const processUrl = `/api/projects/${project.id}/conversations/${conversation.id}/turns/turn-0/process`;
    /** 冻结游标串联所有早期过程，验证没有跳过、重复或跨轮读取。 */
    const processSequences: number[] = [];
    /** 首屏耗时只统计一次有界接口，不混入整段历史扫描。 */
    const processStarted = performance.now();
    /** 第一页复用 Renderer 的条数和字节预算。 */
    let processResponse = await server.inject({ method: 'GET', url: `${processUrl}?direction=tail&limit=48&byteLimit=98304` });
    assertProbe(processResponse.statusCode === 200, `最近过程读取失败：${processResponse.body}`);
    /** 保存首屏统计，后续翻页不能改变该证据。 */
    const firstProcessPage = processResponse.json<NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>>();
    assertProbe(firstProcessPage.items.at(-1)?.sequence === processCount && firstProcessPage.items.length <= 48 && firstProcessPage.hasMore, '首屏必须立即到达最新过程，且只读取有界末页');
    console.log(JSON.stringify({ longTurnItems: processCount, firstPageItems: firstProcessPage.items.length, firstPageMs: Math.round(performance.now() - processStarted) }));
    assertProbe((await server.inject({ method: 'GET', url: `${processUrl}?direction=invalid` })).statusCode === 400, '未知读取方向必须拒绝');
    /** 同一游标换成另一轮次必须失败，记录实际响应便于复查。 */
    const crossTurn = await server.inject({ method: 'GET', url: `${processUrl.replace('turn-0', 'turn-1')}?direction=tail&cursor=${encodeURIComponent(firstProcessPage.nextCursor!)}` });
    assertProbe(crossTurn.statusCode === 400, `倒序游标不能跨轮使用：${crossTurn.statusCode} ${crossTurn.body}`);
    for (;;) {
      /** 每页从真实接口解码，游标的字节截断也必须连续。 */
      const processPage = processResponse.json<NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>>();
      assertProbe(
        processPage.items.every((item, index) => index === 0 || processPage.items[index - 1]!.sequence < item.sequence),
        '倒序页内部必须正序呈现',
      );
      processSequences.unshift(...processPage.items.map((item) => item.sequence));
      if (!processPage.nextCursor) break;
      processResponse = await server.inject({ method: 'GET', url: `${processUrl}?direction=tail&limit=48&byteLimit=98304&cursor=${encodeURIComponent(processPage.nextCursor)}` });
      assertProbe(processResponse.statusCode === 200 && processSequences.length <= processCount, '过程游标必须推进并成功读取');
    }
    assertProbe(processSequences.length === processCount && processSequences.every((sequence, index) => sequence === index + 1), '向上翻页必须保留全部思考与工具记录，不能重复或遗漏');
    /** 正文的倒序页与过程共用有界游标规则，同时保留默认正序入口。 */
    const tailBody = await server.inject({ method: 'GET', url: `/api/projects/${project.id}/conversations/${conversation.id}/turns/turn-0/model-history?direction=tail&limit=2` });
    assertProbe(
      tailBody.statusCode === 200 &&
        JSON.stringify(tailBody.json<{ items: Array<{ id: string }> }>().items.map((item) => item.id)) ===
          JSON.stringify(
            body
              .json<{ items: Array<{ id: string }> }>()
              .items.slice(-2)
              .map((item) => item.id),
          ),
      '轮次正文必须从末页开始且保留正序身份',
    );
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
    return { entries: count, initializedSources: initialization.reconstructed_count, unfilledPlaceholders: count - 1, distantRenderedRows: distant.renderedRowCount, elapsedMs: Math.round(performance.now() - started), writes: 0 };
  } finally {
    await server.close();
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
}
