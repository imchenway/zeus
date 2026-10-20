#!/usr/bin/env node
/* global process */
import { chmod, copyFile, cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareComputerNativeArtifacts, resolveComputerNativeBuildInputs } from './build-computer-native.mjs';

/** 桌面应用构建根目录。 */
const desktopRoot = resolve(import.meta.dirname, '..');
/** 原生辅助程序统一随当前构建输出。 */
const outputDirectory = resolve(desktopRoot, 'dist/native');
/** Swift 编译目标与当前 Node 架构保持一致。 */
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';

if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Zeus 原生辅助程序仅支持 macOS 和 Windows。');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

if (process.platform === 'darwin') {
  await compileSwift({
    source: resolve(desktopRoot, 'native/GitAskpass.swift'),
    output: resolve(outputDirectory, 'ZeusGitAskpass'),
    frameworks: ['AppKit', 'Security'],
  });
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
} else {
  await buildWindowsHelpers();
}

/** CUA 私有 worker 提供原生光标浮层；同进程 TypeScript SDK 不具备此能力。 */
await prepareComputerWorker();

/** SDK 与 worker 使用同一份受控源码，保持官方 ABI 与私有认证配置一致。 */
async function prepareComputerWorker() {
  /** 专属模块负责来源、编译和两层缓存；本脚本只组装桌面产物。 */
  const native = await prepareComputerNativeArtifacts(await resolveComputerNativeBuildInputs(desktopRoot));
  await copyFile(native.workerPath, resolve(outputDirectory, process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver'));
  if (process.platform === 'darwin') await chmod(resolve(outputDirectory, 'cua-driver'), 0o755);
  /** 绑定代码沿用固定官方 SDK；私有组件组装到应用产物，不改共享 node_modules。 */
  const sdkRoot = resolve(dirname(await realpath(fileURLToPath(import.meta.resolve('@trycua/cua-driver')))), '..');
  /** 从实际 SDK 包解析绑定依赖，开发运行不依赖 pnpm 的间接依赖提升。 */
  const sdkRequire = createRequire(resolve(sdkRoot, 'package.json'));
  /** 官方核心绑定的 CommonJS 入口位于包内 dist/cjs。 */
  const coreRoot = resolve(dirname(sdkRequire.resolve('@ubjs/core')), '../..');
  /** 官方库定位器只读解析文件，保留对应 Node 运行包。 */
  const nodeRoot = dirname(sdkRequire.resolve('@ubjs/node/package.json'));
  await cp(coreRoot, resolve(outputDirectory, 'node_modules/@ubjs/core'), { recursive: true });
  await cp(nodeRoot, resolve(outputDirectory, 'node_modules/@ubjs/node'), { recursive: true });
  /** 官方绑定与 Electron 权限适配层共用本应用 SDK。 */
  const sdkOutput = resolve(outputDirectory, 'cua-sdk');
  await mkdir(sdkOutput, { recursive: true });
  await copyFile(resolve(sdkRoot, 'package.json'), resolve(sdkOutput, 'package.json'));
  await cp(resolve(sdkRoot, 'dist'), resolve(sdkOutput, 'dist'), { recursive: true });
  /** 官方 Node FFI 与绑定保持不变，宿主原生库按相同 ABI 构建。 */
  const platformPackage = `@trycua/cua-driver-${process.platform}-${process.arch}${process.platform === 'win32' ? '-msvc' : ''}`;
  /** 原生平台包从 SDK 的真实依赖解析，不使用全局安装。 */
  const platformRoot = dirname(sdkRequire.resolve(`${platformPackage}/package.json`));
  /** 让官方 resolveLibPath 在绑定代码的上级目录找到本应用私有平台包。 */
  const platformOutput = resolve(outputDirectory, 'node_modules', platformPackage);
  await cp(platformRoot, platformOutput, { recursive: true });
  await copyFile(native.sdkPath, resolve(platformOutput, process.platform === 'win32' ? 'cua_driver_sdk.dll' : 'libcua_driver_sdk.dylib'));
  if (process.platform === 'win32') return;
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

/** Windows 安全与运行时助手均按当前目标架构编译，不复用其他平台二进制。 */
async function buildWindowsHelpers() {
  /** 独立发布目录防止 .NET 中间文件进入最终安装器。 */
  const publishDirectory = resolve(desktopRoot, '../../.tmp/windows-security-publish', process.arch);
  await executeNativeBuild('dotnet', [
    'publish',
    resolve(desktopRoot, 'native/WindowsSecurityHelper.csproj'),
    '-c',
    'Release',
    '-r',
    `win-${process.arch}`,
    '--self-contained',
    'true',
    '-p:PublishSingleFile=true',
    '-p:IncludeNativeLibrariesForSelfExtract=true',
    '-o',
    publishDirectory,
  ]);
  await copyFile(resolve(publishDirectory, 'zeus-windows-security.exe'), resolve(outputDirectory, 'zeus-windows-security.exe'));
  // 文件名选择 askpass 入口，避免全局模式变量误导其他安全组件请求。
  await copyFile(resolve(publishDirectory, 'zeus-windows-security.exe'), resolve(outputDirectory, 'ZeusGitAskpass.exe'));
  /** Rust 产物固定在当前工作树，不污染共享源码或其他架构。 */
  const targetDirectory = resolve(desktopRoot, '../../.tmp/windows-runtime-target', process.arch);
  /** 显式目标防止 ARM Windows 上的 x64 编译器静默生成错误架构。 */
  const rustTarget = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  await executeNativeBuild('cargo', ['build', '--release', '--locked', '--target', rustTarget, '--manifest-path', resolve(desktopRoot, 'native/windows-runtime/Cargo.toml'), '--target-dir', targetDirectory]);
  await copyFile(resolve(targetDirectory, rustTarget, 'release/zeus-windows-runtime.exe'), resolve(outputDirectory, 'ZeusWindowsRuntime.exe'));
}

/** 所有原生编译直接传递参数，Windows 路径中的空格不会改变命令边界。 */
async function executeNativeBuild(command, args) {
  await new Promise((resolveBuild, rejectBuild) => {
    /** 当前构建拥有的编译进程，日志由外层统一保存。 */
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', rejectBuild);
    child.once('exit', (code) => (code === 0 ? resolveBuild() : rejectBuild(new Error(`${command} 原生构建失败：${code}`))));
  });
}
