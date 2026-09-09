import { session } from 'electron';
import * as http from 'node:http';
import * as https from 'node:https';
import { networkProxyRuntimeEnvironment } from '@zeus/local-server';
import { networkProxyLoopbackBypass, normalizeNetworkProxySettings, type NetworkProxySettings, type NetworkProxyCheckResult, type NetworkProxyConnectionResult } from '@zeus/shared';

/** 检查复用一个内存会话，串行执行以免两个窗口互相覆盖检查配置。 */
let checkingConnection = false;

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
function connectionError(error: unknown): NetworkProxyConnectionResult {
  /** 只在内部识别平台错误，不把原文传回界面。 */
  const message = error instanceof Error ? error.message : '';
  return { error: /timeout|timed.out|aborted/iu.test(message) ? 'timeout' : /407|proxy.*auth/iu.test(message) ? 'authentication' : 'connection' };
}

/** 使用专用 Agent，不修改全局代理，不复用模型请求的连接。 */
async function checkNodeConnection(settings: NetworkProxySettings, target: URL): Promise<NetworkProxyConnectionResult> {
  /** HTTP 与 HTTPS 分别使用原生代理实现。 */
  const transport = target.protocol === 'https:' ? https : http;
  /** 默认启动环境也可能无效，构造失败必须经过同一错误脱敏。 */
  let agent: http.Agent | undefined;
  try {
    agent = new transport.Agent({ proxyEnv: networkProxyRuntimeEnvironment(settings), keepAlive: false });
    return await new Promise<NetworkProxyConnectionResult>((resolve) => {
      /** 仅请求响应头，不下载目标正文，不跟随跳转。 */
      const request = transport.request(target, { method: 'HEAD', agent, signal: AbortSignal.timeout(10_000) }, (response) => {
        resolve(response.statusCode === 407 ? { error: 'authentication', statusCode: 407 } : { statusCode: response.statusCode });
        response.destroy();
      });
      request.once('error', (error) => resolve(connectionError(error)));
      request.end();
    });
  } catch (error) {
    return connectionError(error);
  } finally {
    agent?.destroy();
  }
}

/** 两条链路用当前草稿检查，不保存配置、不影响任何运行中会话。 */
export async function checkNetworkProxyConnection(value: unknown, address: unknown): Promise<NetworkProxyCheckResult> {
  /** 主进程重新校验，不信任渲染层传入的草稿。 */
  const settings = normalizeNetworkProxySettings(value);
  if (typeof address !== 'string' || address.length > 2048 || /[\s\\]/u.test(address.trim())) throw new Error('请填写有效的 HTTP 或 HTTPS 检查网址。');
  /** 不接受本地文件、用户名、密码或片段，防止检查意外带入登录信息。 */
  const target = URL.parse(address.trim());
  if (!target || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('检查网址只支持 HTTP/HTTPS，不能包含账号密码或片段。');
  if (checkingConnection) throw new Error('已有连接检查正在进行，请稍后再试。');
  checkingConnection = true;
  /** 固定的非持久会话不会继承用户登录信息，也不会积累无界分区。 */
  const isolatedSession = session.fromPartition('zeus-network-proxy-check', { cache: false });
  try {
    await isolatedSession.setProxy(chromiumNetworkProxyConfig(settings));
    /** Chromium 请求只取响应头，拒绝携带浏览器凭据并禁止自动跳转。 */
    const browserCheck = isolatedSession
      .fetch(target.href, { method: 'HEAD', credentials: 'omit', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10_000) })
      .then(async (response): Promise<NetworkProxyConnectionResult> => {
        await response.body?.cancel();
        return response.status === 407 ? { error: 'authentication', statusCode: 407 } : { statusCode: response.status };
      })
      .catch(connectionError);
    /** 并行检查避免等待时间翻倍；结果各自说明网络范围。 */
    const [browser, node] = await Promise.all([browserCheck, checkNodeConnection(settings, target)]);
    return { browser, node };
  } finally {
    try {
      await isolatedSession.closeAllConnections();
    } finally {
      checkingConnection = false;
    }
  }
}
