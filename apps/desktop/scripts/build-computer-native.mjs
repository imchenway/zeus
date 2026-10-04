#!/usr/bin/env node
/* global console, process */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, copyFile, cp, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

/** 官方 SDK 版本与固定源码一起审查，升级时同步更新锁文件摘要。 */
const computerNativeVersion = '0.30.4';
/** 固定官方提交，禁止跟随可移动标签构建。 */
const computerNativeRevision = 'bf6c76786d938070f4ecf1e44004752f69f518b8';
/** 固定提交中的 Cargo.lock 摘要，计算缓存键时无需联网下载源码。 */
const computerNativeLockSha256 = '5fa39679b3fa4a44d8011dfe36bf9e4e2263d41fbd09980e51a6bbca28840968';
/** 一次选择两个生产包，共享依赖特性解析，不构建整个工作区。 */
const computerNativeCargoArguments = ['build', '--release', '--locked', '-p', 'cua-driver', '-p', 'cua-driver-sdk'];
/** 所有会影响编译配置的覆盖项参与缓存身份，不输出其原始值。 */
const computerNativeCompilerEnvironment = ['RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'CARGO_BUILD_TARGET', 'MACOSX_DEPLOYMENT_TARGET', 'CC', 'CXX', 'CFLAGS', 'CXXFLAGS'];
/** 同一工作树内等待其他原生构建结束的有限预算。 */
const computerNativeLockWaitMs = 15 * 60_000;
/** 不经过 shell 执行固定工具链和 Git 命令。 */
const executeFile = promisify(execFile);

/** 对构建输入和产物统一计算 SHA-256。 */
function hashComputerNativeBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 从真实工具链和源码输入产生本地与 CI 共用的缓存身份。 */
export async function resolveComputerNativeBuildInputs(desktopRoot, cacheRoot = resolve(desktopRoot, '../../.tmp')) {
  if (process.platform !== 'darwin') throw new Error('CUA 原生程序只能在 macOS 上构建。');
  if (process.env.CARGO_BUILD_TARGET) throw new Error('CUA 原生构建使用当前宿主架构，请移除 CARGO_BUILD_TARGET。');
  /** 桌面依赖是唯一运行时 SDK 版本来源。 */
  const manifest = JSON.parse(await readFile(resolve(desktopRoot, 'package.json'), 'utf8'));
  if (manifest.dependencies['@trycua/cua-driver'] !== computerNativeVersion) throw new Error('CUA SDK 已变更，请同步核对固定源码、补丁和 Cargo.lock。');
  /** 工具链摘要与 CI 的操作系统、SDK 和编译器实际身份绑定。 */
  const toolchain = await Promise.all([
    executeFile('/usr/bin/sw_vers', ['-productVersion']),
    executeFile('/usr/bin/xcrun', ['--show-sdk-build-version']),
    executeFile('/usr/bin/xcrun', ['clang', '--version']),
    executeFile(process.env.RUSTC || 'rustc', ['-vV']),
    executeFile('cargo', ['-V']),
  ]);
  /** 补丁是应用审查过的唯一原生源码变更。 */
  const patch = resolve(desktopRoot, 'native/cua-desktop.patch');
  /** 编译选项不随外层 Swift 构建或 SDK 文件组装变化。 */
  const configuration = {
    /** 操作系统限定原生中间结果的适用平台。 */
    platform: process.platform,
    /** 宿主架构必须与桌面应用保持一致。 */
    architecture: process.arch,
    /** 官方源码提交同时限定依赖锁文件和工作区成员。 */
    revision: computerNativeRevision,
    /** 原始锁文件内容绑定固定官方提交。 */
    lockSha256: computerNativeLockSha256,
    /** 构建目标、优化档位和锁定参数均参与兼容性判断。 */
    arguments: computerNativeCargoArguments,
    /** 系统、SDK、Clang、Rust 和 Cargo 的真实版本集合。 */
    toolchain: toolchain.map((result) => result.stdout.trim()),
    /** 调用者覆盖的编译配置只参与摘要，不进入工作流输出。 */
    environment: Object.fromEntries(computerNativeCompilerEnvironment.map((name) => [name, process.env[name] ?? ''])),
  };
  /** 中间缓存只在工具链、依赖和构建参数兼容时允许回退恢复。 */
  const cargoCompatibilitySha256 = hashComputerNativeBytes(JSON.stringify(configuration));
  /** 成品还必须精确匹配当前 CUA 模块和补丁，外层组装脚本不参与失效。 */
  const nativeInputSha256 = hashComputerNativeBytes(JSON.stringify([cargoCompatibilitySha256, hashComputerNativeBytes(await readFile(patch)), hashComputerNativeBytes(await readFile(fileURLToPath(import.meta.url)))]));
  /** 每套精确输入单独保存成品，工作副本路径保持稳定以复用 Cargo 结果。 */
  const artifactDirectory = resolve(cacheRoot, `cua-native-artifacts-${nativeInputSha256}`);
  return {
    /** 桌面运行依赖的根目录。 */
    desktopRoot,
    /** 当前工作树拥有的缓存根目录。 */
    cacheRoot,
    /** 当前审查过的原生补丁路径。 */
    patch,
    /** 成品凭证必须精确匹配的输入摘要。 */
    nativeInputSha256,
    /** 两份成品在 CI 中共用的精确主键。 */
    nativeCacheKey: `zeus-cua-native-${process.arch}-${nativeInputSha256}`,
    /** 每次原生输入变化保存新的中间缓存快照。 */
    cargoCacheKey: `zeus-cua-cargo-${process.arch}-${cargoCompatibilitySha256}-${nativeInputSha256}`,
    /** 只回退到工具链与依赖兼容的中间快照。 */
    cargoRestoreKey: `zeus-cua-cargo-${process.arch}-${cargoCompatibilitySha256}-`,
    /** 当前精确输入独占的两份成品目录。 */
    artifactDirectory,
    /** 从固定提交检出的原始源码，不写入补丁。 */
    repository: resolve(cacheRoot, `cua-driver-source-${computerNativeRevision}`),
    /** 稳定工作副本路径避免补丁摘要变化使 Cargo 路径失效。 */
    workspace: resolve(cacheRoot, `cua-native-workspace-${computerNativeRevision}-${process.arch}`),
    /** 本地与 CI 恢复的 release 中间产物根目录。 */
    targetDirectory: resolve(cacheRoot, `cua-driver-target-${process.arch}`),
    /** 受控 worker 可执行文件。 */
    workerPath: resolve(artifactDirectory, 'cua-driver'),
    /** 与 worker 同次构建的 SDK 原生库。 */
    sdkPath: resolve(artifactDirectory, 'libcua_driver_sdk.dylib'),
    /** 两份成品全部成功之后才写入的完整凭证。 */
    receiptPath: resolve(artifactDirectory, 'build-receipt.json'),
  };
}

/** 成品输入与两个文件摘要均一致才允许跳过 Cargo。 */
async function readComputerNativeCache(inputs) {
  try {
    /** 只有成功完成两份产物后才写入的缓存凭证。 */
    const receipt = JSON.parse(await readFile(inputs.receiptPath, 'utf8'));
    return receipt.inputSha256 === inputs.nativeInputSha256 && receipt.workerSha256 === hashComputerNativeBytes(await readFile(inputs.workerPath)) && receipt.sdkSha256 === hashComputerNativeBytes(await readFile(inputs.sdkPath));
  } catch {
    return false;
  }
}

/** 稳定工作副本由单个进程更新，避免并发构建删除彼此正在使用的源码。 */
async function acquireComputerNativeBuildLock(inputs) {
  /** 锁属于当前工作树及架构，不占用其他任务或安装应用。 */
  const lockPath = resolve(inputs.cacheRoot, `cua-native-build-${process.arch}.lock`);
  /** 本次锁的唯一身份，释放时不会误删后来创建的锁。 */
  const token = randomUUID();
  /** 等待使用单调时钟，不因系统时间调整重置预算。 */
  const startedAt = performance.now();
  await mkdir(inputs.cacheRoot, { recursive: true });
  while (true) {
    try {
      /** 排他创建后立即写入拥有者，其他构建只等待。 */
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
      } finally {
        await handle.close();
      }
      return async () => {
        /** 锁身份仍属于本次调用时才释放。 */
        const owner = JSON.parse(await readFile(lockPath, 'utf8'));
        if (owner.token === token) await rm(lockPath);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        /** 仅回收已经退出的拥有者或超过初始化窗口的空锁。 */
        const metadata = await stat(lockPath);
        /** 空锁可能来自创建后立即退出的进程，保留三十秒写入窗口。 */
        const rawOwner = await readFile(lockPath, 'utf8');
        if (!rawOwner && Date.now() - metadata.mtimeMs > 30_000) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (rawOwner) {
          /** 已写入的拥有者必须是有效进程身份。 */
          const owner = JSON.parse(rawOwner);
          if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('CUA 构建锁的拥有者无效。');
          try {
            process.kill(owner.pid, 0);
          } catch (probeError) {
            if (probeError.code === 'ESRCH') {
              if ((await readFile(lockPath, 'utf8')) === rawOwner) await rm(lockPath, { force: true });
              continue;
            }
            if (probeError.code !== 'EPERM') throw probeError;
          }
        }
      } catch (lockError) {
        if (lockError.code !== 'ENOENT') throw lockError;
      }
      if (performance.now() - startedAt >= computerNativeLockWaitMs) throw new Error('等待同一工作树的 CUA 原生构建超时。');
      await delay(500);
    }
  }
}

/** 同时生成 worker 与 SDK，成品失效时由 Cargo 校验并复用未变化依赖。 */
export async function prepareComputerNativeArtifacts(inputs) {
  if (await readComputerNativeCache(inputs)) {
    console.log('CUA 原生成品缓存命中：worker 与 SDK 摘要均通过。');
    return inputs;
  }
  /** 固定工作副本与共享 target 在锁内修改。 */
  const releaseLock = await acquireComputerNativeBuildLock(inputs);
  try {
    if (await readComputerNativeCache(inputs)) return inputs;
    try {
      await access(resolve(inputs.repository, '.git'));
    } catch {
      await executeFile('git', ['clone', '--depth', '1', '--filter=blob:none', '--no-checkout', '--branch', `cua-driver-rs-v${computerNativeVersion}`, 'https://github.com/trycua/cua.git', inputs.repository]);
    }
    if ((await executeFile('git', ['-C', inputs.repository, 'rev-parse', 'HEAD'])).stdout.trim() !== computerNativeRevision) throw new Error('CUA 发布源码提交不匹配。');
    await executeFile('git', ['-C', inputs.repository, 'sparse-checkout', 'set', '--cone', 'libs/cua-driver/rust']);
    await executeFile('git', ['-C', inputs.repository, 'checkout', '--detach', computerNativeRevision]);
    await executeFile('git', ['-C', inputs.repository, 'diff', '--quiet', computerNativeRevision, '--', 'libs/cua-driver/rust']);
    if ((await executeFile('git', ['-C', inputs.repository, 'ls-files', '--others', '--', 'libs/cua-driver/rust'])).stdout.trim()) throw new Error('CUA 源码缓存含未跟踪文件，不能用于原生构建。');
    /** 原始副本不接受补丁，工作副本每次从已核对源码重建。 */
    const sourceDirectory = resolve(inputs.repository, 'libs/cua-driver/rust');
    if (hashComputerNativeBytes(await readFile(resolve(sourceDirectory, 'Cargo.lock'))) !== computerNativeLockSha256) throw new Error('CUA Cargo.lock 与固定源码摘要不一致。');
    await rm(inputs.workspace, { recursive: true, force: true });
    await cp(sourceDirectory, inputs.workspace, { recursive: true, preserveTimestamps: true });
    await executeFile('git', ['apply', '--check', inputs.patch], { cwd: inputs.workspace, env: { ...process.env, GIT_CEILING_DIRECTORIES: inputs.cacheRoot } });
    await executeFile('git', ['apply', inputs.patch], { cwd: inputs.workspace, env: { ...process.env, GIT_CEILING_DIRECTORIES: inputs.cacheRoot } });
    console.log('CUA 原生成品缓存未命中：合并构建 worker 与 SDK，由 Cargo 复核中间缓存。');
    await new Promise((resolveBuild, rejectBuild) => {
      /** 同一调用解析两个生产包，日志保留 Cargo 的实际编译时间。 */
      const child = spawn('cargo', computerNativeCargoArguments, { cwd: inputs.workspace, env: { ...process.env, CARGO_TARGET_DIR: inputs.targetDirectory }, stdio: 'inherit' });
      child.once('error', rejectBuild);
      child.once('exit', (code, signal) => (code === 0 ? resolveBuild() : rejectBuild(new Error(`CUA 原生源码构建失败：${signal ? `signal=${signal}` : `code=${code}`}`))));
    });
    await mkdir(inputs.artifactDirectory, { recursive: true });
    await copyFile(resolve(inputs.targetDirectory, 'release/cua-driver'), inputs.workerPath);
    await chmod(inputs.workerPath, 0o755);
    await copyFile(resolve(inputs.targetDirectory, 'release/libcua_driver_sdk.dylib'), inputs.sdkPath);
    await writeFile(
      inputs.receiptPath,
      JSON.stringify({ inputSha256: inputs.nativeInputSha256, workerSha256: hashComputerNativeBytes(await readFile(inputs.workerPath)), sdkSha256: hashComputerNativeBytes(await readFile(inputs.sdkPath)) }),
    );
    return inputs;
  } finally {
    await releaseLock();
  }
}

/** CI 在依赖安装后计算同一套缓存键；清理只作用于本次精确输入的成品。 */
async function main() {
  /** 命令入口只允许缓存信息和失配成品清理，不触发原生编译。 */
  const mode = process.argv[2];
  if (!['--cache-info', '--clear-artifacts'].includes(mode) || process.argv.length !== 3) throw new Error('CUA 构建辅助入口仅接受 --cache-info 或 --clear-artifacts。');
  /** 从自身位置固定当前工作树，拒绝按调用目录猜测。 */
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  /** 工作流与本地构建读取同一模块的真实输入。 */
  const inputs = await resolveComputerNativeBuildInputs(desktopRoot);
  if (mode === '--clear-artifacts') {
    await rm(inputs.artifactDirectory, { recursive: true, force: true });
    return;
  }
  /** 缓存路径相对仓库，跨 runner 恢复时不绑定用户目录。 */
  const repositoryRoot = resolve(desktopRoot, '../..');
  console.log(`native_key=${inputs.nativeCacheKey}`);
  console.log(`cargo_key=${inputs.cargoCacheKey}`);
  console.log(`cargo_restore_key=${inputs.cargoRestoreKey}`);
  console.log(`artifact_path=${relative(repositoryRoot, inputs.artifactDirectory)}`);
  console.log(`cargo_target_path=${relative(repositoryRoot, inputs.targetDirectory)}/release`);
}

// 导入构建模块不会执行 CI 命令入口。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
