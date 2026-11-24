import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { findExecutable } from './commandExecution.js';

/** Google 官方 CLI 安装脚本使用的发布清单源。 */
const releaseOrigin = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app';

/** Google 官方公开的 Antigravity CLI 资产路径。 */
const artifactRoot = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/';

/** 官方独立 CLI 下载的最大字节数，限制暂存空间。 */
const maximumBinaryBytes = 512 * 1024 * 1024;

/** Zeus 仅使用自己的 agy 路径，避免与用户通过 PATH 安装的版本冲突。 */
function managedCommand(dataRoot: string): string {
  return join(dataRoot, 'antigravity', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
}

/** 按绝对路径读取已安装的 CLI，检查是否可执行。 */
export function readManagedAntigravity(dataRoot: string): string | null {
  return findExecutable(managedCommand(dataRoot));
}

/** 下载时报告实际字节数，未知总量用 null。 */
export type AntigravityInstallProgress = { stage: 'preparing' | 'verifying' | 'installing' } | { stage: 'downloading'; receivedBytes: number; totalBytes: number | null };

/** 获取官方资产并校验 SHA-512，同一磁盘上原子发布到 Zeus 的安装目录。 */
export async function installManagedAntigravity(dataRoot: string, cancellation: AbortSignal, report: (progress: AntigravityInstallProgress) => void): Promise<void> {
  if (readManagedAntigravity(dataRoot)) return;
  if (!['darwin', 'win32'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error('Antigravity 托管安装支持 macOS 和 Windows 的 x64 与 ARM64。');
  }
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(5 * 60_000)]);
  const os = process.platform === 'darwin' ? 'darwin' : 'windows';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const platformDir = `${os}-${arch === 'arm64' ? 'arm' : 'x64'}`;
  const manifestResponse = await fetchRelease(new URL(`/manifests/${os}_${arch}.json`, releaseOrigin), signal);
  const manifestChunks: Buffer[] = [];
  for await (const chunk of responseBytes(manifestResponse, 64 * 1024)) manifestChunks.push(Buffer.from(chunk));
  const manifest: unknown = JSON.parse(Buffer.concat(manifestChunks).toString('utf8'));
  if (!manifest || typeof manifest !== 'object' || !('url' in manifest) || typeof manifest.url !== 'string' || !('sha512' in manifest) || typeof manifest.sha512 !== 'string' || !/^[a-f0-9]{128}$/iu.test(manifest.sha512)) {
    throw new Error('Google Antigravity 发布清单缺少资产或校验值。');
  }
  const asset = new URL(manifest.url);
  const expectedSuffix = os === 'darwin' ? '.tar.gz' : '.exe';
  if (!asset.href.startsWith(artifactRoot) || !asset.pathname.includes(`/${platformDir}/`) || !asset.pathname.endsWith(expectedSuffix)) {
    throw new Error('Google Antigravity 发布清单中的资产地址与当前平台不匹配。');
  }

  const command = managedCommand(dataRoot);
  const directory = dirname(command);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(directory, '.install-'));
  try {
    const payload = join(staging, `download${expectedSuffix}`);
    report({ stage: 'downloading', receivedBytes: 0, totalBytes: null });
    const response = await fetchRelease(asset, signal);
    /** 自动解压的响应字节与压缩总量不兼容，无法据此计算百分比。 */
    const encoding = response.headers.get('content-encoding')?.toLowerCase();
    const contentLength = Number(response.headers.get('content-length'));
    const totalBytes = (!encoding || encoding === 'identity') && Number.isSafeInteger(contentLength) && contentLength > 0 && contentLength <= maximumBinaryBytes ? contentLength : null;
    const digest = createHash('sha512');
    /** 将原始下载字节同步计入校验，无需把整个程序读入内存。 */
    async function* hashPayload() {
      let receivedBytes = 0;
      for await (const chunk of responseBytes(response, maximumBinaryBytes)) {
        digest.update(chunk);
        yield chunk;
        receivedBytes += chunk.byteLength;
        report({ stage: 'downloading', receivedBytes, totalBytes: totalBytes !== null && receivedBytes <= totalBytes ? totalBytes : null });
      }
    }
    await pipeline(hashPayload(), createWriteStream(payload, { flags: 'wx', mode: 0o600 }), { signal });
    report({ stage: 'verifying' });
    if (digest.digest('hex') !== manifest.sha512.toLowerCase()) throw new Error('Google Antigravity 下载校验失败，请重试。');

    report({ stage: 'installing' });
    const executable = os === 'darwin' ? join(staging, 'agy') : payload;
    if (os === 'darwin') await extractMacBinary(payload, executable, signal);
    await chmod(executable, 0o700);
    signal.throwIfAborted();
    await rename(executable, command);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** 下载固定的官方 HTTPS 地址，禁止跳转到其他来源。 */
async function fetchRelease(url: URL, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, { redirect: 'error', signal }).catch((cause: unknown) => {
    if (signal.aborted) throw new Error('准备 Antigravity CLI 超时或已取消。', { cause });
    throw new Error('无法连接 Google Antigravity 发布服务。', { cause });
  });
  if (response.ok) return response;
  await response.body?.cancel();
  throw new Error(`Google Antigravity 发布服务返回 HTTP ${response.status}。`);
}

/** 按实际读取的字节限制下载大小，包括没有 Content-Length 的响应。 */
async function* responseBytes(response: Response, maximumBytes: number): AsyncGenerator<Uint8Array> {
  if (!response.body) throw new Error('Google Antigravity 下载响应为空。');
  const reader = response.body.getReader();
  let remaining = maximumBytes;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      remaining -= chunk.value.byteLength;
      if (remaining < 0) throw new Error('Google Antigravity 下载内容超过大小上限。');
      yield chunk.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** macOS 发布包只提取官方 antigravity 入口到指定文件，tar 不直接写入目录。 */
async function extractMacBinary(archive: string, target: string, signal: AbortSignal): Promise<void> {
  const child = spawn('/usr/bin/tar', ['-xOzf', archive, 'antigravity'], { stdio: ['ignore', 'pipe', 'ignore'], signal });
  const completed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('无法从 Google Antigravity 发布包解出 CLI。'));
    });
  });
  try {
    await Promise.all([pipeline(child.stdout, createWriteStream(target, { flags: 'wx', mode: 0o600 }), { signal }), completed]);
  } catch (error) {
    child.kill();
    throw error;
  }
}
