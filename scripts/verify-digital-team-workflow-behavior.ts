import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digitalTeamWorkflowSchemaGeneration,
  missingDigitalTeamVerificationCommands,
  validateDigitalTeamWorkflowDefinition,
  type DigitalTeamStructuredResult,
  type DigitalTeamWorkflowDefinition,
} from '../packages/shared/src/digitalTeamWorkflow.js';
import { createZeusDatabase, DigitalEmployeeRepository, DigitalTeamNodeAttemptRepository, DigitalTeamWorkflowRunRepository, DigitalTeamWorkflowTemplateRepository, ProjectRepository, TaskRepository } from '../packages/storage/src/index.js';

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
    const recoveredRun = reopenedRuns.listRecoverable()[0];
    assert(recoveredRun?.controlState === 'paused', '重启后必须恢复暂停控制状态。');
    assert(reopenedAttempts.getCurrentByNode(recoveredRun.id, 'worker_one')?.status === 'prepared', '重启后必须恢复返工尝试。');
  } finally {
    await reopened.close();
  }
  process.stdout.write(`${JSON.stringify({ ok: true, checks: ['validation', 'authority', 'verification-commands', 'snapshot', 'parallel-rework', 'read-only-result', 'late-result', 'restart'] })}\n`);
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
