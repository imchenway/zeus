import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from 'react';
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
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewId = useId();
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

  useEffect(() => {
    if (!previewAttachment) return;
    let active = true;
    setPreviewUrl('');
    setPreviewLoading(true);
    setPreviewFailed(false);
    void loadPreview(previewAttachment)
      .then((preview) => {
        if (!active) return;
        if (preview?.previewUrl) setPreviewUrl(preview.previewUrl);
        else setPreviewFailed(true);
      })
      .catch(() => {
        if (active) setPreviewFailed(true);
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [loadPreview, previewAttachment]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!previewAttachment || !dialog || dialog.open || typeof dialog.showModal !== 'function') return;
    dialog.showModal();
  }, [previewAttachment]);

  function closePreview(): void {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    setPreviewAttachment(null);
    previewTriggerRef.current?.focus();
  }

  function handleDialogClose(): void {
    setPreviewAttachment(null);
    previewTriggerRef.current?.focus();
  }

  function handleDialogCancel(event: SyntheticEvent<HTMLDialogElement, Event>): void {
    event.preventDefault();
    closePreview();
  }

  function handleDialogPointerDown(event: ReactMouseEvent<HTMLDialogElement>): void {
    if (event.currentTarget === event.target) closePreview();
  }

  async function activateResource(resource: PendingResourceCardItem, trigger: HTMLButtonElement): Promise<void> {
    const attachment = attachmentsById.get(resource.id);
    if (!attachment) return;
    if (resource.kind === 'image') {
      previewTriggerRef.current = trigger;
      setPreviewAttachment(attachment);
      return;
    }
    const bridge = window.zeus?.openConversationInputResource;
    if (!bridge) {
      props.onError(zh ? '当前应用版本无法安全打开这个附件。' : 'This app version cannot safely open the attachment.');
      return;
    }
    try {
      const result = await bridge({ ...(attachment.localPath ? { localPath: attachment.localPath } : {}), ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}) });
      if (!result.opened) props.onError(zh ? '无法打开这个附件，请确认原文件仍然可用。' : 'The attachment could not be opened. Confirm that the original resource is still available.');
    } catch {
      props.onError(zh ? '无法打开这个附件，请重试。' : 'The attachment could not be opened. Try again.');
    }
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
      <dialog
        ref={dialogRef}
        className="task-model-push-attachment-dialog"
        aria-labelledby={`${previewId}-title`}
        aria-describedby={`${previewId}-description`}
        onClose={handleDialogClose}
        onCancel={handleDialogCancel}
        onPointerDown={handleDialogPointerDown}
      >
        <div className="task-model-push-attachment-sheet">
          <header>
            <span>
              <strong id={`${previewId}-title`}>{previewAttachment?.name ?? (zh ? '图片预览' : 'Image preview')}</strong>
              <small id={`${previewId}-description`}>{zh ? '本次推送附件图片预览' : 'Image preview for this push attachment'}</small>
            </span>
            <button type="button" onClick={closePreview} aria-label={zh ? '关闭图片预览' : 'Close image preview'}>
              ×
            </button>
          </header>
          <div className="task-model-push-attachment-stage">
            {previewLoading ? (
              <p role="status">{zh ? '正在加载图片…' : 'Loading image…'}</p>
            ) : previewAttachment && previewUrl && !previewFailed ? (
              <img src={previewUrl} alt={previewAttachment.name} onError={() => setPreviewFailed(true)} />
            ) : (
              <p>{zh ? '图片预览不可用。' : 'Image preview is unavailable.'}</p>
            )}
          </div>
        </div>
      </dialog>
    </div>
  );
}
