#!/usr/bin/env node
import { releaseTag, versionFromReleaseTag, assertDistributionVersions } from './desktop-distribution.mjs';
/* global process, console */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { zeusDistribution as distribution } from './desktop-distribution.mjs';

// 普通 CI 可在贡献者 fork 中验证源码；只有发布入口检查远端仓库归属。
if ((process.argv.includes('--manifest') || process.argv.includes('--check-version')) && process.env.GITHUB_REPOSITORY && process.env.GITHUB_REPOSITORY !== distribution.repository)
  throw new Error('当前 Actions 仓库与发行配置不一致，拒绝发布。');
if (process.argv.includes('--github-output')) {
  if (!process.env.GITHUB_OUTPUT) throw new Error('缺少 GITHUB_OUTPUT。');
  appendFileSync(process.env.GITHUB_OUTPUT, `release_branch=${distribution.releaseBranch}\nhomebrew_enabled=${distribution.homebrewEnabled}\nhomebrew_repository=${distribution.homebrewRepository}\n`);
}
const distributionVersion = assertDistributionVersions();
if (process.argv.includes('--tag')) console.log(releaseTag(distributionVersion));
else console.log(JSON.stringify({ ...distribution, version: distributionVersion }, null, 2));

const manifestIndex = process.argv.indexOf('--manifest');
if (manifestIndex >= 0) {
  const manifest = JSON.parse(readFileSync(process.argv[manifestIndex + 1], 'utf8'));
  if (manifest.distributionId !== distribution.id || manifest.repository !== distribution.repository || manifest.channel !== distribution.channel) throw new Error('产物清单与发行配置不一致。');
  if (process.env.RELEASE_COMMIT && manifest.sourceCommit !== process.env.RELEASE_COMMIT) throw new Error('产物提交与发布候选不一致。');
  if (process.env.RELEASE_TAG && releaseTag(manifest.version) !== process.env.RELEASE_TAG) throw new Error('产物版本与发布标签不一致。');
  if (!manifest.artifacts?.length) throw new Error('产物清单为空。');
  for (const artifact of manifest.artifacts) {
    if (!artifact.downloadUrl.startsWith(`https://github.com/${distribution.repository}/releases/download/${releaseTag(manifest.version)}/`)) throw new Error('产物下载来源不属于本次发行版。');
  }
}

if (process.argv.includes('--check-version')) {
  // 读取待发布版本，保持稳定渠道的三段版本约束。
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('稳定渠道只接受三段递增版本号。');
  // 保留全部分页，只输出公开稳定版标签，避免发布正文和附件详情撑满子进程缓冲区。
  const tags = execFileSync('gh', ['api', `repos/${distribution.repository}/releases?per_page=100`, '--paginate', '--jq', '.[] | select(.draft == false and .prerelease == false) | .tag_name'], { encoding: 'utf8' })
    .trim()
    .split('\n');
  // 逐个检查历史标签，不依赖发布时间或 API 返回顺序。
  for (const tag of tags) {
    if (tag === releaseTag(version) || !versionFromReleaseTag(tag)) continue;
    // 将当前版本拆成可逐段比较的数字。
    const current = version.split('.').map(Number);
    // 将本发行版的历史稳定版本拆成数字。
    const published = versionFromReleaseTag(tag).split('.').map(Number);
    // 首个不同版本段决定高低；相同目标标签已在上方排除。
    const difference = current.map((part, index) => part - published[index]).find((part) => part !== 0) ?? 0;
    if (difference <= 0) throw new Error(`目标版本必须高于本发行版已发布版本：${tag}`);
  }
}
