#!/usr/bin/env node
/* global process */
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const sourcePath = resolve(desktopRoot, 'native/UpdateProgressPanel.swift');
const outputDirectory = resolve(desktopRoot, 'dist/native');
const outputPath = resolve(outputDirectory, 'ZeusUpdateProgress');
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';

if (process.platform !== 'darwin') {
  throw new Error('Zeus 原生辅助程序只能在 macOS 上构建。');
}

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', '-framework', 'AppKit', '-target', `${architecture}-apple-macos13.0`, sourcePath, '-o', outputPath], {
    stdio: 'inherit',
  });
  child.once('error', rejectBuild);
  child.once('exit', (code, signal) => {
    if (code === 0) resolveBuild();
    else rejectBuild(new Error(`Zeus 原生辅助程序构建失败${signal ? `：signal=${signal}` : `：code=${code ?? 'unknown'}`}`));
  });
});
