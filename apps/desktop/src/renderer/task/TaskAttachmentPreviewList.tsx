import { useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type SyntheticEvent } from 'react';
import type { TaskAttachmentView } from './taskAttachments.js';

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

  return (
    <div className={listClassName}>
      {addedStatus ? (
        <p className="task-attachment-live-status" aria-live="polite">
          {addedStatus}
        </p>
      ) : null}
      <ul className="task-attachment-filmstrip" aria-label={addedStatus}>
        {props.attachments.map((attachment) => {
          const attachmentSrc = resolveTaskAttachmentPreviewSrc(attachment, loadedPreviewUrls);
          const previewIsPending = attachment.kind === 'image' && !attachmentSrc && !failedPreviewPaths.has(attachment.path) && Boolean(props.onLoadPreview);
          const attachmentFailed = failedPreviewPaths.has(attachment.path) || (!attachmentSrc && !previewIsPending);
          const previewState = attachment.kind !== 'image' ? 'file' : previewIsPending || loadingPreviewPaths.has(attachment.path) ? 'loading' : attachmentFailed ? 'unavailable' : 'ready';
          const kindLabel = attachment.kind === 'image' ? props.copy.imageLabel : props.copy.fileLabel;
          const fileExtension = formatTaskAttachmentExtension(attachment.name);
          return (
            <li className="task-attachment-film-item" key={attachment.path} data-attachment-preview-state={previewState}>
              {attachment.kind === 'image' ? (
                <button type="button" className="task-attachment-thumb-button" aria-label={`${props.copy.openPreviewLabel}: ${attachment.name}`} onClick={(event) => openAttachmentPreview(attachment, event.currentTarget)}>
                  {attachmentFailed || !attachmentSrc ? (
                    <span className="task-attachment-thumb-fallback">{props.copy.previewUnavailable}</span>
                  ) : (
                    <img className="task-attachment-image-thumb" src={attachmentSrc} alt={attachment.name} loading="lazy" onError={() => markPreviewFailed(attachment.path)} />
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  className="task-attachment-file-button"
                  data-attachment-extension={fileExtension}
                  aria-label={`${props.copy.openFileLabel}: ${attachment.name}`}
                  onClick={() => openFileAttachment(attachment.path)}
                  disabled={props.disabled}
                >
                  <span className="task-attachment-file-badge" aria-hidden="true">
                    {fileExtension}
                  </span>
                </button>
              )}
              <span className="task-attachment-copy">
                <strong title={attachment.name}>{attachment.name}</strong>
                <small title={attachment.path}>{attachment.kind === 'image' ? kindLabel : `${fileExtension} · ${kindLabel}`}</small>
              </span>
              {props.mode === 'editable' && props.onRemove ? (
                <button
                  type="button"
                  className="task-attachment-remove-button"
                  onClick={() => props.onRemove?.(attachment.path)}
                  disabled={props.disabled}
                  aria-label={props.copy.removeLabel ? `${props.copy.removeLabel}: ${attachment.name}` : attachment.name}
                >
                  ×
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <dialog
        ref={dialogRef}
        className="task-attachment-zoom-dialog"
        aria-labelledby={previewTitleId}
        aria-describedby={previewDescriptionId}
        onClose={handleDialogClose}
        onCancel={handleDialogCancel}
        onPointerDown={handleDialogPointerDown}
      >
        <div className="task-attachment-zoom-sheet">
          <header className="task-attachment-zoom-header">
            <span>
              <strong id={previewTitleId}>{previewAttachment?.name ?? props.copy.openPreviewLabel}</strong>
              <small id={previewDescriptionId}>{previewAttachment?.path ?? props.copy.localPathLabel}</small>
            </span>
            <button type="button" className="task-attachment-zoom-close" onClick={closeAttachmentPreview} aria-label={props.copy.closePreviewLabel}>
              ×
            </button>
          </header>
          <div className="task-attachment-zoom-stage">
            {previewAttachment && !previewFailed && previewSrc ? (
              <img className="task-attachment-zoom-image" src={previewSrc} alt={previewAttachment.name} onError={() => markPreviewFailed(previewAttachment.path)} />
            ) : (
              <p className="task-attachment-zoom-fallback">{props.copy.previewUnavailable}</p>
            )}
          </div>
          {previewAttachment ? (
            <p className="task-attachment-zoom-path">
              <strong>{props.copy.localPathLabel}</strong>
              <span>{previewAttachment.path}</span>
            </p>
          ) : null}
        </div>
      </dialog>
    </div>
  );
}

function formatTaskAttachmentExtension(fileName: string): string {
  const cleanName = fileName.trim();
  const extension = cleanName.includes('.')
    ? cleanName
        .split('.')
        .pop()
        ?.replace(/[^a-z0-9]+/giu, '')
    : '';
  return (extension || 'FILE').slice(0, 5).toUpperCase();
}
