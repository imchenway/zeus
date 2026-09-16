import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { RowsIcon as Rows } from '@phosphor-icons/react/dist/csr/Rows';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { TerminalIcon as TerminalGlyph } from '@phosphor-icons/react/dist/csr/Terminal';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  AiRuntimeSession,
  AiRuntimeSessionStatus,
  AiRuntimeTerminalSnapshot,
  ProjectConfig,
  RuntimeOperationConfirmation,
  RuntimeStatusSnapshot,
  StartRuntimeSessionRequest,
  ZeusRealtimeConnectionState,
  ZeusRealtimeEvent,
} from '../apiClient.js';

import { TerminalTabs } from '../features/runtime/TerminalTabs.js';
import { observeTerminalTheme, terminalDisplayOptions } from '../features/runtime/terminalPresentation.js';

const integratedTerminalCommand = 'sh';
const integratedTerminalScript = 'exec "${SHELL:-sh}" -l';
const integratedTerminalArgs = ['-lc', integratedTerminalScript] as const;
const terminalHeightStorageKey = 'zeus.session-terminal.height.v1';
const defaultTerminalHeight = 284;
/** 右侧面板默认宽度，实际尺寸仍受当前会话宽度约束。 */
const defaultTerminalWidth = 480;
/** 保留终端基本可读宽度；窄窗口最多占用一半空间。 */
const minimumTerminalWidth = 240;
/** 位置偏好按项目隔离，未选择时从右侧打开。 */
type TerminalPosition = 'right' | 'bottom';
const minimumTerminalHeight = 160;
const maximumTerminalTabs = 8;
const maximumTerminalInputChunk = 32 * 1024;
const alternateScreenResetSequence = '\u001b[?1049h\u001b[2J\u001b[H';
const synchronizedOutputSequence = '\u001b[?2026h';

export interface SessionTerminalClient {
  loadRuntimeStatus: () => Promise<RuntimeStatusSnapshot>;
  loadRuntimeSessions: (input?: { projectId?: string; taskId?: string; archived?: boolean }) => Promise<AiRuntimeSession[]>;
  loadRuntimeTerminalSnapshot: (sessionId: string) => Promise<AiRuntimeTerminalSnapshot>;
  createRuntimeConfirmation: (input: { action: 'start_generic_session'; reason: string; session: Omit<StartRuntimeSessionRequest, 'confirmationId'> }) => Promise<RuntimeOperationConfirmation>;
  confirmRuntimeOperation: (confirmationId: string) => Promise<RuntimeOperationConfirmation>;
  startRuntimeSession: (input: StartRuntimeSessionRequest) => Promise<AiRuntimeSession>;
  stopRuntimeSession: (sessionId: string) => Promise<AiRuntimeSession>;
  sendRuntimeInput: (sessionId: string, input: string) => Promise<AiRuntimeSession>;
  resizeRuntimeSession: (sessionId: string, size: { cols: number; rows: number }) => Promise<AiRuntimeSession>;
  loadProjectConfig: (projectId: string) => Promise<ProjectConfig>;
  enableProjectShell?: (projectId: string) => Promise<ProjectConfig>;
  subscribeRealtimeEvents?: (onEvent: (event: ZeusRealtimeEvent) => void, onConnectionState: (state: ZeusRealtimeConnectionState) => void) => (() => void) | void;
}

export interface SessionTerminalPanelProps {
  client: SessionTerminalClient;
  language: 'zh-CN' | 'en-US';
  visible: boolean;
  projectId: string;
  projectName: string;
  projectPath: string;
  taskId?: string;
  cwd?: string | null;
  focusRequest: number;
  onClose: () => void;
}

interface TerminalSurfaceHandle {
  sessionId: string;
  focus(): void;
  refresh(): void;
  write(event: ZeusRealtimeEvent): void;
}

type TerminalPanelPhase = { kind: 'loading' } | { kind: 'ready'; shellAllowed: boolean } | { kind: 'unavailable'; reason: string } | { kind: 'failed'; message: string };

const terminalCopy = {
  'zh-CN': {
    panel: '终端',
    resize: '调整终端高度',
    resizeWidth: '调整终端宽度',
    moveBottom: '移到底部',
    moveRight: '移到右侧',
    closePanel: '隐藏终端',
    loading: '正在连接终端服务…',
    starting: '正在启动终端…',
    allowAndStart: '允许 Shell 并新建终端',
    permissionTitle: '此项目尚未允许 Shell',
    permissionBody: '启用后，你在这里输入的命令会直接在当前项目目录中运行。',
    unavailableTitle: '交互式终端不可用',
    retry: '重试',
    cancel: '取消',
    sessionEnded: '终端进程已结束',
    terminalAria: '交互式项目终端',
    startupFailed: '无法启动终端。',
    permissionUnavailable: '当前界面不能修改项目 Shell 权限，请先在项目设置中开启“允许 Shell”。',
  },
  'en-US': {
    panel: 'Terminal',
    resize: 'Resize terminal height',
    resizeWidth: 'Resize terminal width',
    moveBottom: 'Move to bottom',
    moveRight: 'Move to right',
    closePanel: 'Hide terminal',
    loading: 'Connecting to the terminal service…',
    starting: 'Starting terminal…',
    allowAndStart: 'Allow Shell and create terminal',
    permissionTitle: 'Shell is not enabled for this project',
    permissionBody: 'Once enabled, commands entered here run directly in the current project folder.',
    unavailableTitle: 'Interactive terminal unavailable',
    retry: 'Retry',
    cancel: 'Cancel',
    sessionEnded: 'Terminal process ended',
    terminalAria: 'Interactive project terminal',
    startupFailed: 'Unable to start the terminal.',
    permissionUnavailable: 'This view cannot change the project Shell permission. Enable “Allow Shell” in project settings first.',
  },
} as const;

export function SessionTerminalPanel(props: SessionTerminalPanelProps) {
  /** 标签与输出面板共享的唯一标识。 */
  const panelId = useId();
  const copy = terminalCopy[props.language];
  const [phase, setPhase] = useState<TerminalPanelPhase>({ kind: 'loading' });
  const [sessions, setSessions] = useState<AiRuntimeSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(readStoredTerminalHeight);
  /** 项目身份由外层 key 隔离，重新进入会话时读取已保存的位置。 */
  const positionStorageKey = `zeus.session-terminal.position:${encodeURIComponent(props.projectId)}`;
  /** 位置切换只更新布局，保留现有终端、输出与输入内容。 */
  const [position, setPosition] = useState<TerminalPosition>(() => readStoredTerminalPosition(positionStorageKey));
  /** 宽度与底部高度独立，往返切换不互相覆盖。 */
  const [width, setWidth] = useState(defaultTerminalWidth);
  /** 当前方向决定分隔线使用的坐标轴。 */
  const right = position === 'right';
  /** 切换按钮描述点击后的目标位置。 */
  const moveLabel = right ? copy.moveBottom : copy.moveRight;
  const panelRef = useRef<HTMLElement | null>(null);
  const resizeStateRef = useRef<{ pointerId: number; startCoordinate: number; startSize: number } | null>(null);
  const activeSurfaceRef = useRef<TerminalSurfaceHandle | null>(null);
  const mountedRef = useRef(true);
  const loadRevisionRef = useRef(0);
  const startInFlightRef = useRef(false);
  const autoStartAttemptRef = useRef<string | null>(null);
  const closeInFlightRef = useRef(false);
  const activeSession = useMemo(() => sessions.find((session) => session.id === activeSessionId) ?? null, [activeSessionId, sessions]);
  const preferredCwd = useMemo(() => resolveTerminalCwd(props.projectPath, props.cwd), [props.cwd, props.projectPath]);

  const loadPanel = useCallback(async (): Promise<void> => {
    const revision = ++loadRevisionRef.current;
    setPhase({ kind: 'loading' });
    setError(null);
    try {
      const [runtimeStatus, projectConfig, runtimeSessions] = await Promise.all([props.client.loadRuntimeStatus(), props.client.loadProjectConfig(props.projectId), props.client.loadRuntimeSessions({ projectId: props.projectId })]);
      if (revision !== loadRevisionRef.current) return;
      if (runtimeStatus.terminal?.provider !== 'node-pty' || runtimeStatus.terminal.pty.available !== true) {
        setPhase({ kind: 'unavailable', reason: runtimeStatus.terminal?.pty.reason ?? copy.unavailableTitle });
        return;
      }
      const terminals = runtimeSessions.filter((session) => !session.archived && isIntegratedTerminalSession(session) && terminalSessionCanReattach(session.status)).slice(0, maximumTerminalTabs);
      setSessions(terminals);
      setActiveSessionId((current) => (current && terminals.some((session) => session.id === current) ? current : (terminals[0]?.id ?? null)));
      setPhase({ kind: 'ready', shellAllowed: projectConfig.security.allowShell });
    } catch (loadError) {
      if (revision !== loadRevisionRef.current) return;
      setPhase({ kind: 'failed', message: terminalErrorMessage(loadError, props.language, copy.startupFailed) });
    }
  }, [copy.startupFailed, copy.unavailableTitle, props.client, props.language, props.projectId]);

  useEffect(() => {
    void loadPanel();
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [loadPanel]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const subscribe = props.client.subscribeRealtimeEvents;
    if (!subscribe) return;
    const unsubscribe = subscribe(
      (event) => {
        const sessionId = typeof event.payload.sessionId === 'string' ? event.payload.sessionId : null;
        if (!sessionId) return;
        if (event.type === 'runtime.session.output' || event.type === 'runtime.session.error') {
          if (activeSurfaceRef.current?.sessionId === sessionId) activeSurfaceRef.current.write(event);
          return;
        }
        if (event.type !== 'runtime.session.ended' && event.type !== 'runtime.session.stopped') return;
        const status = runtimeStatusValue(event.payload.status);
        setSessions((current) =>
          current.map((session) =>
            session.id === sessionId
              ? { ...session, status: status ?? session.status, exitCode: runtimeExitCode(event.payload.exitCode), endedAt: typeof event.payload.endedAt === 'string' ? event.payload.endedAt : session.endedAt }
              : session,
          ),
        );
        if (activeSurfaceRef.current?.sessionId === sessionId) activeSurfaceRef.current.refresh();
      },
      (connectionState) => {
        if (connectionState === 'connected') activeSurfaceRef.current?.refresh();
      },
    );
    return () => unsubscribe?.();
  }, [props.client]);

  useEffect(() => {
    if (props.visible) activeSurfaceRef.current?.focus();
  }, [props.focusRequest, props.visible]);

  useEffect(() => {
    const panel = panelRef.current;
    const root = panel?.closest('.session-workspace-root');
    if (!panel || !root) return;
    const observer = new ResizeObserver(() => {
      setHeight((current) => clampTerminalHeight(current, root.getBoundingClientRect().height));
      setWidth((current) => Math.min(Math.max(minimumTerminalWidth, current), root.getBoundingClientRect().width * 0.5));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  const registerSurface = useCallback((surface: TerminalSurfaceHandle | null): void => {
    activeSurfaceRef.current = surface;
  }, []);

  const startTerminal = useCallback(async (): Promise<void> => {
    if (startInFlightRef.current || phase.kind !== 'ready') return;
    startInFlightRef.current = true;
    setStarting(true);
    setError(null);
    try {
      let shellAllowed = phase.shellAllowed;
      if (!shellAllowed) {
        if (!props.client.enableProjectShell) throw new Error(copy.permissionUnavailable);
        const config = await props.client.enableProjectShell(props.projectId);
        shellAllowed = config.security.allowShell;
        if (!shellAllowed) throw new Error(copy.permissionUnavailable);
        if (mountedRef.current) setPhase({ kind: 'ready', shellAllowed: true });
      }
      const request: Omit<StartRuntimeSessionRequest, 'confirmationId'> = {
        projectId: props.projectId,
        ...(props.taskId ? { taskId: props.taskId } : {}),
        command: integratedTerminalCommand,
        args: [...integratedTerminalArgs],
        cwd: preferredCwd,
      };
      const confirmation = await props.client.createRuntimeConfirmation({
        action: 'start_generic_session',
        reason: `用户在会话终端中确认启动项目 Shell：${props.projectName}`,
        session: request,
      });
      const confirmed = await props.client.confirmRuntimeOperation(confirmation.id);
      const session = await props.client.startRuntimeSession({ ...request, confirmationId: confirmed.id });
      if (mountedRef.current) {
        setSessions((current) => [session, ...current.filter((candidate) => candidate.id !== session.id)].slice(0, maximumTerminalTabs));
        setActiveSessionId(session.id);
      }
    } catch (startError) {
      if (mountedRef.current) setError(terminalErrorMessage(startError, props.language, copy.startupFailed));
    } finally {
      startInFlightRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  }, [copy.permissionUnavailable, copy.startupFailed, phase, preferredCwd, props.client, props.language, props.projectId, props.projectName, props.taskId]);

  useEffect(() => {
    if (!props.visible || phase.kind !== 'ready' || !phase.shellAllowed || sessions.length > 0 || startInFlightRef.current) return;
    if (autoStartAttemptRef.current === props.projectId) return;
    autoStartAttemptRef.current = props.projectId;
    void startTerminal();
  }, [phase, props.projectId, props.visible, sessions.length, startTerminal]);

  function requestCloseSession(session: AiRuntimeSession): void {
    if (!terminalSessionIsLive(session.status)) {
      removeSessionTab(session.id);
      return;
    }
    void closeSession(session.id);
  }

  async function closeSession(sessionId: string): Promise<void> {
    if (closingSessionId || closeInFlightRef.current) return;
    closeInFlightRef.current = true;
    setClosingSessionId(sessionId);
    setError(null);
    try {
      await props.client.stopRuntimeSession(sessionId);
      if (mountedRef.current) {
        removeSessionTab(sessionId);
      }
    } catch (closeError) {
      if (mountedRef.current) setError(terminalErrorMessage(closeError, props.language, copy.startupFailed));
    } finally {
      closeInFlightRef.current = false;
      if (mountedRef.current) setClosingSessionId(null);
    }
  }

  function removeSessionTab(sessionId: string): void {
    const index = sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return;
    const next = sessions.filter((session) => session.id !== sessionId);
    setSessions(next);
    setActiveSessionId((current) => (current === sessionId ? (next[Math.min(Math.max(index, 0), Math.max(next.length - 1, 0))]?.id ?? null) : current));
    if (next.length === 0) {
      autoStartAttemptRef.current = null;
      props.onClose();
    }
  }

  function updateSessionStatus(sessionId: string, status: AiRuntimeSessionStatus): void {
    setSessions((current) => current.map((session) => (session.id === sessionId && session.status !== status ? { ...session, status } : session)));
  }

  /** 当前方向的尺寸上限始终为正文保留空间。 */
  function terminalMaximumSize(): number {
    /** 会话根节点覆盖终端与正文，避免根据自身尺寸反复收缩。 */
    const bounds = panelRef.current?.closest('.session-workspace-root')?.getBoundingClientRect();
    return right ? (bounds?.width ?? window.innerWidth) * 0.5 : maximumTerminalHeight(bounds?.height ?? window.innerHeight);
  }

  /** 窄窗口优先保留正文，分隔线的最小值不超过实际可用上限。 */
  const minimumSize = right ? Math.min(minimumTerminalWidth, terminalMaximumSize()) : minimumTerminalHeight;
  /** 当前方向的已选尺寸，用于键盘及指针调整。 */
  const size = right ? width : height;

  /** 拖动和键盘共用边界处理，避免越界尺寸写回终端。 */
  function clampSize(nextSize: number): number {
    return Math.min(terminalMaximumSize(), Math.max(minimumSize, Math.round(nextSize)));
  }

  /** 完成拖动后继续沿用底部高度的既有持久化行为。 */
  function commitSize(nextSize: number): void {
    /** 只保存当前方向的有效尺寸。 */
    const clamped = clampSize(nextSize);
    if (right) {
      setWidth(clamped);
      return;
    }
    setHeight(clamped);
    try {
      window.localStorage.setItem(terminalHeightStorageKey, String(clamped));
    } catch {
      // 浏览器存储不可用时，当前窗口仍保留用户调整结果。
    }
  }

  /** 用户点击后立即切换，并把选择写入当前项目的本机偏好。 */
  function togglePosition(): void {
    /** 两种停靠方向互相切换，不创建或结束后台进程。 */
    const next = right ? 'bottom' : 'right';
    setPosition(next);
    try {
      window.localStorage.setItem(positionStorageKey, next);
    } catch {
      // 存储不可用时仍允许本次切换，下次打开使用默认位置。
    }
  }

  /** 两个方向分别保留尺寸，仅 CSS 决定当前使用哪一个。 */
  const panelStyle = { '--session-terminal-height': `${height}px`, '--session-terminal-width': `${width}px` } as CSSProperties;

  return (
    <section
      ref={panelRef}
      className="session-terminal-panel"
      style={panelStyle}
      aria-label={copy.panel}
      aria-hidden={!props.visible}
      inert={!props.visible}
      data-open={props.visible}
      data-position={position}
      data-resizing={resizeStateRef.current ? 'true' : undefined}
    >
      <div
        className="session-terminal-resizer"
        role="separator"
        aria-label={right ? copy.resizeWidth : copy.resize}
        aria-orientation={right ? 'vertical' : 'horizontal'}
        aria-valuemin={minimumSize}
        aria-valuemax={terminalMaximumSize()}
        aria-valuenow={size}
        tabIndex={0}
        onDoubleClick={() => commitSize(right ? defaultTerminalWidth : defaultTerminalHeight)}
        onPointerDown={(event) => {
          resizeStateRef.current = { pointerId: event.pointerId, startCoordinate: right ? event.clientX : event.clientY, startSize: size };
          event.currentTarget.setPointerCapture(event.pointerId);
          panelRef.current?.setAttribute('data-resizing', 'true');
        }}
        onPointerMove={(event) => {
          const state = resizeStateRef.current;
          if (!state || state.pointerId !== event.pointerId) return;
          (right ? setWidth : setHeight)(clampSize(state.startSize + state.startCoordinate - (right ? event.clientX : event.clientY)));
        }}
        onPointerUp={(event) => {
          const state = resizeStateRef.current;
          if (!state || state.pointerId !== event.pointerId) return;
          /** 松开时读取当前轴坐标，避免丢失最后一次移动。 */
          const nextSize = state.startSize + state.startCoordinate - (right ? event.clientX : event.clientY);
          resizeStateRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          panelRef.current?.removeAttribute('data-resizing');
          commitSize(nextSize);
        }}
        onPointerCancel={(event) => {
          resizeStateRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          panelRef.current?.removeAttribute('data-resizing');
        }}
        onKeyDown={(event) => {
          /** 水平布局使用左右键，底部布局使用上下键。 */
          const growKey = right ? 'ArrowLeft' : 'ArrowUp';
          /** 向正文反方向移动会缩小终端。 */
          const shrinkKey = right ? 'ArrowRight' : 'ArrowDown';
          if (event.key === growKey || event.key === shrinkKey) {
            event.preventDefault();
            commitSize(size + (event.key === growKey ? 20 : -20));
          } else if (event.key === 'Home') {
            event.preventDefault();
            commitSize(minimumSize);
          } else if (event.key === 'End') {
            event.preventDefault();
            commitSize(terminalMaximumSize());
          }
        }}
      />
      <header className="zeus-terminal-toolbar">
        <TerminalTabs
          sessions={sessions}
          activeId={activeSessionId}
          panelId={panelId}
          language={props.language}
          visible={props.visible}
          starting={starting}
          newDisabled={starting || Boolean(closingSessionId) || phase.kind !== 'ready' || sessions.length >= maximumTerminalTabs}
          closingId={closingSessionId}
          closeDisabled={starting || Boolean(closingSessionId)}
          onSelect={setActiveSessionId}
          onNew={() => void startTerminal()}
          onClose={requestCloseSession}
        />
        <button type="button" className="zeus-terminal-action" aria-label={moveLabel} title={moveLabel} onClick={togglePosition}>
          {right ? <Rows aria-hidden="true" /> : <SidebarSimple aria-hidden="true" style={{ transform: 'scaleX(-1)' }} />}
        </button>
        <button type="button" className="zeus-terminal-action" aria-label={copy.closePanel} title={copy.closePanel} onClick={props.onClose}>
          <X aria-hidden="true" />
        </button>
      </header>
      {error ? (
        <div className="session-terminal-error" role="alert">
          <WarningCircle aria-hidden="true" />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={copy.cancel}>
            <X aria-hidden="true" />
          </button>
        </div>
      ) : null}
      <div className="session-terminal-body" role="tabpanel" id={panelId} aria-labelledby={activeSessionId ? `${panelId}-${activeSessionId}` : undefined}>
        {phase.kind === 'loading' ? (
          <TerminalEmptyState icon={<CircleNotch className="session-terminal-spinner" aria-hidden="true" />} title={copy.loading} />
        ) : phase.kind === 'unavailable' ? (
          <TerminalEmptyState
            icon={<WarningCircle aria-hidden="true" />}
            title={copy.unavailableTitle}
            detail={phase.reason}
            action={
              <button type="button" onClick={() => void loadPanel()}>
                {copy.retry}
              </button>
            }
          />
        ) : phase.kind === 'failed' ? (
          <TerminalEmptyState
            icon={<WarningCircle aria-hidden="true" />}
            title={copy.startupFailed}
            detail={phase.message}
            action={
              <button type="button" onClick={() => void loadPanel()}>
                {copy.retry}
              </button>
            }
          />
        ) : activeSession ? (
          <TerminalViewport
            key={activeSession.id}
            client={props.client}
            language={props.language}
            session={activeSession}
            focusRequest={props.focusRequest}
            registerSurface={registerSurface}
            onStatusChange={(status) => updateSessionStatus(activeSession.id, status)}
            onError={setError}
          />
        ) : phase.shellAllowed ? (
          <TerminalEmptyState
            icon={error ? <WarningCircle aria-hidden="true" /> : <CircleNotch className="session-terminal-spinner" aria-hidden="true" />}
            title={error ? copy.startupFailed : copy.starting}
            detail={error ?? undefined}
            action={
              error ? (
                <button type="button" onClick={() => void startTerminal()} disabled={starting}>
                  {copy.retry}
                </button>
              ) : undefined
            }
          />
        ) : (
          <TerminalEmptyState
            icon={<TerminalGlyph aria-hidden="true" />}
            title={copy.permissionTitle}
            detail={copy.permissionBody}
            action={
              <button type="button" onClick={() => void startTerminal()} disabled={starting} autoFocus>
                {starting ? <CircleNotch aria-hidden="true" className="session-terminal-spinner" /> : <Plus aria-hidden="true" />}
                {copy.allowAndStart}
              </button>
            }
          />
        )}
      </div>
    </section>
  );
}

function TerminalViewport(props: {
  client: SessionTerminalClient;
  language: 'zh-CN' | 'en-US';
  session: AiRuntimeSession;
  focusRequest: number;
  registerSurface: (surface: TerminalSurfaceHandle | null) => void;
  onStatusChange: (status: AiRuntimeSessionStatus) => void;
  onError: (message: string | null) => void;
}) {
  const copy = terminalCopy[props.language];
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const onErrorRef = useRef(props.onError);
  const onStatusChangeRef = useRef(props.onStatusChange);
  const sessionStatusRef = useRef(props.session.status);
  onErrorRef.current = props.onError;
  onStatusChangeRef.current = props.onStatusChange;
  sessionStatusRef.current = props.session.status;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let resizeFrame: number | null = null;
    let disposeBindings: (() => void) | undefined;
    let refreshRunning = false;
    let refreshPending = false;
    let hydrating = true;
    let coldTuiRedrawPending = false;
    let redrawTimer: number | null = null;
    const bufferedEvents: ZeusRealtimeEvent[] = [];
    const seenLogIds = new Set<string>();
    const io = createTerminalIoPump(props.client, props.session.id, (ioError) => {
      if (!disposed) onErrorRef.current(terminalErrorMessage(ioError, props.language, copy.startupFailed));
    });

    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')])
      .then(([{ Terminal }, { FitAddon }]) => {
        if (disposed || !hostRef.current) return;
        /** 内容区使用命令入口的共享显示配置。 */
        const terminal = new Terminal({
          ...terminalDisplayOptions,
          allowTransparency: false,
          convertEol: false,
          disableStdin: !terminalSessionIsLive(sessionStatusRef.current),
          rows: 20,
          cols: 80,
          scrollback: 10_000,
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminalRef.current = terminal;
        terminal.open(hostRef.current);
        const dataSubscription = terminal.onData((value) => io.input(value));
        const resizeObserver = new ResizeObserver(() => scheduleFit());
        resizeObserver.observe(hostRef.current);
        /** 主题切换仅更新现有终端的颜色。 */
        const disposeTheme = observeTerminalTheme(terminal, hostRef.current);

        const surface: TerminalSurfaceHandle = {
          sessionId: props.session.id,
          focus: () => terminal.focus(),
          refresh: () => void refresh(false),
          write: (event) => {
            if (hydrating) {
              bufferedEvents.push(event);
              return;
            }
            writeRealtimeEvent(terminal, event, seenLogIds);
          },
        };
        props.registerSurface(surface);

        function scheduleFit(): void {
          if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            // 收起立即停止同步尺寸，保留后台终端大小，不把退出动画中的零高度写回 Shell。
            if (!host || host.closest('[inert]') || host.clientHeight === 0) return;
            const proposed = fitAddon.proposeDimensions();
            if (!proposed || (proposed.cols === terminal.cols && proposed.rows === terminal.rows)) return;
            fitAddon.fit();
            io.resize({ cols: terminal.cols, rows: terminal.rows });
          });
        }

        async function refresh(reset: boolean): Promise<void> {
          if (refreshRunning) {
            refreshPending = true;
            return;
          }
          refreshRunning = true;
          try {
            const snapshot = await props.client.loadRuntimeTerminalSnapshot(props.session.id);
            if (disposed) return;
            if (reset) {
              terminal.reset();
              seenLogIds.clear();
            }
            if (reset && terminalSnapshotNeedsLiveRedraw(snapshot)) {
              rememberTerminalSnapshotLogs(snapshot, seenLogIds);
              // 截断尾部可能从半个 ANSI 帧开始；先进入干净的备用屏，再让仍存活的 TUI 通过 SIGWINCH 输出完整当前帧。
              terminal.write(alternateScreenResetSequence);
              coldTuiRedrawPending = true;
            } else {
              writeTerminalSnapshot(terminal, snapshot, seenLogIds);
            }
            onStatusChangeRef.current(snapshot.status);
          } catch (refreshError) {
            if (!disposed) onErrorRef.current(terminalErrorMessage(refreshError, props.language, copy.startupFailed));
          } finally {
            refreshRunning = false;
            if (refreshPending && !disposed) {
              refreshPending = false;
              void refresh(false);
            }
          }
        }

        scheduleFit();
        void refresh(true).finally(() => {
          if (disposed) return;
          hydrating = false;
          if (coldTuiRedrawPending) {
            coldTuiRedrawPending = false;
            bufferedEvents.length = 0;
            redrawTimer = requestLiveTerminalRedraw(terminal, io, () => disposed);
          } else {
            for (const event of bufferedEvents.splice(0)) writeRealtimeEvent(terminal, event, seenLogIds);
          }
          terminal.focus();
        });
        disposeBindings = () => {
          dataSubscription.dispose();
          resizeObserver.disconnect();
          disposeTheme();
        };
      })
      .catch((loadError) => {
        if (!disposed) onErrorRef.current(terminalErrorMessage(loadError, props.language, copy.startupFailed));
      });

    return () => {
      disposed = true;
      props.registerSurface(null);
      disposeBindings?.();
      io.dispose();
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (redrawTimer !== null) window.clearTimeout(redrawTimer);
      terminalRef.current?.dispose();
      terminalRef.current = null;
    };
  }, [copy.startupFailed, props.client, props.language, props.registerSurface, props.session.id]);

  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.disableStdin = !terminalSessionIsLive(props.session.status);
  }, [props.session.status]);

  useEffect(() => {
    terminalRef.current?.focus();
  }, [props.focusRequest]);

  return <div ref={hostRef} className="zeus-terminal-screen" aria-label={copy.terminalAria} data-terminal-status={props.session.status} />;
}

function TerminalEmptyState(props: { icon: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="session-terminal-empty-state">
      {props.icon}
      <strong>{props.title}</strong>
      {props.detail ? <p>{props.detail}</p> : null}
      {props.action}
    </div>
  );
}

function createTerminalIoPump(
  client: SessionTerminalClient,
  sessionId: string,
  onError: (error: unknown) => void,
): {
  input(value: string): void;
  resize(size: { cols: number; rows: number }): void;
  dispose(): void;
} {
  type Operation = { kind: 'input'; value: string } | { kind: 'resize'; value: { cols: number; rows: number } };
  const operations: Operation[] = [];
  let draining = false;
  let disposed = false;
  let scheduledDrain: number | null = null;

  const scheduleDrain = (immediate = false): void => {
    if (draining || disposed || scheduledDrain !== null) return;
    scheduledDrain = window.setTimeout(
      () => {
        scheduledDrain = null;
        void drain();
      },
      immediate ? 0 : 8,
    );
  };

  const drain = async (): Promise<void> => {
    if (draining || disposed) return;
    draining = true;
    try {
      while (!disposed && operations.length > 0) {
        const operation = operations.shift()!;
        try {
          if (operation.kind === 'input') await client.sendRuntimeInput(sessionId, operation.value);
          else await client.resizeRuntimeSession(sessionId, operation.value);
        } catch (error) {
          onError(error);
        }
      }
    } finally {
      draining = false;
      if (!disposed && operations.length > 0) scheduleDrain(true);
    }
  };

  return {
    input(value) {
      if (disposed || !value) return;
      for (let offset = 0; offset < value.length; offset += maximumTerminalInputChunk) {
        const chunk = value.slice(offset, offset + maximumTerminalInputChunk);
        const tail = operations.at(-1);
        if (tail?.kind === 'input' && tail.value.length + chunk.length <= maximumTerminalInputChunk) tail.value += chunk;
        else operations.push({ kind: 'input', value: chunk });
      }
      scheduleDrain(value.includes('\r') || value.includes('\n'));
    },
    resize(size) {
      if (disposed) return;
      const tail = operations.at(-1);
      if (tail?.kind === 'resize') tail.value = size;
      else operations.push({ kind: 'resize', value: size });
      scheduleDrain();
    },
    dispose() {
      disposed = true;
      operations.length = 0;
      if (scheduledDrain !== null) window.clearTimeout(scheduledDrain);
    },
  };
}

function writeTerminalSnapshot(terminal: import('@xterm/xterm').Terminal, snapshot: AiRuntimeTerminalSnapshot, seenLogIds: Set<string>): void {
  const chunks: string[] = [];
  for (const log of snapshot.logs) {
    if (seenLogIds.has(log.id)) continue;
    seenLogIds.add(log.id);
    if (log.stream === 'system') continue;
    chunks.push(log.text);
  }
  // 单次交给 xterm 解析，避免高频 TUI 冷回放时为每个数据库块建立独立解析任务。
  if (chunks.length > 0) terminal.write(chunks.join(''));
  terminal.options.disableStdin = !terminalSessionIsLive(snapshot.status);
}

function rememberTerminalSnapshotLogs(snapshot: AiRuntimeTerminalSnapshot, seenLogIds: Set<string>): void {
  for (const log of snapshot.logs) seenLogIds.add(log.id);
}

function terminalSnapshotNeedsLiveRedraw(snapshot: AiRuntimeTerminalSnapshot): boolean {
  if (snapshot.status !== 'running' || !snapshot.logsTruncated) return false;
  return snapshot.logs.some((log) => log.stream !== 'system' && (log.text.includes(synchronizedOutputSequence) || log.text.includes('\u001b[?1049h') || log.text.includes('\u001b[?1047h')));
}

function requestLiveTerminalRedraw(terminal: import('@xterm/xterm').Terminal, io: { resize(size: { cols: number; rows: number }): void }, disposed: () => boolean): number | null {
  const cols = terminal.cols;
  const rows = terminal.rows;
  if (cols <= 1 || rows <= 2) {
    io.resize({ cols, rows });
    return null;
  }
  const transientRows = rows - 1;
  terminal.resize(cols, transientRows);
  io.resize({ cols, rows: transientRows });
  return window.setTimeout(() => {
    if (disposed()) return;
    // 给 TUI 足够时间结束第一轮同步帧；随后清屏并以最终尺寸触发一张完整帧，避免两次 SIGWINCH 交错。
    terminal.write(alternateScreenResetSequence, () => {
      if (disposed()) return;
      terminal.resize(cols, rows);
      io.resize({ cols, rows });
    });
  }, 250);
}

function writeRealtimeEvent(terminal: import('@xterm/xterm').Terminal, event: ZeusRealtimeEvent, seenLogIds: Set<string>): void {
  const logId = typeof event.payload.logId === 'string' ? event.payload.logId : null;
  if (logId && seenLogIds.has(logId)) return;
  if (logId) seenLogIds.add(logId);
  const text = typeof event.payload.terminalText === 'string' ? event.payload.terminalText : typeof event.payload.text === 'string' ? event.payload.text : '';
  if (text) terminal.write(text);
}

function runtimeStatusValue(value: unknown): AiRuntimeSessionStatus | null {
  return value === 'running' || value === 'exited' || value === 'failed' || value === 'stopped' || value === 'orphan_detected' || value === 'lost' ? value : null;
}

function runtimeExitCode(value: unknown): number | null | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : value === null ? null : undefined;
}

function terminalSessionIsLive(status: AiRuntimeSessionStatus): boolean {
  return status === 'running';
}

function terminalSessionCanReattach(status: AiRuntimeSessionStatus): boolean {
  return status === 'running' || status === 'orphan_detected';
}

export function isIntegratedTerminalSession(session: Pick<AiRuntimeSession, 'command' | 'args'>): boolean {
  return session.command === integratedTerminalCommand && session.args.length === integratedTerminalArgs.length && session.args.every((arg, index) => arg === integratedTerminalArgs[index]);
}

export function isSessionTerminalShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'>): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && (event.code === 'Backquote' || event.key === '`');
}

function resolveTerminalCwd(projectPath: string, candidate: string | null | undefined): string {
  const normalizedProject = normalizeComparablePath(projectPath);
  const normalizedCandidate = normalizeComparablePath(candidate ?? '');
  if (normalizedCandidate === normalizedProject || normalizedCandidate.startsWith(`${normalizedProject}/`)) return candidate!.trim();
  return projectPath;
}

function normalizeComparablePath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/u, '');
}

/** 只接受明确保存的底部选择；缺失、损坏或不可读取时默认右侧。 */
function readStoredTerminalPosition(storageKey: string): TerminalPosition {
  try {
    return window.localStorage.getItem(storageKey) === 'bottom' ? 'bottom' : 'right';
  } catch {
    return 'right';
  }
}

function readStoredTerminalHeight(): number {
  if (typeof window === 'undefined') return defaultTerminalHeight;
  try {
    const stored = Number(window.localStorage.getItem(terminalHeightStorageKey));
    return Number.isFinite(stored) ? Math.max(minimumTerminalHeight, Math.round(stored)) : defaultTerminalHeight;
  } catch {
    return defaultTerminalHeight;
  }
}

function clampTerminalHeight(height: number, rootHeight: number): number {
  return Math.min(maximumTerminalHeight(rootHeight), Math.max(minimumTerminalHeight, Math.round(height)));
}

function maximumTerminalHeight(rootHeight: number): number {
  return Math.max(minimumTerminalHeight, Math.floor(rootHeight * 0.66));
}

function terminalErrorMessage(error: unknown, language: 'zh-CN' | 'en-US', fallback: string): string {
  const code = error && typeof error === 'object' && 'error' in error && typeof error.error === 'string' ? error.error : null;
  if (code === 'ZEUS_RUNTIME_SHELL_PERMISSION_REQUIRED') {
    return language === 'zh-CN' ? '请先允许此项目使用 Shell，再启动终端。' : 'Allow Shell for this project before starting a terminal.';
  }
  if (code === 'ZEUS_RUNTIME_CWD_OUTSIDE_PROJECT') {
    return language === 'zh-CN' ? '当前会话工作目录不在项目范围内，无法启动终端。' : 'The conversation working folder is outside the project, so the terminal cannot start.';
  }
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}
