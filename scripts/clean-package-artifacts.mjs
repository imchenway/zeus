#!/usr/bin/env node
/* global console, process */
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 只识别打包器生成的稳定版本安装包及配套文件。 */
const artifactPattern = /^Zeus-(Test-)?(\d+\.\d+\.\d+)-(arm64|x64)\.(dmg|zip)(\.blockmap)?$/u;

/** 按身份和架构保留最新实际安装包；默认只预览，不递归删除目录或跟随符号链接。 */
export async function cleanPackageArtifacts(outputRoot, { apply = false, variant, arch } = {}) {
  /** 不存在的输出目录没有待清理产物，其他读取错误必须暴露。 */
  const directory = await lstat(outputRoot).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!directory) return [];
  if (!directory.isDirectory()) throw new Error(`Zeus 安装包清理拒绝非普通目录：${outputRoot}`);

  /** 候选仅来自输出目录第一层的普通文件。 */
  const artifacts = [];
  for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
    /** 文件名携带身份、版本和架构，不接受任意前缀匹配。 */
    const match = entry.isFile() && entry.name.match(artifactPattern);
    if (!match) continue;
    /** 测试与正式安装包分别保留。 */
    const identity = match[1] ? 'test' : 'release';
    if ((variant && identity !== variant) || (arch && match[3] !== arch)) continue;
    artifacts.push({ name: entry.name, version: match[2], group: `${identity}-${match[3]}`, blockmap: Boolean(match[5]) });
  }

  /** 只有实际安装包能成为保留依据，孤立 blockmap 不占据最新版本。 */
  const archiveNames = new Set(artifacts.filter((artifact) => !artifact.blockmap).map((artifact) => artifact.name));
  /** 同一身份与架构按数字版本排序，避免 0.3.9 排在 0.3.110 之后。 */
  const latestVersions = new Map();
  for (const artifact of artifacts) {
    if (artifact.blockmap) continue;
    /** 已找到的最新实际安装包版本。 */
    const latest = latestVersions.get(artifact.group);
    if (!latest || artifact.version.localeCompare(latest, 'en', { numeric: true }) > 0) latestVersions.set(artifact.group, artifact.version);
  }

  /** 先完整收集可审阅清单，再按显式执行选项删除文件。 */
  const obsolete = [];
  for (const artifact of artifacts) {
    if (artifact.version === latestVersions.get(artifact.group) && (!artifact.blockmap || archiveNames.has(artifact.name.replace(/\.blockmap$/u, '')))) continue;
    /** 只删除普通文件，不用递归删除 API。 */
    const path = join(outputRoot, artifact.name);
    /** 删除前再次核对文件类型，目录和符号链接始终保留。 */
    const info = await lstat(path);
    if (info.isFile()) obsolete.push({ path, sizeBytes: info.size });
  }
  if (apply) {
    for (const artifact of obsolete) await unlink(artifact.path);
  }
  return obsolete;
}

/** 手动清理默认预览；显式输出目录只处理该目录，否则处理默认正式与测试目录。 */
async function main() {
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) throw new Error('用法：pnpm package:clean [--apply]；默认仅预览。');
  /** 只有显式参数才允许删除旧安装包。 */
  const apply = process.argv.includes('--apply');
  /** 输出路径与打包入口保持一致。 */
  const rootDir = resolve(import.meta.dirname, '..');
  /** 沿用打包入口已有的自定义输出目录设置。 */
  const configuredOutputRoot = process.env.ZEUS_PACKAGE_OUTPUT_DIR?.trim();
  /** 默认目录不递归扫描，避免触及用户文件与应用内容。 */
  const outputRoots = configuredOutputRoot ? [resolve(rootDir, configuredOutputRoot)] : [join(rootDir, 'dist'), join(rootDir, 'dist', 'test')];
  for (const outputRoot of outputRoots) {
    /** 清单只包含本次实际命中的旧安装包。 */
    const obsolete = await cleanPackageArtifacts(outputRoot, { apply });
    console.log(`Zeus 安装包清理${apply ? '完成' : '预览'}：${outputRoot}；${obsolete.length} 个文件，${(obsolete.reduce((bytes, artifact) => bytes + artifact.sizeBytes, 0) / 1024 ** 3).toFixed(2)} GiB。`);
    for (const artifact of obsolete) console.log(`- ${artifact.path}`);
  }
  if (!apply) console.log('仅预览，未删除文件；确认清单后执行 pnpm package:clean --apply。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
