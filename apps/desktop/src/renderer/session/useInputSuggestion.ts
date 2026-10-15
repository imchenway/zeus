import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { InputSuggestionRequest, InputSuggestionResult, InputSuggestionSettings } from '@zeus/shared';
import type { NativeSessionState, NativeTurnSnapshot } from './sessionTypes.js';
import { getInputSuggestionSession, inputSuggestionIdentity, synchronizeInputSuggestionSettings } from './inputSuggestionStore.js';

/** 自动灰字、主动建议和草稿润色共享请求身份，迟到结果不能覆盖新草稿。 */
export function useInputSuggestion(options: {
  /** 已建立的会话提供归属与手动润色参考轮次，不决定后台状态是否显示。 */
  state?: NativeSessionState;
  /** 新会话按项目或任务隔离结果。 */
  scopeKey?: string;
  /** 新草稿也可携带项目归属，不提前创建会话。 */
  projectId?: string;
  /** 当前可见原文用于请求绑定，未点击润色时不发送。 */
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

  useEffect(() => {
    /** 进入会话时校验保存的原文；切出时不清理请求。 */
    const current = session.getSnapshot();
    if (!current) return;
    if (current.sourceDraft !== options.draft || (settingsReady && current.modelKey !== modelKey)) session.dismiss();
  }, [session, modelKey, settingsReady, options.draft]);

  /** 前台只负责主动生成，自动触发统一由工作台完成事件驱动。 */
  const requestManual = useCallback(() => {
    if (!options.eligible || !modelRef || !generate.current) return;
    /** 操作类型由点击时的真实草稿决定。 */
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

  /** 输入、采纳、发送或 Escape 立即清除候选和状态。 */
  const dismiss = useCallback(() => {
    session.dismiss();
  }, [session]);
  /** 后台状态自身拥有完成轮次；切回时本地正文、轮次或队列可能尚未加载，不能再据此隐藏状态。 */
  const visible = Boolean(result && result.sourceDraft === options.draft && result.modelKey === modelKey && (result.trigger === 'manual' ? result.key === resultKey : enabled));
  /** 输入暂时不可用时仍显示进度和失败原因，只有采用内容继续遵守输入限制。 */
  const usable = visible && options.eligible && (result?.trigger === 'manual' || options.automaticEligible === true);
  return {
    text: usable && result?.mode === 'suggest' && result.sourceDraft.length === 0 ? result.text : null,
    // 仅有空白字符时也用预览采纳，避免灰字被非空编辑器遮住。
    polishedText: usable && (result?.mode === 'polish' || (result?.mode === 'suggest' && result.sourceDraft.length > 0)) ? result.text : null,
    sourceDraft: usable ? result!.sourceDraft : null,
    pending: Boolean(visible && result?.pending),
    mode: visible ? result!.mode : null,
    reason: visible ? result!.reason : null,
    cause: visible ? (result?.cause ?? null) : null,
    available: Boolean(modelRef && options.eligible && generate.current),
    requestManual,
    dismiss,
  };
}
