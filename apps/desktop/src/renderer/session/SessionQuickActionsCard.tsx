import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FileIcon as File } from '@phosphor-icons/react/dist/csr/File';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GearSixIcon as GearSix } from '@phosphor-icons/react/dist/csr/GearSix';
import { GitBranchIcon as GitBranch } from '@phosphor-icons/react/dist/csr/GitBranch';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { GithubLogoIcon as GithubLogo } from '@phosphor-icons/react/dist/csr/GithubLogo';
import { PlusIcon as Plus } from '@phosphor-icons/react/dist/csr/Plus';
import { conversationAttachmentIdentity } from './ConversationComposerAttachments.js';
import type { ConversationResource, NativeConversationChoice, NativeSessionState, TaskWorkspaceSnapshot, TaskWorkspacesSnapshot } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

interface SessionQuickActionsCardProps {
  language: SessionUiLanguage;
  conversation: NativeConversationChoice;
  state: NativeSessionState;
  task: { id: string; title: string } | null;
  forceCollapsed?: boolean;
  onLoadTaskWorkspaces?: (taskId: string) => Promise<TaskWorkspacesSnapshot>;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenGitReview?: (taskId: string, workspaceId: string | null, mode: 'commit' | 'push-only') => void;
  onOpenGitDelivery?: (taskId: string) => void;
  onAddSources?: () => void | Promise<void>;
  onOpenSource?: (resource: ConversationResource) => void | Promise<void>;
}

interface SourceRow {
  id: string;
  label: string;
  resource?: ConversationResource;
}

const PERSISTENT_CARD_MIN_WORKSPACE_WIDTH = 1440;

export function SessionQuickActionsCard(props: SessionQuickActionsCardProps) {
  const zh = props.language === 'zh-CN';
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const loadedWorkspaceKeyRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [hasPersistentSpace, setHasPersistentSpace] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);
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
  const visibleSources = showAllSources ? sources : sources.slice(0, 2);
  const dirty = workspace?.review ? !workspace.review.clean : false;
  const canPush = Boolean(workspace?.review?.clean && workspace.review.ahead > 0 && workspace.remoteName);
  const canOpenReview = Boolean(taskId && workspace && props.onOpenGitReview);
  const canCommitOrPush = canOpenReview && (dirty || canPush);
  const persistent = hasPersistentSpace && !props.forceCollapsed;
  const cardVisible = persistent || (open && !props.forceCollapsed);

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
    setOpen(false);
    setShowAllSources(false);
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

  function openReview(mode: 'commit' | 'push-only'): void {
    if (!taskId || !workspace || !props.onOpenGitReview) return;
    setOpen(false);
    props.onOpenGitReview(taskId, workspace.id, mode);
  }

  return (
    <div className="session-quick-actions-anchor" ref={rootRef} data-presentation={persistent ? 'persistent' : 'collapsed'}>
      {persistent ? null : (
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

      {cardVisible ? (
        <section className="session-quick-actions-card" data-presentation={persistent ? 'persistent' : 'popover'} role={persistent ? 'region' : 'dialog'} aria-label={zh ? '环境信息与快捷操作' : 'Environment information and quick actions'}>
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
            <button type="button" className="session-quick-actions-row" disabled={!canOpenReview} onClick={() => openReview('commit')}>
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

            <button
              type="button"
              className="session-quick-actions-row"
              disabled={!canCommitOrPush}
              title={!taskId ? (zh ? '项目对话没有任务工作区' : 'Project conversations do not have a task workspace') : undefined}
              onClick={() => openReview(dirty ? 'commit' : 'push-only')}
            >
              <GitDiff aria-hidden="true" weight="regular" />
              <span className="session-quick-actions-copy">
                <strong>{zh ? '提交或推送' : 'Commit or push'}</strong>
                <small>
                  {dirty
                    ? zh
                      ? `${changes.files} 个文件待提交`
                      : `${changes.files} files to commit`
                    : canPush
                      ? zh
                        ? `${workspace?.review?.ahead ?? 0} 个提交待推送`
                        : `${workspace?.review?.ahead ?? 0} commits to push`
                      : zh
                        ? '当前没有待处理内容'
                        : 'Nothing to commit or push'}
                </small>
              </span>
            </button>

            <button
              type="button"
              className="session-quick-actions-row"
              disabled={!taskId || !workspace || !props.onOpenGitDelivery}
              onClick={() => {
                if (!taskId || !props.onOpenGitDelivery) return;
                setOpen(false);
                props.onOpenGitDelivery(taskId);
              }}
            >
              <GithubLogo aria-hidden="true" weight="regular" />
              <span className="session-quick-actions-copy">
                <strong>{zh ? '比较分支' : 'Compare branch'}</strong>
                {workspace?.sourceBranch ? (
                  <small>
                    {workspace.branchName} → {workspace.sourceBranch}
                  </small>
                ) : null}
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
                        <File aria-hidden="true" weight="regular" />
                        <span>{source.label}</span>
                      </button>
                    ) : (
                      <span title={source.label}>
                        <File aria-hidden="true" weight="regular" />
                        <span>{source.label}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            ) : (
              <p>{zh ? '当前会话还没有来源。' : 'No sources in this conversation yet.'}</p>
            )}
            {sources.length > 2 ? (
              <button type="button" className="session-quick-actions-view-all" aria-expanded={showAllSources} onClick={() => setShowAllSources((current) => !current)}>
                <CaretDown aria-hidden="true" weight="regular" />
                <span>{showAllSources ? (zh ? '收起' : 'Show less') : zh ? `查看全部（${sources.length}）` : `View all (${sources.length})`}</span>
              </button>
            ) : null}
          </section>

          {workspaceState === 'error' ? (
            <p className="session-quick-actions-error" role="alert" title={workspaceError ?? undefined}>
              {zh ? 'Git 状态读取失败；目录与分支仍来自会话快照。' : 'Git status could not be loaded; directory and branch still come from the conversation snapshot.'}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
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
    byId.set(id, { id, label: attachment.name });
  }
  for (const resource of Object.values(state.items).flatMap((item) => item.resources)) {
    byId.set(`resource:${resource.id}`, { id: `resource:${resource.id}`, label: resource.displayName, resource });
  }
  return [...byId.values()];
}
