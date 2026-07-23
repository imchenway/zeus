import {useEffect, useId, useRef, useState} from 'react';
import {ComposerDropdown} from './ComposerDropdown.js';
import type {NativePermissionMode} from './sessionTypes.js';
import type {SessionUiLanguage} from './ThreadItemView.js';

export interface PermissionModeControlProps {
  language: SessionUiLanguage;
  value: NativePermissionMode;
  disabled?: boolean;
  onChange: (permissionMode: NativePermissionMode) => void | Promise<void>;
}

export function requiresPermissionModeConfirmation(current: NativePermissionMode, next: NativePermissionMode): boolean {
  return next === 'full-access' && current !== 'full-access';
}

const labels = {
  'zh-CN': {
    label: '权限模式',
    readOnly: '只读',
    auto: '自动',
    fullAccess: '完全访问',
    warning: '完全访问允许 Codex 在本机无审批执行命令。仅在你信任当前项目与本次输入时启用。',
    locked: '权限模式只能在会话空闲时切换',
    confirm: '确认完全访问',
    cancel: '取消',
  },
  'en-US': {
    label: 'Permission mode',
    readOnly: 'Read only',
    auto: 'Auto',
    fullAccess: 'Full access',
    warning: 'Full access lets Codex run commands on this Mac without approval. Enable it only when you trust this project and request.',
    locked: 'Permission mode can change only while the conversation is idle',
    confirm: 'Confirm full access',
    cancel: 'Cancel',
  },
} as const;

export function PermissionModeControl(props: PermissionModeControlProps) {
  const copy = labels[props.language];
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const warningId = useId();
    const triggerRef = useRef<HTMLButtonElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
    const options = [
        {value: 'read-only', label: copy.readOnly},
        {value: 'auto', label: copy.auto},
        {value: 'full-access', label: copy.fullAccess},
    ] as const;

  function closeConfirmation(next?: NativePermissionMode): void {
    setConfirmingFullAccess(false);
      triggerRef.current?.focus();
    if (next) void props.onChange(next);
  }

  useEffect(() => {
    if (props.disabled || props.value === 'full-access') setConfirmingFullAccess(false);
  }, [props.disabled, props.value]);

  useEffect(() => {
    if (confirmingFullAccess) confirmButtonRef.current?.focus();
  }, [confirmingFullAccess]);

  return (
    <span className="session-permission-control">
      <ComposerDropdown
          triggerRef={triggerRef}
          label={copy.label}
          title={props.disabled ? copy.locked : undefined}
          value={props.value}
          options={options}
          disabled={props.disabled}
          onChange={(next) => {
              if (requiresPermissionModeConfirmation(props.value, next)) {
                  setConfirmingFullAccess(true);
                  return;
              }
              setConfirmingFullAccess(false);
              void props.onChange(next);
          }}
      />
      {confirmingFullAccess ? (
        <span className="session-permission-confirmation" role="alertdialog" aria-label={copy.confirm} aria-describedby={warningId}>
          <span id={warningId}>{copy.warning}</span>
          <span className="session-permission-confirmation-actions">
            <button ref={confirmButtonRef} type="button" onClick={() => closeConfirmation('full-access')}>
              {copy.confirm}
            </button>
            <button type="button" onClick={() => closeConfirmation()}>
              {copy.cancel}
            </button>
          </span>
        </span>
      ) : null}
    </span>
  );
}
