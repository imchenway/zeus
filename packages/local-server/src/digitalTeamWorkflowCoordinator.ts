import { createHash } from 'node:crypto';
import { getGitRepositoryContext, getGitWorktreeClean, getTaskWorkspaceReview, prepareWorkflowCandidate } from '@zeus/git-core';
import {
  digitalTeamExecutionDefinition,
  digitalTeamWorkflowSchemaGeneration,
  missingDigitalTeamVerificationCommands,
  validateDigitalTeamStructuredPlan,
  validateDigitalTeamProjectWorkflowStatuses,
  normalizeDigitalTeamWorkflowDefinition,
  resolveDigitalTeamAssignmentEntry,
  type DigitalTeamEmployeeNode,
  type DigitalTeamNode,
  type DigitalTeamStructuredPlan,
  type DigitalTeamStructuredResult,
  type DigitalTeamWorkflowDefinition,
  type DigitalTeamRunRuntimeState,
} from '@zeus/shared';
import {
  type ArtifactStore,
  type ConversationProviderItemRepository,
  type ConversationRepository,
  type ConversationSubmissionRepository,
  type ConversationTurnRepository,
  type DigitalEmployeeRecord,
  type DefectWorkflowRepository,
  type DefectWorkflowRecord,
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
  type ZeusTaskRecord,
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

/** Provider 仍可能写入的节点状态。 */
const inFlightAttemptStatuses = new Set<DigitalTeamNodeAttemptRecord['status']>(['dispatching', 'active']);

/** Provider 轮次可据此做最终验真的终态。 */
const terminalTurnStatuses = new Set(['completed', 'interrupted', 'failed']);

/** 创建运行前只读冻结的仓库事实。 */
interface PreparedDigitalTeamRun {
  /** 预检所见的准确任务事实，关闭异步仓库检查后的改派竞态。 */
  expectedTaskUpdatedAt?: string;
  /** 指派接纳的耐久入口与成果绑定。 */
  runtimeState?: DigitalTeamRunRuntimeState;
  /** 重复触发或人工改派关联已有流程。 */
  existingRunId?: string;
  /** 已确认修订的模板。 */
  templateId: string;
  /** 已确认模板修订。 */
  templateRevision: number;
  /** 已确认修订且可用于创建运行的团队定义。 */
  definition: DigitalTeamWorkflowDefinition;
  /** 逐仓冻结基线。 */
  baseRevisions: DigitalTeamBaseRevision[];
  /** 逐仓登记记录，供后续 worktree 绑定。 */
  repositories: ZeusProjectRepositoryRecord[];
}

/** 手动、状态与自动化统一使用的项目流程指派输入。 */
export interface DigitalTeamEmployeeAssignmentInput {
  /** 本次用户或自动化来源冻结的最大权限。 */
  permissionMode?: 'read-only' | 'auto' | 'full-access';
  /** 当前任务身份。 */
  taskId: string;
  /** 全局员工或明确项目绑定身份。 */
  employeeId: string;
  /** 防止过期任务事实进入流程。 */
  expectedTaskUpdatedAt?: string;
  /** 当前任务明确选择的上游正式成果。 */
  inputDeliverableIds?: string[];
  /** 人工改派保留的交接原因。 */
  reason?: string;
}

/** 任务创建与明确权限更新复用已有 Core 业务操作，不另发第二份 HTTP 命令。 */
interface DigitalTeamTaskCreationPort {
  /** 在同一 Core transaction 创建任务。 */
  create(input: CreateUserTaskInput, taskId: string, context: DigitalTeamCommandContext & { /** 可信团队来源不替换真实操作者。 */ taskOrigin: 'digital_team_workflow' }): unknown;
  /** 用户明确授权时在同一 Core transaction 更新任务权限，并保留任务审计和事件。 */
  grantCodeAuthority?(taskId: string, expectedUpdatedAt: string, context: DigitalTeamCommandContext): ZeusTaskRecord;
}

/** 协调器依赖均为已有权威仓储或受控执行端口。 */
export interface DigitalTeamWorkflowCoordinatorOptions {
  /** 正式缺陷、被测现场和修复成果账本。 */
  defects: DefectWorkflowRepository;
  /** 校验项目真实任务状态，禁止把显示名当成身份。 */
  validateTaskStatus?(projectId: string, statusId: string): boolean;
  /** 只读映射退役前冻结的状态身份，不让旧项目规则影响新运行。 */
  resolveLegacyTaskStatus?(projectId: string, statusId: string, runId: string): string;
  /** 完成状态只能由已收口的终点分工推进。 */
  isCompletedTaskStatus?(projectId: string, statusId: string): boolean;
  /** 统一推进真实状态并携带流程来源，避免自身再次触发。 */
  advanceTaskStatus?(taskId: string, statusId: string, source: { runId: string; nodeId: string; phase: 'started' | 'completed' }): void;
  /** 父流程复验通过后关闭已验收的 defect 子任务。 */
  finishAcceptedDefect?(taskId: string, runId: string): void;
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
  /** 复用项目自定义的任务完成与取消状态。 */
  isTaskTerminal(task: ZeusTaskRecord): boolean;
  /** 项目仓库登记。 */
  projectRepositories: Pick<ProjectRepositoryRegistrationRepository, 'listByProject'>;
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
  /** 当前协调循环，避免重入。 */
  private active: Promise<void> | null = null;

  /** 进程内正在执行外部效果的尝试；重启后不会被误认为可重放。 */
  private readonly activeExternalAttemptIds = new Set<string>();

  /** 关闭后不再派发。 */
  private closed = false;

  /** 保存依赖，由工作管理共用的调度循环驱动恢复。 */
  constructor(private readonly options: DigitalTeamWorkflowCoordinatorOptions) {}

  /** 团队定义统一管理，不按运行项目保存副本。 */
  listTemplates(): unknown {
    return this.options.templates.listGlobal();
  }

  /** 人工接受风险只放行任务关单门禁，不改写真实测试结论。 */
  acceptDefectRisk(runId: string, input: { defectId: string; reason: string; expectedRevision: number }, context: DigitalTeamCommandContext): unknown {
    requireHumanActor(context);
    const run = this.requireRun(runId, input.expectedRevision);
    if (!this.options.defects.listByRun(run.id).some((defect) => defect.id === input.defectId)) throw routeError('ZEUS_DIGITAL_TEAM_DEFECT_NOT_FOUND', '正式缺陷不属于当前父流程。', 404);
    this.options.defects.acceptRisk(input.defectId, requiredText(input.reason, '接受风险需要明确理由。', 2_000), context.actor.id!);
    if (!['completed', 'cancelled'].includes(run.status))
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_RISK_ACCEPTED', message: '人工已接受正式缺陷风险；真实测试结论保留，自动派发已暂停。' } });
    return this.getRunProjection(run.id);
  }

  /** 全部任务指派先经过同一只读入口解析，配置错误不会静默降级。 */
  async prepareEmployeeAssignment(projectId: string, input: DigitalTeamEmployeeAssignmentInput): Promise<PreparedDigitalTeamRun | null> {
    this.requireProject(projectId);
    const task = this.options.tasks.getById(input.taskId);
    if (!task || task.projectId !== projectId || this.options.isTaskTerminal(task)) throw routeError('ZEUS_DIGITAL_TEAM_TASK_NOT_AVAILABLE', '任务不存在、已结束或不属于当前项目。');
    if (input.expectedTaskUpdatedAt && task.updatedAt !== input.expectedTaskUpdatedAt) throw routeError('ZEUS_DIGITAL_TEAM_TASK_CONFLICT', '任务已变化，请重新读取后指派。');
    /** 在途工作先读取冻结安排，当前模板编辑只能影响新接纳。 */
    const existing = this.options.runs.listByTask(task.id).find((run) => !['completed', 'failed', 'cancelled'].includes(run.status));
    /** 人工改派采用原冻结配置，不把新模板强塞进在途流程。 */
    if (existing) {
      const frozenEntry = resolveDigitalTeamAssignmentEntry(existing.definitionSnapshot, this.options.runs.resolveEmployeeId(projectId, input.employeeId));
      /** 当前请求只能进一步收紧原运行权限，不能通过改派扩大冻结上限。 */
      const permissionMode = restrictPermission(existing.runtimeState.permissionMode, input.permissionMode);
      const execution = digitalTeamExecutionDefinition({ ...existing, runtimeState: { ...existing.runtimeState, entryNodeId: frozenEntry.id } });
      this.requireRunStatuses(existing, execution);
      if (permissionMode === 'read-only' && execution.nodes.some((node) => node.type === 'employee' && node.data.executionMode === 'isolated_write'))
        throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_REQUIRED', '本次只读权限不允许执行冻结流程中的代码分工。');
      /** 交接默认绑定当前流程已经正式核验的成果，未完成工作不冒充有效输入。 */
      const inputs = input.inputDeliverableIds ?? [
        ...new Set([
          ...(existing.runtimeState.inputDeliverableIds ?? []),
          ...this.currentAttempts(existing)
            .filter((attempt) => attempt.status === 'succeeded' && attempt.deliverableId)
            .map((attempt) => attempt.deliverableId!),
        ]),
      ];
      if (existing.runtimeState.entryNodeId !== frozenEntry.id && existing.definitionSnapshot.edges.some((edge) => edge.target === frozenEntry.id) && !inputs.length)
        throw routeError('ZEUS_DIGITAL_TEAM_ENTRY_INPUT_REQUIRED', '旧工作尚未形成正式成果，不能从中间员工开始新安排。');
      /** 选择已有准确候选作为新入口现场，避免丢掉已经完成的上游代码。 */
      const entryCodeRevisions = existing.candidateRevisions.length
        ? existing.candidateRevisions.map((candidate) => ({ repositoryId: candidate.repositoryId, sourceRef: 'HEAD', baseSha: candidate.headSha }))
        : existing.runtimeState.entryCodeRevisions;
      for (const candidate of existing.candidateRevisions) {
        const workspace = this.options.workspaces.getById(candidate.workspaceRef);
        const review = workspace?.worktreePath ? await getTaskWorkspaceReview(workspace.worktreePath) : null;
        if (!review?.clean || review.headSha !== candidate.headSha) throw routeError('ZEUS_DIGITAL_TEAM_ENTRY_CODE_STALE', '当前任务候选现场已变化，不能交接为新的入口代码。');
      }
      return {
        templateId: existing.templateId ?? '',
        templateRevision: existing.templateRevision ?? 0,
        definition: existing.definitionSnapshot,
        baseRevisions: existing.baseRevisions,
        repositories: [],
        existingRunId: existing.id,
        expectedTaskUpdatedAt: task.updatedAt,
        runtimeState: {
          ...existing.runtimeState,
          entryNodeId: frozenEntry.id,
          inputDeliverableIds: inputs,
          entryCodeRevisions,
          permissionMode,
        },
      };
    }
    /** 没有在途团队时直接指派员工；新团队必须由任务明确选择。 */
    return null;
  }

  /** 重复接纳关联原运行，人工改派先耐久登记交接并停止旧执行。 */
  acceptEmployeeAssignment(projectId: string, input: DigitalTeamEmployeeAssignmentInput, context: DigitalTeamCommandContext, prepared: PreparedDigitalTeamRun): unknown {
    const preparedTask = this.options.tasks.getById(input.taskId);
    if (!preparedTask || preparedTask.projectId !== projectId || (prepared.expectedTaskUpdatedAt && preparedTask.updatedAt !== prepared.expectedTaskUpdatedAt))
      throw routeError('ZEUS_DIGITAL_TEAM_TASK_CONFLICT', '任务在流程预检之后变化，请重新读取后指派。');
    if (prepared.existingRunId) {
      const run = this.requireRun(prepared.existingRunId);
      const entryNodeId = prepared.runtimeState?.entryNodeId;
      if (!entryNodeId || run.runtimeState.entryNodeId === entryNodeId || run.runtimeState.handoff?.entryNodeId === entryNodeId) return this.getRunProjection(run.id);
      requireHumanActor(context);
      const reason = requiredText(input.reason ?? '人工重新指派任务', '改派原因不能为空。', 2_000);
      this.options.runs.update(run.id, {
        expectedRevision: run.revision,
        controlState: 'paused',
        runtimeState: {
          ...run.runtimeState,
          inputDeliverableIds: prepared.runtimeState?.inputDeliverableIds,
          entryCodeRevisions: prepared.runtimeState?.entryCodeRevisions,
          permissionMode: prepared.runtimeState?.permissionMode,
          handoff: { employeeId: input.employeeId, entryNodeId, operationIdentity: context.operationIdentity, reason, requestedAt: this.options.now().toISOString(), status: 'stopping' },
        },
      });
      return this.getRunProjection(run.id);
    }
    const task = this.options.tasks.getById(input.taskId);
    if (!task || task.projectId !== projectId) throw routeError('ZEUS_DIGITAL_TEAM_TASK_NOT_FOUND', '任务不属于当前项目。', 404);
    return this.createRun(
      projectId,
      {
        taskId: task.id,
        expectedTaskUpdatedAt: task.updatedAt,
        templateId: prepared.templateId,
        templateRevision: prepared.templateRevision,
        title: task.title,
        description: task.description,
        taskFacts: structuredClone(task) as unknown as Record<string, unknown>,
        entryNodeId: prepared.runtimeState?.entryNodeId ?? undefined,
        inputDeliverableIds: prepared.runtimeState?.inputDeliverableIds,
      },
      context,
      prepared,
    );
  }

  /** 新建或按修订更新模板。 */
  saveTemplate(input: DigitalTeamTemplateSaveInput, operationIdentity: string): unknown {
    const id = typeof input.id === 'string' && input.id.trim() ? input.id.trim() : stableIdentity('digital_team_template', operationIdentity);
    const existing = this.options.templates.getById(id);
    if (existing && input.expectedRevision !== existing.revision) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '模板作用域或修订已变化，请重新读取。');
    if (!existing && (typeof input.name !== 'string' || typeof input.description !== 'string' || !isRecord(input.definition))) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_INVALID', '模板名称、说明和画布定义不能为空。', 400);
    /** 团队保存使用全局任务状态目录，不在配置阶段建立项目员工实例。 */
    if (isRecord(input.definition) || existing) this.requireProjectStatuses('', normalizeDigitalTeamWorkflowDefinition(isRecord(input.definition) ? (input.definition as unknown as DigitalTeamWorkflowDefinition) : existing!.definition));
    if (existing) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision! < 1) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '模板作用域不匹配或缺少有效修订。');
      return this.options.templates.update(id, {
        expectedRevision: input.expectedRevision!,
        ...(typeof input.name === 'string' ? { name: input.name } : {}),
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(isRecord(input.definition) ? { definition: input.definition as never } : {}),
      });
    }
    if (typeof input.name !== 'string' || typeof input.description !== 'string' || !isRecord(input.definition)) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_INVALID', '模板名称、说明和画布定义不能为空.', 400);
    return this.options.templates.create({ id, name: input.name, description: input.description, definition: input.definition as never });
  }

  /** 状态属于实时项目事实，配置保存和危险状态推进前都要核对。 */
  private requireProjectStatuses(projectId: string, definition: DigitalTeamWorkflowDefinition): void {
    const issue = validateDigitalTeamProjectWorkflowStatuses(definition, {
      hasStatus: (statusId) => this.options.validateTaskStatus?.(projectId, statusId) ?? true,
      isCompletedStatus: (statusId) => this.options.isCompletedTaskStatus?.(projectId, statusId) ?? statusId === 'completed',
    })[0];
    if (issue) throw routeError(issue.code, issue.message, 400);
  }

  /** 历史运行使用精确归档映射读取当前状态身份，冻结定义始终保持原文。 */
  private resolveRunTaskStatus(run: DigitalTeamWorkflowRunRecord, statusId: string): string {
    return this.options.resolveLegacyTaskStatus?.(run.projectId, statusId, run.id) ?? statusId;
  }

  /** 历史状态只在核验副本上投影，不写回已冻结节点或任务事实。 */
  private requireRunStatuses(run: DigitalTeamWorkflowRunRecord, source = digitalTeamExecutionDefinition(run)): void {
    /** 当前结构可能直接引用原快照，必须复制后才能替换展示身份。 */
    const definition = structuredClone(source);
    for (const node of definition.nodes) {
      if (node.type !== 'employee') continue;
      for (const key of ['triggerStatusId', 'startStatusId', 'completionStatusId'] as const) if (node.data[key]) node.data[key] = this.resolveRunTaskStatus(run, node.data[key]!);
    }
    this.requireProjectStatuses(run.projectId, definition);
  }

  /** 状态配置被删除或改成非法完成映射时先暂停，旧冻结定义保持供人工修正。 */
  private projectStatusesRemainValid(run: DigitalTeamWorkflowRunRecord): boolean {
    try {
      this.requireRunStatuses(run);
      return true;
    } catch (error) {
      const latest = this.options.runs.getById(run.id)!;
      this.options.runs.update(latest.id, { expectedRevision: latest.revision, controlState: 'paused', error: serializeError(error) });
      return false;
    }
  }

  /** 删除统一团队模板，历史运行继续读取自己的快照。 */
  deleteTemplate(templateId: string, expectedRevision: number): unknown {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw routeError('ZEUS_DIGITAL_TEAM_REVISION_INVALID', '模板修订无效。', 400);
    const template = this.options.templates.getById(templateId);
    if (!template) throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_NOT_FOUND', '数字团队流程模板不存在。', 404);
    return this.options.templates.delete(template.id, expectedRevision);
  }

  /** 按真实项目、任务与可选会话关联读取运行，不把旧流程挂到新的独立员工会话。 */
  listRuns(projectId: string, taskId?: string, conversationId?: string): unknown {
    this.requireProject(projectId);
    if (conversationId !== undefined && taskId === undefined) throw routeError('ZEUS_DIGITAL_TEAM_TASK_REQUIRED', '会话团队进展必须指定所属任务。', 400);
    if (taskId === undefined) return this.options.runs.listByProject(projectId);
    /** 当前任务单独读取全部运行，避免被项目最近一百条记录挤出入口。 */
    const task = this.options.tasks.getById(requiredText(taskId, '任务身份无效。', 512));
    if (!task || task.projectId !== projectId) throw routeError('ZEUS_DIGITAL_TEAM_TASK_NOT_FOUND', '任务不存在或不属于当前项目。', 404);
    return this.options.runs.listByTask(task.id, conversationId);
  }

  /** 返回运行、完整历史和每节点当前尝试。 */
  getRunProjection(runId: string): unknown {
    const run = this.options.runs.getById(runId);
    if (!run) return null;
    const nodeAttempts = this.options.attempts.listByRun(run.id);
    const currentAttempts = digitalTeamExecutionDefinition(run).nodes.flatMap((node) => {
      const attempt = this.options.attempts.getCurrentByNode(run.id, node.id);
      return attempt ? [attempt] : [];
    });
    return { run, nodeAttempts, currentAttempts, defects: this.options.defects?.listByRun(run.id) ?? [] };
  }

  /** 把有界命令回执解析为模板或运行的当前公开投影。 */
  resolveMutationResult(result: unknown): unknown {
    if (!isRecord(result)) throw routeError('ZEUS_DIGITAL_TEAM_MUTATION_RESULT_INVALID', '数字团队命令回执缺少资源身份。', 500);
    if (result.resourceKind === 'run' && typeof result.runId === 'string') return this.getRunProjection(result.runId);
    if (result.resourceKind === 'template' && typeof result.templateId === 'string') {
      return this.options.templates.getById(result.templateId) ?? result;
    }
    throw routeError('ZEUS_DIGITAL_TEAM_MUTATION_RESULT_INVALID', '数字团队命令回执资源身份无效。', 500);
  }

  /** 在 Core 状态和持久文件都成功后发布准确资源变化。 */
  publishMutation(result: unknown): void {
    if (!isRecord(result)) return;
    if (result.resourceKind === 'run' && typeof result.runId === 'string') this.publishRunChanged(result.runId);
    else if (result.resourceKind === 'template' && typeof result.templateId === 'string') {
      this.options.publish('digital_team.template.changed', { templateId: result.templateId, projectId: result.projectId ?? null, revision: result.revision });
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
    if (!template || (template.projectId !== null && template.projectId !== project.id) || template.revision !== input.templateRevision || !template.ready) {
      throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '流程模板不存在、尚未通过校验或已被修改。');
    }
    /** 节点员工由模板唯一确定；存储边界会在创建运行时解析项目中的可执行实例。 */
    const definition = template.definition;
    this.requireProjectStatuses(projectId, definition);
    /** 只计算本次入口后的实际动作权限，不把未执行上游的能力带入。 */
    const execution = digitalTeamExecutionDefinition({ definitionSnapshot: definition, plan: null, runtimeState: { entryNodeId: input.entryNodeId } });
    if (!requiredText(input.title, '任务名称不能为空。', 240) || typeof input.description !== 'string' || !isRecord(input.taskFacts)) {
      throw routeError('ZEUS_DIGITAL_TEAM_RUN_INVALID', '任务名称、说明和任务事实无效。', 400);
    }
    const existingTask = this.requireExistingTask(projectId, input);
    /** 预检只核对本次明确授权；任务权限仅在随后 Core 事务内更新。 */
    this.requireRunCodeAuthority(input, definition, existingTask);
    /** 只有实际使用代码现场的步骤才冻结 Git 基线，普通协作不依赖仓库。 */
    const needsRepository = execution.nodes.some((node) => node.type === 'employee' && node.data.executionMode !== 'read_only');
    const repositories = needsRepository ? this.options.projectRepositories.listByProject(project.id) : [];
    if (!needsRepository) return { templateId: template.id, templateRevision: template.revision, definition, baseRevisions: [], repositories };
    if (repositories.length === 0) throw routeError('ZEUS_DIGITAL_TEAM_REPOSITORY_REQUIRED', '项目尚未登记可冻结的 Git 仓库。');
    if (repositories.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '代码集成目前需要选择单一仓库；普通协作不受仓库数量限制。');
    const baseRevisions = await Promise.all(
      repositories.map(async (repository) => {
        const [context, clean] = await Promise.all([getGitRepositoryContext(repository.localPath), getGitWorktreeClean(repository.localPath)]);
        if (!context.isRepository || !context.headSha) throw routeError('ZEUS_DIGITAL_TEAM_REPOSITORY_REQUIRED', `仓库 ${repository.name} 不是可用 Git 仓库。`);
        if (!clean && input.taskFacts.confirmCommittedBaseline !== true) {
          throw routeError('ZEUS_DIGITAL_TEAM_DIRTY_BASELINE_CONFIRMATION_REQUIRED', `仓库 ${repository.name} 有未提交改动；这些改动不会进入冻结基线，请先处理或明确确认只使用已提交版本。`);
        }
        /** 已选择成果的代码身份优先于项目当前 HEAD，保证中间入口不切换被测版本。 */
        const inputResults =
          existingTask && input.inputDeliverableIds?.length
            ? this.options.runs
                .listByTask(existingTask.id)
                .flatMap((run) => this.options.attempts.listByRun(run.id))
                .filter((attempt) => attempt.deliverableId && input.inputDeliverableIds!.includes(attempt.deliverableId) && attempt.status === 'succeeded')
                .flatMap((attempt) => [...(attempt.result?.repositoryResults ?? []), ...(attempt.result?.verifiedCandidates ?? []).map((candidate) => ({ ...candidate, baseSha: candidate.headSha }))])
                .filter((result) => result.repositoryId === repository.id)
            : [];
        const heads = [...new Set(inputResults.map((result) => result.headSha))];
        if (heads.length > 1) throw routeError('ZEUS_DIGITAL_TEAM_ENTRY_CODE_AMBIGUOUS', '入口成果绑定了不同代码版本，请选择准确的被测成果。');
        if (
          input.entryNodeId &&
          definition.edges.some((edge) => edge.target === input.entryNodeId) &&
          definition.nodes.some((node) => node.id === input.entryNodeId && node.type === 'employee' && node.data.executionMode === 'candidate_read_only') &&
          !heads.length
        )
          throw routeError('ZEUS_DIGITAL_TEAM_ENTRY_CODE_REQUIRED', '测试入口缺少正式上游成果中的准确代码身份。');
        return { repositoryId: repository.id, sourceRef: context.detached || !context.branch ? 'HEAD' : context.branch, baseSha: heads[0] ?? context.headSha };
      }),
    );
    return { templateId: template.id, templateRevision: template.revision, definition, baseRevisions, repositories };
  }

  /** 在统一 Core 事务中创建任务并冻结运行；当前员工根节点由依赖调度直接启动。 */
  createRun(projectId: string, input: DigitalTeamRunCreateInput, context: DigitalTeamCommandContext, preparedValue: unknown): unknown {
    const prepared = preparedValue as PreparedDigitalTeamRun;
    const template = this.options.templates.getById(prepared.templateId);
    if (!template || (template.projectId !== null && template.projectId !== projectId) || template.revision !== prepared.templateRevision || template.revision !== input.templateRevision) {
      throw routeError('ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '流程模板在预检后发生变化。');
    }
    this.requireProjectStatuses(projectId, prepared.definition);
    const runId = stableIdentity('digital_team_run', context.operationIdentity);
    /** 事务内重新核对任务修订及运行占用，关闭异步预检后的竞态窗口。 */
    let existingTask = this.requireExistingTask(projectId, input);
    /** 重新核对实际入口和权限，预检不能绕过本次只读约束或授予旧任务新能力。 */
    const grantTaskCodeAuthority = this.requireRunCodeAuthority({ ...input, permissionMode: prepared.runtimeState?.permissionMode ?? input.permissionMode }, prepared.definition, existingTask);
    if (grantTaskCodeAuthority) {
      /** 只有本次明确用户动作可授予新权限，系统和员工不能借流程名称扩大任务能力。 */
      if (!['user', 'local_api', 'remote_control'].includes(context.actor.kind)) throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_ACTOR_INVALID', '任务代码授权必须由真实用户入口发起。', 400);
      if (existingTask && (!existingTask.allowCodeChanges || !existingTask.allowTests || !existingTask.allowGitCommit)) {
        if (!this.options.taskCreation.grantCodeAuthority) throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_UNAVAILABLE', '任务代码授权入口尚未就绪。', 500);
        existingTask = this.options.taskCreation.grantCodeAuthority(existingTask.id, existingTask.updatedAt, context);
      }
    }
    /** 已有任务不复制或改写身份。 */
    const taskId = existingTask?.id ?? stableIdentity('task', `${context.operationIdentity}\0digital-team`);
    /** 任务事实必须来自服务端现存记录，客户端只能确认基线。 */
    const taskFacts = existingTask ? { ...structuredClone(existingTask), confirmCommittedBaseline: input.taskFacts.confirmCommittedBaseline === true } : structuredClone(input.taskFacts);
    if (grantTaskCodeAuthority && !existingTask) {
      /** 新任务同样只从用户明确开始研发取得这三项能力，不从岗位或流程名称推断。 */
      taskFacts.allowCodeChanges = true;
      taskFacts.allowTests = true;
      taskFacts.allowGitCommit = true;
    }
    /** 自动缺陷登记继续引用原接纳命令，不伪造新的用户批准。 */
    taskFacts.digitalTeamSourceCommandId = context.commandId;
    if (!existingTask)
      this.options.taskCreation.create(
        {
          projectId,
          title: requiredText(input.title, '任务名称不能为空。', 240),
          taskType: 'requirement',
          description: input.description,
          sourceContext: { type: 'digital_team_workflow', digitalTeamRunId: runId, taskFacts },
          allowCodeChanges: taskFactBoolean(taskFacts, 'allowCodeChanges', false),
          allowTests: taskFactBoolean(taskFacts, 'allowTests', true),
          allowGitCommit: taskFactBoolean(taskFacts, 'allowGitCommit', false),
        },
        taskId,
        { ...context, taskOrigin: 'digital_team_workflow' },
      );
    const run = this.options.runs.create({
      id: runId,
      projectId,
      taskId,
      templateId: template.id,
      templateRevision: template.revision,
      definition: structuredClone(prepared.definition),
      taskFacts,
      baseRevisions: prepared.baseRevisions,
      runtimeState: prepared.runtimeState ?? {
        entryNodeId: input.entryNodeId ?? null,
        inputDeliverableIds: input.inputDeliverableIds ?? [],
        repairRound: this.options.defects?.getRepairRounds(taskId) ?? 0,
        permissionMode: input.permissionMode,
      },
    });
    if (run.definitionSnapshot.schemaGeneration !== digitalTeamWorkflowSchemaGeneration) {
      const startNode = digitalTeamExecutionDefinition(run).nodes.find((node) => node.type === 'start')!;
      const start = this.options.attempts.create({ id: stableAttemptId(run.id, startNode.id, 1), runId: run.id, nodeId: startNode.id, inputSha256: inputDigest(run, startNode, []) });
      const activeStart = this.options.attempts.update(start.id, { expectedRevision: start.revision, status: 'active', commandId: context.commandId, startedAt: this.options.now().toISOString() });
      this.options.attempts.update(activeStart.id, { expectedRevision: activeStart.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
    }
    return this.getRunProjection(run.id);
  }

  /** 新授权只来自类型明确的用户选择；本次只读权限和真实执行范围仍是上限。 */
  private requireRunCodeAuthority(input: DigitalTeamRunCreateInput, definition: DigitalTeamWorkflowDefinition, existingTask: ZeusTaskRecord | null): boolean {
    if (input.grantTaskCodeAuthority !== undefined && typeof input.grantTaskCodeAuthority !== 'boolean') throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_INVALID', '任务代码授权必须是明确的布尔选择。', 400);
    /** 入口前未执行的代码步骤不进入本次授权范围。 */
    const execution = digitalTeamExecutionDefinition({ definitionSnapshot: definition, plan: null, runtimeState: { entryNodeId: input.entryNodeId } });
    /** 实际写入能力只取冻结节点模式，不从名称或职责推断。 */
    const writesCode = execution.nodes.some((node) => node.type === 'employee' && node.data.executionMode === 'isolated_write');
    /** 顶层字段是为旧任务新增能力的唯一入口，普通事实字段不能代替用户选择。 */
    const grantTaskCodeAuthority = input.grantTaskCodeAuthority === true;
    if (input.permissionMode === 'read-only' && (writesCode || grantTaskCodeAuthority)) throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_REQUIRED', '本次只读权限不允许执行代码分工或授予代码写入权限。');
    if (grantTaskCodeAuthority && !writesCode) throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_SCOPE_INVALID', '本流程没有修改代码的分工，不需要代码授权。', 400);
    if (writesCode && !grantTaskCodeAuthority && (input.taskFacts.allowCodeChanges !== true || input.taskFacts.allowGitCommit !== true || (existingTask && (!existingTask.allowCodeChanges || !existingTask.allowGitCommit))))
      throw routeError('ZEUS_DIGITAL_TEAM_CODE_AUTHORITY_REQUIRED', '本次代码工作需要明确允许开发、检查并本地提交。');
    return grantTaskCodeAuthority;
  }

  /** 任务入口与新建入口共用创建链路；现有任务必须仍可执行且没有活动运行。 */
  private requireExistingTask(projectId: string, input: DigitalTeamRunCreateInput): ZeusTaskRecord | null {
    if (input.taskId === undefined) return null;
    /** 按真实身份读取，禁止跨项目绑定。 */
    const task = this.options.tasks.getById(requiredText(input.taskId, '任务身份无效。', 512));
    if (!task || task.projectId !== projectId) throw routeError('ZEUS_DIGITAL_TEAM_TASK_NOT_FOUND', '任务不存在或不属于当前项目。', 404);
    if (!input.expectedTaskUpdatedAt || task.updatedAt !== input.expectedTaskUpdatedAt) throw routeError('ZEUS_DIGITAL_TEAM_TASK_CONFLICT', '任务内容已变化，请返回任务详情刷新后重试。');
    if (this.options.isTaskTerminal(task) || task.status === 'completed' || task.status === 'cancelled') throw routeError('ZEUS_DIGITAL_TEAM_TASK_TERMINAL', '请先重新打开任务，再使用数字团队流程。');
    if (this.options.runs.listByTask(task.id).some((run) => !['completed', 'failed', 'cancelled'].includes(run.status))) throw routeError('ZEUS_DIGITAL_TEAM_TASK_RUNNING', '当前任务已有未结束的团队运行，请先查看现有运行。');
    return task;
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
    const boundSha256 = node.data.purpose === 'plan_approval' ? run.planSha256 : attempt.inputSha256;
    if (!boundSha256) throw routeError('ZEUS_DIGITAL_TEAM_APPROVAL_STALE', '待批准的规划或候选不存在。');
    this.assertApprovalUpstreamTerminal(run, node);
    /** 只有代码集成的下游确认需要复核候选；先核对再写入批准事实。 */
    const integration = digitalTeamExecutionDefinition(run).nodes.find((candidate) => candidate.type === 'code_integration');
    const checksCandidate = node.data.purpose === 'final_acceptance' && integration && descendantIds(run, integration.id).has(node.id) && run.candidateRevisions.length > 0;
    if (input.approved && checksCandidate && (!isRecord(preparedValue) || preparedValue.candidateSetSha256 !== run.candidateSetSha256)) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '验收前未完成准确候选复核。');
    if (!input.approved) {
      const affected = new Set(directPredecessorIds(run, node.id).flatMap((nodeId) => [...descendantIds(run, nodeId)]));
      if (this.currentAttempts(run).some((current) => affected.has(current.nodeId) && (inFlightAttemptStatuses.has(current.status) || current.status === 'outcome_unknown')))
        throw routeError('ZEUS_DIGITAL_TEAM_REWORK_IN_FLIGHT', '相关分支仍在执行或结果待核对，请先暂停并核对，再退回成果。');
    }
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
    if (input.approved) {
      if (node.data.purpose === 'plan_approval') this.options.runs.approvePlan(run.id, { expectedRevision: run.revision, planSha256: boundSha256, actorId: context.actor.id ?? context.actor.kind });
    } else {
      /** 退回实际上游工作，保留不相干的并行分支，不把所有意见强塞给汇总人员。 */
      const upstream = directPredecessorIds(run, node.id).filter((id) => requireNode(run, id).type !== 'start');
      for (const nodeId of upstream) this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId, reason: input.reason || '用户要求修改上游成果。', invalidatedByAttemptId: decided.id });
      if (!upstream.length) this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: node.id, reason: input.reason || '用户要求重新确认。', invalidatedByAttemptId: decided.id });
      const latestRun = this.options.runs.getById(run.id)!;
      this.options.runs.update(run.id, {
        expectedRevision: latestRun.revision,
        status: 'executing',
        ...(upstream.some((nodeId) => [...descendantIds(run, nodeId)].some((id) => requireNode(run, id).type === 'code_integration')) ? { candidateRevisions: [] } : {}),
        error: null,
      });
    }
    return this.getRunProjection(run.id);
  }

  /** 最终批准前复核全部候选工作区仍干净且 HEAD 与运行绑定一致。 */
  async prepareApproval(runId: string, input: DigitalTeamApprovalInput): Promise<unknown> {
    const run = this.requireRun(runId, input.expectedRevision);
    const node = requireNode(run, input.nodeId);
    if (!input.approved || node.type !== 'human_confirmation' || node.data.purpose !== 'final_acceptance') return null;
    /** 独立报告分支的人工确认不受其他分支代码候选影响。 */
    const integration = digitalTeamExecutionDefinition(run).nodes.find((candidate) => candidate.type === 'code_integration');
    if (!integration || !descendantIds(run, integration.id).has(node.id) || !run.candidateRevisions.length) return { candidateSetSha256: null };
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
    /** 用户明确继续已确定取消的测试时，旧轮完整留证，沿同一候选接纳新的验收轮。 */
    const cancelledVerification =
      input.state === 'running' && run.runtimeState.verificationRound?.phase === 'collecting' && run.runtimeState.verificationRound.tests.some((test) => this.options.attempts.getById(test.attemptId)?.status === 'cancelled');
    if (cancelledVerification && this.currentAttempts(run).some((attempt) => inFlightAttemptStatuses.has(attempt.status))) throw routeError('ZEUS_DIGITAL_TEAM_STOPPING', '本轮测试仍在停止核对，请等待全部在途工作终结后继续。');
    if (cancelledVerification)
      for (const test of run.runtimeState.verificationRound!.tests) this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: test.nodeId, reason: '用户继续已确定取消的验收，原轮结果保留，沿原候选重新测试。' });
    for (const childId of this.associatedRepairRunIds(run)) {
      const child = this.options.runs.getById(childId);
      if (input.state === 'running' && child && (child.status === 'outcome_unknown' || this.currentAttempts(child).some((attempt) => attempt.status === 'outcome_unknown')))
        throw routeError('ZEUS_DIGITAL_TEAM_UNKNOWN_OUTCOME', '修复子流程仍有停止结果未知的外部操作，核对前不能继续。');
      if (child && !['completed', 'failed', 'cancelled'].includes(child.status)) this.options.runs.update(child.id, { expectedRevision: child.revision, controlState: input.state });
    }
    /** 暂停或继续只更新控制提示，保留仍需返工或人工核对的真实失败原因。 */
    const controlError = input.state === 'paused' ? (run.error ?? { code: 'ZEUS_DIGITAL_TEAM_STOPPING', message: '已停止新派发，正在核对在途工作。' }) : run.error?.code === 'ZEUS_DIGITAL_TEAM_STOPPING' ? null : run.error;
    this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: input.state, error: controlError, ...(cancelledVerification ? { runtimeState: { ...run.runtimeState, verificationRound: null } } : {}) });
    return this.getRunProjection(run.id);
  }

  /** 返工只失效目标和后继，活动现场必须先暂停核对。 */
  requestRework(runId: string, input: DigitalTeamReworkInput, context: DigitalTeamCommandContext): unknown {
    requireHumanActor(context);
    const run = this.requireRun(runId, input.expectedRevision);
    /** 已完成或已取消的流程不能通过返工先失效历史再碰到终态限制。 */
    if (['completed', 'cancelled'].includes(run.status)) throw routeError('ZEUS_DIGITAL_TEAM_RUN_STATE_INVALID', '已经结束的流程运行不能再返工。');
    /** 旧失败流程释放任务后，新运行拥有独占权，不能再同时复活旧流程。 */
    if (run.status === 'failed' && this.options.runs.listByTask(run.taskId).some((candidate) => candidate.id !== run.id && !['completed', 'failed', 'cancelled'].includes(candidate.status)))
      throw routeError('ZEUS_DIGITAL_TEAM_TASK_RUNNING', '当前任务已有新的团队运行，请先查看现有运行。');
    /** 失败流程只有无在途与未知尝试才能恢复，拒绝时不能先失效其他节点。 */
    if (run.status === 'failed' && this.currentAttempts(run).some((attempt) => ['prepared', 'dispatching', 'active', 'outcome_unknown'].includes(attempt.status)))
      throw routeError('ZEUS_DIGITAL_TEAM_REWORK_IN_FLIGHT', '失败流程仍有在途或未知结果，不能恢复执行。');
    const reason = requiredText(input.reason, '返工原因不能为空。', 2_000);
    const node = requireNode(run, input.nodeId);
    if (node.type === 'start' || node.type === 'end' || node.type === 'human_confirmation') throw routeError('ZEUS_DIGITAL_TEAM_REWORK_INVALID', '请选择需要重新执行的员工或集成节点。', 400);
    const affected = descendantIds(run, node.id);
    const current = this.options.attempts.listByRun(run.id).filter((attempt) => affected.has(attempt.nodeId) && this.options.attempts.getCurrentByNode(run.id, attempt.nodeId)?.id === attempt.id);
    if (current.some((attempt) => inFlightAttemptStatuses.has(attempt.status))) throw routeError('ZEUS_DIGITAL_TEAM_REWORK_IN_FLIGHT', '受影响节点仍在执行，请先暂停并完成在途核对。');
    /** 父验收返工不能绕过本轮修复的停止核对，避免旧修复继续写入新候选。 */
    if (
      run.runtimeState.verificationRound?.tests.some((test) => affected.has(test.nodeId)) &&
      this.associatedRepairRunIds(run).some((id) => {
        const child = this.options.runs.getById(id);
        return child && (child.status === 'outcome_unknown' || this.currentAttempts(child).some((attempt) => inFlightAttemptStatuses.has(attempt.status) || attempt.status === 'outcome_unknown'));
      })
    )
      throw routeError('ZEUS_DIGITAL_TEAM_REWORK_IN_FLIGHT', '本轮修复仍在执行或停止结果未知，请先暂停并核对。');
    /** 显式返工等同于用户确认这些未知结果不得采用；保留历史后再失效，不推断成功。 */
    for (const attempt of current.filter((candidate) => candidate.status === 'outcome_unknown')) {
      this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'failed', error: { code: 'ZEUS_DIGITAL_TEAM_UNKNOWN_DISCARDED_FOR_REWORK', message: reason }, completedAt: this.options.now().toISOString() });
    }
    const unrelatedUnknown = this.currentAttempts(run).some((attempt) => attempt.status === 'outcome_unknown' && !affected.has(attempt.nodeId));
    if (unrelatedUnknown) throw routeError('ZEUS_DIGITAL_TEAM_UNKNOWN_OUTCOME', '未受本次返工影响的并行节点仍有未知结果，请先明确处置对应节点。');
    this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: node.id, reason, invalidatedByAttemptId: this.options.attempts.getCurrentByNode(run.id, node.id)?.id });
    const targetStage = reworkRunStatus(node);
    const clearsCandidate =
      run.definitionSnapshot.schemaGeneration === digitalTeamWorkflowSchemaGeneration
        ? [...affected].some((nodeId) => digitalTeamExecutionDefinition(run).nodes.some((candidate) => candidate.id === nodeId && candidate.type === 'employee' && candidate.data.executionMode === 'isolated_write'))
        : affected.has(digitalTeamExecutionDefinition(run).nodes.find((candidate) => candidate.type === 'code_integration')?.id ?? '');
    /** 同一候选的缺项返工只替换对应测试尝试，其他并行测试的真实结果继续属于本轮。 */
    const round = run.runtimeState.verificationRound;
    const replacementTests =
      round?.phase === 'collecting' && !clearsCandidate && round.candidateSetSha256 === run.candidateSetSha256
        ? round.tests.map((test) => (affected.has(test.nodeId) ? { nodeId: test.nodeId, attemptId: stableAttemptId(run.id, test.nodeId, (this.options.attempts.getCurrentByNode(run.id, test.nodeId)?.attempt ?? 0) + 1) } : test))
        : null;
    /** 返工需要恢复的阶段、候选和控制字段在同一修订内落地。 */
    const reworkInput = {
      expectedRevision: run.revision,
      status: targetStage,
      completedAt: null,
      ...(clearsCandidate ? { candidateRevisions: [] } : {}),
      ...(round?.tests.some((test) => affected.has(test.nodeId))
        ? {
            runtimeState: {
              ...run.runtimeState,
              verificationRound: replacementTests ? { ...round, id: stableIdentity('digital_team_verification', `${run.id}\0${round.candidateSetSha256}\0${stableJson(replacementTests)}`), tests: replacementTests } : null,
              repairVerificationNodeId: null,
              repairRunIds: [],
            },
          }
        : {}),
      error: null,
    };
    if (run.status === 'failed') this.options.runs.reopenFailedRun(run.id, reworkInput);
    else this.options.runs.update(run.id, reworkInput);
    return this.getRunProjection(run.id);
  }

  /** 外部状态变化后立即调度。 */
  kick(): void {
    if (!this.closed) this.options.taskWork.kick();
  }

  /** 工作管理关闭前停止团队派发，并等待其当前扫描结束。 */
  async close(): Promise<void> {
    this.closed = true;
    if (this.active) await this.active;
  }

  /** 暴露给 Provider 的结构化工具只登记当前准确轮次的待验真 payload。 */
  readonly workTools: TaskWorkToolPort = {
    invoke: (call) => this.invokeWorkTool(call),
  };

  /** 串行扫描可恢复运行，单个运行失败不会阻断其他运行。 */
  async processRuns(): Promise<void> {
    if (this.closed || this.options.readOnlyValidation || this.active) return;
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
    });
    await this.active;
  }

  /** 先收口当前轮次，再按真实工作依赖创建本次尝试。 */
  private async processRun(runId: string): Promise<void> {
    let run = this.options.runs.getById(runId);
    if (!run || ['completed', 'failed', 'cancelled'].includes(run.status)) return;
    if (run.runtimeState.handoff?.status === 'stopping') {
      await this.processHandoff(run);
      return;
    }
    if (!this.projectStatusesRemainValid(run)) {
      await this.stopPausedRun(this.options.runs.getById(run.id)!);
      return;
    }
    /** 暂停后仍先接纳已经终结的准确轮次，再停止真正仍在途的工作。 */
    for (const attempt of this.currentAttempts(run)) await this.reconcileAttempt(run, attempt);
    run = this.options.runs.getById(run.id)!;
    if (run.controlState === 'paused') {
      await this.stopPausedRun(run);
      return;
    }
    if (run.controlState !== 'running' || ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)) return;
    if (run.runtimeState.repairVerificationNodeId && !run.runtimeState.verificationRound && !this.restoreLegacyVerificationRound(run)) return;
    run = this.options.runs.getById(run.id)!;
    if (run.runtimeState.verificationRound?.phase === 'collecting' && !(await this.settleVerificationRound(run))) return;
    run = this.options.runs.getById(run.id)!;
    if (run.runtimeState.verificationRound?.phase === 'repairing' && !(await this.processRepairResults(run))) return;
    run = this.options.runs.getById(run.id)!;
    /** 自动修复闭环先处理本轮缺陷，普通分工明确失败且没有在途工作才释放运行。 */
    if (this.settleDefiniteRunFailure(run)) return;
    const current = new Map(this.currentAttempts(run).map((attempt) => [attempt.nodeId, attempt]));
    for (const node of digitalTeamExecutionDefinition(run).nodes) {
      /** 派发会等待外部接纳，期间的暂停或未知结果必须阻止下一份工作。 */
      run = this.options.runs.getById(run.id)!;
      if (run.controlState !== 'running' || ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)) break;
      const prior = current.get(node.id);
      if (prior && !['invalidated', 'cancelled'].includes(prior.status)) continue;
      if (!allPredecessorsSucceeded(run, node.id, current)) continue;
      if (node.type === 'start') continue;
      /** 测试执行前形成准确候选，后续结果只能绑定这份提交。 */
      if (run.runtimeState.verificationRound?.phase === 'collecting' && !run.runtimeState.verificationRound.tests.some((test) => test.nodeId === node.id)) continue;
      if (node.type === 'employee' && node.data.executionMode === 'candidate_read_only') {
        if (!run.runtimeState.verificationRound) {
          if (!(await this.integrateCurrentCandidate(run, true))) return;
          run = this.options.runs.getById(run.id)!;
          const tests = digitalTeamExecutionDefinition(run)
            .nodes.filter((candidate): candidate is DigitalTeamEmployeeNode => candidate.type === 'employee' && candidate.data.executionMode === 'candidate_read_only')
            .filter((candidate) => (!current.get(candidate.id) || ['invalidated', 'cancelled'].includes(current.get(candidate.id)!.status)) && allPredecessorsSucceeded(run!, candidate.id, current))
            .map((candidate) => ({ nodeId: candidate.id, attemptId: stableAttemptId(run!.id, candidate.id, (current.get(candidate.id)?.attempt ?? 0) + 1) }));
          this.options.runs.update(run.id, {
            expectedRevision: run.revision,
            runtimeState: {
              ...run.runtimeState,
              verificationRound: {
                id: stableIdentity('digital_team_verification', `${run.id}\0${run.candidateSetSha256}\0${stableJson(tests)}`),
                candidateSetSha256: run.candidateSetSha256!,
                candidates: structuredClone(run.candidateRevisions),
                tests,
                phase: 'collecting',
                defectIds: [],
                repairRunIds: [],
              },
            },
          });
          await this.options.save();
          run = this.options.runs.getById(run.id)!;
        }
      }
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
        await this.dispatchEmployee(run, node, attempt);
      } else if (node.type === 'code_integration') await this.integrateCandidate(run, node, attempt);
      else if (node.type === 'end') {
        /** 结束等待全部直接依赖；审批只是依赖之一，不再直接完成整个运行。 */
        const active = this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'active', startedAt: this.options.now().toISOString() });
        this.options.attempts.update(active.id, { expectedRevision: active.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
        const latestRun = this.options.runs.getById(run.id)!;
        this.options.runs.update(run.id, { expectedRevision: latestRun.revision, status: 'completed', completedAt: this.options.now().toISOString(), error: null });
      }
    }
    if (this.options.runs.getById(run.id)?.runtimeState.verificationRound) return;
    /** 当前团队没有开始和结束节点；全部真实员工分工成功就是团队完成。 */
    let latestRun = this.options.runs.getById(run.id)!;
    if (latestRun.definitionSnapshot.schemaGeneration === digitalTeamWorkflowSchemaGeneration) {
      const nodes = digitalTeamExecutionDefinition(latestRun).nodes.filter((node): node is DigitalTeamEmployeeNode => node.type === 'employee');
      const attempts = new Map(this.currentAttempts(latestRun).map((attempt) => [attempt.nodeId, attempt]));
      if (nodes.length > 0 && nodes.every((node) => attempts.get(node.id)?.status === 'succeeded')) {
        if (!(await this.integrateCurrentCandidate(latestRun))) return;
        latestRun = this.options.runs.getById(latestRun.id)!;
        /** 有代码成果必须由真实测试节点核对最终候选，阻塞缺陷仍未接受不能完成。 */
        const verification = nodes.filter((node) => node.data.purpose === 'verify' && node.data.executionMode === 'candidate_read_only');
        const unresolvedDefects = (this.options.defects?.listByRun(latestRun.id) ?? []).filter((defect) => !['accepted', 'risk_accepted'].includes(defect.status));
        if (!latestRun.runtimeState.parentRepair && verification.length && verification.some((node) => this.options.attempts.getCurrentByNode(latestRun.id, node.id)?.status === 'invalidated')) return;
        if (
          unresolvedDefects.length ||
          (!latestRun.runtimeState.parentRepair &&
            nodes.some((node) => node.data.executionMode === 'isolated_write') &&
            (!verification.length || verification.some((node) => this.options.attempts.getCurrentByNode(latestRun.id, node.id)?.verifiedCandidateSetSha256 !== latestRun.candidateSetSha256)))
        ) {
          this.options.runs.update(latestRun.id, {
            expectedRevision: latestRun.revision,
            controlState: 'paused',
            error: { code: 'ZEUS_DIGITAL_TEAM_FINAL_VERIFICATION_REQUIRED', message: unresolvedDefects.length ? '正式阻塞缺陷尚未通过父流程复验。' : '最终代码候选缺少准确测试验收，流程已暂停。' },
          });
          return;
        }
        /** 完成前再次核对真实候选，人工改动工作区不会被缓存摘要掩盖。 */
        const verificationRevision = latestRun.revision;
        for (const candidate of latestRun.candidateRevisions) {
          const workspace = this.options.workspaces.getById(candidate.workspaceRef);
          const review = workspace?.worktreePath ? await getTaskWorkspaceReview(workspace.worktreePath) : null;
          if (!review?.clean || review.headSha !== candidate.headSha) {
            this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', message: '最终候选现场已变化，必须核对后重新验收。' } });
            return;
          }
        }
        latestRun = this.options.runs.getById(run.id)!;
        /** 实际 Git 核对期间的返工会改变运行修订，旧成功快照不能推进任务或流程。 */
        if (latestRun.revision !== verificationRevision || latestRun.controlState !== 'running' || latestRun.runtimeState.handoff?.status === 'stopping') return;
        if (!this.projectStatusesRemainValid(latestRun)) {
          await this.stopPausedRun(this.options.runs.getById(run.id)!);
          return;
        }
        /** 任务完成与团队完成共用最终门禁，不能在节点成果接纳时提前关单。 */
        for (const node of nodes) {
          const statusId = node.data.completionStatusId ? this.resolveRunTaskStatus(latestRun, node.data.completionStatusId) : undefined;
          if (statusId && (this.options.isCompletedTaskStatus?.(latestRun.projectId, statusId) ?? statusId === 'completed'))
            this.options.advanceTaskStatus?.(latestRun.taskId, statusId, { runId: latestRun.id, nodeId: node.id, phase: 'completed' });
        }
        this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'completed', completedAt: this.options.now().toISOString(), error: null });
      } else if (latestRun.status !== 'executing') {
        this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'executing' });
      }
      return;
    }
    /** 阶段名称是当前活动的投影，不再成为另一套派发条件。 */
    latestRun = this.options.runs.getById(run.id)!;
    if (!['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(latestRun.status)) {
      const attempts = this.currentAttempts(latestRun);
      const waiting = attempts.find((current) => current.status === 'awaiting_approval');
      const active = attempts.find((current) => inFlightAttemptStatuses.has(current.status));
      const currentNode = waiting || active ? requireNode(latestRun, (waiting ?? active)!.nodeId) : null;
      const stage =
        currentNode?.type === 'human_confirmation' ? (currentNode.data.purpose === 'plan_approval' ? 'awaiting_plan_approval' : 'awaiting_final_approval') : currentNode?.type === 'employee' ? reworkRunStatus(currentNode) : 'executing';
      if (stage !== latestRun.status) this.options.runs.update(run.id, { expectedRevision: latestRun.revision, status: stage });
    }
  }

  /** 没有执行或未知副作用的确定失败终结运行，保留全部结果供重新配置或显式返工。 */
  private settleDefiniteRunFailure(run: DigitalTeamWorkflowRunRecord): boolean {
    if (run.error?.code !== 'ZEUS_DIGITAL_TEAM_NODE_FAILED' || ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(run.status)) return false;
    /** 测试收齐后仍可能登记自动修复，旧修复轮也必须先恢复真实关系，不能提前终结。 */
    if (run.runtimeState.verificationRound || run.runtimeState.repairVerificationNodeId) return false;
    /** 当前有效尝试决定是否仍可能执行，不从历史失败数量推断可安全接纳新流程。 */
    const attempts = this.currentAttempts(run);
    if (!attempts.some((attempt) => attempt.status === 'failed') || attempts.some((attempt) => ['prepared', 'dispatching', 'active', 'outcome_unknown'].includes(attempt.status))) return false;
    for (const childId of this.associatedRepairRunIds(run)) {
      /** 修复关系缺失或尚未终结时保持原账本，不猜测代码执行已经停止。 */
      const child = this.options.runs.getById(childId);
      if (!child || !['completed', 'failed', 'cancelled'].includes(child.status) || this.currentAttempts(child).some((attempt) => ['prepared', 'dispatching', 'active', 'outcome_unknown'].includes(attempt.status))) return false;
    }
    this.options.runs.update(run.id, { expectedRevision: run.revision, status: 'failed', completedAt: this.options.now().toISOString() });
    return true;
  }

  /** 暂停或复验前逐一停止准确在途工作；无法确认时保留未知账本。 */
  private async stopPausedRun(run: DigitalTeamWorkflowRunRecord, affectedNodeIds?: ReadonlySet<string>): Promise<void> {
    /** 定向停止不能覆盖先前尚未明确处置的未知结果。 */
    let unknown = this.currentAttempts(run).some((attempt) => (!affectedNodeIds || affectedNodeIds.has(attempt.nodeId)) && attempt.status === 'outcome_unknown');
    /** 暂停父验收同时停止属于本轮的修复子流程，不留下继续写入的后台工作。 */
    for (const childId of this.associatedRepairRunIds(run)) {
      const child = this.options.runs.getById(childId);
      if (!child || ['completed', 'failed', 'cancelled'].includes(child.status)) continue;
      if (child.controlState === 'running') this.options.runs.update(child.id, { expectedRevision: child.revision, controlState: 'paused' });
      await this.stopPausedRun(this.options.runs.getById(child.id)!);
      if (this.options.runs.getById(child.id)?.status === 'outcome_unknown') unknown = true;
    }
    /** 已取消尝试仍核对对应工作项，恢复曾在 Provider 停止后尚未收口的耐久状态。 */
    for (const attempt of this.currentAttempts(run).filter(
      (candidate) => (!affectedNodeIds || affectedNodeIds.has(candidate.nodeId)) && (inFlightAttemptStatuses.has(candidate.status) || (candidate.status === 'cancelled' && Boolean(candidate.workItemId))),
    )) {
      if (inFlightAttemptStatuses.has(attempt.status) && (!attempt.workItemId || (attempt.status === 'dispatching' && !attempt.submissionId))) {
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
    if (unknown && (latestRun.status !== 'outcome_unknown' || latestRun.controlState !== 'paused'))
      this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'outcome_unknown', controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_STOP_UNKNOWN', message: '至少一个在途工作停止结果未知。' } });
    else if (!unknown && latestRun.error?.code === 'ZEUS_DIGITAL_TEAM_STOPPING') this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, error: null });
  }

  /** 人工改派先停止准确旧工作，迟到结果留在历史尝试里但不能推进新安排。 */
  private async processHandoff(run: DigitalTeamWorkflowRunRecord): Promise<void> {
    await this.stopPausedRun(run);
    const latest = this.options.runs.getById(run.id)!;
    const handoff = latest.runtimeState.handoff;
    if (!handoff || this.currentAttempts(latest).some((attempt) => inFlightAttemptStatuses.has(attempt.status) || attempt.status === 'outcome_unknown')) return;
    /** 旧修复分工也必须明确终结，再交给新的人工安排处理原正式缺陷。 */
    for (const childId of this.associatedRepairRunIds(latest)) {
      const child = this.options.runs.getById(childId);
      if (!child || ['completed', 'failed', 'cancelled'].includes(child.status)) continue;
      if (child.status === 'outcome_unknown' || this.currentAttempts(child).some((attempt) => inFlightAttemptStatuses.has(attempt.status) || attempt.status === 'outcome_unknown')) return;
      this.options.runs.update(child.id, { expectedRevision: child.revision, status: 'cancelled', controlState: 'cancelled', completedAt: this.options.now().toISOString() });
    }
    /** 冻结旧结果并统一失效，避免新入口误用旧安排的成功状态。 */
    for (const attempt of this.currentAttempts(latest).filter((item) => !['invalidated', 'cancelled'].includes(item.status)))
      this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'invalidated', invalidationReason: handoff.reason, invalidatedByAttemptId: attempt.id, completedAt: this.options.now().toISOString() });
    this.options.runs.update(latest.id, {
      expectedRevision: latest.revision,
      status: 'executing',
      controlState: 'running',
      candidateRevisions: [],
      runtimeState: { ...latest.runtimeState, entryNodeId: handoff.entryNodeId, candidateSourceSha256: null, repairVerificationNodeId: null, repairRunIds: [], verificationRound: null, handoff: { ...handoff, status: 'completed' } },
      error: null,
    });
  }

  /** 读取本轮全部修复关系，旧单测试字段不能遗漏正式缺陷绑定的子流程。 */
  private associatedRepairRunIds(run: DigitalTeamWorkflowRunRecord): string[] {
    return [
      ...new Set([
        ...(run.runtimeState.repairRunIds ?? []),
        ...(run.runtimeState.verificationRound?.repairRunIds ?? []),
        ...this.options.defects
          .listByRun(run.id)
          .filter((defect) => ['repairing', 'awaiting_retest'].includes(defect.status))
          .flatMap((defect) => (defect.repairRunId && defect.repairRunId !== run.id ? [defect.repairRunId] : [])),
      ]),
    ];
  }

  /** 存量父验收轮只从正式来源和子流程冻结事实恢复，不猜测被覆盖关系或退还旧预算。 */
  private restoreLegacyVerificationRound(run: DigitalTeamWorkflowRunRecord): boolean {
    const defects = this.options.defects.listByRun(run.id).filter((defect) => ['open', 'repairing', 'awaiting_retest'].includes(defect.status));
    const tests = [...new Map(defects.map((defect) => [defect.sourceAttemptId, { nodeId: defect.verificationNodeId, attemptId: defect.sourceAttemptId }])).values()];
    const childIds = this.associatedRepairRunIds(run);
    if (
      !defects.length ||
      !run.candidateSetSha256 ||
      defects.some((defect) => {
        const source = this.options.attempts.getById(defect.sourceAttemptId);
        const childId = defect.repairRunId ?? stableIdentity('digital_team_repair', `${run.id}\0${run.runtimeState.repairRound}\0${defect.id}`);
        const child = this.options.runs.getById(childId);
        if (defect.status === 'open' && !child && (run.runtimeState.repairRunIds ?? []).includes(childId)) {
          if (!childIds.includes(childId)) childIds.push(childId);
          return !source || source.runId !== run.id || source.nodeId !== defect.verificationNodeId;
        }
        return (
          !source ||
          source.runId !== run.id ||
          source.nodeId !== defect.verificationNodeId ||
          !child ||
          child.runtimeState.parentRepair?.runId !== run.id ||
          !child.runtimeState.parentRepair.defectIds.includes(defect.id) ||
          !child.baseRevisions.some((base) => base.repositoryId === defect.repositoryId && base.baseSha === defect.headSha)
        );
      })
    ) {
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_REPAIR_RELATION_UNPROVEN', message: '旧验收轮的正式来源或修复关系无法唯一恢复，请核对原记录。' } });
      return false;
    }
    this.options.runs.update(run.id, {
      expectedRevision: run.revision,
      runtimeState: {
        ...run.runtimeState,
        repairRunIds: childIds,
        verificationRound: {
          id: stableIdentity('digital_team_verification', `${run.id}\0legacy\0${stableJson(tests)}`),
          candidateSetSha256: run.candidateSetSha256 ?? '',
          candidates: structuredClone(run.candidateRevisions),
          tests,
          phase: 'repairing',
          defectIds: defects.map((defect) => defect.id),
          repairRunIds: childIds,
        },
      },
    });
    return true;
  }

  /** 同一候选全部真实测试收齐后统一登记缺陷，并耐久接纳一次修复额度。 */
  private async settleVerificationRound(run: DigitalTeamWorkflowRunRecord): Promise<boolean> {
    const round = run.runtimeState.verificationRound!;
    const attempts = round.tests.map((test) => this.options.attempts.getById(test.attemptId));
    if (attempts.some((attempt) => attempt && ['outcome_unknown', 'cancelled', 'invalidated'].includes(attempt.status))) {
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_VERIFICATION_INCOMPLETE', message: '本轮并行测试有未知、取消或失效结果，核对前不启动修复。' } });
      return false;
    }
    if (attempts.some((attempt) => !attempt || ['prepared', 'dispatching', 'active'].includes(attempt.status))) return true;
    if (run.candidateSetSha256 !== round.candidateSetSha256) {
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', message: '并行验收候选已变化，必须重新核对全部测试。' } });
      return false;
    }
    if (attempts.some((attempt) => !['succeeded', 'failed'].includes(attempt!.status) || (attempt!.status === 'succeeded' && attempt!.verifiedCandidateSetSha256 !== round.candidateSetSha256))) {
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_VERIFICATION_INCOMPLETE', message: '本轮测试尚无准确候选的完整验真终态，不能接纳复验。' } });
      return false;
    }
    if (attempts.every((attempt) => attempt!.status === 'succeeded')) {
      for (const test of round.tests) this.options.defects.acceptRetest(run.id, test.nodeId);
      for (const defect of this.options.defects.listByRun(run.id).filter((item) => item.status === 'accepted')) this.options.finishAcceptedDefect?.(defect.defectTaskId, run.id);
      this.options.runs.update(run.id, { expectedRevision: run.revision, runtimeState: { ...run.runtimeState, verificationRound: null }, error: null });
      return true;
    }
    const failed = attempts.filter((attempt) => attempt!.status === 'failed');
    if (failed.some((attempt) => attempt!.error?.code !== 'ZEUS_DIGITAL_TEAM_DEFECTS_FOUND' || !attempt!.result?.defects?.length)) {
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_VERIFICATION_INCOMPLETE', message: '本轮测试失败缺少已验真的正式缺陷，不能推断可自动修复。' } });
      return false;
    }
    for (const attempt of failed) this.registerAttemptDefects(run, requireNode(run, attempt!.nodeId) as DigitalTeamEmployeeNode, attempt!, attempt!.result!);
    const registered = this.options.defects.listByRun(run.id).filter((defect) => round.tests.some((test) => test.attemptId === defect.sourceAttemptId) && defect.status === 'open');
    const parentTask = this.options.tasks.getById(run.taskId)!;
    /** 修复范围受父运行冻结成员、本次权限及当前任务授权共同约束，不再读取已删除的员工权限开关。 */
    const allowed = Boolean(
      run.definitionSnapshot.repairEmployeeId &&
      run.roleSnapshots.some((snapshot) => snapshot.employeeId === run.definitionSnapshot.repairEmployeeId) &&
      run.runtimeState.permissionMode !== 'read-only' &&
      parentTask.allowCodeChanges &&
      parentTask.allowGitCommit,
    );
    const nextRound = this.options.defects.getRepairRounds(run.taskId) + 1;
    if (!allowed || nextRound > (run.definitionSnapshot.maxRepairRounds ?? 3)) {
      this.options.runs.update(run.id, {
        expectedRevision: run.revision,
        controlState: 'paused',
        error: {
          code: allowed ? 'ZEUS_DIGITAL_TEAM_REPAIR_LIMIT_REACHED' : 'ZEUS_DIGITAL_TEAM_REPAIR_AUTHORITY_REQUIRED',
          message: allowed ? '自动修复额度已用尽，正式缺陷仍阻塞完成。' : '全部正式缺陷已登记；缺少预先授权修复员工或父任务代码权限。',
        },
      });
      return false;
    }
    const childIds = registered.map((defect) => stableIdentity('digital_team_repair', `${run.id}\0${nextRound}\0${defect.id}`));
    const state: DigitalTeamRunRuntimeState = {
      ...run.runtimeState,
      repairVerificationNodeId: round.tests[0]!.nodeId,
      repairRunIds: childIds,
      verificationRound: { ...round, phase: 'repairing', defectIds: registered.map((defect) => defect.id), repairRunIds: childIds },
    };
    if (this.options.defects.admitRepairRound(run.id, run.revision, run.taskId, run.definitionSnapshot.maxRepairRounds ?? 3, state) === null) return false;
    const frozen = this.options.runs.getById(run.id)!;
    for (const [index, defect] of registered.entries()) this.createDefectRepairRun(frozen, defect, childIds[index]!);
    await this.options.save();
    return false;
  }

  /** 父验收轮等待全部核验修复成果，统一合成后让旧候选的全部测试及后继重新执行。 */
  private async processRepairResults(run: DigitalTeamWorkflowRunRecord): Promise<boolean> {
    const round = run.runtimeState.verificationRound!;
    const defects = this.options.defects.listByRun(run.id).filter((defect) => round.defectIds.includes(defect.id));
    for (const defect of defects) {
      const childId = stableIdentity('digital_team_repair', `${run.id}\0${run.runtimeState.repairRound}\0${defect.id}`);
      if (defect.status === 'open' && round.repairRunIds.includes(childId)) this.createDefectRepairRun(run, defect, childId);
    }
    const children = round.repairRunIds.map((id) => this.options.runs.getById(id));
    if (
      defects.length !== round.defectIds.length ||
      !children.length ||
      children.some(
        (child) => !child || ['outcome_unknown', 'failed', 'cancelled'].includes(child.status) || child.controlState === 'paused' || this.currentAttempts(child).some((attempt) => ['failed', 'outcome_unknown'].includes(attempt.status)),
      )
    ) {
      this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_REPAIR_BLOCKED', message: '本轮修复流程缺失、失败、暂停或结果未知，需要核对后继续。' } });
      return false;
    }
    if (children.some((child) => child!.status !== 'completed')) return false;
    for (const defect of defects.filter((item) => item.status === 'repairing')) {
      const child = children.find((item) => item?.id === defect.repairRunId);
      const results = child ? this.currentAttempts(child).flatMap((attempt) => (attempt.status === 'succeeded' ? (attempt.result?.repositoryResults ?? []) : [])) : [];
      if (!child || !results.length || results.some((result) => result.repositoryId !== defect.repositoryId || result.baseSha !== defect.headSha) || results.every((result) => result.headSha === defect.headSha)) {
        this.options.runs.update(run.id, { expectedRevision: run.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_REPAIR_NO_PROGRESS', message: '修复没有从准确被测版本形成新的真实代码成果，已暂停。' } });
        return false;
      }
      this.options.defects.submitRepair(defect.id, child.id, results);
    }
    /** 修复尚未形成新候选；顺序验收中先前已通过的旧候选结果也必须复验。 */
    const verificationNodes = digitalTeamExecutionDefinition(run).nodes.filter((node) => node.type === 'employee' && node.data.executionMode === 'candidate_read_only');
    /** 先前 QA 的其他后继可能仍在执行，必须停止完整受影响集合后才可失效。 */
    const affectedNodeIds = new Set(verificationNodes.flatMap((node) => [...descendantIds(run, node.id)]));
    await this.stopPausedRun(run, affectedNodeIds);
    /** 停止期间的人工控制和未知外部结果均保留原候选及修复轮，禁止重派。 */
    const stoppedRun = this.options.runs.getById(run.id)!;
    if (stoppedRun.controlState !== 'running' || stoppedRun.status === 'outcome_unknown' || stoppedRun.runtimeState.verificationRound?.id !== round.id) return false;
    for (const node of verificationNodes) this.options.attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: node.id, reason: '本轮全部修复成果已核验，旧候选的测试与后继统一重新执行。' });
    const latest = this.options.runs.getById(run.id)!;
    this.options.runs.update(latest.id, {
      expectedRevision: latest.revision,
      status: 'executing',
      candidateRevisions: [],
      runtimeState: {
        ...latest.runtimeState,
        repairVerificationNodeId: null,
        repairRunIds: [],
        verificationRound: null,
        candidateSourceSha256: null,
      },
      error: null,
    });
    return true;
  }

  /** 自动修复从父测试准确版本创建隔离子流程，不扩大父任务授权。 */
  private createDefectRepairRun(parent: DigitalTeamWorkflowRunRecord, defect: DefectWorkflowRecord, childId: string): void {
    if (!this.options.runs.getById(childId)) {
      const task = this.options.tasks.getById(defect.defectTaskId);
      if (!task || task.projectId !== parent.projectId) throw routeError('ZEUS_DIGITAL_TEAM_DEFECT_TASK_MISSING', '正式缺陷子任务不存在。');
      const repairEmployeeId = parent.definitionSnapshot.repairEmployeeId!;
      const node: DigitalTeamEmployeeNode = {
        id: 'repair',
        type: 'employee',
        position: { x: 120, y: 120 },
        data: {
          title: `修复：${defect.title}`,
          employeeId: repairEmployeeId,
          purpose: 'work',
          executionMode: 'isolated_write',
          instructions: `仅修复正式缺陷 ${defect.key}。${defect.description}\n实际失败现场：${stableJson({ reproductionEvidence: defect.reproductionEvidence, repositoryId: defect.repositoryId, testedHeadSha: defect.headSha, sourceAttemptId: defect.sourceAttemptId, previousRepairResults: defect.repairResults })}`,
          acceptanceCriteria: ['缺陷修复提交与实际验证证据均可核对'],
          expectedDeliverables: ['准确 baseSha/headSha 的修复代码与验证证据'],
        },
      };
      this.options.runs.create(
        {
          id: childId,
          projectId: parent.projectId,
          taskId: defect.defectTaskId,
          definition: { schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes: [node], edges: [], viewport: { x: 0, y: 0, zoom: 1 }, projectMemoryPolicy: parent.definitionSnapshot.projectMemoryPolicy },
          taskFacts: { ...structuredClone(task), parentAcceptanceRunId: parent.id, failure: defect },
          baseRevisions: [{ repositoryId: defect.repositoryId, sourceRef: 'HEAD', baseSha: defect.headSha }],
          runtimeState: { repairRound: parent.runtimeState.repairRound, permissionMode: parent.runtimeState.permissionMode, parentRepair: { runId: parent.id, defectIds: [defect.id], verificationNodeId: defect.verificationNodeId } },
        },
        parent.id,
      );
    }
    this.options.defects.bindRepair(defect.id, childId);
  }

  /** 本轮结果收齐后按准确来源登记正式缺陷，预算由父验收轮统一接纳。 */
  private registerAttemptDefects(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord, result: DigitalTeamStructuredResult): void {
    const parentTask = this.options.tasks.getById(run.taskId)!;
    for (const defect of result.defects ?? []) {
      const previous = this.options.defects.getByProblem(run.taskId, defect.key);
      const defectTaskId = previous?.defectTaskId ?? stableIdentity('task', `${run.taskId}\0defect\0${defect.key}`);
      if (!previous)
        this.options.taskCreation.create(
          {
            projectId: run.projectId,
            parentTaskId: run.taskId,
            title: defect.title,
            taskType: 'defect',
            description: defect.description,
            defectCurrentState: defect.description,
            defectExpectedOutcome: '准确修复成果合入父候选并通过父流程复验。',
            defectReproductionSteps: defect.reproductionEvidence.join('\n'),
            allowCodeChanges: parentTask.allowCodeChanges,
            allowTests: parentTask.allowTests,
            allowGitCommit: parentTask.allowGitCommit,
            sourceContext: { type: 'digital_team_workflow', digitalTeamRunId: run.id, verificationAttemptId: attempt.id, testedRepositoryId: defect.repositoryId, testedHeadSha: defect.headSha },
          },
          defectTaskId,
          {
            commandId: String(run.taskFacts.digitalTeamSourceCommandId),
            operationIdentity: stableIdentity('digital_team_defect', `${run.id}\0${defect.key}`),
            actor: { kind: 'worker', id: node.data.employeeId },
            taskOrigin: 'digital_team_workflow',
          },
        );
      this.options.defects.register({ ...defect, parentTaskId: run.taskId, defectTaskId, parentRunId: run.id, verificationNodeId: node.id, sourceAttemptId: attempt.id });
    }
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
    if (node.data.purpose === 'plan' && run.definitionSnapshot.schemaGeneration !== digitalTeamWorkflowSchemaGeneration) await this.acceptTerminalPlan(run, attempt);
    else await this.acceptTerminalResult(run, node, attempt);
  }

  /** 为本次尝试创建员工会话；dispatching 先落库，副作用后才绑定 submission。 */
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
      /** 每个节点尝试拥有独立工作运行；汇总通过上游成果继承上下文。 */
      /** 最新失效尝试携带本次人工返工要求，不能只保存历史而让新员工重复旧目标。 */
      /** 只传递直接针对本节点的返工要求；上游失效原因不能冒充下游的新指令。 */
      const priorAttempt = this.options.attempts
        .listByRun(run.id)
        .filter((candidate) => candidate.nodeId === node.id && candidate.attempt < attempt.attempt && candidate.status === 'invalidated')
        .sort((left, right) => right.attempt - left.attempt)[0];
      /** 人工拒绝规划或最终验收时，由对应确认节点明确退回规划或汇总。 */
      const invalidationSource = priorAttempt?.invalidatedByAttemptId ? this.options.attempts.getById(priorAttempt.invalidatedByAttemptId) : null;
      /** 自身返工和对应人工退回拥有明确的节点归属，历史无来源原因不作为指令重放。 */
      const directlyReworked = invalidationSource?.id === priorAttempt?.id || (invalidationSource?.nodeType === 'human_confirmation' && directPredecessorIds(run, invalidationSource.nodeId).includes(node.id));
      const reworkReason = directlyReworked ? (priorAttempt?.invalidationReason ?? null) : null;
      /** 测试和汇总接收本闭环的真实失败与已完成修复，不能只看到最后一次复验。 */
      const handoffDefects = ['verify', 'summary'].includes(node.data.purpose) ? this.options.defects.listByRun(run.id) : [];
      /** 只引用准确来源尝试及当前正式修复的成功成果，不扩大普通跨任务读取。 */
      const handoffAttempts = handoffDefects.flatMap((defect) => [
        this.options.attempts.getById(defect.sourceAttemptId),
        ...(defect.repairRunId && this.options.runs.getById(defect.repairRunId)?.status === 'completed' ? this.options.attempts.listByRun(defect.repairRunId).filter((item) => item.status === 'succeeded') : []),
      ]);
      const prompt = `${buildNodePrompt(run, node, attempt, this.options.attempts.listByRun(run.id), reworkReason)}${handoffDefects.length ? `\n\n正式缺陷交付关系：\n${stableJson(handoffDefects.map((defect) => ({ id: defect.id, key: defect.key, status: defect.status, sourceAttemptId: defect.sourceAttemptId, repairRunId: defect.repairRunId, repairResults: defect.repairResults })))}` : ''}`;
      {
        externalOutcomeUncertain = node.data.executionMode === 'isolated_write';
        const workspace = await this.prepareEmployeeWorkspace(run, node, attempt);
        externalOutcomeUncertain = false;
        /** 缺陷修复沿用父流程确认的规则来源，独立无模板流程不能获得自动记忆授权。 */
        const memoryPolicySource = run.runtimeState.parentRepair ? this.options.runs.getById(run.runtimeState.parentRepair.runId) : run;
        const created = await this.options.taskWork.createWorkflowWorkItem({
          taskId: run.taskId,
          employeeId: node.data.employeeId,
          employeeSnapshot: this.frozenEmployee(run, node.data.employeeId),
          sourceRef: `digital-team:${run.id}:${node.id}:attempt:${attempt.attempt}`,
          title: node.data.title,
          // 工作项说明仅作列表摘要；完整节点要求和上游证据仍保存在 supplementalInfo。
          description: node.data.instructions.slice(0, 4_000),
          supplementalInfo: prompt,
          /** 各节点沿用整份工作创建时确认的经验规则，项目后续编辑不改变在途授权。 */
          projectMemoryPolicy:
            memoryPolicySource?.templateId && memoryPolicySource.templateRevision !== null && memoryPolicySource.definitionSnapshot.projectMemoryPolicy
              ? {
                  workflowTemplateId: memoryPolicySource.templateId,
                  workflowTemplateRevision: memoryPolicySource.templateRevision,
                  autoApplyStableExperience: memoryPolicySource.definitionSnapshot.projectMemoryPolicy?.autoApplyStableExperience === true,
                }
              : undefined,
          upstreamDeliverableIds: [
            ...new Set([
              ...(run.runtimeState.inputDeliverableIds ?? []),
              ...(priorAttempt?.deliverableId ? [priorAttempt.deliverableId] : []),
              ...handoffAttempts.flatMap((item) => (item?.deliverableId ? [item.deliverableId] : [])),
              ...this.currentAttempts(run)
                .filter((item) => directPredecessorIds(run, node.id).includes(item.nodeId) && item.status === 'succeeded' && item.deliverableId)
                .map((item) => item.deliverableId!),
              ...(run.runtimeState.parentRepair
                ? this.options.defects
                    .listByRun(run.runtimeState.parentRepair.runId)
                    .filter((defect) => run.runtimeState.parentRepair!.defectIds.includes(defect.id))
                    .map((defect) => this.options.attempts.getById(defect.sourceAttemptId)?.deliverableId)
                    .filter((id): id is string => Boolean(id))
                : []),
            ]),
          ],
          workspace: workspace ? { mode: 'existing', environmentId: workspace.environmentId! } : { mode: 'direct' },
          purpose: node.data.purpose,
          executionMode: node.data.executionMode,
          settings: {
            ...node.data.settings,
            permissionMode:
              run.runtimeState.permissionMode === 'read-only' || node.data.settings?.permissionMode === 'read-only'
                ? 'read-only'
                : run.runtimeState.permissionMode === 'auto' || node.data.settings?.permissionMode === 'auto'
                  ? 'auto'
                  : (run.runtimeState.permissionMode ?? node.data.settings?.permissionMode),
          },
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
        if (accepted.submissionId && node.data.startStatusId) {
          if (!this.projectStatusesRemainValid(this.options.runs.getById(run.id)!)) {
            await this.stopPausedRun(this.options.runs.getById(run.id)!);
            return;
          }
          this.options.advanceTaskStatus?.(run.taskId, this.resolveRunTaskStatus(run, node.data.startStatusId), { runId: run.id, nodeId: node.id, phase: 'started' });
        }
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
    /** 新人工入口从明确交接代码开始，父验收的原始基线仍保留供审计。 */
    const inputBases = run.runtimeState.entryCodeRevisions ?? run.baseRevisions;
    if (node.data.executionMode === 'read_only') {
      if (inputBases.length !== 1) return null;
      const base = inputBases[0]!;
      const upstreamCommitShas = collectUpstreamWorkCommits(run, node.id, this.currentAttempts(run), base.repositoryId);
      if (upstreamCommitShas.length === 0 && !run.runtimeState.entryCodeRevisions?.length) return null;
      const repository = this.requireRepository(run.projectId, base.repositoryId);
      const prepared = await prepareWorkflowCandidate({
        repositoryPath: repository.localPath,
        projectSlug: this.requireProject(run.projectId).slug,
        candidateId: attempt.id,
        branchName: workflowBranchName(run, node, attempt, repository.id),
        baseSha: base.baseSha,
        upstreamCommitShas,
      });
      if (prepared.state !== 'ready' || !prepared.candidateSha) throw routeError('ZEUS_DIGITAL_TEAM_WORKSPACE_CONFLICT', `上游代码成果存在未解决冲突：${prepared.conflictFiles.join('、')}`);
      return this.registerPreparedWorkspace(run, attempt.id, repository, base, prepared.worktreePath, prepared.branchName, prepared.candidateSha);
    }
    if (node.data.executionMode === 'candidate_read_only') {
      if (run.candidateRevisions.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '当前真实验证入口要求运行只有一个候选仓库。');
      /** 每份测试从同一准确候选建立独立现场，命令与环境占用不会相互干扰。 */
      const candidate = run.candidateRevisions[0]!;
      const workspace = this.options.workspaces.getById(candidate.workspaceRef);
      const review = workspace?.worktreePath ? await getTaskWorkspaceReview(workspace.worktreePath) : null;
      if (!workspace?.environmentId || workspace.taskId !== run.taskId || workspace.projectId !== run.projectId || workspace.repositoryId !== candidate.repositoryId || !review?.clean || review.headSha !== candidate.headSha)
        throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '候选工作区不存在、已变化或包含未提交修改。');
      const repository = this.requireRepository(run.projectId, candidate.repositoryId);
      const base = { repositoryId: candidate.repositoryId, sourceRef: 'HEAD', baseSha: candidate.headSha };
      const prepared = await prepareWorkflowCandidate({
        repositoryPath: repository.localPath,
        projectSlug: this.requireProject(run.projectId).slug,
        candidateId: attempt.id,
        branchName: workflowBranchName(run, node, attempt, repository.id),
        baseSha: candidate.headSha,
        upstreamCommitShas: [],
      });
      if (prepared.state !== 'ready' || prepared.candidateSha !== candidate.headSha) throw routeError('ZEUS_DIGITAL_TEAM_CANDIDATE_STALE', '独立验收现场没有保持准确候选版本。');
      return this.registerPreparedWorkspace(run, attempt.id, repository, base, prepared.worktreePath, prepared.branchName, candidate.headSha);
    }
    if (inputBases.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '当前真实开发入口要求项目只登记一个 Git 仓库。');
    const base = inputBases[0]!;
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
    return this.registerPreparedWorkspace(run, attempt.id, repository, base, prepared.worktreePath, prepared.branchName, prepared.candidateSha);
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
      const workspace = this.registerPreparedWorkspace(run, attempt.id, repository, base, prepared.worktreePath, prepared.branchName, prepared.candidateSha);
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

  /** 当前员工编排完成后自动形成任务内代码候选，不向团队画布暴露系统节点。 */
  private async integrateCurrentCandidate(run: DigitalTeamWorkflowRunRecord, required = false): Promise<boolean> {
    if (!required && !digitalTeamExecutionDefinition(run).nodes.some((node) => node.type === 'employee' && node.data.executionMode === 'isolated_write')) return true;
    /** 修复提交与原开发成果共同形成候选，新代码必须形成新的不可变候选身份。 */
    const repairs = (this.options.defects?.listByRun(run.id) ?? []).flatMap((defect) => defect.repairResults);
    const sourceSha256 = sha256(stableJson({ work: collectAllWorkCommits(run, this.currentAttempts(run), run.baseRevisions[0]?.repositoryId ?? ''), repairs, entryCodeRevisions: run.runtimeState.entryCodeRevisions }));
    if (run.candidateRevisions.length > 0 && run.runtimeState.candidateSourceSha256 === sourceSha256) return true;
    let latestRun = this.options.runs.getById(run.id)!;
    if (latestRun.status !== 'integrating') latestRun = this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'integrating', error: null });
    await this.options.save();
    const operationId = stableIdentity('digital_team_candidate', `${latestRun.id}\0${sourceSha256}`);
    try {
      if (latestRun.baseRevisions.length !== 1) throw routeError('ZEUS_DIGITAL_TEAM_MULTI_REPOSITORY_UNSUPPORTED', '当前自动代码候选入口要求项目只登记一个 Git 仓库。');
      const base = latestRun.baseRevisions[0]!;
      const repository = this.requireRepository(latestRun.projectId, base.repositoryId);
      const upstreamCommitShas = [
        ...new Set([
          ...collectAllWorkCommits(latestRun, this.currentAttempts(latestRun), base.repositoryId),
          ...(latestRun.runtimeState.entryCodeRevisions ?? []).filter((revision) => revision.repositoryId === base.repositoryId).map((revision) => revision.baseSha),
          ...repairs.filter((result) => result.repositoryId === base.repositoryId).map((result) => result.headSha),
        ]),
      ];
      if (upstreamCommitShas.length === 0 && !required) throw routeError('ZEUS_DIGITAL_TEAM_INTEGRATION_INPUT_MISSING', '代码分工没有提交可集成的版本。');
      const prepared = await prepareWorkflowCandidate({
        repositoryPath: repository.localPath,
        projectSlug: this.requireProject(latestRun.projectId).slug,
        candidateId: operationId,
        branchName: `zeus/digital-team-${sha256(`${latestRun.id}\0${sourceSha256}\0${repository.id}`).slice(0, 20)}`,
        baseSha: base.baseSha,
        upstreamCommitShas,
      });
      if (prepared.state !== 'ready' || !prepared.candidateSha) {
        this.options.runs.update(latestRun.id, {
          expectedRevision: latestRun.revision,
          status: 'executing',
          controlState: 'paused',
          error: { code: 'ZEUS_DIGITAL_TEAM_INTEGRATION_CONFLICT', message: `代码成果存在冲突：${prepared.conflictFiles.join('、')}。请返工相关员工分工后重试。` },
        });
        return false;
      }
      const workspace = this.registerPreparedWorkspace(latestRun, operationId, repository, base, prepared.worktreePath, prepared.branchName, prepared.candidateSha);
      latestRun = this.options.runs.getById(latestRun.id)!;
      this.options.runs.update(latestRun.id, {
        expectedRevision: latestRun.revision,
        status: 'executing',
        candidateRevisions: [{ repositoryId: repository.id, headSha: prepared.candidateSha, workspaceRef: workspace.id }],
        runtimeState: { ...latestRun.runtimeState, candidateSourceSha256: sourceSha256 },
        error: null,
      });
      return true;
    } catch (error) {
      latestRun = this.options.runs.getById(latestRun.id)!;
      this.options.runs.update(latestRun.id, { expectedRevision: latestRun.revision, status: 'outcome_unknown', error: serializeError(error) });
      return false;
    }
  }

  /** 把物理候选 worktree 登记为现有任务环境，供 task_push 精确复用。 */
  private registerPreparedWorkspace(
    run: DigitalTeamWorkflowRunRecord,
    operationId: string,
    repository: ZeusProjectRepositoryRecord,
    base: DigitalTeamBaseRevision,
    worktreePath: string,
    branchName: string,
    inputHeadSha: string,
  ): ZeusTaskWorkspaceRecord {
    const environmentId = stableIdentity('task_environment', operationId).slice(0, 41);
    const workspaceId = stableIdentity('task_workspace', `${operationId}\0${repository.id}`).slice(0, 39);
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

  /** 负责人 规划只在 exact turn 成功终态后进入待批准。 */
  private async acceptTerminalPlan(run: DigitalTeamWorkflowRunRecord, attempt: DigitalTeamNodeAttemptRecord): Promise<void> {
    const pending = isRecord(attempt.artifactRef) && attempt.artifactRef.kind === 'pending_team_plan' ? attempt.artifactRef.plan : null;
    const errors = validateDigitalTeamStructuredPlan(run.definitionSnapshot, pending);
    if (errors.length > 0) {
      this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_PLAN_MISSING', errors[0] ?? '负责人 未提交结构化计划。');
      return;
    }
    const latestRun = this.options.runs.getById(run.id)!;
    this.options.runs.submitPlan(latestRun.id, { expectedRevision: latestRun.revision, plan: pending as DigitalTeamStructuredPlan });
    const latest = this.options.attempts.getById(attempt.id)!;
    this.options.attempts.update(latest.id, { expectedRevision: latest.revision, status: 'succeeded', completedAt: this.options.now().toISOString() });
    if (latest.workRunId) this.options.taskWork.settleWorkflowWorkItem(latest.workRunId, 'succeeded');
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
      /** 正式缺陷只能由核对准确候选的测试员工登记，复现证据属于当前实际轮次。 */
      if (result.defects?.length) {
        if (run.runtimeState.parentRepair || node.data.purpose !== 'verify' || node.data.executionMode !== 'candidate_read_only' || result.outcome === 'succeeded' || result.verification !== 'failed')
          throw new Error('正式缺陷需要父流程测试失败及准确被测候选，修复子流程不能再创建缺陷的缺陷。');
        for (const defect of result.defects) {
          if (
            !defect ||
            typeof defect.key !== 'string' ||
            !defect.key.trim() ||
            defect.key.length > 256 ||
            typeof defect.title !== 'string' ||
            !defect.title.trim() ||
            defect.title.length > 240 ||
            typeof defect.description !== 'string' ||
            !defect.description.trim() ||
            defect.description.length > 4_000 ||
            !Array.isArray(defect.reproductionEvidence) ||
            !defect.reproductionEvidence.length ||
            defect.reproductionEvidence.some((id) => !result.evidence.some((evidence) => evidence.id === id && ['command', 'artifact'].includes(evidence.kind))) ||
            !run.candidateRevisions.some((candidate) => candidate.repositoryId === defect.repositoryId && candidate.headSha === defect.headSha)
          )
            throw new Error('缺陷需要稳定问题身份、复现说明、当前真实证据和准确被测代码身份。');
        }
      }
      if (!attempt.workRunId || !attempt.turnId) throw new Error('正式成果缺少准确工作运行和 Provider 轮次。');
      const deliverable = await this.options.taskWork.freezeWorkflowDeliverable({ workRunId: attempt.workRunId, turnId: attempt.turnId, summary: result.summary, structuredResult: result });
      const captured = this.options.attempts.getById(attempt.id)!;
      this.options.attempts.update(captured.id, { expectedRevision: captured.revision, deliverableId: deliverable.deliverableId, deliverableVersion: deliverable.deliverableVersion, artifactRef: deliverable.artifactRef });
      /** 冻结期间的新人工安排优先，旧成果可保存但不能推进状态。 */
      const afterCapture = this.options.runs.getById(run.id)!;
      if (afterCapture.runtimeState.handoff?.status === 'stopping') {
        const oldAttempt = this.options.attempts.getById(attempt.id)!;
        this.options.attempts.update(oldAttempt.id, { expectedRevision: oldAttempt.revision, status: 'cancelled', result, completedAt: this.options.now().toISOString() });
        if (oldAttempt.workRunId) this.options.taskWork.settleWorkflowWorkItem(oldAttempt.workRunId, 'failed', '成果已保存；等待新的人工安排完成交接。');
        return;
      }
      if (result.defects?.length) {
        this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_DEFECTS_FOUND', result.summary, result);
        return;
      }
      if (result.outcome !== 'succeeded' || (node.data.purpose === 'verify' && result.verification !== 'passed')) {
        this.failAttempt(attempt, 'ZEUS_DIGITAL_TEAM_RESULT_FAILED', result.summary, result);
        return;
      }
      const latest = this.options.attempts.getById(attempt.id)!;
      this.options.attempts.submitResult(latest.id, {
        expectedRevision: latest.revision,
        result,
        verifiedCandidateSetSha256: node.data.executionMode === 'candidate_read_only' ? run.candidateSetSha256 : null,
        deliverableId: deliverable.deliverableId,
        deliverableVersion: deliverable.deliverableVersion,
        artifactRef: deliverable.artifactRef,
      });
      if (latest.workRunId) this.options.taskWork.settleWorkflowWorkItem(latest.workRunId, 'succeeded');
      if (node.data.executionMode === 'isolated_write')
        for (const defect of this.options.defects.listByRun(run.id).filter((item) => ['open', 'repairing'].includes(item.status))) {
          const repairResults = result.repositoryResults.filter((repository) => repository.repositoryId === defect.repositoryId && repository.baseSha === defect.headSha && repository.headSha !== defect.headSha);
          if (repairResults.length) this.options.defects.submitManualRepair(defect.id, run.id, repairResults);
        }
      if (node.data.purpose === 'verify' && node.data.executionMode === 'candidate_read_only' && !this.options.runs.getById(run.id)?.runtimeState.verificationRound) {
        this.options.defects.acceptRetest(run.id, node.id);
        for (const defect of this.options.defects.listByRun(run.id).filter((item) => item.status === 'accepted')) this.options.finishAcceptedDefect?.(defect.defectTaskId, run.id);
      }
      /** 中间状态随节点推进，真实完成状态必须等待整个运行最终验真。 */
      const statusId = node.data.completionStatusId ? this.resolveRunTaskStatus(run, node.data.completionStatusId) : undefined;
      if (statusId && !this.projectStatusesRemainValid(this.options.runs.getById(run.id)!)) {
        await this.stopPausedRun(this.options.runs.getById(run.id)!);
        return;
      }
      if (statusId && !(this.options.isCompletedTaskStatus?.(run.projectId, statusId) ?? statusId === 'completed')) this.options.advanceTaskStatus?.(run.taskId, statusId, { runId: run.id, nodeId: node.id, phase: 'completed' });
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
      if (!review.clean || !repositoryResult || repositoryResult.baseSha !== workspace.sourceHeadSha || repositoryResult.headSha !== review.headSha) {
        throw new Error('写入结果没有绑定干净工作区的准确输入和提交。');
      }
    }
    if (node.data.purpose === 'verify') {
      if (result.outcome === 'succeeded' && result.verification !== 'passed') throw new Error('测试分工只有真实通过才可以提交成功结果。');
      if (result.outcome === 'succeeded' && result.verification === 'passed' && successfulVerificationCommands.length === 0) throw new Error('测试验收通过需要当前准确轮次的真实成功命令依据。');
      const missingCommands = missingDigitalTeamVerificationCommands(node.data.verificationCommands ?? [], successfulVerificationCommands);
      if (result.outcome === 'succeeded' && missingCommands.length > 0) throw new Error(`验证节点缺少当前轮次成功命令：${missingCommands.join('；')}`);
    }
    if (node.data.executionMode === 'candidate_read_only') {
      const workspace = attempt.workspaceId ? this.options.workspaces.getById(attempt.workspaceId) : undefined;
      /** 独立测试现场按仓库和冻结输入绑定候选，不能靠共用环境身份代替版本核对。 */
      const candidate = workspace ? run.candidateRevisions.find((entry) => entry.repositoryId === workspace.repositoryId && entry.headSha === workspace.sourceHeadSha) : undefined;
      const review = workspace?.worktreePath ? await getTaskWorkspaceReview(workspace.worktreePath) : null;
      if (!workspace || workspace.taskId !== run.taskId || workspace.projectId !== run.projectId || !candidate || !review?.clean || workspace.headSha !== candidate.headSha || review.headSha !== candidate.headSha)
        throw new Error('验证轮次没有绑定当前干净候选版本。');
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
        if (node.data.purpose !== 'plan') throw routeError('ZEUS_DIGITAL_TEAM_TOOL_SCOPE', '当前节点不是负责人规划节点。');
        const errors = validateDigitalTeamStructuredPlan(run.definitionSnapshot, call.arguments);
        if (errors.length > 0) throw routeError('ZEUS_DIGITAL_TEAM_PLAN_INVALID', errors[0]!, 400);
        const next = { kind: 'pending_team_plan', plan: structuredClone(call.arguments), callId: call.callId, turnId: turn.id };
        if (attempt.artifactRef && stableJson(attempt.artifactRef) !== stableJson(next)) throw routeError('ZEUS_DIGITAL_TEAM_TOOL_REPLAY_CONFLICT', '当前尝试已提交不同规划。');
        if (!attempt.artifactRef) this.options.attempts.update(attempt.id, { expectedRevision: attempt.revision, artifactRef: next });
      } else if (call.tool === 'submit_team_result') {
        if (!isStructuredResultSubmission(call.arguments)) throw routeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', '结构化结果字段不完整。', 400);
        /** 在活跃轮次拒绝字符串化或不完整引用，让员工立即修正而不是交付后才失败。 */
        if (call.arguments.artifactRefs.some((reference) => !isRecord(reference) || typeof reference.sha256 !== 'string' || !isRecord(reference.owner) || typeof reference.owner.kind !== 'string' || typeof reference.owner.id !== 'string'))
          throw routeError('ZEUS_DIGITAL_TEAM_RESULT_INVALID', 'artifactRefs 必须填写 publish_artifact 返回的对象，包含 sha256 和 owner；不能填写 JSON 字符串。', 400);
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
    if (latest.workRunId) this.options.taskWork.settleWorkflowWorkItem(latest.workRunId, 'failed', message);
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
    return digitalTeamExecutionDefinition(run).nodes.flatMap((node) => {
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
  return digitalTeamExecutionDefinition(run)
    .edges.filter((edge) => edge.target === nodeId)
    .map((edge) => edge.source);
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
  const outgoing = new Map(digitalTeamExecutionDefinition(run).nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of digitalTeamExecutionDefinition(run).edges) outgoing.get(edge.source)!.push(edge.target);
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
      digitalTeamExecutionDefinition(run).nodes.flatMap((node) => {
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
  const predecessors = digitalTeamExecutionDefinition(run)
    .edges.filter((edge) => edge.target === node.id)
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
  /** 负责人需要准确的既定分工身份和数量范围，不能靠猜节点名称提交计划。 */
  const laterNodeIds = node.data.purpose === 'plan' ? descendantIds(run, node.id) : new Set<string>();
  const planningScope =
    node.data.purpose === 'plan'
      ? {
          existingWork: run.definitionSnapshot.nodes.filter((candidate) => candidate.type === 'employee' && candidate.data.purpose === 'work' && laterNodeIds.has(candidate.id)),
          delegation: node.data.settings?.delegation ?? null,
        }
      : undefined;
  const assignment = run.plan?.assignments.find((candidate) => candidate.nodeId === node.id) ?? null;
  const predecessorIds = new Set(directPredecessorIds(run, node.id));
  const upstream = attempts
    .filter((candidate) => predecessorIds.has(candidate.nodeId) && candidate.status === 'succeeded' && !attempts.some((other) => other.nodeId === candidate.nodeId && other.attempt > candidate.attempt))
    .map((candidate) => ({
      nodeId: candidate.nodeId,
      attempt: candidate.attempt,
      outcome: candidate.result?.outcome,
      summary: candidate.result?.summary,
      remainingIssues: candidate.result?.remainingIssues,
      repositoryResults: candidate.result?.repositoryResults,
      verifiedCandidates: candidate.result?.verifiedCandidates,
      deliverableId: candidate.deliverableId,
      deliverableVersion: candidate.deliverableVersion,
      artifactRef: candidate.artifactRef,
    }));
  /** 返工带准确前次成果及失败证据引用，正文由工作工具按需读取。 */
  const previous = attempts.filter((candidate) => candidate.nodeId === node.id && candidate.attempt < attempt.attempt).sort((left, right) => right.attempt - left.attempt)[0];
  /** 当前节点只对自身分工交付负责，不能因尚未派发的后继工作缺成果而误报阻塞。 */
  const completionBoundary =
    '只根据当前节点的工作要求、完成标准和预期成果判断本分工是否完成。后继开发或验收尚未开始，不构成本节点受阻；不要把后继应完成的工作当成本节点尚未完成的问题。当前分工确实缺少必要资料、没有可行方案或无法完成时，仍须如实报告 blocked 或 failed，不能强行声明成功。';
  /** 现行只读分工通过结构化结果交付正文，正式文档由 Core 终态验真后保存。 */
  const readOnlyDelivery =
    run.definitionSnapshot.schemaGeneration === digitalTeamWorkflowSchemaGeneration && node.data.executionMode === 'read_only'
      ? '本次只读分工可在本轮最终说明中提供完整方案、分析结论和文档正文，并使用 submit_team_result 提交不超过 4000 字的摘要与真实结果。Core 会在准确轮次结束并核对结果后，采集本轮真实说明正文与结构化声明，冻结为正式成果并导出到任务 docs；不要求员工直接改写任务 README 或共享 docs 索引。没有代码修改能力不妨碍交付当前只读方案，也不要求在本节点完成后继开发或验收。'
      : '';
  /** 保留各冻结图原有提交入口，不改变旧规划工具与当前结果工具的范围。 */
  const action =
    node.data.purpose === 'plan' && run.definitionSnapshot.schemaGeneration !== digitalTeamWorkflowSchemaGeneration
      ? '请使用 zeus_work.submit_team_plan 提交计划，逐项覆盖 planningScope.existingWork；需要额外分工时，只能使用本次已授权成员，以新的 nodeId、employeeId 和可选 dependencyIds 指定。'
      : '请使用 zeus_work.submit_team_result 提交结构化结果；最终文字不会推进流程。上游资料先读目录和摘要，按需读取有界正文。测试发现正式阻塞缺陷时先用 zeus_work.inspect 查询当前真实命令证据身份，提交 outcome=failed、verification=failed，以及 defects 中稳定 key、title、description、reproductionEvidence、repositoryId、准确被测 headSha。开发自查局部修正留在本分工，不创建缺陷子任务。';
  return `${node.data.instructions}\n\n数字团队冻结上下文：\n${stableJson({ runId: run.id, nodeId: node.id, attempt: attempt.attempt, executionMode: node.data.executionMode, acceptanceCriteria: node.data.acceptanceCriteria, expectedDeliverables: node.data.expectedDeliverables, planningScope, authorizedMembers: node.data.purpose === 'plan' ? run.roleSnapshots.filter((member) => node.data.settings?.delegation?.employeeIds.includes(member.employeeId)).map((member) => ({ employeeId: member.employeeId, name: member.configuration.name, role: member.configuration.role })) : undefined, reworkReason, previousResult: previous ? { summary: previous.result?.summary, remainingIssues: previous.result?.remainingIssues, evidence: previous.result?.evidence, deliverableId: previous.deliverableId, artifactRef: previous.artifactRef } : undefined, taskFacts: run.taskFacts, plan: run.plan, baseRevisions: run.baseRevisions, candidateRevisions: run.candidateRevisions, verificationCommands: node.data.purpose === 'verify' ? node.data.verificationCommands : undefined, assignment, upstream })}\n\n${completionBoundary}\n${readOnlyDelivery}\n\n${action}`;
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
  const node = digitalTeamExecutionDefinition(run).nodes.find((candidate) => candidate.id === nodeId);
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

/** 改派权限取原冻结上限和本次请求的交集，员工默认不能扩大用户授权。 */
function restrictPermission(current: DigitalTeamRunRuntimeState['permissionMode'], requested: DigitalTeamRunRuntimeState['permissionMode']): DigitalTeamRunRuntimeState['permissionMode'] {
  if (current === 'read-only' || requested === 'read-only') return 'read-only';
  if (current === 'auto' || requested === 'auto') return 'auto';
  return current ?? requested;
}
