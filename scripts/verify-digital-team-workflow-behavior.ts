import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DigitalTeamWorkflowCoordinator, type DigitalTeamWorkflowCoordinatorOptions } from '../packages/local-server/src/digitalTeamWorkflowCoordinator.js';
import {
  digitalTeamWorkflowSchemaGeneration,
  legacyDigitalTeamWorkflowSchemaGeneration,
  normalizeDigitalTeamWorkflowDefinition,
  validateDigitalTeamWorkflowDefinition,
  type DigitalTeamEmployeeNode,
  type DigitalTeamStructuredResult,
  type DigitalTeamWorkflowDefinition,
} from '../packages/shared/src/digitalTeamWorkflow.js';
import {
  createZeusDatabase,
  DigitalEmployeeRepository,
  DigitalEmployeeTemplateRepository,
  DigitalTeamNodeAttemptRepository,
  DigitalTeamWorkflowRunRepository,
  DigitalTeamWorkflowTemplateRepository,
  ProjectRepository,
  TaskRepository,
} from '../packages/storage/src/index.js';

/** 探针使用的真实证据摘要。 */
const evidenceSha = 'e'.repeat(64);
/** 探针数据库所在临时目录。 */
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-digital-team-workflow-probe-'));
/** 探针数据库路径。 */
const databasePath = join(probeRoot, 'workflow.db');

try {
  /** 探针使用真实 SQLite 持久化入口。 */
  const database = await createZeusDatabase(databasePath);
  try {
    /** 项目持久化入口。 */
    const projects = new ProjectRepository(database);
    /** 任务持久化入口。 */
    const tasks = new TaskRepository(database);
    /** 数字员工持久化入口。 */
    const employees = new DigitalEmployeeRepository(database);
    /** 全局数字员工模板持久化入口。 */
    const employeeTemplates = new DigitalEmployeeTemplateRepository(database);
    /** 团队模板持久化入口。 */
    const templates = new DigitalTeamWorkflowTemplateRepository(database);
    /** 团队运行持久化入口。 */
    const runs = new DigitalTeamWorkflowRunRepository(database);
    /** 节点尝试持久化入口。 */
    const attempts = new DigitalTeamNodeAttemptRepository(database);
    /** 探针项目。 */
    const project = projects.create({ id: 'project_digital_team_probe', name: '数字团队探针', localPath: join(probeRoot, 'repository') });
    /** 流程节点直接选择的全局数字员工模板。 */
    const employeeTemplate = employeeTemplates.create({
      id: 'digital_employee_template_probe',
      name: '综合员工',
      role: '分析与交付',
      prompt: '完成明确分工。',
      permissionMode: 'read-only',
    });
    /** 项目中的唯一启用实例由运行边界自动解析，不再由用户二次选择。 */
    const employee = employees.createFromTemplate({ projectId: project.id, template: employeeTemplate, overrides: { id: 'employee_digital_team_probe' } });
    /** 单员工定义证明团队不需要开始、结束或其他系统节点。 */
    const singleDefinition = definition([employeeNode('single', employee.id, '独立完成任务')], []);
    assert(validateDigitalTeamWorkflowDefinition(singleDefinition).length === 0, '单员工团队必须可执行。');
    /** 多根定义证明没有上游的员工可直接并行接收原始任务。 */
    const parallelDefinition = definition(
      [employeeNode('root_one', employee.id, '并行分工一'), employeeNode('root_two', employee.id, '并行分工二'), employeeNode('downstream', employee.id, '汇合分工')],
      [
        { id: 'root_one_downstream', source: 'root_one', target: 'downstream' },
        { id: 'root_two_downstream', source: 'root_two', target: 'downstream' },
      ],
    );
    assert(validateDigitalTeamWorkflowDefinition(parallelDefinition).length === 0, '多个根员工和汇合依赖必须可执行。');
    assert(new Set(parallelDefinition.nodes.map((node) => node.data.employeeId)).size === 1, '同一员工必须允许承担多份分工。');
    /** 循环定义验证依赖线只表达可完成的前置关系。 */
    const cyclicDefinition = structuredClone(parallelDefinition);
    cyclicDefinition.edges.push({ id: 'downstream_root_one', source: 'downstream', target: 'root_one' });
    assert(
      validateDigitalTeamWorkflowDefinition(cyclicDefinition).some((issue) => issue.code === 'ZEUS_DIGITAL_TEAM_WORKFLOW_CYCLE'),
      '循环依赖必须被拒绝。',
    );
    /** 旧模板定义用于验证技术节点会折叠为最近员工依赖。 */
    const upgraded = normalizeDigitalTeamWorkflowDefinition(legacyDefinition(employee.id));
    assert(upgraded.schemaGeneration === digitalTeamWorkflowSchemaGeneration, '旧模板必须升级为当前结构。');
    assert(
      upgraded.nodes.every((node) => node.type === 'employee'),
      '升级后只能保留员工节点。',
    );
    assert(upgraded.edges.some((edge) => edge.source === 'planner' && edge.target === 'worker') && upgraded.edges.some((edge) => edge.source === 'worker' && edge.target === 'reviewer'), '旧技术节点必须保留最近员工之间的依赖。');
    /** 空草稿允许保存，但不能标记为可执行。 */
    const emptyTemplate = templates.create({ projectId: project.id, name: '空草稿', description: '', definition: definition([], []) });
    assert(!emptyTemplate.ready, '空草稿只能保存，不能启动。');
    /** 可运行模板冻结纯员工定义。 */
    const template = templates.create({ projectId: project.id, name: '并行团队', description: '', definition: parallelDefinition });
    assert(template.ready && template.definition.nodes.length === 3, '纯员工模板必须可运行。');
    /** 全局模板成员直接引用节点中配置的员工模板身份。 */
    const globalDefinition = definition([employeeNode('global_member', employeeTemplate.id, '全局成员')], []);
    /** 全局模板不写入项目身份。 */
    const globalTemplate = templates.create({ projectId: null, name: '全局团队', description: '', definition: globalDefinition });
    assert(globalTemplate.projectId === null && templates.listGlobal().some((candidate) => candidate.id === globalTemplate.id), '全局团队模板必须独立于项目读取。');
    /** 全局团队运行仍属于明确项目和任务。 */
    const globalTask = tasks.create({ projectId: project.id, title: '验证全局团队绑定', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
    /** 创建运行只提交节点定义，存储边界自动冻结本项目唯一的可执行实例。 */
    const globalRun = runs.create({
      projectId: project.id,
      taskId: globalTask.id,
      templateId: globalTemplate.id,
      templateRevision: globalTemplate.revision,
      definition: globalTemplate.definition,
      taskFacts: { title: globalTask.title },
      baseRevisions: [],
    });
    assert(globalRun.definitionSnapshot.nodes[0]?.type === 'employee' && globalRun.definitionSnapshot.nodes[0].data.employeeId === employee.id, '全局团队运行必须按节点配置自动冻结项目执行员工。');
    /** 并行调度任务。 */
    const parallelTask = tasks.create({ projectId: project.id, title: '验证并行根节点', taskType: 'requirement', description: '两个根员工直接开始。', createdFrom: 'digital-team-probe', sourceContext: {} });
    /** 并行运行从执行态开始，不创建隐藏开始节点。 */
    const parallelRun = runs.create({
      projectId: project.id,
      taskId: parallelTask.id,
      templateId: template.id,
      templateRevision: template.revision,
      definition: template.definition,
      taskFacts: { title: parallelTask.title },
      baseRevisions: [],
    });
    assert(parallelRun.status === 'executing' && attempts.listByRun(parallelRun.id).length === 0, '当前团队运行不能依赖隐藏开始节点。');
    /** 记录调度器实际尝试派发的根员工。 */
    const dispatchedRoots: string[] = [];
    /** 调度器只需走到外部派发边界，探针不启动真实 Provider。 */
    const coordinator = new DigitalTeamWorkflowCoordinator({
      templates,
      runs,
      attempts,
      projects,
      tasks,
      isTaskTerminal: (task) => task.managementStatus === 'done',
      now: () => new Date(),
      save: () => database.save(),
      publish: () => undefined,
      taskWork: {
        createWorkflowWorkItem: async (input: { sourceRef: string }) => {
          /** 来源身份固定包含运行、节点和尝试号。 */
          const nodeId = input.sourceRef.split(':')[2];
          if (nodeId) dispatchedRoots.push(nodeId);
          throw new Error('探针在真实 Provider 派发前停止。');
        },
      },
    } as unknown as DigitalTeamWorkflowCoordinatorOptions);
    await coordinator.processRuns();
    assert(dispatchedRoots.includes('root_one') && dispatchedRoots.includes('root_two'), '所有无上游员工必须直接并行派发。');
    assert(!attempts.getCurrentByNode(parallelRun.id, 'downstream'), '下游员工必须等待全部直接前置成功。');
    runs.update(parallelRun.id, { expectedRevision: runs.getById(parallelRun.id)!.revision, status: 'failed' });
    /** 单员工任务用于验证全部真实员工成功即完成团队。 */
    const singleTask = tasks.create({ projectId: project.id, title: '验证单员工完成', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
    /** 单员工运行。 */
    const singleRun = runs.create({ projectId: project.id, taskId: singleTask.id, definition: singleDefinition, taskFacts: { title: singleTask.title }, baseRevisions: [] });
    completeEmployeeAttempt(attempts, singleRun.id, 'single');
    await coordinator.processRuns();
    assert(runs.getById(singleRun.id)?.status === 'completed', '全部真实员工成功后团队必须完成。');
    await coordinator.close();
    process.stdout.write(
      `${JSON.stringify({ ok: true, checks: ['single-employee', 'parallel-roots', 'dependency-gate', 'same-employee-reuse', 'legacy-collapse', 'empty-draft', 'global-template', 'run-node-employee-resolution', 'all-employees-complete'] })}\n`,
    );
  } finally {
    await database.close();
  }
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

/** 构造当前员工分工。 */
function employeeNode(id: string, employeeId: string, title: string): DigitalTeamEmployeeNode {
  return {
    id,
    type: 'employee',
    position: { x: 120, y: 120 },
    data: {
      title,
      employeeId,
      purpose: 'work',
      executionMode: 'read_only',
      instructions: `完成${title}。`,
      acceptanceCriteria: [`${title}有明确结论`],
      expectedDeliverables: [`${title}成果`],
    },
  };
}

/** 构造当前纯员工编排定义。 */
function definition(nodes: DigitalTeamEmployeeNode[], edges: DigitalTeamWorkflowDefinition['edges']): DigitalTeamWorkflowDefinition {
  return { schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

/** 构造包含技术节点的旧模板定义。 */
function legacyDefinition(employeeId: string): DigitalTeamWorkflowDefinition {
  /** 旧规划员工。 */
  const planner = employeeNode('planner', employeeId, '规划');
  /** 旧执行员工。 */
  const worker = employeeNode('worker', employeeId, '执行');
  /** 旧核对员工。 */
  const reviewer = employeeNode('reviewer', employeeId, '核对');
  return {
    schemaGeneration: legacyDigitalTeamWorkflowSchemaGeneration,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: '开始' } },
      { ...planner, data: { ...planner.data, purpose: 'plan' } },
      { id: 'approval', type: 'human_confirmation', position: { x: 0, y: 0 }, data: { title: '批准', purpose: 'plan_approval', instructions: '' } },
      { ...worker, data: { ...worker.data, executionMode: 'isolated_write' } },
      { id: 'integration', type: 'code_integration', position: { x: 0, y: 0 }, data: { title: '集成', mode: 'merge', instructions: '' } },
      { ...reviewer, data: { ...reviewer.data, purpose: 'verify', executionMode: 'candidate_read_only' } },
      { id: 'end', type: 'end', position: { x: 0, y: 0 }, data: { title: '结束' } },
    ],
    edges: [
      { id: 'start_planner', source: 'start', target: 'planner' },
      { id: 'planner_approval', source: 'planner', target: 'approval' },
      { id: 'approval_worker', source: 'approval', target: 'worker' },
      { id: 'worker_integration', source: 'worker', target: 'integration' },
      { id: 'integration_reviewer', source: 'integration', target: 'reviewer' },
      { id: 'reviewer_end', source: 'reviewer', target: 'end' },
    ],
  };
}

/** 创建并完成一份只读员工结果。 */
function completeEmployeeAttempt(repository: DigitalTeamNodeAttemptRepository, runId: string, nodeId: string): void {
  /** 待执行尝试。 */
  const prepared = repository.create({ runId, nodeId, inputSha256: evidenceSha });
  /** 活动尝试。 */
  const active = repository.update(prepared.id, { expectedRevision: prepared.revision, status: 'active', startedAt: new Date().toISOString() });
  repository.submitResult(active.id, { expectedRevision: active.revision, result: readOnlyResult() });
}

/** 构造符合结构化边界的只读成功结果。 */
function readOnlyResult(): DigitalTeamStructuredResult {
  return {
    outcome: 'succeeded',
    verification: 'not_run',
    summary: '分工完成。',
    evidence: [{ kind: 'artifact', id: 'employee-result', sha256: evidenceSha, status: 'succeeded' }],
    repositoryResults: [],
    verifiedCandidates: [],
    artifactRefs: [],
    remainingIssues: [],
  };
}

/** 在探针中执行最小断言。 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
