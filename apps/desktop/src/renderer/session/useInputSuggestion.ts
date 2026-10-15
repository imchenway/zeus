import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import type { InputSuggestionRequest, InputSuggestionResult, InputSuggestionSettings } from '@zeus/shared';
import type { NativeSessionState, NativeTurnSnapshot } from './sessionTypes.js';
import { getInputSuggestionSession, inputSuggestionIdentity, synchronizeInputSuggestionSettings } from './inputSuggestionStore.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';

/** 自动灰字、主动建议和草稿润色共享请求身份，继续输入保留候选，明确采用才替换草稿。 */
export function useInputSuggestion(options: {
  /** 已建立的会话提供归属与手动润色参考轮次，不决定后台状态是否显示。 */
  state?: NativeSessionState;
  /** 新会话按项目或任务隔离结果。 */
  scopeKey?: string;
  /** 新草稿也可携带项目归属，不提前创建会话。 */
  projectId?: string;
  /** 当前可见原文用于请求绑定，未主动润色时不发送。 */
  draft: string;
  /** 只读、组合输入和目标输入限制主动操作及采用，不取消后台请求。 */
  eligible: boolean;
  /** 输入框报告草稿、附件、评论、目标和组合输入限制；服务端交互另行核对。 */
  automaticEligible?: boolean;
  /** 自动开关和专用模型、深度不继承主会话设置。 */
  settings?: InputSuggestionSettings;
  /** 同一次请求始终使用捕获的操作身份。 */
  generate?: (input: InputSuggestionRequest, signal: AbortSignal, diagnosticId?: string) => Promise<InputSuggestionResult>;
}) {
  /** 目录和正文变化不重复扫描轮次。 */
  const latestTurn = useMemo(
    () =>
      Object.values(options.state?.turnsByProviderId ?? {}).reduce<NativeTurnSnapshot | null>(
        (latest, turn) => (!latest || turn.createdAt > latest.createdAt || (turn.createdAt === latest.createdAt && turn.id > latest.id) ? turn : latest),
        null,
      ),
    [options.state?.turnsByProviderId],
  );
  /** Provider 身份在实时事件和历史水合间保持稳定。 */
  const turnId = latestTurn?.providerTurnId ?? latestTurn?.id ?? null;
  /** 前台展示和后台触发共享身份，不从当前导航猜测归属。 */
  const { sessionKey, modelKey, resultKey, automaticResultKey } = inputSuggestionIdentity({
    projectId: options.state?.projectId ?? options.projectId,
    conversationId: options.state?.conversationId,
    scopeKey: options.scopeKey,
    settings: options.settings,
    turnId,
  });
  /** 请求和结果跨越输入框卸载，订阅仅切换当前显示的会话。 */
  const session = useMemo(() => getInputSuggestionSession(sessionKey), [sessionKey]);
  /** 外部状态始终保存稳定快照，后台完成不会写入其他输入框。 */
  const result = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  /** 采用失败属于当前候选和草稿；继续编辑或重新生成后不保留旧提示。 */
  const [failedAdoption, setFailedAdoption] = useState<{ result: typeof result; draft: string } | null>(null);
  /** Escape 后的下一次 Tab 保留焦点导航，避免快捷键困住键盘用户。 */
  const allowTabNavigation = useRef(false);
  /** 多处输入框可以共用会话，但即时输入限制各自登记和释放。 */
  const eligibilityOwner = useRef(Symbol('input-suggestion-composer'));
  useEffect(() => session.observeAutomaticEligibility(eligibilityOwner.current, options.automaticEligible === true && options.draft.length === 0), [session, options.automaticEligible, options.draft]);
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
      turnKey: automaticResultKey,
      sourceDraft: options.draft,
      modelRef,
      request: {
        mode,
        trigger: 'manual',
        ...(projectId ? { projectId } : {}),
        ...(conversationId ? { conversationId } : {}),
        ...(mode === 'polish' ? { draft: options.draft, suggestion: session.getLastSuggestion(automaticResultKey) } : {}),
      },
      generate: generate.current,
    });
  }, [session, options.eligible, options.draft, modelRef, modelKey, projectId, conversationId, resultKey, automaticResultKey]);

  /** 采纳、发送或明确取消才清除候选和状态。 */
  const dismiss = useCallback(() => {
    session.dismiss();
  }, [session]);
  /** 后台状态自身拥有完成轮次；切回时本地正文、轮次或队列可能尚未加载，不能再据此隐藏状态。 */
  const visible = Boolean(result && result.modelKey === modelKey && (result.trigger === 'manual' ? result.key === resultKey : enabled));
  /** 输入暂时不可用时仍显示进度和失败原因，只有采用内容继续遵守输入限制。 */
  const usable = visible && options.eligible && (result?.trigger === 'manual' || options.automaticEligible === true || options.draft.length > 0);
  /** 用户已经输入时改用预览，不让空草稿生成的结果覆盖当前文字。 */
  const preview = result?.mode === 'polish' || options.draft.length > 0 || Boolean(result?.sourceDraft.length);
  /** 主动操作仅使用已配置的模型与当前可编辑状态。 */
  const available = Boolean(modelRef && options.eligible && generate.current);

  /** 鼠标和 Tab 共用可撤销的替换事务，实际原文或引用不匹配时保留输入。 */
  function accept(input: ComposerInputHandle | null): boolean {
    if (!usable || !result?.text) return false;
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
      if (usable && result?.text) accept(input);
      else requestManual();
    }
    return true;
  }

  return {
    text: usable && !preview ? result!.text : null,
    // 润色、空白字符和生成期间继续输入的结果共用预览。
    polishedText: usable && preview ? result!.text : null,
    sourceDraft: usable ? result!.sourceDraft : null,
    draftChanged: usable && result!.sourceDraft !== options.draft,
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
    dismiss,
  };
}
