import { useEffect } from 'react';
import { adaptConversationSnapshotV2 } from './conversationSnapshotV2Adapter.js';
import { conversationTreeRuntimeStateFromConversation, type ProjectConversationGroup } from './ProjectConversationTree.js';
import { createInitialSessionState, sessionReducer } from './sessionReducer.js';
import { ordinarySessionHotCacheLimit, rememberSessionHotState, type SessionHotCache } from './sessionHotCache.js';
import type { SessionControllerClient } from './useSessionController.js';

/** 完成通知到达后预取未读首屏；只更新显示缓存，不启动控制器或消费未读状态。 */
export function useCompletedConversationPreload(options: {
  /** 复用当前工作区已授权的只读会话接口。 */
  client?: SessionControllerClient;
  /** 项目会话与任务会话共用列表中的权威完成事实。 */
  groups: readonly ProjectConversationGroup[];
  /** 与前台会话共享数量和字节上限。 */
  cache: SessionHotCache;
  /** 当前会话由前台负责加载，后台不得覆盖其状态。 */
  selectedConversationId?: string;
  /** 成功取得的新显示状态沿用工作区的延迟持久化。 */
  onCached: (conversationId: string) => void;
}): void {
  useEffect(() => {
    /** 客户端切换、列表更新或导航时取消当前批次及其网络请求。 */
    const cancellation = new AbortController();
    /** 延迟到导航提交后读取，批次内始终只有一个首屏请求。 */
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** 保存当前依赖，异步结果只写回同一个工作区缓存。 */
    const { client, cache, selectedConversationId, onCached } = options;
    if (!client) return;
    /** 同一会话可能同时出现在任务和项目列表，按身份去重后优先准备最近完成的会话。 */
    const candidates = [...new Map(options.groups.flatMap((group) => [...(group.conversations ?? []), ...group.tasks.flatMap((task) => task.conversations)]).map((choice) => [choice.id, choice])).values()]
      .filter(
        (choice) =>
          choice.id !== selectedConversationId &&
          !choice.archived &&
          choice.transportKind === 'codex_native' &&
          choice.hasUnreadAttention &&
          choice.attentionKind === 'completed' &&
          conversationTreeRuntimeStateFromConversation(choice) === 'ready',
      )
      .sort((left, right) => (right.attentionUpdatedAt ?? right.updatedAt).localeCompare(left.attentionUpdatedAt ?? left.updatedAt))
      .slice(0, ordinarySessionHotCacheLimit);

    /** 分批准备有界首屏；读取失败由正常打开流程重试，不改变完成图标或发送状态。 */
    async function preload(index: number): Promise<void> {
      /** 当前候选已由本批次的权威列表确定。 */
      const choice = candidates[index];
      if (!choice || cancellation.signal.aborted || !client) return;
      /** 保留请求发出前的缓存身份，前台更新过的缓存不能被迟到结果覆盖。 */
      const previous = cache.get(choice.id);
      try {
        if (previous?.state.snapshot && previous.state.snapshot.attentionRevision >= choice.attentionRevision && previous.state.snapshot.updatedAt >= choice.updatedAt) return;
        /** 单个预取最多等待十秒；超时不占住后续已完成会话。 */
        const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(10_000)]);
        /** 正文尾页与活动摘要由同一个服务端读取水位返回。 */
        const readable = await client.loadNativeConversationReadableSnapshot(choice.projectId, choice.id, { signal });
        if (signal.aborted || cache.get(choice.id) !== previous || (previous?.state.snapshot && previous.state.snapshot.throughEventSeq > readable.snapshot.throughEventSeq)) return;
        /** 预取只提供显示内容，队列与交互权限仍需打开后重新核对。 */
        const snapshot = adaptConversationSnapshotV2({
          ...readable,
          choice,
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
        const selected = selectedConversationId ? cache.get(selectedConversationId) : undefined;
        if (selected && selectedConversationId) {
          cache.delete(selectedConversationId);
          cache.set(selectedConversationId, selected);
        }
        if (rememberSessionHotState(cache, choice.id, { ...state, transportState: 'disconnected' })) onCached(choice.id);
      } catch {
        // 预取失败不掩盖错误；用户打开时仍走原有权威读取与错误反馈。
      } finally {
        if (!cancellation.signal.aborted) timer = setTimeout(() => void preload(index + 1), 150);
      }
    }

    timer = setTimeout(() => void preload(0), 150);
    return () => {
      cancellation.abort();
      clearTimeout(timer);
    };
  }, [options.client, options.groups, options.cache, options.selectedConversationId, options.onCached]);
}
