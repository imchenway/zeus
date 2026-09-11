import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePresenceSurface } from './MotionPresence.js';
import { useModalFocus } from './useModalFocus.js';
import { useNativeCloseLayer } from './nativeCloseLayer.js';

/** 抽屉的呈现方式与尺寸保持显式。 */
type WorkspaceDrawerVisual =
  | {
      presentation: 'floating';
      backdrop: 'dimmed';
      size?: 'standard' | 'wide';
    }
  | {
      presentation: 'sheet';
      backdrop: 'dimmed';
      size?: 'standard' | 'wide';
    };

/** 所有工作区抽屉共用关闭、焦点和遮罩行为。 */
export type WorkspaceDrawerProps = WorkspaceDrawerVisual & {
  label: string;
  backdropLabel: string;
  closeLabel: string;
  /** 可选的右上角操作，和关闭按钮共用同一栏。 */
  headerAction?: ReactNode;
  className?: string;
  portalStyle?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
};

/** 抽屉从当前位置连续进出，关闭等待真实过渡完成。 */
export function WorkspaceDrawer(props: WorkspaceDrawerProps) {
  /** 表面同时用于动效与焦点管理。 */
  const workspaceDrawerRef = useRef<HTMLElement>(null);
  /** 调用方立即关闭业务，边界等待视觉退出。 */
  const open = usePresenceSurface(workspaceDrawerRef);
  /** 门户内的下拉与抽屉正文共同参与焦点范围。 */
  const portalRef = useRef<HTMLDivElement>(null);
  useModalFocus(portalRef, open);
  useNativeCloseLayer(open, props.onClose);
  /** 防止从内容拖选到遮罩时误关抽屉。 */
  const backdropPointer = useRef<number | null>(null);
  /** Esc 只关闭当前最上层，内部下拉可以先消费事件。 */
  const handleWorkspaceDrawerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    props.onClose();
  };

  /** 门户只承载当前抽屉，不改变调用方的业务状态。 */
  const drawerSurface = (
    <div
      ref={portalRef}
      tabIndex={-1}
      className="macos-ai-app workspace-drawer-portal-root"
      data-zeus-primitive="drawer"
      data-motion-state={open ? 'open' : 'closing'}
      inert={!open}
      aria-hidden={!open || undefined}
      data-drawer-presentation={props.presentation}
      data-drawer-backdrop={props.backdrop}
      data-drawer-size={props.size ?? 'standard'}
      style={props.portalStyle}
    >
      <div
        className="workspace-drawer-backdrop"
        aria-label={props.backdropLabel}
        data-motion-surface="backdrop"
        data-motion-state={open ? 'open' : 'closing'}
        onPointerDown={(event) => {
          backdropPointer.current = event.button === 0 && event.target === event.currentTarget ? event.pointerId : null;
        }}
        onPointerCancel={() => {
          backdropPointer.current = null;
        }}
        onPointerUp={(event) => {
          const shouldClose = backdropPointer.current === event.pointerId && event.target === event.currentTarget;
          backdropPointer.current = null;
          if (open && shouldClose) props.onClose();
        }}
      >
        <aside
          className={`workspace-drawer ${props.className ?? ''}`.trim()}
          role="dialog"
          aria-modal="true"
          inert={!open}
          aria-hidden={!open || undefined}
          aria-label={props.label}
          data-motion-surface="drawer"
          data-motion-state={open ? 'open' : 'closing'}
          ref={workspaceDrawerRef}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={handleWorkspaceDrawerKeyDown}
        >
          <div className="workspace-drawer-chrome">
            <strong>{props.label}</strong>
            <div className="workspace-drawer-header-actions">
              {props.headerAction}
              <button type="button" className="workspace-drawer-close-button" aria-label={props.closeLabel} onClick={props.onClose}>
                {props.closeLabel}
              </button>
            </div>
          </div>
          <div className="workspace-drawer-content">{props.children}</div>
        </aside>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body ? createPortal(drawerSurface, document.body) : drawerSurface;
}
