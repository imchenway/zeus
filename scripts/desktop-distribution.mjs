// 构建脚本运行在 Node 原生 ESM 环境，不能直接加载 TypeScript 源文件；工作区构建会先生成发行包 dist。
import { skylightDistribution } from '../packages/skylight-distribution/dist/index.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** 发布与构建统一选择发行包，不从通用 shared 包读取二开常量。 */
export const zeusDistribution = skylightDistribution;

/** 发行包版本是二开版本源，应用元数据在准备发布时同步。 */
export const distributionPackagePath = 'packages/skylight-distribution/package.json';
export const releasePackagePaths = ['package.json', 'apps/desktop/package.json', distributionPackagePath];

export function readDistributionVersion() {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '..', distributionPackagePath), 'utf8')).version;
}

export function assertDistributionVersions() {
  const version = readDistributionVersion();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('发行包必须使用三段稳定版本号。');
  for (const path of releasePackagePaths) {
    if (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', path), 'utf8')).version !== version) throw new Error(`${path} 与二开发行版本 ${version} 不一致，请同步版本后构建。`);
  }
  return version;
}

export function releaseTag(version) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error(`无效发行版本：${version}`);
  return `${zeusDistribution.releaseTagPrefix}${version}`;
}

export function versionFromReleaseTag(tag) {
  if (typeof tag !== 'string' || !tag.startsWith(zeusDistribution.releaseTagPrefix)) return null;
  const version = tag.slice(zeusDistribution.releaseTagPrefix.length);
  return /^\d+\.\d+\.\d+$/u.test(version) ? version : null;
}
