import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatTeardropDotsIcon as ChatTeardropDots } from '@phosphor-icons/react/dist/csr/ChatTeardropDots';
import type { EditorView } from '@codemirror/view';
import type { ConversationCodeComment, ConversationCodeCommentPosition, ConversationCodeCommentSide, ConversationFileLocation, FilePreviewBlameLine } from '@zeus/shared';
import { SourceCodePreview } from '../code/SourceCodePreview.js';
import { MotionPresence, PopoverSurface } from '../ui/MotionPresence.js';
import { CodeCommentPanel } from './CodeCommentPanel.js';
import { SelectionCommentEditor, selectionCommentEditorPoint, type SelectionOverlayBounds } from './SelectionCommentEditor.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import type { GitBlameLine } from '../features/git/gitContracts.js';

/** 只读源码及文字选区评论共用的输入。 */
interface CommentableSourceCodePreviewProps {
  /** 文件或版本身份变化时清理未保存的评论编辑状态。 */
  identity: string;
  /** 评论中使用的稳定文件路径。 */
  path: string;
  /** 已授权的只读文件正文。 */
  content: string;
  /** CodeMirror 语法高亮语言。 */
  language: string | null;
  /** 代码区域的无障碍名称。 */
  label: string;
  /** 评论所属的文件版本侧。 */
  side?: ConversationCodeCommentSide;
  /** 当前界面语言。 */
  locale: SessionUiLanguage;
  /** 工具栏触发的文件内搜索请求。 */
  searchRequest?: number;
  /** 当前引用的行号范围。 */
  location?: ConversationFileLocation;
  /** 项目身份用于读取 Git blame。 */
  projectId?: string;
  /** 会话身份用于读取受控资源的 Git blame。 */
  conversationId?: string;
  /** 会话资源身份用于读取受控资源的 Git blame。 */
  resourceId?: string;
  /** 文件预览提供的版本归属与正文一起传给只读编辑器。 */
  blame?: FilePreviewBlameLine[];
  /** 通用预览直接传入已校验版本的逐行归属。 */
  blameLines?: GitBlameLine[];
  /** 当前会话全部代码评论。 */
  comments?: ConversationCodeComment[];
  /** 缺省表示当前会话只读，不展示评论入口。 */
  onCommentsChange?: (comments: ConversationCodeComment[]) => void;
}

/** 拖选完成后暂存准确文字锚点和评论入口位置。 */
interface SourceSelectionCandidate {
  position: ConversationCodeCommentPosition;
  /** 鼠标松手点用于保持评论入口贴近用户操作位置。 */
  pointer: { left: number; top: number };
  point: { left: number; top: number; placement: 'above' | 'below' };
}

/** 含完整文字锚点的文件评论位置。 */
type TextAnchoredCodePosition = ConversationCodeCommentPosition & Required<Pick<ConversationCodeCommentPosition, 'endOffset' | 'selectedText' | 'startOffset'>>;
/** 含完整文字锚点的文件评论。 */
type TextAnchoredCodeComment = Omit<ConversationCodeComment, 'position'> & { position: TextAnchoredCodePosition };
/** CodeMirror 返回的评论锚点视口矩形。 */
interface SourceCommentRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/** 评论标记使用与会话回答一致的 24 像素尺寸。 */
const SOURCE_COMMENT_MARKER_SIZE = 24;

/** 源码预览和通用文本审阅共用会话式文字选区评论。 */
export function CommentableSourceCodePreview(props: CommentableSourceCodePreviewProps) {
  /** 当前界面是否使用中文。 */
  const zh = props.locale === 'zh-CN';
  /** 单文件预览缺省属于变更后的右侧。 */
  const side = props.side ?? 'right';
  /** 监听器只依赖评论权限，避免会话刷新更换回调时丢失正在拖选的状态。 */
  const commentsEnabled = Boolean(props.onCommentsChange);
  /** 当前只读编辑器提供文档偏移和视口坐标。 */
  const [view, setView] = useState<EditorView | null>(null);
  /** 拖选后尚未确认创建的评论锚点。 */
  const [candidate, setCandidate] = useState<SourceSelectionCandidate | null>(null);
  /** 当前正在编辑的已保存评论。 */
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  /** 滚动和尺寸变化只刷新浮层位置，不修改评论数据。 */
  const [layoutRevision, setLayoutRevision] = useState(0);
  /** 原生浮层保留主题继承并绕开编辑器裁剪。 */
  const toolbarRef = useRef<HTMLDivElement>(null);
  /** 评论编辑框用于读取真实高度。 */
  const editorRef = useRef<HTMLDivElement>(null);
  /** 未挂载时为零，挂载后按真实高度重新定位。 */
  const [editorHeight, setEditorHeight] = useState(0);
  /** 旧行评论仍使用原有 React 区块，避免历史草稿失去入口。 */
  const widgetElements = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    // 切换文件或版本后不能把上一份文件的临时选区带入当前内容。
    setCandidate(null);
    setEditingCommentId(null);
  }, [props.identity, props.path, side]);

  /** 只处理当前文件和当前版本侧的评论。 */
  const comments = useMemo(() => (props.comments ?? []).filter((comment) => comment.position.path === props.path && comment.position.side === side), [props.comments, props.path, side]);
  /** 新评论使用文字锚点；旧行评论继续按原方式显示和编辑。 */
  const selectionComments = useMemo(() => comments.filter(isTextAnchoredComment), [comments]);
  /** 没有文字偏移的历史评论保持原来的行后区块。 */
  const lineComments = useMemo(() => comments.filter((comment) => !isTextAnchoredPosition(comment.position)), [comments]);
  /** 只有原文仍与锚点一致时才在文件中显示高亮和标记。 */
  const visibleSelectionComments = useMemo(() => selectionComments.filter((comment) => textAnchorMatchesContent(comment.position, props.content)), [props.content, selectionComments]);
  /** 高亮范围保持引用稳定，滚动刷新标记时不重复配置 CodeMirror。 */
  const highlights = useMemo(() => visibleSelectionComments.map((comment) => ({ from: comment.position.startOffset, to: comment.position.endOffset })), [visibleSelectionComments]);
  /** 旧行评论只为实际存在的行建立稀疏容器。 */
  const widgets = useMemo(() => {
    /** 当前需要挂载评论区块的行号。 */
    const lines = new Set(lineComments.map((comment) => comment.position.line));
    /** 保留仍在使用的节点，移除已删除评论的空节点。 */
    const next = [...lines].sort((left, right) => left - right).map((line) => ({ line, element: widgetElements.current.get(line) ?? document.createElement('div') }));
    widgetElements.current = new Map(next.map((widget) => [widget.line, widget.element]));
    return next;
  }, [lineComments]);
  /** 编辑旧行评论时仍定位其区块；文字评论使用浮层。 */
  const activeLineComment = lineComments.find((comment) => comment.id === editingCommentId);
  /** 行号评论入口已停用，保留文案回调用于旧区块能力的共享接口。 */
  const commentLabel = useCallback((line: number) => (zh ? `评论第 ${line} 行` : `Comment on line ${line}`), [zh]);

  useLayoutEffect(() => {
    if (!candidate || !toolbarRef.current || !view) return;
    if (!toolbarRef.current.matches(':popover-open')) toolbarRef.current.showPopover();
    /** 挂载后按按钮真实尺寸再次夹紧到代码区。 */
    const point = sourceSelectionToolbarPoint(candidate.pointer, sourceOverlayBounds(view), toolbarRef.current);
    if (point.left !== candidate.point.left || point.top !== candidate.point.top || point.placement !== candidate.point.placement) setCandidate({ ...candidate, point });
  }, [candidate, view]);

  useEffect(() => {
    if (!view || !commentsEnabled) return;
    /** 只有从当前代码正文开始的拖选才生成评论入口。 */
    let selecting = false;
    /** 开始新选区时关闭旧入口，评论浮层上的操作不改变代码选区。 */
    const handlePointerDown = (event: PointerEvent): void => {
      selecting = false;
      if ((event.target as Element | null)?.closest?.('.session-selection-toolbar, .session-response-annotation-marker, .session-response-annotation-editor')) return;
      selecting = view.contentDOM.contains(event.target as Node);
      setCandidate(null);
    };
    /** 松手后读取 CodeMirror 的最终选区，避免 DOM 虚拟化造成偏移错误。 */
    const handlePointerUp = (event: PointerEvent): void => {
      if (!selecting) return;
      selecting = false;
      requestAnimationFrame(() => {
        const selection = view.state.selection.main;
        const selectedText = view.state.sliceDoc(selection.from, selection.to);
        if (selection.empty || !selectedText.trim() || selectedText.length > 20_000) {
          setCandidate(null);
          return;
        }
        /** 结束行使用最后一个已选字符，行尾选区不会误落到下一行。 */
        const startLine = view.state.doc.lineAt(selection.from).number;
        const endLine = view.state.doc.lineAt(Math.max(selection.from, selection.to - 1)).number;
        /** 文件评论保留原有行号，同时增加准确字符锚点。 */
        const position: ConversationCodeCommentPosition = {
          path: props.path,
          side,
          line: endLine,
          ...(startLine !== endLine ? { startLine, startSide: side } : {}),
          startOffset: selection.from,
          endOffset: selection.to,
          selectedText,
        };
        /** 评论入口贴近鼠标松手点并限制在代码可见区域。 */
        const pointer = { left: event.clientX, top: event.clientY };
        setCandidate({ position, pointer, point: sourceSelectionToolbarPoint(pointer, sourceOverlayBounds(view), toolbarRef.current) });
      });
    };
    view.dom.ownerDocument.addEventListener('pointerdown', handlePointerDown, true);
    view.dom.ownerDocument.addEventListener('pointerup', handlePointerUp, true);
    return () => {
      view.dom.ownerDocument.removeEventListener('pointerdown', handlePointerDown, true);
      view.dom.ownerDocument.removeEventListener('pointerup', handlePointerUp, true);
    };
  }, [commentsEnabled, props.path, side, view]);

  useEffect(() => {
    if (!view) return;
    /** 滚动、窗口和分栏变化都重新计算评论标记与浮层位置。 */
    const updateLayout = (): void => {
      setCandidate((current) => (current ? { ...current, point: sourceSelectionToolbarPoint(current.pointer, sourceOverlayBounds(view), toolbarRef.current) } : null));
      setLayoutRevision((revision) => revision + 1);
    };
    const window = view.dom.ownerDocument.defaultView;
    view.scrollDOM.addEventListener('scroll', updateLayout, { passive: true });
    window?.addEventListener('resize', updateLayout);
    /** 分栏拖动不会触发窗口 resize，因此单独观察代码根节点。 */
    const observer = new ResizeObserver(updateLayout);
    observer.observe(view.dom);
    return () => {
      view.scrollDOM.removeEventListener('scroll', updateLayout);
      window?.removeEventListener('resize', updateLayout);
      observer.disconnect();
    };
  }, [view]);

  useLayoutEffect(() => {
    /** 编辑框进入浏览器顶层后，固定定位才以视口为原点。 */
    const editor = editorRef.current;
    if (!editor) return;
    if (!editor.matches(':popover-open')) {
      editor.showPopover();
      editor.querySelector('textarea')?.focus({ preventScroll: true });
    }
    /** 输入换行会改变浮层高度，必须同步重算上下位置。 */
    const updateHeight = (): void => setEditorHeight(editor.offsetHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [editingCommentId, layoutRevision]);

  /** 新建文字评论后立即打开与会话回答相同的编辑浮层。 */
  function addSelectionComment(position: ConversationCodeCommentPosition): void {
    if (!props.onCommentsChange) return;
    /** 评论先进入会话草稿，Esc 会按会话现有规则保留非空内容或删除空草稿。 */
    const id = crypto.randomUUID();
    props.onCommentsChange([...(props.comments ?? []), { id, body: '', position }]);
    setCandidate(null);
    setEditingCommentId(id);
  }

  /** 更新评论正文时保留文字锚点和评论身份。 */
  function updateComment(id: string, body: string): void {
    props.onCommentsChange?.((props.comments ?? []).map((comment) => (comment.id === id ? { ...comment, body: body.trim() } : comment)));
  }

  /** 删除评论并关闭其浮层。 */
  function removeComment(id: string): void {
    props.onCommentsChange?.((props.comments ?? []).filter((comment) => comment.id !== id));
    setEditingCommentId(null);
  }

  /** 旧行评论继续使用原有面板，避免历史草稿因新交互丢失。 */
  function saveLineComment(body: string, existingId: string): void {
    props.onCommentsChange?.((props.comments ?? []).map((comment) => (comment.id === existingId ? { ...comment, body } : comment)));
    setEditingCommentId(null);
  }

  /** 当前代码区边界用于决定标记和编辑浮层是否可见。 */
  const bounds = sourceOverlayBounds(view);
  /** 当前文字评论的编辑对象。 */
  const editingSelectionComment = props.onCommentsChange ? (visibleSelectionComments.find((comment) => comment.id === editingCommentId) ?? null) : null;
  /** 评论编辑框锚定到选区末端。 */
  const editingRect = view && editingSelectionComment ? sourceCommentRect(view, editingSelectionComment.position) : null;
  /** 选区末端完整可见时才显示编辑浮层。 */
  const editorPoint = editingRect && markerAnchorFitsBounds(editingRect, bounds, 0) ? selectionCommentEditorPoint(editingRect, view?.dom.ownerDocument.defaultView ?? null, bounds, editorHeight) : null;
  /** 已保存评论以编号标记显示在所选文字末端。 */
  const markers = view
    ? visibleSelectionComments.flatMap((comment, index) => {
        /** CodeMirror 提供当前折行和滚动后的视口坐标。 */
        const rect = sourceCommentRect(view, comment.position);
        return rect && markerAnchorFitsBounds(rect, bounds, SOURCE_COMMENT_MARKER_SIZE) ? [{ comment, index, rect }] : [];
      })
    : [];
  void layoutRevision;
  /** 浮层离开代码滚动区但保留应用主题祖先，避免裁剪和样式丢失。 */
  const portalRoot = view?.dom.closest<HTMLElement>('.macos-ai-app.zeus-shell') ?? view?.dom.ownerDocument.body ?? document.body;

  return (
    <>
      <SourceCodePreview
        blame={props.blame}
        path={props.path}
        content={props.content}
        language={props.language}
        label={props.label}
        projectId={props.projectId}
        conversationId={props.conversationId}
        resourceId={props.resourceId}
        blameLines={props.blameLines}
        locale={props.locale}
        searchRequest={props.searchRequest}
        location={props.location}
        widgets={widgets}
        highlights={highlights}
        focusWidget={activeLineComment ? widgets.find((widget) => widget.line === activeLineComment.position.line)?.element : undefined}
        commentLabel={commentLabel}
        onView={setView}
      />
      {widgets.map((widget) =>
        createPortal(
          lineComments
            .filter((comment) => comment.position.line === widget.line)
            .map((comment) =>
              editingCommentId === comment.id ? (
                <CodeCommentPanel
                  key={comment.id}
                  language={props.locale}
                  position={comment.position}
                  comment={comment}
                  onCancel={() => setEditingCommentId(null)}
                  onSave={(body) => saveLineComment(body, comment.id)}
                  onDelete={() => removeComment(comment.id)}
                />
              ) : (
                <span key={comment.id} className="session-saved-code-comment">
                  <strong>{zh ? '本地评论' : 'Local comment'}</strong>
                  <span>{comment.body}</span>
                  {props.onCommentsChange ? (
                    <span className="session-saved-code-comment-actions">
                      <button type="button" onClick={() => setEditingCommentId(comment.id)}>
                        {zh ? '编辑' : 'Edit'}
                      </button>
                      <button type="button" onClick={() => removeComment(comment.id)}>
                        {zh ? '删除' : 'Delete'}
                      </button>
                    </span>
                  ) : null}
                </span>
              ),
            ),
          widget.element,
          String(widget.line),
        ),
      )}
      {createPortal(
        <>
          <MotionPresence>
            {candidate ? (
              <PopoverSurface
                ref={toolbarRef}
                popover="manual"
                className="session-selection-toolbar"
                data-placement={candidate.point.placement}
                style={{ left: candidate.point.left, top: candidate.point.top }}
                role="toolbar"
                aria-label={zh ? '选中文字操作' : 'Selected text actions'}
              >
                <button
                  type="button"
                  aria-label={zh ? '评论选中文字' : 'Comment on selected text'}
                  data-icon-tooltip={zh ? '评论' : 'Comment'}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => addSelectionComment(candidate.position)}
                >
                  <ChatTeardropDots aria-hidden="true" weight="regular" />
                </button>
              </PopoverSurface>
            ) : null}
          </MotionPresence>
          {markers.map(({ comment, index, rect }) => (
            <button
              data-icon-tooltip={zh ? `打开第 ${index + 1} 条文件评论` : `Open file comment ${index + 1}`}
              type="button"
              key={comment.id}
              className="session-response-annotation-marker session-source-annotation-marker"
              style={{ left: rect.right, top: rect.top }}
              aria-label={zh ? `打开第 ${index + 1} 条文件评论` : `Open file comment ${index + 1}`}
              aria-expanded={props.onCommentsChange ? editingCommentId === comment.id : undefined}
              disabled={!props.onCommentsChange}
              onClick={() => props.onCommentsChange && setEditingCommentId(comment.id)}
            >
              {index + 1}
            </button>
          ))}
          <MotionPresence>
            {editingSelectionComment && editorPoint ? (
              <SelectionCommentEditor
                editorRef={editorRef}
                id={editingSelectionComment.id}
                note={editingSelectionComment.body}
                point={editorPoint}
                language={props.locale}
                label={zh ? '文件评论' : 'File comment'}
                onClose={() => setEditingCommentId(null)}
                onUpdate={updateComment}
                onRemove={removeComment}
              />
            ) : null}
          </MotionPresence>
        </>,
        portalRoot,
      )}
    </>
  );
}

/** 判断评论是否带有完整、可读取的文件文字锚点。 */
function isTextAnchoredPosition(position: ConversationCodeCommentPosition): position is TextAnchoredCodePosition {
  return Number.isFinite(position.startOffset) && Number.isFinite(position.endOffset) && typeof position.selectedText === 'string' && position.startOffset! >= 0 && position.endOffset! > position.startOffset!;
}

/** 把带完整文字锚点的评论收窄为可定位类型。 */
function isTextAnchoredComment(comment: ConversationCodeComment): comment is TextAnchoredCodeComment {
  return isTextAnchoredPosition(comment.position);
}

/** 文件内容变化后不猜测新位置，只有原文仍匹配时才显示锚点。 */
function textAnchorMatchesContent(position: TextAnchoredCodePosition, content: string): boolean {
  return position.endOffset <= content.length && content.slice(position.startOffset, position.endOffset) === position.selectedText;
}

/** 计算代码视图与应用视口的可见交集。 */
function sourceOverlayBounds(view: EditorView | null): SelectionOverlayBounds {
  /** 未挂载时返回空边界，不显示任何浮层。 */
  if (!view) return { left: 0, right: 0, top: 0, bottom: 0 };
  /** 代码根节点会随分栏调整，不能只使用全局视口。 */
  const rect = view.dom.getBoundingClientRect();
  const window = view.dom.ownerDocument.defaultView;
  return {
    left: Math.max(0, rect.left),
    right: Math.min(window?.innerWidth ?? rect.right, rect.right),
    top: Math.max(0, rect.top),
    bottom: Math.min(window?.innerHeight ?? rect.bottom, rect.bottom),
  };
}

/** 评论入口贴近鼠标松手点，并按按钮真实尺寸限制在代码区。 */
function sourceSelectionToolbarPoint(pointer: SourceSelectionCandidate['pointer'], bounds: SelectionOverlayBounds, toolbar: HTMLElement | null): SourceSelectionCandidate['point'] {
  /** 浮层挂载前尺寸为零，布局阶段会立即校正。 */
  const width = toolbar?.offsetWidth ?? 0;
  /** 浮层高度用于判断选区上方是否可放置。 */
  const height = toolbar?.offsetHeight ?? 0;
  /** 评论入口与松手位置之间保留轻量间距。 */
  const gap = 6;
  /** 鼠标允许在正文外松开，但入口必须留在当前代码区。 */
  const left = Math.max(bounds.left, Math.min(pointer.left, bounds.right));
  /** 垂直位置同样限制在可见代码区。 */
  const top = Math.max(bounds.top, Math.min(pointer.top, bounds.bottom));
  /** 上方空间不足时放到选区下方。 */
  const placement = top - bounds.top >= height + gap ? 'above' : 'below';
  return {
    left: Math.max(bounds.left, Math.min(left + gap, bounds.right - width)),
    top: placement === 'above' ? top - gap : Math.min(top + gap, bounds.bottom - height),
    placement,
  };
}

/** 从 CodeMirror 文档偏移读取评论选区末端的视口坐标。 */
function sourceCommentRect(view: EditorView, position: TextAnchoredCodePosition): SourceCommentRect | null {
  if (position.endOffset > view.state.doc.length) return null;
  return view.coordsAtPos(position.endOffset, -1);
}

/** 检查评论标记或编辑锚点是否完整落在代码可见范围内。 */
function markerAnchorFitsBounds(rect: SourceCommentRect, bounds: SelectionOverlayBounds, markerSize: number): boolean {
  /** 标记沿用会话样式向右下偏移，因此检查时预留相同空间。 */
  const left = rect.right + 5;
  /** 标记向上偏移五像素。 */
  const top = rect.top - 5;
  return left >= bounds.left && left + markerSize <= bounds.right && top >= bounds.top && rect.bottom <= bounds.bottom && top + markerSize <= bounds.bottom;
}
