import { FilePreviewDialog } from '../code/FilePreview.js';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { TaskPushSupplementalAttachmentDraft } from '../session/sessionTypes.js';
import { conversationAttachmentIdentity } from '../session/ConversationComposerAttachments.js';
import { PendingResourceCards, type PendingResourceCardItem } from '../ui/PendingResourceCards.js';

export function TaskPushSupplementalAttachmentCards(props: {
  attachments: TaskPushSupplementalAttachmentDraft[];
  language: 'zh-CN' | 'en-US';
  disabled: boolean;
  onRemove: (attachment: TaskPushSupplementalAttachmentDraft) => void;
  onRestoreText: (attachment: TaskPushSupplementalAttachmentDraft) => void;
  onError: (message: string) => void;
}) {
  const [previewAttachment, setPreviewAttachment] = useState<TaskPushSupplementalAttachmentDraft | null>(null);

  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const zh = props.language === 'zh-CN';
  const attachmentsById = useMemo(() => new Map(props.attachments.map((attachment) => [conversationAttachmentIdentity(attachment), attachment])), [props.attachments]);
  const resources = useMemo<PendingResourceCardItem[]>(
    () =>
      props.attachments.map((attachment) => ({
        id: conversationAttachmentIdentity(attachment),
        name: attachment.name,
        kind: attachment.kind ?? (attachment.mime === 'inode/directory' ? 'directory' : attachment.mime.startsWith('image/') ? 'image' : 'file'),
        mimeType: attachment.mime,
        size: attachment.size,
        ...(attachment.characterCount !== undefined ? { characterCount: attachment.characterCount } : {}),
        ...(attachment.restorableText ? { restorable: true } : {}),
        title: attachment.name,
      })),
    [props.attachments],
  );

  const loadPreview = useCallback(async (attachment: TaskPushSupplementalAttachmentDraft) => {
    const bridge = window.zeus?.getConversationResourcePreview;
    if (!bridge) return null;
    return bridge({ ...(attachment.localPath ? { localPath: attachment.localPath } : {}), ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}) });
  }, []);

  const loadResourcePreview = useCallback(
    async (resource: PendingResourceCardItem) => {
      const attachment = attachmentsById.get(resource.id);
      return attachment ? loadPreview(attachment) : null;
    },
    [attachmentsById, loadPreview],
  );

  function closePreview(): void {
    setPreviewAttachment(null);
  }

  async function activateResource(resource: PendingResourceCardItem, trigger: HTMLButtonElement): Promise<void> {
    const attachment = attachmentsById.get(resource.id);
    if (!attachment) return;
    previewTriggerRef.current = trigger;
    setPreviewAttachment(attachment);
  }

  return (
    <div className="task-model-push-supplemental-resources">
      <PendingResourceCards
        resources={resources}
        language={props.language}
        disabled={props.disabled}
        onLoadPreview={loadResourcePreview}
        onActivate={(resource, trigger) => void activateResource(resource, trigger)}
        onRemove={(resource) => {
          const attachment = attachmentsById.get(resource.id);
          if (attachment) props.onRemove(attachment);
        }}
        onRestoreText={(resource) => {
          const attachment = attachmentsById.get(resource.id);
          if (attachment) props.onRestoreText(attachment);
        }}
      />
      <MotionPresence>{previewAttachment ? <FilePreviewDialog request={{ kind: 'attachment', localPath: previewAttachment.localPath, uploadRef: previewAttachment.uploadRef }} zh={zh} onClose={closePreview} /> : null}</MotionPresence>
    </div>
  );
}
