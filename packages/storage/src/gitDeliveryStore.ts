import { createHash } from 'node:crypto';
import type { GitDeliveryAction, GitDeliveryInput, GitDeliveryRun, GitDeliveryStep, GitDeliveryNotification } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

/** 普通会话的隔离合入事实仅存于 Core，不暴露绝对目录。 */
export interface GitDeliveryMergeResult {
  /** 独立合入目录。 */
  integrationPath: string;
  /** 来源分支。 */
  sourceBranch: string;
  /** 目标分支。 */
  targetBranch: string;
  /** 原来源提交。 */
  sourceHeadSha: string;
  /** 原目标提交。 */
  targetHeadSha: string;
  /** 当前冲突文件。 */
  conflictFiles: string[];
  /** 已完成的合入提交。 */
  resultHeadSha: string | null;
}

/** 步骤内部事实包括稳定命令身份和有限的恢复快照。 */
export interface GitDeliveryStepRecord extends GitDeliveryStep {
  /** 所属运行。 */
  runId: string;
  /** 手动重试代次；未知结果不增加代次。 */
  attempt: number;
  /** 当前命令身份，持久化后才能产生副作用。 */
  commandId: string | null;
  /** 已确认结果或普通会话合入快照。 */
  result: Record<string, unknown> | null;
}

/** 运行内部保存初始管理状态，避免覆盖用户的后续选择。 */
export interface GitDeliveryRunRecord extends Omit<GitDeliveryRun, 'steps'> {
  /** 运行开始时的任务管理状态。 */
  initialTaskStatus: string | null;
  /** 接纳时最后一次管理状态事件，检测状态改回原值的并发操作。 */
  initialTaskStatusEventId: string | null;
  /** 准确执行步骤。 */
  steps: GitDeliveryStepRecord[];
}

/** 两张表分别表达一次授权运行和一个仓库步骤，JSON 仅保存固定输入与原始结果。 */
export function migrateGitDelivery(db: ZeusDatabasePort): void {
  /** 固定迁移身份，现有数据不被重复初始化覆盖。 */
  const migrationId = '20261015_0857_git_delivery';
  if (db.get('SELECT 1 FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    db.execute(`CREATE TABLE git_delivery_runs (
      id TEXT PRIMARY KEY,                                      -- 唯一运行身份
      project_id TEXT NOT NULL REFERENCES projects(id),          -- 所属项目
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('task','conversation')), -- 真实入口种类
      scope_id TEXT NOT NULL,                                    -- 真实任务或会话身份，由接纳边界核验
      input_json TEXT NOT NULL,                                 -- 一次授权的不可变输入快照
      initial_task_status TEXT,                                 -- 开始时的任务管理状态，普通会话为空
      initial_task_status_event_id TEXT,                         -- 接纳时最后管理状态事件，普通会话为空
      state TEXT NOT NULL CHECK(state IN ('queued','running','attention','succeeded')), -- 运行状态
      created_at TEXT NOT NULL,                                 -- 接纳时间
      updated_at TEXT NOT NULL,                                 -- 最近进度时间
      read_at TEXT                                              -- 通知确认时间，空表示未读
    )`);
    db.execute(`CREATE TABLE git_delivery_steps (
      id TEXT PRIMARY KEY,                                      -- 稳定步骤身份
      run_id TEXT NOT NULL REFERENCES git_delivery_runs(id) ON DELETE CASCADE, -- 运行拥有步骤
      repository_id TEXT,                                       -- 已核验工作区或仓库身份，任务状态步骤为空
      repository_name TEXT NOT NULL,                            -- 本次运行的显示名称
      action TEXT NOT NULL CHECK(action IN ('commit','merge','push','task_status')), -- 固定操作
      state TEXT NOT NULL CHECK(state IN ('pending','running','waiting','attention','unknown','succeeded')), -- 步骤进度
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),     -- 已明确重试的次数
      command_id TEXT,                                          -- 当前命令的稳定回执身份
      message TEXT,                                             -- 待处理或失败原因
      conversation_id TEXT,                                     -- 冲突 AI 会话，可为空
      integration_id TEXT,                                      -- 任务合入身份，可为空
      result_json TEXT,                                         -- 命令或隔离合入结果快照
      CHECK((action = 'task_status') = (repository_id IS NULL))   -- 全局状态步骤不伪造仓库
    )`);
    db.execute('CREATE UNIQUE INDEX git_delivery_steps_repository ON git_delivery_steps(run_id, repository_id, action) WHERE repository_id IS NOT NULL');
    db.execute("CREATE UNIQUE INDEX git_delivery_steps_status ON git_delivery_steps(run_id) WHERE action = 'task_status'");
    db.execute('CREATE INDEX git_delivery_runs_scope ON git_delivery_runs(project_id, scope_kind, scope_id, created_at)');
    db.execute('CREATE INDEX git_delivery_runs_unread ON git_delivery_runs(state, read_at, updated_at, id)');
    db.execute('INSERT INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [migrationId, '后台交付运行与逐仓步骤', createHash('sha256').update(migrationId).digest('hex'), new Date().toISOString()]);
  });
}

/** 运行仓库不执行 Git，只通过已有耐久事务提交进度。 */
export class GitDeliveryRepository {
  /** 共用应用数据库。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 接纳输入与全部步骤在同一事务保存。 */
  create(id: string, projectId: string, input: GitDeliveryInput, names: Record<string, string>, initialTaskStatus: string | null): GitDeliveryRunRecord {
    /** 创建时间也作为初始进度时间。 */
    const now = new Date().toISOString();
    this.db.commitCriticalFactSync(() => {
      this.db.execute('INSERT INTO git_delivery_runs(id, project_id, scope_kind, scope_id, input_json, initial_task_status, state, created_at, updated_at) VALUES(?,?,?,?,?,?,?, ?,?)', [
        id,
        projectId,
        input.scope.kind,
        input.scope.kind === 'task' ? input.scope.taskId : input.scope.conversationId,
        JSON.stringify(input),
        initialTaskStatus,
        'queued',
        now,
        now,
      ]);
      if (input.scope.kind === 'task')
        this.db.execute("UPDATE git_delivery_runs SET initial_task_status_event_id=(SELECT id FROM task_events WHERE task_id=? AND event_type='task.management_status.changed' ORDER BY rowid DESC LIMIT 1) WHERE id=?", [
          input.scope.taskId,
          id,
        ]);
      for (const repository of input.repositories) {
        for (const action of ['commit', 'merge', 'push'] as const) if (input.settings[action]) this.addStep(id, repository.repositoryId, names[repository.repositoryId] ?? repository.repositoryId, action);
      }
      if (input.settings.finalTaskStatus) this.addStep(id, null, '任务状态', 'task_status');
    });
    return this.get(id)!;
  }

  /** 顺序由固定动作定义，身份不依赖数组排序。 */
  private addStep(runId: string, repositoryId: string | null, name: string, action: GitDeliveryAction): void {
    /** 稳定哈希避免名称或路径进入命令身份。 */
    const id = `delivery_step_${createHash('sha256').update(`${runId}\0${repositoryId}\0${action}`).digest('hex').slice(0, 32)}`;
    this.db.execute('INSERT INTO git_delivery_steps(id, run_id, repository_id, repository_name, action, state) VALUES(?,?,?,?,?,?)', [id, runId, repositoryId, name, action, 'pending']);
  }

  /** 读取同一运行的固定输入与实时进度。 */
  get(id: string): GitDeliveryRunRecord | undefined {
    /** SQL 使用明确列名，不将数据库内部字段直接公开。 */
    const row = this.db.get<{ id: string; projectId: string; input: string; initialTaskStatus: string | null; initialTaskStatusEventId: string | null; state: GitDeliveryRun['state']; createdAt: string; updatedAt: string }>(
      'SELECT id, project_id AS projectId, input_json AS input, initial_task_status AS initialTaskStatus, initial_task_status_event_id AS initialTaskStatusEventId, state, created_at AS createdAt, updated_at AS updatedAt FROM git_delivery_runs WHERE id = ?',
      [id],
    );
    if (!row) return undefined;
    /** 固定输入仅由接纳校验后的写入产生。 */
    const input = JSON.parse(row.input) as GitDeliveryInput;
    return { ...row, input, scope: input.scope, steps: this.steps(id) };
  }

  /** 列表仅查询指定的真实归属。 */
  list(projectId?: string, scopeId?: string): GitDeliveryRunRecord[] {
    return this.db
      .select<{ id: string }>('SELECT id FROM git_delivery_runs WHERE (? IS NULL OR project_id = ?) AND (? IS NULL OR scope_id = ?) ORDER BY created_at DESC LIMIT 100', [
        projectId ?? null,
        projectId ?? null,
        scopeId ?? null,
        scopeId ?? null,
      ])
      .map((row) => this.get(row.id)!);
  }

  /** 重启恢复不受历史列表数量限制。 */
  unfinished(): GitDeliveryRunRecord[] {
    return this.db.select<{ id: string }>("SELECT id FROM git_delivery_runs WHERE state <> 'succeeded'").map((row) => this.get(row.id)!);
  }

  /** 每个步骤都保留独立的命令、结果和冲突身份。 */
  private steps(runId: string): GitDeliveryStepRecord[] {
    return this.db
      .select<Omit<GitDeliveryStepRecord, 'result'> & { resultJson: string | null }>(
        `SELECT id, run_id AS runId, repository_id AS repositoryId, repository_name AS repositoryName, action, state, attempt, command_id AS commandId, message, conversation_id AS conversationId, integration_id AS integrationId, result_json AS resultJson FROM git_delivery_steps WHERE run_id = ? ORDER BY rowid`,
        [runId],
      )
      .map(({ resultJson, ...row }) => ({ ...row, result: resultJson ? JSON.parse(resultJson) : null }));
  }

  /** 进度更新先落盘，再允许执行器启动下一步。 */
  updateStep(step: GitDeliveryStepRecord, change: Partial<Pick<GitDeliveryStepRecord, 'state' | 'attempt' | 'commandId' | 'message' | 'conversationId' | 'integrationId' | 'result'>>): void {
    /** 完整的新值避免可选字段把旧结果清空。 */
    const next = { ...step, ...change };
    this.db.commitCriticalFactSync(() =>
      this.db.execute('UPDATE git_delivery_steps SET state=?, attempt=?, command_id=?, message=?, conversation_id=?, integration_id=?, result_json=? WHERE id=?', [
        next.state,
        next.attempt,
        next.commandId,
        next.message,
        next.conversationId,
        next.integrationId,
        next.result ? JSON.stringify(next.result) : null,
        step.id,
      ]),
    );
  }

  /** 状态发生变化才更新通知时间，轮询不重复生成未读。 */
  updateState(id: string, state: GitDeliveryRun['state']): void {
    this.db.commitCriticalFactSync(() => this.db.execute('UPDATE git_delivery_runs SET state=?, updated_at=?, read_at=NULL WHERE id=? AND state<>?', [state, new Date().toISOString(), id, state]));
  }

  /** 对外投影排除命令恢复快照和工作目录。 */
  view(run: GitDeliveryRunRecord): GitDeliveryRun {
    return {
      id: run.id,
      projectId: run.projectId,
      scope: run.scope,
      input: run.input,
      state: run.state,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      steps: run.steps.map(({ id, repositoryId, repositoryName, action, state, message, conversationId, integrationId, result }) => ({
        id,
        repositoryId,
        repositoryName,
        action,
        state,
        message,
        conversationId,
        integrationId,
        ...(result?.cleanupConfirmation ? { cleanupConfirmation: result.cleanupConfirmation as NonNullable<GitDeliveryStep['cleanupConfirmation']> } : {}),
      })),
    };
  }

  /** 交付通知与进度读取同一权威记录。 */
  notifications(): GitDeliveryNotification[] {
    return this.db.select<{ id: string }>("SELECT id FROM git_delivery_runs WHERE state IN ('succeeded','attention') AND read_at IS NULL ORDER BY updated_at DESC, id DESC").map(({ id }) => {
      /** 通知不复制执行状态。 */
      const run = this.get(id)!;
      return { id, projectId: run.projectId, scope: run.scope, title: '代码交付', status: run.state as 'succeeded' | 'attention', occurredAt: run.updatedAt };
    });
  }

  /** 单条或全部已读都由通知命令事务调用。 */
  acknowledge(id?: string): void {
    this.db.execute("UPDATE git_delivery_runs SET read_at=? WHERE state IN ('succeeded','attention') AND read_at IS NULL AND (? IS NULL OR id=?)", [new Date().toISOString(), id ?? null, id ?? null]);
  }
}
