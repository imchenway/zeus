import { app, BrowserWindow, type IpcMainEvent } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { faultReportContext, faultReportDetails, redactFaultReportText, type FaultProcessSnapshot, type FaultReportEvent, type FaultReportScene } from '@zeus/shared';
import type { FaultReportOptions } from './faultReporting.js';
import { withCloseTimeout } from './executionHostClosePlan.js';

/** 独立守护只通过私有 IPC 获取启动信息，参数和报告中均不写认证令牌。 */
export interface FaultMonitorBootstrap {
  runId: string;
  mainPid: number;
  startedAt: string;
  executable: string;
  args: string[];
  dataRoot: string;
  helperPath: string;
  crashDirectory: string;
  reports: FaultReportOptions;
  language: 'zh-CN' | 'en-US';
  appearance: 'dark' | 'light';
}

/** 每次主进程心跳包含进程身份和最后一次真正的界面响应。 */
export interface FaultMonitorPulse {
  at: string;
  /** 焦点只用于关联最后工作面，不触发任何窗口激活动作。 */
  activeWindowId?: number;
  processes: FaultProcessSnapshot[];
  windows: Array<{ id: number; pid: number; startedAt: string; lastHeartbeatAt: string; ready: boolean; unresponsiveSince?: string; context: Record<string, string> }>;
  configuration: Record<string, string | number | boolean | null>;
  core?: { pid: number; instanceId: string };
  reports: FaultReportOptions;
  language: 'zh-CN' | 'en-US';
  appearance: 'dark' | 'light';
}

/** Main 与独立守护之间的有界协议；业务正文不进入此通道。 */
export type FaultWatchdogMessage =
  | { kind: 'bootstrap'; value: FaultMonitorBootstrap }
  | { kind: 'pulse'; value: FaultMonitorPulse }
  | { kind: 'breadcrumb'; value: FaultReportEvent }
  | { kind: 'fault'; reason: FaultReportScene['reason']; windowId?: number; detail?: string }
  | { kind: 'clean-exit' }
  | { kind: 'resume' };

/** 主进程只转发健康和业务身份，故障窗口、取证及强制恢复在独立进程执行。 */
export function startFaultMonitor(
  options: FaultMonitorBootstrap & {
    windows: () => BrowserWindow[];
    isReady: (window: BrowserWindow) => boolean;
    current: () => Pick<FaultMonitorPulse, 'reports' | 'configuration' | 'core' | 'language' | 'appearance'>;
    onUnavailable: () => void;
  },
): {
  heartbeat: (event: IpcMainEvent, nonce: unknown) => void;
  context: (event: IpcMainEvent, context: unknown) => void;
  breadcrumb: (event: IpcMainEvent, value: unknown) => void;
  fault: (reason: FaultReportScene['reason'], window?: BrowserWindow, detail?: string) => void;
  responsive: (window: BrowserWindow, responsive: boolean) => void;
  ready: (window: BrowserWindow) => void;
  loading: (window: BrowserWindow) => void;
  resume: () => void;
  quitting: (quitting: boolean) => void;
  close: () => void;
  closeAndWait: () => Promise<void>;
} {
  /** 窗口状态只由受信主框架和对应的 ping 回执更新。 */
  const windows = new Map<number, { nonce: string; startedAt: string; lastHeartbeatAt: string; context: Record<string, string>; unresponsiveSince?: string; ready?: boolean }>();
  /** Electron 的 Node 模式已有执行宿主先例，不增加可执行文件或构建入口配置。 */
  const child: ChildProcess = spawn(process.execPath, [fileURLToPath(new URL('./faultWatchdog.js', import.meta.url))], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ZEUS_FAULT_WATCHDOG: '1' },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr?.on('data', (chunk: Buffer) => console.error('Zeus 独立故障监控诊断。', redactFaultReportText(chunk.toString('utf8'), 2000)));
  child.unref();
  child.channel?.unref();
  /** 干净退出后不把正常关闭误判成进程崩溃。 */
  let closed = false;
  /** 已确认退出后不再把正在关闭的 Renderer 当作故障。 */
  let quitting = false;
  /** 启动失败只提示一次，避免 error 和 exit 连续弹出两个窗口。 */
  let unavailable = false;
  /** 上次 Main 调度时刻用于记录已经恢复的短时卡顿，单位毫秒。 */
  let lastPulseAt = Date.now();
  /** 只有子进程实际就绪才结束启动期限，spawn 成功不能代表监控有效。 */
  const readyTimer = setTimeout(reportUnavailable, 10_000);
  readyTimer.unref();
  child.on('message', (message: { kind?: string }) => {
    if (message.kind === 'ready') clearTimeout(readyTimer);
  });
  /** 监控不可用会影响故障恢复，必须明确提示而不能只写控制台。 */
  function reportUnavailable(): void {
    clearTimeout(readyTimer);
    if (!closed && !unavailable) {
      unavailable = true;
      options.onUnavailable();
    }
  }
  /** 心跳失败只写本机错误，避免故障提示递归触发自身。 */
  child.on('error', (error) => {
    console.error('Zeus 独立故障监控启动失败。', error);
    reportUnavailable();
  });
  child.on('exit', (code) => {
    if (!closed) {
      console.error('Zeus 独立故障监控已退出。', code);
      reportUnavailable();
    }
  });
  /** 子进程已退出时不重放消息，也不向业务暴露 IPC 内部对象。 */
  function send(message: FaultWatchdogMessage): void {
    if (!closed && child.connected) child.send(message, () => undefined);
  }
  send({
    kind: 'bootstrap',
    value: {
      runId: options.runId,
      mainPid: options.mainPid,
      startedAt: options.startedAt,
      executable: options.executable,
      args: options.args,
      dataRoot: options.dataRoot,
      helperPath: options.helperPath,
      crashDirectory: options.crashDirectory,
      reports: options.reports,
      language: options.language,
      appearance: options.appearance,
    },
  });

  /** 同一窗口的受信主框架才可以刷新健康或诊断身份。 */
  function owner(event: IpcMainEvent): BrowserWindow | undefined {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window && !window.isDestroyed() && options.windows().includes(window) && event.senderFrame === event.sender.mainFrame ? window : undefined;
  }

  /** 不依赖 Renderer 的定时器，后台窗口也通过 IPC 事件响应健康探针。 */
  function pulse(): void {
    if (closed) return;
    const at = new Date().toISOString();
    const eventLoopDelayMs = Math.max(0, Date.now() - lastPulseAt - 2_000);
    lastPulseAt = Date.now();
    if (eventLoopDelayMs >= 1_000) send({ kind: 'breadcrumb', value: { timestamp: at, event: 'main.event_loop_delay', context: {}, details: { durationMs: eventLoopDelayMs } } });
    const open = quitting ? [] : options.windows().filter((window) => !window.isDestroyed() && !window.webContents.isDestroyed());
    for (const id of windows.keys()) if (!open.some((window) => window.id === id)) windows.delete(id);
    const tracked = open.map((window) => {
      let state = windows.get(window.id);
      if (!state) {
        state = { nonce: '', startedAt: at, lastHeartbeatAt: at, context: {} };
        windows.set(window.id, state);
      }
      state.nonce = randomUUID();
      window.webContents.send('zeus:health-ping', state.nonce);
      return {
        id: window.id,
        pid: window.webContents.getOSProcessId(),
        startedAt: state.startedAt,
        lastHeartbeatAt: state.lastHeartbeatAt,
        ready: state.ready ?? options.isReady(window),
        context: state.context,
        ...(state.unresponsiveSince ? { unresponsiveSince: state.unresponsiveSince } : {}),
      };
    });
    const metrics = app.getAppMetrics().slice(0, 16);
    const current = options.current();
    const processes: FaultProcessSnapshot[] = metrics.flatMap((metric) => {
      const role = metric.pid === process.pid ? 'main' : tracked.some((window) => window.pid === metric.pid) ? 'renderer' : metric.type === 'GPU' ? 'gpu' : null;
      return role ? [{ role, pid: metric.pid, cpuPercent: metric.cpu.percentCPUUsage, memoryKiB: metric.memory.workingSetSize, ...(role === 'main' ? { lastHeartbeatAt: at } : {}) }] : [];
    });
    if (!processes.some((entry) => entry.role === 'main')) processes.unshift({ role: 'main', pid: process.pid, lastHeartbeatAt: at });
    for (const window of tracked) if (window.pid > 0 && !processes.some((entry) => entry.pid === window.pid)) processes.push({ role: 'renderer', pid: window.pid, lastHeartbeatAt: window.lastHeartbeatAt });
    if (current.core) processes.push({ role: 'core', pid: current.core.pid });
    send({
      kind: 'pulse',
      value: { at, windows: tracked, processes, activeWindowId: BrowserWindow.getFocusedWindow()?.id, ...current, configuration: { ...current.configuration, eventLoopDelayMs, ...(quitting ? { phase: 'quitting' } : {}) } },
    });
  }
  /** 两秒一次探针；连续十五秒未响应的判定由独立进程执行。 */
  const timer = setInterval(pulse, 2_000);
  timer.unref();
  pulse();
  /** 正常退出通知守护收尾，异常退出仍由独立进程保存现场。 */
  function close(): void {
    if (closed) return;
    send({ kind: 'clean-exit' });
    closed = true;
    clearInterval(timer);
    clearTimeout(readyTimer);
  }
  /** 安装前等待守护真正退出，避免旧进程继续读取待替换的 ASAR。 */
  async function closeAndWait(): Promise<void> {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {
      close();
      return;
    }
    const exited = new Promise<void>((resolveExit, rejectExit) => child.once('exit', (code) => (code === 0 ? resolveExit() : rejectExit(new Error('独立故障监控未完成正常退出。')))));
    close();
    try {
      await withCloseTimeout(exited, 25_000, '等待故障现场保存和恢复窗口退出超时。');
    } catch (error) {
      child.kill('SIGKILL');
      throw error;
    }
  }
  return {
    heartbeat: (event, nonce) => {
      const window = owner(event);
      const state = window && windows.get(window.id);
      if (state && typeof nonce === 'string' && state.nonce === nonce) state.lastHeartbeatAt = new Date().toISOString();
    },
    context: (event, context) => {
      const window = owner(event);
      if (!window) return;
      const at = new Date().toISOString();
      const state = windows.get(window.id) ?? { nonce: '', startedAt: at, lastHeartbeatAt: at, context: {} };
      state.context = faultReportContext(context);
      windows.set(window.id, state);
    },
    breadcrumb: (event, value) => {
      const window = owner(event);
      if (!window || !value || typeof value !== 'object') return;
      const entry = value as Record<string, unknown>;
      if (typeof entry.event !== 'string' || !/^(?:ui\.(?:click|navigation)|desktop\.invoke|local_api\.(?:request_started|request_finished))$/u.test(entry.event)) return;
      send({
        kind: 'breadcrumb',
        value: { timestamp: new Date().toISOString(), event: entry.event, context: { ...windows.get(window.id)?.context, ...faultReportContext(entry.context), windowId: String(window.id) }, details: faultReportDetails(entry.details) },
      });
    },
    fault: (reason, window, detail) => {
      if (quitting) return;
      if (reason === 'manual_report') pulse();
      send({ kind: 'fault', reason, ...(window ? { windowId: window.id } : {}), ...(detail ? { detail } : {}) });
    },
    responsive: (window, responsive) => {
      const state = windows.get(window.id);
      if (state) state.unresponsiveSince = responsive ? undefined : (state.unresponsiveSince ?? new Date().toISOString());
    },
    ready: (window) => {
      const state = windows.get(window.id);
      if (state) state.ready = true;
    },
    loading: (window) => {
      const at = new Date().toISOString();
      windows.set(window.id, { nonce: '', startedAt: at, lastHeartbeatAt: at, context: windows.get(window.id)?.context ?? {}, ready: false });
    },
    resume: () => {
      const at = new Date().toISOString();
      for (const state of windows.values()) {
        state.lastHeartbeatAt = at;
        state.unresponsiveSince = undefined;
      }
      send({ kind: 'resume' });
    },
    quitting: (value) => {
      quitting = value;
      pulse();
    },
    close,
    closeAndWait,
  };
}
