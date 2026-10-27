import { classifyAssistantMessage } from '@zeus/shared';
import { type HTMLAttributes, type KeyboardEvent, type RefObject, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useHoverIntent } from '../ui/useHoverIntent.js';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { ModelBrainIcon } from './ModelBrainIcon.js';
import { BrowserCommentPreview } from './BrowserCommentPreview.js';
import { PaperclipIcon as Paperclip } from '@phosphor-icons/react/dist/csr/Paperclip';
import { SquareIcon as Square } from '@phosphor-icons/react/dist/csr/Square';
import { TargetIcon as Target } from '@phosphor-icons/react/dist/csr/Target';
import { XIcon as X } from '@phosphor-icons/react/dist/csr/X';
import type { ConversationContextDraft, ZeusBrowserPreparedSubmission } from '@zeus/shared';
import type {
  CodexConversationCapabilities,
  NativeCollaborationMode,
  NativeConversationAttachment,
  NativeGoalSnapshot,
  NativePermissionMode,
  NativeServiceTierSelection,
  NativeSessionState,
  NativeTurnSettingsSelection,
} from './sessionTypes.js';
import { ComposerDropdown } from './ComposerDropdown.js';
import { PermissionModeControl } from './PermissionModeControl.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { CollaborationModeControl } from './CollaborationModeControl.js';
import { ConversationComposerAttachments } from './ConversationComposerAttachments.js';
import { ContextUsageIndicator } from './ContextUsageIndicator.js';
import { IconTooltip } from '../ui/IconTooltip.js';
import { ServiceTierToggle } from './ServiceTierToggle.js';
import { resolveModelCapability } from './modelSelection.js';
import { useConversationInputResources } from './useConversationInputResources.js';
import { normalizeServiceTierSelection, selectionFromEffectiveServiceTier, serviceTierSelectionValue, serviceTierWireOverride } from './serviceTierSelection.js';
import { browserProjectModelPreferenceStorage, readProjectModelPreferences } from './projectModelPreferences.js';
import { contextCapacitySelectionAllowed } from './contextCapacitySelection.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { systemMessageScope, recordSystemMessage, recoverSystemMessage, useConversationSystemMessages, handledMessageDeliveryErrors } from './conversationSystemMessages.js';
import { StructuredComposerInput, type StructuredComposerSelection } from './StructuredComposerInput.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';
import { useInputSuggestion } from './useInputSuggestion.js';
import { InputSuggestionButton } from './InputSuggestionControl.js';
import { selectPendingExecutionMessage } from './sessionSelectors.js';

export type ComposerKeyIntent = 'submit' | 'newline' | 'escape' | 'ignore';
export interface ComposerRuntimeSettings {
  /** 下一轮选择的上下文容量。 */
  contextCapacityTokens?: number | null;
  model: string;
  agentKind?: 'codex' | 'pi';
  effort?: string;
  serviceTier?: string | null;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
}

export interface ConversationComposerProps {
  /** 主输入框独享建议设置；答题和其他复用输入框保持原有行为。 */
  inputSuggestionSettings?: import('@zeus/shared').InputSuggestionSettings;
  /** 生成灰字或润色候选，不提交下一轮或改变执行队列。 */
  onGenerateInputSuggestion?: (input: import('@zeus/shared').InputSuggestionRequest, signal: AbortSignal, diagnosticId?: string) => Promise<import('@zeus/shared').InputSuggestionResult>;
  state: NativeSessionState;
  language: SessionUiLanguage;
  textareaRef?: RefObject<ComposerInputHandle | null>;
  capabilities?: CodexConversationCapabilities | null;
  onDraftChange: (draft: string) => void;
  onSubmit: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => void | Promise<void>;
  onInterrupt: (turnId: string) => void | Promise<void>;
  onChooseAttachments?: () => void | Promise<void>;
  onAddAttachments?: (attachments: NativeConversationAttachment[]) => void;
  onRemoveAttachment?: (attachment: NativeConversationAttachment) => void;
  onRemoveBrowserSubmission?: () => void;
  onContextDraftChange?: (draft: ConversationContextDraft) => void;
  projectId?: string;
  /** 普通会话切换模型时恢复所属项目的选择。 */
  restoreProjectModelPreferences?: boolean;
  /** 讨论归属任务，用于读取成员实际继承配置。 */
  taskId?: string;
  onLoadExtensions?: (projectId?: string, forceReload?: boolean) => Promise<import('../features/codex/codexContracts.js').SkillCatalog>;
  onLoadEmployees?: (projectId: string) => Promise<import('../features/digital-employees/digitalEmployeeContracts.js').DigitalEmployeeRecord[]>;
  onOpenComputerSettings?: () => void;
  runtimeSettings?: ComposerRuntimeSettings | null;
  onRuntimeSettingsChange?: (settings: ComposerRuntimeSettings) => void;
  readOnly?: boolean;
  inputBlocked?: boolean;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
  goalAvailable?: boolean;
  goal?: NativeGoalSnapshot | null;
  goalBusy?: boolean;
  onSetGoal?: (objective: string) => boolean | Promise<boolean>;
  onPauseGoal?: () => boolean | Promise<boolean>;
  onResumeGoal?: () => boolean | Promise<boolean>;
  onOpenGoal?: () => void;
}

const labels = {
  'zh-CN': {
    input: (provider: string) => `发送消息给 ${provider}`,
    placeholder: '继续对话，Enter 发送，Shift+Enter 换行',
    send: '发送',
    /** 空输入时，发送按钮明确提交当前可见建议。 */
    sendSuggestion: '发送输入建议',
    stop: '停止',
    attach: '添加附件',
    removeAttachment: '移除附件',
    interruptConfirm: '再次按 Escape 停止当前响应',
    model: '模型',
    effort: '推理强度',
    unsynced: '未同步',
    searchModel: '搜索供应商或模型',
    noModel: '没有匹配模型',
    goal: '目标',
    createGoal: '创建目标',
    goalInput: '目标内容',
    goalPlaceholder: '说明要达成什么、如何验证，以及何时停止',
    exitGoal: '退出目标输入',
    normalDraftPreserved: '普通消息草稿已保留',
    recoveredInputBlocked: '连接中断后恢复的问题暂时无法回答。你可以停止当前处理。',
  },
  'en-US': {
    input: (provider: string) => `Message ${provider}`,
    placeholder: 'Continue the conversation. Enter to send, Shift+Enter for a newline.',
    send: 'Send',
    /** 与中文一致说明直接发送建议的操作。 */
    sendSuggestion: 'Send input suggestion',
    stop: 'Stop',
    attach: 'Add attachment',
    removeAttachment: 'Remove attachment',
    interruptConfirm: 'Press Escape again to stop the current response',
    model: 'Model',
    effort: 'Reasoning effort',
    unsynced: 'Not synced',
    searchModel: 'Search providers or models',
    noModel: 'No matching models',
    goal: 'Goal',
    createGoal: 'Create goal',
    goalInput: 'Goal objective',
    goalPlaceholder: 'Describe the outcome, validation, and stopping condition',
    exitGoal: 'Exit goal input',
    normalDraftPreserved: 'Message draft preserved',
    recoveredInputBlocked: 'This question cannot be answered after the connection was interrupted. You can stop the current work.',
  },
} as const;

export function ConversationComposer(props: ConversationComposerProps) {
  const copy = labels[props.language];
  const initialModel = resolveComposerModel(props.capabilities, props.runtimeSettings?.model ?? props.state.providerSettings?.model);
  const initialEffort = resolveComposerEffort(props.capabilities, initialModel, props.runtimeSettings?.effort ?? props.state.providerSettings?.effort);
  /** 服务档位只使用当前会话的显式选择。 */
  const initialServiceTier = selectionFromEffectiveServiceTier(props.runtimeSettings && Object.prototype.hasOwnProperty.call(props.runtimeSettings, 'serviceTier') ? props.runtimeSettings.serviceTier : null);
  const fallbackRef = useRef<ComposerInputHandle | null>(null);
  const textareaRef = props.textareaRef ?? fallbackRef;
  const composingRef = useRef(false);
  const structuredSelectionRef = useRef<StructuredComposerSelection>({ displayText: props.state.draft, promptText: props.state.draft, expertMentions: [], skillReferences: [], pluginReferences: [], computerUseRequested: false });
  const [isComposing, setIsComposing] = useState(false);
  /** 输入 DOM 可复用，但草稿本地值必须跟随实际会话归属。 */
  const editorScopeKey = JSON.stringify([props.state.projectId, props.state.conversationId]);
  /** 输入法组合中的本地文本不回写到其他会话。 */
  const [editorDraft, setEditorDraft] = useState({ key: editorScopeKey, text: props.state.draft });
  /** 切换的首帧即使用新会话草稿，避免旧本地值取消已保存的生成。 */
  const editorValue = editorDraft.key === editorScopeKey ? editorDraft.text : props.state.draft;
  /** 所有本地输入更新都捕获当前会话身份。 */
  const setEditorValue = useCallback((text: string) => setEditorDraft({ key: editorScopeKey, text }), [editorScopeKey]);
  const [goalInputOpen, setGoalInputOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [goalSubmitting, setGoalSubmitting] = useState(false);
  /** 输入区只记录系统消息，正文区域负责按持久位置展示。 */
  const systemScope = systemMessageScope(props.state.projectId ?? props.projectId ?? '', props.state.conversationId);
  const pendingSystemMessages = useConversationSystemMessages(systemScope);
  /** 输入文件的失败与消息提交失败分别记录。 */
  const setInputResourceError = (error: unknown): void => {
    if (error) recordSystemMessage(systemScope, error, 'input_resource', '输入附件处理失败。');
  };
  /** 只有对应操作实际成功才补充恢复事实。 */
  const recoverInputOperation = (operation: 'input_resource' | 'message_send'): void => {
    for (const message of [...Object.values(props.state.systemMessages ?? {}), ...pendingSystemMessages]) if (message.operation === operation && !message.recoveredAt) recoverSystemMessage(systemScope, message);
  };
  const [selectedModel, setSelectedModel] = useState(initialModel);
  /** 已持久化的下一轮容量；正在执行的请求保持原容量。 */
  const selectedCapacity = props.runtimeSettings?.contextCapacityTokens !== undefined ? props.runtimeSettings.contextCapacityTokens : (props.state.snapshot?.contextCapacityTokens ?? null);
  const [selectedEffort, setSelectedEffort] = useState(initialEffort);
  const [selectedServiceTier, setSelectedServiceTier] = useState<NativeServiceTierSelection>(initialServiceTier);
  /** 本地发送立即切换主按钮；停止操作仍须取得真实轮次身份后才能启用。 */
  const active =
    props.state.conversationState === 'active_prework' ||
    props.state.conversationState === 'active_final_answer' ||
    props.state.conversationState === 'starting_turn' ||
    (props.state.transportState !== 'failed' && Boolean(selectPendingExecutionMessage(props.state)));
  const busy = Boolean(props.state.busyOperation);
  const writable = props.readOnly !== true && props.state.conversationState !== 'legacy_readonly';
  const inputWritable = writable && props.inputBlocked !== true;
  const hasDraft = editorValue.trim().length > 0 || props.state.attachments.length > 0 || Boolean(props.state.browserSubmission) || props.state.contextDraft.responseAnnotations.length > 0 || props.state.contextDraft.codeComments.length > 0;
  const goalInputActive = goalInputOpen && !props.goal;
  const goalCount = [...goalDraft.trim()].length;
  const goalDraftValid = goalCount > 0 && goalCount <= 4_000;
  const goalOperationBusy = goalSubmitting || props.goalBusy === true;
  const modelPresentation = useMemo(() => presentModelOptions(props.capabilities?.models ?? [], selectedModel, props.language, { preserveMissingSelection: true }), [props.capabilities?.models, props.language, selectedModel]);
  const effectiveModel = modelPresentation.selectedId || selectedModel;
  const selectedCapability = resolveModelCapability(modelPresentation.models, effectiveModel);
  const providerLabel = selectedCapability?.sourceName?.trim() || (selectedCapability?.agentKind === 'pi' ? 'Pi' : 'Codex');
  const inputLabel = copy.input(providerLabel);
  const settingsWritable = props.readOnly !== true && props.inputBlocked !== true && Boolean(selectedCapability);
  const modelSelectionWritable = props.readOnly !== true && props.inputBlocked !== true && modelPresentation.options.length > 0;
  const modelOptions = modelPresentation.options;
  const selectedModelLabel = modelPresentation.triggerLabel || copy.unsynced;
  const effortOptions = selectedCapability?.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? [];
  const inputResources = useConversationInputResources({
    attachments: props.state.attachments,
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    textareaRef,
    text: props.state.draft,
    disabled: !inputWritable || busy || goalInputActive,
    onTextChange: props.onDraftChange,
    onAddAttachments: (attachments) => {
      recoverInputOperation('input_resource');
      props.onAddAttachments?.(attachments);
    },
    onError: setInputResourceError,
  });
  useEffect(() => {
    const nextModel = resolveComposerModel(props.capabilities, props.runtimeSettings?.model ?? props.state.snapshot?.nextTurnSettings?.model ?? props.state.providerSettings?.model);
    const nextEffort = resolveComposerEffort(props.capabilities, nextModel, props.runtimeSettings?.effort ?? props.state.snapshot?.nextTurnSettings?.effort ?? props.state.providerSettings?.effort);
    const nextServiceTier = selectionFromEffectiveServiceTier(
      props.runtimeSettings && Object.prototype.hasOwnProperty.call(props.runtimeSettings, 'serviceTier')
        ? props.runtimeSettings.serviceTier
        : props.state.snapshot?.nextTurnSettings && Object.prototype.hasOwnProperty.call(props.state.snapshot.nextTurnSettings, 'serviceTier')
          ? props.state.snapshot.nextTurnSettings.serviceTier
          : null,
    );
    if (nextModel !== selectedModel) setSelectedModel(nextModel);
    if (nextEffort !== selectedEffort) setSelectedEffort(nextEffort);
    if (serviceTierSelectionValue(nextServiceTier) !== serviceTierSelectionValue(selectedServiceTier)) setSelectedServiceTier(nextServiceTier);
  }, [props.capabilities, props.runtimeSettings, props.state.snapshot?.nextTurnSettings, props.state.providerSettings?.effort, props.state.providerSettings?.model, selectedEffort, selectedModel, selectedServiceTier]);

  /** 自动预测要求空输入且无待处理交互；手动生成可以与主会话并行。 */
  const suggestion = useInputSuggestion({
    state: props.state,
    draft: editorValue,
    // 待处理问题由后台读取权威状态；这里仅报告即时输入限制，避免落后的会话投影漏掉完成事件。
    automaticEligible: inputWritable && !hasDraft && editorValue.length === 0 && !goalInputActive && !goalOperationBusy && !isComposing && !inputResources.processing,
    settings: props.inputSuggestionSettings,
    generate: props.onGenerateInputSuggestion,
    eligible: inputWritable && !busy && !goalInputActive && !goalOperationBusy && !isComposing && !inputResources.processing,
  });
  /** 只有空输入中的可见灰字可直接发送；已有正文优先，附件和评论仍随消息提交。 */
  const sendableSuggestion = editorValue.length === 0 ? suggestion.text : null;
  /** 按钮启用与真正发送共用当前可提交的内容，生成中和空结果不计入。 */
  const hasSendableContent = hasDraft || Boolean(sendableSuggestion?.trim());
  /** 主会话运行中也允许把已生成的建议加入原有发送队列。 */
  const showSendCommand = props.inputBlocked !== true && (goalInputActive || !active || hasSendableContent);

  useEffect(() => {
    // 拼音尚未上屏时由编辑器本地值持有组合文本，避免会话快照或草稿持久化回写打断输入法。
    if (!composingRef.current) setEditorValue(props.state.draft);
  }, [props.state.draft, setEditorValue]);

  useEffect(() => {
    if (!props.goal) return;
    setGoalInputOpen(false);
    setGoalDraft('');
  }, [props.goal]);

  /** 发送按钮明确允许采纳灰字；输入框 Enter 沿用原有草稿发送行为。 */
  function submit(nextDelivery: 'queue' | 'steer_now', acceptSuggestion = false): void {
    // 附件尚在导入时不能提交，避免正文先发出而附件随后落回草稿。
    if (!inputWritable || busy || goalOperationBusy || isComposing || composingRef.current || inputResources.processing) return;
    if (nextDelivery === 'queue' && !selectedCapability) return;
    // 点击按钮后编辑器已失去焦点，使用核对空原文的事务；失败时不发送或清空候选。
    if (acceptSuggestion && sendableSuggestion?.trim()) {
      if (!textareaRef.current?.replaceDraft?.('', sendableSuggestion)) return;
    } else if (!hasDraft) return;
    suggestion.dismiss();
    /** 采纳事务同步更新正文与引用后，再捕获发送内容，避免提交空正文。 */
    const structured = structuredSelectionRef.current;
    const settings =
      nextDelivery === 'queue' && effectiveModel
        ? {
            contextCapacityTokens: selectedCapacity,
            model: effectiveModel,
            agentKind: selectedCapability?.agentKind,
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            ...serviceTierWireOverride(selectedServiceTier),
            permissionMode: props.permissionMode,
            collaborationMode: props.collaborationMode,
            ...(structured.pluginReferences.length ? { pluginReferences: structured.pluginReferences } : {}),
            ...(structured.expertMentions.length ? { expertMentions: structured.expertMentions } : {}),
            ...(structured.skillReferences.length ? { skillReferences: structured.skillReferences } : {}),
            ...(structured.computerUseRequested ? { computerUseRequested: true } : {}),
            displayText: structured.displayText,
            promptText: structured.promptText,
          }
        : undefined;
    setInputResourceError(null);
    void Promise.resolve()
      .then(() => props.onSubmit(nextDelivery, settings))
      .then(() => recoverInputOperation('message_send'))
      .catch((error: unknown) => {
        // 发送中的连接恢复与失败已经显示在原消息下；前置拒绝仍由系统消息承载。
        if (error && typeof error === 'object' && handledMessageDeliveryErrors.has(error)) return;
        recordSystemMessage(systemScope, error, 'message_send', '消息提交失败。');
      });
  }

  function enterGoalInput(initialObjective?: string): void {
    if (initialObjective !== undefined) setGoalDraft(initialObjective);
    setGoalInputOpen(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function exitGoalInput(): void {
    if (goalSubmitting) return;
    setGoalInputOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  async function setGoalObjective(objective: string, clearMessageDraft = false): Promise<void> {
    const normalized = objective.trim();
    if (!props.onSetGoal || !normalized || [...normalized].length > 4_000 || goalOperationBusy) return;
    if (structuredSelectionRef.current.expertMentions.length > 0) {
      setInputResourceError(new Error(props.language === 'zh-CN' ? '目标模式暂不支持指定数字员工。请退出目标模式后再选择。' : 'Goal mode does not support choosing a digital employee. Exit goal mode before selecting one.'));
      return;
    }
    setGoalSubmitting(true);
    try {
      const saved = await props.onSetGoal(normalized);
      if (saved === false) return;
      if (clearMessageDraft) props.onDraftChange('');
      setGoalInputOpen(false);
      setGoalDraft('');
    } finally {
      setGoalSubmitting(false);
    }
  }

  async function runGoalCommand(command: string): Promise<void> {
    const argument = command.slice('/goal'.length).trim();
    if (!argument) {
      props.onDraftChange('');
      if (props.goal) props.onOpenGoal?.();
      else enterGoalInput();
      return;
    }
    if (props.goal && argument === 'pause' && props.onPauseGoal) {
      if ((await props.onPauseGoal()) !== false) props.onDraftChange('');
      return;
    }
    if (props.goal && argument === 'resume' && props.onResumeGoal) {
      if ((await props.onResumeGoal()) !== false) props.onDraftChange('');
      return;
    }
    if (props.goal && argument === 'clear') {
      props.onDraftChange('');
      props.onOpenGoal?.();
      return;
    }
    if (!props.goal && ['pause', 'resume', 'clear'].includes(argument)) return;
    await setGoalObjective(argument, true);
  }

  /** 普通输入与 Markdown 输入共用发送条件和附件快捷键。 */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>): void {
    // 输入法和命令菜单优先，建议的生成、采用和取消共用统一入口。
    if (!isComposing && !composingRef.current && suggestion.handleKeyDown(event, textareaRef.current)) return;
    if (!goalInputActive) inputResources.handlePasteShortcut(event);
    const intent = resolveComposerKeyIntent({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: isComposing || composingRef.current || event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      repeat: event.repeat,
    });
    if (intent === 'submit') {
      event.preventDefault();
      if (goalInputActive) {
        if (inputWritable && goalDraftValid && !busy && !goalOperationBusy) void setGoalObjective(goalDraft);
        return;
      }
      if (editorValue.trim() === '/plan' && !props.state.browserSubmission && props.onRuntimeSettingsChange) {
        props.onDraftChange('');
        props.onRuntimeSettingsChange({
          model: effectiveModel,
          effort: selectedEffort,
          ...serviceTierWireOverride(selectedServiceTier),
          permissionMode: props.permissionMode,
          collaborationMode: props.collaborationMode === 'plan' ? 'default' : 'plan',
        });
        return;
      }
      if (/^\/goal(?:\s|$)/u.test(editorValue.trim()) && !props.state.browserSubmission && props.goalAvailable) {
        if (structuredSelectionRef.current.expertMentions.length > 0) {
          setInputResourceError(new Error(props.language === 'zh-CN' ? '目标模式暂不支持指定数字员工。请退出目标模式后再选择。' : 'Goal mode does not support choosing a digital employee. Exit goal mode before selecting one.'));
          return;
        }
        void runGoalCommand(editorValue.trim());
        return;
      }
      if (inputWritable && hasDraft && !busy) submit('queue');
      return;
    }
    if (intent === 'escape' && goalInputActive) {
      event.preventDefault();
      event.stopPropagation();
      exitGoalInput();
      return;
    }
    // Escape 由 SessionWorkspace capture 统一处理，保证 approval/RUI 层优先于 interrupt。
  }

  return (
    <section
      className="session-composer-shell"
      data-input-suggestion={suggestion.text || suggestion.polishedText || suggestion.pending || suggestion.reason ? 'true' : undefined}
      aria-label={inputLabel}
      aria-busy={busy || inputResources.processing || undefined}
      data-active={active ? 'true' : 'false'}
      data-goal-input={goalInputActive ? 'true' : 'false'}
      data-input-blocked={props.inputBlocked ? 'true' : 'false'}
      data-resource-dragging={inputResources.dragging ? 'true' : 'false'}
      onDragEnter={inputResources.handleDragEnter}
      onDragOver={inputResources.handleDragOver}
      onDragLeave={inputResources.handleDragLeave}
      onDrop={inputResources.handleDrop}
    >
      {!goalInputActive && props.state.browserSubmission ? (
        <BrowserSubmissionAttachment submission={props.state.browserSubmission} language={props.language} disabled={!inputWritable || busy} onRemove={props.onRemoveBrowserSubmission} />
      ) : null}
      {!goalInputActive && (props.state.contextDraft.responseAnnotations.length || props.state.contextDraft.codeComments.length) ? (
        <ContextDraftAttachment draft={props.state.contextDraft} language={props.language} disabled={!inputWritable || busy} onRemove={() => props.onContextDraftChange?.({ responseAnnotations: [], codeComments: [] })} />
      ) : null}
      <div className="session-composer-input-frame" data-goal-input={goalInputActive ? 'true' : 'false'} data-input-suggestion={!goalInputActive && props.onGenerateInputSuggestion ? 'true' : undefined}>
        {goalInputActive ? (
          <div className="session-goal-compose-context">
            <Target aria-hidden="true" weight="regular" />
            <strong>{copy.createGoal}</strong>
            {hasDraft ? <small>{copy.normalDraftPreserved}</small> : null}
            <span className={goalCount > 4_000 ? 'session-goal-compose-count is-invalid' : 'session-goal-compose-count'}>{goalCount} / 4000</span>
            <button type="button" aria-label={copy.exitGoal} onClick={exitGoalInput} disabled={goalOperationBusy}>
              <X aria-hidden="true" weight="bold" />
            </button>
          </div>
        ) : null}
        <ConversationComposerAttachments
          attachments={props.state.attachments}
          pendingResources={inputResources.pendingResources}
          language={props.language}
          disabled={!inputWritable || busy || inputResources.processing}
          onRemove={(attachment) => props.onRemoveAttachment?.(attachment)}
        />
        {goalInputActive ? (
          <textarea
            ref={(element) => {
              textareaRef.current = element;
            }}
            aria-label={copy.goalInput}
            aria-keyshortcuts="Enter Shift+Enter Escape Meta+A Control+A"
            placeholder={copy.goalPlaceholder}
            value={goalDraft}
            disabled={!inputWritable || busy || goalOperationBusy}
            onChange={(event) => {
              setGoalDraft(event.currentTarget.value);
            }}
            onCompositionStart={() => setIsComposing(true)}
            onCompositionEnd={() => setIsComposing(false)}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <div className="session-composer-editor-with-suggestion" data-enabled={props.onGenerateInputSuggestion ? 'true' : undefined}>
            {props.onGenerateInputSuggestion ? <InputSuggestionButton suggestion={suggestion} draft={editorValue} inputRef={textareaRef} language={props.language} configured={Boolean(props.inputSuggestionSettings?.modelRef)} /> : null}
            <StructuredComposerInput
              value={editorValue}
              onValueChange={(nextValue) => {
                if (nextValue !== editorValue) suggestion.beginEditing();
                setEditorValue(nextValue);
                if (!composingRef.current) props.onDraftChange(nextValue);
              }}
              onSelectionChange={(selection) => {
                structuredSelectionRef.current = selection;
              }}
              textareaRef={textareaRef}
              projectId={props.projectId}
              language={props.language}
              disabled={!inputWritable || busy || goalOperationBusy}
              ariaLabel={inputLabel}
              ariaKeyShortcuts="Tab Enter Shift+Enter Escape Meta+A Control+A"
              placeholder={props.inputBlocked ? copy.recoveredInputBlocked : copy.placeholder}
              suggestion={suggestion.text}
              loadCatalog={props.onLoadExtensions}
              loadEmployees={props.onLoadEmployees}
              goalAvailable={props.goalAvailable}
              onPlanMode={() =>
                props.onRuntimeSettingsChange?.({
                  model: effectiveModel,
                  effort: selectedEffort,
                  ...serviceTierWireOverride(selectedServiceTier),
                  permissionMode: props.permissionMode,
                  collaborationMode: props.collaborationMode === 'plan' ? 'default' : 'plan',
                })
              }
              onGoalMode={() => {
                if (props.goal) props.onOpenGoal?.();
                else enterGoalInput();
              }}
              onOpenComputerSettings={props.onOpenComputerSettings}
              onCompositionStart={() => {
                suggestion.beginEditing();
                composingRef.current = true;
                setIsComposing(true);
              }}
              onCompositionEnd={(nextValue) => {
                composingRef.current = false;
                setIsComposing(false);
                setEditorValue(nextValue);
                props.onDraftChange(nextValue);
              }}
              onBlur={(nextValue) => {
                if (!composingRef.current) return;
                composingRef.current = false;
                setIsComposing(false);
                setEditorValue(nextValue);
                props.onDraftChange(nextValue);
              }}
              onPaste={(event) => {
                suggestion.beginEditing();
                inputResources.handlePaste(event);
              }}
              onKeyDown={handleKeyDown}
            />
          </div>
        )}
        <div className="session-composer-command-row">
          <span className="session-composer-leading-actions">
            {/* 附件入口直接显示功能提示，禁用时仍可识别用途。 */}
            {props.onChooseAttachments ? (
              <IconTooltip label={copy.attach}>
                <button type="button" className="session-attachment-button" aria-label={copy.attach} aria-haspopup="menu" onClick={inputResources.chooseAttachments} disabled={!inputWritable || busy || inputResources.processing}>
                  <Paperclip aria-hidden="true" weight="regular" />
                </button>
              </IconTooltip>
            ) : null}
            <PermissionModeControl
              language={props.language}
              supportsAutoReview={Boolean(selectedCapability) && !['unsupported', 'needs_configuration'].includes(selectedCapability?.features?.autoReview.state ?? 'unknown')}
              value={props.permissionMode}
              disabled={props.readOnly === true || props.inputBlocked === true || !props.onRuntimeSettingsChange}
              onChange={(permissionMode) =>
                props.onRuntimeSettingsChange?.({
                  model: effectiveModel,
                  effort: selectedEffort,
                  ...serviceTierWireOverride(selectedServiceTier),
                  permissionMode,
                  collaborationMode: props.collaborationMode,
                })
              }
            />
            <CollaborationModeControl
              language={props.language}
              value={props.collaborationMode}
              formalPlanReady={props.state.planImplementationRequests.length > 0}
              disabled={props.readOnly === true || props.inputBlocked === true || !props.onRuntimeSettingsChange}
              onChange={(collaborationMode) =>
                props.onRuntimeSettingsChange?.({
                  model: effectiveModel,
                  effort: selectedEffort,
                  ...serviceTierWireOverride(selectedServiceTier),
                  permissionMode: props.permissionMode,
                  collaborationMode,
                })
              }
            />
            {props.goalAvailable ? (
              <IconTooltip label={props.goal ? copy.goal : goalInputActive ? copy.exitGoal : copy.createGoal}>
                <button
                  type="button"
                  className="session-goal-trigger"
                  aria-label={props.goal ? copy.goal : goalInputActive ? copy.exitGoal : copy.createGoal}
                  aria-haspopup={props.goal ? 'dialog' : undefined}
                  aria-pressed={!props.goal ? goalInputActive : undefined}
                  data-active={goalInputActive || props.goal ? 'true' : 'false'}
                  data-status={props.goal?.status}
                  onClick={() => {
                    if (props.goal) props.onOpenGoal?.();
                    else if (goalInputActive) exitGoalInput();
                    else if (structuredSelectionRef.current.expertMentions.length > 0) {
                      setInputResourceError(new Error(props.language === 'zh-CN' ? '目标模式暂不支持指定数字员工。请退出目标模式后再选择。' : 'Goal mode does not support choosing a digital employee. Exit goal mode before selecting one.'));
                    } else enterGoalInput();
                  }}
                  disabled={props.readOnly === true || props.inputBlocked === true || goalOperationBusy || (props.goal ? !props.onOpenGoal : !props.onSetGoal)}
                >
                  <Target aria-hidden="true" weight={goalInputActive || props.goal ? 'fill' : 'regular'} />
                </button>
              </IconTooltip>
            ) : null}
          </span>
          <span className="session-composer-trailing-actions">
            <span className="session-composer-runtime-settings">
              <ContextUsageIndicator contextCapacityEvidence={props.state.snapshot?.contextCapacityEvidence} contextCapacityTokens={selectedCapacity} unifiedUsage={props.state.unifiedUsage} language={props.language} />
              <ServiceTierToggle
                language={props.language}
                model={selectedCapability}
                value={selectedServiceTier}
                disabled={!settingsWritable}
                onChange={(selection) => {
                  setSelectedServiceTier(selection);
                  props.onRuntimeSettingsChange?.({
                    contextCapacityTokens: selectedCapacity,
                    model: effectiveModel,
                    effort: selectedEffort,
                    ...serviceTierWireOverride(selection),
                    permissionMode: props.permissionMode,
                    collaborationMode: props.collaborationMode,
                  });
                }}
              />
              <ComposerDropdown
                label={copy.model}
                triggerLabel={`${copy.model}：${selectedModelLabel}`}
                displayLabel={selectedModelLabel}
                // 窄输入框通过容器查询只显示图标，模型名称继续用于提示和无障碍名称。
                triggerIcon={<ModelBrainIcon />}
                className="session-composer-model-dropdown"
                value={effectiveModel}
                options={modelOptions}
                pinning={modelPresentation.pinning}
                disabled={!modelSelectionWritable}
                searchable
                searchPlaceholder={copy.searchModel}
                emptyLabel={copy.noModel}
                onChange={(model) => {
                  /** 模型能力包含供应商身份及当前允许的参数。 */
                  const capability = resolveModelCapability(props.capabilities?.models, model);
                  /** 完整身份用于区分不同供应商的同名模型。 */
                  const modelId = capability?.id ?? model;
                  /** 审查等独立工作流不读取普通会话配置。 */
                  const storage = props.restoreProjectModelPreferences ? browserProjectModelPreferenceStorage() : undefined;
                  /** 历史推送模型名只在目录中唯一匹配时恢复。 */
                  const last = props.projectId ? readProjectModelPreferences(storage, props.projectId) : null;
                  /** 仅恢复所选项目和模型的选择。 */
                  const remembered = props.projectId ? (readProjectModelPreferences(storage, props.projectId, modelId) ?? (resolveModelCapability(props.capabilities?.models, last?.model)?.id === modelId ? last : null)) : null;
                  /** 无已用等级或当前模型不再支持时采用模型默认。 */
                  const effort = remembered && capability?.supportedReasoningEfforts.includes(remembered.effort) ? remembered.effort : (capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '');
                  /** 不支持的 Fast 由现有速度控件说明。 */
                  const normalizedTier = normalizeServiceTierSelection(remembered?.serviceTier ?? { type: 'standard' }, capability);
                  /** 已记住容量失效时使用默认容量，未有记忆时保留当前会话选择。 */
                  const capacity = remembered ? (contextCapacitySelectionAllowed(remembered.contextCapacityTokens, capability?.contextCapacity) ? remembered.contextCapacityTokens : null) : selectedCapacity;
                  if (remembered && remembered.contextCapacityTokens !== capacity) {
                    recordSystemMessage(
                      systemScope,
                      props.language === 'zh-CN' ? '已记住的上下文容量不受当前模型支持，已改用默认容量。' : 'The remembered context capacity is unsupported by this model; the default capacity will be used.',
                      'message_send',
                      '模型配置恢复失败。',
                    );
                  }
                  setSelectedModel(model);
                  setSelectedEffort(effort);
                  setSelectedServiceTier(normalizedTier.selection);
                  props.onRuntimeSettingsChange?.({
                    contextCapacityTokens: capacity,
                    model: modelId,
                    agentKind: capability?.agentKind,
                    effort,
                    ...serviceTierWireOverride(normalizedTier.selection),
                    permissionMode: remembered?.permissionMode ?? props.permissionMode,
                    collaborationMode: remembered?.workMode ?? props.collaborationMode,
                  });
                }}
              />
              {effortOptions.length > 0 ? (
                <ComposerDropdown
                  label={copy.effort}
                  triggerLabel={`${copy.effort}：${selectedEffort}`}
                  value={selectedEffort}
                  options={effortOptions}
                  disabled={!settingsWritable}
                  onChange={(effort) => {
                    setSelectedEffort(effort);
                    props.onRuntimeSettingsChange?.({
                      contextCapacityTokens: selectedCapacity,
                      model: effectiveModel,
                      effort,
                      ...serviceTierWireOverride(selectedServiceTier),
                      permissionMode: props.permissionMode,
                      collaborationMode: props.collaborationMode,
                    });
                  }}
                />
              ) : null}
            </span>
            <span className="session-primary-command-slot" data-primary-command-slot="true">
              {showSendCommand ? (
                <button
                  type="button"
                  className="session-send-button"
                  aria-label={goalInputActive ? copy.createGoal : sendableSuggestion ? copy.sendSuggestion : copy.send}
                  onClick={() => (goalInputActive ? void setGoalObjective(goalDraft) : submit('queue', true))}
                  disabled={!inputWritable || !settingsWritable || busy || goalOperationBusy || inputResources.processing || (goalInputActive ? !goalDraftValid : !hasSendableContent)}
                  aria-busy={busy || goalOperationBusy || inputResources.processing || undefined}
                >
                  {busy || goalOperationBusy || inputResources.processing ? <span className="session-command-spinner" aria-hidden="true" /> : <ArrowUp aria-hidden="true" weight="bold" />}
                </button>
              ) : (
                <button
                  type="button"
                  className="session-stop-button"
                  aria-label={busy ? (props.language === 'zh-CN' ? '正在暂停' : 'Pausing') : copy.stop}
                  aria-busy={busy || undefined}
                  onClick={() => props.state.activeTurnId && void props.onInterrupt(props.state.activeTurnId)}
                  disabled={!writable || !props.state.activeTurnId || props.state.startedTurnId !== props.state.activeTurnId || busy}
                >
                  {busy ? <span className="session-command-spinner" aria-hidden="true" /> : <Square aria-hidden="true" weight="fill" />}
                </button>
              )}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

/** 两类评论附件共用开关行为，等待只影响悬停，保留键盘和点击查看。 */
function useContextDraftPreview() {
  /** CSS 只负责展示，是否展开由真实交互状态决定。 */
  const [open, setOpen] = useState(false);
  /** 跨过气泡与详情之间的间隙时保留阅读入口。 */
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** 附件和其他详情采用同一连续停留时间。 */
  const hoverIntent = useHoverIntent(() => setOpen(true));
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  /** 点击与键盘操作直接展示，并撤销所有旧计时。 */
  function show(): void {
    clearTimeout(closeTimer.current);
    hoverIntent.cancel();
    setOpen(true);
  }

  /** 移出后允许跨越小间隙，焦点仍在详情内时继续阅读。 */
  function closeLater(element: HTMLElement): void {
    hoverIntent.cancel();
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (!element.matches(':hover') && !element.contains(element.ownerDocument.activeElement)) setOpen(false);
    }, 120);
  }

  /** 两种附件使用同一组事件，移除按钮不单独创建提示。 */
  const surfaceProps: HTMLAttributes<HTMLElement> & { 'data-preview-open': boolean } = {
    'data-preview-open': open,
    onPointerEnter(event) {
      clearTimeout(closeTimer.current);
      if (!open && event.pointerType !== 'touch' && event.buttons === 0) hoverIntent.schedule(event.currentTarget);
    },
    onPointerLeave(event) {
      closeLater(event.currentTarget);
    },
    onFocusCapture(event) {
      hoverIntent.cancel();
      if (event.target.matches(':focus-visible') && !event.currentTarget.contains(event.relatedTarget)) show();
    },
    onBlurCapture(event) {
      if (!event.currentTarget.contains(event.relatedTarget)) closeLater(event.currentTarget);
    },
    onKeyDown(event) {
      if (event.key !== 'Escape') return;
      hoverIntent.cancel();
      clearTimeout(closeTimer.current);
      if (!open) return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      // 从详情内部关闭时把焦点送回摘要，同一容器内的焦点恢复不会重新展开。
      event.currentTarget.querySelector<HTMLButtonElement>('.session-context-draft-preview-trigger')?.focus({ preventScroll: true });
    },
  };
  return { open, show, surfaceProps };
}

/** 待发送评论统一计数，悬停或聚焦时展示原文、来源与内容。 */
function ContextDraftAttachment(props: { draft: ConversationContextDraft; language: SessionUiLanguage; disabled: boolean; onRemove?: () => void }) {
  /** 评论摘要沿用共享的延迟与立即打开行为。 */
  const preview = useContextDraftPreview();
  /** 回答和代码评论在摘要中合计，详情继续保留各自来源。 */
  const count = props.draft.responseAnnotations.length + props.draft.codeComments.length;
  const zh = props.language === 'zh-CN';
  /** 唯一标识用于把摘要按钮与只读详情浮层关联。 */
  const previewId = useId();
  const label = zh ? `${count} 条评论` : `${count} ${count === 1 ? 'comment' : 'comments'}`;
  return (
    <section {...preview.surfaceProps} className="session-composer-context-draft" aria-label={zh ? '待发送评论' : 'Pending comments'}>
      <span className="session-context-draft-chip">
        <button type="button" className="session-context-draft-preview-trigger" aria-describedby={preview.open ? previewId : undefined} onClick={preview.show}>
          <ChatCircle aria-hidden="true" weight="regular" />
          <strong>{label}</strong>
        </button>
        <button type="button" aria-label={zh ? '移除评论' : 'Remove comments'} onClick={props.onRemove} disabled={props.disabled || !props.onRemove}>
          <span aria-hidden="true">×</span>
        </button>
      </span>
      <aside id={previewId} className="session-context-draft-preview" role="tooltip" aria-hidden={!preview.open} inert={!preview.open}>
        <header>
          <strong>{zh ? '待发送详情' : 'Pending details'}</strong>
          <span>{label}</span>
        </header>
        <div className="session-message-response-annotations">
          {props.draft.codeComments.map((comment, index) => (
            <article key={comment.id}>
              <span>
                {zh ? `代码评论 ${index + 1}` : `Code comment ${index + 1}`} · {comment.position.path}:
                {comment.position.startLine && comment.position.startLine !== comment.position.line ? `${comment.position.startLine}-${comment.position.line}` : comment.position.line}
              </span>
              {comment.position.selectedText?.trim() ? (
                <blockquote>
                  <span className="session-response-annotation-label">{zh ? '引用原文' : 'Quoted text'}</span>
                  {comment.position.selectedText}
                </blockquote>
              ) : null}
              {comment.body.trim() ? (
                <p>
                  {comment.position.selectedText?.trim() ? <span className="session-response-annotation-label">{zh ? '我的评论' : 'My comment'}</span> : null}
                  {comment.body}
                </p>
              ) : null}
            </article>
          ))}
          {props.draft.responseAnnotations.map((annotation, index) => (
            <article key={annotation.id}>
              <span>{zh ? `回答评论 ${index + 1}` : `Response comment ${index + 1}`}</span>
              <blockquote>
                <span className="session-response-annotation-label">{zh ? '引用原文' : 'Quoted text'}</span>
                {annotation.anchor.selectedText}
              </blockquote>
              {annotation.note?.trim() ? (
                <p>
                  <span className="session-response-annotation-label">{zh ? '我的评论' : 'My comment'}</span>
                  {annotation.note}
                </p>
              ) : null}
            </article>
          ))}
        </div>
      </aside>
    </section>
  );
}

/** 网页评论沿用回答评论的摘要气泡，悬停或聚焦后查看原文与评论。 */
export function BrowserSubmissionAttachment(props: { submission: ZeusBrowserPreparedSubmission; language: SessionUiLanguage; disabled: boolean; onRemove?: () => void }) {
  /** 网页评论与代码评论使用同一个展开规则。 */
  const preview = useContextDraftPreview();
  /** 详情与当前气泡一一关联，支持键盘聚焦。 */
  const previewId = useId();
  /** 统一当前语言的摘要文案。 */
  const zh = props.language === 'zh-CN';
  /** 输入框只展示数量，完整内容放入悬浮详情。 */
  const label = zh ? `${props.submission.comments.length} 条网页评论` : `${props.submission.comments.length} browser comments`;
  return (
    <section {...preview.surfaceProps} className="session-composer-context-draft" aria-label={zh ? '待发送网页评论' : 'Pending browser comments'}>
      <span className="session-context-draft-chip">
        <button type="button" className="session-context-draft-preview-trigger" aria-describedby={preview.open ? previewId : undefined} onClick={preview.show}>
          <ChatCircle aria-hidden="true" weight="regular" />
          <strong>{label}</strong>
        </button>
        <button type="button" aria-label={props.language === 'zh-CN' ? '移除网页评论' : 'Remove browser comments'} onClick={props.onRemove} disabled={props.disabled || !props.onRemove}>
          <span aria-hidden="true">×</span>
        </button>
      </span>
      <aside id={previewId} className="session-context-draft-preview" aria-label={zh ? '网页评论详情' : 'Browser comment details'} aria-hidden={!preview.open} inert={!preview.open}>
        <BrowserCommentPreview comments={props.submission.comments} zh={zh} />
      </aside>
    </section>
  );
}

export function resolveComposerKeyIntent(input: { key: string; shiftKey: boolean; isComposing: boolean; keyCode?: number; repeat: boolean }): ComposerKeyIntent {
  if (input.repeat) return 'ignore';
  if (input.key === 'Escape') return 'escape';
  if (input.key !== 'Enter') return 'ignore';
  // Chromium 在部分输入法收尾按键上只保留 229，不能把该 Enter 当成发送。
  if (input.isComposing || input.keyCode === 229) return 'ignore';
  return input.shiftKey ? 'newline' : 'submit';
}

export function canSteerActiveTurn(state: NativeSessionState): boolean {
  const active = state.conversationState === 'active_prework' || state.conversationState === 'active_final_answer';
  if (!active || state.transportState !== 'ready' || !state.activeTurnId || state.startedTurnId !== state.activeTurnId) return false;
  // 正式正文或正式计划完成后，用户看到的这一轮已经交付；Provider 的后台收尾不能继续开放“引导”。
  return !Object.values(state.items).some((item) => {
    if (item.turnId !== state.activeTurnId || item.status !== 'completed' || !item.text.trim()) return false;
    // 不同 Provider 的正文类型命名先归一化再判断。
    const type = item.type.toLocaleLowerCase().replace(/[\s_\-/]+/gu, '');
    // 旧快照可能把阶段保存在顶层，新快照优先使用原始载荷。
    const messageKind = classifyAssistantMessage(item.payload, item.phase);
    if ((type === 'agentmessage' || type === 'assistantmessage' || type === 'assistant' || type === 'message') && messageKind === 'final') return true;
    if (type !== 'plan') return false;
    return item.payload.formalPlan === true || state.planImplementationRequests.some((request) => request.planItemId === item.localItemId || request.planItemId === item.itemId || request.planItemId === item.providerItemId);
  });
}

function resolveComposerModel(capabilities: CodexConversationCapabilities | null | undefined, providerModel: string | undefined): string {
  const normalized = providerModel?.trim();
  const availableModels = capabilities?.models.filter((model) => model.available !== false);
  if (normalized) return resolveModelCapability(availableModels, normalized)?.id ?? normalized;
  return resolveModelCapability(availableModels, capabilities?.preferredModel)?.id ?? availableModels?.[0]?.id ?? '';
}

function resolveComposerEffort(capabilities: CodexConversationCapabilities | null | undefined, model: string, providerEffort: string | undefined): string {
  const capability = resolveModelCapability(capabilities?.models, model);
  const normalized = providerEffort?.trim();
  if (normalized && capability?.supportedReasoningEfforts.includes(normalized)) return normalized;
  return capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? normalized ?? '';
}
