import type { CommandActorKind } from './commandEnvelope.js';

/** 数字团队流程定义的稳定结构身份。 */
export const digitalTeamWorkflowSchemaGeneration = 'digital-team-workflow-2026-09-15' as const;

/** 画布允许持久化的节点类型。 */
export const digitalTeamNodeTypes = ['start', 'employee', 'human_confirmation', 'code_integration', 'end'] as const;

/** 画布节点类型。 */
export type DigitalTeamNodeType = (typeof digitalTeamNodeTypes)[number];

/** 员工节点在研发闭环中的职责。 */
export const digitalTeamEmployeePurposes = ['plan', 'work', 'verify', 'summary'] as const;

/** 员工节点职责。 */
export type DigitalTeamEmployeePurpose = (typeof digitalTeamEmployeePurposes)[number];

/** 员工节点允许使用的代码现场。 */
export const digitalTeamExecutionModes = ['read_only', 'isolated_write', 'candidate_read_only'] as const;

/** 员工节点代码现场模式。 */
export type DigitalTeamExecutionMode = (typeof digitalTeamExecutionModes)[number];

/** 人工节点承担的批准类型。 */
export const digitalTeamApprovalPurposes = ['plan_approval', 'final_acceptance'] as const;

/** 人工批准类型。 */
export type DigitalTeamApprovalPurpose = (typeof digitalTeamApprovalPurposes)[number];

/** 流程运行阶段。 */
export const digitalTeamRunStatuses = ['planning', 'awaiting_plan_approval', 'executing', 'integrating', 'verifying', 'summarizing', 'awaiting_final_approval', 'completed', 'failed', 'outcome_unknown', 'cancelled'] as const;

/** 流程运行阶段类型。 */
export type DigitalTeamRunStatus = (typeof digitalTeamRunStatuses)[number];

/** 流程后续派发控制状态。 */
export const digitalTeamRunControlStates = ['running', 'paused', 'cancelled'] as const;

/** 流程后续派发控制状态类型。 */
export type DigitalTeamRunControlState = (typeof digitalTeamRunControlStates)[number];

/** 节点单次尝试状态。 */
export const digitalTeamNodeAttemptStatuses = ['prepared', 'dispatching', 'active', 'awaiting_approval', 'succeeded', 'changes_requested', 'invalidated', 'failed', 'outcome_unknown', 'cancelled'] as const;

/** 节点单次尝试状态类型。 */
export type DigitalTeamNodeAttemptStatus = (typeof digitalTeamNodeAttemptStatuses)[number];

/** React Flow 画布中的持久坐标。 */
export interface DigitalTeamNodePosition {
  /** 横向坐标。 */
  x: number;
  /** 纵向坐标。 */
  y: number;
}

/** React Flow 画布保存并重开时使用的视口。 */
export interface DigitalTeamViewport {
  /** 横向平移。 */
  x: number;
  /** 纵向平移。 */
  y: number;
  /** 缩放比例。 */
  zoom: number;
}

/** 所有画布节点共用的稳定字段。 */
interface DigitalTeamNodeBase<TType extends DigitalTeamNodeType, TData extends Record<string, unknown>> {
  /** 模板内稳定节点身份。 */
  id: string;
  /** 节点类型。 */
  type: TType;
  /** 画布坐标。 */
  position: DigitalTeamNodePosition;
  /** 节点配置。 */
  data: TData;
}

/** 开始节点配置。 */
export interface DigitalTeamStartNodeData extends Record<string, unknown> {
  /** 用户可读名称。 */
  title: string;
}

/** 结束节点配置。 */
export interface DigitalTeamEndNodeData extends Record<string, unknown> {
  /** 用户可读名称。 */
  title: string;
}

/** 员工节点配置。 */
export interface DigitalTeamEmployeeNodeData extends Record<string, unknown> {
  /** 用户可读名称。 */
  title: string;
  /** 项目数字员工身份。 */
  employeeId: string;
  /** 本节点在闭环中的职责。 */
  purpose: DigitalTeamEmployeePurpose;
  /** 本节点允许使用的代码现场。 */
  executionMode: DigitalTeamExecutionMode;
  /** 节点目标与完成标准。 */
  instructions: string;
  /** 候选验证节点必须逐条成功执行的精确命令；其他职责不使用。 */
  verificationCommands?: string[];
}

/** 人工确认节点配置。 */
export interface DigitalTeamHumanConfirmationNodeData extends Record<string, unknown> {
  /** 用户可读名称。 */
  title: string;
  /** 本节点承担的批准类型。 */
  purpose: DigitalTeamApprovalPurpose;
  /** 展示给审批人的核对要求。 */
  instructions: string;
}

/** 代码集成节点配置。 */
export interface DigitalTeamCodeIntegrationNodeData extends Record<string, unknown> {
  /** 用户可读名称。 */
  title: string;
  /** 首期固定使用合并提交，避免同一恢复账本维护多种历史语义。 */
  mode: 'merge';
  /** 集成候选的核对要求。 */
  instructions: string;
}

/** 开始节点。 */
export type DigitalTeamStartNode = DigitalTeamNodeBase<'start', DigitalTeamStartNodeData>;

/** 员工节点。 */
export type DigitalTeamEmployeeNode = DigitalTeamNodeBase<'employee', DigitalTeamEmployeeNodeData>;

/** 人工确认节点。 */
export type DigitalTeamHumanConfirmationNode = DigitalTeamNodeBase<'human_confirmation', DigitalTeamHumanConfirmationNodeData>;

/** 代码集成节点。 */
export type DigitalTeamCodeIntegrationNode = DigitalTeamNodeBase<'code_integration', DigitalTeamCodeIntegrationNodeData>;

/** 结束节点。 */
export type DigitalTeamEndNode = DigitalTeamNodeBase<'end', DigitalTeamEndNodeData>;

/** 数字团队画布节点。 */
export type DigitalTeamNode = DigitalTeamStartNode | DigitalTeamEmployeeNode | DigitalTeamHumanConfirmationNode | DigitalTeamCodeIntegrationNode | DigitalTeamEndNode;

/** 节点之间的有向依赖边。 */
export interface DigitalTeamEdge {
  /** 模板内稳定边身份。 */
  id: string;
  /** 上游节点身份。 */
  source: string;
  /** 下游节点身份。 */
  target: string;
}

/** 可保存和冻结的数字团队画布定义。 */
export interface DigitalTeamWorkflowDefinition {
  /** 结构身份。 */
  schemaGeneration: typeof digitalTeamWorkflowSchemaGeneration;
  /** 画布节点。 */
  nodes: DigitalTeamNode[];
  /** 有向依赖边。 */
  edges: DigitalTeamEdge[];
  /** 保存时的画布视口。 */
  viewport: DigitalTeamViewport;
}

/** 结构化规划中的单节点安排。 */
export interface DigitalTeamPlanAssignment {
  /** 对应员工实现节点身份。 */
  nodeId: string;
  /** 该节点的明确目标。 */
  objective: string;
  /** 本节点允许处理的范围。 */
  scope: string[];
  /** 本节点明确禁止处理的范围。 */
  excludedScope: string[];
  /** 可核对的完成标准。 */
  acceptanceCriteria: string[];
  /** 本节点必须形成的真实交付物。 */
  expectedDeliverables: string[];
}

/** CTO 提交的结构化规划。 */
export interface DigitalTeamStructuredPlan {
  /** 规划摘要。 */
  summary: string;
  /** 按节点身份提交的实现安排。 */
  assignments: DigitalTeamPlanAssignment[];
}

/** 节点结果引用的机器证据。 */
export interface DigitalTeamResultEvidence {
  /** 证据种类。 */
  kind: 'message' | 'change_set' | 'command' | 'artifact' | 'git_candidate';
  /** 来源记录身份。 */
  id: string;
  /** 来源内容摘要。 */
  sha256: string;
  /** 来源的真实状态。 */
  status: string;
}

/** 单仓代码结果。 */
export interface DigitalTeamRepositoryResult {
  /** 项目仓库身份。 */
  repositoryId: string;
  /** 本节点接收的固定上游提交。 */
  baseSha: string;
  /** 本节点实际产出的提交。 */
  headSha: string;
}

/** 员工节点提交的结构化结果。 */
export interface DigitalTeamStructuredResult {
  /** 节点依据证据声明的业务结果。 */
  outcome: 'succeeded' | 'failed' | 'blocked';
  /** 本节点实际验证结论。 */
  verification: 'passed' | 'failed' | 'not_run';
  /** 结果摘要，不单独作为完成依据。 */
  summary: string;
  /** 本次尝试的真实证据。 */
  evidence: DigitalTeamResultEvidence[];
  /** 写入节点的逐仓代码结果。 */
  repositoryResults: DigitalTeamRepositoryResult[];
  /** 验证节点实际核对的逐仓候选提交。 */
  verifiedCandidates: Array<{ repositoryId: string; headSha: string }>;
  /** 长产物的受控 ArtifactRef JSON；正文不进入结果记录。 */
  artifactRefs: Record<string, unknown>[];
  /** 尚未解决、不能隐藏的问题。 */
  remainingIssues: string[];
}

/** 一条项目内可复制、删除和重开的流程模板投影。 */
export interface DigitalTeamWorkflowTemplateRecord {
  /** 模板身份。 */
  id: string;
  /** 所属项目。 */
  projectId: string;
  /** 模板名称。 */
  name: string;
  /** 模板用途说明。 */
  description: string;
  /** 可继续编辑的画布定义。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 当前草稿是否可以创建运行。 */
  ready: boolean;
  /** 当前画布的完整校验问题。 */
  validationIssues: DigitalTeamWorkflowValidationIssue[];
  /** 乐观并发修订。 */
  revision: number;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
}

/** 创建运行时冻结的项目数字员工配置。 */
export interface DigitalTeamRoleSnapshot {
  /** 数字员工身份。 */
  employeeId: string;
  /** 数字员工修订。 */
  employeeRevision: number;
  /** 不含凭据的完整员工配置。 */
  configuration: Record<string, unknown>;
}

/** 创建运行时冻结的逐仓基线。 */
export interface DigitalTeamBaseRevision {
  /** 项目仓库身份。 */
  repositoryId: string;
  /** 来源分支或引用。 */
  sourceRef: string;
  /** 完整来源提交。 */
  baseSha: string;
}

/** 当前逐仓集成候选。 */
export interface DigitalTeamCandidateRevision {
  /** 项目仓库身份。 */
  repositoryId: string;
  /** 候选提交。 */
  headSha: string;
  /** 隔离候选工作区身份或路径引用。 */
  workspaceRef: string;
}

/** 一次数字团队运行的冻结事实与当前阶段投影。 */
export interface DigitalTeamWorkflowRunRecord {
  /** 运行身份。 */
  id: string;
  /** 所属项目。 */
  projectId: string;
  /** 所属任务。 */
  taskId: string;
  /** 来源模板；直接从合法画布运行时为空。 */
  templateId: string | null;
  /** 创建运行时的模板修订。 */
  templateRevision: number | null;
  /** 创建运行时冻结的画布。 */
  definitionSnapshot: DigitalTeamWorkflowDefinition;
  /** 创建运行时一次冻结的全部角色配置。 */
  roleSnapshots: DigitalTeamRoleSnapshot[];
  /** 创建运行时冻结的任务事实。 */
  taskFacts: Record<string, unknown>;
  /** 创建运行时冻结的逐仓来源提交。 */
  baseRevisions: DigitalTeamBaseRevision[];
  /** CTO 规划和汇总复用的主会话。 */
  mainConversationId: string | null;
  /** 当前流程阶段。 */
  status: DigitalTeamRunStatus;
  /** 后续派发控制状态。 */
  controlState: DigitalTeamRunControlState;
  /** 最近一次结构化规划。 */
  plan: DigitalTeamStructuredPlan | null;
  /** 规划代次。 */
  planVersion: number;
  /** 规划内容摘要。 */
  planSha256: string | null;
  /** 已批准的规划摘要。 */
  approvedPlanSha256: string | null;
  /** 批准规划的用户身份。 */
  planApprovedBy: string | null;
  /** 规划批准时间。 */
  planApprovedAt: string | null;
  /** 当前逐仓集成候选。 */
  candidateRevisions: DigitalTeamCandidateRevision[];
  /** 当前候选集合摘要。 */
  candidateSetSha256: string | null;
  /** 最终验收绑定的候选集合摘要。 */
  finalApprovedCandidateSetSha256: string | null;
  /** 最终验收用户身份。 */
  finalApprovedBy: string | null;
  /** 最终验收时间。 */
  finalApprovedAt: string | null;
  /** 失败或未知结果说明。 */
  error: Record<string, unknown> | null;
  /** 乐观并发修订。 */
  revision: number;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
  /** 流程完成时间。 */
  completedAt: string | null;
}

/** 人工决定中冻结的批准事实。 */
export interface DigitalTeamApprovalDecision {
  /** 批准类型。 */
  purpose: DigitalTeamApprovalPurpose;
  /** 批准或要求返工。 */
  decision: 'approved' | 'changes_requested';
  /** 发起决定的真实 actor 种类。 */
  actorKind: CommandActorKind;
  /** 发起决定的稳定 actor 身份。 */
  actorId: string;
  /** 批准绑定的规划或候选摘要。 */
  boundSha256: string;
  /** 用户提供的说明。 */
  reason: string;
}

/** 节点一次不可覆盖的执行尝试投影。 */
export interface DigitalTeamNodeAttemptRecord {
  /** 尝试身份。 */
  id: string;
  /** 所属运行。 */
  runId: string;
  /** 模板内节点身份。 */
  nodeId: string;
  /** 冻结的节点类型。 */
  nodeType: DigitalTeamNodeType;
  /** 节点内单调递增尝试号。 */
  attempt: number;
  /** 尝试状态。 */
  status: DigitalTeamNodeAttemptStatus;
  /** 本次尝试输入摘要。 */
  inputSha256: string;
  /** 当前尝试使用的规划代次。 */
  planVersion: number | null;
  /** 真实员工工作项。 */
  workItemId: string | null;
  /** 真实员工工作运行。 */
  workRunId: string | null;
  /** 本次尝试会话。 */
  conversationId: string | null;
  /** 本次 Provider 写入提交。 */
  submissionId: string | null;
  /** 本次 Provider 轮次。 */
  turnId: string | null;
  /** 本次运行片段。 */
  segmentId: string | null;
  /** 本次工作环境。 */
  environmentId: string | null;
  /** 本次工作区。 */
  workspaceId: string | null;
  /** 发起外部动作的 Command。 */
  commandId: string | null;
  /** 外部动作的稳定幂等身份。 */
  externalOperationId: string | null;
  /** 员工结构化结果。 */
  result: DigitalTeamStructuredResult | null;
  /** 员工交付物身份。 */
  deliverableId: string | null;
  /** 员工交付物版本。 */
  deliverableVersion: number | null;
  /** 长产物受控读取引用。 */
  artifactRef: Record<string, unknown> | null;
  /** 本次验证实际绑定的候选集合摘要。 */
  verifiedCandidateSetSha256: string | null;
  /** 人工批准事实。 */
  approval: DigitalTeamApprovalDecision | null;
  /** 使当前结果失效的返工尝试。 */
  invalidatedByAttemptId: string | null;
  /** 当前结果失效原因。 */
  invalidationReason: string | null;
  /** 失败或未知结果说明。 */
  error: Record<string, unknown> | null;
  /** 乐观并发修订。 */
  revision: number;
  /** 开始时间。 */
  startedAt: string | null;
  /** 结束时间。 */
  completedAt: string | null;
  /** 创建时间。 */
  createdAt: string;
  /** 更新时间。 */
  updatedAt: string;
}

/** 模板新增输入。 */
export interface CreateDigitalTeamWorkflowTemplateInput {
  /** 可选稳定身份。 */
  id?: string;
  /** 所属项目。 */
  projectId: string;
  /** 模板名称。 */
  name: string;
  /** 模板用途说明。 */
  description: string;
  /** 即使尚未通过完整校验也可保存的画布草稿。 */
  definition: DigitalTeamWorkflowDefinition;
}

/** 模板修改输入。 */
export interface UpdateDigitalTeamWorkflowTemplateInput {
  /** 客户端读取到的修订。 */
  expectedRevision: number;
  /** 新模板名称。 */
  name?: string;
  /** 新模板用途说明。 */
  description?: string;
  /** 新画布草稿。 */
  definition?: DigitalTeamWorkflowDefinition;
}

/** 新建运行输入。 */
export interface CreateDigitalTeamWorkflowRunInput {
  /** 可选稳定运行身份。 */
  id?: string;
  /** 所属项目。 */
  projectId: string;
  /** 所属任务。 */
  taskId: string;
  /** 可选来源模板。 */
  templateId?: string | null;
  /** 读取来源模板时的修订。 */
  templateRevision?: number | null;
  /** 需要完整通过校验的画布定义。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 当前任务冻结事实。 */
  taskFacts: Record<string, unknown>;
  /** 逐仓来源提交。 */
  baseRevisions: DigitalTeamBaseRevision[];
}

/** 运行通用修改输入。 */
export interface UpdateDigitalTeamWorkflowRunInput {
  /** 客户端读取到的修订。 */
  expectedRevision: number;
  /** 新流程阶段。 */
  status?: DigitalTeamRunStatus;
  /** 新派发控制状态。 */
  controlState?: DigitalTeamRunControlState;
  /** CTO 主会话身份。 */
  mainConversationId?: string | null;
  /** 新集成候选。 */
  candidateRevisions?: DigitalTeamCandidateRevision[];
  /** 新错误说明。 */
  error?: Record<string, unknown> | null;
  /** 完成时间。 */
  completedAt?: string | null;
}

/** 新建节点尝试输入。 */
export interface CreateDigitalTeamNodeAttemptInput {
  /** 可选稳定尝试身份。 */
  id?: string;
  /** 所属运行。 */
  runId: string;
  /** 模板内节点身份。 */
  nodeId: string;
  /** 本次输入摘要。 */
  inputSha256: string;
  /** 当前规划代次。 */
  planVersion?: number | null;
  /** 人工节点可直接进入等待批准。 */
  status?: Extract<DigitalTeamNodeAttemptStatus, 'prepared' | 'awaiting_approval'>;
}

/** 节点尝试通用修改输入。 */
export interface UpdateDigitalTeamNodeAttemptInput {
  /** 客户端读取到的修订。 */
  expectedRevision: number;
  /** 新尝试状态。 */
  status?: DigitalTeamNodeAttemptStatus;
  /** 真实员工工作项。 */
  workItemId?: string | null;
  /** 真实员工工作运行。 */
  workRunId?: string | null;
  /** 当前会话。 */
  conversationId?: string | null;
  /** 当前 Provider 写入提交。 */
  submissionId?: string | null;
  /** 当前 Provider 轮次。 */
  turnId?: string | null;
  /** 当前运行片段。 */
  segmentId?: string | null;
  /** 当前工作环境。 */
  environmentId?: string | null;
  /** 当前工作区。 */
  workspaceId?: string | null;
  /** 当前 Command。 */
  commandId?: string | null;
  /** 当前外部动作身份。 */
  externalOperationId?: string | null;
  /** 员工结构化结果。 */
  result?: DigitalTeamStructuredResult | null;
  /** 员工交付物身份。 */
  deliverableId?: string | null;
  /** 员工交付物版本。 */
  deliverableVersion?: number | null;
  /** 长产物引用。 */
  artifactRef?: Record<string, unknown> | null;
  /** 验证绑定的候选集合摘要。 */
  verifiedCandidateSetSha256?: string | null;
  /** 人工批准事实。 */
  approval?: DigitalTeamApprovalDecision | null;
  /** 结构化错误。 */
  error?: Record<string, unknown> | null;
  /** 开始时间。 */
  startedAt?: string | null;
  /** 结束时间。 */
  completedAt?: string | null;
}

/** 流程定义校验问题。 */
export interface DigitalTeamWorkflowValidationIssue {
  /** 稳定问题代码。 */
  code: string;
  /** 用户可读说明。 */
  message: string;
  /** 关联节点身份。 */
  nodeId?: string;
  /** 关联边身份。 */
  edgeId?: string;
}

/** 流程定义不满足可运行条件时抛出的边界错误。 */
export class DigitalTeamWorkflowValidationError extends Error {
  /** 错误名称。 */
  readonly name = 'DigitalTeamWorkflowValidationError';

  /** 保存完整问题列表，调用方可以直接投影到画布。 */
  constructor(readonly issues: DigitalTeamWorkflowValidationIssue[]) {
    super(issues[0]?.message ?? '数字团队流程定义无效。');
  }
}

/** 校验草稿结构和完整研发闭环；返回空数组表示可以创建运行。 */
export function validateDigitalTeamWorkflowDefinition(value: unknown): DigitalTeamWorkflowValidationIssue[] {
  const issues: DigitalTeamWorkflowValidationIssue[] = [];
  if (!isRecord(value) || value.schemaGeneration !== digitalTeamWorkflowSchemaGeneration || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !isViewport(value.viewport)) {
    return [{ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SHAPE_INVALID', message: '流程定义缺少受支持的结构身份、节点或连线。' }];
  }
  if (value.nodes.length < 2 || value.nodes.length > 128 || value.edges.length > 512) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SIZE_INVALID', message: '流程需要 2 到 128 个节点，连线不能超过 512 条。' });
  }
  const nodes = value.nodes.filter(isNode);
  const edges = value.edges.filter(isEdge);
  if (nodes.length !== value.nodes.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', message: '流程包含字段不完整或配置无效的节点。' });
  if (edges.length !== value.edges.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID', message: '流程包含字段不完整的连线。' });
  const nodeById = new Map<string, DigitalTeamNode>();
  for (const node of nodes) {
    if (nodeById.has(node.id)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_DUPLICATE', message: '节点身份不能重复。', nodeId: node.id });
    nodeById.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  const edgePairs = new Set<string>();
  for (const edge of edges) {
    if (edgeIds.has(edge.id)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_DUPLICATE', message: '连线身份不能重复。', edgeId: edge.id });
    edgeIds.add(edge.id);
    const pair = `${edge.source}\0${edge.target}`;
    if (edgePairs.has(pair)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_DUPLICATE', message: '同一对节点不能重复连线。', edgeId: edge.id });
    edgePairs.add(pair);
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target) || edge.source === edge.target) {
      issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_ENDPOINT_INVALID', message: '连线必须连接两个不同的现有节点。', edgeId: edge.id });
    }
  }
  if (issues.some((issue) => ['ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_ENDPOINT_INVALID'].includes(issue.code))) return issues;

  const starts = nodes.filter((node) => node.type === 'start');
  const ends = nodes.filter((node) => node.type === 'end');
  const integrations = nodes.filter((node) => node.type === 'code_integration');
  const plans = employeesByPurpose(nodes, 'plan');
  const implementations = employeesByPurpose(nodes, 'work');
  const verifications = employeesByPurpose(nodes, 'verify');
  const summaries = employeesByPurpose(nodes, 'summary');
  const planApprovals = approvalsByPurpose(nodes, 'plan_approval');
  const finalApprovals = approvalsByPurpose(nodes, 'final_acceptance');
  requireExactlyOne(issues, starts, 'ZEUS_DIGITAL_TEAM_WORKFLOW_START_COUNT', '流程必须且只能有一个开始节点。');
  requireExactlyOne(issues, ends, 'ZEUS_DIGITAL_TEAM_WORKFLOW_END_COUNT', '流程必须且只能有一个结束节点。');
  requireExactlyOne(issues, plans, 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_COUNT', '流程必须且只能有一个 CTO 规划节点。');
  requireExactlyOne(issues, planApprovals, 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_APPROVAL_COUNT', '流程必须且只能有一个规划批准节点。');
  requireExactlyOne(issues, integrations, 'ZEUS_DIGITAL_TEAM_WORKFLOW_INTEGRATION_COUNT', '流程必须且只能有一个代码集成节点。');
  requireExactlyOne(issues, summaries, 'ZEUS_DIGITAL_TEAM_WORKFLOW_SUMMARY_COUNT', '流程必须且只能有一个 CTO 汇总节点。');
  requireExactlyOne(issues, finalApprovals, 'ZEUS_DIGITAL_TEAM_WORKFLOW_FINAL_APPROVAL_COUNT', '流程必须且只能有一个最终人工验收节点。');
  if (implementations.length === 0) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_IMPLEMENTATION_MISSING', message: '流程至少需要一个员工执行节点。' });
  if (implementations.some((node) => node.data.executionMode === 'candidate_read_only') || !implementations.some((node) => node.data.executionMode === 'isolated_write')) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_IMPLEMENTATION_MODE_INVALID', message: '执行节点允许只读或独立写入，且至少需要一个独立写入节点。' });
  }
  requireExactlyOne(issues, verifications, 'ZEUS_DIGITAL_TEAM_WORKFLOW_VERIFICATION_COUNT', '流程必须且只能有一个候选验证节点。');
  if (verifications.some((node) => node.data.executionMode !== 'candidate_read_only')) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_VERIFICATION_MODE_INVALID', message: '候选验证节点必须只读核对集成候选。' });
  if (verifications.some((node) => !Array.isArray(node.data.verificationCommands) || node.data.verificationCommands.length === 0)) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_VERIFICATION_COMMANDS_MISSING', message: '候选验证节点必须配置至少一条真实验证命令。' });
  }
  if (plans.some((node) => node.data.executionMode !== 'read_only') || summaries.some((node) => node.data.executionMode !== 'read_only')) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CTO_MODE_INVALID', message: 'CTO 规划与汇总节点必须保持只读。' });
  }
  if (plans.length === 1 && summaries.length === 1 && plans[0]!.data.employeeId !== summaries[0]!.data.employeeId) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CTO_IDENTITY_MISMATCH', message: 'CTO 规划与汇总必须复用同一员工身份。' });
  }
  if (issues.some((issue) => issue.code.endsWith('_COUNT') || issue.code.endsWith('_MISSING'))) return issues;

  const outgoing = adjacency(nodes, edges, 'outgoing');
  const incoming = adjacency(nodes, edges, 'incoming');
  const start = starts[0]!;
  const end = ends[0]!;
  if ((incoming.get(start.id)?.size ?? 0) > 0 || (outgoing.get(end.id)?.size ?? 0) > 0) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_TERMINAL_EDGE_INVALID', message: '开始节点不能有上游，结束节点不能有下游。' });
  }
  if (hasCycle(nodes, outgoing)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CYCLE', message: '流程必须是无环有向图。' });
  const fromStart = reachable(start.id, outgoing);
  const toEnd = reachable(end.id, incoming);
  for (const node of nodes) {
    if (!fromStart.has(node.id) || !toEnd.has(node.id)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_ORPHANED', message: '每个节点都必须位于开始到结束的有效路径上。', nodeId: node.id });
  }
  if (issues.some((issue) => issue.code === 'ZEUS_DIGITAL_TEAM_WORKFLOW_CYCLE' || issue.code === 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_ORPHANED')) return issues;

  const plan = plans[0]!;
  const planApproval = planApprovals[0]!;
  const integration = integrations[0]!;
  const summary = summaries[0]!;
  const finalApproval = finalApprovals[0]!;
  requireAncestor(issues, plan.id, planApproval.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_APPROVAL_BYPASS', '规划批准必须位于 CTO 规划之后。');
  for (const node of nodes.filter((candidate) => candidate.type === 'employee' && candidate.data.purpose !== 'plan')) {
    requireAncestor(issues, planApproval.id, node.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_APPROVAL_BYPASS', '规划批准前不能派发后续员工节点。', node.id);
  }
  for (const node of implementations) requireAncestor(issues, node.id, integration.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_INTEGRATION_BYPASS', '所有写入节点都必须汇合到代码集成节点。', node.id);
  for (const node of verifications) {
    requireAncestor(issues, integration.id, node.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_VERIFICATION_BYPASS', '候选验证必须位于代码集成之后。', node.id);
    requireAncestor(issues, node.id, summary.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_SUMMARY_BYPASS', 'CTO 汇总必须等待全部候选验证成功。', node.id);
  }
  requireAncestor(issues, summary.id, finalApproval.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_FINAL_APPROVAL_BYPASS', '最终人工验收必须位于 CTO 汇总之后。');
  requireAncestor(issues, finalApproval.id, end.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_END_BYPASS', '结束节点必须等待最终人工验收。');
  for (const gate of [planApproval, integration, summary, finalApproval]) {
    if (!dominatesEnd(gate.id, start.id, end.id, outgoing)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_GATE_BYPASS', message: '存在绕过批准、集成、汇总或最终验收的结束路径。', nodeId: gate.id });
  }
  if (!verifications.some((node) => dominatesEnd(node.id, integration.id, end.id, outgoing))) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_VERIFICATION_BYPASS', message: '至少一个候选验证节点必须成为代码集成到结束的必经节点。' });
  }
  return issues;
}

/** 在创建运行前强制要求完整合法的流程定义。 */
export function assertDigitalTeamWorkflowReady(value: unknown): asserts value is DigitalTeamWorkflowDefinition {
  const issues = validateDigitalTeamWorkflowDefinition(value);
  if (issues.length > 0) throw new DigitalTeamWorkflowValidationError(issues);
}

/** 校验 CTO 规划逐项覆盖全部实现节点且没有冒用其他节点。 */
export function validateDigitalTeamStructuredPlan(definition: DigitalTeamWorkflowDefinition, value: unknown): string[] {
  if (!isRecord(value) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.assignments)) return ['规划必须包含摘要和逐节点安排。'];
  const expected = definition.nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === 'work').map((node) => node.id);
  const actual = value.assignments.filter(isPlanAssignment).map((assignment) => assignment.nodeId);
  if (actual.length !== value.assignments.length) return ['规划安排必须包含节点、目标和完成标准。'];
  if (new Set(actual).size !== actual.length) return ['同一实现节点不能重复规划。'];
  if (expected.length !== actual.length || expected.some((nodeId) => !actual.includes(nodeId))) return ['规划必须且只能覆盖画布中的全部实现节点。'];
  return [];
}

/** 判断普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 判断稳定非空身份。 */
function isIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
}

/** 判断画布视口结构。 */
function isViewport(value: unknown): value is DigitalTeamViewport {
  return isRecord(value) && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.zoom) && (value.zoom as number) > 0;
}

/** 判断画布节点结构。 */
function isNode(value: unknown): value is DigitalTeamNode {
  if (
    !isRecord(value) ||
    !isIdentity(value.id) ||
    !digitalTeamNodeTypes.includes(value.type as DigitalTeamNodeType) ||
    !isRecord(value.position) ||
    !Number.isFinite(value.position.x) ||
    !Number.isFinite(value.position.y) ||
    !isRecord(value.data) ||
    typeof value.data.title !== 'string' ||
    !value.data.title.trim()
  )
    return false;
  if (value.type === 'employee') {
    return (
      isIdentity(value.data.employeeId) &&
      digitalTeamEmployeePurposes.includes(value.data.purpose as DigitalTeamEmployeePurpose) &&
      digitalTeamExecutionModes.includes(value.data.executionMode as DigitalTeamExecutionMode) &&
      typeof value.data.instructions === 'string' &&
      (value.data.verificationCommands === undefined ||
        (Array.isArray(value.data.verificationCommands) &&
          value.data.verificationCommands.length <= 16 &&
          value.data.verificationCommands.every((command) => typeof command === 'string' && Boolean(command.trim()) && command.length <= 1_000)))
    );
  }
  if (value.type === 'human_confirmation') return digitalTeamApprovalPurposes.includes(value.data.purpose as DigitalTeamApprovalPurpose) && typeof value.data.instructions === 'string';
  if (value.type === 'code_integration') return value.data.mode === 'merge' && typeof value.data.instructions === 'string';
  return true;
}

/** 返回尚未在当前轮次以退出码零精确执行的验证命令。 */
export function missingDigitalTeamVerificationCommands(required: readonly string[], successful: readonly string[]): string[] {
  /** 两侧只去除首尾空白，避免把不同 shell 语义错误合并。 */
  const successfulCommands = new Set(successful.map((command) => command.trim()).filter(Boolean));
  return required.map((command) => command.trim()).filter((command) => !successfulCommands.has(command));
}

/** 判断画布连线结构。 */
function isEdge(value: unknown): value is DigitalTeamEdge {
  return isRecord(value) && isIdentity(value.id) && isIdentity(value.source) && isIdentity(value.target);
}

/** 判断结构化规划安排。 */
function isPlanAssignment(value: unknown): value is DigitalTeamPlanAssignment {
  return (
    isRecord(value) &&
    isIdentity(value.nodeId) &&
    typeof value.objective === 'string' &&
    Boolean(value.objective.trim()) &&
    isNonEmptyTextArray(value.scope) &&
    isTextArray(value.excludedScope) &&
    isNonEmptyTextArray(value.acceptanceCriteria) &&
    isNonEmptyTextArray(value.expectedDeliverables)
  );
}

/** 判断可为空的文字数组。 */
function isTextArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && Boolean(item.trim()));
}

/** 判断至少包含一项的文字数组。 */
function isNonEmptyTextArray(value: unknown): value is string[] {
  return isTextArray(value) && value.length > 0;
}

/** 按员工职责筛选节点。 */
function employeesByPurpose(nodes: DigitalTeamNode[], purpose: DigitalTeamEmployeePurpose): DigitalTeamEmployeeNode[] {
  return nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === purpose);
}

/** 按批准职责筛选节点。 */
function approvalsByPurpose(nodes: DigitalTeamNode[], purpose: DigitalTeamApprovalPurpose): DigitalTeamHumanConfirmationNode[] {
  return nodes.filter((node): node is DigitalTeamHumanConfirmationNode => node.type === 'human_confirmation' && node.data.purpose === purpose);
}

/** 要求一类关键节点唯一。 */
function requireExactlyOne(issues: DigitalTeamWorkflowValidationIssue[], nodes: DigitalTeamNode[], code: string, message: string): void {
  if (nodes.length !== 1) issues.push({ code, message });
}

/** 构造正向或反向邻接表。 */
function adjacency(nodes: DigitalTeamNode[], edges: DigitalTeamEdge[], direction: 'outgoing' | 'incoming'): Map<string, Set<string>> {
  const result = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) result.get(direction === 'outgoing' ? edge.source : edge.target)!.add(direction === 'outgoing' ? edge.target : edge.source);
  return result;
}

/** 返回从指定节点可达的全部节点。 */
function reachable(source: string, graph: Map<string, Set<string>>, omittedNodeId?: string): Set<string> {
  const result = new Set<string>();
  const pending = source === omittedNodeId ? [] : [source];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    for (const next of graph.get(current) ?? []) if (next !== omittedNodeId && !result.has(next)) pending.push(next);
  }
  return result;
}

/** 使用入度消减判断是否存在环。 */
function hasCycle(nodes: DigitalTeamNode[], outgoing: Map<string, Set<string>>): boolean {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const targets of outgoing.values()) for (const target of targets) indegree.set(target, (indegree.get(target) ?? 0) + 1);
  const pending = [...indegree].filter((entry) => entry[1] === 0).map((entry) => entry[0]);
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) pending.push(target);
    }
  }
  return visited !== nodes.length;
}

/** 要求上游节点可以到达下游节点。 */
function requireAncestor(issues: DigitalTeamWorkflowValidationIssue[], ancestorId: string, descendantId: string, outgoing: Map<string, Set<string>>, code: string, message: string, nodeId?: string): void {
  if (!reachable(ancestorId, outgoing).has(descendantId)) issues.push({ code, message, ...(nodeId ? { nodeId } : {}) });
}

/** 删除候选关口后仍能到达结束即代表存在绕过路径。 */
function dominatesEnd(gateId: string, sourceId: string, endId: string, outgoing: Map<string, Set<string>>): boolean {
  if (gateId === sourceId || gateId === endId) return true;
  return !reachable(sourceId, outgoing, gateId).has(endId);
}
