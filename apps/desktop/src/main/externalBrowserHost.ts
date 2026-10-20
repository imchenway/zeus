import { BrowserWindow, clipboard, ipcMain, nativeImage, type IpcMainEvent } from 'electron';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants as fileConstants, createReadStream } from 'node:fs';
import { copyFile, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { ensurePrivatePathSync, publishFileSync } from '@zeus/storage/platform-security';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import {
  browserFrozenContractEntries,
  browserFrozenArgumentSchema,
  browserFrozenContractEntry,
  browserFrozenContractVersion,
  browserFrozenUnsupportedSurfaceKinds,
  type BrowserAutomationContentItem,
  type BrowserAutomationPort,
  type BrowserAutomationToolCall,
} from '@zeus/local-server';
import type { ZeusBrowserSettings } from '@zeus/shared';
import { closeLocalHttpServer } from './closeLocalHttpServer.js';

type ExternalSurface = 'chrome' | 'edge';

/** 注册表仅通过系统自带程序和参数数组访问，不拼接命令字符串。 */
const runRegistry = promisify(execFileCallback);

interface ExternalConnection {
  extensionId: string;
  connectionId: string;
  lastSeenAt: number;
}

interface QueuedCommand {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  identity: Pick<BrowserAutomationToolCall, 'conversationId' | 'threadId' | 'turnId' | 'callId'>;
}

interface PendingCommand {
  resolve(value: { contentItems: BrowserAutomationContentItem[]; success: boolean }): void;
  timer: ReturnType<typeof setTimeout>;
}

interface SurfaceRuntime {
  enabled: boolean;
  expectedExtensionId: string | null;
  token: string;
  queue: QueuedCommand[];
  waiters: ServerResponse[];
  connection?: ExternalConnection;
}

interface CreateExternalBrowserHostOptions {
  /** 安全登录窗口使用应用语言。 */
  language?: () => 'zh-CN' | 'en-US';
  runtimeRoot: string;
  artifactRoot: string;
  helperExecutable: string;
  testDistribution: boolean;
  readOnlyValidation?: boolean;
  productionChromeExtensionId?: string;
  productionEdgeExtensionId?: string;
}

const chromeTestExtensionId = 'fdmpmokokhlhmcejkdblbhllckhdfiop';
const edgePreviewExtensionId = 'pcnleiehflciojdelkchdjjfefkjphef';
const maximumNativeMessageBytes = 16 * 1024 * 1024;
const requestTimeoutMs = 120_000;
const waiterTimeoutMs = 15_000;

export class ExternalBrowserHost implements BrowserAutomationPort {
  private server: Server | null = null;
  private port: number | null = null;
  private closed = false;
  /** 设置变更串行执行；关闭必须等待迟到的注册写入结束。 */
  private configuration: Promise<unknown> = Promise.resolve();
  /** 所有关闭调用等待同一次清理，不能把进行中的关闭误报为完成。 */
  private closing: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingCommand>();
  private readonly surfaces: Record<ExternalSurface, SurfaceRuntime> = {
    chrome: { enabled: false, expectedExtensionId: null, token: randomBytes(32).toString('base64url'), queue: [], waiters: [] },
    edge: { enabled: false, expectedExtensionId: null, token: randomBytes(32).toString('base64url'), queue: [], waiters: [] },
  };

  constructor(private readonly options: CreateExternalBrowserHostOptions) {}

  async configure(settings: Pick<ZeusBrowserSettings, 'externalChromeEnabled' | 'externalEdgeEnabled'>): Promise<{
    state: NonNullable<ZeusBrowserSettings['externalConnectionState']>;
    detail?: string;
  }> {
    if (this.closed) throw new Error('外部浏览器宿主已关闭。');
    const snapshot = { externalChromeEnabled: settings.externalChromeEnabled, externalEdgeEnabled: settings.externalEdgeEnabled };
    const operation = this.configuration.catch(() => undefined).then(() => this.applyConfiguration(snapshot));
    this.configuration = operation;
    return operation;
  }

  /** 只处理本次冻结的设置；失败不会重放，后续显式设置可以独立执行。 */
  private async applyConfiguration(settings: Pick<ZeusBrowserSettings, 'externalChromeEnabled' | 'externalEdgeEnabled'>): Promise<{
    state: NonNullable<ZeusBrowserSettings['externalConnectionState']>;
    detail?: string;
  }> {
    if (this.closed) throw new Error('外部浏览器宿主已关闭。');
    if (this.options.readOnlyValidation) return { state: 'disabled', detail: '只读验证模式不安装或启动外部浏览器桥。' };
    this.surfaces.chrome.enabled = settings.externalChromeEnabled;
    this.surfaces.edge.enabled = settings.externalEdgeEnabled;
    if (!settings.externalChromeEnabled && !settings.externalEdgeEnabled) {
      await this.stopServer();
      if (process.platform === 'win32') {
        for (const surface of ['chrome', 'edge'] as const) await this.removeWindowsRegistration(surface);
      }
      return { state: 'disabled', detail: 'Chrome 与 Edge 原生桥均已停用。' };
    }
    await this.ensureServer();
    const pendingStoreIds: ExternalSurface[] = [];
    for (const surface of ['chrome', 'edge'] as const) {
      const runtime = this.surfaces[surface];
      if (!runtime.enabled) {
        if (process.platform === 'win32') await this.removeWindowsRegistration(surface);
        continue;
      }
      const extensionId = this.extensionId(surface);
      runtime.expectedExtensionId = extensionId;
      if (!extensionId) {
        pendingStoreIds.push(surface);
        continue;
      }
      await this.installSurface(surface, extensionId);
    }
    if (pendingStoreIds.length > 0) {
      return { state: 'store_id_pending', detail: `${pendingStoreIds.join('、')} 的生产扩展 ID 尚未绑定；未写入通配 allowed_origins。` };
    }
    const connected = (['chrome', 'edge'] as const).filter((surface) => this.surfaces[surface].enabled && this.isConnected(surface));
    return connected.length > 0 ? { state: 'connected', detail: `已连接：${connected.join('、')}。` } : { state: 'waiting', detail: 'Native Messaging Host 已安装，正在等待已授权扩展连接。' };
  }

  async invoke(input: BrowserAutomationToolCall): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const surface = input.arguments.surface;
    if (surface !== 'chrome' && surface !== 'edge') return textResult('外部浏览器调用必须明确指定 chrome 或 edge surface。', false);
    const runtime = this.surfaces[surface];
    if (!runtime.enabled) return textResult(`Zeus ${surface} 原生桥尚未在设置中启用。`, false);
    if (!runtime.expectedExtensionId) return textResult(`Zeus ${surface} 生产扩展 ID 尚未绑定，禁止使用通配 allowed_origins。`, false);
    if (!this.isConnected(surface)) return textResult(`Zeus ${surface} 扩展未连接。请确认扩展已加载且 Native Messaging Host 可用。`, false);
    if (input.tool === 'catalog') return this.catalog(surface, input.arguments);
    if (input.tool === 'clipboard') return this.performClipboard(input.arguments);
    if (input.tool === 'invoke') {
      const path = requireString(input.arguments.path, 'path');
      const contract = browserFrozenContractEntry(path);
      if (!contract) return textResult(`Method path is not in Browser ${browserFrozenContractVersion}: ${path}`, false);
      if (path === 'Documentation.get') {
        const name = requireString(asRecord(input.arguments.arguments).name, 'name');
        const entry = browserFrozenContractEntry(name);
        return jsonResult({
          version: browserFrozenContractVersion,
          entries: entry ? [{ ...entry, argumentSchema: browserFrozenArgumentSchema(entry.path), unsupportedOn: browserFrozenUnsupportedSurfaceKinds(entry.path) }] : [],
        });
      }
      if (path.startsWith('TabClipboardAPI.')) return this.performAdvancedClipboard(surface, input, path, asRecord(input.arguments.arguments));
      if (path === 'BrowserAuthTabCapability.request') return this.performBrowserAuth(surface, input);
    }
    try {
      const argumentsValue = withoutSurface(input.arguments);
      const identity = { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId, callId: input.callId };
      return await this.enqueue(surface, {
        id: `browser-${randomUUID()}`,
        tool: input.tool,
        arguments: argumentsValue,
        identity,
      });
    } catch (error) {
      const record = asRecord(error);
      const code = typeof record.code === 'string' ? record.code : 'ZEUS_BROWSER_EXTENSION_REQUEST_FAILED';
      return textResult(`${code}: ${error instanceof Error ? error.message : String(error)}`, false);
    }
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.finishClose();
    return this.closing;
  }

  /** 先排空已接受的配置，再撤销本实例注册，防止退出后重新开放端口。 */
  private async finishClose(): Promise<void> {
    await this.configuration.catch(() => undefined);
    await this.stopServer();
    if (process.platform === 'win32') {
      for (const surface of ['chrome', 'edge'] as const) await this.removeWindowsRegistration(surface);
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve(textResult('Zeus 外部浏览器宿主已关闭。', false));
      this.pending.delete(id);
    }
  }

  private catalog(surface: ExternalSurface, args: Record<string, unknown>): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
    const group = typeof args.group === 'string' ? args.group.toLocaleLowerCase() : '';
    const query = typeof args.query === 'string' ? args.query.toLocaleLowerCase() : '';
    const entries = browserFrozenContractEntries
      .filter((entry) => (!group || entry.group.toLocaleLowerCase() === group) && (!query || entry.path.toLocaleLowerCase().includes(query)))
      .map((entry) => ({ ...entry, argumentSchema: browserFrozenArgumentSchema(entry.path), unsupportedOn: browserFrozenUnsupportedSurfaceKinds(entry.path) }));
    return jsonResult({ version: browserFrozenContractVersion, surface, count: entries.length, entries });
  }

  private performClipboard(args: Record<string, unknown>): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
    const action = requireString(args.action, 'action');
    if (action === 'read') return jsonResult({ text: clipboard.readText(), format: 'text/plain' });
    if (action === 'write') {
      clipboard.writeText(typeof args.text === 'string' ? args.text : '');
      return jsonResult({ written: true, format: 'text/plain' });
    }
    return textResult(`ZEUS_BROWSER_ARGUMENT_INVALID: unsupported clipboard action ${action}.`, false);
  }

  private async performAdvancedClipboard(surface: ExternalSurface, input: BrowserAutomationToolCall, path: string, args: Record<string, unknown>): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const validation = await this.enqueue(surface, {
      id: `browser-clipboard-${randomUUID()}`,
      tool: 'invoke',
      arguments: { ...withoutSurface(input.arguments), arguments: { ...args, __phase: 'validate' } },
      identity: { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId, callId: `${input.callId}:clipboard-validate` },
    });
    if (!validation.success) return validation;
    if (path === 'TabClipboardAPI.readText') return jsonResult(clipboard.readText());
    if (path === 'TabClipboardAPI.read') {
      const entries = clipboard.availableFormats().map((mimeType) => {
        if (mimeType === 'text/plain') return { mimeType, text: clipboard.readText() };
        if (mimeType === 'text/html') return { mimeType, text: clipboard.readHTML() };
        if (mimeType === 'text/rtf') return { mimeType, text: clipboard.readRTF() };
        return { mimeType, base64: clipboard.readBuffer(mimeType).toString('base64') };
      });
      return jsonResult([{ entries, presentationStyle: 'unspecified' }]);
    }
    if (path === 'TabClipboardAPI.writeText') {
      clipboard.writeText(typeof args.text === 'string' ? args.text : '');
      return jsonResult({ written: true });
    }
    if (path === 'TabClipboardAPI.write') {
      const items = Array.isArray(args.items) ? args.items.map(asRecord) : [];
      const entries = items.flatMap((item) => (Array.isArray(item.entries) ? item.entries.map(asRecord) : []));
      if (entries.length === 0) return textResult('ZEUS_BROWSER_CLIPBOARD_FORMAT_INVALID: at least one clipboard entry is required.', false);
      const data: Electron.Data = {};
      const custom: Array<{ mimeType: string; bytes: Buffer }> = [];
      for (const entry of entries) {
        const mimeType = requireString(entry.mimeType, 'mimeType');
        const text = typeof entry.text === 'string' ? entry.text : undefined;
        const bytes = typeof entry.base64 === 'string' ? Buffer.from(entry.base64, 'base64') : text === undefined ? undefined : Buffer.from(text, 'utf8');
        if (mimeType === 'text/plain' && text !== undefined) data.text = text;
        else if (mimeType === 'text/html' && text !== undefined) data.html = text;
        else if (mimeType === 'text/rtf' && text !== undefined) data.rtf = text;
        else if (mimeType === 'image/png' && bytes) data.image = nativeImage.createFromBuffer(bytes);
        else if (bytes) custom.push({ mimeType, bytes });
      }
      if (Object.keys(data).length > 0) clipboard.write(data);
      for (const entry of custom) clipboard.writeBuffer(entry.mimeType, entry.bytes);
      return jsonResult({ written: true, formats: entries.map((entry) => entry.mimeType) });
    }
    return textResult(`ZEUS_BROWSER_METHOD_NOT_IMPLEMENTED: ${path}`, false);
  }

  private async ensureServer(): Promise<void> {
    if (this.closed) throw new Error('外部浏览器宿主已关闭。');
    if (this.server && this.port) return;
    const server = createServer((request, response) => void this.handleNativeRequest(request, response));
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen);
      server.listen(0, '127.0.0.1', () => resolveListen());
    });
    const address = server.address() as AddressInfo | null;
    if (!address) throw new Error('Zeus 无法获得外部浏览器 rendezvous 端口。');
    this.server = server;
    this.port = address.port;
    for (const surface of ['chrome', 'edge'] as const) {
      this.surfaces[surface].token = randomBytes(32).toString('base64url');
      this.surfaces[surface].connection = undefined;
    }
  }

  private async stopServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    for (const surface of ['chrome', 'edge'] as const) {
      const runtime = this.surfaces[surface];
      runtime.connection = undefined;
      runtime.queue.length = 0;
      for (const response of runtime.waiters.splice(0)) this.respondNative(response, { type: 'noop' });
    }
    await closeLocalHttpServer(server);
    await Promise.all((['chrome', 'edge'] as const).map((surface) => rm(join(resolve(this.options.runtimeRoot, surface), 'rendezvous.json'), { force: true })));
  }

  private async installSurface(surface: ExternalSurface, extensionId: string): Promise<void> {
    if (!this.port) throw new Error('Zeus 外部浏览器 rendezvous 尚未启动。');
    const runtime = this.surfaces[surface];
    const surfaceRoot = resolve(this.options.runtimeRoot, surface);
    const helperPath = join(surfaceRoot, process.platform === 'win32' ? 'ZeusBrowserNativeHost.exe' : 'ZeusBrowserNativeHost');
    await mkdir(surfaceRoot, { recursive: true, mode: 0o700 });
    if (process.platform === 'win32') {
      ensurePrivatePathSync(surfaceRoot, 'directory');
      await installWindowsBrowserHelper(this.options.helperExecutable, helperPath);
    } else {
      await copyFile(this.options.helperExecutable, helperPath);
      await import('node:fs/promises').then(({ chmod }) => chmod(helperPath, 0o700));
    }
    await atomicJson(join(surfaceRoot, 'rendezvous.json'), {
      endpoint: `http://127.0.0.1:${this.port}/native`,
      token: runtime.token,
      surface,
      pid: process.pid,
      extensionId,
    });
    const manifestDirectory =
      process.platform === 'win32'
        ? surfaceRoot
        : surface === 'chrome'
          ? join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
          : join(homedir(), 'Library', 'Application Support', 'Microsoft Edge', 'NativeMessagingHosts');
    await mkdir(manifestDirectory, { recursive: true, mode: 0o700 });
    await atomicJson(join(manifestDirectory, `${this.nativeHostName()}.json`), {
      name: this.nativeHostName(),
      description: `Zeus ${surface} native browser host`,
      path: helperPath,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    });
    if (process.platform === 'win32') {
      await runRegistry(windowsRegistryExecutable(), ['add', this.windowsRegistrationKey(surface), '/ve', '/t', 'REG_SZ', '/d', join(manifestDirectory, `${this.nativeHostName()}.json`), '/f', '/reg:64'], {
        windowsHide: true,
        timeout: 5000,
      });
    }
  }

  /** 每种浏览器使用独立的当前用户注册项，正式版和验收版互不覆盖。 */
  private windowsRegistrationKey(surface: ExternalSurface): string {
    return `HKCU\\Software\\${surface === 'chrome' ? 'Google\\Chrome' : 'Microsoft\\Edge'}\\NativeMessagingHosts\\${this.nativeHostName()}`;
  }

  /** 仅清理仍指向本实例清单的注册值，不删除另一实例新登记的路径。 */
  private async removeWindowsRegistration(surface: ExternalSurface): Promise<void> {
    const key = this.windowsRegistrationKey(surface);
    let value: string;
    try {
      const { stdout } = await runRegistry(windowsRegistryExecutable(), ['query', key, '/ve', '/reg:64'], { windowsHide: true, timeout: 5000 });
      value = /REG_SZ\s+([^\r\n]+)/u.exec(stdout)?.[1]?.trim() ?? '';
    } catch (error) {
      // 查询失败不据此删除注册项；下次明确配置时仍会完整检查登记结果。
      if ((error as { code?: unknown }).code === 1) return;
      throw error;
    }
    const expected = join(resolve(this.options.runtimeRoot, surface), `${this.nativeHostName()}.json`);
    if (value.toLocaleLowerCase() !== expected.toLocaleLowerCase()) return;
    await runRegistry(windowsRegistryExecutable(), ['delete', key, '/ve', '/f', '/reg:64'], { windowsHide: true, timeout: 5000 });
  }

  private async handleNativeRequest(request: import('node:http').IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (this.closed) return this.rejectNative(response, 503);
      if (request.method !== 'POST' || request.url !== '/native') return this.rejectNative(response, 404);
      const surfaceHeader = request.headers['x-zeus-browser-surface'];
      const surface = surfaceHeader === 'chrome' || surfaceHeader === 'edge' ? surfaceHeader : null;
      if (!surface || !this.surfaces[surface].enabled) return this.rejectNative(response, 403);
      if (!this.authorized(request.headers.authorization, this.surfaces[surface].token)) return this.rejectNative(response, 401);
      const body = await readRequestBody(request);
      // 请求体读取期间可能已开始退出，迟到请求不能重新登记连接或派发命令。
      if (this.closed) return this.rejectNative(response, 503);
      const message = JSON.parse(body.toString('utf8')) as unknown;
      const record = asRecord(message);
      const runtime = this.surfaces[surface];
      if (record.type === 'hello') {
        const extensionId = typeof record.extensionId === 'string' ? record.extensionId : '';
        const connectionId = typeof record.connectionId === 'string' ? record.connectionId : '';
        if (!runtime.expectedExtensionId || extensionId !== runtime.expectedExtensionId) return this.rejectNative(response, 403);
        if (!/^[0-9a-f-]{36}$/iu.test(connectionId)) return this.rejectNative(response, 403);
        if (runtime.connection && runtime.connection.connectionId !== connectionId && Date.now() - runtime.connection.lastSeenAt <= waiterTimeoutMs + 10_000) {
          return this.rejectNative(response, 409);
        }
        runtime.connection = { extensionId, connectionId, lastSeenAt: Date.now() };
      } else if (record.type === 'result' && typeof record.id === 'string') {
        if (!runtime.connection || record.connectionId !== runtime.connection.connectionId) return this.rejectNative(response, 409);
        runtime.connection = { ...runtime.connection, lastSeenAt: Date.now() };
        await this.resolveCommand(surface, record);
      } else if (record.type === 'poll') {
        if (!runtime.connection || record.connectionId !== runtime.connection.connectionId) return this.rejectNative(response, 409);
        runtime.connection = { ...runtime.connection, lastSeenAt: Date.now() };
      } else if (record.type === 'host_error') {
        runtime.connection = undefined;
      }
      // 结果处理也会异步落盘，关闭后不能再把迟到响应加入长轮询队列。
      if (this.closed || response.destroyed) return;
      const next = runtime.queue.shift();
      if (next) return this.respondNative(response, { type: 'command', ...next });
      runtime.waiters.push(response);
      const timer = setTimeout(() => {
        const index = runtime.waiters.indexOf(response);
        if (index >= 0) runtime.waiters.splice(index, 1);
        this.respondNative(response, { type: 'noop' });
      }, waiterTimeoutMs);
      timer.unref();
      response.once('close', () => clearTimeout(timer));
    } catch {
      this.rejectNative(response, 400);
    }
  }

  private enqueue(surface: ExternalSurface, command: QueuedCommand): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const runtime = this.surfaces[surface];
    return new Promise((resolveCommand) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.id);
        resolveCommand(textResult(`ZEUS_BROWSER_EXTENSION_TIMEOUT: ${surface} 扩展调用超时。`, false));
      }, requestTimeoutMs);
      timer.unref();
      this.pending.set(command.id, { resolve: resolveCommand, timer });
      const waiter = runtime.waiters.shift();
      if (waiter) this.respondNative(waiter, { type: 'command', ...command });
      else runtime.queue.push(command);
    });
  }

  private async resolveCommand(surface: ExternalSurface, record: Record<string, unknown>): Promise<void> {
    const pending = this.pending.get(String(record.id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(record.id));
    if (record.success !== true) {
      const error = asRecord(record.error);
      pending.resolve(textResult(`${typeof error.code === 'string' ? error.code : 'ZEUS_BROWSER_EXTENSION_OPERATION_FAILED'}: ${typeof error.message === 'string' ? error.message : 'External browser operation failed.'}`, false));
      return;
    }
    const items: BrowserAutomationContentItem[] = [];
    let value = record.value;
    if (Array.isArray(record.artifacts) && record.artifacts.length > 0) {
      const primaryArtifact = asRecord(value).__zeusPrimaryArtifact === true;
      const directoryPath = join(resolve(this.options.artifactRoot), 'external-browser-assets', `${surface}-${Date.now()}-${randomUUID()}`);
      await mkdir(directoryPath, { recursive: true, mode: 0o700 });
      const artifacts: Array<Record<string, unknown>> = [];
      let totalBytes = 0;
      for (const [index, entryValue] of record.artifacts.slice(0, 100).entries()) {
        const entry = asRecord(entryValue);
        if (typeof entry.data !== 'string') continue;
        const data = Buffer.from(entry.data, 'base64');
        totalBytes += data.byteLength;
        if (data.byteLength > 8 * 1024 * 1024 || totalBytes > 12 * 1024 * 1024) continue;
        const name = sanitizeName(typeof entry.name === 'string' ? entry.name : `asset-${index}`, `asset-${index}`);
        const path = join(directoryPath, `${String(index + 1).padStart(3, '0')}-${name}`);
        await import('node:fs/promises').then(({ writeFile }) => writeFile(path, data, { mode: 0o600 }));
        const { data: _data, ...metadata } = entry;
        void _data;
        artifacts.push({ ...metadata, path, byteLength: data.byteLength });
      }
      value = primaryArtifact ? (artifacts[0]?.path ?? null) : { ...asRecord(value), directoryPath, artifacts };
    }
    if (typeof record.image === 'string' && record.image.startsWith('data:image/')) {
      const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/iu.exec(record.image);
      if (match) {
        const data = Buffer.from(match[2]!, 'base64');
        if (data.byteLength > 0 && data.byteLength <= 30 * 1024 * 1024) {
          const directoryPath = join(resolve(this.options.artifactRoot), 'external-browser-screenshots', `${surface}-${Date.now()}-${randomUUID()}`);
          await mkdir(directoryPath, { recursive: true, mode: 0o700 });
          const artifactPath = join(directoryPath, 'screenshot.png');
          const handle = await open(artifactPath, 'wx', 0o600);
          try {
            await handle.writeFile(data);
            await handle.sync();
          } finally {
            await handle.close();
          }
          value = { ...asRecord(value), artifactPath, mimeType: match[1], byteLength: data.byteLength };
        }
      }
    }
    if ('value' in record) items.push({ type: 'inputText', text: JSON.stringify(value, null, 2) });
    if (typeof record.image === 'string' && record.image.startsWith('data:image/')) items.push({ type: 'inputImage', imageUrl: record.image });
    if (items.length === 0) items.push({ type: 'inputText', text: 'null' });
    pending.resolve({ contentItems: items, success: true });
  }

  private respondNative(response: ServerResponse, value: unknown): void {
    if (response.writableEnded || response.destroyed) return;
    // 现有心跳和命令响应携带可选语言，不增加扩展请求权限。
    const data = Buffer.from(JSON.stringify({ ...asRecord(value), language: this.options.language?.() ?? 'zh-CN' }));
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(data.byteLength), 'cache-control': 'no-store' });
    response.end(data);
  }

  private rejectNative(response: ServerResponse, status: number): void {
    if (response.writableEnded || response.destroyed) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end('{"type":"noop"}');
  }

  private authorized(header: string | undefined, token: string): boolean {
    if (!header?.startsWith('Bearer ')) return false;
    const supplied = Buffer.from(header.slice('Bearer '.length));
    const expected = Buffer.from(token);
    return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
  }

  private extensionId(surface: ExternalSurface): string | null {
    if (this.options.testDistribution) return surface === 'chrome' ? chromeTestExtensionId : edgePreviewExtensionId;
    const value = surface === 'chrome' ? this.options.productionChromeExtensionId : this.options.productionEdgeExtensionId;
    return validExtensionId(value) ? value! : null;
  }

  private nativeHostName(): string {
    return this.options.testDistribution ? 'dev.hypha.zeus.test.browser_host' : 'dev.hypha.zeus.browser_host';
  }

  private isConnected(surface: ExternalSurface): boolean {
    const connection = this.surfaces[surface].connection;
    return Boolean(connection && Date.now() - connection.lastSeenAt <= waiterTimeoutMs + 10_000);
  }

  private async performBrowserAuth(surface: ExternalSurface, input: BrowserAutomationToolCall): Promise<{ contentItems: BrowserAutomationContentItem[]; success: boolean }> {
    const requestArguments = asRecord(input.arguments.arguments);
    const validation = await this.enqueue(surface, {
      id: `browser-${randomUUID()}`,
      tool: 'invoke',
      arguments: { ...withoutSurface(input.arguments), arguments: { ...requestArguments, __phase: 'validate' } },
      identity: { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId, callId: `${input.callId}:validate` },
    });
    if (!validation.success) return validation;
    const validationValue = parseOnlyTextJson(validation);
    const validationRecord = asRecord(validationValue);
    if (validationRecord.origin !== requestArguments.origin) return jsonResult({ status: 'origin_changed' });
    const invalidField = Array.isArray(validationRecord.fields) ? validationRecord.fields.map(asRecord).find((field) => field.valid !== true) : undefined;
    if (invalidField) return jsonResult({ status: 'locator_invalid', locator_error: { field_id: invalidField.id, reason: 'not_user_visible' } });
    const fields = Array.isArray(requestArguments.fields) ? requestArguments.fields.filter(isRecord).slice(0, 20) : [];
    const options = Array.isArray(requestArguments.options) ? requestArguments.options.filter(isRecord).slice(0, 20) : [];
    const secure = await this.collectSecureCredentials(String(requestArguments.origin), fields, options);
    if (secure.status !== 'submitted') return jsonResult({ status: secure.status });
    try {
      return await this.enqueue(surface, {
        id: `browser-${randomUUID()}`,
        tool: 'invoke',
        arguments: { ...withoutSurface(input.arguments), arguments: { ...requestArguments, __phase: 'fill', __secureValues: secure.values, ...(secure.selectedOption ? { __selectedOption: secure.selectedOption } : {}) } },
        identity: { conversationId: input.conversationId, threadId: input.threadId, turnId: input.turnId, callId: `${input.callId}:fill` },
      });
    } finally {
      for (const key of Object.keys(secure.values)) secure.values[key] = '';
    }
  }

  private collectSecureCredentials(origin: string, fields: Record<string, unknown>[], options: Record<string, unknown>[]): Promise<{ status: 'submitted' | 'cancelled'; values: Record<string, string>; selectedOption?: string }> {
    const token = randomUUID();
    const channel = `zeus:external-browser-auth:${token}`;
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
    const window = new BrowserWindow({
      ...(parent ? { parent, modal: true } : {}),
      show: false,
      width: 460,
      height: Math.min(720, 260 + fields.length * 74 + options.length * 44),
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: this.options.language?.() === 'en-US' ? 'Sign in with Zeus' : '通过 Zeus 登录',
      webPreferences: { contextIsolation: false, nodeIntegration: true, sandbox: false, devTools: false },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    const safeFields = fields.map((field) => ({ id: String(field.id ?? ''), label: String(field.label ?? field.id ?? 'Credential').slice(0, 100), type: secureInputType(field.type), required: field.required === true }));
    const safeOptions = options.map((option) => ({ id: String(option.id ?? ''), label: String(option.label ?? option.id ?? 'Option').slice(0, 100) }));
    const configuration = JSON.stringify({ origin, fields: safeFields, options: safeOptions, channel, token }).replaceAll('<', '\\u003c');
    const html = `<!doctype html><html lang="${this.options.language?.() ?? 'zh-CN'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>body{font:14px -apple-system,sans-serif;margin:0;background:#11151b;color:#f5f7f6}main{padding:24px}h1{font-size:20px;margin:0 0 6px}p{color:#aeb8b5;margin:0 0 18px;word-break:break-all}label{display:block;margin:12px 0 5px}input[type=text],input[type=email],input[type=tel],input[type=password]{box-sizing:border-box;width:100%;padding:10px;border:1px solid #39433f;border-radius:8px;background:#1b2229;color:#fff}.option{display:flex;gap:8px;align-items:center}.actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}button{padding:9px 15px;border-radius:8px;border:1px solid #44514d;background:#252e35;color:#fff}button.primary{background:#55bda1;color:#07120f;border-color:#55bda1}</style></head><body><main><h1>${this.options.language?.() === 'en-US' ? 'Sign in with Zeus' : '通过 Zeus 登录'}</h1><p id="origin"></p><form id="form"><div id="options"></div><div id="fields"></div><div class="actions"><button type="button" id="cancel">${this.options.language?.() === 'en-US' ? 'Cancel' : '取消'}</button><button class="primary" type="submit">${this.options.language?.() === 'en-US' ? 'Continue' : '继续'}</button></div></form></main><script>const {ipcRenderer}=require('electron');const config=${configuration};document.getElementById('origin').textContent=config.origin;const options=document.getElementById('options');for(const option of config.options){const label=document.createElement('label');label.className='option';const input=document.createElement('input');input.type='radio';input.name='selectedOption';input.value=option.id;label.append(input,document.createTextNode(option.label));options.append(label)}const fields=document.getElementById('fields');for(const field of config.fields){const label=document.createElement('label');label.textContent=field.label;const input=document.createElement('input');input.type=field.type;input.name=field.id;input.required=field.required;input.autocomplete='off';label.append(input);fields.append(label)}const finish=(status)=>{const values={};for(const field of config.fields){const input=document.querySelector('[name="'+CSS.escape(field.id)+'"]');values[field.id]=input?.value||'';if(input)input.value=''}const selectedOption=document.querySelector('[name=selectedOption]:checked')?.value;ipcRenderer.send(config.channel,{token:config.token,status,values,selectedOption})};document.getElementById('cancel').onclick=()=>finish('cancelled');document.getElementById('form').onsubmit=(event)=>{event.preventDefault();finish('submitted')}</script></body></html>`;
    return new Promise((resolveCredentials) => {
      let resolved = false;
      const finish = (value: { status: 'submitted' | 'cancelled'; values: Record<string, string>; selectedOption?: string }) => {
        if (resolved) return;
        resolved = true;
        ipcMain.removeListener(channel, listener);
        if (!window.isDestroyed()) window.destroy();
        resolveCredentials(value);
      };
      const listener = (event: IpcMainEvent, payload: unknown) => {
        if (event.sender.id !== window.webContents.id) return;
        const record = asRecord(payload);
        if (record.token !== token) return;
        const raw = asRecord(record.values);
        const values = Object.fromEntries(safeFields.map((field) => [field.id, typeof raw[field.id] === 'string' ? (raw[field.id] as string) : '']));
        finish({ status: record.status === 'submitted' ? 'submitted' : 'cancelled', values, ...(typeof record.selectedOption === 'string' ? { selectedOption: record.selectedOption } : {}) });
      };
      ipcMain.on(channel, listener);
      window.once('closed', () => finish({ status: 'cancelled', values: {} }));
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).then(() => window.show());
    });
  }
}

export function createExternalBrowserHost(options: CreateExternalBrowserHostOptions): ExternalBrowserHost {
  return new ExternalBrowserHost(options);
}

/** 在私有目录中持久发布会合信息，Windows 不以 chmod 模拟访问控制。 */
async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') ensurePrivatePathSync(dirname(path), 'directory');
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform === 'win32') {
    ensurePrivatePathSync(temporary, 'file');
    publishFileSync(temporary, path, { replace: true });
    return;
  }
  await rename(temporary, path);
  const descriptor = await stat(path);
  if ((descriptor.mode & 0o077) !== 0) await import('node:fs/promises').then(({ chmod }) => chmod(path, 0o600));
}

/** 定位系统注册表程序，避免依赖调用方 PATH 中的同名程序。 */
function windowsRegistryExecutable(): string {
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
}

/** 流式校验原生程序，避免把自带运行时的大文件整体加载到内存。 */
async function nativeHelperDigest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** 相同程序不覆盖运行中的 Windows 文件；升级失败保留明确的重新连接提示。 */
async function installWindowsBrowserHelper(source: string, target: string): Promise<void> {
  try {
    await copyFile(source, target, fileConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const [sourceHash, targetHash] = await Promise.all([nativeHelperDigest(source), nativeHelperDigest(target)]);
    if (sourceHash !== targetHash) {
      try {
        await copyFile(source, target);
      } catch {
        throw new Error('浏览器原生桥仍被占用，请关闭对应浏览器后重新启用连接。');
      }
    }
  }
  ensurePrivatePathSync(target, 'file');
}

async function readRequestBody(request: import('node:http').IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maximumNativeMessageBytes) throw new Error('Native Messaging request is too large.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function withoutSurface(value: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...value };
  delete rest.surface;
  return rest;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error(`${name} is required.`), { code: 'ZEUS_BROWSER_ARGUMENT_REQUIRED' });
  return value;
}

function validExtensionId(value: string | undefined): boolean {
  return typeof value === 'string' && /^[a-p]{32}$/u.test(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseOnlyTextJson(result: { contentItems: BrowserAutomationContentItem[] }): unknown {
  const text = result.contentItems.find((item): item is Extract<BrowserAutomationContentItem, { type: 'inputText' }> => item.type === 'inputText');
  if (!text) return null;
  try {
    return JSON.parse(text.text) as unknown;
  } catch {
    return null;
  }
}

function secureInputType(value: unknown): 'text' | 'email' | 'tel' | 'password' {
  const type = typeof value === 'string' ? value.toLocaleLowerCase() : 'text';
  if (type === 'email' || type === 'tel' || type === 'password') return type;
  return 'text';
}

function sanitizeName(value: string, fallback: string): string {
  const printable = [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127 || '/\\:'.includes(character) ? '-' : character;
    })
    .join('');
  const normalized = printable
    .normalize('NFKC')
    .replace(/^\.+|\.+$/gu, '')
    .trim()
    .slice(0, 160);
  return normalized || fallback;
}

function textResult(text: string, success: boolean): { contentItems: BrowserAutomationContentItem[]; success: boolean } {
  return { contentItems: [{ type: 'inputText', text }], success };
}

function jsonResult(value: unknown): { contentItems: BrowserAutomationContentItem[]; success: true } {
  return { contentItems: [{ type: 'inputText', text: JSON.stringify(value, null, 2) }], success: true };
}
