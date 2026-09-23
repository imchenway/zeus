/** 临时验收探针：用 Electron 窗口加载 QA 页面，输出布局几何并截图。 */
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { setTimeout } from 'node:timers';

/** 目标地址、截图输出路径和窗口宽度由命令行传入。 */
const targetUrl = process.argv[2];
const outputPath = process.argv[3];
const width = Number(process.argv[4] ?? 1440);

/** 读取关键元素的盒模型，用于判断按钮是否与正文同行。 */
const measureScript = `(() => {
  const box = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height), bottom: Math.round(rect.bottom) };
  };
  const pill = document.querySelector('section[aria-label="消息发送状态"]') || document.querySelector('.session-turn-failure');
  const message = pill ? pill.querySelector('.session-turn-failure-message') : null;
  const error = pill ? pill.querySelector('.session-message-delivery-error') : null;
  const details = pill ? pill.querySelector('.application-error-details-link') : null;
  const actions = pill ? pill.querySelector('.session-message-delivery-actions') : null;
  const button = actions ? actions.querySelector('button') : null;
  const footer = document.querySelector('.session-queued-thread-footer');
  const state = footer ? footer.querySelector('.session-item-state') : null;
  const deleteButton = footer ? footer.querySelector('.session-queued-thread-delete') : null;
  const centerY = (element) => {
    const rect = element.getBoundingClientRect();
    return (rect.top + rect.bottom) / 2;
  };
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pill: box(pill),
    messageColumns: message ? getComputedStyle(message).gridTemplateColumns : null,
    error: box(error),
    errorText: error ? error.textContent : null,
    details: box(details),
    actions: box(actions),
    button: box(button),
    buttonText: button ? button.textContent : null,
    buttonSameRowAsError: Boolean(button && error) && Math.abs(centerY(button) - centerY(error)) < 6,
    footer: box(footer),
    state: box(state),
    stateText: state ? state.textContent : null,
    deleteButton: box(deleteButton)
  };
})()`;

/** 等待页面挂载 QA 组件，避免读到空壳。 */
async function waitForContent(win) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.session-transcript, .session-turn-failure'))`);
    if (ready) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** 带超时的等待，避免加载挂起时整个探针卡住。 */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))]);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  console.log('[probe] loading', targetUrl);
  console.log('[probe] load result', await withTimeout(win.loadURL(targetUrl), 20000));
  console.log('[probe] content ready', await waitForContent(win));
  const measurement = await win.webContents.executeJavaScript(measureScript);
  console.log(JSON.stringify(measurement, null, 2));
  const image = await withTimeout(win.webContents.capturePage(), 15000);
  if (image && image.toPNG) fs.writeFileSync(outputPath, image.toPNG());
  console.log('[probe] wrote', outputPath, image && image.toPNG ? image.toPNG().length : 0);
  app.exit(0);
});
