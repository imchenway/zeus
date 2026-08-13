import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject, type SyntheticEvent } from 'react';
import type { TaskAttachmentView } from './taskAttachments.js';
import { PendingResourceCards, type PendingResourceCardItem } from '../ui/PendingResourceCards.js';
import { useNativeCloseLayer } from '../ui/nativeCloseLayer.js';

export type TaskAttachmentPreviewItem = TaskAttachmentView;

export interface TaskAttachmentPreviewListCopy {
  imageLabel: string;
  fileLabel: string;
  openFileLabel: string;
  openPreviewLabel: string;
  closePreviewLabel: string;
  previewUnavailable: string;
  localPathLabel: string;
  removeLabel?: string;
  addedStatus?: (count: number) => string;
}

export interface TaskAttachmentPreviewListProps {
  attachments: TaskAttachmentPreviewItem[];
  copy: TaskAttachmentPreviewListCopy;
  mode: 'editable' | 'readonly';
  onRemove?: (path: string) => void;
  onLoadPreview?: (path: string) => Promise<{ previewUrl: string; mimeType: string } | null>;
  onOpenAttachment?: (path: string) => Promise<{ opened: boolean; error?: string }> | void;
  onRestoreText?: (attachment: TaskAttachmentPreviewItem) => void;
  className?: string;
  disabled?: boolean;
}

export function resolveTaskAttachmentPreviewSrc(attachment: TaskAttachmentPreviewItem, loadedPreviewUrls: ReadonlyMap<string, string>): string {
  if (attachment.kind !== 'image') return '';
  if (attachment.previewUrl?.startsWith('data:image/')) return attachment.previewUrl;
  return loadedPreviewUrls.get(attachment.path) ?? '';
}

export function TaskAttachmentPreviewList(props: TaskAttachmentPreviewListProps) {
  const [previewAttachment, setPreviewAttachment] = useState<TaskAttachmentPreviewItem | null>(null);
  const [loadedPreviewUrls, setLoadedPreviewUrls] = useState<Map<string, string>>(() => new Map());
  const [loadingPreviewPaths, setLoadingPreviewPaths] = useState<Set<string>>(() => new Set());
  const [failedPreviewPaths, setFailedPreviewPaths] = useState<Set<string>>(() => new Set());
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const lastPreviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewId = useId();
  const previewTitleId = `${previewId}-task-attachment-zoom-title`;
  const previewDescriptionId = `${previewId}-task-attachment-zoom-description`;
  const previewSrc = previewAttachment ? resolveTaskAttachmentPreviewSrc(previewAttachment, loadedPreviewUrls) : '';
  const previewFailed = previewAttachment ? failedPreviewPaths.has(previewAttachment.path) || (!previewSrc && !props.onLoadPreview) : false;
  const listClassName = ['task-attachment-preview-list', props.className].filter(Boolean).join(' ');
  const addedStatus = useMemo(() => props.copy.addedStatus?.(props.attachments.length), [props.attachments.length, props.copy]);

  useNativeCloseLayer(Boolean(previewAttachment), closeAttachmentPreview);

  useEffect(() => {
    if (!props.onLoadPreview) return;
    let cancelled = false;
    for (const attachment of props.attachments) {
      if (attachment.kind !== 'image') continue;
      if (attachment.previewUrl || loadedPreviewUrls.has(attachment.path) || loadingPreviewPaths.has(attachment.path) || failedPreviewPaths.has(attachment.path)) continue;
      setLoadingPreviewPaths((currentPaths) => new Set(currentPaths).add(attachment.path));
      void props
        .onLoadPreview(attachment.path)
        .then((preview) => {
          if (cancelled || !preview?.previewUrl) return;
          setLoadedPreviewUrls((currentUrls) => {
            const nextUrls = new Map(currentUrls);
            nextUrls.set(attachment.path, preview.previewUrl);
            return nextUrls;
          });
        })
        .catch(() => {
          if (!cancelled) markPreviewFailed(attachment.path);
        })
        .finally(() => {
          if (cancelled) return;
          setLoadingPreviewPaths((currentPaths) => {
            const nextPaths = new Set(currentPaths);
            nextPaths.delete(attachment.path);
            return nextPaths;
          });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [failedPreviewPaths, loadedPreviewUrls, loadingPreviewPaths, props]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!previewAttachment || !dialog || dialog.open || typeof dialog.showModal !== 'function') return;
    dialog.showModal();
  }, [previewAttachment]);

  function markPreviewFailed(path: string): void {
    setFailedPreviewPaths((currentPaths) => {
      const nextPaths = new Set(currentPaths);
      nextPaths.add(path);
      return nextPaths;
    });
  }

  function openAttachmentPreview(attachment: TaskAttachmentPreviewItem, trigger: HTMLButtonElement): void {
    lastPreviewTriggerRef.current = trigger;
    setPreviewAttachment(attachment);
  }

  function openFileAttachment(path: string): void {
    if (props.disabled) return;
    void props.onOpenAttachment?.(path);
  }

  function closeAttachmentPreview(): void {
    const dialog = dialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    setPreviewAttachment(null);
    lastPreviewTriggerRef.current?.focus();
  }

  function handleDialogClose(): void {
    setPreviewAttachment(null);
    lastPreviewTriggerRef.current?.focus();
  }

  function handleDialogCancel(event: SyntheticEvent<HTMLDialogElement, Event>): void {
    event.preventDefault();
    closeAttachmentPreview();
  }

  function handleDialogPointerDown(event: ReactMouseEvent<HTMLDialogElement>): void {
    if (event.currentTarget === event.target) closeAttachmentPreview();
  }

  const attachmentsByPath = new Map(props.attachments.map((attachment) => [attachment.path, attachment]));
  const resources: PendingResourceCardItem[] = props.attachments.map((attachment) => {
    const previewUrl = resolveTaskAttachmentPreviewSrc(attachment, loadedPreviewUrls);
    return {
      id: attachment.path,
      name: attachment.name,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
      ...(attachment.characterCount !== undefined ? { characterCount: attachment.characterCount } : {}),
      ...(previewUrl ? { previewUrl } : {}),
      ...(attachment.restorableText ? { restorable: true } : {}),
      title: attachment.path,
    };
  });
  const language = props.copy.imageLabel.toLocaleLowerCase() === 'image' ? 'en-US' : 'zh-CN';
  return (
    <div className={listClassName}>
      {addedStatus ? (
        <p className="task-attachment-live-status" aria-live="polite">
          {addedStatus}
        </p>
      ) : null}
      <PendingResourceCards
        resources={resources}
        language={language}
        disabled={props.disabled}
        onRemove={props.mode === 'editable' && props.onRemove ? (resource) => props.onRemove?.(resource.id) : undefined}
        onRestoreText={
          props.mode === 'editable' && props.onRestoreText
            ? (resource) => {
                const attachment = attachmentsByPath.get(resource.id);
                if (attachment) props.onRestoreText?.(attachment);
              }
            : undefined
        }
        onActivate={(resource, trigger) => {
          const attachment = attachmentsByPath.get(resource.id);
          if (!attachment) return;
          if (attachment.kind === 'image') openAttachmentPreview(attachment, trigger);
          else openFileAttachment(attachment.path);
        }}
      />
      {renderTaskAttachmentPreviewDialog({
        dialogRef,
        previewTitleId,
        previewDescriptionId,
        previewAttachment,
        previewFailed,
        previewSrc,
        copy: props.copy,
        closeAttachmentPreview,
        handleDialogClose,
        handleDialogCancel,
        handleDialogPointerDown,
        markPreviewFailed,
      })}
    </div>
  );
}

function renderTaskAttachmentPreviewDialog(input: {
  dialogRef: RefObject<HTMLDialogElement | null>;
  previewTitleId: string;
  previewDescriptionId: string;
  previewAttachment: TaskAttachmentPreviewItem | null;
  previewFailed: boolean;
  previewSrc: string;
  copy: TaskAttachmentPreviewListCopy;
  closeAttachmentPreview: () => void;
  handleDialogClose: () => void;
  handleDialogCancel: (event: SyntheticEvent<HTMLDialogElement, Event>) => void;
  handleDialogPointerDown: (event: ReactMouseEvent<HTMLDialogElement>) => void;
  markPreviewFailed: (path: string) => void;
}) {
  return (
    <dialog
      ref={input.dialogRef}
      className="task-attachment-zoom-dialog"
      aria-labelledby={input.previewTitleId}
      aria-describedby={input.previewDescriptionId}
      onClose={input.handleDialogClose}
      onCancel={input.handleDialogCancel}
      onPointerDown={input.handleDialogPointerDown}
    >
      <div className="task-attachment-zoom-sheet">
        <header className="task-attachment-zoom-header">
          <span>
            <strong id={input.previewTitleId}>{input.previewAttachment?.name ?? input.copy.openPreviewLabel}</strong>
            <small id={input.previewDescriptionId}>{input.previewAttachment?.path ?? input.copy.localPathLabel}</small>
          </span>
          <button type="button" className="task-attachment-zoom-close" onClick={input.closeAttachmentPreview} aria-label={input.copy.closePreviewLabel}>
            ×
          </button>
        </header>
        <div className="task-attachment-zoom-stage">
          {input.previewAttachment && !input.previewFailed && input.previewSrc ? (
            <img className="task-attachment-zoom-image" src={input.previewSrc} alt={input.previewAttachment.name} onError={() => input.markPreviewFailed(input.previewAttachment!.path)} />
          ) : (
            <p className="task-attachment-zoom-fallback">{input.copy.previewUnavailable}</p>
          )}
        </div>
        {input.previewAttachment ? (
          <p className="task-attachment-zoom-path">
            <strong>{input.copy.localPathLabel}</strong>
            <span>{input.previewAttachment.path}</span>
          </p>
        ) : null}
      </div>
    </dialog>
  );
}
