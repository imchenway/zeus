#!/usr/bin/env node
/* global console, process */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { commandFailureDetail, commandResultSucceeded, isTransientRemoteReadFailure, releaseRemoteReadAttempts, releaseRemoteReadTimeoutMs, runRemoteReadWithRetrySync } from './release-remote-read.mjs';
import { parseBoolean, requiredVersion, sha256File, sha256Text, validateReleaseNotes, validateReleaseNotesFile } from './release-script-utils.mjs';
import {
  formatReleaseWorkflowDuration,
  observeReleaseWorkflowExecution,
  readReleaseWorkflowWaitState,
  ReleasePublicationUnconfirmedError,
  releasePublicationUnconfirmedExitCode,
  releaseWorkflowHeartbeatIntervalMs,
  releaseWorkflowPollIntervalMs,
  resolveReleaseWorkflowWaitWindow,
} from './release-workflow-wait-policy.mjs';

/** 从当前脚本位置固定源码和本地证据的根目录。 */
const repositoryRoot = resolve(import.meta.dirname, '..');
/** 正式发布只写入 Zeus 官方仓库。 */
const repository = 'imchenway/zeus';
/** 正式发布同步的官方 Homebrew 仓库。 */
const homebrewRepository = 'imchenway/homebrew-tap';

// 直接运行才进入发布编排；导入回验函数不会触发远端写入。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ReleasePublicationUnconfirmedError ? releasePublicationUnconfirmedExitCode : 1;
  });
}

/** 编排受控发布或指定候选的只读回验，成功时保存相同格式的凭证。 */
async function main() {
  const releaseVersion = requiredVersion(process.env.RELEASE_VERSION);
  const applyRemote = parseBoolean('APPLY_REMOTE', process.env.APPLY_REMOTE, false);
  /** 只读回验指定版本，不准备候选、不触发 Workflow。 */
  const verifyPublishedOnly = parseBoolean('VERIFY_PUBLISHED_ONLY', process.env.VERIFY_PUBLISHED_ONLY, false);
  const requireAppleDistribution = parseBoolean('REQUIRE_APPLE_DISTRIBUTION', process.env.REQUIRE_APPLE_DISTRIBUTION, false);
  const waitForCompletion = parseBoolean('WAIT_FOR_COMPLETION', process.env.WAIT_FOR_COMPLETION, true);
  const deepVerifyPublicDmg = parseBoolean('DEEP_VERIFY_PUBLIC_DMG', process.env.DEEP_VERIFY_PUBLIC_DMG, false);
  const confirmation = process.env.PUBLISH_CONFIRMATION?.trim() ?? '';
  const tag = `v${releaseVersion}`;
  const outputDirectory = resolveOutputDirectory(releaseVersion);
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

  /** 普通发布与只读回验使用同一套公开资产校验。 */
  const verificationInput = { releaseVersion, tag, outputDirectory, requireAppleDistribution, deepVerifyPublicDmg };
  if (verifyPublishedOnly) {
    if (applyRemote) throw new Error('只读发布回验不能同时启用 APPLY_REMOTE。');
    /** 候选身份必须显式指定，禁止按当前工作树或最新版本猜测。 */
    const headSha = process.env.RELEASE_COMMIT?.trim() ?? '';
    if (!/^[a-f0-9]{40}$/u.test(headSha)) throw new Error('只读发布回验要求 RELEASE_COMMIT 为完整候选提交。');
    /** 说明正文从固定候选读取，允许在后续工作树回验既有版本。 */
    const releaseNotes = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${repository}/contents/releases/${tag}.md?ref=${headSha}`]);
    validateReleaseNotes(releaseNotes, releaseVersion);
    /** 所有必要公开证据通过后才生成回验凭证。 */
    const verification = await readVerifiedPublishedRelease({ ...verificationInput, headSha, releaseNotes });
    if (!verification) throw new Error(`目标版本尚未公开：${tag}；本次只读回验未触发发布。`);
    writePublishResult(verification, outputDirectory);
    return;
  }

  const localGateSummaryPath = optionalFile(process.env.LOCAL_GATE_SUMMARY_FILE, 'LOCAL_GATE_SUMMARY_FILE');

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

  // 先复用前置检查的公开事实，已完成交付不再依赖 Workflow 列表读取。
  const release = preflight.release;
  /** 发布目标一旦完整交付，不因滞后的 Workflow 状态重新触发写入。 */
  const candidateVerificationInput = { ...verificationInput, headSha: preflight.headSha };
  if (release.exists) {
    /** 交付证据与本地凭证写入分别处理，写入失败不能触发新的远端发布。 */
    let existingVerification = null;
    try {
      existingVerification = await verifyPublishedRelease({ ...candidateVerificationInput, release });
    } catch (error) {
      console.warn(`既有版本尚未完成全部公开回验，继续原有发布恢复流程：${error instanceof Error ? error.message : String(error)}`);
    }
    if (existingVerification) {
      writePublishResult(existingVerification, outputDirectory);
      return;
    }
  }
  /** 同一快照决定活跃运行与最近运行，避免重复读取产生矛盾结果。 */
  const workflowRuns = listReleaseRuns(preflight.headSha).value;
  /** 尚未交付时优先续等同一候选的活跃运行。 */
  let workflowRun = workflowRuns.find((run) => run.headSha === preflight.headSha && ['queued', 'in_progress', 'waiting', 'requested'].includes(run.status)) ?? null;
  /** 最近运行仅参与已有失败 Workflow 的恢复判断。 */
  const latestWorkflowRun = workflowRuns.find((run) => run.headSha === preflight.headSha) ?? null;
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

  /** Workflow 状态只提供进度，成功收尾必须来自完整公开资产回验。 */
  let verification = workflowRun ? await waitForPublishedRelease(workflowRun, candidateVerificationInput) : await verifyPublishedRelease({ ...candidateVerificationInput, release });
  if (deepVerifyPublicDmg && !verification.deepVerified) {
    // 完整 DMG 回下载是等待结束后的独立验收，保留原有十五分钟下载预算。
    verification = await readVerifiedPublishedRelease({ ...candidateVerificationInput, workflowRun });
    if (!verification) throw new Error(`完整 DMG 回验前无法读取目标公开版本：${tag}`);
  }
  writePublishResult(verification, outputDirectory);
}

/** 保存独立回验凭证，不改写命令历史的退出码或状态。 */
function writePublishResult(verification, outputDirectory) {
  /** 普通发布与只读回验共用同一份交付凭证格式。 */
  const resultPath = join(outputDirectory, `Zeus-${verification.releaseVersion}-publish-result.md`);
  writeFileSync(resultPath, buildPublishResult(verification), { mode: 0o600 });
  console.log(`公开发布与${verification.deepVerified ? '完整 DMG' : '轻量资产'}对账通过：${resultPath}`);
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
  const ghAuth = captureRemoteRead('检查 GitHub CLI 登录状态', 'gh', ['auth', 'status', '--hostname', 'github.com'], { allowFailure: true });
  const release = readRelease(input.tag);
  const ciRun = findSuccessfulCiRun(headSha);
  const workflow = readReleaseWorkflow();
  const secretsRead = readActionSecretNames();
  const secretNames = secretsRead.names;
  const releaseNotesPath = join(repositoryRoot, 'releases', `${input.tag}.md`);
  let packageVersion = null;
  let desktopVersion = null;

  if (branch !== 'main') blockers.push(`当前分支必须是 main，实际为 ${branch}`);
  if (worktreeStatus) blockers.push('工作区必须干净');
  if (!isExpectedOrigin(originUrl)) blockers.push(`origin 不是 ${repository}：${originUrl}`);
  if (!remoteMainSha) blockers.push('无法读取 origin/main 远程提交');
  else if (remoteMainSha !== headSha) blockers.push(`本地 HEAD 与 origin/main 不一致：local=${headSha} remote=${remoteMainSha}`);
  if (ghAuth.status !== 0) blockers.push(`GitHub CLI 未完成可用登录：${commandFailureDetail(ghAuth)}`);

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
  if (secretsRead.error) {
    blockers.push(`无法读取 GitHub Actions Secrets：${secretsRead.error}`);
  } else {
    if (!secretNames.has('HOMEBREW_TAP_TOKEN')) blockers.push('GitHub Actions 缺少 HOMEBREW_TAP_TOKEN');
    if (input.requireAppleDistribution) {
      for (const name of ['MACOS_CERTIFICATE', 'MACOS_CERTIFICATE_PASSWORD']) {
        if (!secretNames.has(name)) blockers.push(`严格 Apple 分发缺少 ${name}`);
      }
      const hasAppleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'].every((name) => secretNames.has(name));
      const hasApiKey = ['APPLE_API_KEY_P8', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every((name) => secretNames.has(name));
      if (!hasAppleId && !hasApiKey) blockers.push('严格 Apple 分发缺少一组完整公证凭据');
    }
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
    '2. 以精确候选 SHA 触发 Release Workflow；Workflow 并行执行 verify:publish 与正式打包。',
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

/** 完整核对公开交付证据，缺少或不一致的证据不能被当作成功。 */
export async function verifyPublishedRelease(input) {
  if (input.release.data.tagName !== input.tag || input.release.data.isDraft || input.release.data.isPrerelease) {
    throw new Error(`GitHub Release 状态不符合稳定版要求：tag=${input.release.data.tagName ?? 'missing'} draft=${input.release.data.isDraft} prerelease=${input.release.data.isPrerelease}`);
  }
  // 公开标签与清单必须同时绑定候选，不能只相信 Release 页面或当前工作树。
  if (resolveRemoteTagSha(input.tag, publicVerificationReadOptions(input)) !== input.headSha) {
    throw new Error('公开标签未指向本次候选提交。');
  }
  const releaseNotesPath = join(repositoryRoot, 'releases', `${input.tag}.md`);
  /** 只读模式使用固定候选的说明，普通发布使用本次干净候选的说明。 */
  const releaseNotes = input.releaseNotes ?? readFileSync(releaseNotesPath, 'utf8');
  const expectedNotes = normalizeText(releaseNotes);
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
    downloadReleaseAsset(input.tag, 'zeus-release-manifest.json', downloadDirectory, publicVerificationReadOptions(input));
    const manifestPath = join(downloadDirectory, 'zeus-release-manifest.json');
    const manifestSha256 = await sha256File(manifestPath);
    const manifestSize = statSync(manifestPath).size;
    if (manifestAsset.size !== manifestSize || manifestAsset.digest !== `sha256:${manifestSha256}`) {
      throw new Error('GitHub manifest 资产元数据与下载文件不一致。');
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (manifest.repository !== repository || manifest.sourceCommit !== input.headSha) throw new Error('公开清单不是 Zeus 官方来源或本次候选提交。');
    const manifestArtifact = manifest.artifacts?.find((artifact) => artifact.arch === 'arm64' && artifact.kind === 'dmg' && artifact.fileName === expectedDmgName);
    if (manifest.version !== input.releaseVersion || manifest.channel !== 'stable' || !manifestArtifact) {
      throw new Error('公开 manifest 的版本、通道或 DMG 记录不一致。');
    }
    if (input.requireAppleDistribution && (!manifest.signed || !manifest.notarized)) {
      throw new Error('本次强制 Apple 正式分发，但公开 manifest 未同时记录 Developer ID 签名和 Apple 公证。');
    }
    const dmgSha256 = dmgAsset.digest.slice('sha256:'.length);
    const dmgSize = dmgAsset.size;
    if (manifestArtifact.sha256 !== dmgSha256 || manifestArtifact.sizeBytes !== dmgSize) {
      throw new Error('公开 manifest 与 GitHub DMG 服务端摘要或字节数不一致。');
    }

    if (input.deepVerifyPublicDmg) {
      downloadReleaseAsset(input.tag, expectedDmgName, downloadDirectory, { timeout: 15 * 60_000 });
      const dmgPath = join(downloadDirectory, expectedDmgName);
      run('/usr/bin/hdiutil', ['verify', dmgPath]);
      const downloadedDmgSha256 = await sha256File(dmgPath);
      const downloadedDmgSize = statSync(dmgPath).size;
      if (downloadedDmgSha256 !== dmgSha256 || downloadedDmgSize !== dmgSize) {
        throw new Error('回下载 DMG 与 GitHub 服务端资产元数据不一致。');
      }
    }

    const cask = gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `repos/${homebrewRepository}/contents/Casks/zeus.rb?ref=main`], publicVerificationReadOptions(input));
    for (const expected of [`version "${input.releaseVersion}"`, `sha256 "${dmgSha256}"`, 'depends_on arch: :arm64']) {
      if (!cask.includes(expected)) throw new Error(`Homebrew Tap Cask 与公开 DMG 不一致，缺少：${expected}`);
    }

    const releaseNotesSnapshotPath = join(input.outputDirectory, `${input.tag}-release-notes.md`);
    const manifestSnapshotPath = join(input.outputDirectory, `${input.tag}-release-manifest.json`);
    const caskSnapshotPath = join(input.outputDirectory, `${input.tag}-homebrew-cask.rb`);
    writeFileSync(releaseNotesSnapshotPath, releaseNotes, { mode: 0o600 });
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
      releaseNotesSha256: sha256Text(releaseNotes),
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

function optionalFile(rawValue, name) {
  const value = rawValue?.trim() ?? '';
  if (!value) return null;
  const path = resolve(repositoryRoot, value);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${name} 不是可读文件：${path}`);
  if (statSync(path).size > 128 * 1024) throw new Error(`${name} 超过 128 KiB。`);
  return path;
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
  const result = captureRemoteRead('读取 GitHub Actions Secrets', 'gh', ['secret', 'list', '--repo', repository, '--app', 'actions'], { allowFailure: true });
  if (result.status !== 0) return { names: new Set(), error: commandFailureDetail(result) };
  return {
    names: new Set(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => line.split(/\s+/u)[0]?.trim())
        .filter(Boolean),
    ),
    error: null,
  };
}

/** 在调用方预算内读取正式公开版本，区分不存在和读取失败。 */
function readRelease(tag, options = {}) {
  const result = ghJson(['release', 'view', tag, '--repo', repository, '--json', 'tagName,name,isDraft,isPrerelease,url,body,assets'], true, options);
  if (result.ok) return { exists: true, data: result.value };
  if (/release not found|HTTP 404/iu.test(result.error)) return { exists: false, data: null };
  return { exists: false, data: null, error: result.error };
}

/** 一次读取候选运行列表，读取失败时禁止猜测并重复触发发布。 */
function listReleaseRuns(headSha) {
  const result = ghJson(
    ['run', 'list', '--repo', repository, '--workflow', 'Release', '--event', 'workflow_dispatch', '--commit', headSha, '--limit', '20', '--json', 'databaseId,status,conclusion,event,headSha,url,createdAt,workflowName'],
    true,
  );
  if (!result.ok || !Array.isArray(result.value)) throw new Error(`无法确认候选提交是否已有 Release Workflow：${result.error || 'GitHub 返回了无效运行列表'}`);
  return result;
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

/** 在剩余预算内读取公开事实；轮询只尝试一次，下一轮负责继续恢复。 */
function publicVerificationReadOptions(input) {
  if (!input.waitWindow) return {};
  /** 每次联网前重新读取预算，避免多条串行请求分别消耗完整超时时间。 */
  const waitState = readReleaseWorkflowWaitState(input.waitWindow);
  if (waitState.timedOut) throw new Error('本轮本地等待预算已用尽，公开发布结果仍须回验。');
  return { attempts: 1, timeout: Math.min(releaseRemoteReadTimeoutMs, waitState.remainingMs) };
}

/** 只有正式公开且全部交付证据一致时才返回凭证；不存在的版本继续等待。 */
async function readVerifiedPublishedRelease(input) {
  /** 存在 Release 只是前置条件，不能代替安装包和 Homebrew 回验。 */
  const release = readRelease(input.tag, publicVerificationReadOptions(input));
  if (release.error) throw new Error(`无法读取目标公开版本：${release.error}`);
  if (!release.exists) return null;
  return verifyPublishedRelease({ ...input, release });
}

/** 用完整轻量交付证据结束等待，不把滞后的 Workflow 状态当成最终发布结果。 */
export async function waitForPublishedRelease(workflowRun, input) {
  /** 本次进入等待时建立预算，远端运行年龄不参与本地超时计算。 */
  const waitWindow = resolveReleaseWorkflowWaitWindow(performance.now(), workflowRun);
  /** 等待只回验轻量证据；显式完整 DMG 回下载在等待结束后单独执行。 */
  const verificationInput = { ...input, workflowRun, waitWindow, deepVerifyPublicDmg: false };
  let previousSnapshot = null;
  /** 连续故障次数只用于进度说明，瞬时故障不会另设提前退出次数。 */
  let consecutiveReadFailures = 0;
  /** 最近的缺失证据只作为未确认原因，不把未确认改成远端发布失败。 */
  let lastVerificationFailure = '';
  /** 进入等待就回验一次，随后按既有心跳间隔检查实际交付。 */
  let nextVerificationAtMs = waitWindow.startedAtMs;
  /** 进度心跳与等待预算使用同一个单调时钟。 */
  let nextHeartbeatAtMs = performance.now() + releaseWorkflowHeartbeatIntervalMs;
  while (true) {
    /** 回验本身也消耗预算，完成后必须重新计算下一条请求的剩余时间。 */
    let beforeRead = readReleaseWorkflowWaitState(waitWindow);
    if (!beforeRead.timedOut && (performance.now() >= nextVerificationAtMs || beforeRead.remainingMs <= releaseRemoteReadTimeoutMs)) {
      try {
        /** 公开版本、候选、资产和 Cask 全部一致才允许正常结束本地命令。 */
        const verification = await readVerifiedPublishedRelease(verificationInput);
        if (verification) return verification;
      } catch (error) {
        lastVerificationFailure = error instanceof Error ? error.message : String(error);
      }
      nextVerificationAtMs = performance.now() + releaseWorkflowHeartbeatIntervalMs;
      beforeRead = readReleaseWorkflowWaitState(waitWindow);
    }
    if (beforeRead.timedOut) throw releaseWorkflowWaitTimeoutError(workflowRun, previousSnapshot, beforeRead, lastVerificationFailure);

    const result = ghJson(['run', 'view', String(workflowRun.databaseId), '--repo', repository, '--json', 'databaseId,status,conclusion,url,jobs'], true, {
      attempts: 1,
      timeout: Math.max(1, Math.min(releaseRemoteReadTimeoutMs, beforeRead.remainingMs)),
    });
    if (!result.ok || !result.value || typeof result.value.status !== 'string') {
      consecutiveReadFailures += 1;
      const reason = result.error || 'GitHub CLI 返回了无效响应';
      // 网络故障由同一等待预算约束，不能在三次瞬时失败后提前放弃已派发的发布。
      // 确定的权限、命令或响应错误仍先回验实际交付，再结束本地等待。
      if (!result.transient) {
        try {
          /** 状态读取确定不可继续时，完整公开证据仍能证明真实发布结果。 */
          const verification = await readVerifiedPublishedRelease(verificationInput);
          if (verification) return verification;
        } catch (error) {
          lastVerificationFailure = error instanceof Error ? error.message : String(error);
        }
        throw new ReleasePublicationUnconfirmedError(`无法继续读取 Release Workflow 状态，公开发布结果仍未确认：${reason}${lastVerificationFailure ? `\n最近公开回验：${lastVerificationFailure}` : ''}`);
      }
      const waitState = readReleaseWorkflowWaitState(waitWindow);
      if (waitState.timedOut) throw releaseWorkflowWaitTimeoutError(workflowRun, previousSnapshot, waitState, lastVerificationFailure);
      console.warn(`暂时无法读取 Release Workflow 状态，仍在本轮等待时限内继续查询（连续 ${consecutiveReadFailures} 次）：${reason}`);
      printWorkflowWaitHeartbeatIfDue(workflowRun, previousSnapshot, waitState, nextHeartbeatAtMs);
      if (performance.now() >= nextHeartbeatAtMs) nextHeartbeatAtMs = performance.now() + releaseWorkflowHeartbeatIntervalMs;
      await delay(Math.min(releaseWorkflowPollIntervalMs, waitState.remainingMs));
      continue;
    }
    consecutiveReadFailures = 0;

    const snapshot = buildWorkflowProgressSnapshot(result.value);
    observeReleaseWorkflowExecution(waitWindow, snapshot);
    /** 终态变化时立即回验，后续成功终态仍按一分钟间隔等待公开证据。 */
    const completedStateChanged = snapshot.status === 'completed' && (previousSnapshot?.status !== 'completed' || previousSnapshot.conclusion !== snapshot.conclusion);
    printWorkflowProgressChanges(snapshot, previousSnapshot);
    previousSnapshot = snapshot;

    if (snapshot.status === 'completed' && completedStateChanged) {
      /** 状态服务报告结束也必须核对实际交付，失败状态不能抹掉既有完整交付。 */
      try {
        /** 成功终态下的短暂读取失败仍保留本轮等待预算，不立即误报发布失败。 */
        const verification = await readVerifiedPublishedRelease({ ...verificationInput, workflowRun: { ...workflowRun, ...result.value } });
        if (verification) return verification;
        lastVerificationFailure = `目标版本尚未公开：${input.tag}`;
      } catch (error) {
        lastVerificationFailure = error instanceof Error ? error.message : String(error);
      }
      nextVerificationAtMs = performance.now() + releaseWorkflowHeartbeatIntervalMs;
      if (snapshot.conclusion !== 'success') {
        throw new Error(`Release Workflow 未成功完成：conclusion=${snapshot.conclusion || 'unknown'} ${result.value.url || workflowRun.url}\n公开回验：${lastVerificationFailure}`);
      }
    }

    const waitState = readReleaseWorkflowWaitState(waitWindow);
    if (waitState.timedOut) throw releaseWorkflowWaitTimeoutError(workflowRun, snapshot, waitState, lastVerificationFailure);
    printWorkflowWaitHeartbeatIfDue(workflowRun, snapshot, waitState, nextHeartbeatAtMs);
    if (performance.now() >= nextHeartbeatAtMs) nextHeartbeatAtMs = performance.now() + releaseWorkflowHeartbeatIntervalMs;
    await delay(Math.min(releaseWorkflowPollIntervalMs, waitState.remainingMs));
  }
}

/** 达到单调时钟约定的间隔后输出实际等待时长。 */
function printWorkflowWaitHeartbeatIfDue(workflowRun, snapshot, waitState, nextHeartbeatAtMs) {
  if (performance.now() < nextHeartbeatAtMs) return;
  const status = snapshot?.status ?? workflowRun.status ?? 'unknown';
  console.log(`Release Workflow 仍在等待：${status}，已等待 ${formatReleaseWorkflowDuration(waitState.elapsedMs)} / 上限 ${formatReleaseWorkflowDuration(waitState.limitMs)}；${workflowRun.url}`);
}

/** 本地等待结束只代表结果未确认，保留远端运行和具体缺失证据。 */
function releaseWorkflowWaitTimeoutError(workflowRun, snapshot, waitState, verificationFailure = '') {
  const status = snapshot?.status ?? workflowRun.status ?? 'unknown';
  return new ReleasePublicationUnconfirmedError(
    [
      `等待已达到 ${formatReleaseWorkflowDuration(waitState.limitMs)} 上限，本地等待结束，公开发布结果仍未确认：status=${status}，elapsed=${formatReleaseWorkflowDuration(waitState.elapsedMs)} ${workflowRun.url}`,
      ...(verificationFailure ? [`最近公开回验：${verificationFailure}`] : []),
      '远程 Workflow 未被自动取消；可查看该次运行，或重新执行发布命令继续识别并回验同一候选。',
    ].join('\n'),
  );
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

/** 从官方仓库读取真实标签提交，兼顾轻量标签和附注标签。 */
function resolveRemoteTagSha(tag, options = {}) {
  /** 固定官方来源，使只读回验不受执行目录的 origin 配置影响。 */
  const result = captureRemoteRead(`读取远程标签 ${tag}`, 'git', ['ls-remote', '--tags', `https://github.com/${repository}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], options);
  /** 同一次响应优先选择附注标签解析后的提交。 */
  const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  /** 轻量标签没有解析行，此时使用直接引用。 */
  const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
  return (peeled ?? lines[0])?.split(/\s+/u)[0] ?? null;
}

function resolveRemoteReference(reference) {
  const result = captureRemoteRead(`读取远程引用 ${reference}`, 'git', ['ls-remote', 'origin', reference]);
  return result.stdout.trim().split(/\s+/u)[0] || null;
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

/** 复用既有只读重试入口，并接受等待阶段的剩余预算。 */
function gh(args, options = {}) {
  const result = captureRemoteRead('读取 GitHub 公开事实', 'gh', args, options);
  return result.stdout;
}

/** 保留远程读取的真实故障类型，等待循环只对瞬时故障继续查询。 */
function ghJson(args, allowFailure = false, options = {}) {
  const result = captureRemoteRead('读取 GitHub 公开事实', 'gh', args, { ...options, allowFailure });
  if (!commandResultSucceeded(result)) return { ok: false, error: [result.stdout, result.stderr].filter(Boolean).join('\n') || commandFailureDetail(result), transient: isTransientRemoteReadFailure(result) };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `gh JSON 响应无效：${error instanceof Error ? error.message : String(error)}`, transient: false };
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

/** 下载指定公开资产，轮询与独立回验分别使用调用方的预算和重试次数。 */
function downloadReleaseAsset(tag, assetName, destinationDirectory, options = {}) {
  /** 轮询内只使用本轮剩余预算，独立回验保留既有重试规则。 */
  const timeout = options.timeout ?? releaseRemoteReadTimeoutMs;
  const destination = join(destinationDirectory, assetName);
  const args = ['release', 'download', tag, '--repo', repository, '--pattern', assetName, '--dir', destinationDirectory];
  const outcome = runRemoteReadWithRetrySync({
    attempts: options.attempts,
    execute: () => {
      rmSync(destination, { force: true });
      return spawnSync('gh', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      });
    },
    onRetry: (retry) => {
      console.warn(`公开资产下载暂时失败：${assetName}；${retry.delayMs / 1_000} 秒后重试（第 ${retry.nextAttempt}/${retry.attempts} 次）：${retry.detail}`);
    },
  });
  if (!commandResultSucceeded(outcome.result)) {
    throw new Error(`下载 GitHub Release 资产 ${assetName} 失败：${commandFailureDetail(outcome.result)}`);
  }
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

function captureRemoteRead(label, command, args, options = {}) {
  const timeout = options.timeout ?? releaseRemoteReadTimeoutMs;
  const attempts = options.attempts ?? releaseRemoteReadAttempts;
  const outcome = runRemoteReadWithRetrySync({
    attempts,
    execute: () =>
      spawnSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
      }),
    onRetry: (retry) => {
      console.warn(`远程只读操作暂时失败：${label}；${retry.delayMs / 1_000} 秒后重试（第 ${retry.nextAttempt}/${retry.attempts} 次）：${retry.detail}`);
    },
  });
  const result = {
    status: outcome.result.status,
    stdout: outcome.result.stdout ?? '',
    stderr: outcome.result.stderr ?? '',
    error: outcome.result.error ?? null,
  };
  if (!options.allowFailure && !commandResultSucceeded(result)) {
    throw new Error(`${label}失败：${commandFailureDetail(result)}`);
  }
  return result;
}

function normalizeText(value) {
  return value.replace(/\r\n/gu, '\n').trim();
}
