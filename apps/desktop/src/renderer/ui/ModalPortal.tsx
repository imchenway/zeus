import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNativeCloseLayer } from './nativeCloseLayer.js';
import { usePresenceSurface } from './MotionPresence.js';
import { useModalFocus } from './useModalFocus.js';
import { SystemWindowPortal, type SystemWindowKind } from './SystemWindowPortal.js';
import { WindowDocumentContext, useWindowDocument } from './windowDocument.js';

/** 弹窗共用遮罩、焦点和关闭规则。 */
export interface ModalPortalProps {
  /** 已迁移的工作界面由系统窗口承载，浏览器预览仍使用普通门户。 */
  systemWindow?: SystemWindowKind;
  /** 系统标题栏名称不依赖正文标题的 DOM 标识。 */
  windowTitle?: string;
  /** 入口再次触发时唤回已存在窗口，不重建表单。 */
  windowActivation?: unknown;
  /** 模态身份与下拉弹层共享门户根，避免选项落在可访问范围外。 */
  role: 'dialog' | 'alertdialog';
  /** 弹窗名称，可直接提供或引用标题。 */
  'aria-label'?: string;
  /** 可见标题节点的标识。 */
  'aria-labelledby'?: string;
  /** 补充说明节点的标识。 */
  'aria-describedby'?: string;
  rootClassName?: string;
  backdropClassName?: string;
  dismissDisabled?: boolean;
  onDismiss?: () => void;
  children: ReactNode;
}

/** 业务关闭立即生效，退出边界负责保留视觉表面。 */
export function ModalPortal(props: ModalPortalProps) {
  if (props.systemWindow && window.zeus) {
    return (
      <SystemWindowPortal kind={props.systemWindow} activation={props.windowActivation} title={props.windowTitle ?? props['aria-label'] ?? 'Zeus'} onClose={props.onDismiss}>
        <ModalSurface {...props} />
      </SystemWindowPortal>
    );
  }
  return <ModalSurface {...props} />;
}

/** 遮罩和焦点仅作用于所属文档，独立窗口不会阻塞主工作区。 */
function ModalSurface(props: ModalPortalProps) {
  /** 下拉和内嵌弹层沿用同一个目标文档。 */
  const ownerDocument = useWindowDocument();
  /** 门户根节点同时用于焦点隔离和退出等待。 */
  const rootRef = useRef<HTMLDivElement>(null);
  /** 关闭中的弹窗不再接受任何新的操作。 */
  const open = usePresenceSurface(rootRef);
  /** 只有在同一遮罩上按下并松开才关闭，避免内容拖选误触。 */
  const backdropPointer = useRef<number | null>(null);

  useNativeCloseLayer(open, () => {
    if (!props.dismissDisabled) props.onDismiss?.();
  });

  useModalFocus(rootRef, open);

  /** Esc 关闭最上层，Tab 只在可见且可操作的控件间移动。 */
  function containKeyboardFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (!props.dismissDisabled) props.onDismiss?.();
      return;
    }
  }

  /** 遮罩与内容共同退出，隐藏期间不拦截背景操作。 */
  const modalSurface = (
    <div
      ref={rootRef}
      role={props.role}
      aria-modal="true"
      aria-label={props['aria-label']}
      aria-labelledby={props['aria-labelledby']}
      aria-describedby={props['aria-describedby']}
      className={['macos-ai-app', 'zeus-modal-portal-root', props.rootClassName, props.systemWindow && ownerDocument !== document && 'zeus-system-window-root'].filter(Boolean).join(' ')}
      data-zeus-primitive="modal"
      data-motion-state={open ? 'open' : 'closing'}
      inert={!open}
      aria-hidden={!open || undefined}
      tabIndex={-1}
      onKeyDown={containKeyboardFocus}
    >
      <div
        className={['zeus-modal-backdrop', props.backdropClassName].filter(Boolean).join(' ')}
        data-motion-surface="backdrop"
        onPointerDown={(event) => {
          backdropPointer.current = event.button === 0 && event.currentTarget === event.target ? event.pointerId : null;
        }}
        onPointerCancel={() => {
          backdropPointer.current = null;
        }}
        onPointerUp={(event) => {
          const shouldDismiss = backdropPointer.current === event.pointerId && event.currentTarget === event.target;
          backdropPointer.current = null;
          if (shouldDismiss && open && !props.dismissDisabled) props.onDismiss?.();
        }}
      >
        {props.children}
      </div>
    </div>
  );

  return createPortal(<WindowDocumentContext.Provider value={ownerDocument}>{modalSurface}</WindowDocumentContext.Provider>, ownerDocument.body);
}
