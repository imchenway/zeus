import { addWebUiListener, removeWebUiListener, sendWithPromise } from 'chrome://resources/js/cr.js';
import { createDesktopApi, type DesktopTransport } from './desktopApi.cjs';
import { decodeChromiumWire, encodeChromiumWire } from './chromiumWire.js';

/** 可信 WebUI 自带的通知接口；原生端仍须核验发起帧身份。 */
interface ChromiumWebUiWindow extends Window {
  /** Chromium 注入的原生消息入口。 */
  chrome?: { send(message: string, args?: unknown[]): void };
}

if (location.protocol !== 'chrome:' || location.hostname !== 'zeus' || window.top !== window) {
  throw new Error('Zeus 桌面桥只能在可信的顶层 Chromium WebUI 中初始化。');
}

/** 提前固定原生通知函数，不从普通网页或后续可变对象读取。 */
const send = (window as ChromiumWebUiWindow).chrome?.send.bind((window as ChromiumWebUiWindow).chrome);
if (!send) throw new Error('当前 Chromium 宿主未提供 WebUI 通信接口。');
if (Object.hasOwn(window, 'zeus')) throw new Error('当前界面的桌面桥已初始化。');

/** Chromium 原生通道使用独立命令来源，不伪装为 Electron IPC。 */
const transport: DesktopTransport = {
  kind: 'chromium-native',
  invoke: async (channel, ...args) => decodeChromiumWire(await sendWithPromise('zeusDesktopInvoke', channel, encodeChromiumWire(args))),
  send: (channel, ...args) => send('zeusDesktopSend', [channel, encodeChromiumWire(args)]),
  subscribe: <T>(channel: string, listener: (value: T) => void) => {
    /** 订阅身份由 Chromium 保存，不向业务界面暴露。 */
    const subscription = addWebUiListener(channel, (value: unknown) => listener(decodeChromiumWire(value) as T));
    return () => removeWebUiListener(subscription);
  },
  // WebUI 不提供任意文件路径；用户选入的 File 走现有附件物化与授权链路。
  getPathForFile: () => '',
};

/** 两种宿主复用完全相同的业务 API；仅该对象向可信界面公开。 */
const desktopApi = Object.freeze(createDesktopApi(transport));
Object.defineProperty(window, 'zeus', { value: desktopApi, enumerable: true, writable: false, configurable: false });

// 必须先完成桥初始化，再执行现有 Zeus 启动入口，避免界面读取空宿主。
void import(/* @vite-ignore */ __ZEUS_RENDERER_ENTRY__).catch((error: unknown) => {
  desktopApi.reportRendererFatalFailure(error instanceof Error ? error.message : String(error));
});
