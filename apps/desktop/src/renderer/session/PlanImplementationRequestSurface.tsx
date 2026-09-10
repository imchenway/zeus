import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ArrowRightIcon as ArrowRight } from '@phosphor-icons/react/dist/csr/ArrowRight';
import { PencilSimpleIcon as PencilSimple } from '@phosphor-icons/react/dist/csr/PencilSimple';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react/dist/csr/Paperclip';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { NativeConversationAttachment, NativePlanImplementationRequest } from './sessionTypes.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';
import { ConversationComposerAttachments, conversationAttachmentIdentity } from './ConversationComposerAttachments.js';
import { useConversationInputResources } from './useConversationInputResources.js';

/** 计划确认与修改共用选项行尺寸和询问操作样式，保留原有三种响应动作。 */
export function PlanImplementationRequestSurface(props: {
  request: NativePlanImplementationRequest;
  language: SessionUiLanguage;
  busy?: boolean;
  error?: string | null;
  autoFocus?: boolean;
  /** 与普通会话共用原生附件选择入口。 */
  onChooseAttachments?: () => Promise<NativeConversationAttachment[]>;
  onRespond: (
    requestId: string,
    input: {
      action: 'implement' | 'refine' | 'dismiss';
      feedback?: string;
      /** 修改意见随同一条提交携带附件。 */
      attachments?: NativeConversationAttachment[];
    },
  ) => void | Promise<void>;
}) {
  /** 当前界面语言。 */
  const zh = props.language === 'zh-CN';
  /** 只切换第二行的内容，不移动行尾操作。 */
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  /** 修改意见在提交确认前保留。 */
  const [feedback, setFeedback] = useState('');
  /** 附件只归属当前修改意见，提交失败时保留。 */
  const [attachments, setAttachments] = useState<NativeConversationAttachment[]>([]);
  /** 资源读取错误使用现有错误提示。 */
  const [resourceError, setResourceError] = useState<unknown>(null);
  /** 文件选择期间阻止提前提交，文字输入仍可编辑。 */
  const [choosingAttachments, setChoosingAttachments] = useState(false);
  /** 初次出现时聚焦实施选项。 */
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  /** 展开修改意见后聚焦同一行的输入框。 */
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useApplicationErrorDialog(props.error ?? resourceError, {
    language: zh ? 'zh-CN' : 'en',
  });

  /** 粘贴、原生剪贴板回退、拖入和长文本恢复均走共享资源入口。 */
  const inputResources = useConversationInputResources({
    language: zh ? 'zh-CN' : 'en',
    textareaRef: inputRef,
    text: feedback,
    disabled: props.busy === true,
    onTextChange: setFeedback,
    onAddAttachments: addAttachments,
    onRemoveAttachment: removeAttachment,
    onError: setResourceError,
  });
  /** 附件未准备完成时，不允许发送或关闭当前意见。 */
  const responding = props.busy || choosingAttachments || inputResources.processing;

  /** 相同受信资源只显示一次，选择与粘贴共用添加入口。 */
  function addAttachments(added: NativeConversationAttachment[]): void {
    setResourceError(null);
    setAttachments((current) => [...new Map([...current, ...added].map((attachment) => [conversationAttachmentIdentity(attachment), attachment])).values()]);
  }

  /** 只释放用户移除的托管草稿资源，清理失败不影响继续编辑。 */
  function removeAttachment(attachment: NativeConversationAttachment): void {
    setAttachments((current) => current.filter((candidate) => conversationAttachmentIdentity(candidate) !== conversationAttachmentIdentity(attachment)));
    void window.zeus?.discardConversationResources?.([{ ...(attachment.localPath ? { localPath: attachment.localPath } : {}), ...(attachment.uploadRef ? { uploadRef: attachment.uploadRef } : {}) }]).catch(() => undefined);
  }

  /** 原生文件选择结果与剪贴板资源采用相同预览和提交格式。 */
  async function chooseAttachments(): Promise<void> {
    if (!props.onChooseAttachments || responding) return;
    setChoosingAttachments(true);
    try {
      addAttachments(await props.onChooseAttachments());
    } catch (error) {
      setResourceError(error);
    } finally {
      setChoosingAttachments(false);
    }
  }

  useEffect(() => {
    if (props.autoFocus !== false) primaryRef.current?.focus();
  }, [props.autoFocus, props.request.id]);
  useEffect(() => {
    if (feedbackOpen) inputRef.current?.focus();
  }, [feedbackOpen]);

  /** 表单按钮与回车共用提交入口，允许仅用附件表达修改意见。 */
  function submitFeedback(event: FormEvent): void {
    event.preventDefault();
    if ((!feedback.trim() && attachments.length === 0) || responding) return;
    void props.onRespond(props.request.id, { action: 'refine', feedback: feedback.trim(), ...(attachments.length ? { attachments } : {}) });
  }

  /** 复用答题卡的操作顺序、品牌色和高度；展开输入前只显示跳过。 */
  const actions = (
    <div className="session-rui-inline-actions" role="group" aria-label={zh ? '计划操作' : 'Plan actions'}>
      {feedbackOpen && props.onChooseAttachments ? (
        <button type="button" className="session-question-attachment-button" aria-label={zh ? '添加附件' : 'Add attachment'} disabled={responding} onClick={() => void chooseAttachments()}>
          <Paperclip aria-hidden="true" />
        </button>
      ) : null}
      <button type="button" onClick={() => void props.onRespond(props.request.id, { action: 'dismiss' })} disabled={responding}>
        {zh ? '跳过' : 'Skip'}
      </button>
      {feedbackOpen ? (
        <button type="submit" disabled={(!feedback.trim() && attachments.length === 0) || responding}>
          {zh ? '提交' : 'Submit'}
        </button>
      ) : null}
    </div>
  );

  return (
    <section className="session-question-panel session-plan-implementation-request" aria-busy={responding || undefined} data-error={Boolean(props.error) || undefined} data-request-id={props.request.id}>
      <header>
        <strong>{zh ? '实施此计划？' : 'Implement this plan?'}</strong>
        <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => void props.onRespond(props.request.id, { action: 'dismiss' })} disabled={responding}>
          <X aria-hidden="true" />
        </button>
      </header>
      <div className="session-question-options">
        <button ref={primaryRef} type="button" className="session-question-option is-primary" onClick={() => void props.onRespond(props.request.id, { action: 'implement' })} disabled={responding}>
          <span className="session-question-index">1</span>
          <span className="session-question-option-copy">
            <strong>{zh ? '是，实施此计划' : 'Yes, implement this plan'}</strong>
          </span>
          <ArrowRight aria-hidden="true" />
        </button>
        {feedbackOpen ? (
          <form
            className="session-plan-refinement"
            onSubmit={submitFeedback}
            data-resource-dragging={inputResources.dragging || undefined}
            onDragEnter={inputResources.handleDragEnter}
            onDragOver={inputResources.handleDragOver}
            onDragLeave={inputResources.handleDragLeave}
            onDrop={inputResources.handleDrop}
          >
            <span className="session-question-index">
              <PencilSimple aria-hidden="true" />
            </span>
            <textarea
              ref={inputRef}
              rows={1}
              aria-label={zh ? '修改计划' : 'Revise plan'}
              aria-keyshortcuts="Enter Shift+Enter"
              value={feedback}
              placeholder={zh ? '说明希望如何修改计划' : 'Describe how you would like to change the plan'}
              onChange={(event) => setFeedback(event.currentTarget.value)}
              onPaste={inputResources.handlePaste}
              onKeyDown={(event) => {
                inputResources.handlePasteShortcut(event);
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            {actions}
            <ConversationComposerAttachments
              attachments={attachments}
              language={props.language}
              disabled={responding === true}
              className="session-question-answer-attachments"
              onRemove={removeAttachment}
              onRestorePastedText={inputResources.restorePastedText}
            />
          </form>
        ) : (
          <div className="session-plan-refinement">
            <button type="button" className="session-question-option session-question-option-other" onClick={() => setFeedbackOpen(true)} disabled={props.busy}>
              <span className="session-question-index">
                <PencilSimple aria-hidden="true" />
              </span>
              <span className="session-question-option-copy">{zh ? '否，并告诉 Codex 应该如何做得不同' : 'No, tell Codex what to do differently'}</span>
            </button>
            {actions}
          </div>
        )}
      </div>
    </section>
  );
}
