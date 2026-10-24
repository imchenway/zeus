import { ZeusApiError } from '../transport/localApiTransport.js';
import { useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import type { ConversationContextDraft, ConversationResponseAnnotation } from '@zeus/shared';
import { ArrowsOutIcon } from '@phosphor-icons/react/dist/csr/ArrowsOut';
import { ArrowsInIcon } from '@phosphor-icons/react/dist/csr/ArrowsIn';
import { XIcon } from '@phosphor-icons/react/dist/csr/X';
import { ConversationComposer, type ComposerRuntimeSettings } from './ConversationComposer.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';
import type { CodexConversationCapabilities, NativeConversationAttachment, NativeConversationChoice } from './sessionTypes.js';
import { createInitialSessionState } from './sessionReducer.js';
import { VisibleApplicationError } from '../ui/ApplicationErrorDialog.js';
import { Button } from '../ui/Button.js';
import type { SessionUiLanguage } from './ThreadItemView.js';

/** 首发冻结问题、引用和模型选择；结果不明时只核对同一请求。 */
export interface SideQuestionStartInput {
  /** 主会话内独立草稿的稳定身份。 */
  id: string;
  /** 用户输入的问题。 */
  content: string;
  /** 原回答的选区评论。 */
  conversationContext: ConversationContextDraft;
  /** 本次问题随附的独立资源。 */
  attachments: NativeConversationAttachment[];
  /** 发送时明确选择的运行设置。 */
  settings: ComposerRuntimeSettings;
}

/** 右侧会话属于主会话的界面状态，关闭面板不丢弃草稿或已创建的产品会话。 */
export interface SideQuestionState {
  /** 持久首发信封的隔离身份。 */
  id: string;
  /** 尚未发送的问题。 */
  draft: string;
  /** 未交给右侧会话输入框的选区评论。 */
  annotations: ConversationResponseAnnotation[];
  /** 尚未发送的附件。 */
  attachments: NativeConversationAttachment[];
  /** 尚未发送时选择的运行设置，切换主会话后仍保留。 */
  settings?: ComposerRuntimeSettings;
  /** 右侧独立会话，首次发送接纳后才存在。 */
  conversation: NativeConversationChoice | null;
  /** 原样重用已尝试发送的输入，避免异常后新建第二个会话。 */
  attempt?: SideQuestionStartInput;
}

/** 复用正式会话输入框和完整会话页，只负责侧栏首发与页面外框。 */
export function SideQuestionWorkspace(props: {
  /** 所属主会话保存的侧栏草稿或会话。 */
  state: SideQuestionState;
  /** 只更新当前主会话的侧栏状态。 */
  onStateChange: Dispatch<SetStateAction<SideQuestionState | null>>;
  /** 沿用主会话界面语言。 */
  language: SessionUiLanguage;
  /** 附件与模型选择使用所属项目。 */
  projectId: string;
  /** 任务会话保留原任务身份。 */
  taskId?: string;
  /** 复用已加载的模型能力清单。 */
  capabilities?: CodexConversationCapabilities | null;
  /** 源会话的有效模型与权限选择。 */
  initialSettings: ComposerRuntimeSettings;
  /** 隐藏时退出布局和键盘导航。 */
  visible: boolean;
  /** 窄窗口可展开为全宽阅读。 */
  fullWidth: boolean;
  /** 复用主页面分栏宽度状态。 */
  onFullWidthChange: (value: boolean) => void;
  /** 关闭只收起当前面板。 */
  onClose: () => void;
  /** 首发沿用正式会话的持久回执。 */
  onStart: (input: SideQuestionStartInput, onAccepted: (choice: NativeConversationChoice) => void) => Promise<void>;
  /** 接纳后挂载完整会话页并交付后续选区。 */
  renderConversation: (conversation: NativeConversationChoice, annotations: ConversationResponseAnnotation[], onStaged: (ids: string[]) => void) => ReactNode;
}) {
  /** 文案跟随主会话语言。 */
  const zh = props.language === 'zh-CN';
  /** 首发请求只能有一个执行者。 */
  const sending = useRef(false);
  /** 发送中状态只限制当前侧栏。 */
  const [busy, setBusy] = useState(false);
  /** 原因由共享错误组件展示，不清空问题。 */
  const [error, setError] = useState<unknown>(null);
  /** 初始沿用源会话模型与权限，用户仍可主动调整。 */
  const settings = props.state.settings ?? props.initialSettings;
  /** 打开后将键盘焦点交给右侧问题输入框。 */
  const inputRef = useRef<ComposerInputHandle | null>(null);
  /** 只有未创建的会话使用本地草稿，不伪造后端会话身份。 */
  const state = useMemo(
    () => ({
      ...createInitialSessionState(),
      draft: props.state.draft,
      attachments: props.state.attachments,
      contextDraft: { responseAnnotations: props.state.annotations, codeComments: [] },
      conversationState: 'native_idle' as const,
      transportState: 'ready' as const,
    }),
    [props.state],
  );
  useEffect(() => {
    if (props.visible && !props.state.conversation) inputRef.current?.focus();
  }, [props.visible, props.state.annotations.length, props.state.conversation]);

  /** 成功回执立即切换真实会话；刷新失败不能触发第二次创建。 */
  async function submit(selected = settings): Promise<void> {
    if (sending.current) return;
    /** 首次发送后冻结输入，手动核对仍使用原始内容及身份。 */
    const input = props.state.attempt ?? {
      id: props.state.id,
      content: props.state.draft.trim() || (zh ? '请解释引用的内容。' : 'Please explain the quoted text.'),
      conversationContext: state.contextDraft,
      attachments: props.state.attachments,
      settings: selected,
    };
    sending.current = true;
    setBusy(true);
    setError(null);
    props.onStateChange((current) => current && { ...current, attempt: input });
    try {
      await props.onStart(input, (conversation) =>
        props.onStateChange(
          (current) =>
            current && {
              ...current,
              conversation,
              draft: '',
              attachments: [],
              attempt: undefined,
              annotations: current.annotations.filter((annotation) => !input.conversationContext.responseAnnotations.some((sent) => sent.id === annotation.id)),
            },
        ),
      );
    } catch (failure) {
      // 仅发送前明确拒绝的设置与目录校验恢复编辑；网络失败和未知结果继续冻结原请求。
      if (
        failure instanceof ZeusApiError &&
        !failure.recoveryRequired &&
        ['ZEUS_INVALID_CONVERSATION_SETTINGS', 'ZEUS_INVALID_PERMISSION_MODE', 'ZEUS_INVALID_COLLABORATION_MODE', 'ZEUS_MODEL_UNAVAILABLE', 'ZEUS_MODEL_NOT_READY', 'ZEUS_TASK_EXECUTION_CONTEXT_INVALID'].includes(failure.error ?? '')
      ) {
        props.onStateChange((current) => current && { ...current, attempt: undefined });
      }
      setError(failure);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <section className="session-side-question" hidden={!props.visible} inert={!props.visible} aria-label={zh ? '侧边栏会话' : 'Sidebar conversation'}>
      <header className="session-side-question-header">
        <strong>{zh ? '侧边栏提问' : 'Ask in sidebar'}</strong>
        <nav aria-label={zh ? '侧边栏会话操作' : 'Sidebar conversation actions'}>
          <button type="button" aria-label={props.fullWidth ? (zh ? '恢复分栏' : 'Restore split') : zh ? '扩展为全宽' : 'Expand full width'} onClick={() => props.onFullWidthChange(!props.fullWidth)}>
            {props.fullWidth ? <ArrowsInIcon /> : <ArrowsOutIcon />}
          </button>
          <button type="button" aria-label={zh ? '关闭侧边栏会话' : 'Close sidebar conversation'} onClick={props.onClose}>
            <XIcon />
          </button>
        </nav>
      </header>
      {props.state.conversation ? (
        props.renderConversation(props.state.conversation, props.state.annotations, (ids) => props.onStateChange((current) => current && { ...current, annotations: current.annotations.filter((annotation) => !ids.includes(annotation.id)) }))
      ) : (
        <div className="session-side-question-draft">
          <div className="session-side-question-space" />
          {error ? <VisibleApplicationError error={error} language={zh ? 'zh-CN' : 'en'} /> : null}
          {props.state.attempt && !busy ? <Button onClick={() => void submit()}>{zh ? '核对并继续' : 'Check and continue'}</Button> : null}
          <ConversationComposer
            state={state}
            language={props.language}
            textareaRef={inputRef}
            capabilities={props.capabilities}
            projectId={props.projectId}
            taskId={props.taskId}
            permissionMode={settings.permissionMode}
            collaborationMode={settings.collaborationMode}
            runtimeSettings={settings}
            onRuntimeSettingsChange={(settings) => props.onStateChange((current) => current && { ...current, settings })}
            inputBlocked={busy || Boolean(props.state.attempt)}
            onDraftChange={(draft) => props.onStateChange((current) => current && { ...current, draft })}
            onSubmit={(_delivery, selected) => submit({ ...settings, ...selected })}
            onInterrupt={() => {}}
            onChooseAttachments={() => {}}
            onAddAttachments={(attachments) => props.onStateChange((current) => current && { ...current, attachments: [...current.attachments, ...attachments] })}
            onRemoveAttachment={(attachment) => props.onStateChange((current) => current && { ...current, attachments: current.attachments.filter((entry) => entry !== attachment) })}
            onContextDraftChange={(context) => props.onStateChange((current) => current && { ...current, annotations: context.responseAnnotations })}
          />
        </div>
      )}
    </section>
  );
}
