import { type FormEvent, type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { selectionCommentIcons } from '../../preload/selectionCommentIcons.js';
import { PopoverSurface } from '../ui/MotionPresence.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 选区评论编辑框在视口中的位置和可用尺寸。 */
export interface SelectionCommentEditorPoint {
  left: number;
  top: number;
  /** 实际可用宽度同步到样式，窄分栏不沿用视口宽度。 */
  width: number;
  /** 极矮窗口中允许编辑框内部滚动，操作按钮不落到裁剪区域。 */
  maxHeight: number;
  placement: 'above' | 'below';
}

/** 选区评论浮层允许使用的可见边界。 */
export interface SelectionOverlayBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** 编辑框贴住选区末端，并限制在当前内容区域和视口内。 */
export function selectionCommentEditorPoint(rect: Pick<DOMRect, 'bottom' | 'right' | 'top'>, view: Window | null, overlayBounds: SelectionOverlayBounds, editorHeight: number): SelectionCommentEditorPoint {
  /** 编辑框与可见区域边缘之间的安全间距。 */
  const margin = 12;
  /** 编辑框与选区之间的间距。 */
  const gap = 10;
  /** 窄分栏按真实可用宽度收缩。 */
  const availableWidth = Math.max(1, overlayBounds.right - overlayBounds.left - margin * 2);
  /** 编辑框使用会话评论的固定上限。 */
  const editorWidth = Math.min(296, (view?.innerWidth ?? 380) - margin * 2, availableWidth);
  /** 高度不足时由编辑框内部滚动。 */
  const maxHeight = Math.max(1, overlayBounds.bottom - overlayBounds.top - margin * 2);
  /** 水平位置贴近选区末端并保持在可见范围内。 */
  const left = Math.max(overlayBounds.left + margin, Math.min(rect.right + 5, overlayBounds.right - editorWidth - margin));
  /** 下方空间不足时把编辑框放到选区上方。 */
  const placeBelow = rect.bottom + gap + editorHeight <= overlayBounds.bottom - margin || rect.top - 5 - gap - editorHeight < overlayBounds.top + margin;
  return {
    left,
    width: editorWidth,
    maxHeight,
    top: placeBelow ? Math.max(overlayBounds.top + margin, Math.min(rect.bottom + gap, overlayBounds.bottom - margin - editorHeight)) : rect.top - 5 - gap,
    placement: placeBelow ? 'below' : 'above',
  };
}

/** 会话回答和文件文字选区共用的评论编辑浮层。 */
export function SelectionCommentEditor(props: {
  /** 供调用方读取实际浮层高度并重新定位。 */
  editorRef: RefObject<HTMLDivElement | null>;
  /** 当前评论的稳定身份。 */
  id: string;
  /** 当前评论正文；空值表示只引用所选文字。 */
  note?: string;
  /** 浮层在当前可见区域中的位置。 */
  point: SelectionCommentEditorPoint;
  /** 当前界面语言。 */
  language: SessionUiLanguage;
  /** 浮层的无障碍名称。 */
  label: string;
  /** 关闭浮层但保留当前评论。 */
  onClose: () => void;
  /** 保存评论正文。 */
  onUpdate?: (id: string, note: string) => void;
  /** 删除当前评论。 */
  onRemove?: (id: string) => void;
}) {
  /** 本地编辑内容在确认后写入会话草稿。 */
  const [note, setNote] = useState(props.note ?? '');
  /** 调整面板保留删除和取消，默认只展示输入与确认。 */
  const [optionsOpen, setOptionsOpen] = useState(false);
  /** 自动折行和手动换行都使用展开外观。 */
  const [multiline, setMultiline] = useState(false);
  /** 多行文字按实际内容增长，避免固定大输入框。 */
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    /** 先恢复单行高度，再测量换行后的实际内容。 */
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '28px';
    textarea.style.height = `${Math.min(112, textarea.scrollHeight)}px`;
    setMultiline(textarea.scrollHeight > 36);
  }, [note, props.point.width]);
  useEffect(() => setNote(props.note ?? ''), [props.id, props.note]);
  /** 当前语言用于评论编辑器的操作文案。 */
  const zh = props.language === 'zh-CN';

  /** 点击确认和键盘确认共用同一条评论提交流程。 */
  function submitComment(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    props.onUpdate?.(props.id, note);
    props.onClose();
  }

  /** 普通 Enter 提交；输入法确认和 Shift + Enter 保留原生输入行为。 */
  function handleCommentKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  /** Esc 保存已有内容并关闭，纯空白草稿直接删除。 */
  function handleCommentDismiss(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (note.trim()) props.onUpdate?.(props.id, note);
    else props.onRemove?.(props.id);
    props.onClose();
  }

  return (
    <PopoverSurface
      ref={props.editorRef}
      popover="manual"
      className="session-response-annotation-editor"
      lang={props.language}
      data-placement={props.point.placement}
      data-expanded={optionsOpen || multiline || undefined}
      style={{ left: props.point.left, top: props.point.top, width: props.point.width, maxHeight: props.point.maxHeight }}
      aria-label={props.label}
      onKeyDown={handleCommentDismiss}
    >
      <form className="session-response-annotation-row" onSubmit={submitComment}>
        <button data-icon-tooltip={zh ? '评论选项' : 'Comment options'} type="button" aria-label={zh ? '评论选项' : 'Comment options'} aria-expanded={optionsOpen} onClick={() => setOptionsOpen((open) => !open)}>
          <svg aria-hidden="true" viewBox={selectionCommentIcons.viewBox} fill="currentColor">
            <path d={selectionCommentIcons.options} />
          </svg>
        </button>
        <textarea
          ref={textareaRef}
          autoFocus
          rows={1}
          value={note}
          aria-label={zh ? '评论内容' : 'Comment text'}
          placeholder={zh ? '添加可选评论…' : 'Add an optional comment…'}
          onChange={(event) => setNote(event.currentTarget.value)}
          onKeyDown={handleCommentKeyDown}
        />
        <button data-icon-tooltip={zh ? '完成评论' : 'Save comment'} type="submit" className="session-response-annotation-save" aria-label={zh ? '完成评论' : 'Save comment'}>
          <svg aria-hidden="true" viewBox={selectionCommentIcons.viewBox} fill="currentColor">
            <path d={selectionCommentIcons.save} />
          </svg>
        </button>
      </form>
      {optionsOpen ? (
        <div className="session-response-annotation-options">
          <button
            type="button"
            onClick={() => {
              props.onRemove?.(props.id);
              props.onClose();
            }}
          >
            {zh ? '删除' : 'Delete'}
          </button>
          <button type="button" onClick={props.onClose}>
            {zh ? '取消' : 'Cancel'}
          </button>
        </div>
      ) : null}
    </PopoverSurface>
  );
}
