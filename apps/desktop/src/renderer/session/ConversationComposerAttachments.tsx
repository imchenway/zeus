import type {NativeConversationAttachment} from './sessionTypes.js';
import {PendingResourceCards, type PendingResourceCardItem} from '../ui/PendingResourceCards.js';

export interface ConversationComposerAttachmentsProps {
  attachments: NativeConversationAttachment[];
  language: 'zh-CN' | 'en-US';
  disabled: boolean;
  onRemove: (attachment: NativeConversationAttachment) => void;
  onRestorePastedText?: (attachment: NativeConversationAttachment) => void;
}

export function ConversationComposerAttachments(props: ConversationComposerAttachmentsProps) {
  if (props.attachments.length === 0) return null;
  const resources = props.attachments.map(toPendingResource);
  const byId = new Map(props.attachments.map((attachment) => [conversationAttachmentIdentity(attachment), attachment]));
  return (
    <PendingResourceCards
      resources={resources}
      language={props.language}
      disabled={props.disabled}
      className="session-composer-attachments"
      onLoadPreview={async (resource) => {
        const attachment = byId.get(resource.id);
        if (!attachment || !window.zeus?.getConversationResourcePreview) return null;
        return window.zeus.getConversationResourcePreview({
          ...(attachment.localPath ? {localPath: attachment.localPath} : {}),
          ...(attachment.uploadRef ? {uploadRef: attachment.uploadRef} : {}),
        });
      }}
      onRemove={(resource) => {
        const attachment = byId.get(resource.id);
        if (attachment) props.onRemove(attachment);
      }}
      onRestoreText={props.onRestorePastedText
        ? (resource) => {
            const attachment = byId.get(resource.id);
            if (attachment) props.onRestorePastedText?.(attachment);
          }
        : undefined}
    />
  );
}

function toPendingResource(attachment: NativeConversationAttachment): PendingResourceCardItem {
  return {
    id: conversationAttachmentIdentity(attachment),
    name: attachment.name,
    kind: attachmentKind(attachment),
    mimeType: attachment.mime,
    size: attachment.size,
    ...(attachment.characterCount !== undefined ? {characterCount: attachment.characterCount} : {}),
    ...(attachment.restorableText ? {restorable: true} : {}),
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
