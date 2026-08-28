import { createHash, randomUUID } from 'node:crypto';
import {
  conversationSchemaGeneration,
  conversationSyncProtocolV2Generation,
  type ConversationSyncEventPage,
  type ConversationSyncEventRecord,
  type ConversationSyncEventRepository,
  type ConversationSyncEventStreamRecord,
  type ZeusDatabase,
} from '@zeus/storage';
import { classifyConversationEventDurability, conversationEventFlowBudgets, type ConversationEventDurabilityLevel, type ConversationEventFlowControl } from './eventFlowControl.js';

export const conversationSyncProtocolGeneration = conversationSyncProtocolV2Generation;
export const maximumDurableConversationEventBytes = 1024 * 1024;
export const conversationSyncTransportBudgets = conversationEventFlowBudgets.websocket;
export const maximumRetainedConversationSyncEvents = 4_096;
export const maximumRetainedConversationSyncBytes = 16 * 1024 * 1024;
const conversationSyncCompactionInterval = 64;
const retainedConversationSyncEventsWatermark = maximumRetainedConversationSyncEvents - conversationSyncCompactionInterval;
const retainedConversationSyncBytesWatermark = 12 * 1024 * 1024;
const immediateCompactionEventBytes = 64 * 1024;

/** WebSocket 路由只依赖这一个诊断端口，不感知流控实现及其他阶段预算。 */
export interface ConversationSyncFlowControlPort {
  observeWebSocketSlowConsumerDisconnect(bufferedBytes: number): void;
}

export interface DurableConversationRealtimeEvent {
  id: string;
  type: string;
  payload: Record<string, unknown> & {
    conversationId: string;
    conversationSchemaGeneration: typeof conversationSchemaGeneration;
    syncStreamGeneration: typeof conversationSyncProtocolGeneration;
    sequence: number;
    entityRevision: string | number;
    durabilityLevel: Exclude<ConversationEventDurabilityLevel, 'ephemeral_ui'>;
  };
  createdAt: string;
}

export interface DurableConversationEventPage {
  conversationId: string;
  conversationSchemaGeneration: typeof conversationSchemaGeneration;
  syncStreamGeneration: typeof conversationSyncProtocolGeneration;
  baseSequence: number | null;
  throughEventSeq: number;
  nextCursor: number;
  hasMore: boolean;
  requestedBeforeBaseline: boolean;
  events: DurableConversationRealtimeEvent[];
}

export interface AppendDurableConversationEventInput {
  conversationId: string;
  type: string;
  payload: Record<string, unknown>;
  eventId?: string;
  occurredAt?: string;
}

export interface ConversationSyncProtocolOptions {
  db: ZeusDatabase;
  repository: ConversationSyncEventRepository;
  broadcast: (event: DurableConversationRealtimeEvent) => void | Promise<void>;
  now?: () => Date;
  flowControl?: ConversationEventFlowControl;
}

/**
 * 会话增量协议只承载已经写入 SQLite 的 UI 投影。
 *
 * Repository 与业务写入共享当前事务；WebSocket 通知注册到 afterCommit，因此 COMMIT
 * 失败时客户端绝不会先看到成功事件。Provider runtime generation 只能放在 payload，
 * 不得替代稳定的 Zeus 协议流 generation。
 */
export class ConversationSyncProtocol {
  private readonly now: () => Date;

  constructor(private readonly options: ConversationSyncProtocolOptions) {
    this.now = options.now ?? (() => new Date());
  }

  currentStream(conversationId: string): ConversationSyncEventStreamRecord | undefined {
    return this.options.repository.currentStream(conversationId);
  }

  throughSequence(conversationId: string): number {
    return this.currentStream(conversationId)?.latestSequence ?? 0;
  }

  append(input: AppendDurableConversationEventInput): DurableConversationRealtimeEvent {
    const occurredAt = input.occurredAt ?? durableEventOccurredAt(input) ?? this.now().toISOString();
    const eventId = input.eventId ?? stableDurableEventId(input) ?? randomUUID();
    const durabilityLevel = classifyConversationEventDurability(input.type);
    if (durabilityLevel === 'ephemeral_ui') {
      this.options.flowControl?.observeDroppedEphemeralEvent();
      throw Object.assign(new Error('临时 UI 事件不得进入耐久会话流。'), { code: 'ZEUS_CONVERSATION_SYNC_EPHEMERAL_NOT_DURABLE' });
    }
    const entityRevision = input.payload.entityRevision;
    if ((typeof entityRevision !== 'string' || !entityRevision.trim()) && (typeof entityRevision !== 'number' || !Number.isSafeInteger(entityRevision))) {
      this.options.flowControl?.observeFailClosed();
      throw Object.assign(new Error('耐久会话事件必须携带稳定实体 revision。'), { code: 'ZEUS_CONVERSATION_SYNC_ENTITY_REVISION_REQUIRED' });
    }
    const storedEnvelope = {
      id: eventId,
      type: input.type,
      payload: {
        ...input.payload,
        conversationId: input.conversationId,
        conversationSchemaGeneration,
        syncStreamGeneration: conversationSyncProtocolGeneration,
        entityRevision,
        durabilityLevel,
      },
      createdAt: occurredAt,
    };
    const encodedBytes = Buffer.byteLength(JSON.stringify(storedEnvelope), 'utf8');
    if (encodedBytes > maximumDurableConversationEventBytes) {
      throw Object.assign(new Error('会话增量事件超过 1 MiB 协议预算；完整内容必须改用句柄或分页读取。'), {
        code: 'ZEUS_CONVERSATION_SYNC_EVENT_TOO_LARGE',
        details: { conversationId: input.conversationId, type: input.type, encodedBytes, maximumBytes: maximumDurableConversationEventBytes },
      });
    }
    const appended = this.options.repository.appendNext({
      conversationId: input.conversationId,
      generationId: conversationSyncProtocolGeneration,
      eventId,
      payload: storedEnvelope,
      occurredAt,
    });
    if (!appended.appended) return decodeStoredEvent(appended.event);
    if (appended.latestSequence % conversationSyncCompactionInterval === 0 || appended.event.payloadByteLength >= immediateCompactionEventBytes) {
      const compacted = this.options.repository.compactCurrentStreamTail({
        conversationId: input.conversationId,
        generationId: conversationSyncProtocolGeneration,
        maximumEvents: retainedConversationSyncEventsWatermark,
        maximumBytes: retainedConversationSyncBytesWatermark,
      });
      if (compacted.prunedEvents > 0) this.options.flowControl?.observeCoalescedProcessEvent(compacted.prunedEvents);
    }
    const event = decodeStoredEvent(appended.event);
    this.options.flowControl?.observeAppend(durabilityLevel);
    this.options.db.afterCommit(() => this.options.broadcast(event));
    return event;
  }

  listPage(input: { conversationId: string; afterSequence?: number; limit?: number; byteLimit?: number }): DurableConversationEventPage {
    const page = this.options.repository.listPage({
      conversationId: input.conversationId,
      generationId: conversationSyncProtocolGeneration,
      ...(input.afterSequence === undefined ? {} : { afterSequence: input.afterSequence }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.byteLimit === undefined ? {} : { byteLimit: input.byteLimit }),
    });
    return toProtocolPage(input.conversationId, page);
  }
}

function stableDurableEventId(input: AppendDurableConversationEventInput): string | null {
  if (input.type !== 'conversation.turn.change_set.changed') return null;
  const changeSetId = input.payload.changeSetId;
  const entityRevision = input.payload.entityRevision;
  if (typeof changeSetId !== 'string' || !changeSetId || (typeof entityRevision !== 'string' && typeof entityRevision !== 'number')) return null;
  const digest = createHash('sha256')
    .update(`${input.conversationId}\0${input.type}\0${changeSetId}\0${String(entityRevision)}`)
    .digest('hex');
  return `change-set:${digest}`;
}

function durableEventOccurredAt(input: AppendDurableConversationEventInput): string | null {
  if (input.type !== 'conversation.turn.change_set.changed') return null;
  const revision = input.payload.entityRevision;
  return typeof revision === 'string' && !Number.isNaN(Date.parse(revision)) ? revision : null;
}

function toProtocolPage(conversationId: string, page: ConversationSyncEventPage): DurableConversationEventPage {
  return {
    conversationId,
    conversationSchemaGeneration,
    syncStreamGeneration: conversationSyncProtocolGeneration,
    baseSequence: page.baseSequence,
    throughEventSeq: page.throughSequence,
    nextCursor: page.nextSequence,
    hasMore: page.hasMore,
    requestedBeforeBaseline: page.requestedBeforeBaseline,
    events: page.events.map(decodeStoredEvent),
  };
}

function decodeStoredEvent(record: ConversationSyncEventRecord): DurableConversationRealtimeEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.payloadJson);
  } catch (error) {
    throw protocolCorruption('耐久会话事件不是合法 JSON。', record, error);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw protocolCorruption('耐久会话事件不是对象。', record);
  const envelope = parsed as Record<string, unknown>;
  if (envelope.id !== record.eventId || typeof envelope.type !== 'string' || !envelope.type || envelope.createdAt !== record.occurredAt) {
    throw protocolCorruption('耐久会话事件身份或时间与存储索引不一致。', record);
  }
  if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) throw protocolCorruption('耐久会话事件缺少 payload。', record);
  const payload = envelope.payload as Record<string, unknown>;
  if (payload.conversationId !== record.conversationId || payload.conversationSchemaGeneration !== conversationSchemaGeneration || payload.syncStreamGeneration !== conversationSyncProtocolGeneration) {
    throw protocolCorruption('耐久会话事件的会话或协议代次不一致。', record);
  }
  const entityRevision = payload.entityRevision;
  if ((typeof entityRevision !== 'string' || !entityRevision.trim()) && (typeof entityRevision !== 'number' || !Number.isSafeInteger(entityRevision))) {
    throw protocolCorruption('耐久会话事件缺少实体 revision。', record);
  }
  if (payload.durabilityLevel !== 'critical_fact' && payload.durabilityLevel !== 'coalescible_process') {
    throw protocolCorruption('耐久会话事件的耐久等级无效。', record);
  }
  return {
    id: record.eventId,
    type: envelope.type,
    payload: {
      ...payload,
      conversationId: record.conversationId,
      conversationSchemaGeneration,
      syncStreamGeneration: conversationSyncProtocolGeneration,
      sequence: record.sequence,
      entityRevision,
      durabilityLevel: payload.durabilityLevel,
    },
    createdAt: record.occurredAt,
  };
}

function protocolCorruption(message: string, record: ConversationSyncEventRecord, cause?: unknown): Error {
  const error = new Error(`${message} conversation=${record.conversationId} generation=${record.generationId} sequence=${record.sequence}`, cause === undefined ? undefined : { cause });
  error.name = 'ConversationSyncProtocolCorruptionError';
  return error;
}
