import { flushSync } from 'react-dom';

/** 只保留当前视觉过渡，连续选择不能排队播放已经离开的会话。 */
let activeTransition: ViewTransition | null = null;
/** 标记归属防止旧动画结束时清理新动画的表面。 */
let transitionRevision = 0;

/** 只选取实际可见的最上层会话，避免任务弹层与底层工作面产生同名快照。 */
function visibleWorkspace(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.session-workspace-root')].filter((element) => element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]')).at(-1);
}

/** 导航只过渡标题与环境卡片；正文直接使用当前会话，不等待或重播页面快照。 */
export async function transitionConversation(update: () => boolean): Promise<void> {
  activeTransition?.skipTransition();
  /** 无可见旧画面、减少动态效果或不支持原生过渡时直接执行同一导航。 */
  const previous = visibleWorkspace();
  if (!previous || !document.startViewTransition || document.visibilityState === 'hidden' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  /** 两个表面共用本次身份，旧完成回执不能删除后来设置的标记。 */
  const revision = String(++transitionRevision);
  /** 切换后可能进入另一种会话工作面，清理只针对本轮实际标记的元素。 */
  let next: HTMLElement | undefined;
  previous.dataset.sessionTransition = revision;
  /** 业务变更只执行一次；快照失败不能重放选择、发送或其他业务动作。 */
  const transition = document.startViewTransition(async () => {
    if (!flushSync(update)) {
      transition.skipTransition();
      return;
    }
    // 抽屉可能保留旧工作面，只让当前表面进入新快照，避免两个可见区域同名。
    if (previous.dataset.sessionTransition === revision) delete previous.dataset.sessionTransition;
    next = visibleWorkspace();
    if (next) next.dataset.sessionTransition = revision;
    /** 标题随快照入场，过渡结束后也不能重新播放局部动画。 */
    const header = next?.querySelector<HTMLElement>('.session-thread-header');
    if (header) header.dataset.nativeArrival = 'true';
  });
  activeTransition = transition;
  // 连续切换、隐藏窗口或快照不可用会跳过动画，导航仍以自己的完成结果为准。
  void transition.ready.catch(() => undefined);
  void transition.finished
    .catch(() => undefined)
    .then(() => {
      for (const element of [previous, next]) {
        if (element?.dataset.sessionTransition === revision) delete element.dataset.sessionTransition;
      }
      if (activeTransition === transition) activeTransition = null;
    });
  await transition.updateCallbackDone;
}
