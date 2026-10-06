import { MotionPresence } from './ui/MotionPresence.js';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ClockCounterClockwiseIcon as ClockCounterClockwise } from '@phosphor-icons/react/dist/csr/ClockCounterClockwise';
import { CheckIcon as CheckGlyph } from '@phosphor-icons/react/dist/csr/Check';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { DownloadSimpleIcon as DownloadSimple } from '@phosphor-icons/react/dist/csr/DownloadSimple';
import { FolderSimpleIcon as FolderSimple } from '@phosphor-icons/react/dist/csr/FolderSimple';
import { QuestionIcon as Question } from '@phosphor-icons/react/dist/csr/Question';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PlayIcon as Play } from '@phosphor-icons/react/dist/csr/Play';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { StopIcon as Stop } from '@phosphor-icons/react/dist/csr/Stop';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { commandNeedsHighRiskConfirmation, type CommandRiskFlags } from '@zeus/shared';
import { projectTerminalOutput } from '@zeus/shared';
import {
  isLikelyLocalServerConnectionError,
  ZeusApiError,
  type CommandArtifact,
  type CommandDefinition,
  type CommandDefinitionInput,
  type CommandParameterDefinition,
  type CommandRun,
  type CommandRunDetail,
  type DashboardClient,
  type ProjectConfig,
  type ProjectRecord,
  type SaveProjectConfigRequest,
  type ZeusRealtimeEvent,
} from './apiClient.js';
import { Button } from './ui/Button.js';
import { ModalPortal } from './ui/ModalPortal.js';
import { MenuSurface } from './ui/MenuSurface.js';
import { VisibleApplicationError } from './ui/ApplicationErrorDialog.js';
import './commandCenter.css';
import { ProjectTerminalPanel } from './features/runtime/ProjectTerminalPanel.js';

export interface CommandCenterPanelProps {
  mode: 'global' | 'project';
  project?: ProjectRecord;
  client: DashboardClient;
  language: 'zh-CN' | 'en-US';
}

interface CommandDraft {
  name: string;
  aliases: string;
  title: string;
  description: string;
  command: string;
  timeoutSeconds: string;
  enabled: boolean;
  telegramEnabled: boolean;
  riskFlags: CommandRiskFlags;
  parameters: CommandParameterDefinition[];
}

interface CommandPermissionRequest {
  command: CommandDefinition;
  missingShell: boolean;
  missingGitWrite: boolean;
}

const emptyDraft: CommandDraft = {
  name: '',
  aliases: '',
  title: '',
  description: '',
  command: '',
  timeoutSeconds: '300',
  enabled: true,
  telegramEnabled: false,
  riskFlags: { gitWrite: false, outsideProjectWrite: false, externalServiceWrite: false },
  parameters: [],
};

const COMMAND_RUN_LOG_PAGE_SIZE = 1_000;
const MAX_DISPLAYED_COMMAND_RUN_LOGS = 2_000;
const MAX_DISPLAYED_COMMAND_RUN_LOG_BYTES = 4 * 1024 * 1024;
const COMMAND_RUN_LOG_FOLLOW_DISTANCE_PX = 24;
const COMMAND_RUN_COPY_SUCCESS_DURATION_MS = 2_000;
const COMMAND_RUN_POLL_INTERVAL_MS = 1_000;
const COMMAND_RUN_SYNC_STALE_MS = 3_000;
const COMMAND_RUN_EVENT_REFRESH_DELAY_MS = 100;
const UTF8_ENCODER = new TextEncoder();

/** 两份系统归档日志使用导出入口，其他文件使用输出文件入口。 */
const COMMAND_RUN_LOG_ARTIFACT_PATHS = new Set(['logs/terminal.raw.log', 'logs/terminal.normalized.log']);
/** 菜单按同一宽度对齐触发按钮，实际窗口边缘由共用菜单组件校正。 */
const COMMAND_RUN_FILE_MENU_WIDTH_PX = 280;

type CommandRunSyncState = 'syncing' | 'live' | 'stale';

function CommandRunDurationValue(props: { run: CommandRun; zh: boolean }) {
  const shouldTick = props.run.status === 'running' && Boolean(props.run.startedAt) && !props.run.endedAt;
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!shouldTick) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [shouldTick, props.run.startedAt]);

  return <span className="command-run-duration">{formatRunDuration(props.run, nowMs, props.zh)}</span>;
}

type CommandRunCopyState = 'idle' | 'copying' | 'copied' | 'too_large' | 'failed';

function constrainSelectionToContainer(container: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!range.intersectsNode(container)) return;
  const constrained = range.cloneRange();
  if (!container.contains(constrained.startContainer)) constrained.setStart(container, 0);
  if (!container.contains(constrained.endContainer)) constrained.setEnd(container, container.childNodes.length);
  if (constrained.startContainer === range.startContainer && constrained.startOffset === range.startOffset && constrained.endContainer === range.endContainer && constrained.endOffset === range.endOffset) return;
  selection.removeAllRanges();
  selection.addRange(constrained);
}

function beginCommandRunLogSelection(event: ReactPointerEvent<HTMLPreElement>): void {
  if (event.button !== 0) return;
  const container = event.currentTarget;
  const finish = () => {
    window.removeEventListener('pointercancel', cancel, true);
    // Chromium 没有实现 user-select: contain；松开鼠标时把跨界选区夹回日志正文。
    constrainSelectionToContainer(container);
  };
  const cancel = () => window.removeEventListener('pointerup', finish, true);
  window.addEventListener('pointerup', finish, { capture: true, once: true });
  window.addEventListener('pointercancel', cancel, { capture: true, once: true });
}

/** 文件操作按需展开，不占用终端正文；复用菜单的关闭、定位和键盘规则。 */
function CommandRunFileActions(props: { artifacts: CommandArtifact[]; client: DashboardClient; zh: boolean }) {
  /** 原始输出与整理日志均可独立导出，避免丢失排查所需信息。 */
  const logArtifacts = props.artifacts.filter((artifact) => COMMAND_RUN_LOG_ARTIFACT_PATHS.has(artifact.relativePath));
  /** 命令显式生成的文件使用独立入口，数量不包含系统日志。 */
  const outputArtifacts = props.artifacts.filter((artifact) => !COMMAND_RUN_LOG_ARTIFACT_PATHS.has(artifact.relativePath));
  /** 菜单定位同时记录所属入口，切换记录时随终端一起重建。 */
  const [menu, setMenu] = useState<{ kind: 'logs' | 'files'; left: number; top: number } | null>(null);
  /** 菜单留在当前弹窗的门户根内，避免被终端裁切或被焦点隔离排除。 */
  const menuHostRef = useRef<HTMLElement | null>(null);
  /** 同一菜单的触发器与读屏名称共享稳定标识。 */
  const menuId = useId();
  /** 读取文件期间禁止重复提交，失败后保留原选项供重试。 */
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  /** 文件读取失败直接在菜单内显示，不改变运行状态或打开新弹窗。 */
  const [downloadFailed, setDownloadFailed] = useState(false);
  /** 当前入口只呈现对应文件，不为每次打开重复请求列表。 */
  const visibleArtifacts = menu?.kind === 'logs' ? logArtifacts : outputArtifacts;

  /** 按按钮位置打开菜单，首次打开才创建浮层。 */
  function openMenu(kind: 'logs' | 'files', trigger: HTMLButtonElement): void {
    if (menu?.kind === kind) {
      setMenu(null);
      return;
    }
    /** 优先复用所属弹窗的门户，确保菜单仍在当前模态操作范围内。 */
    menuHostRef.current = trigger.closest<HTMLElement>('.zeus-modal-portal-root') ?? document.body;
    /** 浮层宽度与定位使用同一配置。 */
    const bounds = trigger.getBoundingClientRect();
    setDownloadFailed(false);
    setMenu({ kind, left: bounds.right - COMMAND_RUN_FILE_MENU_WIDTH_PX, top: bounds.bottom + 6 });
  }

  /** 下载归档的完整文件，不使用当前界面截取的日志内容。 */
  async function downloadArtifact(artifact: CommandArtifact): Promise<void> {
    if (downloadingId) return;
    setDownloadingId(artifact.id);
    setDownloadFailed(false);
    try {
      /** 现有内容接口保留文件授权、类型和原始字节。 */
      const blob = await props.client.loadCommandArtifact(artifact.id);
      /** 临时地址只服务本次下载，不在历史记录中累积缓存。 */
      const url = URL.createObjectURL(blob);
      try {
        /** 浏览器和 Electron 使用原生下载流程，文件名保留原始扩展名。 */
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = artifact.relativePath.split('/').at(-1) || artifact.relativePath;
        anchor.click();
      } finally {
        // 下一轮事件循环释放地址，让原生下载有机会接管文件。
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      setMenu(null);
    } catch {
      setDownloadFailed(true);
    } finally {
      setDownloadingId(null);
    }
  }

  return (
    <>
      {logArtifacts.length > 0 ? (
        <button
          type="button"
          className="command-run-log-action"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'logs'}
          aria-controls={menu?.kind === 'logs' ? menuId : undefined}
          disabled={Boolean(downloadingId)}
          onClick={(event) => openMenu('logs', event.currentTarget)}
        >
          <DownloadSimple aria-hidden="true" />
          <span>{props.zh ? '导出日志' : 'Export logs'}</span>
          <CaretDown aria-hidden="true" />
        </button>
      ) : null}
      {outputArtifacts.length > 0 ? (
        <button
          type="button"
          className="command-run-log-action"
          aria-haspopup="menu"
          aria-expanded={menu?.kind === 'files'}
          aria-controls={menu?.kind === 'files' ? menuId : undefined}
          disabled={Boolean(downloadingId)}
          onClick={(event) => openMenu('files', event.currentTarget)}
        >
          <span>
            {props.zh ? '输出文件' : 'Output files'} ({outputArtifacts.length})
          </span>
          <CaretDown aria-hidden="true" />
        </button>
      ) : null}
      <MotionPresence>
        {menu && menuHostRef.current
          ? createPortal(
              <MenuSurface
                id={menuId}
                className="command-run-file-menu"
                aria-label={menu.kind === 'logs' ? (props.zh ? '导出日志' : 'Export logs') : props.zh ? '输出文件' : 'Output files'}
                style={{ left: menu.left, top: menu.top, width: COMMAND_RUN_FILE_MENU_WIDTH_PX }}
                onClose={() => setMenu(null)}
              >
                {visibleArtifacts.map((artifact) => (
                  <button
                    key={artifact.id}
                    type="button"
                    role="menuitem"
                    disabled={Boolean(downloadingId)}
                    aria-busy={downloadingId === artifact.id || undefined}
                    title={artifact.relativePath}
                    onClick={() => void downloadArtifact(artifact)}
                  >
                    {downloadingId === artifact.id ? <CircleNotch className="command-run-copy-spinner" aria-hidden="true" /> : <DownloadSimple aria-hidden="true" />}
                    <span>
                      <strong>{menu.kind === 'logs' ? (artifact.relativePath === 'logs/terminal.raw.log' ? (props.zh ? '原始日志' : 'Raw logs') : props.zh ? '整理日志' : 'Formatted logs') : artifact.relativePath}</strong>
                      <small>{downloadingId === artifact.id ? (props.zh ? '正在导出…' : 'Exporting…') : formatBytes(artifact.byteLength)}</small>
                    </span>
                  </button>
                ))}
                {downloadFailed ? <p role="alert">{props.zh ? '导出失败，请重试。' : 'Export failed. Please try again.'}</p> : null}
              </MenuSurface>,
              menuHostRef.current,
            )
          : null}
      </MotionPresence>
    </>
  );
}

/** 运行说明并入终端，正文保留独立滚动、尾部跟随、完整复制与文件导出。 */
function CommandRunLog(props: { runId: string; content: string; ariaLabel: string; hasLogs: boolean; failureReason: string | null; artifacts: CommandArtifact[]; client: DashboardClient; zh: boolean }) {
  /** 正文容器只负责日志滚动和选区。 */
  const containerRef = useRef<HTMLPreElement>(null);
  /** 切换记录时重新定位到日志尾部。 */
  const followedRunIdRef = useRef(props.runId);
  /** 用户上滚后暂停跟随，回到底部时恢复。 */
  const shouldFollowLatestRef = useRef(true);
  /** 复制反馈独立于运行状态。 */
  const [copyState, setCopyState] = useState<CommandRunCopyState>('idle');

  useEffect(() => {
    if (copyState !== 'copied') return undefined;
    const timer = window.setTimeout(() => setCopyState('idle'), COMMAND_RUN_COPY_SUCCESS_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    if (followedRunIdRef.current !== props.runId) {
      followedRunIdRef.current = props.runId;
      shouldFollowLatestRef.current = true;
    }
    if (shouldFollowLatestRef.current) container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
  }, [props.content, props.runId]);

  useEffect(() => {
    /** 窗口和折叠内容改变终端尺寸时，延续用户当前的尾部跟随选择。 */
    const container = containerRef.current;
    if (!container) return;
    /** 观察实际正文尺寸，覆盖折叠动画和窗口缩放。 */
    const resizeObserver = new ResizeObserver(() => {
      if (shouldFollowLatestRef.current) container.scrollTo({ top: container.scrollHeight, behavior: 'instant' });
    });
    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  /** 按复制状态展示可访问名称和明确的恢复提示。 */
  const copyLabel =
    copyState === 'copying'
      ? props.zh
        ? '正在复制…'
        : 'Copying…'
      : copyState === 'copied'
        ? props.zh
          ? '已复制'
          : 'Copied'
        : copyState === 'too_large'
          ? props.zh
            ? '日志过大，请导出'
            : 'Too large; export logs'
          : copyState === 'failed'
            ? props.zh
              ? '复制失败，请重试'
              : 'Copy failed; retry'
            : props.zh
              ? '复制全部日志'
              : 'Copy all logs';

  /** 复制服务端完整输出，不把当前展示预算当作完整日志。 */
  async function copyCompleteLog(): Promise<void> {
    if (!props.hasLogs || copyState === 'copying') return;
    setCopyState('copying');
    try {
      const output = await props.client.loadCommandRunTerminalOutput(props.runId);
      if (!output.content || !(await writeCommandRunClipboard(output.content))) throw new Error('Clipboard write failed');
      setCopyState('copied');
    } catch (error) {
      setCopyState(error instanceof ZeusApiError && error.error === 'ZEUS_COMMAND_RUN_LOG_COPY_TOO_LARGE' ? 'too_large' : 'failed');
    }
  }

  return (
    <section className="command-run-log-shell" aria-label={props.ariaLabel}>
      <header className="command-run-log-toolbar">
        <strong>
          <TerminalWindow aria-hidden="true" />
          {props.ariaLabel}
        </strong>
        <div className="command-run-log-actions">
          <button
            className="command-run-log-action"
            type="button"
            disabled={!props.hasLogs || copyState === 'copying'}
            aria-busy={copyState === 'copying' || undefined}
            data-copy-state={copyState}
            aria-label={copyLabel}
            title={copyLabel}
            onClick={() => void copyCompleteLog()}
          >
            {copyState === 'copying' ? (
              <CircleNotch className="command-run-copy-spinner" aria-hidden="true" />
            ) : copyState === 'copied' ? (
              <CheckGlyph aria-hidden="true" />
            ) : copyState === 'too_large' || copyState === 'failed' ? (
              <WarningCircle aria-hidden="true" />
            ) : (
              <Copy aria-hidden="true" />
            )}
            <span>{copyState === 'idle' ? (props.zh ? '复制日志' : 'Copy logs') : copyLabel}</span>
          </button>
          <CommandRunFileActions artifacts={props.artifacts} client={props.client} zh={props.zh} />
        </div>
      </header>
      {props.failureReason ? (
        <details className="command-run-failure">
          <summary>
            <WarningCircle aria-hidden="true" />
            <span className="command-run-failure-preview">{props.failureReason}</span>
            <span className="command-run-disclosure-label">
              {props.zh ? '详情' : 'Details'}
              <CaretDown aria-hidden="true" />
            </span>
          </summary>
          <pre tabIndex={0}>{props.failureReason}</pre>
        </details>
      ) : null}
      <span className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {copyState === 'idle' ? '' : copyLabel}
      </span>
      <pre
        ref={containerRef}
        className="command-run-log"
        tabIndex={0}
        onPointerDown={beginCommandRunLogSelection}
        onScroll={(event) => {
          const container = event.currentTarget;
          const distanceFromBottom = Math.max(0, container.scrollHeight - container.clientHeight - container.scrollTop);
          // 用户主动上滚时保留历史阅读位置；手动回到底部后恢复跟随。
          shouldFollowLatestRef.current = distanceFromBottom <= COMMAND_RUN_LOG_FOLLOW_DISTANCE_PX;
        }}
      >
        {props.content}
      </pre>
    </section>
  );
}

async function writeCommandRunClipboard(content: string): Promise<boolean> {
  try {
    const result = await window.zeus?.writeClipboardText?.(content);
    if (result?.written) return true;
  } catch {
    // Electron 原生桥不可用时再尝试 Web Clipboard API。
  }
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
}

export function CommandCenterPanel(props: CommandCenterPanelProps) {
  const zh = props.language === 'zh-CN';
  /** 与浏览器工作区一样，将终端停靠到滚动正文之外。 */
  const [terminalHost, setTerminalHost] = useState<HTMLDivElement | null>(null);
  const [commands, setCommands] = useState<CommandDefinition[]>([]);
  const [runs, setRuns] = useState<CommandRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<CommandDefinition | 'new' | null>(null);
  const [draft, setDraft] = useState<CommandDraft>(emptyDraft);
  const [permissionRequest, setPermissionRequest] = useState<CommandPermissionRequest | null>(null);
  const [runningCommand, setRunningCommand] = useState<CommandDefinition | null>(null);
  const [runParameters, setRunParameters] = useState<Record<string, string | number | boolean>>({});
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [historyCommand, setHistoryCommand] = useState<CommandDefinition | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<CommandRunDetail | null>(null);
  const [runSyncState, setRunSyncState] = useState<CommandRunSyncState>('syncing');
  const runLogCursorRef = useRef<{ runId: string | null; nextSeq: number }>({ runId: null, nextSeq: 0 });
  const historyCommandIdRef = useRef<string | null>(null);

  const canMaintain = props.mode === 'global' || Boolean(props.project);
  const historyRuns = useMemo(() => (historyCommand ? runs.filter((run) => run.commandId === historyCommand.id) : []), [historyCommand, runs]);
  const activeHistoryRuns = useMemo(() => historyRuns.filter((run) => run.status === 'running'), [historyRuns]);
  const selectedRun = runs.find((run) => run.id === selectedRunId);
  const selectedRunIsActive = selectedRun?.status === 'running';
  const selectedRuntimeSessionId = selectedRun?.runtimeSessionId ?? null;
  const projectedRunLogContent = useMemo(() => {
    if (!runDetail) return '';
    const raw = `${runDetail.logsTruncated ? (zh ? '…仅显示最新日志，完整历史已保存在 Runtime 日志中。\n' : '…Showing recent logs only. The complete history remains in Runtime logs.\n') : ''}${joinRuntimeLogEntries(runDetail.logs)}`;
    return projectTerminalOutput(raw);
  }, [runDetail, zh]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const request = props.mode === 'global' ? props.client.loadGlobalCommands() : props.project ? props.client.loadProjectCommands(props.project.id) : Promise.resolve([]);
    void request
      .then((items) => {
        if (active) setCommands(items);
      })
      .catch((loadError) => {
        if (active) setError(loadError);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.mode, props.project?.id]);

  useEffect(() => {
    historyCommandIdRef.current = null;
    setHistoryCommand(null);
    setSelectedRunId(null);
    if (props.mode !== 'project' || !props.project) {
      setRuns([]);
      return;
    }
    let active = true;
    void props.client
      .loadCommandRuns(props.project.id)
      .then((items) => {
        if (active) setRuns(items);
      })
      .catch((loadError) => {
        if (active) setError(loadError);
      });
    return () => {
      active = false;
    };
  }, [props.client, props.mode, props.project?.id]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      setRunSyncState('syncing');
      runLogCursorRef.current = { runId: null, nextSeq: 0 };
      return;
    }
    if (runLogCursorRef.current.runId !== selectedRunId) {
      runLogCursorRef.current = { runId: selectedRunId, nextSeq: 0 };
      setRunDetail((current) => (current?.run.id === selectedRunId ? current : null));
    }
    let active = true;
    let loading = false;
    let refreshQueued = false;
    let eventRefreshTimer: number | undefined;
    let staleTimer: number | undefined;

    const clearStaleTimer = () => {
      if (staleTimer === undefined) return;
      window.clearTimeout(staleTimer);
      staleTimer = undefined;
    };

    const scheduleLoad = (delay = COMMAND_RUN_EVENT_REFRESH_DELAY_MS) => {
      if (!active || eventRefreshTimer !== undefined) return;
      eventRefreshTimer = window.setTimeout(() => {
        eventRefreshTimer = undefined;
        void load();
      }, delay);
    };

    const load = async () => {
      if (loading) {
        refreshQueued = true;
        return;
      }
      loading = true;
      refreshQueued = false;
      if (selectedRunIsActive) {
        staleTimer = window.setTimeout(() => {
          if (active && loading) setRunSyncState('stale');
        }, COMMAND_RUN_SYNC_STALE_MS);
      }
      try {
        const requestedAfterSeq = runLogCursorRef.current.runId === selectedRunId ? runLogCursorRef.current.nextSeq : 0;
        const loadTail = !selectedRunIsActive && requestedAfterSeq === 0;
        let detail = await props.client.loadCommandRun(selectedRunId, {
          afterSeq: requestedAfterSeq,
          logLimit: loadTail ? MAX_DISPLAYED_COMMAND_RUN_LOGS : COMMAND_RUN_LOG_PAGE_SIZE,
          tail: loadTail,
        });
        if (!active) return;
        let skippedHistoricalLogs = Boolean(detail.logsTruncated) || (detail.hasMoreLogs && detail.nextSeq <= requestedAfterSeq);
        if (detail.run.status !== 'running' && !loadTail && detail.hasMoreLogs) {
          // 终态只重取一次展示预算内的尾部，禁止无间隔追赶整段积压历史。
          detail = await props.client.loadCommandRun(selectedRunId, {
            afterSeq: 0,
            logLimit: MAX_DISPLAYED_COMMAND_RUN_LOGS,
            tail: true,
          });
          if (!active) return;
          skippedHistoricalLogs = true;
        }
        runLogCursorRef.current = { runId: selectedRunId, nextSeq: detail.nextSeq };
        setRunDetail((current) => mergeCommandRunDetail(current, detail, skippedHistoricalLogs));
        setRuns((current) => {
          const index = current.findIndex((run) => run.id === detail.run.id);
          if (index < 0) return [detail.run, ...current];
          if (commandRunStateMatches(current[index]!, detail.run)) return current;
          const next = [...current];
          next[index] = detail.run;
          return next;
        });
        setRunSyncState('live');
      } catch (loadError) {
        if (active) {
          if (isLikelyLocalServerConnectionError(loadError)) setRunSyncState('stale');
          else {
            setRunSyncState('live');
            setError(loadError);
          }
        }
      } finally {
        clearStaleTimer();
        loading = false;
        if (active && refreshQueued) scheduleLoad(0);
      }
    };
    void load();
    const pollTimer = selectedRunIsActive ? window.setInterval(() => void load(), COMMAND_RUN_POLL_INTERVAL_MS) : undefined;
    const unsubscribe = selectedRunIsActive
      ? props.client.subscribeEvents(
          (event) => {
            if (commandRunRealtimeEventMatches(event, selectedRunId, selectedRuntimeSessionId)) scheduleLoad();
          },
          (state) => {
            if (!active) return;
            if (state === 'reconnecting') setRunSyncState('stale');
            else if (state === 'connected') scheduleLoad(0);
          },
        )
      : undefined;
    return () => {
      active = false;
      if (eventRefreshTimer !== undefined) window.clearTimeout(eventRefreshTimer);
      clearStaleTimer();
      if (pollTimer) window.clearInterval(pollTimer);
      unsubscribe?.();
    };
  }, [props.client, selectedRunId, selectedRunIsActive, selectedRuntimeSessionId]);

  async function reloadCommands(): Promise<void> {
    const items = props.mode === 'global' ? await props.client.loadGlobalCommands() : props.project ? await props.client.loadProjectCommands(props.project.id) : [];
    setCommands(items);
  }

  async function reloadRuns(selectRunId?: string): Promise<void> {
    if (!props.project) return;
    const items = await props.client.loadCommandRuns(props.project.id);
    setRuns(items);
    if (selectRunId) setSelectedRunId(selectRunId);
  }

  async function openRunHistory(command: CommandDefinition, selectRunId?: string): Promise<void> {
    if (!props.project) return;
    historyCommandIdRef.current = command.id;
    setHistoryCommand(command);
    setError(null);
    setRunDetail(null);
    setRunSyncState('syncing');
    runLogCursorRef.current = { runId: null, nextSeq: 0 };
    const currentCommandRuns = runs.filter((run) => run.commandId === command.id);
    setSelectedRunId(selectRunId ?? currentCommandRuns[0]?.id ?? null);
    try {
      const items = await props.client.loadCommandRuns(props.project.id);
      if (historyCommandIdRef.current !== command.id) return;
      const commandRuns = items.filter((run) => run.commandId === command.id);
      setRuns(items);
      setSelectedRunId(selectRunId ?? commandRuns[0]?.id ?? null);
    } catch (loadError) {
      setError(loadError);
    }
  }

  function closeRunHistory(): void {
    historyCommandIdRef.current = null;
    setHistoryCommand(null);
    setSelectedRunId(null);
    setRunDetail(null);
    setRunSyncState('syncing');
  }

  function selectHistoryRun(runId: string): void {
    setSelectedRunId(runId);
    setRunSyncState('syncing');
    setRunDetail((current) => (current?.run.id === runId ? current : null));
  }

  function openCreate(): void {
    setDraft({ ...emptyDraft, riskFlags: { ...emptyDraft.riskFlags }, parameters: [] });
    setEditing('new');
    setError(null);
  }

  function openEdit(command: CommandDefinition): void {
    setDraft({
      name: command.name,
      aliases: command.aliases.join(', '),
      title: command.title,
      description: command.description,
      command: command.command,
      timeoutSeconds: String(command.timeoutSeconds),
      enabled: command.enabled,
      telegramEnabled: command.telegramEnabled,
      riskFlags: { ...command.riskFlags },
      parameters: command.parameters.map((parameter) => ({ ...parameter })),
    });
    setEditing(command);
    setError(null);
  }

  async function saveDefinition(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!editing || busy) return;
    const input = draftToInput(draft);
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') {
        if (props.mode === 'global') await props.client.createGlobalCommand(input);
        else if (props.project) await props.client.createProjectCommand(props.project.id, input);
      } else if (editing.scope === 'global') {
        await props.client.updateGlobalCommand(editing.id, input, editing.revision);
      } else if (props.project) {
        await props.client.updateProjectCommand(props.project.id, editing.id, input, editing.revision);
      }
      await reloadCommands();
      setEditing(null);
      setNotice(zh ? '命令定义已保存。' : 'Command definition saved.');
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  }

  async function removeCommand(command: CommandDefinition): Promise<void> {
    if (pendingDeleteId !== command.id) {
      setPendingDeleteId(command.id);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (command.scope === 'global') await props.client.deleteGlobalCommand(command.id, command.revision);
      else if (props.project) await props.client.deleteProjectCommand(props.project.id, command.id, command.revision);
      await reloadCommands();
      setPendingDeleteId(null);
      setNotice(zh ? '命令定义已删除，历史记录仍保留。' : 'Command deleted; history remains available.');
    } catch (deleteError) {
      setError(deleteError);
    } finally {
      setBusy(false);
    }
  }

  function showRunConfirmation(command: CommandDefinition): void {
    const initialValues: Record<string, string | number | boolean> = {};
    for (const parameter of command.parameters) {
      if (parameter.defaultValue !== undefined) initialValues[parameter.key] = parameter.defaultValue;
      else if (parameter.type === 'boolean') initialValues[parameter.key] = false;
      else initialValues[parameter.key] = '';
    }
    setRunParameters(initialValues);
    setRunningCommand(command);
    setError(null);
  }

  async function openRun(command: CommandDefinition): Promise<void> {
    if (!props.project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const config = await props.client.loadProjectConfig(props.project.id);
      const missingShell = !config.security.allowShell;
      const missingGitWrite = command.riskFlags.gitWrite && !config.security.allowGitWrite;
      if (missingShell || missingGitWrite) {
        setPermissionRequest({ command, missingShell, missingGitWrite });
        return;
      }
      showRunConfirmation(command);
    } catch (loadError) {
      setError(loadError);
    } finally {
      setBusy(false);
    }
  }

  async function enablePermissionsAndContinue(): Promise<void> {
    if (!permissionRequest || !props.project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const config = await props.client.loadProjectConfig(props.project.id);
      const input = projectConfigWithCommandPermissions(config, permissionRequest.command);
      await props.client.saveProjectConfig(props.project.id, input);
      const command = permissionRequest.command;
      setPermissionRequest(null);
      showRunConfirmation(command);
      setNotice(zh ? '已开启所需项目权限，请确认本次运行。' : 'Required project permissions enabled. Confirm this run to continue.');
    } catch (saveError) {
      setError(saveError);
    } finally {
      setBusy(false);
    }
  }

  async function submitRun(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!runningCommand || !props.project || busy) return;
    setBusy(true);
    setError(null);
    try {
      const confirmation = await props.client.createCommandConfirmation(props.project.id, runningCommand.id, {
        parameters: runParameters,
        trigger: 'desktop',
      });
      const run = await props.client.startCommandRun(props.project.id, runningCommand.id, {
        runId: confirmation.runId,
        confirmationId: confirmation.id,
        parameters: runParameters,
      });
      const command = runningCommand;
      setRunningCommand(null);
      await openRunHistory(command, run.id);
      setNotice(zh ? `已启动 ${command.title}。` : `${command.title} started.`);
    } catch (runError) {
      setError(runError);
      await reloadRuns().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function stopRun(run: CommandRun): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await props.client.stopCommandRun(run.id);
      await reloadRuns(run.id);
    } catch (stopError) {
      setError(stopError);
    } finally {
      setBusy(false);
    }
  }

  /** 项目已由工作区导航标明，页面标题只说明当前操作。 */
  const heading = props.mode === 'global' ? (zh ? '全局命令' : 'Global commands') : zh ? '命令' : 'Commands';

  return (
    <div className="command-center-workspace">
      <section className="command-center" aria-labelledby="command-center-title">
        <header className="command-center-header">
          <span>
            <h2 id="command-center-title">{heading}</h2>
            {props.mode === 'global' ? <p>{zh ? '在项目中运行' : 'Run from a project'}</p> : null}
          </span>
          <div className="command-center-header-actions">
            {props.mode === 'project' && props.project ? <ProjectTerminalPanel dockHost={terminalHost} key={props.project.id} project={props.project} client={props.client} language={props.language} /> : null}
            <Button variant="primary" onClick={openCreate} disabled={!canMaintain || busy}>
              <Plus aria-hidden="true" />
              {zh ? '新建命令' : 'New command'}
            </Button>
          </div>
        </header>

        <div className="command-center-live" role="status" aria-live="polite">
          {notice ? <span>{notice}</span> : null}
        </div>
        {error ? (
          <p className="command-center-empty" role="alert">
            <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          </p>
        ) : null}

        <section className="command-definition-list" aria-label={zh ? '命令定义列表' : 'Command definitions'}>
          {loading ? (
            <p className="command-center-empty">{zh ? '正在加载命令…' : 'Loading commands…'}</p>
          ) : commands.length === 0 ? (
            <p className="command-center-empty">{zh ? '尚未配置命令。' : 'No commands configured.'}</p>
          ) : (
            commands.map((command) => {
              /** 项目页只允许维护项目命令，全局页维护全局命令。 */
              const editable = props.mode === 'global' ? command.scope === 'global' : command.scope === 'project';
              return (
                <article className="command-definition-row" key={command.id} data-enabled={command.enabled ? 'true' : 'false'}>
                  <details className="command-definition-copy">
                    <summary className="command-definition-title">
                      <CaretDown aria-hidden="true" />
                      <strong>{command.title}</strong>
                      <small>{command.scope === 'global' ? (zh ? '全局' : 'Global') : zh ? '项目' : 'Project'}</small>
                      {!command.enabled ? <small>{zh ? '已停用' : 'Disabled'}</small> : null}
                    </summary>
                    <CommandDefinitionDetails command={command} zh={zh} />
                  </details>
                  <span className="command-definition-actions">
                    {props.mode === 'project' ? (
                      <>
                        <button
                          type="button"
                          className="command-definition-icon-action"
                          onClick={() => void openRunHistory(command)}
                          disabled={!props.project || busy}
                          aria-label={`${zh ? '查看执行历史' : 'View run history'} ${command.title}`}
                          title={zh ? '执行历史' : 'Run history'}
                        >
                          <ClockCounterClockwise aria-hidden="true" />
                        </button>
                        <Button size="compact" onClick={() => void openRun(command)} disabled={!command.enabled || !props.project || busy} aria-label={`${zh ? '运行' : 'Run'} ${command.title}`}>
                          <Play aria-hidden="true" />
                          {zh ? '运行' : 'Run'}
                        </Button>
                      </>
                    ) : null}
                    <span className="command-definition-management">
                      {editable ? (
                        <>
                          <button type="button" className="command-definition-icon-action" onClick={() => openEdit(command)} disabled={busy} aria-label={`${zh ? '编辑' : 'Edit'} ${command.title}`}>
                            <PencilSimple aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="command-definition-icon-action"
                            data-confirm={pendingDeleteId === command.id ? 'true' : undefined}
                            onClick={() => void removeCommand(command)}
                            disabled={busy}
                            aria-label={`${pendingDeleteId === command.id ? (zh ? '确认删除' : 'Confirm delete') : zh ? '删除' : 'Delete'} ${command.title}`}
                          >
                            <Trash aria-hidden="true" />
                            {pendingDeleteId === command.id ? (zh ? '确认' : 'Confirm') : null}
                          </button>
                        </>
                      ) : null}
                    </span>
                  </span>
                </article>
              );
            })
          )}
        </section>

        <MotionPresence>
          {editing ? (
            <CommandDefinitionModal
              draft={draft}
              busy={busy}
              language={props.language}
              title={editing === 'new' ? (zh ? '新建命令' : 'New command') : zh ? '编辑命令' : 'Edit command'}
              onChange={setDraft}
              onClose={() => setEditing(null)}
              onSubmit={(event) => void saveDefinition(event)}
            />
          ) : null}
        </MotionPresence>

        <MotionPresence>
          {permissionRequest && props.project ? (
            <CommandPermissionModal request={permissionRequest} project={props.project} busy={busy} language={props.language} onClose={() => setPermissionRequest(null)} onContinue={() => void enablePermissionsAndContinue()} />
          ) : null}
        </MotionPresence>

        <MotionPresence>
          {runningCommand && props.project ? (
            <CommandRunModal
              command={runningCommand}
              project={props.project}
              values={runParameters}
              busy={busy}
              language={props.language}
              onValuesChange={setRunParameters}
              onClose={() => setRunningCommand(null)}
              onSubmit={(event) => void submitRun(event)}
            />
          ) : null}
        </MotionPresence>

        <MotionPresence>
          {historyCommand && props.project ? (
            <CommandRunHistoryModal
              command={historyCommand}
              project={props.project}
              runs={historyRuns}
              activeRunCount={activeHistoryRuns.length}
              selectedRunId={selectedRunId}
              runDetail={runDetail}
              syncState={runSyncState}
              projectedRunLogContent={projectedRunLogContent}
              client={props.client}
              busy={busy}
              language={props.language}
              onClose={closeRunHistory}
              onSelectRun={selectHistoryRun}
              onStopRun={(run) => void stopRun(run)}
            />
          ) : null}
        </MotionPresence>
      </section>
      <div className="command-center-terminal-host" ref={setTerminalHost} />
    </div>
  );
}

/** 完整说明与技术配置按需展开，列表和运行确认共用一处展示。 */
function CommandDefinitionDetails(props: { command: CommandDefinition; zh: boolean }) {
  return (
    <div className="command-definition-details">
      {props.command.description ? <p>{props.command.description}</p> : null}
      <code>{props.command.command}</code>
      <dl>
        <div>
          <dt>{props.zh ? '名称' : 'Name'}</dt>
          <dd>{props.command.name}</dd>
        </div>
        {props.command.aliases.length > 0 ? (
          <div>
            <dt>{props.zh ? '别名' : 'Aliases'}</dt>
            <dd>{props.command.aliases.join(', ')}</dd>
          </div>
        ) : null}
        <div>
          <dt>{props.zh ? '超时' : 'Timeout'}</dt>
          <dd>{props.command.timeoutSeconds}s</dd>
        </div>
        <div>
          <dt>Telegram</dt>
          <dd>{props.command.telegramEnabled ? (props.zh ? '开启' : 'On') : props.zh ? '关闭' : 'Off'}</dd>
        </div>
      </dl>
    </div>
  );
}

/** 历史列表与终端分别滚动，运行说明随终端展示。 */
function CommandRunHistoryModal(props: {
  command: CommandDefinition;
  project: ProjectRecord;
  runs: CommandRun[];
  activeRunCount: number;
  selectedRunId: string | null;
  runDetail: CommandRunDetail | null;
  syncState: CommandRunSyncState;
  projectedRunLogContent: string;
  client: DashboardClient;
  busy: boolean;
  language: 'zh-CN' | 'en-US';
  onClose: () => void;
  onSelectRun: (runId: string) => void;
  onStopRun: (run: CommandRun) => void;
}) {
  /** 文案跟随当前界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 运行中的命令保留真实连接状态。 */
  const activeRunSyncState = props.runDetail?.run.status === 'running' ? props.syncState : 'live';
  /** 未确认实时状态时禁止停止，避免提交结果不明确的操作。 */
  const stopUnavailable = activeRunSyncState !== 'live';
  /** 当前记录的状态在详情标题旁展示，避免重复占用统计卡片。 */
  const selectedStatus = props.runDetail ? commandRunStatusPresentation(props.runDetail.run, props.runDetail.run.id, props.syncState, zh) : null;
  return (
    <ModalPortal rootClassName="command-modal-portal-root" backdropClassName="command-modal-backdrop" dismissDisabled={props.busy} onDismiss={props.onClose} role="dialog" aria-labelledby="command-history-modal-title">
      <div className="command-modal command-history-modal zeus-solid-form-surface" data-modal-surface="dialog">
        <header className="command-modal-header">
          <span>
            <h3 id="command-history-modal-title">{zh ? `${props.command.title} · 执行历史` : `${props.command.title} · Run history`}</h3>
            <p>
              {props.project.name} · <code>{props.command.name}</code>
              {props.activeRunCount > 0 ? ` · ${zh ? `${props.activeRunCount} 条运行中` : `${props.activeRunCount} running`}` : ''}
            </p>
          </span>
          <button type="button" aria-label={zh ? '关闭执行历史' : 'Close run history'} onClick={props.onClose} disabled={props.busy}>
            ×
          </button>
        </header>
        <div className="command-history-modal-body">
          {props.runs.length === 0 ? (
            <p className="command-center-empty">{zh ? '此命令在当前项目中尚无执行记录。' : 'This command has no run history in the current project.'}</p>
          ) : (
            <div className="command-run-layout">
              <aside className="command-run-sidebar">
                <ul className="command-run-list" aria-label={zh ? '执行记录' : 'Run records'}>
                  {props.runs.map((run) => {
                    /** 历史记录同步展示运行状态与连接状态。 */
                    const status = commandRunStatusPresentation(run, props.selectedRunId, props.syncState, zh);
                    return (
                      <li key={run.id}>
                        <button type="button" aria-pressed={props.selectedRunId === run.id} className={props.selectedRunId === run.id ? 'selected' : ''} onClick={() => props.onSelectRun(run.id)}>
                          <span>
                            <strong>{formatRunTime(run.createdAt)}</strong>
                            <small>
                              {zh ? '耗时' : 'Duration'} <CommandRunDurationValue run={run} zh={zh} />
                            </small>
                          </span>
                          <span className={`command-run-status ${status.className}`}>{status.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </aside>
              {props.runDetail ? (
                <section className="command-run-detail" aria-label={zh ? '执行详情' : 'Run details'}>
                  <header>
                    <span>
                      <strong>{formatRunTime(props.runDetail.run.createdAt)}</strong>
                      <small title={props.runDetail.run.cwd}>{props.runDetail.run.cwd}</small>
                    </span>
                    <div className="command-run-detail-actions">
                      {selectedStatus ? <span className={`command-run-status ${selectedStatus.className}`}>{selectedStatus.label}</span> : null}
                      {props.runDetail.run.status === 'running' ? (
                        <Button
                          variant="danger"
                          size="compact"
                          onClick={() => props.onStopRun(props.runDetail!.run)}
                          disabled={props.busy || stopUnavailable}
                          title={stopUnavailable ? (zh ? '连接恢复并确认命令状态后才能停止。' : 'Stop is available after the connection recovers and the run state is confirmed.') : undefined}
                        >
                          <Stop aria-hidden="true" />
                          {zh ? '停止' : 'Stop'}
                        </Button>
                      ) : null}
                    </div>
                  </header>
                  {activeRunSyncState === 'stale' ? (
                    <p className="command-run-sync-warning" role="status" aria-live="polite">
                      <WarningCircle aria-hidden="true" />
                      <span>
                        <strong>{zh ? '连接中断，命令可能仍在执行。' : 'Connection lost; the command may still be running.'}</strong>
                        <small>{zh ? '正在重新连接，连接恢复后会更新日志和命令状态。' : 'Reconnecting. Logs and command status will update when the connection returns.'}</small>
                      </span>
                    </p>
                  ) : null}
                  <dl>
                    <div>
                      <dt>{zh ? '实际耗时' : 'Duration'}</dt>
                      <dd>
                        <CommandRunDurationValue run={props.runDetail.run} zh={zh} />
                      </dd>
                    </div>
                    <div>
                      <dt>{zh ? '超时上限' : 'Timeout limit'}</dt>
                      <dd>{props.runDetail.run.timeoutSeconds}s</dd>
                    </div>
                    <div>
                      <dt>{zh ? '退出码' : 'Exit code'}</dt>
                      <dd>{props.runDetail.run.exitCode ?? '—'}</dd>
                    </div>
                  </dl>
                  <CommandRunLog
                    key={props.runDetail.run.id}
                    runId={props.runDetail.run.id}
                    ariaLabel={zh ? '终端日志' : 'Terminal logs'}
                    content={props.runDetail.logs.length > 0 ? props.projectedRunLogContent : zh ? '暂无日志。' : 'No logs yet.'}
                    hasLogs={props.runDetail.logTotal > 0}
                    failureReason={props.runDetail.run.failureReason}
                    artifacts={props.runDetail.artifacts}
                    client={props.client}
                    zh={zh}
                  />
                </section>
              ) : (
                <p className="command-center-empty">{zh ? '选择一条记录查看执行详情。' : 'Select a run to view its details.'}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}

function CommandDefinitionModal(props: {
  draft: CommandDraft;
  title: string;
  busy: boolean;
  language: 'zh-CN' | 'en-US';
  onChange: (draft: CommandDraft) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const zh = props.language === 'zh-CN';
  const update = <K extends keyof CommandDraft>(key: K, value: CommandDraft[K]) => props.onChange({ ...props.draft, [key]: value });
  const updateParameter = (index: number, patch: Partial<CommandParameterDefinition>) =>
    update(
      'parameters',
      props.draft.parameters.map((parameter, parameterIndex) => (parameterIndex === index ? { ...parameter, ...patch } : parameter)),
    );
  return (
    <ModalPortal rootClassName="command-modal-portal-root" backdropClassName="command-modal-backdrop" dismissDisabled={props.busy} onDismiss={props.onClose} role="dialog" aria-labelledby="command-definition-modal-title">
      <form className="command-modal command-definition-modal command-editor-form zeus-solid-form-surface" onSubmit={props.onSubmit} data-modal-surface="dialog">
        <header className="command-modal-header">
          <span>
            <h3 id="command-definition-modal-title">{props.title}</h3>
            <p>{zh ? '命令会在目标项目目录中执行，使用系统命令解释器（sh -lc）。' : 'Commands run in the target project folder using the system shell (sh -lc).'}</p>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>
            ×
          </button>
        </header>
        <div className="command-modal-body" inert={props.busy} aria-busy={props.busy || undefined}>
          <div className="command-editor-grid">
            <label>
              {zh ? '名称' : 'Name'}
              <input autoFocus required value={props.draft.name} onChange={(event) => update('name', event.currentTarget.value)} placeholder="my-command" />
            </label>
            <label>
              {zh ? '标题' : 'Title'}
              <input required maxLength={80} value={props.draft.title} onChange={(event) => update('title', event.currentTarget.value)} />
            </label>
            <label className="wide">
              {zh ? '别名（逗号分隔）' : 'Aliases (comma separated)'}
              <input value={props.draft.aliases} onChange={(event) => update('aliases', event.currentTarget.value)} />
            </label>
            <label className="wide">
              {zh ? '说明' : 'Description'}
              <textarea maxLength={400} rows={2} value={props.draft.description} onChange={(event) => update('description', event.currentTarget.value)} />
            </label>
            <label className="wide">
              {zh ? '命令' : 'Command'}
              <textarea required maxLength={1024} rows={4} value={props.draft.command} onChange={(event) => update('command', event.currentTarget.value)} />
            </label>
            <label>
              {zh ? '超时（秒）' : 'Timeout (seconds)'}
              <input required type="number" min={5} max={3600} value={props.draft.timeoutSeconds} onChange={(event) => update('timeoutSeconds', event.currentTarget.value)} />
            </label>
          </div>
          <fieldset className="command-editor-switches">
            <legend>{zh ? '可用性与风险' : 'Availability and risk'}</legend>
            <Check label={zh ? '启用命令' : 'Enable command'} checked={props.draft.enabled} onChange={(checked) => update('enabled', checked)} />
            <Check label={zh ? '允许 Telegram' : 'Allow Telegram'} checked={props.draft.telegramEnabled} onChange={(checked) => update('telegramEnabled', checked)} />
            <Check label={zh ? 'Git 写入' : 'Git write'} checked={props.draft.riskFlags.gitWrite} onChange={(checked) => update('riskFlags', { ...props.draft.riskFlags, gitWrite: checked })} />
            <Check label={zh ? '项目外写入' : 'Outside-project write'} checked={props.draft.riskFlags.outsideProjectWrite} onChange={(checked) => update('riskFlags', { ...props.draft.riskFlags, outsideProjectWrite: checked })} />
            <Check label={zh ? '外部服务写入' : 'External service write'} checked={props.draft.riskFlags.externalServiceWrite} onChange={(checked) => update('riskFlags', { ...props.draft.riskFlags, externalServiceWrite: checked })} />
          </fieldset>
          <section className="command-parameter-editor" aria-labelledby="command-parameter-heading">
            <header>
              <span>
                <strong id="command-parameter-heading">{zh ? '运行参数' : 'Run parameters'}</strong>
                <small>{zh ? '参数以环境变量注入；ZEUS_* 为保留名称。' : 'Parameters are injected as environment variables; ZEUS_* is reserved.'}</small>
              </span>
              <Button size="compact" onClick={() => update('parameters', [...props.draft.parameters, newParameter()])}>
                <Plus aria-hidden="true" />
                {zh ? '添加参数' : 'Add parameter'}
              </Button>
            </header>
            {props.draft.parameters.map((parameter, index) => (
              <fieldset className="command-parameter-row" key={index}>
                <legend>{zh ? `参数 ${index + 1}` : `Parameter ${index + 1}`}</legend>
                <label>
                  {zh ? '环境变量' : 'Environment key'}
                  <input required value={parameter.key} onChange={(event) => updateParameter(index, { key: event.currentTarget.value.toLocaleUpperCase() })} placeholder="DEPTH" />
                </label>
                <label>
                  {zh ? '标签' : 'Label'}
                  <input required value={parameter.label} onChange={(event) => updateParameter(index, { label: event.currentTarget.value })} />
                </label>
                <label>
                  {zh ? '类型' : 'Type'}
                  <select value={parameter.type} onChange={(event) => updateParameter(index, { type: event.currentTarget.value as CommandParameterDefinition['type'], defaultValue: undefined })}>
                    <option value="string">string</option>
                    <option value="number">number</option>
                    <option value="boolean">boolean</option>
                  </select>
                </label>
                <label>
                  {zh ? '默认值' : 'Default value'}
                  {parameter.type === 'boolean' ? (
                    <select
                      value={parameter.defaultValue === undefined ? '' : parameter.defaultValue ? 'true' : 'false'}
                      disabled={parameter.sensitive}
                      onChange={(event) => updateParameter(index, { defaultValue: event.currentTarget.value === '' ? undefined : event.currentTarget.value === 'true' })}
                    >
                      <option value="">{zh ? '无' : 'None'}</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={parameter.type === 'number' ? 'number' : 'text'}
                      step={parameter.type === 'number' ? 'any' : undefined}
                      disabled={parameter.sensitive}
                      value={parameter.defaultValue === undefined ? '' : String(parameter.defaultValue)}
                      onChange={(event) => updateParameter(index, { defaultValue: event.currentTarget.value === '' ? undefined : parameter.type === 'number' ? Number(event.currentTarget.value) : event.currentTarget.value })}
                    />
                  )}
                </label>
                <label className="wide">
                  {zh ? '说明' : 'Description'}
                  <input maxLength={200} value={parameter.description} onChange={(event) => updateParameter(index, { description: event.currentTarget.value })} />
                </label>
                <span className="command-parameter-flags">
                  <Check label={zh ? '必填' : 'Required'} checked={parameter.required} onChange={(checked) => updateParameter(index, { required: checked })} />
                  <Check label={zh ? '敏感' : 'Sensitive'} checked={parameter.sensitive} onChange={(checked) => updateParameter(index, { sensitive: checked, defaultValue: checked ? undefined : parameter.defaultValue })} />
                  <Button
                    size="compact"
                    variant="danger"
                    onClick={() =>
                      update(
                        'parameters',
                        props.draft.parameters.filter((_, parameterIndex) => parameterIndex !== index),
                      )
                    }
                  >
                    <Trash aria-hidden="true" />
                    {zh ? '移除' : 'Remove'}
                  </Button>
                </span>
              </fieldset>
            ))}
          </section>
        </div>
        <footer className="command-modal-footer">
          <Button onClick={props.onClose} disabled={props.busy}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button type="submit" variant="primary" busy={props.busy}>
            {zh ? '保存命令' : 'Save command'}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
}

function CommandPermissionModal(props: { request: CommandPermissionRequest; project: ProjectRecord; busy: boolean; language: 'zh-CN' | 'en-US'; onClose: () => void; onContinue: () => void }) {
  const zh = props.language === 'zh-CN';
  return (
    <ModalPortal
      rootClassName="command-modal-portal-root"
      backdropClassName="command-modal-backdrop"
      dismissDisabled={props.busy}
      onDismiss={props.onClose}
      role="dialog"
      aria-labelledby="command-permission-modal-title"
      aria-describedby="command-permission-modal-description"
    >
      <div className="command-modal command-permission-modal zeus-solid-form-surface" data-modal-surface="dialog">
        <header className="command-modal-header">
          <span>
            <h3 id="command-permission-modal-title">{zh ? '开启项目命令权限' : 'Enable project command permissions'}</h3>
            <p>
              {props.project.name} · {props.request.command.title}
            </p>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>
            ×
          </button>
        </header>
        <div className="command-modal-body command-permission-body">
          <p id="command-permission-modal-description">
            {zh ? '运行此命令前需要开启下列项目权限。权限会保存到当前项目，但不会因此立即执行命令。' : 'This command needs the following project permissions. They will be saved for this project, but the command will not run yet.'}
          </p>
          <ul>
            {props.request.missingShell ? (
              <li>
                <strong>{zh ? 'Shell' : 'Shell'}</strong>
                <span>{zh ? '允许任务在当前项目中执行终端命令。' : 'Allow tasks to run terminal commands in this project.'}</span>
              </li>
            ) : null}
            {props.request.missingGitWrite ? (
              <li>
                <strong>{zh ? 'Git 写操作' : 'Git write'}</strong>
                <span>{zh ? '允许此项目中的命令执行 Git 写操作。' : 'Allow commands in this project to perform Git writes.'}</span>
              </li>
            ) : null}
          </ul>
          <p className="command-permission-next-step">{zh ? '开启后还需确认运行。' : 'Confirm the run after enabling.'}</p>
        </div>
        <footer className="command-modal-footer">
          <Button autoFocus onClick={props.onClose} disabled={props.busy}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button variant={props.request.missingGitWrite ? 'danger' : 'primary'} busy={props.busy} onClick={props.onContinue}>
            {zh ? '开启并继续' : 'Enable and continue'}
          </Button>
        </footer>
      </div>
    </ModalPortal>
  );
}

/** 运行确认只填写必填参数，技术配置与字段说明按需查看。 */
function CommandRunModal(props: {
  command: CommandDefinition;
  project: ProjectRecord;
  values: Record<string, string | number | boolean>;
  busy: boolean;
  language: 'zh-CN' | 'en-US';
  onValuesChange: (values: Record<string, string | number | boolean>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  /** 当前界面的显示语言。 */
  const zh = props.language === 'zh-CN';
  /** 高风险命令保留醒目的运行按钮和具体影响。 */
  const highRisk = commandNeedsHighRiskConfirmation(props.command.riskFlags);
  /** 仅展示本次命令实际声明的风险范围。 */
  const riskLabels = commandRiskLabels(props.command.riskFlags, zh);
  /** 只渲染必须填写的参数，完整参数值仍沿用既有初始化和提交链路。 */
  const requiredParameters = props.command.parameters.filter((parameter) => parameter.required);
  /** 控件和说明使用同一弹窗内的唯一标识建立可访问关联。 */
  const fieldPrefix = useId();
  /** 整分钟超时使用易读单位，其余仍显示精确秒数。 */
  const timeoutLabel = props.command.timeoutSeconds % 60 === 0 ? `${props.command.timeoutSeconds / 60}${zh ? ' 分钟' : ' min'}` : `${props.command.timeoutSeconds}${zh ? ' 秒' : ' s'}`;
  return (
    <ModalPortal
      rootClassName="command-modal-portal-root"
      backdropClassName="command-modal-backdrop"
      dismissDisabled={props.busy}
      onDismiss={props.onClose}
      role="dialog"
      aria-labelledby="command-run-modal-title"
      aria-describedby={highRisk ? `${fieldPrefix}-risk` : undefined}
    >
      <form className="command-modal command-run-modal command-run-form zeus-solid-form-surface" onSubmit={props.onSubmit} data-modal-surface="dialog">
        <header className="command-modal-header">
          <span>
            <h3 id="command-run-modal-title">{props.command.title}</h3>
          </span>
          <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>
            ×
          </button>
        </header>
        <div className="command-modal-body command-run-body" inert={props.busy} aria-busy={props.busy || undefined}>
          <div className="command-run-context">
            <FolderSimple aria-hidden="true" />
            <span title={props.project.localPath} aria-label={`${zh ? '项目目录' : 'Project directory'} ${props.project.localPath}`}>
              {props.project.localPath}
            </span>
            <small title={zh ? '超时上限' : 'Timeout limit'}>{timeoutLabel}</small>
          </div>
          <div className="command-run-parameters">
            {requiredParameters.map((parameter, index) => (
              <div className="command-run-parameter" data-type={parameter.type} key={parameter.key}>
                <div className="command-run-parameter-heading">
                  <label htmlFor={`${fieldPrefix}-${index}`}>
                    {parameter.label}
                    {parameter.required ? (
                      <span className="command-run-required" aria-label={zh ? '必填' : 'Required'}>
                        {' '}
                        *
                      </span>
                    ) : null}
                  </label>
                  <details className="command-parameter-help">
                    <summary aria-label={`${zh ? '查看说明' : 'View help'} ${parameter.label}`}>
                      <Question aria-hidden="true" />
                    </summary>
                    <div id={`${fieldPrefix}-${index}-help`}>
                      <code>{parameter.key}</code>
                      {parameter.description ? <p>{parameter.description}</p> : null}
                    </div>
                  </details>
                </div>
                {parameter.type === 'boolean' ? (
                  <input
                    id={`${fieldPrefix}-${index}`}
                    aria-describedby={`${fieldPrefix}-${index}-help`}
                    autoFocus={index === 0}
                    type="checkbox"
                    checked={Boolean(props.values[parameter.key])}
                    onChange={(event) => props.onValuesChange({ ...props.values, [parameter.key]: event.currentTarget.checked })}
                  />
                ) : (
                  <input
                    id={`${fieldPrefix}-${index}`}
                    aria-describedby={`${fieldPrefix}-${index}-help`}
                    autoFocus={index === 0}
                    required={parameter.required}
                    type={parameter.sensitive ? 'password' : parameter.type === 'number' ? 'number' : 'text'}
                    step={parameter.type === 'number' ? 'any' : undefined}
                    value={String(props.values[parameter.key] ?? '')}
                    onChange={(event) => props.onValuesChange({ ...props.values, [parameter.key]: parameter.type === 'number' && event.currentTarget.value !== '' ? Number(event.currentTarget.value) : event.currentTarget.value })}
                  />
                )}
              </div>
            ))}
          </div>
          <details className="command-run-details">
            <summary>
              <CaretDown aria-hidden="true" />
              {zh ? '命令详情' : 'Command details'}
            </summary>
            <CommandDefinitionDetails command={props.command} zh={zh} />
          </details>
          {highRisk ? (
            <p className="command-run-risk" id={`${fieldPrefix}-risk`}>
              <WarningCircle aria-hidden="true" />
              <span>
                {zh ? '涉及：' : 'Includes: '}
                {riskLabels.join(zh ? '、' : ', ')}
              </span>
            </p>
          ) : null}
        </div>
        <footer className="command-modal-footer">
          <Button onClick={props.onClose} disabled={props.busy}>
            {zh ? '取消' : 'Cancel'}
          </Button>
          <Button autoFocus={requiredParameters.length === 0} type="submit" variant={highRisk ? 'danger' : 'primary'} busy={props.busy}>
            <Play aria-hidden="true" />
            {zh ? '运行' : 'Run'}
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
}

function Check(props: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="command-check">
      <input type="checkbox" checked={props.checked} onChange={(event) => props.onChange(event.currentTarget.checked)} />
      <span>{props.label}</span>
    </label>
  );
}

function newParameter(): CommandParameterDefinition {
  return { key: '', label: '', description: '', type: 'string', required: false, sensitive: false };
}

function draftToInput(draft: CommandDraft): CommandDefinitionInput {
  return {
    name: draft.name.trim(),
    aliases: draft.aliases
      .split(',')
      .map((alias) => alias.trim())
      .filter(Boolean),
    title: draft.title.trim(),
    description: draft.description.trim(),
    command: draft.command.trim(),
    timeoutSeconds: Number(draft.timeoutSeconds),
    enabled: draft.enabled,
    telegramEnabled: draft.telegramEnabled,
    riskFlags: draft.riskFlags,
    parameters: draft.parameters.map((parameter) => ({ ...parameter, key: parameter.key.trim(), label: parameter.label.trim(), description: parameter.description.trim() })),
  };
}

function projectConfigWithCommandPermissions(config: ProjectConfig, command: CommandDefinition): SaveProjectConfigRequest {
  return {
    database: config.database,
    security: {
      allowShell: true,
      allowGitWrite: config.security.allowGitWrite || command.riskFlags.gitWrite,
    },
  };
}

function commandRiskLabels(riskFlags: CommandRiskFlags, zh: boolean): string[] {
  const labels: string[] = [];
  if (riskFlags.gitWrite) labels.push(zh ? 'Git 写操作' : 'Git write');
  if (riskFlags.outsideProjectWrite) labels.push(zh ? '写入项目目录之外' : 'Write outside the project');
  if (riskFlags.externalServiceWrite) labels.push(zh ? '写入外部服务' : 'Write to an external service');
  return labels;
}

function commandRunRealtimeEventMatches(event: ZeusRealtimeEvent, runId: string, runtimeSessionId: string | null): boolean {
  return event.payload.runId === runId || (runtimeSessionId !== null && (event.payload.sessionId === runtimeSessionId || event.payload.runtimeSessionId === runtimeSessionId));
}

function commandRunStatusPresentation(run: CommandRun, selectedRunId: string | null, syncState: CommandRunSyncState, zh: boolean): { label: string; className: string } {
  if (run.id === selectedRunId && run.status === 'running') {
    if (syncState === 'stale') return { label: zh ? '连接中断' : 'Disconnected', className: 'status-stale' };
    if (syncState === 'syncing') return { label: zh ? '正在同步' : 'Synchronizing', className: 'status-syncing' };
  }
  return { label: runStatusLabel(run.status, zh), className: `status-${run.status}` };
}

function runStatusLabel(status: CommandRun['status'], zh: boolean): string {
  const labels: Record<CommandRun['status'], [string, string]> = {
    pending_confirmation: ['待确认', 'Pending'],
    starting: ['启动中', 'Starting'],
    running: ['运行中', 'Running'],
    stopping: ['停止中', 'Stopping'],
    succeeded: ['成功', 'Succeeded'],
    failed: ['失败', 'Failed'],
    timed_out: ['超时', 'Timed out'],
    cancelled: ['已取消', 'Cancelled'],
    rejected: ['已拒绝', 'Rejected'],
  };
  return labels[status][zh ? 0 : 1];
}

function mergeCommandRunDetail(current: CommandRunDetail | null, incoming: CommandRunDetail, skippedHistoricalLogs: boolean): CommandRunDetail {
  const canAppend = current?.run.id === incoming.run.id && incoming.afterSeq > 0;
  const combinedLogs = canAppend ? [...current.logs, ...incoming.logs] : incoming.logs;
  const boundedLogs = boundDisplayedCommandRunLogs(combinedLogs);
  const logsTruncated = Boolean(current?.logsTruncated) || skippedHistoricalLogs || boundedLogs.truncated;
  const logs = boundedLogs.items;
  if (!skippedHistoricalLogs && incoming.logs.length === 0 && current && commandRunDetailMetadataMatches(current, incoming) && current.logTotal === incoming.logTotal && current.hasMoreLogs === incoming.hasMoreLogs) {
    return current;
  }
  return { ...incoming, logs, logsTruncated };
}

function commandRunDetailMetadataMatches(left: CommandRunDetail, right: CommandRunDetail): boolean {
  if (!commandRunStateMatches(left.run, right.run)) return false;
  if (left.runtimeSession?.status !== right.runtimeSession?.status || left.runtimeSession?.endedAt !== right.runtimeSession?.endedAt || left.runtimeSession?.exitCode !== right.runtimeSession?.exitCode) return false;
  if (left.artifacts.length !== right.artifacts.length) return false;
  return left.artifacts.every((artifact, index) => {
    const candidate = right.artifacts[index];
    return candidate?.id === artifact.id && candidate.byteLength === artifact.byteLength && candidate.relativePath === artifact.relativePath;
  });
}

function commandRunStateMatches(left: CommandRun, right: CommandRun): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    left.status === right.status &&
    left.runtimeSessionId === right.runtimeSessionId &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.exitCode === right.exitCode &&
    left.failureReason === right.failureReason
  );
}

function boundDisplayedCommandRunLogs(logs: CommandRunDetail['logs']): { items: CommandRunDetail['logs']; truncated: boolean } {
  const items: CommandRunDetail['logs'] = [];
  let usedBytes = 0;
  let truncated = logs.length > MAX_DISPLAYED_COMMAND_RUN_LOGS;
  for (let index = logs.length - 1; index >= 0 && items.length < MAX_DISPLAYED_COMMAND_RUN_LOGS; index -= 1) {
    const log = logs[index]!;
    const bytes = UTF8_ENCODER.encode(log.text).byteLength;
    if (bytes > MAX_DISPLAYED_COMMAND_RUN_LOG_BYTES || usedBytes + bytes > MAX_DISPLAYED_COMMAND_RUN_LOG_BYTES) {
      truncated = true;
      continue;
    }
    items.push(log);
    usedBytes += bytes;
  }
  items.reverse();
  return { items, truncated };
}

function joinRuntimeLogEntries(logs: CommandRunDetail['logs']): string {
  let output = '';
  for (const log of logs) {
    if (log.stream !== 'system') {
      output += log.text;
      continue;
    }
    if (output && !output.endsWith('\n') && !output.endsWith('\r')) output += '\n';
    output += log.text;
    if (!output.endsWith('\n')) output += '\n';
  }
  return output;
}

function formatRunTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function formatRunDuration(run: CommandRun, nowMs: number, zh: boolean): string {
  if (!run.startedAt) return zh ? '未启动' : 'Not started';
  const startedAtMs = Date.parse(run.startedAt);
  const endedAtMs = run.endedAt ? Date.parse(run.endedAt) : nowMs;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return '—';

  const totalSeconds = Math.floor(Math.max(0, endedAtMs - startedAtMs) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}
