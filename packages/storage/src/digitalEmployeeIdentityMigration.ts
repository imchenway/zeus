import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

/** 员工身份与项目差异使用独立迁移账本，不重写历史执行快照。 */
const employeeIdentityMigrationId = '20261005_digital_employee_identity';

/** 将历史项目有效配置冻结成显式覆盖，只关联确实存在的已创建全局员工。 */
export function migrateDigitalEmployeeIdentity(db: ZeusDatabasePort): void {
  /** 结构与迁移规则的固定签名。 */
  const checksum = `sha256:${createHash('sha256').update('employee_identity:global_reference,explicit_project_overrides,project_instructions,global_defaults').digest('hex')}`;
  db.transaction(() => {
    /** 重复启动只验证账本，不再次覆盖用户配置。 */
    const previous = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [employeeIdentityMigrationId]);
    if (previous) {
      if (previous.checksum !== checksum) throw new Error('数字员工身份迁移账本与当前定义不一致。');
      return;
    }
    addIdentityColumn(db, 'digital_employee_templates', 'base_configuration_json', "TEXT NOT NULL DEFAULT '{}'");
    addIdentityColumn(db, 'digital_employees', 'global_employee_id', 'TEXT');
    addIdentityColumn(db, 'digital_employees', 'project_overrides_json', "TEXT NOT NULL DEFAULT '{}'");
    addIdentityColumn(db, 'digital_employees', 'project_instructions', "TEXT NOT NULL DEFAULT ''");
    /** 旧库已经关闭经验读取时保留该偏好，新库默认开启。 */
    const memoryExpression = db.select<{ name: string }>('PRAGMA table_info(digital_employees)').some((column) => column.name === 'memory_enabled') ? 'memory_enabled' : '1';
    db.execute(`UPDATE digital_employees SET
      global_employee_id = (SELECT id FROM digital_employee_templates WHERE id = digital_employees.template_id AND built_in = 0 AND deleted_at IS NULL),
      project_overrides_json = json_object(
        'name', name, 'description', description, 'role', role, 'domain', domain, 'avatarId', avatar_id,
        'skillIds', json(skill_ids_json), 'prompt', prompt, 'agentKind', agent_kind, 'model', model,
        'reasoningEffort', reasoning_effort, 'serviceTier', service_tier, 'permissionMode', permission_mode,
        'workMode', work_mode, 'memoryEnabled', json(CASE WHEN ${memoryExpression} = 1 THEN 'true' ELSE 'false' END), 'allowCodeChanges', json(CASE WHEN allow_code_changes = 1 THEN 'true' ELSE 'false' END),
        'allowTests', json(CASE WHEN allow_tests = 1 THEN 'true' ELSE 'false' END),
        'deliveryGrants', json_object('allowCommit', json(CASE WHEN allow_commit = 1 THEN 'true' ELSE 'false' END),
          'allowPush', json(CASE WHEN allow_push = 1 THEN 'true' ELSE 'false' END),
          'allowMerge', json(CASE WHEN allow_merge = 1 THEN 'true' ELSE 'false' END),
          'allowDeploy', json(CASE WHEN allow_deploy = 1 THEN 'true' ELSE 'false' END),
          'allowComplete', json(CASE WHEN allow_complete = 1 THEN 'true' ELSE 'false' END)))`);
    db.execute('CREATE INDEX IF NOT EXISTS idx_digital_employees_global_identity ON digital_employees(global_employee_id, project_id, deleted_at)');
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      employeeIdentityMigrationId,
      '保留历史项目绑定身份并显式保存项目覆盖，区分模板与全局员工',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

/** 扩展已存在的数据表，保留历史字段与记录身份。 */
function addIdentityColumn(db: ZeusDatabasePort, table: string, column: string, definition: string): void {
  /** SQLite 表结构中已登记的字段。 */
  const columns = db.select<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((entry) => entry.name === column)) db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
