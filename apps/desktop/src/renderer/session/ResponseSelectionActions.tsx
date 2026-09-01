import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationResponseAnnotation, ConversationResponseTextAnchor } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';

interface SelectionCandidate {
  anchor: ConversationResponseTextAnchor;
  point: { left: number; top: number; placement: 'above' | 'below' };
}

interface AnnotationEditorPoint {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

interface OverlayBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const ANNOTATION_MARKER_SIZE = 26;
const ANNOTATION_MARKER_INLINE_OFFSET = 7;
const ANNOTATION_MARKER_BLOCK_OFFSET = -7;

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

  useLayoutEffect(() => {
    const view = props.articleRef.current?.ownerDocument.defaultView;
    if (!view) return;
    const update = () => {
      // 选区工具条只服务当前静止选区；滚动或窗口变化后关闭，避免悬浮在已经离开的文字上。
      setCandidate(null);
      setRevision((value) => value + 1);
    };
    view.addEventListener('resize', update);
    view.addEventListener('scroll', update, true);
    return () => {
      view.removeEventListener('resize', update);
      view.removeEventListener('scroll', update, true);
    };
  }, [props.articleRef]);

  if (!props.enabled) return null;
  const article = props.articleRef.current;
  const root = article?.querySelector<HTMLElement>('.session-markdown') ?? null;
  const view = article?.ownerDocument.defaultView ?? null;
  const overlayBounds = visibleOverlayBounds(article, view);
  const markers = root
    ? props.annotations.flatMap((annotation, index) => {
        const range = rangeFromOffsets(root, annotation.anchor.startOffset, annotation.anchor.endOffset);
        const rect = range ? rangeEndRect(range) : null;
        return rect && rect.width > 0 && markerFitsVisibleBounds(rect, overlayBounds) ? [{ annotation, index, left: rect.right, top: rect.top }] : [];
      })
    : [];
  const editingAnnotation = props.annotations.find((annotation) => annotation.id === editingId) ?? null;
  const editingRange = root && editingAnnotation ? rangeFromOffsets(root, editingAnnotation.anchor.startOffset, editingAnnotation.anchor.endOffset) : null;
  const editingRect = editingRange ? rangeEndRect(editingRange) : null;
  const editorPoint = editingRect && rectFitsVisibleBounds(editingRect, overlayBounds) ? annotationEditorPoint(editingRect, view, overlayBounds) : null;
  void revision;
  const portalRoot = article?.closest<HTMLElement>('.session-codex-parity-v1') ?? article?.ownerDocument.body ?? document.body;

  return createPortal(
    <>
      {candidate ? (
        <div
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
        </div>
      ) : null}
      {markers.map(({ annotation, index, left, top }) => (
        <button
          type="button"
          key={annotation.id}
          className="session-response-annotation-marker"
          style={{ left, top }}
          aria-label={props.language === 'zh-CN' ? `打开第 ${index + 1} 条注释` : `Open annotation ${index + 1}`}
          onClick={() => setEditingId(annotation.id)}
        >
          {index + 1}
        </button>
      ))}
      {editingAnnotation && editorPoint ? (
        <ResponseAnnotationEditor annotation={editingAnnotation} point={editorPoint} language={props.language} onClose={() => setEditingId(null)} onUpdate={props.onUpdateAnnotation} onRemove={props.onRemoveAnnotation} />
      ) : null}
    </>,
    portalRoot,
  );
}

function ResponseAnnotationEditor(props: {
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
    <section className="session-response-annotation-editor" data-placement={props.point.placement} style={{ left: props.point.left, top: props.point.top }} aria-label={zh ? '回答批注' : 'Response annotation'}>
      <header>
        <strong>{zh ? '添加评论' : 'Add comment'}</strong>
        <button type="button" onClick={props.onClose} aria-label={zh ? '关闭' : 'Close'}>
          ×
        </button>
      </header>
      <blockquote title={props.annotation.anchor.selectedText}>{props.annotation.anchor.selectedText}</blockquote>
      <textarea autoFocus rows={2} value={note} placeholder={zh ? '写下评论…' : 'Write a comment…'} onChange={(event) => setNote(event.currentTarget.value)} />
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
    </section>
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

function annotationEditorPoint(rect: DOMRect, view: Window | null, overlayBounds: OverlayBounds): AnnotationEditorPoint {
  const viewportWidth = view?.innerWidth ?? 380;
  const margin = 12;
  const gap = 10;
  const availableWidth = Math.max(1, overlayBounds.right - overlayBounds.left - margin * 2);
  const editorWidth = Math.min(300, viewportWidth - margin * 2, availableWidth);
  const editorHeight = 196;
  const roomOnRight = overlayBounds.right - rect.right - margin;
  const minimumLeft = overlayBounds.left + margin;
  const maximumLeft = overlayBounds.right - editorWidth - margin;
  const left = roomOnRight >= editorWidth + gap ? rect.right + gap : Math.max(minimumLeft, Math.min(rect.right - editorWidth - gap, maximumLeft));
  const placeBelow = rect.bottom + gap + editorHeight <= overlayBounds.bottom - margin || rect.top - gap - editorHeight < overlayBounds.top + margin;
  return {
    left,
    top: placeBelow ? rect.bottom + gap : rect.top - gap,
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
