export type DesktopLocalServerCloseMode = 'continue_in_background' | 'upgrade_handoff' | 'final_quit' | 'force_quit';

export interface BeforeQuitCleanupEvent {
  preventDefault: () => void;
}

export type BeforeQuitCleanupFailureAction = 'retry' | 'keep_open' | 'force_quit';

export interface BeforeQuitCleanupResources {
  closeSystemNotifications?: () => void;
  resolveQuitMode?: () => Promise<DesktopLocalServerCloseMode | 'cancel'>;
  closeLocalServer?: (mode: DesktopLocalServerCloseMode) => Promise<void>;
  shouldDeferQuit?: () => boolean;
  requestQuitConfirmation?: () => void;
  onCleanupError?: (error: unknown, quitMode: DesktopLocalServerCloseMode | null) => BeforeQuitCleanupFailureAction | Promise<BeforeQuitCleanupFailureAction>;
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
      while (cleanupStarted) {
        let quitMode: DesktopLocalServerCloseMode | null = null;
        try {
          const resolvedQuitMode = (await resources.resolveQuitMode?.()) ?? 'final_quit';
          if (resolvedQuitMode === 'cancel') {
            cleanupStarted = false;
            return;
          }
          quitMode = resolvedQuitMode;
          const cleanupErrors: unknown[] = [];
          try {
            resources.closeSystemNotifications?.();
          } catch (error) {
            cleanupErrors.push(error);
          }
          try {
            await resources.closeLocalServer?.(quitMode);
          } catch (error) {
            cleanupErrors.push(error);
          }
          if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'Zeus 退出资源清理未完整成功。');
          resources.exitApp(0);
          return;
        } catch (error) {
          let action: BeforeQuitCleanupFailureAction = 'keep_open';
          try {
            action = (await resources.onCleanupError?.(error, quitMode)) ?? 'keep_open';
          } catch {
            // 错误 UI 本身失败时也不能伪造正常退出；保留进程供用户重试。
            action = 'keep_open';
          }
          if (action === 'retry') continue;
          if (action === 'force_quit') {
            resources.exitApp(1);
            return;
          }
          cleanupStarted = false;
          return;
        }
      }
    })();
  };
}
