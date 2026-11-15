import { flushSync } from 'react-dom';

/** 会话选择在当前事件内提交，直接显示目标页面，不等待浏览器截取旧画面。 */
export async function transitionConversation(update: () => boolean): Promise<void> {
  flushSync(update);
}
