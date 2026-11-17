import * as http from 'node:http';
import { BlockList, isIP } from 'node:net';
import { networkProxyEnvironment, normalizeNetworkProxySettings, type NetworkProxySettings } from '@zeus/shared';
import { startSystemProxyBridge } from './systemProxyBridge.js';
import { resolveSystemProxyRoutes, type SystemProxyRoute } from './systemProxyResolver.js';

/** 非桌面宿主的默认模式沿用启动时的代理环境，避免读取自身转发地址。 */
const inheritedProxyEnvironment = { ...process.env };
/** 当前正式出口与持久化设置使用相同的规范化结构。 */
let activeNetworkProxy = normalizeNetworkProxySettings(undefined);
/** 关闭宿主时恢复 Node 原有网络实现。 */
let restoreGlobalProxy: (() => void) | undefined;
/** 所有客户端共享固定回环入口，切换配置不要求重启已有子进程。 */
let networkProxyBridge: Awaited<ReturnType<typeof startSystemProxyBridge>> | undefined;
/** 并发读取运行地址时只创建一个监听端口。 */
let startingNetworkProxyBridge: ReturnType<typeof startSystemProxyBridge> | undefined;

/** 匹配手动绕过规则及非桌面宿主原有的 NO_PROXY 主机、端口和 IPv4 范围。 */
function bypassesProxy(target: URL, bypass: string): boolean {
  /** URL 的 IPv6 方括号不属于主机身份。 */
  const host = target.hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  /** 标准端口会被 URL 省略，匹配显式端口规则前补齐。 */
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return bypass.split(',').some((value) => {
    /** 环境变量允许星号；手动配置已由共享边界限制为主机或域名后缀。 */
    let rule = value.trim().toLowerCase();
    if (rule === '*') return true;
    if (!rule) return false;
    if (rule === host || rule === target.hostname.toLowerCase()) return true;
    /** 带方括号的 IPv6 或普通主机可以限定目标端口。 */
    const withPort = /^(\[[^\]]+\]|[^:]+):(\d+)$/u.exec(rule);
    if (withPort) {
      if (withPort[2] !== port) return false;
      rule = withPort[1]!.replace(/^\[|\]$/gu, '');
    }
    /** Node 的 NO_PROXY 同时支持闭区间形式的 IPv4 地址。 */
    const range = rule.split('-');
    if (range.length === 2 && range.every((address) => isIP(address) === 4) && isIP(host) === 4) {
      /** 原生地址比较避免字符串字典序误判网段。 */
      const addresses = new BlockList();
      try {
        addresses.addRange(range[0]!, range[1]!);
        return addresses.check(host);
      } catch {
        return false;
      }
    }
    return host === rule || ((rule.startsWith('.') || rule.startsWith('*.')) && host.endsWith(rule.replace(/^\*/u, '')));
  });
}

/** 每次建连读取当前出口；配置失败不会静默回退为直连。 */
async function resolveNetworkProxyRoutes(target: URL): Promise<SystemProxyRoute[]> {
  /** 同一次解析固定一个配置快照，切换时旧客户端连接会被关闭。 */
  const settings = activeNetworkProxy;
  if (settings.mode === 'direct' || (settings.mode === 'manual' && bypassesProxy(target, settings.bypass))) return [{ kind: 'direct' }];
  if (settings.mode === 'manual') return [{ kind: settings.url.startsWith('https:') ? 'https' : 'http', url: new URL(settings.url) }];
  if (process.platform === 'darwin' || process.platform === 'win32') return resolveSystemProxyRoutes(target);
  if (bypassesProxy(target, inheritedProxyEnvironment.no_proxy ?? inheritedProxyEnvironment.NO_PROXY ?? '')) return [{ kind: 'direct' }];
  /** 小写环境变量与原生 Node 代理采用相同优先级。 */
  const proxy = target.protocol === 'https:' ? (inheritedProxyEnvironment.https_proxy ?? inheritedProxyEnvironment.HTTPS_PROXY) : (inheritedProxyEnvironment.http_proxy ?? inheritedProxyEnvironment.HTTP_PROXY);
  if (!proxy) return [{ kind: 'direct' }];
  /** 非桌面环境仍只接受原生 Node 支持的 HTTP/HTTPS 代理地址。 */
  const url = new URL(proxy);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('启动环境中的代理协议不受支持。');
  return [{ kind: url.protocol === 'https:' ? 'https' : 'http', url }];
}

/** 设置保存与导入共用同步切换，立即关闭旧连接且不重发业务请求。 */
export function updateNetworkProxySettings(value: NetworkProxySettings | undefined): void {
  /** 运行出口只接收共享校验后的完整配置。 */
  const next = normalizeNetworkProxySettings(value);
  if (next.mode === activeNetworkProxy.mode && next.url === activeNetworkProxy.url && next.bypass === activeNetworkProxy.bypass) return;
  activeNetworkProxy = next;
  networkProxyBridge?.resetConnections();
}

/** 真实生效状态由网络出口提供，不从界面草稿推断。 */
export function readActiveNetworkProxySettings(): NetworkProxySettings {
  return { ...activeNetworkProxy };
}

/** 模型、Main 和浏览器始终连接固定入口，绕过规则在转发器内实时执行。 */
export async function networkProxyRuntimeEnvironment(): Promise<Record<string, string>> {
  if (!startingNetworkProxyBridge) {
    /** 关闭与重建交错时，旧监听端口的回执不能替换新入口。 */
    const startup: ReturnType<typeof startSystemProxyBridge> = startSystemProxyBridge(resolveNetworkProxyRoutes)
      .then((bridge) => {
        if (startingNetworkProxyBridge === startup) networkProxyBridge = bridge;
        return bridge;
      })
      .catch((error: unknown) => {
        if (startingNetworkProxyBridge === startup) startingNetworkProxyBridge = undefined;
        throw error;
      });
    startingNetworkProxyBridge = startup;
  }
  /** 地址中的随机凭据只传给当前宿主客户端，不写入用户设置。 */
  const bridge = await startingNetworkProxyBridge;
  return networkProxyEnvironment({ mode: 'manual', url: bridge.url, bypass: '' });
}

/** Core 与 Main 使用同一个运行出口，覆盖 fetch、Node HTTP/HTTPS 和后续子进程。 */
export function applyNetworkProxyEnvironment(environment: Record<string, string>): void {
  /** 原生能力缺失时明确失败，不绕过用户代理配置。 */
  const setGlobalProxyFromEnv = (http as typeof http & { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }).setGlobalProxyFromEnv;
  if (!setGlobalProxyFromEnv) throw new Error('当前 Node.js 不支持网络代理，请升级 Node.js 或使用 Zeus 测试应用。');
  restoreGlobalProxy?.();
  restoreGlobalProxy = setGlobalProxyFromEnv(environment);
  Object.assign(process.env, environment);
}

/** 宿主关闭时回收转发连接，保留其他进程独立持有的资源。 */
export async function closeNetworkProxyRuntime(): Promise<void> {
  restoreGlobalProxy?.();
  restoreGlobalProxy = undefined;
  /** 先移除引用，迟到的关闭不会覆盖下一次初始化。 */
  const previous = startingNetworkProxyBridge;
  startingNetworkProxyBridge = undefined;
  networkProxyBridge = undefined;
  if (previous)
    await previous.then(
      (bridge) => bridge.close(),
      () => undefined,
    );
}

/** 在业务请求启动前建立固定出口，后续设置变更只切换出口规则。 */
export async function initializeNetworkProxyRuntime(settings: NetworkProxySettings): Promise<void> {
  updateNetworkProxySettings(settings);
  applyNetworkProxyEnvironment(await networkProxyRuntimeEnvironment());
}
