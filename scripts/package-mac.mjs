#!/usr/bin/env node
/* global console, process */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { verifyPackagedApp } from './verify-packaged-app-health.mjs';
import { machoSignatureNeutralSha256 } from './macho-signature-neutral-sha256.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const desktopDir = join(rootDir, 'apps', 'desktop');

export function electronZipFileName(version, arch) {
  return `electron-v${version}-darwin-${arch}.zip`;
}

export function electronDistDirName(version, arch) {
  return `electron-v${version}-darwin-${arch}`;
}

export function packagedAppPathForArch(arch) {
  return join(rootDir, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Zeus.app');
}

export function buildCodesignVerifyArgs(appPath) {
  return ['--verify', '--deep', '--strict', '--verbose=2', appPath];
}

function hasDeveloperIdSigningConfiguration(env) {
  return Boolean(env.CSC_LINK?.trim() || env.CSC_NAME?.trim());
}

function hasNotarizationConfiguration(env) {
  const hasApiKey = Boolean(env.APPLE_API_KEY?.trim() && env.APPLE_API_KEY_ID?.trim() && env.APPLE_API_ISSUER?.trim());
  const hasAppleId = Boolean(env.APPLE_ID?.trim() && env.APPLE_APP_SPECIFIC_PASSWORD?.trim() && env.APPLE_TEAM_ID?.trim());
  const hasKeychainProfile = Boolean(env.APPLE_KEYCHAIN_PROFILE?.trim());
  return hasApiKey || hasAppleId || hasKeychainProfile;
}

function omitEmptyAppleReleaseEnvironment(env) {
  const normalizedEnv = { ...env };
  const releaseKeys = ['CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE'];
  // GitHub Actions 会把未配置的 secret 注入为空字符串；electron-builder 会把空 CSC_LINK 误判为证书路径。
  for (const key of releaseKeys) {
    if (!normalizedEnv[key]?.trim()) delete normalizedEnv[key];
  }
  return normalizedEnv;
}

function buildElectronBuilderSigningArgs(env) {
  if (!hasDeveloperIdSigningConfiguration(env)) {
    return ['--config.mac.identity=-', '--config.mac.notarize=false'];
  }

  return [`--config.mac.notarize=${hasNotarizationConfiguration(env) ? 'true' : 'false'}`, '--config.forceCodeSigning=true'];
}

async function readElectronVersion() {
  const configPath = join(desktopDir, 'electron-builder.yml');
  const text = await import('node:fs/promises').then((fs) => fs.readFile(configPath, 'utf8'));
  const match = text.match(/^electronVersion:\s*([^\s]+)/mu);
  if (!match) {
    throw new Error('Zeus package:mac 无法从 apps/desktop/electron-builder.yml 读取 electronVersion。');
  }
  return match[1];
}

async function findFileByName(startDir, fileName) {
  const entries = await readdir(startDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(startDir, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = await findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return undefined;
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} ${args.join(' ')} failed${signal ? ` with ${signal}` : ` with code ${code}`}`));
    });
  });
}

function buildMacNativeDependencyEnv(baseEnv = process.env) {
  if (process.platform !== 'darwin') return baseEnv;
  try {
    const sdkPath = execFileSync('xcrun', ['--show-sdk-path'], {
      encoding: 'utf8',
    }).trim();
    const cxxIncludePath = join(sdkPath, 'usr', 'include', 'c++', 'v1');
    // node-pty 的 Electron rebuild 需要 C++ 标准库头文件；部分 CLT 安装只在版本化 SDK 下提供该目录。
    return {
      ...baseEnv,
      SDKROOT: sdkPath,
      CPLUS_INCLUDE_PATH: [cxxIncludePath, baseEnv.CPLUS_INCLUDE_PATH].filter(Boolean).join(':'),
    };
  } catch {
    return baseEnv;
  }
}

export function findRunningPackagedAppProcesses(psOutput, appPath) {
  const executablePath = join(resolve(appPath), 'Contents', 'MacOS', 'Zeus');
  return psOutput
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => {
      const command = line.replace(/^\d+\s+/u, '');
      return command === executablePath || command.startsWith(`${executablePath} `);
    });
}

export function formatRunningPackagedAppError(appPath, runningProcesses) {
  return [
    `Zeus package:mac 检测到正在运行的打包 App：${appPath}`,
    '请先退出当前 Zeus，再重新执行 pnpm package:mac；否则 Electron 可能用旧 asar 索引读取新 app.asar，窗口会显示源码片段并失去拖拽样式。',
    '运行中进程：',
    ...runningProcesses.map((line) => `- ${line}`),
  ].join('\n');
}

async function assertPackagedAppIsNotRunning(appPath) {
  if (process.platform !== 'darwin') return;
  const psOutput = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,args='], {
    encoding: 'utf8',
  });
  const running = findRunningPackagedAppProcesses(psOutput, appPath);
  if (running.length > 0) {
    throw new Error(formatRunningPackagedAppError(appPath, running));
  }
}

async function verifyCodesignPackagedApp(appPath) {
  if (process.platform !== 'darwin') return;
  // 签名必须在 electron-builder 生成 DMG 前完成；这里仅验证最终 App，不再事后改写签名。
  await run('/usr/bin/codesign', buildCodesignVerifyArgs(appPath));
}

async function prepareElectronDist(version, arch) {
  const zipName = electronZipFileName(version, arch);
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'electron');
  const zipPath = await findFileByName(cacheRoot, zipName);
  if (!zipPath) {
    return undefined;
  }

  const distDir = join(rootDir, '.tmp', 'electron-dist', electronDistDirName(version, arch));
  const electronApp = join(distDir, 'Electron.app');
  if (!existsSync(electronApp)) {
    await rm(distDir, { recursive: true, force: true });
    await mkdir(distDir, { recursive: true });
    await run('/usr/bin/unzip', ['-q', '-o', zipPath, '-d', distDir]);
  }
  return distDir;
}

async function refreshCodexRuntimeManifest(arch) {
  const runtimeDir = join(rootDir, '.tmp', 'codex-runtime', arch);
  const binary = await readFile(join(runtimeDir, 'codex'));
  const manifestPath = join(runtimeDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const binarySha256 = createHash('sha256').update(binary).digest('hex');
  if (manifest.sha256 !== binarySha256) {
    throw new Error(`Zeus package:mac Codex runtime 原始摘要不一致：expected=${manifest.sha256 ?? 'missing'} actual=${binarySha256}`);
  }
  const codeSha256 = machoSignatureNeutralSha256(binary);
  if (manifest.codeSha256 === codeSha256) return;
  await writeFile(manifestPath, `${JSON.stringify({ ...manifest, codeSha256 }, null, 2)}\n`, { mode: 0o600 });
}

export async function packageMac() {
  if (process.platform !== 'darwin') {
    throw new Error('Zeus package:mac 只能在 macOS 上执行。');
  }
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const version = await readElectronVersion();
  const electronDist = await prepareElectronDist(version, arch);
  const appPath = packagedAppPathForArch(arch);
  await assertPackagedAppIsNotRunning(appPath);
  await refreshCodexRuntimeManifest(arch);
  await run('pnpm', ['build'], { cwd: desktopDir });
  const packageEnv = buildMacNativeDependencyEnv(omitEmptyAppleReleaseEnvironment(process.env));
  const signingArgs = buildElectronBuilderSigningArgs(packageEnv);
  const electronDistArgs = electronDist ? [`--config.electronDist=${electronDist}`] : [];
  await run('pnpm', ['--filter', '@zeus/desktop', 'exec', 'electron-builder', '--mac', 'dmg', '--config', 'electron-builder.yml', ...electronDistArgs, ...signingArgs], {
    cwd: rootDir,
    env: packageEnv,
  });
  verifyPackagedApp(appPath);
  await verifyCodesignPackagedApp(appPath);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageMac().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
