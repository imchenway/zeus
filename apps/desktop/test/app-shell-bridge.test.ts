import { describe, expect, it, vi } from 'vitest';
import { notifyMainAppShellSettingsChanged, openGraphSourceInMain } from '../src/renderer/appShellBridge.js';

describe('renderer to Electron main app shell bridge', () => {
  it('notifies Electron Main after app shell settings are saved', async () => {
    const notifyAppShellSettingsChanged = vi.fn().mockResolvedValue({ applied: true });
    await expect(
      notifyMainAppShellSettingsChanged({
        zeus: { notifyAppShellSettingsChanged },
        settings: {
          webviewDebugEnabled: true,
          multiWindowEnabled: false,
          backgroundModeEnabled: false,
          desktopNotificationsEnabled: false,
          openAtLoginEnabled: true,
        },
      }),
    ).resolves.toEqual({ applied: true });

    expect(notifyAppShellSettingsChanged).toHaveBeenCalledWith({
      webviewDebugEnabled: true,
      multiWindowEnabled: false,
      backgroundModeEnabled: false,
      desktopNotificationsEnabled: false,
      openAtLoginEnabled: true,
    });
  });

  it('is a no-op outside Electron preload', async () => {
    await expect(
      notifyMainAppShellSettingsChanged({
        zeus: undefined,
        settings: {
          webviewDebugEnabled: false,
          multiWindowEnabled: true,
          backgroundModeEnabled: true,
          desktopNotificationsEnabled: true,
          openAtLoginEnabled: false,
        },
      }),
    ).resolves.toEqual({ applied: false });
  });

  it('asks Electron Main to open a graph source location when preload is available', async () => {
    const openGraphSource = vi.fn().mockResolvedValue({
      opened: true,
      filePath: '/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx',
    });

    await expect(
      openGraphSourceInMain({
        zeus: { openGraphSource },
        source: {
          sourceRef: 'apps/desktop/src/renderer/App.tsx',
          lineStart: 42,
        },
      }),
    ).resolves.toEqual({
      opened: true,
      filePath: '/Users/david/hypha/zeus/apps/desktop/src/renderer/App.tsx',
    });

    expect(openGraphSource).toHaveBeenCalledWith({
      sourceRef: 'apps/desktop/src/renderer/App.tsx',
      lineStart: 42,
    });
  });
});
