import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { execFile as execFileCallback } from 'node:child_process';
import { constants as fsConstants, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { access, copyFile, cp, lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createBeforeQuitCleanupHandler, type DesktopLocalServerRuntime, parseCodexNativeEnabled, startDesktopLocalServer } from './localServerRuntime.js';
import { createStartupCoordinator } from './startupCoordinator.js';
import { terminateAfterFatalStartup } from './fatalStartup.js';
import { createRendererBootstrapMonitor } from './rendererBootstrapMonitor.js';
import { exportMermaidDiagramToFile, exportPlantUmlDiagramToFile } from './mermaidExport.js';
import { exportPatchToFile } from './patchExport.js';
import { exportRuntimeLogsToFile } from './runtimeLogExport.js';
import { chooseProjectDirectory } from './projectDirectoryPicker.js';
import { exportSettingsSnapshotToFile, importBusinessDataSnapshotFromFile, importSettingsSnapshotFromFile } from './settingsPortability.js';
import { type GraphSourceLocation, openGraphSourceLocation } from './sourceOpen.js';
import { buildAppShellMenuTemplate, buildLoginItemSettings, buildMenuBarTrayTemplate, type MainAppShellSettings, shouldQuitWhenAllWindowsClosed, shouldUseSystemNotifications } from './appShellPolicy.js';
import { createSystemNotificationBridge, type SystemNotificationBridge } from './systemNotifications.js';
import { openLocalLogDirectory } from './localLogDirectory.js';
import { openExternalHttpsUrl } from './externalOpen.js';
import { createPersistedMainWindowState, findSavedWindowDisplay, type PersistedMainWindowState, readPersistedMainWindowState, resolveMainWindowState, writePersistedMainWindowState } from './windowState.js';
import { applyRestoredMainWindowPlacement, createWindowStatePersistenceGate, waitForSavedWindowDisplay, type WindowStatePersistenceGate } from './windowRestoration.js';
import {
  buildTaskAttachmentPreviewDataUrl,
  coerceTaskClipboardAttachmentBuffer,
  inferTaskClipboardAttachmentMimeType,
  readTaskClipboardAttachmentsFromClipboard,
  readTaskClipboardFileReferencesFromClipboard,
  type TaskClipboardAttachmentPayload,
} from './taskClipboard.js';
import { type BrowserHost, createBrowserHost } from './browserHost.js';
import { type ConversationResourceRequest, listConversationResourceOpenTargets, openConversationResource, type OpenConversationResourceRequest } from './conversationResourceOpen.js';
import {
  type ConversationInputResourceBroker,
  type ConversationInputResourceSource,
  type ConversationResourcePayload,
  createConversationInputResourceBroker,
  readOrCreateConversationAttachmentGrantSecret,
} from './conversationInputResources.js';
import { cleanupStaleReleaseBackups, createReleaseUpdateService, type ReleaseUpdateService } from './releaseUpdateService.js';

let mainWindow: BrowserWindow | undefined;
const windows = new Set<BrowserWindow>();
let tray: Tray | undefined;
let localServerRuntime: DesktopLocalServerRuntime | undefined;
let releaseUpdateService: ReleaseUpdateService | undefined;
let browserHost: BrowserHost | undefined;
let conversationInputResources: ConversationInputResourceBroker | undefined;
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
const taskTableLayoutDirtyWindowIds = new Set<number>();
const sensitiveRequestDraftIdsByWindow = new Map<number, Set<string>>();
const taskTableLayoutCloseApprovedWindowIds = new Set<number>();
const pendingTaskTableLayoutWindowCloseIds = new Set<number>();
const pendingNativeUpdateCheckWindowIds = new Set<number>();
let taskTableLayoutQuitPending = false;
let taskTableLayoutQuitApproved = false;
let upgradeHandoffRequested = false;
const execFile = promisify(execFileCallback);
const windowStateSaveDelayMs = 250;
const windowStateActivationDelayMs = 500;
const savedDisplayAvailabilityTimeoutMs = 2_000;
const testDistributionName = 'Zeus Test';

function isTestDistribution(): boolean {
  if (!app.isPackaged) return false;
  const executablePath = process.execPath;
  return basename(executablePath, extname(executablePath)) === testDistributionName;
}

function desktopDisplayName(): string {
  return isTestDistribution() ? testDistributionName : 'Zeus';
}

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
  if (isTestDistribution()) app.setName(testDistributionName);

  const configured = process.env.ZEUS_USER_DATA_DIR?.trim();
  if (configured) {
    app.setPath('userData', resolve(configured));
    return;
  }

  // 测试发行版必须拥有独立单实例锁、配置和数据库，正式版继续沿用既有目录。
  if (isTestDistribution()) {
    app.setPath('userData', join(app.getPath('appData'), testDistributionName));
  }
}

// 打包验收可用隔离资料目录运行，禁止污染用户正在使用的 Zeus 数据。
applyExplicitUserDataDirectory();

function desktopRoot(): string {
  return process.env.ZEUS_DESKTOP_DIR ?? app.getAppPath();
}

function currentAppBundlePath(): string {
  let candidate = resolve(process.execPath);
  while (dirname(candidate) !== candidate) {
    if (candidate.endsWith('.app')) return candidate;
    candidate = dirname(candidate);
  }
  throw new Error('Zeus 无法定位当前 App bundle。');
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
  window.on('close', (event) => {
    flushMainWindowState(window);
    if (taskTableLayoutQuitApproved || taskTableLayoutCloseApprovedWindowIds.has(window.id) || !taskTableLayoutDirtyWindowIds.has(window.id)) return;
    event.preventDefault();
    pendingTaskTableLayoutWindowCloseIds.add(window.id);
    window.webContents.send('zeus:task-table-layout-close-requested');
  });
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
    title: desktopDisplayName(),
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
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle(desktopDisplayName());
  });
  browserHost?.registerWindow(window);

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
    browserHost?.unregisterWindow(window);
    const timer = windowStateSaveTimers.get(window.id);
    if (timer) clearTimeout(timer);
    windowStateSaveTimers.delete(window.id);
    const activationTimer = windowStateActivationTimers.get(window.id);
    if (activationTimer) clearTimeout(activationTimer);
    windowStateActivationTimers.delete(window.id);
    windowStatePersistenceGates.delete(window.id);
    taskTableLayoutDirtyWindowIds.delete(window.id);
    sensitiveRequestDraftIdsByWindow.delete(window.id);
    taskTableLayoutCloseApprovedWindowIds.delete(window.id);
    pendingTaskTableLayoutWindowCloseIds.delete(window.id);
    pendingNativeUpdateCheckWindowIds.delete(window.id);
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
        checkForUpdates: () => {
          void checkForUpdatesFromMenu();
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

/** 从 macOS 原生菜单触发真实更新检查；结果和用户决策由 Renderer 的统一弹窗承载。 */
async function checkForUpdatesFromMenu(): Promise<void> {
  await requestMainWindow();
  if (fatalStartup) return;
  const window = mainWindow;
  if (!window || window.isDestroyed()) return;
  if (!rendererBootstrapMonitor.isReady(window)) {
    pendingNativeUpdateCheckWindowIds.add(window.id);
    return;
  }
  window.webContents.send('zeus:native-check-for-updates');
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

async function revealProjectPathInFinder(value: unknown): Promise<{ revealed: true; path: string }> {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value.trim())) {
    throw new TypeError('Project path must be an absolute local path.');
  }
  const projectPath = resolve(value.trim());
  const projectPathStat = await stat(projectPath);
  if (!projectPathStat.isDirectory()) {
    throw new TypeError('Project path must point to a local directory.');
  }
  // showItemInFolder 会在 Finder 中选中项目目录；不能退化成 openPath，否则用户会进入目录而不是定位目录本身。
  shell.showItemInFolder(projectPath);
  return { revealed: true, path: projectPath };
}

function conversationResourceOpenServices(requestingWindow: BrowserWindow) {
  if (!localServerRuntime) throw new Error('Zeus local server is not ready.');
  return {
    config: localServerRuntime.config,
    fetchJson: async (url: string, init: { headers: Record<string, string> }) => {
      const response = await fetch(url, init);
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
        throw Object.assign(new Error(typeof record.message === 'string' ? record.message : `Local resource authority failed with HTTP ${response.status}.`), {
          code: typeof record.error === 'string' ? record.error : 'ZEUS_CONVERSATION_RESOURCE_AUTHORITY_FAILED',
        });
      }
      return payload;
    },
    pathExists: async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
    openExternal: (url: string) => shell.openExternal(url),
    openPath: (path: string) => shell.openPath(path),
    showItemInFolder: (path: string) => shell.showItemInFolder(path),
    writeClipboardText: (text: string) => clipboard.writeText(text),
    openBrowser: async (input: { conversationId: string; url: string }) => {
      if (!browserHost) throw new Error('Zeus BrowserHost is not ready.');
      return browserHost.openConversationResource(requestingWindow, input);
    },
    executeFile: (file: string, args: string[]) => execFile(file, args),
    applicationHome: app.getPath('home'),
    getSettings: () => {
      if (!browserHost) throw new Error('Zeus BrowserHost is not ready.');
      return browserHost.getSettings();
    },
  };
}

function setupIpc(): void {
  ipcMain.handle('zeus:get-local-server-config', async () => {
    if (!localServerRuntime) {
      throw new Error('Zeus local server is not ready');
    }
    return localServerRuntime.refreshConfig();
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
    if (pendingNativeUpdateCheckWindowIds.delete(requestingWindow.id)) {
      requestingWindow.webContents.send('zeus:native-check-for-updates');
    }
  });
  ipcMain.on('zeus:renderer-runtime-failed', (event, message: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !rendererBootstrapMonitor.isReady(requestingWindow)) return;
    const detail = typeof message === 'string' && message.trim() ? message.trim().slice(0, 500) : 'Renderer runtime failed without detail';
    void startupCoordinator.fail(new Error(`Renderer runtime failed: ${detail}`));
  });
  ipcMain.on('zeus:task-table-layout-dirty-changed', (event, dirty: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    if (dirty === true) taskTableLayoutDirtyWindowIds.add(requestingWindow.id);
    else taskTableLayoutDirtyWindowIds.delete(requestingWindow.id);
  });
  ipcMain.on('zeus:sensitive-request-draft-changed', (event, payload: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !payload || typeof payload !== 'object') return;
    const requestId = typeof (payload as { requestId?: unknown }).requestId === 'string' ? (payload as { requestId: string }).requestId.trim() : '';
    const present = (payload as { present?: unknown }).present === true;
    if (!requestId || requestId.length > 200) return;
    const requestIds = sensitiveRequestDraftIdsByWindow.get(requestingWindow.id) ?? new Set<string>();
    if (present) requestIds.add(requestId);
    else requestIds.delete(requestId);
    if (requestIds.size > 0) sensitiveRequestDraftIdsByWindow.set(requestingWindow.id, requestIds);
    else sensitiveRequestDraftIdsByWindow.delete(requestingWindow.id);
  });
  ipcMain.on('zeus:task-table-layout-close-resolution', (event, resolution: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return;
    const proceed = Boolean(resolution && typeof resolution === 'object' && (resolution as { proceed?: unknown }).proceed === true);
    if (!proceed) {
      pendingTaskTableLayoutWindowCloseIds.delete(requestingWindow.id);
      taskTableLayoutQuitPending = false;
      taskTableLayoutQuitApproved = false;
      return;
    }
    taskTableLayoutDirtyWindowIds.delete(requestingWindow.id);
    taskTableLayoutCloseApprovedWindowIds.add(requestingWindow.id);
    if (taskTableLayoutQuitPending) {
      if (taskTableLayoutDirtyWindowIds.size === 0) {
        taskTableLayoutQuitApproved = true;
        taskTableLayoutQuitPending = false;
        app.quit();
      }
      return;
    }
    if (pendingTaskTableLayoutWindowCloseIds.delete(requestingWindow.id)) requestingWindow.close();
  });
  ipcMain.handle('zeus:open-external-https-url', (event, url: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) return { opened: false, error: 'external_open_untrusted_sender' };
    return openExternalHttpsUrl({
      url,
      openExternal: (url) => shell.openExternal(url),
    });
  });
  ipcMain.handle('zeus:release:download-update', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Release update request came from an untrusted window.');
    if (!releaseUpdateService) throw new Error('Zeus release update service is not ready.');
    return releaseUpdateService.download();
  });
  ipcMain.handle('zeus:release:install-update', (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) throw new Error('Release update request came from an untrusted window.');
    if (!releaseUpdateService) throw new Error('Zeus release update service is not ready.');
    if (taskTableLayoutDirtyWindowIds.size > 0) {
      throw new Error('请先保存或放弃尚未保存的任务表布局，再安装更新。');
    }
    if ([...sensitiveRequestDraftIdsByWindow.values()].some((requestIds) => requestIds.size > 0)) {
      throw new Error('存在尚未提交的敏感回答。请先提交或清空敏感内容，再安装更新。');
    }
    return releaseUpdateService.install();
  });
  ipcMain.handle('zeus:conversation-resource:list-open-targets', (event, request: ConversationResourceRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Conversation resource request came from an untrusted window.');
    }
    return listConversationResourceOpenTargets(request, conversationResourceOpenServices(requestingWindow));
  });
  ipcMain.handle('zeus:conversation-resource:open', (event, request: OpenConversationResourceRequest) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Conversation resource request came from an untrusted window.');
    }
    return openConversationResource(request, conversationResourceOpenServices(requestingWindow));
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
  ipcMain.handle('zeus:reveal-project-in-finder', (event, projectPath: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow)) {
      throw new Error('Project reveal request came from an untrusted window.');
    }
    return revealProjectPathInFinder(projectPath);
  });
  ipcMain.handle('zeus:choose-conversation-resources', async (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource picker is unavailable for this window.');
    }
    const selected = await dialog.showOpenDialog(requestingWindow, {
      title: '选择文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (selected.canceled) return [];
    return conversationInputResources.describePaths(selected.filePaths, 'picker');
  });
  ipcMain.handle('zeus:authorize-conversation-files', async (event, paths: unknown, source: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation file authorization is unavailable for this window.');
    }
    const filePaths = Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : [];
    const normalizedSource: ConversationInputResourceSource = source === 'drop' ? 'drop' : 'paste';
    return conversationInputResources.describePaths(filePaths, normalizedSource);
  });
  ipcMain.handle('zeus:materialize-conversation-resources', async (event, payloads: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource materialization is unavailable for this window.');
    }
    const normalized = Array.isArray(payloads) ? payloads.filter((payload): payload is ConversationResourcePayload => Boolean(payload) && typeof payload === 'object' && !Array.isArray(payload)) : [];
    return conversationInputResources.materialize(normalized);
  });
  ipcMain.handle('zeus:read-conversation-clipboard-resources', async (event) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation clipboard access is unavailable for this window.');
    }
    return conversationInputResources.readClipboard();
  });
  ipcMain.handle('zeus:get-conversation-resource-preview', async (event, resource: unknown) => {
    const requestingWindow = BrowserWindow.fromWebContents(event.sender);
    if (!requestingWindow || requestingWindow.isDestroyed() || !windows.has(requestingWindow) || !conversationInputResources) {
      throw new Error('Conversation resource preview is unavailable for this window.');
    }
    const record = resource && typeof resource === 'object' && !Array.isArray(resource) ? (resource as { localPath?: string; uploadRef?: string }) : {};
    return conversationInputResources.preview(record);
  });
  ipcMain.handle('zeus:choose-task-attachments', async () => {
    const selected = await dialog.showOpenDialog({
      title: '选择文件或文件夹',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
    });
    if (selected.canceled) return [];
    const resources = await saveTaskResourcePaths(selected.filePaths);
    if (selected.filePaths.length > 0 && resources.length === 0) {
      throw new Error('No selected task resources could be copied into Zeus storage.');
    }
    return resources;
  });
  ipcMain.handle('zeus:store-task-resource-paths', (_event, paths: unknown) => saveTaskResourcePaths(Array.isArray(paths) ? paths.filter((path): path is string => typeof path === 'string') : []));
  ipcMain.handle('zeus:materialize-task-resources', (_event, resources: unknown) => saveTaskAttachmentPayloads(Array.isArray(resources) ? (resources as TaskResourcePayload[]) : []));
  ipcMain.handle('zeus:read-task-clipboard-resources', () => readTaskClipboardResourcesFromNativeClipboard());
  ipcMain.handle('zeus:read-task-clipboard-attachments', () => readTaskClipboardAttachmentsFromNativeClipboard());
  ipcMain.handle('zeus:save-task-clipboard-attachments', async () => {
    const result = await readTaskClipboardResourcesFromNativeClipboard();
    return result.resources;
  });
  ipcMain.handle('zeus:write-clipboard-text', (_event, text: unknown) => {
    if (typeof text !== 'string') throw new TypeError('Clipboard text must be a string.');
    clipboard.writeText(text);
    return { written: clipboard.readText() === text };
  });
  ipcMain.handle('zeus:read-task-clipboard-image', async () => {
    const [firstAttachment] = await readTaskClipboardAttachmentsFromNativeClipboard();
    return firstAttachment ?? null;
  });
  ipcMain.handle('zeus:save-task-pasted-attachments', async (_event, attachments: TaskResourcePayload[]) => {
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
  browserHost?.registerIpc();
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

type TaskStoredResourceKind = 'image' | 'file' | 'directory' | 'pasted_text';

type TaskStoredResource = {
  path: string;
  name: string;
  kind: TaskStoredResourceKind;
  mimeType?: string;
  size?: number;
  characterCount?: number;
  previewUrl?: string;
  restorableText?: string;
};

type TaskResourcePayload = {
  name?: string;
  type?: string;
  data?: ArrayBuffer | Uint8Array;
  text?: string;
  kind?: TaskStoredResourceKind;
};

const maximumTaskResourceCount = 100;
const maximumTaskResourceBytes = 100 * 1024 * 1024;
const maximumTaskResourceBatchBytes = 256 * 1024 * 1024;
const maximumTaskDirectoryEntries = 2_000;
const maximumTaskRestorableTextCharacters = 25_000;
const taskLongPasteThreshold = 5_000;

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
    .replace(/[^\p{L}\p{N}._ ()[\]-]+/gu, '-')
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

async function readTaskClipboardResourcesFromNativeClipboard(): Promise<{ resources: TaskStoredResource[]; text: string }> {
  const clipboardReader = {
    readImage: () => clipboard.readImage(),
    availableFormats: () => clipboard.availableFormats(),
    readBuffer: (format: string) => clipboard.readBuffer(format),
    readText: () => clipboard.readText(),
    readHTML: () => clipboard.readHTML(),
  };
  const readOptions = { readSystemFileReferences: readMacOSClipboardFileReferences };
  const referencedPaths = await readTaskClipboardFileReferencesFromClipboard(clipboardReader, readOptions);
  if (referencedPaths.length > 0) {
    return { resources: await saveTaskResourcePaths(referencedPaths), text: '' };
  }
  const attachments = await readTaskClipboardAttachmentsFromClipboard(clipboardReader, readOptions);
  if (attachments.length > 0) {
    return { resources: await saveTaskAttachmentPayloads(attachments), text: '' };
  }
  let text = '';
  try {
    text = clipboard.readText();
  } catch {
    // 剪贴板文字读取失败时按空内容处理，保留用户当前任务表单。
  }
  if (text.length >= taskLongPasteThreshold) {
    return {
      resources: await saveTaskAttachmentPayloads([{ name: 'Pasted text.txt', type: 'text/plain', text, kind: 'pasted_text' }]),
      text: '',
    };
  }
  return { resources: [], text };
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

async function saveTaskResourcePaths(paths: string[]): Promise<TaskStoredResource[]> {
  if (paths.length === 0) return [];
  const attachmentDirectory = taskAttachmentDirectory();
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
  const resources: TaskStoredResource[] = [];
  const seen = new Set<string>();
  let batchBytes = 0;
  for (const path of paths.slice(0, maximumTaskResourceCount)) {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) continue;
    try {
      const canonicalPath = await realpath(path);
      if (seen.has(canonicalPath)) continue;
      seen.add(canonicalPath);
      const sourceStat = await lstat(canonicalPath);
      if (sourceStat.isSymbolicLink() || (!sourceStat.isFile() && !sourceStat.isDirectory())) continue;
      const summary = sourceStat.isDirectory() ? await inspectTaskResourceTree(canonicalPath) : { bytes: sourceStat.size, entries: 1 };
      if (summary.bytes > maximumTaskResourceBytes || batchBytes + summary.bytes > maximumTaskResourceBatchBytes) {
        continue;
      }
      batchBytes += summary.bytes;
      const safeName = sanitizeTaskAttachmentFileName(basename(canonicalPath) || 'task-resource');
      const destination = join(attachmentDirectory, `${Date.now()}-${randomUUID()}-${safeName}`);
      if (sourceStat.isDirectory()) {
        await cp(canonicalPath, destination, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: async (source) => !(await lstat(source)).isSymbolicLink(),
        });
        resources.push({
          path: destination,
          name: safeName,
          kind: 'directory',
          mimeType: 'inode/directory',
          size: summary.bytes,
        });
        continue;
      }
      await copyFile(canonicalPath, destination, fsConstants.COPYFILE_EXCL);
      const mimeType = inferTaskClipboardAttachmentMimeType(destination);
      const kind = mimeType.startsWith('image/') || isImageAttachmentPath(destination) ? 'image' : 'file';
      const previewUrl = kind === 'image' && sourceStat.size <= maximumTaskResourceBytes ? buildTaskAttachmentPreviewDataUrl(await readFile(destination), mimeType) : undefined;
      resources.push({
        path: destination,
        name: safeName,
        kind,
        mimeType,
        size: sourceStat.size,
        ...(previewUrl ? { previewUrl } : {}),
      });
    } catch {
      // 单个文件、目录或复制动作失败时保留同批次中的其他可用资源。
    }
  }
  return resources;
}

async function inspectTaskResourceTree(rootPath: string): Promise<{ bytes: number; entries: number }> {
  const pending = [rootPath];
  let bytes = 0;
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      const entryStat = await lstat(entryPath);
      if (entryStat.isSymbolicLink()) throw new Error('Task attachment directories cannot contain symbolic links.');
      entries += 1;
      if (entries > maximumTaskDirectoryEntries) throw new Error('Task attachment directory contains too many entries.');
      if (entryStat.isDirectory()) pending.push(entryPath);
      else if (entryStat.isFile()) bytes += entryStat.size;
      else throw new Error('Task attachment directory contains an unsupported entry.');
      if (bytes > maximumTaskResourceBytes) throw new Error('Task attachment directory is too large.');
    }
  }
  return { bytes, entries };
}

async function saveTaskAttachmentPayloads(attachments: TaskResourcePayload[]): Promise<TaskStoredResource[]> {
  if (attachments.length === 0) return [];
  const attachmentDirectory = taskAttachmentDirectory();
  await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
  const savedAttachments: TaskStoredResource[] = [];
  let batchBytes = 0;
  for (const [index, attachment] of attachments.slice(0, maximumTaskResourceCount).entries()) {
    const text = typeof attachment?.text === 'string' ? attachment.text : undefined;
    const attachmentBuffer = text === undefined ? coerceTaskClipboardAttachmentBuffer(attachment?.data) : Buffer.from(text, 'utf8');
    if (!attachment || !attachmentBuffer || attachmentBuffer.byteLength === 0) continue;
    if (attachmentBuffer.byteLength > maximumTaskResourceBytes || batchBytes + attachmentBuffer.byteLength > maximumTaskResourceBatchBytes) {
      continue;
    }
    batchBytes += attachmentBuffer.byteLength;
    const safeName = sanitizeTaskAttachmentFileName(attachment.name || `pasted-task-attachment-${index + 1}`);
    const filePath = join(attachmentDirectory, `${Date.now()}-${randomUUID()}-${safeName}`);
    // 粘贴得到的是剪贴板二进制内容；Main 进程落到本机 userData 后，只把路径回传给任务上下文。
    await writeFile(filePath, attachmentBuffer, { flag: 'wx', mode: 0o600 });
    const mimeType = attachment.type || inferTaskClipboardAttachmentMimeType(filePath);
    const pastedText = text !== undefined || attachment.kind === 'pasted_text';
    const kind: TaskStoredResourceKind = pastedText ? 'pasted_text' : mimeType.startsWith('image/') || isImageAttachmentPath(filePath) ? 'image' : 'file';
    savedAttachments.push({
      path: filePath,
      name: safeName,
      kind,
      mimeType,
      size: attachmentBuffer.byteLength,
      ...(pastedText ? { characterCount: text?.length ?? 0 } : {}),
      ...(pastedText && text !== undefined && text.length <= maximumTaskRestorableTextCharacters ? { restorableText: text } : {}),
      ...(kind === 'image' ? { previewUrl: buildTaskAttachmentPreviewDataUrl(attachmentBuffer, mimeType) } : {}),
    });
  }
  return savedAttachments;
}

async function initializeApplication(): Promise<void> {
  await app.whenReady();
  const userDataPath = app.getPath('userData');
  const browserAttachmentRoot = join(userDataPath, 'browser-comments');
  const conversationAttachmentRoot = join(userDataPath, 'conversation-attachments');
  const conversationAttachmentGrantSecretPath = join(userDataPath, 'conversation-attachment-grant.secret');
  const conversationAttachmentGrantSecret = await readOrCreateConversationAttachmentGrantSecret(conversationAttachmentGrantSecretPath);
  conversationInputResources = createConversationInputResourceBroker({
    attachmentRoot: conversationAttachmentRoot,
    grantSecret: conversationAttachmentGrantSecret,
    clipboard: {
      readImage: () => clipboard.readImage(),
      availableFormats: () => clipboard.availableFormats(),
      readBuffer: (format) => clipboard.readBuffer(format),
      readText: () => clipboard.readText(),
      readHTML: () => clipboard.readHTML(),
    },
    clipboardReadOptions: { readSystemFileReferences: readMacOSClipboardFileReferences },
  });
  browserHost = createBrowserHost({
    userDataPath,
    preloadPath: join(desktopRoot(), 'dist/preload/browser-page.cjs'),
    attachmentRoot: browserAttachmentRoot,
    defaultDownloadDirectory: app.getPath('downloads'),
  });
  const mainProjectRoot = resolveMainProjectRoot();
  const codexNativeEnabled = parseCodexNativeEnabled(process.env.ZEUS_CODEX_NATIVE_ENABLED);
  const allowUntrustedReleaseUpdateTest = isTestDistribution() && process.env.ZEUS_ALLOW_UNTRUSTED_UPDATE_TEST === '1';
  localServerRuntime = await startDesktopLocalServer({
    userDataPath,
    projectRoot: mainProjectRoot,
    appVersion: app.getVersion(),
    telegramToken: process.env.ZEUS_TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseTelegramAllowedUserIds(process.env.ZEUS_TELEGRAM_ALLOWED_USER_IDS),
    codexNativeEnabled,
    codexLegacyImportRoot: join(userDataPath, 'codex-legacy-import'),
    releaseUpdateManifestUrl: allowUntrustedReleaseUpdateTest ? process.env.ZEUS_RELEASE_UPDATE_MANIFEST_URL : undefined,
    allowUntrustedReleaseUpdateTest,
    taskAttachmentRoot: join(userDataPath, 'task-attachments'),
    browserAttachmentRoot,
    conversationAttachmentRoot,
    conversationAttachmentGrantSecret,
    conversationAttachmentGrantSecretPath,
    browserAutomation: browserHost,
    onRestarted: () => {
      // 本地服务异常重启后，依赖旧 WebSocket 的系统通知桥必须重建，避免继续挂在旧端口。
      applySystemNotificationBridge();
    },
  });
  if (app.isPackaged) {
    releaseUpdateService = createReleaseUpdateService({
      userDataPath,
      currentAppPath: currentAppBundlePath(),
      currentExecutablePath: process.execPath,
      currentAppVersion: app.getVersion(),
      localServerConfig: () => {
        if (!localServerRuntime) throw new Error('Zeus local server is not ready.');
        return localServerRuntime.config;
      },
      isPackaged: true,
      testMode: isTestDistribution(),
      allowUntrustedTestUpdate: allowUntrustedReleaseUpdateTest,
      onInstallReady: () => {
        upgradeHandoffRequested = true;
        taskTableLayoutQuitApproved = true;
        setImmediate(() => app.quit());
      },
    });
  }
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

async function resolveDesktopQuitMode(): Promise<'continue_in_background' | 'upgrade_handoff' | 'final_quit' | 'cancel'> {
  if (upgradeHandoffRequested) return 'upgrade_handoff';
  const runtime = localServerRuntime;
  if (!runtime) return 'final_quit';
  let status;
  try {
    status = await runtime.getStatus();
  } catch {
    // 无法确认后台工作时优先保护执行，避免一次状态探测失败把长任务连带终止。
    return 'continue_in_background';
  }
  if (!status.hasActiveWork) return 'final_quit';
  const options = {
    type: 'warning' as const,
    title: '仍有任务正在运行',
    message: '退出 Zeus 时如何处理正在运行的任务？',
    detail: `正在执行的轮次 ${status.activeTurnCount} 个，等待交互 ${status.waitingRequestCount} 个，其他 Runtime ${status.activeRuntimeCount} 个。`,
    buttons: ['退出界面，任务继续运行', '停止任务并退出', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  };
  const targetWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const result = targetWindow ? await dialog.showMessageBox(targetWindow, options) : await dialog.showMessageBox(options);
  if (result.response === 2) return 'cancel';
  if (result.response === 0) return 'continue_in_background';
  try {
    await runtime.stopActiveWork();
    return 'final_quit';
  } catch (error) {
    dialog.showErrorBox('Zeus', `无法安全停止全部任务，应用将保持打开。\n\n${error instanceof Error ? error.message : String(error)}`);
    return 'cancel';
  }
}

app.on(
  'before-quit',
  createBeforeQuitCleanupHandler({
    shouldDeferQuit: () => !taskTableLayoutQuitApproved && taskTableLayoutDirtyWindowIds.size > 0,
    requestQuitConfirmation: () => {
      if (taskTableLayoutQuitPending) return;
      taskTableLayoutQuitPending = true;
      for (const window of windows) {
        if (!window.isDestroyed() && taskTableLayoutDirtyWindowIds.has(window.id)) {
          window.webContents.send('zeus:task-table-layout-close-requested');
        }
      }
    },
    closeSystemNotifications: () => {
      systemNotificationBridge?.close();
      systemNotificationBridge = undefined;
    },
    resolveQuitMode: resolveDesktopQuitMode,
    closeLocalServer: async (mode) => {
      await browserHost?.close();
      browserHost = undefined;
      conversationInputResources = undefined;
      await localServerRuntime?.close(mode);
      localServerRuntime = undefined;
      if (mode === 'final_quit' && app.isPackaged) {
        await cleanupStaleReleaseBackups(currentAppBundlePath()).catch((error: unknown) => {
          console.warn('Zeus 未能在执行宿主关闭后清理旧 App 备份。', error);
        });
      }
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
    // 某些开发或受限运行环境可能不允许写入登录项，设置页仍保留用户偏好以便下次真实 App 启动时重试。
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
