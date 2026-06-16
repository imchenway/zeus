import { app, BrowserWindow, Menu, Tray, ipcMain, dialog, shell, Notification, nativeImage } from 'electron';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createBeforeQuitCleanupHandler, startDesktopLocalServer, type DesktopLocalServerRuntime } from './localServerRuntime.js';
import { exportMermaidDiagramToFile } from './mermaidExport.js';
import { exportPatchToFile } from './patchExport.js';
import { exportRuntimeLogsToFile } from './runtimeLogExport.js';
import { chooseProjectDirectory } from './projectDirectoryPicker.js';
import { exportSettingsSnapshotToFile, importBusinessDataSnapshotFromFile, importSettingsSnapshotFromFile } from './settingsPortability.js';
import { openGraphSourceLocation, type GraphSourceLocation } from './sourceOpen.js';
import { buildAppShellMenuTemplate, buildLoginItemSettings, buildMenuBarTrayTemplate, shouldQuitWhenAllWindowsClosed, shouldUseSystemNotifications, type MainAppShellSettings } from './appShellPolicy.js';
import { createSystemNotificationBridge, type SystemNotificationBridge } from './systemNotifications.js';
import { openLocalLogDirectory } from './localLogDirectory.js';

let mainWindow: BrowserWindow | undefined;
const windows = new Set<BrowserWindow>();
let tray: Tray | undefined;
let localServerRuntime: DesktopLocalServerRuntime | undefined;
let systemNotificationBridge: SystemNotificationBridge | undefined;
let appShellSettings: MainAppShellSettings = {
  webviewDebugEnabled: false,
  multiWindowEnabled: true,
  backgroundModeEnabled: true,
  desktopNotificationsEnabled: true,
  openAtLoginEnabled: false,
};
const manualWindowDragStates = new Map<number, { pointerX: number; pointerY: number; windowX: number; windowY: number }>();

function desktopRoot(): string {
  return process.env.ZEUS_DESKTOP_DIR ?? app.getAppPath();
}

function revealMainWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  // macOS 直接启动、open 启动和 Codex Run 启动都必须把真实主窗口带到前台；
  // 否则用户会看到进程存在但没有可交互窗口，功能验证也无法继续。
  window.show();
  window.focus();
  app.focus({ steal: true });
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
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 980,
    minHeight: 720,
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

  windows.add(window);
  mainWindow = window;
  window.on('closed', () => {
    windows.delete(window);
    if (mainWindow === window) mainWindow = [...windows].at(-1);
  });

  let didRevealMainWindow = false;
  const revealMainWindowOnce = () => {
    if (didRevealMainWindow) return;
    didRevealMainWindow = true;
    revealMainWindow(window);
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
        createWindow: () => {
          void createWindow();
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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            void createWindow();
          }
        },
        quit: () => app.quit(),
      }) as Electron.MenuItemConstructorOptions[],
    ),
  );
}

/** 从 macOS 原生 Settings 菜单进入设置区域；只跳转页面锚点，不伪造任何设置状态。 */
async function openSettingsFromMenu(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
  await mainWindow?.webContents.executeJavaScript('globalThis.location.hash = "#settings-general";', true).catch(() => undefined);
}

/** 从 macOS 原生菜单进入发布与签名区域；只展示手动更新和等待项，不伪造在线更新 feed。 */
async function openReleaseStatusFromMenu(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
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
      projectRoot: process.env.ZEUS_PROJECT_ROOT ?? process.cwd(),
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
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            void createWindow();
          }
        },
        createWindow: () => {
          void createWindow();
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

app.whenReady().then(async () => {
  localServerRuntime = await startDesktopLocalServer({
    userDataPath: app.getPath('userData'),
    projectRoot: process.env.ZEUS_PROJECT_ROOT ?? process.cwd(),
    telegramToken: process.env.ZEUS_TELEGRAM_BOT_TOKEN,
    telegramAllowedUserIds: parseTelegramAllowedUserIds(process.env.ZEUS_TELEGRAM_ALLOWED_USER_IDS),
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
  await createWindow();
});

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

app.on('activate', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) await createWindow();
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
