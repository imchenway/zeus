#!/usr/bin/env node
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const desktopRoot = resolve(import.meta.dirname, '..');
const sourceRoot = resolve(desktopRoot, 'browser-extension/src');
const storeRoot = resolve(desktopRoot, 'browser-extension/store');
const outputRoot = resolve(desktopRoot, 'dist/browser-extension');
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
    description: 'Connect an explicitly authorized browser profile to the local Zeus automation and approval layer.',
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
  await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  for (const size of [16, 32, 48, 128]) await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), resolve(desktopRoot, 'assets/icon.svg'), '--out', resolve(target, `icons/icon-${size}.png`)]);
  await run('/usr/bin/zip', ['-q', '-r', resolve(outputRoot, variant.zip), '.'], target);
}

const materials = resolve(outputRoot, 'chrome-web-store-materials');
await mkdir(materials, { recursive: true });
for (const file of ['permissions.zh-CN.md', 'privacy.zh-CN.md', 'review-checklist.zh-CN.md']) await copyFile(resolve(storeRoot, file), resolve(materials, file));
for (const [source, target, width, height] of [
  ['promo-small.svg', 'promo-small-440x280.png', 440, 280],
  ['promo-marquee.svg', 'promo-marquee-1400x560.png', 1400, 560],
])
  await run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(height), String(width), resolve(storeRoot, source), '--out', resolve(materials, target)]);
await copyFile(resolve(desktopRoot, 'assets/icon.svg'), resolve(materials, 'zeus-browser-icon-source.svg'));
await writeFile(resolve(materials, 'PRODUCTION_EXTENSION_ID_REQUIRED.txt'), '生产扩展 ID 是商店首次上传后的发布输入。本任务禁止使用通配 allowed_origins，也不上传或提交审核。\n', 'utf8');

async function run(command, args, cwd = desktopRoot) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => (code === 0 ? resolveRun() : rejectRun(new Error(`${basename(command)} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`))));
  });
}
