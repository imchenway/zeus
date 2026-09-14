import type { NativeConversationAttachment } from './sessionTypes.js';
import { PendingResourceCards, type PendingResourceCardItem } from '../ui/PendingResourceCards.js';
import { useState } from 'react';
import { MotionPresence } from '../ui/MotionPresence.js';
import { FilePreviewDialog } from '../code/FilePreview.js';

export interface ConversationComposerAttachmentsProps {
  attachments: NativeConversationAttachment[];
  language: 'zh-CN' | 'en-US';
  disabled: boolean;
  ariaLabel?: string;
  className?: string;
  onActivate?: (attachment: NativeConversationAttachment, trigger: HTMLButtonElement) => void;
  onRemove?: (attachment: NativeConversationAttachment) => void;
  onRestorePastedText?: (attachment: NativeConversationAttachment) => void;
}

/** 草稿附件共享缩略图、放大预览和安全打开入口。 */
export function ConversationComposerAttachments(props: ConversationComposerAttachmentsProps) {
  /** 所有输入入口共用图片预览，调用者仍可提供自己的打开行为。 */
  const [previewAttachment, setPreviewAttachment] = useState<NativeConversationAttachment | null>(null);
  /** 所有格式就地预览，显式调用者的激活行为仍受保留。 */
  function activateAttachment(attachment: NativeConversationAttachment, trigger: HTMLButtonElement): void {
    if (props.onActivate) return props.onActivate(attachment, trigger);
    setPreviewAttachment(attachment);
  }

  const resources = props.attachments.map(toPendingResource);
  const byId = new Map(props.attachments.map((attachment) => [conversationAttachmentIdentity(attachment), attachment]));
  return (
    <>
      <PendingResourceCards
        resources={resources}
        language={props.language}
        ariaLabel={props.ariaLabel}
        disabled={props.disabled}
        className={['session-composer-attachments', props.className].filter(Boolean).join(' ')}
        onLoadPreview={async (resource) => {
          const attachment = byId.get(resource.id);
          return attachment ? loadAttachmentPreview(attachment) : null;
        }}
        onActivate={(resource, trigger) => {
          const attachment = byId.get(resource.id);
          if (attachment) void activateAttachment(attachment, trigger);
        }}
        onRemove={
          props.onRemove
            ? (resource) => {
                const attachment = byId.get(resource.id);
                if (attachment) props.onRemove?.(attachment);
              }
            : undefined
        }
        onRestoreText={
          props.onRestorePastedText
            ? (resource) => {
                const attachment = byId.get(resource.id);
                if (attachment) props.onRestorePastedText?.(attachment);
              }
            : undefined
        }
      />
      <MotionPresence>{previewAttachment ? <FilePreviewDialog request={{ kind: 'attachment', ...attachmentResource(previewAttachment) }} zh={props.language === 'zh-CN'} onClose={() => setPreviewAttachment(null)} /> : null}</MotionPresence>
    </>
  );
}

/** 缩略图和放大预览使用同一受信引用。 */
function attachmentResource(attachment: NativeConversationAttachment): { localPath?: string; uploadRef?: string } {
  return { ...(attachment.localPath ? { localPath: attachment.localPath } : {}), ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}) };
}

/** 预览由宿主读取，不存在预览能力时给出空结果。 */
async function loadAttachmentPreview(attachment: NativeConversationAttachment): Promise<{ previewUrl: string; mimeType: string } | null> {
  return (await window.zeus?.getConversationResourcePreview(attachmentResource(attachment))) ?? null;
}

function toPendingResource(attachment: NativeConversationAttachment): PendingResourceCardItem {
  return {
    id: conversationAttachmentIdentity(attachment),
    name: attachment.name,
    kind: attachmentKind(attachment),
    mimeType: attachment.mime,
    size: attachment.size,
    ...(attachment.characterCount !== undefined ? { characterCount: attachment.characterCount } : {}),
    ...(attachment.restorableText ? { restorable: true } : {}),
  };
}

export function conversationAttachmentIdentity(attachment: NativeConversationAttachment): string {
  return attachment.localPath ?? attachment.uploadRef;
}

function attachmentKind(attachment: NativeConversationAttachment): NonNullable<NativeConversationAttachment['kind']> {
  if (attachment.kind) return attachment.kind;
  if (attachment.mime === 'inode/directory') return 'directory';
  return attachment.mime.startsWith('image/') ? 'image' : 'file';
}
