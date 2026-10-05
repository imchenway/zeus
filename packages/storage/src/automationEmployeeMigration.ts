import { createHash } from 'node:crypto';
import type { AutomationExecutionReference } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';
import { AutomationTaskRepository } from './automationStore.js';
import { DigitalEmployeeRepository } from './digitalEmployeeStore.js';

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
        const unchanged =
          existing.revision === 0 &&
          original?.projectIds.length === 1 &&
          original.projectIds[0] === legacy.project_id &&
          existing.name === legacy.name &&
          existing.prompt === (typeof action.description === 'string' && action.description.trim() ? action.description : employee.prompt) &&
          existing.action.kind === (legacy.action_kind === 'explore_project' ? 'employee_work' : 'project_task') &&
          existing.action.employeeId === (employee.globalEmployeeId ?? employee.id) &&
          (existing.action.taskId ?? null) === (typeof action.taskId === 'string' ? action.taskId : null) &&
          existing.action.useEventTask === (action.useEventTask === true);
        if (unchanged) {
          db.transaction(() => {
            /** 保留已有同范围授权，更正策略不扩大执行权限。 */
            const granted = tasks.hasFullAccessGrant(existing.id, existing.revision);
            const corrected = tasks.update(existing.id, { expectedRevision: existing.revision, action: { ...existing.action, taskSelection } });
            if (granted) tasks.setFullAccessGrant(corrected.id, corrected.revision, true);
            tasks.setMigrationIssue(existing.id, null);
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
        permissionMode: employee.permissionMode,
        action: {
          kind: legacy.action_kind === 'explore_project' ? 'employee_work' : 'project_task',
          taskSelection,
          employeeId: employee.globalEmployeeId ?? employee.id,
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
      if (employee.permissionMode === 'full-access') tasks.setFullAccessGrant(migrated.id, migrated.revision, true);
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
}
