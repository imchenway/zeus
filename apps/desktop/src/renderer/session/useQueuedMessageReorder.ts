import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { composerQueuedSubmissions, queuedSubmissionIdentity, reorderableQueuedSubmissions } from './conversationQueuePresentation.js';
import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionState } from './sessionTypes.js';

/** 服务端返回队列水位，尚未创建会话的本地队列可以同步完成。 */
export type ReorderQueuedMessages = (orderedSubmissionIds: string[]) => void | NativeQueueSnapshot | Promise<void | NativeQueueSnapshot>;

/** 本地调序以稳定的客户端消息身份表达，渲染等到权威水位接管。 */
interface OrderProjection {
  scope: string;
  ids: string[];
  baseline: NativeQueueSnapshot | null;
  settled?: true;
  throughEventSeq?: number;
}

/** 每次点击先更新位置，再交给会话控制器按点击顺序保存。 */
export function useQueuedMessageReorder(input: {
  /** 服务端队列与本地待接纳消息来自同一个投影。 */
  state: NativeSessionState;
  /** 正在退出的卡片不占用可见调序位置，仍保留提交顺序供服务端处理。 */
  isExiting(submission: NativeQueuedSubmission): boolean;
  /** 调序写入沿用已有入口。 */
  onReorder?: ReorderQueuedMessages;
  /** 失败继续显示在原消息旁。 */
  onError(submissionId: string, error: unknown): void;
}) {
  /** 完整排序需要保留不可见的权威队列成员。 */
  const authoritativeQueue = useMemo(() => reorderableQueuedSubmissions(input.state.queue), [input.state.queue]);
  /** 仅普通等待项展示卡片。 */
  const visibleQueue = useMemo(() => composerQueuedSubmissions(input.state), [input.state.activeTurnId, input.state.itemOrder, input.state.items, input.state.queue, input.state.snapshot?.providerState, input.state.terminalTurnIds]);
  /** 本地等待项先加入队尾，接纳后由相同客户端身份接管。 */
  const sourceQueue = useMemo(() => [...authoritativeQueue, ...visibleQueue.filter((entry) => entry.localOnly)], [authoritativeQueue, visibleQueue]);
  /** 不把另一个会话的顺序带到当前列表。 */
  const scope = JSON.stringify([input.state.projectId, input.state.conversationId]);
  /** 同一帧内的连续点击也读取最新的目标顺序。 */
  const latest = useRef<OrderProjection | null>(null);
  /** React 渲染只读已经接受的最新位置。 */
  const [projection, setProjection] = useState<OrderProjection | null>(null);
  /** 队列和按钮用同一个目标顺序，隐藏项仍参与排序。 */
  const ids = projection?.scope === scope ? projection.ids : undefined;
  /** 权威接纳前继续渲染最后一次意图。 */
  const fullQueue = projectOrder(sourceQueue, ids);
  /** 卡片是完整顺序的可见子集。 */
  const queue = projectOrder(visibleQueue, ids);

  useLayoutEffect(
    () => () => {
      latest.current = null;
    },
    [scope],
  );

  useLayoutEffect(() => {
    if (!projection?.settled || projection.scope !== scope) return;
    /** 本地模式靠快照对象变化，真实会话靠服务端水位接管。 */
    const acknowledged = projection.throughEventSeq === undefined ? input.state.queue !== projection.baseline : (input.state.queue?.throughEventSeq ?? -1) >= projection.throughEventSeq;
    if (acknowledged && latest.current === projection) {
      latest.current = null;
      setProjection(null);
    }
  }, [input.state.queue, projection, scope]);

  /** 找到当前可见的相邻普通消息，保持隐藏项与暂停项的边界。 */
  function moveTarget(submissionId: string, direction: -1 | 1) {
    const current = latest.current !== projection && latest.current?.scope === scope ? projectOrder(sourceQueue, latest.current.ids) : fullQueue;
    const index = current.findIndex((entry) => queuedSubmissionIdentity(entry) === submissionId);
    /** 跳过退出中的行，只交换两条可见消息。 */
    let targetIndex = index + direction;
    while (current[targetIndex] && input.isExiting(current[targetIndex]!)) targetIndex += direction;
    const target = current[targetIndex];
    if (!input.onReorder || input.state.conversationState === 'legacy_readonly' || index < 0 || current[index]?.status !== 'queued' || target?.status !== 'queued' || !visibleQueue.some((entry) => entry.id === target.id)) return null;
    return { current, index, targetIndex };
  }

  /** 同步更新位置和焦点，后续点击可在保存期间继续换位。 */
  function move(submissionId: string, direction: -1 | 1): boolean {
    const move = moveTarget(submissionId, direction);
    const save = input.onReorder;
    if (!move || !save) return false;
    const { index, targetIndex } = move;
    const current = [...move.current];
    [current[index], current[targetIndex]] = [current[targetIndex]!, current[index]!];
    const next: OrderProjection = { scope, ids: current.map(queuedSubmissionIdentity), baseline: input.state.queue };
    latest.current = next;
    setProjection(next);
    /** 所有操作在点击时即进入同一写入队列，后续引导或删除不会越过本次调序。 */
    void persist(
      next,
      current.map((entry) => entry.id),
      submissionId,
      save,
    );
    return true;
  }

  /** 迟到的处理结果不能替换后续点击的即时顺序。 */
  async function persist(next: OrderProjection, orderedIds: string[], submissionId: string, save: ReorderQueuedMessages): Promise<void> {
    try {
      const result = await save(orderedIds);
      if (latest.current !== next) return;
      const settled: OrderProjection = { ...next, settled: true, ...(result ? { throughEventSeq: result.throughEventSeq } : {}) };
      latest.current = settled;
      setProjection(settled);
    } catch (error) {
      if (latest.current !== next) return;
      latest.current = null;
      setProjection(null);
      input.onError(submissionId, error);
    }
  }

  return { queue, fullQueue, saving: Boolean(ids && !projection?.settled), canMove: (id: string, direction: -1 | 1) => Boolean(moveTarget(id, direction)), move };
}

/** 未参与移动的新成员留在原位置，已退出队列的成员自然消失。 */
function projectOrder<T extends NativeQueuedSubmission>(queue: T[], ids?: string[]): T[] {
  if (!ids) return queue;
  const byId = new Map(queue.map((entry) => [queuedSubmissionIdentity(entry), entry]));
  const ordered = ids.flatMap((id) => byId.get(id) ?? []);
  const moved = new Set(ids);
  return queue.map((entry) => (moved.has(queuedSubmissionIdentity(entry)) ? ordered.shift()! : entry));
}
