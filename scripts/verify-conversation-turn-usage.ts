/** 轮次用量的定向检查，仅使用内存 SQLite，不访问业务数据或供应商。 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readConversationTurnUsage } from '../packages/storage/src/conversationExecutionStore.js';
import type { ZeusDatabasePort, SqlValue } from '../packages/storage/src/databasePort.js';
import { formatEstimatedCosts } from '../packages/shared/src/modelPricing.js';
import { formatRuntimeCosts, formatTokenCount } from '../apps/desktop/src/renderer/session/tokenUsageFormat.js';

// 紧凑正文保持币种、两位小数及正数小额事实，未知状态仍由正文组件处理。
assert.equal(formatTokenCount(126480, 'zh-CN').compact, '126K');
assert.equal(formatRuntimeCosts([{ currency: 'USD', amount: 23.931 }], 'zh-CN'), '~$23.93');
assert.equal(formatRuntimeCosts([{ currency: 'CNY', amount: 23.931 }], 'zh-CN'), '~¥23.93');
assert.equal(formatRuntimeCosts([{ currency: 'USD', amount: 0 }], 'en-US'), '~$0.00');
assert.equal(formatRuntimeCosts([{ currency: 'CNY', amount: 0.00001 }], 'zh-CN'), '~<¥0.01');
assert.equal(formatRuntimeCosts([{ currency: 'EUR', amount: 2.5 }], 'en-US'), '~EUR 2.50');

/** 内存表只包含读取投影所需字段，检查真实 SQL 的身份关联。 */
const sqlite = new DatabaseSync(':memory:');
try {
  sqlite.exec(`
    CREATE TABLE conversation_turns (id TEXT, conversation_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT);
    CREATE TABLE codex_usage_ledger (conversation_id TEXT, provider_thread_id TEXT, provider_turn_id TEXT, total_tokens INTEGER, input_tokens INTEGER, output_tokens INTEGER, usage_complete INTEGER, estimate_json TEXT);
    INSERT INTO conversation_turns VALUES ('local-a', 'conversation', 'thread', 'provider-a'), ('local-b', 'conversation', 'thread', 'provider-b');
    INSERT INTO codex_usage_ledger VALUES
      ('conversation', 'thread', 'provider-a', 1200, 1000, 200, 1, '{"apiEquivalentUsd":0.00001,"coverage":1}'),
      ('conversation', 'thread', 'provider-a', 300, 250, 50, 1, '{"costs":[{"currency":"CNY","amount":0.02}],"coverage":1}'),
      ('conversation', 'thread', 'provider-b', 900, 800, 100, 0, '{"apiEquivalentUsd":null,"coverage":null}'),
      ('other-conversation', 'thread', 'provider-a', 99999, 99990, 9, 1, '{"apiEquivalentUsd":99,"coverage":1}'),
      ('conversation', 'other-thread', 'provider-a', 99999, 99990, 9, 1, '{"apiEquivalentUsd":99,"coverage":1}');
  `);
  /** 只读端口直接执行被检查投影的 SQL。 */
  const db: Pick<ZeusDatabasePort, 'select'> = {
    /** 保留 SQLite 返回值，避免用预设结果替代真实关联。 */
    select: <T>(sql: string, params: SqlValue[] = []) => sqlite.prepare(sql).all(...params) as T[],
  };
  /** 本轮多币种只按币种求和，历史身份与实时身份必须一致。 */
  const usage = readConversationTurnUsage(db, 'conversation');
  assert.equal(usage['local-a'], usage['provider-a']);
  assert.equal(usage['local-a'].totalTokens, 1500);
  // 输入和输出与总量共用身份过滤，跨账本分别累加。
  assert.equal(usage['local-a'].inputTokens, 1250);
  assert.equal(usage['local-a'].outputTokens, 250);
  assert.equal(usage['local-a'].costComplete, true);
  assert.deepEqual(usage['local-a'].costs, [
    { currency: 'CNY', amount: 0.02 },
    { currency: 'USD', amount: 0.00001 },
  ]);
  assert.equal(formatEstimatedCosts(usage['local-a'].costs, null), 'CNY 0.02 + USD <0.0001');
  assert.equal(usage['local-b'].totalTokens, 900);
  assert.equal(usage['local-b'].usageComplete, false);
  assert.equal(usage['local-b'].costComplete, false);
  assert.deepEqual(usage['local-b'].costs, []);
  assert.deepEqual(readConversationTurnUsage(db, 'conversation'), usage);
  assert.deepEqual(Object.keys(readConversationTurnUsage(db, 'missing')), []);
  sqlite.exec(`UPDATE codex_usage_ledger SET total_tokens = 0, input_tokens = 0, output_tokens = 0, usage_complete = 1, estimate_json = '{"apiEquivalentUsd":0,"coverage":1}' WHERE provider_turn_id = 'provider-b'`);
  /** 零消耗与缺价不同，完整免费记录仍返回真实零值。 */
  const zero = readConversationTurnUsage(db, 'conversation')['local-b'];
  assert.equal(zero.totalTokens, 0);
  assert.deepEqual(zero.costs, [{ currency: 'USD', amount: 0 }]);
  assert.equal(zero.costComplete, true);
  console.log('轮次用量检查通过：身份隔离、历史与实时一致、多币种、小额、未知、零值和重复读取。');
} finally {
  sqlite.close();
}
