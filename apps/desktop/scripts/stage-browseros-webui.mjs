#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { browserOsUpstream } from '../browseros/upstream.mjs';
import { webUiOverlayInputs } from '../browseros/webui-overlay.mjs';

/** 所有输入从脚本所在项目定位，支持 Windows 和 macOS 路径。 */
const desktopRoot = resolve(import.meta.dirname, '..');
/** 固定上游的缓存位于工作区内，不读取用户浏览器资料。 */
const repositoryRoot = resolve(desktopRoot, '../..');
/** 已准备的 BrowserOS 源码，提供固定补丁。 */
const upstreamRoot = join(repositoryRoot, '.tmp/browseros/upstream');
/** 只缓存固定修订且摘要匹配的 Chromium 原始文件。 */
const cacheRoot = join(repositoryRoot, '.tmp/browseros/chromium-api');
/** 当前 Zeus 界面的独立构建产物。 */
const uiRoot = join(desktopRoot, 'dist/chromium-ui');
/** 可供原生源码接入的覆盖文件包；不属于可运行安装包。 */
const outputRoot = join(desktopRoot, 'dist/browseros-webui');
/** C++ 文件在 Chromium 源码树内的固定地址。 */
const nativePrefix = 'chrome/browser/ui/webui/zeus';

/** 计算实际字节的 SHA-256，不依赖文件时间或 Git 工作区状态。 */
function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 只允许普通相对路径，不接受跨目录路径或 Windows 盘符。 */
function checkPath(path) {
  if (!/^[A-Za-z0-9_./-]+$/u.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`无效的覆盖文件路径：${path}`);
  }
}

/** 资源来源必须是普通文件，防止符号链接绕过产物目录。 */
async function readRegular(root, path) {
  checkPath(path);
  /** 沿每一级目录检查，拒绝链接到工作区之外的资源。 */
  let current = root;
  for (const part of path.split('/')) {
    current = join(current, part);
    /** lstat 不跟随符号链接。 */
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`资源路径含符号链接：${path}`);
  }
  if (!(await lstat(current)).isFile()) throw new Error(`资源不是普通文件：${path}`);
  return readFile(current);
}

/** 官方固定源码下载后按预登记摘要核验；缓存不能改变输入身份。 */
async function readChromiumBase(input) {
  /** 缓存缺失才下载，不覆盖摘要不符的已有缓存。 */
  let bytes;
  try {
    bytes = await readRegular(cacheRoot, input.path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    /** 下载只访问已固定修订的官方源码地址。 */
    const response = await fetch(`https://chromium.googlesource.com/chromium/src/+/${browserOsUpstream.chromiumRevision}/${input.path}?format=TEXT`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Chromium 源码下载失败：${response.status} ${input.path}`);
    bytes = Buffer.from(await response.text(), 'base64');
    if (digest(bytes) !== input.baseSha256) throw new Error(`Chromium 下载摘要不符：${input.path}`);
    await mkdir(dirname(join(cacheRoot, input.path)), { recursive: true });
    await writeFile(join(cacheRoot, input.path), bytes, { flag: 'wx' });
  }
  if (digest(bytes) !== input.baseSha256) throw new Error(`Chromium 缓存摘要不符：${input.path}`);
  return bytes;
}

if (process.argv.length !== 2) throw new Error('此命令不接受参数；请先执行 prepare:browseros 与 build:chromium-ui。');
/** 上游 Git 身份必须与界面资源使用的固定修订一致。 */
const upstreamRevision = execFileSync('git', ['-C', upstreamRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
if (upstreamRevision !== browserOsUpstream.revision) throw new Error('BrowserOS 源码修订与目标不一致。');
/** 上游身份也记录在 UI 产物内，拒绝把旧 UI 拼入新的原生源码。 */
const uiUpstream = JSON.parse(await readRegular(uiRoot, 'browseros-upstream.json'));
if (JSON.stringify(uiUpstream) !== JSON.stringify(browserOsUpstream)) throw new Error('Zeus 界面产物对应另一上游，请重新构建。');
/** 资源与原生头分别纳入完整性校验。 */
const resourceManifest = JSON.parse(await readRegular(uiRoot, 'resource-manifest.json'));
if (resourceManifest.artifactKind !== 'chromium-webui-resources' || !Array.isArray(resourceManifest.nativeFiles)) {
  throw new Error('界面资源缺少原生构建元数据，请重新构建。');
}
await mkdir(dirname(outputRoot), { recursive: true });
/** 私有临时目录避免修改已准备的 BrowserOS 仓库或用户的 Chromium checkout。 */
const stagingRoot = await mkdtemp(join(dirname(outputRoot), 'browseros-webui-staging-'));
/** 单一构建锁避免并发替换同一个产物目录。 */
const lockPath = `${outputRoot}.lock`;
/** 仅取得锁的进程负责释放它。 */
let ownsLock = false;
try {
  await writeFile(lockPath, `${process.pid}\n`, { flag: 'wx' });
  ownsLock = true;
  /** 每个输出文件记录当前摘要；已有源码另记录 BrowserOS 修改后的前置摘要。 */
  const files = [];
  // Git apply 仅在独立临时仓库中执行，避免向 Zeus 当前工作树应用补丁。
  execFileSync('git', ['-c', 'init.templateDir=', 'init', '--quiet', stagingRoot]);
  for (const input of webUiOverlayInputs) {
    /** Chromium 原文和 BrowserOS 补丁均经过固定摘要约束。 */
    const base = await readChromiumBase(input);
    /** 补丁读取严格受限于当前上游的固定目录。 */
    const patch = await readRegular(upstreamRoot, `packages/browseros/chromium_patches/${input.path}`);
    if (digest(patch) !== input.patchSha256) throw new Error(`BrowserOS 补丁摘要不符：${input.path}`);
    await mkdir(dirname(join(stagingRoot, input.path)), { recursive: true });
    await writeFile(join(stagingRoot, input.path), base);
    execFileSync('git', ['-C', stagingRoot, 'apply', '--whitespace=nowarn', '-'], { input: patch });
    /** 应用 Zeus 之前必须保留 BrowserOS 已有修改。 */
    const before = await readFile(join(stagingRoot, input.path));
    /** 只插入已核对的唯一锚点，不用模糊匹配或全局替换。 */
    let source = before.toString('utf8');
    for (const [anchor, addition] of input.additions) {
      if (source.split(anchor).length !== 2) throw new Error(`构建接线锚点不唯一：${input.path}`);
      source = source.replace(anchor, `${anchor}${addition}`);
    }
    await writeFile(join(stagingRoot, input.path), source);
    files.push({ path: input.path, beforeSha256: digest(before), sha256: digest(source), byteLength: Buffer.byteLength(source) });
  }
  /** 统一写入并登记新原生文件和静态资源，拒绝重复目的路径。 */
  async function addFile(path, bytes) {
    checkPath(path);
    if (files.some((file) => file.path === path)) throw new Error(`重复的覆盖文件：${path}`);
    await mkdir(dirname(join(stagingRoot, path)), { recursive: true });
    await writeFile(join(stagingRoot, path), bytes, { flag: 'wx' });
    files.push({ path, beforeSha256: null, sha256: digest(bytes), byteLength: bytes.length });
  }
  for (const path of (await readdir(join(desktopRoot, 'browseros/native'))).sort()) {
    await addFile(`${nativePrefix}/${path}`, await readRegular(join(desktopRoot, 'browseros/native'), path));
  }
  for (const resource of [...resourceManifest.resources, ...resourceManifest.nativeFiles]) {
    /** 每个复制资源都重新检查实际内容，不能只信任清单。 */
    const bytes = await readRegular(uiRoot, resource.path);
    if (digest(bytes) !== resource.sha256 || bytes.length !== resource.byteLength) throw new Error(`界面资源摘要不符：${resource.path}`);
    await addFile(`${nativePrefix}/resources/${resource.path}`, bytes);
  }
  await rm(join(stagingRoot, '.git'), { recursive: true, force: true });
  /** 清单明确区分源文件覆盖包与已编译、已接通的桌面应用。 */
  const manifest = {
    artifactKind: 'browseros-webui-source-overlay',
    upstream: browserOsUpstream,
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')),
    nativeHostBuilt: false,
    desktopServicesBound: false,
    googleSyncVerified: false,
  };
  await writeFile(join(stagingRoot, 'overlay-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await rm(outputRoot, { recursive: true, force: true });
  await rename(stagingRoot, outputRoot);
  console.log(`已生成 BrowserOS WebUI 源码覆盖包：${files.length} 个文件；原生编译与桌面服务连接尚未完成。`);
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
  if (ownsLock) await rm(lockPath, { force: true });
}
