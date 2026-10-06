import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { migrateDigitalTeamProjectEmployeeReferences } from './digitalTeamWorkflowStore.js';
import { migrateAutomationProjectEmployeeReferences } from './automationEmployeeMigration.js';

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

/** 旧项目身份自动成为正式员工，迁移过程不要求用户重新配置。 */
export const digitalEmployeeGlobalIdentityMigrationId = '20261006_digital_employee_global_identity';

/** 迁移只处理身份与提示词，历史执行偏好继续留在原列。 */
interface LegacyEmployeeIdentityRow {
  id: string;
  name: string;
  description: string;
  role: string;
  domain: string;
  avatar_id: string | null;
  prompt: string;
  base_configuration_json?: string;
  built_in?: number;
  deleted_at: string | null;
}

/** 原项目绑定持有项目要求、经验偏好和所有历史工作引用。 */
interface LegacyProjectIdentityRow extends LegacyEmployeeIdentityRow {
  project_id: string;
  template_id: string | null;
  global_employee_id: string | null;
  project_overrides_json: string;
  memory_enabled: number;
}

/** 已存在的项目有效身份无损迁移，禁止按姓名合并或改写冻结执行。 */
export function migrateDigitalEmployeeGlobalIdentity(db: ZeusDatabasePort): void {
  /** 独立账本不改变旧身份迁移已经保存的校验和。 */
  const checksum = `sha256:${createHash('sha256').update('employee_global_identity:preserve_binding,promote_effective_identity,freeze_existing_memory_ids,retain_template_source,pin_project_workflow_and_automation_references').digest('hex')}`;
  db.transaction(() => {
    /** 重复启动不能再生成员工，也不能恢复已删除的身份。 */
    const previous = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE migration_id = ?', [digitalEmployeeGlobalIdentityMigrationId]);
    if (previous) {
      if (previous.checksum !== checksum) throw new Error('数字员工自动身份迁移账本与当前定义不一致。');
      return;
    }
    addIdentityColumn(db, 'digital_employees', 'migrated_memory_global_id', 'TEXT');
    addIdentityColumn(db, 'digital_employees', 'migrated_memory_ids_json', "TEXT NOT NULL DEFAULT '[]'");
    /** 软删除绑定不参加迁移；停用员工仍保持停用状态。 */
    const bindings = db.select<LegacyProjectIdentityRow>('SELECT * FROM digital_employees WHERE deleted_at IS NULL ORDER BY id');
    /** 冻结原先按全局身份命中的绑定，避免逐个迁出后把重复绑定误当成原执行人。 */
    const referencedBindings = new Map<string, string>();
    for (const binding of bindings) {
      if (!binding.global_employee_id) continue;
      /** 与原仓储的稳定身份查找使用同一项目和排序。 */
      const selected = db.get<{ id: string }>('SELECT id FROM digital_employees WHERE project_id=? AND global_employee_id=? AND deleted_at IS NULL ORDER BY created_at LIMIT 1', [binding.project_id, binding.global_employee_id]);
      if (selected) referencedBindings.set(`${binding.project_id}\0${binding.global_employee_id}`, selected.id);
    }
    /** 一次迁移内统一记录创建时间。 */
    const timestamp = new Date().toISOString();
    for (const binding of bindings) {
      /** 来源必须按稳定身份匹配，模板和已删除员工不作为当前正式员工。 */
      const sourceId = binding.global_employee_id ?? binding.template_id;
      /** 缺少全局引用时，旧 templateId 仍可指向用户创建的员工。 */
      const source = sourceId ? db.get<LegacyEmployeeIdentityRow>('SELECT * FROM digital_employee_templates WHERE id = ? AND built_in = 0 AND deleted_at IS NULL', [sourceId]) : undefined;
      /** 原覆盖记录保留的是升级前已经生效的身份。 */
      const overrides = parseLegacyIdentityObject(binding.project_overrides_json);
      /** 经验偏好属于项目；缺少覆盖时才继承来源默认。 */
      const sourceDefaults = parseLegacyIdentityObject(source?.base_configuration_json ?? '{}');
      /** 只迁移当前真实有效的身份，不将项目追加要求重复拼入通用提示词。 */
      const identity = Object.fromEntries(
        ['name', 'description', 'role', 'domain', 'avatarId', 'prompt'].map((key) => {
          /** 历史数据库字段与公开身份字段的对应关系。 */
          const column = key === 'avatarId' ? 'avatar_id' : (key as 'name' | 'description' | 'role' | 'domain' | 'prompt');
          return [key, Object.hasOwn(overrides, key) ? overrides[key] : (source ?? binding)[column]];
        }),
      ) as { name: string; description: string; role: string; domain: string; avatarId: string | null; prompt: string };
      /** 未关闭的旧经验偏好必须继续有效，关闭偏好也不能在升级中被重开。 */
      const memoryEnabled = typeof overrides.memoryEnabled === 'boolean' ? overrides.memoryEnabled : source ? sourceDefaults.memoryEnabled !== false : binding.memory_enabled !== 0;
      /** 只有明确同一来源且全部有效身份一致才继续共用全局员工。 */
      const matchesSource =
        source &&
        identity.name === source.name &&
        identity.description === source.description &&
        identity.role === source.role &&
        identity.domain === source.domain &&
        identity.avatarId === source.avatar_id &&
        identity.prompt === source.prompt;
      /** 独立身份从绑定 ID 派生，完全不使用姓名做去重。 */
      const globalId = matchesSource ? source.id : `digital_employee_global_${createHash('sha256').update(binding.id).digest('hex').slice(0, 24)}`;
      if (!matchesSource) {
        if (source) {
          /** 普通旧全局引用沿用原命中绑定，自动化的明确来源则可以指向同项目另一旧绑定。 */
          const isDefaultBinding = referencedBindings.get(`${binding.project_id}\0${source.id}`) === binding.id;
          migrateAutomationProjectEmployeeReferences(db, { projectId: binding.project_id, globalEmployeeId: source.id, employeeId: binding.id, isDefaultBinding }, timestamp);
          if (isDefaultBinding) migrateDigitalTeamProjectEmployeeReferences(db, { projectId: binding.project_id, globalEmployeeId: source.id, employeeId: binding.id }, timestamp);
        }
        if (db.get('SELECT id FROM digital_employee_templates WHERE id = ?', [globalId])) throw new Error('旧项目员工对应的全局身份已存在，拒绝覆盖或恢复该记录。');
        db.execute(
          `INSERT INTO digital_employee_templates
            (id,name,description,role,domain,avatar_id,skill_ids_json,prompt,agent_kind,model,reasoning_effort,service_tier,permission_mode,work_mode,built_in,revision,created_at,updated_at,base_configuration_json)
           VALUES (?,?,?,?,?,?,'[]',?,'codex',NULL,NULL,NULL,'read-only','default',0,0,?,?,?)`,
          [globalId, identity.name, identity.description, identity.role, identity.domain, identity.avatarId, identity.prompt, timestamp, timestamp, JSON.stringify({ memoryEnabled })],
        );
        /** 只冻结迁移时已有的原员工有效经验，不订阅该来源未来新增或纠正的内容。 */
        const memoryIds = source
          ? db
              .select<{ id: string }>(
                `SELECT memory.id FROM long_term_memories memory WHERE memory.scope_kind='employee' AND memory.scope_id=?
               AND (memory.project_limit_id IS NULL OR memory.project_limit_id=?) AND memory.tombstone=0
               AND NOT EXISTS (SELECT 1 FROM long_term_memories successor WHERE successor.supersedes_id=memory.id) ORDER BY memory.id`,
                [source.id, binding.project_id],
              )
              .map((memory) => memory.id)
          : [];
        db.execute('UPDATE digital_employees SET migrated_memory_global_id=?,migrated_memory_ids_json=? WHERE id=?', [globalId, JSON.stringify(memoryIds), binding.id]);
      }
      db.execute("UPDATE digital_employees SET global_employee_id=?,project_overrides_json=?,memory_enabled=?,entrypoint_migration_state='ready',revision=revision+1,updated_at=? WHERE id=?", [
        globalId,
        JSON.stringify(Object.hasOwn(overrides, 'memoryEnabled') || !source ? { memoryEnabled } : {}),
        memoryEnabled ? 1 : 0,
        timestamp,
        binding.id,
      ]);
    }
    db.execute('INSERT INTO schema_migrations (migration_id,description,checksum,applied_at) VALUES (?,?,?,?)', [digitalEmployeeGlobalIdentityMigrationId, '旧项目有效身份自动成为正式员工，并冻结原项目已有经验来源', checksum, timestamp]);
  });
}

/** 无效历史配置显式报错，避免迁移时以空对象悄悄丢弃提示词。 */
function parseLegacyIdentityObject(value: string): Record<string, unknown> {
  /** 旧配置必须是对象，与原仓储的读取边界一致。 */
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('旧数字员工配置无效，无法保留原有效身份。');
  return parsed as Record<string, unknown>;
}
