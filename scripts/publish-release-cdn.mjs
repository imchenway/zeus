#!/usr/bin/env node
/* global console, process */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cdnReleaseManifest,
  releaseCdnBaseUrl,
  releaseCdnStableCacheControl,
  renderCdnReleaseNotes,
  requiredVersion,
  sha256File,
  stableReleaseArtifactFileName,
  verifyPublicCdnDownload,
  verifyPublicCdnManifest,
} from './release-script-utils.mjs';

/** 各平台固定清单名同时用于不可变版本目录和可变更新目录。 */
const manifestNames = { darwin: 'zeus-release-manifest.json', win32: 'zeus-release-manifest-win32.json' };

/** CI 的非密钥配置必须指向官方域名和有效的 OSS 空间，不允许临时镜像替代官方来源。 */
export function releaseCdnConfiguration(env = process.env) {
  /** Bucket 与地域仅参与官方 OSS 地址和已授权对象前缀的构造。 */
  const bucket = env.ZEUS_OSS_BUCKET?.trim();
  const region = env.ZEUS_OSS_REGION?.trim();
  const baseUrl = env.ZEUS_DOWNLOAD_BASE_URL?.trim().replace(/\/$/u, '');
  if (!bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(bucket) || !region || !/^[a-z]+(?:-[a-z0-9]+)+$/u.test(region) || baseUrl !== releaseCdnBaseUrl) throw new Error('OSS 发布配置缺失或不属于官方 CDN。');
  /** 上传角色和 OIDC 提供商必须属于同一账号，配置缺失时在公开发布前失败。 */
  const providerAccount = env.ALIYUN_OIDC_PROVIDER_ARN?.match(/^acs:ram::(\d+):oidc-provider\/[\w.-]+$/u)?.[1];
  const roleAccount = env.ALIYUN_ROLE_ARN?.match(/^acs:ram::(\d+):role\/[\w./-]+$/u)?.[1];
  if (!providerAccount || providerAccount !== roleAccount) throw new Error('OIDC 身份提供商和上传角色缺失或账号不一致。');
  return { bucket, region, baseUrl };
}

/** stage 只准备版本目录；activate 才更新固定下载入口和稳定清单。 */
export async function publishReleaseCdn({ directory, configuration, version, sourceCommit, activate = false }, execute = executeReleaseCommand, request = fetch) {
  requiredVersion(version);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('OSS 发布缺少固定候选提交。');
  /** 临时目录只保存本次清单和小型回读文件，不保存凭据。 */
  const temporary = await mkdtemp(join(tmpdir(), 'zeus-cdn-'));
  /** 两个发布阶段使用完全相同的制品身份和校验流程。 */
  const files = [];
  try {
    for (const currentPlatform of Object.keys(manifestNames)) {
      /** GitHub 清单保持原样，CDN 清单在临时目录生成。 */
      const fileName = manifestNames[currentPlatform];
      const manifest = JSON.parse(await readFile(join(directory, fileName), 'utf8'));
      if (
        manifest.app !== 'Zeus' ||
        manifest.repository !== 'imchenway/zeus' ||
        manifest.channel !== 'stable' ||
        manifest.schemaVersion !== 1 ||
        manifest.version !== version ||
        manifest.sourceCommit !== sourceCommit ||
        (manifest.platform ?? 'darwin') !== currentPlatform
      )
        throw new Error(`OSS 发布清单身份不符：${fileName}`);
      /** 平台必须包含正式支持的全部架构，不接受选择性上传。 */
      const architectures = currentPlatform === 'win32' ? ['x64', 'arm64'] : ['arm64'];
      if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== architectures.length) throw new Error(`OSS 安装包数量不符：${fileName}`);
      for (const arch of architectures) {
        /** 名称严格由候选版本、平台和架构产生，不能将其他本地文件上传到 OSS。 */
        const expectedName = `Zeus-${version}${currentPlatform === 'win32' ? '-win32' : ''}-${arch}.${currentPlatform === 'win32' ? 'exe' : 'dmg'}`;
        const artifact = manifest.artifacts.find((entry) => entry.arch === arch);
        if (
          !artifact ||
          artifact.fileName !== expectedName ||
          artifact.kind !== (currentPlatform === 'win32' ? 'exe' : 'dmg') ||
          (artifact.platform ?? 'darwin') !== currentPlatform ||
          !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
          artifact.downloadUrl !== `https://github.com/imchenway/zeus/releases/download/v${version}/${expectedName}`
        )
          throw new Error(`OSS 安装包来源不符：${expectedName}`);
        /** 只有实际文件的大小和摘要匹配构建清单才允许分发。 */
        const path = join(directory, expectedName);
        const size = (await stat(path)).size;
        if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes !== size || size <= 0 || size > 2 * 1024 ** 3 || (await sha256File(path)) !== artifact.sha256) throw new Error(`OSS 安装包大小或 SHA-256 不符：${expectedName}`);
        files.push({ path, fileName: expectedName, sha256: artifact.sha256, size, key: `zeus/releases/${version}/${expectedName}`, contentType: 'application/octet-stream' });
      }
      /** 保留原始发布时间及字段顺序，使同候选重跑产生相同清单字节。 */
      const path = join(temporary, fileName);
      await writeFile(path, `${JSON.stringify(cdnReleaseManifest(manifest), null, 2)}\n`, { mode: 0o600 });
      files.push({ path, fileName, sha256: await sha256File(path), size: (await stat(path)).size, key: `zeus/releases/${version}/${fileName}`, contentType: 'application/json', platform: currentPlatform, manifest });
    }
    for (const file of files) {
      /** CRC64 与 OSS 服务端计算值对账，避免对分片 ETag 错当 MD5，也避免回下载整个安装包。 */
      const crc64 = runOssutil(['hash', 'crc64', file.path]).match(/^\s*(\d+)\s/u)?.[1];
      if (!crc64) throw new Error(`无法计算制品 CRC64：${file.fileName}`);
      file.crc64 = crc64;
      /** 已有固定版本文件只核验，不覆盖；只有 stage 可以创建缺失文件。 */
      let headers = headObject(file.key);
      if (!headers) {
        if (activate) throw new Error(`固定版本文件尚未准备完成：${file.key}`);
        copyObject(file, file.key, true);
        headers = headObject(file.key);
      }
      assertStoredFile(file, headers);
      /** 确认实际下载域名能访问该对象，而非只确认 OSS 内部写入成功。 */
      await assertPublicFile(file);
    }
    for (const file of files.filter((entry) => entry.platform)) await verifyPublicCdnManifest(file.manifest, file.fileName, request);
    if (!activate) return { files: files.length, activated: [] };
    /** 旧版本补发不能将稳定指针移回 GitHub 当前稳定版之前。 */
    const latestVersion = requiredVersion(execute('gh', ['release', 'view', '--repo', 'imchenway/zeus', '--json', 'tagName', '--jq', '.tagName']).trim().replace(/^v/u, ''));
    if (latestVersion !== version) return { files: files.length, activated: [], reason: '目标版本不是 GitHub 当前稳定版本，仅补齐固定版本文件。' };
    /** 所有平台文件已核验后，才逐个平台更新稳定指针。 */
    const activated = [];
    for (const file of files.filter((entry) => entry.platform)) {
      /** 指针写入由两个工作流共同的 publish 并发组串行保护。 */
      const key = `zeus/updates/${file.fileName}`;
      const previous = headObject(key);
      /** 同版重跑仍修补安装包入口，不重复覆盖已经核对的稳定清单。 */
      let sameVersion = false;
      if (previous) {
        /** 只回读小型稳定清单，不通过不可靠的同名覆盖猜测当前版本。 */
        const previousPath = join(temporary, `previous-${file.fileName}`);
        if (Number(previous['content-length']) > 1024 * 1024) throw new Error('现有 CDN 更新清单超过允许大小。');
        runOssutil(['cp', objectUrl(key), previousPath, '--force']);
        const manifest = JSON.parse(await readFile(previousPath, 'utf8'));
        if (
          manifest.app !== 'Zeus' ||
          manifest.repository !== 'imchenway/zeus' ||
          manifest.channel !== 'stable' ||
          manifest.schemaVersion !== 1 ||
          manifest.platform !== file.platform ||
          !/^[a-f0-9]{40}$/u.test(manifest.sourceCommit) ||
          !Array.isArray(manifest.artifacts)
        )
          throw new Error('现有 CDN 更新清单身份不符。');
        const order = compareVersions(requiredVersion(manifest.version), version);
        if (order > 0) continue;
        if (order === 0) {
          assertStoredFile(file, previous);
          sameVersion = true;
        }
      }
      /** 从已校验的版本对象服务端复制，README 使用的入口不再含版本号。 */
      for (const artifact of file.manifest.artifacts) {
        const installer = files.find((entry) => entry.fileName === artifact.fileName);
        const downloadKey = `zeus/updates/${stableReleaseArtifactFileName(version, artifact.fileName)}`;
        /** 同版完整对象直接复用；缺失、旧版本或缓存属性不符时才重新复制。 */
        let headers = headObject(downloadKey);
        if (!storedFileMatches(installer, headers) || headers['cache-control'] !== releaseCdnStableCacheControl || headers['content-disposition'] !== `attachment; filename="${installer.fileName}"`) {
          copyObject(installer, downloadKey, false, objectUrl(installer.key));
          headers = headObject(downloadKey);
        }
        assertStoredFile(installer, headers);
      }
      /** CDN 仍返回旧缓存时等待其过期，全部入口可用后才推进更新清单。 */
      await Promise.all(file.manifest.artifacts.map((artifact) => verifyPublicCdnDownload(file.manifest, artifact, request)));
      if (sameVersion) continue;
      copyObject(file, key, false);
      assertStoredFile(file, headObject(key));
      activated.push(file.platform);
    }
    return { files: files.length, activated };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  /** 凭据只由环境传入 ossutil；日志关闭，地域和 HTTPS Endpoint 显式固定。 */
  function runOssutil(args) {
    return execute('ossutil', [...args, '--region', configuration.region, '--endpoint', `https://oss-${configuration.region}.aliyuncs.com`, '--mode', 'StsToken', '--loglevel', 'off', '--quiet']);
  }

  /** 所有操作只能落在已授权的 zeus 对象前缀内。 */
  function objectUrl(key) {
    if (!key.startsWith('zeus/') || key.includes('..')) throw new Error('OSS 对象路径越界。');
    return `oss://${configuration.bucket}/${key}`;
  }

  /** 只有明确的 NoSuchKey 才视为缺失；权限、网络及 Bucket 错误均停止发布。 */
  function headObject(key) {
    objectUrl(key);
    try {
      /** ossutil 固定版本返回 Header 字典；HTTP 头按大小写不敏感处理。 */
      const response = JSON.parse(runOssutil(['api', 'head-object', '--bucket', configuration.bucket, '--key', key, '--output-format', 'json']));
      if (!response.Header || typeof response.Header !== 'object') throw new Error('OSS 元数据响应格式无效。');
      return Object.fromEntries(Object.entries(response.Header).map(([name, values]) => [name.toLowerCase(), Array.isArray(values) ? values[0] : values]));
    } catch (error) {
      if (/Error Code:\s*NoSuchKey\b/u.test(String(error.stderr ?? error.message))) return null;
      throw error;
    }
  }

  /** 版本目录不可变；可变入口使用一分钟缓存，并保留实际版本文件名供下载保存。 */
  function copyObject(file, key, immutable, source = file.path) {
    runOssutil([
      'cp',
      source,
      objectUrl(key),
      immutable ? '--ignore-existing' : '--force',
      ...(source === file.path ? [] : ['--copy-props', 'metadata', '--metadata-directive', 'REPLACE', '--content-disposition', `attachment; filename="${file.fileName}"`]),
      '--metadata',
      `sha256=${file.sha256}`,
      '--metadata',
      `source-commit=${sourceCommit}`,
      '--content-type',
      file.contentType,
      '--cache-control',
      immutable ? 'public,max-age=2592000,immutable,no-transform' : releaseCdnStableCacheControl,
    ]);
  }

  /** 候选摘要、提交、字节数与服务端 CRC64 共同决定对象能否复用。 */
  function storedFileMatches(file, headers) {
    return Boolean(
      headers && headers['x-oss-meta-sha256'] === file.sha256 && headers['x-oss-meta-source-commit'] === sourceCommit && String(headers['content-length']) === String(file.size) && headers['x-oss-hash-crc64ecma'] === file.crc64,
    );
  }

  /** 已存在的不可变制品必须匹配固定候选，不能自动覆盖或忽略不一致。 */
  function assertStoredFile(file, headers) {
    if (!storedFileMatches(file, headers)) throw new Error(`OSS 已存制品与固定候选不一致：${file.key}`);
  }

  /** 公开 HEAD 请求原始字节长度，避免 CDN 压缩导致大小误判；服务端完整性由 OSS 元数据及 CRC64 校验确认。 */
  async function assertPublicFile(file) {
    const response = await request(`${configuration.baseUrl}/releases/${version}/${encodeURIComponent(file.fileName)}`, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' }, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok || response.headers.get('x-oss-meta-sha256') !== file.sha256 || response.headers.get('content-length') !== String(file.size)) throw new Error(`CDN 公开制品不可用或身份不符：${file.fileName}，HTTP ${response.status}`);
  }
}

/** 稳定发布只比较三段数字版本，不能以字符串顺序将 0.10 排在 0.9 之前。 */
function compareVersions(left, right) {
  const a = requiredVersion(left).split('.').map(Number);
  const b = requiredVersion(right).split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/** 子进程只输出业务结果；不会将环境或凭据拼入命令参数。 */
function executeReleaseCommand(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', timeout: 30 * 60_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** 只有直接执行本脚本才写入 OSS；导入验证函数不会触发发布。 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    /** validate 只核对公开配置与固定候选正文，不申请凭据或写入 OSS。 */
    const [mode, path] = process.argv.slice(2);
    if (mode === 'validate') {
      releaseCdnConfiguration();
      /** CDN 链接必须在固定候选中，不能等远端发布后再临时补正文。 */
      const version = requiredVersion(process.env.RELEASE_TAG?.replace(/^v/u, ''));
      const notes = await readFile(join('releases', `v${version}.md`), 'utf8');
      if (notes !== renderCdnReleaseNotes(notes, version)) throw new Error('候选 Release notes 缺少完整 CDN 下载区块，请先通过 release:prepare 准备候选。');
      return;
    }
    if (!['stage', 'activate'].includes(mode)) throw new Error('用法：publish-release-cdn.mjs validate，或 stage|activate dist。');
    /** OIDC 信任与运行分支一致，不能借检出 main 的文件从其他分支申请发布权限。 */
    if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('CDN 发布只能从 main 分支运行。');
    const result = await publishReleaseCdn({
      directory: resolve(path),
      configuration: releaseCdnConfiguration(),
      version: requiredVersion(process.env.RELEASE_TAG?.replace(/^v/u, '')),
      sourceCommit: process.env.RELEASE_COMMIT ?? '',
      activate: mode === 'activate',
    });
    console.log(`CDN ${mode} 完成：${JSON.stringify(result)}`);
  })().catch((error) => {
    /** SDK 错误可能含请求信息；输出前移除本次临时凭据。 */
    let message = String(error.stderr || error.message || error);
    for (const key of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_SESSION_TOKEN']) {
      if (process.env[key]) message = message.replaceAll(process.env[key], '[REDACTED]');
    }
    console.error(message);
    process.exitCode = 1;
  });
}
