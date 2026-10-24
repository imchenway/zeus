import { MotionPresence, PopoverSurface } from '../ui/MotionPresence.js';
import { SidebarSimpleIcon as SidebarSimple } from '@phosphor-icons/react/dist/csr/SidebarSimple';
import { ChatTeardropDotsIcon as ChatTeardropDots } from '@phosphor-icons/react/dist/csr/ChatTeardropDots';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationResponseAnnotation, ConversationResponseTextAnchor } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { SelectionCommentEditor, selectionCommentEditorPoint, type SelectionOverlayBounds } from './SelectionCommentEditor.js';

/** 评论入口保存松手点与选择终点的相对位置，布局变化后仍跟随原文。 */
interface SelectionCandidate {
  anchor: ConversationResponseTextAnchor;
  /** 鼠标松手点相对选择终点的偏移，支持正向与反向跨行选择。 */
  pointerOffset: { left: number; top: number };
  point: { left: number; top: number; placement: 'above' | 'below' };
}

/** 标记尺寸与样式保持一致。 */
const ANNOTATION_MARKER_SIZE = 24;
/** 标记放在选中文字末尾右侧。 */
const ANNOTATION_MARKER_INLINE_OFFSET = 5;
/** 标记略高于文字，减少对下一行的遮挡。 */
const ANNOTATION_MARKER_BLOCK_OFFSET = -5;

/** 回答正文共用选区评论入口、定位标记和草稿编辑框。 */
export function ResponseSelectionActions(props: {
  articleRef: RefObject<HTMLElement | null>;
  itemId: string;
  enabled: boolean;
  language: SessionUiLanguage;
  annotations: ConversationResponseAnnotation[];
  /** 在右侧会话中暂存同一段原文，点击本身不发送。 */
  onAskInSidebar?: (anchor: ConversationResponseTextAnchor) => void;
  onAddAnnotation?: (anchor: ConversationResponseTextAnchor) => string;
  onUpdateAnnotation?: (id: string, note: string) => void;
  onRemoveAnnotation?: (id: string) => void;
}) {
  const [candidate, setCandidate] = useState<SelectionCandidate | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  /** 原生浮层保留主题继承，同时绕开会话祖先的位移与裁剪。 */
  const toolbarRef = useRef<HTMLDivElement>(null);
  /** 位置使用真实编辑框高度，不以固定高度猜测上下可用空间。 */
  const editorRef = useRef<HTMLDivElement>(null);
  /** 未挂载时暂为零，布局阶段会在绘制前补上真实尺寸。 */
  const [editorHeight, setEditorHeight] = useState(0);

  useLayoutEffect(() => {
    if (!candidate || !toolbarRef.current) return;
    toolbarRef.current.showPopover();
    /** 浮层挂载后用实际尺寸校正边界，兼容中英文按钮宽度。 */
    const article = props.articleRef.current;
    const view = article?.ownerDocument.defaultView;
    const selection = view?.getSelection();
    if (!article || !selection?.rangeCount) return;
    /** 首次校正和后续布局刷新使用相同的正文边界。 */
    const root = article.querySelector<HTMLElement>('.session-markdown');
    /** 只测量当前回答中的有效选区。 */
    const range = root ? selectedResponseRange(root, selection) : null;
    const point = range ? selectionToolbarPoint(selection, range, candidate.pointerOffset, article, view ?? null, toolbarRef.current) : null;
    if (point && (point.left !== candidate.point.left || point.top !== candidate.point.top || point.placement !== candidate.point.placement)) setCandidate({ ...candidate, point });
  }, [candidate, props.articleRef]);

  useEffect(() => {
    const article = props.articleRef.current;
    if (!article || !props.enabled) return;
    /** 只处理从当前回答开始的拖选，允许在正文外松开。 */
    let selecting = false;
    /** 松手后读取最终选区，避免浏览器尚未完成原生选择。 */
    const updateCandidate = (event: PointerEvent) => {
      if (!selecting) return;
      selecting = false;
      requestAnimationFrame(() => {
        const root = article.querySelector<HTMLElement>('.session-markdown');
        const selection = article.ownerDocument.defaultView?.getSelection();
        /** 跨出正文时只引用当前回答，不能带入相邻消息和操作按钮。 */
        const range = root ? selectedResponseRange(root, selection ?? null) : null;
        if (!root || !selection || !range) {
          setCandidate(null);
          return;
        }
        const selectedText = range.toString();
        if (!selectedText.trim() || selectedText.length > 20_000) {
          setCandidate(null);
          return;
        }
        const startOffset = textOffset(root, range.startContainer, range.startOffset);
        const endOffset = textOffset(root, range.endContainer, range.endOffset);
        const rect = range.getBoundingClientRect();
        if (startOffset === null || endOffset === null || endOffset <= startOffset || rect.width === 0) {
          setCandidate(null);
          return;
        }
        /** 选择终点由原生 Selection 决定，反向拖选不误用选区末尾。 */
        const focusPoint = selectionFocusPoint(selection, range);
        if (!focusPoint) {
          setCandidate(null);
          return;
        }
        /** 首次定位使用真实松手坐标，后续刷新保留与原文的距离。 */
        const pointerOffset = { left: event.clientX - focusPoint.left, top: event.clientY - focusPoint.top };
        const point = selectionToolbarPoint(selection, range, pointerOffset, article, article.ownerDocument.defaultView ?? null, toolbarRef.current);
        setCandidate(point ? { anchor: { itemId: props.itemId, startOffset, endOffset, selectedText }, pointerOffset, point } : null);
      });
    };
    /** 记录选择起点，操作浮层时不重新生成评论入口。 */
    const clearOnPointerDown = (event: PointerEvent) => {
      selecting = false;
      if ((event.target as Element | null)?.closest?.('.session-selection-toolbar, .session-response-annotation-marker, .session-response-annotation-editor')) return;
      selecting = article.querySelector('.session-markdown')?.contains(event.target as Node) ?? false;
      setCandidate(null);
    };
    article.ownerDocument.addEventListener('pointerup', updateCandidate, true);
    article.ownerDocument.addEventListener('pointerdown', clearOnPointerDown, true);
    return () => {
      article.ownerDocument.removeEventListener('pointerup', updateCandidate, true);
      article.ownerDocument.removeEventListener('pointerdown', clearOnPointerDown, true);
    };
  }, [props.articleRef, props.enabled, props.itemId]);

  // 正文引用属于父节点，提交完成后再绑定，避免子组件布局阶段仍读到空引用。
  useEffect(() => {
    const article = props.articleRef.current;
    const view = article?.ownerDocument.defaultView;
    const transcript = article?.closest<HTMLElement>('.session-transcript');
    if (!article || !view) return;
    /** 布局通知只刷新仍有效的选区，避免浮层出现后的自动滚动把入口立即清掉。 */
    const update = () => {
      setCandidate((current) => {
        if (!current) return null;
        /** 已取消或更换的选区不能继续使用上一次批注入口。 */
        const selection = view.getSelection();
        /** 正文节点只从当前回答读取，避免跨消息复用入口。 */
        const root = article.querySelector<HTMLElement>('.session-markdown');
        if (!root || !selection?.rangeCount || selection.isCollapsed) return null;
        /** 文字相同也必须属于当前回答，不能跟随另一条消息的选区。 */
        const selectedRange = selectedResponseRange(root, selection);
        if (!selectedRange || selectedRange.toString() !== current.anchor.selectedText) return null;
        /** 原生选区提供滚动及换行后的实际位置，越界时仍关闭入口。 */
        const point = selectionToolbarPoint(selection, selectedRange, current.pointerOffset, article, view, toolbarRef.current);
        return point ? { ...current, point } : null;
      });
      setRevision((value) => value + 1);
    };
    view.addEventListener('resize', update);
    transcript?.addEventListener('scroll', update, { passive: true });
    /** 分栏宽度与正文换行同样会改变选区位置。 */
    const observer = new ResizeObserver(update);
    if (article) observer.observe(article);
    if (transcript) observer.observe(transcript);
    update();
    return () => {
      view.removeEventListener('resize', update);
      transcript?.removeEventListener('scroll', update);
      observer.disconnect();
    };
  }, [props.articleRef, props.itemId]);

  useLayoutEffect(() => {
    /** 编辑、换行或调整输入框高度后沿用相同尺寸通知。 */
    const editor = editorRef.current;
    if (!editor) return;
    // 进入浏览器顶层后固定定位才真正以视口为原点，输入焦点也不会滚动正文。
    if (!editor.matches(':popover-open')) {
      editor.showPopover();
      editor.querySelector('textarea')?.focus({ preventScroll: true });
    }
    /** 布局尺寸不受浮层进出动画的缩放影响。 */
    const update = () => setEditorHeight(editor.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(editor);
    return () => observer.disconnect();
  }, [editingId, revision]);

  if (!props.enabled) return null;
  const article = props.articleRef.current;
  const root = article?.querySelector<HTMLElement>('.session-markdown') ?? null;
  const view = article?.ownerDocument.defaultView ?? null;
  const transcript = article?.closest<HTMLElement>('.session-transcript') ?? null;
  const transcriptRect = transcript?.getBoundingClientRect() ?? null;
  const overlayBounds = visibleOverlayBounds(article, view);
  const markers =
    root && transcript && transcriptRect
      ? props.annotations.flatMap((annotation, index) => {
          const range = rangeFromOffsets(root, annotation.anchor.startOffset, annotation.anchor.endOffset);
          const rect = range ? rangeEndRect(range) : null;
          return rect && rect.width > 0 && markerFitsVisibleBounds(rect, overlayBounds)
            ? [{ annotation, index, left: rect.right - transcriptRect.left + transcript.scrollLeft, top: rect.top - transcriptRect.top + transcript.scrollTop }]
            : [];
        })
      : [];
  const editingAnnotation = props.annotations.find((annotation) => annotation.id === editingId) ?? null;
  const editingRange = root && editingAnnotation ? rangeFromOffsets(root, editingAnnotation.anchor.startOffset, editingAnnotation.anchor.endOffset) : null;
  const editingRect = editingRange ? rangeEndRect(editingRange) : null;
  // 标记必须留在会话可见区，编辑浮层则可利用整个视口的上下空间。
  const editorPoint = editingRect && rectFitsVisibleBounds(editingRect, overlayBounds) ? selectionCommentEditorPoint(editingRect, view, { ...overlayBounds, top: 0, bottom: view?.innerHeight ?? overlayBounds.bottom }, editorHeight) : null;
  void revision;
  const portalRoot = transcript ?? article?.closest<HTMLElement>('.session-codex-parity-v1') ?? article?.ownerDocument.body ?? document.body;

  return createPortal(
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
            aria-label={props.language === 'zh-CN' ? '选中文字操作' : 'Selected text actions'}
          >
            <button
              type="button"
              disabled={!props.onAddAnnotation}
              aria-label={props.language === 'zh-CN' ? '评论选中文字' : 'Comment on selected text'}
              data-icon-tooltip={props.language === 'zh-CN' ? '评论' : 'Comment'}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                const id = props.onAddAnnotation?.(candidate.anchor);
                setCandidate(null);
                if (id) setEditingId(id);
              }}
            >
              <ChatTeardropDots aria-hidden="true" weight="regular" />
            </button>
            {props.onAskInSidebar ? (
              <button
                type="button"
                aria-label={props.language === 'zh-CN' ? '在侧边栏提问' : 'Ask in sidebar'}
                data-icon-tooltip={props.language === 'zh-CN' ? '在侧边栏提问' : 'Ask in sidebar'}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => {
                  props.onAskInSidebar?.(candidate.anchor);
                  setCandidate(null);
                  view?.getSelection()?.removeAllRanges();
                }}
              >
                <SidebarSimple aria-hidden="true" />
              </button>
            ) : null}
          </PopoverSurface>
        ) : null}
      </MotionPresence>
      {markers.map(({ annotation, index, left, top }) => (
        <button
          data-icon-tooltip={props.language === 'zh-CN' ? `打开第 ${index + 1} 条评论` : `Open comment ${index + 1}`}
          type="button"
          key={annotation.id}
          className="session-response-annotation-marker"
          style={{ left, top }}
          aria-label={props.language === 'zh-CN' ? `打开第 ${index + 1} 条评论` : `Open comment ${index + 1}`}
          aria-expanded={editingId === annotation.id}
          onClick={() => setEditingId(annotation.id)}
        >
          {index + 1}
        </button>
      ))}
      <MotionPresence>
        {editingAnnotation && editorPoint ? (
          <SelectionCommentEditor
            editorRef={editorRef}
            id={editingAnnotation.id}
            note={editingAnnotation.note}
            point={editorPoint}
            language={props.language}
            label={props.language === 'zh-CN' ? '回答评论' : 'Response comment'}
            onClose={() => setEditingId(null)}
            onUpdate={props.onUpdateAnnotation}
            onRemove={props.onRemoveAnnotation}
          />
        ) : null}
      </MotionPresence>
    </>,
    portalRoot,
  );
}

function rangeEndRect(range: Range): DOMRect | null {
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0);
  return (
    rects.at(-1) ??
    (() => {
      const rect = range.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? rect : null;
    })()
  );
}

/** 选区裁到当前回答，保留跨出正文时仍有效的文字。 */
function selectedResponseRange(root: HTMLElement, selection: Selection | null): Range | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  /** 副本只用于读取，不改变用户的原生选区。 */
  const range = selection.getRangeAt(0).cloneRange();
  if (!range.intersectsNode(root)) return null;
  /** 正文边界同时排除回答之外的标题、操作和相邻消息。 */
  const contentRange = root.ownerDocument.createRange();
  contentRange.selectNodeContents(root);
  if (range.compareBoundaryPoints(Range.START_TO_START, contentRange) < 0) range.setStart(contentRange.startContainer, contentRange.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, contentRange) > 0) range.setEnd(contentRange.endContainer, contentRange.endOffset);
  return range.collapsed ? null : range;
}

/** 原生光标给出拖选方向；定位使用裁到正文后的对应端。 */
function selectionFocusPoint(selection: Selection, range: Range): SelectionCandidate['pointerOffset'] | null {
  /** 原生选区按文档顺序保存，focus 才代表用户结束选择的一端。 */
  const selectedRange = selection.getRangeAt(0);
  /** 反向选择的终点在选区开头。 */
  const backward = selection.focusNode === selectedRange.startContainer && selection.focusOffset === selectedRange.startOffset;
  /** 折叠副本读取光标位置，不改变用户选区。 */
  const focusRange = range.cloneRange();
  focusRange.collapse(backward);
  /** 文字节点优先使用真实光标；元素边界回退到首尾可见文字片段。 */
  const caret = focusRange.getBoundingClientRect();
  const rect = caret.height > 0 ? caret : backward ? Array.from(range.getClientRects()).find((fragment) => fragment.width > 0 && fragment.height > 0) : rangeEndRect(range);
  return rect ? { left: caret.height > 0 || backward ? rect.left : rect.right, top: rect.top } : null;
}

/** 评论入口放在鼠标松手点右上方，按实际尺寸避开会话边界。 */
function selectionToolbarPoint(selection: Selection, range: Range, pointerOffset: SelectionCandidate['pointerOffset'], article: HTMLElement, view: Window | null, toolbar: HTMLElement | null): SelectionCandidate['point'] | null {
  /** 会话可见范围同时约束短选区和窄分栏。 */
  const bounds = visibleOverlayBounds(article, view);
  /** 布局刷新只重算原文终点，鼠标与终点的相对距离保持不变。 */
  const focusPoint = selectionFocusPoint(selection, range);
  if (!focusPoint) return null;
  /** 原文完全离开可见范围时关闭入口；松手点越界时仍保留有效选区。 */
  const rect = range.getBoundingClientRect();
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top || rect.bottom <= bounds.top || rect.top >= bounds.bottom || rect.right <= bounds.left || rect.left >= bounds.right) return null;
  /** 松手点夹紧到会话边界，不能因鼠标离开正文而丢掉评论。 */
  const left = Math.max(bounds.left, Math.min(focusPoint.left + pointerOffset.left, bounds.right));
  /** 垂直越界同样回到当前可见区域。 */
  const top = Math.max(bounds.top, Math.min(focusPoint.top + pointerOffset.top, bounds.bottom));
  /** 首次挂载前尺寸为零，布局阶段会在绘制前校正。 */
  const width = toolbar?.offsetWidth ?? 0;
  const height = toolbar?.offsetHeight ?? 0;
  /** 浮层与选区间保留轻量间隔，顶部放不下时移到下方。 */
  const gap = 6;
  const placement = top - bounds.top >= height + gap ? 'above' : 'below';
  return {
    left: Math.max(bounds.left, Math.min(left + gap, bounds.right - width)),
    top: placement === 'above' ? top - gap : Math.min(top + gap, bounds.bottom - height),
    placement,
  };
}

/** 取得回答在会话滚动区和视口共同形成的可见边界。 */
function visibleOverlayBounds(article: HTMLElement | null, view: Window | null): SelectionOverlayBounds {
  const viewport = {
    left: 0,
    right: view?.innerWidth ?? 380,
    top: 0,
    bottom: view?.innerHeight ?? 640,
  };
  const transcript = article?.closest<HTMLElement>('.session-transcript');
  if (!transcript) return viewport;
  const rect = transcript.getBoundingClientRect();
  return {
    left: Math.max(viewport.left, rect.left),
    right: Math.min(viewport.right, rect.right),
    top: Math.max(viewport.top, rect.top),
    bottom: Math.min(viewport.bottom, rect.bottom),
  };
}

/** 只有完整可见的选区末端才显示评论编辑框。 */
function rectFitsVisibleBounds(rect: DOMRect, bounds: SelectionOverlayBounds): boolean {
  return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
}

/** 只有标记完整落在可见范围内时才显示。 */
function markerFitsVisibleBounds(rect: DOMRect, bounds: SelectionOverlayBounds): boolean {
  const markerLeft = rect.right + ANNOTATION_MARKER_INLINE_OFFSET;
  const markerTop = rect.top + ANNOTATION_MARKER_BLOCK_OFFSET;
  return markerLeft >= bounds.left && markerLeft + ANNOTATION_MARKER_SIZE <= bounds.right && markerTop >= bounds.top && markerTop + ANNOTATION_MARKER_SIZE <= bounds.bottom;
}

function textOffset(root: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function rangeFromOffsets(root: HTMLElement, start: number, end: number): Range | null {
  const walker = root.ownerDocument.createTreeWalker(root, root.ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4);
  let current = walker.nextNode();
  let offset = 0;
  let startPoint: { node: Node; offset: number } | null = null;
  let endPoint: { node: Node; offset: number } | null = null;
  while (current) {
    const length = current.textContent?.length ?? 0;
    if (!startPoint && start <= offset + length) startPoint = { node: current, offset: Math.max(0, start - offset) };
    if (end <= offset + length) {
      endPoint = { node: current, offset: Math.max(0, end - offset) };
      break;
    }
    offset += length;
    current = walker.nextNode();
  }
  if (!startPoint || !endPoint) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(startPoint.node, startPoint.offset);
  range.setEnd(endPoint.node, endPoint.offset);
  return range;
}
