import { useId, type FormEvent, type ReactNode } from 'react';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import { Button } from './Button.js';
import { ModalPortal } from './ModalPortal.js';

/** 表单操作共用标题、滚动表单和操作区，焦点与关闭行为交给全局弹窗。 */
export function FormDialog(props: {
  title: string;
  /** 业务只扩展内容布局，不重写按钮与弹窗行为。 */
  className?: string;
  description?: string;
  zh: boolean;
  busy: boolean;
  submitLabel: string;
  submitDisabled?: boolean;
  danger?: boolean;
  children?: ReactNode;
  onClose(): void;
  onSubmit(event: FormEvent): void;
}) {
  /** 同页多层弹窗保持独立的可访问名称。 */
  const id = useId();
  return (
    <ModalPortal dismissDisabled={props.busy} onDismiss={props.onClose}>
      <form
        className={['zeus-form-dialog zeus-solid-form-surface', props.className].filter(Boolean).join(' ')}
        role={props.danger ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={props.description ? `${id}-description` : undefined}
        onSubmit={props.onSubmit}
      >
        <header>
          <h2 id={`${id}-title`}>{props.title}</h2>
          <Button className="zeus-form-dialog-close" aria-label={props.zh ? '关闭' : 'Close'} onClick={props.onClose} disabled={props.busy}>
            <X aria-hidden="true" />
          </Button>
        </header>
        <fieldset className="zeus-form-fields" disabled={props.busy}>
          {props.description ? (
            <p id={`${id}-description`} className="zeus-form-description">
              {props.description}
            </p>
          ) : null}
          {props.children}
        </fieldset>
        <footer>
          <Button onClick={props.onClose} disabled={props.busy}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button type="submit" variant={props.danger ? 'danger' : 'primary'} busy={props.busy} disabled={props.submitDisabled}>
            <span role="status">{props.busy ? (props.zh ? '处理中…' : 'Working…') : props.submitLabel}</span>
          </Button>
        </footer>
      </form>
    </ModalPortal>
  );
}
