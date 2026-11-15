import { Activity, createContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ordinarySessionHotCacheLimit } from './sessionHotCache.js';
import type { SessionController } from './useSessionController.js';

/** 主页面控制器由保留页面持有；子会话仍沿用自身的挂载生命周期。 */
export const ConversationControllerRetentionContext = createContext<{ conversationId: string; controllers: Set<SessionController> } | null>(null);

/** 控制器的所有者位于 Activity 外部，隐藏只暂停界面副作用，淘汰才释放后台状态。 */
function RetainedConversationView(props: { conversationId?: string; visible: boolean; children: ReactNode }) {
  /** 真实身份更换时释放旧控制器，稳定导航别名不混用其运行状态。 */
  const owner = useMemo(() => (props.conversationId ? { conversationId: props.conversationId, controllers: new Set<SessionController>() } : null), [props.conversationId]);
  useEffect(
    () => () => {
      for (const controller of owner?.controllers ?? []) controller.dispose();
      owner?.controllers.clear();
    },
    [owner],
  );
  return (
    <ConversationControllerRetentionContext.Provider value={owner}>
      <Activity mode={props.visible ? 'visible' : 'hidden'}>{props.children}</Activity>
    </ConversationControllerRetentionContext.Provider>
  );
}

/** 保留最近会话的 DOM 和组件状态；隐藏页面的订阅与焦点副作用由 Activity 清理。 */
export function ConversationWorkspaceCache(props: {
  /** 真实项目与稳定导航身份共同隔离页面；新建或旧协议页面不进入保留队列。 */
  conversationKey?: string;
  /** 控制器按真实身份保留，导航别名只用于页面节点复用。 */
  conversationId?: string;
  /** 当前会话始终使用本次导航的新权限和操作回调。 */
  children: ReactNode;
}) {
  /** 只保留已提交的页面，废弃的并发渲染不能占用缓存或覆盖有效回调。 */
  const views = useRef(new Map<string, { content: ReactNode; conversationId?: string }>());
  /** 访问顺序独立于 DOM 顺序，切回最近页面时不移动已有节点或重建嵌入预览。 */
  const recency = useRef<string[]>([]);
  /** 超出最近会话数量时，在绘制前移除最旧页面及其 DOM。 */
  const [, refreshViews] = useState(0);
  useLayoutEffect(() => {
    if (!props.conversationKey) return;
    views.current.set(props.conversationKey, { content: props.children, conversationId: props.conversationId });
    recency.current = [...recency.current.filter((key) => key !== props.conversationKey), props.conversationKey];
    if (views.current.size > ordinarySessionHotCacheLimit) {
      views.current.delete(recency.current.shift()!);
      refreshViews((revision) => revision + 1);
    }
  }, [props.conversationKey, props.conversationId, props.children]);
  /** 新目标在当前提交中直接显示，已有页面保持原有 React 身份。 */
  const keys = [...views.current.keys()];
  if (props.conversationKey && !views.current.has(props.conversationKey)) keys.push(props.conversationKey);
  return (
    <>
      {keys.map((key) => (
        <RetainedConversationView key={key} conversationId={key === props.conversationKey ? props.conversationId : views.current.get(key)?.conversationId} visible={key === props.conversationKey}>
          {key === props.conversationKey ? props.children : views.current.get(key)?.content}
        </RetainedConversationView>
      ))}
      {!props.conversationKey ? (
        <Activity key="transient-conversation" mode="visible">
          {props.children}
        </Activity>
      ) : null}
    </>
  );
}
