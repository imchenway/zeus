/** 本机网络代理；默认保留系统和启动环境，修改后完整重启应用生效。 */
export interface NetworkProxySettings {
  /** 默认、强制直连或手动指定代理。 */
  mode: 'default' | 'direct' | 'manual';
  /** 无账号密码的 HTTP/HTTPS 代理地址。 */
  url: string;
  /** 逗号分隔的域名、域名后缀或 IP；本机回环地址始终直连。 */
  bypass: string;
}

/** 旧资料没有代理字段时保持既有网络行为。 */
export const defaultNetworkProxySettings: NetworkProxySettings = { mode: 'default', url: '', bypass: '' };

/** 本地连接不经过代理；Node HTTP 与 fetch 对 IPv6 分别需要裸地址和方括号写法。 */
export const networkProxyLoopbackBypass = 'localhost,127.0.0.1,::1,[::1]';

/** 表单分别保留文本，允许用户先输入主机再输入端口。 */
export interface NetworkProxyAddressFields {
  /** 代理服务器连接协议。 */
  protocol: 'http' | 'https';
  /** 不含协议、路径或端口的主机名；支持 IPv6。 */
  host: string;
  /** 保留未完成输入，提交时才转换并校验。 */
  port: string;
}

/** 单条网络链路的检查结果，不返回响应正文或可能含秘密的错误原文。 */
export interface NetworkProxyConnectionResult {
  /** 收到 HTTP 响应时返回状态码，包含目标网站的拒绝响应。 */
  statusCode?: number;
  /** 失败按超时、代理认证或连接错误区分。 */
  error?: 'timeout' | 'authentication' | 'connection';
}

/** 两条网络链路分别报告，不将浏览器可用误报为模型可用。 */
export interface NetworkProxyCheckResult {
  /** Chromium 网络检查。 */
  browser: NetworkProxyConnectionResult;
  /** 模型宿主使用的 Node 网络检查。 */
  node: NetworkProxyConnectionResult;
}

/** 已有 URL 自动拆分；标准端口即使被 URL 规范化省略也能回填。 */
export function networkProxyAddressFields(settings: NetworkProxySettings): NetworkProxyAddressFields {
  if (!settings.url) return { protocol: 'http', host: '', port: '' };
  /** 持久化地址仍需经过统一校验。 */
  const url = new URL(normalizeNetworkProxySettings(settings).url);
  return { protocol: url.protocol === 'https:' ? 'https' : 'http', host: url.hostname, port: url.port || (url.protocol === 'https:' ? '443' : '80') };
}

/** 独立输入框统一组装为原有存储格式，不引入第二套代理状态。 */
export function networkProxySettingsFromFields(mode: NetworkProxySettings['mode'], fields: NetworkProxyAddressFields, bypass: string): NetworkProxySettings {
  if (mode !== 'manual') return normalizeNetworkProxySettings({ mode });
  if (fields.protocol !== 'http' && fields.protocol !== 'https') throw new NetworkProxySettingsError('请选择 HTTP 或 HTTPS 代理。');
  /** 显式端口只接受十进制整数，禁止空值、零、科学计数法和越界值。 */
  const port = fields.port.trim();
  if (!/^\d{1,5}$/u.test(port) || Number(port) < 1 || Number(port) > 65535) throw new NetworkProxySettingsError('端口号须为 1 到 65535 的整数。');
  /** 拒绝把完整地址或内嵌端口当成主机；裸 IPv6 由 URL 负责最终校验。 */
  const host = fields.host.trim();
  if (!host || /[\s/@?#\\]/u.test(host) || (host.includes(':') && !host.startsWith('[') && host.split(':').length < 3) || /^\[.*\].+$/u.test(host)) throw new NetworkProxySettingsError('主机名只填写域名或 IP，协议和端口请使用独立输入框。');
  return normalizeNetworkProxySettings({ mode, url: `${fields.protocol}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${Number(port)}`, bypass });
}

/** 输入错误不携带原始地址，防止账号密码进入日志。 */
export class NetworkProxySettingsError extends Error {
  /** 供设置接口区分输入错误与保存失败。 */
  readonly code = 'ZEUS_NETWORK_PROXY_INVALID';
}

/** 设置保存、导入与启动共用校验，拒绝无法跨网络通道一致执行的规则。 */
export function normalizeNetworkProxySettings(value: unknown): NetworkProxySettings {
  if (value === undefined) return { ...defaultNetworkProxySettings };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NetworkProxySettingsError('代理配置格式无效。');
  /** 不信任接口或导入文件中的字段类型。 */
  const raw = value as Record<string, unknown>;
  if (raw.mode !== 'default' && raw.mode !== 'direct' && raw.mode !== 'manual') throw new NetworkProxySettingsError('请选择默认、直连或手动代理。');
  if (raw.mode !== 'manual') return { mode: raw.mode, url: '', bypass: '' };
  if (typeof raw.url !== 'string' || raw.url.length > 2048 || typeof raw.bypass !== 'string' || raw.bypass.length > 4096) throw new NetworkProxySettingsError('请填写有效的代理地址和绕过列表。');
  /** URL 解析前拒绝空白及反斜杠，避免宽松解析改变输入含义。 */
  const address = raw.url.trim();
  if (!/^https?:\/\//u.test(address) || /[\s\\]/u.test(address)) throw new NetworkProxySettingsError('代理地址须以 http:// 或 https:// 开头，例如 http://127.0.0.1:7890。');
  /** 原生 URL 负责端口范围、IPv6 和地址规范化。 */
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new NetworkProxySettingsError('代理地址或端口无效。');
  }
  if (url.username || url.password || address.includes('@')) throw new NetworkProxySettingsError('代理地址不能包含账号密码；请使用本机代理客户端提供的无认证地址。');
  if (url.port === '0') throw new NetworkProxySettingsError('端口号须为 1 到 65535 的整数。');
  if (!url.hostname || url.pathname !== '/' || url.search || url.hash || /[?#]/u.test(address)) throw new NetworkProxySettingsError('代理地址只能包含协议、主机和端口，不能包含路径、查询参数或片段。');
  /** 统一采用主机或后缀语义，不接受各平台解释不同的端口、CIDR 和任意通配符。 */
  const bypass = [
    ...new Set(
      raw.bypass
        .split(/[\s,;]+/u)
        .filter(Boolean)
        .map((host) => host.toLowerCase()),
    ),
  ];
  for (const host of bypass) {
    if (host === '::1') continue;
    if (!/^(?:\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(host) || host.includes('..')) throw new NetworkProxySettingsError('绕过列表只支持域名、以点开头的域名后缀或 IPv4 地址，用逗号分隔；本机回环地址已自动绕过。');
  }
  return { mode: 'manual', url: url.origin, bypass: bypass.join(',') };
}

/** 统一大小写环境变量，防止启动环境中已有的小写代理覆盖手动配置。 */
export function networkProxyEnvironment(settings: NetworkProxySettings): Record<string, string> {
  if (settings.mode === 'default') return {};
  /** 直连清空代理并绕过所有地址；手动代理始终保留回环直连。 */
  const proxy = settings.mode === 'manual' ? settings.url : '';
  /** 逗号分隔规则供 Node、模型进程和常见命令行工具共同使用。 */
  const bypass = settings.mode === 'manual' ? [networkProxyLoopbackBypass, settings.bypass].filter(Boolean).join(',') : '*';
  return { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, NO_PROXY: bypass, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: bypass, NODE_USE_ENV_PROXY: '1' };
}
