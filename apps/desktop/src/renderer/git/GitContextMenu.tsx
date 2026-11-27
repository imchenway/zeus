import { MenuSurface, type MenuSubmenuAnchor } from '../ui/MenuSurface.js';
import { CaretRightIcon as CaretRight } from '@phosphor-icons/react/dist/csr/CaretRight';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';

export interface GitMenuItem {
  label: string;
  /** 动作图标和文字共用同一行。 */
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  /** 快捷键提示只显示调用方实际支持的组合。 */
  shortcut?: string;
  /** 在一组 Git 动作前插入标准菜单分隔线。 */
  separatorBefore?: boolean;
  /** 提交引用菜单复用同一套分支操作。 */
  children?: GitMenuItem[];
  run: () => void | Promise<void>;
}
export function GitContextMenu(props: { x: number; y: number; title: string; items: GitMenuItem[]; anchor?: HTMLElement; submenuAnchor?: MenuSubmenuAnchor; onClose: () => void; onAction?: () => void; onError: (error: unknown) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [submenu, setSubmenu] = useState<{ anchor: MenuSubmenuAnchor; item: GitMenuItem }>();

  return createPortal(
    <MenuSurface
      onClose={props.onClose}
      ref={ref}
      submenuAnchor={props.submenuAnchor}
      className="zeus-context-menu project-git-context-menu"
      role="menu"
      aria-label={props.title}
      style={{ left: props.x, top: props.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== 'F2') return;
        const rename = ref.current?.querySelector<HTMLButtonElement>('[aria-keyshortcuts="F2"]:not(:disabled)');
        if (!rename) return;
        event.preventDefault();
        rename.click();
      }}
    >
      <strong>{props.title}</strong>
      {props.items.map((item, index) => (
        <Fragment key={index}>
          {item.separatorBefore ? <hr role="separator" /> : null}
          <Button
            unstyled
            type="button"
            role="menuitem"
            disabled={item.disabled}
            aria-keyshortcuts={item.shortcut === 'F2' ? 'F2' : undefined}
            aria-haspopup={item.children ? 'menu' : undefined}
            aria-expanded={item.children ? item === submenu?.item : undefined}
            data-danger={item.danger || undefined}
            onClick={(event) => {
              if (item.children && ref.current) {
                setSubmenu(submenu?.item === item ? undefined : { anchor: { row: event.currentTarget, parent: ref.current }, item });
                return;
              }
              (props.onAction ?? props.onClose)();
              try {
                return Promise.resolve(item.run()).catch(props.onError);
              } catch (error) {
                props.onError(error);
              }
            }}
          >
            {item.icon}
            <span>{item.label}</span>
            {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            {item.children ? <CaretRight aria-hidden="true" /> : null}
          </Button>
        </Fragment>
      ))}
      {submenu?.item.children ? (
        <GitContextMenu x={0} y={0} title={submenu.item.label} items={submenu.item.children} submenuAnchor={submenu.anchor} onClose={() => setSubmenu(undefined)} onAction={props.onAction ?? props.onClose} onError={props.onError} />
      ) : null}
    </MenuSurface>,
    props.anchor?.closest('[data-zeus-primitive=modal]') ?? document.querySelector('.macos-ai-app') ?? document.body,
  );
}

export interface GitMenuConfirmation {
  title: string;
  description: string;
  field?: string;
  initialValue?: string;
  /** 固定 Git 目标由下拉列表选取，不接受任意输入。 */
  choices?: Array<{ value: string; label: string }>;
  messageField?: string;
  /** 编辑提交之前保留原有多行说明。 */
  initialMessage?: string;
  /** 历史操作只提交勾选的工作树文件。 */
  files?: Array<{ path: string; checked: boolean }>;
  danger?: boolean;
  /** 确认按钮可显示实际 Git 动作。 */
  actionLabel?: string;
  run: (value: string, message?: string, paths?: string[]) => Promise<boolean>;
}
export function GitMenuActionDialog(props: { value: GitMenuConfirmation; zh: boolean; onClose: () => void }) {
  const [text, setText] = useState(props.value.initialValue ?? props.value.choices?.[0]?.value ?? '');
  const [message, setMessage] = useState(props.value.initialMessage ?? '');
  /** 初始勾选沿用暂存区，用户可以加入其他工作树文件。 */
  const [paths, setPaths] = useState(() => props.value.files?.filter((file) => file.checked).map((file) => file.path) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  return (
    <ModalPortal rootClassName="project-git-modal-root" backdropClassName="project-git-modal-backdrop" onDismiss={props.onClose} dismissDisabled={busy} role="alertdialog" aria-label={props.value.title}>
      <section className="project-git-menu-action-dialog" data-modal-surface="alertdialog">
        <header>
          <strong>{props.value.title}</strong>
          <p style={{ whiteSpace: 'pre-wrap', maxHeight: '40vh', overflowY: 'auto', overflowWrap: 'anywhere' }}>{props.value.description}</p>
        </header>
        {props.value.field ? (
          <label>
            {props.value.field}
            {props.value.choices ? (
              <select autoFocus value={text} disabled={busy} onChange={(event) => setText(event.currentTarget.value)}>
                {props.value.choices.map(({ value, label }) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <input autoFocus value={text} disabled={busy} onChange={(event) => setText(event.currentTarget.value)} />
            )}
          </label>
        ) : null}
        {props.value.messageField ? (
          <label>
            {props.value.messageField}
            <textarea value={message} disabled={busy} onChange={(event) => setMessage(event.currentTarget.value)} />
          </label>
        ) : null}
        {props.value.files ? (
          <fieldset className="git-history-file-selection">
            <legend>Changes</legend>
            {props.value.files.map(({ path }) => (
              <label key={path} className="project-git-checkbox" title={path}>
                <input type="checkbox" checked={paths.includes(path)} disabled={busy} onChange={(event) => setPaths(event.currentTarget.checked ? [...paths, path] : paths.filter((item) => item !== path))} />
                <span>{path}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? (
          <p role="alert">
            <VisibleApplicationError error={error} />
          </p>
        ) : null}
        <footer>
          <Button variant="secondary" disabled={busy} onClick={props.onClose}>
            {props.zh ? '取消' : 'Cancel'}
          </Button>
          <Button
            variant={props.value.danger ? 'danger' : 'primary'}
            busy={busy}
            disabled={busy || Boolean(props.value.field && !text.trim()) || Boolean(props.value.files && (!paths.length || (props.value.messageField && !message.trim())))}
            onClick={async () => {
              if (submitting.current) return;
              submitting.current = true;
              setBusy(true);
              setError('');
              try {
                if (await props.value.run(text.trim(), message.trim(), paths)) props.onClose();
                else setError(props.zh ? '操作未完成，请处理错误后重试。' : 'The operation did not complete. Resolve the error and retry.');
              } catch (reason) {
                setError(reason instanceof Error ? reason.message : String(reason));
              } finally {
                submitting.current = false;
                setBusy(false);
              }
            }}
          >
            {props.value.actionLabel ?? (props.zh ? '确认' : 'Confirm')}
          </Button>
        </footer>
      </section>
    </ModalPortal>
  );
}
