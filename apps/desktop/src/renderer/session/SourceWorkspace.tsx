import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileImageIcon as FileImage } from '@phosphor-icons/react/dist/csr/FileImage';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ConversationResourcePreview } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { ConversationMarkdown } from './ConversationMarkdown.js';
import type { ConversationCodeComment, ConversationCodeCommentPosition } from '@zeus/shared';
import { CodeCommentPanel } from './CodeCommentPanel.js';
/** 与项目源码编辑器一样按需加载，避免会话首屏加载编辑器运行时。 */
const SourceCodePreview = lazy(() => import('../code/SourceCodePreview.js').then((module) => ({ default: module.SourceCodePreview })));

/** Markdown 可在排版预览与源码之间切换。 */
export type SourceWorkspaceViewMode = 'preview' | 'source';

/** Markdown 默认展示排版，其余文件直接展示源码。 */
export function defaultSourceWorkspaceViewMode(preview: ConversationResourcePreview): SourceWorkspaceViewMode {
  return supportsMarkdownPreview(preview) ? 'preview' : 'source';
}

/** 会话资源共用的预览入口，源码交给可视区域渲染，图片与 Markdown 保持原有展示。 */
export function SourceWorkspace(props: {
  preview: ConversationResourcePreview;
  viewMode: SourceWorkspaceViewMode;
  onViewModeChange: (viewMode: SourceWorkspaceViewMode) => void;
  language: SessionUiLanguage;
  fullWidth: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  comments?: ConversationCodeComment[];
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}) {
  /** 当前界面文案与资源展示信息。 */
  const zh = props.language === 'zh-CN';
  /** 打开资源时供键盘用户定位预览标题。 */
  const titleRef = useRef<HTMLSpanElement | null>(null);
  /** 图片资源不参与源码或 Markdown 渲染。 */
  const sourcePreview = props.preview.kind === 'source' ? props.preview : null;
  /** 文件用项目相对路径，附件使用显示名称。 */
  const displayPath = props.preview.resource.kind === 'file' ? props.preview.resource.projectRelativePath : props.preview.resource.displayName;
  /** 是否提供 Markdown 排版切换入口。 */
  const markdownPreview = supportsMarkdownPreview(props.preview);
  /** 当前只挂载被选中的一种展示模式。 */
  const renderedMarkdown = Boolean(sourcePreview && markdownPreview && props.viewMode === 'preview');
  /** 尚未保存的评论行范围。 */
  const [draftPosition, setDraftPosition] = useState<ConversationCodeCommentPosition | null>(null);
  /** 当前正在编辑的已保存评论。 */
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  /** Shift 点击使用上次选中的行作为范围起点。 */
  const rangeStartLine = useRef<number | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, [props.preview.resource.id]);

  useEffect(() => {
    setDraftPosition(null);
    setEditingCommentId(null);
    rangeStartLine.current = null;
  }, [props.preview.resource.id, displayPath]);

  /** 只处理当前文件的评论，输入正文变化时复用分组结果。 */
  const comments = useMemo(() => (props.comments ?? []).filter((comment) => comment.position.path === displayPath && comment.position.side === 'right'), [props.comments, displayPath]);
  /** 容器按行复用，其他评论更新时也保留当前行的输入状态。 */
  const widgetElements = useRef(new Map<number, HTMLElement>());
  /** 只为实际存在评论或草稿的行建立容器，滚动隐藏时保留 React 状态。 */
  const widgets = useMemo(() => {
    // 评论数量决定门户数量，与文件总行数无关。
    const lines = new Set(comments.map((comment) => comment.position.line));
    if (draftPosition) lines.add(draftPosition.line);
    /** 仅保留当前评论行，移除的评论不长期占用容器。 */
    const next = [...lines].sort((left, right) => left - right).map((line) => ({ line, element: widgetElements.current.get(line) ?? document.createElement('div') }));
    widgetElements.current = new Map(next.map((widget) => [widget.line, widget.element]));
    return next;
  }, [comments, draftPosition]);

  /** 由编辑器在评论区块完成布局后聚焦，避免提前聚焦离屏节点。 */
  const activeCommentLine = draftPosition?.line ?? comments.find((comment) => comment.id === editingCommentId)?.position.line;

  /** 复用稳定回调，评论范围不依赖会话正文的更新。 */
  const beginComment = useCallback(
    (line: number, extendRange: boolean) => {
      /** 归一化范围，持久化仍使用结束行与可选起始行。 */
      const startLine = extendRange && rangeStartLine.current ? Math.min(rangeStartLine.current, line) : line;
      /** 范围终点不小于起点。 */
      const endLine = extendRange && rangeStartLine.current ? Math.max(rangeStartLine.current, line) : line;
      rangeStartLine.current = line;
      setEditingCommentId(null);
      setDraftPosition({ path: displayPath, line: endLine, side: 'right', ...(startLine !== endLine ? { startLine, startSide: 'right' as const } : {}) });
    },
    [displayPath],
  );
  /** 评论入口保持当前界面语言。 */
  const commentLabel = useCallback((line: number) => (zh ? `评论第 ${line} 行` : `Comment on line ${line}`), [zh]);

  /** 保存到原有会话评论草稿，不修改文件内容。 */
  function saveComment(position: ConversationCodeCommentPosition, body: string, existingId?: string): void {
    if (!props.onCommentsChange) return;
    /** 沿用原有会话草稿回调写入评论。 */
    const next = existingId ? (props.comments ?? []).map((comment) => (comment.id === existingId ? { ...comment, body } : comment)) : [...(props.comments ?? []), { id: crypto.randomUUID(), body, position }];
    props.onCommentsChange(next);
    setDraftPosition(null);
    setEditingCommentId(null);
  }

  return (
    <section
      className="session-context-workspace session-source-workspace"
      aria-label={props.preview.kind === 'image' ? (zh ? '图片预览' : 'Image preview') : renderedMarkdown ? (zh ? 'Markdown 预览' : 'Markdown preview') : zh ? '源码预览' : 'Source preview'}
    >
      <header className="session-context-workspace-header">
        <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
          {props.preview.kind === 'image' ? <FileImage aria-hidden="true" weight="regular" /> : <FileCode aria-hidden="true" weight="regular" />}
          <span>
            <strong>{basename(displayPath)}</strong>
            <small title={displayPath}>{displayPath}</small>
          </span>
        </span>
        <nav aria-label={zh ? '源码预览操作' : 'Source preview actions'}>
          {markdownPreview ? (
            <>
              <button type="button" className="session-context-text-action session-source-view-action" aria-pressed={renderedMarkdown} onClick={() => props.onViewModeChange('preview')}>
                {zh ? '预览' : 'Preview'}
              </button>
              <button type="button" className="session-context-text-action session-source-view-action" aria-pressed={!renderedMarkdown} onClick={() => props.onViewModeChange('source')}>
                {zh ? '源码' : 'Source'}
              </button>
            </>
          ) : null}
          <button
            type="button"
            aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            title={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
            onClick={() => props.onFullWidthChange(!props.fullWidth)}
          >
            {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
          </button>
          <button type="button" aria-label={zh ? '关闭源码预览' : 'Close source preview'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
            <X aria-hidden="true" />
          </button>
        </nav>
      </header>
      <div className="session-source-meta" role="status">
        {props.preview.kind === 'image' ? (
          <>
            <span>{props.preview.mimeType}</span>
            <span>{formatBytes(props.preview.byteLength)}</span>
          </>
        ) : (
          <>
            <span>{props.preview.language ?? (zh ? '纯文本' : 'Plain text')}</span>
            <span>{zh ? `${props.preview.lineCount} 行` : `${props.preview.lineCount} lines`}</span>
            {props.preview.truncated ? <span>{zh ? '预览已截断' : 'Preview truncated'}</span> : null}
          </>
        )}
      </div>
      <div className={renderedMarkdown ? 'session-source-markdown-scroll' : `session-source-scroll ${props.preview.kind === 'image' ? 'session-image-preview' : ''}`}>
        {props.preview.kind === 'image' ? (
          <img src={props.preview.dataUrl} alt={props.preview.resource.displayName} decoding="async" />
        ) : renderedMarkdown ? (
          <ConversationMarkdown text={props.preview.content} streamId={`source-preview:${props.preview.resource.id}`} phase="final" language={props.language} />
        ) : (
          <Suspense fallback={<div role="status">{zh ? '正在打开源码…' : 'Opening source…'}</div>}>
            <SourceCodePreview
              key={props.preview.resource.id}
              path={displayPath}
              content={props.preview.content}
              language={props.preview.language}
              label={zh ? `${displayPath} 源码` : `${displayPath} source`}
              location={props.preview.location}
              widgets={widgets}
              focusWidget={widgets.find((widget) => widget.line === activeCommentLine)?.element}
              onComment={props.onCommentsChange ? beginComment : undefined}
              commentLabel={commentLabel}
            />
            {widgets.map((widget) =>
              createPortal(
                <>
                  {comments
                    .filter((comment) => comment.position.line === widget.line)
                    .map((comment) =>
                      editingCommentId === comment.id ? (
                        <CodeCommentPanel
                          key={comment.id}
                          language={props.language}
                          position={comment.position}
                          comment={comment}
                          onCancel={() => setEditingCommentId(null)}
                          onSave={(body) => saveComment(comment.position, body, comment.id)}
                          onDelete={() => {
                            props.onCommentsChange?.((props.comments ?? []).filter((candidate) => candidate.id !== comment.id));
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
                            <button type="button" onClick={() => props.onCommentsChange?.((props.comments ?? []).filter((candidate) => candidate.id !== comment.id))}>
                              {zh ? '删除' : 'Delete'}
                            </button>
                          </span>
                        </span>
                      ),
                    )}
                  {draftPosition?.line === widget.line ? <CodeCommentPanel language={props.language} position={draftPosition} onCancel={() => setDraftPosition(null)} onSave={(body) => saveComment(draftPosition, body)} /> : null}
                </>,
                widget.element,
                String(widget.line),
              ),
            )}
          </Suspense>
        )}
      </div>
    </section>
  );
}

/** 依据资源类型、语言及后缀保留 Markdown 预览能力。 */
function supportsMarkdownPreview(preview: ConversationResourcePreview): boolean {
  if (preview.kind !== 'source') return false;
  if (preview.resource.iconKind === 'markdown') return true;
  /** 语言信息可能来自文件后缀或附件预览。 */
  const language = preview.language?.trim().toLowerCase();
  if (language === 'markdown' || language === 'md' || language === 'mdx') return true;
  /** 文件用项目相对路径，附件使用显示名称。 */
  const displayPath = preview.resource.kind === 'file' ? preview.resource.projectRelativePath : preview.resource.displayName;
  return /\.(?:md|markdown|mdx)$/iu.test(displayPath);
}

/** 标题仅显示文件名，完整路径仍在副标题中保留。 */
function basename(path: string): string {
  /** 统一路径分隔符后取文件名。 */
  const normalized = path.replaceAll('\\', '/');
  return normalized.split('/').filter(Boolean).at(-1) ?? path;
}

/** 图片信息沿用简短的字节大小展示。 */
function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
