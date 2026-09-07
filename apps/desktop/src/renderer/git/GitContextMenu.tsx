import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';

export interface GitMenuItem {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  run: () => void | Promise<void>;
}
export function GitContextMenu(props: { x: number; y: number; title: string; items: GitMenuItem[]; onClose: () => void; onError: (error: unknown) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const previous = document.activeElement as HTMLElement | null;
    const bounds = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(props.x, window.innerWidth - bounds.width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(props.y, window.innerHeight - bounds.height - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (event: Event) => {
      if (!element.contains(event.target as Node)) props.onClose();
    };
    const resize = () => props.onClose();
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', close, true);
      document.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', resize);
      previous?.focus();
    };
  }, [props.x, props.y, props.items, props.onClose]);
  return createPortal(
    <div
      ref={ref}
      className="project-git-context-menu"
      role="menu"
      aria-label={props.title}
      style={{ left: props.x, top: props.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const buttons = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <strong>{props.title}</strong>
      {props.items.map((item, index) => (
        <button
          key={index}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          data-danger={item.danger || undefined}
          onClick={() => {
            props.onClose();
            try {
              void Promise.resolve(item.run()).catch(props.onError);
            } catch (error) {
              props.onError(error);
            }
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.querySelector('.macos-ai-app') ?? document.body,
  );
}

export interface GitMenuConfirmation {
  title: string;
  description: string;
  field?: string;
  initialValue?: string;
  danger?: boolean;
  run: (value: string) => Promise<boolean>;
}
export function GitMenuActionDialog(props: { value: GitMenuConfirmation; zh: boolean; onClose: () => void }) {
  const [text, setText] = useState(props.value.initialValue ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={busy}>
      <section className="project-git-menu-action-dialog" role="alertdialog" aria-modal="true" aria-label={props.value.title}>
        <header>
          <strong>{props.value.title}</strong>
          <p>{props.value.description}</p>
        </header>
        {props.value.field ? (
          <label>
            {props.value.field}
            <input autoFocus value={text} disabled={busy} onChange={(event) => setText(event.currentTarget.value)} />
          </label>
        ) : null}
        {error ? <p role="alert">{error}</p> : null}
        <footer>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant={props.value.danger ? 'danger' : 'primary'}
            busy={busy}
            disabled={busy || Boolean(props.value.field && !text.trim())}
            onClick={async () => {
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              setError('');
              try {
                if (await props.value.run(text.trim())) props.onClose();
                else setError(props.zh ? '操作未完成，请处理错误后重试。' : 'The operation did not complete. Resolve the error and retry.');
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            {props.zh ? '确认' : 'Confirm'}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
