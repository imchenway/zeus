import { createHash } from 'node:crypto';
import type { AutomationActionConfig, AutomationExecutionReference } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { AutomationRunRepository, AutomationTaskRepository } from './automationStore.js';
import { DigitalEmployeeRepository } from './digitalEmployeeStore.js';
import { randomId } from './randomId.js';

/** 全局身份分离前按原项目绑定保留规则职责，不拆规则或改写历史修订。 */
export function migrateAutomationProjectEmployeeReferences(db: ZeusDatabasePort, binding: { projectId: string; globalEmployeeId: string; employeeId: string; isDefaultBinding?: boolean }, timestamp: string): void {
  if (!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_tasks'")) return;
  /** 规则与运行分别读取，当前映射不能冒充旧运行的冻结授权。 */
  const tasks = new AutomationTaskRepository(db);
  const runs = new AutomationRunRepository(db);
  for (const task of tasks.list()) {
    if (task.action.kind === 'conversation' || task.action.employeeId !== binding.globalEmployeeId || !tasks.listTargets(task.id).some((target) => target.projectId === binding.projectId)) continue;
    /** 精确来源优先于按全局身份选择的默认绑定，重复项目绑定不能互相接管。 */
    const source =
      db.get<{ employee_id: string }>('SELECT employee_id FROM digital_employee_automations WHERE id = ? AND project_id = ? AND deleted_at IS NULL', [task.id, binding.projectId])?.employee_id ??
      (task.id.startsWith('automation_employee_claim_') ? task.id.slice('automation_employee_claim_'.length) : task.id.startsWith('automation_employee_exploration_') ? task.id.slice('automation_employee_exploration_'.length) : undefined);
    if (source ? source !== binding.employeeId : binding.isDefaultBinding === false) continue;
    if (task.action.projectEmployeeIds?.[binding.projectId]) continue;
    /** 仅新当前修订增加按项目的内部引用，其余计划、游标、预算和启停原样保留。 */
    const previous = tasks.getRevision(task.currentRevisionId)!;
    const action = { ...task.action, projectEmployeeIds: { ...task.action.projectEmployeeIds, [binding.projectId]: binding.employeeId } };
    const revisionId = `automation_revision_${randomId(12)}`;
    const revision = task.revision + 1;
    /** 只有这份原修订的有效授权会在本次迁移中失效，不推断其他旧修订曾获授权。 */
    const movesGrantedRevision = tasks.hasFullAccessGrant(task.id, task.revision);
    db.execute('INSERT INTO automation_task_revisions (id, automation_id, revision, snapshot_json, project_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
      revisionId,
      task.id,
      revision,
      JSON.stringify({ ...previous.snapshot, action }),
      JSON.stringify(previous.projectIds),
      timestamp,
    ]);
    db.execute('UPDATE automation_tasks SET action_json = ?, current_revision_id = ?, revision = ?, updated_at = ? WHERE id = ?', [JSON.stringify(action), revisionId, revision, timestamp, task.id]);
    /** 范围与权限未扩大，只平移原修订的真实授权，保留原确认时间。 */
    db.execute('UPDATE automation_full_access_grants SET config_revision = ? WHERE automation_id = ? AND config_revision = ?', [revision, task.id, task.revision]);
    for (const row of db.select<{ id: string }>("SELECT id FROM automation_runs WHERE automation_id = ? AND status IN ('queued', 'dispatching', 'running', 'blocked', 'outcome_unknown')", [task.id])) {
      /** 已冻结项目绑定和真实接纳引用不改变，单独处理未准备的身份与本次迁移授权的未接纳部分。 */
      const oldRun = runs.getById(row.id)!;
      const frozenAction = tasks.getRevision(oldRun.automationRevisionId)?.snapshot.action;
      const identityAffected = frozenAction?.employeeId === binding.globalEmployeeId && !frozenAction.projectEmployeeIds?.[binding.projectId] && oldRun.projectIds.includes(binding.projectId);
      const grantMoved = movesGrantedRevision && oldRun.automationRevisionId === task.currentRevisionId;
      if (!identityAffected && !grantMoved) continue;
      const run = runs.ensureDispatchTargets(row.id);
      const reason = 'ZEUS_AUTOMATION_EMPLOYEE_IDENTITY_MIGRATED: 员工身份已迁移，本次未开始部分请重新运行。';
      let affected = false;
      let reconciled = false;
      let outcomeUnknown = false;
      for (const target of run.dispatchTargets) {
        if (target.status === 'accepted' || target.status === 'skipped' || (!grantMoved && (target.projectId !== binding.projectId || target.employeeId))) continue;
        /** 已接纳但回执尚未回写的准确事实优先，禁止把真实工作当成未开始。 */
        let accepted: AutomationExecutionReference | null | false = null;
        try {
          accepted = target.status === 'accepting' ? runs.findAcceptedExecution(target) : null;
        } catch (error) {
          /** 业务回执冲突只暂停原规则；结构或 SQL 错误仍使迁移明确失败。 */
          if (!(error instanceof Error) || !error.message.startsWith('ZEUS_AUTOMATION_DISPATCH_OUTCOME_UNKNOWN:')) throw error;
          runs.updateDispatchTarget(run.id, { ...target, reason: `${reason}\n${error.message}` });
          tasks.setStatus(task.id, 'paused');
          affected = true;
          outcomeUnknown = true;
          continue;
        }
        if (accepted || accepted === false) {
          runs.updateDispatchTarget(run.id, { ...target, status: accepted ? 'accepted' : 'skipped', reference: accepted || null, reason: accepted ? null : '原工作安排没有可领取分工。' });
          reconciled = true;
          continue;
        }
        runs.updateDispatchTarget(run.id, { ...target, reason });
        affected = true;
      }
      if (!affected && !reconciled) continue;
      /** 对账成功后同样保留原异常结论，已接纳工作必须继续占住队列。 */
      if (run.status === 'blocked' || run.status === 'outcome_unknown')
        db.execute('UPDATE automation_runs SET dispatch_reconciliation_json = COALESCE(dispatch_reconciliation_json, ?) WHERE id = ?', [
          JSON.stringify({ previousStatus: run.status, checkedAt: timestamp, reason: run.errorMessage ?? reason, completedAt: run.completedAt }),
          run.id,
        ]);
      const reconciledRun = runs.getById(run.id)!;
      if (!affected && reconciledRun.dispatchTargets.every((target) => target.status === 'accepted' || target.status === 'skipped')) {
        db.execute("UPDATE automation_runs SET status = 'dispatching', updated_at = ? WHERE id = ?", [timestamp, run.id]);
        runs.completeDispatch(run.id);
        continue;
      }
      if (!affected) continue;
      /** 部分工作仍保留串行占位，调度器只等原引用终结，不接纳剩余目标。 */
      if (reconciledRun.executionReferences.length === 0 && !outcomeUnknown) runs.setTerminal(run.id, 'blocked', 'ZEUS_AUTOMATION_EMPLOYEE_IDENTITY_MIGRATED', reason);
      else {
        /** 未知接纳即使暂缺引用，也不能释放串行占位。 */
        db.execute("UPDATE automation_runs SET status = 'dispatching', updated_at = ? WHERE id = ?", [timestamp, run.id]);
      }
    }
  }
}

/** 将旧员工自动化一次性移交给普通自动化；旧回执、在途执行和游标均不重放。 */
export function migrateEmployeeAutomationsToUnified(db: ZeusDatabasePort): void {
  /** 旧表在早期数据结构中可能尚未创建。 */
  if (!db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'digital_employee_automations'")) return;
  /** 复用已有定义和身份解析。 */
  const tasks = new AutomationTaskRepository(db);
  const employees = new DigitalEmployeeRepository(db);
  for (const legacy of db.select<{
    id: string;
    project_id: string;
    employee_id: string;
    name: string;
    enabled: number;
    trigger_kind: string;
    trigger_config_json: string;
    action_kind: string;
    action_config_json: string;
    next_run_at: string | null;
    cursor_sequence: number;
    last_triggered_at: string | null;
    created_at: string;
  }>('SELECT * FROM digital_employee_automations WHERE deleted_at IS NULL')) {
    /** 已迁移身份的删除即退役，来源员工失效也不能重建规则或恢复旧调度。 */
    if (db.get('SELECT id FROM automation_tasks WHERE id = ? AND deleted_at IS NOT NULL', [legacy.id])) {
      db.execute('UPDATE digital_employee_automations SET enabled = 0 WHERE id = ?', [legacy.id]);
      continue;
    }
    const employee = employees.getById(legacy.employee_id);
    if (!employee) {
      if (!tasks.getById(legacy.id)) throw new Error('ZEUS_AUTOMATION_EMPLOYEE_MIGRATION_BLOCKED: 旧规则的员工不可用，禁止无声跳过。');
      tasks.setMigrationIssue(legacy.id, '旧规则来源员工不可用，请重新选择员工与目标策略后保存。');
      db.execute('UPDATE digital_employee_automations SET enabled = 0 WHERE id = ?', [legacy.id]);
      continue;
    }
    const trigger = JSON.parse(legacy.trigger_config_json) as Record<string, unknown>;
    const action = JSON.parse(legacy.action_config_json) as Record<string, unknown>;
    /** 旧授权及筛选从原行读取，不能由当前统一默认重写。 */
    const legacyConfig = db.get<{ permission_mode: 'read-only' | 'auto' | 'full-access'; task_filter_json: string }>('SELECT permission_mode, task_filter_json FROM digital_employees WHERE id = ?', [legacy.employee_id])!;
    /** 领取原任务与新建任务必须保留为不同目标策略。 */
    const taskSelection =
      legacy.action_kind !== 'assign_task'
        ? 'create'
        : typeof action.taskId === 'string' && action.taskId
          ? 'specified'
          : action.useEventTask === true && ['task_created', 'task_updated', 'task_status_changed', 'code_changed'].includes(legacy.trigger_kind)
            ? 'event'
            : 'pool';
    /** 已迁移定义只在能证明仍是原始结果时更正，不动历史冻结运行。 */
    const existing = tasks.getById(legacy.id);
    if (existing) {
      if (!existing.action.taskSelection && !(existing.revision > 0 && existing.action.kind !== 'project_task')) {
        /** 原始迁移修订尚未编辑，且关键来源字段必须完全匹配。 */
        const original = tasks.getRevision(existing.currentRevisionId);
        /** 内部身份引用迁移不算用户编辑，仍可核对最初的完整配置。 */
        const initial = db.get<{ id: string }>('SELECT id FROM automation_task_revisions WHERE automation_id = ? AND revision = 0', [existing.id]);
        const initialSnapshot = initial ? tasks.getRevision(initial.id)?.snapshot : undefined;
        const currentWithoutIdentityMap = original ? { ...original.snapshot, action: { ...original.snapshot.action } } : undefined;
        if (currentWithoutIdentityMap) delete currentWithoutIdentityMap.action.projectEmployeeIds;
        const onlyIdentityMigrated = existing.action.projectEmployeeIds?.[legacy.project_id] === employee.id && JSON.stringify(currentWithoutIdentityMap) === JSON.stringify(initialSnapshot);
        const unchanged =
          (existing.revision === 0 || onlyIdentityMigrated) &&
          original?.projectIds.length === 1 &&
          original.projectIds[0] === legacy.project_id &&
          existing.name === legacy.name &&
          existing.prompt === (typeof action.description === 'string' && action.description.trim() ? action.description : employee.prompt) &&
          existing.action.kind === (legacy.action_kind === 'explore_project' ? 'employee_work' : 'project_task') &&
          (existing.action.projectEmployeeIds?.[legacy.project_id] ?? existing.action.employeeId) === (existing.action.projectEmployeeIds?.[legacy.project_id] ? employee.id : (employee.globalEmployeeId ?? employee.id)) &&
          (existing.action.taskId ?? null) === (typeof action.taskId === 'string' ? action.taskId : null) &&
          existing.action.useEventTask === (action.useEventTask === true);
        if (unchanged) {
          db.transaction(() => {
            /** 保留已有同范围授权，更正策略不扩大执行权限。 */
            const granted = tasks.hasFullAccessGrant(existing.id, existing.revision);
            const corrected = tasks.update(existing.id, {
              expectedRevision: existing.revision,
              action: { ...existing.action, taskSelection, taskFilter: existing.action.taskFilter ?? (JSON.parse(legacyConfig.task_filter_json) as NonNullable<AutomationActionConfig['taskFilter']>) },
            });
            if (granted) tasks.setFullAccessGrant(corrected.id, corrected.revision, true);
            /** 更正任务策略不能抹掉另行要求重新授权的说明。 */
            if (existing.migrationIssue && existing.migrationIssue !== '旧自动化的目标选择需要核对，请明确选择领取已有任务或创建新任务后保存。') tasks.setMigrationIssue(existing.id, existing.migrationIssue);
          });
        } else tasks.setMigrationIssue(existing.id, '旧自动化的目标选择需要核对，请明确选择领取已有任务或创建新任务后保存。');
      }
      /** 旧调度权已移交，后续更正不能恢复第二个消费者。 */
      db.execute('UPDATE digital_employee_automations SET enabled = 0 WHERE id = ?', [legacy.id]);
      continue;
    }
    const eventTrigger = ['task_created', 'task_updated', 'task_status_changed', 'code_changed'].includes(legacy.trigger_kind);
    db.transaction(() => {
      /** 新规则保持旧身份，旧触发回执仍能找到原规则。 */
      const migrated = tasks.create({
        id: legacy.id,
        name: legacy.name,
        projectIds: [legacy.project_id],
        prompt: typeof action.description === 'string' && action.description.trim() ? action.description : employee.prompt,
        modelSourceId: 'codex',
        modelId: employee.model ?? 'employee-default',
        permissionMode: legacyConfig.permission_mode,
        action: {
          kind: legacy.action_kind === 'explore_project' ? 'employee_work' : 'project_task',
          taskSelection,
          employeeId: employee.globalEmployeeId ?? employee.id,
          /** 原任务筛选从历史行冻结，不能依赖已经收敛的员工投影。 */
          taskFilter: JSON.parse(legacyConfig.task_filter_json) as NonNullable<AutomationActionConfig['taskFilter']>,
          taskId: typeof action.taskId === 'string' ? action.taskId : null,
          title: typeof action.title === 'string' ? action.title : legacy.name,
          useEventTask: action.useEventTask === true,
        },
        triggerKind: eventTrigger ? 'event' : legacy.trigger_kind === 'immediate' ? 'once' : (legacy.trigger_kind as 'once' | 'interval' | 'daily' | 'weekly'),
        triggerConfig: eventTrigger
          ? { eventKinds: [legacy.trigger_kind], beforeStatusId: typeof trigger.fromStatusId === 'string' ? trigger.fromStatusId : undefined, afterStatusId: typeof trigger.toStatusId === 'string' ? trigger.toStatusId : undefined }
          : {
              at: legacy.next_run_at ?? undefined,
              everyMinutes: typeof trigger.intervalMinutes === 'number' ? trigger.intervalMinutes : undefined,
              localTime: `${String(trigger.hour ?? 9).padStart(2, '0')}:${String(trigger.minute ?? 0).padStart(2, '0')}`,
              weekdays: typeof trigger.weekday === 'number' ? [trigger.weekday] : undefined,
            },
      });
      /** 原到期点原样保留，已消费游标不会回到零。 */
      tasks.setNextRun(migrated.id, legacy.next_run_at, legacy.last_triggered_at ?? undefined);
      tasks.setEventCursor(migrated.id, legacy.project_id, legacy.cursor_sequence, true);
      if (legacyConfig.permission_mode === 'full-access') {
        /** 旧员工授权不能替代新增本地提交语义的明确确认。 */
        if (migrated.action.kind === 'project_task' && taskSelection === 'create') tasks.setMigrationIssue(migrated.id, '旧规则的完全访问确认未包含新建任务的本地提交，请核对任务策略并重新保存授权。');
        else tasks.setFullAccessGrant(migrated.id, migrated.revision, true);
      }
      if (!legacy.enabled) tasks.setStatus(migrated.id, 'paused');
      for (const receipt of db.select<{ event_identity: string; execution_id: string | null; created_at: string }>('SELECT event_identity, execution_id, created_at FROM digital_employee_event_receipts WHERE automation_id = ?', [
        legacy.id,
      ])) {
        /** 身份只从原规则和触发回执计算，不猜测文件时间。 */
        const runId = `automation_run_${createHash('sha256').update(`${legacy.id}\0${receipt.event_identity}`).digest('hex').slice(0, 24)}`;
        const work = db.get<{ current_run_id: string; task_id: string; status: string }>('SELECT current_run_id, task_id, status FROM task_work_items WHERE source_ref = ? LIMIT 1', [`${employee.id}:${legacy.id}:${receipt.event_identity}`]);
        const execution = receipt.execution_id ? db.get<{ id: string; task_id: string; status: string }>('SELECT id, task_id, status FROM digital_employee_executions WHERE id = ?', [receipt.execution_id]) : undefined;
        const references: AutomationExecutionReference[] = work?.current_run_id
          ? [{ kind: 'task_work', id: work.current_run_id, taskId: work.task_id }]
          : execution
            ? [{ kind: 'legacy_employee', id: execution.id, taskId: execution.task_id }]
            : [];
        const status = references.length ? 'running' : 'cancelled';
        /** 新调度统一前缀；原回执和关联仍完整留在旧表。 */
        const triggerIdentity = receipt.event_identity.replace(/^scheduled:/u, 'schedule:');
        db.execute(
          `INSERT OR IGNORE INTO automation_runs (id, automation_id, automation_revision_id, project_id, project_ids_json, trigger_kind, trigger_identity, causal_chain_id, status, queue_position, execution_references_json, scheduled_at, accepted_at, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runId,
            migrated.id,
            migrated.currentRevisionId,
            legacy.project_id,
            JSON.stringify([legacy.project_id]),
            legacy.trigger_kind,
            triggerIdentity,
            `migration:${runId}`,
            status,
            JSON.stringify(references),
            receipt.created_at,
            receipt.created_at,
            receipt.created_at,
            references.length ? null : receipt.created_at,
            receipt.created_at,
            receipt.created_at,
          ],
        );
        db.execute('INSERT OR IGNORE INTO automation_trigger_receipts (automation_id, project_id, trigger_identity, run_id, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
          migrated.id,
          legacy.project_id,
          triggerIdentity,
          runId,
          receipt.created_at,
          receipt.created_at,
        ]);
      }
      /** 接纳后未写旧回执的执行仍须保留，不能在移交调度时丢失在途关联。 */
      for (const execution of db.select<{ id: string; task_id: string; created_at: string }>(
        "SELECT execution.id, execution.task_id, execution.created_at FROM digital_employee_executions execution LEFT JOIN digital_employee_event_receipts receipt ON receipt.execution_id = execution.id WHERE execution.automation_id = ? AND receipt.execution_id IS NULL AND execution.status IN ('queued', 'dispatching', 'running', 'waiting', 'delivery_pending')",
        [legacy.id],
      )) {
        const runId = `automation_migrated_${execution.id}`;
        const references: AutomationExecutionReference[] = [{ kind: 'legacy_employee', id: execution.id, taskId: execution.task_id }];
        db.execute(
          `INSERT OR IGNORE INTO automation_runs (id, automation_id, automation_revision_id, project_id, project_ids_json, trigger_kind, trigger_identity, causal_chain_id, status, queue_position, execution_references_json, scheduled_at, accepted_at, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?)`,
          [
            runId,
            migrated.id,
            migrated.currentRevisionId,
            legacy.project_id,
            JSON.stringify([legacy.project_id]),
            legacy.trigger_kind,
            `migration:${execution.id}`,
            `migration:${runId}`,
            JSON.stringify(references),
            execution.created_at,
            execution.created_at,
            execution.created_at,
            execution.created_at,
            execution.created_at,
          ],
        );
      }
      /** 新 Task Work 已接纳但旧回执尚未写出时，同样保留在途运行。 */
      const workSourcePrefix = `${employee.id}:${legacy.id}:`;
      for (const work of db.select<{ run_id: string; task_id: string; created_at: string }>(
        "SELECT work.current_run_id AS run_id, work.task_id, work.created_at FROM task_work_items work JOIN task_work_runs run ON run.id = work.current_run_id LEFT JOIN digital_employee_event_receipts receipt ON receipt.automation_id = ? AND work.source_ref = ? || receipt.event_identity WHERE work.source = 'automation' AND substr(work.source_ref, 1, ?) = ? AND receipt.event_identity IS NULL AND run.status IN ('prepared', 'dispatching', 'active', 'waiting_input', 'runtime_completed')",
        [legacy.id, workSourcePrefix, workSourcePrefix.length, workSourcePrefix],
      )) {
        /** 原运行身份继续作为回执关联，不复制会话或执行。 */
        const runId = `automation_migrated_${work.run_id}`;
        /** 关联仍指向原 Task Work 的冻结权限与成果。 */
        const references: AutomationExecutionReference[] = [{ kind: 'task_work', id: work.run_id, taskId: work.task_id }];
        db.execute(
          `INSERT OR IGNORE INTO automation_runs (id, automation_id, automation_revision_id, project_id, project_ids_json, trigger_kind, trigger_identity, causal_chain_id, status, queue_position, execution_references_json, scheduled_at, accepted_at, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?, ?, ?, ?, ?)`,
          [
            runId,
            migrated.id,
            migrated.currentRevisionId,
            legacy.project_id,
            JSON.stringify([legacy.project_id]),
            legacy.trigger_kind,
            `migration:${work.run_id}`,
            `migration:${runId}`,
            JSON.stringify(references),
            work.created_at,
            work.created_at,
            work.created_at,
            work.created_at,
            work.created_at,
          ],
        );
      }
      /** 同一事务内停止旧调度，普通调度成为唯一所有者。 */
      db.execute('UPDATE digital_employee_automations SET enabled = 0 WHERE id = ?', [legacy.id]);
    });
  }
  /** 原来源已丢失的旧规则无法证明目标策略，不按名称或任务历史猜测。 */
  for (const task of tasks.list().filter((task) => task.id.startsWith('digital_employee_automation_') && task.action.kind === 'project_task' && !task.action.taskSelection)) {
    if (!db.get('SELECT id FROM digital_employee_automations WHERE id = ? AND deleted_at IS NULL', [task.id])) tasks.setMigrationIssue(task.id, '原员工自动化来源已不可用，请明确核对目标选择后保存。');
  }
  migrateEmployeeWorkRules(db);
}

/** 员工后台领取及筛选一次移交为可见规则，后续只由自动化调度。 */
function migrateEmployeeWorkRules(db: ZeusDatabasePort): void {
  /** 迁移只消费数据库原字段，现行员工投影不得抹掉旧事实。 */
  const migrationId = '20261006_0782_employee_work_rules';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    /** 员工原配置只读，旧执行快照不改写。 */
    const employees = db.select<{
      id: string;
      global_employee_id: string | null;
      project_id: string;
      name: string;
      prompt: string;
      enabled: number;
      auto_claim: number;
      autonomous_exploration: number;
      permission_mode: 'read-only' | 'auto' | 'full-access';
      task_filter_json: string;
    }>('SELECT id, global_employee_id, project_id, name, prompt, enabled, auto_claim, autonomous_exploration, permission_mode, task_filter_json FROM digital_employees WHERE deleted_at IS NULL');
    /** 现有自动化保留运行计划、事件游标与合法运维设置。 */
    const tasks = new AutomationTaskRepository(db);
    for (const task of tasks.list().filter((entry) => entry.action.kind === 'project_task' && !entry.action.taskFilter)) {
      /** 同一多项目规则只能接纳一致的旧筛选，差异必须由用户拆分。 */
      const projectIds = tasks.listTargets(task.id).map((target) => target.projectId);
      const filters = employees
        .filter(
          (employee) =>
            projectIds.includes(employee.project_id) &&
            (task.action.projectEmployeeIds?.[employee.project_id] ? employee.id === task.action.projectEmployeeIds[employee.project_id] : employee.id === task.action.employeeId || employee.global_employee_id === task.action.employeeId),
        )
        .map((employee) => JSON.parse(employee.task_filter_json) as NonNullable<AutomationActionConfig['taskFilter']>);
      if (new Set(filters.map((filter) => JSON.stringify(filter))).size > 1) {
        tasks.setMigrationIssue(task.id, '原项目员工使用不同任务筛选，请按项目拆分规则后保存。');
        continue;
      }
      const granted = tasks.hasFullAccessGrant(task.id, task.revision);
      const updated = tasks.update(task.id, { expectedRevision: task.revision, action: { ...task.action, taskFilter: filters[0] ?? { managementStatuses: [], taskTypes: [], requiredTags: [] } } });
      if (granted) tasks.setFullAccessGrant(task.id, updated.revision, true);
      if (task.migrationIssue) tasks.setMigrationIssue(task.id, task.migrationIssue);
    }
    for (const employee of employees) {
      /** ponytail: 沿用最小一分钟间隔并立即首轮领取，确需秒级再扩展触发器。 */
      const claimId = `automation_employee_claim_${employee.id}`;
      if (employee.auto_claim === 1 && !db.get('SELECT id FROM automation_tasks WHERE id = ?', [claimId])) {
        const task = tasks.create({
          id: claimId,
          name: `${employee.name} · 领取任务`,
          prompt: employee.prompt,
          projectIds: [employee.project_id],
          permissionMode: employee.permission_mode,
          action: { kind: 'project_task', employeeId: employee.global_employee_id ?? employee.id, taskSelection: 'pool', taskFilter: JSON.parse(employee.task_filter_json) as NonNullable<AutomationActionConfig['taskFilter']> },
          triggerKind: 'interval',
          triggerConfig: { everyMinutes: 1 },
        });
        tasks.setNextRun(task.id, new Date().toISOString());
        if (employee.permission_mode === 'full-access') tasks.setFullAccessGrant(task.id, task.revision, true);
        if (employee.enabled !== 1) tasks.setStatus(task.id, 'paused');
      }
      /** 只有开关没有触发安排的探索保留为暂停规则，不凭空启动新工作。 */
      const explorationId = `automation_employee_exploration_${employee.id}`;
      if (
        employee.autonomous_exploration === 1 &&
        !db.get('SELECT id FROM automation_tasks WHERE id = ?', [explorationId]) &&
        !tasks
          .list()
          .some(
            (task) =>
              task.action.kind === 'employee_work' &&
              [employee.id, employee.global_employee_id].includes(task.action.projectEmployeeIds?.[employee.project_id] ?? task.action.employeeId) &&
              tasks.listTargets(task.id).some((target) => target.projectId === employee.project_id),
          )
      ) {
        const task = tasks.create({
          id: explorationId,
          name: `${employee.name} · 自主探索`,
          prompt: employee.prompt,
          projectIds: [employee.project_id],
          permissionMode: 'read-only',
          action: { kind: 'employee_work', employeeId: employee.global_employee_id ?? employee.id },
          triggerKind: 'manual',
        });
        tasks.setMigrationIssue(task.id, '原自主探索只有开关，请配置明确的触发安排后启用。');
      }
    }
    db.execute('INSERT INTO schema_migrations (migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [
      migrationId,
      '员工领取与筛选统一交给自动化规则',
      `sha256:${createHash('sha256').update(migrationId).digest('hex')}`,
      new Date().toISOString(),
    ]);
  });
}
