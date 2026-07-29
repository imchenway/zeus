#!/usr/bin/env node
/* global process, console */
import { existsSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const formatExtensions = new Set(['.ts', '.tsx', '.cts', '.cjs', '.mjs', '.js', '.json', '.yml', '.yaml']);

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

const { paths, diffChecks } = collectChangeContext();
const formattedPaths = [...paths].filter((path) => formatExtensions.has(extname(path))).sort();

for (const args of diffChecks) {
  runStep(`Git 空白错误检查：git ${args.join(' ')}`, 'git', args);
}

if (formattedPaths.length > 0) {
  runStep(`Prettier 检查本次变更文件（${formattedPaths.length} 个）`, 'pnpm', ['exec', 'prettier', '--check', '--ignore-path', '.prettierignore', ...formattedPaths]);
} else {
  console.log('\n==> 本次没有需要 Prettier 检查的代码或配置文件');
}

runStep('ESLint', 'pnpm', ['lint']);
runStep('TypeScript 类型检查', 'pnpm', ['typecheck']);
runStep('生产构建', 'pnpm', ['build']);

console.log('\nZeus 发布前门禁通过。');
