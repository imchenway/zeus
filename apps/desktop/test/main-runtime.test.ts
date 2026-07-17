import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CodexAppServerEvent, CodexAppServerManager, CodexServerRequestResponse, CodexThreadStartInput, CodexTransportState, CodexTurnStartInput, CodexTurnSteerInput } from '@zeus/ai-runtime';
import { codexFinalizationOwnershipClaimSymbol, type RunningZeusLocalServer } from '@zeus/local-server';
import { createBeforeQuitCleanupHandler, parseCodexNativeEnabled, startDesktopLocalServer } from '../src/main/localServerRuntime.js';
import { openLocalLogDirectory } from '../src/main/localLogDirectory.js';

class DesktopFakeCodexManager implements CodexAppServerManager {
  readonly threadStarts: CodexThreadStartInput[] = [];
  readonly turnStarts: CodexTurnStartInput[] = [];
  readonly steers: CodexTurnSteerInput[] = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly responses: CodexServerRequestResponse[] = [];
  readonly lifecycle: string[] = [];
  spawnCount = 0;
  subscribeCount = 0;
  unsubscribeCount = 0;
  prepareForShutdownCount = 0;
  closeCount = 0;
  prepareForShutdownFailure: Error | null = null;
  closeFailure: Error | null = null;
  private started = false;
  private threadSequence = 0;
  private turnSequence = 0;
  private readonly listeners = new Set<(event: CodexAppServerEvent) => void>();
  private readonly state: CodexTransportState = {
    type: 'ready',
    generationId: 'desktop-generation',
    capabilities: {
      generationId: 'desktop-generation',
      initializedAt: '2026-07-13T08:00:00.000Z',
      models: [],
      supportedModels: ['gpt-5.4'],
    },
  };

  get listenerCount(): number {
    return this.listeners.size;
  }

  async ensureReady() {
    if (!this.started) {
      this.started = true;
      this.spawnCount += 1;
    }
    if (this.state.type !== 'ready') throw new Error('desktop fake transport unavailable');
    return this.state.capabilities;
  }

  async startThread(input: CodexThreadStartInput) {
    this.threadStarts.push(input);
    return { id: `desktop-thread-${++this.threadSequence}`, turns: [] };
  }

  async resumeThread(input: { threadId: string }) {
    return { id: input.threadId, turns: [] };
  }

  async readThread(input: { threadId: string }) {
    return { id: input.threadId, turns: [] };
  }

  async startTurn(input: CodexTurnStartInput) {
    this.turnStarts.push(input);
    return { id: `desktop-turn-${++this.turnSequence}`, threadId: input.threadId, items: [] };
  }

  async steerTurn(input: CodexTurnSteerInput) {
    this.steers.push(input);
    return { turnId: input.turnId };
  }

  async interruptTurn(input: { threadId: string; turnId: string }) {
    this.lifecycle.push(`interrupt:${input.threadId}:${input.turnId}`);
    this.interrupts.push(input);
  }

  async respondToServerRequest(input: CodexServerRequestResponse) {
    this.lifecycle.push(`respond:${input.type}`);
    this.responses.push(input);
  }

  subscribe(listener: (event: CodexAppServerEvent) => void) {
    this.subscribeCount += 1;
    this.listeners.add(listener);
    return () => {
      if (!this.listeners.delete(listener)) return;
      this.unsubscribeCount += 1;
      this.lifecycle.push('coordinator.unsubscribe');
    };
  }

  getState() {
    return this.state;
  }

  async prepareForShutdown() {
    this.prepareForShutdownCount += 1;
    this.lifecycle.push('manager.prepareForShutdown');
    if (this.prepareForShutdownFailure) throw this.prepareForShutdownFailure;
  }

  async close() {
    this.closeCount += 1;
    this.lifecycle.push('manager.close');
    if (this.closeFailure) throw this.closeFailure;
  }

  async emit(method: string, params: unknown, requestId?: string | number, sequence = 1): Promise<void> {
    const event: CodexAppServerEvent = {
      generationId: 'desktop-generation',
      sequence,
      method,
      params,
      receivedAt: `2026-07-13T08:00:${String(sequence).padStart(2, '0')}.000Z`,
      ...(requestId === undefined ? {} : { requestId }),
    };
    await Promise.all([...this.listeners].map(async (listener) => listener(event)));
  }
}

function createFakeRunningServer(baseUrl: string): {
  running: RunningZeusLocalServer;
  emitClose: () => void;
  prepareForShutdown: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const events = new EventEmitter();
  const prepareForShutdown = vi.fn();
  const close = vi.fn(async () => undefined);
  const running = {
    baseUrl,
    server: { server: { once: (event: string, listener: () => void) => events.once(event, listener) } },
    prepareForShutdown,
    close,
  } as unknown as RunningZeusLocalServer;
  return { running, emitClose: () => events.emit('close'), prepareForShutdown, close };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('Electron main shutdown cleanup', () => {
  it('prevents quit until notification and local server cleanup finish exactly once', async () => {
    let releaseServerClose!: () => void;
    const preventDefault = vi.fn();
    const closeSystemNotifications = vi.fn();
    const closeLocalServer = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseServerClose = resolve;
        }),
    );
    const exitApp = vi.fn();
    const handler = createBeforeQuitCleanupHandler({
      closeSystemNotifications,
      closeLocalServer,
      exitApp,
    });

    handler({ preventDefault });
    handler({ preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(closeSystemNotifications).toHaveBeenCalledTimes(1);
    expect(closeLocalServer).toHaveBeenCalledTimes(1);
    expect(exitApp).not.toHaveBeenCalled();

    releaseServerClose();
    await Promise.resolve();
    await Promise.resolve();

    expect(exitApp).toHaveBeenCalledTimes(1);
    expect(exitApp).toHaveBeenCalledWith(0);
  });
});

describe('Electron main local log directory', () => {
  it('creates the Zeus local log directory before opening it from the native menu', async () => {
    const openedPaths: string[] = [];
    const ensuredDirectories: Array<{ path: string; recursive: boolean }> = [];

    const result = await openLocalLogDirectory({
      dbPath: '/Users/david/Library/Application Support/Zeus/zeus.db',
      fallbackLogsPath: '/Users/david/Library/Logs/Zeus',
      ensureDirectory: async (path, options) => {
        ensuredDirectories.push({
          path,
          recursive: options.recursive === true,
        });
      },
      openPath: async (path) => {
        openedPaths.push(path);
        return '';
      },
    });

    expect(result).toEqual({
      opened: true,
      path: '/Users/david/Library/Application Support/Zeus/zeus.db.logs',
    });
    expect(ensuredDirectories).toEqual([
      {
        path: '/Users/david/Library/Application Support/Zeus/zeus.db.logs',
        recursive: true,
      },
    ]);
    expect(openedPaths).toEqual(['/Users/david/Library/Application Support/Zeus/zeus.db.logs']);
  });
});

describe('Electron main window responsive bounds', () => {
  it('does not force the app window to a fixed desktop minimum size', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

    expect(source).toContain('窗口根层响应式最终覆盖');
    expect(source).not.toMatch(/minWidth:\s*980/);
    expect(source).not.toMatch(/minHeight:\s*720/);
    expect(source).toMatch(/minWidth:\s*360/);
    expect(source).toMatch(/minHeight:\s*560/);
  });

  it('does not let packaged macOS fallback to slash as the graph scan root', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

    expect(source).toContain('function resolveMainProjectRoot()');
    expect(source).toContain('app.isPackaged ? desktopRoot() : process.cwd()');
    expect(source).not.toContain('projectRoot: process.env.ZEUS_PROJECT_ROOT ?? process.cwd()');
    expect(source).not.toContain('projectRoot: process.env.ZEUS_PROJECT_ROOT ?? process.cwd(),');
  });

  it('reveals an existing packaged window on macOS activation and second-instance launch instead of leaving Zeus hidden in the background', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

    expect(source).toContain('function revealMainWindow(window: BrowserWindow): void');
    expect(source).toContain('async function revealOrCreateMainWindow()');
    expect(source).toContain('app.requestSingleInstanceLock()');
    expect(source).toContain("app.on('second-instance'");
    expect(source).toMatch(/app\.on\('activate', \(\) => \{\s*void requestMainWindow\(\);/);
    expect(source).not.toContain('if (!mainWindow || mainWindow.isDestroyed()) await createWindow();');
  });

  it('gates initial launch, activate, second-instance, and reveal actions behind one startup coordinator', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const setupMenuSource = source.slice(source.indexOf('function setupMenu(): void {'), source.indexOf('/** Cmd+N 是会话级动作'));
    const setupTraySource = source.slice(source.indexOf('function setupTray(): void {'), source.indexOf('function setupTraySafely(): void {'));
    const singleInstanceSource = source.slice(source.indexOf('const hasSingleInstanceLock = app.requestSingleInstanceLock();'), source.indexOf("app.on(\n  'before-quit'"));
    const activateSource = source.slice(source.indexOf("app.on('activate', () => {"), source.indexOf('async function loadMainAppShellSettings'));

    expect(source).toContain("import { createStartupCoordinator } from './startupCoordinator.js';");
    expect(source).toContain("import { terminateAfterFatalStartup } from './fatalStartup.js';");
    expect(source).toContain('async function initializeApplication(): Promise<void>');
    expect(source).toContain('const startupCoordinator = createStartupCoordinator({');
    expect(source).toContain('let fatalStartup = false;');
    expect(source).toMatch(/function handleFatalStartupError\(error: unknown\): void \{\s*fatalStartup = true;\s*terminateAfterFatalStartup\(\{/);
    expect(source).toMatch(/function requestMainWindow\(\): Promise<void> \{\s*if \(fatalStartup\) return Promise\.resolve\(\);\s*return startupCoordinator\.requestMainWindow\(\);/);
    expect(singleInstanceSource).toMatch(/if \(!hasSingleInstanceLock\) \{\s*app\.quit\(\);\s*\} else \{\s*app\.on\('second-instance', \(\) => \{\s*void requestMainWindow\(\);\s*\}\);\s*void requestMainWindow\(\);\s*\}/);
    expect(singleInstanceSource).not.toMatch(/(?:revealOrCreateMainWindow|createWindow)\(/);
    expect(activateSource).toMatch(/app\.on\('activate', \(\) => \{\s*void requestMainWindow\(\);\s*\}\);/);
    expect(activateSource).not.toMatch(/(?:revealOrCreateMainWindow|createWindow)\(/);
    expect(setupMenuSource).toMatch(/showMainWindow: \(\) => \{\s*void requestMainWindow\(\);\s*\},/);
    expect(setupMenuSource).not.toMatch(/showMainWindow:[\s\S]*?(?:revealOrCreateMainWindow|createWindow)\(/);
    expect(source).toMatch(/async function startNewConversationFromMenu\(\): Promise<void> \{\s*await requestMainWindow\(\);\s*if \(fatalStartup\) return;\s*mainWindow\?\.webContents\.send/);
    expect(source).toMatch(/async function openSettingsFromMenu\(\): Promise<void> \{\s*await requestMainWindow\(\);\s*if \(fatalStartup\) return;\s*await mainWindow\?\.webContents\.executeJavaScript/);
    expect(source).toMatch(/async function openReleaseStatusFromMenu\(\): Promise<void> \{\s*await requestMainWindow\(\);\s*if \(fatalStartup\) return;\s*await mainWindow\?\.webContents\.executeJavaScript/);
    expect(setupTraySource).toMatch(
      /showMainWindow: \(\) => \{\s*void requestMainWindow\(\);\s*\},\s*createWindow: \(\) => \{\s*if \(fatalStartup\) return;\s*void createWindow\(\)\.catch\(\(error: unknown\) => \{\s*void startupCoordinator\.fail\(error\);\s*\}\);\s*\},/,
    );
    expect(setupTraySource).not.toContain('revealOrCreateMainWindow(');
    expect(source).not.toMatch(/app\.whenReady\(\)\.then\(async/);
    expect(source).not.toMatch(/app\.on\('activate'[\s\S]*await revealOrCreateMainWindow\(\)/);
  });

  it('keeps fatal startup detail in logs while showing one generic native error', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const fatalHandlerSource = source.slice(source.indexOf('function handleFatalStartupError(error: unknown): void {'), source.indexOf('const startupCoordinator = createStartupCoordinator({'));

    expect(fatalHandlerSource).toContain('reportError: (message, detail) => console.error(message, detail)');
    expect(fatalHandlerSource).toContain("dialog.showErrorBox('Zeus', 'Zeus 无法启动，请重新打开应用。')");
    expect(fatalHandlerSource).toContain('terminateAfterFatalStartup({');
    expect(fatalHandlerSource).toContain('quitApplication: () => app.quit()');
    expect(fatalHandlerSource).toContain('forceExit: (code) => app.exit(code)');
  });

  it('routes trusted renderer bootstrap failures into the shared fatal startup exit', async () => {
    const mainSource = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const preloadSource = await readFile(new URL('../src/preload/index.cts', import.meta.url), 'utf8');
    const preloadStateSource = await readFile(new URL('../src/preload/rendererBootstrapState.cjs', import.meta.url), 'utf8');
    const globalSource = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');
    const ipcHandlerStart = mainSource.indexOf("ipcMain.on('zeus:renderer-bootstrap-failed'");
    const ipcHandlerSource = mainSource.slice(ipcHandlerStart, mainSource.indexOf("ipcMain.handle('zeus:open-external-https-url'", ipcHandlerStart));
    const createWindowSource = mainSource.slice(mainSource.indexOf('async function createWindow(): Promise<void>'), mainSource.indexOf('function setupMenu(): void'));
    const preloadErrorAt = createWindowSource.indexOf("window.webContents.once('preload-error'");

    expect(mainSource).toContain("ipcMain.on('zeus:renderer-bootstrap-failed'");
    expect(mainSource).toContain("ipcMain.on('zeus:renderer-bootstrap-ready'");
    expect(mainSource).toContain("ipcMain.on('zeus:renderer-runtime-failed'");
    expect(mainSource).toContain("import { createRendererBootstrapMonitor } from './rendererBootstrapMonitor.js';");
    expect(ipcHandlerSource).toContain('BrowserWindow.fromWebContents(event.sender)');
    expect(ipcHandlerSource).toContain('requestingWindow.isDestroyed()');
    expect(ipcHandlerSource).toContain('windows.has(requestingWindow)');
    expect(ipcHandlerSource).toContain("message.trim().slice(0, 500) : 'Renderer bootstrap failed without detail'");
    expect(ipcHandlerSource).toContain('rendererBootstrapMonitor.markReady(requestingWindow)');
    expect(ipcHandlerSource).toContain('rendererBootstrapMonitor.fail');
    expect(ipcHandlerSource).toContain('rendererBootstrapMonitor.isReady(requestingWindow)');
    expect(ipcHandlerSource).toContain('startupCoordinator.fail');
    expect(mainSource).toContain("window.webContents.once('preload-error'");
    expect(createWindowSource).toContain('rendererBootstrapMonitor.watch(window)');
    expect(createWindowSource).toContain("window.webContents.once('render-process-gone'");
    expect(createWindowSource).toContain("window.webContents.on('did-fail-load'");
    expect(createWindowSource).toContain("window.on('unresponsive'");
    expect(createWindowSource).toContain('rendererBootstrapMonitor.dispose(window)');
    expect(mainSource).not.toContain('timeoutMs: 15_000');
    expect(preloadErrorAt).toBeGreaterThan(createWindowSource.indexOf('new BrowserWindow({'));
    expect(createWindowSource.indexOf('await window.loadURL(rendererUrl)')).toBeGreaterThan(preloadErrorAt);
    expect(preloadSource).toContain('createRendererBootstrapReporter');
    expect(preloadSource).toContain('shouldReportRendererWindowError(rendererBootstrapReporter.getState(), event)');
    expect(preloadStateSource).toContain("'zeus:renderer-bootstrap-failed'");
    expect(preloadStateSource).toContain("'zeus:renderer-bootstrap-ready'");
    expect(preloadStateSource).toContain("'zeus:renderer-runtime-failed'");
    expect(preloadSource).toMatch(/globalThis\.addEventListener\(\s*'error'/);
    expect(preloadSource).toContain("globalThis.addEventListener('unhandledrejection'");
    expect(preloadSource).toMatch(/globalThis\.addEventListener\(\s*'error',[\s\S]*?true,\s*\);/);
    expect(globalSource).toContain('reportRendererFatalFailure: (message: string) => void;');
    expect(globalSource).toContain('reportRendererBootstrapReady: () => void;');
  });

  it('routes native Command+N into the renderer new conversation flow instead of creating a window', async () => {
    const mainSource = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const preloadSource = await readFile(new URL('../src/preload/index.cts', import.meta.url), 'utf8');
    const globalSource = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');
    const appSource = await readFile(new URL('../src/renderer/App.tsx', import.meta.url), 'utf8');

    expect(mainSource).toContain('async function startNewConversationFromMenu()');
    expect(mainSource).toContain("webContents.send('zeus:native-new-conversation')");
    expect(mainSource).toContain('createNewConversation: () => {');
    expect(preloadSource).toContain('onNativeNewConversation: (listener: () => void) => {');
    expect(preloadSource).toContain("ipcRenderer.on('zeus:native-new-conversation'");
    expect(globalSource).toContain('onNativeNewConversation: (listener: () => void) => () => void;');
    expect(appSource).toContain('window.zeus?.onNativeNewConversation?.(() => prepareNewConversationDraft())');
  });

  it('opens MCP authorization pages only through the audited HTTPS IPC bridge', async () => {
    const mainSource = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const preloadSource = await readFile(new URL('../src/preload/index.cts', import.meta.url), 'utf8');
    const globalSource = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('zeus:open-external-https-url'");
    expect(mainSource).toContain('openExternal: (url) => shell.openExternal(url)');
    expect(mainSource).toContain('setWindowOpenHandler(() => {');
    expect(mainSource).toContain("return { action: 'deny' };");
    expect(preloadSource).toContain("openExternalHttpsUrl: (url: string) => ipcRenderer.invoke('zeus:open-external-https-url', url)");
    expect(globalSource).toContain('openExternalHttpsUrl: (url: string) => Promise<{ opened: boolean; url?: string; error?: string }>;');
  });

  it('exposes a native task attachment picker and clipboard screenshot fallback instead of fake upload rows', async () => {
    const mainSource = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const preloadSource = await readFile(new URL('../src/preload/index.cts', import.meta.url), 'utf8');
    const globalSource = await readFile(new URL('../src/renderer/global.d.ts', import.meta.url), 'utf8');
    const taskClipboardSource = await readFile(new URL('../src/main/taskClipboard.ts', import.meta.url), 'utf8');

    expect(mainSource).toContain("ipcMain.handle('zeus:choose-task-attachments'");
    expect(mainSource).toContain("ipcMain.handle('zeus:save-task-pasted-attachments'");
    expect(mainSource).toContain("ipcMain.handle('zeus:save-task-clipboard-attachments'");
    expect(mainSource).toContain("ipcMain.handle('zeus:read-task-clipboard-attachments'");
    expect(mainSource).toContain("ipcMain.handle('zeus:read-task-clipboard-image'");
    expect(mainSource).toContain("ipcMain.handle('zeus:get-task-attachment-preview'");
    expect(mainSource).toContain("ipcMain.handle('zeus:open-task-attachment'");
    expect(mainSource).toContain('shell.openPath(path)');
    expect(mainSource).toContain('clipboard.readImage()');
    expect(mainSource).toContain('clipboard.availableFormats()');
    expect(mainSource).toContain('clipboard.readBuffer(format)');
    expect(mainSource).toContain('clipboard.readHTML()');
    expect(mainSource).toContain('readMacOSClipboardFileReferences');
    expect(mainSource).toContain('the clipboard as «class furl»');
    expect(mainSource).toContain('readTaskClipboardAttachmentsFromClipboard');
    expect(taskClipboardSource).toContain('image.isEmpty()');
    expect(taskClipboardSource).toContain('image.toPNG()');
    expect(taskClipboardSource).toContain("type: 'image/png'");
    expect(taskClipboardSource).toContain('pasted-task-screenshot');
    expect(mainSource).toContain("properties: ['openFile', 'multiSelections']");
    expect(mainSource).toContain("{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic']");
    expect(mainSource).toContain('readTaskAttachmentFilePathPayloads(selected.filePaths)');
    expect(mainSource).toContain('return saveTaskAttachmentPayloads(await readTaskAttachmentFilePathPayloads(selected.filePaths));');
    expect(mainSource).toContain("join(app.getPath('userData'), 'task-attachments')");
    expect(mainSource).toContain('sanitizeTaskAttachmentFileName');
    expect(mainSource).toContain('await writeFile(filePath, attachmentBuffer');
    expect(mainSource).toContain('buildTaskAttachmentPreviewDataUrl');
    expect(mainSource).toContain('loadSavedTaskAttachmentPreview');
    expect(mainSource).toContain('coerceTaskClipboardAttachmentBuffer');
    expect(preloadSource).toContain("chooseTaskAttachments: () => ipcRenderer.invoke('zeus:choose-task-attachments')");
    expect(preloadSource).toContain("readTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:read-task-clipboard-attachments')");
    expect(preloadSource).toContain("saveTaskClipboardAttachments: () => ipcRenderer.invoke('zeus:save-task-clipboard-attachments')");
    expect(preloadSource).toContain("readTaskClipboardImage: () => ipcRenderer.invoke('zeus:read-task-clipboard-image')");
    expect(preloadSource).toContain("getTaskAttachmentPreview: (path: string) => ipcRenderer.invoke('zeus:get-task-attachment-preview', path)");
    expect(preloadSource).toContain("openTaskAttachment: (path: string) => ipcRenderer.invoke('zeus:open-task-attachment', path)");
    expect(preloadSource).toContain('saveTaskPastedAttachments: (attachments: Array<{ name: string; type: string; data: ArrayBuffer }>)');
    expect(preloadSource).toContain("ipcRenderer.invoke('zeus:save-task-pasted-attachments', attachments)");
    expect(globalSource).toContain("chooseTaskAttachments: () => Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>>;");
    expect(globalSource).toContain('readTaskClipboardAttachments: () => Promise<Array<{ name: string; type: string; data: ArrayBuffer }>>;');
    expect(globalSource).toContain("saveTaskClipboardAttachments: () => Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>>;");
    expect(globalSource).toContain("readTaskClipboardImage: () => Promise<{ name: string; type: 'image/png'; data: ArrayBuffer } | null>;");
    expect(globalSource).toContain(
      "saveTaskPastedAttachments: (attachments: Array<{ name: string; type: string; data: ArrayBuffer }>) => Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>>;",
    );
    expect(globalSource).toContain('getTaskAttachmentPreview: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;');
    expect(globalSource).toContain('openTaskAttachment: (path: string) => Promise<{ opened: boolean; error?: string }>;');
  });

  it('disables Chromium Safe Storage Keychain access before the Electron app is ready', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');
    const disablePromptIndex = source.indexOf("app.commandLine.appendSwitch('use-mock-keychain')");
    const readyIndex = source.indexOf('app.whenReady()');

    expect(disablePromptIndex).toBeGreaterThanOrEqual(0);
    expect(readyIndex).toBeGreaterThan(disablePromptIndex);
    expect(source).toContain('移除 Chromium Safe Storage 对 macOS 钥匙串的读取申请');
  });

  it('passes the explicit Codex native kill switch from Electron Main', async () => {
    const source = await readFile(new URL('../src/main/main.ts', import.meta.url), 'utf8');

    expect(source).toContain('const codexNativeEnabled = parseCodexNativeEnabled(process.env.ZEUS_CODEX_NATIVE_ENABLED)');
    expect(source).toContain('codexNativeEnabled,');
  });

  it('enables Codex native by default and disables it only for the exact env value zero', () => {
    expect(parseCodexNativeEnabled(undefined)).toBe(true);
    expect(parseCodexNativeEnabled('0')).toBe(false);
    expect(parseCodexNativeEnabled('1')).toBe(true);
    expect(parseCodexNativeEnabled('false')).toBe(true);
  });
});

describe('Electron main local-server runtime', () => {
  it('passes Telegram token and allowed users to the local server without exposing them to renderer config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-'));
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
        telegramToken: 'real-token',
        telegramAllowedUserIds: [42],
      });
      expect(runtime.config).not.toHaveProperty('telegramToken');
      const response = await fetch(`${runtime.config.baseUrl}/api/settings/runtime-status`, { headers: { authorization: `Bearer ${runtime.config.apiToken}` } });
      expect(response.status).toBe(200);
      expect((await response.json()).telegram).toMatchObject({
        enabled: true,
        reason: 'Telegram long polling 可启用。',
      });
      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts Zeus local server under the app user data directory and returns a renderer-safe config', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-'));
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
      });
      expect(runtime.dbPath).toBe(join(dir, 'zeus.db'));
      expect(runtime.config.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
      expect(runtime.config.apiToken.length).toBeGreaterThan(20);
      const response = await fetch(`${runtime.config.baseUrl}/health`);
      expect(response.status).toBe(200);
      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes a local config file beside the app database without exposing the renderer token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-config-'));
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
      });
      expect(runtime.configPath).toBe(join(dir, 'zeus.config.json'));

      const configFile = JSON.parse(await readFile(runtime.configPath, 'utf8')) as Record<string, unknown>;
      expect(configFile).toMatchObject({
        appName: 'Zeus',
        projectRoot: '/Users/david/hypha/zeus',
        dbPath: join(dir, 'zeus.db'),
        localLogDirectory: join(dir, 'zeus.db.logs'),
        localServerHost: '127.0.0.1',
      });
      expect(configFile).toHaveProperty('updatedAt');
      expect(configFile).not.toHaveProperty('apiToken');
      expect(JSON.stringify(configFile)).not.toContain(runtime.config.apiToken);

      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exposes the root package version through the desktop-started Health API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-health-version-'));
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
      });
      const response = await fetch(`${runtime.config.baseUrl}/health`);
      const health = (await response.json()) as {
        version?: string;
        appName?: string;
      };

      expect(response.status).toBe(200);
      expect(health).toMatchObject({ appName: 'Zeus', version: '0.1.0' });
      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('notifies Electron main dependents after an unexpected local server restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-restart-callback-'));
    try {
      const restartNotifications: Array<{ baseUrl: string; apiToken: string }> = [];
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
        restartDelayMs: 10,
        onRestarted: (config) => {
          restartNotifications.push({ ...config });
        },
      });
      const firstBaseUrl = runtime.config.baseUrl;

      await runtime.server.close();
      await waitForRestart(runtime, firstBaseUrl);

      expect(restartNotifications).toHaveLength(1);
      expect(restartNotifications[0]).toEqual(runtime.config);
      expect(restartNotifications[0].baseUrl).not.toBe(firstBaseUrl);
      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('automatically restarts the local server after an unexpected close while keeping renderer token stable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-restart-'));
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
        restartDelayMs: 10,
      });
      const firstBaseUrl = runtime.config.baseUrl;
      const firstToken = runtime.config.apiToken;

      await runtime.server.close();
      await waitForRestart(runtime, firstBaseUrl);

      expect(runtime.dbPath).toBe(join(dir, 'zeus.db'));
      expect(runtime.config.apiToken).toBe(firstToken);
      expect(runtime.config.baseUrl).not.toBe(firstBaseUrl);
      const response = await fetch(`${runtime.config.baseUrl}/health`);
      expect(response.status).toBe(200);
      await runtime.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not restart the local server after an intentional close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-close-'));
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: '/Users/david/hypha/zeus',
        restartDelayMs: 10,
      });
      const firstBaseUrl = runtime.config.baseUrl;

      await runtime.close();
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(runtime.config.baseUrl).toBe(firstBaseUrl);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('takes over an in-flight restart during final close without publishing or notifying the late server', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-close-restart-race-'));
    const manager = new DesktopFakeCodexManager();
    const first = createFakeRunningServer('http://127.0.0.1:41001');
    const late = createFakeRunningServer('http://127.0.0.1:41002');
    const pendingRestart = deferred<RunningZeusLocalServer>();
    const localServerFactory = vi.fn().mockResolvedValueOnce(first.running).mockReturnValueOnce(pendingRestart.promise);
    const onRestarted = vi.fn();
    const cancelSharedPendingRequest = vi.fn(async () => {
      if (cancelSharedPendingRequest.mock.calls.length > 1) throw Object.assign(new Error('shared manager request not found'), { code: 'ZEUS_CODEX_REQUEST_NOT_FOUND' });
    });
    first.prepareForShutdown.mockImplementation(cancelSharedPendingRequest);
    late.prepareForShutdown.mockImplementation(cancelSharedPendingRequest);
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        restartDelayMs: 0,
        codexAppServerManagerFactory: () => manager,
        localServerFactory,
        onRestarted,
      });
      first.emitClose();
      await vi.waitFor(() => expect(localServerFactory).toHaveBeenCalledTimes(2));

      const firstClose = runtime.close();
      const secondClose = runtime.close();
      expect(secondClose).toBe(firstClose);
      pendingRestart.resolve(late.running);
      await firstClose;

      expect(runtime.server).toBe(first.running);
      expect(runtime.config.baseUrl).toBe(first.running.baseUrl);
      expect(onRestarted).not.toHaveBeenCalled();
      expect(cancelSharedPendingRequest).toHaveBeenCalledTimes(1);
      expect(first.prepareForShutdown).not.toHaveBeenCalled();
      expect(first.close).not.toHaveBeenCalled();
      expect(late.prepareForShutdown).toHaveBeenCalledTimes(1);
      expect(late.close).toHaveBeenCalledTimes(1);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the handoff server as finalization owner when an in-flight restart launch fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-close-restart-fallback-'));
    const manager = new DesktopFakeCodexManager();
    const first = createFakeRunningServer('http://127.0.0.1:41101');
    const pendingRestart = deferred<RunningZeusLocalServer>();
    const restartError = new Error('replacement launch failed');
    const cancelSharedPendingRequest = vi.fn(async () => undefined);
    first.prepareForShutdown.mockImplementation(cancelSharedPendingRequest);
    const localServerFactory = vi.fn().mockResolvedValueOnce(first.running).mockReturnValueOnce(pendingRestart.promise);
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        restartDelayMs: 0,
        codexAppServerManagerFactory: () => manager,
        localServerFactory,
      });
      first.emitClose();
      await vi.waitFor(() => expect(localServerFactory).toHaveBeenCalledTimes(2));

      const closing = runtime.close();
      pendingRestart.reject(restartError);

      await expect(closing).rejects.toBe(restartError);
      expect(cancelSharedPendingRequest).toHaveBeenCalledTimes(1);
      expect(first.prepareForShutdown).toHaveBeenCalledTimes(1);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not finalize the handoff server again when a rejected replacement already claimed finalization ownership', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-close-restart-claimed-'));
    const manager = new DesktopFakeCodexManager();
    const first = createFakeRunningServer('http://127.0.0.1:41201');
    const pendingRestart = deferred<RunningZeusLocalServer>();
    const restartError = new Error('replacement listen failed after finalization');
    Object.defineProperty(restartError, codexFinalizationOwnershipClaimSymbol, { value: true });
    const cancelSharedPendingRequest = vi.fn(async () => undefined);
    const localServerFactory = vi.fn().mockResolvedValueOnce(first.running).mockReturnValueOnce(pendingRestart.promise);
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        restartDelayMs: 0,
        codexAppServerManagerFactory: () => manager,
        localServerFactory,
      });
      first.emitClose();
      await vi.waitFor(() => expect(localServerFactory).toHaveBeenCalledTimes(2));

      const closing = runtime.close();
      await cancelSharedPendingRequest();
      pendingRestart.reject(restartError);

      await expect(closing).rejects.toBe(restartError);
      expect(cancelSharedPendingRequest).toHaveBeenCalledTimes(1);
      expect(first.prepareForShutdown).not.toHaveBeenCalled();
      expect(first.close).not.toHaveBeenCalled();
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('remembers claimed finalization after a replacement failure settles before close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-settled-restart-claimed-'));
    const manager = new DesktopFakeCodexManager();
    const first = createFakeRunningServer('http://127.0.0.1:41301');
    const pendingRestart = deferred<RunningZeusLocalServer>();
    const restartError = new Error('settled replacement listen failure');
    Object.defineProperty(restartError, codexFinalizationOwnershipClaimSymbol, { value: true });
    const cancelSharedPendingRequest = vi.fn(async () => undefined);
    const localServerFactory = vi.fn().mockResolvedValueOnce(first.running).mockReturnValueOnce(pendingRestart.promise);
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        restartDelayMs: 0,
        codexAppServerManagerFactory: () => manager,
        localServerFactory,
      });
      first.emitClose();
      await vi.waitFor(() => expect(localServerFactory).toHaveBeenCalledTimes(2));

      await cancelSharedPendingRequest();
      pendingRestart.reject(restartError);
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(runtime.close()).resolves.toBeUndefined();
      expect(cancelSharedPendingRequest).toHaveBeenCalledTimes(1);
      expect(first.prepareForShutdown).not.toHaveBeenCalled();
      expect(first.close).not.toHaveBeenCalled();
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the handoff server after an unclaimed replacement failure settles before close', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-settled-restart-unclaimed-'));
    const manager = new DesktopFakeCodexManager();
    const first = createFakeRunningServer('http://127.0.0.1:41401');
    const pendingRestart = deferred<RunningZeusLocalServer>();
    const cancelSharedPendingRequest = vi.fn(async () => undefined);
    first.prepareForShutdown.mockImplementation(cancelSharedPendingRequest);
    const localServerFactory = vi.fn().mockResolvedValueOnce(first.running).mockReturnValueOnce(pendingRestart.promise);
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        restartDelayMs: 0,
        codexAppServerManagerFactory: () => manager,
        localServerFactory,
      });
      first.emitClose();
      await vi.waitFor(() => expect(localServerFactory).toHaveBeenCalledTimes(2));

      pendingRestart.reject(new Error('settled replacement factory failure'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(runtime.close()).resolves.toBeUndefined();
      expect(cancelSharedPendingRequest).toHaveBeenCalledTimes(1);
      expect(first.prepareForShutdown).toHaveBeenCalledTimes(1);
      expect(first.close).toHaveBeenCalledTimes(1);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prepares and closes the shared manager when the initial local-server launch rejects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-initial-launch-failure-'));
    const manager = new DesktopFakeCodexManager();
    const launchError = new Error('initial listen rejected');
    try {
      await expect(
        startDesktopLocalServer({
          userDataPath: dir,
          projectRoot: dir,
          codexAppServerManagerFactory: () => manager,
          localServerFactory: vi.fn().mockRejectedValue(launchError),
        }),
      ).rejects.toBe(launchError);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('prepares and closes the shared manager when the local-server factory throws synchronously', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-local-factory-throw-'));
    const manager = new DesktopFakeCodexManager();
    const factoryError = new Error('local-server factory threw');
    try {
      await expect(
        startDesktopLocalServer({
          userDataPath: dir,
          projectRoot: dir,
          codexAppServerManagerFactory: () => manager,
          localServerFactory: vi.fn(() => {
            throw factoryError;
          }),
        }),
      ).rejects.toBe(factoryError);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs every final cleanup exactly once and preserves server plus manager cleanup failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-final-cleanup-errors-'));
    const manager = new DesktopFakeCodexManager();
    const server = createFakeRunningServer('http://127.0.0.1:42001');
    const serverPrepareError = new Error('server prepare failed');
    const serverCloseError = new Error('server close failed');
    const managerPrepareError = new Error('manager prepare failed');
    const managerCloseError = new Error('manager close failed');
    server.prepareForShutdown.mockImplementation(() => {
      throw serverPrepareError;
    });
    server.close.mockRejectedValue(serverCloseError);
    manager.prepareForShutdownFailure = managerPrepareError;
    manager.closeFailure = managerCloseError;
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        codexAppServerManagerFactory: () => manager,
        localServerFactory: vi.fn().mockResolvedValue(server.running),
      });

      const firstClose = runtime.close();
      const secondClose = runtime.close();
      expect(secondClose).toBe(firstClose);
      const error = await firstClose.catch((failure: unknown) => failure);

      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors).toEqual([serverPrepareError, serverCloseError, managerPrepareError, managerCloseError]);
      expect(server.prepareForShutdown).toHaveBeenCalledTimes(1);
      expect(server.close).toHaveBeenCalledTimes(1);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reuses one app-server manager across Fastify port restarts and closes it once after the final coordinator unsubscribes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-codex-singleton-'));
    const manager = new DesktopFakeCodexManager();
    const managerFactory = vi.fn(() => manager);
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        restartDelayMs: 10,
        codexAppServerManagerFactory: managerFactory,
      });
      const task = await createNativeTask(runtime, dir, 'singleton-first');

      const first = await postJson(
        runtime,
        `/api/tasks/${task.id}/conversations`,
        {
          mode: 'create',
          content: '首次 native turn',
        },
        'singleton-first-turn',
      );
      expect(first.status).toBe(202);
      expect(managerFactory).toHaveBeenCalledTimes(1);
      expect(manager.spawnCount).toBe(1);
      expect(manager.listenerCount).toBe(1);

      const firstBaseUrl = runtime.config.baseUrl;
      await runtime.server.close();
      await waitForRestart(runtime, firstBaseUrl);

      expect(managerFactory).toHaveBeenCalledTimes(1);
      expect(manager.spawnCount).toBe(1);
      expect(manager.subscribeCount).toBe(2);
      expect(manager.unsubscribeCount).toBe(1);
      expect(manager.listenerCount).toBe(1);
      expect(manager.prepareForShutdownCount).toBe(0);
      expect(manager.closeCount).toBe(0);

      const second = await postJson(
        runtime,
        `/api/tasks/${task.id}/conversations`,
        {
          mode: 'create',
          content: '换端口后的 native turn',
        },
        'singleton-second-turn',
      );
      expect(second.status).toBe(202);
      expect(manager.spawnCount).toBe(1);

      await runtime.close();
      await runtime.close();

      expect(manager.unsubscribeCount).toBe(2);
      expect(manager.listenerCount).toBe(0);
      expect(manager.prepareForShutdownCount).toBe(1);
      expect(manager.closeCount).toBe(1);
      expect(manager.lifecycle.slice(-3)).toEqual(['coordinator.unsubscribe', 'manager.prepareForShutdown', 'manager.close']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('cancels pending approvals and interrupts unresolved user-input or MCP turns before manager shutdown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-codex-pending-'));
    const manager = new DesktopFakeCodexManager();
    try {
      const runtime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        codexAppServerManagerFactory: () => manager,
      });
      const task = await createNativeTask(runtime, dir, 'pending-shutdown');
      const created = await postJson(
        runtime,
        `/api/tasks/${task.id}/conversations`,
        {
          mode: 'create',
          content: '保持 turn 活跃以验证退出收口',
        },
        'pending-shutdown-turn',
      );
      expect(created.status).toBe(202);
      const body = (await created.json()) as { conversation: { provider: { threadId: string } }; submission: { providerTurnId: string } };
      const threadId = body.conversation.provider.threadId;
      const turnId = body.submission.providerTurnId;

      await manager.emit('item/commandExecution/requestApproval', { threadId, turnId, command: ['git', 'status'] }, 'approval-1', 2);
      await manager.emit(
        'item/tool/requestUserInput',
        {
          threadId,
          turnId,
          itemId: 'rui-item-1',
          questions: [
            {
              id: 'choice',
              header: '继续',
              question: '继续？',
              options: [
                { label: '继续', description: '继续当前操作。' },
                { label: '停止', description: '停止当前操作。' },
              ],
              isOther: false,
              isSecret: false,
            },
          ],
          autoResolutionMs: null,
        },
        'rui-1',
        3,
      );
      await manager.emit('item/mcpToolCall/request', { threadId, turnId, server: 'test' }, 'mcp-1', 4);

      // 先完成一次非最终 Fastify handoff，复现 restart timer 尚未触发时应用直接退出的窗口。
      await runtime.server.close();
      expect(manager.responses).toEqual([]);
      expect(manager.interrupts).toEqual([]);
      expect(manager.prepareForShutdownCount).toBe(0);

      await runtime.close();

      expect(manager.responses).toContainEqual({
        type: 'command',
        decision: 'cancel',
        generationId: 'desktop-generation',
        requestId: 'approval-1',
      });
      expect(manager.interrupts).toEqual([{ threadId, turnId }]);
      expect(manager.lifecycle.indexOf('respond:command')).toBeLessThan(manager.lifecycle.indexOf('manager.prepareForShutdown'));
      expect(manager.lifecycle.indexOf(`interrupt:${threadId}:${turnId}`)).toBeLessThan(manager.lifecycle.indexOf('manager.prepareForShutdown'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps native history readable while kill-switch writes fail closed and non-Codex legacy execution remains available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'zeus-main-runtime-codex-disabled-'));
    const enabledManager = new DesktopFakeCodexManager();
    let enabledRuntime: Awaited<ReturnType<typeof startDesktopLocalServer>> | undefined;
    let disabledRuntime: Awaited<ReturnType<typeof startDesktopLocalServer>> | undefined;
    try {
      enabledRuntime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        codexAppServerManagerFactory: () => enabledManager,
      });
      const project = await createProject(enabledRuntime, dir, 'kill-switch-project');
      const nativeTask = await createTask(enabledRuntime, project.id, 'kill-switch-native-task');
      const created = await postJson(
        enabledRuntime,
        `/api/tasks/${nativeTask.id}/conversations`,
        {
          mode: 'create',
          content: '此 native 历史必须保留只读',
        },
        'kill-switch-native-create',
      );
      expect(created.status).toBe(202);
      const createdBody = (await created.json()) as { conversation: { id: string } };
      await enabledRuntime.close();
      enabledRuntime = undefined;

      const disabledManager = new DesktopFakeCodexManager();
      disabledRuntime = await startDesktopLocalServer({
        userDataPath: dir,
        projectRoot: dir,
        codexNativeEnabled: false,
        codexAppServerManagerFactory: () => disabledManager,
      });

      const history = await getJson(disabledRuntime, `/api/projects/${project.id}/conversations/${createdBody.conversation.id}`);
      expect(history.status).toBe(200);
      expect((await history.json()) as object).toMatchObject({ id: createdBody.conversation.id, transportKind: 'codex_native' });

      const disabledWrite = await postJson(
        disabledRuntime,
        `/api/projects/${project.id}/conversations/${createdBody.conversation.id}/messages`,
        {
          content: 'kill switch 下不得进入 provider',
        },
        'kill-switch-native-write',
      );
      expect(disabledWrite.status).toBe(409);
      expect((await disabledWrite.json()) as object).toMatchObject({ error: 'ZEUS_CODEX_NATIVE_DISABLED' });
      expect(disabledManager.spawnCount).toBe(0);
      expect(disabledManager.threadStarts).toHaveLength(0);
      expect(disabledManager.turnStarts).toHaveLength(0);

      const settings = await putJson(disabledRuntime, '/api/runtime/settings', {
        defaultAdapterId: 'claude',
        adapterModels: {},
        adapterDefaultArgs: {},
        adapterCliPaths: { claude: '/usr/bin/true' },
        terminalEnv: {},
        shell: { path: null, login: false },
        concurrency: { maxPerProject: 4, maxGlobal: 4 },
        executionTimeoutSeconds: 3600,
        logRetentionDays: 30,
        autoConfirmationPolicy: 'never',
      });
      expect(settings.status, await settings.clone().text()).toBe(200);
      const genericTask = await createTask(disabledRuntime, project.id, 'kill-switch-generic-task');
      const genericRun = await postJson(disabledRuntime, `/api/tasks/${genericTask.id}/run`, {});
      expect(genericRun.status).toBe(201);
      expect((await genericRun.json()) as object).toMatchObject({
        task: { id: genericTask.id, status: 'running' },
        conversation: { taskId: genericTask.id, status: 'running' },
        runtimeSession: { command: '/usr/bin/true' },
      });
      expect(disabledManager.spawnCount).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      await disabledRuntime?.close();
      await enabledRuntime?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function waitForRestart(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, oldBaseUrl: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (runtime.config.baseUrl !== oldBaseUrl) {
      const response = await fetch(`${runtime.config.baseUrl}/health`);
      if (response.status === 200) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Zeus local server did not restart');
}

async function createProject(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, localPath: string, name: string): Promise<{ id: string }> {
  const response = await postJson(runtime, '/api/projects', { name, localPath });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function createTask(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, projectId: string, title: string): Promise<{ id: string }> {
  const response = await postJson(runtime, '/api/tasks', {
    projectId,
    title,
    description: title,
    allowCodeChanges: false,
    allowTests: false,
    allowGitCommit: false,
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

async function createNativeTask(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, localPath: string, name: string): Promise<{ id: string }> {
  const project = await createProject(runtime, localPath, `${name}-project`);
  return createTask(runtime, project.id, `${name}-task`);
}

async function getJson(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, path: string): Promise<Response> {
  return fetch(`${runtime.config.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${runtime.config.apiToken}` },
  });
}

async function postJson(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, path: string, body: object, idempotencyKey?: string): Promise<Response> {
  return fetch(`${runtime.config.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtime.config.apiToken}`,
      'content-type': 'application/json',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function putJson(runtime: Awaited<ReturnType<typeof startDesktopLocalServer>>, path: string, body: object): Promise<Response> {
  return fetch(`${runtime.config.baseUrl}${path}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${runtime.config.apiToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}
