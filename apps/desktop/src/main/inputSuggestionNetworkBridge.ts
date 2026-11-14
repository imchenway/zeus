import { net } from 'electron';

/** Main 独立报告系统联网状态，切页或关闭会话窗口不影响 Core 的离线等待。 */
export function startInputSuggestionNetworkBridge(readConnection: () => { baseUrl: string; apiToken: string } | undefined): () => void {
  /** 同一时刻只保留一个本机状态报告。 */
  let pending: AbortController | null = null;
  /** 退出后不再向旧宿主报告状态。 */
  let closed = false;
  /** 网络状态来自系统；连接存在不代表模型服务一定可达。 */
  const report = async (): Promise<void> => {
    if (closed || pending) return;
    const connection = readConnection();
    if (!connection) return;
    const controller = new AbortController();
    pending = controller;
    try {
      await fetch(`${connection.baseUrl}/api/input-suggestions/network`, {
        method: 'POST',
        headers: { authorization: `Bearer ${connection.apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ online: net.isOnline() }),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3_000)]),
      });
    } catch {
      // 宿主短暂重启不弹出用户错误，下次报告使用最新端点；Core 不永久信任过期离线状态。
    } finally {
      if (pending === controller) pending = null;
    }
  };
  /** 五秒刷新保证 Core 重启后也能重新获得状态。 */
  const timer = setInterval(() => {
    void report();
  }, 5_000);
  timer.unref();
  void report();
  return () => {
    closed = true;
    clearInterval(timer);
    pending?.abort();
  };
}
