/** Electron Main 只依赖这三个开关来决定窗口、菜单与后台驻留策略。 */
export interface MainAppShellSettings {
  appLanguage: 'zh-CN' | 'en-US';
  webviewDebugEnabled: boolean;
  multiWindowEnabled: boolean;
  backgroundModeEnabled: boolean;
  desktopNotificationsEnabled: boolean;
  openAtLoginEnabled: boolean;
}

export interface AppShellMenuActions {
  applicationName: string;
  settings: MainAppShellSettings;
  createNewConversation: () => void | Promise<void>;
  toggleDevTools: () => void;
  showMainWindow: () => void;
  openSettings: () => void | Promise<void>;
  checkForUpdates: () => void | Promise<void>;
  openLogsDirectory: () => void | Promise<void>;
  closeFocusedWindow: () => void;
  quit: () => void;
}

export interface MenuBarTrayActions {
  applicationName: string;
  settings: Pick<MainAppShellSettings, 'multiWindowEnabled' | 'backgroundModeEnabled'> & { appLanguage?: MainAppShellSettings['appLanguage'] };
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
  // 设置加载前沿用中文；角色菜单也显式跟随应用语言。
  const zh = actions.settings.appLanguage !== 'en-US';
  const appName = actions.applicationName;
  return [
    {
      label: appName,
      submenu: [
        { role: 'about', label: zh ? `关于 ${appName}` : `About ${appName}` },
        { type: 'separator' },
        {
          label: zh ? '设置…' : 'Settings...',
          accelerator: 'CommandOrControl+,',
          click: actions.openSettings,
        },
        {
          label: zh ? '检查更新…' : 'Check for Updates...',
          accelerator: 'CommandOrControl+U',
          click: actions.checkForUpdates,
        },
        { type: 'separator' },
        { label: zh ? `显示 ${appName}` : `Show ${appName}`, click: actions.showMainWindow },
        {
          label: zh ? '打开日志文件夹' : 'Open Logs Folder',
          accelerator: 'CommandOrControl+L',
          click: actions.openLogsDirectory,
        },
        { type: 'separator' },
        { role: 'quit', label: zh ? `退出 ${appName}` : `Quit ${appName}`, click: actions.quit },
      ],
    },
    {
      label: zh ? '文件' : 'File',
      submenu: [
        {
          label: zh ? '新建对话' : 'New Chat',
          accelerator: 'CommandOrControl+N',
          click: actions.createNewConversation,
        },
      ],
    },
    {
      label: zh ? '编辑' : 'Edit',
      submenu: [
        { role: 'undo', label: zh ? '撤销' : 'Undo' },
        { role: 'redo', label: zh ? '重做' : 'Redo' },
        { type: 'separator' },
        { role: 'cut', label: zh ? '剪切' : 'Cut' },
        { role: 'copy', label: zh ? '复制' : 'Copy' },
        { role: 'paste', label: zh ? '粘贴' : 'Paste' },
        { type: 'separator' },
        { role: 'selectAll', label: zh ? '全选' : 'Select All' },
      ],
    },
    {
      label: zh ? '显示' : 'View',
      submenu: [
        { role: 'reload', label: zh ? '重新加载页面' : 'Reload Page' },
        {
          label: zh ? '开发者工具' : 'Toggle Developer Tools',
          accelerator: 'Alt+CommandOrControl+I',
          visible: actions.settings.webviewDebugEnabled,
          enabled: actions.settings.webviewDebugEnabled,
          click: actions.toggleDevTools,
        },
      ],
    },
    {
      label: zh ? '窗口' : 'Window',
      submenu: [
        { role: 'minimize', label: zh ? '最小化' : 'Minimize' },
        {
          label: zh ? '关闭窗口' : 'Close',
          accelerator: 'CommandOrControl+W',
          click: actions.closeFocusedWindow,
        },
      ],
    },
  ];
}

/**
 * 生成 macOS Menu Bar 常驻菜单。即使后台模式关闭也保留退出入口；
 * 多窗口关闭时禁用 New Window，避免 Tray 绕过用户的窗口策略。
 */
export function buildMenuBarTrayTemplate(actions: MenuBarTrayActions): AppShellMenuItem[] {
  // 设置加载前沿用中文；角色菜单也显式跟随应用语言。
  const zh = actions.settings.appLanguage !== 'en-US';
  const appName = actions.applicationName;
  return [
    { label: zh ? `显示 ${appName}` : `Show ${appName}`, click: actions.showMainWindow },
    {
      label: zh ? '新建窗口' : 'New Window',
      enabled: actions.settings.multiWindowEnabled,
      click: actions.createWindow,
    },
    { type: 'separator' },
    { label: zh ? `退出 ${appName}` : `Quit ${appName}`, click: actions.quit },
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

/** 将 Zeus 本机设置映射成 Electron 登录项 API 参数，保持 Main 进程逻辑纯净且可复用。 */
export function buildLoginItemSettings(input: { openAtLoginEnabled: boolean }): { openAtLogin: boolean } {
  return { openAtLogin: input.openAtLoginEnabled };
}
