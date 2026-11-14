import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { InputSuggestionRequest, InputSuggestionResult, InputSuggestionSettings } from '@zeus/shared';
import type { NativeSessionState } from './sessionTypes.js';
import { getAutomaticInputSuggestionSession, getInputSuggestionSession, inputSuggestionIdentity, synchronizeInputSuggestionSettings } from './inputSuggestionStore.js';
import { useDraftCompletion } from './useDraftCompletion.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';

/** 空输入建议在编辑时隐藏，草稿润色随原文失效；明确采用才替换正文。 */
export function useInputSuggestion(options: {
  /** 已建立的会话提供归属，生成材料由服务端读取当前权威状态。 */
  state?: NativeSessionState;
  /** 新会话按项目或任务隔离结果。 */
  scopeKey?: string;
  /** 新草稿也可携带项目归属，不提前创建会话。 */
  projectId?: string;
  /** 当前输入框模型供新草稿跟随；已有会话仍由服务端核对实际模型。 */
  conversationModelRef?: string;
  /** 当前原文绑定润色与补全请求，自动补全受输入建议开关控制。 */
  draft: string;
  /** 只读、组合输入和目标输入限制主动操作及采用。 */
  eligible: boolean;
  /** 空草稿和可编辑状态决定自动建议是否可以展示及采用。 */
  automaticEligible?: boolean;
  /** 自动开关、深度和速度独立配置，模型可显式跟随当前会话。 */
  settings?: InputSuggestionSettings;
  /** 同一次请求始终使用捕获的操作身份。 */
  generate?: (input: InputSuggestionRequest, signal: AbortSignal, diagnosticId?: string) => Promise<InputSuggestionResult>;
}) {
  /** 开关只控制自动任务状态订阅，手动操作仍可使用已配置模型。 */
  const enabled = options.settings?.enabled === true;
  /** 前台展示和后台触发共享身份，不从当前导航猜测归属。 */
  const { sessionKey, automaticSessionKey, modelKey, resultKey } = inputSuggestionIdentity({
    projectId: options.state?.projectId ?? options.projectId,
    conversationId: options.state?.conversationId,
    scopeKey: options.scopeKey,
    settings: options.settings,
  });
  /** 手动请求和结果跨越输入框卸载，不占用自动生成。 */
  const session = useMemo(() => getInputSuggestionSession(sessionKey), [sessionKey]);
  /** 每轮自动建议独立生成，即使用户正在手动润色也保留候选。 */
  const automaticSession = useMemo(
    () => (options.state?.conversationId && options.state.projectId ? getAutomaticInputSuggestionSession(options.state.projectId, options.state.conversationId) : getInputSuggestionSession(automaticSessionKey)),
    [automaticSessionKey],
  );
  /** 手动结果只服务于发起时的草稿。 */
  const manualResult = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  /** 关闭自动建议后停止本窗口的补读，Core 按保存的设置暂停生成。 */
  const subscribeAutomatic = useCallback((listener: () => void) => (enabled ? automaticSession.subscribe(listener) : () => {}), [automaticSession, enabled]);
  /** 后台完成不会写入其他会话的输入框。 */
  const cachedAutomaticResult = useSyncExternalStore(subscribeAutomatic, automaticSession.getSnapshot, automaticSession.getSnapshot);
  /** 停用后的旧投影不参与手动结果的展示选择。 */
  const automaticResult = enabled ? cachedAutomaticResult : null;
  /** 手动操作优先处理当前草稿；空输入的手动失败不能遮住后台建议。 */
  const result = manualResult?.sourceDraft === options.draft && (options.draft.length > 0 || manualResult.pending || manualResult.text || !automaticResult) ? manualResult : automaticResult;
  /** 采用失败属于当前候选和草稿；继续编辑或重新生成后不保留旧提示。 */
  const [failedAdoption, setFailedAdoption] = useState<{ result: typeof result; draft: string } | null>(null);
  /** Escape 后的下一次 Tab 保留焦点导航，避免快捷键困住键盘用户。 */
  const allowTabNavigation = useRef(false);
  /** 采用时直接核对原生预览是否展开，隐藏候选不能由 Tab 采用。 */
  const previewRef = useRef<HTMLDivElement>(null);
  /** 外部恢复草稿同样使旧润色失效，空输入建议继续由原文匹配控制显示。 */
  useLayoutEffect(() => {
    if (manualResult && manualResult.sourceDraft !== options.draft) session.invalidateDraft();
  }, [session, manualResult, options.draft]);
  /** 回调引用变化不能重启已发出的请求。 */
  const generate = useRef(options.generate);
  generate.current = options.generate;
  /** 跟随模式由服务端解析已有会话模型，专用模式保留明确身份。 */
  const modelRef = options.settings?.followConversationModel ? null : (options.settings?.modelRef ?? null);
  /** 已有会话可由服务端解析模型；新草稿必须已有明确选择。 */
  const hasModel = Boolean(modelRef || (options.settings?.followConversationModel && (options.state?.conversationId || options.conversationModelRef)));
  /** 仅同一输入框的模型改变才放弃候选，切换会话或目录初次加载保留后台结果。 */
  const previousModel = useRef({ session, modelRef: options.conversationModelRef });
  useLayoutEffect(() => {
    if (options.settings?.followConversationModel && previousModel.current.session === session && previousModel.current.modelRef && options.conversationModelRef && previousModel.current.modelRef !== options.conversationModelRef) {
      session.dismiss();
      automaticSession.invalidateAutomatic();
    }
    previousModel.current = { session, modelRef: options.conversationModelRef };
  }, [session, automaticSession, options.conversationModelRef, options.settings?.followConversationModel]);
  /** 主动请求与自动请求使用同一会话归属。 */
  const projectId = options.state?.projectId ?? options.projectId;
  /** 新草稿没有会话身份。 */
  const conversationId = options.state?.conversationId ?? undefined;

  /** 草稿补全使用独立请求，输入法、只读和目标模式沿用当前输入限制。 */
  const completion = useDraftCompletion({
    sessionKey,
    modelKey,
    enabled: enabled && hasModel && options.eligible && !(result?.mode === 'polish' && result.sourceDraft === options.draft),
    draft: options.draft,
    modelRef: modelRef ?? options.conversationModelRef ?? null,
    projectId,
    conversationId,
    draftModelRef: !conversationId && options.settings?.followConversationModel ? options.conversationModelRef : undefined,
    generate: options.generate,
  });
  /** 编辑清除旧后缀与润色，空输入建议继续生成，等待草稿删空。 */
  const beginEditing = useCallback(() => {
    session.invalidateDraft();
    completion.dismiss();
  }, [session, completion.dismiss]);

  /** 设置尚未载入时不把暂时缺失当作用户删除配置。 */
  const settingsReady = options.settings !== undefined;
  useEffect(() => {
    if (settingsReady) synchronizeInputSuggestionSettings(modelKey, enabled);
  }, [modelKey, enabled, settingsReady]);

  /** 主动操作负责全文润色或空输入起草，与停顿补全分别控制。 */
  const requestManual = useCallback(() => {
    if (!options.eligible || !hasModel || !generate.current) return;
    completion.dismiss();
    /** 按钮和 Tab 都按操作时的真实草稿决定生成类型。 */
    const mode = options.draft.trim() ? 'polish' : 'suggest';
    // 当前原文变化只替换旧手动请求，后台自动生成继续运行。
    if (session.getSnapshot()?.sourceDraft !== options.draft) session.dismiss();
    session.start({
      key: resultKey,
      modelKey,
      sourceDraft: options.draft,
      modelRef,
      request: {
        mode,
        trigger: 'manual',
        ...(projectId ? { projectId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(!conversationId && options.settings?.followConversationModel && options.conversationModelRef ? { draftModelRef: options.conversationModelRef } : {}),
        ...(mode === 'polish' ? { draft: options.draft } : {}),
      },
      generate: generate.current,
    });
  }, [session, completion.dismiss, options.eligible, options.draft, options.conversationModelRef, options.settings?.followConversationModel, hasModel, modelRef, modelKey, projectId, conversationId, resultKey]);

  /** 浮层按所属请求关闭，输入框主动取消则清理当前请求。 */
  const dismiss = useCallback(
    (requestId?: string) => {
      session.dismiss(requestId);
      automaticSession.dismiss(requestId);
      if (!requestId) completion.dismiss();
    },
    [session, automaticSession, completion.dismiss],
  );
  /** 后台状态自身拥有完成轮次；展示核对当前草稿和模型，不依赖本地轮次水合。 */
  const visible = Boolean(
    result &&
    result.sourceDraft === options.draft &&
    result.modelKey === modelKey &&
    (!options.settings?.followConversationModel || !result.text || result.modelRef === options.conversationModelRef) &&
    (result.trigger === 'manual' ? result.key === resultKey : enabled),
  );
  /** 输入暂时不可用时仍显示进度和失败原因，只有采用内容继续遵守输入限制。 */
  const usable = visible && options.eligible && (result?.trigger === 'manual' || options.automaticEligible === true);
  /** 有原文的手动结果用预览，空输入继续用灰字。 */
  const preview = result?.mode === 'polish' || options.draft.length > 0 || Boolean(result?.sourceDraft.length);
  /** 主动操作仅使用已配置的模型与当前可编辑状态。 */
  const available = Boolean(hasModel && options.eligible && generate.current);

  /** 灰字直接可见，预览必须实际展开；请求身份和草稿必须仍与生成时一致。 */
  function canAccept(): boolean {
    return Boolean(usable && result?.text && (result.trigger === 'automatic' ? automaticSession : session).getSnapshot() === result && result.sourceDraft === options.draft && (!preview || previewRef.current?.matches(':popover-open')));
  }

  /** 鼠标和 Tab 共用可撤销的替换事务，实际原文或引用不匹配时保留输入。 */
  function accept(input: ComposerInputHandle | null): boolean {
    if (!canAccept() || !result?.text) return false;
    if (input?.replaceDraft?.(options.draft, result.text) !== true) {
      setFailedAdoption({ result, draft: options.draft });
      return false;
    }
    dismiss(result.requestId);
    return true;
  }

  /** 两个会话输入入口共用建议快捷键，命令菜单在调用前优先处理自己的按键。 */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>, input: ComposerInputHandle | null): boolean {
    if (event.defaultPrevented || !options.eligible || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    /** 焦点导航只放行 Escape 后紧接的一次 Tab，普通输入恢复建议快捷键。 */
    const navigate = allowTabNavigation.current;
    allowTabNavigation.current = event.key === 'Escape';
    if (event.key === 'Escape') {
      if (!visible && !completion.text && !completion.pending) return false;
      event.preventDefault();
      event.stopPropagation();
      if (visible) dismiss(result?.requestId);
      else completion.dismiss();
      return true;
    }
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || navigate || !available) return false;
    // 已有草稿的 Tab 优先采用可见后缀；没有后缀时保留原生焦点导航。
    if (options.draft.length > 0 && !canAccept()) {
      if (event.repeat || !completion.accept(input)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !(visible && result?.pending)) {
      if (canAccept()) accept(input);
      else requestManual();
    }
    return true;
  }

  return {
    completion: completion.text,
    completionPending: completion.pending,
    onCompletionActiveChange: completion.setActive,
    requestId: visible ? result!.requestId : null,
    previewRef,
    claimPreview: session.claimPreview,
    text: usable && !preview ? result!.text : null,
    // 仅有效的手动草稿结果进入预览，继续输入后立即清除。
    polishedText: usable && preview ? result!.text : null,
    sourceDraft: usable ? result!.sourceDraft : null,
    adoptionFailed: usable && failedAdoption?.result === result && failedAdoption.draft === options.draft,
    pending: Boolean(visible && result?.pending),
    retryAttempt: visible ? (result?.retryAttempt ?? 0) : 0,
    retryAt: visible ? (result?.retryAt ?? null) : null,
    waitingForNetwork: Boolean(visible && result?.waitingForNetwork),
    trigger: visible ? result!.trigger : null,
    mode: visible ? result!.mode : null,
    reason: visible ? result!.reason : null,
    cause: visible ? (result?.cause ?? null) : null,
    available,
    accept,
    handleKeyDown,
    requestManual,
    beginEditing,
    dismiss,
  };
}
