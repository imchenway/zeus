import { RuntimeCopyButton } from './RuntimeDetails.js';
import { IconTooltip } from '../ui/IconTooltip.js';
import { Collapsible } from '../ui/Collapsible.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useMotionPresence } from '../ui/useMotionPresence.js';
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CheckCircleIcon as CheckCircle } from '@phosphor-icons/react/dist/csr/CheckCircle';
import { CircleNotchIcon as CircleNotch } from '@phosphor-icons/react/dist/csr/CircleNotch';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { DesktopIcon as Desktop } from '@phosphor-icons/react/dist/csr/Desktop';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GithubLogoIcon as GithubLogo } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { MinusCircleIcon as MinusCircle } from '@phosphor-icons/react/dist/csr/MinusCircle';
import { PencilSimpleLineIcon as PencilSimpleLine } from '@phosphor-icons/react/dist/csr/PencilSimpleLine';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/dist/csr/ShareNetwork';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { conversationAttachmentIdentity } from './ConversationComposerAttachments.js';
import { isImageResource, isPendingImageAttachment, ResourceIcon } from './ConversationResources.js';
import { SessionCodeReviewDialog, type SessionCodeReviewSelection } from './SessionCodeReviewDialog.js';
import { SessionComputerPreview } from './SessionComputerPreview.js';
import { SessionWorkingDirectoryLauncher } from './SessionWorkingDirectoryLauncher.js';
import type { CodexConversationCapabilities, ConversationResource, ConversationResourcePreview, NativeConversationAttachment, NativeConversationChoice, NativeSessionState } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { VisibleApplicationError, reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { DashboardClient, ProjectRecord } from '../apiClient.js';
import type { GitEnvironmentStatus, GitEnvironmentWorkspace } from '@zeus/shared';
import { platformShortcutLabel } from '../platform.js';
import { conversationGitDeliveryTarget } from '../git/conversationGitDeliveryTarget.js';
import { GitDeliveryProgress } from '../git/GitDeliveryProgress.js';
import { GitDeliveryRunActions } from '../git/GitDeliveryRunActions.js';
import { useGitDeliveryRuns } from '../git/useGitDeliveryRuns.js';
import { Button } from '../ui/Button.js';

interface SessionQuickActionsCardProps {
  gitContext?: { client: DashboardClient; project: ProjectRecord };
  language: SessionUiLanguage;
  conversation: NativeConversationChoice;
  state: NativeSessionState;
  task: { id: string; title: string } | null;
  /** 正文列真实可用宽度：右侧上下文工作面与停靠终端占用的空间都已扣除。 */
  conversationColumnWidth: number;
  persistentHost?: HTMLElement | null;
  /** 浏览器展开时将环境信息放进独立布局区，保留网页可见性。 */
  dockHost?: HTMLElement | null;
  forceCollapsed?: boolean;
  suppressed?: boolean;
  capabilities?: CodexConversationCapabilities | null;
  onLoadCapabilities?: (projectId: string) => Promise<CodexConversationCapabilities>;
  onLoadSkills?: (projectId?: string, forceReload?: boolean) => Promise<import('../features/codex/codexContracts.js').SkillCatalog>;
  onOpenGitDelivery?: (taskId: string, workspaceId: string | null) => void | Promise<void>;
  /** 内置浏览器的显示状态由当前会话工作面维护。 */
  browserOpen: boolean;
  /** 入口只切换显示，浏览器标签与关闭流程仍由会话管理。 */
  onToggleBrowser: (trigger: HTMLButtonElement) => void;
  /** 当前主会话的侧栏是否正在显示。 */
  sideQuestionOpen?: boolean;
  /** 可提问的主会话提供同一打开、恢复和收起入口。 */
  onToggleSideQuestion?: (trigger: HTMLButtonElement) => void;
  /** 会话终端继续使用原有会话身份和显示状态。 */
  terminalOpen: boolean;
  /** 缺少终端能力时不显示入口，不创建项目级替代终端。 */
  onToggleTerminal?: (trigger: HTMLButtonElement) => void;
  subagentCount?: number;
  onOpenSubagents?: (trigger: HTMLButtonElement) => void;
  /** 屏幕控制停止时同步结束该会话的操作模型。 */
  onStopOperationAgent?: () => Promise<void>;
  onStartCodeReview?: (
    selection: SessionCodeReviewSelection,
  ) => void | boolean | { state: 'preparing'; cancel: () => void } | { state: 'failed'; message: string } | Promise<void | boolean | { state: 'preparing'; cancel: () => void } | { state: 'failed'; message: string }>;
  onAddSources?: () => void | Promise<void>;
  onOpenSource?: (resource: ConversationResource) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
  onPopoverOpenChange?: (open: boolean) => void;
}

interface SourceRow {
  id: string;
  label: string;
  attachment?: NativeConversationAttachment;
  resource?: ConversationResource;
}

/** 正文列扣掉常驻卡 332px 后，仍能容纳 768px 正文和两侧留白。 */
const PERSISTENT_CARD_MIN_COLUMN_WIDTH = 1200;
const DEFAULT_VISIBLE_SOURCE_COUNT = 3;
/** 只保留最近 32 个范围的显示结果，打开时仍重新读取真实 Git 状态。 */
const environmentStatusCache = new WeakMap<DashboardClient, Map<string, GitEnvironmentStatus>>();

/** 分支引用一致时提供单键复制，存在差异时按仓库展示。 */
function SessionBranchCard(props: { kind: 'source' | 'target'; zh: boolean; branches?: GitEnvironmentStatus['sourceBranches']; branch: string | null; emptyLabel: string }) {
  /** 会话环境以创建工作树时的分支为来源，以工作分支为目标。 */
  const label = props.kind === 'source' ? (props.zh ? '来源分支' : 'Source branch') : props.zh ? '目标分支' : 'Target branch';
  /** 同名判断以首仓真实分支为起点。 */
  const firstBranch = props.branches?.[0]?.branch;
  /** 多仓只有分支全部已知且一致时才复制单个名称。 */
  const copyableBranch = props.branches?.length ? (firstBranch && props.branches.every((entry) => entry.branch === firstBranch) ? firstBranch : null) : props.branch;
  /** 多仓异名时优先显示分支名，完整的仓库映射可悬停查看。 */
  const value = copyableBranch ?? (props.branches?.some((entry) => entry.branch) ? props.branches.map((entry) => `${entry.branch ?? (props.zh ? '未记录' : 'Not recorded')} (${entry.repositoryRelativePath})`).join(' · ') : props.emptyLabel);
  return (
    <div className="session-quick-actions-row is-static session-quick-actions-branch">
      <GitBranch aria-hidden="true" weight="regular" />
      <span className="session-quick-actions-copy">
        <small>{label}</small>
        <strong title={value}>{value}</strong>
      </span>
      {copyableBranch ? <RuntimeCopyButton text={copyableBranch} label={props.zh ? `复制${label}` : `Copy ${label.toLowerCase()}`} copiedLabel={props.zh ? `${label}已复制` : `${label} copied`} /> : null}
    </div>
  );
}

export function SessionQuickActionsCard(props: SessionQuickActionsCardProps) {
  const zh = props.language === 'zh-CN';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  /** 只接收当前范围的共享摘要，后台刷新保留上次显示结果。 */
  const [summary, setSummary] = useState<GitEnvironmentStatus | null>(null);
  const [workspaceState, setWorkspaceState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [workspaceError, setWorkspaceError] = useState<unknown>(null);
  /** 打开中的窗口按发起会话归属，迟到回执不能清除另一次打开状态。 */
  const [openingDelivery, setOpeningDelivery] = useState<{ conversationId: string } | null>(null);
  /** 异步窗口回执只关闭发起会话自己的面板。 */
  const currentConversationId = useRef(props.conversation.id);
  currentConversationId.current = props.conversation.id;
  const taskId = props.task?.id ?? props.conversation.taskId;
  const gitClient = props.gitContext?.client;
  /** 普通目录读取项目仓库，独立工作树继续使用服务端绑定的会话范围。 */
  const directWorkspace = props.conversation.workspaceMode === 'direct';
  /** 关联任务不等于使用任务工作树，普通目录任务仍读取项目全部仓库。 */
  const useTaskWorkspaces = Boolean(taskId && !directWorkspace && (props.conversation.workspaceId || props.conversation.workspaceMode !== 'worktree'));
  /** 持久范围身份决定何时重新读取，普通目录与独立工作树保持各自边界。 */
  const summaryKey = JSON.stringify([
    props.conversation.projectId,
    props.gitContext?.project.localPath,
    useTaskWorkspaces
      ? ['task', taskId, props.conversation.workspaceId, props.conversation.environmentId]
      : directWorkspace
        ? ['project']
        : ['conversation', props.conversation.id, props.conversation.workspaceId, props.conversation.environmentId],
  ]);
  /** 交付入口沿用原目录模式，摘要订阅不扩大写入范围。 */
  const conversationGitClient = !useTaskWorkspaces ? gitClient : null;
  /** 审查入口核对原工作区身份，不借用其他仓库。 */
  const workspace = summary?.workspace ?? props.conversation.workspace ?? null;
  const exactReviewWorkspace = workspace && workspace.id === props.conversation.workspaceId && workspace.environmentId === props.conversation.environmentId ? workspace : null;
  /** 首次摘要到达前显示会话根目录；单次命令进入子仓库不改变工作区身份。 */
  const executionContext = props.state.snapshot?.executionContext;
  /** 执行上下文保留只读审查、冲突处理等精确范围；Git 聚合摘要只补充尚未加载的目录。 */
  const cwd = executionContext?.cwd ?? summary?.cwd ?? props.conversation.executionPath ?? (directWorkspace ? props.gitContext?.project.localPath : null) ?? null;
  /** 工作目录保持单行，缺少路径时在原位置显示读取状态。 */
  const workingDirectoryLabel = cwd
    ? zh
      ? '工作目录'
      : 'Working directory'
    : workspaceState === 'idle' || workspaceState === 'loading'
      ? zh
        ? '正在读取工作目录…'
        : 'Loading working directory…'
      : zh
        ? '工作目录不可用'
        : 'Working directory unavailable';
  /** 有摘要入口时，确定仓库范围后再使用单仓分支。 */
  const workingBranch = summary?.repositoryCount === 1 ? summary.branch : !gitClient ? (executionContext?.branch ?? props.conversation.workspace?.branchName ?? null) : null;
  /** 独立工作树提前预留来源卡，直接使用目录时只有已记录的来源才显示。 */
  const showSourceBranch = useTaskWorkspaces || props.conversation.workspaceMode === 'worktree' || Boolean(summary?.sourceBranch || summary?.sourceBranches?.length);
  /** 分支读取和补齐期间保留卡片位置。 */
  const branchLoading = Boolean(gitClient && (workspaceState === 'idle' || workspaceState === 'loading'));
  /** 没有工作分支时显示实际的 Git 状态。 */
  const missingWorkingBranch =
    workspaceState === 'error'
      ? zh
        ? 'Git 状态读取失败'
        : 'Failed to read Git status'
      : branchLoading
        ? zh
          ? '正在读取分支…'
          : 'Loading branch…'
        : summary?.repositoryCount === 0
          ? zh
            ? '非 Git 目录'
            : 'Not a Git repository'
          : zh
            ? '分支不可用'
            : 'Branch unavailable';
  const conversationReady = !useTaskWorkspaces && (Boolean(summary?.repositoryCount) || executionContext?.isGitRepository === true);
  const sources = useMemo(() => collectSources(props.state), [props.state.attachments, props.state.items]);
  const visibleSources = showAllSources ? sources : sources.slice(0, DEFAULT_VISIBLE_SOURCE_COUNT);
  /** 只区分是否有未提交更改，不读取或显示文件数及差异行数。 */
  const dirty = summary?.dirty ?? false;
  /** 交付行用图形和语义色区分 Git 状态，完整含义供悬停和读屏读取。 */
  const deliveryStatus =
    openingDelivery?.conversationId === props.conversation.id
      ? { icon: CircleNotch, state: 'loading', label: zh ? '正在打开代码交付…' : 'Opening code delivery…' }
      : !summary && (workspaceState === 'idle' || workspaceState === 'loading')
        ? { icon: CircleNotch, state: 'loading', label: zh ? '正在读取 Git 状态…' : 'Loading Git status…' }
        : workspaceState === 'error'
          ? { icon: WarningCircle, state: 'error', label: zh ? 'Git 状态读取失败' : 'Failed to load Git status' }
          : dirty
            ? { icon: PencilSimpleLine, state: 'dirty', label: zh ? '有未提交更改' : 'Uncommitted changes' }
            : summary?.repositoryCount
              ? { icon: CheckCircle, state: 'clean', label: zh ? '工作区干净' : 'Working tree clean' }
              : { icon: MinusCircle, state: 'unavailable', label: zh ? '非 Git 目录' : 'Not a Git repository' };
  /** 保持状态图标的组件身份，加载时复用会话已有的旋转及减弱动画规则。 */
  const DeliveryStatusIcon = deliveryStatus.icon;
  /** 进入页面不依赖预读成功；加载和目录错误由交付页呈现并提供重试。 */
  const canOpenDelivery = Boolean(conversationGitClient || (useTaskWorkspaces && props.onOpenGitDelivery));
  const codeReviewUnavailableReason = resolveCodeReviewUnavailableReason({
    zh,
    taskId: useTaskWorkspaces ? taskId : null,
    conversation: props.conversation,
    workspace: exactReviewWorkspace,
    workspaceState,
    startAvailable: Boolean(props.onStartCodeReview),
    conversationReady,
  });
  const canStartCodeReview = codeReviewUnavailableReason === null;
  const subagentCount = props.subagentCount ?? 0;
  /** 常驻只看正文列真实可用宽度：右侧终端或浏览器变宽都会让这里重新判定。 */
  const hasPersistentSpace = props.conversationColumnWidth >= PERSISTENT_CARD_MIN_COLUMN_WIDTH;
  const persistent = hasPersistentSpace && !props.forceCollapsed;
  const cardVisible = !props.suppressed && (persistent || open);
  const cardMounted = cardVisible || Boolean(props.suppressed && persistent);
  /** 进度沿用点击交付时的真实范围，冲突会话继续指向来源交付。 */
  const deliveryTarget = conversationGitDeliveryTarget({ ...props.conversation, taskId }, props.conversation.workspaceId ?? workspace?.id ?? null);
  /** 稳定身份避免流式消息更新重复预热同一交付窗口。 */
  const deliveryTargetKey = JSON.stringify(deliveryTarget);
  /** 返回主窗口或靠近入口时补齐预热；失败仍由真实打开报告。 */
  const preloadDelivery = useCallback(() => {
    if (props.suppressed || !canOpenDelivery) return;
    void window.zeus?.openTaskGitDeliveryWindow({ ...JSON.parse(deliveryTargetKey), preload: true }).catch(() => undefined);
  }, [props.suppressed, canOpenDelivery, deliveryTargetKey]);
  useEffect(() => {
    if (props.suppressed || !canOpenDelivery || !window.zeus?.openTaskGitDeliveryWindow) return;
    /** 首屏渲染后只准备当前会话，真实点击仍负责显示和报告失败。 */
    const idle = window.requestIdleCallback(preloadDelivery, { timeout: 500 });
    window.addEventListener('focus', preloadDelivery);
    return () => {
      window.cancelIdleCallback(idle);
      window.removeEventListener('focus', preloadDelivery);
    };
  }, [props.suppressed, canOpenDelivery, preloadDelivery]);
  /** 项目级单步交付没有组合运行，不读取其他会话的组合进度。 */
  const deliveryScopeId = deliveryTarget.taskId ?? deliveryTarget.conversationId ?? null;
  /** 只在卡片可见时订阅交付事件，不增加 Git 文件变化订阅。 */
  const { runs: deliveryRuns, error: deliveryProgressError, refresh: refreshDelivery } = useGitDeliveryRuns(gitClient, props.conversation.projectId, deliveryScopeId, cardVisible);
  /** 环境卡片只显示当前仍需展示的交付。 */
  const deliveryRun = deliveryRuns[0];
  /** 浮动快捷面板退场不延长数据订阅；常驻模式继续保持原组件身份。 */
  const { ref: cardRef, present: cardPresent } = useMotionPresence<HTMLDivElement>(cardMounted);
  const popoverOpen = cardVisible && !persistent;
  /** 手动展开的环境侧栏仍由顶部按钮控制。 */
  const docked = !persistent && Boolean(props.dockHost);

  useLayoutEffect(() => {
    props.onPopoverOpenChange?.(popoverOpen);
    return () => {
      if (popoverOpen) props.onPopoverOpenChange?.(false);
    };
  }, [popoverOpen, props.onPopoverOpenChange]);

  useEffect(() => {
    if (!props.forceCollapsed) return;
    setOpen(false);
  }, [props.forceCollapsed]);

  useEffect(() => {
    if (!props.suppressed) return;
    setOpen(false);
  }, [props.suppressed]);

  useEffect(() => {
    setOpen(false);
    setShowAllSources(false);
    setReviewDialogOpen(false);
  }, [props.conversation.id]);

  /** 切换范围先清除旧状态，不把上个工作区的更改状态带入当前会话。 */
  useLayoutEffect(() => {
    /** 缓存按客户端与持久范围隔离，绝不借用上个会话的目录或状态。 */
    const cached = gitClient ? environmentStatusCache.get(gitClient)?.get(summaryKey) : undefined;
    setSummary(cached ?? null);
    setWorkspaceState(cached ? 'ready' : 'idle');
    setWorkspaceError(null);
  }, [gitClient, summaryKey]);

  /** 打开卡片、轮次切换、交付完成和窗口恢复焦点时按需读取，关闭后取消请求。 */
  useEffect(() => {
    if (!cardVisible || !gitClient) return;
    /** 后续读取取消旧请求，旧范围和旧结果不能覆盖当前状态。 */
    let controller: AbortController | undefined;
    /** 目录由服务端按持久身份解析，不传本地路径。 */
    const scope = useTaskWorkspaces && taskId ? { taskId, workspaceId: props.conversation.workspaceId ?? undefined } : directWorkspace ? {} : { conversationId: props.conversation.id };
    /** 复用轻量状态接口，不订阅文件变化或读取差异统计。 */
    const refreshStatus = (): void => {
      if (document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      /** 每次读取保留自身取消信号，迟到结果不得覆盖后续读取。 */
      const { signal } = controller;
      setWorkspaceState('loading');
      setWorkspaceError(null);
      void gitClient
        .loadGitEnvironmentStatus(props.conversation.projectId, scope, signal)
        .then((next) => {
          if (signal.aborted) return;
          /** 有界显示缓存不参与交付和权限判断，服务端继续核验真实范围。 */
          const cache = environmentStatusCache.get(gitClient) ?? new Map<string, GitEnvironmentStatus>();
          cache.delete(summaryKey);
          cache.set(summaryKey, next);
          if (cache.size > 32) cache.delete(cache.keys().next().value!);
          environmentStatusCache.set(gitClient, cache);
          setSummary(next);
          setWorkspaceState('ready');
        })
        .catch((error: unknown) => {
          if (signal.aborted) return;
          setWorkspaceState('error');
          setWorkspaceError(error);
        });
    };
    /** 只接收当前任务的交付结果，不借用其他任务的状态。 */
    const unsubscribeDelivery = window.zeus?.onTaskGitDeliveryChanged?.((changedTaskId) => {
      if (changedTaskId === taskId) refreshStatus();
    });
    refreshStatus();
    window.addEventListener('focus', refreshStatus);
    return () => {
      controller?.abort();
      unsubscribeDelivery?.();
      window.removeEventListener('focus', refreshStatus);
    };
  }, [cardVisible, gitClient, summaryKey, props.conversation.id, props.conversation.projectId, props.conversation.workspaceId, props.state.activeTurnId, useTaskWorkspaces, directWorkspace, taskId]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) || cardRef.current?.contains(event.target as Node)) return;
      // 应用选择器浮层挂在应用壳上，选中应用前保留环境卡。
      if (event.target instanceof Element && event.target.closest('.session-working-directory-apps-popover')) return;
      if (docked) return;
      setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // 子面板优先处理 Esc，收起后焦点留在环境信息卡。
      if (cardRef.current?.querySelector('.session-computer-preview-info:popover-open, .session-working-directory-apps[data-open="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', closeFromOutside, true);
    window.addEventListener('keydown', closeFromKeyboard, true);
    return () => {
      window.removeEventListener('pointerdown', closeFromOutside, true);
      window.removeEventListener('keydown', closeFromKeyboard, true);
    };
  }, [open, docked]);

  useLayoutEffect(() => {
    if (!cardVisible) return;
    const card = cardRef.current;
    if (!card) return;

    const updateAvailableHeight = (): void => {
      const viewport = window.visualViewport;
      const viewportBottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      const cardTop = card.getBoundingClientRect().top;
      card.style.setProperty('--session-quick-actions-available-height', `${Math.max(0, Math.floor(viewportBottom - cardTop - 16))}px`);
    };

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateAvailableHeight);
    const persistentParent = persistent ? props.persistentHost?.parentElement : null;
    const observePersistentLayout = (): void => {
      if (!resizeObserver || !props.persistentHost) return;
      resizeObserver.disconnect();
      resizeObserver.observe(props.persistentHost);
      let sibling = props.persistentHost.previousElementSibling;
      while (sibling) {
        if (sibling instanceof HTMLElement) resizeObserver.observe(sibling);
        sibling = sibling.previousElementSibling;
      }
    };
    if (persistent) observePersistentLayout();
    else if (rootRef.current && resizeObserver) resizeObserver.observe(rootRef.current);

    const mutationObserver =
      persistentParent && typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            observePersistentLayout();
            updateAvailableHeight();
          })
        : null;
    mutationObserver?.observe(persistentParent as HTMLElement, { childList: true });

    const frame = window.requestAnimationFrame(updateAvailableHeight);
    window.addEventListener('resize', updateAvailableHeight);
    window.visualViewport?.addEventListener('resize', updateAvailableHeight);
    window.visualViewport?.addEventListener('scroll', updateAvailableHeight);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', updateAvailableHeight);
      window.visualViewport?.removeEventListener('resize', updateAvailableHeight);
      window.visualViewport?.removeEventListener('scroll', updateAvailableHeight);
      card.style.removeProperty('--session-quick-actions-available-height');
    };
  }, [cardVisible, persistent, props.persistentHost]);

  /** 同一个按钮统一打开原生交付窗口，任务范围保留现有工作区定位。 */
  async function openDelivery(): Promise<void> {
    if (openingDelivery?.conversationId === props.conversation.id) return;
    /** 与快捷键共用目录模式，摘要只补充尚未带回的任务工作区身份。 */
    const target = conversationGitDeliveryTarget({ ...props.conversation, taskId }, props.conversation.workspaceId ?? workspace?.id ?? null);
    /** 按钮立即反馈并防止重复提交，窗口可用后再关闭浮动面板。 */
    const opening = { conversationId: props.conversation.id };
    setOpeningDelivery(opening);
    try {
      if (conversationGitClient) {
        if (!window.zeus?.openTaskGitDeliveryWindow) throw new Error(zh ? '当前环境无法打开代码交付窗口。' : 'The code delivery window is unavailable in this environment.');
        await window.zeus.openTaskGitDeliveryWindow(target);
      } else if (target.taskId && props.onOpenGitDelivery) {
        await props.onOpenGitDelivery(target.taskId, target.workspaceId ?? null);
      }
      if (currentConversationId.current === opening.conversationId) setOpen(false);
    } catch (error) {
      reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' });
    } finally {
      setOpeningDelivery((current) => (current === opening ? null : current));
    }
  }

  /** 浮层关闭后使用环境入口恢复焦点，避免引用已经卸载的工具行。 */
  function toggleTool(trigger: HTMLButtonElement, action: ((trigger: HTMLButtonElement) => void) | undefined): void {
    if (!action) return;
    /** 常驻卡没有折叠按钮，保留当前工具行作为返回目标。 */
    const returnTarget = triggerRef.current ?? trigger;
    setOpen(false);
    action(returnTarget);
  }

  function openCodeReview(): void {
    if (!canStartCodeReview) return;
    setOpen(false);
    setReviewDialogOpen(true);
  }

  function openSubagents(trigger: HTMLButtonElement): void {
    setOpen(false);
    props.onOpenSubagents?.(trigger);
  }

  return (
    <div className="session-quick-actions-anchor" ref={rootRef} data-presentation={persistent ? 'persistent' : 'collapsed'}>
      {workspaceError ? (
        <span role="alert">
          <VisibleApplicationError error={workspaceError} language={zh ? 'zh-CN' : 'en'} />
        </span>
      ) : null}
      {persistent || props.suppressed ? null : (
        <Button
          unstyled
          ref={triggerRef}
          type="button"
          className={`session-quick-actions-trigger ${open ? 'selected' : ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-label={zh ? '环境与快捷操作' : 'Environment and quick actions'}
          data-icon-tooltip={zh ? '环境与快捷操作' : 'Environment and quick actions'}
          onClick={() => setOpen((current) => !current)}
        >
          <Desktop aria-hidden="true" weight="regular" />
        </Button>
      )}

      {cardPresent ? (
        <SessionQuickActionsCardMount persistent={persistent || docked} host={docked ? props.dockHost : props.persistentHost}>
          <div
            ref={cardRef}
            className="session-quick-actions-surface"
            data-motion-surface={persistent ? undefined : 'popover'}
            data-motion-state={cardMounted ? 'open' : 'closing'}
            inert={!cardVisible}
            aria-hidden={!cardVisible}
            data-presentation={persistent ? 'persistent' : docked ? 'docked' : 'popover'}
            hidden={props.suppressed || undefined}
          >
            <section
              className="session-quick-actions-card"
              data-presentation={persistent ? 'persistent' : docked ? 'docked' : 'popover'}
              data-sources-expanded={showAllSources || undefined}
              role={persistent || docked ? 'region' : 'dialog'}
              aria-label={zh ? '环境信息与快捷操作' : 'Environment information and quick actions'}
            >
              {/* 标题、Git 状态、来源与错误补载共用自然高度过渡，外层边框随内容连续调整。 */}
              <Collapsible open animateHeight>
                <header>
                  <strong>{zh ? '环境信息' : 'Environment'}</strong>
                </header>

                <div className="session-quick-actions-list">
                  <div className="session-quick-actions-row is-static" data-icon-tooltip={cwd ?? undefined}>
                    {cwd ? <FileTypeIcon path={cwd} kind="directory" size={17} /> : <Folder aria-hidden="true" weight="regular" />}
                    <span className="session-quick-actions-copy">
                      <strong>{workingDirectoryLabel}</strong>
                    </span>
                    {cwd ? <RuntimeCopyButton text={cwd} label={zh ? '复制工作目录' : 'Copy working directory'} copiedLabel={zh ? '工作目录已复制' : 'Working directory copied'} /> : null}
                  </div>
                  {cwd && window.zeus?.openWorkingDirectory ? (
                    <SessionWorkingDirectoryLauncher
                      key={JSON.stringify([props.conversation.projectId, props.conversation.id, cwd])}
                      projectId={props.conversation.projectId}
                      conversationId={props.conversation.id}
                      cwd={cwd}
                      visible={cardVisible}
                      zh={zh}
                    />
                  ) : null}

                  {showSourceBranch ? (
                    <SessionBranchCard
                      kind="source"
                      zh={zh}
                      branches={summary?.sourceBranches}
                      branch={summary?.sourceBranch ?? null}
                      emptyLabel={branchLoading ? (zh ? '正在读取分支…' : 'Loading branch…') : zh ? '未记录' : 'Not recorded'}
                    />
                  ) : null}
                  <SessionBranchCard kind="target" zh={zh} branches={summary?.workingBranches} branch={workingBranch} emptyLabel={missingWorkingBranch} />

                  {subagentCount > 0 && props.onOpenSubagents ? (
                    <Button unstyled type="button" className="session-quick-actions-row" onClick={(event) => openSubagents(event.currentTarget)}>
                      <UsersThree aria-hidden="true" weight="regular" />
                      <span className="session-quick-actions-copy">
                        <strong>{zh ? '智能体' : 'Agents'}</strong>
                        <small>{zh ? `${subagentCount} 个线程` : `${subagentCount} ${subagentCount === 1 ? 'thread' : 'threads'}`}</small>
                      </span>
                      <ArrowSquareOut aria-hidden="true" weight="regular" />
                    </Button>
                  ) : null}

                  {props.onToggleSideQuestion ? (
                    <Button
                      unstyled
                      type="button"
                      className="session-quick-actions-row"
                      aria-label={zh ? '侧边栏会话' : 'Sidebar conversation'}
                      aria-pressed={props.sideQuestionOpen ?? false}
                      onClick={(event) => toggleTool(event.currentTarget, props.onToggleSideQuestion)}
                    >
                      <ChatCircle aria-hidden="true" weight="regular" />
                      <span className="session-quick-actions-copy">
                        <strong>{zh ? '侧边栏会话' : 'Sidebar conversation'}</strong>
                      </span>
                    </Button>
                  ) : null}

                  <Button
                    unstyled
                    type="button"
                    className="session-quick-actions-row"
                    aria-label={zh ? '浏览器' : 'Browser'}
                    aria-pressed={props.browserOpen}
                    aria-keyshortcuts="Meta+Shift+B Control+Shift+B"
                    data-icon-tooltip={platformShortcutLabel('⌘⇧B')}
                    onClick={(event) => toggleTool(event.currentTarget, props.onToggleBrowser)}
                  >
                    <GlobeSimple aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{zh ? '浏览器' : 'Browser'}</strong>
                    </span>
                  </Button>

                  {props.onToggleTerminal ? (
                    <Button
                      unstyled
                      type="button"
                      className="session-quick-actions-row"
                      aria-label={zh ? '会话终端' : 'Conversation terminal'}
                      aria-pressed={props.terminalOpen}
                      aria-keyshortcuts="Control+`"
                      data-icon-tooltip="Ctrl+`"
                      onClick={(event) => toggleTool(event.currentTarget, props.onToggleTerminal)}
                    >
                      <TerminalWindow aria-hidden="true" weight="regular" />
                      <span className="session-quick-actions-copy">
                        <strong>{zh ? '会话终端' : 'Conversation terminal'}</strong>
                      </span>
                    </Button>
                  ) : null}

                  <Button unstyled type="button" className="session-quick-actions-row" disabled={!canStartCodeReview} data-icon-tooltip={codeReviewUnavailableReason ?? undefined} onClick={openCodeReview}>
                    <FileCode aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{zh ? '代码审查' : 'Code review'}</strong>
                    </span>
                    <ArrowSquareOut aria-hidden="true" weight="regular" />
                  </Button>

                  <div className="session-quick-actions-delivery">
                    <Button
                      unstyled
                      type="button"
                      className="session-quick-actions-row"
                      disabled={!canOpenDelivery || openingDelivery?.conversationId === props.conversation.id}
                      aria-busy={openingDelivery?.conversationId === props.conversation.id || undefined}
                      data-icon-tooltip={!canOpenDelivery ? (zh ? '当前会话没有可用的项目 Git 入口' : 'Project Git is unavailable for this conversation') : undefined}
                      onClick={openDelivery}
                      onPointerEnter={preloadDelivery}
                      onFocus={preloadDelivery}
                    >
                      <GithubLogo aria-hidden="true" weight="regular" />
                      <span className="session-quick-actions-copy">
                        <strong>{zh ? '代码交付' : 'Code delivery'}</strong>
                        {deliveryProgressError ? <small role="status">{zh ? '交付进度读取失败' : 'Delivery progress unavailable'}</small> : null}
                      </span>
                      {deliveryRun ? null : (
                        <IconTooltip label={deliveryStatus.label}>
                          <DeliveryStatusIcon
                            role="img"
                            aria-label={deliveryStatus.label}
                            className={`session-quick-actions-delivery-status${deliveryStatus.state === 'loading' ? ' session-conversation-state-spinner' : ''}`}
                            data-state={deliveryStatus.state}
                            size={17}
                            weight="regular"
                          />
                        </IconTooltip>
                      )}
                    </Button>
                    {deliveryRun ? (
                      <div className="session-quick-actions-delivery-progress">
                        <GitDeliveryProgress run={deliveryRun} zh={zh} showErrorSummaries />
                        {gitClient ? <GitDeliveryRunActions client={gitClient} run={deliveryRun} zh={zh} onUpdated={() => refreshDelivery()} /> : null}
                      </div>
                    ) : null}
                  </div>
                </div>

                <section className="session-quick-actions-sources" aria-label={zh ? '来源' : 'Sources'}>
                  <header>
                    <strong>{zh ? '来源' : 'Sources'}</strong>
                    {props.onAddSources ? (
                      <Button unstyled type="button" aria-label={zh ? '添加来源' : 'Add source'} data-icon-tooltip={zh ? '添加到当前输入' : 'Add to current input'} onClick={() => props.onAddSources?.()}>
                        <Plus aria-hidden="true" weight="regular" />
                      </Button>
                    ) : null}
                  </header>
                  {visibleSources.length > 0 ? (
                    <ol>
                      {visibleSources.map((source) => (
                        <li key={source.id}>
                          {source.resource && props.onOpenSource ? (
                            <Button unstyled type="button" data-icon-tooltip={source.label} onClick={() => props.onOpenSource?.(source.resource as ConversationResource)}>
                              <SessionQuickActionSourceVisual source={source} onLoadResourcePreview={props.onLoadResourcePreview} />
                              <span className="session-quick-actions-source-label">{source.label}</span>
                            </Button>
                          ) : (
                            <span data-icon-tooltip={source.label}>
                              <SessionQuickActionSourceVisual source={source} onLoadResourcePreview={props.onLoadResourcePreview} />
                              <span className="session-quick-actions-source-label">{source.label}</span>
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>{zh ? '当前会话还没有来源。' : 'No sources in this conversation yet.'}</p>
                  )}
                  {sources.length > DEFAULT_VISIBLE_SOURCE_COUNT ? (
                    <Button unstyled type="button" className="session-quick-actions-view-all" aria-expanded={showAllSources} onClick={() => setShowAllSources((current) => !current)}>
                      <ShareNetwork aria-hidden="true" weight="regular" />
                      <span>{showAllSources ? (zh ? '收起' : 'Show less') : zh ? '查看全部' : 'View all'}</span>
                    </Button>
                  ) : null}
                </section>
              </Collapsible>
            </section>
            <SessionComputerPreview key={props.conversation.id} conversationId={props.conversation.id} language={props.language} active={cardVisible} onStopOperationAgent={props.onStopOperationAgent} />
          </div>
        </SessionQuickActionsCardMount>
      ) : null}
      <MotionPresence>
        {reviewDialogOpen ? (
          <SessionCodeReviewDialog
            open={reviewDialogOpen}
            language={props.language}
            conversation={props.conversation}
            state={props.state}
            workspace={exactReviewWorkspace}
            repositoryName={summary?.repositoryName}
            capabilities={props.capabilities ?? null}
            onLoadCapabilities={props.onLoadCapabilities}
            onLoadSkills={props.onLoadSkills}
            onClose={() => setReviewDialogOpen(false)}
            onStart={props.onStartCodeReview}
          />
        ) : null}
      </MotionPresence>
    </div>
  );
}

function SessionQuickActionSourceVisual(props: { source: SourceRow; onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview> }) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const sourceRef = useRef(props.source);
  const loadPreviewRef = useRef(props.onLoadResourcePreview);
  const [visible, setVisible] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  sourceRef.current = props.source;
  loadPreviewRef.current = props.onLoadResourcePreview;
  const image = isImageSource(props.source);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !image || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setVisible(true);
        observer.disconnect();
      },
      { rootMargin: '96px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, [image, visible]);

  useEffect(() => {
    if (!image || !visible) return;
    let active = true;
    setPreviewUrl(null);
    setPreviewFailed(false);
    void loadSourcePreview(sourceRef.current, loadPreviewRef.current)
      .then((url) => {
        if (!active) return;
        if (url) setPreviewUrl(url);
        else setPreviewFailed(true);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      });
    return () => {
      active = false;
    };
  }, [image, props.source.id, visible]);

  return (
    <span ref={rootRef} className="session-quick-actions-source-visual" aria-hidden="true" data-image={image || undefined} data-preview-failed={previewFailed || undefined}>
      {previewUrl && !previewFailed ? <img src={previewUrl} alt="" loading="lazy" onError={() => setPreviewFailed(true)} /> : <SourceFallbackIcon source={props.source} />}
    </span>
  );
}

/** 来源列表使用登记资源或原始附件的文件名。 */
function SourceFallbackIcon(props: { source: SourceRow }) {
  if (props.source.resource) return <ResourceIcon resource={props.source.resource} />;
  /** 未持久化的来源只有原始附件信息。 */
  const attachment = props.source.attachment;
  return <FileTypeIcon path={attachment?.kind === 'pasted_text' ? 'pasted.txt' : (attachment?.name ?? '')} kind={attachment?.kind === 'directory' ? 'directory' : undefined} />;
}

function isImageSource(source: SourceRow): boolean {
  if (source.resource) return isImageResource(source.resource);
  return Boolean(source.attachment && isPendingImageAttachment(source.attachment));
}

async function loadSourcePreview(source: SourceRow, loadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>): Promise<string | null> {
  if (source.resource) {
    if (!loadResourcePreview) return null;
    const preview = await loadResourcePreview(source.resource);
    return preview.kind === 'image' ? preview.dataUrl : null;
  }
  if (!source.attachment || !window.zeus?.getConversationResourcePreview) return null;
  const preview = await window.zeus.getConversationResourcePreview({
    ...(source.attachment.localPath ? { localPath: source.attachment.localPath } : {}),
    ...(source.attachment.uploadRef ? { uploadRef: source.attachment.uploadRef } : {}),
  });
  return preview?.mimeType.startsWith('image/') ? preview.previewUrl : null;
}

function SessionQuickActionsCardMount(props: { persistent: boolean; host?: HTMLElement | null; children: ReactNode }) {
  if (!props.persistent) return props.children;
  return props.host ? createPortal(props.children, props.host) : null;
}

/** 审查以原目录是否保留为准，已交付工作区仍可读取。 */
function resolveCodeReviewUnavailableReason(input: {
  zh: boolean;
  taskId: string | null | undefined;
  conversation: NativeConversationChoice;
  workspace: GitEnvironmentWorkspace | null;
  workspaceState: 'idle' | 'loading' | 'ready' | 'error';
  startAvailable: boolean;
  conversationReady: boolean;
}): string | null {
  if (!input.startAvailable) return input.zh ? '当前版本没有可用的代码审查入口' : 'Code review is unavailable in this version';
  if (!input.taskId) {
    if (input.conversationReady) return null;
    return input.zh ? (input.workspaceState === 'error' ? '会话工作目录不可用，请检查目录后重试' : '正在检查会话工作目录…') : 'The conversation working folder is not ready';
  }
  if (!input.conversation.workspaceId || !input.conversation.environmentId) {
    return input.zh ? '此对话没有任务开始时的代码记录。请从拥有独立工作目录的任务对话启动审查' : 'This conversation has no record of the code when the task started. Start the review from a task conversation with its own working folder';
  }
  if (!input.workspace && (input.workspaceState === 'idle' || input.workspaceState === 'loading')) return input.zh ? '正在检查代码审查的工作目录…' : 'Checking the working folder for the code review…';
  if (input.workspaceState === 'error') return input.zh ? '读取工作目录失败，请重新打开面板重试' : 'Failed to load the working folder. Reopen this panel to retry';
  if (!input.workspace || !['ready', 'merged'].includes(input.workspace.state) || !input.workspace.worktreePath) return input.zh ? '此任务的工作目录已回收或不可用' : 'This task’s working folder has been reclaimed or is unavailable';
  return null;
}

function collectSources(state: NativeSessionState): SourceRow[] {
  const byId = new Map<string, SourceRow>();
  for (const attachment of state.attachments) {
    const id = `attachment:${conversationAttachmentIdentity(attachment)}`;
    byId.set(id, { id, label: attachment.name, attachment });
  }
  for (const resource of Object.values(state.items).flatMap((item) => item.resources)) {
    byId.set(`resource:${resource.id}`, { id: `resource:${resource.id}`, label: resource.displayName, resource });
  }
  return [...byId.values()];
}
