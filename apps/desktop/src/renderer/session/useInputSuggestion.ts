import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { InputSuggestionRequest, InputSuggestionResult, InputSuggestionSettings } from '@zeus/shared';
import type { NativeSessionState } from './sessionTypes.js';
import { getInputSuggestionSession, inputSuggestionIdentity, synchronizeInputSuggestionSettings } from './inputSuggestionStore.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';

/** 空输入和已有草稿共用输入建议，编辑即失效，明确采用才替换草稿。 */
export function useInputSuggestion(options: {
  /** 已建立的会话提供归属，生成材料由服务端读取当前权威状态。 */
  state?: NativeSessionState;
  /** 新会话按项目或任务隔离结果。 */
  scopeKey?: string;
  /** 新草稿也可携带项目归属，不提前创建会话。 */
  projectId?: string;
  /** 当前可见原文用于请求绑定，未主动润色时不发送。 */
  draft: string;
  /** 只读、组合输入和目标输入限制主动操作及采用，编辑事件另行取消请求。 */
  eligible: boolean;
  /** 输入框报告草稿、附件、评论、目标和组合输入限制；服务端交互另行核对。 */
  automaticEligible?: boolean;
  /** 自动开关和专用模型、深度不继承主会话设置。 */
  settings?: InputSuggestionSettings;
  /** 同一次请求始终使用捕获的操作身份。 */
  generate?: (input: InputSuggestionRequest, signal: AbortSignal, diagnosticId?: string) => Promise<InputSuggestionResult>;
}) {
  /** 前台展示和后台触发共享身份，不从当前导航猜测归属。 */
  const { sessionKey, modelKey, resultKey } = inputSuggestionIdentity({
    projectId: options.state?.projectId ?? options.projectId,
    conversationId: options.state?.conversationId,
    scopeKey: options.scopeKey,
    settings: options.settings,
  });
  /** 请求和结果跨越输入框卸载，订阅仅切换当前显示的会话。 */
  const session = useMemo(() => getInputSuggestionSession(sessionKey), [sessionKey]);
  /** 外部状态始终保存稳定快照，后台完成不会写入其他输入框。 */
  const result = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  /** 采用失败属于当前候选和草稿；继续编辑或重新生成后不保留旧提示。 */
  const [failedAdoption, setFailedAdoption] = useState<{ result: typeof result; draft: string } | null>(null);
  /** Escape 后的下一次 Tab 保留焦点导航，避免快捷键困住键盘用户。 */
  const allowTabNavigation = useRef(false);
  /** 采用时直接核对原生预览是否展开，隐藏候选不能由 Tab 采用。 */
  const previewRef = useRef<HTMLDivElement>(null);
  /** 多处输入框可以共用会话，但即时输入限制各自登记和释放。 */
  const eligibilityOwner = useRef(Symbol('input-suggestion-composer'));
  useLayoutEffect(() => session.observeAutomaticEligibility(eligibilityOwner.current, options.automaticEligible === true && options.draft.length === 0), [session, options.automaticEligible, options.draft]);
  /** 外部恢复或切换草稿也核对原文；直接编辑由事件入口在状态更新前取消。 */
  useLayoutEffect(() => {
    if (result && result.sourceDraft !== options.draft) session.dismiss(result.requestId);
  }, [session, result, options.draft]);
  /** 文字变化和组合输入开始共用即时取消入口，清空或改回原文也不能恢复候选。 */
  const beginEditing = useCallback(() => session.beginEditing(eligibilityOwner.current), [session]);
  /** 回调引用变化不能重启已发出的请求。 */
  const generate = useRef(options.generate);
  generate.current = options.generate;
  /** 开关仅控制自动触发，主动点击仍使用已配置的专用模型。 */
  const enabled = options.settings?.enabled === true;
  /** 没有专用模型时不回退到主会话模型。 */
  const modelRef = options.settings?.modelRef ?? null;
  /** 主动请求与自动请求使用同一会话归属。 */
  const projectId = options.state?.projectId ?? options.projectId;
  /** 新草稿没有会话身份。 */
  const conversationId = options.state?.conversationId ?? undefined;

  /** 设置尚未载入时不把暂时缺失当作用户删除配置。 */
  const settingsReady = options.settings !== undefined;
  useEffect(() => {
    if (settingsReady) synchronizeInputSuggestionSettings(modelKey, enabled);
  }, [modelKey, enabled, settingsReady]);

  /** 前台只负责主动生成，自动触发统一由工作台完成事件驱动。 */
  const requestManual = useCallback(() => {
    if (!options.eligible || !modelRef || !generate.current) return;
    /** 按钮和 Tab 都按操作时的真实草稿决定生成类型。 */
    const mode = options.draft.trim() ? 'polish' : 'suggest';
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
        ...(mode === 'polish' ? { draft: options.draft } : {}),
      },
      generate: generate.current,
    });
  }, [session, options.eligible, options.draft, modelRef, modelKey, projectId, conversationId, resultKey]);

  /** 浮层按所属请求关闭，输入框主动取消则清理当前请求。 */
  const dismiss = useCallback(
    (requestId?: string) => {
      session.dismiss(requestId);
    },
    [session],
  );
  /** 后台状态自身拥有完成轮次；展示核对当前草稿和模型，不依赖本地轮次水合。 */
  const visible = Boolean(result && result.sourceDraft === options.draft && result.modelKey === modelKey && (result.trigger === 'manual' ? result.key === resultKey : enabled));
  /** 输入暂时不可用时仍显示进度和失败原因，只有采用内容继续遵守输入限制。 */
  const usable = visible && options.eligible && (result?.trigger === 'manual' || options.automaticEligible === true);
  /** 有原文的手动结果用预览，空输入继续用灰字。 */
  const preview = result?.mode === 'polish' || options.draft.length > 0 || Boolean(result?.sourceDraft.length);
  /** 主动操作仅使用已配置的模型与当前可编辑状态。 */
  const available = Boolean(modelRef && options.eligible && generate.current);

  /** 灰字直接可见，预览必须实际展开；请求身份和草稿必须仍与生成时一致。 */
  function canAccept(): boolean {
    return Boolean(usable && result?.text && session.getSnapshot() === result && result.sourceDraft === options.draft && (!preview || previewRef.current?.matches(':popover-open')));
  }

  /** 鼠标和 Tab 共用可撤销的替换事务，实际原文或引用不匹配时保留输入。 */
  function accept(input: ComposerInputHandle | null): boolean {
    if (!canAccept() || !result?.text) return false;
    if (input?.replaceDraft?.(options.draft, result.text) !== true) {
      setFailedAdoption({ result, draft: options.draft });
      return false;
    }
    dismiss();
    return true;
  }

  /** 两个会话输入入口共用建议快捷键，命令菜单在调用前优先处理自己的按键。 */
  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement | HTMLDivElement>, input: ComposerInputHandle | null): boolean {
    if (event.defaultPrevented || !options.eligible || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
    /** 焦点导航只放行 Escape 后紧接的一次 Tab，普通输入恢复建议快捷键。 */
    const navigate = allowTabNavigation.current;
    allowTabNavigation.current = event.key === 'Escape';
    if (event.key === 'Escape') {
      if (!visible) return false;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return true;
    }
    if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || navigate || !available) return false;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat && !(visible && result?.pending)) {
      if (canAccept()) accept(input);
      else requestManual();
    }
    return true;
  }

  return {
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
