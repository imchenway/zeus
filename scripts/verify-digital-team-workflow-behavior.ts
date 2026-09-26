import { DigitalTeamWorkflowCoordinator, type DigitalTeamWorkflowCoordinatorOptions } from '../packages/local-server/src/digitalTeamWorkflowCoordinator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  digitalTeamWorkflowSchemaGeneration,
  digitalTeamExecutionDefinition,
  missingDigitalTeamVerificationCommands,
  normalizeDigitalTeamWorkflowDefinition,
  validateDigitalTeamStructuredPlan,
  validateDigitalTeamWorkflowDefinition,
  type DigitalTeamStructuredResult,
  type DigitalTeamWorkflowDefinition,
} from '../packages/shared/src/digitalTeamWorkflow.js';
import {
  createZeusDatabase,
  DigitalEmployeeRepository,
  DigitalTeamNodeAttemptRepository,
  DigitalTeamWorkflowRunRepository,
  DigitalTeamWorkflowTemplateRepository,
  ProjectRepository,
  TaskRepository,
  TaskWorkPlanningRepository,
  ZeusDatabase,
} from '../packages/storage/src/index.js';
import { migrateDigitalTeamWorkflowSchema } from '../packages/storage/src/digitalTeamWorkflowStore.js';

/** 探针使用的完整 Git 基线提交。 */
const baseSha = 'a'.repeat(40);
/** 第一位员工产出的完整 Git 提交。 */
const workerOneSha = 'b'.repeat(40);
/** 第二位员工产出的完整 Git 提交。 */
const workerTwoSha = 'c'.repeat(40);
/** 集成候选的完整 Git 提交。 */
const candidateSha = 'd'.repeat(40);
/** 探针使用的真实证据摘要。 */
const evidenceSha = 'e'.repeat(64);
/** 探针数据库所在临时目录。 */
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-digital-team-workflow-probe-'));
/** 探针数据库路径。 */
const databasePath = join(probeRoot, 'workflow.db');

try {
  /** 首次打开的真实 SQLite 数据库。 */
  const database = await createZeusDatabase(databasePath);
  try {
    /** 项目持久化入口。 */
    const projects = new ProjectRepository(database);
    /** 任务持久化入口。 */
    const tasks = new TaskRepository(database);
    /** 数字员工持久化入口。 */
    const employees = new DigitalEmployeeRepository(database);
    /** 流程模板持久化入口。 */
    const templates = new DigitalTeamWorkflowTemplateRepository(database);
    /** 流程运行持久化入口。 */
    const runs = new DigitalTeamWorkflowRunRepository(database);
    /** 节点尝试持久化入口。 */
    const attempts = new DigitalTeamNodeAttemptRepository(database);
    /** 探针项目。 */
    const project = projects.create({ id: 'project_digital_team_probe', name: '数字团队探针', localPath: join(probeRoot, 'repository') });
    /** 探针任务。 */
    const task = tasks.create({
      id: 'task_digital_team_probe',
      projectId: project.id,
      title: '验证数字团队闭环',
      taskType: 'requirement',
      description: '验证冻结、返工与恢复。',
      createdFrom: 'digital-team-probe',
      sourceContext: {},
      allowCodeChanges: true,
      allowGitCommit: true,
    });
    /** CTO 数字员工。 */
    const cto = employees.create(employeeInput(project.id, 'employee_cto_probe', 'CTO'));
    /** 第一位开发数字员工。 */
    const workerOne = employees.create(employeeInput(project.id, 'employee_worker_one_probe', '前端开发'));
    /** 第二位开发数字员工。 */
    const workerTwo = employees.create(employeeInput(project.id, 'employee_worker_two_probe', '后端开发'));
    /** 验证数字员工。 */
    const verifier = employees.create(employeeInput(project.id, 'employee_verifier_probe', '验证'));
    /** 能完整覆盖批准、并行汇合、验证和最终验收的画布。 */
    const definition = workflowDefinition({ cto: cto.id, workerOne: workerOne.id, workerTwo: workerTwo.id, verifier: verifier.id });
    assert(validateDigitalTeamWorkflowDefinition(definition).length === 0, '标准流程必须通过共享校验。');
    assert(missingDigitalTeamVerificationCommands(['pnpm build'], ['pwd']).length === 1, '无关成功命令不能冒充真实验证。');
    assert(missingDigitalTeamVerificationCommands(['pnpm build'], ['pnpm build']).length === 0, '精确成功命令必须满足真实验证清单。');
    /** 缺少代码修改和本地提交能力的员工。 */
    const unauthorizedWorker = employees.create({ ...employeeInput(project.id, 'employee_unauthorized_probe', '受限开发'), permissionMode: 'read-only', allowCodeChanges: false, deliveryGrants: { allowCommit: false } });
    /** 结构正确但角色能力不足的流程。 */
    const unauthorizedDefinition = workflowDefinition({ cto: cto.id, workerOne: unauthorizedWorker.id, workerTwo: workerTwo.id, verifier: verifier.id });
    assert(
      captureCode(() => runs.create({ projectId: project.id, taskId: task.id, definition: unauthorizedDefinition, taskFacts: { source: 'authority-probe' }, baseRevisions: [{ repositoryId: project.id, sourceRef: 'main', baseSha }] })) ===
        'ZEUS_DIGITAL_TEAM_EMPLOYEE_AUTHORITY_INCOMPATIBLE',
      '角色能力不足必须在运行冻结事务中被拒绝。',
    );
    /** 删除规划批准连线后的非法画布。 */
    const bypassedDefinition = structuredClone(definition);
    bypassedDefinition.edges = bypassedDefinition.edges.filter((edge) => edge.id !== 'edge_plan_approval_worker_one');
    assert(validateDigitalTeamWorkflowDefinition(bypassedDefinition).length > 0, '绕过规划批准的流程必须被拒绝。');
    /** 保存后的流程模板。 */
    const template = templates.create({ projectId: project.id, name: '标准研发协作', description: '探针模板', definition });
    /** 仅验证运行创建事务，不启动调度器或 Provider。 */
    const coordinator = new DigitalTeamWorkflowCoordinator({
      readOnlyValidation: true,
      templates,
      runs,
      attempts,
      projects,
      tasks,
      isTaskTerminal: (record) => record.managementStatus === 'done',
      now: () => new Date(),
      taskCreation: {
        create: () => {
          throw new Error('已有任务入口不得创建另一任务。');
        },
      },
    } as DigitalTeamWorkflowCoordinatorOptions);
    /** 专门验证已有任务绑定与事实冻结。 */
    const existingTask = tasks.create({ projectId: project.id, title: '现有任务真实标题', description: '现有任务真实说明', taskType: 'requirement', createdFrom: 'digital-team-probe', sourceContext: {} });
    /** 客户端旧标题不得替换服务端任务事实。 */
    const existingInput = {
      taskId: existingTask.id,
      expectedTaskUpdatedAt: existingTask.updatedAt,
      templateId: template.id,
      templateRevision: template.revision,
      title: '不可信标题',
      description: '不可信说明',
      taskFacts: { confirmCommittedBaseline: true, allowGitCommit: true },
    };
    /** 此阶段只覆盖事务，基线预检保持已有读 Git 入口。 */
    const prepared = { templateId: template.id, templateRevision: template.revision, baseRevisions: [{ repositoryId: project.id, sourceRef: 'main', baseSha }], repositories: [] };
    /** 用户发起的可审计创建身份。 */
    const context = { commandId: 'existing-task-command', operationIdentity: 'existing-task-operation', actor: { kind: 'user', id: 'probe' } } as Parameters<typeof coordinator.createRun>[2];
    assert(captureCode(() => coordinator.createRun(project.id, { ...existingInput, expectedTaskUpdatedAt: 'stale' }, context, prepared)) === 'ZEUS_DIGITAL_TEAM_TASK_CONFLICT', '过期任务必须拒绝。');
    assert(captureCode(() => coordinator.createRun('another-project', existingInput, context, { ...prepared })) === 'ZEUS_DIGITAL_TEAM_TEMPLATE_CONFLICT', '跨项目绑定必须拒绝。');
    /** 另一项目的现存任务不能被当前模板接管。 */
    const otherProject = projects.create({ name: '另一项目', localPath: join(probeRoot, 'other') });
    /** 跨项目任务保持独立身份。 */
    const otherTask = tasks.create({ projectId: otherProject.id, title: '另一项目任务', description: '', taskType: 'requirement', createdFrom: 'digital-team-probe', sourceContext: {} });
    assert(
      captureCode(() => coordinator.createRun(project.id, { ...existingInput, taskId: otherTask.id, expectedTaskUpdatedAt: otherTask.updatedAt }, context, prepared)) === 'ZEUS_DIGITAL_TEAM_TASK_NOT_FOUND',
      '不能把其他项目的任务绑定到当前流程。',
    );
    /** 终态任务保持只读，重新打开后才能使用流程。 */
    const closedTask = tasks.create({ projectId: project.id, title: '已结束任务', description: '', taskType: 'requirement', createdFrom: 'digital-team-probe', sourceContext: {}, managementStatus: 'done' });
    assert(captureCode(() => coordinator.createRun(project.id, { ...existingInput, taskId: closedTask.id, expectedTaskUpdatedAt: closedTask.updatedAt }, context, prepared)) === 'ZEUS_DIGITAL_TEAM_TASK_TERMINAL', '终态任务必须拒绝新运行。');
    coordinator.createRun(project.id, existingInput, context, prepared);
    /** 读取真实 SQLite 冻结记录核对身份、事实和权限。 */
    const boundRun = runs.listByTask(existingTask.id)[0];
    assert(boundRun?.taskId === existingTask.id && boundRun.taskFacts.title === existingTask.title && boundRun.taskFacts.description === existingTask.description, '必须复用当前任务并冻结真实内容。');
    assert(boundRun.taskFacts.allowGitCommit === existingTask.allowGitCommit, '客户端不能扩大任务权限。');
    assert(
      (coordinator.listRuns(project.id, existingTask.id) as Array<{ taskId: string }>).every((record) => record.taskId === existingTask.id),
      '任务入口只返回本任务的运行。',
    );
    assert(captureCode(() => coordinator.listRuns(project.id, 'missing-task')) === 'ZEUS_DIGITAL_TEAM_TASK_NOT_FOUND', '任务运行查询必须校验归属。');
    assert(captureCode(() => coordinator.createRun(project.id, existingInput, { ...context, operationIdentity: 'duplicate-task-operation' }, prepared)) === 'ZEUS_DIGITAL_TEAM_TASK_RUNNING', '当前任务的活动运行必须阻止重复创建。');
    /** 隔离后续调度探针，不派发既有研发样例。 */
    runs.update(boundRun.id, { expectedRevision: boundRun.revision, controlState: 'paused' });
    /** 普通报告只配置实际工作与可选人工确认。 */
    const reportDefinition = normalizeDigitalTeamWorkflowDefinition({
      schemaGeneration: digitalTeamWorkflowSchemaGeneration,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'report', type: 'employee', position: { x: 200, y: 100 }, data: { title: '调研报告', employeeId: cto.id, purpose: 'work', executionMode: 'read_only', instructions: '整理已有资料。' } },
        { id: 'accept', type: 'human_confirmation', position: { x: 400, y: 100 }, data: { title: '确认报告', purpose: 'final_acceptance', instructions: '核对实际结论。' } },
      ],
      edges: [{ id: 'report_accept', source: 'report', target: 'accept' }],
    });
    assert(validateDigitalTeamWorkflowDefinition(reportDefinition).length === 0, '普通报告无需研发节点或命令。');
    assert(JSON.stringify(normalizeDigitalTeamWorkflowDefinition(reportDefinition)) === JSON.stringify(reportDefinition), '起止节点补齐必须幂等。');
    /** 运行预检不访问不存在的 Git 仓库，也不要求代码授权。 */
    const reportTemplate = templates.create({ projectId: project.id, name: '报告协作', description: '无 Git 报告探针。', definition: reportDefinition });
    const reportTask = tasks.create({ projectId: project.id, title: '无 Git 的报告协作', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {}, allowCodeChanges: false, allowGitCommit: false });
    const reportInput = { templateId: reportTemplate.id, templateRevision: reportTemplate.revision, taskId: reportTask.id, expectedTaskUpdatedAt: reportTask.updatedAt, title: reportTask.title, description: '', taskFacts: {} };
    const reportPrepared = await coordinator.prepareRun(project.id, reportInput);
    assert(reportPrepared.baseRevisions.length === 0, '普通协作不应冻结 Git 基线。');
    coordinator.createRun(project.id, reportInput, { ...context, operationIdentity: 'report-workflow' }, reportPrepared);
    const reportRun = runs.listByTask(reportTask.id)[0]!;
    completeEmployeeAttempt(attempts, reportRun.id, 'report', readOnlyResult('报告已形成。'), 0);
    /** 使用真实调度入口和 SQLite；没有 Provider 或外部动作。 */
    const runtimeCoordinator = new DigitalTeamWorkflowCoordinator({
      templates,
      runs,
      attempts,
      projects,
      tasks,
      isTaskTerminal: (record) => record.managementStatus === 'done',
      now: () => new Date(),
      save: () => database.save(),
      publish: () => undefined,
      taskWork: {
        createWorkflowWorkItem: async () => {
          throw new Error('探针在外部派发前停止。');
        },
      },
    } as unknown as DigitalTeamWorkflowCoordinatorOptions);
    await runtimeCoordinator.processRuns();
    const rejectedApproval = attempts.getCurrentByNode(reportRun.id, 'accept')!;
    runtimeCoordinator.decideApproval(reportRun.id, { nodeId: 'accept', attempt: rejectedApproval.attempt, expectedRevision: runs.getById(reportRun.id)!.revision, approved: false, reason: '补充报告依据。' }, context);
    assert(attempts.getCurrentByNode(reportRun.id, 'report')?.status === 'invalidated', '报告被退回时必须让实际报告工作返工。');
    completeEmployeeAttempt(attempts, reportRun.id, 'report', readOnlyResult('已补充报告依据。'), 0);
    await runtimeCoordinator.processRuns();
    /** 新确认绑定返工成果，迟到决定不能批准旧报告。 */
    const approval = attempts.getCurrentByNode(reportRun.id, 'accept')!;
    assert(approval.inputSha256 !== rejectedApproval.inputSha256 && approval.attempt === 2, '返工后必须生成不同的确认输入和新尝试。');
    assert(
      captureCode(() => runtimeCoordinator.decideApproval(reportRun.id, { nodeId: 'accept', attempt: rejectedApproval.attempt, expectedRevision: runs.getById(reportRun.id)!.revision, approved: true, reason: '' }, context)) ===
        'ZEUS_DIGITAL_TEAM_APPROVAL_STALE',
      '过期确认必须被拒绝。',
    );
    assert(approval?.status === 'awaiting_approval', '报告完成后应到达人工确认。');
    const approvalInput = { nodeId: 'accept', attempt: approval.attempt, expectedRevision: runs.getById(reportRun.id)!.revision, approved: true, reason: '报告符合要求。' };
    runtimeCoordinator.decideApproval(reportRun.id, approvalInput, context, await runtimeCoordinator.prepareApproval(reportRun.id, approvalInput));
    assert(attempts.getCurrentByNode(reportRun.id, 'accept')?.approval?.boundSha256 === approval.inputSha256, '普通确认必须绑定当前输入，不依赖代码候选。');
    assert(runs.getById(reportRun.id)?.status !== 'completed', '人工确认不能越过结束节点提前完成运行。');
    await runtimeCoordinator.processRuns();
    assert(runs.getById(reportRun.id)?.status === 'completed', '普通协作应按依赖到达结束。');
    /** 冻结成员内可新增分工，汇总必须等待实际新增的成果。 */
    const plannedDefinition = normalizeDigitalTeamWorkflowDefinition({
      schemaGeneration: digitalTeamWorkflowSchemaGeneration,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'leader',
          type: 'employee',
          position: { x: 200, y: 100 },
          data: { title: '负责人', employeeId: cto.id, purpose: 'plan', executionMode: 'read_only', instructions: '', settings: { delegation: { employeeIds: [workerOne.id], maxDepth: 1, maxWorkItems: 2 } } },
        },
        { id: 'collect', type: 'employee', position: { x: 600, y: 100 }, data: { title: '汇总', employeeId: cto.id, purpose: 'summary', executionMode: 'read_only', instructions: '' } },
      ],
      edges: [{ id: 'leader_collect', source: 'leader', target: 'collect' }],
    });
    const addedAssignment = { nodeId: 'research', employeeId: workerOne.id, objective: '核对资料', scope: ['项目资料'], excludedScope: ['外部写入'], acceptanceCriteria: ['列明依据'], expectedDeliverables: ['报告'] };
    const dynamicPlan = { summary: '分配一份调研。', assignments: [addedAssignment] };
    assert(validateDigitalTeamStructuredPlan(plannedDefinition, dynamicPlan).length === 0, '已授权成员可以承担新增分工。');
    assert(validateDigitalTeamStructuredPlan(plannedDefinition, { ...dynamicPlan, assignments: [{ ...addedAssignment, employeeId: workerTwo.id }] }).length > 0, '不能扩大授权成员范围。');
    assert(
      validateDigitalTeamStructuredPlan(plannedDefinition, {
        ...dynamicPlan,
        assignments: [
          { ...addedAssignment, dependencyIds: ['second'] },
          { ...addedAssignment, nodeId: 'second', dependencyIds: ['research'] },
        ],
      }).length > 0,
      '新增分工不能形成循环。',
    );
    const plannedRun = runs.create({ projectId: project.id, taskId: reportTask.id, definition: plannedDefinition, taskFacts: {}, baseRevisions: [] });
    assert(
      plannedRun.roleSnapshots.some((role) => role.employeeId === workerOne.id),
      '新增分工成员必须在启动时冻结。',
    );
    const derived = digitalTeamExecutionDefinition({ ...plannedRun, plan: dynamicPlan });
    assert(
      derived.edges.some((edge) => edge.source === 'research' && edge.target === 'collect'),
      '汇总必须等待新增成果。',
    );
    assert(!plannedRun.definitionSnapshot.nodes.some((node) => node.id === 'research'), '新增分工不能篡改冻结模板。');
    /** 提交与批准计划只保存事实，不解除其他分支的未知结果保护。 */
    const unknownPlan = runs.update(plannedRun.id, { expectedRevision: plannedRun.revision, status: 'outcome_unknown', controlState: 'paused' });
    const submittedPlan = runs.submitPlan(plannedRun.id, { expectedRevision: unknownPlan.revision, plan: dynamicPlan });
    const approvedPlan = runs.approvePlan(plannedRun.id, { expectedRevision: submittedPlan.revision, planSha256: submittedPlan.planSha256!, actorId: 'probe' });
    assert(submittedPlan.status === 'outcome_unknown' && approvedPlan.status === 'outcome_unknown', '计划变化和批准不能恢复未知结果中的运行。');
    /** 同一员工已有两份在途工作时，第三份独立工作仍可进入实际派发预检。 */
    const parallelDefinition = normalizeDigitalTeamWorkflowDefinition({ ...reportDefinition, nodes: [1, 2, 3].map((index) => ({ ...reportDefinition.nodes.find((node) => node.id === 'report')!, id: `parallel_${index}` })), edges: [] });
    const parallelRun = runs.create({ projectId: project.id, taskId: reportTask.id, definition: parallelDefinition, taskFacts: {}, baseRevisions: [] });
    const startAttempt = attempts.create({ runId: parallelRun.id, nodeId: parallelDefinition.nodes.find((node) => node.type === 'start')!.id, inputSha256: evidenceSha });
    const activeStart = attempts.update(startAttempt.id, { expectedRevision: startAttempt.revision, status: 'active' });
    attempts.update(activeStart.id, { expectedRevision: activeStart.revision, status: 'succeeded' });
    for (const nodeId of ['parallel_1', 'parallel_2']) {
      const pending = attempts.create({ runId: parallelRun.id, nodeId, inputSha256: evidenceSha });
      attempts.update(pending.id, { expectedRevision: pending.revision, status: 'active' });
    }
    await runtimeCoordinator.processRuns();
    assert(attempts.getCurrentByNode(parallelRun.id, 'parallel_3')?.status === 'failed', '独立工作不能被历史员工并发值或隐藏的两个名额拦住。');
    runs.update(parallelRun.id, { expectedRevision: runs.getById(parallelRun.id)!.revision, controlState: 'paused' });
    await runtimeCoordinator.close();
    /** 构造旧配方和未启动安排，重跑专属迁移验证持久数据导入与幂等。 */
    const legacyPlanning = new TaskWorkPlanningRepository(database);
    const legacyRecipe = legacyPlanning.saveRecipe({
      id: 'legacy_report_recipe',
      projectId: project.id,
      name: '旧报告配方',
      revision: 0,
      stages: [
        {
          title: '分析',
          description: '整理结论',
          settings: {},
          requiredSkillIds: [],
          advanceMode: 'auto',
          acceptanceMode: 'manual',
          assignments: [{ title: '调研', description: '分析资料', employeeId: cto.id, role: '分析员', settings: { promptOverride: '保留自定义要求' }, required: true, outputKinds: ['document'] }],
        },
      ],
    });
    const legacyTask = tasks.create({ projectId: project.id, title: '旧草稿任务', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
    const legacyPlan = legacyPlanning.save(legacyTask.id, null, legacyRecipe.stages, {});
    await database.save();
    /** 从本探针数据新建迁移前夹具，不删除任何现存数据库的迁移账本或保护触发器。 */
    const fixtureNative = new DatabaseSync(':memory:');
    fixtureNative.exec('PRAGMA foreign_keys = OFF');
    fixtureNative.prepare('ATTACH DATABASE ? AS source').run(databasePath);
    for (const table of database.select<{ name: string; sql: string }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL")) {
      fixtureNative.exec(table.sql);
      const quoted = `"${table.name.replaceAll('"', '""')}"`;
      const historyFilter = table.name === 'schema_migrations' ? " WHERE migration_id NOT IN ('20260926_digital_team_general_workflows', '20260926_employee_arrangements_to_team_templates')" : '';
      fixtureNative.exec(`INSERT INTO ${quoted} SELECT * FROM source.${quoted}${historyFilter}`);
    }
    fixtureNative.exec('PRAGMA foreign_keys = ON');
    assert(fixtureNative.prepare('PRAGMA foreign_key_check').all().length === 0, '迁移前夹具必须保留完整引用。');
    const fixture = new ZeusDatabase(fixtureNative, ':memory:');
    try {
      migrateDigitalTeamWorkflowSchema(fixture);
      const importedTemplates = new DigitalTeamWorkflowTemplateRepository(fixture);
      assert(importedTemplates.getById(`imported_${legacyRecipe.id}`)?.ready, '旧配方应转成可执行模板。');
      assert(
        importedTemplates.getById(`imported_plan_${legacyPlan.id}`)?.definition.nodes.some((node) => node.type === 'employee' && node.data.settings?.promptOverride === '保留自定义要求'),
        '旧草稿应保留本次配置。',
      );
      assert(new TaskWorkPlanningRepository(fixture).get(legacyTask.id)?.state === 'draft', '导入不能启动或覆盖原安排。');
      const importedCount = importedTemplates.listByProject(project.id).length;
      migrateDigitalTeamWorkflowSchema(fixture);
      assert(importedTemplates.listByProject(project.id).length === importedCount, '重复启动不能重复导入模板。');
    } finally {
      await fixture.close();
    }
    /** 创建时冻结画布、角色、任务事实和基线的运行。 */
    let run = runs.create({
      projectId: project.id,
      taskId: task.id,
      templateId: template.id,
      templateRevision: template.revision,
      definition,
      taskFacts: { source: 'probe', confirmCommittedBaseline: true },
      baseRevisions: [{ repositoryId: project.id, sourceRef: 'main', baseSha }],
    });
    employees.update(cto.id, { expectedRevision: cto.revision, name: '已修改 CTO' });
    /** 运行内冻结的 CTO 配置。 */
    const frozenCto = run.roleSnapshots.find((snapshot) => snapshot.employeeId === cto.id)?.configuration;
    assert(frozenCto?.name === cto.name, '运行必须保留创建时的完整角色配置。');
    /** 覆盖两个实现节点的结构化规划。 */
    const plan = {
      summary: '两位开发员工并行实现后汇合。',
      assignments: ['worker_one', 'worker_two'].map((nodeId) => ({
        nodeId,
        objective: `完成 ${nodeId}`,
        scope: ['限定文件'],
        excludedScope: ['目标分支'],
        acceptanceCriteria: ['形成真实提交'],
        expectedDeliverables: ['提交与命令证据'],
      })),
    };
    run = runs.submitPlan(run.id, { expectedRevision: run.revision, plan });
    run = runs.approvePlan(run.id, { expectedRevision: run.revision, planSha256: run.planSha256!, actorId: 'probe_user' });
    /** 第一位开发员工的成功尝试。 */
    const firstWorkerAttempt = completeEmployeeAttempt(attempts, run.id, 'worker_one', writeResult(workerOneSha), run.planVersion);
    /** 第二位开发员工的成功尝试。 */
    const secondWorkerAttempt = completeEmployeeAttempt(attempts, run.id, 'worker_two', writeResult(workerTwoSha), run.planVersion);
    /** 代码集成节点尝试。 */
    const integrationAttempt = attempts.create({ runId: run.id, nodeId: 'integration', inputSha256: evidenceSha, planVersion: run.planVersion });
    /** 进入活动状态的代码集成尝试。 */
    const activeIntegrationAttempt = attempts.update(integrationAttempt.id, { expectedRevision: integrationAttempt.revision, status: 'active', startedAt: new Date().toISOString() });
    /** 已完成的代码集成尝试。 */
    const completedIntegrationAttempt = attempts.update(activeIntegrationAttempt.id, { expectedRevision: activeIntegrationAttempt.revision, status: 'succeeded', completedAt: new Date().toISOString() });
    assert(completedIntegrationAttempt.status === 'succeeded', '代码集成节点必须形成成功尝试。');
    run = runs.update(run.id, { expectedRevision: run.revision, status: 'integrating' });
    run = runs.update(run.id, {
      expectedRevision: run.revision,
      status: 'verifying',
      candidateRevisions: [{ repositoryId: project.id, headSha: candidateSha, workspaceRef: join(probeRoot, 'candidate') }],
    });
    /** 候选验证节点的成功尝试。 */
    const verifyAttempt = completeEmployeeAttempt(attempts, run.id, 'verify', verifyResult(project.id), run.planVersion);
    run = runs.update(run.id, { expectedRevision: run.revision, status: 'summarizing' });
    /** CTO 汇总节点的成功尝试。 */
    const summaryAttempt = completeEmployeeAttempt(attempts, run.id, 'summary', readOnlyResult('CTO 已核对真实结果。'), run.planVersion);
    /** 多个验证分支及等待中的人工确认都不能沿用已替换候选。 */
    const secondVerification = completeEmployeeAttempt(attempts, run.id, 'verify_second', verifyResult(project.id), run.planVersion);
    const candidateApproval = attempts.create({ runId: run.id, nodeId: 'final_approval', inputSha256: evidenceSha, status: 'awaiting_approval' });
    run = runs.update(run.id, { expectedRevision: run.revision, candidateRevisions: [{ repositoryId: project.id, headSha: '9'.repeat(40), workspaceRef: join(probeRoot, 'candidate') }] });
    assert(
      [verifyAttempt, secondVerification, summaryAttempt, candidateApproval].every((attempt) => attempts.getById(attempt.id)?.status === 'invalidated'),
      '候选变化必须使全部复核和确认分支失效。',
    );
    /** 只读工作节点不能把未核对提交注入候选。 */
    const readOnlyDefinition = structuredClone(definition);
    const readOnlyWorker = readOnlyDefinition.nodes.find((node) => node.id === 'worker_one');
    if (readOnlyWorker?.type === 'employee') readOnlyWorker.data.executionMode = 'read_only';
    const readOnlyRun = runs.create({ projectId: project.id, taskId: task.id, definition: readOnlyDefinition, taskFacts: { source: 'read-only-result-probe' }, baseRevisions: [{ repositoryId: project.id, sourceRef: 'main', baseSha }] });
    assert(captureCode(() => completeEmployeeAttempt(attempts, readOnlyRun.id, 'worker_one', writeResult(workerOneSha), 0)) === 'ZEUS_DIGITAL_TEAM_RESULT_INVALID', '只读工作节点不能提交代码版本。');
    runs.update(readOnlyRun.id, { expectedRevision: readOnlyRun.revision, status: 'failed' });
    run = runs.update(run.id, { expectedRevision: run.revision, status: 'awaiting_final_approval' });
    attempts.invalidateCurrentAndDescendants({ runId: run.id, nodeId: 'worker_one', reason: '人工要求第一位员工返工。' });
    assert(attempts.getById(secondWorkerAttempt.id)?.status === 'succeeded', '返工不能破坏未受影响的并行分支。');
    assert(attempts.getById(verifyAttempt.id)?.status === 'invalidated', '返工必须让下游验证失效。');
    assert(attempts.getById(summaryAttempt.id)?.status === 'invalidated', '返工必须让下游汇总失效。');
    run = runs.update(run.id, { expectedRevision: run.revision, status: 'executing', controlState: 'paused', candidateRevisions: [] });
    /** 暂停时可建立但不可被调度的新返工尝试。 */
    const reworkAttempt = attempts.create({ runId: run.id, nodeId: 'worker_one', inputSha256: 'f'.repeat(64), planVersion: run.planVersion });
    assert(reworkAttempt.status === 'prepared', '暂停中的返工只能保持待执行。');
    assert(captureCode(() => attempts.update(firstWorkerAttempt.id, { expectedRevision: firstWorkerAttempt.revision, status: 'failed' })) === 'ZEUS_DIGITAL_TEAM_ATTEMPT_STALE', '迟到结果必须被拒绝。');
    run = runs.update(run.id, { expectedRevision: run.revision, status: 'outcome_unknown' });
    run = runs.update(run.id, { expectedRevision: run.revision, status: 'planning' });
    assert(run.status === 'planning', '人工明确返工后必须能从未知结果回到对应阶段。');
  } finally {
    await database.close();
  }
  /** 重启后重新打开的真实 SQLite 数据库。 */
  const reopened = await createZeusDatabase(databasePath);
  try {
    /** 重启后的运行仓储。 */
    const reopenedRuns = new DigitalTeamWorkflowRunRepository(reopened);
    /** 重启后的尝试仓储。 */
    const reopenedAttempts = new DigitalTeamNodeAttemptRepository(reopened);
    /** 重启后恢复的唯一运行。 */
    const recoveredRun = reopenedRuns.listRecoverable().find((record) => record.taskId === 'task_digital_team_probe');
    assert(recoveredRun?.controlState === 'paused', '重启后必须恢复暂停控制状态。');
    assert(reopenedAttempts.getCurrentByNode(recoveredRun.id, 'worker_one')?.status === 'prepared', '重启后必须恢复返工尝试。');
  } finally {
    await reopened.close();
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, checks: ['validation', 'authority', 'verification-commands', 'snapshot', 'parallel-rework', 'read-only-result', 'late-result', 'existing-task-binding', 'existing-task-conflict', 'existing-task-authority', 'restart', 'no-git-workflow', 'approval-input-binding', 'dependency-completion', 'authorized-planning', 'parallel-dispatch', 'legacy-migration'] })}\n`,
  );
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

/** 构造可运行的项目数字员工。 */
function employeeInput(projectId: string, id: string, role: string) {
  /** 开发角色需要写入和本地提交，验证角色只需要执行验证。 */
  const writesCode = role !== 'CTO' && role !== '验证';
  /** 验证命令需要写构建缓存，但不能修改源码或提交。 */
  const needsWritableSandbox = writesCode || role === '验证';
  return {
    id,
    projectId,
    name: role,
    role,
    prompt: `负责${role}。`,
    enabled: true,
    permissionMode: needsWritableSandbox ? ('auto' as const) : ('read-only' as const),
    allowCodeChanges: writesCode,
    allowTests: role === '验证',
    deliveryGrants: { allowCommit: writesCode },
  };
}

/** 构造完整的双开发节点标准流程。 */
function workflowDefinition(employeeIds: { cto: string; workerOne: string; workerTwo: string; verifier: string }): DigitalTeamWorkflowDefinition {
  /** 节点共用坐标生成器。 */
  const position = (x: number, y: number) => ({ x, y });
  return {
    schemaGeneration: digitalTeamWorkflowSchemaGeneration,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'start', type: 'start', position: position(0, 100), data: { title: '开始' } },
      { id: 'plan', type: 'employee', position: position(180, 100), data: { title: 'CTO 规划', employeeId: employeeIds.cto, purpose: 'plan', executionMode: 'read_only', instructions: '提交结构化规划。' } },
      { id: 'plan_approval', type: 'human_confirmation', position: position(360, 100), data: { title: '批准规划', purpose: 'plan_approval', instructions: '核对范围和权限。' } },
      { id: 'worker_one', type: 'employee', position: position(540, 20), data: { title: '员工一', employeeId: employeeIds.workerOne, purpose: 'work', executionMode: 'isolated_write', instructions: '在独立工作树实现。' } },
      { id: 'worker_two', type: 'employee', position: position(540, 180), data: { title: '员工二', employeeId: employeeIds.workerTwo, purpose: 'work', executionMode: 'isolated_write', instructions: '在独立工作树实现。' } },
      { id: 'integration', type: 'code_integration', position: position(720, 100), data: { title: '候选集成', mode: 'merge', instructions: '只生成任务内候选。' } },
      {
        id: 'verify',
        type: 'employee',
        position: position(900, 100),
        data: { title: '真实验证', employeeId: employeeIds.verifier, purpose: 'verify', executionMode: 'candidate_read_only', instructions: '验证准确候选。', verificationCommands: ['pnpm build'] },
      },
      { id: 'verify_second', type: 'employee', position: position(900, 280), data: { title: '独立复核', employeeId: employeeIds.verifier, purpose: 'verify', executionMode: 'candidate_read_only', instructions: '复核准确候选。' } },
      { id: 'summary', type: 'employee', position: position(1080, 100), data: { title: 'CTO 汇总', employeeId: employeeIds.cto, purpose: 'summary', executionMode: 'read_only', instructions: '复用主会话汇总。' } },
      { id: 'final_approval', type: 'human_confirmation', position: position(1260, 100), data: { title: '最终验收', purpose: 'final_acceptance', instructions: '只验收当前候选。' } },
      { id: 'end', type: 'end', position: position(1440, 100), data: { title: '结束' } },
    ],
    edges: [
      ['start_plan', 'start', 'plan'],
      ['plan_approval', 'plan', 'plan_approval'],
      ['plan_approval_worker_one', 'plan_approval', 'worker_one'],
      ['plan_approval_worker_two', 'plan_approval', 'worker_two'],
      ['worker_one_integration', 'worker_one', 'integration'],
      ['worker_two_integration', 'worker_two', 'integration'],
      ['integration_verify', 'integration', 'verify'],
      ['verify_summary', 'verify', 'summary'],
      ['integration_verify_second', 'integration', 'verify_second'],
      ['verify_second_summary', 'verify_second', 'summary'],
      ['summary_final', 'summary', 'final_approval'],
      ['final_end', 'final_approval', 'end'],
    ].map(([id, source, target]) => ({ id: `edge_${id}`, source, target })),
  };
}

/** 创建、绑定并完成一个员工节点尝试。 */
function completeEmployeeAttempt(repository: DigitalTeamNodeAttemptRepository, runId: string, nodeId: string, result: DigitalTeamStructuredResult, planVersion: number) {
  /** 新节点尝试。 */
  const prepared = repository.create({ runId, nodeId, inputSha256: evidenceSha, planVersion });
  /** 进入活动状态以验证结构化结果和返工状态机；真实绑定由运行协调器专项验收。 */
  const active = repository.update(prepared.id, { expectedRevision: prepared.revision, status: 'active', startedAt: new Date().toISOString() });
  return repository.submitResult(active.id, { expectedRevision: active.revision, result });
}

/** 构造独立写入节点结果。 */
function writeResult(headSha: string): DigitalTeamStructuredResult {
  return { ...readOnlyResult('形成真实代码提交。'), repositoryResults: [{ repositoryId: 'project_digital_team_probe', baseSha, headSha }] };
}

/** 构造候选验证节点结果。 */
function verifyResult(repositoryId: string): DigitalTeamStructuredResult {
  return { ...readOnlyResult('候选验证通过。'), verification: 'passed', verifiedCandidates: [{ repositoryId, headSha: candidateSha }] };
}

/** 构造包含机器证据的只读节点结果。 */
function readOnlyResult(summary: string): DigitalTeamStructuredResult {
  return {
    outcome: 'succeeded',
    verification: 'not_run',
    summary,
    evidence: [{ kind: 'command', id: `command_${summary.length}`, sha256: evidenceSha, status: 'succeeded' }],
    repositoryResults: [],
    verifiedCandidates: [],
    artifactRefs: [],
    remainingIssues: [],
  };
}

/** 捕获业务错误代码。 */
function captureCode(action: () => unknown): string | null {
  try {
    action();
    return null;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null;
  }
}

/** 在探针中执行最小断言。 */
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
