import { platformShortcutLabel } from '../platform.js';
import { type FormEvent, useLayoutEffect, useRef, useState } from 'react';
import { ArrowBendUpRightIcon as ArrowBendUpRight } from '@phosphor-icons/react/dist/csr/ArrowBendUpRight';
import { ArrowDownIcon as ArrowDown } from '@phosphor-icons/react/dist/csr/ArrowDown';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ClockIcon as Clock } from '@phosphor-icons/react/dist/csr/Clock';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react/dist/csr/Paperclip';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { TrashIcon as Trash } from '@phosphor-icons/react/dist/csr/Trash';
import { ConversationComposerAttachments, conversationAttachmentIdentity } from './ConversationComposerAttachments.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { useQueuedMessageReorder, type ReorderQueuedMessages } from './useQueuedMessageReorder.js';
import type { NativeConversationAttachment, NativeQueuedSubmission, NativeSessionState } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { useConversationInputResources } from './useConversationInputResources.js';
import { formatAsyncQuestionAnswer } from '@zeus/shared';
import { Form } from '../ui/Form.js';
import { Button } from '../ui/Button.js';
import { queuedSubmissionIdentity } from './conversationQueuePresentation.js';
import { useListReorderMotion } from '../ui/useListReorderMotion.js';
import { useNewItemMotionIds } from '../ui/useNewItemMotion.js';
import { MotionPresence, PopoverSurface } from '../ui/MotionPresence.js';

/** 输入框上方排队卡片所需的权威操作。 */
export interface QueuedConversationMessagesProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  /** 编辑正文和附件使用同一次权威替换。 */
  onEdit?: (submissionId: string, content: string, attachments: NativeConversationAttachment[]) => void | Promise<void>;
  onDelete?: (submissionId: string) => void | Promise<void>;
  /** 引导使用点击时显示的轮次，入队回执到达后仍指向该轮次。 */
  onSendNow?: (submissionId: string, expectedTurnId: string) => void | Promise<void>;
  /** 中断后由用户明确继续原队列，沿用既有恢复命令。 */
  onResumeQueue?: () => void | Promise<void>;
  /** 调序回执用于等待权威队列接管即时位置。 */
  onReorder?: ReorderQueuedMessages;
}

/** 排队卡片只保留当前操作需要的短文案。 */
const labels = {
  'zh-CN': {
    region: '排队消息',
    heading: (count: number) => `${count} 条排队消息`,
    queued: '排队中',
    paused: '已暂停',
    resume: '继续发送排队消息',
    resumeHelp: '继续发送已暂停的队列',
    attachmentOnly: '仅附件消息',
    edit: '编辑排队消息',
    editLabel: '编辑排队消息内容',
    editPlaceholder: '输入消息内容',
    editAttachmentPlaceholder: '添加说明（可选）',
    editShortcut: platformShortcutLabel('⌘ Enter 保存'),
    attachments: (count: number) => `${count} 个附件`,
    addAttachments: '添加附件',
    save: '保存',
    cancel: '取消',
    steer: '引导到当前回复',
    steerHelp: '补充给当前回复，不中断当前执行',
    remove: '删除排队消息',
    moveUp: '上移排队消息',
    moveDown: '下移排队消息',
    editFailed: '保存失败，编辑内容已保留。',
    editUnavailable: '消息已离开队列，仍可复制编辑内容。',
    actionFailed: '操作失败，请重试。',
    reordered: (position: number, total: number) => `排队消息已移到第 ${position} 项，共 ${total} 项`,
  },
  'en-US': {
    region: 'Queued messages',
    heading: (count: number) => `${count} queued message${count === 1 ? '' : 's'}`,
    queued: 'Queued',
    paused: 'Paused',
    resume: 'Resume queued messages',
    resumeHelp: 'Continue sending the paused queue',
    attachmentOnly: 'Attachment-only message',
    edit: 'Edit queued message',
    editLabel: 'Edit queued message content',
    editPlaceholder: 'Enter message content',
    editAttachmentPlaceholder: 'Add a note (optional)',
    editShortcut: platformShortcutLabel('⌘ Enter to save'),
    attachments: (count: number) => `${count} attachment${count === 1 ? '' : 's'}`,
    addAttachments: 'Add attachments',
    save: 'Save',
    cancel: 'Cancel',
    steer: 'Steer into the current response',
    steerHelp: 'Add to the current response without interrupting it',
    remove: 'Delete queued message',
    moveUp: 'Move queued message up',
    moveDown: 'Move queued message down',
    editFailed: 'Save failed. Your edit is preserved.',
    editUnavailable: 'The message has left the queue. You can still copy your edit.',
    actionFailed: 'The action failed. Try again.',
    reordered: (position: number, total: number) => `Queued message moved to position ${position} of ${total}`,
  },
} as const;

/** 按消息和操作去重，队列控制器负责写入顺序。 */
type QueueAction = 'edit' | 'delete' | 'steer' | 'resume';

/** 请求已改变队列时，保留原卡片直至退出动效结束。 */
interface QueueCardExit {
  submission: NativeQueuedSubmission;
  index: number;
  confirmed: boolean;
}

/** 在输入框上方展示仍未进入供应商轮次的普通排队消息。 */
export function QueuedConversationMessages(props: QueuedConversationMessagesProps) {
  /** 当前语言对应的短文案。 */
  const copy = labels[props.language];
  /** 独立保存草稿，切换卡片时仍保留正在写入或失败的编辑。 */
  const [editingRows, setEditingRows] = useState<ReadonlyMap<string, NativeQueuedSubmission>>(() => new Map());
  /** 连续点击同一个动作只提交一次，其他操作照常接收点击。 */
  const actionRef = useRef(new Set<string>());
  /** 写入进度只用于原按钮的反馈。 */
  const [actions, setActions] = useState<ReadonlySet<string>>(() => new Set());
  /** 引导或删除从点击开始退出，成功回执只确认最终移除。 */
  const [exits, setExits] = useState<ReadonlyMap<string, QueueCardExit>>(() => new Map());
  /** 操作失败紧邻原消息展示，不污染整段会话。 */
  const [actionErrors, setActionErrors] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** 原消息的高亮与辅助播报使用稳定提交身份。 */
  const [reorderFeedback, setReorderFeedback] = useState<{ submissionId: string } | null>(null);
  /** 移动后在当前排队区查找原消息，不依赖改变后的行号。 */
  const regionRef = useRef<HTMLDivElement>(null);
  /** 换位后立即恢复原按钮焦点，不等待保存回执。 */
  const reorderFocusRef = useRef<HTMLButtonElement | null>(null);
  /** 从编辑态退出时回到原卡片的编辑入口。 */
  const editFocusRef = useRef<string | null>(null);
  /** 展示顺序即时更新，持久化仍走原会话队列入口。 */
  const ordering = useQueuedMessageReorder({
    state: props.state,
    isExiting: (submission) => exits.has(queuedSubmissionIdentity(submission)),
    onReorder: props.onReorder,
    /** 保存失败恢复原卡片的错误展示并清除本次位置反馈。 */
    onError(submissionId, error) {
      setActionError(submissionId, actionErrorMessage(error, copy.actionFailed));
      setReorderFeedback(null);
      reorderFocusRef.current = null;
    },
  });
  /** 完整队列保留隐藏成员，卡片列表仅保留普通等待项。 */
  const { queue, fullQueue: reorderableQueue } = ordering;
  /** 队列身份在本地接入权威快照时保持不变。 */
  const queueIds = queue.map(queuedSubmissionIdentity);
  /** 轮次切换或发送失败时保留已打开的草稿，直到用户主动关闭。 */
  const rows = [...queue, ...[...editingRows].filter(([id]) => !queueIds.includes(id)).map(([, submission]) => submission)];
  for (const [id, exit] of exits) {
    if (!rows.some((submission) => queuedSubmissionIdentity(submission) === id)) rows.splice(exit.index, 0, exit.submission);
  }
  /** 列表有可交互卡片时保持展开，最后一条退出时收起整个区域。 */
  const visibleRows = rows.filter((submission) => !exits.has(queuedSubmissionIdentity(submission)));
  /** 插入、编辑或换位时，其他行从上一帧位置平滑移动。 */
  const listRef = useListReorderMotion<HTMLOListElement>(JSON.stringify([rows.map(queuedSubmissionIdentity), [...editingRows.keys()], [...actionErrors]]), true);
  /** 同一条卡片只在首次出现时进入。 */
  const enteringIds = useNewItemMotionIds(queueIds);
  /** 辅助播报读取当前实际行序，隐藏或删除后不再报告旧位置。 */
  const visibleQueueIds = queueIds.filter((id) => !exits.has(id));
  /** 调序位置与读屏计数均采用可见队列。 */
  const reorderedIndex = reorderFeedback ? visibleQueueIds.indexOf(reorderFeedback.submissionId) : -1;
  /** 历史只读会话不提供队列写入口。 */
  const writable = props.state.conversationState !== 'legacy_readonly';

  useLayoutEffect(() => {
    /** CSS 决定退出时长，成功回执提前到达也不会截断动画。 */
    let cancelled = false;
    for (const [id, exit] of exits) {
      if (!exit.confirmed || queue.some((submission) => queuedSubmissionIdentity(submission) === id)) continue;
      const element = listRef.current?.querySelector(`[data-list-motion-id="${CSS.escape(id)}"]`);
      const animations = element?.getAnimations() ?? [];
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
        if (cancelled) return;
        setExits((current) => {
          if (current.get(id) !== exit) return current;
          const remaining = new Map(current);
          remaining.delete(id);
          return remaining;
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [exits, listRef, queue]);

  useLayoutEffect(() => {
    const identity = editFocusRef.current;
    if (!identity || editingRows.has(identity)) return;
    editFocusRef.current = null;
    if (document.activeElement !== document.body) return;
    const row = listRef.current?.querySelector(`[data-list-motion-id="${CSS.escape(identity)}"]`);
    row?.querySelector<HTMLButtonElement>('[data-queue-edit]')?.focus({ preventScroll: true });
  }, [editingRows, listRef]);

  useLayoutEffect(() => {
    if (!reorderFeedback || !reorderFocusRef.current) return;
    /** React 移动已有节点或禁用按钮时可能丢失焦点，只恢复本次操作的目标。 */
    const button = reorderFocusRef.current;
    reorderFocusRef.current = null;
    if (document.activeElement !== document.body && document.activeElement !== button) return;
    /** 到达首尾后原方向禁用，消息本身接管焦点，不跳到另一条消息。 */
    const row = regionRef.current?.querySelector<HTMLElement>('[data-reordered="true"]');
    if (!row) return;
    (button.isConnected ? button : row).focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [reorderFeedback, queue]);

  /** 错误由原卡片保留，其他卡片的操作不会覆盖它。 */
  function setActionError(id: string, message?: string): void {
    setActionErrors((current) => {
      if (current.get(id) === message) return current;
      const errors = new Map(current);
      if (message) errors.set(id, message);
      else errors.delete(id);
      return errors;
    });
  }

  /** 进入编辑态时优先恢复用户在 Composer 中实际输入的草稿。 */
  function startEdit(submission: NativeQueuedSubmission): void {
    const identity = queuedSubmissionIdentity(submission);
    setEditingRows((current) => new Map([...current].filter(([id]) => actionRef.current.has(`edit:${id}`) || actionErrors.has(id) || !queueIds.includes(id)).concat([[identity, submission]])));
    setActionError(identity);
    setReorderFeedback(null);
  }

  /** 退出编辑态但不触碰权威排队内容。 */
  function cancelEdit(identity: string): void {
    setEditingRows((current) => new Map([...current].filter(([id]) => id !== identity)));
    setActionError(identity);
  }

  /** 保存仍使用原提交身份，服务端负责原子替换排队内容。 */
  async function saveEdit(submission: NativeQueuedSubmission, content: string, attachments: NativeConversationAttachment[]): Promise<void> {
    if (!props.onEdit || (!content.trim() && attachments.length === 0)) return;
    /** 保存期间允许编辑别的卡片；旧回执只关闭自己打开的编辑框。 */
    const identity = queuedSubmissionIdentity(submission);
    const saved = await runAction(submission, 'edit', () => props.onEdit?.(submission.id, content.trim(), attachments));
    if (saved) cancelEdit(identity);
  }

  /** 点击引导或删除即开始退出，拒绝时在当前队列位置反向展开。 */
  async function runAction(submission: NativeQueuedSubmission, action: QueueAction, operation: () => void | Promise<void>): Promise<boolean> {
    /** 原提交身份跨越本地排队和确认回执。 */
    const submissionId = queuedSubmissionIdentity(submission);
    /** 去重范围仅限当前消息的同一操作。 */
    const key = `${action}:${submissionId}`;
    if (actionRef.current.has(key)) return false;
    /** 只有会移出单条消息的操作触发退出。 */
    const exit = action === 'steer' || action === 'delete' ? { submission, index: rows.indexOf(submission), confirmed: false } : null;
    if (exit && (actionRef.current.has(`steer:${submissionId}`) || actionRef.current.has(`delete:${submissionId}`))) return false;
    actionRef.current.add(key);
    setActions(new Set(actionRef.current));
    if (exit) {
      setExits((current) => new Map(current).set(submissionId, exit));
      /** 键盘焦点随可见队列移动，退出的卡片不再占用焦点。 */
      const focusedRow = document.activeElement?.closest<HTMLElement>('[data-list-motion-id]');
      if (focusedRow?.dataset.listMotionId === submissionId) {
        const position = visibleRows.indexOf(submission);
        const neighbor = visibleRows[position + 1] ?? visibleRows[position - 1];
        if (neighbor) {
          listRef.current?.querySelector<HTMLElement>(`[data-list-motion-id="${CSS.escape(queuedSubmissionIdentity(neighbor))}"] > .session-queued-message-clip > article`)?.focus({ preventScroll: true });
        }
      }
    }
    setActionError(submissionId);
    setReorderFeedback(null);
    try {
      await operation();
      if (exit) setExits((current) => new Map(current).set(submissionId, { ...exit, confirmed: true }));
      return true;
    } catch (error) {
      if (exit) {
        setExits((current) => {
          const remaining = new Map(current);
          remaining.delete(submissionId);
          return remaining;
        });
      }
      setActionError(submissionId, actionErrorMessage(error, action === 'edit' ? copy.editFailed : copy.actionFailed));
      return false;
    } finally {
      actionRef.current.delete(key);
      setActions(new Set(actionRef.current));
    }
  }

  /** 按完整队列立即移动一位，连续点击由共享调序逻辑串行保存。 */
  function reorder(submission: NativeQueuedSubmission, direction: -1 | 1, button: HTMLButtonElement): void {
    const identity = queuedSubmissionIdentity(submission);
    if (!ordering.move(identity, direction)) return;
    reorderFocusRef.current = button;
    setActionError(identity);
    setReorderFeedback({ submissionId: identity });
  }

  /** 最后一条退出时保留可见表面完成过渡。 */
  const panel = (
    <PopoverSurface ref={regionRef} className="session-queued-messages" data-queue-restoring={visibleRows.some((submission) => actionErrors.has(queuedSubmissionIdentity(submission))) || undefined} role="region" aria-label={copy.region}>
      <h2 className="session-sr-only">{copy.heading(visibleQueueIds.length)}</h2>
      <output className="session-sr-only" aria-live="polite" aria-atomic="true">
        {reorderedIndex >= 0 ? copy.reordered(reorderedIndex + 1, visibleQueueIds.length) : ''}
      </output>
      <ol ref={listRef}>
        {rows.map((submission) => {
          /** 编辑、动画和反馈跨越本地投影和权威提交的交接。 */
          const identity = queuedSubmissionIdentity(submission);
          /** 只退出本次操作的卡片，后续卡片仍可点击。 */
          const exiting = exits.has(identity);
          /** 保存、引导和删除分别反馈自身的写入进度。 */
          const saving = actions.has(`edit:${identity}`);
          /** 发起会移出队列的操作时，整张卡片立即进入收起过渡。 */
          const steering = actions.has(`steer:${identity}`);
          const deleting = actions.has(`delete:${identity}`);
          const editing = editingRows.has(identity);
          const leftQueue = !queueIds.includes(identity);
          /** 旧暂停卡片保留明确继续入口；活动回复和未知送达不能从这里绕过。 */
          const resumable =
            submission.status === 'paused' &&
            submission.pausedReason === 'interrupted' &&
            reorderableQueue[0]?.id === submission.id &&
            (props.state.queue?.state.type === 'idle' || (props.state.queue?.state.type === 'paused' && props.state.queue.state.reason === 'interrupted'));
          /** 前端保留引导入口，队首和轮次是否可接收由服务端核对。 */
          const steerTurnId = submission.status === 'queued' ? props.state.activeTurnId : null;
          /** 中断后继续原队列，活动轮次使用点击时显示的轮次。 */
          const sendAction = resumable ? props.onResumeQueue : steerTurnId && props.onSendNow ? () => props.onSendNow?.(submission.id, steerTurnId) : undefined;
          /** 操作名称明确区分引导当前回复与继续整个队列。 */
          const sendLabel = resumable ? copy.resume : copy.steer;
          /** 上移只允许与相邻普通排队项交换。 */
          const canMoveUp = ordering.canMove(identity, -1);
          /** 下移只允许与相邻普通排队项交换。 */
          const canMoveDown = ordering.canMove(identity, 1);
          /** 当前行的错误保持在原提交旁。 */
          const rowError = actionErrors.get(identity) ?? (!saving && leftQueue ? copy.editUnavailable : submission.error?.message);
          /** 附件与正文分别投影，纯附件消息不再退化成空白或泛化占位。 */
          const attachments = submission.attachments ?? [];
          /** 折叠态正文保持单行，编辑态仍使用完整原稿。 */
          const textPreview = queuedMessageTextPreview(submission);
          return (
            <li key={identity} data-list-motion-id={identity} data-queue-exiting={exiting || undefined} inert={exiting}>
              <div className="session-queued-message-clip">
                <article
                  className="session-queued-message"
                  tabIndex={-1}
                  data-motion-surface="list-item"
                  data-motion-state={enteringIds.has(identity) ? 'entering' : undefined}
                  data-reordered={reorderFeedback?.submissionId === identity || undefined}
                  data-queue-status={submission.status}
                  data-editing={editing || undefined}
                  aria-busy={(ordering.saving && reorderFeedback?.submissionId === identity) || undefined}
                >
                  {editing ? (
                    <QueuedMessageEditor
                      submission={submission}
                      language={props.language}
                      busy={saving}
                      canSave={!leftQueue && writable && Boolean(props.onEdit)}
                      onSave={(content, attachments) => saveEdit(submission, content, attachments)}
                      onCancel={() => {
                        editFocusRef.current = identity;
                        cancelEdit(identity);
                      }}
                      onError={(message) => setActionError(identity, message)}
                    />
                  ) : (
                    <div className="session-queued-message-content" data-icon-tooltip={queuedMessageAccessiblePreview(submission, copy.attachmentOnly, props.language)}>
                      <Clock aria-hidden="true" weight="regular" />
                      <span className="session-queued-message-state">{submission.status === 'paused' ? copy.paused : copy.queued}</span>
                      {textPreview ? <span className="session-queued-message-preview">{textPreview}</span> : null}
                      {attachments.length > 0 ? (
                        <span className="session-queued-message-attachment-summary" data-attachment-only={!textPreview || undefined}>
                          <Paperclip aria-hidden="true" />
                          <span>{queuedMessageAttachmentSummary(attachments, props.language)}</span>
                        </span>
                      ) : null}
                    </div>
                  )}
                  {!editing && writable ? (
                    <footer className="session-queued-message-actions">
                      {props.onEdit ? (
                        <Button unstyled type="button" data-queue-edit data-icon-tooltip={copy.edit} aria-label={copy.edit} onClick={() => startEdit(submission)}>
                          <PencilSimple aria-hidden="true" />
                        </Button>
                      ) : null}
                      {sendAction ? (
                        <Button
                          unstyled
                          type="button"
                          className="session-queued-message-steer"
                          data-busy-behavior="background"
                          busy={resumable ? actions.has(`resume:${identity}`) : steering}
                          data-icon-tooltip={sendLabel}
                          aria-label={`${sendLabel}. ${resumable ? copy.resumeHelp : copy.steerHelp}`}
                          onClick={() => void runAction(submission, resumable ? 'resume' : 'steer', sendAction)}
                        >
                          <ArrowBendUpRight aria-hidden="true" weight="bold" />
                        </Button>
                      ) : null}
                      {props.onDelete ? (
                        <Button
                          unstyled
                          type="button"
                          className="session-queued-message-delete"
                          data-busy-behavior="background"
                          busy={deleting}
                          data-icon-tooltip={copy.remove}
                          aria-label={copy.remove}
                          onClick={() => void runAction(submission, 'delete', () => props.onDelete?.(submission.id))}
                        >
                          <Trash aria-hidden="true" />
                        </Button>
                      ) : null}
                      {canMoveUp ? (
                        <Button unstyled type="button" data-icon-tooltip={copy.moveUp} aria-label={copy.moveUp} onClick={(event) => reorder(submission, -1, event.currentTarget)}>
                          <ArrowUp aria-hidden="true" />
                        </Button>
                      ) : null}
                      {canMoveDown ? (
                        <Button unstyled type="button" data-icon-tooltip={copy.moveDown} aria-label={copy.moveDown} onClick={(event) => reorder(submission, 1, event.currentTarget)}>
                          <ArrowDown aria-hidden="true" />
                        </Button>
                      ) : null}
                    </footer>
                  ) : null}
                  {rowError ? (
                    <small className="session-queued-message-error" role="alert">
                      <VisibleApplicationError error={rowError} language={props.language === 'zh-CN' ? 'zh-CN' : 'en'} />
                    </small>
                  ) : null}
                </article>
              </div>
            </li>
          );
        })}
      </ol>
    </PopoverSurface>
  );
  return <MotionPresence>{visibleRows.length > 0 ? panel : null}</MotionPresence>;
}

/** 编辑器随当前行挂载，取消、切换消息或发送后不接收旧附件导入回执。 */
function QueuedMessageEditor(props: {
  /** 编辑沿用原提交身份，原附件只在保存成功后被替换。 */
  submission: NativeQueuedSubmission;
  /** 文案沿用会话语言。 */
  language: SessionUiLanguage;
  /** 权威操作期间锁定编辑与重复提交。 */
  busy: boolean;
  /** 已经派发或失败的原消息仍可复制草稿，停止保存到旧提交。 */
  canSave: boolean;
  /** 正文与附件通过同一次队列操作保存。 */
  onSave(content: string, attachments: NativeConversationAttachment[]): Promise<void>;
  /** 取消只卸载当前草稿。 */
  onCancel(): void;
  /** 导入和保存错误都留在当前消息旁。 */
  onError(message: string): void;
}) {
  /** 恢复完整原稿，避免把单行摘要写回正文。 */
  const [draft, setDraft] = useState(() => queuedMessageEditDraft(props.submission));
  /** 独立草稿列表防止移除附件立即影响原排队消息。 */
  const [attachments, setAttachments] = useState(() => [...(props.submission.attachments ?? [])]);
  /** 普通 textarea 直接复用现有附件输入与选区接口。 */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** 当前语言的编辑文案。 */
  const copy = labels[props.language];
  /** 按真实资源身份移除，保留其他同名附件。 */
  function removeAttachment(attachment: NativeConversationAttachment): void {
    setAttachments((current) => current.filter((candidate) => conversationAttachmentIdentity(candidate) !== conversationAttachmentIdentity(attachment)));
  }
  /** 选择、粘贴和拖放共用授权、即时预览与异步生命周期。 */
  const inputResources = useConversationInputResources({
    attachments,
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    textareaRef,
    text: draft,
    disabled: props.busy,
    onTextChange: setDraft,
    onAddAttachments: (added) => {
      setAttachments((current) => {
        /** 同一资源重复导入只保留一份，名称相同的不同资源仍可并存。 */
        const byIdentity = new Map(current.map((attachment) => [conversationAttachmentIdentity(attachment), attachment]));
        added.forEach((attachment) => byIdentity.set(conversationAttachmentIdentity(attachment), attachment));
        return [...byIdentity.values()];
      });
    },
    onError: props.onError,
  });
  /** 导入尚未完成时不能保存一份缺少附件的消息。 */
  const saveDisabled = !props.canSave || props.busy || inputResources.processing || (!draft.trim() && attachments.length === 0);

  useLayoutEffect(() => {
    textareaRef.current?.focus();
  }, []);

  /** 表单和快捷键使用同一保存门禁。 */
  function submit(event: FormEvent<HTMLFormElement>): void | Promise<void> {
    event.preventDefault();
    if (!saveDisabled) return props.onSave(draft, attachments);
  }

  return (
    <Form
      className="session-queued-message-editor"
      onSubmit={submit}
      aria-busy={props.busy || inputResources.processing || undefined}
      data-resource-dragging={inputResources.dragging || undefined}
      onDragEnter={inputResources.handleDragEnter}
      onDragOver={inputResources.handleDragOver}
      onDragLeave={inputResources.handleDragLeave}
      onDrop={inputResources.handleDrop}
    >
      <ConversationComposerAttachments
        attachments={attachments}
        pendingResources={inputResources.pendingResources}
        language={props.language}
        disabled={props.busy}
        ariaLabel={copy.attachments(attachments.length)}
        className="session-queued-message-attachments"
        onRemove={removeAttachment}
      />
      <label className="session-sr-only" htmlFor={`queued-message-${props.submission.id}`}>
        {copy.editLabel}
      </label>
      <textarea
        id={`queued-message-${props.submission.id}`}
        ref={textareaRef}
        value={draft}
        disabled={props.busy}
        placeholder={attachments.length > 0 ? copy.editAttachmentPlaceholder : copy.editPlaceholder}
        aria-keyshortcuts="Meta+Enter Control+Enter Escape"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onPaste={inputResources.handlePaste}
        onKeyDown={(event) => {
          inputResources.handlePasteShortcut(event);
          if (props.busy) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            return props.onCancel();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!saveDisabled) event.currentTarget.form?.requestSubmit();
          }
        }}
      />
      <footer>
        <small aria-hidden="true">{copy.editShortcut}</small>
        <Button unstyled type="button" data-icon-tooltip={copy.addAttachments} aria-label={copy.addAttachments} aria-haspopup="menu" onClick={inputResources.chooseAttachments} disabled={props.busy || inputResources.processing}>
          <Paperclip aria-hidden="true" />
        </Button>
        <Button unstyled type="button" className="session-queued-message-editor-cancel" onClick={props.onCancel} disabled={props.busy}>
          {copy.cancel}
        </Button>
        <Button unstyled type="submit" className="session-queued-message-editor-save" disabled={saveDisabled}>
          {copy.save}
        </Button>
      </footer>
    </Form>
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

/** 将未知异常收敛为简短的用户可读反馈。 */
function actionErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : typeof error === 'string' && error.trim() ? error : fallback;
}
