/** 当前弹出页的状态与权限操作控件。 */
const status = document.getElementById('status');
/** 当前站点授权按钮。 */
const site = document.getElementById('site');
/** 高级权限按钮。 */
const advanced = document.getElementById('advanced');
/** 当前可授权的网站；浏览器内部页面保持不可授权。 */
let origin = null;
/** 未收到 Zeus 设置前默认使用中文。 */
let language = 'zh-CN';
/** 复用桌面语言，权限状态与浏览器返回结果一致。 */
const text = (zh, en) => (language === 'en-US' ? en : zh);
/** 先读取语言，再检查站点，避免先展示另一种语言的结果。 */
async function initialize() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'zeus-ui-language' });
    language = result?.language === 'en-US' ? 'en-US' : 'zh-CN';
  } catch {
    /* 扩展尚未连接时沿用中文。 */
  }
  document.documentElement.lang = language;
  site.textContent = text('允许当前站点', 'Allow this site');
  advanced.textContent = text('允许高级访问', 'Allow advanced access');
  document.querySelector('.note').textContent = text(
    '高级访问包含书签、历史记录、下载、剪贴板和网页调试。提交内容或登录等操作仍需在 Zeus 中确认。',
    'Advanced access includes bookmarks, history, downloads, the clipboard, and browser debugging. Submitting content and signing in still require confirmation in Zeus.',
  );
  status.textContent = text('正在检查当前站点权限…', 'Checking site access…');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url);
    if (['http:', 'https:'].includes(url.protocol)) origin = `${url.origin}/*`;
  } catch {
    origin = null;
  }
  if (!origin) {
    status.textContent = text('此页面不支持站点授权，请打开普通网站后再使用。', 'This page does not support site access. Open a regular website first.');
    site.disabled = true;
    return;
  }
  try {
    const allowed = await chrome.permissions.contains({ origins: [origin] });
    status.textContent = allowed ? text('Zeus 可以访问当前站点。', 'Zeus can access this site.') : text('尚未允许 Zeus 访问当前站点。', 'Zeus does not have access to this site yet.');
  } catch {
    status.textContent = text('浏览器未能返回站点权限状态，请重新打开此面板。', 'The browser could not return the site permission state. Reopen this panel.');
  }
}
void initialize();
site.addEventListener('click', async () => {
  if (!origin) return;
  try {
    const allowed = await chrome.permissions.request({ origins: [origin] });
    status.textContent = allowed ? text('已允许访问当前站点。', 'Site access is allowed.') : text('未获得当前站点的访问权限。', 'Site access was not granted.');
  } catch {
    status.textContent = text('浏览器未能完成授权，请检查浏览器中的权限提示。', 'The browser could not complete authorization. Check its permission prompt.');
  }
});
advanced.addEventListener('click', async () => {
  try {
    const allowed = await chrome.permissions.request({ permissions: ['bookmarks', 'history', 'downloads', 'clipboardRead', 'clipboardWrite', 'debugger'] });
    status.textContent = allowed ? text('已允许高级访问。', 'Advanced access is allowed.') : text('部分高级权限未获允许，对应功能暂时不可用。', 'Some advanced permissions were not granted. Their features are unavailable.');
  } catch {
    status.textContent = text('浏览器未能完成授权，请检查浏览器中的权限提示。', 'The browser could not complete authorization. Check its permission prompt.');
  }
});
