import { Activity, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ordinarySessionHotCacheLimit } from './sessionHotCache.js';

/** 保留最近会话的 DOM 和组件状态；隐藏页面的订阅与焦点副作用由 Activity 清理。 */
export function ConversationWorkspaceCache(props: {
  /** 真实项目与稳定导航身份共同隔离页面；新建或旧协议页面不进入保留队列。 */
  conversationKey?: string;
  /** 当前会话始终使用本次导航的新权限和操作回调。 */
  children: ReactNode;
}) {
  /** 只保留已提交的页面，废弃的并发渲染不能占用缓存或覆盖有效回调。 */
  const views = useRef(new Map<string, ReactNode>());
  /** 访问顺序独立于 DOM 顺序，切回最近页面时不移动已有节点或重建嵌入预览。 */
  const recency = useRef<string[]>([]);
  /** 超出最近会话数量时，在绘制前移除最旧页面及其 DOM。 */
  const [, refreshViews] = useState(0);
  useLayoutEffect(() => {
    if (!props.conversationKey) return;
    views.current.set(props.conversationKey, props.children);
    recency.current = [...recency.current.filter((key) => key !== props.conversationKey), props.conversationKey];
    if (views.current.size > ordinarySessionHotCacheLimit) {
      views.current.delete(recency.current.shift()!);
      refreshViews((revision) => revision + 1);
    }
  }, [props.conversationKey, props.children]);
  /** 新目标在当前提交中直接显示，已有页面保持原有 React 身份。 */
  const keys = [...views.current.keys()];
  if (props.conversationKey && !views.current.has(props.conversationKey)) keys.push(props.conversationKey);
  return (
    <>
      {keys.map((key) => (
        <Activity key={key} mode={key === props.conversationKey ? 'visible' : 'hidden'}>
          {key === props.conversationKey ? props.children : views.current.get(key)}
        </Activity>
      ))}
      {!props.conversationKey ? (
        <Activity key="transient-conversation" mode="visible">{props.children}</Activity>
      ) : null}
    </>
  );
}
