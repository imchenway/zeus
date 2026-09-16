import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { isInteractiveShellSession } from '@zeus/shared';
import type { AiRuntimeSession, DashboardClient, ProjectRecord } from '../../apiClient.js';
import { Button } from '../../ui/Button.js';
import { createPortal } from 'react-dom';
import { MotionPresence, usePresenceSurface } from '../../ui/MotionPresence.js';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { StopIcon as Stop } from '@phosphor-icons/react/dist/csr/Stop';
import { useApplicationErrorDialog } from '../../ui/ApplicationErrorDialog.js';

/** 终端面板状态持久化存储键前缀。 */
const TERMINAL_STATE_STORAGE_KEY_PREFIX = 'zeus.terminal-panel-state.';

/** 从本地存储读取终端面板状态。 */
function readTerminalPanelState(projectId: string): { open: boolean; heightShare: number } {
  try {
    const stored = window.localStorage.getItem(`${TERMINAL_STATE_STORAGE_KEY_PREFIX}${projectId}`);
    if (!stored) return { open: false, heightShare: 42 };
    const parsed = JSON.parse(stored);
    return {
      open: typeof parsed.open === 'boolean' ? parsed.open : false,
      heightShare: typeof parsed.heightShare === 'number' ? Math.min(70, Math.max(25, parsed.heightShare)) : 42,
    };
  } catch {
    return { open: false, heightShare: 42 };
  }
}

/** 将终端面板状态保存到本地存储。 */
function saveTerminalPanelState(projectId: string, state: { open: boolean; heightShare: number }): void {
  try {
    window.localStorage.setItem(`${TERMINAL_STATE_STORAGE_KEY_PREFIX}${projectId}`, JSON.stringify(state));
  } catch {
    // 忽略存储失败
  }
}

/** 命令页入口打开底部停靠面板，沿用浏览器分屏方式，收起不结束后台进程。 */
export function ProjectTerminalPanel(props: { project: ProjectRecord; client: DashboardClient; language: 'zh-CN' | 'en-US'; dockHost: HTMLDivElement | null }) {
  /** 当前界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 面板打开状态按项目ID持久化，切换项目时保持各项目独立状态。 */
  const [open, setOpen] = useState(() => readTerminalPanelState(props.project.id).open);
  /** 高度比例按项目ID持久化。 */
  const [heightShare, setHeightShare] = useState(() => readTerminalPanelState(props.project.id).heightShare);
  /** 收起后把键盘焦点还给入口。 */
  const entryRef = useRef<HTMLButtonElement>(null);
  /** 标签与输出面板的无障碍关联保持唯一。 */
  const panelId = useId();
  /** 新建或切换时让当前标签滚入可见范围。 */
  const selectedTabRef = useRef<HTMLButtonElement>(null);
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

  /** 当项目ID变化时，从持久化存储恢复状态。 */
  useEffect(() => {
    const savedState = readTerminalPanelState(props.project.id);
    setOpen(savedState.open);
    setHeightShare(savedState.heightShare);
  }, [props.project.id]);

  /** 持久化打开状态和高度。 */
  useEffect(() => {
    saveTerminalPanelState(props.project.id, { open, heightShare });
  }, [props.project.id, open, heightShare]);

  useEffect(() => {
    if (open) selectedTabRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [open, selectedId]);
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
        const items = (await props.client.loadRuntimeSessions({ projectId: props.project.id })).filter((session) => session.projectId === props.project.id && isInteractiveShellSession(session) && !session.archived && !session.deletedAt);
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
                <header className="project-terminal-toolbar">
                  <div
                    className="project-terminal-tabs"
                    role="tablist"
                    aria-label={zh ? '终端会话' : 'Terminal sessions'}
                    onKeyDown={(event) => {
                      /** 方向键只移动标签焦点，回车或空格由按钮原生激活。 */
                      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                      const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
                      const index = tabs.indexOf(event.target as HTMLButtonElement);
                      if (index < 0) return;
                      event.preventDefault();
                      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                      tabs[next]?.focus();
                    }}
                  >
                    {sessions
                      .slice()
                      .reverse()
                      .map((session, index) => (
                        <button
                          key={session.id}
                          ref={session.id === selectedId ? selectedTabRef : undefined}
                          type="button"
                          role="tab"
                          id={`${panelId}-${session.id}`}
                          aria-controls={panelId}
                          aria-selected={session.id === selectedId}
                          tabIndex={session.id === selectedId ? 0 : -1}
                          className="project-terminal-tab"
                          title={session.status === 'running' ? (zh ? '运行中' : 'Running') : zh ? '已结束' : 'Ended'}
                          onClick={() => setSelectedId(session.id)}
                        >
                          {zh ? '终端' : 'Terminal'} {index + 1}
                          {session.status !== 'running' ? <span>{zh ? '已结束' : 'Ended'}</span> : null}
                        </button>
                      ))}
                  </div>
                  <button type="button" title={zh ? '新建终端' : 'New terminal'} aria-label={zh ? '新建终端' : 'New terminal'} disabled={busy} onClick={() => void start()}>
                    <Plus aria-hidden="true" />
                  </button>
                  {selected ? (
                    <>
                      <button type="button" title={zh ? '重新连接' : 'Reconnect'} aria-label={zh ? '重新连接' : 'Reconnect'} onClick={() => setConnection((value) => value + 1)}>
                        <ArrowClockwise aria-hidden="true" />
                      </button>
                      <button
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
                  <button type="button" title={zh ? '收起终端' : 'Hide terminal'} aria-label={zh ? '收起终端' : 'Hide terminal'} onClick={hide}>
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
    let xterm: Awaited<typeof import('@xterm/xterm')>['Terminal'] | null = null;
    let fitAddon: Awaited<typeof import('@xterm/addon-fit')>['FitAddon'] | null = null;
    let webglAddon: Awaited<typeof import('@xterm/addon-webgl')>['WebglAddon'] | null = null;
    let connectionDispose: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let fitFrame: number | undefined;
    const queuedInputs: Array<{ data: string; id: number }> = [];
    let nextInputId = 0;
    let sending = false;

    async function connect(): Promise<void> {
      const [{ Terminal }, { FitAddon }, { WebglAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), import('@xterm/addon-webgl')]);
      if (disposed) return;
      xterm = new Terminal({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: "'SFMono-Regular', 'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace",
        theme: {
          background: '#1e1e1e',
          foreground: '#d4d4d4',
          cursor: '#d4d4d4',
          selectionBackground: '#264f78',
        },
        scrollback: 10000,
      });
      fitAddon = new FitAddon();
      xterm.loadAddon(fitAddon);
      try {
        webglAddon = new WebglAddon();
        xterm.loadAddon(webglAddon);
      } catch {
        // WebGL 不可用时回退到 canvas 渲染
      }
      if (!containerRef.current || disposed) return;
      xterm.open(containerRef.current);
      fitAddon.fit();
      /** 连接终端输出流。 */
      const {
        dispose: disposeConnection,
        sendInput,
        resize: resizeTerminal,
      } = await props.client.connectRuntimeTerminal(props.session.id, {
        onData: (data) => {
          if (!disposed && xterm) xterm.write(data);
        },
        onExit: () => {
          if (!disposed) setState('disconnected');
        },
      });
      if (disposed) {
        disposeConnection();
        return;
      }
      connectionDispose = disposeConnection;
      /** 发送输入的有序队列，避免并发打乱顺序。 */
      function flushQueue(): void {
        if (sending || queuedInputs.length === 0) return;
        sending = true;
        const next = queuedInputs.shift()!;
        void sendInput(next.data).finally(() => {
          sending = false;
          if (!disposed) flushQueue();
        });
      }
      xterm.onData((data) => {
        if (!runningRef.current) {
          setState('input_failed');
          return;
        }
        queuedInputs.push({ data, id: nextInputId++ });
        flushQueue();
      });
      /** 终端尺寸变更通过防抖批量发送，避免高频 resize 压垮后端。 */
      let resizeTimer: ReturnType<typeof setTimeout> | undefined;
      xterm.onResize(({ cols, rows }) => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!disposed) void resizeTerminal(cols, rows);
        }, 100);
      });
      /** 容器尺寸变化时重新适配。 */
      resizeObserver = new ResizeObserver(() => {
        if (fitAddon && !disposed) {
          cancelAnimationFrame(fitFrame);
          fitFrame = window.requestAnimationFrame(() => {
            if (fitAddon && !disposed) {
              fitAddon.fit();
            }
          });
        }
      });
      resizeObserver.observe(containerRef.current);
      setState('ready');
    }

    void connect();
    return () => {
      disposed = true;
      cancelAnimationFrame(fitFrame);
      clearTimeout(resizeTimer);
      resizeObserver?.disconnect();
      connectionDispose?.dispose();
      webglAddon?.dispose();
      fitAddon?.dispose();
      xterm?.dispose();
    };
  }, [props.client, props.session.id, props.session.status]);

  const zh = props.zh;
  return (
    <div className="interactive-terminal-pane">
      <div ref={containerRef} className="interactive-terminal-container" />
      {state === 'connecting' ? <div className="interactive-terminal-overlay">{zh ? '正在连接…' : 'Connecting…'}</div> : null}
      {state === 'disconnected' ? (
        <div className="interactive-terminal-overlay interactive-terminal-disconnected">
          <span>{zh ? '会话已结束' : 'Session ended'}</span>
        </div>
      ) : null}
      {state === 'input_failed' ? (
        <div className="interactive-terminal-overlay interactive-terminal-input-failed">
          <span>{zh ? '输入不可用，终端已结束' : 'Input unavailable, terminal ended'}</span>
        </div>
      ) : null}
    </div>
  );
}
