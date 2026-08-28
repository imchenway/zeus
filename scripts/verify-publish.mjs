#!/usr/bin/env node
/* global process, console */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const formatExtensions = new Set(['.ts', '.tsx', '.cts', '.cjs', '.mjs', '.js', '.json', '.yml', '.yaml']);
const conflictMarkerPattern = /^(?:<<<<<<<(?: |$)|=======$|>>>>>>>(?: |$))/u;
const conflictMarkerGitPattern = '^(<<<<<<<( |$)|=======$|>>>>>>>( |$))';

process.chdir(repositoryRoot);

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: process.env,
    encoding: options.encoding ?? 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (!options.allowFailure && result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result;
}

function captureGit(args, options = {}) {
  return execute('git', args, {
    capture: true,
    allowFailure: options.allowFailure,
  });
}

function hasCommit(reference) {
  if (!reference || /^0+$/u.test(reference)) return false;
  return captureGit(['cat-file', '-e', `${reference}^{commit}`], { allowFailure: true }).status === 0;
}

function changedPaths(args) {
  const result = captureGit([...args, '--name-only', '--diff-filter=ACMR', '-z']);
  return result.stdout.split('\0').filter(Boolean);
}

function addPaths(target, paths) {
  for (const path of paths) {
    if (existsSync(resolve(repositoryRoot, path))) target.add(path);
  }
}

function resolveCommittedRange() {
  const requestedHead = process.env.ZEUS_VERIFY_HEAD?.trim();
  const head = hasCommit(requestedHead) ? requestedHead : 'HEAD';
  const requestedBase = process.env.ZEUS_VERIFY_BASE?.trim();

  if (hasCommit(requestedBase)) {
    return { base: requestedBase, head, source: '环境变量' };
  }

  if (hasCommit(`${head}^`)) {
    return { base: `${head}^`, head, source: requestedBase ? '首个可用父提交' : '最近一次提交' };
  }

  return null;
}

function collectChangeContext() {
  const paths = new Set();
  const diffChecks = [];
  const requestedHead = process.env.ZEUS_VERIFY_HEAD?.trim();

  if (requestedHead) {
    const range = resolveCommittedRange();
    if (range) {
      addPaths(paths, changedPaths(['diff', range.base, range.head]));
      diffChecks.push(['diff', '--check', range.base, range.head]);
      console.log(`Zeus 发布前门禁：使用${range.source}范围 ${range.base}..${range.head}`);
    }
    return { paths, diffChecks };
  }

  addPaths(paths, changedPaths(['diff']));
  addPaths(paths, changedPaths(['diff', '--cached']));
  addPaths(paths, captureGit(['ls-files', '--others', '--exclude-standard', '-z']).stdout.split('\0').filter(Boolean));
  diffChecks.push(['diff', '--check'], ['diff', '--cached', '--check']);

  const upstreamResult = captureGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], { allowFailure: true });
  const upstream = upstreamResult.status === 0 ? upstreamResult.stdout.trim() : '';
  const upstreamHead = upstream ? captureGit(['rev-parse', upstream], { allowFailure: true }).stdout.trim() : '';
  const currentHead = captureGit(['rev-parse', 'HEAD']).stdout.trim();

  if (upstream && upstreamHead && upstreamHead !== currentHead) {
    addPaths(paths, changedPaths(['diff', `${upstream}...HEAD`]));
    diffChecks.push(['diff', '--check', `${upstream}...HEAD`]);
    console.log(`Zeus 发布前门禁：包含尚未推送的提交 ${upstream}...HEAD`);
  } else if (paths.size === 0) {
    const range = resolveCommittedRange();
    if (range) {
      addPaths(paths, changedPaths(['diff', range.base, range.head]));
      diffChecks.push(['diff', '--check', range.base, range.head]);
      console.log(`Zeus 发布前门禁：工作区干净，检查${range.source} ${range.base}..${range.head}`);
    }
  }

  return { paths, diffChecks };
}

function runStep(label, command, args) {
  console.log(`\n==> ${label}`);
  execute(command, args);
}

function conflictMarkerLines(path) {
  try {
    return readFileSync(resolve(repositoryRoot, path), 'utf8')
      .split(/\r?\n/u)
      .flatMap((line, index) => (conflictMarkerPattern.test(line) ? [`${path}:${index + 1}:${line}`] : []));
  } catch {
    return [];
  }
}

function verifyNoConflictMarkers(paths) {
  console.log('\n==> Git 冲突残留检查');
  const findings = new Set();
  const unstagedPaths = new Set(changedPaths(['diff']));
  const trackedScans = [
    { args: ['grep', '-n', '-I', '-E', conflictMarkerGitPattern, '--', '.'], source: 'worktree' },
    { args: ['grep', '--cached', '-n', '-I', '-E', conflictMarkerGitPattern, '--', '.'], source: 'index' },
  ];

  for (const { args, source } of trackedScans) {
    const result = captureGit(args, { allowFailure: true });
    if (result.status !== 0 && result.status !== 1) {
      process.stderr.write(result.stderr);
      process.exit(result.status ?? 1);
    }
    for (const line of result.stdout.split(/\r?\n/u).filter(Boolean)) {
      const path = line.slice(0, line.indexOf(':'));
      if (source === 'index' && unstagedPaths.has(path)) continue;
      findings.add(line);
    }
  }

  for (const path of paths) {
    for (const line of conflictMarkerLines(path)) findings.add(line);
  }

  if (findings.size > 0) {
    console.error('Zeus 发布前门禁：发现尚未清理的 Git 冲突标记：');
    for (const finding of [...findings].sort()) console.error(`  ${finding}`);
    process.exit(1);
  }

  console.log('未发现 Git 冲突残留。');
}

const { paths, diffChecks } = collectChangeContext();
const formattedPaths = [...paths].filter((path) => formatExtensions.has(extname(path))).sort();

verifyNoConflictMarkers(paths);

for (const args of diffChecks) {
  runStep(`Git 空白错误检查：git ${args.join(' ')}`, 'git', args);
}

runStep('发布公网只读重试行为探针', 'pnpm', ['verify:release-remote-read']);

if (formattedPaths.length > 0) {
  runStep(`Prettier 检查本次变更文件（${formattedPaths.length} 个）`, 'pnpm', ['exec', 'prettier', '--check', '--ignore-path', '.prettierignore', ...formattedPaths]);
} else {
  console.log('\n==> 本次没有需要 Prettier 检查的代码或配置文件');
}

runStep('ESLint', 'pnpm', ['lint']);
runStep('TypeScript 类型检查', 'pnpm', ['typecheck']);
runStep('生产构建', 'pnpm', ['build']);

console.log('\nZeus 发布前门禁通过。');
