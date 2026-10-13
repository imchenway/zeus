import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { userFacingErrorCause, type InputSuggestionRequest, type InputSuggestionResult, type InputSuggestionSettings } from '@zeus/shared';
import type { NativeSessionState, NativeTurnSnapshot } from './sessionTypes.js';
import { isInputSuggestionPendingMessage, isInputSuggestionReply } from './sessionSelectors.js';

/** 自动灰字、主动建议和草稿润色共享请求身份，迟到结果不能覆盖新草稿。 */
export function useInputSuggestion(options: {
  /** 已建立的会话用于观察真实完成事件，新会话没有此状态。 */
  state?: NativeSessionState;
  /** 新会话按项目或任务隔离结果。 */
  scopeKey?: string;
  /** 新草稿也可携带项目归属，不提前创建会话。 */
  projectId?: string;
  /** 当前可见原文用于请求绑定，未点击润色时不发送。 */
  draft: string;
  /** 只读、组合输入、目标输入和未完成交互阻止生成。 */
  eligible: boolean;
  /** 自动建议额外要求没有附件、评论或未提交内容。 */
  automaticEligible?: boolean;
  /** 会话或提交未收口时不启动独立生成。 */
  working: boolean;
  /** 自动开关和专用模型、深度不继承主会话设置。 */
  settings?: InputSuggestionSettings;
  /** 同一次请求始终使用捕获的操作身份。 */
  generate?: (input: InputSuggestionRequest, signal: AbortSignal) => Promise<InputSuggestionResult>;
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
  /** 新旧输入器的结果都绑定其实际归属。 */
  const sessionKey = options.state ? `${options.state.projectId}:${options.state.conversationId}` : (options.scopeKey ?? `new:${options.projectId ?? ''}`);
  /** Provider 身份在实时事件和历史水合间保持稳定。 */
  const turnId = latestTurn?.providerTurnId ?? latestTurn?.id ?? null;
  /** 本轮完整正文必须已经进入会话，不能把轮次状态或用户提示词当作回复。 */
  const hasFinalReply = useMemo(
    () => Boolean(latestTurn && Object.values(options.state?.items ?? {}).some((item) => (item.turnId === latestTurn.id || item.turnId === latestTurn.providerTurnId) && isInputSuggestionReply(item))),
    [latestTurn, options.state?.items],
  );
  /** 新提示词在正式轮次建立前，也会出现在本地消息或发送队列中。 */
  const hasNewSubmission = Boolean(options.state?.queue?.submissions.some((submission) => ['queued', 'dispatching'].includes(submission.status)) || Object.values(options.state?.items ?? {}).some(isInputSuggestionPendingMessage));
  /** 权威活动身份和队列状态共同兜住发送、等待与停止过程中的短暂空闲投影。 */
  const working = Boolean(
    options.working ||
    hasNewSubmission ||
    options.state?.activeTurnId ||
    (options.state && !['native_idle', 'turn_failed'].includes(options.state.conversationState)) ||
    (options.state?.queue && ['dispatching', 'active', 'waiting'].includes(options.state.queue.state.type)) ||
    options.state?.queue?.submissions.some((submission) => submission.status === 'active'),
  );
  /** 模型或深度变化后立即隐藏旧候选。 */
  const resultKey = `${sessionKey}:${turnId}:${options.settings?.modelRef}:${options.settings?.effort ?? ''}`;
  /** 首次打开历史会话只建立基线，不自动产生用量。 */
  const observed = useRef<{ sessionKey: string; turnId: string | null; status: string | null; startedTurnId: string | null } | null>(null);
  /** 每个完成轮次最多自动请求一次；用户主动点击不受此去重约束。 */
  const requestedTurn = useRef<string | null>(null);
  /** 完成事件和正文可以分批抵达；只为本次观察到的实时轮次等待完整正文。 */
  const awaitingReply = useRef<string | null>(null);
  /** 回调引用变化不能重启已发出的请求。 */
  const generate = useRef(options.generate);
  generate.current = options.generate;
  /** 每次输入和取消同步终止旧请求。 */
  const activeRequest = useRef<AbortController | null>(null);
  /** 刚显示的建议可辅助润色，但仅在相同会话、轮次和模型内有效。 */
  const lastSuggestion = useRef<{ key: string; text: string } | null>(null);
  /** 草稿、候选和错误共同绑定同一次输入快照。 */
  const [result, setResult] = useState<
    (Pick<InputSuggestionResult, 'text' | 'reason' | 'cause'> & { key: string; sourceDraft: string; mode: InputSuggestionRequest['mode']; trigger: InputSuggestionRequest['trigger']; pending: boolean }) | null
  >(null);
  /** 自动建议只接受成功终态，主动润色也支持没有历史的新草稿。 */
  const status = latestTurn?.status ?? null;
  /** 成功轮次和非空最终正文缺一不可，失败回复不能触发自动建议。 */
  const replyReady = status === 'completed' && !latestTurn?.error && hasFinalReply;
  /** 快速完成事件可能在一次 React 渲染中收口。 */
  const startedTurnId = options.state?.startedTurnId ?? null;
  /** 开关仅控制自动触发，主动点击仍使用已配置的专用模型。 */
  const enabled = options.settings?.enabled === true;
  /** 没有专用模型时不回退到主会话模型。 */
  const modelRef = options.settings?.modelRef ?? null;
  /** 主动请求与自动请求使用同一会话归属。 */
  const projectId = options.state?.projectId ?? options.projectId;
  /** 新草稿没有会话身份。 */
  const conversationId = options.state?.conversationId ?? undefined;

  // 开始标记的快照回写不取消同轮请求；真正输入、切换或状态变化才取消。
  useEffect(() => {
    setResult(null);
    return () => {
      activeRequest.current?.abort();
      activeRequest.current = null;
    };
  }, [resultKey, status, enabled, options.draft, options.eligible, options.automaticEligible, working, replyReady]);

  /** 一次点击只发出一次调用，忙碌时再次点击由按钮转换为取消。 */
  const start = useCallback(
    (mode: InputSuggestionRequest['mode'], trigger: InputSuggestionRequest['trigger']) => {
      if (activeRequest.current || !options.eligible || working || !modelRef || !generate.current || (trigger === 'automatic' && !replyReady)) return;
      /** 捕获本次原文，采用候选时还要再次对照编辑器。 */
      const sourceDraft = options.draft;
      /** 取消属于本次独立生成，不影响主会话。 */
      const controller = new AbortController();
      activeRequest.current = controller;
      setResult({ key: resultKey, sourceDraft, mode, trigger, text: null, pending: true, reason: null });
      void generate
        .current(
          {
            mode,
            trigger,
            ...(projectId ? { projectId } : {}),
            ...(conversationId ? { conversationId } : {}),
            ...(trigger === 'automatic' && turnId ? { completedTurnId: turnId } : {}),
            ...(mode === 'polish' ? { draft: sourceDraft, suggestion: lastSuggestion.current?.key === resultKey ? lastSuggestion.current.text : undefined } : {}),
          },
          controller.signal,
        )
        .then((response) => {
          if (controller.signal.aborted) return;
          if (response.modelRef !== modelRef || (trigger === 'automatic' && response.completedTurnId !== turnId)) {
            setResult(null);
            return;
          }
          if (mode === 'suggest' && response.text) lastSuggestion.current = { key: resultKey, text: response.text };
          setResult({ key: resultKey, sourceDraft, mode, trigger, text: response.text, pending: false, reason: response.reason, cause: response.cause });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) setResult({ key: resultKey, sourceDraft, mode, trigger, text: null, pending: false, reason: 'failed', cause: userFacingErrorCause(error) });
        })
        .finally(() => {
          if (activeRequest.current === controller) activeRequest.current = null;
        });
    },
    [options.eligible, working, options.draft, modelRef, projectId, conversationId, turnId, resultKey, replyReady],
  );

  useEffect(() => {
    /** 无论是否正在发送，都推进观察基线，避免空闲后重放旧轮次的完成转换。 */
    const previous = observed.current;
    observed.current = { sessionKey, turnId, status, startedTurnId };
    if (!previous || previous.sessionKey !== sessionKey || status !== 'completed') {
      awaitingReply.current = null;
      return;
    }
    /** 待请求身份同时绑定会话和真实完成轮次。 */
    const turnKey = `${sessionKey}:${turnId}`;
    /** 同时涵盖正常状态转换和一次渲染内完成的快速回复。 */
    const completedLiveTurn = previous.turnId === turnId && previous.status && !['completed', 'failed', 'interrupted'].includes(previous.status);
    if (completedLiveTurn || (startedTurnId === turnId && previous.startedTurnId !== startedTurnId)) awaitingReply.current = turnKey;
    if (awaitingReply.current !== turnKey) return;
    // 用户已有下一条消息、草稿或当前轮次失败时立即消费旧事件，之后清空输入也不补发。
    if (hasNewSubmission || latestTurn?.error || !enabled || !options.eligible || !options.automaticEligible || options.draft.length || !projectId || !conversationId || !turnId) {
      awaitingReply.current = null;
      requestedTurn.current = turnKey;
      return;
    }
    if (!replyReady || working) return;
    awaitingReply.current = null;
    /** 自动事件只消费一次，清空草稿不会补发旧轮次。 */
    if (requestedTurn.current === turnKey) return;
    requestedTurn.current = turnKey;
    start('suggest', 'automatic');
  }, [sessionKey, turnId, status, startedTurnId, enabled, options.eligible, options.automaticEligible, options.draft, working, hasNewSubmission, latestTurn?.error, replyReady, projectId, conversationId, start]);

  /** 输入、采纳、发送或 Escape 立即清除候选和状态。 */
  const dismiss = useCallback(() => {
    awaitingReply.current = null;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setResult(null);
  }, []);
  /** 操作类型由点击时的真实草稿决定。 */
  const requestManual = useCallback(() => start(options.draft.trim() ? 'polish' : 'suggest', 'manual'), [start, options.draft]);
  /** 迟到 React 清理之前，也不显示已经失去输入归属的结果。 */
  const visible = options.eligible && !working && result?.key === resultKey && result.sourceDraft === options.draft && (result.trigger === 'manual' || (enabled && replyReady && options.automaticEligible));
  return {
    text: visible && result?.mode === 'suggest' && result.sourceDraft.length === 0 ? result.text : null,
    // 仅有空白字符时也用预览采纳，避免灰字被非空编辑器遮住。
    polishedText: visible && (result?.mode === 'polish' || (result?.mode === 'suggest' && result.sourceDraft.length > 0)) ? result.text : null,
    sourceDraft: visible ? result!.sourceDraft : null,
    pending: Boolean(visible && result?.pending),
    mode: visible ? result!.mode : null,
    reason: visible ? result!.reason : null,
    cause: visible ? (result?.cause ?? null) : null,
    available: Boolean(modelRef && options.eligible && !working && generate.current),
    requestManual,
    dismiss,
  };
}
