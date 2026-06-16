import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitCleanupHandler, startDesktopLocalServer } from '../src/main/localServerRuntime.js';
import { openLocalLogDirectory } from '../src/main/localLogDirectory.js';

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
