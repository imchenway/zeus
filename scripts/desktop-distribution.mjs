import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const distributionConfigPath = resolve(import.meta.dirname, '..', 'packages/distribution/src/config.json');

/** 发布前检查运行在干净检出目录，直接读取受版本控制的发行配置，不依赖构建产物 dist。 */
export const zeusDistribution = JSON.parse(readFileSync(distributionConfigPath, 'utf8'));

/** 根包是唯一应用版本源，发布时同步桌面包；内部工作区包不参与发行编号。 */
export const releasePackagePaths = ['package.json', 'apps/desktop/package.json'];

export function readDistributionVersion() {
  return JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')).version;
}

export function assertDistributionVersions() {
  const version = readDistributionVersion();
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error('发行包必须使用三段稳定版本号。');
  for (const path of releasePackagePaths) {
    if (JSON.parse(readFileSync(resolve(import.meta.dirname, '..', path), 'utf8')).version !== version) throw new Error(`${path} 与根包版本 ${version} 不一致，请同步版本后构建。`);
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
