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
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('稳定渠道只接受三段递增版本号。');
  const pages = JSON.parse(execFileSync('gh', ['api', `repos/${distribution.repository}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' }));
  for (const release of pages.flat()) {
    if (release.draft || release.prerelease || release.tag_name === releaseTag(version) || !versionFromReleaseTag(release.tag_name)) continue;
    const current = version.split('.').map(Number);
    const published = versionFromReleaseTag(release.tag_name).split('.').map(Number);
    const difference = current.map((part, index) => part - published[index]).find((part) => part !== 0) ?? 0;
    if (difference <= 0) throw new Error(`目标版本必须高于本发行版已发布版本：${release.tag_name}`);
  }
}
