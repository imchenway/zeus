#!/usr/bin/env node
/* global console, process */
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function readAsarArchive(asarPath) {
  const previousNoAsar = process.noAsar;
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
  return {
    archive,
    header,
    contentStart: alignAsarContentOffset(headerStart, headerSize),
  };
}

function resolveAsarNode(header, innerPath) {
  const normalizedPath = innerPath.replace(/^\/+/, '');
  const parts = normalizedPath.split('/').filter(Boolean);
  let node = { files: header.files };
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) throw new Error(`asar file not found: ${innerPath}`);
  }
  return node;
}

/**
 * 读取 Electron asar 内的文本文件。
 * 只实现发布门禁需要的只读路径校验，不引入额外 asar 依赖，避免本地核心验收再增加安装变量。
 */
export function readAsarTextFile(asarPath, innerPath) {
  const { archive, header, contentStart } = readAsarArchive(asarPath);
  const node = resolveAsarNode(header, innerPath);
  if (typeof node.size !== 'number' || typeof node.offset !== 'string') {
    throw new Error(`asar path is not a file: ${innerPath}`);
  }
  const start = contentStart + Number(node.offset);
  return archive.subarray(start, start + node.size).toString('utf8');
}

/** 列出 asar 内指定目录的所有文件，确保 Vite 动态 chunk 也进入发布文案门禁。 */
export function listAsarFilePaths(asarPath, innerDirectory) {
  const { header } = readAsarArchive(asarPath);
  const directory = resolveAsarNode(header, innerDirectory);
  if (!directory.files) throw new Error(`asar path is not a directory: ${innerDirectory}`);
  const paths = [];
  const visit = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files ?? {})) {
      const path = posix.join(prefix, name);
      if (child.files) visit(child, path);
      else if (typeof child.size === 'number' && typeof child.offset === 'string') paths.push(path);
    }
  };
  visit(directory, innerDirectory.replace(/^\/+|\/+$/g, ''));
  return paths;
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

  const forbiddenStartupCopy = ['正在启动本地服务', '正在连接本地服务', '本地服务连接失败', '本机 API 暂不可用', 'Connecting local service', 'Local service unavailable', 'Local API temporarily unavailable'];
  if (!html.includes('zeus-startup-loader') || !html.includes('prefers-reduced-motion')) {
    throw new Error('packaged renderer is missing the Zeus startup shell contract');
  }
  const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]).filter((ref) => ref.includes('assets/'));
  if (assetRefs.length === 0) {
    throw new Error('packaged renderer index.html does not reference built assets');
  }

  for (const ref of assetRefs) {
    const assetPath = posix.normalize(posix.join(posix.dirname(htmlPath), ref));
    readAsarTextFile(asarPath, assetPath);
  }

  const rendererTextPaths = listAsarFilePaths(asarPath, 'dist/renderer').filter((path) => /\.(?:html|js|mjs|css|svg|json)$/u.test(path));
  for (const path of rendererTextPaths) {
    const content = readAsarTextFile(asarPath, path);
    for (const forbidden of forbiddenStartupCopy) {
      if (content.includes(forbidden)) {
        throw new Error(`packaged renderer exposes forbidden startup infrastructure copy: ${forbidden} (${path})`);
      }
    }
  }

  return { htmlPath, assetCount: assetRefs.length };
}

/** sandbox: true 的 preload 不能在运行时加载项目内相对 CommonJS 模块，发布包必须是单文件 bundle。 */
export function assertPackagedPreloadEntrypoint(asarPath) {
  const preloadPath = 'dist/preload/index.cjs';
  const preload = readAsarTextFile(asarPath, preloadPath);
  if (/\brequire\(\s*['"]\.{1,2}\//u.test(preload)) {
    throw new Error('sandboxed preload contains relative CommonJS require; bundle the preload into one file');
  }
  return { preloadPath };
}

export function verifyPackagedApp(appPath) {
  const appRoot = resolve(appPath);
  const asarPath = join(appRoot, 'Contents/Resources/app.asar');
  const renderer = assertPackagedRendererEntrypoint(asarPath);
  const preload = assertPackagedPreloadEntrypoint(asarPath);
  const mainPackage = JSON.parse(readAsarTextFile(asarPath, 'package.json'));
  if (mainPackage?.name !== '@zeus/desktop' || mainPackage?.main !== 'dist/main/main.js') {
    throw new Error(`unexpected packaged app metadata: ${JSON.stringify({ name: mainPackage?.name, main: mainPackage?.main })}`);
  }
  readAsarTextFile(asarPath, mainPackage.main);
  return {
    appName: 'Zeus',
    assetCount: renderer.assetCount,
    main: mainPackage.main,
    preload: preload.preloadPath,
  };
}

async function main() {
  const appPath = process.argv[2];
  if (!appPath) {
    console.error('Zeus packaged health: missing Zeus.app path');
    process.exit(2);
  }
  const health = verifyPackagedApp(appPath);
  console.log(`packaged-health=${health.appName};rendererAssets=${health.assetCount};main=${health.main};preload=${health.preload}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
