import { FilePreviewDialog } from '../code/FilePreview.js';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { TaskAttachmentView } from './taskAttachments.js';
import { PendingResourceCards, type PendingResourceCardItem } from '../ui/PendingResourceCards.js';

export type TaskAttachmentPreviewItem = TaskAttachmentView;

export interface TaskAttachmentPreviewListCopy {
  imageLabel: string;
  fileLabel: string;
  openFileLabel: string;
  openPreviewLabel: string;
  closePreviewLabel: string;
  previewLoading: string;
  previewUnavailable: string;
  previewLoadFailed: string;
  retryPreviewLabel: string;
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
  const [previewFailures, setPreviewFailures] = useState<Map<string, TaskAttachmentPreviewFailure>>(() => new Map());
  const loadedPreviewUrlsRef = useRef(loadedPreviewUrls);
  const previewFailuresRef = useRef(previewFailures);
  const previewRequestsRef = useRef<Map<string, symbol>>(new Map());
  const previewLoaderRef = useRef(props.onLoadPreview);
  const mountedRef = useRef(true);

  const lastPreviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const previewId = useId();
  const previewTitleId = `${previewId}-task-attachment-zoom-title`;
  const previewDescriptionId = `${previewId}-task-attachment-zoom-description`;
  const previewSrc = previewAttachment ? resolveTaskAttachmentPreviewSrc(previewAttachment, loadedPreviewUrls) : '';
  const previewFailure = previewAttachment ? (previewFailures.get(previewAttachment.path) ?? (!previewSrc && !props.onLoadPreview ? 'unavailable' : undefined)) : undefined;
  const previewLoading = Boolean(previewAttachment && !previewSrc && !previewFailure && (loadingPreviewPaths.has(previewAttachment.path) || props.onLoadPreview));
  const listClassName = ['task-attachment-preview-list', props.className].filter(Boolean).join(' ');
  const addedStatus = useMemo(() => props.copy.addedStatus?.(props.attachments.length), [props.attachments.length, props.copy]);
  const previewCandidateSignature = props.attachments
    .filter((attachment) => attachment.kind === 'image' && !attachment.previewUrl)
    .map((attachment) => attachment.path)
    .join('\0');
  const previewLoaderAvailable = Boolean(props.onLoadPreview);

  previewLoaderRef.current = props.onLoadPreview;
  loadedPreviewUrlsRef.current = loadedPreviewUrls;
  previewFailuresRef.current = previewFailures;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const requestAttachmentPreview = useCallback((path: string, force = false): void => {
    const loadPreview = previewLoaderRef.current;
    if (!loadPreview) return;
    if (!force && (loadedPreviewUrlsRef.current.has(path) || previewFailuresRef.current.has(path) || previewRequestsRef.current.has(path))) return;

    const requestToken = Symbol('task-attachment-preview-request');
    previewRequestsRef.current.set(path, requestToken);
    setLoadingPreviewPaths((currentPaths) => new Set(currentPaths).add(path));
    setPreviewFailures((currentFailures) => {
      const nextFailures = new Map(currentFailures);
      nextFailures.delete(path);
      previewFailuresRef.current = nextFailures;
      return nextFailures;
    });

    void loadPreview(path)
      .then((preview) => {
        if (!mountedRef.current || previewRequestsRef.current.get(path) !== requestToken) return;
        if (!preview?.previewUrl) {
          markPreviewFailed(path, 'unavailable');
          return;
        }
        setLoadedPreviewUrls((currentUrls) => {
          const nextUrls = new Map(currentUrls);
          nextUrls.set(path, preview.previewUrl);
          loadedPreviewUrlsRef.current = nextUrls;
          return nextUrls;
        });
      })
      .catch(() => {
        if (mountedRef.current && previewRequestsRef.current.get(path) === requestToken) markPreviewFailed(path, 'read_failed');
      })
      .finally(() => {
        if (!mountedRef.current || previewRequestsRef.current.get(path) !== requestToken) return;
        previewRequestsRef.current.delete(path);
        setLoadingPreviewPaths((currentPaths) => {
          const nextPaths = new Set(currentPaths);
          nextPaths.delete(path);
          return nextPaths;
        });
      });
  }, []);

  useEffect(() => {
    if (!previewLoaderAvailable || !previewCandidateSignature) return;
    for (const path of previewCandidateSignature.split('\0')) requestAttachmentPreview(path);
  }, [previewCandidateSignature, previewLoaderAvailable, requestAttachmentPreview]);

  function markPreviewFailed(path: string, failure: TaskAttachmentPreviewFailure = 'unavailable'): void {
    setPreviewFailures((currentFailures) => {
      const nextFailures = new Map(currentFailures);
      nextFailures.set(path, failure);
      previewFailuresRef.current = nextFailures;
      return nextFailures;
    });
  }

  function retryAttachmentPreview(path: string): void {
    requestAttachmentPreview(path, true);
  }

  function openAttachmentPreview(attachment: TaskAttachmentPreviewItem, trigger: HTMLButtonElement): void {
    lastPreviewTriggerRef.current = trigger;
    setPreviewAttachment(attachment);
  }

  function closeAttachmentPreview(): void {
    setPreviewAttachment(null);
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
          openAttachmentPreview(attachment, trigger);
        }}
      />
      {renderTaskAttachmentPreviewDialog({
        previewTitleId,
        previewDescriptionId,
        previewAttachment,
        previewFailure,
        previewLoading,
        previewSrc,
        copy: props.copy,
        closeAttachmentPreview,
        markPreviewFailed,
        retryAttachmentPreview,
      })}
    </div>
  );
}

type TaskAttachmentPreviewFailure = 'unavailable' | 'read_failed';

function renderTaskAttachmentPreviewDialog(input: {
  previewTitleId: string;
  previewDescriptionId: string;
  previewAttachment: TaskAttachmentPreviewItem | null;
  previewFailure?: TaskAttachmentPreviewFailure;
  previewLoading: boolean;
  previewSrc: string;
  copy: TaskAttachmentPreviewListCopy;
  closeAttachmentPreview: () => void;
  markPreviewFailed: (path: string, failure?: TaskAttachmentPreviewFailure) => void;
  retryAttachmentPreview: (path: string) => void;
}) {
  return input.previewAttachment ? <FilePreviewDialog request={{ kind: 'attachment', localPath: input.previewAttachment.path }} zh={input.copy.imageLabel.toLowerCase() !== 'image'} onClose={input.closeAttachmentPreview} /> : null;
}
