#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { requiredVersion, sha256File, waitForReleaseOperations } from './release-script-utils.mjs';

/** 各资产独立上传到同一官方 Release，不覆盖已存在的同名文件。 */
const executeFile = promisify(execFile);

/** 同组安装包并发上传并核验完成后，才公开对应的更新清单。 */
async function publishReleaseAssets(directory, windowsOnly) {
  /** 版本和候选提交由发布作业固定，不从资产名称推测。 */
  const version = requiredVersion(process.env.RELEASE_TAG?.replace(/^v/u, ''));
  const sourceCommit = process.env.RELEASE_COMMIT ?? '';
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('GitHub 资产发布缺少固定候选提交。');
  /** 补发只处理 Windows，统一发布同时处理两个平台。 */
  const platforms = windowsOnly ? ['win32'] : ['darwin', 'win32'];
  const groups = await waitForReleaseOperations(
    platforms.map(async (platform) => {
      /** 平台清单必须精确属于本次官方稳定候选。 */
      const name = platform === 'win32' ? 'zeus-release-manifest-win32.json' : 'zeus-release-manifest.json';
      const manifest = JSON.parse(await readFile(join(directory, name), 'utf8'));
      if (
        manifest.app !== 'Zeus' ||
        manifest.repository !== 'imchenway/zeus' ||
        manifest.channel !== 'stable' ||
        manifest.schemaVersion !== 1 ||
        manifest.platform !== platform ||
        manifest.version !== version ||
        manifest.sourceCommit !== sourceCommit
      )
        throw new Error(`GitHub 资产清单身份不符：${name}`);
      /** 架构集合固定，不能用任意清单文件扩大上传范围。 */
      const architectures = platform === 'win32' ? ['x64', 'arm64'] : ['arm64'];
      if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== architectures.length) throw new Error(`GitHub 安装包数量不符：${name}`);
      const installers = await waitForReleaseOperations(
        architectures.map(async (arch) => {
          const fileName = `Zeus-${version}${platform === 'win32' ? '-win32' : ''}-${arch}.${platform === 'win32' ? 'exe' : 'dmg'}`;
          const artifact = manifest.artifacts.find((entry) => entry.arch === arch);
          if (
            !artifact ||
            artifact.fileName !== fileName ||
            artifact.platform !== platform ||
            artifact.kind !== (platform === 'win32' ? 'exe' : 'dmg') ||
            artifact.downloadUrl !== `https://github.com/imchenway/zeus/releases/download/v${version}/${fileName}`
          )
            throw new Error(`GitHub 安装包来源不符：${fileName}`);
          const file = await describeAsset(fileName);
          if (file.size !== artifact.sizeBytes || file.digest !== `sha256:${artifact.sha256}`) throw new Error(`GitHub 安装包摘要或大小不符：${fileName}`);
          return file;
        }),
      );
      return { installers, manifest: await describeAsset(name) };
    }),
  );
  /** 先核对全部已存在资产，再开始上传，未知读取结果不触发写入。 */
  let release = await readRelease();
  for (const file of groups.flatMap((group) => [...group.installers, group.manifest])) verifyAsset(file, release, true);
  for (const files of [groups.flatMap((group) => group.installers), groups.map((group) => group.manifest)]) {
    await waitForReleaseOperations(files.filter((file) => !release.assets.some((asset) => asset.name === file.name)).map((file) => command(['release', 'upload', `v${version}`, file.path, '--repo', 'imchenway/zeus'])));
    release = await readRelease();
    for (const file of files) verifyAsset(file, release, false);
  }

  /** 文件大小和 SHA-256 并发读取，元数据只描述当前磁盘文件。 */
  async function describeAsset(name) {
    const path = join(directory, name);
    const [information, digest] = await Promise.all([stat(path), sha256File(path)]);
    if (!Number.isSafeInteger(information.size) || information.size <= 0) throw new Error(`GitHub 资产大小无效：${name}`);
    return { name, path, size: information.size, digest: `sha256:${digest}` };
  }

  /** 固定官方仓库与公开稳定标签，禁止把草稿或预发布当作交付。 */
  async function readRelease() {
    const release = JSON.parse(await command(['release', 'view', `v${version}`, '--repo', 'imchenway/zeus', '--json', 'tagName,isDraft,isPrerelease,assets']));
    if (release.tagName !== `v${version}` || release.isDraft !== false || release.isPrerelease !== false || !Array.isArray(release.assets)) throw new Error('GitHub Release 身份不符。');
    return release;
  }
}

/** 同名资产必须唯一且字节身份相同；只有上传前允许明确缺失。 */
function verifyAsset(file, release, allowMissing) {
  const matches = release.assets.filter((asset) => asset.name === file.name);
  if (allowMissing && matches.length === 0) return;
  if (matches.length !== 1 || matches[0].size !== file.size || matches[0].digest !== file.digest) throw new Error(`GitHub 同名资产缺失或与固定候选不一致：${file.name}`);
}

/** 子进程继承当前认证环境，凭据不进入命令参数；单次上传上限为 30 分钟。 */
async function command(args) {
  return (await executeFile('gh', args, { encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 1024 * 1024 })).stdout;
}

/** 只有直接运行才上传；导入不会触发远程写入。 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || (process.argv[3] !== undefined && process.argv[3] !== 'win32')) throw new Error('用法：publish-release-assets.mjs dist [win32]。');
  publishReleaseAssets(resolve(process.argv[2]), process.argv[3] === 'win32').catch((error) => {
    console.error(String(error.stderr || error.message || error));
    process.exitCode = 1;
  });
}
