import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCodexAppServerManager, type CodexAppServerManager } from '@zeus/ai-runtime';
import { hasCodexFinalizationOwnershipClaim, startZeusLocalServer, type RunningZeusLocalServer } from '@zeus/local-server';

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
  codexNativeEnabled?: boolean;
  codexRuntimeCommandPath?: string;
  codexLegacyImportRoot?: string;
  taskAttachmentRoot?: string;
  codexAppServerManagerFactory?: () => CodexAppServerManager;
  localServerFactory?: typeof startZeusLocalServer;
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

export function parseCodexNativeEnabled(value: string | undefined): boolean {
  return value !== '0';
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
  const localServerFactory = options.localServerFactory ?? startZeusLocalServer;
  const codexAppServerManager = (options.codexAppServerManagerFactory ?? createCodexAppServerManager)();
  let closingIntentionally = false;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let restartPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  let shutdownOwner: RunningZeusLocalServer | undefined;
  let shutdownOwnerFinalized = false;
  await writeDesktopLocalAppConfig({
    configPath,
    userDataPath: options.userDataPath,
    projectRoot: options.projectRoot,
    dbPath,
  });
  let currentServer: RunningZeusLocalServer;
  try {
    currentServer = await launchServer();
  } catch (launchError) {
    const cleanupErrors: unknown[] = [];
    try {
      await codexAppServerManager.prepareForShutdown();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await codexAppServerManager.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) throw new AggregateError([launchError, ...cleanupErrors], 'Initial Zeus local-server launch and manager cleanup failed.');
    throw launchError;
  }
  const config: RendererLocalServerConfig = {
    baseUrl: currentServer.baseUrl,
    apiToken,
  };

  async function launchServer(): Promise<RunningZeusLocalServer> {
    const server = await localServerFactory({
      dbPath,
      localConfigPath: configPath,
      apiToken,
      projectRoot: options.projectRoot,
      telegramToken: options.telegramToken,
      telegramAllowedUserIds: options.telegramAllowedUserIds,
      codexNativeEnabled: options.codexNativeEnabled ?? true,
      codexRuntimeCommandPath: options.codexRuntimeCommandPath,
      codexLegacyImportRoot: options.codexLegacyImportRoot,
      taskAttachmentRoot: options.taskAttachmentRoot,
      codexAppServerManager,
    });
    server.server.server.once('close', () => {
      if (closingIntentionally) return;
      restartTimer = setTimeout(() => {
        restartTimer = undefined;
        if (restartPromise) return;
        const restarting = restartAfterUnexpectedClose().catch((error: unknown) => {
          if (hasCodexFinalizationOwnershipClaim(error)) shutdownOwnerFinalized = true;
          throw error;
        });
        const trackedRestart = restarting.finally(() => {
          if (restartPromise === trackedRestart) restartPromise = undefined;
        });
        restartPromise = trackedRestart;
        void restartPromise.catch(() => undefined);
      }, restartDelayMs);
    });
    return server;
  }

  async function restartAfterUnexpectedClose(): Promise<void> {
    if (closingIntentionally) return;
    const restartedServer = await launchServer();
    if (closingIntentionally) {
      const errors: unknown[] = [];
      shutdownOwner = restartedServer;
      try {
        await restartedServer.prepareForShutdown();
      } catch (error) {
        errors.push(error);
      }
      try {
        await restartedServer.close();
      } catch (error) {
        errors.push(error);
      }
      shutdownOwnerFinalized = true;
      throwCollectedCleanupErrors(errors, 'Late Zeus local-server restart cleanup failed.');
      return;
    }
    currentServer = restartedServer;
    config.baseUrl = restartedServer.baseUrl;
    await options.onRestarted?.(config);
  }

  return {
    dbPath,
    configPath,
    get server() {
      return currentServer;
    },
    config,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closingIntentionally = true;
        const errors: unknown[] = [];
        if (restartTimer) {
          clearTimeout(restartTimer);
          restartTimer = undefined;
        }
        const pendingRestart = restartPromise;
        if (pendingRestart) {
          try {
            await pendingRestart;
          } catch (error) {
            if (hasCodexFinalizationOwnershipClaim(error)) shutdownOwnerFinalized = true;
            collectCleanupError(errors, error);
          }
        }
        if (!shutdownOwnerFinalized) {
          const finalizationOwner = shutdownOwner ?? currentServer;
          try {
            await finalizationOwner.prepareForShutdown();
          } catch (error) {
            errors.push(error);
          }
          try {
            await finalizationOwner.close();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await codexAppServerManager.prepareForShutdown();
        } catch (error) {
          errors.push(error);
        }
        try {
          await codexAppServerManager.close();
        } catch (error) {
          errors.push(error);
        }
        throwCollectedCleanupErrors(errors, 'Zeus desktop local-server shutdown failed.');
      })();
      return closePromise;
    },
  };
}

function collectCleanupError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    errors.push(...error.errors);
    return;
  }
  errors.push(error);
}

function throwCollectedCleanupErrors(errors: unknown[], message: string): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, message);
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
