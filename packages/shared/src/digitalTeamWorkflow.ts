import type { EmployeeWorkSettings } from './employeeWorkPlanning.js';
import type { CommandActorKind } from './commandEnvelope.js';

/** 旧数字团队流程定义的结构身份，仅用于继续读取历史运行。 */
export const legacyDigitalTeamWorkflowSchemaGeneration = 'digital-team-workflow-2026-09-15' as const;

/** 当前数字团队流程定义的稳定结构身份。 */
export const digitalTeamWorkflowSchemaGeneration = 'digital-team-workflow-2026-09-27' as const;

/** 历史记录中可能出现的全部节点类型。 */
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
  /** 用户可逐项核对的完成标准。 */
  acceptanceCriteria?: string[];
  /** 本分工需要形成的真实交付物。 */
  expectedDeliverables?: string[];
  /** 候选验证节点必须逐条成功执行的精确命令；其他职责不使用。 */
  verificationCommands?: string[];
  /** 本次工作覆盖员工默认配置，实际动作仍受任务授权约束。 */
  settings?: EmployeeWorkSettings;
  /** 同一员工承担多份分工时，明确唯一的任务指派入口。 */
  assignmentEntry?: boolean;
  /** 可接纳本节点的真实项目任务状态。 */
  triggerStatusId?: string;
  /** 本节点开始时推进到的真实项目任务状态。 */
  startStatusId?: string;
  /** 本节点完成时推进到的真实项目任务状态。 */
  completionStatusId?: string;
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
  schemaGeneration: typeof digitalTeamWorkflowSchemaGeneration | typeof legacyDigitalTeamWorkflowSchemaGeneration;
  /** 画布节点。 */
  nodes: DigitalTeamNode[];
  /** 有向依赖边。 */
  edges: DigitalTeamEdge[];
  /** 保存时的画布视口。 */
  viewport: DigitalTeamViewport;
  /** 正式缺陷的预先授权修复员工，不由模型临时扩大范围。 */
  repairEmployeeId?: string;
  /** 一个父验收闭环最多自动修复轮数，未配置时为三轮。 */
  maxRepairRounds?: number;
  /** 仅供历史冻结运行读取的旧项目经验规则，新团队定义不再保存。 */
  projectMemoryPolicy?: {
    /** 有效工作启动时冻结该授权；偏好与跨项目推广仍须审查。 */
    autoApplyStableExperience: boolean;
  };
}

/** 正式验收中发现且需要独立追踪的缺陷。 */
export interface DigitalTeamDefectSubmission {
  /** 同一父流程内稳定问题身份，复验失败继续原缺陷。 */
  key: string;
  /** 缺陷名称。 */
  title: string;
  /** 复现条件、预期与实际行为。 */
  description: string;
  /** 当前测试轮次实际产生的复现证据身份。 */
  reproductionEvidence: string[];
  /** 被测仓库身份。 */
  repositoryId: string;
  /** 被测的准确代码提交。 */
  headSha: string;
}

/** 耐久流程控制事实，重启与子任务不能重置自动修复额度。 */
export interface DigitalTeamRunRuntimeState {
  /** 本次接纳的最大执行权限，所有后继与自动修复共同继承。 */
  permissionMode?: 'read-only' | 'auto' | 'full-access';
  /** 本次任务指派的真实入口；空值表示从全部根员工开始。 */
  entryNodeId?: string | null;
  /** 当前任务明确绑定并已验收的上游成果。 */
  inputDeliverableIds?: string[];
  /** 人工交接明确绑定的当前任务代码现场，不改写原冻结基线。 */
  entryCodeRevisions?: DigitalTeamBaseRevision[];
  /** 父验收闭环已开始的自动修复轮数。 */
  repairRound?: number;
  /** 正在等待修复成果的测试节点。 */
  repairVerificationNodeId?: string | null;
  /** 当前自动修复子流程身份。 */
  repairRunIds?: string[];
  /** 同一准确候选的父验收轮；并行测试和修复关系必须一起恢复。 */
  verificationRound?: {
    /** 按候选和全部准确测试尝试生成的幂等身份。 */
    id: string;
    /** 本轮准确被测候选摘要。 */
    candidateSetSha256: string;
    /** 本轮冻结的准确候选，不能在等待并行结果时切换现场。 */
    candidates: DigitalTeamCandidateRevision[];
    /** 本轮全部参与测试的节点和准确尝试。 */
    tests: { nodeId: string; attemptId: string }[];
    /** 收齐结果前不启动修复；已接纳修复保留完整子流程关系。 */
    phase: 'collecting' | 'repairing';
    /** 本轮正式缺陷，重启不重新登记另一批问题。 */
    defectIds: string[];
    /** 本轮全部修复子流程，暂停和改派逐一核对。 */
    repairRunIds: string[];
  } | null;
  /** 形成候选的实际代码结果集合摘要。 */
  candidateSourceSha256?: string | null;
  /** 耐久人工改派交接；旧执行结束前不能接纳新入口。 */
  handoff?: { employeeId: string; entryNodeId: string; operationIdentity: string; reason: string; requestedAt: string; status: 'stopping' | 'ready' | 'completed' } | null;
  /** 修复子流程所属父验收运行与正式缺陷身份。 */
  parentRepair?: { runId: string; defectIds: string[]; verificationNodeId: string } | null;
}

/** 结构化规划中的单节点安排。 */
export interface DigitalTeamPlanAssignment {
  /** 新增分工必须选择规划节点已授权的成员；既有分工不能换人。 */
  employeeId?: string;
  /** 只引用同一计划中的分工，不能借依赖扩大执行范围。 */
  dependencyIds?: string[];
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
  /** 正式测试发现的阻塞缺陷，开发自查无需创建子任务。 */
  defects?: DigitalTeamDefectSubmission[];
}

/** 一条可复制、删除和重开的团队模板投影。 */
export interface DigitalTeamWorkflowTemplateRecord {
  /** 模板身份。 */
  id: string;
  /** 旧模板的所属项目；null 表示可跨项目复用的全局团队模板。 */
  projectId: string | null;
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
  /** 历史固定研发流程的最终候选摘要；新确认保存在节点尝试中。 */
  finalApprovedCandidateSetSha256: string | null;
  /** 历史固定研发流程的最终验收用户身份。 */
  finalApprovedBy: string | null;
  /** 历史固定研发流程的最终验收时间。 */
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
  /** 当前流程的耐久入口、修复与人工交接状态。 */
  runtimeState: DigitalTeamRunRuntimeState;
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
  /** 接纳时冻结的流程入口、上游成果与父修复关系。 */
  runtimeState?: DigitalTeamRunRuntimeState;
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
  /** 一次替换控制快照，并受运行修订保护。 */
  runtimeState?: DigitalTeamRunRuntimeState;
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
  /** 使本次结果失效的准确尝试身份。 */
  invalidatedByAttemptId?: string | null;
  /** 人工改派或返工的明确原因。 */
  invalidationReason?: string | null;
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

/** 校验节点、连线身份及连线端点。 */
function validateGraphReferences(nodes: DigitalTeamNode[], edges: DigitalTeamEdge[], issues: DigitalTeamWorkflowValidationIssue[]): void {
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
}

/** 校验工作依赖与已选能力；返回空数组表示可以创建运行。 */
export function validateDigitalTeamWorkflowDefinition(value: unknown): DigitalTeamWorkflowValidationIssue[] {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !isViewport(value.viewport)) {
    return [{ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SHAPE_INVALID', message: '团队编排缺少受支持的结构身份、员工分工或依赖关系。' }];
  }
  if (value.schemaGeneration === legacyDigitalTeamWorkflowSchemaGeneration) return validateLegacyDigitalTeamWorkflowDefinition(value);
  if (value.schemaGeneration !== digitalTeamWorkflowSchemaGeneration) {
    return [{ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SHAPE_INVALID', message: '团队编排使用了不受支持的结构身份。' }];
  }
  const issues: DigitalTeamWorkflowValidationIssue[] = [];
  if (value.projectMemoryPolicy !== undefined && (!isRecord(value.projectMemoryPolicy) || typeof value.projectMemoryPolicy.autoApplyStableExperience !== 'boolean'))
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_MEMORY_POLICY_INVALID', message: '项目经验自动生效规则需要明确开启或关闭。' });
  if (value.nodes.length < 1 || value.nodes.length > 128 || value.edges.length > 512) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SIZE_INVALID', message: '请配置 1 到 128 份员工分工，依赖关系不能超过 512 条。' });
  }
  const nodes = value.nodes.filter(isCurrentNode);
  const edges = value.edges.filter(isEdge);
  if (nodes.length !== value.nodes.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', message: '团队只能配置字段完整的员工分工。' });
  if (edges.length !== value.edges.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID', message: '团队包含字段不完整的依赖关系。' });
  validateGraphReferences(nodes, edges, issues);
  if (issues.some((issue) => ['ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_ENDPOINT_INVALID'].includes(issue.code))) return issues;
  if (hasCycle(nodes, adjacency(nodes, edges, 'outgoing'))) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CYCLE', message: '员工分工的依赖关系不能形成循环。' });
  if (value.repairEmployeeId !== undefined && !isIdentity(value.repairEmployeeId)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_REPAIR_EMPLOYEE_INVALID', message: '修复员工身份无效。' });
  if (value.maxRepairRounds !== undefined && (!Number.isSafeInteger(value.maxRepairRounds) || (value.maxRepairRounds as number) < 0 || (value.maxRepairRounds as number) > 20))
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_REPAIR_LIMIT_INVALID', message: '自动修复额度需要在零到二十轮之间。' });
  for (const node of nodes) {
    if (!node.data.instructions.trim()) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_INSTRUCTIONS_MISSING', message: '请填写这份分工需要完成的工作。', nodeId: node.id });
    if (!node.data.acceptanceCriteria?.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_ACCEPTANCE_MISSING', message: '请填写至少一项完成标准。', nodeId: node.id });
    if (!node.data.expectedDeliverables?.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_DELIVERABLE_MISSING', message: '请填写至少一项预期交付物。', nodeId: node.id });
    if (node.data.settings?.delegation) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_DELEGATION_INVALID', message: '团队分工请直接添加员工，不在员工节点中再次委派。', nodeId: node.id });
    if (node.data.assignmentEntry !== undefined && typeof node.data.assignmentEntry !== 'boolean') issues.push({ code: 'ZEUS_DIGITAL_TEAM_ENTRY_INVALID', message: '指派入口配置无效。', nodeId: node.id });
    for (const key of ['triggerStatusId', 'startStatusId', 'completionStatusId'])
      if (node.data[key] !== undefined && !isIdentity(node.data[key])) issues.push({ code: 'ZEUS_DIGITAL_TEAM_STATUS_INVALID', message: '流程状态需要使用项目真实状态身份。', nodeId: node.id });
    if (node.data.executionMode === 'candidate_read_only' && node.data.purpose !== 'verify') issues.push({ code: 'ZEUS_DIGITAL_TEAM_VERIFY_MODE_INVALID', message: '候选只读现场只能用于测试验收分工。', nodeId: node.id });
  }
  /** 并行分支不争抢任务阶段；只有明确汇合后的单一阶段可以推进。 */
  for (const node of nodes)
    if (
      (node.data.startStatusId || node.data.completionStatusId) &&
      nodes.some((other) => other.id !== node.id && !reachable(node.id, adjacency(nodes, edges, 'outgoing')).has(other.id) && !reachable(other.id, adjacency(nodes, edges, 'outgoing')).has(node.id))
    )
      issues.push({ code: 'ZEUS_DIGITAL_TEAM_PARALLEL_STATUS_CONFLICT', message: '并行分工不能分别推进任务状态，请在汇合分工设置状态。', nodeId: node.id });
  return issues;
}

/** 保存和执行共用项目真实状态校验，全局模板应用到项目时也必须完成映射。 */
export function validateDigitalTeamProjectWorkflowStatuses(definition: DigitalTeamWorkflowDefinition, statuses: { hasStatus(statusId: string): boolean; isCompletedStatus(statusId: string): boolean }): DigitalTeamWorkflowValidationIssue[] {
  const issues: DigitalTeamWorkflowValidationIssue[] = [];
  for (const node of definition.nodes) {
    if (node.type !== 'employee') continue;
    for (const statusId of [node.data.triggerStatusId, node.data.startStatusId, node.data.completionStatusId])
      if (statusId && !statuses.hasStatus(statusId)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_STATUS_INVALID', message: '流程状态不属于当前项目，请完成状态映射。', nodeId: node.id });
    if (node.data.startStatusId && statuses.isCompletedStatus(node.data.startStatusId)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_COMPLETION_STATUS_INVALID', message: '开始工作不能把任务推进到完成状态。', nodeId: node.id });
    if (node.data.completionStatusId && statuses.isCompletedStatus(node.data.completionStatusId) && definition.edges.some((edge) => edge.source === node.id))
      issues.push({ code: 'ZEUS_DIGITAL_TEAM_COMPLETION_STATUS_INVALID', message: '有后继分工的节点不能提前完成任务，请在汇合终点配置完成状态。', nodeId: node.id });
  }
  return issues;
}

/** 校验旧流程快照，保证历史运行仍可读取和恢复。 */
function validateLegacyDigitalTeamWorkflowDefinition(value: Record<string, unknown>): DigitalTeamWorkflowValidationIssue[] {
  const issues: DigitalTeamWorkflowValidationIssue[] = [];
  if (value.schemaGeneration !== legacyDigitalTeamWorkflowSchemaGeneration || !Array.isArray(value.nodes) || !Array.isArray(value.edges) || !isViewport(value.viewport)) {
    return [{ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SHAPE_INVALID', message: '历史流程定义缺少受支持的结构身份、节点或连线。' }];
  }
  if (value.nodes.length < 2 || value.nodes.length > 128 || value.edges.length > 512) {
    issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_SIZE_INVALID', message: '历史流程需要 2 到 128 个节点，连线不能超过 512 条。' });
  }
  const nodes = value.nodes.filter(isNode);
  const edges = value.edges.filter(isEdge);
  if (nodes.length !== value.nodes.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', message: '历史流程包含字段不完整或配置无效的节点。' });
  if (edges.length !== value.edges.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID', message: '历史流程包含字段不完整的连线。' });
  validateGraphReferences(nodes, edges, issues);
  if (issues.some((issue) => ['ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_INVALID', 'ZEUS_DIGITAL_TEAM_WORKFLOW_EDGE_ENDPOINT_INVALID'].includes(issue.code))) return issues;

  const starts = nodes.filter((node) => node.type === 'start');
  const ends = nodes.filter((node) => node.type === 'end');
  /** 起止节点是内部结构约束；业务职责只在配置了对应步骤时校验。 */
  const plans = employeesByPurpose(nodes, 'plan');
  const integrations = nodes.filter((node) => node.type === 'code_integration');
  requireExactlyOne(issues, starts, 'ZEUS_DIGITAL_TEAM_WORKFLOW_START_COUNT', '流程需要一个开始节点。');
  requireExactlyOne(issues, ends, 'ZEUS_DIGITAL_TEAM_WORKFLOW_END_COUNT', '流程需要一个结束节点。');
  if (!nodes.some((node) => node.type === 'employee')) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_EMPLOYEE_MISSING', message: '请添加至少一位负责工作的员工。' });
  if (plans.length > 1) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_COUNT', message: '同一份协作安排只需要一位规划负责人。' });
  if (integrations.length > 1) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_INTEGRATION_COUNT', message: '同一份代码候选只能由一个集成步骤生成。' });
  if (starts.length !== 1 || ends.length !== 1) return issues;

  /** 全部连接表示必须完成的依赖，不表示互斥分支。 */
  const outgoing = adjacency(nodes, edges, 'outgoing');
  const incoming = adjacency(nodes, edges, 'incoming');
  const start = starts[0]!;
  const end = ends[0]!;
  if ((incoming.get(start.id)?.size ?? 0) > 0 || (outgoing.get(end.id)?.size ?? 0) > 0) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_TERMINAL_EDGE_INVALID', message: '开始不能有上游，结束不能有下游。' });
  if (hasCycle(nodes, outgoing)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CYCLE', message: '工作依赖不能形成循环。' });
  const fromStart = reachable(start.id, outgoing);
  const toEnd = reachable(end.id, incoming);
  for (const node of nodes) {
    if (!fromStart.has(node.id) || !toEnd.has(node.id)) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_NODE_ORPHANED', message: '请把这一步连接到完整的工作流程。', nodeId: node.id });
    if (node.type !== 'employee') continue;
    if (node.data.settings?.delegation && node.data.purpose !== 'plan') issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_DELEGATION_INVALID', message: '新增分工由规划负责人统一安排，请把成员范围移到规划步骤。', nodeId: node.id });
    if (['plan', 'summary'].includes(node.data.purpose) && node.data.executionMode !== 'read_only')
      issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CTO_MODE_INVALID', message: '规划和汇总保持只读；需要修改文件时请使用执行步骤。', nodeId: node.id });
    if (node.data.executionMode === 'candidate_read_only') {
      if (integrations.length !== 1) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_CANDIDATE_MISSING', message: '核对代码候选前，请配置代码集成步骤。', nodeId: node.id });
      else requireAncestor(issues, integrations[0]!.id, node.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_VERIFICATION_BYPASS', '核对代码候选必须等待集成完成。', node.id);
    }
  }
  for (const approval of approvalsByPurpose(nodes, 'plan_approval')) {
    if (plans.length !== 1) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_MISSING', message: '批准计划前，请配置规划负责人。', nodeId: approval.id });
    else requireAncestor(issues, plans[0]!.id, approval.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_PLAN_APPROVAL_BYPASS', '批准计划必须等待规划完成。', approval.id);
  }
  for (const integration of integrations) {
    /** 集成只接受真正写入代码的上游，普通报告不需要这个步骤。 */
    const writers = nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.executionMode === 'isolated_write');
    if (!writers.length) issues.push({ code: 'ZEUS_DIGITAL_TEAM_WORKFLOW_INTEGRATION_INPUT_MISSING', message: '代码集成需要至少一份代码工作；普通协作可移除此步骤。', nodeId: integration.id });
    for (const writer of writers) requireAncestor(issues, writer.id, integration.id, outgoing, 'ZEUS_DIGITAL_TEAM_WORKFLOW_INTEGRATION_BYPASS', '代码集成必须等待全部代码工作完成。', writer.id);
  }
  return issues;
}

/** 把旧技术流程折叠为员工分工依赖；当前定义只补齐新字段，不增加隐藏节点。 */
export function normalizeDigitalTeamWorkflowDefinition(definition: DigitalTeamWorkflowDefinition): DigitalTeamWorkflowDefinition {
  if (!isRecord(definition) || !Array.isArray(definition.nodes) || !Array.isArray(definition.edges)) return definition;
  /** 表单允许空白行；只清理受限的纯文本列表，错误类型仍交给正式校验拒绝。 */
  definition = structuredClone(definition);
  /** 项目经验规则已经退役，只在历史运行快照中保留原值。 */
  delete definition.projectMemoryPolicy;
  for (const node of definition.nodes) {
    if (!isRecord(node) || node.type !== 'employee' || !isRecord(node.data)) continue;
    for (const key of ['acceptanceCriteria', 'expectedDeliverables', 'verificationCommands'] as const) {
      /** 在原有长度限制内归一化，不能用空白项绕过列表上限。 */
      const values = node.data[key];
      if (Array.isArray(values) && values.length <= (key === 'verificationCommands' ? 16 : 32) && values.every((value) => typeof value === 'string')) node.data[key] = values.map((value) => value.trim()).filter(Boolean);
    }
  }
  if (definition.nodes.some((node) => !isNode(node)) || definition.edges.some((edge) => !isEdge(edge))) return definition;
  const employeeNodes = definition.nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee');
  if (definition.schemaGeneration === digitalTeamWorkflowSchemaGeneration && employeeNodes.length === definition.nodes.length) {
    return { ...structuredClone(definition), nodes: employeeNodes.map((node) => normalizeEmployeeNode(node)) };
  }
  /** 旧职责、候选模式与技术节点只在升级边界收敛。 */
  const nodes = employeeNodes.map((node) => normalizeEmployeeNode(node));
  /** 旧技术节点只传递依赖，最近的下游员工成为当前员工的直接后继。 */
  const outgoing = adjacency(definition.nodes, definition.edges, 'outgoing');
  const employeeIds = new Set(employeeNodes.map((node) => node.id));
  const pairs = new Set<string>();
  for (const source of employeeNodes) {
    const pending = [...(outgoing.get(source.id) ?? [])];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const target = pending.shift()!;
      if (visited.has(target)) continue;
      visited.add(target);
      if (employeeIds.has(target)) {
        if (target !== source.id) pairs.add(`${source.id}\0${target}`);
        continue;
      }
      pending.push(...(outgoing.get(target) ?? []));
    }
  }
  const edges = [...pairs].map((pair, index) => {
    const [source, target] = pair.split('\0');
    return { id: `employee_dependency_${index}_${source}_${target}`, source: source!, target: target! };
  });
  return {
    schemaGeneration: digitalTeamWorkflowSchemaGeneration,
    nodes,
    edges,
    viewport: structuredClone(definition.viewport),
  };
}

/** 在创建运行前强制要求完整合法的流程定义。 */
export function assertDigitalTeamWorkflowReady(value: unknown): asserts value is DigitalTeamWorkflowDefinition {
  const issues = validateDigitalTeamWorkflowDefinition(value);
  if (issues.length > 0) throw new DigitalTeamWorkflowValidationError(issues);
}

/** 从真实员工身份解析唯一入口，禁止静默选中重复岗位或降级为独立执行。 */
export function resolveDigitalTeamAssignmentEntry(definition: DigitalTeamWorkflowDefinition, employeeId: string): DigitalTeamEmployeeNode {
  const candidates = definition.nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.employeeId === employeeId);
  const marked = candidates.filter((node) => node.data.assignmentEntry);
  const selected = marked.length === 1 ? marked[0] : candidates.length === 1 ? candidates[0] : undefined;
  if (!selected || marked.length > 1)
    throw new DigitalTeamWorkflowValidationError([
      { code: candidates.length ? 'ZEUS_DIGITAL_TEAM_ENTRY_AMBIGUOUS' : 'ZEUS_DIGITAL_TEAM_ENTRY_NOT_FOUND', message: candidates.length ? '该员工在项目流程中承担多份分工，请明确唯一指派入口。' : '该员工没有对应的项目流程入口。' },
    ]);
  return selected;
}

/** 校验负责人覆盖后续工作，并只向授权成员增加有边界的分工。 */
export function validateDigitalTeamStructuredPlan(definition: DigitalTeamWorkflowDefinition, value: unknown): string[] {
  if (definition.schemaGeneration === digitalTeamWorkflowSchemaGeneration) return ['当前团队已直接配置全部员工分工，不接受运行时新增规划。'];
  if (!isRecord(value) || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.assignments)) return ['规划必须包含摘要和逐项安排。'];
  /** 先期调研可以在规划前完成，负责人只安排自己的后续工作。 */
  const planner = definition.nodes.find((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === 'plan');
  if (!planner) return ['当前流程没有规划负责人。'];
  /** 已明确安排的后续工作必须全部覆盖；额外分工只能使用事先授权的成员。 */
  const afterPlan = reachable(planner.id, adjacency(definition.nodes, definition.edges, 'outgoing'));
  const expected = definition.nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === 'work' && afterPlan.has(node.id));
  const assignments = value.assignments.filter(isPlanAssignment);
  if (assignments.length !== value.assignments.length) return ['每份安排需要目标、范围、完成标准和交付物。'];
  const actual = assignments.map((assignment) => assignment.nodeId);
  if (new Set(actual).size !== actual.length) return ['同一分工不能重复规划。'];
  if (expected.some((node) => !actual.includes(node.id))) return ['规划需要覆盖已经安排的全部工作。'];
  const policy = planner?.data.settings?.delegation;
  const additions = assignments.filter((assignment) => !expected.some((node) => node.id === assignment.nodeId));
  if (
    additions.length &&
    (!policy || additions.length > policy.maxWorkItems || additions.some((assignment) => !assignment.employeeId || !policy.employeeIds.includes(assignment.employeeId) || definition.nodes.some((node) => node.id === assignment.nodeId)))
  )
    return ['新增分工必须选择已授权的团队成员，并遵守本次分工数量限制。'];
  if (assignments.some((assignment) => assignment.employeeId && expected.some((node) => node.id === assignment.nodeId && node.data.employeeId !== assignment.employeeId))) return ['已经安排的工作不能在规划时更换员工。'];
  if (assignments.some((assignment) => assignment.dependencyIds?.some((id) => !actual.includes(id) || id === assignment.nodeId))) return ['分工依赖只能引用本计划中的其他分工。'];
  /** 生成图后复用同一个结构校验器，循环、孤立节点和代码现场要求均不能绕过。 */
  return validateDigitalTeamWorkflowDefinition(digitalTeamExecutionDefinition({ definitionSnapshot: definition, plan: value as unknown as DigitalTeamStructuredPlan })).map((issue) => issue.message);
}

/** 从冻结模板与已登记计划派生执行图；模板本身不被改写，返工历史保留原有身份。 */
export function digitalTeamExecutionDefinition(run: Pick<DigitalTeamWorkflowRunRecord, 'definitionSnapshot' | 'plan'> & Partial<Pick<DigitalTeamWorkflowRunRecord, 'runtimeState'>>): DigitalTeamWorkflowDefinition {
  if (run.definitionSnapshot.schemaGeneration === digitalTeamWorkflowSchemaGeneration) {
    const entryNodeId = run.runtimeState?.entryNodeId;
    if (!entryNodeId) return run.definitionSnapshot;
    const included = reachable(entryNodeId, adjacency(run.definitionSnapshot.nodes, run.definitionSnapshot.edges, 'outgoing'));
    included.add(entryNodeId);
    return { ...run.definitionSnapshot, nodes: run.definitionSnapshot.nodes.filter((node) => included.has(node.id)), edges: run.definitionSnapshot.edges.filter((edge) => included.has(edge.source) && included.has(edge.target)) };
  }
  if (!run.plan) return run.definitionSnapshot;
  /** 规划节点及其确认点决定新增工作的入口。 */
  const definition = structuredClone(run.definitionSnapshot);
  const planner = definition.nodes.find((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === 'plan');
  if (!planner) return definition;
  const outgoing = adjacency(definition.nodes, definition.edges, 'outgoing');
  const afterPlan = reachable(planner.id, outgoing);
  const approvals = definition.nodes.filter((node) => node.type === 'human_confirmation' && node.data.purpose === 'plan_approval' && afterPlan.has(node.id));
  const entrances = approvals.length ? approvals : [planner];
  const additions = run.plan.assignments.filter((assignment) => !definition.nodes.some((node) => node.id === assignment.nodeId));
  /** 新分工默认分析资料；只有模板已明确授权的同成员代码职责才继承写入现场。 */
  for (const [index, assignment] of additions.entries()) {
    const role = definition.nodes.find((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === 'work' && node.data.employeeId === assignment.employeeId);
    definition.nodes.push({
      id: assignment.nodeId,
      type: 'employee',
      position: { x: 760, y: 480 + index * 160 },
      data: {
        title: assignment.objective.slice(0, 120),
        employeeId: assignment.employeeId ?? '',
        purpose: 'work',
        executionMode: role?.data.executionMode ?? 'read_only',
        instructions: assignment.objective,
        ...(role?.data.settings ? { settings: structuredClone(role.data.settings) } : {}),
      },
    });
  }
  /** 稳定连线身份来自节点身份，重复读取同一计划不会制造新连接。 */
  const connect = (source: string, target: string): void => {
    if (!definition.edges.some((edge) => edge.source === source && edge.target === target)) definition.edges.push({ id: `planned_${definition.edges.length}_${source.slice(0, 60)}_${target.slice(0, 60)}`, source, target });
  };
  for (const assignment of run.plan.assignments) for (const predecessor of assignment.dependencyIds ?? []) connect(predecessor, assignment.nodeId);
  for (const assignment of additions) {
    for (const entrance of entrances) connect(entrance.id, assignment.nodeId);
    /** 已有复核、集成、汇总和结束都等待新增成果，规划确认本身不反向等待。 */
    for (const node of run.definitionSnapshot.nodes)
      if (afterPlan.has(node.id) && node.id !== planner.id && !approvals.some((approval) => approval.id === node.id) && !(node.type === 'employee' && node.data.purpose === 'work')) connect(assignment.nodeId, node.id);
  }
  return definition;
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

/** 节点覆盖只使用现有员工配置字段，数据库和前端共用同一结构边界。 */
function isEmployeeSettings(value: unknown): value is EmployeeWorkSettings {
  if (!isRecord(value) || Object.keys(value).some((key) => !['autonomyObjective', 'delegation', 'modelOverride', 'reasoningEffort', 'serviceTier', 'workMode', 'permissionMode', 'skillIds', 'promptOverride'].includes(key))) return false;
  for (const key of ['autonomyObjective', 'modelOverride', 'reasoningEffort', 'serviceTier', 'promptOverride'])
    if (value[key] !== undefined && value[key] !== null && (typeof value[key] !== 'string' || !(value[key] as string).trim())) return false;
  if (value.workMode !== undefined && !['default', 'plan'].includes(String(value.workMode))) return false;
  if (value.permissionMode !== undefined && !['read-only', 'auto', 'full-access'].includes(String(value.permissionMode))) return false;
  if (value.skillIds !== undefined && (!Array.isArray(value.skillIds) || !value.skillIds.every(isIdentity))) return false;
  if (value.delegation !== undefined) {
    const policy = value.delegation;
    if (
      !isRecord(policy) ||
      !Array.isArray(policy.employeeIds) ||
      policy.employeeIds.length > 24 ||
      !policy.employeeIds.every(isIdentity) ||
      !Number.isInteger(policy.maxDepth) ||
      Number(policy.maxDepth) < 1 ||
      Number(policy.maxDepth) > 4 ||
      !Number.isInteger(policy.maxWorkItems) ||
      Number(policy.maxWorkItems) < 1 ||
      Number(policy.maxWorkItems) > 48
    )
      return false;
  }
  return true;
}

/** 保留员工职责与独立权限配置，只补齐缺省的工作协议。 */
function normalizeEmployeeNode(node: DigitalTeamEmployeeNode): DigitalTeamEmployeeNode {
  /** 执行方式仍属于流程调度元数据，不进入数字员工配置表单。 */
  const executionMode = node.data.executionMode;
  /** 兼容字段由系统补齐，用户不再为节点维护第二份工作提示。 */
  const acceptanceCriteria = node.data.acceptanceCriteria?.map((item) => item.trim()).filter(Boolean) ?? [];
  /** 交付物同样只作为运行协议默认值存在。 */
  const expectedDeliverables = node.data.expectedDeliverables?.map((item) => item.trim()).filter(Boolean) ?? [];
  /** 保留模型与推理覆盖；历史运行读取原冻结定义，不经过此边界。 */
  const settings = node.data.settings ? structuredClone(node.data.settings) : undefined;
  if (settings) for (const key of ['serviceTier', 'workMode', 'skillIds']) delete (settings as Record<string, unknown>)[key];
  return {
    ...structuredClone(node),
    type: 'employee',
    data: {
      ...structuredClone(node.data),
      purpose: node.data.purpose,
      executionMode,
      settings: settings && Object.keys(settings).length ? settings : undefined,
      instructions: node.data.instructions.trim() || '根据当前任务目标和数字员工职责完成工作，并提交可核对结果。',
      acceptanceCriteria: acceptanceCriteria.length ? acceptanceCriteria : ['按工作要求完成并提交可核对结果'],
      expectedDeliverables: expectedDeliverables.length ? expectedDeliverables : [executionMode === 'isolated_write' ? '代码变更与验证证据' : '可核对的工作成果'],
    },
  };
}

/** 判断当前画布允许保存的员工分工。 */
function isCurrentNode(value: unknown): value is DigitalTeamEmployeeNode {
  if (!isNode(value) || value.type !== 'employee') return false;
  return (value.data.acceptanceCriteria === undefined || isNonEmptyTextArray(value.data.acceptanceCriteria)) && (value.data.expectedDeliverables === undefined || isNonEmptyTextArray(value.data.expectedDeliverables));
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
      (value.data.settings === undefined || isEmployeeSettings(value.data.settings)) &&
      (value.data.verificationCommands === undefined ||
        (Array.isArray(value.data.verificationCommands) &&
          value.data.verificationCommands.length <= 16 &&
          value.data.verificationCommands.every((command) => typeof command === 'string' && Boolean(command.trim()) && command.length <= 1_000))) &&
      (value.data.acceptanceCriteria === undefined ||
        (Array.isArray(value.data.acceptanceCriteria) && value.data.acceptanceCriteria.length <= 32 && value.data.acceptanceCriteria.every((item) => typeof item === 'string' && Boolean(item.trim())))) &&
      (value.data.expectedDeliverables === undefined ||
        (Array.isArray(value.data.expectedDeliverables) && value.data.expectedDeliverables.length <= 32 && value.data.expectedDeliverables.every((item) => typeof item === 'string' && Boolean(item.trim()))))
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
    (value.employeeId === undefined || isIdentity(value.employeeId)) &&
    (value.dependencyIds === undefined || (Array.isArray(value.dependencyIds) && value.dependencyIds.every(isIdentity))) &&
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
