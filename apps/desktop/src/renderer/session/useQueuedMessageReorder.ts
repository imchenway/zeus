import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { composerQueuedSubmissions, reorderableQueuedSubmissions } from './conversationQueuePresentation.js';
import type { NativeQueuedSubmission, NativeQueueSnapshot, NativeSessionState } from './sessionTypes.js';

/** 调序回执提供权威水位；尚未创建会话的本地队列可以同步完成。 */
export type ReorderQueuedMessages = (orderedSubmissionIds: string[]) => void | NativeQueueSnapshot | Promise<void | NativeQueueSnapshot>;

/** 一批连续点击只保留最新目标，同一时刻只有一个保存请求。 */
interface ReorderRun {
  /** 项目与会话共同约束异步回执。 */
  scope: string;
  /** 成员或可操作状态变化后停止追加排序。 */
  membership: string;
  /** 每次点击替换数组，保存中的请求保持自己的快照。 */
  ids: string[];
  /** 失败提示关联最后一次点击的消息。 */
  submissionId: string;
  /** 切换会话、卸载或成员变化后不再追加请求。 */
  cancelled: boolean;
}

/** 显示顺序只覆盖位置，不修改提交内容、状态或服务端快照。 */
interface OrderProjection {
  /** 同一批点击与最终回执共用身份。 */
  run: ReorderRun;
  /** 渲染使用不可变的目标数组。 */
  ids: string[];
  /** 有回执水位时，等待权威投影追上后撤销本地覆盖。 */
  throughEventSeq?: number;
  /** 同步本地队列没有水位，用原快照身份识别更新。 */
  baseline: NativeQueueSnapshot | null;
}

/** 排队卡片立即换位，保存串行合并，失败或队列成员变化后回到权威顺序。 */
export function useQueuedMessageReorder(input: {
  /** 原会话状态始终保留权威队列。 */
  state: NativeSessionState;
  /** 编辑、删除等其他动作进行中时不接受调序。 */
  blocked: boolean;
  /** 原有持久化入口，不创建新的提交身份。 */
  onReorder?: ReorderQueuedMessages;
  /** 错误继续显示在对应消息旁。 */
  onError(submissionId: string, error: unknown): void;
}) {
  /** 服务端要求完整的 queued、paused、failed 成员。 */
  const authoritativeQueue = useMemo(() => reorderableQueuedSubmissions(input.state.queue), [input.state.queue]);
  /** 本地待接纳消息只展示，不参与排序写入。 */
  const visibleQueue = useMemo(() => composerQueuedSubmissions(input.state), [input.state.itemOrder, input.state.items, input.state.queue, input.state.snapshot?.providerState]);
  /** 会话切换不能继续使用旧队列的回调。 */
  const scope = JSON.stringify([input.state.projectId, input.state.conversationId]);
  /** 顺序本身不影响成员身份，状态与可见边界变化会使当前批次失效。 */
  const membership = JSON.stringify([
    authoritativeQueue.map((entry) => [entry.id, entry.status]).sort(([left], [right]) => left!.localeCompare(right!)),
    visibleQueue
      .filter((entry) => !entry.localOnly)
      .map((entry) => entry.id)
      .sort(),
  ]);
  /** 当前仅用于显示的顺序。 */
  const [projection, setProjection] = useState<OrderProjection | null>(null);
  /** 保存期间其他队列动作保持互斥，排序箭头可以继续接受点击。 */
  const [saving, setSaving] = useState(false);
  /** 同步锁防止连续事件发出并行请求。 */
  const active = useRef<ReorderRun | null>(null);
  /** 异步保存只读取当前已渲染的会话与成员。 */
  const latest = useRef({ input, scope, membership });
  latest.current = { input, scope, membership };
  /** 断线与只读状态不接受新的位置修改。 */
  const writable = input.state.transportState === 'ready' && input.state.conversationState !== 'legacy_readonly';
  /** 调序自身的控制器忙碌态不锁住下一次位置点击。 */
  const blocked =
    input.blocked ||
    !writable ||
    Boolean(active.current && (active.current.cancelled || active.current.scope !== scope || active.current.membership !== membership)) ||
    Boolean(input.state.busyOperation && !(active.current && !active.current.cancelled && input.state.busyOperation.startsWith('queue:reorder:')));
  /** 失效的本地顺序不能覆盖新会话或刚进入执行的消息。 */
  const applicable = projection?.run.scope === scope && projection.run.membership === membership && !projection.run.cancelled;
  /** 隐藏成员仍占据原来的完整队列边界。 */
  const fullQueue = useMemo(() => projectOrder(authoritativeQueue, applicable ? projection.ids : undefined), [authoritativeQueue, applicable, projection]);
  /** 卡片和操作判断使用同一份目标顺序。 */
  const queue = useMemo(() => projectOrder(visibleQueue, applicable ? projection.ids : undefined), [visibleQueue, applicable, projection]);

  useLayoutEffect(() => {
    setSaving(false);
    /** 切换会话或卸载只停止后续合并请求，已经发出的请求仍由原控制器接收。 */
    return () => {
      if (active.current) active.current.cancelled = true;
      active.current = null;
    };
  }, [scope]);

  useLayoutEffect(() => {
    if (!projection) return;
    if (!applicable || !writable) {
      projection.run.cancelled = true;
      setProjection(null);
      if (!active.current) setSaving(false);
      return;
    }
    /** 回执和实时事件无论先后到达，都只在权威顺序可用时撤掉本地覆盖。 */
    const acknowledged = authoritativeQueue.every((entry, index) => entry.id === projection.ids[index]);
    /** 水位更高的服务端更新可以覆盖已完成的本地调序。 */
    const caughtUp = projection.throughEventSeq !== undefined ? (input.state.queue?.throughEventSeq ?? -1) >= projection.throughEventSeq : input.state.queue !== projection.baseline;
    if (!saving && (acknowledged || caughtUp)) setProjection(null);
  }, [projection, applicable, writable, saving, authoritativeQueue, input.state.queue]);

  /** 请求失败不自动重放，也不继续提交尚未保存的后续点击。 */
  async function persist(run: ReorderRun, save: ReorderQueuedMessages): Promise<void> {
    try {
      while (active.current === run && !run.cancelled) {
        /** 当前请求只保存此刻的完整顺序，后续点击替换 run.ids。 */
        const ids = run.ids;
        /** 无服务端水位的同步回调也能识别状态接管。 */
        const baseline = latest.current.input.state.queue;
        /** 原入口负责持久化和权威状态更新。 */
        const result = await save(ids);
        if (active.current !== run || run.cancelled) return;
        if (latest.current.scope !== run.scope || latest.current.membership !== run.membership) {
          run.cancelled = true;
          return;
        }
        if (run.ids.some((id, index) => id !== ids[index])) continue;
        setProjection({ run, ids: run.ids, baseline, ...(result ? { throughEventSeq: result.throughEventSeq } : {}) });
        return;
      }
    } catch (error) {
      if (active.current !== run || latest.current.scope !== run.scope) return;
      run.cancelled = true;
      setProjection(null);
      latest.current.input.onError(run.submissionId, error);
    } finally {
      if (active.current === run) {
        active.current = null;
        setSaving(false);
        if (run.cancelled) setProjection(null);
      }
    }
  }

  /** 仅交换相邻普通消息，暂停、失败、控制提交和本地投影均不可跨越。 */
  function canMove(submissionId: string, direction: -1 | 1): boolean {
    /** 事件之间尚未重绘时也按最新点击目标判断边界。 */
    const currentQueue = active.current ? projectOrder(fullQueue, active.current.ids) : fullQueue;
    /** 相邻身份按当前显示顺序定位。 */
    const index = currentQueue.findIndex((entry) => entry.id === submissionId);
    /** 隐藏项或待接纳项不是有效交换目标。 */
    const target = currentQueue[index + direction];
    return !blocked && Boolean(input.onReorder) && index >= 0 && currentQueue[index]?.status === 'queued' && target?.status === 'queued' && queue.some((entry) => entry.id === target.id && !entry.localOnly);
  }

  /** 点击同步更新位置，首个请求立即发出，期间点击只替换下一次目标。 */
  function move(submissionId: string, direction: -1 | 1): boolean {
    if (!canMove(submissionId, direction) || !input.onReorder) return false;
    /** 使用同步目标保护同一轮渲染前的连续点击。 */
    const ids = [...(active.current?.ids ?? fullQueue.map((entry) => entry.id))];
    /** 一次只交换相邻位置，完整成员集合保持不变。 */
    const index = ids.indexOf(submissionId);
    if (index < 0 || index + direction < 0 || index + direction >= ids.length) return false;
    [ids[index], ids[index + direction]] = [ids[index + direction]!, ids[index]!];
    /** 现有批次只更新目标，不新增并行写入。 */
    const run = active.current ?? { scope, membership, ids, submissionId, cancelled: false };
    run.ids = ids;
    run.submissionId = submissionId;
    setProjection({ run, ids, baseline: input.state.queue });
    if (!active.current) {
      active.current = run;
      setSaving(true);
      void persist(run, input.onReorder);
    }
    return true;
  }

  return { queue, fullQueue, saving, canMove, move };
}

/** 只调整已知身份的展示顺序，本地待接纳消息仍留在队尾。 */
function projectOrder<T extends NativeQueuedSubmission>(queue: T[], ids?: string[]): T[] {
  if (!ids) return queue;
  /** 没有服务端身份的条目沿用原相对顺序。 */
  const positions = new Map(ids.map((id, index) => [id, index]));
  return [...queue].sort((left, right) => (positions.get(left.id) ?? ids.length) - (positions.get(right.id) ?? ids.length));
}
