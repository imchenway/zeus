import { ConversationGoalRepository } from '@zeus/storage';
import { effectiveToolPermission, restrictToolPermission } from './conversationToolPolicy.js';
import { conversationCommandTypes, conversationInputSha256 } from './conversationCommandApplication.js';
import { EmployeeMemoryProposalRepository } from '@zeus/storage';
import { isProviderStopPendingTurn } from './codexProviderStopRecoveryApplication.js';
import { selectEmployeeMemories } from './employeeMemoryContext.js';
import type { TaskWorkToolPort } from './taskWorkDynamicTools.js';
import { captureTaskWorkEvidence, captureDeploymentCommands } from './taskWorkEvidenceCapture.js';
import { mergeEmployeeWorkSettings, type EmployeeWorkSettings, type EmployeeWorkStageInput, type EmployeeTeamRecipe } from '@zeus/shared';
import { LongTermMemoryRepository, TaskWorkReviewRepository, TaskWorkDeploymentRepository, TurnChangeSetRepository, ConversationProviderItemRepository, TaskWorkPlanningRepository } from '@zeus/storage';
import { createHash } from 'node:crypto';
import { attachDigitalTeamTaskPushPolicy } from './digitalTeamWorkflowExecutionPolicy.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  buildTaskPushLayout,
  type CommandDefinition,
  type CommandEnvelope,
  commandEnvelopeSchemaGeneration,
  commandParameterValueMatchesType,
  splitZeusSkillIds,
  type TaskPushMessageLayout,
  type TaskPushSupplementalAttachment,
} from '@zeus/shared';
import {
  type AgentEntrypointV2,
  ArtifactStore,
  CommandDefinitionRepository,
  CommandRunRepository,
  ConversationExecutionRepository,
  ConversationRepository,
  ConversationServerRequestRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  DigitalEmployeeExecutionRepository,
  type DigitalEmployeeRecord,
  DigitalEmployeeRepository,
  ProjectRepository,
  TaskEventRepository,
  TaskRepository,
  type TaskWorkDecisionRecord,
  TaskWorkDecisionRepository,
  taskWorkDeliverableArtifactGeneration,
  type TaskWorkDeliverableRecord,
  TaskWorkDeliverableRepository,
  type TaskWorkItemRecord,
  TaskWorkItemRepository,
  type TaskWorkRunRecord,
  TaskWorkRunRepository,
  TaskWorkStoreError,
  type TaskWorkWorkspaceSnapshot,
  type WorkContextManifestV1,
  type ZeusProjectRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { commandCenterCommandTypes, commandCenterInputSha256 } from './commandCenterCommandApplication.js';
import { conversationDispatchCommandTypes, conversationDispatchInputSha256 } from './conversationDispatchCommandApplication.js';
import type { ConversationCapabilityModel, ConversationCapabilityQueryApplication } from './conversationCapabilityQueryApplication.js';
import { conversationWorkExecutionState } from './conversationWorkExecutionState.js';
import { WorkManagementCommandApplication, workManagementInputSha256, workManagementCommandHttpError, workManagementCommandTypes, type WorkManagementMutationRequest } from './workManagementCommandApplication.js';
import type { ZeusPluginService } from './zeusPluginService.js';
import type { ZeusSkillService } from './zeusSkillService.js';

const previewTtlMs = 10 * 60 * 1_000;
const tickMs = 2_500;
const maximumSkillSnapshotFiles = 2_000;
const maximumSkillSnapshotBytes = 32 * 1024 * 1024;
const taskWorkSkillArtifactGeneration = '2026-08-29-task-work-skill-snapshot-v1';

export interface TaskWorkPreviewSelection {
  /** 已安排分工只启动原工作，不重复创建。 */
  plannedWorkItemId?: string;
  employeeId: string;
  supplementalInfo?: string | null;
  supplementalAttachments?: TaskWorkSupplementalAttachmentInput[];
  modelOverride?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  workMode?: 'default' | 'plan' | null;
  permissionMode?: 'read-only' | 'auto' | 'full-access' | null;
  promptOverride?: string | null;
  skillIds?: string[];
  selectedDeliverableIds?: string[];
  workspace?: TaskWorkWorkspaceChoice;
}

type TaskWorkSupplementalAttachmentInput = {
  taskPushAttachmentKey: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'file' | 'directory' | 'pasted_text';
  localPath?: string;
  uploadRef?: string;
};

export type TaskWorkWorkspaceChoice = { mode: 'create' } | { mode: 'direct' } | { mode: 'existing'; environmentId: string } | { mode: 'local'; branchName: string };

export interface TaskWorkPreview {
  previewSha256: string;
  expiresAt: string;
  expectedTaskRevision: string;
  expectedEmployeeRevision: number;
  selection: TaskWorkPreviewSelection;
  employee: { id: string; name: string; role: string; domain: string; revision: number };
  entrypoint: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  skills: Array<TaskWorkNativeSkillPreview | TaskWorkPluginSkillPreview>;
  authority: Record<string, unknown>;
  context: WorkContextManifestV1;
  workspace: TaskWorkWorkspaceSnapshot | null;
  promptPreview: TaskPushMessageLayout | null;
  command: null | {
    id: string;
    title: string;
    revision: number;
    parameters: Array<{ key: string; label: string; description: string; type: string; required: boolean; sensitive: boolean; hasValue: boolean }>;
    safeParameterSnapshot: Record<string, string | number | boolean>;
    parameterDigest: string;
    riskFlags: CommandDefinition['riskFlags'];
  };
  blockers: Array<{ code: string; message: string }>;
}

interface TaskWorkNativeSkillPreview {
  source: 'skill';
  id: string;
  name: string;
  description: string;
  directoryName: string;
  contentSha256: string;
  resourceCount: number;
  totalBytes: number;
}

interface TaskWorkPluginSkillPreview {
  source: 'plugin';
  id: string;
  name: string;
  description: string;
  pluginId: string;
  pluginRevisionId: string;
}

interface PreparedSkillResourceSnapshot {
  metadata: TaskWorkNativeSkillPreview;
  files: Array<{ path: string; sha256: string; bytes: number; contentBase64: string }>;
}

interface TaskWorkCreateInput {
  selection: TaskWorkPreviewSelection;
  previewSha256: string;
  expectedTaskRevision: string;
  expectedEmployeeRevision: number;
}

type TaskWorkCreateRequest = WorkManagementMutationRequest<TaskWorkCreateInput>;

interface TaskWorkActionInput {
  expectedRevision: number;
  reason?: string;
}

interface TaskWorkDecisionResolveInput {
  expectedRevision: number;
  responseSha256: string;
}

interface TaskWorkDecisionResolveRequest extends WorkManagementMutationRequest<TaskWorkDecisionResolveInput> {
  runtime: { response: Record<string, unknown> };
}

interface TaskWorkManagementOptions {
  /** 目标状态读取原会话投影，不另建后台循环。 */
  conversationGoals: ConversationGoalRepository;
  /** 员工建议与确认记忆分别保存。 */
  memoryProposals: EmployeeMemoryProposalRepository;
  server: FastifyInstance;
  apiToken: string;
  application: WorkManagementCommandApplication;
  projects: ProjectRepository;
  tasks: TaskRepository;
  employees: DigitalEmployeeRepository;
  legacyExecutions: DigitalEmployeeExecutionRepository;
  items: TaskWorkItemRepository;
  /** 阶段仅安排分工，执行仍由本控制器负责。 */
  planning: TaskWorkPlanningRepository;
  /** 审查意见与真实会话证据读取器。 */
  reviews: TaskWorkReviewRepository;
  /** 部署凭证只读原工作运行的实际命令来源。 */
  deployments: TaskWorkDeploymentRepository;
  /** 已治理的员工个人经验。 */
  memory: LongTermMemoryRepository;
  turnChanges: TurnChangeSetRepository;
  providerItems: ConversationProviderItemRepository;
  runs: TaskWorkRunRepository;
  deliverables: TaskWorkDeliverableRepository;
  decisions: TaskWorkDecisionRepository;
  conversations: ConversationRepository;
  conversationTurns: ConversationTurnRepository;
  conversationExecution: ConversationExecutionRepository;
  conversationRequests: ConversationServerRequestRepository;
  conversationSubmissions: ConversationSubmissionRepository;
  commandDefinitions: CommandDefinitionRepository;
  commandRuns: CommandRunRepository;
  artifacts: ArtifactStore;
  skillSnapshotRoot: string;
  skills: ZeusSkillService | null;
  plugins: Pick<ZeusPluginService, 'listSkills'> | null;
  conversationCapabilities: ConversationCapabilityQueryApplication;
  normalizeTaskPushSupplementalAttachments(value: unknown, projectLocalPath: string): { promptAttachments: TaskPushSupplementalAttachment[] };
  executeTaskConversationIdempotent(project: ZeusProjectRecord, task: ZeusTaskRecord, body: Record<string, unknown>, idempotencyKey: string): Promise<{ statusCode: number; body: unknown }>;
  isTaskTerminal(task: ZeusTaskRecord): boolean;
  taskEvents: TaskEventRepository;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): unknown;
  save(): Promise<void>;
  now(): Date;
  readOnlyValidation?: boolean;
}

export interface TaskWorkManagementController {
  /** 原生工具绑定本次工作的真实会话。 */
  workTools: TaskWorkToolPort;
  kick(): void;
  hasAutomationSource(sourceRef: string): boolean;
  /** 默认任务池不重复承接已有明确安排的完整任务。 */
  hasExistingTaskWork(taskId: string): boolean;
  /** 自动领取只绑定现行安排中的待领分工。 */
  claimPlannedWork(taskId: string, employeeId: string): boolean;
  createAutomatedWorkItem(input: { taskId: string; employeeId: string; sourceRef: string }): Promise<{ item: TaskWorkItemRecord; run: TaskWorkRunRecord }>;
  /** 数字团队按冻结节点创建工作项，旧自动调度器不会接管此来源。 */
  createWorkflowWorkItem(input: {
    taskId: string;
    employeeId: string;
    /** 创建运行时冻结的完整员工配置。 */
    employeeSnapshot: DigitalEmployeeRecord;
    sourceRef: string;
    title: string;
    /** 工作项列表展示的节点目标，不承载完整冻结上下文。 */
    description: string;
    /** 发给实际员工的完整冻结输入，独立保存在运行入口快照。 */
    supplementalInfo: string;
    workspace: TaskWorkWorkspaceChoice;
    purpose: 'plan' | 'work' | 'verify' | 'summary';
    executionMode: 'read_only' | 'isolated_write' | 'candidate_read_only';
  }): Promise<{ item: TaskWorkItemRecord; run: TaskWorkRunRecord }>;
  /** 数字团队显式派发已准备运行，并返回耐久会话与提交身份。 */
  dispatchWorkflowRun(runId: string): Promise<{ run: TaskWorkRunRecord; submissionId: string | null; turnId: string | null }>;
  /** CTO 汇总和员工返工继续原会话，并返回新的准确提交与轮次。 */
  continueWorkflowConversation(input: { taskId: string; conversationId: string; content: string; operationIdentity: string }): Promise<{ submissionId: string; turnId: string | null }>;
  /** 数字团队暂停或返工时停止准确工作项现场。 */
  stopWorkflowWorkItem(workItemId: string, operationIdentity: string): Promise<void>;
  /** 结构化结果验真后同步旧工作项投影，不从最终文字生成交付。 */
  settleWorkflowWorkItem(workRunId: string, outcome: 'succeeded' | 'failed', message?: string): void;
  /** 运行期绑定数字团队结构化工具，避免初始化循环依赖。 */
  bindDigitalTeamTools(tools: TaskWorkToolPort): void;
  close(): Promise<void>;
}

/** 任务阶段安排和独立指派统一进入工作记录，旧运行只保留原有收口路径。 */
export function registerTaskWorkManagement(options: TaskWorkManagementOptions): TaskWorkManagementController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let closed = false;
  /** 数字团队工具在两个协调器都完成构造后绑定。 */
  let digitalTeamTools: TaskWorkToolPort | null = null;

  const schedule = (delay = tickMs): void => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
    timer.unref?.();
  };
  const run = async (): Promise<void> => {
    if (closed || active) return;
    active = processRuns()
      .catch((error) => console.error('Task work management tick failed.', error))
      .finally(() => {
        active = null;
        schedule();
      });
    await active;
  };
  const kick = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
    schedule(0);
  };

  options.server.get('/api/tasks/:taskId/work-management', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    const task = requireTask(options, request.params.taskId, reply);
    if (!task) return;
    return workManagementProjection(options, task);
  });

  /** 阶段安排的读写仍使用工作管理命令身份，重复请求返回同一次接纳。 */
  options.server.get('/api/tasks/:taskId/work-plan', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) =>
    route(reply, async () => {
      requireTaskOrThrow(options, request.params.taskId);
      return options.planning.get(request.params.taskId);
    }),
  );
  if (!options.readOnlyValidation) {
    options.server.post(
      '/api/tasks/:taskId/work-plan',
      async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<{ expectedRevision: number | null; stages: EmployeeWorkStageInput[]; settings: EmployeeWorkSettings }> }>, reply) =>
        route(reply, async () => {
          const task = requireTaskOrThrow(options, request.params.taskId);
          if (options.isTaskTerminal(task)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_TASK_TERMINAL', '重新打开任务后才能安排工作。');
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.taskWorkPlanSave, scopeKind: 'task', expectedScopeId: () => task.id });
          const input = parsed.input as typeof request.body.input;
          const stages = normalizeWorkStages(input.stages);
          const settings = normalizeWorkSettings(input.settings);
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-planning-repository',
            resourceId: `task:${task.id}`,
            mutateBusinessState: () => options.planning.save(task.id, input.expectedRevision, stages, settings),
          });
          await options.save();
          kick();
          return result.result;
        }),
    );
    options.server.post(
      '/api/tasks/:taskId/work-plan/control',
      async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<{ expectedRevision: number; state: 'running' | 'paused' | 'cancelled' }> }>, reply) =>
        route(reply, async () => {
          const task = requireTaskOrThrow(options, request.params.taskId);
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.taskWorkPlanControl, scopeKind: 'task', expectedScopeId: () => task.id });
          const input = parsed.input as typeof request.body.input;
          if (!['running', 'paused', 'cancelled'].includes(input.state) || (options.isTaskTerminal(task) && input.state === 'running')) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '当前任务不能执行该安排操作。', 400);
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-planning-repository',
            resourceId: `task:${task.id}`,
            mutateBusinessState: () => {
              const plan = options.planning.control(task.id, input.expectedRevision, input.state);
              for (const stage of plan.stages)
                for (const item of stage.items) {
                  if (input.state === 'running' && item.arrangement?.blockedReason && !item.currentRunId) options.planning.updateArrangement(item, { ...item.arrangement, blockedReason: undefined });
                  // 停止外部运行由耐久调度继续处理，状态提交不能伪称 Provider 已停止。
                }
              return options.planning.get(task.id);
            },
          });
          await options.save();
          kick();
          return result.result;
        }),
    );
    options.server.post(
      '/api/tasks/:taskId/work-items/:workItemId/assign',
      async (request: FastifyRequest<{ Params: { taskId: string; workItemId: string }; Body: WorkManagementMutationRequest<{ expectedRevision: number; employeeId: string }> }>, reply) =>
        route(reply, async () => {
          const task = requireTaskOrThrow(options, request.params.taskId);
          const item = options.items.getById(request.params.workItemId);
          if (!item || item.taskId !== task.id || options.isTaskTerminal(task)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ITEM_NOT_FOUND', '当前任务没有可调整的这份工作。', 404);
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.taskWorkItemAssign, scopeKind: 'task', expectedScopeId: () => task.id });
          const input = parsed.input as typeof request.body.input;
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-planning-repository',
            resourceId: `task_work_item:${item.id}`,
            mutateBusinessState: () => options.planning.assign(item.id, input.expectedRevision, requiredText(input.employeeId, '请选择执行人。', 256)),
          });
          await options.save();
          kick();
          return result.result;
        }),
    );
  }
  if (!options.readOnlyValidation)
    options.server.post(
      '/api/tasks/:taskId/work-items/:workItemId/settings',
      async (request: FastifyRequest<{ Params: { taskId: string; workItemId: string }; Body: WorkManagementMutationRequest<{ expectedRevision: number; settings: EmployeeWorkSettings }> }>, reply) =>
        route(reply, async () => {
          /** 已经启动的运行快照保持不变，只调整尚未开始的分工。 */
          const item = requireOwnedItem(options, request.params.taskId, request.params.workItemId);
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.taskWorkSettingsUpdate, scopeKind: 'task', expectedScopeId: () => item.taskId });
          const input = parsed.input as typeof request.body.input;
          const settings = normalizeWorkSettings(input.settings);
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-planning-repository',
            resourceId: `task_work_item:${item.id}`,
            mutateBusinessState: () => {
              const current = options.items.getById(item.id);
              const plan = options.planning.get(item.taskId);
              if (
                !current?.arrangement ||
                current.currentRunId ||
                current.status !== 'queued' ||
                current.revision !== input.expectedRevision ||
                !plan ||
                ['cancelled', 'completed'].includes(plan.state) ||
                options.isTaskTerminal(requireTaskOrThrow(options, item.taskId))
              )
                throw new TaskWorkStoreError('ZEUS_TASK_WORK_ASSIGNMENT_CONFLICT', '该分工已开始执行或发生变化，请重新读取。');
              options.planning.updateArrangement(current, { ...current.arrangement, settings, blockedReason: undefined });
              return options.items.getById(current.id)!;
            },
          });
          await options.save();
          kick();
          return result.result;
        }),
    );
  options.server.get('/api/projects/:projectId/digital-employees/:employeeId/memory-proposals', async (request: FastifyRequest<{ Params: { projectId: string; employeeId: string } }>, reply) =>
    route(reply, async () => {
      requireEmployeeOrThrow(options, request.params.projectId, request.params.employeeId);
      return options.memoryProposals.list(request.params.projectId, request.params.employeeId);
    }),
  );
  if (!options.readOnlyValidation)
    options.server.post(
      '/api/projects/:projectId/digital-employees/:employeeId/memory-proposals/:proposalId',
      async (
        request: FastifyRequest<{
          Params: { projectId: string; employeeId: string; proposalId: string };
          Body: WorkManagementMutationRequest<{ expectedRevision: number; accept: boolean; topic: string; content: string; reviewAfter: string }>;
        }>,
        reply,
      ) =>
        route(reply, async () => {
          const employee = requireEmployeeOrThrow(options, request.params.projectId, request.params.employeeId);
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.employeeMemoryDecide, scopeKind: 'project', expectedScopeId: () => employee.projectId });
          const input = parsed.input as typeof request.body.input;
          if (typeof input.accept !== 'boolean') throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_INVALID', '请选择接纳或拒绝建议。', 400);
          if (input.accept) {
            requiredText(input.topic, '请填写经验主题。', 160);
            requiredText(input.content, '请填写经验正文。', 8000);
            if (typeof input.reviewAfter !== 'string' || !Number.isFinite(Date.parse(input.reviewAfter)) || Date.parse(input.reviewAfter) <= options.now().getTime())
              throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_INVALID', '请选择未来的复核日期。', 400);
          }
          const result = options.application.executeCore({
            parsed,
            destinationId: 'employee-memory-proposal-repository',
            resourceId: `employee_memory_proposal:${request.params.proposalId}`,
            mutateBusinessState: () => options.memoryProposals.decide(employee.projectId, employee.id, request.params.proposalId, input),
          });
          await options.save();
          return result.result;
        }),
    );
  options.server.get('/api/projects/:projectId/employee-team-recipes', async (request: FastifyRequest<{ Params: { projectId: string } }>) => options.planning.listRecipes(request.params.projectId));
  if (!options.readOnlyValidation)
    options.server.post('/api/projects/:projectId/employee-team-recipes', async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<EmployeeTeamRecipe> }>, reply) =>
      route(reply, async () => {
        const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.employeeTeamRecipeSave, scopeKind: 'project', expectedScopeId: () => request.params.projectId });
        const input = parsed.input as EmployeeTeamRecipe;
        if (input.projectId !== request.params.projectId || !options.projects.getById(input.projectId)) throw new TaskWorkStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
        const result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-planning-repository',
          resourceId: `employee_team_recipe:${input.id}`,
          mutateBusinessState: () => options.planning.saveRecipe({ ...input, stages: normalizeWorkStages(input.stages) }),
        });
        await options.save();
        return result.result;
      }),
    );

  /** 审查只引用当前任务内固定成果。 */
  options.server.get('/api/tasks/:taskId/work-deliverables/:deliverableId/reviews', async (request: FastifyRequest<{ Params: { taskId: string; deliverableId: string } }>, reply) =>
    route(reply, async () => {
      const deliverable = requireOwnedDeliverable(options, request.params.taskId, request.params.deliverableId);
      return options.reviews.list(deliverable.id);
    }),
  );
  if (!options.readOnlyValidation) {
    options.server.post(
      '/api/tasks/:taskId/work-deliverables/:deliverableId/reviews',
      async (request: FastifyRequest<{ Params: { taskId: string; deliverableId: string }; Body: WorkManagementMutationRequest<{ contentSha256: string; anchor: string; content: string; blocking: boolean }> }>, reply) =>
        route(reply, async () => {
          const task = requireTaskOrThrow(options, request.params.taskId);
          if (options.isTaskTerminal(task)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_TASK_TERMINAL', '终态任务不能追加审查。');
          const deliverable = requireOwnedDeliverable(options, task.id, request.params.deliverableId);
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.taskWorkReviewAdd, scopeKind: 'task', expectedScopeId: () => task.id });
          const input = parsed.input as typeof request.body.input;
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-review-repository',
            resourceId: `task_work_deliverable:${deliverable.id}`,
            mutateBusinessState: () => options.reviews.add(deliverable.id, input.contentSha256, input),
          });
          await options.save();
          return result.result;
        }),
    );
    options.server.post(
      '/api/tasks/:taskId/work-deliverables/:deliverableId/reviews/:noteId',
      async (request: FastifyRequest<{ Params: { taskId: string; deliverableId: string; noteId: string }; Body: WorkManagementMutationRequest<{ expectedRevision: number; resolved: boolean }> }>, reply) =>
        route(reply, async () => {
          const task = requireTaskOrThrow(options, request.params.taskId);
          if (options.isTaskTerminal(task)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_TASK_TERMINAL', '终态任务不能更改审查。');
          const deliverable = requireOwnedDeliverable(options, task.id, request.params.deliverableId);
          const parsed = options.application.parse({ value: request.body, commandType: workManagementCommandTypes.taskWorkReviewResolve, scopeKind: 'task', expectedScopeId: () => task.id });
          const input = parsed.input as typeof request.body.input;
          if (typeof input.resolved !== 'boolean') throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_INVALID', '审查处理状态无效。', 400);
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-review-repository',
            resourceId: `task_work_review:${request.params.noteId}`,
            mutateBusinessState: () => options.reviews.resolve(deliverable.id, request.params.noteId, input.expectedRevision, input.resolved),
          });
          await options.save();
          return result.result;
        }),
    );
  }

  options.server.get('/api/tasks/:taskId/work-deliverables/:deliverableId/content', async (request: FastifyRequest<{ Params: { taskId: string; deliverableId: string } }>, reply) =>
    route(reply, async () => {
      requireTaskOrThrow(options, request.params.taskId);
      const deliverable = requireOwnedDeliverable(options, request.params.taskId, request.params.deliverableId);
      const stored = await options.artifacts.readAuthorized({ sha256: deliverable.artifactSha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, maximumContentBytes: 16 * 1024 * 1024 });
      const content = Buffer.from(stored.bytes).toString('utf8');
      if (sha256(content) !== deliverable.contentSha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELIVERABLE_CORRUPT', '交付物正文完整性校验失败。');
      return { deliverableId: deliverable.id, version: deliverable.version, contentSha256: deliverable.contentSha256, content };
    }),
  );

  if (!options.readOnlyValidation)
    options.server.post('/api/tasks/:taskId/work-item-previews', async (request: FastifyRequest<{ Params: { taskId: string }; Body: TaskWorkPreviewSelection }>, reply) =>
      route(reply, async () => {
        const task = requireTaskOrThrow(options, request.params.taskId);
        const selection = normalizeSelection(request.body);
        return resolvePreview(options, task, selection);
      }),
    );

  if (!options.readOnlyValidation)
    options.server.post('/api/tasks/:taskId/work-items', async (request: FastifyRequest<{ Params: { taskId: string }; Body: TaskWorkCreateRequest }>, reply) =>
      route(reply, async () => {
        const task = requireTaskOrThrow(options, request.params.taskId);
        const parsed = options.application.parse<TaskWorkCreateInput>({
          value: { command: request.body?.command, input: request.body?.input },
          commandType: workManagementCommandTypes.taskWorkItemCreate,
          scopeKind: 'task',
          expectedScopeId: () => task.id,
        });
        if (parsed.input.selection.plannedWorkItemId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_START_REQUIRED', '请从工作安排启动或继续执行，已有分工不会重复创建。');
        const preview = await resolvePreview(options, task, normalizeSelection(parsed.input.selection));
        assertPreviewFresh(preview, parsed.input);
        const employee = requireEmployeeOrThrow(options, task.projectId, preview.employee.id);
        const skillResources = await prepareSkillResourceSnapshots(options, task, preview);
        const created = options.application.executeCore({
          parsed,
          destinationId: 'task-work-item-repository',
          resourceId: `task_work_item:${parsed.operationIdentity}`,
          mutateBusinessState: () => createWorkItemFromPreview(options, task, employee, preview, parsed.operationIdentity, { source: 'manual', sourceRef: `manual:${parsed.operationIdentity}` }, skillResources),
        });
        await options.save();
        const currentItem = options.items.getById(created.result.item.id) ?? created.result.item;
        const currentRun = options.runs.getById(created.result.run.id) ?? created.result.run;
        publishChanged(options, task.id, currentItem.id, 'created');
        kick();
        return reply.code(202).send({ item: currentItem, run: currentRun, replayed: created.replayed });
      }),
    );

  if (!options.readOnlyValidation)
    options.server.post('/api/tasks/:taskId/work-deliverables/:deliverableId/accept', async (request: FastifyRequest<{ Params: { taskId: string; deliverableId: string }; Body: WorkManagementMutationRequest<TaskWorkActionInput> }>, reply) =>
      route(reply, async () => {
        const task = requireTaskOrThrow(options, request.params.taskId);
        const deliverable = requireOwnedDeliverable(options, task.id, request.params.deliverableId);
        const parsed = options.application.parse<TaskWorkActionInput>({ value: request.body, commandType: workManagementCommandTypes.taskWorkDeliverableAccept, scopeKind: 'task', expectedScopeId: () => task.id });
        const result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-deliverable-repository',
          resourceId: `task_work_deliverable:${deliverable.id}`,
          mutateBusinessState: () => acceptDeliverable(options, deliverable, parsed.input.expectedRevision),
        });
        await options.save();
        publishChanged(options, task.id, deliverable.workItemId, 'deliverable_accepted');
        return result.result;
      }),
    );

  if (!options.readOnlyValidation)
    options.server.post(
      '/api/tasks/:taskId/work-deliverables/:deliverableId/request-changes',
      async (request: FastifyRequest<{ Params: { taskId: string; deliverableId: string }; Body: WorkManagementMutationRequest<TaskWorkActionInput> }>, reply) =>
        route(reply, async () => {
          const task = requireTaskOrThrow(options, request.params.taskId);
          const deliverable = requireOwnedDeliverable(options, task.id, request.params.deliverableId);
          const parsed = options.application.parse<TaskWorkActionInput>({ value: request.body, commandType: workManagementCommandTypes.taskWorkDeliverableRequestChanges, scopeKind: 'task', expectedScopeId: () => task.id });
          const reason = requiredText(parsed.input.reason, '请说明需要修改的内容。', 4_000);
          const result = options.application.executeCore({
            parsed,
            destinationId: 'task-work-deliverable-repository',
            resourceId: `task_work_deliverable:${deliverable.id}`,
            mutateBusinessState: () => requestDeliverableChanges(options, deliverable, parsed.input.expectedRevision, reason),
          });
          await options.save();
          publishChanged(options, task.id, deliverable.workItemId, 'changes_requested');
          kick();
          return reply.code(202).send(result.result);
        }),
    );

  if (!options.readOnlyValidation)
    options.server.post('/api/tasks/:taskId/work-items/:workItemId/retry', async (request: FastifyRequest<{ Params: { taskId: string; workItemId: string }; Body: WorkManagementMutationRequest<TaskWorkActionInput> }>, reply) =>
      route(reply, async () => {
        const item = requireOwnedItem(options, request.params.taskId, request.params.workItemId);
        const parsed = options.application.parse<TaskWorkActionInput>({ value: request.body, commandType: workManagementCommandTypes.taskWorkItemRetry, scopeKind: 'task', expectedScopeId: () => item.taskId });
        const result = options.application.executeCore({ parsed, destinationId: 'task-work-item-repository', resourceId: `task_work_item:${item.id}`, mutateBusinessState: () => retryWorkItem(options, item, parsed.input.expectedRevision) });
        await options.save();
        publishChanged(options, item.taskId, item.id, 'retried');
        kick();
        return reply.code(202).send(result.result);
      }),
    );

  if (!options.readOnlyValidation)
    options.server.post('/api/tasks/:taskId/work-items/:workItemId/cancel', async (request: FastifyRequest<{ Params: { taskId: string; workItemId: string }; Body: WorkManagementMutationRequest<TaskWorkActionInput> }>, reply) =>
      route(reply, async () => {
        const item = requireOwnedItem(options, request.params.taskId, request.params.workItemId);
        const parsed = options.application.parse<TaskWorkActionInput>({ value: request.body, commandType: workManagementCommandTypes.taskWorkItemCancel, scopeKind: 'task', expectedScopeId: () => item.taskId });
        const stopping = item.arrangement && item.status !== 'cancelled' ? options.planning.requestCancellation(item.id, parsed.input.expectedRevision) : item;
        await options.save();
        await stopWorkItemRuntime(options, stopping, `cancel:${parsed.operationIdentity}:${item.id}`);
        const result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-item-repository',
          resourceId: `task_work_item:${item.id}`,
          mutateBusinessState: () => cancelWorkItem(options, stopping, stopping.revision),
        });
        await options.save();
        publishChanged(options, item.taskId, item.id, 'cancelled');
        return result.result;
      }),
    );

  if (!options.readOnlyValidation)
    options.server.post('/api/tasks/:taskId/work-decisions/:decisionId/resolve', async (request: FastifyRequest<{ Params: { taskId: string; decisionId: string }; Body: TaskWorkDecisionResolveRequest }>, reply) =>
      route(reply, async () => {
        const decision = requireOwnedDecision(options, request.params.taskId, request.params.decisionId);
        const parsed = options.application.parse<TaskWorkDecisionResolveInput>({
          value: { command: request.body?.command, input: request.body?.input },
          commandType: workManagementCommandTypes.taskWorkDecisionResolve,
          scopeKind: 'task',
          expectedScopeId: () => decision.taskId,
        });
        const response = request.body?.runtime?.response;
        if (!isRecord(response) || sha256(canonicalJson(response)) !== parsed.input.responseSha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DECISION_RESPONSE_INVALID', '待办回复摘要与本次输入不一致。', 400);
        if (decision.kind === 'input_required' || decision.kind === 'authorization') {
          throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONVERSATION_REQUEST_SUPERSEDED', '该历史待办已由原任务会话接管，请在会话中处理。', 409);
        } else if (decision.kind === 'command_confirmation') {
          await confirmAutomatedCommand(options, decision, response);
        } else if (decision.kind !== 'outcome_unknown' && decision.kind !== 'command_failure') {
          throw new TaskWorkStoreError('ZEUS_TASK_WORK_DECISION_KIND_INVALID', '该待办必须通过交付物验收动作处置。');
        }
        const result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-decision-repository',
          resourceId: `task_work_decision:${decision.id}`,
          mutateBusinessState: () => resolveManagerDecision(options, decision, parsed.input.expectedRevision, response),
        });
        await options.save();
        publishChanged(options, decision.taskId, decision.workItemId, 'decision_resolved');
        kick();
        return reply.code(202).send(result.result);
      }),
    );

  if (!options.readOnlyValidation) schedule();
  return {
    workTools: { invoke: invokeWorkTool },
    kick,
    claimPlannedWork: (taskId, employeeId) => {
      const plan = options.planning.get(taskId);
      if (!plan) return false;
      if (plan.state !== 'running' || !options.tasks.getById(taskId) || options.isTaskTerminal(options.tasks.getById(taskId)!)) return true;
      const employee = options.employees.getById(employeeId);
      if (!employee?.enabled || employee.projectId !== options.tasks.getById(taskId)?.projectId) return true;
      const stage = plan.stages.find((candidate) => !['accepted', 'skipped'].includes(candidate.status));
      for (const item of stage?.items ?? [])
        if (!item.employeeId && !item.currentRunId && item.status === 'queued' && (!item.arrangement?.role || employee.role.includes(item.arrangement.role) || employee.domain.includes(item.arrangement.role)))
          options.planning.assign(item.id, item.revision, employee.id);
      kick();
      return true;
    },
    hasExistingTaskWork: (taskId) => options.items.listByTask(taskId).some((item) => !item.arrangement && item.status !== 'cancelled'),
    hasAutomationSource: (sourceRef) => Boolean(options.items.getBySource('automation', sourceRef)),
    createAutomatedWorkItem: async ({ taskId, employeeId, sourceRef }) => {
      const replay = options.items.getBySource('automation', sourceRef);
      if (replay?.currentRunId) {
        const run = options.runs.getById(replay.currentRunId);
        if (run) return { item: replay, run };
      }
      const task = requireTaskOrThrow(options, taskId);
      const employee = requireEmployeeOrThrow(options, task.projectId, employeeId);
      const preview = await resolvePreview(options, task, { employeeId, workspace: { mode: 'create' } });
      const blockers = preview.blockers;
      if (blockers.length > 0) throw new TaskWorkStoreError(blockers[0]!.code, blockers[0]!.message);
      const skillResources = await prepareSkillResourceSnapshots(options, task, preview);
      const created = createWorkItemFromPreview(options, task, employee, preview, stableIdentity('task_work_item', sourceRef), { source: 'automation', sourceRef }, skillResources);
      await options.save();
      publishChanged(options, task.id, created.item.id, 'automation_created');
      kick();
      return created;
    },
    createWorkflowWorkItem: async ({ taskId, employeeId, employeeSnapshot, sourceRef, title, description, supplementalInfo, workspace, purpose, executionMode }) => {
      const replay = options.items.getBySource('manual', sourceRef);
      if (replay?.currentRunId) {
        const run = options.runs.getById(replay.currentRunId);
        if (run) return { item: replay, run };
      }
      const task = requireTaskOrThrow(options, taskId);
      if (employeeSnapshot.id !== employeeId || employeeSnapshot.projectId !== task.projectId) throw new TaskWorkStoreError('ZEUS_DIGITAL_TEAM_EMPLOYEE_SNAPSHOT_INVALID', '冻结员工配置与当前节点不一致。');
      const employee = structuredClone(employeeSnapshot);
      const preview = await resolvePreview(options, task, { employeeId, supplementalInfo, workspace }, employee);
      if (preview.blockers.length > 0) throw new TaskWorkStoreError(preview.blockers[0]!.code, preview.blockers[0]!.message);
      /** 节点职责随真实 TaskWorkRun 冻结，Provider 权限只能由服务端读取该字段。 */
      preview.entrypoint = { ...(preview.entrypoint ?? {}), digitalTeamPurpose: purpose, digitalTeamExecutionMode: executionMode };
      /** 角色顶层授权和 Agent 策略取交集；验证可运行测试，但始终不能改代码或提交。 */
      preview.authority = {
        ...preview.authority,
        allowCodeChanges: preview.authority.allowCodeChanges === true && employee.allowCodeChanges,
        allowTests: preview.authority.allowTests === true && employee.allowTests,
        allowCommit: preview.authority.allowCommit === true && employee.deliveryGrants.allowCommit,
      };
      if (purpose !== 'work') {
        preview.authority = {
          ...preview.authority,
          permissionMode: purpose === 'verify' ? preview.authority.permissionMode : 'read-only',
          allowCodeChanges: false,
          allowTests: purpose === 'verify' && preview.authority.allowTests === true,
          allowCommit: false,
        };
      }
      const skillResources = await prepareSkillResourceSnapshots(options, task, preview);
      const itemId = stableIdentity('task_work_item', sourceRef);
      const created = createWorkItemFromPreview(options, task, employee, preview, itemId, { source: 'manual', sourceRef, title, description }, skillResources);
      await options.save();
      publishChanged(options, task.id, created.item.id, 'workflow_created');
      return created;
    },
    dispatchWorkflowRun: async (runId) => {
      const run = options.runs.getById(runId);
      const item = run ? options.items.getById(run.workItemId) : undefined;
      if (!run || !item || !isDigitalTeamWorkItem(item)) throw new TaskWorkStoreError('ZEUS_DIGITAL_TEAM_WORK_RUN_NOT_FOUND', '数字团队工作运行不存在。', 404);
      if (run.status === 'prepared') options.runs.update(run.id, { status: 'dispatching', startedAt: options.now().toISOString() });
      const dispatched = await dispatchAgent(options, options.runs.getById(run.id)!, false);
      const currentItem = options.items.getById(item.id);
      if (currentItem?.status === 'queued') options.items.update(currentItem.id, { status: 'active' });
      const submission = dispatched.run.conversationId ? options.conversationSubmissions.listByConversation(dispatched.run.conversationId).find((candidate) => candidate.id === dispatched.submissionId) : undefined;
      const turn = submission && dispatched.run.conversationId ? options.conversationTurns.listByConversation(dispatched.run.conversationId).find((candidate) => candidate.clientSubmissionId === submission.id) : undefined;
      return { run: dispatched.run, submissionId: submission?.id ?? null, turnId: turn?.id ?? null };
    },
    continueWorkflowConversation: async ({ taskId, conversationId, content, operationIdentity }) => {
      const task = requireTaskOrThrow(options, taskId);
      const project = options.projects.getById(task.projectId);
      const conversation = options.conversations.getById(conversationId);
      if (!project || !conversation || conversation.taskId !== task.id || conversation.projectId !== project.id) {
        throw new TaskWorkStoreError('ZEUS_DIGITAL_TEAM_CONVERSATION_NOT_FOUND', '数字团队原会话不存在或不属于当前任务。', 404);
      }
      const accepted = await options.executeTaskConversationIdempotent(project, task, { mode: 'resume', conversationId, content }, operationIdentity);
      const response = isRecord(accepted.body) ? accepted.body : {};
      const submissionProjection = isRecord(response.submission) ? response.submission : {};
      const submissionId = typeof submissionProjection.id === 'string' ? submissionProjection.id : null;
      if (!submissionId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ACCEPTANCE_NOT_DURABLE', '继续会话没有返回耐久提交身份。');
      const turn = options.conversationTurns.listByConversation(conversationId).find((candidate) => candidate.clientSubmissionId === submissionId);
      return { submissionId, turnId: turn?.id ?? null };
    },
    stopWorkflowWorkItem: async (workItemId, operationIdentity) => {
      const item = options.items.getById(workItemId);
      if (!item || !isDigitalTeamWorkItem(item)) throw new TaskWorkStoreError('ZEUS_DIGITAL_TEAM_WORK_ITEM_NOT_FOUND', '数字团队工作项不存在。', 404);
      await stopWorkItemRuntime(options, item, operationIdentity);
    },
    settleWorkflowWorkItem: (workRunId, outcome, message) => {
      const run = options.runs.getById(workRunId);
      const item = run ? options.items.getById(run.workItemId) : undefined;
      if (!run || !item || !isDigitalTeamWorkItem(item)) throw new TaskWorkStoreError('ZEUS_DIGITAL_TEAM_WORK_RUN_NOT_FOUND', '数字团队工作运行不存在。', 404);
      const completedAt = options.now().toISOString();
      if (!['succeeded', 'failed'].includes(run.status))
        options.runs.update(run.id, { status: outcome, completedAt, ...(outcome === 'failed' ? { errorCode: 'ZEUS_DIGITAL_TEAM_RESULT_FAILED', errorMessage: message ?? '数字团队节点结果未通过验真。' } : {}) });
      const currentItem = options.items.getById(item.id)!;
      if (currentItem.status === 'queued') options.items.update(currentItem.id, { status: 'active' });
      const activeItem = options.items.getById(item.id)!;
      if (!['completed', 'failed', 'cancelled'].includes(activeItem.status)) options.items.update(activeItem.id, { status: outcome === 'succeeded' ? 'completed' : 'failed', completedAt });
    },
    bindDigitalTeamTools: (tools) => {
      digitalTeamTools = tools;
    },
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active) await active;
    },
  };

  /** 模型工具只在原生轮次绑定的工作内生效，调用方不能传入其他任务身份。 */
  async function invokeWorkTool(call: Parameters<TaskWorkToolPort['invoke']>[0]): ReturnType<TaskWorkToolPort['invoke']> {
    try {
      /** 结构化计划与结果只由数字团队 attempt 账本判定归属。 */
      if (call.tool === 'submit_team_plan' || call.tool === 'submit_team_result') {
        if (!digitalTeamTools) throw new TaskWorkStoreError('ZEUS_DIGITAL_TEAM_TOOL_UNAVAILABLE', '数字团队协调器尚未就绪。');
        return digitalTeamTools.invoke(call);
      }
      /** 从原会话及轮次核对工具来源。 */
      const conversation = options.conversations.getRecordById(call.conversationId);
      const turn = options.conversationTurns.listByConversation(call.conversationId).find((candidate) => candidate.providerThreadId === call.threadId && candidate.providerTurnId === call.turnId);
      if (!conversation?.taskId || !turn || conversation.providerThreadId !== call.threadId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_TOOL_SCOPE', '当前会话没有可核对的任务工作轮次。');
      const run = options.runs.listByTask(conversation.taskId).find((candidate) => candidate.conversationId === call.conversationId);
      const item = run ? options.items.getById(run.workItemId) : null;
      if (!run && ['inspect', 'assign'].includes(call.tool)) {
        const result = await invokeDiscussionWorkTool(call, conversation.taskId, turn.id, turn.clientSubmissionId);
        return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
      }
      if (!run || !item || item.currentRunId !== run.id) throw new TaskWorkStoreError('ZEUS_TASK_WORK_TOOL_SCOPE', '该会话不是当前工作运行。');
      /** 权限来自启动时冻结的安排，员工默认不能扩大本轮委派范围。 */
      const policy = normalizeWorkSettings({ ...(run.entrypointSnapshot.delegationPolicy ? { delegation: run.entrypointSnapshot.delegationPolicy } : {}) }).delegation;
      let result: unknown;
      if (call.tool === 'inspect') {
        result = {
          work: { id: item.id, title: item.title, description: item.description, status: item.status },
          planState: options.planning.get(item.taskId)?.state ?? null,
          delegation: policy ?? null,
          commands: options.providerItems
            .listByConversation(call.conversationId)
            .filter((record) => record.itemType === 'commandExecution')
            .map((record) => ({ id: record.id, status: record.status, completedAt: record.completedAt, summary: record.textContent.slice(0, 500) })),
          deployments: options.deployments.list(run.id).map((receipt) => ({ id: receipt.id, environment: receipt.environment, revision: receipt.revision, outcome: receipt.outcome, contentSha256: receipt.contentSha256 })),
          members: (policy?.employeeIds ?? [])
            .map((id) => options.employees.getById(id))
            .filter(Boolean)
            .map((employee) => ({ id: employee!.id, name: employee!.name, role: employee!.role, enabled: employee!.enabled })),
          children: options.items
            .listByTask(item.taskId)
            .filter((candidate) => candidate.arrangement?.parentWorkItemId === item.id)
            .map((child) => ({
              id: child.id,
              title: child.title,
              status: child.status,
              employeeId: child.employeeId,
              dependencies: child.arrangement?.dependencyIds,
              reason: child.arrangement?.blockedReason,
              deliverables: options.deliverables
                .listAcceptedByTask(item.taskId)
                .filter((deliverable) => deliverable.workItemId === child.id)
                .map((deliverable) => ({ id: deliverable.id, summary: deliverable.summary, contentSha256: deliverable.contentSha256 })),
            })),
        };
      } else if (call.tool === 'record_deployment') {
        /** 凭证保存不执行部署；实际外部操作继续遵守原运行权限。 */
        const input = {
          environment: requiredText(call.arguments.environment, '请说明实际部署环境。', 240),
          revision: requiredText(call.arguments.revision, '请提供实际代码或产物修订。', 240),
          url: requiredText(call.arguments.url, '请提供应用或部署记录地址。', 2000),
          outcome: optionalMember(call.arguments.outcome, ['succeeded', 'failed', 'unknown'] as const, '部署结果无效。')!,
          summary: requiredText(call.arguments.summary, '请说明结果与待核对事项。', 4000),
          deploymentCommandId: requiredText(call.arguments.deploymentCommandId, '请选择部署命令来源。', 256),
          verificationCommandId: optionalText(call.arguments.verificationCommandId, 256) ?? undefined,
        };
        if (!input.outcome || !/^https?:\/\//u.test(input.url)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_INVALID', '请提供明确结果和 HTTP 或 HTTPS 部署地址。', 400);
        /** 拒绝在地址内夹带凭据，展示只允许普通网页地址。 */
        const url = new URL(input.url);
        if (url.username || url.password) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_INVALID', '部署地址不能包含账户凭据。', 400);
        const identity = sha256([call.conversationId, call.threadId, call.turnId, call.callId].join('\0'));
        const parsed = options.application.parse({
          value: commandEnvelope(workManagementCommandTypes.taskWorkDeploymentRecord, 'task', item.taskId, identity, input, workManagementInputSha256(input)),
          commandType: workManagementCommandTypes.taskWorkDeploymentRecord,
          scopeKind: 'task',
          expectedScopeId: () => item.taskId,
        });
        result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-deployment-repository',
          resourceId: `task_work_run:${run.id}`,
          mutateBusinessState: () => {
            assertCurrentWorkToolTurn(options, call.conversationId, turn.id);
            if (options.readOnlyValidation || options.isTaskTerminal(requireTaskOrThrow(options, item.taskId))) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DEPLOYMENT_CLOSED', '任务已结束或处于只读检查。');
            const commands = captureDeploymentCommands(run, options.providerItems, input);
            return options.deployments.record({ environment: input.environment, revision: input.revision, url: input.url, outcome: input.outcome, summary: input.summary, id: identity, runId: run.id, commands });
          },
        }).result;
        await options.save();
        publishChanged(options, item.taskId, item.id, 'deployment_recorded');
      } else if (call.tool === 'propose_memory') {
        if (options.readOnlyValidation || !['active', 'waiting_input'].includes(run.status) || options.isTaskTerminal(requireTaskOrThrow(options, item.taskId)))
          throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_CLOSED', '当前工作已经结束，不能新增经验建议。');
        const input = {
          topic: requiredText(call.arguments.topic, '请填写经验主题。', 160),
          kind: optionalMember(call.arguments.kind, ['domain_knowledge', 'stable_workflow', 'preference'] as const, '请选择可复用经验类别。')!,
          content: requiredText(call.arguments.content, '请填写可复用经验。', 8_000),
          reason: requiredText(call.arguments.reason, '请说明依据、适用范围与例外。', 2_000),
        };
        if (!input.kind) throw new TaskWorkStoreError('ZEUS_EMPLOYEE_MEMORY_PROPOSAL_INVALID', '经验类别不能为空。', 400);
        const identity = sha256([call.conversationId, call.threadId, call.turnId, call.callId].join('\0'));
        const parsed = options.application.parse({
          value: commandEnvelope(workManagementCommandTypes.employeeMemoryPropose, 'task', item.taskId, identity, input, workManagementInputSha256(input)),
          commandType: workManagementCommandTypes.employeeMemoryPropose,
          scopeKind: 'task',
          expectedScopeId: () => item.taskId,
        });
        result = options.application.executeCore({
          parsed,
          destinationId: 'employee-memory-proposal-repository',
          resourceId: `employee_memory_proposal:${identity}`,
          mutateBusinessState: () => {
            assertCurrentWorkToolTurn(options, call.conversationId, turn.id);
            return options.memoryProposals.propose({ ...input, id: identity, projectId: item.projectId, employeeId: run.employeeId, taskId: item.taskId, runId: run.id });
          },
        }).result;
        await options.save();
      } else if (call.tool === 'delegate') {
        if (options.readOnlyValidation || !policy || !['active', 'waiting_input'].includes(run.status) || options.isTaskTerminal(requireTaskOrThrow(options, item.taskId)))
          throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELEGATION_NOT_ALLOWED', '当前工作没有正在生效的委派授权。');
        /** 每个工具调用使用原始身份去重，未知结果重新核对时不会再次创建。 */
        const input = {
          employeeId: requiredText(call.arguments.employeeId, '请选择允许的员工。', 256),
          title: requiredText(call.arguments.title, '请说明子工作名称。', 240),
          description: requiredText(call.arguments.description, '请说明目标和完成标准。', 4_000),
          dependencyIds: normalizeIdentities(Array.isArray(call.arguments.dependencyIds) ? call.arguments.dependencyIds : []),
        };
        const operationIdentity = sha256([call.conversationId, call.threadId, call.turnId, call.callId].join('\0'));
        const payload = commandEnvelope(workManagementCommandTypes.taskWorkDelegate, 'task', item.taskId, operationIdentity, input, workManagementInputSha256(input));
        const parsed = options.application.parse({ value: payload, commandType: workManagementCommandTypes.taskWorkDelegate, scopeKind: 'task', expectedScopeId: () => item.taskId });
        result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-planning-repository',
          resourceId: `task:${item.taskId}`,
          mutateBusinessState: () => {
            assertCurrentWorkToolTurn(options, call.conversationId, turn.id);
            /** 委派同时遵守原工作授权和当前轮次上限，降低权限后不能借旧安排扩大权限。 */
            const permission = restrictToolPermission(
              run.authoritySnapshot.permissionMode === 'read-only' ? 'read-only' : run.authoritySnapshot.permissionMode === 'full-access' ? 'full-access' : 'auto',
              readWorkToolPermission(options, call.conversationId, turn.clientSubmissionId),
            );
            return options.planning.delegate(item.id, operationIdentity, input, policy, permission === 'auto-review' ? 'auto' : permission);
          },
        }).result;
        await options.save();
        publishChanged(options, item.taskId, item.id, 'delegated');
        if (!(await pauseTaskWorkGoal(options, run, `goal-delegated:${run.id}`))) result = { work: result, message: '子工作已保存。自主目标暂停尚未确认，请查看原会话目标状态，不要重复委派。' };
        kick();
      } else throw new TaskWorkStoreError('ZEUS_TASK_WORK_TOOL_UNKNOWN', '不支持该工作操作。');
      return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(result) }] };
    } catch (cause) {
      return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify(serializeError(cause)) }] };
    }
  }

  /** 任务讨论使用原用户提交及工作账本转为指派，不创建第二套运行链路。 */
  async function invokeDiscussionWorkTool(call: Parameters<TaskWorkToolPort['invoke']>[0], taskId: string, turnId: string, submissionId: string | null): Promise<unknown> {
    /** 任务和当前用户请求均从原始会话关系读取。 */
    const task = requireTaskOrThrow(options, taskId);
    const submission = submissionId ? options.conversationSubmissions.getById(submissionId) : undefined;
    const plan = options.planning.get(taskId);
    if (call.tool === 'inspect')
      return {
        task: { id: task.id, title: task.title, description: task.description },
        sourceRequestId: submission?.conversationId === call.conversationId ? submission.id : null,
        members: options.employees
          .listByProject(task.projectId)
          .filter((employee) => employee.enabled)
          .map((employee) => ({ id: employee.id, name: employee.name, role: employee.role, domain: employee.domain })),
        plan: plan
          ? {
              state: plan.state,
              stages: plan.stages.map((stage) => ({
                id: stage.id,
                title: stage.title,
                status: stage.status,
                items: stage.items.map((item) => ({ id: item.id, title: item.title, description: item.description, employeeId: item.employeeId, status: item.status, revision: item.revision, started: Boolean(item.currentRunId) })),
              })),
            }
          : null,
        work: options.items.listByTask(taskId).map((item) => ({ id: item.id, title: item.title, employeeId: item.employeeId, status: item.status })),
        guidance: '仅当用户明确要求开始执行时指派。已有安排先选择原分工；草稿或暂停安排保留原状态。',
      };
    /** 用户来源只能是当前原生轮次绑定的提交，模型不能引用其他人的消息。 */
    const input = {
      sourceRequestId: requiredText(call.arguments.sourceRequestId, '请引用当前用户请求。', 256),
      employeeId: requiredText(call.arguments.employeeId, '请选择实际员工。', 256),
      title: requiredText(call.arguments.title, '请说明工作名称。', 240),
      description: requiredText(call.arguments.description, '请说明工作边界与完成标准。', 4000),
      workItemId: optionalText(call.arguments.workItemId, 256) ?? null,
      expectedRevision: call.arguments.expectedRevision === undefined ? null : Number(call.arguments.expectedRevision),
    };
    if (!submission || submission.conversationId !== call.conversationId || input.sourceRequestId !== submission.id) throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_REQUEST_SCOPE', '指派必须来自当前用户请求，不能引用历史或其他会话。');
    /** 权限取用户提交时的冻结值，不使用会话后来修改的设置扩大权限。 */
    const permissionMode = readWorkToolPermission(options, call.conversationId, submission.id);
    const identity = sha256([call.conversationId, call.threadId, call.turnId, call.callId].join('\0'));
    const parsed = options.application.parse({
      value: commandEnvelope(workManagementCommandTypes.taskDiscussionAssign, 'task', taskId, identity, input, workManagementInputSha256(input)),
      commandType: workManagementCommandTypes.taskDiscussionAssign,
      scopeKind: 'task',
      expectedScopeId: () => taskId,
    });
    /** 同一用户请求中的相同员工指派只产生一份独立工作。 */
    const sourceRef = `discussion:${submission.id}:${input.employeeId}`;
    const existing = options.items.getBySource('manual', sourceRef);
    /** 异步预检仅为新独立工作准备，不阻断已接纳调用的原回执读取。 */
    let preview: TaskWorkPreview | null = null;
    let resources: PreparedSkillResourceSnapshot[] = [];
    if (!input.workItemId && !existing) {
      assertCurrentWorkToolTurn(options, call.conversationId, turnId);
      if (options.readOnlyValidation || options.isTaskTerminal(requireTaskOrThrow(options, taskId))) throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_CLOSED', '任务已结束或当前处于只读检查。');
      if (plan) throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_PLAN_EXISTS', '任务已有工作安排，请指派其中尚未开始的分工，避免重复执行。');
      preview = await resolvePreview(options, task, { employeeId: input.employeeId, supplementalInfo: `${input.title}\n\n${input.description}\n\n来源：任务讨论中的用户请求 ${submission.id}`, permissionMode, workspace: { mode: 'create' } });
      if (preview.blockers.length) throw new TaskWorkStoreError(preview.blockers[0]!.code, preview.blockers[0]!.message);
      resources = await prepareSkillResourceSnapshots(options, task, preview);
    }
    const result = options.application.executeCore({
      parsed,
      destinationId: 'task-work-discussion-assignment',
      resourceId: `task:${taskId}`,
      mutateBusinessState: () => {
        assertCurrentWorkToolTurn(options, call.conversationId, turnId);
        if (options.readOnlyValidation || options.isTaskTerminal(requireTaskOrThrow(options, taskId))) throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_CLOSED', '任务已结束或当前处于只读检查。');
        const currentPlan = options.planning.get(taskId);
        if (input.workItemId) {
          const target = currentPlan?.stages.flatMap((stage) => stage.items).find((item) => item.id === input.workItemId);
          if (!currentPlan || ['cancelled', 'completed'].includes(currentPlan.state) || !target?.arrangement || !Number.isInteger(input.expectedRevision))
            throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_ASSIGNMENT_CONFLICT', '请读取现行安排并选择尚未开始的分工。');
          const assigned = options.planning.assign(target.id, input.expectedRevision!, input.employeeId);
          /** 指派不扩大原安排已明确选择的权限，也不突破当前请求权限。 */
          const stage = currentPlan.stages.find((candidate) => candidate.id === assigned.arrangement!.stageId);
          const configured = mergeEmployeeWorkSettings(currentPlan.settings, stage?.settings, assigned.arrangement!.settings).permissionMode;
          const boundedPermission = configured === 'read-only' || permissionMode === 'read-only' ? 'read-only' : configured === 'auto' || permissionMode === 'auto' ? 'auto' : 'full-access';
          options.planning.updateArrangement(assigned, { ...assigned.arrangement!, settings: { ...assigned.arrangement!.settings, permissionMode: boundedPermission }, blockedReason: undefined });
          return { item: options.items.getById(assigned.id), planState: currentPlan.state, message: currentPlan.state === 'running' ? '已指派，将在依赖和前序阶段完成后执行。' : '已指派；安排保持原状态，可在工作页启动或继续。' };
        }
        const duplicate = options.items.getBySource('manual', sourceRef);
        if (duplicate) {
          if (duplicate.title !== input.title || duplicate.description !== input.description) throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_ASSIGNMENT_CONFLICT', '这个请求已为该员工创建工作，请继续原工作，或通过新的用户请求调整。');
          return { item: duplicate, message: '此请求已有正式工作，请继续查看原工作。' };
        }
        if (currentPlan || !preview || task.updatedAt !== options.tasks.getById(taskId)?.updatedAt || preview.expectedEmployeeRevision !== options.employees.getById(input.employeeId)?.revision)
          throw new TaskWorkStoreError('ZEUS_TASK_DISCUSSION_ASSIGNMENT_CONFLICT', '任务、员工或安排在预检后发生变化，请重新读取。');
        const created = createWorkItemFromPreview(
          options,
          task,
          requireEmployeeOrThrow(options, task.projectId, input.employeeId),
          preview,
          stableIdentity('task_work_item', sourceRef),
          { source: 'manual', sourceRef, title: input.title, description: input.description },
          resources,
        );
        return { item: created.item, run: created.run, message: '已创建正式工作，执行状态与成果将在工作页更新。' };
      },
    }).result;
    await options.save();
    publishChanged(options, taskId, input.workItemId ?? stableIdentity('task_work_item', sourceRef), 'discussion_assigned');
    kick();
    return result;
  }

  async function processRuns(): Promise<void> {
    await processArrangements();
    for (const runRecord of options.runs.listRecoverable(100)) {
      if (closed) return;
      const current = options.runs.getById(runRecord.id);
      if (!current || options.items.getById(current.workItemId)?.arrangement?.cancellationRequested) continue;
      /** 数字团队运行由 DAG 协调器依据 node attempt 派发，旧循环不得抢跑或按最终文字收口。 */
      const currentItem = options.items.getById(current.workItemId);
      if (currentItem && isDigitalTeamWorkItem(currentItem)) continue;
      try {
        if (current.entrypointKind === 'agent') await processAgentRun(options, current);
        else await processCommandRun(options, current);
      } catch (error) {
        const latest = options.runs.getById(current.id);
        if (latest && !['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(latest.status)) {
          const serialized = serializeError(error);
          options.runs.update(latest.id, { status: 'failed', errorCode: serialized.code, errorMessage: serialized.message, completedAt: options.now().toISOString() });
          const item = options.items.getById(latest.workItemId);
          if (item && !['completed', 'cancelled'].includes(item.status)) options.items.update(item.id, { status: 'failed' });
          publishChanged(options, latest.taskId, latest.workItemId, 'failed');
        }
      } finally {
        await options.save();
      }
    }
  }
  /** 有依赖和验收条件的安排逐阶段调度，失败原因持久保留并等待用户重查。 */
  async function processArrangements(): Promise<void> {
    for (const taskId of options.planning.listRunningTaskIds()) {
      const task = options.tasks.getById(taskId);
      if (!task) continue;
      const plan = options.planning.reconcile(taskId);
      await options.save();
      if (plan) {
        for (const item of plan.stages.flatMap((stage) => stage.items).filter((item) => item.arrangement?.cancellationRequested && !['completed', 'cancelled'].includes(item.status))) {
          try {
            await stopWorkItemRuntime(options, item, `work-cancel:${item.id}`);
            const latest = options.items.getById(item.id)!;
            cancelWorkItem(options, latest, latest.revision);
          } catch (cause) {
            const latest = options.items.getById(item.id)!;
            const message = serializeError(cause).message;
            if (latest.arrangement?.blockedReason !== message) options.planning.updateArrangement(latest, { ...latest.arrangement!, blockedReason: message });
          }
          await options.save();
        }
      }
      if (plan?.state === 'cancelled') {
        for (const stage of plan.stages)
          for (const item of stage.items) {
            if (['completed', 'cancelled'].includes(item.status) || item.arrangement?.blockedReason || item.arrangement?.cancellationRequested) continue;
            try {
              await stopWorkItemRuntime(options, item, `plan-cancel:${plan.id}:${item.id}`);
              const latest = options.items.getById(item.id)!;
              cancelWorkItem(options, latest, latest.revision);
            } catch (cause) {
              const latest = options.items.getById(item.id);
              if (latest?.arrangement) options.planning.updateArrangement(latest, { ...latest.arrangement, blockedReason: serializeError(cause).message });
            }
            await options.save();
          }
        continue;
      }
      if (!plan || plan.state !== 'running' || options.isTaskTerminal(task)) continue;
      const stage = plan.stages.find((candidate) => !['accepted', 'skipped'].includes(candidate.status));
      if (!stage) continue;
      for (const scheduled of stage.items) {
        const item = options.items.getById(scheduled.id);
        if (!item || !item.employeeId || item.currentRunId || item.status !== 'queued' || item.arrangement?.blockedReason || item.arrangement?.cancellationRequested) continue;
        if (item.arrangement?.dependencyIds.some((id) => options.items.getById(id)?.status !== 'completed')) continue;
        try {
          const preview = await resolvePreview(options, task, { employeeId: item.employeeId, plannedWorkItemId: item.id, workspace: { mode: 'create' } });
          if (preview.blockers.length) throw new TaskWorkStoreError(preview.blockers[0]!.code, preview.blockers[0]!.message);
          const resources = await prepareSkillResourceSnapshots(options, task, preview);
          /** 异步预检后重新核对暂停与指派，禁止沿用旧人选自动启动。 */
          const fresh = options.items.getById(item.id);
          if (fresh?.arrangement?.cancellationRequested || fresh?.revision !== item.revision || options.planning.get(taskId)?.state !== 'running' || options.isTaskTerminal(options.tasks.getById(taskId)!)) continue;
          createWorkItemFromPreview(options, task, requireEmployeeOrThrow(options, task.projectId, item.employeeId), preview, item.id, { source: item.source, sourceRef: item.sourceRef! }, resources);
        } catch (cause) {
          const latest = options.items.getById(item.id);
          if (latest?.arrangement && !latest.currentRunId) options.planning.updateArrangement(latest, { ...latest.arrangement, blockedReason: serializeError(cause).message });
        }
        await options.save();
        publishChanged(options, taskId, item.id, 'arrangement_changed');
      }
    }
  }
}

async function resolvePreview(options: TaskWorkManagementOptions, task: ZeusTaskRecord, selection: TaskWorkPreviewSelection, employeeSnapshot?: DigitalEmployeeRecord): Promise<TaskWorkPreview> {
  /** 保留显式请求，复核预览时不重复追加工作目标。 */
  const requestedSelection = structuredClone(selection);
  /** 对照分工身份解析每一层配置，独立会话不会虚构阶段。 */
  const planned = selection.plannedWorkItemId ? options.items.getById(selection.plannedWorkItemId) : null;
  if (selection.plannedWorkItemId && (!planned || planned.taskId !== task.id || planned.employeeId !== selection.employeeId)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ASSIGNMENT_CONFLICT', '分工或执行人已经改变，请重新读取。');
  const plan = options.planning.get(task.id);
  const stage = planned?.arrangement?.stageId ? plan?.stages.find((candidate) => candidate.id === planned.arrangement!.stageId) : null;
  const effective = mergeEmployeeWorkSettings(plan?.settings, stage?.settings, planned?.arrangement?.settings, { ...selection, workMode: selection.workMode ?? undefined, permissionMode: selection.permissionMode ?? undefined });
  const requiredSkills = stage?.requiredSkillIds ?? [];
  selection = {
    ...selection,
    ...effective,
    ...(requiredSkills.length ? { skillIds: Array.from(new Set([...(effective.skillIds ?? employeeSnapshot?.skillIds ?? options.employees.getById(selection.employeeId)?.skillIds ?? []), ...requiredSkills])) } : {}),
  };
  if (planned) {
    /** 执行输入同步实际成果约束，员工可以知道部署凭证等必要交付内容。 */
    const outputLabels = {
      document: '成果说明',
      code: '实际代码差异',
      verification: '实际执行的验证记录',
      deployment: '部署及部署后验证凭证：使用 zeus_work.inspect 读取命令身份，再用 record_deployment 保存环境、修订、地址和结果；未知结果不能声明成功',
    };
    selection.supplementalInfo = [
      planned.title,
      planned.description,
      planned.arrangement?.outputKinds.length ? `需要提交：\n${planned.arrangement.outputKinds.map((kind) => outputLabels[kind]).join('\n')}` : '',
      stage?.verificationCommands.length ? `必须执行并保留结果的验证命令：\n${stage.verificationCommands.join('\n')}` : '',
      selection.supplementalInfo,
    ]
      .filter(Boolean)
      .join('\n\n');
    /** 只携带当前阶段之前的已验收成果，独立工作的成果仍由用户显式选取。 */
    const earlierStageIds = new Set(
      plan?.stages
        .slice(
          0,
          Math.max(
            0,
            plan.stages.findIndex((candidate) => candidate.id === stage?.id),
          ),
        )
        .map((candidate) => candidate.id),
    );
    selection.selectedDeliverableIds = Array.from(
      new Set([
        ...(selection.selectedDeliverableIds ?? []),
        ...options.deliverables
          .listAcceptedByTask(task.id)
          .filter((deliverable) => earlierStageIds.has(options.items.getById(deliverable.workItemId)?.arrangement?.stageId ?? '') || planned.arrangement?.dependencyIds.includes(deliverable.workItemId))
          .map((deliverable) => deliverable.id),
      ]),
    );
  }
  const blockers: TaskWorkPreview['blockers'] = [];
  const employee = employeeSnapshot ?? options.employees.getById(selection.employeeId);
  if (!employee || employee.projectId !== task.projectId) throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '数字员工不存在。', 404);
  if (options.isTaskTerminal(task) || task.status === 'completed' || task.status === 'cancelled') blockers.push({ code: 'ZEUS_TASK_WORK_TASK_TERMINAL', message: '终态任务不能创建新工作项。' });
  if (!employee.enabled) blockers.push({ code: 'ZEUS_DIGITAL_EMPLOYEE_DISABLED', message: '数字员工已停用。' });
  if (employee.entrypoint?.kind !== 'agent' || employee.entrypointMigrationState !== 'ready') {
    blockers.push({ code: 'ZEUS_DIGITAL_EMPLOYEE_AGENT_ENTRYPOINT_REQUIRED', message: '该记录不是可执行的 Agent 数字员工，请先在员工设置中保存为当前配置。' });
  }
  const context = resolveContextManifest(options, task, selection.selectedDeliverableIds ?? [], blockers);
  let model: Record<string, unknown> | null = null;
  const skills: TaskWorkPreview['skills'] = [];
  const command: TaskWorkPreview['command'] = null;
  let entrypoint: Record<string, unknown> | null = employee.entrypoint ? sanitizeEntrypoint(employee.entrypoint) : null;
  let authority: Record<string, unknown> = employee.entrypoint?.kind === 'agent' ? { ...employee.entrypoint.authorityPolicy } : {};
  let workspace: TaskWorkWorkspaceSnapshot | null = null;
  let promptPreview: TaskPushMessageLayout | null = null;
  const project = options.projects.getById(task.projectId);
  if (!project) throw new TaskWorkStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
  const supplementalAttachments = resolveTaskWorkSupplementalAttachments(options, selection.supplementalAttachments, project.localPath);

  if (employee.entrypoint?.kind === 'agent') {
    const agentEntrypoint = employee.entrypoint;
    const workMode = selection.workMode ?? employee.workMode;
    /** 个人经验只由当前员工的独立范围读取，项目默认仍由上下文编译器负责。 */
    const memories = selectEmployeeMemories(options.memory, employee, task.projectId, task.title + task.description, options.now().toISOString());
    /** 冻结来源与内容；到期或停用经验不会进入新工作。 */
    const memoryText = memories.map((record) => `[${record.memoryKey} · 来源 ${record.source.reference} · ${record.id}]\n${record.content}`).join('\n\n');
    const prompt = [selection.promptOverride ?? agentEntrypoint.prompt, memoryText ? `员工相关经验（仅作工作参考，不代表本次行动授权）：\n${memoryText}` : ''].filter(Boolean).join('\n\n');
    entrypoint = {
      ...sanitizeEntrypoint(agentEntrypoint),
      prompt,
      memoryPromptBase: selection.promptOverride ?? agentEntrypoint.prompt,
      autonomyObjective: effective.autonomyObjective ?? null,
      delegationPolicy: planned?.arrangement?.delegation ?? effective.delegation ?? null,
      memorySnapshot: memories.map((record) => ({ id: record.id, contentSha256: record.contentSha256, source: record.source, reviewAfter: record.reviewAfter })),
      workMode,
      supplementalInfo: selection.supplementalInfo,
      ...(selection.supplementalAttachments ? { supplementalAttachments: selection.supplementalAttachments } : {}),
    };
    authority = resolveRunAuthority(agentEntrypoint, selection.permissionMode);
    const capability = await options.conversationCapabilities.readTaskPush(task.projectId, task.id);
    model = resolveAgentModel(employee, agentEntrypoint, selection, capability, blockers);
    /** 与会话共用真实功能目录，切换到 Pi 后不按品牌关闭已经接入的目标。 */
    const selectedCapability = (Array.isArray(capability.models) ? capability.models.filter(isCapabilityModel) : []).find((candidate) => candidate.id === model?.id);
    if (effective.autonomyObjective && !(selectedCapability?.features ? ['available', 'unknown'].includes(selectedCapability.features.goals.state) : isRecord(capability.goals) && capability.goals.enabled === true))
      blockers.push({ code: 'ZEUS_TASK_WORK_GOAL_UNAVAILABLE', message: '该模型尚不支持自主目标，请切换支持的模型或清空此目标后执行。' });
    workspace = resolveTaskWorkWorkspaceSnapshot(selection.workspace, capability, blockers);
    if (model && typeof model.agentKind === 'string') entrypoint = { ...entrypoint, agentKind: model.agentKind };
    const selectedSkillIds = normalizeIdentities(selection.skillIds ?? agentEntrypoint.skillPolicy.allowedSkillIds);
    const selectionBySource = splitZeusSkillIds(selectedSkillIds);
    if (selectionBySource.invalidIds.length > 0) blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_INVALID', message: '指派包含无效的 Skill 身份。' });
    if (selectionBySource.nativeSkillIds.length > 0 && !options.skills) blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_CATALOG_UNAVAILABLE', message: 'Zeus Skill 目录当前不可用。' });
    if (selectionBySource.pluginReferences.length > 0 && !options.plugins) blockers.push({ code: 'ZEUS_TASK_WORK_PLUGIN_SKILL_CATALOG_UNAVAILABLE', message: 'Zeus Plugin Skill 目录当前不可用。' });
    if (options.skills) {
      for (const skillId of selectionBySource.nativeSkillIds) {
        try {
          const resolvedSkill = await options.skills.resolve({ cwd: options.projects.getById(task.projectId)!.localPath, skillId });
          skills.push(await snapshotSkill(resolvedSkill));
        } catch (error) {
          blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_UNAVAILABLE', message: serializeError(error).message });
        }
      }
    }
    if (options.plugins && selectionBySource.pluginReferences.length > 0) {
      try {
        const available = await options.plugins.listSkills({ projectId: task.projectId });
        for (const reference of selectionBySource.pluginReferences) {
          const skill = available.find((candidate) => candidate.id === reference.id);
          if (!skill) blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_UNAVAILABLE', message: `Plugin Skill ${reference.id} 在当前项目不可用。` });
          else skills.push({ source: 'plugin', id: skill.id, name: skill.namespace, description: skill.description, pluginId: skill.pluginId, pluginRevisionId: skill.pluginRevisionId });
        }
      } catch (error) {
        blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_UNAVAILABLE', message: serializeError(error).message });
      }
    }
    const supplementalInfo = await buildAgentSupplementalInfoSnapshot(options, {
      employee,
      entrypoint,
      context,
      skills: skills.map((skill) => (skill.source === 'skill' ? { ...skill, snapshotPath: '（运行创建后冻结）' } : skill)),
    });
    promptPreview = buildTaskWorkPromptPreview(task, supplementalInfo, supplementalAttachments);
  }

  const digestSource = {
    arrangementRevision: planned?.revision ?? null,
    planRevision: planned ? (plan?.revision ?? null) : null,
    expectedTaskRevision: task.updatedAt,
    expectedEmployeeRevision: employee.revision,
    selection: requestedSelection,
    employee: { id: employee.id, name: employee.name, role: employee.role, domain: employee.domain, revision: employee.revision },
    entrypoint,
    model,
    skills,
    authority,
    context,
    workspace,
    promptPreview,
    command,
    blockers,
  };
  return { previewSha256: sha256(canonicalJson(digestSource)), expiresAt: new Date(options.now().getTime() + previewTtlMs).toISOString(), ...digestSource };
}

function resolveTaskWorkWorkspaceSnapshot(choice: TaskWorkWorkspaceChoice | undefined, capabilities: Record<string, unknown>, blockers: TaskWorkPreview['blockers']): TaskWorkWorkspaceSnapshot {
  const repositories = Array.isArray(capabilities.repositories) ? capabilities.repositories.filter(isRecord) : [];
  /** 规划和汇总只读会话可明确使用项目目录，不提前创建任务分支。 */
  if (choice?.mode === 'direct') return { mode: 'direct' };
  if (repositories.length === 0) {
    if (choice?.mode === 'existing' || choice?.mode === 'local') blockers.push({ code: 'ZEUS_TASK_WORK_ENVIRONMENT_INVALID', message: '当前任务没有可继续的任务分支。' });
    return { mode: 'direct' };
  }

  if (choice?.mode === 'existing') {
    const environments = Array.isArray(capabilities.existingEnvironments) ? capabilities.existingEnvironments.filter(isRecord) : [];
    const environment = environments.find((candidate) => candidate.id === choice.environmentId);
    if (!environment) blockers.push({ code: 'ZEUS_TASK_WORK_ENVIRONMENT_INVALID', message: '所选任务环境不属于当前任务。' });
    else if (environment.available !== true)
      blockers.push({
        code: environment.unavailableReason === 'closed_workspace' ? 'ZEUS_TASK_WORK_ENVIRONMENT_CLOSED' : 'ZEUS_TASK_WORK_ENVIRONMENT_BUSY',
        message: environment.unavailableReason === 'closed_workspace' ? '所选任务环境已经部分关闭。' : '所选任务环境正被其他会话使用。',
      });
    return { mode: 'existing', environmentId: choice.environmentId };
  }

  const repositoryRevision = typeof capabilities.repositoryRevision === 'string' ? capabilities.repositoryRevision : '';
  if (!repositoryRevision) blockers.push({ code: 'ZEUS_TASK_WORK_REPOSITORY_REVISION_REQUIRED', message: '项目仓库清单缺少稳定版本。' });
  if (choice?.mode === 'local') {
    const resolvedRepositories = repositories.flatMap((repository) => {
      if (typeof repository.id !== 'string') {
        blockers.push({ code: 'ZEUS_TASK_WORK_LOCAL_BRANCH_INVALID', message: '项目仓库缺少稳定身份。' });
        return [];
      }
      const candidates = Array.isArray(repository.localTaskBranches) ? repository.localTaskBranches.filter(isRecord) : [];
      const candidate = candidates.find((entry) => entry.branchName === choice.branchName);
      if (!candidate) blockers.push({ code: 'ZEUS_TASK_WORK_LOCAL_BRANCH_INVALID', message: `本地任务分支在仓库中不可用：${choice.branchName}` });
      else if (candidate.available !== true) {
        blockers.push({
          code: candidate.unavailableReason === 'checked_out' ? 'ZEUS_TASK_WORK_LOCAL_BRANCH_CHECKED_OUT' : 'ZEUS_TASK_WORK_LOCAL_BRANCH_MANAGED',
          message: candidate.unavailableReason === 'checked_out' ? `本地任务分支已被其他 worktree 检出：${choice.branchName}` : `本地任务分支已经由任务环境管理：${choice.branchName}`,
        });
      }
      return [{ repositoryId: repository.id, branchName: choice.branchName }];
    });
    return { mode: 'local', repositoryRevision, repositories: resolvedRepositories };
  }

  const resolvedRepositories = repositories.flatMap((repository) => {
    const sourceRefs = Array.isArray(repository.sourceRefs) ? repository.sourceRefs.filter(isRecord) : [];
    const source = sourceRefs.find((candidate) => candidate.current === true) ?? sourceRefs.find((candidate) => candidate.kind === 'local');
    if (!source || typeof repository.id !== 'string' || typeof source.ref !== 'string' || typeof repository.suggestedBranchName !== 'string') {
      blockers.push({ code: 'ZEUS_TASK_WORK_SOURCE_REF_UNAVAILABLE', message: '项目仓库没有可用的来源分支。' });
      return [];
    }
    return [{ repositoryId: repository.id, sourceRef: source.ref, branchName: repository.suggestedBranchName }];
  });
  return { mode: 'create', repositoryRevision, repositories: resolvedRepositories };
}

function createWorkItemFromPreview(
  options: TaskWorkManagementOptions,
  task: ZeusTaskRecord,
  employee: DigitalEmployeeRecord,
  preview: TaskWorkPreview,
  operationIdentity: string,
  source: { source: 'manual' | 'automation'; sourceRef: string; title?: string; description?: string } = { source: 'manual', sourceRef: `manual:${operationIdentity}` },
  skillResources: PreparedSkillResourceSnapshot[] = [],
): { item: TaskWorkItemRecord; run: TaskWorkRunRecord } {
  if (employee.entrypoint?.kind !== 'agent') throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_AGENT_ENTRYPOINT_REQUIRED', '数字员工必须通过 Agent 会话执行。');
  if (!preview.workspace) throw new TaskWorkStoreError('ZEUS_TASK_WORK_WORKSPACE_MISSING', 'Agent 运行缺少已解析代码现场。');
  const item = options.items.create({
    id: operationIdentity,
    projectId: task.projectId,
    taskId: task.id,
    employeeId: employee.id,
    source: source.source,
    sourceRef: source.sourceRef,
    title: source.title ?? `${employee.name}·${task.title}`,
    description: source.description ?? task.description,
    entrypointKind: 'agent',
    status: 'queued',
  });
  const existingRun = item.currentRunId ? options.runs.getById(item.currentRunId) : undefined;
  if (existingRun) return { item, run: existingRun };
  const runId = stableIdentity('task_work_run', `${item.id}\0attempt:1`);
  const skillSnapshot = persistSkillResourceSnapshots(
    options,
    runId,
    task.projectId,
    skillResources,
    preview.skills.filter((skill): skill is TaskWorkPluginSkillPreview => skill.source === 'plugin'),
  );
  const run = options.runs.create({
    id: runId,
    projectId: task.projectId,
    taskId: task.id,
    workItemId: item.id,
    employeeId: employee.id,
    attempt: 1,
    status: 'prepared',
    entrypointKind: 'agent',
    employeeRevision: employee.revision,
    employeeSnapshot: structuredClone(employee) as unknown as Record<string, unknown>,
    entrypointSnapshot: structuredClone(preview.entrypoint ?? {}),
    modelSnapshot: preview.model,
    skillSnapshot,
    authoritySnapshot: structuredClone(preview.authority),
    contextManifest: structuredClone(preview.context),
    workspaceSnapshot: structuredClone(preview.workspace),
    environmentId: null,
  });
  const updatedItem = options.items.update(item.id, { currentRunId: run.id });
  options.taskEvents.create({ taskId: task.id, eventType: 'task.work_item.created', title: '已创建数字员工工作项', payload: { workItemId: item.id, runId: run.id, employeeId: employee.id, entrypointKind: 'agent' } });
  return { item: updatedItem, run };
}

async function processAgentRun(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Promise<void> {
  if (run.status === 'prepared' && options.items.getById(run.workItemId)?.arrangement?.stageId && options.planning.get(run.taskId)?.state !== 'running') return;
  if (run.status === 'prepared' || run.status === 'dispatching') {
    const dispatching = run.status === 'prepared' ? options.runs.update(run.id, { status: 'dispatching', startedAt: options.now().toISOString() }) : run;
    const item = options.items.getById(run.workItemId)!;
    if (item.status === 'queued') options.items.update(item.id, { status: 'active' });
    verifyFrozenSkillResources(options, dispatching);
    await dispatchAgent(options, dispatching);
    return;
  }
  // 正式交付物提交后运行已冻结；普通会话后续轮次不回写该运行或交付物版本。
  if (run.status === 'runtime_completed') {
    /** 自动接纳只检查用户事先指定的命令证据，不推断业务或部署正确性。 */
    const item = options.items.getById(run.workItemId);
    const plan = options.planning.get(run.taskId);
    const stage = plan?.stages.find((candidate) => candidate.id === item?.arrangement?.stageId);
    const deliverable = options.deliverables.listByTask(run.taskId).find((candidate) => candidate.runId === run.id && candidate.status === 'submitted');
    if (plan?.state !== 'running' || stage?.acceptanceMode !== 'checked' || !stage.verificationCommands.length || !deliverable?.bundle || !item?.arrangement || options.isTaskTerminal(requireTaskOrThrow(options, run.taskId))) return;
    const sources = deliverable.bundle.sources;
    if (
      deliverable.bundle.gaps.length ||
      !item.arrangement.outputKinds.every((kind) => deliverable.bundle!.availableKinds.includes(kind)) ||
      !stage.verificationCommands.every((command) => sources.some((source) => source.kind === 'command' && source.command === command && source.status === 'passed')) ||
      options.reviews.list(deliverable.id).some((note) => note.blocking && note.status === 'open')
    )
      return;
    const input = { expectedRevision: deliverable.revision, deliverableId: deliverable.id, contentSha256: deliverable.contentSha256 };
    const identity = `checked:${deliverable.id}:${deliverable.contentSha256}`;
    const parsed = options.application.parse({
      value: commandEnvelope(workManagementCommandTypes.taskWorkDeliverableAccept, 'task', run.taskId, identity, input, workManagementInputSha256(input)),
      commandType: workManagementCommandTypes.taskWorkDeliverableAccept,
      scopeKind: 'task',
      expectedScopeId: () => run.taskId,
    });
    options.application.executeCore({
      parsed,
      destinationId: 'task-work-deliverable-repository',
      resourceId: `task_work_deliverable:${deliverable.id}`,
      mutateBusinessState: () => acceptDeliverable(options, deliverable, deliverable.revision),
    });
    publishChanged(options, run.taskId, item.id, 'checks_accepted');
    return;
  }
  if (!run.conversationId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONVERSATION_MISSING', 'Agent 工作运行缺少会话身份。');
  verifyFrozenSkillResources(options, run);
  recordActuallyEnabledSkills(options, run);
  const conversation = options.conversations.getById(run.conversationId);
  if (!conversation || conversation.taskId !== run.taskId || conversation.projectId !== run.projectId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONVERSATION_MISSING', 'Agent 工作运行的会话已不可用。');
  const executionState = conversationWorkExecutionState(conversation, options.conversationSubmissions.listByConversation(conversation.id));
  if (executionState.type === 'failed') throw new TaskWorkStoreError(executionState.code, executionState.message);
  if (executionState.type === 'outcome_unknown') {
    blockAgentRunForUnknownOutcome(options, run, executionState.code, executionState.message);
    return;
  }
  if (executionState.type === 'waiting') {
    if (run.status !== 'waiting_input') options.runs.update(run.id, { status: 'waiting_input' });
    const item = options.items.getById(run.workItemId)!;
    if (item.status !== 'waiting_manager') options.items.update(item.id, { status: 'waiting_manager' });
    return;
  }
  if (executionState.type !== 'completed') {
    if (run.status !== 'active') options.runs.update(run.id, { status: 'active' });
    const item = options.items.getById(run.workItemId);
    if (item?.status === 'waiting_manager') options.items.update(item.id, { status: 'active' });
    return;
  }
  if (run.status === 'waiting_input') {
    run = options.runs.update(run.id, { status: 'active' });
    const current = options.items.getById(run.workItemId)!;
    if (current.status === 'waiting_manager') options.items.update(current.id, { status: 'active' });
  }
  /** 委派完成后再发起一次明确汇总；等待本身不制造模型轮次或提前提交成果。 */
  const children = options.items.listByTask(run.taskId).filter((item) => item.arrangement?.parentWorkItemId === run.workItemId);
  const joined = Array.isArray(run.entrypointSnapshot.joinedChildIds) ? run.entrypointSnapshot.joinedChildIds : [];
  if (children.some((item) => !joined.includes(item.id))) {
    if (!(await pauseTaskWorkGoal(options, run, `goal-join:${run.id}`))) {
      const item = options.items.getById(run.workItemId)!;
      if (item.arrangement && item.arrangement.blockedReason !== '自主目标暂停尚未确认，请在原会话核对目标状态。')
        options.planning.updateArrangement(item, { ...item.arrangement, blockedReason: '自主目标暂停尚未确认，请在原会话核对目标状态。' });
      return;
    }
    if (options.planning.get(run.taskId)?.state !== 'running' || children.some((item) => item.status !== 'completed')) return;
    /** 汇总输入固定到已经验收的子成果，保持独立历史与原始来源。 */
    const acceptedChildren = options.deliverables.listAcceptedByTask(run.taskId).filter((deliverable) => children.some((item) => item.id === deliverable.workItemId));
    const blockers: TaskWorkPreview['blockers'] = [];
    const context = resolveContextManifest(
      options,
      requireTaskOrThrow(options, run.taskId),
      [...new Set([...run.contextManifest.acceptedDeliverables.map((deliverable) => deliverable.deliverableId), ...acceptedChildren.map((deliverable) => deliverable.id)])],
      blockers,
    );
    if (blockers.length) throw new TaskWorkStoreError(blockers[0]!.code, blockers[0]!.message);
    let parent = options.items.getById(run.workItemId)!;
    if (parent.arrangement?.blockedReason) {
      options.planning.updateArrangement(parent, { ...parent.arrangement, blockedReason: undefined });
      parent = options.items.getById(parent.id)!;
    }
    const next = cloneRun(
      options,
      parent,
      run,
      {
        joinedChildIds: children.map((item) => item.id),
        supplementalInfo: [run.entrypointSnapshot.supplementalInfo, '子工作已经通过审查。请读取所附冻结成果，核对原任务目标并形成整体结论；存在分歧时明确指出，不能把子成果机械拼接为完成。'].filter(Boolean).join('\n\n'),
      },
      context,
    );
    options.runs.update(run.id, { status: 'succeeded', completedAt: options.now().toISOString() });
    options.items.update(parent.id, { currentRunId: next.id, status: 'active' });
    options.taskEvents.create({
      taskId: run.taskId,
      eventType: 'task.work_item.joined',
      title: '子工作已通过，开始汇总',
      payload: { workItemId: parent.id, runId: next.id, deliverableIds: acceptedChildren.map((deliverable) => deliverable.id) },
    });
    return;
  }
  /** 自主目标未完成时普通空闲不代表交付，暂停与额度等待通过原会话处理。 */
  if (run.entrypointSnapshot.autonomyObjective) {
    const goal = options.conversationGoals.get(run.conversationId!);
    const explicitlyCleared = options.conversationGoals.listEvents(run.conversationId!).at(-1)?.kind === 'cleared';
    if ((!goal && !explicitlyCleared) || (goal && goal.status !== 'complete')) return;
  }
  const existing = options.deliverables.listByTask(run.taskId).find((candidate) => candidate.runId === run.id);
  if (!existing) await captureAgentDeliverable(options, run, conversation.messages);
}

async function dispatchAgent(options: TaskWorkManagementOptions, run: TaskWorkRunRecord, processAttached = true): Promise<{ run: TaskWorkRunRecord; submissionId: string | null }> {
  const task = requireTaskOrThrow(options, run.taskId);
  const project = options.projects.getById(run.projectId);
  if (!project) throw new TaskWorkStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
  const model = run.modelSnapshot;
  if (!model || typeof model.id !== 'string' || typeof model.agentKind !== 'string') throw new TaskWorkStoreError('ZEUS_TASK_WORK_MODEL_MISSING', 'Agent 运行缺少已解析模型快照。');
  const pluginReferences = await resolveFrozenPluginSkillReferences(options, run);
  const authority = run.authoritySnapshot;
  const writeEnabled = authority.permissionMode !== 'read-only';
  let workspace = run.workspaceSnapshot;
  if (!workspace) {
    const legacyCapabilities = await options.conversationCapabilities.readTaskPush(project.id, task.id);
    const blockers: TaskWorkPreview['blockers'] = [];
    workspace = resolveTaskWorkWorkspaceSnapshot({ mode: 'create' }, legacyCapabilities, blockers);
    if (blockers.length > 0) throw new TaskWorkStoreError(blockers[0]!.code, blockers[0]!.message);
    options.runs.update(run.id, { workspaceSnapshot: workspace });
  }
  if (workspace.mode === 'direct' && writeEnabled) {
    const capabilities = await options.conversationCapabilities.readTaskPush(project.id, task.id);
    if (isRecord(capabilities.directWorkspace) && typeof capabilities.directWorkspace.activeWritableConversationCount === 'number' && capabilities.directWorkspace.activeWritableConversationCount > 0) {
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_DIRECT_WORKSPACE_BUSY', '项目目录已有可写会话，新运行不会隐式共享写入现场。');
    }
  }
  const supplementalInfo = await buildAgentSupplementalInfo(options, run);
  const supplementalAttachments = Array.isArray(run.entrypointSnapshot.supplementalAttachments) ? run.entrypointSnapshot.supplementalAttachments : [];
  const body: Record<string, unknown> = {
    mode: 'create',
    model: model.id,
    agentKind: model.agentKind,
    ...(typeof model.reasoningEffort === 'string' ? { effort: model.reasoningEffort } : {}),
    ...(typeof model.serviceTier === 'string' ? { serviceTier: model.serviceTier } : {}),
    permissionMode: typeof authority.permissionMode === 'string' ? authority.permissionMode : 'read-only',
    source: 'task_push',
    ...(typeof run.entrypointSnapshot.autonomyObjective === 'string' && run.entrypointSnapshot.autonomyObjective ? { goalObjective: run.entrypointSnapshot.autonomyObjective } : {}),
    workMode: run.entrypointSnapshot.workMode === 'plan' ? 'plan' : 'default',
    supplementalInfo,
    ...(supplementalAttachments.length > 0 ? { supplementalAttachments } : {}),
    workspace,
    ...(pluginReferences.length > 0 ? { pluginReferences } : {}),
  };
  /** Symbol 形式的服务端策略不会从 HTTP JSON 注入，接纳层会再次与任务授权取交集。 */
  const digitalTeamPurpose = typeof run.entrypointSnapshot.digitalTeamPurpose === 'string' ? run.entrypointSnapshot.digitalTeamPurpose : null;
  if (digitalTeamPurpose && ['plan', 'work', 'verify', 'summary'].includes(digitalTeamPurpose)) {
    const workNode = digitalTeamPurpose === 'work' && run.entrypointSnapshot.digitalTeamExecutionMode === 'isolated_write';
    const verificationNode = digitalTeamPurpose === 'verify' && run.entrypointSnapshot.digitalTeamExecutionMode === 'candidate_read_only';
    body.permissionMode = (workNode || verificationNode) && authority.permissionMode !== 'read-only' ? authority.permissionMode : 'read-only';
    attachDigitalTeamTaskPushPolicy(body, {
      purpose: digitalTeamPurpose as 'plan' | 'work' | 'verify' | 'summary',
      allowCodeChanges: workNode && authority.allowCodeChanges === true,
      allowTests: (workNode || verificationNode) && authority.allowTests === true,
      allowGitCommit: workNode && authority.allowCommit === true,
    });
  }
  const accepted = await options.executeTaskConversationIdempotent(project, task, body, `task-work-run:${run.id}`);
  const response = isRecord(accepted.body) ? accepted.body : {};
  const projection = isRecord(response.conversation) ? response.conversation : {};
  /** 耐久 submission 身份供数字团队绑定准确轮次，普通工作仍可忽略。 */
  const submissionProjection = isRecord(response.submission) ? response.submission : {};
  const submissionId = typeof submissionProjection.id === 'string' ? submissionProjection.id : null;
  const conversationId = typeof projection.id === 'string' ? projection.id : null;
  if (!conversationId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ACCEPTANCE_NOT_DURABLE', '任务推送没有返回耐久会话身份。');
  const persistedConversation = options.conversations.getById(conversationId);
  const environmentId = typeof projection.environmentId === 'string' ? projection.environmentId : (persistedConversation?.environmentId ?? null);
  if (workspace.mode === 'existing' && environmentId !== workspace.environmentId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ENVIRONMENT_MISMATCH', '新会话没有绑定所选任务环境。');
  if ((workspace.mode === 'create' || workspace.mode === 'local') && !environmentId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ENVIRONMENT_MISSING', '任务分支没有返回任务环境身份。');
  if (workspace.mode === 'direct' && environmentId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ENVIRONMENT_MISMATCH', '项目目录直连会话意外绑定了任务环境。');
  const attached = options.runs.update(run.id, { status: 'active', conversationId, environmentId });
  publishChanged(options, run.taskId, run.workItemId, 'agent_started');
  if (processAttached) await processAgentRun(options, attached);
  return { run: attached, submissionId };
}

function blockAgentRunForUnknownOutcome(options: TaskWorkManagementOptions, run: TaskWorkRunRecord, code: string, message: string): void {
  const completedAt = options.now().toISOString();
  options.runs.update(run.id, { status: 'outcome_unknown', errorCode: code, errorMessage: message, completedAt });
  const item = options.items.getById(run.workItemId);
  if (item && item.status !== 'blocked') options.items.update(item.id, { status: 'blocked' });
  options.decisions.create({
    projectId: run.projectId,
    taskId: run.taskId,
    workItemId: run.workItemId,
    runId: run.id,
    deliverableId: null,
    kind: 'outcome_unknown',
    title: '核对 Agent 会话派发结果',
    prompt: '会话可能已经写入 Provider，Zeus 不会自动重发。请核对会话现场后处置。',
    requestPayload: { code, message, conversationId: run.conversationId },
    operationIdentity: `agent-outcome:${run.id}`,
    expiresAt: null,
  });
  publishChanged(options, run.taskId, run.workItemId, 'outcome_unknown');
}

async function captureAgentDeliverable(options: TaskWorkManagementOptions, run: TaskWorkRunRecord, messages: Array<{ id: string; role: string; content: string }>): Promise<void> {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'assistant' && candidate.content.trim());
  if (!message) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELIVERABLE_EMPTY', 'Agent 会话已结束，但没有可沉淀的正式输出。');
  const deliverableId = stableIdentity('task_work_deliverable', run.id);
  /** 本次提交冻结说明、真实变更与明确的运行结果。 */
  const evidence = captureTaskWorkEvidence({
    run,
    message,
    changes: options.turnChanges,
    providerItems: options.providerItems,
    deployments: options.deployments.list(run.id),
    requiredKinds: options.items.getById(run.workItemId)?.arrangement?.outputKinds,
  });
  const artifact = await options.artifacts.putText({
    text: evidence.content,
    mimeType: 'text/markdown',
    owner: { kind: 'task_work_deliverable', id: deliverableId, generationId: taskWorkDeliverableArtifactGeneration, projectId: run.projectId, conversationId: run.conversationId },
  });
  options.artifacts.hold({ sha256: artifact.sha256, owner: { kind: 'task_work_deliverable', id: deliverableId }, ownerClass: 'active_task', reason: `task-work-deliverable:${run.taskId}` });
  const item = options.items.getById(run.workItemId)!;
  const deliverable = options.deliverables.create({
    id: deliverableId,
    projectId: run.projectId,
    taskId: run.taskId,
    workItemId: run.workItemId,
    runId: run.id,
    kind: 'agent_result',
    bundle: evidence.bundle,
    title: `${item.title}·交付物`,
    summary: summarize(message.content),
    artifactSha256: artifact.sha256,
    contentSha256: artifact.contentSha256,
    sourceMessageId: message.id,
  });
  options.runs.update(run.id, { status: 'runtime_completed', runtimeCompletedAt: options.now().toISOString() });
  options.items.update(item.id, { status: 'waiting_manager' });
  options.decisions.create({
    projectId: run.projectId,
    taskId: run.taskId,
    workItemId: run.workItemId,
    runId: run.id,
    deliverableId: deliverable.id,
    kind: 'deliverable_acceptance',
    title: '验收数字员工交付物',
    prompt: '请验收该正式交付物，或明确要求修改。',
    requestPayload: { deliverableId: deliverable.id, version: deliverable.version, contentSha256: deliverable.contentSha256 },
    operationIdentity: `deliverable-acceptance:${deliverable.id}`,
    expiresAt: null,
  });
  options.taskEvents.create({
    taskId: run.taskId,
    eventType: 'task.work_deliverable.submitted',
    title: '数字员工已提交正式交付物',
    payload: { workItemId: run.workItemId, runId: run.id, deliverableId: deliverable.id, version: deliverable.version },
  });
  publishChanged(options, run.taskId, run.workItemId, 'deliverable_submitted');
}

async function startCommandRun(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, run: TaskWorkRunRecord, parameters: Record<string, unknown>, preview: TaskWorkPreview): Promise<void> {
  if (!preview.command) throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_UNAVAILABLE', '命令预览不可用。');
  const commandId = preview.command.id;
  const commandRunId = stableIdentity('command_run_task_work', run.id);
  const confirmationInput = { parameters, trigger: 'desktop' };
  const confirmation = await options.server.inject({
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(run.projectId)}/commands/${encodeURIComponent(commandId)}/confirmations`,
    headers: { authorization: `Bearer ${options.apiToken}` },
    payload: commandEnvelope(commandCenterCommandTypes.confirmationCreate, 'command_run', commandRunId, commandRunId, confirmationInput, commandCenterInputSha256(confirmationInput)),
  });
  if (confirmation.statusCode !== 201) {
    await commandStartFailure(options, item, run, confirmation.statusCode, safeHttpMessage(confirmation), 'confirmation');
    return;
  }
  const confirmationBody: unknown = confirmation.json();
  const confirmationId = isRecord(confirmationBody) && typeof confirmationBody.id === 'string' ? confirmationBody.id : null;
  if (!confirmationId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_CONFIRMATION_INVALID', '命令确认没有返回稳定身份。');
  options.runs.update(run.id, { status: 'active', commandRunId, startedAt: run.startedAt ?? options.now().toISOString() });
  if (item.status !== 'active') options.items.update(item.id, { status: 'active' });
  const runInput = { runId: commandRunId, confirmationId, parameters };
  const started = await options.server.inject({
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(run.projectId)}/commands/${encodeURIComponent(commandId)}/runs`,
    headers: { authorization: `Bearer ${options.apiToken}` },
    payload: commandEnvelope(commandCenterCommandTypes.runStart, 'command_run', commandRunId, `${commandRunId}_start`, runInput, commandCenterInputSha256(runInput)),
  });
  if (started.statusCode !== 201) {
    await commandStartFailure(options, item, run, started.statusCode, safeHttpMessage(started), 'start');
    return;
  }
  options.runs.update(run.id, { status: 'active', commandRunId });
  options.taskEvents.create({ taskId: run.taskId, eventType: 'task.work_command.started', title: '数字员工已启动项目命令', payload: { workItemId: item.id, runId: run.id, commandRunId, commandId } });
}

async function commandStartFailure(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, run: TaskWorkRunRecord, statusCode: number, message: string, phase: string): Promise<void> {
  if (statusCode >= 500) {
    options.runs.update(run.id, { status: 'outcome_unknown', errorCode: 'ZEUS_TASK_WORK_COMMAND_OUTCOME_UNKNOWN', errorMessage: message, completedAt: options.now().toISOString() });
    options.items.update(item.id, { status: 'blocked' });
    options.decisions.create({
      projectId: run.projectId,
      taskId: run.taskId,
      workItemId: run.workItemId,
      runId: run.id,
      deliverableId: null,
      kind: 'outcome_unknown',
      title: '处置命令未知结果',
      prompt: '命令可能已产生外部效果，Zeus 不会自动重发。请核对现场后处置。',
      requestPayload: { phase, statusCode },
      operationIdentity: `command-outcome:${run.id}:${phase}`,
      expiresAt: null,
    });
  } else {
    options.runs.update(run.id, { status: 'failed', errorCode: 'ZEUS_TASK_WORK_COMMAND_START_FAILED', errorMessage: message, completedAt: options.now().toISOString() });
    options.items.update(item.id, { status: 'failed' });
    createCommandFailureDecision(options, run, message, phase);
  }
}

async function processCommandRun(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Promise<void> {
  if (run.status === 'prepared' || run.status === 'dispatching') return;
  // `waiting_input` 且尚未生成 commandRunId 表示 Command 工作项正在等待管理者
  // 首次确认或显式重试确认。此时命令尚未开始，不能把“没有运行身份”误判为失败。
  if (run.status === 'waiting_input' && !run.commandRunId) return;
  if (!run.commandRunId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_RUN_MISSING', 'Command 工作运行缺少命令运行身份。');
  const commandRun = options.commandRuns.getById(run.commandRunId);
  if (!commandRun) throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_RUN_MISSING', '命令运行记录已不可用。');
  if (commandRun.status === 'starting' || commandRun.status === 'running' || commandRun.status === 'stopping') return;
  const item = options.items.getById(run.workItemId)!;
  if (commandRun.status === 'succeeded') {
    options.runs.update(run.id, { status: 'succeeded', runtimeCompletedAt: commandRun.endedAt ?? options.now().toISOString(), completedAt: commandRun.endedAt ?? options.now().toISOString() });
    options.items.update(item.id, { status: 'completed', completedAt: commandRun.endedAt ?? options.now().toISOString() });
    options.taskEvents.create({ taskId: run.taskId, eventType: 'task.work_command.succeeded', title: '数字员工命令已成功完成', payload: { workItemId: item.id, runId: run.id, commandRunId: commandRun.id, exitCode: commandRun.exitCode } });
    publishChanged(options, run.taskId, item.id, 'command_succeeded');
    return;
  }
  if (commandRun.status === 'pending_confirmation') {
    if (run.status !== 'waiting_input') options.runs.update(run.id, { status: 'waiting_input' });
    if (item.status !== 'waiting_manager') options.items.update(item.id, { status: 'waiting_manager' });
    options.decisions.create({
      projectId: run.projectId,
      taskId: run.taskId,
      workItemId: run.workItemId,
      runId: run.id,
      deliverableId: null,
      kind: 'command_confirmation',
      title: '重新确认项目命令',
      prompt: '命令确认已过期或定义发生变化，请重新预览后显式处置。',
      requestPayload: { commandRunId: commandRun.id, command: commandDecisionSnapshot(options, run) },
      operationIdentity: `command-confirmation:${run.id}`,
      expiresAt: null,
    });
    return;
  }
  options.runs.update(run.id, {
    status: commandRun.status === 'cancelled' ? 'cancelled' : 'failed',
    errorCode: 'ZEUS_TASK_WORK_COMMAND_FAILED',
    errorMessage: commandRun.failureReason ?? commandRun.status,
    completedAt: commandRun.endedAt ?? options.now().toISOString(),
  });
  options.items.update(item.id, { status: commandRun.status === 'cancelled' ? 'cancelled' : 'failed' });
  if (commandRun.status !== 'cancelled') createCommandFailureDecision(options, run, commandRun.failureReason ?? commandRun.status, 'run');
  publishChanged(options, run.taskId, item.id, 'command_failed');
}

function createCommandFailureDecision(options: TaskWorkManagementOptions, run: TaskWorkRunRecord, message: string, phase: string): void {
  options.decisions.create({
    projectId: run.projectId,
    taskId: run.taskId,
    workItemId: run.workItemId,
    runId: run.id,
    deliverableId: null,
    kind: 'command_failure',
    title: '处置失败的项目命令',
    prompt: '命令已明确失败。请检查日志后取消工作项或显式创建一次新尝试；Zeus 不会自动重发。',
    requestPayload: { phase, message },
    operationIdentity: `command-failure:${run.id}:${phase}`,
    expiresAt: null,
  });
}

function acceptDeliverable(options: TaskWorkManagementOptions, deliverable: TaskWorkDeliverableRecord, expectedRevision: number) {
  /** 验收只收口当前等待审查的运行，不能复活取消或替换后的工作。 */
  const { run, item } = requireReviewableWork(options, deliverable);
  /** 显式要求的成果类型必须有实际证据，人工验收也不能绕过部署凭证等约束。 */
  const missing = item.arrangement?.outputKinds.filter((kind) => !(deliverable.bundle?.availableKinds ?? ['document']).includes(kind)) ?? [];
  if (missing.length)
    throw new TaskWorkStoreError(
      'ZEUS_TASK_WORK_OUTPUTS_MISSING',
      `尚缺少安排要求的成果：${missing.map((kind) => ({ document: '成果说明', code: '代码差异', verification: '运行验证', deployment: '部署及后续验证凭证' })[kind]).join('、')}。请要求员工补充后再验收。`,
    );
  if (options.reviews.list(deliverable.id).some((note) => note.blocking && note.status === 'open')) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_UNRESOLVED', '这份成果仍有未解决的阻塞审查意见，请处理后再验收。');
  if (options.items.listByTask(deliverable.taskId).some((item) => item.arrangement?.parentWorkItemId === deliverable.workItemId && item.status !== 'completed'))
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_CHILDREN_PENDING', '子工作尚未全部通过审查，请完成子工作后再验收汇总。');
  const accepted = options.deliverables.transition(deliverable.id, expectedRevision, 'accepted');
  options.runs.update(run.id, { status: 'succeeded', completedAt: options.now().toISOString() });
  options.items.update(item.id, { status: 'completed', completedAt: options.now().toISOString() });
  resolveAcceptanceDecision(options, deliverable.id, { action: 'accepted' });
  options.taskEvents.create({
    taskId: deliverable.taskId,
    eventType: 'task.work_deliverable.accepted',
    title: '数字员工交付物已验收',
    payload: { workItemId: item.id, runId: run.id, deliverableId: deliverable.id, version: deliverable.version },
  });
  return { item: options.items.getById(item.id)!, run: options.runs.getById(run.id)!, deliverable: accepted };
}

function requestDeliverableChanges(options: TaskWorkManagementOptions, deliverable: TaskWorkDeliverableRecord, expectedRevision: number, reason: string) {
  /** 旧成果可以阅读，返工只能针对当前工作运行。 */
  const { run: previousRun, item } = requireReviewableWork(options, deliverable);
  const changed = options.deliverables.transition(deliverable.id, expectedRevision, 'changes_requested');
  const closedRun = options.runs.update(previousRun.id, {
    status: 'failed',
    errorCode: 'ZEUS_TASK_WORK_CHANGES_REQUESTED',
    errorMessage: reason,
    completedAt: options.now().toISOString(),
  });
  /** 返工携带原成果的明确审查位置，不只发送一句笼统要求。 */
  const reviewContext = options.reviews
    .list(deliverable.id)
    .filter((note) => note.status === 'open')
    .map((note) => `${note.anchor || '整体'}：${note.content}`)
    .join('\n');
  const next = cloneRun(options, item, closedRun, { reworkReason: [reason, reviewContext].filter(Boolean).join('\n\n') });
  options.items.update(item.id, { status: 'active', currentRunId: next.id });
  resolveAcceptanceDecision(options, deliverable.id, { action: 'changes_requested', reason });
  options.taskEvents.create({
    taskId: deliverable.taskId,
    eventType: 'task.work_deliverable.changes_requested',
    title: '数字员工交付物已要求修改',
    payload: { workItemId: item.id, previousRunId: previousRun.id, runId: next.id, deliverableId: deliverable.id, reason },
  });
  return { item: options.items.getById(item.id)!, run: next, deliverable: changed };
}

/** 统一人工与自动审查的活动运行边界，关闭后只能读取历史。 */
function requireReviewableWork(options: TaskWorkManagementOptions, deliverable: TaskWorkDeliverableRecord): { run: TaskWorkRunRecord; item: TaskWorkItemRecord } {
  const run = options.runs.getById(deliverable.runId);
  const item = options.items.getById(deliverable.workItemId);
  if (
    !run ||
    !item ||
    item.currentRunId !== run.id ||
    run.status !== 'runtime_completed' ||
    item.status !== 'waiting_manager' ||
    item.arrangement?.cancellationRequested ||
    options.isTaskTerminal(requireTaskOrThrow(options, deliverable.taskId))
  )
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVIEW_CLOSED', '这份成果不再属于当前待审工作，请重新读取任务。');
  return { run, item };
}

function retryWorkItem(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, expectedRevision: number) {
  if (item.revision !== expectedRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REVISION_CONFLICT', '工作项已更新，请刷新后重试。');
  if (!['failed', 'blocked'].includes(item.status)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_NOT_RETRYABLE', '只有失败或已明确解除阻塞的工作项可以重试。');
  const previous = item.currentRunId ? options.runs.getById(item.currentRunId) : undefined;
  if (!previous || previous.status === 'outcome_unknown') throw new TaskWorkStoreError('ZEUS_TASK_WORK_OUTCOME_UNKNOWN', '结果未知的运行不能自动重发。');
  const next = cloneRun(options, item, previous);
  const activeItem = options.items.update(item.id, { expectedRevision, status: 'active', currentRunId: next.id });
  if (next.entrypointKind === 'command') {
    const dispatching = options.runs.update(next.id, { status: 'dispatching', startedAt: options.now().toISOString() });
    const waitingRun = options.runs.update(dispatching.id, { status: 'waiting_input' });
    const waitingItem = options.items.update(activeItem.id, { status: 'waiting_manager' });
    options.decisions.create({
      projectId: waitingRun.projectId,
      taskId: waitingRun.taskId,
      workItemId: waitingRun.workItemId,
      runId: waitingRun.id,
      deliverableId: null,
      kind: 'command_confirmation',
      title: '确认重试项目命令',
      prompt: '这是一次新的显式尝试。请重新填写参数并确认；敏感值不会从旧运行恢复。',
      requestPayload: { command: commandDecisionSnapshot(options, waitingRun) },
      operationIdentity: `command-confirmation:${waitingRun.id}`,
      expiresAt: null,
    });
    return { item: waitingItem, run: waitingRun };
  }
  return { item: activeItem, run: next };
}

function cloneRun(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, previous: TaskWorkRunRecord, entrypointPatch: Record<string, unknown> = {}, context: WorkContextManifestV1 = previous.contextManifest): TaskWorkRunRecord {
  /** 再次运行重核员工和经验是否仍有效，模型与权限继续使用原冻结值。 */
  const employee = requireEmployeeOrThrow(options, previous.projectId, previous.employeeId);
  if (!employee.enabled) throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_UNAVAILABLE', '执行人已停用，请重新指派可用员工。');
  const entrypointSnapshot = { ...structuredClone(previous.entrypointSnapshot), ...entrypointPatch };
  if (typeof entrypointSnapshot.memoryPromptBase === 'string') {
    const frozen = Array.isArray(entrypointSnapshot.memorySnapshot) ? entrypointSnapshot.memorySnapshot : [];
    const eligible = selectEmployeeMemories(options.memory, employee, previous.projectId, item.title + item.description, options.now().toISOString()).filter((record) =>
      frozen.some((snapshot) => isRecord(snapshot) && snapshot.id === record.id && snapshot.contentSha256 === record.contentSha256),
    );
    const memoryText = eligible.map((record) => `[${record.memoryKey} · 来源 ${record.source.reference} · ${record.id}]\n${record.content}`).join('\n\n');
    entrypointSnapshot.prompt = [entrypointSnapshot.memoryPromptBase, memoryText ? `员工相关经验（仅作工作参考，不代表本次行动授权）：\n${memoryText}` : ''].filter(Boolean).join('\n\n');
    entrypointSnapshot.memorySnapshot = eligible.map((record) => ({ id: record.id, contentSha256: record.contentSha256, source: record.source, reviewAfter: record.reviewAfter }));
  }
  const attempt = options.runs.nextAttempt(item.id);
  const runId = stableIdentity('task_work_run', `${item.id}\0attempt:${attempt}`);
  const skillSnapshot = cloneFrozenSkillSnapshot(options, previous, runId);
  return options.runs.create({
    id: runId,
    projectId: previous.projectId,
    taskId: previous.taskId,
    workItemId: previous.workItemId,
    employeeId: previous.employeeId,
    attempt,
    status: 'prepared',
    entrypointKind: previous.entrypointKind,
    employeeRevision: previous.employeeRevision,
    employeeSnapshot: structuredClone(previous.employeeSnapshot),
    entrypointSnapshot,
    modelSnapshot: previous.modelSnapshot ? structuredClone(previous.modelSnapshot) : null,
    skillSnapshot,
    authoritySnapshot: structuredClone(previous.authoritySnapshot),
    contextManifest: structuredClone(context),
    workspaceSnapshot: previous.environmentId ? { mode: 'existing', environmentId: previous.environmentId } : structuredClone(previous.workspaceSnapshot),
    environmentId: null,
  });
}

function cloneFrozenSkillSnapshot(options: TaskWorkManagementOptions, previous: TaskWorkRunRecord, runId: string): Record<string, unknown> {
  if (!isRecord(previous.skillSnapshot) || !Array.isArray(previous.skillSnapshot.selected)) return structuredClone(previous.skillSnapshot);
  const selected = previous.skillSnapshot.selected.map((value) => {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.artifactSha256 !== 'string') throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_MISSING', '旧运行缺少可复用的冻结 Skill 资源快照。');
    const artifactOwnerId = stableIdentity('task_work_run_skill', `${runId}\0${value.id}`);
    options.artifacts.attachOwner({
      sha256: value.artifactSha256,
      owner: { kind: 'task_work_run_skill', id: artifactOwnerId, generationId: taskWorkSkillArtifactGeneration, projectId: previous.projectId },
    });
    options.artifacts.hold({ sha256: value.artifactSha256, owner: { kind: 'task_work_run_skill', id: artifactOwnerId }, ownerClass: 'active_task', reason: `task-work-skill:${runId}` });
    return { ...structuredClone(value), artifactOwnerId };
  });
  return { ...structuredClone(previous.skillSnapshot), selected };
}

function cancelWorkItem(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, expectedRevision: number) {
  const run = item.currentRunId ? options.runs.getById(item.currentRunId) : undefined;
  if (run && ['prepared', 'dispatching', 'active', 'waiting_input', 'runtime_completed'].includes(run.status)) options.runs.update(run.id, { status: 'cancelled', completedAt: options.now().toISOString() });
  const cancelled = options.items.update(item.id, { expectedRevision, status: 'cancelled' });
  for (const decision of options.decisions.listByTask(item.taskId)) if (decision.workItemId === item.id && decision.status === 'pending') options.decisions.resolve(decision.id, decision.revision, { action: 'work_cancelled' }, 'dismissed');
  return cancelled;
}

function activeTaskWorkItems(options: TaskWorkManagementOptions, taskId: string): TaskWorkItemRecord[] {
  return options.items.listByTask(taskId).filter((item) => {
    if (item.arrangement && !item.currentRunId) return false;
    const run = item.currentRunId ? options.runs.getById(item.currentRunId) : undefined;
    return run ? ['prepared', 'dispatching', 'active', 'waiting_input'].includes(run.status) : item.status === 'queued' || item.status === 'active';
  });
}

function assertPreviewFresh(preview: TaskWorkPreview, input: TaskWorkCreateInput): void {
  if (preview.previewSha256 !== input.previewSha256 || preview.expectedTaskRevision !== input.expectedTaskRevision || preview.expectedEmployeeRevision !== input.expectedEmployeeRevision) {
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_PREVIEW_STALE', '任务、员工或能力来源已变化，请重新预览后再指派。');
  }
  if (preview.blockers.length > 0) throw new TaskWorkStoreError(preview.blockers[0]!.code, preview.blockers[0]!.message);
}

/** 任务委派复用本轮执行快照，计划模式只读，缺少可核对身份时不扩大权限。 */
function readWorkToolPermission(options: TaskWorkManagementOptions, conversationId: string, submissionId: string | null): 'read-only' | 'auto' | 'full-access' {
  /** 提交身份由工具原轮次确定，不能引用其他会话的权限。 */
  const submission = submissionId ? options.conversationSubmissions.getById(submissionId) : undefined;
  /** 工作工具只读取冻结权限，不使用会话的后续草稿设置。 */
  const snapshot = submission?.conversationId === conversationId && submission.executionSnapshotId ? options.conversationExecution.getExecutionSnapshot(submission.executionSnapshotId) : undefined;
  if (snapshot?.conversationId !== conversationId) return 'read-only';
  /** 工作安排只有三种目录权限，自动审查降为人工审查不会放宽授权。 */
  const permission = effectiveToolPermission(
    snapshot.permissionMode === 'full-access' ? 'full-access' : snapshot.permissionMode === 'auto' || snapshot.permissionMode === 'auto-review' ? 'auto' : 'read-only',
    snapshot.collaborationMode === 'plan' ? 'plan' : 'default',
  );
  return permission === 'auto-review' ? 'auto' : permission;
}

/** 新写入只接纳当前进行中的原生轮次，旧轮次只允许读取已接纳回执。 */
function assertCurrentWorkToolTurn(options: TaskWorkManagementOptions, conversationId: string, turnId: string): void {
  if (options.conversationTurns.getLatestActiveByConversation(conversationId)?.id !== turnId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_TOOL_TURN_CLOSED', '该轮次已经结束，不能新增工作操作。');
}

/** 停止与等待子成果时暂停原生目标，失败只留下待核对状态，不造新的目标控制器。 */
async function pauseTaskWorkGoal(options: TaskWorkManagementOptions, run: TaskWorkRunRecord, identity: string): Promise<boolean> {
  if (!run.conversationId) return true;
  /** 只有原会话明确的状态可以核对暂停；尚未建立的目标交由派发恢复处理。 */
  const before = options.conversationGoals.get(run.conversationId);
  if (before?.status !== 'active') return true;
  const response = await options.server.inject({
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(run.projectId)}/conversations/${encodeURIComponent(run.conversationId)}/goal/pause`,
    headers: { authorization: `Bearer ${options.apiToken}` },
    payload: commandEnvelope(conversationCommandTypes.goalPause, 'product_conversation', run.conversationId, identity, {}, conversationInputSha256({})),
  });
  const after = options.conversationGoals.get(run.conversationId);
  return response.statusCode === 200 && Boolean(after && after.status !== 'active');
}

async function stopWorkItemRuntime(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, operationIdentity: string): Promise<void> {
  const run = item.currentRunId ? options.runs.getById(item.currentRunId) : undefined;
  if (run && !(await pauseTaskWorkGoal(options, run, `goal-stop:${run.id}`))) throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', '自主目标暂停尚未确认，请在原会话核对目标状态。');
  if (run?.status === 'outcome_unknown') throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', '此工作仍有未知外部结果，请先核对原会话的实际状态。');
  if (!run || !['dispatching', 'active', 'waiting_input'].includes(run.status)) return;
  if (run.entrypointKind === 'agent') {
    if (!run.conversationId) {
      if (run.status === 'dispatching') throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', 'Agent 正在派发且尚未返回耐久会话身份；结果确认前不会启动新的数字员工。');
      return;
    }
    const turns = options.conversationTurns.listByConversation(run.conversationId);
    const providerTurns = [...turns].reverse().filter((candidate) => candidate.providerTurnId);
    if (providerTurns.some(isProviderStopPendingTurn)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', '停止请求已保存，正在等待 Provider 确认原轮次终态。');
    const turn = providerTurns.find((candidate) => ['dispatching', 'running', 'waiting'].includes(candidate.status));
    if (!turn?.providerTurnId) {
      if (providerTurns[0] && ['interrupted', 'completed', 'failed'].includes(providerTurns[0].status)) return;
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_STATE_CHANGED', 'Agent 已不在可中断状态，请刷新任务后重试。');
    }
    const input = {};
    const response = await options.server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(run.projectId)}/conversations/${encodeURIComponent(run.conversationId)}/turns/${encodeURIComponent(turn.providerTurnId)}/interrupt`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: commandEnvelope(conversationDispatchCommandTypes.turnInterrupt, 'turn', turn.providerTurnId, operationIdentity, input, conversationDispatchInputSha256(input)),
    });
    if (response.statusCode !== 202) throw new TaskWorkStoreError(response.statusCode >= 500 ? 'ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN' : 'ZEUS_TASK_WORK_STOP_REJECTED', safeHttpMessage(response));
    const confirmed = options.conversationTurns.listByConversation(run.conversationId).find((candidate) => candidate.id === turn.id);
    if (!confirmed || isProviderStopPendingTurn(confirmed) || !['completed', 'interrupted', 'failed'].includes(confirmed.status)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', '停止已请求，原轮次终态尚待确认。');
    return;
  }
  if (!run.commandRunId) return;
  const commandRun = options.commandRuns.getById(run.commandRunId);
  if (!commandRun || commandRun.status === 'cancelled') return;
  if (commandRun.status === 'stopping') throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', '命令仍在停止中，结果确认前不会启动新的数字员工。');
  if (commandRun.status !== 'running') throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_STATE_CHANGED', 'Command 已不在可停止状态，请刷新任务后重试。');
  const input = {};
  const response = await options.server.inject({
    method: 'POST',
    url: `/api/command-runs/${encodeURIComponent(run.commandRunId)}/stop`,
    headers: { authorization: `Bearer ${options.apiToken}` },
    payload: commandEnvelope(commandCenterCommandTypes.runStop, 'command_run', run.commandRunId, operationIdentity, input, commandCenterInputSha256(input)),
  });
  if (response.statusCode !== 200) throw new TaskWorkStoreError(response.statusCode >= 500 ? 'ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN' : 'ZEUS_TASK_WORK_STOP_REJECTED', safeHttpMessage(response));
  if (options.commandRuns.getById(run.commandRunId)?.status !== 'cancelled') throw new TaskWorkStoreError('ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN', '命令停止已请求，正在核对实际结果。');
}

async function confirmAutomatedCommand(options: TaskWorkManagementOptions, decision: TaskWorkDecisionRecord, response: Record<string, unknown>): Promise<void> {
  const run = decision.runId ? options.runs.getById(decision.runId) : undefined;
  const item = options.items.getById(decision.workItemId);
  if (!run || !item || run.entrypointKind !== 'command' || run.status !== 'waiting_input') throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_CONFIRMATION_STALE', '命令工作项已变化，请刷新后重试。');
  const commandId = typeof run.entrypointSnapshot.commandId === 'string' ? run.entrypointSnapshot.commandId : null;
  const commandRevision = typeof run.entrypointSnapshot.commandRevision === 'number' ? run.entrypointSnapshot.commandRevision : null;
  const definition = commandId ? options.commandDefinitions.getById(commandId) : undefined;
  if (!definition || !definition.enabled || definition.revision !== commandRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_CHANGED', '命令定义已变化，请取消当前工作项并重新指派。');
  const parameters = isRecord(response.parameters) ? response.parameters : response;
  const blockers: TaskWorkPreview['blockers'] = [];
  const command = resolveCommandPreview(definition, parameters, blockers);
  if (blockers.length > 0) throw new TaskWorkStoreError(blockers[0]!.code, blockers[0]!.message, 400);
  await startCommandRun(options, item, run, parameters, { command } as TaskWorkPreview);
}

function resolveUnknownOutcome(options: TaskWorkManagementOptions, decision: TaskWorkDecisionRecord, response: Record<string, unknown>): void {
  const run = decision.runId ? options.runs.getById(decision.runId) : undefined;
  const item = options.items.getById(decision.workItemId);
  if (!run || !item || run.status !== 'outcome_unknown' || item.status !== 'blocked') throw new TaskWorkStoreError('ZEUS_TASK_WORK_OUTCOME_DECISION_STALE', '未知结果工作项已变化，请刷新后重试。');
  if (response.action === 'mark_succeeded') {
    options.runs.update(run.id, { status: 'succeeded', completedAt: options.now().toISOString() });
    options.items.update(item.id, { status: 'completed', completedAt: options.now().toISOString() });
  } else if (response.action === 'mark_failed') {
    options.runs.update(run.id, { status: 'failed', completedAt: options.now().toISOString() });
    options.items.update(item.id, { status: 'failed' });
    createCommandFailureDecision(options, run, '管理者核对现场后确认该命令失败。', 'outcome_reconciled');
  } else {
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_OUTCOME_ACTION_INVALID', '请选择“确认成功”或“确认失败”；处置不会自动重发命令。', 400);
  }
}

function retryFailedCommand(options: TaskWorkManagementOptions, decision: TaskWorkDecisionRecord, response: Record<string, unknown>): void {
  const item = options.items.getById(decision.workItemId);
  if (!item || item.status !== 'failed') throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_FAILURE_STALE', '失败工作项已变化，请刷新后重试。');
  if (response.action === 'cancel') {
    options.items.update(item.id, { expectedRevision: item.revision, status: 'cancelled' });
    return;
  }
  if (response.action === 'retry') {
    retryWorkItem(options, item, item.revision);
    return;
  }
  throw new TaskWorkStoreError('ZEUS_TASK_WORK_COMMAND_FAILURE_ACTION_INVALID', '请选择取消工作项或显式创建新尝试。', 400);
}

function commandDecisionSnapshot(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Record<string, unknown> | null {
  const commandId = typeof run.entrypointSnapshot.commandId === 'string' ? run.entrypointSnapshot.commandId : null;
  const commandRevision = typeof run.entrypointSnapshot.commandRevision === 'number' ? run.entrypointSnapshot.commandRevision : null;
  const definition = commandId ? options.commandDefinitions.getById(commandId) : undefined;
  if (!definition || definition.revision !== commandRevision) return null;
  return {
    id: definition.id,
    title: definition.title,
    revision: definition.revision,
    parameters: definition.parameters.map((parameter) => ({ key: parameter.key, label: parameter.label, description: parameter.description, type: parameter.type, required: parameter.required, sensitive: parameter.sensitive })),
  };
}

function resolveManagerDecision(options: TaskWorkManagementOptions, decision: TaskWorkDecisionRecord, expectedRevision: number, response: Record<string, unknown>) {
  if (decision.kind === 'outcome_unknown') resolveUnknownOutcome(options, decision, response);
  if (decision.kind === 'command_failure') retryFailedCommand(options, decision, response);
  const resolved = options.decisions.resolve(decision.id, expectedRevision, {
    responseSha256: sha256(canonicalJson(response)),
    responseRecordedBy: 'manager_action',
  });
  return resolved;
}

function resolveAcceptanceDecision(options: TaskWorkManagementOptions, deliverableId: string, response: Record<string, unknown>): void {
  const decision = options.decisions.listByTask(options.deliverables.getById(deliverableId)!.taskId).find((candidate) => candidate.deliverableId === deliverableId && candidate.status === 'pending');
  if (decision) options.decisions.resolve(decision.id, decision.revision, response);
}

function workManagementProjection(options: TaskWorkManagementOptions, task: ZeusTaskRecord) {
  const items = options.items.listByTask(task.id);
  const runs = options.runs.listByTask(task.id);
  const activeItems = activeTaskWorkItems(options, task.id);
  const deliverables = options.deliverables.listByTask(task.id);
  const decisions = options.decisions.listByTask(task.id);
  const managerDecisions = decisions.filter((decision) => decision.kind !== 'input_required' && decision.kind !== 'authorization');
  const conversationRequests = runs.flatMap((run) =>
    run.conversationId && (run.status === 'active' || run.status === 'waiting_input')
      ? options.conversationRequests.listPendingByConversation(run.conversationId).map((request) => ({
          id: request.id,
          conversationId: run.conversationId!,
          workItemId: run.workItemId,
          runId: run.id,
          requestKind: request.requestKind,
          createdAt: request.createdAt,
          expiresAt: request.expiresAt,
        }))
      : [],
  );
  const legacyExecutions = options.legacyExecutions.listByTask(task.id);
  return {
    plan: options.planning.get(task.id),
    summary: {
      workItems: items.length,
      activeWorkItems: activeItems.length,
      pendingActions: managerDecisions.filter((decision) => decision.status === 'pending').length + conversationRequests.length,
      submittedDeliverables: deliverables.filter((deliverable) => deliverable.status === 'submitted').length,
      legacyExecutions: legacyExecutions.length,
    },
    workItems: items.map((item) => ({
      ...item,
      runs: runs.filter((run) => run.workItemId === item.id).map((run) => ({ ...run, goal: run.conversationId ? (options.conversationGoals.get(run.conversationId) ?? null) : null })),
      deliverables: deliverables.filter((deliverable) => deliverable.workItemId === item.id),
    })),
    relationships: items.flatMap((item) => [
      ...(item.arrangement?.parentWorkItemId ? [{ kind: 'delegation', from: item.arrangement.parentWorkItemId, to: item.id }] : []),
      ...(item.arrangement?.dependencyIds ?? []).map((id) => ({ kind: 'dependency', from: id, to: item.id })),
    ]),
    conversationRequests,
    managerDecisions,
    deliverables,
    evidenceRefs: [
      ...runs.flatMap((run) =>
        [
          run.conversationId ? { kind: 'conversation', id: run.conversationId, workItemId: run.workItemId, runId: run.id } : null,
          run.commandRunId ? { kind: 'command_run', id: run.commandRunId, workItemId: run.workItemId, runId: run.id } : null,
        ].filter(Boolean),
      ),
      ...legacyExecutions.map((execution) => ({ kind: 'legacy_execution', id: execution.id, status: execution.status, executionMode: execution.executionMode, conversationId: execution.conversationId })),
    ],
    revision: sha256(
      canonicalJson({
        task: task.updatedAt,
        items: items.map((item) => [item.id, item.revision]),
        runs: runs.map((run) => [run.id, run.revision]),
        deliverables: deliverables.map((deliverable) => [deliverable.id, deliverable.revision]),
        decisions: decisions.map((decision) => [decision.id, decision.revision]),
        conversationRequests: conversationRequests.map((request) => [request.id, request.createdAt]),
      }),
    ),
  };
}

function resolveContextManifest(options: TaskWorkManagementOptions, task: ZeusTaskRecord, selectedIds: string[], blockers: TaskWorkPreview['blockers']): WorkContextManifestV1 {
  const selected = normalizeIdentities(selectedIds);
  const accepted = options.deliverables.listAcceptedByTask(task.id);
  const deliverables = selected.flatMap((id) => {
    const deliverable = accepted.find((candidate) => candidate.id === id);
    if (!deliverable) {
      blockers.push({ code: 'ZEUS_TASK_WORK_CONTEXT_DELIVERABLE_INVALID', message: `上下文交付物 ${id} 未验收或不属于当前任务。` });
      return [];
    }
    return [{ deliverableId: deliverable.id, version: deliverable.version, contentSha256: deliverable.contentSha256, title: deliverable.title }];
  });
  const source = safeJsonParse(task.sourceContextJson);
  const attachments =
    isRecord(source) && Array.isArray(source.attachments)
      ? source.attachments.flatMap((value) => (isRecord(value) && typeof value.path === 'string' ? [{ path: value.path, field: typeof value.field === 'string' ? value.field : null }] : []))
      : [];
  const project = options.projects.getById(task.projectId)!;
  const rules = projectRuleMetadata(project.localPath);
  return { version: 1, task: { id: task.id, revision: task.updatedAt, title: task.title, description: task.description, taskType: task.taskType, tags: [...task.tags] }, attachments, projectRules: rules, acceptedDeliverables: deliverables };
}

function resolveAgentModel(employee: DigitalEmployeeRecord, entrypoint: AgentEntrypointV2, selection: TaskWorkPreviewSelection, capability: Record<string, unknown>, blockers: TaskWorkPreview['blockers']): Record<string, unknown> | null {
  const models = Array.isArray(capability.models) ? capability.models.filter(isCapabilityModel) : [];
  const requested =
    selection.modelOverride?.trim() ||
    (selection.modelOverride !== null && entrypoint.modelPolicy.defaultMode === 'explicit' ? entrypoint.modelPolicy.defaultModel : null) ||
    (typeof capability.preferredModel === 'string' ? capability.preferredModel : null);
  const model = requested ? models.find((candidate) => candidate.id === requested || candidate.model === requested) : models.find((candidate) => candidate.available);
  if (!model || !model.available) {
    blockers.push({ code: 'ZEUS_TASK_WORK_MODEL_UNAVAILABLE', message: requested ? `模型 ${requested} 当前不可用。` : '项目当前没有可用模型。' });
    return null;
  }
  /** 显式调整优先，其次沿用员工默认，最后采用模型推荐值。 */
  const reasoningEffort = selection.reasoningEffort === null ? model.defaultReasoningEffort : selection.reasoningEffort?.trim() || employee.reasoningEffort || model.defaultReasoningEffort;
  if (reasoningEffort && !model.supportedReasoningEfforts.includes(reasoningEffort)) blockers.push({ code: 'ZEUS_TASK_WORK_REASONING_NOT_ALLOWED', message: '所选推理强度不受当前模型支持。' });
  /** 显式选择标准档保持清除语义；未设置时继承员工默认。 */
  const serviceTier = selection.serviceTier === null ? model.defaultServiceTier : selection.serviceTier?.trim() || employee.serviceTier || model.defaultServiceTier;
  if (serviceTier && !model.serviceTiers.some((tier) => tier.id === serviceTier)) blockers.push({ code: 'ZEUS_TASK_WORK_SERVICE_TIER_NOT_ALLOWED', message: '所选服务速率不受当前模型支持。' });
  return {
    id: model.id,
    model: model.model,
    displayName: model.displayName ?? model.model,
    agentKind: model.agentKind,
    sourceId: model.sourceId,
    sourceName: model.sourceName,
    reasoningEffort: reasoningEffort ?? null,
    serviceTier: serviceTier ?? null,
    contextWindow: model.contextWindow,
  };
}

function resolveRunAuthority(entrypoint: AgentEntrypointV2, requestedPermission: TaskWorkPreviewSelection['permissionMode']): Record<string, unknown> {
  const permissionMode = requestedPermission ?? entrypoint.authorityPolicy.permissionMode;
  return { ...entrypoint.authorityPolicy, permissionMode };
}

function resolveCommandPreview(definition: CommandDefinition, raw: Record<string, unknown>, blockers: TaskWorkPreview['blockers']): NonNullable<TaskWorkPreview['command']> {
  const normalized: Record<string, string | number | boolean> = {};
  const safe: Record<string, string | number | boolean> = {};
  for (const parameter of definition.parameters) {
    const candidate = raw[parameter.key] ?? parameter.defaultValue;
    if (candidate === undefined) {
      if (parameter.required) blockers.push({ code: 'ZEUS_TASK_WORK_COMMAND_PARAMETER_REQUIRED', message: `命令参数 ${parameter.label} 为必填项。` });
      continue;
    }
    if (!commandParameterValueMatchesType(candidate, parameter.type)) {
      blockers.push({ code: 'ZEUS_TASK_WORK_COMMAND_PARAMETER_INVALID', message: `命令参数 ${parameter.label} 类型无效。` });
      continue;
    }
    normalized[parameter.key] = candidate;
    if (!parameter.sensitive) safe[parameter.key] = candidate;
  }
  const extras = Object.keys(raw).filter((key) => !definition.parameters.some((parameter) => parameter.key === key));
  if (extras.length > 0) blockers.push({ code: 'ZEUS_TASK_WORK_COMMAND_PARAMETER_UNKNOWN', message: `命令包含未定义参数：${extras.join('、')}。` });
  return {
    id: definition.id,
    title: definition.title,
    revision: definition.revision,
    parameters: definition.parameters.map((parameter) => ({
      key: parameter.key,
      label: parameter.label,
      description: parameter.description,
      type: parameter.type,
      required: parameter.required,
      sensitive: parameter.sensitive,
      hasValue: normalized[parameter.key] !== undefined,
    })),
    safeParameterSnapshot: safe,
    parameterDigest: sha256(canonicalJson(normalized)),
    riskFlags: definition.riskFlags,
  };
}

async function snapshotSkill(skill: { id: string; name: string; description: string; path: string }): Promise<TaskWorkPreview['skills'][number]> {
  return (await readSkillResourceSnapshot(skill)).metadata;
}

async function readSkillResourceSnapshot(skill: { id: string; name: string; description: string; path: string }): Promise<PreparedSkillResourceSnapshot> {
  const root = resolve(dirname(skill.path));
  let fileCount = 0;
  let totalBytes = 0;
  const files: PreparedSkillResourceSnapshot['files'] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_UNSAFE', `Skill 包含符号链接：${relative(root, path)}`);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) {
        fileCount += 1;
        totalBytes += stat.size;
        if (fileCount > maximumSkillSnapshotFiles || totalBytes > maximumSkillSnapshotBytes) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_TOO_LARGE', 'Skill 资源超出运行快照限制。');
        const content = await readFile(path);
        files.push({ path: relative(root, path), sha256: sha256(content), bytes: stat.size, contentBase64: content.toString('base64') });
      }
    }
  };
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const digests = files.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes }));
  return {
    metadata: { source: 'skill', id: skill.id, name: skill.name, description: skill.description, directoryName: basename(root), contentSha256: sha256(canonicalJson(digests)), resourceCount: fileCount, totalBytes },
    files,
  };
}

async function prepareSkillResourceSnapshots(options: TaskWorkManagementOptions, task: ZeusTaskRecord, preview: TaskWorkPreview): Promise<PreparedSkillResourceSnapshot[]> {
  const nativeSkills = preview.skills.filter((skill): skill is TaskWorkNativeSkillPreview => skill.source === 'skill');
  if (nativeSkills.length === 0) return [];
  if (!options.skills) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_CATALOG_UNAVAILABLE', 'Zeus Skill 目录当前不可用。');
  const project = options.projects.getById(task.projectId);
  if (!project) throw new TaskWorkStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
  const snapshots: PreparedSkillResourceSnapshot[] = [];
  for (const expected of nativeSkills) {
    const skill = await options.skills.resolve({ cwd: project.localPath, skillId: expected.id });
    const snapshot = await readSkillResourceSnapshot(skill);
    if (snapshot.metadata.contentSha256 !== expected.contentSha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PREVIEW_STALE', `Skill ${expected.name} 已变化，请重新预览后再指派。`);
    snapshots.push(snapshot);
  }
  return snapshots;
}

function persistSkillResourceSnapshots(options: TaskWorkManagementOptions, runId: string, projectId: string, snapshots: PreparedSkillResourceSnapshot[], pluginSkills: TaskWorkPluginSkillPreview[]): Record<string, unknown> {
  const selected = snapshots.map((snapshot) => {
    const artifactOwnerId = stableIdentity('task_work_run_skill', `${runId}\0${snapshot.metadata.id}`);
    const artifact = options.artifacts.putJsonSync({
      value: { version: 1, skill: snapshot.metadata, files: snapshot.files },
      owner: { kind: 'task_work_run_skill', id: artifactOwnerId, generationId: taskWorkSkillArtifactGeneration, projectId },
    });
    options.artifacts.hold({ sha256: artifact.sha256, owner: { kind: 'task_work_run_skill', id: artifactOwnerId }, ownerClass: 'active_task', reason: `task-work-skill:${runId}` });
    const snapshotPath = frozenSkillPath(options.skillSnapshotRoot, runId, snapshot.metadata.id);
    materializeFrozenSkill(snapshotPath, snapshot.files);
    return { ...snapshot.metadata, artifactSha256: artifact.sha256, artifactContentSha256: artifact.contentSha256, artifactOwnerId, snapshotPath };
  });
  return { generation: taskWorkSkillArtifactGeneration, selected, pluginSkills };
}

async function resolveFrozenPluginSkillReferences(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Promise<Array<{ kind: 'skill'; id: string }>> {
  const selected = isRecord(run.skillSnapshot) && Array.isArray(run.skillSnapshot.pluginSkills) ? run.skillSnapshot.pluginSkills : [];
  if (selected.length === 0) return [];
  if (!options.plugins) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLUGIN_SKILL_CATALOG_UNAVAILABLE', 'Zeus Plugin Skill 目录当前不可用。');
  const available = await options.plugins.listSkills({ projectId: run.projectId });
  return selected.map((value) => {
    if (!isRecord(value) || value.source !== 'plugin' || typeof value.id !== 'string' || typeof value.pluginRevisionId !== 'string') {
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLUGIN_SKILL_SNAPSHOT_INVALID', '运行缺少可信的 Plugin Skill 快照。');
    }
    const current = available.find((candidate) => candidate.id === value.id);
    if (!current) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLUGIN_SKILL_UNAVAILABLE', `Plugin Skill ${value.id} 在当前项目不可用。`);
    if (current.pluginRevisionId !== value.pluginRevisionId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLUGIN_SKILL_SNAPSHOT_STALE', `Plugin Skill ${current.namespace} 已更新；本次运行不会静默改用新版本。`);
    return { kind: 'skill', id: value.id };
  });
}

function verifyFrozenSkillResources(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): void {
  const selected = isRecord(run.skillSnapshot) && Array.isArray(run.skillSnapshot.selected) ? run.skillSnapshot.selected.filter(isRecord) : [];
  for (const skill of selected) {
    if (typeof skill.artifactSha256 !== 'string' || typeof skill.artifactOwnerId !== 'string') throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_MISSING', '运行缺少冻结的 Skill 资源快照。');
    const stored = options.artifacts.readAuthorizedSync({
      sha256: skill.artifactSha256,
      owner: { kind: 'task_work_run_skill', id: skill.artifactOwnerId },
      maximumContentBytes: Math.ceil(maximumSkillSnapshotBytes * 1.5),
    });
    if (typeof skill.artifactContentSha256 !== 'string' || stored.ref.contentSha256 !== skill.artifactContentSha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT', '冻结的 Skill 资源快照完整性校验失败。');
    const bundle = safeJsonParse(Buffer.from(stored.bytes).toString('utf8'));
    const files = isRecord(bundle) && Array.isArray(bundle.files) ? normalizeFrozenSkillFiles(bundle.files) : null;
    if (!files || typeof skill.snapshotPath !== 'string') throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT', '冻结的 Skill 资源清单不可读取。');
    const expectedPath = frozenSkillPath(options.skillSnapshotRoot, run.id, typeof skill.id === 'string' ? skill.id : 'invalid');
    const reusablePath = run.attempt > 1 && resolve(skill.snapshotPath).startsWith(`${resolve(options.skillSnapshotRoot)}${process.platform === 'win32' ? '\\' : '/'}`) ? resolve(skill.snapshotPath) : expectedPath;
    if (resolve(skill.snapshotPath) !== reusablePath) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_PATH_INVALID', '冻结的 Skill 资源路径不可信。');
    materializeFrozenSkill(reusablePath, files);
  }
}

function normalizeFrozenSkillFiles(values: unknown[]): PreparedSkillResourceSnapshot['files'] | null {
  const files = values.flatMap((value) => {
    if (!isRecord(value) || typeof value.path !== 'string' || typeof value.sha256 !== 'string' || typeof value.bytes !== 'number' || typeof value.contentBase64 !== 'string') return [];
    return [{ path: value.path, sha256: value.sha256, bytes: value.bytes, contentBase64: value.contentBase64 }];
  });
  return files.length === values.length ? files : null;
}

function frozenSkillPath(root: string, runId: string, skillId: string): string {
  return join(resolve(root), sha256(runId).slice(0, 32), sha256(skillId).slice(0, 32));
}

function materializeFrozenSkill(snapshotPath: string, files: PreparedSkillResourceSnapshot['files']): void {
  const root = resolve(snapshotPath);
  if (existsSync(root)) {
    for (const file of files) {
      const path = safeFrozenSkillFile(root, file.path);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || sha256(readFileSync(path)) !== file.sha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT', `冻结的 Skill 文件已变化：${file.path}`);
    }
    makeFrozenSkillReadOnly(root, files);
    return;
  }
  const staging = `${root}.staging-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    for (const file of files) {
      const path = safeFrozenSkillFile(staging, file.path);
      const content = Buffer.from(file.contentBase64, 'base64');
      if (content.byteLength !== file.bytes || sha256(content) !== file.sha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT', `冻结的 Skill Artifact 无法验证：${file.path}`);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
    }
    mkdirSync(dirname(root), { recursive: true, mode: 0o700 });
    renameSync(staging, root);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(root)) {
      materializeFrozenSkill(root, files);
      return;
    }
    throw error;
  }
  makeFrozenSkillReadOnly(root, files);
}

function makeFrozenSkillReadOnly(root: string, files: PreparedSkillResourceSnapshot['files']): void {
  const directories = new Set<string>([root]);
  for (const file of files) {
    const path = safeFrozenSkillFile(root, file.path);
    chmodSync(path, 0o400);
    let directory = dirname(path);
    while (directory.startsWith(`${root}${process.platform === 'win32' ? '\\' : '/'}`)) {
      directories.add(directory);
      directory = dirname(directory);
    }
  }
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) chmodSync(directory, 0o500);
}

function safeFrozenSkillFile(root: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0')) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT', '冻结的 Skill 资源路径无效。');
  const path = resolve(root, relativePath);
  const canonicalRoot = resolve(root);
  if (!path.startsWith(`${canonicalRoot}${process.platform === 'win32' ? '\\' : '/'}`)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_SNAPSHOT_CORRUPT', '冻结的 Skill 资源路径越界。');
  return path;
}

function recordActuallyEnabledSkills(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): void {
  if (!run.conversationId) return;
  const selected = isRecord(run.skillSnapshot) && Array.isArray(run.skillSnapshot.selected) ? run.skillSnapshot.selected.filter(isRecord) : [];
  if (selected.length === 0) return;
  const readDirectories = new Set<string>();
  for (const processItem of options.conversationExecution.snapshot(run.conversationId).process) {
    for (const path of skillManifestPaths(safeJsonParse(processItem.detailJson))) {
      const segments = path.split(/[\\/]/u).filter(Boolean);
      if (segments.length >= 2) readDirectories.add(segments[segments.length - 2]!);
    }
  }
  const enabled = selected.flatMap((skill) => {
    const snapshotDirectory = typeof skill.snapshotPath === 'string' ? basename(skill.snapshotPath) : null;
    return typeof skill.id === 'string' && snapshotDirectory && readDirectories.has(snapshotDirectory) ? [skill.id] : [];
  });
  if (canonicalJson(enabled) !== canonicalJson(run.enabledSkillIds)) options.runs.update(run.id, { enabledSkillIds: enabled });
}

function skillManifestPaths(value: unknown): string[] {
  if (typeof value === 'string') return /(^|[\\/])SKILL\.md$/u.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(skillManifestPaths);
  if (isRecord(value)) return Object.values(value).flatMap(skillManifestPaths);
  return [];
}

async function buildAgentSupplementalInfo(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Promise<string> {
  return buildAgentSupplementalInfoSnapshot(options, {
    employee: run.employeeSnapshot,
    entrypoint: run.entrypointSnapshot,
    context: run.contextManifest,
    skills: isRecord(run.skillSnapshot) ? [...(Array.isArray(run.skillSnapshot.selected) ? run.skillSnapshot.selected : []), ...(Array.isArray(run.skillSnapshot.pluginSkills) ? run.skillSnapshot.pluginSkills : [])] : [],
  });
}

async function buildAgentSupplementalInfoSnapshot(options: TaskWorkManagementOptions, input: { employee: { name?: unknown }; entrypoint: Record<string, unknown>; context: WorkContextManifestV1; skills: unknown[] }): Promise<string> {
  const selectedContent: string[] = [];
  for (const ref of input.context.acceptedDeliverables) {
    const deliverable = options.deliverables.getById(ref.deliverableId);
    if (!deliverable || deliverable.status !== 'accepted' || deliverable.version !== ref.version || deliverable.contentSha256 !== ref.contentSha256)
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONTEXT_CHANGED', '已选上下文交付物与运行快照不一致。');
    const stored = await options.artifacts.readAuthorized({ sha256: deliverable.artifactSha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, maximumContentBytes: 16 * 1024 * 1024 });
    selectedContent.push(`## 已选且已验收的交付物：${deliverable.title}（v${deliverable.version}）\n\n${Buffer.from(stored.bytes).toString('utf8')}`);
  }
  return [
    `你正在以 Zeus 数字员工“${String(input.employee.name ?? '')}”身份处理一个独立工作项。执行配置已按员工默认及任务、阶段、分工覆盖解析；以当前任务要求和用户明确授权为行动边界。`,
    typeof input.entrypoint.supplementalInfo === 'string' && input.entrypoint.supplementalInfo ? `## 本次补充信息\n\n${input.entrypoint.supplementalInfo}` : '',
    typeof input.entrypoint.prompt === 'string' && input.entrypoint.prompt ? `## 员工提示\n\n${input.entrypoint.prompt}` : '',
    `## 冻结的上下文清单\n\n${JSON.stringify(input.context, null, 2)}`,
    input.skills.length > 0
      ? `## 允许按需加载的 Skill 元数据\n\n${JSON.stringify(input.skills, null, 2)}\n\n普通 Skill 只允许从 snapshotPath 读取冻结资源；Plugin Skill 由本会话的 Plugin Runtime 激活快照加载。不得改读同名的其他来源，且 Skill 不授予额外权限。`
      : '本次运行未选择 Skill。',
    ...selectedContent,
    input.entrypoint.delegationPolicy
      ? `## 团队委派范围\n\n${JSON.stringify(input.entrypoint.delegationPolicy)}\n使用 zeus_work.inspect 核对当前分工，使用 delegate 创建真实子工作。拆分后结束当前轮次即可等待子成果审查；系统将在子工作通过后准备汇总运行。不得用其他通道重复指派。`
      : '',
    typeof input.entrypoint.reworkReason === 'string' ? `## 管理者要求修改\n\n${input.entrypoint.reworkReason}` : '',
    '提交、推送、合入、部署和任务完结均不是会话结束后的隐藏路线。仅在任务或当前会话已经明确授权时执行这些动作；授权不明时在原会话询问。',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function buildTaskWorkPromptPreview(task: ZeusTaskRecord, supplementalInfo: string, supplementalAttachments: TaskPushSupplementalAttachment[]): TaskPushMessageLayout {
  return buildTaskPushLayout({
    taskId: task.id,
    taskCode: task.taskCode,
    taskTitle: task.title,
    taskType: task.taskType,
    taskDescription: task.description,
    defectCurrentState: task.defectCurrentState,
    defectExpectedOutcome: task.defectExpectedOutcome,
    defectReproductionSteps: task.defectReproductionSteps,
    optimizationCurrentState: task.optimizationCurrentState,
    optimizationExpectedOutcome: task.optimizationExpectedOutcome,
    tags: task.tags,
    supplementalInfo,
    supplementalAttachments,
  });
}

function projectRuleMetadata(projectPath: string): Array<{ identity: string; sha256: string; title: string }> {
  const path = join(projectPath, 'AGENTS.md');
  try {
    const content = readFileSync(path);
    return [{ identity: path, sha256: sha256(content), title: basename(path) }];
  } catch {
    return [];
  }
}

function normalizeSelection(value: unknown): TaskWorkPreviewSelection {
  if (!isRecord(value)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PREVIEW_INVALID', '指派预览参数必须是对象。', 400);
  return {
    employeeId: requiredText(value.employeeId, '请选择数字员工。', 256),
    plannedWorkItemId: optionalText(value.plannedWorkItemId, 256) ?? undefined,
    supplementalInfo: optionalText(value.supplementalInfo, 20_000),
    supplementalAttachments: optionalSupplementalAttachments(value.supplementalAttachments),
    modelOverride: optionalText(value.modelOverride, 256),
    reasoningEffort: optionalText(value.reasoningEffort, 64),
    serviceTier: value.serviceTier === null ? null : optionalText(value.serviceTier, 64),
    workMode: optionalMember(value.workMode, ['default', 'plan'] as const, '工作模式无效。'),
    permissionMode: optionalMember(value.permissionMode, ['read-only', 'auto', 'full-access'] as const, '权限模式无效。'),
    promptOverride: optionalText(value.promptOverride, 20_000),
    skillIds: Array.isArray(value.skillIds) ? normalizeIdentities(value.skillIds) : undefined,
    selectedDeliverableIds: Array.isArray(value.selectedDeliverableIds) ? normalizeIdentities(value.selectedDeliverableIds) : undefined,
    workspace: normalizeTaskWorkWorkspaceChoice(value.workspace),
  };
}

function optionalSupplementalAttachments(value: unknown): TaskWorkSupplementalAttachmentInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INPUT_INVALID', '补充附件必须是不超过 100 项的数组。', 400);
  return structuredClone(value) as TaskWorkSupplementalAttachmentInput[];
}

function resolveTaskWorkSupplementalAttachments(options: TaskWorkManagementOptions, value: TaskWorkSupplementalAttachmentInput[] | undefined, projectLocalPath: string): TaskPushSupplementalAttachment[] {
  try {
    return options.normalizeTaskPushSupplementalAttachments(value, projectLocalPath).promptAttachments;
  } catch (error) {
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_INPUT_INVALID', serializeError(error).message, 400);
  }
}

function normalizeTaskWorkWorkspaceChoice(value: unknown): TaskWorkWorkspaceChoice | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || (value.mode !== 'create' && value.mode !== 'existing' && value.mode !== 'local')) throw new TaskWorkStoreError('ZEUS_TASK_WORK_WORKSPACE_INVALID', '代码现场选择无效。', 400);
  if (value.mode === 'create') return { mode: 'create' };
  if (value.mode === 'local') return { mode: 'local', branchName: requiredText(value.branchName, '请选择已有本地任务分支。', 512) };
  return { mode: 'existing', environmentId: requiredText(value.environmentId, '请选择已有任务环境。', 512) };
}

function sanitizeEntrypoint(entrypoint: AgentEntrypointV2): Record<string, unknown> {
  return { kind: 'agent', prompt: entrypoint.prompt, agentKind: entrypoint.agentKind, modelPolicy: entrypoint.modelPolicy, skillPolicy: entrypoint.skillPolicy, authorityPolicy: entrypoint.authorityPolicy };
}

function commandEnvelope<T extends object>(
  commandType: string,
  scopeKind: 'command_run' | 'approval' | 'turn' | 'task' | 'product_conversation',
  scopeId: string,
  operationIdentity: string,
  input: T,
  inputSha256: string,
): { command: CommandEnvelope<{ operationIdentity: string; inputSha256: string }>; input: T } {
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: stableIdentity('command_task_work', `${commandType}\0${operationIdentity}`),
      commandType,
      actor: { kind: 'worker', id: 'task-work-management' },
      scope: { kind: scopeKind, id: scopeId },
      expectedRevision: null,
      idempotencyKey: `${commandType}:${operationIdentity}`,
      issuedAt: stableIssuedAt(operationIdentity),
      payload: { operationIdentity, inputSha256 },
    },
    input,
  };
}

function publishChanged(options: TaskWorkManagementOptions, taskId: string, workItemId: string, reason: string): void {
  options.publishRealtimeEvent('task.work_management.changed', { taskId, workItemId, reason });
}
function requireTask(options: TaskWorkManagementOptions, taskId: string, reply: FastifyReply): ZeusTaskRecord | undefined {
  const task = options.tasks.getById(taskId);
  if (!task) void reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: '任务不存在。' });
  return task;
}
function requireTaskOrThrow(options: TaskWorkManagementOptions, taskId: string): ZeusTaskRecord {
  const task = options.tasks.getById(taskId);
  if (!task) throw new TaskWorkStoreError('ZEUS_TASK_NOT_FOUND', '任务不存在。', 404);
  return task;
}
function requireEmployeeOrThrow(options: TaskWorkManagementOptions, projectId: string, employeeId: string): DigitalEmployeeRecord {
  const employee = options.employees.getById(employeeId);
  if (!employee || employee.projectId !== projectId) throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '数字员工不存在。', 404);
  return employee;
}
function requireOwnedItem(options: TaskWorkManagementOptions, taskId: string, itemId: string): TaskWorkItemRecord {
  const item = options.items.getById(itemId);
  if (!item || item.taskId !== taskId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ITEM_NOT_FOUND', '工作项不存在。', 404);
  return item;
}
function requireOwnedDeliverable(options: TaskWorkManagementOptions, taskId: string, deliverableId: string): TaskWorkDeliverableRecord {
  const deliverable = options.deliverables.getById(deliverableId);
  if (!deliverable || deliverable.taskId !== taskId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELIVERABLE_NOT_FOUND', '交付物不存在。', 404);
  return deliverable;
}
function requireOwnedDecision(options: TaskWorkManagementOptions, taskId: string, decisionId: string): TaskWorkDecisionRecord {
  const decision = options.decisions.getById(decisionId);
  if (!decision || decision.taskId !== taskId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DECISION_NOT_FOUND', '管理者待办不存在。', 404);
  return decision;
}

async function route(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TaskWorkStoreError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    const mapped = workManagementCommandHttpError(error);
    if (mapped) return reply.code(mapped.statusCode).send(mapped.payload);
    throw error;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isCapabilityModel(value: unknown): value is ConversationCapabilityModel {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.model === 'string' &&
    (value.agentKind === 'codex' || value.agentKind === 'pi') &&
    typeof value.available === 'boolean' &&
    Array.isArray(value.supportedReasoningEfforts) &&
    Array.isArray(value.serviceTiers)
  );
}
function normalizeIdentities(value: unknown[]): string[] {
  return [...new Set(value.map((entry) => requiredText(entry, '身份无效。', 512)))];
}
/** 数字团队来源使用稳定前缀隔离，旧线性工作调度器不得接管。 */
function isDigitalTeamWorkItem(item: TaskWorkItemRecord): boolean {
  return item.source === 'manual' && item.sourceRef?.startsWith('digital-team:') === true;
}
function requiredText(value: unknown, message: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INPUT_INVALID', message, 400);
  return value.trim();
}
function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return requiredText(value, '参数无效。', maximum);
}
function optionalMember<const Values extends readonly string[]>(value: unknown, values: Values, message: string): Values[number] | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !values.includes(value)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INPUT_INVALID', message, 400);
  return value as Values[number];
}
function stableIdentity(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 32)}`;
}
function stableIssuedAt(identity: string): string {
  const seconds = Number.parseInt(sha256(identity).slice(0, 8), 16);
  return new Date(Date.UTC(2020, 0, 1) + seconds * 1_000).toISOString();
}
function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function summarize(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 300 ? normalized : `${normalized.slice(0, 297)}…`;
}
function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
function serializeError(error: unknown): { code: string; message: string } {
  if (error instanceof Error) return { code: typeof Reflect.get(error, 'code') === 'string' ? String(Reflect.get(error, 'code')) : 'ZEUS_TASK_WORK_FAILED', message: error.message.slice(0, 4_000) };
  return { code: 'ZEUS_TASK_WORK_FAILED', message: String(error).slice(0, 4_000) };
}
function safeHttpMessage(response: { body: string; statusCode: number }): string {
  try {
    const value: unknown = JSON.parse(response.body);
    if (isRecord(value) && typeof value.message === 'string') return value.message.slice(0, 4_000);
  } catch {
    /* 只返回有界文本。 */
  }
  return `HTTP ${response.statusCode}`;
}

/** 配置只接纳实际支持的字段，不将未知 JSON 当作权限或执行能力。 */
export function normalizeWorkSettings(value: unknown): EmployeeWorkSettings {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SETTINGS_INVALID', '工作配置必须是有效对象。', 400);
  const allowed = ['autonomyObjective', 'delegation', 'modelOverride', 'reasoningEffort', 'serviceTier', 'workMode', 'permissionMode', 'skillIds', 'promptOverride'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SETTINGS_INVALID', '工作配置包含不支持的选项。', 400);
  const result: EmployeeWorkSettings = {};
  if (value.delegation !== undefined) {
    /** 委派范围与拆分预算必须显式提供；空成员表示本层关闭委派。 */
    const policy = value.delegation;
    if (
      !isRecord(policy) ||
      !Array.isArray(policy.employeeIds) ||
      policy.employeeIds.length > 24 ||
      !Number.isInteger(policy.maxDepth) ||
      Number(policy.maxDepth) < 1 ||
      Number(policy.maxDepth) > 4 ||
      !Number.isInteger(policy.maxWorkItems) ||
      Number(policy.maxWorkItems) < 1 ||
      Number(policy.maxWorkItems) > 48
    )
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_SETTINGS_INVALID', '委派需要明确成员、1 到 4 层拆分和 1 到 48 份分工预算。', 400);
    result.delegation = { employeeIds: normalizeIdentities(policy.employeeIds), maxDepth: Number(policy.maxDepth), maxWorkItems: Number(policy.maxWorkItems) };
  }
  for (const key of ['autonomyObjective', 'modelOverride', 'reasoningEffort', 'serviceTier', 'promptOverride'] as const)
    if (key in value) result[key] = value[key] === null ? null : requiredText(value[key], '配置文本无效。', key === 'promptOverride' ? 20_000 : key === 'autonomyObjective' ? 4_000 : 256);
  if (value.workMode !== undefined) result.workMode = optionalMember(value.workMode, ['default', 'plan'] as const, '工作模式无效。') ?? undefined;
  if (value.permissionMode !== undefined) result.permissionMode = optionalMember(value.permissionMode, ['read-only', 'auto', 'full-access'] as const, '权限模式无效。') ?? undefined;
  if (value.skillIds !== undefined) {
    if (!Array.isArray(value.skillIds)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SETTINGS_INVALID', '技能必须为身份列表。', 400);
    result.skillIds = normalizeIdentities(value.skillIds);
  }
  return result;
}

/** 阶段安排在存储前完整规范化，保留用户明确填写的目标和交付条件。 */
function normalizeWorkStages(value: unknown): EmployeeWorkStageInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '请安排 1 到 12 个阶段。', 400);
  return value.map((stage) => {
    if (!isRecord(stage) || !Array.isArray(stage.assignments) || !stage.assignments.length || stage.assignments.length > 24) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '每个阶段需要 1 到 24 份明确分工。', 400);
    if (!stage.assignments.some((assignment) => isRecord(assignment) && assignment.required !== false)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '每个阶段至少需要一份必要分工。', 400);
    if (stage.acceptanceMode === 'checked' && (!Array.isArray(stage.verificationCommands) || !stage.verificationCommands.length)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '自动接纳需要至少一条明确的验证命令。', 400);
    return {
      title: requiredText(stage.title, '请填写阶段名称。', 240),
      description: optionalText(stage.description, 4_000) ?? '',
      settings: normalizeWorkSettings(stage.settings),
      requiredSkillIds: Array.isArray(stage.requiredSkillIds) ? normalizeIdentities(stage.requiredSkillIds) : [],
      advanceMode: optionalMember(stage.advanceMode, ['manual', 'auto'] as const, '阶段推进方式无效。') ?? 'auto',
      verificationCommands: Array.isArray(stage.verificationCommands) ? stage.verificationCommands.map((command) => requiredText(command, '验证命令不能为空。', 2_000)).slice(0, 16) : [],
      acceptanceMode: optionalMember(stage.acceptanceMode, ['manual', 'checked'] as const, '成果接纳方式无效。') ?? 'manual',
      assignments: stage.assignments.map((assignment) => {
        if (!isRecord(assignment)) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '分工内容无效。', 400);
        const outputKinds = Array.isArray(assignment.outputKinds) ? assignment.outputKinds : ['document'];
        if (!outputKinds.length || outputKinds.some((kind) => !['document', 'code', 'verification', 'deployment'].includes(String(kind)))) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PLAN_INVALID', '请选择实际需要的成果类型。', 400);
        return {
          title: requiredText(assignment.title, '请填写分工目标。', 240),
          description: requiredText(assignment.description, '请填写工作边界与完成标准。', 4_000),
          employeeId: optionalText(assignment.employeeId, 256) ?? null,
          role: optionalText(assignment.role, 240) ?? '',
          settings: normalizeWorkSettings(assignment.settings),
          required: assignment.required !== false,
          outputKinds: outputKinds as EmployeeWorkStageInput['assignments'][number]['outputKinds'],
        };
      }),
    };
  });
}
