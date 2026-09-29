import { session } from 'electron';
import * as http from 'node:http';
import * as https from 'node:https';
import { randomUUID } from 'node:crypto';
import { networkProxyRuntimeEnvironment } from '@zeus/local-server';
import { networkProxyLoopbackBypass, normalizeNetworkProxySettings, type NetworkProxySettings, type NetworkProxyConnectionResult } from '@zeus/shared';

/** 单条网络请求的最长等待时间。 */
const networkRequestTimeoutMs = 10_000;

/** Electron 原生代理切换和连接清理的最长等待时间。 */
const electronNetworkOperationTimeoutMs = 10_000;

/** 清理只做资源回收，不应延长用户可见检查。 */
const electronNetworkCleanupTimeoutMs = 1_000;

/** 为 Electron 不支持 AbortSignal 的 Promise 补上硬截止时间，防止设置页永久等待。 */
async function withOperationTimeout<T>(operation: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  /** 超时句柄只活到当前操作结束。 */
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** 清理失败或迟到不能再次卡住已经完成的用户检查。 */
async function closeConnectionsWithinDeadline(targetSession: Electron.Session): Promise<void> {
  await withOperationTimeout(targetSession.closeAllConnections(), electronNetworkCleanupTimeoutMs, '连接清理超时。').catch(() => undefined);
}

/** 将请求耗时限制为非负整数，避免系统时钟调整污染显示。 */
function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** 正式生效与检查共用 Chromium 配置，域名后缀保持与 NO_PROXY 一致。 */
export function chromiumNetworkProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  if (settings.mode === 'default') return { mode: 'system' };
  if (settings.mode === 'direct') return { mode: 'direct' };
  return {
    mode: 'fixed_servers',
    proxyRules: settings.url,
    proxyBypassRules: [networkProxyLoopbackBypass, settings.bypass]
      .filter(Boolean)
      .join(',')
      .split(',')
      .map((host) => (host === '::1' ? '[::1]' : host.startsWith('.') ? `*${host}` : host))
      .join(';'),
  };
}

/** 原始异常可能包含地址或凭据，仅返回固定错误分类。 */
function connectionError(error: unknown, startedAt: number): NetworkProxyConnectionResult {
  /** 只在内部识别平台错误，不把原文传回界面。 */
  const message = error instanceof Error ? error.message : '';
  return { latencyMs: elapsedMilliseconds(startedAt), error: /timeout|timed.out|aborted/iu.test(message) ? 'timeout' : /407|proxy.*auth/iu.test(message) ? 'authentication' : 'connection' };
}

/** 使用专用 Agent，不修改全局代理，不复用模型请求的连接。 */
async function checkNodeConnection(settings: NetworkProxySettings, target: URL): Promise<NetworkProxyConnectionResult> {
  /** 延迟从请求准备开始计算，包含代理连接和 TLS 握手。 */
  const startedAt = performance.now();
  /** HTTP 与 HTTPS 分别使用原生代理实现。 */
  const transport = target.protocol === 'https:' ? https : http;
  /** 默认启动环境也可能无效，构造失败必须经过同一错误脱敏。 */
  let agent: http.Agent | undefined;
  try {
    agent = new transport.Agent({ proxyEnv: networkProxyRuntimeEnvironment(settings), keepAlive: false });
    return await new Promise<NetworkProxyConnectionResult>((resolve) => {
      /** 仅请求响应头，不下载目标正文，不跟随跳转。 */
      const request = transport.request(target, { method: 'HEAD', agent, signal: AbortSignal.timeout(networkRequestTimeoutMs) }, (response) => {
        /** 任何 HTTP 响应都证明网络已到达目标，407 单独标记代理认证问题。 */
        const latencyMs = elapsedMilliseconds(startedAt);
        resolve(response.statusCode === 407 ? { error: 'authentication', statusCode: 407, latencyMs } : { statusCode: response.statusCode, latencyMs });
        response.destroy();
      });
      request.once('error', (error) => resolve(connectionError(error, startedAt)));
      request.end();
    });
  } catch (error) {
    return connectionError(error, startedAt);
  } finally {
    agent?.destroy();
  }
}

/** 单条链路用当前草稿检查，不保存配置、不影响任何运行中会话。 */
export async function checkNetworkProxyConnection(value: unknown, address: unknown, checkTarget: unknown): Promise<NetworkProxyConnectionResult> {
  /** 主进程重新校验，不信任渲染层传入的草稿。 */
  const settings = normalizeNetworkProxySettings(value);
  if (typeof address !== 'string' || address.length > 2048 || /[\s\\]/u.test(address.trim())) throw new Error('请填写有效的 HTTP 或 HTTPS 检查网址。');
  if (checkTarget !== 'browser' && checkTarget !== 'node') throw new Error('请选择有效的网络检查链路。');
  /** 不接受本地文件、用户名、密码或片段，防止检查意外带入登录信息。 */
  const target = URL.parse(address.trim());
  if (!target || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('检查网址只支持 HTTP/HTTPS，不能包含账号密码或片段。');
  if (checkTarget === 'node') return checkNodeConnection(settings, target);
  /** 每次检查使用独立非持久会话；迟到的原生操作不会污染下一次检查。 */
  const isolatedSession = session.fromPartition(`zeus-network-proxy-check-${randomUUID()}`, { cache: false });
  /** 浏览器链路耗时覆盖代理切换、DNS、TLS 和响应头等待。 */
  const browserStartedAt = performance.now();
  try {
    await withOperationTimeout(isolatedSession.setProxy(chromiumNetworkProxyConfig(settings)), electronNetworkOperationTimeoutMs, '代理切换超时。');
    /** Chromium 请求只取响应头，拒绝携带浏览器凭据并禁止自动跳转。 */
    return await isolatedSession
      .fetch(target.href, { method: 'HEAD', credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(networkRequestTimeoutMs) })
      .then(async (response): Promise<NetworkProxyConnectionResult> => {
        await response.body?.cancel();
        /** 407 只代表代理认证失败，其他响应码都保留为可达证据。 */
        const latencyMs = elapsedMilliseconds(browserStartedAt);
        return response.status === 407 ? { error: 'authentication', statusCode: 407, latencyMs } : { statusCode: response.status, latencyMs };
      })
      .catch((error) => connectionError(error, browserStartedAt));
  } catch (error) {
    return connectionError(error, browserStartedAt);
  } finally {
    await closeConnectionsWithinDeadline(isolatedSession);
  }
}
