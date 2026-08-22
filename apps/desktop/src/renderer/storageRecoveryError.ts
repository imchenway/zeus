import { reportApplicationError } from './ui/ApplicationErrorDialog.js';

/**
 * 存储首错只负责说明已经发生的失败，并把恢复动作绑定到显式用户确认。
 * 预检和 Core generation 重启仍由受信任的 Main/Core 边界执行。
 */
export function reportStorageReadOnlyFault(language: 'zh-CN' | 'en', readsAvailable: boolean, onRestartError: (error: unknown) => void): void {
  const restart = window.zeus?.runStorageRecoveryPreflightAndRestart;
  reportApplicationError(new Error('ZEUS_STORAGE_READ_ONLY_FAULT'), {
    language,
    title:
      language === 'zh-CN'
        ? readsAvailable
          ? '存储已进入只读保护'
          : '存储读写已安全停止'
        : readsAvailable
          ? 'Storage is now read-only'
          : 'Storage reads and writes stopped',
    summary:
      language === 'zh-CN'
        ? readsAvailable
          ? '现有已提交数据仍可读取，新的消息、任务和其他副作用已停止。修复磁盘空间或目录权限后，可执行恢复预检并重启 Core。'
          : '当前事务无法安全回滚，为避免显示未提交数据，读取和副作用都已停止。修复存储后，请执行恢复预检并重启 Core。'
        : readsAvailable
          ? 'Existing committed data remains readable, but new messages, tasks, and other side effects have stopped. Fix disk space or permissions, then run recovery checks and restart Core.'
          : 'The current transaction could not be safely rolled back, so reads and side effects stopped to avoid exposing uncommitted data. Fix storage, then run recovery checks and restart Core.',
    source: 'storage.write_fault',
    details:
      language === 'zh-CN'
        ? 'Zeus 不会自动重发状态不明的 Provider 请求。只有事务回滚、数据库 quick_check、WAL checkpoint、外键、Command Ledger 与 Artifact staging/空间检查全部通过，才会安排新的 Core generation。'
        : 'Zeus will not automatically resend Provider requests with an unknown outcome. A new Core generation is scheduled only after rollback, database, WAL, foreign-key, Command Ledger, and Artifact staging/capacity checks all pass.',
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
