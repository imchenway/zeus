import * as http from 'node:http';
import { networkProxyEnvironment, type NetworkProxySettings } from '@zeus/shared';

/** 启动环境只读取一次，避免内嵌服务重建时把上次手动代理误当成默认值。 */
const inheritedProxyEnvironment = Object.fromEntries(Object.keys(networkProxyEnvironment({ mode: 'direct', url: '', bypass: '' })).map((key) => [key, process.env[key]]));
/** 原生恢复函数只在下一次初始化时执行，不中断运行中的请求。 */
let restoreGlobalProxy: (() => void) | undefined;

/** 检查默认模式时使用最初的启动环境，避免把当前手动代理误当成默认值。 */
export function networkProxyRuntimeEnvironment(settings: NetworkProxySettings): Record<string, string> {
  if (settings.mode !== 'default') return networkProxyEnvironment(settings);
  return Object.fromEntries(Object.entries(inheritedProxyEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** 在任何外部请求和模型进程启动前设置 Node 原生代理及子进程环境。 */
export function applyNetworkProxyAtStartup(settings: NetworkProxySettings): void {
  /** Electron 已内置此能力；旧版 Node 开发环境给出明确错误，不静默直连。 */
  const setGlobalProxyFromEnv = (http as typeof http & { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }).setGlobalProxyFromEnv;
  if (settings.mode !== 'default' && !setGlobalProxyFromEnv) throw new Error('当前 Node.js 不支持网络代理，请升级 Node.js 或使用 Zeus 测试应用。');
  restoreGlobalProxy?.();
  restoreGlobalProxy = undefined;
  for (const [key, value] of Object.entries(inheritedProxyEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (settings.mode === 'default') return;
  /** 原生代理同时覆盖 fetch 与 Node HTTP/HTTPS，无需新增代理依赖。 */
  const environment = networkProxyEnvironment(settings);
  restoreGlobalProxy = setGlobalProxyFromEnv!(environment);
  Object.assign(process.env, environment);
}
