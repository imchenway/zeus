/**
 * 会话右键菜单组件
 *
 * 提供会话列表项的上下文菜单，支持归档、标记未读、重命名等操作。
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArchiveIcon as Archive } from '@phosphor-icons/react/dist/csr/Archive';
import { ArrowSquareOutIcon as ArrowSquareOut } from '@phosphor-icons/react/dist/csr/ArrowSquareOut';
import { CopyIcon as Copy } from '@phosphor-icons/react/dist/csr/Copy';
import { ArrowBendUpRightIcon as Fork } from '@phosphor-icons/react/dist/csr/ArrowBendUpRight';
import { FolderIcon as Folder } from '@phosphor-icons/react/dist/csr/Folder';
import { ListIcon as List } from '@phosphor-icons/react/dist/csr/List';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PushPinIcon as PushPin } from '@phosphor-icons/react/dist/csr/PushPin';
import { ShareIcon as Share } from '@phosphor-icons/react/dist/csr/Share';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { EyeIcon as Eye } from '@phosphor-icons/react/dist/csr/Eye';
import { EyeSlashIcon as EyeSlash } from '@phosphor-icons/react/dist/csr/EyeSlash';
import { MenuSurface } from '../ui/MenuSurface.js';
import { ModalPortal } from '../ui/ModalPortal.js';
import { Button } from '../ui/Button.js';
import type { NativeConversationChoice } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

export type ConversationContextMenuLanguage = SessionUiLanguage;

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
  /** 标记为未读 */
  onMarkAsUnread?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 标记为已读 */
  onMarkAsRead?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 重命名会话 */
  onRename?: (conversation: NativeConversationChoice, newTitle: string) => void | Promise<void>;
  /** 在新窗口打开 */
  onOpenInNewWindow?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 复制会话 */
  onCopy?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 分叉会话 */
  onFork?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 分享会话 */
  onShare?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 移动到项目 */
  onMoveToProject?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 移动到分区 */
  onMoveToSection?: (conversation: NativeConversationChoice) => void | Promise<void>;
  /** 删除会话 */
  onDelete?: (conversation: NativeConversationChoice) => void | Promise<void>;
}

const labels = {
  'zh-CN': {
    rename: '重命名',
    renameShortcut: '⌥⌘R',
    pin: '置顶',
    pinShortcut: '⌥⌘P',
    markAsUnread: '标记为未读',
    markAsRead: '标记为已读',
    markAsUnreadShortcut: '⇧⌘U',
    archive: '归档',
    archiveShortcut: '⇧⌘A',
    delete: '永久删除',
    project: '项目',
    section: '分区',
    share: '分享',
    copy: '复制',
    fork: '分叉',
    openWith: '打开方式',
    openInNewWindow: '在新窗口中打开',
    renameDialogTitle: '重命名会话',
    renameDialogHelp: '输入新的会话标题',
    renameLabel: '标题',
    renamePlaceholder: '会话标题',
    renameCancel: '取消',
    renameSave: '保存',
    renameSaving: '保存中...',
  },
  'en-US': {
    rename: 'Rename',
    renameShortcut: '⌥⌘R',
    pin: 'Pin',
    pinShortcut: '⌥⌘P',
    markAsUnread: 'Mark as unread',
    markAsRead: 'Mark as read',
    markAsUnreadShortcut: '⇧⌘U',
    archive: 'Archive',
    archiveShortcut: '⇧⌘A',
    delete: 'Delete permanently',
    project: 'Project',
    section: 'Section',
    share: 'Share',
    copy: 'Copy',
    fork: 'Fork',
    openWith: 'Open with',
    openInNewWindow: 'Open in new window',
    renameDialogTitle: 'Rename conversation',
    renameDialogHelp: 'Enter a new title for this conversation',
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
  const { conversation, open, position, onClose, language, onArchive, onRestore, onMarkAsUnread, onMarkAsRead, onRename, onOpenInNewWindow, onCopy, onFork, onShare, onMoveToProject, onMoveToSection, onDelete } = props;

  const copy = labels[language];
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState(conversation.title);
  const [renameBusy, setRenameBusy] = useState(false);
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
      .finally(() => {
        setRenameBusy(false);
      });
  }

  function handleRenameCancel(): void {
    setRenameDialogOpen(false);
    setRenameDraft(conversation.title);
  }

  // 菜单项点击处理
  function handleRename(): void {
    setRenameDraft(conversation.title);
    setRenameDialogOpen(true);
  }

  function handleArchive(): void {
    if (conversation.archived) {
      onRestore?.(conversation);
    } else {
      onArchive?.(conversation);
    }
    onClose();
  }

  function handleMarkAsUnread(): void {
    if (conversation.hasUnreadAttention) {
      onMarkAsRead?.(conversation);
    } else {
      onMarkAsUnread?.(conversation);
    }
    onClose();
  }

  function handleOpenInNewWindow(): void {
    onOpenInNewWindow?.(conversation);
    onClose();
  }

  function handleCopy(): void {
    onCopy?.(conversation);
    onClose();
  }

  function handleFork(): void {
    onFork?.(conversation);
    onClose();
  }

  function handleShare(): void {
    onShare?.(conversation);
    onClose();
  }

  function handleMoveToProject(): void {
    onMoveToProject?.(conversation);
    onClose();
  }

  function handleMoveToSection(): void {
    onMoveToSection?.(conversation);
    onClose();
  }

  function handleDelete(): void {
    onDelete?.(conversation);
    onClose();
  }

  if (!open) return null;

  return (
    <>
      <MenuSurface onClose={onClose} style={{ left: position.x, top: position.y }} className="conversation-context-menu">
        {/* 重命名 */}
        <button type="button" role="menuitem" onClick={handleRename}>
          <PencilSimple aria-hidden="true" />
          <span>{copy.rename}</span>
          <kbd>{copy.renameShortcut}</kbd>
        </button>

        {/* 置顶 - 暂未实现 */}
        <button type="button" role="menuitem" disabled>
          <PushPin aria-hidden="true" />
          <span>{copy.pin}</span>
          <kbd>{copy.pinShortcut}</kbd>
        </button>

        {/* 标记为未读/已读 */}
        {(onMarkAsUnread || onMarkAsRead) && (
          <button type="button" role="menuitem" onClick={handleMarkAsUnread}>
            {conversation.hasUnreadAttention ? <Eye aria-hidden="true" /> : <EyeSlash aria-hidden="true" />}
            <span>{conversation.hasUnreadAttention ? copy.markAsRead : copy.markAsUnread}</span>
            <kbd>{copy.markAsUnreadShortcut}</kbd>
          </button>
        )}

        {/* 归档/取消归档 */}
        {(onArchive || onRestore) && (
          <button type="button" role="menuitem" onClick={handleArchive}>
            <Archive aria-hidden="true" />
            <span>{conversation.archived ? copy.archive.replace('归档', '取消归档').replace('Archive', 'Restore') : copy.archive}</span>
            <kbd>{copy.archiveShortcut}</kbd>
          </button>
        )}

        {/* 永久删除 */}
        {onDelete && (
          <button type="button" role="menuitem" className="conversation-context-menu-danger" onClick={handleDelete}>
            <Trash aria-hidden="true" />
            <span>{copy.delete}</span>
          </button>
        )}

        {/* 分隔线 */}
        <div className="conversation-context-menu-separator" role="separator" />

        {/* 项目 - 暂未实现 */}
        <button type="button" role="menuitem" disabled onClick={handleMoveToProject}>
          <Folder aria-hidden="true" />
          <span>{copy.project}</span>
          <span className="conversation-context-menu-arrow">›</span>
        </button>

        {/* 分区 - 暂未实现 */}
        <button type="button" role="menuitem" disabled onClick={handleMoveToSection}>
          <List aria-hidden="true" />
          <span>{copy.section}</span>
          <span className="conversation-context-menu-arrow">›</span>
        </button>

        {/* 分隔线 */}
        <div className="conversation-context-menu-separator" role="separator" />

        {/* 分享 */}
        {onShare && (
          <button type="button" role="menuitem" onClick={handleShare}>
            <Share aria-hidden="true" />
            <span>{copy.share}</span>
          </button>
        )}

        {/* 复制 */}
        {onCopy && (
          <button type="button" role="menuitem" onClick={handleCopy}>
            <Copy aria-hidden="true" />
            <span>{copy.copy}</span>
            <span className="conversation-context-menu-arrow">›</span>
          </button>
        )}

        {/* 分叉 */}
        {onFork && (
          <button type="button" role="menuitem" onClick={handleFork}>
            <Fork aria-hidden="true" />
            <span>{copy.fork}</span>
            <span className="conversation-context-menu-arrow">›</span>
          </button>
        )}

        {/* 打开方式 - 暂未实现 */}
        <button type="button" role="menuitem" disabled>
          <ArrowSquareOut aria-hidden="true" />
          <span>{copy.openWith}</span>
          <span className="conversation-context-menu-arrow">›</span>
        </button>

        {/* 在新窗口中打开 */}
        {onOpenInNewWindow && (
          <button type="button" role="menuitem" onClick={handleOpenInNewWindow}>
            <ArrowSquareOut aria-hidden="true" />
            <span>{copy.openInNewWindow}</span>
          </button>
        )}
      </MenuSurface>

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
              <small>{copy.renameDialogHelp}</small>
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
