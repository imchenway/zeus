import { classifyAssistantMessage, emptyConversationContextDraft } from '@zeus/shared';
import type { NativeSessionItemBuffer, NativeSessionState } from './sessionTypes.js';

const emptyItems: NativeSessionState['items'] = Object.freeze({});
const emptyItemOrder: NativeSessionState['itemOrder'] = Object.freeze([]) as unknown as NativeSessionState['itemOrder'];
const emptyTurns: NativeSessionState['turnsByProviderId'] = Object.freeze({});
const emptyChangeSets: NativeSessionState['changeSetsByProviderId'] = Object.freeze({});
const emptyTerminalTurns: NativeSessionState['terminalTurnIds'] = Object.freeze({});
const emptyRequests: NativeSessionState['pendingRequests'] = Object.freeze([]) as unknown as NativeSessionState['pendingRequests'];
const emptyPlanRequests: NativeSessionState['planImplementationRequests'] = Object.freeze([]) as unknown as NativeSessionState['planImplementationRequests'];
const emptyAttachments: NativeSessionState['attachments'] = Object.freeze([]) as unknown as NativeSessionState['attachments'];
const emptySeenEvents: NativeSessionState['seenEventIds'] = Object.freeze({});
const emptySequences: NativeSessionState['lastSequenceByGeneration'] = Object.freeze({});

type StateSelector = (state: NativeSessionState) => NativeSessionState;

/**
 * 工作区壳只保留控制、运行态、底部问题与右侧资源所需投影。流式正文、草稿和事件去重水位不会
 * 改变这个对象的身份，因而不会让整个工作区随每个 delta commit。
 */
export function createSessionWorkspaceStateSelector(): StateSelector {
  let previousResourceItems: NativeSessionState['items'] = emptyItems;
  let previous: NativeSessionState | null = null;
  return (state) => {
    previousResourceItems = projectResourceItems(state.items, previousResourceItems);
    const next: NativeSessionState = {
      ...state,
      items: previousResourceItems,
      itemOrder: emptyItemOrder,
      seenEventIds: emptySeenEvents,
      lastSequenceByGeneration: emptySequences,
      lastEventId: null,
      draft: '',
      attachments: emptyAttachments,
      browserSubmission: null,
      transcriptRevision: 0,
      feedbackEpoch: 0,
      visibleFeedbackEpoch: 0,
    };
    if (previous && shallowStateEqual(previous, next)) return previous;
    previous = next;
    return next;
  };
}

/** 会话正文仅订阅可见历史、轮次、请求、分页游标、批注与正文错误。 */
export function createConversationTranscriptStateSelector(): StateSelector {
  return cachedSelector((state) => ({
    ...state,
    providerSettings: null,
    tokenUsage: null,
    unifiedUsage: null,
    sessionMetrics: null,
    rateLimits: null,
    mcpStartup: null,
    seenEventIds: emptySeenEvents,
    lastSequenceByGeneration: emptySequences,
    lastEventId: null,
    draft: '',
    attachments: emptyAttachments,
    browserSubmission: null,
    busyOperation: null,
  }));
}

/** 输入区只订阅草稿、附件、运行选择、用量和当前轮次控制字段。 */
export function createConversationComposerStateSelector(): StateSelector {
  return cachedSelector((state) => ({
    ...state,
    turnsByProviderId: emptyTurns,
    changeSetsByProviderId: emptyChangeSets,
    terminalTurnIds: emptyTerminalTurns,
    items: emptyItems,
    itemOrder: emptyItemOrder,
    queue: null,
    pendingRequests: emptyRequests,
    planImplementationRequests: emptyPlanRequests,
    tokenUsage: null,
    sessionMetrics: null,
    rateLimits: null,
    mcpStartup: null,
    seenEventIds: emptySeenEvents,
    lastSequenceByGeneration: emptySequences,
    lastEventId: null,
    transcriptRevision: 0,
    feedbackEpoch: 0,
    visibleFeedbackEpoch: 0,
    error: null,
  }));
}

/** 排队卡片订阅权威队列、本地待接纳消息和操作闸机，不随正文流、草稿或附件变化重绘。 */
export function createConversationQueueStateSelector(): StateSelector {
  /** 上次投影保留引用，正文流式更新时避免排队区空重绘。 */
  let previousProjection: Pick<NativeSessionState, 'items' | 'itemOrder'> = { items: emptyItems, itemOrder: emptyItemOrder };
  /** 原消息顺序未变时无需重复扫描完整历史。 */
  let previousSourceItemOrder: NativeSessionState['itemOrder'] = emptyItemOrder;
  /** 候选只包含少量 optimistic 用户消息，流式正文更新仅核对这些条目。 */
  let candidateKeys: NativeSessionState['itemOrder'] = emptyItemOrder;
  return cachedSelector((state) => {
    if (state.itemOrder !== previousSourceItemOrder) {
      previousSourceItemOrder = state.itemOrder;
      candidateKeys = state.itemOrder.filter((key) => {
        /** optimistic 用户消息可能在重试或接纳时改变排队状态。 */
        const item = state.items[key];
        return item?.optimistic === true && item.type === 'userMessage';
      });
    }
    previousProjection = projectQueuedItems(state.items, candidateKeys, previousProjection);
    return {
      ...state,
      turnsByProviderId: emptyTurns,
      changeSetsByProviderId: emptyChangeSets,
      terminalTurnIds: emptyTerminalTurns,
      items: previousProjection.items,
      itemOrder: previousProjection.itemOrder,
      pendingRequests: emptyRequests,
      planImplementationRequests: emptyPlanRequests,
      providerSettings: null,
      tokenUsage: null,
      unifiedUsage: null,
      sessionMetrics: null,
      rateLimits: null,
      mcpStartup: null,
      seenEventIds: emptySeenEvents,
      lastSequenceByGeneration: emptySequences,
      lastEventId: null,
      draft: '',
      attachments: emptyAttachments,
      browserSubmission: null,
      contextDraft: emptyConversationContextDraft,
      transcriptRevision: 0,
      feedbackEpoch: 0,
      visibleFeedbackEpoch: 0,
      error: null,
    };
  });
}

/** 仅保留输入框排队卡片需要的本地乐观消息，并在内容未变时复用旧投影。 */
function projectQueuedItems(items: NativeSessionState['items'], candidateKeys: NativeSessionState['itemOrder'], previous: Pick<NativeSessionState, 'items' | 'itemOrder'>): Pick<NativeSessionState, 'items' | 'itemOrder'> {
  /** 排队消息按现有时间线顺序筛选，不能让对象枚举顺序改变卡片位置。 */
  const nextEntries = candidateKeys.flatMap((key): Array<[string, NativeSessionItemBuffer]> => {
    /** 只有活跃轮次后的普通本地发送会进入输入框排队区。 */
    const item = items[key];
    return item && itemNeededByComposerQueue(item) ? [[key, item]] : [];
  });
  /** 引用和顺序都未变化时返回旧投影，隔离无关正文增量。 */
  const previousEntries = Object.entries(previous.items);
  if (nextEntries.length === previousEntries.length && nextEntries.every(([key, item], index) => previousEntries[index]?.[0] === key && previousEntries[index]?.[1] === item)) return previous;
  return { items: Object.fromEntries(nextEntries), itemOrder: nextEntries.map(([key]) => key) };
}

/** 判断条目是否属于输入框排队区需要即时展示的本地消息。 */
function itemNeededByComposerQueue(item: NativeSessionItemBuffer): boolean {
  return item.optimistic === true && item.type === 'userMessage' && item.payload.delivery === 'queue' && item.payload.queuedForActiveTurn === true && (item.status === 'pending' || item.status === 'queued');
}

function cachedSelector(project: (state: NativeSessionState) => NativeSessionState): StateSelector {
  let previous: NativeSessionState | null = null;
  return (state) => {
    const next = project(state);
    if (previous && shallowStateEqual(previous, next)) return previous;
    previous = next;
    return next;
  };
}

function shallowStateEqual(left: NativeSessionState, right: NativeSessionState): boolean {
  for (const key of Object.keys(left) as Array<keyof NativeSessionState>) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}

function projectResourceItems(items: NativeSessionState['items'], previous: NativeSessionState['items']): NativeSessionState['items'] {
  const nextEntries = Object.entries(items).filter(([, item]) => itemNeededByWorkspaceResourcePanels(item));
  const previousEntries = Object.entries(previous);
  if (nextEntries.length === previousEntries.length && nextEntries.every(([key, item], index) => previousEntries[index]?.[0] === key && previousEntries[index]?.[1] === item)) return previous;
  return Object.fromEntries(nextEntries);
}

function itemNeededByWorkspaceResourcePanels(item: NativeSessionItemBuffer): boolean {
  const payloadType = typeof item.payload.type === 'string' ? item.payload.type : item.type;
  const normalizedType = payloadType.toLocaleLowerCase().replaceAll(/[^a-z]/gu, '');
  const recoveredUserInput = normalizedType === 'requestuserinput' && item.payload.recovery === 'content_only' && item.payload.outcome === 'pending';
  /** 底部问题只需要完整题目、答复状态与最终交付边界，不订阅流式正文。 */
  const questionControlItem =
    Boolean(item.payload.questionAnswer) || (item.status === 'completed' && ['agentmessage', 'assistantmessage', 'assistant', 'message'].includes(normalizedType) && classifyAssistantMessage(item.payload, item.phase) !== 'progress');
  return questionControlItem || recoveredUserInput || normalizedType === 'subagentactivity' || normalizedType === 'collabagenttoolcall' || normalizedType === 'filechange';
}
