const status = document.getElementById('status');
const site = document.getElementById('site');
const advanced = document.getElementById('advanced');
let origin = null;
void chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
  try {
    const url = new URL(tab.url);
    if (['http:', 'https:'].includes(url.protocol)) origin = `${url.origin}/*`;
  } catch {
    origin = null;
  }
  if (!origin) {
    status.textContent = '当前页面不支持站点授权。';
    site.disabled = true;
    return;
  }
  const allowed = await chrome.permissions.contains({ origins: [origin] });
  status.textContent = allowed ? 'Zeus 已获当前站点访问权限。' : '当前站点尚未授权。';
});
site.addEventListener('click', async () => {
  if (!origin) return;
  const allowed = await chrome.permissions.request({ origins: [origin] });
  status.textContent = allowed ? '当前站点已授权。' : '用户拒绝了当前站点权限。';
});
advanced.addEventListener('click', async () => {
  const allowed = await chrome.permissions.request({ permissions: ['bookmarks', 'history', 'downloads', 'clipboardRead', 'clipboardWrite', 'debugger'] });
  status.textContent = allowed ? '可选高级权限已授权。' : '一个或多个高级权限未授权。';
});
