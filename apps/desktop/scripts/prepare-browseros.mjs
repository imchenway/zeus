#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { browserOsUpstream } from '../browseros/upstream.mjs';

/** 当前工作区独占的上游源码目录，不使用用户已安装 BrowserOS 的资料。 */
const workspaceRoot = resolve(import.meta.dirname, '../../..');
/** 临时源码与准备记录不进入 Zeus 的应用分发包。 */
const preparationRoot = join(workspaceRoot, '.tmp', 'browseros');
/** 保留完整上游许可和补丁的固定修订检出。 */
const sourceRoot = join(preparationRoot, 'upstream');
/** 构建准备过程不运行用户配置的 Git hooks。 */
const hooksRoot = join(preparationRoot, 'empty-hooks');
/** 互斥文件防止两个准备进程同时修改同一检出。 */
const lockPath = join(preparationRoot, 'prepare.lock');

if (process.argv.length > 2) throw new Error('prepare-browseros 不接受额外参数；上游身份由固定配置声明。');
await mkdir(hooksRoot, { recursive: true });
/** 已有锁表示另一个准备过程未结束，不能自动删除后重放。 */
const lock = await open(lockPath, 'wx');
try {
  await lock.writeFile(`${process.pid}\n`);
  await prepareSource();
} finally {
  await lock.close();
  /** 只删除当前进程成功创建的锁，不清理源码或用户文件。 */
  const { unlink } = await import('node:fs/promises');
  await unlink(lockPath);
}

/** 下载固定 BrowserOS 修订并核对来源；不构建、启动或替换现有桌面运行层。 */
async function prepareSource() {
  await mkdir(sourceRoot, { recursive: true });
  if ((await realpath(sourceRoot)) !== sourceRoot) throw new Error('BrowserOS 源码目录不能通过符号链接指向其他目录。');
  /** 非空目录必须是本脚本准备的上游 Git 检出。 */
  const entries = await readdir(sourceRoot);
  if (entries.length === 0) {
    await git(['init']);
    await git(['remote', 'add', 'origin', browserOsUpstream.repository]);
  } else if (!entries.includes('.git')) {
    throw new Error('BrowserOS 源码目录已有其他内容，已停止准备，未覆盖文件。');
  }
  /** 来源不一致时拒绝把已有仓库改造成上游检出。 */
  const remote = (await git(['remote', 'get-url', 'origin'])).trim();
  if (remote !== browserOsUpstream.repository) throw new Error('BrowserOS 源码仓库来源不一致，已停止准备。');
  /** 保留上游本地改动，不能以更新依赖为由清理或重置。 */
  const status = await git(['status', '--porcelain', '--untracked-files=all']);
  if (status.trim()) throw new Error('BrowserOS 源码存在本地改动，已停止准备，未重置或覆盖。');
  /** 首次初始化时尚无 HEAD；后续运行不隐式切换已存在的其他修订。 */
  const head = (await git(['rev-parse', '--verify', 'HEAD'], true)).trim();
  if (head && head !== browserOsUpstream.revision) throw new Error('BrowserOS 源码修订不同，请另行处理上游升级，当前目录保持原样。');
  if (!head) {
    /** 已完整下载的提交可直接检出，失败恢复不重复传输同一份源码。 */
    const downloaded = (await git(['rev-parse', '--verify', `${browserOsUpstream.revision}^{commit}`], true)).trim();
    if (downloaded !== browserOsUpstream.revision) await git(['fetch', '--depth=1', '--no-tags', 'origin', browserOsUpstream.revision]);
    await git(['checkout', '--detach', browserOsUpstream.revision]);
  }
  /** 根许可随来源保留，并以摘要记录本次实际读到的内容。 */
  const licenseBytes = await readFile(join(sourceRoot, 'LICENSE'));
  /** Chromium pin 文件比介绍页更接近实际构建输入。 */
  const versionText = await readFile(join(sourceRoot, 'packages/browseros/CHROMIUM_VERSION'), 'utf8');
  /** 逐项解析版本组成，缺项不会静默变成空版本。 */
  const version = ['MAJOR', 'MINOR', 'BUILD', 'PATCH'].map((name) => new RegExp(`^${name}=(\\d+)\\s*$`, 'm').exec(versionText)?.[1]).join('.');
  /** Chromium 基线提交必须与同一 BrowserOS 修订中的记录一致。 */
  const chromiumRevision = (await readFile(join(sourceRoot, 'packages/browseros/BASE_COMMIT'), 'utf8')).trim();
  if (version !== browserOsUpstream.chromiumVersion || chromiumRevision !== browserOsUpstream.chromiumRevision) throw new Error('BrowserOS 的 Chromium 构建身份不符合固定配置。');
  /** 记录真实准备结果，不声明宿主、扩展或 Google Sync 已可用。 */
  const manifest = {
    ...browserOsUpstream,
    sourceRoot,
    licenseSha256: createHash('sha256').update(licenseBytes).digest('hex'),
    artifactKind: 'browseros-upstream-source',
    // 大型 LFS 运行资源留在原始指针状态，不能把源码准备视为离线构建材料齐备。
    lfsResourcesMaterialized: false,
    // 子模块按后续原生构建的固定依赖阶段准备，本命令不隐式执行递归下载。
    submodulesInitialized: false,
    nativeHostBuilt: false,
    zeusUiIntegrated: false,
    googleSyncVerified: false,
  };
  await writeFile(join(preparationRoot, 'source-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`BrowserOS 固定源码已准备：${browserOsUpstream.revision}\n目录：${sourceRoot}\n此结果仅为上游源码，不是可运行的 Zeus 浏览器。`);
}

/** 使用参数数组执行 Git，不拼接 shell；只允许首次检出缺少 HEAD。 */
function git(args, allowMissingHead = false) {
  return new Promise((resolveResult, reject) => {
    /** Git 输出限制在源码准备范围，不传入账号、密钥或浏览器资料。 */
    const child = spawn('git', ['-c', `core.hooksPath=${hooksRoot}`, '-c', 'core.autocrlf=false', '-c', 'filter.lfs.required=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', ...args], {
      cwd: sourceRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // 源码下载最多等待十五分钟，失败后保留现场，不自动重复检出。
      timeout: 15 * 60_000,
    });
    /** Git 元数据输出，用于核对来源、状态与修订。 */
    let output = '';
    /** 错误输出保留末段，避免下载进度无限占用内存。 */
    let errorOutput = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${String(chunk)}`.slice(-8000);
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolveResult(output);
      else if (allowMissingHead && code === 128) resolveResult('');
      else reject(new Error(`Git ${args[0]} 失败（${code}）：${errorOutput.trim()}`));
    });
  });
}
