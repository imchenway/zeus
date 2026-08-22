import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import type { ConversationAgentKind, ConversationItemPhase, ConversationItemStatus, ConversationItemType, ZeusConversationItemRecord } from './conversationItemTypes.js';

export const conversationProviderItemStoreGeneration = '2026-08-21-provider-item-ingestion-v1';

const schemaMigrationId = '20260821_020_provider_item_ingestion';
const maximumProjectionTextBytes = 64 * 1024;
const maximumProjectionPayloadBytes = 128 * 1024;

type ProviderItemBaseInput = {
  conversationId: string;
  turnId: string;
  providerThreadId: string;
  providerTurnId: string;
  providerItemId: string;
  itemType: ConversationItemType;
  phase: ConversationItemPhase;
  payload: unknown;
  startedAt?: string | null;
  updatedAt: string;
  agentKind?: ConversationAgentKind;
  nativeItemId?: string;
};

interface ProviderItemRow {
  id: string;
  conversation_id: string;
  turn_id: string;
  provider_thread_id: string;
  provider_turn_id: string;
  provider_item_id: string;
  item_type: ConversationItemType;
  status: ConversationItemStatus;
  phase: ConversationItemPhase;
  text_projection: string;
  payload_projection_json: string;
  projection_truncated: number;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  agent_kind: ConversationAgentKind | null;
  native_item_id: string | null;
}

/**
 * Provider item 仅是摄取与幂等状态，不是 UI 读模型。
 * Renderer、项目/任务/归档和远程入口只能读取 Snapshot V2 的时间线、模型历史与过程表。
 */
export function migrateConversationProviderItemStoreSchema(db: ZeusDatabasePort): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_provider_item_states (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      provider_turn_id TEXT NOT NULL,
      provider_item_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed')),
      phase TEXT NOT NULL CHECK (phase IN ('prework', 'final_answer')),
      text_projection TEXT NOT NULL,
      payload_projection_json TEXT NOT NULL,
      projection_truncated INTEGER NOT NULL DEFAULT 0 CHECK (projection_truncated IN (0, 1)),
      started_at TEXT,
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      agent_kind TEXT,
      native_item_id TEXT,
      structure_generation TEXT NOT NULL,
      UNIQUE(provider_thread_id, provider_item_id)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_provider_item_states_conversation ON conversation_provider_item_states(conversation_id, updated_at, id)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_provider_item_states_turn_plan ON conversation_provider_item_states(turn_id, updated_at DESC, id DESC) WHERE item_type = 'plan' AND status = 'completed'`);
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
    schemaMigrationId,
    '建立 Provider item 摄取幂等状态并与 Snapshot V2 读模型解耦',
    `sha256:${createHash('sha256').update('provider-item-ingestion-state-v1').digest('hex')}`,
    new Date().toISOString(),
  ]);
}

/**
 * Provider adapter 的有界摄取仓储。完整工具输出必须在完成事件中写入 ArtifactRef；
 * 这里仅保存流式预览和协议身份，避免重新制造第二套 UI 正文事实。
 */
export class ConversationProviderItemRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  appendDelta(input: ProviderItemBaseInput & { delta: string; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    return this.write({
      ...input,
      status: input.status ?? 'in_progress',
      textContent: `${existing?.textContent ?? ''}${input.delta}`,
      startedAt: existing?.startedAt ?? input.startedAt ?? null,
      completedAt: null,
    });
  }

  upsertProgress(input: ProviderItemBaseInput & { textContent: string; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed') return existing;
    return this.write({
      ...input,
      status: input.status ?? 'in_progress',
      textContent: input.textContent,
      startedAt: existing?.startedAt ?? input.startedAt ?? null,
      completedAt: null,
    });
  }

  upsertCompleted(input: ProviderItemBaseInput & { textContent: string; completedAt: string | null; status?: ConversationItemStatus }): ZeusConversationItemRecord {
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (existing?.status === 'completed' && existing.itemType === input.itemType) return existing;
    return this.write({ ...input, status: input.status ?? 'completed', textContent: input.textContent, startedAt: existing?.startedAt ?? input.startedAt ?? null });
  }

  replaceCompletedPiAgentMessage(input: { providerThreadId: string; providerItemId: string; textContent: string; updatedAt: string }): ZeusConversationItemRecord | undefined {
    const existing = this.getByProvider(input.providerThreadId, input.providerItemId);
    if (!existing || existing.itemType !== 'agentMessage' || existing.status !== 'completed' || existing.agentKind !== 'pi') return existing;
    return this.write({
      conversationId: existing.conversationId,
      turnId: existing.turnId,
      providerThreadId: existing.providerThreadId,
      providerTurnId: existing.providerTurnId,
      providerItemId: existing.providerItemId,
      itemType: existing.itemType,
      phase: 'final_answer',
      payload: parseProjectionJson(existing.payloadJson),
      textContent: input.textContent,
      status: existing.status,
      startedAt: existing.startedAt,
      completedAt: existing.completedAt,
      updatedAt: input.updatedAt,
      agentKind: existing.agentKind ?? undefined,
      nativeItemId: existing.nativeItemId ?? undefined,
    });
  }

  getByProvider(providerThreadId: string, providerItemId: string): ZeusConversationItemRecord | undefined {
    const row = this.db.get<ProviderItemRow>(`SELECT * FROM conversation_provider_item_states WHERE provider_thread_id = ? AND provider_item_id = ?`, [providerThreadId, providerItemId]);
    return row ? mapRow(row) : undefined;
  }

  getById(id: string): ZeusConversationItemRecord | undefined {
    const row = this.db.get<ProviderItemRow>(`SELECT * FROM conversation_provider_item_states WHERE id = ?`, [id]);
    return row ? mapRow(row) : undefined;
  }

  listByConversation(conversationId: string): ZeusConversationItemRecord[] {
    return this.db.select<ProviderItemRow>(`SELECT * FROM conversation_provider_item_states WHERE conversation_id = ? ORDER BY updated_at, id`, [conversationId]).map(mapRow);
  }

  getLatestCompletedPlanByTurn(turnId: string): ZeusConversationItemRecord | undefined {
    const row = this.db.get<ProviderItemRow>(
      `SELECT *
         FROM conversation_provider_item_states
        WHERE turn_id = ? AND item_type = 'plan' AND status = 'completed' AND trim(text_projection) <> ''
        ORDER BY updated_at DESC, id DESC
        LIMIT 1`,
      [turnId],
    );
    return row ? mapRow(row) : undefined;
  }

  listLatestCompletedPlansByTurns(turnIds: readonly string[]): ZeusConversationItemRecord[] {
    const uniqueTurnIds = [...new Set(turnIds)];
    if (uniqueTurnIds.length === 0) return [];
    const rows = this.db
      .select<ProviderItemRow>(
        `SELECT *
           FROM conversation_provider_item_states
          WHERE turn_id IN (${uniqueTurnIds.map(() => '?').join(', ')})
            AND item_type = 'plan' AND status = 'completed' AND trim(text_projection) <> ''
          ORDER BY turn_id, updated_at DESC, id DESC`,
        uniqueTurnIds,
      )
      .map(mapRow);
    const latest = new Map<string, ZeusConversationItemRecord>();
    for (const row of rows) if (!latest.has(row.turnId)) latest.set(row.turnId, row);
    return [...latest.values()];
  }

  private write(
    input: ProviderItemBaseInput & {
      textContent: string;
      status: ConversationItemStatus;
      startedAt: string | null;
      completedAt: string | null;
    },
  ): ZeusConversationItemRecord {
    assertItemInput(input);
    const text = boundedUtf8(input.textContent, maximumProjectionTextBytes);
    const payload = boundedJsonProjection(input.payload, maximumProjectionPayloadBytes);
    const truncated = text.truncated || payload.truncated;
    const id = providerItemStateId(input.providerThreadId, input.providerItemId);
    this.db.execute(
      `INSERT INTO conversation_provider_item_states
       (id, conversation_id, turn_id, provider_thread_id, provider_turn_id, provider_item_id,
        item_type, status, phase, text_projection, payload_projection_json, projection_truncated,
        started_at, completed_at, updated_at, agent_kind, native_item_id, structure_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_thread_id, provider_item_id) DO UPDATE SET
         conversation_id = excluded.conversation_id,
         turn_id = excluded.turn_id,
         provider_turn_id = excluded.provider_turn_id,
         item_type = excluded.item_type,
         status = excluded.status,
         phase = excluded.phase,
         text_projection = excluded.text_projection,
         payload_projection_json = excluded.payload_projection_json,
         projection_truncated = excluded.projection_truncated,
         started_at = COALESCE(conversation_provider_item_states.started_at, excluded.started_at),
         completed_at = excluded.completed_at,
         updated_at = excluded.updated_at,
         agent_kind = excluded.agent_kind,
         native_item_id = excluded.native_item_id,
         structure_generation = excluded.structure_generation`,
      [
        id,
        input.conversationId,
        input.turnId,
        input.providerThreadId,
        input.providerTurnId,
        input.providerItemId,
        input.itemType,
        input.status,
        input.phase,
        text.value,
        payload.value,
        truncated ? 1 : 0,
        input.startedAt,
        input.completedAt,
        input.updatedAt,
        input.agentKind ?? 'codex',
        input.nativeItemId ?? input.providerItemId,
        conversationProviderItemStoreGeneration,
      ],
    );
    return this.getByProvider(input.providerThreadId, input.providerItemId)!;
  }
}

function assertItemInput(input: ProviderItemBaseInput & { status: ConversationItemStatus }): void {
  for (const [name, value] of [
    ['conversationId', input.conversationId],
    ['turnId', input.turnId],
    ['providerThreadId', input.providerThreadId],
    ['providerTurnId', input.providerTurnId],
    ['providerItemId', input.providerItemId],
  ] as const) {
    if (!value.trim() || Buffer.byteLength(value) > 2_048) throw new Error(`${name} 格式无效。`);
  }
  if (!['in_progress', 'completed', 'failed'].includes(input.status)) throw new Error('Provider item 状态无效。');
  if (!['prework', 'final_answer'].includes(input.phase)) throw new Error('Provider item 阶段无效。');
  if (!Number.isFinite(Date.parse(input.updatedAt))) throw new Error('Provider item 更新时间无效。');
}

function providerItemStateId(providerThreadId: string, providerItemId: string): string {
  return `conversation_provider_item_${createHash('sha256').update(`${providerThreadId}\0${providerItemId}`).digest('hex').slice(0, 32)}`;
}

function boundedUtf8(value: string, maximumBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maximumBytes) return { value, truncated: false };
  const marker = '\n…[Provider 流式预览已截断；完整内容见统一模型历史或 ArtifactRef]…\n';
  const markerBytes = Buffer.byteLength(marker);
  const side = Math.max(0, Math.floor((maximumBytes - markerBytes) / 2));
  return {
    value: `${bytes.subarray(0, side).toString('utf8')}${marker}${bytes.subarray(bytes.byteLength - side).toString('utf8')}`,
    truncated: true,
  };
}

function boundedJsonProjection(value: unknown, maximumBytes: number): { value: string; truncated: boolean } {
  const serialized = safeJsonStringify(value);
  if (Buffer.byteLength(serialized) <= maximumBytes) return { value: serialized, truncated: false };
  const preview = boundedUtf8(serialized, Math.max(1_024, maximumBytes - 512));
  return {
    value: JSON.stringify({
      projectionTruncated: true,
      originalByteLength: Buffer.byteLength(serialized),
      preview: preview.value,
      recovery: '完整内容必须从统一模型历史或 ArtifactRef 读取',
    }),
    truncated: true,
  };
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return JSON.stringify({ serializationError: true });
  }
}

function parseProjectionJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return { raw: value };
  }
}

function mapRow(row: ProviderItemRow): ZeusConversationItemRecord {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    turnId: row.turn_id,
    providerThreadId: row.provider_thread_id,
    providerTurnId: row.provider_turn_id,
    providerItemId: row.provider_item_id,
    itemType: row.item_type,
    status: row.status,
    phase: row.phase,
    textContent: row.text_projection,
    payloadJson: row.payload_projection_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    agentKind: row.agent_kind,
    nativeItemId: row.native_item_id,
  };
}
