import { randomBytes, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import * as net from 'node:net';
import * as tls from 'node:tls';
import type { Duplex } from 'node:stream';
import { networkProxyEnvironment, networkProxyFailureHeader } from '@zeus/shared';
import { resolveSystemProxyRoutes, type SystemProxyRoute } from './systemProxyResolver.js';

/** 代理建连及 SOCKS 握手的最长等待时间，单位毫秒。 */
const connectionTimeoutMs = 10_000;
/** 转发器自己的请求必须直达选定出口，不能再次进入自身的代理环境。 */
const directEnvironment = networkProxyEnvironment({ mode: 'direct', url: '', bypass: '' });

/** 从已暂停的套接字读取握手报文，保留随后到达的应用数据。 */
function readBytes(socket: net.Socket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    /** 任一结束路径都移除握手监听，避免保留失效连接。 */
    function cleanup(): void {
      socket.off('readable', readable);
      socket.off('error', failed);
      socket.off('end', ended);
      socket.off('close', ended);
    }
    /** 完整读取当前报文，不消费下一个报文的字节。 */
    function readable(): void {
      /** read 的长度由固定协议字段决定，最大为一个 SOCKS 地址。 */
      const value = socket.read(length) as Buffer | null;
      if (!value) return;
      cleanup();
      if (value.length !== length) reject(new Error('系统 SOCKS 代理提前关闭了连接。'));
      else resolve(value);
    }
    /** 连接异常只属于当前握手，不影响其他模型请求。 */
    function failed(error: Error): void {
      cleanup();
      reject(error);
    }
    /** 未取得完整响应时不能把断开的套接字交给模型。 */
    function ended(): void {
      failed(new Error('系统 SOCKS 代理提前关闭了连接。'));
    }
    socket.on('readable', readable);
    socket.once('error', failed);
    socket.once('end', ended);
    socket.once('close', ended);
    if (socket.destroyed || socket.readableEnded) ended();
    else readable();
  });
}

/** 直接连接选定的目标或代理；到 HTTPS 代理自身的连接仍验证系统信任证书。 */
async function connectDirect(host: string, port: number, secure = false): Promise<net.Socket> {
  /** 原始 TCP/TLS 不读取 HTTP_PROXY，防止本地转发递归。 */
  const socket = secure ? tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }) }) : net.createConnection({ host, port });
  /** 超时也走 error 路径，所有等待者都能结束。 */
  const timer = setTimeout(() => socket.destroy(new Error('系统代理连接超时。')), connectionTimeoutMs);
  try {
    await once(socket, secure ? 'secureConnect' : 'connect');
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP 和 HTTPS 代理均通过 CONNECT 保持目标 TLS、流式响应和 WebSocket 原样传输。 */
function connectHttpProxy(proxy: Extract<SystemProxyRoute, { url: URL }>, target: URL): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    /** https 表示到代理服务器自身的 TLS；目标 TLS 仍由模型客户端校验。 */
    const transport = proxy.kind === 'https' ? https : http;
    /** 新 Agent 明确直连代理地址，不继承转发器自己的环境。 */
    const agent = new transport.Agent({ keepAlive: false, proxyEnv: directEnvironment });
    /** CONNECT 必须携带目标端口，即使 URL 已省略标准端口。 */
    const authority = `${target.hostname}:${target.port || (target.protocol === 'https:' ? '443' : '80')}`;
    /** 只向代理发送代理认证，凭据不会进入目标网站请求头。 */
    const headers: Record<string, string> = { host: authority };
    if (proxy.url.username || proxy.url.password) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.url.username)}:${decodeURIComponent(proxy.url.password)}`).toString('base64')}`;
    /** 凭据不放进请求选项的 URL，错误也不会包含完整代理地址。 */
    const request = transport.request({ hostname: proxy.url.hostname.replace(/^\[|\]$/gu, ''), port: proxy.url.port || (proxy.kind === 'https' ? 443 : 80), method: 'CONNECT', path: authority, headers, agent });
    /** 整个 CONNECT 过程共用一个截止时间。 */
    const timer = setTimeout(() => request.destroy(new Error('系统代理连接超时。')), connectionTimeoutMs);
    request.once('error', () => {
      clearTimeout(timer);
      agent.destroy();
      reject(new Error('无法连接系统 HTTP 代理。'));
    });
    request.once('connect', (response, socket, head) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        socket.destroy();
        agent.destroy();
        reject(new Error(response.statusCode === 407 ? '系统代理要求认证。' : '系统 HTTP 代理拒绝了连接。'));
        return;
      }
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

/** 将 Node 已校验的 IPv6 地址编码为 SOCKS5 的十六字节地址。 */
function ipv6Bytes(host: string): Buffer {
  /** IPv4 映射地址的最后四字节先转换成两个 IPv6 分组。 */
  const tail = host.substring(host.lastIndexOf(':') + 1);
  if (tail.includes('.')) {
    /** isIP 已保证四个八位组均合法。 */
    const octets = tail.split('.').map(Number);
    host = `${host.slice(0, -tail.length)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  /** 双冒号只能出现一次，由 isIP 在调用前保证。 */
  const halves = host.split('::');
  /** 两侧显式分组保留原始顺序，中间补零至八组。 */
  const left = halves[0] ? halves[0].split(':') : [];
  /** 没有压缩时右侧为空，不额外增加分组。 */
  const right = halves[1] ? halves[1].split(':') : [];
  /** 每个 IPv6 分组占两个字节。 */
  const output = Buffer.alloc(16);
  [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].forEach((part, index) => output.writeUInt16BE(parseInt(part, 16), index * 2));
  return output;
}

/** 使用系统 SOCKS 出口；域名交给代理解析，保留其 DNS 和绕过语义。 */
async function connectSocksProxy(proxy: Extract<SystemProxyRoute, { url: URL }>, target: URL): Promise<net.Socket> {
  /** SOCKS 握手不使用 HTTP Agent。 */
  const socket = await connectDirect(proxy.url.hostname.replace(/^\[|\]$/gu, ''), Number(proxy.url.port || 1080));
  /** 握手失败时销毁连接，同时唤醒正在等待响应的读取。 */
  const timer = setTimeout(() => socket.destroy(new Error('系统 SOCKS 代理握手超时。')), connectionTimeoutMs);
  try {
    /** URL 已校验 IPv6 方括号；协议报文使用裸地址。 */
    const host = target.hostname.replace(/^\[|\]$/gu, '');
    /** 目标端口与上层 CONNECT 或 HTTP 请求一致。 */
    const port = Buffer.alloc(2);
    port.writeUInt16BE(Number(target.port || (target.protocol === 'https:' ? 443 : 80)));
    /** 可选用户名和密码只用于代理认证。 */
    const username = Buffer.from(decodeURIComponent(proxy.url.username));
    /** SOCKS5 认证字段以单字节长度编码。 */
    const password = Buffer.from(decodeURIComponent(proxy.url.password));
    if (username.length > 255 || password.length > 255 || username.includes(0)) throw new Error('系统 SOCKS 代理凭据格式不受支持。');
    if (proxy.kind === 'socks4') {
      if (net.isIP(host) === 6) throw new Error('SOCKS4 不能连接 IPv6 字面地址。');
      /** SOCKS4a 用特殊 IPv4 标记携带需要远端解析的域名。 */
      const address = net.isIP(host) === 4 ? Buffer.from(host.split('.').map(Number)) : Buffer.from([0, 0, 0, 1]);
      socket.write(Buffer.concat([Buffer.from([4, 1]), port, address, username, Buffer.from([0]), ...(net.isIP(host) ? [] : [Buffer.from(host), Buffer.from([0])])]));
      if ((await readBytes(socket, 8))[1] !== 90) throw new Error('系统 SOCKS4 代理拒绝了连接。');
      return socket;
    }
    socket.write(Buffer.from(username.length || password.length ? [5, 2, 0, 2] : [5, 1, 0]));
    /** 服务端选择的认证方式必须属于本次声明的方式。 */
    const selection = await readBytes(socket, 2);
    if (selection[0] !== 5 || ![0, 2].includes(selection[1]!) || (selection[1] === 2 && !username.length && !password.length)) throw new Error('系统 SOCKS5 代理不接受当前认证方式。');
    if (selection[1] === 2) {
      socket.write(Buffer.concat([Buffer.from([1, username.length]), username, Buffer.from([password.length]), password]));
      /** 用户名密码认证成功才允许发送目标地址。 */
      const authentication = await readBytes(socket, 2);
      if (authentication[0] !== 1 || authentication[1] !== 0) throw new Error('系统 SOCKS5 代理认证失败。');
    }
    /** 字面地址按协议编码；域名保持原样交由代理解析。 */
    if (Buffer.byteLength(host) > 255) throw new Error('系统 SOCKS5 代理目标域名过长。');
    const address =
      net.isIP(host) === 6 ? Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]) : net.isIP(host) === 4 ? Buffer.from([1, ...host.split('.').map(Number)]) : Buffer.concat([Buffer.from([3, Buffer.byteLength(host)]), Buffer.from(host)]);
    socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, port]));
    /** 消费完整响应地址，避免把握手字节转发给 TLS 客户端。 */
    const response = await readBytes(socket, 4);
    if (response[0] !== 5 || response[1] !== 0) throw new Error('系统 SOCKS5 代理拒绝了连接。');
    if (response[3] === 1) await readBytes(socket, 6);
    else if (response[3] === 4) await readBytes(socket, 18);
    else if (response[3] === 3) await readBytes(socket, (await readBytes(socket, 1))[0]! + 2);
    else throw new Error('系统 SOCKS5 代理返回了无效地址。');
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP 请求需要区分目标连接与正向代理，TLS 隧道只使用套接字。 */
interface SystemConnection {
  /** 已经按系统规则连接的目标或上游代理。 */
  socket: net.Socket;
  /** 普通 HTTP 正向请求使用绝对网址，并只向此代理发送认证。 */
  forwardProxy?: URL;
}

/** 仅尝试当前配置明确返回的有序出口，不自行增加直连回退。 */
async function openSystemConnection(target: URL, tunnel: boolean, routes: SystemProxyRoute[]): Promise<SystemConnection> {
  for (const route of routes) {
    try {
      if (route.kind === 'direct') return { socket: await connectDirect(target.hostname.replace(/^\[|\]$/gu, ''), Number(target.port || (target.protocol === 'https:' ? 443 : 80))) };
      if (route.kind === 'http' || route.kind === 'https') {
        if (tunnel) return { socket: await connectHttpProxy(route, target) };
        // 普通 HTTP 使用正向代理，不能假定系统代理允许 CONNECT 到 80 端口。
        return { socket: await connectDirect(route.url.hostname.replace(/^\[|\]$/gu, ''), Number(route.url.port || (route.kind === 'https' ? 443 : 80)), route.kind === 'https'), forwardProxy: route.url };
      }
      return { socket: await connectSocksProxy(route, target) };
    } catch {
      // 下一个出口必须同样来自系统或 PAC；不把代理失败当成直连许可。
    }
  }
  throw new Error('系统代理的所有出口均无法建立连接。');
}

/** 校验代理请求的目标，拒绝凭据、片段和非法端口。 */
function requestTarget(value: string, tunnel: boolean): URL {
  /** CONNECT 仅有主机和端口；HTTPS 的默认端口为 443。 */
  const target = new URL(tunnel ? `https://${value}` : value);
  if (!target.hostname || target.username || target.password || target.hash || (tunnel ? target.pathname !== '/' || !!target.search : target.protocol !== 'http:')) throw new Error('代理目标无效。');
  return target;
}

/** 去掉内部代理认证，只有上游代理可以收到其自身的认证头。 */
function forwardHeaders(request: http.IncomingMessage, target: URL, proxy?: URL): http.OutgoingHttpHeaders {
  /** Host 始终对应真实目标，不携带回环代理身份。 */
  const headers: http.OutgoingHttpHeaders = { ...request.headers, host: target.host };
  delete headers['proxy-authorization'];
  delete headers['proxy-connection'];
  if (proxy?.username || proxy?.password) headers['proxy-authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`;
  return headers;
}

/** 为所有网络客户端提供固定入口，每次建连读取当前出口配置。 */
export async function startSystemProxyBridge(resolveRoutes: (target: URL) => Promise<SystemProxyRoute[]> = resolveSystemProxyRoutes): Promise<{ url: string; resetConnections: () => void; close: () => Promise<void> }> {
  /** 代理认证密码只属于当前宿主，不写入配置或日志。 */
  const password = randomBytes(32).toString('hex');
  /** 每个宿主独立持有随机认证值，网页不能把回环端口当成开放代理。 */
  const credential = `Basic ${Buffer.from(`zeus:${password}`).toString('base64')}`;
  /** 正向连接和 CONNECT 都需要在退出时收口。 */
  const sockets = new Set<net.Socket>();
  /** CONNECT 和 WebSocket 共用透明转发，任一端关闭都会回收另一端。 */
  function pipeSockets(client: Duplex, upstream: net.Socket, head: Buffer): void {
    sockets.add(upstream);
    upstream.once('close', () => sockets.delete(upstream));
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
  }
  /** 认证在解析目标之前完成；比较不泄露匹配到哪一段凭据。 */
  const authorized = (request: http.IncomingMessage): boolean => {
    /** 不接受重复认证头，避免不同 HTTP 实现选择不同值。 */
    const values = request.headersDistinct['proxy-authorization'];
    return values?.length === 1 && Buffer.byteLength(values[0]!) === Buffer.byteLength(credential) && timingSafeEqual(Buffer.from(values[0]!), Buffer.from(credential));
  };
  /** 只向客户端返回固定分类，不带代理地址、认证值或目标请求内容。 */
  const server = http.createServer((request, response) => {
    if (!authorized(request)) {
      response.writeHead(407, { 'proxy-authenticate': 'Basic realm="Zeus system proxy"' });
      response.end();
      return;
    }
    void (async () => {
      /** 绝对形式的 HTTP 请求经当前配置选定的连接转发。 */
      const target = requestTarget(request.url || '', false);
      /** 当前请求有且仅有一个出口连接，不进入 Agent 的代理环境。 */
      const { socket, forwardProxy } = await openSystemConnection(target, false, await resolveRoutes(target));
      if (request.aborted || response.destroyed) {
        socket.destroy();
        return;
      }
      /** 普通请求与 WebSocket 升级共用同一认证隔离。 */
      const headers = forwardHeaders(request, target, forwardProxy);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      /** 独立 Agent 只使用已经建立的系统出口。 */
      const agent = new http.Agent({ keepAlive: false, proxyEnv: directEnvironment });
      agent.createConnection = () => socket;
      /** 正向代理需要 absolute-form，目标或 SOCKS 连接使用 origin-form。 */
      const outgoing = http.request({ hostname: target.hostname, port: target.port || 80, path: forwardProxy ? target.href : target.pathname + target.search, method: request.method, headers, agent }, (upstream) => {
        response.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.on('error', () => response.destroy());
        upstream.pipe(response);
      });
      outgoing.on('error', () => {
        if (!response.headersSent) response.writeHead(502, { [networkProxyFailureHeader]: 'connection' });
        response.end('System proxy connection failed');
      });
      response.once('close', () => {
        outgoing.destroy();
        agent.destroy();
      });
      request.once('aborted', () => outgoing.destroy());
      request.pipe(outgoing);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502, { [networkProxyFailureHeader]: 'connection' });
      response.end('System proxy connection failed');
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  });
  /** 明文 WebSocket 使用 HTTP Upgrade，不能当作普通响应或 TLS 隧道处理。 */
  server.on('upgrade', (request, client, head) => {
    if (!authorized(request)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Zeus system proxy"\r\nConnection: close\r\n\r\n');
      return;
    }
    void (async () => {
      /** WebSocket 的绝对地址按 HTTP 转发，保留路径、请求头及握手后数据。 */
      const target = requestTarget((request.url || '').replace(/^ws:/iu, 'http:'), false);
      /** 普通 HTTP 代理仍使用正向请求，不要求它支持 CONNECT 到 80 端口。 */
      const { socket: upstream, forwardProxy } = await openSystemConnection(target, false, await resolveRoutes(target));
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      /** 所有头均来自 Node 已解析的 HTTP 报文，内部代理凭据已移除。 */
      const headers = Object.entries(forwardHeaders(request, target, forwardProxy)).flatMap(([name, value]) => (value === undefined ? [] : (Array.isArray(value) ? value : [value]).map((item) => `${name}: ${item}`)));
      upstream.write([`${request.method} ${forwardProxy ? target.href : target.pathname + target.search} HTTP/${request.httpVersion}`, ...headers, '', ''].join('\r\n'));
      pipeSockets(client, upstream, head);
    })().catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  });
  server.on('connect', (request, client, head) => {
    if (!authorized(request)) {
      client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Zeus system proxy"\r\nConnection: close\r\n\r\n');
      return;
    }
    void (async () => {
      /** TLS 保留在模型与远端之间；Core 不解密模型请求。 */
      const target = requestTarget(request.url || '', true);
      /** 以当前配置决定直达目标或经过上游代理。 */
      const { socket: upstream } = await openSystemConnection(target, true, await resolveRoutes(target));
      if (client.destroyed) {
        upstream.destroy();
        return;
      }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      pipeSockets(client, upstream, head);
    })().catch(() => client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'));
  });
  /** 仅在 IPv4 回环监听，端口由系统分配，不改变 macOS 或 Windows 的代理设置。 */
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  server.unref();
  /** listen 成功后必定得到 TCP 地址。 */
  const address = server.address() as net.AddressInfo;
  /** 随机凭据只通过模型进程环境传递，不保存到用户设置。 */
  const url = new URL(`http://127.0.0.1:${address.port}`);
  url.username = 'zeus';
  url.password = password;
  return {
    url: url.href,
    /** 立即断开旧出口，保留监听地址和认证值供现有客户端重新建连。 */
    resetConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
