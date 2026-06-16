/** Electron Main 只依赖这三个开关来决定窗口、菜单与后台驻留策略。 */
export interface MainAppShellSettings {
  webviewDebugEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
}

export interface AppShellMenuActions {
  settings: MainAppShellSettings;
  createWindow: () => void | Promise<void>;
  toggleDevTools: () => void;
  showMainWindow: () => void;
  openSettings: () => void | Promise<void>;
  openReleaseStatus: () => void | Promise<void>;
  openLogsDirectory: () => void | Promise<void>;
  quit: () => void;
}

export interface MenuBarTrayActions {
  settings: Pick<MainAppShellSettings, 'multiWindowEnabled' | 'backgroundModeEnabled'>;
  showMainWindow: () => void;
  createWindow: () => void | Promise<void>;
  quit: () => void;
}

export interface AppShellMenuItem {
  label?: string;
  role?: string;
  type?: 'separator';
  accelerator?: string;
  enabled?: boolean;
  visible?: boolean;
  click?: () => void | Promise<void>;
  submenu?: AppShellMenuItem[];
}

/** 根据用户设置生成菜单模板，避免 Renderer 设置只停留在页面展示。 */
export function buildAppShellMenuTemplate(actions: AppShellMenuActions): AppShellMenuItem[] {
  return [
    {
      label: 'Zeus',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'CommandOrControl+,',
          click: actions.openSettings,
        },
        {
          label: 'Check for Updates...',
          accelerator: 'CommandOrControl+U',
          click: actions.openReleaseStatus,
        },
        { type: 'separator' },
        { label: 'Show Zeus', click: actions.showMainWindow },
        {
          label: 'Open Logs Folder',
          accelerator: 'CommandOrControl+L',
          click: actions.openLogsDirectory,
        },
        { type: 'separator' },
        { role: 'quit', click: actions.quit },
      ],
    },
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CommandOrControl+N',
          enabled: actions.settings.multiWindowEnabled,
          click: actions.createWindow,
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        {
          label: 'Toggle Developer Tools',
          accelerator: 'Alt+CommandOrControl+I',
          visible: actions.settings.webviewDebugEnabled,
          enabled: actions.settings.webviewDebugEnabled,
          click: actions.toggleDevTools,
        },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ];
}

/**
 * 生成 macOS Menu Bar 常驻菜单。即使后台模式关闭也保留退出入口；
 * 多窗口关闭时禁用 New Window，避免 Tray 绕过用户的窗口策略。
 */
export function buildMenuBarTrayTemplate(actions: MenuBarTrayActions): AppShellMenuItem[] {
  return [
    { label: 'Show Zeus', click: actions.showMainWindow },
    {
      label: 'New Window',
      enabled: actions.settings.multiWindowEnabled,
      click: actions.createWindow,
    },
    { type: 'separator' },
    { label: 'Quit Zeus', click: actions.quit },
  ];
}

/** macOS 上只有开启后台模式才常驻；关闭后台模式时最后一个窗口关闭即退出。 */
export function shouldQuitWhenAllWindowsClosed(input: { platform: NodeJS.Platform | string; backgroundModeEnabled: boolean }): boolean {
  if (input.platform !== 'darwin') return true;
  return !input.backgroundModeEnabled;
}

/** 只有用户开启且 Electron 支持 native notification 时，才订阅本地事件流并弹出系统通知。 */
export function shouldUseSystemNotifications(input: { desktopNotificationsEnabled: boolean; notificationSupported: boolean }): boolean {
  return input.desktopNotificationsEnabled && input.notificationSupported;
}

/** 将 Zeus 本机设置映射成 Electron 登录项 API 参数，保持 Main 进程逻辑可测试。 */
export function buildLoginItemSettings(input: { openAtLoginEnabled: boolean }): { openAtLogin: boolean } {
  return { openAtLogin: input.openAtLoginEnabled };
}
