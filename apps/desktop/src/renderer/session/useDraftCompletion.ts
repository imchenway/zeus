import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InputSuggestionRequest, InputSuggestionResult } from '@zeus/shared';
import { getInputSuggestionSession } from './inputSuggestionStore.js';
import type { ComposerInputHandle } from './MarkdownComposerEditor.js';

/** 输入停顿后生成独立后缀，空输入建议继续保留在原会话槽位。 */
export function useDraftCompletion(options: {
  /** 草稿归属沿用输入建议的项目、会话或新草稿身份。 */
  sessionKey: string;
  /** 配置身份包含模型、深度和速度。 */
  modelKey: string;
  /** 已启用自动建议且输入可编辑时才发送草稿。 */
  enabled: boolean;
  /** 未提交的当前原文，最多沿用服务端允许的一万六千字符。 */
  draft: string;
  /** 专用模型或当前跟随模型，用于拒收旧模型结果。 */
  modelRef: string | null;
  /** 已建立会话同时携带项目归属。 */
  projectId?: string;
  /** 新草稿可以没有会话。 */
  conversationId?: string;
  /** 新草稿跟随模型时携带当前输入框选择。 */
  draftModelRef?: string;
  /** 复用主输入建议的鉴权、取消和诊断通路。 */
  generate?: (input: InputSuggestionRequest, signal: AbortSignal, diagnosticId?: string) => Promise<InputSuggestionResult>;
}) {
  /** 后缀独立占用请求槽位，不取消正在生成的空输入建议。 */
  const session = useMemo(() => getInputSuggestionSession(JSON.stringify([options.sessionKey, 'completion'])), [options.sessionKey]);
  /** 只有当前输入框聚焦且光标位于正文末尾时才展示或请求。 */
  const [active, setActive] = useState(false);
  /** 请求回调变化不重新计时或产生重复请求。 */
  const generate = useRef(options.generate);
  generate.current = options.generate;
  /** 订阅独立候选，普通输入不会覆盖空输入建议。 */
  const result = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  /** 回调是否存在属于请求条件，函数身份本身不属于。 */
  const available = Boolean(options.generate);
  /** 主动润色、发送及 Escape 都可以清理尚未触发的计时器。 */
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    session.dismiss();
    if (!active || !options.enabled || !available || !options.draft.trim() || options.draft.length > 16_000) return;
    /** 停顿时间为一千毫秒，每次文字、配置或输入状态变化重新计时。 */
    const timer = window.setTimeout(() => {
      timerRef.current = null;
      if (!generate.current) return;
      session.start({
        key: options.sessionKey,
        modelKey: options.modelKey,
        sourceDraft: options.draft,
        modelRef: options.modelRef,
        request: {
          mode: 'complete',
          trigger: 'typing',
          draft: options.draft,
          ...(options.projectId ? { projectId: options.projectId } : {}),
          ...(options.conversationId ? { conversationId: options.conversationId } : {}),
          ...(options.draftModelRef ? { draftModelRef: options.draftModelRef } : {}),
        },
        generate: generate.current,
      });
    }, 1_000);
    timerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      timerRef.current = null;
      session.dismiss();
    };
  }, [session, active, available, options.enabled, options.sessionKey, options.modelKey, options.modelRef, options.draft, options.projectId, options.conversationId, options.draftModelRef]);

  /** 即时编辑和 Escape 直接清理候选，迟到响应由请求控制器丢弃。 */
  const dismiss = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    session.dismiss();
  }, [session]);
  /** 结果只与生成时的原文、配置和编辑状态匹配，不把隐藏候选回填。 */
  const visible = active && options.enabled && result?.sourceDraft === options.draft && result.modelKey === options.modelKey && (!options.modelRef || result.modelRef === options.modelRef);
  /** 只有当前候选参与 Tab 和 Escape，隐藏的旧请求不占用工作区快捷键。 */
  const text = visible ? result.text : null;
  /** 编辑器再次核对真实正文及光标，用独立撤销事务追加后缀。 */
  function accept(input: ComposerInputHandle | null): boolean {
    if (!text || session.getSnapshot() !== result || !input?.appendCompletion?.(options.draft, text)) return false;
    dismiss();
    return true;
  }
  return { text, pending: Boolean(visible && result.pending), setActive, accept, dismiss };
}
