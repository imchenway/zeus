import { app, net, session } from 'electron';
import * as http from 'node:http';
import * as https from 'node:https';
import { applyNetworkProxyEnvironment } from '@zeus/local-server';
import { networkProxyEnvironment, networkProxyFailureHeader, type NetworkProxyConnectionResult } from '@zeus/shared';

/** 单条网络请求及原生代理设置的最长等待时间，单位毫秒。 */
const networkRequestTimeoutMs = 10_000;
/** Main 只持有 Core 的随机回环凭据，不保存用户代理认证。 */
let runtimeProxyAddress: URL | undefined;

/** Electron 的原生操作没有 AbortSignal，以截止时间结束宿主初始化等待。 */
async function withOperationTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
  /** 原生操作提前完成时清理定时器，不延长宿主生命周期。 */
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), networkRequestTimeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/** 仅向当前 Core 的回环代理提供认证，网站认证不能取得该凭据。 */
app.on('login', (event, _webContents, details, authInfo, callback) => {
  /** 页面请求和主进程检查复用同一个内部代理身份边界。 */
  const credentials = runtimeProxyCredentials(authInfo);
  if (!credentials) return;
  event.preventDefault();
  if (!details.firstAuthAttempt) callback();
  else callback(...credentials);
});

/** 随机凭据只回应当前 Core 的代理挑战，不能用于网站认证或其他代理。 */
function runtimeProxyCredentials(authInfo: Electron.AuthInfo): [string, string] | null {
  if (!runtimeProxyAddress || !authInfo.isProxy || authInfo.host !== runtimeProxyAddress.hostname || authInfo.port !== Number(runtimeProxyAddress.port)) return null;
  return [decodeURIComponent(runtimeProxyAddress.username), decodeURIComponent(runtimeProxyAddress.password)];
}

/** 主进程请求需要单独应答本机代理的认证。 */
export function createDesktopProxyRequest(options: Electron.ClientRequestConstructorOptions): Electron.ClientRequest {
  /** 使用调用方选择的 Chromium 会话。 */
  const request = net.request(options);
  /** 每条请求只应答一次认证挑战，避免重复提交被拒绝的凭据。 */
  let authenticated = false;
  request.on('login', (authInfo, callback) => {
    /** 仅向当前 Core 的本机代理提供凭据。 */
    const credentials = runtimeProxyCredentials(authInfo);
    if (authenticated || !credentials) return callback();
    authenticated = true;
    callback(...credentials);
  });
  return request;
}

/** 校验可交给 Main、Chromium 和 Codex 的 Core 代理地址。 */
export function parseDesktopNetworkProxyAddress(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('网络运行地址无效。');
  /** 内部端点只能是带随机认证的本机 HTTP 代理，不能由配置替换成外部地址。 */
  const address = URL.parse(value);
  if (!address || address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || !address.username || !address.password || address.pathname !== '/' || address.search || address.hash)
    throw new Error('网络运行地址无效。');
  return address;
}

/** Main 与浏览器共用已校验的 Core 网络出口。 */
export async function applyDesktopNetworkProxy(address: URL, browserSession: Electron.Session): Promise<void> {
  runtimeProxyAddress = address;
  applyNetworkProxyEnvironment(networkProxyEnvironment({ mode: 'manual', url: address.href, bypass: '' }));
  /** 用户绕过列表由 Core 处理，客户端只固定绕过本机 API。 */
  const proxy: Electron.ProxyConfig = { mode: 'fixed_servers', proxyRules: address.origin, proxyBypassRules: 'localhost;127.0.0.1;[::1]' };
  /** 默认会话与内置浏览器可能复用同一个 Session。 */
  const sessions = [...new Set([session.defaultSession, browserSession])];
  await withOperationTimeout(Promise.all([app.setProxy(proxy), ...sessions.map((target) => target.setProxy(proxy))]), '网络代理初始化超时。');
  /** Core 重建后丢弃指向旧回环端口的连接，不保留旧代理池。 */
  await withOperationTimeout(Promise.all(sessions.map((target) => target.closeAllConnections())), '旧网络连接清理超时。');
}

/** 将请求耗时限制为非负整数，避免系统时钟调整污染显示。 */
function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

/** 底层异常可能包含地址或凭据，仅返回固定错误分类。 */
function connectionError(error: unknown, startedAt: number): NetworkProxyConnectionResult {
  /** 只在内部识别平台错误，不把原文传回界面。 */
  const message = error instanceof Error ? error.message : '';
  return { latencyMs: elapsedMilliseconds(startedAt), error: /timeout|timed.out|aborted/iu.test(message) ? 'timeout' : /407|proxy.*auth/iu.test(message) ? 'authentication' : 'connection' };
}

/** 检查复用正式全局 Agent，避免检查成功而模型请求仍走另一份代理。 */
async function checkNodeConnection(target: URL): Promise<NetworkProxyConnectionResult> {
  /** 延迟包含代理连接和 TLS 握手。 */
  const startedAt = performance.now();
  /** HTTP 与 HTTPS 分别使用已经配置的原生网络实现。 */
  const transport = target.protocol === 'https:' ? https : http;
  try {
    return await new Promise<NetworkProxyConnectionResult>((resolve) => {
      /** 仅请求响应头，不下载目标正文，不跟随跳转。 */
      const request = transport.request(target, { method: 'HEAD', signal: AbortSignal.timeout(networkRequestTimeoutMs) }, (response) => {
        /** 转发器的建连失败不能算目标可达，407 单独标记代理认证问题。 */
        const latencyMs = elapsedMilliseconds(startedAt);
        resolve(
          response.headers[networkProxyFailureHeader] === 'connection'
            ? { error: 'connection', latencyMs }
            : response.statusCode === 407
              ? { error: 'authentication', statusCode: 407, latencyMs }
              : { statusCode: response.statusCode, latencyMs },
        );
        response.destroy();
      });
      request.once('error', (error) => resolve(connectionError(error, startedAt)));
      request.end();
    });
  } catch (error) {
    return connectionError(error, startedAt);
  }
}

/** 两条检查链路都使用正式运行出口，不接受独立草稿代理。 */
export async function checkNetworkProxyConnection(address: unknown, checkTarget: unknown, browserSession: Electron.Session): Promise<NetworkProxyConnectionResult> {
  if (typeof address !== 'string' || address.length > 2048 || /[\s\\]/u.test(address.trim())) throw new Error('请填写有效的 HTTP 或 HTTPS 检查网址。');
  if (checkTarget !== 'browser' && checkTarget !== 'node') throw new Error('请选择有效的网络检查链路。');
  /** 不接受本地文件、用户名、密码或片段，防止检查意外带入登录信息。 */
  const target = URL.parse(address.trim());
  if (!target || !['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash) throw new Error('检查网址只支持 HTTP/HTTPS，不能包含账号密码或片段。');
  if (checkTarget === 'node') return checkNodeConnection(target);
  /** 主进程 Chromium 请求需处理自己的 login 事件，app.login 只覆盖页面请求。 */
  const startedAt = performance.now();
  try {
    return await new Promise<NetworkProxyConnectionResult>((resolve) => {
      /** 沿用正式浏览器会话和代理，禁止携带网站 Cookie 或认证，也不跟随跳转。 */
      const request = createDesktopProxyRequest({ url: target.href, method: 'HEAD', session: browserSession, credentials: 'omit', redirect: 'manual', cache: 'no-store' });
      /** 请求完成、失败和超时只允许产生一次回执。 */
      let finished = false;
      /** Chromium ClientRequest 不接收 AbortSignal，超时后主动终止。 */
      const timer = setTimeout(() => finish({ error: 'timeout', latencyMs: elapsedMilliseconds(startedAt) }), networkRequestTimeoutMs);
      /** 取得响应头即可结束，避免下载正文或残留检查连接。 */
      function finish(result: NetworkProxyConnectionResult): void {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve(result);
        request.abort();
      }
      request.on('response', (response) => {
        response.on('error', (error) => finish(connectionError(error, startedAt)));
        /** Core 的建连错误与目标网站自己的拒绝响应分别报告。 */
        const latencyMs = elapsedMilliseconds(startedAt);
        finish(
          response.headers[networkProxyFailureHeader]?.includes('connection')
            ? { error: 'connection', latencyMs }
            : response.statusCode === 407
              ? { error: 'authentication', statusCode: 407, latencyMs }
              : { statusCode: response.statusCode, latencyMs },
        );
      });
      request.on('redirect', (statusCode) => finish({ statusCode, latencyMs: elapsedMilliseconds(startedAt) }));
      request.on('error', (error) => finish(connectionError(error, startedAt)));
      request.end();
    });
  } catch (error) {
    return connectionError(error, startedAt);
  }
}
