#!/usr/bin/env node
/* global process */
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(desktopRoot, 'browser-extension/src');
const storeRoot = resolve(desktopRoot, 'browser-extension/store');
const outputRoot = resolve(desktopRoot, 'dist/browser-extension');
const svgRenderer = resolve(desktopRoot, 'scripts/render-svg.swift');
const projectRoot = resolve(desktopRoot, '../..');
const swiftEnvironment = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: process.env.CLANG_MODULE_CACHE_PATH || resolve(projectRoot, '.tmp/clang-module-cache'),
};
const chromeTestKey =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtbixiqp3UHuJx2C81eJxDKJyGQCtZgDRw66bP6KY5lF9yUGedShp4oiIKZOXSwu9iC4Zy39+PqwPtjuGO9v0Oo91wiJR0LvkdVDhirCCLxCLq6s7Hl72h9L8lelCZzPvDsuUJP5gfBIP3yoUJ5mkJUE0jKXGaxey2Gu5vh5nWuMrNRuItpX9jPF1zz3GKeX8v5hhSO/drwFxUKcs528ZbOFLZUlHMR29heFG1K/gTrAltzDeLfK2LP6XmnYQ/Rjp12lAslpw9cuLYseKH2dly9usltJaOKGVaz4R3WvJb7ttRS2QnCppnqwjZVkZocGjbCaxndh4Ku9Gjfv42ujamwIDAQAB';
const edgePreviewKey =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA6jYFqwXRrrA8z4NHw2hI4UFhmYHnjl3kD1FQ3D38b8ah5umY4/8pR9/DgOnILf+vCDoVDkHzuwGMaBEDSqOaWqrD4tJ+RzV8RjCammz2jaTE6+3y3G8SgxS6VJgz4bTrZZmzh3qR2/L6z3wx7WSqkUpqQNb3uABkCZn8VZRMyMn9NWOyna7hSGADP5RKq4jtZjc8pu5+NmpmUKc807m8FGuMwSGt3CGyekHy6wHpC2NXgucBwMS39krFgYRFdhB/n8vO+qPo/eqo0nKa5Q2soLPHLy+E4xtX/2fi2/uTvotzBm3offPZUebCcrVPpuQJeQRaVtRHpqYsSYmfg+7TPwIDAQAB';

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const variants = [
  { directory: 'chrome', surface: 'chrome', name: 'Zeus Browser', host: 'dev.hypha.zeus.browser_host', key: undefined, zip: 'Zeus-Browser-Chrome-Web-Store.zip' },
  { directory: 'chrome-test', surface: 'chrome', name: 'Zeus Browser Test', host: 'dev.hypha.zeus.test.browser_host', key: chromeTestKey, zip: 'Zeus-Browser-Chrome-Test.zip' },
  { directory: 'edge-preview', surface: 'edge', name: 'Zeus Browser Edge Preview', host: 'dev.hypha.zeus.test.browser_host', key: edgePreviewKey, zip: 'Zeus-Browser-Edge-Preview.zip' },
];

const backgroundSource = await readFile(resolve(sourceRoot, 'background.ts'), 'utf8');
for (const variant of variants) {
  const target = resolve(outputRoot, variant.directory);
  await mkdir(resolve(target, 'icons'), { recursive: true });
  await writeFile(resolve(target, 'background.js'), backgroundSource.replaceAll('__ZEUS_SURFACE__', variant.surface).replaceAll('__ZEUS_NATIVE_HOST__', variant.host), 'utf8');
  await copyFile(resolve(sourceRoot, 'content.ts'), resolve(target, 'content.js'));
  await copyFile(resolve(sourceRoot, 'popup.ts'), resolve(target, 'popup.js'));
  await copyFile(resolve(sourceRoot, 'popup.html'), resolve(target, 'popup.html'));
  await copyFile(resolve(sourceRoot, 'popup.css'), resolve(target, 'popup.css'));
  const manifest = {
    manifest_version: 3,
    name: variant.name,
    // 安装页由浏览器自带语言机制选择说明；扩展弹窗继续跟随 Zeus。
    default_locale: 'en',
    description: '__MSG_description__',
    version: '1.0.0',
    minimum_chrome_version: '120',
    ...(variant.key ? { key: variant.key } : {}),
    action: { default_title: variant.name, default_popup: 'popup.html' },
    background: { service_worker: 'background.js' },
    permissions: ['tabs', 'nativeMessaging', 'scripting', 'storage'],
    optional_permissions: ['bookmarks', 'history', 'downloads', 'clipboardRead', 'clipboardWrite', 'debugger'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  };
  // 只生成安装说明所需的两份浏览器原生语言文件，不增加翻译依赖。
  for (const [locale, description] of [
    ['en', 'Let Zeus browse sites you allow. Sensitive actions still need your confirmation.'],
    ['zh_CN', '让 Zeus 操作你允许的网站。敏感操作仍需你确认。'],
  ]) {
    await mkdir(resolve(target, '_locales', locale), { recursive: true });
    await writeFile(resolve(target, '_locales', locale, 'messages.json'), JSON.stringify({ description: { message: description } }), 'utf8');
  }
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // 扩展各尺寸图标直接由应用的同一份原图生成。
  if (process.platform === 'win32') {
    // Windows 使用系统绘图及 ZIP 库；输入路径通过环境传递，不拼接进命令。
    await run(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.IO.Compression.FileSystem
# 图标始终从应用原图读取，并在所有尺寸生成后释放文件句柄。
$source = [System.Drawing.Image]::FromFile($env:BROWSER_EXTENSION_ICON)
try {
  # 与扩展清单保持相同的四个图标尺寸。
  foreach ($size in @(16, 32, 48, 128)) {
    # 透明画布保留源图的 Alpha 通道。
    $canvas = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    # 绘图上下文仅服务当前尺寸，失败也必须释放。
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.DrawImage($source, 0, 0, $size, $size)
      $canvas.Save((Join-Path $env:BROWSER_EXTENSION_DIRECTORY ('icons/icon-' + $size + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $graphics.Dispose()
      $canvas.Dispose()
    }
  }
} finally {
  $source.Dispose()
}
# ZIP 根目录直接包含 manifest，与现有 macOS 扩展包结构相同。
[System.IO.Compression.ZipFile]::CreateFromDirectory($env:BROWSER_EXTENSION_DIRECTORY, $env:BROWSER_EXTENSION_ARCHIVE, [System.IO.Compression.CompressionLevel]::Optimal, $false)
`,
      ],
      target,
      {
        ...process.env,
        // 三个平台扩展沿用同一份应用原图。
        BROWSER_EXTENSION_ICON: resolve(desktopRoot, 'assets/icon.png'),
        // 当前扩展的独立输出目录。
        BROWSER_EXTENSION_DIRECTORY: target,
        // 当前扩展的归档文件，位于被压缩目录之外。
        BROWSER_EXTENSION_ARCHIVE: resolve(outputRoot, variant.zip),
      },
    );
  } else {
    for (const size of [16, 32, 48, 128]) await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), resolve(desktopRoot, 'assets/icon.png'), '--out', resolve(target, `icons/icon-${size}.png`)]);
    await run('/usr/bin/zip', ['-q', '-r', resolve(outputRoot, variant.zip), '.'], target);
  }
}

const materials = resolve(outputRoot, 'chrome-web-store-materials');
await mkdir(materials, { recursive: true });
for (const file of ['permissions.zh-CN.md', 'privacy.zh-CN.md', 'review-checklist.zh-CN.md']) await copyFile(resolve(storeRoot, file), resolve(materials, file));
for (const [source, target, width, height] of [
  ['promo-small.svg', 'promo-small-440x280.png', 440, 280],
  ['promo-marquee.svg', 'promo-marquee-1400x560.png', 1400, 560],
]) {
  // ponytail: 商店 PNG 沿用 macOS 上架构建；Windows 保留 SVG，需跨平台上架时统一渲染器。
  if (process.platform === 'darwin') await run('/usr/bin/xcrun', ['swift', svgRenderer, resolve(storeRoot, source), resolve(materials, target), String(width), String(height)], desktopRoot, swiftEnvironment);
  else await copyFile(resolve(storeRoot, source), resolve(materials, source));
}
// 商店素材保留原始 PNG，避免扩展与桌面应用使用不同头像。
await copyFile(resolve(desktopRoot, 'assets/icon.png'), resolve(materials, 'zeus-browser-icon-source.png'));
await writeFile(resolve(materials, 'PRODUCTION_EXTENSION_ID_REQUIRED.txt'), '生产扩展 ID 是商店首次上传后的发布输入。本任务禁止使用通配 allowed_origins，也不上传或提交审核。\n', 'utf8');

/** 按平台执行固定构建工具，失败保留原始错误并终止打包。 */
async function run(command, args, cwd = desktopRoot, env = process.env) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => (code === 0 ? resolveRun() : rejectRun(new Error(`${basename(command)} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`))));
  });
}
