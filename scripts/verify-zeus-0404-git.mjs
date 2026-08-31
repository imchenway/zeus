import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { finalizeTaskBranchIntegration, startTaskBranchIntegration } from '../packages/git-core/dist/index.js';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'zeus-0404-git-'));

try {
  const unrelated = await verifyDirtySourceWorktree('unrelated');
  const overlapping = await verifyDirtySourceWorktree('overlapping');
  process.stdout.write(`${JSON.stringify({ unrelated, overlapping }, null, 2)}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function verifyDirtySourceWorktree(kind) {
  const scenarioRoot = join(root, kind);
  const repositoryPath = join(scenarioRoot, 'repository');
  const taskWorktreePath = join(scenarioRoot, 'task-worktree');
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, ['init', '-b', 'main']);
  await git(repositoryPath, ['config', 'user.name', 'Zeus Verification']);
  await git(repositoryPath, ['config', 'user.email', 'zeus-verification@example.invalid']);
  await writeFile(join(repositoryPath, 'shared.txt'), 'base\n');
  await writeFile(join(repositoryPath, 'source-only.txt'), 'base\n');
  await git(repositoryPath, ['add', '.']);
  await git(repositoryPath, ['commit', '-m', 'initial']);
  const targetHeadSha = await revParse(repositoryPath, 'HEAD');

  await git(repositoryPath, ['worktree', 'add', '-b', `zeus/ZEUS-0404-${kind}`, taskWorktreePath, 'main']);
  const taskPath = kind === 'overlapping' ? 'shared.txt' : 'task-only.txt';
  await writeFile(join(taskWorktreePath, taskPath), 'task result\n');
  await git(taskWorktreePath, ['add', taskPath]);
  await git(taskWorktreePath, ['commit', '-m', `task ${kind}`]);

  const localPath = kind === 'overlapping' ? 'shared.txt' : 'source-only.txt';
  await writeFile(join(repositoryPath, localPath), 'local uncommitted\n');
  const started = await startTaskBranchIntegration({
    repositoryPath,
    projectSlug: `zeus-0404-${kind}`,
    integrationId: `integration-${kind}`,
    targetBranch: 'main',
    taskBranch: `zeus/ZEUS-0404-${kind}`,
    mode: 'merge',
    commitMessage: `ZEUS-0404 ${kind}`,
  });
  assert(started.state === 'ready' && started.resultHeadSha, `${kind}: 合入候选应无冲突完成`);
  const finalized = await finalizeTaskBranchIntegration({
    repositoryPath,
    integrationPath: started.integrationPath,
    targetBranch: 'main',
    targetHeadSha: started.targetHeadSha,
    resultHeadSha: started.resultHeadSha,
  });

  assert((await readFile(join(repositoryPath, localPath), 'utf8')) === 'local uncommitted\n', `${kind}: 来源工作区改动不得丢失`);
  if (kind === 'unrelated') {
    assert(finalized.localSyncStatus === 'synced', '无关脏改动应允许来源分支安全快进');
    assert((await revParse(repositoryPath, 'HEAD')) === started.resultHeadSha, '安全快进后来源分支必须指向候选提交');
  } else {
    assert(finalized.localSyncStatus === 'pending', '重叠脏改动应保留隔离候选等待重试');
    assert((await revParse(repositoryPath, 'HEAD')) === targetHeadSha, '重叠脏改动不得推进来源分支');
  }
  return { localSyncStatus: finalized.localSyncStatus, localChangesPreserved: true };
}

async function git(cwd, args) {
  return execFileAsync('git', args, { cwd });
}

async function revParse(cwd, ref) {
  const result = await git(cwd, ['rev-parse', ref]);
  return result.stdout.trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
