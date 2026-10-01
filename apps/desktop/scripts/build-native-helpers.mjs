#!/usr/bin/env node
/* global process */
import { access, chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256File } from '../../../scripts/release-script-utils.mjs';

/** 桌面应用构建根目录。 */
const desktopRoot = resolve(import.meta.dirname, '..');
/** 原生辅助程序统一随当前构建输出。 */
const outputDirectory = resolve(desktopRoot, 'dist/native');
/** Swift 编译目标与当前 Node 架构保持一致。 */
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';

if (process.platform !== 'darwin') {
  throw new Error('Zeus 原生辅助程序只能在 macOS 上构建。');
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await compileSwift({
  source: resolve(desktopRoot, 'native/UpdateProgressPanel.swift'),
  output: resolve(outputDirectory, 'ZeusUpdateProgress'),
  frameworks: ['AppKit'],
});

await compileSwift({
  source: resolve(desktopRoot, 'native/BrowserNativeMessagingHost.swift'),
  output: resolve(outputDirectory, 'ZeusBrowserNativeHost'),
  frameworks: [],
});
await chmod(resolve(outputDirectory, 'ZeusBrowserNativeHost'), 0o755);

/** CUA 私有 worker 提供原生光标浮层；同进程 TypeScript SDK 不具备此能力。 */
await prepareComputerWorker();

/** SDK 保持官方 ABI，仅对固定发布源码补齐桌面保护与多屏浮层。 */
async function prepareComputerWorker() {
  /** 源码来自对应官方发布提交，升级 SDK 时必须同步核对。 */
  const version = '0.30.4';
  /** 完整提交防止标签移动或混入上游新协议。 */
  const revision = 'bf6c76786d938070f4ecf1e44004752f69f518b8';
  /** 桌面依赖是唯一 SDK 版本来源。 */
  const manifest = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'));
  if (manifest.dependencies['@trycua/cua-driver'] !== version) throw new Error('CUA SDK 已变更，请同步核对私有 worker 源码与补丁。');
  /** 补丁作为应用源码审查，不依赖用户机器上的临时修改。 */
  const patch = resolve(desktopRoot, 'native/cua-desktop.patch');
  /** 补丁和架构变化才需要重新编译原生 worker。 */
  const fingerprint = `${revision}-${process.arch}-${await sha256File(patch)}`;
  /** 所有源码和编译缓存都属于当前工作树。 */
  const cacheRoot = resolve(desktopRoot, '../../.tmp');
  /** 官方源码缓存保持原始提交，不把补丁覆盖到共享源码。 */
  const repository = resolve(cacheRoot, `cua-driver-source-${revision}`);
  /** 每份补丁有独立构建目录，避免误用旧原生程序。 */
  const buildRoot = resolve(cacheRoot, `cua-worker-${fingerprint}`);
  /** 完成后才写入的可复用构建凭证。 */
  const receipt = resolve(buildRoot, 'worker.sha256');
  /** 原生可执行程序缓存。 */
  const cachedBinary = resolve(buildRoot, 'cua-driver');
  /** 子命令使用独立参数，不经过 shell。 */
  const run = promisify(execFile);
  await mkdir(cacheRoot, { recursive: true });
  /** 仅使用已完成且摘要匹配的缓存。 */
  let cached = false;
  try {
    cached = (await readFile(receipt, 'utf8')).trim() === (await sha256File(cachedBinary));
  } catch {
    /* 首次构建或中断缓存重新生成。 */
  }
  if (!cached) {
    try {
      await access(resolve(repository, '.git'));
    } catch {
      await run('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', `cua-driver-rs-v${version}`, 'https://github.com/trycua/cua.git', repository]);
    }
    if ((await run('git', ['-C', repository, 'rev-parse', 'HEAD'])).stdout.trim() !== revision) throw new Error('CUA 发布源码提交不匹配。');
    // 稀疏检出集中获取 Rust 目录，避免 archive 为每个缺失对象单独联网。
    await run('git', ['-C', repository, 'sparse-checkout', 'set', '--cone', 'libs/cua-driver/rust']);
    await run('git', ['-C', repository, 'checkout', '--detach', revision]);
    await rm(buildRoot, { recursive: true, force: true });
    await mkdir(buildRoot, { recursive: true });
    /** 稀疏目录必须与固定提交一致，拒绝复用被手工修改的缓存。 */
    await run('git', ['-C', repository, 'diff', '--quiet', revision, '--', 'libs/cua-driver/rust']);
    if ((await run('git', ['-C', repository, 'ls-files', '--others', '--', 'libs/cua-driver/rust'])).stdout.trim()) throw new Error('CUA 源码缓存含未跟踪文件，不能用于原生构建。');
    await cp(resolve(repository, 'libs/cua-driver/rust'), buildRoot, { recursive: true });
    await run('git', ['apply', '--check', patch], { cwd: buildRoot, env: { ...process.env, GIT_CEILING_DIRECTORIES: cacheRoot } });
    await run('git', ['apply', patch], { cwd: buildRoot, env: { ...process.env, GIT_CEILING_DIRECTORIES: cacheRoot } });
    /** 同架构复用 Cargo 依赖编译结果，锁文件禁止依赖漂移。 */
    const targetDirectory = resolve(cacheRoot, `cua-driver-target-${process.arch}`);
    await new Promise((resolveBuild, rejectBuild) => {
      /** 原生编译日志由外层正常构建日志接收。 */
      const child = spawn('cargo', ['build', '--release', '--locked', '-p', 'cua-driver', '--bin', 'cua-driver'], { cwd: buildRoot, env: { ...process.env, CARGO_TARGET_DIR: targetDirectory }, stdio: 'inherit' });
      child.once('error', rejectBuild);
      child.once('exit', (code) => (code === 0 ? resolveBuild() : rejectBuild(new Error(`CUA 原生源码构建失败：code=${code}`))));
    });
    await copyFile(resolve(targetDirectory, 'release/cua-driver'), cachedBinary);
    await writeFile(receipt, `${await sha256File(cachedBinary)}\n`);
  }
  await copyFile(cachedBinary, resolve(outputDirectory, 'cua-driver'));
  await chmod(resolve(outputDirectory, 'cua-driver'), 0o755);
  // 官方 worker 的环境白名单不含主题目录；固定启动器仅补入本应用只读资源路径。
  await writeFile(
    resolve(outputDirectory, 'ZeusComputerWorker'),
    '#!/bin/sh\n# Zeus 私有 CUA worker：继承宿主身份，不创建可重连的外部服务。\nworker_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)" || exit 1\nexport CUA_DRIVER_CURSOR_THEME_DIR="$worker_dir/../../assets/computer-cursor"\nexec "$worker_dir/cua-driver" "$@"\n',
  );
  await chmod(resolve(outputDirectory, 'ZeusComputerWorker'), 0o755);
}

/** 编译当前架构的 Swift 辅助程序，失败直接停止构建。 */
async function compileSwift({ source, output, frameworks }) {
  /** 每个系统框架分别传参，避免经过 shell 解析。 */
  const frameworkArgs = frameworks.flatMap((framework) => ['-framework', framework]);
  await new Promise((resolveBuild, rejectBuild) => {
    /** 构建子进程继承日志，并由退出状态确定构建结果。 */
    const child = spawn('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', ...frameworkArgs, '-target', `${architecture}-apple-macos13.0`, ...[source].flat(), '-o', output], {
      stdio: 'inherit',
    });
    child.once('error', rejectBuild);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Zeus 原生辅助程序构建失败（${source}）${signal ? `：signal=${signal}` : `：code=${code ?? 'unknown'}`}`));
    });
  });
}
