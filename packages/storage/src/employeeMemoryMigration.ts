import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

/** 员工经验沿用长期记忆的来源、纠正与失效机制，仅扩展作用范围。 */
export function migrateEmployeeMemorySchema(db: ZeusDatabasePort): void {
  /** 员工范围迁移独立于旧记忆结构账本。 */
  const migrationId = '20260910_employee_memory_scope';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    /** 自引用的纠正关系在重建期间延迟核对。 */
    db.execute('PRAGMA defer_foreign_keys = ON');
    /** 保留全部旧约束，只拓展范围和稳定知识类别。 */
    const schema = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'long_term_memories'")!;
    /** 原索引在重建后恢复。 */
    const indexes = db.select<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'long_term_memories' AND sql IS NOT NULL");
    db.execute(
      schema.sql
        .replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?long_term_memories/i, 'CREATE TABLE employee_memories_migration')
        .replace("scope_kind IN ('global', 'project')", "scope_kind IN ('global', 'project', 'employee')")
        .replace("scope_kind = 'project' AND", "scope_kind IN ('project', 'employee') AND")
        .replace("memory_kind IN ('preference', 'safety_boundary', 'stable_workflow')", "memory_kind IN ('preference', 'safety_boundary', 'stable_workflow', 'domain_knowledge')"),
    );
    db.execute('INSERT INTO employee_memories_migration SELECT * FROM long_term_memories');
    db.execute('DROP TABLE long_term_memories');
    db.execute('ALTER TABLE employee_memories_migration RENAME TO long_term_memories');
    for (const index of indexes) db.execute(index.sql);
    if (db.select('PRAGMA foreign_key_check').length) throw new Error('员工记忆迁移外键检查失败。');
    db.execute('PRAGMA defer_foreign_keys = OFF');
    db.execute('ALTER TABLE digital_employees ADD COLUMN memory_enabled INTEGER NOT NULL DEFAULT 1');
    db.execute('INSERT INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES(?, ?, ?, ?)', [
      migrationId,
      '员工独立经验范围及读取偏好',
      createHash('sha256').update(migrationId).digest('hex'),
      new Date().toISOString(),
    ]);
  });
}
