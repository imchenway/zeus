/* global process, console, fetch, WebSocket, setTimeout, clearTimeout, Buffer, performance */
import { resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';

/** 仅连接显式提供的当前任务 development 主进程，不启动替代应用。 */
const { values } = parseArgs({
  options: {
    pid: { type: 'string' },
    port: { type: 'string' },
    'data-root': { type: 'string' },
    'display-id': { type: 'string' },
    'show-cursor': { type: 'boolean' },
    'user-priority': { type: 'boolean' },
    'packaged-app': { type: 'string' },
    performance: { type: 'boolean' },
    'system-stop': { type: 'boolean' },
    'single-display': { type: 'boolean' },
  },
});
/** 所有路径及进程身份必须来自本工作树。 */
const expected = {
  pid: Number(values.pid),
  port: Number(values.port),
  dataRoot: resolve(values['data-root'] ?? '.tmp/electron-development-data'),
  appRoot: values['packaged-app'] ? resolve(values['packaged-app'], 'Contents/Resources/app.asar') : resolve('apps/desktop'),
  hostBundleId: values['packaged-app'] ? 'dev.hypha.zeus.test' : 'com.github.Electron',
  displayId: Number(values['display-id']),
  showCursor: values['show-cursor'] === true,
  userPriority: values['user-priority'] === true,
  performance: values.performance === true,
  systemStop: values['system-stop'] === true,
  /** 仅在用户明确变更副屏验收约束后，由本次编排显式传入。 */
  singleDisplay: values['single-display'] === true,
};
if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0 || !Number.isSafeInteger(expected.port) || expected.port <= 0 || !Number.isSafeInteger(expected.displayId) || !expected.dataRoot.startsWith(`${resolve('.tmp')}/`))
  throw new Error('必须指定本任务 --pid、--port、--display-id 和 .tmp 下的 --data-root。');
if (values['packaged-app'] && (!resolve(values['packaged-app']).startsWith(`${resolve('.tmp')}/`) || !resolve(values['packaged-app']).endsWith('/Zeus Test.app')))
  throw new Error('打包运行只接受当前工作树 .tmp 中正常构建的 Zeus Test.app。');
/** 调试端口必须实际属于该主进程，不能只按端口猜测。 */
const run = promisify(execFile);
if ((await run('/usr/sbin/lsof', ['-a', '-p', String(expected.pid), '-nP', `-iTCP:${expected.port}`, '-sTCP:LISTEN', '-t'])).stdout.trim() !== String(expected.pid)) throw new Error('调试端口进程身份不符。');
/** 只接受本机 Inspector 返回的主进程调试端点。 */
const endpoints = await fetch(`http://127.0.0.1:${expected.port}/json/list`).then((response) => response.json());
/** 探针连接结束时关闭，不留下调试附着。 */
const socket = new WebSocket(endpoints[0].webSocketDebuggerUrl);

/** 在真实 Electron 主进程、系统窗口和私有原生 worker 上验证完整调用链。 */
async function verifyInElectron(expected) {
  /** 载入当前应用实际依赖及已正常构建的宿主源码。 */
  const { createRequire } = await import('node:module');
  /** 验收不读取或覆盖生产配置。 */
  const fs = await import('node:fs/promises');
  /** 当前进程的原生 Electron 模块。 */
  const electron = createRequire(`${expected.appRoot}/package.json`)('electron');
  /** 断言失败即保留错误，不改用前台输入或伪造结果。 */
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  assert(process.type === 'browser' && process.pid === expected.pid && electron.app?.getAppPath() === expected.appRoot, '源码主界面进程身份不符');
  assert(electron.app.getPath('userData') === `${expected.dataRoot}/profile/electron`, '隔离数据根不符');
  /** 首窗必须真实位于指定验收屏，操作开始前由用户切回工作应用。 */
  const window = electron.BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
  assert(window && !window.isFocused() && electron.screen.getDisplayMatching(window.getBounds()).id === expected.displayId, '验收窗口未在指定屏幕后台就绪');
  if (!expected.singleDisplay) assert(electron.screen.getDisplayNearestPoint(electron.screen.getCursorScreenPoint()).id !== expected.displayId, '用户正在验收屏工作，停止本次操作');
  /** 宿主配置仅供本探针，不改主应用开关。 */
  const statePath = `${expected.dataRoot}/computer-runtime-probe.json`;
  await fs.writeFile(statePath, JSON.stringify({ enabled: true }));
  /** 正常磁盘构建产物中的真实宿主。 */
  const { ComputerHost } = await import(`file://${expected.appRoot}/dist/main/computerHost.js?computer-runtime-probe=${Date.now()}`);
  /** 独立轮次仅占用本任务应用的真实窗口。 */
  const host = new ComputerHost({
    statePath,
    hostBundleId: expected.hostBundleId,
    mainCommandLedger: () => {
      throw new Error('探针不应修改设置');
    },
  });
  /** 动作入口沿用正常产品轮次协议。 */
  const call = (tool, args, turnId = 'runtime-owner') => host.invoke({ namespace: 'zeus_computer', tool, arguments: args, conversationId: 'computer-runtime-probe', threadId: 'native', turnId });
  /** 只提取文本结果，不把图片或应用清单回传日志。 */
  const textOf = (result) =>
    result.contentItems
      .filter((item) => item.type === 'inputText')
      .map((item) => item.text)
      .join('\n');
  /** 验收记录来自实际返回和断言。 */
  const checks = [];
  /** 每个创建过的原生 worker 都记录精确 PID，便于清理复核。 */
  const workerPids = [];
  /** 现场条件未满足的检查不能标为已通过。 */
  const remainingChecks = [];
  /** 实际延迟、传图字节和原生进程资源单独记录，不能用静态检查替代。 */
  const performanceResults = {};
  try {
    /** 模块异步加载期间全局停止，不能在停止之后初始化无所属轮次的 SDK。 */
    const discoveryStartup = host.ensureDriver().then(
      () => true,
      () => false,
    );
    await host.stop('user', false);
    assert(!(await discoveryStartup) && host.driver === null && host.startingDriver === null, '全局停止后发现操作仍创建 SDK');
    checks.push('global_stop_revokes_pending_discovery_startup');
    /** 真实冷启动期间停止，主线程必须能响应而不是等待同步 FFI。 */
    const booting = call('get_window_state', { pid: expected.pid, window_id: Number(window.getMediaSourceId().split(':')[1]), include_screenshot: false }, 'startup-owner');
    const bootDeadline = Date.now() + 5000;
    while (!host.startingDriver && Date.now() < bootDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    assert(host.startingDriver, '未能观察真实 SDK 启动阶段');
    const startupSdkPid = host.startingDriver.workerParentPid;
    const startupOwner = [...host.owners.values()].find((candidate) => candidate.input.turnId === 'startup-owner');
    assert(startupOwner, '启动时没有可停止轮次');
    const startupStoppedAt = Date.now();
    await host.stopOwner(startupOwner);
    assert(Date.now() - startupStoppedAt < 2000 && !(await booting).success, '启动阶段停止没有及时撤销');
    if (startupSdkPid) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      let alive = false;
      try {
        process.kill(startupSdkPid, 0);
        alive = true;
      } catch {
        /* SDK 进程应已退出。 */
      }
      assert(!alive, '启动停止后 SDK 进程残留');
    }
    checks.push('stop_during_real_sdk_startup_is_bounded');
    /** 原生发现只限定本任务进程。 */
    const listed = await call('list_windows', { pid: expected.pid, on_screen_only: true });
    assert(listed.success, textOf(listed));
    /** 仅选正常主窗口，忽略 Electron 小型内部窗口。 */
    const nativeWindow = JSON.parse(textOf(listed)).windows.find((candidate) => candidate.bounds.width > 500 && candidate.bounds.height > 400);
    assert(nativeWindow, '未找到本任务原生主窗口');
    /** 精确窗口身份始终来自真实发现。 */
    const target = { pid: expected.pid, window_id: Number(nativeWindow.window_id ?? nativeWindow.windowId) };
    /** 首次真实截图与辅助功能读取。 */
    const observed = await call('get_window_state', { ...target, max_elements: 80, max_image_dimension: 256 });
    assert(observed.success, textOf(observed));
    assert(JSON.parse(textOf(observed)).zeus_control?.monitoring === true, '原生用户输入监听尚未就绪');
    assert(JSON.parse(textOf(observed)).zeus_control?.events_ready === true && JSON.parse(textOf(observed)).zeus_control?.sharing_active === true, '真实窗口共享或已认证事件通道尚未就绪');
    workerPids.push(host.workerPid);
    checks.push('native_observation_and_user_monitor_ready');
    /** 原生返回实际采集时间，主进程不得用工具回复时间伪装。 */
    const observedAt = JSON.parse(textOf(observed)).screenshot_captured_at_unix_ms;
    assert(Number.isSafeInteger(observedAt) && Math.abs(Date.now() - observedAt) < 10_000 && host.getPreview('computer-runtime-probe')?.capturedAt === new Date(observedAt).toISOString(), '预览没有使用真实系统帧采集时间');
    checks.push('native_frame_capture_timestamp_used_in_preview');
    /** 在真实会话创建请求已派发、回复未返回时停止，确认原生会话也被释放。 */
    const sessionOwner = host.ensureOwner({ conversationId: 'computer-runtime-probe', threadId: 'native', turnId: 'session-start-owner', tool: 'get_window_state' });
    const sessionStartup = host.ensureOwnerSession(host.driver, sessionOwner, sessionOwner.input).then(
      () => true,
      () => false,
    );
    /** 微任务只等待真实派发，不替换 Driver 或原生返回值。 */
    for (let attempt = 0; !sessionOwner.sessionDriver && attempt < 20; attempt += 1) await Promise.resolve();
    assert(sessionOwner.sessionDriver && !sessionOwner.sessionStarted, '没有捕获会话创建回复前的真实派发');
    await host.stopOwner(sessionOwner);
    assert(!(await sessionStartup) && !sessionOwner.sessionStarted, '迟到会话创建复活已停止控制');
    const sessions = await host.driver.callTool('list_sessions', JSON.stringify({ limit: 100 }));
    assert(!sessions.isError && !JSON.parse(sessions.structuredJson).sessions.some((session) => session.session === sessionOwner.id), '创建期间停止后原生会话残留');
    checks.push('stop_during_dispatched_session_start_releases_native_session');
    /** 未改变的图片读取只返回元数据。 */
    const preview = host.getPreview('computer-runtime-probe');
    assert(preview?.imageUrl && preview.imageId && preview.capturedAt, '缺少真实捕获预览');
    await fs.writeFile(`${expected.dataRoot}/../computer-window-observed.png`, Buffer.from(preview.imageUrl.split(',')[1], 'base64'));
    assert(host.getPreview('computer-runtime-probe', preview.imageId)?.imageUrl === null, '相同图片重复传输');
    /** 第二轮次必须在刷新原生 snapshot 之前拒绝占用。 */
    const busy = await call('get_window_state', { ...target, include_screenshot: false }, 'competing-owner');
    assert(!busy.success && textOf(busy).includes('ZEUS_COMPUTER_WINDOW_BUSY'), '窗口观察互斥失效');
    checks.push('window_reserved_before_native_observation');
    /** 后台输入拒绝实际经过宿主参数闸门。 */
    for (const [tool, args, code] of [
      ['click', { ...target, x: 10, y: 10, capture_id: 'probe-refusal' }, 'ZEUS_COMPUTER_BACKGROUND_FOCUS_UNSUPPORTED'],
      ['type_text', { ...target, x: 10, y: 10, text: '不得输入' }, 'ZEUS_COMPUTER_BACKGROUND_FOCUS_UNSUPPORTED'],
      ['invoke_menu', { ...target, menu_path: ['File'] }, 'ZEUS_COMPUTER_BACKGROUND_MENU_UNSUPPORTED'],
    ]) {
      const refused = await call(tool, args);
      assert(!refused.success && textOf(refused).includes(code), `${tool} 未安全拒绝：${textOf(refused)}`);
    }
    checks.push('unsafe_focus_routes_refused_before_dispatch');
    /** 重新观察使用 AX-only，不能把旧截图时间改成新时间。 */
    const semantic = await call('get_window_state', { ...target, include_screenshot: false, max_elements: 40 });
    assert(semantic.success, textOf(semantic));
    assert(host.getPreview('computer-runtime-probe')?.capturedAt === preview.capturedAt, 'AX-only 伪造新截图时间');
    checks.push('preview_incremental_image_and_capture_timestamp');
    if (expected.performance) {
      /** 多次真实调用取分位数，不把一次缓存命中当成整条链路性能。 */
      const summarize = (samples) => {
        const sorted = [...samples].sort((left, right) => left - right);
        return { samples: sorted.length, p50Ms: Math.round(sorted[Math.ceil(sorted.length * 0.5) - 1] * 10) / 10, p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10 };
      };
      for (const [name, args, count] of [
        ['axOnly40', { include_screenshot: false, max_elements: 40 }, 20],
        ['queryCreate', { include_screenshot: false, max_elements: 20, query: '创建新项目' }, 20],
        ['screenshot256', { include_accessibility_tree: false, max_image_dimension: 256 }, 10],
      ]) {
        const samples = [];
        for (let index = 0; index < count; index += 1) {
          const started = performance.now();
          const actual = await call('get_window_state', { ...target, ...args });
          assert(actual.success, textOf(actual));
          samples.push(performance.now() - started);
        }
        performanceResults[name] = summarize(samples);
      }
      /** 只读取已核对的本任务 worker 累计 CPU 时间和实际 RSS。 */
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const nativeRun = promisify(execFile);
      const resources = async () => {
        const output = (await nativeRun('/bin/ps', ['-p', String(host.workerPid), '-o', 'time=', '-o', 'rss='], { timeout: 1500 })).stdout.trim();
        const match = output.match(/^(\S+)\s+(\d+)$/u);
        assert(match, '原生资源记录格式不符');
        return {
          cpuSeconds: match[1]
            .split(':')
            .map(Number)
            .reduce((total, part) => total * 60 + part, 0),
          rssMb: Math.round((Number(match[2]) / 1024) * 10) / 10,
        };
      };
      const currentPreview = host.getPreview('computer-runtime-probe');
      performanceResults.preview = { initialBytes: Buffer.byteLength(JSON.stringify(currentPreview)), unchangedBytes: Buffer.byteLength(JSON.stringify(host.getPreview('computer-runtime-probe', currentPreview.imageId))) };
      const owner = [...host.owners.values()].find((candidate) => candidate.input.turnId === 'runtime-owner');
      const before = await resources();
      const started = performance.now();
      let moves = 0;
      let peakRssMb = before.rssMb;
      while (performance.now() - started < 8000) {
        const moved = await host.driver.callTool('move_cursor', JSON.stringify({ session: owner.id, scope: 'window', x: nativeWindow.bounds.x + 200 + (moves % 8) * 45, y: nativeWindow.bounds.y + 180 + (moves % 6) * 30 }));
        assert(!moved.isError, moved.structuredJson ?? moved.rawJson);
        moves += 1;
        if (moves % 4 === 0) peakRssMb = Math.max(peakRssMb, (await resources()).rssMb);
        await new Promise((resolveFrame) => setTimeout(resolveFrame, 35));
      }
      const after = await resources();
      const wallSeconds = (performance.now() - started) / 1000;
      performanceResults.cursor = { moves, wallSeconds: Math.round(wallSeconds * 100) / 100, cpuPercentOfCore: Math.round(((after.cpuSeconds - before.cpuSeconds) / wallSeconds) * 1000) / 10, peakRssMb, finalRssMb: after.rssMb };
      checks.push('real_observation_preview_and_cursor_performance_measured');
    }
    if (expected.showCursor) {
      /** 只移动 CUA 软件光标，不产生实体鼠标或键盘输入。 */
      const owner = [...host.owners.values()].find((candidate) => candidate.input.turnId === 'runtime-owner');
      /** 副屏中可见窗口内的真实点。 */
      const point = { x: nativeWindow.bounds.x + 320, y: nativeWindow.bounds.y + 220 };
      const moved = await host.driver.callTool('move_cursor', JSON.stringify({ session: owner.id, scope: 'window', ...point }));
      assert(!moved.isError, moved.structuredJson ?? moved.rawJson);
      await new Promise((resolveFrame) => setTimeout(resolveFrame, 250));
      /** 只截取本任务副屏内的光标区域，图像需另外目视验收。 */
      const { execFile } = await import('node:child_process');
      /** 只捕获本 worker 在目标屏的透明浮层，避免截取其他应用内容。 */
      const display = electron.screen.getAllDisplays().find((candidate) => candidate.id === expected.displayId);
      const surfaces = await host.driver.listWindows({ pid: host.workerPid, onScreenOnly: true });
      const overlay = surfaces.windows.find(
        (candidate) => candidate.bounds.x === display.bounds.x && candidate.bounds.y === display.bounds.y && candidate.bounds.width === display.bounds.width && candidate.bounds.height === display.bounds.height,
      );
      assert(overlay, '目标副屏未建立原生浮层');
      await fs.writeFile(
        `${expected.dataRoot}/../computer-cursor-window.json`,
        JSON.stringify({ ...overlay, expectedPointer: point, expectedScale: display.scaleFactor }, (_key, value) => (typeof value === 'bigint' ? String(value) : value)),
      );
      await new Promise((resolveCapture, reject) => execFile('/usr/sbin/screencapture', ['-x', '-o', `-l${overlay.windowId}`, `${expected.dataRoot}/../computer-cursor-runtime.png`], (error) => (error ? reject(error) : resolveCapture())));
      await fs.writeFile(`${expected.dataRoot}/../computer-cursor-state.json`, (await host.driver.getAgentCursorState({ session: owner.id })).structuredJson);
      checks.push('software_cursor_secondary_screen_capture_produced');
    }
    if (expected.systemStop) {
      /** 菜单栏系统共享入口可以停止共享，不对受控应用生成任何模拟点击。 */
      const sharedDriver = host.driver;
      const sharedWorkerPid = host.workerPid;
      /** 就绪凭证只记录本任务进程，实际停止操作由用户完成。 */
      await fs.writeFile(`${expected.dataRoot}/../computer-system-stop-ready.json`, JSON.stringify({ pid: expected.pid, windowId: target.window_id, workerPid: sharedWorkerPid }));
      /** 原生事件已经即时驱动宿主状态，本等待不重新观察或重开共享。 */
      const until = Date.now() + 180_000;
      while (Date.now() < until && host.getPreview('computer-runtime-probe')?.state !== 'paused') await new Promise((resolveEvent) => setTimeout(resolveEvent, 100));
      /** 状态、原因和原生实例必须同时符合真实系统停止。 */
      const event = sharedDriver.lastControlEvent;
      assert(host.getPreview('computer-runtime-probe')?.state === 'paused' && event?.reason === 'ZEUS_COMPUTER_SHARING_STOPPED' && event.workerPid === sharedWorkerPid && event.pid === target.pid, '未捕获本窗口真实系统共享停止');
      const refused = await call('press_key', { ...target, key: 'Enter' });
      assert(!refused.success && textOf(refused).includes('ZEUS_COMPUTER_SHARING_STOPPED'), '系统停止后旧轮次仍能输入');
      checks.push('system_sharing_stop_immediately_revokes_input');
      await host.endComputerUse({ conversationId: 'computer-runtime-probe', turnId: 'runtime-owner' });
      return { pid: process.pid, displayId: expected.displayId, workerPids, checks, remainingChecks, performanceResults };
    }
    if (expected.userPriority) {
      /** 真实键盘事件只统计数量，不记录字符或剪贴板。 */
      const firstState = JSON.parse(textOf(await call('get_window_state', { ...target, include_screenshot: false, max_elements: 20 }))).zeus_control;
      /** 事件保留已核对实例的诊断副本，不重新观察并重开已停止的共享。 */
      const monitoredDriver = host.driver;
      /** 原生身份固定，恢复或其他目标的事件不能替代本现场接管。 */
      const monitoredWorkerPid = host.workerPid;
      /** 先确认其他应用的输入没有让权，再等待用户主动进入受控应用。 */
      let otherApplicationContinued = false;
      let userTookControl = false;
      const until = Date.now() + 180_000;
      /** 就绪凭证仅供本任务编排，不发送到外部服务。 */
      await fs.writeFile(`${expected.dataRoot}/../computer-user-priority-ready.json`, JSON.stringify({ pid: expected.pid, windowId: target.window_id, workerPid: host.workerPid }));
      while (Date.now() < until) {
        /** 实际回调驱动的暂停状态不依赖继续调用模型工具。 */
        const event = monitoredDriver.lastControlEvent;
        if (host.getPreview('computer-runtime-probe')?.state === 'paused' && event?.workerPid === monitoredWorkerPid && event.pid === target.pid && event.reason === 'ZEUS_COMPUTER_USER_CONTROL') {
          otherApplicationContinued ||= event.otherKeyboardEvents > firstState.other_keyboard_events;
          userTookControl = true;
          break;
        }
        /** 未发生接管时才继续读；与回调交错的取消在下一次循环判定。 */
        const actual = await call('get_window_state', { ...target, include_screenshot: false, max_elements: 20 });
        if (actual.success) {
          const control = JSON.parse(textOf(actual)).zeus_control;
          if (!control.paused && control.other_keyboard_events > firstState.other_keyboard_events) otherApplicationContinued = true;
        } else assert(host.getPreview('computer-runtime-probe')?.state === 'paused', textOf(actual));
        await new Promise((resolveSample) => setTimeout(resolveSample, 200));
      }
      if (otherApplicationContinued && userTookControl) {
        const beforePid = host.workerPid;
        const refused = await call('press_key', { ...target, key: 'Enter' });
        assert(!refused.success && textOf(refused).includes('ZEUS_COMPUTER_USER_CONTROL') && host.workerPid === beforePid, '用户接管后未稳定让权');
        checks.push('other_application_keyboard_continues_and_target_user_input_pauses');
        /** 旧轮次结束后，新指令必须通过新的命名会话和观察继续。 */
        await host.endComputerUse({ conversationId: 'computer-runtime-probe', turnId: 'runtime-owner' });
        await host.endComputerUse({ conversationId: 'computer-runtime-probe', turnId: 'competing-owner' });
        const next = await call('get_window_state', { ...target, include_screenshot: false }, 'next-instruction');
        assert(next.success && !JSON.parse(textOf(next)).zeus_control.paused, '新轮次观察未解除已结束的用户接管');
        await host.endComputerUse({ conversationId: 'computer-runtime-probe', turnId: 'next-instruction' });
        return { pid: process.pid, displayId: expected.displayId, workerPids, checks, remainingChecks, performanceResults };
      }
      remainingChecks.push(otherApplicationContinued ? 'target_physical_user_takeover_not_observed' : 'other_application_physical_keyboard_not_observed');
    }
    /** 真实私有进程失联，不模拟 SDK 返回。 */
    const lostPid = host.workerPid;
    assert(Number.isSafeInteger(lostPid) && lostPid !== process.pid, '失联检查缺少精确 worker 身份');
    process.kill(lostPid, 'SIGTERM');
    const lost = await call('get_window_state', { ...target, include_screenshot: false });
    assert(!lost.success, '退出 worker 被误报成功');
    const fresh = await call('get_window_state', { ...target, include_screenshot: false, max_elements: 40 });
    assert(fresh.success && host.workerPid !== lostPid, `失联后新观察未恢复：${textOf(fresh)}`);
    workerPids.push(host.workerPid);
    checks.push('real_worker_loss_recovers_only_on_fresh_observation');
    /** 另一轮实际命名会话不能被正常停止清空。 */
    const independentOwner = [...host.owners.values()].find((candidate) => candidate.input.turnId === 'competing-owner');
    await host.ensureOwnerSession(host.driver, independentOwner, independentOwner.input);
    const retainedDriver = host.driver;
    const retainedWorkerPid = host.workerPid;
    /** 有界状态等待时通过同一个停止出口撤销，不自动重放。 */
    const waiting = call('verify_state', { ...target, expect: [{ element: { selector: { label_contains: 'zeus-probe-impossible-label' }, exists: true } }], timeout_ms: 5000 });
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    const activeOwner = [...host.owners.values()].find((candidate) => candidate.input.turnId === 'runtime-owner');
    const started = Date.now();
    await host.stopOwner(activeOwner);
    assert(Date.now() - started < 4000, '停止被原生等待挂住');
    assert(!(await waiting).success, '已停止的等待仍被误报成功');
    assert(host.driver === retainedDriver && host.workerPid === retainedWorkerPid, '正常停止错误地回收其他会话的驱动');
    assert(independentOwner.sessionStarted, '正常停止清空其他轮次');
    checks.push('stop_during_native_wait_is_bounded_and_preserves_other_sessions');
    await host.endComputerUse({ conversationId: 'computer-runtime-probe', turnId: 'competing-owner' });
    assert(host.windowOwners.size === 0 && host.getPreview('computer-runtime-probe') === null, '停止后窗口占用或预览残留');
    checks.push('session_and_window_ownership_released');
    return { pid: process.pid, displayId: expected.displayId, workerPids, checks, remainingChecks, performanceResults };
  } finally {
    await host.close();
    await fs.unlink(statePath);
  }
}

await new Promise((resolveOpen, reject) => {
  socket.addEventListener('open', resolveOpen, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
/** 单次调试请求有界等待，迟到响应不重新触发动作。 */
const result = await new Promise((resolveResult, reject) => {
  /** 超时只结束探针，宿主本身仍按调用期限回收。 */
  const timer = setTimeout(() => reject(new Error('Computer Use 真实运行检查超时')), expected.userPriority || expected.systemStop ? 240000 : expected.performance ? 120000 : 60000);
  socket.addEventListener('message', (event) => {
    /** 只处理本探针的唯一响应。 */
    const message = JSON.parse(event.data);
    if (message.id !== 1) return;
    clearTimeout(timer);
    if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
    else resolveResult(message.result.result.value);
  });
  /** ESM 导入交给真实 Node 主环境，不重写应用运行时。 */
  const body = `(${verifyInElectron.toString()})(${JSON.stringify(expected)})`;
  socket.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `process.getBuiltinModule('vm').runInThisContext(${JSON.stringify(body)}, { importModuleDynamically: process.getBuiltinModule('vm').constants.USE_MAIN_CONTEXT_DEFAULT_LOADER })`,
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  );
}).finally(() => socket.close());
console.log(JSON.stringify(result));
