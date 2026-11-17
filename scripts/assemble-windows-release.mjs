#!/usr/bin/env node
/* global process, console */
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderReleaseManifest } from './generate-release-manifest.mjs';
import { sha256File, waitForReleaseOperations } from './release-script-utils.mjs';

/** Windows 正式支持的两个原生架构必须同时完成构建。 */
const supportedArchitectures = ['x64', 'arm64'];

/** 合并前逐项验证来源、签名声明、文件名、架构、摘要和大小。 */
export async function assembleWindowsRelease(directory, version, sourceCommit) {
  /** 两个架构的读盘和摘要校验独立执行，收齐后才合并清单。 */
  const candidates = await waitForReleaseOperations(
    supportedArchitectures.map(async (arch) => {
      /** 每份清单来自对应原生 Windows runner。 */
      const candidate = JSON.parse(await readFile(join(directory, `zeus-release-manifest-win32-${arch}.json`), 'utf8'));
      if (
        candidate.platform !== 'win32' ||
        candidate.app !== 'Zeus' ||
        candidate.repository !== 'imchenway/zeus' ||
        candidate.version !== version ||
        candidate.channel !== 'stable' ||
        candidate.sourceCommit !== sourceCommit ||
        typeof candidate.signed !== 'boolean'
      )
        throw new Error(`Windows ${arch} 构建清单来源或签名状态不一致。`);
      /** 两个原生构建都完成时才具备完整发行，取较晚的有效时间。 */
      const builtAt = typeof candidate.publishedAt === 'string' ? Date.parse(candidate.publishedAt) : NaN;
      if (!Number.isFinite(builtAt) || builtAt <= 0) throw new Error(`Windows ${arch} 构建清单缺少有效发布时间。`);
      /** 每个架构只允许一个 NSIS 安装包，不接受便携包混入正式升级渠道。 */
      if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length !== 1) throw new Error(`Windows ${arch} 构建清单必须恰好包含一个安装器。`);
      /** 不能从混有其他版本或架构的清单中选择性接受一条记录。 */
      const artifact = candidate.artifacts[0];
      if (!artifact || artifact.arch !== arch || artifact.platform !== 'win32' || artifact.kind !== 'exe' || artifact.fileName !== `Zeus-${version}-win32-${arch}.exe` || !/^[a-f0-9]{64}$/u.test(artifact.sha256))
        throw new Error(`Windows ${arch} 安装包身份无效。`);
      if (artifact.downloadUrl !== `https://github.com/imchenway/zeus/releases/download/v${version}/${artifact.fileName}`) throw new Error(`Windows ${arch} 安装包下载来源不是本次官方发行。`);
      /** 下载的 CI 资产必须与对应构建文件的摘要完全一致。 */
      const path = join(directory, artifact.fileName);
      const [information, digest] = await Promise.all([stat(path), sha256File(path)]);
      if (information.size !== artifact.sizeBytes || digest !== artifact.sha256) throw new Error(`Windows ${arch} 安装包完整性校验失败。`);
      return { artifact, signed: candidate.signed, builtAt };
    }),
  );
  /** 签名策略必须一致，时间和顺序固定来自原构建，不随重跑改变。 */
  const signed = candidates[0].signed;
  if (candidates.some((candidate) => candidate.signed !== signed)) throw new Error('Windows 两个架构的构建清单签名状态不一致。');
  const artifacts = candidates.map((candidate) => candidate.artifact);
  const publishedAt = Math.max(...candidates.map((candidate) => candidate.builtAt));
  await writeFile(join(directory, 'zeus-release-manifest-win32.json'), renderReleaseManifest({ version, sourceCommit, platform: 'win32', signed, artifacts, publishedAt: new Date(publishedAt).toISOString() }));
}

/** CI 发布作业只组装本地已下载制品，不创建标签或上传远端。 */
async function main() {
  /** 工作树根路径固定于当前脚本。 */
  const root = resolve(import.meta.dirname, '..');
  /** 当前候选版本来自根包清单。 */
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  /** 构建提交必须与发行作业检出的候选一致。 */
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  await assembleWindowsRelease(resolve(root, process.argv[2] || 'dist'), version, sourceCommit);
  console.log('Windows 两个架构的正式产物已核对并合并清单，签名状态按实际构建记录。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
