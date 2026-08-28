/**
 * 存储恢复预检一旦通过，重启意图必须先于可能失败的 Main receipt 持久化存在于内存。
 * `finally` 可重复调用 ensureScheduled；真正的调度器只会安装一次。
 */
export class StorageRecoveryRestartCoordinator {
  private requested = false;
  private scheduled = false;

  isRequested(): boolean {
    return this.requested;
  }

  request(): void {
    this.requested = true;
  }

  ensureScheduled(schedule: () => void): boolean {
    if (!this.requested || this.scheduled) return false;
    this.scheduled = true;
    try {
      schedule();
      return true;
    } catch (error) {
      this.scheduled = false;
      throw error;
    }
  }
}
