import type { NativeConversationAttachment } from './sessionTypes.js';
import { PendingResourceCards, type PendingResourceCardItem } from '../ui/PendingResourceCards.js';
import { useEffect, useState } from 'react';
import { MotionPresence } from '../ui/MotionPresence.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { ConversationImagePreviewDialog } from './ConversationResources.js';

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
  /** 预览读取失败只影响当前弹窗，不阻止草稿继续编辑。 */
  const [previewUrl, setPreviewUrl] = useState('');
  /** 空地址与读取中分开表达，避免失败后一直显示加载。 */
  const [previewLoading, setPreviewLoading] = useState(false);
  /** 非图片沿用宿主的受信资源打开接口。 */
  const [openError, setOpenError] = useState<unknown>(null);
  useApplicationErrorDialog(openError, { language: props.language === 'zh-CN' ? 'zh-CN' : 'en' });

  useEffect(() => {
    if (!previewAttachment) return;
    /** 切换图片或关闭后丢弃迟到结果。 */
    let active = true;
    setPreviewUrl('');
    setPreviewLoading(true);
    void loadAttachmentPreview(previewAttachment)
      .then((preview) => {
        if (active) setPreviewUrl(preview?.previewUrl ?? '');
      })
      .catch(() => {
        if (active) setPreviewUrl('');
      })
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [previewAttachment]);

  /** 图片就地放大，其余文件交给系统已关联的应用；不拼接任意文件地址。 */
  async function activateAttachment(attachment: NativeConversationAttachment, trigger: HTMLButtonElement): Promise<void> {
    if (props.onActivate) return props.onActivate(attachment, trigger);
    setOpenError(null);
    if (attachmentKind(attachment) === 'image') {
      setPreviewUrl('');
      setPreviewLoading(true);
      setPreviewAttachment(attachment);
      return;
    }
    try {
      /** 宿主继续复验本地路径与上传引用的授权。 */
      const result = await window.zeus?.openConversationInputResource(attachmentResource(attachment));
      if (!result?.opened) setOpenError(props.language === 'zh-CN' ? '无法打开这个附件，请确认原资源仍然可用。' : 'The attachment could not be opened. Confirm that the original resource is still available.');
    } catch (error) {
      setOpenError(error);
    }
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
      <MotionPresence>
        {previewAttachment ? (
          <ConversationImagePreviewDialog
            key={conversationAttachmentIdentity(previewAttachment)}
            previewUrl={previewUrl}
            label={previewAttachment.name}
            language={props.language}
            loading={previewLoading}
            onClose={() => setPreviewAttachment(null)}
          />
        ) : null}
      </MotionPresence>
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
