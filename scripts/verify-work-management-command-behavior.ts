import { access, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import { CommandDeliveryRepository, createZeusDatabase, ProjectRepository, TaskEventFileProjectionRepository, TaskEventRepository, TaskRepository } from '../packages/storage/src/index.js';
import { WorkManagementCommandApplication, workManagementCommandTypes, workManagementInputSha256, type WorkManagementCommandPayload } from '../packages/local-server/src/workManagementCommandApplication.js';
import { TaskEventFileProjectionService } from '../packages/local-server/src/taskEventFileProjectionService.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-work-management-command-probe-'));
const observed: Record<string, unknown> = {};

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

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Work Management Command 行为探针失败：${message}`);
}
