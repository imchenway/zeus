#!/usr/bin/env node
/* global process */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(desktopRoot, 'dist/native');
const architecture = process.arch === 'x64' ? 'x86_64' : 'arm64';
const packageVariant = process.env.ZEUS_PACKAGE_VARIANT === 'release' || process.env.ZEUS_RELEASE_BUILD === '1' ? 'release' : 'test';

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

const computerApp = resolve(outputDirectory, 'Zeus Computer Service.app');
const computerExecutableDirectory = resolve(computerApp, 'Contents/MacOS');
const computerExecutable = resolve(computerExecutableDirectory, 'Zeus Computer Service');
await mkdir(computerExecutableDirectory, { recursive: true });
await compileSwift({
  source: resolve(desktopRoot, 'native/ComputerService.swift'),
  output: computerExecutable,
  frameworks: ['AppKit', 'ApplicationServices', 'CoreGraphics', 'ScreenCaptureKit'],
});
await chmod(computerExecutable, 0o755);
const computerBundleId = packageVariant === 'release' ? 'dev.hypha.zeus.helper.computer' : 'dev.hypha.zeus.test.helper.computer';
await writeFile(
  resolve(computerApp, 'Contents/Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleExecutable</key><string>Zeus Computer Service</string>
  <key>CFBundleIdentifier</key><string>${computerBundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Zeus Computer Service</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSBackgroundOnly</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Zeus captures only the explicitly targeted app window for user-authorized Computer Use.</string>
</dict>
</plist>
`,
  'utf8',
);

await compileSwift({
  source: resolve(desktopRoot, 'native/BrowserNativeMessagingHost.swift'),
  output: resolve(outputDirectory, 'ZeusBrowserNativeHost'),
  frameworks: [],
});
await chmod(resolve(outputDirectory, 'ZeusBrowserNativeHost'), 0o755);

async function compileSwift({ source, output, frameworks }) {
  const frameworkArgs = frameworks.flatMap((framework) => ['-framework', framework]);
  await new Promise((resolveBuild, rejectBuild) => {
    const child = spawn('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-O', ...frameworkArgs, '-target', `${architecture}-apple-macos13.0`, source, '-o', output], {
      stdio: 'inherit',
    });
    child.once('error', rejectBuild);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild();
      else rejectBuild(new Error(`Zeus 原生辅助程序构建失败（${source}）${signal ? `：signal=${signal}` : `：code=${code ?? 'unknown'}`}`));
    });
  });
}
