#!/usr/bin/env node
/* global process, console */
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderReleaseManifest } from './generate-release-manifest.mjs';
import { sha256File } from './release-script-utils.mjs';

/** Windows 正式支持的两个原生架构必须同时完成构建。 */
const supportedArchitectures = ['x64', 'arm64'];

/** 合并前逐项验证来源、签名声明、文件名、架构、摘要和大小。 */
export async function assembleWindowsRelease(directory, version, sourceCommit) {
  /** 发布清单只包含本次固定候选实际产生的资产。 */
  const artifacts = [];
  /** 合并时间来自固定构建清单，重跑组装时不能产生不同的同名资产。 */
  let publishedAt = 0;
  for (const arch of supportedArchitectures) {
    /** 每份清单来自对应原生 Windows runner。 */
    const candidate = JSON.parse(await readFile(join(directory, `zeus-release-manifest-win32-${arch}.json`), 'utf8'));
    if (
      candidate.platform !== 'win32' ||
      candidate.app !== 'Zeus' ||
      candidate.repository !== 'imchenway/zeus' ||
      candidate.version !== version ||
      candidate.channel !== 'stable' ||
      candidate.sourceCommit !== sourceCommit ||
      candidate.signed !== true
    )
      throw new Error(`Windows ${arch} 构建清单来源不一致或未签名。`);
    /** 两个原生构建都完成时才具备完整发行，取较晚的有效时间。 */
    const builtAt = typeof candidate.publishedAt === 'string' ? Date.parse(candidate.publishedAt) : NaN;
    if (!Number.isFinite(builtAt) || builtAt <= 0) throw new Error(`Windows ${arch} 构建清单缺少有效发布时间。`);
    publishedAt = Math.max(publishedAt, builtAt);
    /** 每个架构只允许一个 NSIS 安装包，不接受便携包混入正式升级渠道。 */
    const artifact = candidate.artifacts?.find((item) => item.arch === arch);
    if (!artifact || artifact.platform !== 'win32' || artifact.kind !== 'exe' || artifact.fileName !== `Zeus-${version}-win32-${arch}.exe` || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error(`Windows ${arch} 安装包身份无效。`);
    if (artifact.downloadUrl !== `https://github.com/imchenway/zeus/releases/download/v${version}/${artifact.fileName}`) throw new Error(`Windows ${arch} 安装包下载来源不是本次官方发行。`);
    /** 下载的 CI 资产必须与已验签文件的摘要完全一致。 */
    const path = join(directory, artifact.fileName);
    if ((await stat(path)).size !== artifact.sizeBytes || (await sha256File(path)) !== artifact.sha256) throw new Error(`Windows ${arch} 安装包完整性校验失败。`);
    artifacts.push(artifact);
  }
  await writeFile(join(directory, 'zeus-release-manifest-win32.json'), renderReleaseManifest({ version, sourceCommit, platform: 'win32', signed: true, artifacts, publishedAt: new Date(publishedAt).toISOString() }));
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
  console.log('Windows 两个架构的签名产物已核对并合并清单。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
