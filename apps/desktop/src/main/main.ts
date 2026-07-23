import {
    app,
    BrowserWindow,
    clipboard,
    dialog,
    ipcMain,
    Menu,
    nativeImage,
    Notification,
    screen,
    shell,
    Tray
} from 'electron';
import {execFile as execFileCallback} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {basename, dirname, extname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {
    createBeforeQuitCleanupHandler,
    type DesktopLocalServerRuntime,
    parseCodexNativeEnabled,
    startDesktopLocalServer
} from './localServerRuntime.js';
import {createStartupCoordinator} from './startupCoordinator.js';
import {terminateAfterFatalStartup} from './fatalStartup.js';
import {createRendererBootstrapMonitor} from './rendererBootstrapMonitor.js';
import {resolveCodexRuntimePath} from './codexRuntimePath.js';
import {exportMermaidDiagramToFile, exportPlantUmlDiagramToFile} from './mermaidExport.js';
import {exportPatchToFile} from './patchExport.js';
import {exportRuntimeLogsToFile} from './runtimeLogExport.js';
import {chooseProjectDirectory} from './projectDirectoryPicker.js';
import {
    exportSettingsSnapshotToFile,
    importBusinessDataSnapshotFromFile,
    importSettingsSnapshotFromFile
} from './settingsPortability.js';
import {type GraphSourceLocation, openGraphSourceLocation} from './sourceOpen.js';
import {
    buildAppShellMenuTemplate,
    buildLoginItemSettings,
    buildMenuBarTrayTemplate,
    type MainAppShellSettings,
    shouldQuitWhenAllWindowsClosed,
    shouldUseSystemNotifications
} from './appShellPolicy.js';
import {createSystemNotificationBridge, type SystemNotificationBridge} from './systemNotifications.js';
import {openLocalLogDirectory} from './localLogDirectory.js';
import {openExternalHttpsUrl} from './externalOpen.js';
import {
    createPersistedMainWindowState,
    findSavedWindowDisplay,
    type PersistedMainWindowState,
    readPersistedMainWindowState,
    resolveMainWindowState,
    writePersistedMainWindowState
} from './windowState.js';
import {
    applyRestoredMainWindowPlacement,
    createWindowStatePersistenceGate,
    waitForSavedWindowDisplay,
    type WindowStatePersistenceGate
} from './windowRestoration.js';
import {
    buildTaskAttachmentPreviewDataUrl,
    coerceTaskClipboardAttachmentBuffer,
    inferTaskClipboardAttachmentMimeType,
    readTaskAttachmentFilePathPayloads,
    readTaskClipboardAttachmentsFromClipboard,
    type TaskClipboardAttachmentPayload,
} from './taskClipboard.js';

let mainWindow: BrowserWindow | undefined;
const windows = new Set<BrowserWindow>();
let tray: Tray | undefined;
let localServerRuntime: DesktopLocalServerRuntime | undefined;
let systemNotificationBridge: SystemNotificationBridge | undefined;
let fatalStartup = false;
let appShellSettings: MainAppShellSettings = {
  webviewDebugEnabled: false,
  multiWindowEnabled: true,
  backgroundModeEnabled: true,
  desktopNotificationsEnabled: true,
  openAtLoginEnabled: false,
};
const manualWindowDragStates = new Map<number, { pointerX: number; pointerY: number; windowX: number; windowY: number }>();
const windowStateSaveTimers = new Map<number, ReturnType<typeof setTimeout>>();
const windowStateActivationTimers = new Map<number, ReturnType<typeof setTimeout>>();
const windowStatePersistenceGates = new Map<number, WindowStatePersistenceGate>();
const execFile = promisify(execFileCallback);
const windowStateSaveDelayMs = 250;
const windowStateActivationDelayMs = 500;
const savedDisplayAvailabilityTimeoutMs = 2_000;

/**
 * 移除 Chromium Safe Storage 对 macOS 钥匙串的读取申请。
 * 用户已明确要求 Zeus 不再弹出 `@zeus/desktop Safe Storage` 授权框；
 * 代价是 Chromium profile 内依赖系统钥匙串加密的浏览器态会降级为 mock keychain。
 */
function disableChromiumSafeStorageKeychainPrompt(): void {
  if (process.platform !== 'darwin') return;
  app.commandLine.appendSwitch('use-mock-keychain');
}

disableChromiumSafeStorageKeychainPrompt();

function applyExplicitUserDataDirectory(): void {
    const configured = process.env.ZEUS_USER_DATA_DIR?.trim();
    if (configured) app.setPath('userData', resolve(configured));
}

// 打包验收可用隔离资料目录运行，禁止污染用户正在使用的 Zeus 数据。
applyExplicitUserDataDirectory();

function desktopRoot(): string {
  return process.env.ZEUS_DESKTOP_DIR ?? app.getAppPath();
}

function resolveMainProjectRoot(): string {
  // packaged App 从 Finder 启动时 process.cwd() 可能是 "/"；禁止把全局 scan-current 兜底到整机根目录。
  return process.env.ZEUS_PROJECT_ROOT ?? (app.isPackaged ? desktopRoot() : process.cwd());
}

function mainWindowStatePath(): string {
    return join(app.getPath('userData'), 'main-window-state.json');
}

function persistMainWindowState(window: BrowserWindow): boolean {
    if (window.isDestroyed()) return false;
    const bounds = window.getNormalBounds();
    const display = screen.getDisplayMatching(bounds);
    const state = createPersistedMainWindowState({
        bounds,
        display,
        isMaximized: window.isMaximized(),
        isFullScreen: window.isFullScreen(),
    });
    if (!state || !writePersistedMainWindowState(mainWindowStatePath(), state)) return false;
    windowStatePersistenceGates.get(window.id)?.markPersisted();
    return true;
}

function flushMainWindowState(window: BrowserWindow): void {
    const timer = windowStateSaveTimers.get(window.id);
    if (timer) clearTimeout(timer);
    windowStateSaveTimers.delete(window.id);
    if (!windowStatePersistenceGates.get(window.id)?.shouldPersist()) return;
    persistMainWindowState(window);
}

function scheduleMainWindowStateSave(window: BrowserWindow): void {
    if (!windowStatePersistenceGates.get(window.id)?.recordChange()) return;
    const pendingTimer = windowStateSaveTimers.get(window.id);
    if (pendingTimer) clearTimeout(pendingTimer);
    const timer = setTimeout(() => {
        windowStateSaveTimers.delete(window.id);
        persistMainWindowState(window);
    }, windowStateSaveDelayMs);
    timer.unref();
    windowStateSaveTimers.set(window.id, timer);
}

function registerMainWindowStatePersistence(window: BrowserWindow): void {
    windowStatePersistenceGates.set(window.id, createWindowStatePersistenceGate());
    const scheduleSave = () => scheduleMainWindowStateSave(window);
    window.on('move', scheduleSave);
    window.on('resize', scheduleSave);
    window.on('maximize', scheduleSave);
    window.on('unmaximize', scheduleSave);
    window.on('enter-full-screen', scheduleSave);
    window.on('leave-full-screen', scheduleSave);
    window.on('close', () => flushMainWindowState(window));
}

function activateMainWindowStatePersistence(window: BrowserWindow): void {
    const pendingTimer = windowStateActivationTimers.get(window.id);
    if (pendingTimer) clearTimeout(pendingTimer);
    const timer = setTimeout(() => {
        windowStateActivationTimers.delete(window.id);
        if (!window.isDestroyed()) windowStatePersistenceGates.get(window.id)?.activate();
    }, windowStateActivationDelayMs);
    timer.unref();
    windowStateActivationTimers.set(window.id, timer);
}

async function resolveMainWindowStateForLaunch(persisted: PersistedMainWindowState | undefined) {
    const displays = screen.getAllDisplays();
    if (persisted && !findSavedWindowDisplay(persisted, displays)) {
        await waitForSavedWindowDisplay({
            persisted,
            getDisplays: () => screen.getAllDisplays(),
            subscribe: (listener) => {
                screen.on('display-added', listener);
                screen.on('display-metrics-changed', listener);
                return () => {
                    screen.off('display-added', listener);
                    screen.off('display-metrics-changed', listener);
                };
            },
            timeoutMs: savedDisplayAvailabilityTimeoutMs,
        });
    }
    return resolveMainWindowState(persisted, screen.getAllDisplays(), screen.getPrimaryDisplay());
}

function revealMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // macOS 直接启动、open 启动和 Codex Run 启动都必须把真实主窗口带到前台；
  // 否则用户会看到进程存在但没有可交互窗口，功能验证也无法继续。
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  app.focus({ steal: true });
}

/** macOS 再次点击 Dock/Finder 或第二个进程启动时，优先恢复已有窗口；没有窗口才新建。 */
async function revealOrCreateMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow(mainWindow);
    return;
  }
  await createWindow();
}

function normalizeDragPoint(point: unknown): { screenX: number; screenY: number } | undefined {
  if (!point || typeof point !== 'object') return undefined;
  const candidate = point as { screenX?: unknown; screenY?: unknown };
  if (typeof candidate.screenX !== 'number' || typeof candidate.screenY !== 'number') return undefined;
  if (!Number.isFinite(candidate.screenX) || !Number.isFinite(candidate.screenY)) return undefined;
  return { screenX: candidate.screenX, screenY: candidate.screenY };
}

function isAllowedRendererNavigation(targetUrl: string, rendererUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const renderer = new URL(rendererUrl);
    if (renderer.protocol === 'file:') return target.protocol === 'file:' && target.pathname === renderer.pathname;
    return target.origin === renderer.origin;
  } catch {
    return false;
  }
}

function configureWindowSecurity(window: BrowserWindow, rendererUrl: string): void {
  // Renderer 只允许 Zeus 自身入口导航；所有外部链接必须走显式 shell.openExternal 审计路径。
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, rendererUrl)) {
      event.preventDefault();
    }
  });
  // Zeus 不需要摄像头、麦克风、定位等浏览器权限；默认拒绝可避免第三方内容误触权限弹窗。
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

/** 创建 Zeus 主窗口；preload 会读取 Main 中启动的本地服务配置。 */
async function createWindow(): Promise<void> {
  if (!appShellSettings.multiWindowEnabled && mainWindow && !mainWindow.isDestroyed()) {
    revealMainWindow(mainWindow);
    return;
  }

    const persistedWindowState = windows.size === 0 ? readPersistedMainWindowState(mainWindowStatePath()) : undefined;
    const restoredWindowState = await resolveMainWindowStateForLaunch(persistedWindowState);
  const window = new BrowserWindow({
      ...restoredWindowState.bounds,
    // 2026-06-18 窗口根层响应式最终覆盖：允许紧凑窗口真实触发 renderer 的窄屏结构，而不是在 Main 进程强制桌面最小尺寸。
    minWidth: 360,
    minHeight: 560,
    title: 'Zeus',
    // 隐藏 macOS 原生标题栏，让内容贴近窗口顶部；标题仅保留给系统菜单与辅助功能。
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    show: false,
    webPreferences: {
      preload: join(desktopRoot(), 'dist/preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

    registerMainWindowStatePersistence(window);

  rendererBootstrapMonitor.watch(window);

  window.webContents.once('preload-error', (_event, preloadPath, error) => {
    const detail = error instanceof Error ? error.message : String(error);
    rendererBootstrapMonitor.fail(window, new Error(`Renderer preload failed (${preloadPath}): ${detail}`));
  });
  window.webContents.once('render-process-gone', (_event, details) => {
    rendererBootstrapMonitor.fail(window, new Error(`Renderer process exited during bootstrap (${details.reason}, exit ${details.exitCode})`));
  });
  window.on('unresponsive', () => {
    rendererBootstrapMonitor.fail(window, new Error('Renderer became unresponsive during bootstrap'));
  });
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    rendererBootstrapMonitor.fail(window, new Error(`Renderer failed to load ${validatedURL}: ${errorDescription} (${errorCode})`));
  });

  windows.add(window);
  mainWindow = window;
  window.on('closed', () => {
      const timer = windowStateSaveTimers.get(window.id);
      if (timer) clearTimeout(timer);
      windowStateSaveTimers.delete(window.id);
      const activationTimer = windowStateActivationTimers.get(window.id);
      if (activationTimer) clearTimeout(activationTimer);
      windowStateActivationTimers.delete(window.id);
      windowStatePersistenceGates.delete(window.id);
    rendererBootstrapMonitor.dispose(window);
    windows.delete(window);
    if (mainWindow === window) mainWindow = [...windows].at(-1);
  });

  let didRevealMainWindow = false;
  const revealMainWindowOnce = () => {
    if (didRevealMainWindow) return;
    didRevealMainWindow = true;
      const placement = applyRestoredMainWindowPlacement({
          window,
          restored: restoredWindowState,
          getDisplayMatching: (bounds) => screen.getDisplayMatching(bounds),
          reveal: () => revealMainWindow(window),
      });
      activateMainWindowStatePersistence(window);
      console.info(
          'Zeus main window restoration',
          JSON.stringify({
              matchKind: restoredWindowState.matchKind,
              targetDisplayId: restoredWindowState.targetDisplayId ?? null,
              actualDisplayId: placement.actualDisplayId ?? null,
              corrected: placement.corrected,
              bounds: window.getBounds(),
          }),
      );
  };

  window.once('ready-to-show', revealMainWindowOnce);
  const rendererUrl = process.env.ZEUS_DEV_SERVER_URL ?? pathToFileURL(join(desktopRoot(), 'dist/renderer/index.html')).toString();
  configureWindowSecurity(window, rendererUrl);
  if (process.env.ZEUS_DEV_SERVER_URL) {
    await window.loadURL(rendererUrl);
  } else {
    await window.loadURL(rendererUrl);
  }
  // 某些 packaged file:// + asar 状态下 ready-to-show 可能错过或延迟；兜底显示窗口，避免只剩后台进程。
  setTimeout(revealMainWindowOnce, 1200);
}

function setupMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildAppShellMenuTemplate({
        settings: appShellSettings,
        createNewConversation: () => {
          void startNewConversationFromMenu();
        },
        toggleDevTools: () => mainWindow?.webContents.toggleDevTools(),
        openSettings: () => {
          void openSettingsFromMenu();
        },
        openReleaseStatus: () => {
          void openReleaseStatusFromMenu();
        },
        openLogsDirectory: () => {
          void openLogsDirectoryFromMenu();
        },
        showMainWindow: () => {
          void requestMainWindow();
        },
        quit: () => app.quit(),
      }) as Electron.MenuItemConstructorOptions[],
    ),
  );
}

/** Cmd+N 是会话级动作：恢复主窗口并通知 Renderer 打开新会话草稿，不再创建额外窗口。 */
async function startNewConversationFromMenu(): Promise<void> {
  await requestMainWindow();
  if (fatalStartup) return;
  mainWindow?.webContents.send('zeus:native-new-conversation');
}

/** 从 macOS 原生 Settings 菜单进入设置区域；只跳转页面锚点，不伪造任何设置状态。 */
async function openSettingsFromMenu(): Promise<void> {
  await requestMainWindow();
  if (fatalStartup) return;
  await mainWindow?.webContents.executeJavaScript('globalThis.location.hash = "#settings-general";', true).catch(() => undefined);
}

/** 从 macOS 原生菜单进入发布与签名区域；只展示手动更新和等待项，不伪造在线更新 feed。 */
async function openReleaseStatusFromMenu(): Promise<void> {
  await requestMainWindow();
  if (fatalStartup) return;
  await mainWindow?.webContents.executeJavaScript('globalThis.location.hash = "#settings-about";', true).catch(() => undefined);
}

/** 打开本机日志目录；长日志和导出文件留在用户 Mac 上，不发送到远端渠道。 */
async function openLogsDirectoryFromMenu(): Promise<void> {
  await openLocalLogDirectory({
    dbPath: localServerRuntime?.dbPath,
    fallbackLogsPath: app.getPath('logs'),
    ensureDirectory: async (path, options) => {
      await mkdir(path, options);
    },
    openPath: (path) => shell.openPath(path),
  }).catch(() => undefined);
}

function setupIpc(): void {
  ipcMain.handle('zeus:get-local-server-config', () => {
    if (!localServerRuntime) {
      throw new Error('Zeus local server is not ready');
    }
    return localServerRuntime.config;
  });
  ipcMain.on('zeus:renderer-bootstrap-failed', (event, message: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const detail = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Renderer bootstrap failed without detail';
    rendererBootstrapMonitor.fail(requestingWindow, new Error(`Renderer bootstrap failed: ${detail}`));
  });
  ipcMain.on('zeus:renderer-bootstrap-ready', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    rendererBootstrapMonitor.markReady(requestingWindow);
  });
  ipcMain.on('zeus:renderer-runtime-failed', (event, message: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !rendererBootstrapMonitor.isReady(requestingWindow)) return;
    const detail = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Renderer runtime failed without detail';
    void startupCoordinator.fail(new Error(`Renderer runtime failed: ${detail}`));
  });
  ipcMain.handle('zeus:open-external-https-url', (event, url: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return { opened: false, error: 'external_open_untrusted_sender' };
    return openExternalHttpsUrl({
      url,
      openExternal: (url) => shell.openExternal(url),
    });
  });
  ipcMain.handle('zeus:window-drag-start', (event, point: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dragPoint = normalizeDragPoint(point);
    if (!window || window.isDestroyed() || window.isFullScreen() || !dragPoint) return { dragging: false };
    const [windowX, windowY] = window.getPosition();
    // Electron 的 app-region 在 hiddenInset + file:// asar 组合下可能不触发原生拖动；
    // Main 进程用真实屏幕坐标移动窗口，确保顶部空白区一定可拖。
    manualWindowDragStates.set(event.sender.id, {
      pointerX: dragPoint.screenX,
      pointerY: dragPoint.screenY,
      windowX,
      windowY,
    });
    return { dragging: true };
  });
  ipcMain.handle('zeus:window-drag-move', (event, point: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const dragPoint = normalizeDragPoint(point);
    const dragState = manualWindowDragStates.get(event.sender.id);
    if (!window || window.isDestroyed() || window.isFullScreen() || !dragPoint || !dragState) return { dragging: false };
    const nextX = Math.round(dragState.windowX + dragPoint.screenX - dragState.pointerX);
    const nextY = Math.round(dragState.windowY + dragPoint.screenY - dragState.pointerY);
    window.setPosition(nextX, nextY, false);
    return { dragging: true, x: nextX, y: nextY };
  });
  ipcMain.handle('zeus:window-drag-end', (event) => {
    manualWindowDragStates.delete(event.sender.id);
    return { dragging: false };
  });
  ipcMain.handle('zeus:choose-project-directory', () =>
    chooseProjectDirectory(() =>
      dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: '选择 Zeus 项目代码库',
      }),
    ),
  );
  ipcMain.handle('zeus:choose-task-attachments', async () => {
    const selected = await dialog.showOpenDialog({
      title: '选择任务图片或附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    if (selected.canceled) return [];
    return saveTaskAttachmentPayloads(await readTaskAttachmentFilePathPayloads(selected.filePaths));
  });
  ipcMain.handle('zeus:read-task-clipboard-attachments', () => readTaskClipboardAttachmentsFromNativeClipboard());
  ipcMain.handle('zeus:save-task-clipboard-attachments', async () => saveTaskAttachmentPayloads(await readTaskClipboardAttachmentsFromNativeClipboard()));
    ipcMain.handle('zeus:write-clipboard-text', (_event, text: unknown) => {
        if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string.');
        clipboard.writeText(text);
        return {written: clipboard.readText() === text};
    });
  ipcMain.handle('zeus:read-task-clipboard-image', async () => {
    const [firstAttachment] = await readTaskClipboardAttachmentsFromNativeClipboard();
    return firstAttachment ?? null;
  });
  ipcMain.handle('zeus:save-task-pasted-attachments', async (_event, attachments: Array<{ name: string; type: string; data: ArrayBuffer | Uint8Array }>) => {
    return saveTaskAttachmentPayloads(Array.isArray(attachments) ? attachments : []);
  });
  ipcMain.handle('zeus:get-task-attachment-preview', (_event, path: string) => loadSavedTaskAttachmentPreview(path));
  ipcMain.handle('zeus:open-task-attachment', (_event, path: string) => openSavedTaskAttachment(path));
  ipcMain.handle('zeus:export-settings-snapshot', (_event, snapshot: unknown) =>
    exportSettingsSnapshotToFile({
      snapshot,
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Zeus 设置快照',
          defaultPath: 'zeus-settings.json',
          filters: [{ name: 'Zeus Settings JSON', extensions: ['json'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:import-settings-snapshot', () =>
    importSettingsSnapshotFromFile({
      chooseFile: () =>
        dialog.showOpenDialog({
          title: '导入 Zeus 设置快照',
          properties: ['openFile'],
          filters: [{ name: 'Zeus Settings JSON', extensions: ['json'] }],
        }),
      readTextFile: (path) => readFile(path, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:import-business-data-snapshot', () =>
    importBusinessDataSnapshotFromFile({
      chooseFile: () =>
        dialog.showOpenDialog({
          title: '导入 Zeus 业务数据快照',
          properties: ['openFile'],
          filters: [{ name: 'Zeus Business Data JSON', extensions: ['json'] }],
        }),
      readTextFile: (path) => readFile(path, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:export-patch', (_event, patch: unknown) =>
    exportPatchToFile({
      patch: patch as { fileName: string; mimeType: string; patchText: string },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Zeus Patch',
          defaultPath: (patch as { fileName?: string }).fileName ?? 'zeus-diff.patch',
          filters: [{ name: 'Patch File', extensions: ['patch'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:open-graph-source', (_event, source: GraphSourceLocation) =>
    openGraphSourceLocation({
      projectRoot: resolveMainProjectRoot(),
      source,
      // 只检查文件存在性，不读取内容；打开动作交由 macOS 默认编辑器或文件关联处理。
      fileExists: async (filePath) => {
        try {
          await access(filePath);
          return true;
        } catch {
          return false;
        }
      },
      openPath: (filePath) => shell.openPath(filePath),
    }),
  );
  ipcMain.handle('zeus:export-mermaid-diagram', (_event, payload: unknown) =>
    exportMermaidDiagramToFile({
      payload: payload as {
        fileName: string;
        mimeType: string;
        content: string;
      },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Mermaid 源码',
          defaultPath: (payload as { fileName?: string }).fileName ?? 'zeus-graph.mmd',
          filters: [{ name: 'Mermaid Diagram', extensions: ['mmd'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:export-plantuml-diagram', (_event, payload: unknown) =>
    exportPlantUmlDiagramToFile({
      payload: payload as {
        fileName: string;
        mimeType: string;
        content: string;
      },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 PlantUML 源码',
          defaultPath: (payload as { fileName?: string }).fileName ?? 'zeus-graph.puml',
          filters: [{ name: 'PlantUML Diagram', extensions: ['puml', 'plantuml'] }],
        }),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:export-runtime-logs', (_event, payload: unknown) =>
    exportRuntimeLogsToFile({
      payload: payload as {
        fileName: string;
        mimeType: string;
        sessionId: string;
        sourceFilePath?: string;
        logs: Array<{ createdAt: string; stream: string; text: string }>;
      },
      chooseFile: () =>
        dialog.showSaveDialog({
          title: '导出 Zeus Runtime 日志',
          defaultPath: (payload as { fileName?: string }).fileName ?? 'zeus-runtime.log',
          filters: [{ name: 'Runtime Log', extensions: ['log', 'txt'] }],
        }),
      isAllowedSourceFile: isRuntimeLogSourcePathAllowed,
      readTextFile: (path) => readFile(path, 'utf8'),
      writeTextFile: (path, content) => writeFile(path, content, 'utf8'),
    }),
  );
  ipcMain.handle('zeus:app-shell-settings-changed', (_event, settings: Partial<MainAppShellSettings>) => {
    appShellSettings = {
      webviewDebugEnabled: settings.webviewDebugEnabled === true,
      multiWindowEnabled: typeof settings.multiWindowEnabled === 'boolean' ? settings.multiWindowEnabled : appShellSettings.multiWindowEnabled,
      backgroundModeEnabled: typeof settings.backgroundModeEnabled === 'boolean' ? settings.backgroundModeEnabled : appShellSettings.backgroundModeEnabled,
      desktopNotificationsEnabled: typeof settings.desktopNotificationsEnabled === 'boolean' ? settings.desktopNotificationsEnabled : appShellSettings.desktopNotificationsEnabled,
      openAtLoginEnabled: typeof settings.openAtLoginEnabled === 'boolean' ? settings.openAtLoginEnabled : appShellSettings.openAtLoginEnabled,
    };
    setupMenu();
    setupTraySafely();
    applySystemNotificationBridge();
    applyLoginItemSettings();
    return { applied: true };
  });
}

/** 解析 Telegram 白名单，非法值直接忽略，避免把错误配置当作授权用户。 */
function parseTelegramAllowedUserIds(raw: string | undefined): number[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item));
}

function setupTray(): void {
  if (!tray) {
    const trayIconPath = join(desktopRoot(), 'assets/trayTemplate.png');
    const trayIcon = nativeImage.createFromBuffer(readFileSync(trayIconPath));
    if (trayIcon.isEmpty()) throw new Error(`Zeus tray icon is empty: ${trayIconPath}`);
    trayIcon.setTemplateImage(true);
    tray = new Tray(trayIcon);
    tray.setToolTip('Zeus');
  }
  tray.setContextMenu(
    Menu.buildFromTemplate(
      buildMenuBarTrayTemplate({
        settings: appShellSettings,
        showMainWindow: () => {
          void requestMainWindow();
        },
        createWindow: () => {
          if (fatalStartup) return;
          void createWindow().catch((error: unknown) => {
            void startupCoordinator.fail(error);
          });
        },
        quit: () => app.quit(),
      }) as Electron.MenuItemConstructorOptions[],
    ),
  );
}

function setupTraySafely(): void {
  try {
    setupTray();
  } catch (error) {
    tray = undefined;
    // 托盘图标缺失或 macOS 拒绝创建 Tray 时，不阻断设置保存和主窗口功能。
    console.warn('Zeus tray is unavailable; continuing without menu bar tray.', error);
  }
}

function isImageAttachmentPath(filePath: string): boolean {
  return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(extname(filePath).toLowerCase());
}

function taskAttachmentDirectory(): string {
  return join(app.getPath('userData'), 'task-attachments');
}

function isInsideTaskAttachmentDirectory(filePath: string): boolean {
  const directory = taskAttachmentDirectory();
  const resolvedDirectory = resolve(directory);
  const resolvedFilePath = resolve(filePath);
  const relativePath = relative(resolvedDirectory, resolvedFilePath);
  return relativePath.length > 0 && !relativePath.startsWith('..') && !isAbsolute(relativePath);
}

function sanitizeTaskAttachmentFileName(fileName: string): string {
  const safeName = basename(fileName)
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
  // 文件名为空或只有非法字符时保留稳定 fallback，避免 userData 附件目录出现不可读文件。
  return safeName || 'pasted-task-attachment';
}

function readTaskClipboardAttachmentsFromNativeClipboard(): Promise<TaskClipboardAttachmentPayload[]> {
  return readTaskClipboardAttachmentsFromClipboard(
    {
      readImage: () => clipboard.readImage(),
      availableFormats: () => clipboard.availableFormats(),
      readBuffer: (format) => clipboard.readBuffer(format),
      readText: () => clipboard.readText(),
      readHTML: () => clipboard.readHTML(),
    },
    {
      readSystemFileReferences: readMacOSClipboardFileReferences,
    },
  );
}

async function readMacOSClipboardFileReferences(): Promise<string[]> {
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await execFile(
      '/usr/bin/osascript',
      [
        '-e',
        `try
  set fileReference to the clipboard as «class furl»
  return POSIX path of fileReference
on error
  return ""
end try`,
      ],
      { timeout: 1000, maxBuffer: 64 * 1024 },
    );
    return stdout
      .split(/\r?\n/gu)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('/'));
  } catch {
    // Finder 复制文件时 Electron 可能只暴露文件图标；osascript 读不到 furl 时继续走 bitmap 回退。
    return [];
  }
}

async function loadSavedTaskAttachmentPreview(path: string): Promise<{ previewUrl: string; mimeType: string } | null> {
  if (typeof path !== 'string' || !isInsideTaskAttachmentDirectory(path)) return null;
  const mimeType = inferTaskClipboardAttachmentMimeType(path);
  if (!mimeType.startsWith('image/')) return null;
  const data = await readFile(path);
  const previewUrl = buildTaskAttachmentPreviewDataUrl(data, mimeType);
  return previewUrl ? { previewUrl, mimeType } : null;
}

async function openSavedTaskAttachment(path: string): Promise<{ opened: boolean; error?: string }> {
  if (typeof path !== 'string' || !isInsideTaskAttachmentDirectory(path)) return { opened: false, error: 'attachment_not_allowed' };
  try {
    const openError = await shell.openPath(path);
    return openError ? { opened: false, error: openError } : { opened: true };
  } catch (error) {
    return { opened: false, error: error instanceof Error ? error.message : 'open_attachment_failed' };
  }
}

async function saveTaskAttachmentPayloads(attachments: Array<{ name: string; type: string; data: ArrayBuffer | Uint8Array }>): Promise<Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }>> {
  if (attachments.length === 0) return [];
  const attachmentDirectory = taskAttachmentDirectory();
  await mkdir(attachmentDirectory, { recursive: true });
  const createdAt = Date.now();
  const savedAttachments: Array<{ path: string; name: string; kind: 'image' | 'file'; mimeType?: string; previewUrl?: string }> = [];
  for (const [index, attachment] of attachments.entries()) {
    const attachmentBuffer = coerceTaskClipboardAttachmentBuffer(attachment?.data);
    if (!attachment || !attachmentBuffer) continue;
    const safeName = sanitizeTaskAttachmentFileName(attachment.name || `pasted-task-attachment-${index + 1}`);
    const filePath = join(attachmentDirectory, `${createdAt}-${index}-${safeName}`);
    // 粘贴得到的是剪贴板二进制内容；Main 进程落到本机 userData 后，只把路径回传给任务上下文。
    await writeFile(filePath, attachmentBuffer);
    const mimeType = attachment.type || inferTaskClipboardAttachmentMimeType(filePath);
    const kind = mimeType.startsWith('image/') || isImageAttachmentPath(filePath) ? 'image' : 'file';
    savedAttachments.push({
      path: filePath,
      name: safeName,
      kind,
      mimeType,
      ...(kind === 'image' ? { previewUrl: buildTaskAttachmentPreviewDataUrl(attachmentBuffer, mimeType) } : {}),
    });
  }
  return savedAttachments;
}

async function initializeApplication(): Promise<void> {
  await app.whenReady();
  const userDataPath = app.getPath('userData');
  const mainProjectRoot = resolveMainProjectRoot();
  const codexNativeEnabled = parseCodexNativeEnabled(process.env.ZEUS_CODEX_NATIVE_ENABLED);
  const codexRuntimeCommandPath = codexNativeEnabled
    ? await resolveCodexRuntimePath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: mainProjectRoot,
        arch: process.arch,
      })
    : undefined;
  localServerRuntime = await startDesktopLocalServer({
    userDataPath,
    projectRoot: mainProjectRoot,
    telegramToken: process.env.ZEUS_TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseTelegramAllowedUserIds(process.env.ZEUS_TELEGRAM_ALLOWED_USER_IDS),
    codexNativeEnabled,
    codexRuntimeCommandPath,
    codexLegacyImportRoot: join(userDataPath, 'codex-legacy-import'),
    taskAttachmentRoot: join(userDataPath, 'task-attachments'),
    onRestarted: () => {
      // 本地服务异常重启后，依赖旧 WebSocket 的系统通知桥必须重建，避免继续挂在旧端口。
      applySystemNotificationBridge();
    },
  });
  appShellSettings = await loadMainAppShellSettings(localServerRuntime.config);
  applyLoginItemSettings();
  setupMenu();
  setupIpc();
  setupTraySafely();
  applySystemNotificationBridge();
}

function handleFatalStartupError(error: unknown): void {
  fatalStartup = true;
  terminateAfterFatalStartup({
    error,
    reportError: (message, detail) => console.error(message, detail),
    showGenericError: () => dialog.showErrorBox('Zeus', 'Zeus 无法启动，请重新打开应用。'),
    quitApplication: () => app.quit(),
    forceExit: (code) => app.exit(code),
  });
}

const startupCoordinator = createStartupCoordinator({
  initialize: initializeApplication,
  revealOrCreateMainWindow,
  onFatalStartupError: handleFatalStartupError,
});
const rendererBootstrapMonitor = createRendererBootstrapMonitor<BrowserWindow>({
  onFailure: (_window, error) => {
    void startupCoordinator.fail(error);
  },
});

function requestMainWindow(): Promise<void> {
  if (fatalStartup) return Promise.resolve();
  return startupCoordinator.requestMainWindow();
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    void requestMainWindow();
  });
  void requestMainWindow();
}

app.on(
  'before-quit',
  createBeforeQuitCleanupHandler({
    closeSystemNotifications: () => {
      systemNotificationBridge?.close();
      systemNotificationBridge = undefined;
    },
    closeLocalServer: async () => {
      await localServerRuntime?.close();
      localServerRuntime = undefined;
    },
    exitApp: (code) => app.exit(code),
  }),
);

app.on('window-all-closed', () => {
  if (
    shouldQuitWhenAllWindowsClosed({
      platform: process.platform,
      backgroundModeEnabled: appShellSettings.backgroundModeEnabled,
    })
  )
    app.quit();
});

app.on('activate', () => {
  void requestMainWindow();
});

async function loadMainAppShellSettings(config: { baseUrl: string; apiToken: string }): Promise<MainAppShellSettings> {
  try {
    const response = await fetch(`${config.baseUrl}/api/settings/app-shell`, {
      headers: { authorization: `Bearer ${config.apiToken}` },
    });
    if (!response.ok) return appShellSettings;
    const body = (await response.json()) as Partial<MainAppShellSettings>;
    return {
      webviewDebugEnabled: body.webviewDebugEnabled === true,
      multiWindowEnabled: typeof body.multiWindowEnabled === 'boolean' ? body.multiWindowEnabled : true,
      backgroundModeEnabled: typeof body.backgroundModeEnabled === 'boolean' ? body.backgroundModeEnabled : true,
      desktopNotificationsEnabled: typeof body.desktopNotificationsEnabled === 'boolean' ? body.desktopNotificationsEnabled : true,
      openAtLoginEnabled: typeof body.openAtLoginEnabled === 'boolean' ? body.openAtLoginEnabled : false,
    };
  } catch {
    return appShellSettings;
  }
}

/** 限制 Renderer 传入的 Runtime 日志源路径，避免借导出能力读取任意本机敏感文件。 */
function isRuntimeLogSourcePathAllowed(sourceFilePath: string): boolean {
  const dbPath = localServerRuntime?.dbPath;
  if (!dbPath) return false;
  const sessionsRoot = resolve(dirname(dbPath), 'sessions');
  const resolvedSourcePath = resolve(sourceFilePath);
  return basename(resolvedSourcePath) === 'terminal.normalized.log' && resolvedSourcePath.startsWith(`${sessionsRoot}${sep}`);
}

/** 按当前本机设置重建系统通知订阅，确保关闭开关后不会继续弹出 native notification。 */
function applySystemNotificationBridge(): void {
  systemNotificationBridge?.close();
  systemNotificationBridge = undefined;
  if (!localServerRuntime) return;
  if (
    !shouldUseSystemNotifications({
      desktopNotificationsEnabled: appShellSettings.desktopNotificationsEnabled,
      notificationSupported: Notification.isSupported(),
    })
  )
    return;
  systemNotificationBridge = startSystemNotificationBridge(localServerRuntime.config);
}

/** 将本机开机启动偏好应用到 macOS 登录项；失败不影响 Zeus 主流程启动。 */
function applyLoginItemSettings(): void {
  try {
    app.setLoginItemSettings(
      buildLoginItemSettings({
        openAtLoginEnabled: appShellSettings.openAtLoginEnabled,
      }),
    );
  } catch {
    // 某些开发或测试环境可能不允许写入登录项，设置页仍保留用户偏好以便下次真实 App 启动时重试。
  }
}

function startSystemNotificationBridge(config: { baseUrl: string; apiToken: string }): SystemNotificationBridge | undefined {
  if (!Notification.isSupported()) return undefined;
  try {
    return createSystemNotificationBridge({
      baseUrl: config.baseUrl,
      apiToken: config.apiToken,
      openWebSocket: (url, protocol) =>
        new (
          globalThis as unknown as {
            WebSocket: new (
              url: string,
              protocol?: string,
            ) => {
              addEventListener(type: 'message', listener: (event: { data: string }) => void): void;
              close(): void;
            };
          }
        ).WebSocket(url, protocol),
      showNotification: (payload) => {
        // 系统通知只展示真实事件摘要，不包含 token、证书、命令明文等敏感数据。
        new Notification(payload).show();
      },
    });
  } catch {
    return undefined;
  }
}
