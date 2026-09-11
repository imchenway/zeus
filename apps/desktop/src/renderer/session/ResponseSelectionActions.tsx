import { MotionPresence, PopoverSurface } from '../ui/MotionPresence.js';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatCircleTextIcon as ChatCircleText } from '@phosphor-icons/react/dist/csr/ChatCircleText';
import type { ConversationResponseAnnotation, ConversationResponseTextAnchor } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';

interface SelectionCandidate {
  anchor: ConversationResponseTextAnchor;
  point: { left: number; top: number; placement: 'above' | 'below' };
}

interface AnnotationEditorPoint {
  left: number;
  top: number;
  /** 实际可用宽度同步到样式，窄分栏不沿用视口宽度。 */
  width: number;
  /** 极矮会话中允许编辑框内部滚动，操作按钮不落到裁剪区域。 */
  maxHeight: number;
  placement: 'above' | 'below';
}

interface OverlayBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 标记尺寸与样式保持一致。 */
const ANNOTATION_MARKER_SIZE = 24;
/** 标记放在选中文字末尾右侧。 */
const ANNOTATION_MARKER_INLINE_OFFSET = 5;
/** 标记略高于文字，减少对下一行的遮挡。 */
const ANNOTATION_MARKER_BLOCK_OFFSET = -5;

export function ResponseSelectionActions(props: {
  articleRef: RefObject<HTMLElement | null>;
  itemId: string;
  enabled: boolean;
  language: SessionUiLanguage;
  annotations: ConversationResponseAnnotation[];
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
    if (candidate) toolbarRef.current?.showPopover();
  }, [candidate]);

  useEffect(() => {
    const article = props.articleRef.current;
    if (!article || !props.enabled) return;
    const updateCandidate = () => {
      requestAnimationFrame(() => {
        const root = article.querySelector<HTMLElement>('.session-markdown');
        const selection = article.ownerDocument.defaultView?.getSelection();
        if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
          setCandidate(null);
          return;
        }
        const range = selection.getRangeAt(0);
        if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
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
        const point = selectionToolbarPoint(rect, article, article.ownerDocument.defaultView ?? null);
        setCandidate(point ? { anchor: { itemId: props.itemId, startOffset, endOffset, selectedText }, point } : null);
      });
    };
    const clearOnPointerDown = (event: PointerEvent) => {
      if ((event.target as Element | null)?.closest?.('.session-selection-toolbar, .session-response-annotation-marker, .session-response-annotation-editor')) return;
      if (!article.contains(event.target as Node)) setCandidate(null);
    };
    article.addEventListener('pointerup', updateCandidate);
    article.ownerDocument.addEventListener('pointerdown', clearOnPointerDown, true);
    return () => {
      article.removeEventListener('pointerup', updateCandidate);
      article.ownerDocument.removeEventListener('pointerdown', clearOnPointerDown, true);
    };
  }, [props.articleRef, props.enabled, props.itemId]);

  // 正文引用属于父节点，提交完成后再绑定，避免子组件布局阶段仍读到空引用。
  useEffect(() => {
    const article = props.articleRef.current;
    const view = article?.ownerDocument.defaultView;
    const transcript = article?.closest<HTMLElement>('.session-transcript');
    if (!view) return;
    const update = () => {
      // 选区工具条只服务当前静止选区；滚动或窗口变化后关闭，避免悬浮在已经离开的文字上。
      setCandidate(null);
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
  const editorPoint = editingRect && rectFitsVisibleBounds(editingRect, overlayBounds) ? annotationEditorPoint(editingRect, view, { ...overlayBounds, top: 0, bottom: view?.innerHeight ?? overlayBounds.bottom }, editorHeight) : null;
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
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                const id = props.onAddAnnotation?.(candidate.anchor);
                setCandidate(null);
                if (id) setEditingId(id);
              }}
            >
              {props.language === 'zh-CN' ? '添加到对话' : 'Add to chat'}
            </button>
          </PopoverSurface>
        ) : null}
      </MotionPresence>
      {markers.map(({ annotation, index, left, top }) => (
        <button
          type="button"
          key={annotation.id}
          className="session-response-annotation-marker"
          style={{ left, top }}
          aria-label={props.language === 'zh-CN' ? `打开第 ${index + 1} 条注释` : `Open annotation ${index + 1}`}
          aria-expanded={editingId === annotation.id}
          onClick={() => setEditingId(annotation.id)}
        >
          <ChatCircleText aria-hidden="true" weight="fill" />
        </button>
      ))}
      <MotionPresence>
        {editingAnnotation && editorPoint ? (
          <ResponseAnnotationEditor
            editorRef={editorRef}
            annotation={editingAnnotation}
            point={editorPoint}
            language={props.language}
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

function ResponseAnnotationEditor(props: {
  /** 供定位逻辑读取实际浮层高度。 */
  editorRef: RefObject<HTMLDivElement | null>;
  annotation: ConversationResponseAnnotation;
  point: AnnotationEditorPoint;
  language: SessionUiLanguage;
  onClose: () => void;
  onUpdate?: (id: string, note: string) => void;
  onRemove?: (id: string) => void;
}) {
  const [note, setNote] = useState(props.annotation?.note ?? '');
  useEffect(() => setNote(props.annotation?.note ?? ''), [props.annotation?.id, props.annotation?.note]);
  const zh = props.language === 'zh-CN';
  return (
    <PopoverSurface
      ref={props.editorRef}
      popover="manual"
      className="session-response-annotation-editor"
      data-placement={props.point.placement}
      style={{ left: props.point.left, top: props.point.top, width: props.point.width, maxHeight: props.point.maxHeight }}
      aria-label={zh ? '回答批注' : 'Response annotation'}
    >
      <header>
        <strong>{zh ? '添加评论' : 'Add comment'}</strong>
        <button type="button" onClick={props.onClose} aria-label={zh ? '关闭' : 'Close'}>
          ×
        </button>
      </header>
      <textarea autoFocus rows={2} value={note} placeholder={zh ? '添加可选评论…' : 'Add an optional comment…'} onChange={(event) => setNote(event.currentTarget.value)} />
      <footer>
        <button
          type="button"
          onClick={() => {
            props.onRemove?.(props.annotation.id);
            props.onClose();
          }}
        >
          {zh ? '删除' : 'Delete'}
        </button>
        <button
          type="button"
          onClick={() => {
            props.onUpdate?.(props.annotation.id, note);
            props.onClose();
          }}
        >
          {zh ? '完成' : 'Done'}
        </button>
      </footer>
    </PopoverSurface>
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

function selectionToolbarPoint(rect: DOMRect, article: HTMLElement, view: Window | null): SelectionCandidate['point'] | null {
  const bounds = visibleOverlayBounds(article, view);
  if (!rectFitsVisibleBounds(rect, bounds)) return null;
  const toolbarHalfWidth = 190;
  const roomAbove = rect.top - bounds.top;
  const placement = roomAbove >= 44 ? 'above' : 'below';
  const minimumCenter = bounds.left + toolbarHalfWidth;
  const maximumCenter = bounds.right - toolbarHalfWidth;
  const center = rect.left + rect.width / 2;
  return {
    left: maximumCenter >= minimumCenter ? Math.min(Math.max(center, minimumCenter), maximumCenter) : bounds.left + (bounds.right - bounds.left) / 2,
    top: placement === 'above' ? rect.top : rect.bottom + 12,
    placement,
  };
}

/** 编辑框贴住标记下方，右侧空间不足时只做边界夹紧，不跳到另一侧。 */
function annotationEditorPoint(rect: DOMRect, view: Window | null, overlayBounds: OverlayBounds, editorHeight: number): AnnotationEditorPoint {
  const viewportWidth = view?.innerWidth ?? 380;
  const margin = 12;
  const gap = 10;
  const availableWidth = Math.max(1, overlayBounds.right - overlayBounds.left - margin * 2);
  const editorWidth = Math.min(300, viewportWidth - margin * 2, availableWidth);
  /** 整个编辑框保留在会话可见区域内，空间不足时内部滚动。 */
  const maxHeight = Math.max(1, overlayBounds.bottom - overlayBounds.top - margin * 2);
  const minimumLeft = overlayBounds.left + margin;
  const maximumLeft = overlayBounds.right - editorWidth - margin;
  const left = Math.max(minimumLeft, Math.min(rect.right + ANNOTATION_MARKER_INLINE_OFFSET, maximumLeft));
  const placeBelow = rect.bottom + gap + editorHeight <= overlayBounds.bottom - margin || rect.top + ANNOTATION_MARKER_BLOCK_OFFSET - gap - editorHeight < overlayBounds.top + margin;
  return {
    left,
    width: editorWidth,
    maxHeight,
    top: placeBelow ? Math.max(overlayBounds.top + margin, Math.min(rect.bottom + gap, overlayBounds.bottom - margin - editorHeight)) : rect.top + ANNOTATION_MARKER_BLOCK_OFFSET - gap,
    placement: placeBelow ? 'below' : 'above',
  };
}

function visibleOverlayBounds(article: HTMLElement | null, view: Window | null): OverlayBounds {
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

function rectFitsVisibleBounds(rect: DOMRect, bounds: OverlayBounds): boolean {
  return rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
}

function markerFitsVisibleBounds(rect: DOMRect, bounds: OverlayBounds): boolean {
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
