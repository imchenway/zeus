import { createHash } from 'node:crypto';
import type { EmployeeWorkSettings, EmployeeWorkStageInput, EmployeeWorkOutputKind, EmployeeTeamRecipe } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { TaskWorkItemRepository, TaskWorkStoreError, type TaskWorkItemRecord } from './taskWorkStore.js';
import { TaskStageRepository } from './taskStageStore.js';
import { randomId } from './randomId.js';

/** 工作安排只补充目标关系，实际执行仍由工作运行仓库记录。 */
export interface TaskWorkArrangement {
  /** 所属阶段；独立工作可省略。 */
  stageId?: string;
  /** 委派来源工作。 */
  parentWorkItemId?: string;
  /** 必须先完成的工作身份。 */
  dependencyIds: string[];
  /** 待领取的职责。 */
  role: string;
  /** 是否作为本阶段必要成果。 */
  required: boolean;
  /** 预期的真实成果种类。 */
  outputKinds: EmployeeWorkOutputKind[];
  /** 本工作后续覆盖。 */
  settings: EmployeeWorkSettings;
  /** 当前分工实际生效的委派范围。 */
  delegation?: EmployeeWorkSettings['delegation'];
  /** 执行前预检失败的当前原因。 */
  blockedReason?: string;
  /** 先持久停止意图，外部终态确认后才结束记录。 */
  cancellationRequested?: boolean;
}

/** 流程只安排阶段与分工，不持有另一套执行尝试。 */
export interface TaskWorkPlan {
  /** 复用已有流程身份。 */
  id: string;
  /** 当前任务。 */
  taskId: string;
  /** 每次明确重新安排的工作代次。 */
  generation: number;
  /** 安排的执行控制状态。 */
  state: 'draft' | 'running' | 'paused' | 'completed' | 'cancelled';
  /** 并发修改修订。 */
  revision: number;
  /** 全任务配置覆盖。 */
  settings: EmployeeWorkSettings;
  /** 当前有序阶段与对应的真实工作。 */
  stages: Array<{
    id: string;
    title: string;
    description: string;
    status: string;
    advanceMode: 'manual' | 'auto';
    acceptanceMode: 'manual' | 'checked';
    /** 阶段要求的明确验证命令。 */
    verificationCommands: string[];
    settings: EmployeeWorkSettings;
    requiredSkillIds: string[];
    items: TaskWorkItemRecord[];
  }>;
}

/** 迁移不修改旧账本；新阶段沿用原表，执行明确归属工作管理。 */
export function migrateTaskWorkPlanningSchema(db: ZeusDatabasePort): void {
  /** 结构身份使用日期和语义，不重复创建另一套工作表。 */
  const migrationId = '20260910_task_work_planning';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    /** 当前外键均为保留历史的普通引用；重建时暂缓验证并在恢复前完整核对。 */
    db.execute('PRAGMA defer_foreign_keys = ON');
    /** 复制原结构，仅允许尚未领取的工作不绑定员工。 */
    const original = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_work_items'")!;
    /** 现有索引原样恢复，不丢失重复来源约束。 */
    const indexes = db.select<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'task_work_items' AND sql IS NOT NULL");
    /** 防止未来添加级联引用后沿用当前重建策略损坏历史。 */
    for (const table of db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      const references = db.select<{ table: string; on_delete: string }>(`PRAGMA foreign_key_list("${table.name.replaceAll('"', '""')}")`);
      if (references.some((reference) => reference.table === 'task_work_items' && reference.on_delete !== 'NO ACTION' && reference.on_delete !== 'RESTRICT')) throw new Error('工作安排迁移发现未声明的级联关系，已停止迁移。');
    }
    db.execute(original.sql.replace(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?task_work_items["`]?/i, 'CREATE TABLE task_work_items_planning').replace(/employee_id TEXT NOT NULL/i, 'employee_id TEXT'));
    db.execute('INSERT INTO task_work_items_planning SELECT * FROM task_work_items');
    db.execute('DROP TABLE task_work_items');
    db.execute('ALTER TABLE task_work_items_planning RENAME TO task_work_items');
    for (const index of indexes) db.execute(index.sql);
    db.execute('ALTER TABLE task_work_items ADD COLUMN arrangement_json TEXT');
    db.execute("ALTER TABLE task_workflows ADD COLUMN execution_owner TEXT NOT NULL DEFAULT 'legacy'");
    db.execute("ALTER TABLE task_workflows ADD COLUMN work_control_state TEXT NOT NULL DEFAULT 'draft'");
    db.execute('ALTER TABLE task_workflows ADD COLUMN work_generation INTEGER NOT NULL DEFAULT 1');
    db.execute("ALTER TABLE task_workflows ADD COLUMN work_settings_json TEXT NOT NULL DEFAULT '{}'");
    db.execute("ALTER TABLE task_stages ADD COLUMN work_settings_json TEXT NOT NULL DEFAULT '{}'");
    db.execute("ALTER TABLE task_stages ADD COLUMN required_skills_json TEXT NOT NULL DEFAULT '[]'");
    db.execute("ALTER TABLE task_stages ADD COLUMN acceptance_mode TEXT NOT NULL DEFAULT 'manual'");
    db.execute('CREATE TABLE employee_team_recipes (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, stages_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1)');
    if (db.select('PRAGMA foreign_key_check').length) throw new Error('工作安排迁移后外键核对失败，已回滚。');
    /** SQLite 重建原表后仍保留临时删除计数；完整检查成功才恢复即时外键验证。 */
    db.execute('PRAGMA defer_foreign_keys = OFF');
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '统一阶段安排、员工领取与工作关系',
      createHash('sha256').update(migrationId).digest('hex'),
      new Date().toISOString(),
    ]);
  });
}

/** 阶段和工作关系的唯一安排入口；不会派发模型或自动验收。 */
export class TaskWorkPlanningRepository {
  /** 与工作管理共享同一数据库事务。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 读取现行安排，旧阶段保留原有历史入口。 */
  get(taskId: string): TaskWorkPlan | null {
    /** 仅工作管理拥有的流程进入新调度。 */
    const row = this.db.get<{ id: string; task_id: string; work_control_state: TaskWorkPlan['state']; work_generation: number; revision: number; work_settings_json: string }>(
      "SELECT * FROM task_workflows WHERE task_id = ? AND execution_owner = 'task_work'",
      [taskId],
    );
    if (!row) return null;
    /** 分工统一从实际工作仓库读取。 */
    const items = new TaskWorkItemRepository(this.db, this.now).listByTask(taskId);
    /** 原阶段表继续提供标题及完成状态。 */
    const stages = this.db.select<{
      id: string;
      title: string;
      description: string;
      status: string;
      advance_mode: 'auto' | 'manual';
      acceptance_mode: 'checked' | 'manual';
      output_contract_json: string;
      work_settings_json: string;
      required_skills_json: string;
    }>("SELECT * FROM task_stages WHERE workflow_id = ? AND COALESCE(json_extract(output_contract_json, '$.workGeneration'), 1) = ? ORDER BY sequence, id", [row.id, row.work_generation]);
    return {
      id: row.id,
      taskId,
      state: row.work_control_state,
      generation: row.work_generation,
      revision: row.revision,
      settings: JSON.parse(row.work_settings_json),
      stages: stages.map((stage) => ({
        id: stage.id,
        title: stage.title,
        description: stage.description,
        status: stage.status,
        advanceMode: stage.advance_mode,
        acceptanceMode: stage.acceptance_mode,
        verificationCommands: JSON.parse(stage.output_contract_json).verificationCommands ?? [],
        settings: JSON.parse(stage.work_settings_json),
        requiredSkillIds: JSON.parse(stage.required_skills_json),
        items: items.filter((item) => item.arrangement?.stageId === stage.id),
      })),
    };
  }

  /** 按当前阶段准备待领取分工，不把完整任务复制给每位成员。 */
  save(taskId: string, expectedRevision: number | null, stages: EmployeeWorkStageInput[], settings: EmployeeWorkSettings): TaskWorkPlan {
    if (
      !Array.isArray(stages) ||
      stages.length < 1 ||
      stages.length > 12 ||
      stages.some((stage) => !stage.title.trim() || !stage.assignments.length || stage.assignments.length > 24 || stage.assignments.some((item) => !item.title.trim() || !item.description.trim()))
    )
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '每个阶段需要名称，以及有目标和完成标准的分工。', 400);
    /** 保存安排必须与读取修订一致；已运行阶段不能被编辑重写。 */
    const current = this.get(taskId);
    if ((current?.revision ?? null) !== expectedRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_CONFLICT', '任务安排已更新，请重新读取。');
    /** 已有旧流程不能静默接管正在执行的尝试。 */
    const legacy = new TaskStageRepository(this.db, this.now).getWorkflowByTask(taskId);
    if (legacy && !current && (legacy.workflow.status === 'active' || this.db.get("SELECT id FROM task_stage_attempts WHERE task_id = ? AND status IN ('starting','active','outcome_unknown') LIMIT 1", [taskId])))
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_LEGACY_ACTIVE', '此任务仍有旧阶段运行，请先完成或明确结束原工作。');
    if (current && !['draft', 'completed', 'cancelled'].includes(current.state)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_STARTED', '已开始的安排不能整体覆盖；请调整尚未执行的具体分工。');
    /** 当前任务项目边界不取自客户端。 */
    const task = this.db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [taskId]);
    if (!task) throw new TaskWorkStoreError('ZEUS_TASK_NOT_FOUND', '任务不存在。', 404);
    for (const stage of stages)
      for (const assignment of stage.assignments)
        if (assignment.employeeId && !this.db.get('SELECT id FROM digital_employees WHERE id = ? AND project_id = ?', [assignment.employeeId, task.project_id]))
          throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '执行人必须属于当前项目。', 400);
    /** 重开只创建新一轮阶段，旧分工、成果与原阶段身份全部保留。 */
    if (current && current.state !== 'draft' && current.stages.some((stage) => stage.items.some((item) => !['completed', 'cancelled', 'failed'].includes(item.status))))
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_UNSETTLED', '原安排还有未收口的工作，请先核对停止或未知结果。');
    this.db.transaction(() => {
      const generation = current ? current.generation + (current.state === 'draft' ? 0 : 1) : legacy ? 2 : 1;
      const workflowId = current?.id ?? legacy?.workflow.id ?? `task_workflow_${randomId(16)}`;
      const timestamp = this.now();
      if (current?.state === 'draft') {
        for (const stage of current.stages) {
          if (stage.items.some((item) => item.currentRunId)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_STARTED', '已经运行的工作不能被替换。');
          for (const item of stage.items) this.db.execute('DELETE FROM task_work_items WHERE id = ? AND current_run_id IS NULL', [item.id]);
          this.db.execute('DELETE FROM task_stages WHERE id = ?', [stage.id]);
        }
      }
      if (!current && !legacy)
        this.db.execute("INSERT INTO task_workflows(id, task_id, template_key, template_revision, status, revision, created_at, updated_at) VALUES (?, ?, 'employee-team', 1, 'active', 1, ?, ?)", [workflowId, taskId, timestamp, timestamp]);
      this.db.execute(
        "UPDATE task_workflows SET execution_owner = 'task_work', work_control_state = 'draft', work_settings_json = ?, work_generation = ?, status = 'active', current_stage_id = NULL, revision = ?, updated_at = ? WHERE id = ?",
        [JSON.stringify(settings), generation, (current?.revision ?? legacy?.workflow.revision ?? 0) + 1, timestamp, workflowId],
      );
      const sequenceStart = this.db.get<{ maximum: number | null }>('SELECT MAX(sequence) AS maximum FROM task_stages WHERE workflow_id = ?', [workflowId])?.maximum ?? 0;
      stages.forEach((stage, index) => {
        const stageId = `task_stage_${randomId(16)}`;
        this.db.execute(
          `INSERT INTO task_stages(id, workflow_id, task_id, stage_key, sequence, kind, title, description, status, agent_kind, model_ref, work_mode, permission_mode, advance_mode, prompt, output_contract_json, revision, created_at, updated_at, work_settings_json, required_skills_json, acceptance_mode)
          VALUES (?, ?, ?, ?, ?, 'custom', ?, ?, ?, 'codex', '', 'default', 'read-only', ?, '', ?, 1, ?, ?, ?, ?, ?)`,
          [
            stageId,
            workflowId,
            taskId,
            `cycle-${generation}-stage-${index + 1}`,
            sequenceStart + index + 1,
            stage.title,
            stage.description,
            index === 0 ? 'ready' : 'pending',
            stage.advanceMode,
            JSON.stringify({ workGeneration: generation, verificationCommands: stage.verificationCommands ?? [] }),
            timestamp,
            timestamp,
            JSON.stringify(stage.settings),
            JSON.stringify(stage.requiredSkillIds),
            stage.acceptanceMode,
          ],
        );
        for (const assignment of stage.assignments)
          new TaskWorkItemRepository(this.db, this.now).create({
            id: `task_work_item_${randomId(16)}`,
            taskId,
            projectId: task.project_id,
            employeeId: assignment.employeeId,
            source: 'manual',
            sourceRef: `arrangement:${randomId(16)}`,
            title: assignment.title,
            description: assignment.description,
            entrypointKind: 'agent',
            status: 'queued',
            arrangement: { stageId, dependencyIds: [], role: assignment.role, required: assignment.required, outputKinds: assignment.outputKinds, settings: assignment.settings },
          });
      });
    });
    return this.get(taskId)!;
  }

  /** 启动、暂停与继续只改变后续调度许可，不伪称外部动作已经停止。 */
  control(taskId: string, expectedRevision: number, state: 'running' | 'paused' | 'cancelled'): TaskWorkPlan {
    /** 状态变更与修订在同一事务中接纳。 */
    const current = this.get(taskId);
    if (!current || current.revision !== expectedRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_CONFLICT', '任务安排已更新，请重新读取。');
    if (current.state === 'completed' || current.state === 'cancelled') throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_CLOSED', '此轮安排已结束。');
    this.db.execute('UPDATE task_workflows SET work_control_state = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', [state, this.now(), current.id, expectedRevision]);
    if (state === 'cancelled') {
      /** 整体结束先记录每份分工的停止意图，后台只核对原运行。 */
      const items = new TaskWorkItemRepository(this.db, this.now);
      for (const planned of current.stages.flatMap((stage) => stage.items)) {
        const item = items.getById(planned.id);
        if (item?.arrangement && !item.arrangement.cancellationRequested && !['completed', 'cancelled'].includes(item.status)) this.requestCancellation(item.id, item.revision);
      }
    }
    return this.get(taskId)!;
  }

  /** 独占领取一份待领工作，不限制同一员工承接其他独立分工。 */
  assign(workItemId: string, expectedRevision: number, employeeId: string): TaskWorkItemRecord {
    /** 比较并交换在同步数据库事务内完成。 */
    return this.db.transaction(() => {
      const items = new TaskWorkItemRepository(this.db, this.now);
      const item = items.getById(workItemId);
      if (!item || item.revision !== expectedRevision || item.currentRunId || item.status !== 'queued') throw new TaskWorkStoreError('ZEUS_TASK_WORK_ASSIGNMENT_CONFLICT', '该分工已更新或开始执行，请重新读取。');
      if (!this.db.get('SELECT id FROM digital_employees WHERE id = ? AND project_id = ? AND enabled = 1 AND deleted_at IS NULL', [employeeId, item.projectId]))
        throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '员工不属于当前项目或已停用。');
      this.db.execute('UPDATE task_work_items SET employee_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', [employeeId, this.now(), item.id, expectedRevision]);
      return items.getById(item.id)!;
    });
  }

  /** 持久保存具体工作的后续配置或当前阻塞原因。 */
  updateArrangement(item: TaskWorkItemRecord, arrangement: TaskWorkArrangement): void {
    this.db.execute('UPDATE task_work_items SET arrangement_json = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', [JSON.stringify(arrangement), this.now(), item.id, item.revision]);
    if (!this.db.get<{ count: number }>('SELECT changes() AS count')?.count) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ASSIGNMENT_CONFLICT', '分工已更新，请重新读取。');
  }

  /** 取消当前工作及子孙，保留并行兄弟与已验收结果。 */
  requestCancellation(workItemId: string, expectedRevision: number): TaskWorkItemRecord {
    return this.db.transaction(() => {
      const items = new TaskWorkItemRepository(this.db, this.now);
      const root = items.getById(workItemId);
      if (!root || root.revision !== expectedRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ASSIGNMENT_CONFLICT', '工作已经变化，请重新读取。');
      const family = new Set([root.id]);
      const records = items.listByTask(root.taskId);
      for (let index = 0; index < records.length; index += 1) for (const item of records) if (item.arrangement?.parentWorkItemId && family.has(item.arrangement.parentWorkItemId)) family.add(item.id);
      for (const item of records)
        if (family.has(item.id) && item.arrangement && !['completed', 'cancelled'].includes(item.status)) this.updateArrangement(item, { ...item.arrangement, cancellationRequested: true, blockedReason: undefined });
      return items.getById(root.id)!;
    });
  }

  /** 有边界的子工作沿用父分工所在阶段，并独立记录运行和审查。 */
  delegate(
    parentId: string,
    operationIdentity: string,
    input: { employeeId: string; title: string; description: string; dependencyIds: string[] },
    policy: NonNullable<EmployeeWorkSettings['delegation']>,
    permissionMode: NonNullable<EmployeeWorkSettings['permissionMode']>,
  ): TaskWorkItemRecord {
    /** 重放通过固定来源返回原分工。 */
    const items = new TaskWorkItemRepository(this.db, this.now);
    const replay = items.getBySource('manual', `delegation:${operationIdentity}`);
    if (replay) return replay;
    /** 父工作必须属于正在推进的安排，防止独立会话偷偷生成后台任务。 */
    const parent = items.getById(parentId);
    if (parent?.arrangement?.cancellationRequested || !parent?.arrangement?.stageId || !parent.currentRunId || ['completed', 'cancelled', 'failed'].includes(parent.status))
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELEGATION_CLOSED', '当前工作不能新增委派。');
    const plan = this.get(parent.taskId);
    if (plan?.state !== 'running') throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_PAUSED', '当前安排尚未运行或已暂停。');
    if (!policy.employeeIds.includes(input.employeeId) || !this.db.get('SELECT id FROM digital_employees WHERE id = ? AND project_id = ? AND enabled = 1 AND deleted_at IS NULL', [input.employeeId, parent.projectId]))
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELEGATION_NOT_ALLOWED', '该员工不在本次允许委派的成员范围内。');
    /** 沿父关系定位本轮拆分边界。 */
    let root = parent;
    let depth = 1;
    const visited = new Set([parent.id]);
    while (root.arrangement?.parentWorkItemId) {
      const ancestor = items.getById(root.arrangement.parentWorkItemId);
      if (!ancestor || visited.has(ancestor.id)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPENDENCY_INVALID', '工作父关系无效。');
      visited.add(ancestor.id);
      root = ancestor;
      depth += 1;
    }
    if (depth > policy.maxDepth) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELEGATION_LIMIT', '本次委派已达到允许的拆分层级。');
    /** 所有子孙计入同一根工作的预算，拆分不能重置上限。 */
    const family = items.listByTask(parent.taskId).filter((candidate) => {
      let current = candidate;
      const seen = new Set<string>();
      while (current.arrangement?.parentWorkItemId) {
        if (seen.has(current.id)) return false;
        seen.add(current.id);
        if (current.arrangement.parentWorkItemId === root.id) return true;
        const ancestor = items.getById(current.arrangement.parentWorkItemId);
        if (!ancestor) return false;
        current = ancestor;
      }
      return false;
    });
    if (family.length >= policy.maxWorkItems) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELEGATION_LIMIT', '本轮拆分已达到分工数量上限，请先汇总现有工作。');
    if (input.dependencyIds.some((id) => !family.some((candidate) => candidate.id === id) || visited.has(id))) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPENDENCY_INVALID', '依赖必须是同一轮已经创建的其他子工作，不能依赖父工作。');
    return items.create({
      id: `task_work_item_${randomId(16)}`,
      taskId: parent.taskId,
      projectId: parent.projectId,
      employeeId: input.employeeId,
      source: 'manual',
      sourceRef: `delegation:${operationIdentity}`,
      title: input.title,
      description: input.description,
      entrypointKind: 'agent',
      status: 'queued',
      arrangement: {
        stageId: parent.arrangement.stageId,
        parentWorkItemId: parent.id,
        dependencyIds: input.dependencyIds,
        role: '',
        required: true,
        outputKinds: ['document'],
        settings: { permissionMode },
        delegation: structuredClone(policy),
      },
    });
  }

  /** 只返回现行调度可管理的任务。 */
  listRunningTaskIds(): string[] {
    return this.db.select<{ task_id: string }>("SELECT task_id FROM task_workflows WHERE execution_owner = 'task_work' AND work_control_state IN ('running','paused','cancelled')").map((row) => row.task_id);
  }

  /** 阶段状态来自必要工作的实际结果，不凭模型空闲或最后一句话推进。 */
  reconcile(taskId: string): TaskWorkPlan | null {
    const plan = this.get(taskId);
    if (!plan || plan.state !== 'running') return plan;
    for (const stage of plan.stages) {
      if (stage.status === 'accepted' || stage.status === 'skipped') continue;
      const required = stage.items.filter((item) => item.arrangement?.required !== false);
      const complete = required.length > 0 && required.every((item) => item.status === 'completed');
      const status = complete ? 'accepted' : stage.items.some((item) => item.status === 'waiting_manager') ? 'awaiting_acceptance' : stage.items.some((item) => item.currentRunId) ? 'running' : 'ready';
      if (status !== stage.status) this.db.execute('UPDATE task_stages SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ?', [status, this.now(), stage.id]);
      if (!complete) {
        this.db.execute('UPDATE task_workflows SET current_stage_id = ? WHERE id = ?', [stage.id, plan.id]);
        return this.get(taskId);
      }
      if (stage.advanceMode === 'manual' && plan.stages.at(-1)?.id !== stage.id) {
        this.db.execute("UPDATE task_workflows SET work_control_state = 'paused', revision = revision + 1 WHERE id = ?", [plan.id]);
        return this.get(taskId);
      }
    }
    this.db.execute("UPDATE task_workflows SET work_control_state = 'completed', status = 'completed', current_stage_id = NULL, revision = revision + 1 WHERE id = ?", [plan.id]);
    return this.get(taskId);
  }

  /** 配方按项目读取，复制到任务后不随模板改变。 */
  listRecipes(projectId: string): EmployeeTeamRecipe[] {
    return this.db
      .select<{ id: string; project_id: string; name: string; stages_json: string; revision: number }>('SELECT * FROM employee_team_recipes WHERE project_id = ? ORDER BY name, id', [projectId])
      .map((row) => ({ id: row.id, projectId: row.project_id, name: row.name, stages: JSON.parse(row.stages_json), revision: row.revision }));
  }

  /** 保存配方使用显式修订，不改动已经启动的任务。 */
  saveRecipe(input: EmployeeTeamRecipe): EmployeeTeamRecipe {
    const current = this.listRecipes(input.projectId).find((recipe) => recipe.id === input.id);
    if ((current?.revision ?? 0) !== input.revision || !input.name.trim()) throw new TaskWorkStoreError('ZEUS_EMPLOYEE_RECIPE_CONFLICT', '配方名称缺失或已被修改。');
    this.db.execute(
      'INSERT INTO employee_team_recipes(id, project_id, name, stages_json, revision) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, stages_json = excluded.stages_json, revision = excluded.revision WHERE employee_team_recipes.project_id = excluded.project_id',
      [input.id, input.projectId, input.name.trim(), JSON.stringify(input.stages), input.revision + 1],
    );
    const saved = this.listRecipes(input.projectId).find((recipe) => recipe.id === input.id);
    if (!saved) throw new TaskWorkStoreError('ZEUS_EMPLOYEE_RECIPE_CONFLICT', '配方身份属于其他项目，未修改任何配置。');
    return saved;
  }
}
