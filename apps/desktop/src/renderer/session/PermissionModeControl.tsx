import { useEffect, useId, useRef, useState } from 'react';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/csr/Eye';
import { ShieldCheckIcon as ShieldCheck } from '@phosphor-icons/react/dist/csr/ShieldCheck';
import { TerminalWindowIcon as TerminalWindow } from '@phosphor-icons/react/dist/csr/TerminalWindow';
import { WarningCircleIcon as WarningCircle } from '@phosphor-icons/react/dist/csr/WarningCircle';
import { Button } from '../ui/Button.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { ComposerDropdown } from './ComposerDropdown.js';
import type { NativePermissionMode } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

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
    title: '要开启完全访问吗？',
    introduction: '开启后，Zeus 可以在无需逐次批准的情况下，于这台 Mac 的任意位置运行命令、访问互联网以及创建和编辑文件，包括但不限于：',
    filesTitle: '文件与文件夹',
    filesDescription: '读取、创建、修改或删除这台 Mac 上任意位置的文件',
    terminalTitle: '终端命令',
    terminalDescription: '运行命令、安装软件或更改系统设置',
    internetTitle: '互联网访问',
    internetDescription: '访问网站，并可能向外部服务发送本机数据',
    risk: '这可能造成敏感数据丢失或泄露，也会增加提示词注入带来的风险。你可以随时切换回“自动”或“只读”模式。',
    locked: '权限模式只能在会话空闲时切换',
    confirm: '确认开启',
    cancel: '取消',
  },
  'en-US': {
    label: 'Permission mode',
    readOnly: 'Read only',
    auto: 'Auto',
    fullAccess: 'Full access',
    title: 'Enable full access?',
    introduction: 'Zeus will be able to run commands, use the internet, and create or edit files anywhere on this Mac without asking for approval each time, including:',
    filesTitle: 'Files and folders',
    filesDescription: 'Read, create, modify, or delete files anywhere on this Mac',
    terminalTitle: 'Terminal commands',
    terminalDescription: 'Run commands, install software, or change system settings',
    internetTitle: 'Internet access',
    internetDescription: 'Visit websites and potentially send local data to external services',
    risk: 'This can cause loss or exposure of sensitive data and increases the risk of prompt injection. You can switch back to Auto or Read only at any time.',
    locked: 'Permission mode can change only while the conversation is idle',
    confirm: 'Enable full access',
    cancel: 'Cancel',
  },
} as const;

export function PermissionModeControl(props: PermissionModeControlProps) {
  const copy = labels[props.language];
  const [confirmingFullAccess, setConfirmingFullAccess] = useState(false);
  const titleId = useId();
  const introductionId = useId();
  const riskId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const options = [
    { value: 'read-only', label: copy.readOnly },
    { value: 'auto', label: copy.auto },
    { value: 'full-access', label: copy.fullAccess },
  ] as const;
  const selectedLabel = options.find((option) => option.value === props.value)?.label ?? copy.label;
  const triggerIcon = props.value === 'read-only' ? <Eye weight="regular" /> : props.value === 'full-access' ? <WarningCircle weight="fill" /> : <ShieldCheck weight="regular" />;

  function closeConfirmation(next?: NativePermissionMode): void {
    setConfirmingFullAccess(false);
    if (next) void props.onChange(next);
  }

  useEffect(() => {
    if (props.disabled || props.value === 'full-access') setConfirmingFullAccess(false);
  }, [props.disabled, props.value]);

  return (
    <span className="session-permission-control">
      <ComposerDropdown
        triggerRef={triggerRef}
        label={copy.label}
        title={props.disabled ? copy.locked : `${copy.label}：${selectedLabel}`}
        triggerLabel={`${copy.label}：${selectedLabel}`}
        triggerIcon={triggerIcon}
        hideSelectedLabel
        className="session-permission-dropdown"
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
        <ModalPortal rootClassName="session-permission-dialog-portal-root" backdropClassName="session-permission-dialog-backdrop" onDismiss={() => closeConfirmation()}>
          <section
            className="session-permission-dialog zeus-solid-form-surface"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={`${introductionId} ${riskId}`}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.stopPropagation();
              closeConfirmation();
            }}
          >
            <header className="session-permission-dialog-header">
              <WarningCircle aria-hidden="true" weight="regular" />
              <strong id={titleId}>{copy.title}</strong>
            </header>
            <p id={introductionId} className="session-permission-dialog-introduction">
              {copy.introduction}
            </p>
            <div className="session-permission-dialog-capabilities">
              <div className="session-permission-dialog-capability">
                <span className="session-permission-dialog-capability-icon" data-kind="files" aria-hidden="true">
                  <Folder weight="fill" />
                </span>
                <span>
                  <strong>{copy.filesTitle}</strong>
                  <small>{copy.filesDescription}</small>
                </span>
              </div>
              <div className="session-permission-dialog-capability">
                <span className="session-permission-dialog-capability-icon" data-kind="terminal" aria-hidden="true">
                  <TerminalWindow weight="fill" />
                </span>
                <span>
                  <strong>{copy.terminalTitle}</strong>
                  <small>{copy.terminalDescription}</small>
                </span>
              </div>
              <div className="session-permission-dialog-capability">
                <span className="session-permission-dialog-capability-icon" data-kind="internet" aria-hidden="true">
                  <GlobeSimple weight="regular" />
                </span>
                <span>
                  <strong>{copy.internetTitle}</strong>
                  <small>{copy.internetDescription}</small>
                </span>
              </div>
            </div>
            <p id={riskId} className="session-permission-dialog-risk">
              {copy.risk}
            </p>
            <footer className="session-permission-dialog-actions">
              <Button autoFocus variant="secondary" size="regular" onClick={() => closeConfirmation()}>
                {copy.cancel}
              </Button>
              <Button variant="danger" size="regular" onClick={() => closeConfirmation('full-access')}>
                <WarningCircle aria-hidden="true" weight="regular" />
                {copy.confirm}
              </Button>
            </footer>
          </section>
        </ModalPortal>
      ) : null}
    </span>
  );
}
