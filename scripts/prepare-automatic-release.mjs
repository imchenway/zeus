#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zeusDistribution as distribution, releasePackagePaths, releaseTag, versionFromReleaseTag } from './desktop-distribution.mjs';
import { parseBoolean, requiredVersion, validateReleaseNotes } from './release-script-utils.mjs';

const repositoryRoot = resolve(import.meta.dirname, '..');
const sourceTrailer = 'Zeus-Release-Source:';

function compareVersions(left, right) {
  const a = requiredVersion(left).split('.').map(Number);
  const b = requiredVersion(right).split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** 沿用 v 标签的版本序列；失败候选占用的版本也不能被新提交覆盖。 */
export function selectAutomaticVersion(currentVersion, tags, notesExist) {
  let version = requiredVersion(currentVersion);
  const versions = tags.map(versionFromReleaseTag).filter(Boolean).sort(compareVersions);
  const highest = versions.at(-1);
  if (highest && compareVersions(version, highest) <= 0) {
    const parts = highest.split('.').map(Number);
    version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  while (notesExist(releaseTag(version))) {
    const parts = version.split('.').map(Number);
    version = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }
  return version;
}

export function automaticReleaseNotes(version, sourceSha, previousTag) {
  const base = `https://github.com/${distribution.repository}`;
  const changes = previousTag ? `${base}/compare/${previousTag}...${sourceSha}` : `${base}/commit/${sourceSha}`;
  return [
    `# Zeus ${version} 更新内容`,
    '',
    '## 本次更新',
    '',
    `本版本汇总 main 中通过检查的改动。[查看完整变更](${changes})。`,
    '',
    '## 如何升级',
    '',
    `从 [Zeus 发布页](${base}/releases/tag/${releaseTag(version)}) 下载 Zeus-${version}-arm64.dmg，退出 Zeus 后安装。`,
    ...(distribution.homebrewEnabled ? [`Homebrew：\`brew upgrade --cask ${distribution.homebrewTap}/zeus\`。`] : []),
    '',
    '## 系统要求与已知限制',
    '',
    '面向 Apple Silicon Mac，要求 macOS 13 或更高版本。签名、公证及自动安装能力以本次更新清单和应用检查结果为准。',
    '',
    '## 发布验证',
    '',
    '公开发布以源码检查、候选检查和安装包校验成功为前提；具体执行结果见同一提交对应的 GitHub Actions 记录。',
    '',
  ].join('\n');
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function packageVersion(root) {
  const versions = releasePackagePaths.map((path) => JSON.parse(readFileSync(resolve(root, path), 'utf8')).version);
  if (versions.some((version) => version !== versions[0])) throw new Error('自动发布要求根包与桌面包的版本一致。');
  return requiredVersion(versions[0]);
}

function remoteTags(root) {
  const refs = git(root, 'ls-remote', '--tags', 'origin').split('\n').filter(Boolean);
  const tags = new Map();
  for (const ref of refs) {
    const [sha, name] = ref.split(/\s+/u);
    const tag = name.replace(/^refs\/tags\//u, '').replace(/\^\{\}$/u, '');
    if (!versionFromReleaseTag(tag)) continue;
    if (!tags.has(tag) || name.endsWith('^{}')) tags.set(tag, sha);
  }
  return tags;
}

/** 必须同时匹配单父提交、固定尾注和版本文件范围，不能只凭提交标题跳过 CI。 */
function readAutomaticCandidate(root, commit) {
  const message = git(root, 'show', '-s', '--format=%B', commit);
  const source = message.match(/^Zeus-Release-Source: ([a-f0-9]{40})$/mu)?.[1];
  if (!source || git(root, 'show', '-s', '--format=%P', commit) !== source) return null;
  const version = packageVersion(root);
  const tag = releaseTag(version);
  const notesPath = `releases/${tag}.md`;
  const paths = git(root, 'diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n');
  const allowed = new Set([...releasePackagePaths, notesPath]);
  if (!paths.includes(notesPath) || paths.some((path) => !allowed.has(path))) return null;
  validateReleaseNotes(readFileSync(resolve(root, notesPath), 'utf8'), version);
  return { commit_sha: commit, tag, source };
}

/** 只在 CI 的临时检出中准备候选；正常推送失败即停止，不合并、不强推。 */
export function prepareAutomaticCandidate({ root, sourceSha, releases }) {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('自动发布缺少有效的 CI 提交。');
  if (git(root, 'status', '--porcelain')) throw new Error('自动发布要求干净工作区。');
  git(root, 'fetch', '--no-tags', 'origin', `refs/heads/${distribution.releaseBranch}`);
  const remoteHead = git(root, 'rev-parse', 'FETCH_HEAD');
  git(root, 'checkout', '--detach', remoteHead);
  const candidate = readAutomaticCandidate(root, remoteHead);
  if (remoteHead !== sourceSha && candidate?.source !== sourceSha) return { ready: false, reason: 'main 已更新，跳过过时的 CI 结果。' };
  const tags = remoteTags(root);
  if (candidate) {
    if (tags.has(candidate.tag) && tags.get(candidate.tag) !== candidate.commit_sha) throw new Error('已有发行标签指向其他提交，拒绝覆盖。');
    if (releases.some((release) => release.tag_name === candidate.tag && !release.draft && !release.prerelease)) {
      if (tags.get(candidate.tag) !== candidate.commit_sha) throw new Error('已发布版本与候选提交不一致。');
      return { ready: false, reason: `${candidate.tag} 已发布，不重复递增版本。` };
    }
    return { ready: true, publish: true, ...candidate };
  }
  const reservedTags = [...tags.keys(), ...releases.map((release) => release.tag_name)];
  const version = selectAutomaticVersion(packageVersion(root), reservedTags, (tag) => existsSync(resolve(root, 'releases', `${tag}.md`)));
  const tag = releaseTag(version);
  const published = releases.filter((release) => !release.draft && !release.prerelease && versionFromReleaseTag(release.tag_name));
  published.sort((left, right) => compareVersions(versionFromReleaseTag(right.tag_name), versionFromReleaseTag(left.tag_name)));
  const notes = automaticReleaseNotes(version, sourceSha, published[0]?.tag_name);
  validateReleaseNotes(notes, version);
  for (const path of releasePackagePaths) {
    const absolute = resolve(root, path);
    writeFileSync(absolute, JSON.stringify({ ...JSON.parse(readFileSync(absolute, 'utf8')), version }, null, 2) + '\n');
  }
  mkdirSync(resolve(root, 'releases'), { recursive: true });
  const notesPath = `releases/${tag}.md`;
  writeFileSync(resolve(root, notesPath), notes, { flag: 'wx' });
  git(root, 'config', 'user.name', 'Zeus Release Bot');
  git(root, 'config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  git(root, 'add', '--', ...releasePackagePaths, notesPath);
  git(root, 'diff', '--cached', '--check');
  git(root, 'commit', '-m', `chore(release): ${tag}`, '-m', `${sourceTrailer} ${sourceSha}`);
  const commit = git(root, 'rev-parse', 'HEAD');
  try {
    git(root, 'push', 'origin', `HEAD:refs/heads/${distribution.releaseBranch}`);
  } catch (error) {
    const actual = git(root, 'ls-remote', 'origin', `refs/heads/${distribution.releaseBranch}`).split(/\s+/u)[0];
    if (actual !== commit) throw new Error('版本提交推送失败：main 可能已更新，或分支规则不允许 Actions 写入；未强推。', { cause: error });
  }
  return { ready: true, publish: true, commit_sha: commit, tag, source: sourceSha };
}

function main() {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_OUTPUT) throw new Error('此入口只在 GitHub Actions 中运行。');
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  let result;
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    if (process.env.GITHUB_REPOSITORY !== distribution.repository) throw new Error('自动发布仓库与发行配置不一致。');
    if (process.env.ZEUS_AUTO_RELEASE !== 'true') throw new Error('自动发布未启用，请先配置 ZEUS_AUTO_RELEASE。');
    if (event.deleted || event.ref !== `refs/heads/${distribution.releaseBranch}` || event.repository?.full_name !== distribution.repository) throw new Error('自动发布只接受本仓库 main 推送。');
    const origin = git(repositoryRoot, 'remote', 'get-url', 'origin');
    if (![`https://github.com/${distribution.repository}`, `https://github.com/${distribution.repository}.git`, `git@github.com:${distribution.repository}.git`].includes(origin)) throw new Error('origin 与发行仓库不一致。');
    const releases = JSON.parse(execFileSync('gh', ['api', `repos/${distribution.repository}/releases?per_page=100`, '--paginate', '--slurp'], { encoding: 'utf8' })).flat();
    result = prepareAutomaticCandidate({ root: repositoryRoot, sourceSha: event.after, releases });
  } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const publish = parseBoolean('publish_release', String(event.inputs?.publish_release ?? 'false'), false);
    const commit = git(repositoryRoot, 'rev-parse', 'HEAD');
    // 候选构建可在贡献者 fork 运行；公开发布仍要求显式绑定上游提交和标签。
    if (publish) {
      if (process.env.GITHUB_REPOSITORY !== distribution.repository) throw new Error('公开发布仓库与发行配置不一致。');
      if (!/^[a-f0-9]{40}$/u.test(event.inputs?.commit_sha ?? '') || event.inputs.commit_sha !== commit) throw new Error('公开发布要求显式填写与检出代码一致的 40 位提交。');
      if (!event.inputs?.tag) throw new Error('公开发布要求显式填写目标标签。');
    }
    result = {
      ready: true,
      publish,
      commit_sha: commit,
      tag: event.inputs?.tag || releaseTag(packageVersion(repositoryRoot)),
    };
  } else throw new Error('不支持的发布触发事件。');
  if (result.tag && !versionFromReleaseTag(result.tag)) throw new Error('发行标签格式不正确。');
  result.require_apple_distribution = parseBoolean('REQUIRE_APPLE_DISTRIBUTION', process.env.REQUIRE_APPLE_DISTRIBUTION, false);
  for (const [key, value] of Object.entries(result)) {
    if (key === 'reason') continue;
    appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(result.reason ?? `发布候选：${result.tag} / ${result.commit_sha}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
