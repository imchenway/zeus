import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandEnvelopeSchemaGeneration, type CommandEnvelope } from '../packages/shared/src/commandEnvelope.js';
import {
  ArtifactStore,
  CommandDeliveryRepository,
  ConversationRepository,
  DigitalEmployeeExecutionRepository,
  DigitalEmployeeRepository,
  ProjectRepository,
  TaskRepository,
  TaskStageRepository,
  TaskStageStoreError,
  createZeusDatabase,
  digitalEmployeeSchemaMigrationId,
  digitalEmployeeStageHandoffMigrationId,
  taskStageSchemaMigrationId,
  type DigitalEmployeeRecord,
  type ZeusTaskStageRecord,
} from '../packages/storage/src/index.js';
import { WorkManagementCommandApplication, workManagementCommandTypes, workManagementInputSha256, type WorkManagementCommandPayload } from '../packages/local-server/src/workManagementCommandApplication.js';

const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-0373-stage-handoff-'));
const observed: Record<string, unknown> = {};

try {
  const projectPath = join(probeRoot, 'project');
  await mkdir(projectPath, { recursive: true });
  const db = await createZeusDatabase(join(probeRoot, 'probe.db'));
  try {
    const projects = new ProjectRepository(db);
    const tasks = new TaskRepository(db);
    const employees = new DigitalEmployeeRepository(db);
    const executions = new DigitalEmployeeExecutionRepository(db);
    const conversations = new ConversationRepository(db);
    let clock = Date.parse('2026-08-28T09:00:00.000Z');
    const now = () => new Date((clock += 1_000)).toISOString();
    const stages = new TaskStageRepository(db, now);
    const artifacts = new ArtifactStore(db, join(probeRoot, 'artifacts'), now, { minimumFreeBytes: 0, writeFaultReporter: db });
    const commands = new WorkManagementCommandApplication({ db, deliveries: new CommandDeliveryRepository(db), redactSensitiveText: (value) => ({ text: value }), now: () => new Date((clock += 1_000)) });

    const project = projects.create({ id: 'project_zeus_0373_probe', name: 'ZEUS-0373 回放项目', localPath: projectPath });
    const task = tasks.create({
      id: 'task_zeus_0373_probe',
      projectId: project.id,
      title: '数字员工手动接力',
      taskType: 'optimization',
      description: '产品方案交给开发执行',
      createdFrom: 'verification_probe',
      sourceContext: {},
      allowCodeChanges: true,
      allowTests: true,
    });
    const product = createEmployee(employees, project.id, 'product', '产品数字员工', '产品', 'plan', 'read-only');
    const developer = createEmployee(employees, project.id, 'developer', '开发数字员工', '开发', 'default', 'auto');

    let workflow = stages.initializeDefault({ taskId: task.id, templateKey: 'digital-employee-plan-implement-review', templateRevision: 1, stages: defaultStages() });
    let planStage = workflow.stages[0]!;
    workflow = stages.assignEmployee(planStage.id, assignment(planStage, product));
    planStage = workflow.stages[0]!;
    observed.planUsesNonInteractiveConversation = planStage.workMode === 'default' && planStage.permissionMode === 'read-only';
    let execution = executions.create({
      id: 'digital_employee_execution_zeus_0373',
      employee: product,
      taskId: task.id,
      source: 'manual',
      sourceRef: 'probe:staged',
      executionMode: 'staged',
      workflowId: workflow.workflow.id,
      currentStageId: planStage.id,
    });
    execution = executions.update(execution.id, { status: 'dispatching', startedAt: now() });
    execution = executions.update(execution.id, { status: 'running' });

    const planConversationId = createConversation(db, conversations, project.id, task.id, 'conversation_zeus_0373_plan', product, now());
    const planAttempt = stages.prepareAttempt({
      stageId: planStage.id,
      operationIdentity: 'probe:plan:attempt:1',
      workExecutionId: execution.id,
      employeeId: product.id,
      employeeRevision: product.revision,
      employeeSnapshot: { ...product },
      skillId: product.skillIds[0] ?? null,
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    stages.bindExistingConversationAttempt({ attemptId: planAttempt.id, conversationId: planConversationId });
    const planContent = '# 产品方案\n\n实施必须只读取本方案，并在独立会话中完成。';
    const planDeliverable = await persistDeliverable(artifacts, stages, {
      taskId: task.id,
      projectId: project.id,
      stageId: planStage.id,
      attemptId: planAttempt.id,
      conversationId: planConversationId,
      id: 'task_stage_deliverable_zeus_0373_plan',
      operationIdentity: 'probe:plan:deliverable:1',
      title: '产品方案',
      content: planContent,
    });
    execution = executions.update(execution.id, { status: 'waiting', completedAt: now(), deliveryState: { candidateDeliverableId: planDeliverable.id, candidateDeliverableVersion: planDeliverable.version } });

    observed.candidateBeforeConfirmation = planDeliverable.status === 'submitted' && executions.getById(execution.id)?.deliveryStage === 'none';
    observed.noExternalDeliveryBeforeConfirmation = tasks.getById(task.id)?.status === 'ready' && executions.getById(execution.id)?.finalizedAt === null;

    const handoffInput = {
      sourceStageId: planStage.id,
      deliverableId: planDeliverable.id,
      deliverableVersion: planDeliverable.version,
      targetEmployeeId: developer.id,
      expectedExecutionRevision: execution.revision,
      expectedSourceStageRevision: stages.getStage(planStage.id)!.revision,
    };
    const handoffRequest = commandRequest('command_zeus_0373_handoff', workManagementCommandTypes.digitalEmployeeExecutionHandoff, task.id, 'operation_zeus_0373_handoff', handoffInput);
    const parsedHandoff = commands.parse<typeof handoffInput>({ value: handoffRequest, commandType: workManagementCommandTypes.digitalEmployeeExecutionHandoff, scopeKind: 'task', expectedScopeId: () => task.id });
    let handoffMutationCount = 0;
    const handoff = () =>
      commands.executeCore({
        parsed: parsedHandoff,
        destinationId: 'digital-employee-stage-handoff',
        resourceId: `digital_employee_execution:${execution.id}`,
        mutateBusinessState: () => {
          handoffMutationCount += 1;
          const accepted = stages.acceptDeliverable(planDeliverable.id, handoffInput.expectedSourceStageRevision);
          const next = accepted.stages.find((stage) => stage.kind === 'implementation')!;
          const assigned = stages.assignEmployee(next.id, assignment(next, developer));
          const assignedStage = assigned.stages.find((stage) => stage.id === next.id)!;
          return executions.advanceStage(execution.id, { expectedRevision: handoffInput.expectedExecutionRevision, employee: developer, currentStageId: assignedStage.id, deliveryState: { acceptedDeliverableId: planDeliverable.id } });
        },
      });
    const firstHandoff = handoff();
    const replayedHandoff = handoff();
    execution = executions.getById(execution.id)!;
    const implementationStage = stages.getStage(execution.currentStageId!)!;
    const acceptedInputs = stages.acceptedInputDeliverables(implementationStage);
    const storedPlan = await artifacts.readAuthorized({ sha256: planDeliverable.artifactSha256, owner: { kind: 'task_stage_deliverable', id: planDeliverable.id }, maximumContentBytes: 100_000 });

    observed.handoffCommandReplay = handoffMutationCount === 1 && replayedHandoff.replayed && firstHandoff.result.currentStageId === implementationStage.id;
    observed.preciseAcceptedInput = acceptedInputs.length === 1 && acceptedInputs[0]?.id === planDeliverable.id && Buffer.from(storedPlan.bytes).toString('utf8') === planContent;
    observed.deliveryStillClosedAfterHandoff = execution.status === 'queued' && execution.deliveryStage === 'none' && execution.finalizedAt === null;

    execution = executions.update(execution.id, { status: 'dispatching', startedAt: now() });
    execution = executions.update(execution.id, { status: 'running' });
    const developmentConversationId = createConversation(db, conversations, project.id, task.id, 'conversation_zeus_0373_development', developer, now());
    const developmentAttempt = stages.prepareAttempt({
      stageId: implementationStage.id,
      operationIdentity: 'probe:implementation:attempt:1',
      workExecutionId: execution.id,
      employeeId: developer.id,
      employeeRevision: developer.revision,
      employeeSnapshot: { ...developer },
      skillId: developer.skillIds[0] ?? null,
      effectivePermissions: { permissionMode: 'auto', allowCodeChanges: true, allowTests: true },
    });
    stages.bindExistingConversationAttempt({ attemptId: developmentAttempt.id, conversationId: developmentConversationId });
    observed.independentConversations = planConversationId !== developmentConversationId;
    observed.frozenEmployeeSnapshots = planAttempt.employeeId === product.id && developmentAttempt.employeeId === developer.id && developmentAttempt.inputDeliverableIds[0] === planDeliverable.id;
    observed.activeEmployeeSwitchRejected = captureStageCode(() => stages.assignEmployee(implementationStage.id, assignment(stages.getStage(implementationStage.id)!, product)));

    const implementationContent = '# 实施结果\n\n已严格依据产品方案完成。';
    const implementationDeliverable = await persistDeliverable(artifacts, stages, {
      taskId: task.id,
      projectId: project.id,
      stageId: implementationStage.id,
      attemptId: developmentAttempt.id,
      conversationId: developmentConversationId,
      id: 'task_stage_deliverable_zeus_0373_implementation',
      operationIdentity: 'probe:implementation:deliverable:1',
      title: '实施结果',
      content: implementationContent,
    });
    execution = executions.update(execution.id, { status: 'waiting', completedAt: now() });
    const changed = stages.requestChanges(implementationDeliverable.id, { expectedStageRevision: stages.getStage(implementationStage.id)!.revision, reason: '补充边界验证' });
    const changedStage = changed.stages.find((stage) => stage.id === implementationStage.id)!;
    const reassigned = stages.assignEmployee(changedStage.id, assignment(changedStage, developer));
    execution = executions.advanceStage(execution.id, { expectedRevision: execution.revision, employee: developer, currentStageId: implementationStage.id });
    const reworkAttempt = stages.prepareAttempt({
      stageId: implementationStage.id,
      operationIdentity: 'probe:implementation:attempt:2',
      workExecutionId: execution.id,
      employeeId: developer.id,
      employeeRevision: developer.revision,
      employeeSnapshot: { ...developer },
      effectivePermissions: { permissionMode: 'auto', allowCodeChanges: true, allowTests: true },
    });
    observed.reworkPreservesHistory = reassigned.stages.find((stage) => stage.id === implementationStage.id)!.attempts.length === 1 && reworkAttempt.attemptNumber === 2 && stages.getAttempt(developmentAttempt.id)?.status === 'completed';

    const retryTask = tasks.create({
      id: 'task_zeus_0373_failed_retry_probe',
      projectId: project.id,
      title: '失败阶段选择员工创建新尝试',
      taskType: 'optimization',
      description: '保留失败尝试并允许改派',
      createdFrom: 'verification_probe',
      sourceContext: {},
      allowCodeChanges: false,
      allowTests: false,
    });
    let retryWorkflow = stages.initializeDefault({ taskId: retryTask.id, templateKey: 'digital-employee-plan-implement-review', templateRevision: 1, stages: defaultStages() });
    let retryStage = retryWorkflow.stages[0]!;
    retryWorkflow = stages.assignEmployee(retryStage.id, assignment(retryStage, product));
    retryStage = retryWorkflow.stages[0]!;
    let failedExecution = executions.create({
      id: 'digital_employee_execution_zeus_0373_failed_retry',
      employee: product,
      taskId: retryTask.id,
      source: 'manual',
      sourceRef: 'probe:failed-retry',
      executionMode: 'staged',
      workflowId: retryWorkflow.workflow.id,
      currentStageId: retryStage.id,
    });
    failedExecution = executions.update(failedExecution.id, { status: 'dispatching', startedAt: now() });
    failedExecution = executions.update(failedExecution.id, { status: 'running' });
    const failedConversationId = createConversation(db, conversations, project.id, retryTask.id, 'conversation_zeus_0373_failed_attempt', product, now());
    const failedAttempt = stages.prepareAttempt({
      stageId: retryStage.id,
      operationIdentity: 'probe:failed-retry:attempt:1',
      workExecutionId: failedExecution.id,
      employeeId: product.id,
      employeeRevision: product.revision,
      employeeSnapshot: { ...product },
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    stages.bindExistingConversationAttempt({ attemptId: failedAttempt.id, conversationId: failedConversationId });
    stages.failAttempt(failedAttempt.id, { outcomeUnknown: false, error: { code: 'PROBE_PROVIDER_FAILED', message: 'provider failed before output' } });
    failedExecution = executions.update(failedExecution.id, { status: 'failed', completedAt: now(), errorCode: 'PROBE_PROVIDER_FAILED', errorMessage: 'provider failed before output' });
    const retryInput = { targetEmployeeId: developer.id, expectedExecutionRevision: failedExecution.revision };
    const retryRequest = commandRequest('command_zeus_0373_failed_retry', workManagementCommandTypes.digitalEmployeeExecutionRetry, retryTask.id, 'operation_zeus_0373_failed_retry', retryInput);
    const parsedRetry = commands.parse<typeof retryInput>({ value: retryRequest, commandType: workManagementCommandTypes.digitalEmployeeExecutionRetry, scopeKind: 'task', expectedScopeId: () => retryTask.id });
    let retryMutationCount = 0;
    const retryFailedStage = () =>
      commands.executeCore({
        parsed: parsedRetry,
        destinationId: 'digital-employee-stage-retry',
        resourceId: `digital_employee_execution:${failedExecution.id}`,
        mutateBusinessState: () => {
          retryMutationCount += 1;
          const failedStage = stages.getStage(retryStage.id)!;
          const assignedRetry = stages.assignEmployee(failedStage.id, assignment(failedStage, developer));
          const assignedRetryStage = assignedRetry.stages.find((stage) => stage.id === failedStage.id)!;
          return executions.advanceStage(failedExecution.id, { expectedRevision: retryInput.expectedExecutionRevision, employee: developer, currentStageId: assignedRetryStage.id });
        },
      });
    retryFailedStage();
    const replayedRetry = retryFailedStage();
    failedExecution = executions.getById(failedExecution.id)!;
    const retriedAttempt = stages.prepareAttempt({
      stageId: retryStage.id,
      operationIdentity: 'probe:failed-retry:attempt:2',
      workExecutionId: failedExecution.id,
      employeeId: developer.id,
      employeeRevision: developer.revision,
      employeeSnapshot: { ...developer },
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    observed.failedRetryPreservesHistory =
      retryMutationCount === 1 &&
      replayedRetry.replayed &&
      failedExecution.employeeId === developer.id &&
      failedExecution.attempt === 2 &&
      stages.getAttempt(failedAttempt.id)?.status === 'failed' &&
      retriedAttempt.attemptNumber === 2 &&
      retriedAttempt.employeeId === developer.id;

    const reviewReworkTask = tasks.create({
      id: 'task_zeus_0373_review_rework_probe',
      projectId: project.id,
      title: '最终审查阶段继续完善',
      taskType: 'optimization',
      description: '代码审查交付物返工必须停留在当前阶段',
      createdFrom: 'verification_probe',
      sourceContext: {},
      allowCodeChanges: false,
      allowTests: false,
    });
    let reviewWorkflow = stages.initializeDefault({ taskId: reviewReworkTask.id, templateKey: 'digital-employee-plan-implement-review', templateRevision: 1, stages: defaultStages() });
    let reviewPlanStage = reviewWorkflow.stages[0]!;
    reviewWorkflow = stages.assignEmployee(reviewPlanStage.id, assignment(reviewPlanStage, product));
    reviewPlanStage = reviewWorkflow.stages.find((stage) => stage.id === reviewPlanStage.id)!;
    const reviewPlanAttempt = stages.prepareAttempt({
      stageId: reviewPlanStage.id,
      operationIdentity: 'probe:review-rework:plan-attempt',
      employeeId: product.id,
      employeeRevision: product.revision,
      employeeSnapshot: { ...product },
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    const reviewPlanConversation = createConversation(db, conversations, project.id, reviewReworkTask.id, 'conversation_zeus_0373_review_rework_plan', product, now());
    stages.bindExistingConversationAttempt({ attemptId: reviewPlanAttempt.id, conversationId: reviewPlanConversation });
    const reviewPlanDeliverable = await persistDeliverable(artifacts, stages, {
      taskId: reviewReworkTask.id,
      projectId: project.id,
      stageId: reviewPlanStage.id,
      attemptId: reviewPlanAttempt.id,
      conversationId: reviewPlanConversation,
      id: 'task_stage_deliverable_zeus_0373_review_rework_plan',
      operationIdentity: 'probe:review-rework:plan-deliverable',
      title: '审查返工产品方案',
      content: '# 产品方案',
    });
    reviewWorkflow = stages.acceptDeliverable(reviewPlanDeliverable.id, stages.getStage(reviewPlanStage.id)!.revision);
    let reviewImplementationStage = reviewWorkflow.stages.find((stage) => stage.kind === 'implementation')!;
    reviewWorkflow = stages.assignEmployee(reviewImplementationStage.id, assignment(reviewImplementationStage, developer));
    reviewImplementationStage = reviewWorkflow.stages.find((stage) => stage.id === reviewImplementationStage.id)!;
    const reviewImplementationAttempt = stages.prepareAttempt({
      stageId: reviewImplementationStage.id,
      operationIdentity: 'probe:review-rework:implementation-attempt',
      employeeId: developer.id,
      employeeRevision: developer.revision,
      employeeSnapshot: { ...developer },
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    const reviewImplementationConversation = createConversation(db, conversations, project.id, reviewReworkTask.id, 'conversation_zeus_0373_review_rework_implementation', developer, now());
    stages.bindExistingConversationAttempt({ attemptId: reviewImplementationAttempt.id, conversationId: reviewImplementationConversation });
    const reviewImplementationDeliverable = await persistDeliverable(artifacts, stages, {
      taskId: reviewReworkTask.id,
      projectId: project.id,
      stageId: reviewImplementationStage.id,
      attemptId: reviewImplementationAttempt.id,
      conversationId: reviewImplementationConversation,
      id: 'task_stage_deliverable_zeus_0373_review_rework_implementation',
      operationIdentity: 'probe:review-rework:implementation-deliverable',
      title: '审查返工实施结果',
      content: '# 实施结果',
    });
    reviewWorkflow = stages.acceptDeliverable(reviewImplementationDeliverable.id, stages.getStage(reviewImplementationStage.id)!.revision);
    let reviewStage = reviewWorkflow.stages.find((stage) => stage.kind === 'code_review')!;
    reviewWorkflow = stages.assignEmployee(reviewStage.id, assignment(reviewStage, developer));
    reviewStage = reviewWorkflow.stages.find((stage) => stage.id === reviewStage.id)!;
    const reviewAttempt = stages.prepareAttempt({
      stageId: reviewStage.id,
      operationIdentity: 'probe:review-rework:review-attempt:1',
      employeeId: developer.id,
      employeeRevision: developer.revision,
      employeeSnapshot: { ...developer },
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    const reviewConversation = createConversation(db, conversations, project.id, reviewReworkTask.id, 'conversation_zeus_0373_review_rework_review_1', developer, now());
    stages.bindExistingConversationAttempt({ attemptId: reviewAttempt.id, conversationId: reviewConversation });
    const reviewDeliverable = await persistDeliverable(artifacts, stages, {
      taskId: reviewReworkTask.id,
      projectId: project.id,
      stageId: reviewStage.id,
      attemptId: reviewAttempt.id,
      conversationId: reviewConversation,
      id: 'task_stage_deliverable_zeus_0373_review_rework_review_1',
      operationIdentity: 'probe:review-rework:review-deliverable:1',
      title: '代码审查报告',
      content: '# 代码审查报告 v1',
    });
    reviewWorkflow = stages.requestChanges(reviewDeliverable.id, {
      expectedStageRevision: stages.getStage(reviewStage.id)!.revision,
      reason: '补充人工验收事实',
      stayOnStage: true,
    });
    const reviewReworkStage = reviewWorkflow.stages.find((stage) => stage.id === reviewStage.id)!;
    const reviewReworkAttempt = stages.prepareAttempt({
      stageId: reviewReworkStage.id,
      operationIdentity: 'probe:review-rework:review-attempt:2',
      employeeId: developer.id,
      employeeRevision: developer.revision,
      employeeSnapshot: { ...developer },
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false },
    });
    observed.finalStageReworkStaysOnReview =
      reviewWorkflow.workflow.currentStageId === reviewStage.id &&
      reviewReworkStage.status === 'changes_requested' &&
      reviewWorkflow.stages.find((stage) => stage.id === reviewImplementationStage.id)?.status === 'accepted' &&
      reviewDeliverable.status === 'submitted' &&
      stages.getDeliverable(reviewDeliverable.id)?.status === 'changes_requested' &&
      reviewReworkAttempt.attemptNumber === 2;

    const activeLegacy = executions.create({ id: 'digital_employee_execution_zeus_0373_legacy_active', employee: product, taskId: task.id, source: 'manual', sourceRef: 'probe:legacy-active' });
    observed.legacyNotFabricated = activeLegacy.executionMode === 'legacy_single_conversation' && activeLegacy.workflowId === null && activeLegacy.currentStageId === null;

    const legacyTask = tasks.create({
      id: 'task_zeus_0373_legacy_probe',
      projectId: project.id,
      title: '旧版输出显式接入阶段链',
      taskType: 'optimization',
      description: '只在用户确认后接入真实旧会话输出',
      createdFrom: 'verification_probe',
      sourceContext: {},
      allowCodeChanges: false,
      allowTests: false,
    });
    const legacyConversationId = createConversation(db, conversations, project.id, legacyTask.id, 'conversation_zeus_0373_legacy_completed', product, now());
    let completedLegacy = executions.create({ id: 'digital_employee_execution_zeus_0373_legacy_completed', employee: product, taskId: legacyTask.id, source: 'manual', sourceRef: 'probe:legacy-completed' });
    completedLegacy = executions.update(completedLegacy.id, { status: 'dispatching', conversationId: legacyConversationId, startedAt: now() });
    completedLegacy = executions.update(completedLegacy.id, { status: 'running' });
    completedLegacy = executions.update(completedLegacy.id, { status: 'failed', completedAt: now(), errorCode: 'PROBE_LEGACY_TERMINAL' });
    let legacyWorkflow = stages.initializeDefault({ taskId: legacyTask.id, templateKey: 'digital-employee-plan-implement-review', templateRevision: 1, stages: defaultStages() });
    let legacyStage = legacyWorkflow.stages[0]!;
    legacyWorkflow = stages.assignEmployee(legacyStage.id, assignment(legacyStage, product));
    legacyStage = legacyWorkflow.stages[0]!;
    const legacyAttempt = stages.prepareAttempt({
      stageId: legacyStage.id,
      operationIdentity: 'probe:legacy:attempt:1',
      workExecutionId: completedLegacy.id,
      employeeId: product.id,
      employeeRevision: product.revision,
      employeeSnapshot: { ...product },
      skillId: product.skillIds[0] ?? null,
      effectivePermissions: { permissionMode: 'read-only', allowCodeChanges: false, allowTests: false, source: 'legacy_adoption' },
    });
    stages.bindExistingConversationAttempt({ attemptId: legacyAttempt.id, conversationId: legacyConversationId });
    const legacyDeliverable = await persistDeliverable(artifacts, stages, {
      taskId: legacyTask.id,
      projectId: project.id,
      stageId: legacyStage.id,
      attemptId: legacyAttempt.id,
      conversationId: legacyConversationId,
      id: 'task_stage_deliverable_zeus_0373_legacy',
      operationIdentity: 'probe:legacy:deliverable:1',
      title: '旧版真实输出',
      content: '# 旧版真实输出\n\n仅在用户显式确认后作为交接起点。',
    });
    const adoptedLegacy = executions.adoptLegacyAsStaged(completedLegacy.id, {
      expectedRevision: completedLegacy.revision,
      workflowId: legacyWorkflow.workflow.id,
      currentStageId: legacyStage.id,
      candidateDeliverableId: legacyDeliverable.id,
      candidateDeliverableVersion: legacyDeliverable.version,
      candidateContentSha256: legacyDeliverable.contentSha256,
    });
    observed.legacyCompletedAdopted =
      adoptedLegacy.executionMode === 'staged' && adoptedLegacy.status === 'waiting' && adoptedLegacy.conversationId === legacyConversationId && adoptedLegacy.deliveryState.candidateDeliverableId === legacyDeliverable.id;
    observed.legacyActiveUnchanged = executions.getById(activeLegacy.id)?.executionMode === 'legacy_single_conversation' && executions.getById(activeLegacy.id)?.workflowId === null;
    observed.migrationsPresent = [digitalEmployeeSchemaMigrationId, taskStageSchemaMigrationId, digitalEmployeeStageHandoffMigrationId].every((migrationId) =>
      Boolean(db.get(`SELECT migration_id FROM schema_migrations WHERE migration_id = ?`, [migrationId])),
    );
    observed.sqliteIntegrity = db.get<{ quick_check: string }>(`PRAGMA quick_check`)?.quick_check ?? null;

    assertProbe(observed.planUsesNonInteractiveConversation === true, '产品阶段必须使用可自然结束的只读默认会话，不能进入 Codex 内部 PLAN 审批');
    assertProbe(observed.candidateBeforeConfirmation === true && observed.noExternalDeliveryBeforeConfirmation === true, '候选方案生成前后不得触发外部交付');
    assertProbe(observed.handoffCommandReplay === true && observed.preciseAcceptedInput === true, '交接命令必须幂等并精确传递已接受方案');
    assertProbe(observed.independentConversations === true && observed.frozenEmployeeSnapshots === true, '阶段必须使用独立会话并冻结各自员工快照');
    assertProbe(
      observed.activeEmployeeSwitchRejected === 'ZEUS_TASK_STAGE_NOT_READY' && observed.reworkPreservesHistory === true && observed.failedRetryPreservesHistory === true && observed.finalStageReworkStaysOnReview === true,
      '活动阶段不可换人；返工和失败重试必须保留旧尝试并新建尝试，最终审查返工必须停留当前阶段',
    );
    assertProbe(observed.deliveryStillClosedAfterHandoff === true && observed.legacyNotFabricated === true, '最终确认前不得打开交付，旧记录不得伪造阶段');
    assertProbe(observed.legacyCompletedAdopted === true && observed.legacyActiveUnchanged === true, '已结束旧执行应可显式接入，活动旧执行必须保持原状');
    assertProbe(observed.migrationsPresent === true && observed.sqliteIntegrity === 'ok', '迁移账本与 SQLite 完整性必须通过');
    await db.save();
  } finally {
    await db.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: 'passed', observed }, null, 2));

function createEmployee(repository: DigitalEmployeeRepository, projectId: string, id: string, name: string, role: string, workMode: 'default' | 'plan', permissionMode: 'read-only' | 'auto'): DigitalEmployeeRecord {
  return repository.create({
    id: `digital_employee_zeus_0373_${id}`,
    projectId,
    name,
    role,
    description: `${role}阶段探针`,
    domain: 'ZEUS-0373',
    skillIds: [id === 'product' ? '11111111111111111111111111111111' : '22222222222222222222222222222222'],
    prompt: `${role}数字员工提示词`,
    agentKind: 'codex',
    model: 'gpt-5.4',
    permissionMode,
    workMode,
    allowCodeChanges: role === '开发',
    allowTests: role === '开发',
  });
}

function defaultStages() {
  return [
    {
      stageKey: 'plan',
      kind: 'plan' as const,
      title: '方案规划',
      description: '形成产品方案',
      agentKind: 'codex' as const,
      modelRef: '',
      workMode: 'default' as const,
      permissionMode: 'read-only' as const,
      advanceMode: 'manual' as const,
      prompt: '输出正式方案',
      outputContract: { format: 'markdown' },
    },
    {
      stageKey: 'implementation',
      kind: 'implementation' as const,
      title: '实施',
      description: '执行确认方案',
      agentKind: 'codex' as const,
      modelRef: '',
      workMode: 'default' as const,
      permissionMode: 'auto' as const,
      advanceMode: 'manual' as const,
      prompt: '执行已确认方案',
      outputContract: { format: 'markdown' },
    },
    {
      stageKey: 'code-review',
      kind: 'code_review' as const,
      title: '代码审查',
      description: '审查实施结果',
      agentKind: 'codex' as const,
      modelRef: '',
      workMode: 'default' as const,
      permissionMode: 'read-only' as const,
      advanceMode: 'manual' as const,
      prompt: '审查实施结果',
      outputContract: { format: 'markdown' },
    },
  ];
}

function assignment(stage: ZeusTaskStageRecord, employee: DigitalEmployeeRecord) {
  return {
    expectedRevision: stage.revision,
    employeeMode: 'explicit' as const,
    employeeId: employee.id,
    agentKind: employee.agentKind,
    modelRef: employee.model ?? 'gpt-5.4',
    effort: employee.reasoningEffort,
    serviceTier: employee.serviceTier,
    workMode: stage.kind === 'plan' || stage.kind === 'code_review' ? ('default' as const) : employee.workMode,
    permissionMode: stage.kind === 'plan' || stage.kind === 'code_review' ? ('read-only' as const) : employee.permissionMode,
    prompt: stage.prompt,
  };
}

function createConversation(db: Awaited<ReturnType<typeof createZeusDatabase>>, conversations: ConversationRepository, projectId: string, taskId: string, id: string, employee: DigitalEmployeeRecord, timestamp: string): string {
  conversations.create({
    id,
    projectId,
    taskId,
    title: `${employee.name}会话`,
    status: 'completed',
    transportKind: 'codex_native',
    providerState: 'closed',
    permissionMode: employee.permissionMode,
    collaborationMode: employee.workMode,
    agentKind: employee.agentKind,
    agentTransport: 'app_server',
    modelId: employee.model ?? undefined,
  });
  db.execute(`UPDATE conversations SET stage = 'completed', stage_updated_at = ?, updated_at = ? WHERE id = ?`, [timestamp, timestamp, id]);
  return id;
}

async function persistDeliverable(
  artifacts: ArtifactStore,
  stages: TaskStageRepository,
  input: { taskId: string; projectId: string; stageId: string; attemptId: string; conversationId: string; id: string; operationIdentity: string; title: string; content: string },
) {
  const ref = await artifacts.putText({
    text: input.content,
    mimeType: 'text/markdown',
    owner: { kind: 'task_stage_deliverable', id: input.id, generationId: '2026-08-28-zeus-0373-probe', projectId: input.projectId, conversationId: input.conversationId },
  });
  const workflow = stages.createDeliverable({
    taskId: input.taskId,
    stageId: input.stageId,
    attemptId: input.attemptId,
    operationIdentity: input.operationIdentity,
    kind: 'stage_output',
    title: input.title,
    summary: input.content.replace(/\s+/gu, ' ').slice(0, 280),
    artifactRef: ref,
  });
  return workflow.stages.flatMap((stage) => stage.deliverables).find((deliverable) => deliverable.id === input.id)!;
}

function commandRequest<TInput extends object>(commandId: string, commandType: string, taskId: string, operationIdentity: string, input: TInput) {
  const command: CommandEnvelope<WorkManagementCommandPayload> = {
    schemaGeneration: commandEnvelopeSchemaGeneration,
    commandId,
    commandType,
    actor: { kind: 'local_api', id: 'zeus-0373-probe' },
    scope: { kind: 'task', id: taskId },
    expectedRevision: null,
    idempotencyKey: `${commandType}:${operationIdentity}`,
    issuedAt: '2026-08-28T09:00:00.000Z',
    payload: { operationIdentity, inputSha256: workManagementInputSha256(input) },
  };
  return { command, input };
}

function captureStageCode(operation: () => unknown): string | null {
  try {
    operation();
    return null;
  } catch (error) {
    return error instanceof TaskStageStoreError ? error.code : error instanceof Error ? `${error.name}:${error.message}` : String(error);
  }
}

function assertProbe(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`ZEUS-0373 回放失败：${message}`);
}
