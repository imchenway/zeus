import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startZeusLocalServer, type RunningZeusLocalServer } from '@zeus/local-server';

export interface RendererLocalServerConfig {
  baseUrl: string;
  apiToken: string;
}

export interface DesktopLocalServerRuntime {
  dbPath: string;
  configPath: string;
  config: RendererLocalServerConfig;
  readonly server: RunningZeusLocalServer;
  close: () => Promise<void>;
}

export interface StartDesktopLocalServerOptions {
  userDataPath: string;
  projectRoot: string;
  telegramToken?: string;
  telegramAllowedUserIds?: number[];
  restartDelayMs?: number;
  onRestarted?: (config: RendererLocalServerConfig) => void | Promise<void>;
}

export interface DesktopLocalAppConfigFile {
  appName: 'Zeus';
  projectRoot: string;
  dbPath: string;
  localLogDirectory: string;
  localServerHost: '127.0.0.1';
  updatedAt: string;
}

/**
 * 写入可追踪的本机运行配置文件；该文件只记录路径与监听边界，
 * 严禁写入 Renderer API token、Telegram token 等敏感凭据。
 */
async function writeDesktopLocalAppConfig(input: { configPath: string; userDataPath: string; projectRoot: string; dbPath: string }): Promise<void> {
  const configFile: DesktopLocalAppConfigFile = {
    appName: 'Zeus',
    projectRoot: input.projectRoot,
    dbPath: input.dbPath,
    localLogDirectory: `${input.dbPath}.logs`,
    localServerHost: '127.0.0.1',
    updatedAt: new Date().toISOString(),
  };

  await mkdir(input.userDataPath, { recursive: true });
  await writeFile(input.configPath, `${JSON.stringify(configFile, null, 2)}\n`, 'utf8');
}

/** Electron Main 启动本地服务，并只把本机 baseUrl 与临时 token 暴露给 Renderer。 */
export async function startDesktopLocalServer(options: StartDesktopLocalServerOptions): Promise<DesktopLocalServerRuntime> {
  const apiToken = randomBytes(24).toString('base64url');
  const dbPath = join(options.userDataPath, 'zeus.db');
  const configPath = join(options.userDataPath, 'zeus.config.json');
  const restartDelayMs = options.restartDelayMs ?? 1_000;
  let closingIntentionally = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  await writeDesktopLocalAppConfig({
    configPath,
    userDataPath: options.userDataPath,
    projectRoot: options.projectRoot,
    dbPath,
  });
  let currentServer = await launchServer();
  const config: RendererLocalServerConfig = {
    baseUrl: currentServer.baseUrl,
    apiToken,
  };

  async function launchServer(): Promise<RunningZeusLocalServer> {
    const server = await startZeusLocalServer({
      dbPath,
      localConfigPath: configPath,
      apiToken,
      projectRoot: options.projectRoot,
      telegramToken: options.telegramToken,
      telegramAllowedUserIds: options.telegramAllowedUserIds,
    });
    server.server.server.once('close', () => {
      if (closingIntentionally) return;
      restartTimer = setTimeout(() => {
        void restartAfterUnexpectedClose();
      }, restartDelayMs);
    });
    return server;
  }

  async function restartAfterUnexpectedClose(): Promise<void> {
    if (closingIntentionally) return;
    currentServer = await launchServer();
    config.baseUrl = currentServer.baseUrl;
    await options.onRestarted?.(config);
  }

  return {
    dbPath,
    configPath,
    get server() {
      return currentServer;
    },
    config,
    close: async () => {
      closingIntentionally = true;
      if (restartTimer) clearTimeout(restartTimer);
      await currentServer.close();
    },
  };
}

export interface BeforeQuitCleanupEvent {
  preventDefault: () => void;
}

export interface BeforeQuitCleanupResources {
  closeSystemNotifications?: () => void;
  closeLocalServer?: () => Promise<void>;
  exitApp: (code: number) => void;
}

/**
 * Electron 的 before-quit 不会等待 async listener；这里先同步拦截退出，
 * 等系统通知桥和本地服务都关闭后再显式退出，避免残留本机进程或旧 WebSocket。
 */
export function createBeforeQuitCleanupHandler(resources: BeforeQuitCleanupResources): (event: BeforeQuitCleanupEvent) => void {
  let cleanupStarted = false;
  return (event) => {
    event.preventDefault();
    if (cleanupStarted) return;
    cleanupStarted = true;
    void (async () => {
      try {
        resources.closeSystemNotifications?.();
        await resources.closeLocalServer?.();
      } finally {
        resources.exitApp(0);
      }
    })();
  };
}
