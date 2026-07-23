import {
    type KeyboardEvent,
    type PointerEvent,
    type RefObject,
    useEffect,
    useLayoutEffect,
    useRef,
    useState
} from 'react';
import type {
    CodexConversationCapabilities,
    NativeCollaborationMode,
    NativeConversationAttachment,
    NativePermissionMode,
    NativeQueuedSubmission,
    NativeSessionState,
    NativeTurnSettingsSelection
} from './sessionTypes.js';
import {ComposerDropdown} from './ComposerDropdown.js';
import {PermissionModeControl} from './PermissionModeControl.js';
import type {SessionUiLanguage} from './ThreadItemView.js';
import {autosizeTextarea} from './textareaAutosize.js';
import {CollaborationModeControl} from './CollaborationModeControl.js';

export const QUEUE_REORDER_THRESHOLD_PX = 6;

export type ComposerKeyIntent = 'submit' | 'newline' | 'escape' | 'ignore';

export interface ConversationComposerProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
    capabilities?: CodexConversationCapabilities | null;
  onDraftChange: (draft: string) => void;
    onSubmit: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => void | Promise<void>;
  onInterrupt: (turnId: string) => void | Promise<void>;
  onChooseAttachments?: () => void | Promise<void>;
  onRemoveAttachment?: (attachment: NativeConversationAttachment) => void;
  onEditQueuedSubmission?: (submissionId: string, content: string) => void | Promise<void>;
  onDeleteQueuedSubmission?: (submissionId: string) => void | Promise<void>;
  onSendQueuedNow?: (submissionId: string) => void | Promise<void>;
  onReorderQueue?: (orderedSubmissionIds: string[]) => void | Promise<void>;
  onResumeQueue?: () => void | Promise<void>;
    onRetryQueue?: () => void | Promise<void>;
  readOnly?: boolean;
  permissionMode: NativePermissionMode;
  onPermissionModeChange?: (permissionMode: NativePermissionMode) => void | Promise<void>;
    collaborationMode: NativeCollaborationMode;
    onCollaborationModeChange?: (collaborationMode: NativeCollaborationMode) => void | Promise<void>;
}

const labels = {
  'zh-CN': {
    input: '发送消息给 Codex',
    placeholder: '继续对话，Enter 发送，Shift+Enter 换行',
    send: '发送',
    stop: '停止',
    queue: '排队',
    steer: '立即引导',
    attach: '添加附件',
    removeAttachment: '移除附件',
    queued: '待发送',
    edit: '编辑队列消息',
    save: '保存队列消息',
    cancel: '取消编辑',
    remove: '删除队列消息',
    sendNow: '立即发送队列消息',
    moveUp: '上移队列消息',
    moveDown: '下移队列消息',
    drag: '拖动队列消息',
    resume: '继续队列',
      retry: '重试发送',
    interruptConfirm: '再次按 Escape 停止当前响应',
    model: '模型',
    effort: '推理强度',
    unsynced: '未同步',
    reordered: (position: number, total: number) => `队列消息已移到第 ${position} 项，共 ${total} 项`,
  },
  'en-US': {
    input: 'Message Codex',
    placeholder: 'Continue the conversation. Enter to send, Shift+Enter for a newline.',
    send: 'Send',
    stop: 'Stop',
    queue: 'Queue',
    steer: 'Steer',
    attach: 'Add attachment',
    removeAttachment: 'Remove attachment',
    queued: 'Queued',
    edit: 'Edit queued message',
    save: 'Save queued message',
    cancel: 'Cancel queue edit',
    remove: 'Delete queued message',
    sendNow: 'Send queued message now',
    moveUp: 'Move queued message up',
    moveDown: 'Move queued message down',
    drag: 'Drag queued message',
    resume: 'Resume queue',
      retry: 'Retry sending',
    interruptConfirm: 'Press Escape again to stop the current response',
    model: 'Model',
    effort: 'Reasoning effort',
    unsynced: 'Not synced',
    reordered: (position: number, total: number) => `Queued message moved to position ${position} of ${total}`,
  },
} as const;

export function ConversationComposer(props: ConversationComposerProps) {
  const copy = labels[props.language];
    const initialModel = resolveComposerModel(props.capabilities, props.state.providerSettings?.model);
    const initialEffort = resolveComposerEffort(props.capabilities, initialModel, props.state.providerSettings?.effort);
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = props.textareaRef ?? fallbackRef;
  const [delivery, setDelivery] = useState<'queue' | 'steer_now'>('queue');
  const [isComposing, setIsComposing] = useState(false);
  const [editingSubmissionId, setEditingSubmissionId] = useState<string | null>(null);
  const [queueEditDraft, setQueueEditDraft] = useState('');
  const [queueEditError, setQueueEditError] = useState<string | null>(null);
  const [queueAnnouncement, setQueueAnnouncement] = useState('');
    const [selectedModel, setSelectedModel] = useState(initialModel);
    const [selectedEffort, setSelectedEffort] = useState(initialEffort);
    const [settingsDirty, setSettingsDirty] = useState(false);
  const pointerStarts = useRef(new Map<string, { x: number; y: number }>());
  const active = props.state.conversationState === 'active_prework' || props.state.conversationState === 'active_final_answer';
  const busy = Boolean(props.state.busyOperation);
  const writable =
    props.readOnly !== true &&
    !props.state.error?.recoveryRequired &&
    props.state.transportState === 'ready' &&
    props.state.conversationState !== 'legacy_readonly' &&
    props.state.conversationState !== 'waiting_approval' &&
    props.state.conversationState !== 'waiting_user_input';
  const hasDraft = props.state.draft.trim().length > 0;
  const queue = props.state.queue?.submissions ?? [];
  const steerAllowed = canSteerActiveTurn(props.state) && props.readOnly !== true;
    const selectedCapability = props.capabilities?.models.find((candidate) => candidate.model === selectedModel || candidate.id === selectedModel) ?? null;
    const settingsWritable = writable && props.state.conversationState === 'native_idle' && !busy && Boolean(selectedCapability);
    const modelOptions = props.capabilities?.models.length
        ? props.capabilities.models.map((capability) => ({
            value: capability.model,
            label: capability.displayName ?? capability.model
        }))
        : [{value: selectedModel, label: selectedModel || copy.unsynced}];
    const effortOptions = selectedCapability?.supportedReasoningEfforts.length
        ? selectedCapability.supportedReasoningEfforts.map((effort) => ({value: effort, label: effort}))
        : [{value: selectedEffort, label: selectedEffort || copy.unsynced}];

    useEffect(() => {
        const nextModel = resolveComposerModel(props.capabilities, props.state.providerSettings?.model);
        const nextEffort = resolveComposerEffort(props.capabilities, nextModel, props.state.providerSettings?.effort);
        if (!settingsDirty) {
            if (nextModel !== selectedModel) setSelectedModel(nextModel);
            if (nextEffort !== selectedEffort) setSelectedEffort(nextEffort);
            return;
        }
        if (props.state.providerSettings?.model === selectedModel && (props.state.providerSettings?.effort ?? '') === selectedEffort) setSettingsDirty(false);
    }, [props.capabilities, props.state.providerSettings?.effort, props.state.providerSettings?.model, selectedEffort, selectedModel, settingsDirty]);

  useEffect(() => {
    if (!steerAllowed && delivery === 'steer_now') setDelivery('queue');
  }, [delivery, steerAllowed]);

    useLayoutEffect(() => {
        if (textareaRef.current) autosizeTextarea(textareaRef.current);
    }, [props.state.draft, textareaRef]);

    useEffect(() => {
        const textarea = textareaRef.current;
        const view = textarea?.ownerDocument.defaultView;
        if (!textarea || !view) return;
        const resize = () => autosizeTextarea(textarea);
        view.addEventListener('resize', resize);
        return () => view.removeEventListener('resize', resize);
    }, [textareaRef]);

    function submit(nextDelivery: 'queue' | 'steer_now'): void {
        const settings = nextDelivery === 'queue' && selectedModel ? {
            model: selectedModel, ...(selectedEffort ? {effort: selectedEffort} : {}),
            collaborationMode: props.collaborationMode
        } : undefined;
        void props.onSubmit(nextDelivery, settings);
    }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const intent = resolveComposerKeyIntent({ key: event.key, shiftKey: event.shiftKey, isComposing: isComposing || event.nativeEvent.isComposing, repeat: event.repeat });
    if (intent === 'submit') {
      event.preventDefault();
        if (props.state.draft.trim() === '/plan' && props.onCollaborationModeChange) {
            props.onDraftChange('');
            void props.onCollaborationModeChange(props.collaborationMode === 'plan' ? 'default' : 'plan');
            return;
        }
        if (writable && hasDraft && !busy) submit(active && delivery === 'steer_now' && steerAllowed ? 'steer_now' : 'queue');
      return;
    }
    // Escape 由 SessionWorkspace capture 统一处理，保证 approval/RUI 层优先于 interrupt。
  }

  function handleQueuePointerUp(event: PointerEvent<HTMLSpanElement>, submission: NativeQueuedSubmission): void {
    const start = pointerStarts.current.get(submission.id);
    pointerStarts.current.delete(submission.id);
    if (!start) return;
    releasePointerCapture(event.currentTarget, event.pointerId);
    if (!shouldCommitQueueReorder(start, { x: event.clientX, y: event.clientY })) return;
    const orderedIds = moveQueueSubmissionByPixels(queue, submission.id, event.clientY - start.y);
    announceQueuePosition(orderedIds, submission.id);
    void props.onReorderQueue?.(orderedIds);
  }

  function announceQueuePosition(orderedIds: string[], submissionId: string): void {
    const position = orderedIds.indexOf(submissionId) + 1;
    if (position > 0) setQueueAnnouncement(copy.reordered(position, orderedIds.length));
  }

  return (
    <section className="session-composer-shell" aria-label={copy.input} data-active={active ? 'true' : 'false'}>
      {queue.length > 0 ? (
        <section className="session-queue" aria-label={copy.queued}>
          <header>
            <strong>{copy.queued}</strong>
              {props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'interrupted' ? (
              <button type="button" onClick={() => void props.onResumeQueue?.()} disabled={!writable || busy}>
                {copy.resume}
              </button>
              ) : props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'provider_archived' ? (
                  <button type="button" onClick={() => void props.onRetryQueue?.()} disabled={!writable || busy}>
                      {copy.retry}
                  </button>
            ) : null}
          </header>
          <ol>
            {queue.map((submission, index) => (
              <li key={submission.id} data-queue-submission-id={submission.id}>
                <span
                  className="session-queue-drag-handle"
                  title={copy.drag}
                  aria-hidden="true"
                  onPointerDown={(event) => {
                    if (writable && !busy) {
                      pointerStarts.current.set(submission.id, { x: event.clientX, y: event.clientY });
                      capturePointer(event.currentTarget, event.pointerId);
                    }
                  }}
                  onPointerUp={(event) => handleQueuePointerUp(event, submission)}
                  onPointerCancel={(event) => {
                    pointerStarts.current.delete(submission.id);
                    releasePointerCapture(event.currentTarget, event.pointerId);
                  }}
                >
                  ⋮⋮
                </span>
                {editingSubmissionId === submission.id ? (
                  <label className="session-queue-editor">
                    <span className="session-sr-only">{copy.edit}</span>
                    <textarea value={queueEditDraft} onChange={(event) => setQueueEditDraft(event.currentTarget.value)} />
                    <span>
                      <button
                        type="button"
                        onClick={async () => {
                          setQueueEditError(null);
                          const saved = await saveQueuedSubmissionEdit(submission.id, queueEditDraft, props.onEditQueuedSubmission);
                          if (saved) setEditingSubmissionId(null);
                          else setQueueEditError(props.language === 'zh-CN' ? '保存失败，编辑内容已保留。' : 'Save failed. Your edit is preserved.');
                        }}
                        disabled={!queueEditDraft.trim() || !writable || busy}
                      >
                        {copy.save}
                      </button>
                      <button type="button" onClick={() => setEditingSubmissionId(null)} disabled={busy}>
                        {copy.cancel}
                      </button>
                    </span>
                    {queueEditError ? <small role="alert">{queueEditError}</small> : null}
                  </label>
                ) : (
                  <>
                    <span className="session-queue-copy">{submission.content}</span>
                    <span className="session-queue-actions">
                      <button
                        type="button"
                        aria-label={copy.edit}
                        onClick={() => {
                          setQueueEditDraft(submission.content);
                          setEditingSubmissionId(submission.id);
                        }}
                        disabled={!writable || busy}
                      >
                        <span className="session-queue-action-icon" aria-hidden="true">
                          ✎
                        </span>
                        <span className="session-queue-action-label">{copy.edit}</span>
                      </button>
                      <button type="button" aria-label={copy.remove} onClick={() => void props.onDeleteQueuedSubmission?.(submission.id)} disabled={!writable || busy}>
                        <span className="session-queue-action-icon" aria-hidden="true">
                          ×
                        </span>
                        <span className="session-queue-action-label">{copy.remove}</span>
                      </button>
                      <button type="button" aria-label={copy.sendNow}
                              onClick={() => void props.onSendQueuedNow?.(submission.id)}
                              disabled={!active || !writable || busy}>
                        <span className="session-queue-action-icon" aria-hidden="true">
                          ↥
                        </span>
                        <span className="session-queue-action-label">{copy.sendNow}</span>
                      </button>
                      <button
                        type="button"
                        aria-label={copy.moveUp}
                        onClick={() => {
                          const ordered = moveQueueSubmission(queue, submission.id, -1);
                          announceQueuePosition(ordered, submission.id);
                          void props.onReorderQueue?.(ordered);
                        }}
                        disabled={index === 0 || !writable || busy}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        aria-label={copy.moveDown}
                        onClick={() => {
                          const ordered = moveQueueSubmission(queue, submission.id, 1);
                          announceQueuePosition(ordered, submission.id);
                          void props.onReorderQueue?.(ordered);
                        }}
                        disabled={index === queue.length - 1 || !writable || busy}
                      >
                        ↓
                      </button>
                    </span>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <output className="session-sr-only" aria-live="polite" aria-atomic="true">
        {queueAnnouncement}
      </output>
      {props.state.attachments.length > 0 ? (
        <ul className="session-composer-attachments" aria-label={props.language === 'zh-CN' ? '待发送附件' : 'Pending attachments'}>
          {props.state.attachments.map((attachment) => (
            <li key={attachment.localPath ?? attachment.uploadRef}>
              <span>{attachment.name}</span>
              <small>{formatBytes(attachment.size)}</small>
              <button type="button" aria-label={`${copy.removeAttachment}: ${attachment.name}`} onClick={() => props.onRemoveAttachment?.(attachment)} disabled={!writable || busy}>
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="session-composer-input-frame">
        <textarea
          ref={textareaRef}
          aria-label={copy.input}
          aria-keyshortcuts="Enter Shift+Enter Escape Meta+A Control+A"
          placeholder={copy.placeholder}
          value={props.state.draft}
          disabled={!writable || busy}
          onChange={(event) => {
              autosizeTextarea(event.currentTarget);
              props.onDraftChange(event.currentTarget.value);
          }}
          onCompositionStart={() => setIsComposing(true)}
          onCompositionEnd={() => setIsComposing(false)}
          onKeyDown={handleKeyDown}
        />
        <div className="session-composer-command-row">
          <span className="session-composer-leading-actions">
            {props.onChooseAttachments ? (
              <button type="button" aria-label={copy.attach} onClick={() => void props.onChooseAttachments?.()} disabled={!writable || busy}>
                <span aria-hidden="true">＋</span>
              </button>
            ) : null}
              <span className="session-composer-runtime-settings">
              <ComposerDropdown
                  label={copy.model}
                  value={selectedModel}
                  options={modelOptions}
                  disabled={!settingsWritable}
                  onChange={(model) => {
                      const capability = props.capabilities?.models.find((candidate) => candidate.model === model || candidate.id === model);
                      setSelectedModel(model);
                      setSelectedEffort(capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '');
                      setSettingsDirty(true);
                  }}
              />
              <ComposerDropdown
                  label={copy.effort}
                  value={selectedEffort}
                  options={effortOptions}
                  disabled={!settingsWritable || !selectedCapability?.supportedReasoningEfforts.length}
                  onChange={(effort) => {
                      setSelectedEffort(effort);
                      setSettingsDirty(true);
                  }}
              />
            </span>
            <PermissionModeControl
              language={props.language}
              value={props.permissionMode}
              disabled={props.state.transportState !== 'ready' || props.state.conversationState !== 'native_idle' || busy || !props.onPermissionModeChange}
              onChange={(permissionMode) => props.onPermissionModeChange?.(permissionMode)}
            />
            <CollaborationModeControl
                language={props.language}
                value={props.collaborationMode}
                disabled={props.state.transportState !== 'ready' || busy || !props.onCollaborationModeChange}
                onChange={(mode) => props.onCollaborationModeChange?.(mode)}
            />
          </span>
          <span className="session-composer-trailing-actions">
            {active ? (
              <span className="session-delivery-mode" role="group" aria-label={props.language === 'zh-CN' ? '活动轮次发送方式' : 'Active turn delivery'}>
                <button type="button" aria-pressed={delivery === 'queue'} onClick={() => setDelivery('queue')} disabled={!writable || busy}>
                  {copy.queue}
                </button>
                <button type="button" aria-pressed={delivery === 'steer_now'} onClick={() => setDelivery('steer_now')} disabled={!writable || busy || !steerAllowed}>
                  {copy.steer}
                </button>
                {hasDraft ? (
                  <button
                    type="button"
                    className="session-active-draft-submit"
                    onClick={() => submit(delivery === 'steer_now' && steerAllowed ? 'steer_now' : 'queue')}
                    disabled={!writable || busy || (delivery === 'steer_now' && !steerAllowed)}
                    aria-label={delivery === 'queue' ? copy.queue : copy.steer}
                  >
                    ↑
                  </button>
                ) : null}
              </span>
            ) : null}
            <span className="session-primary-command-slot" data-primary-command-slot="true">
              {active ? (
                <button
                  type="button"
                  className="session-stop-button"
                  aria-label={copy.stop}
                  onClick={() => props.state.activeTurnId && void props.onInterrupt(props.state.activeTurnId)}
                  disabled={!writable || !props.state.activeTurnId || props.state.startedTurnId !== props.state.activeTurnId || busy}
                >
                  <span aria-hidden="true" />
                </button>
              ) : (
                  <button type="button" className="session-send-button" aria-label={copy.send}
                          onClick={() => submit('queue')} disabled={!writable || !hasDraft || busy}
                          aria-busy={busy || undefined}>
                  {busy ? <span className="session-command-spinner" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
                </button>
              )}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

export function resolveComposerKeyIntent(input: { key: string; shiftKey: boolean; isComposing: boolean; repeat: boolean }): ComposerKeyIntent {
  if (input.repeat) return 'ignore';
  if (input.key === 'Escape') return 'escape';
  if (input.key !== 'Enter') return 'ignore';
  if (input.isComposing) return 'ignore';
  return input.shiftKey ? 'newline' : 'submit';
}

export function shouldCommitQueueReorder(start: { x: number; y: number }, current: { x: number; y: number }): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) >= QUEUE_REORDER_THRESHOLD_PX;
}

export function canSteerActiveTurn(state: NativeSessionState): boolean {
  const active = state.conversationState === 'active_prework' || state.conversationState === 'active_final_answer';
  return active && state.transportState === 'ready' && Boolean(state.activeTurnId) && state.startedTurnId === state.activeTurnId && !state.error?.recoveryRequired;
}

function resolveComposerModel(capabilities: CodexConversationCapabilities | null | undefined, providerModel: string | undefined): string {
    const normalized = providerModel?.trim();
    if (normalized && capabilities?.models.some((candidate) => candidate.model === normalized || candidate.id === normalized))
        return capabilities.models.find((candidate) => candidate.model === normalized || candidate.id === normalized)?.model ?? normalized;
    return capabilities?.preferredModel ?? capabilities?.models[0]?.model ?? normalized ?? '';
}

function resolveComposerEffort(capabilities: CodexConversationCapabilities | null | undefined, model: string, providerEffort: string | undefined): string {
    const capability = capabilities?.models.find((candidate) => candidate.model === model || candidate.id === model);
    const normalized = providerEffort?.trim();
    if (normalized && capability?.supportedReasoningEfforts.includes(normalized)) return normalized;
    return capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? normalized ?? '';
}

export function moveQueueSubmissionByPixels(queue: readonly NativeQueuedSubmission[], submissionId: string, deltaY: number, rowHeight = 38): string[] {
  if (!Number.isFinite(deltaY) || !Number.isFinite(rowHeight) || rowHeight <= 0) return queue.map((submission) => submission.id);
  if (Math.abs(deltaY) < QUEUE_REORDER_THRESHOLD_PX) return queue.map((submission) => submission.id);
  const positions = Math.max(1, Math.round(Math.abs(deltaY) / rowHeight));
  return moveQueueSubmission(queue, submissionId, deltaY >= 0 ? positions : -positions);
}

export async function saveQueuedSubmissionEdit(submissionId: string, content: string, save?: (submissionId: string, content: string) => void | Promise<void>): Promise<boolean> {
  if (!content.trim() || !save) return false;
  try {
    await save(submissionId, content);
    return true;
  } catch {
    return false;
  }
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

function capturePointer(target: Pick<HTMLElement, 'setPointerCapture'>, pointerId: number): void {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // 已结束的 pointer 可能不允许 capture；此时仍由后续事件安全收口。
  }
}

function releasePointerCapture(target: Pick<HTMLElement, 'releasePointerCapture'>, pointerId: number): void {
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // pointerup/cancel 后 release 只需 best-effort，不影响队列状态。
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
