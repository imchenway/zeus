import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  CommandDefinitionRepository,
  DigitalEmployeeAutomationRepository,
  DigitalEmployeeExecutionRepository,
  DigitalEmployeeProjectEventRepository,
  DigitalEmployeeRepository,
  DigitalEmployeeStoreError,
  DigitalEmployeeTemplateRepository,
  type AppendAuditLogInput,
  type CreateDigitalEmployeeAutomationInput,
  type CreateDigitalEmployeeInput,
  type CreateDigitalEmployeeTemplateInput,
  type DigitalEmployeeRecord,
  type DigitalEmployeeExecutionRecord,
  type ProjectRepository,
  type TaskEventRepository,
  type TaskRepository,
  type UpdateDigitalEmployeeAutomationInput,
  type UpdateDigitalEmployeeInput,
  type UpdateDigitalEmployeeTemplateInput,
  type ZeusTaskRecord,
} from '@zeus/storage';
import { WorkManagementCommandApplication, type ParsedWorkManagementMutation, type WorkManagementMutationRequest, workManagementCommandHttpError, workManagementCommandTypes } from './workManagementCommandApplication.js';

interface DigitalEmployeeRouteOptions {
  server: FastifyInstance;
  application: WorkManagementCommandApplication;
  projects: Pick<ProjectRepository, 'getById'>;
  tasks: Pick<TaskRepository, 'getById'>;
  taskEvents: Pick<TaskEventRepository, 'create'>;
  templates: DigitalEmployeeTemplateRepository;
  employees: DigitalEmployeeRepository;
  automations: DigitalEmployeeAutomationRepository;
  executions: DigitalEmployeeExecutionRepository;
  projectEvents: DigitalEmployeeProjectEventRepository;
  commandDefinitions: CommandDefinitionRepository;
  appendAuditLog(input: Omit<AppendAuditLogInput, 'createdAt'> & { createdAt?: string }): void;
  publishRealtimeEvent(type: string, payload: Record<string, unknown>): unknown;
  isTaskTerminal(task: ZeusTaskRecord): boolean;
  save(): Promise<void>;
  kick(): void;
}

type DeleteInput = { expectedRevision: number };
type CreateEmployeeBody = { templateId?: string; overrides?: Partial<Omit<CreateDigitalEmployeeInput, 'projectId' | 'templateId'>> } & Partial<Omit<CreateDigitalEmployeeInput, 'projectId'>>;
type CreateExecutionBody = { employeeId: string };

/** 数字员工的公开读写边界；写操作全部复用工作管理 Command ledger。 */
export function registerDigitalEmployeeRoutes(options: DigitalEmployeeRouteOptions): void {
  options.server.get('/api/digital-employee-templates', async () => options.templates.list());
  options.server.get('/api/projects/:projectId/digital-employees', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!requireProject(options, request.params.projectId, reply)) return;
    return options.employees.listByProject(request.params.projectId);
  });
  options.server.get('/api/projects/:projectId/digital-employee-automations', async (request: FastifyRequest<{ Params: { projectId: string } }>, reply) => {
    if (!requireProject(options, request.params.projectId, reply)) return;
    return options.automations.listByProject(request.params.projectId);
  });
  options.server.get('/api/projects/:projectId/digital-employee-executions', async (request: FastifyRequest<{ Params: { projectId: string }; Querystring: { limit?: string } }>, reply) => {
    if (!requireProject(options, request.params.projectId, reply)) return;
    const limit = Number(request.query.limit ?? 100);
    return options.executions.listByProject(request.params.projectId, Number.isFinite(limit) ? limit : 100);
  });
  options.server.get('/api/tasks/:taskId/digital-employee-executions', async (request: FastifyRequest<{ Params: { taskId: string } }>, reply) => {
    if (!requireTask(options, request.params.taskId, reply)) return;
    return options.executions.listByTask(request.params.taskId);
  });

  options.server.post('/api/digital-employee-templates', async (request: FastifyRequest<{ Body: WorkManagementMutationRequest<CreateDigitalEmployeeTemplateInput> }>, reply) =>
    runRoute(reply, async () => {
      const parsed = options.application.parse<CreateDigitalEmployeeTemplateInput>({
        value: request.body,
        commandType: workManagementCommandTypes.digitalEmployeeTemplateCreate,
        scopeKind: 'settings',
        expectedScopeId: () => 'digital-employee-templates',
      });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-template-repository',
        resourceId: `digital_employee_template:${parsed.operationIdentity}`,
        mutateBusinessState: () => {
          const record = options.templates.create({ ...parsed.input, id: parsed.operationIdentity });
          audit(options, parsed, 'digital_employee.template.created', 'digital_employee_template', record.id, { builtIn: false });
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.template.changed', { templateId: mutation.result.id });
      return reply.code(201).send(mutation.result);
    }),
  );

  options.server.patch('/api/digital-employee-templates/:templateId', async (request: FastifyRequest<{ Params: { templateId: string }; Body: WorkManagementMutationRequest<UpdateDigitalEmployeeTemplateInput> }>, reply) =>
    runRoute(reply, async () => {
      const parsed = options.application.parse<UpdateDigitalEmployeeTemplateInput>({
        value: request.body,
        commandType: workManagementCommandTypes.digitalEmployeeTemplateUpdate,
        scopeKind: 'settings',
        expectedScopeId: () => `digital-employee-template:${request.params.templateId}`,
      });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-template-repository',
        resourceId: `digital_employee_template:${request.params.templateId}`,
        mutateBusinessState: () => {
          const record = options.templates.update(request.params.templateId, parsed.input);
          audit(options, parsed, 'digital_employee.template.updated', 'digital_employee_template', record.id, { revision: record.revision });
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.template.changed', { templateId: mutation.result.id });
      return mutation.result;
    }),
  );

  options.server.delete('/api/digital-employee-templates/:templateId', async (request: FastifyRequest<{ Params: { templateId: string }; Body: WorkManagementMutationRequest<DeleteInput> }>, reply) =>
    runRoute(reply, async () => {
      const parsed = options.application.parse<DeleteInput>({
        value: request.body,
        commandType: workManagementCommandTypes.digitalEmployeeTemplateDelete,
        scopeKind: 'settings',
        expectedScopeId: () => `digital-employee-template:${request.params.templateId}`,
      });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-template-repository',
        resourceId: `digital_employee_template:${request.params.templateId}`,
        mutateBusinessState: () => {
          const record = options.templates.delete(request.params.templateId, parsed.input.expectedRevision);
          audit(options, parsed, 'digital_employee.template.deleted', 'digital_employee_template', record.id, {});
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.template.changed', { templateId: mutation.result.id, deleted: true });
      return mutation.result;
    }),
  );

  options.server.post('/api/projects/:projectId/digital-employees', async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<CreateEmployeeBody> }>, reply) =>
    runRoute(reply, async () => {
      const project = requireProject(options, request.params.projectId, reply);
      if (!project) return;
      const parsed = options.application.parse<CreateEmployeeBody>({
        value: request.body,
        commandType: workManagementCommandTypes.digitalEmployeeCreate,
        scopeKind: 'project',
        expectedScopeId: () => project.id,
      });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-repository',
        resourceId: `digital_employee:${parsed.operationIdentity}`,
        mutateBusinessState: () => {
          const record = createEmployee(options, project.id, parsed.operationIdentity, parsed.input);
          validateDeployCommand(options, record.projectId, record.deliveryGrants.allowDeploy, record.deployCommandId);
          audit(options, parsed, 'digital_employee.created', 'digital_employee', record.id, { projectId: project.id, templateId: record.templateId });
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.changed', { projectId: project.id, employeeId: mutation.result.id });
      options.kick();
      return reply.code(201).send(mutation.result);
    }),
  );

  options.server.patch(
    '/api/projects/:projectId/digital-employees/:employeeId',
    async (request: FastifyRequest<{ Params: { projectId: string; employeeId: string }; Body: WorkManagementMutationRequest<UpdateDigitalEmployeeInput> }>, reply) =>
      runRoute(reply, async () => {
        const current = requireEmployee(options, request.params.projectId, request.params.employeeId, reply);
        if (!current) return;
        const parsed = options.application.parse<UpdateDigitalEmployeeInput>({
          value: request.body,
          commandType: workManagementCommandTypes.digitalEmployeeUpdate,
          scopeKind: 'project',
          expectedScopeId: () => current.projectId,
        });
        const projectedGrants = { ...current.deliveryGrants, ...parsed.input.deliveryGrants };
        const projectedDeployCommandId = parsed.input.deployCommandId === undefined ? current.deployCommandId : parsed.input.deployCommandId;
        validateDeployCommand(options, current.projectId, projectedGrants.allowDeploy, projectedDeployCommandId);
        const mutation = options.application.executeCore({
          parsed,
          destinationId: 'digital-employee-repository',
          resourceId: `digital_employee:${current.id}`,
          mutateBusinessState: () => {
            const record = options.employees.update(current.id, parsed.input);
            audit(options, parsed, 'digital_employee.updated', 'digital_employee', record.id, { projectId: record.projectId, revision: record.revision });
            return record;
          },
        });
        await finishMutation(options, mutation.replayed, 'digital_employee.changed', { projectId: current.projectId, employeeId: current.id });
        options.kick();
        return mutation.result;
      }),
  );

  options.server.delete('/api/projects/:projectId/digital-employees/:employeeId', async (request: FastifyRequest<{ Params: { projectId: string; employeeId: string }; Body: WorkManagementMutationRequest<DeleteInput> }>, reply) =>
    runRoute(reply, async () => {
      const current = requireEmployee(options, request.params.projectId, request.params.employeeId, reply);
      if (!current) return;
      const parsed = options.application.parse<DeleteInput>({ value: request.body, commandType: workManagementCommandTypes.digitalEmployeeDelete, scopeKind: 'project', expectedScopeId: () => current.projectId });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-repository',
        resourceId: `digital_employee:${current.id}`,
        mutateBusinessState: () => {
          const record = options.employees.delete(current.id, parsed.input.expectedRevision);
          audit(options, parsed, 'digital_employee.deleted', 'digital_employee', record.id, { projectId: record.projectId });
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.changed', { projectId: current.projectId, employeeId: current.id, deleted: true });
      return mutation.result;
    }),
  );

  registerAutomationRoutes(options);
  registerExecutionRoutes(options);
}

function registerAutomationRoutes(options: DigitalEmployeeRouteOptions): void {
  options.server.post(
    '/api/projects/:projectId/digital-employee-automations',
    async (request: FastifyRequest<{ Params: { projectId: string }; Body: WorkManagementMutationRequest<Omit<CreateDigitalEmployeeAutomationInput, 'projectId'>> }>, reply) =>
      runRoute(reply, async () => {
        const project = requireProject(options, request.params.projectId, reply);
        if (!project) return;
        const parsed = options.application.parse<Omit<CreateDigitalEmployeeAutomationInput, 'projectId'>>({
          value: request.body,
          commandType: workManagementCommandTypes.digitalEmployeeAutomationCreate,
          scopeKind: 'project',
          expectedScopeId: () => project.id,
        });
        const employee = requireEmployee(options, project.id, parsed.input.employeeId);
        validateAutomationEmployee(employee!, parsed.input.actionKind);
        const initialCursorSequence = isProjectEventTrigger(parsed.input.triggerKind) ? options.projectEvents.latestSequence(project.id, parsed.input.triggerKind) : 0;
        const mutation = options.application.executeCore({
          parsed,
          destinationId: 'digital-employee-automation-repository',
          resourceId: `digital_employee_automation:${parsed.operationIdentity}`,
          mutateBusinessState: () => {
            const record = options.automations.create({ ...parsed.input, id: parsed.operationIdentity, projectId: project.id }, { initialCursorSequence });
            audit(options, parsed, 'digital_employee.automation.created', 'digital_employee_automation', record.id, { projectId: project.id, employeeId: record.employeeId, triggerKind: record.triggerKind });
            return record;
          },
        });
        await finishMutation(options, mutation.replayed, 'digital_employee.automation.changed', { projectId: project.id, automationId: mutation.result.id });
        options.kick();
        return reply.code(201).send(mutation.result);
      }),
  );

  options.server.patch(
    '/api/projects/:projectId/digital-employee-automations/:automationId',
    async (request: FastifyRequest<{ Params: { projectId: string; automationId: string }; Body: WorkManagementMutationRequest<UpdateDigitalEmployeeAutomationInput> }>, reply) =>
      runRoute(reply, async () => {
        const current = requireAutomation(options, request.params.projectId, request.params.automationId, reply);
        if (!current) return;
        const parsed = options.application.parse<UpdateDigitalEmployeeAutomationInput>({
          value: request.body,
          commandType: workManagementCommandTypes.digitalEmployeeAutomationUpdate,
          scopeKind: 'project',
          expectedScopeId: () => current.projectId,
        });
        const employee = requireEmployee(options, current.projectId, current.employeeId);
        if (parsed.input.enabled ?? current.enabled) validateAutomationEmployee(employee!, parsed.input.actionKind ?? current.actionKind);
        const nextTriggerKind = parsed.input.triggerKind ?? current.triggerKind;
        const resetCursorSequence = nextTriggerKind !== current.triggerKind && isProjectEventTrigger(nextTriggerKind) ? options.projectEvents.latestSequence(current.projectId, nextTriggerKind) : undefined;
        const mutation = options.application.executeCore({
          parsed,
          destinationId: 'digital-employee-automation-repository',
          resourceId: `digital_employee_automation:${current.id}`,
          mutateBusinessState: () => {
            const record = options.automations.update(current.id, parsed.input, { resetCursorSequence });
            audit(options, parsed, 'digital_employee.automation.updated', 'digital_employee_automation', record.id, { projectId: record.projectId, revision: record.revision });
            return record;
          },
        });
        await finishMutation(options, mutation.replayed, 'digital_employee.automation.changed', { projectId: current.projectId, automationId: current.id });
        options.kick();
        return mutation.result;
      }),
  );

  options.server.delete(
    '/api/projects/:projectId/digital-employee-automations/:automationId',
    async (request: FastifyRequest<{ Params: { projectId: string; automationId: string }; Body: WorkManagementMutationRequest<DeleteInput> }>, reply) =>
      runRoute(reply, async () => {
        const current = requireAutomation(options, request.params.projectId, request.params.automationId, reply);
        if (!current) return;
        const parsed = options.application.parse<DeleteInput>({ value: request.body, commandType: workManagementCommandTypes.digitalEmployeeAutomationDelete, scopeKind: 'project', expectedScopeId: () => current.projectId });
        const mutation = options.application.executeCore({
          parsed,
          destinationId: 'digital-employee-automation-repository',
          resourceId: `digital_employee_automation:${current.id}`,
          mutateBusinessState: () => {
            const record = options.automations.delete(current.id, parsed.input.expectedRevision);
            audit(options, parsed, 'digital_employee.automation.deleted', 'digital_employee_automation', record.id, { projectId: record.projectId });
            return record;
          },
        });
        await finishMutation(options, mutation.replayed, 'digital_employee.automation.changed', { projectId: current.projectId, automationId: current.id, deleted: true });
        return mutation.result;
      }),
  );

  options.server.post(
    '/api/projects/:projectId/digital-employee-automations/:automationId/run',
    async (request: FastifyRequest<{ Params: { projectId: string; automationId: string }; Body: WorkManagementMutationRequest<Record<string, never>> }>, reply) =>
      runRoute(reply, async () => {
        const current = requireAutomation(options, request.params.projectId, request.params.automationId, reply);
        if (!current) return;
        if (!current.enabled) return reply.code(409).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_DISABLED', message: '自动化规则已停用；启用后才能请求立即运行。' });
        const employee = requireEmployee(options, current.projectId, current.employeeId);
        validateAutomationEmployee(employee!, current.actionKind);
        const parsed = options.application.parse<Record<string, never>>({ value: request.body, commandType: workManagementCommandTypes.digitalEmployeeAutomationRun, scopeKind: 'project', expectedScopeId: () => current.projectId });
        const mutation = options.application.executeCore({
          parsed,
          destinationId: 'digital-employee-automation-repository',
          resourceId: `digital_employee_automation:${current.id}`,
          mutateBusinessState: () => {
            const record = options.automations.advance({ id: current.id, nextRunAt: new Date().toISOString(), lastTriggeredAt: current.lastTriggeredAt ?? current.createdAt });
            audit(options, parsed, 'digital_employee.automation.run_requested', 'digital_employee_automation', record.id, { projectId: record.projectId });
            return record;
          },
        });
        await finishMutation(options, mutation.replayed, 'digital_employee.automation.run_requested', { projectId: current.projectId, automationId: current.id });
        options.kick();
        return reply.code(202).send(mutation.result);
      }),
  );
}

function registerExecutionRoutes(options: DigitalEmployeeRouteOptions): void {
  options.server.post('/api/tasks/:taskId/digital-employee-executions', async (request: FastifyRequest<{ Params: { taskId: string }; Body: WorkManagementMutationRequest<CreateExecutionBody> }>, reply) =>
    runRoute(reply, async () => {
      const task = requireTask(options, request.params.taskId, reply);
      if (!task) return;
      const parsed = options.application.parse<CreateExecutionBody>({
        value: request.body,
        commandType: workManagementCommandTypes.digitalEmployeeExecutionCreate,
        scopeKind: 'task',
        expectedScopeId: () => task.id,
      });
      const employee = requireEmployee(options, task.projectId, parsed.input.employeeId, reply);
      if (!employee) return;
      if (options.isTaskTerminal(task) || task.status === 'completed' || task.status === 'cancelled') {
        return reply.code(409).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_TASK_TERMINAL', message: '终态任务不能创建新的数字员工执行。' });
      }
      if (!employee.enabled) return reply.code(409).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_DISABLED', message: '数字员工已停用，不能接收新任务。' });
      if (options.executions.hasActiveTaskExecution(task.id)) return reply.code(409).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_TASK_ALREADY_ASSIGNED', message: '该任务已有运行中或待交付的数字员工执行。' });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-execution-repository',
        resourceId: `digital_employee_execution:${parsed.operationIdentity}`,
        mutateBusinessState: () => createExecution(options, employee, task.id, parsed.operationIdentity, parsed),
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.execution.changed', { projectId: task.projectId, taskId: task.id, executionId: mutation.result.id });
      options.kick();
      return reply.code(202).send(mutation.result);
    }),
  );

  options.server.post('/api/digital-employee-executions/:executionId/retry', async (request: FastifyRequest<{ Params: { executionId: string }; Body: WorkManagementMutationRequest<Record<string, never>> }>, reply) =>
    runRoute(reply, async () => {
      const current = requireExecution(options, request.params.executionId, reply);
      if (!current) return;
      const parsed = options.application.parse<Record<string, never>>({ value: request.body, commandType: workManagementCommandTypes.digitalEmployeeExecutionRetry, scopeKind: 'task', expectedScopeId: () => current.taskId });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-execution-repository',
        resourceId: `digital_employee_execution:${current.id}`,
        mutateBusinessState: () => {
          const record = options.executions.retry(current.id);
          options.taskEvents.create({ taskId: record.taskId, eventType: 'task.digital_employee.retried', title: '数字员工执行已重新排队', payload: { executionId: record.id, employeeId: record.employeeId, attempt: record.attempt } });
          audit(options, parsed, 'digital_employee.execution.retried', 'digital_employee_execution', record.id, { projectId: record.projectId, taskId: record.taskId, attempt: record.attempt });
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.execution.changed', { projectId: current.projectId, taskId: current.taskId, executionId: current.id });
      options.kick();
      return reply.code(202).send(mutation.result);
    }),
  );

  options.server.post('/api/digital-employee-executions/:executionId/cancel', async (request: FastifyRequest<{ Params: { executionId: string }; Body: WorkManagementMutationRequest<Record<string, never>> }>, reply) =>
    runRoute(reply, async () => {
      const current = requireExecution(options, request.params.executionId, reply);
      if (!current) return;
      const parsed = options.application.parse<Record<string, never>>({ value: request.body, commandType: workManagementCommandTypes.digitalEmployeeExecutionCancel, scopeKind: 'task', expectedScopeId: () => current.taskId });
      const mutation = options.application.executeCore({
        parsed,
        destinationId: 'digital-employee-execution-repository',
        resourceId: `digital_employee_execution:${current.id}`,
        mutateBusinessState: () => {
          const record = options.executions.cancel(current.id);
          options.taskEvents.create({ taskId: record.taskId, eventType: 'task.digital_employee.cancelled', title: '数字员工执行已取消', payload: { executionId: record.id, employeeId: record.employeeId, status: record.status } });
          audit(options, parsed, 'digital_employee.execution.cancelled', 'digital_employee_execution', record.id, { projectId: record.projectId, taskId: record.taskId });
          return record;
        },
      });
      await finishMutation(options, mutation.replayed, 'digital_employee.execution.changed', { projectId: current.projectId, taskId: current.taskId, executionId: current.id });
      return mutation.result;
    }),
  );
}

function createEmployee(options: DigitalEmployeeRouteOptions, projectId: string, id: string, input: CreateEmployeeBody) {
  const templateId = typeof input.templateId === 'string' ? input.templateId : undefined;
  if (templateId) {
    const template = options.templates.getById(templateId);
    if (!template) throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_TEMPLATE_NOT_FOUND', '数字员工模板不存在。');
    return options.employees.createFromTemplate({ projectId, template, overrides: { id, ...(input.overrides ?? {}) } });
  }
  const value = input.overrides ? { ...input.overrides } : { ...input };
  delete (value as { templateId?: unknown }).templateId;
  delete (value as { overrides?: unknown }).overrides;
  return options.employees.create({ ...(value as Omit<CreateDigitalEmployeeInput, 'projectId'>), id, projectId });
}

function createExecution(options: DigitalEmployeeRouteOptions, employee: DigitalEmployeeRecord, taskId: string, operationIdentity: string, parsed: ParsedWorkManagementMutation<CreateExecutionBody>): DigitalEmployeeExecutionRecord {
  const record = options.executions.create({ id: operationIdentity, employee, taskId, source: 'manual', sourceRef: `manual:${operationIdentity}` });
  options.taskEvents.create({
    taskId,
    eventType: 'task.digital_employee.assigned',
    title: '任务已指派给数字员工',
    payload: { executionId: record.id, employeeId: employee.id, employeeName: employee.name, source: record.source, automationId: null },
  });
  audit(options, parsed, 'digital_employee.execution.queued', 'digital_employee_execution', record.id, { projectId: record.projectId, taskId: record.taskId, employeeId: record.employeeId, source: record.source });
  return record;
}

function validateDeployCommand(options: DigitalEmployeeRouteOptions, projectId: string, allowDeploy: boolean, commandId: string | null | undefined): void {
  if (!allowDeploy) return;
  if (!commandId) throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_COMMAND_REQUIRED', '开启自动部署时必须选择项目命令中心里的部署命令。');
  const command = options.commandDefinitions.getById(commandId);
  if (!command || !command.enabled || (command.scope === 'project' && command.projectId !== projectId)) {
    throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_COMMAND_INVALID', '部署命令不存在、已停用或不属于当前项目。');
  }
  if (command.parameters.some((parameter) => parameter.required && parameter.defaultValue === undefined)) {
    throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_DEPLOY_COMMAND_PARAMETERS_REQUIRED', '自动部署命令包含没有默认值的必填参数，不能用于无人值守执行。');
  }
}

function validateAutomationEmployee(employee: DigitalEmployeeRecord, actionKind: CreateDigitalEmployeeAutomationInput['actionKind']): void {
  if (!employee.enabled) throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_DISABLED', '数字员工已停用，不能创建或运行自动化。');
  if (actionKind === 'explore_project' && !employee.autonomousExploration) {
    throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXPLORATION_DISABLED', '数字员工未开启只读自主探索，不能配置项目探索自动化。');
  }
}

function isProjectEventTrigger(value: CreateDigitalEmployeeAutomationInput['triggerKind']): value is Extract<CreateDigitalEmployeeAutomationInput['triggerKind'], 'task_created' | 'task_updated' | 'task_status_changed' | 'code_changed'> {
  return value === 'task_created' || value === 'task_updated' || value === 'task_status_changed' || value === 'code_changed';
}

function requireProject(options: DigitalEmployeeRouteOptions, projectId: string, reply?: FastifyReply) {
  const project = options.projects.getById(projectId);
  if (!project && reply) void reply.code(404).send({ error: 'ZEUS_PROJECT_NOT_FOUND', message: 'Project not found' });
  if (!project && !reply) throw new DigitalEmployeeStoreError('ZEUS_PROJECT_NOT_FOUND', '项目不存在。', { statusCode: 404 });
  return project;
}

function requireTask(options: DigitalEmployeeRouteOptions, taskId: string, reply?: FastifyReply) {
  const task = options.tasks.getById(taskId);
  if (!task && reply) void reply.code(404).send({ error: 'ZEUS_TASK_NOT_FOUND', message: 'Task not found' });
  if (!task && !reply) throw new DigitalEmployeeStoreError('ZEUS_TASK_NOT_FOUND', '任务不存在。', { statusCode: 404 });
  return task;
}

function requireEmployee(options: DigitalEmployeeRouteOptions, projectId: string, employeeId: string, reply?: FastifyReply): DigitalEmployeeRecord | undefined {
  const employee = employeeId ? options.employees.getById(employeeId) : undefined;
  if (!employee || employee.projectId !== projectId) {
    if (reply) void reply.code(404).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', message: '数字员工不存在。' });
    else throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_NOT_FOUND', '数字员工不存在。', { statusCode: 404 });
    return undefined;
  }
  return employee;
}

function requireAutomation(options: DigitalEmployeeRouteOptions, projectId: string, automationId: string, reply?: FastifyReply) {
  const automation = options.automations.getById(automationId);
  if (!automation || automation.projectId !== projectId) {
    if (reply) void reply.code(404).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_NOT_FOUND', message: '数字员工自动化不存在。' });
    else throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_AUTOMATION_NOT_FOUND', '数字员工自动化不存在。', { statusCode: 404 });
    return undefined;
  }
  return automation;
}

function requireExecution(options: DigitalEmployeeRouteOptions, executionId: string, reply?: FastifyReply) {
  const execution = options.executions.getById(executionId);
  if (!execution) {
    if (reply) void reply.code(404).send({ error: 'ZEUS_DIGITAL_EMPLOYEE_EXECUTION_NOT_FOUND', message: '数字员工工作执行不存在。' });
    else throw new DigitalEmployeeStoreError('ZEUS_DIGITAL_EMPLOYEE_EXECUTION_NOT_FOUND', '数字员工工作执行不存在。', { statusCode: 404 });
    return undefined;
  }
  return execution;
}

function audit<TInput extends object>(options: DigitalEmployeeRouteOptions, parsed: ParsedWorkManagementMutation<TInput>, action: string, resourceType: string, resourceId: string, payload: Record<string, unknown>): void {
  options.appendAuditLog({
    actorType: parsed.command.actor.kind,
    ...(parsed.command.actor.id ? { actorRef: parsed.command.actor.id } : {}),
    action,
    resourceType,
    resourceId,
    payload: { commandId: parsed.command.commandId, operationIdentity: parsed.operationIdentity, ...payload },
    createdAt: new Date().toISOString(),
  });
}

async function finishMutation(options: DigitalEmployeeRouteOptions, replayed: boolean, eventType: string, payload: Record<string, unknown>): Promise<void> {
  if (replayed) return;
  options.publishRealtimeEvent(eventType, payload);
  await options.save();
}

async function runRoute(reply: FastifyReply, operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (error) {
    const status = workManagementCommandHttpError(error);
    if (status) return reply.code(status.statusCode).send(status.payload);
    if (error instanceof DigitalEmployeeStoreError) return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    throw error;
  }
}
