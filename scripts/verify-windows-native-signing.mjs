#!/usr/bin/env node
/* global console */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import signWindowsNative from './sign-windows-native.mjs';

/** 复用当前安装的 builder 及其资源编辑依赖，不另装工具链。 */
const rootRequire = createRequire(import.meta.url);
/** electron-builder 自身依赖提供真实打包实现。 */
const builderRequire = createRequire(createRequire(rootRequire.resolve('electron-builder/package.json')).resolve('app-builder-lib/package.json'));
// 先初始化公开入口，保持 builder 自身循环依赖的加载顺序。
builderRequire('./out/index.js');
/** 直接检查实际签名选择器及资源编辑方法。 */
const { WinPackager } = builderRequire('./out/winPackager.js');
/** 资源读写只使用已安装的 PE 库，不执行生成的文件。 */
const { NtExecutable, NtExecutableResource, Resource } = builderRequire('resedit');
/** 与正式配置共用同一签名规则。 */
const configuration = builderRequire('js-yaml').load(await readFile(new URL('../apps/desktop/electron-builder.windows.yml', import.meta.url), 'utf8'));
/** 包规则必须只排除原名 Rust 服务，其余可执行文件和动态库保持默认签名。 */
const selection = { platformSpecificBuildOptions: configuration.win };
for (const name of ['Zeus.exe', 'Zeus Test.exe', 'zeus-windows-security.exe', 'cua-driver.exe', 'sdk.dll', 'sdk.node', 'runtime.exe']) assert.equal(WinPackager.prototype.shouldSignFile.call(selection, name), true);
assert.equal(WinPackager.prototype.shouldSignFile.call(selection, 'ZeusWindowsRuntime.exe'), false);
/** 所有候选和缓存只写独立临时目录。 */
const directory = await mkdtemp(join(tmpdir(), 'zeus-native-signing-'));
try {
  /** 验证包目录与输出目录分离，临时签名缓存不能进入应用资源。 */
  const appOutDir = join(directory, 'application');
  /** 最终运行时仍须保留约定的物理路径。 */
  const nativeDirectory = join(appOutDir, 'resources/native');
  await mkdir(nativeDirectory, { recursive: true });
  // builder 的 Arch 枚举为 x64=1、arm64=3；两种 PE 必须保留原架构。
  for (const [machine, arch] of [
    [0x8664, 1],
    [0xaa64, 3],
  ]) {
    /** 生成最小未签名 PE，仅供资源编辑检查。 */
    const input = Buffer.from(NtExecutable.createEmpty(false).generate());
    input.writeUInt16LE(machine, input.readUInt32LE(60) + 4);
    await writeFile(join(nativeDirectory, 'ZeusWindowsRuntime.exe'), input);
    /** 只记录签名边界，不伪造 Authenticode 成功。 */
    let signingCalls = 0;
    /** 实际 builder 编辑资源；签名边界由检查代替，不需要发行证书。 */
    const packager = {
      ...selection,
      appInfo: { productName: 'Zeus Test', copyright: 'Zeus', shortVersion: '1.2.3', shortVersionWindows: '1.2.3' },
      config: { electronDist: directory },
      /** 资源检查不需要产品图标。 */
      getIconPath: async () => null,
      signAndEditResources: WinPackager.prototype.signAndEditResources,
      /** 签名前的字节必须已含正确组件身份。 */
      signIf: async (path) => {
        signingCalls += 1;
        const executable = NtExecutable.from(await readFile(path));
        const entries = Resource.VersionInfo.fromEntries(NtExecutableResource.from(executable).entries);
        assert.equal(entries[0].getStringValues(entries[0].getAllLanguagesForStringValues()[0]).InternalName, 'ZeusWindowsRuntime');
      },
    };
    await signWindowsNative({ electronPlatformName: 'win32', appOutDir, outDir: directory, arch, packager });
    assert.equal(signingCalls, 1);
    assert.deepEqual(await readdir(directory), ['application']);
    /** 资源编辑不能改变实际 PE 架构。 */
    const result = await readFile(join(nativeDirectory, 'ZeusWindowsRuntime.exe'));
    assert.equal(result.readUInt16LE(result.readUInt32LE(60) + 4), machine);
  }
  console.log('原生签名构建检查通过：真实 builder 写入 InternalName、仅签一次、保持 x64/ARM64 PE、清除临时缓存；未执行 Authenticode。');
} finally {
  await rm(directory, { recursive: true, force: true });
}
