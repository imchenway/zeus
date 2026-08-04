import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeQueueSnapshot, NativeQueuedSubmission, NativeSessionState } from './sessionTypes.js';
import { SafeMarkdown, type SessionUiLanguage } from './ThreadItemView.js';
import { autosizeTextarea } from './textareaAutosize.js';

export interface QueuedConversationMessagesProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEdit?: (submissionId: string, content: string) => void | Promise<void>;
  onDelete?: (submissionId: string) => void | Promise<void>;
  onSendNow?: (submissionId: string) => void | Promise<void>;
  onReorder?: (orderedSubmissionIds: string[]) => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

const labels = {
  'zh-CN': {
    region: '排队中的消息',
    queued: '排队中',
    paused: '排队中 · 已暂停',
    edit: '编辑',
    editLabel: '编辑队列消息',
    save: '保存',
    cancel: '取消',
    remove: '删除',
    sendNow: '立即发送',
    moveUp: '上移',
    moveDown: '下移',
    resume: '继续发送',
    retry: '恢复并发送',
    saveFailed: '保存失败，编辑内容已保留。',
    attachmentOnly: '仅附件消息',
    attachments: '附件',
    reordered: (position: number, total: number) => `队列消息已移到第 ${position} 项，共 ${total} 项`,
  },
  'en-US': {
    region: 'Queued messages',
    queued: 'Queued',
    paused: 'Queued · Paused',
    edit: 'Edit',
    editLabel: 'Edit queued message',
    save: 'Save',
    cancel: 'Cancel',
    remove: 'Delete',
    sendNow: 'Send now',
    moveUp: 'Move up',
    moveDown: 'Move down',
    resume: 'Resume sending',
    retry: 'Restore and send',
    saveFailed: 'Save failed. Your edit is preserved.',
    attachmentOnly: 'Attachment-only message',
    attachments: 'Attachments',
    reordered: (position: number, total: number) => `Queued message moved to position ${position} of ${total}`,
  },
} as const;

export function QueuedConversationMessages(props: QueuedConversationMessagesProps) {
  const copy = labels[props.language];
  const queue = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = Boolean(props.state.busyOperation);
  const writable =
    !props.state.error?.recoveryRequired &&
    props.state.transportState === 'ready' &&
    props.state.conversationState !== 'legacy_readonly' &&
    props.state.conversationState !== 'waiting_approval' &&
    props.state.conversationState !== 'waiting_user_input';
  const active = props.state.conversationState === 'active_prework' || props.state.conversationState === 'active_final_answer';
  const paused = props.state.queue?.state.type === 'paused';

  useEffect(() => {
    if (editingId && !queue.some((submission) => submission.id === editingId)) {
      setEditingId(null);
      setEditDraft('');
      setEditError(null);
    }
  }, [editingId, queue]);

  useLayoutEffect(() => {
    if (!editingId || !textareaRef.current) return;
    textareaRef.current.focus();
    autosizeTextarea(textareaRef.current, 72, 0.42);
  }, [editDraft, editingId]);

  if (queue.length === 0 || props.state.error?.recoveryRequired || props.state.snapshot?.providerState === 'failed' || props.state.snapshot?.providerState === 'closed') return null;

  async function saveEdit(event: FormEvent<HTMLFormElement>, submission: NativeQueuedSubmission): Promise<void> {
    event.preventDefault();
    if (!props.onEdit || !editDraft.trim() || saving) return;
    setSaving(true);
    setEditError(null);
    try {
      await props.onEdit(submission.id, editDraft.trim());
      setEditingId(null);
      setEditDraft('');
    } catch {
      setEditError(copy.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  function reorder(submission: NativeQueuedSubmission, direction: number): void {
    const orderedIds = moveQueueSubmission(queue, submission.id, direction);
    if (orderedIds.every((id, index) => id === queue[index]?.id)) return;
    const position = orderedIds.indexOf(submission.id) + 1;
    setAnnouncement(copy.reordered(position, orderedIds.length));
    void props.onReorder?.(orderedIds);
  }

  function cancelEdit(): void {
    setEditingId(null);
    setEditDraft('');
    setEditError(null);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    cancelEdit();
  }

  return (
    <section className="session-queued-messages" aria-label={copy.region}>
      <output className="session-sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </output>
      <ol>
        {queue.map((submission, index) => (
          <li key={submission.id}>
            <article className="session-thread-item session-thread-item-user session-queued-message" data-queue-status={submission.status}>
              <header className="session-thread-item-meta">
                <span className="session-queued-message-status">
                  <span aria-hidden="true" />
                  {paused || submission.status === 'paused' ? copy.paused : copy.queued}
                </span>
              </header>
              {editingId === submission.id ? (
                <form className="session-queued-message-editor" onSubmit={(event) => void saveEdit(event, submission)}>
                  <label className="session-sr-only" htmlFor={`queued-message-${submission.id}`}>
                    {copy.editLabel}
                  </label>
                  <textarea
                    id={`queued-message-${submission.id}`}
                    ref={textareaRef}
                    value={editDraft}
                    disabled={saving}
                    aria-keyshortcuts="Escape"
                    onChange={(event) => setEditDraft(event.currentTarget.value)}
                    onKeyDown={handleEditKeyDown}
                  />
                  <footer>
                    {editError ? <small role="alert">{editError}</small> : <span />}
                    <button type="button" onClick={cancelEdit} disabled={saving}>
                      {copy.cancel}
                    </button>
                    <button type="submit" disabled={!editDraft.trim() || saving}>
                      {copy.save}
                    </button>
                  </footer>
                </form>
              ) : (
                <>
                  {submission.content.trim() ? <SafeMarkdown text={submission.content} language={props.language} /> : <p className="session-queued-message-empty">{copy.attachmentOnly}</p>}
                  {submission.attachments?.length ? (
                    <ul className="session-queued-message-attachments" aria-label={copy.attachments}>
                      {submission.attachments.map((attachment) => (
                        <li key={`${attachment.name}:${attachment.localPath ?? attachment.uploadRef ?? ''}`}>{attachment.name}</li>
                      ))}
                    </ul>
                  ) : null}
                </>
              )}
              {editingId === submission.id ? null : (
                <footer className="session-queued-message-actions">
                  {index === 0 && props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'interrupted' ? (
                    <button type="button" onClick={() => void props.onResume?.()} disabled={!writable || busy || !props.onResume}>
                      {copy.resume}
                    </button>
                  ) : index === 0 && props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'provider_archived' ? (
                    <button type="button" onClick={() => void props.onRetry?.()} disabled={!writable || busy || !props.onRetry}>
                      {copy.retry}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(submission.id);
                      setEditDraft(submission.content);
                      setEditError(null);
                    }}
                    disabled={!writable || busy || !props.onEdit}
                  >
                    {copy.edit}
                  </button>
                  <button type="button" onClick={() => void props.onDelete?.(submission.id)} disabled={!writable || busy || !props.onDelete}>
                    {copy.remove}
                  </button>
                  <button type="button" onClick={() => void props.onSendNow?.(submission.id)} disabled={!active || !writable || busy || !props.onSendNow || submission.status !== 'queued'}>
                    {copy.sendNow}
                  </button>
                  <button type="button" onClick={() => reorder(submission, -1)} disabled={!writable || busy || !props.onReorder || index === 0}>
                    {copy.moveUp}
                  </button>
                  <button type="button" onClick={() => reorder(submission, 1)} disabled={!writable || busy || !props.onReorder || index === queue.length - 1}>
                    {copy.moveDown}
                  </button>
                </footer>
              )}
            </article>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null): NativeQueuedSubmission[] {
  return [...(queue?.submissions ?? [])]
    .filter((submission) => (submission.status === 'queued' || submission.status === 'paused') && !submission.providerTurnId)
    .sort((left, right) => left.position - right.position || (left.createdAt ?? '').localeCompare(right.createdAt ?? '') || left.id.localeCompare(right.id));
}

function moveQueueSubmission(queue: readonly NativeQueuedSubmission[], submissionId: string, direction: number): string[] {
  const ids = queue.map((submission) => submission.id);
  const currentIndex = ids.indexOf(submissionId);
  if (currentIndex < 0) return ids;
  const targetIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + direction));
  if (targetIndex === currentIndex) return ids;
  const [moved] = ids.splice(currentIndex, 1);
  if (moved) ids.splice(targetIndex, 0, moved);
  return ids;
}
