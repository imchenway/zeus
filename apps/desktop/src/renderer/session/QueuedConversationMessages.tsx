import { type FormEvent, type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowBendUpRightIcon as ArrowBendUpRight } from '@phosphor-icons/react/dist/csr/ArrowBendUpRight';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ClockIcon as Clock } from '@phosphor-icons/react/dist/csr/Clock';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react/dist/csr/Paperclip';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { canSteerActiveTurn } from './ConversationComposer.js';
import { ConversationComposerAttachments } from './ConversationComposerAttachments.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { composerQueuedSubmissions, reorderableQueuedSubmissions } from './conversationQueuePresentation.js';
import type { NativeQueuedSubmission, NativeSessionState } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { autosizeTextarea } from './textareaAutosize.js';
import { formatAsyncQuestionAnswer } from '@zeus/shared';

/** 输入框上方排队卡片所需的权威操作。 */
export interface QueuedConversationMessagesProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  onEdit?: (submissionId: string, content: string) => void | Promise<void>;
  onDelete?: (submissionId: string) => void | Promise<void>;
  onSendNow?: (submissionId: string) => void | Promise<void>;
  onReorder?: (orderedSubmissionIds: string[]) => void | Promise<void>;
}

/** 排队卡片只保留当前操作需要的短文案。 */
const labels = {
  'zh-CN': {
    region: '排队消息',
    heading: (count: number) => `${count} 条排队消息`,
    queued: '排队中',
    attachmentOnly: '仅附件消息',
    edit: '编辑排队消息',
    editLabel: '编辑排队消息内容',
    editPlaceholder: '输入消息内容',
    editAttachmentPlaceholder: '添加说明（可选）',
    editShortcut: '⌘ Enter 保存',
    attachments: (count: number) => `${count} 个附件 · 附件保持不变`,
    save: '保存',
    cancel: '取消',
    steer: '引导到当前回复',
    steerHelp: '补充给当前回复，不中断当前执行',
    steerHeadOnly: '请先处理更早的排队消息',
    steerUnavailable: '当前回复还未准备好接受引导',
    remove: '删除排队消息',
    moveUp: '上移排队消息',
    moveDown: '下移排队消息',
    editFailed: '保存失败，编辑内容已保留。',
    actionFailed: '操作失败，请重试。',
    reordered: (position: number, total: number) => `排队消息已移到第 ${position} 项，共 ${total} 项`,
  },
  'en-US': {
    region: 'Queued messages',
    heading: (count: number) => `${count} queued message${count === 1 ? '' : 's'}`,
    queued: 'Queued',
    attachmentOnly: 'Attachment-only message',
    edit: 'Edit queued message',
    editLabel: 'Edit queued message content',
    editPlaceholder: 'Enter message content',
    editAttachmentPlaceholder: 'Add a note (optional)',
    editShortcut: '⌘ Enter to save',
    attachments: (count: number) => `${count} attachment${count === 1 ? '' : 's'} · Unchanged`,
    save: 'Save',
    cancel: 'Cancel',
    steer: 'Steer into the current response',
    steerHelp: 'Add to the current response without interrupting it',
    steerHeadOnly: 'Handle the earlier queued message first',
    steerUnavailable: 'The current response is not ready for steering',
    remove: 'Delete queued message',
    moveUp: 'Move queued message up',
    moveDown: 'Move queued message down',
    editFailed: 'Save failed. Your edit is preserved.',
    actionFailed: 'The action failed. Try again.',
    reordered: (position: number, total: number) => `Queued message moved to position ${position} of ${total}`,
  },
} as const;

/** 在输入框上方展示仍未进入供应商轮次的普通排队消息。 */
export function QueuedConversationMessages(props: QueuedConversationMessagesProps) {
  /** 当前语言对应的短文案。 */
  const copy = labels[props.language];
  /** 卡片只展示可安全编辑的普通等待项。 */
  const queue = useMemo(() => composerQueuedSubmissions(props.state), [props.state.itemOrder, props.state.items, props.state.queue]);
  /** 服务端重排要求携带完整可重排队列，不能只提交当前可见卡片。 */
  const reorderableQueue = useMemo(() => reorderableQueuedSubmissions(props.state.queue), [props.state.queue]);
  /** 当前展开编辑器的提交身份。 */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** 编辑器保留原始多行正文，普通卡片仍只显示一行摘要。 */
  const [editDraft, setEditDraft] = useState('');
  /** 当前进行中的操作用于阻止重复点击。 */
  const [actionId, setActionId] = useState<string | null>(null);
  /** 操作失败紧邻原消息展示，不污染整段会话。 */
  const [actionError, setActionError] = useState<{ submissionId: string; message: string } | null>(null);
  /** 排序结果通过礼貌播报提供给辅助技术。 */
  const [announcement, setAnnouncement] = useState('');
  /** 编辑器挂载后恢复键盘焦点。 */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 只有真实可写连接允许修改权威队列。 */
  const writable = props.state.transportState === 'ready' && props.state.conversationState !== 'legacy_readonly';
  /** 控制器操作和组件本地操作共同锁定按钮。 */
  const busy = Boolean(props.state.busyOperation || actionId);

  useEffect(() => {
    if (!editingId || queue.some((submission) => submission.id === editingId)) return;
    setEditingId(null);
    setEditDraft('');
  }, [editingId, queue]);

  useLayoutEffect(() => {
    if (!editingId || !textareaRef.current) return;
    textareaRef.current.focus();
    autosizeTextarea(textareaRef.current, 42, 0.34);
  }, [editDraft, editingId]);

  if (queue.length === 0 || props.state.snapshot?.providerState === 'failed' || props.state.snapshot?.providerState === 'closed') return null;

  /** 进入编辑态时优先恢复用户在 Composer 中实际输入的草稿。 */
  function startEdit(submission: NativeQueuedSubmission): void {
    setEditingId(submission.id);
    setEditDraft(queuedMessageEditDraft(submission));
    setActionError(null);
  }

  /** 退出编辑态但不触碰权威排队内容。 */
  function cancelEdit(): void {
    setEditingId(null);
    setEditDraft('');
    setActionError(null);
  }

  /** Escape 关闭编辑器；Command 或 Control 加 Enter 保存多行内容。 */
  function handleEditKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
      return;
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  /** 保存仍使用原提交身份，服务端负责原子替换排队内容。 */
  async function saveEdit(event: FormEvent<HTMLFormElement>, submission: NativeQueuedSubmission): Promise<void> {
    event.preventDefault();
    if (!props.onEdit || !editDraft.trim() || busy) return;
    setActionId(`edit:${submission.id}`);
    setActionError(null);
    try {
      await props.onEdit(submission.id, editDraft.trim());
      setEditingId(null);
      setEditDraft('');
    } catch (error) {
      setActionError({ submissionId: submission.id, message: actionErrorMessage(error, copy.editFailed) });
    } finally {
      setActionId(null);
    }
  }

  /** 所有单击操作共用忙碌态和消息旁错误反馈。 */
  async function runAction(submissionId: string, action: string, operation: (() => void | Promise<void>) | undefined): Promise<boolean> {
    if (!operation || busy) return false;
    setActionId(`${action}:${submissionId}`);
    setActionError(null);
    try {
      await operation();
      return true;
    } catch (error) {
      setActionError({ submissionId, message: actionErrorMessage(error, copy.actionFailed) });
      return false;
    } finally {
      setActionId(null);
    }
  }

  /** 按完整队列移动一位，避免遗漏隐藏的控制或恢复提交。 */
  async function reorder(submission: NativeQueuedSubmission, direction: -1 | 1): Promise<void> {
    if (!props.onReorder || busy || !canMoveQueueSubmission(reorderableQueue, queue, submission.id, direction)) return;
    /** 新顺序包含服务端认定的全部可重排成员。 */
    const orderedIds = moveQueueSubmission(reorderableQueue, submission.id, direction);
    /** 辅助技术播报使用真实完整队列位置。 */
    const position = orderedIds.indexOf(submission.id) + 1;
    if (await runAction(submission.id, 'reorder', () => props.onReorder?.(orderedIds))) setAnnouncement(copy.reordered(position, orderedIds.length));
  }

  return (
    <section className="session-queued-messages" aria-label={copy.region}>
      <h2 className="session-sr-only">{copy.heading(queue.length)}</h2>
      <output className="session-sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </output>
      <ol>
        {queue.map((submission) => {
          /** 本地待接纳投影只负责稳定首帧位置，服务端身份到达前禁止修改。 */
          const submissionWritable = writable && !submission.localOnly;
          /** 引导保持可聚焦，禁用原因通过标题和可访问名称说明。 */
          const steerReason = submission.localOnly ? copy.steerUnavailable : queuedSteerUnavailableReason(props.state, reorderableQueue, submission, copy);
          /** 上移只允许与相邻普通排队项交换。 */
          const canMoveUp = canMoveQueueSubmission(reorderableQueue, queue, submission.id, -1);
          /** 下移只允许与相邻普通排队项交换。 */
          const canMoveDown = canMoveQueueSubmission(reorderableQueue, queue, submission.id, 1);
          /** 当前行的错误保持在原提交旁。 */
          const rowError = actionError?.submissionId === submission.id ? actionError.message : submission.error?.message;
          /** 附件与正文分别投影，纯附件消息不再退化成空白或泛化占位。 */
          const attachments = submission.attachments ?? [];
          /** 折叠态正文保持单行，编辑态仍使用完整原稿。 */
          const textPreview = queuedMessageTextPreview(submission);
          return (
            <li key={submission.id}>
              <article className="session-queued-message" data-queue-status={submission.status} data-editing={editingId === submission.id || undefined} aria-busy={actionId?.endsWith(submission.id) || undefined}>
                {editingId === submission.id ? (
                  <form className="session-queued-message-editor" onSubmit={(event) => void saveEdit(event, submission)}>
                    {attachments.length > 0 ? (
                      <ConversationComposerAttachments attachments={attachments} language={props.language} disabled={busy} ariaLabel={copy.attachments(attachments.length)} className="session-queued-message-attachments" />
                    ) : null}
                    <label className="session-sr-only" htmlFor={`queued-message-${submission.id}`}>
                      {copy.editLabel}
                    </label>
                    <textarea
                      id={`queued-message-${submission.id}`}
                      ref={textareaRef}
                      value={editDraft}
                      disabled={busy}
                      placeholder={attachments.length > 0 ? copy.editAttachmentPlaceholder : copy.editPlaceholder}
                      aria-keyshortcuts="Meta+Enter Control+Enter Escape"
                      onChange={(event) => setEditDraft(event.currentTarget.value)}
                      onKeyDown={handleEditKeyDown}
                    />
                    <footer>
                      <small aria-hidden="true">{copy.editShortcut}</small>
                      <button type="button" className="session-queued-message-editor-cancel" onClick={cancelEdit} disabled={busy}>
                        {copy.cancel}
                      </button>
                      <button type="submit" className="session-queued-message-editor-save" disabled={!editDraft.trim() || busy}>
                        {copy.save}
                      </button>
                    </footer>
                  </form>
                ) : (
                  <div className="session-queued-message-content" title={queuedMessageAccessiblePreview(submission, copy.attachmentOnly, props.language)}>
                    <Clock aria-hidden="true" weight="regular" />
                    <span className="session-queued-message-state">{copy.queued}</span>
                    {textPreview ? <span className="session-queued-message-preview">{textPreview}</span> : null}
                    {attachments.length > 0 ? (
                      <span className="session-queued-message-attachment-summary" data-attachment-only={!textPreview || undefined}>
                        <Paperclip aria-hidden="true" />
                        <span>{queuedMessageAttachmentSummary(attachments, props.language)}</span>
                      </span>
                    ) : null}
                  </div>
                )}
                {editingId === submission.id ? null : (
                  <footer className="session-queued-message-actions">
                    <button type="button" title={copy.edit} aria-label={copy.edit} onClick={() => startEdit(submission)} disabled={!submissionWritable || busy || !props.onEdit}>
                      <PencilSimple aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="session-queued-message-steer"
                      title={steerReason ?? copy.steerHelp}
                      aria-label={`${copy.steer}. ${steerReason ?? copy.steerHelp}`}
                      aria-disabled={Boolean(!submissionWritable || busy || !props.onSendNow || steerReason)}
                      onClick={() => {
                        if (!submissionWritable || busy || !props.onSendNow || steerReason) return;
                        void runAction(submission.id, 'steer', () => props.onSendNow?.(submission.id));
                      }}
                    >
                      <ArrowBendUpRight aria-hidden="true" weight="bold" />
                    </button>
                    <button
                      type="button"
                      className="session-queued-message-delete"
                      title={copy.remove}
                      aria-label={copy.remove}
                      onClick={() => void runAction(submission.id, 'delete', () => props.onDelete?.(submission.id))}
                      disabled={!submissionWritable || busy || !props.onDelete}
                    >
                      <Trash aria-hidden="true" />
                    </button>
                    <button type="button" title={copy.moveUp} aria-label={copy.moveUp} onClick={() => void reorder(submission, -1)} disabled={!submissionWritable || busy || !props.onReorder || !canMoveUp}>
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button type="button" title={copy.moveDown} aria-label={copy.moveDown} onClick={() => void reorder(submission, 1)} disabled={!submissionWritable || busy || !props.onReorder || !canMoveDown}>
                      <ArrowDown aria-hidden="true" />
                    </button>
                  </footer>
                )}
                {rowError ? (
                  <small className="session-queued-message-error" role="alert">
                    <VisibleApplicationError error={rowError} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
                  </small>
                ) : null}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 优先展示 Composer 原始草稿，避免把结构化摘要写回正文。 */
function queuedMessageEditDraft(submission: NativeQueuedSubmission): string {
  return typeof submission.composerDraft === 'string' ? submission.composerDraft : submission.content;
}

/** 问题回答优先展示答案；已编辑的正文及普通消息保留原稿，附件单独展示。 */
function queuedMessageTextPreview(submission: NativeQueuedSubmission): string {
  /** 展示摘要不能改变发送给模型的完整原稿。 */
  const draft = submission.composerDraft?.trim() || submission.content.trim();
  /** 只读取明确绑定原题的结构化答案。 */
  const answer = submission.questionAnswer;
  if (!answer) return draft;
  /** 复用原格式化入口核对原稿，避免排队编辑后仍展示旧答案。 */
  const answerAttachments = Object.fromEntries(Object.entries(answer.answerAttachmentIndices ?? {}).map(([id, indices]) => [id, indices.map((index) => submission.attachments?.[index]).filter((attachment) => attachment !== undefined)]));
  if (answer.questions?.length && draft !== formatAsyncQuestionAnswer(answer.questions, answer.answers, answerAttachments).trim()) return draft;
  return (
    Object.values(answer.answers)
      .flatMap((entry) => entry.answers)
      .join('；')
      .trim() || draft
  );
}

/** 附件摘要优先展示真实文件名，多附件时补充剩余数量。 */
function queuedMessageAttachmentSummary(attachments: Readonly<NonNullable<NativeQueuedSubmission['attachments']>>, language: SessionUiLanguage): string {
  const firstName = attachments[0]?.name ?? (language === 'zh-CN' ? '附件' : 'Attachment');
  if (attachments.length <= 1) return firstName;
  return language === 'zh-CN' ? `${firstName} 等 ${attachments.length} 个` : `${firstName} +${attachments.length - 1}`;
}

/** 标题合并正文与附件，鼠标和辅助技术都能获知被截断的完整内容。 */
function queuedMessageAccessiblePreview(submission: NativeQueuedSubmission, attachmentOnly: string, language: SessionUiLanguage): string {
  const text = queuedMessageTextPreview(submission);
  const attachments = submission.attachments ?? [];
  const attachmentSummary = attachments.length > 0 ? queuedMessageAttachmentSummary(attachments, language) : '';
  return [text || (attachmentSummary ? attachmentOnly : ''), attachmentSummary].filter(Boolean).join(' · ');
}

/** 只有普通队首且当前轮次可引导时开放引导操作。 */
function queuedSteerUnavailableReason(state: NativeSessionState, queue: readonly NativeQueuedSubmission[], submission: NativeQueuedSubmission, copy: (typeof labels)[SessionUiLanguage]): string | null {
  if (queue[0]?.id !== submission.id) return copy.steerHeadOnly;
  if (submission.status !== 'queued' || !canSteerActiveTurn(state)) return copy.steerUnavailable;
  return null;
}

/** 排序只交换相邻的可见普通 queued 项，不跨越控制、失败或恢复边界。 */
function canMoveQueueSubmission(fullQueue: readonly NativeQueuedSubmission[], visibleQueue: readonly NativeQueuedSubmission[], submissionId: string, direction: -1 | 1): boolean {
  /** 当前项必须仍是普通 queued，暂停项不能绕开队首闸机。 */
  const currentIndex = fullQueue.findIndex((submission) => submission.id === submissionId);
  /** 目标项必须同样出现在当前卡片区。 */
  const target = fullQueue[currentIndex + direction];
  /** 可见身份集合只用于约束相邻交换，不改变服务端完整顺序。 */
  const visibleIds = new Set(visibleQueue.map((submission) => submission.id));
  return currentIndex >= 0 && fullQueue[currentIndex]?.status === 'queued' && target?.status === 'queued' && visibleIds.has(target.id);
}

/** 返回服务端要求的完整新顺序，不原地修改 React 派生数组。 */
function moveQueueSubmission(queue: readonly NativeQueuedSubmission[], submissionId: string, direction: -1 | 1): string[] {
  /** 新数组保护权威快照不被视图层修改。 */
  const ids = queue.map((submission) => submission.id);
  /** 当前索引决定一次只移动一个相邻位置。 */
  const currentIndex = ids.indexOf(submissionId);
  if (currentIndex < 0) return ids;
  /** 目标索引严格限制在队列范围内。 */
  const targetIndex = Math.max(0, Math.min(ids.length - 1, currentIndex + direction));
  if (targetIndex === currentIndex) return ids;
  /** 被移动身份由 splice 原子取出后插入目标位置。 */
  const [moved] = ids.splice(currentIndex, 1);
  if (moved) ids.splice(targetIndex, 0, moved);
  return ids;
}

/** 将未知异常收敛为简短的用户可读反馈。 */
function actionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : typeof error === 'string' && error.trim() ? error : fallback;
}
