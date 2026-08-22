import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { prepareTaskWorktree } from '../packages/git-core/dist/index.js';
import { createLocalServer } from '../packages/local-server/dist/index.js';
import { createZeusDatabase, ProjectRepository, ProjectRepositoryRegistrationRepository, TaskEnvironmentRepository, TaskRepository, TaskWorkspaceRepository } from '../packages/storage/dist/index.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'zeus-0159-api-'));
const keepFixture = process.env.ZEUS_KEEP_FIXTURE === '1';
let server;

try {
  const projectPath = join(root, 'project');
  const environmentPath = join(root, 'task-environment');
  const repositories = [];
  await mkdir(projectPath, { recursive: true });
  await mkdir(environmentPath, { recursive: true });
  for (let index = 0; index < 3; index += 1) {
    const repositoryPath = join(projectPath, `repository-${index + 1}`);
    await createRepository(repositoryPath);
    const sourceHeadSha = (await git(repositoryPath, ['rev-parse', 'HEAD'])).stdout.trim();
    let remoteName = '';
    let remotePath = '';
    if (index === 0) {
      remotePath = join(root, 'valid-remote.git');
      await git(root, ['init', '--bare', remotePath]);
      await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
      remoteName = 'origin';
    } else if (index === 1) {
      remotePath = join(root, 'missing-remote.git');
      await git(repositoryPath, ['remote', 'add', 'origin', remotePath]);
      remoteName = 'origin';
    }
    const branchName = `zeus/ZEUS-0159-api-${index + 1}`;
    const prepared = await prepareTaskWorktree({
      repositoryPath,
      projectSlug: 'api-project',
      taskCode: 'ZEUS-0159',
      taskTitle: '接口验证',
      workspaceId: `api-${index + 1}`,
      branchName,
      sourceRef: 'main',
      sourceKind: 'local',
      sourceBranch: 'main',
      existingBranch: false,
      worktreePath: join(environmentPath, `repository-${index + 1}`),
    });
    repositories.push({ repositoryPath, sourceHeadSha, remoteName, remotePath, branchName, prepared });
  }

  await writeFile(join(repositories[0].prepared.worktreePath, 'batch.txt'), 'repository one\n');
  await writeFile(join(repositories[2].prepared.worktreePath, 'batch.txt'), 'repository three\n');
  await writeFile(join(repositories[1].prepared.worktreePath, 'conflict.txt'), 'task branch\n');
  await git(repositories[1].prepared.worktreePath, ['add', '.']);
  await git(repositories[1].prepared.worktreePath, ['commit', '-m', 'task conflict side']);
  await writeFile(join(repositories[1].repositoryPath, 'conflict.txt'), 'source branch\n');
  await git(repositories[1].repositoryPath, ['add', '.']);
  await git(repositories[1].repositoryPath, ['commit', '-m', 'source conflict side']);
  await gitAllowFailure(repositories[1].prepared.worktreePath, ['merge', 'main']);

  const dbPath = join(root, 'data', 'zeus.db');
  await mkdir(join(root, 'data'), { recursive: true });
  const db = await createZeusDatabase(dbPath);
  const project = new ProjectRepository(db).create({ name: 'ZEUS-0159 API', localPath: projectPath });
  const task = new TaskRepository(db).create({
    projectId: project.id,
    title: '多仓批量接口验证',
    taskType: 'optimization',
    description: '',
    optimizationCurrentState: '逐仓操作',
    optimizationExpectedOutcome: '批量操作',
    createdFrom: 'verification',
    sourceContext: {},
    managementStatus: 'todo',
    allowCodeChanges: true,
    allowGitCommit: true,
  });
  const registered = new ProjectRepositoryRegistrationRepository(db).replaceForProject(
    project.id,
    repositories.map((repository, index) => ({
      projectId: project.id,
      name: `repository-${index + 1}`,
      relativePath: `repository-${index + 1}`,
      localPath: repository.repositoryPath,
    })),
  );
  const environment = new TaskEnvironmentRepository(db).create({ projectId: project.id, taskId: task.id, rootPath: environmentPath });
  const workspaceRepository = new TaskWorkspaceRepository(db);
  const workspaces = repositories.map((repository, index) =>
    workspaceRepository.create({
      projectId: project.id,
      taskId: task.id,
      environmentId: environment.id,
      repositoryId: registered[index].id,
      repositoryName: `repository-${index + 1}`,
      repositoryRelativePath: `repository-${index + 1}`,
      repositoryPath: repository.repositoryPath,
      branchName: repository.branchName,
      sourceBranch: 'main',
      sourceHeadSha: repository.sourceHeadSha,
      remoteName: repository.remoteName,
      remoteBranch: repository.branchName,
      worktreePath: repository.prepared.worktreePath,
      headSha: repository.prepared.headSha,
      state: 'ready',
    }),
  );
  await db.close();

  const apiToken = 'zeus-0159-api-token';
  server = await createLocalServer({ dbPath, apiToken, keychainService: 'Zeus Test ZEUS-0159 API Verifier', codexNativeEnabled: false, projectRoot: projectPath, localConfigPath: join(root, 'local-config.json') });
  await server.ready();
  const inject = (method, url, payload) =>
    server.inject({
      method,
      url,
      headers: { authorization: `Bearer ${apiToken}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
      ...(payload ? { payload: JSON.stringify(payload) } : {}),
    });

  const indexResponse = await inject('GET', `/api/tasks/${task.id}/git-workspaces/index`);
  assert(indexResponse.statusCode === 200 && indexResponse.json().items.length === 3, '轻量工作区索引应返回三个仓库');
  const firstDetail = await inject('GET', `/api/tasks/${task.id}/git-workspaces/${workspaces[0].id}/snapshot`);
  assert(firstDetail.statusCode === 200 && firstDetail.json().workspace.id === workspaces[0].id, '单仓详情接口应只返回目标仓库');

  const commitResponse = await inject('POST', `/api/tasks/${task.id}/git-workspaces/commit-all`, { message: 'feat: ZEUS-0159 batch API verification' });
  const commitBody = commitResponse.json();
  assert(commitResponse.statusCode === 200, '批量提交接口应返回逐仓结果');
  assert(commitBody.summary.succeeded === 2 && commitBody.summary.failed === 1, '批量提交应允许两个成功和一个真实冲突失败并存');
  const successfulHeads = await Promise.all([repositories[0], repositories[2]].map((repository) => git(repository.prepared.worktreePath, ['rev-parse', 'HEAD']).then((result) => result.stdout.trim())));
  assert(
    successfulHeads.every((head, index) => head !== repositories[index === 0 ? 0 : 2].prepared.headSha),
    '其他仓库失败不得回滚已成功提交',
  );

  await git(repositories[1].prepared.worktreePath, ['merge', '--abort']);
  const pushResponse = await inject('POST', `/api/tasks/${task.id}/git-workspaces/push-all`, {});
  const pushBody = pushResponse.json();
  assert(pushResponse.statusCode === 200, '批量推送接口应返回逐仓结果');
  assert(pushBody.summary.succeeded === 1 && pushBody.summary.failed === 1 && pushBody.summary.skipped === 1, '批量推送应区分成功、远端失败和无远端跳过');
  const remoteHead = (await git(root, ['--git-dir', repositories[0].remotePath, 'rev-parse', `refs/heads/${repositories[0].branchName}`])).stdout.trim();
  assert(remoteHead === successfulHeads[0], '批量推送成功后远端 SHA 必须等于本地 HEAD');

  const failedDetail = await inject('GET', `/api/tasks/${task.id}/git-workspaces/${workspaces[1].id}/snapshot`);
  const healthyDetail = await inject('GET', `/api/tasks/${task.id}/git-workspaces/${workspaces[2].id}/snapshot`);
  assert(failedDetail.statusCode === 200 && healthyDetail.statusCode === 200, '一个仓库操作失败后其他仓库详情仍应可读取');

  process.stdout.write(
    `${JSON.stringify(
      {
        indexItems: indexResponse.json().items.length,
        selectedDetailWorkspaceId: firstDetail.json().workspace.id,
        commitSummary: commitBody.summary,
        pushSummary: pushBody.summary,
        successfulCommitsPreserved: true,
        remoteShaVerified: true,
        repositoryErrorIsolation: true,
        ...(keepFixture ? { fixtureRoot: root, taskId: task.id, projectId: project.id } : {}),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (server) await server.close().catch(() => undefined);
  if (!keepFixture) await rm(root, { recursive: true, force: true });
}

async function createRepository(repositoryPath) {
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init', '-b', 'main']);
  await git(repositoryPath, ['config', 'user.name', 'Zeus Verification']);
  await git(repositoryPath, ['config', 'user.email', 'zeus-verification@example.invalid']);
  await writeFile(join(repositoryPath, 'tracked.txt'), 'initial\n');
  await writeFile(join(repositoryPath, 'conflict.txt'), 'initial\n');
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'initial']);
}

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 });
}

async function gitAllowFailure(cwd, args) {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
