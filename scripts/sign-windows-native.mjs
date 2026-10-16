import { copyFile, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Rust 服务始终写入组件名，并沿用当前包的签名策略；其他原生文件由复制阶段处理。 */
export default async function signWindowsNative(context) {
  if (context.electronPlatformName !== 'win32') return;
  /** 保留原生目录的链接边界检查，拒绝将外部目标作为包内组件。 */
  await assertWindowsNativeDirectory(join(context.appOutDir, 'resources/native'));
  /** 此文件在默认复制签名阶段明确排除，仅由本钩子写资源并签名一次。 */
  const runtimePath = join(context.appOutDir, 'resources/native/ZeusWindowsRuntime.exe');
  /** builder 的可执行缓存未绑定 Rust 字节；独立临时目录防止重用主程序或旧服务缓存。 */
  const signingDirectory = await mkdtemp(join(context.outDir, '.zeus-runtime-sign-'));
  try {
    /** 临时名称不命中复制阶段的精确排除项，最终组件身份由资源字段确定。 */
    const candidate = join(signingDirectory, 'runtime.exe');
    await copyFile(runtimePath, candidate);
    await context.packager.signAndEditResources(candidate, context.arch, signingDirectory, 'ZeusWindowsRuntime');
    await rename(candidate, runtimePath);
  } finally {
    await rm(signingDirectory, { recursive: true, force: true });
  }
}

/** 每个目录由构建产物生成，链接不属于允许发布的原生文件。 */
async function assertWindowsNativeDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Windows 原生资源目录不能含符号链接。');
    if (entry.isDirectory()) await assertWindowsNativeDirectory(join(directory, entry.name));
  }
}
