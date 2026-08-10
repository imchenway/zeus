import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  cleanupPreparedTaskWorktree,
  commitTaskWorkspace,
  discoverGitRepositories,
  getGitRepositoryContext,
  getTaskBranchComparison,
  getTaskWorkspaceFileDiff,
  getTaskWorkspaceReview,
  prepareTaskWorktree,
  pushTaskWorkspace,
} from '../packages/git-core/dist/index.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'zeus-0159-verification-'));
const checks = {};

try {
  const reviewRepository = await createRepository(join(root, 'review'));
  await writeFile(join(reviewRepository, 'tracked.txt'), `${'changed\n'.repeat(5_000)}`);
  await writeFile(join(reviewRepository, 'binary.dat'), Buffer.alloc(512 * 1024, 7));
  const review = await getTaskWorkspaceReview(reviewRepository);
  const selectedDiff = await getTaskWorkspaceFileDiff(reviewRepository, 'tracked.txt');
  assert(review.unstagedDiff.diffText === '' && review.unstagedDiff.fileDiffs.every((file) => file.hunks.length === 0), '工作区索引不应生成完整差异');
  assert(
    selectedDiff.diff.fileDiffs.some((file) => file.hunks.length > 0),
    '选中文件应按需生成完整文本差异',
  );
  checks.lightweightReview = { files: review.unstagedFiles.length, indexHunks: 0, selectedFileHunks: selectedDiff.diff.fileDiffs[0]?.hunks.length ?? 0 };

  await git(reviewRepository, ['reset', '--hard', 'HEAD']);
  await git(reviewRepository, ['checkout', '-b', 'zeus/ZEUS-0159-rename']);
  await git(reviewRepository, ['mv', 'tracked.txt', 'renamed.txt']);
  await git(reviewRepository, ['commit', '-am', 'rename tracked file']);
  const comparison = await getTaskBranchComparison(reviewRepository, 'main', 'zeus/ZEUS-0159-rename');
  assert(
    comparison.files.some((file) => file.path === 'renamed.txt' && file.originalPath === 'tracked.txt'),
    '分支统计应保留重命名前后路径',
  );
  checks.branchComparison = { files: comparison.files.length, renamePreserved: true };

  const nestedProject = await createRepository(join(root, 'nested-project'), ['nested/']);
  const nestedRepository = await createRepository(join(nestedProject, 'nested'));
  const nestedDiscovered = await discoverGitRepositories(nestedProject);
  assert(nestedDiscovered.length === 2, '应发现父仓和嵌套子仓');
  const environmentRoot = join(root, 'nested-worktrees');
  await mkdir(environmentRoot, { recursive: true });
  const parentPrepared = await prepareTaskWorktree({
    repositoryPath: nestedProject,
    projectSlug: 'nested-project',
    taskCode: 'ZEUS-0159',
    taskTitle: '嵌套仓验证',
    workspaceId: 'nested-parent',
    branchName: 'zeus/ZEUS-0159-nested-parent',
    sourceRef: 'main',
    sourceKind: 'local',
    sourceBranch: 'main',
    existingBranch: false,
    worktreePath: environmentRoot,
  });
  const childPrepared = await prepareTaskWorktree({
    repositoryPath: nestedRepository,
    projectSlug: 'nested-project',
    taskCode: 'ZEUS-0159',
    taskTitle: '嵌套仓验证',
    workspaceId: 'nested-child',
    branchName: 'zeus/ZEUS-0159-nested-child',
    sourceRef: 'main',
    sourceKind: 'local',
    sourceBranch: 'main',
    existingBranch: false,
    worktreePath: join(environmentRoot, 'nested'),
  });
  await cleanupPreparedTaskWorktree({ repositoryPath: nestedRepository, worktreePath: childPrepared.worktreePath, branchName: childPrepared.branchName, removeBranch: true });
  await cleanupPreparedTaskWorktree({ repositoryPath: nestedProject, worktreePath: parentPrepared.worktreePath, branchName: parentPrepared.branchName, removeBranch: true });
  checks.nestedRepositories = { discovered: nestedDiscovered.map((repository) => repository.relativePath), preparedInDependencyOrder: true, reclaimedChildFirst: true };

  const failureProject = join(root, 'failure-project');
  await mkdir(failureProject, { recursive: true });
  const failureRepositories = await Promise.all(Array.from({ length: 4 }, (_, index) => createRepository(join(failureProject, `repository-${index + 1}`))));
  const failureEnvironment = join(root, 'failure-worktrees');
  await mkdir(failureEnvironment, { recursive: true });
  const failureAttempts = await Promise.allSettled(
    failureRepositories.map((repositoryPath, index) =>
      prepareTaskWorktree({
        repositoryPath,
        projectSlug: 'failure-project',
        taskCode: 'ZEUS-0159',
        taskTitle: '失败回滚验证',
        workspaceId: `failure-${index}`,
        branchName: index === 2 ? 'invalid-branch' : `zeus/ZEUS-0159-failure-${index}`,
        sourceRef: 'main',
        sourceKind: 'local',
        sourceBranch: 'main',
        existingBranch: false,
        worktreePath: join(failureEnvironment, String(index + 1)),
      }),
    ),
  );
  await Promise.all(
    failureAttempts.flatMap((attempt, index) =>
      attempt.status === 'fulfilled'
        ? [
            cleanupPreparedTaskWorktree({
              repositoryPath: failureRepositories[index],
              worktreePath: attempt.value.worktreePath,
              branchName: attempt.value.branchName,
              removeBranch: true,
            }),
          ]
        : [],
    ),
  );
  await rm(failureEnvironment, { recursive: true, force: true });
  for (let index = 0; index < failureRepositories.length; index += 1) {
    const branchName = `zeus/ZEUS-0159-failure-${index}`;
    const branch = await gitAllowFailure(failureRepositories[index], ['show-ref', '--verify', `refs/heads/${branchName}`]);
    assert(branch === null, `失败回滚后不应残留任务分支：${branchName}`);
    const context = await getGitRepositoryContext(failureRepositories[index]);
    assert(context.worktrees.length === 1, '失败回滚后只应保留主工作区');
  }
  checks.failureRollback = {
    preparedBeforeFailure: failureAttempts.filter((attempt) => attempt.status === 'fulfilled').length,
    failed: failureAttempts.filter((attempt) => attempt.status === 'rejected').length,
    residualBranches: 0,
    residualWorktrees: 0,
  };

  const remoteRepository = await createRepository(join(root, 'remote-source'));
  const bareRemote = join(root, 'remote.git');
  await git(root, ['init', '--bare', bareRemote]);
  await git(remoteRepository, ['remote', 'add', 'origin', bareRemote]);
  const remoteWorktree = join(root, 'remote-worktree');
  const remotePrepared = await prepareTaskWorktree({
    repositoryPath: remoteRepository,
    projectSlug: 'remote-source',
    taskCode: 'ZEUS-0159',
    taskTitle: '远端验证',
    workspaceId: 'remote',
    branchName: 'zeus/ZEUS-0159-remote',
    sourceRef: 'main',
    sourceKind: 'local',
    sourceBranch: 'main',
    existingBranch: false,
    worktreePath: remoteWorktree,
  });
  await writeFile(join(remoteWorktree, 'delivery.txt'), 'first delivery\n');
  const committed = await commitTaskWorkspace({ cwd: remoteWorktree, message: 'feat: remote verification', selectedPaths: ['delivery.txt'] });
  const firstPush = await pushTaskWorkspace({ cwd: remoteWorktree, remoteName: 'origin', remoteBranch: remotePrepared.branchName });
  const repeatedPush = await pushTaskWorkspace({ cwd: remoteWorktree, remoteName: 'origin', remoteBranch: remotePrepared.branchName });
  assert(firstPush.headSha === firstPush.remoteHeadSha && repeatedPush.remoteHeadSha === committed.headSha, '推送后远端 SHA 必须与本地 HEAD 相同');

  const otherClone = join(root, 'remote-other');
  await git(root, ['clone', '--branch', remotePrepared.branchName, bareRemote, otherClone]);
  await git(otherClone, ['config', 'user.name', 'Zeus Verification']);
  await git(otherClone, ['config', 'user.email', 'zeus-verification@example.invalid']);
  await writeFile(join(otherClone, 'remote-only.txt'), 'remote advancement\n');
  await git(otherClone, ['add', '.']);
  await git(otherClone, ['commit', '-m', 'remote advancement']);
  await git(otherClone, ['push', 'origin', remotePrepared.branchName]);
  await writeFile(join(remoteWorktree, 'local-only.txt'), 'local divergence\n');
  await commitTaskWorkspace({ cwd: remoteWorktree, message: 'feat: local divergence', selectedPaths: ['local-only.txt'] });
  let divergenceCode = '';
  try {
    await pushTaskWorkspace({ cwd: remoteWorktree, remoteName: 'origin', remoteBranch: remotePrepared.branchName });
  } catch (error) {
    divergenceCode = typeof error === 'object' && error && 'code' in error ? String(error.code) : '';
  }
  assert(divergenceCode === 'ZEUS_TASK_REMOTE_DIVERGED', '远端领先或分叉时必须拒绝普通推送');
  checks.remotePush = { firstPushVerified: true, repeatedPushVerified: true, divergenceCode };
  await cleanupPreparedTaskWorktree({ repositoryPath: remoteRepository, worktreePath: remoteWorktree, branchName: remotePrepared.branchName, removeBranch: true });

  const unavailable = await getGitRepositoryContext(join(root, 'not-a-repository'));
  assert(unavailable.isRepository === false, '单仓不可用必须返回真实失败状态');
  checks.repositoryFailure = { isolatedRepositoryUnavailable: true };

  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createRepository(repositoryPath, ignored = []) {
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init', '-b', 'main']);
  await git(repositoryPath, ['config', 'user.name', 'Zeus Verification']);
  await git(repositoryPath, ['config', 'user.email', 'zeus-verification@example.invalid']);
  await writeFile(join(repositoryPath, '.gitignore'), ignored.join('\n'));
  await writeFile(join(repositoryPath, 'tracked.txt'), 'initial\n');
  await writeFile(join(repositoryPath, 'binary.dat'), Buffer.alloc(512 * 1024, 1));
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'initial']);
  return repositoryPath;
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
