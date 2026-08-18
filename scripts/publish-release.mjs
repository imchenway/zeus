#!/usr/bin/env node
/* global console, process */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const repositoryRoot = resolve(import.meta.dirname, '..');
const repository = 'imchenway/zeus';
const homebrewRepository = 'imchenway/homebrew-tap';

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const releaseVersion = requiredVersion(process.env.RELEASE_VERSION);
  const applyRemote = parseBoolean('APPLY_REMOTE', process.env.APPLY_REMOTE, false);
  const requireAppleDistribution = parseBoolean('REQUIRE_APPLE_DISTRIBUTION', process.env.REQUIRE_APPLE_DISTRIBUTION, true);
  if (!requireAppleDistribution) {
    throw new Error('公开发布必须使用 Developer ID 签名并完成 Apple 公证；REQUIRE_APPLE_DISTRIBUTION 不允许关闭。');
  }
  const waitForCompletion = parseBoolean('WAIT_FOR_COMPLETION', process.env.WAIT_FOR_COMPLETION, true);
  const deepVerifyPublicDmg = parseBoolean('DEEP_VERIFY_PUBLIC_DMG', process.env.DEEP_VERIFY_PUBLIC_DMG, false);
  const confirmation = process.env.PUBLISH_CONFIRMATION?.trim() ?? '';
  const localGateSummaryPath = optionalFile(process.env.LOCAL_GATE_SUMMARY_FILE, 'LOCAL_GATE_SUMMARY_FILE');
  const tag = `v${releaseVersion}`;
  const outputDirectory = resolveOutputDirectory(releaseVersion);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  const preflight = collectPreflight({ releaseVersion, tag, requireAppleDistribution, localGateSummaryPath });
  const planPath = join(outputDirectory, `Zeus-${releaseVersion}-publish-${applyRemote ? 'execution' : 'plan'}.md`);
  writeFileSync(planPath, buildPlan(preflight, { releaseVersion, tag, applyRemote, requireAppleDistribution, waitForCompletion }), { mode: 0o600 });
  console.log(`ZEUS_ARTIFACT_FILE=${planPath}`);

  if (!applyRemote) {
    console.log(`公开发布计划：${planPath}`);
    console.log(preflight.blockers.length === 0 ? '只读前置检查通过；本次未执行任何 Git 或远程写操作。' : `只读前置检查发现 ${preflight.blockers.length} 个阻断项；本次未执行任何 Git 或远程写操作。`);
    return;
  }

  const expectedConfirmation = `PUBLISH_${tag}`;
  if (confirmation !== expectedConfirmation) {
    throw new Error(`真实公开发布要求 PUBLISH_CONFIRMATION=${expectedConfirmation}。`);
  }
  if (preflight.blockers.length > 0) {
    throw new Error(`公开发布前置检查未通过：\n- ${preflight.blockers.join('\n- ')}\n详细计划：${planPath}`);
  }

  let release = readRelease(tag);
  let workflowRun = findActiveReleaseRun(preflight.headSha);
  const latestWorkflowRun = findLatestReleaseRun(preflight.headSha);
  const shouldRetryFailedWorkflow = release.exists && !workflowRun && latestWorkflowRun?.status === 'completed' && latestWorkflowRun.conclusion === 'failure';
  if ((!release.exists && !workflowRun) || shouldRetryFailedWorkflow) {
    const dispatchedAt = Date.now();
    dispatchReleaseWorkflow(tag, preflight.headSha, requireAppleDistribution);
    workflowRun = await waitForDispatchedRun(preflight.headSha, dispatchedAt);
  }

  if (!release.exists && !workflowRun) {
    throw new Error('已请求快速发布，但未找到对应的 Release Workflow 运行。请重新执行本命令继续。');
  }

  if (workflowRun && !waitForCompletion) {
    const resultPath = join(outputDirectory, `Zeus-${releaseVersion}-publish-dispatched.md`);
    writeFileSync(resultPath, buildDispatchedResult({ releaseVersion, tag, headSha: preflight.headSha, workflowRun }), { mode: 0o600 });
    console.log(`Release Workflow 已触发：${workflowRun.url}`);
    console.log(`ZEUS_ARTIFACT_FILE=${resultPath}`);
    return;
  }

  if (workflowRun) {
    workflowRun = await waitForWorkflowRun(workflowRun);
    release = readRelease(tag);
  }
  if (!release.exists) throw new Error(`Release Workflow 结束后仍未找到 GitHub Release：${tag}`);

  const verification = await verifyPublishedRelease({ releaseVersion, tag, headSha: preflight.headSha, release, outputDirectory, workflowRun, requireAppleDistribution, deepVerifyPublicDmg });
  const resultPath = join(outputDirectory, `Zeus-${releaseVersion}-publish-result.md`);
  writeFileSync(resultPath, buildPublishResult(verification), { mode: 0o600 });
  console.log(`公开发布与${deepVerifyPublicDmg ? '完整 DMG' : '轻量资产'}对账通过：${resultPath}`);
  for (const path of [resultPath, verification.releaseNotesSnapshotPath, verification.manifestSnapshotPath, verification.caskSnapshotPath]) {
    console.log(`ZEUS_ARTIFACT_FILE=${path}`);
  }
}

function collectPreflight(input) {
  const blockers = [];
  const headSha = git(['rev-parse', 'HEAD']);
  const branch = git(['branch', '--show-current']) || '(detached HEAD)';
  const worktreeStatus = git(['status', '--short']);
  const originUrl = git(['remote', 'get-url', 'origin']);
  const remoteMainSha = resolveRemoteReference('refs/heads/main');
  const localTagSha = resolveLocalTagSha(input.tag);
  const remoteTagSha = resolveRemoteTagSha(input.tag);
  const ghAuth = capture('gh', ['auth', 'status', '--hostname', 'github.com'], true);
  const release = readRelease(input.tag);
  const ciRun = findSuccessfulCiRun(headSha);
  const workflow = readReleaseWorkflow();
  const secretNames = readActionSecretNames();
  const releaseNotesPath = join(repositoryRoot, 'docs', 'releases', `${input.tag}.md`);
  let packageVersion = null;
  let desktopVersion = null;

  if (branch !== 'main') blockers.push(`当前分支必须是 main，实际为 ${branch}`);
  if (worktreeStatus) blockers.push('工作区必须干净');
  if (!isExpectedOrigin(originUrl)) blockers.push(`origin 不是 ${repository}：${originUrl}`);
  if (!remoteMainSha) blockers.push('无法读取 origin/main 远程提交');
  else if (remoteMainSha !== headSha) blockers.push(`本地 HEAD 与 origin/main 不一致：local=${headSha} remote=${remoteMainSha}`);
  if (ghAuth.status !== 0) blockers.push(`GitHub CLI 未完成可用登录：${ghAuth.stderr.trim() || ghAuth.stdout.trim() || `退出码 ${ghAuth.status}`}`);

  try {
    packageVersion = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).version;
    desktopVersion = JSON.parse(readFileSync(join(repositoryRoot, 'apps', 'desktop', 'package.json'), 'utf8')).version;
    if (packageVersion !== input.releaseVersion || desktopVersion !== input.releaseVersion) {
      blockers.push(`包版本必须均为 ${input.releaseVersion}：root=${packageVersion ?? 'missing'} desktop=${desktopVersion ?? 'missing'}`);
    }
  } catch (error) {
    blockers.push(`无法读取包版本：${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    validateReleaseNotesFile(releaseNotesPath, input.releaseVersion);
  } catch (error) {
    blockers.push(error instanceof Error ? error.message : String(error));
  }

  if (input.localGateSummaryPath) {
    try {
      validateLocalGateSummary(input.localGateSummaryPath, input.releaseVersion, headSha);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (!workflow.active) blockers.push(`Release Workflow 不可用：${workflow.detail}`);
  if (!secretNames.has('HOMEBREW_TAP_TOKEN')) blockers.push('GitHub Actions 缺少 HOMEBREW_TAP_TOKEN');
  if (input.requireAppleDistribution) {
    for (const name of ['MACOS_CERTIFICATE', 'MACOS_CERTIFICATE_PASSWORD']) {
      if (!secretNames.has(name)) blockers.push(`严格 Apple 分发缺少 ${name}`);
    }
    const hasAppleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((name) => secretNames.has(name));
    const hasApiKey = ['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((name) => secretNames.has(name));
    if (!hasAppleId && !hasApiKey) blockers.push('严格 Apple 分发缺少一组完整公证凭据');
  }

  if (localTagSha && localTagSha !== headSha) blockers.push(`本地标签 ${input.tag} 指向其他提交：${localTagSha}`);
  if (remoteTagSha && remoteTagSha !== headSha) blockers.push(`远程标签 ${input.tag} 指向其他提交：${remoteTagSha}`);
  if (release.exists && (!remoteTagSha || remoteTagSha !== headSha)) blockers.push(`GitHub Release ${input.tag} 存在，但远程标签未指向候选提交`);
  if (release.exists && (release.data.isDraft || release.data.isPrerelease)) blockers.push(`GitHub Release ${input.tag} 仍是草稿或预发布`);
  if (release.error) blockers.push(`无法确认 GitHub Release 是否存在：${release.error}`);

  return {
    blockers,
    headSha,
    branch,
    worktreeStatus,
    originUrl,
    remoteMainSha,
    localTagSha,
    remoteTagSha,
    ghAuthenticated: ghAuth.status === 0,
    release,
    ciRun,
    workflow,
    secretNames: [...secretNames].sort(),
    releaseNotesPath,
    localGateSummaryPath: input.localGateSummaryPath,
    packageVersion,
    desktopVersion,
  };
}

function buildPlan(preflight, input) {
  return [
    `# Zeus ${input.releaseVersion} 公开发布${input.applyRemote ? '执行前置' : '计划'}`,
    '',
    '## 候选事实',
    '',
    `- 标签：${input.tag}`,
    `- 分支：${preflight.branch}`,
    `- 候选提交：${preflight.headSha}`,
    `- origin/main：${preflight.remoteMainSha || '未读取到'}`,
    `- 根包／桌面包版本：${preflight.packageVersion ?? '未读取到'} / ${preflight.desktopVersion ?? '未读取到'}`,
    `- Release notes：${preflight.releaseNotesPath}`,
    `- 本地快速检查摘要：${preflight.localGateSummaryPath || '未提供'}`,
    `- main CI：${preflight.ciRun ? `${preflight.ciRun.conclusion} ${preflight.ciRun.url}` : '未完成；快速发布不串行等待'}`,
    `- 本地／远程标签：${preflight.localTagSha || '无'} / ${preflight.remoteTagSha || '无'}`,
    `- GitHub Release：${preflight.release.exists ? preflight.release.data.url : '无'}`,
    `- GitHub CLI 登录：${preflight.ghAuthenticated ? '可用' : '不可用'}`,
    `- Release Workflow：${preflight.workflow.active ? '可用' : '不可用'}`,
    `- Actions Secrets 名称：${preflight.secretNames.join(', ') || '无可见配置'}`,
    '',
    '## 执行开关',
    '',
    `- APPLY_REMOTE：${input.applyRemote ? 'true' : 'false'}`,
    `- REQUIRE_APPLE_DISTRIBUTION：${input.requireAppleDistribution ? 'true' : 'false'}`,
    `- WAIT_FOR_COMPLETION：${input.waitForCompletion ? 'true' : 'false'}`,
    '',
    '## 阻断项',
    '',
    ...(preflight.blockers.length > 0 ? preflight.blockers.map((blocker) => `- ${blocker}`) : ['- 无。']),
    '',
    '## 受控写操作',
    '',
    `1. 仅在阻断项为空、APPLY_REMOTE=true 且确认值精确为 PUBLISH_${input.tag} 时继续。`,
    '2. 以精确候选 SHA 触发 Release Workflow；Workflow 并行执行 typecheck 与正式打包。',
    `3. 所有阻塞作业通过后，由 Workflow 创建不可变标签 ${input.tag}、GitHub Release 并同步 Homebrew Tap。`,
    '4. 等待 Workflow 后读取 GitHub 资产服务端摘要并下载 manifest，核对 Release notes、SHA-256 与 Tap Cask。',
    '',
    '## 不在本命令中执行',
    '',
    '- 不创建或合入 PR；候选改动必须在进入本命令前已通过正常代码交付进入 main。',
    '- 不强推、不改写已存在标签、不删除失败发布留下的标签。',
    '- Workflow 在阻塞检查通过前不创建标签；失败后可对同一候选提交幂等重试。',
    '',
  ].join('\n');
}

function buildDispatchedResult(input) {
  return [
    `# Zeus ${input.releaseVersion} 公开发布已触发`,
    '',
    `- 标签：${input.tag}`,
    `- 提交：${input.headSha}`,
    `- Workflow：${input.workflowRun.url}`,
    '- 标签将在 Workflow 的阻塞检查和正式打包通过后创建。',
    '- WAIT_FOR_COMPLETION=false，本次不声称已完成 GitHub Release、Homebrew Tap 或公开产物对账。',
    '- Workflow 结束后应使用同一版本重新执行本命令，完成幂等发布后验证。',
    '',
  ].join('\n');
}

async function verifyPublishedRelease(input) {
  if (input.release.data.tagName !== input.tag || input.release.data.isDraft || input.release.data.isPrerelease) {
    throw new Error(`GitHub Release 状态不符合稳定版要求：tag=${input.release.data.tagName ?? 'missing'} draft=${input.release.data.isDraft} prerelease=${input.release.data.isPrerelease}`);
  }
  const releaseNotesPath = join(repositoryRoot, 'docs', 'releases', `${input.tag}.md`);
  const expectedNotes = normalizeText(readFileSync(releaseNotesPath, 'utf8'));
  const actualNotes = normalizeText(input.release.data.body ?? '');
  if (actualNotes !== expectedNotes) throw new Error('GitHub Release notes 与标签候选的仓库 Release notes 不一致。');

  const expectedDmgName = `Zeus-${input.releaseVersion}-arm64.dmg`;
  const expectedAssets = new Set([expectedDmgName, 'zeus-release-manifest.json']);
  const actualAssets = input.release.data.assets ?? [];
  const actualAssetNames = new Set(actualAssets.map((asset) => asset.name));
  if (actualAssetNames.size !== expectedAssets.size || [...expectedAssets].some((name) => !actualAssetNames.has(name))) {
    throw new Error(`GitHub Release 资产集合不一致：${[...actualAssetNames].join(', ') || 'empty'}`);
  }

  const dmgAsset = actualAssets.find((asset) => asset.name === expectedDmgName);
  const manifestAsset = actualAssets.find((asset) => asset.name === 'zeus-release-manifest.json');
  if (!/^sha256:[a-f0-9]{64}$/u.test(dmgAsset?.digest ?? '') || !Number.isInteger(dmgAsset?.size) || dmgAsset.size <= 0) {
    throw new Error('GitHub DMG 资产缺少可信的服务端 SHA-256 或字节数。');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(manifestAsset?.digest ?? '') || !Number.isInteger(manifestAsset?.size) || manifestAsset.size <= 0) {
    throw new Error('GitHub manifest 资产缺少可信的服务端 SHA-256 或字节数。');
  }

  const downloadDirectory = mkdtempSync(join(tmpdir(), `zeus-release-public-${input.releaseVersion}-`));
  try {
    run('gh', ['release', 'download', input.tag, '--repo', repository, '--pattern', 'zeus-release-manifest.json', '--dir', downloadDirectory]);
    const manifestPath = join(downloadDirectory, 'zeus-release-manifest.json');
    const manifestSha256 = await sha256File(manifestPath);
    const manifestSize = statSync(manifestPath).size;
    if (manifestAsset.size !== manifestSize || manifestAsset.digest !== `sha256:${manifestSha256}`) {
      throw new Error('GitHub manifest 资产元数据与下载文件不一致。');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const manifestArtifact = manifest.artifacts?.find((artifact) => artifact.arch === 'arm64' && artifact.kind === 'dmg' && artifact.fileName === expectedDmgName);
    if (manifest.version !== input.releaseVersion || manifest.channel !== 'stable' || !manifestArtifact) {
      throw new Error('公开 manifest 的版本、通道或 DMG 记录不一致。');
    }
    if (!manifest.signed || !manifest.notarized) {
      throw new Error('公开 manifest 未同时记录 Developer ID 签名和 Apple 公证，拒绝把身份不稳定的产物视为发布完成。');
    }
    const dmgSha256 = dmgAsset.digest.slice('sha256:'.length);
    const dmgSize = dmgAsset.size;
    if (manifestArtifact.sha256 !== dmgSha256 || manifestArtifact.sizeBytes !== dmgSize) {
      throw new Error('公开 manifest 与 GitHub DMG 服务端摘要或字节数不一致。');
    }

    if (input.deepVerifyPublicDmg) {
      run('gh', ['release', 'download', input.tag, '--repo', repository, '--pattern', expectedDmgName, '--dir', downloadDirectory]);
      const dmgPath = join(downloadDirectory, expectedDmgName);
      run('/usr/bin/hdiutil', ['verify', dmgPath]);
      const downloadedDmgSha256 = await sha256File(dmgPath);
      const downloadedDmgSize = statSync(dmgPath).size;
      if (downloadedDmgSha256 !== dmgSha256 || downloadedDmgSize !== dmgSize) {
        throw new Error('回下载 DMG 与 GitHub 服务端资产元数据不一致。');
      }
    }

    const cask = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${homebrewRepository}/contents/Casks/zeus.rb?ref=main`]);
    for (const expected of [`version "${input.releaseVersion}"`, `sha256 "${dmgSha256}"`, 'depends_on arch: :arm64']) {
      if (!cask.includes(expected)) throw new Error(`Homebrew Tap Cask 与公开 DMG 不一致，缺少：${expected}`);
    }

    const releaseNotesSnapshotPath = join(input.outputDirectory, `${input.tag}-release-notes.md`);
    const manifestSnapshotPath = join(input.outputDirectory, `${input.tag}-release-manifest.json`);
    const caskSnapshotPath = join(input.outputDirectory, `${input.tag}-homebrew-cask.rb`);
    copyFileSync(releaseNotesPath, releaseNotesSnapshotPath);
    copyFileSync(manifestPath, manifestSnapshotPath);
    writeFileSync(caskSnapshotPath, cask, { mode: 0o600 });

    return {
      releaseVersion: input.releaseVersion,
      tag: input.tag,
      headSha: input.headSha,
      releaseUrl: input.release.data.url,
      workflowUrl: input.workflowRun?.url ?? '已有 Release，本次未触发新 Workflow',
      dmgName: expectedDmgName,
      dmgSize,
      dmgSha256,
      manifestSize,
      manifestSha256,
      releaseNotesSha256: await sha256File(releaseNotesPath),
      caskSha256: sha256Text(cask),
      signed: Boolean(manifest.signed),
      notarized: Boolean(manifest.notarized),
      deepVerified: input.deepVerifyPublicDmg,
      releaseNotesSnapshotPath,
      manifestSnapshotPath,
      caskSnapshotPath,
    };
  } finally {
    rmSync(downloadDirectory, { recursive: true, force: true });
  }
}

function buildPublishResult(input) {
  return [
    `# Zeus ${input.releaseVersion} 公开发布结果`,
    '',
    `- 标签：${input.tag}`,
    `- 发布提交：${input.headSha}`,
    `- GitHub Release：${input.releaseUrl}`,
    `- Release Workflow：${input.workflowUrl}`,
    `- DMG：${input.dmgName}，${input.dmgSize} 字节，SHA-256 ${input.dmgSha256}`,
    `- manifest：${input.manifestSize} 字节，SHA-256 ${input.manifestSha256}`,
    `- Release notes SHA-256：${input.releaseNotesSha256}`,
    `- Homebrew Cask SHA-256：${input.caskSha256}`,
    `- Developer ID 签名：${input.signed ? '是' : '否'}`,
    `- Apple 公证：${input.notarized ? '是' : '否'}`,
    input.deepVerified ? '- 公开 DMG 已回下载并通过 `hdiutil verify`。' : '- 默认快速模式未回下载完整 DMG；正式 DMG 已在上传前通过 `hdiutil verify`。',
    `- GitHub 服务端资产元数据、manifest、Release notes 和 Homebrew Tap Cask 已完成一致性对账${input.deepVerified ? '，并额外完成公开 DMG 回下载复核' : ''}。`,
    '',
  ].join('\n');
}

function requiredVersion(rawValue) {
  const version = rawValue?.trim() ?? '';
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('RELEASE_VERSION 为必填稳定版本号，例如 0.1.10。');
  return version;
}

function parseBoolean(name, rawValue, defaultValue) {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const normalized = rawValue.trim().toLocaleLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  throw new Error(`${name} 必须是布尔值；当前值为 ${rawValue}。`);
}

function optionalFile(rawValue, name) {
  const value = rawValue?.trim() ?? '';
  if (!value) return null;
  const path = resolve(repositoryRoot, value);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name} 不是可读文件：${path}`);
  if (statSync(path).size > 128 * 1024) throw new Error(`${name} 超过 128 KiB。`);
  return path;
}

function validateReleaseNotesFile(path, version) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`缺少仓库 Release notes：${path}`);
  const markdown = readFileSync(path, 'utf8');
  const requiredTitle = `# Zeus ${version} 更新内容`;
  if (!markdown.startsWith(`${requiredTitle}\n`)) throw new Error(`Release notes 标题必须是：${requiredTitle}`);
  for (const heading of ['## 如何升级', '## 系统要求与已知限制', '## 发布验证']) {
    if (!markdown.includes(`\n${heading}\n`)) throw new Error(`Release notes 缺少必要章节：${heading}`);
  }
  const leakedCommentary = markdown.match(/用户要求只返回|confidence\s*[=:：]|uncertainties\s*[=:：]|以下无其他字段|最终正文如上/iu)?.[0];
  if (leakedCommentary) throw new Error(`Release notes 混入生成过程说明“${leakedCommentary}”。`);
  const draftOnlyPublicationState = markdown.match(/本次发布前需完成以下验证流程|将由\s*(?:Release Workflow|发布流程)|发布流程将在草稿通过后执行|尚未发生/iu)?.[0];
  if (draftOnlyPublicationState) throw new Error(`Release notes 包含只在草稿阶段成立的表述“${draftOnlyPublicationState}”。`);
  if (/对\s*DMG\s*进行开发者签名和 Apple 公证/iu.test(markdown)) {
    throw new Error('Release notes 无条件承诺 Developer ID 签名与 Apple 公证。');
  }
}

function validateLocalGateSummary(path, version, headSha) {
  const content = readFileSync(path, 'utf8');
  const validTitle = content.includes(`# Zeus ${version} 快速发布前置摘要`) || content.includes(`# Zeus ${version} 发布门禁摘要`);
  if (!validTitle) throw new Error(`本地检查摘要与候选版本不一致，缺少 Zeus ${version} 标题。`);
  for (const expected of [`- 候选提交：${headSha}`]) {
    if (!content.includes(expected)) throw new Error(`本地检查摘要与候选版本不一致，缺少：${expected}`);
  }
}

function findSuccessfulCiRun(headSha) {
  const result = ghJson(['run', 'list', '--repo', repository, '--workflow', 'CI', '--branch', 'main', '--commit', headSha, '--limit', '20', '--json', 'databaseId,status,conclusion,event,headSha,url,createdAt,workflowName'], true);
  if (!result.ok || !Array.isArray(result.value)) return null;
  return result.value.find((run) => run.headSha === headSha && run.event === 'push' && run.status === 'completed' && run.conclusion === 'success') ?? null;
}

function readReleaseWorkflow() {
  const result = ghJson(['workflow', 'list', '--repo', repository, '--json', 'name,state,path,id'], true);
  if (!result.ok || !Array.isArray(result.value)) return { active: false, detail: result.error || '无法读取 Workflow' };
  const workflow = result.value.find((candidate) => candidate.name === 'Release' || candidate.path === '.github/workflows/release.yml');
  return { active: workflow?.state === 'active', detail: workflow ? `${workflow.name}/${workflow.state}` : '未找到 Release Workflow' };
}

function readActionSecretNames() {
  const result = capture('gh', ['secret', 'list', '--repo', repository, '--app', 'actions'], true);
  if (result.status !== 0) return new Set();
  return new Set(
    result.stdout
      .split(/\r?\n/u)
      .map((line) => line.split(/\s+/u)[0]?.trim())
      .filter(Boolean),
  );
}

function readRelease(tag) {
  const result = ghJson(['release', 'view', tag, '--repo', repository, '--json', 'tagName,name,isDraft,isPrerelease,url,body,assets'], true);
  if (result.ok) return { exists: true, data: result.value };
  if (/release not found|HTTP 404/iu.test(result.error)) return { exists: false, data: null };
  return { exists: false, data: null, error: result.error };
}

function findActiveReleaseRun(headSha) {
  const result = listReleaseRuns(headSha);
  if (!result.ok || !Array.isArray(result.value)) return null;
  return result.value.find((run) => run.headSha === headSha && (run.status === 'queued' || run.status === 'in_progress' || run.status === 'waiting' || run.status === 'requested')) ?? null;
}

function findLatestReleaseRun(headSha) {
  const result = listReleaseRuns(headSha);
  if (!result.ok || !Array.isArray(result.value)) return null;
  return result.value.find((run) => run.headSha === headSha) ?? null;
}

function listReleaseRuns(headSha) {
  return ghJson(['run', 'list', '--repo', repository, '--workflow', 'Release', '--event', 'workflow_dispatch', '--commit', headSha, '--limit', '20', '--json', 'databaseId,status,conclusion,event,headSha,url,createdAt,workflowName'], true);
}

function dispatchReleaseWorkflow(tag, commitSha, requireAppleDistribution) {
  run('gh', [
    'workflow',
    'run',
    'Release',
    '--repo',
    repository,
    '--ref',
    'main',
    '--field',
    `commit_sha=${commitSha}`,
    '--field',
    `tag=${tag}`,
    '--field',
    'publish_release=true',
    '--field',
    `require_apple_distribution=${requireAppleDistribution ? 'true' : 'false'}`,
  ]);
}

async function waitForDispatchedRun(headSha, dispatchedAt) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = listReleaseRuns(headSha);
    if (result.ok && Array.isArray(result.value)) {
      const run = result.value.find((candidate) => candidate.headSha === headSha && Date.parse(candidate.createdAt) >= dispatchedAt - 10_000);
      if (run) return run;
    }
    await delay(2_000);
  }
  return null;
}

async function waitForWorkflowRun(workflowRun) {
  let previousSnapshot = null;
  let consecutiveReadFailures = 0;
  while (true) {
    const result = ghJson(['run', 'view', String(workflowRun.databaseId), '--repo', repository, '--json', 'databaseId,status,conclusion,url,jobs'], true);
    if (!result.ok || !result.value || typeof result.value.status !== 'string') {
      consecutiveReadFailures += 1;
      const reason = result.error || 'GitHub CLI 返回了无效响应';
      if (consecutiveReadFailures >= 3) {
        throw new Error(`连续 3 次无法读取 Release Workflow 状态：${reason}`);
      }
      console.warn(`暂时无法读取 Release Workflow 状态，10 秒后重试（${consecutiveReadFailures}/3）：${reason}`);
      await delay(10_000);
      continue;
    }
    consecutiveReadFailures = 0;

    const snapshot = buildWorkflowProgressSnapshot(result.value);
    printWorkflowProgressChanges(snapshot, previousSnapshot);
    previousSnapshot = snapshot;

    if (snapshot.status === 'completed') {
      if (snapshot.conclusion !== 'success') {
        throw new Error(`Release Workflow 未成功完成：conclusion=${snapshot.conclusion || 'unknown'} ${result.value.url || workflowRun.url}`);
      }
      return { ...workflowRun, ...result.value };
    }
    await delay(10_000);
  }
}

function buildWorkflowProgressSnapshot(workflowRun) {
  return {
    status: workflowRun.status,
    conclusion: workflowRun.conclusion || null,
    jobs: Array.isArray(workflowRun.jobs)
      ? workflowRun.jobs.map((job) => {
          const steps = Array.isArray(job.steps) ? job.steps : [];
          const phase = steps.find((step) => step.status === 'in_progress') ?? steps.find((step) => ['queued', 'pending', 'waiting'].includes(step.status)) ?? steps.findLast((step) => step.status === 'completed') ?? null;
          return {
            name: job.name,
            status: job.status,
            conclusion: job.conclusion || null,
            phaseName: phase?.name ?? null,
            phaseStatus: phase?.status ?? null,
            phaseConclusion: phase?.conclusion || null,
          };
        })
      : [],
  };
}

function printWorkflowProgressChanges(snapshot, previousSnapshot) {
  if (!previousSnapshot || snapshot.status !== previousSnapshot.status || snapshot.conclusion !== previousSnapshot.conclusion) {
    console.log(`Release Workflow 状态：${snapshot.status}${snapshot.conclusion ? `/${snapshot.conclusion}` : ''}`);
  }

  const previousJobs = new Map((previousSnapshot?.jobs ?? []).map((job) => [job.name, job]));
  for (const job of snapshot.jobs) {
    const previousJob = previousJobs.get(job.name);
    if (previousJob && JSON.stringify(job) === JSON.stringify(previousJob)) continue;
    const phase = job.phaseName ? `，阶段=${job.phaseName} (${job.phaseStatus}${job.phaseConclusion ? `/${job.phaseConclusion}` : ''})` : '';
    console.log(`Release Workflow 作业：${job.name}=${job.status}${job.conclusion ? `/${job.conclusion}` : ''}${phase}`);
  }
}

function resolveLocalTagSha(tag) {
  const result = capture('git', ['rev-list', '-n', '1', tag], true);
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveRemoteTagSha(tag) {
  const result = capture('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`], true);
  if (result.status !== 0) return null;
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  return (peeled ?? lines[0])?.split(/\s+/u)[0] ?? null;
}

function resolveRemoteReference(reference) {
  const result = capture('git', ['ls-remote', 'origin', reference], true);
  return result.status === 0 ? result.stdout.trim().split(/\s+/u)[0] || null : null;
}

function isExpectedOrigin(url) {
  return url === `https://github.com/${repository}.git` || url === `https://github.com/${repository}` || url === `git@github.com:${repository}.git`;
}

function resolveOutputDirectory(version) {
  const commandRunDirectory = process.env.ZEUS_COMMAND_RUN_DIR?.trim();
  if (commandRunDirectory) return resolve(commandRunDirectory);
  return mkdtempSync(join(tmpdir(), `zeus-release-publish-${version}-`));
}

function git(args) {
  const result = capture('git', ['-c', 'core.quotePath=false', ...args]);
  return result.stdout.trim();
}

function gh(args) {
  const result = capture('gh', args);
  return result.stdout;
}

function ghJson(args, allowFailure = false) {
  const result = capture('gh', args, allowFailure);
  if (result.status !== 0) return { ok: false, error: [result.stdout, result.stderr].filter(Boolean).join('\n') };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `gh JSON 响应无效：${error instanceof Error ? error.message : String(error)}` };
  }
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

function capture(command, args, allowFailure = false) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败：${result.stderr.trim() || `退出码 ${result.status ?? 'unknown'}`}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function normalizeText(value) {
  return value.replace(/\r\n/gu, '\n').trim();
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
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
