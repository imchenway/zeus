#!/usr/bin/env node
/* global console, process */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {
    copyFileSync,
    createReadStream,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    statSync,
    writeFileSync
} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const expectedVersion = requiredVersion(process.env.EXPECTED_VERSION);
  const allowDirtyWorktree = parseBoolean('ALLOW_DIRTY_WORKTREE', process.env.ALLOW_DIRTY_WORKTREE, false);
  const requireAppleDistribution = parseBoolean('REQUIRE_APPLE_DISTRIBUTION', process.env.REQUIRE_APPLE_DISTRIBUTION, false);
  const registerDmgArtifact = parseBoolean('REGISTER_DMG_ARTIFACT', process.env.REGISTER_DMG_ARTIFACT, false);
  const latestTag = resolveLatestStableTag();
  const headSha = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
    const releaseOutputDirectory = resolve(repositoryRoot, process.env.ZEUS_RELEASE_OUTPUT_DIR?.trim() || 'dist');

  assertVersionAfterBase(expectedVersion, latestTag);
  assertTagDoesNotExist(expectedVersion);
  assertPackageVersions(expectedVersion);

  const releaseNotesPath = join(repositoryRoot, 'docs', 'releases', `v${expectedVersion}.md`);
  validateReleaseNotes(releaseNotesPath, expectedVersion);

  const worktreeStatus = git(['status', '--short']);
  if (worktreeStatus && !allowDirtyWorktree) {
    throw new Error(['发布门禁要求可复现的候选提交，当前工作区不干净。', '请先审阅并处理变更；仅在明确进行本地非正式试跑时设置 ALLOW_DIRTY_WORKTREE=true。', worktreeStatus].join('\n'));
  }

  if (process.platform !== 'darwin') {
    throw new Error('Zeus 完整发布门禁只能在 macOS 上执行。');
  }

  console.log(`Zeus 发布门禁：版本 ${expectedVersion}，范围 ${latestTag}..${headSha.slice(0, 12)}`);
  console.log('正在执行静态检查、验收矩阵、正式打包和产物校验；不执行 Git 写入或公开发布。');
  run('pnpm', ['verify:release'], {
    env: {
      ...process.env,
      ZEUS_REQUIRE_DISTRIBUTABLE_RELEASE: requireAppleDistribution ? '1' : '0',
        ZEUS_RELEASE_OUTPUT_DIR: releaseOutputDirectory,
    },
  });

  const architecture = process.arch === 'x64' ? 'x64' : 'arm64';
    const dmgPath = join(releaseOutputDirectory, `Zeus-${expectedVersion}-${architecture}.dmg`);
    const manifestPath = join(releaseOutputDirectory, 'zeus-release-manifest.json');
    const generatedCaskPath = join(releaseOutputDirectory, 'homebrew', 'zeus.rb');
    const appPath = join(releaseOutputDirectory, architecture === 'arm64' ? 'mac-arm64' : 'mac', 'Zeus.app');

  for (const path of [dmgPath, manifestPath, generatedCaskPath, appPath]) {
    if (!existsSync(path)) throw new Error(`发布门禁缺少必需产物：${path}`);
  }

  run('/usr/bin/hdiutil', ['verify', dmgPath]);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const artifact = validateManifest(manifest, expectedVersion, architecture, dmgPath);
  const dmgSha256 = await sha256File(dmgPath);
  const dmgSize = statSync(dmgPath).size;
  if (artifact.sha256 !== dmgSha256 || artifact.sizeBytes !== dmgSize) {
    throw new Error(`更新清单与 DMG 不一致：manifest=${artifact.sha256}/${artifact.sizeBytes} actual=${dmgSha256}/${dmgSize}`);
  }

  validateGeneratedCask(generatedCaskPath, expectedVersion, dmgSha256, architecture);
  const gatekeeper = capture('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath], true);
  const outputDirectory = resolveOutputDirectory(expectedVersion, headSha.slice(0, 12));
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const summaryPath = join(outputDirectory, `Zeus-${expectedVersion}-release-gate-summary.md`);
  const notesSnapshotPath = join(outputDirectory, basename(releaseNotesPath));
  const manifestSnapshotPath = join(outputDirectory, `Zeus-${expectedVersion}-release-manifest.json`);
  const caskSnapshotPath = join(outputDirectory, `Zeus-${expectedVersion}-homebrew-cask.rb`);
  copyFileSync(releaseNotesPath, notesSnapshotPath);
  copyFileSync(manifestPath, manifestSnapshotPath);
  copyFileSync(generatedCaskPath, caskSnapshotPath);
  writeFileSync(
    summaryPath,
    buildSummary({
      expectedVersion,
      latestTag,
      headSha,
      branch,
      allowDirtyWorktree,
      worktreeStatus,
      requireAppleDistribution,
      manifest,
      architecture,
      dmgPath,
      dmgSha256,
      dmgSize,
      gatekeeper,
    }),
    { mode: 0o600 },
  );

  const artifactPaths = [summaryPath, notesSnapshotPath, manifestSnapshotPath, caskSnapshotPath];
  if (registerDmgArtifact) {
    const dmgArtifactPath = join(outputDirectory, basename(dmgPath));
    registerLargeArtifact(dmgPath, dmgArtifactPath);
    artifactPaths.push(dmgArtifactPath);
  }

  console.log(`发布门禁通过：${summaryPath}`);
  console.log(`DMG：${dmgPath}`);
  for (const path of artifactPaths) console.log(`ZEUS_ARTIFACT_FILE=${path}`);
}

function requiredVersion(rawValue) {
  const version = rawValue?.trim() ?? '';
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error('EXPECTED_VERSION 为必填稳定版本号，例如 0.1.10。');
  }
  return version;
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
  throw new Error(`目标版本 ${version} 必须高于最新公开基线 ${tag}，拒绝重新打包已发布版本。`);
}

function assertTagDoesNotExist(version) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/v${version}`], { cwd: repositoryRoot });
  if (result.status === 0) throw new Error(`标签 v${version} 已存在，拒绝把已标记版本当作新候选版本重新打包。`);
}

function assertPackageVersions(expectedVersion) {
  for (const relativePath of ['package.json', 'apps/desktop/package.json']) {
    const actualVersion = JSON.parse(readFileSync(join(repositoryRoot, relativePath), 'utf8')).version;
    if (actualVersion !== expectedVersion) {
      throw new Error(`${relativePath} 版本与期望不一致：expected=${expectedVersion} actual=${actualVersion ?? 'missing'}`);
    }
  }
}

function validateReleaseNotes(path, version) {
  if (!existsSync(path) || statSync(path).size === 0) throw new Error(`缺少已审阅的 Release notes：${path}`);
  const markdown = readFileSync(path, 'utf8');
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
}

function validateManifest(manifest, version, architecture, dmgPath) {
  if (manifest.version !== version || manifest.channel !== 'stable') {
    throw new Error(`更新清单版本或通道不一致：version=${manifest.version ?? 'missing'} channel=${manifest.channel ?? 'missing'}`);
  }
  const expectedFileName = basename(dmgPath);
  const artifact = manifest.artifacts?.find((candidate) => candidate.arch === architecture && candidate.kind === 'dmg' && candidate.fileName === expectedFileName);
  if (!artifact) throw new Error(`更新清单缺少目标产物：${expectedFileName}`);
  return artifact;
}

function validateGeneratedCask(path, version, sha256, architecture) {
  const content = readFileSync(path, 'utf8');
  const homebrewArchitecture = architecture === 'x64' ? 'x86_64' : architecture;
  for (const expected of [`version "${version}"`, `sha256 "${sha256}"`, `depends_on arch: :${homebrewArchitecture}`]) {
    if (!content.includes(expected)) throw new Error(`Homebrew Cask 与发布产物不一致，缺少：${expected}`);
  }
}

function buildSummary(input) {
  const gatekeeperText = input.gatekeeper.output || `退出码 ${input.gatekeeper.status}`;
  return [
    `# Zeus ${input.expectedVersion} 发布门禁摘要`,
    '',
    '## 候选范围',
    '',
    `- 最新公开基线：${input.latestTag}`,
    `- 候选提交：${input.headSha}`,
    `- 当前分支：${input.branch}`,
    `- 工作区：${input.worktreeStatus ? (input.allowDirtyWorktree ? '包含已明确允许的未提交变更' : '非预期脏状态') : '干净'}`,
    '',
    '## 已完成门禁',
    '',
    '- `pnpm verify:release`：通过。',
    '- DMG `hdiutil verify`：通过。',
    '- 更新清单的版本、架构、文件名、字节数和 SHA-256 与本地 DMG 一致。',
    '- 生成的 Homebrew Cask 与同一版本、架构和 DMG SHA-256 一致。',
    '',
    '## 产物事实',
    '',
    `- DMG：${input.dmgPath}`,
    `- 架构：${input.architecture}`,
    `- 字节数：${input.dmgSize}`,
    `- SHA-256：${input.dmgSha256}`,
    `- Developer ID 签名：${input.manifest.signed ? '是' : '否'}`,
    `- Apple 公证：${input.manifest.notarized ? '是' : '否'}`,
    `- 本次是否强制 Apple 正式分发：${input.requireAppleDistribution ? '是' : '否'}`,
    '',
    '## Gatekeeper 现场',
    '',
    '```text',
    gatekeeperText,
    '```',
    '',
    '## 发布边界',
    '',
    '- 本摘要只证明本地发布门禁与产物对账通过，不代表真实桌面交互已验收。',
    '- 本命令没有创建提交、推送分支、创建标签、发布 GitHub Release 或同步 Homebrew Tap。',
    '- 公开发布前仍需复核 Release notes、真实桌面交互、CI、不可变标签和发布后回下载对账。',
    '',
  ].join('\n');
}

function resolveOutputDirectory(version, shortSha) {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  if (commandRunDirectory) return resolve(commandRunDirectory);
  return mkdtempSync(join(tmpdir(), `zeus-release-gate-${version}-${shortSha}-`));
}

function registerLargeArtifact(sourcePath, destinationPath) {
  try {
    linkSync(sourcePath, destinationPath);
  } catch {
    copyFileSync(sourcePath, destinationPath);
  }
}

function git(args) {
  return capture('git', ['-c', 'core.quotePath=false', ...args]).output;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${result.status ?? 'unknown'}。`);
}

function capture(command, args, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr.trim() || `退出码 ${result.status ?? 'unknown'}`}`);
  }
  return {
    status: result.status,
    output: [result.stdout, result.stderr]
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n'),
  };
}

function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('error', rejectHash);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolveHash(hash.digest('hex')));
  });
}
