import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isInteractiveShellSession } from '@zeus/shared';
import type { AiRuntimeSession, DashboardClient, ProjectRecord } from '../../apiClient.js';
import { Button } from '../../ui/Button.js';
import { createPortal } from 'react-dom';
import { MotionPresence, usePresenceSurface } from '../../ui/MotionPresence.js';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { StopIcon as Stop } from '@phosphor-icons/react/dist/csr/Stop';
import { TerminalTabs } from './TerminalTabs.js';
import { observeTerminalTheme, terminalDisplayOptions } from './terminalPresentation.js';
import { useApplicationErrorDialog } from '../../ui/ApplicationErrorDialog.js';

/** 命令页入口打开底部停靠面板，沿用浏览器分屏方式，收起不结束后台进程。 */
export function ProjectTerminalPanel(props: { project: ProjectRecord; client: DashboardClient; language: 'zh-CN' | 'en-US'; dockHost: HTMLDivElement | null }) {
  /** 当前界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 面板与后台会话的生命周期分开。 */
  const [open, setOpen] = useState(false);
  /** 默认占工作区下方四成，上方命令页仍能操作。 */
  const [heightShare, setHeightShare] = useState(42);
  /** 收起后把键盘焦点还给入口。 */
  const entryRef = useRef<HTMLButtonElement>(null);
  /** 标签与输出面板的无障碍关联保持唯一。 */
  const panelId = useId();
  /** 当前项目的交互 shell 与选中身份。 */
  const [sessions, setSessions] = useState<AiRuntimeSession[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** 首次读取完成后才能决定恢复会话还是新建。 */
  const [loading, setLoading] = useState(true);
  /** 启停期间防止重复提交。 */
  const [busy, setBusy] = useState(false);
  /** 列表故障直接显示，操作故障沿用应用错误弹窗。 */
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** 重连只重建显示端，不重启进程。 */
  const [connection, setConnection] = useState(0);
  /** 最新选中会话始终来自后台状态。 */
  const selected = sessions.find((session) => session.id === selectedId);
  /** 启停结果不能被更早发出的列表读取覆盖。 */
  const revisionRef = useRef(0);
  /** 本次挂载已关闭的标签不再被轮询或重连恢复。 */
  const closedIdsRef = useRef(new Set<string>());
  /** 关闭请求的进度与同步互斥保护。 */
  const [closingId, setClosingId] = useState<string | null>(null);
  /** 同一轮事件中也不能重复发出关闭请求。 */
  const closeInFlightRef = useRef(false);
  /** 异步关闭完成时读取最新列表，保留期间新发现的终端。 */
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  useApplicationErrorDialog(error, { language: zh ? 'zh-CN' : 'en' });

  useEffect(() => {
    /** 卸载后不回写，轮询之间不并发。 */
    let disposed = false;
    let refreshing = false;
    /** 从项目归属和精确 shell 参数恢复终端列表。 */
    async function refresh(): Promise<void> {
      if (refreshing) return;
      refreshing = true;
      const revision = revisionRef.current;
      try {
        const items = (await props.client.loadRuntimeSessions({ projectId: props.project.id })).filter(
          (session) => session.projectId === props.project.id && isInteractiveShellSession(session) && !session.archived && !session.deletedAt && !closedIdsRef.current.has(session.id),
        );
        if (disposed || revision !== revisionRef.current) return;
        setSessions(items);
        setSelectedId((current) => (items.some((session) => session.id === current) ? current : ((items.find((session) => session.status === 'running') ?? items[0])?.id ?? null)));
        setLoadFailed(false);
      } catch {
        if (!disposed) setLoadFailed(true);
      } finally {
        refreshing = false;
        if (!disposed) setLoading(false);
      }
    }
    void refresh();
    /** 事件负责及时更新，轮询负责断线补偿。 */
    const timer = window.setInterval(() => void refresh(), 2_000);
    const unsubscribe = props.client.subscribeEvents(
      (event) => {
        if (event.payload.projectId === props.project.id && ['runtime.session.created', 'runtime.session.ended', 'runtime.session.stopped'].includes(event.type)) void refresh();
      },
      (state) => {
        if (state === 'connected') void refresh();
      },
    );
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [props.client, props.project.id]);

  /** 点击即授权开启终端，沿用后台权限与一次性确认记录，不再弹二次提示。 */
  async function start(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      /** 能力与项目配置检查互不依赖。 */
      const [status, config] = await Promise.all([props.client.loadRuntimeStatus(), props.client.loadProjectConfig(props.project.id)]);
      if (status.terminal?.provider !== 'node-pty' || !status.terminal.pty.available || !status.terminal.shell)
        throw new Error(zh ? '当前终端组件不可用，请检查应用安装后重试。' : 'The terminal backend is unavailable. Check the app installation and retry.');
      if (!config.security.allowShell)
        await props.client.saveProjectConfig(props.project.id, {
          defaultModel: config.defaultModel,
          defaultWorkMode: config.defaultWorkMode,
          language: config.language,
          dependencies: config.dependencies,
          database: config.database,
          telegram: config.telegram,
          security: { ...config.security, allowShell: true },
        });
      /** 不拼接路径到 shell 命令；后台从当前项目记录解析默认目录。 */
      const sessionInput = { projectId: props.project.id, ...status.terminal.shell };
      const confirmation = await props.client.createRuntimeConfirmation({ action: 'start_generic_session', reason: '用户点击开启项目终端', session: sessionInput });
      await props.client.confirmRuntimeOperation(confirmation.id);
      const session = await props.client.startRuntimeSession({ ...sessionInput, confirmationId: confirmation.id });
      revisionRef.current += 1;
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSelectedId(session.id);
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  /** 优先恢复运行中的终端；没有运行会话时直接创建。 */
  function show(): void {
    if (loading || busy) return;
    setOpen(true);
    const running = sessions.find((session) => session.status === 'running');
    if (running) setSelectedId(running.id);
    else void start();
  }

  /** 只结束选中终端及其进程树，已产生的输出仍可查看。 */
  async function stop(): Promise<void> {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const session = await props.client.stopRuntimeSession(selected.id);
      revisionRef.current += 1;
      setSessions((current) => current.map((item) => (item.id === session.id ? session : item)));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  /** 关闭标签直接结束运行进程；只有成功后才移除，失败保留标签和错误。 */
  async function closeTab(session: AiRuntimeSession): Promise<void> {
    if (busy || closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    setBusy(true);
    setClosingId(session.id);
    setError(null);
    try {
      if (['running', 'orphan_detected'].includes(session.status)) await props.client.stopRuntimeSession(session.id);
      closedIdsRef.current.add(session.id);
      revisionRef.current += 1;
      /** 按屏幕上的顺序选择右邻标签，末尾关闭时选择左邻标签。 */
      const displayed = sessionsRef.current.slice().reverse();
      /** 当前标签在最新列表中的位置。 */
      const index = displayed.findIndex((item) => item.id === session.id);
      /** 保留所有未关闭的终端，输出与历史记录不做删除。 */
      const remaining = displayed.filter((item) => item.id !== session.id);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setSelectedId((current) => (current === session.id ? (remaining[Math.max(0, Math.min(index, remaining.length - 1))]?.id ?? null) : current));
      if (remaining.length === 0) hide();
    } catch (failure) {
      setError(failure);
    } finally {
      closeInFlightRef.current = false;
      setClosingId(null);
      setBusy(false);
    }
  }

  /** 根据工作区高度调整分屏比例，保留上方页面的操作空间。 */
  function resize(clientY: number): void {
    const rect = props.dockHost?.parentElement?.getBoundingClientRect();
    if (rect?.height) setHeightShare(Math.min(70, Math.max(25, ((rect.bottom - clientY) / rect.height) * 100)));
  }

  /** 只收起显示端，不终止后台 shell。 */
  function hide(): void {
    setOpen(false);
    entryRef.current?.focus();
  }

  return (
    <>
      <Button ref={entryRef} onClick={() => (open ? hide() : show())} disabled={loading || busy} aria-expanded={open}>
        {zh ? '终端' : 'Terminal'}
      </Button>
      <MotionPresence>
        {open && props.dockHost
          ? createPortal(
              <TerminalDock heightShare={heightShare} label={zh ? '项目终端' : 'Project terminal'}>
                <div
                  className="project-terminal-resizer"
                  role="separator"
                  aria-label={zh ? '调整终端高度' : 'Resize terminal'}
                  aria-orientation="horizontal"
                  aria-valuemin={25}
                  aria-valuemax={70}
                  aria-valuenow={Math.round(heightShare)}
                  tabIndex={0}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    resize(event.clientY);
                  }}
                  onPointerMove={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientY);
                  }}
                  onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onPointerCancel={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                  }}
                  onKeyDown={(event) => {
                    if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return;
                    event.preventDefault();
                    setHeightShare((current) => Math.min(70, Math.max(25, current + (event.key === 'ArrowUp' ? 2 : -2))));
                  }}
                />
                <header className="zeus-terminal-toolbar">
                  <TerminalTabs
                    sessions={sessions.slice().reverse()}
                    activeId={selectedId}
                    panelId={panelId}
                    language={props.language}
                    visible={open}
                    starting={busy && !closingId && !selected}
                    newDisabled={busy}
                    closingId={closingId}
                    closeDisabled={busy || loadFailed}
                    onSelect={setSelectedId}
                    onNew={() => void start()}
                    onClose={(session) => void closeTab(session)}
                  />
                  {selected ? (
                    <>
                      <button className="zeus-terminal-action" type="button" title={zh ? '重新连接' : 'Reconnect'} aria-label={zh ? '重新连接' : 'Reconnect'} onClick={() => setConnection((value) => value + 1)}>
                        <ArrowClockwise aria-hidden="true" />
                      </button>
                      <button
                        className="zeus-terminal-action"
                        type="button"
                        title={zh ? '结束会话' : 'End session'}
                        aria-label={zh ? '结束会话' : 'End session'}
                        disabled={busy || loadFailed || !['running', 'orphan_detected'].includes(selected.status)}
                        onClick={() => void stop()}
                      >
                        <Stop aria-hidden="true" />
                      </button>
                    </>
                  ) : null}
                  <button className="zeus-terminal-action" type="button" title={zh ? '收起终端' : 'Hide terminal'} aria-label={zh ? '收起终端' : 'Hide terminal'} onClick={hide}>
                    <X aria-hidden="true" />
                  </button>
                </header>
                <div className="project-terminal-content" role="tabpanel" id={panelId} aria-labelledby={selectedId ? `${panelId}-${selectedId}` : undefined}>
                  {loadFailed ? <p role="status">{zh ? '终端列表连接中断，正在重连…' : 'Terminal list disconnected. Reconnecting…'}</p> : null}
                  {selected ? (
                    <InteractiveTerminalPane key={`${selected.id}:${connection}`} client={props.client} session={selected} zh={zh} />
                  ) : (
                    <p role="status">{busy ? (zh ? '正在开启终端…' : 'Opening terminal…') : zh ? '尚无终端会话' : 'No terminal sessions'}</p>
                  )}
                </div>
              </TerminalDock>,
              props.dockHost,
            )
          : null}
      </MotionPresence>
    </>
  );
}

/** 注册真实停靠表面，让共享动效边界等待收起完成后再卸载终端。 */
function TerminalDock(props: { heightShare: number; label: string; children: ReactNode }) {
  /** 高度变化直接发生在分屏表面，与浏览器的宽度展开对应。 */
  const ref = useRef<HTMLElement>(null);
  /** 关闭立即停止交互，保留最后一帧完成退出动效。 */
  const open = usePresenceSurface(ref);
  return (
    <section ref={ref} className="project-terminal" aria-label={props.label} aria-hidden={!open} inert={!open} data-open={open} style={{ height: open ? `${props.heightShare}%` : 0 }}>
      {props.children}
    </section>
  );
}

/** xterm 按日志游标增量渲染，键盘输入及尺寸变更通过同一有序队列发送。 */
function InteractiveTerminalPane(props: { client: DashboardClient; session: AiRuntimeSession; zh: boolean }) {
  /** 终端容器只绑定当前会话。 */
  const containerRef = useRef<HTMLDivElement>(null);
  /** 后台状态变化无需重建终端缓冲区。 */
  const runningRef = useRef(props.session.status === 'running');
  runningRef.current = props.session.status === 'running';
  /** 断线和输入故障显式展示；未知结果不自动重放输入。 */
  const [state, setState] = useState<'connecting' | 'ready' | 'disconnected' | 'input_failed'>('connecting');

  useEffect(() => {
    /** 异步导入、查询和队列都检查卸载状态。 */
    let disposed = false;
    let terminal: import('@xterm/xterm').Terminal | undefined;
    let observer: ResizeObserver | undefined;
    /** 只更新显示主题，不重建终端或改变运行中的 shell。 */
    let disposeTheme: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let pollTimer: number | undefined;
    let refreshTimer: number | undefined;
    let loading = false;
    let offset: number | undefined;
    let ready = false;
    let inputFailed = false;
    /** 同一终端内输入和 resize 不并发，避免租约序号冲突。 */
    let writes = Promise.resolve();

    /** 写入不确定时停止后续输入，用户重连后根据真实输出决定下一步。 */
    function send(operation: () => Promise<unknown>): void {
      writes = writes.then(async () => {
        if (disposed || inputFailed || !runningRef.current) return;
        try {
          await operation();
        } catch {
          inputFailed = true;
          if (!disposed) {
            terminal!.options.disableStdin = true;
            setState('input_failed');
          }
        }
      });
    }

    /** 从实际字符格测量尺寸，不额外引入适配依赖。 */
    function resize(): void {
      if (!terminal || !containerRef.current || !ready || !runningRef.current) return;
      const screen = containerRef.current.querySelector('.xterm-screen');
      const bounds = screen?.getBoundingClientRect();
      if (!bounds?.width || !bounds.height) return;
      const cols = Math.max(2, Math.floor(containerRef.current.clientWidth / (bounds.width / terminal.cols)));
      const rows = Math.max(2, Math.floor(containerRef.current.clientHeight / (bounds.height / terminal.rows)));
      terminal.resize(cols, rows);
      send(() => props.client.resizeRuntimeSession(props.session.id, { cols, rows }));
    }

    /** 输出按持久游标追赶，等待 xterm 消化后再取下一页。 */
    async function refresh(): Promise<void> {
      if (disposed || loading || !terminal) return;
      loading = true;
      try {
        if (offset === undefined) {
          const head = await props.client.loadRuntimeSessionLogsPage(props.session.id, { limit: 1 });
          if (disposed) return;
          // ponytail: 重连只回放最近 2000 条；需要无损全屏程序恢复时增加终端屏幕快照。
          offset = Math.max(0, head.total - 2_000);
          if (offset > 0) terminal.writeln(props.zh ? '…仅回放最近的终端输出。' : '…Replaying recent terminal output only.');
        }
        const page = await props.client.loadRuntimeSessionLogsPage(props.session.id, { offset, limit: 200 });
        if (disposed) return;
        const output = page.items
          .filter((entry) => entry.stream !== 'system')
          .map((entry) => entry.text)
          .join('');
        if (output) await new Promise<void>((resolve) => terminal!.write(output, resolve));
        if (disposed) return;
        offset += page.items.length;
        const caughtUp = offset >= page.total;
        terminal.options.disableStdin = !caughtUp || !runningRef.current || inputFailed;
        if (caughtUp && !ready) {
          ready = true;
          resize();
          terminal.focus();
        }
        if (!inputFailed) setState(caughtUp ? 'ready' : 'connecting');
        if (!caughtUp && page.items.length) scheduleRefresh();
      } catch {
        if (!disposed) {
          terminal.options.disableStdin = true;
          if (!inputFailed) setState('disconnected');
        }
      } finally {
        loading = false;
      }
    }

    /** 合并输出通知；分页追赶也让出浏览器线程。 */
    function scheduleRefresh(): void {
      if (disposed || refreshTimer !== undefined) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        void refresh();
      }, 50);
    }

    void import('@xterm/xterm')
      .then(({ Terminal }) => {
        if (disposed || !containerRef.current) return;
        /** 内容区显示配置与会话入口共享，输入与日志仍由当前入口管理。 */
        terminal = new Terminal({
          ...terminalDisplayOptions,
          disableStdin: true,
          screenReaderMode: true,
          scrollback: 5_000,
          rows: 24,
          cols: 100,
        });
        disposeTheme = observeTerminalTheme(terminal, containerRef.current);
        terminal.open(containerRef.current);
        terminal.textarea?.setAttribute('aria-label', props.zh ? '终端输入' : 'Terminal input');
        terminal.onData((input) => {
          if (!terminal!.options.disableStdin) send(() => props.client.sendRuntimeInput(props.session.id, input));
        });
        observer = new ResizeObserver(resize);
        observer.observe(containerRef.current);
        unsubscribe = props.client.subscribeEvents(
          (event) => {
            if (event.payload.sessionId === props.session.id) scheduleRefresh();
          },
          (connection) => {
            if (connection === 'connected') scheduleRefresh();
            else {
              terminal!.options.disableStdin = true;
              if (!inputFailed) setState('disconnected');
            }
          },
        );
        pollTimer = window.setInterval(() => void refresh(), 1_000);
        void refresh();
      })
      .catch(() => {
        if (!disposed) setState('disconnected');
      });
    return () => {
      disposed = true;
      observer?.disconnect();
      disposeTheme?.();
      unsubscribe?.();
      window.clearInterval(pollTimer);
      window.clearTimeout(refreshTimer);
      terminal?.dispose();
    };
  }, [props.client, props.session.id, props.zh]);

  return (
    <>
      <div className="zeus-terminal-screen" ref={containerRef} />
      {state !== 'ready' || props.session.status !== 'running' ? (
        <p role="status">
          {state === 'input_failed'
            ? props.zh
              ? '输入发送失败，未自动重发。请重新连接并检查终端输出。'
              : 'Input failed and was not replayed. Reconnect and check the output.'
            : state === 'disconnected'
              ? props.zh
                ? '连接中断，正在重连；暂不可输入。'
                : 'Disconnected. Reconnecting; input is paused.'
              : state === 'connecting'
                ? props.zh
                  ? '正在连接终端…'
                  : 'Connecting…'
                : `${props.zh ? '会话已结束' : 'Session ended'}${props.session.exitCode == null ? '' : ` · ${props.zh ? '退出码' : 'Exit code'} ${props.session.exitCode}`}`}
        </p>
      ) : null}
    </>
  );
}
