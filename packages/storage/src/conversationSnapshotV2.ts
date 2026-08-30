import type { ZeusDatabasePort } from './databasePort.js';
import { type ArtifactRef, type ArtifactStore, artifactStoreGeneration } from './artifactStore.js';
import { conversationSchemaGeneration, type ConversationSessionMetricsSnapshot, readConversationSessionMetrics } from './conversationExecutionStore.js';

export const conversationSnapshotV2StructureGeneration = '2026-08-29-conversation-snapshot-v2-recovered-request-input';

export const conversationSnapshotV2Limits = {
  snapshot: {
    defaultClosedTurnLimit: 2,
    maximumClosedTurnLimit: 2,
    defaultByteLimit: 64 * 1024,
    minimumByteLimit: 16 * 1024,
    maximumByteLimit: 512 * 1024,
  },
  page: {
    defaultEntryLimit: 64,
    maximumEntryLimit: 256,
    defaultByteLimit: 128 * 1024,
    minimumByteLimit: 16 * 1024,
    maximumByteLimit: 1024 * 1024,
  },
  content: {
    defaultByteLimit: 16 * 1024,
    minimumByteLimit: 256,
    maximumByteLimit: 64 * 1024,
  },
} as const;

type ConversationPageKind = 'timeline' | 'model_history' | 'process' | 'commands' | 'resources' | 'change_files';
type ConversationContentKind = 'timeline_payload' | 'model_content' | 'process_detail' | 'change_file_diff';
type ConversationProcessKind = 'reasoning' | 'tool' | 'command' | 'retry' | 'context_compaction' | 'waiting' | 'warning';

// 模型历史持久化的是结构化 JSON；普通会话正文只读取其中的可见文本，绝不能把内部 tool_call 包装层当作消息正文。
// 用户消息的附件、任务布局和上下文是正文展示所需结构，保留原 JSON 交给 Renderer 还原；工具调用没有 text 字段，
// 继续保留原 JSON 预览供结构分类，Renderer 会按 toolPairId/type 将其从消息流排除。
const modelHistoryVisibleContentSql = `CASE
  WHEN conversation_model_history.role = 'user'
   AND json_valid(content_json)
   AND (
     json_type(content_json, '$.attachments') = 'array'
     OR json_type(content_json, '$.taskPushLayout') = 'object'
     OR json_type(content_json, '$.conversationContext') = 'object'
   )
    THEN content_json
  WHEN json_valid(content_json) AND json_type(content_json, '$.text') = 'text'
    THEN json_extract(content_json, '$.text')
  ELSE content_json
END`;
const modelHistoryAssistantProviderItemSql = `(SELECT message.provider_item_id
  FROM conversation_messages AS message
  JOIN conversation_turns AS history_turn ON history_turn.id = conversation_model_history.turn_id
 WHERE message.conversation_id = conversation_model_history.conversation_id
   AND message.provider_turn_id = history_turn.provider_turn_id
   AND message.role = conversation_model_history.role
   AND message.created_at = conversation_model_history.confirmed_at
   AND message.content = ${modelHistoryVisibleContentSql}
 LIMIT 1)`;
const modelHistoryProviderItemSql = `COALESCE(
  ${modelHistoryAssistantProviderItemSql},
  CASE
    WHEN json_valid(reasoning_source_json)
      THEN COALESCE(
        json_extract(reasoning_source_json, '$.itemId'),
        json_extract(reasoning_source_json, '$.providerItemId')
      )
    ELSE NULL
  END
)`;
const modelHistoryReasoningSummarySql = `CASE
  WHEN json_valid(reasoning_source_json)
   AND COALESCE(json_extract(reasoning_source_json, '$.readableSummary'), 0) = 1
    THEN 1
  ELSE 0
END`;
const modelHistoryAssistantPhaseSql = `CASE
  WHEN json_valid(reasoning_source_json) AND json_extract(reasoning_source_json, '$.itemType') = 'plan'
    THEN 'plan'
  ELSE (SELECT json_extract(message.metadata_json, '$.phase')
    FROM conversation_messages AS message
    JOIN conversation_turns AS history_turn ON history_turn.id = conversation_model_history.turn_id
   WHERE message.conversation_id = conversation_model_history.conversation_id
     AND message.provider_turn_id = history_turn.provider_turn_id
     AND message.role = conversation_model_history.role
     AND message.created_at = conversation_model_history.confirmed_at
     AND message.content = ${modelHistoryVisibleContentSql}
     AND json_valid(message.metadata_json)
   LIMIT 1)
END`;
const modelHistoryFormalPlanSql = `CASE
  WHEN ${modelHistoryAssistantPhaseSql} = 'plan'
   AND EXISTS (
     SELECT 1
       FROM conversation_plan_actions AS plan_action
       JOIN conversation_provider_item_states AS formal_plan_item ON formal_plan_item.id = plan_action.plan_item_id
      WHERE plan_action.conversation_id = conversation_model_history.conversation_id
        AND plan_action.turn_id = conversation_model_history.turn_id
        AND formal_plan_item.provider_item_id = ${modelHistoryProviderItemSql}
   )
    THEN 1
  ELSE 0
END`;
export type ConversationSnapshotV2ErrorCode =
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_NOT_FOUND'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_TURN_NOT_FOUND'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_CHANGE_SET_NOT_FOUND'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_NOT_FOUND'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_CHANGED'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_TRANSITIONING'
  | 'ZEUS_CONVERSATION_SNAPSHOT_V2_BYTE_BUDGET_EXHAUSTED';

export class ConversationSnapshotV2Error extends Error {
  readonly name = 'ConversationSnapshotV2Error';

  constructor(
    readonly code: ConversationSnapshotV2ErrorCode,
    message: string,
    readonly statusCode: 400 | 404 | 409 | 413,
  ) {
    super(message);
  }
}

export interface ConversationSnapshotV2TurnSummary {
  id: string;
  providerTurnId: string | null;
  submissionId: string | null;
  status: string;
  hasError: boolean;
  hasPlan: boolean;
  plan: ConversationSnapshotV2TurnPlan | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  agentKind: string | null;
  openingUserMessage: ConversationModelHistoryPageItem | null;
  /**
   * 活动轮次尚未形成 confirmed model history 时的有界可见投影。
   * 这里只暴露 Snapshot V2 需要的展示字段，不把 Provider 摄取表直接当成客户端协议。
   */
  activeItems?: ConversationSnapshotV2ActiveItem[];
  activeItemsTruncated?: boolean;
  process: {
    available: boolean;
    latestSequence: number;
  };
  resourcesAvailable: boolean;
  changeSetAvailable: boolean;
}

export interface ConversationSnapshotV2ActiveItem {
  id: string;
  order: number;
  turnId: string;
  providerItemId: string;
  itemType: string;
  status: 'in_progress';
  phase: 'prework' | 'final_answer';
  text: BoundedContentProjection;
  payload: BoundedContentProjection;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface ConversationSnapshotV2TurnPlan {
  explanation: string | null;
  steps: Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>;
}

export interface ConversationSnapshotV2 {
  schemaVersion: 2;
  structureGeneration: typeof conversationSnapshotV2StructureGeneration;
  conversationSchemaGeneration: typeof conversationSchemaGeneration;
  throughEventSeq: number;
  eventStreamGeneration: string | null;
  conversation: {
    id: string;
    projectId: string;
    taskId: string | null;
    title: string;
    titleRedacted: boolean;
    status: string;
    stage: string;
    stageUpdatedAt: string;
    archived: boolean;
    transportKind: string;
    providerState: string;
    providerModel: string | null;
    providerSettings: ConversationSnapshotV2ProviderSettings | null;
    nextTurnSettings: ConversationSnapshotV2NextTurnSettings | null;
    agentKind: string | null;
    createdAt: string;
    updatedAt: string;
  };
  openSegment: {
    id: string;
    runtimeKind: string;
    state: string;
    nativeSessionId: string | null;
    providerModel: string | null;
    openedAt: string;
    acceptedAt: string | null;
    updatedAt: string;
  } | null;
  activeTurn: ConversationSnapshotV2TurnSummary | null;
  recentClosedTurns: ConversationSnapshotV2TurnSummary[];
  sessionMetrics: ConversationSessionMetricsSnapshot | null;
  collections: {
    timeline: { throughSequence: number };
    modelHistory: { throughSequence: number };
    process: { throughSequence: number };
    resources: { available: boolean };
  };
  limits: {
    closedTurnLimit: number;
    byteLimit: number;
    returnedTurnCount: number;
    responseBytes: number;
  };
}

export interface ConversationSnapshotV2ProviderSettings {
  generationId?: string;
  sequence?: number;
  model: string;
  effort?: string;
  serviceTier?: string | null;
}

export interface ConversationSnapshotV2NextTurnSettings {
  model: string;
  effort?: string;
  serviceTier?: string | null;
  permissionMode: 'read-only' | 'auto' | 'full-access';
  collaborationMode: 'default' | 'plan';
}

export interface ConversationSnapshotV2Page<T> {
  schemaVersion: 2;
  structureGeneration: typeof conversationSnapshotV2StructureGeneration;
  conversationId: string;
  kind: ConversationPageKind;
  throughEventSeq: number;
  throughSequence: number;
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
  limits: {
    entryLimit: number;
    byteLimit: number;
    returnedItems: number;
    responseBytes: number;
  };
}

export interface ConversationTimelinePageItem {
  id: string;
  sequence: number;
  eventKind: string;
  turnId: string | null;
  submissionId: string | null;
  segmentId: string | null;
  occurredAt: string;
  payload: BoundedContentProjection;
}

export interface ConversationModelHistoryPageItem {
  id: string;
  sequence: number;
  turnId: string;
  submissionId: string | null;
  clientUserMessageId: string | null;
  providerItemId: string | null;
  reasoningSummary: boolean;
  phase: string | null;
  formalPlan: boolean;
  segmentId: string;
  role: string;
  toolPairId: string | null;
  confirmedAt: string;
  content: BoundedContentProjection;
  toolResult: ConversationToolResultDescriptor | null;
}

export interface ConversationProcessPageItem {
  id: string;
  sequence: number;
  turnId: string;
  segmentId: string;
  providerItemId: string | null;
  kind: ConversationProcessKind;
  status: string;
  title: string;
  sourceEventId: string | null;
  startedAt: string;
  completedAt: string | null;
  presentation: Record<string, unknown> | null;
  detail: BoundedContentProjection;
  toolResult: ConversationToolResultDescriptor | null;
}

export interface ConversationResourcePageItem {
  id: string;
  turnId: string;
  itemId: string;
  sourceIndex: number;
  kind: string;
  presentation: string;
  displayName: string;
  mimeType: string | null;
  previewKind: string | null;
  iconKind: string | null;
  attachmentRef: string | null;
  taskPushAttachmentKey: string | null;
  origin: string | null;
  createdAt: string;
  updatedAt: string;
  accessPolicy: 'authorized_open_intent_or_preview';
}

export interface ConversationChangeSetSummary {
  id: string;
  projectId: string;
  conversationId: string;
  turnId: string;
  providerTurnId: string;
  state: string;
  preImageDigest: string | null;
  postImageDigest: string | null;
  hasConflict: boolean;
  unavailableReason: string | null;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  addedLines: number;
  deletedLines: number;
  diffBytes: number;
}

export interface ConversationChangeFilePageItem {
  id: string;
  changeSetId: string;
  sourceItemId: string | null;
  sourceIndex: number;
  oldPath: string | null;
  newPath: string | null;
  changeType: string;
  addedLines: number;
  deletedLines: number;
  preHash: string | null;
  postHash: string | null;
  preExists: boolean;
  postExists: boolean;
  reversible: boolean;
  unavailableReason: string | null;
  diffBytes: number;
  diffHandle: string | null;
  detailState: 'available' | 'transitioning';
  createdAt: string;
  updatedAt: string;
}

export interface ConversationContentPage {
  schemaVersion: 2;
  structureGeneration: typeof conversationSnapshotV2StructureGeneration;
  conversationId: string;
  kind: ConversationContentKind;
  mimeType: string;
  text: string;
  offset: number;
  nextOffset: number | null;
  totalCharacters: number;
  totalBytes: number;
  contentByteLimit: number;
  redacted: boolean;
}

interface BoundedContentProjection {
  preview: string;
  byteLength: number;
  truncated: boolean;
  redacted: boolean;
  contentHandle: string | null;
  refreshRequired: boolean;
}

interface ConversationToolResultDescriptor {
  handle: string;
  sha256: string;
  byteLength: number;
  mimeType: string;
  projection: string;
  projectionTruncated: boolean;
  redacted: boolean;
}

interface ConversationRow {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  status: string;
  stage: string;
  stage_updated_at: string;
  archived: number;
  transport_kind: string;
  provider_state: string;
  provider_model: string | null;
  provider_settings_json: string;
  next_turn_settings_json: string;
  permission_mode: string;
  collaboration_mode: string;
  agent_kind: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  provider_turn_id: string | null;
  client_submission_id: string | null;
  status: string;
  has_error: number;
  has_plan: number;
  plan_json: string | null;
  legacy_plan_text: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  agent_kind: string | null;
}

interface SequenceCursorPayload {
  version: 2;
  type: 'sequence';
  kind: 'timeline' | 'model_history' | 'process' | 'commands';
  conversationId: string;
  scope: string;
  afterSequence: number;
  throughSequence: number;
  throughEventSeq: number;
}

interface ReverseSequenceCursorPayload {
  version: 2;
  type: 'reverse_sequence';
  kind: 'model_history';
  conversationId: string;
  beforeSequence: number;
  throughSequence: number;
  throughEventSeq: number;
}

interface ResourceCursorPayload {
  version: 2;
  type: 'resource';
  kind: 'resources';
  conversationId: string;
  after: ResourceOrderKey;
  through: ResourceOrderKey;
  throughEventSeq: number;
}

interface ChangeFileCursorPayload {
  version: 2;
  type: 'change_file';
  kind: 'change_files';
  conversationId: string;
  scope: string;
  after: ChangeFileOrderKey;
  through: ChangeFileOrderKey;
  throughEventSeq: number;
}

interface ContentHandlePayload {
  version: 2;
  type: 'content';
  kind: ConversationContentKind;
  conversationId: string;
  identity: string;
  turnId: string | null;
  revision: string;
  totalCharacters: number;
  totalBytes: number;
}

interface ResourceOrderKey {
  createdAt: string;
  sourceIndex: number;
  id: string;
}

interface ChangeFileOrderKey {
  sourceIndex: number;
  id: string;
}

type CursorPayload = SequenceCursorPayload | ReverseSequenceCursorPayload | ResourceCursorPayload | ChangeFileCursorPayload | ContentHandlePayload;

interface ModelHistoryProjectionRow {
  id: string;
  sequence: number;
  turn_id: string;
  submission_id: string | null;
  client_user_message_id: string | null;
  provider_item_id: string | null;
  reasoning_summary: number;
  assistant_phase: string | null;
  formal_plan: number;
  segment_id: string;
  role: string;
  tool_pair_id: string | null;
  confirmed_at: string;
  content_preview: string;
  content_bytes: number;
  content_characters: number;
}

const previewCharacterLimit = 2_048;
const activeTurnItemLimit = 64;
const maximumCursorLength = 4_096;
const stableChangeSetStates = new Set(['applied', 'undone', 'conflicted', 'unavailable']);

/**
 * Snapshot V2 只执行有界投影查询；不会调用 V1 的全历史 repository。
 * 游标携带第一页读取时的高水位，后续追加的数据不会插入当前分页窗口。
 */
export class ConversationSnapshotV2Repository {
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly artifactStore?: ArtifactStore,
  ) {}

  readSnapshot(conversationIdValue: string, options: { closedTurnLimit?: number; byteLimit?: number; includeSessionMetrics?: boolean } = {}): ConversationSnapshotV2 {
    const conversationId = requiredIdentity(conversationIdValue, 'conversationId');
    const closedTurnLimit = boundedInteger(options.closedTurnLimit ?? conversationSnapshotV2Limits.snapshot.defaultClosedTurnLimit, 'closedTurnLimit', 1, conversationSnapshotV2Limits.snapshot.maximumClosedTurnLimit);
    const byteLimit = boundedInteger(options.byteLimit ?? conversationSnapshotV2Limits.snapshot.defaultByteLimit, 'byteLimit', conversationSnapshotV2Limits.snapshot.minimumByteLimit, conversationSnapshotV2Limits.snapshot.maximumByteLimit);
    const conversation = this.db.get<ConversationRow>(
      `SELECT id, project_id, task_id, substr(title, 1, 512) AS title,
              status, stage, stage_updated_at, archived, transport_kind, provider_state,
              CASE WHEN provider_model IS NULL THEN NULL ELSE substr(provider_model, 1, 256) END AS provider_model,
              substr(provider_settings_json, 1, 4096)  AS provider_settings_json,
              substr(next_turn_settings_json, 1, 4096) AS next_turn_settings_json,
              permission_mode,
              collaboration_mode,
              agent_kind, created_at, updated_at
         FROM conversations
        WHERE id = ?`,
      [conversationId],
    );
    if (!conversation) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_NOT_FOUND', '会话不存在。', 404);

    // 每个状态只从既有 (conversation_id, status, created_at, id) 索引取少量候选，
    // 避免离线热索引尚未切换时为 IN + 跨状态排序扫描全部历史 turn。
    // 历史异常退出可能留下 running turn，但 provider_state 已由恢复流程收口为 paused。
    // 两份权威状态必须同时表明正在执行，Snapshot 才能向界面暴露 activeTurn。
    const activeTurnCandidate = this.latestTurnsByStatus(conversationId, ['running', 'dispatching', 'waiting'], 1)[0];
    const activeTurn = conversation.provider_state === 'active' || conversation.provider_state === 'waiting' ? activeTurnCandidate : undefined;
    const recentClosedTurns = this.latestTurnsByStatus(conversationId, ['completed', 'interrupted', 'failed'], closedTurnLimit);
    const stream = this.db.get<{ generation_id: string; latest_sequence: number }>(
      `SELECT generation_id, latest_sequence
         FROM conversation_sync_event_streams
        WHERE conversation_id = ? AND is_current = 1`,
      [conversationId],
    );
    const currentSegment = this.db.get<{
      id: string;
      runtime_kind: string;
      state: string;
      native_session_id: string | null;
      provider_model: string | null;
      opened_at: string;
      accepted_at: string | null;
      updated_at: string;
    }>(
      `SELECT id, runtime_kind, state, native_session_id,
              CASE WHEN provider_model IS NULL THEN NULL ELSE substr(provider_model, 1, 256) END AS provider_model,
              opened_at, accepted_at, updated_at
         FROM conversation_runtime_segments
        WHERE conversation_id = ? AND state = 'current'`,
      [conversationId],
    );
    const turnRows = [...(activeTurn ? [activeTurn] : []), ...recentClosedTurns];
    const title = redactSensitivePreview(conversation.title);
    const providerSettings = parseProviderSettings(conversation.provider_settings_json);
    const nextTurnSettings = parseNextTurnSettings(conversation.next_turn_settings_json, conversation.permission_mode, conversation.collaboration_mode);
    const activeItemProjection = activeTurn ? this.activeTurnItems(conversationId, activeTurn.id) : { items: [], truncated: false };
    const activeItems = [...activeItemProjection.items];
    let activeItemsTruncated = activeItemProjection.truncated;
    const activeTurnSummary = activeTurn ? this.toTurnSummary(conversationId, activeTurn) : null;
    const snapshotBase: ConversationSnapshotV2 = {
      schemaVersion: 2,
      structureGeneration: conversationSnapshotV2StructureGeneration,
      conversationSchemaGeneration,
      throughEventSeq: stream?.latest_sequence ?? 0,
      eventStreamGeneration: stream?.generation_id ?? null,
      conversation: {
        id: conversation.id,
        projectId: conversation.project_id,
        taskId: conversation.task_id,
        title: title.text,
        titleRedacted: title.redacted,
        status: conversation.status,
        stage: conversation.stage,
        stageUpdatedAt: conversation.stage_updated_at,
        archived: conversation.archived === 1,
        transportKind: conversation.transport_kind,
        providerState: conversation.provider_state,
        providerModel: conversation.provider_model,
        providerSettings,
        nextTurnSettings,
        agentKind: conversation.agent_kind,
        createdAt: conversation.created_at,
        updatedAt: conversation.updated_at,
      },
      openSegment: currentSegment
        ? {
            id: currentSegment.id,
            runtimeKind: currentSegment.runtime_kind,
            state: currentSegment.state,
            nativeSessionId: currentSegment.native_session_id,
            providerModel: currentSegment.provider_model,
            openedAt: currentSegment.opened_at,
            acceptedAt: currentSegment.accepted_at,
            updatedAt: currentSegment.updated_at,
          }
        : null,
      activeTurn: activeTurnSummary,
      recentClosedTurns: recentClosedTurns.map((turn) => this.toTurnSummary(conversationId, turn)),
      // 会话正文首屏允许延后读取聚合指标；旧客户端未传该选项时仍保持原响应契约。
      sessionMetrics: options.includeSessionMetrics === false ? null : readConversationSessionMetrics(this.db, conversationId, activeTurn?.id ?? null),
      collections: {
        timeline: { throughSequence: this.maximumSequence('conversation_timeline_events', 'sequence', conversationId) },
        modelHistory: { throughSequence: this.maximumSequence('conversation_model_history', 'sequence', conversationId) },
        process: { throughSequence: this.maximumSequence('conversation_process_items', 'process_sequence', conversationId) },
        resources: {
          available: Boolean(this.db.get<{ present: number }>(`SELECT 1 AS present FROM conversation_resources WHERE conversation_id = ? LIMIT 1`, [conversationId])),
        },
      },
      limits: {
        closedTurnLimit,
        byteLimit,
        returnedTurnCount: turnRows.length,
        responseBytes: 0,
      },
    };
    const buildSnapshot = (): ConversationSnapshotV2 =>
      stableResponseBytes({
        ...snapshotBase,
        activeTurn: activeTurnSummary
          ? {
              ...activeTurnSummary,
              activeItems: [...activeItems],
              activeItemsTruncated,
            }
          : null,
        limits: { ...snapshotBase.limits, responseBytes: 0 },
      });
    let snapshotWithoutMetrics = buildSnapshot();
    while (snapshotWithoutMetrics.limits.responseBytes > byteLimit && activeItems.length > 0) {
      activeItems.shift();
      activeItemsTruncated = true;
      snapshotWithoutMetrics = buildSnapshot();
    }
    return finalizeBoundedResponse(snapshotWithoutMetrics, byteLimit, 'Snapshot V2 固定字段超过响应字节预算。');
  }

  readSessionMetrics(conversationIdValue: string): ConversationSessionMetricsSnapshot {
    const conversationId = requiredIdentity(conversationIdValue, 'conversationId');
    const conversation = this.db.get<{ provider_state: string }>(
      `SELECT provider_state
                                                                    FROM conversations
                                                                    WHERE id = ?`,
      [conversationId],
    );
    if (!conversation) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_NOT_FOUND', '会话不存在。', 404);
    const activeTurnCandidate = this.latestTurnsByStatus(conversationId, ['running', 'dispatching', 'waiting'], 1)[0];
    const activeTurn = conversation.provider_state === 'active' || conversation.provider_state === 'waiting' ? activeTurnCandidate : undefined;
    return readConversationSessionMetrics(this.db, conversationId, activeTurn?.id ?? null);
  }

  listTimelinePage(input: { conversationId: string; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationTimelinePageItem> {
    const context = this.sequencePageContext(input, 'timeline', '');
    const rows = this.db.select<{
      id: string;
      sequence: number;
      event_kind: string;
      turn_id: string | null;
      submission_id: string | null;
      segment_id: string | null;
      occurred_at: string;
      payload_preview: string;
      payload_bytes: number;
      payload_characters: number;
    }>(
      `SELECT id, sequence, event_kind, turn_id, submission_id, segment_id, occurred_at,
              substr(payload_json, 1, ?) AS payload_preview,
              length(CAST(payload_json AS BLOB)) AS payload_bytes,
              length(payload_json) AS payload_characters
         FROM conversation_timeline_events
        WHERE conversation_id = ? AND sequence > ? AND sequence <= ?
        ORDER BY sequence
        LIMIT ?`,
      [previewCharacterLimit, context.conversationId, context.afterSequence, context.throughSequence, context.entryLimit + 1],
    );
    const items = rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      eventKind: row.event_kind,
      turnId: row.turn_id,
      submissionId: row.submission_id,
      segmentId: row.segment_id,
      occurredAt: row.occurred_at,
      payload: boundedProjection(
        row.payload_preview,
        row.payload_bytes,
        this.contentHandle({
          kind: 'timeline_payload',
          conversationId: context.conversationId,
          identity: String(row.sequence),
          turnId: row.turn_id,
          revision: row.occurred_at,
          totalCharacters: row.payload_characters,
          totalBytes: row.payload_bytes,
        }),
        false,
      ),
    }));
    return buildSequencePage(context, items);
  }

  listModelHistoryPage(input: { conversationId: string; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationModelHistoryPageItem> {
    const context = this.sequencePageContext(input, 'model_history', '');
    const rows = this.db.select<ModelHistoryProjectionRow>(
      `SELECT id,
                sequence,
                turn_id,
                submission_id,
                (SELECT client_message_id
                 FROM conversation_submissions
                 WHERE id = conversation_model_history.submission_id) AS client_user_message_id,
                ${modelHistoryProviderItemSql}                        AS provider_item_id,
                ${modelHistoryReasoningSummarySql}                    AS reasoning_summary,
                ${modelHistoryAssistantPhaseSql}                      AS assistant_phase,
                ${modelHistoryFormalPlanSql}                           AS formal_plan,
                segment_id,
                role,
                tool_pair_id,
                confirmed_at,
              substr(${modelHistoryVisibleContentSql}, 1, ?)         AS content_preview,
              length(CAST(${modelHistoryVisibleContentSql} AS BLOB)) AS content_bytes,
              length(${modelHistoryVisibleContentSql})               AS content_characters
         FROM conversation_model_history
        WHERE conversation_id = ? AND sequence > ? AND sequence <= ?
        ORDER BY sequence
        LIMIT ?`,
      [previewCharacterLimit, context.conversationId, context.afterSequence, context.throughSequence, context.entryLimit + 1],
    );
    return buildSequencePage(context, this.mapModelHistoryRows(context.conversationId, rows));
  }

  /**
   * 按权威 turn 身份补齐完成轮次的模型正文。过程表只保存命令、工具和摘要，
   * 不能替代运行期间已经展示过的阶段性 commentary；展开历史轮次时必须同时读取二者。
   */
  listTurnModelHistoryPage(input: { conversationId: string; turnId: string; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationModelHistoryPageItem> {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const turnId = this.requireTurn(conversationId, input.turnId);
    const context = this.sequencePageContext({ ...input, conversationId }, 'model_history', `turn:${turnId}`, {
      table: 'conversation_model_history',
      column: 'sequence',
      extraWhere: ' AND turn_id = ?',
      extraParams: [turnId],
    });
    const rows = this.db.select<ModelHistoryProjectionRow>(
      `SELECT id,
              sequence,
              turn_id,
              submission_id,
              (SELECT client_message_id
               FROM conversation_submissions
               WHERE id = conversation_model_history.submission_id) AS client_user_message_id,
              ${modelHistoryProviderItemSql}                        AS provider_item_id,
              ${modelHistoryReasoningSummarySql}                    AS reasoning_summary,
              ${modelHistoryAssistantPhaseSql}                      AS assistant_phase,
              ${modelHistoryFormalPlanSql}                          AS formal_plan,
              segment_id,
              role,
              tool_pair_id,
              confirmed_at,
              substr(${modelHistoryVisibleContentSql}, 1, ?)         AS content_preview,
              length(CAST(${modelHistoryVisibleContentSql} AS BLOB)) AS content_bytes,
              length(${modelHistoryVisibleContentSql})               AS content_characters
         FROM conversation_model_history
        WHERE conversation_id = ? AND turn_id = ?
          AND sequence > ? AND sequence <= ?
        ORDER BY sequence
        LIMIT ?`,
      [previewCharacterLimit, context.conversationId, turnId, context.afterSequence, context.throughSequence, context.entryLimit + 1],
    );
    return buildSequencePage(context, this.mapModelHistoryRows(context.conversationId, rows));
  }

  /**
   * 首屏从冻结高水位向前读取最近历史；nextCursor 继续向更早序号推进。
   * 返回项始终按 sequence 正序，避免 Renderer 因加载方向改变稳定身份或时间线顺序。
   */
  listModelHistoryTailPage(input: { conversationId: string; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationModelHistoryPageItem> {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const limits = normalizePageLimits(input.entryLimit, input.byteLimit);
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const cursor = decoded ? requireReverseSequenceCursor(decoded, conversationId) : null;
    const throughSequence = cursor?.throughSequence ?? this.maximumSequence('conversation_model_history', 'sequence', conversationId);
    const beforeSequence = cursor?.beforeSequence ?? throughSequence + 1;
    const throughEventSeq = cursor?.throughEventSeq ?? this.throughEventSeq(conversationId);
    if (throughSequence === 0) return emptyPage(conversationId, 'model_history', throughEventSeq, limits);
    const rows = this.db.select<ModelHistoryProjectionRow>(
      `SELECT id, sequence, turn_id, submission_id,
              (SELECT client_message_id FROM conversation_submissions WHERE id = conversation_model_history.submission_id) AS client_user_message_id,
              ${modelHistoryProviderItemSql} AS provider_item_id,
              ${modelHistoryReasoningSummarySql} AS reasoning_summary,
              ${modelHistoryAssistantPhaseSql} AS assistant_phase,
              ${modelHistoryFormalPlanSql} AS formal_plan,
              segment_id, role, tool_pair_id, confirmed_at,
              substr(${modelHistoryVisibleContentSql}, 1, ?)         AS content_preview,
              length(CAST(${modelHistoryVisibleContentSql} AS BLOB)) AS content_bytes,
              length(${modelHistoryVisibleContentSql})               AS content_characters
         FROM conversation_model_history
        WHERE conversation_id = ? AND sequence < ? AND sequence <= ?
        ORDER BY sequence DESC
        LIMIT ?`,
      [previewCharacterLimit, conversationId, beforeSequence, throughSequence, limits.entryLimit + 1],
    );
    return buildReverseSequencePage({
      conversationId,
      throughSequence,
      throughEventSeq,
      limits,
      candidates: this.mapModelHistoryRows(conversationId, rows),
    });
  }

  listProcessPage(input: { conversationId: string; turnId: string; kind?: ConversationProcessKind; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationProcessPageItem> {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const turnId = this.requireTurn(conversationId, input.turnId);
    const kind = input.kind === undefined ? null : processKind(input.kind);
    const pageKind = kind === 'command' ? 'commands' : 'process';
    const scope = `${turnId}\0${kind ?? '*'}`;
    const context = this.sequencePageContext({ ...input, conversationId }, pageKind, scope, {
      table: 'conversation_process_items',
      column: 'process_sequence',
      extraWhere: kind ? ' AND turn_id = ? AND kind = ?' : ' AND turn_id = ?',
      extraParams: kind ? [turnId, kind] : [turnId],
    });
    const rows = this.db.select<{
      id: string;
      process_sequence: number;
      turn_id: string;
      segment_id: string;
      kind: ConversationProcessKind;
      status: string;
      title: string;
      source_event_id: string | null;
      started_at: string;
      completed_at: string | null;
      detail_preview: string;
      detail_bytes: number;
      detail_characters: number;
      presentation_json: string | null;
    }>(
      `SELECT id, process_sequence, turn_id, segment_id, kind, status, substr(title, 1, 512) AS title,
              source_event_id, started_at, completed_at,
              substr(detail_json, 1, ?) AS detail_preview,
              length(CAST(detail_json AS BLOB)) AS detail_bytes,
              length(detail_json) AS detail_characters,
              CASE WHEN kind = 'waiting' THEN detail_json ELSE NULL END AS presentation_json
         FROM conversation_process_items
        WHERE conversation_id = ? AND turn_id = ?${kind ? ' AND kind = ?' : ''}
          AND process_sequence > ? AND process_sequence <= ?
        ORDER BY process_sequence
        LIMIT ?`,
      [previewCharacterLimit, context.conversationId, turnId, ...(kind ? [kind] : []), context.afterSequence, context.throughSequence, context.entryLimit + 1],
    );
    const pairIds = rows.map((row) => toolPairIdFromSourceEvent(row.source_event_id));
    const toolResults = this.toolResultsByPair(context.conversationId, pairIds);
    const items = rows.map((row, index) => {
      const mutable = row.status === 'in_progress';
      const pairId = pairIds[index] ?? null;
      return {
        id: row.id,
        sequence: row.process_sequence,
        turnId: row.turn_id,
        segmentId: row.segment_id,
        providerItemId: pairId,
        kind: row.kind,
        status: row.status,
        title: row.title,
        sourceEventId: row.source_event_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        presentation: recoveredRequestUserInputPresentation(row.presentation_json),
        detail: boundedProjection(
          row.detail_preview,
          row.detail_bytes,
          mutable
            ? null
            : this.contentHandle({
                kind: 'process_detail',
                conversationId: context.conversationId,
                identity: String(row.process_sequence),
                turnId: row.turn_id,
                revision: `${row.status}:${row.completed_at ?? ''}`,
                totalCharacters: row.detail_characters,
                totalBytes: row.detail_bytes,
              }),
          mutable,
        ),
        toolResult: pairId ? (toolResults.get(pairId) ?? null) : null,
      };
    });
    return buildSequencePage(context, items);
  }

  listResourcePage(input: { conversationId: string; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationResourcePageItem> {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const limits = normalizePageLimits(input.entryLimit, input.byteLimit);
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const cursor = decoded ? requireResourceCursor(decoded, conversationId) : null;
    const through =
      cursor?.through ??
      mapResourceOrderKey(
        this.db.get<{ created_at: string; source_index: number; id: string }>(
          `SELECT created_at, source_index, id
             FROM conversation_resources
            WHERE conversation_id = ?
            ORDER BY created_at DESC, source_index DESC, id DESC
            LIMIT 1`,
          [conversationId],
        ),
      );
    const throughEventSeq = cursor?.throughEventSeq ?? this.throughEventSeq(conversationId);
    if (!through) return emptyPage(conversationId, 'resources', throughEventSeq, limits);
    const after = cursor?.after ?? null;
    const rows = this.db.select<{
      id: string;
      turn_id: string;
      item_id: string;
      source_index: number;
      kind: string;
      presentation: string;
      display_name: string | null;
      mime_type: string | null;
      preview_kind: string | null;
      icon_kind: string | null;
      attachment_ref: string | null;
      task_push_attachment_key: string | null;
      origin: string | null;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, turn_id, item_id, source_index, kind, presentation,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.displayName') AS TEXT), 1, 512) ELSE NULL END AS display_name,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.mimeType') AS TEXT), 1, 256) ELSE NULL END AS mime_type,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.previewKind') AS TEXT), 1, 64) ELSE NULL END AS preview_kind,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.iconKind') AS TEXT), 1, 64) ELSE NULL END AS icon_kind,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.attachmentRef') AS TEXT), 1, 512) ELSE NULL END AS attachment_ref,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.taskPushAttachmentKey') AS TEXT), 1, 512) ELSE NULL END AS task_push_attachment_key,
              CASE WHEN json_valid(display_json) THEN substr(CAST(json_extract(display_json, '$.origin') AS TEXT), 1, 128) ELSE NULL END AS origin,
              created_at, updated_at
         FROM conversation_resources
        WHERE conversation_id = ?
          ${after ? 'AND (created_at, source_index, id) > (?, ?, ?)' : ''}
          AND (created_at, source_index, id) <= (?, ?, ?)
        ORDER BY created_at, source_index, id
        LIMIT ?`,
      [conversationId, ...(after ? [after.createdAt, after.sourceIndex, after.id] : []), through.createdAt, through.sourceIndex, through.id, limits.entryLimit + 1],
    );
    const items = rows.map((row) => ({
      id: row.id,
      turnId: row.turn_id,
      itemId: row.item_id,
      sourceIndex: row.source_index,
      kind: row.kind,
      presentation: row.presentation,
      displayName: row.display_name ?? 'Resource',
      mimeType: row.mime_type,
      previewKind: row.preview_kind,
      iconKind: row.icon_kind,
      attachmentRef: row.attachment_ref,
      taskPushAttachmentKey: row.task_push_attachment_key,
      origin: row.origin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      accessPolicy: 'authorized_open_intent_or_preview' as const,
    }));
    const upper: ResourceOrderKey = through;
    return buildCompositePage({
      conversationId,
      kind: 'resources',
      throughEventSeq,
      throughSequence: 0,
      limits,
      candidates: items,
      cursorFor: (item) =>
        encodeCursor({
          version: 2,
          type: 'resource',
          kind: 'resources',
          conversationId,
          after: { createdAt: item.createdAt, sourceIndex: item.sourceIndex, id: item.id },
          through: upper,
          throughEventSeq,
        }),
    });
  }

  getChangeSetSummary(conversationIdValue: string, turnIdValue: string): ConversationChangeSetSummary {
    const conversationId = requiredIdentity(conversationIdValue, 'conversationId');
    const turnId = this.requireTurn(conversationId, turnIdValue);
    const row = this.db.get<{
      id: string;
      project_id: string;
      conversation_id: string;
      turn_id: string;
      provider_turn_id: string;
      state: string;
      pre_image_digest: string | null;
      post_image_digest: string | null;
      has_conflict: number;
      unavailable_reason: string | null;
      created_at: string;
      updated_at: string;
      file_count: number;
      added_lines: number;
      deleted_lines: number;
      diff_bytes: number;
    }>(
      `SELECT change_set.id, change_set.project_id, change_set.conversation_id, change_set.turn_id,
              change_set.provider_turn_id, change_set.state, change_set.pre_image_digest,
              change_set.post_image_digest, CASE WHEN change_set.conflict_json IS NULL THEN 0 ELSE 1 END AS has_conflict,
              CASE WHEN change_set.unavailable_reason IS NULL THEN NULL ELSE substr(change_set.unavailable_reason, 1, 1024) END AS unavailable_reason,
              change_set.created_at, change_set.updated_at,
              COUNT(change_file.id) AS file_count,
              COALESCE(SUM(change_file.added_lines), 0) AS added_lines,
              COALESCE(SUM(change_file.deleted_lines), 0) AS deleted_lines,
              COALESCE(NULLIF(change_set.unified_diff_byte_length, 0), length(CAST(change_set.unified_diff AS BLOB))) AS diff_bytes
         FROM turn_change_sets AS change_set
         LEFT JOIN turn_change_files AS change_file ON change_file.change_set_id = change_set.id
        WHERE change_set.conversation_id = ? AND change_set.turn_id = ?
        GROUP BY change_set.id`,
      [conversationId, turnId],
    );
    if (!row) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CHANGE_SET_NOT_FOUND', '轮次变更集不存在。', 404);
    return {
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      turnId: row.turn_id,
      providerTurnId: row.provider_turn_id,
      state: row.state,
      preImageDigest: row.pre_image_digest,
      postImageDigest: row.post_image_digest,
      hasConflict: row.has_conflict === 1,
      unavailableReason: row.unavailable_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      fileCount: row.file_count,
      addedLines: row.added_lines,
      deletedLines: row.deleted_lines,
      diffBytes: row.diff_bytes,
    };
  }

  listChangeFilesPage(input: { conversationId: string; turnId: string; changeSetId: string; cursor?: string; entryLimit?: number; byteLimit?: number }): ConversationSnapshotV2Page<ConversationChangeFilePageItem> {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const turnId = this.requireTurn(conversationId, input.turnId);
    const changeSetId = requiredIdentity(input.changeSetId, 'changeSetId');
    const changeSet = this.db.get<{ id: string; state: string; updated_at: string }>(`SELECT id, state, updated_at FROM turn_change_sets WHERE id = ? AND conversation_id = ? AND turn_id = ?`, [changeSetId, conversationId, turnId]);
    if (!changeSet) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CHANGE_SET_NOT_FOUND', '轮次变更集不存在或不属于当前会话。', 404);
    const limits = normalizePageLimits(input.entryLimit, input.byteLimit);
    const scope = `${turnId}\0${changeSetId}`;
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const cursor = decoded ? requireChangeFileCursor(decoded, conversationId, scope) : null;
    const through =
      cursor?.through ?? mapChangeFileOrderKey(this.db.get<{ source_index: number; id: string }>(`SELECT source_index, id FROM turn_change_files WHERE change_set_id = ? ORDER BY source_index DESC, id DESC LIMIT 1`, [changeSetId]));
    const throughEventSeq = cursor?.throughEventSeq ?? this.throughEventSeq(conversationId);
    if (!through) return emptyPage(conversationId, 'change_files', throughEventSeq, limits);
    const after = cursor?.after ?? null;
    const rows = this.db.select<{
      id: string;
      change_set_id: string;
      source_item_id: string | null;
      source_index: number;
      old_path: string | null;
      new_path: string | null;
      change_type: string;
      added_lines: number;
      deleted_lines: number;
      pre_hash: string | null;
      post_hash: string | null;
      pre_exists: number;
      post_exists: number;
      reversible: number;
      unavailable_reason: string | null;
      diff_bytes: number;
      diff_characters: number;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, change_set_id, source_item_id, source_index,
              CASE WHEN old_path IS NULL THEN NULL ELSE substr(old_path, 1, 2048) END AS old_path,
              CASE WHEN new_path IS NULL THEN NULL ELSE substr(new_path, 1, 2048) END AS new_path,
              change_type, added_lines, deleted_lines, pre_hash, post_hash, pre_exists, post_exists,
              reversible,
              CASE WHEN unavailable_reason IS NULL THEN NULL ELSE substr(unavailable_reason, 1, 1024) END AS unavailable_reason,
              COALESCE(NULLIF(unified_diff_byte_length, 0), length(CAST(unified_diff AS BLOB))) AS diff_bytes,
              COALESCE(NULLIF(unified_diff_character_length, 0), length(unified_diff)) AS diff_characters,
              created_at, updated_at
         FROM turn_change_files
        WHERE change_set_id = ?
          ${after ? 'AND (source_index, id) > (?, ?)' : ''}
          AND (source_index, id) <= (?, ?)
        ORDER BY source_index, id
        LIMIT ?`,
      [changeSetId, ...(after ? [after.sourceIndex, after.id] : []), through.sourceIndex, through.id, limits.entryLimit + 1],
    );
    const stable = stableChangeSetStates.has(changeSet.state);
    const items = rows.map((row) => ({
      id: row.id,
      changeSetId: row.change_set_id,
      sourceItemId: row.source_item_id,
      sourceIndex: row.source_index,
      oldPath: row.old_path,
      newPath: row.new_path,
      changeType: row.change_type,
      addedLines: row.added_lines,
      deletedLines: row.deleted_lines,
      preHash: row.pre_hash,
      postHash: row.post_hash,
      preExists: row.pre_exists === 1,
      postExists: row.post_exists === 1,
      reversible: row.reversible === 1,
      unavailableReason: row.unavailable_reason,
      diffBytes: row.diff_bytes,
      diffHandle: stable
        ? this.contentHandle({
            kind: 'change_file_diff',
            conversationId,
            identity: row.id,
            turnId,
            revision: `${changeSet.state}:${changeSet.updated_at}:${row.updated_at}`,
            totalCharacters: row.diff_characters,
            totalBytes: row.diff_bytes,
          })
        : null,
      detailState: stable ? ('available' as const) : ('transitioning' as const),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
    const upper: ChangeFileOrderKey = through;
    return buildCompositePage({
      conversationId,
      kind: 'change_files',
      throughEventSeq,
      throughSequence: 0,
      limits,
      candidates: items,
      cursorFor: (item) =>
        encodeCursor({
          version: 2,
          type: 'change_file',
          kind: 'change_files',
          conversationId,
          scope,
          after: { sourceIndex: item.sourceIndex, id: item.id },
          through: upper,
          throughEventSeq,
        }),
    });
  }

  readContentPage(input: { conversationId: string; handle: string; offset?: number; byteLimit?: number }): ConversationContentPage {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const payload = requireContentHandle(decodeCursor(input.handle), conversationId);
    const offset = boundedInteger(input.offset ?? 0, 'offset', 0, Number.MAX_SAFE_INTEGER);
    const byteLimit = boundedInteger(input.byteLimit ?? conversationSnapshotV2Limits.content.defaultByteLimit, 'byteLimit', conversationSnapshotV2Limits.content.minimumByteLimit, conversationSnapshotV2Limits.content.maximumByteLimit);
    const row = this.readContentSlice(payload, offset, byteLimit);
    if (!row) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_NOT_FOUND', '正文句柄指向的内容不存在或不属于当前会话。', 404);
    if (row.total_characters !== payload.totalCharacters || row.total_bytes !== payload.totalBytes || row.revision !== payload.revision) {
      throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_CHANGED', '正文在分页期间发生变化，请刷新摘要并使用新句柄读取。', 409);
    }
    if (payload.kind === 'process_detail' && row.transitioning === 1) {
      throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_TRANSITIONING', '进行中的处理过程正文不能使用稳定分页句柄。', 409);
    }
    if (payload.kind === 'change_file_diff' && row.transitioning === 1) {
      throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_TRANSITIONING', '变更集正在切换状态，请完成后重新获取 diff 句柄。', 409);
    }
    const bounded = takeCodePointPrefixByBytes(row.content_slice, byteLimit);
    const redacted = redactSensitivePreview(bounded.text);
    const consumedCharacters = bounded.codePoints;
    const nextOffset = offset + consumedCharacters < row.total_characters ? offset + consumedCharacters : null;
    return {
      schemaVersion: 2,
      structureGeneration: conversationSnapshotV2StructureGeneration,
      conversationId,
      kind: payload.kind,
      mimeType: payload.kind === 'change_file_diff' ? 'text/x-diff; charset=utf-8' : payload.kind === 'model_content' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      text: redacted.text,
      offset,
      nextOffset,
      totalCharacters: row.total_characters,
      totalBytes: row.total_bytes,
      contentByteLimit: byteLimit,
      redacted: redacted.redacted,
    };
  }

  resolveTurnId(conversationIdValue: string, turnIdValue: string): string | null {
    const conversationId = requiredIdentity(conversationIdValue, 'conversationId');
    const turnId = requiredIdentity(turnIdValue, 'turnId');
    const byId = this.db.get<{ id: string }>(`SELECT id FROM conversation_turns WHERE id = ? AND conversation_id = ?`, [turnId, conversationId]);
    if (byId) return byId.id;
    return this.db.get<{ id: string }>(`SELECT id FROM conversation_turns WHERE provider_turn_id = ? AND conversation_id = ?`, [turnId, conversationId])?.id ?? null;
  }

  private activeTurnItems(conversationId: string, turnId: string): { items: ConversationSnapshotV2ActiveItem[]; truncated: boolean } {
    const rows = this.db.select<{
      id: string;
      native_item_id: string | null;
      provider_item_id: string;
      item_type: string;
      phase: 'prework' | 'final_answer';
      text_preview: string;
      text_bytes: number;
      payload_preview: string;
      payload_bytes: number;
      projection_truncated: number;
      started_at: string | null;
      completed_at: string | null;
      updated_at: string;
    }>(
      `SELECT id, native_item_id, provider_item_id, item_type, phase,
              substr(text_projection, 1, ?) AS text_preview,
              length(CAST(text_projection AS BLOB)) AS text_bytes,
              substr(payload_projection_json, 1, ?) AS payload_preview,
              length(CAST(payload_projection_json AS BLOB)) AS payload_bytes,
              projection_truncated, started_at, completed_at, updated_at
         FROM conversation_provider_item_states
        WHERE conversation_id = ? AND turn_id = ? AND status = 'in_progress'
        ORDER BY
          CASE
            WHEN COALESCE(native_item_id, provider_item_id) GLOB 'item-[0-9]*'
            THEN CAST(substr(COALESCE(native_item_id, provider_item_id), 6) AS INTEGER)
            ELSE NULL
          END DESC,
          COALESCE(started_at, updated_at) DESC,
          updated_at DESC,
          id DESC
        LIMIT ?`,
      [previewCharacterLimit, previewCharacterLimit, conversationId, turnId, activeTurnItemLimit + 1],
    );
    const selected = rows.slice(0, activeTurnItemLimit).reverse();
    return {
      items: selected.map((row, order) => ({
        id: row.id,
        order,
        turnId,
        providerItemId: row.provider_item_id,
        itemType: row.item_type,
        status: 'in_progress' as const,
        phase: row.phase,
        text: activeItemProjection(row.text_preview, row.text_bytes, row.projection_truncated === 1),
        payload: activeItemProjection(row.payload_preview, row.payload_bytes, row.projection_truncated === 1),
        startedAt: row.started_at,
        completedAt: row.completed_at,
        updatedAt: row.updated_at,
      })),
      truncated: rows.length > activeTurnItemLimit,
    };
  }

  private toTurnSummary(conversationId: string, row: TurnRow): ConversationSnapshotV2TurnSummary {
    const latestProcess = this.db.get<{ process_sequence: number }>(
      `SELECT process_sequence
         FROM conversation_process_items
        WHERE conversation_id = ? AND turn_id = ? AND kind <> 'reasoning'
        ORDER BY process_sequence DESC
        LIMIT 1`,
      [conversationId, row.id],
    );
    const plan = parseTurnPlan(row.plan_json) ?? legacyTurnPlan(row.legacy_plan_text);
    return {
      id: row.id,
      providerTurnId: row.provider_turn_id,
      submissionId: row.client_submission_id,
      status: row.status,
      hasError: row.has_error === 1,
      hasPlan: row.has_plan === 1,
      plan,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      agentKind: row.agent_kind,
      openingUserMessage: this.openingUserMessage(conversationId, row.id),
      process: { available: Boolean(latestProcess), latestSequence: latestProcess?.process_sequence ?? 0 },
      resourcesAvailable: Boolean(this.db.get<{ present: number }>(`SELECT 1 AS present FROM conversation_resources WHERE conversation_id = ? AND turn_id = ? LIMIT 1`, [conversationId, row.id])),
      changeSetAvailable: Boolean(this.db.get<{ present: number }>(`SELECT 1 AS present FROM turn_change_sets WHERE conversation_id = ? AND turn_id = ? LIMIT 1`, [conversationId, row.id])),
    };
  }

  private openingUserMessage(conversationId: string, turnId: string): ConversationModelHistoryPageItem | null {
    const row = this.db.get<ModelHistoryProjectionRow>(
      `SELECT id, sequence, turn_id, submission_id,
              (SELECT client_message_id FROM conversation_submissions WHERE id = conversation_model_history.submission_id) AS client_user_message_id,
              ${modelHistoryProviderItemSql} AS provider_item_id,
              0 AS reasoning_summary,
              NULL AS assistant_phase,
              0 AS formal_plan,
              segment_id, role, tool_pair_id, confirmed_at,
              substr(${modelHistoryVisibleContentSql}, 1, ?)         AS content_preview,
              length(CAST(${modelHistoryVisibleContentSql} AS BLOB)) AS content_bytes,
              length(${modelHistoryVisibleContentSql})               AS content_characters
         FROM conversation_model_history
        WHERE conversation_id = ? AND turn_id = ? AND role = 'user'
        ORDER BY sequence
        LIMIT 1`,
      [previewCharacterLimit, conversationId, turnId],
    );
    return row ? (this.mapModelHistoryRows(conversationId, [row])[0] ?? null) : null;
  }

  private latestTurnsByStatus(conversationId: string, statuses: readonly string[], limit: number): TurnRow[] {
    return statuses
      .flatMap((status) =>
        this.db.select<TurnRow>(
          `${turnSummarySelectSql()}
             FROM conversation_turns
            WHERE conversation_id = ? AND status = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?`,
          [conversationId, status, limit],
        ),
      )
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || right.id.localeCompare(left.id))
      .slice(0, limit);
  }

  private sequencePageContext(
    input: { conversationId: string; cursor?: string; entryLimit?: number; byteLimit?: number },
    kind: SequenceCursorPayload['kind'],
    scope: string,
    highWater: {
      table: 'conversation_process_items' | 'conversation_model_history';
      column: 'process_sequence' | 'sequence';
      extraWhere: string;
      extraParams: Array<string | number>;
    } | null = null,
  ): SequencePageContext {
    const conversationId = requiredIdentity(input.conversationId, 'conversationId');
    const limits = normalizePageLimits(input.entryLimit, input.byteLimit);
    const decoded = input.cursor ? decodeCursor(input.cursor) : null;
    const cursor = decoded ? requireSequenceCursor(decoded, conversationId, kind, scope) : null;
    const throughSequence =
      cursor?.throughSequence ??
      (highWater
        ? (this.db.get<{ maximum_sequence: number | null }>(`SELECT MAX(${highWater.column}) AS maximum_sequence FROM ${highWater.table} WHERE conversation_id = ?${highWater.extraWhere}`, [conversationId, ...highWater.extraParams])
            ?.maximum_sequence ?? 0)
        : this.maximumSequence(kind === 'timeline' ? 'conversation_timeline_events' : 'conversation_model_history', 'sequence', conversationId));
    return {
      conversationId,
      kind,
      scope,
      afterSequence: cursor?.afterSequence ?? 0,
      throughSequence,
      throughEventSeq: cursor?.throughEventSeq ?? this.throughEventSeq(conversationId),
      ...limits,
    };
  }

  private maximumSequence(table: 'conversation_timeline_events' | 'conversation_model_history' | 'conversation_process_items', column: 'sequence' | 'process_sequence', conversationId: string): number {
    return this.db.get<{ maximum_sequence: number | null }>(`SELECT MAX(${column}) AS maximum_sequence FROM ${table} WHERE conversation_id = ?`, [conversationId])?.maximum_sequence ?? 0;
  }

  private mapModelHistoryRows(conversationId: string, rows: ModelHistoryProjectionRow[]): ConversationModelHistoryPageItem[] {
    const toolResults = this.toolResultsByPair(
      conversationId,
      rows.map((row) => row.tool_pair_id),
    );
    return rows.map((row) => ({
      id: row.id,
      sequence: row.sequence,
      turnId: row.turn_id,
      submissionId: row.submission_id,
      clientUserMessageId: row.client_user_message_id,
      providerItemId: row.provider_item_id,
      reasoningSummary: row.reasoning_summary === 1,
      phase: row.assistant_phase,
      formalPlan: row.formal_plan === 1,
      segmentId: row.segment_id,
      role: row.role,
      toolPairId: row.tool_pair_id,
      confirmedAt: row.confirmed_at,
      content: boundedProjection(
        row.content_preview,
        row.content_bytes,
        this.contentHandle({
          kind: 'model_content',
          conversationId,
          identity: String(row.sequence),
          turnId: row.turn_id,
          revision: row.confirmed_at,
          totalCharacters: row.content_characters,
          totalBytes: row.content_bytes,
        }),
        false,
      ),
      toolResult: row.tool_pair_id ? (toolResults.get(row.tool_pair_id) ?? null) : null,
    }));
  }

  private throughEventSeq(conversationId: string): number {
    const stream = this.db.get<{ latest_sequence: number }>(`SELECT latest_sequence FROM conversation_sync_event_streams WHERE conversation_id = ? AND is_current = 1`, [conversationId]);
    return stream?.latest_sequence ?? 0;
  }

  private requireTurn(conversationId: string, turnIdValue: string): string {
    const turnId = this.resolveTurnId(conversationId, turnIdValue);
    if (!turnId) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_TURN_NOT_FOUND', '轮次不存在或不属于当前会话。', 404);
    return turnId;
  }

  private contentHandle(payload: Omit<ContentHandlePayload, 'version' | 'type'>): string {
    return encodeCursor({ version: 2, type: 'content', ...payload });
  }

  private toolResultsByPair(conversationId: string, candidates: Array<string | null>): Map<string, ConversationToolResultDescriptor> {
    const pairIds = [...new Set(candidates.filter((value): value is string => Boolean(value)))];
    if (pairIds.length === 0) return new Map();
    const placeholders = pairIds.map(() => '?').join(', ');
    const rows = this.db.select<{
      tool_pair_id: string;
      handle: string;
      sha256: string;
      byte_length: number;
      mime_type: string;
      projection_preview: string;
      projection_bytes: number;
    }>(
      `SELECT tool_pair_id, handle, sha256, byte_length, mime_type,
              substr(projection_json, 1, ?) AS projection_preview,
              length(CAST(projection_json AS BLOB)) AS projection_bytes
         FROM conversation_tool_results
        WHERE conversation_id = ? AND tool_pair_id IN (${placeholders})`,
      [previewCharacterLimit, conversationId, ...pairIds],
    );
    return new Map(
      rows.map((row) => {
        const projection = redactSensitivePreview(row.projection_preview);
        return [
          row.tool_pair_id,
          {
            handle: row.handle,
            sha256: row.sha256,
            byteLength: row.byte_length,
            mimeType: row.mime_type,
            projection: projection.text,
            projectionTruncated: row.projection_bytes > Buffer.byteLength(row.projection_preview, 'utf8'),
            redacted: projection.redacted,
          },
        ];
      }),
    );
  }

  private readContentSlice(payload: ContentHandlePayload, offset: number, byteLimit: number): { content_slice: string; total_characters: number; total_bytes: number; revision: string; transitioning: number } | undefined {
    const sliceStart = offset + 1;
    const sliceCharacters = byteLimit + 1;
    if (payload.kind === 'timeline_payload') {
      return this.db.get(
        `SELECT substr(payload_json, ?, ?) AS content_slice,
                length(payload_json) AS total_characters,
                length(CAST(payload_json AS BLOB)) AS total_bytes,
                occurred_at AS revision,
                0 AS transitioning
           FROM conversation_timeline_events
          WHERE conversation_id = ? AND sequence = ?`,
        [sliceStart, sliceCharacters, payload.conversationId, numericIdentity(payload.identity)],
      );
    }
    if (payload.kind === 'model_content') {
      return this.db.get(
        `SELECT substr(${modelHistoryVisibleContentSql}, ?, ?)         AS content_slice,
                  length(${modelHistoryVisibleContentSql})               AS total_characters,
                  length(CAST(${modelHistoryVisibleContentSql} AS BLOB)) AS total_bytes,
                confirmed_at AS revision,
                0 AS transitioning
           FROM conversation_model_history
          WHERE conversation_id = ? AND sequence = ?`,
        [sliceStart, sliceCharacters, payload.conversationId, numericIdentity(payload.identity)],
      );
    }
    if (payload.kind === 'process_detail') {
      return this.db.get(
        `SELECT substr(detail_json, ?, ?) AS content_slice,
                length(detail_json) AS total_characters,
                length(CAST(detail_json AS BLOB)) AS total_bytes,
                status || ':' || COALESCE(completed_at, '') AS revision,
                CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END AS transitioning
           FROM conversation_process_items
          WHERE conversation_id = ? AND turn_id = ? AND process_sequence = ?`,
        [sliceStart, sliceCharacters, payload.conversationId, payload.turnId, numericIdentity(payload.identity)],
      );
    }
    const changeFile = this.db.get<{
      unified_diff: string;
      unified_diff_artifact_ref_json: string | null;
      total_characters: number;
      total_bytes: number;
      revision: string;
      transitioning: number;
    }>(
      `SELECT change_file.unified_diff,
              change_file.unified_diff_artifact_ref_json,
              COALESCE(NULLIF(change_file.unified_diff_character_length, 0), length(change_file.unified_diff)) AS total_characters,
              COALESCE(NULLIF(change_file.unified_diff_byte_length, 0), length(CAST(change_file.unified_diff AS BLOB))) AS total_bytes,
              change_set.state || ':' || change_set.updated_at || ':' || change_file.updated_at AS revision,
              CASE WHEN change_set.state IN ('capturing', 'undoing', 'reapplying') THEN 1 ELSE 0 END AS transitioning
         FROM turn_change_files AS change_file
         JOIN turn_change_sets AS change_set ON change_set.id = change_file.change_set_id
        WHERE change_file.id = ? AND change_set.conversation_id = ? AND change_set.turn_id = ?`,
      [payload.identity, payload.conversationId, payload.turnId],
    );
    if (!changeFile) return undefined;
    const artifactRef = parseSnapshotArtifactRef(changeFile.unified_diff_artifact_ref_json);
    const content = artifactRef ? this.readChangeFileArtifact(artifactRef, payload.identity) : changeFile.unified_diff;
    return {
      content_slice: Array.from(content)
        .slice(offset, offset + sliceCharacters)
        .join(''),
      total_characters: changeFile.total_characters,
      total_bytes: changeFile.total_bytes,
      revision: changeFile.revision,
      transitioning: changeFile.transitioning,
    };
  }

  private readChangeFileArtifact(ref: ArtifactRef, changeFileId: string): string {
    if (!this.artifactStore) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_NOT_FOUND', 'diff ArtifactRef 存储未接入。', 404);
    if (ref.owner.kind !== 'turn_change_file_diff' || ref.owner.id !== changeFileId) {
      throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_NOT_FOUND', 'diff ArtifactRef owner 与内容句柄不匹配。', 404);
    }
    const { bytes } = this.artifactStore.readAuthorizedSync({
      sha256: ref.sha256,
      owner: { kind: ref.owner.kind, id: ref.owner.id },
      maximumContentBytes: Math.max(1, ref.contentByteLength),
    });
    return Buffer.from(bytes).toString('utf8');
  }
}

interface SequencePageContext {
  conversationId: string;
  kind: SequenceCursorPayload['kind'];
  scope: string;
  afterSequence: number;
  throughSequence: number;
  throughEventSeq: number;
  entryLimit: number;
  byteLimit: number;
}

function turnSummarySelectSql(): string {
  return `SELECT id, provider_turn_id, client_submission_id, status,
                 CASE WHEN error_json IS NULL THEN 0 ELSE 1 END AS has_error,
                 CASE WHEN EXISTS (
                   SELECT 1
                     FROM conversation_provider_item_states AS projected_plan
                    WHERE projected_plan.turn_id = conversation_turns.id
                      AND projected_plan.item_type = 'plan'
                      AND projected_plan.status = 'completed'
                      AND trim(projected_plan.text_projection) <> ''
                 ) OR (plan_json IS NOT NULL AND EXISTS (
                   SELECT 1
                     FROM conversation_submissions AS plan_submission
                    WHERE plan_submission.id = conversation_turns.client_submission_id
                      AND json_valid(plan_submission.input_json)
                      AND json_extract(plan_submission.input_json, '$.context.workMode') = 'plan'
                 )) THEN 1 ELSE 0 END AS has_plan,
                 plan_json,
                 (SELECT projected_plan.text_projection
                    FROM conversation_provider_item_states AS projected_plan
                   WHERE projected_plan.turn_id = conversation_turns.id
                     AND projected_plan.item_type = 'plan'
                     AND projected_plan.status = 'completed'
                     AND trim(projected_plan.text_projection) <> ''
                   ORDER BY projected_plan.updated_at DESC, projected_plan.id DESC
                   LIMIT 1) AS legacy_plan_text,
                 started_at, completed_at, created_at, updated_at, agent_kind`;
}

/**
 * PLAN 正文可能来自 Provider 正式计划投影，而不一定收到 turn/plan/updated。
 * 普通 update_plan 历史只存在于 turn.plan_json/旧统一条目，不能据此升级为 PLAN 计划书。
 */
function legacyTurnPlan(text: string | null): ConversationSnapshotV2TurnPlan | null {
  const explanation = text?.trim();
  return explanation ? { explanation, steps: [] } : null;
}

function boundedProjection(previewValue: string, byteLength: number, contentHandle: string | null, refreshRequired: boolean): BoundedContentProjection {
  const redacted = redactSensitivePreview(previewValue);
  return {
    preview: redacted.text,
    byteLength,
    truncated: byteLength > Buffer.byteLength(previewValue, 'utf8'),
    redacted: redacted.redacted,
    contentHandle,
    refreshRequired,
  };
}

function activeItemProjection(previewValue: string, byteLength: number, sourceTruncated: boolean): BoundedContentProjection {
  const projection = boundedProjection(previewValue, byteLength, null, true);
  return sourceTruncated && !projection.truncated ? { ...projection, truncated: true } : projection;
}

function buildSequencePage<T extends { sequence: number }>(context: SequencePageContext, candidates: T[]): ConversationSnapshotV2Page<T> {
  return buildCompositePage({
    conversationId: context.conversationId,
    kind: context.kind,
    throughEventSeq: context.throughEventSeq,
    throughSequence: context.throughSequence,
    limits: { entryLimit: context.entryLimit, byteLimit: context.byteLimit },
    candidates,
    cursorFor: (item) =>
      encodeCursor({
        version: 2,
        type: 'sequence',
        kind: context.kind,
        conversationId: context.conversationId,
        scope: context.scope,
        afterSequence: item.sequence,
        throughSequence: context.throughSequence,
        throughEventSeq: context.throughEventSeq,
      }),
  });
}

function buildReverseSequencePage(input: {
  conversationId: string;
  throughSequence: number;
  throughEventSeq: number;
  limits: { entryLimit: number; byteLimit: number };
  /** SQL 已按 sequence DESC 返回；响应会恢复为正序。 */
  candidates: ConversationModelHistoryPageItem[];
}): ConversationSnapshotV2Page<ConversationModelHistoryPageItem> {
  const selected = input.candidates.slice(0, input.limits.entryLimit);
  let response: ConversationSnapshotV2Page<ConversationModelHistoryPageItem>;
  do {
    const hasMore = input.candidates.length > selected.length;
    const oldest = selected[selected.length - 1];
    const nextCursor =
      hasMore && oldest
        ? encodeCursor({
            version: 2,
            type: 'reverse_sequence',
            kind: 'model_history',
            conversationId: input.conversationId,
            beforeSequence: oldest.sequence,
            throughSequence: input.throughSequence,
            throughEventSeq: input.throughEventSeq,
          })
        : null;
    response = stableResponseBytes({
      schemaVersion: 2,
      structureGeneration: conversationSnapshotV2StructureGeneration,
      conversationId: input.conversationId,
      kind: 'model_history',
      throughEventSeq: input.throughEventSeq,
      throughSequence: input.throughSequence,
      items: [...selected].reverse(),
      hasMore,
      nextCursor,
      limits: {
        entryLimit: input.limits.entryLimit,
        byteLimit: input.limits.byteLimit,
        returnedItems: selected.length,
        responseBytes: 0,
      },
    });
    if (response.limits.responseBytes <= input.limits.byteLimit) return response;
    selected.pop();
  } while (selected.length > 0);
  if (input.candidates.length === 0) return response!;
  throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_BYTE_BUDGET_EXHAUSTED', '单条摘要超过分页响应字节预算。', 413);
}

function buildCompositePage<T>(input: {
  conversationId: string;
  kind: ConversationPageKind;
  throughEventSeq: number;
  throughSequence: number;
  limits: { entryLimit: number; byteLimit: number };
  candidates: T[];
  cursorFor: (item: T) => string;
}): ConversationSnapshotV2Page<T> {
  const selected = input.candidates.slice(0, input.limits.entryLimit);
  let response: ConversationSnapshotV2Page<T>;
  do {
    const hasMore = input.candidates.length > selected.length;
    const nextCursor = hasMore && selected.length > 0 ? input.cursorFor(selected[selected.length - 1]!) : null;
    response = stableResponseBytes({
      schemaVersion: 2,
      structureGeneration: conversationSnapshotV2StructureGeneration,
      conversationId: input.conversationId,
      kind: input.kind,
      throughEventSeq: input.throughEventSeq,
      throughSequence: input.throughSequence,
      items: [...selected],
      hasMore,
      nextCursor,
      limits: {
        entryLimit: input.limits.entryLimit,
        byteLimit: input.limits.byteLimit,
        returnedItems: selected.length,
        responseBytes: 0,
      },
    });
    if (response.limits.responseBytes <= input.limits.byteLimit) return response;
    selected.pop();
  } while (selected.length > 0);
  if (input.candidates.length === 0) return response!;
  throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_BYTE_BUDGET_EXHAUSTED', '单条摘要超过分页响应字节预算。', 413);
}

function emptyPage<T>(conversationId: string, kind: ConversationPageKind, throughEventSeq: number, limits: { entryLimit: number; byteLimit: number }): ConversationSnapshotV2Page<T> {
  return stableResponseBytes({
    schemaVersion: 2,
    structureGeneration: conversationSnapshotV2StructureGeneration,
    conversationId,
    kind,
    throughEventSeq,
    throughSequence: 0,
    items: [],
    hasMore: false,
    nextCursor: null,
    limits: { ...limits, returnedItems: 0, responseBytes: 0 },
  });
}

function finalizeBoundedResponse<T extends { limits: { responseBytes: number } }>(value: T, byteLimit: number, message: string): T {
  const response = stableResponseBytes(value);
  if (response.limits.responseBytes > byteLimit) throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_BYTE_BUDGET_EXHAUSTED', message, 413);
  return response;
}

function stableResponseBytes<T extends { limits: { responseBytes: number } }>(value: T): T {
  let response = value;
  for (let index = 0; index < 8; index += 1) {
    const measured = Buffer.byteLength(JSON.stringify(response), 'utf8');
    if (measured === response.limits.responseBytes) return response;
    response = { ...response, limits: { ...response.limits, responseBytes: measured } };
  }
  return response;
}

function normalizePageLimits(entryLimitValue: number | undefined, byteLimitValue: number | undefined): { entryLimit: number; byteLimit: number } {
  return {
    entryLimit: boundedInteger(entryLimitValue ?? conversationSnapshotV2Limits.page.defaultEntryLimit, 'entryLimit', 1, conversationSnapshotV2Limits.page.maximumEntryLimit),
    byteLimit: boundedInteger(byteLimitValue ?? conversationSnapshotV2Limits.page.defaultByteLimit, 'byteLimit', conversationSnapshotV2Limits.page.minimumByteLimit, conversationSnapshotV2Limits.page.maximumByteLimit),
  };
}

function boundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT', `${name} 必须是 ${minimum} 到 ${maximum} 之间的安全整数。`, 400);
  }
  return value;
}

function requiredIdentity(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 1_024) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT', `${name} 必须是非空且长度受控的字符串。`, 400);
  }
  return value;
}

function processKind(value: string): ConversationProcessKind {
  if (['reasoning', 'tool', 'command', 'retry', 'context_compaction', 'waiting', 'warning'].includes(value)) return value as ConversationProcessKind;
  throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_ARGUMENT', '过程类型无效。', 400);
}

function numericIdentity(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || String(parsed) !== value) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '正文句柄中的序号无效。', 400);
  }
  return parsed;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(value: string): CursorPayload {
  if (typeof value !== 'string' || !value || value.length > maximumCursorLength || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '分页游标格式无效。', 400);
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 2 || typeof parsed.type !== 'string') throw new Error('invalid cursor envelope');
    return parsed as unknown as CursorPayload;
  } catch {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '分页游标无法解析。', 400);
  }
}

function requireSequenceCursor(payload: CursorPayload, conversationId: string, kind: SequenceCursorPayload['kind'], scope: string): SequenceCursorPayload {
  if (
    payload.type !== 'sequence' ||
    payload.kind !== kind ||
    payload.conversationId !== conversationId ||
    payload.scope !== scope ||
    !validNonNegativeSequence(payload.afterSequence) ||
    !validNonNegativeSequence(payload.throughSequence) ||
    !validNonNegativeSequence(payload.throughEventSeq) ||
    payload.afterSequence > payload.throughSequence
  ) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '分页游标与当前会话、集合或读取上界不匹配。', 400);
  }
  return payload;
}

function requireReverseSequenceCursor(payload: CursorPayload, conversationId: string): ReverseSequenceCursorPayload {
  if (
    payload.type !== 'reverse_sequence' ||
    payload.kind !== 'model_history' ||
    payload.conversationId !== conversationId ||
    !validNonNegativeSequence(payload.beforeSequence) ||
    payload.beforeSequence === 0 ||
    !validNonNegativeSequence(payload.throughSequence) ||
    !validNonNegativeSequence(payload.throughEventSeq) ||
    payload.beforeSequence > payload.throughSequence + 1
  ) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '尾部历史游标与当前会话或读取上界不匹配。', 400);
  }
  return payload;
}

function requireResourceCursor(payload: CursorPayload, conversationId: string): ResourceCursorPayload {
  if (
    payload.type !== 'resource' ||
    payload.kind !== 'resources' ||
    payload.conversationId !== conversationId ||
    !validResourceKey(payload.after) ||
    !validResourceKey(payload.through) ||
    !validNonNegativeSequence(payload.throughEventSeq) ||
    compareResourceOrderKey(payload.after, payload.through) > 0
  ) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '资源分页游标与当前会话不匹配。', 400);
  }
  return payload;
}

function requireChangeFileCursor(payload: CursorPayload, conversationId: string, scope: string): ChangeFileCursorPayload {
  if (
    payload.type !== 'change_file' ||
    payload.kind !== 'change_files' ||
    payload.conversationId !== conversationId ||
    payload.scope !== scope ||
    !validChangeFileKey(payload.after) ||
    !validChangeFileKey(payload.through) ||
    !validNonNegativeSequence(payload.throughEventSeq) ||
    compareChangeFileOrderKey(payload.after, payload.through) > 0
  ) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '变更文件分页游标与当前会话或变更集不匹配。', 400);
  }
  return payload;
}

function requireContentHandle(payload: CursorPayload, conversationId: string): ContentHandlePayload {
  if (
    payload.type !== 'content' ||
    payload.conversationId !== conversationId ||
    !['timeline_payload', 'model_content', 'process_detail', 'change_file_diff'].includes(payload.kind) ||
    typeof payload.identity !== 'string' ||
    !payload.identity ||
    (payload.turnId !== null && typeof payload.turnId !== 'string') ||
    typeof payload.revision !== 'string' ||
    !validNonNegativeSequence(payload.totalCharacters) ||
    !validNonNegativeSequence(payload.totalBytes)
  ) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_INVALID_CURSOR', '正文句柄与当前会话不匹配。', 400);
  }
  return payload;
}

function parseSnapshotArtifactRef(value: string | null): ArtifactRef | null {
  if (!value) return null;
  let parsed: Partial<ArtifactRef>;
  try {
    parsed = JSON.parse(value) as Partial<ArtifactRef>;
  } catch {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_NOT_FOUND', 'diff ArtifactRef 无法解析。', 404);
  }
  if (
    parsed.storageGeneration !== artifactStoreGeneration ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.contentSha256 !== 'string' ||
    typeof parsed.byteLength !== 'number' ||
    typeof parsed.contentByteLength !== 'number' ||
    typeof parsed.mimeType !== 'string' ||
    (parsed.encoding !== 'identity' && parsed.encoding !== 'gzip-v1') ||
    typeof parsed.generationId !== 'string' ||
    typeof parsed.relativePath !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !parsed.owner ||
    typeof parsed.owner.kind !== 'string' ||
    typeof parsed.owner.id !== 'string'
  ) {
    throw snapshotError('ZEUS_CONVERSATION_SNAPSHOT_V2_CONTENT_NOT_FOUND', 'diff ArtifactRef 字段不完整。', 404);
  }
  return parsed as ArtifactRef;
}

function validResourceKey(value: unknown): value is ResourceOrderKey {
  return isRecord(value) && typeof value.createdAt === 'string' && validNonNegativeSequence(value.sourceIndex) && typeof value.id === 'string' && Boolean(value.id);
}

function validChangeFileKey(value: unknown): value is ChangeFileOrderKey {
  return isRecord(value) && validNonNegativeSequence(value.sourceIndex) && typeof value.id === 'string' && Boolean(value.id);
}

function mapResourceOrderKey(row: { created_at: string; source_index: number; id: string } | undefined): ResourceOrderKey | undefined {
  return row ? { createdAt: row.created_at, sourceIndex: row.source_index, id: row.id } : undefined;
}

function mapChangeFileOrderKey(row: { source_index: number; id: string } | undefined): ChangeFileOrderKey | undefined {
  return row ? { sourceIndex: row.source_index, id: row.id } : undefined;
}

function compareResourceOrderKey(left: ResourceOrderKey, right: ResourceOrderKey): number {
  return left.createdAt.localeCompare(right.createdAt) || left.sourceIndex - right.sourceIndex || left.id.localeCompare(right.id);
}

function compareChangeFileOrderKey(left: ChangeFileOrderKey, right: ChangeFileOrderKey): number {
  return left.sourceIndex - right.sourceIndex || left.id.localeCompare(right.id);
}

function validNonNegativeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseProviderSettings(value: string): ConversationSnapshotV2ProviderSettings | null {
  const settings = parseSettingsRecord(value);
  const model = boundedSettingString(settings?.model, 256);
  if (!settings || !model) return null;
  const generationId = boundedSettingString(settings.generationId, 256);
  const effort = boundedSettingString(settings.effort, 64);
  const serviceTier = settings.serviceTier === null ? null : boundedSettingString(settings.serviceTier, 64);
  return {
    ...(generationId ? { generationId } : {}),
    ...(validNonNegativeSequence(settings.sequence) ? { sequence: settings.sequence } : {}),
    model,
    ...(effort ? { effort } : {}),
    ...(settings.serviceTier === null || serviceTier ? { serviceTier } : {}),
  };
}

function parseNextTurnSettings(value: string, permissionModeValue: string, collaborationModeValue: string): ConversationSnapshotV2NextTurnSettings | null {
  const settings = parseSettingsRecord(value);
  const model = boundedSettingString(settings?.model, 256);
  if (!settings || !model) return null;
  const permissionMode = ['read-only', 'auto', 'full-access'].includes(String(settings.permissionMode))
    ? (settings.permissionMode as ConversationSnapshotV2NextTurnSettings['permissionMode'])
    : ['read-only', 'auto', 'full-access'].includes(permissionModeValue)
      ? (permissionModeValue as ConversationSnapshotV2NextTurnSettings['permissionMode'])
      : null;
  const collaborationMode = ['default', 'plan'].includes(String(settings.collaborationMode))
    ? (settings.collaborationMode as ConversationSnapshotV2NextTurnSettings['collaborationMode'])
    : ['default', 'plan'].includes(collaborationModeValue)
      ? (collaborationModeValue as ConversationSnapshotV2NextTurnSettings['collaborationMode'])
      : null;
  if (!permissionMode || !collaborationMode) return null;
  const effort = boundedSettingString(settings.effort, 64);
  const serviceTier = settings.serviceTier === null ? null : boundedSettingString(settings.serviceTier, 64);
  return {
    model,
    ...(effort ? { effort } : {}),
    ...(settings.serviceTier === null || serviceTier ? { serviceTier } : {}),
    permissionMode,
    collaborationMode,
  };
}

function parseSettingsRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseTurnPlan(value: string | null): ConversationSnapshotV2TurnPlan | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.steps)) return null;
  const explanation = parsed.explanation === null ? null : boundedSettingString(parsed.explanation, 4_000);
  // 计划进入 Snapshot V2 首屏，必须受固定字节预算约束，不能让异常长计划挤掉最近消息。
  const steps = parsed.steps.slice(0, 32).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const step = boundedSettingString(entry.step, 512);
    const status = entry.status;
    if (!step || (status !== 'pending' && status !== 'inProgress' && status !== 'completed')) return [];
    return [{ step, status: status as ConversationSnapshotV2TurnPlan['steps'][number]['status'] }];
  });
  if (steps.length === 0 && !explanation) return null;
  return { explanation, steps };
}

function boundedSettingString(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function recoveredRequestUserInputPresentation(detailJson: string | null): Record<string, unknown> | null {
  if (!detailJson) return null;
  let detail: unknown;
  try {
    detail = JSON.parse(detailJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(detail) || detail.recovery !== 'content_only' || detail.requestType !== 'request_user_input' || !Array.isArray(detail.questions) || detail.questions.length === 0 || detail.questions.length > 3) return null;
  const questionIds = new Set<string>();
  const questions = detail.questions.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const id = boundedPresentationString(candidate.id, 256);
    const header = boundedPresentationString(candidate.header, 512);
    const question = boundedPresentationString(candidate.question, 8_000);
    if (!id || !header || !question || questionIds.has(id)) return [];
    const rawOptions = candidate.options;
    let options: Array<{ label: string; description: string }> | null = null;
    if (rawOptions !== null) {
      if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > 10) return [];
      const labels = new Set<string>();
      options = rawOptions.flatMap((rawOption) => {
        if (!isRecord(rawOption)) return [];
        const label = boundedPresentationString(rawOption.label, 2_000);
        const description = typeof rawOption.description === 'string' && rawOption.description.length <= 8_000 ? rawOption.description : null;
        if (!label || description === null || labels.has(label)) return [];
        labels.add(label);
        return [{ label, description }];
      });
      if (options.length !== rawOptions.length) return [];
    }
    questionIds.add(id);
    return [
      {
        id,
        header,
        question,
        options,
        isOther: options !== null && candidate.isOther === true,
        isSecret: candidate.isSecret === true,
        multiple: options !== null && candidate.multiple === true,
      },
    ];
  });
  if (questions.length !== detail.questions.length) return null;
  const outcome = ['pending', 'answered', 'aborted', 'resolved'].includes(String(detail.outcome)) ? String(detail.outcome) : 'pending';
  const answers = recoveredRequestUserInputAnswers(detail.answers, questionIds);
  return {
    requestType: 'request_user_input',
    recovery: 'content_only',
    submissionAuthority: 'unavailable',
    providerThreadId: boundedPresentationString(detail.providerThreadId, 1_024),
    providerTurnId: boundedPresentationString(detail.providerTurnId, 1_024),
    providerItemId: boundedPresentationString(detail.providerItemId, 1_024),
    callId: boundedPresentationString(detail.callId, 1_024),
    questions,
    outcome,
    ...(answers ? { answers } : {}),
    ...(detail.resolutionReason === 'turn_terminal' ? { resolutionReason: 'turn_terminal' } : {}),
  };
}

function recoveredRequestUserInputAnswers(value: unknown, questionIds: ReadonlySet<string>): Record<string, { answers: string[] }> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value).flatMap(([questionId, rawAnswer]) => {
    if (!questionIds.has(questionId) || !isRecord(rawAnswer) || !Array.isArray(rawAnswer.answers) || rawAnswer.answers.length === 0 || rawAnswer.answers.length > 10) return [];
    const answers = rawAnswer.answers.flatMap((answer) => {
      const text = boundedPresentationString(answer, 8_000);
      return text ? [text] : [];
    });
    return answers.length === rawAnswer.answers.length ? [[questionId, { answers }] as const] : [];
  });
  return entries.length === Object.keys(value).length ? Object.fromEntries(entries) : null;
}

function boundedPresentationString(value: unknown, maximumLength: number): string | null {
  return typeof value === 'string' && value.trim() && value.length <= maximumLength ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toolPairIdFromSourceEvent(sourceEventId: string | null): string | null {
  if (!sourceEventId) return null;
  for (const pattern of [/^codex:item:(.+)$/u, /^pi:block:(.+)$/u, /^pi:(?:tool_execution|tool_call|toolcall):(.+)$/u]) {
    const match = sourceEventId.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function redactSensitivePreview(value: string): { text: string; redacted: boolean } {
  const patterns: Array<[RegExp, string]> = [
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/gu, '[REDACTED_PRIVATE_KEY]'],
    [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}={0,2}/giu, 'Bearer [REDACTED_TOKEN]'],
    [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED_TOKEN]'],
  ];
  let text = value;
  let redacted = false;
  for (const [pattern, replacement] of patterns) {
    text = text.replace(pattern, () => {
      redacted = true;
      return replacement;
    });
  }
  text = text.replace(/(?:"?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"?\s*[:=]\s*"?)[^"'\s,}]{8,}/giu, (match) => {
    redacted = true;
    const separator = Math.max(match.lastIndexOf(':'), match.lastIndexOf('='));
    return `${match.slice(0, separator + 1)}[REDACTED_SECRET]`;
  });
  return { text, redacted };
}

function takeCodePointPrefixByBytes(value: string, byteLimit: number): { text: string; codePoints: number } {
  let bytes = 0;
  let codePoints = 0;
  const output: string[] = [];
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > byteLimit) break;
    output.push(character);
    bytes += characterBytes;
    codePoints += 1;
  }
  return { text: output.join(''), codePoints };
}

function snapshotError(code: ConversationSnapshotV2ErrorCode, message: string, statusCode: 400 | 404 | 409 | 413): ConversationSnapshotV2Error {
  return new ConversationSnapshotV2Error(code, message, statusCode);
}
