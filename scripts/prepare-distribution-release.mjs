#!/usr/bin/env node
import { releaseTag, releasePackagePaths, readDistributionVersion } from './desktop-distribution.mjs';
/* global process, console */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zeusDistribution as d } from './desktop-distribution.mjs';
import { requiredVersion, assertVersionAfterTag, validateReleaseNotes } from './release-script-utils.mjs';

// 支持尚无自有 GitHub Release 的首次发布；只准备文件，不提交、推送或发布。
const version = requiredVersion(process.env.RELEASE_VERSION || readDistributionVersion());
const paths = releasePackagePaths;
const packages = paths.map((path) => JSON.parse(readFileSync(path, 'utf8')));
if (packages[0].version !== packages[1].version) throw new Error('根包与桌面包版本不一致。');
if (version !== readDistributionVersion()) assertVersionAfterTag(version, releaseTag(readDistributionVersion()));
const tag = releaseTag(version);
const tags = execFileSync('git', ['tag', '--list', tag], { encoding: 'utf8' }).trim();
if (tags) throw new Error('目标版本已存在本地标签，请选择新的版本号。');
const notesPath = resolve(process.env.RELEASE_NOTES_FILE || '');
if (!process.env.RELEASE_NOTES_FILE || !existsSync(notesPath)) throw new Error('请提供 RELEASE_NOTES_FILE 指向已审阅的中文发布说明。');
const notes = readFileSync(notesPath, 'utf8');
validateReleaseNotes(notes, version);
const target = `releases/${tag}.md`;
if (existsSync(target)) throw new Error(`发布说明已存在，拒绝覆盖：${target}`);
const apply = process.env.APPLY_CHANGES === '1';
console.log(JSON.stringify({ repository: d.repository, version, tag, files: [...paths, target], apply }, null, 2));
if (apply) {
  for (let index = 0; index < paths.length; index += 1) writeFileSync(paths[index], JSON.stringify({ ...packages[index], version }, null, 2) + '\n');
  writeFileSync(target, notes);
  console.log(`候选文件已准备。审阅并推送 ${d.releaseBranch} 后，使用 Release 工作流先验收候选，再显式公开发布。`);
}
