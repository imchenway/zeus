import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNativeCloseLayer } from './nativeCloseLayer.js';

export interface ModalPortalProps {
  rootClassName?: string;
  backdropClassName?: string;
  dismissDisabled?: boolean;
  onDismiss?: () => void;
  children: ReactNode;
}

export function ModalPortal(props: ModalPortalProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useNativeCloseLayer(true, () => {
    if (!props.dismissDisabled) props.onDismiss?.();
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof document === 'undefined') return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const backgroundElements = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== root);
    const backgroundState = backgroundElements.map((element) => ({ element, ariaHidden: element.getAttribute('aria-hidden'), inert: element.inert }));
    for (const element of backgroundElements) {
      element.setAttribute('aria-hidden', 'true');
      element.inert = true;
    }

    const focusableElements = () =>
      [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
        (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
      );
    const focusFirst = () => (root.querySelector<HTMLElement>('[autofocus]') ?? focusableElements()[0] ?? root).focus();
    const animationFrame = window.requestAnimationFrame(focusFirst);
    const containProgrammaticFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && root.contains(event.target)) return;
      focusFirst();
    };
    document.addEventListener('focusin', containProgrammaticFocus);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('focusin', containProgrammaticFocus);
      for (const { element, ariaHidden, inert } of backgroundState) {
        if (ariaHidden === null) element.removeAttribute('aria-hidden');
        else element.setAttribute('aria-hidden', ariaHidden);
        element.inert = inert;
      }
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, []);

  function containKeyboardFocus(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'Tab') return;
    const root = rootRef.current;
    if (!root) return;
    const focusable = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
      (element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true',
    );
    if (focusable.length === 0) {
      event.preventDefault();
      root.focus();
      return;
    }
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const modalSurface = (
    <div ref={rootRef} className={['macos-ai-app', 'zeus-modal-portal-root', props.rootClassName].filter(Boolean).join(' ')} data-zeus-primitive="modal" tabIndex={-1} onKeyDown={containKeyboardFocus}>
      <div
        className={['zeus-modal-backdrop', props.backdropClassName].filter(Boolean).join(' ')}
        data-motion-surface="backdrop"
        onPointerDown={(event) => {
          if (event.currentTarget !== event.target || props.dismissDisabled) return;
          props.onDismiss?.();
        }}
      >
        {props.children}
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body ? createPortal(modalSurface, document.body) : modalSurface;
}
