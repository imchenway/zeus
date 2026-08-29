import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { commandEnvelopeSchemaGeneration, commandParameterValueMatchesType, type CommandDefinition, type CommandEnvelope } from '@zeus/shared';
import {
  ArtifactStore,
  CommandDefinitionRepository,
  CommandRunRepository,
  ConversationExecutionRepository,
  ConversationRepository,
  ConversationServerRequestRepository,
  DigitalEmployeeExecutionRepository,
  DigitalEmployeeRepository,
  ProjectRepository,
  TaskEventRepository,
  TaskRepository,
  TaskWorkDecisionRepository,
  TaskWorkDeliverableRepository,
  TaskWorkItemRepository,
  TaskWorkRunRepository,
  TaskWorkStoreError,
  taskWorkDeliverableArtifactGeneration,
  type DigitalEmployeeRecord,
  type EmployeeEntrypointV2,
  type TaskWorkDecisionRecord,
  type TaskWorkDeliverableRecord,
  type TaskWorkItemRecord,
  type TaskWorkRunRecord,
  type WorkContextManifestV1,
  type ZeusProjectRecord,
  type ZeusTaskRecord,
} from '@zeus/storage';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { commandCenterCommandTypes, commandCenterInputSha256 } from './commandCenterCommandApplication.js';
import { conversationDispatchCommandTypes, conversationDispatchInputSha256 } from './conversationDispatchCommandApplication.js';
import type { ConversationCapabilityQueryApplication, ConversationCapabilityModel } from './conversationCapabilityQueryApplication.js';
import { WorkManagementCommandApplication, type WorkManagementMutationRequest, workManagementCommandHttpError, workManagementCommandTypes } from './workManagementCommandApplication.js';
import type { ZeusSkillService } from './zeusSkillService.js';

const previewTtlMs = 10 * 60 * 1_000;
const tickMs = 2_500;
const maximumSkillSnapshotFiles = 2_000;
const maximumSkillSnapshotBytes = 32 * 1024 * 1024;
const taskWorkSkillArtifactGeneration = '2026-08-29-task-work-skill-snapshot-v1';

export interface TaskWorkPreviewSelection {
  employeeId: string;
  modelOverride?: string | null;
  reasoningEffort?: string | null;
  serviceTier?: string | null;
  skillIds?: string[];
  selectedDeliverableIds?: string[];
}

export interface TaskWorkPreview {
  previewSha256: string;
  expiresAt: string;
  expectedTaskRevision: string;
  expectedEmployeeRevision: number;
  selection: TaskWorkPreviewSelection;
  employee: { id: string; name: string; role: string; domain: string; revision: number };
  entrypoint: Record<string, unknown> | null;
  model: Record<string, unknown> | null;
  skills: Array<{ id: string; name: string; description: string; directoryName: string; contentSha256: string; resourceCount: number; totalBytes: number }>;
  authority: Record<string, unknown>;
  context: WorkContextManifestV1;
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

interface PreparedSkillResourceSnapshot {
  metadata: TaskWorkPreview['skills'][number];
  files: Array<{ path: string; sha256: string; bytes: number; contentBase64: string }>;
}

interface TaskWorkCreateInput {
  selection: TaskWorkPreviewSelection;
  previewSha256: string;
  expectedTaskRevision: string;
  expectedEmployeeRevision: number;
  commandParameterDigest?: string | null;
}

interface TaskWorkCreateRequest extends WorkManagementMutationRequest<TaskWorkCreateInput> {
  runtime?: { commandParameters?: Record<string, unknown> };
}

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
  server: FastifyInstance;
  apiToken: string;
  application: WorkManagementCommandApplication;
  projects: ProjectRepository;
  tasks: TaskRepository;
  employees: DigitalEmployeeRepository;
  legacyExecutions: DigitalEmployeeExecutionRepository;
  items: TaskWorkItemRepository;
  runs: TaskWorkRunRepository;
  deliverables: TaskWorkDeliverableRepository;
  decisions: TaskWorkDecisionRepository;
  conversations: ConversationRepository;
  conversationExecution: ConversationExecutionRepository;
  conversationRequests: ConversationServerRequestRepository;
  commandDefinitions: CommandDefinitionRepository;
  commandRuns: CommandRunRepository;
  artifacts: ArtifactStore;
  skillSnapshotRoot: string;
  skills: ZeusSkillService | null;
  conversationCapabilities: ConversationCapabilityQueryApplication;
  executeTaskConversationIdempotent(project: ZeusProjectRecord, task: ZeusTaskRecord, body: Record<string, unknown>, idempotencyKey: string): Promise<{ statusCode: number; body: unknown }>;
  isTaskTerminal(task: ZeusTaskRecord): boolean;
  taskEvents: TaskEventRepository;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): unknown;
  save(): Promise<void>;
  now(): Date;
  readOnlyValidation?: boolean;
}

export interface TaskWorkManagementController {
  kick(): void;
  countActiveByEmployee(employeeId: string): number;
  hasAutomationSource(sourceRef: string): boolean;
  createAutomatedWorkItem(input: { taskId: string; employeeId: string; sourceRef: string }): Promise<{ item: TaskWorkItemRecord; run: TaskWorkRunRecord }>;
  close(): Promise<void>;
}

/** v2 工作管理：新指派只创建独立工作项，不读写旧阶段与旧执行。 */
export function registerTaskWorkManagement(options: TaskWorkManagementOptions): TaskWorkManagementController {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let active: Promise<void> | null = null;
  let closed = false;

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
    options.server.post('/api/tasks/:taskId/work-item-previews', async (request: FastifyRequest<{ Params: { taskId: string }; Body: TaskWorkPreviewSelection & { commandParameters?: Record<string, unknown> } }>, reply) =>
      route(reply, async () => {
        const task = requireTaskOrThrow(options, request.params.taskId);
        const selection = normalizeSelection(request.body);
        return resolvePreview(options, task, selection, request.body.commandParameters ?? {});
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
        const runtimeParameters = request.body?.runtime?.commandParameters ?? {};
        const preview = await resolvePreview(options, task, normalizeSelection(parsed.input.selection), runtimeParameters);
        if (preview.previewSha256 !== parsed.input.previewSha256 || preview.expectedTaskRevision !== parsed.input.expectedTaskRevision || preview.expectedEmployeeRevision !== parsed.input.expectedEmployeeRevision) {
          throw new TaskWorkStoreError('ZEUS_TASK_WORK_PREVIEW_STALE', '任务、员工或能力来源已变化，请重新预览后再指派。');
        }
        if (preview.command && parsed.input.commandParameterDigest !== preview.command.parameterDigest) {
          throw new TaskWorkStoreError('ZEUS_TASK_WORK_PREVIEW_STALE', '命令参数已变化，请重新预览后再指派。');
        }
        if (preview.blockers.length > 0) throw new TaskWorkStoreError(preview.blockers[0]!.code, preview.blockers[0]!.message);
        const employee = requireEmployeeOrThrow(options, task.projectId, preview.employee.id);
        const skillResources = await prepareSkillResourceSnapshots(options, task, preview);
        const created = options.application.executeCore({
          parsed,
          destinationId: 'task-work-item-repository',
          resourceId: `task_work_item:${parsed.operationIdentity}`,
          mutateBusinessState: () => createWorkItemFromPreview(options, task, employee, preview, parsed.operationIdentity, { source: 'manual', sourceRef: `manual:${parsed.operationIdentity}` }, skillResources),
        });
        await options.save();
        if (created.result.run.entrypointKind === 'command' && !created.result.run.commandRunId) {
          const dispatching = created.result.run.status === 'prepared' ? options.runs.update(created.result.run.id, { status: 'dispatching', startedAt: options.now().toISOString() }) : created.result.run;
          await startCommandRun(options, created.result.item, dispatching, runtimeParameters, preview);
          await options.save();
        }
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
        const result = options.application.executeCore({
          parsed,
          destinationId: 'task-work-item-repository',
          resourceId: `task_work_item:${item.id}`,
          mutateBusinessState: () => cancelWorkItem(options, item, parsed.input.expectedRevision),
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
          await respondToConversationRequest(options, decision, response, parsed.operationIdentity);
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
    kick,
    countActiveByEmployee: (employeeId) => options.items.countActiveByEmployee(employeeId),
    hasAutomationSource: (sourceRef) => Boolean(options.items.getBySource('automation', sourceRef)),
    createAutomatedWorkItem: async ({ taskId, employeeId, sourceRef }) => {
      const replay = options.items.getBySource('automation', sourceRef);
      if (replay?.currentRunId) {
        const run = options.runs.getById(replay.currentRunId);
        if (run) return { item: replay, run };
      }
      const task = requireTaskOrThrow(options, taskId);
      const employee = requireEmployeeOrThrow(options, task.projectId, employeeId);
      const preview = await resolvePreview(options, task, { employeeId }, {});
      const blockers = preview.blockers.filter((blocker) => employee.entrypoint?.kind !== 'command' || blocker.code !== 'ZEUS_TASK_WORK_COMMAND_PARAMETER_REQUIRED');
      if (blockers.length > 0) throw new TaskWorkStoreError(blockers[0]!.code, blockers[0]!.message);
      const skillResources = await prepareSkillResourceSnapshots(options, task, preview);
      const created = createWorkItemFromPreview(options, task, employee, preview, stableIdentity('task_work_item', sourceRef), { source: 'automation', sourceRef }, skillResources);
      if (created.run.entrypointKind === 'command') {
        const dispatching = options.runs.update(created.run.id, { status: 'dispatching', startedAt: options.now().toISOString() });
        const activeItem = options.items.update(created.item.id, { status: 'active' });
        const waitingRun = options.runs.update(dispatching.id, { status: 'waiting_input' });
        const waitingItem = options.items.update(activeItem.id, { status: 'waiting_manager' });
        options.decisions.create({
          projectId: waitingRun.projectId,
          taskId: waitingRun.taskId,
          workItemId: waitingRun.workItemId,
          runId: waitingRun.id,
          deliverableId: null,
          kind: 'command_confirmation',
          title: '确认自动化项目命令',
          prompt: '自动化只创建待确认事项。请填写命令参数并显式确认；Zeus 不会在后台自动执行外部动作。',
          requestPayload: { command: preview.command, commandRevision: preview.command?.revision ?? null },
          operationIdentity: `command-confirmation:${waitingRun.id}`,
          expiresAt: null,
        });
        await options.save();
        publishChanged(options, task.id, waitingItem.id, 'automation_command_confirmation_required');
        return { item: waitingItem, run: waitingRun };
      }
      await options.save();
      publishChanged(options, task.id, created.item.id, 'automation_created');
      kick();
      return created;
    },
    close: async () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (active) await active;
    },
  };

  async function processRuns(): Promise<void> {
    for (const runRecord of options.runs.listRecoverable(100)) {
      if (closed) return;
      const current = options.runs.getById(runRecord.id);
      if (!current) continue;
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
}

async function resolvePreview(options: TaskWorkManagementOptions, task: ZeusTaskRecord, selection: TaskWorkPreviewSelection, rawParameters: Record<string, unknown>): Promise<TaskWorkPreview> {
  const blockers: TaskWorkPreview['blockers'] = [];
  const employee = options.employees.getById(selection.employeeId);
  if (!employee || employee.projectId !== task.projectId) throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '数字员工不存在。', 404);
  if (options.isTaskTerminal(task) || task.status === 'completed' || task.status === 'cancelled') blockers.push({ code: 'ZEUS_TASK_WORK_TASK_TERMINAL', message: '终态任务不能创建新工作项。' });
  if (!employee.enabled) blockers.push({ code: 'ZEUS_DIGITAL_EMPLOYEE_DISABLED', message: '数字员工已停用。' });
  if (!employee.entrypoint || employee.entrypointMigrationState !== 'ready')
    blockers.push({
      code: 'ZEUS_DIGITAL_EMPLOYEE_ENTRYPOINT_REQUIRED',
      message: employee.entrypointMigrationState === 'requires_selection' ? '该员工同时保留 Agent 和命令配置，请先在员工设置中选择主执行入口。' : '该 Command 员工尚未选择项目命令，暂不可指派。',
    });
  if (options.items.countActiveByEmployee(employee.id) >= employee.maxConcurrency) blockers.push({ code: 'ZEUS_TASK_WORK_EMPLOYEE_CAPACITY', message: `该员工已达并发上限 ${employee.maxConcurrency}。` });

  const context = resolveContextManifest(options, task, selection.selectedDeliverableIds ?? [], blockers);
  let model: Record<string, unknown> | null = null;
  const skills: TaskWorkPreview['skills'] = [];
  let command: TaskWorkPreview['command'] = null;
  let entrypoint: Record<string, unknown> | null = employee.entrypoint ? sanitizeEntrypoint(employee.entrypoint) : null;
  const authority = employee.entrypoint?.kind === 'agent' ? { ...employee.entrypoint.authorityPolicy } : {};

  if (employee.entrypoint?.kind === 'agent') {
    const agentEntrypoint = employee.entrypoint;
    const capability = await options.conversationCapabilities.readTaskPush(task.projectId, task.id);
    model = resolveAgentModel(employee, agentEntrypoint, selection, capability, blockers);
    const selectedSkillIds = normalizeIdentities(selection.skillIds ?? agentEntrypoint.skillPolicy.allowedSkillIds);
    if (selectedSkillIds.some((id) => !agentEntrypoint.skillPolicy.allowedSkillIds.includes(id))) blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_NOT_ALLOWED', message: '指派包含该员工未允许的 Skill。' });
    if (selectedSkillIds.length > 0 && !options.skills) blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_CATALOG_UNAVAILABLE', message: 'Zeus Skill 目录当前不可用。' });
    if (options.skills) {
      for (const skillId of selectedSkillIds) {
        try {
          const resolvedSkill = await options.skills.resolve({ cwd: options.projects.getById(task.projectId)!.localPath, skillId });
          skills.push(await snapshotSkill(resolvedSkill));
        } catch (error) {
          blockers.push({ code: 'ZEUS_TASK_WORK_SKILL_UNAVAILABLE', message: serializeError(error).message });
        }
      }
    }
  } else if (employee.entrypoint?.kind === 'command') {
    const definition = options.commandDefinitions.getById(employee.entrypoint.commandId);
    if (!definition || !definition.enabled || (definition.scope === 'project' && definition.projectId !== task.projectId)) {
      blockers.push({ code: 'ZEUS_TASK_WORK_COMMAND_UNAVAILABLE', message: '员工配置的项目命令不存在、已停用或不属于当前项目。' });
    } else {
      command = resolveCommandPreview(definition, rawParameters, blockers);
      entrypoint = { kind: 'command', commandId: definition.id, commandRevision: definition.revision, title: definition.title };
    }
  }

  const digestSource = {
    expectedTaskRevision: task.updatedAt,
    expectedEmployeeRevision: employee.revision,
    selection,
    employee: { id: employee.id, name: employee.name, role: employee.role, domain: employee.domain, revision: employee.revision },
    entrypoint,
    model,
    skills,
    authority,
    context,
    command,
    blockers,
  };
  return { previewSha256: sha256(canonicalJson(digestSource)), expiresAt: new Date(options.now().getTime() + previewTtlMs).toISOString(), ...digestSource };
}

function createWorkItemFromPreview(
  options: TaskWorkManagementOptions,
  task: ZeusTaskRecord,
  employee: DigitalEmployeeRecord,
  preview: TaskWorkPreview,
  operationIdentity: string,
  source: { source: 'manual' | 'automation'; sourceRef: string } = { source: 'manual', sourceRef: `manual:${operationIdentity}` },
  skillResources: PreparedSkillResourceSnapshot[] = [],
): { item: TaskWorkItemRecord; run: TaskWorkRunRecord } {
  if (!employee.entrypoint) throw new TaskWorkStoreError('ZEUS_DIGITAL_EMPLOYEE_ENTRYPOINT_REQUIRED', '数字员工主入口未配置。');
  const item = options.items.create({
    id: operationIdentity,
    projectId: task.projectId,
    taskId: task.id,
    employeeId: employee.id,
    source: source.source,
    sourceRef: source.sourceRef,
    title: `${employee.name}·${task.title}`,
    description: task.description,
    entrypointKind: employee.entrypoint.kind,
    status: 'queued',
  });
  const existingRun = item.currentRunId ? options.runs.getById(item.currentRunId) : undefined;
  if (existingRun) return { item, run: existingRun };
  const runId = stableIdentity('task_work_run', `${item.id}\0attempt:1`);
  const skillSnapshot = persistSkillResourceSnapshots(options, runId, task.projectId, skillResources);
  const run = options.runs.create({
    id: runId,
    projectId: task.projectId,
    taskId: task.id,
    workItemId: item.id,
    employeeId: employee.id,
    attempt: 1,
    status: 'prepared',
    entrypointKind: employee.entrypoint.kind,
    employeeRevision: employee.revision,
    employeeSnapshot: structuredClone(employee) as unknown as Record<string, unknown>,
    entrypointSnapshot: structuredClone(preview.entrypoint ?? {}),
    modelSnapshot: preview.model,
    skillSnapshot,
    authoritySnapshot: structuredClone(preview.authority),
    contextManifest: structuredClone(preview.context),
  });
  const updatedItem = options.items.update(item.id, { currentRunId: run.id });
  options.taskEvents.create({ taskId: task.id, eventType: 'task.work_item.created', title: '已创建数字员工工作项', payload: { workItemId: item.id, runId: run.id, employeeId: employee.id, entrypointKind: employee.entrypoint.kind } });
  return { item: updatedItem, run };
}

async function processAgentRun(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Promise<void> {
  if (run.status === 'prepared' || run.status === 'dispatching') {
    const dispatching = run.status === 'prepared' ? options.runs.update(run.id, { status: 'dispatching', startedAt: options.now().toISOString() }) : run;
    const item = options.items.getById(run.workItemId)!;
    if (item.status === 'queued') options.items.update(item.id, { status: 'active' });
    verifyFrozenSkillResources(options, dispatching);
    await dispatchAgent(options, dispatching);
    return;
  }
  if (!run.conversationId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONVERSATION_MISSING', 'Agent 工作运行缺少会话身份。');
  verifyFrozenSkillResources(options, run);
  recordActuallyEnabledSkills(options, run);
  const conversation = options.conversations.getById(run.conversationId);
  if (!conversation || conversation.taskId !== run.taskId || conversation.projectId !== run.projectId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONVERSATION_MISSING', 'Agent 工作运行的会话已不可用。');
  if (conversation.stage === 'waiting_user' || conversation.stage === 'waiting_approval' || conversation.providerState === 'waiting') {
    createConversationDecisions(options, run);
    if (run.status !== 'waiting_input') options.runs.update(run.id, { status: 'waiting_input' });
    const item = options.items.getById(run.workItemId)!;
    if (item.status !== 'waiting_manager') options.items.update(item.id, { status: 'waiting_manager' });
    return;
  }
  if (conversation.stage === 'failed' || conversation.providerState === 'failed') throw new TaskWorkStoreError('ZEUS_TASK_WORK_AGENT_FAILED', 'Agent 会话执行失败，请从证据页查看详情。');
  if (conversation.stage !== 'completed') {
    if (run.status !== 'active') options.runs.update(run.id, { status: 'active' });
    return;
  }
  const existing = options.deliverables.listByTask(run.taskId).find((candidate) => candidate.runId === run.id);
  if (!existing) await captureAgentDeliverable(options, run, conversation.messages);
}

async function dispatchAgent(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): Promise<void> {
  const task = requireTaskOrThrow(options, run.taskId);
  const project = options.projects.getById(run.projectId);
  if (!project) throw new TaskWorkStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
  const model = run.modelSnapshot;
  if (!model || typeof model.id !== 'string' || typeof model.agentKind !== 'string') throw new TaskWorkStoreError('ZEUS_TASK_WORK_MODEL_MISSING', 'Agent 运行缺少已解析模型快照。');
  const authority = run.authoritySnapshot;
  const capabilities = await options.conversationCapabilities.readTaskPush(project.id, task.id);
  const repositories = Array.isArray(capabilities.repositories) ? capabilities.repositories.filter(isRecord) : [];
  const repositoryRevision = typeof capabilities.repositoryRevision === 'string' ? capabilities.repositoryRevision : '';
  const writeEnabled = authority.permissionMode !== 'read-only' && (authority.allowCodeChanges === true || authority.allowTests === true);
  let workspace: Record<string, unknown> = { mode: 'direct' };
  if (repositories.length > 0) {
    if (!repositoryRevision) throw new TaskWorkStoreError('ZEUS_TASK_WORK_REPOSITORY_REVISION_REQUIRED', '项目仓库清单缺少稳定版本。');
    workspace = {
      mode: 'create',
      repositoryRevision,
      repositories: repositories.map((repository) => {
        const sourceRefs = Array.isArray(repository.sourceRefs) ? repository.sourceRefs.filter(isRecord) : [];
        const source = sourceRefs.find((candidate) => candidate.current === true) ?? sourceRefs.find((candidate) => candidate.kind === 'local');
        if (!source || typeof repository.id !== 'string' || typeof source.ref !== 'string' || typeof repository.suggestedBranchName !== 'string')
          throw new TaskWorkStoreError('ZEUS_TASK_WORK_SOURCE_REF_UNAVAILABLE', '项目仓库没有可用的来源分支。');
        return { repositoryId: repository.id, sourceRef: source.ref, branchName: repository.suggestedBranchName };
      }),
    };
  } else if (writeEnabled && isRecord(capabilities.directWorkspace) && typeof capabilities.directWorkspace.activeWritableConversationCount === 'number' && capabilities.directWorkspace.activeWritableConversationCount > 0) {
    throw new TaskWorkStoreError('ZEUS_TASK_WORK_DIRECT_WORKSPACE_BUSY', '项目目录已有可写会话，新运行不会隐式共享写入现场。');
  }
  const supplementalInfo = await buildAgentSupplementalInfo(options, run);
  const body: Record<string, unknown> = {
    mode: 'create',
    model: model.id,
    agentKind: model.agentKind,
    ...(typeof model.reasoningEffort === 'string' ? { effort: model.reasoningEffort } : {}),
    ...(typeof model.serviceTier === 'string' ? { serviceTier: model.serviceTier } : {}),
    permissionMode: typeof authority.permissionMode === 'string' ? authority.permissionMode : 'read-only',
    source: 'task_push',
    workMode: 'default',
    supplementalInfo,
    workspace,
  };
  const accepted = await options.executeTaskConversationIdempotent(project, task, body, `task-work-run:${run.id}`);
  const response = isRecord(accepted.body) ? accepted.body : {};
  const projection = isRecord(response.conversation) ? response.conversation : {};
  const conversationId = typeof projection.id === 'string' ? projection.id : null;
  if (!conversationId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_ACCEPTANCE_NOT_DURABLE', '任务推送没有返回耐久会话身份。');
  options.runs.update(run.id, { status: 'active', conversationId });
  publishChanged(options, run.taskId, run.workItemId, 'agent_started');
}

async function captureAgentDeliverable(options: TaskWorkManagementOptions, run: TaskWorkRunRecord, messages: Array<{ id: string; role: string; content: string }>): Promise<void> {
  const message = [...messages].reverse().find((candidate) => candidate.role === 'assistant' && candidate.content.trim());
  if (!message) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DELIVERABLE_EMPTY', 'Agent 会话已结束，但没有可沉淀的正式输出。');
  const deliverableId = stableIdentity('task_work_deliverable', run.id);
  const artifact = await options.artifacts.putText({
    text: message.content,
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
  const accepted = options.deliverables.transition(deliverable.id, expectedRevision, 'accepted');
  const run = options.runs.getById(deliverable.runId)!;
  const item = options.items.getById(deliverable.workItemId)!;
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
  const changed = options.deliverables.transition(deliverable.id, expectedRevision, 'changes_requested');
  const previousRun = options.runs.getById(deliverable.runId)!;
  const item = options.items.getById(deliverable.workItemId)!;
  const closedRun = options.runs.update(previousRun.id, {
    status: 'failed',
    errorCode: 'ZEUS_TASK_WORK_CHANGES_REQUESTED',
    errorMessage: reason,
    completedAt: options.now().toISOString(),
  });
  const next = cloneRun(options, item, closedRun, { reworkReason: reason });
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

function cloneRun(options: TaskWorkManagementOptions, item: TaskWorkItemRecord, previous: TaskWorkRunRecord, entrypointPatch: Record<string, unknown> = {}): TaskWorkRunRecord {
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
    entrypointSnapshot: { ...structuredClone(previous.entrypointSnapshot), ...entrypointPatch },
    modelSnapshot: previous.modelSnapshot ? structuredClone(previous.modelSnapshot) : null,
    skillSnapshot,
    authoritySnapshot: structuredClone(previous.authoritySnapshot),
    contextManifest: structuredClone(previous.contextManifest),
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
  if (run && !['succeeded', 'failed', 'outcome_unknown', 'cancelled'].includes(run.status)) options.runs.update(run.id, { status: 'cancelled', completedAt: options.now().toISOString() });
  return options.items.update(item.id, { expectedRevision, status: 'cancelled' });
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
    responseRecordedBy: decision.kind === 'input_required' || decision.kind === 'authorization' ? 'conversation_request' : 'manager_action',
  });
  if ((decision.kind === 'input_required' || decision.kind === 'authorization') && decision.runId) {
    const run = options.runs.getById(decision.runId);
    if (run?.status === 'waiting_input') options.runs.update(run.id, { status: 'active' });
  }
  const item = options.items.getById(decision.workItemId);
  if ((decision.kind === 'input_required' || decision.kind === 'authorization') && item?.status === 'waiting_manager') options.items.update(item.id, { status: 'active' });
  return resolved;
}

async function respondToConversationRequest(options: TaskWorkManagementOptions, decision: TaskWorkDecisionRecord, response: Record<string, unknown>, operationIdentity: string): Promise<void> {
  const run = decision.runId ? options.runs.getById(decision.runId) : undefined;
  const requestId = typeof decision.requestPayload.requestId === 'string' ? decision.requestPayload.requestId : null;
  if (!run?.conversationId || !requestId) throw new TaskWorkStoreError('ZEUS_TASK_WORK_DECISION_SOURCE_MISSING', '待办缺少可回复的会话请求。');
  const body = commandEnvelope(conversationDispatchCommandTypes.serverRequestRespond, 'approval', requestId, operationIdentity, response, conversationDispatchInputSha256(response));
  const result = await options.server.inject({
    method: 'POST',
    url: `/api/projects/${encodeURIComponent(run.projectId)}/conversations/${encodeURIComponent(run.conversationId)}/requests/${encodeURIComponent(requestId)}/respond`,
    headers: { authorization: `Bearer ${options.apiToken}` },
    payload: body,
  });
  if (result.statusCode !== 202) throw new TaskWorkStoreError(result.statusCode >= 500 ? 'ZEUS_TASK_WORK_DECISION_OUTCOME_UNKNOWN' : 'ZEUS_TASK_WORK_DECISION_REJECTED', safeHttpMessage(result));
}

function createConversationDecisions(options: TaskWorkManagementOptions, run: TaskWorkRunRecord): void {
  if (!run.conversationId) return;
  for (const request of options.conversationRequests.listPendingByConversation(run.conversationId)) {
    const kind = request.requestKind === 'request_user_input' ? 'input_required' : 'authorization';
    options.decisions.create({
      projectId: run.projectId,
      taskId: run.taskId,
      workItemId: run.workItemId,
      runId: run.id,
      deliverableId: null,
      kind,
      title: kind === 'input_required' ? '员工需要补充信息' : '员工等待授权',
      prompt: '请在任务详情中处置该请求；会话页仅作为证据查看。',
      requestPayload: { requestId: request.id, requestKind: request.requestKind, containsSecret: request.containsSecret, payload: safeJsonParse(request.payloadJson) },
      operationIdentity: `conversation-request:${request.id}`,
      expiresAt: request.expiresAt,
    });
  }
}

function resolveAcceptanceDecision(options: TaskWorkManagementOptions, deliverableId: string, response: Record<string, unknown>): void {
  const decision = options.decisions.listByTask(options.deliverables.getById(deliverableId)!.taskId).find((candidate) => candidate.deliverableId === deliverableId && candidate.status === 'pending');
  if (decision) options.decisions.resolve(decision.id, decision.revision, response);
}

function workManagementProjection(options: TaskWorkManagementOptions, task: ZeusTaskRecord) {
  const items = options.items.listByTask(task.id);
  const runs = options.runs.listByTask(task.id);
  const deliverables = options.deliverables.listByTask(task.id);
  const decisions = options.decisions.listByTask(task.id);
  const legacyExecutions = options.legacyExecutions.listByTask(task.id);
  return {
    summary: {
      workItems: items.length,
      activeWorkItems: items.filter((item) => ['queued', 'active', 'waiting_manager', 'blocked'].includes(item.status)).length,
      pendingManagerDecisions: decisions.filter((decision) => decision.status === 'pending').length,
      submittedDeliverables: deliverables.filter((deliverable) => deliverable.status === 'submitted').length,
      legacyExecutions: legacyExecutions.length,
    },
    workItems: items.map((item) => ({ ...item, runs: runs.filter((run) => run.workItemId === item.id), deliverables: deliverables.filter((deliverable) => deliverable.workItemId === item.id) })),
    relationships: [],
    managerDecisions: decisions,
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

function resolveAgentModel(
  employee: DigitalEmployeeRecord,
  entrypoint: Extract<EmployeeEntrypointV2, { kind: 'agent' }>,
  selection: TaskWorkPreviewSelection,
  capability: Record<string, unknown>,
  blockers: TaskWorkPreview['blockers'],
): Record<string, unknown> | null {
  const models = Array.isArray(capability.models) ? capability.models.filter(isCapabilityModel).filter((model) => model.agentKind === entrypoint.agentKind) : [];
  const requested = selection.modelOverride?.trim() || (entrypoint.modelPolicy.defaultMode === 'explicit' ? entrypoint.modelPolicy.defaultModel : null) || (typeof capability.preferredModel === 'string' ? capability.preferredModel : null);
  const model = requested ? models.find((candidate) => candidate.id === requested || candidate.model === requested) : models.find((candidate) => candidate.available);
  if (!model || !model.available) {
    blockers.push({ code: 'ZEUS_TASK_WORK_MODEL_UNAVAILABLE', message: requested ? `模型 ${requested} 当前不可用。` : '项目当前没有可用模型。' });
    return null;
  }
  if (entrypoint.modelPolicy.allowedModels.length > 0 && !entrypoint.modelPolicy.allowedModels.some((allowed) => allowed === model.id || allowed === model.model))
    blockers.push({ code: 'ZEUS_TASK_WORK_MODEL_NOT_ALLOWED', message: '所选模型不在员工允许范围内。' });
  const reasoningEffort = selection.reasoningEffort?.trim() || model.defaultReasoningEffort || employee.reasoningEffort;
  if (reasoningEffort && (!model.supportedReasoningEfforts.includes(reasoningEffort) || (entrypoint.modelPolicy.allowedReasoningEfforts.length > 0 && !entrypoint.modelPolicy.allowedReasoningEfforts.includes(reasoningEffort))))
    blockers.push({ code: 'ZEUS_TASK_WORK_REASONING_NOT_ALLOWED', message: '所选推理强度不可用或不在员工允许范围内。' });
  const serviceTier = selection.serviceTier?.trim() || model.defaultServiceTier || employee.serviceTier;
  if (serviceTier && (!model.serviceTiers.some((tier) => tier.id === serviceTier) || (entrypoint.modelPolicy.allowedServiceTiers.length > 0 && !entrypoint.modelPolicy.allowedServiceTiers.includes(serviceTier))))
    blockers.push({ code: 'ZEUS_TASK_WORK_SERVICE_TIER_NOT_ALLOWED', message: '所选服务速率不可用或不在员工允许范围内。' });
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
    metadata: { id: skill.id, name: skill.name, description: skill.description, directoryName: basename(root), contentSha256: sha256(canonicalJson(digests)), resourceCount: fileCount, totalBytes },
    files,
  };
}

async function prepareSkillResourceSnapshots(options: TaskWorkManagementOptions, task: ZeusTaskRecord, preview: TaskWorkPreview): Promise<PreparedSkillResourceSnapshot[]> {
  if (preview.skills.length === 0) return [];
  if (!options.skills) throw new TaskWorkStoreError('ZEUS_TASK_WORK_SKILL_CATALOG_UNAVAILABLE', 'Zeus Skill 目录当前不可用。');
  const project = options.projects.getById(task.projectId);
  if (!project) throw new TaskWorkStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', 404);
  const snapshots: PreparedSkillResourceSnapshot[] = [];
  for (const expected of preview.skills) {
    const skill = await options.skills.resolve({ cwd: project.localPath, skillId: expected.id });
    const snapshot = await readSkillResourceSnapshot(skill);
    if (snapshot.metadata.contentSha256 !== expected.contentSha256) throw new TaskWorkStoreError('ZEUS_TASK_WORK_PREVIEW_STALE', `Skill ${expected.name} 已变化，请重新预览后再指派。`);
    snapshots.push(snapshot);
  }
  return snapshots;
}

function persistSkillResourceSnapshots(options: TaskWorkManagementOptions, runId: string, projectId: string, snapshots: PreparedSkillResourceSnapshot[]): Record<string, unknown> {
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
  return { generation: taskWorkSkillArtifactGeneration, selected };
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
  const employee = run.employeeSnapshot;
  const metadata = isRecord(run.skillSnapshot) && Array.isArray(run.skillSnapshot.selected) ? run.skillSnapshot.selected : [];
  const selectedContent: string[] = [];
  for (const ref of run.contextManifest.acceptedDeliverables) {
    const deliverable = options.deliverables.getById(ref.deliverableId);
    if (!deliverable || deliverable.status !== 'accepted' || deliverable.version !== ref.version || deliverable.contentSha256 !== ref.contentSha256)
      throw new TaskWorkStoreError('ZEUS_TASK_WORK_CONTEXT_CHANGED', '已选上下文交付物与运行快照不一致。');
    const stored = await options.artifacts.readAuthorized({ sha256: deliverable.artifactSha256, owner: { kind: 'task_work_deliverable', id: deliverable.id }, maximumContentBytes: 16 * 1024 * 1024 });
    selectedContent.push(`## 已选且已验收的交付物：${deliverable.title}（v${deliverable.version}）\n\n${Buffer.from(stored.bytes).toString('utf8')}`);
  }
  return [
    `你正在以 Zeus 数字员工“${String(employee.name ?? '')}”身份处理一个独立工作项。本次行为只由冻结的员工能力配置决定，与指派次数、尝试次数无关。`,
    typeof run.entrypointSnapshot.prompt === 'string' ? `## 员工提示\n\n${run.entrypointSnapshot.prompt}` : '',
    `## 冻结的上下文清单\n\n${JSON.stringify(run.contextManifest, null, 2)}`,
    metadata.length > 0
      ? `## 允许按需加载的 Skill 元数据\n\n${JSON.stringify(metadata, null, 2)}\n\n仅在任务需要时从各项 snapshotPath 中读取冻结资源，不得改读同名的全局或项目 Skill；读取 SKILL.md 即代表实际启用，且 Skill 不授予额外权限。`
      : '本次运行未选择 Skill。',
    ...selectedContent,
    typeof run.entrypointSnapshot.reworkReason === 'string' ? `## 管理者要求修改\n\n${run.entrypointSnapshot.reworkReason}` : '',
    '提交、推送、合入、部署和任务完结均不是会话结束后的隐藏路线。如需这些动作，等待管理者显式指令。',
  ]
    .filter(Boolean)
    .join('\n\n');
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
    modelOverride: optionalText(value.modelOverride, 256),
    reasoningEffort: optionalText(value.reasoningEffort, 64),
    serviceTier: optionalText(value.serviceTier, 64),
    skillIds: Array.isArray(value.skillIds) ? normalizeIdentities(value.skillIds) : undefined,
    selectedDeliverableIds: Array.isArray(value.selectedDeliverableIds) ? normalizeIdentities(value.selectedDeliverableIds) : undefined,
  };
}

function sanitizeEntrypoint(entrypoint: EmployeeEntrypointV2): Record<string, unknown> {
  if (entrypoint.kind === 'command') return { kind: 'command', commandId: entrypoint.commandId };
  return { kind: 'agent', prompt: entrypoint.prompt, agentKind: entrypoint.agentKind, modelPolicy: entrypoint.modelPolicy, skillPolicy: entrypoint.skillPolicy, authorityPolicy: entrypoint.authorityPolicy };
}

function commandEnvelope<T extends object>(
  commandType: string,
  scopeKind: 'command_run' | 'approval',
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
function requiredText(value: unknown, message: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) throw new TaskWorkStoreError('ZEUS_TASK_WORK_INPUT_INVALID', message, 400);
  return value.trim();
}
function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return requiredText(value, '参数无效。', maximum);
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
