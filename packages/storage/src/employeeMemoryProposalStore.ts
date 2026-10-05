import { createHash } from 'node:crypto';
import type { ZeusDatabasePort } from './databasePort.js';
import { LongTermMemoryRepository, LongTermMemoryStoreError, type LongTermMemoryKind } from './longTermMemoryStore.js';
import { TaskWorkStoreError } from './taskWorkStore.js';

/** 员工经验保留来源候选；只有用户预先授权的项目稳定经验可以自动接纳。 */
export interface EmployeeMemoryProposal {
  /** 与现行经验冲突时仍待处理，不覆盖现行内容。 */
  conflictReason?: string;
  /** 固定工具调用对应的建议身份。 */
  id: string;
  /** 所属项目与个人范围。 */
  projectId: string;
  /** 提出建议的员工。 */
  employeeId: string;
  /** 来源任务。 */
  taskId: string;
  /** 来源工作运行，保留原会话入口。 */
  runId: string;
  /** 可读主题。 */
  topic: string;
  /** 候选经验类别。 */
  kind: LongTermMemoryKind;
  /** 原始建议正文，接纳修改不覆盖原文。 */
  content: string;
  /** 适用范围、根据与例外。 */
  reason: string;
  /** 审核结果。 */
  status: 'pending' | 'accepted' | 'rejected';
  /** 实际接纳的记忆身份。 */
  memoryId: string | null;
  /** 并发核对修订。 */
  revision: number;
  /** 首次提出时间。 */
  createdAt: string;
}

/** 候选账本独立于生效记忆，迁移不会自动接纳任何历史输出。 */
export function migrateEmployeeMemoryProposalSchema(db: ZeusDatabasePort): void {
  /** 迁移身份用于恢复时避免重复建表。 */
  const id = '20260910_employee_memory_proposals';
  if (db.get('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [id])) return;
  db.transaction(() => {
    db.execute(
      `CREATE TABLE employee_memory_proposals (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), employee_id TEXT NOT NULL REFERENCES digital_employees(id), task_id TEXT NOT NULL REFERENCES tasks(id), run_id TEXT NOT NULL REFERENCES task_work_runs(id), proposal_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')), memory_id TEXT REFERENCES long_term_memories(id), revision INTEGER NOT NULL, created_at TEXT NOT NULL)`,
    );
    db.execute('CREATE INDEX idx_employee_memory_proposals_employee ON employee_memory_proposals(employee_id, status, created_at)');
    db.execute('INSERT INTO schema_migrations(migration_id, description, checksum, applied_at) VALUES (?, ?, ?, ?)', [id, '员工经验建议先审查后生效', createHash('sha256').update(id).digest('hex'), new Date().toISOString()]);
  });
}

/** 建议与生效记忆在同一事务内接纳，不因重复点击生成多条经验。 */
export class EmployeeMemoryProposalRepository {
  /** 复用原数据库和业务时钟。 */
  constructor(
    private readonly db: ZeusDatabasePort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** 只读取当前项目内员工的建议。 */
  list(projectId: string, employeeId: string): EmployeeMemoryProposal[] {
    return this.db
      .select<{
        proposal_json: string;
        status: EmployeeMemoryProposal['status'];
        memory_id: string | null;
        revision: number;
      }>('SELECT * FROM employee_memory_proposals WHERE project_id = ? AND employee_id = ? ORDER BY created_at DESC, id', [projectId, employeeId])
      .map((row) => ({ ...JSON.parse(row.proposal_json), status: row.status, memoryId: row.memory_id, revision: row.revision }));
  }

  /** 工具调用身份固定来源，所有文本必须在业务入口完整校验。 */
  propose(input: Omit<EmployeeMemoryProposal, 'status' | 'memoryId' | 'revision' | 'createdAt'>): EmployeeMemoryProposal {
    return this.db.transaction(() => {
      /** 重复调用返回原建议，不能用同一身份替换正文。 */
      const existing = this.list(input.projectId, input.employeeId).find((record) => record.id === input.id);
      if (existing) return existing;
      /** 外键只能保证身份存在，这里同时保证员工、任务与运行属于同一项目。 */
      const run = this.db.get<{ entrypoint_snapshot_json: string }>('SELECT entrypoint_snapshot_json FROM task_work_runs WHERE id = ? AND project_id = ? AND task_id = ? AND employee_id = ?', [
        input.runId,
        input.projectId,
        input.taskId,
        input.employeeId,
      ]);
      if (!run) throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_SCOPE', '经验建议与来源工作不匹配。');
      const proposal: EmployeeMemoryProposal = { ...input, status: 'pending', memoryId: null, revision: 1, createdAt: this.now() };
      this.db.execute("INSERT INTO employee_memory_proposals(id, project_id, employee_id, task_id, run_id, proposal_json, status, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', 1, ?)", [
        proposal.id,
        input.projectId,
        input.employeeId,
        input.taskId,
        input.runId,
        JSON.stringify(proposal),
        proposal.createdAt,
      ]);
      /** 自动生效只使用本轮冻结规则，经验半年后须复核，不永久信任模型归纳。 */
      const policy = JSON.parse(run.entrypoint_snapshot_json).projectMemoryPolicy;
      if (
        ['stable_workflow', 'domain_knowledge'].includes(input.kind) &&
        policy?.autoApplyStableExperience === true &&
        policy.projectId === input.projectId &&
        typeof policy.workflowTemplateId === 'string' &&
        policy.workflowTemplateId.length > 0 &&
        policy.workflowTemplateId.length <= 256 &&
        Number.isSafeInteger(policy.workflowTemplateRevision) &&
        policy.workflowTemplateRevision > 0
      )
        return this.applyDecision(
          input.projectId,
          input.employeeId,
          input.id,
          { expectedRevision: proposal.revision, accept: true, topic: input.topic, content: input.content, reviewAfter: new Date(Date.parse(proposal.createdAt) + 180 * 24 * 60 * 60 * 1_000).toISOString() },
          policy,
        );
      return proposal;
    });
  }

  /** 明确接纳可以修正正文；拒绝只保留审核结果，不生成记忆。 */
  decide(projectId: string, employeeId: string, id: string, input: { expectedRevision: number; accept: boolean; topic: string; content: string; reviewAfter: string }): EmployeeMemoryProposal {
    return this.applyDecision(projectId, employeeId, id, input);
  }

  /** 自动与人工接纳共用冲突保护，自动来源不伪造用户逐条审核。 */
  private applyDecision(
    projectId: string,
    employeeId: string,
    id: string,
    input: { expectedRevision: number; accept: boolean; topic: string; content: string; reviewAfter: string },
    policy?: { workflowTemplateId: string; workflowTemplateRevision: number },
  ): EmployeeMemoryProposal {
    return this.db.transaction(() => {
      const proposal = this.list(projectId, employeeId).find((record) => record.id === id);
      if (!proposal || proposal.status !== 'pending' || proposal.revision !== input.expectedRevision) throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_CHANGED', '经验建议已处理或发生变化，请重新读取。');
      let memoryId: string | null = null;
      if (input.accept) {
        /** 同主题的明确项目或全局规则冲突时保留待处理建议，不借员工优先级隐式覆盖。 */
        const effective = new LongTermMemoryRepository(this.db).resolveForContext({ projectId, employeeId, asOf: this.now() }).selected;
        const conflict = effective.find((record) => record.memoryKey === input.topic && record.content.trim() !== input.content.trim());
        if (conflict) {
          this.db.execute('UPDATE employee_memory_proposals SET proposal_json=?,revision=revision+1 WHERE id=? AND revision=?', [
            JSON.stringify({ ...proposal, conflictReason: `与现行经验 ${conflict.id} 冲突，请明确修正规则或原经验后再处理。` }),
            id,
            input.expectedRevision,
          ]);
          return this.list(projectId, employeeId).find((record) => record.id === id)!;
        }
        try {
          const result = new LongTermMemoryRepository(this.db).recordCandidate({
            id: `employee_memory_${id}`,
            scope: { kind: 'employee', id: employeeId },
            /** 用户审查一条项目经验并不等于同意跨项目推广。 */
            projectLimitId: projectId,
            memoryKey: input.topic,
            candidateKind: proposal.kind,
            content: input.content,
            effect: 'advisory',
            source: {
              kind: policy ? 'project_instruction' : 'user_explicit',
              reference: `${policy ? `project:${projectId}/workflow:${policy.workflowTemplateId}/revision:${policy.workflowTemplateRevision}/` : ''}task:${proposal.taskId}/work-run:${proposal.runId}/proposal:${proposal.id}`,
              observedAt: proposal.createdAt,
              contentSha256: createHash('sha256').update(proposal.content).digest('hex'),
            },
            confirmationLevel: policy ? 'confirmed' : 'explicit',
            confidence: 1,
            reviewAfter: input.reviewAfter,
            recordedAt: this.now(),
          });
          if (!result.accepted) throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_INVALID', '该内容不属于可长期使用的经验。');
          memoryId = result.record.id;
        } catch (error) {
          if (!(error instanceof LongTermMemoryStoreError) || error.code !== 'ZEUS_LONG_TERM_MEMORY_HEAD_CONFLICT') throw error;
          /** 已确认规则发生冲突时保留建议和原经验，交给用户明确修正。 */
          this.db.execute('UPDATE employee_memory_proposals SET proposal_json=?,revision=revision+1 WHERE id=? AND revision=?', [JSON.stringify({ ...proposal, conflictReason: error.message }), id, input.expectedRevision]);
          return this.list(projectId, employeeId).find((record) => record.id === id)!;
        }
      }
      this.db.execute('UPDATE employee_memory_proposals SET status = ?, memory_id = ?, revision = revision + 1 WHERE id = ? AND revision = ?', [input.accept ? 'accepted' : 'rejected', memoryId, id, input.expectedRevision]);
      return this.list(projectId, employeeId).find((record) => record.id === id)!;
    });
  }
}
