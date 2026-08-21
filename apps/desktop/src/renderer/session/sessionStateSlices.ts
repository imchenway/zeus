import { emptyConversationContextDraft } from '@zeus/shared';
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
 * 工作区壳只保留控制、运行态与右侧资源所需投影。流式正文、草稿和事件去重水位不会
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
    planImplementationRequests: emptyPlanRequests,
    providerSettings: null,
    tokenUsage: null,
    unifiedUsage: null,
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

/** 队列区只订阅权威队列、当前轮次、传输/会话状态与操作忙碌态。 */
export function createConversationQueueStateSelector(): StateSelector {
  return cachedSelector((state) => ({
    ...state,
    turnsByProviderId: emptyTurns,
    changeSetsByProviderId: emptyChangeSets,
    terminalTurnIds: emptyTerminalTurns,
    items: emptyItems,
    itemOrder: emptyItemOrder,
    pendingRequests: emptyRequests,
    planImplementationRequests: emptyPlanRequests,
    providerSettings: null,
    tokenUsage: null,
    unifiedUsage: null,
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
  }));
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
  return item.type === 'plan' || normalizedType === 'subagentactivity' || normalizedType === 'collabagenttoolcall' || normalizedType === 'filechange';
}
