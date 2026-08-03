#!/usr/bin/env node
/* global console, process */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function main() {
  const releaseVersion = requiredVersion(process.env.RELEASE_VERSION);
  const sourceNotesPath = requiredFile(process.env.RELEASE_NOTES_FILE, 'RELEASE_NOTES_FILE');
  const applyChanges = parseBoolean('APPLY_CHANGES', process.env.APPLY_CHANGES, false);
  const latestTag = resolveLatestStableTag();
  const baseVersion = latestTag.slice(1);
  const targetNotesPath = join(repositoryRoot, 'docs', 'releases', `v${releaseVersion}.md`);
  const sourceNotes = readFileSync(sourceNotesPath, 'utf8');

  assertVersionAfterBase(releaseVersion, latestTag);
  assertTagDoesNotExist(releaseVersion);
  validateReleaseNotes(sourceNotes, releaseVersion);

  const rootPackagePath = join(repositoryRoot, 'package.json');
  const desktopPackagePath = join(repositoryRoot, 'apps', 'desktop', 'package.json');
  const rootPackage = readPackage(rootPackagePath);
  const desktopPackage = readPackage(desktopPackagePath);
  const preparationState = resolvePreparationState({
    releaseVersion,
    baseVersion,
    rootPackage,
    desktopPackage,
    targetNotesPath,
    sourceNotes,
  });
  const worktreeStatusBefore = git(['status', '--short']);
  const outputDirectory = resolveOutputDirectory(releaseVersion);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  let result = '只读预览';
  if (applyChanges) {
    if (preparationState === 'prepared') {
      assertOnlyPreparedPathsChanged(worktreeStatusBefore, targetNotesPath);
      result = '已是目标候选状态，未重复改写';
    } else {
      if (worktreeStatusBefore) {
        throw new Error(['发布候选准备只能在干净工作区执行。', '请先审阅并处理当前变更；本命令不提供跳过开关。', worktreeStatusBefore].join('\n'));
      }
      applyCandidateChanges({
        releaseVersion,
        sourceNotes,
        rootPackagePath,
        desktopPackagePath,
        targetNotesPath,
        rootPackage,
        desktopPackage,
      });
      result = '已写入版本与 Release notes，等待人工审阅 Git 变更';
    }
  }

  const planPath = join(outputDirectory, `Zeus-${releaseVersion}-release-prepare-${applyChanges ? 'result' : 'plan'}.md`);
  const notesSnapshotPath = join(outputDirectory, `Zeus-${releaseVersion}-release-notes-reviewed.md`);
  if (resolve(sourceNotesPath) !== resolve(notesSnapshotPath)) copyFileSync(sourceNotesPath, notesSnapshotPath);
  writeFileSync(
    planPath,
    buildPlan({
      releaseVersion,
      latestTag,
      sourceNotesPath,
      targetNotesPath,
      applyChanges,
      result,
      preparationState,
      worktreeStatusBefore,
      worktreeStatusAfter: git(['status', '--short']),
    }),
    { mode: 0o600 },
  );

  console.log(`发布候选准备：${result}`);
  console.log(`计划或结果：${planPath}`);
  console.log(`ZEUS_ARTIFACT_FILE=${planPath}`);
  console.log(`ZEUS_ARTIFACT_FILE=${notesSnapshotPath}`);
}

function requiredVersion(rawValue) {
  const version = rawValue?.trim() ?? '';
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('RELEASE_VERSION 为必填稳定版本号，例如 0.1.10。');
  }
  return version;
}

function requiredFile(rawValue, name) {
  const value = rawValue?.trim() ?? '';
  if (!value) throw new Error(`${name} 为必填文件路径。`);
  const path = resolve(repositoryRoot, value);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name} 不是可读文件：${path}`);
  if (statSync(path).size > 64 * 1024) throw new Error(`${name} 超过 64 KiB，拒绝作为 Release notes。`);
  return path;
}

function parseBoolean(name, rawValue, defaultValue) {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const normalized = rawValue.trim().toLocaleLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`${name} 必须是布尔值；当前值为 ${rawValue}。`);
}

function resolveLatestStableTag() {
  const tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) throw new Error(`最新稳定标签格式无效：${tag}`);
  return tag;
}

function assertVersionAfterBase(version, tag) {
  const target = version.split('.').map(Number);
  const base = tag.slice(1).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (target[index] > base[index]) return;
    if (target[index] < base[index]) break;
  }
  throw new Error(`目标版本 ${version} 必须高于最新稳定标签 ${tag}。`);
}

function assertTagDoesNotExist(version) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], { cwd: repositoryRoot });
  if (result.status === 0) throw new Error(`标签 v${version} 已存在，拒绝重新准备同版本。`);
}

function validateReleaseNotes(markdown, version) {
  const requiredTitle = `# Zeus ${version} 更新内容`;
  if (!markdown.startsWith(`${requiredTitle}\n`)) throw new Error(`Release notes 标题必须是：${requiredTitle}`);
  for (const heading of ['## 如何升级', '## 系统要求与已知限制', '## 发布验证']) {
    if (!markdown.includes(`\n${heading}\n`)) throw new Error(`Release notes 缺少必要章节：${heading}`);
  }
  if (!markdown.includes('brew upgrade --cask imchenway/tap/zeus')) {
    throw new Error('Release notes 缺少 Homebrew 升级命令。');
  }
  if (!markdown.includes(`Zeus-${version}-arm64.dmg`)) {
    throw new Error(`Release notes 缺少版本化 DMG 名称：Zeus-${version}-arm64.dmg。`);
  }
  if (/docs\/releases\/v[^\s]+\.md|TASK_\d+/u.test(markdown)) {
    throw new Error('Release notes 泄漏内部任务或发布文档路径。');
  }
  const leakedCommentary = markdown.match(/用户要求只返回|confidence\s*[=:：]|uncertainties\s*[=:：]|以下无其他字段|最终正文如上/iu)?.[0];
  if (leakedCommentary) throw new Error(`Release notes 混入生成过程说明“${leakedCommentary}”。`);
}

function readPackage(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolvePreparationState(input) {
  if (input.rootPackage.version !== input.desktopPackage.version) {
    throw new Error(`根包与桌面包版本不一致：root=${input.rootPackage.version ?? 'missing'} desktop=${input.desktopPackage.version ?? 'missing'}`);
  }
  if (input.rootPackage.version === input.releaseVersion) {
    if (!existsSync(input.targetNotesPath) || readFileSync(input.targetNotesPath, 'utf8') !== input.sourceNotes) {
      throw new Error('包版本已是目标版本，但仓库 Release notes 缺失或与已审阅内容不一致。');
    }
    return 'prepared';
  }
  if (input.rootPackage.version !== input.baseVersion) {
    throw new Error(`当前包版本既不是公开基线 ${input.baseVersion}，也不是目标版本 ${input.releaseVersion}：${input.rootPackage.version ?? 'missing'}`);
  }
  if (existsSync(input.targetNotesPath)) {
    throw new Error(`目标 Release notes 已存在但包版本尚未升级，拒绝覆盖：${input.targetNotesPath}`);
  }
  return 'pending';
}

function assertOnlyPreparedPathsChanged(status, targetNotesPath) {
  if (!status) return;
  const allowed = new Set(['package.json', 'apps/desktop/package.json', relativeToRepository(targetNotesPath)]);
  const unexpected = status
    .split(/\r?\n/u)
    .map((line) => line.slice(3).split(' -> ').at(-1))
    .filter((path) => path && !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(`候选版本已写入，但工作区还有无关变更：\n${unexpected.join('\n')}`);
  }
}

function applyCandidateChanges(input) {
  const originalFiles = [
    { path: input.rootPackagePath, existed: true, content: readFileSync(input.rootPackagePath, 'utf8') },
    { path: input.desktopPackagePath, existed: true, content: readFileSync(input.desktopPackagePath, 'utf8') },
    { path: input.targetNotesPath, existed: existsSync(input.targetNotesPath), content: existsSync(input.targetNotesPath) ? readFileSync(input.targetNotesPath, 'utf8') : '' },
  ];
  const nextRootPackage = `${JSON.stringify({ ...input.rootPackage, version: input.releaseVersion }, null, 2)}\n`;
  const nextDesktopPackage = `${JSON.stringify({ ...input.desktopPackage, version: input.releaseVersion }, null, 2)}\n`;

  try {
    mkdirSync(dirname(input.targetNotesPath), { recursive: true });
    writeFileSync(input.rootPackagePath, nextRootPackage);
    writeFileSync(input.desktopPackagePath, nextDesktopPackage);
    writeFileSync(input.targetNotesPath, input.sourceNotes);
    run('pnpm', ['exec', 'prettier', '--check', 'package.json', 'apps/desktop/package.json']);
    run('git', ['diff', '--check', '--', 'package.json', 'apps/desktop/package.json']);
  } catch (error) {
    for (const file of originalFiles) {
      if (file.existed) writeFileSync(file.path, file.content);
      else if (existsSync(file.path)) unlinkSync(file.path);
    }
    throw error;
  }
}

function buildPlan(input) {
  return [
    `# Zeus ${input.releaseVersion} 发布候选准备${input.applyChanges ? '结果' : '计划'}`,
    '',
    '## 输入',
    '',
    `- 最新稳定标签：${input.latestTag}`,
    `- 目标版本：${input.releaseVersion}`,
    `- 已审阅 Release notes：${input.sourceNotesPath}`,
    `- 目标 Release notes：${input.targetNotesPath}`,
    `- 执行前状态：${input.preparationState === 'prepared' ? '已准备' : '待准备'}`,
    `- APPLY_CHANGES：${input.applyChanges ? 'true' : 'false'}`,
    '',
    '## 结果',
    '',
    `- ${input.result}。`,
    `- 根包目标版本：${input.releaseVersion}`,
    `- 桌面包目标版本：${input.releaseVersion}`,
    `- 执行前工作区：${input.worktreeStatusBefore || '干净'}`,
    `- 执行后工作区：${input.worktreeStatusAfter || '干净'}`,
    '',
    '## 边界',
    '',
    '- 本命令最多只修改 `package.json`、`apps/desktop/package.json` 和目标 Release notes。',
    '- 本命令不创建分支、提交、PR、标签、GitHub Release 或 Homebrew Tap 变更。',
    '- 写入后必须人工审阅 Git 变更，再进入本地发布门禁。',
    '',
  ].join('\n');
}

function resolveOutputDirectory(version) {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  if (commandRunDirectory) return resolve(commandRunDirectory);
  return mkdtempSync(join(tmpdir(), `zeus-release-prepare-${version}-`));
}

function relativeToRepository(path) {
  return path.slice(`${repositoryRoot}/`.length);
}

function git(args) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 执行失败：${result.stderr.trim() || `退出码 ${result.status ?? 'unknown'}`}`);
  return result.stdout.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${result.status ?? 'unknown'}。`);
}
