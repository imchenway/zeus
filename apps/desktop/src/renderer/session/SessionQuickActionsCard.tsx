import { RuntimeCopyButton } from './RuntimeDetails.js';
import { Collapsible } from '../ui/Collapsible.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useMotionPresence } from '../ui/useMotionPresence.js';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { DesktopIcon as Desktop } from '@phosphor-icons/react/dist/csr/Desktop';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { fileIconForKind, fileIconKindForName } from '../code/FileTypeIcon.js';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileImageIcon as FileImage } from '@phosphor-icons/react/dist/csr/FileImage';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GithubLogoIcon as GithubLogo } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/dist/csr/ShareNetwork';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { UsersThreeIcon as UsersThree } from '@phosphor-icons/react/dist/csr/UsersThree';
import { conversationAttachmentIdentity } from './ConversationComposerAttachments.js';
import { isImageResource, isPendingImageAttachment, ResourceIcon } from './ConversationResources.js';
import { SessionCodeReviewDialog, type SessionCodeReviewSelection } from './SessionCodeReviewDialog.js';
import { SessionComputerPreview } from './SessionComputerPreview.js';
import type {
  CodexConversationCapabilities,
  ConversationResource,
  ConversationResourcePreview,
  NativeConversationAttachment,
  NativeConversationChoice,
  NativeSessionState,
  TaskWorkspaceSnapshot,
  TaskWorkspacesSnapshot,
} from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { VisibleApplicationError, reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { DashboardClient, ProjectRecord, ProjectGitWorkbenchSnapshot } from '../apiClient.js';
import { platformShortcutLabel } from '../platform.js';
import { requestProjectGitWorkbench, subscribeProjectGitRefresh, visibleRepositoryFiles } from '../git/projectGitWorkbenchState.js';
import { deliveryWorkspacesForConversationBranch } from '../task/taskGitWorkspaceScope.js';

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
  onLoadTaskWorkspaces?: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  /** 交付通知使当前会话的 Git 快照失效。 */
  taskGitDeliveryRevision?: number;
  onOpenGitDelivery?: (taskId: string, workspaceId: string | null) => void;
  /** 内置浏览器的显示状态由当前会话工作面维护。 */
  browserOpen: boolean;
  /** 入口只切换显示，浏览器标签与关闭流程仍由会话管理。 */
  onToggleBrowser: (trigger: HTMLButtonElement) => void;
  /** 会话终端继续使用原有会话身份和显示状态。 */
  terminalOpen: boolean;
  /** 缺少终端能力时不显示入口，不创建项目级替代终端。 */
  onToggleTerminal?: (trigger: HTMLButtonElement) => void;
  subagentCount?: number;
  onOpenSubagents?: (trigger: HTMLButtonElement) => void;
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

export function SessionQuickActionsCard(props: SessionQuickActionsCardProps) {
  const zh = props.language === 'zh-CN';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<TaskWorkspacesSnapshot | null>(null);
  const [workspaceState, setWorkspaceState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [workspaceError, setWorkspaceError] = useState<unknown>(null);
  const taskId = props.task?.id ?? props.conversation.taskId;
  const gitClient = props.gitContext?.client;
  /** 普通目录读取项目仓库，独立工作树继续使用服务端绑定的会话范围。 */
  const directWorkspace = props.conversation.workspaceMode === 'direct';
  /** 关联任务不等于使用任务工作树，普通目录任务仍读取项目全部仓库。 */
  const useTaskWorkspaces = Boolean(taskId && !directWorkspace);
  /** 普通目录共用项目客户端，独立会话保留其受限客户端。 */
  const conversationGitClient = useMemo(
    () => (!useTaskWorkspaces && gitClient ? (directWorkspace ? gitClient : { ...gitClient, ...gitClient.forConversationGit(props.conversation.id) }) : null),
    [gitClient, props.conversation.id, useTaskWorkspaces, directWorkspace],
  );
  const [conversationGit, setConversationGit] = useState<{ id: string; snapshot: ProjectGitWorkbenchSnapshot } | null>(null);
  const conversationRepository = conversationGit?.id === props.conversation.id ? conversationGit.snapshot.repositories[0] : null;
  const conversationReview = conversationRepository?.snapshot;
  /** 仓库身份与嵌套关系用于排除父仓重复占位，统计范围与交付页一致。 */
  const conversationRepositories = conversationGit?.id === props.conversation.id ? conversationGit.snapshot.repositories : [];
  const conversationReady = !taskId && workspaceState === 'ready' && Boolean(conversationRepository);

  /** 普通目录不能借用同一任务的历史工作树。 */
  const workspace = useTaskWorkspaces ? resolveConversationWorkspace(workspaces, props.conversation, props.state) : null;
  /** 与任务交付页复用相同分支筛选，覆盖该分支的全部仓库。 */
  const deliveryWorkspaces = deliveryWorkspacesForConversationBranch(workspaces?.items ?? [], props.conversation.workspaceId ?? workspace?.id);
  const exactReviewWorkspace = workspace && workspace.id === props.conversation.workspaceId && workspace.environmentId === props.conversation.environmentId ? workspace : null;
  /** 两处环境展示采用相同的最近命令事实，工作区交付身份仍沿用会话绑定。 */
  const executionContext = props.state.snapshot?.executionContext?.recentCommand ?? props.state.snapshot?.executionContext;
  const cwd = (directWorkspace ? props.gitContext?.project.localPath : conversationRepository?.localPath) ?? executionContext?.cwd ?? workspace?.review?.cwd ?? workspace?.worktreePath ?? null;
  /** 多仓目录不把首仓分支冒充整个项目的分支，具体选择由交付页呈现。 */
  const branch =
    directWorkspace && conversationRepositories.length > 1
      ? zh
        ? '多个仓库'
        : 'Multiple repositories'
      : (conversationReview?.branch ?? (executionContext?.cwd ? executionContext.branch : (workspace?.review?.branch ?? workspace?.branchName ?? null)));
  /** 项目快照的完整 diff 包含未跟踪文件；文件数按仓库身份分别去重。 */
  const changes = conversationGitClient
    ? conversationRepositories.reduce(
        (summary, repository) => {
          /** 文件树与统计共同排除嵌套仓库在父仓内的占位。 */
          const paths = new Set(visibleRepositoryFiles(repository, conversationRepositories).map((file) => file.path));
          return repository.snapshot.diff.fileDiffs
            .filter((file) => paths.has(file.newPath) || paths.has(file.oldPath))
            .reduce((counts, file) => ({ ...counts, additions: counts.additions + file.addedLines, deletions: counts.deletions + file.deletedLines }), { ...summary, files: summary.files + paths.size });
        },
        { files: 0, additions: 0, deletions: 0 },
      )
    : summarizeWorkspaceChanges(deliveryWorkspaces);
  const sources = useMemo(() => collectSources(props.state), [props.state.attachments, props.state.items]);
  const visibleSources = showAllSources ? sources : sources.slice(0, DEFAULT_VISIBLE_SOURCE_COUNT);
  /** 待提交提示与展示文件数使用同一范围，不受父仓占位的 dirty 状态影响。 */
  const dirty = changes.files > 0;
  /** 进入页面不依赖预读成功；加载和目录错误由交付页呈现并提供重试。 */
  const canOpenDelivery = Boolean(conversationGitClient || (useTaskWorkspaces && props.onOpenGitDelivery));
  const codeReviewUnavailableReason = resolveCodeReviewUnavailableReason({
    zh,
    taskId,
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

  /** 切换读取范围时清除旧快照，后台刷新只复用同一范围的成功结果。 */
  useEffect(() => {
    setConversationGit(null);
    setWorkspaces(null);
    setWorkspaceState('idle');
    setWorkspaceError(null);
  }, [props.conversation.id, props.conversation.projectId, props.conversation.workspaceId, props.conversation.environmentId, directWorkspace, taskId]);

  useEffect(() => {
    if (!cardVisible || (useTaskWorkspaces ? !props.onLoadTaskWorkspaces : !conversationGitClient)) return;
    /** 固定本次订阅的读取入口，切换会话后旧请求不得回写。 */
    const loadWorkspaces = props.onLoadTaskWorkspaces;
    /** 隐藏卡片或切换读取范围后，丢弃尚未结束的读取结果。 */
    let active = true;
    /** 只接收最近一次读取，避免返回窗口触发的并发请求覆盖新状态。 */
    let requestRevision = 0;
    /** 重新打开、交付变化、回合切换和返回窗口时读取真实 Git 状态。 */
    const refreshWorkspaces = (): void => {
      if (document.visibilityState === 'hidden') return;
      /** 当前请求的顺序，用于拒绝迟到的旧结果和旧错误。 */
      const revision = ++requestRevision;
      // 同一范围刷新保留已显示的快照，避免加载提示反复插入并改变卡片高度。
      setWorkspaceState((current) => (current === 'ready' ? current : 'loading'));
      setWorkspaceError(null);
      const request = useTaskWorkspaces
        ? loadWorkspaces!(taskId!).then((snapshot) => {
            if (active && revision === requestRevision) setWorkspaces(snapshot);
            /** 读取失败或绑定失效不能作为零变更发布。 */
            const current = resolveConversationWorkspace(snapshot, props.conversation, props.state);
            /** 校验范围与卡片统计、点击后打开的任务分支保持一致。 */
            const scoped = deliveryWorkspacesForConversationBranch(snapshot.items, props.conversation.workspaceId ?? current?.id);
            /** 保留服务端返回的仓库读取原因。 */
            const unavailable = scoped.find((item) => item.reviewError || !item.review);
            if (!scoped.length || unavailable) throw new Error(unavailable?.reviewError || (zh ? '任务工作目录不可用，请在代码交付页检查。' : 'The task working folder is unavailable. Check Code Delivery.'));
          })
        : requestProjectGitWorkbench(conversationGitClient!, props.conversation.projectId).then((snapshot) => {
            if (snapshot.repositories.some((repository) => !repository.snapshot.diff.isRepository)) throw new Error(zh ? '仓库差异读取不完整，请在代码交付页重试。' : 'Repository changes could not be fully loaded. Retry in Code Delivery.');
            if (active && revision === requestRevision) setConversationGit({ id: props.conversation.id, snapshot });
          });
      void request
        .then(() => {
          if (!active || revision !== requestRevision) return;
          setWorkspaceState('ready');
        })
        .catch((error: unknown) => {
          if (!active || revision !== requestRevision) return;
          setWorkspaceState('error');
          setWorkspaceError(error);
        });
    };
    refreshWorkspaces();
    /** 工作区写入、项目文件变化与窗口返回共用同一刷新订阅。 */
    const unsubscribe = subscribeProjectGitRefresh(props.conversation.projectId, refreshWorkspaces);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [
    cardVisible,
    props.conversation.id,
    props.conversation.workspaceId,
    props.conversation.environmentId,
    props.onLoadTaskWorkspaces,
    props.state.activeTurnId,
    props.taskGitDeliveryRevision,
    props.conversation.projectId,
    taskId,
    useTaskWorkspaces,
    directWorkspace,
    conversationGitClient,
    zh,
  ]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) || cardRef.current?.contains(event.target as Node)) return;
      if (docked) return;
      setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
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
    if (conversationGitClient) {
      setOpen(false);
      try {
        if (!window.zeus?.openTaskGitDeliveryWindow) throw new Error(zh ? '当前环境无法打开代码交付窗口。' : 'The code delivery window is unavailable in this environment.');
        await window.zeus.openTaskGitDeliveryWindow(directWorkspace && taskId ? { projectId: props.conversation.projectId } : { projectId: props.conversation.projectId, conversationId: props.conversation.id });
      } catch (error) {
        reportApplicationError(error, { language: zh ? 'zh-CN' : 'en' });
      }
      return;
    }
    if (!taskId || !props.onOpenGitDelivery) return;
    setOpen(false);
    props.onOpenGitDelivery(taskId, props.conversation.workspaceId ?? workspace?.id ?? null);
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
        <button
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
        </button>
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
                    <Folder aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{zh ? '工作目录' : 'Working directory'}</strong>
                      <small>{cwd ?? (zh ? '执行目录不可用' : 'Execution directory unavailable')}</small>
                    </span>
                    {cwd ? <RuntimeCopyButton text={cwd} label={zh ? '复制工作目录' : 'Copy working directory'} copiedLabel={zh ? '工作目录已复制' : 'Working directory copied'} /> : null}
                  </div>

                  <div className="session-quick-actions-row is-static" data-icon-tooltip={branch ?? undefined}>
                    <GitBranch aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{branch ?? (cwd ? (zh ? '非 Git 目录' : 'Not a Git repository') : zh ? '分支不可用' : 'Branch unavailable')}</strong>
                      {workspace?.sourceBranch ? <small>{zh ? `来源分支 ${workspace.sourceBranch}` : `Source branch ${workspace.sourceBranch}`}</small> : null}
                    </span>
                    {branch && !(directWorkspace && conversationRepositories.length > 1) ? (
                      <RuntimeCopyButton text={branch} label={zh ? '复制工作分支' : 'Copy working branch'} copiedLabel={zh ? '工作分支已复制' : 'Working branch copied'} />
                    ) : null}
                  </div>

                  {subagentCount > 0 && props.onOpenSubagents ? (
                    <button type="button" className="session-quick-actions-row" onClick={(event) => openSubagents(event.currentTarget)}>
                      <UsersThree aria-hidden="true" weight="regular" />
                      <span className="session-quick-actions-copy">
                        <strong>{zh ? '智能体' : 'Agents'}</strong>
                        <small>{zh ? `${subagentCount} 个线程` : `${subagentCount} ${subagentCount === 1 ? 'thread' : 'threads'}`}</small>
                      </span>
                      <ArrowSquareOut aria-hidden="true" weight="regular" />
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="session-quick-actions-row"
                    aria-label={zh ? '浏览器' : 'Browser'}
                    aria-pressed={props.browserOpen}
                    aria-keyshortcuts="Meta+Shift+B Control+Shift+B"
                    onClick={(event) => toggleTool(event.currentTarget, props.onToggleBrowser)}
                  >
                    <GlobeSimple aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{zh ? '浏览器' : 'Browser'}</strong>
                    </span>
                    <span className="session-quick-actions-shortcut">{platformShortcutLabel('⌘⇧B')}</span>
                  </button>

                  {props.onToggleTerminal ? (
                    <button
                      type="button"
                      className="session-quick-actions-row"
                      aria-label={zh ? '会话终端' : 'Conversation terminal'}
                      aria-pressed={props.terminalOpen}
                      aria-keyshortcuts="Control+`"
                      onClick={(event) => toggleTool(event.currentTarget, props.onToggleTerminal)}
                    >
                      <TerminalWindow aria-hidden="true" weight="regular" />
                      <span className="session-quick-actions-copy">
                        <strong>{zh ? '会话终端' : 'Conversation terminal'}</strong>
                      </span>
                      <span className="session-quick-actions-shortcut">Ctrl+`</span>
                    </button>
                  ) : null}

                  <button type="button" className="session-quick-actions-row" disabled={!canStartCodeReview} data-icon-tooltip={codeReviewUnavailableReason ?? undefined} onClick={openCodeReview}>
                    <FileCode aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{zh ? '代码审查' : 'Code review'}</strong>
                      <small>{codeReviewUnavailableReason ?? (zh ? '新建 AI 会话审查当前完整变化' : 'Review all current changes in a new AI conversation')}</small>
                    </span>
                    <ArrowSquareOut aria-hidden="true" weight="regular" />
                  </button>

                  <button
                    type="button"
                    className="session-quick-actions-row"
                    disabled={!canOpenDelivery}
                    data-icon-tooltip={!canOpenDelivery ? (zh ? '当前会话没有可用的项目 Git 入口' : 'Project Git is unavailable for this conversation') : undefined}
                    onClick={openDelivery}
                  >
                    <GithubLogo aria-hidden="true" weight="regular" />
                    <span className="session-quick-actions-copy">
                      <strong>{zh ? '代码交付' : 'Code delivery'}</strong>
                      <small>
                        {workspaceState === 'loading'
                          ? zh
                            ? '正在读取 Git 状态…'
                            : 'Loading Git status…'
                          : workspaceState === 'error'
                            ? zh
                              ? 'Git 状态读取失败'
                              : 'Failed to load Git status'
                            : dirty
                              ? zh
                                ? `${changes.files} 个文件待提交`
                                : `${changes.files} files to commit`
                              : workspace?.sourceBranch
                                ? `${workspace.branchName} → ${workspace.sourceBranch}`
                                : zh
                                  ? '查看、提交、合入与推送'
                                  : 'Review, commit, merge, and push'}
                      </small>
                    </span>
                    {/* 增删统计与代码交付共用一行，沿用原有颜色、占位和读屏说明。 */}
                    <span
                      className="session-quick-actions-diff"
                      aria-label={
                        workspaceState !== 'ready'
                          ? zh
                            ? '变更统计尚不可用'
                            : 'Change counts unavailable'
                          : zh
                            ? `新增 ${changes.additions} 行，删除 ${changes.deletions} 行`
                            : `${changes.additions} additions, ${changes.deletions} deletions`
                      }
                    >
                      <b>{workspaceState === 'ready' ? `+${changes.additions}` : '—'}</b>
                      <i>{workspaceState === 'ready' ? `−${changes.deletions}` : '—'}</i>
                    </span>
                  </button>
                </div>

                <section className="session-quick-actions-sources" aria-label={zh ? '来源' : 'Sources'}>
                  <header>
                    <strong>{zh ? '来源' : 'Sources'}</strong>
                    {props.onAddSources ? (
                      <button type="button" aria-label={zh ? '添加来源' : 'Add source'} data-icon-tooltip={zh ? '添加到当前输入' : 'Add to current input'} onClick={() => void props.onAddSources?.()}>
                        <Plus aria-hidden="true" weight="regular" />
                      </button>
                    ) : null}
                  </header>
                  {visibleSources.length > 0 ? (
                    <ol>
                      {visibleSources.map((source) => (
                        <li key={source.id}>
                          {source.resource && props.onOpenSource ? (
                            <button type="button" data-icon-tooltip={source.label} onClick={() => void props.onOpenSource?.(source.resource as ConversationResource)}>
                              <SessionQuickActionSourceVisual source={source} onLoadResourcePreview={props.onLoadResourcePreview} />
                              <span className="session-quick-actions-source-label">{source.label}</span>
                            </button>
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
                    <button type="button" className="session-quick-actions-view-all" aria-expanded={showAllSources} onClick={() => setShowAllSources((current) => !current)}>
                      <ShareNetwork aria-hidden="true" weight="regular" />
                      <span>{showAllSources ? (zh ? '收起' : 'Show less') : zh ? '查看全部' : 'View all'}</span>
                    </button>
                  ) : null}
                </section>

                {workspaceState === 'error' ? <p role="status">{zh ? '显示最近一次读取的目录与分支。' : 'Shows the most recently loaded folder and branch.'}</p> : null}
              </Collapsible>
            </section>
            <SessionComputerPreview key={props.conversation.id} conversationId={props.conversation.id} language={props.language} active={cardVisible} />
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
            repositoryName={conversationRepository?.name}
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

function SourceFallbackIcon(props: { source: SourceRow }) {
  if (props.source.resource) return <ResourceIcon resource={props.source.resource} />;
  if (props.source.attachment && isPendingImageAttachment(props.source.attachment)) return <FileImage weight="regular" />;
  if (props.source.attachment?.kind === 'directory') return <Folder weight="regular" />;
  if (props.source.attachment?.kind === 'pasted_text') return <FileCode weight="regular" />;
  if (props.source.attachment) {
    /** 普通附件沿原文件名选择共享图标，不改变图片和目录的预览路径。 */
    const Icon = fileIconForKind(fileIconKindForName(props.source.attachment.name));
    return <Icon weight="regular" />;
  }
  return <File weight="regular" />;
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

function resolveConversationWorkspace(workspaces: TaskWorkspacesSnapshot | null, conversation: NativeConversationChoice, state: NativeSessionState): TaskWorkspaceSnapshot | null {
  if (!workspaces) return null;
  const executionCwd = state.snapshot?.executionContext?.cwd;
  return (
    workspaces.items.find((workspace) => workspace.id === conversation.workspaceId) ??
    workspaces.items.find((workspace) => Boolean(executionCwd) && (workspace.review?.cwd === executionCwd || workspace.worktreePath === executionCwd)) ??
    workspaces.items.find((workspace) => workspace.state === 'ready') ??
    workspaces.items[0] ??
    null
  );
}

/** 审查以原目录是否保留为准，已交付工作区仍可读取。 */
function resolveCodeReviewUnavailableReason(input: {
  zh: boolean;
  taskId: string | null | undefined;
  conversation: NativeConversationChoice;
  workspace: TaskWorkspaceSnapshot | null;
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
  if (input.workspaceState === 'idle' || input.workspaceState === 'loading') return input.zh ? '正在检查代码审查的工作目录…' : 'Checking the working folder for the code review…';
  if (input.workspaceState === 'error') return input.zh ? '读取工作目录失败，请重新打开面板重试' : 'Failed to load the working folder. Reopen this panel to retry';
  if (!input.workspace || !['ready', 'merged'].includes(input.workspace.state) || !input.workspace.worktreePath) return input.zh ? '此任务的工作目录已回收或不可用' : 'This task’s working folder has been reclaimed or is unavailable';
  return null;
}

/** 汇总当前交付分支的全部仓库，跨仓同名文件分别计数。 */
function summarizeWorkspaceChanges(workspaces: TaskWorkspaceSnapshot[]): { files: number; additions: number; deletions: number } {
  return workspaces.reduce(
    (summary, workspace) => {
      if (!workspace.review) return summary;
      /** 同一仓库的已暂存、未暂存和新文件按路径去重。 */
      const files = new Set([...workspace.review.stagedFiles, ...workspace.review.unstagedFiles, ...workspace.review.untrackedFiles].map((file) => file.path)).size;
      /** 服务端已经按工作区边界生成差异统计。 */
      const diffs = [...workspace.review.stagedDiff.fileDiffs, ...workspace.review.unstagedDiff.fileDiffs];
      return diffs.reduce((counts, file) => ({ ...counts, additions: counts.additions + file.addedLines, deletions: counts.deletions + file.deletedLines }), { ...summary, files: summary.files + files });
    },
    { files: 0, additions: 0, deletions: 0 },
  );
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
