import { reportApplicationError } from './ui/ApplicationErrorDialog.js';

/**
 * 存储首错只负责说明已经发生的失败，并把恢复动作绑定到显式用户确认。
 * 预检和 Core generation 重启仍由受信任的 Main/Core 边界执行。
 */
export function reportStorageReadOnlyFault(language: 'zh-CN' | 'en', readsAvailable: boolean, onRestartError: (error: unknown) => void): void {
  const restart = window.zeus?.runStorageRecoveryPreflightAndRestart;
  const error = Object.assign(new Error(language === 'zh-CN' ? (readsAvailable ? '存储已进入只读保护。' : '存储读写已停止。') : readsAvailable ? 'Storage entered read-only protection.' : 'Storage reads and writes stopped.'), {
    code: 'ZEUS_STORAGE_READ_ONLY_FAULT',
  });
  reportApplicationError(error, {
    language,
    ...(restart
      ? {
          primaryAction: {
            label: language === 'zh-CN' ? '预检并重启 Core' : 'Check and restart Core',
            run: () => {
              void restart().catch(onRestartError);
            },
          },
        }
      : {}),
  });
}
