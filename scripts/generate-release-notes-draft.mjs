#!/usr/bin/env node
/* global console, process */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { URL } from 'node:url';

process.on('uncaughtException', (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

const repositoryRoot = resolve(import.meta.dirname, '..');
const releaseVersion = requiredVersion(process.env.RELEASE_VERSION);
const includeWorktree = parseBoolean(process.env.INCLUDE_WORKTREE, true);
const releaseContext = boundedText(process.env.RELEASE_CONTEXT, 2_000);
const automatedRelease = parseBoolean(process.env.AUTOMATED_RELEASE, false);
const baseTag = resolveBaseTag(process.env.BASE_TAG);
const headSha = git(['rev-parse', 'HEAD']);
const shortHeadSha = git(['rev-parse', '--short=12', 'HEAD']);
const branch = git(['branch', '--show-current']) || '(detached HEAD)';
const unresolvedMarkerPattern = /(?<![\p{L}\p{N}])(?:待确认|待验证|待发布门禁确认|尚未确认|尚未验证)(?![\p{L}\p{N}])|\b(?:TODO|TBD)\b/iu;

assertAncestor(baseTag, headSha);
assertVersionAfterBase(releaseVersion, baseTag);

const outputDirectory = resolveOutputDirectory(releaseVersion, shortHeadSha);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const evidencePath = join(outputDirectory, `Zeus-${releaseVersion}-release-evidence.md`);
const draftPath = join(outputDirectory, `Zeus-${releaseVersion}-release-notes-draft.md`);
const evidence = buildEvidence();

writeFileSync(evidencePath, evidence, { mode: 0o600 });
const prompt = buildPrompt(evidencePath, evidence);

console.log(`Zeus 发布内容草稿：版本 ${releaseVersion}，范围 ${baseTag}..${shortHeadSha}`);
let response;
let usedDeterministicFallback = false;
try {
  response = await requestDeepSeekReleaseNotes(prompt);
  console.log('发布说明已由 Zeus 配置的 deepseek-v4-flash 生成。');
} catch (error) {
  console.warn(`deepseek-v4-flash 生成发布说明失败，使用确定性模板继续：${error instanceof Error ? error.message : String(error)}`);
  response = buildDeterministicFallback();
  usedDeterministicFallback = true;
}

if (automatedRelease && (response.confidence !== 'high' || !Array.isArray(response.uncertainties) || response.uncertainties.length > 0)) {
  console.warn(`AI 发布内容没有达到无人值守置信要求，使用确定性模板继续：confidence=${response.confidence ?? 'missing'} uncertainties=${JSON.stringify(response.uncertainties ?? 'missing')}`);
  response = buildDeterministicFallback();
  usedDeterministicFallback = true;
}
let markdown = normalizeMarkdown(response.markdown);
try {
  validateDraft(markdown);
} catch (error) {
  if (!automatedRelease || usedDeterministicFallback) throw error;
  console.warn(`AI 发布内容未通过确定性校验，使用确定性模板继续：${error instanceof Error ? error.message : String(error)}`);
  response = buildDeterministicFallback();
  markdown = normalizeMarkdown(response.markdown);
  validateDraft(markdown);
}
writeFileSync(draftPath, markdown, { mode: 0o600 });

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

function buildPrompt(currentEvidencePath, currentEvidence) {
  const ignoredReleaseNotes = join(repositoryRoot, 'docs', 'releases', `v${releaseVersion}.md`);
  const committedDiff = boundedModelContext(git(['diff', '--no-ext-diff', '--unified=2', `${baseTag}..${headSha}`], { maxBuffer: 16 * 1024 * 1024 }), 160_000);
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
8. “如何升级”必须包含 Homebrew 命令 \`brew upgrade --cask imchenway/tap/zeus\` 和版本化 DMG 手动升级方式，并原样包含文件名 \`Zeus-${releaseVersion}-arm64.dmg\`。
9. 不写营销套话，不虚构性能数字，不使用源码行号或内部任务编号充当用户说明。
10. 这是草稿，不要写 GitHub Release 已发布、Tap 已同步或用户已经完成升级。
${automatedRelease ? '11. 本次用于无人值守发布。confidence 只评价正文中的用户向变更事实；这些事实均有明确证据时设为 high 且 uncertainties 返回空数组。版本写入、后续门禁、正式制品和公开发布将在草稿通过后由编排器执行，它们尚未发生是确定的流程阶段，不是 uncertainty；必须在“发布验证”中准确写成后续动作。任何用户向变更事实的疑点都必须放入 uncertainties，禁止用“待确认”“待验证”“TODO”“TBD”等占位语掩盖。已有证据支持的限制影响可以如实使用“可能”等概率表达。' : '11. 发布验证没有同一候选提交证据时，保留“待发布门禁确认”。'}

你无法读取本机文件，只能使用下面随请求提供的真实证据。最终只返回一个 JSON 对象，不要使用 Markdown 代码围栏；字段为 markdown、confidence、uncertainties。

<release_evidence>
${boundedModelContext(currentEvidence, 120_000)}
</release_evidence>

<committed_diff>
${committedDiff}
</committed_diff>
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

function resolveOutputDirectory(version, shortSha) {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  if (commandRunDirectory) return resolve(commandRunDirectory);
  return mkdtempSync(join(tmpdir(), `zeus-release-draft-${version}-${shortSha}-`));
}

function readPackageVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version ?? '未配置';
}

function readMinimumSystemVersion() {
  const builderConfig = readFileSync(join(repositoryRoot, 'apps', 'desktop', 'electron-builder.yml'), 'utf8');
  return builderConfig.match(/^\s*minimumSystemVersion:\s*["']?([^\s"']+)/mu)?.[1];
}

async function requestDeepSeekReleaseNotes(prompt) {
  const rawUrl = process.env.ZEUS_RELEASE_NOTES_API_URL?.trim() ?? '';
  const capability = process.env.ZEUS_RELEASE_NOTES_CAPABILITY?.trim() ?? '';
  if (!rawUrl || !capability) throw new Error('当前命令没有 Zeus 发布说明能力令牌');
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('发布说明能力只允许调用 Zeus 本机服务');
  }
  const controller = new globalThis.AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), 90_000);
  try {
    const apiResponse = await globalThis.fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4-flash', prompt }),
      signal: controller.signal,
    });
    const payload = await apiResponse.json().catch(() => null);
    if (!apiResponse.ok) {
      const message = payload && typeof payload.message === 'string' ? payload.message : `HTTP ${apiResponse.status}`;
      throw new Error(message);
    }
    const output = payload?.output;
    if (!output || typeof output.markdown !== 'string') throw new Error('Zeus 本机服务没有返回有效发布说明');
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('deepseek-v4-flash 在 90 秒内没有返回');
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function buildDeterministicFallback() {
  const validationLine = automatedRelease ? '- 公开前将由 Release Workflow 对固定候选提交执行类型检查、正式打包、DMG 完整性和更新清单一致性校验。' : '- 当前为候选草稿，正式结果待发布门禁确认。';
  return {
    markdown: [
      `# Zeus ${releaseVersion} 更新内容`,
      '',
      '## 本次更新',
      '',
      `- 本版本收录了 ${baseTag} 之后进入固定候选提交的功能改进与问题修复。`,
      '- AI 发布说明不可用时采用保守模板，不根据缺失证据扩写具体功能。',
      '',
      '## 如何升级',
      '',
      '- Homebrew 用户可执行 `brew upgrade --cask imchenway/tap/zeus`。',
      `- 也可以下载 \`Zeus-${releaseVersion}-arm64.dmg\`，退出正在运行的 Zeus 后覆盖安装。`,
      '',
      '## 系统要求与已知限制',
      '',
      `- 最低系统版本：macOS ${readMinimumSystemVersion() ?? '以公开安装包配置为准'}。`,
      '- 若公开清单显示应用尚未完成 Developer ID 签名或 Apple 公证，首次启动可能需要按 macOS 提示手动确认。',
      '',
      '## 发布验证',
      '',
      validationLine,
      '- 发布完成后将核对 GitHub 资产服务端摘要、更新清单与 Homebrew Cask。',
      '',
    ].join('\n'),
    confidence: 'high',
    uncertainties: [],
  };
}

function boundedModelContext(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n\n[内容超过 ${maxLength} 字符，已截断]`;
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
  const unresolvedMarker = markdown.match(unresolvedMarkerPattern)?.[0];
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
