import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrowserWindow, Rectangle, WebContents } from 'electron';
import { WebSocket, WebSocketServer } from 'ws';
import { closeLocalHttpServer } from './closeLocalHttpServer.js';

/** 一个 CUA 会话只能访问宿主登记的网页及其子 frame。 */
export interface BrowserCuaSurface {
  /** Zeus 自己创建的网页，不接纳模型提供的 WebContents 身份。 */
  contents: WebContents;
  /** 每次命令重新核对标签归属、存活状态及承载窗口。 */
  window(): BrowserWindow;
  /** 网页在窗口内容区内的实际布局，单位为 DIP。 */
  bounds(): Rectangle;
  /** 仅当前可见标签允许显示原生光标。 */
  visible(): boolean;
  /** CUA 连接建立前已经打开的原生 Page 对话框事件。 */
  pendingDialog?(): Record<string, unknown> | undefined;
  /** 导航沿用 Zeus 的页面访问边界。 */
  allowUrl(url: string): void;
}

/** 只桥接真实 CDP 和窗口元数据，页面语义与输入策略全部由 CUA 执行。 */
export class BrowserCuaBridge {
  /** 私有地址只交给 CUA 子进程，不进入工具参数或模型输出。 */
  private readonly secret = randomBytes(32).toString('hex');
  /** 生命周期由 Zeus 轮次拥有，关闭后旧地址立即失效。 */
  private readonly surfaces = new Map<string, BrowserCuaSurface>();
  /** 会话撤销时同时断开它的 CDP 连接。 */
  private readonly clients = new Map<string, Set<WebSocket>>();
  /** HTTP 不提供公开发现接口。 */
  private readonly server: Server = createServer((_request, response) => response.writeHead(401).end());
  /** 原生客户端只使用私有 WebSocket 地址。 */
  private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
  /** 合并启动，避免并发创建多个端口。 */
  private startup: Promise<string> | undefined;

  /** 只监听回环地址；连接还必须持有私有路径和已登记会话。 */
  start(): Promise<string> {
    return (this.startup ??= new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.on('upgrade', (request, socket, head) => {
        const prefix = `/${this.secret}/`;
        const path = request.url ?? '';
        const session = path.startsWith(prefix) ? path.slice(prefix.length) : '';
        const surface = this.surfaces.get(session);
        if (!surface || request.headers.origin) {
          socket.destroy();
          return;
        }
        this.sockets.handleUpgrade(request, socket, head, (client) => {
          try {
            this.connect(session, surface, client);
          } catch {
            client.terminate();
          }
        });
      });
      this.server.listen(0, '127.0.0.1', () => {
        const { port } = this.server.address() as AddressInfo;
        resolve(`ws://127.0.0.1:${port}/${this.secret}/`);
      });
    }));
  }

  /** 会话身份由宿主生成，原生窗口和网页身份不从模型读取。 */
  register(session: string, surface: BrowserCuaSurface): void {
    if (this.surfaces.get(session)?.contents === surface.contents) return;
    if (this.surfaces.has(session)) this.release(session);
    this.surfaces.set(session, surface);
  }

  /** 撤销旧轮次和已关闭网页的传输能力。 */
  release(session: string): void {
    this.surfaces.delete(session);
    for (const client of this.clients.get(session) ?? []) client.terminate();
    this.clients.delete(session);
  }

  /** 应用关闭时释放全部私有连接和监听端口。 */
  async close(): Promise<void> {
    for (const session of this.surfaces.keys()) this.release(session);
    this.sockets.close();
    await closeLocalHttpServer(this.server);
  }

  /** Electron 提供的 desktop-capture 窗口身份仍须由 CUA 向系统核对。 */
  windowId(window: BrowserWindow): number {
    const id = Number(/^window:(\d+):/u.exec(window.getMediaSourceId())?.[1]);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('无法取得内置浏览器承载窗口的原生身份。');
    return id;
  }

  /** 每个连接只看自己的页面会话，不广播其他网页的 CDP 事件。 */
  private connect(session: string, surface: BrowserCuaSurface, client: WebSocket): void {
    const clients = this.clients.get(session) ?? new Set<WebSocket>();
    clients.add(client);
    this.clients.set(session, clients);
    const debuggerApi = surface.contents.debugger;
    if (!debuggerApi.isAttached()) debuggerApi.attach('1.3');
    const rootTarget = debuggerApi.sendCommand('Target.getTargetInfo') as Promise<{ targetInfo: { targetId: string; [key: string]: unknown } }>;
    void rootTarget.catch(() => client.terminate());
    const sessions = new Set<string>();
    const rootSessions = new Set<string>();
    const targets = new Set<string>();
    let dialogOpen = false;
    /** 自动输入期间拦截上传请求，避免网页弹出抢焦点的系统文件选择器。 */
    let fileChooserSequence = 0;
    const send = (value: unknown): void => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(value));
    };
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>, sessionId?: string): void => {
      if (method === 'Page.fileChooserOpened') {
        fileChooserSequence += 1;
        return;
      }
      if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string' && sessions.has(params.sessionId)) {
        sessions.delete(params.sessionId);
        rootSessions.delete(params.sessionId);
        send({ method, params, ...(sessionId ? { sessionId } : {}) });
        return;
      }
      if (method === 'Page.javascriptDialogOpening' || method === 'Page.javascriptDialogClosed') {
        const opening = method === 'Page.javascriptDialogOpening';
        if (opening !== dialogOpen && rootSessions.size > 0) {
          dialogOpen = opening;
          for (const root of rootSessions) send({ method, params, sessionId: root });
        }
        return;
      }
      if (!sessionId || !sessions.has(sessionId)) return;
      if (method === 'Target.attachedToTarget') {
        const info = params.targetInfo as Record<string, unknown> | undefined;
        if (info?.type !== 'iframe' || typeof info.targetId !== 'string' || typeof params.sessionId !== 'string') return;
        targets.add(info.targetId);
        sessions.add(params.sessionId);
      }
      if (method.startsWith('Target.') && typeof params.targetId === 'string' && !targets.has(params.targetId)) return;
      const info = params.targetInfo as { targetId?: string } | undefined;
      if (method.startsWith('Target.') && info?.targetId && !targets.has(info.targetId)) return;
      send({ method, params, sessionId });
    };
    const disconnect = (): void => {
      client.terminate();
    };
    debuggerApi.on('message', onMessage);
    debuggerApi.on('detach', disconnect);
    surface.contents.once('destroyed', disconnect);
    client.on('message', (raw) => {
      void (async () => {
        let id: number | undefined;
        try {
          const request = JSON.parse(raw.toString()) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string };
          id = request.id;
          if (!Number.isSafeInteger(id) || typeof request.method !== 'string') throw new Error('CDP 请求格式无效。');
          if (this.surfaces.get(session) !== surface || surface.contents.isDestroyed()) throw new Error('浏览器会话或网页已经关闭。');
          const window = surface.window();
          if (window.isDestroyed()) throw new Error('浏览器承载窗口已经关闭。');
          if (request.sessionId && !sessions.has(request.sessionId)) throw new Error('CDP 会话不属于当前网页。');
          const params = request.params ?? {};
          const targetInfo = await rootTarget;
          const root = targetInfo.targetInfo;
          targets.add(root.targetId);
          let result: unknown;
          if (request.method === 'Target.getTargets') result = { targetInfos: [root] };
          else if (request.method === 'Zeus.getBrowserSurface') {
            const content = window.getContentBounds();
            const bounds = surface.bounds();
            result = {
              pid: process.pid,
              windowId: this.windowId(window),
              targetId: root.targetId,
              active: surface.visible(),
              zoom: surface.contents.getZoomFactor(),
              bounds: { x: content.x + bounds.x, y: content.y + bounds.y, width: bounds.width, height: bounds.height },
            };
          } else if (request.method === 'Browser.getWindowForTarget') {
            if (params.targetId !== root.targetId) throw new Error('目标不属于当前网页。');
            result = { windowId: this.windowId(window), bounds: this.windowBounds(window) };
          } else if (request.method === 'Browser.getWindowBounds') {
            if (params.windowId !== this.windowId(window)) throw new Error('目标不属于当前窗口。');
            result = { bounds: this.windowBounds(window) };
          } else {
            if (typeof params.targetId === 'string' && !targets.has(params.targetId)) throw new Error('目标不属于当前网页。');
            if (typeof params.sessionId === 'string' && !sessions.has(params.sessionId)) throw new Error('目标会话不属于当前网页。');
            if (request.method === 'Page.navigate') surface.allowUrl(String(params.url ?? ''));
            const domain = request.method.split('.')[0];
            if (!['Target', 'Page', 'Runtime', 'DOM', 'DOMSnapshot', 'Accessibility', 'Input', 'Browser', 'Emulation'].includes(domain)) throw new Error('当前浏览器桥未开放该 CDP 能力。');
            if (domain === 'Browser' && request.method !== 'Browser.getVersion') throw new Error('当前浏览器桥未开放该 Browser 操作。');
            if (domain === 'Target' && !['Target.getTargetInfo', 'Target.attachToTarget', 'Target.detachFromTarget', 'Target.setAutoAttach', 'Target.setDiscoverTargets'].includes(request.method))
              throw new Error('当前浏览器桥未开放该 Target 操作。');
            /** 只在 CUA 输入期间禁止自动上传；用户平时仍可直接使用网页文件选择器。 */
            const interceptChooser =
              (request.method === 'Input.dispatchMouseEvent' && ['mousePressed', 'mouseReleased'].includes(String(params.type))) ||
              (request.method === 'Input.dispatchKeyEvent' && ['keyDown', 'rawKeyDown', 'char'].includes(String(params.type))) ||
              (request.method === 'Runtime.callFunctionOn' && params.userGesture === true);
            const chooserBefore = fileChooserSequence;
            if (interceptChooser) await debuggerApi.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true }, request.sessionId);
            try {
              result = await debuggerApi.sendCommand(request.method, params, request.sessionId);
            } finally {
              if (interceptChooser) await debuggerApi.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false }, request.sessionId);
            }
            if (interceptChooser && fileChooserSequence !== chooserBefore) throw new Error('自动上传未执行；请由用户在网页中手动选择文件。');
            if (request.method === 'Target.attachToTarget') {
              const attached = result as { sessionId?: string };
              if (attached.sessionId) {
                sessions.add(attached.sessionId);
                if (params.targetId === root.targetId) rootSessions.add(attached.sessionId);
              }
            }
            if (request.method === 'Target.detachFromTarget' && typeof params.sessionId === 'string') {
              sessions.delete(params.sessionId);
              rootSessions.delete(params.sessionId);
            }
            if (request.method === 'Page.enable' && request.sessionId && !dialogOpen) {
              const pending = surface.pendingDialog?.();
              if (pending) {
                dialogOpen = true;
                send({ method: 'Page.javascriptDialogOpening', params: pending, sessionId: request.sessionId });
              }
            }
          }
          send({ id, result });
        } catch (error) {
          send({ id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
        }
      })();
    });
    client.once('close', () => {
      debuggerApi.removeListener('message', onMessage);
      debuggerApi.removeListener('detach', disconnect);
      surface.contents.removeListener('destroyed', disconnect);
      clients.delete(client);
      for (const sessionId of sessions) {
        if (!surface.contents.isDestroyed()) void debuggerApi.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => undefined);
      }
    });
    client.on('error', () => client.terminate());
  }

  /** 返回真实宿主窗口几何，不用页面标题推断标签身份。 */
  private windowBounds(window: BrowserWindow): Record<string, unknown> {
    const { x, y, width, height } = window.getBounds();
    return { left: x, top: y, width, height, windowState: window.isMinimized() ? 'minimized' : window.isMaximized() ? 'maximized' : 'normal' };
  }
}
