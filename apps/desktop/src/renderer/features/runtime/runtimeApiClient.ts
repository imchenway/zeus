import type {
  AiRuntimeAdapterDescriptor,
  AiRuntimeAdapterStatus,
  AiRuntimeLogEntry,
  AiRuntimeSession,
  AiRuntimeTerminalSnapshot,
  CreateRuntimeConfirmationRequest,
  CreateTaskFromRuntimeSessionRequest,
  LoadRuntimeLogsRequest,
  LoadRuntimeSessionsRequest,
  LoadRuntimeTerminalEventsRequest,
  RuntimeLogPage,
  RuntimeOperationConfirmation,
  RuntimeStatusSnapshot,
  RuntimeTerminalEventPage,
  StartRuntimeSessionRequest,
} from './runtimeContracts.js';
import type { TaskRecord } from '../tasks/taskContracts.js';
import { buildRuntimeSessionCommandRequest, RuntimeEphemeralCapabilityClient, runtimeSessionClientCommandTypes } from './runtimeSessionCommandClient.js';
import type { LocalApiTransport } from '../../transport/localApiTransport.js';

export interface RuntimeApiClient {
  loadRuntimeStatus: () => Promise<RuntimeStatusSnapshot>;
  loadRuntimeAdapters: () => Promise<AiRuntimeAdapterDescriptor[]>;
  checkRuntimeAdapter: (adapterId: string) => Promise<AiRuntimeAdapterStatus>;
  loadRuntimeSessions: (input?: LoadRuntimeSessionsRequest) => Promise<AiRuntimeSession[]>;
  createRuntimeConfirmation: (input: CreateRuntimeConfirmationRequest) => Promise<RuntimeOperationConfirmation>;
  confirmRuntimeOperation: (confirmationId: string) => Promise<RuntimeOperationConfirmation>;
  rejectRuntimeOperation: (confirmationId: string, reason?: string) => Promise<RuntimeOperationConfirmation>;
  startRuntimeSession: (input: StartRuntimeSessionRequest) => Promise<AiRuntimeSession>;
  stopRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  loadRuntimeSessionLogs: (sessionId: string) => Promise<AiRuntimeLogEntry[]>;
  loadRuntimeSessionLogsPage: (sessionId: string, input?: LoadRuntimeLogsRequest) => Promise<RuntimeLogPage>;
  sendRuntimeInput: (sessionId: string, input: string) => Promise<AiRuntimeSession>;
  interruptRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  resizeRuntimeSession: (sessionId: string, size: { cols: number; rows: number }) => Promise<AiRuntimeSession>;
  loadRuntimeTerminalSnapshot: (sessionId: string) => Promise<AiRuntimeTerminalSnapshot>;
  loadRuntimeTerminalEvents: (sessionId: string, input?: LoadRuntimeTerminalEventsRequest) => Promise<RuntimeTerminalEventPage>;
  generateRuntimeSessionSummary: (sessionId: string) => Promise<AiRuntimeSession>;
  setRuntimeSessionFavorite: (sessionId: string, favorite: boolean) => Promise<AiRuntimeSession>;
  archiveRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  restoreRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  deleteRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  createTaskFromRuntimeSession: (sessionId: string, input: CreateTaskFromRuntimeSessionRequest) => Promise<TaskRecord>;
}

export function createRuntimeApiClient(transport: LocalApiTransport): RuntimeApiClient {
  const runtimeEphemeral = new RuntimeEphemeralCapabilityClient(transport);

  return {
    loadRuntimeStatus: () => transport.request<RuntimeStatusSnapshot>('/api/settings/runtime-status'),
    loadRuntimeAdapters: () => transport.request<AiRuntimeAdapterDescriptor[]>('/api/runtime/adapters'),
    checkRuntimeAdapter: (adapterId) => transport.request<AiRuntimeAdapterStatus>(`/api/runtime/adapters/${adapterId}/check`),
    loadRuntimeSessions: (input) => transport.request<AiRuntimeSession[]>(`/api/runtime/sessions${toRuntimeSessionQuery(input)}`),
    createRuntimeConfirmation: async (input) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.confirmationCreate,
        scopeKind: 'approval',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'runtime_confirmation_',
        value: input,
      });
      return transport.request<RuntimeOperationConfirmation>('/api/runtime/confirmations', { method: 'POST', body: JSON.stringify(body) });
    },
    confirmRuntimeOperation: async (confirmationId) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.confirmationConfirm,
        scopeKind: 'approval',
        scopeId: () => confirmationId,
        operationPrefix: 'runtime_confirmation_confirm_',
        value: {},
      });
      return transport.request<RuntimeOperationConfirmation>(`/api/runtime/confirmations/${encodeURIComponent(confirmationId)}/confirm`, { method: 'POST', body: JSON.stringify(body) });
    },
    rejectRuntimeOperation: async (confirmationId, reason) => {
      const input = reason === undefined ? {} : { reason };
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.confirmationReject,
        scopeKind: 'approval',
        scopeId: () => confirmationId,
        operationPrefix: 'runtime_confirmation_reject_',
        value: input,
      });
      return transport.request<RuntimeOperationConfirmation>(`/api/runtime/confirmations/${encodeURIComponent(confirmationId)}/reject`, { method: 'POST', body: JSON.stringify(body) });
    },
    startRuntimeSession: async (input) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.sessionStart,
        scopeKind: 'runtime_segment',
        scopeId: (operationIdentity) => operationIdentity,
        operationPrefix: 'runtime_session_',
        value: input,
      });
      return transport.request<AiRuntimeSession>('/api/runtime/sessions', { method: 'POST', body: JSON.stringify(body) });
    },
    stopRuntimeSession: async (sessionId) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.sessionStop,
        scopeKind: 'runtime_segment',
        scopeId: () => sessionId,
        operationPrefix: 'runtime_session_stop_',
        value: {},
      });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST', body: JSON.stringify(body) });
    },
    loadRuntimeSessionLogs: (sessionId) => transport.request<AiRuntimeLogEntry[]>(`/api/runtime/sessions/${sessionId}/logs`),
    loadRuntimeSessionLogsPage: (sessionId, input) => transport.request<RuntimeLogPage>(`/api/runtime/sessions/${sessionId}/logs${toRuntimeLogQuery(input)}`),
    sendRuntimeInput: (sessionId, input) => runtimeEphemeral.send(sessionId, 'input', { input }),
    interruptRuntimeSession: async (sessionId) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.sessionInterrupt,
        scopeKind: 'runtime_segment',
        scopeId: () => sessionId,
        operationPrefix: 'runtime_session_interrupt_',
        value: {},
      });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/interrupt`, { method: 'POST', body: JSON.stringify(body) });
    },
    resizeRuntimeSession: (sessionId, size) => runtimeEphemeral.send(sessionId, 'resize', size),
    loadRuntimeTerminalSnapshot: (sessionId) => transport.request<AiRuntimeTerminalSnapshot>(`/api/runtime/sessions/${sessionId}/terminal`),
    loadRuntimeTerminalEvents: (sessionId, input) => transport.request<RuntimeTerminalEventPage>(`/api/runtime/sessions/${sessionId}/terminal/events${toTerminalEventQuery(input)}`),
    generateRuntimeSessionSummary: async (sessionId) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.sessionSummaryGenerate,
        scopeKind: 'runtime_segment',
        scopeId: () => sessionId,
        operationPrefix: 'runtime_session_summary_',
        value: {},
      });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/summary`, { method: 'POST', body: JSON.stringify(body) });
    },
    setRuntimeSessionFavorite: async (sessionId, favorite) => {
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.sessionFavoriteSet,
        scopeKind: 'runtime_segment',
        scopeId: () => sessionId,
        operationPrefix: 'runtime_session_favorite_',
        value: { favorite },
      });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/favorite`, { method: 'PUT', body: JSON.stringify(body) });
    },
    archiveRuntimeSession: async (sessionId) => {
      const body = await buildRuntimeSessionCommandRequest({ commandType: runtimeSessionClientCommandTypes.sessionArchive, scopeKind: 'runtime_segment', scopeId: () => sessionId, operationPrefix: 'runtime_session_archive_', value: {} });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/archive`, { method: 'POST', body: JSON.stringify(body) });
    },
    restoreRuntimeSession: async (sessionId) => {
      const body = await buildRuntimeSessionCommandRequest({ commandType: runtimeSessionClientCommandTypes.sessionRestore, scopeKind: 'runtime_segment', scopeId: () => sessionId, operationPrefix: 'runtime_session_restore_', value: {} });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/restore`, { method: 'POST', body: JSON.stringify(body) });
    },
    deleteRuntimeSession: async (sessionId) => {
      const body = await buildRuntimeSessionCommandRequest({ commandType: runtimeSessionClientCommandTypes.sessionDelete, scopeKind: 'runtime_segment', scopeId: () => sessionId, operationPrefix: 'runtime_session_delete_', value: {} });
      return transport.request<AiRuntimeSession>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', body: JSON.stringify(body) });
    },
    createTaskFromRuntimeSession: async (sessionId, input) => {
      const { idempotencyKey, ...value } = input;
      const body = await buildRuntimeSessionCommandRequest({
        commandType: runtimeSessionClientCommandTypes.sessionTaskCreate,
        scopeKind: 'runtime_segment',
        scopeId: () => sessionId,
        operationPrefix: 'task_',
        operationSeed: idempotencyKey,
        value,
      });
      return transport.request<TaskRecord>(`/api/runtime/sessions/${encodeURIComponent(sessionId)}/tasks`, { method: 'POST', body: JSON.stringify(body) });
    },
  };
}

function toRuntimeSessionQuery(input?: LoadRuntimeSessionsRequest): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (input?.projectId) params.set('projectId', input.projectId);
  if (input?.taskId) params.set('taskId', input.taskId);
  if (input?.archived) params.set('archived', 'true');
  if (input?.favoriteOnly) params.set('favoriteOnly', 'true');
  const query = params.toString();
  return query ? '?' + query : '';
}

function toRuntimeLogQuery(input?: LoadRuntimeLogsRequest): string {
  const params = new URLSearchParams();
  if (input?.query) params.set('query', input.query);
  if (input?.stream) params.set('stream', input.stream);
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  if (typeof input?.offset === 'number') params.set('offset', String(input.offset));
  const query = params.toString();
  return query ? '?' + query : '?limit=200';
}

function toTerminalEventQuery(input?: LoadRuntimeTerminalEventsRequest): string {
  const params = new URLSearchParams();
  if (typeof input?.limit === 'number') params.set('limit', String(input.limit));
  if (typeof input?.offset === 'number') params.set('offset', String(input.offset));
  const query = params.toString();
  return query ? '?' + query : '?limit=200';
}
