import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

export const digitalEmployeeStageHandoffMigrationId = '20260828_0373_digital_employee_stage_handoff_v1';

/**
 * ZEUS-0373 只做前向加列；既有数字员工和阶段迁移的 checksum 必须保持不变。
 * 旧执行通过默认值明确保留为单会话模式，不凭空补造阶段、员工快照或交付物。
 */
export function migrateDigitalEmployeeStageHandoffSchema(db: ZeusDatabasePort): void {
  const checksumSource = [
    'task_stages:employee_mode,employee_id',
    'task_stage_attempts:work_execution_id,employee_id,employee_revision,employee_snapshot_json,skill_id,effective_permissions_json',
    'digital_employee_executions:execution_mode,workflow_id,current_stage_id,revision,finalized_at',
    'legacy-executions-remain-single-conversation',
  ].join(';');
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;

  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [digitalEmployeeStageHandoffMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('数字员工阶段接力迁移账本与当前结构不一致。');

    addColumn(db, 'task_stages', 'employee_mode', `TEXT NOT NULL DEFAULT 'none' CHECK (employee_mode IN ('none', 'inherit', 'explicit'))`);
    addColumn(db, 'task_stages', 'employee_id', 'TEXT');

    addColumn(db, 'task_stage_attempts', 'work_execution_id', 'TEXT');
    addColumn(db, 'task_stage_attempts', 'employee_id', 'TEXT');
    addColumn(db, 'task_stage_attempts', 'employee_revision', 'INTEGER');
    addColumn(db, 'task_stage_attempts', 'employee_snapshot_json', 'TEXT');
    addColumn(db, 'task_stage_attempts', 'skill_id', 'TEXT');
    addColumn(db, 'task_stage_attempts', 'effective_permissions_json', 'TEXT');

    addColumn(db, 'digital_employee_executions', 'execution_mode', `TEXT NOT NULL DEFAULT 'legacy_single_conversation' CHECK (execution_mode IN ('legacy_single_conversation', 'staged'))`);
    addColumn(db, 'digital_employee_executions', 'workflow_id', 'TEXT');
    addColumn(db, 'digital_employee_executions', 'current_stage_id', 'TEXT');
    addColumn(db, 'digital_employee_executions', 'revision', 'INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)');
    addColumn(db, 'digital_employee_executions', 'finalized_at', 'TEXT');

    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_stages_employee ON task_stages(employee_id, status, updated_at)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_task_stage_attempts_execution ON task_stage_attempts(work_execution_id, attempt_number)`);
    db.execute(`CREATE INDEX IF NOT EXISTS idx_digital_employee_execution_workflow ON digital_employee_executions(workflow_id, current_stage_id, updated_at)`);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      digitalEmployeeStageHandoffMigrationId,
      '增加数字员工阶段指派、执行快照与人工接力工作执行字段',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

function addColumn(db: ZeusDatabasePort, table: string, column: string, definition: string): void {
  const exists = db.select<{ name: string }>(`PRAGMA table_info(${table})`).some((row) => row.name === column);
  if (!exists) db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
