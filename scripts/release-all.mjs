#!/usr/bin/env node
/* global console, process */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { commandFailureDetail, commandResultSucceeded, releaseRemoteReadAttempts, releaseRemoteReadTimeoutMs, runRemoteReadWithRetrySync } from './release-remote-read.mjs';
import { releaseWorkflowWaitLimitMs } from './release-workflow-wait-policy.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const repository = 'imchenway/zeus';
const releaseFiles = ['package.json', 'apps/desktop/package.json'];
const formatExtensions = new Set(['.ts', '.tsx', '.cts', '.cjs', '.mjs', '.js', '.json', '.yml', '.yaml']);
const documentationWhitespaceExtensions = new Set(['.md', '.mdx', '.markdown']);
const documentationHtmlExtensions = new Set(['.html', '.htm']);
const isolatedSourceEnvironment = 'ZEUS_RELEASE_ISOLATED_SOURCE';
const isolationValidationEnvironment = 'ZEUS_RELEASE_VALIDATE_ISOLATION';
let activeReleaseStage = '初始化发布';
let activeReleaseState = null;

main().catch((error) => {
  console.error(formatReleaseFailure(error));
  process.exitCode = 1;
});

async function main() {
  announceReleaseStage('检查本地发布条件');
  const outputDirectory = resolveOutputDirectory();
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  assertRepositoryPreflight();
  const initialHeadSha = git(['rev-parse', 'HEAD']);
  inspectCommittedCandidateWhitespace(initialHeadSha);
  const initialWorktreeStatus = git(['status', '--short']);
  const isolationValidation = parseBooleanEnvironment(isolationValidationEnvironment, false);
  if (isolationValidation && (!initialWorktreeStatus || process.env[isolatedSourceEnvironment])) {
    throw new Error(`${isolationValidationEnvironment} 只允许验证脏工作区的隔离路径，不能进入当前仓库的真实发布主链路。`);
  }
  if (initialWorktreeStatus && !process.env[isolatedSourceEnvironment]) {
    await runIsolatedRelease({ outputDirectory, sourceHead: initialHeadSha, worktreeStatus: initialWorktreeStatus });
    return;
  }
  assertGitHubAuthentication();

  announceReleaseStage('读取 GitHub 当前稳定版');
  const stableRelease = readLatestStableRelease();
  announceReleaseStage('同步远程 main 与稳定标签');
  fetchReleaseFacts(stableRelease.tag);
  const publicCommit = git(['rev-parse', `${stableRelease.tag}^{commit}`]);
  const headSha = initialHeadSha;
  announceReleaseStage('核对本地 main 与 origin/main');
  assertMainRelationship(headSha);
  const packageVersion = readMatchingPackageVersion();
  const nextVersion = resolveTargetVersion(stableRelease.version);
  announceReleaseStage('恢复或创建发布状态');
  const state = resolveReleaseState({ stableRelease, publicCommit, headSha, packageVersion, nextVersion });

  if (state.type === 'already_published') {
    const resultPath = join(outputDirectory, `Zeus-${stableRelease.version}-release-already-current.md`);
    writeFileSync(
      resultPath,
      [
        `# Zeus ${stableRelease.version} 已是当前公开稳定版`,
        '',
        `- 本地 main：${headSha}`,
        `- 公开标签：${stableRelease.tag} → ${publicCommit}`,
        `- GitHub Release：${stableRelease.url}`,
        '- 最新公开标签之后没有新的 main 提交，本次没有创建新版本或执行任何写操作。',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    console.log('当前 main 与最新公开稳定版一致；无需重复发布。');
    console.log(`ZEUS_ARTIFACT_FILE=${resultPath}`);
    return;
  }

  const releaseState = state.value;
  activeReleaseState = releaseState;
  assertResumeWorktree(releaseState);
  announceReleaseStage('整理发布候选格式');
  formatReleaseCandidate(releaseState);
  announceReleaseStage('执行候选前置检查');
  await ensureCandidatePreflight(releaseState);
  console.log(`Zeus 端到端发布：${releaseState.baseTag}..${releaseState.sourceHead.slice(0, 12)} → ${releaseState.tag}`);
  console.log('发布说明模型：Zeus DeepSeek deepseek-v4-flash；不可用时自动使用确定性模板。');

  announceReleaseStage('生成 Release notes');
  await ensureReleaseNotes(releaseState);
  announceReleaseStage('写入版本并创建发布提交');
  await ensureReleaseCommit(releaseState);
  announceReleaseStage('执行本地快速发布门禁');
  ensureFastLocalGate(releaseState);
  announceReleaseStage('安全推送 main');
  ensureMainPushed(releaseState);
  announceReleaseStage('创建并回验公开发布');
  await ensurePublished(releaseState);

  releaseState.phase = 'completed';
  releaseState.completedAt = new Date().toISOString();
  writeState(releaseState);
  const resultPath = join(outputDirectory, `Zeus-${releaseState.version}-release-result.md`);
  writeFileSync(resultPath, buildFinalResult(releaseState), { mode: 0o600 });
  const artifactPaths = [resultPath];
  for (const source of [releaseState.notesPath, releaseState.gateSummaryPath, releaseState.publishResultPath]) {
    if (!source || !existsSync(source)) continue;
    const destination = join(outputDirectory, basename(source));
    if (resolve(source) !== resolve(destination)) copyFileSync(source, destination);
    artifactPaths.push(destination);
  }
  console.log(`Zeus ${releaseState.version} 已完成 main 推送、公开发布与产物回验。`);
  for (const path of artifactPaths) console.log(`ZEUS_ARTIFACT_FILE=${path}`);
}

async function runIsolatedRelease(input) {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceHead)) throw new Error(`隔离发布源提交无效：${input.sourceHead}`);
  const origin = git(['remote', 'get-url', 'origin']);
  const isolatedRoot = join(repositoryRoot, '.tmp', 'zeus-release-isolated');
  const isolatedRepository = join(isolatedRoot, input.sourceHead);
  mkdirSync(isolatedRoot, { recursive: true, mode: 0o700 });

  if (!existsSync(isolatedRepository)) {
    runInDirectory(repositoryRoot, 'git', ['clone', '--shared', '--branch', 'main', '--single-branch', repositoryRoot, isolatedRepository]);
  } else if (!existsSync(join(isolatedRepository, '.git'))) {
    throw new Error(`隔离发布目录已存在但不是 Git 仓库，拒绝覆盖或清理：${isolatedRepository}`);
  }

  runInDirectory(isolatedRepository, 'git', ['remote', 'set-url', 'origin', origin]);
  runInDirectory(isolatedRepository, 'git', ['fetch', '--force', 'origin', 'refs/heads/main:refs/remotes/origin/main']);
  const isolatedBranch = gitInDirectory(isolatedRepository, ['branch', '--show-current']) || '(detached HEAD)';
  const isolatedHead = gitInDirectory(isolatedRepository, ['rev-parse', 'HEAD']);
  if (isolatedBranch !== 'main') throw new Error(`隔离发布副本不在 main：${isolatedBranch}`);
  if (isolatedHead !== input.sourceHead && !isRecoverableIsolatedReleaseCommit(isolatedRepository, input.sourceHead, isolatedHead)) {
    throw new Error(`隔离发布副本已经偏离发布源，拒绝覆盖或清理：source=${input.sourceHead} isolated=${isolatedHead}`);
  }
  if (captureInDirectory(isolatedRepository, 'git', ['merge-base', '--is-ancestor', 'origin/main', input.sourceHead], true).status !== 0) {
    throw new Error(`origin/main 已领先发布源或与之分叉，拒绝隔离发布：source=${input.sourceHead}`);
  }

  console.log(`检测到未提交内容，改用隔离发布副本：${isolatedRepository}`);
  console.log(`发布源固定为本地 main HEAD：${input.sourceHead}`);
  console.log('暂存、未暂存和未跟踪内容均不会复制、提交或打包；原工作区保持原样。');

  await runStage('准备隔离发布依赖', 'pnpm', ['install', '--frozen-lockfile'], process.env, { cwd: isolatedRepository });

  if (parseBooleanEnvironment(isolationValidationEnvironment, false)) {
    const currentHead = git(['rev-parse', 'HEAD']);
    const currentWorktreeStatus = git(['status', '--short']);
    if (currentHead !== input.sourceHead || currentWorktreeStatus !== input.worktreeStatus) {
      throw new Error('隔离校验期间原工作区发生变化，无法证明发布编排保持原样。');
    }
    const isolatedStatus = gitInDirectory(isolatedRepository, ['status', '--short']);
    if (isolatedHead !== input.sourceHead || isolatedStatus) {
      throw new Error(`隔离副本不是发布源的干净快照：head=${isolatedHead}\n${isolatedStatus}`);
    }
    const resultPath = join(input.outputDirectory, `Zeus-isolated-release-${input.sourceHead.slice(0, 12)}-validation.md`);
    writeFileSync(resultPath, buildIsolationValidationResult(input, isolatedRepository), { mode: 0o600 });
    console.log('隔离发布校验通过；验证模式没有执行版本写入、提交、push、标签或公开发布。');
    console.log(`ZEUS_ARTIFACT_FILE=${resultPath}`);
    return;
  }

  seedIsolatedReleaseState(isolatedRepository, input.sourceHead);
  await runStage(
    '在隔离副本执行端到端发布',
    'pnpm',
    ['release'],
    {
      ...process.env,
      [isolatedSourceEnvironment]: input.sourceHead,
      ZEUS_COMMAND_RUN_DIR: input.outputDirectory,
    },
    { cwd: isolatedRepository, preserveArtifactLines: true },
  );
  const currentOriginalHead = git(['rev-parse', 'HEAD']);
  if (currentOriginalHead === input.sourceHead) console.log(`隔离发布已完成；原工作区和本地 main 仍保持在 ${input.sourceHead.slice(0, 12)}。`);
  else console.log(`隔离发布已完成；原工作区的 main 在执行期间由其他流程移动到 ${currentOriginalHead.slice(0, 12)}，本脚本没有改写它。`);
  console.log('请在处理完未提交内容后显式同步 origin/main；脚本不会自动 stash、恢复、合并或变基。');
}

function isRecoverableIsolatedReleaseCommit(isolatedRepository, sourceHead, isolatedHead) {
  const packagePath = join(isolatedRepository, 'package.json');
  if (existsSync(packagePath)) {
    const version = JSON.parse(readFileSync(packagePath, 'utf8')).version;
    const gitDirectoryValue = gitInDirectory(isolatedRepository, ['rev-parse', '--git-common-dir']);
    const gitDirectory = isAbsolute(gitDirectoryValue) ? gitDirectoryValue : resolve(isolatedRepository, gitDirectoryValue);
    const releaseStatePath = join(gitDirectory, 'zeus-release', `v${version}`, 'state.json');
    if (existsSync(releaseStatePath)) {
      const state = JSON.parse(readFileSync(releaseStatePath, 'utf8'));
      const sourceIsAncestor = captureInDirectory(isolatedRepository, 'git', ['merge-base', '--is-ancestor', sourceHead, state.sourceHead], true).status === 0;
      if (state.releaseCommit === isolatedHead && sourceIsAncestor) return true;
    }
  }
  const parent = captureInDirectory(isolatedRepository, 'git', ['rev-parse', `${isolatedHead}^`], true);
  if (parent.status !== 0 || parent.stdout.trim() !== sourceHead) return false;
  const changedPaths = gitInDirectory(isolatedRepository, ['diff-tree', '--no-commit-id', '--name-only', '-r', isolatedHead]).split(/\r?\n/u).filter(Boolean);
  const versionNotes = changedPaths.filter((path) => /^docs\/releases\/v\d+\.\d+\.\d+\.md$/u.test(path));
  return changedPaths.length === 3 && releaseFiles.every((path) => changedPaths.includes(path)) && versionNotes.length === 1;
}

function seedIsolatedReleaseState(isolatedRepository, sourceHead) {
  const version = JSON.parse(readFileSync(join(isolatedRepository, 'package.json'), 'utf8')).version;
  const sourceState = readState(version);
  if (!sourceState) return;
  const gitDirectoryValue = gitInDirectory(isolatedRepository, ['rev-parse', '--git-common-dir']);
  const gitDirectory = isAbsolute(gitDirectoryValue) ? gitDirectoryValue : resolve(isolatedRepository, gitDirectoryValue);
  const stateDirectory = join(gitDirectory, 'zeus-release', `v${version}`);
  const targetStatePath = join(stateDirectory, 'state.json');
  if (existsSync(targetStatePath)) return;
  if (sourceState.phase !== 'release_committed' || sourceState.gateSummaryPath || sourceState.publishResultPath || !sourceState.releaseCommit) {
    return;
  }
  if (captureInDirectory(isolatedRepository, 'git', ['merge-base', '--is-ancestor', sourceState.releaseCommit, sourceHead], true).status !== 0) {
    return;
  }
  if (resolveLocalTagSha(sourceState.tag) || resolveRemoteReference(`refs/tags/${sourceState.tag}`)) return;
  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  if (!remoteMainSha || captureInDirectory(isolatedRepository, 'git', ['merge-base', '--is-ancestor', sourceState.releaseCommit, remoteMainSha], true).status === 0) {
    return;
  }
  const notesSource = join(isolatedRepository, 'docs', 'releases', `${sourceState.tag}.md`);
  if (!existsSync(notesSource)) throw new Error(`隔离恢复缺少仓库 Release notes：${notesSource}`);
  const notesDirectory = join(stateDirectory, 'notes');
  mkdirSync(notesDirectory, { recursive: true, mode: 0o700 });
  const notesPath = join(notesDirectory, `Zeus-${version}-release-notes-draft.md`);
  copyFileSync(notesSource, notesPath);
  const isolatedState = {
    schemaVersion: 1,
    version,
    tag: sourceState.tag,
    baseTag: sourceState.baseTag,
    sourceHead,
    releaseCommit: sourceHead,
    notesPath,
    gateSummaryPath: null,
    publishResultPath: null,
    phase: 'release_committed',
    createdAt: sourceState.createdAt,
    updatedAt: new Date().toISOString(),
    stateDirectory,
  };
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const temporaryStatePath = `${targetStatePath}.${process.pid}.tmp`;
  writeFileSync(temporaryStatePath, `${JSON.stringify(isolatedState, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryStatePath, targetStatePath);
  console.log(`已把尚未推送的 ${sourceState.tag} 恢复状态带入隔离副本 ${sourceHead.slice(0, 12)}。`);
}

function buildIsolationValidationResult(input, isolatedRepository) {
  return [
    '# Zeus 脏工作区隔离发布校验',
    '',
    `- 发布源：${input.sourceHead}`,
    `- 隔离副本：${isolatedRepository}`,
    '- 隔离副本分支：main',
    '- 隔离副本工作区：干净',
    '- 原仓库 HEAD：保持不变',
    '- 原仓库 porcelain 状态：保持不变',
    '- 版本写入、提交、push、标签、GitHub Release、Homebrew Tap：均未执行',
    '',
  ].join('\n');
}

function assertRepositoryPreflight() {
  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
  if (branch !== 'main') throw new Error(`一键发布只能从本地 main 执行，当前分支为 ${branch}。`);
  const origin = git(['remote', 'get-url', 'origin']);
  if (![`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`].includes(origin)) {
    throw new Error(`origin 不是受控仓库 ${repository}：${origin}`);
  }
  if (process.platform !== 'darwin') throw new Error('Zeus 完整发布只能在 macOS 上执行。');
}

function inspectCommittedCandidateWhitespace(headSha) {
  const baseTagResult = capture('git', ['describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--abbrev=0', headSha], true);
  const baseTag = baseTagResult.stdout.trim();
  if (baseTagResult.status !== 0 || !/^v\d+\.\d+\.\d+$/u.test(baseTag)) {
    throw new Error(`发布前无法确认候选提交的本地稳定基线：${baseTagResult.stderr.trim() || baseTagResult.stdout.trim() || 'missing'}`);
  }
  const inspection = inspectGitDiffCheck({
    label: '发布候选快速检查',
    diffArgs: [`${baseTag}^{commit}`, headSha],
    allowAutoFix: true,
  });
  if (inspection.autoFixable.length > 0) {
    console.log(`发布候选存在可自动修复的源码空白问题，将进入自动格式化阶段：${baseTag}..${headSha.slice(0, 12)}（${inspection.autoFixable.length} 项）`);
    return;
  }
  const warningSuffix = inspection.warnings.length > 0 ? `，另有 ${inspection.warnings.length} 项文档空白警告` : '';
  console.log(`发布候选快速检查通过：${baseTag}..${headSha.slice(0, 12)}${warningSuffix}`);
}

function inspectGitDiffCheck(input) {
  const commandArgs = ['-c', 'core.quotePath=false', '--no-pager', 'diff', '--check', ...input.diffArgs];
  const result = capture('git', commandArgs, true);
  if (result.status === 0) return { warnings: [], autoFixable: [] };

  const report = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const issues = [];
  const unparsed = [];
  for (const reportLine of report.split(/\r?\n/u)) {
    if (!reportLine || reportLine.startsWith('+') || reportLine.startsWith('-')) continue;
    const match = reportLine.match(/^(.*):(\d+): (.+)$/u);
    if (!match) {
      unparsed.push(reportLine);
      continue;
    }
    issues.push({ path: normalizeGitDiffCheckPath(match[1]), line: Number(match[2]), message: match[3] });
  }
  if (issues.length === 0 || unparsed.length > 0) {
    throw new Error(`${input.label}无法解析 Git 候选检查结果：\n${report || `退出码 ${result.status}`}`);
  }

  const warnings = [];
  const autoFixable = [];
  const blocking = [];
  for (const issue of issues) {
    if (isDocumentationWhitespaceWarning(issue)) {
      warnings.push(issue);
      continue;
    }
    if (input.allowAutoFix && isAutoFixableWhitespaceIssue(issue)) {
      autoFixable.push(issue);
      continue;
    }
    blocking.push(issue);
  }

  if (warnings.length > 0) {
    console.warn(`[文档空白警告，不阻断发布] ${warnings.length} 项\n${warnings.map(formatGitDiffCheckIssue).join('\n')}`);
  }
  if (blocking.length > 0) {
    throw new Error(`${input.label}发现阻断发布的候选问题：\n${blocking.map(formatGitDiffCheckIssue).join('\n')}`);
  }
  return { warnings, autoFixable };
}

function isDocumentationWhitespaceWarning(issue) {
  if (!isWhitespaceIssue(issue.message)) return false;
  const extension = extname(issue.path).toLocaleLowerCase();
  if (documentationWhitespaceExtensions.has(extension)) return true;
  return documentationHtmlExtensions.has(extension) && issue.path.startsWith('docs/');
}

function normalizeGitDiffCheckPath(path) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path);
  } catch {
    return path.slice(1, -1);
  }
}

function isAutoFixableWhitespaceIssue(issue) {
  return isWhitespaceIssue(issue.message) && formatExtensions.has(extname(issue.path).toLocaleLowerCase());
}

function isWhitespaceIssue(message) {
  return /^(?:trailing whitespace|new blank line at EOF|space before tab in indent)\.?$/u.test(message);
}

function formatGitDiffCheckIssue(issue) {
  return `${issue.path}:${issue.line}: ${issue.message}`;
}

function assertGitHubAuthentication() {
  captureRemoteRead('检查 GitHub CLI 登录状态', 'gh', ['auth', 'status', '--hostname', 'github.com']);
}

function readLatestStableRelease() {
  const value = JSON.parse(gh(['release', 'view', '--repo', repository, '--json', 'tagName,isDraft,isPrerelease,publishedAt,url']));
  if (value.isDraft || value.isPrerelease || !/^v\d+\.\d+\.\d+$/u.test(value.tagName ?? '')) {
    throw new Error(`无法确认最新公开稳定版：${JSON.stringify(value)}`);
  }
  return { tag: value.tagName, version: value.tagName.slice(1), publishedAt: value.publishedAt, url: value.url };
}

function fetchReleaseFacts(tag) {
  runRemoteReadInherited('同步远程 main 与稳定标签', 'git', ['--no-pager', 'fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main', `refs/tags/${tag}:refs/tags/${tag}`]);
}

function assertMainRelationship(headSha) {
  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  if (!remoteMainSha) throw new Error('无法读取 origin/main。');
  if (remoteMainSha === headSha) return;
  const relationship = capture('git', ['merge-base', '--is-ancestor', remoteMainSha, headSha], true);
  if (relationship.status !== 0) {
    throw new Error(`origin/main 已领先本地 main 或与之分叉，拒绝自动合并或强推：local=${headSha} remote=${remoteMainSha}`);
  }
}

function resolveReleaseState(input) {
  const currentState = readState(input.packageVersion);
  if (currentState && currentState.version === input.packageVersion && currentState.releaseCommit === input.headSha && currentState.phase !== 'completed') {
    validateState(currentState, input.stableRelease);
    return { type: 'resume', value: currentState };
  }
  if (input.packageVersion === input.stableRelease.version && input.headSha === input.publicCommit) {
    const worktreeStatus = git(['status', '--short']);
    if (worktreeStatus) throw new Error(`发布 main 必须以已提交内容为准；当前工作区不干净：\n${worktreeStatus}`);
    return { type: 'already_published' };
  }
  if (input.packageVersion === input.nextVersion) {
    if (!currentState) throw new Error(`检测到包版本 ${input.packageVersion} 高于公开稳定版，但缺少一键发布恢复状态，拒绝推断或创建新版本。`);
    validateState(currentState, input.stableRelease);
    if (currentState.releaseCommit && currentState.releaseCommit !== input.headSha && !rebindUnpublishedReleaseRepair(currentState, input.headSha)) {
      throw new Error(`本地 main 已偏离发布提交，且当前阶段不允许自动恢复：expected=${currentState.releaseCommit} actual=${input.headSha}`);
    }
    return { type: 'resume', value: currentState };
  }
  if (input.packageVersion !== input.stableRelease.version) {
    throw new Error(`当前包版本 ${input.packageVersion} 与公开稳定版 ${input.stableRelease.version} 不一致，也不是可恢复的 ${input.nextVersion}。`);
  }
  const targetState = readState(input.nextVersion);
  if (targetState) {
    validateState(targetState, input.stableRelease);
    if (targetState.sourceHead !== input.headSha) {
      if (canRebindPreWriteState(targetState)) {
        const worktreeStatus = git(['status', '--short']);
        if (worktreeStatus) throw new Error(`重新绑定未写入的发布候选前要求工作区干净：\n${worktreeStatus}`);
        assertAncestor(targetState.baseTag, input.headSha);
        targetState.sourceHead = input.headSha;
        targetState.notesPath = null;
        targetState.phase = 'initialized';
        targetState.updatedAt = new Date().toISOString();
        writeState(targetState);
        console.log(`未产生写入的 ${targetState.tag} 发布状态已重新绑定到 ${input.headSha.slice(0, 12)}。`);
        return { type: 'resume', value: targetState };
      }
      throw new Error(`已有 ${targetState.tag} 发布状态绑定其他候选提交：state=${targetState.sourceHead} current=${input.headSha}`);
    }
    return { type: 'resume', value: targetState };
  }
  const worktreeStatus = git(['status', '--short']);
  if (worktreeStatus) throw new Error(`新发布只能从干净工作区开始：\n${worktreeStatus}`);
  assertAncestor(input.stableRelease.tag, input.headSha);
  const stateDirectory = releaseStateDirectory(input.nextVersion);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const state = {
    schemaVersion: 1,
    version: input.nextVersion,
    tag: `v${input.nextVersion}`,
    baseTag: input.stableRelease.tag,
    sourceHead: input.headSha,
    releaseCommit: null,
    notesPath: null,
    gateSummaryPath: null,
    publishResultPath: null,
    phase: 'initialized',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stateDirectory,
  };
  writeState(state);
  return { type: 'new', value: state };
}

function canRebindPreWriteState(state) {
  return ['initialized', 'notes_generated'].includes(state.phase) && state.releaseCommit === null && state.gateSummaryPath === null && state.publishResultPath === null;
}

function rebindUnpublishedReleaseRepair(state, headSha) {
  const recoveringUnpushedCommit = state.phase === 'release_committed' && !state.gateSummaryPath;
  const recoveringFailedPushedCommit = state.phase === 'main_pushed' && Boolean(state.gateSummaryPath);
  if ((!recoveringUnpushedCommit && !recoveringFailedPushedCommit) || state.publishResultPath) return false;
  if (git(['status', '--short'])) return false;
  if (readMatchingPackageVersion() !== state.version) return false;
  if (resolveLocalTagSha(state.tag) || resolveRemoteReference(`refs/tags/${state.tag}`)) return false;
  if (capture('git', ['merge-base', '--is-ancestor', state.releaseCommit, headSha], true).status !== 0) return false;
  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  if (!remoteMainSha) return false;
  const previousReleaseIsOnRemote = capture('git', ['merge-base', '--is-ancestor', state.releaseCommit, remoteMainSha], true).status === 0;
  if (recoveringUnpushedCommit && previousReleaseIsOnRemote) return false;
  const localMainContainsRemote = capture('git', ['merge-base', '--is-ancestor', remoteMainSha, headSha], true).status === 0;
  if (recoveringFailedPushedCommit && (!previousReleaseIsOnRemote || !localMainContainsRemote)) return false;
  if (recoveringFailedPushedCommit) assertNoActiveReleaseWorkflow(state.releaseCommit, headSha);
  assertAncestor(state.baseTag, headSha);
  state.sourceHead = headSha;
  state.releaseCommit = headSha;
  state.gateSummaryPath = null;
  state.publishResultPath = null;
  syncReleaseNotesSnapshot(state);
  state.phase = 'release_committed';
  writeState(state);
  const recoverySource = recoveringFailedPushedCommit ? '已推送但未公开' : '尚未推送';
  console.log(`${recoverySource}的 ${state.tag} 发布状态已重新绑定到修复提交 ${headSha.slice(0, 12)}。`);
  return true;
}

function assertNoActiveReleaseWorkflow(replacedCommit, replacementCommit) {
  const runs = JSON.parse(gh(['run', 'list', '--repo', repository, '--workflow', 'Release', '--limit', '50', '--json', 'databaseId,status,headSha,url,createdAt']));
  const activeRuns = runs.filter((run) => run.status !== 'completed');
  if (activeRuns.length === 0) return;

  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  const supersededRuns = activeRuns.filter((run) => isSupersededUnstartedReleaseRun(run, replacedCommit, replacementCommit, remoteMainSha));
  const supersededRunIds = new Set(supersededRuns.map((run) => run.databaseId));
  const blockingRuns = activeRuns.filter((run) => !supersededRunIds.has(run.databaseId));
  for (const run of supersededRuns) {
    console.warn(`隔离忽略已被 main 替代且超过 15 分钟仍未启动的 Release Workflow：${run.databaseId} ${run.url}`);
  }
  if (blockingRuns.length === 0) return;
  const details = blockingRuns.map((run) => `${run.databaseId}:${run.status}:${run.headSha}:${run.url}`).join('\n');
  throw new Error(`仍有 Release Workflow 在运行或排队，拒绝重新绑定失败发布候选：\n${details}`);
}

function isSupersededUnstartedReleaseRun(run, replacedCommit, replacementCommit, remoteMainSha) {
  const createdAtMs = Date.parse(run.createdAt ?? '');
  if (run.status !== 'queued' || run.headSha !== replacedCommit || remoteMainSha !== replacementCommit || !Number.isFinite(createdAtMs) || Date.now() - createdAtMs < releaseWorkflowWaitLimitMs) {
    return false;
  }

  const detail = JSON.parse(gh(['run', 'view', String(run.databaseId), '--repo', repository, '--json', 'databaseId,status,headSha,jobs']));
  return detail.status === 'queued' && detail.headSha === replacedCommit && Array.isArray(detail.jobs) && detail.jobs.length === 0;
}

function validateState(state, stableRelease) {
  if (state.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/u.test(state.version ?? '') || state.tag !== `v${state.version}`) {
    throw new Error('一键发布恢复状态格式无效。');
  }
  if (state.baseTag !== stableRelease.tag && stableRelease.version !== state.version) {
    throw new Error(`恢复状态基线 ${state.baseTag} 与当前公开稳定版 ${stableRelease.tag} 不一致。`);
  }
  if (!/^[a-f0-9]{40}$/u.test(state.sourceHead ?? '')) throw new Error('一键发布恢复状态缺少候选提交。');
  if (state.releaseCommit !== null && !/^[a-f0-9]{40}$/u.test(state.releaseCommit ?? '')) throw new Error('一键发布恢复状态包含无效发布提交。');
  if (!['initialized', 'notes_generated', 'release_committed', 'gate_passed', 'main_pushed', 'ci_passed', 'published', 'completed'].includes(state.phase)) {
    throw new Error(`一键发布恢复阶段无效：${state.phase ?? 'missing'}`);
  }
  const expectedStateDirectory = releaseStateDirectory(state.version);
  if (resolve(state.stateDirectory ?? '') !== expectedStateDirectory) throw new Error('一键发布恢复目录与目标版本不一致。');
  for (const field of ['notesPath', 'gateSummaryPath', 'publishResultPath']) {
    const value = state[field];
    if (value !== null && (typeof value !== 'string' || !resolve(value).startsWith(`${expectedStateDirectory}${sep}`))) {
      throw new Error(`一键发布恢复文件路径越出受控目录：${field}`);
    }
  }
  assertAncestor(state.baseTag, state.sourceHead);
}

function assertResumeWorktree(state) {
  const status = git(['status', '--short']);
  if (!status) return;
  if (!['initialized', 'notes_generated'].includes(state.phase)) throw new Error(`恢复发布要求工作区干净：\n${status}`);
  const allowed = new Set([...releaseFiles, `docs/releases/${state.tag}.md`]);
  const unexpected = status
    .split(/\r?\n/u)
    .map((line) => line.slice(3).split(' -> ').at(-1))
    .filter((path) => path && !allowed.has(path));
  if (unexpected.length > 0) throw new Error(`恢复现场包含发布候选以外的工作区变更：\n${unexpected.join('\n')}`);
}

function formatReleaseCandidate(state) {
  if (!['initialized', 'notes_generated', 'release_committed'].includes(state.phase)) return;
  const currentHead = git(['rev-parse', 'HEAD']);
  const expectedHead = state.releaseCommit ?? state.sourceHead;
  if (currentHead !== expectedHead) throw new Error(`格式检查前本地 main 已偏离候选提交：expected=${expectedHead} actual=${currentHead}`);
  const worktreeStatus = git(['status', '--short']);
  if (worktreeStatus) throw new Error(`格式检查要求干净候选：\n${worktreeStatus}`);
  const paths = git(['diff', '--name-only', '--diff-filter=ACMR', `${state.baseTag}^{commit}`, currentHead, '--'])
    .split(/\r?\n/u)
    .filter((path) => path && formatExtensions.has(extname(path)) && existsSync(join(repositoryRoot, path)))
    .sort();
  if (paths.length === 0) return;

  if (state.releaseCommit) {
    console.log(`\n[检查发布提交格式] Prettier --check（${paths.length} 个文件）`);
    run('pnpm', ['exec', 'prettier', '--check', '--ignore-path', '.prettierignore', ...paths]);
    console.log('发布提交格式检查通过。');
    return;
  }

  console.log(`\n[自动修复发布候选格式] Prettier --write（${paths.length} 个文件）`);
  run('pnpm', ['exec', 'prettier', '--write', '--ignore-path', '.prettierignore', ...paths]);
  console.log(`\n[复核发布候选格式] Prettier --check（${paths.length} 个文件）`);
  run('pnpm', ['exec', 'prettier', '--check', '--ignore-path', '.prettierignore', ...paths]);
  const formattedStatus = git(['status', '--short']);
  if (!formattedStatus) {
    console.log('发布候选原本已符合格式规范，无需创建格式提交。');
    return;
  }

  const candidatePaths = new Set(paths);
  const formattedPaths = formattedStatus
    .split(/\r?\n/u)
    .map((line) => line.slice(3).split(' -> ').at(-1))
    .filter(Boolean)
    .sort();
  const unexpectedPaths = formattedPaths.filter((path) => !candidatePaths.has(path));
  if (unexpectedPaths.length > 0) {
    throw new Error(`自动格式化产生了候选范围之外的变更，拒绝提交：\n${unexpectedPaths.join('\n')}`);
  }

  inspectGitDiffCheck({
    label: '自动格式化后的发布候选检查',
    diffArgs: [`${state.baseTag}^{commit}`],
    allowAutoFix: false,
  });
  runGit(['add', '--', ...formattedPaths]);
  runGit(['diff', '--cached', '--check', '--', ...formattedPaths]);
  runGit(['commit', '-m', `style(release): 自动修复 ${state.tag} 候选格式`, '--', ...formattedPaths]);
  const formattedHead = git(['rev-parse', 'HEAD']);
  const formattedParent = git(['rev-parse', 'HEAD^']);
  if (formattedParent !== state.sourceHead) {
    throw new Error(`自动格式提交父提交不一致：expected=${state.sourceHead} actual=${formattedParent}`);
  }
  const committedPaths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', formattedHead]).split(/\r?\n/u).filter(Boolean).sort();
  if (JSON.stringify(committedPaths) !== JSON.stringify(formattedPaths)) {
    throw new Error(`自动格式提交包含非预期文件：\n${committedPaths.join('\n')}`);
  }
  if (git(['status', '--short'])) throw new Error('自动格式提交完成后工作区仍有未提交变更。');

  state.sourceHead = formattedHead;
  state.releaseCommit = null;
  state.notesPath = null;
  state.phase = 'initialized';
  writeState(state);
  console.log(`发布候选格式已自动修复并提交：${formattedHead.slice(0, 12)}（${formattedPaths.length} 个文件）`);
}

function syncReleaseNotesSnapshot(state) {
  const notesTarget = join(repositoryRoot, 'docs', 'releases', `${state.tag}.md`);
  if (!existsSync(notesTarget)) throw new Error(`恢复发布缺少仓库 Release notes：${notesTarget}`);
  const notesDirectory = join(state.stateDirectory, 'notes');
  mkdirSync(notesDirectory, { recursive: true, mode: 0o700 });
  const notesPath = join(notesDirectory, `Zeus-${state.version}-release-notes-draft.md`);
  copyFileSync(notesTarget, notesPath);
  state.notesPath = notesPath;
}

async function ensureReleaseNotes(state) {
  if (state.notesPath && existsSync(state.notesPath)) return;
  if (git(['rev-parse', 'HEAD']) !== state.sourceHead) throw new Error('生成 Release notes 前本地 main 已偏离绑定的候选提交。');
  const notesDirectory = join(state.stateDirectory, 'notes');
  mkdirSync(notesDirectory, { recursive: true, mode: 0o700 });
  await runStage('生成 Release notes', 'pnpm', ['release:notes:draft'], {
    ...process.env,
    RELEASE_VERSION: state.version,
    BASE_TAG: state.baseTag,
    INCLUDE_WORKTREE: 'false',
    AUTOMATED_RELEASE: 'true',
    ZEUS_COMMAND_RUN_DIR: notesDirectory,
  });
  const notesPath = join(notesDirectory, `Zeus-${state.version}-release-notes-draft.md`);
  if (!existsSync(notesPath)) throw new Error(`Release notes 阶段没有生成预期文件：${notesPath}`);
  state.notesPath = notesPath;
  state.phase = 'notes_generated';
  writeState(state);
}

async function ensureReleaseCommit(state) {
  const currentHead = git(['rev-parse', 'HEAD']);
  if (state.releaseCommit) {
    if (currentHead !== state.releaseCommit) throw new Error(`本地 main 已偏离发布提交：expected=${state.releaseCommit} actual=${currentHead}`);
    return;
  }
  const notesTarget = `docs/releases/${state.tag}.md`;
  if (currentHead !== state.sourceHead && reconstructReleaseCommit(state, currentHead, notesTarget)) return;
  if (currentHead === state.sourceHead && readMatchingPackageVersion() === state.version && isPreparedWorktree(state, notesTarget)) {
    commitPreparedCandidate(state, notesTarget);
    return;
  }
  if (currentHead !== state.sourceHead) throw new Error(`发布候选写入前 main 已变化：expected=${state.sourceHead} actual=${currentHead}`);
  const prepareDirectory = join(state.stateDirectory, 'prepare');
  mkdirSync(prepareDirectory, { recursive: true, mode: 0o700 });
  await runStage('写入版本与发布正文', 'pnpm', ['release:prepare'], {
    ...process.env,
    RELEASE_VERSION: state.version,
    RELEASE_NOTES_FILE: state.notesPath,
    APPLY_CHANGES: 'true',
    ZEUS_COMMAND_RUN_DIR: prepareDirectory,
  });
  if (!isPreparedWorktree(state, notesTarget)) throw new Error('候选准备完成后工作区没有形成预期的三文件变更。');
  commitPreparedCandidate(state, notesTarget);
}

function reconstructReleaseCommit(state, currentHead, notesTarget) {
  if (git(['status', '--short']) || readMatchingPackageVersion() !== state.version || !existsSync(join(repositoryRoot, notesTarget))) return false;
  const parent = capture('git', ['rev-parse', `${currentHead}^`], true);
  if (parent.status !== 0 || parent.stdout.trim() !== state.sourceHead) return false;
  const changedPaths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', currentHead]).split(/\r?\n/u).filter(Boolean).sort();
  const expectedPaths = [...releaseFiles, notesTarget].sort();
  if (JSON.stringify(changedPaths) !== JSON.stringify(expectedPaths)) return false;
  if (readFileSync(join(repositoryRoot, notesTarget), 'utf8') !== readFileSync(state.notesPath, 'utf8')) return false;
  state.releaseCommit = currentHead;
  state.phase = 'release_committed';
  writeState(state);
  return true;
}

function isPreparedWorktree(state, notesTarget) {
  if (readMatchingPackageVersion() !== state.version || !existsSync(join(repositoryRoot, notesTarget))) return false;
  if (readFileSync(join(repositoryRoot, notesTarget), 'utf8') !== readFileSync(state.notesPath, 'utf8')) return false;
  const status = git(['status', '--short']);
  if (!status) return false;
  const allowed = new Set([...releaseFiles, notesTarget]);
  const paths = status.split(/\r?\n/u).map((line) => line.slice(3).split(' -> ').at(-1));
  return paths.length === allowed.size && paths.every((path) => path && allowed.has(path));
}

function commitPreparedCandidate(state, notesTarget) {
  runGit(['add', '--', ...releaseFiles, notesTarget]);
  runGit(['commit', '-m', `chore(release): ${state.tag}`]);
  const releaseCommit = git(['rev-parse', 'HEAD']);
  const parent = git(['rev-parse', 'HEAD^']);
  if (parent !== state.sourceHead) throw new Error(`发布提交父提交不一致：expected=${state.sourceHead} actual=${parent}`);
  if (git(['status', '--short'])) throw new Error('发布提交完成后工作区仍有未提交变更。');
  state.releaseCommit = releaseCommit;
  state.phase = 'release_committed';
  writeState(state);
}

async function ensureCandidatePreflight(state) {
  if (state.releaseCommit) return;
  const currentHead = git(['rev-parse', 'HEAD']);
  if (currentHead !== state.sourceHead) throw new Error(`快速前置检查发现候选提交漂移：expected=${state.sourceHead} actual=${currentHead}`);
  if (git(['status', '--short'])) throw new Error('快速前置检查要求发布候选工作区干净。');
  inspectGitDiffCheck({
    label: '候选前置检查',
    diffArgs: [`${state.baseTag}^{commit}`, state.sourceHead],
    allowAutoFix: false,
  });
  if (resolveLocalTagSha(state.tag) || resolveRemoteReference(`refs/tags/${state.tag}`)) {
    throw new Error(`目标标签 ${state.tag} 已存在，拒绝把新候选写入同一版本。`);
  }
  console.log('快速前置检查通过：候选提交、工作区、Git 候选检查和目标标签均正常。');
}

function ensureFastLocalGate(state) {
  if (state.gateSummaryPath && existsSync(state.gateSummaryPath)) return;
  assertReleaseHead(state);
  if (resolveLocalTagSha(state.tag) || resolveRemoteReference(`refs/tags/${state.tag}`)) {
    throw new Error(`目标标签 ${state.tag} 已存在，但当前发布缺少可恢复的检查摘要。`);
  }
  inspectGitDiffCheck({
    label: '发布提交空白检查',
    diffArgs: [`${state.releaseCommit}^`, state.releaseCommit],
    allowAutoFix: false,
  });
  const gateDirectory = join(state.stateDirectory, 'gate');
  mkdirSync(gateDirectory, { recursive: true, mode: 0o700 });
  const summaryPath = join(gateDirectory, `Zeus-${state.version}-release-fast-preflight-summary.md`);
  writeFileSync(
    summaryPath,
    [
      `# Zeus ${state.version} 快速发布前置摘要`,
      '',
      `- 候选提交：${state.releaseCommit}`,
      `- 公开基线：${state.baseTag}`,
      `- 目标标签：${state.tag}，本地和远端均未占用。`,
      '- 工作区：干净。',
      '- 版本文件与 Release notes：已写入固定候选提交。',
      '- Git 空白错误检查：通过。',
      '- typecheck、正式 DMG 打包、包内容健康检查、hdiutil 与 manifest 对账：交由同一固定提交的 Release Workflow 并行执行。',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  state.gateSummaryPath = summaryPath;
  state.phase = 'gate_passed';
  writeState(state);
  console.log(`本地快速发布前置检查通过：${summaryPath}`);
}

function ensureMainPushed(state) {
  assertReleaseHead(state);
  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  if (remoteMainSha === state.releaseCommit) {
    state.phase = 'main_pushed';
    writeState(state);
    return;
  }
  if (!remoteMainSha || capture('git', ['merge-base', '--is-ancestor', remoteMainSha, state.releaseCommit], true).status !== 0) {
    throw new Error(`推送前 origin/main 已领先或分叉，拒绝自动合并或强推：remote=${remoteMainSha ?? 'missing'} release=${state.releaseCommit}`);
  }
  pushMainWithVerification(state);
  const pushedSha = resolveRemoteReference('refs/heads/main');
  if (pushedSha !== state.releaseCommit) throw new Error(`main 推送后远端提交不一致：expected=${state.releaseCommit} actual=${pushedSha ?? 'missing'}`);
  state.phase = 'main_pushed';
  writeState(state);
}

async function ensurePublished(state) {
  assertReleaseHead(state);
  const publishDirectory = join(state.stateDirectory, 'publish');
  mkdirSync(publishDirectory, { recursive: true, mode: 0o700 });
  await runStage('创建并回验公开发布', 'pnpm', ['release:publish'], {
    ...process.env,
    RELEASE_VERSION: state.version,
    LOCAL_GATE_SUMMARY_FILE: state.gateSummaryPath,
    APPLY_REMOTE: 'true',
    PUBLISH_CONFIRMATION: `PUBLISH_${state.tag}`,
    REQUIRE_APPLE_DISTRIBUTION: 'false',
    WAIT_FOR_COMPLETION: 'true',
    ZEUS_COMMAND_RUN_DIR: publishDirectory,
  });
  const publishResultPath = join(publishDirectory, `Zeus-${state.version}-publish-result.md`);
  if (!existsSync(publishResultPath)) throw new Error(`公开发布没有生成预期回验结果：${publishResultPath}`);
  state.publishResultPath = publishResultPath;
  state.phase = 'published';
  writeState(state);
}

function assertReleaseHead(state) {
  const headSha = git(['rev-parse', 'HEAD']);
  const status = git(['status', '--short']);
  if (headSha !== state.releaseCommit || status) throw new Error(`发布阶段要求干净且固定的 main 提交：expected=${state.releaseCommit} actual=${headSha}\n${status}`);
}

function buildFinalResult(state) {
  return [
    `# Zeus ${state.version} 端到端发布结果`,
    '',
    `- Release notes 范围：${state.baseTag}..${state.sourceHead}`,
    `- 发布提交：${state.releaseCommit}`,
    `- main CI：${state.ciUrl ?? '快速发布未串行等待；阻塞级 typecheck 已由 Release Workflow 执行'}`,
    `- GitHub Release：https://github.com/${repository}/releases/tag/${state.tag}`,
    `- 本地快速检查摘要：${state.gateSummaryPath}`,
    `- 公开资产回验：${state.publishResultPath}`,
    '- 本次允许 ad-hoc、未公证产物；真实签名与公证状态以公开 manifest 和回验结果为准。',
    '- 未自动安装、升级或随 Zeus 分发 Codex CLI。',
    '',
  ].join('\n');
}

function readMatchingPackageVersion() {
  const rootVersion = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version;
  const desktopVersion = JSON.parse(readFileSync(join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8')).version;
  if (rootVersion !== desktopVersion || !/^\d+\.\d+\.\d+$/u.test(rootVersion ?? '')) {
    throw new Error(`根包与桌面包版本不一致：root=${rootVersion ?? 'missing'} desktop=${desktopVersion ?? 'missing'}`);
  }
  return rootVersion;
}

function incrementPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function resolveTargetVersion(stableVersion) {
  const requested = process.env.RELEASE_VERSION?.trim();
  if (!requested) return incrementPatch(stableVersion);
  if (!/^\d+\.\d+\.\d+$/u.test(requested)) throw new Error(`RELEASE_VERSION 不是稳定版本号：${requested}`);
  const stable = stableVersion.split('.').map(Number);
  const target = requested.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (target[index] > stable[index]) return requested;
    if (target[index] < stable[index]) break;
  }
  throw new Error(`目标版本 ${requested} 必须高于当前公开稳定版 ${stableVersion}。`);
}

function releaseStateDirectory(version) {
  const gitDirectoryValue = git(['rev-parse', '--git-common-dir']);
  const gitDirectory = isAbsolute(gitDirectoryValue) ? gitDirectoryValue : resolve(repositoryRoot, gitDirectoryValue);
  return join(gitDirectory, 'zeus-release', `v${version}`);
}

function statePath(version) {
  return join(releaseStateDirectory(version), 'state.json');
}

function readState(version) {
  const path = statePath(version);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取一键发布恢复状态 ${path}：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeState(state) {
  state.updatedAt = new Date().toISOString();
  const path = statePath(state.version);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

async function runStage(label, command, args, env, options = {}) {
  activeReleaseStage = label;
  console.log(`\n[${label}] ${command} ${args.join(' ')}`);
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: options.cwd ?? repositoryRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      const visible = options.preserveArtifactLines ? text : text.replace(/(^|\n)ZEUS_ARTIFACT_FILE=([^\r\n]+)/gu, '$1[内部阶段产物] $2');
      process.stdout.write(visible);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderrTail = `${stderrTail}${text}`.slice(-4_000);
      process.stderr.write(text);
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveRun();
      else {
        const reason = `${label}失败${signal ? `，信号 ${signal}` : `，退出码 ${code ?? 'unknown'}`}。`;
        const error = new Error(reason);
        error.command = [command, ...args].join(' ');
        error.technicalDetail = stderrTail.trim() || reason;
        error.userReason = `${reason}请查看本阶段末尾的原始输出。`;
        rejectRun(error);
      }
    });
  });
}

function parseBooleanEnvironment(name, defaultValue) {
  const rawValue = process.env[name];
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const normalized = rawValue.trim().toLocaleLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`${name} 必须是布尔值；当前值为 ${rawValue}。`);
}

function runInDirectory(cwd, command, args) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${result.status ?? 'unknown'}。`);
}

function captureInDirectory(cwd, command, args, allowFailure = false, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr.trim() || result.stdout.trim() || result.status}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function gitInDirectory(cwd, args) {
  return captureInDirectory(cwd, 'git', ['-c', 'core.quotePath=false', ...args]).stdout.trimEnd();
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repositoryRoot, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${result.status ?? 'unknown'}。`);
}

function runRemoteReadInherited(label, command, args, timeout = releaseRemoteReadTimeoutMs, attempts = releaseRemoteReadAttempts) {
  const outcome = runRemoteReadWithRetrySync({
    attempts,
    execute: () =>
      spawnSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      }),
    onRetry: (retry) => announceRemoteReadRetry(label, retry, timeout),
  });
  if (commandResultSucceeded(outcome.result)) {
    if (outcome.result.stdout) process.stdout.write(outcome.result.stdout);
    if (outcome.result.stderr) process.stderr.write(outcome.result.stderr);
    return;
  }
  throw releaseCommandError(label, command, args, outcome.result, timeout, outcome.attemptsUsed, attempts);
}

function pushMainWithVerification(state) {
  const args = ['--no-pager', 'push', 'origin', 'refs/heads/main:refs/heads/main'];
  const timeout = 180_000;
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    timeout,
  });
  if (!result.error && result.status === 0) return;
  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  if (remoteMainSha === state.releaseCommit) {
    console.log(`main 推送返回异常，但远程已复验为目标提交 ${state.releaseCommit.slice(0, 12)}，继续安全续跑。`);
    return;
  }
  const error = releaseCommandError('安全推送 main', 'git', args, result, timeout, 1, 1);
  error.userReason = `${error.userReason}远程 main 仍未复验为目标提交，脚本不会盲目重复推送。`;
  throw error;
}

function runGit(args) {
  run('git', ['--no-pager', ...args]);
}

function capture(command, args, allowFailure = false, timeout = 30_000) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr.trim() || result.stdout.trim() || result.status}`);
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function git(args) {
  return capture('git', ['-c', 'core.quotePath=false', ...args]).stdout.trimEnd();
}

function gh(args) {
  return captureRemoteRead('读取 GitHub 发布事实', 'gh', args).stdout.trim();
}

function resolveRemoteReference(reference) {
  const result = captureRemoteRead(`读取远程引用 ${reference}`, 'git', ['ls-remote', 'origin', reference]);
  return result.stdout.trim().split(/\s+/u)[0] || null;
}

function resolveLocalTagSha(tag) {
  const result = capture('git', ['rev-list', '-n', '1', tag], true);
  return result.status === 0 ? result.stdout.trim() : null;
}

function assertAncestor(ancestor, descendant) {
  if (capture('git', ['merge-base', '--is-ancestor', `${ancestor}^{commit}`, descendant], true).status !== 0) {
    throw new Error(`${ancestor} 不是候选提交 ${descendant} 的祖先。`);
  }
}

function resolveOutputDirectory() {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  return commandRunDirectory ? resolve(commandRunDirectory) : mkdtempSync(join(tmpdir(), 'zeus-release-all-'));
}

function captureRemoteRead(label, command, args, timeout = releaseRemoteReadTimeoutMs, attempts = releaseRemoteReadAttempts) {
  const outcome = runRemoteReadWithRetrySync({
    attempts,
    execute: () =>
      spawnSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        maxBuffer: 16 * 1024 * 1024,
      }),
    onRetry: (retry) => announceRemoteReadRetry(label, retry, timeout),
  });
  if (commandResultSucceeded(outcome.result)) {
    return { status: outcome.result.status, stdout: outcome.result.stdout ?? '', stderr: outcome.result.stderr ?? '' };
  }
  throw releaseCommandError(label, command, args, outcome.result, timeout, outcome.attemptsUsed, attempts);
}

function announceRemoteReadRetry(label, retry, timeout) {
  console.error(`远程只读操作暂时失败：${label}；${retry.delayMs / 1_000} 秒后重试（第 ${retry.nextAttempt}/${retry.attempts} 次，每次最多 ${Math.round(timeout / 1_000)} 秒）：${retry.detail}`);
}

function releaseCommandError(label, command, args, result, timeout, attempt, attempts) {
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const detail = commandFailureDetail(result);
  const error = new Error(`${label}失败：${detail}`);
  error.name = 'ReleaseCommandError';
  error.command = [command, ...args].join(' ');
  error.technicalDetail = detail;
  error.userReason = timedOut ? `${label}在 ${Math.round(timeout / 1_000)} 秒内没有响应，已尝试 ${attempt}/${attempts} 次。` : `${label}未完成：${detail}`;
  return error;
}

function announceReleaseStage(label) {
  activeReleaseStage = label;
  console.log(`\n发布阶段：${label}`);
}

function formatReleaseFailure(error) {
  const failure = error && typeof error === 'object' ? error : null;
  const reason = typeof failure?.userReason === 'string' ? failure.userReason : error instanceof Error ? error.message : String(error);
  const detail = typeof failure?.command === 'string' ? `${failure.command}${failure.technicalDetail ? ` · ${failure.technicalDetail}` : ''}` : error instanceof Error ? error.message : String(error);
  return ['', '发布失败', `阶段：${activeReleaseStage}`, `原因：${reason}`, `影响：${describeReleaseFailureImpact(activeReleaseState)}`, `下一步：${describeReleaseRecovery(activeReleaseState)}`, `技术详情：${detail}`].join('\n');
}

function describeReleaseFailureImpact(state) {
  if (!state) return '尚未创建或改写发布版本，未执行发布提交、push、GitHub Release 或 Homebrew Tap 写入。';
  if (['initialized', 'notes_generated'].includes(state.phase)) return `已保留 ${state.tag} 的本地恢复状态，尚未推送 main 或创建公开发布。`;
  if (['release_committed', 'gate_passed'].includes(state.phase)) return `本地 ${state.tag} 发布提交已形成，但未确认 main 已推送，也未确认公开发布完成。`;
  if (state.phase === 'main_pushed') return `main 已推送到 ${state.releaseCommit?.slice(0, 12) ?? '目标提交'}，公开 Release 与 Homebrew Tap 尚未确认完成。`;
  if (['published', 'completed'].includes(state.phase)) return `${state.tag} 已进入公开发布收尾阶段；必须以公开回验结果确认最终状态。`;
  return `已保留 ${state.tag} 的发布恢复状态，未完成阶段不会被冒充为成功。`;
}

function describeReleaseRecovery(state) {
  return state ? '排除上述原因后重新运行 pnpm release；脚本会读取本地恢复状态，并在继续任何远程写入前复验外部事实。' : '检查网络与 GitHub 访问后重新运行 pnpm release；本次没有需要回滚的远程写入。';
}
