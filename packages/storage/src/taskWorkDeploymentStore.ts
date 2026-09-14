import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { TaskWorkRunRepository, TaskWorkStoreError } from './taskWorkStore.js';

/** 一次部署的声明和实际命令证据一起冻结；成功执行不替代用户验收。 */
export interface TaskWorkDeploymentReceipt {
  /** 调用账本确定的唯一身份。 */
  id: string;
  /** 凭证只属于一份原始运行。 */
  runId: string;
  /** 数字员工声明的环境名称。 */
  environment: string;
  /** 数字员工声明的部署修订。 */
  revision: string;
  /** 可审查的应用或部署记录地址。 */
  url: string;
  /** 声明结果，未知和失败保留原貌。 */
  outcome: 'succeeded' | 'failed' | 'unknown';
  /** 补充说明及尚待确认的问题。 */
  summary: string;
  /** 原运行内已完成的部署及验证命令，不接受伪造输出。 */
  commands: Array<{ id: string; purpose: 'deploy' | 'verify'; command: string; output: string; exitCode: number | null; completedAt: string | null; sha256: string }>;
  /** 完整凭证的内容摘要。 */
  contentSha256: string;
  /** 系统记录时间，不由模型提供。 */
  createdAt: string;
}

/** 增加不可变凭证账本，运行及交付物仍保留原有权威。 */
export function migrateTaskWorkDeploymentSchema(db: ZeusDatabasePort): void {
  /** 独立迁移不会漏掉已经完成审查迁移的数据库。 */
  const migrationId = '20260912_task_work_deployment';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [migrationId])) return;
  db.transaction(() => {
    db.execute('CREATE TABLE task_work_deployment_receipts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES task_work_runs(id), content_json TEXT NOT NULL, created_at TEXT NOT NULL)');
    db.execute('CREATE INDEX idx_task_work_deployment_run ON task_work_deployment_receipts(run_id, created_at, id)');
    db.execute('INSERT INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES(?, ?, ?, ?)', [
      migrationId,
      '保存原工作运行的不可变部署凭证',
      createHash('sha256').update(migrationId).digest('hex'),
      new Date().toISOString(),
    ]);
  });
}

/** 只追加凭证；重复调用由原工作命令账本核对参数与回执。 */
export class TaskWorkDeploymentRepository {
  /** 共享数据库事务与时钟。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}
  /** 按来源运行读取完整冻结证据。 */
  list(runId: string): TaskWorkDeploymentReceipt[] {
    return this.db.select<{ content_json: string }>('SELECT content_json FROM task_work_deployment_receipts WHERE run_id = ? ORDER BY created_at, id', [runId]).map((row) => JSON.parse(row.content_json) as TaskWorkDeploymentReceipt);
  }
  /** 关闭的运行不能追加会改变成果依据的新凭证。 */
  record(input: Omit<TaskWorkDeploymentReceipt, 'createdAt' | 'contentSha256'>): TaskWorkDeploymentReceipt {
    /** 运行归属与可写状态在事务内复核。 */
    const run = new TaskWorkRunRepository(this.db, this.now).getById(input.runId);
    if (!run || !['active', 'waiting_input'].includes(run.status)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_CLOSED', '当前运行已关闭，不能补写部署凭证。');
    /** 来源和原文按同一次写入冻结。 */
    const record: TaskWorkDeploymentReceipt = { ...input, contentSha256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), createdAt: this.now() };
    this.db.execute('INSERT INTO task_work_deployment_receipts(id, run_id, content_json, created_at) VALUES(?, ?, ?, ?)', [record.id, record.runId, JSON.stringify(record), record.createdAt]);
    return record;
  }
}
