import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileImageIcon as FileImage } from '@phosphor-icons/react/dist/csr/FileImage';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { GithubLogoIcon as GithubLogo } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { ShareNetworkIcon as ShareNetwork } from '@phosphor-icons/react/dist/csr/ShareNetwork';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { conversationAttachmentIdentity } from './ConversationComposerAttachments.js';
import { isImageResource, isPendingImageAttachment, ResourceIcon } from './ConversationResources.js';
import { SessionCodeReviewDialog, type SessionCodeReviewSelection } from './SessionCodeReviewDialog.js';
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

interface SessionQuickActionsCardProps {
  language: SessionUiLanguage;
  conversation: NativeConversationChoice;
  state: NativeSessionState;
  task: { id: string; title: string } | null;
  persistentHost?: HTMLElement | null;
  forceCollapsed?: boolean;
  suppressed?: boolean;
  capabilities?: CodexConversationCapabilities | null;
  onLoadCapabilities?: (projectId: string) => Promise<CodexConversationCapabilities>;
  onLoadTaskWorkspaces?: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenGitReview?: (taskId: string, workspaceId: string | null, mode: 'commit' | 'push-only') => void;
  onOpenGitDelivery?: (taskId: string, workspaceId: string | null) => void;
  onOpenProjectCommands?: () => void;
  onStartCodeReview?: (selection: SessionCodeReviewSelection) => void | boolean | { state: 'preparing'; cancel: () => void } | Promise<void | boolean | { state: 'preparing'; cancel: () => void }>;
  onAddSources?: () => void | Promise<void>;
  onOpenSource?: (resource: ConversationResource) => void | Promise<void>;
  onLoadResourcePreview?: (resource: ConversationResource) => Promise<ConversationResourcePreview>;
}

interface SourceRow {
  id: string;
  label: string;
  attachment?: NativeConversationAttachment;
  resource?: ConversationResource;
}

const PERSISTENT_CARD_MIN_WORKSPACE_WIDTH = 1440;
const DEFAULT_VISIBLE_SOURCE_COUNT = 3;

export function SessionQuickActionsCard(props: SessionQuickActionsCardProps) {
  const zh = props.language === 'zh-CN';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const loadedWorkspaceKeyRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hasPersistentSpace, setHasPersistentSpace] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<TaskWorkspacesSnapshot | null>(null);
  const [workspaceState, setWorkspaceState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const taskId = props.task?.id ?? props.conversation.taskId;
  const workspace = resolveConversationWorkspace(workspaces, props.conversation, props.state);
  const executionContext = props.state.snapshot?.executionContext;
  const cwd = executionContext?.cwd ?? workspace?.review?.cwd ?? workspace?.worktreePath ?? null;
  const branch = executionContext?.cwd ? executionContext.branch : (workspace?.review?.branch ?? workspace?.branchName ?? null);
  const changes = summarizeWorkspaceChanges(workspace);
  const sources = useMemo(() => collectSources(props.state), [props.state.attachments, props.state.items]);
  const visibleSources = showAllSources ? sources : sources.slice(0, DEFAULT_VISIBLE_SOURCE_COUNT);
  const dirty = workspace?.review ? !workspace.review.clean : false;
  const canOpenReview = Boolean(taskId && workspace && props.onOpenGitReview);
  const canOpenDelivery = Boolean(taskId && props.onOpenGitDelivery);
  const persistent = hasPersistentSpace && !props.forceCollapsed;
  const cardVisible = !props.suppressed && (persistent || open);
  const cardMounted = cardVisible || Boolean(props.suppressed && persistent);

  useEffect(() => {
    const workspaceRoot = rootRef.current?.closest<HTMLElement>('.session-workspace-root');
    if (!workspaceRoot || typeof ResizeObserver === 'undefined') return;

    const updatePresentation = (): void => {
      const nextHasPersistentSpace = workspaceRoot.getBoundingClientRect().width >= PERSISTENT_CARD_MIN_WORKSPACE_WIDTH;
      setHasPersistentSpace((current) => (current === nextHasPersistentSpace ? current : nextHasPersistentSpace));
    };
    updatePresentation();
    const observer = new ResizeObserver(updatePresentation);
    observer.observe(workspaceRoot);
    return () => observer.disconnect();
  }, []);

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
    setWorkspaces(null);
    setWorkspaceState('idle');
    setWorkspaceError(null);
    loadedWorkspaceKeyRef.current = null;
  }, [props.conversation.id]);

  useEffect(() => {
    if (!cardVisible || !taskId || !props.onLoadTaskWorkspaces) return;
    const workspaceKey = `${props.conversation.id}:${taskId}`;
    if (loadedWorkspaceKeyRef.current === workspaceKey) return;
    loadedWorkspaceKeyRef.current = workspaceKey;
    let active = true;
    let settled = false;
    setWorkspaceState('loading');
    setWorkspaceError(null);
    void props
      .onLoadTaskWorkspaces(taskId)
      .then((snapshot) => {
        settled = true;
        if (!active) return;
        setWorkspaces(snapshot);
        setWorkspaceState('ready');
      })
      .catch((error: unknown) => {
        settled = true;
        if (!active) return;
        loadedWorkspaceKeyRef.current = null;
        setWorkspaceState('error');
        setWorkspaceError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
      if (!settled && loadedWorkspaceKeyRef.current === workspaceKey) loadedWorkspaceKeyRef.current = null;
    };
  }, [cardVisible, props.conversation.id, props.onLoadTaskWorkspaces, taskId]);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node)) return;
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
  }, [open]);

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

  function openReview(): void {
    if (!taskId || !workspace || !props.onOpenGitReview) return;
    setOpen(false);
    props.onOpenGitReview(taskId, workspace.id, 'commit');
  }

  function openDelivery(): void {
    if (!taskId || !props.onOpenGitDelivery) return;
    setOpen(false);
    props.onOpenGitDelivery(taskId, workspace?.id ?? props.conversation.workspaceId ?? null);
  }

  function openCommands(): void {
    setOpen(false);
    props.onOpenProjectCommands?.();
  }

  function openCodeReview(): void {
    setOpen(false);
    setReviewDialogOpen(true);
  }

  return (
    <div className="session-quick-actions-anchor" ref={rootRef} data-presentation={persistent ? 'persistent' : 'collapsed'}>
      {persistent || props.suppressed ? null : (
        <button
          ref={triggerRef}
          type="button"
          className={`session-quick-actions-trigger ${open ? 'selected' : ''}`}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={zh ? '环境与快捷操作' : 'Environment and quick actions'}
          onClick={() => setOpen((current) => !current)}
        >
          <GitDiff aria-hidden="true" weight="regular" />
          <span>{zh ? '环境' : 'Environment'}</span>
        </button>
      )}

      {cardMounted ? (
        <SessionQuickActionsCardMount persistent={persistent} host={props.persistentHost}>
          <section
            ref={cardRef}
            className="session-quick-actions-card"
            data-presentation={persistent ? 'persistent' : 'popover'}
            data-sources-expanded={showAllSources || undefined}
            role={persistent ? 'region' : 'dialog'}
            aria-label={zh ? '环境信息与快捷操作' : 'Environment information and quick actions'}
            hidden={props.suppressed || undefined}
          >
            <header>
              <strong>{zh ? '环境信息' : 'Environment'}</strong>
              {taskId && props.onOpenTaskDetail ? (
                <button
                  type="button"
                  className="session-quick-actions-settings"
                  aria-label={zh ? '打开任务详情' : 'Open task details'}
                  title={zh ? '打开任务详情' : 'Open task details'}
                  onClick={() => {
                    setOpen(false);
                    props.onOpenTaskDetail?.(taskId);
                  }}
                >
                  <GearSix aria-hidden="true" weight="regular" />
                </button>
              ) : null}
            </header>

            <div className="session-quick-actions-list">
              <button type="button" className="session-quick-actions-row" disabled={!canOpenReview} onClick={openReview}>
                <GitDiff aria-hidden="true" weight="regular" />
                <span className="session-quick-actions-copy">
                  <strong>{zh ? '变更' : 'Changes'}</strong>
                  {workspaceState === 'loading' ? <small>{zh ? '正在读取 Git 状态…' : 'Loading Git status…'}</small> : null}
                </span>
                <span className="session-quick-actions-diff" aria-label={zh ? `新增 ${changes.additions} 行，删除 ${changes.deletions} 行` : `${changes.additions} additions, ${changes.deletions} deletions`}>
                  <b>+{changes.additions}</b>
                  <i>−{changes.deletions}</i>
                </span>
              </button>

              <div className="session-quick-actions-row is-static" title={cwd ?? undefined}>
                <Folder aria-hidden="true" weight="regular" />
                <span className="session-quick-actions-copy">
                  <strong>{zh ? '本地' : 'Local'}</strong>
                  <small>{cwd ?? (zh ? '执行目录不可用' : 'Execution directory unavailable')}</small>
                </span>
              </div>

              <div className="session-quick-actions-row is-static" title={branch ?? undefined}>
                <GitBranch aria-hidden="true" weight="regular" />
                <span className="session-quick-actions-copy">
                  <strong>{branch ?? (cwd ? (zh ? '非 Git 目录' : 'Not a Git repository') : zh ? '分支不可用' : 'Branch unavailable')}</strong>
                  {workspace?.sourceBranch ? <small>{zh ? `来源 ${workspace.sourceBranch}` : `Source ${workspace.sourceBranch}`}</small> : null}
                </span>
              </div>

              <button type="button" className="session-quick-actions-row" onClick={openCommands}>
                <TerminalWindow aria-hidden="true" weight="regular" />
                <span className="session-quick-actions-copy">
                  <strong>{zh ? '命令' : 'Commands'}</strong>
                  <small>{zh ? '打开当前项目的完整命令中心' : 'Open the full command center for this project'}</small>
                </span>
                <ArrowSquareOut aria-hidden="true" weight="regular" />
              </button>

              <button type="button" className="session-quick-actions-row" onClick={openCodeReview}>
                <FileCode aria-hidden="true" weight="regular" />
                <span className="session-quick-actions-copy">
                  <strong>{zh ? '代码审查' : 'Code review'}</strong>
                  <small>{zh ? '新建 AI 会话审查当前完整变化' : 'Review all current changes in a new AI conversation'}</small>
                </span>
                <ArrowSquareOut aria-hidden="true" weight="regular" />
              </button>

              <button
                type="button"
                className="session-quick-actions-row"
                disabled={!canOpenDelivery}
                title={!taskId ? (zh ? '项目对话没有任务工作区' : 'Project conversations do not have a task workspace') : undefined}
                onClick={openDelivery}
              >
                <GithubLogo aria-hidden="true" weight="regular" />
                <span className="session-quick-actions-copy">
                  <strong>{zh ? '代码交付' : 'Code delivery'}</strong>
                  <small>
                    {dirty
                      ? zh
                        ? `${changes.files} 个文件待提交`
                        : `${changes.files} files to commit`
                      : workspace?.sourceBranch
                        ? `${workspace.branchName} → ${workspace.sourceBranch}`
                        : workspaceState === 'loading'
                          ? zh
                            ? '正在读取 Git 状态…'
                            : 'Loading Git status…'
                          : zh
                            ? '查看、提交、合入与推送'
                            : 'Review, commit, merge, and push'}
                  </small>
                </span>
                <ArrowSquareOut aria-hidden="true" weight="regular" />
              </button>
            </div>

            <section className="session-quick-actions-sources" aria-label={zh ? '来源' : 'Sources'}>
              <header>
                <strong>{zh ? '来源' : 'Sources'}</strong>
                {props.onAddSources ? (
                  <button type="button" aria-label={zh ? '添加来源' : 'Add source'} title={zh ? '添加到当前输入' : 'Add to current input'} onClick={() => void props.onAddSources?.()}>
                    <Plus aria-hidden="true" weight="regular" />
                  </button>
                ) : null}
              </header>
              {visibleSources.length > 0 ? (
                <ol>
                  {visibleSources.map((source) => (
                    <li key={source.id}>
                      {source.resource && props.onOpenSource ? (
                        <button type="button" title={source.label} onClick={() => void props.onOpenSource?.(source.resource as ConversationResource)}>
                          <SessionQuickActionSourceVisual source={source} onLoadResourcePreview={props.onLoadResourcePreview} />
                          <span className="session-quick-actions-source-label">{source.label}</span>
                        </button>
                      ) : (
                        <span title={source.label}>
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

            {workspaceState === 'error' ? (
              <p className="session-quick-actions-error" role="alert" title={workspaceError ?? undefined}>
                {zh ? 'Git 状态读取失败；目录与分支仍来自会话快照。' : 'Git status could not be loaded; directory and branch still come from the conversation snapshot.'}
              </p>
            ) : null}
          </section>
        </SessionQuickActionsCardMount>
      ) : null}
      <SessionCodeReviewDialog
        open={reviewDialogOpen}
        language={props.language}
        conversation={props.conversation}
        state={props.state}
        workspace={workspace}
        capabilities={props.capabilities ?? null}
        onLoadCapabilities={props.onLoadCapabilities}
        onClose={() => setReviewDialogOpen(false)}
        onStart={props.onStartCodeReview}
      />
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
  if (props.source.attachment && isPendingImageAttachment(props.source.attachment)) return <FileImage weight="duotone" />;
  if (props.source.attachment?.kind === 'directory') return <Folder weight="duotone" />;
  if (props.source.attachment?.kind === 'pasted_text') return <FileCode weight="duotone" />;
  return <File weight="duotone" />;
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

function summarizeWorkspaceChanges(workspace: TaskWorkspaceSnapshot | null): { files: number; additions: number; deletions: number } {
  if (!workspace?.review) return { files: 0, additions: 0, deletions: 0 };
  const files = new Set([...workspace.review.stagedFiles, ...workspace.review.unstagedFiles, ...workspace.review.untrackedFiles].map((file) => file.path)).size;
  const diffs = [...workspace.review.stagedDiff.fileDiffs, ...workspace.review.unstagedDiff.fileDiffs];
  return diffs.reduce((summary, file) => ({ ...summary, additions: summary.additions + file.addedLines, deletions: summary.deletions + file.deletedLines }), { files, additions: 0, deletions: 0 });
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
