import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { conversationSyncProtocolV2Generation } from '../packages/storage/src/conversationSyncEventStore.js';

/** 压缩与提升必须共同满足的维护账本身份。 */
export const maintenanceMigrationId = '20261018_0001_archived_conversation_sync_event_cleanup';
/** 每个当前会话最多保留的连续同步事件数量。 */
export const maximumRetainedEvents = 4_096;
/** 每个当前会话最多保留的同步载荷字节数。 */
export const maximumRetainedBytes = 16 * 1024 * 1024;
/** 维护规则的摘要包含删除范围和当前尾部预算，不能用旧标记代替。 */
export const maintenanceChecksum = `sha256:${createHash('sha256').update('retired-and-archived-sync-events-deleted,current-tail<=4096-events,current-tail<=16777216-bytes').digest('hex')}`;
/** 维护前后必须保持不变的业务事实表。 */
export const businessFactTables = [
  'conversations',
  'conversation_turns',
  'conversation_items',
  'conversation_model_history',
  'conversation_process_items',
  'conversation_resources',
  'turn_change_sets',
  'turn_change_files',
  'conversation_server_requests',
  'conversation_submissions',
] as const;

/** 压缩产物和正式提升统一检查的维护事实。 */
export interface ConversationSyncMaintenanceFacts {
  /** 必须同时匹配当前标记和规则摘要。 */
  maintenanceMigrationPresent: boolean;
  /** 退役代次不能残留同步事件。 */
  legacySyncEvents: number;
  /** 已归档会话不能残留短期同步投影。 */
  archivedSyncEvents: number;
  /** 当前流水必须属于当前同步协议。 */
  currentNonV2Streams: number;
  /** 当前流水的事件数或载荷字节不能超预算。 */
  retainedBudgetViolations: number;
}

/** 只读收集维护事实；调用方负责打开一致候选或已退出的正式数据库。 */
export function inspectConversationSyncMaintenance(database: DatabaseSync): ConversationSyncMaintenanceFacts {
  /** 所有统计语句在此集中，避免压缩与提升检查规则漂移。 */
  const count = (sql: string, parameters: Array<string | number> = []): number => Number((database.prepare(sql).get(...parameters) as { value: number }).value);
  /** 账本存在但摘要不匹配时仍视为未完成维护。 */
  const marker = database.prepare('SELECT checksum FROM schema_migrations WHERE migration_id = ?').get(maintenanceMigrationId) as { checksum: string } | undefined;
  return {
    maintenanceMigrationPresent: marker?.checksum === maintenanceChecksum,
    legacySyncEvents: count('SELECT COUNT(*) AS value FROM conversation_sync_events WHERE generation_id <> ?', [conversationSyncProtocolV2Generation]),
    archivedSyncEvents: count('SELECT COUNT(*) AS value FROM conversation_sync_events WHERE conversation_id IN (SELECT id FROM conversations WHERE archived = 1)'),
    currentNonV2Streams: count('SELECT COUNT(*) AS value FROM conversation_sync_event_streams WHERE is_current = 1 AND generation_id <> ?', [conversationSyncProtocolV2Generation]),
    retainedBudgetViolations: count(
      'SELECT COUNT(*) AS value FROM (SELECT conversation_id, COUNT(*) AS events, COALESCE(SUM(payload_byte_length), 0) AS bytes FROM conversation_sync_events WHERE generation_id = ? GROUP BY conversation_id HAVING events > ? OR bytes > ?)',
      [conversationSyncProtocolV2Generation, maximumRetainedEvents, maximumRetainedBytes],
    ),
  };
}

/** 两个维护入口使用同一拒绝规则，保留业务事实的检查由各自调用方执行。 */
export function assertConversationSyncMaintenance(facts: ConversationSyncMaintenanceFacts): void {
  if (!facts.maintenanceMigrationPresent || facts.legacySyncEvents !== 0 || facts.archivedSyncEvents !== 0 || facts.currentNonV2Streams !== 0 || facts.retainedBudgetViolations !== 0) {
    throw new Error('候选数据库尚未完成当前同步事件回收规则，不能提升。');
  }
}
