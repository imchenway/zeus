import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

/** 系统针对当前目标选择的直连或代理出口；地址中的认证信息只留在进程内。 */
export type SystemProxyRoute = { kind: 'direct' } | { kind: 'http' | 'https' | 'socks4' | 'socks5'; url: URL };

/** 读取操作系统配置，不经过当前进程已经启用的代理。 */
const execFileAsync = promisify(execFile);
/** 合并同一目标的并发查询，已完成结果最多复用一秒。 */
const decisions = new Map<string, { expiresAt: number; result: Promise<SystemProxyRoute[]> }>();
/** 原生代理查询最多并行四次，避免大量不同目标同时启动系统进程。 */
let activeQueries = 0;
/** 等待队列最多容纳 128 个目标，额外连接立即返回失败。 */
const waitingQueries: Array<() => void> = [];

/** CFNetwork 负责系统绕过规则与 PAC；Secure Web Proxy 仍使用 HTTP CONNECT。 */
const macSystemProxyScript = `
ObjC.import('Foundation');
ObjC.import('CFNetwork');
// 将系统返回的有序出口转换为模型宿主可消费的代理地址。
function routes(reference, target) {
  var list = ObjC.castRefToObject(reference);
  var result = [];
  for (var i = 0; i < list.count; i++) {
    var item = list.objectAtIndex(i);
    // CFString 常量须先桥接为 NSString，否则 JXA 会把字典键读成空值。
    var type = ObjC.unwrap(item.objectForKey(ObjC.castRefToObject($.kCFProxyTypeKey)));
    if (type === 'kCFProxyTypeAutoConfigurationURL' || type === 'kCFProxyTypeAutoConfigurationJavaScript') {
      var script = type === 'kCFProxyTypeAutoConfigurationURL'
        ? $.NSString.stringWithContentsOfURLEncodingError(item.objectForKey(ObjC.castRefToObject($.kCFProxyAutoConfigurationURLKey)), $.NSUTF8StringEncoding, null)
        : item.objectForKey(ObjC.castRefToObject($.kCFProxyAutoConfigurationJavaScriptKey));
      if (!script || script.length === 0 || script.length > 1048576) throw new Error('Invalid PAC script');
      var expanded = $.CFNetworkCopyProxiesForAutoConfigurationScript(script, target, null);
      if (!expanded) throw new Error('PAC resolution failed');
      result = result.concat(routes(expanded, target));
    } else if (type === 'kCFProxyTypeNone') {
      result.push({ kind: 'direct' });
    } else {
      var scheme = type === 'kCFProxyTypeSOCKS' ? 'socks5' :
        type === 'kCFProxyTypeHTTP' || type === 'kCFProxyTypeHTTPS' ? 'http' : null;
      if (!scheme) throw new Error('Unsupported system proxy');
      var host = ObjC.unwrap(item.objectForKey(ObjC.castRefToObject($.kCFProxyHostNameKey)));
      var port = ObjC.unwrap(item.objectForKey(ObjC.castRefToObject($.kCFProxyPortNumberKey)));
      var user = ObjC.unwrap(item.objectForKey(ObjC.castRefToObject($.kCFProxyUsernameKey)));
      var password = ObjC.unwrap(item.objectForKey(ObjC.castRefToObject($.kCFProxyPasswordKey)));
      var auth = user || password ? encodeURIComponent(user || '') + ':' + encodeURIComponent(password || '') + '@' : '';
      result.push({ url: scheme + '://' + auth + (host.indexOf(':') >= 0 ? '[' + host + ']' : host) + ':' + port });
    }
    if (result.length > 32) throw new Error('Too many system proxies');
  }
  return result;
}
// 目标通过私有进程环境传入，不把网址或查询凭据放入命令行。
function run() {
  var target = $.NSURL.URLWithString($.NSProcessInfo.processInfo.environment.objectForKey('ZEUS_SYSTEM_PROXY_TARGET'));
  return JSON.stringify(routes($.CFNetworkCopyProxiesForURL(target, $.CFNetworkCopySystemProxySettings()), target));
}`;

/** Windows 使用当前用户的系统代理，包含自动配置与目标绕过判断。 */
const windowsSystemProxyScript = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$target = [Uri][Environment]::GetEnvironmentVariable('ZEUS_SYSTEM_PROXY_TARGET')
$proxy = [Net.WebRequest]::GetSystemWebProxy()
if ($null -eq $proxy -or $proxy.IsBypassed($target)) {
  '[{"kind":"direct"}]'
} else {
  $address = $proxy.GetProxy($target)
  if ($null -eq $address -or $address.AbsoluteUri -eq $target.AbsoluteUri) {
    '[{"kind":"direct"}]'
  } else {
    ConvertTo-Json -Compress -InputObject @(@{ url = $address.AbsoluteUri })
  }
}`;

/** 校验操作系统返回值，不把错误文本中的 PAC 地址或代理凭据带入日志。 */
function parseSystemProxyRoutes(output: string): SystemProxyRoute[] {
  /** 原生查询只允许返回有限的有序代理列表。 */
  const values: unknown = JSON.parse(output.replace(/^\uFEFF/u, '').trim());
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) throw new Error('系统代理没有返回有效出口。');
  return values.map((value): SystemProxyRoute => {
    if (!value || typeof value !== 'object') throw new Error('系统代理出口无效。');
    if ('kind' in value && value.kind === 'direct') return { kind: 'direct' };
    if (!('url' in value) || typeof value.url !== 'string') throw new Error('系统代理地址无效。');
    /** URL 解析同时校验主机与端口，认证信息不会被拼接成 HTTP 报文。 */
    const url = new URL(value.url);
    if (!url.hostname || (url.pathname !== '' && url.pathname !== '/') || url.search || url.hash) throw new Error('系统代理地址无效。');
    switch (url.protocol) {
      case 'http:':
        return { kind: 'http', url };
      case 'https:':
        return { kind: 'https', url };
      case 'socks:':
      case 'socks5:':
        return { kind: 'socks5', url };
      case 'socks4:':
        return { kind: 'socks4', url };
      default:
        throw new Error('系统代理使用了不支持的连接协议。');
    }
  });
}

/** 查询本机当前配置；读取失败时返回错误，不把配置故障静默改成直连。 */
async function querySystemProxyRoutes(target: URL): Promise<SystemProxyRoute[]> {
  if (activeQueries < 4) activeQueries++;
  else {
    if (waitingQueries.length >= 128) throw new Error('系统代理解析繁忙，请稍后重试。');
    await new Promise<void>((resolve) => waitingQueries.push(resolve));
  }
  try {
    if (process.platform === 'darwin') {
      /** JXA 仅调用系统网络框架，不启动窗口或读取模型凭据。 */
      const result = await execFileAsync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', macSystemProxyScript], { env: { ...process.env, ZEUS_SYSTEM_PROXY_TARGET: target.href }, timeout: 10_000, maxBuffer: 65_536 });
      return parseSystemProxyRoutes(result.stdout);
    }
    if (process.platform === 'win32') {
      /** 固定系统程序路径，避免工作区中的同名命令被当作系统解析器。 */
      const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      /** 网址只通过子进程环境传入，不参与 PowerShell 命令解析。 */
      const result = await execFileAsync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsSystemProxyScript], {
        env: { ...process.env, ZEUS_SYSTEM_PROXY_TARGET: target.href },
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 65_536,
      });
      return parseSystemProxyRoutes(result.stdout);
    }
    throw new Error('当前平台没有桌面系统代理解析器。');
  } catch {
    throw new Error('读取系统代理失败，请检查系统代理或 PAC 配置。');
  } finally {
    /** 将槽位直接交给下一个等待者，不让新请求插队突破并发上限。 */
    const next = waitingQueries.shift();
    if (next) next();
    else activeQueries--;
  }
}

/** 按真实目标解析系统代理；已有连接不变，新连接最多一秒后跟随系统变更。 */
export function resolveSystemProxyRoutes(target: URL): Promise<SystemProxyRoute[]> {
  /** 保留 HTTP 请求的路径，避免把 PAC 对不同路径的选择合并。 */
  const key = target.href;
  /** 同一轮原生查询只启动一个子进程。 */
  const current = decisions.get(key);
  if (current && current.expiresAt > Date.now()) return current.result;
  /** 缓存有界，工具请求大量不同网址时不会持续累积目标与凭据。 */
  if (decisions.size >= 128) decisions.delete(decisions.keys().next().value!);
  /** 查询进行期间不重复启动；一秒复用期从成功返回后开始计算。 */
  const entry = { expiresAt: Number.POSITIVE_INFINITY, result: querySystemProxyRoutes(target) };
  entry.result = entry.result.then(
    (routes) => {
      entry.expiresAt = Date.now() + 1_000;
      return routes;
    },
    (error: unknown) => {
      if (decisions.get(key) === entry) decisions.delete(key);
      throw error;
    },
  );
  decisions.set(key, entry);
  return entry.result;
}
