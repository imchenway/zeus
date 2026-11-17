import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserCuaBridge } from './browserCuaBridge.js';

/** 为 Zeus 自有窗口登记仅同一系统用户可发现的后台文本输入能力。 */
export class ComputerElectronBridge {
  /** 复用私有 CDP 传输，不启动 Electron 的公共调试端口。 */
  private readonly bridge = new BrowserCuaBridge();
  /** 原生 worker 与 Main 使用相同的系统临时目录和用户身份。 */
  private readonly directory = join(tmpdir(), `zeus-cua-electron-${process.getuid!()}`);
  /** 关闭时撤销当前实例写入的全部窗口凭证。 */
  private readonly files = new Set<string>();
  /** 连接地址仅在 Main 与受控原生 worker 间传递。 */
  private readonly endpoint = this.bridge.start();
  /** 应用退出后禁止迟到的窗口登记。 */
  private closed = false;
  /** 窗口创建事件只登记该窗口，不激活或抬升窗口。 */
  private readonly onWindow = (_event: unknown, window: BrowserWindow): void => {
    void this.register(window).catch(() => console.warn('Zeus 窗口后台输入桥登记失败。'));
  };

  /** 同时覆盖已存在窗口和之后创建的设置、编辑器等独立窗口。 */
  constructor() {
    void this.endpoint.catch(() => console.warn('Zeus 窗口后台输入桥启动失败。'));
    app.on('browser-window-created', this.onWindow);
    for (const window of BrowserWindow.getAllWindows()) this.onWindow(undefined, window);
  }

  /** 每份凭证只绑定当前进程和一个原生窗口，关闭窗口即失效。 */
  private async register(window: BrowserWindow): Promise<void> {
    const endpoint = await this.endpoint;
    if (this.closed || window.isDestroyed()) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0) throw new Error('后台输入桥目录的身份或权限不匹配。');
    const windowId = this.bridge.windowId(window);
    const session = randomUUID();
    const path = join(this.directory, `${process.pid}-${windowId}.json`);
    const temporary = `${path}.${randomUUID()}`;
    this.bridge.register(session, {
      contents: window.webContents,
      window: () => window,
      bounds: () => {
        const [width, height] = window.getContentSize();
        return { x: 0, y: 0, width, height };
      },
      visible: () => window.isVisible(),
      textInputOnly: true,
      allowUrl: () => {
        throw new Error('应用后台输入桥不允许导航。');
      },
    });
    try {
      writeFileSync(temporary, JSON.stringify({ pid: process.pid, windowId, endpoint: `${endpoint}${session}` }), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path);
      this.files.add(path);
    } finally {
      rmSync(temporary, { force: true });
    }
    window.once('closed', () => {
      this.bridge.release(session);
      this.files.delete(path);
      rmSync(path, { force: true });
    });
  }

  /** 退出时先撤销凭证，再断开全部私有传输。 */
  async close(): Promise<void> {
    this.closed = true;
    app.removeListener('browser-window-created', this.onWindow);
    for (const path of this.files) rmSync(path, { force: true });
    this.files.clear();
    await this.endpoint.catch(() => undefined);
    await this.bridge.close();
  }
}
