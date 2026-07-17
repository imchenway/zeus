import { describe, expect, it, vi } from 'vitest';
import { buildAppShellMenuTemplate, buildLoginItemSettings, buildMenuBarTrayTemplate, shouldQuitWhenAllWindowsClosed, shouldUseSystemNotifications, type MainAppShellSettings } from '../src/main/appShellPolicy.js';

describe('Electron main app shell policy', () => {
  const baseSettings: MainAppShellSettings = {
    webviewDebugEnabled: false,
    multiWindowEnabled: true,
    backgroundModeEnabled: true,
    desktopNotificationsEnabled: true,
    openAtLoginEnabled: false,
  };

  it('routes Command+N to New Chat instead of opening another window', () => {
    const createWindow = vi.fn();
    const createNewConversation = vi.fn();
    const multiWindowMenu = buildAppShellMenuTemplate({
      settings: { ...baseSettings, multiWindowEnabled: true },
      createNewConversation,
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings: vi.fn(),
      openReleaseStatus: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
    });
    const singleWindowMenu = buildAppShellMenuTemplate({
      settings: { ...baseSettings, multiWindowEnabled: false },
      createNewConversation,
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings: vi.fn(),
      openReleaseStatus: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
    });

    const multiWindowItem = findMenuItem(multiWindowMenu, 'New Chat');
    const singleWindowItem = findMenuItem(singleWindowMenu, 'New Chat');

    expect(multiWindowItem?.accelerator).toBe('CommandOrControl+N');
    expect(multiWindowItem?.click).toBe(createNewConversation);
    expect(singleWindowItem?.click).toBe(createNewConversation);
    expect(createWindow).not.toHaveBeenCalled();
    expect(findMenuItem(multiWindowMenu, 'New Window')).toBeUndefined();
  });

  it('exposes a native Settings menu entry with the standard macOS shortcut', () => {
    const openSettings = vi.fn();
    const menu = buildAppShellMenuTemplate({
      settings: baseSettings,
      createNewConversation: vi.fn(),
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings,
      openReleaseStatus: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
    });

    const settingsItem = findMenuItem(menu, 'Settings...');

    expect(settingsItem?.accelerator).toBe('CommandOrControl+,');
    expect(settingsItem?.click).toBe(openSettings);
  });

  it('exposes a manual update check entry that opens the release status instead of claiming an update feed', () => {
    const openReleaseStatus = vi.fn();
    const menu = buildAppShellMenuTemplate({
      settings: baseSettings,
      createNewConversation: vi.fn(),
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings: vi.fn(),
      openReleaseStatus,
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
    });

    const updatesItem = findMenuItem(menu, 'Check for Updates...');

    expect(updatesItem?.accelerator).toBe('CommandOrControl+U');
    expect(updatesItem?.click).toBe(openReleaseStatus);
  });

  it('exposes a local logs menu entry so long logs stay on the Mac instead of remote channels', () => {
    const openLogsDirectory = vi.fn();
    const menu = buildAppShellMenuTemplate({
      settings: baseSettings,
      createNewConversation: vi.fn(),
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings: vi.fn(),
      openReleaseStatus: vi.fn(),
      openLogsDirectory,
      quit: vi.fn(),
    });

    const logsItem = findMenuItem(menu, 'Open Logs Folder');

    expect(logsItem?.accelerator).toBe('CommandOrControl+L');
    expect(logsItem?.click).toBe(openLogsDirectory);
  });

  it('hides the DevTools toggle when WebView debugging is disabled', () => {
    const debugMenu = buildAppShellMenuTemplate({
      settings: { ...baseSettings, webviewDebugEnabled: true },
      createNewConversation: vi.fn(),
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings: vi.fn(),
      openReleaseStatus: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
    });
    const productionMenu = buildAppShellMenuTemplate({
      settings: { ...baseSettings, webviewDebugEnabled: false },
      createNewConversation: vi.fn(),
      toggleDevTools: vi.fn(),
      showMainWindow: vi.fn(),
      openSettings: vi.fn(),
      openReleaseStatus: vi.fn(),
      openLogsDirectory: vi.fn(),
      quit: vi.fn(),
    });

    expect(findMenuItem(debugMenu, 'Toggle Developer Tools')?.visible).toBe(true);
    expect(findMenuItem(productionMenu, 'Toggle Developer Tools')?.visible).toBe(false);
  });

  it('keeps Zeus resident on macOS only when background mode is enabled', () => {
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'darwin',
        backgroundModeEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'darwin',
        backgroundModeEnabled: false,
      }),
    ).toBe(true);
    expect(
      shouldQuitWhenAllWindowsClosed({
        platform: 'linux',
        backgroundModeEnabled: true,
      }),
    ).toBe(true);
  });

  it('subscribes to macOS system notifications only when the user enabled them and Electron supports notifications', () => {
    expect(
      shouldUseSystemNotifications({
        desktopNotificationsEnabled: true,
        notificationSupported: true,
      }),
    ).toBe(true);
    expect(
      shouldUseSystemNotifications({
        desktopNotificationsEnabled: false,
        notificationSupported: true,
      }),
    ).toBe(false);
    expect(
      shouldUseSystemNotifications({
        desktopNotificationsEnabled: true,
        notificationSupported: false,
      }),
    ).toBe(false);
  });

  it('maps the app shell open-at-login preference to the Electron login item contract', () => {
    expect(buildLoginItemSettings({ openAtLoginEnabled: true })).toEqual({
      openAtLogin: true,
    });
    expect(buildLoginItemSettings({ openAtLoginEnabled: false })).toEqual({
      openAtLogin: false,
    });
  });

  it('keeps the menu bar tray contract aligned with background and multi-window settings', () => {
    const showMainWindow = vi.fn();
    const createWindow = vi.fn();
    const quit = vi.fn();
    const menuBarTemplate = buildMenuBarTrayTemplate({
      settings: {
        ...baseSettings,
        multiWindowEnabled: false,
        backgroundModeEnabled: true,
      },
      showMainWindow,
      createWindow,
      quit,
    });

    expect(menuBarTemplate.map((item) => item.label ?? item.type)).toEqual(['Show Zeus', 'New Window', 'separator', 'Quit Zeus']);
    expect(findFlatMenuItem(menuBarTemplate, 'Show Zeus')?.click).toBe(showMainWindow);
    expect(findFlatMenuItem(menuBarTemplate, 'New Window')?.enabled).toBe(false);
    expect(findFlatMenuItem(menuBarTemplate, 'Quit Zeus')?.click).toBe(quit);
  });
});

function findMenuItem(
  template: ReturnType<typeof buildAppShellMenuTemplate>,
  label: string,
):
  | {
      label?: string;
      enabled?: boolean;
      visible?: boolean;
      accelerator?: string;
      click?: () => void | Promise<void>;
    }
  | undefined {
  for (const menu of template) {
    const submenu = Array.isArray(menu.submenu) ? menu.submenu : [];
    const found = submenu.find((item) => 'label' in item && item.label === label);
    if (found && 'label' in found) return found;
  }
  return undefined;
}

function findFlatMenuItem(template: ReturnType<typeof buildMenuBarTrayTemplate>, label: string): { label?: string; enabled?: boolean; click?: () => void | Promise<void> } | undefined {
  return template.find((item) => 'label' in item && item.label === label);
}
