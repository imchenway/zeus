import { fileURLToPath } from 'node:url';
import { createZeusPluginMcpBroker } from '../packages/local-server/src/zeusPluginMcpBroker.js';
import { invokeWorkflowPluginTool } from '../packages/local-server/src/workflowToolAdapter.js';
import type { PluginActivationState } from '../packages/local-server/src/zeusPluginService.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createZeusDatabase,
  ProjectRepository,
  TaskRepository,
  DigitalTeamWorkflowRunRepository,
  DigitalTeamNodeAttemptRepository,
  DigitalTeamWorkflowTemplateRepository,
  DigitalEmployeeRepository,
  DigitalEmployeeTemplateRepository,
} from '../packages/storage/src/index.js';
import {
  digitalTeamWorkflowSchemaGeneration,
  normalizeDigitalTeamWorkflowDefinition,
  validateDigitalTeamWorkflowDefinition,
  type DigitalTeamNode,
  type DigitalTeamWorkflowDefinition,
  type WorkflowValue,
} from '../packages/shared/src/index.js';
import { WorkflowPrimitiveRuntime } from '../packages/local-server/src/workflowPrimitiveRuntime.js';
import { DigitalTeamWorkflowCoordinator, type DigitalTeamWorkflowCoordinatorOptions } from '../packages/local-server/src/digitalTeamWorkflowCoordinator.js';

/** 本专项使用临时真实 SQLite、真实 LangGraph 和受控能力端口，不连接用户业务系统。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-1035-workflow-'));
/** 实际完成的集成验收项。 */
const checks: string[] = [];
/** 验收失败立即保留明确原因。 */
function check(value: unknown, message: string): void {
  if (!value) throw new Error(message);
  checks.push(message);
}
/** 在同一测试时钟下验证期限与重启恢复，不使用阻塞等待。 */
let clock = Date.parse('2026-11-12T04:00:00Z');
/** 临时数据库由当前仓库的真实迁移入口创建。 */
let db = await createZeusDatabase(join(root, 'workflow.sqlite'));
/** 每次重开都重新创建仓储与运行器，不复用内存检查点。 */
let runs = new DigitalTeamWorkflowRunRepository(db);
/** 所有节点结果都保存到真实尝试账本。 */
let attempts = new DigitalTeamNodeAttemptRepository(db);
/** 本轮工具端口的实际调用次数。 */
let toolCalls = 0;
/** 工具端口可控地返回结果或模拟接纳后的断连。 */
let toolUnknown = false;
/** 模拟真实网络等待，不阻塞其他运行。 */
let toolDelay: Promise<void> | undefined;
/** 受控员工端口只核对准确输入和结构化交接，不冒充实际模型执行。 */
let agentCalls = 0;
/** 可替换为真实 MCP broker 的集成端口。 */
let externalTool: Parameters<typeof invokeWorkflowPluginTool>[0] | undefined;
/** 临时项目与任务均使用生产仓储创建。 */
const project = new ProjectRepository(db).create({ name: '工作流原语集成验收', localPath: root });
/** 创建可持久化的图定义。 */
function graph(nodes: DigitalTeamNode[], edges: Array<[string, string]> = []): DigitalTeamWorkflowDefinition {
  return normalizeDigitalTeamWorkflowDefinition({
    engine: 'langgraph',
    schemaGeneration: digitalTeamWorkflowSchemaGeneration,
    nodes,
    edges: edges.map(([source, target], index) => ({ id: `edge_${index}`, source, target })),
    viewport: { x: 0, y: 0, zoom: 1 },
  });
}
/** 确定性调用经同一 Invoke 和数据绑定协议执行。 */
function invoke(id: string, values: Record<string, WorkflowValue> = {}): DigitalTeamNode {
  return { id, type: 'invoke', position: { x: 0, y: 0 }, data: { title: id, capability: { kind: 'transform' }, inputs: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { source: 'literal', value }])) } };
}
/** 创建具有明确授权与真实任务身份的独立运行。 */
function start(definition: DigitalTeamWorkflowDefinition): string {
  const task = new TaskRepository(db).create({ projectId: project.id, title: '原语联调', taskType: 'requirement', description: '', createdFrom: 'workflow-verification', sourceContext: {} });
  return runs.create({ projectId: project.id, taskId: task.id, definition, taskFacts: { approved: false, count: 0, title: task.title }, baseRevisions: [], runtimeState: { permissionMode: 'read-only', graph: { ownerActorId: 'reviewer' } } })
    .id;
}
/** 当前进程保留在途动作，真正重启后创建全新的运行器。 */
let cachedRuntime: WorkflowPrimitiveRuntime | undefined;
/** 每个运行器实例仅依赖耐久账本，能力端口在集成环境中受控。 */
function runtime(): WorkflowPrimitiveRuntime {
  return (cachedRuntime ??= new WorkflowPrimitiveRuntime({
    runs,
    attempts,
    now: () => new Date(clock),
    save: () => db.save(),
    dispatchAgent: async (_run, _node, attempt) => {
      agentCalls += 1;
      const active = attempts.update(attempt.id, { expectedRevision: attempt.revision, status: 'active' });
      attempts.update(active.id, { expectedRevision: active.revision, status: 'succeeded', execution: { ...attempt.execution!, output: { received: attempt.execution!.input } } });
    },
    invokeTool: async (_run, _reference, input, approved) => {
      if (externalTool) return invokeWorkflowPluginTool(externalTool, _run, _reference, input, approved);
      toolCalls += 1;
      if (toolUnknown) throw new Error('工具接纳后连接中断');
      if (toolDelay) await toolDelay;
      return { received: input };
    },
    startWorkflow: async (_run, _node, attempt) => {
      const id = `child_${attempt.id}`;
      if (runs.getById(id)) return id;
      const task = new TaskRepository(db).create({ projectId: project.id, title: '子流程', taskType: 'requirement', description: '', createdFrom: 'workflow-verification', sourceContext: {} });
      runs.create({
        id,
        projectId: project.id,
        taskId: task.id,
        definition: graph([invoke('child_result', { result: 'child-output' })]),
        taskFacts: attempt.execution!.input,
        baseRevisions: [],
        runtimeState: { graph: { parentRunId: attempt.runId, parentAttemptId: attempt.id } },
      });
      return id;
    },
    complete: async (run) => {
      runs.update(run.id, { expectedRevision: run.revision, status: 'completed', completedAt: new Date(clock).toISOString() });
    },
  }));
}
/** 精确回应使用真实主体和当前输入快照。 */
function respond(engine: WorkflowPrimitiveRuntime, runId: string, nodeId: string, response: WorkflowValue, overrides: Record<string, unknown> = {}): void {
  const attempt = attempts.getCurrentByNode(runId, nodeId)!;
  engine.respond(
    runId,
    { nodeId, attempt: attempt.attempt, expectedRevision: runs.getById(runId)!.revision, waitId: attempt.execution!.wait!.id, inputSha256: attempt.inputSha256, approved: true, reason: '', response, ...overrides },
    { commandId: `respond_${attempt.id}`, operationIdentity: `respond_${attempt.id}`, actor: { kind: 'user', id: 'reviewer' } },
  );
}
/** 验证业务边界确实拒绝错误输入。 */
function rejected(action: () => unknown, message: string): void {
  let failed = false;
  try {
    action();
  } catch {
    failed = true;
  }
  check(failed, message);
}

try {
  const seed = invoke('seed', { decision: 'continue', count: 0, approved: false });
  const route: DigitalTeamNode = {
    id: 'route',
    type: 'route',
    position: { x: 0, y: 0 },
    data: { title: 'route', inputs: { decision: { source: 'node', nodeId: 'seed', path: 'decision' } }, cases: [{ field: 'decision', operator: 'eq', value: 'continue', targetId: 'selected' }], defaultTargetId: 'unselected' },
  };
  const joinNode: DigitalTeamNode = { id: 'join', type: 'join', position: { x: 0, y: 0 }, data: { title: 'join' } };
  const definition = graph(
    [seed, route, invoke('selected', { done: true }), invoke('unselected'), invoke('parallel', { concurrent: true }), joinNode],
    [
      ['seed', 'route'],
      ['route', 'selected'],
      ['route', 'unselected'],
      ['selected', 'join'],
      ['unselected', 'join'],
      ['parallel', 'join'],
    ],
  );
  check(validateDigitalTeamWorkflowDefinition(definition).length === 0, '调用、路由、并行与汇合配置可保存');
  const runId = start(definition);
  await runtime().advance(runId);
  check(runs.getById(runId)!.status === 'completed', '完整分支与汇合流程完成');
  check(attempts.getCurrentByNode(runId, 'unselected')!.status === 'skipped', '未选择分支显式跳过');
  check(attempts.getCurrentByNode(runId, 'selected')!.status === 'succeeded', '已选择分支正常执行');
  check(
    JSON.stringify(attempts.getCurrentByNode(runId, 'seed')!.execution!.output).includes('"approved":false') && JSON.stringify(attempts.getCurrentByNode(runId, 'seed')!.execution!.output).includes('"count":0'),
    'false 与零通过绑定完整保留',
  );
  check(!Object.hasOwn(attempts.getCurrentByNode(runId, 'join')!.execution!.output as object, 'unselected'), '未选择分支不阻塞或污染汇合输出');
  const broken = graph([{ ...invoke('invalid'), data: { ...(invoke('invalid') as Extract<DigitalTeamNode, { type: 'invoke' }>).data, inputs: { missing: { source: 'task', path: 'missing' } } } }]);
  const failedRun = start(broken);
  await runtime().advance(failedRun);
  await runtime().advance(failedRun);
  check(attempts.getCurrentByNode(failedRun, 'invalid')!.status === 'failed', '缺失字段形成明确失败并保留尝试');
  const schemaNode = invoke('typed', { value: 'wrong' }) as Extract<DigitalTeamNode, { type: 'invoke' }>;
  schemaNode.data.outputSchema = { type: 'object', properties: { value: { type: 'number' } } };
  const schemaRun = start(graph([schemaNode]));
  await runtime().advance(schemaRun);
  check(attempts.getCurrentByNode(schemaRun, 'typed')!.status === 'failed', '输出类型不匹配不能推进');
  const wait: DigitalTeamNode = {
    id: 'wait',
    type: 'await',
    position: { x: 0, y: 0 },
    data: { title: 'wait', mode: 'human', actorIds: ['initiator'], timeoutMs: 60_000, onTimeout: 'fail', outputSchema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string' } } } },
  };
  const waitRun = start(graph([wait, invoke('after_wait')], [['wait', 'after_wait']]));
  await runtime().advance(waitRun);
  const stableWaitingRevision = runs.getById(waitRun)!.revision;
  await runtime().advance(waitRun);
  await runtime().advance(waitRun);
  check(runs.getById(waitRun)!.revision === stableWaitingRevision, '空等待扫描不改变运行修订，人工回应不会无故过期');
  check(attempts.getCurrentByNode(waitRun, 'wait')!.status === 'waiting' && !attempts.getCurrentByNode(waitRun, 'after_wait'), '等待释放执行资源并阻止下游');
  await db.save();
  await db.close();
  cachedRuntime = undefined;
  db = await createZeusDatabase(join(root, 'workflow.sqlite'));
  runs = new DigitalTeamWorkflowRunRepository(db);
  attempts = new DigitalTeamNodeAttemptRepository(db);
  const restored = runtime();
  rejected(() => respond(restored, waitRun, 'wait', { decision: 'yes' }, { inputSha256: '0'.repeat(64) }), '旧输入摘要不能回应等待');
  rejected(() => respond(restored, waitRun, 'wait', {}), '回应必须满足输出契约');
  respond(restored, waitRun, 'wait', { decision: 'yes' });
  rejected(() => respond(restored, waitRun, 'wait', { decision: 'yes' }), '重复回应不能重复推进');
  await restored.advance(waitRun);
  check(runs.getById(waitRun)!.status === 'completed', '真实 SQLite 重开后恢复 LangGraph 等待并完成下游');
  const nullWait = { ...wait, data: { ...wait.data, outputSchema: { type: 'null' as const } } };
  const nullDownstream = invoke('after_null') as Extract<DigitalTeamNode, { type: 'invoke' }>;
  nullDownstream.data.inputs = { value: { source: 'node', nodeId: 'wait', path: '' } };
  const nullRun = start(graph([nullWait, nullDownstream], [['wait', 'after_null']]));
  await runtime().advance(nullRun);
  respond(runtime(), nullRun, 'wait', null);
  await runtime().advance(nullRun);
  check(JSON.stringify(attempts.getCurrentByNode(nullRun, 'after_null')!.execution!.output) === '{"value":null}', '显式 null 回应与跨节点绑定不会退回其他值');
  const timer = structuredClone(wait);
  timer.data = { title: 'timer', mode: 'timer', actorIds: [], timeoutMs: 1000, onTimeout: 'continue' };
  const timerRun = start(graph([timer]));
  await runtime().advance(timerRun);
  clock += 1001;
  await runtime().advance(timerRun);
  check(runs.getById(timerRun)!.status === 'completed', '定时等待到期恢复');
  const expired = start(graph([{ ...wait, data: { ...wait.data, timeoutMs: 1 } }]));
  await runtime().advance(expired);
  clock += 2;
  await runtime().advance(expired);
  check(attempts.getCurrentByNode(expired, 'wait')!.status === 'failed', '等待超时按规则失败');
  const eventRun = start(graph([{ ...wait, data: { ...wait.data, mode: 'event', eventKey: 'deployment:42' } }]));
  await runtime().advance(eventRun);
  rejected(() => respond(runtime(), eventRun, 'wait', { decision: 'done' }, { eventKey: 'other' }), '外部事件关联错误被拒绝');
  respond(runtime(), eventRun, 'wait', { decision: 'done' }, { eventKey: 'deployment:42' });
  await runtime().advance(eventRun);
  check(runs.getById(eventRun)!.status === 'completed', '外部事件准确关联后恢复');
  const toolNode: DigitalTeamNode = {
    id: 'tool',
    type: 'invoke',
    position: { x: 0, y: 0 },
    data: {
      title: 'tool',
      capability: { kind: 'tool', reference: { conversationId: 'controlled-session', tool: { name: 'echo', pluginRevisionId: 'frozen', definitionSha256: 'a'.repeat(64), approvalMode: 'prompt' } } },
      inputs: { value: { source: 'literal', value: 'tool-input' } },
    },
  };
  const toolRun = start(graph([toolNode]));
  await runtime().advance(toolRun);
  await runtime().settleExternal();
  await runtime().advance(toolRun);
  check(toolCalls === 0 && attempts.getCurrentByNode(toolRun, 'tool')!.status === 'waiting', '需要批准的工具在回应前没有副作用');
  respond(runtime(), toolRun, 'tool', { approved: true });
  await runtime().advance(toolRun);
  await runtime().settleExternal();
  await runtime().advance(toolRun);
  await runtime().advance(toolRun);
  await runtime().settleExternal();
  await runtime().advance(toolRun);
  check(toolCalls === 1 && runs.getById(toolRun)!.status === 'completed', '工具批准精确输入后只调用一次');
  toolUnknown = true;
  const unknownNode = structuredClone(toolNode);
  if (unknownNode.data.capability.kind === 'tool') unknownNode.data.capability.reference.tool.approvalMode = 'approve';
  const unknownRun = start(graph([unknownNode]));
  await runtime().advance(unknownRun);
  await runtime().settleExternal();
  await runtime().advance(unknownRun);
  await runtime().advance(unknownRun);
  await runtime().settleExternal();
  await runtime().advance(unknownRun);
  await runtime().advance(unknownRun);
  await runtime().settleExternal();
  await runtime().advance(unknownRun);
  check(toolCalls === 2 && runs.getById(unknownRun)!.status === 'outcome_unknown', '未知工具结果保留并阻止重复调用');
  toolUnknown = false;
  let releaseTool: () => void = () => undefined;
  toolDelay = new Promise<void>((resolve) => {
    releaseTool = resolve;
  });
  const waitingNetwork = start(graph([unknownNode]));
  await runtime().advance(waitingNetwork);
  check(attempts.getCurrentByNode(waitingNetwork, 'tool')!.status === 'dispatching', '长时间工具调用释放图推进和协调器扫描');
  const independentRun = start(graph([invoke('independent')]));
  await runtime().advance(independentRun);
  check(runs.getById(independentRun)!.status === 'completed', '工具网络等待期间其他运行仍可完成');
  releaseTool();
  await runtime().settleExternal();
  toolDelay = undefined;
  await runtime().advance(waitingNetwork);
  check(runs.getById(waitingNetwork)!.status === 'completed', '异步工具回执到达后准确恢复且不丢失唤醒');
  const childNode: DigitalTeamNode = { id: 'child', type: 'invoke', position: { x: 0, y: 0 }, data: { title: 'child', capability: { kind: 'workflow', templateId: 'controlled-template', templateRevision: 1 } } };
  const parentRun = start(graph([childNode, invoke('after_child')], [['child', 'after_child']]));
  await runtime().advance(parentRun);
  const childId = attempts.getCurrentByNode(parentRun, 'child')!.execution!.childRunId!;
  await runtime().advance(childId);
  await runtime().advance(parentRun);
  check(runs.getById(parentRun)!.status === 'completed' && attempts.getCurrentByNode(parentRun, 'child')!.execution!.output !== undefined, '父子运行关系与子流程输出贯通');
  /** 临时激活只连接本仓库回显进程，执行真实 MCP 握手与工具调用。 */
  const activation = {
    pluginId: 'workflow-echo',
    pluginRevisionId: 'echo-fixed-revision',
    installPath: process.cwd(),
    connectors: [],
    components: { mcpServers: [{ id: 'echo', transport: 'stdio', config: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/workflow-echo.mjs', import.meta.url))] } }] },
    mcpPolicies: [{ serverId: 'echo', toolName: '*', enabled: true, approvalMode: 'approve' }],
  } as unknown as PluginActivationState;
  const broker = createZeusPluginMcpBroker({ dataRoot: root, getActivations: async () => [activation], secretStore: { getSecret: async () => null } });
  try {
    const catalog = await broker.listTools('controlled-session');
    check(catalog.tools.length === 1 && catalog.tools[0]!.readOnly === true, '真实 stdio MCP 目录与只读注解贯通');
    externalTool = { conversationProjectId: project.id, runtime: { getCatalog: (id) => broker.listTools(id), invokeMcp: (input) => broker.invoke(input) } };
    const realTool = structuredClone(toolNode);
    realTool.data.capability = { kind: 'tool', reference: { conversationId: 'controlled-session', tool: JSON.parse(JSON.stringify(catalog.tools[0])) } };
    const realToolRun = start(graph([realTool]));
    await runtime().advance(realToolRun);
    await runtime().settleExternal();
    await runtime().advance(realToolRun);
    check(runs.getById(realToolRun)!.status === 'completed' && JSON.stringify(attempts.getCurrentByNode(realToolRun, 'tool')!.execution!.output).includes('tool-input'), 'Invoke 到权限适配、Plugin broker、真实 MCP 进程再到结构化输出贯通');
    if (realTool.data.capability.kind === 'tool') realTool.data.capability.reference.tool.definitionSha256 = '0'.repeat(64);
    const staleRun = start(graph([realTool]));
    await runtime().advance(staleRun);
    await runtime().settleExternal();
    await runtime().advance(staleRun);
    check(attempts.getCurrentByNode(staleRun, 'tool')!.status === 'failed', '过期工具定义在副作用前被拒绝');
  } finally {
    externalTool = undefined;
    await broker.close();
  }
  /** 员工适配器收到准确输入后，经同一输出协议连接后续路由。 */
  const employeeTemplate = new DigitalEmployeeTemplateRepository(db).create({ name: '受控员工', role: '分析', prompt: '返回结构化结果。' });
  const employee = new DigitalEmployeeRepository(db).createFromTemplate({ projectId: project.id, template: employeeTemplate });
  const agentNode: DigitalTeamNode = {
    id: 'agent',
    type: 'employee',
    position: { x: 0, y: 0 },
    data: { title: '员工调用', employeeId: employee.id, purpose: 'work', executionMode: 'read_only', instructions: '验证员工输入输出', inputs: { message: { source: 'literal', value: 'agent-input' } } },
  };
  const agentRun = start(
    graph(
      [agentNode, { ...invoke('after_agent'), data: { ...(invoke('after_agent') as Extract<DigitalTeamNode, { type: 'invoke' }>).data, inputs: { received: { source: 'node', nodeId: 'agent', path: 'received.message' } } } }],
      [['agent', 'after_agent']],
    ),
  );
  await runtime().advance(agentRun);
  check(agentCalls === 1 && runs.getById(agentRun)!.status === 'completed' && JSON.stringify(attempts.getCurrentByNode(agentRun, 'after_agent')!.execution!.output).includes('agent-input'), '员工受控适配器与通用输入输出及下游调用贯通');
  const coordinator = new DigitalTeamWorkflowCoordinator({
    projects: new ProjectRepository(db),
    tasks: new TaskRepository(db),
    templates: new DigitalTeamWorkflowTemplateRepository(db),
    employees: new DigitalEmployeeRepository(db),
    runs,
    attempts,
    now: () => new Date(clock),
    save: () => db.save(),
    publish: () => undefined,
    isTaskTerminal: () => false,
    taskWork: { kick: () => undefined },
    transaction: (operation: () => unknown) => db.transaction(operation),
    taskCreation: { create: (input: Record<string, unknown>, id: string) => new TaskRepository(db).create({ ...input, id, createdFrom: 'workflow-verification' } as never) },
  } as unknown as DigitalTeamWorkflowCoordinatorOptions);
  const coordinated = start(graph([invoke('coordinator_real', { value: true })]));
  await coordinator.processRuns();
  check(runs.getById(coordinated)!.status === 'completed', '现有协调器到 LangGraph 再到最终门禁完整贯通');
  /** 父运行固定子图后，即使来源模板更新，子流程仍执行已接纳修订。 */
  const templates = new DigitalTeamWorkflowTemplateRepository(db);
  const childTemplate = templates.create({ name: '固定子流程', description: '', definition: graph([invoke('snapshot_result', { version: 'frozen' })]) });
  const sourceParent = templates.create({
    name: '固定父流程',
    description: '',
    definition: graph(
      [
        { ...wait, data: { ...wait.data, outputSchema: undefined } },
        { ...childNode, data: { ...childNode.data, capability: { kind: 'workflow', templateId: childTemplate.id, templateRevision: childTemplate.revision } } },
      ],
      [['wait', 'child']],
    ),
  });
  const sourceInput = { templateId: sourceParent.id, templateRevision: sourceParent.revision, title: '冻结子流程实际联调', description: '', permissionMode: 'read-only' as const, taskFacts: {} };
  const prepared = await coordinator.prepareRun(project.id, sourceInput);
  const parentProjection = coordinator.createRun(project.id, sourceInput, { commandId: 'snapshot_parent', operationIdentity: 'snapshot_parent', actor: { kind: 'user', id: 'reviewer' } }, prepared) as { run: { id: string } };
  await coordinator.processRuns();
  templates.update(childTemplate.id, { expectedRevision: childTemplate.revision, definition: graph([invoke('snapshot_result', { version: 'changed-after-acceptance' })]) });
  const currentWait = attempts.getCurrentByNode(parentProjection.run.id, 'wait')!;
  coordinator.decideApproval(
    parentProjection.run.id,
    {
      nodeId: 'wait',
      attempt: currentWait.attempt,
      expectedRevision: runs.getById(parentProjection.run.id)!.revision,
      waitId: currentWait.execution!.wait!.id,
      inputSha256: currentWait.inputSha256,
      approved: true,
      reason: '',
      response: {},
    },
    { commandId: 'snapshot_response', operationIdentity: 'snapshot_response', actor: { kind: 'user', id: 'reviewer' } },
  );
  for (let step = 0; step < 4; step += 1) await coordinator.processRuns();
  check(
    runs.getById(parentProjection.run.id)!.status === 'completed' && JSON.stringify(attempts.getCurrentByNode(parentProjection.run.id, 'child')!.execution!.output).includes('frozen'),
    '真实协调器子流程使用父运行冻结修订，不随模板更新漂移',
  );
  const reworkRun = start(graph([{ ...wait, data: { ...wait.data, outputSchema: undefined } }]));
  await coordinator.processRuns();
  const oldWait = attempts.getCurrentByNode(reworkRun, 'wait')!;
  coordinator.requestRework(
    reworkRun,
    { nodeId: 'wait', expectedRevision: runs.getById(reworkRun)!.revision, reason: '重新收集准确输入' },
    { commandId: 'rework_wait', operationIdentity: 'rework_wait', actor: { kind: 'user', id: 'reviewer' } },
  );
  await coordinator.processRuns();
  check(attempts.getCurrentByNode(reworkRun, 'wait')!.attempt === 2, '等待节点返工生成新尝试并重建检查点');
  rejected(
    () =>
      runtime().respond(
        reworkRun,
        { nodeId: 'wait', attempt: oldWait.attempt, expectedRevision: runs.getById(reworkRun)!.revision, waitId: oldWait.execution!.wait!.id, inputSha256: oldWait.inputSha256, approved: true, reason: '' },
        { commandId: 'old_wait', operationIdentity: 'old_wait', actor: { kind: 'user', id: 'reviewer' } },
      ),
    '返工前的旧等待回应被拒绝',
  );
  const budgetRun = start(graph([invoke('budget_first'), invoke('budget_second')], [['budget_first', 'budget_second']]));
  const beforeBudget = runs.getById(budgetRun)!;
  runs.update(budgetRun, { expectedRevision: beforeBudget.revision, runtimeState: { ...beforeBudget.runtimeState, graph: { ...beforeBudget.runtimeState.graph, maxNodeAttempts: 1 } } });
  await runtime().advance(budgetRun);
  check(runs.getById(budgetRun)!.controlState === 'paused' && !attempts.getCurrentByNode(budgetRun, 'budget_second'), '共享节点额度耗尽后停止派发');
  const reservedRun = start(graph([invoke('reserved')]));
  const reservedRecord = runs.getById(reservedRun)!;
  runs.update(reservedRun, { expectedRevision: reservedRecord.revision, runtimeState: { ...reservedRecord.runtimeState, graph: { ...reservedRecord.runtimeState.graph, maxNodeAttempts: 1 } } });
  const reservedAttempt = attempts.create({ runId: reservedRun, nodeId: 'reserved', inputSha256: 'a'.repeat(64) });
  attempts.update(reservedAttempt.id, { expectedRevision: reservedAttempt.revision, execution: { input: { resumed: true } } });
  await runtime().advance(reservedRun);
  check(runs.getById(reservedRun)!.status === 'completed' && attempts.getCurrentByNode(reservedRun, 'reserved')!.attempt === 1, '重启继续已预留尝试不会重复扣减额度或生成新尝试');
  await coordinator.close();
  /** 构造真实旧格式与自关联返工记录，再由正式启动入口执行迁移。 */
  let migrationDb = await createZeusDatabase(join(root, 'migration.sqlite'));
  const migrationProject = new ProjectRepository(migrationDb).create({ name: '迁移验证', localPath: root });
  const migrationTask = new TaskRepository(migrationDb).create({ projectId: migrationProject.id, title: '历史运行', taskType: 'requirement', description: '', createdFrom: 'workflow-verification', sourceContext: {} });
  const migrationTemplate = new DigitalEmployeeTemplateRepository(migrationDb).create({ name: '历史员工', role: '分析', prompt: '保留历史事实。' });
  const migrationEmployee = new DigitalEmployeeRepository(migrationDb).createFromTemplate({ projectId: migrationProject.id, template: migrationTemplate });
  const migrationRun = new DigitalTeamWorkflowRunRepository(migrationDb).create({
    projectId: migrationProject.id,
    taskId: migrationTask.id,
    definition: {
      schemaGeneration: digitalTeamWorkflowSchemaGeneration,
      nodes: [{ id: 'historical', type: 'employee', position: { x: 0, y: 0 }, data: { title: '历史工作', employeeId: migrationEmployee.id, purpose: 'work', executionMode: 'read_only', instructions: '保留原工作。' } }],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    taskFacts: {},
    baseRevisions: [],
  });
  const migrationAttempts = new DigitalTeamNodeAttemptRepository(migrationDb);
  const historical = migrationAttempts.create({ runId: migrationRun.id, nodeId: 'historical', inputSha256: 'b'.repeat(64) });
  const historicalActive = migrationAttempts.update(historical.id, { expectedRevision: historical.revision, status: 'active' });
  migrationAttempts.update(historical.id, { expectedRevision: historicalActive.revision, status: 'succeeded' });
  migrationAttempts.invalidateCurrentAndDescendants({ runId: migrationRun.id, nodeId: 'historical', invalidatedByAttemptId: historical.id, reason: '历史返工' });
  migrationAttempts.create({ runId: migrationRun.id, nodeId: 'historical', inputSha256: 'c'.repeat(64) });
  const beforeMigration = migrationDb.select('SELECT id, run_id, node_id, status, input_sha256, revision, invalidated_by_attempt_id FROM digital_team_node_attempts ORDER BY attempt');
  migrationDb.transaction(() => {
    // 仅构造这个临时旧库时开放迁移账本写入，随后恢复既有降级保护。
    migrationDb.execute('UPDATE conversation_legacy_write_fence SET current_writer_open = 1 WHERE singleton = 1');
    migrationDb.execute('PRAGMA defer_foreign_keys = ON');
    migrationDb.execute('ALTER TABLE digital_team_node_attempts DROP COLUMN execution_json');
    const indexes = migrationDb.select<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'digital_team_node_attempts' AND sql IS NOT NULL");
    const currentSchema = migrationDb.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'digital_team_node_attempts'")!.sql;
    const historicalSchema = currentSchema
      .replace(/CREATE TABLE\s+["`]?digital_team_node_attempts["`]?/i, 'CREATE TABLE historical_attempts')
      .replace(/REFERENCES\s+["`]?digital_team_node_attempts["`]?\s*\(/gi, 'REFERENCES historical_attempts(')
      .replace(",'invoke','await','route','join'", '')
      .replace(",'waiting','skipped'", '');
    migrationDb.execute(historicalSchema);
    migrationDb.execute('INSERT INTO historical_attempts SELECT * FROM digital_team_node_attempts');
    migrationDb.execute('DROP TABLE digital_team_node_attempts');
    migrationDb.execute('ALTER TABLE historical_attempts RENAME TO digital_team_node_attempts');
    for (const index of indexes) migrationDb.execute(index.sql);
    migrationDb.execute("DELETE FROM schema_migrations WHERE migration_id = '20261112_workflow_primitives'");
    migrationDb.execute('UPDATE conversation_legacy_write_fence SET current_writer_open = 0 WHERE singleton = 1');
  });
  await migrationDb.save();
  await migrationDb.close();
  migrationDb = await createZeusDatabase(join(root, 'migration.sqlite'));
  const afterMigration = migrationDb.select('SELECT id, run_id, node_id, status, input_sha256, revision, invalidated_by_attempt_id FROM digital_team_node_attempts ORDER BY attempt');
  check(
    JSON.stringify(beforeMigration) === JSON.stringify(afterMigration) &&
      migrationDb.select('PRAGMA foreign_key_check').length === 0 &&
      migrationDb.select<{ name: string }>('PRAGMA table_info(digital_team_node_attempts)').some((column) => column.name === 'execution_json'),
    '旧 SQLite 迁移保留身份、输入摘要、修订和返工自关联，外键检查通过',
  );
  await migrationDb.close();
  check(agentCalls === 1, '本专项明确区分员工受控适配器与真实模型执行');
  process.stdout.write(
    `${JSON.stringify({ ok: true, sqliteVersion: db.get('SELECT sqlite_version() AS version'), checks, evidenceBoundary: '真实 SQLite、LangGraph、协调器；真实 Plugin broker 与 stdio MCP；员工与子流程端口受控，未调用真实模型或用户业务系统' }, null, 2)}\n`,
  );
} finally {
  await db.close();
  await rm(root, { recursive: true, force: true });
}
