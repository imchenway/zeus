import { BrowserWindow, nativeTheme, screen, type WebContentsView } from 'electron';
import type { BrowserPasswordFrameProbe } from '../preload/browserPasswordFrame.js';

/** 候选弹层只接收来源和账号标签，密码由宿主在选中后读取。 */
interface BrowserPasswordPickerOptions {
  parent: BrowserWindow;
  view: WebContentsView;
  anchor: BrowserPasswordFrameProbe['anchor'];
  /** 输入框触发的候选须保留网页焦点，工具栏入口支持键盘选账号。 */
  automatic: boolean;
  /** 复用打包后的沙箱 preload，仅开启本地弹层的选择接口。 */
  preloadPath: string;
  /** 展示文字由宿主根据语言和已识别的登录字段提供。 */
  title: string;
  origin: string;
  labels: string[];
  emptyLabel: string;
  closeLabel: string;
  language: 'zh-CN' | 'en-US';
  signal: AbortSignal;
}

/** 在网页内容之上选账号，关闭、换页或失焦时返回空选择。 */
export function showBrowserPasswordPicker(options: BrowserPasswordPickerOptions): Promise<number | null> {
  /** 窗口与嵌入视图的边界使用设备无关像素，表单坐标还需乘网页缩放比例。 */
  const { parent, view, signal, automatic } = options;
  const page = view.webContents;
  if (parent.isDestroyed() || !parent.isFocused() || page.isDestroyed() || signal.aborted) return Promise.resolve(null);
  const content = parent.getContentBounds();
  const viewport = view.getBounds();
  const zoom = page.getZoomFactor();
  /** 关闭已聚焦的弹层后，把键盘交回打开它的工作面。 */
  const shell = parent.webContents;
  const previousFocus = page.isFocused() ? page : shell;
  const viewX = content.x + viewport.x;
  const viewY = content.y + viewport.y;
  /** 工具栏主动打开且没有可见登录框时，弹层靠近右侧工具栏。 */
  const anchor = options.anchor;
  const anchorX = viewX + (anchor ? Math.round(anchor.x * zoom) : viewport.width - 1);
  const anchorY = viewY + (anchor ? Math.round((anchor.y + anchor.height) * zoom) : 8);
  const work = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY }).workArea;
  const left = Math.max(viewX, work.x);
  const right = Math.min(viewX + viewport.width, work.x + work.width);
  const top = Math.max(viewY, work.y);
  const bottom = Math.min(viewY + viewport.height, work.y + work.height);
  const width = Math.min(340, right - left);
  const height = Math.min(320, 76 + Math.max(1, options.labels.length) * 38, bottom - top);
  if (width <= 0 || height <= 0) return Promise.resolve(null);
  const x = Math.max(left, Math.min(anchorX, right - width - (anchor ? 0 : 8)));
  const below = anchorY + 6;
  const above = anchor ? viewY + Math.round(anchor.y * zoom) - height - 6 : below;
  const y = Math.max(top, Math.min(below + height <= bottom || above < top ? below : above, bottom - height));
  /** 独立的沙箱窗口在网页上方展示，网页不能读候选列表或提交选择。 */
  const picker = new BrowserWindow({
    parent,
    x,
    y,
    width,
    height,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: !automatic,
    acceptFirstMouse: true,
    skipTaskbar: true,
    title: options.title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242529' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      preload: options.preloadPath,
      additionalArguments: ['--zeus-browser-password-picker'],
    },
  });
  const contents = picker.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (event) => event.preventDefault());
  /** 页面只渲染候选标签，选择通过当前窗口的 IPC 返回。 */
  const html = browserPasswordPickerHtml(options);
  return new Promise((resolve) => {
    /** 单次选择、窗口事件或加载失败共用清理。 */
    let finished = false;
    /** 窗口或页面失去交互条件时取消选择。 */
    const close = (): void => finish(null);
    /** 点击弹层外先收起候选，原点击仍交给网页或 Zeus 工作区。 */
    const closeOnOutsideClick = (_event: unknown, input: { type: string }): void => {
      if (input.type === 'mouseDown') close();
    };
    /** 只在原弹层仍有焦点时恢复键盘焦点，点击窗口之外时保留新的焦点。 */
    const finish = (index: number | null): void => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', close);
      parent.off('move', close);
      parent.off('resize', close);
      page.off('destroyed', close);
      if (automatic) {
        parent.off('blur', close);
        page.off('before-mouse-event', closeOnOutsideClick);
        shell.off('before-mouse-event', closeOnOutsideClick);
      }
      const restoreFocus = !signal.aborted && !picker.isDestroyed() && picker.isFocused();
      if (!picker.isDestroyed()) picker.destroy();
      if (restoreFocus && !parent.isDestroyed() && !previousFocus.isDestroyed()) {
        parent.focus();
        previousFocus.focus();
      }
      resolve(index);
    };
    signal.addEventListener('abort', close, { once: true });
    parent.on('move', close);
    parent.on('resize', close);
    page.once('destroyed', close);
    if (automatic) {
      parent.once('blur', close);
      page.on('before-mouse-event', closeOnOutsideClick);
      shell.on('before-mouse-event', closeOnOutsideClick);
    }
    picker.once('blur', close);
    picker.once('closed', close);
    contents.ipc.on('zeus:browser-password-picker:choose', (event, index: unknown) => {
      if (event.senderFrame !== contents.mainFrame) return;
      if (index === null) {
        close();
      } else if (typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < options.labels.length) {
        finish(index);
      }
    });
    void picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)).then(() => {
      if (picker.isDestroyed()) return;
      if (parent.isDestroyed() || !parent.isFocused()) close();
      else if (automatic) picker.showInactive();
      else picker.show();
    }, close);
  });
}

/** 使用 DOM 文本渲染来源和用户名，候选文档不包含网络权限或账号密码。 */
function browserPasswordPickerHtml({ title, origin, labels, emptyLabel, closeLabel, language, automatic }: BrowserPasswordPickerOptions): string {
  /** 编码控制字符和标签起始符，避免用户名改变脚本结构。 */
  const data = JSON.stringify({ title, origin, labels, emptyLabel, closeLabel, automatic }).replaceAll('<', '\\u003c');
  return `<!doctype html>
<html lang="${language === 'en-US' ? 'en-US' : 'zh-CN'}">
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Zeus</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; padding: 4px; font: 13px/1.4 -apple-system, "Segoe UI", sans-serif; color: #24252a; background: #fff; }
  header { position: sticky; top: 0; display: flex; align-items: center; gap: 9px; padding: 8px 6px; border-bottom: 1px solid #e5e6e9; background: #fff; }
  header > div { flex: 1; min-width: 0; }
  header > svg { width: 17px; height: 17px; flex: 0 0 auto; color: #46669e; }
  h1 { margin: 0; font-size: 13px; font-weight: 650; }
  p { margin: 0; font-size: 12px; color: #595d65; overflow-wrap: anywhere; }
  button { color: inherit; font: inherit; cursor: pointer; border: 0; border-radius: 6px; background: transparent; }
  button:focus-visible { outline: 2px solid #6587c2; outline-offset: -2px; }
  button:hover, button:focus-visible { background: #eef3fb; }
  #close { flex: 0 0 28px; height: 28px; padding: 0; font-size: 18px; }
  #accounts { padding-top: 4px; }
  .account { display: block; width: 100%; min-height: 38px; padding: 6px 10px; text-align: start; overflow-wrap: anywhere; }
  .empty { padding: 10px; }
  @media (prefers-color-scheme: dark) {
    body { color: #eff1f5; background: #242529; }
    header { border-color: #373941; background: #242529; }
    header > svg { color: #a7bde6; }
    p { color: #b5b8c0; }
    button:hover, button:focus-visible { background: #343e51; }
  }
</style>
<main role="dialog" aria-labelledby="title" aria-describedby="origin">
<header>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M14 15a5.5 5.5 0 1 0-5-5.5L2.5 16v5.5H8v-3h3v-3z" /><circle cx="16.5" cy="7.5" r="1" /></svg>
  <div><h1 id="title"></h1><p id="origin"></p></div>
  <button id="close" type="button">×</button>
</header>
<div id="accounts" aria-labelledby="title"></div>
</main>
<script>
  const data = ${data};
  document.getElementById('title').textContent = data.title;
  document.getElementById('origin').textContent = data.origin;
  const list = document.getElementById('accounts');
  const close = document.getElementById('close');
  close.setAttribute('aria-label', data.closeLabel);
  close.onclick = () => window.zeusPasswordPicker.choose(null);
  const choices = data.labels.map((label, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'account';
    button.textContent = label;
    button.onclick = () => window.zeusPasswordPicker.choose(index);
    list.append(button);
    return button;
  });
  if (choices.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = data.emptyLabel;
    list.append(empty);
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close.click();
    } else if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const current = choices.indexOf(document.activeElement);
      const next = current < 0 ? 0 : Math.max(0, Math.min(choices.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      choices[next].focus();
    }
  });
  if (!data.automatic) (choices[0] || close).focus();
</script>
</html>`;
}
