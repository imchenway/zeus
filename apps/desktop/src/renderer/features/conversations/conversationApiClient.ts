import type {
  ArchivedConversationChoicesSnapshot,
  CodexConversationCapabilities,
  ConversationResourcePreview,
  NativeCollaborationMode,
  NativeConversationChangeFileV2Item,
  NativeConversationChangeSetV2Summary,
  NativeConversationChoice,
  NativeConversationChoicesSnapshot,
  NativeConversationContentV2Page,
  NativeConversationEventPage,
  NativeConversationModelHistoryV2Item,
  NativeConversationProcessV2Item,
  NativeConversationResourceV2Item,
  NativeConversationSnapshotV2,
  NativeConversationSnapshotV2Page,
  NativeConversationToolResultPage,
  NativeGoalResponse,
  NativeNextTurnSettings,
  NativeOperationAcceptance,
  NativePendingRequest,
  NativePermissionMode,
  NativePlanImplementationRequest,
  NativeProjectConversationChoicesSnapshot,
  NativeQueueSnapshot,
  NativeSubagentListSnapshot,
  NativeSubagentThreadSnapshot,
  SendNativeMessageRequest,
  StartNativeConversationRequest,
  StartProjectConversationRequest,
  TurnChangeSet,
  TurnChangeSetOperationResult,
} from '../../session/sessionTypes.js';
import type { GraphConversationHistoryItem } from '../graph/graphContracts.js';
import type { ZeusRealtimeEvent } from '../../transport/dashboardClientContracts.js';
import type { NativeProjectConversationChoiceGroupsSnapshot } from './conversationContracts.js';
import { jsonRequest, type LocalApiTransport } from '../../transport/localApiTransport.js';
import { buildConversationCommandRequest, conversationClientCommandTypes } from './conversationCommandClient.js';
import { buildConversationDispatchCommandRequest, conversationDispatchClientCommandTypes } from './conversationDispatchCommandClient.js';
import { buildGraphConversationCommandRequest, graphConversationClientCommandTypes } from './graphConversationCommandClient.js';

export interface ConversationApiClient {
  loadArchivedConversations: () => Promise<ArchivedConversationChoicesSnapshot>;
  loadProjectConversationChoices: (projectId: string) => Promise<NativeProjectConversationChoicesSnapshot>;
  loadProjectConversationChoiceGroups: (projectId: string) => Promise<NativeProjectConversationChoiceGroupsSnapshot>;
  startProjectConversation: (projectId: string, input: StartProjectConversationRequest) => Promise<NativeOperationAcceptance>;
  loadTaskConversationChoices: (taskId: string) => Promise<NativeConversationChoicesSnapshot>;
  loadCodexConversationCapabilities: (projectId: string) => Promise<CodexConversationCapabilities>;
  startNativeConversation: (taskId: string, input: StartNativeConversationRequest) => Promise<NativeOperationAcceptance>;
  loadNativeConversationV2: (projectId: string, conversationId: string) => Promise<NativeConversationSnapshotV2>;
  loadNativeConversationModelHistoryV2: (
    projectId: string,
    conversationId: string,
    options?: { cursor?: string; limit?: number; byteLimit?: number; direction?: 'forward' | 'tail' },
  ) => Promise<NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>>;
  loadNativeConversationProcessV2: (
    projectId: string,
    conversationId: string,
    turnId: string,
    options?: { cursor?: string; limit?: number; byteLimit?: number; kind?: NativeConversationProcessV2Item['kind'] },
  ) => Promise<NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>>;
  loadNativeConversationResourcesV2: (projectId: string, conversationId: string, options?: { cursor?: string; limit?: number; byteLimit?: number }) => Promise<NativeConversationSnapshotV2Page<NativeConversationResourceV2Item>>;
  loadNativeConversationChangeSetV2: (projectId: string, conversationId: string, turnId: string) => Promise<NativeConversationChangeSetV2Summary>;
  loadNativeConversationChangeFilesV2: (
    projectId: string,
    conversationId: string,
    turnId: string,
    changeSetId: string,
    options?: { cursor?: string; limit?: number; byteLimit?: number },
  ) => Promise<NativeConversationSnapshotV2Page<NativeConversationChangeFileV2Item>>;
  loadNativeConversationContentV2: (projectId: string, conversationId: string, handle: string, options?: { offset?: number; byteLimit?: number }) => Promise<NativeConversationContentV2Page>;
  loadNativeConversationToolResult: (projectId: string, conversationId: string, handle: string, options?: { offset?: number; limit?: number }) => Promise<NativeConversationToolResultPage>;
  loadNativeConversationQueueV2: (projectId: string, conversationId: string) => Promise<NativeQueueSnapshot>;
  loadNativeConversationEvents: (projectId: string, conversationId: string, options: { afterSequence: number; limit?: number; byteLimit?: number; syncStreamGeneration?: string }) => Promise<NativeConversationEventPage>;
  loadNativePendingRequests: (projectId: string, conversationId: string) => Promise<{ conversationId: string; requests: NativePendingRequest[] }>;
  loadNativeSubagents: (projectId: string, conversationId: string) => Promise<NativeSubagentListSnapshot>;
  loadNativeSubagentThread: (projectId: string, conversationId: string, threadId: string) => Promise<NativeSubagentThreadSnapshot>;
  loadNativeConversationChoice: (projectId: string, conversationId: string) => Promise<NativeConversationChoice>;
  archiveNativeConversation: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  restoreConversationArchive: (projectId: string, conversationId: string) => Promise<GraphConversationHistoryItem>;
  loadConversationResourcePreview: (projectId: string, conversationId: string, resourceId: string) => Promise<ConversationResourcePreview>;
  loadTurnChangeFilePreview: (projectId: string, conversationId: string, turnId: string, changeSetId: string, fileId: string) => Promise<ConversationResourcePreview>;
  loadTurnChangeSet: (projectId: string, conversationId: string, turnId: string) => Promise<TurnChangeSet>;
  operateTurnChangeSet: (
    projectId: string,
    conversationId: string,
    turnId: string,
    action: 'undo' | 'reapply',
    input: { changeSetId: string; expectedState: 'applied' | 'undone'; idempotencyKey: string },
  ) => Promise<TurnChangeSetOperationResult>;
  acknowledgeNativeConversationAttention: (projectId: string, conversationId: string, expectedRevision: number) => Promise<{ acknowledged: boolean; conversation: NativeConversationChoice }>;
  restoreArchivedNativeConversation: (projectId: string, conversationId: string) => Promise<{ acknowledged: true }>;
  updateNativePermissionMode: (projectId: string, conversationId: string, permissionMode: NativePermissionMode) => Promise<{ acknowledged: true }>;
  updateNativeCollaborationMode: (projectId: string, conversationId: string, collaborationMode: NativeCollaborationMode) => Promise<{ acknowledged: true }>;
  loadNativeGoal: (projectId: string, conversationId: string) => Promise<NativeGoalResponse>;
  setNativeGoal: (projectId: string, conversationId: string, objective: string) => Promise<NativeGoalResponse>;
  pauseNativeGoal: (projectId: string, conversationId: string) => Promise<NativeGoalResponse>;
  resumeNativeGoal: (projectId: string, conversationId: string) => Promise<NativeGoalResponse>;
  clearNativeGoal: (projectId: string, conversationId: string, confirmUnfinished: boolean) => Promise<NativeGoalResponse & { cleared: boolean }>;
  updateNativeNextTurnSettings: (projectId: string, conversationId: string, settings: NativeNextTurnSettings) => Promise<NativeNextTurnSettings>;
  sendNativeMessage: (projectId: string, conversationId: string, input: SendNativeMessageRequest) => Promise<NativeOperationAcceptance>;
  askNativeSideChat: (projectId: string, conversationId: string, input: { selectedText: string; question: string }) => Promise<{ answer: string; status: 'completed' | 'interrupted' }>;
  editNativeQueuedSubmission: (projectId: string, conversationId: string, submissionId: string, content: string) => Promise<NativeQueueSnapshot>;
  retryNativeQueuedSubmission: (projectId: string, conversationId: string, submissionId: string) => Promise<NativeQueueSnapshot>;
  rerouteNativeQueuedSubmission: (projectId: string, conversationId: string, submissionId: string, settings: NativeNextTurnSettings) => Promise<NativeQueueSnapshot>;
  deleteNativeQueuedSubmission: (projectId: string, conversationId: string, submissionId: string) => Promise<NativeQueueSnapshot>;
  sendNativeQueuedNow: (projectId: string, conversationId: string, submissionId: string) => Promise<NativeOperationAcceptance>;
  interruptNativeTurn: (projectId: string, conversationId: string, turnId: string) => Promise<NativeOperationAcceptance>;
  respondToNativeRequest: (projectId: string, conversationId: string, requestId: string, response: Record<string, unknown>) => Promise<{ operation: Record<string, unknown>; request: NativePendingRequest }>;
  snoozeNativeRequest: (
    projectId: string,
    conversationId: string,
    requestId: string,
  ) => Promise<{
    request: NativePendingRequest;
  }>;
  respondToPlanImplementationRequest: (
    projectId: string,
    conversationId: string,
    requestId: string,
    input: { action: 'implement' | 'refine' | 'dismiss'; feedback?: string },
  ) => Promise<{
    operation: NativeOperationAcceptance['operation'];
    request: NativePlanImplementationRequest;
    acknowledged: true;
  }>;
  resumeNativeQueue: (projectId: string, conversationId: string) => Promise<NativeQueueSnapshot>;
  recoverNativeQueue: (projectId: string, conversationId: string) => Promise<NativeQueueSnapshot>;
  reorderNativeQueue: (projectId: string, conversationId: string, orderedSubmissionIds: string[]) => Promise<NativeQueueSnapshot>;
  connectEvents: (onEvent: (event: ZeusRealtimeEvent) => void, options?: { afterEventId?: string; conversationId?: string; afterSequence?: number; syncStreamGeneration?: string }) => WebSocket;
}

export function createConversationApiClient(transport: LocalApiTransport): ConversationApiClient {
  return {
    loadArchivedConversations: () => transport.request<ArchivedConversationChoicesSnapshot>('/api/conversations/archived'),
    loadProjectConversationChoices: (projectId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/conversation-choices`),
    loadProjectConversationChoiceGroups: (projectId) => transport.request(`/api/projects/${encodeURIComponent(projectId)}/conversation-choice-groups`),
    startProjectConversation: async (projectId, input) => {
      const { idempotencyKey, ...body } = input;
      const commandBody = await buildGraphConversationCommandRequest({
        commandType: graphConversationClientCommandTypes.projectConversationCreate,
        scopeKind: 'project',
        scopeId: projectId,
        operationSeed: idempotencyKey,
        reconnectIdentity: idempotencyKey,
        value: body,
      });
      return transport.request<NativeOperationAcceptance>(`${conversationCollectionPath(projectId)}`, {
        ...jsonRequest('POST', commandBody),
      });
    },
    loadTaskConversationChoices: (taskId) => transport.request(`/api/tasks/${encodeURIComponent(taskId)}/conversation-choices`),
    loadCodexConversationCapabilities: async (projectId) => normalizeCapabilities(await transport.request<CodexConversationCapabilities>(`/api/projects/${encodeURIComponent(projectId)}/codex-conversation-capabilities`)),
    startNativeConversation: async (taskId, input) => {
      const { idempotencyKey, ...body } = input;
      const commandBody = await buildGraphConversationCommandRequest({
        commandType: graphConversationClientCommandTypes.taskConversationCreate,
        scopeKind: 'task',
        scopeId: taskId,
        operationSeed: idempotencyKey,
        reconnectIdentity: idempotencyKey,
        value: body,
      });
      return transport.request<NativeOperationAcceptance>(`/api/tasks/${encodeURIComponent(taskId)}/conversations`, {
        ...jsonRequest('POST', commandBody),
      });
    },
    loadNativeConversationV2: (projectId, conversationId) =>
      transport.request<NativeConversationSnapshotV2>(`${conversationPath(projectId, conversationId)}/snapshot-v2`, {
        headers: { 'x-zeus-snapshot-caller': 'renderer-session-v2' },
      }),
    loadNativeConversationModelHistoryV2: (projectId, conversationId, options) =>
      transport.request<NativeConversationSnapshotV2Page<NativeConversationModelHistoryV2Item>>(`${conversationPath(projectId, conversationId)}/model-history${pageQuery(options)}`),
    loadNativeConversationProcessV2: (projectId, conversationId, turnId, options) =>
      transport.request<NativeConversationSnapshotV2Page<NativeConversationProcessV2Item>>(`${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/process${pageQuery(options)}`),
    loadNativeConversationResourcesV2: (projectId, conversationId, options) =>
      transport.request<NativeConversationSnapshotV2Page<NativeConversationResourceV2Item>>(`${conversationPath(projectId, conversationId)}/resources/page${pageQuery(options)}`),
    loadNativeConversationChangeSetV2: (projectId, conversationId, turnId) => transport.request<NativeConversationChangeSetV2Summary>(`${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/summary`),
    loadNativeConversationChangeFilesV2: (projectId, conversationId, turnId, changeSetId, options) =>
      transport.request<NativeConversationSnapshotV2Page<NativeConversationChangeFileV2Item>>(
        `${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/${encodeURIComponent(changeSetId)}/files${pageQuery(options)}`,
      ),
    loadNativeConversationContentV2: (projectId, conversationId, handle, options) => transport.request<NativeConversationContentV2Page>(`${conversationPath(projectId, conversationId)}/content${contentQuery(handle, options)}`),
    loadNativeConversationToolResult: (projectId, conversationId, handle, options) => transport.request<NativeConversationToolResultPage>(`${conversationPath(projectId, conversationId)}/tool-results${toolResultQuery(handle, options)}`),
    loadNativeConversationQueueV2: (projectId, conversationId) => transport.request<NativeQueueSnapshot>(`${conversationPath(projectId, conversationId)}/queue-state`),
    loadNativeConversationEvents: (projectId, conversationId, options) => {
      const query = new URLSearchParams({ afterSequence: String(options.afterSequence) });
      if (options.limit !== undefined) query.set('limit', String(options.limit));
      if (options.byteLimit !== undefined) query.set('byteLimit', String(options.byteLimit));
      if (options.syncStreamGeneration) query.set('syncStreamGeneration', options.syncStreamGeneration);
      return transport.request<NativeConversationEventPage>(`${conversationPath(projectId, conversationId)}/events?${query.toString()}`);
    },
    loadNativePendingRequests: (projectId, conversationId) => transport.request<{ conversationId: string; requests: NativePendingRequest[] }>(`${conversationPath(projectId, conversationId)}/pending-requests`),
    loadNativeSubagents: (projectId, conversationId) => transport.request<NativeSubagentListSnapshot>(`${conversationPath(projectId, conversationId)}/subagents`),
    loadNativeSubagentThread: (projectId, conversationId, threadId) => transport.request<NativeSubagentThreadSnapshot>(`${conversationPath(projectId, conversationId)}/subagents/${encodeURIComponent(threadId)}`),
    loadNativeConversationChoice: (projectId, conversationId) => transport.request(`${conversationPath(projectId, conversationId)}/choice`),
    archiveNativeConversation: async (projectId, conversationId) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.archive, conversationId, value: {} });
      return transport.request<GraphConversationHistoryItem>(`${conversationPath(projectId, conversationId)}/archive`, jsonRequest('POST', body));
    },
    restoreConversationArchive: async (projectId, conversationId) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.restore, conversationId, value: {} });
      return transport.request<GraphConversationHistoryItem>(`${conversationPath(projectId, conversationId)}/restore`, jsonRequest('POST', body));
    },
    loadConversationResourcePreview: (projectId, conversationId, resourceId) => transport.request<ConversationResourcePreview>(`${conversationPath(projectId, conversationId)}/resources/${encodeURIComponent(resourceId)}/preview`),
    loadTurnChangeFilePreview: (projectId, conversationId, turnId, changeSetId, fileId) =>
      transport.request<ConversationResourcePreview>(`${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/${encodeURIComponent(changeSetId)}/files/${encodeURIComponent(fileId)}/preview`),
    loadTurnChangeSet: (projectId, conversationId, turnId) => transport.request<TurnChangeSet>(`${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/change-set`),
    operateTurnChangeSet: async (projectId, conversationId, turnId, action, input) => {
      const body = await buildConversationDispatchCommandRequest({
        commandType: action === 'undo' ? conversationDispatchClientCommandTypes.changeSetUndo : conversationDispatchClientCommandTypes.changeSetReapply,
        scopeKind: 'turn',
        scopeId: turnId,
        reconnectIdentity: input.idempotencyKey,
        value: { changeSetId: input.changeSetId, expectedState: input.expectedState },
      });
      return transport.request<TurnChangeSetOperationResult>(`${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/change-set/${action}`, jsonRequest('POST', body));
    },
    acknowledgeNativeConversationAttention: async (projectId, conversationId, expectedRevision) => {
      const body = await buildConversationCommandRequest({
        commandType: conversationClientCommandTypes.attentionAcknowledge,
        conversationId,
        expectedRevision,
        value: { expectedRevision },
      });
      return transport.request(`${conversationPath(projectId, conversationId)}/attention-acknowledgement`, jsonRequest('PUT', body));
    },
    restoreArchivedNativeConversation: async (projectId, conversationId) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.providerThreadRestore, conversationId, value: {} });
      await transport.request<unknown>(`${conversationPath(projectId, conversationId)}/provider-thread/restore`, jsonRequest('POST', body));
      return { acknowledged: true };
    },
    updateNativePermissionMode: async (projectId, conversationId, permissionMode) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.permissionModeUpdate, conversationId, value: { permissionMode } });
      await transport.request<unknown>(`${conversationPath(projectId, conversationId)}/permission-mode`, jsonRequest('PATCH', body));
      return { acknowledged: true };
    },
    updateNativeCollaborationMode: async (projectId, conversationId, collaborationMode) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.collaborationModeUpdate, conversationId, value: { collaborationMode } });
      await transport.request<unknown>(`${conversationPath(projectId, conversationId)}/collaboration-mode`, jsonRequest('PATCH', body));
      return { acknowledged: true };
    },
    loadNativeGoal: (projectId, conversationId) => transport.request<NativeGoalResponse>(`${conversationPath(projectId, conversationId)}/goal`),
    setNativeGoal: async (projectId, conversationId, objective) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.goalSet, conversationId, value: { objective } });
      return transport.request<NativeGoalResponse>(`${conversationPath(projectId, conversationId)}/goal`, jsonRequest('PUT', body));
    },
    pauseNativeGoal: async (projectId, conversationId) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.goalPause, conversationId, value: {} });
      return transport.request<NativeGoalResponse>(`${conversationPath(projectId, conversationId)}/goal/pause`, jsonRequest('POST', body));
    },
    resumeNativeGoal: async (projectId, conversationId) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.goalResume, conversationId, value: {} });
      return transport.request<NativeGoalResponse>(`${conversationPath(projectId, conversationId)}/goal/resume`, jsonRequest('POST', body));
    },
    clearNativeGoal: async (projectId, conversationId, confirmUnfinished) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.goalClear, conversationId, value: { confirmUnfinished } });
      return transport.request<NativeGoalResponse & { cleared: boolean }>(`${conversationPath(projectId, conversationId)}/goal`, jsonRequest('DELETE', body));
    },
    updateNativeNextTurnSettings: async (projectId, conversationId, settings) => {
      const body = await buildConversationCommandRequest({ commandType: conversationClientCommandTypes.nextTurnSettingsUpdate, conversationId, value: settings });
      return transport.request<NativeNextTurnSettings>(`${conversationPath(projectId, conversationId)}/next-turn-settings`, jsonRequest('PATCH', body));
    },
    connectEvents: (onEvent, options) => transport.connectEvents(onEvent, options),
    sendNativeMessage: async (projectId, conversationId, input) => {
      const body = await buildConversationDispatchCommandRequest({
        commandType: conversationDispatchClientCommandTypes.messageSubmit,
        scopeKind: 'product_conversation',
        scopeId: conversationId,
        reconnectIdentity: input.idempotencyKey,
        value: input,
      });
      return transport.request<NativeOperationAcceptance>(`${conversationPath(projectId, conversationId)}/messages`, jsonRequest('POST', body));
    },
    askNativeSideChat: async (projectId, conversationId, input) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.sideChatAsk, scopeKind: 'product_conversation', scopeId: conversationId, value: input });
      return transport.request(`${conversationPath(projectId, conversationId)}/side-chat`, jsonRequest('POST', body));
    },
    editNativeQueuedSubmission: async (projectId, conversationId, submissionId, content) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueUpdate, scopeKind: 'submission', scopeId: submissionId, value: { content } });
      return transport.request<NativeQueueSnapshot>(queueSubmissionPath(projectId, conversationId, submissionId), jsonRequest('PATCH', body));
    },
    retryNativeQueuedSubmission: async (projectId, conversationId, submissionId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueRetry, scopeKind: 'submission', scopeId: submissionId, value: {} });
      return transport.request<NativeQueueSnapshot>(`${queueSubmissionPath(projectId, conversationId, submissionId)}/retry`, jsonRequest('POST', body));
    },
    rerouteNativeQueuedSubmission: async (projectId, conversationId, submissionId, settings) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueReroute, scopeKind: 'submission', scopeId: submissionId, value: settings });
      return transport.request<NativeQueueSnapshot>(`${queueSubmissionPath(projectId, conversationId, submissionId)}/reroute`, jsonRequest('POST', body));
    },
    deleteNativeQueuedSubmission: async (projectId, conversationId, submissionId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueDelete, scopeKind: 'submission', scopeId: submissionId, value: {} });
      return transport.request<NativeQueueSnapshot>(queueSubmissionPath(projectId, conversationId, submissionId), jsonRequest('DELETE', body));
    },
    sendNativeQueuedNow: async (projectId, conversationId, submissionId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueSendNow, scopeKind: 'submission', scopeId: submissionId, value: {} });
      return transport.request<NativeOperationAcceptance>(`${queueSubmissionPath(projectId, conversationId, submissionId)}/send-now`, jsonRequest('POST', body));
    },
    interruptNativeTurn: async (projectId, conversationId, turnId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.turnInterrupt, scopeKind: 'turn', scopeId: turnId, value: {} });
      return transport.request<NativeOperationAcceptance>(`${conversationPath(projectId, conversationId)}/turns/${encodeURIComponent(turnId)}/interrupt`, jsonRequest('POST', body));
    },
    respondToNativeRequest: async (projectId, conversationId, requestId, response) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.serverRequestRespond, scopeKind: 'approval', scopeId: requestId, value: response });
      return transport.request<{ operation: Record<string, unknown>; request: NativePendingRequest }>(`${conversationPath(projectId, conversationId)}/requests/${encodeURIComponent(requestId)}/respond`, jsonRequest('POST', body));
    },
    snoozeNativeRequest: async (projectId, conversationId, requestId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.requestSnooze, scopeKind: 'approval', scopeId: requestId, value: {} });
      return transport.request<{ request: NativePendingRequest }>(`${conversationPath(projectId, conversationId)}/requests/${encodeURIComponent(requestId)}/snooze`, jsonRequest('POST', body));
    },
    respondToPlanImplementationRequest: async (projectId, conversationId, requestId, input) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.planImplementationRespond, scopeKind: 'approval', scopeId: requestId, value: input });
      const result = await transport.request<{ operation: NativeOperationAcceptance['operation']; request: NativePlanImplementationRequest }>(
        `${conversationPath(projectId, conversationId)}/plan-implementation-requests/${encodeURIComponent(requestId)}/respond`,
        jsonRequest('POST', body),
      );
      return { operation: result.operation, request: result.request, acknowledged: true };
    },
    resumeNativeQueue: async (projectId, conversationId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueResume, scopeKind: 'product_conversation', scopeId: conversationId, value: {} });
      return transport.request<NativeQueueSnapshot>(`${conversationPath(projectId, conversationId)}/queue/resume`, jsonRequest('POST', body));
    },
    recoverNativeQueue: async (projectId, conversationId) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueRecover, scopeKind: 'product_conversation', scopeId: conversationId, value: {} });
      return transport.request<NativeQueueSnapshot>(`${conversationPath(projectId, conversationId)}/queue/recover`, jsonRequest('POST', body));
    },
    reorderNativeQueue: async (projectId, conversationId, orderedSubmissionIds) => {
      const body = await buildConversationDispatchCommandRequest({ commandType: conversationDispatchClientCommandTypes.queueReorder, scopeKind: 'product_conversation', scopeId: conversationId, value: { orderedSubmissionIds } });
      return transport.request<NativeQueueSnapshot>(`${conversationPath(projectId, conversationId)}/queue/reorder`, jsonRequest('POST', body));
    },
  };
}

function conversationCollectionPath(projectId: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/conversations`;
}

function conversationPath(projectId: string, conversationId: string): string {
  return `${conversationCollectionPath(projectId)}/${encodeURIComponent(conversationId)}`;
}

function queueSubmissionPath(projectId: string, conversationId: string, submissionId: string): string {
  return `${conversationPath(projectId, conversationId)}/queue/${encodeURIComponent(submissionId)}`;
}

function pageQuery(options?: { cursor?: string; limit?: number; byteLimit?: number; direction?: 'forward' | 'tail'; kind?: string }): string {
  if (!options) return '';
  const query = new URLSearchParams();
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.byteLimit !== undefined) query.set('byteLimit', String(options.byteLimit));
  if (options.direction) query.set('direction', options.direction);
  if (options.kind) query.set('kind', options.kind);
  return query.size > 0 ? `?${query.toString()}` : '';
}

function contentQuery(handle: string, options?: { offset?: number; byteLimit?: number }): string {
  const query = new URLSearchParams({ handle });
  if (options?.offset !== undefined) query.set('offset', String(options.offset));
  if (options?.byteLimit !== undefined) query.set('byteLimit', String(options.byteLimit));
  return `?${query.toString()}`;
}

function toolResultQuery(handle: string, options?: { offset?: number; limit?: number }): string {
  const query = new URLSearchParams({ handle });
  if (options?.offset !== undefined) query.set('offset', String(options.offset));
  if (options?.limit !== undefined) query.set('limit', String(options.limit));
  return `?${query.toString()}`;
}

function normalizeCapabilities(capabilities: CodexConversationCapabilities): CodexConversationCapabilities {
  if (capabilities.goals && typeof capabilities.goals.supported === 'boolean' && typeof capabilities.goals.enabled === 'boolean') return capabilities;
  return { ...capabilities, goals: { supported: false, enabled: false, stage: null } };
}
