#!/usr/bin/env node
/* global console, process */
import { existsSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, '..');
const desktopDir = join(rootDir, 'apps', 'desktop');

export function electronZipFileName(version, arch) {
  return `electron-v${version}-darwin-${arch}.zip`;
}

export function electronDistDirName(version, arch) {
  return `electron-v${version}-darwin-${arch}`;
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

async function prepareElectronDist(version, arch) {
  const zipName = electronZipFileName(version, arch);
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'electron');
  const zipPath = await findFileByName(cacheRoot, zipName);
  if (!zipPath) {
    throw new Error(`Zeus package:mac 未找到 Electron 缓存 ${zipName}。请先执行一次 electron-builder 下载 Electron，或检查网络后重试。`);
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

export async function packageMac() {
  if (process.platform !== 'darwin') {
    throw new Error('Zeus package:mac 只能在 macOS 上执行。');
  }
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  const version = await readElectronVersion();
  const electronDist = await prepareElectronDist(version, arch);
  await assertPackagedAppIsNotRunning(join(rootDir, 'dist', arch === 'arm64' ? 'mac-arm64' : 'mac', 'Zeus.app'));
  await run('pnpm', ['build'], { cwd: desktopDir });
  await run('pnpm', ['--filter', '@zeus/desktop', 'exec', 'electron-builder', '--mac', 'dmg', 'zip', '--config', 'electron-builder.yml', `--config.electronDist=${electronDist}`], { cwd: rootDir, env: buildMacNativeDependencyEnv() });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  packageMac().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
