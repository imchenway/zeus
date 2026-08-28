import { createHash } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { nanoid } from 'nanoid';
import { type CodexUsageEstimate, type ConversationResourceKind, type ConversationResourcePresentation, type TokenUsageBreakdown } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import type { ConversationAgentKind } from './conversationItemTypes.js';

function nowIso(): string {
  return new Date().toISOString();
}

export interface ZeusConversationRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  workspaceId: string | null;
  environmentId: string | null;
  sessionId: string | null;
  title: string;
  summary: string | null;
  status: string;
  stage: ConversationStage;
  stageUpdatedAt: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  transportKind: ConversationTransportKind;
  providerId: string | null;
  providerThreadId: string | null;
  providerThreadPath: string | null;
  providerModel: string | null;
  providerState: ConversationProviderState;
  providerProtocolVersion: string | null;
  providerBinaryVersion: string | null;
  legacySourceConversationId: string | null;
  providerSettingsJson: string;
  providerTokenUsageJson: string;
  permissionMode: ConversationPermissionMode;
  collaborationMode: ConversationCollaborationMode;
  nextTurnSettingsJson: string;
  attentionUnread: boolean;
  attentionKind: ConversationAttentionKind;
  attentionRevision: number;
  attentionTurnId: string | null;
  attentionUpdatedAt: string | null;
  agentKind: ConversationAgentKind | null;
  agentTransport: ConversationAgentTransport | null;
  modelSourceId: string | null;
  modelId: string | null;
  nativeSessionId: string | null;
  nativeSessionPath: string | null;
  capabilitySnapshotId: string | null;
}

export type ConversationTransportKind = 'legacy_cli' | 'codex_native';
export type ConversationStage = 'created' | 'connecting' | 'queued' | 'running' | 'waiting_user' | 'waiting_approval' | 'completed' | 'failed' | 'paused' | 'ready' | 'archived';
export type ConversationAgentTransport = 'app_server' | 'rpc' | 'sdk';
export type ConversationProviderState = 'unbound' | 'binding' | 'ready' | 'active' | 'waiting' | 'paused' | 'archived' | 'closed' | 'failed';
export type ConversationPermissionMode = 'read-only' | 'auto' | 'full-access';
export type ConversationCollaborationMode = 'default' | 'plan';
export type ConversationAttentionKind = 'none' | 'unread' | 'completed' | 'failed' | 'interrupted';
export type ConversationGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';
export type ConversationGoalEventKind = 'created' | 'edited' | 'paused' | 'resumed' | 'blocked' | 'usage_limited' | 'budget_limited' | 'completed' | 'cleared';

export interface ZeusConversationGoalRecord {
  conversationId: string;
  providerThreadId: string;
  objective: string;
  status: ConversationGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  providerCreatedAt: number;
  providerUpdatedAt: number;
  updatedAt: string;
}

export interface ZeusConversationGoalEventRecord {
  id: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string | null;
  kind: ConversationGoalEventKind;
  objective: string | null;
  status: ConversationGoalStatus | null;
  tokenBudget: number | null;
  tokensUsed: number | null;
  timeUsedSeconds: number | null;
  occurredAt: string;
}

export interface ConversationNextTurnSettings {
  model: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode: ConversationPermissionMode;
  collaborationMode: ConversationCollaborationMode;
}

export interface ZeusConversationMessageRecord {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadataJson: string;
  createdAt: string;
  providerThreadId: string | null;
  providerTurnId: string | null;
  providerItemId: string | null;
  clientMessageId: string | null;
}

export interface ZeusConversationWithMessagesRecord extends ZeusConversationRecord {
  messages: ZeusConversationMessageRecord[];
}

export type CodexLegacyImportStatus = 'prepared' | 'waiting' | 'completed' | 'failed';

export interface ZeusCodexLegacyImportRecord {
  id: string;
  providerImportId: string | null;
  sourceConversationId: string;
  targetConversationId: string | null;
  snapshotPath: string;
  snapshotSha256: string;
  status: CodexLegacyImportStatus;
  targetThreadId: string | null;
  failureStage: string | null;
  failureMessage: string | null;
  providerBinaryVersion: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CreateCodexLegacyImportRunInput {
  sourceConversationId: string;
  snapshotPath: string;
  snapshotSha256: string;
  providerBinaryVersion: string;
}

export interface ConversationListOptions {
  query?: string;
  limit?: number;
  offset?: number;
  archived?: boolean;
}

export interface ConversationRecordListOptions {
  archived?: boolean;
}

export interface ConversationListResult {
  items: ZeusConversationWithMessagesRecord[];
  total: number;
  limit: number;
  offset: number;
  query: string | null;
  archived: boolean;
}

export interface CreateConversationInput {
  id?: string;
  projectId: string;
  taskId?: string;
  workspaceId?: string;
  environmentId?: string;
  sessionId?: string;
  title: string;
  summary?: string;
  status?: string;
  transportKind?: ConversationTransportKind;
  providerId?: string;
  providerThreadId?: string;
  providerThreadPath?: string;
  providerModel?: string;
  providerState?: ConversationProviderState;
  providerProtocolVersion?: string;
  providerBinaryVersion?: string;
  legacySourceConversationId?: string;
  permissionMode?: ConversationPermissionMode;
  collaborationMode?: ConversationCollaborationMode;
  agentKind?: ConversationAgentKind;
  agentTransport?: ConversationAgentTransport;
  modelSourceId?: string;
  modelId?: string;
  nativeSessionId?: string;
  nativeSessionPath?: string;
  capabilitySnapshotId?: string;
}

export interface AppendConversationMessageInput {
  conversationId: string;
  role: string;
  content: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  providerThreadId?: string;
  providerTurnId?: string;
  providerItemId?: string;
  clientMessageId?: string;
}

export interface UpdateConversationRuntimeStateInput {
  sessionId?: string | null;
  status?: string;
  summary?: string | null;
}

export interface BindConversationProviderInput {
  providerId: string;
  providerThreadId: string;
  providerThreadPath?: string | null;
  providerModel?: string | null;
  providerState: ConversationProviderState;
  providerProtocolVersion?: string | null;
  providerBinaryVersion?: string | null;
}

export interface BindPiConversationProviderInput extends BindConversationProviderInput {
  modelSourceId: string | null;
  modelId: string;
}

export interface ProviderSequenceSnapshot {
  generationId: string;
  sequence: number;
}

export interface ConversationProviderSettingsSnapshot extends ProviderSequenceSnapshot {
  model: string;
  effort?: string;
  serviceTier?: string | null;
}

export interface ConversationProviderTokenUsageSnapshot extends ProviderSequenceSnapshot {
  serviceTier?: string | null;
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
  cacheHitRate: number | null;
  estimatedCredits: number | null;
  apiEquivalentUsd: number | null;
  lastApiEquivalentUsd: number | null;
  cacheSavingsUsd: number | null;
  priceCoverage: number | null;
  pricingCatalogDate: string | null;
  pricingSourceUrls: string[];
  historyComplete: boolean;
}

export interface CodexUsageLedgerRecord {
  id: string;
  providerId: string;
  accountScopeId: string;
  projectId: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string;
  model: string;
  serviceTier: string | null;
  usage: TokenUsageBreakdown;
  providerBaseline: TokenUsageBreakdown | null;
  providerTotal: TokenUsageBreakdown | null;
  usageComplete: boolean;
  estimate: CodexUsageEstimate;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertCodexUsageLedgerInput {
  providerId: string;
  accountScopeId: string;
  projectId: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string;
  model: string;
  serviceTier?: string | null;
  usage: TokenUsageBreakdown;
  providerBaseline?: TokenUsageBreakdown | null;
  providerTotal?: TokenUsageBreakdown | null;
  usageComplete?: boolean;
  estimate: CodexUsageEstimate;
  occurredAt: string;
}

export interface ListCodexUsageLedgerInput {
  providerId?: string | null;
  providerThreadId?: string | null;
  accountScopeId?: string | null;
  since?: string | null;
  projectId?: string | null;
  model?: string | null;
  conversationId?: string | null;
}

export type ProviderVisibleJson = null | boolean | number | string | ProviderVisibleJson[] | { [key: string]: ProviderVisibleJson };
export interface CodexRateLimitWindowState {
  remaining?: number;
  usedPercent?: number;
  resetsAt?: number | string | null;
}
export interface CodexRateLimitCreditsState {
  balance?: number | string | null;
  unlimited?: boolean;
}
export interface CodexRateLimitsState {
  primary?: CodexRateLimitWindowState;
  secondary?: CodexRateLimitWindowState;
  credits?: CodexRateLimitCreditsState;
  planType?: string;
}
export interface CodexRateLimitsSnapshot extends ProviderSequenceSnapshot {
  value: CodexRateLimitsState;
}
export type CodexMcpServerStartupState = string | { status: string; error?: string | null };
export interface CodexMcpStartupStatusSnapshot extends ProviderSequenceSnapshot {
  value: Record<string, CodexMcpServerStartupState>;
}

export type ConversationTurnStatus = 'queued' | 'dispatching' | 'running' | 'waiting' | 'paused' | 'completed' | 'interrupted' | 'failed';
export interface ZeusConversationTurnRecord {
  id: string;
  conversationId: string;
  providerThreadId: string;
  providerTurnId: string | null;
  clientSubmissionId: string | null;
  status: ConversationTurnStatus;
  errorJson: string | null;
  planJson: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentKind: ConversationAgentKind | null;
  nativeRunId: string | null;
}

export interface ZeusConversationProviderSyncCheckpointRecord {
  conversationId: string;
  providerThreadId: string;
  baselineTurnId: string | null;
  lastSyncedTurnId: string | null;
  initializedAt: string;
  updatedAt: string;
}

export type AgentCapabilitySupportStatus = 'unavailable' | 'framework_only' | 'experimental' | 'verified';

export interface ZeusAgentCapabilitySnapshotRecord {
  id: string;
  agentKind: ConversationAgentKind;
  transportKind: ConversationAgentTransport;
  supportStatus: AgentCapabilitySupportStatus;
  adapterVersion: string | null;
  binaryVersion: string | null;
  protocolVersion: string | null;
  capabilitiesJson: string;
  evidenceJson: string;
  checkedAt: string;
}

export interface CreateAgentCapabilitySnapshotInput {
  id?: string;
  agentKind: ConversationAgentKind;
  transportKind: ConversationAgentTransport;
  supportStatus: AgentCapabilitySupportStatus;
  adapterVersion?: string;
  binaryVersion?: string;
  protocolVersion?: string;
  capabilities: unknown;
  evidence: unknown;
  checkedAt: string;
}

export interface ZeusConversationResourceRecord {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  itemId: string;
  sourceIndex: number;
  canonicalTargetDigest: string;
  kind: ConversationResourceKind;
  presentation: ConversationResourcePresentation;
  displayJson: string;
  targetJson: string;
  authorityJson: string;
  createdAt: string;
  updatedAt: string;
}

export type ConversationSubmissionKind = 'message' | 'steer';
export type ConversationRequestedDelivery = 'queue' | 'send_now';
export type ConversationSubmissionStatus = 'queued' | 'dispatching' | 'active' | 'paused' | 'completed' | 'resolved' | 'failed' | 'cancelled' | 'deleted';
export interface ZeusConversationSubmissionRecord {
  id: string;
  conversationId: string;
  idempotencyKey: string;
  requestHash: string;
  clientMessageId: string;
  kind: ConversationSubmissionKind;
  requestedDelivery: ConversationRequestedDelivery;
  status: ConversationSubmissionStatus;
  queuePosition: number | null;
  inputJson: string;
  targetProviderTurnId: string | null;
  providerTurnId: string | null;
  pausedReason: string | null;
  errorJson: string | null;
  createdAt: string;
  updatedAt: string;
  dispatchedAt: string | null;
  resolvedAt: string | null;
  replacementOfSubmissionId: string | null;
  replacementReason: string | null;
  executionSnapshotId: string | null;
  segmentId: string | null;
  submissionOutcome: 'queued' | 'paused' | 'outcome_unknown' | 'accepted' | 'terminal';
  acceptedAt: string | null;
  timelineSequence: number | null;
  modelHistorySequence: number | null;
}

export type ConversationServerRequestKind = 'command' | 'file' | 'permissions' | 'request_user_input' | 'mcp';
export type ConversationServerRequestStatus = 'pending' | 'resolved' | 'declined' | 'expired' | 'failed';
export interface ZeusConversationServerRequestRecord {
  id: string;
  conversationId: string;
  turnId: string | null;
  itemId: string | null;
  transportGenerationId: string;
  providerRequestIdJson: string;
  requestKind: ConversationServerRequestKind;
  payloadJson: string;
  status: ConversationServerRequestStatus;
  responseJson: string | null;
  containsSecret: boolean;
  expiresAt: string | null;
  autoResolutionState: ConversationRequestAutoResolutionState;
  createdAt: string;
  resolvedAt: string | null;
}

export type ConversationRequestAutoResolutionState = 'none' | 'scheduled' | 'snoozed';

export type ConversationPlanActionStatus = 'pending' | 'dismissed' | 'implemented' | 'refinement_requested' | 'superseded';

export interface ZeusConversationPlanActionRecord {
  id: string;
  conversationId: string;
  turnId: string;
  planItemId: string;
  status: ConversationPlanActionStatus;
  submissionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export type IdempotencyRequestStatus = 'in_progress' | 'completed' | 'failed';
export interface ZeusIdempotencyRequestRecord {
  scope: string;
  idempotencyKey: string;
  requestHash: string;
  status: IdempotencyRequestStatus;
  httpStatus: number | null;
  responseJson: string | null;
  resourceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProviderEventReceiptInput {
  identity: string;
  generationId: string;
  sequence: number;
  method: string;
  threadId?: string | null;
  providerTurnId?: string | null;
  providerItemId?: string | null;
  requestId?: string | null;
  receivedAt: string;
}

/** Provider 回执和业务投影共用 ZeusDatabasePort 的待持久事务，避免去重状态与业务状态分裂。 */
export class ProviderEventReceiptRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  has(identity: string): boolean {
    return Boolean(this.db.get<{ identity: string }>(`SELECT identity FROM provider_event_receipts WHERE identity = ?`, [identity]));
  }

  record(input: ProviderEventReceiptInput): void {
    this.db.execute(
      `INSERT INTO provider_event_receipts
         (identity, generation_id, sequence, method, thread_id, provider_turn_id, provider_item_id, request_id, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(identity) DO NOTHING`,
      [input.identity, input.generationId, input.sequence, input.method, input.threadId ?? '', input.providerTurnId ?? '', input.providerItemId ?? '', input.requestId ?? '', input.receivedAt],
    );
  }

  listGenerationIds(): string[] {
    return this.db.select<{ generation_id: string }>(`SELECT DISTINCT generation_id FROM provider_event_receipts`).map((row) => row.generation_id);
  }

  deleteGenerations(generationIds: readonly string[]): void {
    if (generationIds.length === 0) return;
    const placeholders = generationIds.map(() => '?').join(', ');
    this.db.execute(`DELETE FROM provider_event_receipts WHERE generation_id IN (${placeholders})`, [...generationIds]);
  }
}

/** 设置仓储保存本机偏好与通知策略，不存储 token、密码等敏感明文。 */

const selectConversationFields = `id, project_id, task_id, session_id, title, summary, status, stage, stage_updated_at, created_at, updated_at, archived,
  transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
  provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json, permission_mode, collaboration_mode, next_turn_settings_json, completion_unread, attention_kind, attention_revision, attention_turn_id, attention_updated_at, workspace_id, environment_id,
  agent_kind, agent_transport, model_source_id, model_id, native_session_id, native_session_path, capability_snapshot_id`;
const selectConversationMessageFields = `id, conversation_id, role, content, source, metadata_json, created_at,
  provider_thread_id, provider_turn_id, provider_item_id, client_message_id`;
const selectAliasedConversationMessageFields = `message.id, message.conversation_id, message.role, message.content, message.source, message.metadata_json, message.created_at,
  message.provider_thread_id, message.provider_turn_id, message.provider_item_id, message.client_message_id`;

function latestIso(...values: Array<string | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => right.localeCompare(left))[0] ?? '';
}

function isPiModelRequestFailure(errorJson: string | null | undefined): boolean {
  if (!errorJson) return false;
  try {
    const error = JSON.parse(errorJson) as unknown;
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ZEUS_PI_MODEL_REQUEST_FAILED';
  } catch {
    return false;
  }
}

/**
 * 从持久执行事实投影当前会话阶段。该投影不读取会话正文、配置或阅读状态，避免非阶段变化污染排序。
 */
export function deriveConversationStageProjection(db: ZeusDatabasePort, conversationId: string): { stage: ConversationStage; evidenceAt: string } | null {
  const conversation = db.get<{
    archived: number;
    transport_kind: ConversationTransportKind;
    status: string;
    provider_state: ConversationProviderState;
    created_at: string;
  }>(`SELECT archived, transport_kind, status, provider_state, created_at FROM conversations WHERE id = ?`, [conversationId]);
  if (!conversation) return null;
  if (conversation.archived === 1 || conversation.provider_state === 'archived') return { stage: 'archived', evidenceAt: conversation.created_at };

  const pendingPlanAction = db.get<{ created_at: string }>(`SELECT created_at FROM conversation_plan_actions WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
  if (pendingPlanAction) return { stage: 'waiting_user', evidenceAt: pendingPlanAction.created_at };

  const pendingRequest = db.get<{ request_kind: ConversationServerRequestKind; created_at: string }>(
    `SELECT request_kind, created_at FROM conversation_server_requests WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  if (pendingRequest) {
    return {
      stage: pendingRequest.request_kind === 'request_user_input' ? 'waiting_user' : 'waiting_approval',
      evidenceAt: pendingRequest.created_at,
    };
  }

  const activeTurn = db.get<{ started_at: string | null; updated_at: string }>(`SELECT started_at, updated_at FROM conversation_turns WHERE conversation_id = ? AND status = 'running' ORDER BY updated_at DESC, id DESC LIMIT 1`, [
    conversationId,
  ]);
  const activeSubmission = db.get<{ dispatched_at: string | null; updated_at: string }>(
    `SELECT dispatched_at, updated_at FROM conversation_submissions WHERE conversation_id = ? AND status = 'active' ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  if (activeTurn || activeSubmission) {
    return {
      stage: 'running',
      evidenceAt: latestIso(activeTurn?.started_at, activeTurn?.updated_at, activeSubmission?.dispatched_at, activeSubmission?.updated_at, conversation.created_at),
    };
  }

  const queuedSubmission = db.get<{ created_at: string; updated_at: string }>(
    `SELECT created_at, updated_at FROM conversation_submissions WHERE conversation_id = ? AND status IN ('queued', 'dispatching') ORDER BY created_at ASC, id ASC LIMIT 1`,
    [conversationId],
  );
  if (queuedSubmission) {
    const latestTerminal = db.get<{ completed_at: string | null; updated_at: string }>(
      `SELECT completed_at, updated_at FROM conversation_turns WHERE conversation_id = ? AND status IN ('completed', 'interrupted', 'failed') ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 1`,
      [conversationId],
    );
    return { stage: 'queued', evidenceAt: latestIso(queuedSubmission.created_at, latestTerminal?.completed_at, latestTerminal?.updated_at) };
  }

  const latestTurn = db.get<{ status: string; error_json: string | null; completed_at: string | null; updated_at: string }>(
    `SELECT status, error_json, completed_at, updated_at FROM conversation_turns WHERE conversation_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  const latestSubmission = db.get<{ status: string; resolved_at: string | null; updated_at: string }>(
    `SELECT status, resolved_at, updated_at FROM conversation_submissions WHERE conversation_id = ? ORDER BY updated_at DESC, id DESC LIMIT 1`,
    [conversationId],
  );
  const terminalEvidenceAt = latestIso(latestTurn?.completed_at, latestTurn?.updated_at, latestSubmission?.resolved_at, latestSubmission?.updated_at, conversation.created_at);
  if (conversation.provider_state === 'paused') return { stage: 'paused', evidenceAt: terminalEvidenceAt };
  if (conversation.provider_state === 'failed' || conversation.status === 'failed') return { stage: 'failed', evidenceAt: terminalEvidenceAt };
  if (conversation.provider_state === 'closed') return { stage: 'completed', evidenceAt: terminalEvidenceAt };
  if (conversation.transport_kind === 'legacy_cli') return { stage: 'completed', evidenceAt: conversation.created_at };
  // Pi 供应商单轮请求失败只保留为历史结果，不终止仍处于 ready 的会话。
  if (conversation.provider_state === 'ready' && latestTurn?.status === 'failed' && isPiModelRequestFailure(latestTurn.error_json)) return { stage: 'ready', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'waiting') return { stage: 'waiting_approval', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'failed' || latestSubmission?.status === 'failed') return { stage: 'failed', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'paused' || latestTurn?.status === 'interrupted' || latestSubmission?.status === 'paused') return { stage: 'paused', evidenceAt: terminalEvidenceAt };
  if (latestTurn?.status === 'completed' || latestSubmission?.status === 'completed') return { stage: 'completed', evidenceAt: terminalEvidenceAt };
  if (conversation.provider_state === 'binding' || conversation.provider_state === 'unbound' || conversation.status === 'starting') {
    return { stage: 'connecting', evidenceAt: conversation.created_at };
  }
  if (conversation.provider_state === 'ready') return { stage: 'ready', evidenceAt: terminalEvidenceAt };
  return { stage: 'created', evidenceAt: conversation.created_at };
}

/** 只有阶段枚举真正变化时才推进阶段时间，不触碰会话最后更新时间。 */
function syncConversationStage(db: ZeusDatabasePort, conversationId: string, occurredAt = nowIso()): void {
  const current = db.get<{ stage: ConversationStage; stage_updated_at: string }>(`SELECT stage, stage_updated_at FROM conversations WHERE id = ?`, [conversationId]);
  const projection = deriveConversationStageProjection(db, conversationId);
  if (!current || !projection || current.stage === projection.stage) return;
  db.execute(`UPDATE conversations SET stage = ?, stage_updated_at = ? WHERE id = ?`, [projection.stage, occurredAt, conversationId]);
}

/** 保存一次真实能力检查的版本与结论，不保存命令原文、密钥或对话正文。 */
export class AgentCapabilitySnapshotRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  create(input: CreateAgentCapabilitySnapshotInput): ZeusAgentCapabilitySnapshotRecord {
    const record: ZeusAgentCapabilitySnapshotRecord = {
      id: input.id ?? `agent_capability_${nanoid(12)}`,
      agentKind: assertEnum(input.agentKind, ['codex', 'pi', 'claude'] as const, 'agent capability kind'),
      transportKind: assertEnum(input.transportKind, ['app_server', 'rpc', 'sdk'] as const, 'agent capability transport'),
      supportStatus: assertEnum(input.supportStatus, ['unavailable', 'framework_only', 'experimental', 'verified'] as const, 'agent capability support status'),
      adapterVersion: input.adapterVersion ?? null,
      binaryVersion: input.binaryVersion ?? null,
      protocolVersion: input.protocolVersion ?? null,
      capabilitiesJson: JSON.stringify(input.capabilities),
      evidenceJson: JSON.stringify(input.evidence),
      checkedAt: input.checkedAt,
    };
    this.db.execute(
      `INSERT INTO agent_capability_snapshots
       (id, agent_kind, transport_kind, support_status, adapter_version, binary_version, protocol_version, capabilities_json, evidence_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.id, record.agentKind, record.transportKind, record.supportStatus, record.adapterVersion, record.binaryVersion, record.protocolVersion, record.capabilitiesJson, record.evidenceJson, record.checkedAt],
    );
    return record;
  }

  getById(id: string): ZeusAgentCapabilitySnapshotRecord | undefined {
    const row = this.db.get<DbAgentCapabilitySnapshotRow>(`SELECT * FROM agent_capability_snapshots WHERE id = ?`, [id]);
    return row ? mapAgentCapabilitySnapshotRow(row) : undefined;
  }

  listByAgent(agentKind: ConversationAgentKind, limit = 20): ZeusAgentCapabilitySnapshotRecord[] {
    const normalizedAgentKind = assertEnum(agentKind, ['codex', 'pi', 'claude'] as const, 'agent capability kind');
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200));
    return this.db.select<DbAgentCapabilitySnapshotRow>(`SELECT * FROM agent_capability_snapshots WHERE agent_kind = ? ORDER BY checked_at DESC, id DESC LIMIT ?`, [normalizedAgentKind, safeLimit]).map(mapAgentCapabilitySnapshotRow);
  }
}

/** 对话仓储保存 AI 对话主记录与消息，不写入任何 seed 对话。 */
export class ConversationRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  /**
   * 会话列表时间只描述用户能理解的真实活动，不使用会被打开、水合、统计或归档维护推进的 conversations.updated_at。
   * 这里刻意不读取旧 item 投影的更新时间：历史回填会重写该投影，且它没有按会话时间查询的索引。
   */
  meaningfulActivityAt(conversationId: string): string {
    const row = this.db.get<{
      created_at: string;
      message_at: string | null;
      turn_at: string | null;
      submission_at: string | null;
      request_at: string | null;
      plan_at: string | null;
    }>(
      `SELECT c.created_at,
              (SELECT MAX(m.created_at) FROM conversation_messages m WHERE m.conversation_id = c.id) AS message_at,
              (SELECT MAX(COALESCE(t.completed_at, t.started_at, t.created_at)) FROM conversation_turns t WHERE t.conversation_id = c.id) AS turn_at,
              (SELECT MAX(CASE WHEN s.status IN ('cancelled', 'deleted') THEN s.created_at ELSE COALESCE(s.resolved_at, s.accepted_at, s.dispatched_at, s.created_at) END)
                 FROM conversation_submissions s WHERE s.conversation_id = c.id) AS submission_at,
              (SELECT MAX(COALESCE(r.resolved_at, r.created_at)) FROM conversation_server_requests r WHERE r.conversation_id = c.id) AS request_at,
              (SELECT MAX(COALESCE(p.resolved_at, p.created_at)) FROM conversation_plan_actions p WHERE p.conversation_id = c.id) AS plan_at
         FROM conversations c
        WHERE c.id = ?`,
      [conversationId],
    );
    if (!row) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return latestIso(row.message_at, row.turn_at, row.submission_at, row.request_at, row.plan_at, row.created_at);
  }

  create(input: CreateConversationInput): ZeusConversationRecord {
    const transportKind = assertEnum(input.transportKind ?? 'legacy_cli', ['legacy_cli', 'codex_native'] as const, 'conversation transport kind');
    const providerState = assertEnum(input.providerState ?? 'unbound', ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state');
    const permissionMode = assertEnum(input.permissionMode ?? 'read-only', ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode');
    const collaborationMode = assertEnum(input.collaborationMode ?? 'default', ['default', 'plan'] as const, 'conversation collaboration mode');
    const agentKind = input.agentKind ? assertEnum(input.agentKind, ['codex', 'pi', 'claude'] as const, 'conversation agent kind') : transportKind === 'codex_native' ? 'codex' : null;
    const agentTransport = input.agentTransport ? assertEnum(input.agentTransport, ['app_server', 'rpc', 'sdk'] as const, 'conversation agent transport') : transportKind === 'codex_native' ? 'app_server' : null;
    const timestamp = nowIso();
    const record: ZeusConversationRecord = {
      id: input.id ?? `conversation_${nanoid(12)}`,
      projectId: input.projectId,
      taskId: input.taskId ?? null,
      workspaceId: input.workspaceId ?? null,
      environmentId: input.environmentId ?? null,
      sessionId: input.sessionId ?? null,
      title: input.title,
      summary: input.summary ?? null,
      status: input.status ?? 'open',
      stage: 'created',
      stageUpdatedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      archived: false,
      transportKind,
      providerId: input.providerId ?? null,
      providerThreadId: input.providerThreadId ?? null,
      providerThreadPath: input.providerThreadPath ?? null,
      providerModel: input.providerModel ?? null,
      providerState,
      providerProtocolVersion: input.providerProtocolVersion ?? null,
      providerBinaryVersion: input.providerBinaryVersion ?? null,
      legacySourceConversationId: input.legacySourceConversationId ?? null,
      providerSettingsJson: '{}',
      providerTokenUsageJson: '{}',
      permissionMode,
      collaborationMode,
      nextTurnSettingsJson: '{}',
      attentionUnread: false,
      attentionKind: 'none',
      attentionRevision: 0,
      attentionTurnId: null,
      attentionUpdatedAt: null,
      agentKind,
      agentTransport,
      modelSourceId: input.modelSourceId ?? null,
      modelId: input.modelId ?? input.providerModel ?? null,
      nativeSessionId: input.nativeSessionId ?? input.providerThreadId ?? null,
      nativeSessionPath: input.nativeSessionPath ?? input.providerThreadPath ?? null,
      capabilitySnapshotId: input.capabilitySnapshotId ?? null,
    };
    this.db.execute(
      `INSERT INTO conversations (id, project_id, task_id, workspace_id, environment_id, session_id, title, summary, status, stage, stage_updated_at, created_at, updated_at, archived,
        transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
        provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json, permission_mode, collaboration_mode, next_turn_settings_json, completion_unread,
        agent_kind, agent_transport, model_source_id, model_id, native_session_id, native_session_path, capability_snapshot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.projectId,
        record.taskId,
        record.workspaceId,
        record.environmentId,
        record.sessionId,
        record.title,
        record.summary,
        record.status,
        record.stage,
        record.stageUpdatedAt,
        record.createdAt,
        record.updatedAt,
        record.transportKind,
        record.providerId,
        record.providerThreadId,
        record.providerThreadPath,
        record.providerModel,
        record.providerState,
        record.providerProtocolVersion,
        record.providerBinaryVersion,
        record.legacySourceConversationId,
        record.providerSettingsJson,
        record.providerTokenUsageJson,
        record.permissionMode,
        record.collaborationMode,
        record.nextTurnSettingsJson,
        record.agentKind,
        record.agentTransport,
        record.modelSourceId,
        record.modelId,
        record.nativeSessionId,
        record.nativeSessionPath,
        record.capabilitySnapshotId,
      ],
    );
    syncConversationStage(this.db, record.id, timestamp);
    return this.getById(record.id) ?? record;
  }

  updatePermissionMode(conversationId: string, permissionMode: ConversationPermissionMode): ZeusConversationWithMessagesRecord {
    const normalized = assertEnum(permissionMode, ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode');
    this.db.execute(`UPDATE conversations SET permission_mode = ?, updated_at = ? WHERE id = ?`, [normalized, nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  updateCollaborationMode(conversationId: string, collaborationMode: ConversationCollaborationMode): ZeusConversationWithMessagesRecord {
    const normalized = assertEnum(collaborationMode, ['default', 'plan'] as const, 'conversation collaboration mode');
    this.db.execute(`UPDATE conversations SET collaboration_mode = ?, updated_at = ? WHERE id = ?`, [normalized, nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  updateNextTurnSettings(conversationId: string, settings: ConversationNextTurnSettings): ZeusConversationWithMessagesRecord {
    validateNextTurnSettings(settings);
    this.db.execute(`UPDATE conversations SET next_turn_settings_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(settings), nowIso(), conversationId]);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  getNextTurnSettings(conversationId: string): ConversationNextTurnSettings | undefined {
    const row = this.db.get<{ next_turn_settings_json: string }>(`SELECT next_turn_settings_json FROM conversations WHERE id = ?`, [conversationId]);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.next_turn_settings_json) as unknown;
      validateNextTurnSettings(parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  hasSessionFileEditGrant(conversationId: string): boolean {
    return this.db.get<{ enabled: number }>(`SELECT enabled FROM conversation_session_file_edit_grants WHERE conversation_id = ?`, [conversationId])?.enabled === 1;
  }

  setSessionFileEditGrant(conversationId: string, projectId: string, enabled: boolean): void {
    this.db.execute(
      `INSERT INTO conversation_session_file_edit_grants (conversation_id, project_id, enabled, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET project_id = excluded.project_id, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      [conversationId, projectId, enabled ? 1 : 0, nowIso()],
    );
  }

  /** 关注未读是阅读事实，不得改变会话活跃时间或阶段排序。相同轮次与类型重复到达时保持幂等。 */
  markAttentionUnread(conversationId: string, input: { kind: Exclude<ConversationAttentionKind, 'none'>; turnId?: string | null; occurredAt: string }): ZeusConversationWithMessagesRecord {
    const kind = assertEnum(input.kind, ['unread', 'completed', 'failed', 'interrupted'] as const, 'conversation attention kind');
    const current = this.db.get<{ completion_unread: number; attention_kind: ConversationAttentionKind; attention_revision: number; attention_turn_id: string | null }>(
      `SELECT completion_unread, attention_kind, attention_revision, attention_turn_id FROM conversations WHERE id = ?`,
      [conversationId],
    );
    if (!current) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const turnId = input.turnId ?? null;
    if (!(current.completion_unread === 1 && current.attention_kind === kind && current.attention_turn_id === turnId)) {
      this.db.execute(
        `UPDATE conversations
            SET completion_unread = 1,
                attention_kind = ?,
                attention_revision = attention_revision + 1,
                attention_turn_id = ?,
                attention_updated_at = ?
          WHERE id = ?`,
        [kind, turnId, input.occurredAt, conversationId],
      );
    }
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  /** 只确认调用方实际看见的关注版本；期间若有新回复到达，旧确认不得把它清掉。 */
  acknowledgeAttention(conversationId: string, expectedRevision: number): { acknowledged: boolean; conversation: ZeusConversationWithMessagesRecord } {
    const current = this.db.get<{ completion_unread: number; attention_revision: number }>(`SELECT completion_unread, attention_revision FROM conversations WHERE id = ?`, [conversationId]);
    if (!current) throw new Error(`Zeus conversation not found: ${conversationId}`);
    const acknowledged = current.completion_unread === 1 && current.attention_revision === expectedRevision;
    if (acknowledged) {
      this.db.execute(`UPDATE conversations SET completion_unread = 0, attention_kind = 'none', attention_turn_id = NULL WHERE id = ? AND attention_revision = ?`, [conversationId, expectedRevision]);
    }
    const conversation = this.getById(conversationId);
    if (!conversation) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return { acknowledged, conversation };
  }

  appendMessage(input: AppendConversationMessageInput): ZeusConversationMessageRecord {
    const record: ZeusConversationMessageRecord = {
      id: `conversation_message_${nanoid(12)}`,
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      source: input.source,
      metadataJson: JSON.stringify(input.metadata),
      createdAt: input.createdAt,
      providerThreadId: input.providerThreadId ?? null,
      providerTurnId: input.providerTurnId ?? null,
      providerItemId: input.providerItemId ?? null,
      clientMessageId: input.clientMessageId ?? null,
    };
    if (record.providerItemId) {
      const aliased = this.db.get<DbConversationMessageRow>(
        `SELECT ${selectAliasedConversationMessageFields}
           FROM conversation_message_provider_aliases alias
           JOIN conversation_messages message ON message.id = alias.message_id
          WHERE alias.conversation_id = ? AND alias.provider_item_id = ?`,
        [record.conversationId, record.providerItemId],
      );
      if (aliased) return this.updateConfirmedUserMessageAlias(record, mapConversationMessageRow(aliased));

      const legacyExact = this.db.get<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? AND provider_item_id = ?`, [record.conversationId, record.providerItemId]);
      if (legacyExact) {
        const exact = mapConversationMessageRow(legacyExact);
        this.insertProviderMessageAlias(record, exact.id);
        return this.updateConfirmedUserMessageAlias(record, exact);
      }
    }
    if (record.role === 'user' && record.clientMessageId) {
      const existing = this.db.get<DbConversationMessageRow>(
        `SELECT ${selectConversationMessageFields} FROM conversation_messages
         WHERE conversation_id = ? AND role = 'user' AND client_message_id = ?
         ORDER BY CASE WHEN source = 'zeus_local_submission' THEN 0 ELSE 1 END, created_at ASC, id ASC LIMIT 1`,
        [record.conversationId, record.clientMessageId],
      );
      if (existing) {
        const current = mapConversationMessageRow(existing);
        // 本地接纳投影先出现，Provider 回显到达后在同一行补齐原生身份；旧回放不得把已确认身份降级。
        if (!record.providerItemId && current.providerItemId) return current;
        if (record.providerItemId) this.insertProviderMessageAlias(record, current.id);
        this.db.execute(
          `UPDATE conversation_messages SET content = ?, source = ?, metadata_json = ?,
             provider_thread_id = COALESCE(?, provider_thread_id), provider_turn_id = COALESCE(?, provider_turn_id),
             provider_item_id = COALESCE(provider_item_id, ?)
           WHERE id = ?`,
          [record.content, record.source, record.metadataJson, record.providerThreadId, record.providerTurnId, record.providerItemId, current.id],
        );
        this.advanceConversationUpdatedAt(record.conversationId, record.createdAt);
        return this.db.select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE id = ?`, [current.id]).map(mapConversationMessageRow)[0]!;
      }
    }
    const params = [record.id, record.conversationId, record.role, record.content, record.source, record.metadataJson, record.createdAt, record.providerThreadId, record.providerTurnId, record.providerItemId, record.clientMessageId];
    if (record.providerItemId) {
      this.db.execute(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id, provider_item_id) WHERE provider_item_id IS NOT NULL DO UPDATE SET
           role = excluded.role, content = excluded.content, source = excluded.source, metadata_json = excluded.metadata_json,
           provider_thread_id = excluded.provider_thread_id, provider_turn_id = excluded.provider_turn_id,
           client_message_id = excluded.client_message_id`,
        params,
      );
    } else {
      this.db.execute(
        `INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params,
      );
    }
    if (record.providerItemId) this.insertProviderMessageAlias(record, record.id);
    this.advanceConversationUpdatedAt(record.conversationId, record.createdAt);
    if (!record.providerItemId) return record;
    return this.db
      .select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? AND provider_item_id = ?`, [record.conversationId, record.providerItemId])
      .map(mapConversationMessageRow)[0]!;
  }

  private updateConfirmedUserMessageAlias(record: ZeusConversationMessageRecord, current: ZeusConversationMessageRecord): ZeusConversationMessageRecord {
    if (record.role !== 'user' || current.role !== 'user' || (record.clientMessageId && current.clientMessageId && record.clientMessageId !== current.clientMessageId)) return current;
    this.db.execute(
      `UPDATE conversation_messages
          SET content = ?, source = ?, metadata_json = ?,
              provider_thread_id = COALESCE(provider_thread_id, ?),
              provider_turn_id = COALESCE(provider_turn_id, ?),
              client_message_id = COALESCE(client_message_id, ?)
        WHERE id = ?`,
      [record.content, record.source, record.metadataJson, record.providerThreadId, record.providerTurnId, record.clientMessageId, current.id],
    );
    this.advanceConversationUpdatedAt(record.conversationId, record.createdAt);
    return this.db.select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE id = ?`, [current.id]).map(mapConversationMessageRow)[0]!;
  }

  private insertProviderMessageAlias(record: ZeusConversationMessageRecord, messageId: string): void {
    if (!record.providerItemId) return;
    this.db.execute(
      `INSERT INTO conversation_message_provider_aliases
         (conversation_id, message_id, provider_thread_id, provider_turn_id, provider_item_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id, provider_item_id) DO UPDATE SET
         provider_thread_id = COALESCE(excluded.provider_thread_id, conversation_message_provider_aliases.provider_thread_id),
         provider_turn_id = COALESCE(excluded.provider_turn_id, conversation_message_provider_aliases.provider_turn_id),
         updated_at = CASE WHEN conversation_message_provider_aliases.updated_at < excluded.updated_at THEN excluded.updated_at ELSE conversation_message_provider_aliases.updated_at END`,
      [record.conversationId, messageId, record.providerThreadId, record.providerTurnId, record.providerItemId, record.createdAt, record.createdAt],
    );
  }

  private advanceConversationUpdatedAt(conversationId: string, occurredAt: string): void {
    this.db.execute(`UPDATE conversations SET updated_at = CASE WHEN updated_at < ? THEN ? ELSE updated_at END WHERE id = ?`, [occurredAt, occurredAt, conversationId]);
  }

  bindProvider(conversationId: string, input: BindConversationProviderInput): ZeusConversationWithMessagesRecord {
    assertEnum(input.providerState, ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state');
    const timestamp = nowIso();
    this.db.execute(
      `UPDATE conversations SET transport_kind = 'codex_native', provider_id = ?, provider_thread_id = ?, provider_thread_path = COALESCE(?, provider_thread_path),
       provider_model = COALESCE(?, provider_model), provider_state = ?, provider_protocol_version = COALESCE(?, provider_protocol_version), provider_binary_version = COALESCE(?, provider_binary_version),
       agent_kind = 'codex', agent_transport = 'app_server', model_id = COALESCE(?, model_id), native_session_id = ?, native_session_path = COALESCE(?, native_session_path), updated_at = ? WHERE id = ?`,
      [
        input.providerId,
        input.providerThreadId,
        input.providerThreadPath ?? null,
        input.providerModel ?? null,
        input.providerState,
        input.providerProtocolVersion ?? null,
        input.providerBinaryVersion ?? null,
        input.providerModel ?? null,
        input.providerThreadId,
        input.providerThreadPath ?? null,
        timestamp,
        conversationId,
      ],
    );
    syncConversationStage(this.db, conversationId, timestamp);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  /** Pi Worker 准备完成后绑定原生会话，同时保留此前已经展示给用户的 Zeus 会话身份。 */
  bindPiProvider(conversationId: string, input: BindPiConversationProviderInput): ZeusConversationWithMessagesRecord {
    assertEnum(input.providerState, ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state');
    const timestamp = nowIso();
    this.db.execute(
      `UPDATE conversations SET transport_kind = 'codex_native', provider_id = ?, provider_thread_id = ?, provider_thread_path = COALESCE(?, provider_thread_path),
       provider_model = ?, provider_state = ?, provider_protocol_version = COALESCE(?, provider_protocol_version), provider_binary_version = COALESCE(?, provider_binary_version),
       agent_kind = 'pi', agent_transport = 'rpc', model_source_id = ?, model_id = ?, native_session_id = ?, native_session_path = COALESCE(?, native_session_path), updated_at = ? WHERE id = ?`,
      [
        input.providerId,
        input.providerThreadId,
        input.providerThreadPath ?? null,
        input.providerModel ?? input.modelId,
        input.providerState,
        input.providerProtocolVersion ?? null,
        input.providerBinaryVersion ?? null,
        input.modelSourceId,
        input.modelId,
        input.providerThreadId,
        input.providerThreadPath ?? null,
        timestamp,
        conversationId,
      ],
    );
    syncConversationStage(this.db, conversationId, timestamp);
    const updated = this.getById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return updated;
  }

  updateProviderThreadPath(conversationId: string, input: { providerThreadId: string; providerThreadPath: string }): ZeusConversationWithMessagesRecord {
    const updated = this.updateProviderThreadPathRecord(conversationId, input);
    return { ...updated, messages: this.listMessages(updated.id) };
  }

  /** 线程文件迁移只校验并返回主记录，不为每条历史会话加载完整消息。 */
  updateProviderThreadPathRecord(
    conversationId: string,
    input: {
      providerThreadId: string;
      providerThreadPath: string;
    },
  ): ZeusConversationRecord {
    const providerThreadPath = input.providerThreadPath;
    if (!providerThreadPath.trim()) throw new Error('Provider thread path is required.');
    this.db.execute(
      `UPDATE conversations SET provider_thread_path = ?, native_session_path = ?
      WHERE id = ? AND provider_thread_id = ?`,
      [providerThreadPath, providerThreadPath, conversationId, input.providerThreadId],
    );
    const updated = this.getRecordById(conversationId);
    if (!updated) throw new Error(`Zeus conversation not found: ${conversationId}`);
    if (updated.providerThreadId !== input.providerThreadId || updated.providerThreadPath !== providerThreadPath || updated.nativeSessionPath !== providerThreadPath) {
      throw new Error(`Zeus conversation provider thread does not match: ${conversationId}`);
    }
    return updated;
  }

  upsertProviderSettingsSnapshot(conversationId: string, snapshot: ConversationProviderSettingsSnapshot): ConversationProviderSettingsSnapshot | undefined {
    return this.upsertConversationSnapshot(conversationId, 'provider_settings_json', snapshot);
  }

  getProviderSettingsSnapshot(conversationId: string): ConversationProviderSettingsSnapshot | undefined {
    return this.getConversationSnapshot<ConversationProviderSettingsSnapshot>(conversationId, 'provider_settings_json');
  }

  upsertProviderTokenUsageSnapshot(conversationId: string, snapshot: ConversationProviderTokenUsageSnapshot): ConversationProviderTokenUsageSnapshot | undefined {
    return this.upsertConversationSnapshot(conversationId, 'provider_token_usage_json', snapshot);
  }

  /**
   * 仅供历史定价身份修复：保留 Provider 的 generation/sequence 与真实 Token，替换由旧路由写错的
   * 估算字段。普通事件仍必须走 upsertProviderTokenUsageSnapshot 的单调序列门禁。
   */
  repairProviderTokenUsagePricing(conversationId: string, snapshot: ConversationProviderTokenUsageSnapshot): ConversationProviderTokenUsageSnapshot {
    validateProviderTokenUsageSnapshot(snapshot);
    const current = this.getProviderTokenUsageSnapshot(conversationId);
    if (!current || current.generationId !== snapshot.generationId || current.sequence !== snapshot.sequence) {
      throw new Error(`Conversation token usage identity changed during pricing repair: ${conversationId}`);
    }
    this.db.execute(`UPDATE conversations SET provider_token_usage_json = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(snapshot), nowIso(), conversationId]);
    return snapshot;
  }

  getProviderTokenUsageSnapshot(conversationId: string): ConversationProviderTokenUsageSnapshot | undefined {
    const snapshot = this.getConversationSnapshot<ConversationProviderTokenUsageSnapshot & { inputTokens?: number; outputTokens?: number; totalTokens?: number }>(conversationId, 'provider_token_usage_json');
    if (!snapshot) return undefined;
    if (snapshot.total && snapshot.last) return { ...snapshot, lastApiEquivalentUsd: snapshot.lastApiEquivalentUsd ?? null };
    if ([snapshot.inputTokens, snapshot.outputTokens, snapshot.totalTokens].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
      const total: TokenUsageBreakdown = {
        totalTokens: snapshot.totalTokens!,
        inputTokens: snapshot.inputTokens!,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: snapshot.outputTokens!,
        reasoningOutputTokens: 0,
      };
      return {
        generationId: snapshot.generationId,
        sequence: snapshot.sequence,
        total,
        last: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
        modelContextWindow: null,
        cacheHitRate: null,
        estimatedCredits: null,
        apiEquivalentUsd: null,
        lastApiEquivalentUsd: null,
        cacheSavingsUsd: null,
        priceCoverage: null,
        pricingCatalogDate: null,
        pricingSourceUrls: [],
        historyComplete: false,
      };
    }
    return undefined;
  }

  private upsertConversationSnapshot<T extends ProviderSequenceSnapshot>(conversationId: string, column: 'provider_settings_json' | 'provider_token_usage_json', snapshot: T): T | undefined {
    if (column === 'provider_settings_json') validateProviderSettingsSnapshot(snapshot);
    else validateProviderTokenUsageSnapshot(snapshot);
    const current = this.getConversationSnapshot<T>(conversationId, column);
    if (!shouldAcceptProviderSnapshot(this.db, snapshot, current)) return current;
    this.db.execute(`UPDATE conversations SET ${column} = ?, updated_at = ? WHERE id = ?`, [JSON.stringify(snapshot), nowIso(), conversationId]);
    if (!this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [conversationId])) throw new Error(`Zeus conversation not found: ${conversationId}`);
    return snapshot;
  }

  private getConversationSnapshot<T extends ProviderSequenceSnapshot>(conversationId: string, column: 'provider_settings_json' | 'provider_token_usage_json'): T | undefined {
    const row = this.db.get<{ value_json: string }>(`SELECT ${column} AS value_json FROM conversations WHERE id = ?`, [conversationId]);
    if (!row) return undefined;
    try {
      const parsed = JSON.parse(row.value_json) as T;
      return typeof parsed.generationId === 'string' && typeof parsed.sequence === 'number' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  updateRuntimeState(conversationId: string, input: UpdateConversationRuntimeStateInput): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    const assignments = ['updated_at = ?'];
    const values: Array<string | number | null> = [timestamp];
    if ('sessionId' in input) {
      assignments.push('session_id = ?');
      values.push(input.sessionId ?? null);
    }
    if ('status' in input) {
      assignments.push('status = ?');
      values.push(input.status ?? existing.status);
    }
    if ('summary' in input) {
      assignments.push('summary = ?');
      values.push(input.summary ?? null);
    }
    this.db.execute(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`, [...values, conversationId]);
    syncConversationStage(this.db, conversationId, timestamp);
    const updated = this.getById(conversationId);
    if (!updated) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return updated;
  }

  /** 通用 Agent 运行态更新，不把 Pi SDK 伪装成 Codex app-server。 */
  updateAgentRuntime(conversationId: string, input: { providerState?: ConversationProviderState; status?: string; modelSourceId?: string | null; modelId?: string | null; providerModel?: string | null }): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) throw new Error(`Zeus conversation not found: ${conversationId}`);
    const timestamp = nowIso();
    const assignments = ['updated_at = ?'];
    const values: Array<string | number | null> = [timestamp];
    if (input.providerState) {
      assignments.push('provider_state = ?');
      values.push(assertEnum(input.providerState, ['unbound', 'binding', 'ready', 'active', 'waiting', 'paused', 'archived', 'closed', 'failed'] as const, 'conversation provider state'));
    }
    if (input.status) {
      assignments.push('status = ?');
      values.push(input.status);
    }
    if ('modelSourceId' in input) {
      assignments.push('model_source_id = ?');
      values.push(input.modelSourceId ?? null);
    }
    if ('modelId' in input) {
      assignments.push('model_id = ?');
      values.push(input.modelId ?? null);
    }
    if ('providerModel' in input) {
      assignments.push('provider_model = ?');
      values.push(input.providerModel ?? null);
    }
    this.db.execute(`UPDATE conversations SET ${assignments.join(', ')} WHERE id = ?`, [...values, conversationId]);
    syncConversationStage(this.db, conversationId, timestamp);
    return this.getById(conversationId)!;
  }

  listMessages(conversationId: string): ZeusConversationMessageRecord[] {
    return this.db
      .select<DbConversationMessageRow>(
        `SELECT ${selectConversationMessageFields}
       FROM conversation_messages WHERE conversation_id = ${toSqlStringLiteral(conversationId)} ORDER BY created_at ASC, id ASC`,
      )
      .map(mapConversationMessageRow);
  }

  getRecordById(conversationId: string): ZeusConversationRecord | undefined {
    const row = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE id = ?`, [conversationId]);
    return row ? mapConversationRow(row) : undefined;
  }

  getById(conversationId: string): ZeusConversationWithMessagesRecord | undefined {
    const conversation = this.getRecordById(conversationId);
    if (!conversation) return undefined;
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  getByProviderThreadId(providerThreadId: string): ZeusConversationWithMessagesRecord | undefined {
    const row = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE provider_thread_id = ? AND archived = 0`, [providerThreadId]);
    if (!row) return undefined;
    const conversation = mapConversationRow(row);
    return { ...conversation, messages: this.listMessages(conversation.id) };
  }

  /** 历史线程文件迁移只读取主记录，避免在应用启动时加载全部会话正文。 */
  listProviderThreadPathCandidates(): ZeusConversationRecord[] {
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields}
                 FROM conversations
                 WHERE transport_kind = 'codex_native'
                   AND provider_thread_id IS NOT NULL
                   AND provider_thread_path IS NOT NULL
                 ORDER BY created_at, id`,
      )
      .map(mapConversationRow);
  }

  /** 只读取已绑定原生会话元数据，供状态投影和枚举路径使用。 */
  listNativeBoundRecords(agentKind?: ConversationAgentKind): ZeusConversationRecord[] {
    const agentClause = agentKind ? ' AND agent_kind = ?' : '';
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields} FROM conversations WHERE transport_kind = 'codex_native' AND provider_thread_id IS NOT NULL AND provider_state NOT IN ('closed', 'failed') AND archived = 0${agentClause} ORDER BY created_at, id`,
        agentKind ? [agentKind] : [],
      )
      .map(mapConversationRow);
  }

  listNativeBound(agentKind?: ConversationAgentKind): ZeusConversationWithMessagesRecord[] {
    return this.listNativeBoundRecords(agentKind).map((conversation) => ({ ...conversation, messages: this.listMessages(conversation.id) }));
  }

  /** 身份修复候选包含已归档或失败会话，保证历史记录恢复后仍按原 Agent 路由。 */
  listNativeIdentityCandidates(): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE transport_kind = 'codex_native' AND provider_thread_id IS NOT NULL ORDER BY created_at, id`).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  /** 只有调用方已经核验 Pi 原生会话和消息证据时，才允许纠正被 Codex 恢复器污染的主身份。 */
  repairPiAgentIdentity(input: { conversationId: string; nativeSessionId: string; nativeSessionPath: string; modelSourceId: string }): boolean {
    this.db.execute(
      `UPDATE conversations
       SET provider_id = ?, provider_protocol_version = 'sdk',
           provider_binary_version = CASE WHEN provider_binary_version LIKE 'pi-sdk-%' THEN provider_binary_version ELSE NULL END,
           agent_kind = 'pi', agent_transport = 'sdk'
       WHERE id = ? AND transport_kind = 'codex_native' AND COALESCE(agent_kind, '') <> 'pi'
         AND provider_thread_id = native_session_id AND provider_thread_id = ?
         AND provider_thread_path = native_session_path AND native_session_path = ?
         AND model_source_id = ?
         AND EXISTS (
           SELECT 1 FROM conversation_messages
           WHERE conversation_messages.conversation_id = conversations.id
             AND conversation_messages.source = 'pi_sdk'
             AND conversation_messages.provider_thread_id = conversations.native_session_id
         )`,
      [`pi:${input.modelSourceId}`, input.conversationId, input.nativeSessionId, input.nativeSessionPath, input.modelSourceId],
    );
    return (this.db.get<{ count: number }>(`SELECT changes() AS count`)?.count ?? 0) === 1;
  }

  /** 侧边栏状态聚合只读取会话主记录，不加载消息正文。 */
  listUnarchivedRecords(): ZeusConversationRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE archived = 0 ORDER BY updated_at DESC, id DESC`).map(mapConversationRow);
  }

  /** 会话选择列表只读取主记录，避免为每条会话加载完整消息正文。 */
  listRecordsByProject(projectId: string, options: ConversationRecordListOptions = {}): ZeusConversationRecord[] {
    return this.db
      .select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE project_id = ? AND archived = ? ORDER BY stage_updated_at DESC, created_at DESC, id DESC`, [projectId, options.archived === true ? 1 : 0])
      .map(mapConversationRow);
  }

  /** 精准任务刷新沿用同一元数据投影，不再扫描项目会话或消息。 */
  listRecordsByTask(taskId: string, options: ConversationRecordListOptions = {}): ZeusConversationRecord[] {
    return this.db
      .select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE task_id = ? AND archived = ? ORDER BY stage_updated_at DESC, created_at DESC, id DESC`, [taskId, options.archived === true ? 1 : 0])
      .map(mapConversationRow);
  }

  /** Runtime 日志镜像按会话身份定位时只需要主记录，不读取历史消息。 */
  listRecordsBySessionId(sessionId: string): ZeusConversationRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE session_id = ? ORDER BY updated_at DESC, id DESC`, [sessionId]).map(mapConversationRow);
  }

  listByWorkspace(workspaceId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE workspace_id = ? AND archived = 0 ORDER BY updated_at DESC, id`, [workspaceId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  listByEnvironment(environmentId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE environment_id = ? AND archived = 0 ORDER BY updated_at DESC, id`, [environmentId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  listByTask(taskId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE task_id = ? AND archived = 0 ORDER BY updated_at DESC, id`, [taskId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  /** 父任务上下文选择需要同时看到未归档和已归档会话，不改变常规会话列表的隐藏规则。 */
  listAllByTask(taskId: string): ZeusConversationWithMessagesRecord[] {
    return this.db.select<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE task_id = ? ORDER BY created_at ASC, id`, [taskId]).map((row) => {
      const conversation = mapConversationRow(row);
      return { ...conversation, messages: this.listMessages(conversation.id) };
    });
  }

  listBySessionId(sessionId: string): ZeusConversationWithMessagesRecord[] {
    return this.db
      .select<DbConversationRow>(
        `SELECT ${selectConversationFields}
       FROM conversations WHERE session_id = ${toSqlStringLiteral(sessionId)} ORDER BY updated_at DESC, id DESC`,
      )
      .map((row) => {
        const conversation = mapConversationRow(row);
        return { ...conversation, messages: this.listMessages(conversation.id) };
      });
  }

  listByProject(projectId: string, options: ConversationListOptions = {}): ConversationListResult {
    const query = options.query?.trim().toLowerCase() ?? '';
    const limit = clampConversationLimit(options.limit);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const archived = options.archived === true;
    const allRows = this.db.select<DbConversationRow>(
      `SELECT ${selectConversationFields}
       FROM conversations WHERE project_id = ${toSqlStringLiteral(projectId)} AND archived = ${archived ? 1 : 0} ORDER BY updated_at DESC, id DESC`,
    );
    const matchedRows = allRows.filter((row) => {
      if (!query) return true;
      const messages = this.listMessages(row.id);
      // 搜索覆盖标题、摘要、会话与消息正文，避免用户记得答案片段却找不到历史记录。
      return `${row.title}\n${row.summary ?? ''}\n${row.session_id ?? ''}\n${messages.map((message) => message.content).join('\n')}`.toLowerCase().includes(query);
    });
    const rows = matchedRows.slice(offset, offset + limit);
    return {
      items: rows.map((row) => {
        const conversation = mapConversationRow(row);
        return {
          ...conversation,
          messages: this.listMessages(conversation.id),
        };
      }),
      total: matchedRows.length,
      limit,
      offset,
      query: query || null,
      archived,
    };
  }

  archive(conversationId: string): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    // 归档只隐藏会话列表，不删除消息，保证图谱问答证据链可恢复。
    this.db.execute(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ${toSqlStringLiteral(conversationId)}`, [1, timestamp]);
    syncConversationStage(this.db, conversationId, timestamp);
    const archived = this.getById(conversationId);
    if (!archived) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return archived;
  }

  restore(conversationId: string): ZeusConversationWithMessagesRecord {
    const existing = this.getById(conversationId);
    if (!existing) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    const timestamp = nowIso();
    this.db.execute(`UPDATE conversations SET archived = ?, updated_at = ? WHERE id = ${toSqlStringLiteral(conversationId)}`, [0, timestamp]);
    syncConversationStage(this.db, conversationId, timestamp);
    const restored = this.getById(conversationId);
    if (!restored) {
      throw new Error(`Zeus conversation not found: ${conversationId}`);
    }
    return restored;
  }

  listByProjectLegacy(projectId: string, limit = 20): ZeusConversationWithMessagesRecord[] {
    return this.listByProject(projectId, { limit }).items;
  }
}

export class CodexLegacyImportRepository {
  private readonly now: () => string;
  private readonly createId: () => string;

  constructor(
    private readonly db: ZeusDatabasePort,
    options: { now?: () => string; id?: () => string } = {},
  ) {
    this.now = options.now ?? nowIso;
    this.createId = options.id ?? (() => `codex_legacy_import_${nanoid(12)}`);
  }

  createRun(input: CreateCodexLegacyImportRunInput): ZeusCodexLegacyImportRecord {
    const existing = this.db.get<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE source_conversation_id = ? AND snapshot_sha256 = ?`, [input.sourceConversationId, input.snapshotSha256]);
    if (existing) return mapCodexLegacyImportRow(existing);
    if (!/^[a-f0-9]{64}$/u.test(input.snapshotSha256)) throw new Error('Codex legacy snapshot SHA-256 is invalid.');
    const source = this.db.get<{ id: string }>(`SELECT id FROM conversations WHERE id = ?`, [input.sourceConversationId]);
    if (!source) throw new Error(`Codex legacy source conversation not found: ${input.sourceConversationId}`);
    const timestamp = this.now();
    const id = this.createId();
    this.db.execute(
      `INSERT INTO codex_legacy_imports
       (id, provider_import_id, source_conversation_id, target_conversation_id, snapshot_path, snapshot_sha256, status,
        target_thread_id, failure_stage, failure_message, provider_binary_version, created_at, updated_at, started_at, completed_at)
       VALUES (?, NULL, ?, NULL, ?, ?, 'prepared', NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      [id, input.sourceConversationId, input.snapshotPath, input.snapshotSha256, input.providerBinaryVersion, timestamp, timestamp],
    );
    return this.getById(id)!;
  }

  getById(id: string): ZeusCodexLegacyImportRecord | undefined {
    const row = this.db.get<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE id = ?`, [id]);
    return row ? mapCodexLegacyImportRow(row) : undefined;
  }

  getByImportId(providerImportId: string): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE provider_import_id = ? ORDER BY created_at, id`, [providerImportId]).map(mapCodexLegacyImportRow);
  }

  listBySourceConversation(sourceConversationId: string): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE source_conversation_id = ? ORDER BY created_at DESC, id DESC`, [sourceConversationId]).map(mapCodexLegacyImportRow);
  }

  listRecoverable(): ZeusCodexLegacyImportRecord[] {
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports WHERE status IN ('prepared', 'waiting') ORDER BY created_at, id`).map(mapCodexLegacyImportRow);
  }

  listRecent(limit = 100): ZeusCodexLegacyImportRecord[] {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 500));
    return this.db.select<DbCodexLegacyImportRow>(`SELECT * FROM codex_legacy_imports ORDER BY updated_at DESC, id DESC LIMIT ?`, [safeLimit]).map(mapCodexLegacyImportRow);
  }

  markStarted(id: string, providerImportId: string): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== 'prepared') throw new Error(`Invalid Codex legacy import transition: ${record.status} -> waiting.`);
    if (!providerImportId.trim()) throw new Error('Codex legacy provider import id is required.');
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET provider_import_id = ?, status = 'waiting', failure_stage = NULL, failure_message = NULL,
       started_at = ?, updated_at = ? WHERE id = ?`,
      [providerImportId, timestamp, timestamp, id],
    );
    return this.requireById(id);
  }

  markCompleted(id: string, targetThreadId: string, targetConversationId: string): ZeusCodexLegacyImportRecord {
    const record = this.requireTransition(id, 'waiting', 'completed');
    if (!targetThreadId.trim() || !targetConversationId.trim()) throw new Error('Codex legacy import completion requires target identities.');
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET status = 'completed', target_thread_id = ?, target_conversation_id = ?,
       failure_stage = NULL, failure_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = ?`,
      [targetThreadId, targetConversationId, timestamp, timestamp, id, record.status],
    );
    return this.requireById(id);
  }

  markFailed(id: string, input: { stage: string; message: string }): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status === 'completed') throw new Error('Invalid Codex legacy import transition: completed -> failed.');
    const timestamp = this.now();
    this.db.execute(`UPDATE codex_legacy_imports SET status = 'failed', failure_stage = ?, failure_message = ?, completed_at = ?, updated_at = ? WHERE id = ?`, [input.stage, input.message, timestamp, timestamp, id]);
    return this.requireById(id);
  }

  retryFailed(id: string): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== 'failed') throw new Error(`Invalid Codex legacy import transition: ${record.status} -> prepared.`);
    const timestamp = this.now();
    this.db.execute(
      `UPDATE codex_legacy_imports SET provider_import_id = NULL, status = 'prepared', target_thread_id = NULL,
       target_conversation_id = NULL, failure_stage = NULL, failure_message = NULL, started_at = NULL,
       completed_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed'`,
      [timestamp, id],
    );
    return this.requireById(id);
  }

  bindThreadAndArchiveSource(input: { id: string; targetThreadId: string; providerBinaryVersion: string }): { run: ZeusCodexLegacyImportRecord; conversation: ZeusConversationWithMessagesRecord } {
    if (!input.targetThreadId.trim()) throw new Error('Codex legacy import target thread id is required.');
    const run = this.requireTransition(input.id, 'waiting', 'completed');
    const targetConversationId = `conversation_${nanoid(12)}`;
    this.db.transaction(() => {
      const source = this.db.get<DbConversationRow>(`SELECT ${selectConversationFields} FROM conversations WHERE id = ? AND transport_kind = 'legacy_cli' AND archived = 0`, [run.sourceConversationId]);
      if (!source) throw new Error(`Eligible Codex legacy source conversation not found: ${run.sourceConversationId}`);
      const timestamp = this.now();
      this.db.execute(
        `INSERT INTO conversations
         (id, project_id, task_id, session_id, title, summary, status, created_at, updated_at, archived,
          transport_kind, provider_id, provider_thread_id, provider_thread_path, provider_model, provider_state,
          provider_protocol_version, provider_binary_version, legacy_source_conversation_id, provider_settings_json, provider_token_usage_json,
          agent_kind, agent_transport, native_session_id)
         VALUES (?, ?, ?, NULL, ?, ?, 'open', ?, ?, 0, 'codex_native', 'codex', ?, NULL, NULL, 'ready', ?, ?, ?, '{}', '{}', 'codex', 'app_server', ?)`,
        [targetConversationId, source.project_id, source.task_id, source.title, source.summary, timestamp, timestamp, input.targetThreadId, input.providerBinaryVersion, input.providerBinaryVersion, source.id, input.targetThreadId],
      );
      const sourceMessages = this.db.select<DbConversationMessageRow>(`SELECT ${selectConversationMessageFields} FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at, id`, [source.id]);
      for (const message of sourceMessages) {
        this.db.execute(
          `INSERT INTO conversation_messages
           (id, conversation_id, role, content, source, metadata_json, created_at, provider_thread_id, provider_turn_id, provider_item_id, client_message_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            `conversation_message_${nanoid(12)}`,
            targetConversationId,
            message.role,
            message.content,
            message.source,
            message.metadata_json,
            message.created_at,
            input.targetThreadId,
            message.provider_turn_id,
            message.provider_item_id,
            message.client_message_id,
          ],
        );
      }
      this.db.execute(`UPDATE conversations SET archived = 1, updated_at = ? WHERE id = ?`, [timestamp, source.id]);
      this.db.execute(
        `UPDATE codex_legacy_imports SET status = 'completed', target_thread_id = ?, target_conversation_id = ?, provider_binary_version = ?,
         failure_stage = NULL, failure_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`,
        [input.targetThreadId, targetConversationId, input.providerBinaryVersion, timestamp, timestamp, input.id],
      );
    });
    const conversation = new ConversationRepository(this.db).getById(targetConversationId);
    if (!conversation) throw new Error(`Imported Codex conversation not found: ${targetConversationId}`);
    return { run: this.requireById(input.id), conversation };
  }

  private requireById(id: string): ZeusCodexLegacyImportRecord {
    const record = this.getById(id);
    if (!record) throw new Error(`Codex legacy import record not found: ${id}`);
    return record;
  }

  private requireTransition(id: string, from: CodexLegacyImportStatus, to: CodexLegacyImportStatus): ZeusCodexLegacyImportRecord {
    const record = this.requireById(id);
    if (record.status !== from) throw new Error(`Invalid Codex legacy import transition: ${record.status} -> ${to}.`);
    return record;
  }
}

export class ConversationGoalRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  get(conversationId: string): ZeusConversationGoalRecord | undefined {
    const row = this.db.get<{
      conversation_id: string;
      provider_thread_id: string;
      objective: string;
      status: ConversationGoalStatus;
      token_budget: number | null;
      tokens_used: number;
      time_used_seconds: number;
      provider_created_at: number;
      provider_updated_at: number;
      updated_at: string;
    }>(`SELECT * FROM conversation_goals WHERE conversation_id = ?`, [conversationId]);
    return row
      ? {
          conversationId: row.conversation_id,
          providerThreadId: row.provider_thread_id,
          objective: row.objective,
          status: assertEnum(row.status, ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const, 'conversation goal status'),
          tokenBudget: row.token_budget,
          tokensUsed: row.tokens_used,
          timeUsedSeconds: row.time_used_seconds,
          providerCreatedAt: row.provider_created_at,
          providerUpdatedAt: row.provider_updated_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  listActive(): ZeusConversationGoalRecord[] {
    const ids = this.db.select<{ conversation_id: string }>(`SELECT conversation_id FROM conversation_goals WHERE status = 'active' ORDER BY updated_at, conversation_id`);
    return ids.flatMap((row) => {
      const goal = this.get(row.conversation_id);
      return goal ? [goal] : [];
    });
  }

  upsert(goal: Omit<ZeusConversationGoalRecord, 'updatedAt'>, input: { eventKind?: ConversationGoalEventKind; providerTurnId?: string | null; occurredAt: string }): ZeusConversationGoalRecord {
    const status = assertEnum(goal.status, ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const, 'conversation goal status');
    this.db.execute(
      `INSERT INTO conversation_goals (conversation_id, provider_thread_id, objective, status, token_budget, tokens_used, time_used_seconds, provider_created_at, provider_updated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET provider_thread_id = excluded.provider_thread_id, objective = excluded.objective,
       status = excluded.status, token_budget = excluded.token_budget, tokens_used = excluded.tokens_used,
       time_used_seconds = excluded.time_used_seconds, provider_created_at = excluded.provider_created_at,
       provider_updated_at = excluded.provider_updated_at, updated_at = excluded.updated_at`,
      [goal.conversationId, goal.providerThreadId, goal.objective, status, goal.tokenBudget, goal.tokensUsed, goal.timeUsedSeconds, goal.providerCreatedAt, goal.providerUpdatedAt, input.occurredAt],
    );
    if (input.eventKind) this.appendEvent(goal.conversationId, goal.providerThreadId, input.eventKind, goal, input.providerTurnId ?? null, input.occurredAt);
    return this.get(goal.conversationId)!;
  }

  clear(input: { conversationId: string; providerThreadId: string; providerTurnId?: string | null; occurredAt: string }): boolean {
    const current = this.get(input.conversationId);
    if (!current) return false;
    this.db.execute(`DELETE FROM conversation_goals WHERE conversation_id = ?`, [input.conversationId]);
    this.appendEvent(input.conversationId, input.providerThreadId, 'cleared', current, input.providerTurnId ?? null, input.occurredAt);
    return true;
  }

  listEvents(conversationId: string): ZeusConversationGoalEventRecord[] {
    return this.db
      .select<{
        id: string;
        conversation_id: string;
        provider_thread_id: string;
        provider_turn_id: string | null;
        kind: ConversationGoalEventKind;
        objective: string | null;
        status: ConversationGoalStatus | null;
        token_budget: number | null;
        tokens_used: number | null;
        time_used_seconds: number | null;
        occurred_at: string;
      }>(`SELECT * FROM conversation_goal_events WHERE conversation_id = ? ORDER BY occurred_at, id`, [conversationId])
      .map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        providerThreadId: row.provider_thread_id,
        providerTurnId: row.provider_turn_id,
        kind: assertEnum(row.kind, ['created', 'edited', 'paused', 'resumed', 'blocked', 'usage_limited', 'budget_limited', 'completed', 'cleared'] as const, 'conversation goal event kind'),
        objective: row.objective,
        status: row.status ? assertEnum(row.status, ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const, 'conversation goal event status') : null,
        tokenBudget: row.token_budget,
        tokensUsed: row.tokens_used,
        timeUsedSeconds: row.time_used_seconds,
        occurredAt: row.occurred_at,
      }));
  }

  private appendEvent(
    conversationId: string,
    providerThreadId: string,
    kind: ConversationGoalEventKind,
    goal: Pick<ZeusConversationGoalRecord, 'objective' | 'status' | 'tokenBudget' | 'tokensUsed' | 'timeUsedSeconds'>,
    providerTurnId: string | null,
    occurredAt: string,
  ): void {
    this.db.execute(
      `INSERT INTO conversation_goal_events (id, conversation_id, provider_thread_id, provider_turn_id, kind, objective, status, token_budget, tokens_used, time_used_seconds, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`conversation_goal_event_${nanoid(12)}`, conversationId, providerThreadId, providerTurnId, kind, goal.objective, goal.status, goal.tokenBudget, goal.tokensUsed, goal.timeUsedSeconds, occurredAt],
    );
  }
}

export class ConversationTurnRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  upsert(
    input: Omit<ZeusConversationTurnRecord, 'id' | 'errorJson' | 'planJson' | 'agentKind' | 'nativeRunId'> & {
      id?: string;
      error?: unknown;
      agentKind?: ConversationAgentKind | null;
      nativeRunId?: string | null;
    },
  ): ZeusConversationTurnRecord {
    const status = assertEnum(input.status, ['queued', 'dispatching', 'running', 'waiting', 'paused', 'completed', 'interrupted', 'failed'] as const, 'conversation turn status');
    const existing = input.providerTurnId ? this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE provider_thread_id = ? AND provider_turn_id = ?`, [input.providerThreadId, input.providerTurnId]) : undefined;
    if (existing?.status === 'completed') {
      if (!existing.client_submission_id && input.clientSubmissionId) {
        this.db.execute(`UPDATE conversation_turns SET client_submission_id = ?, updated_at = ? WHERE id = ?`, [input.clientSubmissionId, input.updatedAt, existing.id]);
        return mapConversationTurnRow(this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [existing.id])!);
      }
      return mapConversationTurnRow(existing);
    }
    const id = existing?.id ?? input.id ?? `conversation_turn_${nanoid(12)}`;
    const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
    this.db.execute(
      `INSERT INTO conversation_turns (id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status, error_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider_thread_id = excluded.provider_thread_id, provider_turn_id = excluded.provider_turn_id,
       client_submission_id = COALESCE(excluded.client_submission_id, conversation_turns.client_submission_id),
       status = excluded.status, error_json = excluded.error_json, started_at = COALESCE(excluded.started_at, conversation_turns.started_at),
       completed_at = excluded.completed_at, updated_at = excluded.updated_at, agent_kind = excluded.agent_kind, native_run_id = COALESCE(excluded.native_run_id, conversation_turns.native_run_id)`,
      [
        id,
        input.conversationId,
        input.providerThreadId,
        input.providerTurnId,
        input.clientSubmissionId,
        status,
        errorJson,
        input.startedAt,
        input.completedAt,
        input.createdAt,
        input.updatedAt,
        input.agentKind ?? 'codex',
        input.nativeRunId ?? input.providerTurnId,
      ],
    );
    syncConversationStage(this.db, input.conversationId, input.updatedAt);
    return mapConversationTurnRow(this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [id])!);
  }

  getById(id: string): ZeusConversationTurnRecord | undefined {
    const row = this.db.get<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE id = ?`, [id]);
    return row ? mapConversationTurnRow(row) : undefined;
  }

  updatePlan(
    id: string,
    plan: {
      explanation: string | null;
      steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>;
    },
    updatedAt: string,
  ): ZeusConversationTurnRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation turn not found: ${id}`);
    const planJson = JSON.stringify(plan);
    this.db.execute(`UPDATE conversation_turns SET plan_json = ?, updated_at = ? WHERE id = ?`, [planJson, updatedAt, id]);
    return this.getById(id)!;
  }

  listByConversation(conversationId: string): ZeusConversationTurnRecord[] {
    return this.db.select<DbConversationTurnRow>(`SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationTurnRow);
  }

  /** 启动恢复只枚举尚未产生计划操作的计划轮次，避免逐会话读取全部历史轮次和提交。 */
  listCompletedPlanRecoveryCandidates(agentKind: ConversationAgentKind): ZeusConversationTurnRecord[] {
    return this.db
      .select<DbConversationTurnRow>(
        `SELECT turn.*
           FROM conversation_turns turn
           JOIN conversations conversation ON conversation.id = turn.conversation_id
           JOIN conversation_submissions submission ON submission.id = turn.client_submission_id
          WHERE conversation.transport_kind = 'codex_native'
            AND conversation.provider_thread_id IS NOT NULL
            AND conversation.provider_state NOT IN ('closed', 'failed')
            AND conversation.archived = 0
            AND conversation.agent_kind = ?
            AND turn.status = 'completed'
            AND json_extract(submission.input_json, '$.context.workMode') = 'plan'
            AND NOT EXISTS (SELECT 1 FROM conversation_plan_actions action WHERE action.turn_id = turn.id)
          ORDER BY turn.created_at, turn.id`,
        [agentKind],
      )
      .map(mapConversationTurnRow);
  }

  getLatestActiveByConversation(conversationId: string): ZeusConversationTurnRecord | undefined {
    const row = this.db.get<DbConversationTurnRow>(
      `SELECT id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
              NULL AS error_json, NULL AS plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id
         FROM conversation_turns
        WHERE conversation_id = ? AND status IN ('running', 'dispatching', 'waiting')
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [conversationId],
    );
    return row ? mapConversationTurnRow(row) : undefined;
  }

  /** 批量投影会话运行态时不加载错误和计划正文，避免逐会话查询与大 JSON 放大。 */
  listInProgress(): ZeusConversationTurnRecord[] {
    return this.db
      .select<DbConversationTurnRow>(
        `SELECT id, conversation_id, provider_thread_id, provider_turn_id, client_submission_id, status,
                NULL AS error_json, NULL AS plan_json, started_at, completed_at, created_at, updated_at, agent_kind, native_run_id
         FROM conversation_turns
         WHERE status IN ('queued', 'dispatching', 'running', 'waiting', 'paused')
         ORDER BY conversation_id, created_at, id`,
      )
      .map(mapConversationTurnRow);
  }
}

export class ConversationProviderSyncCheckpointRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  getByConversation(conversationId: string): ZeusConversationProviderSyncCheckpointRecord | undefined {
    const row = this.db.get<DbConversationProviderSyncCheckpointRow>(`SELECT * FROM conversation_provider_sync_checkpoints WHERE conversation_id = ?`, [conversationId]);
    return row ? mapConversationProviderSyncCheckpointRow(row) : undefined;
  }

  initialize(input: { conversationId: string; providerThreadId: string; baselineTurnId: string | null; timestamp: string }): ZeusConversationProviderSyncCheckpointRecord {
    this.db.execute(
      `INSERT INTO conversation_provider_sync_checkpoints
         (conversation_id, provider_thread_id, baseline_turn_id, last_synced_turn_id, initialized_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO NOTHING`,
      [input.conversationId, input.providerThreadId, input.baselineTurnId, input.baselineTurnId, input.timestamp, input.timestamp],
    );
    const checkpoint = this.getByConversation(input.conversationId);
    if (!checkpoint) throw new Error(`Provider 同步检查点创建失败：${input.conversationId}`);
    if (checkpoint.providerThreadId !== input.providerThreadId) throw new Error(`Provider 同步检查点线程身份冲突：${input.conversationId}`);
    return checkpoint;
  }

  /** 产品会话切换到新的 Codex 分段时，检查点随当前原生线程重新建立边界。 */
  rebind(input: { conversationId: string; providerThreadId: string; baselineTurnId: string | null; timestamp: string }): ZeusConversationProviderSyncCheckpointRecord {
    this.db.execute(
      `UPDATE conversation_provider_sync_checkpoints
          SET provider_thread_id = ?, baseline_turn_id = ?, last_synced_turn_id = ?,
              initialized_at = ?, updated_at = ?
        WHERE conversation_id = ?`,
      [input.providerThreadId, input.baselineTurnId, input.baselineTurnId, input.timestamp, input.timestamp, input.conversationId],
    );
    const checkpoint = this.getByConversation(input.conversationId);
    if (!checkpoint) throw new Error(`Provider 同步检查点重建失败：${input.conversationId}`);
    if (checkpoint.providerThreadId !== input.providerThreadId) throw new Error(`Provider 同步检查点线程身份冲突：${input.conversationId}`);
    return checkpoint;
  }

  advance(input: { conversationId: string; providerThreadId: string; lastSyncedTurnId: string; timestamp: string }): ZeusConversationProviderSyncCheckpointRecord {
    const checkpoint = this.getByConversation(input.conversationId);
    if (!checkpoint) throw new Error(`Provider 同步检查点不存在：${input.conversationId}`);
    if (checkpoint.providerThreadId !== input.providerThreadId) throw new Error(`Provider 同步检查点线程身份冲突：${input.conversationId}`);
    this.db.execute(`UPDATE conversation_provider_sync_checkpoints SET last_synced_turn_id = ?, updated_at = ? WHERE conversation_id = ?`, [input.lastSyncedTurnId, input.timestamp, input.conversationId]);
    return this.getByConversation(input.conversationId)!;
  }
}

/** 供应源用量账本不建立外键，被引用对象删除后仍保留真实历史消耗。 */
export class CodexUsageLedgerRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  upsert(input: UpsertCodexUsageLedgerInput): CodexUsageLedgerRecord {
    validateTokenUsageBreakdown(input.usage);
    if (input.providerBaseline) validateTokenUsageBreakdown(input.providerBaseline);
    if (input.providerTotal) validateTokenUsageBreakdown(input.providerTotal);
    validateCodexUsageEstimate(input.estimate);
    if (![input.providerId, input.accountScopeId, input.projectId, input.conversationId, input.providerThreadId, input.providerTurnId, input.model].every((value) => value.trim())) {
      throw new Error('Usage ledger identity is incomplete');
    }
    const existing = this.findByProviderTurn(input.providerId, input.providerThreadId, input.providerTurnId);
    const timestamp = nowIso();
    const id = existing?.id ?? `codex_usage_${nanoid(12)}`;
    const createdAt = existing?.createdAt ?? timestamp;
    this.db.execute(
      `INSERT INTO codex_usage_ledger
         (id, provider_id, account_scope_id, project_id, conversation_id, provider_thread_id, provider_turn_id, model, service_tier,
          total_tokens, input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens,
          provider_baseline_json, provider_total_json, usage_complete, estimate_json, occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, provider_thread_id, provider_turn_id) DO UPDATE SET
         account_scope_id = excluded.account_scope_id,
         project_id = excluded.project_id,
         conversation_id = excluded.conversation_id,
         model = excluded.model,
         service_tier = excluded.service_tier,
         total_tokens = excluded.total_tokens,
         input_tokens = excluded.input_tokens,
         cached_input_tokens = excluded.cached_input_tokens,
         cache_write_input_tokens = excluded.cache_write_input_tokens,
         output_tokens = excluded.output_tokens,
         reasoning_output_tokens = excluded.reasoning_output_tokens,
         provider_baseline_json = excluded.provider_baseline_json,
         provider_total_json = excluded.provider_total_json,
         usage_complete = excluded.usage_complete,
         estimate_json = excluded.estimate_json,
         occurred_at = excluded.occurred_at,
         updated_at = excluded.updated_at`,
      [
        id,
        input.providerId,
        input.accountScopeId,
        input.projectId,
        input.conversationId,
        input.providerThreadId,
        input.providerTurnId,
        input.model,
        input.serviceTier ?? null,
        input.usage.totalTokens,
        input.usage.inputTokens,
        input.usage.cachedInputTokens,
        input.usage.cacheWriteInputTokens,
        input.usage.outputTokens,
        input.usage.reasoningOutputTokens,
        input.providerBaseline ? JSON.stringify(input.providerBaseline) : null,
        input.providerTotal ? JSON.stringify(input.providerTotal) : null,
        input.usageComplete === true ? 1 : 0,
        JSON.stringify(input.estimate),
        input.occurredAt,
        createdAt,
        timestamp,
      ],
    );
    return this.findByProviderTurn(input.providerId, input.providerThreadId, input.providerTurnId)!;
  }

  findByProviderTurn(providerId: string, providerThreadId: string, providerTurnId: string): CodexUsageLedgerRecord | undefined {
    const row = this.db.get<DbCodexUsageLedgerRow>(`SELECT * FROM codex_usage_ledger WHERE provider_id = ? AND provider_thread_id = ? AND provider_turn_id = ?`, [providerId, providerThreadId, providerTurnId]);
    return row ? mapCodexUsageLedgerRow(row) : undefined;
  }

  deleteById(id: string): void {
    this.db.execute(`DELETE FROM codex_usage_ledger WHERE id = ?`, [id]);
  }

  list(input: ListCodexUsageLedgerInput = {}): CodexUsageLedgerRecord[] {
    const clauses: string[] = [];
    const values: SQLInputValue[] = [];
    if (input.providerId) {
      clauses.push('provider_id = ?');
      values.push(input.providerId);
    }
    if (input.providerThreadId) {
      clauses.push('provider_thread_id = ?');
      values.push(input.providerThreadId);
    }
    if (input.accountScopeId) {
      clauses.push('account_scope_id = ?');
      values.push(input.accountScopeId);
    }
    if (input.since) {
      clauses.push('occurred_at >= ?');
      values.push(input.since);
    }
    if (input.projectId) {
      clauses.push('project_id = ?');
      values.push(input.projectId);
    }
    if (input.model) {
      clauses.push('model = ?');
      values.push(input.model);
    }
    if (input.conversationId) {
      clauses.push('conversation_id = ?');
      values.push(input.conversationId);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return this.db.select<DbCodexUsageLedgerRow>(`SELECT * FROM codex_usage_ledger${where} ORDER BY occurred_at ASC, id ASC`, values).map(mapCodexUsageLedgerRow);
  }

  collectionStartedAt(accountScopeId?: string | null): string | null {
    return accountScopeId
      ? (this.db.get<{ occurred_at: string }>(`SELECT occurred_at FROM codex_usage_ledger WHERE account_scope_id = ? ORDER BY occurred_at ASC, id ASC LIMIT 1`, [accountScopeId])?.occurred_at ?? null)
      : (this.db.get<{ occurred_at: string }>(`SELECT occurred_at FROM codex_usage_ledger ORDER BY occurred_at ASC, id ASC LIMIT 1`)?.occurred_at ?? null);
  }
}

export class ConversationResourceRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  replaceForItem(itemId: string, resources: Array<Omit<ZeusConversationResourceRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }>, updatedAt: string): ZeusConversationResourceRecord[] {
    return this.db.transaction(() => {
      this.db.execute(`DELETE FROM conversation_resources WHERE item_id = ?`, [itemId]);
      for (const resource of resources) {
        const kind = assertEnum(resource.kind, ['file', 'website', 'attachment'] as const, 'conversation resource kind');
        const presentation = assertEnum(resource.presentation, ['inline', 'card'] as const, 'conversation resource presentation');
        this.db.execute(
          `INSERT INTO conversation_resources
             (id, project_id, conversation_id, turn_id, item_id, source_index, canonical_target_digest,
              kind, presentation, display_json, target_json, authority_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            resource.id ?? `conversation_resource_${nanoid(12)}`,
            resource.projectId,
            resource.conversationId,
            resource.turnId,
            itemId,
            resource.sourceIndex,
            resource.canonicalTargetDigest,
            kind,
            presentation,
            resource.displayJson,
            resource.targetJson,
            resource.authorityJson,
            updatedAt,
            updatedAt,
          ],
        );
      }
      return this.listByItem(itemId);
    });
  }

  getById(id: string): ZeusConversationResourceRecord | undefined {
    const row = this.db.get<DbConversationResourceRow>(`SELECT * FROM conversation_resources WHERE id = ?`, [id]);
    return row ? mapConversationResourceRow(row) : undefined;
  }

  listByItem(itemId: string): ZeusConversationResourceRecord[] {
    return this.db.select<DbConversationResourceRow>(`SELECT * FROM conversation_resources WHERE item_id = ? ORDER BY source_index, id`, [itemId]).map(mapConversationResourceRow);
  }

  listByConversation(conversationId: string): ZeusConversationResourceRecord[] {
    return this.db.select<DbConversationResourceRow>(`SELECT * FROM conversation_resources WHERE conversation_id = ? ORDER BY created_at, source_index, id`, [conversationId]).map(mapConversationResourceRow);
  }
}

export class ConversationSubmissionRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  createOrGet(input: {
    id?: string;
    conversationId: string;
    idempotencyKey: string;
    requestHash: string;
    clientMessageId: string;
    kind: ConversationSubmissionKind;
    requestedDelivery: ConversationRequestedDelivery;
    status: ConversationSubmissionStatus;
    queuePosition?: number | null;
    input: unknown;
    targetProviderTurnId?: string | null;
    providerTurnId?: string | null;
    pausedReason?: string | null;
    error?: unknown;
    createdAt: string;
    dispatchedAt?: string | null;
    resolvedAt?: string | null;
    replacementOfSubmissionId?: string | null;
    replacementReason?: string | null;
    executionSnapshotId?: string | null;
  }): ZeusConversationSubmissionRecord {
    const kind = assertEnum(input.kind, ['message', 'steer'] as const, 'conversation submission kind');
    const requestedDelivery = assertEnum(input.requestedDelivery, ['queue', 'send_now'] as const, 'conversation submission requested delivery');
    const status = assertEnum(input.status, ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'] as const, 'conversation submission status');
    const existing = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? AND idempotency_key = ?`, [input.conversationId, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== input.requestHash || (input.id !== undefined && existing.id !== input.id)) throwIdempotencyConflict(input.conversationId, input.idempotencyKey);
      return mapConversationSubmissionRow(existing);
    }
    const id = input.id ?? `conversation_submission_${nanoid(12)}`;
    const errorJson = input.error === undefined ? null : JSON.stringify(input.error);
    this.db.execute(
      `INSERT INTO conversation_submissions (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery, status, queue_position, input_json, target_provider_turn_id, provider_turn_id, paused_reason, error_json, created_at, updated_at, dispatched_at, resolved_at, replacement_of_submission_id, replacement_reason, execution_snapshot_id, submission_outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.conversationId,
        input.idempotencyKey,
        input.requestHash,
        input.clientMessageId,
        kind,
        requestedDelivery,
        status,
        input.queuePosition ?? null,
        JSON.stringify(input.input),
        input.targetProviderTurnId ?? null,
        input.providerTurnId ?? null,
        input.pausedReason ?? null,
        errorJson,
        input.createdAt,
        input.createdAt,
        input.dispatchedAt ?? null,
        input.resolvedAt ?? null,
        input.replacementOfSubmissionId ?? null,
        input.replacementReason ?? null,
        input.executionSnapshotId ?? null,
        input.status === 'paused' || input.status === 'failed' ? 'paused' : 'queued',
      ],
    );
    syncConversationStage(this.db, input.conversationId, input.createdAt);
    return this.getById(id)!;
  }

  getById(id: string): ZeusConversationSubmissionRecord | undefined {
    const row = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE id = ?`, [id]);
    return row ? mapConversationSubmissionRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationSubmissionRecord[] {
    return this.db.select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? ORDER BY queue_position, created_at, id`, [conversationId]).map(mapConversationSubmissionRow);
  }

  getFirstByConversation(conversationId: string): ZeusConversationSubmissionRecord | undefined {
    const row = this.db.get<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? ORDER BY created_at, id LIMIT 1`, [conversationId]);
    return row ? mapConversationSubmissionRow(row) : undefined;
  }

  listQueueByConversation(conversationId: string): ZeusConversationSubmissionRecord[] {
    return this.db
      .select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE conversation_id = ? AND status IN ('queued', 'paused') ORDER BY queue_position, created_at, id`, [conversationId])
      .map(mapConversationSubmissionRow);
  }

  listRecoverable(): ZeusConversationSubmissionRecord[] {
    return this.db
      .select<DbConversationSubmissionRow>(`SELECT * FROM conversation_submissions WHERE status IN ('queued', 'dispatching', 'active', 'paused') ORDER BY conversation_id, queue_position, created_at, id`)
      .map(mapConversationSubmissionRow);
  }

  createReplacement(
    id: string,
    input: {
      requestHash: string;
      input: unknown;
      reason: 'edit' | 'reroute' | 'retry' | 'steer_replacement' | 'release_hold';
      idempotencyKey?: string;
      clientMessageId?: string;
      kind?: ConversationSubmissionKind;
      requestedDelivery?: ConversationRequestedDelivery;
      targetProviderTurnId?: string | null;
      inheritExecutionSnapshot?: boolean;
      updatedAt?: string;
    },
  ): ZeusConversationSubmissionRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation submission not found: ${id}`);
    if (existing.status !== 'queued' && existing.status !== 'paused' && existing.status !== 'failed') {
      throw Object.assign(new Error('Only queued, paused, or failed submissions can be edited.'), { code: 'ZEUS_NATIVE_SUBMISSION_NOT_EDITABLE' as const });
    }
    const updatedAt = input.updatedAt ?? nowIso();
    const replacementId = `conversation_submission_${nanoid(12)}`;
    const replacementStatus = input.reason === 'retry' || input.reason === 'reroute' ? 'queued' : existing.status === 'failed' ? 'paused' : existing.status;
    const replacementPausedReason = replacementStatus === 'paused' ? existing.pausedReason : null;
    this.db.transaction(() => {
      this.db.execute(
        `UPDATE conversation_submissions
            SET status = 'cancelled', submission_outcome = 'terminal', resolved_at = ?, updated_at = ?
          WHERE id = ?`,
        [updatedAt, updatedAt, existing.id],
      );
      this.db.execute(
        `INSERT INTO conversation_submissions
         (id, conversation_id, idempotency_key, request_hash, client_message_id, kind, requested_delivery,
          status, queue_position, input_json, target_provider_turn_id, provider_turn_id, paused_reason,
          error_json, created_at, updated_at, dispatched_at, resolved_at, replacement_of_submission_id,
          replacement_reason, execution_snapshot_id, segment_id, submission_outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, NULL, ?)`,
        [
          replacementId,
          existing.conversationId,
          input.idempotencyKey ?? `${existing.idempotencyKey}:replacement:${replacementId}`,
          input.requestHash,
          input.clientMessageId ?? `replacement-client-${nanoid(16)}`,
          input.kind ?? existing.kind,
          input.requestedDelivery ?? existing.requestedDelivery,
          replacementStatus,
          existing.queuePosition,
          JSON.stringify(input.input),
          input.targetProviderTurnId === undefined ? existing.targetProviderTurnId : input.targetProviderTurnId,
          replacementPausedReason,
          updatedAt,
          updatedAt,
          existing.id,
          input.reason,
          input.inheritExecutionSnapshot === false ? null : existing.executionSnapshotId,
          replacementStatus === 'paused' ? 'paused' : 'queued',
        ],
      );
    });
    syncConversationStage(this.db, existing.conversationId, updatedAt);
    return this.getById(replacementId)!;
  }

  reorderQueued(conversationId: string, orderedSubmissionIds: readonly string[], updatedAt = nowIso()): ZeusConversationSubmissionRecord[] {
    const queued = this.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
    if (orderedSubmissionIds.length !== queued.length || new Set(orderedSubmissionIds).size !== queued.length || orderedSubmissionIds.some((id) => !queued.some((entry) => entry.id === id))) {
      throw Object.assign(new Error('Queued submission reorder must contain every queued or paused submission exactly once.'), { code: 'ZEUS_NATIVE_QUEUE_REORDER_INVALID' as const });
    }
    this.db.transaction(() => {
      orderedSubmissionIds.forEach((id, index) => this.db.execute(`UPDATE conversation_submissions SET queue_position = ?, updated_at = ? WHERE id = ? AND conversation_id = ?`, [index + 1, updatedAt, id, conversationId]));
    });
    return this.listByConversation(conversationId).filter((entry) => entry.status === 'queued' || entry.status === 'paused' || entry.status === 'failed');
  }

  updateStatus(
    id: string,
    statusValue: ConversationSubmissionStatus,
    input: {
      providerTurnId?: string | null;
      pausedReason?: string | null;
      error?: unknown;
      dispatchedAt?: string | null;
      resolvedAt?: string | null;
      updatedAt?: string;
      preserveError?: boolean;
      preserveSubmissionOutcome?: boolean;
    } = {},
  ): ZeusConversationSubmissionRecord {
    const status = assertEnum(statusValue, ['queued', 'dispatching', 'active', 'paused', 'completed', 'resolved', 'failed', 'cancelled', 'deleted'] as const, 'conversation submission status');
    const updatedAt = input.updatedAt ?? nowIso();
    this.db.execute(
      `UPDATE conversation_submissions
          SET status = ?, provider_turn_id = COALESCE(?, provider_turn_id), paused_reason = ?,
              error_json = CASE WHEN ? THEN error_json ELSE ? END,
              dispatched_at = COALESCE(?, dispatched_at), resolved_at = COALESCE(?, resolved_at), updated_at = ?,
              submission_outcome = CASE WHEN ? THEN submission_outcome ELSE CASE
                  WHEN ? IN ('active', 'resolved', 'completed') THEN CASE WHEN ? = 'active' THEN 'accepted' ELSE 'terminal' END
                  WHEN ? IN ('paused', 'failed') THEN 'paused'
                  WHEN ? IN ('cancelled', 'deleted') THEN 'terminal'
                  ELSE 'queued'
                END
              END
        WHERE id = ?`,
      [
        status,
        input.providerTurnId ?? null,
        input.pausedReason ?? null,
        input.preserveError === true ? 1 : 0,
        input.error === undefined ? null : JSON.stringify(input.error),
        input.dispatchedAt ?? null,
        input.resolvedAt ?? null,
        updatedAt,
        input.preserveSubmissionOutcome === true ? 1 : 0,
        status,
        status,
        status,
        status,
        id,
      ],
    );
    const updated = this.getById(id);
    if (!updated) throw new Error(`Conversation submission not found: ${id}`);
    syncConversationStage(this.db, updated.conversationId, updatedAt);
    return updated;
  }

  requeueRejectedSteer(id: string, updatedAt = nowIso()): ZeusConversationSubmissionRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation submission not found: ${id}`);
    const parsedInput = parseStoredJson(existing.inputJson);
    if (!isPlainRecord(parsedInput)) throw new Error(`Conversation submission input is invalid: ${id}`);
    // Provider 明确拒绝已结束轮次的 steer 时，原提交保持审计事实，改由关联 replacement 进入普通队列。
    const replacement = this.createReplacement(id, {
      requestHash: createHash('sha256')
        .update(JSON.stringify({ ...parsedInput, delivery: 'queue', expectedTurnId: null }))
        .digest('hex'),
      input: { ...parsedInput, delivery: 'queue', expectedTurnId: null },
      reason: 'steer_replacement',
      kind: 'message',
      requestedDelivery: 'queue',
      targetProviderTurnId: null,
      updatedAt,
    });
    return replacement;
  }
}

export class ConversationServerRequestRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  upsert(input: {
    conversationId: string;
    turnId?: string | null;
    itemId?: string | null;
    transportGenerationId: string;
    providerRequestId: string | number;
    requestKind: ConversationServerRequestKind;
    payload: unknown;
    status: ConversationServerRequestStatus;
    response?: unknown;
    containsSecret?: boolean;
    expiresAt?: string | null;
    autoResolutionState?: ConversationRequestAutoResolutionState;
    createdAt: string;
    resolvedAt?: string | null;
  }): ZeusConversationServerRequestRecord {
    const requestKind = assertEnum(input.requestKind, ['command', 'file', 'permissions', 'request_user_input', 'mcp'] as const, 'conversation server request kind');
    const status = assertEnum(input.status, ['pending', 'resolved', 'declined', 'expired', 'failed'] as const, 'conversation server request status');
    const providerRequestIdJson = serializeProviderRequestId(input.providerRequestId);
    const existing = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [input.transportGenerationId, providerRequestIdJson]);
    const persistedPayload = parseStoredJson(existing?.payload_json);
    const containsSecret = input.containsSecret === true || existing?.contains_secret === 1 || hasSecretUserInputQuestion(input.payload) || hasSecretUserInputQuestion(persistedPayload);
    const payload = containsSecret ? redactSecretValues(input.payload) : input.payload;
    if (existing) {
      assertConversationServerRequestIdentity(existing, requestKind, payload, containsSecret);
      return mapConversationServerRequestRow(existing);
    }
    const id = `conversation_server_request_${nanoid(12)}`;
    const response = containsSecret && input.response !== undefined ? createSecretResponseSummary(input.payload, input.response) : input.response;
    this.db.execute(
      `INSERT INTO conversation_server_requests (id, conversation_id, turn_id, item_id, transport_generation_id, provider_request_id_json, request_kind, payload_json, status, response_json, contains_secret, expires_at, auto_resolution_state, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(transport_generation_id, provider_request_id_json) DO NOTHING`,
      [
        id,
        input.conversationId,
        input.turnId ?? null,
        input.itemId ?? null,
        input.transportGenerationId,
        providerRequestIdJson,
        requestKind,
        JSON.stringify(payload),
        status,
        response === undefined ? null : JSON.stringify(response),
        containsSecret ? 1 : 0,
        input.expiresAt ?? null,
        assertEnum(input.autoResolutionState ?? 'none', ['none', 'scheduled', 'snoozed'] as const, 'request auto resolution state'),
        input.createdAt,
        input.resolvedAt ?? null,
      ],
    );
    const stored = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [input.transportGenerationId, providerRequestIdJson]);
    if (!stored) throw new Error('Conversation server request insert did not persist a record.');
    assertConversationServerRequestIdentity(stored, requestKind, payload, containsSecret);
    syncConversationStage(this.db, input.conversationId, input.createdAt);
    return mapConversationServerRequestRow(stored);
  }

  resolve(id: string, input: { response: unknown; isSecret?: boolean; questionIds?: string[]; answerCount?: number; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    const persistedPayload = parseStoredJson(existing.payloadJson);
    const secret = input.isSecret === true || existing.containsSecret || hasSecretUserInputQuestion(persistedPayload);
    const responseJson = secret ? JSON.stringify(createSecretResponseSummary(persistedPayload, input.response, input.questionIds, input.answerCount)) : JSON.stringify(input.response);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'resolved', response_json = ?, contains_secret = ?, resolved_at = ? WHERE id = ?`, [responseJson, secret ? 1 : 0, input.resolvedAt, id]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  /**
   * 宿主升级会终止旧 app-server 的瞬时请求通道，但用户仍需在同一 Zeus 会话中继续作答。
   * 这里只恢复待处理投影并写入明确交接标记；真正回复时必须重新校验原请求与用户答案。
   */
  restorePendingAfterHostHandoff(id: string, input: { sourceInstanceId: string; capturedAt: string; restoredAt: string }): ZeusConversationServerRequestRecord {
    return this.restorePendingAfterTransportRecovery(id, {
      recoveryReason: 'host_handoff',
      sourceInstanceId: input.sourceInstanceId,
      capturedAt: input.capturedAt,
      restoredAt: input.restoredAt,
    });
  }

  /**
   * app-server 请求通道退出后，旧请求不能再通过原 RPC 作答，但仍可作为一次显式续接的恢复点。
   * 该标记只恢复 Zeus 侧交互，不会把旧请求伪装成当前 app-server 的有效请求。
   */
  restorePendingAfterTransportRecovery(
    id: string,
    input: {
      recoveryReason: 'host_handoff' | 'app_server_generation_changed';
      restoredAt: string;
      sourceInstanceId?: string;
      capturedAt?: string;
      sourceGenerationId?: string;
      currentGenerationId?: string | null;
    },
  ): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(
      `UPDATE conversation_server_requests
       SET status = 'pending', response_json = ?, resolved_at = NULL, auto_resolution_state = 'none'
       WHERE id = ?`,
      [
        JSON.stringify({
          interactionRecoveryCheckpoint: true,
          recoveryReason: input.recoveryReason,
          ...(input.recoveryReason === 'host_handoff' ? { handoffCheckpoint: true } : {}),
          ...(input.sourceInstanceId ? { sourceInstanceId: input.sourceInstanceId } : {}),
          ...(input.capturedAt ? { capturedAt: input.capturedAt } : {}),
          ...(input.sourceGenerationId ? { sourceGenerationId: input.sourceGenerationId } : {}),
          ...(input.currentGenerationId !== undefined ? { currentGenerationId: input.currentGenerationId } : {}),
          restoredAt: input.restoredAt,
        }),
        id,
      ],
    );
    syncConversationStage(this.db, existing.conversationId, input.restoredAt);
    return this.getById(id)!;
  }

  /** 记录请求已由 Codex 的其他已授权客户端回答；Zeus 不持久化它看不到的答案正文。 */
  resolveExternally(
    id: string,
    input: {
      source: 'codex_remote_control' | 'provider';
      resolvedAt: string;
      answerRecovery?: 'rollout_path_unavailable' | 'rollout_thread_mismatch' | 'request_call_missing' | 'request_call_ambiguous' | 'answer_output_missing' | 'answer_output_ambiguous' | 'answer_output_invalid';
    },
  ): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'resolved', response_json = ?, resolved_at = ? WHERE id = ? AND status = 'pending'`, [
      JSON.stringify({ type: 'external_resolution', source: input.source, ...(input.answerRecovery ? { answerRecovery: input.answerRecovery } : {}) }),
      input.resolvedAt,
      id,
    ]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  fail(id: string, input: { error: unknown; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'failed', response_json = ?, resolved_at = ? WHERE id = ?`, [JSON.stringify(input.error), input.resolvedAt, id]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  expire(id: string, input: { response: unknown; resolvedAt: string }): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    this.db.execute(`UPDATE conversation_server_requests SET status = 'expired', response_json = ?, resolved_at = ? WHERE id = ? AND status IN ('pending', 'resolved')`, [JSON.stringify(input.response), input.resolvedAt, id]);
    syncConversationStage(this.db, existing.conversationId, input.resolvedAt);
    return this.getById(id)!;
  }

  snooze(id: string): ZeusConversationServerRequestRecord {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Conversation server request not found: ${id}`);
    if (existing.status !== 'pending') throw Object.assign(new Error('Only a pending request can be snoozed.'), { code: 'ZEUS_CODEX_SERVER_REQUEST_NOT_PENDING' as const });
    this.db.execute(`UPDATE conversation_server_requests SET auto_resolution_state = 'snoozed', expires_at = NULL WHERE id = ?`, [id]);
    return this.getById(id)!;
  }

  getById(id: string): ZeusConversationServerRequestRecord | undefined {
    const row = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE id = ?`, [id]);
    return row ? mapConversationServerRequestRow(row) : undefined;
  }

  getByProvider(transportGenerationId: string, providerRequestId: string | number): ZeusConversationServerRequestRecord | undefined {
    const row = this.db.get<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE transport_generation_id = ? AND provider_request_id_json = ?`, [
      transportGenerationId,
      serializeProviderRequestId(providerRequestId),
    ]);
    return row ? mapConversationServerRequestRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationServerRequestRow);
  }

  listPendingByConversation(conversationId: string): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at, id`, [conversationId]).map(mapConversationServerRequestRow);
  }

  listPending(): ZeusConversationServerRequestRecord[] {
    return this.db.select<DbConversationServerRequestRow>(`SELECT * FROM conversation_server_requests WHERE status = 'pending' ORDER BY created_at, id`).map(mapConversationServerRequestRow);
  }
}

export class ConversationPlanActionRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  createPending(input: { conversationId: string; turnId: string; planItemId: string; createdAt: string }): ZeusConversationPlanActionRecord {
    const existing = this.db.get<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE plan_item_id = ?`, [input.planItemId]);
    if (existing) return mapConversationPlanActionRow(existing);
    return this.db.transaction(() => {
      this.db.execute(`UPDATE conversation_plan_actions SET status = 'superseded', resolved_at = ?, updated_at = ? WHERE conversation_id = ? AND status IN ('pending', 'refinement_requested')`, [
        input.createdAt,
        input.createdAt,
        input.conversationId,
      ]);
      const id = `conversation_plan_action_${nanoid(12)}`;
      this.db.execute(
        `INSERT INTO conversation_plan_actions (id, conversation_id, turn_id, plan_item_id, status, submission_id, created_at, resolved_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, ?, NULL, ?)`,
        [id, input.conversationId, input.turnId, input.planItemId, input.createdAt, input.createdAt],
      );
      const created = this.getById(id)!;
      syncConversationStage(this.db, input.conversationId, input.createdAt);
      return created;
    });
  }

  getById(id: string): ZeusConversationPlanActionRecord | undefined {
    const row = this.db.get<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE id = ?`, [id]);
    return row ? mapConversationPlanActionRow(row) : undefined;
  }

  getLatestPending(conversationId: string): ZeusConversationPlanActionRecord | undefined {
    const row = this.db.get<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE conversation_id = ? AND status = 'pending' ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId]);
    return row ? mapConversationPlanActionRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationPlanActionRecord[] {
    return this.db.select<DbConversationPlanActionRow>(`SELECT * FROM conversation_plan_actions WHERE conversation_id = ? ORDER BY created_at, id`, [conversationId]).map(mapConversationPlanActionRow);
  }

  resolveLatestPending(
    id: string,
    conversationId: string,
    input: {
      status: Exclude<ConversationPlanActionStatus, 'pending' | 'superseded'>;
      submissionId?: string | null;
      resolvedAt: string;
    },
  ): ZeusConversationPlanActionRecord {
    const status = assertEnum(input.status, ['dismissed', 'implemented', 'refinement_requested'] as const, 'conversation plan action resolution');
    return this.db.transaction(() =>
      this.resolveLatestPendingInCurrentTransaction(id, conversationId, {
        ...input,
        status,
      }),
    );
  }

  /** 仅供已经持有 ZeusDatabasePort transaction 的领域操作组合调用。 */
  resolveLatestPendingInCurrentTransaction(
    id: string,
    conversationId: string,
    input: {
      status: Exclude<ConversationPlanActionStatus, 'pending' | 'superseded'>;
      submissionId?: string | null;
      resolvedAt: string;
    },
  ): ZeusConversationPlanActionRecord {
    const status = assertEnum(input.status, ['dismissed', 'implemented', 'refinement_requested'] as const, 'conversation plan action resolution');
    const latest = this.getLatestPending(conversationId);
    if (!latest || latest.id !== id) {
      throw Object.assign(new Error('Plan implementation request is stale or already resolved.'), { code: 'ZEUS_PLAN_IMPLEMENTATION_REQUEST_STALE' as const });
    }
    this.db.execute(`UPDATE conversation_plan_actions SET status = ?, submission_id = ?, resolved_at = ?, updated_at = ? WHERE id = ? AND status = 'pending'`, [status, input.submissionId ?? null, input.resolvedAt, input.resolvedAt, id]);
    const updated = this.getById(id)!;
    syncConversationStage(this.db, conversationId, input.resolvedAt);
    return updated;
  }
}

export class IdempotencyRequestRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  createOrGet(input: {
    scope: string;
    idempotencyKey: string;
    requestHash: string;
    status: IdempotencyRequestStatus;
    httpStatus?: number | null;
    response?: unknown;
    resourceId?: string | null;
    createdAt: string;
  }): ZeusIdempotencyRequestRecord {
    const status = assertEnum(input.status, ['in_progress', 'completed', 'failed'] as const, 'idempotency request status');
    const existing = this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [input.scope, input.idempotencyKey]);
    if (existing) {
      if (existing.request_hash !== input.requestHash) throwIdempotencyConflict(input.scope, input.idempotencyKey);
      return mapIdempotencyRequestRow(existing);
    }
    this.db.execute(`INSERT INTO idempotency_requests (scope, idempotency_key, request_hash, status, http_status, response_json, resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      input.scope,
      input.idempotencyKey,
      input.requestHash,
      status,
      input.httpStatus ?? null,
      input.response === undefined ? null : JSON.stringify(input.response),
      input.resourceId ?? null,
      input.createdAt,
      input.createdAt,
    ]);
    return mapIdempotencyRequestRow(this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [input.scope, input.idempotencyKey])!);
  }

  get(scope: string, idempotencyKey: string): ZeusIdempotencyRequestRecord | undefined {
    const row = this.db.get<DbIdempotencyRequestRow>(`SELECT * FROM idempotency_requests WHERE scope = ? AND idempotency_key = ?`, [scope, idempotencyKey]);
    return row ? mapIdempotencyRequestRow(row) : undefined;
  }

  complete(input: { scope: string; idempotencyKey: string; status: 'completed' | 'failed'; httpStatus: number; response: unknown; resourceId?: string | null; updatedAt: string }): ZeusIdempotencyRequestRecord {
    const existing = this.get(input.scope, input.idempotencyKey);
    if (!existing) throw new Error(`Idempotency request not found: ${input.scope}/${input.idempotencyKey}`);
    this.db.execute(
      `UPDATE idempotency_requests
       SET status = ?, http_status = ?, response_json = ?, resource_id = ?, updated_at = ?
       WHERE scope = ? AND idempotency_key = ?`,
      [input.status, input.httpStatus, JSON.stringify(input.response), input.resourceId ?? existing.resourceId, input.updatedAt, input.scope, input.idempotencyKey],
    );
    return this.get(input.scope, input.idempotencyKey)!;
  }
}

function clampConversationLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 20;
  return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function toSqlStringLiteral(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`;
}

function assertEnum<const T extends readonly string[]>(value: unknown, allowed: T, label: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`Unknown ${label}: ${String(value)}`);
  return value as T[number];
}

const providerGenerationOrderSettingKey = 'codex.native.transport_generation_order';

function assertProviderSequenceSnapshot(snapshot: unknown): asserts snapshot is ProviderSequenceSnapshot {
  if (!isPlainRecord(snapshot) || typeof snapshot.generationId !== 'string' || !snapshot.generationId || !Number.isSafeInteger(snapshot.sequence) || Number(snapshot.sequence) < 0) {
    throw new Error('Invalid provider generation/sequence snapshot');
  }
}

function validateProviderSettingsSnapshot(snapshot: unknown): asserts snapshot is ConversationProviderSettingsSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertNoSecretLikeProviderKeys(candidate);
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'model', 'effort', 'serviceTier'], 'provider settings snapshot');
  if (
    typeof candidate.model !== 'string' ||
    !candidate.model.trim() ||
    (candidate.effort !== undefined && typeof candidate.effort !== 'string') ||
    (candidate.serviceTier !== undefined && candidate.serviceTier !== null && typeof candidate.serviceTier !== 'string')
  ) {
    throw new Error('Invalid provider settings snapshot');
  }
}

function validateNextTurnSettings(settings: unknown): asserts settings is ConversationNextTurnSettings {
  if (!isPlainRecord(settings)) throw new Error('Invalid conversation next turn settings');
  assertOnlyKeys(settings, ['model', 'effort', 'serviceTier', 'permissionMode', 'collaborationMode'], 'conversation next turn settings');
  if (
    typeof settings.model !== 'string' ||
    !settings.model.trim() ||
    (settings.effort !== undefined && (typeof settings.effort !== 'string' || !settings.effort.trim())) ||
    (settings.serviceTier !== undefined && settings.serviceTier !== null && (typeof settings.serviceTier !== 'string' || !settings.serviceTier.trim()))
  ) {
    throw new Error('Invalid conversation next turn settings');
  }
  assertEnum(settings.permissionMode, ['read-only', 'auto', 'full-access'] as const, 'conversation next turn permission mode');
  assertEnum(settings.collaborationMode, ['default', 'plan'] as const, 'conversation next turn collaboration mode');
}

function validateProviderTokenUsageSnapshot(snapshot: unknown): asserts snapshot is ConversationProviderTokenUsageSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertNoSecretLikeProviderKeys(candidate, new Set(['inputtokens', 'cachedinputtokens', 'cachewriteinputtokens', 'outputtokens', 'reasoningoutputtokens', 'totaltokens']));
  assertOnlyKeys(
    candidate,
    [
      'generationId',
      'sequence',
      'serviceTier',
      'total',
      'last',
      'modelContextWindow',
      'cacheHitRate',
      'estimatedCredits',
      'apiEquivalentUsd',
      'lastApiEquivalentUsd',
      'cacheSavingsUsd',
      'priceCoverage',
      'pricingCatalogDate',
      'pricingSourceUrls',
      'historyComplete',
    ],
    'provider token usage snapshot',
  );
  validateTokenUsageBreakdown(candidate.total);
  validateTokenUsageBreakdown(candidate.last);
  if (candidate.serviceTier !== undefined && candidate.serviceTier !== null && typeof candidate.serviceTier !== 'string') throw new Error('Invalid provider token usage snapshot');
  for (const value of [candidate.modelContextWindow, candidate.cacheHitRate, candidate.estimatedCredits, candidate.apiEquivalentUsd, candidate.lastApiEquivalentUsd, candidate.cacheSavingsUsd, candidate.priceCoverage]) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid provider token usage snapshot');
  }
  if ((candidate.pricingCatalogDate !== null && typeof candidate.pricingCatalogDate !== 'string') || !Array.isArray(candidate.pricingSourceUrls) || candidate.pricingSourceUrls.some((url) => typeof url !== 'string')) {
    throw new Error('Invalid provider token usage snapshot');
  }
  if (typeof candidate.historyComplete !== 'boolean') throw new Error('Invalid provider token usage snapshot');
}

export function validateTokenUsageBreakdown(value: unknown): asserts value is TokenUsageBreakdown {
  if (!isPlainRecord(value)) throw new Error('Invalid token usage breakdown');
  assertOnlyKeys(value, ['totalTokens', 'inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens'], 'token usage breakdown');
  if (Object.values(value).some((entry) => typeof entry !== 'number' || !Number.isSafeInteger(entry) || entry < 0)) throw new Error('Invalid token usage breakdown');
}

function validateCodexUsageEstimate(value: unknown): asserts value is CodexUsageEstimate {
  if (!isPlainRecord(value) || !isPlainRecord(value.rateSnapshot)) throw new Error('Invalid Codex usage estimate');
  assertNoSecretLikeProviderKeys(value, new Set(['input', 'cachedinput', 'cachewrite', 'output', 'billabletokens', 'pricedtokens']));
  for (const candidate of [value.credits, value.apiEquivalentUsd, value.cacheSavingsUsd, value.coverage]) {
    if (candidate !== null && (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < 0)) throw new Error('Invalid Codex usage estimate');
  }
  if (![value.pricedTokens, value.billableTokens].every((candidate) => typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0)) throw new Error('Invalid Codex usage estimate');
}

export function validateRateLimitsSnapshot(snapshot: unknown): asserts snapshot is CodexRateLimitsSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'value'], 'Codex rate limits snapshot');
  assertNoSecretLikeProviderKeys(candidate.value);
  assertProviderVisibleJson(candidate.value, 'rate limits');
  if (!isPlainRecord(candidate.value)) throw new Error('Invalid Codex rate limits snapshot');
  for (const key of ['primary', 'secondary'] as const) {
    const window = candidate.value[key];
    if (window === undefined) continue;
    if (!isPlainRecord(window)) throw new Error('Invalid Codex rate limits snapshot');
    if (window.remaining !== undefined && (typeof window.remaining !== 'number' || !Number.isFinite(window.remaining))) throw new Error('Invalid Codex rate limits snapshot');
    if (window.usedPercent !== undefined && (typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent))) throw new Error('Invalid Codex rate limits snapshot');
    if (window.resetsAt !== undefined && window.resetsAt !== null && typeof window.resetsAt !== 'number' && typeof window.resetsAt !== 'string') throw new Error('Invalid Codex rate limits snapshot');
  }
}

export function validateMcpStartupStatusSnapshot(snapshot: unknown): asserts snapshot is CodexMcpStartupStatusSnapshot {
  assertProviderSequenceSnapshot(snapshot);
  const candidate = snapshot as ProviderSequenceSnapshot & Record<string, unknown>;
  assertOnlyKeys(candidate, ['generationId', 'sequence', 'value'], 'Codex MCP startup snapshot');
  assertProviderVisibleJson(candidate.value, 'MCP startup status');
  if (!isPlainRecord(candidate.value)) throw new Error('Invalid Codex MCP startup snapshot');
  for (const [serverId, state] of Object.entries(candidate.value)) {
    if (!serverId.trim()) throw new Error('Invalid Codex MCP startup snapshot');
    // 顶层键是 MCP 服务标识而非负载字段；密钥规则继续应用于每个服务的状态内容。
    assertNoSecretLikeProviderKeys(state, new Set<string>(), `snapshot.${serverId}`);
    if (typeof state === 'string') continue;
    if (!isPlainRecord(state) || typeof state.status !== 'string') throw new Error('Invalid Codex MCP startup snapshot');
    assertOnlyKeys(state, ['status', 'error'], 'Codex MCP server startup state');
    if (state.error !== undefined && state.error !== null && typeof state.error !== 'string') throw new Error('Invalid Codex MCP startup snapshot');
  }
}

export function shouldAcceptProviderSnapshot(db: ZeusDatabasePort, incoming: ProviderSequenceSnapshot, current: ProviderSequenceSnapshot | undefined): boolean {
  const row = db.get<{ value_json: string }>(`SELECT value_json FROM settings WHERE key = ?`, [providerGenerationOrderSettingKey]);
  let generationIds: string[] = [];
  if (row) {
    const parsed = parseStoredJson(row.value_json);
    if (!isPlainRecord(parsed) || !Array.isArray(parsed.generationIds) || !parsed.generationIds.every((value) => typeof value === 'string' && value)) throw new Error('Invalid persisted provider generation order');
    generationIds = [...new Set(parsed.generationIds)];
  }
  let changed = false;
  for (const generationId of [current?.generationId, incoming.generationId]) {
    if (generationId && !generationIds.includes(generationId)) {
      generationIds.push(generationId);
      changed = true;
    }
  }
  if (changed) {
    const timestamp = nowIso();
    db.execute(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [providerGenerationOrderSettingKey, JSON.stringify({ generationIds }), timestamp],
    );
  }
  const incomingEpoch = generationIds.indexOf(incoming.generationId);
  if (incomingEpoch < generationIds.length - 1) return false;
  return !(current && current.generationId === incoming.generationId && current.sequence >= incoming.sequence);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`Invalid ${label}`);
}

function assertNoSecretLikeProviderKeys(value: unknown, allowedTokenCounters = new Set<string>(), path = 'snapshot', seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`Invalid cyclic provider state at ${path}`);
  seen.add(value);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.replace(/[^a-z0-9]/giu, '').toLowerCase();
    const tokenLike = normalized.includes('token') && !allowedTokenCounters.has(normalized);
    const secretKeyLike =
      normalized === 'key' || ['apikey', 'accesskey', 'secretkey', 'privatekey', 'signingkey', 'encryptionkey', 'decryptionkey', 'sessionkey', 'serviceaccountkey', 'clientkey', 'keymaterial'].some((marker) => normalized.includes(marker));
    if (tokenLike || secretKeyLike || ['secret', 'authorization', 'credential', 'password', 'passphrase', 'bearer', 'cookie'].some((marker) => normalized.includes(marker))) {
      throw new Error(`Secret-like provider field rejected: ${path}.${key}`);
    }
    assertNoSecretLikeProviderKeys(nested, allowedTokenCounters, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function assertProviderVisibleJson(value: unknown, label: string, seen = new WeakSet<object>()): asserts value is ProviderVisibleJson {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Invalid ${label} provider state`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error(`Invalid ${label} provider state`);
  seen.add(value);
  const entries = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  for (const nested of entries) assertProviderVisibleJson(nested, label, seen);
  seen.delete(value);
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function throwIdempotencyConflict(scope: string, key: string): never {
  throw Object.assign(new Error(`Idempotency key conflict for ${scope}/${key}`), { code: 'ZEUS_IDEMPOTENCY_CONFLICT' as const });
}

function serializeProviderRequestId(value: string | number): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Provider request id must be a finite JSON scalar');
  return JSON.stringify(value);
}

function parseStoredJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function assertConversationServerRequestIdentity(existing: DbConversationServerRequestRow, requestKind: ConversationServerRequestKind, payload: unknown, containsSecret: boolean): void {
  const sameKind = existing.request_kind === requestKind;
  const samePayload = canonicalJson(existing.payload_json ? parseStoredJson(existing.payload_json) : undefined) === canonicalJson(payload);
  const sameSecretClassification = (existing.contains_secret === 1) === containsSecret;
  if (sameKind && samePayload && sameSecretClassification) return;
  throw Object.assign(new Error('Codex server request identity conflicts with an existing generation-scoped provider request.'), {
    code: 'ZEUS_CODEX_SERVER_REQUEST_IDENTITY_CONFLICT' as const,
  });
}

export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function hasSecretUserInputQuestion(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some(hasSecretUserInputQuestion);
  if (!isPlainRecord(payload)) return false;
  if (Array.isArray(payload.questions) && payload.questions.some((question) => isPlainRecord(question) && question.isSecret === true)) return true;
  return Object.values(payload).some(hasSecretUserInputQuestion);
}

function extractUserInputQuestionIds(payload: unknown): string[] {
  if (!isPlainRecord(payload) || !Array.isArray(payload.questions)) return [];
  return payload.questions.flatMap((question) => {
    if (!isPlainRecord(question)) return [];
    const id = typeof question.id === 'string' ? question.id : typeof question.questionId === 'string' ? question.questionId : undefined;
    return id ? [id] : [];
  });
}

function countUserInputAnswers(response: unknown): number {
  if (!isPlainRecord(response) || !isPlainRecord(response.answers)) return 0;
  let count = 0;
  for (const answer of Object.values(response.answers)) {
    if (Array.isArray(answer)) count += answer.length;
    else if (isPlainRecord(answer) && Array.isArray(answer.answers)) count += answer.answers.length;
    else if (answer !== undefined && answer !== null) count += 1;
  }
  return count;
}

function createSecretResponseSummary(payload: unknown, response: unknown, questionIds?: string[], answerCount?: number): { questionIds: string[]; answerCount: number; answers: '[REDACTED]'; publicAnswers: Record<string, string[]> } {
  return {
    questionIds: questionIds ?? extractUserInputQuestionIds(payload),
    answerCount: answerCount ?? countUserInputAnswers(response),
    answers: '[REDACTED]',
    publicAnswers: extractNonSecretUserInputAnswers(payload, response),
  };
}

function extractNonSecretUserInputAnswers(payload: unknown, response: unknown): Record<string, string[]> {
  if (!isPlainRecord(payload) || !Array.isArray(payload.questions) || !isPlainRecord(response) || !isPlainRecord(response.answers)) return {};
  const publicQuestionIds = new Set(
    payload.questions.flatMap((question) => {
      if (!isPlainRecord(question) || question.isSecret !== false) return [];
      const id = typeof question.id === 'string' ? question.id : typeof question.questionId === 'string' ? question.questionId : undefined;
      return id ? [id] : [];
    }),
  );
  return Object.fromEntries(
    Object.entries(response.answers).flatMap(([questionId, answer]) => {
      if (!publicQuestionIds.has(questionId) || !isPlainRecord(answer) || !Array.isArray(answer.answers) || !answer.answers.every((entry) => typeof entry === 'string')) return [];
      return [[questionId, answer.answers]];
    }),
  );
}

function redactSecretValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecretValues);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => (/^(?:answer|answers|value|secret)$/iu.test(key) ? [key, '[REDACTED]'] : [key, redactSecretValues(nested)])));
}

/** Git 快照仓储只记录状态与 diff 路径，不主动执行任何 Git 写操作。 */

interface DbConversationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  workspace_id: string | null;
  environment_id: string | null;
  session_id: string | null;
  title: string;
  summary: string | null;
  status: string;
  stage: ConversationStage;
  stage_updated_at: string;
  created_at: string;
  updated_at: string;
  archived: number;
  transport_kind: ConversationTransportKind;
  provider_id: string | null;
  provider_thread_id: string | null;
  provider_thread_path: string | null;
  provider_model: string | null;
  provider_state: ConversationProviderState;
  provider_protocol_version: string | null;
  provider_binary_version: string | null;
  legacy_source_conversation_id: string | null;
  provider_settings_json: string;
  provider_token_usage_json: string;
  permission_mode: ConversationPermissionMode;
  collaboration_mode: ConversationCollaborationMode;
  next_turn_settings_json: string;
  completion_unread: number;
  attention_kind: ConversationAttentionKind;
  attention_revision: number;
  attention_turn_id: string | null;
  attention_updated_at: string | null;
  agent_kind: ConversationAgentKind | null;
  agent_transport: ConversationAgentTransport | null;
  model_source_id: string | null;
  model_id: string | null;
  native_session_id: string | null;
  native_session_path: string | null;
  capability_snapshot_id: string | null;
}

interface DbConversationMessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  source: string;
  metadata_json: string;
  created_at: string;
  provider_thread_id: string | null;
  provider_turn_id: string | null;
  provider_item_id: string | null;
  client_message_id: string | null;
}

interface DbCodexLegacyImportRow {
  id: string;
  provider_import_id: string | null;
  source_conversation_id: string;
  target_conversation_id: string | null;
  snapshot_path: string;
  snapshot_sha256: string;
  status: CodexLegacyImportStatus;
  target_thread_id: string | null;
  failure_stage: string | null;
  failure_message: string | null;
  provider_binary_version: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface DbConversationTurnRow {
  id: string;
  conversation_id: string;
  provider_thread_id: string;
  provider_turn_id: string | null;
  client_submission_id: string | null;
  status: ConversationTurnStatus;
  error_json: string | null;
  plan_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  agent_kind: ConversationAgentKind | null;
  native_run_id: string | null;
}

interface DbConversationProviderSyncCheckpointRow {
  conversation_id: string;
  provider_thread_id: string;
  baseline_turn_id: string | null;
  last_synced_turn_id: string | null;
  initialized_at: string;
  updated_at: string;
}

export interface DbCodexUsageLedgerRow {
  id: string;
  provider_id: string;
  account_scope_id: string;
  project_id: string;
  conversation_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  model: string;
  service_tier: string | null;
  total_tokens: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  provider_baseline_json: string | null;
  provider_total_json: string | null;
  usage_complete: number;
  estimate_json: string;
  occurred_at: string;
  created_at: string;
  updated_at: string;
}

interface DbAgentCapabilitySnapshotRow {
  id: string;
  agent_kind: ConversationAgentKind;
  transport_kind: ConversationAgentTransport;
  support_status: AgentCapabilitySupportStatus;
  adapter_version: string | null;
  binary_version: string | null;
  protocol_version: string | null;
  capabilities_json: string;
  evidence_json: string;
  checked_at: string;
}

interface DbConversationResourceRow {
  id: string;
  project_id: string;
  conversation_id: string;
  turn_id: string;
  item_id: string;
  source_index: number;
  canonical_target_digest: string;
  kind: ConversationResourceKind;
  presentation: ConversationResourcePresentation;
  display_json: string;
  target_json: string;
  authority_json: string;
  created_at: string;
  updated_at: string;
}

interface DbConversationSubmissionRow {
  id: string;
  conversation_id: string;
  idempotency_key: string;
  request_hash: string;
  client_message_id: string;
  kind: ConversationSubmissionKind;
  requested_delivery: ConversationRequestedDelivery;
  status: ConversationSubmissionStatus;
  queue_position: number | null;
  input_json: string;
  target_provider_turn_id: string | null;
  provider_turn_id: string | null;
  paused_reason: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
  dispatched_at: string | null;
  resolved_at: string | null;
  replacement_of_submission_id: string | null;
  replacement_reason: string | null;
  execution_snapshot_id: string | null;
  segment_id: string | null;
  submission_outcome: 'queued' | 'paused' | 'outcome_unknown' | 'accepted' | 'terminal';
  accepted_at: string | null;
  timeline_sequence: number | null;
  model_history_sequence: number | null;
}

interface DbConversationServerRequestRow {
  id: string;
  conversation_id: string;
  turn_id: string | null;
  item_id: string | null;
  transport_generation_id: string;
  provider_request_id_json: string;
  request_kind: ConversationServerRequestKind;
  payload_json: string;
  status: ConversationServerRequestStatus;
  response_json: string | null;
  contains_secret: number;
  expires_at: string | null;
  auto_resolution_state: ConversationRequestAutoResolutionState;
  created_at: string;
  resolved_at: string | null;
}

interface DbConversationPlanActionRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  plan_item_id: string;
  status: ConversationPlanActionStatus;
  submission_id: string | null;
  created_at: string;
  resolved_at: string | null;
  updated_at: string;
}

interface DbIdempotencyRequestRow {
  scope: string;
  idempotency_key: string;
  request_hash: string;
  status: IdempotencyRequestStatus;
  http_status: number | null;
  response_json: string | null;
  resource_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapConversationRow(row: DbConversationRow): ZeusConversationRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    workspaceId: row.workspace_id,
    environmentId: row.environment_id,
    sessionId: row.session_id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    stage: assertEnum(row.stage, ['created', 'connecting', 'queued', 'running', 'waiting_user', 'waiting_approval', 'completed', 'failed', 'paused', 'ready', 'archived'] as const, 'conversation stage'),
    stageUpdatedAt: row.stage_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    transportKind: row.transport_kind,
    providerId: row.provider_id,
    providerThreadId: row.provider_thread_id,
    providerThreadPath: row.provider_thread_path,
    providerModel: row.provider_model,
    providerState: row.provider_state,
    providerProtocolVersion: row.provider_protocol_version,
    providerBinaryVersion: row.provider_binary_version,
    legacySourceConversationId: row.legacy_source_conversation_id,
    providerSettingsJson: row.provider_settings_json,
    providerTokenUsageJson: row.provider_token_usage_json,
    permissionMode: assertEnum(row.permission_mode, ['read-only', 'auto', 'full-access'] as const, 'conversation permission mode'),
    collaborationMode: assertEnum(row.collaboration_mode, ['default', 'plan'] as const, 'conversation collaboration mode'),
    nextTurnSettingsJson: row.next_turn_settings_json,
    attentionUnread: row.completion_unread === 1,
    attentionKind: assertEnum(row.attention_kind, ['none', 'unread', 'completed', 'failed', 'interrupted'] as const, 'conversation attention kind'),
    attentionRevision: row.attention_revision,
    attentionTurnId: row.attention_turn_id,
    attentionUpdatedAt: row.attention_updated_at,
    agentKind: row.agent_kind,
    agentTransport: row.agent_transport,
    modelSourceId: row.model_source_id,
    modelId: row.model_id,
    nativeSessionId: row.native_session_id,
    nativeSessionPath: row.native_session_path,
    capabilitySnapshotId: row.capability_snapshot_id,
  };
}

function mapConversationMessageRow(row: DbConversationMessageRow): ZeusConversationMessageRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    source: row.source,
    metadataJson: row.metadata_json,
    createdAt: row.created_at,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    clientMessageId: row.client_message_id,
  };
}

function mapCodexLegacyImportRow(row: DbCodexLegacyImportRow): ZeusCodexLegacyImportRecord {
  return {
    id: row.id,
    providerImportId: row.provider_import_id,
    sourceConversationId: row.source_conversation_id,
    targetConversationId: row.target_conversation_id,
    snapshotPath: row.snapshot_path,
    snapshotSha256: row.snapshot_sha256,
    status: row.status,
    targetThreadId: row.target_thread_id,
    failureStage: row.failure_stage,
    failureMessage: row.failure_message,
    providerBinaryVersion: row.provider_binary_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapConversationTurnRow(row: DbConversationTurnRow): ZeusConversationTurnRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    clientSubmissionId: row.client_submission_id,
    status: row.status,
    errorJson: row.error_json,
    planJson: row.plan_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    agentKind: row.agent_kind,
    nativeRunId: row.native_run_id,
  };
}

function mapConversationProviderSyncCheckpointRow(row: DbConversationProviderSyncCheckpointRow): ZeusConversationProviderSyncCheckpointRecord {
  return {
    conversationId: row.conversation_id,
    providerThreadId: row.provider_thread_id,
    baselineTurnId: row.baseline_turn_id,
    lastSyncedTurnId: row.last_synced_turn_id,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

function mapCodexUsageLedgerRow(row: DbCodexUsageLedgerRow): CodexUsageLedgerRecord {
  const estimate = JSON.parse(row.estimate_json) as CodexUsageEstimate;
  validateCodexUsageEstimate(estimate);
  return {
    id: row.id,
    providerId: row.provider_id,
    accountScopeId: row.account_scope_id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    model: row.model,
    serviceTier: row.service_tier,
    usage: {
      totalTokens: row.total_tokens,
      inputTokens: row.input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheWriteInputTokens: row.cache_write_input_tokens,
      outputTokens: row.output_tokens,
      reasoningOutputTokens: row.reasoning_output_tokens,
    },
    providerBaseline: parseStoredTokenUsageBreakdown(row.provider_baseline_json),
    providerTotal: parseStoredTokenUsageBreakdown(row.provider_total_json),
    usageComplete: row.usage_complete === 1,
    estimate,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseStoredTokenUsageBreakdown(value: string | null): TokenUsageBreakdown | null {
  if (!value) return null;
  const parsed = JSON.parse(value) as TokenUsageBreakdown;
  validateTokenUsageBreakdown(parsed);
  return parsed;
}

export function subtractTokenUsageBreakdown(total: TokenUsageBreakdown, baseline: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    totalTokens: Math.max(0, total.totalTokens - baseline.totalTokens),
    inputTokens: Math.max(0, total.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, total.cachedInputTokens - baseline.cachedInputTokens),
    cacheWriteInputTokens: Math.max(0, total.cacheWriteInputTokens - baseline.cacheWriteInputTokens),
    outputTokens: Math.max(0, total.outputTokens - baseline.outputTokens),
    reasoningOutputTokens: Math.max(0, total.reasoningOutputTokens - baseline.reasoningOutputTokens),
  };
}

function mapAgentCapabilitySnapshotRow(row: DbAgentCapabilitySnapshotRow): ZeusAgentCapabilitySnapshotRecord {
  return {
    id: row.id,
    agentKind: row.agent_kind,
    transportKind: row.transport_kind,
    supportStatus: row.support_status,
    adapterVersion: row.adapter_version,
    binaryVersion: row.binary_version,
    protocolVersion: row.protocol_version,
    capabilitiesJson: row.capabilities_json,
    evidenceJson: row.evidence_json,
    checkedAt: row.checked_at,
  };
}

function mapConversationResourceRow(row: DbConversationResourceRow): ZeusConversationResourceRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    sourceIndex: row.source_index,
    canonicalTargetDigest: row.canonical_target_digest,
    kind: row.kind,
    presentation: row.presentation,
    displayJson: row.display_json,
    targetJson: row.target_json,
    authorityJson: row.authority_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversationSubmissionRow(row: DbConversationSubmissionRow): ZeusConversationSubmissionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    clientMessageId: row.client_message_id,
    kind: row.kind,
    requestedDelivery: row.requested_delivery,
    status: row.status,
    queuePosition: row.queue_position,
    inputJson: row.input_json,
    targetProviderTurnId: row.target_provider_turn_id,
    providerTurnId: row.provider_turn_id,
    pausedReason: row.paused_reason,
    errorJson: row.error_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    dispatchedAt: row.dispatched_at,
    resolvedAt: row.resolved_at,
    replacementOfSubmissionId: row.replacement_of_submission_id,
    replacementReason: row.replacement_reason,
    executionSnapshotId: row.execution_snapshot_id,
    segmentId: row.segment_id,
    submissionOutcome: row.submission_outcome,
    acceptedAt: row.accepted_at,
    timelineSequence: row.timeline_sequence,
    modelHistorySequence: row.model_history_sequence,
  };
}

function mapConversationServerRequestRow(row: DbConversationServerRequestRow): ZeusConversationServerRequestRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    itemId: row.item_id,
    transportGenerationId: row.transport_generation_id,
    providerRequestIdJson: row.provider_request_id_json,
    requestKind: row.request_kind,
    payloadJson: row.payload_json,
    status: row.status,
    responseJson: row.response_json,
    containsSecret: row.contains_secret === 1,
    expiresAt: row.expires_at,
    autoResolutionState: assertEnum(row.auto_resolution_state, ['none', 'scheduled', 'snoozed'] as const, 'request auto resolution state'),
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

function mapConversationPlanActionRow(row: DbConversationPlanActionRow): ZeusConversationPlanActionRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    planItemId: row.plan_item_id,
    status: assertEnum(row.status, ['pending', 'dismissed', 'implemented', 'refinement_requested', 'superseded'] as const, 'conversation plan action status'),
    submissionId: row.submission_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    updatedAt: row.updated_at,
  };
}

function mapIdempotencyRequestRow(row: DbIdempotencyRequestRow): ZeusIdempotencyRequestRecord {
  return {
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    status: row.status,
    httpStatus: row.http_status,
    responseJson: row.response_json,
    resourceId: row.resource_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
