import { readFile, writeFile } from 'node:fs/promises';
import { createDashboardClient } from '../apps/desktop/src/renderer/dashboardClient.js';
import { digitalTeamWorkflowSchemaGeneration, type DigitalTeamNode } from '../packages/shared/src/index.js';

/** 真实 Agent 验收只连接显式启用现有 Codex 账户的隔离 loopback 服务。 */
const fixture = JSON.parse(await readFile('apps/desktop/qa/.workflow-fixture.json', 'utf8'));
/** 正式 Renderer 客户端生成命令身份、修订和 HTTP 契约。 */
const client = createDashboardClient({ baseUrl: 'http://127.0.0.1:18535', apiToken: fixture.apiToken });
/** 初始化复用已获授权的登录，不执行登录、登出或新的密钥配置。 */
const activation = await client.activateCodexConfig({ syncSubscriptionModels: true });
/** 仅输出不包含账户身份和认证内容的激活元数据。 */
console.log(JSON.stringify({ activated: true, keys: Object.keys(activation) }));
/** 调试阶段也只保留连接元数据，认证信息始终留在私有临时目录。 */
await writeFile('/tmp/zeus-1035-codex-activation.json', JSON.stringify(activation), { mode: 0o600 });

/** 本次只验证账户连接，不披露账号标识。 */
const account = await client.loadCodexAccount();
if (!account.signedIn) throw new Error('复用的 Codex 账户尚未登录。');
/** 使用当前真实目录的首选 Codex 模型，不猜测模型或档位。 */
const capabilities = await client.loadDigitalEmployeeCapabilities();
const model = capabilities.models.find((item) => item.id === capabilities.preferredModel) ?? capabilities.models[0];
if (!model) throw new Error('当前连接没有可用模型。');
/** 明确返工参数只恢复已记录的失败运行，保留首轮和所有原始身份。 */
let runId: string;
if (process.argv.includes('--observe-existing')) {
  runId = JSON.parse(await readFile('/tmp/zeus-1035-live-agent-run.json', 'utf8')).runId;
} else if (process.argv.includes('--resume-with-rework')) {
  const previous = JSON.parse(await readFile('/tmp/zeus-1035-live-agent-run.json', 'utf8'));
  const projection = await client.loadDigitalTeamRun(previous.runId);
  if (projection.run.status !== 'failed') throw new Error('只有已确认失败的运行允许本脚本发起返工。');
  await client.requestDigitalTeamRework(previous.runId, 'agent', {
    expectedRevision: projection.run.revision,
    reason: '隔离 Codex 发行包已补齐 code-mode host 配套进程。首轮工具调用在启动该进程前失败，未提交结果；请依据同一准确输入重新完成结构化交接，并如实提交本轮结果。',
  });
  runId = previous.runId;
  console.log(JSON.stringify({ reworked: true, runId, model: model.model }));
} else {
  /** 只读验收员工不会修改代码、运行命令或访问用户业务系统。 */
  const employee = await client.createDigitalEmployeeTemplate({
    name: 'ZEUS-1035 真实 Agent 验收',
    role: '结构化交接验收',
    agentKind: 'codex',
    model: model.id,
    reasoningEffort: 'low',
    permissionMode: 'read-only',
    memoryEnabled: false,
    skillIds: [],
    prompt: '仅完成本节点的结构化交接，不读写文件、不运行命令、不访问外部系统。除 zeus_work.inspect 和 zeus_work.submit_team_result 外不调用工具。先给出一句可阅读说明，再提交本次真实结果；提交后给出简短完成说明。',
  });
  /** Agent 输出经实际 Route、分支跳过和 Join 进入最终结果。 */
  const nodes: DigitalTeamNode[] = [
    {
      id: 'agent',
      type: 'employee',
      position: { x: 0, y: 0 },
      data: {
        title: '读取准确输入并返回结构化结果',
        employeeId: employee.id,
        purpose: 'work',
        executionMode: 'read_only',
        instructions:
          '从本节点准确输入读取 amount。提交 output={decision:"continue",value:amount}；submit_team_result 的 outcome=succeeded，verification=not_run，repositoryResults=[]，verifiedCandidates=[]，artifactRefs=[]，remainingIssues=[]，summary 写明已读取准确输入并返回结果。本次无代码修改或执行命令，不声称做过代码验证。',
        acceptanceCriteria: ['读取准确 amount 输入并交付结构化 decision 和 value'],
        expectedDeliverables: ['可阅读说明与结构化交接结果'],
        inputs: { amount: { source: 'literal', value: 7 } },
        outputSchema: { type: 'object', required: ['decision', 'value'], properties: { decision: { type: 'string', enum: ['continue', 'stop'] }, value: { type: 'integer' } } },
      },
    },
    {
      id: 'route',
      type: 'route',
      position: { x: 300, y: 0 },
      data: {
        title: '按实际 Agent 输出选择出口',
        inputs: { decision: { source: 'node', nodeId: 'agent', path: 'decision' } },
        cases: [{ field: 'decision', operator: 'eq', value: 'continue', targetId: 'selected' }],
        defaultTargetId: 'unselected',
      },
    },
    { id: 'selected', type: 'invoke', position: { x: 600, y: 0 }, data: { title: '接收实际 Agent 输出', capability: { kind: 'transform' }, inputs: { received: { source: 'node', nodeId: 'agent', path: 'value' } } } },
    { id: 'unselected', type: 'invoke', position: { x: 600, y: 200 }, data: { title: '未选择出口', capability: { kind: 'transform' } } },
    { id: 'join', type: 'join', position: { x: 900, y: 0 }, data: { title: '汇合真实结果' } },
  ];
  /** 固定模板与当前修订通过正式 Core 接纳。 */
  const template = await client.saveDigitalTeamTemplate({
    expectedRevision: null,
    name: 'ZEUS-1035 真实 Codex 全链路',
    description: '只读、小型结构化输出验收。',
    definition: {
      engine: 'langgraph',
      schemaGeneration: digitalTeamWorkflowSchemaGeneration,
      nodes,
      edges: [
        ['agent', 'route'],
        ['route', 'selected'],
        ['route', 'unselected'],
        ['selected', 'join'],
        ['unselected', 'join'],
      ].map(([source, target], index) => ({ id: `edge_${index}`, source: source!, target: target! })),
      viewport: { x: 0, y: 0, zoom: 1 },
    },
  });
  /** 正式任务与真实 Provider 轮次只在这个隔离项目中创建。 */
  const created = await client.createDigitalTeamRun(fixture.project.id, {
    templateId: template.id,
    templateRevision: template.revision,
    title: 'ZEUS-1035 真实 Agent 与节点联调',
    description: '',
    permissionMode: 'read-only',
    taskFacts: { title: 'ZEUS-1035 真实 Agent 与节点联调' },
  });
  await writeFile('/tmp/zeus-1035-live-agent-run.json', JSON.stringify({ runId: created.run.id, templateId: template.id, model: model.model }), { mode: 0o600 });
  runId = created.run.id;
  console.log(JSON.stringify({ started: true, runId, model: model.model }));
}
/** 等待真实业务终态；每次只读取当前运行，不重发任务或修改结果。 */
const deadline = Date.now() + 180_000;
/** 终态与业务输出都确认后才报告通过。 */
let verified = false;
while (Date.now() < deadline) {
  const projection = await client.loadDigitalTeamRun(runId);
  if (['completed', 'failed', 'outcome_unknown', 'cancelled'].includes(projection.run.status) || projection.run.controlState === 'paused') {
    const evidence = {
      checkedAt: new Date().toISOString(),
      model: model.model,
      runId: projection.run.id,
      status: projection.run.status,
      controlState: projection.run.controlState,
      error: projection.run.error,
      attemptHistory: projection.nodeAttempts.map((attempt) => ({ nodeId: attempt.nodeId, attempt: attempt.attempt, status: attempt.status, inputSha256: attempt.inputSha256, turnId: attempt.turnId, error: attempt.error })),
      attempts: projection.currentAttempts.map((attempt) => ({
        nodeId: attempt.nodeId,
        status: attempt.status,
        attempt: attempt.attempt,
        conversationId: attempt.conversationId,
        turnId: attempt.turnId,
        deliverableId: attempt.deliverableId,
        output: attempt.execution?.output ?? attempt.result?.output,
        evidence: attempt.result?.evidence,
        error: attempt.error,
      })),
    };
    await writeFile('docs/ZEUS-1035/verification/live-agent.json', JSON.stringify(evidence, null, 2));
    const selected = projection.currentAttempts.find((attempt) => attempt.nodeId === 'selected');
    const agent = projection.currentAttempts.find((attempt) => attempt.nodeId === 'agent');
    if (
      projection.run.status !== 'completed' ||
      selected?.status !== 'succeeded' ||
      JSON.stringify(selected.execution?.output) !== '{"received":7}' ||
      projection.currentAttempts.find((attempt) => attempt.nodeId === 'unselected')?.status !== 'skipped' ||
      !agent?.turnId ||
      !agent.deliverableId
    )
      throw new Error(`真实 Agent 联调未通过：${projection.run.status}。请读取已保存的准确证据，不自动重发。`);
    verified = true;
    console.log(JSON.stringify({ ok: true, runId: projection.run.id, model: model.model, statuses: projection.currentAttempts.map((attempt) => ({ nodeId: attempt.nodeId, status: attempt.status })) }));
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

if (!verified) throw new Error(`等待真实模型终态超时，保留运行 ${runId}，不自动重发。`);
