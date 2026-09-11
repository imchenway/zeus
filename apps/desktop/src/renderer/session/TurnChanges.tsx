import { AnimatedSize } from '../ui/AnimatedSize.js';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowClockwiseIcon as ArrowClockwise } from '@phosphor-icons/react/dist/csr/ArrowClockwise';
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from '@phosphor-icons/react/dist/csr/ArrowCounterClockwise';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { CaretDownIcon as CaretDown } from '@phosphor-icons/react/dist/csr/CaretDown';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FilesIcon as Files } from '@phosphor-icons/react/dist/csr/Files';
import { GitDiffIcon as GitDiff } from '@phosphor-icons/react/dist/csr/GitDiff';
import { InfoIcon as Info } from '@phosphor-icons/react/dist/csr/Info';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import {
  historicalTurnChangeUnavailableReason,
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
import { ConversationMarkdown } from './ConversationMarkdown.js';
import { useApplicationErrorDialog, VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
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
  useApplicationErrorDialog(error && error !== props.changeSet.conflict?.message && error !== props.changeSet.unavailableReason ? error : null, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const changeSet = optimisticChangeSet && optimisticChangeSet.id === props.changeSet.id && optimisticChangeSet.updatedAt >= props.changeSet.updatedAt ? optimisticChangeSet : props.changeSet;
  const visibleFiles = expanded ? changeSet.files : changeSet.files.slice(0, 3);
  const hiddenCount = Math.max(0, changeSet.files.length - visibleFiles.length);
  const action = availableAction(changeSet);

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
            <span className="session-turn-change-title">{changeSetTitle(changeSet, props.language)}</span>
            <small>
              <span className="session-turn-change-stats">
                <span className="session-change-added">+{changeSet.addedLines}</span> <span className="session-change-deleted">-{changeSet.deletedLines}</span>
              </span>
              <span className="session-turn-change-view">{zh ? '查看更改' : 'View changes'}</span>
            </small>
          </span>
        </span>
        <nav aria-label={zh ? '文件变更操作' : 'File change actions'}>
          {action ? (
            <button
              type="button"
              className="session-turn-change-undo"
              title={zh ? '仅操作此卡片列出的已记录变更' : 'Only affects recorded changes listed in this card'}
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
      {changeSet.conflict ? (
        <p className="session-turn-change-error" role="alert">
          <VisibleApplicationError error={changeSet.conflict} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {visibleFiles.length ? (
        <AnimatedSize changeKey={expanded}>
          <ul className="session-turn-change-files">
            {visibleFiles.map((file) => (
              <li key={file.id}>
                <button type="button" onClick={() => props.onReview?.(changeSet, file.id)} disabled={!props.onReview}>
                  <span className="session-turn-change-path" title={displayPath(file)}>
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
      {hiddenCount > 0 || (expanded && changeSet.files.length > 3) ? (
        <button type="button" className="session-turn-change-more" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          <span>{expanded ? (zh ? '收起文件' : 'Show fewer files') : zh ? `再显示 ${hiddenCount} 个文件` : `Show ${hiddenCount} more files`}</span>
          <CaretDown aria-hidden="true" data-expanded={expanded || undefined} />
        </button>
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
  useApplicationErrorDialog(error && error !== props.changeSet.conflict?.message && error !== props.changeSet.unavailableReason ? error : null, {
    language: zh ? 'zh-CN' : 'en',
  });
  const [optimisticChangeSet, setOptimisticChangeSet] = useState<TurnChangeSet | null>(null);
  const [draftPosition, setDraftPosition] = useState<ConversationCodeCommentPosition | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [rangeStart, setRangeStart] = useState<{ line: number; side: ConversationCodeCommentSide } | null>(null);
  const changeSet = optimisticChangeSet && optimisticChangeSet.id === props.changeSet.id && optimisticChangeSet.updatedAt >= props.changeSet.updatedAt ? optimisticChangeSet : props.changeSet;
  const action = availableAction(changeSet);
  const activeFile = changeSet.files.find((file) => file.id === activeFileId) ?? changeSet.files[0] ?? null;
  /** 审核默认显示差异；只有 Markdown 文件才提供当前全文预览。 */
  const [viewMode, setViewMode] = useState<'diff' | 'preview'>('diff');
  /** 文件类型按当前状态的路径判断；已删除文件仍可进入预览查看不可用原因。 */
  const markdownFile = /\.(?:md|markdown|mdx)$/iu.test((changeSet.state === 'undone' ? activeFile?.oldPath : activeFile?.newPath) ?? activeFile?.oldPath ?? activeFile?.newPath ?? '');
  /** 普通文件与没有读取能力的页面始终展示原始差异。 */
  const renderedMarkdown = markdownFile && Boolean(props.onLoadPreview) && viewMode === 'preview';
  /** 将本轮补丁转换为交付页共用的双栏数据，避免重复维护布局与高亮。 */
  const diff = useMemo(() => (renderedMarkdown ? null : turnFileDiff(activeFile)), [activeFile, renderedMarkdown]);
  const activePath = activeFile ? commentPath(activeFile) : null;
  const comments = useMemo(() => (props.comments ?? []).filter((comment) => comment.position.path === activePath), [props.comments, activePath]);
  /** 只为实际评论和当前草稿登记位置，不遍历代码行。 */
  const annotationLines = useMemo(() => [...comments.map((comment) => comment.position), ...(draftPosition ? [draftPosition] : [])], [comments, draftPosition]);

  useEffect(() => {
    titleRef.current?.focus();
  }, [props.changeSet.id]);

  useEffect(() => {
    if (props.initialFileId && changeSet.files.some((file) => file.id === props.initialFileId)) {
      setActiveFileId(props.initialFileId);
      return;
    }
    if (!changeSet.files.some((file) => file.id === activeFileId)) {
      setActiveFileId(changeSet.files[0]?.id ?? null);
    }
  }, [activeFileId, changeSet.files, props.initialFileId]);

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
            >
              +
            </button>
          ) : null}
          {side === currentSide && activeFile && canOpen ? (
            <button type="button" className="session-diff-line-number" aria-label={zh ? `在源码中打开第 ${line} 行` : `Open source at line ${line}`} onClick={() => void openFile(activeFile, line)}>
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
            title={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            onClick={() => props.onFullWidthChange(!props.fullWidth)}
          >
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </button>
          <button type="button" aria-label={zh ? '关闭变更审核' : 'Close change review'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </nav>
      </header>
      {changeSet.conflict ? (
        <p className="session-turn-change-error session-turn-diff-error" role="alert">
          <VisibleApplicationError error={changeSet.conflict} language={zh ? 'zh-CN' : 'en'} />
        </p>
      ) : null}
      {!changeSet.conflict && changeSet.state === 'unavailable' && changeSet.unavailableReason ? (
        <p className="session-turn-change-notice session-turn-diff-error" role="status">
          <Info aria-hidden="true" />
          <span>{unavailableReason(changeSet.unavailableReason, props.language)}</span>
        </p>
      ) : null}
      <div className="session-turn-diff-layout">
        <nav className="session-turn-diff-files" aria-label={zh ? '变更文件' : 'Changed files'}>
          <div className="session-turn-diff-totals">
            <span className="session-change-added">+{changeSet.addedLines}</span>
            <span className="session-change-deleted">-{changeSet.deletedLines}</span>
          </div>
          {changeSet.files.map((file) => (
            <button type="button" key={file.id} aria-current={file.id === activeFile?.id ? 'true' : undefined} onClick={() => setActiveFileId(file.id)}>
              <span title={displayPath(file)}>{displayPath(file)}</span>
              <small>
                {file.addedLines ? <span className="session-change-added">+{file.addedLines}</span> : null}
                {file.deletedLines ? <span className="session-change-deleted">-{file.deletedLines}</span> : null}
              </small>
            </button>
          ))}
        </nav>
        <section className="session-turn-diff-content" aria-label={activeFile ? displayPath(activeFile) : undefined}>
          {activeFile ? (
            <>
              <header>
                <strong title={displayPath(activeFile)}>{displayPath(activeFile)}</strong>
                <span>
                  <small>{localizedChangeType(activeFile, props.language)}</small>
                  {markdownFile && props.onLoadPreview ? (
                    <>
                      <button type="button" className="session-turn-diff-open-file" aria-pressed={!renderedMarkdown} onClick={() => setViewMode('diff')}>
                        {zh ? '差异' : 'Diff'}
                      </button>
                      <button type="button" className="session-turn-diff-open-file" aria-pressed={renderedMarkdown} onClick={() => setViewMode('preview')}>
                        {zh ? '预览' : 'Preview'}
                      </button>
                    </>
                  ) : null}
                  {props.onOpenFile ? (
                    <button type="button" className="session-turn-diff-open-file" onClick={() => void openFile(activeFile)}>
                      <FileCode aria-hidden="true" />
                      <span>{zh ? '打开文件' : 'Open file'}</span>
                    </button>
                  ) : null}
                </span>
              </header>
              {renderedMarkdown && props.onLoadPreview ? (
                busy || ['capturing', 'undoing', 'reapplying'].includes(changeSet.state) ? (
                  <p className="session-turn-diff-empty" role="status">
                    {zh ? '正在更新文件，完成后显示预览…' : 'Updating file. Preview will load when finished…'}
                  </p>
                ) : (
                  <TurnChangeMarkdownPreview key={`${changeSet.id}:${activeFile.id}:${changeSet.state}:${changeSet.updatedAt}`} language={props.language} loadPreview={() => props.onLoadPreview!(changeSet, activeFile)} />
                )
              ) : (
                <>
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
                      <div className="session-turn-diff-side-labels">
                        <span title={activeFile.oldPath ?? ''}>{zh ? '修改前' : 'Before'}</span>
                        <span title={activeFile.newPath ?? ''}>{zh ? '修改后' : 'After'}</span>
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
                </>
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

/** 按所选文件和变更状态独立加载，切走后丢弃旧结果，失败可重试。 */
function TurnChangeMarkdownPreview(props: {
  /** 沿用会话界面语言。 */
  language: SessionUiLanguage;
  /** 只读取文件，不打开外部应用或切换审核工作区。 */
  loadPreview: () => Promise<ConversationResourcePreview>;
}) {
  /** 使用现有中英文界面文案。 */
  const zh = props.language === 'zh-CN';
  /** 保存已读取的文本；空文件同样属于成功结果。 */
  const [preview, setPreview] = useState<Extract<ConversationResourcePreview, { kind: 'source' }> | null>(null);
  /** 保存真实读取错误，交给既有错误展示组件解释。 */
  const [error, setError] = useState<unknown>(null);
  /** 只有显式重试才增加读取次数。 */
  const [attempt, setAttempt] = useState(0);
  /** 回调身份变化不重复读取；组件的键负责文件与变更状态隔离。 */
  const loadPreviewRef = useRef(props.loadPreview);
  loadPreviewRef.current = props.loadPreview;

  useEffect(() => {
    /** 卸载或重试后不再应用之前的异步结果。 */
    let active = true;
    setPreview(null);
    setError(null);
    void (async () => {
      try {
        /** 文件读取接口也支持图片，Markdown 预览只接受文本。 */
        const result = await loadPreviewRef.current();
        if (result.kind !== 'source') throw new Error(zh ? '此文件无法作为 Markdown 文本预览。' : 'This file cannot be previewed as Markdown text.');
        if (active) setPreview(result);
      } catch (loadError) {
        if (active) setError(loadError);
      }
    })();
    return () => {
      active = false;
    };
  }, [attempt, zh]);

  return (
    <>
      <p className="session-turn-diff-truncated" role="status">
        {zh ? '当前文件内容；本轮增删请查看“差异”。' : 'Current file content. See Diff for this turn’s changes.'}
        {preview?.truncated ? (zh ? ' 预览已截断。' : ' Preview truncated.') : null}
      </p>
      {error ? (
        <div className="session-turn-diff-empty" role="alert">
          <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} />
          <button type="button" className="session-turn-diff-open-file" onClick={() => setAttempt((value) => value + 1)}>
            {zh ? '重试预览' : 'Retry preview'}
          </button>
        </div>
      ) : preview ? (
        <div className="session-source-markdown-scroll" aria-label={zh ? 'Markdown 预览' : 'Markdown preview'}>
          {preview.content ? <ConversationMarkdown text={preview.content} streamId={`turn-preview:${preview.resource.id}`} phase="final" language={props.language} /> : <p role="status">{zh ? '文件内容为空。' : 'This file is empty.'}</p>}
        </div>
      ) : (
        <p className="session-turn-diff-empty" role="status">
          {zh ? '正在加载 Markdown 预览…' : 'Loading Markdown preview…'}
        </p>
      )}
    </>
  );
}

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

/** 将恢复能力限制与审阅能力区分，并将旧记录中的快照错误转为可理解的提示。 */
function unavailableReason(reason: string, language: SessionUiLanguage): string {
  if (reason === 'The captured recovery snapshots do not reproduce the provider patch.')
    return language === 'zh-CN' ? '无法确认这次修改前后的文件内容，暂不能安全撤销或重新应用；仍可审核已记录的差异。' : 'Recovery snapshots could not be verified, so Undo/Reapply is unavailable. Recorded changes can still be reviewed.';
  if (reason !== historicalTurnChangeUnavailableReason) return reason;
  return language === 'zh-CN' ? '缺少这次修改前后的文件内容，无法撤销或重新应用这些修改。' : 'The file contents before and after these changes are unavailable. These changes cannot be undone or reapplied.';
}

function changeSetTitle(changeSet: TurnChangeSet, language: SessionUiLanguage): string {
  const zh = language === 'zh-CN';
  const subject = changeSet.fileCount === 1 ? displayPath(changeSet.files[0]!) : zh ? `${changeSet.fileCount} 个文件` : `${changeSet.fileCount} files`;
  if (changeSet.state === 'capturing') return zh ? '正在记录文件变更' : 'Recording file changes';
  if (changeSet.state === 'undoing') return zh ? '正在撤销文件变更' : 'Undoing file changes';
  if (changeSet.state === 'reapplying') return zh ? '正在重新应用文件变更' : 'Reapplying file changes';
  if (changeSet.state === 'undone') return zh ? `已撤销 ${subject}` : `Undid ${subject}`;
  if (changeSet.state === 'conflicted') return zh ? `无法安全更新 ${subject}` : `Could not safely update ${subject}`;
  if (changeSet.state === 'unavailable') return zh ? '文件变更不可撤销' : 'File changes are not reversible';
  return zh ? `已记录 ${subject}的变更` : `Recorded changes to ${subject}`;
}

function displayPath(file: TurnChangeFile): string {
  if (file.oldPath && file.newPath && file.oldPath !== file.newPath) return `${file.oldPath} → ${file.newPath}`;
  return file.newPath ?? file.oldPath ?? 'unknown';
}

function localizedChangeType(file: TurnChangeFile, language: SessionUiLanguage): string {
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
