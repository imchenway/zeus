import {
  type AnimationEvent as ReactAnimationEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

const workspaceDrawerCloseFallbackMs = 320;

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

export type WorkspaceDrawerProps = WorkspaceDrawerVisual & {
  label: string;
  backdropLabel: string;
  closeLabel: string;
  className?: string;
  portalStyle?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
};

export function WorkspaceDrawer(props: WorkspaceDrawerProps) {
  const workspaceDrawerRef = useRef<HTMLElement | null>(null);
  const previousFocusedElementRef = useRef<HTMLElement | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    previousFocusedElementRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    workspaceDrawerRef.current?.focus();
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
      const previousFocusedElement = previousFocusedElementRef.current;
      if (previousFocusedElement?.isConnected) previousFocusedElement.focus();
    };
  }, []);

  const requestWorkspaceDrawerClose = () => {
    if (isClosing) return;
    setIsClosing(true);
    // animationend 是正常关闭路径；定时器只兜底系统或宿主意外吞掉动画事件的情况。
    closeTimerRef.current = setTimeout(props.onClose, workspaceDrawerCloseFallbackMs);
  };

  const handleWorkspaceDrawerAnimationEnd = (event: ReactAnimationEvent<HTMLElement>) => {
    if (!isClosing || event.currentTarget !== event.target) return;
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    props.onClose();
  };

  const handleWorkspaceDrawerKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      requestWorkspaceDrawerClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const drawer = workspaceDrawerRef.current;
    if (!drawer) return;
    const focusableElements = [...drawer.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')].filter(
      (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
    );
    if (focusableElements.length === 0) {
      event.preventDefault();
      drawer.focus();
      return;
    }
    const firstFocusableElement = focusableElements[0];
    const lastFocusableElement = focusableElements.at(-1);
    if (event.shiftKey && (document.activeElement === firstFocusableElement || document.activeElement === drawer)) {
      event.preventDefault();
      lastFocusableElement?.focus();
    } else if (!event.shiftKey && document.activeElement === lastFocusableElement) {
      event.preventDefault();
      firstFocusableElement?.focus();
    }
  };

  const drawerSurface = (
    <div
      className="macos-ai-app workspace-drawer-portal-root"
      data-zeus-primitive="drawer"
      data-drawer-presentation={props.presentation}
      data-drawer-backdrop={props.backdrop}
      data-drawer-size={props.size ?? 'standard'}
      style={props.portalStyle}
    >
      <div
        className="workspace-drawer-backdrop"
        aria-label={props.backdropLabel}
        data-motion-surface="backdrop"
        data-motion-state={isClosing ? 'closing' : 'open'}
        onClick={requestWorkspaceDrawerClose}
      >
        <aside
          className={`workspace-drawer ${props.className ?? ''}`.trim()}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          data-motion-surface="drawer"
          data-motion-state={isClosing ? 'closing' : 'open'}
          ref={workspaceDrawerRef}
          tabIndex={-1}
          onClick={(event) => event.stopPropagation()}
          onAnimationEnd={handleWorkspaceDrawerAnimationEnd}
          onKeyDown={handleWorkspaceDrawerKeyDown}
        >
          <div className="workspace-drawer-chrome">
            <strong>{props.label}</strong>
            <button type="button" className="workspace-drawer-close-button" aria-label={props.closeLabel} onClick={requestWorkspaceDrawerClose}>
              {props.closeLabel}
            </button>
          </div>
          <div className="workspace-drawer-content">{props.children}</div>
        </aside>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body ? createPortal(drawerSurface, document.body) : drawerSurface;
}
