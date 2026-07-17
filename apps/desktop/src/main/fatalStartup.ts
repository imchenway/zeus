export type FatalStartupTerminationOptions = {
  error: unknown;
  reportError: (message: string, error: unknown) => void;
  showGenericError: () => void;
  quitApplication: () => void;
  forceExit: (code: number) => void;
};

/**
 * 统一终止不可恢复的启动失败。
 * 任何日志、系统提示或 Electron 退出 API 自身的异常都不得再泄漏成未处理 rejection。
 */
export function terminateAfterFatalStartup(options: FatalStartupTerminationOptions): void {
  const reportSafely = (message: string, error: unknown): void => {
    try {
      options.reportError(message, error);
    } catch {
      // fatal 路径不能依赖日志设施本身健康。
    }
  };

  reportSafely('Zeus startup failed', options.error);
  try {
    options.showGenericError();
  } catch (dialogError) {
    reportSafely('Zeus startup error dialog failed', dialogError);
  }

  try {
    options.quitApplication();
  } catch (quitError) {
    reportSafely('Zeus startup quit failed', quitError);
    try {
      options.forceExit(1);
    } catch (exitError) {
      reportSafely('Zeus startup force exit failed', exitError);
    }
  }
}
