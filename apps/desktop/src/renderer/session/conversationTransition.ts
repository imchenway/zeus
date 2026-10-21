import { flushSync } from 'react-dom';

/** 只保留当前视觉过渡，连续选择不能排队播放已经离开的会话。 */
let activeTransition: ViewTransition | null = null;
/** 标记归属防止旧动画结束时清理新动画的表面。 */
let transitionRevision = 0;

/** 只选取实际可见的最上层会话，避免任务弹层与底层工作面产生同名快照。 */
function visibleWorkspace(): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('.session-workspace-root')].filter((element) => element.getClientRects().length > 0 && !element.closest('[inert], [aria-hidden="true"]')).at(-1);
}

/** 热历史等待已有的首次定位；冷读取立即展示加载态，不把网络等待放进动画。 */
async function prepareTranscript(workspace: HTMLElement | undefined, revision: string): Promise<void> {
  /** 子线程与主线程都有正文，只准备当前工作面的主正文。 */
  const transcript = workspace?.querySelector<HTMLElement>('.session-transcript-shell');
  if (!transcript || transcript.dataset.historyHydrated !== 'true') return;
  if (transcript.dataset.historyReady !== 'true') {
    await new Promise<void>((resolve) => {
      /** 定位或窗口隐藏都必须结束等待，不能让后台窗口卡住导航。 */
      const finish = (): void => {
        observer.disconnect();
        window.clearTimeout(timer);
        resolve();
      };
      /** 复用正文已完成定位的事实，不另建滚动收敛算法。 */
      const observer = new MutationObserver(() => {
        if (transcript.dataset.historyReady === 'true') finish();
      });
      /** 这里只给本地布局一个短预算；超时继续使用原正文加载与淡入。 */
      const timer = window.setTimeout(finish, 160);
      observer.observe(transcript, { attributes: true, attributeFilter: ['data-history-ready'] });
    });
  }
  // 原生快照负责本次入场，不能再捕获一个透明度为零的正文，也不能结束后重播淡入。
  if (workspace?.dataset.sessionTransition === revision && transcript.isConnected && transcript.dataset.historyReady === 'true') transcript.dataset.nativeArrival = 'true';
}

/** 导航统一接管前后画面；只保存浏览器快照，不保留旧会话的可交互 React 实例。 */
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
    await prepareTranscript(next, revision);
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
