import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  cleanupTaskIntegrationWorktree,
  completeTaskIntegrationCommit,
  finalizeTaskBranchIntegration,
  readTaskIntegrationConflict,
  startTaskBranchIntegration,
  startTaskIntegrationAttempt,
  writeTaskIntegrationResolution,
} from '../packages/git-core/dist/index.js';

/** Promise 形式的进程执行入口。 */
const execFileAsync = promisify(execFile);
/** 所有场景共用且退出时删除的临时根目录。 */
const probeRoot = await mkdtemp(join(tmpdir(), 'zeus-0728-git-'));

try {
  /** 无关文件继续走 Git 原生快进。 */
  const unrelated = await verifyUnrelatedLocalChanges();
  /** 同文件不同位置由隔离三方合并自动处理。 */
  const automatic = await verifyAutomaticallyMergedLocalChanges();
  /** 同行冲突由现有手工工作台处理。 */
  const manual = await verifyManualLocalConflict();
  /** 同一来源草稿快照可以复制到 AI 命名工作区。 */
  const ai = await verifyAiLocalConflictAttempt();
  /** 处理期间来源现场变化必须拒绝覆盖。 */
  const concurrent = await verifyConcurrentSourceChange();
  process.stdout.write(`${JSON.stringify({ unrelated, automatic, manual, ai, concurrent }, null, 2)}\n`);
} finally {
  await rm(probeRoot, { recursive: true, force: true });
}

/** 创建带 main 与任务 worktree 的最小真实 Git 仓库。 */
async function createScenario(name, baseContent = 'base\n') {
  /** 当前场景的独立目录。 */
  const scenarioRoot = join(probeRoot, name);
  /** main 分支真实检出目录。 */
  const repositoryPath = join(scenarioRoot, 'repository');
  /** 任务分支独立 worktree。 */
  const taskWorktreePath = join(scenarioRoot, 'task');
  /** 当前场景任务分支名。 */
  const taskBranch = `zeus/ZEUS-0728-${name}`;
  await mkdir(repositoryPath, { recursive: true });
  await git(repositoryPath, 'init', '-b', 'main');
  await git(repositoryPath, 'config', 'user.name', 'Zeus Verification');
  await git(repositoryPath, 'config', 'user.email', 'zeus-verification@example.invalid');
  await writeFile(join(repositoryPath, 'shared.txt'), baseContent);
  await writeFile(join(repositoryPath, 'source-only.txt'), 'base\n');
  await git(repositoryPath, 'add', '.');
  await git(repositoryPath, 'commit', '-m', '基础提交');
  await git(repositoryPath, 'worktree', 'add', '-b', taskBranch, taskWorktreePath, 'main');
  return { name, repositoryPath, taskWorktreePath, taskBranch };
}

/** 为任务分支提交指定文件内容。 */
async function commitTaskFile(scenario, path, content) {
  await writeFile(join(scenario.taskWorktreePath, path), content);
  await git(scenario.taskWorktreePath, 'add', path);
  await git(scenario.taskWorktreePath, 'commit', '-m', `任务成果 ${scenario.name}`);
}

/** 创建正式隔离合入候选。 */
async function startIntegration(scenario) {
  /** 当前场景稳定的合入身份。 */
  const integrationId = `integration-${scenario.name}`;
  return startTaskBranchIntegration({
    repositoryPath: scenario.repositoryPath,
    projectSlug: `zeus-0728-${scenario.name}`,
    integrationId,
    targetBranch: 'main',
    taskBranch: scenario.taskBranch,
    mode: 'merge',
    commitMessage: `ZEUS-0728 ${scenario.name}`,
  });
}

/** 使用候选记录中的精确提交执行本地来源同步。 */
async function finalizeIntegration(scenario, started, integrationPath = started.integrationPath, resultHeadSha = started.resultHeadSha) {
  assertProbe(resultHeadSha, `${scenario.name}: 合入候选缺少结果提交`);
  return finalizeTaskBranchIntegration({
    repositoryPath: scenario.repositoryPath,
    integrationPath,
    targetBranch: 'main',
    targetHeadSha: started.targetHeadSha,
    resultHeadSha,
  });
}

/** 验证不同文件的来源草稿仍由 Git 原生保留。 */
async function verifyUnrelatedLocalChanges() {
  /** 无关文件场景。 */
  const scenario = await createScenario('unrelated');
  await commitTaskFile(scenario, 'task-only.txt', 'task\n');
  await writeFile(join(scenario.repositoryPath, 'source-only.txt'), 'local\n');
  /** 隔离任务合入候选。 */
  const started = await startIntegration(scenario);
  /** 来源同步结果。 */
  const finalized = await finalizeIntegration(scenario, started);
  assertProbe(finalized.localSyncStatus === 'synced' && finalized.conflictFiles.length === 0, '无关来源草稿应直接安全快进');
  assertProbe((await readFile(join(scenario.repositoryPath, 'source-only.txt'), 'utf8')) === 'local\n', '无关来源草稿必须保留');
  return { status: finalized.localSyncStatus, localChangesPreserved: true };
}

/** 验证同一文件不同位置的修改可以自动三方合并。 */
async function verifyAutomaticallyMergedLocalChanges() {
  /** 可自动合并场景。 */
  const scenario = await createScenario('automatic', 'first base\nmiddle\nlast base\n');
  await commitTaskFile(scenario, 'shared.txt', 'first task\nmiddle\nlast base\n');
  await writeFile(join(scenario.repositoryPath, 'shared.txt'), 'first base\nmiddle\nlast local\n');
  await git(scenario.repositoryPath, 'add', 'shared.txt');
  /** 隔离任务合入候选。 */
  const started = await startIntegration(scenario);
  /** 来源同步结果。 */
  const finalized = await finalizeIntegration(scenario, started);
  assertProbe(finalized.localSyncStatus === 'synced' && finalized.conflictFiles.length === 0, '可自动合并的来源草稿应完成落地');
  assertProbe((await readFile(join(scenario.repositoryPath, 'shared.txt'), 'utf8')) === 'first task\nmiddle\nlast local\n', '自动合并必须同时保留任务与来源内容');
  assertProbe((await git(scenario.repositoryPath, 'show', 'HEAD:shared.txt')) === 'first task\nmiddle\nlast base', '目标分支提交不得吸收来源草稿');
  assertProbe((await git(scenario.repositoryPath, 'status', '--porcelain=v1', '--', 'shared.txt')).startsWith(' M '), '来源草稿落回后应保持未暂存');
  return { status: finalized.localSyncStatus, localChangesUnstaged: true };
}

/** 建立来源草稿与任务成果修改同一行的真实冲突。 */
async function prepareConflictScenario(name) {
  /** 当前冲突场景。 */
  const scenario = await createScenario(name);
  await commitTaskFile(scenario, 'shared.txt', 'task\n');
  await writeFile(join(scenario.repositoryPath, 'shared.txt'), 'source local\n');
  await git(scenario.repositoryPath, 'add', 'shared.txt');
  /** 隔离任务合入候选。 */
  const started = await startIntegration(scenario);
  /** 首次同步应返回可处理冲突。 */
  const conflicted = await finalizeIntegration(scenario, started);
  assertProbe(conflicted.localSyncStatus === 'pending' && conflicted.conflictFiles.join(',') === 'shared.txt', `${name}: 重叠来源草稿应返回真实冲突`);
  /** 三栏冲突内容。 */
  const conflict = await readTaskIntegrationConflict(started.integrationPath, 'shared.txt');
  assertProbe(conflict.source === 'source local\n' && conflict.task === 'task\n', `${name}: 来源与任务两栏不能颠倒`);
  assertProbe((await git(scenario.repositoryPath, 'show', 'HEAD:shared.txt')) === 'base', `${name}: 处理前来源分支不得推进`);
  assertProbe((await readFile(join(scenario.repositoryPath, 'shared.txt'), 'utf8')) === 'source local\n', `${name}: 处理前来源草稿不得变化`);
  return { scenario, started, conflict };
}

/** 验证手工冲突解决只改变最终工作区，不提交来源草稿。 */
async function verifyManualLocalConflict() {
  /** 手工冲突现场。 */
  const prepared = await prepareConflictScenario('manual');
  await writeTaskIntegrationResolution(prepared.started.integrationPath, 'shared.txt', 'manual resolved\n');
  /** 冲突处理完成后仍返回任务合入提交。 */
  const commit = await completeTaskIntegrationCommit({ integrationPath: prepared.started.integrationPath, mode: 'merge', commitMessage: '手工解决来源草稿冲突' });
  /** 最终来源同步结果。 */
  const finalized = await finalizeIntegration(prepared.scenario, prepared.started, prepared.started.integrationPath, commit.resultHeadSha);
  assertProbe(finalized.localSyncStatus === 'synced', '手工解决后应完成目标分支同步');
  assertProbe((await readFile(join(prepared.scenario.repositoryPath, 'shared.txt'), 'utf8')) === 'manual resolved\n', '手工结果必须落回来源工作区');
  assertProbe((await git(prepared.scenario.repositoryPath, 'show', 'HEAD:shared.txt')) === 'task', '手工结果不得偷偷提交来源草稿');
  assertProbe((await git(prepared.scenario.repositoryPath, 'status', '--porcelain=v1', '--', 'shared.txt')).startsWith(' M '), '手工结果必须保持未暂存');
  assertProbe(!existsSync(prepared.started.integrationPath), '完成后应回收原隔离合入 worktree');
  return { status: finalized.localSyncStatus, sourceDraftCommitted: false };
}

/** 验证 AI 命名冲突工作区复制同一来源草稿快照并可安全落地。 */
async function verifyAiLocalConflictAttempt() {
  /** AI 冲突现场。 */
  const prepared = await prepareConflictScenario('ai');
  /** AI 使用的独立命名冲突分支。 */
  const attempt = await startTaskIntegrationAttempt({
    repositoryPath: prepared.scenario.repositoryPath,
    projectSlug: 'zeus-0728-ai',
    integrationId: 'integration-ai',
    attemptId: 'attempt-ai',
    targetBranch: 'main',
    targetHeadSha: prepared.started.targetHeadSha,
    taskBranch: prepared.scenario.taskBranch,
    taskHeadSha: await git(prepared.scenario.taskWorktreePath, 'rev-parse', 'HEAD'),
    conflictBranch: 'zeus/ZEUS-0728-ai-merge',
    mode: 'merge',
    commitMessage: 'AI 解决来源草稿冲突',
    localChangesFromPath: prepared.started.integrationPath,
  });
  assertProbe(attempt.state === 'conflicted' && attempt.localChangesConflict === true && attempt.conflictFiles.join(',') === 'shared.txt', 'AI 命名工作区必须复现并标识来源草稿冲突');
  /** AI 工作区三栏冲突内容。 */
  const conflict = await readTaskIntegrationConflict(attempt.integrationPath, 'shared.txt');
  assertProbe(conflict.source === prepared.conflict.source && conflict.task === prepared.conflict.task, 'AI 工作区必须沿用同一来源与任务内容');
  await writeTaskIntegrationResolution(attempt.integrationPath, 'shared.txt', 'ai resolved\n');
  /** AI 处理后仍只返回任务合入提交。 */
  const commit = await completeTaskIntegrationCommit({ integrationPath: attempt.integrationPath, mode: 'merge', commitMessage: 'AI 解决来源草稿冲突' });
  /** AI 结果最终同步。 */
  const finalized = await finalizeIntegration(prepared.scenario, prepared.started, attempt.integrationPath, commit.resultHeadSha);
  assertProbe(finalized.localSyncStatus === 'synced', 'AI 解决后应完成目标分支同步');
  assertProbe((await readFile(join(prepared.scenario.repositoryPath, 'shared.txt'), 'utf8')) === 'ai resolved\n', 'AI 结果必须落回来源工作区');
  assertProbe((await git(prepared.scenario.repositoryPath, 'show', 'HEAD:shared.txt')) === 'task', 'AI 结果不得偷偷提交来源草稿');
  await cleanupTaskIntegrationWorktree({ repositoryPath: prepared.scenario.repositoryPath, integrationPath: prepared.started.integrationPath });
  return { status: finalized.localSyncStatus, conflictCopied: true };
}

/** 验证隔离处理期间的并发来源编辑不会被覆盖。 */
async function verifyConcurrentSourceChange() {
  /** 并发编辑场景。 */
  const prepared = await prepareConflictScenario('concurrent');
  await writeTaskIntegrationResolution(prepared.started.integrationPath, 'shared.txt', 'resolved before concurrent edit\n');
  /** 已完成冲突编辑但尚未落地的任务提交。 */
  const commit = await completeTaskIntegrationCommit({ integrationPath: prepared.started.integrationPath, mode: 'merge', commitMessage: '并发保护' });
  await writeFile(join(prepared.scenario.repositoryPath, 'shared.txt'), 'new concurrent edit\n');
  /** 是否得到稳定的并发变化错误。 */
  let rejected = false;
  try {
    await finalizeIntegration(prepared.scenario, prepared.started, prepared.started.integrationPath, commit.resultHeadSha);
  } catch (error) {
    rejected = error instanceof Error && error.code === 'ZEUS_TARGET_WORKTREE_CHANGED';
  }
  assertProbe(rejected, '来源现场变化后必须拒绝落地');
  assertProbe((await readFile(join(prepared.scenario.repositoryPath, 'shared.txt'), 'utf8')) === 'new concurrent edit\n', '并发来源编辑必须原样保留');
  assertProbe((await git(prepared.scenario.repositoryPath, 'show', 'HEAD:shared.txt')) === 'base', '拒绝落地时来源分支不得推进');
  await cleanupTaskIntegrationWorktree({ repositoryPath: prepared.scenario.repositoryPath, integrationPath: prepared.started.integrationPath });
  return { rejected, sourcePreserved: true };
}

/** 执行真实 Git 命令并返回去除结尾换行的标准输出。 */
async function git(cwd, ...args) {
  /** Git 命令结果。 */
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trimEnd();
}

/** 探针断言失败时立即给出产品行为原因。 */
function assertProbe(condition, message) {
  if (!condition) throw new Error(message);
}
