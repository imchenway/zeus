import { createHash } from 'node:crypto';
import type { DigitalTeamDefectSubmission, DigitalTeamRepositoryResult, DigitalTeamRunRuntimeState } from '@zeus/shared';
import type { ZeusDatabasePort } from './databasePort.js';

/** 正式缺陷的持久状态，只有父流程复验或明确风险决定可以关闭。 */
export type DefectWorkflowStatus = 'open' | 'repairing' | 'awaiting_retest' | 'accepted' | 'risk_accepted' | 'blocked';

/** 一条正式缺陷与其被测现场、修复成果和父验收关系。 */
export interface DefectWorkflowRecord extends DigitalTeamDefectSubmission {
  /** 稳定缺陷身份。 */
  id: string;
  /** 等待验收的原任务。 */
  parentTaskId: string;
  /** 可独立追踪的 defect 子任务。 */
  defectTaskId: string;
  /** 当前负责复验的父流程。 */
  parentRunId: string;
  /** 父流程真实测试节点。 */
  verificationNodeId: string;
  /** 发现问题的准确测试尝试。 */
  sourceAttemptId: string;
  /** 当前修复子流程。 */
  repairRunId: string | null;
  /** 已核验且等待父流程复验的准确修复提交。 */
  repairResults: DigitalTeamRepositoryResult[];
  /** 当前缺陷状态。 */
  status: DefectWorkflowStatus;
  /** 人工接受风险的理由，不能充当 passed 记录。 */
  riskReason: string | null;
  /** 记录决定的真实用户身份。 */
  riskActorId: string | null;
  /** 并发修订。 */
  revision: number;
}

/** 迁移仅创建缺陷账本，既有任务和运行快照保持原值。 */
export function migrateDefectWorkflowSchema(db: ZeusDatabasePort): void {
  db.execute('CREATE TABLE IF NOT EXISTS digital_team_task_repair_budgets (task_id TEXT PRIMARY KEY REFERENCES tasks(id), used_rounds INTEGER NOT NULL DEFAULT 0 CHECK(used_rounds >= 0))');
  db.execute(`CREATE TABLE IF NOT EXISTS defect_workflow_records (
    id TEXT PRIMARY KEY, parent_task_id TEXT NOT NULL REFERENCES tasks(id), defect_task_id TEXT NOT NULL REFERENCES tasks(id),
    parent_run_id TEXT NOT NULL REFERENCES digital_team_workflow_runs(id), verification_node_id TEXT NOT NULL, source_attempt_id TEXT NOT NULL,
    problem_key TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, reproduction_evidence_json TEXT NOT NULL CHECK(json_valid(reproduction_evidence_json)),
    tested_repository_id TEXT NOT NULL, tested_head_sha TEXT NOT NULL, repair_run_id TEXT REFERENCES digital_team_workflow_runs(id),
    repair_results_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(repair_results_json)), status TEXT NOT NULL CHECK(status IN ('open','repairing','awaiting_retest','accepted','risk_accepted','blocked')),
    risk_reason TEXT, risk_actor_id TEXT, revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(parent_task_id, problem_key), UNIQUE(defect_task_id))`);
  db.execute('CREATE INDEX IF NOT EXISTS idx_defect_workflow_parent_run ON defect_workflow_records(parent_run_id, status)');
  db.execute('CREATE TABLE IF NOT EXISTS digital_team_repair_round_receipts (acceptance_round_id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), used_round INTEGER NOT NULL)');
}

/** 复用问题身份与修复关系的正式缺陷仓库。 */
export class DefectWorkflowRepository {
  /** 使用与任务、流程相同的 SQLite 事务边界。 */
  constructor(private readonly db: ZeusDatabasePort) {}

  /** 额度归属原任务，同一问题重新建运行也不能归零。 */
  getRepairRounds(taskId: string): number {
    return this.db.get<{ used_rounds: number }>('SELECT used_rounds FROM digital_team_task_repair_budgets WHERE task_id = ?', [taskId])?.used_rounds ?? 0;
  }

  /** 原子消耗一轮，多个缺陷共用同一父验收预算。 */
  consumeRepairRound(taskId: string, limit: number): number | null {
    this.db.execute('INSERT OR IGNORE INTO digital_team_task_repair_budgets(task_id,used_rounds) VALUES(?,0)', [taskId]);
    this.db.execute('UPDATE digital_team_task_repair_budgets SET used_rounds = used_rounds + 1 WHERE task_id = ? AND used_rounds < ?', [taskId, limit]);
    return this.db.get<{ count: number }>('SELECT changes() AS count')?.count === 1 ? this.getRepairRounds(taskId) : null;
  }

  /** 修复额度和本轮全部关系同一耐久事务接纳，重复事件和重启不能再扣一轮。 */
  admitRepairRound(runId: string, expectedRevision: number, taskId: string, limit: number, state: DigitalTeamRunRuntimeState): number | null {
    const round = state.verificationRound;
    if (!round || round.phase !== 'repairing') throw new Error('修复接纳缺少完整父验收轮。');
    return this.db.durableTransactionSync(() => {
      const current = this.db.get<{ revision: number; task_id: string }>('SELECT revision, task_id FROM digital_team_workflow_runs WHERE id = ?', [runId]);
      if (!current || current.task_id !== taskId || current.revision !== expectedRevision) throw new Error('父验收运行已变化，请重新核对。');
      const receipt = this.db.get<{ used_round: number; task_id: string }>('SELECT used_round, task_id FROM digital_team_repair_round_receipts WHERE acceptance_round_id = ?', [round.id]);
      if (receipt && receipt.task_id !== taskId) throw new Error('父验收轮不能跨任务消耗预算。');
      const usedRound = receipt?.used_round ?? this.consumeRepairRound(taskId, limit);
      if (usedRound === null) return null;
      if (!receipt) this.db.execute('INSERT INTO digital_team_repair_round_receipts(acceptance_round_id, task_id, used_round) VALUES(?,?,?)', [round.id, taskId, usedRound]);
      this.db.execute('UPDATE digital_team_workflow_runs SET runtime_state_json = ?, error_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?', [
        JSON.stringify({ ...state, repairRound: usedRound }),
        new Date().toISOString(),
        runId,
        expectedRevision,
      ]);
      return usedRound;
    });
  }

  /** 读取父流程所有正式缺陷，包括已验收的历史问题。 */
  listByRun(runId: string): DefectWorkflowRecord[] {
    return this.db.select<Record<string, unknown>>('SELECT * FROM defect_workflow_records WHERE parent_run_id = ? ORDER BY created_at, id', [runId]).map(mapDefect);
  }

  /** 同一问题复验失败继续原子任务，不重复创建缺陷。 */
  getByProblem(parentTaskId: string, key: string): DefectWorkflowRecord | undefined {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM defect_workflow_records WHERE parent_task_id = ? AND problem_key = ?', [parentTaskId, key]);
    return row ? mapDefect(row) : undefined;
  }

  /** 缺陷身份由父任务与问题身份确定，重试不会新建单。 */
  identity(parentTaskId: string, key: string): string {
    return `defect_${createHash('sha256').update(`${parentTaskId}\0${key}`).digest('hex').slice(0, 28)}`;
  }

  /** 登记准确测试现场；调用方先核对真实复现证据并创建同项目子任务。 */
  register(input: DigitalTeamDefectSubmission & { parentTaskId: string; defectTaskId: string; parentRunId: string; verificationNodeId: string; sourceAttemptId: string }): DefectWorkflowRecord {
    const task = this.db.get<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = ?', [input.parentTaskId]);
    const child = this.db.get<{ project_id: string; task_type: string }>('SELECT project_id, task_type FROM tasks WHERE id = ?', [input.defectTaskId]);
    if (!task || !child || task.project_id !== child.project_id || child.task_type !== 'defect') throw new Error('缺陷子任务必须是当前项目的 defect 任务。');
    const timestamp = new Date().toISOString();
    this.db.execute(
      `INSERT INTO defect_workflow_records(id,parent_task_id,defect_task_id,parent_run_id,verification_node_id,source_attempt_id,problem_key,title,description,reproduction_evidence_json,tested_repository_id,tested_head_sha,status,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'open',?,?) ON CONFLICT(parent_task_id,problem_key) DO UPDATE SET parent_run_id=excluded.parent_run_id, verification_node_id=excluded.verification_node_id, source_attempt_id=excluded.source_attempt_id, title=excluded.title, description=excluded.description, reproduction_evidence_json=excluded.reproduction_evidence_json, tested_repository_id=excluded.tested_repository_id, tested_head_sha=excluded.tested_head_sha, status='open', risk_reason=NULL, risk_actor_id=NULL, revision=revision+1, updated_at=excluded.updated_at`,
      [
        this.identity(input.parentTaskId, input.key),
        input.parentTaskId,
        input.defectTaskId,
        input.parentRunId,
        input.verificationNodeId,
        input.sourceAttemptId,
        input.key,
        input.title,
        input.description,
        JSON.stringify(input.reproductionEvidence),
        input.repositoryId,
        input.headSha,
        timestamp,
        timestamp,
      ],
    );
    return this.getByProblem(input.parentTaskId, input.key)!;
  }

  /** 绑定唯一修复流程，保留父流程的累计轮数。 */
  bindRepair(id: string, runId: string): void {
    this.db.execute("UPDATE defect_workflow_records SET repair_run_id = ?, status = 'repairing', revision = revision + 1, updated_at = ? WHERE id = ? AND status = 'open'", [runId, new Date().toISOString(), id]);
  }

  /** 只接纳真实修复提交，父流程等待成果而非等待子任务关闭。 */
  submitRepair(id: string, runId: string, results: DigitalTeamRepositoryResult[]): void {
    if (!results.length || results.some((result) => !/^[a-f0-9]{40}$/.test(result.headSha))) throw new Error('修复缺少准确代码成果。');
    this.db.execute("UPDATE defect_workflow_records SET repair_results_json = ?, status = 'awaiting_retest', revision = revision + 1, updated_at = ? WHERE id = ? AND repair_run_id = ? AND status = 'repairing'", [
      JSON.stringify(results),
      new Date().toISOString(),
      id,
      runId,
    ]);
  }

  /** 人工改派产生的真实修复同样必须从原被测现场开始，再等待父复验。 */
  submitManualRepair(id: string, parentRunId: string, results: DigitalTeamRepositoryResult[]): void {
    this.db.execute(
      "UPDATE defect_workflow_records SET repair_run_id = ?, repair_results_json = ?, status = 'awaiting_retest', revision = revision + 1, updated_at = ? WHERE id = ? AND parent_run_id = ? AND status IN ('open','repairing')",
      [parentRunId, JSON.stringify(results), new Date().toISOString(), id, parentRunId],
    );
  }

  /** 准确新候选通过父流程复验后才关闭正式缺陷。 */
  acceptRetest(parentRunId: string, verificationNodeId: string): void {
    this.db.execute("UPDATE defect_workflow_records SET status = 'accepted', revision = revision + 1, updated_at = ? WHERE parent_run_id = ? AND verification_node_id = ? AND status = 'awaiting_retest'", [
      new Date().toISOString(),
      parentRunId,
      verificationNodeId,
    ]);
  }

  /** 人工接受风险必须保存真实理由，单独状态不产生测试通过记录。 */
  acceptRisk(id: string, reason: string, actorId: string): void {
    if (!reason.trim() || !actorId.trim()) throw new Error('接受风险需要真实用户身份和明确理由。');
    this.db.execute("UPDATE defect_workflow_records SET status = 'risk_accepted', risk_reason = ?, risk_actor_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?", [reason.trim(), actorId, new Date().toISOString(), id]);
  }
}

/** 将 SQLite 缺陷记录还原为受控公开投影。 */
function mapDefect(row: Record<string, unknown>): DefectWorkflowRecord {
  return {
    id: String(row.id),
    parentTaskId: String(row.parent_task_id),
    defectTaskId: String(row.defect_task_id),
    parentRunId: String(row.parent_run_id),
    verificationNodeId: String(row.verification_node_id),
    sourceAttemptId: String(row.source_attempt_id),
    key: String(row.problem_key),
    title: String(row.title),
    description: String(row.description),
    reproductionEvidence: JSON.parse(String(row.reproduction_evidence_json)) as string[],
    repositoryId: String(row.tested_repository_id),
    headSha: String(row.tested_head_sha),
    repairRunId: row.repair_run_id ? String(row.repair_run_id) : null,
    repairResults: JSON.parse(String(row.repair_results_json)) as DigitalTeamRepositoryResult[],
    status: row.status as DefectWorkflowStatus,
    riskReason: row.risk_reason ? String(row.risk_reason) : null,
    riskActorId: row.risk_actor_id ? String(row.risk_actor_id) : null,
    revision: Number(row.revision),
  };
}
