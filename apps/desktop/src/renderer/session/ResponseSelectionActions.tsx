import { type RefObject, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationResponseAnnotation, ConversationResponseTextAnchor } from '@zeus/shared';
import type { SessionUiLanguage } from './ThreadItemView.js';

interface SelectionCandidate {
  anchor: ConversationResponseTextAnchor;
  point: { left: number; top: number; placement: 'above' | 'below' };
}

export function ResponseSelectionActions(props: {
  articleRef: RefObject<HTMLElement | null>;
  itemId: string;
  enabled: boolean;
  language: SessionUiLanguage;
  annotations: ConversationResponseAnnotation[];
  onAddAnnotation?: (anchor: ConversationResponseTextAnchor) => string;
  onUpdateAnnotation?: (id: string, note: string) => void;
  onRemoveAnnotation?: (id: string) => void;
  onOpenSideChat?: (selectedText: string) => void;
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
        setCandidate({
          anchor: { itemId: props.itemId, startOffset, endOffset, selectedText },
          point: {
            left: Math.min(Math.max(rect.left + rect.width / 2, 190), Math.max(190, (article.ownerDocument.defaultView?.innerWidth ?? 380) - 190)),
            top: rect.top >= 64 ? rect.top : rect.bottom + 12,
            placement: rect.top >= 64 ? 'above' : 'below',
          },
        });
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
    const update = () => setRevision((value) => value + 1);
    view.addEventListener('resize', update);
    view.addEventListener('scroll', update, true);
    return () => {
      view.removeEventListener('resize', update);
      view.removeEventListener('scroll', update, true);
    };
  }, [props.articleRef]);

  if (!props.enabled) return null;
  const root = props.articleRef.current?.querySelector<HTMLElement>('.session-markdown') ?? null;
  const markers = root
    ? props.annotations.flatMap((annotation, index) => {
        const range = rangeFromOffsets(root, annotation.anchor.startOffset, annotation.anchor.endOffset);
        const rect = range?.getBoundingClientRect();
        return rect && rect.width > 0 ? [{ annotation, index, left: rect.right, top: rect.top }] : [];
      })
    : [];
  void revision;
  const portalRoot = props.articleRef.current?.closest<HTMLElement>('.session-codex-parity-v1') ?? props.articleRef.current?.ownerDocument.body ?? document.body;

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
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              props.onOpenSideChat?.(candidate.anchor.selectedText);
              setCandidate(null);
            }}
          >
            {props.language === 'zh-CN' ? '在侧边聊天中提问' : 'Ask in side chat'}
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
      {editingId ? (
        <ResponseAnnotationEditor
          annotation={props.annotations.find((annotation) => annotation.id === editingId) ?? null}
          language={props.language}
          onClose={() => setEditingId(null)}
          onUpdate={props.onUpdateAnnotation}
          onRemove={props.onRemoveAnnotation}
        />
      ) : null}
    </>,
    portalRoot,
  );
}

function ResponseAnnotationEditor(props: { annotation: ConversationResponseAnnotation | null; language: SessionUiLanguage; onClose: () => void; onUpdate?: (id: string, note: string) => void; onRemove?: (id: string) => void }) {
  const [note, setNote] = useState(props.annotation?.note ?? '');
  useEffect(() => setNote(props.annotation?.note ?? ''), [props.annotation?.id, props.annotation?.note]);
  if (!props.annotation) return null;
  const zh = props.language === 'zh-CN';
  return (
    <section className="session-response-annotation-editor" aria-label={zh ? '选区注释' : 'Selection annotation'}>
      <header>
        <strong>{zh ? '本地注释' : 'Local annotation'}</strong>
        <button type="button" onClick={props.onClose} aria-label={zh ? '关闭' : 'Close'}>
          ×
        </button>
      </header>
      <textarea autoFocus value={note} placeholder={zh ? '添加评论…' : 'Add a comment…'} onChange={(event) => setNote(event.currentTarget.value)} />
      <footer>
        <button
          type="button"
          onClick={() => {
            props.onRemove?.(props.annotation!.id);
            props.onClose();
          }}
        >
          {zh ? '删除' : 'Delete'}
        </button>
        <button
          type="button"
          onClick={() => {
            props.onUpdate?.(props.annotation!.id, note);
            props.onClose();
          }}
        >
          {zh ? '完成' : 'Done'}
        </button>
      </footer>
    </section>
  );
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
