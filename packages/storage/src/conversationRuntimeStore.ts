import type { ZeusDatabasePort } from './databasePort.js';

/** 工具进程归属持久化，进程与日志仍由已有 Runtime 管理。 */
export interface ConversationToolProcessRecord {
  processId: string;
  conversationId: string;
  turnId: string;
  requestHash: string;
  permission: string;
}

/** 目标控制权和用量完整性，避免切换时两条执行链同时自动推进。 */
export interface ConversationGoalControlRecord {
  /** 稳定产品会话。 */
  conversationId: string;
  /** handoff 表示旧控制器已停止、新控制器尚未接管。 */
  source: 'codex' | 'pi' | 'handoff';
  /** 已确认绑定的原生会话。 */
  nativeSessionId: string;
  /** 切换前目标是否需要继续运行。 */
  resumeAfterSwitch: boolean;
  /** 没有真实用量时不能展示精确预算。 */
  usageComplete: boolean;
  /** 最后已计费用量的轮次，重复事件不重复累加。 */
  accountedTurnId: string | null;
  /** 换到新原生线程前已知的真实累计量，不重复计入新线程回报。 */
  nativeTokensOffset?: number;
  /** 同上，保留切换前真实耗时。 */
  nativeTimeOffset?: number;
  /** 产品目标总预算；新线程只接收剩余额度。 */
  totalTokenBudget?: number | null;
}

/** 子代理只记录归属和继承上限，运行状态与结果仍读取普通会话。 */
export interface ConversationSubagentRecord {
  /** 稳定子会话身份，也是工具返回的代理身份。 */
  conversationId: string;
  /** 直接父会话。 */
  parentId: string;
  /** 整棵树的根，用于限制并行数量。 */
  rootId: string;
  /** 最多两层派生。 */
  depth: number;
  /** 创建请求摘要，重复请求不得改变任务。 */
  requestHash: string;
  /** 父轮次冻结的权限上限。 */
  permissionMode: string;
  /** 父轮次冻结的上下文，恢复时不重新猜测。 */
  contextJson: string;
}

/** 幂等建立归属表，不改变已有进程和会话数据。 */
export function migrateConversationRuntimeSchema(db: ZeusDatabasePort): void {
  db.execute(`CREATE TABLE IF NOT EXISTS conversation_tool_processes (process_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, turn_id TEXT NOT NULL, request_hash TEXT NOT NULL, permission TEXT NOT NULL)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_tool_processes_owner ON conversation_tool_processes(conversation_id)`);
  db.execute(`CREATE TABLE IF NOT EXISTS conversation_subagents (conversation_id TEXT PRIMARY KEY, parent_id TEXT NOT NULL, root_id TEXT NOT NULL, state_json TEXT NOT NULL)`);
  db.execute(`CREATE INDEX IF NOT EXISTS idx_conversation_subagents_root ON conversation_subagents(root_id)`);
  db.execute(`CREATE TABLE IF NOT EXISTS conversation_goal_control (conversation_id TEXT PRIMARY KEY, state_json TEXT NOT NULL)`);
}

/** 只保存工具调用归属，不复制 Runtime 的状态机或日志。 */
export class ConversationRuntimeRepository {
  /** 使用宿主同一数据库，保证写前归属可以持久提交。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 创建前先保留归属，宿主重启后未知发送结果不另建代理。 */
  bindSubagent(record: ConversationSubagentRecord): void {
    this.db.execute('INSERT INTO conversation_subagents(conversation_id, parent_id, root_id, state_json) VALUES (?, ?, ?, ?)', [record.conversationId, record.parentId, record.rootId, JSON.stringify(record)]);
  }

  /** 精确身份读取，不按名称猜测归属。 */
  getSubagent(conversationId: string): ConversationSubagentRecord | undefined {
    const row = this.db.get<{ state: string }>('SELECT state_json AS state FROM conversation_subagents WHERE conversation_id = ?', [conversationId]);
    return row ? (JSON.parse(row.state) as ConversationSubagentRecord) : undefined;
  }

  /** 同一根会话的全部子代理包含已完成结果，不删除历史。 */
  listSubagents(rootId: string): ConversationSubagentRecord[] {
    return this.db.select<{ state: string }>('SELECT state_json AS state FROM conversation_subagents WHERE root_id = ?', [rootId]).map((row) => JSON.parse(row.state) as ConversationSubagentRecord);
  }

  /** 缺少记录的历史目标仍由原生 Provider 控制。 */
  getGoalControl(conversationId: string): ConversationGoalControlRecord | undefined {
    const row = this.db.get<{ state: string }>('SELECT state_json AS state FROM conversation_goal_control WHERE conversation_id = ?', [conversationId]);
    return row ? (JSON.parse(row.state) as ConversationGoalControlRecord) : undefined;
  }

  /** 与已有目标、提交在同一事务中更新控制权。 */
  setGoalControl(control: ConversationGoalControlRecord): void {
    this.db.execute('INSERT INTO conversation_goal_control(conversation_id, state_json) VALUES (?, ?) ON CONFLICT(conversation_id) DO UPDATE SET state_json = excluded.state_json', [control.conversationId, JSON.stringify(control)]);
  }

  /** 读取稳定进程身份，重复请求不得另起进程。 */
  getProcess(processId: string): ConversationToolProcessRecord | undefined {
    return this.db.get<ConversationToolProcessRecord>(`SELECT process_id AS processId, conversation_id AS conversationId, turn_id AS turnId, request_hash AS requestHash, permission FROM conversation_tool_processes WHERE process_id = ?`, [
      processId,
    ]);
  }

  /** 在任何 spawn 之前写入，重复身份只能对应同一操作。 */
  bindProcess(input: ConversationToolProcessRecord): void {
    this.db.execute(`INSERT INTO conversation_tool_processes(process_id, conversation_id, turn_id, request_hash, permission) VALUES (?, ?, ?, ?, ?)`, [
      input.processId,
      input.conversationId,
      input.turnId,
      input.requestHash,
      input.permission,
    ]);
  }

  /** 停止或归档时只处理本会话拥有的进程。 */
  listProcesses(conversationId: string): ConversationToolProcessRecord[] {
    return this.db.select<ConversationToolProcessRecord>(
      `SELECT process_id AS processId, conversation_id AS conversationId, turn_id AS turnId, request_hash AS requestHash, permission FROM conversation_tool_processes WHERE conversation_id = ?`,
      [conversationId],
    );
  }
}
