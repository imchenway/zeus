import type { BrowserAutomationPort, BrowserAutomationToolCall } from '@zeus/local-server';

interface NativeAutomationHostOptions {
  browser: BrowserAutomationPort;
  computer: BrowserAutomationPort;
  externalBrowser?: BrowserAutomationPort;
}

/** Electron Main 的单一自动化端口；执行宿主只持有短期桥租约，不拥有任何 UI 或系统权限。 */
export function createNativeAutomationHost(options: NativeAutomationHostOptions): BrowserAutomationPort {
  return {
    invoke(input: BrowserAutomationToolCall) {
      if (input.namespace === 'zeus_computer') return options.computer.invoke(input);
      if (input.namespace && input.namespace !== 'zeus_browser') {
        return Promise.resolve({ contentItems: [{ type: 'inputText', text: `Zeus 原生自动化命名空间不存在：${input.namespace}` }], success: false });
      }
      const surface = typeof input.arguments.surface === 'string' ? input.arguments.surface : 'built_in';
      if (surface === 'chrome' || surface === 'edge') {
        if (options.externalBrowser) return options.externalBrowser.invoke({ ...input, namespace: 'zeus_browser' });
        return Promise.resolve({ contentItems: [{ type: 'inputText', text: `Zeus ${surface} 扩展宿主当前不可用。` }], success: false });
      }
      return options.browser.invoke({ ...input, namespace: 'zeus_browser' });
    },
  };
}
