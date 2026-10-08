import { readPublicPricingPage } from './pricingPageReader.js';
import type { BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';

interface NativeAutomationHostOptions {
  browser: BrowserAutomationPort;
  computer: BrowserAutomationPort;
  externalBrowser?: BrowserAutomationPort;
  /** 包括后台价目读取在内，所有浏览器联网先等待代理生效。 */
  beforeNetwork?: () => Promise<void>;
  /** 外部扩展使用时等待自身初始化，不阻挡内置浏览器。 */
  beforeExternalBrowser?: () => Promise<void>;
}

/** Electron Main 的单一自动化端口；执行宿主只持有短期桥租约，不拥有任何 UI 或系统权限。 */
export function createNativeAutomationHost(options: NativeAutomationHostOptions): BrowserAutomationPort {
  return {
    async readPricingPage(input) {
      await options.beforeNetwork?.();
      return readPublicPricingPage(input);
    },
    /** 将桌面控制生命周期送到唯一的原生控制宿主。 */
    endComputerUse: (input) => options.computer.endComputerUse?.(input) ?? Promise.resolve(),
    async invoke(input: BrowserAutomationToolCall) {
      if (input.namespace === 'zeus_computer') return options.computer.invoke(input);
      if (input.namespace && input.namespace !== 'zeus_browser') {
        return Promise.resolve({ contentItems: [{ type: 'inputText', text: `Zeus 原生自动化命名空间不存在：${input.namespace}` }], success: false });
      }
      await options.beforeNetwork?.();
      const surface = typeof input.arguments.surface === 'string' ? input.arguments.surface : 'built_in';
      if (surface === 'chrome' || surface === 'edge') {
        await options.beforeExternalBrowser?.();
        if (options.externalBrowser) return options.externalBrowser.invoke({ ...input, namespace: 'zeus_browser' });
        return Promise.resolve({ contentItems: [{ type: 'inputText', text: `Zeus ${surface} 扩展宿主当前不可用。` }], success: false });
      }
      return options.browser.invoke({ ...input, namespace: 'zeus_browser' });
    },
  };
}
