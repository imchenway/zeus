#!/usr/bin/env node
/* global console */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { downloadArtifactFromSource, downloadVerifiedArtifact, fetchDesktopReleaseManifest } from '../apps/desktop/src/main/releaseUpdateService.ts';
import { caskMatchesRelease, prefetchHomebrewCdnArtifact } from '../apps/desktop/src/main/homebrewUpdateService.ts';
import { isTrustedReleaseResponseUrl, parseReleaseUpdateManifest, readReleaseUpdateStatus, releaseArtifactDownloadUrls, releaseDownloadBaseUrl, releaseUpdateManifestUrls } from '../packages/local-server/src/releaseCore.ts';
import { renderReleaseManifest } from './generate-release-manifest.mjs';
import { publishReleaseCdn, releaseCdnConfiguration } from './publish-release-cdn.mjs';
import { cdnReleaseManifest, releaseCdnBaseUrl, renderCdnReleaseNotes, sha256Text, verifyPublicCdnManifest } from './release-script-utils.mjs';

/** 所有制品、网络和 OSS 操作均隔离在临时目录及内存，不连接真实发布服务。 */
const directory = await mkdtemp(join(tmpdir(), 'zeus-release-cdn-check-'));
/** 固定候选身份用于检测跨版本、跨提交的清单混用。 */
const version = '1.2.3';
const sourceCommit = 'a'.repeat(40);
/** 与阿里云分支信任及目录约束同形的非敏感配置。 */
const configuration = releaseCdnConfiguration({
  ALIYUN_OIDC_PROVIDER_ARN: 'acs:ram::1234567890123456:oidc-provider/github-actions',
  ALIYUN_ROLE_ARN: 'acs:ram::1234567890123456:role/zeus-release-uploader',
  ZEUS_OSS_BUCKET: 'imchenway-zeus',
  ZEUS_OSS_REGION: 'cn-hangzhou',
  ZEUS_DOWNLOAD_BASE_URL: releaseCdnBaseUrl,
});

/** 使用真实文件字节计算摘要，便于检测完整性错误而不依赖字符串匹配源码。 */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 这里仅模拟工具返回的 64 位校验值，验证双方对账规则；不重新实现 CRC64 算法。 */
function remoteChecksum(bytes) {
  return BigInt(`0x${digest(bytes).slice(0, 16)}`).toString();
}

/** 生成三个小型制品及实际格式的双平台清单。 */
async function prepareCandidate(candidateVersion = version) {
  const manifests = {};
  for (const platform of ['darwin', 'win32']) {
    const artifacts = [];
    for (const arch of platform === 'win32' ? ['x64', 'arm64'] : ['arm64']) {
      const fileName = `Zeus-${candidateVersion}${platform === 'win32' ? '-win32' : ''}-${arch}.${platform === 'win32' ? 'exe' : 'dmg'}`;
      const bytes = Buffer.from(`isolated-release-${candidateVersion}-${platform}-${arch}`);
      await writeFile(join(directory, fileName), bytes);
      artifacts.push({
        arch,
        platform,
        kind: platform === 'win32' ? 'exe' : 'dmg',
        fileName,
        sha256: digest(bytes),
        sizeBytes: bytes.length,
        downloadUrl: `https://github.com/imchenway/zeus/releases/download/v${candidateVersion}/${fileName}`,
      });
    }
    const manifest = JSON.parse(renderReleaseManifest({ version: candidateVersion, platform, sourceCommit, artifacts, publishedAt: '2026-11-11T00:00:00.000Z', signed: false, notarized: false }));
    await writeFile(join(directory, platform === 'win32' ? 'zeus-release-manifest-win32.json' : 'zeus-release-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    manifests[platform] = manifest;
  }
  return manifests;
}

/** 最小 OSS/HTTP 协议替身：执行真实发布函数，但不会调用外部工具或网络。 */
function isolatedDistribution() {
  const objects = new Map();
  const writes = [];
  const state = { githubVersion: version, failKey: '', corruptKey: '', denyHead: false, unavailable: false };
  return { objects, writes, state, execute, request };

  /** 模拟固定版本 ossutil 的 Header JSON 和 cp 行为，保留每一次写入顺序。 */
  function execute(command, args) {
    if (command === 'gh') return `v${state.githubVersion}\n`;
    assert.equal(command, 'ossutil');
    assert.equal(args.includes('--access-key-secret'), false);
    if (args[0] === 'hash') return `${remoteChecksum(readFileSync(args[2]))}  ${args[2]}\n`;
    if (args[0] === 'api') {
      const key = args[args.indexOf('--key') + 1];
      if (state.denyHead) throw Object.assign(new Error('Permission denied'), { stderr: 'Error Code: AccessDenied.' });
      const object = objects.get(key);
      if (!object) throw Object.assign(new Error('Object absent'), { stderr: 'Error Code: NoSuchKey.' });
      return JSON.stringify({
        Header: { 'Content-Length': [String(object.bytes.length)], 'X-Oss-Meta-Sha256': [object.sha256], 'X-Oss-Meta-Source-Commit': [sourceCommit], 'X-Oss-Hash-Crc64ecma': [key === state.corruptKey ? '0' : remoteChecksum(object.bytes)] },
      });
    }
    assert.equal(args[0], 'cp');
    if (args[1].startsWith('oss://')) {
      writeFileSync(args[2], objects.get(new URL(args[1]).pathname.slice(1)).bytes);
      return '';
    }
    const key = new URL(args[2]).pathname.slice(1);
    if (key === state.failKey) throw new Error('Isolated upload interrupted');
    if (objects.has(key) && args.includes('--ignore-existing')) return '';
    const bytes = readFileSync(args[1]);
    const sha256 = args.find((value) => value.startsWith('sha256='))?.slice('sha256='.length);
    objects.set(key, { bytes, sha256 });
    writes.push(key);
    return '';
  }

  /** HEAD 检查可达性，GET 返回实际存储的清单字节。 */
  async function request(url, init = {}) {
    assert.equal(new URL(url).origin, new URL(releaseCdnBaseUrl).origin);
    const object = objects.get(decodeURIComponent(new URL(url).pathname.slice(1)));
    if (state.unavailable || !object) return new Response(null, { status: 404 });
    return new Response(init.method === 'HEAD' ? null : object.bytes, { headers: { 'content-length': String(object.bytes.length), 'x-oss-meta-sha256': object.sha256 } });
  }
}

try {
  /** 两处独立运行边界必须使用同一官方地址。 */
  assert.equal(releaseDownloadBaseUrl, releaseCdnBaseUrl);
  assert.throws(() => releaseCdnConfiguration({}), /配置缺失/u);
  assert.equal(isTrustedReleaseResponseUrl(new URL(`${releaseCdnBaseUrl}/updates/zeus-release-manifest.json`)), true);
  for (const url of [
    'https://zeus-download.hyphatech.cn.evil.example/zeus/releases/a',
    'https://user:secret@zeus-download.hyphatech.cn/zeus/updates/a',
    'http://zeus-download.hyphatech.cn/zeus/updates/a',
    'https://zeus-download.hyphatech.cn:8443/zeus/updates/a',
    'https://zeus-download.hyphatech.cn/private/a',
  ])
    assert.equal(isTrustedReleaseResponseUrl(new URL(url)), false);
  /** 双平台清单保持 GitHub 地址，独立 CDN 清单才能使用加速地址。 */
  const manifests = await prepareCandidate();
  const manifest = manifests.darwin;
  const cdnManifest = cdnReleaseManifest(manifest);
  assert.equal(parseReleaseUpdateManifest(manifest).artifacts[0].downloadUrl, manifest.artifacts[0].downloadUrl);
  assert.equal(parseReleaseUpdateManifest(cdnManifest).artifacts[0].downloadUrl, cdnManifest.artifacts[0].downloadUrl);
  assert.throws(() => parseReleaseUpdateManifest({ ...cdnManifest, artifacts: [{ ...cdnManifest.artifacts[0], downloadUrl: `${releaseCdnBaseUrl}/releases/9.9.9/${cdnManifest.artifacts[0].fileName}` }] }));
  /** 正常检查只访问 CDN，Windows 请求自己的独立清单。 */
  const calls = [];
  let update = await readReleaseUpdateStatus({
    currentVersion: '1.2.2',
    platform: 'win32',
    platformArch: 'x64',
    request: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(cdnReleaseManifest(manifests.win32)));
    },
  });
  assert.equal(update.status, 'available');
  assert.deepEqual(calls.splice(0), [releaseUpdateManifestUrls('win32')[0]]);
  /** 网络故障允许回退；内容错误或跨域跳转不能借备用源绕过。 */
  update = await readReleaseUpdateStatus({
    currentVersion: '1.2.2',
    platform: 'darwin',
    platformArch: 'arm64',
    request: async (url) => {
      calls.push(url);
      if (url.startsWith(releaseCdnBaseUrl)) throw new TypeError('Isolated network failure');
      return new Response(JSON.stringify(manifest));
    },
  });
  assert.equal(update.status, 'available');
  assert.deepEqual(calls.splice(0), releaseUpdateManifestUrls('darwin'));
  /** OSS 首次尚无稳定指针时，CDN 的 404 也必须回退到已有 GitHub 正式清单。 */
  update = await readReleaseUpdateStatus({
    currentVersion: '1.2.2',
    platform: 'darwin',
    platformArch: 'arm64',
    request: async (url) => {
      calls.push(url);
      return url.startsWith(releaseCdnBaseUrl) ? new Response(null, { status: 404 }) : new Response(JSON.stringify(manifest));
    },
  });
  assert.equal(update.status, 'available');
  assert.deepEqual(calls.splice(0), releaseUpdateManifestUrls('darwin'));
  update = await readReleaseUpdateStatus({
    currentVersion: '1.2.2',
    platform: 'darwin',
    platformArch: 'arm64',
    request: async (url) => {
      calls.push(url);
      return new Response('not-json');
    },
  });
  assert.equal(update.status, 'unavailable');
  assert.equal(calls.splice(0).length, 1);
  update = await readReleaseUpdateStatus({
    currentVersion: '1.2.2',
    platform: 'darwin',
    platformArch: 'arm64',
    request: async (url) => {
      calls.push(url);
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/manifest.json' } });
    },
  });
  assert.equal(update.status, 'unavailable');
  assert.equal(calls.splice(0).length, 1);
  /** GitHub 的合法资产重定向仍能完成旧来源读取。 */
  update = await readReleaseUpdateStatus({
    currentVersion: '1.2.2',
    manifestUrl: releaseUpdateManifestUrls('darwin')[1],
    platform: 'darwin',
    platformArch: 'arm64',
    request: async (url) =>
      url.includes('github.com/') ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/known/manifest.json?signature=sample' } }) : new Response(JSON.stringify(manifest)),
  });
  assert.equal(update.status, 'available');

  /** 原生 Chromium manual 通过 redirect 事件返回跳转，不能依赖 net.fetch 的 Response。 */
  let redirectTarget = 'https://release-assets.githubusercontent.com/known/manifest.json?signature=isolated';
  const chromiumCalls = [];
  const chromiumRequest = ({ url, redirect }) => {
    assert.equal(redirect, 'manual');
    chromiumCalls.push(url);
    const pending = new EventEmitter();
    let aborted = false;
    pending.setHeader = () => {};
    pending.abort = () => {
      if (aborted) return;
      aborted = true;
      pending.emit('close');
    };
    pending.end = () => {
      if (url.includes('github.com/')) {
        pending.emit('redirect', 302, 'GET', redirectTarget);
        if (!aborted) pending.emit('error', new Error('Redirect was cancelled'));
      } else {
        const body = Readable.from([Buffer.from(JSON.stringify(manifest))]);
        body.statusCode = 200;
        pending.emit('response', body);
      }
    };
    return pending;
  };
  const chromiumInput = { currentVersion: '1.2.2', manifestUrl: releaseUpdateManifestUrls('darwin')[1], platform: 'darwin', platformArch: 'arm64', request: (url, init) => fetchDesktopReleaseManifest(url, init, chromiumRequest) };
  assert.equal((await readReleaseUpdateStatus(chromiumInput)).status, 'available');
  assert.deepEqual(chromiumCalls.splice(0), [chromiumInput.manifestUrl, redirectTarget]);
  redirectTarget = 'https://evil.example/manifest.json';
  assert.equal((await readReleaseUpdateStatus(chromiumInput)).status, 'unavailable');
  assert.deepEqual(chromiumCalls.splice(0), [chromiumInput.manifestUrl]);

  /** 下载使用真实流和文件校验，只有传输失败才重新请求同版本备用文件。 */
  const artifact = manifest.artifacts[0];
  const bytes = await readFile(join(directory, artifact.fileName));
  /** 目标 basename 是正式文件名，独立目录用于保留原始候选。 */
  const downloadDirectory = await mkdtemp(join(directory, 'download-'));
  const download = {
    version,
    fileName: artifact.fileName,
    url: cdnManifest.artifacts[0].downloadUrl,
    targetPath: join(downloadDirectory, artifact.fileName),
    expectedSha256: artifact.sha256,
    expectedSizeBytes: bytes.length,
    testMode: false,
  };
  await downloadVerifiedArtifact(download, async (url) => {
    calls.push(url.href);
    if (url.hostname !== 'github.com') throw new TypeError('Isolated CDN interruption');
    return Readable.from([bytes]);
  });
  assert.deepEqual(calls.splice(0), releaseArtifactDownloadUrls(version, artifact.fileName));
  assert.deepEqual(await readFile(download.targetPath), bytes);
  await rm(download.targetPath);
  await assert.rejects(
    () =>
      downloadVerifiedArtifact(download, async (url) => {
        calls.push(url.href);
        return Readable.from([Buffer.alloc(bytes.length)]);
      }),
    /摘要或大小/u,
  );
  assert.equal(calls.splice(0).length, 1);
  assert.deepEqual(await readdir(downloadDirectory), []);
  /** 中途断开的源必须清除 partial 文件，再从备用源完整重下。 */
  await downloadVerifiedArtifact(download, async (url) => {
    calls.push(url.href);
    if (url.hostname === 'github.com') return Readable.from([bytes]);
    return Readable.from(
      (async function* () {
        yield bytes.subarray(0, 2);
        throw Object.assign(new Error('stream interrupted'), { code: 'ECONNRESET' });
      })(),
    );
  });
  assert.equal(calls.splice(0).length, 2);
  assert.deepEqual(await readdir(downloadDirectory), [artifact.fileName]);
  assert.deepEqual(await readFile(download.targetPath), bytes);
  assert.throws(() => releaseArtifactDownloadUrls(version, '../outside.exe'));

  /** Homebrew 的 GitHub Cask 与 CDN 清单按同版摘要匹配，预填其带哈希前缀的原生缓存名。 */
  const brewUpdate = { latestVersion: version, artifact: cdnManifest.artifacts[0] };
  const cask = { version, sha256: artifact.sha256, url: artifact.downloadUrl };
  assert.equal(caskMatchesRelease(cask, brewUpdate), true);
  assert.equal(caskMatchesRelease({ ...cask, version: '1.2.2' }, brewUpdate), false);
  assert.equal(caskMatchesRelease({ ...cask, sha256: '0'.repeat(64) }, brewUpdate), false);
  assert.equal(caskMatchesRelease({ ...cask, url: 'https://evil.example/package.dmg' }, brewUpdate), false);
  const cachePath = join(downloadDirectory, 'homebrew', `url-hash--${artifact.fileName}`);
  const recoveryPolicy = { stallWindowMs: 30_000, minimumBytesPerSecond: 16 * 1024, minimumRemainingBytes: 8 * 1024 * 1024 };
  let reconnect;
  const setReconnect = (handler) => {
    reconnect = handler;
  };
  assert.equal(
    await prefetchHomebrewCdnArtifact(
      brewUpdate,
      cachePath,
      () => {},
      recoveryPolicy,
      setReconnect,
      (input) =>
        downloadArtifactFromSource(input, async (url) => {
          assert.equal(url.href, cdnManifest.artifacts[0].downloadUrl);
          return Readable.from([bytes]);
        }),
    ),
    true,
  );
  assert.deepEqual(await readFile(cachePath), bytes);
  assert.equal(reconnect, null);
  await rm(cachePath);
  /** CDN 网络失败交给 brew fetch；篡改和大小不符不触发原生下载。 */
  assert.equal(
    await prefetchHomebrewCdnArtifact(
      brewUpdate,
      cachePath,
      () => {},
      recoveryPolicy,
      setReconnect,
      (input) =>
        downloadArtifactFromSource(input, async () => {
          throw new TypeError('Isolated CDN unavailable');
        }),
    ),
    false,
  );
  await assert.rejects(
    () =>
      prefetchHomebrewCdnArtifact(
        brewUpdate,
        cachePath,
        () => {},
        recoveryPolicy,
        setReconnect,
        (input) => downloadArtifactFromSource(input, async () => Readable.from([Buffer.alloc(bytes.length)])),
      ),
    /摘要或大小/u,
  );
  /** 手动重连必须取消 CDN 流，清理 partial，并恢复原生 Homebrew 下载入口。 */
  assert.equal(
    await prefetchHomebrewCdnArtifact(
      brewUpdate,
      cachePath,
      () => {},
      recoveryPolicy,
      setReconnect,
      (input) =>
        downloadArtifactFromSource(input, async (_url, _testMode, signal) => {
          assert.equal(reconnect(), true);
          signal.throwIfAborted();
        }),
    ),
    false,
  );
  assert.equal(reconnect, null);
  assert.deepEqual(await readdir(join(downloadDirectory, 'homebrew')), []);

  /** 发布必须先准备全部固定版本文件，不提前改动 latest；重复执行不得覆盖历史制品。 */
  const distribution = isolatedDistribution();
  const publication = { directory, configuration, version, sourceCommit };
  const staged = await publishReleaseCdn(publication, distribution.execute, distribution.request);
  assert.equal(staged.files, 5);
  assert.equal(
    distribution.writes.some((key) => key.startsWith('zeus/updates/')),
    false,
  );
  await verifyPublicCdnManifest(manifest, 'zeus-release-manifest.json', distribution.request);
  await assert.rejects(() => verifyPublicCdnManifest(manifest, 'zeus-release-manifest.json', distribution.request, true), /不可用/u);
  const activated = await publishReleaseCdn({ ...publication, activate: true }, distribution.execute, distribution.request);
  assert.deepEqual(activated.activated, ['darwin', 'win32']);
  await verifyPublicCdnManifest(manifest, 'zeus-release-manifest.json', distribution.request, true);
  const writes = distribution.writes.length;
  await publishReleaseCdn(publication, distribution.execute, distribution.request);
  await publishReleaseCdn({ ...publication, activate: true }, distribution.execute, distribution.request);
  assert.equal(distribution.writes.length, writes);
  assert.equal(JSON.parse(await readFile(join(directory, 'zeus-release-manifest.json'), 'utf8')).artifacts[0].downloadUrl, artifact.downloadUrl);
  /** 旧版本补发不会覆盖已有较新的稳定指针。 */
  distribution.state.githubVersion = '1.10.0';
  assert.deepEqual((await publishReleaseCdn({ ...publication, activate: true }, distribution.execute, distribution.request)).activated, []);
  assert.equal(distribution.writes.length, writes);
  /** 任一安装包上传失败，两个现有稳定清单都保持原来的字节。 */
  const previous = [...distribution.objects].filter(([key]) => key.startsWith('zeus/updates/')).map(([key, object]) => [key, digest(object.bytes)]);
  const nextManifests = await prepareCandidate('1.2.4');
  distribution.state.failKey = 'zeus/releases/1.2.4/Zeus-1.2.4-win32-arm64.exe';
  await assert.rejects(() => publishReleaseCdn({ ...publication, version: '1.2.4' }, distribution.execute, distribution.request), /upload interrupted/u);
  assert.deepEqual(
    [...distribution.objects].filter(([key]) => key.startsWith('zeus/updates/')).map(([key, object]) => [key, digest(object.bytes)]),
    previous,
  );
  await assert.rejects(() => verifyPublicCdnManifest(nextManifests.darwin, 'zeus-release-manifest.json', distribution.request, true), /候选不一致/u);
  /** 权限故障不能当作不存在后创建或覆盖对象。 */
  distribution.state.denyHead = true;
  const previousWrites = distribution.writes.length;
  await assert.rejects(() => publishReleaseCdn({ ...publication, version: '1.2.4' }, distribution.execute, distribution.request), /Permission denied/u);
  assert.equal(distribution.writes.length, previousWrites);
  distribution.state.denyHead = false;
  distribution.state.failKey = '';
  distribution.state.corruptKey = 'zeus/releases/1.2.4/Zeus-1.2.4-arm64.dmg';
  await assert.rejects(() => publishReleaseCdn({ ...publication, version: '1.2.4' }, distribution.execute, distribution.request), /已存制品与固定候选不一致/u);
  /** CDN 链接正文可重跑且不会改变说明的其他内容。 */
  const notes = `# Zeus ${version} 更新内容\n\n原有发布说明\n`;
  const rendered = renderCdnReleaseNotes(notes, version);
  assert.equal(renderCdnReleaseNotes(rendered, version), rendered);
  assert.equal(rendered.includes('原有发布说明'), true);
  assert.equal((rendered.match(/https:\/\/zeus-download\.hyphatech\.cn/gu) ?? []).length, 3);
  assert.equal(sha256Text(rendered) === sha256Text(notes), false);
  /** CI 预检读取候选正文：未固定下载链接时拒绝，在生成公开 Release 前阻断。 */
  await mkdir(join(directory, 'releases'));
  const candidateNotesPath = join(directory, 'releases', `v${version}.md`);
  const validationScript = fileURLToPath(new URL('./publish-release-cdn.mjs', import.meta.url));
  const validationEnvironment = {
    ...process.env,
    RELEASE_TAG: `v${version}`,
    ALIYUN_OIDC_PROVIDER_ARN: 'acs:ram::1234567890123456:oidc-provider/github-actions',
    ALIYUN_ROLE_ARN: 'acs:ram::1234567890123456:role/zeus-release-uploader',
    ZEUS_OSS_BUCKET: configuration.bucket,
    ZEUS_OSS_REGION: configuration.region,
    ZEUS_DOWNLOAD_BASE_URL: configuration.baseUrl,
  };
  await writeFile(candidateNotesPath, notes);
  assert.throws(() => execFileSync(process.execPath, [validationScript, 'validate'], { cwd: directory, env: validationEnvironment, stdio: 'pipe' }), /缺少完整 CDN 下载区块/u);
  await writeFile(candidateNotesPath, rendered);
  execFileSync(process.execPath, [validationScript, 'validate'], { cwd: directory, env: validationEnvironment, stdio: 'pipe' });
  console.log('CDN 更新、完整性、双源回退、OSS 发布顺序与 Release 下载链接验证通过。');
} finally {
  await rm(directory, { recursive: true, force: true });
}
