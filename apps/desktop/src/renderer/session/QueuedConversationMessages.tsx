import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionState } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { autosizeTextarea } from './textareaAutosize.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

export interface QueuedConversationMessagesProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEdit?: (submissionId: string, content: string) => void | Promise<void>;
  onDelete?: (submissionId: string) => void | Promise<void>;
  onSendNow?: (submissionId: string) => void | Promise<void>;
  onRetrySubmission?: (submissionId: string) => void | Promise<void>;
  onRerouteSubmission?: (submissionId: string) => void | Promise<void>;
  onReorder?: (orderedSubmissionIds: string[]) => void | Promise<void>;
  onResume?: () => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

const labels = {
  'zh-CN': {
    region: '等待发送的后续消息',
    heading: (count: number) => `后续消息（${count}）`,
    active: '当前回复结束后按顺序自动发送。',
    dispatching: '第一条后续消息正在启动处理。',
    waitingUserInput: '完成上方选择后按顺序自动发送。',
    waitingApproval: '完成上方审批后按顺序自动发送。',
    waitingPlanConfirmation: '完成上方计划确认后按顺序自动发送。',
    preparingExecutionContext: '正在准备会话执行现场，完成后按顺序自动发送。',
    dispatchPending: '队首消息正在等待发送。',
    interrupted: '当前回复已中断，后续消息已暂停。',
    transportUnavailable: '连接恢复后继续处理后续消息。',
    providerArchived: '原会话已归档，恢复后由你确认发送。',
    conflictPreparing: '正在准备最新冲突现场，消息会在准备完成后按顺序发送。',
    conflictPreparationFailed: '冲突现场准备失败，当前会话和消息均已保留。',
    retryPreparation: '重试准备',
    uncertain: '部分消息的接收结果尚未确认，不会自动重发。',
    confirmationRequired: '这些消息需要你确认后再发送。',
    recoveryRequired: '消息派发或接收状态需要恢复，已暂停自动发送。',
    runtimeRejected: '运行时已明确拒绝这条消息，未进入模型历史；可重试、改用当前模型或取消。',
    planControl: '计划操作',
    edit: '编辑',
    editLabel: '编辑队列消息',
    save: '保存',
    cancel: '取消',
    remove: '删除',
    steer: '引导',
    steerHelp: '补充给当前回复，不中断当前执行',
    steerHeadOnly: '请先把消息上移到队首，再引导',
    steerUnavailable: '当前回复还未准备好接受引导',
    steerFailedFallback: '无法引导这条排队消息。',
    moveUp: '上移',
    moveDown: '下移',
    resume: '继续发送',
    retry: '恢复并发送',
    retrySameRoute: '重试原路由',
    rerouteCurrentModel: '改用当前模型',
    saveFailed: '保存失败，编辑内容已保留。',
    attachmentOnly: '仅附件消息',
    item: (position: number) => `第 ${position} 条`,
    attachmentCount: (count: number) => `${count} 个附件`,
    reordered: (position: number, total: number) => `队列消息已移到第 ${position} 项，共 ${total} 项`,
  },
  'en-US': {
    region: 'Follow-up messages waiting to send',
    heading: (count: number) => `Follow-ups (${count})`,
    active: 'Sends automatically in order after the current response.',
    dispatching: 'Starting the first follow-up.',
    waitingUserInput: 'Sends automatically in order after you answer above.',
    waitingApproval: 'Sends automatically in order after you approve above.',
    waitingPlanConfirmation: 'Sends automatically in order after you confirm the plan above.',
    preparingExecutionContext: 'Preparing the conversation workspace, then sends automatically in order.',
    dispatchPending: 'The first follow-up is waiting to be sent.',
    interrupted: 'The current response was interrupted. Follow-ups are paused.',
    transportUnavailable: 'Follow-ups continue after the connection recovers.',
    providerArchived: 'The original conversation is archived. Restore it to confirm sending.',
    conflictPreparing: 'Preparing the latest conflict workspace. Messages will send in order when it is ready.',
    conflictPreparationFailed: 'Conflict workspace preparation failed. This conversation and its messages were preserved.',
    retryPreparation: 'Retry preparation',
    uncertain: 'Some message delivery results are unconfirmed and will not resend automatically.',
    confirmationRequired: 'These messages need your confirmation before sending.',
    recoveryRequired: 'Message dispatch or delivery state requires recovery. Automatic sending is paused.',
    runtimeRejected: 'The runtime explicitly rejected this message before acceptance. Retry, reroute, or cancel it.',
    planControl: 'Plan action',
    edit: 'Edit',
    editLabel: 'Edit queued message',
    save: 'Save',
    cancel: 'Cancel',
    remove: 'Delete',
    steer: 'Steer',
    steerHelp: 'Add to the current response without interrupting it',
    steerHeadOnly: 'Move this message to the front before steering it',
    steerUnavailable: 'The current response is not ready to accept a steer',
    steerFailedFallback: 'Unable to steer this queued message.',
    moveUp: 'Move up',
    moveDown: 'Move down',
    resume: 'Resume sending',
    retry: 'Restore and send',
    retrySameRoute: 'Retry same route',
    rerouteCurrentModel: 'Use current model',
    saveFailed: 'Save failed. Your edit is preserved.',
    attachmentOnly: 'Attachment-only message',
    item: (position: number) => `Message ${position}`,
    attachmentCount: (count: number) => `${count} attachment${count === 1 ? '' : 's'}`,
    reordered: (position: number, total: number) => `Queued message moved to position ${position} of ${total}`,
  },
} as const;

export function QueuedConversationMessages(props: QueuedConversationMessagesProps) {
  const copy = labels[props.language];
  const queue = useMemo(() => visibleQueuedSubmissions(props.state.queue), [props.state.queue]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [steerError, setSteerError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [saving, setSaving] = useState(false);
  const [steeringId, setSteeringId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const busy = Boolean(props.state.busyOperation);
  const writable = props.state.transportState === 'ready' && props.state.conversationState !== 'legacy_readonly';
  const active = props.state.conversationState === 'active_prework' || props.state.conversationState === 'active_final_answer';
  const queueExplanation = describeQueueState(props.state, queue, copy);
  const attentionRequired = queue.some((submission) => submission.status === 'paused' && submission.pausedReason !== 'conflict_preparing');
  const [expanded, setExpanded] = useState(true);
  const previousQueueLengthRef = useRef(queue.length);

  useEffect(() => {
    if (attentionRequired) setExpanded(true);
  }, [attentionRequired]);

  useEffect(() => {
    if (previousQueueLengthRef.current === 0 && queue.length > 0) setExpanded(true);
    previousQueueLengthRef.current = queue.length;
  }, [queue.length]);

  useApplicationErrorDialog(editError, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    title: props.language === 'zh-CN' ? '队列消息保存失败' : 'Queued message failed to save',
    source: 'QueuedConversationMessages.saveEdit',
  });

  useApplicationErrorDialog(steerError, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    title: props.language === 'zh-CN' ? '排队消息引导失败' : 'Queued message steer failed',
    source: 'QueuedConversationMessages.steer',
  });

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

  if (queue.length === 0 || props.state.snapshot?.providerState === 'failed' || props.state.snapshot?.providerState === 'closed') return null;

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

  async function steer(submissionId: string): Promise<void> {
    if (!props.onSendNow || steeringId) return;
    setSteeringId(submissionId);
    setSteerError(null);
    try {
      await props.onSendNow(submissionId);
    } catch (error) {
      setSteerError(error instanceof Error ? error.message : typeof error === 'string' ? error : copy.steerFailedFallback);
    } finally {
      setSteeringId(null);
    }
  }

  return (
    <details className="session-queued-messages" aria-label={copy.region} open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary className="session-queued-messages-header">
        <strong>{copy.heading(queue.length)}</strong>
        <span role="status" aria-live="polite">
          {queueExplanation}
        </span>
      </summary>
      <output className="session-sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </output>
      <ol>
        {queue.map((submission, index) => (
          <li key={submission.id}>
            <article className="session-queued-message" data-queue-status={submission.status}>
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
                    <span />
                    <button type="button" onClick={cancelEdit} disabled={saving}>
                      {copy.cancel}
                    </button>
                    <button type="submit" disabled={!editDraft.trim() || saving}>
                      {copy.save}
                    </button>
                  </footer>
                </form>
              ) : (
                <div className="session-queued-message-content">
                  <p className="session-queued-message-reference">
                    <strong>{copy.item(index + 1)}</strong>
                    <span>{queuedMessagePreview(submission, copy.attachmentOnly)}</span>
                    {submission.controlAction ? <small>{copy.planControl}</small> : null}
                    {!submission.controlAction && (submission.attachments?.length ?? 0) > 0 ? <small>{copy.attachmentCount(submission.attachments!.length)}</small> : null}
                  </p>
                  {submission.error?.message ? (
                    <small className="session-queued-message-error" role="alert">
                      {submission.error.message}
                    </small>
                  ) : null}
                </div>
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
                  ) : index === 0 && props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'conflict_preparation_failed' ? (
                    <button type="button" onClick={() => void props.onResume?.()} disabled={!writable || busy || !props.onResume}>
                      {copy.retryPreparation}
                    </button>
                  ) : null}
                  {canReplaceFailedQueueHead(submission, index) ? (
                    <>
                      {canRetrySameRoute(submission) ? (
                        <button type="button" onClick={() => void props.onRetrySubmission?.(submission.id)} disabled={!writable || busy || !props.onRetrySubmission}>
                          {copy.retrySameRoute}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => void props.onRerouteSubmission?.(submission.id)} disabled={!writable || busy || !props.onRerouteSubmission}>
                        {copy.rerouteCurrentModel}
                      </button>
                    </>
                  ) : null}
                  {submission.controlAction ? null : (
                    <>
                      {active && submission.status === 'queued' ? (
                        <button
                          type="button"
                          className="session-queued-message-steer"
                          title={queuedSteerHelp(props.state, index, copy)}
                          aria-label={`${copy.steer}. ${queuedSteerHelp(props.state, index, copy)}`}
                          onClick={() => void steer(submission.id)}
                          disabled={!writable || busy || !props.onSendNow || !canSteerQueuedSubmission(props.state, index) || steeringId !== null}
                        >
                          {copy.steer}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          setEditingId(submission.id);
                          setEditDraft(queuedMessageEditDraft(submission));
                          setEditError(null);
                        }}
                        disabled={!writable || busy || !props.onEdit}
                      >
                        {copy.edit}
                      </button>
                      <button type="button" onClick={() => void props.onDelete?.(submission.id)} disabled={!writable || busy || !props.onDelete}>
                        {copy.remove}
                      </button>
                      <button type="button" onClick={() => reorder(submission, -1)} disabled={!writable || busy || !props.onReorder || index === 0 || Boolean(queue[index - 1]?.controlAction)}>
                        {copy.moveUp}
                      </button>
                      <button type="button" onClick={() => reorder(submission, 1)} disabled={!writable || busy || !props.onReorder || index === queue.length - 1}>
                        {copy.moveDown}
                      </button>
                    </>
                  )}
                </footer>
              )}
            </article>
          </li>
        ))}
      </ol>
    </details>
  );
}

function canReplaceFailedQueueHead(submission: NativeQueuedSubmission, index: number): boolean {
  if (index !== 0 || submission.status !== 'paused' || submission.providerTurnId) return false;
  if (submission.pausedReason === 'outcome_unknown') return false;
  return ['preflight_failed', 'runtime_rejected', 'recovery_required', 'semantic_route_changed', 'upgrade_interrupted', 'configuration_mismatch'].includes(submission.pausedReason ?? '');
}

function canRetrySameRoute(submission: NativeQueuedSubmission): boolean {
  return submission.pausedReason !== 'semantic_route_changed' && submission.pausedReason !== 'upgrade_interrupted' && submission.pausedReason !== 'configuration_mismatch';
}

function canSteerQueuedSubmission(state: NativeSessionState, index: number): boolean {
  return index === 0 && Boolean(state.activeTurnId) && state.startedTurnId === state.activeTurnId;
}

function queuedSteerHelp(state: NativeSessionState, index: number, copy: (typeof labels)[SessionUiLanguage]): string {
  if (canSteerQueuedSubmission(state, index)) return copy.steerHelp;
  return index === 0 ? copy.steerUnavailable : copy.steerHeadOnly;
}

function queuedMessagePreview(submission: NativeQueuedSubmission, attachmentOnly: string): string {
  const content = submission.content.trim();
  if (!content) return attachmentOnly;
  return content;
}

function queuedMessageEditDraft(submission: NativeQueuedSubmission): string {
  if (typeof submission.composerDraft === 'string') return submission.composerDraft;
  const content = submission.content.trim();
  if (submission.browserComments?.length && content === `Browser comments (${submission.browserComments.length})`) return '';
  const codeCommentCount = submission.conversationContext?.codeComments.length ?? 0;
  if (codeCommentCount > 0 && content === `Code comments (${codeCommentCount})`) return '';
  const responseAnnotationCount = submission.conversationContext?.responseAnnotations.length ?? 0;
  if (responseAnnotationCount > 0 && content === `Response annotations (${responseAnnotationCount})`) return '';
  return submission.content;
}

function describeQueueState(state: NativeSessionState, queue: readonly NativeQueuedSubmission[], copy: (typeof labels)[SessionUiLanguage]): string {
  const waitReason = state.queue?.waitReason ?? inferLegacyQueueWaitReason(state, queue);
  if (waitReason === 'current_turn') return copy.active;
  if (waitReason === 'dispatching') return copy.dispatching;
  if (waitReason === 'user_input') return copy.waitingUserInput;
  if (waitReason === 'approval') return copy.waitingApproval;
  if (waitReason === 'plan_confirmation') return copy.waitingPlanConfirmation;
  if (waitReason === 'execution_context_preparing') return copy.preparingExecutionContext;
  if (waitReason === 'interrupted') return copy.interrupted;
  if (waitReason === 'transport_unavailable') return copy.transportUnavailable;
  if (waitReason === 'provider_archived') return copy.providerArchived;
  if (waitReason === 'conflict_preparing') return copy.conflictPreparing;
  if (waitReason === 'conflict_preparation_failed') return copy.conflictPreparationFailed;
  if (waitReason === 'user_confirmation') return copy.confirmationRequired;
  if (waitReason === 'recovery_required') return queue.some((submission) => submission.error?.code === 'ZEUS_NATIVE_SUBMISSION_DELIVERY_UNCONFIRMED') ? copy.uncertain : copy.recoveryRequired;
  if (waitReason === 'runtime_rejected') return copy.runtimeRejected;
  return copy.dispatchPending;
}

function inferLegacyQueueWaitReason(state: NativeSessionState, queue: readonly NativeQueuedSubmission[]) {
  if (state.conversationState === 'waiting_user_input') return 'user_input' as const;
  if (state.conversationState === 'waiting_approval') return 'approval' as const;
  const runState = state.queue?.state;
  if (runState?.type === 'active') return 'current_turn' as const;
  if (runState?.type === 'dispatching') return 'dispatching' as const;
  if (runState?.type === 'waiting') return runState.reason;
  if (runState?.type === 'paused') return runState.reason;
  if (queue.some((submission) => submission.controlAction)) return 'plan_confirmation' as const;
  if (queue.length > 0 && queue.every((submission) => submission.pausedReason === 'user_confirmation')) return 'user_confirmation' as const;
  return 'dispatch_pending' as const;
}

export function visibleQueuedSubmissions(queue: NativeQueueSnapshot | null): NativeQueuedSubmission[] {
  return [...(queue?.submissions ?? [])]
    .filter((submission) => (submission.status === 'queued' || submission.status === 'dispatching' || submission.status === 'paused') && !submission.providerTurnId)
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
