import { FilePreview } from '../code/FilePreview.js';
import { FileTypeIcon } from '../code/FileTypeIcon.js';
import { groupDirectoryFiles } from '../code/groupDirectoryFiles.js';
import { AnimatedSize } from '../ui/AnimatedSize.js';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FilesIcon as Files } from '@phosphor-icons/react/dist/csr/Files';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import {
  type ConversationCodeComment,
  type ConversationCodeCommentPosition,
  type ConversationCodeCommentSide,
  type ConversationResourcePreview,
  type TurnChangeFile,
  type TurnChangeSet,
  type TurnChangeSetOperationResult,
} from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { CodeCommentPanel } from './CodeCommentPanel.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { TaskGitDiffTable } from '../task/TaskGitDiffTable.js';
import type { TaskGitFileDiff } from './sessionTypes.js';

type ChangeAction = 'undo' | 'reapply';

/** 文件摘要始终允许进入审阅；正文缺失时由既有读取入口补齐。 */
export function TurnChangeCard(props: {
  changeSet: TurnChangeSet;
  language: SessionUiLanguage;
  onReview?: (changeSet: TurnChangeSet, fileId?: string) => void;
  onOperate?: (changeSet: TurnChangeSet, action: ChangeAction) => Promise<TurnChangeSetOperationResult>;
}) {
  const zh = props.language === 'zh-CN';
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<ChangeAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const changeSet = optimisticChangeSet && optimisticChangeSet.id === props.changeSet.id && optimisticChangeSet.updatedAt >= props.changeSet.updatedAt ? optimisticChangeSet : props.changeSet;
  const visibleFiles = expanded ? changeSet.files : changeSet.files.slice(0, 3);
  const hiddenCount = Math.max(0, changeSet.files.length - visibleFiles.length);
  const action = availableAction(changeSet);
  /** 普通摘要使用稳定标题，正在操作或发生冲突时保留明确的阶段反馈。 */
  const title = ['applied', 'undone', 'unavailable'].includes(changeSet.state) ? (zh ? '文件更改' : 'File changes') : changeSetTitle(changeSet, props.language);
  /** 只标记已经执行的撤销结果。 */
  const availability = changeSet.state === 'undone' ? (zh ? '已撤销' : 'Undone') : null;

  async function operate(): Promise<void> {
    if (!action || !props.onOperate || busy) return;
    setBusy(action);
    setError(null);
    try {
      const result = await props.onOperate(changeSet, action);
      setOptimisticChangeSet(result.changeSet);
    } catch (operationError) {
      setError(operationError);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="session-turn-change-card" data-state={changeSet.state}>
      <header>
        <span className="session-turn-change-summary">
          <span className="session-turn-change-icon">
            <Files aria-hidden="true" weight="regular" />
          </span>
          <span>
            <span className="session-turn-change-heading">
              <span className="session-turn-change-title" data-icon-tooltip={changeSetTitle(changeSet, props.language)}>
                {title}
              </span>
              {availability ? <span className="session-turn-change-availability">{availability}</span> : null}
            </span>
            <small
              data-icon-tooltip={
                zh ? `${changeSet.fileCount} 个文件，新增 ${changeSet.addedLines} 行，删除 ${changeSet.deletedLines} 行` : `${changeSet.fileCount} files, ${changeSet.addedLines} added lines, ${changeSet.deletedLines} deleted lines`
              }
            >
              <span className="session-turn-change-total">{zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`}</span>
              <span className="session-turn-change-stats">
                <span className="session-change-added">+{changeSet.addedLines}</span> <span className="session-change-deleted">-{changeSet.deletedLines}</span>
              </span>
            </small>
          </span>
        </span>
        <nav aria-label={zh ? '文件变更操作' : 'File change actions'}>
          {hiddenCount > 0 || (expanded && changeSet.files.length > 3) ? (
            <button
              type="button"
              className="session-turn-change-more"
              aria-expanded={expanded}
              aria-label={expanded ? (zh ? '收起文件' : 'Show fewer files') : zh ? `再显示 ${hiddenCount} 个文件` : `Show ${hiddenCount} more files`}
              data-icon-tooltip={expanded ? (zh ? '收起文件' : 'Show fewer files') : zh ? `再显示 ${hiddenCount} 个文件` : `Show ${hiddenCount} more files`}
              onClick={() => setExpanded((value) => !value)}
            >
              <CaretDown aria-hidden="true" data-expanded={expanded || undefined} />
            </button>
          ) : null}
          {action ? (
            <button
              type="button"
              className="session-turn-change-undo"
              data-icon-tooltip={zh ? '仅操作此卡片列出的已记录变更' : 'Only affects recorded changes listed in this card'}
              disabled={Boolean(busy) || !props.onOperate}
              onClick={() => void operate()}
            >
              {action === 'undo' ? <ArrowCounterClockwise aria-hidden="true" /> : <ArrowClockwise aria-hidden="true" />}
              <span>{busy ? (zh ? '处理中…' : 'Working…') : action === 'undo' ? (zh ? '撤销' : 'Undo') : zh ? '重新应用' : 'Reapply'}</span>
            </button>
          ) : null}
          <button type="button" className="session-turn-change-review" disabled={!props.onReview || changeSet.files.length === 0} onClick={() => props.onReview?.(changeSet)}>
            {zh ? '审核' : 'Review'}
          </button>
        </nav>
      </header>
      {/* 不可恢复只影响操作能力；真正的操作冲突才显示错误。 */}
      {changeSet.conflict && changeSet.state !== 'unavailable' ? (
        <p className="session-turn-change-error" role="alert">
          <VisibleApplicationError error={changeSet.conflict} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {error && error !== changeSet.conflict?.message && error !== changeSet.unavailableReason ? (
        <p className="session-turn-change-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {visibleFiles.length ? (
        <AnimatedSize changeKey={expanded}>
          <ul className="session-turn-change-files">
            {visibleFiles.map((file) => (
              <li key={file.id}>
                <button type="button" aria-label={`${displayPath(file)} · ${localizedChangeType(file, props.language)}`} onClick={() => props.onReview?.(changeSet, file.id)} disabled={!props.onReview}>
                  <FileTypeIcon name={file.newPath ?? file.oldPath ?? ''} />
                  <span className="session-turn-change-path" data-icon-tooltip={`${displayPath(file)} · ${localizedChangeType(file, props.language)}`} data-file-status={file.changeType === 'binary' ? 'modified' : file.changeType}>
                    {displayPath(file)}
                  </span>
                  <span className="session-turn-change-file-counts">
                    {file.addedLines ? <span className="session-change-added">+{file.addedLines}</span> : null}
                    {file.deletedLines ? <span className="session-change-deleted">-{file.deletedLines}</span> : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </AnimatedSize>
      ) : null}
    </section>
  );
}

/** 审阅只依赖差异正文，恢复快照不可用时仍显示变更和评论入口。 */
export function TurnDiffWorkspace(props: {
  changeSet: TurnChangeSet;
  initialFileId?: string;
  language: SessionUiLanguage;
  fullWidth: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  /** 正文读取进度与可重试错误沿用会话分页状态。 */
  loading?: boolean;
  /** 正文加载失败原因，不与撤销不可用混为一谈。 */
  loadError?: string | null;
  /** 复用会话按需加载入口重新读取差异。 */
  onLoad?: () => void;
  onOperate?: (changeSet: TurnChangeSet, action: ChangeAction) => Promise<TurnChangeSetOperationResult>;
  onOpenFile?: (file: TurnChangeFile, line?: number) => void | Promise<void>;
  /** 读取当前工作区文件全文，保留现有路径授权与文件大小限制。 */
  onLoadPreview?: (changeSet: TurnChangeSet, file: TurnChangeFile) => Promise<ConversationResourcePreview>;
  comments?: ConversationCodeComment[];
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}) {
  /** 事件只读取最新回调，父会话输入不让可见代码行重新渲染。 */
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  /** 权限变化仍会更新行号操作入口。 */
  const canComment = Boolean(props.onCommentsChange);
  const canOpen = Boolean(props.onOpenFile);
  const zh = props.language === 'zh-CN';
  const [activeFileId, setActiveFileId] = useState(props.initialFileId ?? props.changeSet.files[0]?.id ?? null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const [busy, setBusy] = useState<ChangeAction | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const [draftPosition, setDraftPosition] = useState<ConversationCodeCommentPosition | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState<{ line: number; side: ConversationCodeCommentSide } | null>(null);
  const changeSet = optimisticChangeSet && optimisticChangeSet.id === props.changeSet.id && optimisticChangeSet.updatedAt >= props.changeSet.updatedAt ? optimisticChangeSet : props.changeSet;
  const action = availableAction(changeSet);
  const activeFile = changeSet.files.find((file) => file.id === activeFileId) ?? changeSet.files[0] ?? null;
  /** 将本轮补丁转换为交付页共用的双栏数据，避免重复维护布局与高亮。 */
  const diff = useMemo(() => turnFileDiff(activeFile), [activeFile]);
  const activePath = activeFile ? commentPath(activeFile) : null;
  /** 目录展示只投影本轮文件，选择与预览继续使用原文件身份。 */
  const directoryFiles = useMemo(() => changeSet.files.map((file) => ({ path: commentPath(file), file })), [changeSet.files]);
  /** 目录宽度沿用源码页默认值，并随所在面板限制上限。 */
  const [treeWidth, setTreeWidth] = useState(260);
  /** 面板尺寸由实际布局测量，窄面板仍为差异正文留出空间。 */
  const [layoutWidth, setLayoutWidth] = useState(0);
  /** 拖拽和布局测量只操作本审阅面板。 */
  const layoutRef = useRef<HTMLDivElement>(null);
  /** 外部跳转文件时展开其所在目录。 */
  const filesRef = useRef<HTMLElement>(null);
  /** 指针捕获期间保留起始位置，不添加全局拖拽监听。 */
  const treeResize = useRef<{ x: number; width: number } | null>(null);
  /** 目录最宽与源码页一致，正文至少保留 160px。 */
  const maximumTreeWidth = Math.max(150, Math.min(420, layoutWidth - 168));
  /** 窗口或分栏变窄时只限制显示宽度，保留用户原来的选择。 */
  const visibleTreeWidth = Math.min(treeWidth, maximumTreeWidth);
  const comments = useMemo(() => (props.comments ?? []).filter((comment) => comment.position.path === activePath), [props.comments, activePath]);
  /** 只为实际评论和当前草稿登记位置，不遍历代码行。 */
  const annotationLines = useMemo(() => [...comments.map((comment) => comment.position), ...(draftPosition ? [draftPosition] : [])], [comments, draftPosition]);

  useLayoutEffect(() => {
    /** 观察实际面板，覆盖窗口缩放与全宽切换。 */
    const layout = layoutRef.current;
    if (!layout) return;
    /** 按布局宽度限制目录，不把入场动画的缩放算作真实面板尺寸。 */
    const updateWidth = (): void => setLayoutWidth(layout.clientWidth);
    updateWidth();
    /** 生命周期结束后移除布局观察。 */
    const observer = new ResizeObserver(updateWidth);
    observer.observe(layout);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    /** 保留手动折叠，仅在当前文件改变时展开它的祖先目录。 */
    let directory = filesRef.current?.querySelector('[aria-current="true"]')?.closest('details');
    while (directory) {
      directory.open = true;
      directory = directory.parentElement?.closest('details') ?? null;
    }
  }, [activeFile?.id, activePath]);

  /** 使用源码页同样的指针捕获和拖拽手感。 */
  function startTreeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.dragging = 'true';
    treeResize.current = { x: event.clientX, width: visibleTreeWidth };
  }

  /** 松开、取消和失去捕获都结束当前拖拽。 */
  function finishTreeResize(event: ReactPointerEvent<HTMLDivElement>): void {
    treeResize.current = null;
    delete event.currentTarget.dataset.dragging;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }

  /** 指针、键盘和复位共用同一布局边界。 */
  function resizeTree(width: number): void {
    setTreeWidth(Math.max(150, Math.min(maximumTreeWidth, Math.round(width))));
  }

  useEffect(() => {
    titleRef.current?.focus();
  }, [props.changeSet.id]);

  useEffect(() => {
    // 外部打开意图只在目标改变时生效，不能覆盖用户随后在目录中的选择。
    setActiveFileId(props.initialFileId ?? callbacksRef.current.changeSet.files[0]?.id ?? null);
  }, [props.changeSet.id, props.initialFileId]);

  useEffect(() => {
    // 正文刷新保留仍存在的当前文件；文件被移除时才回退到第一项。
    setActiveFileId((current) => (changeSet.files.some((file) => file.id === current) ? current : (changeSet.files[0]?.id ?? null)));
  }, [changeSet.files]);

  useEffect(() => {
    setDraftPosition(null);
    setEditingCommentId(null);
    setRangeStart(null);
  }, [activeFile?.id]);

  /** 评论保存使用最新草稿集合，避免稳定回调保留过期数据。 */
  const saveComment = useCallback(
    (position: ConversationCodeCommentPosition, body: string, existingId?: string): void => {
      if (!callbacksRef.current.onCommentsChange) return;
      const diffHunk = activeFile ? nearbyDiffHunk(activeFile.unifiedDiff, position) : undefined;
      const next = existingId
        ? (callbacksRef.current.comments ?? []).map((comment) => (comment.id === existingId ? { ...comment, body } : comment))
        : [...(callbacksRef.current.comments ?? []), { id: crypto.randomUUID(), body, position, ...(diffHunk ? { diffHunk } : {}) }];
      callbacksRef.current.onCommentsChange(next);
      setDraftPosition(null);
      setEditingCommentId(null);
    },
    [activeFile],
  );

  async function operate(): Promise<void> {
    if (!action || !props.onOperate || busy) return;
    setBusy(action);
    setError(null);
    try {
      const result = await props.onOperate(changeSet, action);
      setOptimisticChangeSet(result.changeSet);
    } catch (operationError) {
      setError(operationError);
    } finally {
      setBusy(null);
    }
  }

  /** 打开源码只在点击时读取最新入口。 */
  const openFile = useCallback(async (file: TurnChangeFile, line?: number): Promise<void> => {
    if (!callbacksRef.current.onOpenFile) return;
    setError(null);
    try {
      await callbacksRef.current.onOpenFile(file, line);
    } catch (openError) {
      setError(openError);
    }
  }, []);

  /** 评论始终使用所在侧的行号；只有当前工作区存在的一侧允许打开源码。 */
  const renderLineNumber = useCallback(
    (line: number, side: ConversationCodeCommentSide): ReactNode => {
      /** 撤销后工作区恢复旧文件，其余稳定状态按新文件定位。 */
      const currentSide = changeSet.state === 'undone' || changeSet.state === 'reapplying' ? 'left' : 'right';
      return (
        <>
          {activePath && canComment ? (
            <button
              type="button"
              className="session-code-comment-add"
              aria-label={zh ? `评论${side === 'left' ? '旧' : '新'}文件第 ${line} 行` : `Comment on ${side === 'left' ? 'old' : 'new'} line ${line}`}
              onClick={(event) => {
                /** 跨侧点击不延续选择，避免混用旧文件与新文件行号。 */
                const useRange = event.shiftKey && rangeStart?.side === side;
                /** 反向选择仍按递增顺序保存起点。 */
                const startLine = useRange ? Math.min(rangeStart.line, line) : line;
                /** 评论挂在选择范围的末行。 */
                const endLine = useRange ? Math.max(rangeStart.line, line) : line;
                setRangeStart({ line, side });
                setEditingCommentId(null);
                setDraftPosition({ path: activePath, line: endLine, side, ...(startLine !== endLine ? { startLine, startSide: side } : {}) });
              }}
            />
          ) : null}
          {side === currentSide && activeFile && canOpen ? (
            <button
              data-icon-tooltip={zh ? `在源码中打开第 ${line} 行` : `Open source at line ${line}`}
              type="button"
              className="session-diff-line-number"
              aria-label={zh ? `在源码中打开第 ${line} 行` : `Open source at line ${line}`}
              onClick={() => void openFile(activeFile, line)}
            >
              {line}
            </button>
          ) : (
            <span className="session-diff-line-number">{line}</span>
          )}
        </>
      );
    },
    [changeSet.state, activePath, canComment, canOpen, rangeStart, activeFile, zh, openFile],
  );

  /** 将已保存评论和编辑草稿放在各自的旧／新文件行下，保留原有评论操作。 */
  const renderLineComments = useCallback(
    (line: number, side: ConversationCodeCommentSide): ReactNode => {
      /** 同号的左右两行不能共享评论。 */
      const lineComments = comments.filter((comment) => comment.position.line === line && comment.position.side === side);
      /** 草稿只属于当前路径下的一个行位置。 */
      const draftHere = draftPosition?.line === line && draftPosition.side === side && draftPosition.path === activePath;
      if (!lineComments.length && !draftHere) return null;
      return (
        <>
          {lineComments.map((comment) =>
            editingCommentId === comment.id ? (
              <CodeCommentPanel
                key={comment.id}
                language={props.language}
                position={comment.position}
                comment={comment}
                onCancel={() => setEditingCommentId(null)}
                onSave={(body) => saveComment(comment.position, body, comment.id)}
                onDelete={() => {
                  callbacksRef.current.onCommentsChange?.((callbacksRef.current.comments ?? []).filter((candidate) => candidate.id !== comment.id));
                  setEditingCommentId(null);
                }}
              />
            ) : (
              <span key={comment.id} className="session-saved-code-comment">
                <strong>{zh ? '本地评论' : 'Local comment'}</strong>
                <span>{comment.body}</span>
                <span className="session-saved-code-comment-actions">
                  <button type="button" onClick={() => setEditingCommentId(comment.id)}>
                    {zh ? '编辑' : 'Edit'}
                  </button>
                  <button type="button" onClick={() => callbacksRef.current.onCommentsChange?.((callbacksRef.current.comments ?? []).filter((candidate) => candidate.id !== comment.id))}>
                    {zh ? '删除' : 'Delete'}
                  </button>
                </span>
              </span>
            ),
          )}
          {draftHere && draftPosition ? <CodeCommentPanel language={props.language} position={draftPosition} onCancel={() => setDraftPosition(null)} onSave={(body) => saveComment(draftPosition, body)} /> : null}
        </>
      );
    },
    [comments, draftPosition, activePath, editingCommentId, props.language, zh, saveComment],
  );

  return (
    <section className="session-context-workspace session-turn-diff-workspace" aria-label={zh ? '变更审核' : 'Change review'}>
      <header className="session-context-workspace-header">
        <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
          <GitDiff aria-hidden="true" weight="regular" />
          <span>
            <strong>{zh ? '审核变更' : 'Review changes'}</strong>
            <small>{zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`}</small>
          </span>
        </span>
        <nav aria-label={zh ? '变更审核操作' : 'Change review actions'}>
          {action ? (
            <button type="button" className="session-context-text-action" disabled={Boolean(busy) || !props.onOperate} onClick={() => void operate()}>
              {action === 'undo' ? <ArrowCounterClockwise aria-hidden="true" /> : <ArrowClockwise aria-hidden="true" />}
              <span>{busy ? (zh ? '处理中…' : 'Working…') : action === 'undo' ? (zh ? '撤销' : 'Undo') : zh ? '重新应用' : 'Reapply'}</span>
            </button>
          ) : null}
          <button
            type="button"
            aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            data-icon-tooltip={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            onClick={() => props.onFullWidthChange(!props.fullWidth)}
          >
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </button>
          <button type="button" aria-label={zh ? '关闭变更审核' : 'Close change review'} data-icon-tooltip={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </nav>
      </header>
      {/* 审核不展示撤销资格提示，实际操作冲突继续显示错误。 */}
      {changeSet.conflict && changeSet.state !== 'unavailable' ? (
        <p className="session-turn-change-error session-turn-diff-error" role="alert">
          <VisibleApplicationError error={changeSet.conflict} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {error && error !== changeSet.conflict?.message && error !== changeSet.unavailableReason ? (
        <p className="session-turn-change-error session-turn-diff-error" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      <div className="session-turn-diff-layout" ref={layoutRef} style={{ gridTemplateColumns: `${visibleTreeWidth}px 8px minmax(0, 1fr)` }}>
        <nav className="session-turn-diff-files" ref={filesRef} aria-label={zh ? '变更文件' : 'Changed files'}>
          <div className="session-turn-diff-totals">
            <span className="session-change-added">+{changeSet.addedLines}</span>
            <span className="session-change-deleted">-{changeSet.deletedLines}</span>
          </div>
          <TurnDiffDirectory files={directoryFiles} prefix="" depth={0} activeFileId={activeFile?.id} language={props.language} onSelect={setActiveFileId} />
        </nav>
        <div
          className="session-turn-diff-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label={zh ? '调整变更目录宽度' : 'Resize changed files'}
          aria-valuemin={150}
          aria-valuemax={maximumTreeWidth}
          aria-valuenow={visibleTreeWidth}
          tabIndex={0}
          onDoubleClick={() => resizeTree(260)}
          onPointerDown={startTreeResize}
          onPointerMove={(event) => {
            if (treeResize.current && event.currentTarget.hasPointerCapture(event.pointerId)) resizeTree(treeResize.current.width + event.clientX - treeResize.current.x);
          }}
          onPointerUp={finishTreeResize}
          onPointerCancel={finishTreeResize}
          onLostPointerCapture={finishTreeResize}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
            event.preventDefault();
            resizeTree(event.key === 'Home' ? 260 : visibleTreeWidth + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 24 : 8));
          }}
        />
        <section className="session-turn-diff-content" aria-label={activeFile ? displayPath(activeFile) : undefined}>
          {activeFile ? (
            <>
              <header>
                <strong data-icon-tooltip={`${displayPath(activeFile)} · ${localizedChangeType(activeFile, props.language)}`} data-file-status={activeFile.changeType === 'binary' ? 'modified' : activeFile.changeType}>
                  {displayPath(activeFile)}
                </strong>
                <span>
                  {props.onOpenFile ? (
                    <button type="button" className="session-turn-diff-open-file" onClick={() => void openFile(activeFile)}>
                      <FileCode aria-hidden="true" />
                      <span>{zh ? '打开当前文件' : 'Open current file'}</span>
                    </button>
                  ) : null}
                </span>
              </header>
              {busy || ['capturing', 'undoing', 'reapplying'].includes(changeSet.state) ? (
                <p role="status">{zh ? '正在更新文件，完成后显示预览…' : 'Updating file…'}</p>
              ) : (
                <FilePreview
                  request={{ kind: 'turn', projectId: changeSet.projectId, conversationId: changeSet.conversationId, turnId: changeSet.turnId, changeSetId: changeSet.id, fileId: activeFile.id }}
                  revision={changeSet.updatedAt}
                  fileStatus={activeFile.changeType === 'binary' ? 'modified' : activeFile.changeType}
                  zh={zh}
                >
                  {changeSet.contentProjection === 'summary' ? (
                    <p className="session-turn-diff-empty" role="status">
                      {props.loading
                        ? zh
                          ? '正在加载差异正文…'
                          : 'Loading diff…'
                        : props.loadError
                          ? zh
                            ? '差异正文加载失败，请重试。'
                            : 'Could not load the diff. Please retry.'
                          : zh
                            ? '差异正文尚未加载。'
                            : 'The diff has not been loaded yet.'}
                      {props.onLoad ? (
                        <button type="button" disabled={props.loading} onClick={props.onLoad}>
                          {zh ? '加载差异' : 'Load diff'}
                        </button>
                      ) : null}
                    </p>
                  ) : !activeFile.unifiedDiff ? (
                    <p className="session-turn-diff-empty" role="status">
                      {zh ? '此文件没有可显示的文本差异。' : 'This file has no displayable text diff.'}
                    </p>
                  ) : (
                    <div className="session-turn-diff-table">
                      <div className="session-turn-diff-side-labels" data-single-side={activeFile.changeType === 'added' || activeFile.changeType === 'deleted' ? 'true' : undefined}>
                        {activeFile.changeType !== 'added' ? <span data-icon-tooltip={activeFile.oldPath ?? ''}>{zh ? '修改前' : 'Before'}</span> : null}
                        {activeFile.changeType !== 'deleted' ? <span data-icon-tooltip={activeFile.newPath ?? ''}>{zh ? '修改后' : 'After'}</span> : null}
                      </div>
                      <TaskGitDiffTable
                        diff={diff}
                        hasSelection
                        zh={zh}
                        annotationLines={annotationLines}
                        focusAnnotation={draftPosition ?? comments.find((comment) => comment.id === editingCommentId)?.position}
                        renderLineNumber={renderLineNumber}
                        renderLineComments={renderLineComments}
                      />
                    </div>
                  )}
                </FilePreview>
              )}
            </>
          ) : (
            <p className="session-turn-diff-empty">{zh ? '这一轮没有可显示的文本差异。' : 'This turn has no displayable text diff.'}</p>
          )}
        </section>
      </div>
    </section>
  );
}

/** 目录折叠只影响展示，叶子选择始终回传原始文件身份。 */
function TurnDiffDirectory(props: { files: Array<{ path: string; file: TurnChangeFile }>; prefix: string; depth: number; activeFileId?: string; language: SessionUiLanguage; onSelect: (fileId: string) => void }) {
  /** 与既有 Git 文件列表共用分组和连续单目录合并规则。 */
  const entries = useMemo(() => groupDirectoryFiles(props.files, props.prefix), [props.files, props.prefix]);
  return (
    <ol className="session-turn-diff-tree">
      {entries.map(([name, files]) => (
        <li key={props.prefix + name}>
          {name.endsWith('/') ? (
            <details className="session-turn-diff-directory" open>
              <summary data-icon-tooltip={props.prefix + name} style={{ paddingInlineStart: 7 + props.depth * 14 }}>
                <CaretDown aria-hidden="true" />
                <Folder aria-hidden="true" weight="regular" />
                <span>{name.slice(0, -1)}</span>
                <small>{files.length}</small>
              </summary>
              <TurnDiffDirectory {...props} files={files} prefix={props.prefix + name} depth={props.depth + 1} />
            </details>
          ) : (
            files.map(({ file }) => (
              <button
                type="button"
                className="session-turn-diff-file"
                key={file.id}
                data-icon-tooltip={`${displayPath(file)} · ${localizedChangeType(file, props.language)}`}
                aria-label={`${displayPath(file)} · ${localizedChangeType(file, props.language)}`}
                aria-current={file.id === props.activeFileId ? 'true' : undefined}
                onClick={() => props.onSelect(file.id)}
                style={{ paddingInlineStart: 7 + props.depth * 14 }}
              >
                <span className="session-turn-diff-file-name">
                  <FileTypeIcon name={name} />
                  <span data-file-status={file.changeType === 'binary' ? 'modified' : file.changeType}>{name}</span>
                </span>
                {file.addedLines || file.deletedLines ? (
                  <small>
                    {file.addedLines ? <span className="session-change-added">+{file.addedLines}</span> : null}
                    {file.deletedLines ? <span className="session-change-deleted">-{file.deletedLines}</span> : null}
                  </small>
                ) : null}
              </button>
            ))
          )}
        </li>
      ))}
    </ol>
  );
}

/** 目录分组和评论统一按新路径定位，删除文件回退到旧路径。 */
function commentPath(file: TurnChangeFile): string {
  return file.newPath ?? file.oldPath ?? 'unknown';
}

function nearbyDiffHunk(diff: string, position: ConversationCodeCommentPosition): string | undefined {
  const lines = diff.split('\n');
  let oldLine: number | null = null;
  let newLine: number | null = null;
  let activeHunk = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    if (raw.startsWith('@@')) {
      const match = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/u.exec(raw);
      oldLine = match ? Number(match[1]) : null;
      newLine = match ? Number(match[2]) : null;
      activeHunk = index;
      continue;
    }
    const current = position.side === 'left' ? oldLine : newLine;
    if (current === position.line && activeHunk >= 0) {
      const nextHunk = lines.findIndex((candidate, candidateIndex) => candidateIndex > activeHunk && candidate.startsWith('@@'));
      return lines
        .slice(activeHunk, nextHunk < 0 ? lines.length : nextHunk)
        .join('\n')
        .slice(0, 8_000);
    }
    if (!raw.startsWith('+') && oldLine !== null) oldLine += 1;
    if (!raw.startsWith('-') && newLine !== null) newLine += 1;
  }
  return undefined;
}

function availableAction(changeSet: TurnChangeSet): ChangeAction | null {
  if (changeSet.state === 'applied') return 'undo';
  if (changeSet.state === 'undone') return 'reapply';
  return null;
}

function changeSetTitle(changeSet: TurnChangeSet, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  const subject = changeSet.fileCount === 1 ? displayPath(changeSet.files[0]!) : zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`;
  if (changeSet.state === 'capturing') return zh ? '正在记录文件变更' : 'Recording file changes';
  if (changeSet.state === 'undoing') return zh ? '正在撤销文件变更' : 'Undoing file changes';
  if (changeSet.state === 'reapplying') return zh ? '正在重新应用文件变更' : 'Reapplying file changes';
  if (changeSet.state === 'undone') return zh ? `已撤销 ${subject}` : `Undid ${subject}`;
  if (changeSet.state === 'conflicted') return zh ? `无法安全更新 ${subject}` : `Could not safely update ${subject}`;
  if (changeSet.state === 'unavailable') return zh ? '文件更改' : 'File changes';
  return zh ? `已记录 ${subject}的变更` : `Recorded changes to ${subject}`;
}

function displayPath(file: TurnChangeFile): string {
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
  return file.newPath ?? file.oldPath ?? 'unknown';
}

/** 轮次快照的状态只放入悬停和读屏说明，不与当前工作区状态混用。 */
function localizedChangeType(file: TurnChangeFile, language: SessionUiLanguage): string {
  /** 二进制沿用轮次快照自己的说明。 */
  const labels = language === 'zh-CN' ? { added: '新增', deleted: '删除', modified: '修改', renamed: '重命名', binary: '二进制' } : { added: 'Added', deleted: 'Deleted', modified: 'Modified', renamed: 'Renamed', binary: 'Binary' };
  return labels[file.changeType];
}

/** 解析完整补丁的原始行号；可视区域渲染保留全部差异的访问能力。 */
function turnFileDiff(file: TurnChangeFile | null): TaskGitFileDiff | null {
  if (!file) return null;
  /** 末尾换行不是额外的代码行；只规范化传输中的换行符。 */
  const rawLines = file.unifiedDiff.replace(/\r\n?/gu, '\n').split('\n');
  if (rawLines.at(-1) === '') rawLines.pop();
  /** 路径与变更统计使用会话已记录的文件信息。 */
  const fileDiff: TaskGitFileDiff = {
    oldPath: file.oldPath ?? '',
    newPath: file.newPath ?? '',
    changeType: file.changeType === 'binary' ? 'modified' : file.changeType,
    addedLines: file.addedLines,
    deletedLines: file.deletedLines,
    hunks: [],
  };
  /** 当前补丁片段之外的路径与索引元信息不计入代码行。 */
  let hunk: TaskGitFileDiff['hunks'][number] | null = null;
  /** 左侧行号只随上下文和删除行前进。 */
  let oldLine = 0;
  /** 右侧行号只随上下文和新增行前进。 */
  let newLine = 0;
  for (const raw of rawLines) {
    if (raw.startsWith('diff ') || raw.startsWith('index ')) {
      hunk = null;
      continue;
    }
    if (raw.startsWith('@@')) {
      /** 省略行数等价于一行，显式零行必须保留。 */
      const match = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/u.exec(raw);
      hunk = null;
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = { header: raw, oldStart: oldLine, oldLines: Number(match[2] ?? 1), newStart: newLine, newLines: Number(match[4] ?? 1), lines: [] };
      fileDiff.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('+')) {
      hunk.lines.push({ type: 'addition', content: raw.slice(1), oldLineNumber: null, newLineNumber: newLine++ });
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ type: 'deletion', content: raw.slice(1), oldLineNumber: oldLine++, newLineNumber: null });
    } else if (raw.startsWith(' ')) {
      hunk.lines.push({ type: 'context', content: raw.slice(1), oldLineNumber: oldLine++, newLineNumber: newLine++ });
    } else if (raw.startsWith('\\ No newline at end of file')) {
      hunk.lines.push({ type: 'metadata', content: raw, oldLineNumber: null, newLineNumber: null });
    }
  }
  return fileDiff;
}
