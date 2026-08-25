import { Fragment, useEffect, useRef, useState } from 'react';
import { ArrowsInIcon as ArrowsIn } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { ArrowsOutIcon as ArrowsOut } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { FileCodeIcon as FileCode } from '@phosphor-icons/react/dist/csr/FileCode';
import { FileImageIcon as FileImage } from '@phosphor-icons/react/dist/csr/FileImage';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ConversationResourcePreview } from './sessionTypes.js';
import { SafeMarkdown, type SessionUiLanguage } from './ThreadItemView.js';
import type { ConversationCodeComment, ConversationCodeCommentPosition } from '@zeus/shared';
import { CodeCommentPanel } from './CodeCommentPanel.js';
import { SyntaxHighlightedLine, useSyntaxHighlightedLines } from '../code/SyntaxHighlightedCode.js';

export type SourceWorkspaceViewMode = 'preview' | 'source';

export function defaultSourceWorkspaceViewMode(preview: ConversationResourcePreview): SourceWorkspaceViewMode {
  return supportsMarkdownPreview(preview) ? 'preview' : 'source';
}

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
  const zh = props.language === 'zh-CN';
  const contentRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const sourcePreview = props.preview.kind === 'source' ? props.preview : null;
  const displayPath = props.preview.resource.kind === 'file' ? props.preview.resource.projectRelativePath : props.preview.resource.displayName;
  const markdownPreview = supportsMarkdownPreview(props.preview);
  const renderedMarkdown = Boolean(sourcePreview && markdownPreview && props.viewMode === 'preview');
  const lines = useSyntaxHighlightedLines(displayPath, sourcePreview?.content ?? '', sourcePreview?.language ?? null);
  const targetLine = sourcePreview?.location?.line ?? null;
  const targetEndLine = sourcePreview?.location?.endLine ?? targetLine;
  const [draftPosition, setDraftPosition] = useState<ConversationCodeCommentPosition | null>(null);
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [rangeStartLine, setRangeStartLine] = useState<number | null>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, [props.preview.resource.id]);

  useEffect(() => {
    if (renderedMarkdown || !targetLine) return;
    const target = contentRef.current?.querySelector<HTMLElement>(`[data-source-line='${targetLine}']`);
    target?.scrollIntoView({ block: 'center' });
  }, [props.preview.resource.id, renderedMarkdown, targetLine]);

  const comments = (props.comments ?? []).filter((comment) => comment.position.path === displayPath && comment.position.side === 'right');

  function saveComment(position: ConversationCodeCommentPosition, body: string, existingId?: string): void {
    if (!props.onCommentsChange) return;
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
      <div className={renderedMarkdown ? 'session-source-markdown-scroll' : `session-source-scroll ${props.preview.kind === 'image' ? 'session-image-preview' : ''}`} ref={contentRef}>
        {props.preview.kind === 'image' ? (
          <img src={props.preview.dataUrl} alt={props.preview.resource.displayName} />
        ) : renderedMarkdown ? (
          <SafeMarkdown text={props.preview.content} language={props.language} />
        ) : (
          <pre aria-label={zh ? `${displayPath} 源码` : `${displayPath} source`}>
            <code>
              {lines.map((line, index) => {
                const lineNumber = index + 1;
                const selected = Boolean(targetLine && targetEndLine && lineNumber >= targetLine && lineNumber <= targetEndLine);
                const lineComments = comments.filter((comment) => comment.position.line === lineNumber);
                const draftHere = draftPosition?.line === lineNumber;
                return (
                  <Fragment key={lineNumber}>
                    <span className="session-source-line" data-source-line={lineNumber} data-selected={selected || undefined}>
                      {props.onCommentsChange ? (
                        <button
                          type="button"
                          className="session-code-comment-add"
                          aria-label={zh ? `评论第 ${lineNumber} 行` : `Comment on line ${lineNumber}`}
                          onClick={(event) => {
                            const startLine = event.shiftKey && rangeStartLine ? Math.min(rangeStartLine, lineNumber) : lineNumber;
                            const endLine = event.shiftKey && rangeStartLine ? Math.max(rangeStartLine, lineNumber) : lineNumber;
                            setRangeStartLine(lineNumber);
                            setEditingCommentId(null);
                            setDraftPosition({ path: displayPath, line: endLine, side: 'right', ...(startLine !== endLine ? { startLine, startSide: 'right' as const } : {}) });
                          }}
                        >
                          +
                        </button>
                      ) : null}
                      <span className="session-source-line-number" aria-hidden="true">
                        {lineNumber}
                      </span>
                      <span className="session-source-line-code">
                        <SyntaxHighlightedLine line={line} />
                      </span>
                    </span>
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
                    {draftHere && draftPosition ? <CodeCommentPanel language={props.language} position={draftPosition} onCancel={() => setDraftPosition(null)} onSave={(body) => saveComment(draftPosition, body)} /> : null}
                  </Fragment>
                );
              })}
            </code>
          </pre>
        )}
      </div>
    </section>
  );
}

function supportsMarkdownPreview(preview: ConversationResourcePreview): boolean {
  if (preview.kind !== 'source') return false;
  if (preview.resource.iconKind === 'markdown') return true;
  const language = preview.language?.trim().toLowerCase();
  if (language === 'markdown' || language === 'md' || language === 'mdx') return true;
  const displayPath = preview.resource.kind === 'file' ? preview.resource.projectRelativePath : preview.resource.displayName;
  return /\.(?:md|markdown|mdx)$/iu.test(displayPath);
}

function basename(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.split('/').filter(Boolean).at(-1) ?? path;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
