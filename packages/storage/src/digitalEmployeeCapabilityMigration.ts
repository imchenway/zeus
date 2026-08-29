import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';

export const digitalEmployeeCapabilityMigrationId = '20260829_0002_digital_employee_capability_v2';

/**
 * v2 主入口只写入项目数字员工；旧执行快照与内置模板原样保留。
 * 同时存在 Agent 配置和部署命令的旧员工必须由管理者选择主入口。
 */
export function migrateDigitalEmployeeCapabilitySchema(db: ZeusDatabasePort): void {
  const checksumSource = 'digital_employees:entrypoint_kind,entrypoint_migration_state,model_policy_json,skill_policy_json,authority_policy_json,command_id:v2';
  const checksum = `sha256:${createHash('sha256').update(checksumSource).digest('hex')}`;
  db.transaction(() => {
    const existing = db.get<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE migration_id = ?`, [digitalEmployeeCapabilityMigrationId]);
    if (existing && existing.checksum !== checksum) throw new Error('数字员工能力配置 v2 迁移账本与当前定义不一致。');
    addColumn(db, 'digital_employees', 'entrypoint_kind', 'TEXT');
    addColumn(db, 'digital_employees', 'entrypoint_migration_state', `TEXT NOT NULL DEFAULT 'ready'`);
    addColumn(db, 'digital_employees', 'model_policy_json', `TEXT NOT NULL DEFAULT '{}'`);
    addColumn(db, 'digital_employees', 'skill_policy_json', `TEXT NOT NULL DEFAULT '{}'`);
    addColumn(db, 'digital_employees', 'authority_policy_json', `TEXT NOT NULL DEFAULT '{}'`);
    addColumn(db, 'digital_employees', 'command_id', 'TEXT');

    db.execute(`
      UPDATE digital_employees
      SET entrypoint_kind = CASE WHEN deploy_command_id IS NOT NULL THEN NULL ELSE 'agent' END,
          entrypoint_migration_state = CASE WHEN deploy_command_id IS NOT NULL THEN 'requires_selection' ELSE 'ready' END,
          command_id = deploy_command_id,
          model_policy_json = json_object(
            'defaultMode', CASE WHEN model IS NULL OR trim(model) = '' THEN 'project' ELSE 'explicit' END,
            'defaultModel', model,
            'allowedModels', CASE WHEN model IS NULL OR trim(model) = '' THEN json('[]') ELSE json_array(model) END,
            'allowedReasoningEfforts', CASE WHEN reasoning_effort IS NULL OR trim(reasoning_effort) = '' THEN json('[]') ELSE json_array(reasoning_effort) END,
            'allowedServiceTiers', CASE WHEN service_tier IS NULL OR trim(service_tier) = '' THEN json('[]') ELSE json_array(service_tier) END
          ),
          skill_policy_json = json_object('allowedSkillIds', json(skill_ids_json)),
          authority_policy_json = json_object(
            'permissionMode', permission_mode,
            'allowCodeChanges', json(CASE WHEN allow_code_changes = 1 THEN 'true' ELSE 'false' END),
            'allowTests', json(CASE WHEN allow_tests = 1 THEN 'true' ELSE 'false' END),
            'allowCommit', json(CASE WHEN allow_commit = 1 THEN 'true' ELSE 'false' END),
            'allowPush', json(CASE WHEN allow_push = 1 THEN 'true' ELSE 'false' END),
            'allowMerge', json(CASE WHEN allow_merge = 1 THEN 'true' ELSE 'false' END),
            'allowDeploy', json(CASE WHEN allow_deploy = 1 THEN 'true' ELSE 'false' END),
            'allowComplete', json(CASE WHEN allow_complete = 1 THEN 'true' ELSE 'false' END)
          )
      WHERE entrypoint_kind IS NULL AND entrypoint_migration_state = 'ready'
    `);
    db.execute(`INSERT OR IGNORE INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)`, [
      digitalEmployeeCapabilityMigrationId,
      '新增数字员工 Agent/Command 主入口与版本化模型、Skill、权限策略',
      checksum,
      new Date().toISOString(),
    ]);
  });
}

function addColumn(db: ZeusDatabasePort, table: string, column: string, definition: string): void {
  const columns = db.select<{ name: string }>(`PRAGMA table_info(${table})`);
  if (!columns.some((candidate) => candidate.name === column)) db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
