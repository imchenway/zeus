import { BrowserWindow, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { readPricingDocument } from '@zeus/local-server';

/** 动态价目使用一次性无凭据浏览器，所有联网仍经过固定公网地址的读取器。 */
export async function readPublicPricingPage(input: { url: string }): Promise<string> {
  /** 非持久分区不复用用户浏览器 Cookie 或模型密钥。 */
  const isolated = session.fromPartition(`pricing-${randomUUID()}`);
  /** 整页资源受总量和时间上限约束。 */
  const controller = new AbortController();
  /** 一个页面最多读取八十个公开资源。 */
  let resources = 0;
  /** 所有资源累积限制，防止重试和无限分页。 */
  let bytes = 0;
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on('will-download', (event) => event.preventDefault());
  /** 禁止浏览器直接解析任意目标；公开 GET 由 Node 读取器逐次校验 DNS 和重定向。 */
  const read = async (request: Request): Promise<Response> => {
    try {
      if (request.method !== 'GET' || ++resources > 80 || controller.signal.aborted) return new Response('', { status: 403 });
      const text = await readPricingDocument(request.url, controller.signal);
      bytes += Buffer.byteLength(text);
      if (bytes > 8_000_000) throw new Error('动态价格页面超出读取上限。');
      const path = new URL(request.url).pathname;
      const type = /\.m?js$/iu.test(path) ? 'application/javascript' : /\.css$/iu.test(path) ? 'text/css' : /^\s*[[{]/u.test(text) ? 'application/json' : 'text/html';
      return new Response(text, {
        headers: { 'content-type': `${type}; charset=utf-8`, 'content-security-policy': "default-src http: https: 'unsafe-inline' 'unsafe-eval'; connect-src http: https:; worker-src 'none'; frame-src 'none'; object-src 'none'" },
      });
    } catch {
      return new Response('', { status: 502 });
    }
  };
  isolated.protocol.handle('http', read);
  isolated.protocol.handle('https', read);
  /** 沙箱窗口始终隐藏，禁止弹窗及下载，不继承预加载脚本。 */
  const window = new BrowserWindow({ show: false, webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  /** 页面导航不能越过首次用户指定的来源。 */
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  /** 超时销毁窗口，任何错误均经 finally 清理。 */
  const timeout = setTimeout(() => {
    controller.abort();
    if (!window.isDestroyed()) window.destroy();
  }, 20_000);
  try {
    await window.loadURL(input.url);
    /** 等待正文稳定再提取；长时间更新、登录墙或不完整分页不宣称全站覆盖。 */
    const text: unknown = await window.webContents.executeJavaScript(`new Promise(resolve => {
      let previous = '', stable = 0, attempts = 0;
      const timer = setInterval(() => {
        const text = document.body?.innerText ?? '';
        stable = text === previous ? stable + 1 : 0;
        previous = text;
        if ((text.length > 80 && stable >= 4) || ++attempts >= 30) { clearInterval(timer); resolve(text); }
      }, 300);
    })`);
    if (typeof text !== 'string' || text.length < 80 || text.length > 120_000) throw new Error('动态价格页面正文不可完整读取。');
    return text;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    if (!window.isDestroyed()) window.destroy();
    isolated.protocol.unhandle('http');
    isolated.protocol.unhandle('https');
    await isolated.clearStorageData();
  }
}
