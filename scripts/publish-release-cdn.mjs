#!/usr/bin/env node
/* global console, process */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
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
  waitForReleaseOperations,
} from './release-script-utils.mjs';

/** 各平台固定清单名同时用于不可变版本目录和可变更新目录。 */
const manifestNames = { darwin: 'zeus-release-manifest.json', win32: 'zeus-release-manifest-win32.json' };
/** OSS 子进程异步执行，使不同对象的上传与核验可以重叠。 */
const executeFile = promisify(execFile);
/** 单条发布命令最多执行三十分钟，诊断日志与执行器共用这一时限。 */
const releaseCommandTimeoutMs = 30 * 60_000;
/** 每次连接 OSS 的等待上限，单位秒。 */
const ossConnectTimeoutSeconds = 10;
/** 单次 OSS 请求读写的超时上限，单位秒，不代表整份文件的上传时限。 */
const ossReadWriteTimeoutSeconds = 60;
/** 单次 OSS 请求失败后最多重试两次，全部重试仍受命令总时限约束。 */
const ossRequestRetryTimes = 2;

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

/** stage 可逐包准备版本目录，完整 stage 才核验平台清单；activate 更新固定下载入口和稳定清单。 */
export async function publishReleaseCdn({ directory, configuration, version, sourceCommit, activate = false, artifactFileName, requireStagedInstallers = false }, execute = executeReleaseCommand, request = fetch) {
  requiredVersion(version);
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit)) throw new Error('OSS 发布缺少固定候选提交。');
  if (artifactFileName !== undefined && (activate || requireStagedInstallers || typeof artifactFileName !== 'string' || !artifactFileName)) throw new Error('单制品上传只允许 stage 指定候选安装包。');
  console.log(`OSS 超时设置：connect_timeout_seconds=${ossConnectTimeoutSeconds}，read_write_timeout_seconds=${ossReadWriteTimeoutSeconds}，retry_times=${ossRequestRetryTimes}，command_timeout_ms=${releaseCommandTimeoutMs}`);
  /** 单包上传只下载对应构建附件；完整发布仍要求三个正式安装包。 */
  let targets = Object.entries(manifestNames).map(([platform, fileName]) => ({ platform, fileName, architectures: platform === 'win32' ? ['x64', 'arm64'] : ['arm64'] }));
  if (artifactFileName !== undefined) {
    /** 名称只能指向固定版本的三个正式安装包，不接受任意文件路径。 */
    const target = [
      ['darwin', 'arm64'],
      ['win32', 'x64'],
      ['win32', 'arm64'],
    ].find(([platform, arch]) => artifactFileName === `Zeus-${version}${platform === 'win32' ? '-win32' : ''}-${arch}.${platform === 'win32' ? 'exe' : 'dmg'}`);
    if (!target) throw new Error(`不属于固定候选的安装包：${artifactFileName}`);
    targets = [{ platform: target[0], fileName: target[0] === 'win32' ? `zeus-release-manifest-win32-${target[1]}.json` : manifestNames.darwin, architectures: [target[1]] }];
  }
  /** 临时目录只保存本次清单和小型回读文件，不保存凭据。 */
  const temporary = await mkdtemp(join(tmpdir(), 'zeus-cdn-'));
  try {
    /** 平台清单和各安装包独立校验；任何失败均先等待其他操作结束。 */
    const files = (
      await waitForReleaseOperations(
        targets.map(async ({ platform: currentPlatform, fileName, architectures }) => {
          /** GitHub 清单保持原样，CDN 清单在临时目录生成。 */
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
          if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== architectures.length) throw new Error(`OSS 安装包数量不符：${fileName}`);
          /** 三个安装包的读盘和摘要计算互不依赖。 */
          const artifacts = await waitForReleaseOperations(
            architectures.map(async (arch) => {
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
              const [information, digest] = await Promise.all([stat(path), sha256File(path)]);
              const size = information.size;
              if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes !== size || size <= 0 || size > 2 * 1024 ** 3 || digest !== artifact.sha256) throw new Error(`OSS 安装包大小或 SHA-256 不符：${expectedName}`);
              return { path, fileName: expectedName, sha256: artifact.sha256, size, key: `zeus/releases/${version}/${expectedName}`, contentType: 'application/octet-stream' };
            }),
          );
          if (artifactFileName !== undefined) return artifacts;
          /** 保留原始发布时间及字段顺序，使同候选重跑产生相同清单字节。 */
          const path = join(temporary, fileName);
          await writeFile(path, `${JSON.stringify(cdnReleaseManifest(manifest), null, 2)}\n`, { mode: 0o600 });
          return [...artifacts, { path, fileName, sha256: await sha256File(path), size: (await stat(path)).size, key: `zeus/releases/${version}/${fileName}`, contentType: 'application/json', platform: currentPlatform, manifest }];
        }),
      )
    ).flat();
    /** 安装包组与清单组分别并发，全部安装包核验完成前不公开平台清单。 */
    for (const batch of [files.filter((file) => !file.platform), files.filter((file) => file.platform)]) {
      await waitForReleaseOperations(
        batch.map(async (file) => {
          console.log(`CDN 制品准备开始：${file.fileName}，size_bytes=${file.size}`);
          /** CRC64 与 OSS 服务端计算值对账，避免对分片 ETag 错当 MD5，也避免回下载整个安装包。 */
          const crc64 = (await runOssutil(['hash', 'crc64', file.path])).match(/^\s*(\d+)\s/u)?.[1];
          if (!crc64) throw new Error(`无法计算制品 CRC64：${file.fileName}`);
          file.crc64 = crc64;
          /** 已有固定版本文件只核验，不覆盖；只有 stage 可以创建缺失文件。 */
          let headers = await headObject(file.key);
          console.log(`OSS 对象状态：${file.key}，${headers ? '已存在，核验固定候选' : '不存在，需要上传'}`);
          if (!headers) {
            if (activate || (requireStagedInstallers && !file.platform)) throw new Error(`固定版本文件尚未准备完成：${file.key}`);
            await copyObject(file, file.key, true);
            headers = await headObject(file.key);
          }
          assertStoredFile(file, headers);
          console.log(`OSS 制品核验通过，开始 CDN 回读：${file.fileName}`);
          /** 确认实际下载域名能访问该对象，而非只确认 OSS 内部写入成功。 */
          await assertPublicFile(file);
          console.log(`CDN 制品准备完成：${file.fileName}`);
        }),
      );
    }
    if (artifactFileName === undefined) await waitForReleaseOperations(files.filter((entry) => entry.platform).map((file) => verifyPublicCdnManifest(file.manifest, file.fileName, request)));
    if (!activate) return { files: files.length, activated: [] };
    /** 旧版本补发不能将稳定指针移回 GitHub 当前稳定版之前。 */
    const latestVersion = requiredVersion((await execute('gh', ['release', 'view', '--repo', 'imchenway/zeus', '--json', 'tagName', '--jq', '.tagName'])).trim().replace(/^v/u, ''));
    if (latestVersion !== version) return { files: files.length, activated: [], reason: '目标版本不是 GitHub 当前稳定版本，仅补齐固定版本文件。' };
    /** 各平台的旧清单读取、安装包入口复制和公开回读可以独立进行。 */
    const prepared = await waitForReleaseOperations(
      files
        .filter((entry) => entry.platform)
        .map(async (file) => {
          /** 指针写入由两个工作流共同的 publish 并发组串行保护。 */
          const key = `zeus/updates/${file.fileName}`;
          const previous = await headObject(key);
          /** 同版重跑仍修补安装包入口，不重复覆盖已经核对的稳定清单。 */
          let sameVersion = false;
          if (previous) {
            /** 只回读小型稳定清单，不通过不可靠的同名覆盖猜测当前版本。 */
            const previousPath = join(temporary, `previous-${file.fileName}`);
            if (Number(previous['content-length']) > 1024 * 1024) throw new Error('现有 CDN 更新清单超过允许大小。');
            await runOssutil(['cp', objectUrl(key), previousPath, '--force']);
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
            if (order > 0) return null;
            if (order === 0) {
              assertStoredFile(file, previous);
              sameVersion = true;
            }
          }
          /** 从已校验的版本对象服务端复制，README 使用的入口不再含版本号。 */
          await waitForReleaseOperations(
            file.manifest.artifacts.map(async (artifact) => {
              const installer = files.find((entry) => entry.fileName === artifact.fileName);
              const downloadKey = `zeus/updates/${stableReleaseArtifactFileName(version, artifact.fileName)}`;
              /** 同版完整对象直接复用；缺失、旧版本或缓存属性不符时才重新复制。 */
              let headers = await headObject(downloadKey);
              if (!storedFileMatches(installer, headers) || headers['cache-control'] !== releaseCdnStableCacheControl || headers['content-disposition'] !== `attachment; filename="${installer.fileName}"`) {
                await copyObject(installer, downloadKey, false, objectUrl(installer.key));
                headers = await headObject(downloadKey);
              }
              assertStoredFile(installer, headers);
            }),
          );
          /** CDN 仍返回旧缓存时等待其过期，全部入口可用后才推进更新清单。 */
          await waitForReleaseOperations(file.manifest.artifacts.map((artifact) => verifyPublicCdnDownload(file.manifest, artifact, request)));
          return { file, key, sameVersion };
        }),
    );
    /** 所有安装包入口就绪后才串行写稳定清单，跨版本仍受 publish 并发组保护。 */
    const activated = [];
    for (const { file, key, sameVersion } of prepared.filter(Boolean)) {
      if (sameVersion) continue;
      await copyObject(file, key, false);
      assertStoredFile(file, await headObject(key));
      activated.push(file.platform);
    }
    return { files: files.length, activated };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }

  /** 复制命令独立记录信息级日志；机器读取的摘要和元数据输出不混入日志。 */
  function runOssutil(args) {
    /** 日志位于本次私有临时目录，避免并发命令混写或遗留原始请求信息。 */
    const logPath = args[0] === 'cp' ? join(temporary, `ossutil-${randomUUID()}.log`) : null;
    return execute('ossutil', [
      ...args,
      '--region',
      configuration.region,
      '--endpoint',
      `https://oss-${configuration.region}.aliyuncs.com`,
      '--mode',
      'StsToken',
      '--connect-timeout',
      String(ossConnectTimeoutSeconds),
      '--read-timeout',
      String(ossReadWriteTimeoutSeconds),
      '--retry-times',
      String(ossRequestRetryTimes),
      '--loglevel',
      logPath ? 'info' : 'off',
      ...(logPath ? ['--log-file', logPath] : []),
      '--quiet',
    ]);
  }

  /** 所有操作只能落在已授权的 zeus 对象前缀内。 */
  function objectUrl(key) {
    if (!key.startsWith('zeus/') || key.includes('..')) throw new Error('OSS 对象路径越界。');
    return `oss://${configuration.bucket}/${key}`;
  }

  /** 只有明确的 NoSuchKey 才视为缺失；权限、网络及 Bucket 错误均停止发布。 */
  async function headObject(key) {
    objectUrl(key);
    try {
      /** ossutil 固定版本返回 Header 字典；HTTP 头按大小写不敏感处理。 */
      const response = JSON.parse(await runOssutil(['api', 'head-object', '--bucket', configuration.bucket, '--key', key, '--output-format', 'json']));
      if (!response.Header || typeof response.Header !== 'object') throw new Error('OSS 元数据响应格式无效。');
      return Object.fromEntries(Object.entries(response.Header).map(([name, values]) => [name.toLowerCase(), Array.isArray(values) ? values[0] : values]));
    } catch (error) {
      if (/Error Code:\s*NoSuchKey\b/u.test(String(error.stderr ?? error.message))) return null;
      throw error;
    }
  }

  /** 版本目录不可变；可变入口使用一分钟缓存，并保留实际版本文件名供下载保存。 */
  function copyObject(file, key, immutable, source = file.path) {
    return runOssutil([
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

/** 发布日志统一隐藏环境凭据、请求认证头和签名参数。 */
function redactReleaseCommandOutput(value) {
  /** 先脱敏完整输出，再由调用方截取尾部，避免截断后留下部分凭据。 */
  let output = String(value ?? '');
  for (const key of ['OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET', 'OSS_SESSION_TOKEN', 'ALIBABACLOUD_ACCESS_KEY_ID', 'ALIBABACLOUD_ACCESS_KEY_SECRET', 'ALIBABACLOUD_SECURITY_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    if (process.env[key]) output = output.replaceAll(process.env[key], '[REDACTED]');
  }
  return output
    .replace(/(authorization["']?\s*[:=]\s*)[^\r\n]*/giu, '$1[REDACTED]')
    .replace(/((?:x-oss-security-token|security[-_]?token|ossaccesskeyid|x-oss-credential|x-oss-signature|signature)["']?\s*[:=]\s*["']?)[^\s"',;&]+/giu, '$1[REDACTED]');
}

/** 记录命令耗时和等待心跳；失败时保留退出状态及脱敏后的原生诊断。 */
async function executeReleaseCommand(command, args) {
  /** 只记录操作和复制路径，不展开可能携带认证信息的完整命令参数。 */
  const operation = redactReleaseCommandOutput(`${command} ${args.slice(0, args[0] === 'cp' ? 3 : 2).join(' ')}`);
  /** 单调时钟提供不受系统校时影响的实际执行耗时。 */
  const startedAt = performance.now();
  console.log(`发布命令开始：${operation}，timeout_ms=${releaseCommandTimeoutMs}`);
  /** 原生命令没有输出时，仍每分钟报告当前操作和实际等待时长。 */
  const heartbeat = setInterval(() => console.log(`发布命令仍在执行：${operation}，elapsed_ms=${Math.round(performance.now() - startedAt)}`), 60_000);
  try {
    /** stdout 原样返回给摘要和 JSON 解析，不将诊断日志写入机器输出。 */
    const { stdout, stderr } = await executeFile(command, args, {
      encoding: 'utf8',
      timeout: releaseCommandTimeoutMs,
      // 总时限到达后强制终止，避免子进程忽略终止请求而继续等待。
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
    if (stderr.trim()) console.warn(`发布命令 stderr：${operation}\n${redactReleaseCommandOutput(stderr).slice(-32768)}`);
    console.log(`发布命令完成：${operation}，elapsed_ms=${Math.round(performance.now() - startedAt)}`);
    return stdout;
  } catch (error) {
    /** 退出码、信号和 killed 分开记录，不把包装脚本退出码当作 OSS 错误码。 */
    const details = [
      `发布命令失败：${operation}，elapsed_ms=${Math.round(performance.now() - startedAt)}，timeout_ms=${releaseCommandTimeoutMs}，code=${error.code ?? 'unknown'}，signal=${error.signal ?? 'none'}，killed=${error.killed ?? false}`,
      redactReleaseCommandOutput(error.message).slice(-32768),
    ];
    for (const stream of ['stdout', 'stderr']) {
      if (error[stream]) details.push(`${stream}（脱敏后最多保留末尾 32768 字符）：\n${redactReleaseCommandOutput(error[stream]).slice(-32768)}`);
    }
    /** OSS 原生日志补充重试和传输错误；日志不存在不覆盖最初的命令故障。 */
    const logFileIndex = args.indexOf('--log-file');
    if (logFileIndex >= 0) {
      try {
        details.push(`ossutil 日志（脱敏后最多保留末尾 32768 字符）：\n${redactReleaseCommandOutput(await readFile(args[logFileIndex + 1], 'utf8')).slice(-32768)}`);
      } catch (logError) {
        details.push(`ossutil 日志读取失败：${logError.code ?? logError.message}`);
      }
    }
    throw new Error(redactReleaseCommandOutput(details.join('\n')), { cause: error });
  } finally {
    clearInterval(heartbeat);
  }
}

/** 只有直接执行本脚本才写入 OSS；导入验证函数不会触发发布。 */
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    /** validate 只核对公开配置与固定候选正文，不申请凭据或写入 OSS。 */
    const [mode, path, artifactFileName] = process.argv.slice(2);
    if (mode === 'validate') {
      releaseCdnConfiguration();
      /** CDN 链接必须在固定候选中，不能等远端发布后再临时补正文。 */
      const version = requiredVersion(process.env.RELEASE_TAG?.replace(/^v/u, ''));
      const notes = await readFile(join('releases', `v${version}.md`), 'utf8');
      if (notes !== renderCdnReleaseNotes(notes, version)) throw new Error('候选 Release notes 缺少完整 CDN 下载区块，请先通过 release:prepare 准备候选。');
      return;
    }
    if (!['stage', 'prepare-manifests', 'activate'].includes(mode)) throw new Error('用法：publish-release-cdn.mjs validate、stage dist [安装包名]、prepare-manifests dist，或 activate dist。');
    /** OIDC 信任与运行分支一致，不能借检出 main 的文件从其他分支申请发布权限。 */
    if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('CDN 发布只能从 main 分支运行。');
    const result = await publishReleaseCdn({
      directory: resolve(path),
      configuration: releaseCdnConfiguration(),
      version: requiredVersion(process.env.RELEASE_TAG?.replace(/^v/u, '')),
      sourceCommit: process.env.RELEASE_COMMIT ?? '',
      activate: mode === 'activate',
      artifactFileName,
      requireStagedInstallers: mode === 'prepare-manifests',
    });
    console.log(`CDN ${mode} 完成：${JSON.stringify(result)}`);
  })().catch((error) => {
    /** SDK 错误可能含请求信息；输出前移除本次临时凭据。 */
    console.error(redactReleaseCommandOutput(error.message || error));
    process.exitCode = 1;
  });
}
