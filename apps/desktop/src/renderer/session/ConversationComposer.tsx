import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { ArrowUpIcon as ArrowUp } from '@phosphor-icons/react/dist/csr/ArrowUp';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
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
import { autosizeTextarea } from './textareaAutosize.js';
import { CollaborationModeControl } from './CollaborationModeControl.js';
import { ConversationComposerAttachments } from './ConversationComposerAttachments.js';
import { ContextUsageIndicator } from './ContextUsageIndicator.js';
import { ServiceTierToggle } from './ServiceTierToggle.js';
import { resolveModelCapability } from './modelSelection.js';
import { useConversationInputResources } from './useConversationInputResources.js';
import { normalizeServiceTierSelection, selectionFromEffectiveServiceTier, serviceTierSelectionValue, serviceTierWireOverride } from './serviceTierSelection.js';
import { presentModelOptions } from '../modelOptionPresentation.js';
import { useApplicationErrorDialog } from '../ui/ApplicationErrorDialog.js';

export type ComposerKeyIntent = 'submit' | 'newline' | 'escape' | 'ignore';
export interface ComposerRuntimeSettings {
  model: string;
  agentKind?: 'codex' | 'pi';
  effort?: string;
  serviceTier?: string | null;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
}

export interface ConversationComposerProps {
  state: NativeSessionState;
  language: SessionUiLanguage;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  capabilities?: CodexConversationCapabilities | null;
  onDraftChange: (draft: string) => void;
  onSubmit: (delivery: 'queue' | 'steer_now', settings?: NativeTurnSettingsSelection) => void | Promise<void>;
  onInterrupt: (turnId: string) => void | Promise<void>;
  onChooseAttachments?: () => void | Promise<void>;
  onAddAttachments?: (attachments: NativeConversationAttachment[]) => void;
  onRemoveAttachment?: (attachment: NativeConversationAttachment) => void;
  onRemoveBrowserSubmission?: () => void;
  onContextDraftChange?: (draft: ConversationContextDraft) => void;
  runtimeSettings?: ComposerRuntimeSettings | null;
  onRuntimeSettingsChange?: (settings: ComposerRuntimeSettings) => void;
  readOnly?: boolean;
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
    input: '发送消息给 Codex',
    placeholder: '继续对话，Enter 发送，Shift+Enter 换行',
    send: '发送',
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
  },
  'en-US': {
    input: 'Message Codex',
    placeholder: 'Continue the conversation. Enter to send, Shift+Enter for a newline.',
    send: 'Send',
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
  },
} as const;

export function ConversationComposer(props: ConversationComposerProps) {
  const copy = labels[props.language];
  const initialModel = resolveComposerModel(props.capabilities, props.runtimeSettings?.model ?? props.state.providerSettings?.model);
  const initialEffort = resolveComposerEffort(props.capabilities, initialModel, props.runtimeSettings?.effort ?? props.state.providerSettings?.effort);
  const initialServiceTier = selectionFromEffectiveServiceTier(
    props.runtimeSettings && Object.prototype.hasOwnProperty.call(props.runtimeSettings, 'serviceTier') ? props.runtimeSettings.serviceTier : props.state.providerSettings?.serviceTier,
    resolveModelCapability(props.capabilities?.models, initialModel),
  );
  const fallbackRef = useRef<HTMLTextAreaElement | null>(null);
  const textareaRef = props.textareaRef ?? fallbackRef;
  const composingRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const [editorValue, setEditorValue] = useState(props.state.draft);
  const [goalInputOpen, setGoalInputOpen] = useState(false);
  const [goalDraft, setGoalDraft] = useState('');
  const [goalSubmitting, setGoalSubmitting] = useState(false);
  const [inputResourceError, setInputResourceError] = useState<string | null>(null);
  useApplicationErrorDialog(inputResourceError, {
    language: props.language === 'zh-CN' ? 'zh-CN' : 'en',
    title: props.language === 'zh-CN' ? '会话附件处理失败' : 'Conversation attachment failed',
    source: 'ConversationComposer',
  });
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [selectedEffort, setSelectedEffort] = useState(initialEffort);
  const [selectedServiceTier, setSelectedServiceTier] = useState<NativeServiceTierSelection>(initialServiceTier);
  const active = props.state.conversationState === 'active_prework' || props.state.conversationState === 'active_final_answer';
  const busy = Boolean(props.state.busyOperation);
  const writable = props.readOnly !== true && props.state.conversationState !== 'legacy_readonly';
  const hasDraft = editorValue.trim().length > 0 || props.state.attachments.length > 0 || Boolean(props.state.browserSubmission) || props.state.contextDraft.responseAnnotations.length > 0 || props.state.contextDraft.codeComments.length > 0;
  const goalInputActive = goalInputOpen && !props.goal;
  const goalCount = [...goalDraft.trim()].length;
  const goalDraftValid = goalCount > 0 && goalCount <= 4_000;
  const goalOperationBusy = goalSubmitting || props.goalBusy === true;
  const showSendCommand = goalInputActive || !active || hasDraft;
  const modelPresentation = useMemo(() => presentModelOptions(props.capabilities?.models ?? [], selectedModel, props.language, { preserveMissingSelection: true }), [props.capabilities?.models, props.language, selectedModel]);
  const effectiveModel = modelPresentation.selectedId || selectedModel;
  const selectedCapability = resolveModelCapability(modelPresentation.models, effectiveModel);
  const settingsWritable = props.readOnly !== true && Boolean(selectedCapability);
  const modelSelectionWritable = props.readOnly !== true && modelPresentation.options.length > 0;
  const modelOptions = modelPresentation.options;
  const selectedModelLabel = modelPresentation.triggerLabel || copy.unsynced;
  const effortOptions = selectedCapability?.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? [];
  const inputResources = useConversationInputResources({
    textareaRef,
    text: props.state.draft,
    disabled: !writable || busy || goalInputActive,
    onTextChange: props.onDraftChange,
    onAddAttachments: (attachments) => {
      setInputResourceError(null);
      props.onAddAttachments?.(attachments);
    },
    onRemoveAttachment: (attachment) => props.onRemoveAttachment?.(attachment),
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
          : props.state.providerSettings?.serviceTier,
      resolveModelCapability(props.capabilities?.models, nextModel),
    );
    if (nextModel !== selectedModel) setSelectedModel(nextModel);
    if (nextEffort !== selectedEffort) setSelectedEffort(nextEffort);
    if (serviceTierSelectionValue(nextServiceTier) !== serviceTierSelectionValue(selectedServiceTier)) setSelectedServiceTier(nextServiceTier);
  }, [
    props.capabilities,
    props.runtimeSettings,
    props.state.snapshot?.nextTurnSettings,
    props.state.providerSettings?.effort,
    props.state.providerSettings?.model,
    props.state.providerSettings?.serviceTier,
    selectedEffort,
    selectedModel,
    selectedServiceTier,
  ]);

  useLayoutEffect(() => {
    if (textareaRef.current) autosizeTextarea(textareaRef.current);
  }, [editorValue, goalDraft, goalInputActive, textareaRef]);

  useEffect(() => {
    // 拼音尚未上屏时由 textarea 本地值持有组合文本，避免会话快照或草稿持久化回写打断输入法。
    if (!composingRef.current) setEditorValue(props.state.draft);
  }, [props.state.draft]);

  useEffect(() => {
    if (!props.goal) return;
    setGoalInputOpen(false);
    setGoalDraft('');
  }, [props.goal]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const view = textarea?.ownerDocument.defaultView;
    if (!textarea || !view) return;
    const resize = () => autosizeTextarea(textarea);
    view.addEventListener('resize', resize);
    return () => view.removeEventListener('resize', resize);
  }, [textareaRef]);

  function submit(nextDelivery: 'queue' | 'steer_now'): void {
    if (nextDelivery === 'queue' && !selectedCapability) return;
    const settings =
      nextDelivery === 'queue' && effectiveModel
        ? {
            model: effectiveModel,
            agentKind: selectedCapability?.agentKind,
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            ...serviceTierWireOverride(selectedServiceTier),
            permissionMode: props.permissionMode,
            collaborationMode: props.collaborationMode,
          }
        : undefined;
    void props.onSubmit(nextDelivery, settings);
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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
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
        if (writable && goalDraftValid && !busy && !goalOperationBusy) void setGoalObjective(goalDraft);
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
        void runGoalCommand(editorValue.trim());
        return;
      }
      if (writable && hasDraft && !busy) submit('queue');
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
      aria-label={copy.input}
      data-active={active ? 'true' : 'false'}
      data-goal-input={goalInputActive ? 'true' : 'false'}
      data-resource-dragging={inputResources.dragging ? 'true' : 'false'}
      onDragEnter={inputResources.handleDragEnter}
      onDragOver={inputResources.handleDragOver}
      onDragLeave={inputResources.handleDragLeave}
      onDrop={inputResources.handleDrop}
    >
      {!goalInputActive && props.state.browserSubmission ? <BrowserSubmissionAttachment submission={props.state.browserSubmission} language={props.language} disabled={!writable || busy} onRemove={props.onRemoveBrowserSubmission} /> : null}
      {!goalInputActive && (props.state.contextDraft.responseAnnotations.length || props.state.contextDraft.codeComments.length) ? (
        <ContextDraftAttachment draft={props.state.contextDraft} language={props.language} disabled={!writable || busy} onRemove={() => props.onContextDraftChange?.({ responseAnnotations: [], codeComments: [] })} />
      ) : null}
      <div className="session-composer-input-frame" data-goal-input={goalInputActive ? 'true' : 'false'}>
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
        ) : (
          <ConversationComposerAttachments
            attachments={props.state.attachments}
            language={props.language}
            disabled={!writable || busy || inputResources.processing}
            onRemove={(attachment) => props.onRemoveAttachment?.(attachment)}
            onRestorePastedText={inputResources.restorePastedText}
          />
        )}
        <textarea
          ref={textareaRef}
          aria-label={goalInputActive ? copy.goalInput : copy.input}
          aria-keyshortcuts="Enter Shift+Enter Escape Meta+A Control+A"
          placeholder={goalInputActive ? copy.goalPlaceholder : copy.placeholder}
          value={goalInputActive ? goalDraft : editorValue}
          disabled={!writable || busy || goalOperationBusy}
          onChange={(event) => {
            autosizeTextarea(event.currentTarget);
            const nextValue = event.currentTarget.value;
            if (goalInputActive) {
              setGoalDraft(nextValue);
              return;
            }
            setEditorValue(nextValue);
            if (!composingRef.current) props.onDraftChange(nextValue);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
            setIsComposing(true);
          }}
          onCompositionEnd={(event) => {
            const nextValue = event.currentTarget.value;
            composingRef.current = false;
            setIsComposing(false);
            if (goalInputActive) {
              setGoalDraft(nextValue);
              return;
            }
            setEditorValue(nextValue);
            props.onDraftChange(nextValue);
          }}
          onBlur={(event) => {
            if (!composingRef.current) return;
            const nextValue = event.currentTarget.value;
            composingRef.current = false;
            setIsComposing(false);
            if (goalInputActive) {
              setGoalDraft(nextValue);
              return;
            }
            setEditorValue(nextValue);
            props.onDraftChange(nextValue);
          }}
          onPaste={goalInputActive ? undefined : inputResources.handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="session-composer-command-row">
          <span className="session-composer-leading-actions">
            {!goalInputActive && props.onChooseAttachments ? (
              <button
                type="button"
                className="session-attachment-button"
                aria-label={copy.attach}
                onClick={() => {
                  setInputResourceError(null);
                  void Promise.resolve(props.onChooseAttachments?.()).catch((error: unknown) => {
                    setInputResourceError(error instanceof Error ? error.message : String(error));
                  });
                }}
                disabled={!writable || busy || inputResources.processing}
              >
                <Paperclip aria-hidden="true" weight="regular" />
              </button>
            ) : null}
            <PermissionModeControl
              language={props.language}
              value={props.permissionMode}
              disabled={props.readOnly === true || !props.onRuntimeSettingsChange}
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
              disabled={props.readOnly === true || !props.onRuntimeSettingsChange}
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
              <button
                type="button"
                className="session-goal-trigger"
                aria-label={props.goal ? copy.goal : goalInputActive ? copy.exitGoal : copy.createGoal}
                aria-haspopup={props.goal ? 'dialog' : undefined}
                aria-pressed={!props.goal ? goalInputActive : undefined}
                data-active={goalInputActive || props.goal ? 'true' : 'false'}
                data-status={props.goal?.status}
                title={props.goal ? copy.goal : copy.createGoal}
                onClick={() => {
                  if (props.goal) props.onOpenGoal?.();
                  else if (goalInputActive) exitGoalInput();
                  else enterGoalInput();
                }}
                disabled={props.readOnly === true || goalOperationBusy || (props.goal ? !props.onOpenGoal : !props.onSetGoal)}
              >
                <Target aria-hidden="true" weight={goalInputActive || props.goal ? 'fill' : 'regular'} />
              </button>
            ) : null}
          </span>
          <span className="session-composer-trailing-actions">
            <span className="session-composer-runtime-settings">
              <ContextUsageIndicator usage={props.state.tokenUsage} unifiedUsage={props.state.unifiedUsage} language={props.language} />
              <ServiceTierToggle
                language={props.language}
                model={selectedCapability}
                value={selectedServiceTier}
                disabled={!settingsWritable}
                onChange={(selection) => {
                  setSelectedServiceTier(selection);
                  props.onRuntimeSettingsChange?.({ model: effectiveModel, effort: selectedEffort, ...serviceTierWireOverride(selection), permissionMode: props.permissionMode, collaborationMode: props.collaborationMode });
                }}
              />
              <ComposerDropdown
                label={copy.model}
                triggerLabel={`${copy.model}：${selectedModelLabel}`}
                displayLabel={selectedModelLabel}
                className="session-composer-model-dropdown"
                value={effectiveModel}
                options={modelOptions}
                disabled={!modelSelectionWritable}
                searchable
                searchPlaceholder={copy.searchModel}
                emptyLabel={copy.noModel}
                onChange={(model) => {
                  const capability = resolveModelCapability(props.capabilities?.models, model);
                  const effort = capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '';
                  const normalizedTier = normalizeServiceTierSelection(selectedServiceTier, capability);
                  setSelectedModel(model);
                  setSelectedEffort(effort);
                  setSelectedServiceTier(normalizedTier.selection);
                  props.onRuntimeSettingsChange?.({ model, agentKind: capability?.agentKind, effort, ...serviceTierWireOverride(normalizedTier.selection), permissionMode: props.permissionMode, collaborationMode: props.collaborationMode });
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
                    props.onRuntimeSettingsChange?.({ model: effectiveModel, effort, ...serviceTierWireOverride(selectedServiceTier), permissionMode: props.permissionMode, collaborationMode: props.collaborationMode });
                  }}
                />
              ) : null}
            </span>
            <span className="session-primary-command-slot" data-primary-command-slot="true">
              {showSendCommand ? (
                <button
                  type="button"
                  className="session-send-button"
                  aria-label={goalInputActive ? copy.createGoal : copy.send}
                  onClick={() => (goalInputActive ? void setGoalObjective(goalDraft) : submit('queue'))}
                  disabled={!writable || !settingsWritable || busy || goalOperationBusy || (goalInputActive ? !goalDraftValid : !hasDraft)}
                  aria-busy={busy || goalOperationBusy || undefined}
                >
                  {busy || goalOperationBusy ? <span className="session-command-spinner" aria-hidden="true" /> : <ArrowUp aria-hidden="true" weight="bold" />}
                </button>
              ) : (
                <button
                  type="button"
                  className="session-stop-button"
                  aria-label={copy.stop}
                  onClick={() => props.state.activeTurnId && void props.onInterrupt(props.state.activeTurnId)}
                  disabled={!writable || !props.state.activeTurnId || props.state.startedTurnId !== props.state.activeTurnId || busy}
                >
                  <Square aria-hidden="true" weight="fill" />
                </button>
              )}
            </span>
          </span>
        </div>
      </div>
    </section>
  );
}

function ContextDraftAttachment(props: { draft: ConversationContextDraft; language: SessionUiLanguage; disabled: boolean; onRemove?: () => void }) {
  const annotations = props.draft.responseAnnotations.length;
  const comments = props.draft.codeComments.length;
  const zh = props.language === 'zh-CN';
  const label = zh
    ? [comments ? `${comments} 个评论` : '', annotations ? `${annotations} 条注释` : ''].filter(Boolean).join('、')
    : [comments ? `${comments} ${comments === 1 ? 'comment' : 'comments'}` : '', annotations ? `${annotations} ${annotations === 1 ? 'annotation' : 'annotations'}` : ''].filter(Boolean).join(', ');
  return (
    <section className="session-composer-context-draft" aria-label={zh ? '待发送评论与注释' : 'Pending comments and annotations'}>
      <span className="session-context-draft-chip">
        <ChatCircle aria-hidden="true" weight="regular" />
        <strong>{label}</strong>
        <button type="button" aria-label={zh ? '移除评论与注释' : 'Remove comments and annotations'} onClick={props.onRemove} disabled={props.disabled || !props.onRemove}>
          <span aria-hidden="true">×</span>
        </button>
      </span>
    </section>
  );
}

function BrowserSubmissionAttachment(props: { submission: ZeusBrowserPreparedSubmission; language: SessionUiLanguage; disabled: boolean; onRemove?: () => void }) {
  const screenshot = props.submission.attachments[0];
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const firstComment = props.submission.comments[0];
  const pageTitle = firstComment?.anchor.pageTitle || firstComment?.anchor.pageUrl || (props.language === 'zh-CN' ? '浏览器页面' : 'Browser page');
  const count = props.submission.commentIds.length;

  useEffect(() => {
    let active = true;
    setPreviewUrl(null);
    if (!screenshot?.localPath || !window.zeus?.getBrowserCommentPreview)
      return () => {
        active = false;
      };
    void window.zeus
      .getBrowserCommentPreview(screenshot.localPath)
      .then((preview) => {
        if (active) setPreviewUrl(preview?.previewUrl ?? null);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [screenshot?.localPath]);

  return (
    <section className="session-composer-browser-submission" aria-label={props.language === 'zh-CN' ? '待发送浏览器批注' : 'Pending browser comments'}>
      <div className="session-browser-preview-card" title={pageTitle}>
        {previewUrl ? <img src={previewUrl} alt={pageTitle} /> : <GlobeSimple aria-hidden="true" weight="regular" />}
        <button type="button" aria-label={props.language === 'zh-CN' ? '移除浏览器批注' : 'Remove browser comments'} onClick={props.onRemove} disabled={props.disabled || !props.onRemove}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <span className="session-browser-comment-chip">
        <ChatCircle aria-hidden="true" weight="regular" />
        <strong>{props.language === 'zh-CN' ? `${count} 条注释` : `${count} ${count === 1 ? 'comment' : 'comments'}`}</strong>
      </span>
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
  return active && state.transportState === 'ready' && Boolean(state.activeTurnId) && state.startedTurnId === state.activeTurnId;
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
