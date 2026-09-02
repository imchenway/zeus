import type { FastifyInstance } from 'fastify';
import type { ReleaseUpdateStatus } from './releaseCore.js';
import type { ExecutionHostWorkStatusSnapshot } from './executionHostControlApi.js';

/** Release 查询只组合当前宿主工作投影；自动替换仍保持显式 fail-closed。 */
export function registerReleaseUpdateApi(options: { server: FastifyInstance; buildUpdateStatus(): Promise<ReleaseUpdateStatus>; readExecutionHostStatus(): ExecutionHostWorkStatusSnapshot }): void {
  const snapshot = async () => ({ ...(await options.buildUpdateStatus()), executionHost: options.readExecutionHostStatus() });
  options.server.get('/api/release/update-status', snapshot);
  options.server.post('/api/release/check-update', snapshot);
  options.server.post('/api/release/download-update', async () => {
    const update = await snapshot();
    return {
      accepted: false,
      update,
      reason: update.automaticInstallEnabled ? '下载能力已预留，当前版本仍要求用户通过 GitHub Release 或安装脚本完成安装。' : '当前 Release 产物未同时签名和公证，不允许静默下载或自动安装。',
    };
  });
  options.server.post('/api/release/install-update', async () => {
    const update = await snapshot();
    return {
      accepted: false,
      update,
      reason: update.automaticInstallEnabled ? '安装能力已预留，正式启用前仍需用户确认安装包来源。' : '当前 Release 产物未同时签名和公证，不允许自动替换本机 App。',
    };
  });
}
