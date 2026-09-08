#!/usr/bin/env node
/* global console, process */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, posix, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL, URL } from 'node:url';

/** 只读取完整包的身份，不执行包内程序；打包和运行验收共用这一检查。 */
function verifyPackagedAppIdentity(appPath, variant) {
  if (!['test', 'release'].includes(variant)) throw new Error('只接受标准 Zeus 或 Zeus Test 应用包。');
  /** 通过系统属性表工具读取真实包元信息。 */
  const readInfo = (key) => {
    try {
      return execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(appPath, 'Contents', 'Info.plist')], { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 }).trim();
    } catch {
      throw new Error(`Zeus 应用包缺少有效的 ${key}；请使用 pnpm package:mac 构建完整测试包。`);
    }
  };
  /** 测试身份的包名、进程名和应用身份必须保持一致。 */
  const expected = variant === 'test' ? { bundleId: 'dev.hypha.zeus.test', name: 'Zeus Test', executable: 'Zeus Test' } : { bundleId: 'dev.hypha.zeus', name: 'Zeus', executable: 'Zeus' };
  /** 同时读取用户可见版本和构建版本，禁止验收样本只改其中之一。 */
  const actual = { bundleId: readInfo('CFBundleIdentifier'), name: readInfo('CFBundleName'), executable: readInfo('CFBundleExecutable'), version: readInfo('CFBundleShortVersionString'), buildVersion: readInfo('CFBundleVersion') };
  if (basename(appPath) !== `${expected.name}.app` || actual.bundleId !== expected.bundleId || actual.name !== expected.name || actual.executable !== expected.executable || actual.version !== actual.buildVersion) {
    throw new Error(`Zeus 应用包身份不一致：variant=${variant} actual=${JSON.stringify(actual)}；请使用 pnpm package:mac 构建完整测试包。`);
  }
  return actual;
}

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
  const preloadPaths = ['dist/preload/index.cjs', 'dist/preload/browser-page.cjs'];
  for (const preloadPath of preloadPaths) {
    const preload = readAsarTextFile(asarPath, preloadPath);
    if (/\brequire\(\s*['"]\.{1,2}\//u.test(preload)) {
      throw new Error(`sandboxed preload contains relative CommonJS require; bundle the preload into one file (${preloadPath})`);
    }
  }
  return { preloadPath: preloadPaths[0], browserPagePreloadPath: preloadPaths[1] };
}

/** Zeus 只依赖用户本机安装的 Codex，正式包不得重新夹带二进制或供应链元数据。 */
export function assertNoPackagedCodexRuntime(appRoot) {
  const runtimeRoot = join(appRoot, 'Contents/Resources/codex');
  if (existsSync(runtimeRoot)) throw new Error(`packaged app must not contain Codex runtime resources: ${runtimeRoot}`);
  return { dependency: 'user-installed' };
}

/** 更新流程依赖独立 AppKit 辅助程序，打包产物必须包含可执行文件，避免菜单进入后才失败。 */
export function assertPackagedUpdateProgressHelper(appRoot) {
  const helperPath = join(appRoot, 'Contents/Resources/app.asar.unpacked/dist/native/ZeusUpdateProgress');
  if (!existsSync(helperPath)) {
    throw new Error(`packaged app is missing native update progress helper: ${helperPath}`);
  }
  if (!statSync(helperPath).isFile()) {
    throw new Error(`packaged update progress helper is not a file: ${helperPath}`);
  }
  try {
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    throw new Error(`packaged update progress helper is not executable: ${helperPath}`, { cause: error });
  }
  return { helperPath };
}

/** 仅验证包身份与内容；成功不代表应用已启动或界面已连接。 */
export function verifyPackagedApp(appPath) {
  const appRoot = resolve(appPath);
  /** 正式产物与测试产物分别校验，拒绝改名的系统小程序样本。 */
  const identity = verifyPackagedAppIdentity(appRoot, basename(appRoot) === 'Zeus Test.app' ? 'test' : 'release');
  const asarPath = join(appRoot, 'Contents/Resources/app.asar');
  const renderer = assertPackagedRendererEntrypoint(asarPath);
  const preload = assertPackagedPreloadEntrypoint(asarPath);
  const mainPackage = JSON.parse(readAsarTextFile(asarPath, 'package.json'));
  if (mainPackage?.name !== '@zeus/desktop' || mainPackage?.main !== 'dist/main/main.js' || mainPackage?.version !== identity.version) {
    throw new Error(`Zeus 包内代码与应用身份不一致：${JSON.stringify({ name: mainPackage?.name, main: mainPackage?.main, codeVersion: mainPackage?.version, appVersion: identity.version })}`);
  }
  readAsarTextFile(asarPath, mainPackage.main);
  const codex = assertNoPackagedCodexRuntime(appRoot);
  const updateProgress = assertPackagedUpdateProgressHelper(appRoot);
  return {
    appName: basename(appRoot, '.app'),
    version: identity.version,
    assetCount: renderer.assetCount,
    main: mainPackage.main,
    preload: preload.preloadPath,
    browserPagePreload: preload.browserPagePreloadPath,
    codex,
    updateProgress,
  };
}

/** 用进程实际可执行文件确认主界面和宿主身份，拒绝失效或指向其他程序的进程号。 */
function assertAppProcess(pid, executablePath) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('运行验收要求有效的应用进程号。');
  /** ps 的 comm 字段只用于核对程序路径，不读取或输出进程环境中的凭据。 */
  const actual = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8', timeout: 5_000 }).trim();
  if (actual !== executablePath) throw new Error(`运行验收进程 ${pid} 不属于指定测试包。`);
}

/** 只检查调用方已启动的隔离测试应用，观察真实心跳推进，不启动、停止应用或模拟宿主响应。 */
export async function verifyRunningTestApp(appPath, userDataPath, pid) {
  /** 原正式发布调用仍只做结构检查；运行检查只允许完整测试包。 */
  const identity = verifyPackagedAppIdentity(resolve(appPath), 'test');
  verifyPackagedApp(appPath);
  /** 两个进程必须使用同一完整测试包的可执行文件。 */
  const executablePath = join(resolve(appPath), 'Contents/MacOS', identity.executable);
  assertAppProcess(pid, executablePath);
  /** 复用现有安全发现文件读取和控制协议，不另建模拟接口。 */
  const protocol = await import('../apps/desktop/dist/main/executionHostProtocol.js');
  /** 复用持久数据根的身份核验，拒绝正式数据和跨根宿主。 */
  const { verifyZeusDataRootHostIdentity } = await import('../apps/desktop/dist/main/dataRootIdentity.js');
  /** 数据根由启动本次测试应用时明确指定。 */
  const root = resolve(userDataPath);
  /** 首次观察锁定真实宿主和连接，后续观察不接受被替换的实例。 */
  const rendezvous = await protocol.readExecutionHostRendezvous(root);
  if (!rendezvous || rendezvous.dataRootIdentity.profile !== 'test' || rendezvous.dataRootIdentity.bundleId !== identity.bundleId || rendezvous.pid === pid) {
    throw new Error('未找到独立测试数据目录对应的真实执行宿主。');
  }
  verifyZeusDataRootHostIdentity({ rootPath: root, expected: rendezvous.dataRootIdentity });
  /** 连接地址只能是本机控制端口，禁止把发现文件中的凭据发送到外部地址。 */
  const address = new URL(rendezvous.controlUrl);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.username || address.password || address.pathname !== '/' || address.search || address.hash) {
    throw new Error('测试执行宿主的控制地址不是有效的本机端口。');
  }
  /** 每次检查都确认端口由该包的宿主进程持有，普通模拟服务器不能代替它。 */
  const assertProcesses = () => {
    assertAppProcess(pid, executablePath);
    assertAppProcess(rendezvous.pid, executablePath);
    /** 只输出监听端口所属进程号，不读取连接数据或认证信息。 */
    const owner = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(rendezvous.pid), `-iTCP:${address.port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', timeout: 5_000 }).trim();
    if (owner !== String(rendezvous.pid)) throw new Error('测试控制端口不属于指定应用的执行宿主。');
  };
  assertProcesses();
  /** 此客户端只用于读取健康状态，不发送注册、心跳或关闭请求。 */
  const client = protocol.createExecutionHostControlClient(rendezvous);
  /** 两次真实心跳之间保持相同连接，排除旧状态和已退出的主界面。 */
  let firstStatus;
  /** 心跳正常每秒推进；给启动抖动留出观察时间，超时后失败而不重启应用。 */
  const deadline = Date.now() + 20_000;
  do {
    assertProcesses();
    /** 请求前后都检查进程，避免进程在请求过程中退出仍被判为成功。 */
    const status = await client.health();
    assertProcesses();
    /** 心跳必须来自本次观察期间仍活跃的界面。 */
    const heartbeatAt = Date.parse(status.uiLease?.lastHeartbeatAt ?? '');
    if (
      status.instanceId !== rendezvous.instanceId ||
      status.pid !== rendezvous.pid ||
      status.protocolVersion !== rendezvous.protocolVersion ||
      !status.uiLease?.connected ||
      !status.uiLease.leaseId ||
      status.uiLease.appVersion !== identity.version ||
      !Number.isFinite(heartbeatAt) ||
      heartbeatAt > Date.now() + 1_000 ||
      Date.now() - heartbeatAt > 15_000
    ) {
      throw new Error('测试应用没有保持有效的真实界面连接，不能通过运行验收。');
    }
    if (firstStatus && status.uiLease.leaseId !== firstStatus.uiLease.leaseId) throw new Error('观察期间测试界面连接已被替换，请核对本次启动进程。');
    if (firstStatus && heartbeatAt > Date.parse(firstStatus.uiLease.lastHeartbeatAt)) {
      return { pid, hostPid: rendezvous.pid, version: identity.version, userDataPath: root, firstHeartbeatAt: firstStatus.uiLease.lastHeartbeatAt, lastHeartbeatAt: status.uiLease.lastHeartbeatAt };
    }
    firstStatus ??= status;
    await delay(500);
  } while (Date.now() < deadline);
  throw new Error('测试界面心跳未在观察期限内推进，运行验收失败。');
}

/** 默认只读检查应用包；显式提供数据根和进程号时才检查真实运行。 */
async function main() {
  /** 所有参数严格解析，避免拼错运行参数后静默退回结构验收。 */
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      // 本任务测试进程使用的独立数据目录。
      'runtime-root': { type: 'string' },
      // 调用方实际启动的测试界面进程号。
      'runtime-pid': { type: 'string' },
    },
  });
  /** 保留原有单个应用包位置参数。 */
  const [appPath] = positionals;
  /** 显式传入空运行参数也必须失败，不能被当成仅检查结构。 */
  const runtimeRequested = values['runtime-root'] !== undefined || values['runtime-pid'] !== undefined;
  if (!appPath || positionals.length !== 1 || (runtimeRequested && (!values['runtime-root']?.trim() || !values['runtime-pid']?.trim()))) {
    throw new Error('用法：node scripts/verify-packaged-app-health.mjs <App绝对路径> [--runtime-root <独立测试数据目录> --runtime-pid <测试界面进程号>]');
  }
  if (runtimeRequested) {
    /** 只有真实进程、宿主身份、端口与推进的心跳均通过才输出运行成功。 */
    const runtime = await verifyRunningTestApp(appPath, values['runtime-root'], Number(values['runtime-pid']));
    console.log(`runtime-health=${JSON.stringify(runtime)}`);
    return;
  }
  const health = verifyPackagedApp(appPath);
  console.log(
    `packaged-health=${health.appName};scope=structure;rendererAssets=${health.assetCount};main=${health.main};preload=${health.preload};browserPagePreload=${health.browserPagePreload};codex=${health.codex.dependency};updateProgress=${basename(health.updateProgress.helperPath)}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
