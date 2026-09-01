import type { FastifyInstance } from 'fastify';
import type { ReleaseUpdateStatus } from './releaseCore.js';
import type { ExecutionHostWorkStatusSnapshot } from './executionHostControlApi.js';

/**
 * 这三个 POST 是兼容旧 Renderer 的查询形状，不是下载/安装命令：
 * - check 只读取远端 manifest 与当前宿主投影；
 * - download/install 在真正能力接入前固定返回 accepted=false，绝不落盘或退出进程。
 * 因而它们按实现证据归为 read-only external query，而不是伪造 Command 回执。
 */
export const releaseUpdatePostRouteDeclarations = [
  { method: 'POST', path: '/api/release/check-update', classification: 'read_only', writesBusinessState: false, invokesDownload: false, invokesInstall: false, commandLedger: 'not_applicable' },
  { method: 'POST', path: '/api/release/download-update', classification: 'read_only', writesBusinessState: false, invokesDownload: false, invokesInstall: false, commandLedger: 'not_applicable' },
  { method: 'POST', path: '/api/release/install-update', classification: 'read_only', writesBusinessState: false, invokesDownload: false, invokesInstall: false, commandLedger: 'not_applicable' },
] as const;

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
