import type { ZeusDatabasePort } from './databasePort.js';
import { readConversationLegacyCutoverReceipt, type ConversationLegacyCutoverReceipt } from './conversationLegacyCutover.js';

export const conversationLegacyReconciliationGeneration = '2026-08-21-conversation-items-reconciliation-v1';

export type ConversationLegacyCoverageKind = 'process_source_identity' | 'model_tool_pair_identity' | 'model_reasoning_identity' | 'migration_source_identity' | 'missing_stable_identity';

export interface ConversationLegacyTypeReconciliation {
  itemType: string;
  legacyRows: number;
  coveredRows: number;
  uncoveredRows: number;
  coverageKinds: ConversationLegacyCoverageKind[];
  cutoverBlocker: boolean;
}

export interface ConversationLegacyReconciliationReport {
  schemaVersion: 1;
  generation: typeof conversationLegacyReconciliationGeneration;
  scope: { conversationId: string | null };
  legacy: {
    totalRows: number;
    completedRows: number;
    inProgressRows: number;
    failedRows: number;
  };
  unified: {
    timelineRows: number;
    modelHistoryRows: number;
    processRows: number;
  };
  byItemType: ConversationLegacyTypeReconciliation[];
  exactIdentityCoverage: {
    coveredRows: number;
    uncoveredRows: number;
    ratio: number;
  };
  cutover: ConversationLegacyCutoverReceipt | null;
  eligibility: {
    transcriptReadCutover: boolean;
    legacyWriteFence: boolean;
    reasons: string[];
  };
}

interface LegacyTypeCountRow {
  item_type: string;
  row_count: number;
  completed_count: number;
  in_progress_count: number;
  failed_count: number;
}

interface CountRow {
  row_count: number;
}

const processIdentityTypes = new Set(['reasoning', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'imageView', 'imageGeneration', 'webSearch', 'contextCompaction', 'error']);

const toolPairIdentityTypes = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'imageGeneration', 'webSearch']);

/**
 * 只读核对旧 conversation_items 与统一会话表的稳定身份覆盖率。
 *
 * 该报告故意不以正文相等、时间戳接近或行数接近冒充完成迁移：旧 userMessage、
 * agentMessage 等记录没有进入统一表的稳定 source identity 时，必须继续作为关闸阻塞项。
 */
export class ConversationLegacyReconciliationRepository {
  constructor(private readonly db: ZeusDatabasePort) {}

  read(conversationIdValue?: string | null): ConversationLegacyReconciliationReport {
    const conversationId = normalizeOptionalIdentity(conversationIdValue);
    const scope = conversationId ? ' WHERE legacy.conversation_id = ?' : '';
    const params = conversationId ? [conversationId] : [];
    const typeRows = this.db.select<LegacyTypeCountRow>(
      `SELECT legacy.item_type,
              COUNT(*) AS row_count,
              SUM(CASE WHEN legacy.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
              SUM(CASE WHEN legacy.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress_count,
              SUM(CASE WHEN legacy.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
         FROM conversation_items AS legacy${scope}
        GROUP BY legacy.item_type
        ORDER BY legacy.item_type`,
      params,
    );
    const byItemType = typeRows.map((row) => this.reconcileType(row, conversationId));
    const totalRows = sum(typeRows.map((row) => row.row_count));
    const coveredRows = sum(byItemType.map((row) => row.coveredRows));
    const uncoveredRows = totalRows - coveredRows;
    const cutover = readConversationLegacyCutoverReceipt(this.db);
    const transcriptReadCutover = uncoveredRows === 0 && cutover?.sourceRows === totalRows;
    const reasons: string[] = [];
    if (uncoveredRows > 0) reasons.push(`仍有 ${uncoveredRows} 条旧项目缺少可证明的统一表稳定身份。`);
    if (byItemType.some((row) => row.coverageKinds.includes('missing_stable_identity'))) {
      reasons.push('旧消息类记录尚无 Provider item identity 到统一模型历史的持久映射，不能用正文猜测对账。');
    }
    if (!cutover) reasons.push('候选库尚无完整切换回执、回退库身份或已关闭写入围栏。');
    if (cutover && cutover.sourceRows !== totalRows) reasons.push(`切换回执记录 ${cutover.sourceRows} 条，但当前旧表有 ${totalRows} 条。`);

    return {
      schemaVersion: 1,
      generation: conversationLegacyReconciliationGeneration,
      scope: { conversationId },
      legacy: {
        totalRows,
        completedRows: sum(typeRows.map((row) => row.completed_count)),
        inProgressRows: sum(typeRows.map((row) => row.in_progress_count)),
        failedRows: sum(typeRows.map((row) => row.failed_count)),
      },
      unified: {
        timelineRows: this.countUnified('conversation_timeline_events', conversationId),
        modelHistoryRows: this.countUnified('conversation_model_history', conversationId),
        processRows: this.countUnified('conversation_process_items', conversationId),
      },
      byItemType,
      exactIdentityCoverage: {
        coveredRows,
        uncoveredRows,
        ratio: totalRows === 0 ? 1 : coveredRows / totalRows,
      },
      cutover,
      eligibility: {
        transcriptReadCutover,
        legacyWriteFence: cutover?.legacyWriteFenceClosed === true,
        reasons,
      },
    };
  }

  private reconcileType(row: LegacyTypeCountRow, conversationId: string | null): ConversationLegacyTypeReconciliation {
    const coverageKinds: ConversationLegacyCoverageKind[] = [];
    const clauses: string[] = [];
    const params: Array<string> = [row.item_type];
    const conversationScope = conversationId ? ' AND legacy.conversation_id = ?' : '';
    if (conversationId) params.push(conversationId);

    if (processIdentityTypes.has(row.item_type)) {
      coverageKinds.push('process_source_identity', 'migration_source_identity');
      clauses.push(`EXISTS (
        SELECT 1
          FROM conversation_process_items AS process
         WHERE process.conversation_id = legacy.conversation_id
           AND (
             process.source_event_id = 'codex:item:' || legacy.provider_item_id
             OR process.source_event_id = 'pi:item:' || legacy.provider_item_id
             OR process.source_event_id = 'migration:item:' || legacy.id
             OR (json_valid(process.detail_json) AND json_extract(process.detail_json, '$.migratedFromItemId') = legacy.id)
           )
      )`);
    }
    if (toolPairIdentityTypes.has(row.item_type)) {
      coverageKinds.push('model_tool_pair_identity');
      clauses.push(`EXISTS (
        SELECT 1
          FROM conversation_model_history AS history
         WHERE history.conversation_id = legacy.conversation_id
           AND history.tool_pair_id = legacy.provider_item_id
      )`);
    }
    if (row.item_type === 'reasoning') {
      coverageKinds.push('model_reasoning_identity');
      clauses.push(`EXISTS (
        SELECT 1
          FROM conversation_model_history AS history
         WHERE history.conversation_id = legacy.conversation_id
           AND json_valid(history.reasoning_source_json)
           AND (
             json_extract(history.reasoning_source_json, '$.itemId') = legacy.provider_item_id
             OR json_extract(history.reasoning_source_json, '$.providerItemId') = legacy.provider_item_id
           )
      )`);
    }
    clauses.push(`EXISTS (
      SELECT 1
        FROM conversation_migration_mappings AS mapping
       WHERE mapping.conversation_id = legacy.conversation_id
         AND mapping.source_kind = 'conversation_item'
         AND mapping.source_identity = legacy.id
    )`);
    coverageKinds.push('migration_source_identity');

    if (clauses.length === 1) coverageKinds.push('missing_stable_identity');
    const coveredRows =
      this.db.get<CountRow>(
        `SELECT COUNT(*) AS row_count
         FROM conversation_items AS legacy
        WHERE legacy.item_type = ?${conversationScope}
          AND (${clauses.join(' OR ')})`,
        params,
      )?.row_count ?? 0;

    return {
      itemType: row.item_type,
      legacyRows: row.row_count,
      coveredRows,
      uncoveredRows: row.row_count - coveredRows,
      coverageKinds: [...new Set(coverageKinds)],
      cutoverBlocker: coveredRows !== row.row_count,
    };
  }

  private countUnified(table: 'conversation_timeline_events' | 'conversation_model_history' | 'conversation_process_items', conversationId: string | null): number {
    return conversationId
      ? (this.db.get<CountRow>(`SELECT COUNT(*) AS row_count FROM ${table} WHERE conversation_id = ?`, [conversationId])?.row_count ?? 0)
      : (this.db.get<CountRow>(`SELECT COUNT(*) AS row_count FROM ${table}`)?.row_count ?? 0);
  }
}

function normalizeOptionalIdentity(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 512) throw new Error('conversationId 必须是 1 到 512 个字符。');
  return normalized;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
