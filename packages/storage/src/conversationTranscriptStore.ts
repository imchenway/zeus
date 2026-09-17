import { createHash } from 'node:crypto';
import type { ConversationTranscriptEnvelope, ConversationTranscriptPlacement, ConversationTranscriptPlacementBatch, ConversationTranscriptSourceStamp } from '@zeus/shared';
import { conversationProcessProviderItemId } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

/** 会话位置索引当前结构迁移身份。 */
const conversationTranscriptMigrationId = '20260916_001_conversation_transcript_placement';
/** 相邻显示位置的正常预留间隔。 */
const conversationTranscriptOrderGap = 1_024;
/** 位置核对单批最大身份数。 */
export const conversationTranscriptPlacementBatchLimit = 256;
/** 位置核对响应最大估算字节数。 */
export const conversationTranscriptPlacementByteLimit = 128 * 1_024;
/** 旧数据初始化每次扫描和提交的来源数。 */
const conversationTranscriptInitializationBatchLimit = 512;
/** 旧数据初始化按固定来源顺序保存独立扫描游标。 */
const conversationTranscriptInitializationDomains = ['model_history', 'provider_item', 'process', 'expert_execution', 'request', 'resource'] as const;

/** 旧数据初始化支持的来源种类。 */
type ConversationTranscriptInitializationDomain = (typeof conversationTranscriptInitializationDomains)[number];

/** 旧数据初始化的持久断点。 */
type ConversationTranscriptInitializationCursor = { phase: 'collecting'; domainIndex: number; offset: number } | { phase: 'ordering'; offset: number };

/** 显示位置索引允许的职责种类。 */
export type ConversationTranscriptEntryKind = 'ordinary_input' | 'content' | 'tool_activity' | 'question' | 'notice' | 'resource' | 'hidden_input_anchor' | 'hidden_stage_anchor';

/** 注册一个真实来源所需的稳定身份与归属信息。 */
export interface RegisterConversationTranscriptSourceInput {
  /** 产品会话身份。 */
  conversationId: string;
  /** 来源种类。 */
  sourceDomain: string;
  /** 来源作用域。 */
  sourceScope: string;
  /** 来源原始身份。 */
  sourceId: string;
  /** 来源内容部分。 */
  facet: string;
  /** 可跨来源复用的确定性显示身份。 */
  preferredEntryId: string;
  /** 显示职责。 */
  kind: ConversationTranscriptEntryKind;
  /** 本地轮次身份。 */
  turnId: string | null;
  /** 运行分段身份。 */
  segmentId: string | null;
  /** 明确所属普通输入；缺失时只从已持久位置查找。 */
  openingInputId?: string | null;
  /** 明确的 Provider 展示阶段。 */
  displayStageId?: string | null;
  /** 该来源是否开启新的持久展示阶段。 */
  startsStage?: boolean;
  /** 来源首次出现时间，仅供诊断和旧数据重建。 */
  firstSeenAt: string;
  /** 位置证据种类。 */
  orderingEvidence: 'live' | 'provider' | 'reconstructed';
  /** 内容等价判断指纹；重复摄取不递增修订。 */
  contentHash: string;
  /** 活动内容转存确认历史时继承的内容修订。 */
  inheritedContentRevision?: number | null;
}

/** 会话位置索引状态行。 */
interface TranscriptStateRow {
  conversation_id: string;
  next_revision: number;
  order_epoch: number;
  initialization_state: 'building' | 'ready';
  initialization_cursor_json: string | null;
  reconstructed_count: number;
}

/** 会话显示条目数据库行。 */
interface TranscriptEntryRow {
  conversation_id: string;
  id: string;
  turn_id: string | null;
  segment_id: string | null;
  kind: ConversationTranscriptEntryKind;
  display_order: number | null;
  opening_input_id: string | null;
  display_stage_id: string | null;
  created_revision: number;
  placement_revision: number;
  first_seen_at: string;
  ordering_evidence: string;
  removed_revision: number | null;
  summary_entry_id: string | null;
  current_stage_id: string | null;
}

/** 会话来源别名数据库行。 */
interface TranscriptAliasRow {
  conversation_id: string;
  source_domain: string;
  source_scope: string;
  source_id: string;
  facet: string;
  entry_id: string;
  source_revision: number;
  content_revision: number;
  content_hash: string;
}

/** 旧数据重建时的最小来源事实。 */
interface ReconstructionFact extends RegisterConversationTranscriptSourceInput {
  /** 同一种来源内部的原始顺序。 */
  sourceOrder: number;
  /** 不同来源同刻时使用的固定、可审计优先级。 */
  sourcePriority: number;
}

/** 建立只保存身份、位置与归属的会话显示索引。 */
export function migrateConversationTranscriptStoreSchema(db: ZeusDatabasePort): void {
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_transcript_state (
      conversation_id TEXT PRIMARY KEY,
      next_revision INTEGER NOT NULL DEFAULT 0,
      order_epoch INTEGER NOT NULL DEFAULT 1,
      initialization_state TEXT NOT NULL CHECK (initialization_state IN ('building', 'ready')),
      initialization_cursor_json TEXT,
      reconstructed_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_transcript_entries (
      conversation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      turn_id TEXT,
      segment_id TEXT,
      kind TEXT NOT NULL,
      display_order INTEGER,
      opening_input_id TEXT,
      display_stage_id TEXT,
      created_revision INTEGER NOT NULL,
      placement_revision INTEGER NOT NULL,
      first_seen_at TEXT NOT NULL,
      ordering_evidence TEXT NOT NULL,
      removed_revision INTEGER,
      summary_entry_id TEXT,
      current_stage_id TEXT,
      PRIMARY KEY (conversation_id, id)
    )
  `);
  db.execute(`CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_transcript_order ON conversation_transcript_entries(conversation_id, display_order) WHERE display_order IS NOT NULL`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_transcript_turn_order ON conversation_transcript_entries(conversation_id, turn_id, display_order)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_transcript_input_order ON conversation_transcript_entries(conversation_id, opening_input_id, display_order)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_transcript_stage_order ON conversation_transcript_entries(conversation_id, display_stage_id, display_order)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_transcript_aliases (
      conversation_id TEXT NOT NULL,
      source_domain TEXT NOT NULL,
      source_scope TEXT NOT NULL,
      source_id TEXT NOT NULL,
      facet TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      source_revision INTEGER NOT NULL,
      content_revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      PRIMARY KEY (conversation_id, source_domain, source_scope, source_id, facet)
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_transcript_alias_entry ON conversation_transcript_aliases(conversation_id, entry_id, source_revision, source_domain, source_id, facet)`);
  db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_transcript_initialization_facts (
      conversation_id TEXT NOT NULL,
      source_domain TEXT NOT NULL,
      source_scope TEXT NOT NULL,
      source_id TEXT NOT NULL,
      facet TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      source_priority INTEGER NOT NULL,
      source_order INTEGER NOT NULL,
      preferred_entry_id TEXT NOT NULL,
      fact_json TEXT NOT NULL,
      PRIMARY KEY (conversation_id, source_domain, source_scope, source_id, facet)
    )
  `);
  db.execute(
    `CREATE INDEX IF NOT EXISTS idx_conversation_transcript_initialization_order
       ON conversation_transcript_initialization_facts(conversation_id, first_seen_at, source_priority, source_order, preferred_entry_id, source_domain, source_id, facet)`,
  );
  db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
    conversationTranscriptMigrationId,
    '建立会话显示身份、位置、输入与阶段归属索引',
    `sha256:${createHash('sha256').update('conversation-transcript-placement-identity-source-revision').digest('hex')}`,
    new Date().toISOString(),
  ]);
}

/** 为升级前会话分批建立确定位置；只读取身份、关系、顺序与短结构字段。 */
export async function initializeConversationTranscriptIndexes(db: ZeusDatabasePort, background = false): Promise<void> {
  const repository = new ConversationTranscriptRepository(db);
  const repairId = '20260916_transcript_pi_source_identity';
  if (!db.get(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [repairId])) {
    while (true) {
      const aliases = db.select<{ conversation_id: string; previous_id: string; canonical_id: string }>(
        `SELECT history_alias.conversation_id, history_alias.entry_id AS previous_id, provider_alias.entry_id AS canonical_id
       FROM conversation_transcript_aliases AS history_alias
       JOIN conversation_model_history AS history ON history.id = history_alias.source_id AND history_alias.source_domain = 'model_history'
       JOIN conversation_runtime_segments AS segment ON segment.id = history.segment_id AND segment.runtime_kind = 'pi'
       JOIN conversation_transcript_aliases AS provider_alias ON provider_alias.conversation_id = history_alias.conversation_id
        AND provider_alias.source_domain = 'provider_item' AND provider_alias.source_scope = segment.native_session_id AND provider_alias.facet = history_alias.facet
        AND provider_alias.source_id = CASE WHEN json_valid(history.content_json) THEN COALESCE(json_extract(history.content_json, '$.providerItemId'), json_extract(history.content_json, '$.stageId')) END
       JOIN conversation_transcript_entries AS old_entry ON old_entry.conversation_id = history_alias.conversation_id AND old_entry.id = history_alias.entry_id
       JOIN conversation_transcript_entries AS canonical_entry ON canonical_entry.conversation_id = provider_alias.conversation_id AND canonical_entry.id = provider_alias.entry_id AND canonical_entry.turn_id IS old_entry.turn_id
       WHERE history_alias.entry_id <> provider_alias.entry_id LIMIT 512`,
      );
      if (!aliases.length) break;
      db.transaction(() => {
        for (const alias of aliases) repository.mergeSourceIdentity(alias.conversation_id, alias.previous_id, alias.canonical_id);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [repairId, '修正 Pi 历史与活动来源的明确身份关联', 'pi-stage-identity', new Date().toISOString()]);
  }

  /** 已确认的客户端消息是用户输入的统一身份，修复先登记 Provider 来源造成的重复归属。 */
  const inputRepairId = '20260917_transcript_confirmed_input_identity';
  if (!db.get(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [inputRepairId])) {
    while (true) {
      /** 只合并同一会话、同一轮次且已有明确消息别名的输入，不按正文或时间猜测。 */
      const inputs = db.select<{ conversation_id: string; previous_id: string; canonical_id: string }>(
        `SELECT source.conversation_id, source.entry_id AS previous_id, canonical.id AS canonical_id
           FROM conversation_transcript_aliases AS source
           JOIN conversation_message_provider_aliases AS alias ON alias.conversation_id = source.conversation_id AND alias.provider_item_id = source.source_id
           JOIN conversation_messages AS message ON message.id = alias.message_id AND message.role = 'user' AND message.provider_thread_id = source.source_scope
           JOIN conversation_transcript_entries AS previous ON previous.conversation_id = source.conversation_id AND previous.id = source.entry_id AND previous.kind = 'ordinary_input'
           JOIN conversation_transcript_entries AS canonical ON canonical.conversation_id = source.conversation_id AND canonical.id = 'user-message:' || message.client_message_id
            AND canonical.kind = 'ordinary_input' AND canonical.turn_id IS previous.turn_id AND canonical.removed_revision IS NULL
          WHERE source.source_domain = 'provider_item' AND source.entry_id <> canonical.id LIMIT 512`,
      );
      if (!inputs.length) break;
      db.transaction(() => {
        for (const input of inputs) repository.mergeSourceIdentity(input.conversation_id, input.previous_id, input.canonical_id);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    db.execute(`INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [inputRepairId, '统一已确认用户输入及其过程归属', 'confirmed-input-identity', new Date().toISOString()]);
  }

  const conversations = db.select<{ id: string }>(
    `SELECT conversation.id
       FROM conversations AS conversation
       LEFT JOIN conversation_transcript_state AS state ON state.conversation_id = conversation.id
      WHERE state.conversation_id IS NULL OR state.initialization_state <> 'ready'
      ORDER BY conversation.updated_at DESC, conversation.id`,
  );
  if (background && conversations.length) {
    db.execute(`INSERT OR IGNORE INTO conversation_transcript_state (conversation_id, initialization_state)
      SELECT id, 'building' FROM conversations`);
    const work: TranscriptInitializationWork = { queue: conversations.map((conversation) => conversation.id), timer: null, errors: new Map(), barriers: new Map() };
    transcriptInitializationWork.set(db, work);
    /** 每次只推进一个持久批次；前台读取可将目标会话提到队首。 */
    const advance = (): void => {
      if (transcriptInitializationWork.get(db) !== work) return;
      const conversationId = work.queue[0];
      if (!conversationId) {
        work.timer = null;
        return;
      }
      try {
        if (repository.initializeConversation(conversationId, 1)) {
          work.queue.shift();
          work.barriers.get(conversationId)?.resolve();
          work.barriers.delete(conversationId);
        }
      } catch (error) {
        work.errors.set(conversationId, error);
        work.queue.shift();
        work.barriers.get(conversationId)?.reject(error);
        work.barriers.delete(conversationId);
      }
      work.timer = work.queue.length ? setImmediate(advance) : null;
    };
    work.timer = setImmediate(advance);
    return;
  }
  for (const conversation of conversations) {
    while (!repository.initializeConversation(conversation.id, 1)) await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** 同库旧资料初始化的可取消队列，失败留给对应会话读取明确报告。 */
interface TranscriptInitializationWork {
  queue: string[];
  timer: ReturnType<typeof setImmediate> | null;
  errors: Map<string, unknown>;
  /** 每个会话共用一个等待屏障，不复制到达事件。 */
  barriers: Map<string, { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }>;
}
/** 数据库生命周期拥有初始化队列，不在关闭后保留后台写入。 */
const transcriptInitializationWork = new WeakMap<ZeusDatabasePort, TranscriptInitializationWork>();

/** 关闭或交接数据库时取消后台推进，断点已随每批写入保存。 */
export function stopConversationTranscriptInitialization(db: ZeusDatabasePort): void {
  const work = transcriptInitializationWork.get(db);
  if (work?.timer) clearImmediate(work.timer);
  for (const barrier of work?.barriers.values() ?? []) barrier.reject(transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZATION_STOPPED', '数据库已停止初始化。'));
  transcriptInitializationWork.delete(db);
}

/** 请求中的会话优先完成；失败不得伪装为永远重试的初始化状态。 */
function prioritizeTranscriptInitialization(db: ZeusDatabasePort, conversationId: string): void {
  const work = transcriptInitializationWork.get(db);
  if (!work) return;
  if (work.errors.has(conversationId)) throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZATION_FAILED', '会话显示位置初始化失败，请检查数据库后重新启动。');
  const index = work.queue.indexOf(conversationId);
  if (index > 0) {
    work.queue.splice(index, 1);
    work.queue.unshift(conversationId);
  }
}

/** 同一数据库的各仓库实例共享事务内位置通知，广播由宿主在提交后执行。 */
const placementChangeWriters = new WeakMap<ZeusDatabasePort, (conversationId: string, orderEpoch: number, revision: number) => void>();

/** 管理会话显示身份、位置与来源修订，不保存正文副本。 */
export class ConversationTranscriptRepository {
  /** 绑定共享 SQLite 事务端口。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** Provider 串行摄取等待完整索引，期间事件保留在原有队列中。 */
  async waitUntilReady(conversationId: string): Promise<void> {
    if (this.state(conversationId)?.initialization_state !== 'building') return;
    prioritizeTranscriptInitialization(this.db, conversationId);
    const work = transcriptInitializationWork.get(this.db);
    if (!work) {
      this.requireReadyState(conversationId);
      return;
    }
    let barrier = work.barriers.get(conversationId);
    if (!barrier) {
      /** Promise 构造器同步安装完成与失败回调，沿用项目现有编译目标。 */
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((onReady, onFailure) => {
        resolve = onReady;
        reject = onFailure;
      });
      barrier = { promise, resolve, reject };
      work.barriers.set(conversationId, barrier);
    }
    await barrier.promise;
  }

  /** 宿主注册耐久位置事件写入器；调用发生在位置变更的同一事务内。 */
  onPlacementChanged(writer: (conversationId: string, orderEpoch: number, revision: number) => void): void {
    placementChangeWriters.set(this.db, writer);
  }

  /** 只合并有明确原生身份关联的旧别名，保留最早位置并删除重复显示条目。 */
  mergeSourceIdentity(conversationId: string, previousId: string, canonicalId: string): void {
    if (previousId === canonicalId) return;
    this.db.transaction(() => {
      const previous = this.db.get<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [conversationId, previousId]);
      const canonical = this.db.get<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [conversationId, canonicalId]);
      if (!previous || !canonical || previous.turn_id !== canonical.turn_id) return;
      const revision = this.nextRevision(conversationId);
      const order = previous.display_order !== null && canonical.display_order !== null ? Math.min(previous.display_order, canonical.display_order) : canonical.display_order;
      this.db.execute(`UPDATE conversation_transcript_entries SET display_order = NULL, removed_revision = ?, placement_revision = ? WHERE conversation_id = ? AND id = ?`, [revision, revision, conversationId, previousId]);
      this.db.execute(`UPDATE conversation_transcript_entries SET display_order = ?, placement_revision = ? WHERE conversation_id = ? AND id = ?`, [order, revision, conversationId, canonicalId]);
      this.db.execute(`UPDATE conversation_transcript_aliases SET entry_id = ? WHERE conversation_id = ? AND entry_id = ?`, [canonicalId, conversationId, previousId]);
      this.db.execute(`UPDATE conversation_transcript_entries SET summary_entry_id = ? WHERE conversation_id = ? AND summary_entry_id = ?`, [canonicalId, conversationId, previousId]);
      // 输入合并时连同阶段和过程一起归位，避免删除重复入口后留下另一组过程。
      if (previous.kind === 'ordinary_input' && canonical.kind === 'ordinary_input') {
        this.db.execute(`UPDATE conversation_transcript_entries SET opening_input_id = ?, placement_revision = ? WHERE conversation_id = ? AND opening_input_id = ?`, [canonicalId, revision, conversationId, previousId]);
        this.db.execute(`UPDATE conversation_transcript_entries SET current_stage_id = COALESCE(current_stage_id, ?) WHERE conversation_id = ? AND id = ?`, [previous.current_stage_id, conversationId, canonicalId]);
      }
      this.db.execute(`UPDATE conversation_transcript_state SET order_epoch = order_epoch + 1 WHERE conversation_id = ?`, [conversationId]);
      placementChangeWriters.get(this.db)?.(conversationId, this.orderEpoch(conversationId), revision);
    });
  }

  /** 捕获读取开始时的来源水位，供异步 Provider 返回时核对。 */
  revision(conversationId: string): number {
    return this.state(conversationId)?.next_revision ?? 0;
  }

  /** 为一个旧会话按持久断点建立完整索引；ready 会话永不重复重建。 */
  initializeConversation(conversationId: string, maximumBatches = Number.POSITIVE_INFINITY): boolean {
    const state = this.state(conversationId);
    if (state?.initialization_state === 'ready') return true;
    let cursor = state ? parseInitializationCursor(state.initialization_cursor_json) : null;
    if (!state || !cursor) {
      cursor = { phase: 'collecting', domainIndex: 0, offset: 0 };
      this.db.transaction(() => {
        this.db.execute(`DELETE FROM conversation_transcript_initialization_facts WHERE conversation_id = ?`, [conversationId]);
        this.db.execute(`DELETE FROM conversation_transcript_aliases WHERE conversation_id = ?`, [conversationId]);
        this.db.execute(`DELETE FROM conversation_transcript_entries WHERE conversation_id = ?`, [conversationId]);
        this.db.execute(
          `INSERT INTO conversation_transcript_state
           (conversation_id, next_revision, order_epoch, initialization_state, initialization_cursor_json, reconstructed_count)
           VALUES (?, 0, 1, 'building', ?, 0)
           ON CONFLICT(conversation_id) DO UPDATE SET
             next_revision = 0, order_epoch = order_epoch + 1, initialization_state = 'building',
             initialization_cursor_json = excluded.initialization_cursor_json, reconstructed_count = 0`,
          [conversationId, JSON.stringify(cursor)],
        );
      });
    }
    while (cursor.phase === 'collecting') {
      const domain = conversationTranscriptInitializationDomains[cursor.domainIndex];
      if (!domain) {
        cursor = { phase: 'ordering', offset: 0 };
        this.db.execute(`UPDATE conversation_transcript_state SET initialization_cursor_json = ? WHERE conversation_id = ?`, [JSON.stringify(cursor), conversationId]);
        break;
      }
      const facts = this.reconstructionFactsForDomain(conversationId, domain, cursor.offset, conversationTranscriptInitializationBatchLimit);
      const nextCursor: ConversationTranscriptInitializationCursor =
        facts.length < conversationTranscriptInitializationBatchLimit
          ? { phase: 'collecting', domainIndex: cursor.domainIndex + 1, offset: 0 }
          : { phase: 'collecting', domainIndex: cursor.domainIndex, offset: cursor.offset + facts.length };
      this.db.transaction(() => {
        for (const fact of facts) this.stageReconstructionFact(fact);
        this.db.execute(`UPDATE conversation_transcript_state SET initialization_cursor_json = ? WHERE conversation_id = ?`, [JSON.stringify(nextCursor), conversationId]);
      });
      cursor = nextCursor;
      if (--maximumBatches <= 0) return false;
    }
    while (cursor.phase === 'ordering') {
      const facts = this.stagedReconstructionFacts(conversationId, cursor.offset, conversationTranscriptInitializationBatchLimit);
      if (facts.length === 0) {
        this.db.transaction(() => {
          this.db.execute(`DELETE FROM conversation_transcript_initialization_facts WHERE conversation_id = ?`, [conversationId]);
          this.db.execute(
            `UPDATE conversation_transcript_state
                SET initialization_state = 'ready', initialization_cursor_json = NULL
              WHERE conversation_id = ?`,
            [conversationId],
          );
        });
        return true;
      }
      const nextCursor: ConversationTranscriptInitializationCursor = { phase: 'ordering', offset: cursor.offset + facts.length };
      this.db.transaction(() => {
        for (const fact of facts) this.registerSourceInternal(fact, true);
        this.db.execute(
          `UPDATE conversation_transcript_state
              SET initialization_cursor_json = ?, reconstructed_count = reconstructed_count + ?
            WHERE conversation_id = ?`,
          [JSON.stringify(nextCursor), facts.length, conversationId],
        );
      });
      cursor = nextCursor;
      if (--maximumBatches <= 0) return false;
    }
    return true;
  }

  /** 注册或更新一个来源；重复内容不递增修订，内容更新不移动条目。 */
  registerSource(input: RegisterConversationTranscriptSourceInput): ConversationTranscriptEnvelope {
    return this.db.transaction(() => {
      this.registerSourceInternal(input, false);
      return this.envelopeForSource(input)!;
    });
  }

  /** 消息开始即持久化阶段锚点，正文尚未产生时工具也可继承归属。 */
  startStage(input: { conversationId: string; turnId: string; segmentId: string; stageId: string; occurredAt: string }): void {
    this.db.transaction(() => {
      const registration: RegisterConversationTranscriptSourceInput = {
        ...input,
        sourceDomain: 'stage',
        sourceScope: input.segmentId,
        sourceId: input.stageId,
        facet: 'stage',
        preferredEntryId: input.stageId,
        kind: 'hidden_stage_anchor',
        displayStageId: input.stageId,
        startsStage: true,
        firstSeenAt: input.occurredAt,
        orderingEvidence: 'provider',
        contentHash: input.stageId,
      };
      this.db.execute(`INSERT OR IGNORE INTO conversation_transcript_state (conversation_id, initialization_state) VALUES (?, 'ready')`, [input.conversationId]);
      this.requireReadyState(input.conversationId);
      const revision = this.nextRevision(input.conversationId);
      const openingInputId = this.latestOpeningInputId(input.conversationId, input.turnId) ?? this.ensureHiddenInputAnchor(registration, revision);
      this.ensureNamedStageAnchor(registration, openingInputId, input.stageId, revision);
    });
  }

  /** 标记明确业务删除的来源；分页缺项和缓存淘汰不得调用。 */
  removeSource(input: Pick<RegisterConversationTranscriptSourceInput, 'conversationId' | 'sourceDomain' | 'sourceScope' | 'sourceId' | 'facet'>): void {
    this.db.transaction(() => {
      const alias = this.alias(input);
      if (!alias) return;
      const revision = this.nextRevision(input.conversationId);
      this.db.execute(
        `UPDATE conversation_transcript_entries
          SET removed_revision = ?, placement_revision = ?
        WHERE conversation_id = ? AND id = ? AND removed_revision IS NULL`,
        [revision, revision, input.conversationId, alias.entry_id],
      );
      placementChangeWriters.get(this.db)?.(input.conversationId, this.orderEpoch(input.conversationId), revision);
    });
  }

  /** 按来源读取当前稳定位置与所有已知来源修订。 */
  envelopeForSource(input: Pick<RegisterConversationTranscriptSourceInput, 'conversationId' | 'sourceDomain' | 'sourceScope' | 'sourceId' | 'facet'>): ConversationTranscriptEnvelope | null {
    this.requireReadyState(input.conversationId);
    const alias = this.db.get<TranscriptAliasRow>(
      `SELECT * FROM conversation_transcript_aliases
        WHERE conversation_id = ? AND source_domain = ? AND source_scope = ? AND source_id = ? AND facet = ?`,
      [input.conversationId, input.sourceDomain, input.sourceScope, input.sourceId, input.facet],
    );
    if (!alias) return null;
    const envelope = this.envelopeForEntry(input.conversationId, alias.entry_id);
    return envelope ? { placement: envelope.placement, sources: [mapSourceStamp(alias)] } : null;
  }

  /** 按显示身份读取位置和全部来源修订。 */
  envelopeForEntry(conversationId: string, entryId: string): ConversationTranscriptEnvelope | null {
    return this.envelopeForEntryInternal(conversationId, entryId, false);
  }

  /** 构建期间只允许初始化事务内部读取刚写入的条目。 */
  private envelopeForEntryInternal(conversationId: string, entryId: string, allowBuilding: boolean): ConversationTranscriptEnvelope | null {
    const state = allowBuilding ? (this.state(conversationId) ?? this.requireReadyState(conversationId)) : this.requireReadyState(conversationId);
    const entry = this.db.get<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [conversationId, entryId]);
    if (!entry) return null;
    const sources = this.db
      .select<TranscriptAliasRow>(`SELECT * FROM conversation_transcript_aliases WHERE conversation_id = ? AND entry_id = ? ORDER BY source_revision, source_domain, source_id, facet`, [conversationId, entryId])
      .map(mapSourceStamp);
    return { placement: mapPlacement(entry, state.order_epoch), sources };
  }

  /** 读取一批已加载身份的位置；未知身份不会被解释为删除。 */
  readPlacementBatch(conversationId: string, entryIds: readonly string[]): ConversationTranscriptPlacementBatch {
    const state = this.requireReadyState(conversationId);
    const uniqueIds = [...new Set(entryIds.filter((entryId) => entryId.trim()))];
    if (uniqueIds.length > conversationTranscriptPlacementBatchLimit) throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_BATCH_TOO_LARGE', '单批最多核对 256 个显示身份。');
    if (uniqueIds.length === 0) return { conversationId, orderEpoch: state.order_epoch, revision: state.next_revision, placements: [], uncoveredEntryIds: [], removedEntryIds: [] };
    const rows = this.db.select<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id IN (${uniqueIds.map(() => '?').join(', ')})`, [conversationId, ...uniqueIds]);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const placements: ConversationTranscriptPlacement[] = [];
    const uncoveredEntryIds: string[] = [];
    const removedEntryIds: string[] = [];
    /** 将身份本身与辅助锚点也纳入预算，不能只计算可见位置。 */
    const batch = { conversationId, orderEpoch: state.order_epoch, revision: state.next_revision, placements, uncoveredEntryIds, removedEntryIds };
    uncoveredEntryIds.push(...uniqueIds);
    if (Buffer.byteLength(JSON.stringify(batch)) > conversationTranscriptPlacementByteLimit) throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_BATCH_TOO_LARGE', '位置身份超过响应字节预算。');
    for (const entryId of uniqueIds) {
      const row = byId.get(entryId);
      if (!row) continue;
      const pendingIndex = uncoveredEntryIds.indexOf(entryId);
      uncoveredEntryIds.splice(pendingIndex, 1);
      const previousLength = placements.length;
      if (row.removed_revision !== null) removedEntryIds.push(entryId);
      else {
        if (!placements.some((placement) => placement.entryId === entryId)) placements.push(mapPlacement(row, state.order_epoch));
        for (const anchorId of [row.opening_input_id, row.display_stage_id]) {
          if (!anchorId || placements.some((placement) => placement.entryId === anchorId)) continue;
          const anchor = this.db.get<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ? AND removed_revision IS NULL`, [conversationId, anchorId]);
          if (anchor) placements.push(mapPlacement(anchor, state.order_epoch));
        }
      }
      if (Buffer.byteLength(JSON.stringify(batch)) > conversationTranscriptPlacementByteLimit) {
        placements.splice(previousLength);
        if (row.removed_revision !== null) removedEntryIds.pop();
        uncoveredEntryIds.splice(pendingIndex, 0, entryId);
      }
    }
    return batch;
  }

  /** 返回会话当前位置代次；空会话没有索引行时使用初始代次。 */
  orderEpoch(conversationId: string): number {
    return this.requireReadyState(conversationId).order_epoch;
  }

  /** 执行注册并允许旧数据构建期间写入。 */
  private registerSourceInternal(input: RegisterConversationTranscriptSourceInput, allowBuilding: boolean): ConversationTranscriptEnvelope {
    validateRegistration(input);
    let state = this.state(input.conversationId);
    if (!state) {
      this.db.execute(
        `INSERT INTO conversation_transcript_state
         (conversation_id, next_revision, order_epoch, initialization_state, initialization_cursor_json, reconstructed_count)
         VALUES (?, 0, 1, 'ready', NULL, 0)`,
        [input.conversationId],
      );
      state = this.state(input.conversationId)!;
    }
    if (!allowBuilding && state.initialization_state !== 'ready') this.requireReadyState(input.conversationId);
    let existingAlias = this.alias(input);
    if (existingAlias && existingAlias.entry_id !== input.preferredEntryId) {
      this.mergeSourceIdentity(input.conversationId, existingAlias.entry_id, input.preferredEntryId);
      existingAlias = this.alias(input);
    }
    if (existingAlias) {
      const removedEntry = this.db.get<{ removed_revision: number | null }>(`SELECT removed_revision FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [input.conversationId, existingAlias.entry_id]);
      if (existingAlias.content_hash === input.contentHash && removedEntry?.removed_revision === null) return this.envelopeForEntryInternal(input.conversationId, existingAlias.entry_id, allowBuilding)!;
      const revision = this.nextRevision(input.conversationId);
      this.db.execute(
        `UPDATE conversation_transcript_aliases
            SET source_revision = ?, content_revision = ?, content_hash = ?
          WHERE conversation_id = ? AND source_domain = ? AND source_scope = ? AND source_id = ? AND facet = ?`,
        [revision, input.inheritedContentRevision ?? revision, input.contentHash, input.conversationId, input.sourceDomain, input.sourceScope, input.sourceId, input.facet],
      );
      if (removedEntry && removedEntry.removed_revision !== null) {
        this.db.execute(`UPDATE conversation_transcript_entries SET removed_revision = NULL, placement_revision = ? WHERE conversation_id = ? AND id = ?`, [revision, input.conversationId, existingAlias.entry_id]);
      }
      return this.envelopeForEntryInternal(input.conversationId, existingAlias.entry_id, allowBuilding)!;
    }
    let entry = this.db.get<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [input.conversationId, input.preferredEntryId]);
    if (!entry) entry = this.createEntry(input);
    const sourceRevision = this.nextRevision(input.conversationId);
    this.db.execute(
      `INSERT INTO conversation_transcript_aliases
       (conversation_id, source_domain, source_scope, source_id, facet, entry_id, source_revision, content_revision, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.conversationId, input.sourceDomain, input.sourceScope, input.sourceId, input.facet, entry.id, sourceRevision, input.inheritedContentRevision ?? sourceRevision, input.contentHash],
    );
    return this.envelopeForEntryInternal(input.conversationId, entry.id, allowBuilding)!;
  }

  /** 创建一个新显示条目，并把输入与阶段归属一次写定。 */
  private createEntry(input: RegisterConversationTranscriptSourceInput): TranscriptEntryRow {
    const revision = this.nextRevision(input.conversationId);
    /** 阶段先于正文开始时保留原输入归属，期间插话不能吸走旧阶段的结果。 */
    const stageOpeningInputId = input.displayStageId
      ? this.db.get<{ opening_input_id: string | null }>(`SELECT opening_input_id FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [input.conversationId, input.displayStageId])?.opening_input_id
      : null;
    const openingInputId =
      input.kind === 'ordinary_input' ? input.preferredEntryId : (input.openingInputId ?? stageOpeningInputId ?? this.latestOpeningInputId(input.conversationId, input.turnId) ?? this.ensureHiddenInputAnchor(input, revision));
    let displayStageId = input.displayStageId ?? null;
    if (input.startsStage) displayStageId ??= this.ensureStageAnchor(input, openingInputId, revision);
    if (!displayStageId && (input.kind === 'tool_activity' || input.facet === 'reasoning_block')) displayStageId = this.currentStageId(input.conversationId, openingInputId) ?? this.ensureStageAnchor(input, openingInputId, revision);
    if (displayStageId) this.ensureNamedStageAnchor(input, openingInputId, displayStageId, revision);
    const displayOrder = input.kind === 'hidden_input_anchor' || input.kind === 'hidden_stage_anchor' ? null : this.nextDisplayOrder(input, openingInputId, displayStageId);
    this.db.execute(
      `INSERT INTO conversation_transcript_entries
       (conversation_id, id, turn_id, segment_id, kind, display_order, opening_input_id, display_stage_id,
        created_revision, placement_revision, first_seen_at, ordering_evidence, removed_revision, summary_entry_id, current_stage_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [input.conversationId, input.preferredEntryId, input.turnId, input.segmentId, input.kind, displayOrder, openingInputId, displayStageId, revision, revision, input.firstSeenAt, input.orderingEvidence],
    );
    if (displayStageId && input.startsStage) {
      this.db.execute(`UPDATE conversation_transcript_entries SET summary_entry_id = COALESCE(summary_entry_id, ?) WHERE conversation_id = ? AND id = ?`, [input.preferredEntryId, input.conversationId, displayStageId]);
    }
    return this.db.get<TranscriptEntryRow>(`SELECT * FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [input.conversationId, input.preferredEntryId])!;
  }

  /** 创建缺少可见开场正文时的隐藏轮次输入锚点。 */
  private ensureHiddenInputAnchor(input: RegisterConversationTranscriptSourceInput, revision: number): string {
    const anchorId = `turn-root:${input.turnId ?? input.segmentId ?? input.conversationId}`;
    this.db.execute(
      `INSERT OR IGNORE INTO conversation_transcript_entries
       (conversation_id, id, turn_id, segment_id, kind, display_order, opening_input_id, display_stage_id,
        created_revision, placement_revision, first_seen_at, ordering_evidence, removed_revision, summary_entry_id, current_stage_id)
       VALUES (?, ?, ?, ?, 'hidden_input_anchor', NULL, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [input.conversationId, anchorId, input.turnId, input.segmentId, anchorId, revision, revision, input.firstSeenAt, input.orderingEvidence],
    );
    return anchorId;
  }

  /** 为没有原生阶段身份的首次过程创建确定性隐藏阶段锚点。 */
  private ensureStageAnchor(input: RegisterConversationTranscriptSourceInput, openingInputId: string, revision: number): string {
    const currentStageId = this.currentStageId(input.conversationId, openingInputId);
    if (
      input.startsStage &&
      currentStageId &&
      this.db.get<{ summary_entry_id: string | null }>(`SELECT summary_entry_id FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [input.conversationId, currentStageId])?.summary_entry_id === null
    )
      return currentStageId;
    const anchorId = `stage:${stableIdentity([input.conversationId, openingInputId, input.sourceScope, input.sourceId, input.facet])}`;
    this.ensureNamedStageAnchor(input, openingInputId, anchorId, revision);
    return anchorId;
  }

  /** 确保命名阶段锚点存在，并更新输入锚点的当前阶段。 */
  private ensureNamedStageAnchor(input: RegisterConversationTranscriptSourceInput, openingInputId: string, stageId: string, revision: number): void {
    this.db.execute(
      `INSERT OR IGNORE INTO conversation_transcript_entries
       (conversation_id, id, turn_id, segment_id, kind, display_order, opening_input_id, display_stage_id,
        created_revision, placement_revision, first_seen_at, ordering_evidence, removed_revision, summary_entry_id, current_stage_id)
       VALUES (?, ?, ?, ?, 'hidden_stage_anchor', NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      [input.conversationId, stageId, input.turnId, input.segmentId, openingInputId, stageId, revision, revision, input.firstSeenAt, input.orderingEvidence],
    );
    if (input.startsStage || !this.currentStageId(input.conversationId, openingInputId))
      this.db.execute(`UPDATE conversation_transcript_entries SET current_stage_id = ? WHERE conversation_id = ? AND id = ?`, [stageId, input.conversationId, openingInputId]);
  }

  /** 读取指定输入锚点当前持久阶段。 */
  private currentStageId(conversationId: string, openingInputId: string): string | null {
    return this.db.get<{ current_stage_id: string | null }>(`SELECT current_stage_id FROM conversation_transcript_entries WHERE conversation_id = ? AND id = ?`, [conversationId, openingInputId])?.current_stage_id ?? null;
  }

  /** 读取同轮最近已确认普通输入；不使用当前分页切片。 */
  private latestOpeningInputId(conversationId: string, turnId: string | null): string | null {
    if (!turnId) return null;
    return (
      this.db.get<{ id: string }>(
        `SELECT id FROM conversation_transcript_entries
          WHERE conversation_id = ? AND turn_id = ? AND kind = 'ordinary_input' AND removed_revision IS NULL
          ORDER BY display_order DESC LIMIT 1`,
        [conversationId, turnId],
      )?.id ?? null
    );
  }

  /** 在既定阶段、输入、轮次范围内插入；迟到的旧轮次不能追加到新轮次之后。 */
  private nextDisplayOrder(input: RegisterConversationTranscriptSourceInput, openingInputId: string, stageId: string | null): number {
    const conversationId = input.conversationId;
    /** 先使用最窄的持久归属，工具结果因已有别名不会进入此路径。 */
    const scopes: Array<[string, string | null]> =
      input.kind === 'ordinary_input'
        ? [['turn_id', input.turnId]]
        : [
            ['display_stage_id', stageId],
            ['opening_input_id', openingInputId],
            ['turn_id', input.turnId],
          ];
    let left: number | null = null;
    for (const [column, identity] of scopes) {
      if (!identity) continue;
      left = this.db.get<{ value: number | null }>(`SELECT MAX(display_order) AS value FROM conversation_transcript_entries WHERE conversation_id = ? AND ${column} = ?`, [conversationId, identity])?.value ?? null;
      if (left !== null) break;
    }
    /** 首次补入旧轮时，按已存轮次起点寻找其后继；仅用于新身份定位。 */
    const nextTurn =
      left === null && input.turnId
        ? (this.db.get<{ value: number | null }>(
            `SELECT MIN(entry.display_order) AS value FROM conversation_transcript_entries AS entry
       JOIN conversation_turns AS next_turn ON next_turn.id = entry.turn_id
       JOIN conversation_turns AS own_turn ON own_turn.id = ?
       WHERE entry.conversation_id = ? AND next_turn.started_at > own_turn.started_at`,
            [input.turnId, conversationId],
          )?.value ?? null)
        : null;
    if (left === null && nextTurn === null) left = this.db.get<{ value: number | null }>(`SELECT MAX(display_order) AS value FROM conversation_transcript_entries WHERE conversation_id = ?`, [conversationId])?.value ?? null;
    const right =
      nextTurn ??
      (left === null ? null : (this.db.get<{ value: number | null }>(`SELECT MIN(display_order) AS value FROM conversation_transcript_entries WHERE conversation_id = ? AND display_order > ?`, [conversationId, left])?.value ?? null));
    const order = left === null ? (right === null ? conversationTranscriptOrderGap : right - conversationTranscriptOrderGap) : right === null ? left + conversationTranscriptOrderGap : left + Math.floor((right - left) / 2);
    if (Number.isSafeInteger(order) && order !== left && order !== right) return order;
    this.renumber(conversationId);
    return this.nextDisplayOrder(input, openingInputId, stageId);
  }

  /** 空隙耗尽时在事务内重新编号；先清空唯一位置，避免逐条交换发生冲突。 */
  private renumber(conversationId: string): void {
    const entries = this.db.select<{ id: string }>(`SELECT id FROM conversation_transcript_entries WHERE conversation_id = ? AND display_order IS NOT NULL ORDER BY display_order`, [conversationId]);
    if (!Number.isSafeInteger((entries.length + 1) * conversationTranscriptOrderGap)) throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_ORDER_EXHAUSTED', '显示位置已超出安全整数容量。');
    const revision = this.nextRevision(conversationId);
    this.db.execute(`UPDATE conversation_transcript_entries SET display_order = NULL WHERE conversation_id = ?`, [conversationId]);
    entries.forEach((entry, index) =>
      this.db.execute(`UPDATE conversation_transcript_entries SET display_order = ?, placement_revision = ? WHERE conversation_id = ? AND id = ?`, [(index + 1) * conversationTranscriptOrderGap, revision, conversationId, entry.id]),
    );
    this.db.execute(`UPDATE conversation_transcript_state SET order_epoch = order_epoch + 1 WHERE conversation_id = ?`, [conversationId]);
    placementChangeWriters.get(this.db)?.(conversationId, this.orderEpoch(conversationId), revision);
  }

  /** 分配会话严格递增修订。 */
  private nextRevision(conversationId: string): number {
    this.db.execute(`UPDATE conversation_transcript_state SET next_revision = next_revision + 1 WHERE conversation_id = ?`, [conversationId]);
    return this.db.get<{ next_revision: number }>(`SELECT next_revision FROM conversation_transcript_state WHERE conversation_id = ?`, [conversationId])?.next_revision ?? 1;
  }

  /** 读取来源别名。 */
  private alias(input: Pick<RegisterConversationTranscriptSourceInput, 'conversationId' | 'sourceDomain' | 'sourceScope' | 'sourceId' | 'facet'>): TranscriptAliasRow | undefined {
    return this.db.get<TranscriptAliasRow>(
      `SELECT * FROM conversation_transcript_aliases
        WHERE conversation_id = ? AND source_domain = ? AND source_scope = ? AND source_id = ? AND facet = ?`,
      [input.conversationId, input.sourceDomain, input.sourceScope, input.sourceId, input.facet],
    );
  }

  /** 读取索引状态。 */
  private state(conversationId: string): TranscriptStateRow | undefined {
    return this.db.get<TranscriptStateRow>(`SELECT * FROM conversation_transcript_state WHERE conversation_id = ?`, [conversationId]);
  }

  /** 读取可公开的 ready 状态。 */
  private requireReadyState(conversationId: string): TranscriptStateRow {
    const state = this.state(conversationId);
    if (!state) return { conversation_id: conversationId, next_revision: 0, order_epoch: 1, initialization_state: 'ready', initialization_cursor_json: null, reconstructed_count: 0 };
    if (state.initialization_state !== 'ready') {
      prioritizeTranscriptInitialization(this.db, conversationId);
      throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_INITIALIZING', '会话显示位置正在初始化。');
    }
    return state;
  }

  /** 按来源自己的持久游标读取一批旧数据事实。 */
  private reconstructionFactsForDomain(conversationId: string, domain: ConversationTranscriptInitializationDomain, offset: number, limit: number): ReconstructionFact[] {
    if (domain === 'model_history') return this.modelHistoryFacts(conversationId, offset, limit);
    if (domain === 'provider_item') return this.providerItemFacts(conversationId, offset, limit);
    if (domain === 'process') return this.processFacts(conversationId, offset, limit);
    if (domain === 'expert_execution') return this.expertExecutionFacts(conversationId, offset, limit);
    if (domain === 'request') return this.requestFacts(conversationId, offset, limit);
    return this.resourceFacts(conversationId, offset, limit);
  }

  /** 把一条最小重建事实写入持久暂存区，正文仍留在原业务表。 */
  private stageReconstructionFact(fact: ReconstructionFact): void {
    this.db.execute(
      `INSERT OR REPLACE INTO conversation_transcript_initialization_facts
       (conversation_id, source_domain, source_scope, source_id, facet, first_seen_at,
        source_priority, source_order, preferred_entry_id, fact_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [fact.conversationId, fact.sourceDomain, fact.sourceScope, fact.sourceId, fact.facet, fact.firstSeenAt, fact.sourcePriority, fact.sourceOrder, fact.preferredEntryId, JSON.stringify(fact)],
    );
  }

  /** 按统一旧数据顺序读取一批已暂存事实。 */
  private stagedReconstructionFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    return this.db
      .select<{ fact_json: string }>(
        `SELECT fact_json FROM conversation_transcript_initialization_facts
          WHERE conversation_id = ?
          ORDER BY first_seen_at, source_priority, source_order, preferred_entry_id, source_domain, source_id, facet
          LIMIT ? OFFSET ?`,
        [conversationId, limit, offset],
      )
      .map((row) => JSON.parse(row.fact_json) as ReconstructionFact);
  }

  /** 把确认历史转换为旧数据重建事实。 */
  private modelHistoryFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    const rows = this.db.select<{
      id: string;
      sequence: number;
      turn_id: string;
      submission_id: string | null;
      segment_id: string;
      role: string;
      content_json: string;
      reasoning_source_json: string | null;
      tool_pair_id: string | null;
      confirmed_at: string;
      expert_execution_id: string | null;
      client_message_id: string | null;
    }>(
      `SELECT history.id, history.sequence, history.turn_id, history.submission_id, history.segment_id,
              history.role,
              json_object('providerItemId', CASE WHEN json_valid(history.content_json) THEN json_extract(history.content_json, '$.providerItemId') END,
                'stageId', CASE WHEN json_valid(history.content_json) THEN json_extract(history.content_json, '$.stageId') END,
                'agentKind', segment.runtime_kind) AS content_json,
              CASE WHEN json_valid(history.reasoning_source_json) THEN json_object('itemId', json_extract(history.reasoning_source_json, '$.itemId'), 'providerItemId', json_extract(history.reasoning_source_json, '$.providerItemId'), 'stageId', json_extract(history.reasoning_source_json, '$.stageId'), 'readableSummary', json_extract(history.reasoning_source_json, '$.readableSummary')) END AS reasoning_source_json,
              history.tool_pair_id,
              history.confirmed_at, history.expert_execution_id, submission.client_message_id
         FROM conversation_model_history AS history
         LEFT JOIN conversation_submissions AS submission ON submission.id = history.submission_id
         LEFT JOIN conversation_runtime_segments AS segment ON segment.id = history.segment_id
        WHERE history.conversation_id = ? ORDER BY history.sequence, history.id LIMIT ? OFFSET ?`,
      [conversationId, limit, offset],
    );
    return rows.map((row) => {
      const content = parseRecord(row.content_json);
      const reasoning = parseRecord(row.reasoning_source_json);
      const providerItemId =
        stringValue(content.providerItemId) ??
        (content.agentKind === 'pi' ? stringValue(content.stageId) : null) ??
        stringValue(reasoning.itemId) ??
        stringValue(reasoning.providerItemId) ??
        row.expert_execution_id ??
        this.db.get<{ provider_item_id: string | null }>(
          `SELECT CASE WHEN COUNT(DISTINCT message.provider_item_id) = 1 THEN MIN(message.provider_item_id) END AS provider_item_id
         FROM conversation_model_history AS history
         JOIN conversation_turns AS turn ON turn.id = history.turn_id
         JOIN conversation_messages AS message ON message.conversation_id = history.conversation_id AND message.provider_turn_id = turn.provider_turn_id AND message.role = history.role AND message.created_at = history.confirmed_at
         WHERE history.id = ? AND message.content = CASE WHEN json_valid(history.content_json) THEN COALESCE(json_extract(history.content_json, '$.text'), history.content_json) ELSE history.content_json END`,
          [row.id],
        )?.provider_item_id;
      const reasoningBlock = row.role === 'assistant' && (reasoning.readableSummary === true || reasoning.readableSummary === 1);
      const facet = row.tool_pair_id ? 'tool_activity' : reasoningBlock ? 'reasoning_block' : 'body';
      const preferredEntryId =
        row.role === 'user' && row.client_message_id
          ? `user-message:${row.client_message_id}`
          : row.expert_execution_id
            ? `expert:${row.expert_execution_id}`
            : providerItemId
              ? providerEntryId(row.segment_id, providerItemId, facet)
              : `history:${row.id}`;
      return {
        conversationId,
        sourceDomain: 'model_history',
        sourceScope: row.segment_id,
        sourceId: row.id,
        facet,
        preferredEntryId,
        kind: row.role === 'user' ? 'ordinary_input' : row.tool_pair_id ? 'tool_activity' : 'content',
        turnId: row.turn_id,
        segmentId: row.segment_id,
        displayStageId: stringValue(content.stageId) ?? stringValue(reasoning.stageId),
        startsStage: reasoningBlock,
        firstSeenAt: row.confirmed_at,
        orderingEvidence: 'reconstructed',
        contentHash: hashConversationTranscriptContent([row.content_json, row.reasoning_source_json, row.tool_pair_id]),
        sourceOrder: row.sequence,
        sourcePriority: row.role === 'user' ? 10 : 30,
      } satisfies ReconstructionFact;
    });
  }

  /** 把活动 Provider 条目转换为旧数据重建事实。 */
  private providerItemFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    return this.db
      .select<{
        id: string;
        turn_id: string;
        provider_thread_id: string;
        provider_item_id: string;
        item_type: string;
        phase: string;
        payload_projection_json: string;
        text_projection: string;
        started_at: string | null;
        updated_at: string;
      }>(
        `SELECT id, turn_id, provider_thread_id, provider_item_id, item_type, phase,
                CASE WHEN json_valid(payload_projection_json) THEN json_object('stageId', json_extract(payload_projection_json, '$.stageId')) ELSE '{}' END AS payload_projection_json, '' AS text_projection, started_at, updated_at
           FROM conversation_provider_item_states WHERE conversation_id = ? ORDER BY updated_at, id LIMIT ? OFFSET ?`,
        [conversationId, limit, offset],
      )
      .map((row, index) => {
        const payload = parseRecord(row.payload_projection_json);
        const facet = providerFacet(row.item_type);
        const segmentId = this.segmentForProviderThread(conversationId, row.provider_thread_id);
        return {
          conversationId,
          sourceDomain: 'provider_item',
          sourceScope: row.provider_thread_id,
          sourceId: row.provider_item_id,
          facet,
          preferredEntryId: providerEntryId(segmentId ?? row.provider_thread_id, row.provider_item_id, facet),
          kind: facet === 'tool_activity' ? 'tool_activity' : 'content',
          turnId: row.turn_id,
          segmentId,
          displayStageId: stringValue(payload.stageId),
          startsStage: false,
          firstSeenAt: row.started_at ?? row.updated_at,
          orderingEvidence: 'reconstructed',
          contentHash: hashConversationTranscriptContent([row.text_projection, row.payload_projection_json, row.phase]),
          sourceOrder: offset + index + 1,
          sourcePriority: 20,
        } satisfies ReconstructionFact;
      });
  }

  /** 把过程记录转换为旧数据重建事实。 */
  private processFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    return this.db
      .select<{
        id: string;
        turn_id: string;
        segment_id: string;
        process_sequence: number;
        kind: string;
        title: string;
        detail_json: string;
        source_event_id: string | null;
        started_at: string;
        completed_at: string | null;
      }>(
        `SELECT id, turn_id, segment_id, process_sequence, kind, '' AS title, CASE WHEN json_valid(detail_json) THEN json_object('stageId', json_extract(detail_json, '$.stageId')) ELSE '{}' END AS detail_json, source_event_id, started_at, completed_at FROM conversation_process_items WHERE conversation_id = ? ORDER BY process_sequence, id LIMIT ? OFFSET ?`,
        [conversationId, limit, offset],
      )
      .map((row) => {
        const detail = parseRecord(row.detail_json);
        const providerItemId = conversationProcessProviderItemId(row.source_event_id);
        const facet = row.kind === 'reasoning' ? 'reasoning_block' : 'tool_activity';
        return {
          conversationId,
          sourceDomain: 'process',
          sourceScope: row.segment_id,
          sourceId: row.id,
          facet,
          preferredEntryId: providerItemId ? providerEntryId(row.segment_id, providerItemId, facet) : `process:${row.id}`,
          kind: 'tool_activity',
          turnId: row.turn_id,
          segmentId: row.segment_id,
          displayStageId: stringValue(detail.stageId),
          startsStage: row.kind === 'reasoning',
          firstSeenAt: row.started_at,
          orderingEvidence: 'reconstructed',
          contentHash: hashConversationTranscriptContent([row.title, row.detail_json, row.completed_at]),
          sourceOrder: row.process_sequence,
          sourcePriority: 40,
        } satisfies ReconstructionFact;
      });
  }

  /** 把专家活动状态转换为可与最终历史共用的显示事实。 */
  private expertExecutionFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    return this.db
      .select<{ id: string; submission_id: string; status: string; answer: string | null; error_json: string | null; created_at: string; updated_at: string; turn_id: string; segment_id: string }>(
        `SELECT execution.id, execution.submission_id, execution.status, NULL AS answer, NULL AS error_json,
                execution.created_at, execution.updated_at, turn.id AS turn_id, history.segment_id
           FROM conversation_expert_executions AS execution
           JOIN conversation_turns AS turn ON turn.client_submission_id = execution.submission_id
           JOIN conversation_model_history AS history ON history.submission_id = execution.submission_id AND history.role = 'user'
          WHERE execution.conversation_id = ?
          ORDER BY execution.created_at, execution.ordinal, execution.id LIMIT ? OFFSET ?`,
        [conversationId, limit, offset],
      )
      .map((row, index) => ({
        conversationId,
        sourceDomain: 'expert_execution',
        sourceScope: row.submission_id,
        sourceId: row.id,
        facet: 'body',
        preferredEntryId: `expert:${row.id}`,
        kind: 'content',
        turnId: row.turn_id,
        segmentId: row.segment_id,
        firstSeenAt: row.created_at,
        orderingEvidence: 'reconstructed',
        contentHash: hashConversationTranscriptContent([row.status, row.answer, row.error_json, row.updated_at]),
        sourceOrder: offset + index + 1,
        sourcePriority: 35,
      }));
  }

  /** 把结构化问答转换为旧数据重建事实。 */
  private requestFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    return this.db
      .select<{
        id: string;
        turn_id: string | null;
        item_id: string | null;
        payload_json: string;
        response_json: string | null;
        status: string;
        created_at: string;
        resolved_at: string | null;
      }>(`SELECT id, turn_id, item_id, '{}' AS payload_json, NULL AS response_json, status, created_at, resolved_at FROM conversation_server_requests WHERE conversation_id = ? ORDER BY created_at, id LIMIT ? OFFSET ?`, [
        conversationId,
        limit,
        offset,
      ])
      .map((row, index) => ({
        conversationId,
        sourceDomain: 'request',
        sourceScope: row.turn_id ?? conversationId,
        sourceId: row.id,
        facet: 'request_answer',
        preferredEntryId: `request:${row.id}`,
        kind: 'question',
        turnId: row.turn_id,
        segmentId: null,
        firstSeenAt: row.created_at,
        orderingEvidence: 'reconstructed',
        contentHash: hashConversationTranscriptContent([row.payload_json, row.response_json, row.status, row.resolved_at]),
        sourceOrder: offset + index + 1,
        sourcePriority: 50,
      }));
  }

  /** 把交付资源转换为旧数据重建事实。 */
  private resourceFacts(conversationId: string, offset: number, limit: number): ReconstructionFact[] {
    return this.db
      .select<{
        id: string;
        turn_id: string;
        item_id: string;
        source_index: number;
        display_json: string;
        updated_at: string;
        created_at: string;
      }>(`SELECT id, turn_id, item_id, source_index, '{}' AS display_json, updated_at, created_at FROM conversation_resources WHERE conversation_id = ? ORDER BY created_at, source_index, id LIMIT ? OFFSET ?`, [
        conversationId,
        limit,
        offset,
      ])
      .map((row) => ({
        conversationId,
        sourceDomain: 'resource',
        sourceScope: row.turn_id,
        sourceId: row.id,
        facet: 'resource',
        preferredEntryId: `resource:${row.id}`,
        kind: 'resource',
        turnId: row.turn_id,
        segmentId: null,
        firstSeenAt: row.created_at,
        orderingEvidence: 'reconstructed',
        contentHash: hashConversationTranscriptContent([row.item_id, row.source_index, row.display_json, row.updated_at]),
        sourceOrder: row.source_index,
        sourcePriority: 60,
      }));
  }

  /** 按 Provider 线程找到持久运行分段。 */
  private segmentForProviderThread(conversationId: string, providerThreadId: string): string | null {
    return this.db.get<{ id: string }>(`SELECT id FROM conversation_runtime_segments WHERE conversation_id = ? AND native_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, [conversationId, providerThreadId])?.id ?? null;
  }
}

/** 将数据库条目映射为共享位置协议。 */
function mapPlacement(row: TranscriptEntryRow, orderEpoch: number): ConversationTranscriptPlacement {
  return {
    entryId: row.id,
    order: row.display_order,
    orderEpoch,
    placementRevision: row.placement_revision,
    turnId: row.turn_id,
    openingInputId: row.opening_input_id,
    displayStageId: row.display_stage_id,
  };
}

/** 将数据库别名映射为共享来源修订。 */
function mapSourceStamp(row: TranscriptAliasRow): ConversationTranscriptSourceStamp {
  return {
    domain: row.source_domain,
    scope: row.source_scope,
    sourceId: row.source_id,
    facet: row.facet,
    revision: row.source_revision,
    contentRevision: row.content_revision,
  };
}

/** 解析旧数据初始化断点；损坏断点必须触发一次干净重建。 */
function parseInitializationCursor(value: string | null): ConversationTranscriptInitializationCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (parsed.phase === 'collecting' && Number.isSafeInteger(parsed.domainIndex) && Number.isSafeInteger(parsed.offset) && Number(parsed.domainIndex) >= 0 && Number(parsed.offset) >= 0) {
      return { phase: 'collecting', domainIndex: Number(parsed.domainIndex), offset: Number(parsed.offset) };
    }
    if (parsed.phase === 'ordering' && Number.isSafeInteger(parsed.offset) && Number(parsed.offset) >= 0) return { phase: 'ordering', offset: Number(parsed.offset) };
    return null;
  } catch {
    return null;
  }
}

/** Provider 原生条目按运行分段、原生身份与内容部分生成显示身份。 */
export function providerEntryId(segmentId: string, providerItemId: string, facet: string): string {
  return `provider:${stableIdentity([segmentId, providerItemId, facet])}`;
}

/** Provider 类型映射到互不覆盖的显示内容部分。 */
export function providerFacet(itemType: string): 'body' | 'reasoning_block' | 'tool_activity' {
  if (itemType.toLowerCase().includes('reason')) return 'reasoning_block';
  if (/tool|command|file|search|image/u.test(itemType.toLowerCase())) return 'tool_activity';
  return 'body';
}

/** 生成不含正文的短稳定身份。 */
function stableIdentity(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

/** 为等价内容生成内部修订指纹。 */
export function hashConversationTranscriptContent(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

/** 解析可能损坏的旧结构 JSON。 */
function parseRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 读取非空字符串。 */
function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** 校验索引写入的信任边界。 */
function validateRegistration(input: RegisterConversationTranscriptSourceInput): void {
  for (const [name, value] of [
    ['conversationId', input.conversationId],
    ['sourceDomain', input.sourceDomain],
    ['sourceScope', input.sourceScope],
    ['sourceId', input.sourceId],
    ['facet', input.facet],
    ['preferredEntryId', input.preferredEntryId],
    ['contentHash', input.contentHash],
  ] as const) {
    if (!value.trim() || Buffer.byteLength(value) > 4_096) throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_INVALID_IDENTITY', `${name} 格式无效。`);
  }
  if (!Number.isFinite(Date.parse(input.firstSeenAt))) throw transcriptError('ZEUS_CONVERSATION_TRANSCRIPT_INVALID_TIME', '来源首次出现时间无效。');
}

/** 创建带稳定错误码的索引错误。 */
function transcriptError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
