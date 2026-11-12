import { constants as fsConstants } from 'node:fs';
import { mkdtemp, mkdir, writeFile, copyFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZeusDatabase, DigitalTeamWorkflowTemplateRepository, ProjectRepository, DigitalEmployeeTemplateRepository } from '../packages/storage/src/index.js';
import { digitalTeamWorkflowSchemaGeneration, normalizeDigitalTeamWorkflowDefinition, type DigitalTeamNode } from '../packages/shared/src/index.js';
import { createLocalServer } from '../packages/local-server/src/index.js';

/** 验收服务全部使用临时数据、独立 Keychain 命名和禁用的模型入口。 */
const root = process.argv[2] ?? (await mkdtemp(join(tmpdir(), 'zeus-1035-http-qa-')));
/** 隔离项目路径，当前工作区不作为用户任务的修改目标。 */
const workspace = join(root, 'workspace');
await mkdir(workspace, { recursive: true });
/** 服务启动前通过真实仓储准备可重复操作的配置。 */
const db = await createZeusDatabase(join(root, 'zeus.db'));
/** 单一隔离验收项目。 */
const project = process.argv[2] ? new ProjectRepository(db).getById(db.get<{ id: string }>('SELECT id FROM projects LIMIT 1')!.id)! : new ProjectRepository(db).create({ name: 'ZEUS-1035 节点联调', localPath: workspace });
if (!process.argv[2]) {
  new DigitalEmployeeTemplateRepository(db).create({ name: '验收员工', role: '分析', prompt: '返回可核对结果。' });
  /** 确定性调用与其他 Invoke 能力共用同一节点协议。 */
  const invoke = (id: string, title: string, value: string): DigitalTeamNode => ({ id, type: 'invoke', position: { x: 80, y: 80 }, data: { title, capability: { kind: 'transform' }, inputs: { value: { source: 'literal', value } } } });
  /** 保存子流程后，父流程引用这次准确修订。 */
  const templates = new DigitalTeamWorkflowTemplateRepository(db);
  /** 子流程固定返回结构化结果。 */
  const child = templates.create({
    name: '子流程 · 数据交接',
    description: '',
    definition: { engine: 'langgraph', schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes: [invoke('child_output', '子流程结果', '子流程已完成')], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
  });
  /** 配置覆盖所有四类原语与并行汇合。 */
  const nodes: DigitalTeamNode[] = [
    invoke('input', '任务输入', '开始'),
    {
      id: 'human',
      type: 'await',
      position: { x: 390, y: 80 },
      data: { title: '等待决定', mode: 'human', actorIds: ['initiator'], timeoutMs: 3_600_000, onTimeout: 'fail', outputSchema: { type: 'object', required: ['decision'], properties: { decision: { type: 'string' } } } },
    },
    {
      id: 'route',
      type: 'route',
      position: { x: 700, y: 80 },
      data: { title: '选择路径', inputs: { decision: { source: 'node', nodeId: 'human', path: 'decision' } }, cases: [{ field: 'decision', operator: 'eq', value: 'continue', targetId: 'child' }], defaultTargetId: 'stop' },
    },
    { id: 'child', type: 'invoke', position: { x: 1010, y: 0 }, data: { title: '调用子流程', capability: { kind: 'workflow', templateId: child.id, templateRevision: child.revision } } },
    { ...invoke('stop', '停止路径', '已停止'), position: { x: 1010, y: 200 } },
    { ...invoke('parallel', '并行资料', '资料已就绪'), position: { x: 390, y: 360 } },
    { id: 'join', type: 'join', position: { x: 1320, y: 160 }, data: { title: '汇合结果' } },
  ];
  /** 普通依赖与显式汇合使用相同调度语义。 */
  const edges = [
    ['input', 'human'],
    ['human', 'route'],
    ['route', 'child'],
    ['route', 'stop'],
    ['input', 'parallel'],
    ['child', 'join'],
    ['stop', 'join'],
    ['parallel', 'join'],
  ].map(([source, target], index) => ({ id: `edge_${index}`, source: source!, target: target! }));
  templates.create({
    name: '全节点交互验收',
    description: '',
    definition: normalizeDigitalTeamWorkflowDefinition({ engine: 'langgraph', schemaGeneration: digitalTeamWorkflowSchemaGeneration, nodes, edges, viewport: { x: 0, y: 0, zoom: 0.65 } }),
  });
}
await db.save();
await db.close();
/** 仅限本次 loopback 临时环境的鉴权值，不使用任何用户账号或密钥。 */
const apiToken = 'zeus-1035-isolated-loopback-qa';
/** 只有显式联调参数才复用已授权账户，默认演示环境始终不启动真实模型。 */
const liveCodex = process.argv.includes('--live-codex');
if (liveCodex) {
  /** 凭据只进入权限隔离的临时目录，不复制用户 MCP、通知、插件或会话历史。 */
  const source = process.env.ZEUS_QA_CODEX_SOURCE;
  if (!source) throw new Error('真实 Codex 联调需要明确指定 ZEUS_QA_CODEX_SOURCE。');
  const target = join(root, 'codex');
  await mkdir(join(target, 'packages', 'standalone', 'current', 'bin'), { recursive: true, mode: 0o700 });
  await copyFile(join(source, 'auth.json'), join(target, 'auth.json'));
  await chmod(join(target, 'auth.json'), 0o600);
  // Codex 的工具调用和命令分发依赖同一发行包内的配套进程。
  for (const executable of ['codex', 'codex-code-mode-host', 'codex-exec-server']) {
    await copyFile(join(source, 'packages', 'standalone', 'current', 'bin', executable), join(target, 'packages', 'standalone', 'current', 'bin', executable), fsConstants.COPYFILE_FICLONE);
    await chmod(join(target, 'packages', 'standalone', 'current', 'bin', executable), 0o755);
  }
  await writeFile(join(target, 'config.toml'), 'model_provider = "openai"\napproval_policy = "never"\nsandbox_mode = "read-only"\nmodel_reasoning_effort = "low"\n', { mode: 0o600 });
}
/** 完整生产 HTTP/Core/调度链，只有显式参数才启用真实 Provider。 */
const server = await createLocalServer({
  dbPath: join(root, 'zeus.db'),
  apiToken,
  keychainService: 'dev.hypha.zeus.test.ZEUS1035',
  localConfigPath: join(root, 'local-server.json'),
  codexHome: join(root, 'codex'),
  codexConfigImportSourceRoot: join(root, 'no-import'),
  projectRoot: process.cwd(),
  codexNativeEnabled: liveCodex,
});
server.get('/qa-fixture', async () => ({ project, apiToken, root }));
await writeFile('apps/desktop/qa/.workflow-fixture.json', JSON.stringify({ project, apiToken, root }));
await server.listen({ host: '127.0.0.1', port: 18535 });
await writeFile('/tmp/zeus-1035-http-root', root);
process.stdout.write(`${JSON.stringify({ ready: true, port: 18535, root })}\n`);
