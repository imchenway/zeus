import * as http from 'node:http';
import { networkProxyEnvironment, type NetworkProxySettings } from '@zeus/shared';
import { startSystemProxyBridge } from './systemProxyBridge.js';

/** 启动环境只读取一次，避免内嵌服务重建时把上次手动代理误当成默认值。 */
const inheritedProxyEnvironment = Object.fromEntries(Object.keys(networkProxyEnvironment({ mode: 'direct', url: '', bypass: '' })).map((key) => [key, process.env[key]]));
/** 原生恢复函数只在下一次初始化时执行，不中断运行中的请求。 */
let restoreGlobalProxy: (() => void) | undefined;
/** Core 与 Main 各自拥有本机出口，不把后台模型连接绑定到界面进程。 */
let systemProxyBridge: ReturnType<typeof startSystemProxyBridge> | undefined;

/** 默认模式经统一出口逐目标跟随系统；手动与直连模式显式覆盖它。 */
export async function networkProxyRuntimeEnvironment(settings: NetworkProxySettings): Promise<Record<string, string>> {
  if (settings.mode !== 'default') return networkProxyEnvironment(settings);
  if (process.platform === 'darwin' || process.platform === 'win32') {
    systemProxyBridge ??= startSystemProxyBridge().catch((error: unknown) => {
      systemProxyBridge = undefined;
      throw error;
    });
    /** 内部代理地址不进入用户设置；回环 API 始终绕过转发器。 */
    const bridge = await systemProxyBridge;
    return networkProxyEnvironment({ mode: 'manual', url: bridge.url, bypass: '' });
  }
  // 非桌面宿主继续采用其操作系统通常使用的启动代理环境。
  return Object.fromEntries(Object.entries(inheritedProxyEnvironment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

/** 在宿主关闭后回收转发连接与 Agent，保留其他进程独立持有的出口。 */
export async function closeNetworkProxyRuntime(): Promise<void> {
  restoreGlobalProxy?.();
  restoreGlobalProxy = undefined;
  /** 先移除引用，迟到的关闭不会覆盖下一次初始化的出口。 */
  const previous = systemProxyBridge;
  systemProxyBridge = undefined;
  if (previous)
    await previous.then(
      (bridge) => bridge.close(),
      () => undefined,
    );
}

/** 在任何外部请求和模型进程启动前设置 Node 原生代理及子进程环境。 */
export async function applyNetworkProxyAtStartup(settings: NetworkProxySettings): Promise<void> {
  /** Electron 已内置此能力；旧版 Node 开发环境给出明确错误，不静默直连。 */
  const setGlobalProxyFromEnv = (http as typeof http & { setGlobalProxyFromEnv?: (env: Record<string, string>) => () => void }).setGlobalProxyFromEnv;
  if ((settings.mode !== 'default' || process.platform === 'darwin' || process.platform === 'win32') && !setGlobalProxyFromEnv) throw new Error('当前 Node.js 不支持网络代理，请升级 Node.js 或使用 Zeus 测试应用。');
  await closeNetworkProxyRuntime();
  for (const [key, value] of Object.entries(inheritedProxyEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  /** 原生代理同时覆盖 fetch 与 Node HTTP/HTTPS，无需新增代理依赖。 */
  const environment = await networkProxyRuntimeEnvironment(settings);
  restoreGlobalProxy = setGlobalProxyFromEnv?.(environment);
  Object.assign(process.env, environment);
}
