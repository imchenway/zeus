import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode, type RefObject } from 'react';

/** 退出边界只管理可见表面，不推迟调用方的业务状态。 */
interface PresenceContextValue {
  open: boolean;
  register: (element: HTMLElement) => () => void;
}

/** 门户与内联浮层使用同一个退出边界。 */
const PresenceContext = createContext<PresenceContextValue | null>(null);

/** 保留最后一帧 React 内容直到实际过渡结束；快速重开会取消旧的卸载。 */
export function MotionPresence({ children }: { children: ReactNode }) {
  /** 当前业务内容为空时，保留原有组件与表单现场用于退出。 */
  const [retained, setRetained] = useState(children);
  /** 空节点表示立即关闭交互；动画仅决定何时移除视觉表面。 */
  const parent = useContext(PresenceContext);
  const open = parent?.open !== false && children !== null && children !== undefined && children !== false;
  if (open && children !== retained) setRetained(children);
  /** 只等待显式登记的表面，避免内部加载图标等循环动画阻塞退出。 */
  const surfaces = useRef(new Set<HTMLElement>());
  /** 登记真实节点，门户无需添加影响布局的包装元素。 */
  const register = useCallback((element: HTMLElement) => {
    surfaces.current.add(element);
    return () => {
      surfaces.current.delete(element);
    };
  }, []);
  /** 子元素完成样式更新后再读取实际过渡，减少动态效果时直接卸载。 */
  useLayoutEffect(() => {
    if (open || retained == null || retained === false) return;
    /** 重新打开或离开页面后，旧完成回执不再生效。 */
    let cancelled = false;
    /** 同一元素只采集自己的有限动画，不扫描业务正文。 */
    const animations = [...surfaces.current].flatMap((element) => element.getAnimations()).filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    if (animations.length === 0) {
      setRetained(null);
      return;
    }
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!cancelled) setRetained(null);
    });
    return () => {
      cancelled = true;
    };
  }, [open, retained]);
  /** 稳定上下文使普通内容更新不重新注册表面。 */
  const value = useMemo(() => ({ open, register }), [open, register]);
  return <PresenceContext.Provider value={value}>{open ? children : retained}</PresenceContext.Provider>;
}

/** 读取业务开关，让退出期间的读取和输入监听立即停止。 */
export function usePresenceOpen(): boolean {
  return useContext(PresenceContext)?.open ?? true;
}

/** 为实际绘制的节点登记进出状态；没有边界时保持普通挂载行为。 */
export function usePresenceSurface<T extends HTMLElement>(ref: RefObject<T | null>) {
  /** 最近的边界负责当前浮层，不影响其他同时打开的层。 */
  const presence = useContext(PresenceContext);
  useLayoutEffect(() => {
    if (presence && ref.current) return presence.register(ref.current);
  }, [presence?.register, ref]);
  return presence?.open ?? true;
}

/** 内联菜单、工具条和提示浮层共用表面状态，不额外包装 DOM。 */
export function PopoverSurface({ ref: forwardedRef, ...props }: HTMLAttributes<HTMLDivElement> & { ref?: RefObject<HTMLDivElement | null> }) {
  /** 未传入定位引用时使用本地节点。 */
  const localRef = useRef<HTMLDivElement>(null);
  /** 定位与退出等待指向同一节点。 */
  const ref = forwardedRef ?? localRef;
  /** 关闭时立即撤销点击、焦点与读屏入口。 */
  const open = usePresenceSurface(ref);
  return <div {...props} ref={ref} data-motion-surface="popover" data-motion-state={open ? 'open' : 'closing'} inert={!open || props.inert} aria-hidden={!open || props['aria-hidden']} />;
}
