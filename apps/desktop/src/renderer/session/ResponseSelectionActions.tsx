import { MotionPresence, PopoverSurface } from '../ui/MotionPresence.js';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon as Check } from '@phosphor-icons/react/dist/csr/Check';
import { SlidersHorizontalIcon as SlidersHorizontal } from '@phosphor-icons/react/dist/csr/SlidersHorizontal';
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
    if (!candidate || !toolbarRef.current) return;
    toolbarRef.current.showPopover();
    /** 浮层挂载后用实际尺寸校正边界，兼容中英文按钮宽度。 */
    const article = props.articleRef.current;
    const view = article?.ownerDocument.defaultView;
    const selection = view?.getSelection();
    if (!article || !selection?.rangeCount) return;
    const point = selectionToolbarPoint(selection.getRangeAt(0).getBoundingClientRect(), article, view ?? null, toolbarRef.current);
    if (point && (point.left !== candidate.point.left || point.top !== candidate.point.top || point.placement !== candidate.point.placement)) setCandidate({ ...candidate, point });
  }, [candidate, props.articleRef]);

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
        const point = selectionToolbarPoint(rect, article, article.ownerDocument.defaultView ?? null, toolbarRef.current);
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
        const selectedRange = selection.getRangeAt(0);
        if (!root.contains(selectedRange.startContainer) || !root.contains(selectedRange.endContainer) || selectedRange.toString() !== current.anchor.selectedText) return null;
        /** 原生选区提供滚动及换行后的实际位置，越界时仍关闭入口。 */
        const point = selectionToolbarPoint(selectedRange.getBoundingClientRect(), article, view, toolbarRef.current);
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
              {props.language === 'zh-CN' ? '评论' : 'Comment'}
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
          {index + 1}
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

/** 回答批注沿用浏览器的胶囊编辑框，次要操作收进调整面板。 */
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
  /** 本地编辑内容在确认后写入会话草稿。 */
  const [note, setNote] = useState(props.annotation?.note ?? '');
  /** 调整面板保留删除和取消，默认只展示输入与确认。 */
  const [optionsOpen, setOptionsOpen] = useState(false);
  /** 多行文字按实际内容增长，避免固定大输入框。 */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    /** 先恢复单行高度，再测量换行后的实际内容。 */
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '28px';
    textarea.style.height = `${Math.min(112, textarea.scrollHeight)}px`;
  }, [note]);
  useEffect(() => setNote(props.annotation?.note ?? ''), [props.annotation?.id, props.annotation?.note]);
  /** 操作文案与会话语言一致。 */
  const zh = props.language === 'zh-CN';
  return (
    <PopoverSurface
      ref={props.editorRef}
      popover="manual"
      className="session-response-annotation-editor"
      data-placement={props.point.placement}
      data-expanded={optionsOpen || note.includes('\n') || undefined}
      style={{ left: props.point.left, top: props.point.top, width: props.point.width, maxHeight: props.point.maxHeight }}
      aria-label={zh ? '回答批注' : 'Response annotation'}
    >
      <div className="session-response-annotation-row">
        <button type="button" aria-label={zh ? '批注选项' : 'Annotation options'} aria-expanded={optionsOpen} onClick={() => setOptionsOpen((open) => !open)}>
          <SlidersHorizontal aria-hidden="true" />
        </button>
        <textarea ref={textareaRef} autoFocus rows={1} value={note} aria-label={zh ? '批注内容' : 'Annotation text'} placeholder={zh ? '添加可选评论…' : 'Add an optional comment…'} onChange={(event) => setNote(event.currentTarget.value)} />
        <button
          type="button"
          className="session-response-annotation-save"
          aria-label={zh ? '完成批注' : 'Save annotation'}
          onClick={() => {
            props.onUpdate?.(props.annotation.id, note);
            props.onClose();
          }}
        >
          <Check aria-hidden="true" weight="bold" />
        </button>
      </div>
      {optionsOpen ? (
        <div className="session-response-annotation-options">
          <button
            type="button"
            onClick={() => {
              props.onRemove?.(props.annotation.id);
              props.onClose();
            }}
          >
            {zh ? '删除批注' : 'Delete annotation'}
          </button>
          <button type="button" onClick={props.onClose}>
            {zh ? '取消' : 'Cancel'}
          </button>
        </div>
      ) : null}
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

/** 评论入口右对齐选区，按实际尺寸避开会话边界。 */
function selectionToolbarPoint(rect: DOMRect, article: HTMLElement, view: Window | null, toolbar: HTMLElement | null): SelectionCandidate['point'] | null {
  /** 会话可见范围同时约束短选区和窄分栏。 */
  const bounds = visibleOverlayBounds(article, view);
  if (!rectFitsVisibleBounds(rect, bounds)) return null;
  /** 首次挂载前尺寸为零，布局阶段会在绘制前校正。 */
  const width = toolbar?.offsetWidth ?? 0;
  const height = toolbar?.offsetHeight ?? 0;
  /** 浮层与选区间保留轻量间隔，顶部放不下时移到下方。 */
  const gap = 6;
  const placement = rect.top - bounds.top >= height + gap ? 'above' : 'below';
  return {
    left: Math.min(bounds.right, Math.max(rect.right, bounds.left + width)),
    top: placement === 'above' ? rect.top - gap : rect.bottom + gap,
    placement,
  };
}

/** 编辑框贴住标记下方，右侧空间不足时只做边界夹紧，不跳到另一侧。 */
function annotationEditorPoint(rect: DOMRect, view: Window | null, overlayBounds: OverlayBounds, editorHeight: number): AnnotationEditorPoint {
  const viewportWidth = view?.innerWidth ?? 380;
  const margin = 12;
  const gap = 10;
  const availableWidth = Math.max(1, overlayBounds.right - overlayBounds.left - margin * 2);
  const editorWidth = Math.min(296, viewportWidth - margin * 2, availableWidth);
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
