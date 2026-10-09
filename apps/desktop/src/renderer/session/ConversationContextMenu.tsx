/**
 * 会话右键菜单组件
 *
 * 提供会话列表项的上下文菜单，仅显示实际接入的重命名和归档操作。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { MenuSurface } from '../ui/MenuSurface.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import { reportApplicationError } from '../ui/ApplicationErrorDialog.js';
import type { NativeConversationChoice } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 会话菜单使用会话界面的既有语言范围。 */
export type ConversationContextMenuLanguage = SessionUiLanguage;

/** 菜单只接收真实可执行的会话操作。 */
export interface ConversationContextMenuProps {
  /** 触发菜单的会话 */
  conversation: NativeConversationChoice;
  /** 菜单打开状态 */
  open: boolean;
  /** 菜单位置 */
  position: { x: number; y: number };
  /** 关闭菜单 */
  onClose: () => void;
  /** 语言 */
  language: ConversationContextMenuLanguage;
  /** 归档会话 */
  onArchive?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 取消归档 */
  onRestore?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 重命名会话 */
  onRename?: (conversation: NativeConversationChoice, newTitle: string) => void | Promise<void>;
}

/** 菜单与重命名弹窗的中英文文案。 */
const labels = {
  'zh-CN': {
    rename: '重命名',
    renameShortcut: '⌥⌘R',
    archive: '归档',
    archiveShortcut: '⇧⌘A',
    renameDialogTitle: '重命名会话',
    renameLabel: '标题',
    renamePlaceholder: '会话标题',
    renameCancel: '取消',
    renameSave: '保存',
    renameSaving: '保存中...',
  },
  'en-US': {
    rename: 'Rename',
    renameShortcut: '⌥⌘R',
    archive: 'Archive',
    archiveShortcut: '⇧⌘A',
    renameDialogTitle: 'Rename conversation',
    renameLabel: 'Title',
    renamePlaceholder: 'Conversation title',
    renameCancel: 'Cancel',
    renameSave: 'Save',
    renameSaving: 'Saving...',
  },
} as const;

/**
 * 会话右键菜单
 */
export function ConversationContextMenu(props: ConversationContextMenuProps) {
  const { conversation, open, position, onClose, language, onArchive, onRestore, onRename } = props;

  /** 当前语言下的菜单文案。 */
  const copy = labels[language];
  /** 标题编辑的弹窗、草稿和保存状态。 */
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  /** 用户尚未保存的标题。 */
  const [renameDraft, setRenameDraft] = useState(conversation.title);
  /** 保存期间禁止重复提交和离开。 */
  const [renameBusy, setRenameBusy] = useState(false);
  /** 弹窗进入后定位标题输入框。 */
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 打开重命名对话框时聚焦输入框
  useEffect(() => {
    if (!renameDialogOpen) return;
    const frame = window.requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renameDialogOpen]);

  // 对话关闭时重置重命名状态
  useEffect(() => {
    if (!open) {
      setRenameDialogOpen(false);
      setRenameDraft(conversation.title);
    }
  }, [open, conversation.title]);

  /** 保存真实会话标题，失败后保留草稿供重试。 */
  function handleRenameSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === conversation.title || !onRename) {
      setRenameDialogOpen(false);
      return;
    }
    setRenameBusy(true);
    Promise.resolve(onRename(conversation, trimmed))
      .then(() => {
        setRenameDialogOpen(false);
        onClose();
      })
      .catch((error: unknown) => {
        // 保存失败时保留输入，错误由现有全局弹窗呈现。
        reportApplicationError(error, { language: language === 'zh-CN' ? 'zh-CN' : 'en' });
      })
      .finally(() => {
        setRenameBusy(false);
      });
  }

  /** 取消本次标题编辑。 */
  function handleRenameCancel(): void {
    setRenameDialogOpen(false);
    setRenameDraft(conversation.title);
  }

  // 菜单项点击处理
  function handleRename(): void {
    setRenameDraft(conversation.title);
    setRenameDialogOpen(true);
  }

  /** 调用已接入的归档或恢复入口。 */
  function handleArchive(): void {
    if (conversation.archived) {
      onRestore?.(conversation);
    } else {
      onArchive?.(conversation);
    }
    onClose();
  }

  if (!open) return null;

  /** 和项目菜单一样挂到应用壳层，避免会话列表的折叠和滚动容器裁剪浮层。 */
  const menuPortalHost = document.querySelector<HTMLElement>('.macos-ai-app.zeus-shell') ?? document.body;
  return (
    <>
      {createPortal(
        <MenuSurface onClose={onClose} style={{ left: position.x, top: position.y }} className="conversation-context-menu zeus-quiet-more-menu">
          {/* 重命名 */}
          {onRename ? (
            <button type="button" role="menuitem" onClick={handleRename}>
              <PencilSimple aria-hidden="true" />
              <span>{copy.rename}</span>
              <kbd>{copy.renameShortcut}</kbd>
            </button>
          ) : null}

          {/* 归档/取消归档 */}
          {(onArchive || onRestore) && (
            <button type="button" role="menuitem" onClick={handleArchive}>
              <Archive aria-hidden="true" />
              <span>{conversation.archived ? copy.archive.replace('归档', '取消归档').replace('Archive', 'Restore') : copy.archive}</span>
              <kbd>{copy.archiveShortcut}</kbd>
            </button>
          )}
        </MenuSurface>,
        menuPortalHost,
      )}

      {/* 重命名对话框 */}
      {renameDialogOpen && (
        <ModalPortal
          rootClassName="conversation-rename-dialog-portal-root"
          backdropClassName="conversation-rename-dialog-backdrop"
          dismissDisabled={renameBusy}
          onDismiss={handleRenameCancel}
          role="dialog"
          aria-labelledby="conversation-rename-dialog-title"
        >
          <form className="conversation-rename-dialog zeus-solid-form-surface" onSubmit={handleRenameSubmit}>
            <header className="conversation-rename-dialog-header">
              <strong id="conversation-rename-dialog-title">{copy.renameDialogTitle}</strong>
            </header>
            <div className="conversation-rename-dialog-body">
              <label htmlFor="conversation-rename-input">{copy.renameLabel}</label>
              <input ref={renameInputRef} id="conversation-rename-input" value={renameDraft} placeholder={copy.renamePlaceholder} onChange={(event) => setRenameDraft(event.currentTarget.value)} disabled={renameBusy} />
            </div>
            <footer className="conversation-rename-dialog-footer">
              <Button variant="secondary" size="regular" onClick={handleRenameCancel} disabled={renameBusy}>
                {copy.renameCancel}
              </Button>
              <Button type="submit" variant="primary" size="regular" busy={renameBusy} disabled={!renameDraft.trim() || renameBusy}>
                {renameBusy ? copy.renameSaving : copy.renameSave}
              </Button>
            </footer>
          </form>
        </ModalPortal>
      )}
    </>
  );
}
