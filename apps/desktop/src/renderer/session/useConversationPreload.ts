import { useCallback, useEffect, useRef } from 'react';
import type { ZeusRealtimeEvent } from '../apiClient.js';
import { adaptConversationSnapshotV2 } from './conversationSnapshotV2Adapter.js';
import type { ProjectConversationGroup } from './ProjectConversationTree.js';
import { createInitialSessionState, sessionReducer } from './sessionReducer.js';
import { ordinarySessionHotCacheLimit, rememberSessionHotState, type SessionHotCache } from './sessionHotCache.js';
import type { SessionControllerClient } from './useSessionController.js';

/** 预取最近会话的有界首屏，并用全局事件刷新后台显示缓存；不启动控制器或消费未读状态。 */
export function useConversationPreload(options: {
  /** 复用当前工作区已授权的只读会话接口。 */
  client?: SessionControllerClient;
  /** 项目会话与任务会话共用权威目录，不限制运行状态。 */
  groups: readonly ProjectConversationGroup[];
  /** 与前台会话共享数量和字节上限。 */
  cache: SessionHotCache;
  /** 当前会话由前台负责加载，后台不得覆盖其状态。 */
  selectedConversationId?: string;
  /** 成功取得的新显示状态沿用工作区的延迟持久化。 */
  onCached: (conversationId: string) => void;
}): (event?: ZeusRealtimeEvent) => void {
  /** 调度时读取最新导航和缓存，不因目录对象更新而取消已发出的请求。 */
  const latest = useRef(options);
  latest.current = options;
  /** 前台缓存写入和既有全局连接共用同一个唤醒入口。 */
  const scheduleRef = useRef<(event?: ZeusRealtimeEvent) => void>(() => undefined);
  useEffect(() => {
    /** 仅在工作区或客户端更换时终止整个调度器。 */
    const cancellation = new AbortController();
    /** 一个定时器合并连续事件，后台始终最多读取一个首屏。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 冷切换抢占后台读取，迟到结果也不能覆盖前台。 */
    let inFlight: { conversationId: string; controller: AbortController } | undefined;
    /** 流式增量只记录待刷新身份，不逐事件查询或序列化消息。 */
    const dirty = new Set<string>();
    /** 同一目录版本失败后等待新事件或新目录事实，避免后台空转重试。 */
    const attempted = new Map<string, string>();
    /** 本轮读取始终属于同一个已认证客户端和显示缓存。 */
    const { client, cache } = latest.current;
    if (!client) return;

    /** 首屏读取身份随导航重置，不随显示缓存淘汰而退回加载态。 */
    let foregroundConversationId: string | undefined;
    /** 前台首次取得正文后即可释放后台读取预算。 */
    let foregroundReadable = false;
    /** 缓存只用于确认首次就绪，不能把已显示但随后被淘汰的正文误判为仍在冷读取。 */
    function foregroundReady(): boolean {
      if (foregroundConversationId !== latest.current.selectedConversationId) {
        foregroundConversationId = latest.current.selectedConversationId;
        foregroundReadable = false;
      }
      if (!foregroundConversationId || cache.get(foregroundConversationId)?.state.snapshot) foregroundReadable = true;
      return foregroundReadable;
    }

    /** 优先未读与最近访问会话，并给当前会话保留一个普通缓存名额。 */
    function candidates() {
      /** Map 顺序由前台访问维护，后台刷新已有条目不改变其最近使用顺序。 */
      const recency = new Map([...cache.keys()].map((id, index) => [id, index]));
      return [...new Map(latest.current.groups.flatMap((group) => [...(group.conversations ?? []), ...group.tasks.flatMap((task) => task.conversations)]).map((choice) => [choice.id, choice])).values()]
        .filter((choice) => choice.id !== latest.current.selectedConversationId && !choice.archived && choice.transportKind === 'codex_native')
        .sort(
          (left, right) =>
            Number(right.hasUnreadAttention) - Number(left.hasUnreadAttention) || (recency.get(right.id) ?? -1) - (recency.get(left.id) ?? -1) || (right.activityAt ?? right.updatedAt).localeCompare(left.activityAt ?? left.updatedAt),
        )
        .slice(0, ordinarySessionHotCacheLimit - Number(Boolean(latest.current.selectedConversationId)));
    }

    /** 高频事件只查询这个有界列表，不逐事件遍历和排序全部项目会话。 */
    let backgroundChoices = candidates();

    /** 从最新目录选择一个缺失或已变化的首屏，前台未取得正文时暂停后台读取。 */
    async function preload(): Promise<void> {
      timer = undefined;
      if (cancellation.signal.aborted || inFlight || !client) return;
      if (!foregroundReady()) return;
      /** 工作集变化后释放旧身份，事件记录也受当前候选范围约束。 */
      const choices = (backgroundChoices = candidates());
      /** 仅保存当前工作集的尝试记录。 */
      const identities = new Set(choices.map((choice) => choice.id));
      for (const id of attempted.keys()) if (!identities.has(id)) attempted.delete(id);
      for (const id of dirty) if (!identities.has(id)) dirty.delete(id);
      /** 缺失或落后的缓存也进入同一队列，持续输出的会话不能阻塞其他候选。 */
      for (const candidate of choices) {
        /** 旧目录版本不能反复触发失败重试。 */
        const version = `${candidate.updatedAt}:${candidate.attentionRevision}`;
        if (attempted.get(candidate.id) === version) continue;
        /** 首屏新旧判断继续使用服务端目录事实。 */
        const snapshot = cache.get(candidate.id)?.state.snapshot;
        if (!snapshot || snapshot.attentionRevision < candidate.attentionRevision || snapshot.updatedAt < candidate.updatedAt) dirty.add(candidate.id);
      }
      /** Set 插入顺序保证多个流式会话轮流取得后台预算。 */
      const nextId = dirty.values().next().value;
      /** 当前工作集之外的待刷新身份已经在上方清理。 */
      const choice = choices.find((candidate) => candidate.id === nextId);
      if (!choice) return;
      dirty.delete(choice.id);
      attempted.set(choice.id, `${choice.updatedAt}:${choice.attentionRevision}`);
      /** 保留请求发出前的缓存身份，前台更新过的缓存不能被迟到结果覆盖。 */
      const previous = cache.get(choice.id);
      /** 导航可以单独取消当前读取，无需销毁其他会话的待刷新记录。 */
      const controller = new AbortController();
      inFlight = { conversationId: choice.id, controller };
      try {
        /** 单个预取最多等待十秒，前台读取可以立即抢占。 */
        const signal = AbortSignal.any([cancellation.signal, controller.signal, AbortSignal.timeout(10_000)]);
        /** 正文尾页与活动摘要由同一个服务端读取水位返回。 */
        const readable = await client.loadNativeConversationReadableSnapshot(choice.projectId, choice.id, { signal });
        if (signal.aborted || latest.current.selectedConversationId === choice.id || cache.get(choice.id) !== previous || (previous?.state.snapshot && previous.state.snapshot.throughEventSeq > readable.snapshot.throughEventSeq)) return;
        /** 请求期间归档或退出工作集的会话不再写回。 */
        const currentChoice = candidates().find((candidate) => candidate.id === choice.id && candidate.projectId === choice.projectId);
        if (!currentChoice) return;
        /** 预取只提供显示内容，队列与交互权限仍需打开后重新核对。 */
        const snapshot = adaptConversationSnapshotV2({
          ...readable,
          choice: currentChoice,
          queue: previous?.state.queue ?? { throughEventSeq: 0, state: { type: 'idle' }, submissions: [] },
          requests: previous?.state.pendingRequests ?? [],
          planImplementationRequests: previous?.state.planImplementationRequests ?? [],
          goal: {
            goal: previous?.state.snapshot?.goal ?? null,
            timeline: previous?.state.snapshot?.goalTimeline ?? [],
            capability: previous?.state.snapshot?.goalCapability ?? { supported: false, enabled: false, stage: null, reason: 'unverified' },
          },
        });
        /** 共享 reducer 保留已读历史、附件与尚未交接的本地消息，不另造正文投影。 */
        const state = sessionReducer(previous?.state ?? createInitialSessionState(), { type: 'snapshot_hydrated', snapshot });
        /** 当前阅读的缓存保持最近使用顺序，后台预取不能优先淘汰它。 */
        const selectedConversationId = latest.current.selectedConversationId;
        /** 后台新增缓存不能先淘汰当前可见会话。 */
        const selected = selectedConversationId ? cache.get(selectedConversationId) : undefined;
        if (selected && selectedConversationId) {
          cache.delete(selectedConversationId);
          cache.set(selectedConversationId, selected);
        }
        if (rememberSessionHotState(cache, choice.id, { ...state, transportState: 'disconnected' })) latest.current.onCached(choice.id);
      } catch {
        // 预取失败不掩盖错误；用户打开时仍走原有权威读取与错误反馈。
      } finally {
        inFlight = undefined;
        // 连续输出期间两次后台读取至少间隔 500 毫秒，不与每个流式增量一一对应。
        if (!cancellation.signal.aborted) timer ??= setTimeout(() => void preload(), 500);
      }
    }

    /** 列表变化只唤醒队列；流式事件在有界工作集中合并，重连补读漏失内容。 */
    scheduleRef.current = (event): void => {
      if (!event) backgroundChoices = candidates();
      if (event?.type === 'server.connected') {
        for (const choice of backgroundChoices) dirty.add(choice.id);
      } else if (event) {
        if (!event.type.startsWith('conversation.')) return;
        /** 身份必须属于当前授权目录与后台工作集。 */
        const choice = backgroundChoices.find((candidate) => candidate.id === event.payload.conversationId && candidate.projectId === event.payload.projectId);
        if (!choice) return;
        dirty.add(choice.id);
      }
      if (inFlight && (inFlight.conversationId === latest.current.selectedConversationId || !foregroundReady())) {
        dirty.add(inFlight.conversationId);
        inFlight.controller.abort();
      }
      if (!inFlight) timer ??= setTimeout(() => void preload(), event ? 500 : 150);
    };
    scheduleRef.current();
    return () => {
      cancellation.abort();
      clearTimeout(timer);
      scheduleRef.current = () => undefined;
    };
  }, [options.client, options.cache]);
  useEffect(() => scheduleRef.current(), [options.groups, options.selectedConversationId]);
  return useCallback((event?: ZeusRealtimeEvent) => scheduleRef.current(event), []);
}
