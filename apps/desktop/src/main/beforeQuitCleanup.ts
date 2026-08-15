export type DesktopLocalServerCloseMode = 'continue_in_background' | 'upgrade_handoff' | 'final_quit' | 'force_quit';

export interface BeforeQuitCleanupEvent {
  preventDefault: () => void;
}

export interface BeforeQuitCleanupResources {
  closeSystemNotifications?: () => void;
  resolveQuitMode?: () => Promise<DesktopLocalServerCloseMode | 'cancel'>;
  closeLocalServer?: (mode: DesktopLocalServerCloseMode) => Promise<void>;
  shouldDeferQuit?: () => boolean;
  requestQuitConfirmation?: () => void;
  exitApp: (code: number) => void;
}

/**
 * Electron 的 before-quit 不会等待异步监听器；这里先同步拦截退出，
 * 等系统通知桥和本地服务都关闭后再显式退出，避免残留本机进程或旧连接。
 */
export function createBeforeQuitCleanupHandler(resources: BeforeQuitCleanupResources): (event: BeforeQuitCleanupEvent) => void {
  let cleanupStarted = false;
  return (event) => {
    event.preventDefault();
    if (cleanupStarted) return;
    if (resources.shouldDeferQuit?.()) {
      resources.requestQuitConfirmation?.();
      return;
    }
    cleanupStarted = true;
    void (async () => {
      try {
        const quitMode = (await resources.resolveQuitMode?.()) ?? 'final_quit';
        if (quitMode === 'cancel') {
          cleanupStarted = false;
          return;
        }
        resources.closeSystemNotifications?.();
        await resources.closeLocalServer?.(quitMode);
      } finally {
        if (cleanupStarted) resources.exitApp(0);
      }
    })();
  };
}
