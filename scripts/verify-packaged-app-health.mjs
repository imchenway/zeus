#!/usr/bin/env node
/* global console, process */
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * 读取 Electron asar 内的文本文件。
 * 只实现发布门禁需要的只读路径校验，不引入额外 asar 依赖，避免本地核心验收再增加安装变量。
 */
export function readAsarTextFile(asarPath, innerPath) {
  const previousNoAsar = process.noAsar;
  // Electron 的 Node 模式会把 .asar 当虚拟目录代理；这里要读取 asar 包本体，所以只在本次读取临时关闭代理。
  process.noAsar = true;
  let archive;
  try {
    archive = readFileSync(asarPath);
  } finally {
    process.noAsar = previousNoAsar;
  }
  const headerSize = archive.readUInt32LE(12);
  const headerStart = 16;
  const header = JSON.parse(archive.subarray(headerStart, headerStart + headerSize).toString('utf8'));
  const normalizedPath = innerPath.replace(/^\/+/, '');
  const parts = normalizedPath.split('/').filter(Boolean);
  let node = { files: header.files };
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) {
      throw new Error(`asar file not found: ${innerPath}`);
    }
  }
  if (typeof node.size !== 'number' || typeof node.offset !== 'string') {
    throw new Error(`asar path is not a file: ${innerPath}`);
  }
  const contentStart = alignAsarContentOffset(headerStart, headerSize);
  const start = contentStart + Number(node.offset);
  return archive.subarray(start, start + node.size).toString('utf8');
}

/** asar 头部 JSON 后面会按 4 字节对齐补零；真实文件内容必须从对齐后的 payload 起点读取。 */
export function alignAsarContentOffset(headerStart, headerSize) {
  const rawOffset = headerStart + headerSize;
  return rawOffset + ((4 - (rawOffset % 4)) % 4);
}

/** 校验打包后的首页不会因为 file:// 下的根路径资源引用而白屏。 */
export function assertPackagedRendererEntrypoint(asarPath) {
  const htmlPath = 'dist/renderer/index.html';
  const html = readAsarTextFile(asarPath, htmlPath);
  const rootRelativeAssets = [...html.matchAll(/(?:src|href)="\/assets\//g)];
  if (rootRelativeAssets.length > 0) {
    throw new Error('packaged renderer contains root-relative asset URL; file:// app will open a blank window');
  }

  const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]).filter((ref) => ref.includes('assets/'));
  if (assetRefs.length === 0) {
    throw new Error('packaged renderer index.html does not reference built assets');
  }

  for (const ref of assetRefs) {
    const assetPath = posix.normalize(posix.join(posix.dirname(htmlPath), ref));
    readAsarTextFile(asarPath, assetPath);
  }

  return { htmlPath, assetCount: assetRefs.length };
}

export function verifyPackagedApp(appPath) {
  const appRoot = resolve(appPath);
  const asarPath = join(appRoot, 'Contents/Resources/app.asar');
  const renderer = assertPackagedRendererEntrypoint(asarPath);
  const mainPackage = JSON.parse(readAsarTextFile(asarPath, 'package.json'));
  if (mainPackage?.name !== '@zeus/desktop' || mainPackage?.main !== 'dist/main/main.js') {
    throw new Error(`unexpected packaged app metadata: ${JSON.stringify({ name: mainPackage?.name, main: mainPackage?.main })}`);
  }
  readAsarTextFile(asarPath, mainPackage.main);
  return {
    appName: 'Zeus',
    assetCount: renderer.assetCount,
    main: mainPackage.main,
  };
}

async function main() {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('Zeus packaged health: missing Zeus.app path');
    process.exit(2);
  }
  const health = verifyPackagedApp(appPath);
  console.log(`packaged-health=${health.appName};rendererAssets=${health.assetCount};main=${health.main}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
