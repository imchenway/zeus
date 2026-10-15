import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { defaultGitDeliverySettings, type GitDeliveryInput, type GitDeliveryRun } from '../packages/shared/src/index.js';
import {
  ArtifactStore,
  CommandDeliveryRepository,
  createZeusDatabase,
  ConversationRepository,
  ConversationSubmissionRepository,
  ProjectRepository,
  ProjectRepositoryRegistrationRepository,
  ProjectSharedPathRepository,
  TaskRepository,
  TaskWorkspaceRepository,
  TaskEnvironmentRepository,
  TaskIntegrationRepository,
  TaskIntegrationAttemptRepository,
} from '../packages/storage/src/index.js';
import { executeProjectGitAction, getProjectGitRepositorySnapshot, withGitRepositoryOperation } from '../packages/git-core/src/index.js';
import { GitDeliveryExecution } from '../packages/local-server/src/gitDeliveryExecution.js';
import { WorkspaceGitCommandApplication } from '../packages/local-server/src/workspaceGitCommandApplication.js';
import { createGitIntegrationOperations, type GitIntegrationOperationDependencies } from '../packages/local-server/src/gitIntegrationOperations.js';
import { registerWorkspaceGitCommandRoutes } from '../packages/local-server/src/workspaceGitCommandRoutes.js';

/** 仅在系统临时目录创建仓库、远端与数据库，不使用用户项目。 */
const root = await mkdtemp(join(tmpdir(), 'zeus-0857-delivery-'));
/** Git 子进程不执行任何用户全局 hook。 */
const execute = promisify(execFile);
/** 每个命令只接收探针内部生成的路径和参数。 */
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute('git', args, { cwd, timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim();
}
/** 运行进度使用有界轮询，超时保留准确步骤信息。 */
async function settle(service: GitDeliveryExecution, id: string): Promise<GitDeliveryRun> {
  for (let index = 0; index < 300; index += 1) {
    const run = service.repository.get(id)!;
    if (run.state === 'succeeded' || run.state === 'attention') return service.repository.view(run);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(JSON.stringify(service.repository.view(service.repository.get(id)!)));
}
/** 创建本地仓库及本地 bare 远端，所有推送都留在临时目录。 */
async function createRepository(name: string): Promise<string> {
  const cwd = join(root, 'project', name);
  const remote = join(root, `${name}.git`);
  await mkdir(cwd, { recursive: true });
  await git(cwd, 'init', '-b', 'main');
  await git(cwd, 'config', 'user.name', 'Zeus Delivery Check');
  await git(cwd, 'config', 'user.email', 'delivery-check@example.invalid');
  await git(cwd, 'config', 'core.hooksPath', '/dev/null');
  await writeFile(join(cwd, 'base.txt'), 'base\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', '基础');
  await git(root, 'init', '--bare', remote);
  await git(cwd, 'remote', 'add', 'origin', remote);
  await git(cwd, 'push', '-u', 'origin', 'main');
  return cwd;
}

/** 一个探针数据库持有全部真实存储和命令回执。 */
const db = await createZeusDatabase(join(root, 'delivery.db'));
/** 接纳与命令请求走真实 Fastify 路由。 */
const server = Fastify({ logger: false });
/** 所有仓库事实来自同一数据库。 */
const projects = new ProjectRepository(db),
  projectRepositories = new ProjectRepositoryRegistrationRepository(db),
  tasks = new TaskRepository(db),
  taskWorkspaces = new TaskWorkspaceRepository(db),
  taskIntegrations = new TaskIntegrationRepository(db),
  conversations = new ConversationRepository(db),
  conversationSubmissions = new ConversationSubmissionRepository(db);
/** 原命令应用层保存真实、可恢复的 Git 回执。 */
const commands = new WorkspaceGitCommandApplication({
  db,
  deliveries: new CommandDeliveryRepository(db),
  artifacts: new ArtifactStore(db, join(root, 'artifacts'), () => new Date().toISOString(), { minimumFreeBytes: 0 }),
  redactSensitiveText: (text) => ({ text }),
  now: () => new Date(),
});
/** Provider 状态在本探针中受控模拟，不能当作真实 Provider 验收。 */
const aiStates = new Map<string, 'running' | 'waiting' | 'completed' | 'failed'>();
/** 固定注入参数供宿主重启后重建执行器。 */
const dependencies = {
  server,
  db,
  apiToken: 'isolated-delivery-probe',
  readOnly: false,
  projects,
  projectRepositories,
  tasks,
  taskWorkspaces,
  taskIntegrations,
  taskIntegrationAttempts: new TaskIntegrationAttemptRepository(db),
  conversations,
  conversationSubmissions,
  commands,
  finalizeTaskConflict: async () => {
    throw new Error('本探针未覆盖任务 AI 落地');
  },
  statusOptions: () => [{ id: 'done', label: '完成' }],
  conversationState: (id: string) => aiStates.get(id) ?? ('failed' as const),
  publish: () => undefined,
};
/** 后台执行器不依赖 Renderer 存活。 */
let service = new GitDeliveryExecution(dependencies);
/** 记录通过的实际场景，不把模拟接口记为业务验收。 */
const checked: string[] = [];
try {
  const first = await createRepository('first');
  const second = await createRepository('second');
  const project = projects.create({ name: '交付隔离验收', localPath: join(root, 'project') });
  const registered = projectRepositories.replaceForProject(project.id, [
    { name: 'first', relativePath: 'first', localPath: first },
    { name: 'second', relativePath: 'second', localPath: second },
  ]);
  const conversation = conversations.create({ projectId: project.id, title: '普通会话交付' });
  conversationSubmissions.createOrGet({
    conversationId: conversation.id,
    idempotencyKey: 'delivery-probe',
    requestHash: 'delivery-probe',
    clientMessageId: 'delivery-probe',
    kind: 'message',
    requestedDelivery: 'send_now',
    status: 'completed',
    createdAt: new Date().toISOString(),
    input: { context: { projectLocalPath: project.localPath, executionWorkspaceMode: 'direct' } },
  });
  /** 任务入口使用正式 Git 业务实现，省略本探针不涉及的通知发送。 */
  const operations = createGitIntegrationOperations({
    db,
    projects,
    projectRepositories,
    tasks,
    taskWorkspaces,
    taskIntegrations,
    taskIntegrationAttempts: new TaskIntegrationAttemptRepository(db),
    taskEnvironments: new TaskEnvironmentRepository(db),
    projectSharedPaths: new ProjectSharedPathRepository(db),
    conversations,
    conversationSubmissions,
    appendAuditLog: () => undefined,
    recordTaskEvent: () => undefined,
    publishRealtimeEvent: () => undefined,
  } as GitIntegrationOperationDependencies);
  registerWorkspaceGitCommandRoutes({
    server,
    application: commands,
    operations: { prepare: operations.prepareWorkspaceGitCommand, execute: operations.executeWorkspaceGitCommand, isExplicitRejection: operations.isWorkspaceGitExplicitRejection },
    sendError: operations.sendWorkspaceGitCommandError,
  });
  server.get<{ Params: { taskId: string; workspaceId: string } }>('/api/tasks/:taskId/git-workspaces/:workspaceId/snapshot', async (request) => ({
    workspace: await operations.readTaskWorkspaceSnapshot(project, taskWorkspaces.getById(request.params.workspaceId)!),
  }));
  /** AI 仅模拟接纳和生命周期，文件修改仍走真实隔离仓库。 */
  server.post('/api/projects/:projectId/conversations', async () => {
    const id = `probe_ai_${aiStates.size}`;
    aiStates.set(id, 'running');
    return { conversation: { id } };
  });
  service.register();
  service.recover();
  /** 固定选择从真实 Git 快照生成。 */
  async function inputFor(index: number, selected: string[], settings: Partial<GitDeliveryInput['settings']> = {}, mergeBranch = 'feature'): Promise<GitDeliveryInput> {
    const repository = registered[index]!;
    const snapshot = await getProjectGitRepositorySnapshot(repository.localPath);
    return {
      scope: { kind: 'conversation', conversationId: conversation.id },
      settings: { ...defaultGitDeliverySettings, ...settings },
      mode: 'merge',
      message: '交付检查',
      repositories: [{ repositoryId: repository.id, paths: selected, expectedBranch: snapshot.branch, expectedHeadSha: snapshot.headSha, mergeBranch }],
    };
  }
  /** 创建运行始终带稳定幂等身份。 */
  async function start(input: GitDeliveryInput, key: string): Promise<GitDeliveryRun> {
    const response = await server.inject({ method: 'POST', url: `/api/projects/${project.id}/git-delivery-runs`, payload: input, headers: { 'idempotency-key': key } });
    assert.equal(response.statusCode, 202, response.body);
    return response.json();
  }
  /** 手动继续原运行，后台保留既有成功步骤。 */
  async function resume(id: string): Promise<GitDeliveryRun> {
    const response = await server.inject({ method: 'POST', url: `/api/projects/${project.id}/git-delivery-runs/${id}/resume`, payload: {}, headers: { 'idempotency-key': `resume_${crypto.randomUUID()}` } });
    assert.equal(response.statusCode, 202, response.body);
    return settle(service, id);
  }
  await git(first, 'switch', '-c', 'feature');
  await writeFile(join(first, 'feature.txt'), 'feature\n');
  await git(first, 'add', '.');
  await git(first, 'commit', '-m', '来源分支');
  await git(first, 'switch', 'main');
  await writeFile(join(first, 'chosen.txt'), 'chosen\n');
  const fixed = await inputFor(0, ['chosen.txt']);
  const accepted = await start(fixed, 'run_complete_001');
  assert.equal((await start(fixed, 'run_complete_001')).id, accepted.id);
  const completed = await settle(service, accepted.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  assert.equal(await readFile(join(first, 'feature.txt'), 'utf8'), 'feature\n');
  assert.equal(await git(first, 'rev-parse', 'HEAD'), await git(root, '--git-dir', join(root, 'first.git'), 'rev-parse', 'main'));
  checked.push('普通会话提交→隔离合入→本地远端推送、重复接纳、页面无执行循环');

  const mixed = await inputFor(0, [], { commit: false, merge: false });
  const invalid = await inputFor(1, [], { commit: false, merge: false });
  invalid.repositories[0]!.expectedHeadSha = 'a'.repeat(40);
  mixed.repositories.push(...invalid.repositories);
  const partial = await settle(service, (await start(mixed, 'run_partial_001')).id);
  assert.equal(partial.state, 'attention');
  assert.equal(partial.steps[0]?.state, 'succeeded');
  assert.equal(partial.steps[1]?.state, 'attention');
  checked.push('仅推送、多仓部分失败独立推进、分支提交漂移拒绝');

  await git(second, 'switch', '-c', 'feature');
  await writeFile(join(second, 'base.txt'), 'feature conflict\n');
  await git(second, 'commit', '-am', '来源冲突');
  await git(second, 'switch', 'main');
  await writeFile(join(second, 'base.txt'), 'main conflict\n');
  await git(second, 'commit', '-am', '目标冲突');
  const conflicted = await settle(service, (await start(await inputFor(1, [], { commit: false }), 'run_conflict_001')).id);
  assert.equal(conflicted.steps[0]?.state, 'attention', JSON.stringify(conflicted));
  const conflictStep = conflicted.steps[0]!;
  const conflictUrl = `/api/projects/${project.id}/git-delivery-runs/${conflicted.id}/steps/${conflictStep.id}/conflict`;
  const conflict = (await server.inject({ method: 'GET', url: `${conflictUrl}?path=base.txt` })).json();
  const saved = await server.inject({ method: 'PUT', url: conflictUrl, payload: { path: 'base.txt', content: 'resolved\n', fingerprint: conflict.file.fingerprint } });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await resume(conflicted.id)).state, 'succeeded');
  assert.equal(await readFile(join(second, 'base.txt'), 'utf8'), 'resolved\n');
  checked.push('普通会话真实冲突、指纹保存、人工继续、成功步骤保留');

  /** 任务入口复用原提交、合入、回收和推送路由。 */
  const task = tasks.create({ projectId: project.id, title: '任务交付', taskType: 'feature', description: '', createdFrom: 'probe', sourceContext: {} });
  const taskPath = join(root, 'task-worktree');
  const sourceHead = await git(first, 'rev-parse', 'HEAD');
  await git(first, 'worktree', 'add', '-b', 'task-delivery', taskPath);
  await writeFile(join(taskPath, 'task.txt'), 'task result\n');
  const workspace = taskWorkspaces.create({
    projectId: project.id,
    taskId: task.id,
    repositoryId: registered[0]!.id,
    repositoryPath: first,
    repositoryName: 'first',
    repositoryRelativePath: 'first',
    branchName: 'task-delivery',
    sourceBranch: 'main',
    sourceHeadSha: sourceHead,
    worktreePath: taskPath,
    headSha: sourceHead,
    remoteName: 'origin',
    remoteBranch: 'task-delivery',
  });
  const taskRun = await start(
    {
      scope: { kind: 'task', taskId: task.id },
      settings: { ...defaultGitDeliverySettings },
      message: '任务交付',
      mode: 'merge',
      repositories: [{ repositoryId: workspace.id, paths: ['task.txt'], expectedBranch: 'task-delivery', expectedHeadSha: sourceHead, mergeBranch: 'main' }],
    },
    'run_task_001',
  );
  console.log('任务运行已接纳', taskRun.id);
  const taskResult = await settle(service, taskRun.id);
  assert.equal(taskResult.state, 'succeeded', JSON.stringify(taskResult));
  assert.equal(await readFile(join(first, 'task.txt'), 'utf8'), 'task result\n');
  assert.equal(await git(first, 'rev-parse', 'HEAD'), await git(root, '--git-dir', join(root, 'first.git'), 'rev-parse', 'main'));
  checked.push('任务提交→合入所选目标→工作树回收→推送的真实业务路由');

  /** 强制在推送已成功后丢失回执，恢复必须只读核对远端。 */
  const executeExternal = commands.executeExternal.bind(commands);
  let pushes = 0;
  commands.executeExternal = async (request) =>
    executeExternal({
      ...request,
      invoke: async () => {
        const result = await request.invoke();
        if ((request.parsed.input as { type?: string }).type === 'push') {
          pushes += 1;
          throw new Error('模拟推送后回执丢失');
        }
        return result;
      },
    });
  const unknown = await settle(service, (await start(await inputFor(0, [], { commit: false, merge: false }), 'run_unknown_001')).id);
  commands.executeExternal = executeExternal;
  assert.equal(unknown.steps[0]!.state, 'unknown', JSON.stringify(unknown));
  assert.equal((await resume(unknown.id)).state, 'succeeded');
  assert.equal(pushes, 1);
  checked.push('推送成功后结果未知，远端精确提交核对后完成且没有重推');

  /** AI 生命周期受控模拟：等待输入时暂停，完成后才实际合入和推送。 */
  await git(second, 'switch', '-c', 'ai-feature');
  await writeFile(join(second, 'base.txt'), 'ai source\n');
  await git(second, 'commit', '-am', 'AI 来源');
  await git(second, 'switch', 'main');
  await writeFile(join(second, 'base.txt'), 'ai target\n');
  await git(second, 'commit', '-am', 'AI 目标');
  const aiRun = await start(await inputFor(1, [], { commit: false, resolveConflicts: true }, 'ai-feature'), 'run_ai_001');
  let aiId = '';
  for (let index = 0; index < 300 && !aiId; index += 1) {
    aiId = service.repository.get(aiRun.id)!.steps[0]!.conversationId ?? '';
    if (!aiId) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(aiId);
  aiStates.set(aiId, 'waiting');
  const waiting = await settle(service, aiRun.id);
  assert.equal(waiting.steps[0]!.state, 'attention');
  assert.equal(waiting.steps[1]!.state, 'pending');
  // 人工接管先停止 AI，等待输入的会话仍可能继续写入。
  aiStates.set(aiId, 'failed');
  const aiConflictUrl = `/api/projects/${project.id}/git-delivery-runs/${aiRun.id}/steps/${waiting.steps[0]!.id}/conflict`;
  const aiConflict = (await server.inject({ method: 'GET', url: `${aiConflictUrl}?path=base.txt` })).json();
  assert.equal((await server.inject({ method: 'PUT', url: aiConflictUrl, payload: { path: 'base.txt', content: 'AI resolved\n', fingerprint: aiConflict.file.fingerprint } })).statusCode, 200);
  assert.equal((await resume(aiRun.id)).state, 'succeeded');
  assert.equal(aiStates.size, 1);
  assert.equal(db.get<{ count: number }>('SELECT count(*) AS count FROM tasks WHERE project_id=?', [project.id])!.count, 1);
  checked.push('模拟 AI 接纳、等待权限/输入暂停、人工接管后复用原会话、完成后继续推送；普通会话无替代任务');

  const mergeStep = service.repository.get(aiRun.id)!.steps.find((step) => step.action === 'merge')!;
  service.repository.updateStep(mergeStep, { state: 'unknown' });
  service.repository.updateState(aiRun.id, 'attention');
  assert.equal((await resume(aiRun.id)).state, 'succeeded');
  checked.push('已回收隔离目录的合入通过原回执恢复，不重新合入');

  const pushOnly = await settle(service, (await start(await inputFor(0, [], { commit: false, merge: false }), 'run_recovery_001')).id);
  const pushStep = service.repository.get(pushOnly.id)!.steps[0]!;
  service.repository.updateStep(pushStep, { state: 'running' });
  await service.close();
  service = new GitDeliveryExecution(dependencies);
  service.recover();
  assert.equal(service.repository.get(pushOnly.id)!.steps[0]!.state, 'running');
  /** 只有未完成运行参与重启核对，已完成运行不重新执行。 */
  service.repository.updateState(pushOnly.id, 'running');
  service.recover();
  assert.equal(service.repository.get(pushOnly.id)!.steps[0]!.state, 'unknown');
  assert.equal(service.repository.get(pushOnly.id)!.state, 'attention');
  checked.push('重启保留记录，进行中的步骤变为待核对，完成运行不自动重放');

  /** 相同公共 Git 目录必须阻止独立动作并发写入。 */
  let release!: () => void;
  const held = withGitRepositoryOperation(
    first,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(executeProjectGitAction(first, { type: 'push', remote: 'origin', sourceBranch: 'main', targetBranch: 'main' }), (error: { code?: string }) => error.code === 'ZEUS_GIT_BUSY');
  release();
  await held;
  checked.push('共用 Git 层互斥覆盖原有单步推送');
  console.log(JSON.stringify({ status: 'passed', checked, provider: '未调用真实 Provider' }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await service.close();
  await server.close();
  await db.close();
  await rm(root, { recursive: true, force: true });
}
