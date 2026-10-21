import type { Server } from 'node:http';

/** 业务宿主停止后关闭本机 HTTP 服务；未完成的请求不能继续持有退出中的进程。 */
export function closeLocalHttpServer(server: Server | undefined | null): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    // 先停止监听，再收回活动连接，避免关闭连接期间又接受新连接。
    server.close((error) => {
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
      else resolve();
    });
    // 此处只用于不提供 WebSocket 升级的私有 HTTP 控制通道，不关闭用户的浏览器进程。
    server.closeAllConnections();
  });
}
