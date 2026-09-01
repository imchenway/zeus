import {createHash, randomUUID} from 'node:crypto';
import {
    type CommandActor,
    type CommandEnvelope,
    commandEnvelopeSchemaGeneration,
    type CommandScopeKind,
    splitZeusSkillIds,
    type TaskManagementStatus
} from '@zeus/shared';
import {
    CommandRunRepository,
    ConversationRepository,
    ConversationSubmissionRepository,
    type DigitalEmployeeAutomationRecord,
    DigitalEmployeeAutomationRepository,
    type DigitalEmployeeExecutionRecord,
    DigitalEmployeeExecutionRepository,
    type DigitalEmployeeExecutionSource,
    type DigitalEmployeeProjectEvent,
    DigitalEmployeeProjectEventRepository,
    type DigitalEmployeeRecord,
    DigitalEmployeeRepository,
    ProjectRepository,
    TaskEventRepository,
    TaskIntegrationRepository,
    TaskRepository,
    TaskStageRepository,
    TaskWorkspaceRepository,
    type ZeusProjectRecord,
    type ZeusTaskRecord,
    type ZeusTaskStageRecord,
    type ZeusTaskWorkspaceRecord,
} from '@zeus/storage';
import type {FastifyInstance} from 'fastify';
import {commandCenterCommandTypes, commandCenterInputSha256} from './commandCenterCommandApplication.js';
import type {ConversationCapabilityQueryApplication} from './conversationCapabilityQueryApplication.js';
import {conversationWorkExecutionState} from './conversationWorkExecutionState.js';
import type {TaskStageApplication} from './taskStageApplication.js';
import type {CreateUserTaskInput} from './workManagementCoreCommandRoutes.js';
import {
    type ParsedWorkManagementMutation,
    WorkManagementCommandApplication,
    workManagementCommandTypes,
    workManagementInputSha256
} from './workManagementCommandApplication.js';
import {
    WorkspaceGitCommandApplication,
    type WorkspaceGitCommandType,
    workspaceGitCommandTypes,
    workspaceGitInputSha256,
    type WorkspaceGitScopeKind
} from './workspaceGitCommandApplication.js';
import type {PreparedWorkspaceGitCommand, WorkspaceGitCommandRouteOperations} from './workspaceGitCommandRoutes.js';
import type {TaskWorkManagementController} from './taskWorkManagement.js';

const DEFAULT_TICK_MS = 10_000;
const LEASE_MS = 45_000;
const MAX_EVENTS_PER_RULE_TICK = 20;
const MAX_AUTOMATION_CHAIN_DEPTH = 4;

interface DigitalEmployeeOrchestratorOptions {
  server: FastifyInstance;
  apiToken: string;
  workManagement: WorkManagementCommandApplication;
  workspaceGit: WorkspaceGitCommandApplication;
  workspaceGitOperations: WorkspaceGitCommandRouteOperations;
  employees: DigitalEmployeeRepository;
  automations: DigitalEmployeeAutomationRepository;
  executions: DigitalEmployeeExecutionRepository;
  projectEvents: DigitalEmployeeProjectEventRepository;
  projects: ProjectRepository;
  tasks: TaskRepository;
  taskEvents: TaskEventRepository;
  taskIntegrations: Pick<TaskIntegrationRepository, 'listByTask'>;
  taskWorkspaces: TaskWorkspaceRepository;
  stages: TaskStageRepository;
  taskStageApplication: TaskStageApplication;
  conversations: ConversationRepository;
    conversationSubmissions: ConversationSubmissionRepository;
  commandRuns: CommandRunRepository;
  conversationCapabilities: ConversationCapabilityQueryApplication;
  taskWorkManagement: TaskWorkManagementController;
  executeTaskConversationIdempotent(project: ZeusProjectRecord, task: ZeusTaskRecord, body: Record<string, unknown>, idempotencyKey: string): Promise<{ statusCode: number; body: unknown }>;
  readTaskWorkspaceSnapshot(project: ZeusProjectRecord, workspace: ZeusTaskWorkspaceRecord): Promise<Record<string, unknown>>;
  createTask(input: CreateUserTaskInput, taskId: string, context: { commandId: string; operationIdentity: string; actor: CommandActor }): ZeusTaskRecord;
  resolveDefaultManagementStatus(projectId: string): TaskManagementStatus;
  resolveCompletedManagementStatus(projectId: string): TaskManagementStatus;
  isTaskTerminal(task: ZeusTaskRecord): boolean;
  appendAuditLog(input: { actorType: string; actorRef?: string; action: string; resourceType: string; resourceId?: string; payload: Record<string, unknown>; createdAt?: string }): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): unknown;
  save(): Promise<void>;
  now?(): Date;
  tickMs?: number;
}

export interface DigitalEmployeeOrchestrator {
  kick(): void;
  close(): Promise<void>;
}

/**
 * 数字员工执行器只消费耐久工作与游标。每次 tick 有界、同一时刻只运行一个批次；
 * Provider/Git/命令中心写入均走既有 Command ledger，结果未知时禁止自动补发。
 */
export function createDigitalEmployeeOrchestrator(options: DigitalEmployeeOrchestratorOptions): DigitalEmployeeOrchestrator {
  const owner = `digital-employee-orchestrator:${randomUUID()}`;
  const now = options.now ?? (() => new Date());
  const tickMs = Math.max(2_000, Math.min(60_000, options.tickMs ?? DEFAULT_TICK_MS));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let closed = false;

  const schedule = (delay = tickMs) => {
    if (closed || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, delay);
    timer.unref?.();
  };

  const run = async () => {
    if (closed) return;
    if (active) {
      schedule();
      return;
    }
    active = tick()
      .catch((error) => {
        options.appendAuditLog({
          actorType: 'worker',
          actorRef: owner,
          action: 'digital_employee.orchestrator.tick_failed',
          resourceType: 'digital_employee_orchestrator',
          resourceId: owner,
          payload: { error: serializeError(error) },
          createdAt: now().toISOString(),
        });
      })
      .finally(() => {
        active = null;
        schedule();
      });
    await active;
  };

  async function tick(): Promise<void> {
    await processAutomations();
    await processTaskPool();
    for (const candidate of options.executions.listRecoverable(50)) {
      if (closed) return;
      const lease = options.executions.claim(candidate.id, owner, new Date(now().getTime() + LEASE_MS).toISOString());
      if (!lease) continue;
      try {
        await processExecution(lease);
      } catch (error) {
        await failExecution(lease, error);
      } finally {
        options.executions.releaseLease(lease.id, owner);
        await options.save();
      }
    }
  }

  async function processAutomations(): Promise<void> {
    const timestamp = now();
    for (const automation of options.automations.listEnabled()) {
      try {
        const employee = options.employees.getById(automation.employeeId);
        if (!employee?.enabled || employee.projectId !== automation.projectId) continue;
        if (automation.actionKind === 'explore_project' && !employee.autonomousExploration) continue;
        if (automation.nextRunAt && Date.parse(automation.nextRunAt) <= timestamp.getTime()) {
          const identity = `scheduled:${automation.nextRunAt}`;
          const triggered = await triggerAutomation(automation, employee, identity, null);
          if (triggered) {
            options.automations.advance({
              id: automation.id,
              nextRunAt: nextScheduledRun(automation, timestamp),
              lastTriggeredAt: timestamp.toISOString(),
            });
            await options.save();
          }
        }

        if (isTaskEventTrigger(automation.triggerKind)) {
          const events = options.projectEvents.listTaskEvents({ projectId: automation.projectId, triggerKind: automation.triggerKind, afterSequence: automation.cursorSequence, limit: MAX_EVENTS_PER_RULE_TICK });
          await processProjectEvents(automation, employee, events);
        } else if (automation.triggerKind === 'code_changed') {
          const events = options.projectEvents.listCodeEvents({ projectId: automation.projectId, afterSequence: automation.cursorSequence, limit: MAX_EVENTS_PER_RULE_TICK });
          await processProjectEvents(automation, employee, events);
        }
      } catch (error) {
        options.appendAuditLog({
          actorType: 'worker',
          actorRef: automation.employeeId,
          action: 'digital_employee.automation.processing_failed',
          resourceType: 'digital_employee_automation',
          resourceId: automation.id,
          payload: { projectId: automation.projectId, error: serializeError(error) },
          createdAt: now().toISOString(),
        });
        await options.save();
      }
    }
  }

  async function processProjectEvents(automation: DigitalEmployeeAutomationRecord, employee: DigitalEmployeeRecord, events: DigitalEmployeeProjectEvent[]): Promise<void> {
    for (const event of events) {
      if (event.suppressAutomation) {
        options.automations.advance({ id: automation.id, cursorSequence: event.sequence, lastTriggeredAt: automation.lastTriggeredAt ?? automation.createdAt });
        await options.save();
        continue;
      }
      const task = options.tasks.getById(event.taskId);
      if (!task || task.projectId !== automation.projectId) {
        options.automations.advance({ id: automation.id, cursorSequence: event.sequence, lastTriggeredAt: automation.lastTriggeredAt ?? automation.createdAt });
        await options.save();
        continue;
      }
      const source = readTaskSourceContext(task);
      const automationCreated = typeof source.digitalEmployeeAutomationId === 'string';
      const ignoreAutomationCreated = automation.triggerConfig.ignoreAutomationCreated !== false;
      const automationChainDepth = typeof source.digitalEmployeeAutomationDepth === 'number' ? Math.max(0, Math.trunc(source.digitalEmployeeAutomationDepth)) : automationCreated ? 1 : 0;
      if ((automationCreated && ignoreAutomationCreated) || automationChainDepth >= MAX_AUTOMATION_CHAIN_DEPTH || !taskMatchesEmployee(task, employee)) {
        options.automations.advance({ id: automation.id, cursorSequence: event.sequence, lastTriggeredAt: automation.lastTriggeredAt ?? automation.createdAt });
        await options.save();
        continue;
      }
      const triggered = await triggerAutomation(automation, employee, event.identity, event);
      if (!triggered) return;
      options.automations.advance({ id: automation.id, cursorSequence: event.sequence, lastTriggeredAt: now().toISOString() });
      await options.save();
    }
  }

  async function triggerAutomation(automation: DigitalEmployeeAutomationRecord, employee: DigitalEmployeeRecord, eventIdentity: string, event: DigitalEmployeeProjectEvent | null): Promise<boolean> {
    if (options.automations.hasEventReceipt(automation.id, eventIdentity)) return true;
    let task: ZeusTaskRecord | null = null;
    if (automation.actionKind === 'assign_task') {
      const configuredTaskId = typeof automation.actionConfig.taskId === 'string' ? automation.actionConfig.taskId : null;
      const useEventTask = automation.actionConfig.useEventTask === true;
      task = configuredTaskId ? (options.tasks.getById(configuredTaskId) ?? null) : event && useEventTask ? (options.tasks.getById(event.taskId) ?? null) : selectEligibleTask(employee);
      if (!task || task.projectId !== automation.projectId || !taskMatchesEmployee(task, employee)) {
        consumeAutomationWithoutExecution(automation, eventIdentity, '没有符合条件且可认领的任务');
        return true;
      }
    } else {
      task = createAutomationTask(automation, employee, eventIdentity, event);
    }
    if (!task) {
      consumeAutomationWithoutExecution(automation, eventIdentity, '自动化没有解析到可用任务');
      return true;
    }
    const source: DigitalEmployeeExecutionSource = automation.actionKind === 'explore_project' ? 'exploration' : 'automation';
    await queueExecution({ employee, task, automation, source, sourceRef: `${automation.id}:${eventIdentity}`, eventIdentity });
    return true;
  }

  function createAutomationTask(automation: DigitalEmployeeAutomationRecord, employee: DigitalEmployeeRecord, eventIdentity: string, event: DigitalEmployeeProjectEvent | null): ZeusTaskRecord {
    const taskIdentity = stableIdentity('task', `${automation.id}\0${eventIdentity}`);
    const action = automation.actionConfig;
    const titleTemplate = typeof action.title === 'string' ? action.title : automation.actionKind === 'explore_project' ? `项目探索：${employee.name}` : `自动任务：${automation.name}`;
    const descriptionTemplate =
      typeof action.description === 'string'
        ? action.description
        : automation.actionKind === 'explore_project'
          ? `仅在当前项目的任务、代码和文档范围内进行只读探索，整理有证据的改进机会、风险和候选任务。不得扫描其他项目、本机任意目录或未授权外部系统。`
          : `由数字员工自动化“${automation.name}”创建并交付。`;
    const sourceTask = event ? options.tasks.getById(event.taskId) : null;
    const sourceContext = sourceTask ? readTaskSourceContext(sourceTask) : {};
    const sourceDepth = typeof sourceContext.digitalEmployeeAutomationDepth === 'number' ? Math.max(0, Math.trunc(sourceContext.digitalEmployeeAutomationDepth)) : typeof sourceContext.digitalEmployeeAutomationId === 'string' ? 1 : 0;
    const input: CreateUserTaskInput = {
      projectId: automation.projectId,
      title: interpolateAutomationText(titleTemplate, event),
      taskType: readTaskType(action.taskType),
      description: interpolateAutomationText(descriptionTemplate, event),
      sourceContext: {
        type: 'digital_employee_automation',
        digitalEmployeeAutomationId: automation.id,
        digitalEmployeeId: employee.id,
        eventIdentity,
        digitalEmployeeAutomationDepth: Math.min(MAX_AUTOMATION_CHAIN_DEPTH, sourceDepth + 1),
        ...(event ? { sourceTaskId: event.taskId, sourceEventType: event.eventType } : {}),
      },
      tags: Array.isArray(action.tags) ? action.tags.filter((tag): tag is string => typeof tag === 'string') : ['数字员工'],
      allowCodeChanges: automation.actionKind !== 'explore_project' && employee.allowCodeChanges,
      allowTests: automation.actionKind !== 'explore_project' && employee.allowTests,
      allowGitCommit: false,
    };
    const parsed = parseWorkerWorkManagementCommand<CreateUserTaskInput>({
      application: options.workManagement,
      commandType: workManagementCommandTypes.taskCreate,
      scopeKind: 'task',
      scopeId: taskIdentity,
      operationIdentity: taskIdentity,
      input,
      actorId: employee.id,
    });
    const mutation = options.workManagement.executeCore({
      parsed,
      destinationId: 'work-management-task-application',
      resourceId: taskIdentity,
      mutateBusinessState: () => options.createTask(input, taskIdentity, { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, actor: parsed.command.actor }),
    });
    if (!mutation.replayed) {
      options.publishRealtimeEvent('task.created', { projectId: automation.projectId, taskId: mutation.result.id, source: 'digital_employee_automation' });
    }
    return mutation.result;
  }

  function consumeAutomationWithoutExecution(automation: DigitalEmployeeAutomationRecord, eventIdentity: string, reason: string): void {
    options.appendAuditLog({
      actorType: 'worker',
      actorRef: automation.employeeId,
      action: 'digital_employee.automation.noop',
      resourceType: 'digital_employee_automation',
      resourceId: automation.id,
      payload: { projectId: automation.projectId, eventIdentity, reason },
      createdAt: now().toISOString(),
    });
  }

  async function processTaskPool(): Promise<void> {
    for (const employee of options.employees.listEnabled()) {
      if (!employee.autoClaim) continue;
      for (const task of options.tasks.listByProject(employee.projectId)) {
        const sourceRef = `task_pool:${employee.id}:${task.id}`;
        if (!taskMatchesEmployee(task, employee) || options.taskWorkManagement.hasAutomationSource(sourceRef)) continue;
        try {
          await queueExecution({ employee, task, source: 'task_pool', sourceRef });
        } catch (error) {
          options.appendAuditLog({
            actorType: 'worker',
            actorRef: employee.id,
            action: 'digital_employee.task_pool.claim_failed',
            resourceType: 'task',
            resourceId: task.id,
            payload: { projectId: employee.projectId, error: serializeError(error) },
            createdAt: now().toISOString(),
          });
          await options.save();
        }
      }
    }
  }

  async function queueExecution(input: {
    employee: DigitalEmployeeRecord;
    task: ZeusTaskRecord;
    automation?: DigitalEmployeeAutomationRecord;
    source: DigitalEmployeeExecutionSource;
    sourceRef: string;
    eventIdentity?: string;
  }): Promise<void> {
    if (input.employee.entrypoint?.kind !== 'agent' || input.employee.entrypointMigrationState !== 'ready') {
      throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_AGENT_ENTRYPOINT_REQUIRED', '数字员工必须通过 Agent 会话执行；自动化不会运行旧版入口配置。', false);
    }
    const sourceRef = input.source === 'task_pool' ? input.sourceRef : `${input.employee.id}:${input.sourceRef}`;
    const created = await options.taskWorkManagement.createAutomatedWorkItem({ taskId: input.task.id, employeeId: input.employee.id, sourceRef });
    if (input.automation && input.eventIdentity) options.automations.recordEventReceipt({ automationId: input.automation.id, eventIdentity: input.eventIdentity, executionId: null, createdAt: now().toISOString() });
    options.taskEvents.create({
      taskId: input.task.id,
      eventType: 'task.work_item.automation_created',
      title: '自动化已创建数字员工工作项',
      payload: { workItemId: created.item.id, runId: created.run.id, employeeId: input.employee.id, source: input.source, automationId: input.automation?.id ?? null, entrypointKind: 'agent' },
    });
    await options.save();
  }

  async function processExecution(execution: DigitalEmployeeExecutionRecord): Promise<void> {
    if (execution.status === 'queued' || execution.status === 'dispatching') {
      if (execution.status === 'queued') options.executions.update(execution.id, { status: 'dispatching', startedAt: now().toISOString(), errorCode: null, errorMessage: null });
      await dispatchExecution(options.executions.getById(execution.id)!);
      return;
    }
    if (execution.status === 'running' || execution.status === 'waiting') {
      await monitorConversation(execution);
      return;
    }
    if (execution.status === 'delivery_pending') await processDelivery(execution);
  }

  async function dispatchExecution(execution: DigitalEmployeeExecutionRecord): Promise<void> {
    const task = options.tasks.getById(execution.taskId);
    const project = task ? options.projects.getById(task.projectId) : undefined;
    if (!task || !project || task.projectId !== execution.projectId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_TASK_UNAVAILABLE', '数字员工要处理的任务或项目已经不存在。', false);
    const snapshot = execution.employeeSnapshot;
    const skillSelection = splitZeusSkillIds(snapshot.skillIds);
    if (skillSelection.invalidIds.length > 0) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_SKILL_INVALID', '数字员工执行快照包含无效的 Skill 身份。', false);
    const nativeSkillId = skillSelection.nativeSkillIds[0] ?? null;
    const capability = await options.conversationCapabilities.readTaskPush(project.id, task.id);
    const models = Array.isArray(capability.models) ? capability.models.filter(isCapabilityModel).filter((candidate) => candidate.agentKind === snapshot.agentKind) : [];
    const preferredModel = typeof capability.preferredModel === 'string' ? capability.preferredModel : null;
    const configuredModel = snapshot.model?.trim() || null;
    const model = configuredModel
      ? (models.find((candidate) => candidate.id === configuredModel || candidate.model === configuredModel) ?? null)
      : ((preferredModel ? models.find((candidate) => candidate.id === preferredModel || candidate.model === preferredModel) : null) ?? models.find((candidate) => candidate.available) ?? null);
    if (!model || model.available === false) {
      throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_MODEL_UNAVAILABLE', snapshot.model ? `数字员工配置的模型当前不可用：${snapshot.model}` : '当前项目没有可供数字员工运行的模型。', false);
    }

    const repositories = Array.isArray(capability.repositories) ? capability.repositories.filter(isRepositoryCapability) : [];
    const repositoryRevision = typeof capability.repositoryRevision === 'string' ? capability.repositoryRevision : '';
    const directWorkspace = isRecord(capability.directWorkspace) ? capability.directWorkspace : {};
    const allowCodeChanges = execution.source !== 'exploration' && snapshot.allowCodeChanges && task.allowCodeChanges;
    const allowTests = execution.source !== 'exploration' && snapshot.allowTests && task.allowTests;
    const writeEnabled = (allowCodeChanges || allowTests) && snapshot.permissionMode !== 'read-only';
    let workspace: Record<string, unknown>;
    if (execution.environmentId) {
      workspace = { mode: 'existing', environmentId: execution.environmentId };
    } else if (repositories.length > 0) {
      if (!repositoryRevision) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_REPOSITORY_REVISION_REQUIRED', '项目仓库清单缺少稳定版本，无法创建隔离工作区。', true);
      workspace = {
        mode: 'create',
        repositoryRevision,
        repositories: repositories.map((repository) => {
          const current = repository.sourceRefs.find((source) => source.current) ?? repository.sourceRefs.find((source) => source.kind === 'local');
          if (!current) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_SOURCE_REF_UNAVAILABLE', `仓库 ${repository.name} 没有可用来源分支。`, false);
          return { repositoryId: repository.id, sourceRef: current.ref, branchName: repository.suggestedBranchName };
        }),
      };
    } else {
      const activeWritable = typeof directWorkspace.activeWritableConversationCount === 'number' ? directWorkspace.activeWritableConversationCount : 0;
      if (writeEnabled && activeWritable > 0) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_DIRECT_WORKSPACE_BUSY', '项目目录已有可写会话；数字员工不会自动确认并发直接写入。', true);
      workspace = { mode: 'direct' };
    }

    const permissionMode = execution.source === 'exploration' || (!allowCodeChanges && !allowTests) ? 'read-only' : snapshot.permissionMode;
    const reworkReason = typeof execution.deliveryState.reason === 'string' ? execution.deliveryState.reason.trim() : '';
    const supplementalInfo = [buildEmployeeSupplementalInfo(execution, snapshot, { allowCodeChanges, allowTests }), reworkReason ? `## 用户要求完善的内容\n\n${reworkReason}` : ''].filter(Boolean).join('\n\n');
    let taskStage: ZeusTaskStageRecord | null = null;
    if (execution.executionMode === 'staged') {
      if (!execution.currentStageId || !execution.workflowId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_MISSING', '阶段化工作执行缺少当前阶段身份。', true);
      taskStage = options.stages.getStage(execution.currentStageId);
      if (!taskStage || taskStage.taskId !== task.id || taskStage.workflowId !== execution.workflowId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_MISSING', '阶段化工作执行的当前阶段已经不可用。', true);
      if (taskStage.employeeMode !== 'explicit' || taskStage.employeeId !== snapshot.id) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_EMPLOYEE_CONFLICT', '当前阶段指派与工作执行员工快照不一致。', true);
      const stagePermissionMode = taskStage.kind === 'plan' || taskStage.kind === 'code_review' ? 'read-only' : permissionMode;
      // 阶段交付物必须由一次可自然结束的独立会话生成。Codex 的 PLAN 模式会停在
      // “实施此计划？”内部审批，和 Zeus 的阶段交接确认形成重复且不可见的门禁。
      const stageWorkMode = taskStage.kind === 'plan' || taskStage.kind === 'code_review' ? 'default' : snapshot.workMode;
      if (taskStage.status === 'running') {
        const frozenMatches =
          taskStage.agentKind === model.agentKind &&
          taskStage.modelRef === model.id &&
          taskStage.effort === snapshot.reasoningEffort &&
          taskStage.serviceTier === snapshot.serviceTier &&
          taskStage.workMode === stageWorkMode &&
          taskStage.permissionMode === stagePermissionMode;
        if (!frozenMatches) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_CONFIGURATION_CONFLICT', '已启动阶段的冻结配置与当前派发意图不一致。', true);
      } else {
        const configured = options.stages.assignEmployee(taskStage.id, {
          expectedRevision: taskStage.revision,
          employeeMode: 'explicit',
          employeeId: snapshot.id,
          agentKind: model.agentKind,
          modelRef: model.id,
          effort: snapshot.reasoningEffort,
          serviceTier: snapshot.serviceTier,
          workMode: stageWorkMode,
          permissionMode: stagePermissionMode,
          prompt: taskStage.prompt,
        });
        taskStage = configured.stages.find((stage) => stage.id === taskStage!.id) ?? null;
        if (!taskStage) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_MISSING', '更新阶段执行配置后无法读取当前阶段。', true);
      }
    }
    const effectivePermissionMode = taskStage?.kind === 'plan' || taskStage?.kind === 'code_review' ? 'read-only' : permissionMode;
    const stageExecution = taskStage
      ? {
          workExecutionId: execution.id,
          employeeId: snapshot.id,
          employeeRevision: snapshot.revision,
          employeeSnapshot: snapshot,
          skillId: nativeSkillId,
          effectivePermissions: {
            permissionMode: effectivePermissionMode,
            allowCodeChanges: taskStage.kind === 'implementation' ? allowCodeChanges : false,
            allowTests: taskStage.kind === 'implementation' ? allowTests : false,
            deliveryGrants: execution.deliveryGrantsSnapshot,
          },
        }
      : null;
    const commonBody = {
      mode: 'create',
      model: model.id,
      ...(snapshot.reasoningEffort ? { effort: snapshot.reasoningEffort } : {}),
      ...(snapshot.serviceTier ? { serviceTier: snapshot.serviceTier } : {}),
      permissionMode: effectivePermissionMode,
      agentKind: model.agentKind,
      ...(nativeSkillId ? { skillId: nativeSkillId } : {}),
      ...(skillSelection.pluginReferences.length > 0 ? { pluginReferences: skillSelection.pluginReferences } : {}),
      ...(taskStage ? { stageId: taskStage.id, stageExecution } : {}),
    };
    const reviewSource = taskStage?.kind === 'code_review' ? reviewSourceConversation(taskStage) : null;
    const canReviewPersistedWorkspace = Boolean(reviewSource?.environmentId && reviewSource.workspaceId);
    const body: Record<string, unknown> =
      taskStage?.kind === 'code_review' && canReviewPersistedWorkspace
        ? {
            ...commonBody,
            source: 'code_review',
            collaborationMode: 'default',
            inheritConversationId: reviewSource!.id,
          }
        : {
            ...commonBody,
            source: 'task_push',
            workMode: taskStage?.workMode ?? snapshot.workMode,
            supplementalInfo:
              taskStage?.kind === 'code_review'
                ? [supplementalInfo, '已确认实施交付物的来源会话没有可继承的精确任务工作区。本阶段只能审查已确认的实施报告，不得声称已审查仓库现场；如需仓库级代码审查，应明确报告为现场未验证项。'].join('\n\n')
                : supplementalInfo,
            workspace,
          };
    const accepted = await options.executeTaskConversationIdempotent(project, task, body, `digital-employee:${execution.id}:attempt:${execution.attempt}`);
    const acceptance = isRecord(accepted.body) ? accepted.body : null;
    const conversationProjection = acceptance && isRecord(acceptance.conversation) ? acceptance.conversation : null;
    const conversationId = conversationProjection && typeof conversationProjection.id === 'string' ? conversationProjection.id : null;
    if (!conversationId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_ACCEPTANCE_NOT_DURABLE', '任务推送没有返回耐久会话身份。', true);
    const conversation = options.conversations.getById(conversationId);
    if (!conversation || conversation.taskId !== task.id || conversation.projectId !== project.id) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_ACCEPTANCE_NOT_DURABLE', '任务推送返回的会话与任务身份不一致。', true);
    const updated = options.executions.update(execution.id, {
        status: 'running',
      conversationId: conversation.id,
      environmentId: conversation.environmentId,
      errorCode: null,
      errorMessage: null,
    });
    if (taskStage) {
      const attempt = options.stages.getAttemptByConversation(conversation.id);
      if (!attempt || attempt.stageId !== taskStage.id || attempt.workExecutionId !== execution.id || attempt.employeeId !== snapshot.id) {
        throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_ATTEMPT_NOT_DURABLE', '阶段会话没有冻结到当前工作执行和员工快照。', true);
      }
    }
    options.taskEvents.create({
      taskId: task.id,
      eventType: 'task.digital_employee.started',
      title: '数字员工已开始处理任务',
      payload: {
        executionId: updated.id,
        employeeId: updated.employeeId,
        conversationId: conversation.id,
        environmentId: conversation.environmentId,
        skillId: snapshot.skillIds[0] ?? null,
      },
    });
    publishExecution(updated);
      await monitorConversation(updated);
  }

  async function monitorConversation(execution: DigitalEmployeeExecutionRecord): Promise<void> {
    if (!execution.conversationId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_CONVERSATION_MISSING', '数字员工执行缺少关联会话身份。', true);
    const conversation = options.conversations.getById(execution.conversationId);
    if (!conversation || conversation.taskId !== execution.taskId || conversation.projectId !== execution.projectId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_CONVERSATION_MISSING', '数字员工关联会话已经不可用。', true);
    if (execution.executionMode === 'staged' && execution.status === 'waiting') {
      const candidateId = typeof execution.deliveryState.candidateDeliverableId === 'string' ? execution.deliveryState.candidateDeliverableId : null;
      const candidate = candidateId ? options.stages.getDeliverable(candidateId) : null;
      if (candidate && candidate.taskId === execution.taskId && candidate.stageId === execution.currentStageId && candidate.status === 'submitted') {
        // 候选交付物已耐久化后，等待态只由用户的交接、返工或最终确认命令推进。
        // 重复监控已完成会话会徒增执行修订，使用户刚打开的确认弹窗立即过期。
        return;
      }
    }
      const executionState = conversationWorkExecutionState(conversation, options.conversationSubmissions.listByConversation(conversation.id));
      if (executionState.type === 'failed') throw orchestratorError(executionState.code, executionState.message, false);
      if (executionState.type === 'outcome_unknown') throw orchestratorError(executionState.code, executionState.message, true);
      if (executionState.type === 'waiting') {
      if (execution.status !== 'waiting') publishExecution(options.executions.update(execution.id, { status: 'waiting' }));
      return;
    }
      if (executionState.type !== 'completed') {
      if (execution.status !== 'running') publishExecution(options.executions.update(execution.id, { status: 'running' }));
      return;
    }
    if (execution.executionMode === 'staged') {
      if (!execution.currentStageId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_MISSING', '阶段化工作执行缺少当前阶段身份。', true);
      const attempt = options.stages.getAttemptByConversation(conversation.id);
      if (!attempt || attempt.stageId !== execution.currentStageId || attempt.workExecutionId !== execution.id) {
        throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_STAGE_ATTEMPT_NOT_DURABLE', '已完成会话不属于当前阶段尝试。', true);
      }
      const workflow = await options.taskStageApplication.captureLatestConversationOutput(execution.taskId, execution.currentStageId, {
        operationIdentity: `digital-employee-final-output:${execution.id}:${execution.currentStageId}:${attempt.attemptNumber}`,
      });
      const stage = workflow.stages.find((candidate) => candidate.id === execution.currentStageId);
      const deliverable = stage?.deliverables.filter((candidate) => candidate.attemptId === attempt.id).sort((left, right) => right.version - left.version)[0];
      if (!deliverable || deliverable.status !== 'submitted') throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_DELIVERABLE_NOT_DURABLE', '数字员工最终回复未能固化为待确认交付物。', true);
      const waiting = options.executions.update(execution.id, {
        status: 'waiting',
        completedAt: now().toISOString(),
        deliveryState: {
          candidateDeliverableId: deliverable.id,
          candidateDeliverableVersion: deliverable.version,
          candidateStageId: deliverable.stageId,
          candidateContentSha256: deliverable.contentSha256,
        },
      });
      options.taskEvents.create({
        taskId: execution.taskId,
        eventType: 'task.digital_employee.stage_output_ready',
        title: '数字员工阶段方案已生成，等待确认',
        payload: { executionId: execution.id, stageId: deliverable.stageId, attemptId: attempt.id, deliverableId: deliverable.id, version: deliverable.version },
      });
      publishExecution(waiting);
      return;
    }
    const hasDelivery = execution.source !== 'exploration' && Object.values(execution.deliveryGrantsSnapshot).some(Boolean);
    if (!hasDelivery) {
      const pending = options.executions.update(execution.id, { status: 'delivery_pending', deliveryStage: 'done' });
      publishExecution(pending);
      await markDelivered(pending, '数字员工已完成任务处理；当前执行没有获授自动交付动作。');
      return;
    }
    const pending = options.executions.update(execution.id, { status: 'delivery_pending', deliveryStage: firstDeliveryStage(execution) });
    options.taskEvents.create({ taskId: execution.taskId, eventType: 'task.digital_employee.delivery_started', title: '数字员工开始执行已授权交付动作', payload: { executionId: execution.id, grants: execution.deliveryGrantsSnapshot } });
    publishExecution(pending);
  }

  async function processDelivery(execution: DigitalEmployeeExecutionRecord): Promise<void> {
    const task = options.tasks.getById(execution.taskId);
    const project = task ? options.projects.getById(task.projectId) : undefined;
    if (!task || !project) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_TASK_UNAVAILABLE', '交付目标任务或项目已不存在。', false);
    const stage = execution.deliveryStage === 'none' ? firstDeliveryStage(execution) : execution.deliveryStage;
    if (stage === 'done') {
      await markDelivered(execution, '所有已授权交付动作均已完成。');
      return;
    }
    if ((stage === 'commit' || stage === 'push' || stage === 'merge') && !execution.environmentId) {
      throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_ISOLATED_WORKSPACE_REQUIRED', `自动${deliveryStageLabel(stage)}只允许在本次执行的隔离任务环境中运行。`, false);
    }

    if (stage === 'commit') await deliverCommit(execution, project, task);
    if (stage === 'push') await deliverTaskBranchPush(execution, task);
    if (stage === 'merge') await deliverMerge(execution, task);
    if (stage === 'deploy') {
      const waiting = await deliverDeploy(execution);
      if (waiting) return;
    }
    if (stage === 'complete') await deliverTaskCompletion(execution, task);

    const current = options.executions.getById(execution.id)!;
    const next = nextDeliveryStage(current, stage);
    const updated = options.executions.update(execution.id, { deliveryStage: next });
    publishExecution(updated);
    if (next === 'done') await markDelivered(updated, '所有已授权交付动作均已完成。');
  }

  async function deliverCommit(execution: DigitalEmployeeExecutionRecord, project: ZeusProjectRecord, task: ZeusTaskRecord): Promise<void> {
    for (const workspace of requireGitWorkspaces(execution)) {
      if (!workspace.worktreePath || workspace.state !== 'ready') {
        throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_WORKSPACE_NOT_READY', `仓库 ${workspace.repositoryName} 的隔离任务工作区不可提交：${workspace.state}。`, false);
      }
      const snapshot = await options.readTaskWorkspaceSnapshot(project, workspace);
      const review = isRecord(snapshot.review) ? snapshot.review : null;
      if (!review) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_GIT_REVIEW_UNAVAILABLE', `无法读取仓库 ${workspace.repositoryName} 的提交现场。`, true);
      const conflictFiles = filePaths(review.conflictFiles);
      if (conflictFiles.length > 0) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_GIT_CONFLICTED', `仓库 ${workspace.repositoryName} 存在冲突，已停止自动交付。`, false);
      if (review.clean === true) continue;
      const selectedPaths = [...new Set([...filePaths(review.stagedFiles), ...filePaths(review.unstagedFiles), ...filePaths(review.untrackedFiles)])];
      if (selectedPaths.length === 0) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_GIT_PATHS_UNAVAILABLE', `仓库 ${workspace.repositoryName} 有变化但无法解析精确文件清单。`, true);
      await executeGit({
        execution,
        commandType: workspaceGitCommandTypes.taskWorkspaceCommit,
        scopeKind: 'task_workspace',
        scopeId: workspace.id,
        ids: { taskId: task.id, workspaceId: workspace.id },
        value: { message: `${task.taskCode}: ${task.title}`, selectedPaths },
      });
    }
  }

  async function deliverTaskBranchPush(execution: DigitalEmployeeExecutionRecord, task: ZeusTaskRecord): Promise<void> {
    for (const workspace of requireGitWorkspaces(execution)) {
      if (!workspace.worktreePath || workspace.state !== 'ready') {
        throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_WORKSPACE_NOT_READY', `仓库 ${workspace.repositoryName} 的隔离任务工作区不可推送：${workspace.state}。`, false);
      }
      if (!workspace.remoteName) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_GIT_REMOTE_UNAVAILABLE', `仓库 ${workspace.repositoryName} 没有配置远端，无法完成已授权推送。`, false);
      await executeGit({ execution, commandType: workspaceGitCommandTypes.taskWorkspacePush, scopeKind: 'task_workspace', scopeId: workspace.id, ids: { taskId: task.id, workspaceId: workspace.id }, value: {} });
    }
  }

  async function deliverMerge(execution: DigitalEmployeeExecutionRecord, task: ZeusTaskRecord): Promise<void> {
    const workspaces = requireGitWorkspaces(execution);
    const persistedIntegrationIds = isRecord(execution.deliveryState.integrationIds) ? execution.deliveryState.integrationIds : {};
    const integrationIds: Record<string, string> = Object.fromEntries(Object.entries(persistedIntegrationIds).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const taskIntegrations = options.taskIntegrations.listByTask(task.id);
    for (const workspace of workspaces) {
      if (workspace.state === 'merged') {
        const recovered = integrationIds[workspace.id] ?? taskIntegrations.find((integration) => integration.workspaceId === workspace.id && integration.targetBranch === workspace.sourceBranch && integration.state === 'merged')?.id;
        if (!recovered) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_MERGE_EVIDENCE_MISSING', `仓库 ${workspace.repositoryName} 已显示合入，但缺少可审计的合入记录。`, true);
        integrationIds[workspace.id] = recovered;
        continue;
      }
      const response = await executeGit({
        execution,
        commandType: workspaceGitCommandTypes.taskWorkspaceIntegrate,
        scopeKind: 'task_workspace',
        scopeId: workspace.id,
        ids: { taskId: task.id, workspaceId: workspace.id },
        value: { targetBranch: workspace.sourceBranch, mode: 'merge' },
      });
      const body = isRecord(response.body) ? response.body : null;
      const integration = body && isRecord(body.integration) ? body.integration : null;
      const integrationId = integration && typeof integration.id === 'string' ? integration.id : null;
      const integrationState = integration && typeof integration.state === 'string' ? integration.state : null;
      if (integrationId) {
        integrationIds[workspace.id] = integrationId;
        options.executions.update(execution.id, { deliveryState: { ...execution.deliveryState, integrationIds } });
      }
      if (response.statusCode === 202 || integrationState === 'conflicted' || integrationState === 'pending_local_sync') {
        throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_MERGE_BLOCKED', `仓库 ${workspace.repositoryName} 的合入需要人工处理冲突或本地同步，数字员工不会盲目重试。`, false);
      }
      if (response.statusCode >= 400 || integrationState !== 'merged') throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_MERGE_FAILED', `仓库 ${workspace.repositoryName} 未完成来源分支合入。`, false);
    }
    if (Object.keys(integrationIds).length !== workspaces.length) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_MERGE_EVIDENCE_MISSING', '部分仓库缺少可审计的合入记录，已停止后续交付。', true);
    const currentState = options.executions.getById(execution.id)?.deliveryState ?? execution.deliveryState;
    const state: Record<string, unknown> = { ...currentState, integrationIds };
    options.executions.update(execution.id, { deliveryState: state });
    if (execution.deliveryGrantsSnapshot.allowPush) {
      const pushed = new Set(Array.isArray(state.sourcePushedIntegrationIds) ? state.sourcePushedIntegrationIds.filter((value: unknown): value is string => typeof value === 'string') : []);
      for (const integrationId of Object.values(integrationIds)) {
        if (pushed.has(integrationId)) continue;
        await executeGit({ execution, commandType: workspaceGitCommandTypes.taskIntegrationPush, scopeKind: 'task_integration', scopeId: integrationId, ids: { taskId: task.id, integrationId }, value: {} });
        pushed.add(integrationId);
        options.executions.update(execution.id, { deliveryState: { ...state, sourcePushedIntegrationIds: [...pushed] } });
      }
    }
  }

  async function deliverDeploy(execution: DigitalEmployeeExecutionRecord): Promise<boolean> {
    const commandId = execution.employeeSnapshot.deployCommandId;
    if (!commandId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_COMMAND_REQUIRED', '数字员工执行快照没有已授权部署命令。', false);
    const deliveryState = options.executions.getById(execution.id)?.deliveryState ?? execution.deliveryState;
    const existingRunId = typeof deliveryState.deployRunId === 'string' ? deliveryState.deployRunId : null;
    if (existingRunId) {
      const run = options.commandRuns.getById(existingRunId);
      if (!run) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_RUN_MISSING', '部署命令运行记录已经不可用。', true);
      if (run.status === 'starting' || run.status === 'running' || run.status === 'stopping') return true;
      if (run.status === 'pending_confirmation') {
        options.executions.update(execution.id, { deliveryState: nextDeployRunRound(deliveryState, 'ZEUS_COMMAND_CONFIRMATION_STALE') });
        return true;
      }
      if (run.status !== 'succeeded') {
        throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_OUTCOME_UNKNOWN', `部署命令已经启动但未成功，可能产生了部分外部效果，禁止自动重发：${run.failureReason ?? run.status}`, true);
      }
      return false;
    }

    const deployRunRound = typeof deliveryState.deployRunRound === 'number' ? Math.max(0, Math.trunc(deliveryState.deployRunRound)) : 0;
    const runId = stableIdentity('command_run_employee', `${execution.id}\0deploy\0${execution.attempt}\0${deployRunRound}`);
    const confirmationInput = { parameters: {}, trigger: 'desktop' };
    const confirmationBody = commandCenterEnvelope({ commandType: commandCenterCommandTypes.confirmationCreate, scopeKind: 'command_run', scopeId: runId, operationIdentity: runId, input: confirmationInput, actorId: execution.employeeId });
    const confirmationResponse = await options.server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(execution.projectId)}/commands/${encodeURIComponent(commandId)}/confirmations`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: confirmationBody,
    });
    if (confirmationResponse.statusCode !== 201) {
      throw httpOrchestratorError(
        confirmationResponse.statusCode >= 500 ? 'ZEUS_DIGITAL_EMPLOYEE_DEPLOY_CONFIRMATION_OUTCOME_UNKNOWN' : 'ZEUS_DIGITAL_EMPLOYEE_DEPLOY_CONFIRMATION_FAILED',
        confirmationResponse,
        confirmationResponse.statusCode >= 500,
      );
    }
    const confirmation = confirmationResponse.json() as unknown;
    if (!isRecord(confirmation) || typeof confirmation.id !== 'string') throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_CONFIRMATION_FAILED', '部署命令确认没有返回稳定身份。', true);

    const runInput = { runId, confirmationId: confirmation.id, parameters: {} };
    const runBody = commandCenterEnvelope({ commandType: commandCenterCommandTypes.runStart, scopeKind: 'command_run', scopeId: runId, operationIdentity: `${runId}_start`, input: runInput, actorId: execution.employeeId });
    const runResponse = await options.server.inject({
      method: 'POST',
      url: `/api/projects/${encodeURIComponent(execution.projectId)}/commands/${encodeURIComponent(commandId)}/runs`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: runBody,
    });
    if (runResponse.statusCode !== 201) {
      const responseCode = httpErrorCode(runResponse);
      if (responseCode === 'ZEUS_COMMAND_CONFIRMATION_REQUIRED' || responseCode === 'ZEUS_COMMAND_CONFIRMATION_STALE') {
        options.executions.update(execution.id, { deliveryState: nextDeployRunRound(deliveryState, responseCode) });
        return true;
      }
      throw httpOrchestratorError(runResponse.statusCode >= 500 ? 'ZEUS_DIGITAL_EMPLOYEE_DEPLOY_START_OUTCOME_UNKNOWN' : 'ZEUS_DIGITAL_EMPLOYEE_DEPLOY_START_FAILED', runResponse, runResponse.statusCode >= 500);
    }
    options.executions.update(execution.id, { deliveryState: { ...deliveryState, deployRunId: runId, deployRunRound } });
    return true;
  }

  async function deliverTaskCompletion(execution: DigitalEmployeeExecutionRecord, task: ZeusTaskRecord): Promise<void> {
    const status = options.resolveCompletedManagementStatus(task.projectId);
    const input = { status, expectedUpdatedAt: task.updatedAt, confirmWorktreeCleanup: true };
    const operationIdentity = stableIdentity('digital_employee_task_complete', `${execution.id}\0${execution.attempt}`);
    const body = workManagementEnvelope({
      commandType: workManagementCommandTypes.taskManagementStatusUpdate,
      scopeKind: 'task',
      scopeId: task.id,
      operationIdentity,
      input,
      actorId: execution.employeeId,
    });
    const response = await options.server.inject({
      method: 'PATCH',
      url: `/api/tasks/${encodeURIComponent(task.id)}/management-status`,
      headers: { authorization: `Bearer ${options.apiToken}` },
      payload: body,
    });
    if (response.statusCode !== 200) {
      throw httpOrchestratorError(response.statusCode >= 500 ? 'ZEUS_DIGITAL_EMPLOYEE_TASK_COMPLETE_OUTCOME_UNKNOWN' : 'ZEUS_DIGITAL_EMPLOYEE_TASK_COMPLETE_FAILED', response, response.statusCode >= 500);
    }
  }

  async function executeGit(input: {
    execution: DigitalEmployeeExecutionRecord;
    commandType: WorkspaceGitCommandType;
    scopeKind: WorkspaceGitScopeKind;
    scopeId: string;
    ids: { projectId?: string; taskId?: string; repositoryId?: string; workspaceId?: string; integrationId?: string };
    value: Record<string, unknown>;
  }): Promise<{ statusCode: number; body: unknown }> {
    const operationIdentity = stableIdentity('digital_employee_git', `${input.execution.id}\0${input.execution.attempt}\0${input.commandType}\0${input.scopeId}`);
    const request = workspaceGitEnvelope({ commandType: input.commandType, scopeKind: input.scopeKind, scopeId: input.scopeId, operationIdentity, input: input.value, actorId: input.execution.employeeId });
    const parsed = options.workspaceGit.parse({ value: request, commandType: input.commandType, scopeKind: input.scopeKind, scopeId: input.scopeId });
    const prepared = await options.workspaceGitOperations.prepare({ commandType: input.commandType, operationIdentity, ...input.ids, value: input.value });
    let commitAccepted: (() => void) | undefined;
    const executed = await options.workspaceGit.executeExternal({
      parsed,
      destinationId: prepared.destinationId,
      resourceId: prepared.resourceId,
      externalOperationId: prepared.externalOperationId,
      invoke: async () => {
        const operation = await options.workspaceGitOperations.execute({ commandType: input.commandType, operationIdentity, prepared: prepared as PreparedWorkspaceGitCommand, value: input.value });
        commitAccepted = operation.commitAccepted;
        return operation.response;
      },
      mutateAcceptedBusinessState: () => commitAccepted?.(),
      isExplicitRejection: options.workspaceGitOperations.isExplicitRejection,
    });
    if (executed.result.statusCode >= 400) {
      const body = isRecord(executed.result.body) ? executed.result.body : null;
      throw orchestratorError(typeof body?.error === 'string' ? body.error : 'ZEUS_DIGITAL_EMPLOYEE_GIT_FAILED', typeof body?.message === 'string' ? body.message : `Git 交付动作失败：${input.commandType}`, false);
    }
    return executed.result;
  }

  async function markDelivered(execution: DigitalEmployeeExecutionRecord, message: string): Promise<void> {
    const updated = options.executions.update(execution.id, { status: 'delivered', deliveryStage: 'done', completedAt: now().toISOString(), errorCode: null, errorMessage: null });
    options.taskEvents.create({
      taskId: execution.taskId,
      eventType: 'task.digital_employee.delivered',
      title: '数字员工工作执行已完成',
      payload: { executionId: execution.id, employeeId: execution.employeeId, message, deliveryState: updated.deliveryState },
    });
    options.appendAuditLog({
      actorType: 'worker',
      actorRef: execution.employeeId,
      action: 'digital_employee.execution.delivered',
      resourceType: 'digital_employee_execution',
      resourceId: execution.id,
      payload: { projectId: execution.projectId, taskId: execution.taskId, message, deliveryState: updated.deliveryState },
      createdAt: now().toISOString(),
    });
    publishExecution(updated);
    await options.save();
  }

  async function failExecution(execution: DigitalEmployeeExecutionRecord, error: unknown): Promise<void> {
    const failure = normalizeOrchestratorError(error);
    const status = failure.recoveryRequired ? 'blocked' : 'failed';
    const current = options.executions.getById(execution.id);
    if (!current || current.status === 'delivered' || current.status === 'cancelled') return;
    const retryUnsafe = retryWouldDuplicateUnknownWork(failure.code);
    const deliveryState = retryUnsafe ? { ...current.deliveryState, retryUnsafe: true } : current.deliveryState;
    if (current.executionMode === 'staged' && current.conversationId) {
      const attempt = options.stages.getAttemptByConversation(current.conversationId);
      if (attempt && (attempt.status === 'starting' || attempt.status === 'active')) {
        options.stages.failAttempt(attempt.id, { outcomeUnknown: failure.recoveryRequired, error: { code: failure.code, message: failure.message } });
      }
    }
    const updated = options.executions.update(execution.id, { status, deliveryState, errorCode: failure.code, errorMessage: failure.message, completedAt: now().toISOString() });
    options.taskEvents.create({
      taskId: execution.taskId,
      eventType: 'task.digital_employee.failed',
      title: status === 'blocked' ? '数字员工执行已阻塞' : '数字员工执行失败',
      payload: { executionId: execution.id, employeeId: execution.employeeId, code: failure.code, message: failure.message, recoveryRequired: failure.recoveryRequired, retryUnsafe },
    });
    options.appendAuditLog({
      actorType: 'worker',
      actorRef: execution.employeeId,
      action: status === 'blocked' ? 'digital_employee.execution.blocked' : 'digital_employee.execution.failed',
      resourceType: 'digital_employee_execution',
      resourceId: execution.id,
      payload: { projectId: execution.projectId, taskId: execution.taskId, code: failure.code, message: failure.message, recoveryRequired: failure.recoveryRequired, retryUnsafe },
      createdAt: now().toISOString(),
    });
    publishExecution(updated);
    await options.save();
  }

  function reviewSourceConversation(stage: ZeusTaskStageRecord) {
    const workflow = options.stages.getWorkflowByTask(stage.taskId);
    const implementation = workflow?.stages.filter((candidate) => candidate.sequence < stage.sequence && candidate.kind === 'implementation').sort((left, right) => right.sequence - left.sequence)[0];
    const accepted = implementation?.deliverables.filter((deliverable) => deliverable.status === 'accepted').sort((left, right) => right.version - left.version)[0];
    const attempt = accepted ? implementation?.attempts.find((candidate) => candidate.id === accepted.attemptId) : null;
    if (!attempt?.conversationId) throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_REVIEW_SOURCE_MISSING', '代码审查阶段缺少已确认实施交付物的精确会话。', false);
    const conversation = options.conversations.getById(attempt.conversationId);
    if (!conversation || conversation.taskId !== stage.taskId) {
      throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_REVIEW_SOURCE_MISSING', '代码审查阶段的实施来源会话已经不可用。', false);
    }
    return conversation;
  }

  function executionWorkspaces(execution: DigitalEmployeeExecutionRecord): ZeusTaskWorkspaceRecord[] {
    if (!execution.environmentId) return [];
    return options.taskWorkspaces.listByEnvironment(execution.environmentId).filter((workspace) => workspace.taskId === execution.taskId && workspace.projectId === execution.projectId && workspace.kind === 'task');
  }

  function requireGitWorkspaces(execution: DigitalEmployeeExecutionRecord): ZeusTaskWorkspaceRecord[] {
    const workspaces = executionWorkspaces(execution);
    if (workspaces.length === 0) {
      throw orchestratorError('ZEUS_DIGITAL_EMPLOYEE_ISOLATED_WORKSPACE_REQUIRED', '已授权的 Git 交付动作没有对应的隔离任务工作区，不能声明交付成功。', false);
    }
    return workspaces;
  }

  function selectEligibleTask(employee: DigitalEmployeeRecord): ZeusTaskRecord | null {
    return options.tasks.listByProject(employee.projectId).find((task) => taskMatchesEmployee(task, employee)) ?? null;
  }

  function taskMatchesEmployee(task: ZeusTaskRecord, employee: DigitalEmployeeRecord): boolean {
    if (task.projectId !== employee.projectId || options.isTaskTerminal(task) || task.status === 'completed' || task.status === 'cancelled') return false;
    const filter = employee.taskFilter;
    if (filter.managementStatuses.length > 0 && !filter.managementStatuses.includes(task.managementStatus)) return false;
    if (filter.taskTypes.length > 0 && !filter.taskTypes.includes(task.taskType)) return false;
    if (filter.requiredTags.length > 0 && filter.requiredTags.some((tag) => !task.tags.includes(tag))) return false;
    return true;
  }

  function publishExecution(execution: DigitalEmployeeExecutionRecord): void {
    options.publishRealtimeEvent('digital_employee.execution.changed', {
      projectId: execution.projectId,
      taskId: execution.taskId,
      executionId: execution.id,
      employeeId: execution.employeeId,
      status: execution.status,
      deliveryStage: execution.deliveryStage,
      updatedAt: execution.updatedAt,
    });
  }

  schedule(2_000);
  return {
    kick: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      schedule(0);
    },
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await active;
    },
  };
}

function parseWorkerWorkManagementCommand<TInput extends object>(input: {
  application: WorkManagementCommandApplication;
  commandType: (typeof workManagementCommandTypes)[keyof typeof workManagementCommandTypes];
  scopeKind: Extract<CommandScopeKind, 'project' | 'task' | 'settings'>;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
  actorId: string;
}): ParsedWorkManagementMutation<TInput> {
  return input.application.parse<TInput>({
    value: workManagementEnvelope(input),
    commandType: input.commandType,
    scopeKind: input.scopeKind,
    expectedScopeId: () => input.scopeId,
  });
}

function workManagementEnvelope<TInput extends object>(input: {
  commandType: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
  actorId: string;
}): { command: CommandEnvelope<{ operationIdentity: string; inputSha256: string }>; input: TInput } {
  return commandEnvelope({ ...input, inputSha256: workManagementInputSha256(input.input) });
}

function commandCenterEnvelope<TInput extends object>(input: {
  commandType: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
  actorId: string;
}): { command: CommandEnvelope<{ operationIdentity: string; inputSha256: string }>; input: TInput } {
  return commandEnvelope({ ...input, inputSha256: commandCenterInputSha256(input.input) });
}

function workspaceGitEnvelope<TInput extends object>(input: {
  commandType: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
  actorId: string;
}): { command: CommandEnvelope<{ operationIdentity: string; inputSha256: string }>; input: TInput } {
  return commandEnvelope({ ...input, inputSha256: workspaceGitInputSha256(input.input) });
}

function commandEnvelope<TInput extends object>(input: {
  commandType: string;
  scopeKind: CommandScopeKind;
  scopeId: string;
  operationIdentity: string;
  input: TInput;
  actorId: string;
  inputSha256: string;
}): { command: CommandEnvelope<{ operationIdentity: string; inputSha256: string }>; input: TInput } {
  return {
    command: {
      schemaGeneration: commandEnvelopeSchemaGeneration,
      commandId: stableIdentity('command_digital_employee', `${input.commandType}\0${input.scopeKind}\0${input.scopeId}\0${input.operationIdentity}`),
      commandType: input.commandType,
      actor: { kind: 'worker', id: input.actorId },
      scope: { kind: input.scopeKind, id: input.scopeId },
      expectedRevision: null,
      idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
      issuedAt: stableIssuedAt(input.operationIdentity),
      payload: { operationIdentity: input.operationIdentity, inputSha256: input.inputSha256 },
    },
    input: input.input,
  };
}

function stableIssuedAt(identity: string): string {
  const seconds = Number.parseInt(createHash('sha256').update(identity).digest('hex').slice(0, 8), 16);
  return new Date(Date.UTC(2020, 0, 1) + seconds * 1_000).toISOString();
}

function stableIdentity(prefix: string, seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
}

function buildEmployeeSupplementalInfo(execution: DigitalEmployeeExecutionRecord, employee: DigitalEmployeeRecord, effectivePermissions: { allowCodeChanges: boolean; allowTests: boolean }): string {
  const grants =
    execution.source === 'exploration'
      ? []
      : Object.entries(execution.deliveryGrantsSnapshot)
          .filter(([, value]) => value)
          .map(([key]) => key);
  const skillInstruction = employee.skillIds[0] ? 'Zeus 已按本次执行快照解析并加载员工的默认 Skill；Skill 只提供执行说明和资源，不授予工具、凭据或额外副作用权限。' : '未为该员工配置默认 Skill。';
  return [
    `你正在以 Zeus 数字员工“${employee.name}”身份工作。岗位：${employee.role}；业务领域：${employee.domain || '通用'}。`,
    skillInstruction,
    `员工提示词：${employee.prompt}`,
    execution.source === 'exploration'
      ? '本次属于自主探索：权限固定为只读，只能查看已分配项目中的任务、代码和文档；不得扫描其他项目、本机任意目录或未授权外部系统。输出有证据的候选任务，不执行代码或交付写操作。'
      : `本次工作来源：${execution.source}。员工授权与任务权限取交集后，代码修改权限：${effectivePermissions.allowCodeChanges ? '允许' : '不允许'}；验证权限：${effectivePermissions.allowTests ? '允许' : '不允许'}。`,
    grants.length > 0 ? `提交、推送、合入、部署和任务完结由 Zeus 在会话完成后依据执行快照统一编排；本会话不要自行执行这些动作。已授权动作：${grants.join('、')}。` : '本次未授权自动提交、推送、合入、部署或任务完结；不要自行执行这些动作。',
    '必须区分已证实结果、理论风险与现场未验证项；遇到用户确认、审批、冲突或结果未知时停下并等待，不得盲目重试。',
  ].join('\n\n');
}

function firstDeliveryStage(execution: DigitalEmployeeExecutionRecord) {
  return nextDeliveryStage(execution, 'none');
}

function nextDeliveryStage(execution: DigitalEmployeeExecutionRecord, after: DigitalEmployeeExecutionRecord['deliveryStage']): DigitalEmployeeExecutionRecord['deliveryStage'] {
  const grants = execution.deliveryGrantsSnapshot;
  const stages: Array<[DigitalEmployeeExecutionRecord['deliveryStage'], boolean]> = [
    ['commit', grants.allowCommit],
    ['push', grants.allowPush],
    ['merge', grants.allowMerge],
    ['deploy', grants.allowDeploy],
    ['complete', grants.allowComplete],
  ];
  const index = after === 'none' ? -1 : stages.findIndex(([stage]) => stage === after);
  return stages.slice(index + 1).find(([, enabled]) => enabled)?.[0] ?? 'done';
}

function deliveryStageLabel(stage: 'commit' | 'push' | 'merge'): string {
  if (stage === 'commit') return '提交';
  if (stage === 'push') return '推送';
  return '合入';
}

function nextScheduledRun(automation: DigitalEmployeeAutomationRecord, from: Date): string | null {
  const config = automation.triggerConfig;
  if (automation.triggerKind === 'immediate' || automation.triggerKind === 'once' || isTaskEventTrigger(automation.triggerKind) || automation.triggerKind === 'code_changed') return null;
  if (automation.triggerKind === 'interval') {
    const minutes = typeof config.intervalMinutes === 'number' ? Math.max(1, Math.trunc(config.intervalMinutes)) : 60;
    return new Date(from.getTime() + minutes * 60_000).toISOString();
  }
  const hour = typeof config.hour === 'number' ? Math.max(0, Math.min(23, Math.trunc(config.hour))) : 9;
  const minute = typeof config.minute === 'number' ? Math.max(0, Math.min(59, Math.trunc(config.minute))) : 0;
  const candidate = new Date(from);
  candidate.setHours(hour, minute, 0, 0);
  if (automation.triggerKind === 'daily') {
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.toISOString();
  }
  const weekday = typeof config.weekday === 'number' ? Math.max(0, Math.min(6, Math.trunc(config.weekday))) : 1;
  const dayDelta = (weekday - candidate.getDay() + 7) % 7;
  candidate.setDate(candidate.getDate() + dayDelta);
  if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 7);
  return candidate.toISOString();
}

function isTaskEventTrigger(value: DigitalEmployeeAutomationRecord['triggerKind']): value is 'task_created' | 'task_updated' | 'task_status_changed' {
  return value === 'task_created' || value === 'task_updated' || value === 'task_status_changed';
}

function isCapabilityModel(value: unknown): value is { id: string; model: string; agentKind: 'codex' | 'pi'; available: boolean } {
  return isRecord(value) && typeof value.id === 'string' && typeof value.model === 'string' && (value.agentKind === 'codex' || value.agentKind === 'pi') && typeof value.available === 'boolean';
}

function isRepositoryCapability(value: unknown): value is { id: string; name: string; suggestedBranchName: string; sourceRefs: Array<{ ref: string; kind: string; current: boolean }> } {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.suggestedBranchName === 'string' &&
    Array.isArray(value.sourceRefs) &&
    value.sourceRefs.every((source) => isRecord(source) && typeof source.ref === 'string' && typeof source.kind === 'string' && typeof source.current === 'boolean')
  );
}

function filePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => (typeof entry === 'string' ? [entry] : isRecord(entry) && typeof entry.path === 'string' ? [entry.path] : []));
}

function readTaskSourceContext(task: ZeusTaskRecord): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(task.sourceContextJson);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function interpolateAutomationText(value: string, event: DigitalEmployeeProjectEvent | null): string {
  return value
    .replaceAll('{{event_task_id}}', event?.taskId ?? '')
    .replaceAll('{{event_type}}', event?.eventType ?? '')
    .trim();
}

function readTaskType(value: unknown): ZeusTaskRecord['taskType'] {
  return value === 'defect' || value === 'optimization' || value === 'requirement' ? value : 'requirement';
}

interface OrchestratorFailure extends Error {
  code: string;
  recoveryRequired: boolean;
}

function orchestratorError(code: string, message: string, recoveryRequired: boolean): OrchestratorFailure {
  return Object.assign(new Error(message), { code, recoveryRequired });
}

function normalizeOrchestratorError(error: unknown): { code: string; message: string; recoveryRequired: boolean } {
  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown; recoveryRequired?: unknown };
    const code = typeof candidate.code === 'string' ? candidate.code : 'ZEUS_DIGITAL_EMPLOYEE_EXECUTION_FAILED';
    const outcomeUnknown = code.includes('OUTCOME_UNKNOWN') || candidate.recoveryRequired === true;
    return { code, message: error.message || '数字员工执行失败。', recoveryRequired: outcomeUnknown };
  }
  return { code: 'ZEUS_DIGITAL_EMPLOYEE_EXECUTION_FAILED', message: '数字员工执行失败。', recoveryRequired: false };
}

function httpOrchestratorError(code: string, response: { statusCode: number; body: string }, recoveryRequired: boolean): OrchestratorFailure {
  let message = `${code} (${response.statusCode})`;
  try {
    const body: unknown = JSON.parse(response.body);
    if (isRecord(body) && typeof body.message === 'string') message = body.message;
  } catch {
    // 非 JSON 错误正文只保留状态码，不把完整 HTML 或日志写入业务表。
  }
  return orchestratorError(code, message, recoveryRequired);
}

function httpErrorCode(response: { body: string }): string | null {
  try {
    const body: unknown = JSON.parse(response.body);
    return isRecord(body) && typeof body.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

function nextDeployRunRound(deliveryState: Record<string, unknown>, reason: string): Record<string, unknown> {
  const currentRound = typeof deliveryState.deployRunRound === 'number' ? Math.max(0, Math.trunc(deliveryState.deployRunRound)) : 0;
  const nextState: Record<string, unknown> = { ...deliveryState, deployRunRound: currentRound + 1, deployRecoveryReason: reason };
  delete nextState.deployRunId;
  return nextState;
}

function retryWouldDuplicateUnknownWork(code: string): boolean {
  return (
    code.includes('OUTCOME_UNKNOWN') ||
    code.includes('ACCEPTANCE_NOT_DURABLE') ||
    code === 'ZEUS_DIGITAL_EMPLOYEE_CONVERSATION_MISSING' ||
    code === 'ZEUS_DIGITAL_EMPLOYEE_MERGE_EVIDENCE_MISSING' ||
    code === 'ZEUS_DIGITAL_EMPLOYEE_DEPLOY_RUN_MISSING'
  );
}

function serializeError(error: unknown): Record<string, unknown> {
  const normalized = normalizeOrchestratorError(error);
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
