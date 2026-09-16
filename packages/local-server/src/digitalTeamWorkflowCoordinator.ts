import { createHash } from 'node:crypto';
import { getGitRepositoryContext, getGitWorktreeClean, getTaskWorkspaceReview, prepareWorkflowCandidate } from '@zeus/git-core';
import { missingDigitalTeamVerificationCommands, validateDigitalTeamStructuredPlan, type DigitalTeamEmployeeNode, type DigitalTeamNode, type DigitalTeamStructuredPlan, type DigitalTeamStructuredResult } from '@zeus/shared';
import {
  type ArtifactStore,
  type ConversationProviderItemRepository,
  type ConversationRepository,
  type ConversationSubmissionRepository,
  type ConversationTurnRepository,
  type DigitalEmployeeRepository,
  type DigitalEmployeeRecord,
  type DigitalTeamBaseRevision,
  type DigitalTeamNodeAttemptRecord,
  type DigitalTeamNodeAttemptRepository,
  type DigitalTeamWorkflowRunRecord,
  type DigitalTeamWorkflowRunRepository,
  type DigitalTeamWorkflowTemplateRepository,
  type ProjectRepository,
  type ProjectRepositoryRegistrationRepository,
  type TaskEnvironmentRepository,
  type TaskRepository,
  type TaskWorkspaceRepository,
  type TurnChangeSetRepository,
  type ZeusProjectRepositoryRecord,
  type ZeusTaskWorkspaceRecord,
} from '@zeus/storage';
import type { BrowserAutomationToolCall, BrowserAutomationToolResult } from './browserAutomation.js';
import type {
  DigitalTeamApprovalInput,
  DigitalTeamCommandContext,
  DigitalTeamReworkInput,
  DigitalTeamRunControlInput,
  DigitalTeamRunCreateInput,
  DigitalTeamTemplateSaveInput,
  DigitalTeamWorkflowRouteCoordinator,
} from './digitalTeamWorkflowRoutes.js';
import { DigitalTeamWorkflowRouteError } from './digitalTeamWorkflowRoutes.js';
import type { TaskWorkManagementController } from './taskWorkManagement.js';
import type { TaskWorkToolPort } from './taskWorkDynamicTools.js';
import type { CreateUserTaskInput } from './workManagementCoreCommandRoutes.js';

/** 协调循环间隔；实时事件会用 kick 提前唤醒。 */
const workflowTickMilliseconds = 1_000;

/** 同一数字团队运行最多并发两个真实员工轮次。 */
const maximumConcurrentEmployeeAttempts = 2;

/** Provider 仍可能写入的节点状态。 */
const inFlightAttemptStatuses = new Set<DigitalTeamNodeAttemptRecord['status']>(['dispatching', 'active']);

/** Provider 轮次可据此做最终验真的终态。 */
const terminalTurnStatuses = new Set(['completed', 'interrupted', 'failed']);

/** 创建运行前只读冻结的仓库事实。 */
interface PreparedDigitalTeamRun {
  /** 已确认修订的模板。 */
  templateId: string;
  /** 已确认模板修订。 */
  templateRevision: number;
  /** 逐仓冻结基线。 */
  baseRevisions: DigitalTeamBaseRevision[];
  /** 逐仓登记记录，供后续 worktree 绑定。 */
  repositories: ZeusProjectRepositoryRecord[];
}

/** 业务任务创建入口由现有 WorkManagementCoreOperations 提供。 */
interface DigitalTeamTaskCreationPort {
  /** 在同一 Core transaction 创建任务。 */
  create(input: CreateUserTaskInput, taskId: string, context: DigitalTeamCommandContext): unknown;
}

/** 协调器依赖均为已有权威仓储或受控执行端口。 */
export interface DigitalTeamWorkflowCoordinatorOptions {
  /** 模板仓储。 */
  templates: DigitalTeamWorkflowTemplateRepository;
  /** 运行仓储。 */
  runs: DigitalTeamWorkflowRunRepository;
  /** 节点尝试仓储。 */
  attempts: DigitalTeamNodeAttemptRepository;
  /** 项目仓储。 */
  projects: Pick<ProjectRepository, 'getById'>;
  /** 任务仓储。 */
  tasks: Pick<TaskRepository, 'getById'>;
  /** 项目仓库登记。 */
  projectRepositories: Pick<ProjectRepositoryRegistrationRepository, 'listByProject'>;
  /** 数字员工仓储。 */
  employees: Pick<DigitalEmployeeRepository, 'getById'>;
  /** 任务环境仓储。 */
  environments: TaskEnvironmentRepository;
  /** 任务工作区仓储。 */
  workspaces: TaskWorkspaceRepository;
  /** Provider 提交仓储。 */
  submissions: ConversationSubmissionRepository;
  /** 会话归属仓储。 */
  conversations: Pick<ConversationRepository, 'getRecordById'>;
  /** Provider 轮次仓储。 */
  turns: ConversationTurnRepository;
  /** Provider 结构化条目仓储。 */
  providerItems: ConversationProviderItemRepository;
  /** 精确轮次代码变化仓储。 */
  turnChanges: TurnChangeSetRepository;
  /** 长产物受控读取仓储。 */
  artifacts: ArtifactStore;
  /** 真实工作项和会话派发端口。 */
  taskWork: TaskWorkManagementController;
  /** 原子任务创建端口。 */
  taskCreation: DigitalTeamTaskCreationPort;
  /** 刷新 sql.js 持久文件。 */
  save(): Promise<void>;
  /** 发布统一实时事件。 */
  publish(type: string, payload: Record<string, unknown>): unknown;
  /** 当前时钟。 */
  now(): Date;
  /** 只读验证进程不运行真实协调器。 */
  readOnlyValidation?: boolean;
}

/** 数字团队 DAG 调度、结构化工具和人工控制的唯一协调器。 */
export class DigitalTeamWorkflowCoordinator implements DigitalTeamWorkflowRouteCoordinator {
  /** 下一次协调循环。 */
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** 当前协调循环，避免重入。 */
  private active: Promise<void> | null = null;

  /** 进程内正在执行外部效果的尝试；重启后不会被误认为可重放。 */
  private readonly activeExternalAttemptIds = new Set<string>();

  /** 关闭后不再派发。 */
  private closed = false;

  /** 保存依赖并启动恢复循环。 */
  constructor(private readonly options: DigitalTeamWorkflowCoordinatorOptions) {
    if (!options.readOnlyValidation) this.schedule();
  }

  /** 列出项目模板。 */
  listTemplates(projectId: string): unknown {
    this.requireProject(projectId);
    return this.options.templates.listByProject(projectId);
  }

  /** 新建或按修订更新模板。 */
  saveTemplate(projectId: string, input: DigitalTeamTemplateSaveInput, operationIdentity: string): unknown {
    this.requireProject(projectId);
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : stableIdentity('digital_team_template', operationIdentity);
    const existing = this.options.templates.getById(id);
    if (existing) {
      if (existing.projectId !== projectId || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '模板不属于当前项目或缺少有效修订。');
      return this.options.templates.update(id, {
        expectedRevision: input.expectedRevision!,
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(isRecord(input.definition) ? { definition: input.definition as never } : {}),
      });
    }
    if (typeof input.name !== 'string' || typeof input.description !== 'string' || !isRecord(input.definition)) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_INVALID', '模板名称、说明和画布定义不能为空.', 400);
    return this.options.templates.create({ id, projectId, name: input.name, description: input.description, definition: input.definition as never });
  }

  /** 删除项目模板，历史运行继续读取自己的快照。 */
  deleteTemplate(projectId: string, templateId: string, expectedRevision: number): unknown {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw routeError('ZEUS_DIGITAL_TEAM_REVISION_INVALID', '模板修订无效。', 400);
    const template = this.options.templates.getById(templateId);
    if (!template || template.projectId !== projectId) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_NOT_FOUND', '数字团队流程模板不存在。', 404);
    return this.options.templates.delete(template.id, expectedRevision);
  }

  /** 列出项目运行。 */
  listRuns(projectId: string): unknown {
    this.requireProject(projectId);
    return this.options.runs.listByProject(projectId);
  }

  /** 返回运行、完整历史和每节点当前尝试。 */
  getRunProjection(runId: string): unknown {
    const run = this.options.runs.getById(runId);
    if (!run) return null;
    const nodeAttempts = this.options.attempts.listByRun(run.id);
    const currentAttempts = run.definitionSnapshot.nodes.flatMap((node) => {
      const attempt = this.options.attempts.getCurrentByNode(run.id, node.id);
      return attempt ? [attempt] : [];
    });
    return { run, nodeAttempts, currentAttempts };
  }

  /** 把有界命令回执解析为模板或运行的当前公开投影。 */
  resolveMutationResult(result: unknown): unknown {
    if (!isRecord(result)) throw routeError('ZEUS_DIGITAL_TEAM_MUTATION_RESULT_INVALID', '数字团队命令回执缺少资源身份。', 500);
    if (result.resourceKind === 'run' && typeof result.runId === 'string') return this.getRunProjection(result.runId);
    if (result.resourceKind === 'template' && typeof result.projectId === 'string' && typeof result.templateId === 'string') {
      return this.options.templates.listByProject(result.projectId).find((template) => template.id === result.templateId) ?? result;
    }
    throw routeError('ZEUS_DIGITAL_TEAM_MUTATION_RESULT_INVALID', '数字团队命令回执资源身份无效。', 500);
  }

  /** 在 Core 状态和持久文件都成功后发布准确资源变化。 */
  publishMutation(result: unknown): void {
    if (!isRecord(result)) return;
    if (result.resourceKind === 'run' && typeof result.runId === 'string') this.publishRunChanged(result.runId);
    else if (result.resourceKind === 'template' && typeof result.templateId === 'string' && typeof result.projectId === 'string') {
      this.options.publish('digital_team.template.changed', { templateId: result.templateId, projectId: result.projectId, revision: result.revision });
    }
  }

  /** 返回运行所属真实任务身份。 */
  getRunTaskId(runId: string): string | null {
    return this.options.runs.getById(runId)?.taskId ?? null;
  }

  /** 创建运行前只读核对模板修订和每个登记仓库 HEAD。 */
  async prepareRun(projectId: string, input: DigitalTeamRunCreateInput): Promise<PreparedDigitalTeamRun> {
    const project = this.requireProject(projectId);
    if (!Number.isSafeInteger(input.templateRevision) || input.templateRevision < 1) throw routeError('ZEUS_DIGITAL_TEAM_REVISION_INVALID', '模板修订无效。', 400);
    const template = this.options.templates.getById(requiredText(input.templateId, '请选择流程模板。', 512));
    if (!template || template.projectId !== project.id || template.revision !== input.templateRevision || !template.ready) {
      throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '流程模板不存在、尚未通过校验或已被修改。');
    }
    if (!requiredText(input.title, '任务名称不能为空。', 240) || typeof input.description !== 'string' || !isRecord(input.taskFacts)) {
      throw routeError('ZEUS_DIGITAL_TEAM_RUN_INVALID', '任务名称、说明和任务事实无效。', 400);
    }
    const repositories = this.options.projectRepositories.listByProject(project.id);
    if (repositories.length === 0) throw routeError('ZEUS_DIGITAL_TEAM_REPOSITORY_REQUIRED', '项目尚未登记可冻结的 Git 仓库。');
    if (repositories.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '首期数字团队运行只支持一个 Git 仓库，请调整项目仓库登记后再创建运行。');
    const baseRevisions = await Promise.all(
      repositories.map(async (repository) => {
        const [context, clean] = await Promise.all([getGitRepositoryContext(repository.localPath), getGitWorktreeClean(repository.localPath)]);
        if (!context.isRepository || !context.headSha) throw routeError('ZEUS_DIGITAL_TEAM_REPOSITORY_REQUIRED', `仓库 ${repository.name} 不是可用 Git 仓库。`);
        if (!clean && input.taskFacts.confirmCommittedBaseline !== true) {
          throw routeError('ZEUS_DIGITAL_TEAM_DIRTY_BASELINE_CONFIRMATION_REQUIRED', `仓库 ${repository.name} 有未提交改动；这些改动不会进入冻结基线，请先处理或明确确认只使用已提交版本。`);
        }
        return { repositoryId: repository.id, sourceRef: context.detached || !context.branch ? 'HEAD' : context.branch, baseSha: context.headSha };
      }),
    );
    return { templateId: template.id, templateRevision: template.revision, baseRevisions, repositories };
  }

  /** 在统一 Core 事务中创建任务、冻结运行并完成开始节点。 */
  createRun(projectId: string, input: DigitalTeamRunCreateInput, context: DigitalTeamCommandContext, preparedValue: unknown): unknown {
    const prepared = preparedValue as PreparedDigitalTeamRun;
    const template = this.options.templates.getById(prepared.templateId);
    if (!template || template.projectId !== projectId || template.revision !== prepared.templateRevision || template.revision !== input.templateRevision) {
      throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '流程模板在预检后发生变化。');
    }
    const runId = stableIdentity('digital_team_run', context.operationIdentity);
    const taskId = stableIdentity('task', `${context.operationIdentity}\0digital-team`);
    const taskFacts = structuredClone(input.taskFacts);
    this.options.taskCreation.create(
      {
        projectId,
        title: requiredText(input.title, '任务名称不能为空。', 240),
        taskType: 'requirement',
        description: input.description,
        sourceContext: { digitalTeamRunId: runId, taskFacts },
        allowCodeChanges: taskFactBoolean(taskFacts, 'allowCodeChanges', true),
        allowTests: taskFactBoolean(taskFacts, 'allowTests', true),
        allowGitCommit: taskFactBoolean(taskFacts, 'allowGitCommit', true),
      },
      taskId,
      context,
    );
    const run = this.options.runs.create({
      id: runId,
      projectId,
      taskId,
      templateId: template.id,
      templateRevision: template.revision,
      definition: structuredClone(template.definition),
      taskFacts,
      baseRevisions: prepared.baseRevisions,
    });
    const startNode = run.definitionSnapshot.nodes.find((node) => node.type === 'start')!;
    const start = this.options.attempts.create({ id: stableAttemptId(run.id, startNode.id, 1), runId: run.id, nodeId: startNode.id, inputSha256: inputDigest(run, startNode, []) });
    const activeStart = this.options.attempts.update(start.id, { expectedRevision: start.revision, status: 'active', commandId: context.commandId, startedAt: this.options.now().toISOString() });
    this.options.attempts.update(activeStart.id, { expectedRevision: activeStart.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
    return this.getRunProjection(run.id);
  }

  /** 人工批准只处理当前精确 attempt，并核对上游终态和绑定摘要。 */
  decideApproval(runId: string, input: DigitalTeamApprovalInput, context: DigitalTeamCommandContext, preparedValue?: unknown): unknown {
    if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || typeof input.approved !== 'boolean' || typeof input.reason !== 'string' || input.reason.length > 2_000) {
      throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_INVALID', '批准 attempt、决定或说明无效。', 400);
    }
    const run = this.requireRun(runId, input.expectedRevision);
    requireHumanActor(context);
    const node = requireNode(run, input.nodeId);
    if (node.type !== 'human_confirmation') throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_INVALID', '目标不是人工确认节点。', 400);
    const attempt = this.options.attempts.getCurrentByNode(run.id, node.id);
    if (!attempt || attempt.attempt !== input.attempt) throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_STALE', '人工确认节点已经变化。');
    const boundSha256 = node.data.purpose === 'plan_approval' ? run.planSha256 : run.candidateSetSha256;
    if (!boundSha256) throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_STALE', '待批准的规划或候选不存在。');
    this.assertApprovalUpstreamTerminal(run, node);
    const commanded = this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, commandId: context.commandId });
    const decided = this.options.attempts.decideApproval(commanded.id, {
      expectedRevision: commanded.revision,
      approval: {
        purpose: node.data.purpose,
        decision: input.approved ? 'approved' : 'changes_requested',
        actorKind: context.actor.kind,
        actorId: context.actor.id ?? context.actor.kind,
        boundSha256,
        reason: typeof input.reason === 'string' ? input.reason : '',
      },
    });
    if (node.data.purpose === 'plan_approval') {
      if (input.approved) this.options.runs.approvePlan(run.id, { expectedRevision: run.revision, planSha256: boundSha256, actorId: context.actor.id ?? context.actor.kind });
      else {
        const planNode = run.definitionSnapshot.nodes.find((candidate) => candidate.type === 'employee' && candidate.data.purpose === 'plan')!;
        this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: planNode.id, reason: input.reason || '用户要求修改规划。', invalidatedByAttemptId: decided.id });
        this.options.runs.update(run.id, { expectedRevision: run.revision, status: 'planning', candidateRevisions: [], error: null });
      }
    } else if (input.approved) {
      if (!isRecord(preparedValue) || preparedValue.candidateSetSha256 !== run.candidateSetSha256) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '最终验收前未完成准确候选复核。');
      const endNode = run.definitionSnapshot.nodes.find((candidate) => candidate.type === 'end')!;
      const end = this.options.attempts.create({ id: stableAttemptId(run.id, endNode.id, 1), runId: run.id, nodeId: endNode.id, inputSha256: inputDigest(run, endNode, this.currentAttempts(run)) });
      const activeEnd = this.options.attempts.update(end.id, { expectedRevision: end.revision, status: 'active', startedAt: this.options.now().toISOString() });
      this.options.attempts.update(activeEnd.id, { expectedRevision: activeEnd.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
      this.options.runs.approveFinal(run.id, { expectedRevision: run.revision, candidateSetSha256: boundSha256, actorId: context.actor.id ?? context.actor.kind });
      const summaryNode = run.definitionSnapshot.nodes.find((candidate) => candidate.type === 'employee' && candidate.data.purpose === 'summary')!;
      const summaryAttempt = this.options.attempts.getCurrentByNode(run.id, summaryNode.id);
      if (summaryAttempt?.workRunId) this.options.taskWork.settleWorkflowWorkItem(summaryAttempt.workRunId, 'succeeded');
    } else {
      const summaryNode = run.definitionSnapshot.nodes.find((candidate) => candidate.type === 'employee' && candidate.data.purpose === 'summary')!;
      this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: summaryNode.id, reason: input.reason || '用户要求修改最终汇总。', invalidatedByAttemptId: decided.id });
      this.options.runs.update(run.id, { expectedRevision: run.revision, status: 'summarizing', error: { code: 'ZEUS_DIGITAL_TEAM_FINAL_CHANGES_REQUESTED', message: input.reason } });
    }
    return this.getRunProjection(run.id);
  }

  /** 最终批准前复核全部候选工作区仍干净且 HEAD 与运行绑定一致。 */
  async prepareApproval(runId: string, input: DigitalTeamApprovalInput): Promise<unknown> {
    const run = this.requireRun(runId, input.expectedRevision);
    const node = requireNode(run, input.nodeId);
    if (!input.approved || node.type !== 'human_confirmation' || node.data.purpose !== 'final_acceptance') return null;
    if (!run.candidateSetSha256 || run.candidateRevisions.length === 0) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '最终验收没有可核对的候选版本。');
    for (const candidate of run.candidateRevisions) {
      const workspace = this.options.workspaces.getById(candidate.workspaceRef);
      if (!workspace?.worktreePath || workspace.repositoryId !== candidate.repositoryId) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '候选工作区不存在或仓库身份不一致。');
      const review = await getTaskWorkspaceReview(workspace.worktreePath);
      if (!review.clean || review.headSha !== candidate.headSha) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '候选工作区已变化或包含未提交修改，不能最终验收。');
    }
    return { candidateSetSha256: run.candidateSetSha256 };
  }

  /** 暂停先关闭派发；恢复前拒绝任何未知结果。 */
  controlRun(runId: string, input: DigitalTeamRunControlInput, context: DigitalTeamCommandContext): unknown {
    if (input.state !== 'running' && input.state !== 'paused') throw routeError('ZEUS_DIGITAL_TEAM_CONTROL_INVALID', '只支持暂停或继续运行。', 400);
    requireHumanActor(context);
    const run = this.requireRun(runId, input.expectedRevision);
    if (['completed', 'failed', 'cancelled'].includes(run.status)) throw routeError('ZEUS_DIGITAL_TEAM_RUN_TERMINAL', '已经结束的运行不能暂停或继续。');
    if (input.state === 'running' && this.options.attempts.listByRun(run.id).some((attempt) => attempt.status === 'outcome_unknown')) {
      throw routeError('ZEUS_DIGITAL_TEAM_UNKNOWN_OUTCOME', '仍有结果未知的外部操作，核对前不能继续派发。');
    }
    /** 暂停或继续只更新控制提示，保留仍需返工或人工核对的真实失败原因。 */
    const controlError = input.state === 'paused' ? (run.error ?? { code: 'ZEUS_DIGITAL_TEAM_STOPPING', message: '已停止新派发，正在核对在途工作。' }) : run.error?.code === 'ZEUS_DIGITAL_TEAM_STOPPING' ? null : run.error;
    this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: input.state, error: controlError });
    return this.getRunProjection(run.id);
  }

  /** 返工只失效目标和后继，活动现场必须先暂停核对。 */
  requestRework(runId: string, input: DigitalTeamReworkInput, context: DigitalTeamCommandContext): unknown {
    requireHumanActor(context);
    const run = this.requireRun(runId, input.expectedRevision);
    const reason = requiredText(input.reason, '返工原因不能为空。', 2_000);
    const node = requireNode(run, input.nodeId);
    if (node.type === 'start' || node.type === 'end' || node.type === 'human_confirmation') throw routeError('ZEUS_DIGITAL_TEAM_REWORK_INVALID', '请选择需要重新执行的员工或集成节点。', 400);
    const affected = descendantIds(run, node.id);
    const current = this.options.attempts.listByRun(run.id).filter((attempt) => affected.has(attempt.nodeId) && this.options.attempts.getCurrentByNode(run.id, attempt.nodeId)?.id === attempt.id);
    if (current.some((attempt) => inFlightAttemptStatuses.has(attempt.status))) throw routeError('ZEUS_DIGITAL_TEAM_REWORK_IN_FLIGHT', '受影响节点仍在执行，请先暂停并完成在途核对。');
    /** 显式返工等同于用户确认这些未知结果不得采用；保留历史后再失效，不推断成功。 */
    for (const attempt of current.filter((candidate) => candidate.status === 'outcome_unknown')) {
      this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'failed', error: { code: 'ZEUS_DIGITAL_TEAM_UNKNOWN_DISCARDED_FOR_REWORK', message: reason }, completedAt: this.options.now().toISOString() });
    }
    const unrelatedUnknown = this.currentAttempts(run).some((attempt) => attempt.status === 'outcome_unknown' && !affected.has(attempt.nodeId));
    if (unrelatedUnknown) throw routeError('ZEUS_DIGITAL_TEAM_UNKNOWN_OUTCOME', '未受本次返工影响的并行节点仍有未知结果，请先明确处置对应节点。');
    this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: node.id, reason, invalidatedByAttemptId: this.options.attempts.getCurrentByNode(run.id, node.id)?.id });
    const targetStage = reworkRunStatus(node);
    const clearsCandidate = targetStage === 'planning' || targetStage === 'executing';
    this.options.runs.update(run.id, { expectedRevision: run.revision, status: targetStage, ...(clearsCandidate ? { candidateRevisions: [] } : {}), error: null });
    return this.getRunProjection(run.id);
  }

  /** 外部状态变化后立即调度。 */
  kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  /** 停止新循环并等待当前循环结束。 */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) await this.active;
  }

  /** 暴露给 Provider 的结构化工具只登记当前准确轮次的待验真 payload。 */
  readonly workTools: TaskWorkToolPort = {
    invoke: (call) => this.invokeWorkTool(call),
  };

  /** 安排下一轮恢复扫描。 */
  private schedule(delay = workflowTickMilliseconds): void {
    if (this.closed || this.timer || this.options.readOnlyValidation) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runTick();
    }, delay);
    this.timer.unref?.();
  }

  /** 串行扫描可恢复运行，单个运行失败不会阻断其他运行。 */
  private async runTick(): Promise<void> {
    if (this.closed || this.active) return;
    this.active = (async () => {
      for (const snapshot of this.options.runs.listRecoverable(100)) {
        if (this.closed) return;
        const before = this.runStateDigest(snapshot.id);
        try {
          await this.processRun(snapshot.id);
        } catch (error) {
          this.options.publish('digital_team.run.error', { runId: snapshot.id, error: serializeError(error) });
        } finally {
          await this.options.save();
          if (before !== this.runStateDigest(snapshot.id)) this.publishRunChanged(snapshot.id);
        }
      }
    })().finally(() => {
      this.active = null;
      this.schedule();
    });
    await this.active;
  }

  /** 先收口当前轮次，再按全上游成功和并发上限创建新 attempt。 */
  private async processRun(runId: string): Promise<void> {
    let run = this.options.runs.getById(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    /** 暂停后仍先接纳已经终结的准确轮次，再停止真正仍在途的工作。 */
    for (const attempt of this.currentAttempts(run)) await this.reconcileAttempt(run, attempt);
    run = this.options.runs.getById(run.id)!;
    if (run.controlState === 'paused') {
      await this.stopPausedRun(run);
      return;
    }
    if (run.controlState !== 'running' || ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)) return;
    const current = new Map(this.currentAttempts(run).map((attempt) => [attempt.nodeId, attempt]));
    const activeByEmployee = new Map<string, number>();
    for (const attempt of current.values()) {
      const node = run.definitionSnapshot.nodes.find((candidate) => candidate.id === attempt.nodeId);
      if (node?.type === 'employee' && inFlightAttemptStatuses.has(attempt.status)) activeByEmployee.set(node.data.employeeId, (activeByEmployee.get(node.data.employeeId) ?? 0) + 1);
    }
    let availableEmployees = maximumConcurrentEmployeeAttempts - [...current.values()].filter((attempt) => attempt.nodeType === 'employee' && inFlightAttemptStatuses.has(attempt.status)).length;
    for (const node of run.definitionSnapshot.nodes) {
      const prior = current.get(node.id);
      if (prior && !['invalidated', 'cancelled'].includes(prior.status)) continue;
      if (!allPredecessorsSucceeded(run, node.id, current)) continue;
      if (node.type === 'employee' && availableEmployees <= 0) continue;
      if (node.type === 'employee' && (activeByEmployee.get(node.data.employeeId) ?? 0) >= this.frozenEmployee(run, node.data.employeeId).maxConcurrency) continue;
      if (!nodeAllowedByRunState(run, node)) continue;
      const attempt = this.options.attempts.create({
        id: stableAttemptId(run.id, node.id, (prior?.attempt ?? 0) + 1),
        runId: run.id,
        nodeId: node.id,
        inputSha256: inputDigest(run, node, [...current.values()]),
        planVersion: run.planVersion || null,
        ...(node.type === 'human_confirmation' ? { status: 'awaiting_approval' as const } : {}),
      });
      current.set(node.id, attempt);
      if (node.type === 'employee') {
        availableEmployees -= 1;
        activeByEmployee.set(node.data.employeeId, (activeByEmployee.get(node.data.employeeId) ?? 0) + 1);
        await this.dispatchEmployee(run, node, attempt);
      } else if (node.type === 'code_integration') await this.integrateCandidate(run, node, attempt);
    }
  }

  /** 暂停态逐一停止准确在途工作；无法确认时转未知而不是显示已停止。 */
  private async stopPausedRun(run: DigitalTeamWorkflowRunRecord): Promise<void> {
    let unknown = false;
    for (const attempt of this.currentAttempts(run).filter((candidate) => inFlightAttemptStatuses.has(candidate.status))) {
      if (attempt.status === 'dispatching' && !attempt.submissionId) {
        this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'outcome_unknown', error: { code: 'ZEUS_DIGITAL_TEAM_DISPATCH_UNKNOWN', message: '暂停时无法确认 Provider 是否已接纳。' } });
        unknown = true;
        continue;
      }
      try {
        if (attempt.workItemId) await this.options.taskWork.stopWorkflowWorkItem(attempt.workItemId, `digital-team-pause:${run.id}:${attempt.id}`);
        const latest = this.options.attempts.getById(attempt.id);
        if (latest && inFlightAttemptStatuses.has(latest.status)) this.options.attempts.update(latest.id, { expectedRevision: latest.revision, status: 'cancelled', completedAt: this.options.now().toISOString() });
      } catch (error) {
        const latest = this.options.attempts.getById(attempt.id);
        if (latest && inFlightAttemptStatuses.has(latest.status)) this.options.attempts.update(latest.id, { expectedRevision: latest.revision, status: 'outcome_unknown', error: serializeError(error) });
        unknown = true;
      }
    }
    const latestRun = this.options.runs.getById(run.id)!;
    if (unknown && latestRun.status !== 'outcome_unknown')
      this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'outcome_unknown', error: { code: 'ZEUS_DIGITAL_TEAM_STOP_UNKNOWN', message: '至少一个在途工作停止结果未知。' } });
    else if (!unknown && latestRun.error?.code === 'ZEUS_DIGITAL_TEAM_STOPPING') this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, error: null });
  }

  /** 对已派发 attempt 绑定准确 turn，并在终态后验真结构化 payload。 */
  private async reconcileAttempt(run: DigitalTeamWorkflowRunRecord, attempt: DigitalTeamNodeAttemptRecord): Promise<void> {
    if (attempt.status === 'dispatching') {
      if (!attempt.submissionId || !attempt.conversationId) {
        if (!this.activeExternalAttemptIds.has(attempt.id)) this.markAttemptUnknown(attempt, 'ZEUS_DIGITAL_TEAM_DISPATCH_UNKNOWN', '派发没有留下耐久 submission，Zeus 不会自动重放。');
        return;
      }
      const turn = this.options.turns.listByConversation(attempt.conversationId).find((candidate) => candidate.clientSubmissionId === attempt.submissionId);
      if (!turn) {
        const submission = this.options.submissions.getById(attempt.submissionId);
        if (!submission || submission.conversationId !== attempt.conversationId) {
          this.markAttemptUnknown(attempt, 'ZEUS_DIGITAL_TEAM_SUBMISSION_MISSING', '派发记录指向的 Provider submission 不存在或会话不一致。');
        } else if (['failed', 'cancelled', 'deleted'].includes(submission.status)) {
          this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_DISPATCH_FAILED', `Provider submission 以 ${submission.status} 结束且没有创建轮次。`);
        } else if (['completed', 'resolved'].includes(submission.status)) {
          this.markAttemptUnknown(attempt, 'ZEUS_DIGITAL_TEAM_TURN_MISSING', 'Provider submission 已结束但没有可验真的轮次。');
        }
        return;
      }
      this.options.attempts.bindExecution(attempt.id, {
        expectedRevision: attempt.revision,
        workItemId: attempt.workItemId,
        workRunId: attempt.workRunId,
        conversationId: attempt.conversationId,
        submissionId: attempt.submissionId,
        turnId: turn.id,
        segmentId: turn.nativeRunId ?? turn.id,
        environmentId: attempt.environmentId,
        workspaceId: attempt.workspaceId,
        externalOperationId: attempt.externalOperationId,
      });
      return;
    }
    if (attempt.status !== 'active' || !attempt.conversationId || !attempt.turnId) return;
    const turn = this.options.turns.listByConversation(attempt.conversationId).find((candidate) => candidate.id === attempt.turnId);
    if (!turn || !terminalTurnStatuses.has(turn.status)) return;
    if (turn.status !== 'completed') {
      this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_TURN_FAILED', `Provider 轮次以 ${turn.status} 结束。`);
      return;
    }
    const node = requireNode(run, attempt.nodeId);
    if (node.type !== 'employee') return;
    if (node.data.purpose === 'plan') await this.acceptTerminalPlan(run, attempt);
    else await this.acceptTerminalResult(run, node, attempt);
  }

  /** 创建或继续员工会话；dispatching 先落库，副作用后才绑定 submission。 */
  private async dispatchEmployee(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord): Promise<void> {
    this.options.attempts.update(attempt.id, {
      expectedRevision: attempt.revision,
      status: 'dispatching',
      externalOperationId: `digital-team-dispatch:${attempt.id}`,
      startedAt: this.options.now().toISOString(),
    });
    this.activeExternalAttemptIds.add(attempt.id);
    let externalOutcomeUncertain = false;
    try {
      /** dispatching 标记必须先耐久化，重启后不猜测外部操作是否发生。 */
      await this.options.save();
      /** 只有 CTO 规划与汇总复用主会话；开发和验证返工必须创建新的准确 worktree 与 TaskWorkRun。 */
      const continued =
        node.data.purpose === 'plan' || node.data.purpose === 'summary'
          ? (this.options.attempts
              .listByRun(run.id)
              .filter((candidate) => Boolean(candidate.conversationId) && candidate.conversationId === run.mainConversationId && candidate.id !== attempt.id)
              .at(-1) ?? null)
          : null;
      /** 最新失效尝试携带本次人工返工要求，不能只保存历史而让新员工重复旧目标。 */
      /** 只传递直接针对本节点的返工要求；上游失效原因不能冒充下游的新指令。 */
      const priorAttempt = this.options.attempts
        .listByRun(run.id)
        .filter((candidate) => candidate.nodeId === node.id && candidate.attempt < attempt.attempt && candidate.status === 'invalidated')
        .sort((left, right) => right.attempt - left.attempt)[0];
      /** 人工拒绝规划或最终验收时，由对应确认节点明确退回规划或汇总。 */
      const invalidationSource = priorAttempt?.invalidatedByAttemptId ? this.options.attempts.getById(priorAttempt.invalidatedByAttemptId) : null;
      /** 自身返工和对应人工退回拥有明确的节点归属，历史无来源原因不作为指令重放。 */
      const directlyReworked = invalidationSource?.id === priorAttempt?.id || (invalidationSource?.nodeType === 'human_confirmation' && (node.data.purpose === 'plan' || node.data.purpose === 'summary'));
      const reworkReason = directlyReworked ? (priorAttempt?.invalidationReason ?? null) : null;
      const prompt = buildNodePrompt(run, node, attempt, this.currentAttempts(run), reworkReason);
      if (continued?.conversationId) {
        externalOutcomeUncertain = true;
        const accepted = await this.options.taskWork.continueWorkflowConversation({ taskId: run.taskId, conversationId: continued.conversationId, content: prompt, operationIdentity: `digital-team-turn:${attempt.id}` });
        const latest = this.options.attempts.getById(attempt.id)!;
        this.options.attempts.update(latest.id, {
          expectedRevision: latest.revision,
          workItemId: continued.workItemId,
          workRunId: continued.workRunId,
          conversationId: continued.conversationId,
          submissionId: accepted.submissionId,
          turnId: accepted.turnId,
          segmentId: accepted.turnId,
          environmentId: continued.environmentId,
          workspaceId: continued.workspaceId,
        });
        externalOutcomeUncertain = false;
      } else {
        externalOutcomeUncertain = node.data.executionMode === 'isolated_write';
        const workspace = await this.prepareEmployeeWorkspace(run, node, attempt);
        externalOutcomeUncertain = false;
        const created = await this.options.taskWork.createWorkflowWorkItem({
          taskId: run.taskId,
          employeeId: node.data.employeeId,
          employeeSnapshot: this.frozenEmployee(run, node.data.employeeId),
          sourceRef: `digital-team:${run.id}:${node.id}:attempt:${attempt.attempt}`,
          title: node.data.title,
          // 工作项说明仅作列表摘要；完整节点要求和上游证据仍保存在 supplementalInfo。
          description: node.data.instructions.slice(0, 4_000),
          supplementalInfo: prompt,
          workspace: workspace ? { mode: 'existing', environmentId: workspace.environmentId! } : { mode: 'direct' },
          purpose: node.data.purpose,
          executionMode: node.data.executionMode,
        });
        const boundWork = this.options.attempts.getById(attempt.id)!;
        this.options.attempts.update(boundWork.id, {
          expectedRevision: boundWork.revision,
          workItemId: created.item.id,
          workRunId: created.run.id,
          environmentId: workspace?.environmentId ?? null,
          workspaceId: workspace?.id ?? null,
        });
        externalOutcomeUncertain = true;
        const accepted = await this.options.taskWork.dispatchWorkflowRun(created.run.id);
        const latest = this.options.attempts.getById(attempt.id)!;
        this.options.attempts.update(latest.id, {
          expectedRevision: latest.revision,
          conversationId: accepted.run.conversationId,
          submissionId: accepted.submissionId,
          turnId: accepted.turnId,
          segmentId: accepted.turnId,
          environmentId: accepted.run.environmentId,
          workspaceId: workspace?.id ?? null,
        });
        externalOutcomeUncertain = false;
        if (node.data.purpose === 'plan' && accepted.run.conversationId) {
          const latestRun = this.options.runs.getById(run.id)!;
          this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, mainConversationId: accepted.run.conversationId });
        }
      }
      await this.bindTurnIfPresent(attempt.id);
    } catch (error) {
      const latest = this.options.attempts.getById(attempt.id);
      if (latest && inFlightAttemptStatuses.has(latest.status)) {
        const message = error instanceof Error ? error.message : String(error);
        if (!externalOutcomeUncertain || error instanceof DigitalTeamWorkflowRouteError || providerWriteDefinitelyDidNotStart(error)) this.failAttempt(latest, 'ZEUS_DIGITAL_TEAM_DISPATCH_FAILED', message);
        else this.markAttemptUnknown(latest, 'ZEUS_DIGITAL_TEAM_EXTERNAL_OUTCOME_UNKNOWN', message);
      }
    } finally {
      this.activeExternalAttemptIds.delete(attempt.id);
      await this.options.save();
    }
  }

  /** 写入节点从 exact base 和全部上游工作提交准备独立工作区。 */
  private async prepareEmployeeWorkspace(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord): Promise<ZeusTaskWorkspaceRecord | null> {
    if (node.data.executionMode === 'read_only') return null;
    if (node.data.executionMode === 'candidate_read_only') {
      if (run.candidateRevisions.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '当前真实验证入口要求运行只有一个候选仓库。');
      const workspace = this.options.workspaces.getById(run.candidateRevisions[0]!.workspaceRef);
      if (!workspace?.environmentId || workspace.headSha !== run.candidateRevisions[0]!.headSha) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '候选工作区不存在或提交已变化。');
      return workspace;
    }
    if (run.baseRevisions.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '当前真实开发入口要求项目只登记一个 Git 仓库。');
    const base = run.baseRevisions[0]!;
    const repository = this.requireRepository(run.projectId, base.repositoryId);
    const upstreamCommitShas = collectUpstreamWorkCommits(run, node.id, this.currentAttempts(run), base.repositoryId);
    const prepared = await prepareWorkflowCandidate({
      repositoryPath: repository.localPath,
      projectSlug: this.requireProject(run.projectId).slug,
      // 使用已持久化的短唯一尝试身份，避免长节点名称截断后丢失返工次数。
      candidateId: attempt.id,
      branchName: workflowBranchName(run, node, attempt, repository.id),
      baseSha: base.baseSha,
      upstreamCommitShas,
    });
    if (prepared.state !== 'ready' || !prepared.candidateSha) throw routeError('ZEUS_DIGITAL_TEAM_WORKSPACE_CONFLICT', `工作节点存在未解决冲突：${prepared.conflictFiles.join('、')}`);
    return this.registerPreparedWorkspace(run, attempt, repository, base, prepared.worktreePath, prepared.branchName, prepared.candidateSha);
  }

  /** 集成节点只形成任务内部候选，不调用正式目标分支交付。 */
  private async integrateCandidate(run: DigitalTeamWorkflowRunRecord, node: Extract<DigitalTeamNode, { type: 'code_integration' }>, attempt: DigitalTeamNodeAttemptRecord): Promise<void> {
    const dispatching = this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'dispatching', externalOperationId: `digital-team-integration:${attempt.id}`, startedAt: this.options.now().toISOString() });
    this.activeExternalAttemptIds.add(attempt.id);
    let externalOutcomeUncertain = false;
    try {
      /** Git 候选创建前先保存外部动作身份，进程退出后只核对、不盲目重放。 */
      await this.options.save();
      if (run.baseRevisions.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '当前内部候选入口要求项目只登记一个 Git 仓库。');
      const base = run.baseRevisions[0]!;
      const repository = this.requireRepository(run.projectId, base.repositoryId);
      const upstreamCommitShas = collectAllWorkCommits(run, this.currentAttempts(run), base.repositoryId);
      if (upstreamCommitShas.length === 0) throw routeError('ZEUS_DIGITAL_TEAM_INTEGRATION_INPUT_MISSING', '没有可核对的写入节点提交。');
      externalOutcomeUncertain = true;
      const prepared = await prepareWorkflowCandidate({
        repositoryPath: repository.localPath,
        projectSlug: this.requireProject(run.projectId).slug,
        // 目录与本次尝试一一对应，不依赖可被截断的可读节点名称。
        candidateId: attempt.id,
        branchName: workflowBranchName(run, node, attempt, repository.id),
        baseSha: base.baseSha,
        upstreamCommitShas,
      });
      externalOutcomeUncertain = false;
      if (prepared.state !== 'ready' || !prepared.candidateSha) {
        this.failAttempt(dispatching, 'ZEUS_DIGITAL_TEAM_INTEGRATION_CONFLICT', `候选存在冲突：${prepared.conflictFiles.join('、')}`);
        return;
      }
      const workspace = this.registerPreparedWorkspace(run, attempt, repository, base, prepared.worktreePath, prepared.branchName, prepared.candidateSha);
      let latestRun = this.options.runs.getById(run.id)!;
      if (latestRun.status === 'executing') latestRun = this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'integrating' });
      latestRun = this.options.runs.update(latestRun.id, {
        expectedRevision: latestRun.revision,
        status: 'verifying',
        candidateRevisions: [{ repositoryId: repository.id, headSha: prepared.candidateSha, workspaceRef: workspace.id }],
        error: null,
      });
      const latestAttempt = this.options.attempts.getById(attempt.id)!;
      this.options.attempts.update(latestAttempt.id, { expectedRevision: latestAttempt.revision, status: 'active', environmentId: workspace.environmentId, workspaceId: workspace.id });
      const activeAttempt = this.options.attempts.getById(attempt.id)!;
      this.options.attempts.update(activeAttempt.id, { expectedRevision: activeAttempt.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
    } catch (error) {
      const latest = this.options.attempts.getById(attempt.id);
      if (latest && latest.status === 'dispatching') {
        const message = error instanceof Error ? error.message : String(error);
        if (!externalOutcomeUncertain || error instanceof DigitalTeamWorkflowRouteError) this.failAttempt(latest, 'ZEUS_DIGITAL_TEAM_INTEGRATION_FAILED', message);
        else this.markAttemptUnknown(latest, 'ZEUS_DIGITAL_TEAM_INTEGRATION_UNKNOWN', message);
      }
    } finally {
      this.activeExternalAttemptIds.delete(attempt.id);
    }
  }

  /** 把物理候选 worktree 登记为现有任务环境，供 task_push 精确复用。 */
  private registerPreparedWorkspace(
    run: DigitalTeamWorkflowRunRecord,
    attempt: DigitalTeamNodeAttemptRecord,
    repository: ZeusProjectRepositoryRecord,
    base: DigitalTeamBaseRevision,
    worktreePath: string,
    branchName: string,
    inputHeadSha: string,
  ): ZeusTaskWorkspaceRecord {
    const environmentId = stableIdentity('task_environment', attempt.id).slice(0, 41);
    const workspaceId = stableIdentity('task_workspace', `${attempt.id}\0${repository.id}`).slice(0, 39);
    const existing = this.options.workspaces.getById(workspaceId);
    if (existing) {
      if (existing.taskId !== run.taskId || existing.worktreePath !== worktreePath || existing.headSha !== inputHeadSha) throw routeError('ZEUS_DIGITAL_TEAM_WORKSPACE_MISMATCH', '恢复的工作区与冻结节点输入不一致。');
      return existing;
    }
    const environment = this.options.environments.getById(environmentId) ?? this.options.environments.create({ id: environmentId, projectId: run.projectId, taskId: run.taskId, rootPath: worktreePath, state: 'ready' });
    return this.options.workspaces.create({
      id: workspaceId,
      projectId: run.projectId,
      taskId: run.taskId,
      environmentId: environment.id,
      repositoryId: repository.id,
      repositoryName: repository.name,
      repositoryRelativePath: repository.relativePath,
      repositoryPath: repository.localPath,
      branchName,
      sourceBranch: base.sourceRef,
      sourceHeadSha: inputHeadSha,
      remoteBranch: branchName,
      worktreePath,
      headSha: inputHeadSha,
      state: 'ready',
    });
  }

  /** CTO 规划只在 exact turn 成功终态后进入待批准。 */
  private async acceptTerminalPlan(run: DigitalTeamWorkflowRunRecord, attempt: DigitalTeamNodeAttemptRecord): Promise<void> {
    const pending = isRecord(attempt.artifactRef) && attempt.artifactRef.kind === 'pending_team_plan' ? attempt.artifactRef.plan : null;
    const errors = validateDigitalTeamStructuredPlan(run.definitionSnapshot, pending);
    if (errors.length > 0) {
      this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_PLAN_MISSING', errors[0] ?? 'CTO 未提交结构化计划。');
      return;
    }
    const latestRun = this.options.runs.getById(run.id)!;
    this.options.runs.submitPlan(latestRun.id, { expectedRevision: latestRun.revision, plan: pending as DigitalTeamStructuredPlan });
    const latest = this.options.attempts.getById(attempt.id)!;
    this.options.attempts.update(latest.id, { expectedRevision: latest.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
  }

  /** 员工结果在终态后核对 exact-turn 证据和准确 Git 版本。 */
  private async acceptTerminalResult(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord): Promise<void> {
    const submittedResult = attempt.result;
    if (!submittedResult) {
      this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_RESULT_MISSING', 'Provider 轮次结束前未提交结构化结果。');
      return;
    }
    /** 内部证据身份、摘要和状态只由 Core 从当前准确轮次生成，模型不能伪造或猜测。 */
    const result: DigitalTeamStructuredResult = { ...submittedResult, evidence: this.buildExactTurnEvidence(run, attempt, submittedResult) };
    try {
      await this.verifyResultEvidence(run, node, attempt, result);
      if (result.outcome !== 'succeeded' || (node.data.purpose === 'verify' && result.verification !== 'passed')) {
        this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_RESULT_FAILED', result.summary, result);
        return;
      }
      const latest = this.options.attempts.getById(attempt.id)!;
      this.options.attempts.submitResult(latest.id, {
        expectedRevision: latest.revision,
        result,
        verifiedCandidateSetSha256: node.data.purpose === 'verify' ? run.candidateSetSha256 : null,
        artifactRef: result.artifactRefs[0] ?? null,
      });
      if (latest.workRunId && node.data.purpose !== 'summary') this.options.taskWork.settleWorkflowWorkItem(latest.workRunId, 'succeeded');
      let latestRun = this.options.runs.getById(run.id)!;
      if (node.data.purpose === 'verify' && allPurposeSucceeded(latestRun, 'verify', this.currentAttempts(latestRun))) {
        latestRun = this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'summarizing' });
      } else if (node.data.purpose === 'summary') {
        this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'awaiting_final_approval' });
      }
    } catch (error) {
      this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_RESULT_EVIDENCE_INVALID', error instanceof Error ? error.message : String(error), result);
    }
  }

  /** 从当前准确轮次生成可审计证据目录；长产物和候选仍保留受控引用。 */
  private buildExactTurnEvidence(run: DigitalTeamWorkflowRunRecord, attempt: DigitalTeamNodeAttemptRecord, result: DigitalTeamStructuredResult): DigitalTeamStructuredResult['evidence'] {
    /** 当前 Provider 轮次内可核对的消息与命令记录。 */
    const itemEvidence = this.options.providerItems
      .listByConversation(attempt.conversationId!)
      .filter((item) => item.turnId === attempt.turnId && (item.itemType === 'agentMessage' || item.itemType === 'commandExecution'))
      .map((item) => ({ kind: item.itemType === 'agentMessage' ? ('message' as const) : ('command' as const), id: item.id, sha256: sha256(item.textContent), status: item.status }));
    /** 当前轮次的代码变化证据。 */
    const change = this.options.turnChanges.getByTurn(attempt.conversationId!, attempt.turnId!);
    /** 模型声明的受控长产物只提取可复核的所有者和摘要。 */
    const artifactEvidence = result.artifactRefs.flatMap((artifactRef) => {
      if (typeof artifactRef.sha256 !== 'string' || !isRecord(artifactRef.owner) || typeof artifactRef.owner.id !== 'string') return [];
      return [{ kind: 'artifact' as const, id: artifactRef.owner.id, sha256: artifactRef.sha256, status: 'referenced' }];
    });
    /** 当前运行的候选证据由冻结候选账本生成。 */
    const candidateEvidence = run.candidateRevisions.map((candidate) => ({ kind: 'git_candidate' as const, id: candidate.workspaceRef, sha256: sha256(candidate.headSha), status: 'ready' }));
    return [...itemEvidence, ...(change ? [{ kind: 'change_set' as const, id: change.id, sha256: sha256(change.unifiedDiff), status: change.state }] : []), ...artifactEvidence, ...candidateEvidence];
  }

  /** 证据必须属于当前 attempt 的 exact turn，写入和验证还要核对物理 HEAD。 */
  private async verifyResultEvidence(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord, result: DigitalTeamStructuredResult): Promise<void> {
    const items = this.options.providerItems.listByConversation(attempt.conversationId!).filter((item) => item.turnId === attempt.turnId);
    const change = this.options.turnChanges.getByTurn(attempt.conversationId!, attempt.turnId!);
    /** 当前准确轮次内退出码为零的真实 shell 命令。 */
    const successfulVerificationCommands: string[] = [];
    for (const evidence of result.evidence) {
      if (evidence.kind === 'message' || evidence.kind === 'command') {
        const item = items.find((candidate) => candidate.id === evidence.id && (evidence.kind === 'message' ? candidate.itemType === 'agentMessage' : candidate.itemType === 'commandExecution'));
        if (!item || item.status !== evidence.status || sha256(item.textContent) !== evidence.sha256) throw new Error(`证据 ${evidence.id} 不属于当前轮次或摘要不一致。`);
        if (evidence.kind === 'command' && item.status === 'completed') {
          const payload = parseJsonRecord(item.payloadJson);
          if (payload.exitCode === 0 && typeof payload.command === 'string') {
            successfulVerificationCommands.push(payload.command);
            /** 单个 unknown 动作保留 Provider 原始完整命令，避免展示用 shell 包装造成误拒绝；不拆分组合命令或采用读写摘要。 */
            const actions = payload.commandActions;
            if (Array.isArray(actions) && actions.length === 1) {
              /** 只接受 Provider 原始命令动作，不把多个子动作的整体成功误当逐条成功。 */
              const action = actions[0];
              if (action && typeof action === 'object' && action.type === 'unknown' && typeof action.command === 'string') successfulVerificationCommands.push(action.command);
            }
          }
        }
      } else if (evidence.kind === 'change_set') {
        if (!change || change.id !== evidence.id || sha256(change.unifiedDiff) !== evidence.sha256 || change.state !== evidence.status) throw new Error(`变化证据 ${evidence.id} 不属于当前轮次。`);
      } else if (evidence.kind === 'artifact') {
        const artifactRef = result.artifactRefs.find((candidate) => candidate.sha256 === evidence.sha256 && candidate.owner && isRecord(candidate.owner) && candidate.owner.id === evidence.id);
        if (!artifactRef || typeof artifactRef.sha256 !== 'string' || !isRecord(artifactRef.owner) || typeof artifactRef.owner.kind !== 'string' || typeof artifactRef.owner.id !== 'string')
          throw new Error(`产物证据 ${evidence.id} 缺少受控引用。`);
        await this.options.artifacts.resolveAuthorized({ sha256: artifactRef.sha256, owner: { kind: artifactRef.owner.kind, id: artifactRef.owner.id }, verifyHash: true });
      } else if (evidence.kind === 'git_candidate') {
        if (!run.candidateRevisions.some((candidate) => candidate.workspaceRef === evidence.id && sha256(candidate.headSha) === evidence.sha256)) throw new Error(`候选证据 ${evidence.id} 已失效。`);
      }
    }
    if (node.data.executionMode === 'isolated_write') {
      const workspace = attempt.workspaceId ? this.options.workspaces.getById(attempt.workspaceId) : undefined;
      if (!workspace?.worktreePath) throw new Error('写入节点缺少冻结工作区。');
      const review = await getTaskWorkspaceReview(workspace.worktreePath);
      const repositoryResult = result.repositoryResults.find((candidate) => candidate.repositoryId === workspace.repositoryId);
      if (!review.clean || !repositoryResult || repositoryResult.baseSha !== workspace.sourceHeadSha || repositoryResult.headSha !== review.headSha || repositoryResult.headSha === repositoryResult.baseSha) {
        throw new Error('写入结果没有绑定干净工作区的准确输入和提交。');
      }
    }
    if (node.data.purpose === 'verify') {
      const missingCommands = missingDigitalTeamVerificationCommands(node.data.verificationCommands ?? [], successfulVerificationCommands);
      if (missingCommands.length > 0) throw new Error(`验证节点缺少当前轮次成功命令：${missingCommands.join('；')}`);
      const workspace = attempt.workspaceId ? this.options.workspaces.getById(attempt.workspaceId) : undefined;
      const candidate = workspace ? run.candidateRevisions.find((entry) => entry.workspaceRef === workspace.id) : undefined;
      const review = workspace?.worktreePath ? await getTaskWorkspaceReview(workspace.worktreePath) : null;
      if (!workspace || !candidate || !review?.clean || review.headSha !== candidate.headSha) throw new Error('验证轮次没有绑定当前干净候选版本。');
    }
  }

  /** 动态工具调用只可命中当前 run/node/attempt/exact turn。 */
  private async invokeWorkTool(call: BrowserAutomationToolCall): Promise<BrowserAutomationToolResult> {
    try {
      const turn = this.options.turns.listByConversation(call.conversationId).find((candidate) => candidate.providerThreadId === call.threadId && candidate.providerTurnId === call.turnId);
      if (!turn) throw routeError('ZEUS_DIGITAL_TEAM_TOOL_SCOPE', '当前 Provider 轮次未登记。');
      const conversation = this.options.conversations.getRecordById(call.conversationId);
      if (!conversation?.taskId) throw routeError('ZEUS_DIGITAL_TEAM_TOOL_SCOPE', '当前会话不属于任务。');
      const attempt = this.options.runs
        .listByTask(conversation.taskId)
        .flatMap((run) => this.options.attempts.listByRun(run.id))
        .find((candidate) => candidate.conversationId === call.conversationId && candidate.submissionId === turn.clientSubmissionId && candidate.turnId === turn.id && candidate.status === 'active');
      if (!attempt || this.options.attempts.getCurrentByNode(attempt.runId, attempt.nodeId)?.id !== attempt.id) throw routeError('ZEUS_DIGITAL_TEAM_TOOL_SCOPE', '该轮次不是当前数字团队节点尝试。');
      const run = this.options.runs.getById(attempt.runId)!;
      const node = requireNode(run, attempt.nodeId);
      if (node.type !== 'employee') throw routeError('ZEUS_DIGITAL_TEAM_TOOL_SCOPE', '只有员工节点可以提交结构化结果。');
      if (call.tool === 'submit_team_plan') {
        if (node.data.purpose !== 'plan') throw routeError('ZEUS_DIGITAL_TEAM_TOOL_SCOPE', '当前节点不是 CTO 规划节点。');
        const errors = validateDigitalTeamStructuredPlan(run.definitionSnapshot, call.arguments);
        if (errors.length > 0) throw routeError('ZEUS_DIGITAL_TEAM_PLAN_INVALID', errors[0]!, 400);
        const next = { kind: 'pending_team_plan', plan: structuredClone(call.arguments), callId: call.callId, turnId: turn.id };
        if (attempt.artifactRef && stableJson(attempt.artifactRef) !== stableJson(next)) throw routeError('ZEUS_DIGITAL_TEAM_TOOL_REPLAY_CONFLICT', '当前尝试已提交不同规划。');
        if (!attempt.artifactRef) this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, artifactRef: next });
      } else if (call.tool === 'submit_team_result') {
        if (!isStructuredResultSubmission(call.arguments)) throw routeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '结构化结果字段不完整。', 400);
        /** 在写入待核验结果前反馈职责字段错误，让只读节点在当前轮次纠正，避免结束后才发现无法采用。 */
        if (node.data.executionMode !== 'isolated_write' && call.arguments.repositoryResults.length > 0)
          throw routeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '只读节点的 repositoryResults 必须为空数组；请将已验证候选填写到 verifiedCandidates 后重新提交。', 400);
        /** 先保存业务结论；准确证据在轮次终态后由 Core 补齐。 */
        const result = { ...structuredClone(call.arguments), evidence: [] } as DigitalTeamStructuredResult;
        if (attempt.result && stableJson(attempt.result) !== stableJson(result)) throw routeError('ZEUS_DIGITAL_TEAM_TOOL_REPLAY_CONFLICT', '当前尝试已提交不同结果。');
        if (!attempt.result) this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, result });
      } else throw routeError('ZEUS_DIGITAL_TEAM_TOOL_UNKNOWN', '不支持该数字团队工具。', 400);
      await this.options.save();
      this.publishRunChanged(run.id);
      this.kick();
      return toolResult(true, { accepted: true, runId: run.id, nodeId: node.id, attempt: attempt.attempt, status: 'pending_terminal_verification' });
    } catch (error) {
      return toolResult(false, serializeError(error));
    }
  }

  /** submission 已产生 turn 时立刻绑定，否则由恢复循环继续核对。 */
  private async bindTurnIfPresent(attemptId: string): Promise<void> {
    const attempt = this.options.attempts.getById(attemptId);
    if (!attempt || attempt.status !== 'dispatching' || !attempt.conversationId || !attempt.submissionId) return;
    const turn = this.options.turns.listByConversation(attempt.conversationId).find((candidate) => candidate.clientSubmissionId === attempt.submissionId);
    if (!turn) return;
    this.options.attempts.bindExecution(attempt.id, {
      expectedRevision: attempt.revision,
      workItemId: attempt.workItemId,
      workRunId: attempt.workRunId,
      conversationId: attempt.conversationId,
      submissionId: attempt.submissionId,
      turnId: turn.id,
      segmentId: turn.nativeRunId ?? turn.id,
      environmentId: attempt.environmentId,
      workspaceId: attempt.workspaceId,
      externalOperationId: attempt.externalOperationId,
    });
  }

  /** 将确定失败保存为可人工返工节点，不自动循环。 */
  private failAttempt(attempt: DigitalTeamNodeAttemptRecord, code: string, message: string, result?: DigitalTeamStructuredResult): void {
    const latest = this.options.attempts.getById(attempt.id);
    if (!latest || !['active', 'dispatching', 'prepared'].includes(latest.status)) return;
    this.options.attempts.update(latest.id, { expectedRevision: latest.revision, status: 'failed', ...(result ? { result } : {}), error: { code, message }, completedAt: this.options.now().toISOString() });
    const run = this.options.runs.getById(latest.runId);
    if (run && !['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)) this.options.runs.update(run.id, { expectedRevision: run.revision, error: { code: 'ZEUS_DIGITAL_TEAM_NODE_FAILED', message } });
    const node = run ? requireNode(run, latest.nodeId) : null;
    if (latest.workRunId && !(node?.type === 'employee' && (node.data.purpose === 'plan' || node.data.purpose === 'summary'))) this.options.taskWork.settleWorkflowWorkItem(latest.workRunId, 'failed', message);
  }

  /** 将副作用不明保存为人工核对态，重启不自动重放。 */
  private markAttemptUnknown(attempt: DigitalTeamNodeAttemptRecord, code: string, message: string): void {
    const latest = this.options.attempts.getById(attempt.id);
    if (!latest || !['dispatching', 'active'].includes(latest.status)) return;
    this.options.attempts.update(latest.id, { expectedRevision: latest.revision, status: 'outcome_unknown', error: { code, message } });
    const run = this.options.runs.getById(latest.runId);
    if (run && run.status !== 'outcome_unknown') this.options.runs.update(run.id, { expectedRevision: run.revision, status: 'outcome_unknown', error: { code, message } });
  }

  /** 返回每个节点最新 attempt。 */
  private currentAttempts(run: DigitalTeamWorkflowRunRecord): DigitalTeamNodeAttemptRecord[] {
    return run.definitionSnapshot.nodes.flatMap((node) => {
      const attempt = this.options.attempts.getCurrentByNode(run.id, node.id);
      return attempt ? [attempt] : [];
    });
  }

  /** 生成足以判断公开运行投影是否变化的有界摘要。 */
  private runStateDigest(runId: string): string | null {
    const run = this.options.runs.getById(runId);
    if (!run) return null;
    const attempts = this.options.attempts.listByRun(run.id).map((attempt) => ({ id: attempt.id, revision: attempt.revision, status: attempt.status }));
    return sha256(stableJson({ revision: run.revision, attempts }));
  }

  /** 发布前端订阅的统一运行变化事件。 */
  private publishRunChanged(runId: string): void {
    const run = this.options.runs.getById(runId);
    if (!run) return;
    this.options.publish('digital_team.run.changed', { runId: run.id, taskId: run.taskId, projectId: run.projectId, revision: run.revision });
  }

  /** 要求项目存在。 */
  private requireProject(projectId: string) {
    const project = this.options.projects.getById(projectId);
    if (!project) throw routeError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
    return project;
  }

  /** 要求运行存在且修订准确。 */
  private requireRun(runId: string, expectedRevision?: number): DigitalTeamWorkflowRunRecord {
    const run = this.options.runs.getById(runId);
    if (!run) throw routeError('ZEUS_DIGITAL_TEAM_RUN_NOT_FOUND', '数字团队运行不存在。', 404);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) throw routeError('ZEUS_DIGITAL_TEAM_REVISION_INVALID', '运行修订无效。', 400);
    if (expectedRevision !== undefined && run.revision !== expectedRevision) throw routeError('ZEUS_DIGITAL_TEAM_REVISION_CONFLICT', '运行已变化，请刷新后重试。');
    return run;
  }

  /** 要求逐仓登记存在且仍属于项目。 */
  private requireRepository(projectId: string, repositoryId: string): ZeusProjectRepositoryRecord {
    const repository = this.options.projectRepositories.listByProject(projectId).find((candidate) => candidate.id === repositoryId);
    if (!repository) throw routeError('ZEUS_DIGITAL_TEAM_REPOSITORY_STALE', '冻结仓库登记已经失效。');
    return repository;
  }

  /** 运行只能读取创建时冻结的角色配置，后续员工编辑不影响当前流程。 */
  private frozenEmployee(run: DigitalTeamWorkflowRunRecord, employeeId: string): DigitalEmployeeRecord {
    const snapshot = run.roleSnapshots.find((candidate) => candidate.employeeId === employeeId);
    const configuration = snapshot?.configuration;
    if (!snapshot || !isRecord(configuration) || configuration.id !== employeeId || configuration.projectId !== run.projectId || configuration.revision !== snapshot.employeeRevision) {
      throw routeError('ZEUS_DIGITAL_TEAM_EMPLOYEE_SNAPSHOT_INVALID', '运行中的冻结员工配置已损坏。', 500);
    }
    return structuredClone(configuration) as unknown as DigitalEmployeeRecord;
  }

  /** 人工批准前要求直接上游 attempt 成功且 exact turn 已完成。 */
  private assertApprovalUpstreamTerminal(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamNode): void {
    const current = new Map(this.currentAttempts(run).map((attempt) => [attempt.nodeId, attempt]));
    for (const predecessorId of directPredecessorIds(run, node.id)) {
      const predecessor = current.get(predecessorId);
      if (!predecessor || predecessor.status !== 'succeeded') throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_UPSTREAM_INCOMPLETE', '批准节点的上游尚未成功完成。');
      if (predecessor.turnId) {
        const turn = predecessor.conversationId ? this.options.turns.listByConversation(predecessor.conversationId).find((candidate) => candidate.id === predecessor.turnId) : undefined;
        if (!turn || turn.status !== 'completed') throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_UPSTREAM_INCOMPLETE', '上游 Provider 轮次尚未成功终结。');
      }
    }
  }
}

/** Provider 登录门禁发生在写入前，可以安全归类为失败并允许人工返工。 */
function providerWriteDefinitelyDidNotStart(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && Reflect.get(error, 'code') === 'ZEUS_CODEX_LOGIN_REQUIRED');
}

/** 直接前驱全部成功后才可派发。 */
function allPredecessorsSucceeded(run: DigitalTeamWorkflowRunRecord, nodeId: string, current: Map<string, DigitalTeamNodeAttemptRecord>): boolean {
  return directPredecessorIds(run, nodeId).every((predecessorId) => current.get(predecessorId)?.status === 'succeeded');
}

/** 返回节点直接前驱。 */
function directPredecessorIds(run: DigitalTeamWorkflowRunRecord, nodeId: string): string[] {
  return run.definitionSnapshot.edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
}

/** 运行阶段限制关键节点，防止只靠连线绕过审批。 */
function nodeAllowedByRunState(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamNode): boolean {
  if (node.type === 'start' || node.type === 'end') return false;
  if (node.type === 'human_confirmation') return node.data.purpose === 'plan_approval' ? run.status === 'awaiting_plan_approval' : run.status === 'awaiting_final_approval';
  if (node.type === 'code_integration') return run.status === 'executing';
  if (node.data.purpose === 'plan') return run.status === 'planning';
  if (node.data.purpose === 'work') return run.status === 'executing' && Boolean(run.approvedPlanSha256);
  if (node.data.purpose === 'verify') return run.status === 'verifying' && Boolean(run.candidateSetSha256);
  return node.data.purpose === 'summary' && run.status === 'summarizing';
}

/** 返工从目标职责对应阶段继续，不破坏未受影响的并行兄弟。 */
function reworkRunStatus(node: DigitalTeamNode): Extract<DigitalTeamWorkflowRunRecord['status'], 'planning' | 'executing' | 'verifying' | 'summarizing'> {
  if (node.type === 'code_integration') return 'executing';
  if (node.type !== 'employee') throw routeError('ZEUS_DIGITAL_TEAM_REWORK_INVALID', '该节点不支持返工。', 400);
  if (node.data.purpose === 'plan') return 'planning';
  if (node.data.purpose === 'verify') return 'verifying';
  if (node.data.purpose === 'summary') return 'summarizing';
  return 'executing';
}

/** 判断某一员工职责的全部节点均成功。 */
function allPurposeSucceeded(run: DigitalTeamWorkflowRunRecord, purpose: DigitalTeamEmployeeNode['data']['purpose'], attempts: DigitalTeamNodeAttemptRecord[]): boolean {
  const current = new Map(attempts.map((attempt) => [attempt.nodeId, attempt]));
  return run.definitionSnapshot.nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee' && node.data.purpose === purpose).every((node) => current.get(node.id)?.status === 'succeeded');
}

/** 收集目标节点全部祖先。 */
function ancestorIds(run: DigitalTeamWorkflowRunRecord, nodeId: string): Set<string> {
  const result = new Set<string>();
  const pending = directPredecessorIds(run, nodeId);
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...directPredecessorIds(run, current));
  }
  return result;
}

/** 收集目标节点及全部后继。 */
function descendantIds(run: DigitalTeamWorkflowRunRecord, nodeId: string): Set<string> {
  const outgoing = new Map(run.definitionSnapshot.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of run.definitionSnapshot.edges) outgoing.get(edge.source)!.push(edge.target);
  const result = new Set<string>();
  const pending = [nodeId];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return result;
}

/** 逐节点写入只继承其全部工作祖先的准确提交。 */
function collectUpstreamWorkCommits(run: DigitalTeamWorkflowRunRecord, nodeId: string, attempts: DigitalTeamNodeAttemptRecord[], repositoryId: string): string[] {
  const ancestors = ancestorIds(run, nodeId);
  return collectWorkCommits(
    run,
    attempts.filter((attempt) => ancestors.has(attempt.nodeId)),
    repositoryId,
  );
}

/** 集成节点收集全部成功工作节点提交。 */
function collectAllWorkCommits(run: DigitalTeamWorkflowRunRecord, attempts: DigitalTeamNodeAttemptRecord[], repositoryId: string): string[] {
  return collectWorkCommits(run, attempts, repositoryId);
}

/** 从成功工作结果按画布节点顺序去重提取提交。 */
function collectWorkCommits(run: DigitalTeamWorkflowRunRecord, attempts: DigitalTeamNodeAttemptRecord[], repositoryId: string): string[] {
  const byNode = new Map(attempts.filter((attempt) => attempt.status === 'succeeded').map((attempt) => [attempt.nodeId, attempt]));
  return [
    ...new Set(
      run.definitionSnapshot.nodes.flatMap((node) => {
        if (node.type !== 'employee' || node.data.purpose !== 'work' || node.data.executionMode !== 'isolated_write') return [];
        return (
          byNode
            .get(node.id)
            ?.result?.repositoryResults.filter((result) => result.repositoryId === repositoryId)
            .map((result) => result.headSha) ?? []
        );
      }),
    ),
  ];
}

/** 构造节点输入摘要，包含计划、直接上游当前结果和候选版本。 */
function inputDigest(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamNode, currentAttempts: DigitalTeamNodeAttemptRecord[]): string {
  const byNode = new Map(currentAttempts.map((attempt) => [attempt.nodeId, attempt]));
  const predecessors = run.definitionSnapshot.edges
    .filter((edge) => edge.target === node.id)
    .map((edge) => edge.source)
    .sort()
    .map((nodeId) => {
      const attempt = byNode.get(nodeId);
      return attempt
        ? {
            nodeId,
            attemptId: attempt.id,
            attempt: attempt.attempt,
            status: attempt.status,
            resultSha256: attempt.result ? sha256(stableJson(attempt.result)) : null,
            artifactSha256: attempt.artifactRef ? sha256(stableJson(attempt.artifactRef)) : null,
            verifiedCandidateSetSha256: attempt.verifiedCandidateSetSha256,
          }
        : { nodeId, attemptId: null };
    });
  return sha256(stableJson({ node, planVersion: run.planVersion, planSha256: run.approvedPlanSha256 ?? run.planSha256, predecessors, baseRevisions: run.baseRevisions, candidateSetSha256: run.candidateSetSha256 }));
}

/** 构造节点提示并明确只接受结构化工具提交。 */
function buildNodePrompt(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord, attempts: DigitalTeamNodeAttemptRecord[], reworkReason: string | null): string {
  const assignment = run.plan?.assignments.find((candidate) => candidate.nodeId === node.id) ?? null;
  const predecessorIds = new Set(directPredecessorIds(run, node.id));
  const upstream = attempts
    .filter((candidate) => predecessorIds.has(candidate.nodeId) && candidate.status === 'succeeded')
    .map((candidate) => ({ nodeId: candidate.nodeId, attempt: candidate.attempt, result: candidate.result, artifactRef: candidate.artifactRef }));
  const action = node.data.purpose === 'plan' ? '请使用 zeus_work.submit_team_plan 提交逐 nodeId 计划。' : '请使用 zeus_work.submit_team_result 提交结构化结果；最终文字不会推进流程。';
  return `${node.data.instructions}\n\n数字团队冻结上下文：\n${stableJson({ runId: run.id, nodeId: node.id, attempt: attempt.attempt, executionMode: node.data.executionMode, reworkReason, taskFacts: run.taskFacts, baseRevisions: run.baseRevisions, candidateRevisions: run.candidateRevisions, verificationCommands: node.data.purpose === 'verify' ? node.data.verificationCommands : undefined, assignment, upstream })}\n\n${action}`;
}

/** 构造符合现有分支约束的短稳定名字。 */
function workflowBranchName(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamNode, attempt: DigitalTeamNodeAttemptRecord, repositoryId: string): string {
  return `zeus/digital-team-${sha256(`${run.id}\0${node.id}\0${attempt.attempt}\0${repositoryId}`).slice(0, 20)}`;
}

/** 构造稳定节点 attempt 身份。 */
function stableAttemptId(runId: string, nodeId: string, attempt: number): string {
  return stableIdentity('digital_team_attempt', `${runId}\0${nodeId}\0${attempt}`);
}

/** 由输入生成固定长度业务身份。 */
function stableIdentity(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 32)}`;
}

/** 稳定 JSON 用于幂等比较和摘要。 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** 计算 SHA-256。 */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 判断普通 JSON 对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 解析受控仓储中的 JSON 对象，损坏值按空对象处理并由上层证据校验拒绝。 */
function parseJsonRecord(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 校验结构化员工结果的最小可信形状。 */
function isStructuredResultSubmission(value: unknown): value is Omit<DigitalTeamStructuredResult, 'evidence'> {
  return (
    isRecord(value) &&
    ['succeeded', 'failed', 'blocked'].includes(String(value.outcome)) &&
    ['passed', 'failed', 'not_run'].includes(String(value.verification)) &&
    typeof value.summary === 'string' &&
    Boolean(value.summary.trim()) &&
    Array.isArray(value.repositoryResults) &&
    Array.isArray(value.verifiedCandidates) &&
    Array.isArray(value.artifactRefs) &&
    Array.isArray(value.remainingIssues)
  );
}

/** 要求冻结画布节点存在。 */
function requireNode(run: DigitalTeamWorkflowRunRecord, nodeId: string): DigitalTeamNode {
  const node = run.definitionSnapshot.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw routeError('ZEUS_DIGITAL_TEAM_NODE_NOT_FOUND', '运行节点不存在。', 404);
  return node;
}

/** 人工批准拒绝系统或 worker 冒充用户。 */
function requireHumanActor(context: DigitalTeamCommandContext): void {
  if (!['user', 'local_api', 'remote_control'].includes(context.actor.kind)) throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_ACTOR_INVALID', '人工批准必须由真实用户入口发起。', 400);
}

/** 读取任务事实布尔开关。 */
function taskFactBoolean(facts: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof facts[key] === 'boolean' ? facts[key] : fallback;
}

/** 校验有界必填文字。 */
function requiredText(value: unknown, message: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw routeError('ZEUS_DIGITAL_TEAM_INPUT_INVALID', message, 400);
  return value.trim();
}

/** 构造 HTTP 可识别的数字团队错误。 */
function routeError(code: string, message: string, statusCode = 409): DigitalTeamWorkflowRouteError {
  return new DigitalTeamWorkflowRouteError(statusCode, code, message);
}

/** 返回 Provider 动态工具结果。 */
function toolResult(success: boolean, value: unknown): BrowserAutomationToolResult {
  return { success, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] };
}

/** 将异常压缩为可展示且不含堆栈的结构。 */
function serializeError(error: unknown): { code: string; message: string } {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : 'ZEUS_DIGITAL_TEAM_FAILED';
  return { code, message: error instanceof Error ? error.message : String(error) };
}
