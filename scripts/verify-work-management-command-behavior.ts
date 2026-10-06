import { access, link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAiRuntimeSessionManager } from '../packages/ai-runtime/src/index.js';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import {
  CommandDeliveryRepository,
  DigitalEmployeeRepository,
  DigitalEmployeeTemplateRepository,
  DigitalEmployeeExecutionRepository,
  createZeusDatabase,
  ProjectRepository,
  RuntimeSessionRepository,
  TaskEventFileProjectionRepository,
  TaskEventRepository,
  TaskRepository,
  ZeusDatabase,
  type ZeusTaskRecord,
} from '../packages/storage/src/index.js';
import { createGitIntegrationOperations, type GitIntegrationOperationDependencies } from '../packages/local-server/src/gitIntegrationOperations.js';
import { runtimeSessionIsConfirmedTerminal } from '../packages/local-server/src/runtimeQueryApplication.js';
import { WorkManagementCommandApplication, workManagementCommandTypes, workManagementInputSha256, type WorkManagementCommandPayload } from '../packages/local-server/src/workManagementCommandApplication.js';
import { TaskEventFileProjectionService } from '../packages/local-server/src/taskEventFileProjectionService.js';
import { migrateDigitalEmployeeGlobalIdentity } from '../packages/storage/src/digitalEmployeeIdentityMigration.js';
import {
  ArtifactStore,
  ConversationRepository,
  ConversationGoalRepository,
  ConversationTurnRepository,
  DigitalTeamWorkflowRunRepository,
  DigitalTeamNodeAttemptRepository,
  DefectWorkflowRepository,
  EmployeeMemoryProposalRepository,
  LongTermMemoryRepository,
  TaskWorkDeliverableRepository,
  TaskWorkItemRepository,
  TaskWorkDecisionRepository,
  TaskWorkReviewRepository,
  TaskWorkPlanningRepository,
  TaskWorkRunRepository,
  TaskWorkspaceRepository,
  WorkArtifactRepository,
  taskWorkDeliverableArtifactGeneration,
  type TaskWorkRunRecord,
} from '../packages/storage/src/index.js';
import { WorkArtifactDelivery } from '../packages/local-server/src/workArtifactDelivery.js';
import { ContextSourceCatalog } from '../packages/local-server/src/contextSourceCatalog.js';
import { selectEmployeeMemories } from '../packages/local-server/src/employeeMemoryContext.js';
import { normalizeWorkSettings, registerTaskWorkManagement, type TaskWorkPreview } from '../packages/local-server/src/taskWorkManagement.js';
import { registerDigitalEmployeeRoutes } from '../packages/local-server/src/digitalEmployeeRoutes.js';
import { digitalTeamWorkflowSchemaGeneration, type DigitalTeamWorkflowDefinition } from '../packages/shared/src/digitalTeamWorkflow.js';
import { mergeEmployeeWorkSettings } from '../packages/shared/src/employeeWorkPlanning.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-work-management-command-probe-'));
const observed: Record<string, unknown> = {};

/** 新工作丢弃历史执行偏好，保留业务要求，并且下层不能放宽权限。 */
const simplifiedSettings = normalizeWorkSettings({ modelOverride: 'retired-model', reasoningEffort: 'high', serviceTier: 'priority', workMode: 'plan', skillIds: ['retired-skill'], promptOverride: '本次工作要求', permissionMode: 'auto' });
assertProbe(JSON.stringify(simplifiedSettings) === JSON.stringify({ promptOverride: '本次工作要求', permissionMode: 'auto' }), '工作配置不应继续保存历史执行偏好');
/** 同时覆盖全局、阶段、单份工作的历史字段，避免旧配置重新进入执行快照。 */
const mergedSettings = mergeEmployeeWorkSettings({ modelOverride: 'retired-model', permissionMode: 'read-only' }, { permissionMode: 'full-access', promptOverride: '实际要求', skillIds: ['retired-skill'] });
assertProbe(JSON.stringify(mergedSettings) === JSON.stringify({ permissionMode: 'read-only', promptOverride: '实际要求' }), '统一执行默认必须去除重复配置并保持只读约束');

try {
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    const deliveries = new CommandDeliveryRepository(db);
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    let clock = Date.parse('2026-08-21T03:00:00.000Z');
    const application = new WorkManagementCommandApplication({ db, deliveries, redactSensitiveText: (value) => ({ text: value.replaceAll('probe-secret', '[REDACTED]') }), now: () => new Date((clock += 1_000)) });

    const projectInput = { name: '命令探针项目', localPath: join(probeRoot, 'project') };
    const projectRequest = commandRequest({
      commandId: 'command_work_management_project_create_probe',
      commandType: workManagementCommandTypes.projectCreate,
      scope: { kind: 'project', id: 'project_work_management_probe' },
      operationIdentity: 'project_work_management_probe',
      input: projectInput,
    });
    const parsedProject = application.parse<typeof projectInput>({
      value: projectRequest,
      commandType: workManagementCommandTypes.projectCreate,
      scopeKind: 'project',
      expectedScopeId: ({ operationIdentity }) => operationIdentity,
    });
    let createCalls = 0;
    const createProject = () =>
      application.executeCore({
        parsed: parsedProject,
        destinationId: 'work-management-project-application',
        resourceId: parsedProject.operationIdentity,
        mutateBusinessState: () => {
          createCalls += 1;
          return projects.create({ id: parsedProject.operationIdentity, ...projectInput });
        },
      });
    const created = createProject();
    const replay = createProject();
    projects.update(created.result.id, { name: '后续真实修改' });
    const immutableReplay = application.replayAcceptedCore<typeof projectInput, ReturnType<ProjectRepository['create']>>({
      parsed: parsedProject,
      destinationId: 'work-management-project-application',
      resourceId: parsedProject.operationIdentity,
    });
    observed.coreCreateCalls = createCalls;
    /** 使用真实存储验证跨项目员工继承、项目覆盖和历史迁移边界。 */
    await verifyEmployeeIdentity(db, projects, tasks, created.result.id);
    await verifyWorkArtifactDelivery(db, projects, tasks);
    observed.coreReplay = replay.replayed;
    observed.immutableReplayName = immutableReplay?.result.name ?? null;
    observed.currentProjectName = projects.getById(created.result.id)?.name ?? null;

    const taskInput = { projectId: created.result.id, title: '回滚探针任务', taskType: 'requirement' as const, description: '' };
    const taskRequest = commandRequest({
      commandId: 'command_work_management_task_create_probe',
      commandType: workManagementCommandTypes.taskCreate,
      scope: { kind: 'task', id: 'task_0123456789abcdef0123456789abcdef' },
      operationIdentity: 'task_0123456789abcdef0123456789abcdef',
      input: taskInput,
    });
    const parsedTask = application.parse<typeof taskInput>({
      value: taskRequest,
      commandType: workManagementCommandTypes.taskCreate,
      scopeKind: 'task',
      expectedScopeId: ({ operationIdentity }) => operationIdentity,
    });
    observed.rollbackError = captureCode(() =>
      application.executeCore({
        parsed: parsedTask,
        destinationId: 'work-management-task-application',
        resourceId: parsedTask.operationIdentity,
        mutateBusinessState: () => {
          tasks.create({ id: parsedTask.operationIdentity, ...taskInput, createdFrom: 'probe', sourceContext: {} });
          throw Object.assign(new Error('domain rejected'), { code: 'ZEUS_WORK_MANAGEMENT_PROBE_REJECTED' });
        },
      }),
    );
    observed.rollbackTaskRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM tasks WHERE id = ?`, [parsedTask.operationIdentity])?.count ?? -1;
    observed.rollbackInboxRows = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [parsedTask.command.commandId])?.count ?? -1;
    const acceptedTask = application.executeCore({
      parsed: parsedTask,
      destinationId: 'work-management-task-application',
      resourceId: parsedTask.operationIdentity,
      mutateBusinessState: () => tasks.create({ id: parsedTask.operationIdentity, ...taskInput, createdFrom: 'probe', sourceContext: {} }),
    });
    observed.acceptedTaskId = acceptedTask.result.id;
    const taskEvents = new TaskEventRepository(db);
    const projectionOutbox = new TaskEventFileProjectionRepository(db);

    const readyStatusInput = { status: 'ready' as const };
    const readyStatusRequest = commandRequest({
      commandId: 'command_work_management_task_status_ready_probe',
      commandType: workManagementCommandTypes.taskStatusUpdate,
      scope: { kind: 'task', id: acceptedTask.result.id },
      operationIdentity: 'work_management_task_status_ready_probe',
      input: readyStatusInput,
    });
    const parsedReadyStatus = application.parse<typeof readyStatusInput>({
      value: readyStatusRequest,
      commandType: workManagementCommandTypes.taskStatusUpdate,
      scopeKind: 'task',
      expectedScopeId: () => acceptedTask.result.id,
    });
    let readyTelegramEffect: ReturnType<WorkManagementCommandApplication['enqueueTaskStatusTelegramEffectInCurrentTransaction']> | null = null;
    let readyMutations = 0;
    const mutateReadyStatus = () =>
      application.executeCore({
        parsed: parsedReadyStatus,
        destinationId: 'work-management-task-status-application',
        resourceId: acceptedTask.result.id,
        mutateBusinessState: () => {
          readyMutations += 1;
          const updated = tasks.updateStatus(acceptedTask.result.id, readyStatusInput.status);
          const event = taskEvents.create({ taskId: updated.id, eventType: 'task.status.patch', title: '任务等待执行', payload: { from: 'draft', to: 'ready' } });
          projectionOutbox.enqueue(updated.id, event.id, event.createdAt);
          readyTelegramEffect = application.enqueueTaskStatusTelegramEffectInCurrentTransaction({ parent: parsedReadyStatus, taskId: updated.id, status: updated.status });
          return updated;
        },
      });
    const readyStatus = mutateReadyStatus();
    const readyStatusReplay = mutateReadyStatus();
    const readyChildSnapshot = readyTelegramEffect ? deliveries.get(readyTelegramEffect.parsed.command.commandId) : undefined;
    observed.statusCoreAtomic =
      readyStatus.result.status === 'ready' &&
      readyStatusReplay.replayed &&
      readyMutations === 1 &&
      taskEvents.listByTask(acceptedTask.result.id).some((event) => event.eventType === 'task.status.patch') &&
      projectionOutbox.get(acceptedTask.result.id)?.state === 'pending' &&
      readyChildSnapshot?.attempts.at(-1)?.state === 'prepared';
    observed.statusChildEnvelopeSensitive = readyChildSnapshot ? /probe-token|chatIds|messageBody/u.test(readyChildSnapshot.inbox.envelopeJson) : true;

    let fakeTelegramSends = 0;
    if (!readyTelegramEffect) throw new Error('Work Management Command 行为探针没有生成 Telegram 子效果。');
    const dispatchReadyTelegram = () =>
      application.dispatchTaskStatusTelegramEffect({
        effect: readyTelegramEffect!,
        beforeWrite: async () => undefined,
        invoke: async () => {
          fakeTelegramSends += 1;
          return { taskId: acceptedTask.result.id, status: 'ready', delivered: true as const, recipientCount: 1 };
        },
        mutateAcceptedBusinessState: (result) => {
          const event = taskEvents.create({ taskId: acceptedTask.result.id, eventType: 'telegram.notification.sent', title: 'Telegram 通知已发送', payload: { childCommandId: readyTelegramEffect!.parsed.command.commandId } });
          projectionOutbox.enqueue(event.taskId, event.id, event.createdAt);
          return result;
        },
        mutateFailureBusinessState: () => undefined,
      });
    const telegramAccepted = await dispatchReadyTelegram();
    const telegramReplay = await dispatchReadyTelegram();
    observed.telegramAcceptedReplay = telegramAccepted.result.delivered && telegramReplay.replayed && fakeTelegramSends === 1;

    const runningStatusInput = { status: 'running' as const };
    const runningStatusRequest = commandRequest({
      commandId: 'command_work_management_task_status_running_probe',
      commandType: workManagementCommandTypes.taskStatusUpdate,
      scope: { kind: 'task', id: acceptedTask.result.id },
      operationIdentity: 'work_management_task_status_running_probe',
      input: runningStatusInput,
    });
    const parsedRunningStatus = application.parse<typeof runningStatusInput>({
      value: runningStatusRequest,
      commandType: workManagementCommandTypes.taskStatusUpdate,
      scopeKind: 'task',
      expectedScopeId: () => acceptedTask.result.id,
    });
    let rolledBackChildCommandId: string | null = null;
    const taskEventCountBeforeRollback = taskEvents.listByTask(acceptedTask.result.id).length;
    observed.statusAtomicRollback = captureCode(() =>
      application.executeCore({
        parsed: parsedRunningStatus,
        destinationId: 'work-management-task-status-application',
        resourceId: acceptedTask.result.id,
        mutateBusinessState: () => {
          const updated = tasks.updateStatus(acceptedTask.result.id, runningStatusInput.status);
          const event = taskEvents.create({ taskId: updated.id, eventType: 'task.status.patch', title: '任务已开始', payload: { from: 'ready', to: 'running' } });
          projectionOutbox.enqueue(updated.id, event.id, event.createdAt);
          const child = application.enqueueTaskStatusTelegramEffectInCurrentTransaction({ parent: parsedRunningStatus, taskId: updated.id, status: updated.status });
          rolledBackChildCommandId = child.parsed.command.commandId;
          throw Object.assign(new Error('rollback status with child outbox'), { code: 'ZEUS_STATUS_CHILD_ROLLBACK_PROBE' });
        },
      }),
    );
    observed.statusRollbackFacts = {
      status: tasks.getById(acceptedTask.result.id)?.status ?? null,
      taskEventCount: taskEvents.listByTask(acceptedTask.result.id).length,
      expectedTaskEventCount: taskEventCountBeforeRollback,
      parentInboxRows: db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [parsedRunningStatus.command.commandId])?.count ?? -1,
      childInboxRows: rolledBackChildCommandId ? (db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM command_inbox WHERE command_id = ?`, [rolledBackChildCommandId])?.count ?? -1) : -1,
    };
    let runningTelegramEffect: ReturnType<WorkManagementCommandApplication['enqueueTaskStatusTelegramEffectInCurrentTransaction']> | null = null;
    application.executeCore({
      parsed: parsedRunningStatus,
      destinationId: 'work-management-task-status-application',
      resourceId: acceptedTask.result.id,
      mutateBusinessState: () => {
        const updated = tasks.updateStatus(acceptedTask.result.id, runningStatusInput.status);
        const event = taskEvents.create({ taskId: updated.id, eventType: 'task.status.patch', title: '任务已开始', payload: { from: 'ready', to: 'running' } });
        projectionOutbox.enqueue(updated.id, event.id, event.createdAt);
        runningTelegramEffect = application.enqueueTaskStatusTelegramEffectInCurrentTransaction({ parent: parsedRunningStatus, taskId: updated.id, status: updated.status });
        return updated;
      },
    });
    if (!runningTelegramEffect) throw new Error('Work Management Command 行为探针没有生成 unknown Telegram 子效果。');
    observed.telegramUnknownError = await captureAsyncCode(() =>
      application.dispatchTaskStatusTelegramEffect({
        effect: runningTelegramEffect!,
        beforeWrite: async () => undefined,
        invoke: async () => {
          throw Object.assign(new Error(`probe-secret ${'x'.repeat(1_100_000)}`), { code: 'ZEUS_TELEGRAM_CONNECTION_LOST' });
        },
        mutateAcceptedBusinessState: (result) => result,
        mutateFailureBusinessState: () => undefined,
      }),
    );
    const telegramUnknownSnapshot = deliveries.get(runningTelegramEffect.parsed.command.commandId);
    const telegramUnknownEvidence = telegramUnknownSnapshot?.attempts.at(-1)?.receipt?.evidenceJson ?? '';
    observed.telegramUnknownOutcome = telegramUnknownSnapshot?.attempts.at(-1)?.outcome ?? null;
    observed.telegramUnknownEvidenceBytes = Buffer.byteLength(telegramUnknownEvidence, 'utf8');
    observed.telegramUnknownEvidenceRedacted = !telegramUnknownEvidence.includes('probe-secret');
    observed.telegramUnknownReplay = await captureAsyncCode(() =>
      application.dispatchTaskStatusTelegramEffect({
        effect: runningTelegramEffect!,
        beforeWrite: async () => undefined,
        invoke: async () => ({ taskId: acceptedTask.result.id, status: 'running', delivered: true as const, recipientCount: 1 }),
        mutateAcceptedBusinessState: (result) => result,
        mutateFailureBusinessState: () => undefined,
      }),
    );

    const tampered = { ...projectRequest, input: { ...projectInput, name: '被篡改' } };
    observed.tamperedInput = captureCode(() =>
      application.parse({
        value: tampered,
        commandType: workManagementCommandTypes.projectCreate,
        scopeKind: 'project',
        expectedScopeId: ({ operationIdentity }) => operationIdentity,
      }),
    );

    let acceptedInvocations = 0;
    const acceptedExternal = externalRequest('accepted');
    const acceptedOnce = await application.executeExternal({
      parsed: acceptedExternal,
      destinationId: 'work-management-task-integration',
      resourceId: acceptedExternal.command.scope.id,
      externalOperationId: 'task-integration-finalize:integration-probe-accepted',
      invoke: async () => {
        acceptedInvocations += 1;
        return { state: 'merged' };
      },
      mutateAcceptedBusinessState: (result) => result,
    });
    const acceptedReplay = await application.executeExternal({
      parsed: acceptedExternal,
      destinationId: 'work-management-task-integration',
      resourceId: acceptedExternal.command.scope.id,
      externalOperationId: 'task-integration-finalize:integration-probe-accepted',
      invoke: async () => {
        acceptedInvocations += 1;
        return { state: 'must-not-run' };
      },
      mutateAcceptedBusinessState: (result) => result,
    });
    observed.externalAccepted = acceptedOnce.result.state;
    observed.externalAcceptedReplay = acceptedReplay.replayed;
    observed.externalAcceptedInvocations = acceptedInvocations;

    const beforeWrite = externalRequest('before-write');
    observed.failedBeforeWrite = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: beforeWrite,
        destinationId: 'work-management-task-integration',
        resourceId: beforeWrite.command.scope.id,
        externalOperationId: 'task-integration-start:integration-probe-before-write',
        beforeWrite: async () => {
          throw Object.assign(new Error('preflight rejected'), { code: 'ZEUS_PROBE_PREFLIGHT_REJECTED' });
        },
        invoke: async () => ({ state: 'must-not-run' }),
        mutateAcceptedBusinessState: (result) => result,
      }),
    );
    const beforeWriteRetry = await application.executeExternal({
      parsed: beforeWrite,
      destinationId: 'work-management-task-integration',
      resourceId: beforeWrite.command.scope.id,
      externalOperationId: 'task-integration-start:integration-probe-before-write',
      invoke: async () => ({ state: 'prepared' }),
      mutateAcceptedBusinessState: (result) => result,
    });
    observed.failedBeforeWriteAttempts = deliveries.get(beforeWrite.command.commandId)?.attempts.length ?? 0;
    observed.failedBeforeWriteRetry = beforeWriteRetry.result.state;

    const explicit = externalRequest('explicit');
    observed.explicitRejection = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: explicit,
        destinationId: 'work-management-task-integration',
        resourceId: explicit.command.scope.id,
        externalOperationId: 'task-integration-finalize:integration-probe-explicit',
        invoke: async () => {
          throw Object.assign(new Error('target rejected'), { code: 'ZEUS_PROBE_EXPLICIT_REJECTION' });
        },
        mutateAcceptedBusinessState: (result) => result,
        isExplicitRejection: (error) => captureCodeValue(error) === 'ZEUS_PROBE_EXPLICIT_REJECTION',
      }),
    );
    observed.explicitOutcome = deliveries.get(explicit.command.commandId)?.attempts.at(-1)?.outcome ?? null;

    const unknown = externalRequest('unknown');
    observed.unknownFailure = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown,
        destinationId: 'work-management-task-integration',
        resourceId: unknown.command.scope.id,
        externalOperationId: 'task-integration-push:integration-probe-unknown',
        invoke: async () => {
          throw Object.assign(new Error('connection lost'), { code: 'ZEUS_PROBE_CONNECTION_LOST' });
        },
        mutateAcceptedBusinessState: (result) => result,
      }),
    );
    observed.unknownOutcome = deliveries.get(unknown.command.commandId)?.attempts.at(-1)?.outcome ?? null;
    observed.unknownReplay = await captureAsyncCode(() =>
      application.executeExternal({
        parsed: unknown,
        destinationId: 'work-management-task-integration',
        resourceId: unknown.command.scope.id,
        externalOperationId: 'task-integration-push:integration-probe-unknown',
        invoke: async () => ({ state: 'must-not-run' }),
        mutateAcceptedBusinessState: (result) => result,
      }),
    );

    const localLogDirectory = join(probeRoot, 'local-logs');
    await mkdir(localLogDirectory, { recursive: true, mode: 0o700 });
    for (let index = 0; index < 257; index += 1) {
      const task = tasks.create({
        id: `task_projection_backlog_${String(index).padStart(3, '0')}`,
        projectId: created.result.id,
        title: `投影 backlog ${index}`,
        taskType: 'requirement',
        description: '',
        createdFrom: 'probe',
        sourceContext: {},
      });
      const event = taskEvents.create({ taskId: task.id, eventType: 'probe.backlog', title: 'backlog', payload: { index } });
      projectionOutbox.enqueue(task.id, event.id, event.createdAt);
    }
    await db.save();
    const backlogProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory });
    backlogProjection.recover(64);
    await backlogProjection.drain();
    await backlogProjection.close();
    observed.projectionBacklogAccepted = db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM task_event_file_projection_outbox WHERE task_id LIKE 'task_projection_backlog_%' AND state = 'accepted'`)?.count ?? -1;

    const highVolumeTask = tasks.create({
      id: 'task_projection_high_volume',
      projectId: created.result.id,
      title: '投影一万事件探针',
      taskType: 'requirement',
      description: '',
      createdFrom: 'probe',
      sourceContext: {},
    });
    for (let index = 0; index < 10_000; index += 1) {
      const event = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.volume', title: `event-${index}`, payload: { index } });
      projectionOutbox.enqueue(highVolumeTask.id, event.id, event.createdAt);
    }
    await db.save();
    let rowsRead = 0;
    const observedSteps: Array<{ mode: 'append' | 'rebuild'; step: 'events_synced' | 'events_renamed'; batchCount: number }> = [];
    const observedEventPort = {
      getProjectionCursor: (eventId: string) => taskEvents.getProjectionCursor(eventId),
      listProjectionBatch: (input: Parameters<TaskEventRepository['listProjectionBatch']>[0]) => {
        const rows = taskEvents.listProjectionBatch(input);
        rowsRead += rows.length;
        return rows;
      },
    };
    const highVolumeProjection = projectionService({ db, projectionOutbox, taskEvents: observedEventPort, localLogDirectory, observedSteps });
    highVolumeProjection.schedule(highVolumeTask.id);
    await highVolumeProjection.drain();
    rowsRead = 0;
    observedSteps.length = 0;
    const incrementalEvent = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.incremental', title: 'incremental', payload: { index: 10_000 } });
    projectionOutbox.enqueue(highVolumeTask.id, incrementalEvent.id, incrementalEvent.createdAt);
    await db.save();
    highVolumeProjection.schedule(highVolumeTask.id);
    await highVolumeProjection.drain();
    observed.projectionIncrementalRowsRead = rowsRead;
    observed.projectionIncrementalMode = observedSteps.at(-1)?.mode ?? null;
    await highVolumeProjection.close();

    let concurrentEventId: string | null = null;
    let concurrentInjected = false;
    const firstConcurrentEvent = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.concurrent.first', title: 'concurrent-first', payload: {} });
    projectionOutbox.enqueue(highVolumeTask.id, firstConcurrentEvent.id, firstConcurrentEvent.createdAt);
    await db.save();
    const concurrentProjection = new TaskEventFileProjectionService({
      db,
      outbox: projectionOutbox,
      events: taskEvents,
      localLogDirectory,
      sanitizeTaskId: (value) => value,
      redactSensitiveText: (value) => ({ text: value.replaceAll('probe-secret', '[REDACTED]') }),
      now: () => new Date((clock += 1_000)),
      projectionBatchSize: 128,
      projectionConcurrency: 1,
      onWriteStep: ({ taskId, mode, step }) => {
        if (taskId !== highVolumeTask.id || mode !== 'append' || step !== 'events_synced' || concurrentInjected) return;
        concurrentInjected = true;
        const event = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.concurrent.high_water', title: 'concurrent-high-water', payload: {} });
        projectionOutbox.enqueue(highVolumeTask.id, event.id, event.createdAt);
        concurrentEventId = event.id;
      },
    });
    concurrentProjection.schedule(highVolumeTask.id);
    await concurrentProjection.drain();
    await concurrentProjection.close();
    const concurrentReceipt = projectionOutbox.get(highVolumeTask.id);
    observed.projectionConcurrentHighWater = concurrentReceipt?.appliedEventId === concurrentEventId && concurrentReceipt.appliedRevision === concurrentReceipt.requestedRevision;

    const crashEvent = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.crash', title: 'crash-between-files', payload: { secret: 'probe-secret' } });
    projectionOutbox.enqueue(highVolumeTask.id, crashEvent.id, crashEvent.createdAt);
    await db.save();
    let faultInjected = false;
    const faultProjection = new TaskEventFileProjectionService({
      db,
      outbox: projectionOutbox,
      events: taskEvents,
      localLogDirectory,
      sanitizeTaskId: (value) => value,
      redactSensitiveText: (value) => ({ text: value.replaceAll('probe-secret', '[REDACTED]') }),
      now: () => new Date((clock += 1_000)),
      reportError: () => undefined,
      onWriteStep: ({ taskId, mode, step }) => {
        if (taskId === highVolumeTask.id && mode === 'append' && step === 'events_synced' && !faultInjected) {
          faultInjected = true;
          throw new Error(`probe-secret ${'x'.repeat(16_000)}`);
        }
      },
    });
    faultProjection.schedule(highVolumeTask.id);
    await faultProjection.drain();
    await faultProjection.close();
    const interruptedReceipt = projectionOutbox.get(highVolumeTask.id);
    observed.projectionInterruptedState = interruptedReceipt?.state ?? null;
    observed.projectionInterruptedErrorBytes = Buffer.byteLength(interruptedReceipt?.lastErrorJson ?? '', 'utf8');
    observed.projectionInterruptedErrorRedacted = !(interruptedReceipt?.lastErrorJson ?? '').includes('probe-secret');

    const recoverySteps: Array<{ mode: 'append' | 'rebuild'; step: 'events_synced' | 'events_renamed'; batchCount: number }> = [];
    const recoveryProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory, observedSteps: recoverySteps });
    recoveryProjection.recover(64);
    await recoveryProjection.drain();
    await recoveryProjection.close();
    const eventFilePath = join(localLogDirectory, 'tasks', highVolumeTask.id, 'events.jsonl');
    const timelineFilePath = join(localLogDirectory, 'tasks', highVolumeTask.id, 'timeline.normalized.log');
    const [eventFile, timelineFile, taskDirectoryMetadata, eventFileMetadata, timelineFileMetadata] = await Promise.all([
      readFile(eventFilePath, 'utf8'),
      readFile(timelineFilePath, 'utf8'),
      lstat(join(localLogDirectory, 'tasks', highVolumeTask.id)),
      lstat(eventFilePath),
      lstat(timelineFilePath),
    ]);
    const eventLines = eventFile.trimEnd().split('\n');
    const timelineLines = timelineFile.trimEnd().split('\n');
    const eventIds = eventLines.map((line) => (JSON.parse(line) as { id: string }).id);
    const authoritativeEventCount = taskEvents.listByTask(highVolumeTask.id).length;
    observed.projectionRecoveryMode = recoverySteps.at(-1)?.mode ?? null;
    observed.projectionNoDuplicate = eventIds.length === new Set(eventIds).size && eventIds.length === authoritativeEventCount && timelineLines.length === authoritativeEventCount;
    observed.projectionSecureModes = {
      directory: taskDirectoryMetadata.mode & 0o777,
      events: eventFileMetadata.mode & 0o777,
      timeline: timelineFileMetadata.mode & 0o777,
    };

    const highVolumeTaskDirectory = join(localLogDirectory, 'tasks', highVolumeTask.id);
    const staleEventsTemporary = join(highVolumeTaskDirectory, 'events.jsonl.projection-999-999-12345678-1234-4123-8123-123456789abc.tmp');
    const staleTimelineTemporary = join(highVolumeTaskDirectory, 'timeline.normalized.log.projection-999-999-abcdef12-3456-4567-8abc-abcdef123456.tmp');
    const unrelatedTemporary = join(highVolumeTaskDirectory, 'events.jsonl.projection-manual.tmp');
    await Promise.all([writeFile(staleEventsTemporary, 'stale-events', { mode: 0o600 }), writeFile(staleTimelineTemporary, 'stale-timeline', { mode: 0o600 }), writeFile(unrelatedTemporary, 'keep', { mode: 0o600 })]);
    const cleanupEvent = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.cleanup', title: 'cleanup-stale-temporary', payload: {} });
    projectionOutbox.enqueue(highVolumeTask.id, cleanupEvent.id, cleanupEvent.createdAt);
    await db.save();
    const cleanupClaim = projectionOutbox.claim(highVolumeTask.id, new Date((clock += 1_000)).toISOString());
    if (!cleanupClaim) throw new Error('Work Management Command 行为探针无法建立遗留临时文件的 write_started 恢复现场。');
    projectionOutbox.markRetryable(highVolumeTask.id, cleanupClaim.targetRevision, { code: 'ZEUS_PROBE_REBUILD_INTERRUPTED' }, new Date((clock += 1_000)).toISOString());
    const cleanupProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory });
    cleanupProjection.schedule(highVolumeTask.id);
    await cleanupProjection.drain();
    await cleanupProjection.close();
    observed.projectionStaleTemporaryCleanup = !(await pathExists(staleEventsTemporary)) && !(await pathExists(staleTimelineTemporary)) && (await pathExists(unrelatedTemporary));

    const hardLinkPath = join(highVolumeTaskDirectory, 'events-hardlink-probe');
    await link(eventFilePath, hardLinkPath);
    const hardLinkEvent = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.hardlink', title: 'hardlink-rejected', payload: {} });
    projectionOutbox.enqueue(highVolumeTask.id, hardLinkEvent.id, hardLinkEvent.createdAt);
    await db.save();
    const hardLinkProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory, reportError: () => undefined });
    hardLinkProjection.schedule(highVolumeTask.id);
    await hardLinkProjection.drain();
    await hardLinkProjection.close();
    observed.projectionHardLinkRejected = projectionOutbox.get(highVolumeTask.id)?.state === 'write_started';
    await unlink(hardLinkPath);
    const hardLinkRecovery = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory });
    hardLinkRecovery.schedule(highVolumeTask.id);
    await hardLinkRecovery.drain();
    await hardLinkRecovery.close();
    observed.projectionHardLinkRecovered = projectionOutbox.get(highVolumeTask.id)?.state === 'accepted';

    const staleSymlinkTemporary = join(highVolumeTaskDirectory, 'events.jsonl.projection-999-999-fedcba98-7654-4321-8abc-fedcba987654.tmp');
    await symlink(eventFilePath, staleSymlinkTemporary);
    const symlinkEvent = taskEvents.create({ taskId: highVolumeTask.id, eventType: 'probe.symlink', title: 'symlink-rejected', payload: {} });
    projectionOutbox.enqueue(highVolumeTask.id, symlinkEvent.id, symlinkEvent.createdAt);
    await db.save();
    const symlinkClaim = projectionOutbox.claim(highVolumeTask.id, new Date((clock += 1_000)).toISOString());
    if (!symlinkClaim) throw new Error('Work Management Command 行为探针无法建立遗留符号链接的 write_started 恢复现场。');
    projectionOutbox.markRetryable(highVolumeTask.id, symlinkClaim.targetRevision, { code: 'ZEUS_PROBE_REBUILD_SYMLINK' }, new Date((clock += 1_000)).toISOString());
    const symlinkProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory, reportError: () => undefined });
    symlinkProjection.schedule(highVolumeTask.id);
    await symlinkProjection.drain();
    await symlinkProjection.close();
    observed.projectionStaleSymlinkRejected = projectionOutbox.get(highVolumeTask.id)?.state === 'write_started';
    await unlink(staleSymlinkTemporary);
    const symlinkRecovery = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory });
    symlinkRecovery.schedule(highVolumeTask.id);
    await symlinkRecovery.drain();
    await symlinkRecovery.close();

    const zeroWriteTask = tasks.create({
      id: 'task_projection_zero_write',
      projectId: created.result.id,
      title: '投影零字节写入探针',
      taskType: 'requirement',
      description: '',
      createdFrom: 'probe',
      sourceContext: {},
    });
    const zeroWriteEvent = taskEvents.create({ taskId: zeroWriteTask.id, eventType: 'probe.zero_write', title: 'zero-write', payload: {} });
    projectionOutbox.enqueue(zeroWriteTask.id, zeroWriteEvent.id, zeroWriteEvent.createdAt);
    await db.save();
    const zeroWriteProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory, writeChunk: async () => 0, reportError: () => undefined });
    zeroWriteProjection.schedule(zeroWriteTask.id);
    await zeroWriteProjection.drain();
    await zeroWriteProjection.close();
    observed.projectionZeroWriteRejected = projectionOutbox.get(zeroWriteTask.id)?.state === 'write_started';
    const zeroWriteRecovery = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory });
    zeroWriteRecovery.schedule(zeroWriteTask.id);
    await zeroWriteRecovery.drain();
    await zeroWriteRecovery.close();
    observed.projectionZeroWriteRecovered = projectionOutbox.get(zeroWriteTask.id)?.state === 'accepted';

    const controlTaskId = 'task_projection_control\r\nidentity';
    const controlTask = tasks.create({
      id: controlTaskId,
      projectId: created.result.id,
      title: '投影单行字段探针',
      taskType: 'requirement',
      description: '',
      createdFrom: 'probe',
      sourceContext: {},
    });
    const controlEvent = taskEvents.create({ taskId: controlTask.id, eventType: 'probe\r\nevent', title: `line-1\nline-2\u0001${'x'.repeat(4_000)}`, payload: {} });
    projectionOutbox.enqueue(controlTask.id, controlEvent.id, controlEvent.createdAt);
    await db.save();
    const sanitizeProjectionTaskId = (value: string) =>
      Array.from(value, (character) => {
        const point = character.codePointAt(0) ?? 0;
        return point <= 31 || (point >= 127 && point <= 159) ? '_' : character;
      }).join('');
    const controlProjection = projectionService({ db, projectionOutbox, taskEvents, localLogDirectory, sanitizeTaskId: sanitizeProjectionTaskId });
    controlProjection.schedule(controlTask.id);
    await controlProjection.drain();
    await controlProjection.close();
    const controlTimeline = await readFile(join(localLogDirectory, 'tasks', sanitizeProjectionTaskId(controlTask.id), 'timeline.normalized.log'), 'utf8');
    observed.projectionTimelineSingleLine =
      controlTimeline.trimEnd().split('\n').length === 1 &&
      controlTimeline.includes('probe\\u000d\\u000aevent') &&
      controlTimeline.includes('line-1\\u000aline-2\\u0001') &&
      controlTimeline.includes('taskId=task_projection_control\\u000d\\u000aidentity');

    observed.terminalCleanup = await verifyTaskTerminalCleanup(db, application, tasks.getById(acceptedTask.result.id)!);
    observed.quickCheck = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(createCalls === 1 && replay.replayed && observed.immutableReplayName === projectInput.name && observed.currentProjectName === '后续真实修改', 'Core accepted replay 必须只 mutation 一次并返回不可变结果');
    assertProbe(observed.rollbackError === 'ZEUS_WORK_MANAGEMENT_PROBE_REJECTED' && observed.rollbackTaskRows === 0 && observed.rollbackInboxRows === 0, '领域拒绝必须整体回滚业务事实与命令账本');
    assertProbe(observed.acceptedTaskId === parsedTask.operationIdentity, '回滚后的同一命令必须仍可首次成功接纳');
    assertProbe(observed.statusCoreAtomic === true && observed.statusChildEnvelopeSensitive === false, 'Task status、TaskEvent、投影 outbox、父 receipt 与无敏感正文的 Telegram 子 outbox 必须原子接纳');
    assertProbe(observed.telegramAcceptedReplay === true, 'Telegram 子效果 accepted replay 必须保持不可变且只写出一次');
    assertProbe(
      observed.statusAtomicRollback === 'ZEUS_STATUS_CHILD_ROLLBACK_PROBE' &&
        JSON.stringify(observed.statusRollbackFacts) === JSON.stringify({ status: 'ready', taskEventCount: taskEventCountBeforeRollback, expectedTaskEventCount: taskEventCountBeforeRollback, parentInboxRows: 0, childInboxRows: 0 }),
      '父 Task status 失败必须整体回滚任务事实、TaskEvent、投影 outbox、父账本与子外部 outbox',
    );
    assertProbe(
      observed.telegramUnknownError === 'ZEUS_TELEGRAM_CONNECTION_LOST' &&
        observed.telegramUnknownOutcome === 'outcome_unknown_after_write' &&
        observed.telegramUnknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED' &&
        observed.telegramUnknownEvidenceRedacted === true &&
        typeof observed.telegramUnknownEvidenceBytes === 'number' &&
        observed.telegramUnknownEvidenceBytes <= 3_000,
      'Telegram 写出后错误必须有界脱敏、保守 unknown 并阻断盲目重放',
    );
    assertProbe(observed.tamperedInput === 'ZEUS_WORK_MANAGEMENT_COMMAND_INVALID', '正文摘要不匹配必须在写入前拒绝');
    assertProbe(observed.externalAccepted === 'merged' && observed.externalAcceptedReplay === true && acceptedInvocations === 1, 'external accepted replay 必须返回不可变结果且不二次调用');
    assertProbe(observed.failedBeforeWrite === 'ZEUS_PROBE_PREFLIGHT_REJECTED' && observed.failedBeforeWriteAttempts === 2 && observed.failedBeforeWriteRetry === 'prepared', 'failed_before_write 必须允许安全 attempt 2');
    assertProbe(observed.explicitRejection === 'ZEUS_PROBE_EXPLICIT_REJECTION' && observed.explicitOutcome === 'explicitly_rejected', '外部明确拒绝必须形成 explicitly_rejected 回执');
    assertProbe(observed.unknownFailure === 'ZEUS_PROBE_CONNECTION_LOST' && observed.unknownOutcome === 'outcome_unknown_after_write' && observed.unknownReplay === 'ZEUS_COMMAND_DELIVERY_REPLAY_BLOCKED', '写出后未知必须阻断自动重放');
    assertProbe(observed.projectionBacklogAccepted === 257, '启动恢复必须分页处理超过 256 个任务的 outbox backlog');
    assertProbe(observed.projectionIncrementalMode === 'append' && typeof observed.projectionIncrementalRowsRead === 'number' && observed.projectionIncrementalRowsRead <= 4, '一万事件后的正常新事件必须只读取并追加游标增量');
    assertProbe(observed.projectionConcurrentHighWater === true, '投影写出期间的新事件必须通过 requested/applied 高水位继续收敛');
    assertProbe(
      observed.projectionInterruptedState === 'write_started' && observed.projectionInterruptedErrorRedacted === true && typeof observed.projectionInterruptedErrorBytes === 'number' && observed.projectionInterruptedErrorBytes <= 2_300,
      '两文件间故障必须保留 write_started，并保存有界脱敏错误',
    );
    assertProbe(observed.projectionRecoveryMode === 'rebuild' && observed.projectionNoDuplicate === true, 'write_started 恢复必须分批重建两文件且不重复事件');
    assertProbe(JSON.stringify(observed.projectionSecureModes) === JSON.stringify({ directory: 0o700, events: 0o600, timeline: 0o600 }), '任务投影目录和目标文件必须使用 0700/0600 权限');
    assertProbe(observed.projectionStaleTemporaryCleanup === true && observed.projectionStaleSymlinkRejected === true, '重建遗留临时文件必须有界清理自身普通文件并拒绝符号链接');
    assertProbe(observed.projectionHardLinkRejected === true && observed.projectionHardLinkRecovered === true, 'append/read 目标必须拒绝硬链接并在解除风险后重建收敛');
    assertProbe(observed.projectionZeroWriteRejected === true && observed.projectionZeroWriteRecovered === true, '底层 write 返回 0 必须立即失败并由 write_started 重建恢复');
    assertProbe(observed.projectionTimelineSingleLine === true, 'timeline 的 eventType、title 和 taskId 必须单行转义并按 UTF-8 字节有界');
    assertProbe(observed.quickCheck === 'ok', '临时数据库 quick_check 必须通过');
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

/** 用真实子进程检查任务结束能一次完成停止、归档和状态保存，不要求用户重试。 */
async function verifyTaskTerminalCleanup(db: ZeusDatabase, application: WorkManagementCommandApplication, task: ZeusTaskRecord) {
  /** 临时数据库保存真实运行状态，退出回调沿用产品的持久化顺序。 */
  const runtimeSessions = new RuntimeSessionRepository(db);
  /** 进程只在本探针的隔离目录启动。 */
  const aiRuntimeManager = createAiRuntimeSessionManager({
    allowedRoot: probeRoot,
    onSessionChange: (session) => {
      if (runtimeSessions.getById(session.id)) runtimeSessions.updateStatus(session.id, { status: session.status, endedAt: session.endedAt, exitCode: session.exitCode });
      else runtimeSessions.create(session);
    },
    onProcessStarted: ({ sessionId, pid }) => {
      runtimeSessions.updateStatus(sessionId, { status: 'running', pid });
    },
  });
  try {
    /** 两个存活进程验证并行停止，短进程验证准备之后自然退出的情况。 */
    const sessions = await Promise.all([60, 60, 0].map((seconds) => aiRuntimeManager.startSession({ projectId: task.projectId, taskId: task.id, command: '/bin/sleep', args: [String(seconds)], cwd: probeRoot })));
    /** 调用正式清理实现；本场景没有工作目录和会话通知。 */
    const operations = createGitIntegrationOperations({ aiRuntimeManager, runtimeSessions, recordTaskEvent: () => undefined } as GitIntegrationOperationDependencies);
    /** 保留准备时快照，确保清理阶段会重新读取已经自然退出的会话。 */
    const cleanup = { workspaces: [], conversations: [], runtimeSessions: runtimeSessions.list({ taskId: task.id }), activeConversationCount: 0, activeRuntimeSessionCount: 3, requiresConfirmation: true };
    await aiRuntimeManager.waitForSessionCompletion(sessions[2]!.id, 5_000);
    /** 正式命令账本必须直接收到成功结果，重复请求复用已有结果。 */
    const parsed = application.parse<{ status: string }>({
      value: commandRequest({
        commandId: 'command_work_management_terminal_cleanup_probe',
        commandType: workManagementCommandTypes.taskManagementStatusUpdate,
        scope: { kind: 'task', id: task.id },
        operationIdentity: 'work_management_terminal_cleanup_probe',
        input: { status: 'completed' },
      }),
      commandType: workManagementCommandTypes.taskManagementStatusUpdate,
      scopeKind: 'task',
      expectedScopeId: () => task.id,
    });
    /** 记录清理次数，确认成功回放不会重复操作进程。 */
    let cleanupCalls = 0;
    /** 使用真实外部操作与状态落库路径，不把模拟成功当作退出证据。 */
    const execute = () =>
      application.executeExternal({
        parsed,
        destinationId: 'work-management-task-management-status-external',
        resourceId: task.id,
        externalOperationId: `task-management-status:${parsed.operationIdentity}`,
        invoke: async () => {
          cleanupCalls += 1;
          await operations.closeTaskResourcesForTerminalStatus(task.id, cleanup);
        },
        mutateAcceptedBusinessState: () => new TaskRepository(db).updateManagementStatus(task.id, 'completed', task.updatedAt),
      });
    /** 首次操作应等待进程退出后直接成功。 */
    const completed = await execute();
    /** 同一操作再次到达时不得重新停止进程。 */
    const replay = await execute();
    assertProbe(completed.result.managementStatus === 'completed' && replay.replayed && cleanupCalls === 1, '结束任务必须一次成功，重复请求不得重新清理。');
    assertProbe(
      sessions.every((session) => {
        /** 以退出后的持久状态核实归档，不能只看已发送停止信号。 */
        const saved = runtimeSessions.getById(session.id);
        return Boolean(saved?.archived && runtimeSessionIsConfirmedTerminal(saved));
      }),
      '三个真实进程必须确认退出并归档。',
    );
    return { processes: sessions.length, managementStatus: completed.result.managementStatus, cleanupCalls, replayed: replay.replayed };
  } finally {
    await aiRuntimeManager.close();
  }
}

function commandRequest<TInput extends object>(input: {
  commandId: string;
  commandType: (typeof workManagementCommandTypes)[keyof typeof workManagementCommandTypes];
  scope: { kind: 'project' | 'task'; id: string };
  operationIdentity: string;
  input: TInput;
}) {
  const command: CommandEnvelope<WorkManagementCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId: input.commandId,
    commandType: input.commandType,
    actor: { kind: 'local_api', id: 'work-management-command-probe' },
    scope: input.scope,
    expectedRevision: null,
    idempotencyKey: `${input.commandType}:${input.operationIdentity}`,
    issuedAt: '2026-08-21T03:00:00.000Z',
    payload: { operationIdentity: input.operationIdentity, inputSha256: workManagementInputSha256(input.input) },
  };
  return { command, input: input.input };
}

function externalRequest(label: string) {
  const input = { label };
  const request = commandRequest({
    commandId: `command_work_management_external_${label}`,
    commandType: workManagementCommandTypes.taskIntegrationFinalize,
    scope: { kind: 'task', id: `task_work_management_external_${label}` },
    operationIdentity: `work_management_external_${label}`,
    input,
  });
  return {
    command: request.command,
    input,
    inputSha256: workManagementInputSha256(input),
    operationIdentity: request.command.payload.operationIdentity,
  };
}

function projectionService(input: {
  db: Awaited<ReturnType<typeof createZeusDatabase>>;
  projectionOutbox: TaskEventFileProjectionRepository;
  taskEvents: Pick<TaskEventRepository, 'getProjectionCursor' | 'listProjectionBatch'>;
  localLogDirectory: string;
  observedSteps?: Array<{ mode: 'append' | 'rebuild'; step: 'events_synced' | 'events_renamed'; batchCount: number }>;
  sanitizeTaskId?: (value: string) => string;
  writeChunk?: (handle: FileHandle, bytes: Buffer, offset: number, length: number) => Promise<number>;
  reportError?: (message: string, error: unknown) => void;
}): TaskEventFileProjectionService {
  let clock = Date.parse('2026-08-21T07:00:00.000Z');
  return new TaskEventFileProjectionService({
    db: input.db,
    outbox: input.projectionOutbox,
    events: input.taskEvents,
    localLogDirectory: input.localLogDirectory,
    sanitizeTaskId: input.sanitizeTaskId ?? ((value) => value),
    redactSensitiveText: (value) => ({ text: value.replaceAll('probe-secret', '[REDACTED]') }),
    now: () => new Date((clock += 1_000)),
    projectionBatchSize: 128,
    projectionConcurrency: 1,
    writeChunk: input.writeChunk,
    reportError: input.reportError,
    onWriteStep: ({ mode, step, batchCount }) => input.observedSteps?.push({ mode, step, batchCount }),
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function captureCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return captureCodeValue(error);
  }
}

async function captureAsyncCode(operation: () => Promise<unknown>): Promise<string | null> {
  try {
    await operation();
    return null;
  } catch (error) {
    return captureCodeValue(error);
  }
}

function captureCodeValue(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') return (error as { code: string }).code;
  return error instanceof Error ? error.name : String(error);
}

/** 员工身份探针沿用现有临时数据库，所有配置变化均走实际 Repository。 */
async function verifyEmployeeIdentity(db: ZeusDatabase, projects: ProjectRepository, tasks: TaskRepository, firstProjectId: string): Promise<void> {
  /** 全局目录、项目绑定与冻结执行使用真实存储实现。 */
  const templates = new DigitalEmployeeTemplateRepository(db);
  const employees = new DigitalEmployeeRepository(db);
  const executions = new DigitalEmployeeExecutionRepository(db);
  /** 第二个项目只持有稳定员工关联。 */
  const secondProject = projects.create({ name: '员工身份第二项目', localPath: join(probeRoot, 'employee-second-project') });
  /** 名称相同的员工必须仍有不同身份。 */
  const global = templates.create({ name: '员工身份探针', role: '开发', prompt: '全局通用要求', memoryEnabled: true });
  const sameName = templates.create({ name: global.name, role: global.role, prompt: '另一独立员工' });
  assertProbe(global.id !== sameName.id && global.identityKind === 'employee', '同名员工不能合并，用户创建记录应有全局员工身份。');
  /** 直接构造旧基础配置，验证历史动作不会再进入当前员工继承。 */
  const historicalGrants = { allowCommit: true, allowPush: true, allowMerge: true, allowDeploy: true, allowComplete: true };
  db.execute('UPDATE digital_employee_templates SET base_configuration_json = ? WHERE id = ?', [JSON.stringify({ memoryEnabled: true, allowCodeChanges: true, allowTests: true, deliveryGrants: historicalGrants }), global.id]);
  /** 两个项目关联同一全局员工，旧项目差异只保留原始证据。 */
  const first = employees.ensureProjectEmployee(firstProjectId, global.id);
  const second = employees.createFromTemplate({
    projectId: secondProject.id,
    template: global,
  });
  db.execute('UPDATE digital_employees SET project_overrides_json = ?, project_instructions = ?, enabled = 0 WHERE id = ?', [JSON.stringify({ memoryEnabled: true }), '第二项目必须先审查', second.id]);
  /** 原项目差异与停启列不能被新的身份关联写入覆盖。 */
  const historicalProjectConfiguration = () => db.get('SELECT project_overrides_json, project_instructions, memory_enabled, enabled FROM digital_employees WHERE id = ?', [second.id]);
  const historicalProjectBefore = JSON.stringify(historicalProjectConfiguration());
  assertProbe(!first.allowCodeChanges && !first.allowTests && Object.values(first.deliveryGrants).every((allowed) => !allowed), '当前员工公开配置不能继承全局记录中的历史动作授权。');
  /** 旧动作列保留给历史运行，新配置保存不得覆盖这些存量事实。 */
  db.execute('UPDATE digital_employees SET allow_code_changes = 1, allow_tests = 1, allow_commit = 1, allow_push = 1, allow_merge = 1, allow_deploy = 1, allow_complete = 1, deploy_command_id = ? WHERE id = ?', [
    'legacy_employee_deploy_command',
    first.id,
  ]);
  /** 使用真实旧列比对保存前后值，避免只检查当前有效配置投影。 */
  const readHistoricalActions = () =>
    db.get<Record<string, string | number | null>>('SELECT allow_code_changes, allow_tests, allow_commit, allow_push, allow_merge, allow_deploy, allow_complete, deploy_command_id FROM digital_employees WHERE id = ?', [first.id]);
  /** 记录历史字段原文。 */
  const historicalActionsBefore = JSON.stringify(readHistoricalActions());
  /** JSON 调用方即使注入身份字段，也不能改变已经授权的项目与员工来源。 */
  const scoped = employees.createFromTemplate({ projectId: firstProjectId, template: sameName, globalEmployeeId: global.id } as never);
  assertProbe(scoped.projectId === firstProjectId && scoped.globalEmployeeId === sameName.id, '项目覆盖不能扩大授权范围或替换全局员工来源。');
  assertProbe(captureCode(() => employees.update(first.id, { expectedRevision: first.revision, projectOverrides: { memoryEnabled: true } } as never)) === 'ZEUS_DIGITAL_EMPLOYEE_INVALID', '已经退役的项目覆盖不能继续写入。');
  assertProbe(employees.ensureProjectEmployee(firstProjectId, global.id).id === first.id && employees.resolveProjectEmployee(firstProjectId, second.id) === undefined, '重复绑定必须复用稳定 ID，其他项目的绑定不能被读取。');
  /** 已启动执行冻结旧的模型与权限。 */
  const task = tasks.create({ projectId: firstProjectId, title: '员工身份冻结探针', taskType: 'requirement', description: '', createdFrom: 'probe', sourceContext: {} });
  const execution = executions.create({ employee: { ...employees.getById(first.id)!, model: 'identity-model', permissionMode: 'full-access' }, taskId: task.id, source: 'manual' });
  const snapshotBefore = db.get<{ employee_snapshot_json: string }>('SELECT employee_snapshot_json FROM digital_employee_executions WHERE id = ?', [execution.id])!.employee_snapshot_json;
  templates.update(global.id, { expectedRevision: global.revision, prompt: '更新后的全局要求', memoryEnabled: false });
  const inherited = employees.getById(first.id)!;
  const overridden = employees.getById(second.id)!;
  assertProbe(
    inherited.model === null &&
      inherited.prompt === '更新后的全局要求' &&
      inherited.memoryEnabled === false &&
      inherited.permissionMode === 'read-only' &&
      overridden.prompt === '更新后的全局要求' &&
      overridden.entrypointMigrationState === 'ready' &&
      overridden.memoryEnabled === false &&
      overridden.enabled &&
      overridden.permissionMode === 'read-only',
    '所有新工作统一读取全局职责和经验，旧项目要求、经验覆盖及停启不再生效。',
  );
  assertProbe(executions.getById(execution.id)?.employeeSnapshot.model === 'identity-model', '新配置不能改写已启动的运行快照。');
  /** 更新相同身份只更新关联修订，不清理或覆写历史项目列。 */
  const restored = employees.update(second.id, { expectedRevision: overridden.revision, globalEmployeeId: global.id });
  assertProbe(
    restored.prompt === '更新后的全局要求' &&
      restored.memoryEnabled === false &&
      restored.permissionMode === 'read-only' &&
      restored.entrypointMigrationState === 'ready' &&
      JSON.stringify(historicalProjectConfiguration()) === historicalProjectBefore,
    '更新员工关联后仍读取全局默认，并逐字保留原项目列。',
  );
  /** 项目关联不允许再次维护职责、经验或停启。 */
  for (const input of [{ projectInstructions: '保存后的项目要求' }, { memoryEnabled: true }, { enabled: false }]) {
    assertProbe(captureCode(() => employees.update(first.id, { expectedRevision: inherited.revision, ...input } as never)) === 'ZEUS_DIGITAL_EMPLOYEE_INVALID', '项目独立配置写入必须明确拒绝。');
  }
  assertProbe(JSON.stringify(readHistoricalActions()) === historicalActionsBefore, '当前配置保存不能改写历史员工动作授权或部署命令。');
  assertProbe(
    db.get<{ employee_snapshot_json: string }>('SELECT employee_snapshot_json FROM digital_employee_executions WHERE id = ?', [execution.id])!.employee_snapshot_json === snapshotBefore &&
      executions.getById(execution.id)!.deliveryGrantsSnapshot.allowDeploy,
    '当前配置保存不能改写已有冻结员工或交付授权。',
  );
  /** 内置模板只有创建用途，不能从工作入口直接绑定。 */
  const builtIn = templates.list().find((employee) => employee.builtIn)!;
  assertProbe(captureCode(() => employees.ensureProjectEmployee(secondProject.id, builtIn.id)) === 'ZEUS_DIGITAL_EMPLOYEE_GLOBAL_UNAVAILABLE', '模板不允许成为可指派员工。');
  /** 构造真实历史项目配置，再运行相同迁移逻辑。 */
  const legacy = employees.create({ projectId: secondProject.id, templateId: builtIn.id, name: '历史项目员工', role: '开发', prompt: '历史项目要求', memoryEnabled: false });
  /** 只复制身份、项目范围与冻结数据验证迁移，不绕过正式库降级保护。 */
  const migrationDb = new ZeusDatabase(new DatabaseSync(':memory:', { enableForeignKeyConstraints: false }), join(probeRoot, 'employee-legacy-probe.db'));
  try {
    migrationDb.execute('CREATE TABLE schema_migrations (migration_id TEXT PRIMARY KEY, description TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)');
    /** 自动化当前定义与历史修订使用同一真实结构，便于身份迁移固定原执行人。 */
    const migrationTables = [
      'projects',
      'digital_employee_templates',
      'digital_employees',
      'digital_employee_executions',
      'digital_employee_automations',
      'long_term_memories',
      'digital_team_workflow_templates',
      ...db.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'automation_%'").map((table) => table.name),
    ];
    for (const table of migrationTables) {
      /** 复制真实表结构与旧记录，不复制升级账本和保护触发器。 */
      const schema = db.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?', ['table', table])!;
      migrationDb.execute(schema.sql);
      for (const row of db.select<Record<string, string | number | null>>(`SELECT * FROM ${table}`))
        migrationDb.execute(
          `INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row)
            .map(() => '?')
            .join(', ')})`,
          Object.values(row),
        );
    }
    /** 原始升级差异只写入独立旧结构副本，不删除正式账本或绕过保护触发器。 */
    migrationDb.execute('UPDATE digital_employees SET project_overrides_json = ? WHERE id = ?', [JSON.stringify({ prompt: '项目独立要求', memoryEnabled: true, permissionMode: 'read-only' }), second.id]);
    /** 迁移前后都使用真实员工仓储。 */
    const migratedEmployees = new DigitalEmployeeRepository(migrationDb);
    const migratedTemplates = new DigitalEmployeeTemplateRepository(migrationDb);
    /** 无模板来源的独立员工同样自动保留，停用状态不能在升级中变更。 */
    const standalone = migratedEmployees.create({ projectId: secondProject.id, name: '无模板历史员工', role: '开发', prompt: '独立职责不能丢失。', memoryEnabled: false });
    migrationDb.execute('UPDATE digital_employees SET enabled=0 WHERE id=?', [standalone.id]);
    /** 软删除的绑定完全跳过，不恢复已被用户移除的员工。 */
    const removed = migratedEmployees.create({ projectId: secondProject.id, name: '已移除历史员工', role: '开发', prompt: '已移除职责。' });
    migrationDb.execute('UPDATE digital_employees SET deleted_at=? WHERE id=?', ['2026-10-05T01:00:00.000Z', removed.id]);
    /** 项目仍有效但旧模板已删除时，保留项目身份而不恢复原模板。 */
    const removedSource = migratedTemplates.create({ name: '已删除全局来源', role: '开发', prompt: '被删除的全局职责。' });
    migratedTemplates.delete(removedSource.id, removedSource.revision);
    const surviving = migratedEmployees.create({ projectId: secondProject.id, templateId: removedSource.id, name: '仍有效的项目员工', role: '开发', prompt: '项目中的有效职责。' });
    /** 来源经验使用原记录身份，迁移后仍需服从撤销和原项目限制。 */
    const identityMemory = new LongTermMemoryRepository(migrationDb);
    /** 已确认经验的来源与生命周期保持原样。 */
    const migrationMemoryCandidate = {
      candidateKind: 'stable_workflow' as const,
      effect: 'advisory' as const,
      source: { kind: 'user_explicit' as const, reference: 'identity-migration-probe', observedAt: '2026-10-05T01:00:00.000Z' },
      confirmationLevel: 'explicit' as const,
      confidence: 1,
      reviewAfter: '2027-10-05T01:00:00.000Z',
      recordedAt: '2026-10-05T01:00:00.000Z',
      scope: { kind: 'employee' as const, id: global.id },
    };
    for (const suffix of ['preserved', 'revoked', 'corrected', 'private']) {
      identityMemory.recordCandidate({
        ...migrationMemoryCandidate,
        id: `identity_migration_${suffix}`,
        memoryKey: `identity.migration.${suffix}`,
        content: `原员工经验 ${suffix}`,
        projectLimitId: suffix === 'private' ? firstProjectId : null,
      });
    }
    /** 结构非法但可解析的旧团队草稿不能阻断启动时员工身份迁移。 */
    const invalidTeamDefinitionJson = JSON.stringify({ nodes: null, edges: [], repairEmployeeId: global.id, note: '旧草稿原文必须保留。' });
    migrationDb.execute('INSERT INTO digital_team_workflow_templates(id,project_id,name,description,definition_json,ready,validation_issues_json,revision,created_at,updated_at,deleted_at) VALUES(?,?,?,?,?,0,?,7,?,?,NULL)', [
      'identity_migration_invalid_team',
      firstProjectId,
      '非法历史团队草稿',
      '',
      invalidTeamDefinitionJson,
      '["nodes-invalid"]',
      '2026-10-05T01:00:00.000Z',
      '2026-10-05T01:00:00.000Z',
    ]);
    migrateDigitalEmployeeGlobalIdentity(migrationDb);
    /** 读取原始存储行，确认早期引用迁移没有清洗或误启用坏草稿。 */
    const invalidTeamAfterMigration = migrationDb.get<{ definition_json: string; ready: number; revision: number }>('SELECT definition_json,ready,revision FROM digital_team_workflow_templates WHERE id=?', [
      'identity_migration_invalid_team',
    ]);
    assertProbe(invalidTeamAfterMigration?.definition_json === invalidTeamDefinitionJson && invalidTeamAfterMigration.ready === 0 && invalidTeamAfterMigration.revision === 7, '非法旧团队草稿原文、未就绪状态及修订保持，员工迁移继续完成。');
    assertProbe(
      migratedEmployees.getById(standalone.id)?.enabled === true &&
        migratedEmployees.getById(standalone.id)?.memoryEnabled === false &&
        Boolean(migratedEmployees.getById(standalone.id)?.globalEmployeeId) &&
        migrationDb.get<{ enabled: number }>('SELECT enabled FROM digital_employees WHERE id=?', [standalone.id])?.enabled === 0,
      '独立旧员工自动获得正式身份，原停用列保留但不再阻断新工作，员工本身的经验关闭保持。',
    );
    assertProbe(
      !migratedEmployees.getById(removed.id) && !migrationDb.get<{ global_employee_id: string | null }>('SELECT global_employee_id FROM digital_employees WHERE id=?', [removed.id])?.global_employee_id,
      '软删除绑定不能在自动迁移时复活。',
    );
    assertProbe(
      !migratedTemplates.getById(removedSource.id) && migratedEmployees.getById(surviving.id)?.prompt === surviving.prompt && migratedEmployees.getById(surviving.id)?.globalEmployeeId !== removedSource.id,
      '保留有效项目身份不能复活已删除的来源员工。',
    );
    assertProbe(migratedEmployees.getById(first.id)?.globalEmployeeId === global.id, '来源相同且无身份差异的绑定应继续复用原全局员工。');
    /** 有差异的项目成为独立正式员工，原来源员工继续保留。 */
    const promoted = migratedEmployees.getById(second.id)!;
    assertProbe(promoted.globalEmployeeId !== global.id && migratedTemplates.getById(promoted.globalEmployeeId!)?.builtIn === false, '旧项目独立提示词必须自动成为正式员工，不能要求用户重新确认。');
    /** 旧项目迁出的身份保留精确读取，但不能冒充用户主动创建的目录成员。 */
    const catalogIds = migratedTemplates
      .list()
      .filter((record) => !record.builtIn)
      .map((record) => record.id);
    assertProbe(
      catalogIds.includes(global.id) && catalogIds.includes(sameName.id) && !catalogIds.includes(promoted.globalEmployeeId!) && !catalogIds.includes(migratedEmployees.getById(standalone.id)!.globalEmployeeId!),
      '目录应保留用户创建的同名独立员工，排除旧项目自动迁出的身份。',
    );
    /** 准确来源记录读取只作用于迁移时原项目，不形成未来经验订阅。 */
    const migratedMemories = (projectId = secondProject.id) =>
      identityMemory.resolveForContext({ employeeId: second.id, globalEmployeeId: promoted.globalEmployeeId, projectId, asOf: '2026-10-05T03:00:00.000Z' }).selected.map((record) => record.id);
    assertProbe(
      migratedMemories().includes('identity_migration_preserved') && !migratedMemories().includes('identity_migration_private') && !migratedMemories(firstProjectId).includes('identity_migration_preserved'),
      '迁移必须保留准确已有经验来源，并拒绝其他项目的私有经验。',
    );
    identityMemory.recordCandidate({ ...migrationMemoryCandidate, id: 'identity_migration_future', memoryKey: 'identity.migration.future', content: '迁移后原员工的新经验。' });
    identityMemory.tombstone('identity_migration_revoked', { at: '2026-10-05T02:00:00.000Z', reason: '原来源经验已撤销' });
    identityMemory.supersede('identity_migration_corrected', { ...migrationMemoryCandidate, id: 'identity_migration_corrected_new', content: '迁移后对原员工经验的纠正。' });
    assertProbe(
      !migratedMemories().some((id) => ['identity_migration_future', 'identity_migration_revoked', 'identity_migration_corrected', 'identity_migration_corrected_new'].includes(id)),
      '迁移经验仍须撤销或失效，且不能读来源员工后续新增与纠正内容。',
    );
    assertProbe(promoted.prompt === '项目独立要求' && promoted.memoryEnabled === true && promoted.entrypointMigrationState === 'ready', '自动迁移保留真实员工职责，旧项目补充不再进入新工作。');
    /** 已过期的原记录即使在迁移清单内也不能再次生效。 */
    assertProbe(
      !identityMemory
        .resolveForContext({ employeeId: second.id, globalEmployeeId: promoted.globalEmployeeId, projectId: secondProject.id, asOf: '2028-10-05T03:00:00.000Z' })
        .selected.some((record) => record.id === 'identity_migration_preserved'),
      '迁移不能延长原经验的复核期限。',
    );
    migratedEmployees.update(second.id, { expectedRevision: promoted.revision, globalEmployeeId: sameName.id });
    assertProbe(
      migratedMemories().includes('identity_migration_preserved') &&
        !identityMemory.resolveForContext({ employeeId: second.id, projectId: secondProject.id, asOf: '2026-10-05T03:00:00.000Z' }).selected.some((record) => record.id === 'identity_migration_preserved'),
      '改绑不能把迁移经验交给另一身份，已经冻结的迁出身份仍保留原来源。',
    );
    /** 迁移后的记录使用相同有效配置读取器。 */
    const migrated = new DigitalEmployeeRepository(migrationDb).getById(legacy.id)!;
    assertProbe(
      migrated.id === legacy.id &&
        Boolean(migrated.globalEmployeeId) &&
        migrated.templateId === builtIn.id &&
        migrated.prompt === legacy.prompt &&
        migrated.memoryEnabled === false &&
        migrated.permissionMode === 'read-only' &&
        migrated.entrypointMigrationState === 'ready',
      '历史模板副本自动成为可指派员工，保留原绑定、来源、经验偏好与提示词。',
    );
    assertProbe(
      migrationDb.get<{ employee_snapshot_json: string }>('SELECT employee_snapshot_json FROM digital_employee_executions WHERE id = ?', [execution.id])!.employee_snapshot_json === snapshotBefore,
      '身份迁移不能改变冻结执行快照。',
    );
    /** 重复启动不新建员工或再提升绑定修订。 */
    const migrationState = JSON.stringify(migrationDb.select('SELECT * FROM digital_employees ORDER BY id'));
    migrateDigitalEmployeeGlobalIdentity(migrationDb);
    assertProbe(JSON.stringify(migrationDb.select('SELECT * FROM digital_employees ORDER BY id')) === migrationState, '自动身份迁移必须幂等。');
  } finally {
    await migrationDb.close();
  }
  observed.employeeIdentity = {
    distinctSameName: true,
    projectIsolation: true,
    repeatBinding: true,
    inheritedDefaults: true,
    legacyPromptAutomaticallyPreserved: true,
    legacyMemorySourcesPreserved: true,
    futureSourceMemoryExcluded: true,
    legacyActionsNotInherited: true,
    legacyActionColumnsPreserved: true,
    templateRejected: true,
    legacyBindingPreserved: true,
    executionSnapshotPreserved: true,
  };
  /** 历史绑定改绑后沿用项目经验，通用经验只跟随准确全局身份。 */
  const memory = new LongTermMemoryRepository(db);
  /** 目标项目尚未绑定的独立员工，避免与前面的复用场景混淆。 */
  const memoryGlobalG = templates.create({ name: '经验身份 G', role: '开发', prompt: 'G 的工作要求。' });
  const memoryGlobalH = templates.create({ name: '经验身份 H', role: '开发', prompt: 'H 的工作要求。' });
  const candidate = {
    candidateKind: 'stable_workflow' as const,
    effect: 'advisory' as const,
    source: { kind: 'user_explicit' as const, reference: 'employee-identity-probe', observedAt: '2026-10-05T01:00:00.000Z' },
    confirmationLevel: 'explicit' as const,
    confidence: 1,
    reviewAfter: '2027-10-05T01:00:00.000Z',
    recordedAt: '2026-10-05T01:00:00.000Z',
  };
  memory.recordCandidate({ ...candidate, id: 'identity_global_g_memory', scope: { kind: 'employee', id: memoryGlobalG.id }, memoryKey: 'identity.global.g', content: '全局 G 的通用经验。', projectLimitId: null });
  memory.recordCandidate({ ...candidate, id: 'identity_global_h_memory', scope: { kind: 'employee', id: memoryGlobalH.id }, memoryKey: 'identity.global.h', content: '全局 H 的通用经验。', projectLimitId: null });
  memory.recordCandidate({ ...candidate, id: 'identity_legacy_project_memory', scope: { kind: 'employee', id: legacy.id }, memoryKey: 'identity.legacy.project', content: '历史绑定的项目经验。', projectLimitId: secondProject.id });
  const resolve = (employeeId: string, projectId = secondProject.id) => memory.resolveForContext({ projectId, employeeId, asOf: '2026-10-05T02:00:00.000Z' }).selected.map((record) => record.id);
  assertProbe(resolve(legacy.id).includes('identity_legacy_project_memory') && !resolve(legacy.id).includes('identity_global_g_memory'), '未绑定历史员工只使用自身项目经验。');
  const boundG = employees.update(legacy.id, { expectedRevision: legacy.revision, globalEmployeeId: memoryGlobalG.id });
  assertProbe(resolve(boundG.id).includes('identity_global_g_memory') && resolve(boundG.id).includes('identity_legacy_project_memory'), '首次明确绑定全局员工后必须读取新通用经验并保留历史项目经验。');
  const repeatedG = employees.update(boundG.id, { expectedRevision: boundG.revision, globalEmployeeId: memoryGlobalG.id });
  assertProbe(resolve(repeatedG.id).includes('identity_global_g_memory'), '重复绑定相同身份不能丢失通用经验。');
  /** 模拟运行接纳时已经保存的有效身份，读取开关单独开启以核对检索归属。 */
  const frozenG = { ...repeatedG, memoryEnabled: true };
  /** 历史冻结没有全局字段时，只能使用当时保存的模板来源。 */
  const oldFrozenG = { ...frozenG, globalEmployeeId: undefined, templateId: memoryGlobalG.id };
  /** 未绑定的冻结配置不能因为后续首次绑定而读到新员工经验。 */
  const frozenUnbound = { ...legacy, memoryEnabled: true };
  const boundH = employees.update(repeatedG.id, { expectedRevision: repeatedG.revision, globalEmployeeId: memoryGlobalH.id });
  assertProbe(
    resolve(boundH.id).includes('identity_global_h_memory') && !resolve(boundH.id).includes('identity_global_g_memory') && resolve(boundH.id).includes('identity_legacy_project_memory'),
    '改绑 H 不能保留 G 的通用经验，项目历史仍属于稳定绑定。',
  );
  assertProbe(!resolve(boundH.id, firstProjectId).some((id) => id.startsWith('identity_')), '另一个项目不能借绑定身份读取其通用或限定经验。');
  /** 与真实工作和讨论共用入口核对冻结归属，不只调用仓储替身。 */
  const resolveFrozen = (employee: typeof frozenG, projectId = secondProject.id) => selectEmployeeMemories(memory, employee, projectId, '员工身份经验', '2026-10-05T02:00:00.000Z').map((record) => record.id);
  assertProbe(
    resolveFrozen(frozenG).includes('identity_global_g_memory') && !resolveFrozen(frozenG).includes('identity_global_h_memory') && resolveFrozen(frozenG).includes('identity_legacy_project_memory'),
    '改绑后的在途冻结 G 必须读取 G 的通用经验，并沿稳定绑定保留项目经验。',
  );
  assertProbe(resolveFrozen(oldFrozenG).includes('identity_global_g_memory') && !resolveFrozen(oldFrozenG).includes('identity_global_h_memory'), '旧冻结缺少全局字段时只能使用冻结模板来源，不能回落当前 H。');
  assertProbe(resolveFrozen(frozenUnbound).includes('identity_legacy_project_memory') && !resolveFrozen(frozenUnbound).some((id) => id.startsWith('identity_global_')), '冻结的明确未绑定状态不能被当前绑定替换。');
  assertProbe(!resolveFrozen(frozenG, firstProjectId).some((id) => id.startsWith('identity_')), '冻结全局身份不能扩大原项目绑定范围。');
  /** 固定员工身份不冻结经验正文，同一员工新确认的方法仍可用于后续节点。 */
  memory.recordCandidate({ ...candidate, id: 'identity_global_g_new_memory', scope: { kind: 'employee', id: memoryGlobalG.id }, memoryKey: 'identity.global.g.new', content: '全局 G 后续确认的通用经验。', projectLimitId: null });
  assertProbe(resolveFrozen(frozenG).includes('identity_global_g_new_memory'), '冻结身份的后续节点仍应读取同一员工新确认的经验。');
  observed.employeeMemoryIdentity = {
    firstBinding: true,
    repeatedBinding: true,
    rebindChangesGlobalMemory: true,
    legacyProjectMemoryPreserved: true,
    frozenRebindPreserved: true,
    oldFrozenTemplatePreserved: true,
    frozenUnboundPreserved: true,
    newSameEmployeeMemoryVisible: true,
    wrongProjectDenied: true,
  };
  /** 多个闲置项目关联不能阻止目录删除，活动工作则必须使整项删除回滚。 */
  const deletable = templates.create({ name: global.name, role: '开发', prompt: '目录删除检查。' });
  /** 最后一个关联占用工作，确保前一个关联的删除也能原子回滚。 */
  const deleteBindings = [employees.ensureProjectEmployee(firstProjectId, deletable.id), employees.ensureProjectEmployee(secondProject.id, deletable.id)].sort((left, right) => left.id.localeCompare(right.id));
  /** 队列场景只创建当前探针数据，不启动 Provider。 */
  const deleteTask = tasks.create({ projectId: deleteBindings[1]!.projectId, title: '员工删除保护', taskType: 'requirement', description: '', createdFrom: 'probe', sourceContext: {} });
  /** 未起跑的工作也必须保护员工身份。 */
  const deleteExecution = executions.create({ employee: deleteBindings[1]!, taskId: deleteTask.id, source: 'manual' });
  /** 记录两个关联的全部原值，不能只检查是否仍能读取。 */
  const bindingsBeforeDelete = JSON.stringify(db.select('SELECT * FROM digital_employees WHERE global_employee_id = ? ORDER BY id', [deletable.id]));
  assertProbe(
    captureCode(() => templates.delete(deletable.id, deletable.revision)) === 'ZEUS_DIGITAL_EMPLOYEE_ACTIVE' &&
      JSON.stringify(db.select('SELECT * FROM digital_employees WHERE global_employee_id = ? ORDER BY id', [deletable.id])) === bindingsBeforeDelete &&
      Boolean(templates.getById(deletable.id)),
    '活动工作阻止删除时，两个项目关联和全局身份必须全部保留。',
  );
  executions.cancel(deleteExecution.id);
  /** 正常取消后的历史快照仍应逐字保留。 */
  const cancelledSnapshot = db.get<{ employee_snapshot_json: string }>('SELECT employee_snapshot_json FROM digital_employee_executions WHERE id = ?', [deleteExecution.id])!.employee_snapshot_json;
  templates.delete(deletable.id, deletable.revision);
  assertProbe(
    !templates.getById(deletable.id) &&
      deleteBindings.every((binding) => !employees.getById(binding.id)) &&
      db.get<{ employee_snapshot_json: string }>('SELECT employee_snapshot_json FROM digital_employee_executions WHERE id = ?', [deleteExecution.id])!.employee_snapshot_json === cancelledSnapshot &&
      templates.list().some((record) => record.id === global.id) &&
      templates.list().some((record) => record.id === sameName.id),
    '闲置关联可随员工删除，历史快照和其他主动创建的同名员工不受影响。',
  );
  observed.employeeCatalog = { legacyMigrationsExcluded: true, sameNameCreatedEmployeesKept: true, activeDeletionRolledBack: true, idleBindingsDeleted: true, frozenHistoryKept: true };
}

/** 用真实数据库和文件检查冻结、按需读取、跨目录交接与独立导出恢复。 */
async function verifyWorkArtifactDelivery(db: ZeusDatabase, projects: ProjectRepository, tasks: TaskRepository): Promise<void> {
  /** 所有现场都属于本探针，退出时由既有 finally 清理。 */
  const root = join(probeRoot, 'artifact-project');
  const receiverRoot = join(probeRoot, 'artifact-receiver');
  await mkdir(root, { recursive: true });
  await mkdir(receiverRoot, { recursive: true });
  const project = projects.create({ name: '成果交接项目', localPath: root });
  const task = tasks.create({ projectId: project.id, title: '成果交接', taskType: 'requirement', description: '', createdFrom: 'probe', sourceContext: {} });
  const employees = new DigitalEmployeeRepository(db);
  const global = new DigitalEmployeeTemplateRepository(db).create({ name: '成果员工', role: '开发', prompt: '交付真实文档。' });
  const employee = employees.ensureProjectEmployee(project.id, global.id);
  const items = new TaskWorkItemRepository(db);
  const runs = new TaskWorkRunRepository(db);
  const deliverables = new TaskWorkDeliverableRepository(db);
  const conversations = new ConversationRepository(db);
  const workspaces = new TaskWorkspaceRepository(db);
  const publications = new WorkArtifactRepository(db);
  const artifacts = new ArtifactStore(db, join(probeRoot, 'artifact-objects'));
  await artifacts.initialize();
  const service = new WorkArtifactDelivery({ publications, artifacts, deliverables, runs, tasks, projects, conversations, workspaces, managedRoot: join(probeRoot, 'managed-docs') });
  /** 工作读取权限只能在启动时冻结，当前工具不能自行增补。 */
  const createRun = (
    suffix: string,
    upstreamDeliverableIds: string[] = [],
    workspaceId?: string,
    projectMemoryPolicy?: Record<string, unknown>,
    sourceRef: string | null = null,
    runTask: ZeusTaskRecord = task,
    prepared = false,
  ): TaskWorkRunRecord => {
    const item = items.create({ id: `artifact_item_${suffix}`, projectId: project.id, taskId: runTask.id, employeeId: employee.id, title: suffix, description: '', source: 'manual', sourceRef, entrypointKind: 'agent', status: 'queued' });
    const run = runs.create({
      id: `artifact_run_${suffix}`,
      projectId: project.id,
      taskId: runTask.id,
      workItemId: item.id,
      employeeId: employee.id,
      attempt: 1,
      status: prepared ? 'prepared' : 'active',
      entrypointKind: 'agent',
      employeeRevision: employee.revision,
      employeeSnapshot: structuredClone(employee) as unknown as Record<string, unknown>,
      entrypointSnapshot: { upstreamDeliverableIds, projectMemoryPolicy: projectMemoryPolicy ?? null },
      modelSnapshot: null,
      skillSnapshot: {},
      authoritySnapshot: {},
      contextManifest: { version: 1, task: { id: task.id, revision: task.updatedAt, title: task.title, description: '', taskType: task.taskType, tags: [] }, attachments: [], projectRules: [], acceptedDeliverables: [] },
      workspaceSnapshot: { mode: 'direct' },
      environmentId: null,
    });
    items.update(item.id, { currentRunId: run.id });
    if (prepared) return run;
    const conversation = conversations.create({ projectId: project.id, taskId: runTask.id, title: suffix, workspaceId });
    return runs.update(run.id, { conversationId: conversation.id });
  };
  const source = createRun('source');
  await writeFile(join(root, '交付.md'), '固定原文。');
  await service.submit(source, '交付.md');
  assertProbe((await captureAsyncCode(() => service.submit(source, '../外部文档.md'))) === 'ZEUS_WORK_ARTIFACT_SCOPE', '成果提交必须拒绝相对路径越界。');
  await symlink(join(root, '交付.md'), join(root, '链接.md'));
  assertProbe((await captureAsyncCode(() => service.submit(source, '链接.md'))) === 'ZEUS_WORK_ARTIFACT_SCOPE', '成果提交必须拒绝符号链接来源。');
  await writeFile(join(root, '交付.md'), '后续修改。');
  const artifact = await artifacts.putText({
    text: '交接摘要与真实失败现场。',
    mimeType: 'text/markdown',
    owner: { kind: 'task_work_deliverable', id: 'artifact_deliverable_probe', generationId: taskWorkDeliverableArtifactGeneration, projectId: project.id, conversationId: source.conversationId },
  });
  const deliverable = deliverables.create({
    id: 'artifact_deliverable_probe',
    projectId: project.id,
    taskId: task.id,
    workItemId: source.workItemId,
    runId: source.id,
    kind: 'agent_result',
    title: '固定交接',
    summary: '摘要引用。',
    artifactSha256: artifact.sha256,
    contentSha256: artifact.contentSha256,
    sourceMessageId: null,
  });
  await mkdir(join(root, 'docs'), { recursive: true });
  await writeFile(join(root, 'docs', `${task.taskCode}_旧任务文档.md`), '原文保留。[原附件](./evidence.txt)');
  await writeFile(join(root, 'docs', 'evidence.txt'), '原位置附件。');
  await writeFile(join(root, 'docs', `${task.taskCode}-设计.md`), '横线命名设计。');
  await writeFile(join(root, 'docs', `${task.taskCode}.md`), '仅编码命名。');
  await writeFile(join(root, 'docs', `${task.taskCode}.html`), '<a href="./evidence.txt">原位置附件</a>');
  await writeFile(join(root, 'docs', `${task.taskCode}9_其他任务.md`), '不能借编码前缀混入其他任务。');
  /** 模拟旧迁移留下并被用户修改的副本；新索引不得覆盖它。 */
  await mkdir(join(root, 'docs', task.taskCode, '旧资料'), { recursive: true });
  await writeFile(join(root, 'docs', task.taskCode, '旧资料', `${task.taskCode}_旧任务文档.md`), '用户修改的历史副本。');
  const oldReference = await artifacts.putJson({
    value: { document: '既有真实文件引用。' },
    owner: { kind: 'probe_existing_file', id: source.id, generationId: 'probe_existing_file', projectId: project.id, conversationId: source.conversationId },
  });
  service.includeReferencedFile(source, oldReference);
  const exported = service.publish(deliverable);
  assertProbe(exported.error === null && !!exported.root, '正式成果必须写出真实目录。');
  const fixedFile = join(exported.root, '成果', source.workItemId, '1', '文件', '交付.md');
  assertProbe((await readFile(fixedFile, 'utf8')) === '固定原文。', '提交后的源码文件变动不能影响已冻结成果。');
  const originalIndex = await readFile(join(exported.root, 'README.md'), 'utf8');
  assertProbe((await readFile(join(exported.root, '旧资料', `${task.taskCode}_旧任务文档.md`), 'utf8')) === '用户修改的历史副本。', '历史副本和用户修改必须保留，新索引优先原位置。');
  assertProbe(originalIndex.includes('历史副本与原来源内容不一致'), '旧迁移副本冲突必须明确列出待核对项，不能静默遮蔽用户修改。');
  assertProbe(
    [`${task.taskCode}_旧任务文档.md`, `${task.taskCode}-设计.md`, `${task.taskCode}.md`, `${task.taskCode}.html`].every((name) => originalIndex.includes(`../${encodeURIComponent(name)}`)) && !originalIndex.includes(`${task.taskCode}9`),
    '索引必须沿用原候选规则，覆盖 Markdown、HTML 与任务编码边界，排除另一任务。',
  );
  assertProbe(
    (await readFile(join(root, 'docs', `${task.taskCode}_旧任务文档.md`), 'utf8')).includes('./evidence.txt') &&
      (await readFile(join(root, 'docs', 'evidence.txt'), 'utf8')) === '原位置附件。' &&
      Object.keys(publications.location(task.id)?.legacySources ?? {}).length === 4,
    '旧正文与相对附件必须原位保留，全部来源按稳定任务登记。',
  );
  const catalog = new ContextSourceCatalog([{ id: 'artifact-root', path: root }]);
  const selection = await catalog.discoverTaskDocuments({ rootId: 'artifact-root', projectId: project.id, taskCode: task.taskCode });
  assertProbe(selection.primary?.relativePath === `docs/${task.taskCode}/README.md`, '上下文读取器必须优先固定 README。');
  const denied = createRun('denied');
  assertProbe(captureCode(() => service.read(denied, { deliverableId: deliverable.id, path: '交接.md' })) === 'ZEUS_WORK_ARTIFACT_SCOPE', '同任务未交接成果也必须拒绝读取。');
  const workspace = workspaces.create({ projectId: project.id, taskId: task.id, branchName: 'artifact-receiver', sourceBranch: 'main', sourceHeadSha: 'a'.repeat(40), worktreePath: receiverRoot });
  const receiver = createRun('receiver', [deliverable.id], workspace.id);
  const page = service.read(receiver, { deliverableId: deliverable.id, path: '交接.md', limit: 4 });
  const referenced = service.read(receiver, { deliverableId: deliverable.id, path: `引用/${oldReference.contentSha256}.json` });
  assertProbe(typeof referenced.content === 'string' && referenced.content.includes('既有真实文件引用。'), '既有受控文件引用也必须冻结到正式成果目录，不能只留可能失效的临时 owner。');
  assertProbe(page.content === '交接摘要' && page.nextOffset === 4, '有界正文必须给出准确后续偏移。');
  const materialized = service.materialize(receiver, { deliverableId: deliverable.id });
  assertProbe(
    materialized.root === (await realpath(receiverRoot)) &&
      (await readFile(
        join(
          receiverRoot,
          materialized.files.find((path) => path.endsWith('/交付.md'))!,
        ),
        'utf8',
      )) === '固定原文。',
    '接收工作独立目录必须能读取冻结附件。',
  );
  /** 经真实普通审查入口创建返工，前次正文和附件只交给准确新轮次。 */
  const reworkRoutes = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
  const reworkEvents = new TaskEventRepository(db);
  const planning = new TaskWorkPlanningRepository(db);
  /** 固定能力目录只用于预检和耐久接纳，不派发模型请求。 */
  const workflowModels = ['workflow-default', 'workflow-frozen', 'workflow-node'].map((id) => ({
    id,
    model: id,
    agentKind: 'codex',
    sourceId: 'codex',
    sourceName: 'Codex',
    available: true,
    supportedReasoningEfforts: ['medium', 'high'],
    defaultReasoningEffort: 'medium',
    serviceTiers: [{ id: 'priority' }],
    defaultServiceTier: null,
    contextWindow: null,
  }));
  /** 插件技能通过固定目录验证冻结身份，不读取外部插件目录。 */
  const frozenWorkflowSkill = 'plugin:workflow-probe:skill:frozen';
  const reworkController = registerTaskWorkManagement({
    server: { get: () => undefined, post: (path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) => reworkRoutes.set(path, handler) },
    readOnlyValidation: false,
    application: new WorkManagementCommandApplication({ db, deliveries: new CommandDeliveryRepository(db), redactSensitiveText: (text) => ({ text }), now: () => new Date('2026-10-05T02:00:00.000Z') }),
    tasks,
    projects,
    employees,
    items,
    runs,
    deliverables,
    artifacts,
    workArtifacts: service,
    memory: new LongTermMemoryRepository(db),
    taskEvents: reworkEvents,
    reviews: new TaskWorkReviewRepository(db),
    decisions: new TaskWorkDecisionRepository(db),
    planning,
    conversationCapabilities: { readTaskPush: async () => ({ preferredModel: 'workflow-default', models: workflowModels, repositories: [], goals: { enabled: true } }) },
    plugins: { listSkills: async () => [{ id: frozenWorkflowSkill, namespace: 'workflow-probe:frozen', description: '冻结技能', pluginId: 'workflow-probe', pluginRevisionId: 'frozen-revision' }] },
    normalizeTaskPushSupplementalAttachments: () => ({ promptAttachments: [] }),
    isTaskTerminal: () => false,
    now: () => new Date('2026-10-05T02:00:00.000Z'),
    save: async () => undefined,
    publishRealtimeEvent: () => undefined,
  } as unknown as Parameters<typeof registerTaskWorkManagement>[0]);
  try {
    /** 真实冻结员工保留接纳时的模型、档位和技能，当前员工已统一为默认。 */
    const frozenWorkflowEmployee = {
      ...employee,
      model: 'workflow-frozen',
      reasoningEffort: 'high',
      serviceTier: 'priority',
      workMode: 'plan' as const,
      skillIds: [frozenWorkflowSkill],
      entrypoint: {
        ...employee.entrypoint!,
        modelPolicy: { ...employee.entrypoint!.modelPolicy, defaultMode: 'explicit' as const, defaultModel: 'workflow-frozen' },
        skillPolicy: { ...employee.entrypoint!.skillPolicy, allowedSkillIds: [frozenWorkflowSkill] },
      },
    };
    /** 保存调用前内容，接纳不得反写原团队快照。 */
    const originalFrozenWorkflow = JSON.stringify(frozenWorkflowEmployee);
    /** 来源身份分别代表后续节点，全部只接纳、不派发。 */
    const workflowCases = [
      { suffix: 'employee', employeeSnapshot: frozenWorkflowEmployee, settings: undefined, model: 'workflow-frozen', effort: 'high', tier: 'priority', mode: 'plan', skills: 1 },
      {
        suffix: 'node',
        employeeSnapshot: frozenWorkflowEmployee,
        settings: { modelOverride: 'workflow-node', reasoningEffort: 'medium', serviceTier: null, workMode: 'default' as const, skillIds: [] },
        model: 'workflow-node',
        effort: 'medium',
        tier: null,
        mode: 'default',
        skills: 0,
      },
      {
        suffix: 'cleared',
        employeeSnapshot: frozenWorkflowEmployee,
        settings: { modelOverride: null, reasoningEffort: null, serviceTier: null, workMode: 'default' as const, skillIds: [] },
        model: 'workflow-default',
        effort: 'medium',
        tier: null,
        mode: 'default',
        skills: 0,
      },
      { suffix: 'current', employeeSnapshot: employee, settings: {}, model: 'workflow-default', effort: 'medium', tier: null, mode: 'default', skills: 0 },
      { suffix: 'mode-only', employeeSnapshot: { ...employee, reasoningEffort: 'high', workMode: 'plan' as const }, settings: {}, model: 'workflow-default', effort: 'high', tier: null, mode: 'plan', skills: 0 },
    ];
    for (const scenario of workflowCases) {
      /** 使用正式团队节点接纳入口，读取真实持久化工作快照。 */
      const accepted = await reworkController.createWorkflowWorkItem({
        taskId: task.id,
        employeeId: employee.id,
        employeeSnapshot: scenario.employeeSnapshot,
        sourceRef: `digital-team:frozen-defaults:${scenario.suffix}`,
        title: '冻结执行配置检查',
        description: '',
        supplementalInfo: '',
        workspace: { mode: 'direct' },
        purpose: 'work',
        executionMode: 'read_only',
        settings: { ...scenario.settings, autonomyObjective: '完成冻结工作目标', promptOverride: '本节点明确工作要求' },
      });
      assertProbe(
        accepted.run.modelSnapshot?.id === scenario.model &&
          accepted.run.modelSnapshot?.reasoningEffort === scenario.effort &&
          accepted.run.modelSnapshot?.serviceTier === scenario.tier &&
          accepted.run.entrypointSnapshot.workMode === scenario.mode &&
          (accepted.run.skillSnapshot?.pluginSkills as unknown[])?.length === scenario.skills,
        `团队冻结配置必须保留缺省、节点覆盖及显式清空语义：${scenario.suffix}`,
      );
      assertProbe(accepted.run.entrypointSnapshot.autonomyObjective === '完成冻结工作目标' && accepted.run.entrypointSnapshot.memoryPromptBase === '本节点明确工作要求', '统一执行默认不能删除节点真实目标和提示词要求。');
    }
    assertProbe(JSON.stringify(frozenWorkflowEmployee) === originalFrozenWorkflow, '接纳后续节点不得改写原冻结员工对象。');
    observed.frozenWorkflowDefaults = {
      historicalEmployee: true,
      nodeOverride: true,
      explicitClear: true,
      currentDefaults: true,
      frozenModeWithoutModelOverride: true,
      businessRequirementsPreserved: true,
      originalSnapshotUnchanged: true,
      providerRequests: 0,
    };
    runs.update(source.id, { status: 'runtime_completed' });
    items.update(source.workItemId, { status: 'active' });
    items.update(source.workItemId, { status: 'waiting_manager' });
    let response: unknown;
    let statusCode = 200;
    const reply = {
      code: (code: number) => {
        statusCode = code;
        return reply;
      },
      send: (value: unknown) => {
        response = value;
        return value;
      },
    };
    /** 未参与当前项目的正式全局员工可以直接从任务选择。 */
    const directTemplates = new DigitalEmployeeTemplateRepository(db);
    const directGlobal = directTemplates.create({ name: '任务直派全局员工', role: '协作', prompt: '仅使用全局工作要求。', memoryEnabled: true });
    /** 预览使用真实全局身份，未建立绑定时也能读取该员工的确认经验。 */
    new LongTermMemoryRepository(db).recordCandidate({
      id: 'direct_global_memory',
      scope: { kind: 'employee', id: directGlobal.id },
      memoryKey: 'direct.global.memory',
      content: '直派员工的全局确认经验。',
      projectLimitId: null,
      candidateKind: 'stable_workflow',
      effect: 'advisory',
      source: { kind: 'user_explicit', reference: 'direct-assignment-probe', observedAt: '2026-10-05T01:00:00.000Z' },
      confirmationLevel: 'explicit',
      confidence: 1,
      reviewAfter: '2027-10-05T01:00:00.000Z',
      recordedAt: '2026-10-05T01:00:00.000Z',
    });
    /** 注册真实目录读取处理器，未使用的写路由不执行。 */
    const employeeReadRoutes = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
    registerDigitalEmployeeRoutes({
      server: { get: (path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) => employeeReadRoutes.set(path, handler), post: () => undefined, patch: () => undefined, delete: () => undefined },
      projects,
      employees,
      templates: directTemplates,
    } as unknown as Parameters<typeof registerDigitalEmployeeRoutes>[0]);
    /** 读取和预览都不能增加项目成员行。 */
    const bindingCount = employees.listByProject(project.id).length;
    const availableEmployees = (await employeeReadRoutes.get('/api/projects/:projectId/digital-employees')!({ params: { projectId: project.id }, query: { available: 'true' } }, reply)) as Array<{ id: string }>;
    const directPreview = (await reworkRoutes.get('/api/tasks/:taskId/work-item-previews')!({ params: { taskId: task.id }, body: { employeeId: directGlobal.id, workspace: { mode: 'create' } } }, reply)) as TaskWorkPreview;
    assertProbe(
      availableEmployees.some((candidate) => candidate.id === directGlobal.id) && employees.listByProject(project.id).length === bindingCount && !employees.getByGlobalEmployee(project.id, directGlobal.id),
      'GET可指派目录和预览必须显示正式全局员工且不创建绑定。',
    );
    assertProbe(directPreview.blockers.length === 0 && String(directPreview.entrypoint?.prompt).includes('直派员工的全局确认经验。'), '未绑定员工预览必须沿真实全局身份读取memory。');
    /** 同一命令的两次提交必须复用首次绑定和工作，不被身份变化误判预览过期。 */
    const directRequest = {
      params: { taskId: task.id },
      body: commandRequest({
        commandId: 'command_direct_global_employee_probe',
        commandType: workManagementCommandTypes.taskWorkItemCreate,
        scope: { kind: 'task', id: task.id },
        operationIdentity: 'direct-global-employee-probe',
        input: { selection: directPreview.selection, previewSha256: directPreview.previewSha256, expectedTaskRevision: directPreview.expectedTaskRevision, expectedEmployeeRevision: directPreview.expectedEmployeeRevision },
      }),
    };
    await reworkRoutes.get('/api/tasks/:taskId/work-items')!(directRequest, reply);
    const directAccepted = response as { item: { id: string; employeeId: string }; run: TaskWorkRunRecord };
    assertProbe(
      statusCode === 202 &&
        directAccepted.run.employeeId === employees.getByGlobalEmployee(project.id, directGlobal.id)?.id &&
        directAccepted.run.employeeSnapshot.globalEmployeeId === directGlobal.id &&
        employees.listByProject(project.id).length === bindingCount + 1,
      '真实指派应透明建立且仅建立一个项目绑定，并冻结正式全局来源。',
    );
    /** 探针只验接纳，立即封存本轮，禁止后台派发模型。 */
    runs.update(directAccepted.run.id, { status: 'cancelled' });
    items.update(directAccepted.item.id, { status: 'cancelled' });
    await reworkRoutes.get('/api/tasks/:taskId/work-items')!(directRequest, reply);
    assertProbe(
      statusCode === 202 &&
        (response as { run: TaskWorkRunRecord; replayed: boolean }).replayed &&
        (response as { run: TaskWorkRunRecord }).run.id === directAccepted.run.id &&
        employees.listByProject(project.id).length === bindingCount + 1,
      '首次绑定后相同指派命令必须返回原工作回执。',
    );
    observed.directGlobalEmployeeAssignment = { availableWithoutBinding: true, previewReadOnly: true, globalMemoryPreserved: true, boundOnAcceptance: true, replayStable: true, providerRequests: 0 };
    const input = { expectedRevision: deliverable.revision, reason: '请核对前次正文和冻结附件后修改。' };
    await reworkRoutes.get('/api/tasks/:taskId/work-deliverables/:deliverableId/request-changes')!(
      {
        params: { taskId: task.id, deliverableId: deliverable.id },
        body: commandRequest({
          commandId: 'command_artifact_rework_probe',
          commandType: workManagementCommandTypes.taskWorkDeliverableRequestChanges,
          scope: { kind: 'task', id: task.id },
          operationIdentity: 'artifact-rework-probe',
          input,
        }),
      },
      reply,
    );
    assertProbe(statusCode === 202, '真实普通成果审查入口必须成功接纳返工。');
    const next = (response as { run: TaskWorkRunRecord }).run;
    assertProbe(next.entrypointSnapshot.reworkDeliverableId === deliverable.id && (next.entrypointSnapshot.upstreamDeliverableIds as string[]).includes(deliverable.id), '返工必须耐久冻结准确被修改成果。');
    assertProbe(service.list(next).some((entry) => entry.deliverableId === deliverable.id) && service.read(next, { deliverableId: deliverable.id, path: '交接.md', limit: 4 }).nextOffset === 4, '返工必须能列出并分页读取前次正式正文。');
    /** 旧未执行样本只移除新增授权字段，原审查、运行及成果来源保留。 */
    const legacySnapshot = { ...next.entrypointSnapshot };
    delete legacySnapshot.reworkDeliverableId;
    delete legacySnapshot.upstreamDeliverableIds;
    db.execute('UPDATE task_work_runs SET entrypoint_snapshot_json=? WHERE id=?', [JSON.stringify(legacySnapshot), next.id]);
    /** 来源重复时事务不授予任何成果范围，保留原快照等待核对。 */
    const duplicate = reworkEvents.create({
      taskId: task.id,
      eventType: 'task.work_deliverable.changes_requested',
      title: '重复来源 fixture',
      payload: { runId: next.id, previousRunId: source.id, workItemId: source.workItemId, deliverableId: deliverable.id },
    });
    assertProbe(
      captureCode(() => publications.restorePreparedReworkHandoff(next.id)) === 'ZEUS_TASK_WORK_REWORK_HANDOFF_UNRESOLVED' && !runs.getById(next.id)!.entrypointSnapshot.reworkDeliverableId,
      '返工来源不唯一时必须阻塞并保留原冻结范围。',
    );
    db.execute('DELETE FROM task_events WHERE id=?', [duplicate.id]);
    assertProbe(publications.restorePreparedReworkHandoff(next.id) && !publications.restorePreparedReworkHandoff(next.id), '旧未执行返工必须从唯一正式审查来源恢复且重复恢复幂等。');
    const restored = runs.getById(next.id)!;
    assertProbe(
      restored.entrypointSnapshot.reworkDeliverableId === deliverable.id && service.read(restored, { deliverableId: deliverable.id, path: '文件/交付.md' }).content === '固定原文。',
      '重新读取耐久快照后前次正文和附件范围必须一致。',
    );
    const reworkConversation = conversations.create({ projectId: project.id, taskId: task.id, title: '返工附件物化', workspaceId: workspace.id });
    const materializingRework = runs.update(next.id, { conversationId: reworkConversation.id });
    assertProbe(
      service.materialize(materializingRework, { deliverableId: deliverable.id }).files.some((path) => path.endsWith('/交付.md')),
      '返工必须能在准确当前工作区物化前次附件。',
    );
    assertProbe(!publications.restorePreparedReworkHandoff(next.id), '已有会话的返工不能由存量恢复改写上下文。');
    observed.reworkHandoff = { exactPriorDeliverable: true, pagedBody: true, frozenAttachment: true, materialized: true, durableRestore: true, startedRunUntouched: true };
    /** 自动领取已有安排保存正式来源回执，重启与换代不能改领另一份分工。 */
    assertProbe((await reworkController.claimPlannedAutomationWork({ taskId: task.id, employeeId: employee.id, sourceRef: 'automation:no-plan:project' })) === undefined, '没有安排时不能写入跳过回执阻断独立工作。');
    const planTask = tasks.create({ projectId: project.id, title: '自动化待领取安排', taskType: 'requirement', description: '', createdFrom: 'probe', sourceContext: {} });
    const stages = [
      {
        title: '已有阶段',
        description: '只领取既有分工。',
        settings: {},
        requiredSkillIds: [],
        advanceMode: 'manual' as const,
        acceptanceMode: 'manual' as const,
        assignments: [{ title: '待领开发', description: '核对已有范围后交付。', employeeId: null, role: '开发', settings: {}, required: true, outputKinds: ['document' as const] }],
      },
    ];
    const draft = planning.save(planTask.id, null, stages, {});
    const runningPlan = planning.control(planTask.id, draft.revision, 'running');
    const planInput = { taskId: planTask.id, employeeId: employee.id, sourceRef: 'automation:planned:project', permissionMode: 'read-only' as const };
    const planReference = await reworkController.claimPlannedAutomationWork(planInput);
    const assignedPlan = planning.get(planTask.id)!;
    assertProbe(
      planReference?.kind === 'task_plan' && planReference.id === runningPlan.id && planReference.generation === runningPlan.generation && assignedPlan.stages[0]!.items[0]!.employeeId === employee.id,
      '自动化必须领取原分工并返回原安排与准确代次。',
    );
    const assignedRevision = assignedPlan.stages[0]!.items[0]!.revision;
    assertProbe(assignedPlan.stages[0]!.items[0]!.arrangement?.settings.permissionMode === 'read-only', '只读自动化领取已有分工时必须冻结收紧权限。');
    const replayedPlan = await reworkController.claimPlannedAutomationWork(planInput);
    assertProbe(replayedPlan?.id === planReference?.id && planning.get(planTask.id)!.stages[0]!.items[0]!.revision === assignedRevision, '同一自动化来源重放不能重复领取或增加分工修订。');
    assertProbe((await reworkController.claimPlannedAutomationWork({ ...planInput, sourceRef: 'automation:planned-empty:project' })) === null, '存在安排但没有待领对象时必须耐久跳过，不创建替代工作。');
    const cancelledPlan = planning.control(planTask.id, assignedPlan.revision, 'cancelled');
    items.update(cancelledPlan.stages[0]!.items[0]!.id, { status: 'cancelled' });
    const laterPlan = planning.save(planTask.id, cancelledPlan.revision, stages, {});
    const originalReference = await reworkController.claimPlannedAutomationWork(planInput);
    assertProbe(
      originalReference?.generation === runningPlan.generation && laterPlan.generation > runningPlan.generation && !planning.get(planTask.id)!.stages[0]!.items[0]!.employeeId,
      '原来源已接纳回执在安排换代后仍只能返回原代次，不能领取新代分工。',
    );
    observed.automationPlannedClaim = { noPlanKeepsStandalonePath: true, exactPlanGeneration: true, duplicateIdempotent: true, emptyDurablySkipped: true, newGenerationUntouched: true };
    /** 从真实失败工作入口重试，核对改绑前后的冻结员工经验保持一致。 */
    const retryMemory = new LongTermMemoryRepository(db);
    /** 两名员工的经验使用独立来源身份，正文交集不能掩盖员工归属变化。 */
    const retryReplacement = new DigitalEmployeeTemplateRepository(db).create({ name: '返工改绑员工', role: '开发', prompt: '另一员工要求。' });
    for (const [id, globalId, content] of [
      ['artifact_retry_frozen_memory', global.id, '原员工的冻结经验。'],
      ['artifact_retry_rebound_memory', retryReplacement.id, '改绑员工的经验。'],
    ] as const) {
      retryMemory.recordCandidate({
        id,
        scope: { kind: 'employee', id: globalId },
        memoryKey: id,
        content,
        projectLimitId: null,
        candidateKind: 'stable_workflow',
        effect: 'advisory',
        source: { kind: 'user_explicit', reference: 'frozen-work-retry-probe', observedAt: '2026-10-05T01:00:00.000Z' },
        confirmationLevel: 'explicit',
        confidence: 1,
        reviewAfter: '2027-10-05T01:00:00.000Z',
        recordedAt: '2026-10-05T01:00:00.000Z',
      });
    }
    /** 初始工作记录保存真实员工配置及当时已确认的经验摘要。 */
    const frozenRetry = createRun('frozen-memory-retry');
    db.execute('UPDATE task_work_runs SET entrypoint_snapshot_json=? WHERE id=?', [
      JSON.stringify({ ...frozenRetry.entrypointSnapshot, memoryPromptBase: employee.prompt, memorySnapshot: [{ id: 'artifact_retry_frozen_memory', contentSha256: retryMemory.getById('artifact_retry_frozen_memory')!.contentSha256 }] }),
      frozenRetry.id,
    ]);
    runs.update(frozenRetry.id, { status: 'failed' });
    items.update(frozenRetry.workItemId, { status: 'active' });
    /** 当前失败修订是产品重试请求必须引用的接纳边界。 */
    const failedRetryItem = items.update(frozenRetry.workItemId, { status: 'failed' });
    /** 改绑仅改变当前配置，不重写已失败工作保存的员工对象。 */
    const reboundRetryEmployee = employees.update(employee.id, { expectedRevision: employees.getById(employee.id)!.revision, globalEmployeeId: retryReplacement.id });
    statusCode = 200;
    response = null;
    await reworkRoutes.get('/api/tasks/:taskId/work-items/:workItemId/retry')!(
      {
        params: { taskId: task.id, workItemId: failedRetryItem.id },
        body: commandRequest({
          commandId: 'command_frozen_employee_memory_retry_probe',
          commandType: workManagementCommandTypes.taskWorkItemRetry,
          scope: { kind: 'task', id: task.id },
          operationIdentity: 'frozen-employee-memory-retry-probe',
          input: { expectedRevision: failedRetryItem.revision },
        }),
      },
      reply,
    );
    assertProbe(statusCode === 202, `真实工作重试入口必须成功接纳：${JSON.stringify(response)}`);
    /** 产品入口接纳的新轮次保留旧身份与仍有效的旧经验，不引入改绑员工正文。 */
    const retriedFrozen = (response as { run: TaskWorkRunRecord }).run;
    assertProbe(
      retriedFrozen.employeeSnapshot.globalEmployeeId === global.id && String(retriedFrozen.entrypointSnapshot.prompt).includes('原员工的冻结经验。') && !String(retriedFrozen.entrypointSnapshot.prompt).includes('改绑员工的经验。'),
      '改绑后重试必须沿冻结员工筛选原经验，不能移除仍有效的旧员工经验或引入新员工正文。',
    );
    employees.update(employee.id, { expectedRevision: reboundRetryEmployee.revision, globalEmployeeId: global.id });
    observed.frozenEmployeeMemoryRetry = { productRetryAccepted: true, frozenEmployeePreserved: true, originalMemoryPreserved: true, reboundMemoryExcluded: true };
  } finally {
    await reworkController.close();
  }
  await writeFile(fixedFile, '不能覆盖的其他来源内容。');
  assertProbe(service.publish(deliverable).error !== null && (await readFile(fixedFile, 'utf8')) === '不能覆盖的其他来源内容。', '导出失败必须保留冲突内容和错误。');
  await unlink(fixedFile);
  const recovered = service.retryPending(new Date(Date.now() + 31_000));
  assertProbe(recovered.some((entry) => entry.taskId === task.id && entry.error === null) && publications.get(deliverable.id)?.exportError === null, '原调度入口必须从冻结对象重建并清除错误，无需重跑模型。');
  db.execute('UPDATE tasks SET task_sequence=?,task_code=? WHERE id=?', [9891, 'ZEUS-9891', task.id]);
  service.retryPending(new Date(Date.now() + 31_000));
  const moved = publications.location(task.id)!.root;
  assertProbe(moved.endsWith('/ZEUS-9891') && (await pathExists(join(moved, 'README.md'))) && !(await pathExists(exported.root)), '任务重编号必须按稳定 ID 更新资料位置。');
  assertProbe((await readFile(join(moved, 'README.md'), 'utf8')).includes(`../${encodeURIComponent(`${task.taskCode}.html`)}`), '任务重编号后仍必须索引旧编码的原位置资料。');
  await unlink(join(root, 'docs', `${task.taskCode}_旧任务文档.md`));
  service.rebuildTask(task.id);
  const missingSourceIndex = await readFile(join(moved, 'README.md'), 'utf8');
  assertProbe(missingSourceIndex.includes('原来源已缺失') && missingSourceIndex.includes(`${encodeURIComponent('旧资料')}/${encodeURIComponent(`${task.taskCode}_旧任务文档.md`)}`), '原来源缺失时保留历史副本并明确标出附件待核对。');
  /** 项目经验和已明确确认的通用经验有不同使用边界。 */
  const memory = new LongTermMemoryRepository(db);
  const otherProject = projects.create({ name: '另一经验项目', localPath: join(probeRoot, 'artifact-other-project') });
  const otherEmployee = employees.ensureProjectEmployee(otherProject.id, global.id);
  const candidate = {
    scope: { kind: 'employee' as const, id: global.id },
    candidateKind: 'stable_workflow' as const,
    effect: 'advisory' as const,
    source: { kind: 'user_explicit' as const, reference: `task:${task.id}/work-run:${source.id}`, observedAt: '2026-10-05T01:00:00.000Z' },
    confirmationLevel: 'explicit' as const,
    confidence: 1,
    reviewAfter: '2027-10-05T01:00:00.000Z',
    recordedAt: '2026-10-05T01:00:00.000Z',
  };
  memory.recordCandidate({ ...candidate, id: 'artifact_project_memory', memoryKey: 'artifact.project.workflow', content: '仅本项目规则。', projectLimitId: project.id });
  memory.recordCandidate({ ...candidate, id: 'artifact_general_memory', memoryKey: 'artifact.general.workflow', content: '已确认通用方法。', projectLimitId: null });
  const firstMemory = memory.resolveForContext({ projectId: project.id, employeeId: employee.id, asOf: '2026-10-05T02:00:00.000Z' }).selected;
  const otherMemory = memory.resolveForContext({ projectId: otherProject.id, employeeId: otherEmployee.id, asOf: '2026-10-05T02:00:00.000Z' }).selected;
  assertProbe(
    firstMemory.some((record) => record.id === 'artifact_project_memory') && !otherMemory.some((record) => record.id === 'artifact_project_memory') && otherMemory.some((record) => record.id === 'artifact_general_memory'),
    '项目经验不能自动跨项目传播，明确通用经验才能共享。',
  );
  const proposals = new EmployeeMemoryProposalRepository(db, () => '2026-10-05T02:00:00.000Z');
  const proposal = proposals.propose({
    id: 'artifact_conflicting_memory',
    projectId: project.id,
    employeeId: employee.id,
    taskId: task.id,
    runId: source.id,
    topic: 'artifact.project.workflow',
    kind: 'stable_workflow',
    content: '与已确认原项目规则相反。',
    reason: '探针验证保留来源和冲突待处理。',
  });
  const pending = proposals.decide(project.id, employee.id, proposal.id, { expectedRevision: proposal.revision, accept: true, topic: proposal.topic, content: proposal.content, reviewAfter: '2027-10-05T01:00:00.000Z' });
  assertProbe(pending.status === 'pending' && !!pending.conflictReason && memory.getById('artifact_project_memory')?.content === '仅本项目规则。', '冲突经验必须保留待处理建议，不能覆盖已确认经验。');
  /** 只有启动时冻结的已保存项目规则允许稳定经验自动生效，来源不伪造人工审核。 */
  const automaticRun = createRun('auto-memory', [], undefined, { projectId: project.id, workflowTemplateId: 'saved_project_workflow', workflowTemplateRevision: 7, autoApplyStableExperience: true });
  const automaticInput = {
    projectId: project.id,
    employeeId: employee.id,
    taskId: task.id,
    runId: automaticRun.id,
    kind: 'stable_workflow' as const,
    content: '实施前核对准确代码身份。',
    reason: '真实来源工作中的稳定方法，仅适用于当前项目。',
  };
  const automatic = proposals.propose({ ...automaticInput, id: 'artifact_auto_memory', topic: 'artifact.auto.workflow' });
  const automaticMemory = automatic.memoryId ? memory.getById(automatic.memoryId) : undefined;
  assertProbe(
    automatic.status === 'accepted' &&
      automaticMemory?.projectLimitId === project.id &&
      automaticMemory.source.kind === 'project_instruction' &&
      automaticMemory.confirmationLevel === 'confirmed' &&
      automaticMemory.source.reference.includes('workflow:saved_project_workflow/revision:7/') &&
      automaticMemory.source.reference.includes(`work-run:${automaticRun.id}`),
    '预授权项目稳定经验必须自动生效并保留准确规则与工作来源。',
  );
  const automaticConflict = proposals.propose({ ...automaticInput, id: 'artifact_auto_memory_conflict', topic: 'artifact.project.workflow', content: '覆盖已确认规则的相反经验。' });
  const preference = proposals.propose({ ...automaticInput, id: 'artifact_auto_preference', topic: 'artifact.auto.preference', kind: 'preference' });
  const noGrant = proposals.propose({ ...automaticInput, id: 'artifact_no_grant', topic: 'artifact.no-grant', runId: source.id });
  const otherSelected = memory.resolveForContext({ projectId: otherProject.id, employeeId: otherEmployee.id, asOf: '2026-10-05T02:00:00.000Z' }).selected;
  assertProbe(
    automaticConflict.status === 'pending' && !!automaticConflict.conflictReason && preference.status === 'pending' && noGrant.status === 'pending' && !otherSelected.some((record) => record.id === automatic.memoryId),
    '冲突、偏好、未授权工作和跨项目经验不能自动生效。',
  );
  /** 停止使用真实任务与轮次仓储，受控接口回执不能代替 Provider 终态证据。 */
  const turns = new ConversationTurnRepository(db);
  const writeTurn = (run: TaskWorkRunRecord, status: 'running' | 'interrupted', error?: unknown) =>
    turns.upsert({
      conversationId: run.conversationId!,
      providerThreadId: `thread_${run.id}`,
      providerTurnId: `turn_${run.id}`,
      clientSubmissionId: null,
      status,
      error,
      startedAt: '2026-10-05T02:00:00.000Z',
      completedAt: status === 'interrupted' ? '2026-10-05T02:01:00.000Z' : null,
      createdAt: '2026-10-05T02:00:00.000Z',
      updatedAt: '2026-10-05T02:01:00.000Z',
    });
  /** 此探针只核对产品 Controller，没有真实 Provider 或 HTTP 验收的声明。 */
  const controller = registerTaskWorkManagement({
    server: { get: () => undefined, post: () => undefined, inject: async () => ({ statusCode: 202, json: () => ({}) }) },
    readOnlyValidation: false,
    items,
    runs,
    conversations,
    conversationTurns: turns,
    conversationGoals: new ConversationGoalRepository(db),
    decisions: new TaskWorkDecisionRepository(db),
    apiToken: 'probe-only',
    now: () => new Date('2026-10-05T02:02:00.000Z'),
    save: async () => undefined,
    publishRealtimeEvent: () => undefined,
  } as unknown as Parameters<typeof registerTaskWorkManagement>[0]);
  try {
    const stopping = createRun('confirmed-stop', [], undefined, undefined, 'digital-team:stop-probe:confirmed');
    writeTurn(stopping, 'interrupted');
    await controller.stopWorkflowWorkItem(stopping.workItemId, 'confirmed-stop');
    const cancelledRevision = runs.getById(stopping.id)!.revision;
    await controller.stopWorkflowWorkItem(stopping.workItemId, 'confirmed-stop');
    assertProbe(
      runs.getById(stopping.id)?.status === 'cancelled' && items.getById(stopping.workItemId)?.status === 'cancelled' && !!items.getById(stopping.workItemId)?.completedAt && runs.getById(stopping.id)?.revision === cancelledRevision,
      '确认 Provider 停止后团队运行与工作项必须幂等收口。',
    );
    const pendingStop = createRun('pending-stop', [], undefined, undefined, 'digital-team:stop-probe:pending');
    writeTurn(pendingStop, 'interrupted', { code: 'ZEUS_PROVIDER_STOP_PENDING', providerStopPending: true, providerOutcomeUnconfirmed: true });
    assertProbe(
      (await captureAsyncCode(() => controller.stopWorkflowWorkItem(pendingStop.workItemId, 'pending-stop'))) === 'ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN' && runs.getById(pendingStop.id)?.status === 'active',
      '待确认停止不能伪装为取消终态。',
    );
    const acknowledgedStop = createRun('acknowledged-stop', [], undefined, undefined, 'digital-team:stop-probe:acknowledged');
    writeTurn(acknowledgedStop, 'running');
    assertProbe(
      (await captureAsyncCode(() => controller.stopWorkflowWorkItem(acknowledgedStop.workItemId, 'acknowledged-stop'))) === 'ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN' && runs.getById(acknowledgedStop.id)?.status === 'active',
      '接口接纳停止但未终结真实轮次时不能取消。',
    );
    const unknownStop = createRun('unknown-stop', [], undefined, undefined, 'digital-team:stop-probe:unknown');
    runs.update(unknownStop.id, { status: 'outcome_unknown' });
    assertProbe(
      (await captureAsyncCode(() => controller.stopWorkflowWorkItem(unknownStop.workItemId, 'unknown-stop'))) === 'ZEUS_TASK_WORK_STOP_OUTCOME_UNKNOWN' && runs.getById(unknownStop.id)?.status === 'outcome_unknown',
      '未知外部结果保持未知，不能当作停止完成。',
    );
  } finally {
    await controller.close();
  }

  /** 父流程只回收正式缺陷关系指向的已完成修复成果，禁止一般跨任务读取。 */
  const teamRuns = new DigitalTeamWorkflowRunRepository(db);
  const teamAttempts = new DigitalTeamNodeAttemptRepository(db);
  const defectRecords = new DefectWorkflowRepository(db);
  const definition: DigitalTeamWorkflowDefinition = {
    schemaGeneration: digitalTeamWorkflowSchemaGeneration,
    nodes: [{ id: 'handoff', type: 'employee', position: { x: 0, y: 0 }, data: { title: '交接', employeeId: employee.id, purpose: 'summary', executionMode: 'read_only', instructions: '只核对正式交接。' } }],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  /** 团队旧未派发返工只恢复同节点紧邻失效尝试的准确正式成果。 */
  const reworkTeam = teamRuns.create({ id: 'artifact_team_rework', projectId: project.id, taskId: task.id, definition, taskFacts: {}, baseRevisions: [] });
  const previousTeamAttempt = teamAttempts.create({ runId: reworkTeam.id, nodeId: 'handoff', inputSha256: 'a'.repeat(64), status: 'invalidated' });
  teamAttempts.update(previousTeamAttempt.id, { expectedRevision: previousTeamAttempt.revision, workItemId: source.workItemId, workRunId: source.id, deliverableId: deliverable.id });
  const teamPrepared = createRun('team-prepared-rework', [], undefined, undefined, `digital-team:${reworkTeam.id}:handoff`, task, true);
  db.execute('UPDATE task_work_runs SET entrypoint_snapshot_json=? WHERE id=?', [JSON.stringify({ digitalTeamPurpose: 'summary', upstreamDeliverableIds: [] }), teamPrepared.id]);
  const currentTeamAttempt = teamAttempts.create({ runId: reworkTeam.id, nodeId: 'handoff', inputSha256: 'b'.repeat(64) });
  teamAttempts.update(currentTeamAttempt.id, { expectedRevision: currentTeamAttempt.revision, workItemId: teamPrepared.workItemId, workRunId: teamPrepared.id });
  assertProbe(publications.restorePreparedReworkHandoff(teamPrepared.id) && !publications.restorePreparedReworkHandoff(teamPrepared.id), '团队旧 prepared 返工必须从准确尝试链恢复且保持幂等。');
  assertProbe(service.read(runs.getById(teamPrepared.id)!, { deliverableId: deliverable.id, path: '文件/交付.md' }).content === '固定原文。', '团队恢复后的冻结范围必须能读取前次正式附件。');
  observed.teamPreparedReworkHandoff = { exactPreviousAttempt: true, frozenAttachment: true, idempotent: true };
  teamRuns.update(reworkTeam.id, { expectedRevision: reworkTeam.revision, status: 'cancelled', controlState: 'cancelled' });
  const parentTeam = teamRuns.create({ id: 'artifact_parent_team', projectId: project.id, taskId: task.id, definition, taskFacts: {}, baseRevisions: [] });
  const repairTask = tasks.create({ projectId: project.id, title: '准确缺陷子任务', taskType: 'defect', description: '', createdFrom: 'probe', sourceContext: {} });
  const repairTeam = teamRuns.create({ id: 'artifact_repair_team', projectId: project.id, taskId: repairTask.id, definition, taskFacts: {}, baseRevisions: [] });
  const repairWork = createRun('repair-delivery', [], undefined, undefined, `digital-team:${repairTeam.id}:handoff`, repairTask);
  const repairBody = await artifacts.putText({
    text: '已核验修复的固定正文。',
    mimeType: 'text/markdown',
    owner: { kind: 'task_work_deliverable', id: 'artifact_repair_deliverable', generationId: taskWorkDeliverableArtifactGeneration, projectId: project.id, conversationId: repairWork.conversationId },
  });
  const submittedRepair = deliverables.create({
    id: 'artifact_repair_deliverable',
    projectId: project.id,
    taskId: repairTask.id,
    workItemId: repairWork.workItemId,
    runId: repairWork.id,
    kind: 'team_result',
    title: '准确修复交接',
    summary: '固定修复成果。',
    artifactSha256: repairBody.sha256,
    contentSha256: repairBody.contentSha256,
    sourceMessageId: null,
  });
  const acceptedRepair = deliverables.transition(submittedRepair.id, submittedRepair.revision, 'accepted');
  service.freeze(acceptedRepair);
  let repairAttempt = teamAttempts.create({ runId: repairTeam.id, nodeId: 'handoff', inputSha256: 'a'.repeat(64) });
  repairAttempt = teamAttempts.update(repairAttempt.id, { expectedRevision: repairAttempt.revision, status: 'dispatching' });
  repairAttempt = teamAttempts.update(repairAttempt.id, { expectedRevision: repairAttempt.revision, status: 'active', workItemId: repairWork.workItemId, workRunId: repairWork.id });
  teamAttempts.submitResult(repairAttempt.id, {
    expectedRevision: repairAttempt.revision,
    deliverableId: acceptedRepair.id,
    deliverableVersion: acceptedRepair.version,
    result: {
      outcome: 'succeeded',
      summary: '修复交接完成。',
      evidence: [{ kind: 'artifact', id: acceptedRepair.id, sha256: acceptedRepair.contentSha256, status: 'accepted' }],
      artifactRefs: [{ ...repairBody }],
      repositoryResults: [],
      verifiedCandidates: [],
      verification: 'not_run',
      remainingIssues: [],
    },
  });
  teamRuns.update(repairTeam.id, { expectedRevision: repairTeam.revision, status: 'completed' });
  const defect = defectRecords.register({
    parentTaskId: task.id,
    defectTaskId: repairTask.id,
    parentRunId: parentTeam.id,
    verificationNodeId: 'handoff',
    sourceAttemptId: 'fixture_failed_attempt',
    key: 'handoff-scope',
    title: '资料返回边界',
    description: '仅准确父闭环可读。',
    reproductionEvidence: ['fixture-command'],
    repositoryId: 'fixture-repository',
    headSha: 'a'.repeat(40),
  });
  defectRecords.bindRepair(defect.id, repairTeam.id);
  const parentReceiver = createRun('repair-return-reader', [acceptedRepair.id], undefined, undefined, `digital-team:${parentTeam.id}:handoff`);
  assertProbe(captureCode(() => service.read(parentReceiver, { deliverableId: acceptedRepair.id, path: '交接.md' })) === 'ZEUS_WORK_ARTIFACT_SCOPE', '尚未提交正式修复时父流程不能读取子任务成果。');
  defectRecords.submitRepair(defect.id, repairTeam.id, [{ repositoryId: 'fixture-repository', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }]);
  assertProbe(
    service.canPrepareRepairHandoff(task.id, `digital-team:${parentTeam.id}:handoff`, acceptedRepair.id) && service.read(parentReceiver, { deliverableId: acceptedRepair.id, path: '交接.md' }).content === '已核验修复的固定正文。',
    '正式修复完成后父流程应能按准确关系读取返还成果。',
  );
  const unrelatedReceiver = createRun('unrelated-repair-reader', [acceptedRepair.id], undefined, undefined, 'digital-team:other-parent:handoff');
  assertProbe(
    captureCode(() => service.read(unrelatedReceiver, { deliverableId: acceptedRepair.id, path: '交接.md' })) === 'ZEUS_WORK_ARTIFACT_SCOPE' && !service.canPrepareRepairHandoff(task.id, 'manual:known-owner', acceptedRepair.id),
    '知道成果身份的其他流程和普通任务不能读取修复子任务。',
  );
  observed.artifactDelivery = {
    frozenFile: true,
    controlledRead: true,
    boundedRead: true,
    materialized: true,
    exportRecovered: true,
    stableTaskOwnership: true,
    fixedDocsReader: true,
    projectMemoryLimit: true,
    memoryConflictPending: true,
    frozenProjectMemoryPolicy: true,
    confirmedStopSettled: true,
    unknownStopPreserved: true,
    repairReturnedToExactParent: true,
  };
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Work Management Command 行为探针失败：${message}`);
}
