/** 此入口直接复制为浏览器脚本，保留 JavaScript 语法，不依赖桌面 React。 */
const status = document.getElementById('status');
/** 当前站点授权按钮。 */
const site = document.getElementById('site');
/** 高级权限按钮。 */
const advanced = document.getElementById('advanced');
/** 状态身份独立于语言读取，迟到语言只翻译当前结果。 */
const messages = {
  checking: ['正在检查当前站点权限…', 'Checking site access…'],
  unsupported: ['此页面不支持站点授权，请打开普通网站后再使用。', 'This page does not support site access. Open a regular website first.'],
  siteAllowed: ['Zeus 可以访问当前站点。', 'Zeus can access this site.'],
  siteMissing: ['尚未允许 Zeus 访问当前站点。', 'Zeus does not have access to this site yet.'],
  checkFailed: ['浏览器未能返回站点权限状态，请重新打开此面板。', 'The browser could not return the site permission state. Reopen this panel.'],
  requesting: ['请在浏览器中确认授权…', 'Confirm access in the browser…'],
  siteGranted: ['已允许访问当前站点。', 'Site access is allowed.'],
  siteDenied: ['未获得当前站点的访问权限。', 'Site access was not granted.'],
  advancedGranted: ['已允许高级访问。', 'Advanced access is allowed.'],
  advancedDenied: ['部分高级权限未获允许，对应功能暂时不可用。', 'Some advanced permissions were not granted. Their features are unavailable.'],
  requestFailed: ['浏览器未能完成授权，请检查浏览器中的权限提示。', 'The browser could not complete authorization. Check its permission prompt.'],
};
/** 浏览器内部页面保持不可授权。 */
let origin = null;
/** 语言读取失败或尚未返回时，权限操作仍可使用。 */
let language = 'zh-CN';
/** 仅初始站点检查能替换 checking，不能覆盖用户刚完成的授权。 */
let statusKey = 'checking';
/** 站点查询完成前只阻止站点授权，高级授权不依赖该查询。 */
let siteReady = false;
/** 浏览器一次只处理一个权限确认，重复点击不再打开第二次请求。 */
let pendingButton = null;
/** 文案跟随桌面语言，不等待语言接口才能响应。 */
const text = (zh, en) => (language === 'en-US' ? en : zh);

/** 更新现有节点而不替换控件，保留键盘焦点及当前授权结果。 */
function render() {
  document.documentElement.lang = language;
  status.textContent = messages[statusKey][language === 'en-US' ? 1 : 0];
  site.textContent = pendingButton === site ? text('正在授权…', 'Requesting…') : text('允许当前站点', 'Allow this site');
  advanced.textContent = pendingButton === advanced ? text('正在授权…', 'Requesting…') : text('允许高级访问', 'Allow advanced access');
  site.disabled = Boolean(pendingButton) || !origin || !siteReady;
  advanced.disabled = Boolean(pendingButton);
  site.setAttribute('aria-busy', String(pendingButton === site || !siteReady));
  advanced.setAttribute('aria-busy', String(pendingButton === advanced));
  document.querySelector('.note').textContent = text(
    '高级访问包含书签、历史记录、下载、剪贴板和网页调试。提交内容或登录等操作仍需在 Zeus 中确认。',
    'Advanced access includes bookmarks, history, downloads, the clipboard, and browser debugging. Submitting content and signing in still require confirmation in Zeus.',
  );
}

/** 语言属于后台展示数据，不串行阻塞站点权限读取。 */
async function loadLanguage() {
  try {
    const result = await chrome.runtime.sendMessage({ type: 'zeus-ui-language' });
    language = result?.language === 'en-US' ? 'en-US' : 'zh-CN';
    render();
  } catch {
    /* 断开 Zeus 时继续使用当前语言，浏览器权限仍由浏览器确认。 */
  }
}

/** 每次打开都核对实际权限，不把旧的授权状态当成当前事实。 */
async function initializeSite() {
  let nextStatus = 'checkFailed';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = new URL(tab?.url);
    if (['http:', 'https:'].includes(url.protocol)) origin = `${url.origin}/*`;
    if (origin) nextStatus = (await chrome.permissions.contains({ origins: [origin] })) ? 'siteAllowed' : 'siteMissing';
    else nextStatus = 'unsupported';
  } catch {
    if (!origin) nextStatus = 'unsupported';
  } finally {
    siteReady = true;
    if (statusKey === 'checking') statusKey = nextStatus;
    render();
  }
}

/** 在原始点击调用栈内直接申请权限，不在浏览器用户手势前等待其他接口。 */
async function requestPermission(button, permissions, granted, denied) {
  if (pendingButton) return;
  pendingButton = button;
  statusKey = 'requesting';
  render();
  try {
    statusKey = (await chrome.permissions.request(permissions)) ? granted : denied;
  } catch {
    statusKey = 'requestFailed';
  } finally {
    pendingButton = null;
    render();
  }
}

site.addEventListener('click', () => origin && requestPermission(site, { origins: [origin] }, 'siteGranted', 'siteDenied'));
advanced.addEventListener('click', () => requestPermission(advanced, { permissions: ['bookmarks', 'history', 'downloads', 'clipboardRead', 'clipboardWrite', 'debugger'] }, 'advancedGranted', 'advancedDenied'));
render();
void loadLanguage();
void initializeSite();
