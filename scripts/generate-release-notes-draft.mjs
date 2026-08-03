#!/usr/bin/env node
/* global console, process */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

process.on('uncaughtException', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

const repositoryRoot = resolve(import.meta.dirname, '..');
const releaseVersion = requiredVersion(process.env.RELEASE_VERSION);
const includeWorktree = parseBoolean(process.env.INCLUDE_WORKTREE, true);
const releaseContext = boundedText(process.env.RELEASE_CONTEXT, 2_000);
const releaseModel = optionalModel(process.env.RELEASE_MODEL);
const automatedRelease = parseBoolean(process.env.AUTOMATED_RELEASE, false);
const baseTag = resolveBaseTag(process.env.BASE_TAG);
const headSha = git(['rev-parse', 'HEAD']);
const shortHeadSha = git(['rev-parse', '--short=12', 'HEAD']);
const branch = git(['branch', '--show-current']) || '(detached HEAD)';

assertAncestor(baseTag, headSha);
assertVersionAfterBase(releaseVersion, baseTag);

const outputDirectory = resolveOutputDirectory(releaseVersion, shortHeadSha);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const evidencePath = join(outputDirectory, `Zeus-${releaseVersion}-release-evidence.md`);
const schemaPath = join(outputDirectory, 'release-notes-output.schema.json');
const rawResponsePath = join(outputDirectory, 'release-notes-response.json');
const draftPath = join(outputDirectory, `Zeus-${releaseVersion}-release-notes-draft.md`);
const evidence = buildEvidence();

writeFileSync(evidencePath, evidence, { mode: 0o600 });
writeFileSync(
  schemaPath,
  `${JSON.stringify(
    {
      type: 'object',
      additionalProperties: false,
      properties: automatedRelease
        ? {
            markdown: { type: 'string' },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            uncertainties: { type: 'array', items: { type: 'string' } },
          }
        : { markdown: { type: 'string' } },
      required: automatedRelease ? ['markdown', 'confidence', 'uncertainties'] : ['markdown'],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const prompt = buildPrompt(evidencePath);
const codexArgs = [
  'exec',
  '--ephemeral',
  '--ignore-user-config',
  '--sandbox',
  'read-only',
  '--skip-git-repo-check',
  '--cd',
  outputDirectory,
  '--output-schema',
  schemaPath,
  '--output-last-message',
  rawResponsePath,
  '--color',
  'never',
  '-c',
  'model_reasoning_effort="high"',
  '-c',
  'project_doc_max_bytes=0',
];
if (releaseModel) codexArgs.push('--model', releaseModel);
codexArgs.push('-');

console.log(`Zeus 发布内容草稿：版本 ${releaseVersion}，范围 ${baseTag}..${shortHeadSha}`);
console.log('正在调用 Codex 只读分析真实变更；该步骤不会修改项目、Git 历史或远端状态。');

const isolatedCodexHome = createIsolatedCodexHome();
let codex;
try {
  codex = spawnSync(process.env.ZEUS_CODEX_COMMAND_PATH?.trim() || 'codex', codexArgs, {
    cwd: outputDirectory,
    env: { ...process.env, CODEX_HOME: isolatedCodexHome },
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
} finally {
  rmSync(isolatedCodexHome, { recursive: true, force: true });
}
if (codex.error) {
  throw new Error(`无法启动 Codex CLI：${codex.error.message}`);
}
if (codex.status !== 0) {
  const diagnostic = codex.stderr?.trim().slice(-4_000);
  throw new Error(`Codex CLI 生成发布内容失败，退出码 ${codex.status ?? 'unknown'}。${diagnostic ? `\n${diagnostic}` : ''}`);
}

const response = parseResponse(rawResponsePath);
if (automatedRelease && (response.confidence !== 'high' || !Array.isArray(response.uncertainties) || response.uncertainties.length > 0)) {
  throw new Error(`AI 发布内容没有达到自动发布要求：confidence=${response.confidence ?? 'missing'} uncertainties=${JSON.stringify(response.uncertainties ?? 'missing')}`);
}
const markdown = normalizeMarkdown(response.markdown);
validateDraft(markdown);
writeFileSync(draftPath, markdown, { mode: 0o600 });
rmSync(schemaPath, { force: true });
rmSync(rawResponsePath, { force: true });

console.log(`发布内容草稿：${draftPath}`);
console.log(`生成证据：${evidencePath}`);
console.log(`ZEUS_ARTIFACT_FILE=${draftPath}`);
console.log(`ZEUS_ARTIFACT_FILE=${evidencePath}`);

function buildEvidence() {
  const committedFiles = git(['diff', '--name-status', `${baseTag}..${headSha}`], { maxBuffer: 4 * 1024 * 1024 });
  const committedStat = git(['diff', '--stat', `${baseTag}..${headSha}`], { maxBuffer: 4 * 1024 * 1024 });
  const commits = git(['log', '--no-merges', '--format=- `%h` %s', `${baseTag}..${headSha}`], { maxBuffer: 4 * 1024 * 1024 });
  const worktreeStatus = includeWorktree ? git(['status', '--short'], { maxBuffer: 4 * 1024 * 1024 }) : '按参数忽略工作区未提交变更。';
  const packageVersion = readPackageVersion(join(repositoryRoot, 'package.json'));
  const desktopVersion = readPackageVersion(join(repositoryRoot, 'apps', 'desktop', 'package.json'));
  const minimumSystemVersion = readMinimumSystemVersion();
  const changedTaskDocuments = committedFiles
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? '')
    .filter((path) => /^docs\/TASK_.+\.md$/u.test(path))
    .filter((path) => !path.includes(`${releaseVersion}升级发布`));

  return [
    '# Zeus 发布内容生成证据',
    '',
    '## 候选版本',
    '',
    `- 目标版本：${releaseVersion}`,
    `- 基线标签：${baseTag}`,
    `- 候选提交：${headSha}`,
    `- 当前分支：${branch}`,
    `- 根包版本：${packageVersion}`,
    `- 桌面包版本：${desktopVersion}`,
    `- 最低系统版本配置：${minimumSystemVersion ?? '未读取到'}`,
    `- 包含未提交工作区：${includeWorktree ? '是' : '否'}`,
    '',
    '## 用户补充范围',
    '',
    releaseContext || '未提供。',
    '',
    '## 提交摘要',
    '',
    commits || '基线标签之后没有普通提交。',
    '',
    '## 已提交文件变化',
    '',
    '```text',
    committedFiles || '无',
    '```',
    '',
    '## 变更统计',
    '',
    '```text',
    committedStat || '无',
    '```',
    '',
    '## 相关任务文档',
    '',
    ...(changedTaskDocuments.length > 0 ? changedTaskDocuments.map((path) => `- ${path}`) : ['- 未发现。']),
    '',
    '## 当前工作区',
    '',
    '```text',
    worktreeStatus || '工作区干净。',
    '```',
    '',
    '## 证据边界',
    '',
    '- 本文件只证明 Git 范围、版本配置和工作区状态。',
    '- 除非候选范围内存在同一提交对应的真实记录，否则不得声称 lint、typecheck、build、打包、桌面交互、签名、公证或公开发布已经通过。',
    '- `dist/` 可能包含旧制品，本次生成不读取它，也不得把旧制品信息写入新版本 Release notes。',
    '',
  ].join('\n');
}

function buildPrompt(currentEvidencePath) {
  const ignoredReleaseNotes = join(repositoryRoot, 'docs', 'releases', `v${releaseVersion}.md`);
  return `你负责为 Zeus ${releaseVersion} 生成一份面向用户的候选 Release notes。

这只是只读内容生成，不发布、不修改源码、不运行验证命令。最终响应必须满足输出 Schema；markdown 字段只能包含 Release notes 正文，confidence、uncertainties 或生成过程说明只能放在各自字段，禁止追加到 markdown。

事实入口：
- 仓库根目录：${repositoryRoot}
- 生成证据：${currentEvidencePath}
- Git 范围：${baseTag}..${headSha}
- 忽略既有目标版本发布正文：${ignoredReleaseNotes}

工作要求：
1. 先完整读取生成证据，再按需只读检查真实 Git diff、相关任务文档、package.json、apps/desktop/electron-builder.yml 和上一版本 Release notes。
2. 不得读取或复用 ${ignoredReleaseNotes}、docs/release.md 中目标版本的发布结果，也不得以目标版本的升级发布结果文档反推正文。
3. 用用户能理解的功能和交互变化组织内容，不把 commit subject、文件清单或内部实现名直接当作发布卖点。
4. 只写证据支持的事实；发布验证章节描述本次公开前必经的门禁与回验，不得伪造当前尚未发生的结果。版本写入、发布门禁、正式制品和公开发布尚未执行，是本生成阶段的预期流程状态，不属于用户向变更事实的不确定性，也不得因此降低 confidence 或写入 uncertainties。
5. 当前公开制品若仍是 ad-hoc、未公证，只能描述为手动升级，不得声称应用内自动安装可用。
6. 必须使用简体中文，标题必须精确为“# Zeus ${releaseVersion} 更新内容”。
7. 必须包含“## 如何升级”“## 系统要求与已知限制”“## 发布验证”三个二级标题；前面按真实变化生成一至四个用户向主题。
8. “如何升级”必须包含 Homebrew 命令 \`brew upgrade --cask imchenway/tap/zeus\` 和版本化 DMG 手动升级方式。
9. 不写营销套话，不虚构性能数字，不使用源码行号或内部任务编号充当用户说明。
10. 这是草稿，不要写 GitHub Release 已发布、Tap 已同步或用户已经完成升级。
${automatedRelease ? '11. 本次用于无人值守发布。confidence 只评价正文中的用户向变更事实；这些事实均有明确证据时设为 high 且 uncertainties 返回空数组。版本写入、后续门禁、正式制品和公开发布将在草稿通过后由编排器执行，它们尚未发生是确定的流程阶段，不是 uncertainty；必须在“发布验证”中准确写成后续动作。任何用户向变更事实的疑点都必须放入 uncertainties，禁止用“待确认”“待验证”“TODO”“TBD”等占位语掩盖。已有证据支持的限制影响可以如实使用“可能”等概率表达。' : '11. 发布验证没有同一候选提交证据时，保留“待发布门禁确认”。'}
`;
}

function git(args, options = {}) {
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} 执行失败：${result.stderr.trim() || `退出码 ${result.status}`}`);
  }
  return result.stdout.trim();
}

function resolveBaseTag(rawValue) {
  const requested = rawValue?.trim();
  const tag = requested || git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
  if (!/^v\d+\.\d+\.\d+$/u.test(tag)) {
    throw new Error(`BASE_TAG 必须是稳定版本标签，例如 v0.1.9；当前值为 ${tag || 'empty'}。`);
  }
  git(['rev-parse', '--verify', `${tag}^{commit}`]);
  return tag;
}

function assertAncestor(tag, head) {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', `${tag}^{commit}`, head], { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`基线标签 ${tag} 不是当前候选提交的祖先。`);
}

function requiredVersion(rawValue) {
  const version = rawValue?.trim() ?? '';
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('RELEASE_VERSION 为必填稳定版本号，例如 0.1.10。');
  }
  return version;
}

function assertVersionAfterBase(version, tag) {
  const target = version.split('.').map(Number);
  const base = tag.slice(1).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (target[index] > base[index]) return;
    if (target[index] < base[index]) break;
  }
  throw new Error(`目标版本 ${version} 必须高于基线标签 ${tag.slice(1)}。`);
}

function parseBoolean(rawValue, defaultValue) {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const normalized = rawValue.trim().toLocaleLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`INCLUDE_WORKTREE 必须是布尔值；当前值为 ${rawValue}。`);
}

function boundedText(rawValue, maxLength) {
  const value = rawValue?.trim() ?? '';
  if (value.length > maxLength) throw new Error(`RELEASE_CONTEXT 最多 ${maxLength} 个字符。`);
  return value;
}

function optionalModel(rawValue) {
  const value = rawValue?.trim() ?? '';
  if (value && !/^[A-Za-z0-9._-]{1,80}$/u.test(value)) throw new Error(`RELEASE_MODEL 格式无效：${value}`);
  return value;
}

function resolveOutputDirectory(version, shortSha) {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  if (commandRunDirectory) return resolve(commandRunDirectory);
  return mkdtempSync(join(tmpdir(), `zeus-release-draft-${version}-${shortSha}-`));
}

function createIsolatedCodexHome() {
  const sourceHome = resolve(process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'));
  const sourceAuth = join(sourceHome, 'auth.json');
  if (!existsSync(sourceAuth)) {
    throw new Error('未找到现有 Codex CLI 登录信息；请先在终端完成 codex login。');
  }
  const isolatedHome = mkdtempSync(join(tmpdir(), 'zeus-release-codex-home-'));
  symlinkSync(sourceAuth, join(isolatedHome, 'auth.json'));
  return isolatedHome;
}

function readPackageVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version ?? '未配置';
}

function readMinimumSystemVersion() {
  const builderConfig = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
  return builderConfig.match(/^\s*minimumSystemVersion:\s*["']?([^\s"']+)/mu)?.[1];
}

function parseResponse(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value.markdown !== 'string') throw new Error('响应缺少 markdown 字段');
    return value;
  } catch (error) {
    throw new Error(`Codex 返回的结构化发布内容无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeMarkdown(value) {
  return `${value.replace(/\r\n/gu, '\n').trim()}\n`;
}

function validateDraft(markdown) {
  const requiredTitle = `# Zeus ${releaseVersion} 更新内容`;
  if (!markdown.startsWith(`${requiredTitle}\n`)) throw new Error(`发布内容标题必须是：${requiredTitle}`);
  for (const heading of ['## 如何升级', '## 系统要求与已知限制', '## 发布验证']) {
    if (!markdown.includes(`\n${heading}\n`)) throw new Error(`发布内容缺少必要章节：${heading}`);
  }
  if (!markdown.includes('brew upgrade --cask imchenway/tap/zeus')) {
    throw new Error('发布内容缺少 Homebrew 升级命令。');
  }
  if (!markdown.includes(`Zeus-${releaseVersion}-arm64.dmg`)) {
    throw new Error(`发布内容缺少版本化 DMG 名称：Zeus-${releaseVersion}-arm64.dmg。`);
  }
  if (!automatedRelease && !markdown.includes('待发布门禁确认')) {
    throw new Error('发布内容没有保留“待发布门禁确认”的验证边界。');
  }
  const unresolvedMarker = markdown.match(/待.{0,6}(?:确认|验证)|尚未(?:确认|验证)|TODO|TBD/iu)?.[0];
  if (automatedRelease && unresolvedMarker) {
    throw new Error(`自动发布内容包含未解决占位“${unresolvedMarker}”，拒绝进入版本写入阶段。`);
  }
  if (markdown.length > 32_000) throw new Error('发布内容超过 32,000 字符，拒绝作为命令产物。');
  if (/docs\/releases\/v[^\s]+\.md|TASK_\d+/u.test(markdown)) {
    throw new Error('发布内容泄漏内部任务或发布文档路径，请调整生成范围后重试。');
  }
  const leakedCommentary = markdown.match(/用户要求只返回|confidence\s*[=:：]|uncertainties\s*[=:：]|以下无其他字段|最终正文如上/iu)?.[0];
  if (leakedCommentary) throw new Error(`发布内容混入生成过程说明“${leakedCommentary}”，拒绝写入草稿。`);
}
