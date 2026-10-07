import { digitalTeamExecutionDefinition, type DigitalTeamNode, type DigitalTeamNodeAttemptRecord, type DigitalTeamRunStatus, type DigitalTeamWorkflowRunRecord } from '@zeus/shared';
import type { DigitalTeamRunProjection } from './digitalTeamApiClient.js';

/** 运行阶段的中文标签沿用既有团队页面含义。 */
const chineseRunStatusLabels: Record<DigitalTeamRunStatus, string> = {
  planning: '负责人规划中',
  awaiting_plan_approval: '等待规划批准',
  executing: '员工执行中',
  integrating: '正在集成候选',
  verifying: '正在核对成果',
  summarizing: '成果汇总中',
  awaiting_final_approval: '等待最终验收',
  completed: '已完成',
  failed: '失败',
  outcome_unknown: '结果待核对',
  cancelled: '已取消',
};

/** 英文界面使用相同运行阶段，不从最终消息推断流程已经完成。 */
const englishRunStatusLabels: Record<DigitalTeamRunStatus, string> = {
  planning: 'Lead planning',
  awaiting_plan_approval: 'Awaiting plan approval',
  executing: 'Employees working',
  integrating: 'Integrating candidate',
  verifying: 'Verifying results',
  summarizing: 'Summarizing results',
  awaiting_final_approval: 'Awaiting final acceptance',
  completed: 'Completed',
  failed: 'Failed',
  outcome_unknown: 'Outcome needs review',
  cancelled: 'Cancelled',
};

/** 当前流程受阻入口保留原始节点与尝试，供各页面打开准确会话或运行记录。 */
export interface DigitalTeamRunBlocker {
  /** 当前冻结执行图中的节点身份。 */
  nodeId: string;
  /** 创建运行时冻结的员工名称，缺少时使用节点标题。 */
  nodeName: string;
  /** 当前问题尝试对应的会话，尚未派发时为空。 */
  conversationId: string | null;
  /** 原始冻结节点，不改写职责、执行模式或授权。 */
  node: DigitalTeamNode;
  /** 原始当前尝试，保留错误身份、状态与正式结果。 */
  attempt: DigitalTeamNodeAttemptRecord;
  /** 可直接展示的原因，优先使用员工明确列出的剩余问题。 */
  reason: string;
  /** 首屏只描述当前业务状态，原始长原因留在详情中。 */
  summary: string;
  /** 原始剩余问题列表，不覆盖错误说明或删除诊断资料。 */
  remainingIssues: readonly string[];
}

/** 展示父运行真实阶段；节点确定失败时说明团队受阻，失败终态仍可由用户显式返工。 */
export function digitalTeamRunStatusLabel(run: DigitalTeamWorkflowRunRecord, zh = true): string {
  if (run.error?.code === 'ZEUS_DIGITAL_TEAM_NODE_FAILED') return zh ? '团队受阻' : 'Team blocked';
  return (zh ? chineseRunStatusLabels : englishRunStatusLabels)[run.status] ?? run.status;
}

/** 只依据当前有效尝试寻找首个问题节点，较新尝试会替代原失败记录。 */
export function getDigitalTeamRunBlocker(projection: DigitalTeamRunProjection, zh = true): DigitalTeamRunBlocker | null {
  /** 当前接口已筛选有效尝试；重复条目仍按尝试号和修订选取最新事实。 */
  const currentByNodeId = new Map<string, DigitalTeamNodeAttemptRecord>();
  for (const attempt of projection.currentAttempts) {
    /** 同一节点先前的当前条目，不能用较旧失败覆盖新执行或成功。 */
    const previous = currentByNodeId.get(attempt.nodeId);
    if (!previous || attempt.attempt > previous.attempt || (attempt.attempt === previous.attempt && attempt.revision > previous.revision)) currentByNodeId.set(attempt.nodeId, attempt);
  }
  for (const node of digitalTeamExecutionDefinition(projection.run).nodes) {
    /** 执行图顺序决定首个展示的问题节点，不从历史尝试猜测当前状态。 */
    const attempt = currentByNodeId.get(node.id);
    if (!attempt || !isBlockingAttempt(attempt)) continue;
    /** 原剩余问题保留在投影中，展示仅跳过空白项。 */
    const remainingIssues = attempt.result?.remainingIssues ?? [];
    /** 保留业务原因原文，界面语言不会翻译员工提交的诊断。 */
    const reason =
      remainingIssues.filter((issue) => issue.trim()).join(zh ? '；' : '; ') || nonEmptyText(attempt.error?.message) || nonEmptyText(attempt.approval?.reason) || nonEmptyText(attempt.result?.summary) || blockingAttemptFallback(attempt, zh);
    /** 员工名称只能来自本次运行冻结的身份，避免读取后来改名或改绑的员工。 */
    const employeeName = node.type === 'employee' ? projection.run.roleSnapshots.find((snapshot) => snapshot.employeeId === node.data.employeeId)?.configuration.name : undefined;
    return {
      nodeId: node.id,
      nodeName: nonEmptyText(employeeName) || nonEmptyText(node.data.title) || (zh ? '团队节点' : 'Team step'),
      conversationId: attempt.conversationId,
      node,
      attempt,
      reason,
      summary: blockingAttemptFallback(attempt, zh),
      remainingIssues,
    };
  }
  return null;
}

/** 只读说明仅描述这次冻结运行，不把历史分工当成当前可编辑流程的能力。 */
export function digitalTeamRunReadOnlyDescription(run: DigitalTeamWorkflowRunRecord, zh = true): string | null {
  /** 人工入口可能只执行冻结图中的后续节点，必须核对实际执行范围。 */
  const employees = digitalTeamExecutionDefinition(run).nodes.filter((node) => node.type === 'employee');
  if (!employees.length || employees.some((node) => node.data.executionMode !== 'read_only')) return null;
  return zh ? '本次运行仅执行只读工作，未安排代码修改' : 'This run uses read-only work and does not include code changes';
}

/** 失败、未知结果、人工退回和当前已报告的阻塞都需要可见入口；失效历史不再阻挡新尝试。 */
function isBlockingAttempt(attempt: DigitalTeamNodeAttemptRecord): boolean {
  return ['failed', 'outcome_unknown', 'changes_requested'].includes(attempt.status) || (attempt.status === 'active' && attempt.result?.outcome === 'blocked');
}

/** 未提供具体原因时按真实尝试状态提示，不把未知结果或待核验声明称作失败。 */
function blockingAttemptFallback(attempt: DigitalTeamNodeAttemptRecord, zh: boolean): string {
  if (attempt.status === 'outcome_unknown') return zh ? '本次执行结果尚未确认，需要核对原会话。' : 'The outcome is unconfirmed. Review the original conversation.';
  if (attempt.status === 'changes_requested') return zh ? '上游成果已被退回，需要修改后继续。' : 'The upstream result needs changes before continuing.';
  if (attempt.status === 'active') return zh ? '员工报告了阻塞，请查看分工。' : 'The employee reported a blocker. Review the assignment.';
  if (attempt.result?.outcome === 'blocked') return zh ? '分工受阻，请查看原因后处理。' : 'The assignment is blocked. Review the cause to continue.';
  return zh ? '分工未通过，请查看原因后返工。' : 'The assignment did not pass. Review the cause before rework.';
}

/** 只检查文字是否可读，不修改错误原因或冻结名称的原文。 */
function nonEmptyText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
