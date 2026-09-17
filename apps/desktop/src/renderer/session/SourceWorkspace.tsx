import type { ConversationResource } from '@zeus/shared';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { OpenWithMenu } from './ConversationResources.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import type { ConversationOpenTarget } from '@zeus/shared';
import { FilePreview, PreviewImage } from '../code/FilePreview.js';
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
import type { FilePreviewRequest, ConversationCodeComment, ConversationCodeCommentPosition } from '@zeus/shared';
import { CodeCommentPanel } from './CodeCommentPanel.js';
/** 与项目源码编辑器一样按需加载，避免会话首屏加载编辑器运行时。 */
const SourceCodePreview = lazy(() => import('../code/SourceCodePreview.js').then((module) => ({ default: module.SourceCodePreview })));

/** Markdown 可在排版预览与源码之间切换。 */
export type SourceWorkspaceViewMode = 'preview' | 'source';

/** Markdown 默认展示排版，其余文件直接展示源码。 */
export function defaultSourceWorkspaceViewMode(preview: ConversationResourcePreview): SourceWorkspaceViewMode {
  return supportsMarkdownPreview(preview) ? 'preview' : 'source';
}

/** 同一预览面板保留已打开文件，关闭当前标签后回到相邻文件。 */
export function SourceWorkspace(props: Parameters<typeof SourceWorkspaceView>[0]) {
  /** 每个标签保留自己的预览模式和已授权资源。 */
  const [tabs, setTabs] = useState([{ preview: props.preview, mode: props.viewMode }]);
  /** 当前标签独立于最近收到的打开请求。 */
  const [activeId, setActiveId] = useState(props.preview.resource.id);
  useEffect(() => {
    setTabs((current) => [...current.filter((tab) => tab.preview.resource.id !== props.preview.resource.id), { preview: props.preview, mode: props.viewMode }]);
    setActiveId(props.preview.resource.id);
  }, [props.preview]);
  /** 外部预览到达但状态尚未同步时仍显示真实文件。 */
  const active = tabs.find((tab) => tab.preview.resource.id === activeId) ?? tabs[0]!;
  return (
    <SourceWorkspaceView
      {...props}
      preview={active.preview}
      viewMode={active.mode}
      tabs={tabs.map((tab) => tab.preview)}
      onSelectTab={(preview) => setActiveId(preview.resource.id)}
      onViewModeChange={(mode) => setTabs((current) => current.map((tab) => (tab.preview.resource.id === activeId ? { ...tab, mode } : tab)))}
      onCloseTab={(preview) => {
        const remaining = tabs.filter((tab) => tab.preview.resource.id !== preview.resource.id);
        if (!remaining.length) {
          props.onClose();
          return;
        }
        setTabs(remaining);
        if (preview.resource.id === activeId) setActiveId(remaining.at(-1)!.preview.resource.id);
      }}
    />
  );
}

/** 会话资源共用的预览入口，源码交给可视区域渲染，图片与 Markdown 保持原有展示。 */
function SourceWorkspaceView(props: {
  /** 文件标题与浏览器标签共用会话顶栏位置。 */
  toolbarHost?: HTMLElement | null;
  preview: ConversationResourcePreview;
  /** 外部打开与复制沿用宿主的资源授权。 */
  onOpen?: (target: ConversationOpenTarget, resource?: ConversationResource) => void | Promise<void>;
  /** 多文件标签由外层持有，正文组件只负责当前文件。 */
  tabs?: ConversationResourcePreview[];
  onSelectTab?: (preview: ConversationResourcePreview) => void;
  onCloseTab?: (preview: ConversationResourcePreview) => void;
  /** 新增标签从本会话已有授权文件中选择。 */
  resources?: ConversationResource[];
  onOpenFile?: (resource: ConversationResource) => void | Promise<void>;
  viewMode: SourceWorkspaceViewMode;
  onViewModeChange: (viewMode: SourceWorkspaceViewMode) => void;
  language: SessionUiLanguage;
  fullWidth: boolean;
  /** 窄窗口已经全宽，分栏按钮给出明确的不可用原因。 */
  canSplit?: boolean;
  onFullWidthChange: (fullWidth: boolean) => void;
  onClose: () => void;
  comments?: ConversationCodeComment[];
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}) {
  /** 当前界面文案与资源展示信息。 */
  const zh = props.language === 'zh-CN';
  /** 分段打开按钮保留本次预览选择的外部应用。 */
  const [openTarget, setOpenTarget] = useState<ConversationOpenTarget>('system_default');
  /** 展示宿主打开失败，不吞掉权限或应用错误。 */
  const [openError, setOpenError] = useState<unknown>(null);
  useApplicationErrorDialog(openError, { language: zh ? 'zh-CN' : 'en' });
  /** 统一处理复制与外部应用打开。 */
  async function openResource(target: ConversationOpenTarget): Promise<void> {
    try {
      await props.onOpen?.(target, props.preview.resource);
    } catch (error) {
      setOpenError(error);
    }
  }
  /** 打开资源时供键盘用户定位预览标题。 */
  const titleRef = useRef<HTMLButtonElement | null>(null);
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

  /** 顶栏展示文件名与预览操作，正文从文件信息行直接开始。 */
  const header = (
    <header className="session-context-workspace-header session-source-header">
      <div
        className="session-source-tabs"
        role="tablist"
        aria-label={zh ? '已打开文件' : 'Open files'}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return;
          event.preventDefault();
          const tabs = props.tabs ?? [props.preview];
          const index = tabs.findIndex((tab) => tab.resource.id === props.preview.resource.id);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          props.onSelectTab?.(tabs[next]!);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
        }}
      >
        {(props.tabs ?? [props.preview]).map((preview) => (
          <div className={`session-context-workspace-title${preview.resource.id === props.preview.resource.id ? ' active' : ''}`} key={preview.resource.id}>
            <button
              type="button"
              ref={preview.resource.id === props.preview.resource.id ? titleRef : undefined}
              role="tab"
              tabIndex={preview.resource.id === props.preview.resource.id ? 0 : -1}
              aria-selected={preview.resource.id === props.preview.resource.id}
              title={preview.resource.displayName}
              onClick={() => props.onSelectTab?.(preview)}
            >
              {preview.kind === 'image' ? <FileImage aria-hidden="true" /> : <FileCode aria-hidden="true" />}
              <span>{basename(preview.resource.kind === 'file' ? preview.resource.projectRelativePath : preview.resource.displayName)}</span>
            </button>
            <button type="button" className="session-source-tab-close" aria-label={`${zh ? '关闭' : 'Close'} ${preview.resource.displayName}`} onClick={() => (props.onCloseTab ? props.onCloseTab(preview) : props.onClose())}>
              <X aria-hidden="true" />
            </button>
          </div>
        ))}
        <select
          className="session-source-add-tab"
          aria-label={zh ? '打开文件标签' : 'Open file tab'}
          value=""
          disabled={!props.onOpenFile || !props.resources?.length}
          onChange={(event) => {
            const resource = props.resources?.find((candidate) => candidate.id === event.currentTarget.value);
            if (resource) void Promise.resolve(props.onOpenFile?.(resource)).catch(setOpenError);
          }}
        >
          <option value="">＋</option>
          {props.resources?.map((resource) => (
            <option key={resource.id} value={resource.id}>
              {resource.displayName}
            </option>
          ))}
        </select>
      </div>
      <nav aria-label={zh ? '源码预览操作' : 'Source preview actions'}>
        <button
          type="button"
          aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
          disabled={props.canSplit === false}
          title={props.canSplit === false ? (zh ? '窗口较窄，已自动全宽显示' : 'This window is too narrow for split view') : props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
          onClick={() => props.onFullWidthChange(!props.fullWidth)}
        >
          {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
        </button>
        <button type="button" aria-label={zh ? '关闭源码预览' : 'Close source preview'} title={zh ? '关闭' : 'Close'} onClick={props.onClose}>
          <X aria-hidden="true" />
        </button>
      </nav>
    </header>
  );

  return (
    <section
      className="session-context-workspace session-source-workspace"
      aria-label={props.preview.kind === 'image' ? (zh ? '图片预览' : 'Image preview') : renderedMarkdown ? (zh ? 'Markdown 预览' : 'Markdown preview') : zh ? '源码预览' : 'Source preview'}
    >
      {props.toolbarHost ? createPortal(header, props.toolbarHost) : header}
      <div className="session-source-toolbar">
        <nav className="session-source-breadcrumbs" aria-label={zh ? '文件路径' : 'File path'} title={displayPath}>
          {displayPath.split('/').map((part, index) => (
            <span key={index}>
              {index > 0 ? <span aria-hidden="true">›</span> : null}
              {part}
            </span>
          ))}
        </nav>
        <div className="session-source-actions">
          {markdownPreview ? (
            <button type="button" onClick={() => props.onViewModeChange(renderedMarkdown ? 'source' : 'preview')}>
              {renderedMarkdown ? (zh ? '查看源代码' : 'View source') : zh ? '查看预览' : 'View preview'}
            </button>
          ) : null}
          <button type="button" aria-label={zh ? '复制路径' : 'Copy path'} title={zh ? '复制路径' : 'Copy path'} disabled={!props.onOpen} onClick={() => void openResource('copy_path')}>
            <Copy aria-hidden="true" />
          </button>
          <div className="session-source-open-group">
            <button type="button" disabled={!props.onOpen} onClick={() => void openResource(openTarget)}>
              {zh ? '打开' : 'Open'}
            </button>
            <OpenWithMenu
              key={props.preview.resource.id}
              resource={props.preview.resource}
              language={props.language}
              disabled={!props.onOpen}
              applicationsOnly
              onOpen={(target) => {
                setOpenTarget(target);
                return openResource(target);
              }}
              label=""
            />
          </div>
        </div>
      </div>
      {sourcePreview?.truncated ? <div role="status">{zh ? '预览已截断' : 'Preview truncated'}</div> : null}
      <div className={renderedMarkdown ? 'session-source-markdown-scroll' : `session-source-scroll ${props.preview.kind === 'image' ? 'session-image-preview' : ''}`}>
        {props.preview.kind === 'image' ? (
          <PreviewImage key={props.preview.dataUrl} url={props.preview.dataUrl} name={props.preview.resource.displayName} zh={zh} />
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
              projectId={props.preview.resource.kind === 'file' ? props.preview.resource.projectId : undefined}
              conversationId={props.preview.resource.kind === 'file' ? props.preview.resource.conversationId : undefined}
              resourceId={props.preview.resource.kind === 'file' ? props.preview.resource.id : undefined}
              blameLabels={{
                locale: props.language,
                show: zh ? '显示 Git blame' : 'Show Git blame',
                hide: zh ? '隐藏 Git blame' : 'Hide Git blame',
                loading: zh ? '正在加载 Git blame…' : 'Loading Git blame…',
                unavailable: zh ? 'Git blame 暂不可用' : 'Git blame unavailable',
                retry: zh ? '重试' : 'Retry',
              }}
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

/** 通用文件沿用会话右侧审阅容器，预览组件负责授权读取、格式展示和失败重试。 */
export function FilePreviewWorkspace(props: {
  request: FilePreviewRequest;
  language: SessionUiLanguage;
  toolbarHost?: HTMLElement | null;
  fullWidth: boolean;
  canSplit: boolean;
  onFullWidthChange: (value: boolean) => void;
  onClose: () => void;
}) {
  /** 当前界面的中英文文案。 */
  const zh = props.language === 'zh-CN';
  /** 每次切换文件将焦点移到审阅标题。 */
  const titleRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    titleRef.current?.focus();
  }, [props.request]);
  /** 与源码和浏览器一样将操作栏放入会话顶栏。 */
  const header = (
    <header className="session-context-workspace-header">
      <span className="session-context-workspace-title" ref={titleRef} tabIndex={-1}>
        <FileCode aria-hidden="true" />
        <strong>{zh ? '文件审阅' : 'File review'}</strong>
      </span>
      <nav aria-label={zh ? '文件审阅操作' : 'File review actions'}>
        <button
          type="button"
          disabled={!props.canSplit}
          title={!props.canSplit ? (zh ? '窗口较窄，已自动全宽显示' : 'This window is too narrow for split view') : undefined}
          aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'}
          onClick={() => props.onFullWidthChange(!props.fullWidth)}
        >
          {props.fullWidth ? <ArrowsIn aria-hidden="true" /> : <ArrowsOut aria-hidden="true" />}
        </button>
        <button type="button" aria-label={zh ? '关闭文件审阅' : 'Close file review'} onClick={props.onClose}>
          <X aria-hidden="true" />
        </button>
      </nav>
    </header>
  );
  return (
    <section className="session-context-workspace session-source-workspace" aria-label={zh ? '文件审阅' : 'File review'}>
      {props.toolbarHost ? createPortal(header, props.toolbarHost) : header}
      <FilePreview request={props.request} zh={zh} />
    </section>
  );
}
