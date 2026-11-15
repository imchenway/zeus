/* global window, document */
/** 使用已安装 Playwright 对真实组件做隔离验收；ACCEPTANCE_URL 指向本任务的正式构建页面。 */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
// 复用本机已安装的验收工具，不向项目增加依赖或自动安装浏览器。
const playwrightDirectory = dirname(realpathSync(execFileSync('which', ['playwright'], { encoding: 'utf8' }).trim()));
const { chromium } = createRequire(import.meta.url)(playwrightDirectory);
await mkdir('/tmp/zeus1066-review', { recursive: true });
const target = new URL(process.env.ACCEPTANCE_URL ?? 'http://127.0.0.1:4190/qa/conversation-switch-acceptance.html');
if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw Error('仅允许本任务本机验收页面');
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript(() => {
  window.clickPaints = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries())
      if (e.name === 'click' && e.target?.closest('[data-select]'))
        window.clickPaints.push({ id: e.target.closest('[data-select]').dataset.select, duration: e.duration, processing: e.processingEnd - e.processingStart, start: e.startTime, interactionId: e.interactionId });
  }).observe({ type: 'event', buffered: true, durationThreshold: 16 });
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.goto(target.href);
  await page.waitForSelector('.session-transcript-shell[data-history-ready=true]');
  if ((await page.evaluate(() => document.visibilityState)) !== 'visible') throw Error('页面不可见，拒绝首帧采样');
  await page.evaluate(() => document.fonts.ready);
  const select = async (id) => {
    const count = await page.evaluate(() => window.acceptance.report().performance.samples.filter((x) => x.kind === 'conversation_first_frame').length);
    await page.locator(`[data-select="${id}"]`).click();
    await page.waitForFunction((n) => window.acceptance.report().performance.samples.filter((x) => x.kind === 'conversation_first_frame').length > n, count, { timeout: 3000 });
    await page.evaluate((id) => window.acceptance.verifyDisplay(id), id);
  };
  for (const id of ['B', 'C', 'A']) await select(id);
  for (let i = 0; i < 30; i++) await select('BCA'[i % 3]);
  const report = await page.evaluate(() => ({ ...window.acceptance.report(), clickPaints: window.clickPaints }));
  const warm = report.checks.filter((x) => x.warm);
  if (!warm.every((x) => x.sameNode && x.visibleAfterFrame)) throw Error('热切换重建节点或隐藏正文');
  await page.screenshot({ path: '/tmp/zeus1066-review/switch-visible.png' });
  const editor = page.locator('[data-case="A"] [contenteditable="true"]');
  await editor.fill('保留这条验收草稿');
  await page.waitForFunction(() => window.acceptance.states.A.draft === '保留这条验收草稿');
  const scroller = page.locator('[data-case="A"] .session-transcript');
  await scroller.hover();
  await page.mouse.wheel(0, -600);
  await page.waitForFunction(() => {
    const n = document.querySelector('[data-case="A"] .session-transcript');
    return n.scrollTop < n.scrollHeight - n.clientHeight - 300;
  });
  const before = await scroller.evaluate((n) => n.scrollTop);
  await select('B');
  await select('A');
  const after = await scroller.evaluate((n) => n.scrollTop);
  if (Math.abs(after - before) > 2) throw Error(`阅读位置变化：${before} -> ${after}`);
  if ((await editor.innerText()) !== '保留这条验收草稿') throw Error('草稿未保留');
  await editor.fill('恢复后仍可编辑');
  await page.waitForFunction(() => window.acceptance.states.A.draft === '恢复后仍可编辑');
  await page.screenshot({ path: '/tmp/zeus1066-review/reading-restored.png' });
  await page.setViewportSize({ width: 760, height: 800 });
  await page.screenshot({ path: '/tmp/zeus1066-review/narrow.png' });
  for (const id of ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O']) {
    await page.evaluate((id) => window.acceptance.addCase(id), id);
    await select(id);
  }
  const retained = await page.locator('.acceptance-case').count();
  if (retained !== 12) throw Error(`保留页面数不正确：${retained}`);
  const released = await page.evaluate(() => window.acceptance.calls.filter((x) => x.id === 'A').at(-1)?.aborted);
  if (!released) throw Error('淘汰后没有取消控制器读取');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-details-toggle]').click();
  await page.waitForFunction(() => Math.abs(document.querySelector('#acceptance-details').getBoundingClientRect().height - 80) < 1);
  await page.locator('[data-details-grow]').click();
  await page.waitForFunction(() => Math.abs(document.querySelector('#acceptance-details').getBoundingClientRect().height - 160) < 1);
  await page.locator('[data-details-toggle]').click();
  if (!(await page.locator('#acceptance-details').evaluate((n) => n.inert && n.getAttribute('aria-hidden') === 'true'))) throw Error('收起内容仍可交互');
  await page.waitForFunction(() => document.querySelector('#acceptance-details').getBoundingClientRect().height === 0);
  await page.locator('[data-details-toggle]').click();
  await page.waitForFunction(() => Math.abs(document.querySelector('#acceptance-details').getBoundingClientRect().height - 160) < 1);
  const frames = report.performance.samples.filter((x) => x.kind === 'conversation_first_frame');
  const warmTimes = frames
    .filter((s, i) => report.checks[i]?.warm)
    .map((s) => s.durationMs)
    .sort((a, b) => a - b);
  const warmLatency = { count: warmTimes.length, p50Ms: warmTimes[Math.floor(warmTimes.length * 0.5)], p95Ms: warmTimes[Math.floor(warmTimes.length * 0.95)], maxMs: warmTimes.at(-1) };
  const nativeTimes = report.checks
    .map((check, index) => ({ check, event: report.clickPaints?.find((e) => e.id === check.id && e.start > (report.checks[index - 1]?.startedAt ?? 0) && e.start <= check.startedAt) }))
    .filter((x) => x.check.warm);
  const nativeDurations = nativeTimes.map((x) => x.event?.duration ?? 16).sort((a, b) => a - b);
  const clickToNextPaint = {
    count: nativeTimes.length,
    recordedCount: nativeTimes.filter((x) => x.event).length,
    p50Ms: nativeDurations[Math.floor(nativeDurations.length * 0.5)],
    p95Ms: nativeDurations[Math.floor(nativeDurations.length * 0.95)],
    maxMs: nativeDurations.at(-1),
    resolutionMs: 8,
  };
  const performanceTarget = { confirmationP95BudgetMs: 50, passed: warmLatency.p95Ms <= 50 };
  const final = {
    ...report,
    warmLatency,
    clickToNextPaint,
    performanceTarget,
    checksSummary: {
      warmCount: warm.length,
      domRetained: true,
      bodyVisible: true,
      draftPreserved: true,
      editingWorksAfterRestore: true,
      reading: { before, after },
      retainedPages: retained,
      evictedControllerReleased: released,
      collapseExpandAndResize: true,
    },
    environment: {
      kind: 'isolated Chromium component fixture',
      browser: browser.version(),
      viewport: '1440x900',
      visibility: 'visible',
      renderer: process.env.ACCEPTANCE_RENDERER ?? 'development',
      note: 'Deliberately pending read APIs; not native Electron or real database acceptance',
    },
    pageErrors: errors,
  };
  await writeFile('/tmp/zeus1066-review/acceptance-result.json', JSON.stringify(final, null, 2));
  console.log(JSON.stringify({ latency: report.performance.conversationNavigationLatency, warmLatency, clickToNextPaint, performanceTarget, checks: final.checksSummary, pageErrors: errors }));
  if (!performanceTarget.passed) process.exitCode = 1;
} catch (e) {
  await page.screenshot({ path: '/tmp/zeus1066-review/failed.png' });
  await writeFile('/tmp/zeus1066-review/acceptance-failure.json', JSON.stringify({ error: String(e), errors, report: await page.evaluate(() => window.acceptance?.report()) }, null, 2));
  throw e;
} finally {
  await browser.close();
}
