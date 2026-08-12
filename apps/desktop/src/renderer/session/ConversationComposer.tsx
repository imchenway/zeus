import { type KeyboardEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChatCircleIcon as ChatCircle } from '@phosphor-icons/react/dist/csr/ChatCircle';
import { GlobeSimpleIcon as GlobeSimple } from '@phosphor-icons/react/dist/csr/GlobeSimple';
import { LightningIcon as Lightning } from '@phosphor-icons/react/dist/csr/Lightning';
import type { ZeusBrowserPreparedSubmission } from '@zeus/shared';
import type { CodexConversationCapabilities, NativeCollaborationMode, NativeConversationAttachment, NativePermissionMode, NativeServiceTierSelection, NativeSessionState, NativeTurnSettingsSelection } from './sessionTypes.js';
import { ComposerDropdown } from './ComposerDropdown.js';
import { PermissionModeControl } from './PermissionModeControl.js';
import type { SessionUiLanguage } from './ThreadItemView.js';
import { autosizeTextarea } from './textareaAutosize.js';
import { CollaborationModeControl } from './CollaborationModeControl.js';
import { ConversationComposerAttachments } from './ConversationComposerAttachments.js';
import { ContextUsageIndicator } from './ContextUsageIndicator.js';
import { resolveModelCapability } from './modelSelection.js';
import { useConversationInputResources } from './useConversationInputResources.js';
import { normalizeServiceTierSelection, selectionFromEffectiveServiceTier, serviceTierOptions, serviceTierSelectionFromValue, serviceTierSelectionValue, serviceTierWireOverride } from './serviceTierSelection.js';

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
  runtimeSettings?: ComposerRuntimeSettings | null;
  onRuntimeSettingsChange?: (settings: ComposerRuntimeSettings) => void;
  readOnly?: boolean;
  permissionMode: NativePermissionMode;
  collaborationMode: NativeCollaborationMode;
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
    serviceTier: '服务档位',
    unsynced: '未同步',
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
    serviceTier: 'Service tier',
    unsynced: 'Not synced',
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
  const [isComposing, setIsComposing] = useState(false);
  const [inputResourceError, setInputResourceError] = useState<string | null>(null);
  const [selectedModel, setSelectedModel] = useState(initialModel);
  const [selectedEffort, setSelectedEffort] = useState(initialEffort);
  const [selectedServiceTier, setSelectedServiceTier] = useState<NativeServiceTierSelection>(initialServiceTier);
  const [serviceTierDowngraded, setServiceTierDowngraded] = useState(false);
  const active = props.state.conversationState === 'active_prework' || props.state.conversationState === 'active_final_answer';
  const busy = Boolean(props.state.busyOperation);
  const writable = props.readOnly !== true && props.state.conversationState !== 'legacy_readonly';
  const hasDraft = props.state.draft.trim().length > 0 || props.state.attachments.length > 0 || Boolean(props.state.browserSubmission);
  const selectedCapability = resolveModelCapability(props.capabilities?.models, selectedModel);
  const settingsWritable = props.readOnly !== true && Boolean(selectedCapability);
  const modelOptions = props.capabilities?.models.length
    ? props.capabilities.models.map((capability) => ({
        value: capability.id,
        label: `${capability.sourceName ? `${capability.sourceName} / ` : ''}${capability.displayName ?? capability.model}`,
        disabled: capability.available === false,
      }))
    : [{ value: selectedModel, label: selectedModel || copy.unsynced }];
  const selectedModelLabel = modelOptions.find((option) => option.value === selectedModel)?.label ?? selectedModel ?? copy.unsynced;
  const effortOptions = selectedCapability?.supportedReasoningEfforts.map((effort) => ({ value: effort, label: effort })) ?? [];
  const tierOptions = serviceTierOptions(selectedCapability, props.language, false);
  const selectedServiceTierValue = serviceTierSelectionValue(selectedServiceTier);
  const selectedServiceTierLabel = tierOptions.find((option) => option.value === selectedServiceTierValue)?.label ?? selectedServiceTierValue;
  const inputResources = useConversationInputResources({
    textareaRef,
    text: props.state.draft,
    disabled: !writable || busy,
    onTextChange: props.onDraftChange,
    onAddAttachments: (attachments) => {
      setInputResourceError(null);
      props.onAddAttachments?.(attachments);
    },
    onRemoveAttachment: (attachment) => props.onRemoveAttachment?.(attachment),
    onError: setInputResourceError,
  });
  const serviceTierStatus = serviceTierStatusMessage(serviceTierDowngraded, selectedServiceTier, props.state.providerSettings, selectedCapability, props.language);

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
    const settings =
      nextDelivery === 'queue' && selectedModel
        ? {
            model: selectedModel,
            agentKind: selectedCapability?.agentKind,
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            ...serviceTierWireOverride(selectedServiceTier),
            permissionMode: props.permissionMode,
            collaborationMode: props.collaborationMode,
          }
        : undefined;
    void props.onSubmit(nextDelivery, settings);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    inputResources.handlePasteShortcut(event);
    const intent = resolveComposerKeyIntent({ key: event.key, shiftKey: event.shiftKey, isComposing: isComposing || event.nativeEvent.isComposing, repeat: event.repeat });
    if (intent === 'submit') {
      event.preventDefault();
      if (props.state.draft.trim() === '/plan' && !props.state.browserSubmission && props.onRuntimeSettingsChange) {
        props.onDraftChange('');
        props.onRuntimeSettingsChange({
          model: selectedModel,
          effort: selectedEffort,
          ...serviceTierWireOverride(selectedServiceTier),
          permissionMode: props.permissionMode,
          collaborationMode: props.collaborationMode === 'plan' ? 'default' : 'plan',
        });
        return;
      }
      if (writable && hasDraft && !busy) submit('queue');
      return;
    }
    // Escape 由 SessionWorkspace capture 统一处理，保证 approval/RUI 层优先于 interrupt。
  }

  return (
    <section
      className="session-composer-shell"
      aria-label={copy.input}
      data-active={active ? 'true' : 'false'}
      data-resource-dragging={inputResources.dragging ? 'true' : 'false'}
      onDragEnter={inputResources.handleDragEnter}
      onDragOver={inputResources.handleDragOver}
      onDragLeave={inputResources.handleDragLeave}
      onDrop={inputResources.handleDrop}
    >
      {props.state.browserSubmission ? <BrowserSubmissionAttachment submission={props.state.browserSubmission} language={props.language} disabled={!writable || busy} onRemove={props.onRemoveBrowserSubmission} /> : null}
      {inputResourceError ? (
        <p className="session-composer-resource-error" role="alert">
          {inputResourceError}
        </p>
      ) : null}
      <div className="session-composer-input-frame">
        <ConversationComposerAttachments
          attachments={props.state.attachments}
          language={props.language}
          disabled={!writable || busy || inputResources.processing}
          onRemove={(attachment) => props.onRemoveAttachment?.(attachment)}
          onRestorePastedText={inputResources.restorePastedText}
        />
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
          onPaste={inputResources.handlePaste}
          onKeyDown={handleKeyDown}
        />
        <div className="session-composer-command-row">
          <span className="session-composer-leading-actions">
            {props.onChooseAttachments ? (
              <button
                type="button"
                aria-label={copy.attach}
                onClick={() => {
                  setInputResourceError(null);
                  void Promise.resolve(props.onChooseAttachments?.()).catch((error: unknown) => {
                    setInputResourceError(error instanceof Error ? error.message : String(error));
                  });
                }}
                disabled={!writable || busy || inputResources.processing}
              >
                <span aria-hidden="true">＋</span>
              </button>
            ) : null}
            <PermissionModeControl
              language={props.language}
              value={props.permissionMode}
              disabled={props.readOnly === true || !props.onRuntimeSettingsChange}
              onChange={(permissionMode) =>
                props.onRuntimeSettingsChange?.({
                  model: selectedModel,
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
                  model: selectedModel,
                  effort: selectedEffort,
                  ...serviceTierWireOverride(selectedServiceTier),
                  permissionMode: props.permissionMode,
                  collaborationMode,
                })
              }
            />
          </span>
          <span className="session-composer-trailing-actions">
            <span className="session-composer-runtime-settings">
              <ContextUsageIndicator usage={props.state.tokenUsage} language={props.language} />
              <ComposerDropdown
                label={copy.serviceTier}
                triggerLabel={`${copy.serviceTier}：${selectedServiceTierLabel}`}
                triggerIcon={<Lightning weight={selectedServiceTier.type === 'catalog' ? 'fill' : 'regular'} />}
                hideSelectedLabel
                className="session-composer-service-tier-dropdown"
                value={selectedServiceTierValue}
                options={tierOptions}
                disabled={!settingsWritable}
                onChange={(value) => {
                  const selection = serviceTierSelectionFromValue(value);
                  setSelectedServiceTier(selection);
                  setServiceTierDowngraded(false);
                  props.onRuntimeSettingsChange?.({ model: selectedModel, effort: selectedEffort, ...serviceTierWireOverride(selection), permissionMode: props.permissionMode, collaborationMode: props.collaborationMode });
                }}
              />
              <ComposerDropdown
                label={copy.model}
                triggerLabel={`${copy.model}：${selectedModelLabel}`}
                className="session-composer-model-dropdown"
                value={selectedModel}
                options={modelOptions}
                disabled={!settingsWritable}
                onChange={(model) => {
                  const capability = resolveModelCapability(props.capabilities?.models, model);
                  const effort = capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? '';
                  const normalizedTier = normalizeServiceTierSelection(selectedServiceTier, capability);
                  setSelectedModel(model);
                  setSelectedEffort(effort);
                  setSelectedServiceTier(normalizedTier.selection);
                  setServiceTierDowngraded(normalizedTier.downgraded);
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
                    props.onRuntimeSettingsChange?.({ model: selectedModel, effort, ...serviceTierWireOverride(selectedServiceTier), permissionMode: props.permissionMode, collaborationMode: props.collaborationMode });
                  }}
                />
              ) : null}
            </span>
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
                <button type="button" className="session-send-button" aria-label={copy.send} onClick={() => submit('queue')} disabled={!writable || !hasDraft || busy} aria-busy={busy || undefined}>
                  {busy ? <span className="session-command-spinner" aria-hidden="true" /> : <span aria-hidden="true">↑</span>}
                </button>
              )}
            </span>
          </span>
        </div>
        {serviceTierStatus ? (
          <small className="session-service-tier-note" role="status">
            {serviceTierStatus}
          </small>
        ) : null}
      </div>
    </section>
  );
}

function serviceTierStatusMessage(
  downgraded: boolean,
  selection: NativeServiceTierSelection,
  settings: NativeSessionState['providerSettings'],
  model: CodexConversationCapabilities['models'][number] | null,
  language: SessionUiLanguage,
): string | null {
  if (downgraded) {
    return language === 'zh-CN' ? '所选模型不支持原 Fast 档位，已保留模型并切换为标准。' : 'The selected model does not support the previous Fast tier. The model was kept and Standard was selected.';
  }
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, 'serviceTier')) {
    return language === 'zh-CN' ? '服务档位尚未与运行时同步。' : 'The service tier has not synced with the runtime yet.';
  }
  if (selection.type === 'follow') return null;
  const requested = selection.type === 'standard' ? null : selection.id;
  const effective = !settings.serviceTier || settings.serviceTier === 'default' ? null : settings.serviceTier;
  if (requested === effective) return null;
  const requestedLabel = selection.type === 'standard' ? (language === 'zh-CN' ? '标准' : 'Standard') : (model?.serviceTiers.find((tier) => tier.id === selection.id)?.name ?? selection.id);
  return language === 'zh-CN' ? `请求 ${requestedLabel}，${effectiveServiceTierLabel(settings, model, language)}。` : `Requested ${requestedLabel}; ${effectiveServiceTierLabel(settings, model, language)}.`;
}

function effectiveServiceTierLabel(settings: NativeSessionState['providerSettings'], model: CodexConversationCapabilities['models'][number] | null, language: SessionUiLanguage): string {
  const prefix = language === 'zh-CN' ? '实际' : 'Effective';
  if (!settings || !Object.prototype.hasOwnProperty.call(settings, 'serviceTier')) return `${prefix}：${language === 'zh-CN' ? '未同步' : 'Not synced'}`;
  const serviceTier = settings.serviceTier;
  if (!serviceTier || serviceTier === 'default') return `${prefix}：${language === 'zh-CN' ? '标准' : 'Standard'}`;
  return `${prefix}：${model?.serviceTiers.find((tier) => tier.id === serviceTier)?.name ?? serviceTier}`;
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

export function resolveComposerKeyIntent(input: { key: string; shiftKey: boolean; isComposing: boolean; repeat: boolean }): ComposerKeyIntent {
  if (input.repeat) return 'ignore';
  if (input.key === 'Escape') return 'escape';
  if (input.key !== 'Enter') return 'ignore';
  if (input.isComposing) return 'ignore';
  return input.shiftKey ? 'newline' : 'submit';
}

export function canSteerActiveTurn(state: NativeSessionState): boolean {
  const active = state.conversationState === 'active_prework' || state.conversationState === 'active_final_answer';
  return active && state.transportState === 'ready' && Boolean(state.activeTurnId) && state.startedTurnId === state.activeTurnId;
}

function resolveComposerModel(capabilities: CodexConversationCapabilities | null | undefined, providerModel: string | undefined): string {
  const normalized = providerModel?.trim();
  const capability = resolveModelCapability(capabilities?.models, normalized);
  if (capability) return capability.id;
  return capabilities?.preferredModel ?? capabilities?.models[0]?.id ?? normalized ?? '';
}

function resolveComposerEffort(capabilities: CodexConversationCapabilities | null | undefined, model: string, providerEffort: string | undefined): string {
  const capability = resolveModelCapability(capabilities?.models, model);
  const normalized = providerEffort?.trim();
  if (normalized && capability?.supportedReasoningEfforts.includes(normalized)) return normalized;
  return capability?.defaultReasoningEffort ?? capability?.supportedReasoningEfforts[0] ?? normalized ?? '';
}
