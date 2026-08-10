import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { promisify } from 'node:util';
import { cleanupPreparedTaskWorktree, discoverGitRepositories, prepareTaskWorktree } from '../packages/git-core/dist/index.js';

const execFileAsync = promisify(execFile);
const repositoryCounts = [1, 4, 8];
const rounds = 3;
const root = await mkdtemp(join(tmpdir(), 'zeus-0159-benchmark-'));

try {
  const capabilityResults = [];
  for (const count of repositoryCounts) {
    const projectPath = join(root, `project-${count}`);
    const repositories = await createSiblingRepositories(projectPath, count);
    const before = [];
    const after = [];
    for (let round = 0; round < rounds; round += 1) {
      if (round % 2 === 0) {
        before.push(await elapsed(() => readCapabilitiesBefore(projectPath, repositories)));
        after.push(await elapsed(() => discoverGitRepositories(projectPath)));
      } else {
        after.push(await elapsed(() => discoverGitRepositories(projectPath)));
        before.push(await elapsed(() => readCapabilitiesBefore(projectPath, repositories)));
      }
    }
    capabilityResults.push({
      repositories: count,
      beforeMedianMs: median(before),
      afterMedianMs: median(after),
      improvementPercent: percentImprovement(median(before), median(after)),
      beforeGitCommands: count * 29,
      afterGitCommands: count * 8,
    });
  }

  const preparationProject = join(root, 'preparation');
  const preparationRepositories = await createSiblingRepositories(preparationProject, 8);
  const sequential = [];
  const concurrent = [];
  for (let round = 0; round < rounds; round += 1) {
    sequential.push(await measurePreparation(preparationRepositories, join(root, `worktrees-sequential-${round}`), `zeus/ZEUS-0159-sequential-${round}`, false));
    concurrent.push(await measurePreparation(preparationRepositories, join(root, `worktrees-concurrent-${round}`), `zeus/ZEUS-0159-concurrent-${round}`, true));
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        capabilityResults,
        preparation: {
          repositories: preparationRepositories.length,
          sequentialMedianMs: median(sequential),
          concurrentMedianMs: median(concurrent),
          improvementPercent: percentImprovement(median(sequential), median(concurrent)),
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

async function createSiblingRepositories(projectPath, count) {
  await mkdir(projectPath, { recursive: true });
  const repositories = [];
  for (let index = 0; index < count; index += 1) {
    const repositoryPath = join(projectPath, `repository-${index + 1}`);
    await mkdir(repositoryPath, { recursive: true });
    await git(repositoryPath, ['init', '-b', 'main']);
    await git(repositoryPath, ['config', 'user.name', 'Zeus Benchmark']);
    await git(repositoryPath, ['config', 'user.email', 'zeus-benchmark@example.invalid']);
    await writeFile(join(repositoryPath, 'tracked.txt'), `${'initial line\n'.repeat(400)}repository ${index + 1}\n`);
    await writeFile(join(repositoryPath, 'binary.dat'), Buffer.alloc(256 * 1024, index));
    await git(repositoryPath, ['add', '.']);
    await git(repositoryPath, ['commit', '-m', 'initial']);
    await writeFile(join(repositoryPath, 'tracked.txt'), `${'changed line\n'.repeat(4_000)}repository ${index + 1}\n`);
    await writeFile(join(repositoryPath, 'binary.dat'), Buffer.alloc(256 * 1024, index + 1));
    repositories.push(repositoryPath);
  }
  return repositories;
}

async function readCapabilitiesBefore(projectPath, repositories) {
  await Promise.all(
    repositories.map(async (repositoryPath) => {
      await Promise.all([oldRepositoryContext(repositoryPath), oldGitStatus(repositoryPath)]);
    }),
  );
  await Promise.all(
    repositories.map(async (repositoryPath) => {
      await oldRepositoryContext(repositoryPath);
      await oldWorkspaceReview(repositoryPath);
    }),
  );
  return projectPath;
}

async function oldRepositoryContext(cwd) {
  await git(cwd, ['rev-parse', '--show-toplevel']);
  await git(cwd, ['branch', '--show-current']);
  await git(cwd, ['rev-parse', 'HEAD']);
  await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  await git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/remotes']);
  await git(cwd, ['remote']);
  await git(cwd, ['worktree', 'list', '--porcelain']);
}

async function oldGitStatus(cwd) {
  await git(cwd, ['branch', '--show-current']);
  await git(cwd, ['status', '--porcelain', '-z']);
  await git(cwd, ['branch', '-r', '--format=%(refname:short)']);
  await git(cwd, ['log', '-n', '5', '--pretty=format:%H%x1f%h%x1f%s%x1f%an%x1f%aI']);
}

async function oldWorkspaceReview(cwd) {
  await oldRepositoryContext(cwd);
  await git(cwd, ['status', '--porcelain=v1', '-z', '-uall']);
  await gitAllowFailure(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  await git(cwd, ['diff', '--binary', '--', '.']);
  await git(cwd, ['diff', '--cached', '--binary', '--', '.']);
}

async function measurePreparation(repositories, worktreeRoot, branchName, useConcurrency) {
  await mkdir(worktreeRoot, { recursive: true });
  const prepare = (repositoryPath, index) =>
    prepareTaskWorktree({
      repositoryPath,
      projectSlug: 'zeus-0159-benchmark',
      taskCode: 'ZEUS-0159',
      taskTitle: '多仓性能验证',
      workspaceId: `${branchName}-${index}`,
      branchName,
      sourceRef: 'main',
      sourceKind: 'local',
      sourceBranch: 'main',
      existingBranch: false,
      worktreePath: join(worktreeRoot, String(index + 1)),
    });
  const startedAt = performance.now();
  const prepared = useConcurrency ? await Promise.all(repositories.map(prepare)) : await sequentialMap(repositories, prepare);
  const duration = performance.now() - startedAt;
  await Promise.all(
    prepared.map((entry, index) =>
      cleanupPreparedTaskWorktree({
        repositoryPath: repositories[index],
        worktreePath: entry.worktreePath,
        branchName: entry.branchName,
        removeBranch: true,
      }),
    ),
  );
  return duration;
}

async function sequentialMap(items, operation) {
  const results = [];
  for (let index = 0; index < items.length; index += 1) results.push(await operation(items[index], index));
  return results;
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

async function elapsed(operation) {
  const startedAt = performance.now();
  await operation();
  return performance.now() - startedAt;
}

function median(values) {
  return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)];
}

function percentImprovement(before, after) {
  return Number((((before - after) / before) * 100).toFixed(1));
}
