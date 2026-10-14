import { createHash } from 'node:crypto';
import { redactUserFacingErrorDetails, parseConversationSystemMessage, type ConversationSystemMessage, type ConversationSystemMessageInput, type ConversationSystemMessagePage } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { ConversationTranscriptRepository, hashConversationTranscriptContent } from './conversationTranscriptStore.js';

/** 系统消息沿用消息表，来源与模型确认历史明确分开。 */
const systemMessageSource = 'zeus_system';
/** 一页诊断大小有上限，长历史通过稳定身份向前读取。 */
const systemMessagePageSize = 32;

/** 消息表中系统消息的最小读取投影。 */
interface SystemMessageRow {
  /** 消息表主键，不借用 Provider 身份。 */
  id: string;
  /** 产品会话身份。 */
  conversation_id: string;
  /** 保存系统消息内容和恢复事实。 */
  metadata_json: string;
}

/** 系统消息正文与位置共用一个数据库事务。 */
export class ConversationSystemMessageRepository {
  /** 复用产品会话的持久排序，不另建时间线。 */
  private readonly transcript: ConversationTranscriptRepository;

  /** 数据库只提供存储端口。 */
  constructor(private readonly db: ZeusDatabasePort) {
    this.transcript = new ConversationTranscriptRepository(db);
  }

  /** 幂等保存首次失败及恢复事实；重复上报不能移动或擦除原消息。 */
  save(conversationId: string, value: ConversationSystemMessageInput): ConversationSystemMessage {
    /** 写入边界也校验来自内部调用的内容。 */
    const parsed = parseConversationSystemMessage(value);
    /** 服务端再次脱敏，不能信任渲染进程已做处理。 */
    const input = { ...parsed, summary: redactUserFacingErrorDetails(parsed.summary), detail: redactUserFacingErrorDetails(parsed.detail) };
    return this.db.transaction(() => {
      if (!this.db.get('SELECT id FROM conversations WHERE id = ?', [conversationId])) throw new Error('找不到系统消息所属会话。');
      /** 同一草稿迁移后仍用产品会话和原消息身份去重。 */
      const recordId = `conversation_system_${createHash('sha256')
        .update(JSON.stringify([conversationId, input.id]))
        .digest('hex')}`;
      /** 断线重放先按稳定身份查找；后台重复故障再按操作和诊断合并。 */
      const existing = this.db.get<SystemMessageRow>(
        `SELECT id, conversation_id, metadata_json FROM conversation_messages
         WHERE conversation_id = ? AND source = ? AND (id = ? OR (
           json_extract(metadata_json, '$.recoveredAt') IS NULL
           AND json_extract(metadata_json, '$.operation') = ?
           AND json_extract(metadata_json, '$.targetTurnId') IS ?
           AND json_extract(metadata_json, '$.detail') = ?)) ORDER BY id = ? DESC, created_at DESC LIMIT 1`,
        [conversationId, systemMessageSource, recordId, input.operation, input.targetTurnId, input.detail, recordId],
      );
      /** 已存在的内容和首次时间保持原样，仅允许补充恢复事实。 */
      const previous = existing ? parseConversationSystemMessage(JSON.parse(existing.metadata_json)) : null;
      if (previous && (previous.operation !== input.operation || previous.targetTurnId !== input.targetTurnId || (previous.id === input.id && previous.relatedEntryId !== input.relatedEntryId) || previous.detail !== input.detail))
        throw new Error('系统消息身份与原始内容冲突。');
      /** 首条故障身份接管后续相同自动上报。 */
      const message: ConversationSystemMessageInput = previous ? { ...previous, recoveredAt: previous.recoveredAt ?? input.recoveredAt } : input;
      /** 只接受同一会话内的真实关联位置。 */
      const anchor = message.relatedEntryId ? this.transcript.envelopeForEntry(conversationId, message.relatedEntryId)?.placement : null;
      if (message.relatedEntryId && !anchor) throw new Error('找不到系统消息关联的会话消息。');
      if (message.targetTurnId && !this.db.get('SELECT id FROM conversation_turns WHERE conversation_id = ? AND id = ?', [conversationId, message.targetTurnId])) throw new Error('系统消息目标轮次不属于当前会话。');
      /** 数据库主键与显示来源身份一同复用。 */
      const id = existing?.id ?? recordId;
      if (!existing) {
        this.db.execute('INSERT INTO conversation_messages (id, conversation_id, role, content, source, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
          id,
          conversationId,
          'system',
          message.summary,
          systemMessageSource,
          JSON.stringify(message),
          message.occurredAt,
        ]);
      } else if (message.recoveredAt !== previous?.recoveredAt) {
        this.db.execute('UPDATE conversation_messages SET metadata_json = ? WHERE id = ?', [JSON.stringify(message), id]);
      }
      /** 同一相关消息后的多条提示按首次发生顺序接续，不能倒插。 */
      const precedingNotice = message.relatedEntryId
        ? this.db.get<{ entry_id: string }>(
            `SELECT alias.entry_id FROM conversation_messages AS other JOIN conversation_transcript_aliases AS alias ON alias.conversation_id = other.conversation_id AND alias.source_domain = 'system_message' AND alias.source_id = other.id JOIN conversation_transcript_entries AS entry ON entry.conversation_id = alias.conversation_id AND entry.id = alias.entry_id WHERE other.conversation_id = ? AND other.source = ? AND other.id <> ? AND json_extract(other.metadata_json, '$.relatedEntryId') = ? AND other.created_at <= ? ORDER BY entry.display_order DESC LIMIT 1`,
            [conversationId, systemMessageSource, id, message.relatedEntryId, message.occurredAt],
          )
        : null;
      /** 草稿和断连期间发生的无关联消息按首次发生位置补入，不挂在补写时的尾部。 */
      const previousEntry = !message.relatedEntryId
        ? this.db.get<{ id: string }>(
            'SELECT id FROM conversation_transcript_entries WHERE conversation_id = ? AND display_order IS NOT NULL AND first_seen_at <= ? AND id <> ? AND removed_revision IS NULL ORDER BY display_order DESC LIMIT 1',
            [conversationId, message.occurredAt, `system-message:${id}`],
          )
        : null;
      /** 早于首条消息的草稿诊断在首条消息前显示。 */
      const firstEntry =
        !message.relatedEntryId && !previousEntry
          ? this.db.get<{ id: string }>('SELECT id FROM conversation_transcript_entries WHERE conversation_id = ? AND display_order IS NOT NULL AND id <> ? AND removed_revision IS NULL ORDER BY display_order LIMIT 1', [
              conversationId,
              `system-message:${id}`,
            ])
          : null;
      /** 明确锚定相关消息；没有关联时按首次发生位置登记。 */
      const transcript = this.transcript.registerSource({
        conversationId,
        sourceDomain: 'system_message',
        sourceScope: conversationId,
        sourceId: id,
        facet: 'notice',
        preferredEntryId: `system-message:${id}`,
        kind: 'notice',
        turnId: anchor?.turnId ?? null,
        segmentId: null,
        openingInputId: anchor?.openingInputId,
        afterEntryId: precedingNotice?.entry_id ?? message.relatedEntryId ?? previousEntry?.id,
        beforeEntryId: firstEntry?.id,
        firstSeenAt: message.occurredAt,
        orderingEvidence: 'live',
        contentHash: hashConversationTranscriptContent([message]),
      });
      return { ...message, conversationId, transcript };
    });
  }

  /** 按持久位置向前分页；游标绑定会话并使用消息身份，不使用易漂移的数组下标。 */
  list(conversationId: string, cursor?: string): ConversationSystemMessagePage {
    /** 恢复状态变化不会改变分页边界。 */
    const before = cursor ? this.transcript.envelopeForEntry(conversationId, cursor)?.placement.order : null;
    if (cursor && before == null) throw new Error('系统消息分页游标无效。');
    /** 多读一条只用于判断下一页。 */
    const rows = this.db.select<SystemMessageRow>(
      `SELECT message.id, message.conversation_id, message.metadata_json FROM conversation_messages AS message
       JOIN conversation_transcript_aliases AS alias ON alias.conversation_id = message.conversation_id AND alias.source_domain = 'system_message' AND alias.source_id = message.id AND alias.facet = 'notice'
       JOIN conversation_transcript_entries AS entry ON entry.conversation_id = alias.conversation_id AND entry.id = alias.entry_id
       WHERE message.conversation_id = ? AND message.source = ? AND entry.removed_revision IS NULL
         AND (? IS NULL OR entry.display_order < ?) ORDER BY entry.display_order DESC LIMIT ?`,
      [conversationId, systemMessageSource, before ?? null, before ?? null, systemMessagePageSize + 1],
    );
    /** 首屏和历史页返回相同的系统消息结构。 */
    const items = rows
      .slice(0, systemMessagePageSize)
      .map((row) => ({
        ...parseConversationSystemMessage(JSON.parse(row.metadata_json)),
        conversationId,
        transcript: this.transcript.envelopeForEntry(conversationId, `system-message:${row.id}`)!,
      }))
      .reverse();
    return { conversationId, items, nextCursor: rows.length > systemMessagePageSize ? items[0]!.transcript.placement.entryId : null };
  }
}
