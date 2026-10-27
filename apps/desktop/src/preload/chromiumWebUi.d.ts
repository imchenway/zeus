/** Chromium 提供的可信 WebUI 消息接口，不是第三方网页 API。 */
declare module 'chrome://resources/js/cr.js' {
  /** 与原生 WebUIMessageHandler 的 Resolve/RejectJavascriptCallback 配对。 */
  export function sendWithPromise<T>(method: string, ...args: unknown[]): Promise<T>;
  /** 原生 FireWebUIListener 对应的可释放订阅。 */
  export interface WebUiListener {
    /** 原生事件名称。 */
    eventName: string;
    /** Chromium 分配的订阅标识。 */
    uid: number;
  }
  /** 订阅来自原生宿主的业务事件。 */
  export function addWebUiListener(eventName: string, callback: (...args: unknown[]) => void): WebUiListener;
  /** 释放当前订阅，保留同名事件的其他订阅者。 */
  export function removeWebUiListener(listener: WebUiListener): boolean;
}

/** 构建时注入现有 Zeus 界面入口地址；不包含账号或访问令牌。 */
declare const __ZEUS_RENDERER_ENTRY__: string;
