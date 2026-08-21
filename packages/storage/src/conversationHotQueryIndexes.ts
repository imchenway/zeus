export const CONVERSATION_HOT_QUERY_INDEX_MIGRATION_ID = '20260821_0001_conversation_hot_query_indexes';

export interface ConversationHotQueryIndexDefinition {
  name: string;
  table: string;
  columns: readonly string[];
  predicate: string | null;
  createSql: string;
  dropSql: string;
}

/**
 * ZARCH-010 会话首屏与恢复查询索引。
 *
 * 这些定义不会在既有数据库的普通启动路径执行。大库只能在隔离候选副本的维护边界显式应用；
 * 新建空库可直接安装，避免从第一条会话数据开始继续积累无索引历史。
 */
export const conversationHotQueryIndexes: readonly ConversationHotQueryIndexDefinition[] = [
  {
    name: 'idx_conversation_items_timeline',
    table: 'conversation_items',
    columns: ['conversation_id', 'updated_at', 'id'],
    predicate: null,
    createSql: 'CREATE INDEX IF NOT EXISTS idx_conversation_items_timeline ON conversation_items(conversation_id, updated_at, id)',
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_items_timeline',
  },
  {
    name: 'idx_conversation_items_completed_plan',
    table: 'conversation_items',
    columns: ['turn_id', 'updated_at DESC', 'id DESC'],
    predicate: "item_type = 'plan' AND status = 'completed'",
    createSql: "CREATE INDEX IF NOT EXISTS idx_conversation_items_completed_plan ON conversation_items(turn_id, updated_at DESC, id DESC) WHERE item_type = 'plan' AND status = 'completed'",
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_items_completed_plan',
  },
  {
    name: 'idx_conversation_turns_timeline',
    table: 'conversation_turns',
    columns: ['conversation_id', 'created_at', 'id'],
    predicate: null,
    createSql: 'CREATE INDEX IF NOT EXISTS idx_conversation_turns_timeline ON conversation_turns(conversation_id, created_at, id)',
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_turns_timeline',
  },
  {
    name: 'idx_conversation_turns_current',
    table: 'conversation_turns',
    columns: ['conversation_id', 'created_at DESC', 'id DESC'],
    predicate: "status IN ('running', 'dispatching', 'waiting')",
    createSql: "CREATE INDEX IF NOT EXISTS idx_conversation_turns_current ON conversation_turns(conversation_id, created_at DESC, id DESC) WHERE status IN ('running', 'dispatching', 'waiting')",
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_turns_current',
  },
  {
    name: 'idx_conversation_submissions_queue_head',
    table: 'conversation_submissions',
    columns: ['conversation_id', 'queue_position', 'created_at', 'id'],
    predicate: "status IN ('queued', 'paused')",
    createSql: "CREATE INDEX IF NOT EXISTS idx_conversation_submissions_queue_head ON conversation_submissions(conversation_id, queue_position, created_at, id) WHERE status IN ('queued', 'paused')",
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_submissions_queue_head',
  },
  {
    name: 'idx_conversation_resources_timeline',
    table: 'conversation_resources',
    columns: ['conversation_id', 'created_at', 'source_index', 'id'],
    predicate: null,
    createSql: 'CREATE INDEX IF NOT EXISTS idx_conversation_resources_timeline ON conversation_resources(conversation_id, created_at, source_index, id)',
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_resources_timeline',
  },
  {
    name: 'idx_conversation_persistent_warnings_open_timeline',
    table: 'conversation_persistent_warnings',
    columns: ['conversation_id', 'first_event_seq', 'id'],
    predicate: 'resolved_at IS NULL',
    createSql: 'CREATE INDEX IF NOT EXISTS idx_conversation_persistent_warnings_open_timeline ON conversation_persistent_warnings(conversation_id, first_event_seq, id) WHERE resolved_at IS NULL',
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_persistent_warnings_open_timeline',
  },
  {
    name: 'idx_conversation_config_evidence_timeline',
    table: 'conversation_config_evidence',
    columns: ['conversation_id', 'observed_at', 'id'],
    predicate: null,
    createSql: 'CREATE INDEX IF NOT EXISTS idx_conversation_config_evidence_timeline ON conversation_config_evidence(conversation_id, observed_at, id)',
    dropSql: 'DROP INDEX IF EXISTS idx_conversation_config_evidence_timeline',
  },
];

export const CONVERSATION_HOT_QUERY_INDEX_CHECKSUM_SOURCE = conversationHotQueryIndexes.map((definition) => `${definition.name}:${definition.createSql}`).join(';');

export interface ConversationQueryPlanDefinition {
  id: string;
  description: string;
  sql: string;
  params: readonly (string | number | null)[];
  expectedIndex: string | null;
  scannedTable: string;
  scanBudgetRows: number;
}

/** 首屏与恢复 SQL 的静态预算；验证器同时禁止临时排序和无索引目标表扫描。 */
export const conversationQueryPlanDefinitions: readonly ConversationQueryPlanDefinition[] = [
  {
    id: 'conversation-items-timeline',
    description: '会话旧 item 时间线',
    sql: 'SELECT * FROM conversation_items WHERE conversation_id = ? ORDER BY updated_at, id',
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_items_timeline',
    scannedTable: 'conversation_items',
    scanBudgetRows: 0,
  },
  {
    id: 'latest-completed-plan',
    description: '当前轮次最后一份有效计划',
    sql: "SELECT * FROM conversation_items WHERE turn_id = ? AND item_type = 'plan' AND status = 'completed' AND trim(text_content) <> '' ORDER BY updated_at DESC, id DESC LIMIT 1",
    params: ['turn-plan-check'],
    expectedIndex: 'idx_conversation_items_completed_plan',
    scannedTable: 'conversation_items',
    scanBudgetRows: 0,
  },
  {
    id: 'conversation-turns-timeline',
    description: '会话 turn 时间线',
    sql: 'SELECT * FROM conversation_turns WHERE conversation_id = ? ORDER BY created_at, id',
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_turns_timeline',
    scannedTable: 'conversation_turns',
    scanBudgetRows: 0,
  },
  {
    id: 'current-turn',
    description: '会话当前 turn',
    sql: "SELECT * FROM conversation_turns WHERE conversation_id = ? AND status IN ('running', 'dispatching', 'waiting') ORDER BY created_at DESC, id DESC LIMIT 1",
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_turns_current',
    scannedTable: 'conversation_turns',
    scanBudgetRows: 0,
  },
  {
    id: 'submission-queue-head',
    description: '会话队首 submission',
    sql: "SELECT * FROM conversation_submissions WHERE conversation_id = ? AND status IN ('queued', 'paused') ORDER BY queue_position, created_at, id LIMIT 1",
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_submissions_queue_head',
    scannedTable: 'conversation_submissions',
    scanBudgetRows: 0,
  },
  {
    id: 'conversation-resources-timeline',
    description: '会话资源时间线',
    sql: 'SELECT * FROM conversation_resources WHERE conversation_id = ? ORDER BY created_at, source_index, id',
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_resources_timeline',
    scannedTable: 'conversation_resources',
    scanBudgetRows: 0,
  },
  {
    id: 'open-persistent-warnings',
    description: '未解决持久警告',
    sql: 'SELECT * FROM conversation_persistent_warnings WHERE conversation_id = ? AND resolved_at IS NULL ORDER BY first_event_seq, id',
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_persistent_warnings_open_timeline',
    scannedTable: 'conversation_persistent_warnings',
    scanBudgetRows: 0,
  },
  {
    id: 'configuration-evidence',
    description: '配置证据时间线',
    sql: 'SELECT * FROM conversation_config_evidence WHERE conversation_id = ? ORDER BY observed_at, id',
    params: ['conversation-plan-check'],
    expectedIndex: 'idx_conversation_config_evidence_timeline',
    scannedTable: 'conversation_config_evidence',
    scanBudgetRows: 0,
  },
  {
    id: 'model-history',
    description: '确认后的模型历史',
    sql: 'SELECT * FROM conversation_model_history WHERE conversation_id = ? ORDER BY sequence',
    params: ['conversation-plan-check'],
    expectedIndex: null,
    scannedTable: 'conversation_model_history',
    scanBudgetRows: 0,
  },
  {
    id: 'process-items',
    description: '处理过程时间线',
    sql: 'SELECT * FROM conversation_process_items WHERE conversation_id = ? ORDER BY process_sequence',
    params: ['conversation-plan-check'],
    expectedIndex: null,
    scannedTable: 'conversation_process_items',
    scanBudgetRows: 0,
  },
  {
    id: 'model-requests',
    description: '模型请求时间线',
    sql: 'SELECT * FROM conversation_model_requests WHERE conversation_id = ? ORDER BY request_sequence',
    params: ['conversation-plan-check'],
    expectedIndex: null,
    scannedTable: 'conversation_model_requests',
    scanBudgetRows: 0,
  },
];
