#!/usr/bin/env node
/* global process, console */
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { generateReleaseManifest } from './generate-release-manifest.mjs';

/** 所有路径固定到当前工作树，不依赖调用终端的目录。 */
const root = resolve(import.meta.dirname, '..');
/** 正式包必须显式选择，日常构建保持独立测试身份。 */
const release = process.argv.includes('--release');
/** 显式编译模式只检查原生产物，安装器由普通或正式打包入口生成。 */
const compileOnly = process.argv.includes('--compile-only');
/** 每个架构由原生 Windows runner 构建，避免把 x64 DLL 放进 ARM 包。 */
const arch = process.arch;
/** 当前 pnpm 入口由包脚本传入，Windows 不经过 cmd 的二次参数解析。 */
const pnpmEntry = process.env.npm_execpath;
/** 当前包使用的 Electron 版本及应用版本只有根清单这一来源。 */
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
/** 测试包与正式包写入独立目录。 */
const output = resolve(root, process.env.ZEUS_PACKAGE_OUTPUT_DIR || (release ? 'dist' : 'dist/test'));
/** 内部包按实际凭据决定签名，正式发行始终要求签名。 */
const hasSigningCredentials = Boolean(process.env.WIN_CSC_LINK?.trim() || process.env.CSC_LINK?.trim());
/** 不允许缺少或无效的签名凭据降级为未签名正式包。 */
const requireSignature = release || hasSigningCredentials;

if (process.platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('Windows 安装包必须在对应架构的原生 Windows 上构建。');
if (!pnpmEntry || !/\.(?:c?js|mjs)$/u.test(pnpmEntry)) throw new Error('请通过 pnpm package:windows 执行构建。');
if (!compileOnly && release && !hasSigningCredentials) throw new Error('Windows 正式安装包必须配置可验签的 Authenticode 凭据；无证书请运行 pnpm package:windows，生成独立的未签名内部安装包。');
await mkdir(output, { recursive: true });
await run(process.execPath, [pnpmEntry, 'build']);
if (compileOnly) {
  await assertNativeArchitecture(join(root, 'apps/desktop/dist/native'));
  console.log('Windows 编译与原生 PE 架构检查通过；未生成安装器。');
  process.exit(0);
}
/** 使用已安装的 electron-builder，禁止在打包时联网拉取另一个版本。 */
const require = createRequire(import.meta.url);
await run(
  process.execPath,
  [
    require.resolve('electron-builder/cli.js'),
    '--win',
    '--' + arch,
    '--publish',
    'never',
    '--config',
    release ? 'electron-builder.windows.yml' : 'electron-builder.windows.test.yml',
    `--config.electronVersion=${manifest.devDependencies.electron}`,
    `--config.directories.output=${output}`,
    `--config.forceCodeSigning=${requireSignature}`,
  ],
  join(root, 'apps/desktop'),
);
/** 安装器必须实际存在且非空；原生资源必须出现在解包后的物理目录。 */
const installerName = `${release ? 'Zeus' : 'Zeus-Test'}-${manifest.version}-win32-${arch}.exe`;
if ((await stat(join(output, installerName))).size === 0) throw new Error('Windows 安装器为空。');
/** electron-builder 对非 x64 目标使用架构后缀。 */
const unpacked = join(output, arch === 'x64' ? 'win-unpacked' : `win-${arch}-unpacked`);
await assertNativeArchitecture(join(unpacked, 'resources/native'));
await assertPeArchitecture(join(unpacked, release ? 'Zeus.exe' : 'Zeus Test.exe'), arch);
/** 正式和配置了凭据的内部包必须验签；未签名包必须保持独立产品和原生组件名。 */
await run(
  'powershell.exe',
  [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$ErrorActionPreference='Stop'; $requireSignature=${requireSignature ? '$true' : '$false'}; if ($requireSignature) { $files=@($env:ZEUS_VERIFY_INSTALLER,(Join-Path $env:ZEUS_VERIFY_APP $env:ZEUS_VERIFY_EXECUTABLE))+@(Get-ChildItem -LiteralPath (Join-Path $env:ZEUS_VERIFY_APP 'resources/native') -Recurse -File | Where-Object { $_.Extension -in '.exe','.dll','.node' } | ForEach-Object { $_.FullName }); $subject=$null; foreach($file in $files) { $s=Get-AuthenticodeSignature -LiteralPath $file; if ($s.Status -ne 'Valid') { throw ('Windows signature is invalid: '+$file) }; if ($null -eq $subject) { $subject=$s.SignerCertificate.Subject }; if ($s.SignerCertificate.Subject -ne $subject) { throw ('Windows publisher mismatch: '+$file) } } } else { $main=Get-Item -LiteralPath (Join-Path $env:ZEUS_VERIFY_APP $env:ZEUS_VERIFY_EXECUTABLE); if ($env:ZEUS_VERIFY_EXECUTABLE -cne 'Zeus Test.exe' -or $main.VersionInfo.ProductName -cne 'Zeus Test') { throw 'Unsigned installer must use the isolated Zeus Test identity' } }; $runtime=Get-Item -LiteralPath (Join-Path $env:ZEUS_VERIFY_APP 'resources/native/ZeusWindowsRuntime.exe'); if ($runtime.VersionInfo.InternalName -cne 'ZeusWindowsRuntime') { throw 'Windows runtime component identity is invalid' }`,
  ],
  root,
  { ZEUS_VERIFY_INSTALLER: join(output, installerName), ZEUS_VERIFY_APP: unpacked, ZEUS_VERIFY_EXECUTABLE: release ? 'Zeus.exe' : 'Zeus Test.exe' },
);
if (release) await generateReleaseManifest({ version: manifest.version, platform: 'win32', distDir: output, outputPath: join(output, `zeus-release-manifest-win32-${arch}.json`), signed: true });
console.log(`Windows ${requireSignature ? '已签名' : '未签名内部'}安装包已生成：${join(output, installerName)}`);

/** 构建命令直接传参，输出由调用方保存到构建日志。 */
async function run(command, args, cwd = root, extraEnvironment = {}) {
  await new Promise((resolveRun, rejectRun) => {
    /** 无证书的内部构建关闭自动证书发现；显式凭据失败仍由 builder 拒绝。 */
    const environment = { ...process.env, ...extraEnvironment, ...(requireSignature ? {} : { CSC_IDENTITY_AUTO_DISCOVERY: 'false' }), ZEUS_PACKAGE_VARIANT: release ? 'release' : 'test', ZEUS_RELEASE_BUILD: release ? '1' : '0' };
    /** 当前步骤拥有的唯一构建进程。 */
    const child = spawn(command, args, { cwd, env: environment, stdio: 'inherit', windowsHide: true });
    child.once('error', rejectRun);
    child.once('exit', (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${command} 执行失败：${code}`))));
  });
}

/** 编译检查和正式打包共用相同原生资源架构门禁。 */
async function assertNativeArchitecture(directory) {
  for (const name of ['ZeusWindowsRuntime.exe', 'zeus-windows-security.exe', 'cua-driver.exe']) await assertPeArchitecture(join(directory, name), arch);
  for (const name of ['cua_driver_sdk.dll', 'cua_driver_node_runtime.node']) await assertPeArchitecture(join(directory, `node_modules/@trycua/cua-driver-win32-${arch}-msvc`, name), arch);
}

/** 校验实际 PE 头，文件名和打包参数不能替代二进制架构事实。 */
async function assertPeArchitecture(path, architecture) {
  /** 有界读取 PE 头，避免把大型 .NET 单文件程序全部加载进内存。 */
  const handle = await open(path, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== 64 || dos.readUInt16LE(0) !== 0x5a4d) throw new Error(`Windows 二进制格式无效：${path}`);
    const pe = Buffer.alloc(6);
    if ((await handle.read(pe, 0, pe.length, dos.readUInt32LE(60))).bytesRead !== 6 || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== (architecture === 'arm64' ? 0xaa64 : 0x8664))
      throw new Error(`Windows 二进制架构与 ${architecture} 不一致：${path}`);
  } finally {
    await handle.close();
  }
}
