#!/usr/bin/env node
/* global process */
import { chmod, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(desktopRoot, 'dist/native');
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

async function compileSwift({ source, output, frameworks }) {
  const frameworkArgs = frameworks.flatMap((framework) => ['-framework', framework]);
  await new Promise((resolveBuild, rejectBuild) => {
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
