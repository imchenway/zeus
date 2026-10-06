import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareWorkflowCandidate } from '../packages/git-core/src/index.js';
import { DigitalTeamWorkflowCoordinator, type DigitalTeamWorkflowCoordinatorOptions } from '../packages/local-server/src/digitalTeamWorkflowCoordinator.js';
import { createAutomationScheduler } from '../packages/local-server/src/automationScheduler.js';
import { WorkManagementCoreOperations } from '../packages/local-server/src/workManagementCoreOperations.js';
import { migrateEmployeeAutomationsToUnified } from '../packages/storage/src/automationEmployeeMigration.js';
import { migrateDigitalTeamProjectEmployeeReferences } from '../packages/storage/src/digitalTeamWorkflowStore.js';
import type { ZeusDatabasePort } from '../packages/storage/src/databasePort.js';
import {
  digitalTeamWorkflowSchemaGeneration,
  legacyDigitalTeamWorkflowSchemaGeneration,
  normalizeDigitalTeamWorkflowDefinition,
  digitalTeamExecutionDefinition,
  resolveDigitalTeamAssignmentEntry,
  validateDigitalTeamWorkflowDefinition,
  type DigitalTeamEmployeeNode,
  type DigitalTeamStructuredResult,
  type DigitalTeamWorkflowDefinition,
  type DigitalTeamWorkflowRunRecord,
  type DigitalTeamNodeAttemptRecord,
} from '../packages/shared/src/digitalTeamWorkflow.js';
import {
  createZeusDatabase,
  ArtifactStore,
  AutomationTaskRepository,
  AutomationRunRepository,
  ConversationRepository,
  ConversationProviderItemRepository,
  ConversationSubmissionRepository,
  ConversationTurnRepository,
  DigitalEmployeeAutomationRepository,
  DigitalEmployeeRepository,
  DigitalEmployeeTemplateRepository,
  DigitalTeamNodeAttemptRepository,
  DigitalTeamWorkflowRunRepository,
  DigitalTeamWorkflowTemplateRepository,
  DefectWorkflowRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  TaskRepository,
  TaskEnvironmentRepository,
  TaskWorkspaceRepository,
  TaskWorkDeliverableRepository,
  TaskWorkItemRepository,
  TaskWorkRunRepository,
  taskWorkDeliverableArtifactGeneration,
  TaskEventRepository,
  TaskBoardRepository,
  TaskTemplateRepository,
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
    });
    /** 项目中的唯一启用实例由运行边界自动解析，不再由用户二次选择。 */
    const employee = employees.createFromTemplate({ projectId: project.id, template: employeeTemplate, overrides: { id: 'employee_digital_team_probe' } });
    await verifyUnifiedAutomation(database, project.id, employee.id);
    /** 单员工定义证明团队不需要开始、结束或其他系统节点。 */
    const singleDefinition = definition([employeeNode('single', employee.id, '独立完成任务')], []);
    assert(validateDigitalTeamWorkflowDefinition(singleDefinition).length === 0, '单员工团队必须可执行。');
    /** 普通表单不填写研发字段，清空可选标准后仍由共享边界补齐通用结果要求。 */
    const ordinaryDraft = definition(
      [
        {
          ...employeeNode('ordinary', employee.id, '整理任务资料'),
          data: { ...employeeNode('ordinary', employee.id, '整理任务资料').data, instructions: '', acceptanceCriteria: ['  '], expectedDeliverables: [''], verificationCommands: ['\n'] },
        },
      ],
      [],
    );
    /** 与真实模板保存使用同一归一化入口。 */
    const ordinaryTemplate = templates.create({ projectId: project.id, name: '通用流程', description: '', definition: ordinaryDraft });
    /** 未配置研发能力的员工仍保持只读，不隐式开启写代码或代码候选验证。 */
    const ordinaryNode = ordinaryTemplate.definition.nodes[0] as DigitalTeamEmployeeNode;
    assert(ordinaryTemplate.ready && ordinaryNode.data.purpose === 'work' && ordinaryNode.data.executionMode === 'read_only' && !ordinaryNode.data.verificationCommands?.length, '普通分工不得被研发配置或空白标准阻断。');
    /** 表单空白清理不能接纳混入非文本的非法配置。 */
    const malformedDraft = structuredClone(ordinaryDraft);
    (malformedDraft.nodes[0] as DigitalTeamEmployeeNode).data.acceptanceCriteria = ['有效标准', 7] as never;
    assert(validateDigitalTeamWorkflowDefinition(normalizeDigitalTeamWorkflowDefinition(malformedDraft)).length > 0, '非字符串标准必须继续被校验拒绝。');
    /** 历史节点曾保存独立模型偏好，新模板不再复制这些执行默认值。 */
    const oldNodeSettings = { modelOverride: 'legacy-node-model', reasoningEffort: 'high', serviceTier: 'fast', workMode: 'plan' as const, skillIds: ['legacy-skill'], permissionMode: 'read-only' as const };
    /** 使用真实保存入口验证界面隐藏后不会继续保存无入口的配置。 */
    const settingsDefinition = definition([{ ...employeeNode('settings', employee.id, '读取项目默认'), data: { ...employeeNode('settings', employee.id, '读取项目默认').data, settings: oldNodeSettings } }], []);
    /** 保存结果只保留当前权限约束。 */
    const settingsTemplate = templates.create({ projectId: project.id, name: '统一运行默认', description: '', definition: settingsDefinition });
    assert(
      settingsTemplate.ready && JSON.stringify((settingsTemplate.definition.nodes[0] as DigitalTeamEmployeeNode).data.settings) === JSON.stringify({ permissionMode: 'read-only' }),
      '新模板不得保留逐节点模型、推理、速度、工作模式或技能覆盖。',
    );
    /** 冻结运行原样读取；模板归一化不能倒改已经接纳的工作。 */
    const frozenSettings = digitalTeamExecutionDefinition({ definitionSnapshot: settingsDefinition, plan: null, runtimeState: {} });
    assert((frozenSettings.nodes[0] as DigitalTeamEmployeeNode).data.settings?.modelOverride === 'legacy-node-model' && oldNodeSettings.workMode === 'plan', '旧冻结运行必须保留原模型偏好，归一化不能修改输入对象。');
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
    /** 项目当前流程由独立项目副本维护，来源全局模板修改不会联动。 */
    templates.setCurrentByProject(project.id, template.id);
    assert(templates.getCurrentByProject(project.id)?.id === template.id, '项目必须只有明确绑定的当前流程。');
    /** 同一员工重复出现必须明确指派入口，不能按数组顺序猜测。 */
    let ambiguousEntryRejected = false;
    try {
      resolveDigitalTeamAssignmentEntry(parallelDefinition, employee.id);
    } catch {
      ambiguousEntryRejected = true;
    }
    assert(ambiguousEntryRejected, '重复岗位未选择唯一入口时必须拒绝指派。');
    const entryDefinition = structuredClone(parallelDefinition);
    (entryDefinition.nodes[0] as DigitalTeamEmployeeNode).data.assignmentEntry = true;
    assert(resolveDigitalTeamAssignmentEntry(entryDefinition, employee.id).id === 'root_one', '明确入口必须稳定选择对应分工。');
    const entered = digitalTeamExecutionDefinition({ definitionSnapshot: entryDefinition, plan: null, runtimeState: { entryNodeId: 'root_one' } });
    assert(entered.nodes.length === 2 && entered.edges.length === 1 && !entered.nodes.some((node) => node.id === 'root_two'), '中间指派只执行真实入口后继，不制造其他上游成功。');
    /** 职责和候选验证权限不得在归一化时被静默删除。 */
    const roleDefinition = definition(
      [{ ...employeeNode('tester', employee.id, '测试'), data: { ...employeeNode('tester', employee.id, '测试').data, purpose: 'verify', executionMode: 'candidate_read_only', verificationCommands: ['pnpm verify:publish'] } }],
      [],
    );
    const retainedRole = normalizeDigitalTeamWorkflowDefinition(roleDefinition).nodes[0] as DigitalTeamEmployeeNode;
    assert(retainedRole.data.purpose === 'verify' && retainedRole.data.executionMode === 'candidate_read_only' && retainedRole.data.verificationCommands?.[0] === 'pnpm verify:publish', '真实验收配置必须冻结保留。');
    /** 正式缺陷等待修复成果与父流程复验，不能提前人工关单。 */
    const defects = new DefectWorkflowRepository(database);
    const defectTask = tasks.create({ projectId: project.id, parentTaskId: globalTask.id, title: '正式缺陷', taskType: 'defect', description: '复现现有问题。', createdFrom: 'digital-team-probe', sourceContext: {} });
    const formalDefect = defects.register({
      key: 'reproducible-issue',
      title: defectTask.title,
      description: defectTask.description,
      reproductionEvidence: ['command-exact-turn'],
      repositoryId: 'repository-probe',
      headSha: 'a'.repeat(40),
      parentTaskId: globalTask.id,
      defectTaskId: defectTask.id,
      parentRunId: globalRun.id,
      verificationNodeId: 'tester',
      sourceAttemptId: 'attempt-probe',
    });
    let blockedCompletion = false;
    try {
      tasks.assertCanComplete(globalTask.id);
    } catch {
      blockedCompletion = true;
    }
    assert(blockedCompletion, '未验收正式缺陷必须阻止父任务完成。');
    assert(
      defects.consumeRepairRound(globalTask.id, 3) === 1 && defects.consumeRepairRound(globalTask.id, 3) === 2 && defects.consumeRepairRound(globalTask.id, 3) === 3 && defects.consumeRepairRound(globalTask.id, 3) === null,
      '父验收自动修复默认最多三轮。',
    );
    assert(new DefectWorkflowRepository(database).getRepairRounds(globalTask.id) === 3, '重建仓库不能重置父任务修复额度。');
    defects.bindRepair(formalDefect.id, globalRun.id);
    defects.submitRepair(formalDefect.id, globalRun.id, [{ repositoryId: 'repository-probe', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }]);
    assert(defects.listByRun(globalRun.id)[0]?.status === 'awaiting_retest', '修复成果提交后仍需父流程复验。');
    defects.acceptRetest(globalRun.id, 'tester');
    tasks.assertCanComplete(globalTask.id);
    tasks.assertCanComplete(defectTask.id);
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
    await verifyAssignmentResultBoundaries(database, project.id, employee.id);
    await verifyTeamInternalTaskOrigins(database, project.id, employee.id);
    await verifyParallelVerificationRound(database, project.id, employee.id);
    await verifyFinalTaskCompletionGate();
    verifyMigratedProjectEmployeeReferences(database, project.id, employee.id, employeeTemplate.id);
    process.stdout.write(
      `${JSON.stringify({ ok: true, checks: ['single-employee', 'ordinary-empty-optional-fields', 'nontext-criteria-rejected', 'node-execution-defaults-cleared', 'frozen-node-settings-preserved', 'parallel-roots', 'dependency-gate', 'same-employee-reuse', 'legacy-collapse', 'empty-draft', 'global-template', 'run-node-employee-resolution', 'project-current-workflow', 'assignment-entry-gate', 'entry-descendants-only', 'verification-role-retained', 'defect-completion-gate', 'persistent-repair-budget', 'repair-awaits-parent-retest', 'all-employees-complete', 'active-result-reference-shape', 'development-entry-before-verification', 'unverified-code-task-completion-gate', 'rework-during-final-git-review', 'project-state-shared-save-gate', 'read-only-entry-without-unrelated-baseline', 'frozen-entry-after-template-edit', 'parallel-verification-round-budget', 'parallel-repair-relations-recovery', 'parallel-candidate-environments', 'partial-verification-rework-retains-sibling', 'migrated-project-employee-references'] })}\n`,
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

/** 旧全局身份分离后，项目流程继续指向原员工，其他项目及历史运行不变。 */
function verifyMigratedProjectEmployeeReferences(database: ZeusDatabasePort, projectId: string, employeeId: string, globalEmployeeId: string): void {
  /** 真实模板与运行仓储复用正式保存和员工解析入口。 */
  const templates = new DigitalTeamWorkflowTemplateRepository(database);
  /** 冻结运行只读核对，不用当前模板替代历史事实。 */
  const runs = new DigitalTeamWorkflowRunRepository(database);
  /** 新旧任务分别接纳到自己的运行。 */
  const tasks = new TaskRepository(database);
  /** 原项目流程含员工节点和修复员工两处相同全局引用。 */
  const original = { ...definition([employeeNode('identity', globalEmployeeId, '保持项目职责')], []), repairEmployeeId: globalEmployeeId };
  /** 原项目已有独立流程副本。 */
  const local = templates.create({ projectId, name: '身份迁移项目流程', description: '', definition: original });
  templates.setCurrentByProject(projectId, local.id);
  /** 共享模板继续供其他项目使用原全局员工。 */
  const shared = templates.create({ projectId: null, name: '身份迁移共享流程', description: '', definition: original });
  /** 其他项目的独立副本不能被本项目员工差异改变。 */
  const otherProject = new ProjectRepository(database).create({ name: '其他项目职责', localPath: join(probeRoot, 'other-project') });
  /** 相同旧全局引用在另一项目保持原样。 */
  const other = templates.create({ projectId: otherProject.id, name: '其他项目流程', description: '', definition: original });
  /** 已删除模板保留原定义，迁移不能复活或修改。 */
  const deleted = templates.create({ projectId, name: '已删除旧流程', description: '', definition: original });
  templates.delete(deleted.id, deleted.revision);
  /** 旧节点配置按数据库原文保存，专门验证迁移不会顺带归一化删除。 */
  const historical = templates.create({ projectId, name: '旧委派配置', description: '', definition: original });
  /** 历史委派只有准确旧全局引用需要改为原项目员工。 */
  const historicalDefinition = structuredClone(original);
  (historicalDefinition.nodes[0] as DigitalTeamEmployeeNode).data.settings = { modelOverride: 'historical-model', delegation: { employeeIds: [globalEmployeeId, employeeId], maxDepth: 1, maxWorkItems: 2 } };
  database.execute('UPDATE digital_team_workflow_templates SET definition_json=? WHERE id=?', [JSON.stringify(historicalDefinition), historical.id]);
  /** 迁移前已接纳的运行冻结原员工与模板修订。 */
  const oldTask = tasks.create({ projectId, title: '迁移前任务', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
  /** 员工解析应在升级前已经落到原项目员工。 */
  const oldRun = runs.create({ projectId, taskId: oldTask.id, templateId: local.id, templateRevision: local.revision, definition: local.definition, taskFacts: {}, baseRevisions: [] });
  /** 整份运行快照用于核对迁移没有修改历史事实。 */
  const frozen = JSON.stringify(oldRun);
  /** 同一迁移事务使用统一时间，不改变共享来源。 */
  const timestamp = new Date().toISOString();
  migrateDigitalTeamProjectEmployeeReferences(database, { projectId, globalEmployeeId, employeeId }, timestamp);
  /** 原当前流程引用保持不变，模板只增加一次修订。 */
  const migrated = templates.getCurrentByProject(projectId)!;
  assert(
    migrated.id === local.id && migrated.revision === local.revision + 1 && (migrated.definition.nodes[0] as DigitalTeamEmployeeNode).data.employeeId === employeeId && migrated.definition.repairEmployeeId === employeeId,
    '项目流程必须继续使用原员工并失效旧修订。',
  );
  /** 原文读取验证委派引用变化之外的设置完全保留。 */
  const historicalAfter = JSON.parse(database.get<{ definition_json: string }>('SELECT definition_json FROM digital_team_workflow_templates WHERE id=?', [historical.id])!.definition_json) as DigitalTeamWorkflowDefinition;
  assert(
    (historicalAfter.nodes[0] as DigitalTeamEmployeeNode).data.settings?.modelOverride === 'historical-model' && (historicalAfter.nodes[0] as DigitalTeamEmployeeNode).data.settings?.delegation?.employeeIds.every((id) => id === employeeId),
    '旧委派准确引用须迁移，其他历史设置不得丢失。',
  );
  assert(JSON.stringify(templates.getById(shared.id)) === JSON.stringify(shared) && JSON.stringify(templates.getById(other.id)) === JSON.stringify(other), '共享模板和其他项目不得改变。');
  assert(database.get<{ revision: number }>('SELECT revision FROM digital_team_workflow_templates WHERE id=?', [deleted.id])?.revision === deleted.revision + 1, '已删除模板不得被再次改写。');
  assert(JSON.stringify(runs.getById(oldRun.id)) === frozen, '历史运行与角色快照必须原样保留。');
  migrateDigitalTeamProjectEmployeeReferences(database, { projectId, globalEmployeeId, employeeId }, timestamp);
  assert(templates.getById(local.id)?.revision === migrated.revision, '重复身份迁移不得重复增加模板修订。');
  /** 模拟旧有效身份已经成为独立全局员工，原绑定身份不变。 */
  const promoted = new DigitalEmployeeTemplateRepository(database).create({ name: '原项目职责', role: '项目专属', prompt: '保留原项目提示词。' });
  /** 更新来源后再接纳，证明流程不会重新创建原全局员工。 */
  const employees = new DigitalEmployeeRepository(database);
  employees.update(employeeId, { expectedRevision: employees.getById(employeeId)!.revision, globalEmployeeId: promoted.id });
  /** 新任务继续冻结原项目员工的有效职责。 */
  const newTask = tasks.create({ projectId, title: '迁移后任务', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
  /** 保存后的流程从原绑定读取，不再按旧全局身份另建员工。 */
  const newRun = runs.create({ projectId, taskId: newTask.id, templateId: migrated.id, templateRevision: migrated.revision, definition: migrated.definition, taskFacts: {}, baseRevisions: [] });
  assert(
    newRun.roleSnapshots[0]?.employeeId === employeeId && newRun.roleSnapshots[0]?.configuration.prompt === promoted.prompt && !employees.getByGlobalEmployee(projectId, globalEmployeeId),
    '新运行必须沿原绑定执行项目职责，不能按旧全局身份另建员工。',
  );
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

/** 既有专项探针补验动作冻结、流程终态和旧规则原子移交，不启动 Provider。 */
async function verifyAssignmentResultBoundaries(database: ZeusDatabasePort, projectId: string, employeeId: string): Promise<void> {
  /** 本段只核对活动提交与入口预检，不启动 Provider 或执行成果冻结。 */
  const tasks = new TaskRepository(database);
  /** 当前尝试和运行均使用真实 SQLite 仓储。 */
  const runs = new DigitalTeamWorkflowRunRepository(database);
  /** 轮次绑定不能只使用员工或可复用会话。 */
  const attempts = new DigitalTeamNodeAttemptRepository(database);
  /** 当前 Provider 轮次只用于验证动态工具的准确作用域。 */
  const turns = new ConversationTurnRepository(database);
  /** 会话保留实际任务归属。 */
  const conversations = new ConversationRepository(database);
  /** 仓库基线只读取当前工作树，不修改 Git 历史。 */
  const repositories = new ProjectRepositoryRegistrationRepository(database);
  /** 正式规划成果通过现有仓储的验收状态提供。 */
  const deliverables = new TaskWorkDeliverableRepository(database);
  /** 本段员工入口的预检任务。 */
  const task = tasks.create({ projectId, title: '入口和引用形状探针', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {}, allowCodeChanges: true, allowGitCommit: true });
  /** 规划成果本身不包含开发代码身份。 */
  const prior = runs.create({ projectId, taskId: task.id, definition: definition([employeeNode('plan', employeeId, '规划')], []), taskFacts: {}, baseRevisions: [] });
  completeEmployeeAttempt(attempts, prior.id, 'plan');
  /** 正式资料保持工作项和运行外键，不用孤立资料冒充交接。 */
  const workItem = new TaskWorkItemRepository(database).create({
    id: 'probe-planning-item',
    projectId,
    taskId: task.id,
    employeeId,
    source: 'manual',
    sourceRef: null,
    title: '规划资料',
    description: '',
    entrypointKind: 'agent',
    status: 'completed',
  });
  /** 探针工作快照不派发 Provider，只提供正式资料的完整归属。 */
  const workRun = new TaskWorkRunRepository(database).create({
    id: 'probe-planning-work-run',
    projectId,
    taskId: task.id,
    workItemId: workItem.id,
    employeeId,
    attempt: 1,
    status: 'succeeded',
    entrypointKind: 'agent',
    employeeRevision: 0,
    employeeSnapshot: {},
    entrypointSnapshot: {},
    modelSnapshot: null,
    skillSnapshot: {},
    authoritySnapshot: {},
    contextManifest: { version: 1, task: { id: task.id, revision: task.updatedAt, title: task.title, description: '', taskType: task.taskType, tags: [] }, attachments: [], projectRules: [], acceptedDeliverables: [] },
    workspaceSnapshot: null,
    environmentId: null,
  });
  /** 这里只建立正式资料仓储记录，不把探针材料当成 Provider 产物。 */
  const planning = deliverables.create({
    projectId,
    taskId: task.id,
    workItemId: workItem.id,
    runId: workRun.id,
    kind: 'planning',
    title: '正式规划',
    summary: '开发后再测试。',
    artifactSha256: evidenceSha,
    contentSha256: evidenceSha,
    sourceMessageId: null,
  });
  deliverables.transition(planning.id, planning.revision, 'accepted');
  /** 成果身份关联到原规划尝试，且无 repositoryResults。 */
  const planningAttempt = attempts.getCurrentByNode(prior.id, 'plan')!;
  attempts.update(planningAttempt.id, { expectedRevision: planningAttempt.revision, deliverableId: planning.id });
  runs.update(prior.id, { expectedRevision: prior.revision, status: 'completed' });
  /** 三员工序列证明开发的后继测试不能误要求开发入口已有代码。 */
  const flow = definition(
    [
      employeeNode('plan', employeeId, '规划'),
      { ...employeeNode('development', employeeId, '开发'), data: { ...employeeNode('development', employeeId, '开发').data, executionMode: 'isolated_write' } },
      { ...employeeNode('verification', employeeId, '测试'), data: { ...employeeNode('verification', employeeId, '测试').data, purpose: 'verify', executionMode: 'candidate_read_only' } },
    ],
    [
      { id: 'plan-development', source: 'plan', target: 'development' },
      { id: 'development-verification', source: 'development', target: 'verification' },
    ],
  );
  /** 接纳预检使用已保存模板修订。 */
  const template = new DigitalTeamWorkflowTemplateRepository(database).create({ projectId, name: '入口前后继探针', description: '', definition: flow });
  repositories.replaceForProject(projectId, [{ id: 'probe-read-only-repository', name: '当前源码基线', relativePath: '.', localPath: process.cwd() }]);
  /** 准确轮次工具调用的只读节点运行。 */
  const activeTask = tasks.create({ projectId, title: '活跃结果提交探针', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
  /** 活动运行只用只读员工，避免不相关代码门禁。 */
  const activeRun = runs.create({ projectId, taskId: activeTask.id, definition: definition([employeeNode('current', employeeId, '当前员工')], []), taskFacts: {}, baseRevisions: [] });
  /** 已登记会话和任务归属。 */
  const conversation = conversations.create({ projectId, taskId: activeTask.id, title: '活动提交探针' });
  /** 本段固定时钟只用于完整存储字段。 */
  const timestamp = new Date().toISOString();
  /** 尝试与轮次的 submission 外键必须有真实账本记录。 */
  const submission = new ConversationSubmissionRepository(database).createOrGet({
    id: 'probe-submission',
    conversationId: conversation.id,
    idempotencyKey: 'probe-active-input',
    requestHash: evidenceSha,
    clientMessageId: 'probe-active-message',
    kind: 'message',
    requestedDelivery: 'send_now',
    status: 'active',
    input: {},
    createdAt: timestamp,
  });
  /** 当前准确 Provider 轮次。 */
  const turn = turns.upsert({
    conversationId: conversation.id,
    providerThreadId: 'probe-thread',
    providerTurnId: 'probe-turn',
    clientSubmissionId: submission.id,
    status: 'running',
    startedAt: timestamp,
    completedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  /** 工具必须绑定当前节点的准确活动尝试。 */
  const attempt = attempts.create({ runId: activeRun.id, nodeId: 'current', inputSha256: evidenceSha });
  attempts.bindExecution(attempt.id, { expectedRevision: attempt.revision, conversationId: conversation.id, submissionId: submission.id, turnId: turn.id, segmentId: turn.id });
  /** 不派发模型；工具接收成功也只代表待终态核验。 */
  const coordinator = new DigitalTeamWorkflowCoordinator({
    projects: new ProjectRepository(database),
    tasks,
    templates: new DigitalTeamWorkflowTemplateRepository(database),
    runs,
    attempts,
    conversations,
    turns,
    projectRepositories: repositories,
    defects: new DefectWorkflowRepository(database),
    isTaskTerminal: () => false,
    now: () => new Date(),
    save: () => database.save(),
    publish: () => undefined,
    taskWork: { kick: () => undefined },
  } as unknown as DigitalTeamWorkflowCoordinatorOptions);
  /** 项目状态同时约束普通保存和当前流程保存。 */
  const stateCoordinator = new DigitalTeamWorkflowCoordinator({
    ...({
      projects: new ProjectRepository(database),
      tasks,
      templates: new DigitalTeamWorkflowTemplateRepository(database),
      runs,
      attempts,
      isTaskTerminal: () => false,
      validateTaskStatus: (_projectId: string, statusId: string) => ['todo', 'done'].includes(statusId),
      isCompletedTaskStatus: (_projectId: string, statusId: string) => statusId === 'done',
    } as unknown as DigitalTeamWorkflowCoordinatorOptions),
  });
  /** 保存入口不能允许开始即完成，即使只是普通模板。 */
  const invalidState = definition([employeeNode('state', employeeId, '状态门禁')], []);
  (invalidState.nodes[0] as DigitalTeamEmployeeNode).data.startStatusId = 'done';
  for (const save of [
    () => stateCoordinator.saveTemplate(projectId, { name: '非法状态', description: '', definition: invalidState }, 'probe-invalid-state'),
    () =>
      stateCoordinator.saveProjectWorkflow(
        projectId,
        { name: '非法状态', description: '', definition: invalidState, expectedRevision: new DigitalTeamWorkflowTemplateRepository(database).getCurrentByProject(projectId)?.revision },
        'probe-invalid-current-state',
      ),
  ]) {
    let rejected = false;
    try {
      save();
    } catch (error) {
      rejected = (error as { code?: string }).code === 'ZEUS_DIGITAL_TEAM_COMPLETION_STATUS_INVALID';
    }
    assert(rejected, '普通保存和项目保存必须共同拒绝开始即完成。');
  }
  /** 本次只读入口不执行无关的独立代码分支。 */
  const readerGlobal = new DigitalEmployeeTemplateRepository(database).create({ name: '只读分支员工', role: '汇总', prompt: '只读核对。' });
  const reader = new DigitalEmployeeRepository(database).createFromTemplate({ projectId, template: readerGlobal });
  /** 无关开发分支仍由独立员工执行，代码权限只取决于任务与本次运行。 */
  const writerGlobal = new DigitalEmployeeTemplateRepository(database).create({
    name: '独立开发员工',
    role: '开发',
    prompt: '只改授权代码。',
  });
  const writer = new DigitalEmployeeRepository(database).createFromTemplate({ projectId, template: writerGlobal });
  const independent = definition([{ ...employeeNode('writer', writer.id, '独立开发'), data: { ...employeeNode('writer', writer.id, '独立开发').data, executionMode: 'isolated_write' } }, employeeNode('reader', reader.id, '独立汇总')], []);
  const independentTask = tasks.create({ projectId, title: '只读独立入口', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
  const independentTemplate = new DigitalTeamWorkflowTemplateRepository(database).create({ projectId, name: '冻结入口', description: '', definition: independent });
  const independentRun = runs.create({
    projectId,
    taskId: independentTask.id,
    templateId: independentTemplate.id,
    templateRevision: independentTemplate.revision,
    definition: independent,
    taskFacts: {},
    baseRevisions: [],
    runtimeState: { entryNodeId: 'reader', permissionMode: 'read-only' },
  });
  assert(independentRun.baseRevisions.length === 0, '存储必须按实际只读入口判断基线，未执行的开发不能要求仓库。');
  /** 当前模板变为草稿，已经接纳的冻结入口仍可读取。 */
  new DigitalTeamWorkflowTemplateRepository(database).setCurrentByProject(projectId, independentTemplate.id);
  new DigitalTeamWorkflowTemplateRepository(database).update(independentTemplate.id, { expectedRevision: independentTemplate.revision, definition: definition([], []) });
  const frozen = await coordinator.prepareEmployeeAssignment(projectId, { taskId: independentTask.id, employeeId: reader.id, permissionMode: 'full-access' });
  assert(frozen?.existingRunId === independentRun.id && frozen.runtimeState?.permissionMode === 'read-only', '当前模板改为草稿不能阻止旧冻结入口，也不能扩大原只读权限。');
  await stateCoordinator.close();
  /** 真实只读 Git 预检明确确认当前已提交基线；不把本工作树未提交改动纳入成果。 */
  const prepared = await coordinator.prepareRun(projectId, {
    taskId: task.id,
    expectedTaskUpdatedAt: task.updatedAt,
    templateId: template.id,
    templateRevision: template.revision,
    title: task.title,
    description: '',
    taskFacts: { allowCodeChanges: true, allowGitCommit: true, confirmCommittedBaseline: true },
    entryNodeId: 'development',
    inputDeliverableIds: [planning.id],
  });
  assert(prepared.baseRevisions.length === 1, '开发入口已绑定规划时不能因后继测试误要求既有代码身份。');
  /** 输入字段固定来自本段准确 Provider 轮次。 */
  const call = { conversationId: conversation.id, threadId: 'probe-thread', turnId: 'probe-turn', callId: 'probe-result', tool: 'submit_team_result' };
  /** 字符串化引用必须在活跃工具调用时拒绝，不等轮次结束后才失败。 */
  const malformed = await coordinator.workTools.invoke({ ...call, arguments: { ...readOnlyResult(), artifactRefs: [JSON.stringify({ sha256: evidenceSha, owner: { kind: 'task_work_submission', id: 'probe-file' } })] } });
  assert(!malformed.success && attempts.getById(attempt.id)?.result === null, 'JSON 字符串引用必须立即拒绝且不能留下待核验成功。');
  /** 合法对象只接纳到待核验状态，证据真实性继续由终态冻结负责。 */
  const valid = await coordinator.workTools.invoke({ ...call, arguments: { ...readOnlyResult(), artifactRefs: [{ sha256: evidenceSha, owner: { kind: 'task_work_submission', id: 'probe-file' } }] } });
  assert(valid.success && attempts.getById(attempt.id)?.status === 'active' && attempts.getById(attempt.id)?.result?.artifactRefs[0]?.sha256 === evidenceSha, `合法引用对象应在活跃轮次接收但不得提前成功：${JSON.stringify(valid)}。`);
  await coordinator.close();
}

/** 团队直接创建与正式缺陷均走真实 Core，来源不回流自动化且保留实际操作者。 */
async function verifyTeamInternalTaskOrigins(database: ZeusDatabasePort, projectId: string, employeeId: string): Promise<void> {
  /** 当前业务任务与事件存储。 */
  const tasks = new TaskRepository(database);
  /** 核对任务创建的原始持久事件。 */
  const taskEvents = new TaskEventRepository(database);
  /** 核对审计主体，不用系统身份替换用户或员工。 */
  const actors: Array<{ kind: string; id?: string }> = [];
  /** 真实 Core 创建边界与公开任务相同。 */
  const core = new WorkManagementCoreOperations({
    projects: new ProjectRepository(database),
    tasks,
    taskBoards: new TaskBoardRepository(database),
    taskTemplates: new TaskTemplateRepository(database),
    conversations: new ConversationRepository(database),
    resolveDefaultManagementStatus: () => 'planned',
    recordTaskEvent: (input) => {
      taskEvents.create(input);
    },
    appendAuditLog: (input) => {
      actors.push({ kind: input.actorType, id: input.actorRef });
    },
    afterCommit: (callback) => {
      callback();
    },
    publishRealtimeEvent: () => undefined,
  });
  /** 类型限定内部可信端口，公开路由仍只复制 commandId、operationIdentity、actor。 */
  const taskCreation: DigitalTeamWorkflowCoordinatorOptions['taskCreation'] = { create: (input, taskId, context) => core.createUserTask(input, taskId, context) };
  /** 保存当前探针流程。 */
  const templates = new DigitalTeamWorkflowTemplateRepository(database);
  /** 保存团队创建事实。 */
  const runs = new DigitalTeamWorkflowRunRepository(database);
  /** 保存缺陷来源的准确尝试。 */
  const attempts = new DigitalTeamNodeAttemptRepository(database);
  /** 保存正式缺陷与子任务关联。 */
  const defects = new DefectWorkflowRepository(database);
  /** 单员工流程仅核对创建入口。 */
  const flow = definition([employeeNode('internal', employeeId, '来源探针')], []);
  /** 来源探针使用的已保存模板。 */
  const template = templates.create({ projectId, name: '团队内部来源探针', description: '', definition: flow });
  /** 事件规则从当前边界开始，只观察本段新增任务。 */
  const automationTasks = new AutomationTaskRepository(database);
  /** 保存新任务事件的接纳回执。 */
  const automationRuns = new AutomationRunRepository(database);
  /** 同一项目的新任务事件观察者。 */
  const rule = automationTasks.create({
    name: '内部任务不得回流',
    action: { kind: 'employee_work', employeeId },
    prompt: '仅接纳用户新任务',
    projectIds: [projectId],
    modelSourceId: 'codex',
    modelId: 'probe-model',
    triggerKind: 'event',
    triggerConfig: { eventKinds: ['task_created'] },
  });
  /** 只走实际创建边界，不启动 Provider 调度。 */
  const coordinator = new DigitalTeamWorkflowCoordinator({
    projects: new ProjectRepository(database),
    tasks,
    templates,
    runs,
    attempts,
    defects,
    taskCreation,
    isTaskTerminal: () => false,
    save: () => database.save(),
    now: () => new Date(),
    publish: () => undefined,
  } as unknown as DigitalTeamWorkflowCoordinatorOptions);
  /** 用户启动团队时新建任务，由可信团队边界标记内部来源。 */
  const projection = coordinator.createRun(
    projectId,
    { templateId: template.id, templateRevision: template.revision, title: '团队直接创建', description: '', taskFacts: {} },
    { commandId: 'probe-team-source', operationIdentity: 'probe-team-source', actor: { kind: 'user', id: 'probe-user' } },
    { templateId: template.id, templateRevision: template.revision, definition: flow, baseRevisions: [], repositories: [] },
  ) as { run: DigitalTeamWorkflowRunRecord };
  /** 新建任务的冻结运行。 */
  const run = projection.run;
  /** 定向缺陷登记使用的来源尝试。 */
  const attempt = attempts.create({ runId: run.id, nodeId: 'internal', inputSha256: evidenceSha });
  /** 定向核对正式缺陷创建入口，探针不伪造实际 Provider 终态。 */
  const boundary = coordinator as unknown as { registerAttemptDefects(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord, result: DigitalTeamStructuredResult): void };
  boundary.registerAttemptDefects(run, flow.nodes[0] as DigitalTeamEmployeeNode, attempt, {
    ...readOnlyResult(),
    outcome: 'failed',
    verification: 'failed',
    defects: [{ key: 'internal-source-defect', title: '内部缺陷', description: '来源探针', reproductionEvidence: ['fixture'], repositoryId: 'source-fixture', headSha: 'a'.repeat(40) }],
  });
  /** 当前正式缺陷关联的任务身份。 */
  const defectTaskId = defects.listByRun(run.id)[0]!.defectTaskId;
  for (const taskId of [run.taskId, defectTaskId]) {
    /** 正式持久事件必须保留团队来源，不由 worker 被错误推断成 user。 */
    const event = taskEvents.listByTask(taskId).find((entry) => entry.eventType === 'task.created')!;
    /** 从原始 JSON 读取领域来源。 */
    const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;
    assert(payload.source === 'digital_team_workflow' && payload.suppressAutomation === true && JSON.parse(tasks.getById(taskId)!.sourceContextJson).type === 'digital_team_workflow', '团队新建与内部缺陷都必须记录可信来源并抑制自动化。');
  }
  assert(actors[0]?.kind === 'user' && actors[0]?.id === 'probe-user' && actors[1]?.kind === 'worker' && actors[1]?.id === employeeId, '内部来源不能替换实际用户和员工的审计主体。');
  /** 正常自动化过滤读取刚刚生成的真实任务事件。 */
  const scheduler = createAutomationScheduler({
    tasks: automationTasks,
    runs: automationRuns,
    conversations: new ConversationRepository(database),
    submissions: new ConversationSubmissionRepository(database),
    getProject: (id) => new ProjectRepository(database).getById(id),
    ensureTemporaryWorkspace: () => {
      throw new Error('来源探针不创建环境。');
    },
    dispatch: async () => {
      throw new Error('内部任务不应触发派发。');
    },
    save: () => database.save(),
    now: () => new Date().toISOString(),
    publish: () => undefined,
  });
  await scheduler.close();
  assert(automationRuns.listByAutomation(rule.id).length === 0, '团队任务和缺陷不能再次触发新任务自动化。');
  /** 用户正文伪造同名来源不能抑制普通任务事件。 */
  const ordinary = core.createUserTask({ projectId, title: '用户伪造来源仍为用户任务', taskType: 'requirement', sourceContext: { type: 'digital_team_workflow' } }, 'probe-user-spoofed-origin', {
    commandId: 'probe-user-spoofed-origin',
    operationIdentity: 'probe-user-spoofed-origin',
    actor: { kind: 'user', id: 'probe-user' },
  });
  /** 公开创建任务依然记录真实用户来源。 */
  const ordinaryPayload = JSON.parse(taskEvents.listByTask(ordinary.id)[0]!.payloadJson) as Record<string, unknown>;
  assert(ordinaryPayload.source === 'user' && ordinaryPayload.suppressAutomation !== true, '公开用户任务不能通过 sourceContext 冒充内部来源。');
  automationTasks.setStatus(rule.id, 'paused');
  await coordinator.close();
}

/** 并行验收探针只核对真实仓储和协调接纳，不把 fixture 结果当成实际 Provider 交付。 */
async function verifyParallelVerificationRound(database: ZeusDatabasePort, projectId: string, employeeId: string): Promise<void> {
  /** 全部事实由当前真实 SQLite 仓储维护。 */
  const tasks = new TaskRepository(database);
  const runs = new DigitalTeamWorkflowRunRepository(database);
  const attempts = new DigitalTeamNodeAttemptRepository(database);
  const defects = new DefectWorkflowRepository(database);
  /** 两个测试员工检测同一候选，各自报告不同正式问题。 */
  const tests = ['qa_one', 'qa_two'].map((id) => ({ ...employeeNode(id, employeeId, id), data: { ...employeeNode(id, employeeId, id).data, purpose: 'verify' as const, executionMode: 'candidate_read_only' as const } }));
  /** 修复身份在父接纳时明确冻结，代码权限由父任务授权控制。 */
  const repairGlobal = new DigitalEmployeeTemplateRepository(database).create({
    name: '并行修复员工',
    role: '开发',
    prompt: '仅修复准确缺陷。',
  });
  const repair = new DigitalEmployeeRepository(database).createFromTemplate({ projectId, template: repairGlobal });
  const flow = { ...definition(tests, []), repairEmployeeId: repair.id };
  const task = tasks.create({ projectId, title: '并行父验收轮', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {}, allowCodeChanges: true, allowGitCommit: true });
  const run = runs.create({
    projectId,
    taskId: task.id,
    definition: flow,
    taskFacts: { digitalTeamSourceCommandId: 'fixture-source-command' },
    baseRevisions: [{ repositoryId: 'parallel-fixture-repository', sourceRef: 'HEAD', baseSha: 'a'.repeat(40) }],
  });
  /** 使用 fixture 候选身份，本段不会进行物理代码验收。 */
  const candidate = runs.update(run.id, { expectedRevision: run.revision, candidateRevisions: [{ repositoryId: 'parallel-fixture-repository', headSha: 'a'.repeat(40), workspaceRef: 'parallel-fixture-workspace' }] });
  let one = attempts.create({ runId: run.id, nodeId: 'qa_one', inputSha256: evidenceSha });
  let two = attempts.create({ runId: run.id, nodeId: 'qa_two', inputSha256: evidenceSha });
  /** 本轮冻结准确候选与全部参与尝试。 */
  runs.update(run.id, {
    expectedRevision: candidate.revision,
    runtimeState: {
      verificationRound: {
        id: 'parallel-fixture-round',
        candidateSetSha256: candidate.candidateSetSha256!,
        candidates: candidate.candidateRevisions,
        tests: [
          { nodeId: one.nodeId, attemptId: one.id },
          { nodeId: two.nodeId, attemptId: two.id },
        ],
        phase: 'collecting',
        defectIds: [],
        repairRunIds: [],
      },
    },
  });
  /** 只模拟协调接纳前已验真的终态，实际 Provider 验真仍由真实运行覆盖。 */
  const failedResult = (key: string): DigitalTeamStructuredResult => ({
    ...readOnlyResult(),
    outcome: 'failed',
    verification: 'failed',
    defects: [{ key, title: key, description: 'fixture 独立缺陷', reproductionEvidence: ['fixture-command'], repositoryId: 'parallel-fixture-repository', headSha: 'a'.repeat(40) }],
  });
  attempts.update(one.id, { expectedRevision: one.revision, status: 'failed', result: failedResult('parallel-one'), error: { code: 'ZEUS_DIGITAL_TEAM_DEFECTS_FOUND', message: 'fixture' } });
  /** 停止端口仅替代 Provider，当前工作及节点状态仍保存在真实账本。 */
  const workItems = new TaskWorkItemRepository(database);
  /** 定向验证停止成功与明确未知两条路径。 */
  let stopUnknown = false;
  /** 记录实际调用停止端口的准确工作身份。 */
  const stoppedWorkItemIds: string[] = [];
  /** 子任务创建走正常仓储，探针不创建模型轮次。 */
  const coordinator = new DigitalTeamWorkflowCoordinator({
    projects: new ProjectRepository(database),
    tasks,
    templates: new DigitalTeamWorkflowTemplateRepository(database),
    runs,
    attempts,
    defects,
    now: () => new Date(),
    save: () => database.save(),
    publish: () => undefined,
    isTaskTerminal: () => false,
    taskCreation: { create: (input: Record<string, unknown>, taskId: string) => tasks.create({ ...input, id: taskId, createdFrom: 'digital-team-probe' } as Parameters<TaskRepository['create']>[0]) },
    taskWork: {
      kick: () => undefined,
      stopWorkflowWorkItem: async (workItemId: string) => {
        stoppedWorkItemIds.push(workItemId);
        /** 停止发生在 QA 失效前，候选和原通过事实仍完整可核对。 */
        const item = workItems.getById(workItemId)!;
        const activeRun = runs.listByTask(item.taskId)[0]!;
        assert(attempts.getCurrentByNode(activeRun.id, 'qa_one')?.status === 'succeeded' && activeRun.candidateRevisions.length === 1, '必须先停止在途后继再失效旧候选验收。');
        if (stopUnknown) throw new Error('fixture：Provider 停止结果未知。');
        workItems.update(item.id, { expectedRevision: item.revision, status: 'cancelled' });
      },
    },
  } as unknown as DigitalTeamWorkflowCoordinatorOptions);
  /** 定向调用真实接纳边界，避免扫描本探针其他未派发 fixture。 */
  const boundary = coordinator as unknown as {
    settleVerificationRound(run: DigitalTeamWorkflowRunRecord): Promise<boolean>;
    restoreLegacyVerificationRound(run: DigitalTeamWorkflowRunRecord): boolean;
    processRepairResults(run: DigitalTeamWorkflowRunRecord): Promise<boolean>;
  };
  await boundary.settleVerificationRound(runs.getById(run.id)!);
  assert(defects.getRepairRounds(task.id) === 0 && defects.listByRun(run.id).length === 0, '另一测试结果未收齐时不能登记修复或扣费。');
  /** 确定取消的并行测试由用户继续后重验整轮，原失败证据和零预算保持。 */
  const cancelledRound = runs.getById(run.id)!.runtimeState.verificationRound!;
  attempts.update(two.id, { expectedRevision: two.revision, status: 'cancelled' });
  coordinator.controlRun(run.id, { state: 'running', expectedRevision: runs.getById(run.id)!.revision }, { commandId: 'fixture-resume-command', operationIdentity: 'fixture-resume', actor: { kind: 'user', id: 'fixture-user' } });
  assert(
    runs.getById(run.id)?.runtimeState.verificationRound === null && attempts.getById(one.id)?.status === 'invalidated' && attempts.getById(one.id)?.result?.defects?.[0]?.key === 'parallel-one' && defects.getRepairRounds(task.id) === 0,
    '确定取消的验收继续后必须沿原候选重验，不丢失败事实或提前扣修复预算。',
  );
  one = attempts.create({ runId: run.id, nodeId: 'qa_one', inputSha256: evidenceSha });
  two = attempts.create({ runId: run.id, nodeId: 'qa_two', inputSha256: evidenceSha });
  runs.update(run.id, {
    expectedRevision: runs.getById(run.id)!.revision,
    runtimeState: {
      verificationRound: {
        ...cancelledRound,
        id: 'parallel-fixture-resumed-round',
        tests: [
          { nodeId: one.nodeId, attemptId: one.id },
          { nodeId: two.nodeId, attemptId: two.id },
        ],
      },
    },
  });
  attempts.update(one.id, { expectedRevision: one.revision, status: 'failed', result: failedResult('parallel-one'), error: { code: 'ZEUS_DIGITAL_TEAM_DEFECTS_FOUND', message: 'fixture' } });
  /** 实际派发失败的缺项返工保留另一位已发现的缺陷结果及原候选、零预算。 */
  attempts.update(two.id, { expectedRevision: two.revision, status: 'failed', error: { code: 'ZEUS_DIGITAL_TEAM_DISPATCH_FAILED', message: 'fixture 环境占用' } });
  const retainedFailure = JSON.stringify(attempts.getById(one.id));
  const beforePartialRework = runs.getById(run.id)!;
  runs.update(run.id, { expectedRevision: beforePartialRework.revision, controlState: 'paused', error: { code: 'ZEUS_DIGITAL_TEAM_VERIFICATION_INCOMPLETE', message: 'fixture 缺项' } });
  coordinator.requestRework(
    run.id,
    { nodeId: 'qa_two', reason: '只补齐派发失败的测试，保留另一位正式失败。', expectedRevision: runs.getById(run.id)!.revision },
    { commandId: 'fixture-partial-rework-command', operationIdentity: 'fixture-partial-rework', actor: { kind: 'user', id: 'fixture-user' } },
  );
  const resumedRound = runs.getById(run.id)!.runtimeState.verificationRound!;
  assert(
    resumedRound.tests[0]!.attemptId === one.id &&
      resumedRound.tests[1]!.attemptId !== two.id &&
      JSON.stringify(attempts.getById(one.id)) === retainedFailure &&
      runs.getById(run.id)!.candidateSetSha256 === candidate.candidateSetSha256 &&
      defects.getRepairRounds(task.id) === 0,
    '并行缺项返工必须保留同候选另一测试的完整失败事实，不清空整轮或提前扣预算。',
  );
  coordinator.controlRun(
    run.id,
    { state: 'running', expectedRevision: runs.getById(run.id)!.revision },
    { commandId: 'fixture-partial-continue-command', operationIdentity: 'fixture-partial-continue', actor: { kind: 'user', id: 'fixture-user' } },
  );
  two = attempts.create({ id: resumedRound.tests[1]!.attemptId, runId: run.id, nodeId: 'qa_two', inputSha256: evidenceSha });
  attempts.update(two.id, { expectedRevision: two.revision, status: 'failed', result: failedResult('parallel-two'), error: { code: 'ZEUS_DIGITAL_TEAM_DEFECTS_FOUND', message: 'fixture' } });
  await boundary.settleVerificationRound(runs.getById(run.id)!);
  /** 同一父验收轮保留两条正式缺陷和全部修复子流程，但只消耗一次额度。 */
  const admitted = runs.getById(run.id)!;
  assert(defects.getRepairRounds(task.id) === 1 && defects.listByRun(run.id).length === 2 && admitted.runtimeState.verificationRound?.repairRunIds.length === 2, '并行失败必须统一登记两个修复关系，只扣一次预算。');
  const childIds = admitted.runtimeState.verificationRound!.repairRunIds;
  defects.admitRepairRound(run.id, admitted.revision, task.id, 3, admitted.runtimeState);
  assert(defects.getRepairRounds(task.id) === 1, '同一验收轮重复接纳不能重复扣费。');
  coordinator.controlRun(run.id, { state: 'paused', expectedRevision: runs.getById(run.id)!.revision }, { commandId: 'fixture-pause-command', operationIdentity: 'fixture-pause', actor: { kind: 'user', id: 'fixture-user' } });
  assert(
    childIds.every((id) => runs.getById(id)?.controlState === 'paused'),
    '暂停父验收必须覆盖本轮全部修复子流程。',
  );
  /** 复现旧单节点字段覆盖，正式账本和 child parent 应找回另一修复关系，已花预算保持。 */
  const beforeRestore = runs.getById(run.id)!;
  runs.update(run.id, { expectedRevision: beforeRestore.revision, runtimeState: { ...beforeRestore.runtimeState, verificationRound: null, repairVerificationNodeId: 'qa_two', repairRunIds: [childIds[1]!] } });
  assert(
    boundary.restoreLegacyVerificationRound(runs.getById(run.id)!) && runs.getById(run.id)?.runtimeState.verificationRound?.repairRunIds.length === 2 && defects.getRepairRounds(task.id) === 1,
    '旧父字段被覆盖后必须从正式缺陷和子流程找回全关系，不重置预算。',
  );
  /** 顺序验收的旧 QA 后继必须先明确停止，未知时保留整个复验账本。 */
  for (const uncertainStop of [false, true]) {
    stopUnknown = uncertainStop;
    /** 顺序验收的前一 QA 成功不能在后一 QA 修复后继续引用旧候选。 */
    const sequentialTask = tasks.create({ projectId, title: '顺序验收修复复验', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {}, allowCodeChanges: true, allowGitCommit: true });
    /** 保留开发成果，两个 QA 和汇总按照真实顺序重新安排。 */
    const development = employeeNode('development', repair.id, '开发');
    development.data.executionMode = 'isolated_write';
    /** 旧候选测试的后继汇总。 */
    const summary = employeeNode('summary', employeeId, '汇总');
    /** 先前 QA 的独立汇总后继，可在第二份 QA 之前开始执行。 */
    const earlySummary = employeeNode('summary_early', employeeId, '先行汇总');
    /** 开发、两份顺序测试和汇总的合法冻结图。 */
    const sequential = runs.create({
      projectId,
      taskId: sequentialTask.id,
      definition: {
        ...definition(
          [development, ...tests, summary, earlySummary],
          [
            { id: 'development_qa_one', source: development.id, target: tests[0]!.id },
            { id: 'qa_one_qa_two', source: tests[0]!.id, target: tests[1]!.id },
            { id: 'qa_two_summary', source: tests[1]!.id, target: summary.id },
            { id: 'qa_one_summary_early', source: tests[0]!.id, target: earlySummary.id },
          ],
        ),
        repairEmployeeId: repair.id,
      },
      taskFacts: { digitalTeamSourceCommandId: 'fixture-sequential-command' },
      baseRevisions: run.baseRevisions,
    });
    /** 两份顺序测试最初共同引用的准确候选。 */
    const oldCandidate = runs.update(sequential.id, { expectedRevision: sequential.revision, candidateRevisions: candidate.candidateRevisions });
    /** 已完成开发的 fixture 准确结果，保留在复验安排中。 */
    let developmentAttempt = attempts.create({ runId: sequential.id, nodeId: development.id, inputSha256: evidenceSha });
    developmentAttempt = attempts.update(developmentAttempt.id, { expectedRevision: developmentAttempt.revision, status: 'active' });
    attempts.update(developmentAttempt.id, {
      expectedRevision: developmentAttempt.revision,
      status: 'succeeded',
      result: { ...readOnlyResult(), repositoryResults: [{ repositoryId: 'parallel-fixture-repository', baseSha: 'a'.repeat(40), headSha: 'a'.repeat(40) }] },
    });
    /** 先前通过的准确尝试必须完整保留在历史中。 */
    let firstQa = attempts.create({ runId: sequential.id, nodeId: tests[0]!.id, inputSha256: evidenceSha });
    firstQa = attempts.update(firstQa.id, { expectedRevision: firstQa.revision, status: 'active' });
    attempts.update(firstQa.id, { expectedRevision: firstQa.revision, status: 'succeeded', result: readOnlyResult(), verifiedCandidateSetSha256: oldCandidate.candidateSetSha256 });
    /** 在另一 QA 前已接纳的真实工作身份。 */
    const summaryWorkItem = workItems.create({
      id: `fixture_summary_${sequential.id}`,
      projectId,
      taskId: sequentialTask.id,
      employeeId,
      source: 'manual',
      sourceRef: `digital-team:${sequential.id}:${earlySummary.id}:attempt:1`,
      title: '活动汇总 fixture',
      description: '',
      entrypointKind: 'agent',
      status: 'active',
    });
    /** 在途汇总必须保持当前尝试，不能直接标记失效丢失 Provider 归属。 */
    let summaryAttempt = attempts.create({ runId: sequential.id, nodeId: earlySummary.id, inputSha256: evidenceSha });
    summaryAttempt = attempts.update(summaryAttempt.id, { expectedRevision: summaryAttempt.revision, status: 'active', workItemId: summaryWorkItem.id });
    /** 后一份测试发现缺陷，进入本次自动修复。 */
    const secondQa = attempts.create({ runId: sequential.id, nodeId: tests[1]!.id, inputSha256: evidenceSha });
    attempts.update(secondQa.id, { expectedRevision: secondQa.revision, status: 'failed', result: failedResult('sequential-late-defect'), error: { code: 'ZEUS_DIGITAL_TEAM_DEFECTS_FOUND', message: 'fixture' } });
    runs.update(sequential.id, {
      expectedRevision: runs.getById(sequential.id)!.revision,
      runtimeState: {
        verificationRound: {
          id: `fixture-sequential-round:${sequential.id}`,
          candidateSetSha256: oldCandidate.candidateSetSha256!,
          candidates: oldCandidate.candidateRevisions,
          tests: [{ nodeId: secondQa.nodeId, attemptId: secondQa.id }],
          phase: 'collecting',
          defectIds: [],
          repairRunIds: [],
        },
      },
    });
    await boundary.settleVerificationRound(runs.getById(sequential.id)!);
    /** 按旧候选冻结接纳的修复轮。 */
    const repairing = runs.getById(sequential.id)!;
    /** 本轮唯一缺陷子流程。 */
    const repairRunId = repairing.runtimeState.verificationRound!.repairRunIds[0]!;
    /** 使用真实账本模拟已验真的修复终态，不宣称 Provider 验收。 */
    let repairAttempt = attempts.create({ runId: repairRunId, nodeId: 'repair', inputSha256: evidenceSha });
    repairAttempt = attempts.update(repairAttempt.id, { expectedRevision: repairAttempt.revision, status: 'active' });
    attempts.update(repairAttempt.id, {
      expectedRevision: repairAttempt.revision,
      status: 'succeeded',
      result: { ...readOnlyResult(), repositoryResults: [{ repositoryId: 'parallel-fixture-repository', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) }] },
    });
    runs.update(repairRunId, { expectedRevision: runs.getById(repairRunId)!.revision, status: 'completed' });
    /** 停止明确后才安排复验，停止未知则不得清空旧候选和原验收轮。 */
    const repaired = await boundary.processRepairResults(repairing);
    assert(stoppedWorkItemIds.includes(summaryWorkItem.id), '修复收口必须停止前一 QA 的全部在途后继。');
    if (uncertainStop) {
      assert(
        !repaired && attempts.getById(summaryAttempt.id)?.status === 'outcome_unknown' && attempts.getById(firstQa.id)?.status === 'succeeded' && attempts.getById(secondQa.id)?.status === 'failed',
        '停止未知必须保留准确工作归属和原 QA 事实，不失效或重派。',
      );
      assert(
        runs.getById(sequential.id)?.controlState === 'paused' &&
          runs.getById(sequential.id)?.candidateSetSha256 === oldCandidate.candidateSetSha256 &&
          runs.getById(sequential.id)?.runtimeState.verificationRound?.id === repairing.runtimeState.verificationRound?.id &&
          defects.getRepairRounds(sequentialTask.id) === 1,
        '停止未知保留候选、修复轮和原预算，等待明确核对。',
      );
      continue;
    }
    assert(repaired && attempts.getById(summaryAttempt.id)?.status === 'cancelled' && workItems.getById(summaryWorkItem.id)?.status === 'cancelled', '顺序验收在途后继确认停止后才能收口。');
    assert(
      attempts.getById(firstQa.id)?.status === 'invalidated' && attempts.getById(secondQa.id)?.status === 'invalidated' && attempts.getCurrentByNode(sequential.id, development.id)?.status === 'succeeded',
      '修复必须重新安排前后 QA，保留开发成果。',
    );
    assert(
      attempts.getById(firstQa.id)?.verifiedCandidateSetSha256 === oldCandidate.candidateSetSha256 && runs.getById(sequential.id)?.runtimeState.verificationRound === null && defects.getRepairRounds(sequentialTask.id) === 1,
      '旧通过事实保留，复验安排不能再次扣修复预算。',
    );
  }
  await coordinator.close();
}

/** 真实 SQLite 与独立 Git 副本核对完成门禁，轮次材料为探针 fixture，不宣称真实 Provider 验收。 */
async function verifyFinalTaskCompletionGate(): Promise<void> {
  /** 只克隆已提交基线，候选操作留在临时副本，不修改来源仓库历史。 */
  const repositoryPath = join(probeRoot, 'completion-repository');
  execFileSync('git', ['clone', '--shared', '--quiet', '--', process.cwd(), repositoryPath]);
  /** 实际 HEAD 由 Git 返回，不能使用自填代码摘要。 */
  const headSha = execFileSync('git', ['-C', repositoryPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  /** 原克隆分支只作 fixture 工作区身份，不在来源仓库建分支。 */
  const branchName = execFileSync('git', ['-C', repositoryPath, 'branch', '--show-current'], { encoding: 'utf8' }).trim();
  /** 本段独立账本避免其他探针工作进入同一恢复扫描。 */
  const database = await createZeusDatabase(join(probeRoot, 'completion.db'));
  try {
    /** 本段项目、任务、员工、节点及工作区均持久化在真实 SQLite。 */
    const projects = new ProjectRepository(database);
    const tasks = new TaskRepository(database);
    const runs = new DigitalTeamWorkflowRunRepository(database);
    const attempts = new DigitalTeamNodeAttemptRepository(database);
    const workspaces = new TaskWorkspaceRepository(database);
    const environments = new TaskEnvironmentRepository(database);
    const conversations = new ConversationRepository(database);
    const submissions = new ConversationSubmissionRepository(database);
    const turns = new ConversationTurnRepository(database);
    const providerItems = new ConversationProviderItemRepository(database);
    const deliverables = new TaskWorkDeliverableRepository(database);
    const artifacts = new ArtifactStore(database, join(probeRoot, 'completion-artifacts'));
    /** 员工绑定仍按项目唯一身份创建。 */
    const project = projects.create({ name: '完成门禁探针', localPath: repositoryPath });
    const template = new DigitalEmployeeTemplateRepository(database).create({
      name: '门禁员工',
      role: '开发',
      prompt: '核对 fixture。',
    });
    const employee = new DigitalEmployeeRepository(database).createFromTemplate({ projectId: project.id, template });
    /** 真实仓库登记供候选集成读取。 */
    const repositories = new ProjectRepositoryRegistrationRepository(database);
    const repository = repositories.replaceForProject(project.id, [{ name: '临时基线', relativePath: '.', localPath: repositoryPath }])[0]!;
    /** 末端写入配置允许保存，但未经测试绝不能先把任务完成。 */
    const task = tasks.create({
      projectId: project.id,
      title: '未验证写入不可关单',
      taskType: 'requirement',
      description: '',
      createdFrom: 'digital-team-probe',
      sourceContext: {},
      allowCodeChanges: true,
      allowTests: true,
      allowGitCommit: true,
    });
    const writer = employeeNode('writer', employee.id, '仅写入成果');
    writer.data.executionMode = 'isolated_write';
    writer.data.completionStatusId = 'done';
    const run = runs.create({ projectId: project.id, taskId: task.id, definition: definition([writer], []), taskFacts: {}, baseRevisions: [{ repositoryId: repository.id, sourceRef: 'HEAD', baseSha: headSha }] });
    const environment = environments.create({ projectId: project.id, taskId: task.id, rootPath: repositoryPath });
    const workspace = workspaces.create({
      projectId: project.id,
      taskId: task.id,
      environmentId: environment.id,
      repositoryId: repository.id,
      repositoryPath,
      branchName,
      sourceBranch: 'HEAD',
      sourceHeadSha: headSha,
      worktreePath: repositoryPath,
      headSha,
    });
    /** 探针 fixture 的准确会话、输入与终态，均走既有仓储完整登记。 */
    const conversation = conversations.create({ projectId: project.id, taskId: task.id, title: task.title });
    const timestamp = new Date().toISOString();
    const submission = submissions.createOrGet({
      conversationId: conversation.id,
      idempotencyKey: 'completion-fixture',
      requestHash: evidenceSha,
      clientMessageId: 'completion-fixture-message',
      kind: 'message',
      requestedDelivery: 'send_now',
      status: 'active',
      input: {},
      createdAt: timestamp,
    });
    const turn = turns.upsert({
      conversationId: conversation.id,
      providerThreadId: 'completion-fixture-thread',
      providerTurnId: 'completion-fixture-turn',
      clientSubmissionId: submission.id,
      status: 'completed',
      startedAt: timestamp,
      completedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    providerItems.upsertCompleted({
      conversationId: conversation.id,
      turnId: turn.id,
      providerThreadId: turn.providerThreadId!,
      providerTurnId: turn.providerTurnId!,
      providerItemId: 'completion-fixture-result',
      itemType: 'agentMessage',
      phase: 'final_answer',
      payload: {},
      textContent: '真实基线 HEAD 已核对，未执行测试。',
      completedAt: timestamp,
      updatedAt: timestamp,
    });
    /** 正式成果的工作归属不使用不存在的外键。 */
    const item = new TaskWorkItemRepository(database).create({
      id: 'completion-fixture-work-item',
      projectId: project.id,
      taskId: task.id,
      employeeId: employee.id,
      source: 'manual',
      sourceRef: `digital-team:${run.id}:writer:attempt:1`,
      title: task.title,
      description: '',
      entrypointKind: 'agent',
      status: 'active',
    });
    const work = new TaskWorkRunRepository(database).create({
      id: 'completion-fixture-work-run',
      projectId: project.id,
      taskId: task.id,
      workItemId: item.id,
      employeeId: employee.id,
      attempt: 1,
      status: 'active',
      entrypointKind: 'agent',
      employeeRevision: employee.revision,
      employeeSnapshot: {},
      entrypointSnapshot: {},
      modelSnapshot: null,
      skillSnapshot: {},
      authoritySnapshot: {},
      contextManifest: { version: 1, task: { id: task.id, revision: task.updatedAt, title: task.title, description: '', taskType: task.taskType, tags: [] }, attachments: [], projectRules: [], acceptedDeliverables: [] },
      workspaceSnapshot: null,
      environmentId: environment.id,
      conversationId: conversation.id,
    });
    const prepared = attempts.create({ runId: run.id, nodeId: writer.id, inputSha256: evidenceSha });
    const active = attempts.bindExecution(prepared.id, {
      expectedRevision: prepared.revision,
      workItemId: item.id,
      workRunId: work.id,
      conversationId: conversation.id,
      submissionId: submission.id,
      turnId: turn.id,
      segmentId: turn.id,
      environmentId: environment.id,
      workspaceId: workspace.id,
    });
    attempts.update(active.id, { expectedRevision: active.revision, result: { ...readOnlyResult(), evidence: [], repositoryResults: [{ repositoryId: repository.id, baseSha: headSha, headSha }] } });
    /** 仅替代成果冻结边界，正文与接纳记录仍用真实 ArtifactStore/SQLite；不派发模型。 */
    const coordinator = new DigitalTeamWorkflowCoordinator({
      projects,
      tasks,
      runs,
      attempts,
      workspaces,
      environments,
      conversations,
      submissions,
      turns,
      providerItems,
      projectRepositories: repositories,
      defects: new DefectWorkflowRepository(database),
      turnChanges: { getByTurn: () => undefined },
      isTaskTerminal: () => false,
      isCompletedTaskStatus: (_projectId: string, statusId: string) => statusId === 'done',
      advanceTaskStatus: (taskId: string, statusId: string) => tasks.updateManagementStatus(taskId, statusId),
      now: () => new Date(),
      save: () => database.save(),
      publish: () => undefined,
      taskWork: {
        settleWorkflowWorkItem: () => undefined,
        freezeWorkflowDeliverable: async () => {
          /** 本段 fixture 正文固定说明验证仍未运行。 */
          const artifact = await artifacts.putText({
            text: '本探针写入候选未测试。',
            mimeType: 'text/markdown',
            owner: { kind: 'task_work_deliverable', id: 'completion-fixture-deliverable', generationId: taskWorkDeliverableArtifactGeneration, projectId: project.id, conversationId: conversation.id },
          });
          const submitted = deliverables.create({
            id: 'completion-fixture-deliverable',
            projectId: project.id,
            taskId: task.id,
            workItemId: item.id,
            runId: work.id,
            kind: 'team_result',
            title: task.title,
            summary: '未测试。',
            artifactSha256: artifact.sha256,
            contentSha256: artifact.contentSha256,
            sourceMessageId: null,
          });
          const accepted = deliverables.transition(submitted.id, submitted.revision, 'accepted');
          return { deliverableId: accepted.id, deliverableVersion: accepted.version, artifactRef: artifact };
        },
      },
    } as unknown as DigitalTeamWorkflowCoordinatorOptions);
    /** 两个 QA 必须拥有不同工作区和环境，真实 Git 输入仍与同一父候选完全相同。 */
    const qaTask = tasks.create({ projectId: project.id, title: '同候选并行验收环境', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
    const qaNodes = ['qa_left', 'qa_right'].map((id) => ({ ...employeeNode(id, employee.id, id), data: { ...employeeNode(id, employee.id, id).data, purpose: 'verify' as const, executionMode: 'candidate_read_only' as const } }));
    const qaRun = runs.create({ projectId: project.id, taskId: qaTask.id, definition: definition(qaNodes, []), taskFacts: {}, baseRevisions: [{ repositoryId: repository.id, sourceRef: 'HEAD', baseSha: headSha }] });
    const canonicalPrepared = await prepareWorkflowCandidate({ repositoryPath, projectSlug: project.slug, candidateId: 'parallel-fixture-canonical', branchName: 'zeus/parallel-fixture-canonical', baseSha: headSha, upstreamCommitShas: [] });
    assert(canonicalPrepared.state === 'ready' && canonicalPrepared.candidateSha === headSha, '探针父候选必须从真实准确提交创建。');
    const canonicalEnvironment = environments.create({ projectId: project.id, taskId: qaTask.id, rootPath: canonicalPrepared.worktreePath });
    const canonicalWorkspace = workspaces.create({
      projectId: project.id,
      taskId: qaTask.id,
      environmentId: canonicalEnvironment.id,
      repositoryId: repository.id,
      repositoryPath,
      branchName: canonicalPrepared.branchName,
      sourceBranch: 'HEAD',
      sourceHeadSha: headSha,
      worktreePath: canonicalPrepared.worktreePath,
      headSha,
    });
    const qaCandidate = runs.update(qaRun.id, { expectedRevision: qaRun.revision, candidateRevisions: [{ repositoryId: repository.id, headSha, workspaceRef: canonicalWorkspace.id }] });
    const qaAttempts = qaNodes.map((node) => attempts.create({ runId: qaRun.id, nodeId: node.id, inputSha256: evidenceSha }));
    const workspaceBoundary = coordinator as unknown as {
      prepareEmployeeWorkspace(run: DigitalTeamWorkflowRunRecord, node: DigitalTeamEmployeeNode, attempt: DigitalTeamNodeAttemptRecord): Promise<ReturnType<TaskWorkspaceRepository['getById']>>;
    };
    const qaWorkspaces = [];
    for (const [index, node] of qaNodes.entries()) qaWorkspaces.push(await workspaceBoundary.prepareEmployeeWorkspace(qaCandidate, node, qaAttempts[index]!));
    assert(
      qaWorkspaces.every((entry) => entry && entry.environmentId !== canonicalEnvironment.id && entry.worktreePath !== canonicalWorkspace.worktreePath && entry.sourceHeadSha === headSha && entry.headSha === headSha) &&
        qaWorkspaces[0]!.environmentId !== qaWorkspaces[1]!.environmentId &&
        qaWorkspaces[0]!.worktreePath !== qaWorkspaces[1]!.worktreePath,
      '并行候选测试必须按准确同提交准备各自现场，不能共用候选环境占用。',
    );
    /** 同一尝试恢复沿用原身份，两个现场可同时执行真实只读检查。 */
    const recoveredWorkspace = await workspaceBoundary.prepareEmployeeWorkspace(qaCandidate, qaNodes[0]!, qaAttempts[0]!);
    assert(
      recoveredWorkspace?.id === qaWorkspaces[0]!.id && qaWorkspaces.every((entry) => execFileSync('git', ['-C', entry!.worktreePath!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === headSha),
      '恢复不能新增环境，独立验收现场必须保持父候选准确 HEAD。',
    );
    runs.update(qaRun.id, { expectedRevision: runs.getById(qaRun.id)!.revision, controlState: 'paused' });
    try {
      await coordinator.processRuns();
      assert(attempts.getById(active.id)?.status === 'succeeded', `末端写入结果必须经过真实 HEAD/clean 核对并接纳，不能用提交失败掩盖关单门禁：${JSON.stringify(attempts.getById(active.id)?.error)}。`);
      assert(runs.getById(run.id)?.controlState === 'paused' && runs.getById(run.id)?.error?.code === 'ZEUS_DIGITAL_TEAM_FINAL_VERIFICATION_REQUIRED', '未验证代码必须被最终门禁暂停。');
      assert(tasks.getById(task.id)?.managementStatus !== 'done', '接纳写入结果不能在最终验证之前完成任务。');
      /** 第二段只核对实际 Git await 期间发生的正常返工，不再派发节点。 */
      const reworkTask = tasks.create({ projectId: project.id, title: '最终 Git 核对期间返工', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
      const summary = employeeNode('summary', employee.id, '最终汇总');
      summary.data.completionStatusId = 'done';
      const reworkRun = runs.create({ projectId: project.id, taskId: reworkTask.id, definition: definition([summary], []), taskFacts: {}, baseRevisions: [] });
      completeEmployeeAttempt(attempts, reworkRun.id, summary.id);
      /** 另一个任务使用自己的真实 Git 工作区，不复用前一个任务的目录身份。 */
      const reworkPath = join(probeRoot, 'completion-rework-workspace');
      execFileSync('git', ['-C', repositoryPath, 'worktree', 'add', '--quiet', '-b', 'completion-fixture-rework', reworkPath, headSha]);
      const reworkWorkspace = workspaces.create({
        projectId: project.id,
        taskId: reworkTask.id,
        repositoryId: repository.id,
        repositoryPath,
        branchName: 'completion-fixture-rework',
        sourceBranch: 'HEAD',
        sourceHeadSha: headSha,
        worktreePath: reworkPath,
        headSha,
      });
      runs.update(reworkRun.id, { expectedRevision: reworkRun.revision, candidateRevisions: [{ repositoryId: repository.id, headSha, workspaceRef: reworkWorkspace.id }] });
      /** 微任务在工作区返回后、真实异步 Git 完成前请求返工。 */
      const readWorkspace = workspaces.getById.bind(workspaces);
      let reworked = false;
      workspaces.getById = (id) => {
        if (id === reworkWorkspace.id && !reworked) {
          reworked = true;
          queueMicrotask(() =>
            coordinator.requestRework(
              reworkRun.id,
              { expectedRevision: runs.getById(reworkRun.id)!.revision, nodeId: summary.id, reason: 'Git 核对期间正常返工。' },
              { actor: { kind: 'user', id: 'completion-fixture-user' }, commandId: 'completion-fixture-rework' },
            ),
          );
        }
        return readWorkspace(id);
      };
      await coordinator.processRuns();
      assert(reworked && attempts.getCurrentByNode(reworkRun.id, summary.id)?.status === 'invalidated', '实际 Git 核对期间必须发生正常返工。');
      assert(runs.getById(reworkRun.id)?.status !== 'completed' && tasks.getById(reworkTask.id)?.managementStatus !== 'done', '返工后的失效成功快照不能完成任务或流程。');
    } finally {
      await coordinator.close();
    }
  } finally {
    await database.close();
  }
}

/** 既有专项探针补验动作冻结、流程终态和旧规则原子移交，不启动 Provider。 */
async function verifyUnifiedAutomation(database: ZeusDatabasePort, projectId: string, employeeId: string): Promise<void> {
  /** 真实 Core 创建边界核对自动化 payload；不以模拟 dispatch 代替领域校验。 */
  const taskRepository = new TaskRepository(database);
  /** 原始事件由真实存储记录。 */
  const taskEvents = new TaskEventRepository(database);
  /** 本段不启动宿主，只核对 Core 任务事实与必填字段。 */
  const coreOperations = new WorkManagementCoreOperations({
    projects: new ProjectRepository(database),
    tasks: taskRepository,
    taskBoards: new TaskBoardRepository(database),
    taskTemplates: new TaskTemplateRepository(database),
    conversations: new ConversationRepository(database),
    resolveDefaultManagementStatus: () => 'planned',
    recordTaskEvent: (input) => {
      taskEvents.create(input);
    },
    appendAuditLog: () => undefined,
    afterCommit: (callback) => {
      callback();
    },
    publishRealtimeEvent: () => undefined,
  });
  /** 自动化内部任务同样必须显式满足真实 Core 的必填类型和权限。 */
  const coreTask = database.commitCriticalFactSync(() =>
    coreOperations.createUserTask(
      { projectId, title: '自动化 Core 输入探针', taskType: 'requirement', description: '只读员工工作', sourceContext: { type: 'automation', suppressAutomation: true }, allowCodeChanges: false, allowTests: false, allowGitCommit: false },
      'probe_automation_core_task',
      { commandId: 'probe-automation-core', operationIdentity: 'probe-automation-core', actor: { kind: 'system', id: 'automation-scheduler' } },
    ),
  );
  assert(coreTask.taskType === 'requirement' && !coreTask.allowCodeChanges && !coreTask.allowTests && !coreTask.allowGitCommit, '自动化内部任务必须经真实 Core 接纳合法类型并保持只读。');
  /** 直接使用真实 SQLite 定义和运行回执。 */
  const automationTasks = new AutomationTaskRepository(database);
  /** 自动化运行持久化入口。 */
  const automationRuns = new AutomationRunRepository(database);
  /** 员工动作在定义修订中冻结。 */
  const automation = automationTasks.create({ name: '员工动作探针', prompt: '完成明确范围', projectIds: [projectId], modelSourceId: 'codex', modelId: 'probe-model', action: { kind: 'project_task', employeeId } });
  automationTasks.update(automation.id, { expectedRevision: automation.revision, action: { kind: 'employee_work', employeeId } });
  assert(automationTasks.getRevision(automation.currentRevisionId)?.snapshot.action.kind === 'project_task', '修改动作不能改写已冻结修订。');
  /** 一次运行包含两份流程引用，首个完成不足以结算。 */
  const run = automationRuns.enqueue({ automationId: automation.id, projectIds: [projectId], triggerKind: 'manual', triggerIdentity: 'probe-whole-workflow', scheduledAt: new Date().toISOString() });
  automationRuns.markDispatching(run.id);
  automationRuns.markExecuting(run.id, [
    { kind: 'workflow', id: 'probe_completed_workflow', taskId: coreTask.id },
    { kind: 'workflow', id: 'probe_running_workflow', taskId: coreTask.id },
  ]);
  /** 探针不发起模型请求，只读取编排关联状态。 */
  const schedulerOptions = {
    tasks: automationTasks,
    runs: automationRuns,
    conversations: new ConversationRepository(database),
    submissions: new ConversationSubmissionRepository(database),
    getProject: (id: string) => new ProjectRepository(database).getById(id),
    ensureTemporaryWorkspace: () => {
      throw new Error('探针不创建临时工作区。');
    },
    dispatch: async () => {
      throw new Error('探针不启动 Provider。');
    },
    save: async () => undefined,
    now: () => new Date().toISOString(),
    publish: () => undefined,
  };
  /** 第二份引用仍运行时保留串行边界。 */
  const waiting = createAutomationScheduler({ ...schedulerOptions, readExecution: (reference) => ({ status: reference.id === 'probe_completed_workflow' ? 'completed' : 'running' }) });
  await waiting.close();
  assert(automationRuns.getById(run.id)?.status === 'running', '首个流程完成不能提前结算。');
  /** 所有引用完成才结算运行。 */
  const completed = createAutomationScheduler({ ...schedulerOptions, readExecution: () => ({ status: 'completed' }) });
  await completed.close();
  assert(automationRuns.getById(run.id)?.status === 'succeeded', '全部流程完成应结算。');
  /** 任务后续变化不能替换原事件事实。 */
  const task = new TaskRepository(database).create({ projectId, title: '事件事实探针', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
  new TaskEventRepository(database).create({ taskId: task.id, eventType: 'task.management_status.changed', title: '状态事实', payload: { from: 'planned', to: 'review', source: 'manual' } });
  assert(
    automationTasks.listTriggerEvents(projectId, 0).some((event) => event.taskId === task.id && event.payload.from === 'planned' && event.payload.to === 'review'),
    '必须读取原事件的前后状态。',
  );
  assert(Array.isArray(automationTasks.listCodeTriggerEvents(projectId, 0)), '旧代码规则必须继续读取原 snapshot 事件流。');
  /** 迁移前建立旧规则和已消费回执。 */
  const legacyRules = new DigitalEmployeeAutomationRepository(database);
  /** 原游标和排程应原样移交。 */
  const legacy = legacyRules.create({ projectId, employeeId, name: '旧员工规则探针', triggerKind: 'interval', triggerConfig: { intervalMinutes: 60 }, actionKind: 'assign_task', actionConfig: {} }, { initialCursorSequence: 7 });
  legacyRules.recordEventReceipt({ automationId: legacy.id, eventIdentity: 'task_event:already_consumed', executionId: null, createdAt: new Date().toISOString() });
  migrateEmployeeAutomationsToUnified(database);
  assert(automationTasks.getById(legacy.id)?.eventCursors[projectId] === 7 && automationTasks.getById(legacy.id)?.nextRunAt === legacy.nextRunAt, '迁移必须保持游标与排程。');
  assert(legacyRules.getById(legacy.id)?.enabled === false && automationRuns.listByAutomation(legacy.id).length === 1, '调度权只移交一次，旧回执不能重新入队。');
  migrateEmployeeAutomationsToUnified(database);
  assert(automationRuns.listByAutomation(legacy.id).length === 1, '重复启动不能重复迁移。');
  assert(automationTasks.getById(legacy.id)?.action.taskSelection === 'pool', '旧领取规则必须保留任务池策略，不能转成新建任务。');
  /** 已删除的迁移目标保持退役，重复调度不复活也不丢失历史回执。 */
  automationTasks.delete(legacy.id);
  migrateEmployeeAutomationsToUnified(database);
  migrateEmployeeAutomationsToUnified(database);
  assert(!automationTasks.getById(legacy.id) && legacyRules.getById(legacy.id)?.enabled === false && automationRuns.listByAutomation(legacy.id).length === 1, '删除迁移规则后重复迁移必须保留删除语义和历史运行。');
  /** 未编辑的错误迁移通过新修订更正，已编辑定义只暂停核对。 */
  for (const edited of [false, true]) {
    /** 与旧迁移原字段一致的定义，模拟已经交付的错误迁移。 */
    const old = legacyRules.create({ projectId, employeeId, name: `错误迁移探针${edited}`, triggerKind: 'interval', triggerConfig: { intervalMinutes: 60 }, actionKind: 'assign_task', actionConfig: {} });
    /** 旧员工有效身份用于建立可证明的原结果。 */
    const employee = new DigitalEmployeeRepository(database).getById(employeeId)!;
    /** 保留错误折叠的原配置，不提前写正确策略。 */
    const incorrect = automationTasks.create({
      id: old.id,
      name: old.name,
      prompt: employee.prompt,
      projectIds: [projectId],
      modelSourceId: 'codex',
      modelId: employee.model ?? 'employee-default',
      permissionMode: employee.permissionMode,
      action: { kind: 'project_task', employeeId: employee.globalEmployeeId ?? employee.id, taskId: null, title: old.name, useEventTask: false },
    });
    if (edited) automationTasks.update(incorrect.id, { expectedRevision: incorrect.revision, prompt: '用户已经编辑的说明' });
    migrateEmployeeAutomationsToUnified(database);
    /** 用户编辑内容不能被自动更正覆盖。 */
    const checked = automationTasks.getById(incorrect.id)!;
    assert(
      edited ? checked.prompt === '用户已经编辑的说明' && checked.status === 'paused' && !!checked.migrationIssue : checked.action.taskSelection === 'pool' && checked.revision === 1,
      '错误迁移仅更正未经编辑的原定义，其余明确暂停核对。',
    );
  }
  /** 独立事件流序号不能比较大小，同事务替换新流当前边界。 */
  const eventRule = automationTasks.create({
    name: '事件流切换探针',
    action: { kind: 'employee_work', employeeId },
    prompt: '仅处理新事件',
    projectIds: [projectId],
    modelSourceId: 'codex',
    modelId: 'probe-model',
    triggerKind: 'event',
    triggerConfig: { eventKinds: ['task_updated'] },
  });
  automationTasks.setEventCursor(eventRule.id, projectId, 1_000);
  /** 原代码流保留二十号历史边界。 */
  database.execute('INSERT INTO git_snapshots (rowid, id, task_id, project_id, snapshot_type, status_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    20,
    'probe_code_boundary',
    task.id,
    projectId,
    'checkpoint',
    '{}',
    new Date().toISOString(),
  ]);
  /** 保存代码规则后不能沿用任务流的一千号游标。 */
  const codeRule = automationTasks.update(eventRule.id, { expectedRevision: eventRule.revision, triggerConfig: { eventKinds: ['code_changed'] } });
  assert(codeRule.eventCursors[projectId] === 20, '切换到代码事件必须替换为代码流当前边界。');
  database.execute('INSERT INTO git_snapshots (rowid, id, task_id, project_id, snapshot_type, status_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    21,
    'probe_new_code_event',
    task.id,
    projectId,
    'checkpoint',
    '{}',
    new Date().toISOString(),
  ]);
  assert(automationTasks.listCodeTriggerEvents(projectId, codeRule.eventCursors[projectId]!).length === 1, '新代码二十一号必须可见且不能补跑历史快照。');
  /** 同流仅修改名称不得跨过还没消费的新事件。 */
  const namedRule = automationTasks.update(codeRule.id, { expectedRevision: codeRule.revision, name: '只改名称' });
  assert(namedRule.eventCursors[projectId] === 20, '同流普通编辑不能重置游标。');
  /** 反向切换同样采用当前任务事件流边界。 */
  const taskRule = automationTasks.update(codeRule.id, { expectedRevision: namedRule.revision, triggerConfig: { eventKinds: ['task_updated'] } });
  assert(taskRule.eventCursors[projectId] !== 20 && taskRule.eventCursors[projectId] !== 1_000, '切回任务事件不能继续代码流或旧任务流游标。');
  automationTasks.setStatus(taskRule.id, 'paused');
  /** 首项目业务已接纳但自动化引用尚未记账的真实 SQLite 中断现场。 */
  const secondProject = new ProjectRepository(database).create({ name: '跨项目中断探针', localPath: join(probeRoot, 'automation-second') });
  /** 后续项目任务采用准确归属。 */
  const secondTask = taskRepository.create({ projectId: secondProject.id, title: '第二目标', taskType: 'requirement', description: '', createdFrom: 'digital-team-probe', sourceContext: {} });
  /** 一次运行冻结两个项目。 */
  const crossRule = automationTasks.create({ name: '逐目标恢复探针', prompt: '保留准确原身份', projectIds: [projectId, secondProject.id], modelSourceId: 'codex', modelId: 'probe-model', action: { kind: 'employee_work', employeeId } });
  /** 原触发与原尝试在中断后保持同一身份。 */
  const cross = automationRuns.enqueue({ automationId: crossRule.id, projectIds: [projectId, secondProject.id], triggerKind: 'manual', triggerIdentity: 'probe-partial-before-accounting', scheduledAt: new Date().toISOString() });
  automationRuns.markDispatching(cross.id);
  /** 首目标冻结后才进入业务接纳。 */
  const firstTarget = automationRuns.ensureDispatchTargets(cross.id).dispatchTargets[0]!;
  automationRuns.updateDispatchTarget(cross.id, { ...firstTarget, taskId: coreTask.id, employeeId, status: 'accepting' });
  /** 实际来源工作已经存在，模拟退出发生在返回引用前。 */
  const acceptedItem = new TaskWorkItemRepository(database).create({
    id: 'probe_accounting_work_item',
    projectId,
    taskId: coreTask.id,
    employeeId,
    source: 'automation',
    sourceRef: `${employeeId}:${firstTarget.sourceRef}`,
    title: '已接纳未记账',
    description: '',
    entrypointKind: 'agent',
    status: 'queued',
  });
  /** 正式工作运行具有真实持久身份，本探针不调用 Provider。 */
  const acceptedWork = new TaskWorkRunRepository(database).create({
    id: 'probe_accounting_work_run',
    projectId,
    taskId: coreTask.id,
    workItemId: acceptedItem.id,
    employeeId,
    attempt: 1,
    status: 'prepared',
    entrypointKind: 'agent',
    employeeRevision: 0,
    employeeSnapshot: {},
    entrypointSnapshot: {},
    modelSnapshot: null,
    skillSnapshot: {},
    authoritySnapshot: {},
    contextManifest: {},
    workspaceSnapshot: null,
    environmentId: null,
  });
  new TaskWorkItemRepository(database).update(acceptedItem.id, { currentRunId: acceptedWork.id });
  /** 统计实际恢复派发，只允许第二目标进入回调。 */
  let restoredDispatches = 0;
  const restored = createAutomationScheduler({
    ...schedulerOptions,
    prepareAction: async ({ project }) => ({ taskId: project.id === projectId ? coreTask.id : secondTask.id, employeeId }),
    dispatchAction: async ({ project, target }) => {
      restoredDispatches += 1;
      assert(project.id === secondProject.id, '首目标已有正式接纳，不能再次派发。');
      return { kind: 'workflow', id: 'probe_restored_second_workflow', taskId: target.taskId! };
    },
    readExecution: () => ({ status: 'completed' }),
  });
  await restored.close();
  /** 第一个引用存在时不提前结算，第二项目准确补齐。 */
  const restoredRun = automationRuns.getById(cross.id)!;
  assert(
    restoredDispatches === 1 && restoredRun.status === 'running' && restoredRun.executionReferences.length === 2 && !!restoredRun.dispatchCompletedAt && restoredRun.dispatchTargets.every((target) => target.status === 'accepted'),
    '恢复必须补齐全部目标且不重派已接纳项目。',
  );
  assert(restoredRun.dispatchTargets[0]?.reference?.id === acceptedWork.id, '中断对账必须恢复原工作引用。');
  /** 所有真实引用完成后下一轮才允许成功。 */
  const reconciled = createAutomationScheduler({ ...schedulerOptions, readExecution: () => ({ status: 'completed' }) });
  await reconciled.close();
  assert(automationRuns.getById(cross.id)?.status === 'succeeded', '完整范围及全部工作成功后才结算。');
  /** 所有目标均无可领取项时，明确记录没有执行工作。 */
  const noWork = automationRuns.enqueue({ automationId: crossRule.id, projectIds: [projectId, secondProject.id], triggerKind: 'manual', triggerIdentity: 'probe-no-eligible', scheduledAt: new Date().toISOString() });
  const emptyScheduler = createAutomationScheduler({
    ...schedulerOptions,
    prepareAction: async () => null,
    dispatchAction: async () => {
      throw new Error('无可领取对象不得进入业务派发。');
    },
  });
  await emptyScheduler.close();
  const emptyReconcile = createAutomationScheduler(schedulerOptions);
  await emptyReconcile.close();
  assert(automationRuns.getById(noWork.id)?.status === 'blocked' && automationRuns.getById(noWork.id)?.executionReferences.length === 0, '没有执行工作不能展示交付成功。');
  /** 已误报成功的存量部分运行追加核对结论，不静默补派剩余目标。 */
  const incorrectRun = automationRuns.enqueue({ automationId: crossRule.id, projectIds: [projectId, secondProject.id], triggerKind: 'manual', triggerIdentity: 'probe-old-partial-success', scheduledAt: new Date().toISOString() });
  automationRuns.markDispatching(incorrectRun.id);
  automationRuns.markExecuting(incorrectRun.id, [{ kind: 'task_work', id: acceptedWork.id, taskId: coreTask.id }]);
  /** 模拟旧程序错误结算，保留其原完成时间。 */
  const originalCompletedAt = automationRuns.setTerminal(incorrectRun.id, 'succeeded').completedAt;
  const legacyRecheck = createAutomationScheduler(schedulerOptions);
  await legacyRecheck.close();
  /** 历史错误会显露未知与准确未接纳范围。 */
  const incomplete = automationRuns.getById(incorrectRun.id)!;
  assert(
    incomplete.status === 'outcome_unknown' && incomplete.dispatchReconciliation?.previousStatus === 'succeeded' && incomplete.completedAt === originalCompletedAt && incomplete.executionReferences[0]?.id === acceptedWork.id,
    '存量部分成功必须保留原引用和结论核对历史。',
  );
  automationRuns.resumeDispatch(incorrectRun.id);
  /** 明确恢复后只接纳剩余项目，首项目引用始终不变。 */
  let resumedDispatches = 0;
  const explicitResume = createAutomationScheduler({
    ...schedulerOptions,
    prepareAction: async () => ({ taskId: secondTask.id, employeeId }),
    dispatchAction: async ({ target }) => {
      resumedDispatches += 1;
      assert(target.projectId === secondProject.id, '明确恢复也不能重派原已接纳项目。');
      return { kind: 'workflow', id: 'probe_explicitly_resumed_workflow', taskId: target.taskId! };
    },
  });
  await explicitResume.close();
  assert(
    resumedDispatches === 1 && automationRuns.getById(incorrectRun.id)?.executionReferences[0]?.id === acceptedWork.id && automationRuns.getById(incorrectRun.id)?.dispatchReconciliation?.previousStatus === 'succeeded',
    '恢复沿原运行补齐且保留误报历史。',
  );
}
