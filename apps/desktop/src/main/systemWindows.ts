import { BrowserWindow, ipcMain, nativeTheme, screen } from 'electron';
import { createPersistentWindow } from './persistentWindow.js';

/** 只允许已迁移的工作界面创建空白系统窗口，不接受任意地址或窗口配置。 */
const windowSizes = {
  'git-push': { width: 1240, height: 780, minWidth: 520, minHeight: 420 },
  'git-commit': { width: 720, height: 580, minWidth: 440, minHeight: 360 },
  'task-push': { width: 1280, height: 820, minWidth: 560, minHeight: 480 },
  'file-preview': { width: 1120, height: 780, minWidth: 420, minHeight: 360 },
};

/** 子窗口只承载原工作区的 React 内容，业务授权仍属于创建它的窗口。 */
const systemWindows = new Map<string, { owner: BrowserWindow; window: BrowserWindow; reveal: () => unknown; close: () => void }>();

/** 查找当前工作区正在操作的系统窗口，文件选择和后续 diff 均跟随它。 */
export function activeSystemWindow(owner: BrowserWindow): BrowserWindow {
  /** 只接受同一来源的子窗口，不能跨工作区借用焦点。 */
  const focused = BrowserWindow.getFocusedWindow();
  return [...systemWindows.values()].find((entry) => entry.owner === owner && entry.window === focused)?.window ?? owner;
}

/** 创建固定类型的同源空白窗口；外链、表单提交和未知名称仍全部拒绝。 */
export function systemWindowOpenHandler(owner: BrowserWindow): Parameters<Electron.WebContents['setWindowOpenHandler']>[0] {
  return (details) => {
    /** 随机名称区分同类窗口，类型限定尺寸记忆与可打开的界面。 */
    const match = /^zeus-system:(git-push|git-commit|task-push|file-preview):[0-9a-f-]{36}$/u.exec(details.frameName);
    if (details.url !== 'about:blank' || !match || details.postBody || systemWindows.has(details.frameName)) return { action: 'deny' };
    /** 不允许失控页面无限创建隐藏窗口。 */
    if ([...systemWindows.values()].filter((entry) => entry.owner === owner).length >= 12) return { action: 'deny' };
    /** 尺寸只来自主进程白名单。 */
    const kind = match[1] as keyof typeof windowSizes;
    return {
      action: 'allow',
      createWindow: (options) => {
        /** 首次打开使用当前操作窗口所在屏幕，历史尺寸由已有组件恢复。 */
        const parent = activeSystemWindow(owner);
        /** 可用工作区不包含系统菜单栏和任务栏。 */
        const area = screen.getDisplayMatching(parent.getBounds()).workArea;
        /** 保留 Electron 提供的 webContents，维持同源 opener 与 DOM 门户。 */
        const { window, reveal } = createPersistentWindow(`system-${kind}-window-state.json`, {
          ...options,
          ...windowSizes[kind],
          x: Math.round(area.x + (area.width - Math.min(windowSizes[kind].width, area.width)) / 2),
          y: Math.round(area.y + (area.height - Math.min(windowSizes[kind].height, area.height)) / 2),
          width: Math.min(windowSizes[kind].width, area.width),
          height: Math.min(windowSizes[kind].height, area.height),
          minWidth: Math.min(windowSizes[kind].minWidth, area.width),
          minHeight: Math.min(windowSizes[kind].minHeight, area.height),
          parent: owner,
          modal: false,
          show: false,
          title: 'Zeus',
          titleBarStyle: 'default',
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#181818' : '#f7f8fa',
          resizable: true,
          minimizable: true,
          maximizable: true,
          fullscreenable: true,
          webPreferences: { ...options.webPreferences, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false },
        });
        /** 用户关闭先交回表单；确认卸载后才允许原生关闭并保存最终尺寸。 */
        let closing = false;
        /** 复用既有持久窗口的 close 事件，不用 destroy 绕过尺寸保存。 */
        const close = (): void => {
          closing = true;
          if (window.isDestroyed()) return;
          /** 从预览返回原来的任务窗口；后台卸载不抢走用户焦点。 */
          const restoreFocus = window.isFocused();
          window.close();
          if (restoreFocus && !parent.isDestroyed()) parent.focus();
        };
        systemWindows.set(details.frameName, { owner, window, reveal, close });
        // 空白页只接收原窗口绘制的内容，不允许导航后继续持有 opener。
        window.webContents.on('will-navigate', (event) => event.preventDefault());
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.setMenuBarVisibility(false);
        window.on('close', (event) => {
          if (closing || owner.isDestroyed()) return;
          event.preventDefault();
          owner.webContents.send('zeus:system-window:close-request', details.frameName);
        });
        /** 主窗口退出时不留下无业务状态的空白子窗口。 */
        const destroy = (): void => {
          if (!window.isDestroyed()) window.destroy();
        };
        /** 原页面重载或崩溃后，旧 React 树已经失效。 */
        const navigate = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean): void => {
          if (isMainFrame && !isInPlace) close();
        };
        owner.once('closed', destroy);
        owner.webContents.on('did-start-navigation', navigate);
        owner.webContents.on('render-process-gone', close);
        window.once('closed', () => {
          systemWindows.delete(details.frameName);
          owner.removeListener('closed', destroy);
          if (!owner.webContents.isDestroyed()) {
            owner.webContents.removeListener('did-start-navigation', navigate);
            owner.webContents.removeListener('render-process-gone', close);
          }
        });
        return window.webContents;
      },
    };
  };
}

/** 展示和销毁只接受原窗口主框架及其自己创建的窗口身份。 */
export function registerSystemWindowIpc(): void {
  ipcMain.handle('zeus:system-window:update', (event, name: unknown, action: unknown) => {
    /** 页面不能通过猜测名称管理其他工作区窗口。 */
    const entry = typeof name === 'string' ? systemWindows.get(name) : undefined;
    if (!entry || entry.owner.webContents !== event.sender || event.senderFrame !== event.sender.mainFrame || entry.window.isDestroyed()) throw new Error('系统窗口归属已失效。');
    if (action === 'close') entry.close();
    else if (action === 'show') {
      if (entry.window.isMinimized()) entry.window.restore();
      entry.reveal();
      entry.window.focus();
    } else throw new Error('不支持的系统窗口操作。');
  });
}
