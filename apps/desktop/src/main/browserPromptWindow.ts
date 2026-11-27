import { BrowserWindow, nativeTheme, screen, type Rectangle, type WebContents } from 'electron';
import type { ZeusBrowserApprovalDecision } from '@zeus/shared';

/** 弹层使用应用提供的本地文档和沙箱，网页不能访问弹层内容或代选。 */
export function createBrowserPromptWindow(parent: BrowserWindow, bounds: Rectangle, title: string, preloadPath: string, focusable: boolean): BrowserWindow {
  /** 子窗口保留局部覆盖，网页可继续接收窗口其余区域的输入。 */
  const popup = new BrowserWindow({
    parent,
    ...bounds,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable,
    acceptFirstMouse: true,
    skipTaskbar: true,
    title,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#242529' : '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
      preload: preloadPath,
      additionalArguments: ['--zeus-browser-prompt'],
    },
  });
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', (event) => event.preventDefault());
  return popup;
}

/** 地址栏入口和网页占位使用同一组窗口坐标，弹层始终贴在网页范围内。 */
export function browserPermissionPromptBounds(parent: BrowserWindow, viewport: Rectangle, anchor: Rectangle): Rectangle | null {
  const content = parent.getContentBounds();
  /** DIP 坐标中的地址栏右边缘和底边。 */
  const anchorX = content.x + Math.min(anchor.x + anchor.width, content.width);
  const anchorY = content.y + Math.min(anchor.y + anchor.height, content.height);
  const work = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY }).workArea;
  const left = Math.max(content.x + viewport.x, work.x);
  const top = Math.max(content.y + viewport.y, work.y);
  const right = Math.min(content.x + viewport.x + viewport.width, content.x + content.width, work.x + work.width);
  const bottom = Math.min(content.y + viewport.y + viewport.height, content.y + content.height, work.y + work.height);
  const width = Math.min(314, right - left);
  const height = Math.min(136, bottom - top);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.max(left, Math.min(anchorX - width, right - width)), y: Math.max(top, Math.min(anchorY + 4, bottom - height)), width, height };
}

/** 网页权限弹层只接收可展示的来源、标题和当前请求的决定回调。 */
interface BrowserPermissionPromptOptions {
  parent: BrowserWindow;
  page: WebContents;
  bounds: Rectangle;
  preloadPath: string;
  title: string;
  origin: string;
  permission: string;
  language: 'zh-CN' | 'en-US';
  /** 通过地址栏主动展开时接管键盘焦点。 */
  focus: boolean;
  onDecision: (decision: ZeusBrowserApprovalDecision) => void;
}

/** 选择或关闭只回应当前请求；后台窗口可展示弹层而不获得焦点。 */
export function showBrowserPermissionPrompt(options: BrowserPermissionPromptOptions): BrowserWindow {
  const { parent, page, bounds, preloadPath, title, origin, permission, language, focus, onDecision } = options;
  const popup = createBrowserPromptWindow(parent, bounds, title, preloadPath, true);
  /** 关闭后还原网页或应用工具栏原有的键盘焦点。 */
  const previousFocus = page.isFocused() ? page : parent.webContents;
  /** 关闭和选择共用一次决定，避免销毁窗口时重复提交。 */
  let finished = false;
  /** 标题栏的关闭和 Esc 都按拒绝处理，程序移除窗口由请求宿主收尾。 */
  const finish = (decision: ZeusBrowserApprovalDecision): void => {
    if (finished || popup.isDestroyed()) return;
    finished = true;
    const restoreFocus = popup.isFocused();
    onDecision(decision);
    popup.destroy();
    if (restoreFocus && !parent.isDestroyed() && !previousFocus.isDestroyed()) {
      parent.focus();
      previousFocus.focus();
    }
  };
  popup.once('blur', () => finish('deny'));
  popup.on('close', (event) => {
    event.preventDefault();
    finish('deny');
  });
  popup.webContents.ipc.on('zeus:browser-prompt:choose', (event, index: unknown) => {
    if (event.senderFrame !== popup.webContents.mainFrame || (index !== null && index !== 0 && index !== 1)) return;
    finish(index === 1 ? 'allow_once' : 'deny');
  });
  void popup.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(browserPermissionPromptHtml({ title, origin, permission, language }))).then(
    () => {
      if (popup.isDestroyed()) return;
      if (parent.isDestroyed() || page.isDestroyed() || !parent.isVisible()) popup.destroy();
      else if (parent.isFocused() && (focus || page.isFocused())) popup.show();
      else popup.showInactive();
    },
    () => finish('deny'),
  );
  return popup;
}

/** 用文本节点展示网站来源和权限名称，页面脚本只能返回按钮序号。 */
function browserPermissionPromptHtml({ title, origin, permission, language }: Pick<BrowserPermissionPromptOptions, 'title' | 'origin' | 'permission' | 'language'>): string {
  const zh = language === 'zh-CN';
  const data = JSON.stringify({
    title,
    origin,
    close: zh ? '关闭权限请求' : 'Close permission request',
    deny: zh ? '拒绝' : 'Deny',
    allow: zh ? '允许一次' : 'Allow once',
  }).replaceAll('<', '\\u003c');
  /** 通知与其他网页权限各使用自己的图标。 */
  const icon = permission === 'notifications' ? '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>' : '<path d="M12 22c4.4-2.2 7-5.8 7-10V5l-7-3-7 3v7c0 4.2 2.6 7.8 7 10Z"/>';
  return `<!doctype html>
<html lang="${language}">
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<title>Zeus</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; padding: 14px; font: 13px/1.45 -apple-system, "Segoe UI", sans-serif; color: #24252a; background: #fff; }
header, footer { display: flex; gap: 8px; }
header { align-items: flex-start; gap: 10px; }
header > div { flex: 1; min-width: 0; }
header > svg { flex: 0 0 32px; height: 32px; padding: 7px; border-radius: 8px; color: #2c5cae; background: #ebf1fd; }
h1 { margin: 0 0 3px; font-size: 15px; font-weight: 650; overflow-wrap: anywhere; }
p { margin: 0; font-size: 12px; color: #5b6473; overflow-wrap: anywhere; }
footer { justify-content: flex-end; flex-wrap: wrap; margin-top: 14px; }
button { min-height: 30px; padding: 4px 10px; color: inherit; background: transparent; font: inherit; border: 1px solid #dce0e6; border-radius: 7px; cursor: pointer; }
button:hover { background: #eef3fb; }
button:focus-visible { outline: 2px solid #587cc0; outline-offset: 2px; }
#close { flex: 0 0 24px; min-height: 24px; padding: 0; border-color: transparent; font-size: 16px; line-height: 1; }
@media (prefers-color-scheme: dark) {
  body { color: #eff1f5; background: #242529; }
  header > svg { color: #a7bde6; background: #343e51; }
  p { color: #b5b8c0; }
  button { border-color: #454850; }
  button:hover { background: #343e51; }
}
</style>
<main role="dialog" aria-labelledby="title" aria-describedby="origin">
<header>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>
  <div><h1 id="title"></h1><p id="origin"></p></div>
  <button id="close" type="button">×</button>
</header>
<footer><button id="deny" type="button"></button><button id="allow" type="button"></button></footer>
</main>
<script>
  const data = ${data};
  document.getElementById('title').textContent = data.title;
  document.getElementById('origin').textContent = data.origin;
  const close = document.getElementById('close');
  close.setAttribute('aria-label', data.close);
  close.onclick = () => window.zeusBrowserPrompt.choose(null);
  const deny = document.getElementById('deny');
  deny.textContent = data.deny;
  deny.onclick = () => window.zeusBrowserPrompt.choose(0);
  const allow = document.getElementById('allow');
  allow.textContent = data.allow;
  allow.onclick = () => window.zeusBrowserPrompt.choose(1);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close.click();
    }
  });
</script>
</html>`;
}
