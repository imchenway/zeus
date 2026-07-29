import type {ReactNode} from 'react';
import {createPortal} from 'react-dom';

export interface ModalPortalProps {
  rootClassName?: string;
  backdropClassName?: string;
  dismissDisabled?: boolean;
  onDismiss?: () => void;
  children: ReactNode;
}

export function ModalPortal(props: ModalPortalProps) {
  const modalSurface = (
    <div
      className={['macos-ai-app', 'zeus-modal-portal-root', props.rootClassName].filter(Boolean).join(' ')}
      data-zeus-primitive="modal"
    >
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
