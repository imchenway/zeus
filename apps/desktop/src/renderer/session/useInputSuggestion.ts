import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InputSuggestionResult, InputSuggestionSettings } from '@zeus/shared';
import type { NativeSessionState, NativeTurnSnapshot } from './sessionTypes.js';

/** 只观察当前工作面的真实轮次，不在打开历史会话时补发模型请求。 */
export function useInputSuggestion(options: {
  /** 原生与其他 Provider 共用的轮次状态。 */
  state: NativeSessionState;
  /** 草稿、附件、评论和只读状态共同决定能否显示。 */
  eligible: boolean;
  /** 已结束事件可能先于队列收口，等待会话真正空闲。 */
  working: boolean;
  /** 独立模型设置，不继承会话模型。 */
  settings?: InputSuggestionSettings;
  /** 回调只发送完成轮次身份，不发送客户端拼接的对话材料。 */
  generate?: (completedTurnId: string, signal: AbortSignal) => Promise<InputSuggestionResult>;
}) {
  /** 目录和流式正文更新不重复扫描历史轮次。 */
  const latestTurn = useMemo(
    () =>
      Object.values(options.state.turnsByProviderId).reduce<NativeTurnSnapshot | null>((latest, turn) => (!latest || turn.createdAt > latest.createdAt || (turn.createdAt === latest.createdAt && turn.id > latest.id) ? turn : latest), null),
    [options.state.turnsByProviderId],
  );
  /** 切换会话后的渲染不能显示上一个请求的文字。 */
  const sessionKey = `${options.state.projectId}:${options.state.conversationId}`;
  /** Provider 身份在实时事件与历史水合间保持稳定，服务端按本会话映射核对。 */
  const turnId = latestTurn?.providerTurnId ?? latestTurn?.id ?? null;
  /** 输出归属包含模型和轮次，不只比较消息文本。 */
  const resultKey = `${sessionKey}:${turnId}:${options.settings?.modelRef}`;
  /** 首次挂载只记录已有状态，之后只响应进行中到成功结束的变化。 */
  const observed = useRef<{ sessionKey: string; turnId: string | null; status: string | null; startedTurnId: string | null } | null>(null);
  /** 同一完成轮次即使重复事件或设置变化也只能请求一次。 */
  const requestedTurn = useRef<string | null>(null);
  /** 事件回调变化不重启已经发出的请求。 */
  const generate = useRef(options.generate);
  generate.current = options.generate;
  /** 输入事件同步取消，避免 React 效果尚未执行时回写结果。 */
  const activeRequest = useRef<AbortController | null>(null);
  /** 灰字和加载身份始终与正文状态分开。 */
  const [result, setResult] = useState<{ key: string; text: string | null; pending: boolean } | null>(null);
  /** 失败、中断和历史关闭状态不能当作成功回复。 */
  const status = latestTurn?.status ?? null;
  /** 开始身份来自实时事件；即使快速回复合并为一次渲染，也不会漏掉刚完成的轮次。 */
  const startedTurnId = options.state.startedTurnId;
  /** 未配置时始终关闭，也不会自动使用主会话模型。 */
  const enabled = options.settings?.enabled === true;
  /** 捕获专用模型，后续变更会取消当前调用。 */
  const modelRef = options.settings?.modelRef ?? null;

  useEffect(() => {
    setResult(null);
    /** 若终态先到达，保留此前进行中身份，等待队列收口后再判断。 */
    if (status === 'completed' && options.working) return;
    /** 当前变化与首次挂载基线比较，不把历史消息当作刚结束的回复。 */
    const previous = observed.current;
    observed.current = { sessionKey, turnId, status, startedTurnId };
    if (!previous || previous.sessionKey !== sessionKey || status !== 'completed') return;
    /** 历史水合不会设置已开始身份；只消费真实进行中结束或本轮新增的开始身份。 */
    const completedLiveTurn = previous.turnId === turnId && previous.status && !['completed', 'failed', 'interrupted'].includes(previous.status);
    if (!completedLiveTurn && !(startedTurnId === turnId && previous.startedTurnId !== startedTurnId)) return;
    /** 一次消费成功结束事件；清空草稿或重新启用不能再次产生用量。 */
    const turnKey = `${sessionKey}:${turnId}`;
    if (requestedTurn.current === turnKey) return;
    requestedTurn.current = turnKey;
    if (!enabled || !modelRef || !options.eligible || !turnId || !generate.current || !options.state.projectId || !options.state.conversationId) return;
    /** 每次调用拥有独立取消身份，不中断主会话。 */
    const controller = new AbortController();
    activeRequest.current = controller;
    setResult({ key: resultKey, text: null, pending: true });
    void generate
      .current(turnId, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        if (response.completedTurnId !== turnId || response.modelRef !== modelRef) {
          setResult(null);
          return;
        }
        setResult({ key: resultKey, text: typeof response.text === 'string' && response.text.trim() ? response.text : null, pending: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult(null);
      });
    return () => {
      controller.abort();
      if (activeRequest.current === controller) activeRequest.current = null;
    };
  }, [sessionKey, turnId, status, startedTurnId, enabled, modelRef, options.eligible, options.working, resultKey, options.state.projectId, options.state.conversationId]);

  /** 输入、采纳、发送或 Escape 都同步清除独立建议。 */
  const dismiss = useCallback(() => {
    activeRequest.current?.abort();
    activeRequest.current = null;
    setResult(null);
  }, []);
  /** 不等待效果清理，当前渲染已经失去资格时立即隐藏旧结果。 */
  const visible = enabled && options.eligible && !options.working && result?.key === resultKey;
  return { text: visible ? (result?.text ?? null) : null, pending: visible && result?.pending === true, dismiss };
}
